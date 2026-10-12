const { existsSync } = require('fs');
const os = require('os');

// The user's shell: $SHELL, else their login shell from the user database (a process manager such as s6 or
// launchd often starts CliDeck without $SHELL), else zsh or sh.
function defaultShell(env = process.env, userInfo = os.userInfo, exists = existsSync) {
  if (env.SHELL) return env.SHELL;
  try {
    const shell = userInfo().shell;
    if (shell && exists(shell)) return shell;
  } catch {}
  return exists('/bin/zsh') ? '/bin/zsh' : 'sh';
}

const shellProvider = {
  id: 'shell',
  command: defaultShell(),
  closeInput: 'exit\r',
  supportsAsk: false,
  statusFromActivity: true,
  activityIdleMs: 1500,
  streamsAgentTextFromScreen: false,
  createLaunch({ command }) {
    return { command: command || this.command, args: [] };
  },
};

module.exports = { defaultShell, shellProvider };
