const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { WebSocket } = require('ws');
const { HeadlessServer } = require('../src/server');
const { hasValidControlFields } = require('../src/control');

const manifest = {
  id: 'toggle-thing', name: 'Toggle Thing', version: '1.0.0', apiVersion: 1, description: 'Toggles a thing per session.',
};

// Server-side actions, as a plugin would write them: state lives here, so `when` reads it directly.
const server = `
exports.activate = (api) => {
  const on = new Set();
  const set = (id, value) => {
    if (value) on.add(id); else on.delete(id);
    api.setSessionBadge(id, value ? { label: 'Thing', icon: '✓', title: 'The thing is on' } : null);
    api.refreshActions();
  };
  api.registerAction({
    id: 'enable', label: 'Enable thing', icon: '✓', placements: ['session.menu'],
    when: (context) => context.surface === 'session' && context.session.provider === 'claude-code' && !on.has(context.session.id),
    run: (context) => { set(context.session.id, true); api.toast('success', { id: 'thing', title: 'Thing', body: 'On for ' + context.session.name }); },
  });
  api.registerAction({
    id: 'disable', label: 'Disable thing', icon: '✕', placements: ['session.menu', 'terminal.header'],
    when: (context) => on.has(context.session.id),
    run: (context) => set(context.session.id, false),
  });
  api.registerAction({ id: 'broken', label: 'Broken', placements: ['session.menu'], when: () => { throw new Error('no'); }, run() {} });
  api.registerAction({ id: 'fails', label: 'Fails', placements: ['terminal.header'], when: (context) => context.session.provider === 'codex', run() { throw new Error('Could not do it.'); } });
};
`;

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const events = [];
    socket.on('message', (raw) => events.push(JSON.parse(raw)));
    socket.once('open', () => resolve({ socket, events }));
    socket.once('error', reject);
  });
}

async function waitFor(events, predicate, timeout = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const event = events.find(predicate);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for an event.');
}

const latest = (events, type, sessionId) => events.filter((event) => event.type === type && event.sessionId === sessionId).at(-1);

test('server-side plugin actions are resolved per session, pushed to every client, and run for the requester', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-server-actions-'));
  const bundledDir = mkdtempSync(join(tmpdir(), 'clideck-server-actions-bundled-'));
  mkdirSync(join(bundledDir, manifest.id));
  writeFileSync(join(bundledDir, manifest.id, 'clideck-plugin.json'), JSON.stringify(manifest));
  writeFileSync(join(bundledDir, manifest.id, 'server.js'), server);
  writeFileSync(join(dataDir, 'sessions.json'), JSON.stringify([
    { id: 'claude-one', provider: 'claude-code', name: 'Builder', cwd: dataDir },
    { id: 'codex-one', provider: 'codex', name: 'Reviewer', cwd: dataDir },
  ]));
  const engine = new HeadlessServer({ port: 0, dataDir, bundledPluginsDir: bundledDir, autoSaveMs: 0 });
  t.after(async () => {
    await engine.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(bundledDir, { recursive: true, force: true });
  });
  const { url } = await engine.listen();
  const first = await openSocket(url);
  const second = await openSocket(url);
  t.after(() => { first.socket.close(); second.socket.close(); });

  // Dormant sessions get actions too; `when` decides. A throwing `when` hides only its own action.
  const offered = await waitFor(second.events, (event) => event.type === 'plugin.actions' && event.sessionId === 'claude-one');
  assert.deepEqual(offered.actions, [{ pluginId: 'toggle-thing', id: 'enable', label: 'Enable thing', icon: '✓', description: '', placements: ['session.menu'] }]);
  const codex = await waitFor(second.events, (event) => event.type === 'plugin.actions' && event.sessionId === 'codex-one');
  assert.deepEqual(codex.actions.map((action) => [action.id, action.placements]), [['fails', ['terminal.header']]]);

  first.socket.send(JSON.stringify({ type: 'plugin.action.run', requestId: 'run-1', pluginId: 'toggle-thing', actionId: 'enable', sessionId: 'claude-one', placement: 'session.menu' }));
  const result = await waitFor(first.events, (event) => event.type === 'plugin.action.result' && event.requestId === 'run-1');
  assert.deepEqual(result, { type: 'plugin.action.result', requestId: 'run-1', pluginId: 'toggle-thing', actionId: 'enable', sessionId: 'claude-one', ok: true });
  const toast = first.events.find((event) => event.type === 'plugin.toast');
  assert.deepEqual(toast, { type: 'plugin.toast', pluginId: 'toggle-thing', kind: 'success', title: 'Thing', body: 'On for Builder', toastId: 'thing', requestId: 'run-1' });

  // Badges and the new action list reach every client; the toast and result only the one that ran it.
  const badges = await waitFor(second.events, (event) => event.type === 'session.badges' && event.sessionId === 'claude-one');
  assert.deepEqual(badges.badges, [{ pluginId: 'toggle-thing', label: 'Thing', icon: '✓', title: 'The thing is on' }]);
  await waitFor(second.events, (event) => event.type === 'plugin.actions' && event.sessionId === 'claude-one' && event.actions[0]?.id === 'disable');
  assert.deepEqual(latest(second.events, 'plugin.actions', 'claude-one').actions.map((action) => [action.id, action.placements]),
    [['disable', ['session.menu', 'terminal.header']]]);
  assert.equal(second.events.some((event) => event.type === 'plugin.toast' || event.type === 'plugin.action.result'), false);

  // Only actions the engine offered for that session and placement run; a failing run says why.
  first.socket.send(JSON.stringify({ type: 'plugin.action.run', requestId: 'run-2', pluginId: 'toggle-thing', actionId: 'enable', sessionId: 'claude-one', placement: 'session.menu' }));
  const refused = await waitFor(first.events, (event) => event.requestId === 'run-2');
  assert.equal(refused.ok, false);
  assert.match(refused.error, /not available/);
  first.socket.send(JSON.stringify({ type: 'plugin.action.run', requestId: 'run-3', pluginId: 'toggle-thing', actionId: 'fails', sessionId: 'codex-one', placement: 'terminal.header' }));
  assert.deepEqual(await waitFor(first.events, (event) => event.requestId === 'run-3'), {
    type: 'plugin.action.result', requestId: 'run-3', pluginId: 'toggle-thing', actionId: 'fails', sessionId: 'codex-one', ok: false, error: 'Could not do it.',
  });

  // A client that connects later gets the current lists in its connect burst, before transcript.cache.
  const third = await openSocket(url);
  t.after(() => third.socket.close());
  await waitFor(third.events, (event) => event.type === 'transcript.cache');
  const types = third.events.map((event) => event.type);
  const cacheAt = types.indexOf('transcript.cache');
  assert.ok(third.events.findIndex((event) => event.type === 'plugin.actions' && event.sessionId === 'claude-one') < cacheAt);
  assert.ok(types.indexOf('session.badges') >= 0 && types.indexOf('session.badges') < cacheAt);

  // Disabling the plugin clears its badges and actions with empty lists.
  first.socket.send(JSON.stringify({ type: 'plugin.setEnabled', pluginId: 'toggle-thing', enabled: false }));
  await waitFor(second.events, (event) => event.type === 'session.badges' && event.sessionId === 'claude-one' && !event.badges.length);
  await waitFor(second.events, (event) => event.type === 'plugin.actions' && event.sessionId === 'claude-one' && !event.actions.length);
  await waitFor(second.events, (event) => event.type === 'plugin.actions' && event.sessionId === 'codex-one' && !event.actions.length);
});

test('plugin.action.run control messages are bounded', () => {
  const valid = { type: 'plugin.action.run', requestId: 'r1', pluginId: 'toggle-thing', actionId: 'enable', sessionId: 'claude-one', placement: 'session.menu' };
  assert.equal(hasValidControlFields(valid), true);
  assert.equal(hasValidControlFields({ ...valid, placement: 'terminal.header' }), true);
  for (const bad of [
    { requestId: undefined }, { requestId: 'x'.repeat(101) }, { pluginId: 'Toggle' }, { actionId: '1abc' },
    { sessionId: '' }, { sessionId: 'x'.repeat(201) }, { placement: 'toolbar' }, { placement: undefined },
  ]) assert.equal(hasValidControlFields({ ...valid, ...bad }), false, JSON.stringify(bad));
});

test('an engine that starts with no sessions still offers actions for sessions added later', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-server-actions-empty-'));
  const bundledDir = mkdtempSync(join(tmpdir(), 'clideck-server-actions-empty-bundled-'));
  mkdirSync(join(bundledDir, manifest.id));
  writeFileSync(join(bundledDir, manifest.id, 'clideck-plugin.json'), JSON.stringify(manifest));
  writeFileSync(join(bundledDir, manifest.id, 'server.js'), server);
  const engine = new HeadlessServer({ port: 0, dataDir, bundledPluginsDir: bundledDir, autoSaveMs: 0 });
  t.after(async () => {
    await engine.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(bundledDir, { recursive: true, force: true });
  });
  const { url } = await engine.listen();
  const client = await openSocket(url);
  t.after(() => client.socket.close());
  await new Promise((resolve) => setTimeout(resolve, 200));   // the first pass, with nothing to evaluate

  const [entry] = engine.persistence.importMissing([{ id: 'late-one', provider: 'claude-code', name: 'Late', cwd: dataDir }]);
  engine.broadcast(engine.dormantSnapshot(entry));
  const offered = await waitFor(client.events, (event) => event.type === 'plugin.actions' && event.sessionId === 'late-one');
  assert.deepEqual(offered.actions.map((action) => action.id), ['enable']);
});
