// Answering a detected menu flips a session back to "working" until its push
// status reports idle again. Antigravity has NO push status (no hooks, OTEL, or
// bridge), so if it were flipped to working it would stick there forever. This
// covers both halves of that path:
//   1. the pure decision `menuStartsWork()` — the handler's choice
//   2. the real `sessions.input()` broadcast — where the working:true would fire
// so the regression (agy stuck working after a menu) cannot come back unnoticed.
//
//   node tests/providers/menu-status.test.js

const os = require('os');
const fs = require('fs');
const path = require('path');

// Isolate HOME before requiring server modules (paths.js resolves DATA_DIR, and
// plugin-loader seeds into ~/.clideck, both at require time).
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clideck-menu-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

let failed = 0;
function check(name, cond) {
  console.log(`  ${cond ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}`);
  if (!cond) failed++;
}

// --- Part 1: the pure decision -------------------------------------------------
const { menuStartsWork } = require('../../preset-utils');

check('antigravity never starts work on menu answer (no version)', menuStartsWork('antigravity', false, true) === false);
check('antigravity never starts work on menu answer (with version)', menuStartsWork('antigravity', true, true) === false);
check('claude-code with a menu version still starts work', menuStartsWork('claude-code', true, false) === true);
check('claude-code without a menu version does not (unchanged)', menuStartsWork('claude-code', false, false) === false);
check('codex still starts work on menu answer (unchanged)', menuStartsWork('codex', false, false) === true);

// --- Part 2: the real broadcast path through sessions.input() ------------------
const sessions = require('../../sessions');

// Drive input() against an injected session and collect status broadcasts.
function answerMenu(presetId, finalizeOnCapture) {
  const id = `menu-${presetId}`;
  const statuses = [];
  const off = sessions.addBroadcastListener(m => { if (m.type === 'session.status') statuses.push(m); });
  sessions.getSessions().set(id, {
    presetId,
    working: false,
    pty: { write() {} },
    _menuKey: JSON.stringify([{ label: 'Yes', value: '1' }]),
    // set exactly as the handler would, via the shared predicate
    _menuStartsWork: menuStartsWork(presetId, true, finalizeOnCapture),
    _finalizeOnCapture: !!finalizeOnCapture,
  });
  sessions.input({ id, data: '\r' }); // press Enter on the menu
  const stillWorking = sessions.getSessions().get(id)?.working;
  off();
  sessions.getSessions().delete(id);
  return { workingBroadcast: statuses.some(s => s.working === true), stillWorking };
}

const agy = answerMenu('antigravity', true);
check('agy: answering a menu emits NO working:true broadcast', agy.workingBroadcast === false);
check('agy: session is not left in the working state', agy.stillWorking === false);

const claude = answerMenu('claude-code', false);
check('claude-code: answering a menu still emits working:true (scope intact)', claude.workingBroadcast === true);

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall menu-status checks passed');
