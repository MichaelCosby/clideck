const test = require('node:test');
const assert = require('node:assert/strict');

test('speech block recognition preserves ordinary prose and avoids treating pipes alone as tables', async () => {
  const { speechBlocks } = await import('../plugins/supertonic/public/speech-blocks.js');
  for (const text of ['Choose A | B.\nKeep going.', '# Heading\n\n- first\n- second', 'a | b\nnot a separator', '']) {
    const parts = speechBlocks(text);
    assert(parts.every(part => !part.notice));
    assert.equal(parts.map(part => text.slice(part.start, part.end)).join(''), text);
  }
});

test('fences, rendered tables, formulas and unterminated blocks stay out of speech', async () => {
  const { speechBlocks } = await import('../plugins/supertonic/public/speech-blocks.js');
  for (const [source, kind] of [
    ['~~~js\ncode();\n~~~', 'code block'],
    ['````md\n```\nsecret\n```\n````', 'code block'],
    ['```mermaid\ngraph TD\n```', 'diagram'],
    ['```python\nnever closed\nmore code', 'code block'],
    ['a | b\n:--- | ---:\n1 | 2', 'table'],
    ['┌────┬────┐\n│ a  │ b  │\n├────┼────┤\n│ 1  │ 2  │\n└────┴────┘', 'table'],
    ['$$\na = b^2\n$$', 'formula'],
  ]) {
    assert.deepEqual(speechBlocks(source), [{ start: 0, end: source.length, notice: `See the ${kind} in the conversation.` }]);
  }
});

test('inline Markdown keeps readable words and original read-along spans', async () => {
  const { normalizeTextWithRanges } = await import('../plugins/supertonic/public/tts-normalizer.js');
  const source = '# Heading\n\n**Important** and _helpful_.\n- [x] Keep `flag_name`.\n[Report](https://example.com/report)\n![Chart](chart.png)';
  const result = normalizeTextWithRanges(source, [], 'off');
  assert.match(result.text, /^Heading/);
  assert.match(result.text, /Important and helpful/);
  assert.match(result.text, /Keep flag_name/);
  assert.match(result.text, /Report \(see the link in the conversation\)/);
  assert.match(result.text, /See the image in the conversation/);
  assert.doesNotMatch(result.text, /https:|chart.png|\[x\]|\*\*|`/);
  assert.equal(result.ranges.length, result.text.length);
  for (const range of result.ranges) assert(range.start >= 0 && range.end > range.start && range.end <= source.length);
  for (const plain of ['foo_bar a*b issue#12', 'x < y and x > 2', '1. First item', 'Use $50, not $60.']) {
    assert.equal(normalizeTextWithRanges(plain, [], 'off').text, plain);
  }
});
