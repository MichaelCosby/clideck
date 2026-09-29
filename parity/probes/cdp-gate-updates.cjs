// Update UI over real websocket; isolated engine/browser, fake installer: never npm or live profiles.
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { HeadlessServer } = require('../../src/server.js');
const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = process.env.GATE_OUT || '/tmp/clideck-updates-ui';
mkdirSync(out, { recursive: true });
let fails = 0, passes = 0;
const check = (name, yes, detail) => { yes ? passes++ : fails++; console.log(`${yes ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };
(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'updates-data-'));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'updates-files-')));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ onboarding: { completed: true, seenTips: ['guided-tour', 'about-me'] } }));
  const server = new HeadlessServer({ port: 0, dataDir });
  let installCalls = 0, finishInstall;
  const update = { type:'engine.update',state:'available',currentVersion:'2.3.1',latestVersion:'99.0.0',canInstall:true };
  server.updates = {
    snapshot:()=>({...update}),
    check:async()=>({...update}),
    install:async()=>{installCalls++;update.state='installing';server.broadcast({...update});await new Promise(r=>finishInstall=r);update.state='installed';update.canInstall=false;server.broadcast({...update});return {...update};},
    close:async()=>{},
  };
  let chrome, ctl, cws;
  try {
    const address = await server.listen(), base = `http://127.0.0.1:${address.port}`;
    ctl = new WebSocket(base.replace('http:', 'ws:'));
    const events = [];
    ctl.on('message', raw => { try { events.push(JSON.parse(raw)); } catch {} });
    await new Promise(r => ctl.on('open', r));
    ctl.send(JSON.stringify({ type: 'session.create', provider: 'shell', name: 'links', cwd }));
    for (let i=0; i<100 && !events.some(e=>e.type==='session.created'); i++) await sleep(100);
    const sid = events.find(e=>e.type==='session.created').sessionId;
    const profile = mkdtempSync(join(tmpdir(), 'updates-chrome-'));
    chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
    const portFile = join(profile, 'DevToolsActivePort');
    for (let i=0; i<100 && !existsSync(portFile); i++) await sleep(100);
    const port = readFileSync(portFile, 'utf8').split('\n')[0];
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {method:'PUT'})).json();
    cws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(r=>cws.on('open',r));
    let seq=0; const pending=new Map();
    cws.on('message', raw=> {const m=JSON.parse(raw);if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}});
    const cmd=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+' timeout'));},12000);pending.set(id,m=>{clearTimeout(timer);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);});cws.send(JSON.stringify({id,method,params}));});
    const js=async expression=>{const r=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result?.value;};
    const snap=async name=>{const s=await cmd('Page.captureScreenshot',{format:'png'});writeFileSync(join(out,name),Buffer.from(s.data,'base64'));};
    await cmd('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await cmd('Page.enable');await cmd('Emulation.setFocusEmulationEnabled',{enabled:true});
    await cmd('Emulation.setUserAgentOverride',{userAgent:'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',platform:'Linux x86_64'});
    await cmd('Page.navigate',{url:base});await sleep(2200);
    await js(`(async()=>{window.store=(await import('/js/store.js')).store;store.select(${JSON.stringify(sid)});window.tm=await import('/js/ui/terminal.js');window.term=tm.__termForTest();window.sent=[];const send=WebSocket.prototype.send;WebSocket.prototype.send=function(data){try{sent.push(JSON.parse(data))}catch{}return send.call(this,data)};})()`);
    check('connection snapshot shows one update toast',await js(`document.querySelectorAll('#toast-engine-update').length===1&&document.querySelector('.toast-primary').textContent==='Update'`));
    await sleep(3500);
    check('update notice survives beyond ordinary toast timeout',await js(`!!document.querySelector('#toast-engine-update .toast-primary')`));
    update.state='checking';server.broadcast({...update});await sleep(350);
    check('automatic checking removes stale Update action',await js(`!document.querySelector('#toast-engine-update .toast-primary')`));
    update.state='available';server.broadcast({...update});await sleep(150);
    check('same available version returns after automatic check',await js(`document.querySelector('.toast-primary')?.textContent==='Update'`));
    for(const client of server.clients) client.close();await sleep(400);
    check('offline has no stale Update action',await js(`!store.connected&&!document.querySelector('#toast-engine-update .toast-primary')`));
    await sleep(2000);
    check('real reconnect restores undismissed notice',await js(`store.connected&&document.querySelector('.toast-primary')?.textContent==='Update'`));
    await js(`Array.from(document.querySelectorAll('#toast-engine-update .toast-act')).find(b=>b.textContent==='Dismiss').click()`);await sleep(350);
    update.state='checking';server.broadcast({...update});await sleep(100);update.state='available';server.broadcast({...update});await sleep(150);
    for(const client of server.clients) client.close();await sleep(2000);
    check('explicit dismissal survives check and reconnect',await js(`store.connected&&!document.querySelector('#toast-engine-update .toast-primary')`));
    update.latestVersion='99.0.2';server.broadcast({...update});await sleep(150);
    for(const theme of ['dark','light']) {
      await js(`(async()=>{(await import('/js/theme.js')).setThemePref('${theme}')})()`);await sleep(250);await snap('update-toast-'+theme+'.png');
    }
    await js(`(async()=>{window.settings=await import('/js/ui/settings.js');settings.openSettingsAt('general')})()`);await sleep(300);
    for(const theme of ['dark','light']) {
      await js(`(async()=>{(await import('/js/theme.js')).setThemePref('${theme}')})()`);await sleep(250);await snap('update-settings-'+theme+'.png');
    }
    await cmd('Emulation.setDeviceMetricsOverride',{width:420,height:800,deviceScaleFactor:1,mobile:false});await sleep(250);await snap('update-settings-narrow.png');
    check('narrow Settings update control visible and within viewport',await js(`(()=>{const b=document.querySelector('.set-update button'),r=b.getBoundingClientRect();return r.width>0&&r.bottom<=innerHeight&&r.right<=innerWidth})()`));
    await js(`window.pidBefore=store.active().pid;sent=[];document.querySelector('.set-update button').click()`);await sleep(250);
    check('real control reaches fake installer exactly once',installCalls===1);
    check('installing disables persistent action',await js(`document.querySelector('.set-update button').disabled&&document.querySelector('.set-update-status').textContent.includes('Installing')`));
    finishInstall();await sleep(300);
    check('installed asks for manual restart and keeps session process',await js(`document.querySelector('.set-update-status').textContent.includes('Restart CliDeck when ready')&&store.active().pid===pidBefore&&!sent.some(m=>m.type.includes('restart'))`));
    Object.assign(update,{state:'error',canInstall:true,error:'Permission denied.'});server.broadcast({...update});await sleep(150);
    check('install error without local request offers explicit retry',await js(`document.querySelector('.set-update button').textContent==='Retry update'&&document.querySelector('#toast-engine-update .toast-primary').textContent==='Retry update'`));
    await js(`document.querySelector('.set-update button').click()`);await sleep(150);
    check('retry reaches fake installer once',installCalls===2);finishInstall();await sleep(150);
    Object.assign(update,{state:'available',latestVersion:'99.0.1',canInstall:false,instruction:'Source checkout: update your checkout manually.'});server.broadcast({...update});await sleep(250);
    check('source checkout gives instruction instead of installation',await js(`document.querySelector('.set-update-status').textContent.includes('Source checkout')&&document.querySelector('.set-update button').textContent==='Check for updates'&&document.querySelector('.toast-primary').textContent==='Details'`));
    server.broadcast({...update});await sleep(100);
    check('repeated snapshots retain a single toast',await js(`document.querySelectorAll('#toast-engine-update').length===1`));
    await js(`document.querySelector('.set-update button').click()`);await sleep(200);
    check('manual check returns authoritative snapshot',await js(`store.engineUpdate.state==='available'`));
    Object.assign(update,{state:'error',error:'Unable to contact update server.'});server.broadcast({...update});await sleep(150);
    check('check failure is visible',await js(`document.querySelector('.set-update-status').textContent.includes('Unable to contact')`));
  } finally {
    finishInstall?.();cws?.close();ctl?.close();chrome?.kill();await server.close();
    console.log(`${passes} passed, ${fails} failed; captures ${out}`);process.exitCode=fails?1:0;
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
