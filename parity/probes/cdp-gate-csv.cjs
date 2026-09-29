// CSV file previews, real dock rendering and reload in an isolated engine/browser.
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { HeadlessServer } = require('../../src/server.js');
const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = process.env.GATE_OUT || '/tmp/clideck-csv-ui';
mkdirSync(out, { recursive: true });
let fails = 0, passes = 0;
const check = (name, yes, detail) => { yes ? passes++ : fails++; console.log(`${yes ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };
(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'csv-data-'));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'csv-files-')));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ onboarding: { completed: true, seenTips: ['guided-tour', 'about-me'] } }));
  const server = new HeadlessServer({ port: 0, dataDir });
  let chrome, ctl, cws;
  try {
    const address = await server.listen(), base = `http://127.0.0.1:${address.port}`;
    ctl = new WebSocket(base.replace('http:', 'ws:'));
    const events = [];
    ctl.on('message', raw => { try { events.push(JSON.parse(raw)); } catch {} });
    await new Promise(r => ctl.on('open', r));
    ctl.send(JSON.stringify({ type: 'session.create', provider: 'shell', name: 'CSV preview', cwd }));
    for (let i=0; i<100 && !events.some(e=>e.type==='session.created'); i++) await sleep(100);
    const sid = events.find(e=>e.type==='session.created').sessionId;
    const profile = mkdtempSync(join(tmpdir(), 'csv-chrome-'));
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
    await cmd('Page.navigate',{url:base});await sleep(2200);
    await js(`(async()=>{window.store=(await import('/js/store.js')).store;store.select(${JSON.stringify(sid)});window.tm=await import('/js/ui/terminal.js');window.term=tm.__termForTest();window.keepTerminal=term.element;window.sent=[];const send=WebSocket.prototype.send;WebSocket.prototype.send=function(d){try{sent.push(JSON.parse(d))}catch{}return send.call(this,d)};window.requests=[];const originalFetch=window.fetch;window.fetch=(...args)=>{requests.push(String(args[0]));return originalFetch(...args)};})()`);
    const show=async file=>{const r=await fetch(base+'/show',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:sid,path:join(cwd,file)})});if(!r.ok)throw new Error(await r.text());await sleep(650);return r.json();};
    const refresh=async()=>{const p=await js(`(()=>{const r=document.querySelector('.cd-dock-refresh').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);await cmd('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',clickCount:1});await cmd('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'left',clickCount:1});await sleep(650);};
    const csv = 'ID,Project,Owner,Status,Budget,Notes\r\n' + Array.from({length:60},(_,i)=>`${String(i+1).padStart(4,'0')},${['Atlas','Northstar','Harbor'][i%3]},${['Maya','Leo','Sam'][i%3]},${['Ready','In review','Planned'][i%3]},${['1200.00','0850.50','2400.00'][i%3]},"${i===0?'Includes research, design and QA':i===1?'Line one\nLine two':'Scheduled for next milestone'}"`).join('\r\n');
    writeFileSync(join(cwd,'projects.csv'),csv);await show('projects.csv');
    check('CSV opens in existing document tab',await js(`!!document.querySelector('.cd-render:not([hidden]) .csv-table')&&!!document.querySelector('.cd-dock-refresh')`));
    check('leading zeros and quoted comma survive',await js(`document.querySelector('.cd-render:not([hidden]) .csv-table td').textContent==='0001'&&document.querySelector('.cd-render:not([hidden]) .csv-table').textContent.includes('Includes research, design and QA')`));
    check('multiline quoted value stays one cell',await js(`[...document.querySelectorAll('.cd-render:not([hidden]) .csv-table td')].some(e=>e.textContent==='Line one\\nLine two')`));
    check('table header remains sticky while scrolling',await js(`(()=>{const sc=document.querySelector('.cd-render:not([hidden]) .csv-scroll');sc.scrollTop=150;return getComputedStyle(document.querySelector('.cd-render:not([hidden]) .csv-table thead th')).position==='sticky'})()`));
    for(const theme of ['dark','light']) {
      await js(`(async()=>{(await import('/js/theme.js')).setThemePref('${theme}');document.querySelector('.cd-render:not([hidden]) .csv-scroll').scrollTop=0})()`);await sleep(250);await snap('csv-'+theme+'.png');
    }
    await cmd('Emulation.setDeviceMetricsOverride',{width:760,height:800,deviceScaleFactor:1,mobile:false});await sleep(250);await snap('csv-narrow.png');
    check('420px content pane scrolls horizontally without overflowing',await js(`(()=>{const s=document.querySelector('.cd-render:not([hidden]) .csv-scroll'),r=s.getBoundingClientRect();return s.scrollWidth>s.clientWidth&&r.right<=innerWidth&&r.left>=0})()`));
    await js(`document.querySelector('.cd-render:not([hidden]) .csv-header-toggle input').click()`);
    check('headerless mode exposes first record',await js(`document.querySelector('.cd-render:not([hidden]) .csv-table td').textContent==='ID'`));
    writeFileSync(join(cwd,'projects.csv'),'code,value\n0099,updated');await refresh();
    check('disk refresh retains header choice and updates content',await js(`!document.querySelector('.cd-render:not([hidden]) .csv-header-toggle input').checked&&document.querySelector('.cd-render:not([hidden]) .csv-table').textContent.includes('0099')`));
    writeFileSync(join(cwd,'bad.csv'),'a,"unfinished');await show('bad.csv');
    check('malformed CSV has clear error',await js(`document.querySelector('.cd-render:not([hidden]) .ct-csv [role=alert]')?.textContent.includes('Invalid quoting')`));
    writeFileSync(join(cwd,'empty.csv'),'');await show('empty.csv');
    check('empty CSV has clear state',await js(`document.querySelector('.cd-render:not([hidden]) .ct-csv').textContent.includes('empty')`));
    writeFileSync(join(cwd,'large.csv'),'a,b\n'+Array(1000).fill('001,hello').join('\n'));await show('large.csv');
    check('large table bounded with honest notice',await js(`document.querySelectorAll('.cd-render:not([hidden]) .csv-table tbody tr').length===500&&document.querySelector('.cd-render:not([hidden]) .csv-notice').textContent.includes('remaining content is not shown or checked')`));
    writeFileSync(join(cwd,'safe.csv'),'value\n<img src=x onerror=alert(1)>');await show('safe.csv');
    check('HTML-like values render as literal text',await js(`!document.querySelector('.cd-render:not([hidden]) .csv-table img')&&document.querySelector('.cd-render:not([hidden]) .csv-table td').textContent==='<img src=x onerror=alert(1)>'`));
    check('terminal remains mounted unchanged',await js('term.element===keepTerminal'));
  } finally {
    cws?.close();ctl?.close();chrome?.kill();await server.close();
    console.log(`${passes} passed, ${fails} failed; captures ${out}`);process.exitCode=fails?1:0;
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
