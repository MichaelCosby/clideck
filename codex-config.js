const { parse } = require('smol-toml');

// Codex's config.toml is user-owned: it can use any valid TOML shape for the
// same settings ([otel.exporter.otlp-http] vs [otel] + an inline table), and it
// carries the user's own comments and formatting.
//
// So this module splits the two jobs:
//   - READING  (validate / detect) parses real TOML, so any equivalent shape is
//     understood instead of only the exact text CliDeck happens to write.
//   - WRITING  (upsert / strip) edits lines surgically rather than re-serializing
//     a parsed document, so comments, ordering, and unrelated keys survive.
//
// The one rule the write path must respect: an assignment can span multiple
// lines (`notify = [` ... `]`), so removing one means removing the whole value,
// not just the first line — otherwise the leftovers corrupt the file.

function normalizeCodexToml(content) {
  return String(content || '')
    .replace(/\r\n/g, '\n')
    .replace(/([^\n])(\[(?:projects|notice|plugins)\.[^\n]*\])/g, '$1\n$2')
    .replace(/([^\n])(\[(?:features|otel)\])/g, '$1\n$2')
    .replace(/([^\n])(\[\[skills\.[^\n]*\]\])/g, '$1\n$2');
}

function parseCodexToml(content) {
  try {
    return { ok: true, data: parse(normalizeCodexToml(content)) };
  } catch (err) {
    return { ok: false, error: `Invalid TOML: ${err.message.split('\n')[0]}` };
  }
}

// Net bracket depth of a line, ignoring brackets inside strings or comments —
// Codex notify values legitimately contain things like "[\"node\",\"...\"]".
function bracketDelta(line) {
  let depth = 0, inBasic = false, inLiteral = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inBasic) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inBasic = false;
      continue;
    }
    if (inLiteral) {
      if (ch === "'") inLiteral = false;
      continue;
    }
    if (ch === '"') { inBasic = true; continue; }
    if (ch === "'") { inLiteral = true; continue; }
    if (ch === '#') break;
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
  }
  return depth;
}

// Drop every `key = ...` assignment for the given key, including values that
// span multiple lines. Dropping only the first line would orphan the remaining
// array entries and the closing bracket, leaving a broken file behind.
function stripAssignment(lines, key) {
  const start = new RegExp(`^\\s*${key}\\s*=`);
  const out = [];
  let depth = 0, dropping = false;
  for (const line of lines) {
    if (dropping) {
      depth += bracketDelta(line);
      if (depth <= 0) dropping = false;
      continue;
    }
    if (start.test(line)) {
      depth = bracketDelta(line);
      if (depth > 0) dropping = true;
      continue;
    }
    out.push(line);
  }
  return out;
}

function isOtelHeader(header) {
  return header === '[otel]' || header.startsWith('[otel.');
}

function splitTomlSections(content) {
  const lines = normalizeCodexToml(content).split('\n');
  const top = [];
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (/^\s*\[.*\]\s*$/.test(line)) {
      current = { header: line.trim(), lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else top.push(line);
  }
  return { top, sections };
}

function trimBlankEdges(lines) {
  const out = [...lines];
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

function upsertCodexConfig(content, nodePath, notifyHelperPath, port) {
  // Strip notify before splitting, so a multiline array's inner lines can never
  // be mistaken for section headers or left behind as orphans.
  const stripped = stripAssignment(normalizeCodexToml(content).split('\n'), 'notify').join('\n');
  const { top, sections } = splitTomlSections(stripped);
  const notifyLine = `notify = ["${nodePath}", "${notifyHelperPath}", "${port}"]`;
  const topOut = trimBlankEdges([...top, notifyLine]);

  let hasFeatures = false;
  const keptSections = sections.map(section => {
    if (section.header !== '[features]') return section;
    hasFeatures = true;
    const lines = trimBlankEdges(section.lines.filter(line => !/^\s*(codex_hooks|hooks)\s*=/.test(line)));
    return { ...section, lines: trimBlankEdges([...lines, 'hooks = true']) };
  });
  if (!hasFeatures) keptSections.push({ header: '[features]', lines: ['hooks = true'] });

  // Drop every existing otel table, dotted forms included. Keeping an
  // [otel.exporter.otlp-http] table and then appending [otel] would redefine
  // the same table and make the file invalid TOML.
  const otelBody = [`exporter = { otlp-http = { endpoint = "http://localhost:${port}", protocol = "json" } }`];
  const withoutOtel = keptSections.filter(s => !isOtelHeader(s.header));
  withoutOtel.push({ header: '[otel]', lines: otelBody });

  const out = [];
  if (topOut.length) out.push(...topOut, '');
  withoutOtel.forEach((section, idx) => {
    out.push(section.header, ...trimBlankEdges(section.lines));
    if (idx < withoutOtel.length - 1) out.push('');
  });
  return out.join('\n').trimEnd() + '\n';
}

// Remove CliDeck's own settings again, tolerating the same TOML variety.
function stripCodexConfig(content) {
  const withoutNotify = stripAssignment(normalizeCodexToml(content).split('\n'), 'notify');
  const { top, sections } = splitTomlSections(withoutNotify.join('\n'));
  const kept = sections
    .filter(s => !isOtelHeader(s.header))
    .map(s => ({ ...s, lines: s.lines.filter(line => !/^\s*(codex_hooks|hooks)\s*=/.test(line)) }));

  const out = [...trimBlankEdges(top)];
  if (out.length) out.push('');
  kept.forEach((section, idx) => {
    out.push(section.header, ...trimBlankEdges(section.lines));
    if (idx < kept.length - 1) out.push('');
  });
  return out.join('\n').trimEnd() + '\n';
}

function validateCodexConfigToml(content) {
  const parsed = parseCodexToml(content);
  return parsed.ok ? { ok: true } : { ok: false, error: parsed.error };
}

// The helper is usually its own notify entry, but users legitimately chain
// CliDeck behind another notifier, which nests our argv inside that notifier's
// own JSON-encoded argument. Pull the path out of either shape.
function findNotifyHelper(notify) {
  for (const entry of notify) {
    if (typeof entry !== 'string') continue;
    const match = entry.match(/[^"',[\]]*notify-helper[^"',[\]]*/);
    if (match) return match[0];
  }
  return null;
}

// Semantic view of the user's config — what is actually configured, regardless
// of which valid TOML shape expressed it.
function readCodexSetup(content, port) {
  const parsed = parseCodexToml(content);
  if (!parsed.ok) {
    return { valid: false, error: parsed.error, otelOk: false, wrongOtel: false, notifyHelper: null, hooksEnabled: false };
  }
  const data = parsed.data || {};
  const endpoint = data.otel?.exporter?.['otlp-http']?.endpoint;
  const hasEndpoint = typeof endpoint === 'string';
  const notify = Array.isArray(data.notify) ? data.notify : [];
  return {
    valid: true,
    otelOk: hasEndpoint && endpoint.includes(`localhost:${port}`),
    wrongOtel: hasEndpoint && endpoint.includes('/v1/logs'),
    notifyHelper: findNotifyHelper(notify),
    hooksEnabled: data.features?.hooks === true,
  };
}

module.exports = { upsertCodexConfig, stripCodexConfig, validateCodexConfigToml, readCodexSetup, parseCodexToml };
