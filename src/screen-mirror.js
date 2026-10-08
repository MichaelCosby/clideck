// A headless xterm that sees exactly the output a session sends to browsers, so the engine can hand a browser
// the current screen of a full-screen agent (Claude Code's fullscreen TUI, Codex) instead of replaying every
// byte it ever drew. Those agents patch the alternate screen in place, so a raw replay costs hundreds of KB and
// can't start part-way through; the drawn screen is a few KB and exact.
const { Terminal } = require('@xterm/headless');

const WRITE_SLICE = 8192;
const MOUSE_MODES = { x10: 9, vt200: 1000, drag: 1002, any: 1003 };

function colorCodes(cell, background) {
  const base = background ? 40 : 30;
  if (background ? cell.isBgDefault() : cell.isFgDefault()) return [];
  const color = background ? cell.getBgColor() : cell.getFgColor();
  if (background ? cell.isBgRGB() : cell.isFgRGB()) {
    return [base + 8, 2, (color >> 16) & 255, (color >> 8) & 255, color & 255];
  }
  if (color < 8) return [base + color];
  if (color < 16) return [base + 60 + color - 8];
  return [base + 8, 5, color];
}

// The SGR parameters that draw `cell` from a reset state.
function cellStyle(cell) {
  const codes = [];
  if (cell.isBold()) codes.push(1);
  if (cell.isDim()) codes.push(2);
  if (cell.isItalic()) codes.push(3);
  if (cell.isUnderline()) codes.push(4);
  if (cell.isBlink()) codes.push(5);
  if (cell.isInverse()) codes.push(7);
  if (cell.isInvisible()) codes.push(8);
  if (cell.isStrikethrough()) codes.push(9);
  if (cell.isOverline()) codes.push(53);
  codes.push(...colorCodes(cell, false), ...colorCodes(cell, true));
  return codes.join(';');
}

// A cell that looks like the cleared screen: nothing in it and no background or reverse video.
function isBlank(cell) {
  return !cell.getChars() && cell.isBgDefault() && !cell.isInverse();
}

class ScreenMirror {
  constructor(cols, rows) {
    // No scrollback: only the alternate screen is ever served from here; normal-screen history stays raw.
    this.terminal = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
    this.disposed = false;
  }

  // In slices: xterm keeps an input buffer as large as the largest write it was given, and a burst of output
  // (a shell printing a big file) would otherwise pin that much memory for the life of the session.
  write(data) {
    if (this.disposed || !data) return;
    for (let i = 0; i < data.length; i += WRITE_SLICE) this.terminal.write(data.slice(i, i + WRITE_SLICE));
  }

  // xterm resizes at once but parses writes later, so queue the resize behind them: output drawn at the old size
  // is laid out at the old size, as it was in every browser.
  resize(cols, rows) {
    if (this.disposed) return;
    this.terminal.write('', () => { if (!this.disposed) this.terminal.resize(cols, rows); });
  }

  // Calls back with the screen as of every write made before this call: xterm parses writes in order, so the
  // callback of an empty write runs after those and before any later ones.
  snapshot(callback) {
    if (this.disposed) { callback(null); return; }
    this.terminal.write('', () => {
      if (this.disposed) { callback(null); return; }
      const alternate = this.terminal.buffer.active.type === 'alternate';
      callback({ alternate, data: alternate ? this.drawScreen() : '' });
    });
  }

  // Each visible row at the current width (rows can keep cells from a wider size), then the cursor and the
  // input modes the app set. Soft wraps don't matter here: a full-screen app positions every row itself.
  drawScreen() {
    const { cols, rows, modes } = this.terminal;
    const buffer = this.terminal.buffer.active;
    let out = '\x1b[?1049h\x1b[0m\x1b[H\x1b[2J';
    let cell = buffer.getNullCell();
    for (let y = 0; y < rows; y++) {
      const line = buffer.getLine(buffer.viewportY + y);
      if (!line) continue;
      let last = -1;
      for (let x = 0; x < cols; x++) {
        cell = line.getCell(x, cell);
        if (cell && !isBlank(cell)) last = x;
      }
      if (last < 0) continue;
      out += `\x1b[${y + 1};1H`;
      let style = '', skip = 0, erase = 0;
      const flushErase = () => { if (erase) { out += `\x1b[${erase}X\x1b[${erase}C`; erase = 0; } };
      for (let x = 0; x <= last; x++) {
        cell = line.getCell(x, cell);
        if (!cell || cell.getWidth() === 0) continue;   // the second half of a wide character
        if (isBlank(cell)) { flushErase(); skip += 1; continue; }   // left untouched, as the cleared screen has it
        if (skip) { out += `\x1b[${skip}C`; skip = 0; }
        const next = cellStyle(cell);
        if (next !== style) { flushErase(); out += `\x1b[0${next ? `;${next}` : ''}m`; style = next; }
        // An erased cell with a background (a status bar cleared with EL) is erased again, not filled with a space.
        if (!cell.getChars() && !cell.isInverse()) { erase += 1; continue; }
        flushErase();
        out += cell.getChars() || ' ';
      }
      flushErase();
      if (style) out += '\x1b[0m';
    }
    out += `\x1b[${buffer.cursorY + 1};${buffer.cursorX + 1}H`;
    if (modes.applicationCursorKeysMode) out += '\x1b[?1h';
    if (modes.applicationKeypadMode) out += '\x1b=';
    if (modes.originMode) out += '\x1b[?6h';
    if (!modes.wraparoundMode) out += '\x1b[?7l';
    if (modes.reverseWraparoundMode) out += '\x1b[?45h';
    if (modes.insertMode) out += '\x1b[4h';
    if (modes.bracketedPasteMode) out += '\x1b[?2004h';
    if (modes.sendFocusMode) out += '\x1b[?1004h';
    if (MOUSE_MODES[modes.mouseTrackingMode]) out += `\x1b[?${MOUSE_MODES[modes.mouseTrackingMode]}h`;
    return out;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.terminal.dispose();
  }
}

module.exports = { ScreenMirror };
