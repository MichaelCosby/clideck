const test = require('node:test');
const assert = require('node:assert/strict');
const { assertMenuClickable, closeBrowser, openApp, waitFor } = require('./harness');

test.after(closeBrowser);

// Start a session from the "+" picker the way a person does, then use it.
async function startShell(app, name) {
  const { page, work } = app;
  await page.click('#new-btn');
  await page.locator('.pv-form').waitFor();
  await page.selectOption('.pv-project-select', '__none__');
  await page.fill('.pv-path-input', work);
  await page.fill('.pv-name-input', name);
  await page.locator('.pv-opt', { hasText: 'shell' }).first().click();
  await page.locator(`.row:has-text("${name}")`).waitFor();
  await page.locator('.xterm').waitFor();
}

test('a shell session started from the + picker runs what you type', async (t) => {
  const app = await openApp(t);
  await startShell(app, 'typing');
  await app.page.locator('.xterm').click();
  await app.page.keyboard.type('echo READY_$((20+22))\n');
  await waitFor(async () => (await app.page.locator('.xterm-rows').innerText()).includes('READY_42'), 'the echo');
  app.assertNoErrors();
});

test('the session menu opens from the row and its items can be clicked', async (t) => {
  const app = await openApp(t);
  await startShell(app, 'menus');
  const row = app.page.locator('.row:has-text("menus")');
  await row.hover();
  await row.locator('.r-menu-btn').click();
  await app.page.locator('.menu').waitFor();
  await assertMenuClickable(app.page);
  const items = await app.page.locator('.menu [role=menuitem]').allInnerTexts();
  assert.ok(items.some((text) => /Rename/.test(text)), `Rename is offered (${items.join(', ')})`);
  app.assertNoErrors();
});

test('right-clicking the terminal gives a text menu that can be clicked', async (t) => {
  const app = await openApp(t);
  await startShell(app, 'termmenu');
  await app.page.locator('.xterm').click({ button: 'right' });
  await app.page.locator('.menu').waitFor();
  await assertMenuClickable(app.page);
  const items = await app.page.locator('.menu [role=menuitem]').allInnerTexts();
  assert.ok(items.some((text) => /Paste/.test(text)), `Paste is offered (${items.join(', ')})`);
  app.assertNoErrors();
});
