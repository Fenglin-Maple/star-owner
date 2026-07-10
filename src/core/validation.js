const fs = require('fs');
const path = require('path');
const { assertInside } = require('./workspace');

const REQUIRED_SECTIONS = ['小结', '目录', '思维导图', '字幕', '处理记录'];

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

  if (!fs.existsSync(markdownFile)) errors.push(`Markdown file does not exist: ${markdownFile}`);
  const metadataFile = submission.metadataFile || path.join(artifactDir, 'info.json');
  try {
    assertInside(artifactDir, metadataFile);
    if (!fs.existsSync(metadataFile)) errors.push(`Metadata file does not exist: ${metadataFile}`);
  } catch (error) {
    errors.push(error.message);
  }

  if (fs.existsSync(markdownFile)) {
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

module.exports = { validateSubmission };
