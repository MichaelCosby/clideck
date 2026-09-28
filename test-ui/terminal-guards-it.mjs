// IT — the real terminal pane holds a quick second Ctrl+L in Claude Code sessions behind a toast, and copies
// selections to the clipboard only for providers / custom commands that opted into copy-on-select.
import { installFakeDom } from "./fakedom.mjs";
installFakeDom();
const add = (tag, id, parent = document.body) => { const node = document.createElement(tag); node.id = id; parent.appendChild(node); return node; };
for (const id of ["term", "term-head", "th-avatar", "th-chip", "th-copy", "th-meta", "th-model", "th-name", "th-rename", "rp", "rp-empty", "rp-empty-big", "rp-empty-sub", "scroll-btn", "th-context", "th-context-fill", "th-context-value", "th-last", "th-last-value"]) add("div", id);
globalThis.getComputedStyle = () => ({ paddingLeft: "0", paddingRight: "0", paddingTop: "0", paddingBottom: "0" });
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.location = { host: "fake" };

const sent = [];
globalThis.WebSocket = class { static OPEN = 1; constructor() { this.readyState = 1; } send(text) { sent.push(JSON.parse(text)); } close() {} };
const copied = [];
Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async (text) => { copied.push(text); } } }, configurable: true });

let term = null;
class FakeTerminal {
  constructor(options) {
    term = this; this.options = { ...options }; this.cols = options.cols; this.rows = options.rows; this.modes = { bracketedPasteMode: true };
    this.buffer = { active: { viewportY: 0, baseY: 0, getLine: () => null } };
    this._core = { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } }, viewport: { scrollBarWidth: 0 } };
    this.parser = { registerOscHandler() {} };
    this.selection = "";
  }
  open(host) { const vp = add("div", "", host); vp.className = "xterm-viewport"; this.textarea = add("textarea", "", host); }
  attachCustomKeyEventHandler() {} onScroll() {} onResize() { return { dispose() {} }; } registerLinkProvider() {} reset() {} clear() {}
  onData(fn) { this.dataHandler = fn; }
  onSelectionChange(fn) { this.selectionHandler = fn; }
  hasSelection() { return !!this.selection; } getSelection() { return this.selection; }
  write(_data, done) { done?.(); } resize(cols, rows) { this.cols = cols; this.rows = rows; }
  scrollToBottom() {} focus() {}
}
window.Terminal = FakeTerminal;

const { store } = await import("../public/js/store.js");
const { connectWs } = await import("../public/js/ws.js");
const { initTerminal } = await import("../public/js/ui/terminal.js");
const checks = [];
const ok = (name, pass) => { checks.push([name, !!pass]); console.log((pass ? "  ok   " : "  FAIL ") + name); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

initTerminal();
connectWs();
const inputs = () => sent.filter((m) => m.type === "input").map((m) => m.sessionId + ":" + JSON.stringify(m.data));
const created = (id, provider, extra = {}) => store.applyEvent({ type: "session.created", sessionId: id, provider, name: id, cwd: "/tmp", live: true, ...extra });

created("C", "claude-code");
store.select("C");
term.dataHandler("\x0c");
ok("a single Ctrl+L reaches Claude Code", inputs().join() === 'C:"\\f"');
term.dataHandler("\x0c");
const held = document.getElementById("toast-ctrl-l");
ok("a quick second Ctrl+L is held behind a toast", inputs().length === 1 && !!held);
held._fire("click");
ok("clicking the toast sends the held Ctrl+L", inputs().length === 2 && inputs()[1] === 'C:"\\f"');
term.dataHandler("\x0c");
ok("the next Ctrl+L starts a fresh window and passes", inputs().length === 3);

created("S", "shell");
store.select("S");
term.dataHandler("\x0c"); term.dataHandler("\x0c");
ok("other providers never hold Ctrl+L", inputs().filter((v) => v.startsWith("S:")).length === 2);

term.selection = "hello";
term.selectionHandler(); await sleep(200);
ok("copy-on-select is off by default", copied.length === 0);
store.setCopyOnSelectProviders(["shell"]);
term.selectionHandler(); await sleep(200);
ok("an opted-in provider copies the selection", copied.join() === "hello");
term.selection = "";
term.selectionHandler(); await sleep(200);
ok("clearing the selection copies nothing", copied.length === 1);

created("X", "shell", { commandId: "mine" });
store.select("X");
store.setCommands([{ id: "mine", label: "Mine", command: "bash", copyOnSelect: false }]);
term.selection = "custom";
term.selectionHandler(); await sleep(200);
ok("a custom command's own setting wins over its provider's", copied.length === 1);
store.setCommands([{ id: "mine", label: "Mine", command: "bash", copyOnSelect: true }]);
term.selectionHandler(); await sleep(200);
ok("a custom command that opted in copies", copied.at(-1) === "custom");

const failed = checks.filter(([, pass]) => !pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
