const { collectionStorageName, isBiliCollection, taskSourceTitle } = require('./collection-state');
const { cleanupAttemptFiles, cleanupTaskSnapshot } = require('./task-attempt');
const { activateLatestKnowledgeVersion } = require('./task-versions');

function deleteCompletedDocument({ store, taskId, source = 'document-library' }) {
  const task = store.getTask(String(taskId || ''));
  if (!task || task.status !== 'done' || !task.outputMarkdown) throw new Error('找不到可删除的已完成文档。');
  const collection = store.getCollectionById(task.collectionId);
  if (!collection) throw new Error('文档所属收藏夹不存在，无法安全更新任务状态。');

  const cleanupTask = cleanupTaskSnapshot(task);
  const cleanup = cleanupAttemptFiles(store, task);
  const remoteMembershipGone = isBiliCollection(collection) && (
    collection.biliDeleted
    || task.removedFromFavorites
    || ['removed', 'collection-deleted'].includes(task.favoriteState)
  );
  const now = new Date().toISOString();
  let restored = false;
  let removed = false;

  store.transaction(() => {
    if (remoteMembershipGone) {
      store.delete('tasks', task.id);
      store.delete('videos', task.id);
      store.set('removedFavoriteTasks', task.id, {
        ...(store.get('removedFavoriteTasks', task.id) || {}),
        id: task.id,
        taskId: task.id,
        collectionId: task.collectionId,
        bvid: task.bvid,
        title: taskSourceTitle(task),
        reason: collection.biliDeleted
          ? 'B站收藏夹已删除，文档被用户删除后不恢复总结任务。'
          : '视频已移出B站收藏夹，文档被用户删除后不恢复总结任务。',
        removedAt: now,
        cleanupPending: false,
        cleanupTask
      });
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

    activateLatestKnowledgeVersion(store, task);
    const latestCollection = store.getCollectionById(collection.id);
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
  });

  store.recordTaskEvent(task.id, 'document-deleted', {
    collectionId: task.collectionId,
    bvid: task.bvid,
    source,
    restored,
    removed,
    cleanup
  });
  return {
    taskId: task.id,
    collectionId: task.collectionId,
    collectionName: collection.name,
    bvid: task.bvid,
    restored,
    removed,
    reason: removed
      ? (collection.biliDeleted ? 'collection-deleted' : 'removed-from-favorites')
      : 'pending',
    cleanup
  };
}

module.exports = { deleteCompletedDocument };
