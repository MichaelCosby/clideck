# Provider smoke tests

Catch regressions when a provider's CLI updates and silently breaks CliDeck's
core promises: start a session, send a message, detect **working/idle**, capture
a **resume token**, and detect **approval menus**. Without these, every Claude /
Codex / Gemini / OpenCode / Pi release can quietly break status, resume, or
autopilot.

These are **real** end-to-end tests against the installed agent CLIs — not mocks.
Mocks can't catch a changed TUI, a renamed hook event, or a new menu layout.

## Run

```bash
npm run smoke:providers              # all installed providers
node tests/providers/run.js -p codex # one provider
node tests/providers/run.js -p claude --verbose
npm run smoke:menu                   # menu-detection unit test (no agents needed)
node tests/providers/check-isolation.js   # prove the sandbox is isolated
```

Kept out of `npm test` on purpose — it depends on real, logged-in agent CLIs and
spends real API quota. Exit code is non-zero only on a real regression (`fail`);
missing or unauthenticated CLIs are `skip`.

## Isolation contract (the important part)

The runner is **read-only against the real machine** and writes only inside a
throwaway `tmpHome`:

- Each provider gets a fresh `mkdtemp` home (`chmod 700`, deleted on teardown).
- The CliDeck server is spawned with `HOME=tmpHome` and a **random port**. Because
  `os.homedir()` honors `$HOME`, every path relocates into the sandbox: `~/.clideck`
  (sessions/transcripts/config/lock) **and** each agent's config dir.
- Redirecting env vars (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_*`, `CLIDECK_*`, …)
  are stripped from the child so nothing points back at the real machine.
- Auth/config is **copied** into `tmpHome` (only the minimal files — never the
  multi-hundred-MB caches), and only the copies are ever patched (hooks/telemetry
  are re-installed for the test port). If a copy isn't enough to authenticate a
  provider, it is **skipped**, never repaired against the real config.

Your live CliDeck (its own port, its own `~/.clideck`) is never touched.

## What each provider run checks

1. `telemetry.autosetup` over WS — installs hooks/telemetry into the sandboxed
   config, re-baked for the test port (the port is baked into hook commands at
   install time, so a copied config alone would point at your live instance).
2. Create a session in `tmpHome/work/<provider>` (agent file writes stay in the box).
3. Send `Reply with exactly READY`; assert **working → idle** and that the reply
   shows up in output. Input is resent if the agent drops it while still booting.
4. Resume: a graceful shutdown persists `sessions.json`; assert the resume token
   was captured.

## Provider notes (discovered while building this)

- **Hook ports are baked at install time**, not read from env — so copied configs
  must be re-`autosetup`'d for the test port.
- **Claude (macOS)** authenticates via the Keychain, which is shared regardless of
  `HOME`, so it works in the sandbox. On a machine with no Keychain creds it will
  `skip`.
- **Codex** needs `--dangerously-bypass-hook-trust` (set in the seeded command):
  re-baking the hook makes it "untrusted", and that flag runs it for the
  invocation without persisting trust — so the real trust store is untouched.
  Codex's config is intentionally **not** copied, because the real `config.toml`
  can enable MCP servers (e.g. `codex_apps`) that delay readiness.
- **Status detection has several backends** and the tests exercise all of them:
  Claude/Gemini/Pi via HTTP hooks, Codex via hooks **and** OTLP telemetry,
  OpenCode via its plugin bridge.

## Menu detection

Approval-menu detection is client-coupled (the browser captures the terminal grid
and posts lines back; the server then runs `transcript.detectMenu`). A headless run
has no grid, so `menu-detection.test.js` unit-tests `detectMenu()` against
representative menu frames per provider. When a provider changes its menu layout,
those fixtures break first. Refresh them by capturing a real menu frame.
