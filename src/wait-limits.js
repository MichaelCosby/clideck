// The longest an ask, prompt or annotate may wait for its answer. The CLI checks --timeout against it and the
// engine checks again, so the two cannot disagree about what is allowed.
const MAX_WAIT_MS = 2 * 60 * 60 * 1000;

module.exports = { MAX_WAIT_MS };
