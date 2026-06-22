// Core provider smoke test: start a session, send a one-word prompt, and assert
// the full lifecycle CliDeck depends on — working -> idle status transitions and
// the agent's actual reply showing up in output.
//
// Returns a structured result; classification (pass / fail / skip) is left to
// the runner so the signals stay inspectable.

const { stripAnsi } = require('../../ansi-utils');

const BP_START = '\x1b[200~';
const BP_END = '\x1b[201~';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sendPrompt(client, id, message) {
  // Mirror session-ask.js: bracketed paste, then Enter, then a backup Enter if
  // the agent didn't pick the input up (some TUIs need a nudge).
  const payload = `\n\n${message}`;
  client.send({ type: 'input', id, data: `${BP_START}${payload}${BP_END}` });
  setTimeout(() => client.send({ type: 'input', id, data: '\r' }), 800);
  setTimeout(() => {
    if (!client.working.get(id)) client.send({ type: 'input', id, data: '\r' });
  }, 2300);
}

// Submit the prompt, then watch for working:true -> working:false. If no working
// signal appears within resendGap, resend the prompt (handles TUIs that drop
// input while still booting). Resolves { sawWorking, sawIdle } after the turn
// completes or the hard timeout.
function submitAndWatch(client, id, provider, timeoutMs, log) {
  const resendGap = provider.resendGap || 10000;
  const maxAttempts = provider.submitAttempts || 4;
  return new Promise((resolve) => {
    let sawWorking = !!client.working.get(id);
    let sawIdle = false;
    let attempts = 0;
    let lastSend = 0;
    const fn = (m) => {
      if (m.id !== id || m.type !== 'session.status') return;
      if (m.working) sawWorking = true;
      else if (sawWorking) { sawIdle = true; finish(); }
    };
    const finish = () => { clearTimeout(timer); clearInterval(tick); client.listeners.delete(fn); resolve({ sawWorking, sawIdle }); };
    client.listeners.add(fn);

    sendPrompt(client, id, provider.prompt);
    attempts = 1; lastSend = Date.now();
    log(`prompt sent (attempt 1), watching status…`);

    const tick = setInterval(() => {
      if (sawWorking) return; // it took — stop resending
      if (attempts < maxAttempts && Date.now() - lastSend > resendGap) {
        attempts++; lastSend = Date.now();
        log(`no working signal — resending prompt (attempt ${attempts})`);
        sendPrompt(client, id, provider.prompt);
      }
    }, 1000);
    const timer = setTimeout(finish, timeoutMs);
  });
}

async function runLifecycle(box, client, provider, log, opts = {}) {
  const turnTimeout = opts.turnTimeout || 120000;
  const result = {
    setupOk: null, created: false, sawWorking: false, sawIdle: false,
    gotReady: false, loginHit: null, sessionId: null, error: null,
  };

  const commandId = client.commandIdFor(provider.presetId);
  if (!commandId) { result.error = 'preset not present in config'; return result; }

  // 1. Patch hooks/telemetry into the COPIED config so status signals reach this
  //    test server's (random) port. Writes only under tmpHome.
  client.send({ type: 'telemetry.autosetup', presetId: provider.presetId });
  try {
    const setup = await client.waitFor(
      (m) => m.type === 'telemetry.autosetup.result' && m.presetId === provider.presetId,
      { timeout: 30000, label: 'autosetup' },
    );
    result.setupOk = !!setup.success;
    log(`autosetup: ${setup.success ? 'ok' : 'FAILED — ' + (setup.output || '').slice(0, 120)}`);
  } catch {
    log('autosetup: no result (continuing)');
  }

  // 2. Create the session in a sandbox work dir (agent file writes stay in tmpHome).
  const cwd = box.workDir(provider.key);
  const name = `smoke-${provider.key}`;
  client.send({ type: 'create', commandId, cwd, name });
  let created;
  try {
    created = await client.waitFor((m) => m.type === 'created' && m.name === name, { timeout: 15000, label: 'created' });
  } catch (e) { result.error = 'session not created: ' + e.message; return result; }
  result.created = true;
  result.sessionId = created.id;
  const id = created.id;
  log(`created ${id.slice(0, 8)}  cwd=${cwd}`);

  // 3. Wait until the agent is actually interactive before typing. A fixed timer
  //    is not enough: some TUIs keep initializing (Codex boots MCP servers and
  //    spins for a while) and drop input sent mid-boot. Readiness = either a
  //    status signal (hook agents), or the terminal going QUIET after a minimum
  //    warmup (TUIs with no startup hook). We also approve a hook trust/review
  //    prompt if one appears.
  const maxWarmup = provider.warmup || opts.warmup || 30000;
  const minWarmup = provider.minWarmup || 6000;
  const quietMs = 3500;
  const startWarm = Date.now();
  let lastLen = -1, lastChange = Date.now(), approved = false;
  while (Date.now() - startWarm < maxWarmup) {
    if (provider.hookReview && !approved && provider.hookReview.marker.test(client.outputText(id))) {
      log(`hook-review prompt detected — sending '${provider.hookReview.key}' to trust`);
      client.send({ type: 'input', id, data: provider.hookReview.key });
      approved = true;
      result.hooksApproved = true;
      await sleep(2500);
      continue;
    }
    if (client.statusLog.some((s) => s.id === id)) break; // status signal → ready
    const len = (client.output.get(id) || '').length;
    if (len !== lastLen) { lastLen = len; lastChange = Date.now(); }
    else if (Date.now() - startWarm > minWarmup && Date.now() - lastChange > quietMs) break; // quiet → ready
    await sleep(400);
  }
  log(`ready after ${Math.round((Date.now() - startWarm) / 1000)}s`);
  await sleep(1000);

  // 3b. Fast auth check: if the agent is already showing a login/onboarding
  //     prompt, skip now instead of waiting out the full turn timeout. Copied
  //     config wasn't enough — and we never reach back to the real config.
  const pre = client.outputText(id);
  const earlyLogin = provider.loginMarkers.find((re) => re.test(pre));
  if (earlyLogin && !client.working.get(id)) {
    result.loginHit = earlyLogin.toString();
    log(`login/onboarding prompt detected pre-turn — skipping`);
    return result;
  }

  // 4. Submit the prompt and watch the working -> idle cycle. A still-initializing
  //    TUI silently drops input, so if no working signal shows up we resend the
  //    prompt every few seconds until it takes (or we run out of attempts). Early
  //    sends are dropped rather than buffered, so resending doesn't pile up text.
  const sinceLen = (client.output.get(id) || '').length;
  const turn = await submitAndWatch(client, id, provider, turnTimeout, log);
  result.sawWorking = turn.sawWorking;
  result.sawIdle = turn.sawIdle;
  await sleep(1500); // let trailing output flush

  // 5. Evaluate output.
  const all = client.outputText(id);
  const fresh = stripAnsi((client.output.get(id) || '').slice(sinceLen));
  result.gotReady = provider.expect.test(fresh) || provider.expect.test(all);
  // A login marker only matters when the agent did NOT answer — otherwise it's
  // just a "/login" hint in the chrome of a perfectly working session.
  result.loginHit = result.gotReady ? null : ((provider.loginMarkers.find((re) => re.test(all)) || null)?.toString() || null);
  log(`working=${result.sawWorking} idle=${result.sawIdle} ready=${result.gotReady}${result.loginHit ? ' login?=' + result.loginHit : ''}`);

  return result;
}

module.exports = { runLifecycle, sleep, sendPrompt };
