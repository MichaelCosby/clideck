// Tracks the DEC private modes an agent switches on at startup (bracketed paste, focus reports, mouse, alternate
// screen, hidden cursor) so a replay that starts partway through a session's output can restore them first.
const TRACKED = [1049, 1, 25, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 2004];
const DEFAULTS = { 25: true };
const MODE_SEQUENCE = /\x1b(?:\[\?([0-9;]*)([hl])|c)/g;
// Long enough to finish a mode sequence cut off at the end of the scanned range.
const SEQUENCE_OVERHANG = 32;

// Applies the mode changes in `text` that start before `limit` (default: all of it) to a copy of `modes`.
function scanModes(modes, text, limit = text.length) {
  const next = { ...modes };
  for (const match of text.matchAll(MODE_SEQUENCE)) {
    if (match.index >= limit) break;
    if (match[0] === '\x1bc') {
      for (const key of Object.keys(next)) delete next[key];
      continue;
    }
    for (const part of match[1].split(';')) {
      const mode = Number(part);
      if (TRACKED.includes(mode)) next[mode] = match[2] === 'h';
    }
  }
  return next;
}

// The sequences that put a freshly reset terminal into `modes`.
function modePreamble(modes) {
  let out = '';
  for (const mode of TRACKED) {
    if (modes[mode] === undefined || modes[mode] === (DEFAULTS[mode] === true)) continue;
    out += `\x1b[?${mode}${modes[mode] ? 'h' : 'l'}`;
  }
  return out;
}

function normalizeModes(value) {
  const modes = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return modes;
  for (const mode of TRACKED) if (typeof value[mode] === 'boolean') modes[mode] = value[mode];
  return modes;
}

module.exports = { SEQUENCE_OVERHANG, modePreamble, normalizeModes, scanModes };
