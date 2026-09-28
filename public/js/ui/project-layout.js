// Projects can sit in one level of groups (config.projectGroups; a project names its groupId). The order of
// config.projects is the whole layout: a group appears where its first member does and its members stay
// together, empty groups follow the projects, and a project naming a group that no longer exists shows as
// ungrouped rather than disappearing.
export function layoutProjects(projects, groups) {
  const known = new Map(groups.map((group) => [group.id, group]));
  const items = [];
  const byGroup = new Map();
  for (const project of projects) {
    const group = project.groupId && known.get(project.groupId);
    if (!group) { items.push({ type: "project", project }); continue; }
    let item = byGroup.get(group.id);
    if (!item) { item = { type: "group", group, projects: [] }; byGroup.set(group.id, item); items.push(item); }
    item.projects.push(project);
  }
  for (const group of groups) if (!byGroup.has(group.id)) items.push({ type: "group", group, projects: [] });
  return items;
}

function flatten(items) {
  return items.flatMap((item) => (item.type === "project" ? [item.project] : item.projects));
}

// Moving into a group appends the project to it; leaving puts it just below the group it left.
export function moveProjectToGroup(projects, groups, projectId, groupId) {
  const project = projects.find((p) => p.id === projectId);
  if (!project) return projects;
  const moved = { ...project };
  if (groupId) moved.groupId = groupId; else delete moved.groupId;
  const items = layoutProjects(projects.filter((p) => p.id !== projectId), groups);
  const at = items.findIndex((item) => item.type === "group" && item.group.id === (groupId || project.groupId));
  if (groupId && at >= 0) items[at].projects.push(moved);
  else items.splice(at >= 0 ? at + 1 : items.length, 0, { type: "project", project: moved });
  return flatten(items);
}

// Deleting a group keeps its projects (and their sessions); they become ungrouped where they were.
export function deleteProjectGroup(projects, groups, groupId) {
  return {
    projects: projects.map((p) => {
      if (p.groupId !== groupId) return p;
      const next = { ...p };
      delete next.groupId;
      return next;
    }),
    projectGroups: groups.filter((group) => group.id !== groupId),
  };
}
