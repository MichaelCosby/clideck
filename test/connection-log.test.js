const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { WebSocket } = require('ws');
const { HeadlessServer } = require('../src/server');

test('each browser connect and disconnect is logged with where it came from and why it ended', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-connection-log-'));
  const lines = [];
  const engine = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0, logConnections: (line) => lines.push(line) });
  let silent = null;
  t.after(async () => {
    await engine.close();
    await silent?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const { url } = await engine.listen();
  const waitForLine = async (pattern) => {
    for (let i = 0; i < 200; i++) {
      const line = lines.find((entry) => pattern.test(entry));
      if (line) return line;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no log line matching ${pattern}: ${JSON.stringify(lines)}`);
  };

  const socket = new WebSocket(url, { headers: { 'X-Forwarded-For': '100.64.0.7, 172.20.0.2' } });
  await new Promise((resolve) => socket.once('open', resolve));
  assert.equal(await waitForLine(/#1 connected/), 'browser #1 connected from 100.64.0.7 (1 open)');
  socket.close(4000, 'no reply for 10s');
  assert.match(await waitForLine(/#1 disconnected/), /^browser #1 disconnected: code 4000 \(no reply for 10s\) after \d+s \(0 open\)$/);

  silent = new HeadlessServer({ port: 0, dataDir: join(dataDir, 'quiet'), autoSaveMs: 0 });
  const quiet = new WebSocket((await silent.listen()).url);
  await new Promise((resolve) => quiet.once('open', resolve));
  quiet.close();
  assert.equal(lines.length, 2, 'engines without a logger (tests, embedding) log nothing');
});
