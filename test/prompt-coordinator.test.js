const test = require('node:test');
const assert = require('node:assert/strict');
const { hasValidControlFields, isKnownControlType } = require('../src/control');
const {
  PromptCoordinator,
  parseAnnotateRequest,
  parsePromptRequest,
} = require('../src/prompt-coordinator');

test('user dismissal resolves only its question, never an answer, and ignores late controls', async () => {
  const events = [];
  let id = 0;
  const coordinator = new PromptCoordinator(event => events.push(event), { createId: () => `${++id}` });
  const first = coordinator.prompt('same-session', { question: 'Rent?', options: ['Yes', 'No'] }, 1000);
  const second = coordinator.prompt('same-session', { question: 'Other?' }, 1000);
  assert.equal(coordinator.cancel('1'), true);
  assert.deepEqual(await first, { ok: false, error: 'cancelled' });
  assert.equal(coordinator.cancel('1'), false);
  assert.equal(coordinator.answer('1', 'Yes'), false);
  assert.equal(coordinator.active.size, 1);
  assert.deepEqual([...coordinator.bySession.get('same-session')], ['2']);
  assert.equal(coordinator.answer('2', 'Kept'), true);
  assert.equal(coordinator.cancel('2'), false);
  assert.deepEqual(await second, { ok: true, value: 'Kept' });
  assert.equal(coordinator.active.size, 0);
  assert.equal(coordinator.bySession.size, 0);
  assert.deepEqual(events.filter(e => e.type === 'prompt.resolved').map(e => e.promptId), ['1', '2']);
});

test('prompt cancellation accepts only a valid bounded prompt id', () => {
  assert.equal(isKnownControlType('prompt.cancel'), true);
  assert.equal(hasValidControlFields({ type: 'prompt.cancel', promptId: 'question-id' }), true);
  for (const promptId of [undefined, null, '', ' ', 123, 'bad\0id', 'x'.repeat(201)]) {
    assert.equal(hasValidControlFields({ type: 'prompt.cancel', promptId }), false);
  }
});

test('prompt requests preserve validated options and reject oversized fields', () => {
  assert.deepEqual(parsePromptRequest({
    sessionId: 'session',
    question: 'Choose one',
    options: ['Alpha', ' Beta '],
    timeoutMs: 1000,
  }), {
    sessionId: 'session',
    question: 'Choose one',
    options: ['Alpha', ' Beta '],
    timeoutMs: 1000,
  });
  assert.equal(parsePromptRequest({
    sessionId: 'session',
    question: 'x'.repeat(2001),
  }), null);
  assert.equal(parsePromptRequest({
    sessionId: 'session',
    question: 'Choose',
    options: Array(13).fill('x'),
  }), null);
  assert.equal(parsePromptRequest({
    sessionId: 'session',
    question: 'Choose',
    options: ['x'.repeat(201)],
  }), null);
  assert.deepEqual(parseAnnotateRequest({
    sessionId: 'session',
    path: '/tmp/image.png',
  }), {
    sessionId: 'session',
    path: '/tmp/image.png',
    timeoutMs: 600_000,
  });
});

test('prompts and annotations may wait up to the same 2 hours as asks', () => {
  const hours = 60 * 60 * 1000;
  assert.equal(parseAnnotateRequest({ sessionId: 's', path: '/tmp/a.png', timeoutMs: 2 * hours }).timeoutMs, 2 * hours);
  assert.equal(parseAnnotateRequest({ sessionId: 's', path: '/tmp/a.png', timeoutMs: 2 * hours + 1 }), null);
  assert.equal(parsePromptRequest({ sessionId: 's', question: 'Ok?', timeoutMs: 2 * hours }).timeoutMs, 2 * hours);
  assert.equal(parsePromptRequest({ sessionId: 's', question: 'Ok?', timeoutMs: 2 * hours + 1 }), null);
});

test('prompt coordinator resolves answers, timeouts, and session cancellation once', async () => {
  const events = [];
  let nextId = 0;
  const coordinator = new PromptCoordinator(
    (event) => events.push(event),
    { createId: () => `prompt-${++nextId}` },
  );

  const answered = coordinator.prompt(
    'session-a',
    { question: 'Question', options: ['a', 'b'] },
    1000,
  );
  assert.deepEqual(events[0], {
    type: 'prompt.show',
    sessionId: 'session-a',
    promptId: 'prompt-1',
    question: 'Question',
    options: ['a', 'b'],
  });
  assert.equal(coordinator.answer('prompt-1', 'b\nexact'), true);
  assert.deepEqual(await answered, { ok: true, value: 'b\nexact' });
  assert.equal(coordinator.answer('prompt-1', 'late'), false);

  const timedOut = coordinator.prompt('session-b', { question: 'Wait', options: [] }, 5);
  assert.deepEqual(await timedOut, { ok: false, error: 'timeout' });

  const cancelled = coordinator.prompt('session-c', { question: 'Close', options: [] }, 1000);
  assert.equal(coordinator.cancelSession('session-c'), 1);
  assert.deepEqual(await cancelled, { ok: false, error: 'session_closed' });
  assert.equal(coordinator.cancelSession('session-c'), 0);

  assert.deepEqual(
    events.filter((event) => event.type === 'prompt.resolved').map((event) => event.promptId),
    ['prompt-1', 'prompt-2', 'prompt-3'],
  );
});

test('open questions are offered again; answered ones are not', async () => {
  let id = 0;
  const coordinator = new PromptCoordinator(() => {}, { createId: () => `q${++id}` });
  const first = coordinator.prompt('s1', { question: 'Ship it?', options: ['Yes', 'No'] }, 1000);
  coordinator.prompt('s2', { annotate: { contentId: 'c1', url: '/content/c1', name: 'shot.png' } }, 1000);
  assert.deepEqual(coordinator.openEvents(), [
    { type: 'prompt.show', sessionId: 's1', promptId: 'q1', question: 'Ship it?', options: ['Yes', 'No'], replay: true },
    { type: 'prompt.show', sessionId: 's2', promptId: 'q2', annotate: { contentId: 'c1', url: '/content/c1', name: 'shot.png' }, replay: true },
  ]);
  coordinator.answer('q1', 'Yes');
  await first;
  assert.deepEqual(coordinator.openEvents().map((event) => event.promptId), ['q2']);
  coordinator.cancel('q2');
  assert.deepEqual(coordinator.openEvents(), []);
});

// A browser that connects after a question was asked (a reload, or a reconnect after a network drop) must see it,
// inside the connect burst, or the agent waits out its timeout on a question nobody can see.
test('a browser that connects gets the questions still waiting, before the burst ends', async (t) => {
  const { mkdtempSync, rmSync } = require('fs');
  const { tmpdir } = require('os');
  const { join } = require('path');
  const WebSocket = require('ws');
  const { HeadlessServer } = require('../src/server');
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-prompt-replay-'));
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  t.after(async () => { await server.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const { url } = await server.listen();
  const burst = () => new Promise((resolve, reject) => {
    const socket = new WebSocket(url), seen = [];
    socket.on('message', (raw) => {
      const event = JSON.parse(raw);
      seen.push(event);
      if (event.type === 'transcript.cache') { socket.close(); resolve(seen); }
    });
    socket.on('error', reject);
  });
  const asked = server.promptCoordinator.prompt('agent-1', { question: 'Which branch?', options: [] }, 60_000);
  const events = await burst();
  const shown = events.find((event) => event.type === 'prompt.show');
  assert.equal(shown?.question, 'Which branch?');
  assert.equal(shown.replay, true);
  assert.ok(events.indexOf(shown) < events.findIndex((event) => event.type === 'transcript.cache'));
  server.promptCoordinator.answer(shown.promptId, 'main');
  assert.deepEqual(await asked, { ok: true, value: 'main' });
  assert.equal((await burst()).some((event) => event.type === 'prompt.show'), false);
});
