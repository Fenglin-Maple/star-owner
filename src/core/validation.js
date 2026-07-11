const fs = require('fs');
const path = require('path');
const { assertInside } = require('./workspace');

const REQUIRED_SECTIONS = ['小结', '目录', '思维导图', '字幕', '处理记录'];
const MAX_MARKDOWN_BYTES = 16 * 1024 * 1024;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;

function validateSubmission(task, submission) {
  const errors = [];
  if (!task) errors.push('Task does not exist.');
  if (!submission.markdownFile) errors.push('markdownFile is required.');
  if (!submission.artifactDir) errors.push('artifactDir is required.');
  if (errors.length) return { ok: false, errors };

  let artifactDir;
  let markdownFile;
  try {
    artifactDir = assertInside(task.allowedRoot, submission.artifactDir);
    markdownFile = assertInside(artifactDir, submission.markdownFile);
  } catch (error) {
    errors.push(error.message);
    return { ok: false, errors };
  }

  validateRegularFile(markdownFile, artifactDir, 'Markdown', MAX_MARKDOWN_BYTES, errors);
  let metadataFile = submission.metadataFile || path.join(artifactDir, 'info.json');
  try {
    metadataFile = assertInside(artifactDir, metadataFile);
    validateRegularFile(metadataFile, artifactDir, 'Metadata', MAX_METADATA_BYTES, errors);
  } catch (error) {
    errors.push(error.message);
  }

  if (!errors.some((error) => error.startsWith('Markdown ')) && fs.existsSync(markdownFile)) {
    const markdown = fs.readFileSync(markdownFile, 'utf8');
    for (const section of REQUIRED_SECTIONS) {
      if (!markdown.includes(section)) errors.push(`Markdown is missing section keyword: ${section}`);
    }
    if (!/评论分析/.test(markdown)) errors.push('Markdown is missing 评论分析 section.');
    if (!/字幕.{0,40}(比对|选择|ASR|语音转文字)/s.test(markdown)) {
      errors.push('Markdown is missing subtitle comparison/selection notes.');
    }
    const summaryIndex = markdown.search(/^##\s+小结\s*$/m);
    const mindMapIndex = markdown.search(/^##\s+思维导图\s*$/m);
    const contentsIndex = markdown.search(/^##\s+目录\s*$/m);
    if (!(summaryIndex >= 0 && mindMapIndex > summaryIndex && contentsIndex > mindMapIndex)) {
      errors.push('Markdown section order must begin with 小结 -> 思维导图 -> 目录.');
    }
    const mindMapEnd = mindMapIndex >= 0 ? markdown.slice(mindMapIndex + 1).search(/^##\s+/m) : -1;
    const mindMapSection = mindMapIndex >= 0
      ? markdown.slice(mindMapIndex, mindMapEnd >= 0 ? mindMapIndex + 1 + mindMapEnd : markdown.length)
      : '';
    if (!/```mermaid\s+[\s\S]*?```/i.test(mindMapSection)) errors.push('思维导图 section must contain a Mermaid fenced code block.');
    const imageRefs = [...markdown.matchAll(/!\[[^\]]*]\(([^)]+)\)/g)].map((match) => match[1]);
    for (const ref of imageRefs) {
      if (/^https?:\/\//i.test(ref)) continue;
      const imagePath = path.resolve(path.dirname(markdownFile), ref);
      try {
        assertInside(artifactDir, imagePath);
        if (!fs.existsSync(imagePath)) errors.push(`Referenced image does not exist: ${ref}`);
      } catch (error) {
        errors.push(error.message);
      }
    }
  }

  return { ok: errors.length === 0, errors, artifactDir, markdownFile, metadataFile };
}

function validateRegularFile(file, root, label, maxBytes, errors) {
  if (!fs.existsSync(file)) {
    errors.push(`${label} file does not exist: ${file}`);
    return;
  }
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    errors.push(`${label} path must be a regular file inside the artifact directory.`);
    return;
  }
  const realRoot = fs.realpathSync(root);
  const realFile = fs.realpathSync(file);
  try { assertInside(realRoot, realFile); }
  catch (error) { errors.push(error.message); return; }
  if (stat.size > maxBytes) errors.push(`${label} file exceeds ${Math.floor(maxBytes / 1024 / 1024)} MiB.`);
}

module.exports = { MAX_MARKDOWN_BYTES, MAX_METADATA_BYTES, validateSubmission };
