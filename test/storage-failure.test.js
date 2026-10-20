const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { WebSocket } = require('ws');
const { SessionPersistence } = require('../src/persistence');
const { HeadlessServer } = require('../src/server');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A directory where a write's temporary file goes makes that write fail, like a full disk would.
const blockWrites = (path) => mkdirSync(`${path}.${process.pid}.tmp`);
const unblockWrites = (path) => rmSync(`${path}.${process.pid}.tmp`, { recursive: true, force: true });

test('a failed save is reported and retried instead of thrown', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-storage-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const events = [];
  const persistence = new SessionPersistence({
    dataDir, debounceMs: 0, retryMs: 30,
    onWriteError: (error) => events.push(['error', error.code]), onWriteOk: () => events.push(['ok']),
  });
  persistence.register({ id: 's1', provider: { id: 'shell' }, name: 'A', cwd: dataDir, cols: 80, rows: 24 });
  blockWrites(join(dataDir, 'sessions.json'));
  blockWrites(join(dataDir, 'sessions.backup.json'));
  blockWrites(persistence.historyPath('s1'));
  assert.doesNotThrow(() => persistence.update('s1', { name: 'B' }, true), 'an immediate save does not throw');
  persistence.appendHistory('s1', 'output');
  await sleep(10);
  assert.doesNotThrow(() => persistence.flushHistory('s1'));
  assert.equal(events[0][0], 'error');
  assert.ok(!events.some(([kind]) => kind === 'ok'));

  unblockWrites(join(dataDir, 'sessions.json'));
  unblockWrites(join(dataDir, 'sessions.backup.json'));
  unblockWrites(persistence.historyPath('s1'));
  await sleep(120);
  assert.deepEqual(events.at(-1), ['ok'], 'the retry saves everything and reports it');
  assert.equal(new SessionPersistence({ dataDir }).get('s1').name, 'B');
  assert.equal(persistence.readHistory('s1').toString(), 'output');
  persistence.close();
});

test('browsers are told while the engine cannot save, and when it can again', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-storage-ui-'));
  const lines = [];
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0, log: (line) => lines.push(line) });
  t.after(async () => { await server.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const { url } = await server.listen();
  const socket = new WebSocket(url);
  const events = [];
  socket.on('message', (raw) => events.push(JSON.parse(raw)));
  await new Promise((resolve) => socket.once('open', resolve));
  t.after(() => socket.close());

  const full = Object.assign(new Error('no space left on device, write'), { code: 'ENOSPC' });
  server.storageFailed('sessions', full);
  server.storageFailed('sessions', full);
  await sleep(50);
  const notices = events.filter((event) => event.type === 'engine.storage');
  assert.equal(notices.length, 1, 'once, not on every retry');
  assert.equal(notices[0].ok, false);
  assert.equal(notices[0].code, 'ENOSPC');
  assert.match(notices[0].message, /disk is full/);
  assert.ok(lines.some((line) => /storage: cannot save sessions: ENOSPC/.test(line)));

  const late = new WebSocket(url);
  const lateEvents = [];
  late.on('message', (raw) => lateEvents.push(JSON.parse(raw)));
  await new Promise((resolve) => late.once('open', resolve));
  t.after(() => late.close());
  await sleep(50);
  const types = lateEvents.map((event) => event.type);
  assert.ok(types.indexOf('engine.storage') >= 0 && types.indexOf('engine.storage') < types.indexOf('transcript.cache'),
    'a browser that connects later hears it in its connect burst');

  server.storageRecovered('sessions');
  await sleep(50);
  assert.deepEqual(events.filter((event) => event.type === 'engine.storage').at(-1), { type: 'engine.storage', ok: true });
});

test('a transcript entry that cannot be saved is dropped without stopping the session', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-storage-transcript-'));
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  t.after(async () => { await server.close(); rmSync(dataDir, { recursive: true, force: true }); });
  await server.listen();
  server.transcriptStore.append = () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); };
  assert.equal(server.storeTranscriptEntry('s1', 'agent', 'hello'), null);
  assert.equal(server.storageFailures.get('transcripts').code, 'ENOSPC');
});
