const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const WebSocket = require('ws');
const { SessionPersistence } = require('../src/persistence');
const { HeadlessServer } = require('../src/server');
const { modePreamble, scanModes } = require('../src/terminal-modes');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeSession = (id) => ({ id, provider: { id: 'shell' }, name: id, cwd: '/', cols: 80, rows: 24 });
function store(t, options = {}) {
  const dataDir = options.dataDir || mkdtempSync(join(tmpdir(), 'clideck-window-'));
  const persistence = new SessionPersistence({ dataDir, debounceMs: 0, historyLimit: options.limit || 1024 });
  t.after(() => { persistence.close(); if (!options.dataDir) rmSync(dataDir, { recursive: true, force: true }); });
  return { dataDir, persistence };
}

test('a window starts N prompts back and says whether older output was left out', (t) => {
  const { persistence } = store(t);
  persistence.register(fakeSession('s1'));
  persistence.appendHistory('s1', 'banner\r\n');
  for (const n of [1, 2, 3, 4]) {
    persistence.markTurn('s1');
    persistence.appendHistory('s1', `> prompt ${n}\r\nanswer ${n}\r\n`);
  }
  const last = persistence.historyWindow('s1', 1);
  assert.equal(last.partial, true);
  assert.equal(last.data, '\x1b[0m> prompt 4\r\nanswer 4\r\n');
  const three = persistence.historyWindow('s1', 3);
  assert.match(three.data, /^\x1b\[0m> prompt 2\r\n/);
  assert.match(three.data, /answer 4\r\n$/);
  for (const prompts of [5, 0, undefined]) {
    const full = persistence.historyWindow('s1', prompts);
    assert.deepEqual(full, { data: persistence.historyTail('s1'), partial: false }, `prompts=${prompts}`);
    assert.match(full.data, /^banner/);
  }
});

test('a mark can be placed before output that arrived after the prompt was submitted', (t) => {
  const { persistence } = store(t);
  persistence.register(fakeSession('s1'));
  persistence.appendHistory('s1', 'idle screen ');
  persistence.appendHistory('s1', 'typed echo ');
  persistence.markTurn('s1', Buffer.byteLength('typed echo '));
  assert.equal(persistence.historyWindow('s1', 1).data, '\x1b[0mtyped echo ');
  persistence.markTurn('s1', 10_000);   // a stale offset never moves before the previous mark
  assert.equal(persistence.readHistory('s1').marks.length, 1);
});

test('trimmed output keeps its terminal modes, and marks inside it are dropped', (t) => {
  const { persistence } = store(t, { limit: 256 });
  persistence.register(fakeSession('s1'));
  persistence.markTurn('s1');
  persistence.appendHistory('s1', '\x1b[?2004h\x1b[?1004h\x1b[?25l');
  persistence.appendHistory('s1', 'x'.repeat(300));
  persistence.markTurn('s1');
  persistence.appendHistory('s1', '\x1b[?1004lend');
  const tail = persistence.historyTail('s1');
  assert.ok(tail.startsWith('\x1b[?25l\x1b[?1004h\x1b[?2004h'), JSON.stringify(tail.slice(0, 40)));
  assert.equal(persistence.readHistory('s1').marks.length, 1, 'the mark in trimmed output is gone');
  const window = persistence.historyWindow('s1', 1);
  assert.equal(window.partial, true);
  assert.equal(window.data, '\x1b[0m\x1b[?25l\x1b[?1004h\x1b[?2004h\x1b[?1004lend');
});

test('a full-screen (alternate screen) session always gets the whole history', (t) => {
  const { persistence } = store(t);
  persistence.register(fakeSession('s1'));
  persistence.appendHistory('s1', '\x1b[?1049h\x1b[2Jscreen');
  for (const n of [1, 2]) { persistence.markTurn('s1'); persistence.appendHistory('s1', `\x1b[5;1Hpatch ${n}`); }
  assert.deepEqual(persistence.historyWindow('s1', 1), { data: persistence.historyTail('s1'), partial: false });
  persistence.appendHistory('s1', '\x1b[?1049l');
  persistence.markTurn('s1'); persistence.appendHistory('s1', 'inline again');
  assert.equal(persistence.historyWindow('s1', 1).partial, true, 'back on the normal screen, windows work again');
});

test('a mode sequence cut in half by trimming still counts', (t) => {
  const { persistence } = store(t, { limit: 64 });
  persistence.register(fakeSession('s1'));
  persistence.appendHistory('s1', 'y'.repeat(60) + '\x1b[?20');
  persistence.appendHistory('s1', '04h' + 'z'.repeat(62));
  assert.deepEqual(persistence.readHistory('s1').baseModes, { 2004: true });
});

test('marks and modes survive an engine restart; a mismatched save is ignored', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-window-restart-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const first = new SessionPersistence({ dataDir, debounceMs: 0, historyLimit: 128 });
  first.register(fakeSession('s1'));
  first.appendHistory('s1', '\x1b[?2004h' + 'a'.repeat(200));
  first.markTurn('s1');
  first.appendHistory('s1', 'prompt\r\n');
  const before = first.historyWindow('s1', 1);
  first.close();

  const second = new SessionPersistence({ dataDir, debounceMs: 0, historyLimit: 128 });
  assert.deepEqual(second.historyWindow('s1', 1), before);
  assert.ok(second.historyTail('s1').startsWith('\x1b[?2004h'));
  second.appendHistory('s1', 'more');
  second.close();

  writeFileSync(join(dataDir, 'history', 's1.marks.json'), JSON.stringify({ length: 5, total: 999, marks: [990], modes: {} }));
  const third = new SessionPersistence({ dataDir, debounceMs: 0, historyLimit: 128 });
  assert.equal(third.historyWindow('s1', 1).partial, false);
  third.remove('s1');
  third.close();
});

test('mode scanning and preamble', () => {
  assert.deepEqual(scanModes({}, '\x1b[?1000;1006h\x1b[?2004h\x1b[?2004l\x1b[?7h'), { 1000: true, 1006: true, 2004: false });
  assert.deepEqual(scanModes({ 2004: true }, 'reset\x1bc'), {});
  assert.deepEqual(scanModes({}, '\x1b[?2004h|\x1b[?1004h', 9), { 2004: true });
  assert.equal(modePreamble({ 25: true, 2004: false, 1049: true, 1000: true }), '\x1b[?1049h\x1b[?1000h');
});

test('the engine marks each prompt and serves a window over the socket', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-window-engine-'));
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  t.after(async () => { await server.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const { url } = await server.listen();
  const session = server.createSession({ provider: 'shell', cwd: dataDir, name: 'Shell' });
  const until = async (test) => { for (let i = 0; i < 200 && !test(server.persistence.historyTail(session.id)); i++) await sleep(25); };
  await until((text) => text.length > 0);
  session.sendPrompt('echo first-turn');
  await until((text) => /[\r\n]first-turn\r\n/.test(text));   // the command's output line, not its echo
  session.writeInput('echo second-turn\r');
  session.emitProtocol('turn.user', { text: 'echo second-turn' });   // as a native prompt hook would
  await until((text) => /[\r\n]second-turn\r\n/.test(text));
  assert.equal(server.persistence.readHistory(session.id).marks.length, 2);

  const socket = new WebSocket(url + '/?history=lazy');
  const events = [];
  socket.on('message', (raw) => events.push(JSON.parse(raw)));
  await new Promise((resolve) => socket.once('open', resolve));
  t.after(() => socket.close());
  socket.send(JSON.stringify({ type: 'session.history', sessionId: session.id, requestId: 'w1', prompts: 1 }));
  for (let i = 0; i < 50 && !events.some((e) => e.requestId === 'w1'); i++) await sleep(20);
  const reply = events.find((e) => e.requestId === 'w1');
  assert.equal(reply.partial, true);
  assert.match(reply.data, /second-turn/);
  assert.doesNotMatch(reply.data, /first-turn/);
});
