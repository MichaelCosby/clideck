// Per-session read-aloud browser proof. Isolated engine; a COPY of the Supertonic plugin whose client.js is
// replaced by a fake synthesiser (tiny silent WAV, no model download). Sessions are real AgentSession objects
// with fake terminals (no native start, no PTY). Finished replies are broadcast directly. No live actions.
const { mkdtempSync, writeFileSync, readFileSync, existsSync, cpSync, mkdirSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { HeadlessServer } = require('../../src/server.js');
const { AgentSession } = require('../../src/session');
const { getProvider } = require('../../src/providers');
const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0, passes = 0;
const check = (name, yes, detail) => { yes ? passes++ : fails++; console.log(`${yes ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };

// Fake client: same messages as the real one (speak{source:auto,token} / speak-cancel), plays a silent WAV
// tagged with autoToken, and reports deferred/finished/failed through the REAL plugin server relay. "[synth:N]"
// delays synthesis; "[ignore-cancel]" plays anyway (proves the HOST guard); "[fail-once]"/"[defer-once]" report
// that status on the first attempt only.
const FAKE_CLIENT = `
let current = '';
const seen = new Set();
function wav(seconds) {
  const rate = 8000, n = Math.round(rate * seconds), buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const s = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  s(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); s(8, 'WAVE'); s(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  s(36, 'data'); v.setUint32(40, n * 2, true); return buf;
}
export async function activate(api) {
  api.onMessage('speak', async (value) => {
    if (value?.source !== 'auto' || !value.token) return;
    current = value.token;
    const delay = /\\[synth:(\\d+)\\]/.exec(value.text);
    await new Promise(r => setTimeout(r, delay ? Number(delay[1]) : 30));
    if (current !== value.token && !/\\[ignore-cancel\\]/.test(value.text)) return;
    const once = (tag) => value.text.includes(tag) && !seen.has(tag + value.text) && !!seen.add(tag + value.text);
    if (once('[fail-once]')) return api.send('auto-read-result', { token: value.token, status: 'failed' });
    if (once('[defer-once]')) return api.send('auto-read-result', { token: value.token, status: 'deferred' });
    let played = false;
    try { played = await api.playAudioAndWait(wav(0.3), { mime: 'audio/wav', title: 'Fake: ' + value.text, autoToken: value.token }); } catch {}
    api.stopAudio();
    if (current === value.token) api.send('auto-read-result', { token: value.token, status: played ? 'finished' : 'failed' });
  });
  api.onMessage('speak-cancel', (value) => { if (value?.token === current) current = ''; });
  api.onMessage('manual', (value) => api.playAudio(wav(value?.seconds || 1), { mime: 'audio/wav', title: 'Fake manual' }));
}
`;

(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'read-aloud-data-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ onboarding: { completed: true, seenTips: ['guided-tour', 'about-me'] } }));
  const bundled = mkdtempSync(join(tmpdir(), 'read-aloud-plugins-'));
  const pluginDir = join(bundled, 'supertonic'); mkdirSync(pluginDir);
  for (const file of ['clideck-plugin.json', 'server.js']) cpSync(join(__dirname, '../../plugins/supertonic', file), join(pluginDir, file));
  writeFileSync(join(pluginDir, 'client.js'), FAKE_CLIENT);
  const server = new HeadlessServer({ port: 0, dataDir, bundledPluginsDir: bundled });
  const agents = {};
  for (const name of ['Alpha', 'Beta']) {
    const agent = new AgentSession({ provider: getProvider('claude-code'), name, cwd: dataDir });
    agent.terminal = { pid: name === 'Alpha' ? 4101 : 4102, write: () => {}, resize: () => {}, kill: () => agent.handleExit(0, null) };
    agent.status = 'idle'; server.sessions.set(agent.id, agent); server.persistence.register(agent); agents[name] = agent;
  }
  const A = agents.Alpha.id, B = agents.Beta.id;
  const final = (id, text) => server.broadcast({ type: 'agent.final', sessionId: id, text, at: new Date().toISOString() });
  let chrome, cws;
  try {
    const address = await server.listen(), base = `http://127.0.0.1:${address.port}`;
    const profile = mkdtempSync(join(tmpdir(), 'read-aloud-chrome-'));
    chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--autoplay-policy=no-user-gesture-required', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
    const portFile = join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
    const port = readFileSync(portFile, 'utf8').split('\n')[0];
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    cws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(r => cws.on('open', r));
    let seq = 0; const pending = new Map(), errors = [];
    cws.on('message', raw => { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    const cmd = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; const t = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')); }, 12000); pending.set(id, m => { clearTimeout(t); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }); cws.send(JSON.stringify({ id, method, params })); });
    const js = async expression => { const r = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value; };
    await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await cmd('Runtime.enable'); await cmd('Page.enable');
    // Every audio start is logged with the player's title (which reply) and the channel owner (auto token/manual).
    await cmd('Page.addScriptToEvaluateOnNewDocument', { source: `window.played=[];import('/js/ui/plugin-audio.js').then(m=>{window.__pa=m});const play=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(){played.push({title:document.querySelector('.plugin-audio-copy strong')?.textContent||'',owner:window.__pa?.audioOwner()||''});return play.call(this)};` });
    const load = async () => { await cmd('Page.navigate', { url: base }); await sleep(2500); await js(`(async()=>{window.store=(await import('/js/store.js')).store;window.ra=await import('/js/ui/read-aloud.js');window.host=await import('/js/ui/plugin-host.js')})()`); };
    await load();
    const select = async id => { await js(`store.select(${JSON.stringify(id)})`); await sleep(150); };
    const plays = () => js('played.splice(0)');
    const titles = async () => (await plays()).map(p => p.title.replace('Fake: ', ''));
    const pressed = () => js(`document.getElementById('voice-say').getAttribute('aria-pressed')`);

    check('Supertonic (fake client) is ready', await js(`store.plugins.find(p=>p.id==='supertonic')?.status==='ready'`));
    await select(A);
    check('read-aloud starts off for every session', await pressed() === 'false' && await js(`[...store.sessions.values()].every(s=>s.readAloud===false)`));
    await js(`document.getElementById('voice-say').click()`); await sleep(300);
    check('header toggle turns on the ACTIVE session only (engine round-trip)', await pressed() === 'true' && await js(`store.sessions.get(${JSON.stringify(A)}).readAloud===true&&store.sessions.get(${JSON.stringify(B)}).readAloud===false`) && server.persistence.get(A).readAloud === true);
    await snapOn();

    final(A, 'reply A1'); await sleep(900);
    let p = await plays();
    check('active session: a finished reply is read automatically, tagged as auto', p.length === 1 && p[0].title === 'Fake: reply A1' && /^auto-/.test(p[0].owner), p);

    await select(B); final(A, 'reply A2'); final(B, 'reply B0'); await sleep(700);
    { const pl = await plays(), st = await js(`JSON.stringify(ra.__readAloudStateForTest())`);
      check('reply finished in a background session waits; an off session is ignored', pl.length === 0 && JSON.stringify(JSON.parse(st).pending) === JSON.stringify({ [A]: 'reply A2' }), { pl, st }); }
    await select(A); await sleep(800);
    check('opening that session reads its newest waiting reply', JSON.stringify(await titles()) === '["reply A2"]');

    final(A, 'old A'); final(A, 'newest A'); await sleep(900);
    check('newer reply supersedes the one being read (latest wins)', (await titles()).at(-1) === 'newest A');

    await select(B); await js(`document.getElementById('voice-say').click()`); await sleep(300);
    check('B toggles independently', await pressed() === 'true' && await js(`store.sessions.get(${JSON.stringify(A)}).readAloud===true`));
    await select(A); final(B, 'reply B1'); await sleep(600);
    check('B reply waits while A is on screen', (await plays()).length === 0);
    await select(B); await sleep(800);
    check('B reply is read when B is opened', JSON.stringify(await titles()) === '["reply B1"]');

    await select(A); final(A, 'late focus [synth:800] [ignore-cancel]'); await sleep(200);
    await select(B); await sleep(1100);
    check('audio finished after the person moved away is refused by the host', (await plays()).length === 0 && await js(`ra.__readAloudStateForTest().pending[${JSON.stringify(A)}]`) === 'late focus [synth:800] [ignore-cancel]');
    await select(A); await sleep(1600);
    check('that unheard reply plays when the session is opened again', (await titles()).includes('late focus [synth:800] [ignore-cancel]'));

    final(A, 'turned off [synth:800] [ignore-cancel]'); await sleep(200);
    await js(`document.getElementById('voice-say').click()`); await sleep(1100);
    check('turning the session off mid-synthesis refuses its audio and drops the reply', (await plays()).length === 0 && await pressed() === 'false' && !(await js(`ra.__readAloudStateForTest().pending[${JSON.stringify(A)}]`)));
    await select(B); await select(A); await sleep(400);
    check('nothing is read later for a session turned off', (await plays()).length === 0);
    await js(`document.getElementById('voice-say').click()`); await sleep(300);

    await js(`host.deliverPluginMessage('supertonic','manual',{seconds:1.2})`); await sleep(250);
    final(A, 'after manual'); await sleep(400);
    p = await plays();
    check('manual reading is not interrupted by an auto reply', p.length === 1 && p[0].title === 'Fake manual' && p[0].owner === 'manual' && await js(`__pa.audioOwner()`) === 'manual', p);
    await sleep(1600);
    check('the auto reply plays after the manual reading ends', JSON.stringify(await titles()) === '["after manual"]');

    await js(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'))`);
    final(A, 'while hidden'); await sleep(500);
    check('hidden tab never reads aloud', (await plays()).length === 0);
    await js(`Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'))`); await sleep(800);
    check('returning to the tab reads the waiting reply', JSON.stringify(await titles()) === '["while hidden"]');

    final(A, 'flaky [fail-once]'); await sleep(600);
    check('a failed attempt keeps the reply and marks the session', (await plays()).length === 0 && await js(`JSON.stringify(ra.__readAloudStateForTest())`) === JSON.stringify({ pending: { [A]: 'flaky [fail-once]' }, failed: [A], job: null }));
    await js(`host.deliverPluginMessage('supertonic','manual',{seconds:0.2})`); await sleep(700); await plays();
    check('routine idle/updates never retry a failed session (no loop)', await js(`ra.__readAloudStateForTest().failed.length`) === 1 && (await plays()).length === 0);
    await select(B); await select(A); await sleep(800);
    check('opening the session again retries it once and it plays', JSON.stringify(await titles()) === '["flaky [fail-once]"]' && await js(`ra.__readAloudStateForTest().failed.length`) === 0);

    final(A, 'busy [defer-once]'); await sleep(500);
    check('deferred (manual reading preparing) keeps the reply waiting', (await plays()).length === 0 && await js(`ra.__readAloudStateForTest().pending[${JSON.stringify(A)}]`) === 'busy [defer-once]');
    await js(`host.deliverPluginMessage('supertonic','manual',{seconds:0.2})`); await sleep(1100);
    check('it is read once the manual audio goes idle', JSON.stringify(await titles()) === '["Fake manual","busy [defer-once]"]');

    await js(`window.realPlay=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(){if(__pa.audioOwner().startsWith('auto-')){HTMLMediaElement.prototype.play=realPlay;return Promise.reject(new DOMException('blocked','NotAllowedError'))}return realPlay.call(this)}`);
    final(A, 'autoplay blocked'); await sleep(700);
    const toastText = await js(`document.getElementById('toast-read-aloud-blocked')?.textContent||''`);
    check('blocked autoplay: explicit "Read now" notice, reply kept, not counted as read', /blocked automatic audio/.test(toastText) && /Read now/.test(toastText) && await js(`ra.__readAloudStateForTest().pending[${JSON.stringify(A)}]`) === 'autoplay blocked' && !(await js(`ra.__readAloudStateForTest().job`)), toastText);
    await sleep(600);
    check('no automatic retry loop after a blocked play', (await js(`ra.__readAloudStateForTest().job`)) === null && (await js(`ra.__readAloudStateForTest().pending[${JSON.stringify(A)}]`)) === 'autoplay blocked');
    await plays();
    await js(`document.querySelector('#toast-read-aloud-blocked .toast-act').click()`); await sleep(900);
    check('"Read now" plays the waiting reply', (await titles()).includes('autoplay blocked'));

    final(A, 'reconnect [synth:800] [ignore-cancel]'); await sleep(200);
    for (const client of server.clients) client.terminate();
    await sleep(3500);
    const afterReconnect = await titles();
    check('reconnect is treated like a refresh: in-flight reply dropped, stale audio refused, nothing waiting', afterReconnect.length === 0 && await js(`JSON.stringify(ra.__readAloudStateForTest())`) === JSON.stringify({ pending: {}, failed: [], job: null }), afterReconnect);
    await select(A);

    check('header wording is per-session', await js(`document.getElementById('voice-say').title`) === 'Reading this session’s replies aloud — click to turn off' && await js(`document.getElementById('voice-say').getAttribute('aria-label')`) === 'Read this session’s replies aloud');

    // Default playback speed (main's manifest key) saves from the real Settings select and survives reload.
    const rateSetting = await js(`JSON.stringify(store.plugins.find(p=>p.id==='supertonic')?.settings?.find(d=>d.key==='playback-rate')||null)`);
    const speedSelect = `[...document.querySelectorAll('.plg-select')].find(s=>[...s.options].map(o=>o.value).join()==='1,1.1,1.25,1.5')`;
    if (rateSetting === 'null') console.log('SKIP default playback speed setting not in manifest yet');
    else {
      await js(`import('/js/ui/settings.js').then(m=>m.openPluginSettings('supertonic'))`); await sleep(500);
      await js(`(()=>{const s=${speedSelect};s.value='1.25';s.dispatchEvent(new Event('change',{bubbles:true}))})()`); await sleep(500);
      check('Settings saves the default playback speed', await js(`String(store.plugins.find(p=>p.id==='supertonic').values['playback-rate'])`) === '1.25');
    }

    await load(); await select(A);
    if (rateSetting !== 'null') {
      await js(`import('/js/ui/settings.js').then(m=>m.openPluginSettings('supertonic'))`); await sleep(500);
      check('the default playback speed is still selected after reload', await js(`${speedSelect}?.value`) === '1.25');
      await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`); await sleep(200);
    }
    check('per-session choice persists across reload (A on, B on)', await pressed() === 'true' && await js(`store.sessions.get(${JSON.stringify(A)}).readAloud===true&&store.sessions.get(${JSON.stringify(B)}).readAloud===true`));
    check('reload replays no finished replies (nothing read)', (await plays()).length === 0);
    check('engine never dropped the browser connection', server.clients.size === 1);
    check('no uncaught browser exceptions', errors.length === 0, errors);
    async function snapOn() { const s = await cmd('Page.captureScreenshot', { format: 'png', clip: { x: 900, y: 0, width: 380, height: 60, scale: 2 } }); mkdirSync('/tmp/clideck-read-aloud-ui', { recursive: true }); writeFileSync('/tmp/clideck-read-aloud-ui/header-on.png', Buffer.from(s.data, 'base64')); }
  } finally {
    for (const agent of Object.values(agents)) if (!agent.closed) agent.handleExit(0, null);
    cws?.close(); if (chrome) { chrome.kill(); await new Promise(r => chrome.exitCode !== null ? r() : chrome.once('exit', r)); } await server.close();
    console.log(`${passes} passed, ${fails} failed`); process.exitCode = fails ? 1 : 0;
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
