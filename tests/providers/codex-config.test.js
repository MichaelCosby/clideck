// Codex's config.toml is user-owned and can express the same settings in several
// valid TOML shapes. CliDeck used to read it with substring/single-line regex
// matching, which caused issue #33: a valid `[otel.exporter.otlp-http]` table
// read as "not configured", and — worse — writing to such a file produced BROKEN
// TOML (an orphaned multiline `notify` array, or a duplicate otel table).
//
// These are the regressions that must never come back. Detection is asserted
// through readCodexSetup(), and every write path is asserted by re-parsing its
// output as real TOML.
//
//   node tests/providers/codex-config.test.js

const { parse } = require('smol-toml');
const {
  upsertCodexConfig,
  stripCodexConfig,
  validateCodexConfigToml,
  readCodexSetup,
} = require('../../codex-config');

const PORT = 4000;
const NODE = '/usr/bin/node';
const HELPER = '/lib/clideck/bin/notify-helper.js';

let failed = 0;
function check(name, cond, detail) {
  console.log(`  ${cond ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}`);
  if (!cond) { failed++; if (detail) console.log(`        ${detail}`); }
}
function parses(text) {
  try { parse(text); return true; } catch { return false; }
}

// The exact shape from issue #33 — valid TOML that Codex accepts.
const dottedOtel = [
  '[otel.exporter.otlp-http]',
  'endpoint = "http://localhost:4000"',
  'protocol = "json"',
].join('\n');

// The equivalent shape CliDeck itself writes.
const inlineOtel = [
  '[otel]',
  'exporter = { otlp-http = { endpoint = "http://localhost:4000", protocol = "json" } }',
].join('\n');

// A multiline notify array, wrapped through another notifier — note the nested
// brackets inside a quoted string, which naive bracket counting would misread.
const multilineNotify = [
  'notify = [',
  '  "/opt/SkyComputerUseClient",',
  '  "turn-ended",',
  '  "--previous-notify",',
  '  "[\\"/usr/bin/node\\",\\"/lib/clideck/bin/notify-helper.js\\",\\"4000\\"]",',
  ']',
].join('\n');

// --- detection: equivalent TOML shapes must all be understood ------------------
console.log('\ndetection (readCodexSetup)');
for (const [name, src] of [['dotted table', dottedOtel], ['inline table', inlineOtel]]) {
  const setup = readCodexSetup(src, PORT);
  check(`${name}: otel endpoint detected`, setup.otelOk === true);
  check(`${name}: not flagged as the wrong /v1/logs endpoint`, setup.wrongOtel === false);
}
check('notify helper found in a multiline array',
  readCodexSetup(multilineNotify, PORT).notifyHelper === '/lib/clideck/bin/notify-helper.js');
check('hooks = true under [features] detected',
  readCodexSetup('[features]\nhooks = true\n', PORT).hooksEnabled === true);
check('a different port is not accepted',
  readCodexSetup(dottedOtel, 4111).otelOk === false);
check('missing otel reports not configured',
  readCodexSetup('model = "gpt-5"\n', PORT).otelOk === false);

// --- validation: valid TOML must validate --------------------------------------
console.log('\nvalidation (validateCodexConfigToml)');
check('multiline notify array is valid', validateCodexConfigToml(multilineNotify).ok === true);
check('dotted otel table is valid', validateCodexConfigToml(dottedOtel).ok === true);
check('genuinely broken TOML is rejected', validateCodexConfigToml('notify = [\n"a",\n').ok === false);

// --- writing: output must always be parseable TOML -----------------------------
console.log('\nwriting (upsertCodexConfig)');

const fromDotted = upsertCodexConfig(dottedOtel, NODE, HELPER, PORT);
check('dotted otel: result is valid TOML (no duplicate table)', parses(fromDotted), fromDotted);
check('dotted otel: no stale [otel.exporter.otlp-http] left behind',
  !fromDotted.includes('[otel.exporter.otlp-http]'));

const fromMultiline = upsertCodexConfig(multilineNotify, NODE, HELPER, PORT);
check('multiline notify: result is valid TOML (no orphaned lines)', parses(fromMultiline), fromMultiline);
check('multiline notify: old notifier entry is gone',
  !fromMultiline.includes('SkyComputerUseClient'));

const withComments = [
  '# my codex config',
  'model = "gpt-5"',
  '',
  '[profiles.work]',
  'model = "gpt-5-codex"',
].join('\n');
const fromComments = upsertCodexConfig(withComments, NODE, HELPER, PORT);
check('user comments are preserved', fromComments.includes('# my codex config'));
check('unrelated sections are preserved', fromComments.includes('[profiles.work]'));
check('commented config: result is valid TOML', parses(fromComments), fromComments);

const configured = upsertCodexConfig(fromMultiline, NODE, HELPER, PORT);
check('upsert is idempotent (second run still valid)', parses(configured));
check('upsert result reads back as configured',
  readCodexSetup(configured, PORT).otelOk === true
  && readCodexSetup(configured, PORT).hooksEnabled === true
  && !!readCodexSetup(configured, PORT).notifyHelper);

// --- removal --------------------------------------------------------------------
console.log('\nremoval (stripCodexConfig)');
const stripped = stripCodexConfig(configured);
check('strip: result is valid TOML', parses(stripped), stripped);
check('strip: otel table removed', readCodexSetup(stripped, PORT).otelOk === false);
check('strip: notify removed', readCodexSetup(stripped, PORT).notifyHelper === null);

const strippedDotted = stripCodexConfig(dottedOtel + '\n' + multilineNotify);
check('strip: removes dotted otel + multiline notify too',
  parses(strippedDotted)
  && readCodexSetup(strippedDotted, PORT).otelOk === false
  && readCodexSetup(strippedDotted, PORT).notifyHelper === null, strippedDotted);
check('strip: keeps unrelated user settings',
  stripCodexConfig(withComments + '\n' + inlineOtel).includes('[profiles.work]'));

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall codex config checks passed');
