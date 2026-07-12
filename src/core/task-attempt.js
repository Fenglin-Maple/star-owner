const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { assertInside } = require('./workspace');

const ACTIVE_RUNS = new Set(['queued', 'running']);

function abortTaskAttempt({ store, toolRunner = null, taskId, workerId = '', reason = 'Task attempt aborted.', source = 'unknown' }) {
  const task = store.getTask(String(taskId || ''));
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.status === 'done') throw new Error('Completed tasks cannot be aborted.');
  if (workerId && task.claimedBy && task.claimedBy !== workerId) throw new Error(`Task is owned by another worker: ${task.claimedBy}`);
  if (task.status === 'pending' && !task.claimedBy && task.abortedAt) {
    return {
      task,
      cancelledRuns: [],
      cleanup: { mode: 'already-aborted', deleted: [], preserved: [] },
      alreadyAborted: true
    };
  }

  const cancelledRuns = [];
  for (const run of store.listToolRuns({ taskId: task.id })) {
    if (!ACTIVE_RUNS.has(run.status)) continue;
    try {
      if (toolRunner?.cancel) toolRunner.cancel(run.id);
      else store.updateToolRun(run.id, { status: 'cancelled', stage: 'cancelled', signal: 'ATTEMPT_ROLLED_BACK', finishedAt: new Date().toISOString() });
      cancelledRuns.push(run.id);
    } catch {
      // The run may have reached a terminal state between the list and cancel calls.
    }
  }

  const cleanup = cleanupAttemptFiles(store, task);
  const cache = task.cachedVideoId ? store.getVideoCache(task.cachedVideoId) : null;
  const endedWorkId = task.workId || '';
  const now = new Date().toISOString();
  Object.assign(task, {
    status: 'pending',
    workId: '',
    claimedBy: '',
    claimedAt: '',
    leaseExpiresAt: '',
    completedAt: '',
    outputMarkdown: '',
    metadataFile: cache?.metadataFile || '',
    coverFile: cache?.coverFile || '',
    cachedVideoFile: cache?.videoFile || '',
    artifactDir: cache?.artifactDir || '',
    workspaceId: cache ? task.workspaceId : '',
    workspaceRoot: cache ? task.workspaceRoot : '',
    allowedRoot: cache?.allowedRoot || (cache ? task.allowedRoot : ''),
    validatorErrors: [],
    failureReason: '',
    infrastructureError: '',
    abortReason: String(reason || 'Task attempt aborted.'),
    abortSource: String(source || 'unknown'),
    abortedAt: now,
    updatedAt: now
  });
  store.upsertTask(task);
  store.commit();
  store.recordTaskEvent(task.id, 'attempt-aborted', {
    collectionId: task.collectionId,
    workerId,
    reason: task.abortReason,
    source: task.abortSource,
    workId: endedWorkId,
    cancelledRuns,
    cleanup
  });
  return { task, endedWorkId, cancelledRuns, cleanup, alreadyAborted: false };
}

function createWorkId() {
  return `work-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 12)}`;
}

function cleanupAttemptFiles(store, task) {
  const artifactDir = String(task.artifactDir || '');
  if (!artifactDir || !fs.existsSync(artifactDir)) return { mode: task.cachedVideoId ? 'preserve-cache-source' : 'remove-attempt-directory', deleted: [], preserved: [] };
  const allowedRoot = path.resolve(task.allowedRoot || task.workspaceRoot || path.dirname(artifactDir));
  const artifact = assertInside(allowedRoot, artifactDir);
  if (artifact === allowedRoot) throw new Error('Refusing to clean a task whose artifact directory is the allowed root itself.');

  if (!task.cachedVideoId) {
    removePath(artifact);
    return { mode: 'remove-attempt-directory', deleted: [artifact], preserved: [] };
  }

  const cache = store.getVideoCache(task.cachedVideoId);
  const keep = new Set([
    cache?.videoFile,
    task.cachedVideoFile,
    cache?.metadataFile,
    path.join(artifact, 'info.json'),
    path.join(artifact, 'cache-record.json'),
    cache?.coverFile,
    task.coverFile
  ].filter(Boolean).map((item) => safeInside(artifact, item)).filter(Boolean));
  const deleted = [];
  const preserved = [];
  for (const item of fs.readdirSync(artifact, { withFileTypes: true })) {
    const target = path.join(artifact, item.name);
    if (shouldPreserve(target, keep)) {
      preserved.push(target);
      continue;
    }
    removePath(target);
    deleted.push(target);
  }
  return { mode: 'preserve-cache-source', deleted, preserved: [...keep] };
}

function safeInside(root, value) {
  try {
    const target = path.resolve(path.isAbsolute(String(value)) ? String(value) : path.join(root, String(value)));
    return assertInside(root, target);
  } catch {
    return '';
  }
}

function shouldPreserve(target, keep) {
  const resolved = path.resolve(target);
  for (const item of keep) {
    const relative = path.relative(resolved, item);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return true;
  }
  return false;
}

function removePath(target) {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}

module.exports = { abortTaskAttempt, cleanupAttemptFiles, createWorkId };
