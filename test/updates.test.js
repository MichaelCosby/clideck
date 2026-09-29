const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const { Updates } = require('../src/updates');
const { createUpdateInstaller, runNpm } = require('../src/update-install');
const { getUpdateStatus } = require('../src/update-check');
const { hasValidControlFields } = require('../src/control');

function service(options = {}) {
  const events = [], timers = [], installed = [];
  const updates = new Updates({
    currentVersion: '2.3.2',
    check: async () => ({ state: 'available', latestVersion: '2.4.0' }),
    installer: { capability: async () => ({ canInstall: true }), install: async v => { installed.push(v); } },
    onChange: e => events.push(e),
    schedule: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; }, cancel() {},
    ...options,
  });
  return { updates, events, timers, installed };
}

test('background check offers the known release; only an explicit action installs it', async () => {
  const { updates, events, installed, timers } = service();
  await updates.check();
  assert.equal(updates.snapshot().state, 'available');
  assert.equal(installed.length, 0);
  assert.equal(timers[0].ms, 6 * 60 * 60 * 1000);
  await updates.install();
  assert.deepEqual(installed, ['2.4.0']);
  assert.equal(updates.snapshot().state, 'installed');
  await updates.check();
  await updates.install();
  assert.deepEqual(installed, ['2.4.0']);
  assert.deepEqual(events.map(e => e.state), ['checking', 'available', 'installing', 'installed']);
});

test('checks and multi-client update clicks coalesce and cannot overwrite install state', async () => {
  let resolveCheck, resolveInstall, count = 0;
  const { updates } = service({
    check: () => new Promise(resolve => { resolveCheck = resolve; }),
    installer: { capability: async () => ({ canInstall: true }), install: () => { count++; return new Promise(resolve => { resolveInstall = resolve; }); } },
  });
  const a = updates.check(), b = updates.check();
  await Promise.resolve();
  await updates.install();
  assert.equal(count, 0);
  resolveCheck({ state: 'available', latestVersion: '2.4.0' });
  await Promise.all([a, b]);
  const x = updates.install(), y = updates.install();
  await Promise.resolve();
  await updates.check();
  assert.equal(updates.snapshot().state, 'installing');
  assert.equal(count, 1);
  resolveInstall();
  await Promise.all([x, y]);
  assert.equal(updates.snapshot().state, 'installed');
});

test('offline differs from up to date, retries, and never offers an installation', async () => {
  const result = await getUpdateStatus({ currentVersion: '2.3.2', transport: async () => { throw new Error('offline'); } });
  assert.equal(result.state, 'error');
  const { updates, timers, installed } = service({ check: async () => result });
  await updates.check();
  await updates.install();
  assert.equal(installed.length, 0);
  assert.equal(timers[0].ms, 5 * 60 * 1000);
  const current = await getUpdateStatus({ currentVersion: '2.3.2', transport: async () => '{"version":"2.3.2"}' });
  assert.equal(current.state, 'current');
});

test('unsupported installs show instructions; failure remains retryable without success claims', async () => {
  const unsupported = service({ installer: { capability: async () => ({ canInstall: false, instruction: 'Update source checkout.' }), install: () => assert.fail('must not install') } });
  await unsupported.updates.check();
  await unsupported.updates.install();
  assert.equal(unsupported.updates.snapshot().state, 'available');
  let attempts = 0;
  const { updates } = service({ installer: { capability: async () => ({ canInstall: true }), install: async () => { if (++attempts === 1) throw new Error('Permission denied'); } } });
  await updates.check();
  await updates.install();
  assert.equal(updates.snapshot().state, 'error');
  assert.match(updates.snapshot().error, /Permission/);
  await updates.install();
  assert.equal(updates.snapshot().state, 'installed');
});

test('closing waits for authorized install but never starts another', async () => {
  let finish;
  const { updates } = service({ installer: { capability: async () => ({ canInstall: true }), install: () => new Promise(resolve => { finish = resolve; }) } });
  await updates.check();
  const install = updates.install();
  await Promise.resolve();
  let closed = false;
  const close = updates.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  finish();
  await Promise.all([install, close]);
  assert.equal(closed, true);
  await updates.install();
});

test('update controls accept no client-supplied package/version/command', () => {
  for (const type of ['engine.update.check', 'engine.update.install']) {
    assert.equal(hasValidControlFields({ type }), true);
    for (const key of ['version', 'package', 'command', 'prefix']) assert.equal(hasValidControlFields({ type, [key]: 'evil' }), false);
  }
});

function installation(t) {
  const dir = mkdtempSync(join(tmpdir(), 'clideck-update-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const globalRoot = join(dir, 'lib/node_modules');
  const root = join(globalRoot, 'clideck');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"clideck","version":"2.3.2"}');
  return { dir, root, globalRoot };
}

test('installer verifies destination, pins package and registry, then verifies installed version', async t => {
  const { dir, root, globalRoot } = installation(t), calls = [];
  const installer = createUpdateInstaller({ root, node: '/trusted/node', findNpm: () => '/trusted/npm/bin/npm-cli.js',
    run: async (node, cli, args, timeout) => {
      calls.push({ node, cli, args, timeout });
      if (args[0] === 'root') return globalRoot;
      if (args[0] === 'prefix') return dir;
      writeFileSync(join(root, 'package.json'), '{"name":"clideck","version":"2.4.0"}');
      return '';
    },
  });
  assert.deepEqual(await installer.capability(), { canInstall: true });
  await installer.install('2.4.0');
  assert.deepEqual(calls.at(-1), {
    node: '/trusted/node', cli: '/trusted/npm/bin/npm-cli.js', timeout: 300000,
    args: ['install', '--global', '--prefix', dir, 'clideck@2.4.0', '--registry', 'https://registry.npmjs.org', '--no-audit', '--no-fund'],
  });
  await assert.rejects(installer.install('2.4.0;evil'));
});

test('source checkouts and mismatched npm roots cannot install', async t => {
  const { dir, root } = installation(t);
  const installer = createUpdateInstaller({ root, findNpm: () => '/npm/bin/npm-cli.js', run: async () => dir });
  assert.equal((await installer.capability()).canInstall, false);
  await assert.rejects(installer.install('2.4.0'));
  mkdirSync(join(root, '.git'));
  const source = createUpdateInstaller({ root, run: () => assert.fail('npm must not run for source') });
  assert.match((await source.capability()).instruction, /source checkout/);
  await assert.rejects(source.install('2.4.0'));
});

test('successful npm exit with unchanged package is an update failure', async t => {
  const { dir, root, globalRoot } = installation(t);
  const installer = createUpdateInstaller({ root, findNpm: () => '/npm/bin/npm-cli.js',
    run: async (node, cli, args) => args[0] === 'root' ? globalRoot : args[0] === 'prefix' ? dir : '',
  });
  await assert.rejects(installer.install('2.4.0'), /could not be completed/);
});

test('npm runner deadline kills its own lifecycle descendants before returning', { skip: process.platform === 'win32' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'clideck-update-process-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, 'fake-npm.js'), signal = join(dir, 'child-fired');
  writeFileSync(script, `require('child_process').spawn(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1] + ".ready", "ready"); setTimeout(() => require("fs").writeFileSync(process.argv[1], "bad"), 700)', process.argv[2]], {stdio: 'inherit'}); setInterval(() => {}, 1000);`);
  await assert.rejects(runNpm(process.execPath, script, [signal], 150), /timed out/);
  assert.equal(existsSync(signal + '.ready'), true, 'lifecycle child really ran before timeout');
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(existsSync(signal), false);
});

test('server replays update status and routes explicit controls without affecting sessions', async t => {
  const { HeadlessServer } = require('../src/server');
  const dir = mkdtempSync(join(tmpdir(), 'clideck-update-server-'));
  const { updates, installed } = service();
  const server = new HeadlessServer({ port: 0, dataDir: dir, updates, autoSaveMs: 0 });
  updates.onChange = event => server.broadcast(event);
  t.after(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); });
  await server.listen();
  await updates.check();
  const messages = [];
  const socket = { readyState: 1, send: raw => messages.push(JSON.parse(raw)), on() {}, close() {} };
  server.handleConnection(socket);
  assert.equal(messages.at(-1).state, 'available');
  server.handleControl(socket, Buffer.from('{"type":"engine.update.install"}'));
  await updates.installing;
  assert.deepEqual(installed, ['2.4.0']);
  assert.equal(messages.at(-1).state, 'installed');
  server.handleControl(socket, Buffer.from('{"type":"engine.update.check"}'));
  await Promise.resolve();
  assert.equal(messages.at(-1).state, 'installed');
  assert.equal(messages.some(e => e.type === 'session.closed'), false);
  const replay = [];
  server.handleConnection({ ...socket, send: raw => replay.push(JSON.parse(raw)) });
  assert.equal(replay.at(-1).state, 'installed');
});

test('npm discovery supports runtime and Homebrew layouts, never an unrelated PATH npm', t => {
  const { npmCli } = require('../src/update-install');
  const dir = mkdtempSync(join(tmpdir(), 'clideck-update-npm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const node = join(dir, 'Cellar/node@24/24.1.0/bin/node');
  const cli = join(dir, 'lib/node_modules/npm/bin/npm-cli.js');
  mkdirSync(require('path').dirname(node), { recursive: true }); writeFileSync(node, '');
  assert.equal(npmCli(node), '');
  mkdirSync(require('path').dirname(cli), { recursive: true }); writeFileSync(cli, '');
  assert.equal(npmCli(node), require('fs').realpathSync(cli));
  const kegCli = join(require('path').dirname(node), '../lib/node_modules/npm/bin/npm-cli.js');
  mkdirSync(require('path').dirname(kegCli), { recursive: true }); writeFileSync(kegCli, '');
  assert.equal(npmCli(node), require('fs').realpathSync(kegCli));
  const unrelated = join(dir, 'other/bin/node');
  mkdirSync(require('path').dirname(unrelated), { recursive: true }); writeFileSync(unrelated, '');
  assert.equal(npmCli(unrelated), '');
});

test('distribution npm layout is derived from Node without searching PATH', t => {
  const { npmCli } = require('../src/update-install');
  const dir = mkdtempSync(join(tmpdir(), 'clideck-update-distro-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const node = join(dir, 'usr/bin/node');
  const cli = join(dir, 'usr/share/nodejs/npm/bin/npm-cli.js');
  for (const file of [node, cli]) {
    mkdirSync(require('path').dirname(file), { recursive: true });
    writeFileSync(file, '');
  }
  assert.equal(npmCli(node), require('fs').realpathSync(cli));
});

test('an installation disappearing after the check reports useful recovery instructions', async t => {
  const { dir, root, globalRoot } = installation(t);
  const installer = createUpdateInstaller({ root, findNpm: () => '/npm/bin/npm-cli.js',
    run: async (node, cli, args) => args[0] === 'root' ? globalRoot : dir,
  });
  assert.equal((await installer.capability()).canInstall, true);
  rmSync(root, { recursive: true });
  await assert.rejects(installer.install('2.4.0'), /Run npm install.*restart CliDeck/);
});
