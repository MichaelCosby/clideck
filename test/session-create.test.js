const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { HeadlessServer } = require('../src/server');
const { parseOptions } = require('../src/cli');

async function post(httpUrl, body) {
  const response = await fetch(new URL('/api/session/create', httpUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('create spawns a sibling that inherits the caller provider, cwd and project', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-session-create-'));
  const work = join(dataDir, 'work');
  const other = join(dataDir, 'other');
  mkdirSync(work);
  mkdirSync(other);
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  try {
    const { httpUrl } = await server.listen();
    server.configStore.update({ projects: [{ id: 'p1', name: 'Proj', path: work, color: '#123456', collapsed: false }] });
    const caller = server.createSession({ provider: 'shell', cwd: work, name: 'Lead', projectId: 'p1' });
    assert.ok(caller);

    const sibling = await post(httpUrl, { callerSessionId: caller.id, name: 'Helper' });
    assert.equal(sibling.status, 200);
    assert.equal(sibling.body.session.provider, 'shell');
    assert.equal(sibling.body.session.cwd, work);
    assert.equal(sibling.body.session.projectId, 'p1');
    assert.equal(sibling.body.session.address, '@Proj/Helper');
    assert.ok(server.sessions.has(sibling.body.session.id));

    const elsewhere = await post(httpUrl, { callerSessionId: caller.id, provider: 'shell', cwd: other });
    assert.equal(elsewhere.status, 200);
    assert.equal(elsewhere.body.session.cwd, other);

    assert.equal((await post(httpUrl, { callerSessionId: caller.id, name: 'Helper' })).body.error, 'name_conflict');
    assert.equal((await post(httpUrl, { callerSessionId: caller.id, cwd: join(dataDir, 'missing') })).body.error, 'invalid_cwd');
    assert.equal((await post(httpUrl, { callerSessionId: caller.id, provider: 'nope' })).body.error, 'unknown_provider');
    assert.equal((await post(httpUrl, { callerSessionId: 'not-a-session' })).status, 404);

    const legacy = server.createSession({ provider: 'shell', cwd: other, name: 'Solo' });
    const peer = await post(httpUrl, { callerSessionId: legacy.id, name: 'Peer' });
    assert.equal(peer.status, 200);
    const agents = await (await fetch(new URL(`/api/session/agents?callerSessionId=${legacy.id}`, httpUrl))).json();
    assert.ok(agents.agents.some((agent) => agent.id === peer.body.session.id), 'sibling of a project-less caller is in its scope');
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('create places a session in the project whose folder its --cwd is, and --project chooses', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-session-place-'));
  const mine = join(dataDir, 'mine');
  const theirs = join(dataDir, 'theirs');
  const nested = join(theirs, 'pkg', 'deep');
  const loose = join(dataDir, 'loose');
  for (const dir of [mine, nested, loose]) mkdirSync(dir, { recursive: true });
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  try {
    const { httpUrl } = await server.listen();
    server.configStore.update({ projects: [
      { id: 'pm', name: 'Mine', path: mine, color: '#111111', collapsed: false },
      { id: 'pt', name: 'Theirs', path: theirs, color: '#222222', collapsed: false },
      { id: 'pd', name: 'Theirs-deep', path: join(theirs, 'pkg'), color: '#333333', collapsed: false },
    ] });
    const caller = server.createSession({ provider: 'shell', cwd: mine, name: 'Lead', projectId: 'pm' });

    const folder = await post(httpUrl, { callerSessionId: caller.id, cwd: theirs, name: 'A' });
    assert.equal(folder.body.session.projectId, 'pt');
    assert.equal(folder.body.session.projectName, 'Theirs');
    assert.equal(folder.body.session.placedByFolder, true);
    assert.equal(folder.body.session.address, '@Theirs/A');

    const inside = await post(httpUrl, { callerSessionId: caller.id, cwd: nested, name: 'B' });
    assert.equal(inside.body.session.projectId, 'pd', 'the deepest project containing the folder wins');

    const own = await post(httpUrl, { callerSessionId: caller.id, cwd: mine, name: 'C' });
    assert.equal(own.body.session.projectId, 'pm');
    assert.equal(own.body.session.placedByFolder, undefined, 'nothing to say when it stays in the caller\'s project');

    const none = await post(httpUrl, { callerSessionId: caller.id, cwd: loose, name: 'D' });
    assert.equal(none.body.session.projectId, 'pm', 'a folder in no project keeps the caller\'s project');

    const here = await post(httpUrl, { callerSessionId: caller.id, cwd: theirs, project: 'here', name: 'E' });
    assert.equal(here.body.session.projectId, 'pm');

    const named = await post(httpUrl, { callerSessionId: caller.id, project: 'theirs', name: 'F' });
    assert.equal(named.body.session.projectId, 'pt', 'a project name matches without regard to case');
    assert.equal(named.body.session.placedByFolder, undefined);

    const unknown = await post(httpUrl, { callerSessionId: caller.id, project: 'nowhere', name: 'G' });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error, 'unknown_project');
    assert.equal((await post(httpUrl, { callerSessionId: caller.id, project: '  ', name: 'H' })).status, 400);

    const inherit = await post(httpUrl, { callerSessionId: caller.id, name: 'I' });
    assert.equal(inherit.body.session.projectId, 'pm', 'no --cwd, no placement');
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('create resolves a relative --cwd against the calling shell', () => {
  const options = parseOptions(['--cwd', '../sibling', '--provider', 'codex', '--name', 'Rev'], {}, { allowCreate: true });
  assert.equal(options.cwd, join(process.cwd(), '..', 'sibling'));
  assert.equal(options.provider, 'codex');
  assert.equal(options.name, 'Rev');
  assert.equal(parseOptions(['--project', 'Sprut'], {}, { allowCreate: true }).project, 'Sprut');
  assert.throws(() => parseOptions(['--project'], {}, { allowCreate: true }), /requires a value/);
  assert.throws(() => parseOptions(['--cwd'], {}, { allowCreate: true }), /requires a value/);
});
