const { binName } = require('./utils');

function presetForCommand(cmd, presets, options = {}) {
  const usePresetId = options.usePresetId !== false;
  if (usePresetId && cmd?.presetId) {
    const preset = presets.find(p => p.presetId === cmd.presetId);
    if (preset) return preset;
  }
  const bin = binName(cmd?.command);
  return presets.find(p => binName(p.command) === bin);
}

// Answering a detected menu normally flips a session back to "working" until its
// push-status mechanism reports idle again. Capture-finalized agents (e.g.
// antigravity) have no such mechanism, so they must NOT flip to working — nothing
// would ever return them to idle and the state would stick forever.
function menuStartsWork(presetId, hasMenuVersion, finalizeOnCapture) {
  if (finalizeOnCapture) return false;
  return !(presetId === 'claude-code' && !hasMenuVersion);
}

module.exports = { presetForCommand, menuStartsWork };
