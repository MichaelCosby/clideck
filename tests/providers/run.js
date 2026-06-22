// Provider smoke-test runner.
//
//   node tests/providers/run.js [--provider claude|codex|gemini|opencode|pi|all] [--verbose]
//
// For each selected provider: spin up a filesystem-isolated CliDeck (HOME=tmpHome,
// random port), copy just enough real auth/config into the sandbox, drive a real
// session over WebSocket, and assert the working/idle lifecycle + the agent's
// reply. Providers that are not installed or not authenticated are SKIPPED, never
// failed, and the real machine is never modified.

const { execFileSync } = require('child_process');
const { join } = require('path');
const PROVIDERS = require('./providers');
const { Sandbox } = require('./sandbox');
const { Client } = require('./client');
const { runLifecycle } = require('./lifecycle');

function parseArgs(argv) {
  const out = { provider: 'all', verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider' || a === '-p') out.provider = (argv[++i] || 'all').toLowerCase();
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  // Iteration knobs (mainly for debugging individual providers).
  if (process.env.SMOKE_TURN_TIMEOUT) out.turnTimeout = Number(process.env.SMOKE_TURN_TIMEOUT);
  if (process.env.SMOKE_WARMUP) out.warmup = Number(process.env.SMOKE_WARMUP);
  return out;
}

function installed(bin) {
  try { execFileSync('command', ['-v', bin], { shell: '/bin/zsh', stdio: 'ignore' }); return true; }
  catch { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } }
}

function classify(r) {
  if (r.error) return { status: 'fail', reason: r.error };
  if (!r.created) return { status: 'fail', reason: 'session not created' };
  if (r.gotReady && r.sawWorking && r.sawIdle) return { status: 'pass', reason: 'lifecycle ok' };
  if (r.gotReady) return { status: 'fail', reason: `answer ok but status broken (working=${r.sawWorking} idle=${r.sawIdle})` };
  if (r.loginHit) return { status: 'skip', reason: `not authenticated / onboarding (${r.loginHit})` };
  if (!r.sawWorking) return { status: 'skip', reason: 'no working signal and no answer (auth/availability)' };
  return { status: 'fail', reason: 'working seen but no answer in output' };
}

const COLOR = { pass: '\x1b[32m', fail: '\x1b[31m', skip: '\x1b[33m', off: '\x1b[0m', dim: '\x1b[2m' };

// Build a seeded-config command override for a provider that pins its command
// (e.g. Codex's bypass flag) and/or a home env var resolved under the sandbox.
function buildOverride(provider, tmpHome) {
  if (!provider.command) return null;
  const env = {};
  for (const [k, rel] of Object.entries(provider.envFromHome || {})) env[k] = join(tmpHome, rel);
  return {
    presetId: provider.presetId,
    command: provider.command,
    resumeCommand: provider.resumeCommand,
    env: Object.keys(env).length ? env : undefined,
  };
}

async function runProvider(provider, opts) {
  const tag = `[${provider.key}]`;
  const log = (m) => console.log(`${COLOR.dim}${tag}${COLOR.off} ${m}`);

  if (!installed(provider.bin)) return { provider, ...classify({ error: null, created: false }), skipped: true, reason: `${provider.bin} not installed`, status: 'skip' };

  const box = new Sandbox();
  let client;
  try {
    const copied = provider.copy.filter((rel) => box.copyRealPath(rel));
    log(`copied auth: ${copied.join(', ') || '(none found)'}`);
    const override = buildOverride(provider, box.tmpHome);
    box.seedConfig(override ? [override] : []);
    const port = await box.start();
    log(`server on :${port}`);
    client = new Client(port);
    await client.connect();
    await client.waitFor('config', { timeout: 8000 });

    const r = await runLifecycle(box, client, provider, log, opts);
    const verdict = classify(r);
    const tail = client.outputText(r.sessionId || '').split('\n').filter(Boolean).slice(-12).join('\n');
    if (verdict.status !== 'pass' || opts.verbose) {
      console.log(`${COLOR.dim}${tag} ── output tail ──${COLOR.off}\n${tail}\n${COLOR.dim}${tag} ────────────────${COLOR.off}`);
    }
    if (process.env.SMOKE_DEBUG) {
      const status = client.statusLog.filter((s) => s.id === r.sessionId).map((s) => `${s.working ? 'work' : 'idle'}:${s.source}`).join(' → ') || '(none)';
      console.log(`${COLOR.dim}${tag} status events: ${status}${COLOR.off}`);
      try {
        require('fs').writeFileSync(`/tmp/smoke-${provider.key}.txt`, client.outputText(r.sessionId || ''));
        console.log(`${COLOR.dim}${tag} full output → /tmp/smoke-${provider.key}.txt${COLOR.off}`);
      } catch {}
    }

    // Resume check: a graceful stop runs the server's shutdown path, which
    // persists resumable sessions to sessions.json. The key resume regression
    // signal is whether the provider's resume token was captured (via output
    // regex or bridge) — without it, `clideck --resume` can't work.
    if (verdict.status === 'pass' && provider.canResume) {
      await box.stop(true);
      const persisted = box.readSavedSessions().find((s) => s.name === `smoke-${provider.key}`);
      verdict.resume = persisted?.sessionToken ? `token ${String(persisted.sessionToken).slice(0, 8)}…` : 'NO TOKEN';
      log(`resume: ${verdict.resume}`);
    }
    return { provider, ...verdict, result: r };
  } catch (e) {
    return { provider, status: 'fail', reason: e.message };
  } finally {
    client?.close();
    await box.cleanup();
  }
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node tests/providers/run.js [--provider claude|codex|gemini|opencode|pi|all] [--verbose]');
    return;
  }
  const selected = opts.provider === 'all' ? PROVIDERS : PROVIDERS.filter((p) => p.key === opts.provider);
  if (!selected.length) { console.error(`unknown provider: ${opts.provider}`); process.exit(2); }

  console.log(`\nCliDeck provider smoke test — ${selected.map((p) => p.key).join(', ')}\n`);
  const results = [];
  for (const provider of selected) {
    results.push(await runProvider(provider, opts));
  }

  console.log('\n── summary ──');
  let failed = 0;
  for (const r of results) {
    const c = COLOR[r.status] || '';
    const resume = r.resume ? `  ${COLOR.dim}[resume: ${r.resume}]${COLOR.off}` : '';
    console.log(`  ${c}${r.status.toUpperCase().padEnd(4)}${COLOR.off}  ${r.provider.key.padEnd(9)} ${r.reason}${resume}`);
    if (r.status === 'fail') failed++;
  }
  console.log('');
  // Skips never fail the run (missing CLI / not logged in is expected). Only real
  // regressions (fail) set a non-zero exit code.
  process.exit(failed > 0 ? 1 : 0);
})();
