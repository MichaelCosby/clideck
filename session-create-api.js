const { sendJson, isLoopback, projectName, sessionAddress } = require('./http-util');

const MAX_BODY = 64 * 1024;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY) {
        req.destroy();
        reject(new Error('Request too large'));
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function jsonError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function createSiblingSession(payload, sessionsApi, cfg = {}) {
  const sessions = sessionsApi.getSessions();
  const callerId = String(payload.callerSessionId || '').trim();
  const caller = sessions.get(callerId);
  if (!caller) throw jsonError('Caller session is not active', 404);

  if (!payload.presetId && !payload.commandId) {
    payload = { ...payload, presetId: caller.presetId };
  }
  const cwd = payload.cwd || caller.cwd;
  const projectId = payload.projectId !== undefined ? payload.projectId : caller.projectId;

  const result = sessionsApi.createProgrammatic({
    presetId: payload.presetId,
    commandId: payload.commandId,
    cwd,
    name: payload.name,
    projectId,
    themeId: payload.themeId,
    ephemeral: !!payload.ephemeral,
  }, cfg);
  if (result.error) throw jsonError(result.error, 409);

  const s = sessions.get(result.id);
  const projects = Array.isArray(cfg.projects) ? cfg.projects : [];
  return {
    id: result.id,
    name: s.name || result.id.slice(0, 8),
    preset: s.presetId || 'shell',
    projectId: s.projectId || null,
    project: projectName(projects, s.projectId),
    address: sessionAddress(s, result.id, projects),
    cwd: s.cwd || null,
  };
}

async function handleHttp(req, res, sessionsApi, getConfig = () => ({})) {
  try {
    if (!isLoopback(req)) {
      const err = new Error('CliDeck create only accepts local requests');
      err.status = 403;
      throw err;
    }
    const payload = await readJson(req);
    const session = createSiblingSession(payload, sessionsApi, getConfig() || {});
    sendJson(res, 200, { session });
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.message || 'CliDeck create failed' });
  }
}

module.exports = { handleHttp, createSiblingSession };
