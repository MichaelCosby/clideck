const { parse } = require('smol-toml');

// Codex's config.toml belongs to the user. CliDeck only needs three settings in
// it (otel endpoint, notify helper, features.hooks), so the rules here are:
//
//   READ   parse real TOML, so any valid shape of those settings is understood
//          ([otel.exporter.otlp-http] and [otel] + inline table are the same
//          config, and CliDeck must not care which one the user wrote).
//   WRITE  change only those settings, in place. Never reorder the file, never
//          rewrite text CliDeck did not put there, and never delete a key just
//          because it sits near one of ours. A config we corrupt is a config
//          Codex can no longer start with.
//
// Values can span lines as arrays (`notify = [` ... `]`) or as """ / ''' strings,
// so every edit works off a scanner that knows where a value starts and ends. A
// line inside a value is never a header and never an assignment, however much it
// looks like one — a multiline instructions string may legitimately contain the
// text "[features]".
//
// What is ours to change is also deliberately narrow: settings the user already
// owns (a notifier chain, sibling exporter keys, other otel settings) are read
// and reported, never overwritten.

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

// True only for a notify array CliDeck wrote itself: [node, helper, port].
// Anything longer is a chain the user built and must not be removed.
function isOwnNotify(notify) {
  return Array.isArray(notify)
    && notify.length === 3
    && typeof notify[1] === 'string'
    && notify[1].includes('notify-helper');
}

// Semantic view of the config — what is actually configured, regardless of which
// valid TOML shape expressed it.
function readCodexSetup(content, port) {
  const parsed = parseCodexToml(content);
  if (!parsed.ok) {
    return { valid: false, error: parsed.error, needsRepair: false, otelOk: false, wrongOtel: false, notifyHelper: null, hooksEnabled: false };
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
    ownNotify: isOwnNotify(data.notify),
    hooksEnabled: data.features?.hooks === true,
  };
}

// --- line model for in-place edits -------------------------------------------

// State at the start of each line: bracket depth, and whether we are inside a
// multiline string. Index `lines.length` holds the end-of-file state, so a value
// that runs to the last line still has a terminator to compare against.
function analyzeLines(lines) {
  const state = [];
  let depth = 0;
  let multiline = null;
  for (const line of lines) {
    state.push({ depth, inString: !!multiline });
    let i = 0;
    while (i < line.length) {
      if (multiline) {
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

// The top-level region plus one region per section header. Only lines that begin
// outside any value can be headers.
function scanRegions(lines) {
  const state = analyzeLines(lines);
  const marks = [];
  for (let i = 0; i < lines.length; i++) {
    if (state[i].depth || state[i].inString) continue;
    if (/^\s*\[\[?[^[\]]+\]\]?\s*$/.test(lines[i])) marks.push(i);
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
  const state = analyzeLines(lines);
  const re = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = from; i < to; i++) {
    if (state[i].depth || state[i].inString) continue;
    if (!re.test(lines[i])) continue;
    let end = i;
    while (end + 1 < to && (state[end + 1].depth > 0 || state[end + 1].inString)) end++;
    return { start: i, end };
  }
  return null;
}

// Replace an assignment in place, or insert it just after the region header.
function setKey(lines, region, key, newLine) {
  const body = region.start + (region.header ? 1 : 0);
  const found = findAssignment(lines, key, body, region.end);
  if (found) lines.splice(found.start, found.end - found.start + 1, newLine);
  else lines.splice(body, 0, newLine);
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

// Rewrite only the otlp-http endpoint/protocol inside an inline exporter table,
// leaving sibling settings (headers, other exporters) exactly as they are.
function patchExporter(text, url) {
  const at = text.indexOf('otlp-http');
  if (at === -1) {
    return text.replace(/=\s*\{/, `= { otlp-http = { endpoint = "${url}", protocol = "json" },`);
  }
  const head = text.slice(0, at);
  let tail = text.slice(at);
  tail = /endpoint\s*=\s*"[^"]*"/.test(tail)
    ? tail.replace(/(endpoint\s*=\s*)"[^"]*"/, `$1"${url}"`)
    : tail.replace(/(otlp-http\s*=\s*\{)/, `$1 endpoint = "${url}",`);
  tail = /protocol\s*=\s*"[^"]*"/.test(tail)
    ? tail.replace(/(protocol\s*=\s*)"[^"]*"/, '$1"json"')
    : tail.replace(/(otlp-http\s*=\s*\{)/, '$1 protocol = "json",');
  return head + tail;
}

function ensureOtel(lines, port) {
  const url = `http://localhost:${port}`;

  const dotted = regionFor(lines, '[otel.exporter.otlp-http]');
  if (dotted) {
    setKey(lines, dotted, 'endpoint', `endpoint = "${url}"`);
    setKey(lines, regionFor(lines, '[otel.exporter.otlp-http]'), 'protocol', 'protocol = "json"');
    return;
  }

  const otel = regionFor(lines, '[otel]');
  const exporter = otel && findAssignment(lines, 'exporter', otel.start + 1, otel.end);
  if (exporter) {
    const text = lines.slice(exporter.start, exporter.end + 1).join('\n');
    lines.splice(exporter.start, exporter.end - exporter.start + 1, ...patchExporter(text, url).split('\n'));
    return;
  }

  const top = scanRegions(lines)[0];
  if (findAssignment(lines, 'otel\\.exporter\\.otlp-http\\.endpoint', top.start, top.end)) {
    setKey(lines, top, 'otel\\.exporter\\.otlp-http\\.endpoint', `otel.exporter.otlp-http.endpoint = "${url}"`);
    setKey(lines, scanRegions(lines)[0], 'otel\\.exporter\\.otlp-http\\.protocol', 'otel.exporter.otlp-http.protocol = "json"');
    return;
  }

  // Nothing configured yet — add a table without touching other otel keys.
  if (lines.length && lines[lines.length - 1].trim()) lines.push('');
  lines.push('[otel.exporter.otlp-http]', `endpoint = "${url}"`, 'protocol = "json"');
}

// Returns { content, notifyConflict }. A notify chain the user owns is left
// untouched and reported, because overwriting it would break their notifier.
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

// Remove only the settings CliDeck wrote, then drop tables that our removal left
// empty. A notify chain the user built keeps CliDeck in it: taking our helper out
// of someone else's argv is their edit to make, not ours.
function stripCodexConfig(content) {
  const parsed = parseCodexToml(content);
  const lines = parsed.text.split('\n');

  if (isOwnNotify(parsed.data?.notify)) {
    const top = scanRegions(lines)[0];
    const notify = findAssignment(lines, 'notify', top.start, top.end);
    if (notify) lines.splice(notify.start, notify.end - notify.start + 1);
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
    // Only drop an exporter that is ours alone; siblings mean it is the user's.
    if (exporter) {
      const text = lines.slice(exporter.start, exporter.end + 1).join('\n');
      if (!/headers|otlp-grpc/.test(text)) lines.splice(exporter.start, exporter.end - exporter.start + 1);
    }
  }

  // Drop headers whose body our removal just emptied.
  for (const header of ['[otel.exporter.otlp-http]', '[otel]', '[features]']) {
    const region = regionFor(lines, header);
    if (region && lines.slice(region.start + 1, region.end).every(l => !l.trim())) {
      lines.splice(region.start, region.end - region.start);
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

module.exports = { upsertCodexConfig, stripCodexConfig, validateCodexConfigToml, readCodexSetup, parseCodexToml };
