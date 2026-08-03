const crypto = require('crypto');
const { cleanupAttemptFiles, cleanupTaskSnapshot, queueAttemptCleanup } = require('./task-attempt');
const { isSubmissionValidationMessage } = require('./media-errors');

const OPERATION_SCOPE = 'destructiveOperations';

function removeUnavailableTask({ store, toolRunner = null, taskId, reason, source = 'video-unavailable', excludeRunId = '' }) {
  const id = String(taskId || '');
  const existingTombstone = store.get('unavailableTasks', id);
  const task = store.getTask(id);
  if (!task) return { removed: false, tombstone: existingTombstone || null, cleanup: null };
  if (task.status === 'done') return { removed: false, tombstone: null, cleanup: null };

  const operation = {
    id: `unavailable-remove-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    type: 'unavailable-remove',
    task,
    reason: String(reason || 'Bilibili video is unavailable.').slice(0, 2000),
    source,
    excludeRunId,
    createdAt: new Date().toISOString()
  };
  store.set(OPERATION_SCOPE, operation.id, operation);
  store.commit();
  return executeUnavailableRemoval({ store, toolRunner, operation });
}

function executeUnavailableRemoval({ store, toolRunner = null, operation, recovery = false }) {
  const task = operation.task;

  const cancelledRuns = [];
  for (const run of store.listToolRuns({ taskId: task.id })) {
    if (run.id === operation.excludeRunId || !['queued', 'running'].includes(run.status)) continue;
    try {
      if (toolRunner?.cancel) toolRunner.cancel(run.id);
      else store.updateToolRun(run.id, { status: 'cancelled', stage: 'cancelled', signal: 'VIDEO_UNAVAILABLE', finishedAt: new Date().toISOString() });
      cancelledRuns.push(run.id);
    } catch {
      // A run may become terminal while the unavailable task is being removed.
    }
  }

  let cleanup = null;
  try {
    cleanup = cleanupAttemptFiles(store, task);
    store.delete('attemptCleanupQueue', task.id);
  }
  catch (error) {
    cleanup = { mode: 'cleanup-failed', error: error.message || String(error), deleted: [], preserved: [] };
    queueAttemptCleanup(store, cleanupTaskSnapshot(task), cleanup.error, operation.source);
    toolRunner?.scheduleCleanupRecovery?.();
  }

  const now = new Date().toISOString();
  const tombstone = {
    id: task.id,
    taskId: task.id,
    collectionId: task.collectionId,
    bvid: task.bvid,
    title: task.title,
    owner: task.owner || '',
    reason: operation.reason,
    source: operation.source,
    removedAt: now,
    workId: task.workId || '',
    claimedBy: task.claimedBy || '',
    recoverableTask: recoverableTaskSnapshot(task),
    cancelledRuns,
    cleanup
  };
  store.transaction(() => {
    store.set('unavailableTasks', task.id, tombstone);
    store.delete('tasks', task.id);
    store.delete('videos', task.id);
    const collection = store.getCollectionById(task.collectionId);
    if (collection) {
      collection.videoCount = store.listTasks({ collectionId: collection.id }).length;
      collection.updatedAt = now;
      store.set('collections', collection.id, collection);
    }
    store.delete(OPERATION_SCOPE, operation.id);
  });
  store.recordTaskEvent(task.id, recovery ? 'video-unavailable-recovered' : 'video-unavailable', {
    collectionId: task.collectionId,
    workerId: task.claimedBy || '',
    workId: task.workId || '',
    reason: tombstone.reason,
    source: operation.source,
    cancelledRuns,
    cleanup
  });
  return { removed: true, tombstone, cleanup, cancelledRuns, recovered: recovery };
}

function recoverPendingUnavailableRemovals({ store, onEvent = () => {} }) {
  const results = [];
  for (const operation of store.list(OPERATION_SCOPE).filter((item) => item.type === 'unavailable-remove')) {
    try {
      const result = executeUnavailableRemoval({ store, operation, recovery: true });
      results.push({ ok: true, ...result });
      onEvent({ type: 'video-unavailable-recovered', taskId: operation.task?.id || '', collectionId: operation.task?.collectionId || '' });
    } catch (error) {
      results.push({ ok: false, operationId: operation.id, taskId: operation.task?.id || '', error: error.message || String(error) });
    }
  }
  return results;
}

function recoverMisclassifiedUnavailableTasks({ store, onEvent = () => {} }) {
  const candidates = store.list('unavailableTasks').filter((item) => isSubmissionValidationMessage(item.reason));
  if (!candidates.length) return [];
  const restored = [];
  const touchedCollections = new Set();
  const now = new Date().toISOString();
  store.transaction(() => {
    for (const tombstone of candidates) {
      const collection = store.getCollectionById(tombstone.collectionId);
      if (!collection || collection.biliDeleted || collection.syncState === 'deleted') continue;
      const existing = store.getTask(tombstone.taskId || tombstone.id);
      if (!existing) {
        const source = tombstone.recoverableTask || {};
        const id = String(tombstone.taskId || tombstone.id);
        store.set('tasks', id, {
          ...source,
          id,
          collectionId: tombstone.collectionId,
          bvid: tombstone.bvid || source.bvid || '',
          title: tombstone.title || source.title || tombstone.bvid || id,
          sourceTitle: source.sourceTitle || tombstone.title || source.title || tombstone.bvid || id,
          owner: tombstone.owner || source.owner || '',
          url: source.url || (tombstone.bvid ? `https://www.bilibili.com/video/${tombstone.bvid}` : ''),
          favoriteState: source.favoriteState || 'active',
          removedFromFavorites: false,
          removedFromFavoritesAt: '',
          enabled: source.enabled !== false,
          status: 'pending',
          workId: '',
          claimedBy: '',
          claimedAt: '',
          leaseExpiresAt: '',
          artifactDir: '',
          outputMarkdown: '',
          validatorErrors: [],
          failureReason: '',
          abortReason: '',
          abortSource: '',
          abortedAt: '',
          workspaceId: source.workspaceId || collection.workspaceId || '',
          workspaceRoot: source.workspaceRoot || collection.workspaceRoot || '',
          allowedRoot: source.allowedRoot || collection.collectionRoot || collection.workspaceRoot || '',
          createdAt: source.createdAt || tombstone.removedAt || now,
          updatedAt: now
        });
      }
      store.delete('unavailableTasks', tombstone.id);
      restored.push({ ...tombstone, taskId: tombstone.taskId || tombstone.id });
      touchedCollections.add(tombstone.collectionId);
    }
    for (const collectionId of touchedCollections) {
      const collection = store.getCollectionById(collectionId);
      const videoCount = store.listTasks({ collectionId }).filter((task) => !task.removedFromFavorites && task.favoriteState !== 'removed' && task.favoriteState !== 'collection-deleted').length;
      store.set('collections', collectionId, { ...collection, videoCount, updatedAt: now });
    }
  });
  for (const item of restored) {
    store.recordTaskEvent(item.taskId, 'misclassified-unavailable-restored', {
      collectionId: item.collectionId,
      bvid: item.bvid,
      previousReason: item.reason,
      source: 'startup-migration'
    });
    onEvent({ type: 'misclassified-unavailable-restored', taskId: item.taskId, collectionId: item.collectionId, bvid: item.bvid, previousReason: item.reason });
  }
  return restored;
}

function recoverableTaskSnapshot(task = {}) {
  const copy = { ...task };
  for (const key of ['workId', 'claimedBy', 'claimedAt', 'leaseExpiresAt', 'artifactDir', 'outputMarkdown', 'validatorErrors']) delete copy[key];
  return copy;
}

function isUnavailableTask(store, taskId) {
  return Boolean(store.get('unavailableTasks', String(taskId || '')));
}

module.exports = { isUnavailableTask, recoverMisclassifiedUnavailableTasks, recoverPendingUnavailableRemovals, removeUnavailableTask };
