const fs = require('fs');
const path = require('path');
const { assertInside } = require('./workspace');

const REQUIRED_SECTIONS = ['小结', '目录', '思维导图', '字幕', '处理记录'];
const MAX_MARKDOWN_BYTES = 16 * 1024 * 1024;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACT_ENTRIES = 20000;
const MAX_ARTIFACT_DEPTH = 32;
const TEMPORARY_MEDIA_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.m4a', '.mp3', '.wav', '.aac', '.flac', '.part', '.ytdl']);

function validateSubmission(task, submission, options = {}) {
  const errors = [];
  if (!task) errors.push('Task does not exist.');
  if (!submission.markdownFile) errors.push('markdownFile is required.');
  if (!submission.artifactDir) errors.push('artifactDir is required.');
  if (errors.length) return { ok: false, errors };

  let artifactDir;
  let markdownFile;
  try {
    artifactDir = assertInside(task.allowedRoot, submission.artifactDir);
    const assignedArtifactDir = task.artifactDir ? path.resolve(String(task.artifactDir)) : '';
    if (!assignedArtifactDir || !samePath(artifactDir, assignedArtifactDir)) {
      errors.push('artifactDir must exactly match the directory assigned by this work attempt.');
      return { ok: false, errors };
    }
    markdownFile = assertInside(artifactDir, submission.markdownFile);
  } catch (error) {
    errors.push(error.message);
    return { ok: false, errors };
  }

  validateArtifactBoundary(task.allowedRoot, artifactDir, errors);
  validateArtifactTree(artifactDir, errors);

  validateRegularFile(markdownFile, artifactDir, 'Markdown', MAX_MARKDOWN_BYTES, errors);
  let metadataFile = submission.metadataFile || path.join(artifactDir, 'info.json');
  try {
    metadataFile = assertInside(artifactDir, metadataFile);
    validateRegularFile(metadataFile, artifactDir, 'Metadata', MAX_METADATA_BYTES, errors);
  } catch (error) {
    errors.push(error.message);
  }
  validateAsrTimeline(artifactDir, errors);
  if (options.requireMediaCleanup !== false) validateTemporaryMediaCleanup(task, artifactDir, errors);

  if (!errors.some((error) => error.startsWith('Markdown ')) && fs.existsSync(markdownFile)) {
    const markdown = fs.readFileSync(markdownFile, 'utf8');
    for (const section of REQUIRED_SECTIONS) {
      if (!markdown.includes(section)) errors.push(`Markdown is missing section keyword: ${section}`);
    }
    if (!/评论分析/.test(markdown)) errors.push('Markdown is missing 评论分析 section.');
    if (!/字幕.{0,40}(比对|选择|ASR|语音转文字)/s.test(markdown)) {
      errors.push('Markdown is missing subtitle comparison/selection notes.');
    }
    const timelineLinks = [...markdown.matchAll(/https?:\/\/(?:www\.)?bilibili\.com\/video\/[^\s)]+[?&]t=\d+(?:\.\d+)?/ig)].map((match) => match[0]);
    const expectedBvid = String(task.bvid || '').toLowerCase();
    if (!timelineLinks.length || (expectedBvid && !timelineLinks.some((link) => link.toLowerCase().includes(`/video/${expectedBvid}`)))) {
      errors.push('Markdown must include at least one timeline link for the current Bilibili video with a real ?t=<seconds> value.');
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
    for (const rawRef of imageRefs) {
      const ref = normalizeMarkdownImageReference(rawRef);
      if (/^https?:\/\//i.test(ref)) {
        try {
          const remote = new URL(ref);
          if (remote.protocol !== 'https:' || !isTrustedBilibiliImageHost(remote.hostname) || remote.username || remote.password) {
            errors.push(`Referenced remote image is not a trusted Bilibili asset: ${ref}`);
          }
        } catch {
          errors.push(`Referenced remote image URL is invalid: ${ref}`);
        }
        continue;
      }
      let decodedRef = ref;
      try { decodedRef = decodeURIComponent(ref); }
      catch { errors.push(`Referenced image path is not valid URI encoding: ${ref}`); continue; }
      const imagePath = path.resolve(path.dirname(markdownFile), decodedRef);
      try {
        assertInside(artifactDir, imagePath);
        validateRegularFile(imagePath, artifactDir, `Referenced image (${ref})`, MAX_IMAGE_BYTES, errors);
        validateImageSignature(imagePath, errors);
      } catch (error) {
        errors.push(error.message);
      }
    }
  }

  return { ok: errors.length === 0, errors, artifactDir, markdownFile, metadataFile };
}

function normalizeMarkdownImageReference(value) {
  const ref = String(value || '').trim();
  if (ref.startsWith('<') && ref.endsWith('>')) return ref.slice(1, -1).trim();
  return ref;
}

function validateImageSignature(file, errors) {
  if (!isRegularFile(file)) return;
  const extension = path.extname(file).toLowerCase();
  const buffer = fs.readFileSync(file);
  const valid = extension === '.png'
    ? buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : ['.jpg', '.jpeg'].includes(extension)
      ? buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9
      : extension === '.gif'
        ? buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))
        : extension === '.webp'
          ? buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
          : extension === '.avif'
            ? buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp' && buffer.subarray(8, 12).toString('ascii').includes('avif')
            : false;
  if (!valid) errors.push(`Referenced image content does not match a supported raster image format: ${file}`);
}

function isTrustedBilibiliImageHost(value) {
  const host = String(value || '').toLowerCase().replace(/\.$/, '');
  return ['hdslb.com', 'biliimg.com', 'bilibili.com'].some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function validateAsrTimeline(artifactDir, errors) {
  const directory = path.join(artifactDir, 'asr');
  const srtFile = path.join(directory, 'transcript.srt');
  const textFile = path.join(directory, 'asr-transcript.txt');
  const jsonFile = path.join(directory, 'asr-result.json');
  for (const [file, label] of [[srtFile, 'ASR SRT'], [textFile, 'ASR timestamped text'], [jsonFile, 'ASR segment JSON']]) {
    validateRegularFile(file, artifactDir, label, MAX_METADATA_BYTES, errors);
  }
  if (![srtFile, textFile, jsonFile].every(isRegularFile)) return;

  let payload;
  try { payload = JSON.parse(fs.readFileSync(jsonFile, 'utf8')); }
  catch (error) { errors.push(`ASR segment JSON is invalid: ${error.message}`); return; }
  if (!Array.isArray(payload.segments)) {
    errors.push('ASR segment JSON must contain a segments array.');
    return;
  }
  const invalid = payload.segments.find((segment, index, segments) => !Number.isFinite(Number(segment.start))
    || !Number.isFinite(Number(segment.end))
    || Number(segment.start) < 0
    || Number(segment.end) < Number(segment.start)
    || (index > 0 && Number(segment.start) < Number(segments[index - 1].start))
    || !String(segment.text || '').trim());
  if (invalid) errors.push('Every ASR sentence segment must contain text and finite start/end timestamps.');

  const srt = fs.readFileSync(srtFile, 'utf8');
  const timedText = fs.readFileSync(textFile, 'utf8');
  const srtTimeline = parseTimelines(srt, false);
  const textTimeline = parseTimelines(timedText, true);
  if (payload.segments.length !== srtTimeline.length || payload.segments.length !== textTimeline.length) {
    errors.push('ASR SRT, timestamped text, and segment JSON must expose the same number of sentence timestamps.');
    return;
  }
  const mismatched = payload.segments.some((segment, index) => !sameTimestamp(Number(segment.start), srtTimeline[index].start)
    || !sameTimestamp(Number(segment.end), srtTimeline[index].end)
    || !sameTimestamp(Number(segment.start), textTimeline[index].start)
    || !sameTimestamp(Number(segment.end), textTimeline[index].end));
  if (mismatched) {
    errors.push('ASR SRT, timestamped text, and segment JSON must contain matching sentence start/end timestamps.');
  }
}

function validateRegularFile(file, root, label, maxBytes, errors) {
  try {
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
  } catch (error) {
    errors.push(`${label} file could not be inspected: ${error.message || String(error)}`);
  }
}

function validateArtifactBoundary(allowedRoot, artifactDir, errors) {
  try {
    const artifactStat = fs.lstatSync(artifactDir);
    if (!artifactStat.isDirectory() || artifactStat.isSymbolicLink()) {
      errors.push('Artifact directory must be a real directory, not a file or symbolic link.');
      return;
    }
    const realAllowedRoot = fs.realpathSync(path.resolve(allowedRoot));
    const realArtifactDir = fs.realpathSync(path.resolve(artifactDir));
    assertInside(realAllowedRoot, realArtifactDir);
  } catch (error) {
    errors.push(`Artifact directory boundary check failed: ${error.message || String(error)}`);
  }
}

function validateArtifactTree(artifactDir, errors) {
  const state = { entries: 0 };
  try {
    for (const _file of walkFiles(artifactDir, 0, state)) {
      // Walking is the validation: links, excessive depth, and excessive entries throw.
    }
  } catch (error) {
    errors.push(`Artifact directory structure is invalid: ${error.message || String(error)}`);
  }
}

function validateTemporaryMediaCleanup(task, artifactDir, errors) {
  const allowed = new Set();
  if (task.cachedVideoId || task.keepVideoCache) {
    for (const candidate of [task.cachedVideoFile, path.join(artifactDir, 'merged.mp4'), path.join(artifactDir, 'merged.mkv'), path.join(artifactDir, 'merged.webm')]) {
      if (candidate) allowed.add(normalizePath(candidate));
    }
  }
  const leftovers = [];
  try {
    for (const file of walkFiles(artifactDir)) {
      if (!TEMPORARY_MEDIA_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
      if (!allowed.has(normalizePath(file))) leftovers.push(path.relative(artifactDir, file));
    }
  } catch (error) {
    errors.push(`Artifact directory could not be inspected for temporary media: ${error.message || String(error)}`);
    return;
  }
  if (leftovers.length) {
    errors.push(`Temporary media cache must be cleaned before submission: ${leftovers.slice(0, 8).join(', ')}${leftovers.length > 8 ? ` (+${leftovers.length - 8} more)` : ''}`);
  }
}

function* walkFiles(root, depth = 0, state = { entries: 0 }) {
  if (depth > MAX_ARTIFACT_DEPTH) throw new Error(`directory depth exceeds ${MAX_ARTIFACT_DEPTH}`);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    state.entries += 1;
    if (state.entries > MAX_ARTIFACT_ENTRIES) throw new Error(`entry count exceeds ${MAX_ARTIFACT_ENTRIES}`);
    const target = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symbolic links are not allowed: ${path.relative(root, target) || entry.name}`);
    if (entry.isDirectory()) yield* walkFiles(target, depth + 1, state);
    else if (entry.isFile()) yield target;
  }
}

function normalizePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isRegularFile(file) {
  try { return fs.existsSync(file) && fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(); }
  catch { return false; }
}

function parseTimelines(value, bracketed) {
  const edge = bracketed ? '\\[' : '';
  const tail = bracketed ? '\\]' : '';
  const pattern = new RegExp(`${edge}(\\d{2}:\\d{2}:\\d{2},\\d{3})\\s+-->\\s+(\\d{2}:\\d{2}:\\d{2},\\d{3})${tail}`, 'g');
  return [...String(value || '').matchAll(pattern)].map((match) => ({ start: parseSrtTime(match[1]), end: parseSrtTime(match[2]) }));
}

function parseSrtTime(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
  if (!match) return Number.NaN;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

function sameTimestamp(left, right) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 0.002;
}

module.exports = { MAX_IMAGE_BYTES, MAX_MARKDOWN_BYTES, MAX_METADATA_BYTES, validateSubmission };
