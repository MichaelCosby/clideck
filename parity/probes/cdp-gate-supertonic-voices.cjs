// Actual Supertonic inventory and MP3 decoding; isolated engine/browser, no model download or PTY.
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { HeadlessServer } = require('../../src/server.js');
const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = process.env.GATE_OUT || '/tmp/clideck-supertonic-voices-ui';
mkdirSync(out, { recursive: true });
let fails = 0, passes = 0;
const check = (name, yes, detail) => { yes ? passes++ : fails++; console.log(`${yes ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };
(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'supertonic-voices-data-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ plugins: { supertonic: { enabled: true, settings: { voice: 'mike' } } }, onboarding: { completed: true, seenTips: ['guided-tour', 'about-me'] } }));
  const server = new HeadlessServer({ port: 0, dataDir });
  let chrome, cws;
  try {
    const address = await server.listen(), base = `http://127.0.0.1:${address.port}`;

    const profile = mkdtempSync(join(tmpdir(), 'supertonic-voices-chrome-'));
    chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--mute-audio', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
    const portFile = join(profile, 'DevToolsActivePort');
    for (let i=0; i<100 && !existsSync(portFile); i++) await sleep(100);
    const port = readFileSync(portFile, 'utf8').split('\n')[0];
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {method:'PUT'})).json();
    cws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(r=>cws.on('open',r));
    let seq=0; const pending=new Map(), errors=[], requests=[];
    cws.on('message', raw=> {const m=JSON.parse(raw);if(m.method==='Network.requestWillBeSent')requests.push(m.params.request.url);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}});
    const cmd=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+' timeout'));},12000);pending.set(id,m=>{clearTimeout(timer);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);});cws.send(JSON.stringify({id,method,params}));});
    const js=async expression=>{const r=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result?.value;};
    const snap=async name=>{const s=await cmd('Page.captureScreenshot',{format:'png'});writeFileSync(join(out,name),Buffer.from(s.data,'base64'));};
    await cmd('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await cmd('Network.enable');await cmd('Runtime.enable');await cmd('Page.enable');await cmd('Emulation.setFocusEmulationEnabled',{enabled:true});
    await cmd('Emulation.setUserAgentOverride',{userAgent:'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',platform:'Linux x86_64'});
    await cmd('Page.navigate',{url:base});await sleep(2200);
    await js(`(async()=>{window.store=(await import('/js/store.js')).store;const settings=await import('/js/ui/settings.js');settings.openPluginSettings('supertonic');window.voice=()=>document.getElementById('plugin-setting-supertonic-voice');})()`);
    await sleep(200);
    const names=await js('Array.from(voice().options,o=>o.textContent)');
    check('twelve actual voices with Mika and without Dov/Mike',names.length===12&&names.includes('Mika')&&!names.includes('Mike')&&!names.includes('Dov'),names);
    check('saved Mike ID still selects Mika',await js("voice().value==='mike'&&voice().selectedOptions[0].textContent==='Mika'"));
    const clips=await js(`(async()=>{
      const plugin=store.plugins.find(p=>p.id==='supertonic'), voices=plugin.settings.find(s=>s.key==='voice').options;
      const context=new AudioContext({sampleRate:44100}); const results=[];
      try{for(const v of voices){
        const response=await fetch('/plugins/supertonic/'+v.preview);if(!response.ok)throw Error(v.value+' HTTP '+response.status);
        const buffer=await context.decodeAudioData(await response.arrayBuffer());const data=buffer.getChannelData(0);
        let peak=0,sum=0;for(const x of data){peak=Math.max(peak,Math.abs(x));sum+=x*x;}
        results.push({id:v.value,seconds:buffer.duration,peak,rms:Math.sqrt(sum/data.length),sampleRate:buffer.sampleRate});
      }}finally{await context.close();}return results;
    })()`);
    for(const clip of clips)check('actual preview decodes, finite and non-silent: '+clip.id,clip.seconds>1&&clip.seconds<30&&Number.isFinite(clip.rms)&&clip.rms>0.001,clip);
    await js("voice().value='chun-li';voice().dispatchEvent(new Event('change',{bubbles:true}))");await sleep(200);
    check('new voice saves in isolated engine',server.configStore.get().plugins.supertonic.settings.voice==='chun-li');
    check('preview button names the selected voice',await js("voice().parentNode.querySelector('.plg-preview').getAttribute('aria-label')==='Play Chun-Li preview'"));
    const box=await js("(()=>{const r=voice().parentNode.querySelector('.plg-preview').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
    await cmd('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...box});await cmd('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...box});await sleep(300);
    check('actual preview button starts playback',await js("voice().parentNode.querySelector('.plg-preview').getAttribute('aria-label')==='Stop Chun-Li preview'"));
    await js("voice().parentNode.querySelector('.plg-preview').click()");
    for(const theme of ['dark','light']){await js(`import('/js/theme.js').then(m=>m.setThemePref('${theme}'))`);await sleep(100);await snap('supertonic-voices-'+theme+'.png');}
    check('browsing voices never downloads or loads the speech model',!requests.some(url=>/huggingface\.co|onnxruntime-web/.test(url)));
    check('no browser exceptions',errors.length===0,errors);
  } finally {
    cws?.close();if(chrome){chrome.kill();await new Promise(r=>chrome.exitCode!==null?r():chrome.once('exit',r));}await server.close();
    console.log(`${passes} passed, ${fails} failed; captures ${out}`);process.exitCode=fails?1:0;
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
