function settings(api) {
  return {
    voice: api.getSetting('voice'),
    shortcut: api.getSetting('shortcut'),
    language: api.getSetting('language'),
    normalization: api.getSetting('normalization'),
    quality: api.getSetting('quality'),
    playbackRate: Number(api.getSetting('playback-rate')) || 1,
  };
}

function speechText(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('Provide text to read.');
  return text;
}

exports.activate = (api) => {
  api.registerCommand('speak', ({ args, stdin, sessionId }) => {
    const text = speechText(args.join(' ').trim() || stdin);
    api.sendToClients('speak', { text, sessionId, source: 'agent' });
    return 'Sent to Supertonic.\n';
  });

  api.onClientMessage('ready', (_data, context) => {
    context.reply('settings', settings(api));
  });

  api.onSettingsChange(() => api.sendToClients('settings', settings(api)));

  // A completion belongs only to the browser that requested it, never every client.
  api.onClientMessage('auto-read-result', (data, context) => {
    if (typeof data?.token === 'string' && data.token.length <= 200
      && ['deferred', 'finished', 'failed'].includes(data.status)) {
      context.reply('auto-read-result', { token: data.token, status: data.status });
    }
  });
};
