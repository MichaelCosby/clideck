const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const WebSocket = require('ws');
const { HeadlessServer } = require('../src/server');

test('the engine answers a heartbeat ping without closing the socket', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-heartbeat-'));
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  try {
    const { url } = await server.listen();
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const pong = new Promise((resolve) => socket.on('message', (data) => {
      if (JSON.parse(data).type === 'pong') resolve(true);
    }));
    socket.send(JSON.stringify({ type: 'ping' }));
    assert.equal(await pong, true);
    assert.equal(socket.readyState, WebSocket.OPEN);
    socket.close();
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
