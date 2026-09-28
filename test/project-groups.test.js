const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { isValidConfigPatch } = require('../src/config-store');
const { createBackup, restoreBackup } = require('../src/backup');
const { HeadlessServer } = require('../src/server');

const project = (id, groupId) => ({ id, name: id, path: `/src/${id}`, color: '#123456', collapsed: false, ...(groupId && { groupId }) });
const group = (id) => ({ id, name: id, collapsed: false });

test('layout keeps group members together, shows orphans, and lists empty groups last', async () => {
  const { layoutProjects } = await import('../public/js/ui/project-layout.js');
  const shape = (items) => items.map((i) => (i.type === 'project' ? i.project.id : `${i.group.id}[${i.projects.map((p) => p.id)}]`)).join(' ');
  const projects = [project('a'), project('b', 'g1'), project('c'), project('d', 'g1'), project('e', 'gone')];
  assert.equal(shape(layoutProjects(projects, [group('g1'), group('g2')])), 'a g1[b,d] c e g2[]');
});

test('moving projects between groups and deleting a group', async () => {
  const { layoutProjects, moveProjectToGroup, deleteProjectGroup } = await import('../public/js/ui/project-layout.js');
  const groups = [group('g1'), group('g2')];
  const ids = (list) => list.map((p) => `${p.id}${p.groupId ? `:${p.groupId}` : ''}`).join(' ');
  let projects = [project('a'), project('b', 'g1'), project('c')];
  projects = moveProjectToGroup(projects, groups, 'c', 'g1');
  assert.equal(ids(projects), 'a b:g1 c:g1', 'joining a group appends to it');
  projects = moveProjectToGroup(projects, groups, 'a', 'g2');
  assert.equal(ids(projects), 'b:g1 c:g1 a:g2', 'joining an empty group places it with that group');
  projects = moveProjectToGroup(projects, groups, 'b', null);
  assert.equal(ids(projects), 'c:g1 b a:g2', 'leaving lands just below the old group');
  const after = deleteProjectGroup(projects, groups, 'g1');
  assert.equal(ids(after.projects), 'c b a:g2', 'deleting a group keeps its projects');
  assert.deepEqual(after.projectGroups.map((g) => g.id), ['g2']);
  assert.equal(layoutProjects(after.projects, after.projectGroups).length, 3);
});

test('config validates groups and group references', () => {
  assert.equal(isValidConfigPatch({ projects: [project('a', 'g1')], projectGroups: [group('g1')] }), true);
  assert.equal(isValidConfigPatch({ projects: [project('a', '../bad')] }), false);
  assert.equal(isValidConfigPatch({ projectGroups: [group('g1'), group('g1')] }), false);
  assert.equal(isValidConfigPatch({ projectGroups: [{ id: 'g1', name: ' ', collapsed: false }] }), false);
});

test('backups carry groups, and a restored project brings its group along', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-groups-backup-'));
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  server.broadcast = () => {};
  try {
    server.configStore.update({ projects: [project('a', 'g1'), project('b')], projectGroups: [group('g1')] });
    const backup = createBackup(server);
    assert.deepEqual(backup.projectGroups.map((g) => g.id), ['g1']);
    server.configStore.update({ projects: [], projectGroups: [] });
    restoreBackup(server, backup, { settings: [], projects: ['a'], sessions: [] });
    const config = server.configStore.get();
    assert.deepEqual(config.projects.map((p) => p.id), ['a']);
    assert.deepEqual(config.projectGroups.map((g) => g.id), ['g1']);
    const old = { ...backup };
    delete old.projectGroups;
    server.configStore.update({ projects: [], projectGroups: [] });
    restoreBackup(server, old, { settings: [], projects: ['b'], sessions: [] });
    assert.deepEqual(server.configStore.get().projects.map((p) => p.id), ['b'], 'backups from before groups still restore');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
