const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, join } = require('node:path');
const { downloadGithubPlugin, formatGithubSource, parseGithubSource } = require('../src/plugin-github');
const { PluginManager } = require('../src/plugin-manager');

const manifest = (id, version, extra = {}) => JSON.stringify({ id, name: id, version, apiVersion: 1, ...extra });

function writePlugin(dir, id, version, server) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, 'clideck-plugin.json'), manifest(id, version));
  if (server) fs.writeFileSync(join(dir, 'server.js'), server);
}

// A GitHub-style tarball: everything under one top-level "<repo>-<sha>/" folder.
function tarball(root, build) {
  const top = join(root, 'src', 'repo-abc123');
  build(top);
  const file = join(root, 'repo.tar.gz');
  execFileSync('tar', ['-czf', file, '-C', join(root, 'src'), 'repo-abc123']);
  fs.rmSync(join(root, 'src'), { recursive: true, force: true });
  return fs.readFileSync(file);
}

test('GitHub sources parse from shorthand and links, and reject unsafe paths', () => {
  assert.deepEqual(parseGithubSource('MichaelCosby/clideck-plugins/plugins/sysmon'),
    { owner: 'MichaelCosby', repo: 'clideck-plugins', ref: '', subpath: 'plugins/sysmon' });
  assert.deepEqual(parseGithubSource('https://github.com/MichaelCosby/clideck-plugins/tree/clideck-2x/plugins/sysmon'),
    { owner: 'MichaelCosby', repo: 'clideck-plugins', ref: 'clideck-2x', subpath: 'plugins/sysmon' });
  assert.equal(parseGithubSource('github.com/a/b.git').repo, 'b');
  assert.equal(parseGithubSource('a/b/../etc'), null);
  assert.equal(parseGithubSource('just-one'), null);
  assert.equal(parseGithubSource('a b/c'), null);
  assert.equal(formatGithubSource(parseGithubSource('https://github.com/a/b/tree/dev/p')), 'https://github.com/a/b/tree/dev/p');
  assert.equal(formatGithubSource(parseGithubSource('a/b/p')), 'a/b/p');
});

test('a download unpacks the plugin folder, named after its id', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'clideck-gh-download-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = tarball(root, (top) => {
    writePlugin(join(top, 'plugins', 'sysmon'), 'sysmon', '2.0.0');
    writePlugin(top, 'root-plugin', '1.0.0');
  });
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); return new Response(bytes); };

  const nested = await downloadGithubPlugin(parseGithubSource('o/r/plugins/sysmon'), { fetchImpl });
  assert.equal(basename(nested.dir), 'sysmon');
  assert.match(fs.readFileSync(join(nested.dir, 'clideck-plugin.json'), 'utf8'), /2\.0\.0/);
  assert.equal(seen[0], 'https://codeload.github.com/o/r/tar.gz/HEAD');
  nested.cleanup();
  assert.equal(fs.existsSync(nested.dir), false, 'cleanup removes the download');

  const top = await downloadGithubPlugin(parseGithubSource('https://github.com/o/r/tree/dev'), { fetchImpl });
  assert.equal(basename(top.dir), 'root-plugin', 'a repository-root plugin is staged under its id');
  assert.equal(seen[1], 'https://codeload.github.com/o/r/tar.gz/dev');
  top.cleanup();

  await assert.rejects(downloadGithubPlugin(parseGithubSource('o/r/missing'), { fetchImpl }), /No clideck-plugin.json/);
  await assert.rejects(downloadGithubPlugin(parseGithubSource('o/r'), { fetchImpl: async () => new Response('', { status: 404 }) }), /no repository or branch/);
});

test('update swaps in the new version, and restores the old one if it fails to load', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'clideck-gh-update-'));
  const manager = new PluginManager({ dataDir: join(root, 'state'), bundledDir: join(root, 'empty'), log: () => {} });
  t.after(async () => { await manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await manager.start();
  const v1 = join(root, 'v1', 'demo'); writePlugin(v1, 'demo', '1.0.0', 'exports.activate = () => {};');
  const v2 = join(root, 'v2', 'demo'); writePlugin(v2, 'demo', '2.0.0', 'exports.activate = () => {};');
  const broken = join(root, 'v3', 'demo'); writePlugin(broken, 'demo', '3.0.0', 'exports.activate = () => { throw new Error("boom"); };');
  const other = join(root, 'v4', 'other'); writePlugin(other, 'other', '1.0.0');

  await manager.install(v1);
  const updated = await manager.update('demo', v2);
  assert.equal(updated.manifest.version, '2.0.0');
  assert.equal(updated.status, 'ready');

  await assert.rejects(manager.update('demo', broken), /previous version restored/);
  const restored = manager.snapshot().find((p) => p.id === 'demo');
  assert.equal(restored.version, '2.0.0');
  assert.equal(restored.status, 'ready');
  assert.deepEqual(fs.readdirSync(join(root, 'state', 'plugins')), ['demo'], 'no temporary folders are left behind');

  await assert.rejects(manager.update('demo', other), /not "demo"/);
});

test('the engine installs from GitHub, remembers the source, updates, and forgets it on removal', async (t) => {
  const WebSocket = require('ws');
  const { HeadlessServer } = require('../src/server');
  const root = fs.mkdtempSync(join(tmpdir(), 'clideck-gh-engine-'));
  const server = new HeadlessServer({ port: 0, dataDir: join(root, 'state'), autoSaveMs: 0 });
  t.after(async () => { await server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let version = '1.0.0';
  server.githubDownloader = async () => {
    const dir = join(fs.mkdtempSync(join(root, 'dl-')), 'demo');
    writePlugin(dir, 'demo', version);
    return { dir, cleanup: () => fs.rmSync(join(dir, '..'), { recursive: true, force: true }) };
  };
  const { url } = await server.listen();
  const socket = new WebSocket(url);
  await new Promise((resolve) => socket.once('open', resolve));
  t.after(() => socket.close());
  const call = (message) => new Promise((resolve) => {
    const requestId = 'r' + Math.random().toString(36).slice(2);
    const onMessage = (data) => {
      const event = JSON.parse(data);
      if (event.type === 'plugin.result' && event.requestId === requestId) { socket.off('message', onMessage); resolve(event); }
    };
    socket.on('message', onMessage);
    socket.send(JSON.stringify({ ...message, requestId }));
  });

  const bad = await call({ type: 'plugin.github.install', source: 'not a repo' });
  assert.equal(bad.success, false);
  const installed = await call({ type: 'plugin.github.install', source: 'MichaelCosby/clideck-plugins/plugins/demo' });
  assert.equal(installed.success, true);
  assert.equal(server.configStore.get().pluginSources.demo, 'MichaelCosby/clideck-plugins/plugins/demo');
  version = '1.1.0';
  const updated = await call({ type: 'plugin.github.update', pluginId: 'demo' });
  assert.equal(updated.success, true);
  assert.equal(server.pluginManager.snapshot().find((p) => p.id === 'demo').version, '1.1.0');
  const removed = await call({ type: 'plugin.remove', pluginId: 'demo' });
  assert.equal(removed.success, true);
  assert.equal(server.configStore.get().pluginSources.demo, undefined);
});
