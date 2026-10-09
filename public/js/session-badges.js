// Per-session badges that plugins set (e.g. "✓ Auto-approve"): a short label, a one- or two-character glyph and
// a tooltip, all plain text. The host renders them in the terminal header and on the session's sidebar row;
// plugins never supply markup.
const badges = new Map();      // sessionId -> Map(pluginId -> badge)
const listeners = new Set();

const MAX_LABEL = 32, MAX_TITLE = 200;
const text = (value, max) => String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

function emit(sessionId) { for (const fn of listeners) { try { fn(sessionId); } catch {} } }

// A badge object sets or replaces this plugin's badge on the session; null (or an empty label) clears it.
export function setSessionBadge(pluginId, sessionId, badge) {
  sessionId = String(sessionId || "");
  if (!pluginId || !sessionId || sessionId.length > 200) return;
  const label = badge && typeof badge === "object" ? text(badge.label, MAX_LABEL) : "";
  const forSession = badges.get(sessionId);
  if (!label) {
    if (!forSession || !forSession.delete(pluginId)) return;
    if (!forSession.size) badges.delete(sessionId);
  } else {
    const glyph = text(badge.icon, 8);
    const next = { pluginId, label, icon: [...glyph].length <= 2 ? glyph : "", title: text(badge.title, MAX_TITLE) };
    const map = forSession || new Map();
    const prev = map.get(pluginId);
    if (prev && prev.label === next.label && prev.icon === next.icon && prev.title === next.title) return;
    map.set(pluginId, next);
    badges.set(sessionId, map);
  }
  emit(sessionId);
}

// Called when a plugin's client stops, so a disabled or failed plugin leaves nothing behind.
export function clearPluginBadges(pluginId) {
  for (const [sessionId, map] of [...badges]) {
    if (!map.delete(pluginId)) continue;
    if (!map.size) badges.delete(sessionId);
    emit(sessionId);
  }
}

export function sessionBadges(sessionId) {
  const map = badges.get(String(sessionId || ""));
  return map ? [...map.values()].sort((a, b) => a.pluginId.localeCompare(b.pluginId)) : [];
}

export function onSessionBadges(fn) { listeners.add(fn); return () => listeners.delete(fn); }
