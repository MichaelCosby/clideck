// An agent whose process ends moments after it was started, before anyone typed into it or sent it anything,
// did not start. Without this the session just went to sleep, which looked like a slow start. The cause is
// worked out after the fact rather than checked beforehand: a launch script may create its folder or fetch its
// command itself, so only the outcome says whether it could start.
const { statSync } = require('fs');

const START_FAILURE_MS = 10_000;
const MAX_OUTPUT = 8 * 1024;

const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

function lastLines(output, count = 3, max = 300) {
  const lines = String(output || '').replace(ANSI, '').split(/\r?\n|\r/).map((line) => line.trim()).filter(Boolean);
  const text = lines.slice(-count).join(' / ');
  return text.length > max ? `…${text.slice(-max)}` : text;
}

function folderProblem(cwd, stat = statSync) {
  if (!cwd) return '';
  try {
    return stat(cwd).isDirectory() ? '' : `${cwd} is not a folder.`;
  } catch (error) {
    return error?.code === 'ENOENT' ? `The folder ${cwd} doesn't exist.` : '';
  }
}

// What to tell the user, in order of how sure we are: the folder, then the command, then whatever it printed.
function describeStartFailure({ cwd, command, output, exitCode, signal }, stat = statSync) {
  const folder = folderProblem(cwd, stat);
  if (folder) return folder;
  if (/execvp\(3\) failed/.test(output || '')) {
    return `The command ${JSON.stringify(String(command || ''))} wasn't found.`;
  }
  const how = exitCode != null && exitCode !== 0 ? ` (exit code ${exitCode})`
    : signal ? ` (signal ${signal})` : '';
  const said = lastLines(output);
  return `It stopped right after starting${how}.${said ? ` Last output: ${said}` : ''}`;
}

module.exports = { MAX_OUTPUT, START_FAILURE_MS, describeStartFailure, lastLines };
