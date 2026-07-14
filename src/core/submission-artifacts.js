const fs = require('fs');
const path = require('path');
const { fitArtifactName, videoArtifactDir, videoArtifactName } = require('./workspace');

const FINALIZATION_SCOPE = 'submissionFinalizations';

function prepareSubmissionArtifacts({ task, collection, validation, filenameMetadata }) {
  const currentDir = path.resolve(validation.artifactDir);
  const root = path.resolve(task.allowedRoot || path.dirname(currentDir));
  const baseName = fitArtifactName(root, videoArtifactName(task, collection, filenameMetadata));
  let finalDir = path.join(root, baseName);
  if (!samePath(currentDir, finalDir) && fs.existsSync(finalDir)) {
    finalDir = videoArtifactDir(root, task, collection, filenameMetadata);
  }
  return {
    currentDir,
    finalDir,
    markdownRelative: path.relative(currentDir, validation.markdownFile),
    metadataRelative: path.relative(currentDir, validation.metadataFile),
    finalMarkdownName: `${path.basename(finalDir)}.md`
  };
}

function applySubmissionArtifactPlan(plan) {
  const currentDir = path.resolve(plan.currentDir);
  const finalDir = path.resolve(plan.finalDir);
  if (!samePath(currentDir, finalDir)) {
    if (fs.existsSync(currentDir) && fs.existsSync(finalDir)) {
      // A copy fallback may have been interrupted. The still-present source is authoritative.
      fs.rmSync(finalDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    }
    if (fs.existsSync(currentDir)) moveDirectory(currentDir, finalDir);
    else if (!fs.existsSync(finalDir)) throw new Error('Submission artifact directory disappeared before finalization could finish.');
  } else if (!fs.existsSync(finalDir)) {
    throw new Error('Submission artifact directory disappeared before finalization could finish.');
  }

  const sourceMarkdown = path.join(finalDir, plan.markdownRelative);
  const finalMarkdown = path.join(finalDir, plan.finalMarkdownName);
  if (!samePath(sourceMarkdown, finalMarkdown)) {
    if (fs.existsSync(sourceMarkdown)) {
      if (fs.existsSync(finalMarkdown)) fs.rmSync(finalMarkdown, { force: true });
      fs.renameSync(sourceMarkdown, finalMarkdown);
    } else if (!fs.existsSync(finalMarkdown)) {
      throw new Error('Submission Markdown disappeared before finalization could finish.');
    }
  } else if (!fs.existsSync(finalMarkdown)) {
    throw new Error('Submission Markdown disappeared before finalization could finish.');
  }
  const metadataFile = path.join(finalDir, plan.metadataRelative);
  if (!fs.existsSync(metadataFile)) throw new Error('Submission metadata disappeared before finalization could finish.');
  return { artifactDir: finalDir, markdownFile: finalMarkdown, metadataFile };
}

function finalizeSubmissionArtifacts({ task, collection, validation, filenameMetadata }) {
  return applySubmissionArtifactPlan(prepareSubmissionArtifacts({ task, collection, validation, filenameMetadata }));
}

function stageSubmissionFinalization({ store, task, collection, validation, filenameMetadata, completedTask, event }) {
  const plan = prepareSubmissionArtifacts({ task, collection, validation, filenameMetadata });
  const id = `submission:${task.id}`;
  const record = {
    id,
    taskId: task.id,
    workId: task.workId || '',
    plan,
    completedTask: { ...completedTask },
    event: event ? { ...event } : null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  store.set(FINALIZATION_SCOPE, id, record);
  store.commit();
  return record;
}

function applySubmissionFinalization(store, record) {
  const finalized = applySubmissionArtifactPlan(record.plan);
  const task = {
    ...record.completedTask,
    id: record.taskId,
    artifactDir: finalized.artifactDir,
    outputMarkdown: finalized.markdownFile,
    metadataFile: finalized.metadataFile
  };
  task.coverFile = relocateManagedPath(record.plan.currentDir, finalized.artifactDir, task.coverFile);
  task.cachedVideoFile = relocateManagedPath(record.plan.currentDir, finalized.artifactDir, task.cachedVideoFile);
  relocateCachedVideo(store, task, finalized);
  store.set('tasks', task.id, task);
  if (record.event?.id && !store.get('taskEvents', record.event.id)) store.set('taskEvents', record.event.id, record.event);
  store.delete(FINALIZATION_SCOPE, record.id);
  store.commit();
  return { finalized, task };
}

function recoverPendingSubmissionFinalizations(store) {
  const results = [];
  for (const record of store.list(FINALIZATION_SCOPE)) {
    try {
      const recovered = applySubmissionFinalization(store, record);
      results.push({ id: record.id, taskId: record.taskId, ok: true, ...recovered });
    } catch (error) {
      store.set(FINALIZATION_SCOPE, record.id, {
        ...record,
        attempts: Number(record.attempts || 0) + 1,
        lastError: error.message || String(error),
        updatedAt: new Date().toISOString()
      });
      store.commit();
      results.push({ id: record.id, taskId: record.taskId, ok: false, error: error.message || String(error) });
    }
  }
  return results;
}

function moveDirectory(source, destination) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      fs.renameSync(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120 * (attempt + 1));
    }
  }
  try {
    fs.cpSync(source, destination, { recursive: true, errorOnExist: true });
    fs.rmSync(source, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  } catch (fallbackError) {
    fallbackError.cause = lastError;
    throw fallbackError;
  }
}

function relocateCachedVideo(store, task, finalized) {
  if (!task.cachedVideoId) return;
  const record = store.getVideoCache(task.cachedVideoId);
  if (!record) return;
  const videoName = record.videoFile ? path.basename(record.videoFile) : 'merged.mp4';
  task.cachedVideoFile = path.join(finalized.artifactDir, videoName);
  const coverFile = relocateManagedPath(record.artifactDir, finalized.artifactDir, record.coverFile || task.coverFile);
  task.coverFile = task.coverFile || coverFile;
  const updated = store.upsertVideoCache({
    ...record,
    artifactDir: finalized.artifactDir,
    videoFile: task.cachedVideoFile,
    coverFile,
    metadataFile: finalized.metadataFile,
    updatedAt: new Date().toISOString()
  });
  fs.writeFileSync(path.join(finalized.artifactDir, 'cache-record.json'), `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
}

function relocateManagedPath(oldRoot, newRoot, value) {
  if (!oldRoot || !newRoot || !value) return String(value || '');
  const sourceRoot = path.resolve(oldRoot);
  const source = path.resolve(value);
  const relative = path.relative(sourceRoot, source);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return String(value);
  return path.join(path.resolve(newRoot), relative);
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

module.exports = {
  applySubmissionArtifactPlan,
  applySubmissionFinalization,
  finalizeSubmissionArtifacts,
  prepareSubmissionArtifacts,
  recoverPendingSubmissionFinalizations,
  relocateCachedVideo,
  samePath,
  stageSubmissionFinalization
};
