const { basename } = require('path');
const { AGENT_SESSION_GUIDE, hasClaudeSystemPrompt } = require('./agent-session-guide');
const screen = require('./claude-screen');
const { createClaudeSettings, removeClaudeSettings } = require('./claude-settings');
const { claudeContextUsage } = require('./context-usage');
const { watchClaudeTitle } = require('./claude-title');

const claudeProvider = {
  id: 'claude-code',
  command: 'claude',
  supportsAsk: true,
  closeInput: '\x04\x04',
  interruptInput: '\x1b',
  // Stop supplies the canonical reply; the screen remains preview/menu input, never final-message truth.
  finalizeOnStop: true,
  screenFinalFallback: false,
  requiresResumeTranscript: true,
  screen,
  requiresSessionStart: true,
  contextUsage: claudeContextUsage,
  watchTitle: watchClaudeTitle,
  model: (payload) => payload.model?.display_name || payload.model?.id,
  modelId: (payload) => payload.model?.id,
  finalText(payload) {
    return String(payload.last_assistant_message || '').trim();
  },
  userText(payload) {
    return typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
  },
  promptEchoMatches(expected, actual) {
    // Claude expands large pastes into matching marker-only lines in hooks.
    // Normalize only the native echo, never the user's original message.
    const expanded = actual.replace(/^<pasted_content id="([0-9a-f]{4})">\r?\n([\s\S]*?)\r?\n<\/pasted_content id="\1">$/gm,
      (whole, id, content) => /^<\/?pasted_content /m.test(content) ? whole : content);
    return expected === expanded;
  },
  resumeMetadata(payload) {
    const transcriptPath = String(payload.transcript_path || '').trim();
    const transcriptId = transcriptPath ? basename(transcriptPath, '.jsonl') : '';
    return {
      handle: transcriptId || String(payload.session_id || '').trim(),
      transcriptPath,
    };
  },
  createLaunch({ command, port, sessionId, resumeHandle, model, agentGuide, extraArgs = [], serverUrl }) {
    const settingsPath = createClaudeSettings(port, sessionId, serverUrl);
    const args = ['--settings', settingsPath];
    const guide = agentGuide ?? AGENT_SESSION_GUIDE;
    if (guide && !hasClaudeSystemPrompt(command, extraArgs)) {
      args.push('--append-system-prompt', guide);
    }
    if (resumeHandle) args.push('--resume', resumeHandle);
    // Claude resumes on the model the conversation started with, not the one it was last using; restore that.
    // Last on the command line, so it follows any --model in a custom command or wrapper.
    if (resumeHandle && model) args.push('--model', model);
    return {
      command: command || this.command,
      args,
      cleanup: () => removeClaudeSettings(settingsPath),
    };
  },
};

module.exports = { claudeProvider };
