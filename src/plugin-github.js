const { spawn } = require('child_process');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { basename, join } = require('path');
const { Readable } = require('stream');

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const SEGMENT = /^[A-Za-z0-9_.-]{1,200}$/;
const PLUGIN_ID = /^[a-z][a-z0-9-]{0,62}$/;

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Accepts owner/repo, owner/repo/path/to/plugin, or a github.com URL (optionally /tree/<branch>/path).
function parseGithubSource(input) {
  const text = String(input || '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const url = text.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i);
  const parts = (url ? url[1] : text.replace(/^github:/i, '')).split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo, ...rest] = parts;
  let ref = '';
  let path = rest;
  if (url && rest[0] === 'tree' && rest.length >= 2) {
    ref = rest[1];
    path = rest.slice(2);
  }
  if (!NAME.test(owner) || !NAME.test(repo) || (ref && !SEGMENT.test(ref))) return null;
  if (path.some((part) => part === '.' || part === '..' || !SEGMENT.test(part))) return null;
  return { owner, repo, ref, subpath: path.join('/') };
}

function formatGithubSource({ owner, repo, ref, subpath }) {
  if (ref) return `https://github.com/${owner}/${repo}/tree/${ref}${subpath ? `/${subpath}` : ''}`;
  return [owner, repo, subpath].filter(Boolean).join('/');
}

function extract(body, directory, tarCommand) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve();
    };
    // GNU and BSD tar refuse absolute and ".." member paths; symlinks are rejected later by the installer.
    const tar = spawn(tarCommand, ['-xzf', '-', '--strip-components=1', '--no-same-owner', '-C', directory], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const input = Readable.fromWeb(body);
    let bytes = 0;
    input.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_ARCHIVE_BYTES) {
        input.destroy();
        tar.kill();
        finish(codedError('The plugin download is larger than 64 MB.', 'plugin_too_large'));
      }
    });
    input.on('error', () => finish(codedError('The plugin download was interrupted.', 'github_download')));
    tar.stdin.on('error', () => {});
    tar.on('error', () => finish(codedError('Could not run tar to unpack the plugin.', 'github_extract')));
    tar.on('close', (code) => finish(code === 0 ? null : codedError('Could not unpack the plugin archive.', 'github_extract')));
    input.pipe(tar.stdin);
  });
}

// Downloads the repository and returns a folder named after the plugin id, ready for the installer.
async function downloadGithubPlugin(source, { fetchImpl = fetch, tarCommand = 'tar' } = {}) {
  const label = formatGithubSource(source);
  const url = `https://codeload.github.com/${source.owner}/${source.repo}/tar.gz/${source.ref || 'HEAD'}`;
  let response;
  try {
    response = await fetchImpl(url, { headers: { 'User-Agent': 'clideck' }, redirect: 'follow' });
  } catch {
    throw codedError('Could not reach GitHub.', 'github_download');
  }
  if (!response.ok) {
    throw codedError(response.status === 404
      ? `GitHub has no repository or branch at ${label} (private repositories are not supported).`
      : `GitHub returned HTTP ${response.status} for ${label}.`, 'github_download');
  }
  if (Number(response.headers.get('content-length')) > MAX_ARCHIVE_BYTES) {
    throw codedError('The plugin download is larger than 64 MB.', 'plugin_too_large');
  }
  const directory = mkdtempSync(join(tmpdir(), 'clideck-github-'));
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  try {
    const repoDir = join(directory, 'repo');
    mkdirSync(repoDir);
    await extract(response.body, repoDir, tarCommand);
    const pluginDir = source.subpath ? join(repoDir, ...source.subpath.split('/')) : repoDir;
    const manifestPath = join(pluginDir, 'clideck-plugin.json');
    if (!existsSync(manifestPath)) throw codedError(`No clideck-plugin.json at ${label}.`, 'plugin_not_found');
    let id;
    try { ({ id } = JSON.parse(readFileSync(manifestPath, 'utf8'))); } catch {}
    if (typeof id !== 'string' || !PLUGIN_ID.test(id)) throw codedError('The plugin manifest has no valid id.', 'invalid_manifest');
    if (basename(pluginDir) === id) return { dir: pluginDir, cleanup };
    const staged = join(directory, 'plugin');
    mkdirSync(staged);
    renameSync(pluginDir, join(staged, id));
    return { dir: join(staged, id), cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

module.exports = { MAX_ARCHIVE_BYTES, downloadGithubPlugin, formatGithubSource, parseGithubSource };
