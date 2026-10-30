const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { TaskManager, parseProcesses, collectProcesses, readOwners } = require('../src/task-manager');
const { HeadlessServer } = require('../src/server');
const p = (pid, ppid = 1, extra = {}) => ({ pid, ppid, uid: 501, pgid: pid, started: 'Thu Oct 29 06:00:00 2026', command: 'python work.py', commandHash: 'job', cpu: 1, memory: 1024, elapsed: '00:30', ...extra });
function fixture(extra = {}) {
  let now = 100000, rows = [p(10, 1), p(20, 10, { command: 'codex' }), p(21, 20), p(22, 21), p(30)];
  let calls = 0, ownerCalls = 0; const signals = [];
  const manager = new TaskManager({ platform: 'darwin', uid: 501, enginePid: 10,
    now: () => now, sessions: () => [{ id: 'a', name: 'Researcher', project: 'Study', pid: 20 }],
    collect: async () => { calls++; return rows.map(r => ({ ...r })); },
    readOwners: async selected => { ownerCalls++; return new Map(selected.filter(r => r.pid === 30).map(r => [r.pid, 'a'])); },
    signal: (pid, signal) => signals.push([pid, signal]), ...extra });
  return { manager, signals, advance: ms => now += ms, rows: value => rows = value, calls: () => calls, ownerCalls: () => ownerCalls };
}

test('parses macOS/Linux ps formats, multiline commands are excluded, secrets redacted', () => {
  const rows = parseProcesses(' 42 1 501 42 346.2 2048 02-01:20:30 Thu Oct 29 06:00:00 2026 python job.py --token secret\n 43 42 501 42 1.0 512 00:30 Thu Oct 29  6:00:00 2026 ignored\n');
  assert.equal(rows.length, 1); assert.equal(rows[0].memory, 2097152); assert.equal(rows[0].cpu, 346.2);
  assert(!rows[0].command.includes('secret')); assert.match(rows[0].command, /redacted/);
  assert.throws(() => parseProcesses(''), /No process/);
});

test('snapshot is lazy, coalesced across clients and cached for five seconds', async () => {
  const f = fixture(); assert.equal(f.calls(), 0);
  const [a, b] = await Promise.all([f.manager.snapshot(), f.manager.snapshot()]);
  assert.equal(f.calls(), 1); assert.equal(a, b);
  f.advance(4999); await f.manager.snapshot(); assert.equal(f.calls(), 1);
  f.advance(1); await f.manager.snapshot(); assert.equal(f.calls(), 2);
});

test('failures and unsupported platforms do not cause repeated expensive retries', async () => {
  let calls = 0; const f = fixture({ collect: async () => { calls++; throw Error('slow'); } });
  assert.equal((await f.manager.snapshot()).error, 'slow'); await f.manager.snapshot(); assert.equal(calls, 1);
  const windows = fixture({ platform: 'win32' }); assert.match((await windows.manager.snapshot()).error, /macOS and Linux/); assert.equal(windows.calls(), 0);
});

test('attributes descendants and detached tags; remembers identity after reparenting', async () => {
  const f = fixture(); const first = await f.manager.snapshot();
  assert.deepEqual(first.processes.filter(r => r.sessionId).map(r => r.pid), [20, 21, 22, 30]);
  assert.equal(first.processes.find(r => r.pid === 10).canStop, false);
  f.rows([p(10), p(20, 10, { command: 'codex' }), p(22, 1)]); f.advance(5000);
  assert.equal((await f.manager.snapshot()).processes.find(r => r.pid === 22).sessionId, 'a');
});

test('bounded detached discovery, negative cache, PID reuse loses ownership', async () => {
  let batch; const f = fixture({ readOwners: async rows => { batch = rows; return new Map(); } });
  f.rows([p(10), ...Array.from({ length: 40 }, (_, i) => p(50 + i, 1, { cpu: i }))]);
  await f.manager.snapshot(); assert.equal(batch.length, 8); assert.equal(batch[0].pid, 89);
  f.advance(5000); await f.manager.snapshot(); assert.equal(batch[0].pid, 81);
  const g = fixture(); await g.manager.snapshot();
  g.rows([p(10), p(22, 1, { started: 'new birth' })]); g.advance(5000);
  assert.equal((await g.manager.snapshot()).processes.find(r => r.pid === 22).sessionId, null);
});

test('stop targets current verified job tree, children before parent, never a process group', async () => {
  const f = fixture(); const snapshot = await f.manager.snapshot();
  const target = snapshot.processes.find(p => p.pid === 21);
  const result = await f.manager.stop(target.token);
  assert.deepEqual(f.signals, [[22, 'SIGTERM'], [21, 'SIGTERM']]); assert.equal(result.signalled, 2);
});

test('force requires prior normal stop and delay; arbitrary tokens and expired snapshots fail', async () => {
  const f = fixture(); const target = (await f.manager.snapshot()).processes.find(p => p.pid === 21);
  await assert.rejects(f.manager.stop('21'), /expired/);
  await assert.rejects(f.manager.stop(target.token, true), /normal stop/);
  await f.manager.stop(target.token); await assert.rejects(f.manager.stop(target.token, true), /normal stop/);
  f.advance(5000); await f.manager.snapshot(); await f.manager.stop(target.token, true);
  assert.deepEqual(f.signals.slice(-2), [[22, 'SIGKILL'], [21, 'SIGKILL']]);
  f.advance(21000); await assert.rejects(f.manager.stop(target.token), /expired/);
});

test('engine, agent, ancestor and other-user trees are protected', async () => {
  const f = fixture(); let snapshot = await f.manager.snapshot();
  for (const pid of [10, 20]) await assert.rejects(f.manager.stop(snapshot.processes.find(p => p.pid === pid).token), /protected/);
  f.rows([p(10), p(21), p(22, 21, { uid: 0 })]); f.advance(5000); snapshot = await f.manager.snapshot();
  await assert.rejects(f.manager.stop(snapshot.processes.find(p => p.pid === 21).token), /protected/);
  assert.deepEqual(f.signals, []);
});

test('native child executable is protected even beneath a launcher', async () => {
  const f = fixture(); f.rows([p(10), p(20, 10, { command: 'node /bin/codex' }), p(21, 20, { command: '/vendor/codex' })]);
  const snapshot = await f.manager.snapshot(); assert(!snapshot.processes.find(p => p.pid === 21).canStop);
  await assert.rejects(f.manager.stop(snapshot.processes.find(p => p.pid === 21).token), /protected/); assert.deepEqual(f.signals, []);
});

test('changed start time or executable refuses stop instead of signalling a reused PID', async () => {
  for (const extra of [{ started: 'new birth' }, { commandHash: 'different executable' }]) {
    const f = fixture(); const target = (await f.manager.snapshot()).processes.find(p => p.pid === 21);
    f.rows([p(10), p(21, 1, extra)]); await assert.rejects(f.manager.stop(target.token), /exited or changed/); assert.deepEqual(f.signals, []);
  }
});

test('second verification detects race and newly protected process before any signal', async () => {
  let reads = 0; const f = fixture({ collect: async () => { reads++; return [p(10), p(21, 1, { started: reads === 3 ? 'reused' : 'Thu Oct 29 06:00:00 2026' })]; } });
  const target = (await f.manager.snapshot()).processes.find(p => p.pid === 21);
  await assert.rejects(f.manager.stop(target.token), /tree changed/); assert.deepEqual(f.signals, []);
});

test('partial signal failures report honest counts', async () => {
  const f = fixture({ signal: pid => { if (pid === 22) throw Object.assign(Error(), { code: 'EPERM' }); } });
  const target = (await f.manager.snapshot()).processes.find(p => p.pid === 21);
  const result = await f.manager.stop(target.token); assert.equal(result.signalled, 1); assert.deepEqual(result.failed, [22]);
});

test('HTTP routes validate origin and payload; old control channel is not involved', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'clideck-tasks-http-')), f = fixture();
  const server = new HeadlessServer({ port: 0, dataDir: dir, taskManager: f.manager, autoSaveMs: 0 });
  t.after(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const { httpUrl } = await server.listen();
  assert.equal((await fetch(httpUrl + '/api/tasks', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal(f.calls(), 0);
  const response = await fetch(httpUrl + '/api/tasks'); assert.equal(response.headers.get('cache-control'), 'no-store');
  const snapshot = await response.json(); const token = snapshot.processes.find(p => p.pid === 21).token;
  const post = body => fetch(httpUrl + '/api/tasks/stop', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: httpUrl }, body: JSON.stringify(body) });
  assert.equal((await post({ token, force: false, pid: 1 })).status, 409);
  assert.equal((await post({ token, force: false })).status, 200); assert.equal(f.signals.length, 2);
});

test('real ps and ownership tag work; stop only our explicitly spawned test child', { skip: !['darwin', 'linux'].includes(process.platform) }, async t => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: { ...process.env, CLIDECK_SESSION_ID: 'task-manager-test-owned' }, stdio: 'ignore' });
  await once(child, 'spawn');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const rows = await collectProcesses(), own = rows.find(p => p.pid === child.pid); assert(own);
  const owners = await readOwners([own], process.platform); assert.equal(owners.get(child.pid), 'task-manager-test-owned');
  const manager = new TaskManager({ readOwners: async () => new Map() });
  const snapshot = await manager.snapshot(), target = snapshot.processes.find(p => p.pid === child.pid);
  const exited = once(child, 'exit'); const result = await manager.stop(target.token); assert.equal(result.signalled, 1);
  await exited;
});

test('new executable on the same PID loses force-stop permission', async () => {
  const f = fixture(); let target = (await f.manager.snapshot()).processes.find(p => p.pid === 21);
  await f.manager.stop(target.token); f.rows([p(10), p(21, 1, { commandHash: 'new job' })]); f.advance(5000);
  target = (await f.manager.snapshot()).processes.find(p => p.pid === 21);
  assert.equal(target.forceAllowed, false); await assert.rejects(f.manager.stop(target.token, true), /normal stop/);
});

test('new descendants between stop verifications cause refusal, not an incomplete tree stop', async () => {
  let reads = 0; const f = fixture({ collect: async () => { reads++; return [p(10), p(21), ...(reads === 3 ? [p(22, 21)] : [])]; } });
  const target = (await f.manager.snapshot()).processes.find(p => p.pid === 21);
  await assert.rejects(f.manager.stop(target.token), /tree changed/); assert.deepEqual(f.signals, []);
});
