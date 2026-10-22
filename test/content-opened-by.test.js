const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { HeadlessServer } = require('../src/server');
const { isValidConfigPatch } = require('../src/config-store');

test('a file the user opens is marked openedBy user; an agent show is not', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-opened-by-'));
  const cwd = join(dataDir, 'work');
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'notes.md'), '# notes');
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  const session = { id: 'one', name: 'One', provider: { id: 'shell' }, cwd, closed: false, on() {}, once() {}, off() {}, close() {} };
  const broadcasts = [];
  server.broadcast = (event) => broadcasts.push(event);
  server.persistence.register(session);
  server.sessions.set(session.id, session);
  try {
    assert.equal(await server.openContent({ sessionId: 'one', path: join(cwd, 'notes.md') }), true);
    assert.equal(broadcasts.at(-1).type, 'content.show');
    assert.equal(broadcasts.at(-1).openedBy, 'user');
    server.publishContent('one', server.contentStore.addOpenPayload('one', '# x', 'markdown', 'agent.md'));
    assert.equal('openedBy' in broadcasts.at(-1), false);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the tab-switch setting accepts always, first and never', () => {
  for (const mode of ['always', 'first', 'never']) assert.equal(isValidConfigPatch({ switchToAgentTabs: mode }), true);
  assert.equal(isValidConfigPatch({ switchToAgentTabs: 'sometimes' }), false);
  assert.equal(isValidConfigPatch({ switchToAgentTabs: true }), false);
});
