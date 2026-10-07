// Drag & drop for the sidebar (ported from v1 drag.js). Two gestures share one pointer pipeline:
//   • session row  → drop anywhere inside a PROJECT group (move to project)
//   • project head → reorder among the other projects (an insertion line shows the drop slot)
// A 5px threshold separates a drag from a click; pointer-capture keeps the gesture even off-list; a ghost
// follows the pointer; and after a real drag the follow-up click is suppressed so a drop never selects/collapses.
// The store/config drive the actual re-render — drag only fires the intent (setSessionProject / config.update).
import { store } from "../store.js";
import { setSessionProject, updateConfig } from "../ws.js";
import { placeProject, placeGroup, moveProjectToGroup } from "./project-layout.js";

export function isDragging() { return !!(ds && ds.active); }

const DRAG_THRESHOLD = 5;
let ds = null;              // active drag state (or a pending one below threshold)
let suppressClick = false;  // set on a real drag end → the very next click is swallowed

// The sidebar's row/header click handlers call this first: true (once) right after a drag, so the drop
// doesn't also select the row or toggle the group.
export function wasDragging() {
  if (suppressClick) { suppressClick = false; return true; }
  return false;
}

export function initDrag(listEl) {
  listEl.addEventListener("pointerdown", onDown);
  listEl.addEventListener("pointermove", onMove);
  listEl.addEventListener("pointerup", onUp);
  listEl.addEventListener("pointercancel", onCancel);
}

function onDown(e) {
  if (e.button !== 0) return;
  if (e.target.closest("button") || e.target.closest("input")) return;   // controls never start a drag

  // Group drag — grab by the group header; the whole group moves as one block among the top-level entries.
  const pgHead = e.target.closest(".pgroup > .pgroup-head");
  if (pgHead) {
    const pgroup = pgHead.closest(".pgroup");
    beginPending("pgroup", pgroup, pgHead, e, { groupId: pgroup.dataset.pgroupId });
    return;
  }
  // Project drag — grab by the project header. The whole project dims, but the ghost is just the header so a
  // tall project doesn't drag a giant card around. Dropping it inside a group's projects puts it in that group.
  const head = e.target.closest(".project.is-project > .group-head");
  if (head) {
    if (document.querySelectorAll(".project.is-project").length <= 1 && !document.querySelector(".pgroup")) return;
    const group = head.closest(".project");
    beginPending("project", group, head, e, { projectId: group.dataset.projectId });
    return;
  }
  // Session drag — grab by the row.
  const row = e.target.closest(".row[data-id]");
  if (row) beginPending("session", row, row, e, { id: row.dataset.id });
}

function beginPending(mode, dragRow, ghostSrc, e, extra) {
  const rect = ghostSrc.getBoundingClientRect();
  ds = { mode, row: dragRow, ghostSrc, startX: e.clientX, startY: e.clientY, offsetY: e.clientY - rect.top,
    ghost: null, active: false, dropTarget: null, pointerId: e.pointerId, ...extra };
}

function onMove(e) {
  if (!ds) return;
  if (!ds.active) {
    if (Math.abs(e.clientX - ds.startX) < DRAG_THRESHOLD && Math.abs(e.clientY - ds.startY) < DRAG_THRESHOLD) return;
    try { ds.row.setPointerCapture(ds.pointerId); } catch {}
    startDrag();
  }
  ds.ghost.style.top = (e.clientY - ds.offsetY) + "px";
  if (ds.mode === "project") updateProjectDropTarget(e.clientX, e.clientY);
  else if (ds.mode === "pgroup") updateGroupDropTarget(e.clientY);
  else updateSessionDropTarget(e.clientX, e.clientY);
}

function onUp() {
  if (!ds) return;
  if (ds.active) endDrag();
  ds = null;
}
function onCancel() {
  if (ds && ds.active) cleanup();
  ds = null;
}

function startDrag() {
  ds.active = true;
  ds.row.classList.add("dragging");
  const r = ds.ghostSrc.getBoundingClientRect();
  const ghost = ds.ghostSrc.cloneNode(true);
  ghost.classList.add("drag-ghost"); ghost.classList.remove("dragging");
  ghost.style.top = (ds.startY - ds.offsetY) + "px";
  ghost.style.left = r.left + "px";
  ghost.style.width = r.width + "px";
  document.body.appendChild(ghost);
  ds.ghost = ghost;
  if (ds.mode === "session") document.querySelectorAll(".project.is-project > .group-head").forEach((h) => h.classList.add("drop-target"));   // NOT 'drop-zone' — that's the file-drop veil (inset:0/opacity:0) and would make the headers vanish
}

// The whole project group is a drop target, while the compact header carries the visual highlight.
// Dropping outside an explicit project is a no-op: a drag must never silently manufacture a cwd group.
function updateSessionDropTarget(x, y) {
  document.querySelectorAll(".drop-highlight").forEach((el) => el.classList.remove("drop-highlight"));
  clearDropLine();
  ds.dropTarget = null;
  if (updatePinDropTarget(x, y)) return;
  for (const group of document.querySelectorAll(".project.is-project")) {
    const rect = group.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      const head = group.querySelector(":scope > .group-head");
      head.classList.add("drop-highlight");
      ds.dropTarget = { type: "project", projectId: group.dataset.projectId };
      return;
    }
  }
}

// A pinned row dragged over its group's pinned rows reorders the pins; the insertion line marks the slot.
function updatePinDropTarget(x, y) {
  if (!store.pinnedSessions.includes(ds.id)) return false;
  const pinned = [...ds.row.parentElement.querySelectorAll(":scope > .row.pinned")];
  if (pinned.length < 2) return false;
  const first = pinned[0].getBoundingClientRect(), last = pinned[pinned.length - 1].getBoundingClientRect();
  if (x < first.left || x > first.right || y < first.top || y > last.bottom) return false;
  const dragIdx = pinned.indexOf(ds.row);
  let slot = pinned.length;
  for (let i = 0; i < pinned.length; i++) {
    const r = pinned[i].getBoundingClientRect();
    if (y < r.top + r.height / 2) { slot = i; break; }
  }
  if (slot === dragIdx || slot === dragIdx + 1) return true;   // already there: no line, no move
  ds.dropTarget = { type: "pin", beforeId: slot < pinned.length ? pinned[slot].dataset.id : null, afterId: pinned[pinned.length - 1].dataset.id };
  const line = document.createElement("div");
  line.className = "project-drop-line";
  if (slot < pinned.length) pinned[slot].before(line); else pinned[pinned.length - 1].after(line);
  return true;
}

function groupIdOf(projectEl) {
  const pgroup = projectEl && projectEl.parentNode && projectEl.parentNode.closest && projectEl.parentNode.closest(".pgroup");
  return pgroup ? pgroup.dataset.pgroupId : null;
}
// The slot a pointer at `y` points at: before the first element whose upper half it is in, else the end.
function slotAt(elements, y) {
  for (let i = 0; i < elements.length; i++) {
    const r = elements[i].getBoundingClientRect();
    if (y < r.top + r.height / 2) return i;
  }
  return elements.length;
}
function drawLine(ref, after) {
  const line = document.createElement("div");
  line.className = "project-drop-line";
  if (after) ref.after(line); else ref.parentNode.insertBefore(line, ref);
}

// A project drops onto a group header (joins it at the end) or between projects: the slot takes the group of
// the project below it, so a drop inside a group's list joins that group and one outside leaves it.
function updateProjectDropTarget(x, y) {
  clearDropLine();
  document.querySelectorAll(".drop-highlight").forEach((el) => el.classList.remove("drop-highlight"));
  ds.dropTarget = null;
  for (const head of document.querySelectorAll(".pgroup > .pgroup-head")) {
    const r = head.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      const groupId = head.parentNode.dataset.pgroupId;
      if (groupIdOf(ds.row) === groupId) return;
      head.classList.add("drop-highlight");
      ds.dropTarget = { type: "into-group", groupId };
      return;
    }
  }
  const shown = (el) => el.getBoundingClientRect().height > 0;   // projects inside a collapsed group are not slots
  const rest = [...document.querySelectorAll(".project.is-project")].filter((el) => el !== ds.row && shown(el));
  const before = rest[slotAt(rest, y)] || null;
  const groupId = before ? groupIdOf(before) : null;
  const all = [...document.querySelectorAll(".project.is-project")].filter(shown);
  const same = all[all.indexOf(ds.row) + 1] === (before || undefined) || (!before && all[all.length - 1] === ds.row);
  if (same && groupId === groupIdOf(ds.row)) return;   // dropping back where it already is
  ds.dropTarget = { type: "reorder", beforeId: before ? before.dataset.projectId : null, groupId };
  if (before) drawLine(before, false); else if (rest.length) drawLine(rest[rest.length - 1], true);
}

// A group drops between the top-level entries (projects outside groups, and other groups).
function updateGroupDropTarget(y) {
  clearDropLine();
  ds.dropTarget = null;
  const list = ds.row.parentNode;
  const tops = [...list.children].filter((el) => el !== ds.row && (el.classList.contains("pgroup") || el.classList.contains("is-project")));
  const before = tops[slotAt(tops, y)] || null;
  const all = [...list.children].filter((el) => el.classList.contains("pgroup") || el.classList.contains("is-project"));
  if (all[all.indexOf(ds.row) + 1] === (before || undefined) || (!before && all[all.length - 1] === ds.row)) return;   // already there
  const keyOf = (el) => (el.classList.contains("pgroup") ? "g:" + el.dataset.pgroupId : "p:" + el.dataset.projectId);
  ds.dropTarget = { type: "group-reorder", beforeKey: before ? keyOf(before) : null };
  if (before) drawLine(before, false); else if (tops.length) drawLine(tops[tops.length - 1], true);
}

function endDrag() {
  const target = ds.dropTarget;
  suppressClick = true;
  cleanup();
  if (!target) return;
  if (ds.mode === "session") {
    const s = store.sessions.get(ds.id);
    if (!s) return;
    if (target.type === "project" && s.projectId !== target.projectId) setSessionProject(ds.id, target.projectId);
    if (target.type === "pin") {
      const pins = store.pinnedSessions.filter((id) => id !== ds.id);
      const at = target.beforeId ? pins.indexOf(target.beforeId) : pins.indexOf(target.afterId) + 1;
      pins.splice(at, 0, ds.id);
      store.setPinnedSessions(pins);
      updateConfig({ pinnedSessions: pins });
    }
  } else if (ds.mode === "project") {
    const projects = target.type === "into-group"
      ? moveProjectToGroup(store.projects, store.projectGroups, ds.projectId, target.groupId)
      : placeProject(store.projects, store.projectGroups, ds.projectId, target.beforeId, target.groupId);
    store.setProjectLayout(projects, store.projectGroups);   // optimistic → the sidebar re-sorts instantly
    updateConfig({ projects });                               // persist (engine echoes {type:'config'})
  } else if (ds.mode === "pgroup" && target.type === "group-reorder") {
    const next = placeGroup(store.projects, store.projectGroups, ds.groupId, target.beforeKey);
    store.setProjectLayout(next.projects, next.projectGroups);
    updateConfig({ projects: next.projects, projectGroups: next.projectGroups });
  }
}

function cleanup() {
  if (ds.row) ds.row.classList.remove("dragging");
  if (ds.ghost) ds.ghost.remove();
  document.querySelectorAll(".drop-highlight, .drop-target").forEach((el) => el.classList.remove("drop-highlight", "drop-target"));
  clearDropLine();
}
function clearDropLine() { document.querySelectorAll(".project-drop-line").forEach((el) => el.remove()); }
