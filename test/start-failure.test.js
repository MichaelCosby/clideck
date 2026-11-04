const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { HeadlessServer } = require('../src/server');
const { describeStartFailure, lastLines } = require('../src/start-failure');

test('the reason names a missing folder, a file given as the folder, then a missing command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clideck-start-reason-'));
  try {
    writeFileSync(join(dir, 'file'), '');
    assert.equal(describeStartFailure({ cwd: join(dir, 'gone'), output: 'chdir(2) failed.: No such file or directory\r\n', exitCode: 1 }),
      `The folder ${join(dir, 'gone')} doesn't exist.`);
    assert.equal(describeStartFailure({ cwd: join(dir, 'file'), exitCode: 1 }), `${join(dir, 'file')} is not a folder.`);
    assert.equal(describeStartFailure({ cwd: dir, command: 'claude-9', output: 'execvp(3) failed.: No such file or directory\r\n', exitCode: 1 }),
      'The command "claude-9" wasn\'t found.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('otherwise the reason gives the exit code or signal and the last lines it printed', () => {
  assert.equal(describeStartFailure({ cwd: tmpdir(), output: 'starting\r\n\x1b[31mError: no API key\x1b[0m\r\n', exitCode: 2 }),
    'It stopped right after starting (exit code 2). Last output: starting / Error: no API key');
  assert.equal(describeStartFailure({ cwd: tmpdir(), output: '', exitCode: 0, signal: 9 }), 'It stopped right after starting (signal 9).');
  assert.equal(describeStartFailure({ cwd: tmpdir(), output: '', exitCode: 0 }), 'It stopped right after starting.');
  assert.equal(lastLines('a\nb\nc\nd\n'), 'b / c / d');
  assert.ok(lastLines('x'.repeat(500)).length <= 301);
});

async function waitFor(check, what) {
  for (let i = 0; i < 300; i++) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('an agent that exits as it starts is reported, with the reason kept in its terminal', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-start-failure-'));
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  const events = [];
  server.broadcast = (event) => events.push(event);
  try {
    await server.listen();
    server.configStore.update({ commands: [{
      id: 'boom', label: 'Boom', icon: 'terminal', command: `sh -c "echo no API key; exit 3"`,
      enabled: true, isAgent: true, canResume: false, env: {}, resumeCommand: null, sessionIdPattern: null,
    }] });

    const missing = server.createSession({ provider: 'shell', cwd: join(dataDir, 'nowhere'), name: 'Missing' });
    const boom = server.createSession({ commandId: 'boom', cwd: dataDir, name: 'Boom' });
    const failures = await waitFor(() => {
      const found = events.filter((event) => event.error?.code === 'start_failed');
      return found.length === 2 && found;
    }, 'two start failures');
    const byName = Object.fromEntries(failures.map((event) => [event.name, event.error]));
    assert.equal(byName.Missing.operation, 'session.start');
    assert.equal(byName.Missing.message, `The folder ${join(dataDir, 'nowhere')} doesn't exist.`);
    assert.match(byName.Boom.message, /^It stopped right after starting \(exit code 3\)\. Last output: .*no API key/);
    assert.equal(failures.every((event) => event.live === false), true, 'the session is shown as not running');
    assert.match(server.persistence.historyTail(missing.id), /CliDeck: this session didn't start\. The folder .* doesn't exist\./);
    assert.ok(boom.closed);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('an agent the user ends, or that runs and is closed, is not a failed start', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-start-ok-'));
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  const events = [];
  server.broadcast = (event) => events.push(event);
  try {
    await server.listen();
    const typed = server.createSession({ provider: 'shell', cwd: dataDir, name: 'Typed' });
    typed.writeInput('exit 4\r');
    await waitFor(() => typed.closed, 'the shell to exit');
    const closed = server.createSession({ provider: 'shell', cwd: dataDir, name: 'Closed' });
    await closed.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(events.filter((event) => event.error?.code === 'start_failed'), []);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
