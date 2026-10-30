const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { AgentSession } = require('../src/session');
const { getProvider } = require('../src/providers');
const { AskCoordinator, availableAskSession, availableSteerSession } = require('../src/ask');
const { hasValidControlFields } = require('../src/control');
const { HeadlessServer } = require('../src/server');

function fixture(t, provider = 'claude-code') {
  let now = 10000;
  const session = new AgentSession({ provider: getProvider(provider), now: () => now,
    promptSubmitDelay: () => 25, submitRetryMs: 75 });
  const writes = [], dispatches = [];
  session.terminal = { write: data => writes.push(data), kill: () => session.handleExit(0, null) };
  session.status = 'idle';
  t.after(() => session.handleExit(0, null));
  const coordinator = new AskCoordinator(event => dispatches.push(event));
  const entry = { id: session.id, provider }, sessions = new Map([[session.id, session]]);
  return { session, writes, dispatches, coordinator, entry, sessions, advance: ms => { now += ms; } };
}

test('activity flag is optional and boolean; empty activity frames are accepted', () => {
  const frame = { type: 'input', sessionId: 'one', data: '' };
  for (const extra of [{}, { userActivity: true }, { userActivity: false }]) assert(hasValidControlFields({ ...frame, ...extra }));
  for (const userActivity of ['true', 1, null, {}]) assert(!hasValidControlFields({ ...frame, userActivity }));
});

for (const provider of ['claude-code', 'codex']) {
  test(`${provider}: human input blocks ask and steer, with four seconds from the latest edit`, async t => {
    const f = fixture(t, provider), s = f.session;
    s.writeInput('\x1b[1;1R'); assert(!s.isUserTyping(), 'unmarked protocol replies do not block');
    f.writes.length = 0; s.markUserActivity();
    for (const status of ['idle', 'working']) {
      s.status = status;
      for (const available of [availableAskSession, availableSteerSession]) {
        const result = available(f.entry, f.sessions, f.coordinator);
        assert.equal(result.error, 'user_typing'); assert(!result.steerable); assert.match(result.message, /Nothing was sent/);
      }
      assert.equal((await f.coordinator.ask(s, 'peer ask', 100)).error, 'user_typing');
      assert.equal((await f.coordinator.steer(s, 'peer steer')).error, 'user_typing');
      assert.equal(s.sendPrompt('bypass'), false); assert.equal(s.steerPrompt('bypass'), false);
    }
    assert.deepEqual(f.writes, []); assert.deepEqual(s.userPrompts, []); assert.deepEqual(f.dispatches, []);
    f.advance(3999); assert(s.isUserTyping()); s.markUserActivity(); f.advance(3999); assert(s.isUserTyping());
    f.advance(1); assert(!s.isUserTyping());
    assert.equal(availableSteerSession(f.entry, f.sessions, f.coordinator).session, s);
    s.status = 'idle'; assert.equal(availableAskSession(f.entry, f.sessions, f.coordinator).session, s);
    s.menu = ['Approve']; assert.equal(availableAskSession(f.entry, f.sessions, f.coordinator).error, 'busy');
  });
}

for (const method of ['ask', 'steer']) {
  test(`${method}: human edits cancel delayed Enter and report partial delivery honestly`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t), s = f.session;
    if (method === 'steer') { s.status = 'working'; s.turnOpen = true; }
    const result = method === 'ask' ? f.coordinator.ask(s, 'peer text', 1000) : f.coordinator.steer(s, 'peer text');
    assert.deepEqual(f.writes, ['\x1b[200~peer text\x1b[201~']);
    assert(s.isSubmitting());
    assert.equal(availableSteerSession(f.entry, f.sessions, f.coordinator).error, 'busy');
    s.markUserActivity(); s.writeInput('my draft');
    const interrupted = await result;
    assert.equal(interrupted.error, 'delivery_interrupted'); assert.match(interrupted.message, /already inserted/);
    assert.doesNotMatch(interrupted.message, /Nothing was sent/);
    t.mock.timers.tick(5000); f.advance(5000);
    assert.deepEqual(f.writes, ['\x1b[200~peer text\x1b[201~', 'my draft'], 'no delayed CR, retry, or queued replay');
    assert.deepEqual(f.dispatches, []); assert(!f.coordinator.isActive(s.id));
    assert.equal(s.turnOpen, method === 'steer', 'existing active turn is preserved; an unsubmitted ask does not strand busy state');
    assert.deepEqual(s.pendingPromptEchoes, [], 'cancelled paste cannot block the next native echo');
    const turns = [];
    s.on('event', event => { if (event.type === 'turn.user') turns.push(event.text); });
    assert(s.steerPrompt('next prompt'));
    t.mock.timers.tick(25);
    s.recordNativePrompt({ prompt: 'next prompt', prompt_id: 'next-prompt' });
    assert.deepEqual(turns, ['next prompt'], 'later local prompt and native echo are recorded once');
  });
}

test('steer acknowledges only after Enter; concurrent delivery cannot mix another prompt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t); f.session.status = 'working';
  let acknowledged = false;
  const result = f.coordinator.steer(f.session, 'one').then(value => { acknowledged = true; return value; });
  await Promise.resolve(); assert(!acknowledged);
  assert.equal((await f.coordinator.steer(f.session, 'two')).error, 'unavailable');
  assert.equal(f.writes.length, 1);
  t.mock.timers.tick(25); assert.deepEqual(await result, { ok: true, steered: true });
  t.mock.timers.tick(1000); assert.deepEqual(f.writes, ['\x1b[200~one\x1b[201~', '\r']);
  assert.equal(f.dispatches.length, 1);
});

test('typing after a submitted ask cancels only the retry, keeping its answer delivery intact', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t), result = f.coordinator.ask(f.session, 'one', 1000);
  t.mock.timers.tick(25); await Promise.resolve();
  f.session.markUserActivity(); f.session.writeInput('next draft'); t.mock.timers.tick(100);
  assert.deepEqual(f.writes, ['\x1b[200~one\x1b[201~', '\r', 'next draft']);
  assert(f.coordinator.isActive(f.session.id));
  f.session.emit('event', { type: 'agent.final', text: 'answer' });
  assert.deepEqual(await result, { ok: true, answer: 'answer' }); assert.equal(f.dispatches.length, 1);
});

test('closing a session resolves pending delivery and never submits later', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t), result = f.coordinator.steer(f.session, 'one');
  f.session.handleExit(0, null);
  assert.deepEqual(await result, { ok: false, error: 'target_closed' });
  t.mock.timers.tick(1000); assert.equal(f.writes.length, 1); assert.deepEqual(f.dispatches, []);
});

test('an explicit human prompt still submits while activity is protected', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t); f.session.markUserActivity();
  assert(f.session.sendPrompt('human prompt', { fromUser: true }));
  t.mock.timers.tick(25); assert.equal(f.writes.at(-1), '\r');
});

test('server activity-only frames never write/touch; clients share protection and HTTP refusal', async t => {
  const f = fixture(t), dir = mkdtempSync(join(tmpdir(), 'clideck-activity-'));
  const server = new HeadlessServer({ port: 0, dataDir: dir, autoSaveMs: 0 });
  server.persistence.register(f.session); server.sessions.set(f.session.id, f.session);
  t.after(async () => { f.session.handleExit(0, null); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const { httpUrl } = await server.listen();
  let touches = 0; const touch = server.persistence.touch.bind(server.persistence);
  server.persistence.touch = (...args) => { touches++; return touch(...args); };
  const socket = () => ({ send() {}, close() { assert.fail('valid legacy-compatible input must not close the socket'); } });
  const control = (client, data, extra = {}) => server.handleControl(client, Buffer.from(JSON.stringify({ type: 'input', sessionId: f.session.id, data, ...extra })));
  const a = socket(), b = socket();
  control(a, '', { userActivity: true }); assert(f.session.isUserTyping()); assert.equal(touches, 0); assert.deepEqual(f.writes, []);
  control(b, '', { userActivity: false }); assert(f.session.isUserTyping()); assert.equal(touches, 0);
  f.advance(3000); control(b, 'paste', { userActivity: true }); assert.equal(touches, 1); assert.deepEqual(f.writes, ['paste']);
  f.advance(3000); control(a, '\x1b[1;1R'); assert(f.session.isUserTyping());
  for (const steer of [false, true]) {
    const response = await fetch(httpUrl + '/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: f.session.id, text: 'peer text', steer }) });
    assert.equal(response.status, 409); const body = await response.json(); assert.equal(body.error, 'user_typing'); assert.match(body.message, /Nothing was sent/);
  }
  assert.equal(f.writes.length, 2); assert.deepEqual(f.session.userPrompts, []);
  f.advance(1000); assert(!f.session.isUserTyping(), 'protocol reply does not extend activity');
});
