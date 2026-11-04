const test = require('node:test');
const assert = require('node:assert/strict');
const { sessionEnvironment } = require('../src/session');

test('the session environment drops Claude nesting state inherited by CliDeck', () => {
  const blocked = {
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_EXECPATH: '/bin/claude',
    CLAUDE_CODE_SESSION_ID: 'parent-session',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    CLAUDE_EFFORT: 'high',
  };
  const previous = Object.fromEntries(
    [...Object.keys(blocked), 'CLIDECK_PTY_TEST_KEEP'].map((key) => [key, process.env[key]]),
  );

  try {
    Object.assign(process.env, blocked, { CLIDECK_PTY_TEST_KEEP: 'kept' });
    const env = sessionEnvironment({}, 'session-one', 4000);

    assert.equal(env.CLIDECK_PTY_TEST_KEEP, 'kept');
    for (const key of Object.keys(blocked)) {
      assert.equal(Object.hasOwn(env, key), false);
      assert.equal(process.env[key], blocked[key]);
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Claude variables set on purpose in CliDeck reach the agent, even with the same names leaking in', () => {
  const previous = { CLAUDECODE: process.env.CLAUDECODE, CLAUDE_CODE_USE_VERTEX: process.env.CLAUDE_CODE_USE_VERTEX };
  try {
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_USE_VERTEX = 'inherited';
    const env = sessionEnvironment({ CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_EFFORT: 'high' }, 'session-one', 4000);
    assert.equal(env.CLAUDE_CODE_USE_VERTEX, '1');
    assert.equal(env.CLAUDE_EFFORT, 'high');
    assert.equal(Object.hasOwn(env, 'CLAUDECODE'), false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
