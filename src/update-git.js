// In-app updates for an engine running from a git checkout: follow the branch this checkout tracks
// (e.g. origin/main of a fork), offer its new commits when the checkout can fast-forward to them, and
// install by fast-forwarding to exactly the commit that was checked.
const { execFile } = require('child_process');
const { join } = require('path');
const { npmCli, runNpm } = require('./update-install');

function git(root, args, timeout = 60_000) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', root, ...args], {
      timeout, maxBuffer: 1024 * 1024, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },   // never hang on a credential prompt
    }, (error, stdout) => (error ? reject(error) : resolve(String(stdout).trim())));
  });
}

function createGitUpdates({ root = join(__dirname, '..'), run = git, node = process.execPath,
  findNpm = npmCli, npm = runNpm } = {}) {
  let target = null;   // { sha, ref } from the last successful check

  async function check() {
    target = null;
    let ref;
    try { ref = await run(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']); }
    catch { return { state: 'error', error: 'This checkout\'s branch does not track a remote branch, so there is nothing to update from.' }; }
    const slash = ref.indexOf('/');
    const remote = ref.slice(0, slash), branch = ref.slice(slash + 1);
    try { await run(root, ['fetch', '--quiet', remote, branch]); }
    catch { return { state: 'error', error: `Could not fetch ${ref}. Check the connection and try again.` }; }
    const [head, sha] = await Promise.all([run(root, ['rev-parse', 'HEAD']), run(root, ['rev-parse', ref])]);
    const behind = head === sha ? 0 : Number(await run(root, ['rev-list', '--count', `HEAD..${ref}`]));
    if (!behind) return { state: 'current' };
    let version = '';
    try { version = JSON.parse(await run(root, ['show', `${ref}:package.json`])).version || ''; } catch {}
    const latestVersion = `${version ? `${version} · ` : ''}${sha.slice(0, 7)} (${behind} new commit${behind === 1 ? '' : 's'} on ${ref})`;
    const fastForward = await run(root, ['merge-base', '--is-ancestor', 'HEAD', ref]).then(() => true, () => false);
    if (!fastForward) {
      return { state: 'available', latestVersion, canInstall: false, instruction: `This checkout has commits that are not on ${ref}; update it by hand.` };
    }
    if (await run(root, ['status', '--porcelain', '--untracked-files=no'])) {
      return { state: 'available', latestVersion, canInstall: false, instruction: 'This checkout has uncommitted changes; commit or stash them, then update.' };
    }
    target = { sha, ref };
    return { state: 'available', latestVersion, canInstall: true };
  }

  const installer = {
    async capability() { return {}; },
    async install() {
      if (!target) throw new Error('Check for updates again before installing.');
      const { sha, ref } = target;
      const before = await run(root, ['rev-parse', 'HEAD']);
      try { await run(root, ['merge', '--ff-only', sha]); }
      catch { throw new Error(`Could not fast-forward to ${ref}. Update the checkout by hand.`); }
      target = null;
      const lockChanged = await run(root, ['diff', '--quiet', before, sha, '--', 'package-lock.json']).then(() => false, () => true);
      if (!lockChanged) return;
      const cli = findNpm(node);
      if (!cli) throw new Error(`The code is updated, but npm was not found. Run npm ci in ${root}, then restart CliDeck.`);
      try { await npm(node, cli, ['ci', '--prefix', root, '--no-audit', '--no-fund'], 600_000); }
      catch { throw new Error(`The code is updated, but npm ci failed. Run npm ci in ${root}, then restart CliDeck.`); }
    },
  };

  return { check, installer };
}

module.exports = { createGitUpdates, git };
