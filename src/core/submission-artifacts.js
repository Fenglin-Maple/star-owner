const fs = require('fs');
const path = require('path');
const { fitArtifactName, videoArtifactDir, videoArtifactName } = require('./workspace');

function finalizeSubmissionArtifacts({ task, collection, validation, filenameMetadata }) {
  const currentDir = path.resolve(validation.artifactDir);
  const root = path.resolve(task.allowedRoot || path.dirname(currentDir));
  const baseName = fitArtifactName(root, videoArtifactName(task, collection, filenameMetadata));
  let finalDir = path.join(root, baseName);
  if (!samePath(currentDir, finalDir) && fs.existsSync(finalDir)) {
    finalDir = videoArtifactDir(root, task, collection, filenameMetadata);
  }

  const markdownRelative = path.relative(currentDir, validation.markdownFile);
  const metadataRelative = path.relative(currentDir, validation.metadataFile);
  if (!samePath(currentDir, finalDir)) moveDirectory(currentDir, finalDir);

  const sourceMarkdown = path.join(finalDir, markdownRelative);
  const finalMarkdown = path.join(finalDir, `${path.basename(finalDir)}.md`);
  if (!samePath(sourceMarkdown, finalMarkdown)) {
    if (fs.existsSync(finalMarkdown)) fs.rmSync(finalMarkdown, { force: true });
    fs.renameSync(sourceMarkdown, finalMarkdown);
  }
  return {
    artifactDir: finalDir,
    markdownFile: finalMarkdown,
    metadataFile: path.join(finalDir, metadataRelative)
  };
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
  const updated = store.upsertVideoCache({
    ...record,
    artifactDir: finalized.artifactDir,
    videoFile: task.cachedVideoFile,
    metadataFile: finalized.metadataFile,
    updatedAt: new Date().toISOString()
  });
  fs.writeFileSync(path.join(finalized.artifactDir, 'cache-record.json'), `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

module.exports = { finalizeSubmissionArtifacts, relocateCachedVideo, samePath };
