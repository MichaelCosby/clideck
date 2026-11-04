const test = require('node:test');
const assert = require('node:assert/strict');
const { assertMenuClickable, closeBrowser, openApp } = require('./harness');

test.after(closeBrowser);

async function openSettings(page, category) {
  await page.click('#settings-btn');
  await page.locator('.set-modal').waitFor();
  if (category) await page.locator('.set-cat', { hasText: category }).click();
}

test('every Settings section opens', async (t) => {
  const app = await openApp(t);
  await openSettings(app.page);
  for (const label of await app.page.locator('.set-cat').allInnerTexts()) {
    await app.page.locator('.set-cat', { hasText: label }).click();
    await app.page.locator('.set-cat.on', { hasText: label }).waitFor();
  }
  await app.page.click('.set-x');
  await app.page.locator('.set-modal').waitFor({ state: 'detached' });
  app.assertNoErrors();
});

// The bug that started this suite: the menu was drawn under the Settings dialog, so it showed but ignored clicks,
// and the installed-agents check rebuilt the pane and closed it.
test('"+ Add agent" opens a menu above Settings and adds the chosen agent', async (t) => {
  const app = await openApp(t);
  await openSettings(app.page, 'CLI Agents');
  await app.page.click('button.set-add');
  await app.page.locator('.set-add-item').first().waitFor();
  // Opening Settings starts a check of which agents are installed, and its answer can arrive seconds later. Ask
  // for one now, with the menu open: the answer must not close it.
  await app.page.evaluate(() => import('/js/ws.js').then((ws) => ws.checkAvailability()));
  await app.page.waitForTimeout(1500);
  assert.equal(await app.page.locator('.set-add-item').count() > 0, true, 'the menu is still open');
  await assertMenuClickable(app.page, '.set-add-item');
  await app.page.locator('.set-add-item', { hasText: 'Claude' }).click();
  await app.page.locator('.set-card').first().waitFor();
  assert.equal(await app.page.locator('.set-card').count(), 1);
  app.assertNoErrors();
});

test('a custom agent\'s icon menu opens above Settings and changes the icon', async (t) => {
  const app = await openApp(t);
  await openSettings(app.page, 'CLI Agents');
  await app.page.click('button.set-add');
  await app.page.locator('.set-add-item', { hasText: 'Custom' }).click();
  await app.page.locator('.set-card').first().waitFor();
  const before = await app.page.locator('.set-card-ic').first().innerHTML();
  await app.page.locator('.set-card-ic').first().click();
  await app.page.locator('.menu').waitFor();
  await assertMenuClickable(app.page, '.menu button');
  const icons = app.page.locator('.menu button');
  assert.ok(await icons.count() > 1, 'icons are offered');
  await icons.nth(1).click();
  assert.notEqual(await app.page.locator('.set-card-ic').first().innerHTML(), before, 'the icon changed');
  app.assertNoErrors();
});
