// The sessions this engine is running, kept on disk so the next engine can resume them if this one dies
// without shutting down (a crash, a kill). A clean shutdown removes the file; a planned restart has its own list
// (restart.js). `stable` records that this engine stayed up for a minute: one that crashes sooner is likely to
// crash again, so its sessions are not resumed automatically, which keeps a crash from repeating in a loop.
const { existsSync, readFileSync, renameSync, rmSync, writeFileSync } = require('fs');
const { join } = require('path');

const RUNNING_FILE = 'running-sessions.json';
const STABLE_AFTER_MS = 60_000;

class RunningSessions {
  constructor({ dataDir, stableAfterMs = STABLE_AFTER_MS, schedule = setTimeout, cancel = clearTimeout }) {
    this.file = join(dataDir, RUNNING_FILE);
    this.stableAfterMs = stableAfterMs;
    this.cancel = cancel;
    this.sessions = [];
    this.stable = false;
    this.stopped = false;
    this.timer = schedule(() => { this.stable = true; this.write(); }, stableAfterMs);
    this.timer?.unref?.();
  }

  update(ids) {
    if (this.stopped) return;
    this.sessions = [...new Set(ids)];
    this.write();
  }

  // A failed write (a full disk) only means a crash right now would resume an older list.
  write() {
    if (this.stopped) return;
    try {
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ sessions: this.sessions, stable: this.stable }), { mode: 0o600 });
      renameSync(`${this.file}.tmp`, this.file);
    } catch {
      rmSync(`${this.file}.tmp`, { force: true });
    }
  }

  // Clean shutdown: nothing to resume.
  clear() {
    this.stopped = true;
    this.cancel(this.timer);
    rmSync(this.file, { force: true });
  }
}

// What the previous engine left running, read once and removed. `null` when it shut down cleanly.
function takeRunningSessions(dataDir) {
  const file = join(dataDir, RUNNING_FILE);
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return {
      sessions: Array.isArray(value?.sessions) ? value.sessions.filter((id) => typeof id === 'string' && id) : [],
      stable: value?.stable === true,
    };
  } catch {
    return { sessions: [], stable: false };
  } finally {
    rmSync(file, { force: true });
  }
}

module.exports = { RUNNING_FILE, RunningSessions, STABLE_AFTER_MS, takeRunningSessions };
