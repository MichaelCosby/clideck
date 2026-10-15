// IT — a reconnect keeps the open session open. The store is wiped on every connect and rebuilt from the
// engine's replay; before this, the replay opened the first live session, so typing went to a different one.
import { installFakeDom } from "./fakedom.mjs";
installFakeDom();
const { store } = await import("../public/js/store.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const created = (id, live = true) => store.applyEvent({ type: "session.created", sessionId: id, protocol: 1, provider: "claude-code", name: id, cwd: "/w", live, projectId: null });
const burst = (list) => { store.reset(); for (const [id, live] of list) created(id, live); store.applyEvent({ type: "transcript.cache", cache: {} }); };

burst([["alpha", true], ["beta", true], ["mexico", true]]);
ok("a fresh load opens the first live session", store.activeId === "alpha");
store.select("mexico");
burst([["alpha", true], ["beta", true], ["mexico", true]]);
ok("after a reconnect the session that was open is open again", store.activeId === "mexico");
burst([["beta", true], ["alpha", true], ["mexico", false]]);
ok("…even if it went dormant meanwhile", store.activeId === "mexico");
burst([["alpha", false], ["beta", true]]);
ok("if it was deleted meanwhile, the first live session opens", store.activeId === "beta");
store.reset(); store.reset();
burst([["alpha", true], ["beta", true]]);
ok("a second reset before the replay keeps the session to reopen", store.activeId === "beta");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
