const crypto = require('crypto');
const { collectionStorageName, isBiliCollection, taskSourceTitle } = require('./collection-state');
const { sharedExclusionId } = require('./shared-knowledge-manager');
const { cleanupAttemptFiles, cleanupTaskSnapshot, queueAttemptCleanup } = require('./task-attempt');

const OPERATION_SCOPE = 'destructiveOperations';

function deleteCompletedDocument({ store, taskId, source = 'document-library' }) {
  const task = store.getTask(String(taskId || ''));
  if (!task || task.status !== 'done' || !task.outputMarkdown) throw new Error('找不到可删除的已完成文档。');
  const collection = store.getCollectionById(task.collectionId);
  if (!collection) throw new Error('文档所属收藏夹不存在，无法安全更新任务状态。');

  const documentFamily = task.multiPartRole === 'parent' && String(task.sourceType || '').startsWith('shared-')
    ? store.listTasks({ collectionId: task.collectionId }).filter((item) => item.id === task.id || item.multiPartParentId === task.id)
    : task.singleTask === true
      ? store.listTasks({ collectionId: task.collectionId }).filter((item) => item.singleTask === true && item.bvid === task.bvid)
      : [task];
  const remoteMembershipGone = isBiliCollection(collection) && (
    collection.biliDeleted
    || task.removedFromFavorites
    || ['removed', 'collection-deleted'].includes(task.favoriteState)
  );
  const operation = {
    id: `document-delete-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    type: 'document-delete',
    source,
    task,
    collectionId: collection.id,
    documentFamily,
    cleanupTasks: documentFamily.map(cleanupTaskSnapshot),
    remoteMembershipGone,
    restoreToPending: isBiliCollection(collection) && !remoteMembershipGone && task.singleTask !== true,
    createdAt: new Date().toISOString()
  };
  store.set(OPERATION_SCOPE, operation.id, operation);
  store.commit();
  return executeDocumentDeletion(store, operation);
}

function executeDocumentDeletion(store, operation, { recovery = false } = {}) {
  const task = operation.task;
  const collection = store.getCollectionById(operation.collectionId);
  const cleanups = operation.cleanupTasks.map((cleanupTask) => cleanupWithRetry(store, cleanupTask, operation.source));
  const cleanupTask = cleanupTaskSnapshot(task);
  const cleanup = cleanups.find((item) => item.taskId === task.id)?.cleanup || { mode: 'none', deleted: [], preserved: [] };
  const now = new Date().toISOString();
  let restored = false;
  let removed = false;

  store.transaction(() => {
    if (!operation.restoreToPending) {
      if (collection?.collectionKind === 'shared' && task.sharedRemotePath) {
        const exclusionId = sharedExclusionId(collection.id, task.sharedRemotePath, task.sharedRepository);
        store.set('sharedExclusions', exclusionId, {
          id: exclusionId,
          collectionId: collection.id,
          remotePath: task.sharedRemotePath,
          repository: task.sharedRepository || null,
          documentId: task.sharedDocumentId || '',
          excludedAt: now,
          reason: '用户从文档库删除共享文档。'
        });
      }
      for (const removedTask of operation.documentFamily) {
        store.delete('tasks', removedTask.id);
        store.delete('videos', removedTask.id);
        for (const session of store.list('internalAgentSessions').filter((item) => item.singleTaskId === removedTask.id)) {
          store.delete('internalAgentSessions', session.id);
          const worker = store.getWorker(session.workerId);
          if (worker) store.set('workers', worker.id, { ...worker, status: 'paused', pauseReason: '对应的单视频总结产物已被用户删除。', pausedAt: worker.pausedAt || now, updatedAt: now });
        }
      }
      if (operation.remoteMembershipGone) {
        store.set('removedFavoriteTasks', task.id, {
          ...(store.get('removedFavoriteTasks', task.id) || {}),
          id: task.id,
          taskId: task.id,
          collectionId: task.collectionId,
          bvid: task.bvid,
          title: taskSourceTitle(task),
          reason: collection?.biliDeleted
            ? 'B站收藏夹已删除，文档被用户删除后不恢复总结任务。'
            : '视频已移出B站收藏夹，文档被用户删除后不恢复总结任务。',
          removedAt: now,
          cleanupPending: cleanups.some((item) => item.cleanup.mode === 'cleanup-failed'),
          cleanupTask
        });
      }
      removed = true;
    } else {
      const cache = task.cachedVideoId ? store.getVideoCache(task.cachedVideoId) : null;
      store.upsertTask({
        ...task,
        title: taskSourceTitle(task),
        status: 'pending',
        enabled: task.enabled !== false,
        workId: '',
        claimedBy: '',
        claimedAt: '',
        leaseExpiresAt: '',
        completedAt: '',
        artifactDir: cache?.artifactDir || '',
        outputMarkdown: '',
        metadataFile: cache?.metadataFile || '',
        coverFile: cache?.coverFile || '',
        cachedVideoFile: cache?.videoFile || '',
        workspaceId: cache ? task.workspaceId : '',
        workspaceRoot: cache ? task.workspaceRoot : '',
        allowedRoot: cache?.allowedRoot || (cache ? task.allowedRoot : ''),
        validatorErrors: [],
        failureReason: '',
        infrastructureError: '',
        abortReason: '',
        abortSource: '',
        abortedAt: '',
        documentDeletedAt: now,
        knowledgeActive: true,
        supersededByTaskId: '',
        updatedAt: now
      });
      restored = true;
    }

    const latestCollection = collection && store.getCollectionById(collection.id);
    if (latestCollection) {
      const tasks = store.listTasks({ collectionId: collection.id });
      const archivedDocumentCount = tasks.filter((item) => item.status === 'done' && item.outputMarkdown && (item.removedFromFavorites || item.favoriteState === 'collection-deleted')).length;
      store.set('collections', collection.id, {
        ...latestCollection,
        storageName: collectionStorageName(latestCollection),
        videoCount: latestCollection.internal === true ? tasks.length : latestCollection.videoCount,
        archivedDocumentCount,
        updatedAt: now
      });
    }
    store.delete(OPERATION_SCOPE, operation.id);
  });

  store.recordTaskEvent(task.id, recovery ? 'document-delete-recovered' : 'document-deleted', {
    collectionId: task.collectionId,
    bvid: task.bvid,
    source: operation.source,
    restored,
    removed,
    cleanup,
    cleanups
  });
  return {
    taskId: task.id,
    collectionId: task.collectionId,
    collectionName: collection?.name || '',
    bvid: task.bvid,
    restored,
    removed,
    recovered: recovery,
    reason: removed
      ? (task.singleTask ? 'single-task-deleted' : operation.remoteMembershipGone ? (collection?.biliDeleted ? 'collection-deleted' : 'removed-from-favorites') : 'local-task-deleted')
      : 'pending',
    cleanup,
    cleanups
  };
}

function cleanupWithRetry(store, cleanupTask, source) {
  try {
    const cleanup = cleanupAttemptFiles(store, cleanupTask);
    store.delete('attemptCleanupQueue', cleanupTask.id);
    return { taskId: cleanupTask.id, cleanupTask, cleanup };
  } catch (error) {
    const cleanup = { mode: 'cleanup-failed', error: error.message || String(error), deleted: [], preserved: [] };
    queueAttemptCleanup(store, cleanupTask, cleanup.error, source);
    return { taskId: cleanupTask.id, cleanupTask, cleanup };
  }
}

function recoverPendingDocumentDeletions(store) {
  const results = [];
  for (const operation of store.list(OPERATION_SCOPE).filter((item) => item.type === 'document-delete')) {
    try { results.push({ ok: true, ...executeDocumentDeletion(store, operation, { recovery: true }) }); }
    catch (error) { results.push({ ok: false, operationId: operation.id, taskId: operation.task?.id || '', error: error.message || String(error) }); }
  }
  return results;
}

module.exports = { deleteCompletedDocument, recoverPendingDocumentDeletions };
