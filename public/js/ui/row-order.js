// Order of session rows inside one sidebar group: pinned rows in pin order, then needs-you, working, idle and
// stopped. Within a status, the row that most recently entered it comes first, so a session that just finished
// tops the idle rows while working rows don't jitter as their output streams. Ties keep arrival order.
export const RANK = Object.freeze({ pinned: 0, attention: 1, working: 2, idle: 3, stopped: 4 });

export function rankOf(s, pinned) {
  if (pinned.includes(s.id)) return RANK.pinned;
  if (s.live === false) return RANK.stopped;
  if (s.attention) return RANK.attention;
  if (s.status === "working") return RANK.working;
  return RANK.idle;
}

export function createRowOrder() {
  const entered = new Map();   // id -> { rank, at }

  // Rows seen for the first time keep arrival order (at 0); a stopped one sorts by its recorded activity.
  function note(s, pinned, now = Date.now()) {
    const rank = rankOf(s, pinned);
    const prev = entered.get(s.id);
    if (!prev || prev.rank !== rank) {
      const at = prev ? now : rank === RANK.stopped ? Date.parse(s.lastActive) || 0 : 0;
      entered.set(s.id, { rank, at });
    }
    return rank;
  }

  function sort(ids, pinned, seqOf) {
    const info = (id) => entered.get(id) || { rank: RANK.idle, at: 0 };
    return ids.slice().sort((a, b) => {
      const x = info(a), y = info(b);
      if (x.rank !== y.rank) return x.rank - y.rank;
      if (x.rank === RANK.pinned) return pinned.indexOf(a) - pinned.indexOf(b);
      if (x.at !== y.at) return y.at - x.at;
      return seqOf(a) - seqOf(b);
    });
  }

  return { note, sort, forget: (id) => entered.delete(id) };
}
