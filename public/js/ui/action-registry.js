// Host-owned plugin actions. Client plugins live in module Workers; this registry stores only declarative
// labels/placements and RPC callbacks. It never accepts plugin DOM or markup.

const PLACEMENTS = new Set([
  "terminal.context", "viewer.context", "terminal.header", "viewer.header",
  "session.menu", "project.menu", "toolbar", "terminal.voice",
]);
const actions = new Map();                 // pluginId/actionId -> normalized action
const serverActions = new Map();           // sessionId -> actions the engine resolved for that session
const listeners = new Set();
let onError = () => {};
let runServerAction = async () => false;

const keyOf = (pluginId, id) => pluginId + "/" + id;
const safeId = (value) => /^[a-z][a-z0-9-]{0,62}$/.test(String(value || ""));
function changed() { for (const fn of listeners) fn(); }
function clone(value) { try { return structuredClone(value); } catch { try { return JSON.parse(JSON.stringify(value)); } catch { return {}; } } }
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); return value;
}
function contextSnapshot(context) { return deepFreeze(clone(context || {})); }

export function registerAction(pluginId, definition, invoke) {
  const id = String(definition && definition.id || "");
  const label = String(definition && definition.label || "").trim();
  const placements = Array.isArray(definition && definition.placements)
    ? [...new Set(definition.placements.filter((p) => PLACEMENTS.has(p)))] : [];
  if (!safeId(pluginId) || !safeId(id) || !label || label.length > 120 || !placements.length || typeof invoke !== "function") return () => {};
  const key = keyOf(pluginId, id);
  if (actions.has(key)) return () => {};
  actions.set(key, {
    pluginId, id, label, placements,
    icon: String(definition.icon || "").slice(0, 24),
    description: String(definition.description || "").slice(0, 240),
    hasWhen: definition.hasWhen === true,
    invoke,
  });
  changed();
  return () => { if (actions.delete(key)) changed(); };
}

export function unregisterActionsForPlugin(pluginId) {
  let any = false;
  for (const [key, action] of actions) if (action.pluginId === pluginId) { actions.delete(key); any = true; }
  if (any) changed();
}

// Actions a plugin's server part declared: the engine already decided they apply to this session and
// placement, so they need no `when` here. `list` replaces the session's previous list.
export function setServerActions(sessionId, list) {
  sessionId = String(sessionId || "");
  if (!sessionId) return;
  const valid = (Array.isArray(list) ? list : []).filter((action) => action && safeId(action.pluginId) && safeId(action.id)
    && typeof action.label === "string" && action.label.trim() && Array.isArray(action.placements));
  if (!valid.length && !serverActions.has(sessionId)) return;
  if (valid.length) serverActions.set(sessionId, valid.map((action) => ({
    pluginId: action.pluginId, id: action.id, label: action.label.trim().slice(0, 120),
    placements: action.placements.filter((p) => PLACEMENTS.has(p)),
    icon: String(action.icon || "").slice(0, 24), description: String(action.description || "").slice(0, 240),
    hasWhen: false, server: true,
  })));
  else serverActions.delete(sessionId);
  changed();
}
export function clearServerActions() { if (serverActions.size) { serverActions.clear(); changed(); } }
export function setServerActionRunner(fn) { runServerAction = typeof fn === "function" ? fn : async () => false; }

function serverCandidates(placement, context) {
  const sessionId = context && context.session && context.session.id;
  return (serverActions.get(String(sessionId || "")) || []).filter((action) => action.placements.includes(placement))
    .map((action) => ({ ...action, invoke: (method, id) => method === "run-action" ? runServerAction(action.pluginId, id, sessionId, placement) : true }));
}

export function hasActions(placement) {
  for (const action of actions.values()) if (action.placements.includes(placement)) return true;
  for (const list of serverActions.values()) if (list.some((action) => action.placements.includes(placement))) return true;
  return false;
}

export async function resolveActions(placement, context) {
  const snapshot = contextSnapshot(context);
  const candidates = [...actions.values()].filter((action) => action.placements.includes(placement));
  const visible = await Promise.all(candidates.map(async (action) => {
    if (!action.hasWhen) return action;
    try { return (await action.invoke("match-action", action.id, snapshot)) ? action : null; }
    catch { return null; } // a broken availability predicate hides one action; it never breaks a core menu
  }));
  return [...visible.filter(Boolean), ...serverCandidates(placement, snapshot)].map((action) => ({ ...action, context: snapshot }));
}

// Context menus must decide preventDefault synchronously. Unconditional actions are safe to expose now;
// Worker-backed `when` predicates are primed ahead of time and consumed from the surface cache.
export function resolveImmediateActions(placement, context) {
  const snapshot = contextSnapshot(context);
  return [...actions.values()]
    .filter((action) => action.placements.includes(placement) && !action.hasWhen)
    .concat(serverCandidates(placement, snapshot))
    .map((action) => ({ ...action, context: snapshot }));
}

export async function runAction(action, context) {
  if (!action) return false;
  try { await action.invoke("run-action", action.id, contextSnapshot(context || action.context)); return true; }
  catch (error) { onError(action.pluginId, error); return false; }
}

export function onActionsChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function setActionErrorHandler(fn) { onError = typeof fn === "function" ? fn : () => {}; }

// Small test seams: registrations remain private; tests assert normalized outcomes, not implementation maps.
export function __clearActionsForTest() { actions.clear(); serverActions.clear(); changed(); }
