const { closeSync, existsSync, fstatSync, openSync, readSync, watch } = require('fs');

const WATCH_DEBOUNCE_MS = 250;
const APPEAR_POLL_MS = 1000;
const MAX_READ_BYTES = 1024 * 1024;

// Claude Code's /rename appends {"type":"custom-title","customTitle":...} to the session transcript.
function titleFromLine(line) {
  if (!line.includes('"custom-title"')) return null;
  try {
    const entry = JSON.parse(line);
    return entry?.type === 'custom-title' && typeof entry.customTitle === 'string' ? entry.customTitle : null;
  } catch {
    return null;
  }
}

function fileSize(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    return fstatSync(fd).size;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Follows the transcript from its current end, so titles set before CliDeck attached are ignored.
// A new session's transcript does not exist yet when its SessionStart hook names it: Claude creates it with
// the first thing it writes, which can be the /rename itself. Until then this checks for it every second
// (its folder may not exist yet either), and then reads it from the start.
function watchClaudeTitle(path, onTitle, options = {}) {
  if (!path || typeof onTitle !== 'function') return () => {};
  const watchFile = options.watch || watch;
  const exists = options.exists || existsSync;
  const debounceMs = Number(options.debounceMs ?? WATCH_DEBOUNCE_MS);
  const pollMs = Number(options.pollMs ?? APPEAR_POLL_MS);
  let offset = fileSize(path);
  let partial = '';
  let timer = null;
  let watcher = null;
  let poller = null;
  let stopped = false;

  const read = () => {
    if (stopped) return;
    let fd;
    try {
      fd = openSync(path, 'r');
      const size = fstatSync(fd).size;
      if (size < offset) { offset = size; partial = ''; return; }
      if (size === offset) return;
      const start = Math.max(offset, size - MAX_READ_BYTES);
      const buffer = Buffer.alloc(size - start);
      readSync(fd, buffer, 0, buffer.length, start);
      if (start > offset) partial = '';
      offset = size;
      const lines = (partial + buffer.toString('utf8')).split('\n');
      partial = lines.pop();
      let title = null;
      for (const line of lines) title = titleFromLine(line) ?? title;
      if (title !== null) onTitle(title);
    } catch {
      // The transcript can be rotated or removed; the next event or reattach recovers.
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(read, debounceMs);
    timer.unref?.();
  };
  const follow = () => {
    try {
      watcher = watchFile(path, { persistent: false }, schedule);
      watcher.on?.('error', () => {});
    } catch {}
  };
  if (exists(path)) follow();
  else {
    poller = setInterval(() => {
      if (stopped || !exists(path)) return;
      clearInterval(poller);
      poller = null;
      follow();
      read();
    }, pollMs);
    poller.unref?.();
  }
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(poller);
    try { watcher?.close(); } catch {}
  };
}

module.exports = { titleFromLine, watchClaudeTitle };
