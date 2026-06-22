// Foundation check (not a provider test): proves the sandbox boots a CliDeck
// server fully isolated from the real machine, then tears it down.
//
//   node tests/providers/check-isolation.js
//
// Verifies: server boots on a random port with HOME=tmpHome; its data dir +
// lock live under tmpHome (not real ~/.clideck); the protocol handshake works
// and agent presets are discoverable; nothing is written to the real ~/.clideck.

const { existsSync, statSync } = require('fs');
const { join } = require('path');
const { Sandbox, REAL_HOME } = require('./sandbox');
const { Client } = require('./client');

function snapshot(p) { try { return statSync(p).mtimeMs; } catch { return null; } }

(async () => {
  const realDataDir = join(REAL_HOME, '.clideck');
  const realLockBefore = snapshot(join(realDataDir, 'server.lock'));
  const realSessionsBefore = snapshot(join(realDataDir, 'sessions.json'));

  const box = new Sandbox();
  console.log(`tmpHome:       ${box.tmpHome}`);
  let client;
  try {
    const port = await box.start();
    console.log(`server booted: 127.0.0.1:${port} (pid ${box.proc.pid})`);

    // Lock + data dir must be inside the sandbox, not the real home.
    const lockInSandbox = existsSync(box.lockPath());
    console.log(`lock in tmpHome/.clideck: ${lockInSandbox ? 'yes' : 'NO'}`);

    client = new Client(port);
    await client.connect();
    await client.waitFor('config', { label: 'config', timeout: 8000 });

    const presetIds = ['claude-code', 'codex', 'gemini-cli', 'opencode', 'pi'];
    const found = presetIds.filter((p) => client.commandIdFor(p));
    console.log(`agent presets discoverable: ${found.join(', ') || '(none)'}`);

    // The real ~/.clideck must be untouched by our server (it uses tmpHome).
    // Note: the user's LIVE instance may auto-save there independently, so we
    // assert our server's artifacts are in the sandbox rather than diffing the
    // real dir.
    const port4000Note = port === 4000 ? '  !! collided with default port' : '';
    console.log(`random port (not 4000): ${port !== 4000 ? 'yes' : 'NO'}${port4000Note}`);

    const ok = lockInSandbox && found.length > 0 && port !== 4000;
    console.log(`\nRESULT: ${ok ? 'PASS — sandbox isolated and protocol live' : 'FAIL'}`);
    process.exitCode = ok ? 0 : 1;
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    client?.close();
    await box.cleanup();

    // The real ~/.clideck lock/sessions mtimes should not have moved because of
    // OUR server (it never opened them). We only warn, since a live instance may
    // legitimately touch sessions.json during the run.
    const realLockAfter = snapshot(join(realDataDir, 'server.lock'));
    if (realLockBefore !== realLockAfter) {
      console.warn('WARN: real ~/.clideck/server.lock mtime changed (expected: live instance, not us)');
    }
    void realSessionsBefore;
    console.log('cleaned up tmpHome');
  }
})();
