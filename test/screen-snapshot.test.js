const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const WebSocket = require('ws');
const { Terminal } = require('@xterm/headless');
const { ScreenMirror } = require('../src/screen-mirror');
const { SessionPersistence } = require('../src/persistence');
const { HeadlessServer } = require('../src/server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const render = (data, cols = 80, rows = 24) => new Promise((resolve) => {
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  term.write(data, () => {
    const b = term.buffer.active;
    const lines = [];
    for (let i = 0; i < rows; i++) lines.push(b.getLine(b.viewportY + i).translateToString(true));
    resolve({ type: b.type, lines, modes: term.modes });
    term.dispose();
  });
});
const snapshot = (mirror) => new Promise((resolve) => mirror.snapshot(resolve));

test('the mirror serializes a full-screen app and stays quiet on the normal screen', async () => {
  const mirror = new ScreenMirror(80, 24);
  mirror.write('$ some shell output\r\n');
  assert.deepEqual(await snapshot(mirror), { alternate: false, data: '' });
  const drawing = '\x1b[?1049h\x1b[2J\x1b[H\x1b[1;32mheader\x1b[0m' + Array.from({ length: 500 }, (_, i) => `\x1b[10;1Hcount ${i}\x1b[K`).join('');
  mirror.write(drawing);
  const shot = await snapshot(mirror);
  assert.equal(shot.alternate, true);
  assert.ok(shot.data.length < drawing.length / 5, `${shot.data.length} vs ${drawing.length}`);
  assert.deepEqual((await render(shot.data)).lines, (await render('$ some shell output\r\n' + drawing)).lines);
  mirror.resize(40, 10);
  mirror.write('\x1b[2J\x1b[Hnarrow');
  assert.match((await render((await snapshot(mirror)).data, 40, 10)).lines[0], /^narrow/);
  mirror.dispose();
  assert.equal(await snapshot(mirror), null);
});

test('a resize lands between the output drawn before and after it, even while parsing lags behind', async () => {
  const before = '\x1b[?1049h\x1b[2J\x1b[H' + 'wide line '.repeat(12) + Array.from({ length: 3000 }, (_, i) => `\x1b[5;1Hold ${i}`).join('');
  const after = '\x1b[2J\x1b[Hnarrow repaint\x1b[3;1H' + 'x'.repeat(50);
  const mirror = new ScreenMirror(120, 30);
  mirror.write(before);
  mirror.resize(40, 10);   // straight away, with most of `before` not parsed yet
  mirror.write(after);
  const expected = await new Promise((resolve) => {
    const term = new Terminal({ cols: 120, rows: 30, allowProposedApi: true });
    term.write(before, () => { term.resize(40, 10); term.write(after, () => {
      const b = term.buffer.active, lines = [];
      for (let i = 0; i < 10; i++) lines.push(b.getLine(i).translateToString(true));
      resolve(lines);
    }); });
  });
  assert.deepEqual((await render((await snapshot(mirror)).data, 40, 10)).lines, expected);
  mirror.dispose();
});

test('the drawn screen keeps every character and style', async () => {
  const drawing = '\x1b[?1049h\x1b[2J\x1b[H'
    + '\x1b[1;31mbold red\x1b[0m \x1b[3;4;92mitalic underline bright\x1b[0m \x1b[7minverse\x1b[0m \x1b[2;9mdim strike\x1b[0m'
    + '\x1b[2;1H\x1b[38;5;208m256-orange\x1b[0m \x1b[38;2;10;200;30;48;2;40;40;40mrgb on rgb\x1b[0m \x1b[44m   \x1b[0m<- blue blanks'
    + '\x1b[3;1Hwide: 中文 and 😀 end\x1b[4;80Hlast column\x1b[24;1H\x1b[30;47m status bar \x1b[K\x1b[0m\x1b[10;5H';
  const mirror = new ScreenMirror(80, 24);
  mirror.write(drawing);
  const shot = await snapshot(mirror);
  const cells = (term) => {
    const b = term.buffer.active, out = [];
    let cell = b.getNullCell();
    for (let y = 0; y < term.rows; y++) {
      const line = b.getLine(b.viewportY + y);
      for (let x = 0; x < term.cols; x++) {
        cell = line.getCell(x, cell);
        out.push([cell.getChars(), cell.getWidth(), cell.getFgColorMode(), cell.getFgColor(), cell.getBgColorMode(), cell.getBgColor(),
          cell.isBold(), cell.isDim(), cell.isItalic(), cell.isUnderline(), cell.isInverse(), cell.isStrikethrough()].join('|'));
      }
    }
    return out;
  };
  const copy = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  await new Promise((resolve) => copy.write(shot.data, resolve));
  const want = cells(mirror.terminal), got = cells(copy);
  const differing = want.map((c, i) => (c === got[i] ? null : `${Math.floor(i / 80)},${i % 80}: ${c} != ${got[i]}`)).filter(Boolean);
  assert.deepEqual(differing, []);
  assert.deepEqual([copy.buffer.active.cursorY, copy.buffer.active.cursorX], [9, 4]);
  copy.dispose();
  mirror.dispose();
});

test('current modes follow new output without rescanning, including a sequence split across writes', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-modes-'));
  const persistence = new SessionPersistence({ dataDir, debounceMs: 0, historyLimit: 256 });
  t.after(() => { persistence.close(); rmSync(dataDir, { recursive: true, force: true }); });
  persistence.register({ id: 's1', provider: { id: 'shell' }, name: 's1', cwd: '/', cols: 80, rows: 24 });
  persistence.appendHistory('s1', '\x1b[?2004h');
  assert.deepEqual(persistence.currentModes('s1'), { 2004: true });
  persistence.appendHistory('s1', 'text\x1b[?10');
  assert.deepEqual(persistence.currentModes('s1'), { 2004: true });
  persistence.appendHistory('s1', '49h\x1b[?1006h');
  assert.deepEqual(persistence.currentModes('s1'), { 2004: true, 1049: true, 1006: true });
  persistence.appendHistory('s1', 'x'.repeat(400) + '\x1b[?2004l');   // trims past everything scanned so far
  assert.deepEqual(persistence.currentModes('s1'), { 2004: false, 1049: true, 1006: true });
});

test('the engine answers a full-screen session with its screen, exactly in step with live output', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-snapshot-'));
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  t.after(async () => { await server.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const { url } = await server.listen();
  const session = server.createSession({ provider: 'shell', cwd: dataDir, name: 'Full', cols: 80, rows: 24 });
  for (let i = 0; i < 200 && !server.persistence.historyTail(session.id); i++) await sleep(25);
  // A full-screen app with mouse reporting that keeps patching one line, then prints DONE.
  session.writeInput("printf '\\033[?1049h\\033[?1000h\\033[?1006h\\033[2J\\033[Htop line'; for i in $(seq 1 60000); do printf '\\033[12;1Hcount %d\\033[K' $i; done; printf '\\033[20;1HDONE'\r");
  for (let i = 0; i < 200 && !/count 5\d\d\d\b/.test(server.persistence.historyTail(session.id)); i++) await sleep(10);

  const socket = new WebSocket(url + '/?history=lazy');
  const events = [];
  socket.on('message', (raw) => events.push(JSON.parse(raw)));
  await new Promise((resolve) => socket.once('open', resolve));
  t.after(() => socket.close());
  socket.send(JSON.stringify({ type: 'session.history', sessionId: session.id, requestId: 'snap' }));
  for (let i = 0; i < 400 && !server.persistence.historyTail(session.id).includes('DONE'); i++) await sleep(25);
  await sleep(300);

  const index = events.findIndex((e) => e.requestId === 'snap');
  assert.ok(index >= 0, 'got a reply');
  const reply = events[index];
  const raw = server.persistence.historyTail(session.id);
  assert.ok(reply.data.length < raw.length / 10, `snapshot ${reply.data.length} vs raw ${raw.length}`);
  assert.match(reply.data, /\x1b\[\?1006h/, 'the SGR mouse encoding is restored');
  const after = events.slice(index + 1).filter((e) => e.type === 'output' && e.sessionId === session.id).map((e) => e.data).join('');
  assert.ok(after.length > 0, 'the request landed while the app was still drawing');
  assert.equal(events.slice(0, index).some((e) => e.type === 'output' && e.sessionId === session.id), false,
    'no output for the session reached this browser before its reply');
  const viaSnapshot = await render(reply.data + after);
  const viaRaw = await render(raw);
  assert.equal(viaSnapshot.type, 'alternate');
  assert.deepEqual(viaSnapshot.lines, viaRaw.lines);
  assert.match(viaSnapshot.lines[19], /^DONE/);
  assert.equal(viaSnapshot.modes.mouseTrackingMode, viaRaw.modes.mouseTrackingMode);
});

test('a normal-screen session still gets its saved output', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-snapshot-normal-'));
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  t.after(async () => { await server.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const { url } = await server.listen();
  const session = server.createSession({ provider: 'shell', cwd: dataDir, name: 'Shell' });
  session.writeInput('echo plain-output\r');
  for (let i = 0; i < 200 && !/[\r\n]plain-output/.test(server.persistence.historyTail(session.id)); i++) await sleep(25);
  const socket = new WebSocket(url + '/?history=lazy');
  const events = [];
  socket.on('message', (raw) => events.push(JSON.parse(raw)));
  await new Promise((resolve) => socket.once('open', resolve));
  t.after(() => socket.close());
  socket.send(JSON.stringify({ type: 'session.history', sessionId: session.id, requestId: 'n1' }));
  for (let i = 0; i < 50 && !events.some((e) => e.requestId === 'n1'); i++) await sleep(20);
  assert.equal(events.find((e) => e.requestId === 'n1').data, server.persistence.historyTail(session.id));
});
