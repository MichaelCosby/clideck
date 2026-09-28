const { execFile } = require('child_process');

function readProcessInfo(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve({ error: 'No running process.' });
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'rss=,vsz=', '-p', String(pid)], { timeout: 5000 }, (error, stdout) => {
      const [rssKb, vszKb] = String(stdout || '').trim().split(/\s+/).map(Number);
      if (error || !Number.isFinite(rssKb) || !Number.isFinite(vszKb)) {
        resolve({ pid, error: 'Process info unavailable.' });
        return;
      }
      resolve({ pid, rssKb, vszKb });
    });
  });
}

module.exports = { readProcessInfo };
