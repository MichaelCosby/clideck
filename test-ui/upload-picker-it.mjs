// IT — Upload file… opens a file chooser and uploads the chosen files through the drop path.
import { installFakeDom } from "./fakedom.mjs";
installFakeDom();
const add = (tag, id, parent = document.body) => { const node = document.createElement(tag); node.id = id; parent.appendChild(node); return node; };
for (const id of ["term", "term-head", "th-avatar", "th-chip", "th-copy", "th-meta", "th-model", "th-name", "th-rename", "rp", "rp-empty", "rp-empty-big", "rp-empty-sub", "scroll-btn", "th-context", "th-context-fill", "th-context-value", "th-last", "th-last-value"]) add("div", id);
globalThis.getComputedStyle = () => ({ paddingLeft: "0", paddingRight: "0", paddingTop: "0", paddingBottom: "0" });
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.location = { host: "fake" };

const sent = [];
globalThis.WebSocket = class { static OPEN = 1; constructor() { this.readyState = 1; } send(text) { sent.push(JSON.parse(text)); } close() {} };
const uploads = [];
globalThis.XMLHttpRequest = class {
  open(method, url) { this.method = method; this.url = url; }
  send(body) {
    const name = new URL(this.url, "http://x").searchParams.get("name");
    uploads.push({ method: this.method, name, body });
    this.status = 200; this.responseText = JSON.stringify({ ok: true, name, path: "/work/" + name });
    queueMicrotask(() => this.onload());
  }
};

class FakeTerminal {
  constructor(options) {
    this.options = { ...options }; this.cols = options.cols; this.rows = options.rows; this.modes = { bracketedPasteMode: true };
    this.buffer = { active: { viewportY: 0, baseY: 0, getLine: () => null } };
    this._core = { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } }, viewport: { scrollBarWidth: 0 } };
    this.parser = { registerOscHandler() {} };
  }
  open(host) { const vp = add("div", "", host); vp.className = "xterm-viewport"; this.textarea = add("textarea", "", host); }
  attachCustomKeyEventHandler() {} onData() {} onSelectionChange() {} onScroll() {} onResize() { return { dispose() {} }; } registerLinkProvider() {} reset() {} clear() {}
  hasSelection() { return false; } write(_data, done) { done?.(); } resize(cols, rows) { this.cols = cols; this.rows = rows; }
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
store.applyEvent({ type: "session.created", sessionId: "S", provider: "claude-code", name: "S", cwd: "/work", live: true });
store.select("S");
const inputs = () => sent.filter((m) => m.type === "input");
const paste = (clipboardData) => {
  const event = { clipboardData, defaultPrevented: false };
  event.preventDefault = () => { event.defaultPrevented = true; };
  document.getElementById("term")._fire("paste", event);
  return event;
};

store.setConnected(true);   // the fake socket never fires onopen
const { pickAndUpload } = await import("../public/js/ui/drop.js");
pickAndUpload();
const picker = [...document.body.children].reverse().find((el) => el.type === "file");
picker.files = [new File(["log"], "build.log", { type: "text/plain" })];
picker._fire("change");
await sleep(20);
ok("Upload file… sends the chosen files and removes its picker", uploads.at(-1)?.name === "build.log" && !picker.parentNode);
ok("and pastes the saved path into the terminal", sent.some((m) => m.type === "input" && String(m.data).includes("/work/build.log")));

const failed = checks.filter(([, pass]) => !pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
