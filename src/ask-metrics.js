'use strict';

// Append-only record of every /ask request and how it ended. Observer only:
// it never changes what the handler returns, and every entry point swallows
// its own errors so a metrics failure cannot affect message delivery.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE_NAME = 'ask-metrics.jsonl';
const MAX_BYTES = 5 * 1024 * 1024;
const PREVIEW_CHARS = 120;

function normalize(text) {
  return String(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

function hashText(text) {
  return crypto.createHash('sha256').update(normalize(text)).digest('hex').slice(0, 12);
}

class AskMetrics {
  constructor({ dataDir }) {
    this.file = path.join(dataDir, FILE_NAME);
    // Last send per sender+target+content, so a resend can be flagged. Seeded from the log so restarts don't forget.
    this.seen = new Map();
    try {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!line) continue;
        const e = JSON.parse(line);
        if (e.hash) this.noteSeen(e.from, e.target, e.hash, Date.parse(e.ts));
      }
    } catch { /* no history yet */ }
  }

  noteSeen(from, target, hash, at) {
    const key = `${from}|${target}|${hash}`;
    const prev = this.seen.get(key);
    this.seen.set(key, { at, count: (prev?.count || 0) + 1 });
    return prev;
  }

  // Attach to a response. Captures status and body as they are sent, plus
  // whether the client went away before the response finished.
  observe(res) {
    try {
      const meta = { startedAt: Date.now() };
      res.askMeta = meta;
      const end = res.end;
      res.end = function (chunk, ...rest) {
        try {
          meta.status = res.statusCode;
          if (typeof chunk === 'string') meta.body = JSON.parse(chunk);
        } catch { /* ignore */ }
        return end.call(this, chunk, ...rest);
      };
      res.once('close', () => this.record(meta, res.writableFinished));
    } catch { /* never affect the request */ }
  }

  note(res, fields) {
    try {
      if (!res.askMeta) return;
      const { text, ...rest } = fields;
      Object.assign(res.askMeta, rest);
      if (typeof text === 'string') {
        res.askMeta.chars = text.length;
        res.askMeta.hash = hashText(text);
        res.askMeta.preview = text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS);
      }
    } catch { /* ignore */ }
  }

  record(meta, finished) {
    try {
      const body = meta.body || {};
      const entry = {
        ts: new Date(meta.startedAt).toISOString(),
        ms: Date.now() - meta.startedAt,
        mode: meta.steer ? 'steer' : 'ask',
        from: meta.from || null,
        fromName: meta.fromName || null,
        target: meta.target || null,
        chars: meta.chars ?? null,
        targetState: meta.targetState || null,
        hash: meta.hash || null,
        preview: meta.preview || null,
        status: meta.status ?? null,
        ok: body.ok === true,
        outcome: body.ok === true ? (body.steered ? 'steered' : 'replied') : (body.error || (finished ? 'unknown' : 'client_gone')),
        clientGone: !finished,
      };
      if (entry.hash) {
        const prev = this.noteSeen(entry.from, entry.target, entry.hash, meta.startedAt);
        if (prev) {
          entry.resendOf = prev.count; // how many earlier identical sends
          entry.sinceLastMs = meta.startedAt - prev.at;
        }
      }
      this.append(entry);
    } catch { /* ignore */ }
  }

  append(entry) {
    try {
      try {
        if (fs.statSync(this.file).size > MAX_BYTES) fs.renameSync(this.file, `${this.file}.1`);
      } catch { /* no file yet */ }
      fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch { /* ignore */ }
  }
}

module.exports = { AskMetrics, FILE_NAME, hashText };
