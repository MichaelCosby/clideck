const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const WebSocket = require('ws');
const { HeadlessServer } = require('../src/server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function connect(url) {
  const socket = new WebSocket(url);
  const events = [];
  socket.on('message', (raw) => events.push(JSON.parse(raw)));
  return new Promise((resolve) => socket.once('open', () => resolve({ socket, events })));
}
const historyReply = async (client, sessionId, requestId) => {
  client.socket.send(JSON.stringify({ type: 'session.history', sessionId, requestId }));
  for (let i = 0; i < 100; i++) {
    const reply = client.events.find((e) => e.type === 'session.history.result' && e.requestId === requestId);
    if (reply) return reply;
    await sleep(20);
  }
  throw new Error('no history reply');
};

test('a lazy browser gets history on request, live or stopped; others still get it on connect', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-lazy-'));
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  t.after(async () => { await server.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const { url } = await server.listen();
  const live = server.createSession({ provider: 'shell', cwd: dataDir, name: 'Live' });
  const stopped = server.createSession({ provider: 'shell', cwd: dataDir, name: 'Stopped' });
  live.writeInput('echo hello-lazy\r');
  stopped.writeInput('echo goodbye-lazy\r');
  await sleep(800);
  stopped.removePersistenceOnClose = false; stopped.close();
  for (let i = 0; i < 50 && server.sessions.has(stopped.id); i++) await sleep(50);

  const lazy = await connect(url + '/?history=lazy');
  const eager = await connect(url);
  await sleep(300);
  assert.equal(lazy.events.some((e) => e.type === 'output' && e.replay), false, 'no history on connect');
  assert.ok(lazy.events.some((e) => e.type === 'session.created' && e.sessionId === stopped.id), 'rows still arrive');
  assert.ok(eager.events.some((e) => e.type === 'output' && e.replay && e.sessionId === live.id), 'a non-lazy browser keeps the old behaviour');

  const liveReply = await historyReply(lazy, live.id, 'r1');
  assert.match(liveReply.data, /hello-lazy/);
  assert.equal(liveReply.data, server.persistence.historyTail(live.id));
  assert.equal(liveReply.partial, false);
  const stoppedReply = await historyReply(lazy, stopped.id, 'r2');
  assert.match(stoppedReply.data, /goodbye-lazy/, 'a stopped session answers from saved history');
  assert.equal((await historyReply(lazy, 'no-such-session', 'r3')).data, '');
  lazy.socket.close(); eager.socket.close();
});

test('history reply plus later output reproduces the engine history exactly, even mid-stream', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-lazy-order-'));
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  t.after(async () => { await server.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const { url } = await server.listen();
  const session = server.createSession({ provider: 'shell', cwd: dataDir, name: 'Printer' });
  await sleep(500);
  session.writeInput('for i in $(seq 1 4000); do echo "line $i"; done; echo DONE-MARK\r');
  await sleep(80);
  const client = await connect(url + '/?history=lazy');
  const reply = await historyReply(client, session.id, 'mid');
  for (let i = 0; i < 200 && !server.persistence.historyTail(session.id).includes('DONE-MARK\r\n'); i++) await sleep(50);
  await sleep(300);
  const index = client.events.indexOf(reply);
  const after = client.events.slice(index + 1).filter((e) => e.type === 'output' && e.sessionId === session.id).map((e) => e.data).join('');
  assert.ok(reply.data.length > 0 && after.length > 0, 'the request landed while output was streaming');
  assert.equal(reply.data + after, server.persistence.historyTail(session.id));
  client.socket.close();
});
