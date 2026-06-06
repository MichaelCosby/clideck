function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function isLoopback(req) {
  const addr = req.socket?.remoteAddress || '';
  return addr === '::1' || addr === '127.0.0.1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.');
}

function sameProject(a, b) {
  return (a.projectId || null) === (b.projectId || null);
}

function listProjectAgents(callerSessionId, sessionsApi) {
  const sessions = sessionsApi.getSessions();
  const callerId = String(callerSessionId || '').trim();
  const caller = sessions.get(callerId);
  if (!caller) {
    const err = new Error('Caller session is not active');
    err.status = 404;
    throw err;
  }

  return [...sessions]
    .filter(([, s]) => sameProject(caller, s))
    .map(([id, s]) => ({
      id,
      name: s.name || id.slice(0, 8),
      preset: s.presetId || 'shell',
      working: !!s.working,
      lastPreview: s.lastPreview || '',
      lastActivityAt: s.lastActivityAt || null,
      caller: id === callerId,
    }));
}

async function handleHttp(req, res, sessionsApi) {
  try {
    if (!isLoopback(req)) {
      const err = new Error('CliDeck agents only accepts local requests');
      err.status = 403;
      throw err;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const agents = listProjectAgents(url.searchParams.get('callerSessionId'), sessionsApi);
    sendJson(res, 200, { agents });
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.message || 'CliDeck agents failed' });
  }
}

module.exports = { handleHttp, listProjectAgents };
