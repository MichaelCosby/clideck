// Per-session automatic read-aloud. A finished reply is read only while its session is the one on screen
// (and the tab is visible). A reply that finishes elsewhere waits — newest per session, in memory only, so a
// page reload or lost connection forgets it — until the person opens that session. Manual reading always wins: an auto reply
// waits for the channel.
//
// The Supertonic client synthesises; this host decides. Each dispatch carries a token: plugin-audio asks
// allow() before an auto clip sounds (audio prepared after the person moved away is refused here), reports
// when it really started or was blocked, and the client reports deferred / finished / failed by token.
import { store } from "../store.js";
import { deliverPluginMessage, onPluginHostChange } from "./plugin-host.js";
import { setAutoAudioHooks, audioOwner, stopPluginAudio } from "./plugin-audio.js";
import { toast } from "./toast.js";

const PLUGIN = "supertonic";
const pending = new Map();   // sessionId → newest finished reply not yet heard
const failed = new Set();    // sessions whose last attempt failed: no routine retries until a fresh trigger
let job = null;              // { token, sessionId, text, started } — the one auto reply handed to the plugin
let sequence = 0;

const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
const enabled = (id) => store.sessions.get(id)?.readAloud === true;
function ready() {
  const plugin = store.plugins.find((p) => p.id === PLUGIN);
  return !!(plugin && plugin.enabled !== false && plugin.status === "ready");
}
// Put an unheard reply back, unless a newer one for that session is already waiting.
function requeue(current) {
  if (!pending.has(current.sessionId) && enabled(current.sessionId)) pending.set(current.sessionId, current.text);
}

function cancel(keepUnheard) {
  const current = job;
  if (!current) return;
  job = null;
  deliverPluginMessage(PLUGIN, "speak-cancel", { token: current.token });
  if (audioOwner() === current.token) stopPluginAudio(PLUGIN);
  if (keepUnheard && !current.started) requeue(current);
}

// fresh: the person just did something (opened the session, a new reply, Read now) — the only triggers that
// may retry a session whose last attempt failed, so a broken model download never loops on its own.
function flush(fresh = false) {
  const id = store.activeId;
  if (!id || !pending.has(id) || job || !visible() || !enabled(id) || !ready() || audioOwner()) return;
  if (failed.has(id) && !fresh) return;
  failed.delete(id);
  const text = pending.get(id);
  const next = { token: `auto-${Date.now()}-${++sequence}`, sessionId: id, text, started: false };
  if (!deliverPluginMessage(PLUGIN, "speak", { text, sessionId: id, source: "auto", token: next.token })) return;
  pending.delete(id);
  job = next;
}

function fail(current) {
  job = null; requeue(current); failed.add(current.sessionId);
}

function onFinal(id, text) {
  if (!enabled(id)) return;
  if (job && job.sessionId === id) cancel(false);   // a newer reply supersedes the one being read
  pending.set(id, text);
  flush(true);
}

function onSessionChange(id) {
  if (enabled(id)) return flush();
  pending.delete(id); failed.delete(id);
  if (job && job.sessionId === id) cancel(false);
}

function onResult(message) {
  if (message.pluginId !== PLUGIN || message.event !== "auto-read-result") return;
  const { token, status } = message.data || {};
  if (!job || job.token !== token) return;          // stale: cancelled or superseded
  const current = job;
  if (status === "finished") { job = null; flush(); }
  else if (status === "deferred") { job = null; requeue(current); }   // a manual read is preparing; idle retries
  else if (status === "failed") fail(current);       // the plugin already explained why
}

export function initReadAloud() {
  setAutoAudioHooks({
    allow: (token) => !!job && job.token === token && job.sessionId === store.activeId && visible() && enabled(job.sessionId),
    started(token) {
      if (job && job.token === token) job.started = true;
      else if (audioOwner() === token) stopPluginAudio(PLUGIN);   // began sounding after it was cancelled
    },
    // The browser refused to play (usually autoplay before any click). Keep the reply and offer a gesture.
    blocked(token, error) {
      if (!job || job.token !== token) return;
      const current = job; fail(current);
      const name = store.sessions.get(current.sessionId)?.name || "this session";
      toast.info({ id: "read-aloud-blocked", title: "Reply not read aloud",
        body: error && error.name === "NotAllowedError" ? `The browser blocked automatic audio for ${name}.` : `Audio for ${name} could not play.`,
        action: { label: "Read now", onClick: () => flush(true) } });
    },
    // Manual audio took the channel: an auto reply that had not started waits for it; one that had is over.
    manualStarted() { if (job) cancel(true); },
    // The channel went quiet: an auto reply that had sounded is finished (or was stopped) — it is consumed.
    idle() { if (job && job.started && audioOwner() !== job.token) job = null; flush(); },
  });
  store.on("session:final", onFinal);
  store.on("session:update", onSessionChange);
  store.on("session:remove", (id) => { pending.delete(id); failed.delete(id); if (job && job.sessionId === id) cancel(false); });
  store.on("active", () => { if (job && job.sessionId !== store.activeId) cancel(true); flush(true); });
  store.on("plugin:message", onResult);
  store.on("plugins", () => { if (!ready()) cancel(true); else flush(); });
  // A lost connection is treated like a page refresh: nothing in flight or waiting survives it, so a replay
  // that selects another session can never speak an old reply. Already-heard replies are never replayed.
  const forget = () => { cancel(false); pending.clear(); failed.clear(); };
  store.on("reset", forget);
  store.on("connection", () => { if (!store.connected) forget(); });
  onPluginHostChange(() => flush());                  // the client finished activating
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => { if (!visible()) cancel(true); else flush(); });
}

export function __readAloudStateForTest() {
  return { pending: Object.fromEntries(pending), failed: [...failed], job: job && { ...job } };
}
