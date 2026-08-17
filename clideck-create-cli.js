const http = require('http');
const https = require('https');

function usage() {
  return [
    'Usage:',
    '  clideck create [--preset <id>] [--command <id>] [--name <name>] [--cwd <path>] [--json]',
    '',
    'Spawns a new CliDeck session (a sibling agent) from inside a running session.',
    'Defaults to the caller\'s own preset and cwd, so a plain `clideck create` spins up',
    'another agent of the same kind, in the same worktree.',
    'Run `clideck agents` afterward to confirm the new session and get its ask address.',
    '',
    'Options:',
    '  --preset <id>   Agent preset to launch (e.g. claude-code, codex). Default: caller\'s preset.',
    '  --command <id>  Explicit command id instead of a preset.',
    '  --name <name>   Name for the new session. Default: the preset/command label.',
    '  --cwd <path>    Working directory for the new session. Default: caller\'s cwd.',
    '  --json          Print machine-readable JSON.',
    '  --url <url>     CliDeck server URL. Default: CLIDECK_URL or http://127.0.0.1:<port>.',
    '  -h, --help      Show this help.',
  ].join('\n');
}

function parseArgs(args) {
  const port = process.env.CLIDECK_PORT || process.env.PORT || '4000';
  const out = { json: false, url: process.env.CLIDECK_URL || `http://127.0.0.1:${port}` };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--preset') out.presetId = args[++i];
    else if (arg === '--command') out.commandId = args[++i];
    else if (arg === '--name') out.name = args[++i];
    else if (arg === '--cwd') out.cwd = args[++i];
    else if (arg === '--url') out.url = args[++i];
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const target = new URL('/api/session/create', url);
    const client = target.protocol === 'https:' ? https : http;
    const body = JSON.stringify(payload);
    const req = client.request(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = data ? JSON.parse(data) : {}; } catch {}
        if (res.statusCode >= 400) {
          const err = new Error(parsed.error || `CliDeck create failed (${res.statusCode})`);
          err.statusCode = res.statusCode;
          return reject(err);
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function run(args) {
  try {
    const opts = parseArgs(args);
    if (opts.help) {
      console.log(usage());
      return;
    }
    const callerSessionId = process.env.CLIDECK_SESSION_ID || '';
    if (!callerSessionId) throw new Error('CLIDECK_SESSION_ID is missing. Run this from inside a CliDeck session.');

    const res = await postJson(opts.url, {
      callerSessionId,
      presetId: opts.presetId,
      commandId: opts.commandId,
      name: opts.name,
      cwd: opts.cwd,
    });
    const session = res.session || {};
    if (opts.json) process.stdout.write(JSON.stringify(session, null, 2) + '\n');
    else {
      const address = session.address && session.address !== session.name ? ` ask=${session.address}` : '';
      process.stdout.write(`${session.name} (${session.preset}) id=${session.id}${address} cwd=${session.cwd}\n`);
    }
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { run, parseArgs };
