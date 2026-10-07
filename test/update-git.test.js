const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createGitUpdates } = require('../src/update-git');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

function commit(dir, file, content, message) {
  fs.writeFileSync(join(dir, file), content);
  sh(dir, 'add', file);
  sh(dir, 'commit', '-q', '-m', message);
}

// A fork on "GitHub" (bare repo), a checkout running CliDeck, and a second clone that pushes new work.
function setup(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'clideck-git-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'fork.git'), dev = join(root, 'dev'), running = join(root, 'running');
  sh(root, 'init', '-q', '--bare', '-b', 'main', remote);
  sh(root, 'clone', '-q', remote, dev);
  commit(dev, 'package.json', JSON.stringify({ name: 'clideck', version: '2.4.0' }), 'start');
  commit(dev, 'package-lock.json', '{}', 'lock');
  sh(dev, 'push', '-q', 'origin', 'HEAD:main');
  sh(root, 'clone', '-q', remote, running);
  return { dev, running };
}

test('a checkout that is behind its fork offers and installs the new commits', async (t) => {
  const { dev, running } = setup(t);
  const npmCalls = [];
  const updates = createGitUpdates({ root: running, findNpm: () => '/fake/npm-cli.js', npm: async (node, cli, args) => { npmCalls.push(args); } });

  assert.deepEqual(await updates.check(), { state: 'current' });

  commit(dev, 'feature.txt', 'new', 'feature');
  commit(dev, 'package.json', JSON.stringify({ name: 'clideck', version: '2.4.1' }), 'bump');
  sh(dev, 'push', '-q', 'origin', 'HEAD:main');
  const offer = await updates.check();
  assert.equal(offer.state, 'available');
  assert.equal(offer.canInstall, true);
  assert.match(offer.latestVersion, /^2\.4\.1 · [0-9a-f]{7} \(2 new commits on origin\/main\)$/);

  await updates.installer.install();
  assert.equal(sh(running, 'rev-parse', 'HEAD'), sh(dev, 'rev-parse', 'HEAD'));
  assert.equal(npmCalls.length, 0, 'npm ci only runs when the lockfile changed');
  assert.deepEqual(await updates.check(), { state: 'current' });

  commit(dev, 'package-lock.json', '{"v":2}', 'deps');
  sh(dev, 'push', '-q', 'origin', 'HEAD:main');
  await updates.check();
  await updates.installer.install();
  assert.deepEqual(npmCalls, [['ci', '--prefix', running, '--no-audit', '--no-fund']]);
});

test('local commits or edits block the automatic update, and nothing is installed without a check', async (t) => {
  const { dev, running } = setup(t);
  const updates = createGitUpdates({ root: running, findNpm: () => '', npm: async () => {} });
  await assert.rejects(updates.installer.install(), /Check for updates again/);

  commit(dev, 'a.txt', '1', 'upstream work');
  sh(dev, 'push', '-q', 'origin', 'HEAD:main');
  fs.writeFileSync(join(running, 'package.json'), '{"edited":true}');
  const dirty = await updates.check();
  assert.equal(dirty.canInstall, false);
  assert.match(dirty.instruction, /uncommitted changes/);

  sh(running, 'checkout', '-q', '--', 'package.json');
  commit(running, 'local.txt', 'mine', 'local work');
  const diverged = await updates.check();
  assert.equal(diverged.canInstall, false);
  assert.match(diverged.instruction, /not on origin\/main/);
  await assert.rejects(updates.installer.install(), /Check for updates again/);

  sh(running, 'branch', '-q', '--unset-upstream');
  assert.match((await updates.check()).error, /does not track a remote branch/);
});
