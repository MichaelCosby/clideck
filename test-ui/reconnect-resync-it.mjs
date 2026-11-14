// IT — a reconnect keeps the UI instead of wiping it. A dropped network used to reset the store and rebuild every
// row and the terminal from the replay, which looked like a page reload. Now the first connect builds the store,
// later ones reconcile it in place, and the end of the burst (transcript.cache) clears what the replay left out.
import { installFakeDom, installFakeWs } from "./fakedom.mjs";
installFakeDom();
const ws = installFakeWs();
let socket; const FakeWS = globalThis.WebSocket;
globalThis.WebSocket = class extends FakeWS { constructor(...a) { super(...a); socket = this; } };
globalThis.WebSocket.OPEN = 1;
const { store } = await import("../public/js/store.js");
const { connectWs } = await import("../public/js/ws.js");
const { initContentDock, presentInDock } = await import("../public/js/ui/content-dock.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const tick = () => new Promise((r) => setTimeout(r, 5));
const recv = (ev) => socket.onmessage({ data: JSON.stringify(ev) });
const created = (id, live = true) => recv({ type: "session.created", sessionId: id, protocol: 1, provider: "claude-code", name: id, cwd: "/w", live, projectId: null });
const endBurst = () => recv({ type: "transcript.cache", cache: {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A socket that lived 2s+ was a real connection (shorter ones trip ws.js's stale-engine guard), then the retry.
const drop = async () => { await sleep(2100); socket.close(); await sleep(1600); };

const events = [];
for (const e of ["reset", "resync", "session:remove", "session:wentIdle"]) store.on(e, (...a) => events.push([e, ...a]));
const count = (e) => events.filter((x) => x[0] === e).length;

// ── first connect: a full build ──
connectWs(); await tick();
created("alpha"); created("beta"); created("gamma");
recv({ type: "status", sessionId: "alpha", state: "working" });
recv({ type: "menu", sessionId: "beta", choices: [{ label: "Yes" }], context: "Allow?" });
recv({ type: "agent.update", sessionId: "gamma", text: "reading files" });
endBurst();
ok("the first connect builds from a reset", count("reset") === 1 && count("resync") === 0);
store.select("beta");
const alpha = store.sessions.get("alpha");
alpha.outputBuf = "old screen"; alpha.historyState = "full";
store.sessions.get("beta").historyState = "loading"; store.sessions.get("beta").historyRequest = "h-dead";
store.sessions.get("alpha").unread = 2;
events.length = 0; ws.clear();

// ── the network drops; the socket reconnects ──
await drop();
ok("a reconnect resyncs instead of resetting", count("resync") === 1 && count("reset") === 0);
ok("the rows stay: the same session objects, the open session stays open", store.sessions.get("alpha") === alpha && store.activeId === "beta");
ok("unread counts survive the reconnect", alpha.unread === 2);
ok("every buffer is re-fetched, including a request that died with the old socket",
  alpha.historyState === "none" && store.sessions.get("beta").historyState === "none" && store.sessions.get("beta").historyRequest === "");

// The replay: alpha finished during the drop, beta's menu was answered, gamma was closed elsewhere, delta is new.
created("alpha"); recv({ type: "status", sessionId: "alpha", state: "idle" });
created("beta");
created("delta");
ok("a turn that ended during the drop does not fire a 'just finished' notification", count("session:wentIdle") === 0);
ok("nothing is removed before the burst ends", count("session:remove") === 0 && store.sessions.has("gamma"));
endBurst();
ok("a session closed during the drop is removed at the end of the burst", !store.sessions.has("gamma") && events.some((e) => e[0] === "session:remove" && e[1] === "gamma"));
ok("only that one is removed", count("session:remove") === 1 && store.sessions.has("delta"));
ok("a menu the replay did not re-send is cleared (no stuck needs-you)", store.sessions.get("beta").menu.length === 0 && !store.sessions.get("beta").attention);
ok("the replayed status is applied", alpha.status === "idle");
ok("the open session is still open", store.activeId === "beta");

// A live transition after the burst still notifies.
recv({ type: "status", sessionId: "alpha", state: "working" });
recv({ type: "status", sessionId: "alpha", state: "idle" });
ok("after the burst a real working → idle still notifies", count("session:wentIdle") === 1);

// ── a burst cut off before transcript.cache must not sweep live sessions ──
events.length = 0;
await drop();
created("alpha");   // only one row re-announced, then the socket dies again
await drop();
ok("a cut-off burst removes nothing", count("session:remove") === 0 && store.sessions.has("beta") && store.sessions.has("delta"));
created("alpha"); created("beta"); created("delta"); endBurst();
ok("the next complete burst keeps everything it re-announced", store.sessions.size === 3 && count("session:remove") === 0);

// ── the open session closed during the drop: fall back to the first live one ──
await drop();
created("alpha"); created("delta"); endBurst();
ok("if the open session is gone, the first live session opens", !store.sessions.has("beta") && store.activeId === "alpha");

// ── the content dock keeps its tabs: a replayed document is not added twice ──
const tabs = document.createElement("div"); tabs.id = "pane-tabs"; document.body.appendChild(tabs);
const body = document.createElement("div"); body.id = "pane-body"; document.body.appendChild(body);
initContentDock();
const doc = { type: "content.show", sessionId: "alpha", contentId: "c1", kind: "markdown", name: "plan.md", url: "/content/c1" };
presentInDock(doc);
presentInDock({ ...doc, replay: true });
store.select("alpha");
const tabCount = () => document.querySelectorAll("#pane-tabs .cd-tab").length;
ok("a replayed document does not open a second tab", tabCount() === 2);   // the terminal tab + plan.md

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
