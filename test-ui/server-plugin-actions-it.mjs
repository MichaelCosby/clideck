// IT — actions and badges from a plugin's server part: the engine resolves them per session, the browser shows
// them in the same menus as client actions, and running one sends plugin.action.run and waits for its result.
import { installFakeDom, installFakeWs } from "./fakedom.mjs";
const { body } = installFakeDom();
const ws = installFakeWs();
const actionButton = document.createElement("button"); actionButton.id = "plugin-actions"; actionButton.hidden = true; body.append(actionButton);

const { store } = await import("../public/js/store.js");
const { connectWs } = await import("../public/js/ws.js");
const { initPluginHost, pluginActionContext } = await import("../public/js/ui/plugin-host.js");
const { resolveActions, resolveImmediateActions, hasActions, runAction } = await import("../public/js/ui/action-registry.js");
const { sessionBadges, setSessionBadge } = await import("../public/js/session-badges.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

connectWs(); await tick();
initPluginHost();
store.applyEvent({ type: "session.created", sessionId: "S", protocol: 1, provider: "claude-code", name: "Builder", cwd: "/w", live: true, projectId: null });
store.applyEvent({ type: "session.created", sessionId: "T", protocol: 1, provider: "codex", name: "Other", cwd: "/w", live: true, projectId: null });
store.select("S");
const context = (id, surface) => ({ surface, selection: { text: "", surface }, session: { id, provider: "claude-code" }, project: null });

ok("no server actions, none offered", !hasActions("session.menu"));
store.applyEvent({ type: "plugin.actions", sessionId: "S", actions: [
  { pluginId: "toggle-thing", id: "disable", label: "Disable thing", icon: "✕", description: "", placements: ["session.menu", "terminal.header"] },
  { pluginId: "Bad Id", id: "x", label: "Rejected", placements: ["session.menu"] },
] });
const menu = await resolveActions("session.menu", context("S", "session"));
ok("the session menu offers the engine's action for that session", menu.length === 1 && menu[0].label === "Disable thing" && menu[0].icon === "✕");
ok("other sessions don't get it", !(await resolveActions("session.menu", context("T", "session"))).length);
ok("it is offered synchronously too (no `when` to wait on)", resolveImmediateActions("terminal.header", context("S", "terminal")).length === 1);
await tick();
ok("the terminal header button shows for the active session", actionButton.hidden === false && actionButton._actions?.some((action) => action.id === "disable"));

ws.clear();
const running = runAction(menu[0], menu[0].context);
await tick();
const sent = ws.last("plugin.action.run");
ok("running it sends plugin.action.run with the session and placement", sent && sent.pluginId === "toggle-thing" && sent.actionId === "disable" && sent.sessionId === "S" && sent.placement === "session.menu" && /^ui-/.test(sent.requestId));
store.applyEvent({ type: "plugin.action.result", requestId: sent.requestId, pluginId: "toggle-thing", actionId: "disable", sessionId: "S", ok: false, error: "Could not do it." });
ok("the run resolves when its result arrives", (await running) === true);
await tick();
ok("a failed run shows its error", document.body.textContent.includes("Could not do it."));
store.applyEvent({ type: "plugin.toast", pluginId: "toggle-thing", kind: "success", title: "Thing", body: "Turned off", toastId: "thing", requestId: sent.requestId });
await tick();
ok("a plugin toast is shown", document.body.textContent.includes("Turned off"));

store.applyEvent({ type: "session.badges", sessionId: "S", badges: [{ pluginId: "toggle-thing", label: "Thing", icon: "✓", title: "On" }] });
ok("server badges are stored for the session", JSON.stringify(sessionBadges("S")) === JSON.stringify([{ pluginId: "toggle-thing", label: "Thing", icon: "✓", title: "On" }]));
setSessionBadge("client-plugin", "S", { label: "Client" });
ok("client and server badges show together", sessionBadges("S").map((badge) => badge.pluginId).join() === "client-plugin,toggle-thing");
store.applyEvent({ type: "session.badges", sessionId: "S", badges: [] });
ok("an empty list clears the server badges only", sessionBadges("S").map((badge) => badge.pluginId).join() === "client-plugin");

store.applyEvent({ type: "plugin.actions", sessionId: "S", actions: [] });
ok("an empty list clears the session's actions", !(await resolveActions("session.menu", context("S", "session"))).length && !hasActions("session.menu"));
store.applyEvent({ type: "plugin.actions", sessionId: "T", actions: [{ pluginId: "toggle-thing", id: "enable", label: "Enable", placements: ["session.menu"] }] });
store.applyEvent({ type: "session.badges", sessionId: "T", badges: [{ pluginId: "toggle-thing", label: "Thing" }] });
store.applyEvent({ type: "session.closed", sessionId: "T", exitCode: 0, signal: null });
ok("a closed session drops its actions and badges", !hasActions("session.menu") && !sessionBadges("T").length);
ok("the header context is unchanged for client actions", pluginActionContext("terminal", "").session.id === "S");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
