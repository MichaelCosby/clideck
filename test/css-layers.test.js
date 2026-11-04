const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const { join } = require('path');

const css = readFileSync(join(__dirname, '../public/css/app.css'), 'utf8');

function rules() {
  const found = [];
  for (const match of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    found.push({ selector: match[1].trim(), body: match[2] });
  }
  return found;
}
const zIndex = (body) => Number((body.match(/z-index:\s*(-?\d+)/) || [])[1]);

// A popup menu drawn under the dialog that opened it can be seen but not clicked: the click lands on the dialog
// and closes the menu. That is how "+ Add agent" in Settings stopped working. Every full-screen layer a menu can
// be opened from must sit below menus.
test('popup menus stack above every full-screen overlay', () => {
  const menu = rules().find((rule) => rule.selector === '.menu' && /position:\s*fixed/.test(rule.body));
  assert.ok(menu, 'the .menu rule');
  const overlays = rules().filter((rule) => /position:\s*fixed/.test(rule.body) && /inset:\s*0/.test(rule.body)
    && Number.isFinite(zIndex(rule.body)));
  assert.ok(overlays.length >= 5, `found the overlays (${overlays.map((rule) => rule.selector).join(', ')})`);
  const above = overlays.filter((rule) => zIndex(rule.body) >= zIndex(menu.body));
  assert.deepEqual(above.map((rule) => `${rule.selector} (${zIndex(rule.body)})`), [],
    `.menu is at ${zIndex(menu.body)}; these overlays would cover a menu opened from them`);
});
