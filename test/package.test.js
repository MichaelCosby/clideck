const test = require('node:test');
const assert = require('node:assert/strict');
const pkg = require('../package.json');

// npm versions that block install scripts by default record the permission against an exact version. A checkout
// whose package.json npm had to edit is no longer clean, and the in-app updater refuses to update it.
test('the install-script permission names the node-pty version that is installed', () => {
  assert.deepEqual(pkg.allowScripts, { [`node-pty@${pkg.dependencies['node-pty']}`]: true });
});
