const fs = require('fs');

function relatedSingleVersions(store, task = {}) {
  if (!task.collectionId || !task.bvid) return [];
  const groupId = String(task.versionGroupId || '');
  return store.listTasks({ collectionId: task.collectionId }).filter((item) => (
    item.bvid === task.bvid
    && (groupId
      ? (String(item.versionGroupId || '') === groupId || item.id === groupId)
      : (task.singleTask === true && item.singleTask === true))
  ));
}

function activateKnowledgeVersion(store, taskId) {
  const active = store.getTask(String(taskId || ''));
  if (!active) return null;
  for (const task of relatedSingleVersions(store, active)) {
    if (task.status !== 'done' || !task.outputMarkdown) continue;
    const selected = task.id === active.id;
    store.upsertTask({
      ...task,
      knowledgeActive: selected,
      supersededByTaskId: selected ? '' : active.id,
      updatedAt: selected ? task.updatedAt : new Date().toISOString()
    });
  }
  return active;
}

function activateLatestKnowledgeVersion(store, task = {}) {
  const related = relatedSingleVersions(store, task);
  const completed = related
    .filter((item) => item.status === 'done' && item.outputMarkdown && fs.existsSync(item.outputMarkdown))
    .sort((left, right) => {
      const completedOrder = String(right.completedAt || '').localeCompare(String(left.completedAt || ''));
      return completedOrder || Number(right.revision || 1) - Number(left.revision || 1) || String(right.createdAt || '').localeCompare(String(left.createdAt || ''));
    });
  if (!completed.length) {
    for (const item of related) {
      if (item.status !== 'done' || item.knowledgeActive === false) continue;
      store.upsertTask({ ...item, knowledgeActive: false, supersededByTaskId: '', updatedAt: new Date().toISOString() });
    }
    return null;
  }
  return activateKnowledgeVersion(store, completed[0].id);
}

module.exports = { activateKnowledgeVersion, activateLatestKnowledgeVersion, relatedSingleVersions };
