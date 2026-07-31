const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { projectRuntimeEnvironment } = require('./child-process-io');
const { assertSafeWindowsPath, ensureDir, safeName } = require('./workspace');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const IMAGEIO_BINARIES = path.join(PROJECT_ROOT, 'runtime', 'faster-whisper', 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries');
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v', '.flv', '.wmv', '.ts', '.mts', '.m2ts']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma']);
const SUBTITLE_FORMATS = new Set(['srt', 'vtt', 'lrc', 'txt', 'json']);

function localFfmpeg() {
  if (!fs.existsSync(IMAGEIO_BINARIES)) return '';
  const name = fs.readdirSync(IMAGEIO_BINARIES).find((item) => process.platform === 'win32' ? /^ffmpeg-.*\.exe$/i.test(item) : /^ffmpeg-/i.test(item));
  return name ? path.join(IMAGEIO_BINARIES, name) : '';
}

function requireLocalFfmpeg() {
  const executable = localFfmpeg();
  if (!executable || !fs.existsSync(executable)) {
    const error = new Error('项目自带 FFmpeg 不可用，请在设置中检查或修复 runtime-base 依赖包。');
    error.code = 'LOCAL_FFMPEG_MISSING';
    throw error;
  }
  return executable;
}

function mediaKind(file) {
  const extension = path.extname(String(file || '')).toLowerCase();
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  return '';
}

async function inspectMedia(file, options = {}) {
  const source = path.resolve(String(file || ''));
  const kind = mediaKind(source);
  if (!kind) throw unsupportedMediaError(source, '文件扩展名不在可读取列表中');
  const stat = fs.statSync(source);
  if (!stat.isFile()) throw unsupportedMediaError(source, '所选路径不是普通文件');
  const result = await runFfmpeg(['-hide_banner', '-i', source], {
    signal: options.signal,
    timeoutMs: 30000,
    acceptedExitCodes: [0, 1]
  });
  const output = result.stderr;
  const durationMatch = output.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/i);
  const duration = durationMatch
    ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
    : 0;
  const hasVideo = /Stream\s+#\S+.*Video:/i.test(output);
  const hasAudio = /Stream\s+#\S+.*Audio:/i.test(output);
  const dimensions = output.match(/Video:[^\r\n]*?\b(\d{2,5})x(\d{2,5})\b/i);
  if (!hasVideo && !hasAudio) throw unsupportedMediaError(source, 'FFmpeg 未检测到可解码的音视频流');
  if (kind === 'video' && !hasVideo) throw unsupportedMediaError(source, '文件中没有可读取的视频流');
  if (!duration || !Number.isFinite(duration)) throw unsupportedMediaError(source, '无法读取媒体时长');
  const width = hasVideo ? Number(dimensions?.[1] || 0) : 0;
  const height = hasVideo ? Number(dimensions?.[2] || 0) : 0;
  return {
    path: source,
    name: path.basename(source),
    title: path.basename(source, path.extname(source)),
    extension: path.extname(source).toLowerCase(),
    kind,
    size: stat.size,
    duration,
    hasVideo,
    hasAudio,
    width,
    height,
    orientation: width && height ? (height > width ? 'portrait' : 'landscape') : '',
    modifiedAt: stat.mtime.toISOString()
  };
}

async function extractAudio(source, target, options = {}) {
  ensureDir(path.dirname(target));
  await runFfmpeg([
    '-y', '-hide_banner', '-loglevel', 'error', '-i', source,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    '-progress', 'pipe:1', '-nostats', target
  ], { ...options, duration: options.duration });
  if (!fs.existsSync(target) || fs.statSync(target).size <= 44) throw new Error('FFmpeg 没有生成可用的 ASR 音频。');
  return target;
}

async function compressMedia(source, target, metadata, options = {}) {
  if (metadata?.kind === 'audio' || metadata?.hasVideo === false) return compressAudio(source, target, metadata, options);
  return compressVideo(source, target, metadata, options);
}

async function compressAudio(source, target, metadata, options = {}) {
  const duration = Math.max(1, Number(metadata.duration || 0));
  const budgetBlocks = Math.max(1, Math.ceil(duration / 600));
  const budgetBytes = budgetBlocks * 50 * 1024 * 1024;
  const budgetKbps = Math.max(32, Math.floor((budgetBytes * 8 * 0.9) / duration / 1000));
  const sourceKbps = Math.max(32, Math.floor((Number(metadata.size || budgetBytes) * 8) / duration / 1000));
  const audioKbps = Math.max(32, Math.min(256, sourceKbps, budgetKbps));
  const output = assertSafeWindowsPath(path.resolve(target), '本地音频缓存路径');
  ensureDir(path.dirname(output));
  try {
    await runFfmpeg([
      '-y', '-hide_banner', '-loglevel', 'error', '-i', source,
      '-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', `${audioKbps}k`,
      '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', output
    ], {
      signal: options.signal,
      duration,
      timeoutMs: options.timeoutMs,
      onProgress: options.onProgress
    });
    if (!fs.existsSync(output) || fs.statSync(output).size <= 0) throw new Error('FFmpeg 未生成可用的压缩音频。');
    const outputSize = fs.statSync(output).size;
    if (outputSize > budgetBytes) {
      const error = new Error(`压缩音频仍超过大小额度：${formatBytes(outputSize)} / ${formatBytes(budgetBytes)}。`);
      error.code = 'LOCAL_AUDIO_BUDGET_EXCEEDED';
      throw error;
    }
    return { file: output, size: outputSize, budgetBytes, audioKbps };
  } catch (error) {
    if (fs.existsSync(output)) fs.rmSync(output, { force: true });
    throw error;
  }
}

async function compressVideo(source, target, metadata, options = {}) {
  const duration = Math.max(1, Number(metadata.duration || 0));
  const budgetBlocks = Math.max(1, Math.ceil(duration / 600));
  const budgetBytes = budgetBlocks * 50 * 1024 * 1024;
  const hasAudio = metadata.hasAudio !== false;
  const audioKbps = hasAudio ? 64 : 0;
  const budgetKbps = Math.floor((budgetBytes * 8 * 0.9) / duration / 1000);
  const sourceKbps = Math.max(180, Math.floor((Number(metadata.size || budgetBytes) * 8) / duration / 1000));
  const videoKbps = Math.max(120, Math.min(sourceKbps - audioKbps, budgetKbps - audioKbps));
  const maxRateKbps = Math.max(videoKbps, Math.floor(videoKbps * 1.08));
  const bufferKbps = Math.max(240, videoKbps * 2);
  const output = assertSafeWindowsPath(path.resolve(target), '本地视频缓存路径');
  const directory = ensureDir(path.dirname(output));
  const passLog = path.join(directory, safeName(`ffmpeg-pass-${options.jobId || Date.now()}`, 'ffmpeg-pass', 80));
  const common = [
    '-y', '-hide_banner', '-loglevel', 'error', '-i', source,
    '-map', '0:v:0', '-vf', "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${videoKbps}k`,
    '-maxrate', `${maxRateKbps}k`, '-bufsize', `${bufferKbps}k`, '-pix_fmt', 'yuv420p'
  ];
  try {
    await runFfmpeg([
      ...common, '-an', '-pass', '1', '-passlogfile', passLog,
      '-progress', 'pipe:1', '-nostats', '-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null'
    ], {
      signal: options.signal,
      duration,
      timeoutMs: options.timeoutMs,
      onProgress: (value) => options.onProgress?.(value * 0.46)
    });
    const audioArgs = hasAudio
      ? ['-map', '0:a:0?', '-c:a', 'aac', '-b:a', `${audioKbps}k`, '-ac', '2']
      : ['-an'];
    await runFfmpeg([
      ...common, ...audioArgs, '-pass', '2', '-passlogfile', passLog,
      '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', output
    ], {
      signal: options.signal,
      duration,
      timeoutMs: options.timeoutMs,
      onProgress: (value) => options.onProgress?.(0.46 + value * 0.54)
    });
    if (!fs.existsSync(output) || fs.statSync(output).size <= 0) throw new Error('FFmpeg 没有生成可用的压缩视频。');
    const outputSize = fs.statSync(output).size;
    if (outputSize > budgetBytes) {
      const error = new Error(`压缩视频仍超过大小额度：${formatBytes(outputSize)} / ${formatBytes(budgetBytes)}。`);
      error.code = 'LOCAL_VIDEO_BUDGET_EXCEEDED';
      throw error;
    }
    return { file: output, size: outputSize, budgetBytes, videoKbps, audioKbps };
  } catch (error) {
    if (fs.existsSync(output)) fs.rmSync(output, { force: true });
    throw error;
  } finally {
    for (const suffix of ['-0.log', '-0.log.mbtree', '.log', '.log.mbtree']) {
      const candidate = `${passLog}${suffix}`;
      if (fs.existsSync(candidate)) fs.rmSync(candidate, { force: true });
    }
  }
}

async function extractCover(source, target, options = {}) {
  ensureDir(path.dirname(target));
  const seek = Math.min(3, Math.max(0, Number(options.duration || 0) * 0.08));
  try {
    await runFfmpeg([
      '-y', '-hide_banner', '-loglevel', 'error', '-ss', seek.toFixed(3), '-i', source,
      '-frames:v', '1', '-vf', 'scale=640:640:force_original_aspect_ratio=decrease', target
    ], { signal: options.signal, timeoutMs: 60000 });
    return fs.existsSync(target) && fs.statSync(target).size > 0 ? target : '';
  } catch (error) {
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
    if (options.signal?.aborted || error?.code === 'LOCAL_TOOL_CANCELLED') throw error;
    return '';
  }
}

function writeSubtitleFormats(asrResultFile, destinationDirectory, sourceName, formats) {
  const payload = JSON.parse(fs.readFileSync(asrResultFile, 'utf8'));
  const segments = Array.isArray(payload.segments) ? payload.segments : [];
  const selected = [...new Set((formats || []).map((item) => String(item).toLowerCase()))].filter((item) => SUBTITLE_FORMATS.has(item));
  if (!selected.length) throw new Error('请至少选择一种字幕输出格式。');
  const stem = safeName(path.basename(sourceName, path.extname(sourceName)), 'subtitle', 100);
  const transactionId = `${process.pid}-${Date.now()}`;
  const staged = [];
  try {
    for (const format of selected) {
      const target = assertSafeWindowsPath(path.join(destinationDirectory, `${stem}.asr.${format}`), '字幕输出路径');
      const temporary = `${target}.tmp-${transactionId}`;
      const backup = `${target}.previous-${transactionId}`;
      let content = '';
      if (format === 'srt') content = renderSrt(segments);
      else if (format === 'vtt') content = renderVtt(segments);
      else if (format === 'lrc') content = renderLrc(segments);
      else if (format === 'txt') content = `${segments.map((item) => String(item.text || '').trim()).filter(Boolean).join('\n')}\n`;
      else content = `${JSON.stringify(payload, null, 2)}\n`;
      fs.writeFileSync(temporary, content, 'utf8');
      staged.push({ target, temporary, backup, installed: false, hadPrevious: fs.existsSync(target) });
    }
    for (const item of staged) {
      if (item.hadPrevious) fs.renameSync(item.target, item.backup);
      fs.renameSync(item.temporary, item.target);
      item.installed = true;
    }
    for (const item of staged) if (item.hadPrevious && fs.existsSync(item.backup)) {
      try { fs.rmSync(item.backup, { force: true }); } catch {}
    }
    return staged.map((item) => item.target);
  } catch (error) {
    for (const item of staged.reverse()) {
      if (item.installed && fs.existsSync(item.target)) fs.rmSync(item.target, { force: true });
      if (item.hadPrevious && fs.existsSync(item.backup)) fs.renameSync(item.backup, item.target);
      if (fs.existsSync(item.temporary)) fs.rmSync(item.temporary, { force: true });
    }
    throw error;
  }
}

function renderSrt(segments) {
  return `${segments.map((item, index) => `${index + 1}\n${subtitleTimestamp(item.start, ',')} --> ${subtitleTimestamp(item.end, ',')}\n${String(item.text || '').trim()}\n`).join('\n')}\n`;
}

function renderVtt(segments) {
  return `WEBVTT\n\n${segments.map((item) => `${subtitleTimestamp(item.start, '.')} --> ${subtitleTimestamp(item.end, '.')}\n${String(item.text || '').trim()}\n`).join('\n')}\n`;
}

function renderLrc(segments) {
  return `${segments.map((item) => `[${lrcTimestamp(item.start)}]${String(item.text || '').trim()}`).join('\n')}\n`;
}

function subtitleTimestamp(value, separator) {
  const totalMs = Math.max(0, Math.round(Number(value || 0) * 1000));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const milliseconds = totalMs % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${separator}${String(milliseconds).padStart(3, '0')}`;
}

function lrcTimestamp(value) {
  const totalCentiseconds = Math.max(0, Math.round(Number(value || 0) * 100));
  const minutes = Math.floor(totalCentiseconds / 6000);
  const seconds = Math.floor((totalCentiseconds % 6000) / 100);
  const centiseconds = totalCentiseconds % 100;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
}

function runFfmpeg(args, options = {}) {
  const executable = requireLocalFfmpeg();
  const accepted = new Set(options.acceptedExitCodes || [0]);
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const child = spawn(executable, args, {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      env: projectRuntimeEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener?.('abort', cancel);
      error ? reject(error) : resolve(value);
    };
    const cancel = () => {
      try { child.kill('SIGTERM'); } catch {}
    };
    if (options.signal?.aborted) cancel();
    options.signal?.addEventListener?.('abort', cancel, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-64000);
      const duration = Number(options.duration || 0);
      const match = String(chunk).match(/out_time_(?:ms|us)=(\d+)/g)?.at(-1)?.match(/=(\d+)/);
      if (duration > 0 && match) options.onProgress?.(Math.min(1, Number(match[1]) / 1000000 / duration));
      if (/progress=end/.test(String(chunk))) options.onProgress?.(1);
    });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-128000); });
    child.on('error', (error) => finish(error));
    child.on('close', (code, signal) => {
      if (options.signal?.aborted) return finish(cancelledError());
      if (timedOut) return finish(timeoutError());
      const normalizedCode = signedWindowsExitCode(code);
      if (!accepted.has(Number(code)) && !accepted.has(normalizedCode)) {
        const detail = stderr.trim().split(/\r?\n/).slice(-24).join('\n').slice(-5000);
        const error = new Error(`FFmpeg 执行失败，退出码 ${normalizedCode}${signal ? ` (${signal})` : ''}${detail ? `\n${detail}` : ''}`);
        error.code = 'LOCAL_FFMPEG_FAILED';
        error.exitCode = normalizedCode;
        return finish(error);
      }
      finish(null, { code: normalizedCode, signal: signal || '', stdout, stderr });
    });
    const timeoutMs = Math.max(1000, Number(options.timeoutMs || 12 * 60 * 60 * 1000));
    const timer = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
    timer.unref?.();
  });
}

function cancelledError() {
  const error = new Error('本地工具任务已取消。');
  error.code = 'LOCAL_TOOL_CANCELLED';
  return error;
}

function timeoutError() {
  const error = new Error('本地媒体处理超时。');
  error.code = 'LOCAL_TOOL_TIMEOUT';
  return error;
}

function unsupportedMediaError(file, reason) {
  const error = new Error(`无法读取 ${path.basename(file)}：${reason}。`);
  error.code = 'UNSUPPORTED_LOCAL_MEDIA';
  return error;
}

function signedWindowsExitCode(value) {
  const number = Number(value);
  return process.platform === 'win32' && number > 0x7fffffff ? number - 0x100000000 : number;
}

function formatBytes(value) {
  return `${(Number(value || 0) / 1024 / 1024).toFixed(1)} MiB`;
}

module.exports = {
  AUDIO_EXTENSIONS,
  SUBTITLE_FORMATS,
  VIDEO_EXTENSIONS,
  compressAudio,
  compressMedia,
  compressVideo,
  extractAudio,
  extractCover,
  inspectMedia,
  localFfmpeg,
  mediaKind,
  requireLocalFfmpeg,
  runFfmpeg,
  writeSubtitleFormats
};
