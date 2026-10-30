// Identify blocks before speech chunking: a large table/fence must never leak
// into speech just because it crosses a model or playback chunk boundary.
// Offsets stay in the original text so prose after a skipped block still tracks.
export function speechBlocks(source) {
  const lines = [];
  let offset = 0;
  for (const text of source.split('\n')) {
    lines.push({ text: text.replace(/\r$/, ''), start: offset });
    offset += text.length + 1;
  }
  const result = [];
  let proseStart = 0;
  const tableDivider = line => {
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
    return cells.length >= 2 && cells.every(cell => /^\s*:?-{3,}:?\s*$/.test(cell));
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].text;
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    let end = i, kind = '';
    if (fence) {
      kind = /^(mermaid|graphviz|dot)\b/i.test(fence[2].trim()) ? 'diagram' : 'code block';
      const close = new RegExp('^ {0,3}' + fence[1][0] + '{' + fence[1].length + ',}\\s*$');
      while (++end < lines.length && !close.test(lines[end].text)) {}
    } else if (line.includes('|') && tableDivider(lines[i + 1]?.text || '')) {
      kind = 'table'; end = i + 1;
      while (end + 1 < lines.length && lines[end + 1].text.includes('|') && lines[end + 1].text.trim()) end++;
    } else if (/^\s*[┌╭╔][─━═┬╤╦]+[┐╮╗]\s*$/.test(line)) {
      kind = 'table';
      while (end + 1 < lines.length && /^\s*[│┃║├┝┠┼╞╟╠└╰╚]/.test(lines[end + 1].text)) end++;
    } else if (/^\s*\$\$\s*$/.test(line)) {
      kind = 'formula';
      while (++end < lines.length && !/^\s*\$\$\s*$/.test(lines[end].text)) {}
    }
    if (!kind) continue;
    const start = lines[i].start;
    const after = Math.min(source.length, lines[end + 1]?.start ?? source.length);
    if (start > proseStart) result.push({ start: proseStart, end: start });
    result.push({ start, end: after, notice: `See the ${kind} in the conversation.` });
    proseStart = after; i = end;
  }
  if (proseStart < source.length) result.push({ start: proseStart, end: source.length });
  return result;
}
