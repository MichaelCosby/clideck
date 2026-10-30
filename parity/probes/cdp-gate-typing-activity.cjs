// Typing guard browser proof: real xterm + real trusted key/IME events. Isolated engine only. Synthetic-session
// frames are captured in the page and never sent; the end-to-end fixture forwards over the real WebSocket to a
// real AgentSession whose terminal is a fake recorder (no native start, no PTY). No live sessions or agents.
const { mkdtempSync, writeFileSync, readFileSync, existsSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { HeadlessServer } = require('../../src/server.js');
const WebSocket = require('ws');
const { AgentSession } = require('../../src/session');
const { getProvider } = require('../../src/providers');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0, passes = 0;
const check = (name, yes, detail) => { yes ? passes++ : fails++; console.log(`${yes ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };
(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'typing-activity-data-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ onboarding: { completed: true, seenTips: ['guided-tour', 'about-me'] } }));
  const server = new HeadlessServer({ port: 0, dataDir });
  // End-to-end fixture: real session object + real server map/persistence, injected clock, fake terminal.
  let clock = Date.now(); const writes = [];
  const agent = new AgentSession({ provider: getProvider('claude-code'), name: 'E2E target', cwd: dataDir, now: () => clock, promptSubmitDelay: () => 600, submitRetryMs: 300 });
  agent.terminal = { pid: 4242, write: d => writes.push(d), resize: () => {}, kill: () => agent.handleExit(0, null) };
  agent.status = 'idle';
  server.sessions.set(agent.id, agent); server.persistence.register(agent);
  let chrome, cws;
  try {
    const address = await server.listen(), base = `http://127.0.0.1:${address.port}`;
    const profile = mkdtempSync(join(tmpdir(), 'typing-activity-chrome-'));
    chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
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
    await cmd('Runtime.enable'); await cmd('Page.enable'); await cmd('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cmd('Page.navigate', { url: base }); await sleep(2200);
    await js(`(async()=>{window.store=(await import('/js/store.js')).store;store.applyEvent({type:'session.created',sessionId:'typing',provider:'shell',live:true,pid:999999,cwd:'/tmp',name:'Typing probe'});store.select('typing');window.term=(await import('/js/ui/terminal.js')).__termForTest();window.sent=[];window.forwardId=null;const send=WebSocket.prototype.send;WebSocket.prototype.send=function(data){let m;try{m=JSON.parse(data)}catch{}if(m&&m.type==='input'&&m.sessionId!==forwardId){sent.push(m);return}return send.call(this,data)};})()`);
    await sleep(300);
    const frames = async () => js('sent.splice(0)');
    const focusTerm = () => js('term.focus()');
    const key = async (key, code, vk, extra = {}) => { await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, ...extra }); await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers: extra.modifiers }); await sleep(60); };
    const char = (c, code, vk, modifiers) => key(c, code, vk, { text: c, unmodifiedText: c, modifiers });
    const act = m => m.data === '' && m.userActivity === true && m.sessionId === 'typing';

    await focusTerm(); await frames();
    await char('a', 'KeyA', 65);
    let f = await frames();
    check('real keystroke: activity frame first, then unmarked data', f.length === 2 && act(f[0]) && f[1].data === 'a' && !('userActivity' in f[1]), f);
    await key('Backspace', 'Backspace', 8); await key('ArrowUp', 'ArrowUp', 38); await key('Enter', 'Enter', 13, { text: '\r' });
    f = await frames();
    check('Backspace, history Up and Enter each report activity; their data stays raw', f.filter(act).length === 3 && f.filter(m => m.data).map(m => m.data).join('|') === '\x7f|\x1b[A|\r' && f.filter(m => m.data).every(m => !('userActivity' in m)), f);
    await key('Shift', 'ShiftLeft', 16, { modifiers: 8 }); await key('F9', 'F9', 120);
    f = await frames();
    check('lone modifier and F-key report no activity (F9 still reaches the app raw)', f.length === 1 && f[0].data === '\x1b[20~' && !('userActivity' in f[0]), f);

    await js(`term.write('\\x1b[6n')`); await sleep(200);
    f = await frames();
    check('terminal protocol reply (cursor report) is sent unmarked with no activity', f.length === 1 && /^\x1b\[\d+;\d+R$/.test(f[0].data) && !('userActivity' in f[0]), f);

    await cmd('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 }); await sleep(100);
    f = await frames();
    check('IME composing reports activity before any text is sent', f.length >= 1 && f.every(act), f);
    await cmd('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 }); await sleep(100);
    f = await frames();
    check('each further IME step reports activity again', f.length >= 1 && f.every(act), f);
    await cmd('Input.insertText', { text: '日本' }); await sleep(200);
    f = await frames();
    check('IME commit: activity reported and committed text sent raw', f.some(act) && f.filter(m => m.data).map(m => m.data).join('') === '日本' && f.filter(m => m.data).every(m => !('userActivity' in m)), f);

    await cmd('Input.insertText', { text: 'dictated' }); await sleep(150);
    f = await frames();
    check('native text insertion without key/IME reports activity and keeps the text', f.some(act) && f.filter(m => m.data).map(m => m.data).join('') === 'dictated' && f.filter(m => m.data).every(m => !('userActivity' in m)), f);
    await char('@', 'Digit2', 50, 8); await char('@', 'Digit2', 50, 8); await sleep(100);
    const pickerOpen = await js(`!!document.querySelector('.prompt-dropdown, .pd, [class*="dropdown"].show, [class*="ac-"]')`);
    f = await frames();
    check('@@ opens the mention picker: erase is a marked host insertion', f.some(m => m.data === '\x7f' && m.userActivity === true), { pickerOpen, f });
    await char('t', 'KeyT', 84); await char('y', 'KeyY', 89);
    f = await frames();
    check('typing a picker query keeps reporting activity without sending text', f.length === 2 && f.every(act), f);
    await key('Escape', 'Escape', 27); await frames();

    const mod = await js(`/Mac/.test(navigator.platform)?4:2`);
    await key('f', 'KeyF', 70, { modifiers: 2 }); await sleep(150);
    f = await frames();
    check('Ctrl+F opens terminal search without reporting typing', f.length === 0 && await js(`document.activeElement?.classList.contains('term-search-input')`), f);
    await key('Escape', 'Escape', 27); await sleep(100); await focusTerm(); await frames();
    await key('f', 'KeyF', 70, { modifiers: mod }); await sleep(150);
    const searching = await js(`document.activeElement?.classList.contains('term-search-input')`);
    await frames();
    await char('x', 'KeyX', 88); await key('Backspace', 'Backspace', 8);
    f = await frames();
    check('typing in terminal search sends no activity', searching && f.length === 0, { searching, f });
    await key('Escape', 'Escape', 27); await sleep(100); await frames();

    if (await js(`/Mac/.test(navigator.platform)`)) {
      await cmd('Browser.grantPermissions', { origin: base, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
      await js(`localStorage.setItem('clideck.ctrlVPaste','true');navigator.clipboard.writeText('clip text')`);
      for (const bracketed of [false, true]) {
        await js(`store.sessions.get('typing').bracketedPaste=${bracketed}`); await focusTerm(); await frames();
        await key('v', 'KeyV', 86, { modifiers: 2 }); await sleep(300);
        f = await frames();
        const ok = bracketed ? f.some(m => m.data === '\x1b[200~clip text\x1b[201~' && m.userActivity === true)
          : f.some(act) && f.some(m => m.data === 'clip text' && !('userActivity' in m));
        check(`Mac Ctrl+V marks the actual insertion after the clipboard read (bracketed ${bracketed})`, ok, f);
      }
      await js(`localStorage.removeItem('clideck.ctrlVPaste')`);
    } else console.log('SKIP Mac Ctrl+V clipboard path (not macOS)');
    await sleep(1200);
    check('idle page sends nothing on its own (no polling)', (await frames()).length === 0);
    // ── End to end: trusted key → real WS → engine typing guard → ask/steer HTTP.
    const post = body => fetch(base + '/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: agent.id, timeoutMs: 5000, ...body }) }).then(async r => ({ status: r.status, ...(await r.json()) }));
    await js(`store.select(${JSON.stringify(agent.id)});window.forwardId=${JSON.stringify(agent.id)}`); await sleep(200);
    check('engine session is shown live in the browser', await js(`store.active()?.id===${JSON.stringify(agent.id)}&&store.active().live!==false`));
    await focusTerm(); writes.length = 0;
    await char('h', 'KeyH', 72); await sleep(150);
    check('real keystroke reaches the engine and marks the user as typing', writes.join('') === 'h' && agent.isUserTyping(), writes);
    let r = await post({ text: 'peer ask' });
    check('ask while typing: HTTP 409 user_typing, nothing pasted', r.status === 409 && r.error === 'user_typing' && writes.join('') === 'h', r);
    agent.status = 'working'; agent.turnOpen = true;
    r = await post({ text: 'peer steer', steer: true });
    check('steer while typing: HTTP 409 user_typing, nothing pasted', r.status === 409 && r.error === 'user_typing' && writes.join('') === 'h', r);

    clock += 4000; writes.length = 0;
    check('four seconds after the last edit the guard has expired', !agent.isUserTyping());
    const pendingSteer = post({ text: 'interrupted steer', steer: true });
    await sleep(200);
    const pastedBeforeKey = writes.some(w => w.includes('interrupted steer')) && !writes.includes('\r');
    await char('z', 'KeyZ', 90);
    r = await pendingSteer; await sleep(1200);
    check('key during pending steer cancels Enter: HTTP 409 delivery_interrupted, honest wording', pastedBeforeKey && r.status === 409 && r.error === 'delivery_interrupted' && /already inserted/.test(r.message || ''), r);
    check('no delayed Enter or retry after the interruption', !writes.includes('\r') && writes.at(-1) === 'z', writes);

    clock += 4000; writes.length = 0;
    const started = Date.now();
    r = await post({ text: 'clean steer', steer: true });
    const crIndex = writes.indexOf('\r');
    check('clean steer returns HTTP 200 only after its Enter was written', r.status === 200 && r.ok && crIndex === 1 && writes[0].includes('clean steer') && Date.now() - started >= 550, { r, writes });
    await js('window.forwardId=null');
    check('no uncaught browser exceptions', errors.length === 0, errors);
  } finally {
    if (!agent.closed) agent.handleExit(0, null);
    cws?.close(); if (chrome) { chrome.kill(); await new Promise(r => chrome.exitCode !== null ? r() : chrome.once('exit', r)); } await server.close();
    console.log(`${passes} passed, ${fails} failed`); process.exitCode = fails ? 1 : 0;
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
