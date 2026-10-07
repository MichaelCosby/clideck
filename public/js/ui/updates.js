// Server owns checks and installation. The browser only offers explicit, online actions.
import { store } from "../store.js";
import { send } from "../ws.js";
import { h } from "../util.js";
import { toast } from "./toast.js";

const acknowledged = new Set();
let started = false, notice = null, requested = false, lastNoticeState = null;
const installable = s => s?.canInstall && s.latestVersion && (s.state === "available" || s.state === "error");
const busy = s => s && (s.state === "checking" || s.state === "installing");
function request(install) {
  const state = store.engineUpdate;
  if (!store.connected || !state || busy(state)) return;
  if (install && !installable(state)) return;
  if (install) acknowledged.add(state.latestVersion);
  requested = true;
  send({ type: install ? "engine.update.install" : "engine.update.check" });
  store.applyEvent({ ...state, state: install ? "installing" : "checking" });
}
function detail(s) {
  if (!store.connected) return "Reconnect to check for updates.";
  if (!s) return "Update status unavailable.";
  if (s.state === "checking") return "Checking for updates…";
  if (s.state === "current") return "CliDeck is up to date.";
  if (s.state === "available") return `Version ${s.latestVersion || "update"} available.${s.canInstall ? "" : " " + (s.instruction || "Update your CliDeck installation manually.")}`;
  if (s.state === "installing") return "Installing update… Your sessions keep running.";
  if (s.state === "installed") return "Update installed. Restart CliDeck when ready to use it.";
  return (s.error || "Could not check for updates. Try again.") + (s.instruction ? " " + s.instruction : "");
}
// ── Restarting onto the code on disk (after an update), optionally once every agent is idle ──
const RESTARTED_FLAG = "clideck.restarting";
function requestRestart(whenIdle) {
  if (!store.connected) return;
  send({ type: "engine.restart", whenIdle });
}
function cancelRestart() { if (store.connected) send({ type: "engine.restart.cancel" }); }
function busyText(names) {
  if (!names.length) return "all agents are idle; restarting shortly.";
  const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "");
  return `waiting for ${shown}.`;
}
function restartControls() {
  const r = store.engineRestart;
  if (!r || !r.canRestart) return null;
  const root = h("div", "set-restart");
  const status = h("div", "set-update-status"); status.setAttribute("role", "status");
  if (r.state === "waiting") {
    status.textContent = "Restart when idle: " + busyText(r.busy || []);
    const cancel = h("button", "set-action"); cancel.type = "button"; cancel.textContent = "Cancel restart";
    cancel.disabled = !store.connected; cancel.addEventListener("click", cancelRestart);
    root.append(status, cancel); return root;
  }
  if (r.state === "restarting") { status.textContent = "Restarting… your sessions will resume."; root.append(status); return root; }
  status.textContent = "Restart onto the installed code. Agent sessions resume afterwards; shell sessions start fresh.";
  const idle = h("button", "set-action"); idle.type = "button"; idle.textContent = "Restart when idle";
  idle.disabled = !store.connected; idle.addEventListener("click", () => requestRestart(true));
  // Restarting now interrupts working agents, so it takes a second click.
  const now = h("button", "set-action set-action-quiet"); now.type = "button"; now.textContent = "Restart now";
  now.disabled = !store.connected;
  now.addEventListener("click", () => {
    if (now.dataset.armed) { requestRestart(false); return; }
    now.dataset.armed = "1"; now.textContent = "Click again: interrupts working agents";
    setTimeout(() => { delete now.dataset.armed; now.textContent = "Restart now"; }, 4000);
  });
  const row = h("div", "set-restart-actions"); row.append(idle, now);
  root.append(status, row); return root;
}

export function updateControls() {
  const s = store.engineUpdate, root = h("div", "set-update");
  const status = h("div", "set-update-status"); status.setAttribute("role", "status"); status.textContent = detail(s); root.append(status);
  const restart = restartControls();
  if (s?.state === "installed") { if (restart) root.append(restart); return root; }
  const install = installable(s);
  const button = h("button", "set-action"); button.type = "button";
  button.textContent = install ? (s.state === "error" ? "Retry update" : "Update") : busy(s) ? (s.state === "installing" ? "Installing…" : "Checking…") : "Check for updates";
  button.disabled = !store.connected || !s || busy(s);
  button.addEventListener("click", () => request(install)); root.append(button);
  if (restart) root.append(restart);
  return root;
}
export function initUpdates() {
  if (started) return; started = true;
  store.on("engine.update", s => {
    const key = JSON.stringify([s.state, s.currentVersion, s.latestVersion, s.canInstall, s.instruction, s.error]);
    if (key === lastNoticeState) return;
    lastNoticeState = key;
    if (s.state === "available") {
      requested = false;
      if (acknowledged.has(s.latestVersion)) { notice?.dismiss(); notice = null; return; }
      notice = toast.info({ id: "engine-update", title: "New version available", body: `CliDeck ${s.latestVersion || ""}`, duration: 0,
        onDismiss: () => acknowledged.add(s.latestVersion),
        action: { label: s.canInstall ? "Update" : "Details", onClick: () => {
          if (!store.connected || store.engineUpdate?.state !== "available" || store.engineUpdate.latestVersion !== s.latestVersion) return;
          acknowledged.add(s.latestVersion);
          if (s.canInstall) request(true);
          else import("./settings.js").then(m => m.openSettingsAt("general"));
        } } });
    } else {
      notice?.dismiss(); notice = null;
      if (s.state === "error" && (requested || installable(s))) notice = toast.error({ id: "engine-update", title: "Update failed", body: detail(s), duration: 0,
        action: installable(s) ? { label: "Retry update", onClick: () => request(true) } : undefined });
      if (s.state === "current" || s.state === "installed" || s.state === "error") requested = false;
      if (s.state === "installing" || s.state === "installed") {
        const canRestart = s.state === "installed" && store.engineRestart?.canRestart;
        notice = toast.info({ id: "engine-update", title: s.state === "installed" ? "Update installed" : "Installing update", body: detail(s), duration: 0,
          action: canRestart ? { label: "Restart when idle", onClick: () => requestRestart(true) } : undefined });
      }
    }
  });
  store.on("connection", connected => { if (!connected) { notice?.dismiss(); notice = null; lastNoticeState = null; } });
  let restartNotice = null;
  store.on("engine.restart", r => {
    if (r.state === "waiting") {
      restartNotice = toast.info({ id: "engine-restart", title: "Restart when idle", body: "CliDeck will restart, " + busyText(r.busy || []), duration: 0,
        action: { label: "Cancel restart", onClick: cancelRestart } });
    } else if (r.state === "restarting") {
      try { sessionStorage.setItem(RESTARTED_FLAG, "1"); } catch {}
      restartNotice = toast.info({ id: "engine-restart", title: "Restarting CliDeck", body: "Your sessions will resume in a moment.", duration: 0 });
    } else {
      let restarted = false;
      try { restarted = sessionStorage.getItem(RESTARTED_FLAG) === "1"; sessionStorage.removeItem(RESTARTED_FLAG); } catch {}
      restartNotice?.dismiss(); restartNotice = null;
      if (restarted) toast.success({ id: "engine-restart", title: "CliDeck restarted", body: "Running sessions are resuming." });
    }
  });
}
