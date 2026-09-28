const test = require('node:test');
const assert = require('node:assert/strict');
const { readProcessInfo } = require('../src/process-info');
const { hasValidControlFields, isKnownControlType } = require('../src/control');

test('process info reads memory for a live pid and reports missing ones', async () => {
  const info = await readProcessInfo(process.pid);
  assert.equal(info.pid, process.pid);
  assert.ok(info.rssKb > 0 && info.vszKb >= info.rssKb);
  assert.ok((await readProcessInfo(undefined)).error);
  assert.ok((await readProcessInfo(2 ** 31 - 2)).error);
});

test('session.procInfo is an accepted control message that needs a session id', () => {
  assert.equal(isKnownControlType('session.procInfo'), true);
  assert.equal(hasValidControlFields({ type: 'session.procInfo', sessionId: 'abc' }), true);
  assert.equal(hasValidControlFields({ type: 'session.procInfo' }), false);
});
