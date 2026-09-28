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

test('create resolves a relative --cwd against the calling shell', () => {
  const options = parseOptions(['--cwd', '../sibling', '--provider', 'codex', '--name', 'Rev'], {}, { allowCreate: true });
  assert.equal(options.cwd, join(process.cwd(), '..', 'sibling'));
  assert.equal(options.provider, 'codex');
  assert.equal(options.name, 'Rev');
  assert.throws(() => parseOptions(['--cwd'], {}, { allowCreate: true }), /requires a value/);
});
