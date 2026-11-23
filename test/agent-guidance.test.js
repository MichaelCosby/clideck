const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { createCodexLaunch } = require('../src/codex-launch');
const {
  AGENT_SESSION_GUIDE, DEFAULT_AGENT_GUIDANCE, createAgentSessionGuide,
} = require('../src/agent-session-guide');
const { isValidConfigPatch } = require('../src/config-store');
const { getProvider } = require('../src/providers');
const { HeadlessServer } = require('../src/server');

const plugin = [{ pluginId: 'sysmon', pluginName: 'System Monitor', name: 'stats', description: 'Show stats.', usage: 'sysmon/stats' }];

test('guidance levels: minimal prefers native messaging, full is upstream, off is empty', () => {
  const minimal = createAgentSessionGuide(plugin, { name: 'Michael' }, 'minimal');
  assert.match(minimal, /prefer your own built-in agent messaging/);
  assert.match(minimal, /clideck ask/);
  assert.match(minimal, /clideck create/);
  assert.match(minimal, /clideck show/);
  assert.match(minimal, /sysmon\/stats/, 'plugin commands are still listed');
  assert.match(minimal, /Michael/, 'the About me profile is still included');
  assert.doesNotMatch(minimal, /At the start of project work/);
  assert.equal(createAgentSessionGuide([], {}, 'full'), createAgentSessionGuide([], {}));
  assert.equal(createAgentSessionGuide([], {}), AGENT_SESSION_GUIDE);
  assert.equal(createAgentSessionGuide(plugin, { name: 'Michael' }, 'off'), '');
  assert.equal(DEFAULT_AGENT_GUIDANCE, 'minimal');
});

test('an empty guide launches Claude and Codex with no CliDeck instructions', () => {
  const claude = getProvider('claude-code').createLaunch({ command: 'claude', port: 4100, sessionId: 'guide-off', agentGuide: '' });
  const fallback = getProvider('claude-code').createLaunch({ command: 'claude', port: 4100, sessionId: 'guide-default' });
  try {
    assert.equal(claude.args.includes('--append-system-prompt'), false);
    assert.equal(fallback.args[fallback.args.indexOf('--append-system-prompt') + 1], AGENT_SESSION_GUIDE);
  } finally {
    claude.cleanup();
    fallback.cleanup();
  }
  assert.equal(createCodexLaunch({ port: 4100, agentGuide: '' }).args.some((value) => value.includes('developer_instructions=')), false);
});

test('the engine applies the configured level and defaults to minimal', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-guidance-'));
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  try {
    assert.match(server.providerLaunchOptions('claude-code').agentGuide, /prefer your own built-in agent messaging/);
    server.configStore.update({ agentGuidance: 'off' });
    assert.equal(server.providerLaunchOptions('claude-code').agentGuide, '');
    server.configStore.update({ agentGuidance: 'full' });
    assert.match(server.providerLaunchOptions('claude-code').agentGuide, /At the start of project work/);
    assert.equal(isValidConfigPatch({ agentGuidance: 'loud' }), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('plugin guide text sits before the command lines, stays within the budget and is dropped when guidance is off', () => {
  const guides = [{ pluginId: 'deck', pluginName: 'Session Status', guide: 'End every reply with the status line.' }];
  const guide = createAgentSessionGuide(plugin, { name: 'Michael' }, 'minimal', guides);
  assert.match(guide, /Plugin Session Status: End every reply with the status line\./);
  assert.ok(guide.indexOf('Plugin Session Status') < guide.indexOf('Plugin System Monitor'));
  assert.ok(guide.indexOf('About the user') < guide.indexOf('Plugin Session Status'), 'the profile still comes first');
  assert.equal(createAgentSessionGuide(plugin, {}, 'off', guides), '');
  assert.equal(createAgentSessionGuide([], {}, 'full', []), AGENT_SESSION_GUIDE);

  const huge = Array.from({ length: 12 }, (_, i) => ({ pluginName: `P${i}`, guide: 'y'.repeat(1000) }));
  assert.ok(Buffer.byteLength(createAgentSessionGuide(plugin, { name: 'Michael' }, 'full', huge)) <= 6 * 1024);
  const skipsTooLong = createAgentSessionGuide([], {}, 'full', [{ pluginName: 'Big', guide: 'z'.repeat(9000) }, { pluginName: 'Small', guide: 'fits' }]);
  assert.match(skipsTooLong, /Plugin Small: fits/);
  assert.doesNotMatch(skipsTooLong, /Plugin Big/);
});
