const test = require('node:test');
const assert = require('node:assert/strict');
const { closeBrowser, openApp, waitFor } = require('./harness');

test.after(closeBrowser);

// A dropped connection used to wipe the store and rebuild every row and the terminal, which looked like a page
// reload. Now the page keeps what it shows and the reconnect only fills in what changed.
test('a dropped connection reconnects without rebuilding the page', async (t) => {
  const app = await openApp(t);
  const { page, server, work } = app;
  await page.click('#new-btn');
  await page.locator('.pv-form').waitFor();
  await page.selectOption('.pv-project-select', '__none__');
  await page.fill('.pv-path-input', work);
  await page.fill('.pv-name-input', 'steady');
  await page.locator('.pv-opt', { hasText: 'shell' }).first().click();
  await page.locator('.row:has-text("steady")').waitFor();
  await page.locator('.xterm').click();
  await page.keyboard.type('echo BEFORE_$((40+2))\n');
  const screen = () => page.locator('.xterm-rows').innerText();
  await waitFor(async () => (await screen()).includes('BEFORE_42'), 'the first echo');

  // Mark the row's DOM node: a rebuilt sidebar would drop the mark with the old node.
  await page.evaluate(() => { document.querySelector('.row').dataset.probe = 'kept'; });
  const opened = server.connectionSeq;

  // Output that lands while the socket is down, then the drop itself (from the engine's side, like the network).
  await page.keyboard.type('sleep 0.5; echo GAP_$((3+4))\n');
  for (const socket of server.clients) socket.terminate();
  await waitFor(async () => server.connectionSeq > opened && server.clients.size > 0, 'the page to reconnect');

  await waitFor(async () => (await screen()).includes('GAP_7'), 'the output sent during the drop');
  const probe = await page.evaluate(() => document.querySelector('.row')?.dataset.probe || '');
  assert.equal(probe, 'kept', 'the sidebar row is the same element, not rebuilt');
  assert.ok((await screen()).includes('BEFORE_42'), 'the earlier output is still on screen');
  app.assertNoErrors();
});
