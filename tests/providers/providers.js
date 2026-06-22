// Per-provider smoke-test definitions.
//
// `copy` lists the SPECIFIC small auth/config files to copy from the real home
// into tmpHome (read-only on the real machine). We deliberately copy only the
// minimum needed to authenticate — never whole config trees, which can be
// hundreds of MB of caches/history/sessions. On macOS some providers (Claude)
// keep credentials in the Keychain, which is shared regardless of HOME, so the
// copied account file plus Keychain is enough.
//
// `loginMarkers` are substrings/patterns that mean "not authenticated / stuck
// in onboarding". If the turn produces no answer AND a login marker shows, the
// provider is SKIPPED (not failed) — we never reach back to the real config.

module.exports = [
  {
    key: 'claude',
    presetId: 'claude-code',
    bin: 'claude',
    copy: ['.claude.json', '.claude/.credentials.json', '.claude/settings.json'],
    prompt: 'Reply with exactly the single word READY and nothing else.',
    expect: /\bREADY\b/,
    loginMarkers: [/log\s?in/i, /sign\s?in/i, /\bauthenticate\b/i, /api key/i, /onboarding/i, /press enter to (login|continue)/i],
    canResume: true,
  },
  {
    key: 'codex',
    presetId: 'codex',
    bin: 'codex',
    // Only auth — NOT config.toml. The real config.toml can enable MCP servers
    // (e.g. codex_apps) that hang on boot in the sandbox and block the composer.
    // autosetup writes a minimal config.toml (telemetry only), so Codex boots
    // clean and ready. Auth lives in auth.json independently.
    copy: ['.codex/auth.json'],
    prompt: 'Reply with exactly the single word READY and nothing else.',
    expect: /\bREADY\b/,
    loginMarkers: [/sign in/i, /log\s?in/i, /\bauthenticate\b/i, /not logged in/i, /api key/i],
    // Codex requires interactive approval of lifecycle hooks ("2 hooks need
    // review · Press t to trust all"), and re-baking the hook for the test port
    // makes them hash-new every run. The official, headless-safe escape is
    // --dangerously-bypass-hook-trust: it runs the installed hooks for that
    // invocation WITHOUT persisting any trust, so the real Codex trust store is
    // never touched. CODEX_HOME is pinned to the sandbox so config/state/hooks
    // all resolve under tmpHome. (Per CliDeck maintainer + Codex manual.)
    command: 'codex --dangerously-bypass-hook-trust',
    resumeCommand: 'codex resume {{sessionId}} --dangerously-bypass-hook-trust',
    envFromHome: { CODEX_HOME: '.codex' },
    warmup: 30000,
    minWarmup: 9000,
    canResume: true,
  },
  {
    key: 'gemini',
    presetId: 'gemini-cli',
    bin: 'gemini',
    copy: ['.gemini/oauth_creds.json', '.gemini/settings.json', '.gemini/google_accounts.json', '.gemini/installation_id'],
    prompt: 'Reply with exactly the single word READY and nothing else.',
    expect: /\bREADY\b/,
    loginMarkers: [/sign in/i, /log\s?in/i, /\bauthenticate\b/i, /select auth/i, /api key/i],
    canResume: true,
  },
  {
    key: 'opencode',
    presetId: 'opencode',
    bin: 'opencode',
    copy: ['.config/opencode', '.local/share/opencode/auth.json'],
    prompt: 'Reply with exactly the single word READY and nothing else.',
    expect: /\bREADY\b/,
    loginMarkers: [/sign in/i, /log\s?in/i, /\bauthenticate\b/i, /no providers/i, /api key/i],
    canResume: true,
  },
  {
    key: 'pi',
    presetId: 'pi',
    bin: 'pi',
    copy: ['.pi'],
    prompt: 'Reply with exactly the single word READY and nothing else.',
    expect: /\bREADY\b/,
    loginMarkers: [/sign in/i, /log\s?in/i, /\bauthenticate\b/i, /api key/i],
    canResume: true,
  },
];
