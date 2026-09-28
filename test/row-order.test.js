const test = require('node:test');
const assert = require('node:assert/strict');

test('rows order pinned, needs-you, working, idle, stopped; newest arrival first within a status', async () => {
  const { createRowOrder, rankOf, RANK } = await import('../public/js/ui/row-order.js');
  const s = (id, extra = {}) => ({ id, live: true, status: 'idle', attention: false, ...extra });
  assert.equal(rankOf(s('a', { attention: true }), []), RANK.attention);
  assert.equal(rankOf(s('a', { live: false }), ['a']), RANK.pinned);

  const order = createRowOrder();
  const seq = { idle1: 0, idle2: 1, work: 2, needs: 3, stopped: 4, pin: 5 };
  const pinned = ['pin'];
  order.note(s('idle1'), pinned, 100);
  order.note(s('idle2'), pinned, 100);
  order.note(s('work', { status: 'working' }), pinned, 100);
  order.note(s('needs', { attention: true }), pinned, 100);
  order.note(s('stopped', { live: false, lastActive: '2026-09-01T00:00:00Z' }), pinned, 100);
  order.note(s('pin', { status: 'working' }), pinned, 100);
  const sorted = () => order.sort(Object.keys(seq), pinned, (id) => seq[id]);
  assert.deepEqual(sorted(), ['pin', 'needs', 'work', 'idle1', 'idle2', 'stopped'], 'first sighting keeps arrival order');

  order.note(s('idle2', { status: 'working' }), pinned, 200);
  order.note(s('idle2'), pinned, 300);
  assert.deepEqual(sorted(), ['pin', 'needs', 'work', 'idle2', 'idle1', 'stopped'], 'a session that just finished tops the idle rows');

  order.note(s('work', { status: 'working' }), pinned, 400);
  assert.deepEqual(sorted(), ['pin', 'needs', 'work', 'idle2', 'idle1', 'stopped'], 'staying in a status does not move a row');
});

test('deleting a session drops its pin', () => {
  const { mkdtempSync, rmSync } = require('fs');
  const { tmpdir } = require('os');
  const { join } = require('path');
  const { HeadlessServer } = require('../src/server');
  const { isValidConfigPatch } = require('../src/config-store');
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-pins-'));
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  const events = [];
  server.broadcast = (event) => events.push(event);
  try {
    server.configStore.update({ pinnedSessions: ['keep', 'gone'] });
    server.removeSessionState('gone');
    assert.deepEqual(server.configStore.get().pinnedSessions, ['keep']);
    assert.ok(events.some((event) => event.type === 'config'), 'browsers hear about the change');
    assert.equal(isValidConfigPatch({ pinnedSessions: 'keep' }), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
