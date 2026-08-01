const { parse } = require('smol-toml');

// Codex's config.toml belongs to the user. CliDeck only needs three settings in
// it (otel endpoint, notify helper, features.hooks), so the rules here are:
//
//   READ   parse real TOML, so any valid shape of those settings is understood
//          ([otel.exporter.otlp-http] and [otel] + inline table are the same
//          config, and CliDeck must not care which one the user wrote).
//   WRITE  change only those three settings, in place. Never reorder the file,
//          never rewrite text CliDeck did not put there, and never delete a key
//          just because it sits near one of ours. A config we corrupt is a
//          config Codex can no longer start with.
//
// Two consequences worth stating, because both were bugs before:
//   - an assignment can span lines (`notify = [` ... `]`), so replacing one means
//     replacing its whole value, not its first line
//   - if the user already routes notify through their own notifier, that chain is
//     theirs; CliDeck reports the conflict instead of overwriting it.

// --- reading -----------------------------------------------------------------

// Older CliDeck versions could write headers glued onto the previous line. Repair
// is attempted ONLY when the file does not parse, so valid TOML (including
// strings that merely contain something like "[otel]") is never rewritten.
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

// Semantic view of the config — what is actually configured, regardless of which
// valid TOML shape expressed it.
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
    otelOk: hasEndpoint && endpoint.includes(`localhost:${port}`) && !endpoint.includes('/v1/logs'),
    wrongOtel: hasEndpoint && endpoint.includes('/v1/logs'),
    notifyHelper: findNotifyHelper(notify),
    hooksEnabled: data.features?.hooks === true,
  };
}

// --- line model for in-place edits -------------------------------------------

// Net bracket depth of a line, ignoring brackets inside strings or comments —
// notify values legitimately contain text like "[\"node\",\"...\"]".
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

// Split into the top-level region plus one region per section header. Header
// detection only runs at bracket depth 0, so lines inside a multiline array are
// never mistaken for headers.
function scanRegions(lines) {
  const marks = [];
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    if (depth === 0 && /^\s*\[\[?[^[\]]+\]\]?\s*$/.test(lines[i])) marks.push(i);
    depth = Math.max(0, depth + bracketDelta(lines[i]));
  }
  const regions = [{ header: null, start: 0, end: marks.length ? marks[0] : lines.length }];
  marks.forEach((start, idx) => {
    regions.push({
      header: lines[start].trim(),
      start,
      end: idx + 1 < marks.length ? marks[idx + 1] : lines.length,
    });
  });
  return regions;
}

// Locate a `key = ...` assignment within a region, spanning multiline values.
function findAssignment(lines, key, from, to) {
  const re = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = from; i < to; i++) {
    if (!re.test(lines[i])) continue;
    let depth = bracketDelta(lines[i]);
    let end = i;
    while (depth > 0 && end + 1 < to) { end++; depth += bracketDelta(lines[end]); }
    return { start: i, end };
  }
  return null;
}

// Replace an assignment in place, or insert it just after the region header.
function setKey(lines, region, key, newLine) {
  const found = findAssignment(lines, key, region.start + (region.header ? 1 : 0), region.end);
  if (found) lines.splice(found.start, found.end - found.start + 1, newLine);
  else lines.splice(region.start + (region.header ? 1 : 0), 0, newLine);
}

function regionFor(lines, header) {
  return scanRegions(lines).find(r => r.header === header) || null;
}

// --- writing ------------------------------------------------------------------

function ensureHooks(lines) {
  const features = regionFor(lines, '[features]');
  if (!features) {
    if (lines.length && lines[lines.length - 1].trim()) lines.push('');
    lines.push('[features]', 'hooks = true');
    return;
  }
  setKey(lines, features, 'hooks', 'hooks = true');
}

function ensureOtel(lines, port) {
  const endpoint = `"http://localhost:${port}"`;

  const dotted = regionFor(lines, '[otel.exporter.otlp-http]');
  if (dotted) {
    setKey(lines, dotted, 'endpoint', `endpoint = ${endpoint}`);
    setKey(lines, regionFor(lines, '[otel.exporter.otlp-http]'), 'protocol', 'protocol = "json"');
    return;
  }

  const otel = regionFor(lines, '[otel]');
  if (otel && findAssignment(lines, 'exporter', otel.start + 1, otel.end)) {
    setKey(lines, otel, 'exporter', `exporter = { otlp-http = { endpoint = ${endpoint}, protocol = "json" } }`);
    return;
  }

  const top = scanRegions(lines)[0];
  if (findAssignment(lines, 'otel\\.exporter\\.otlp-http\\.endpoint', top.start, top.end)) {
    setKey(lines, top, 'otel\\.exporter\\.otlp-http\\.endpoint', `otel.exporter.otlp-http.endpoint = ${endpoint}`);
    return;
  }

  // No otel exporter configured yet — add one without touching other otel keys.
  if (lines.length && lines[lines.length - 1].trim()) lines.push('');
  lines.push('[otel.exporter.otlp-http]', `endpoint = ${endpoint}`, 'protocol = "json"');
}

// Returns { content, notifyConflict }. A foreign notify is left untouched and
// reported, because overwriting it would silently break the user's own notifier.
function upsertCodexConfig(content, nodePath, notifyHelperPath, port) {
  const parsed = parseCodexToml(content);
  const setup = readCodexSetup(content, port);
  const lines = parsed.text.split('\n');

  if (!setup.hooksEnabled) ensureHooks(lines);
  if (!setup.otelOk) ensureOtel(lines, port);

  let notifyConflict = false;
  if (!setup.notifyHelper) {
    const top = scanRegions(lines)[0];
    if (findAssignment(lines, 'notify', top.start, top.end)) {
      notifyConflict = true;
    } else {
      // Top-level keys must stay above the first section header.
      const notifyLine = `notify = ["${nodePath}", "${notifyHelperPath}", "${port}"]`;
      const needsGap = top.end < lines.length && lines[top.end].trim().startsWith('[');
      lines.splice(top.end, 0, ...(needsGap ? [notifyLine, ''] : [notifyLine]));
    }
  }

  return { content: lines.join('\n').trimEnd() + '\n', notifyConflict };
}

// Remove only the settings CliDeck manages, then drop tables that our removal
// left empty. A user's own keys and notifier chain stay exactly as they were.
function stripCodexConfig(content) {
  const parsed = parseCodexToml(content);
  const lines = parsed.text.split('\n');

  const top = scanRegions(lines)[0];
  const notify = findAssignment(lines, 'notify', top.start, top.end);
  if (notify) {
    const text = lines.slice(notify.start, notify.end + 1).join('\n');
    if (text.includes('notify-helper')) lines.splice(notify.start, notify.end - notify.start + 1);
  }

  const features = regionFor(lines, '[features]');
  if (features) {
    for (const key of ['hooks', 'codex_hooks']) {
      const found = findAssignment(lines, key, features.start + 1, features.end);
      if (found) lines.splice(found.start, found.end - found.start + 1);
    }
  }

  for (const key of ['endpoint', 'protocol']) {
    const dotted = regionFor(lines, '[otel.exporter.otlp-http]');
    if (!dotted) break;
    const found = findAssignment(lines, key, dotted.start + 1, dotted.end);
    if (found) lines.splice(found.start, found.end - found.start + 1);
  }
  const otel = regionFor(lines, '[otel]');
  if (otel) {
    const exporter = findAssignment(lines, 'exporter', otel.start + 1, otel.end);
    if (exporter) lines.splice(exporter.start, exporter.end - exporter.start + 1);
  }

  // Drop headers whose body is now empty — but only ones we just emptied.
  for (const header of ['[otel.exporter.otlp-http]', '[otel]', '[features]']) {
    const region = regionFor(lines, header);
    if (region && lines.slice(region.start + 1, region.end).every(l => !l.trim())) {
      lines.splice(region.start, region.end - region.start);
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

module.exports = { upsertCodexConfig, stripCodexConfig, validateCodexConfigToml, readCodexSetup, parseCodexToml };
