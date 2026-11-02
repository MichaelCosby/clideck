function hasProjectId(value) {
  return Object.prototype.hasOwnProperty.call(value || {}, 'projectId');
}

function sameSessionScope(left, right) {
  const leftHasProject = hasProjectId(left);
  const rightHasProject = hasProjectId(right);
  if (leftHasProject || rightHasProject) {
    return leftHasProject && rightHasProject
      && (left.projectId || null) === (right.projectId || null);
  }
  return left.cwd === right.cwd;
}

function projectName(projects, projectId) {
  return projects.find((project) => project.id === projectId)?.name || projectId;
}

function cwdGroupName(cwd) {
  const value = String(cwd || '').replace(/[\\/]+$/, '');
  if (!value) return '';
  return value.split(/[\\/]/).pop();
}

const { realpathSync } = require('fs');
const { relative, resolve, isAbsolute } = require('path');

function real(path) {
  try { return realpathSync(path); } catch { return resolve(String(path || '')); }
}

// The project whose folder is `cwd` or contains it; the deepest one when projects nest.
function projectForFolder(projects, cwd) {
  const target = real(cwd);
  let best = null;
  let bestLength = -1;
  for (const project of projects || []) {
    if (!project?.path) continue;
    const root = real(project.path);
    const rel = relative(root, target);
    if (rel.startsWith('..') || isAbsolute(rel)) continue;
    if (root.length > bestLength) { best = project; bestLength = root.length; }
  }
  return best;
}

// A project named by the user or an agent: its id, or its name when exactly one project has it.
function resolveProjectRef(projects, ref) {
  const value = String(ref || '').trim();
  const byId = (projects || []).find((project) => project.id === value);
  if (byId) return { project: byId };
  const named = (projects || []).filter((project) => String(project.name).toLowerCase() === value.toLowerCase());
  if (named.length === 1) return { project: named[0] };
  return { error: named.length ? 'ambiguous_project' : 'unknown_project' };
}

function sessionAddress(entry, projects) {
  const name = entry.name || entry.id;
  const scope = entry.projectId
    ? projectName(projects, entry.projectId)
    : cwdGroupName(entry.cwd);
  return scope ? `@${scope}/${name}` : name;
}

module.exports = {
  cwdGroupName,
  hasProjectId,
  projectForFolder,
  projectName,
  resolveProjectRef,
  sameSessionScope,
  sessionAddress,
};
