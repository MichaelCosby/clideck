const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { spawn } = require('child_process');
const { findUserStatusLine } = require('../src/claude-statusline');

const HOOK = join(__dirname, '..', 'src', 'claude-hook.js');

function settings(dir, statusCommand) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: statusCommand } }));
}

// Runs the real hook as Claude Code would, against a fake engine; resolves with what it printed and what the
// engine received.
async function runHook(route, input, { cwd, env }) {
  const posts = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { posts.push({ url: req.url, body }); res.end('{}'); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const child = spawn(process.execPath, [HOOK, String(port), 'session-1', route], { cwd, env: { ...process.env, ...env } });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stdin.end(input);
    await new Promise((resolve) => child.on('close', resolve));
    for (let i = 0; i < 50 && !posts.length; i++) await new Promise((r) => setTimeout(r, 10));
    return { out, posts };
  } finally {
    server.close();
  }
}

test('the context status line reports to CliDeck and shows the user status line of the account in use', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'clideck-statusline-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const account = join(root, 'claude2');
  settings(account, `node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write('[C2] '+JSON.parse(s).model.display_name))"`);
  const project = join(root, 'project');
  mkdirSync(project);
  const input = JSON.stringify({ model: { display_name: 'Opus' }, context_window: { used_percentage: 12 } });

  const { out, posts } = await runHook('context', input, { cwd: project, env: { CLAUDE_CONFIG_DIR: account } });
  assert.equal(out, '[C2] Opus');
  assert.deepEqual(posts, [{ url: '/hooks/session-1/context', body: input }]);

  settings(join(project, '.claude'), 'echo project-line');   // a project's own status line wins, as in Claude Code
  assert.equal((await runHook('context', input, { cwd: project, env: { CLAUDE_CONFIG_DIR: account } })).out, 'project-line\n');
});

test('no user status line, a failing one, or CliDeck\'s own leaves the line empty; other routes print nothing', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'clideck-statusline-none-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { CLAUDE_CONFIG_DIR: join(root, 'account'), HOME: root };
  assert.equal((await runHook('context', '{}', { cwd: root, env })).out, '');
  settings(env.CLAUDE_CONFIG_DIR, 'exit 3');
  assert.equal((await runHook('context', '{}', { cwd: root, env })).out, '');
  settings(env.CLAUDE_CONFIG_DIR, `"node" "${HOOK}" 1 x context`);
  assert.equal(findUserStatusLine(root, env), '', 'never chains to itself');
  settings(env.CLAUDE_CONFIG_DIR, 'echo should-not-run');
  const { out, posts } = await runHook('start', '{"prompt":"hi"}', { cwd: root, env });
  assert.equal(out, '');
  assert.equal(posts[0].url, '/hooks/session-1/start');
});

test('a status line that runs too long is ended with everything it started, so the hook can exit', async () => {
  const marker = `sleep 7.${process.pid % 1000}`;   // unique, to find leftovers
  const script = `require(${JSON.stringify(join(__dirname, '..', 'src', 'claude-statusline.js'))}).runUserStatusLine(${JSON.stringify(`${marker}; echo late`)}, '{}', { timeoutMs: 100 }).then((out) => process.stdout.write(JSON.stringify(out)))`;
  const started = Date.now();
  const child = spawn(process.execPath, ['-e', script]);
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  await new Promise((resolve) => child.on('close', resolve));
  assert.equal(out, '""');
  assert.ok(Date.now() - started < 3000, `the hook process exited after ${Date.now() - started} ms`);
  const { execFileSync } = require('child_process');
  let left = '';
  try { left = execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' }); } catch {}
  assert.equal(left.trim(), '', 'no process from the status line is left running');
});
