const test = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { closeBrowser, openApp, waitFor } = require('./harness');

test.after(closeBrowser);

async function openMarkdown(app, markdown) {
  const { page, server, work } = app;
  await page.click('#new-btn');
  await page.locator('.pv-form').waitFor();
  await page.selectOption('.pv-project-select', '__none__');
  await page.fill('.pv-path-input', work);
  await page.fill('.pv-name-input', 'doc');
  await page.locator('.pv-opt', { hasText: 'shell' }).first().click();
  await page.locator('.row:has-text("doc")').waitFor();
  const path = join(work, 'notes.md');
  writeFileSync(path, markdown);
  const [sessionId] = server.sessions.keys();
  assert.ok(await server.openContent({ sessionId, path }), 'the file opened');
  await page.locator('.md-view').waitFor();
}

test('fenced code with a known language is syntax highlighted; other fences stay plain', async (t) => {
  const app = await openApp(t);
  await openMarkdown(app, [
    '# Notes', '',
    '```js title="x.js"', 'const answer = 42; // the answer', '```', '',
    '```nosuchlang', 'const plain = 1;', '```', '',
    '```', 'const bare = 2;', '```', '',
  ].join('\n'));
  const { page } = app;
  const js = page.locator('pre.md-code[data-lang^="js"] code');
  await waitFor(async () => (await js.locator('.hljs-keyword').count()) > 0, 'highlighted keywords');
  assert.equal(await js.locator('.hljs-comment').innerText(), '// the answer');
  assert.equal(await js.innerText(), 'const answer = 42; // the answer', 'highlighting keeps the text exactly');
  // The keyword takes a syntax colour, not the block's plain ink.
  const [keyword, plain] = await js.evaluate((code) => [
    getComputedStyle(code.querySelector('.hljs-keyword')).color, getComputedStyle(code).color]);
  assert.notEqual(keyword, plain);
  assert.equal(await page.locator('pre.md-code[data-lang="nosuchlang"] code span').count(), 0);
  assert.equal(await page.locator('pre.md-code:not([data-lang]) code span').count(), 0);
  app.assertNoErrors();
});
