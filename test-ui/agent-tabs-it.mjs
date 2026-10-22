// IT — when a document comes to the front. Before, every content.show took the pane: an agent re-showing a
// report it was editing pulled the user off the terminal each time, and a reconnect's replay left each session
// on its newest document. Now the Settings ▸ Behavior choice (first time by default) governs agent content,
// files the user opens always come forward, and a replay reopens exactly the tab that was open.
import { installFakeDom } from "./fakedom.mjs";
installFakeDom();
const main = document.createElement("div"); document.body.appendChild(main);
const mk = (id) => { const e = document.createElement("div"); e.id = id; main.appendChild(e); return e; };
mk("pane-tabs"); const paneBody = mk("pane-body");
const termPanel = document.createElement("div"); termPanel.id = "term-panel"; paneBody.appendChild(termPanel);
globalThis.fetch = () => Promise.resolve({ text: () => Promise.resolve("text"), json: () => Promise.resolve({}) });

const { store } = await import("../public/js/store.js");
const { initContentViewer } = await import("../public/js/ui/content-viewer.js");
const { showDocument } = await import("../public/js/ui/content-dock.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
const tabs = () => [...document.querySelectorAll(".cd-tab")].filter((t) => !t.className.includes("cd-tab-term"));
const onTab = () => { const t = document.querySelector(".cd-tab.on"); return t ? (t.className.includes("cd-tab-term") ? "terminal" : t.querySelector(".cd-tab-name").textContent) : null; };
const dotted = (name) => !!tabs().find((t) => t.querySelector(".cd-tab-name").textContent === name)?.querySelector(".cd-tab-new");
const show = (o) => store.applyEvent({ type: "content.show", kind: "text", url: "/content/" + o.contentId, ...o });
const mode = (m) => store.applyEvent({ type: "config", config: { switchToAgentTabs: m } });
const terminal = () => document.querySelector(".cd-tab-term")._fire("click");
const sessions = () => {
  store.applyEvent({ type: "session.created", sessionId: "A", cwd: "/a", name: "alpha", live: true, pid: 1 });
  store.applyEvent({ type: "session.created", sessionId: "B", cwd: "/b", name: "beta", live: true, pid: 2 });
};

sessions();
initContentViewer();
ok("the default is the first time", store.switchToAgentTabs === "first");

// first time
show({ sessionId: "A", contentId: "r1", name: "report.txt" }); await flush();
ok("first time: a new tab comes to the front", onTab() === "report.txt");
terminal(); await flush();
show({ sessionId: "A", contentId: "r2", name: "report.txt", replaces: "r1" }); await flush();
ok("first time: showing it again updates the tab and leaves the terminal in front", onTab() === "terminal" && tabs().length === 1);
ok("…and marks the tab with a dot", dotted("report.txt"));
tabs()[0]._fire("click"); await flush();
ok("opening the tab clears the dot", onTab() === "report.txt" && !dotted("report.txt"));
show({ sessionId: "A", contentId: "r3", name: "report.txt", replaces: "r2" }); await flush();
ok("a re-show of the tab on screen stays on screen", onTab() === "report.txt" && !dotted("report.txt"));

// always
mode("always"); terminal(); await flush();
show({ sessionId: "A", contentId: "r4", name: "report.txt", replaces: "r3" }); await flush();
ok("every time: a re-show comes to the front", onTab() === "report.txt");

// never
mode("never"); terminal(); await flush();
show({ sessionId: "A", contentId: "n1", name: "notes.txt" }); await flush();
ok("never: a new tab waits behind the terminal, with a dot", onTab() === "terminal" && dotted("notes.txt"));
show({ sessionId: "A", contentId: "u1", name: "mine.txt", openedBy: "user" }); await flush();
ok("a file the user opened comes to the front whatever the setting", onTab() === "mine.txt" && !dotted("mine.txt"));

// another session
mode("always");
show({ sessionId: "B", contentId: "b1", name: "elsewhere.txt" }); await flush();
store.select("B"); await flush();
ok("content shown in another session never moves that session's tab", onTab() === "terminal" && dotted("elsewhere.txt"));
store.select("A"); await flush();
show({ sessionId: "B", contentId: "b2", name: "second.txt" }); await flush();
showDocument("B", "b2"); store.select("B"); await flush();
ok("the toast's click opens that document", onTab() === "second.txt");
show({ sessionId: "A", contentId: "u2", name: "dropped.txt", openedBy: "user" }); await flush();
store.select("A"); await flush();
ok("a file opened in A from another browser leaves this browser's A tab alone, with a dot", onTab() === "mine.txt" && dotted("dropped.txt"));
store.select("B"); await flush();

// a reconnect: reset, then the engine replays every document
store.select("A"); await flush();
showDocument("A", "n1"); await flush();
ok("A is on notes.txt before the reconnect", onTab() === "notes.txt");
const replay = () => {
  store.reset(); sessions();
  for (const [sessionId, contentId, name] of [["A", "r4", "report.txt"], ["A", "n1", "notes.txt"], ["A", "u1", "mine.txt"], ["B", "b1", "elsewhere.txt"], ["B", "b2", "second.txt"]]) {
    show({ sessionId, contentId, name, replay: true });
  }
  store.applyEvent({ type: "transcript.cache", cache: {} });
};
store.reset(); replay(); await flush();
ok("after a reconnect (even after two resets) A reopens the tab it was on, not the last one replayed", store.activeId === "A" && onTab() === "notes.txt");
ok("…and a replay marks nothing as new", tabs().every((t) => !t.querySelector(".cd-tab-new")));
store.select("B"); await flush();
ok("…and B reopens its tab too", onTab() === "second.txt");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
