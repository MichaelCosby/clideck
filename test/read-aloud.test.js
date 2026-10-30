const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { AgentSession } = require('../src/session');
const { getProvider } = require('../src/providers');
const { HeadlessServer } = require('../src/server');
const { SessionPersistence } = require('../src/persistence');
const { hasValidControlFields } = require('../src/control');
const { createBackup, parseBackup } = require('../src/backup');

test('read-aloud validates explicit boolean controls and remains off for old sessions', () => {
  const message = { type: 'session.readAloud', sessionId: 'one' };
  for (const enabled of [false, true]) assert(hasValidControlFields({ ...message, enabled }));
  for (const enabled of [undefined, null, 'true', 1]) assert(!hasValidControlFields({ ...message, enabled }));
  assert.equal(new AgentSession({ provider: getProvider('shell') }).snapshot().readAloud, false);
});

test('read-aloud is independent per session and persists through reload, backup, resume and restart', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-read-aloud-'));
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  t.after(async () => { server.sessions.clear(); await server.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const events = [];
  server.broadcast = event => events.push(event);
  const a = new AgentSession({ id: 'one', provider: getProvider('shell'), cwd: tmpdir() });
  const b = new AgentSession({ id: 'two', provider: getProvider('shell'), cwd: tmpdir() });
  server.persistence.register(a); server.persistence.register(b); server.sessions.set(a.id, a);
  const socket = { send() {}, close() { assert.fail('valid control'); } };
  server.handleControl(socket, Buffer.from(JSON.stringify({ type: 'session.readAloud', sessionId: a.id, enabled: true })));
  assert.equal(a.readAloud, true); assert.equal(b.readAloud, false);
  assert.equal(events.at(-1).readAloud, true); assert.equal(events.at(-1).sessionId, a.id);
  assert.equal(server.setSessionReadAloud(b.id, true), true);
  assert.equal(events.at(-1).live, false); assert.equal(events.at(-1).readAloud, true);
  server.setSessionReadAloud(a.id, false);
  assert.equal(server.persistence.get(a.id).readAloud, false);
  assert.equal(server.persistence.get(b.id).readAloud, true);
  assert.equal(server.setSessionReadAloud('missing', true), false);
  const reloaded = new SessionPersistence({ dataDir });
  assert.equal(reloaded.get(a.id).readAloud, false); assert.equal(reloaded.get(b.id).readAloud, true);
  reloaded.close();
  const backup = createBackup(server);
  assert.equal(parseBackup(backup).sessions.find(s => s.id === b.id).readAloud, true);
  const invalid = structuredClone(backup); invalid.sessions[0].readAloud = 'true';
  assert.throws(() => parseBackup(invalid));
  // Capture launch options without ever spawning a provider or PTY.
  let options;
  server.startSession = value => { options = value; return a; };
  server.resumeSession(b.id);
  assert.equal(options.readAloud, true);
  server.setSessionReadAloud(a.id, true);
  a.stopForRestart = async () => {};
  await server.restartSession({ sessionId: a.id });
  assert.equal(options.readAloud, true);
});
