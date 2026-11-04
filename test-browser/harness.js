// Real-browser tests: a real engine, a real Chromium page, real mouse clicks at real screen positions. The
// fake-DOM tests in test-ui call handlers directly, so they cannot see that a button is covered, a menu opens
// under a dialog, or a layout pushes something off screen. Playwright's click refuses an element that would not
// receive the click, which is exactly the class of bug those tests miss.
//
// Run with `npm run test:browser`. The browser is found in this order: CLIDECK_TEST_CHROME, Playwright's own
// download, then any Chromium in the Playwright cache, then a system Chrome/Chromium.
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { homedir, tmpdir } = require('node:os');
const { join } = require('node:path');
const { chromium } = require('playwright-core');
const { HeadlessServer } = require('../src/server');

function findChrome() {
  const candidates = [process.env.CLIDECK_TEST_CHROME];
  try { candidates.push(chromium.executablePath()); } catch {}
  const cache = join(homedir(), '.cache', 'ms-playwright');
  try {
    for (const dir of readdirSync(cache).filter((name) => name.startsWith('chromium-')).sort().reverse()) {
      candidates.push(join(cache, dir, 'chrome-linux', 'chrome'), join(cache, dir, 'chrome-linux64', 'chrome'),
        join(cache, dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'));
    }
  } catch {}
  candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  const found = candidates.find((path) => path && existsSync(path));
  if (!found) throw new Error('No Chromium found. Set CLIDECK_TEST_CHROME to a Chrome or Chromium executable.');
  return found;
}

let browserPromise = null;
function browser() {
  browserPromise ||= chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
  return browserPromise;
}

async function closeBrowser() {
  if (browserPromise) await (await browserPromise).close();
  browserPromise = null;
}

// A fresh engine and page. The tour and first-run tips are marked seen so they do not cover the UI.
async function openApp(t, { config = {}, viewport = { width: 1300, height: 860 } } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-browser-'));
  const work = mkdtempSync(join(tmpdir(), 'clideck-browser-work-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    onboarding: { completed: true, seenTips: ['guided-tour', 'about-me'] },
    ...config,
  }));
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  const { httpUrl } = await server.listen();
  const context = await (await browser()).newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(`page error: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console error: ${message.text()}`); });
  t.after(async () => {
    await context.close();
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });
  await page.goto(httpUrl);
  await page.locator('#new-btn').waitFor();
  return {
    page, server, work, errors,
    // Every test ends with this: an error in the browser console is a failure even if the flow looked right.
    assertNoErrors() { assert.deepEqual(errors, [], 'the browser reported errors'); },
  };
}

// A popup menu is only usable if what is drawn is what gets clicked: check that each item's centre hits the
// item itself, not a dialog or panel drawn over it.
async function assertMenuClickable(page, itemSelector = '.menu [role=menuitem], .menu button') {
  const covered = await page.evaluate((selector) => [...document.querySelectorAll(selector)]
    .filter((item) => item.offsetParent !== null)
    .map((item) => {
      const box = item.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return item.contains(hit) ? null : `${item.textContent.trim().slice(0, 40)} → covered by ${hit ? hit.className || hit.tagName : 'nothing'}`;
    })
    .filter(Boolean), itemSelector);
  assert.deepEqual(covered, [], 'menu items are covered');
}

async function waitFor(check, what, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

module.exports = { assertMenuClickable, closeBrowser, openApp, waitFor };
