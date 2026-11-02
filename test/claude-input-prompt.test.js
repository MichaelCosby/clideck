const test = require('node:test');
const assert = require('node:assert/strict');
const { hasInputPrompt, hasSettledPrompt } = require('../src/claude-screen');

const rule = '─'.repeat(100);
const screen = (promptLine) => ['', rule, promptLine, rule, '  [C2]  Opus 5.5  docraven', '  ⏵⏵ auto mode on (shift+tab to cycle)'];

test('an empty prompt is an input prompt', () => {
  assert.equal(hasInputPrompt(screen('❯ ')), true);
  assert.equal(hasInputPrompt(screen('❯')), true);
});

test('the suggestion Claude greys into a fresh prompt does not hide it', () => {
  assert.equal(hasInputPrompt(screen('❯ Try "how does gpu_training.tf work?"')), true);
  assert.equal(hasInputPrompt(screen('❯ Try "fix lint errors"')), true);
  assert.equal(hasSettledPrompt(screen('❯ Try "write a test for <filepath>"')), true);
});

test('text the user has typed is still not an empty prompt', () => {
  assert.equal(hasInputPrompt(screen('❯ please look at the build')), false);
  assert.equal(hasInputPrompt(screen('❯ Try this instead')), false);
  assert.equal(hasInputPrompt(screen('❯ Try "partly typed')), false);
});
