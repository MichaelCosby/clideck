// CliDeck gives Claude Code its own status line so it can read context usage, and a --settings status line wins
// over the user's. To keep the user's own status line on screen, the hook runs it afterwards with the same
// input and prints what it prints.
const { readFileSync } = require('fs');
const { homedir } = require('os');
const { join } = require('path');
const { spawn } = require('child_process');

const USER_STATUS_TIMEOUT_MS = 5000;

function statusCommand(path) {
  try {
    const command = JSON.parse(readFileSync(path, 'utf8'))?.statusLine?.command;
    // Never chain to CliDeck's own hook (a settings file that already holds it would loop).
    return typeof command === 'string' && command.trim() && !command.includes('claude-hook.js') ? command : '';
  } catch {
    return '';
  }
}

// The status line Claude Code would have used without CliDeck: local project settings, then project settings,
// then the account's settings (CLAUDE_CONFIG_DIR, as a wrapper script for a second account sets it, or ~/.claude).
function findUserStatusLine(cwd = process.cwd(), env = process.env) {
  const configDir = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude');
  for (const path of [join(cwd, '.claude', 'settings.local.json'), join(cwd, '.claude', 'settings.json'), join(configDir, 'settings.json')]) {
    const command = statusCommand(path);
    if (command) return command;
  }
  return '';
}

// Runs the user's status line through the shell (as Claude Code does, so ~ and pipes work) and resolves with
// its output, or '' if it fails or takes too long.
function runUserStatusLine(command, input, { cwd = process.cwd(), env = process.env, timeoutMs = USER_STATUS_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    let child;
    const posix = process.platform !== 'win32';
    try {
      // Its own process group, so a timeout can end everything the shell started; anything left holding the
      // output pipe would keep this hook (and Claude's status line) waiting until it finished.
      child = spawn(command, { shell: true, cwd, env, stdio: ['pipe', 'pipe', 'ignore'], detached: posix });
    } catch {
      resolve('');
      return;
    }
    const killTree = () => {
      try { if (posix) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
      child.stdout.destroy();
    };
    const timer = setTimeout(() => { killTree(); finish(''); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', () => finish(''));
    child.on('close', () => finish(out));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

module.exports = { findUserStatusLine, runUserStatusLine };
