const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, existsSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { RESUME_FILE, RestartCoordinator, reexec, takeResumeList } = require('../src/restart');
const { HeadlessServer, resumeAfterRestart } = require('../src/server');

function harness(t, sessions) {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-restart-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  let clock = 0;
  let tickFn = null;
  const events = [];
  const calls = { closed: 0, exec: 0 };
  const server = { sessions: new Map(sessions.map((s) => [s.id, s])), close: async () => { calls.closed++; } };
  const restart = new RestartCoordinator({
    server, dataDir, stableMs: 10_000,
    isBusy: (s) => s.status !== 'idle' || s.menu.length > 0,
    exec: () => { calls.exec++; },
    now: () => clock,
    schedule: (fn) => { tickFn = fn; return 1; },
    cancel: () => { tickFn = null; },
    onChange: (event) => events.push(event),
  });
  const advance = async (ms) => { clock += ms; tickFn?.(); await new Promise((r) => setImmediate(r)); };
  return { dataDir, restart, advance, events, calls };
}
const session = (id, name, status = 'idle', menu = []) => ({ id, name, status, menu, closed: false });

test('restart when idle waits for every agent to stay idle, then restarts and records sessions to resume', async (t) => {
  const lead = session('s1', 'Lead', 'working');
  const shell = session('s2', 'Shell');
  const asking = session('s3', 'Reviewer', 'idle', ['1', '2']);
  const { dataDir, restart, advance, events, calls } = harness(t, [lead, shell, asking]);

  const first = restart.request({ whenIdle: true });
  assert.equal(first.state, 'waiting');
  assert.deepEqual(first.busy, ['Lead', 'Reviewer'], 'an agent waiting on the user counts as busy');

  lead.status = 'idle'; asking.menu = [];
  await advance(1000);
  assert.deepEqual(events.at(-1).busy, []);
  await advance(6000);
  lead.status = 'working';                       // starts again before the quiet period ends
  await advance(1000);
  lead.status = 'idle';
  for (let i = 0; i < 9; i++) await advance(1000);
  assert.equal(calls.exec, 0, 'the quiet period restarts after any activity');
  for (let i = 0; i < 2; i++) await advance(1000);
  assert.equal(calls.closed, 1);
  assert.equal(calls.exec, 1);
  assert.equal(events.at(-1).state, 'restarting');
  assert.deepEqual(takeResumeList(dataDir), ['s1', 's2', 's3']);
  assert.equal(existsSync(join(dataDir, RESUME_FILE)), false, 'the list is read once');
});

test('cancel stops waiting; restart now does not wait; no exec means no restart', async (t) => {
  const busy = session('s1', 'Lead', 'working');
  const { restart, advance, calls } = harness(t, [busy]);
  restart.request({ whenIdle: true });
  assert.equal(restart.cancel().state, 'idle');
  busy.status = 'idle';
  await advance(20_000);
  assert.equal(calls.exec, 0);
  busy.status = 'working';
  await restart.request({ whenIdle: false });
  assert.equal(calls.exec, 1, 'restart now goes ahead while agents work');

  const none = new RestartCoordinator({ server: { sessions: new Map() }, dataDir: '/nonexistent', isBusy: () => false, exec: null });
  assert.equal(none.snapshot().canRestart, false);
  assert.equal(none.request({ whenIdle: false }).state, 'idle');
  assert.equal(reexec({ execve: undefined }), null, 'older Node without execve cannot restart in place');
});

test('after a restart the engine resumes the recorded sessions that still exist', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-restart-resume-'));
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  t.after(async () => { await server.close(); rmSync(dataDir, { recursive: true, force: true }); });
  await server.listen();
  const a = server.createSession({ provider: 'shell', cwd: dataDir, name: 'A' });
  const b = server.createSession({ provider: 'shell', cwd: dataDir, name: 'B' });
  for (const s of [a, b]) { s.removePersistenceOnClose = false; s.close(); }
  for (let i = 0; i < 50 && server.sessions.size; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(server.sessions.size, 0);
  require('fs').writeFileSync(join(dataDir, RESUME_FILE), JSON.stringify({ sessions: [a.id, 'gone', b.id] }));
  const resumed = resumeAfterRestart(server, 50);
  assert.deepEqual(resumed, [a.id, b.id], 'sessions that no longer exist are skipped');
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual([...server.sessions.keys()].sort(), [a.id, b.id].sort());
});
