const { parse } = require('smol-toml');

// Codex's config.toml belongs to the user. CliDeck needs three settings in it
// (otel exporter, notify helper, features.hooks) and nothing else, so:
//
//   READ   parse real TOML. Every valid spelling of those settings is understood
//          - [otel.exporter.otlp-http], [otel] with an inline table, dotted keys,
//          quoted keys, trailing comments. Detection never guesses from text.
//
//   WRITE  only when the target is absent, or when it is provably CliDeck's own
//          canonical form. Anything else is the user's: it is left byte-for-byte
//          alone and reported back as a manual step.
//
// The rule exists because the alternative does not work. Editing arbitrary TOML
// by pattern kept finding new shapes that broke - sibling exporters losing their
// endpoint, a custom exporter deleted on removal, a header with a trailing
// comment producing a duplicate table. Ownership is decided on PARSED data, so
// there is no shape left to mis-read: if we did not write it, we do not touch it.

const CANONICAL_HEADER = 'otel.exporter.otlp-http';

// --- TOML text helpers (structure only, never used to decide semantics) --------

function stripComment(line) {
  let out = '', quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      out += ch;
      if (quote === '"' && ch === '\\') { out += line[++i] ?? ''; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
    if (ch === '#') break;
    out += ch;
  }
  return out;
}

// "otel.exporter.\"otlp-http\"" -> "otel.exporter.otlp-http"
function parseKeyPath(text) {
  const parts = [];
  let current = '', quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (quote === '"' && ch === '\\') { current += text[++i] ?? ''; continue; }
      if (ch === quote) { quote = null; continue; }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '.') { parts.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  parts.push(current.trim());
  return parts.filter(Boolean).join('.');
}

function headerPath(line) {
  const text = stripComment(line).trim();
  if (!text.startsWith('[') || !text.endsWith(']')) return null;
  const inner = text.startsWith('[[') && text.endsWith(']]') ? text.slice(2, -2) : text.slice(1, -1);
  if (inner.includes('[') || inner.includes(']') || !inner.trim()) return null;
  return parseKeyPath(inner);
}

function assignmentPath(line) {
  const text = stripComment(line);
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (quote === '"' && ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '=') return parseKeyPath(text.slice(0, i));
  }
  return null;
}

// State at the start of each line: bracket depth, and whether we are inside a
// multiline string. Index `lines.length` holds the end-of-file state.
function analyzeLines(lines) {
  const state = [];
  let depth = 0, multiline = null;
  for (const line of lines) {
    state.push({ depth, inString: !!multiline });
    let i = 0;
    while (i < line.length) {
      if (multiline) {
        // Basic multiline strings honour backslash escapes, so an escaped quote
        // is content, not the start of a terminator. Literal ''' strings do not.
        if (multiline === '"""' && line[i] === '\\') { i += 2; continue; }
        if (line.startsWith(multiline, i)) { multiline = null; i += 3; continue; }
        i++;
        continue;
      }
      if (line.startsWith('"""', i)) { multiline = '"""'; i += 3; continue; }
      if (line.startsWith("'''", i)) { multiline = "'''"; i += 3; continue; }
      const ch = line[i];
      if (ch === '"') {
        i++;
        while (i < line.length) {
          if (line[i] === '\\') { i += 2; continue; }
          if (line[i] === '"') { i++; break; }
          i++;
        }
        continue;
      }
      if (ch === "'") {
        i++;
        while (i < line.length && line[i] !== "'") i++;
        i++;
        continue;
      }
      if (ch === '#') break;
      if (ch === '[') depth++;
      else if (ch === ']') depth = Math.max(0, depth - 1);
      i++;
    }
  }
  state.push({ depth, inString: !!multiline });
  return state;
}

// The top-level region plus one region per section header. Only lines beginning
// outside any value can be headers.
function scanRegions(lines) {
  const state = analyzeLines(lines);
  const marks = [];
  for (let i = 0; i < lines.length; i++) {
    if (state[i].depth || state[i].inString) continue;
    if (headerPath(lines[i]) !== null) marks.push(i);
  }
  const regions = [{ path: null, start: 0, end: marks.length ? marks[0] : lines.length }];
  marks.forEach((start, idx) => {
    regions.push({
      path: headerPath(lines[start]),
      start,
      end: idx + 1 < marks.length ? marks[idx + 1] : lines.length,
    });
  });
  return regions;
}

// Locate a `key = ...` assignment within a region, spanning multiline values.
function findAssignment(lines, path, from, to) {
  const state = analyzeLines(lines);
  to = Math.min(to, lines.length);
  for (let i = Math.max(0, from); i < to; i++) {
    if (state[i].depth || state[i].inString) continue;
    if (assignmentPath(lines[i]) !== path) continue;
    let end = i;
    while (end + 1 < to && (state[end + 1].depth > 0 || state[end + 1].inString)) end++;
    return { start: i, end };
  }
  return null;
}

function removeRange(lines, range) {
  if (range) lines.splice(range.start, range.end - range.start + 1);
}

// --- reading -------------------------------------------------------------------

// Older CliDeck versions could write headers glued onto the previous line. Repair
// is attempted ONLY when the file does not parse, so valid TOML is never rewritten.
function repairGluedHeaders(content) {
  return content
    .replace(/([^\n])(\[(?:projects|notice|plugins)\.[^\n]*\])/g, '$1\n$2')
    .replace(/([^\n])(\[(?:features|otel)\])/g, '$1\n$2')
    .replace(/([^\n])(\[\[skills\.[^\n]*\]\])/g, '$1\n$2');
}

function parseCodexToml(content) {
  const raw = String(content || '').replace(/\r\n/g, '\n');
  try {
    return { ok: true, data: parse(raw), text: raw };
  } catch (err) {
    const repaired = repairGluedHeaders(raw);
    if (repaired !== raw) {
      try { return { ok: true, data: parse(repaired), text: repaired, repaired: true }; } catch { /* fall through */ }
    }
    return { ok: false, error: `Invalid TOML: ${err.message.split('\n')[0]}`, text: raw };
  }
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

// --- ownership: decided on parsed data, never on text --------------------------

// True for a notify array CliDeck wrote itself: [node, helper, port]. Anything
// else is a chain the user built.
function isOwnNotify(notify) {
  return Array.isArray(notify)
    && notify.length === 3
    && typeof notify[1] === 'string'
    && notify[1].includes('notify-helper');
}

// True when otel holds nothing beyond the otlp-http endpoint/protocol CliDeck
// writes — so replacing it cannot take a user setting with it.
function isOwnOtel(data) {
  const otel = data.otel;
  if (otel === undefined) return true;
  if (!otel || typeof otel !== 'object' || Object.keys(otel).some(k => k !== 'exporter')) return false;
  const exporter = otel.exporter;
  if (exporter === undefined) return true;
  if (!exporter || typeof exporter !== 'object' || Object.keys(exporter).some(k => k !== 'otlp-http')) return false;
  const http = exporter['otlp-http'];
  if (http === undefined) return true;
  if (!http || typeof http !== 'object') return false;
  return Object.keys(http).every(k => k === 'endpoint' || k === 'protocol');
}

// Semantic view of the config — what is actually configured, regardless of shape.
function readCodexSetup(content, port) {
  const parsed = parseCodexToml(content);
  if (!parsed.ok) {
    return { valid: false, error: parsed.error, needsRepair: false, otelOk: false, wrongOtel: false, notifyHelper: null, ownOtel: false, ownNotify: false, hooksEnabled: false };
  }
  const data = parsed.data || {};
  const otlp = data.otel?.exporter?.['otlp-http'];
  const endpoint = otlp?.endpoint;
  const hasEndpoint = typeof endpoint === 'string';
  const notify = Array.isArray(data.notify) ? data.notify : [];
  return {
    valid: true,
    // The file parses only after repair, so what is on disk is still broken for
    // Codex; it cannot count as configured until the repair is written back.
    needsRepair: !!parsed.repaired,
    // CliDeck's OTLP receiver only decodes JSON, so any other protocol means
    // status would silently never arrive.
    otelOk: hasEndpoint && endpoint.includes(`localhost:${port}`) && !endpoint.includes('/v1/logs') && otlp?.protocol === 'json',
    wrongOtel: hasEndpoint && endpoint.includes('/v1/logs'),
    notifyHelper: findNotifyHelper(notify),
    ownOtel: isOwnOtel(data),
    ownNotify: data.notify === undefined || isOwnNotify(data.notify),
    hooksEnabled: data.features?.hooks === true,
  };
}

// --- writing --------------------------------------------------------------------

function appendBlock(lines, block) {
  if (lines.length && lines[lines.length - 1].trim()) lines.push('');
  lines.push(...block);
}

// Setting one key inside [features] replaces only that key.
function ensureHooks(lines) {
  const features = scanRegions(lines).find(r => r.path === 'features');
  if (!features) {
    appendBlock(lines, ['[features]', 'hooks = true']);
    return;
  }
  const found = findAssignment(lines, 'hooks', features.start + 1, features.end);
  if (found) lines.splice(found.start, found.end - found.start + 1, 'hooks = true');
  else lines.splice(features.start + 1, 0, 'hooks = true');
}

// Only ever called once ownership says every otel key is ours.
function removeOwnOtel(lines) {
  const regions = scanRegions(lines);
  for (let i = regions.length - 1; i >= 1; i--) {
    const r = regions[i];
    if (r.path === 'otel' || r.path?.startsWith('otel.')) lines.splice(r.start, r.end - r.start);
  }
  for (;;) {
    const top = scanRegions(lines)[0];
    const state = analyzeLines(lines);
    let hit = null;
    for (let i = top.start; i < top.end && !hit; i++) {
      if (state[i].depth || state[i].inString) continue;
      const path = assignmentPath(lines[i]);
      if (path === 'otel' || path?.startsWith('otel.')) hit = findAssignment(lines, path, i, top.end);
    }
    if (!hit) break;
    removeRange(lines, hit);
  }
}

function writeOwnOtel(lines, port) {
  // If the canonical table is already there, correct its keys in place so the
  // header line — and any comment the user put on it — survives.
  const canonical = scanRegions(lines).find(r => r.path === CANONICAL_HEADER);
  if (canonical) {
    for (const [key, line] of [['endpoint', `endpoint = "http://localhost:${port}"`], ['protocol', 'protocol = "json"']]) {
      const region = scanRegions(lines).find(r => r.path === CANONICAL_HEADER);
      const found = findAssignment(lines, key, region.start + 1, region.end);
      if (found) lines.splice(found.start, found.end - found.start + 1, line);
      else lines.splice(region.start + 1, 0, line);
    }
    return;
  }
  removeOwnOtel(lines);
  appendBlock(lines, [`[${CANONICAL_HEADER}]`, `endpoint = "http://localhost:${port}"`, 'protocol = "json"']);
}

function notifyLine(nodePath, helperPath, port) {
  return `notify = ["${nodePath}", "${helperPath}", "${port}"]`;
}

// Returns { content, manual }. `manual` lists settings CliDeck refused to touch
// because they are the user's; the caller tells them what to add by hand.
function upsertCodexConfig(content, nodePath, notifyHelperPath, port) {
  const parsed = parseCodexToml(content);
  const setup = readCodexSetup(content, port);
  const data = parsed.data || {};
  const lines = parsed.text.split('\n');
  const manual = [];

  if (!setup.hooksEnabled) ensureHooks(lines);

  if (!setup.otelOk) {
    if (setup.ownOtel) writeOwnOtel(lines, port);
    else manual.push('otel');
  }

  const desired = [nodePath, notifyHelperPath, String(port)];
  const current = data.notify;
  const matches = Array.isArray(current) && current.length === 3 && current.every((v, i) => String(v) === desired[i]);
  if (!matches) {
    if (current === undefined) {
      const top = scanRegions(lines)[0];
      // Top-level keys must stay above the first section header.
      const needsGap = top.end < lines.length && lines[top.end].trim().startsWith('[');
      const line = notifyLine(nodePath, notifyHelperPath, port);
      lines.splice(top.end, 0, ...(needsGap ? [line, ''] : [line]));
    } else if (isOwnNotify(current)) {
      const top = scanRegions(lines)[0];
      const found = findAssignment(lines, 'notify', top.start, top.end);
      if (found) lines.splice(found.start, found.end - found.start + 1, notifyLine(nodePath, notifyHelperPath, port));
    } else if (!setup.notifyHelper) {
      manual.push('notify');
    }
  }

  return { content: lines.join('\n').trimEnd() + '\n', manual };
}

// Remove only what CliDeck wrote. Anything the user owns is left intact and
// reported, so removal never half-edits someone else's config silently.
// `keepHooksFeature` is set when hooks other than CliDeck's remain in hooks.json:
// features.hooks is Codex's global switch, so clearing it would disable those too.
function stripCodexConfig(content, options = {}) {
  const parsed = parseCodexToml(content);
  const data = parsed.data || {};
  const lines = parsed.text.split('\n');
  const manual = [];

  if (isOwnNotify(data.notify)) {
    const top = scanRegions(lines)[0];
    removeRange(lines, findAssignment(lines, 'notify', top.start, top.end));
  } else if (data.notify !== undefined && findNotifyHelper(data.notify)) {
    manual.push('notify');
  }

  const featureKeys = options.keepHooksFeature ? ['codex_hooks'] : ['hooks', 'codex_hooks'];
  for (const key of featureKeys) {
    // Re-locate each time: every removal shifts the lines after it.
    const features = scanRegions(lines).find(r => r.path === 'features');
    if (!features) break;
    removeRange(lines, findAssignment(lines, key, features.start + 1, features.end));
  }

  if (data.otel !== undefined) {
    if (isOwnOtel(data)) removeOwnOtel(lines);
    else manual.push('otel');
  }

  // Drop headers whose body our removal just emptied.
  for (;;) {
    const empty = scanRegions(lines).find(r => r.path
      && (r.path === 'features' || r.path === 'otel' || r.path.startsWith('otel.'))
      && lines.slice(r.start + 1, r.end).every(l => !l.trim()));
    if (!empty) break;
    lines.splice(empty.start, empty.end - empty.start);
  }

  return { content: lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n', manual };
}

module.exports = { upsertCodexConfig, stripCodexConfig, validateCodexConfigToml, readCodexSetup, parseCodexToml };
