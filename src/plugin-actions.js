// Plugin actions and badges declared by a plugin's server part. The engine decides which actions apply to
// each session (the plugin's `when`, run in its worker) and pushes the result to every client, so a client
// with no JavaScript runtime (the phone app) shows the same session menu as the browser.
//
// Wire messages (engine -> clients):
//   {type:'plugin.actions', sessionId, actions:[{pluginId, id, label, icon, description, placements}]}
//   {type:'session.badges', sessionId, badges:[{pluginId, label, icon, title}]}
//   {type:'plugin.toast', pluginId, kind, title, body, toastId?, requestId?}
//   {type:'plugin.action.result', requestId, pluginId, actionId, sessionId, ok, error?}   (requester only)
// Both lists are full replacements for that session, sent again whenever they change (empty when cleared).

const SERVER_ACTION_PLACEMENTS = Object.freeze(['session.menu', 'terminal.header']);
const SURFACE = { 'session.menu': 'session', 'terminal.header': 'terminal' };
const RECOMPUTE_DELAY_MS = 30;
const TRIGGERS = new Set(['session.created', 'status', 'session.closed', 'config', 'plugins']);

const text = (value, max) => String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

function cleanBadge(badge) {
  const label = badge && typeof badge === 'object' ? text(badge.label, 32) : '';
  if (!label) return null;
  const glyph = text(badge.icon, 8);
  return { label, icon: [...glyph].length <= 2 ? glyph : '', title: text(badge.title, 200) };
}

class PluginActionHub {
  constructor({ pluginManager, sessions, projects, broadcast }) {
    this.pluginManager = pluginManager;
    this.sessions = sessions;          // () => [{id, name, provider, cwd, projectId, live, status}]
    this.projects = projects;          // () => [project]
    this.broadcast = broadcast;
    this.sent = new Map();             // sessionId -> JSON of the last actions list sent
    this.badges = new Map();           // sessionId -> Map(pluginId -> badge)
    this.timer = null;
    this.running = null;
    this.again = false;
  }

  // Engine events that can change an action's availability: a session appearing, changing or closing, its
  // status, the projects in config, or a plugin starting, stopping or changing settings.
  noteEvent(event) {
    if (!event || !TRIGGERS.has(event.type)) return;
    if (event.type === 'session.closed') {
      this.sent.delete(event.sessionId);
      this.badges.delete(event.sessionId);
    }
    this.schedule();
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.recompute();
    }, RECOMPUTE_DELAY_MS);
    this.timer.unref?.();
  }

  context(session, placement) {
    const surface = SURFACE[placement];
    const project = session.projectId ? (this.projects() || []).find((entry) => entry.id === session.projectId) || null : null;
    return {
      surface,
      selection: { text: '', surface, ...(surface === 'terminal' && { anchor: '' }) },
      session: { ...session },
      project,
    };
  }

  async recompute() {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      try {
        const sessions = this.sessions();
        const contexts = sessions.flatMap((session) => SERVER_ACTION_PLACEMENTS.map((placement) => ({
          key: `${session.id}\n${placement}`, placement, context: this.context(session, placement),
        })));
        const declared = this.pluginManager.serverActions();
        const visible = contexts.length && declared.length ? await this.pluginManager.matchServerActions(contexts) : new Map();
        for (const session of sessions) {
          const actions = [];
          for (const action of declared) {
            const shown = action.placements.filter((placement) => (
              visible.get(action.pluginId)?.[`${session.id}\n${placement}`]?.includes(action.id)
            ));
            if (shown.length) actions.push({ ...action, placements: shown });
          }
          const json = JSON.stringify(actions);
          if ((this.sent.get(session.id) || '[]') === json) continue;
          this.sent.set(session.id, json);
          this.broadcast({ type: 'plugin.actions', sessionId: session.id, actions });
        }
      } finally {
        this.running = null;
      }
    })();
    await this.running;
    if (this.again) { this.again = false; return this.recompute(); }
  }

  setBadge(pluginId, sessionId, badge) {
    sessionId = text(sessionId, 200);
    if (!sessionId || !this.sessions().some((session) => session.id === sessionId)) return;
    const next = cleanBadge(badge);
    const map = this.badges.get(sessionId) || new Map();
    const previous = map.get(pluginId);
    if (!next && !previous) return;
    if (next && previous && JSON.stringify(next) === JSON.stringify(previous)) return;
    if (next) map.set(pluginId, next); else map.delete(pluginId);
    if (map.size) this.badges.set(sessionId, map); else this.badges.delete(sessionId);
    this.broadcast(this.badgeEvent(sessionId));
  }

  // A plugin that stops leaves no badge behind (its actions go with the next recompute).
  clearPlugin(pluginId) {
    for (const [sessionId, map] of [...this.badges]) {
      if (!map.delete(pluginId)) continue;
      if (!map.size) this.badges.delete(sessionId);
      this.broadcast(this.badgeEvent(sessionId));
    }
    this.schedule();
  }

  badgeEvent(sessionId) {
    const map = this.badges.get(sessionId);
    const badges = map ? [...map].map(([pluginId, badge]) => ({ pluginId, ...badge })).sort((a, b) => a.pluginId.localeCompare(b.pluginId)) : [];
    return { type: 'session.badges', sessionId, badges };
  }

  // The non-empty lists, for a client that just connected (it starts with nothing).
  connectEvents() {
    const events = [];
    for (const [sessionId, json] of this.sent) {
      if (json !== '[]') events.push({ type: 'plugin.actions', sessionId, actions: JSON.parse(json) });
    }
    for (const sessionId of this.badges.keys()) events.push(this.badgeEvent(sessionId));
    return events;
  }

  // Runs an action the engine offered for this session and placement; resolves {ok, error?}.
  async run({ pluginId, actionId, sessionId, placement }, onToast) {
    const offered = JSON.parse(this.sent.get(sessionId) || '[]')
      .find((action) => action.pluginId === pluginId && action.id === actionId && action.placements.includes(placement));
    const session = this.sessions().find((entry) => entry.id === sessionId);
    if (!offered || !session) return { ok: false, error: 'That action is not available for this session.' };
    return this.pluginManager.runServerAction(pluginId, actionId, this.context(session, placement), onToast);
  }
}

function toastEvent(pluginId, pluginName, toast) {
  const kind = ['success', 'warn', 'error'].includes(toast?.kind) ? toast.kind : 'info';
  const options = toast?.options && typeof toast.options === 'object' ? toast.options : {};
  const toastId = text(options.id, 100);
  return {
    type: 'plugin.toast',
    pluginId,
    kind,
    title: text(options.title, 120) || pluginName || pluginId,
    body: String(options.body == null ? '' : options.body).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, 2000),
    ...(toastId && { toastId }),
  };
}

module.exports = { PluginActionHub, SERVER_ACTION_PLACEMENTS, cleanBadge, toastEvent };
