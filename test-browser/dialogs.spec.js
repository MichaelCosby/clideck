const test = require('node:test');
const assert = require('node:assert/strict');
const { closeBrowser, openApp } = require('./harness');

test.after(closeBrowser);

async function startShell(app, name) {
  const { page, work } = app;
  await page.click('#new-btn');
  await page.locator('.pv-form').waitFor();
  await page.selectOption('.pv-project-select', '__none__');
  await page.fill('.pv-path-input', work);
  await page.fill('.pv-name-input', name);
  await page.locator('.pv-opt', { hasText: 'shell' }).first().click();
  await page.locator('.xterm').waitFor();
}

// A dialog is usable when it is on top: the middle of its panel is the panel, not something drawn over it.
async function assertOnTop(page, overlaySelector) {
  const result = await page.evaluate((selector) => {
    const overlay = document.querySelector(selector);
    if (!overlay) return 'not open';
    const panel = overlay.firstElementChild || overlay;
    const box = panel.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + Math.min(40, box.height / 2));
    return overlay.contains(hit) ? '' : `covered by ${hit ? hit.className || hit.tagName : 'nothing'}`;
  }, overlaySelector);
  assert.equal(result, '', `${overlaySelector} is on top`);
}

const DIALOGS = [
  { name: 'Prompt library', open: '#prompts-btn', overlay: '.pl-overlay' },
  { name: 'Task Manager', open: '#task-manager', overlay: '.tasks-overlay' },
  { name: 'Conversation history', open: '#th-history', overlay: '.hist-overlay' },
];

for (const dialog of DIALOGS) {
  test(`${dialog.name} opens on top and closes with Escape`, async (t) => {
    const app = await openApp(t);
    await startShell(app, 'dialogs');
    await app.page.click(dialog.open);
    await app.page.locator(dialog.overlay).waitFor();
    await assertOnTop(app.page, dialog.overlay);
    await app.page.keyboard.press('Escape');
    await app.page.locator(dialog.overlay).waitFor({ state: 'detached' });
    app.assertNoErrors();
  });
}
