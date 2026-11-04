const { execFile } = require('node:child_process');
const { open } = require('node:fs/promises');
const { randomUUID, createHash } = require('node:crypto');
const { cpus, totalmem } = require('node:os');

const INTERVAL = 5000;
const MAX_PROCESSES = 10000;
const identity = p => `${p.pid}:${p.uid}:${p.started}`;
const signature = p => `${identity(p)}:${p.commandHash}`;

function runPs(args, maxBuffer = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    execFile('/bin/ps', args, { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      timeout: 2000, killSignal: 'SIGKILL', maxBuffer, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(new Error('Could not read processes within the time/size limit. Try again.'));
      else resolve(stdout);
    });
  });
}

function parseProcesses(text) {
  const rows = [], seen = new Set();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isFinite(+m[5])) continue;
    if (seen.has(pid)) throw new Error('Ambiguous process snapshot. Try again.');
    seen.add(pid);
    rows.push({ pid, ppid: +m[2], uid: +m[3], pgid: +m[4], cpu: +m[5], memory: +m[6] * 1024,
      elapsed: m[7], started: m[8].replace(/\s+/g, ' '),
      commandHash: createHash('sha256').update(m[9]).digest('hex'),
      command: m[9].replace(/((?:--?)?(?:api[_-]?key|token|password|secret|authorization)\s*[=:]\s*|--(?:api-key|token|password|secret)\s+)\S+/gi, '$1[redacted]').slice(0, 500) });
    if (rows.length > MAX_PROCESSES) throw new Error('Too many processes to display safely.');
  }
  if (!rows.length) throw new Error('No process information was available.');
  return rows;
}

async function collectProcesses() {
  return parseProcesses(await runPs(['-axww', '-o', 'pid=,ppid=,uid=,pgid=,pcpu=,rss=,etime=,lstart=,args=']));
}

// Read only the ownership tag; never return/store environment contents. At most
// eight unknown roots per snapshot, with negative caching as well as known owners.
async function readOwners(rows, platform) {
  const owners = new Map();
  const tag = text => {
    const ids = [...text.matchAll(/(?:^|[\s\0])CLIDECK_SESSION_ID=([a-zA-Z0-9_-]{1,200})(?=[\s\0]|$)/g)].map(m => m[1]);
    return new Set(ids).size === 1 ? ids[0] : null;
  };
  if (!rows.length) return owners;
  if (platform === 'darwin') {
    try {
      const text = await runPs(['eww', '-p', rows.map(p => p.pid).join(','), '-o', 'pid=,command='], 512 * 1024);
      for (const line of text.split('\n')) {
        const m = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (m) owners.set(+m[1], tag(m[2]));
      }
    } catch {} // Processes can exit, or OS privacy restrictions can hide their environment.
  } else {
    for (const p of rows) {
      let handle;
      try {
        handle = await open(`/proc/${p.pid}/environ`, 'r');
        const buffer = Buffer.alloc(64 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        owners.set(p.pid, tag(buffer.subarray(0, bytesRead).toString('utf8')));
      } catch {} finally { await handle?.close(); }
    }
  }
  return owners;
}

function protectedPids(rows, sessions, enginePid) {
  const byPid = new Map(rows.map(p => [p.pid, p])), protectedSet = new Set([1, enginePid]);
  for (const pid of [enginePid, ...sessions.map(s => s.pid).filter(Boolean)]) {
    let p = byPid.get(pid), visited = new Set();
    while (p && !visited.has(p.pid)) { visited.add(p.pid); protectedSet.add(p.pid); p = byPid.get(p.ppid); }
  }
  // Native CLIs can have a launcher plus a child executable (notably Codex).
  // Protect those as well as the PTY root, without protecting ordinary job shells.
  for (const s of sessions) if (s.pid) {
    for (const p of descendants(rows, s.pid)) {
      if (/^(?:\S*\/)?(?:node\s+)?(?:\S*\/)?(?:codex|claude|gemini|opencode|pi)(?:\s|$)/.test(p.command)) {
        let parent = p; const seen = new Set();
        while (parent && !seen.has(parent.pid)) { seen.add(parent.pid); protectedSet.add(parent.pid); parent = byPid.get(parent.ppid); }
      }
    }
  }
  return protectedSet;
}

function descendants(rows, pid) {
  const children = new Map();
  for (const p of rows) { if (!children.has(p.ppid)) children.set(p.ppid, []); children.get(p.ppid).push(p); }
  const root = rows.find(p => p.pid === pid), result = [], stack = root ? [root] : [], seen = new Set();
  while (stack.length) {
    const p = stack.pop(); if (seen.has(p.pid)) continue;
    seen.add(p.pid); result.push(p); stack.push(...(children.get(p.pid) || []));
  }
  return result.reverse(); // Children first, so terminating a shell doesn't abandon its known workers.
}

class TaskManager {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.uid = options.uid ?? process.getuid?.();
    this.enginePid = options.enginePid || process.pid;
    this.sessions = options.sessions || (() => []);
    this.collect = options.collect || collectProcesses;
    this.readOwners = options.readOwners || (rows => readOwners(rows, this.platform));
    this.signal = options.signal || ((pid, signal) => process.kill(pid, signal));
    this.now = options.now || Date.now;
    this.cache = null; this.until = 0; this.pending = null; this.stopping = false;
    this.owners = new Map(); this.targets = new Map(); this.stopAttempts = new Map();
  }

  snapshot() {
    if (this.pending) return this.pending;
    if (this.cache && this.now() < this.until) return Promise.resolve(this.cache);
    this.pending = this.scan().catch(error => ({ error: error.message, intervalMs: INTERVAL }))
      .then(result => { this.cache = result; this.until = this.now() + INTERVAL; return result; })
      .finally(() => { this.pending = null; });
    return this.pending;
  }

  async scan() {
    if (!['darwin', 'linux'].includes(this.platform)) throw new Error('Task Manager currently supports macOS and Linux engines.');
    const started = this.now(), rows = await this.collect(), sessions = this.sessions();
    const byPid = new Map(rows.map(p => [p.pid, p])), known = new Map(sessions.map(s => [s.id, s]));
    const ownership = new Map(), protectedSet = protectedPids(rows, sessions, this.enginePid);
    for (const s of sessions) if (byPid.has(s.pid)) ownership.set(s.pid, s.id);
    const roots = rows.filter(p => p.uid === this.uid && !protectedSet.has(p.pid)
      && (!byPid.has(p.ppid) || p.ppid === 1));
    const candidates = roots.filter(p => !this.owners.has(identity(p)) || this.owners.get(identity(p)).retryAt <= started)
      .sort((a, b) => b.cpu - a.cpu).slice(0, 8);
    const tags = await this.readOwners(candidates);
    for (const p of candidates) this.owners.set(identity(p), { id: tags.get(p.pid) || null, retryAt: started + 60000 });
    for (const p of rows) {
      const cached = this.owners.get(identity(p));
      if (!ownership.has(p.pid) && cached?.id && known.has(cached.id)) ownership.set(p.pid, cached.id);
    }
    const ownerFor = p => {
      const chain = [], seen = new Set(); let cur = p;
      while (cur && !ownership.has(cur.pid) && !seen.has(cur.pid)) { seen.add(cur.pid); chain.push(cur.pid); cur = byPid.get(cur.ppid); }
      const id = cur && ownership.get(cur.pid);
      if (id) for (const pid of chain) ownership.set(pid, id);
      return id || null;
    };
    const oldTargets = new Map([...this.targets.values()].map(p => [signature(p), p]));
    this.targets = new Map();
    const activeIdentities = new Set(rows.map(identity));
    const activeSignatures = new Set(rows.map(signature));
    for (const key of this.owners.keys()) if (!activeIdentities.has(key)) this.owners.delete(key);
    for (const key of this.stopAttempts.keys()) if (!activeSignatures.has(key)) this.stopAttempts.delete(key);
    const processes = rows.map(p => {
      const owner = known.get(ownerFor(p));
      if (owner) this.owners.set(identity(p), { id: owner.id, retryAt: Infinity });
      const token = oldTargets.get(signature(p))?.token || randomUUID();
      this.targets.set(token, { ...p, token, observedAt: started });
      const attempted = this.stopAttempts.get(signature(p));
      return { pid: p.pid, ppid: p.ppid, token, command: p.command, cpu: p.cpu, memory: p.memory,
        elapsed: p.elapsed, started: p.started, sessionId: owner?.id || null,
        session: owner?.name || (owner ? owner.id : ''), project: owner?.project || '',
        canStop: p.uid === this.uid && !protectedSet.has(p.pid),
        forceAllowed: attempted !== undefined && started - attempted >= 3000,
        stopping: attempted !== undefined };
    });
    return { processes, sampledAt: started, intervalMs: INTERVAL, scanMs: this.now() - started,
      cpuCount: cpus().length, totalMemory: totalmem(), platform: this.platform };
  }

  async stop(token, force = false) {
    if (this.stopping) throw new Error('Another stop request is in progress.');
    const target = this.targets.get(token);
    if (!target || this.now() - target.observedAt > 20000) throw new Error('Process information expired. Refresh and try again.');
    if (force && (this.stopAttempts.get(signature(target)) === undefined
      || this.now() - this.stopAttempts.get(signature(target)) < 3000)) throw new Error('Request a normal stop first, then wait for the next refresh.');
    this.stopping = true;
    try {
      // Never trust a client PID. Revalidate the displayed process and the whole
      // current tree, including protection of engine/agent ancestors, before signalling.
      const rows = await this.collect(), sessions = this.sessions();
      const root = rows.find(p => p.pid === target.pid);
      if (!root || signature(root) !== signature(target)) throw new Error('That process exited or changed. Refresh and try again.');
      const tree = descendants(rows, root.pid), protectedSet = protectedPids(rows, sessions, this.enginePid);
      if (tree.length > 512 || tree.some(p => p.uid !== this.uid || protectedSet.has(p.pid))) {
        throw new Error('This tree includes a protected process, another user, or too many processes to stop here.');
      }
      const verified = new Map((await this.collect()).map(p => [p.pid, p]));
      const protectedNow = protectedPids([...verified.values()], this.sessions(), this.enginePid);
      const expected = new Set(tree.map(p => p.pid));
      if (!verified.has(root.pid) || descendants([...verified.values()], root.pid).some(p => !expected.has(p.pid))
        || tree.some(p => verified.has(p.pid) && (signature(verified.get(p.pid)) !== signature(p) || protectedNow.has(p.pid)))) {
        throw new Error('The process tree changed. Refresh and try again.');
      }
      let signalled = 0, exited = 0; const failed = [];
      for (const p of tree) {
        if (!verified.has(p.pid)) { exited++; continue; }
        try { this.signal(p.pid, force ? 'SIGKILL' : 'SIGTERM'); signalled++; this.stopAttempts.set(signature(p), this.now()); }
        catch (error) { if (error.code === 'ESRCH') exited++; else failed.push(p.pid); }
      }
      this.until = 0;
      return { signalled, exited, failed, message: `${force ? 'Force stop' : 'Stop'} requested for ${signalled} process${signalled === 1 ? '' : 'es'}.${failed.length ? ` Could not stop PID ${failed.join(', ')}.` : ''}` };
    } finally { this.stopping = false; }
  }
}

module.exports = { TaskManager, parseProcesses, collectProcesses, readOwners, protectedPids, descendants };
