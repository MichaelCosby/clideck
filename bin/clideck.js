#!/usr/bin/env node
const args = process.argv.slice(2);

function usage() {
  const version = require('../package.json').version;
  return [
    `CliDeck v${version}`,
    '',
    'Usage:',
    '  clideck [--host <host>] [--port <port>]',
    '  clideck agents [--json] [--all]',
    '  clideck ask --session <name-or-id> --message <text> [--timeout 10m]',
    '',
    'Options:',
    '  --host <host>     Host to bind. Default: 127.0.0.1. Use 0.0.0.0 for LAN access.',
    '  --port <port>     Port to use. Default: 4000. Can also use CLIDECK_PORT.',
    '  -h, --help        Show this help.',
    '  -v, --version     Show version.',
    '',
    'Agent tools:',
    '  clideck agents',
    '    Lists active sessions in the same project as the caller session.',
    '    Use this first when an agent needs to discover who it can ask.',
    '    Add --all to list cross-project targets with @project/session ask addresses.',
    '',
    '  clideck ask',
    '    Use from inside a CliDeck session when one agent needs an answer from another session.',
    '',
    'Ask behavior:',
    '  Unscoped target lookup is limited to the same project as the caller session.',
    '  Cross-project asks must use an explicit @project/session target.',
    '  CliDeck sends the message into the real target terminal, presses Enter, waits for the',
    '  target to finish, then prints the target agent response to stdout.',
    '  The target is another LLM agent. It may need minutes to think, read files, and use tools.',
    '  Set both `--timeout` and your shell/tool-call timeout high enough, or your caller may exit',
    '  before the target agent finishes.',
    '',
    'Examples:',
    '  clideck agents',
    '  clideck agents --json',
    '  clideck agents --all',
    '  clideck ask --session "Reviewer" --message "Review my changes and return only findings."',
    '  clideck ask "research manager" "Check this plan and tell me what is missing." --timeout 15m',
    '  clideck ask "@website/Docs Writer" "Check if the docs mention the new CLI flags." --timeout 15m',
    '  cat notes.md | clideck ask --session "Docs Writer" --timeout 10m',
    '',
    'Notes for agents:',
    '  Run `clideck agents` to discover available same-project sessions.',
    '  Run `clideck agents --all` before a cross-project ask.',
    '  Run `clideck ask --help` for the exact ask command contract.',
    '  If the target name has spaces, quote it.',
    '  If several sessions have the same name in the same project, use the session id.',
  ].join('\n');
}

if (args[0] === 'agents') {
  require('../clideck-agents-cli').run(args.slice(1));
} else if (args[0] === 'ask') {
  require('../clideck-ask-cli').run(args.slice(1));
} else if (args.includes('--help') || args.includes('-h')) {
  console.log(usage());
} else if (args.includes('--version') || args.includes('-v')) {
  console.log(require('../package.json').version);
} else {
  require('../server.js');
}
