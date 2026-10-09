// IT — plugin session badges: plain text only, one per plugin per session, cleared when the plugin stops, and
// shown as a glyph on the real sidebar row.
import { installFakeDom } from "./fakedom.mjs";
const dom = installFakeDom();
function mkEl(id) { const e = document.createElement("div"); e.id = id; return e; }
const list = mkEl("list"); list.appendChild(mkEl("list-empty")); document.body.appendChild(list);
for (const id of ["tab-all", "tab-unread", "search", "search-clear", "notify-btn", "prompts-btn", "settings-btn", "proj-btn", "unread-cnt", "conn", "conn-text", "save-ind", "new-btn"]) document.body.appendChild(mkEl(id));
const sideHead = document.createElement("div"); sideHead.className = "side-head"; const nw = document.createElement("div"); nw.className = "new-wrap"; sideHead.appendChild(nw); document.body.appendChild(sideHead);

const { store } = await import("../public/js/store.js");
const { initSidebar } = await import("../public/js/ui/sidebar.js");
const { setSessionBadge, clearPluginBadges, sessionBadges, onSessionBadges } = await import("../public/js/session-badges.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };

const heard = [];
onSessionBadges((id) => heard.push(id));
setSessionBadge("claude-autoapprove", "S1", { label: "Auto-approve", icon: "🚀", title: "supervised" });
ok("a badge is stored as plain fields", JSON.stringify(sessionBadges("S1")) === JSON.stringify([{ pluginId: "claude-autoapprove", label: "Auto-approve", icon: "🚀", title: "supervised" }]));
ok("listeners hear which session changed", heard.join() === "S1");
setSessionBadge("claude-autoapprove", "S1", { label: "Auto-approve", icon: "🚀", title: "supervised" });
ok("setting the same badge again is not a change", heard.length === 1);
setSessionBadge("other", "S1", { label: "x".repeat(80), icon: "<svg>", title: "a\u0000b" });
const other = sessionBadges("S1").find((b) => b.pluginId === "other");
ok("labels are capped, a long icon is dropped, control characters stripped", other.label.length === 32 && other.icon === "" && other.title === "a b");
setSessionBadge("claude-autoapprove", "S1", null);
ok("null clears only that plugin's badge", sessionBadges("S1").map((b) => b.pluginId).join() === "other");
setSessionBadge("other", "S2", { label: "On" });
clearPluginBadges("other");
ok("a stopped plugin's badges are all removed", !sessionBadges("S1").length && !sessionBadges("S2").length);

initSidebar();
store.applyEvent({ type: "session.created", sessionId: "A", protocol: 1, provider: "claude-code", name: "A", pid: 1, cwd: "/w", cols: 80, rows: 24, live: true, projectId: null });
const row = () => dom.all("row").find((r) => r.dataset.id === "A");
const marks = () => row().querySelector(".r-plugin-badges").children;
ok("no badge, no glyph", marks().length === 0);
setSessionBadge("claude-autoapprove", "A", { label: "Auto-approve", icon: "🚀", title: "supervised" });
ok("the row shows the glyph with the label in its tooltip", marks().length === 1 && marks()[0].textContent === "🚀" && marks()[0].title === "Auto-approve — supervised");
setSessionBadge("claude-autoapprove", "A", null);
ok("clearing removes the glyph", marks().length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
