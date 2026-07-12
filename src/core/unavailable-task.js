const { cleanupAttemptFiles } = require('./task-attempt');

function removeUnavailableTask({ store, toolRunner = null, taskId, reason, source = 'video-unavailable', excludeRunId = '' }) {
  const id = String(taskId || '');
  const existingTombstone = store.get('unavailableTasks', id);
  const task = store.getTask(id);
  if (!task) return { removed: false, tombstone: existingTombstone || null, cleanup: null };
  if (task.status === 'done') return { removed: false, tombstone: null, cleanup: null };

  const cancelledRuns = [];
  for (const run of store.listToolRuns({ taskId: task.id })) {
    if (run.id === excludeRunId || !['queued', 'running'].includes(run.status)) continue;
    try {
      if (toolRunner?.cancel) toolRunner.cancel(run.id);
      else store.updateToolRun(run.id, { status: 'cancelled', stage: 'cancelled', signal: 'VIDEO_UNAVAILABLE', finishedAt: new Date().toISOString() });
      cancelledRuns.push(run.id);
    } catch {
      // A run may become terminal while the unavailable task is being removed.
    }
  }

  let cleanup = null;
  try { cleanup = cleanupAttemptFiles(store, task); }
  catch (error) { cleanup = { mode: 'cleanup-failed', error: error.message || String(error), deleted: [], preserved: [] }; }

  const now = new Date().toISOString();
  const tombstone = {
    id: task.id,
    taskId: task.id,
    collectionId: task.collectionId,
    bvid: task.bvid,
    title: task.title,
    owner: task.owner || '',
    reason: String(reason || 'Bilibili video is unavailable.').slice(0, 2000),
    source,
    removedAt: now,
    workId: task.workId || '',
    claimedBy: task.claimedBy || '',
    cancelledRuns,
    cleanup
  };
  store.set('unavailableTasks', task.id, tombstone);
  store.delete('tasks', task.id);
  store.delete('videos', task.id);
  const collection = store.getCollectionById(task.collectionId);
  if (collection) {
    collection.videoCount = store.listTasks({ collectionId: collection.id }).length;
    collection.updatedAt = now;
    store.set('collections', collection.id, collection);
  }
  store.save();
  store.recordTaskEvent(task.id, 'video-unavailable', {
    collectionId: task.collectionId,
    workerId: task.claimedBy || '',
    workId: task.workId || '',
    reason: tombstone.reason,
    source,
    cancelledRuns,
    cleanup
  });
  return { removed: true, tombstone, cleanup, cancelledRuns };
}

function isUnavailableTask(store, taskId) {
  return Boolean(store.get('unavailableTasks', String(taskId || '')));
}

module.exports = { isUnavailableTask, removeUnavailableTask };
