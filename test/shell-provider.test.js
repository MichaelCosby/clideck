const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultShell } = require('../src/shell-provider');

test('the shell is $SHELL, else the login shell, else zsh or sh', () => {
  const user = (shell) => () => ({ shell });
  const all = () => true;
  assert.equal(defaultShell({ SHELL: '/usr/bin/fish' }, user('/bin/bash'), all), '/usr/bin/fish');
  // Started by a process manager without $SHELL (the devbox's s6): the account's own shell.
  assert.equal(defaultShell({}, user('/bin/bash'), all), '/bin/bash');
  assert.equal(defaultShell({}, user('/bin/bash'), (path) => path === '/bin/zsh'), '/bin/zsh', 'a login shell that is missing is skipped');
  assert.equal(defaultShell({}, () => { throw new Error('no passwd entry'); }, () => false), 'sh');
  assert.equal(defaultShell({}, user(null), () => false), 'sh');
});
