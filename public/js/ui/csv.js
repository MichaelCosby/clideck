// Comma-only CSV. Bound both parsing work and rendered content; values remain strings.
import { h } from "../util.js";
const MAX_ROWS = 501, MAX_COLUMNS = 50, MAX_CELLS = 10000, MAX_CHARS = 1000000, MAX_FIELD = 2000;
export function parseCsv(value) {
  const source = String(value ?? "").replace(/^\uFEFF/, "");
  const rows = []; let row = [], field = "", quoted = false, closed = false, started = false, clipped = false, limited = false, cells = 0, columns = 0;
  const append = c => { if (field.length < MAX_FIELD) field += c; else clipped = true; };
  const cell = () => { columns++; if (row.length < MAX_COLUMNS) row.push(field); else limited = true; field = ""; started = closed = false; };
  const record = () => { cell(); rows.push(row); cells += row.length; row = []; columns = 0; };
  const error = () => ({ rows: [], error: `Invalid quoting near record ${rows.length + 1}. Use double quotes around fields containing commas or line breaks, and double any quote inside a quoted field.` });
  let i = 0;
  for (; i < Math.min(source.length, MAX_CHARS); i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') { append('"'); i++; } else { quoted = false; closed = true; }
      } else { append(c); }
      continue;
    }
    if (c === ',' || c === '\n' || c === '\r') {
      if (c === ',') cell();
      else {
        record(); if (c === '\r' && source[i + 1] === '\n') i++;
        if ((rows.length >= MAX_ROWS || cells >= MAX_CELLS) && i + 1 < source.length) { limited = true; i++; break; }
      }
    } else if (closed) return error();
    else if (c === '"') { if (started) return error(); quoted = started = true; }
    else { started = true; append(c); }
  }
  if (i < source.length) limited = true; // Never claim the unparsed tail is valid or fully displayed.
  else {
    if (quoted) return error();
    if (started || closed || columns) record();
  }
  return { rows, limited, clipped };
}

export function renderCsv(value, item = {}) {
  const data = parseCsv(value), shell = h("section", "ct-csv");
  const head = h("div", "csv-head"), meta = h("span", "csv-meta");
  head.append(meta); shell.append(head);
  if (data.error || !data.rows.length) {
    meta.textContent = "CSV";
    const notice = h("div", "csv-notice"); notice.textContent = data.error || (data.limited ? "No complete record within the preview limit (1,000,000 characters)." : "This CSV file is empty.");
    if (data.error) notice.setAttribute("role", "alert"); shell.append(notice); return shell;
  }
  const label = h("label", "csv-header-toggle"), checkbox = h("input"); checkbox.type = "checkbox"; checkbox.checked = item.csvHeader !== false;
  const title = h("span"); title.textContent = "First row is header"; label.append(checkbox, title); head.append(label);
  const scroll = h("div", "csv-scroll"); scroll.tabIndex = 0; scroll.setAttribute("role", "region"); scroll.setAttribute("aria-label", "CSV table, scroll to see more");
  const notice = h("div", "csv-notice"); shell.append(scroll, notice);
  function draw() {
    const width = Math.max(...data.rows.map(r => r.length));
    const start = checkbox.checked ? 1 : 0, all = data.rows.slice(start), rows = all.slice(0, Math.min(500, Math.floor(MAX_CELLS / width)));
    const table = h("table", "csv-table"); table.setAttribute("aria-label", item.name || "CSV preview");
    const thead = h("thead"), tr = h("tr"), corner = h("th"); corner.textContent = "#"; corner.setAttribute("scope", "col"); tr.append(corner);
    for (let c = 0; c < width; c++) { const th = h("th"); th.setAttribute("scope", "col"); th.textContent = checkbox.checked ? data.rows[0][c] || `Column ${c + 1}` : `Column ${c + 1}`; tr.append(th); }
    thead.append(tr); table.append(thead);
    const tbody = h("tbody");
    rows.forEach((row, i) => {
      const tr = h("tr"), number = h("th"); number.setAttribute("scope", "row"); number.textContent = String(i + 1); tr.append(number);
      for (let c = 0; c < width; c++) { const td = h("td"); td.textContent = row[c] ?? ""; tr.append(td); }
      tbody.append(tr);
    });
    table.append(tbody); scroll.replaceChildren(table);
    const partial = data.limited || rows.length < all.length;
    meta.textContent = `CSV · ${rows.length} ${partial ? "shown rows" : "rows"} · ${width} columns`;
    const notes = [];
    if (partial) notes.push("Preview limited to 500 data rows, 50 columns, 10,000 cells and 1,000,000 source characters; remaining content is not shown or checked.");
    if (data.clipped) notes.push("Long values are shortened to 2,000 characters.");
    if (data.rows.some(r => r.length !== width)) notes.push("Rows have different field counts; missing cells are shown blank.");
    notice.textContent = notes.join(" "); notice.hidden = !notes.length;
  }
  checkbox.addEventListener("change", () => { item.csvHeader = checkbox.checked; draw(); }); draw(); return shell;
}
