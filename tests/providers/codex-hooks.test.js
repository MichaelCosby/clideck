// Codex status tracking lives in two files: settings in config.toml and the
// hooks themselves in hooks.json. Turning tracking off has to clear BOTH, and it
// has to leave hooks that belong to other tools alone.
//
// The failure this guards against: hooks.json was only touched when config.toml
// existed, so a Codex home with hooks but no config kept firing CliDeck hooks
// after the UI reported tracking disabled.
//
//   node tests/providers/codex-hooks.test.js

const os = require('os');
const fs = require('fs');
const path = require('path');
const { installCodexHooks, removeCodexHooks, codexHooksRemain, codexHooksHealthy } = require('../../codex-hooks');

let failed = 0;
function check(name, cond, detail) {
  console.log(`  ${cond ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}`);
  if (!cond) { failed++; if (detail) console.log(`        ${detail}`); }
}

const NODE = '/usr/bin/node';
const HOOK = '/lib/clideck/bin/codex-hook.js';
const PORT = 4000;

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
}
function readHooks(home) {
  const file = path.join(home, 'hooks.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

console.log('\nhooks.json lifecycle');

// Installed hooks are removed even when the home has no config.toml at all.
const bare = tmpHome();
installCodexHooks(bare, NODE, HOOK, PORT);
check('install writes hooks.json', !!readHooks(bare));
check('installed hooks read as healthy', codexHooksHealthy(bare, HOOK, PORT) === true);
check('no config.toml is needed for hooks to exist', !fs.existsSync(path.join(bare, 'config.toml')));
removeCodexHooks(bare);
check('removal clears CliDeck hooks with no config.toml present',
  codexHooksHealthy(bare, HOOK, PORT) === false, JSON.stringify(readHooks(bare)));
check('nothing of ours is left behind', codexHooksRemain(bare) === false, JSON.stringify(readHooks(bare)));

// A third-party hook must survive, and must keep the features switch on.
const shared = tmpHome();
fs.writeFileSync(path.join(shared, 'hooks.json'), JSON.stringify({
  hooks: { Stop: [{ hooks: [{ command: '/opt/other-tool.js' }] }] },
}, null, 2));
installCodexHooks(shared, NODE, HOOK, PORT);
removeCodexHooks(shared);
const sharedDoc = readHooks(shared);
check('a third-party hook survives removal',
  JSON.stringify(sharedDoc).includes('other-tool.js'), JSON.stringify(sharedDoc));
check('CliDeck hooks are gone from the shared file',
  !JSON.stringify(sharedDoc).includes('codex-hook.js'), JSON.stringify(sharedDoc));
check('remaining third-party hooks keep the features switch on',
  codexHooksRemain(shared) === true, JSON.stringify(sharedDoc));

// Nothing installed at all is not an error.
const empty = tmpHome();
removeCodexHooks(empty);
check('removing from an untouched home is a no-op', codexHooksRemain(empty) === false);

for (const dir of [bare, shared, empty]) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall codex hooks checks passed');
