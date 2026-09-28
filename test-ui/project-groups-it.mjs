// IT — project groups render as containers around their projects, collapse, and hide when filters empty them.
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
const project = (id, groupId) => ({ id, name: id, path: "/src/" + id, color: "#123456", collapsed: false, ...(groupId && { groupId }) });
const top = () => [...list.children].map((c) => c.dataset.pgroupId ? "G:" + c.dataset.pgroupId : c.dataset.projectId ? "P:" + c.dataset.projectId : null).filter(Boolean);
const pgroup = (id) => [...list.children].find((c) => c.dataset.pgroupId === id);
const members = (id) => [...pgroup(id).children[1].children].map((c) => c.dataset.projectId);

try {
  initSidebar();
  store.applyEvent({ type: "config", config: {
    projects: [project("sprut", "simplata"), project("stowbook"), project("docspider", "simplata")],
    projectGroups: [{ id: "simplata", name: "simplata", collapsed: false }, { id: "evanesco", name: "evanesco", collapsed: false }],
  } });
  ok("groups sit where their first project is, empty groups last", top().join() === "G:simplata,P:stowbook,G:evanesco");
  ok("a group holds its projects in order", members("simplata").join() === "sprut,docspider");
  ok("the group header shows its name", pgroup("simplata").children[0].children[1].textContent === "simplata");

  pgroup("simplata").children[0]._fire("click", { target: pgroup("simplata").children[0] });
  ok("clicking the header collapses the group", pgroup("simplata")._cls.has("collapsed") && store.projectGroups[0].collapsed === true);

  store.applyEvent({ type: "config", config: {
    projects: [project("sprut", "gone"), project("stowbook")], projectGroups: [],
  } });
  ok("a project whose group is gone shows ungrouped", top().join() === "P:sprut,P:stowbook" && !pgroup("simplata"));

  store.applyEvent({ type: "config", config: {
    projects: [project("sprut", "simplata"), project("stowbook")],
    projectGroups: [{ id: "simplata", name: "simplata", collapsed: false }],
  } });
  store.setFilter("unread");
  ok("a group with nothing to show under Unread is hidden", pgroup("simplata").style.display === "none");
  store.setFilter("all");
  ok("and returns under All", pgroup("simplata").style.display === "");

  // ── moving projects with the menus ──
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const projectRoot = (id) => list._walk().find((n) => n.dataset && n.dataset.projectId === id && n._cls.has("is-project"));
  const openProjectMenu = (id) => projectRoot(id)._walk().find((n) => n.title === "Project actions")._fire("click", { detail: 1 });
  const choose = async (label) => {
    const item = [...document.querySelectorAll(".menu-item")].find((el) => el.textContent.trim() === label);
    if (!item) throw new Error("no menu item " + label + " in: " + [...document.querySelectorAll(".menu-item")].map((el) => el.textContent.trim()).join(" | "));
    item._fire("click"); await tick();
  };
  const groupOf = (id) => store.projects.find((p) => p.id === id).groupId || null;

  openProjectMenu("stowbook"); await tick();
  await choose("Move to group…");
  await choose("simplata");
  ok("Move to group puts the project in that group", groupOf("stowbook") === "simplata" && members("simplata").join() === "sprut,stowbook");

  openProjectMenu("sprut"); await tick();
  await choose("Move to group…");
  await choose("Remove from group");
  ok("Remove from group takes it out, just below the group", groupOf("sprut") === null && top().join() === "G:simplata,P:sprut");

  openProjectMenu("sprut"); await tick();
  await choose("Move to group…");
  await choose("New group…");
  const created = store.projectGroups.find((g) => g.name === "New group");
  ok("New group creates a group holding the project", created && groupOf("sprut") === created.id && top().length === 2);
  document.querySelectorAll(".name-input").forEach((el) => el._fire("keydown", { key: "Escape" }));

  const simplataMenu = pgroup("simplata")._walk().find((n) => n.title === "Group actions");
  simplataMenu._fire("click", { detail: 1 }); await tick();
  await choose("Delete group");
  await choose("Delete group");
  ok("deleting a group keeps its projects, ungrouped", !store.projectGroups.some((g) => g.id === "simplata") && groupOf("stowbook") === null && store.projects.some((p) => p.id === "stowbook"));

  // ── combined status on a collapsed group ──
  store.applyEvent({ type: "config", config: {
    projects: [project("sprut", "simplata"), project("docspider", "simplata"), project("stowbook")],
    projectGroups: [{ id: "simplata", name: "simplata", collapsed: true }],
  } });
  const session = (id, projectId) => store.applyEvent({ type: "session.created", sessionId: id, protocol: 1, provider: "claude-code", name: id, pid: 1, cwd: "/src", cols: 80, rows: 24, live: true, projectId });
  session("s1", "sprut"); session("s2", "sprut"); session("s3", "docspider"); session("s4", "stowbook");
  store.applyEvent({ type: "status", sessionId: "s1", state: "working" });
  store.applyEvent({ type: "status", sessionId: "s2", state: "idle" });
  store.applyEvent({ type: "menu", sessionId: "s2", choices: ["1"], context: "Allow?" });
  store.applyEvent({ type: "status", sessionId: "s3", state: "working" });
  store.applyEvent({ type: "status", sessionId: "s4", state: "working" });
  await tick();
  const summary = () => pgroup("simplata").children[0].children[2].textContent;
  ok("a collapsed group totals needs-you and working across its projects", summary() === "1 needs you · 2 working" && pgroup("simplata")._cls.has("needs"));
  store.applyEvent({ type: "config", config: {
    projects: [project("sprut", "simplata"), project("docspider", "simplata"), project("stowbook")],
    projectGroups: [{ id: "simplata", name: "simplata", collapsed: false }],
  } });
  await tick();
  ok("an expanded group shows no summary", summary() === "" && !pgroup("simplata")._cls.has("needs"));
} catch (e) { fail++; console.log("  THREW " + (e && e.stack || e)); }
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
