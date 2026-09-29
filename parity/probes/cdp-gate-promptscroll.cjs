// Gate: editing a LONG prompt in the prompts overlay — the text is readable and Save/Cancel is always reachable.
//
// Or's report: "the scroller dont work properly and i cannot scroll down to see the content and action buttons."
// Both halves reproduced and measured before the fix, at 1440x800 with a 40-line prompt:
//   • the text box was 96px tall for content needing 760px — a long prompt read through a five-line slot;
//   • `resize:vertical` invited you to drag it taller, and that WORKED — straight into the trap. .pl-modal is a
//     fixed-height overflow:hidden flex column whose only scrollers are the textarea and the list, so at a
//     500px drag Save/Cancel sat 69px past the clipped bottom edge (269px at 700px) with nothing able to
//     scroll them back. The modal reported clipped from a 340px drag on.
//
// My FIRST probe at this passed and proved nothing — a 2-prompt library at 800px never overflowed, so it
// measured a case the bug does not live in. The sweep that found it is the reason the checks below run across
// viewport heights instead of one: the failure is a function of available height, so a single height is not
// evidence. See §3 of the UI handoff.
//
// Own headless Chrome + temp profile + ephemeral HeadlessServer. Never :9222, never 4100, never ~/.clideck-next.
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { HeadlessServer } = require('/Users/rusty/Projects/clideck-next/src/server.js');
const WebSocket = require('/Users/rusty/Projects/clideck-next/node_modules/ws/index.js');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = '/tmp/clideck-placeholder-ui';
mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const check = (n, ok, extra) => { console.log((ok ? 'PASS' : 'FAIL') + ' ' + n + (extra ? '  [' + extra + ']' : '')); if (!ok) fail++; };

const LONG = Array.from({ length: 40 }, (_, i) =>
  `Step ${i + 1}. Review the change against the surrounding code and report anything surprising.`).join('\n');

const RIG = `
// Settle whatever is open, then open exactly once — the module TOGGLES on repeat calls.
window.__openEditor = async (count) => {
  const { store } = await import('/js/store.js');
  const m = await import('/js/ui/prompts.js');
  if (document.querySelector('.pl-modal')) { m.openPromptLibrary(); await new Promise(r => setTimeout(r, 400)); }
  const prompts = Array.from({length: count}, (_, i) => ({ id: 'p'+i, name: 'Prompt ' + i, text: ${JSON.stringify(LONG)} }));
  store.applyEvent({ type: 'config', config: { prompts } });
  m.openPromptLibrary();
  await new Promise(r => setTimeout(r, 350));
  if (!document.querySelector('.pl-modal')) return 'modal did not open';
  const row = [...document.querySelectorAll('.pl-row')][0];
  if (!row) return 'no rows';
  row.querySelector('.pl-edit').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 350));
  return document.querySelector('.pl-editor') ? true : 'editor did not open';
};
// The NEW-prompt editor, which is where the placeholder is actually visible — an existing prompt has text
// over it. Cancel out of whatever editor is open first, then press New.
window.__openNew = async () => {
  const c = document.querySelector('.pl-ed-cancel');
  if (c) { c.dispatchEvent(new MouseEvent('click', { bubbles: true })); await new Promise(r => setTimeout(r, 300)); }
  const n = document.querySelector('.pl-newbtn'); if (!n) return 'no New button';
  n.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 350));
  const ta = document.querySelector('.pl-ed-text');
  if (!ta) return 'editor did not open';
  const box = ta.getBoundingClientRect(), modal = document.querySelector('.pl-modal').getBoundingClientRect();
  return { placeholder: ta.placeholder, value: ta.value, taH: Math.round(box.height),
    inside: box.bottom <= modal.bottom + 1 && box.top >= modal.top - 1,
    ink: getComputedStyle(ta, "::placeholder").color };
};
window.__closeEditor = async () => {
  const c = document.querySelector('.pl-ed-cancel'); if (!c) return false;
  c.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300)); return !document.querySelector('.pl-editor');
};
window.__state = () => {
  const modal = document.querySelector('.pl-modal');
  const ta = document.querySelector('.pl-ed-text');
  const act = document.querySelector('.pl-ed-actions');
  if (!modal || !ta || !act) return null;
  const m = modal.getBoundingClientRect(), a = act.getBoundingClientRect(), t = ta.getBoundingClientRect();
  return {
    modalH: +m.height.toFixed(0), clipped: modal.scrollHeight > modal.clientHeight + 1,
    taH: ta.offsetHeight, taNeeds: ta.scrollHeight, taResize: getComputedStyle(ta).resize,
    actionsVisible: a.bottom <= m.bottom + 1 && a.top >= m.top - 1,
    actionsBelowBy: +(a.bottom - m.bottom).toFixed(0),
    textInside: t.bottom <= m.bottom + 1 && t.top >= m.top - 1,
    title: (document.querySelector('.pl-title') || {}).textContent,
  };
};
window.__listState = () => {
  const l = document.querySelector('.pl-list');
  if (!l) return { present: false };
  const cs = getComputedStyle(l);
  return { present: true, display: cs.display, overflowY: cs.overflowY, canScroll: l.scrollHeight > l.clientHeight };
};
`;

(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ps-data-'));
  const server = new HeadlessServer({ port: 0, dataDir });
  const addr = await server.listen();

  const prof = mkdtempSync(join(tmpdir(), 'chrome-ps-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${prof}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  const portFile = join(prof, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(200);
  const port = readFileSync(portFile, 'utf8').split('\n')[0].trim();
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const cws = new WebSocket(t.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { cws.on('open', res); cws.on('error', rej); });
  let seq = 0; const pending = new Map();
  cws.on('message', d => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const cmd = (m, p = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); cws.send(JSON.stringify({ id, method: m, params: p })); });
  const js = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const snap = async (n) => { const s = await cmd('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, n), Buffer.from(s.result.data, 'base64')); console.log('  captured ' + n); };
  const viewport = (w, h) => cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });

  await viewport(1440, 800);
  await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await cmd('Page.navigate', { url: `http://127.0.0.1:${addr.port}` });
  await sleep(4500);
  await js(RIG);

  // ── 1. THE REGRESSION NET — every height x library size the bug was a function of ───────────────
  // The pre-fix failure appeared only above a height threshold, so one viewport is not evidence.
  let worstTa = Infinity;
  // 520 is deliberately cramped — the point is that a short window yields a small box, never an unreachable one.
  for (const h of [520, 640, 700, 800, 900]) {
    await viewport(1440, h);
    for (const n of [2, 12, 40]) {
      const opened = await js(`window.__openEditor(${n})`);
      if (opened !== true) { check(`1 vh=${h} n=${n}: editor opens`, false, String(opened)); continue; }
      await sleep(200);
      const s = await js(`window.__state()`);
      worstTa = Math.min(worstTa, s.taH);
      check(`1 vh=${h} n=${n}: Save/Cancel reachable, nothing clipped`,
            s.actionsVisible && s.textInside && !s.clipped,
            `modal ${s.modalH} · text box ${s.taH}px · actions ${s.actionsVisible ? 'in view' : 'BELOW by ' + s.actionsBelowBy + 'px'}${s.clipped ? ' · CLIPPED' : ''}`);
    }
  }

  // ── 2. the other half of the report: a long prompt must be READABLE, not a five-line slot ───────
  await viewport(1440, 800);
  await js(`window.__openEditor(12)`); await sleep(300);
  const s8 = await js(`window.__state()`);
  check('2a the text box grows to the window instead of the old 96px floor',
        s8.taH >= 300, `${s8.taH}px for content needing ${s8.taNeeds}px (was 96px)`);
  check('2b the drag handle that caused the trap is gone', s8.taResize === 'none', `resize:${s8.taResize}`);
  check('2c the header says which mode you are in', s8.title === 'Edit prompt', s8.title);
  console.log(`  info  smallest text box across the whole sweep: ${worstTa}px (pre-fix it was 96px everywhere)`);
  await snap('promptscroll-dark-editing.png');

  // ── 3. leaving the editor restores the browse surfaces, list scroller intact ────────────────────
  check('3a Cancel closes the editor', await js(`window.__closeEditor()`) === true);
  const list = await js(`window.__listState()`);
  check('3b the prompt list is back and is still its own scroller',
        list.present && list.display !== 'none' && /auto|scroll/.test(list.overflowY) && list.canScroll, JSON.stringify(list));
  const backTitle = await js(`(() => (document.querySelector('.pl-title') || {}).textContent)()`);
  check('3c the header goes back to "Prompts"', backTitle === 'Prompts', backTitle);
  await snap('promptscroll-dark-list.png');

  // ── 4. a SHORT prompt must not look silly in the tall box, and must still be fine ───────────────
  const shortOk = await js(`(async () => {
    const { store } = await import('/js/store.js');
    const m = await import('/js/ui/prompts.js');
    if (document.querySelector('.pl-modal')) { m.openPromptLibrary(); await new Promise(r => setTimeout(r, 400)); }
    store.applyEvent({ type: 'config', config: { prompts: [{ id: 's1', name: 'Short', text: 'just one line' }] } });
    m.openPromptLibrary(); await new Promise(r => setTimeout(r, 350));
    document.querySelector('.pl-row .pl-edit').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 350));
    return !!document.querySelector('.pl-editor'); })()`);
  const sShort = await js(`window.__state()`);
  check('4 a one-line prompt still opens cleanly with its actions in view',
        shortOk === true && sShort.actionsVisible && !sShort.clipped, `text box ${sShort && sShort.taH}px`);
  await snap('promptscroll-dark-short.png');

  // ── 5. light theme ─────────────────────────────────────────────────────────────────────────────
  await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await js(`window.__openEditor(12)`); await sleep(400);
  const sl = await js(`window.__state()`);
  check('5 light: same reachability, same box', sl.actionsVisible && sl.textInside && !sl.clipped,
        `text box ${sl.taH}px`);
  await snap('promptscroll-light-editing.png');

  // ── 6. the new-prompt placeholder — the only hint that arrives unasked-for ─────────────────────
  // ⚠️ {{session_name}} pastes the FULL address (@Project/name), not the bare name, and this box is where a
  // prompt is written. Checked in BOTH themes because it is long enough to wrap and it is placeholder ink.
  const newLight = await js(`window.__openNew()`);
  check('6 light: the empty prompt box names both fillers and what session_name means',
        newLight && newLight.value === '' && /\{\{session_name\}\}/.test(newLight.placeholder)
        && /\{\{project_name\}\}/.test(newLight.placeholder) && /full @Project\/name address/i.test(newLight.placeholder),
        newLight && newLight.placeholder);
  check('6 light: it fits inside the modal rather than pushing the box out of it',
        newLight && newLight.inside === true, newLight && `box ${newLight.taH}px`);
  await snap('promptscroll-light-newprompt.png');
  await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(400);
  const newDark = await js(`(() => { const ta = document.querySelector('.pl-ed-text'); const m = document.querySelector('.pl-modal').getBoundingClientRect(), b = ta.getBoundingClientRect();
    return { ink: getComputedStyle(ta, "::placeholder").color, inside: b.bottom <= m.bottom + 1 && b.top >= m.top - 1, taH: Math.round(b.height) }; })()`);
  check('6 dark: the same box, and placeholder ink that came from the tokens rather than the light literal',
        newDark && newDark.inside === true && newDark.ink !== newLight.ink, JSON.stringify({ dark: newDark, light: newLight.ink }));
  await snap('promptscroll-dark-newprompt.png');

  // Native editing plus visual mirror. Never rewrite textarea.value in response to input.
  await js(`window.__openNew()`);
  await js(`document.querySelector('.pl-ed-text').focus()`);
  const sample = 'You are {{session_name}} in {{ project_name }}.\nKeep {session_name}, {{unknown}} and {{session_name} literal.\n<img src=x> is plain text.';
  await cmd('Input.insertText', { text: sample });
  check('7 typed placeholders alone are blue and markup remains text',await js(`document.querySelectorAll('.pl-ed-mirror .pl-placeholder').length===2&&!document.querySelector('.pl-ed-mirror img')`));
  check('7 native selection remains editable',await js(`(()=>{const t=document.querySelector('.pl-ed-text');t.setSelectionRange(0,3);return t.value.startsWith('You')&&t.selectionEnd===3})()`));
  await cmd('Input.insertText',{text:'We'});
  check('7 native selected-text replacement works',await js(`document.querySelector('.pl-ed-text').value.startsWith('We are')`));
  await cmd('Input.dispatchKeyEvent',{type:'keyDown',key:'z',code:'KeyZ',modifiers:4,commands:['undo']});
  await cmd('Input.dispatchKeyEvent',{type:'keyUp',key:'z',code:'KeyZ',modifiers:4});
  check('7 native undo restores text and highlights',await js(`document.querySelector('.pl-ed-text').value.startsWith('You are')&&document.querySelectorAll('.pl-placeholder').length===2`));
  await cmd('Input.imeSetComposition',{text:'日本',selectionStart:2,selectionEnd:2});
  check('7 IME preedit uses native visible text',await js(`document.querySelector('.pl-ed-field').classList.contains('composing')`));
  await cmd('Input.insertText',{text:'日本'});
  check('7 IME commit restores mirror',await js(`!document.querySelector('.pl-ed-field').classList.contains('composing')&&document.querySelector('.pl-ed-text').value.includes('日本')`));
  await cmd('Emulation.setFocusEmulationEnabled',{enabled:true});
  await cmd('Browser.grantPermissions',{origin:`http://127.0.0.1:${addr.port}`,permissions:['clipboardReadWrite','clipboardSanitizedWrite']});
  await js(`navigator.clipboard.writeText('\\n{{project_name}} pasted')`);
  await cmd('Input.dispatchKeyEvent',{type:'keyDown',key:'v',code:'KeyV',modifiers:4,commands:['paste']});
  await cmd('Input.dispatchKeyEvent',{type:'keyUp',key:'v',code:'KeyV',modifiers:4});await sleep(100);
  check('7 native multiline paste updates mirror',await js(`document.querySelector('.pl-ed-text').value.includes('\\n{{project_name}} pasted')&&document.querySelector('.pl-ed-mirror').textContent.includes('pasted')`));
  const populate = async text => js(`(()=>{const t=document.querySelector('.pl-ed-text');t.value=${JSON.stringify(text)};t.dispatchEvent(new Event('input'));t.scrollTop=0;t.dispatchEvent(new Event('scroll'));t.focus()})()`);
  for (const theme of ['dark','light']) {
    await js(`(async()=>{(await import('/js/theme.js')).setThemePref('${theme}')})()`);await populate(sample);await sleep(250);await snap('placeholder-'+theme+'.png');
    check('7 '+theme+' blue token color',await js(`(()=>{const c=getComputedStyle(document.querySelector('.pl-placeholder')).color.match(/\\d+/g).map(Number);return c[2]>c[0]&&c[2]>c[1]})()`));
  }
  await populate(Array.from({length:90},(_,i)=>'Line '+i+' {{session_name}} '+ 'wrapped text '.repeat(9)).join('\n')+'\n');
  await js(`(()=>{const t=document.querySelector('.pl-ed-text');t.scrollTop=t.scrollHeight;t.dispatchEvent(new Event('scroll'))})()`);await sleep(200);
  check('7 long scrolled mirror aligns height and scroll',await js(`(()=>{const t=document.querySelector('.pl-ed-text'),m=document.querySelector('.pl-ed-mirror');return Math.abs(t.scrollHeight-m.scrollHeight)<=1&&t.scrollTop===m.scrollTop})()`));
  await snap('placeholder-long-scrolled.png');
  await viewport(420,800);await sleep(250);
  // Browser clamps scroll on resize; scroll event keeps both layers together.
  console.log('narrow metrics',await js(`(()=>{const t=document.querySelector('.pl-ed-text'),m=document.querySelector('.pl-ed-mirror');return {tw:t.clientWidth,mw:m.clientWidth,th:t.scrollHeight,mh:m.scrollHeight,ts:t.scrollTop,ms:m.scrollTop,actions:window.__state().actionsVisible}})()`));
  check('7 narrow wrap geometry and actions remain aligned',await js(`(()=>{const t=document.querySelector('.pl-ed-text'),m=document.querySelector('.pl-ed-mirror');return t.clientWidth===m.clientWidth&&Math.abs(t.scrollHeight-m.scrollHeight)<=1&&window.__state().actionsVisible})()`));
  await snap('placeholder-narrow.png');

  console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILED'));
  try { chrome.kill(); } catch {} try { await server.close(); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.log('THREW', e && e.stack || e); process.exit(1); });
