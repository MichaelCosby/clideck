// Restarts the engine onto the code now on disk (e.g. after an update), optionally waiting until every agent
// is idle, and resumes the sessions that were running once the new engine is up.
const { existsSync, readFileSync, renameSync, rmSync, writeFileSync } = require('fs');
const { join } = require('path');

const IDLE_STABLE_MS = 10_000;
const POLL_MS = 1000;
const RESUME_FILE = 'restart-resume.json';

class RestartCoordinator {
  constructor({ server, dataDir, isBusy, exec, now = Date.now, schedule = setInterval, cancel = clearInterval,
    stableMs = IDLE_STABLE_MS, onChange = () => {} }) {
    this.server = server;
    this.dataDir = dataDir;
    this.isBusy = isBusy;
    this.exec = exec;
    this.now = now;
    this.schedule = schedule;
    this.cancelTimer = cancel;
    this.stableMs = stableMs;
    this.onChange = onChange;
    this.state = 'idle';
    this.busy = [];
    this.idleSince = null;
    this.timer = null;
  }

  snapshot() {
    return { type: 'engine.restart', state: this.state, busy: this.busy.slice(), canRestart: Boolean(this.exec) };
  }

  publish() { this.onChange(this.snapshot()); return this.snapshot(); }

  liveSessions() {
    return [...this.server.sessions.values()].filter((session) => !session.closed);
  }

  busySessions() {
    return this.liveSessions().filter((session) => this.isBusy(session)).map((session) => session.name || session.id.slice(0, 8));
  }

  request({ whenIdle }) {
    if (!this.exec || this.state === 'restarting') return this.snapshot();
    if (!whenIdle) return this.restart();
    if (this.state === 'waiting') return this.snapshot();
    this.state = 'waiting';
    this.idleSince = null;
    this.timer = this.schedule(() => this.tick(), POLL_MS);
    this.timer?.unref?.();
    this.tick();
    return this.snapshot();
  }

  cancel() {
    if (this.state !== 'waiting') return this.snapshot();
    this.cancelTimer(this.timer);
    this.timer = null;
    this.state = 'idle';
    this.busy = [];
    return this.publish();
  }

  // Restart only after every agent has stayed idle for a while, so one finishing as another starts doesn't count.
  tick() {
    if (this.state !== 'waiting') return;
    const busy = this.busySessions();
    const changed = busy.join('\n') !== this.busy.join('\n');
    this.busy = busy;
    if (busy.length) this.idleSince = null;
    else if (this.idleSince === null) this.idleSince = this.now();
    if (!busy.length && this.now() - this.idleSince >= this.stableMs) { void this.restart(); return; }
    if (changed) this.publish();
  }

  async restart() {
    this.cancelTimer(this.timer);
    this.timer = null;
    this.state = 'restarting';
    this.busy = [];
    this.publish();
    const resume = this.liveSessions().map((session) => session.id);
    const file = join(this.dataDir, RESUME_FILE);
    writeFileSync(`${file}.tmp`, JSON.stringify({ sessions: resume, at: new Date(this.now()).toISOString() }), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    await this.server.close();
    this.exec();
    return this.snapshot();
  }
}

// The sessions a restart left running, read once: the file is removed so a later crash can't resume them again.
function takeResumeList(dataDir) {
  const file = join(dataDir, RESUME_FILE);
  if (!existsSync(file)) return [];
  try {
    const { sessions } = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(sessions) ? sessions.filter((id) => typeof id === 'string' && id) : [];
  } catch {
    return [];
  } finally {
    rmSync(file, { force: true });
  }
}

// Same process, same terminal and PID: replace this engine with a fresh one running the code now on disk.
function reexec(runtime = process) {
  if (typeof runtime.execve !== 'function') return null;
  return () => runtime.execve(runtime.execPath, [runtime.execPath, ...runtime.execArgv, ...runtime.argv.slice(1)], runtime.env);
}

module.exports = { IDLE_STABLE_MS, RESUME_FILE, RestartCoordinator, reexec, takeResumeList };
