// Codex's config.toml belongs to the user, and CliDeck only manages three
// settings inside it. Issue #33 started as a detection bug (a valid
// [otel.exporter.otlp-http] table read as "Failed - configure manually"), but
// the same text-matching assumptions also made the writer destructive.
//
// The rules asserted here, in order of severity:
//   1. writing must never produce invalid TOML (a broken config.toml stops Codex)
//   2. writing must never delete or rewrite anything CliDeck did not put there -
//      other otel keys, per-profile settings, comments, or the user's own notifier
//   3. detection must understand any valid TOML shape of our settings
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
  if (!cond) { failed++; if (detail) console.log(`        ${String(detail).replace(/\n/g, '\n        ')}`); }
}
function parses(text) {
  try { parse(text); return true; } catch { return false; }
}
const upsert = (src) => upsertCodexConfig(src, NODE, HELPER, PORT);

// The shape from issue #33 — valid TOML that Codex accepts.
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

// A multiline notify chained through another notifier — note the nested brackets
// inside a quoted string, which naive bracket counting would misread.
const chainedNotify = [
  'notify = [',
  '  "/opt/SkyComputerUseClient",',
  '  "turn-ended",',
  '  "--previous-notify",',
  '  "[\\"/usr/bin/node\\",\\"/lib/clideck/bin/notify-helper.js\\",\\"4000\\"]",',
  ']',
].join('\n');

// --- 1. detection ---------------------------------------------------------------
console.log('\ndetection (readCodexSetup)');
for (const [name, src] of [['dotted table', dottedOtel], ['inline table', inlineOtel]]) {
  const setup = readCodexSetup(src, PORT);
  check(`${name}: otel endpoint detected`, setup.otelOk === true);
  check(`${name}: not flagged as the wrong /v1/logs endpoint`, setup.wrongOtel === false);
}
check('helper found even when chained inside another notifier',
  readCodexSetup(chainedNotify, PORT).notifyHelper === '/lib/clideck/bin/notify-helper.js');
check('hooks = true under [features] detected',
  readCodexSetup('[features]\nhooks = true\n', PORT).hooksEnabled === true);
check('a different port is not accepted', readCodexSetup(dottedOtel, 4111).otelOk === false);
check('the legacy /v1/logs endpoint is flagged',
  readCodexSetup('[otel.exporter.otlp-http]\nendpoint = "http://localhost:4000/v1/logs"', PORT).wrongOtel === true);

// A string that merely mentions a header must not confuse parsing or writing.
const stringWithHeader = 'instructions = "mention [otel] literally"\n';
check('a string containing [otel] still parses', readCodexSetup(stringWithHeader, PORT).valid === true);

// --- 2. validation --------------------------------------------------------------
console.log('\nvalidation (validateCodexConfigToml)');
check('multiline notify array is valid', validateCodexConfigToml(chainedNotify).ok === true);
check('dotted otel table is valid', validateCodexConfigToml(dottedOtel).ok === true);
check('a string containing [otel] is valid', validateCodexConfigToml(stringWithHeader).ok === true);
check('genuinely broken TOML is rejected', validateCodexConfigToml('notify = [\n"a",\n').ok === false);

// --- 3. writing produces valid TOML ---------------------------------------------
console.log('\nwriting produces valid TOML (upsertCodexConfig)');
const fromDotted = upsert(dottedOtel);
check('dotted otel: valid TOML (no duplicate table)', parses(fromDotted.content), fromDotted.content);
const fromString = upsert(stringWithHeader);
check('string containing [otel]: valid TOML (not split mid-string)', parses(fromString.content), fromString.content);
check('string containing [otel]: text preserved verbatim',
  fromString.content.includes('instructions = "mention [otel] literally"'), fromString.content);
const fromEmpty = upsert('');
check('empty config: valid TOML', parses(fromEmpty.content), fromEmpty.content);
check('empty config: reads back as configured',
  readCodexSetup(fromEmpty.content, PORT).otelOk && readCodexSetup(fromEmpty.content, PORT).hooksEnabled);

// --- 4. writing preserves what CliDeck does not own ------------------------------
console.log('\nwriting preserves user content');

const otelExtras = [
  '[otel]',
  'environment = "prod"',
  'log_user_prompt = false',
  '',
  '[otel.exporter.otlp-http]',
  'endpoint = "http://localhost:9999"',
].join('\n');
const fromExtras = upsert(otelExtras);
check('other otel keys survive', fromExtras.content.includes('environment = "prod"')
  && fromExtras.content.includes('log_user_prompt = false'), fromExtras.content);
check('user-owned otel is left byte-for-byte alone', fromExtras.content.includes(otelExtras), fromExtras.content);
check('user-owned otel is reported as a manual step', fromExtras.manual.includes('otel'));
check('otel extras: valid TOML', parses(fromExtras.content), fromExtras.content);

// When otel holds nothing but our canonical keys, a stale port IS corrected.
const staleOwn = ['[otel.exporter.otlp-http]', 'endpoint = "http://localhost:9999"', 'protocol = "json"'].join('\n');
const fromStale = upsert(staleOwn);
check('our own stale endpoint is corrected', readCodexSetup(fromStale.content, PORT).otelOk === true
  && !fromStale.content.includes('9999'), fromStale.content);
check('correcting our own otel needs no manual step', !fromStale.manual.includes('otel'));
check('corrected otel: valid TOML', parses(fromStale.content), fromStale.content);

const profileNotify = [
  '[profiles.work]',
  'model = "gpt-5-codex"',
  'notify = ["/my/own/notifier"]',
].join('\n');
const fromProfile = upsert(profileNotify);
check('per-profile notify is NOT deleted', fromProfile.content.includes('/my/own/notifier'), fromProfile.content);
check('per-profile section survives', fromProfile.content.includes('[profiles.work]'));
check('profile config: valid TOML', parses(fromProfile.content), fromProfile.content);

const withComments = ['# my codex config', 'model = "gpt-5"'].join('\n');
const fromComments = upsert(withComments);
check('user comments are preserved', fromComments.content.includes('# my codex config'));
check('unrelated top-level keys are preserved', fromComments.content.includes('model = "gpt-5"'));

// The user's own notifier chain is theirs — report, never overwrite.
const foreignNotify = 'notify = ["/opt/my-notifier", "turn-ended"]\n';
const fromForeign = upsert(foreignNotify);
check('a foreign notify chain is NOT overwritten', fromForeign.content.includes('/opt/my-notifier'), fromForeign.content);
check('a foreign notify chain is reported as manual', fromForeign.manual.includes('notify'));
check('foreign notify: valid TOML', parses(fromForeign.content), fromForeign.content);

// An already-chained CliDeck helper needs no edit at all.
const fromChained = upsert(chainedNotify);
check('an existing CliDeck chain is left intact',
  fromChained.content.includes('SkyComputerUseClient') && !fromChained.manual.includes('notify'), fromChained.content);
check('chained notify: valid TOML', parses(fromChained.content), fromChained.content);

// --- 4b. values that span lines are not mistaken for structure -------------------
console.log('\nmultiline values are never treated as structure');

const multilineString = [
  'developer_instructions = """',
  'Some guidance.',
  '[features]',
  'notify = do the thing',
  '"""',
].join('\n');
const fromMultilineString = upsert(multilineString);
check('multiline string: valid TOML', parses(fromMultilineString.content), fromMultilineString.content);
check('multiline string: contents left byte-for-byte alone',
  fromMultilineString.content.includes(multilineString), fromMultilineString.content);
check('multiline string: settings written outside it, and effective',
  readCodexSetup(fromMultilineString.content, PORT).otelOk === true
  && readCodexSetup(fromMultilineString.content, PORT).hooksEnabled === true, fromMultilineString.content);

// A basic multiline string honours \ escapes, so an escaped quote is content and
// must not be read as the closing delimiter.
const escapedQuotes = [
  'developer_instructions = """',
  'Say \\""" to quote it.',
  'More guidance.',
  '"""',
].join('\n');
const fromEscaped = upsert(escapedQuotes);
check('escaped quotes: string preserved verbatim',
  fromEscaped.content.includes(escapedQuotes), fromEscaped.content);
check('escaped quotes: notify stays a top-level key, not swallowed by a table',
  parse(fromEscaped.content).notify !== undefined, fromEscaped.content);
check('escaped quotes: reads back as configured',
  readCodexSetup(fromEscaped.content, PORT).otelOk === true
  && readCodexSetup(fromEscaped.content, PORT).hooksEnabled === true, fromEscaped.content);

const literalBlock = ["raw = '''", '[otel]', "'''"].join('\n');
const fromLiteral = upsert(literalBlock);
check("literal ''' block is left alone", fromLiteral.content.includes(literalBlock), fromLiteral.content);
check('literal block: valid TOML', parses(fromLiteral.content), fromLiteral.content);

// --- 4c. sibling exporter settings ------------------------------------------------
console.log('\ninline exporter siblings');
const inlineSiblings = [
  '[otel]',
  'exporter = { otlp-http = { endpoint = "http://localhost:9999", protocol = "binary", headers = { auth = "x" } } }',
].join('\n');
const fromSiblings = upsert(inlineSiblings);
check('sibling headers survive untouched',
  fromSiblings.content.includes('headers') && fromSiblings.content.includes('auth = "x"'), fromSiblings.content);
check('an exporter with siblings is left alone, not rewritten',
  fromSiblings.content.includes(inlineSiblings) && fromSiblings.manual.includes('otel'), fromSiblings.content);
check('inline siblings: valid TOML', parses(fromSiblings.content), fromSiblings.content);

// A second exporter must never have its endpoint or protocol taken over.
const grpcSibling = [
  '[otel]',
  'exporter = { otlp-http = { protocol = "json" }, otlp-grpc = { endpoint = "http://grpc.internal:4317" } }',
].join('\n');
const fromGrpc = upsert(grpcSibling);
check('a sibling exporter keeps its own endpoint',
  fromGrpc.content.includes('http://grpc.internal:4317'), fromGrpc.content);
check('a sibling exporter is reported, not rewritten', fromGrpc.manual.includes('otel'));
check('sibling exporter: valid TOML', parses(fromGrpc.content), fromGrpc.content);

// --- 4e. headers with comments or quoted keys -------------------------------------
console.log('\nheader spellings');
const commentedHeader = [
  '[otel] # telemetry',
  'exporter = { otlp-http = { endpoint = "http://localhost:9999", protocol = "json" } }',
].join('\n');
const fromCommented = upsert(commentedHeader);
check('header with a trailing comment: valid TOML (no duplicate table)',
  parses(fromCommented.content), fromCommented.content);
check('header with a trailing comment: reads back as configured',
  readCodexSetup(fromCommented.content, PORT).otelOk === true, fromCommented.content);
check('header with a trailing comment: no stale otel table left behind',
  (fromCommented.content.match(/\[otel/g) || []).length === 1, fromCommented.content);

// A comment on the canonical table survives, because that table is edited in place.
const commentedCanonical = ['[otel.exporter.otlp-http] # telemetry', 'endpoint = "http://localhost:9999"', 'protocol = "json"'].join('\n');
const fromCommentedCanonical = upsert(commentedCanonical);
check('comment on our own table is preserved',
  fromCommentedCanonical.content.includes('# telemetry'), fromCommentedCanonical.content);
check('comment on our own table: endpoint still corrected',
  readCodexSetup(fromCommentedCanonical.content, PORT).otelOk === true, fromCommentedCanonical.content);

const quotedHeader = ['[otel.exporter."otlp-http"]', 'endpoint = "http://localhost:9999"', 'protocol = "json"'].join('\n');
const fromQuoted = upsert(quotedHeader);
check('quoted key header: valid TOML (no duplicate table)', parses(fromQuoted.content), fromQuoted.content);
check('quoted key header: reads back as configured',
  readCodexSetup(fromQuoted.content, PORT).otelOk === true, fromQuoted.content);

// --- 4d. protocol and repair gating -----------------------------------------------
console.log('\nhealth gating');
check('protocol = "binary" is NOT accepted (receiver only decodes JSON)',
  readCodexSetup('[otel.exporter.otlp-http]\nendpoint = "http://localhost:4000"\nprotocol = "binary"\n', PORT).otelOk === false);
check('protocol = "json" is accepted', readCodexSetup(dottedOtel, PORT).otelOk === true);

const glued = 'model = "gpt-5"[features]\nhooks = true\n';
check('a file that only parses after repair is flagged needsRepair',
  readCodexSetup(glued, PORT).needsRepair === true);
check('a healthy file is not flagged needsRepair', readCodexSetup(dottedOtel, PORT).needsRepair === false);
check('configuring a repairable file writes the repair',
  parses(upsert(glued).content) && !upsert(glued).content.includes('"gpt-5"[features]'), upsert(glued).content);

// --- 5. idempotence + removal ----------------------------------------------------
console.log('\nidempotence and removal');
const once = upsert(withComments).content;
const twice = upsert(once).content;
check('upsert is idempotent', once === twice, `first:\n${once}\nsecond:\n${twice}`);
check('configured result reads back as configured',
  readCodexSetup(once, PORT).otelOk && readCodexSetup(once, PORT).hooksEnabled && !!readCodexSetup(once, PORT).notifyHelper);

const stripped = stripCodexConfig(once).content;
check('strip: valid TOML', parses(stripped), stripped);
check('strip: our settings are gone',
  readCodexSetup(stripped, PORT).otelOk === false && readCodexSetup(stripped, PORT).notifyHelper === null, stripped);
check('strip: user content survives',
  stripped.includes('# my codex config') && stripped.includes('model = "gpt-5"'), stripped);

const strippedExtras = stripCodexConfig(upsert(otelExtras).content).content;
check('strip: other otel keys survive',
  strippedExtras.includes('environment = "prod"') && strippedExtras.includes('log_user_prompt = false'), strippedExtras);
const strippedProfile = stripCodexConfig(upsert(profileNotify).content).content;
check('strip: per-profile notify survives', strippedProfile.includes('/my/own/notifier'), strippedProfile);

// Removing CliDeck must never dismantle a notifier the user built themselves.
const strippedChain = stripCodexConfig(chainedNotify).content;
check('strip: a user-built notify chain is NOT destroyed',
  strippedChain.includes('SkyComputerUseClient'), strippedChain);
check('strip: chained file stays valid TOML', parses(strippedChain), strippedChain);
const strippedSiblings = stripCodexConfig(upsert(inlineSiblings).content).content;
check('strip: sibling exporter settings survive', strippedSiblings.includes('auth = "x"'), strippedSiblings);

// Removal must never take an exporter CliDeck never wrote.
const customExporter = '[otel]\nexporter = { otlp-custom = { endpoint = "http://mine:1234" } }\n';
const strippedCustom = stripCodexConfig(customExporter);
check('strip: a custom exporter is NOT deleted', strippedCustom.content.includes('otlp-custom'), strippedCustom.content);
check('strip: a custom exporter is reported as manual', strippedCustom.manual.includes('otel'));
check('strip: custom exporter file stays valid TOML', parses(strippedCustom.content), strippedCustom.content);

// Leaving a user-owned table means saying so, not silently half-cleaning it.
const strippedHeaders = stripCodexConfig(inlineSiblings);
check('strip: a user-owned exporter is left intact and reported',
  strippedHeaders.content.includes('auth = "x"') && strippedHeaders.manual.includes('otel'), strippedHeaders.content);

// Our own canonical otel is removed completely, leaving nothing behind.
const strippedOwn = stripCodexConfig(upsert('').content);
check('strip: our own otel is fully removed',
  !strippedOwn.content.includes('localhost:4000') && strippedOwn.manual.length === 0, strippedOwn.content);

// features.hooks is Codex's global switch: clearing it would disable hooks that
// belong to other tools, so it stays when any of those remain.
const configured2 = upsert('').content;
check('strip: hooks switch is cleared when only CliDeck used it',
  readCodexSetup(stripCodexConfig(configured2).content, PORT).hooksEnabled === false);
check('strip: hooks switch is KEPT when other hooks remain',
  readCodexSetup(stripCodexConfig(configured2, { keepHooksFeature: true }).content, PORT).hooksEnabled === true,
  stripCodexConfig(configured2, { keepHooksFeature: true }).content);

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall codex config checks passed');
