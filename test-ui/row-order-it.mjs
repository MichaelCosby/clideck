// IT — the real sidebar orders rows by status (needs-you, working, idle, stopped) with pinned rows first, and
// holds the order still while the pointer is over the list.
import { installFakeDom } from "./fakedom.mjs";
const dom = installFakeDom();
function mkEl(id) { const e = document.createElement("div"); e.id = id; return e; }
const list = mkEl("list"); list.appendChild(mkEl("list-empty")); document.body.appendChild(list);
for (const id of ["tab-all", "tab-unread", "search", "search-clear", "notify-btn", "prompts-btn", "settings-btn", "proj-btn", "unread-cnt", "conn", "conn-text", "save-ind", "new-btn"]) document.body.appendChild(mkEl(id));
const sideHead = document.createElement("div"); sideHead.className = "side-head"; const nw = document.createElement("div"); nw.className = "new-wrap"; sideHead.appendChild(nw); document.body.appendChild(sideHead);

const { store } = await import("../public/js/store.js");
const { initSidebar } = await import("../public/js/ui/sidebar.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const live = (id) => store.applyEvent({ type: "session.created", sessionId: id, protocol: 1, provider: "claude-code", name: id, pid: 1, cwd: "/w", cols: 80, rows: 24, live: true, projectId: null });
const status = (id, state) => store.applyEvent({ type: "status", sessionId: id, state });
const row = (id) => dom.all("row").find((r) => r.dataset.id === id);
const order = () => [...row("A").parentNode.children].filter((c) => c._cls.has("row")).map((c) => c.dataset.id);

try {
  initSidebar();
  for (const id of ["A", "B", "C", "D"]) { live(id); status(id, "idle"); }
  await sleep(10);
  ok("rows start in arrival order", order().join() === "A,B,C,D");

  status("C", "working");
  await sleep(10);
  ok("a working row moves above idle ones", order().join() === "C,A,B,D");

  store.applyEvent({ type: "menu", sessionId: "D", choices: ["1", "2"], context: "Allow?" });
  await sleep(10);
  ok("a row that needs you goes to the top", order().join() === "D,C,A,B");

  list._fire("pointerenter");
  status("B", "working");
  await sleep(10);
  ok("the order holds while the pointer is over the list", order().join() === "D,C,A,B");
  list._fire("pointerleave");
  await sleep(10);
  ok("and catches up when the pointer leaves, newest worker first", order().join() === "D,B,C,A");

  store.setPinnedSessions(["A"]);
  await sleep(10);
  ok("a pinned row sits above everything", order()[0] === "A" && row("A")._cls.has("pinned"));
  ok("the last pinned row carries the divider", row("A")._cls.has("pin-last"));

  store.setPinnedSessions(["B", "A"]);
  await sleep(10);
  ok("pinned rows follow pin order", order().slice(0, 2).join() === "B,A" && !row("B")._cls.has("pin-last") && row("A")._cls.has("pin-last"));

  store.setPinnedSessions([]);
  await sleep(10);
  ok("unpinning returns rows to status order", !row("A")._cls.has("pinned") && order().join() === "D,B,C,A");
} catch (e) { fail++; console.log("  THREW " + (e && e.stack || e)); }
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
