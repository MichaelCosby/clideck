const test = require('node:test');
const assert = require('node:assert/strict');
const { appendFileSync, mkdtempSync, rmSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { titleFromLine, watchClaudeTitle } = require('../src/claude-title');
const { HeadlessServer } = require('../src/server');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const titleLine = (title) => `${JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: 's' })}\n`;

test('custom-title lines are recognised and nothing else is', () => {
  assert.equal(titleFromLine(titleLine('Reviewer').trim()), 'Reviewer');
  assert.equal(titleFromLine('{"type":"user","message":"custom-title please"}'), null);
  assert.equal(titleFromLine('not json "custom-title"'), null);
});

test('the watcher reports only titles written after it attached', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clideck-title-'));
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, titleLine('Old name'));
  const seen = [];
  const stop = watchClaudeTitle(path, (title) => seen.push(title), { debounceMs: 20 });
  try {
    appendFileSync(path, '{"type":"user"}\n');
    await sleep(150);
    assert.deepEqual(seen, [], 'a title from before attaching is ignored');

    const line = titleLine('Planner');
    appendFileSync(path, line.slice(0, 20));
    await sleep(150);
    appendFileSync(path, line.slice(20));
    await sleep(150);
    assert.deepEqual(seen, ['Planner'], 'a line written in two parts is read once, whole');

    appendFileSync(path, titleLine('First') + titleLine('Second'));
    await sleep(150);
    assert.deepEqual(seen, ['Planner', 'Second'], 'a burst reports only the latest title');

    writeFileSync(path, '');
    appendFileSync(path, titleLine('After truncate'));
    await sleep(150);
    assert.equal(seen.includes('Old name'), false);
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an agent title renames the session unless the name is taken', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-title-sync-'));
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  const events = [];
  server.broadcast = (event) => events.push(event);
  try {
    await server.listen();
    const a = server.createSession({ provider: 'shell', cwd: dataDir, name: 'Alpha' });
    server.createSession({ provider: 'shell', cwd: dataDir, name: 'Beta' });

    a.emit('title', 'Planner');
    assert.equal(a.name, 'Planner');
    assert.equal(server.persistence.get(a.id).name, 'Planner');

    events.length = 0;
    a.emit('title', 'Beta');
    assert.equal(a.name, 'Planner', 'a taken name keeps the current one');
    const rejected = events.find((event) => event.error?.operation === 'session.titleSync');
    assert.equal(rejected.error.value, 'Beta');
    assert.equal(rejected.error.current, 'Planner');

    events.length = 0;
    a.emit('title', '   ');
    assert.equal(a.name, 'Planner');
    assert.equal(events.length, 0, 'a blank title does nothing');
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
