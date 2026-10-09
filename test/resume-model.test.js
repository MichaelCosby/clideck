const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { getProvider } = require('../src/providers');
const { createCustomCommandProvider } = require('../src/custom-command');
const { AgentSession } = require('../src/session');
const { SessionPersistence } = require('../src/persistence');
const { HeadlessServer } = require('../src/server');

const launchArgs = (provider, options) => {
  const launch = provider.createLaunch({ port: 1, sessionId: 's1', serverUrl: 'http://127.0.0.1:1', ...options });
  launch.cleanup?.();
  return launch.args;
};

test('Claude gets --model only when resuming, after any --model of a custom command', () => {
  const claude = getProvider('claude-code');
  assert.equal(launchArgs(claude, { model: 'claude-haiku-5-5' }).includes('--model'), false, 'a new session uses the account default');
  assert.deepEqual(launchArgs(claude, { resumeHandle: 'abc', model: 'claude-haiku-5-5' }).slice(-4), ['--resume', 'abc', '--model', 'claude-haiku-5-5']);
  assert.equal(launchArgs(claude, { resumeHandle: 'abc' }).includes('--model'), false);
  const wrapper = createCustomCommandProvider({ id: 'c2', label: 'C2', icon: 'terminal', command: '/home/me/bin/claude-2 --model sonnet',
    enabled: true, isAgent: true, canResume: true, env: {}, resumeCommand: null, sessionIdPattern: null, providerId: 'claude-code' });
  const args = launchArgs(wrapper, { resumeHandle: 'abc', model: 'claude-opus-5-5' });
  assert.deepEqual(args.slice(0, 2), ['--model', 'sonnet']);
  assert.deepEqual(args.slice(-2), ['--model', 'claude-opus-5-5'], 'the saved model comes last, so a wrapper can let it win');
});

test('a session records the exact model id Claude reports, and only well-formed ones', () => {
  const session = new AgentSession({ provider: getProvider('claude-code'), port: 1 });
  session.terminal = { write() {} };
  const events = [];
  session.on('event', (event) => events.push(event));
  try {
    session.handleHook('session-start', { source: 'startup' });
    session.writeInput('hi\r');
    session.handleHook('start', {});
    session.handleHook('context', { model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' } });
    assert.equal(session.modelId, 'claude-opus-5-5');
    session.handleHook('context', { model: { id: 'claude-haiku-5-5', display_name: 'Haiku 5.5' } });
    assert.equal(session.modelId, 'claude-haiku-5-5');
    assert.ok(events.some((e) => e.type === 'status' && e.model === 'Haiku 5.5'));
    session.handleHook('context', { model: { id: 'bad id; rm -rf', display_name: 'x' } });
    assert.equal(session.modelId, 'claude-haiku-5-5');
  } finally {
    session.handleExit(0, null);
  }
  const resumed = new AgentSession({ provider: getProvider('claude-code'), port: 1, providerOptions: { resumeHandle: 'abc', model: 'claude-haiku-5-5' } });
  assert.equal(resumed.modelId, 'claude-haiku-5-5', 'a resumed session starts out knowing its model');
});

test('the model is saved with the session, survives a reload, and is asked for on resume', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-model-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const persistence = new SessionPersistence({ dataDir, debounceMs: 0 });
  persistence.register({ id: 's1', provider: { id: 'claude-code' }, name: 'One', cwd: '/', cols: 80, rows: 24 });
  persistence.recordResumeMetadata('s1', { handle: 'conv-1' });
  persistence.recordModel('s1', 'claude-haiku-5-5');
  persistence.close();
  const reloaded = new SessionPersistence({ dataDir, debounceMs: 0 });
  const entry = reloaded.get('s1');
  reloaded.close();
  assert.equal(entry.modelId, 'claude-haiku-5-5');

  const server = Object.create(HeadlessServer.prototype);
  server.providerLaunchOptions = () => ({});
  assert.deepEqual(server.resumeLaunch(getProvider('claude-code'), entry).providerOptions, { resumeHandle: 'conv-1', model: 'claude-haiku-5-5' });
  assert.equal(server.resumeLaunch(getProvider('codex'), entry).providerOptions.model, undefined, 'Claude only');
  assert.equal(server.resumeLaunch(getProvider('claude-code'), { ...entry, resumeHandle: undefined }).providerOptions.model, undefined, 'only when resuming');
});
