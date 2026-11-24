'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { AskMetrics } = require('../src/ask-metrics');

function fakeRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.writableFinished = false;
  res.end = function (chunk) { this.writableFinished = true; this.emit('close'); };
  return res;
}
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askm-'));
  return { dir, m: new AskMetrics({ dataDir: dir }) };
}
const lines = (m) => fs.readFileSync(m.file, 'utf8').trim().split('\n').map(JSON.parse);

test('records a refusal with its error code', () => {
  const { m } = setup();
  const res = fakeRes();
  m.observe(res);
  m.note(res, { target: 'a/b', steer: false, from: 's1', fromName: 'Reviewer', text: 'hello', targetState: { status: null, sessionStarted: false } });
  res.statusCode = 409;
  res.end(JSON.stringify({ ok: false, error: 'busy' }));
  const [e] = lines(m);
  assert.equal(e.outcome, 'busy');
  assert.equal(e.ok, false);
  assert.equal(e.target, 'a/b');
  assert.equal(e.mode, 'ask');
  assert.equal(e.fromName, 'Reviewer');
  assert.equal(e.chars, 5);
  assert.deepEqual(e.targetState, { status: null, sessionStarted: false });
});

test('records a client that disconnects before the response', () => {
  const { m } = setup();
  const res = fakeRes();
  m.observe(res);
  res.emit('close');
  const [e] = lines(m);
  assert.equal(e.clientGone, true);
  assert.equal(e.outcome, 'client_gone');
});

test('never throws or alters the response when the log is unwritable', () => {
  const m = new AskMetrics({ dataDir: '/nonexistent/dir' });
  const res = fakeRes();
  m.observe(res);
  assert.doesNotThrow(() => res.end(JSON.stringify({ ok: true, steered: true })));
  assert.equal(res.writableFinished, true);
});

test('flags a resend of the same text, including after a restart', () => {
  const { dir, m } = setup();
  const send = (metrics, text) => {
    const res = fakeRes();
    metrics.observe(res);
    metrics.note(res, { target: 'a/b', from: 's1', text });
    res.end(JSON.stringify({ ok: false, error: 'busy' }));
  };
  send(m, 'Please  review the PR');
  send(m, 'please review the pr');
  send(new AskMetrics({ dataDir: dir }), 'Please review the PR');
  send(m, 'something else');
  const [a, b, c, d] = lines(m);
  assert.equal(a.resendOf, undefined);
  assert.equal(b.resendOf, 1);
  assert.equal(c.resendOf, 2);
  assert.equal(typeof c.sinceLastMs, 'number');
  assert.equal(d.resendOf, undefined);
  assert.equal(a.preview, 'Please review the PR');
});
