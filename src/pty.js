const { chmodSync, statSync } = require('fs');
const { dirname, join } = require('path');
const pty = require('node-pty');

let helperChecked = false;

// Claude Code state CliDeck inherits when it is started from inside a Claude session; passed on, it would make
// every agent CliDeck launches think it is nested in that session. Only the inherited environment is filtered:
// variables set on purpose in CliDeck (a custom command's environment) reach the agent as given.
function sanitizeProviderEnv(env) {
  return Object.fromEntries(Object.entries(env || {}).filter(([key]) => {
    const name = key.toUpperCase();
    return name !== 'CLAUDECODE'
      && name !== 'CLAUDE_EFFORT'
      && !name.startsWith('CLAUDE_CODE_');
  }));
}

function ensureHelperExecutable() {
  if (helperChecked || process.platform !== 'darwin') return;   // node-pty ships spawn-helper for macOS only
  helperChecked = true;
  const packageDirectory = dirname(require.resolve('node-pty/package.json'));
  const helper = join(
    packageDirectory,
    'prebuilds',
    `${process.platform}-${process.arch}`,
    'spawn-helper',
  );
  const mode = statSync(helper).mode & 0o777;
  if ((mode & 0o111) === 0) chmodSync(helper, mode | 0o111);
}

function spawn(file, args, options) {
  ensureHelperExecutable();
  return pty.spawn(file, args, options);
}

module.exports = { sanitizeProviderEnv, spawn };
