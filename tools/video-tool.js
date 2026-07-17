#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { repairPortablePythonHome } = require('../src/core/portable-runtime');

const PROJECT_ROOT = path.resolve(__dirname, '..');
try {
  repairPortablePythonHome(PROJECT_ROOT);
} catch (error) {
  console.warn(`[video-tool] portable Python repair failed: ${error.message || String(error)}`);
}
const WHISPER_PYTHON = path.join(PROJECT_ROOT, 'runtime', 'faster-whisper', 'Scripts', 'python.exe');
const WHISPER_CLI = path.join(PROJECT_ROOT, 'tools', 'faster-whisper-cli.py');
const IMAGEIO_BINARIES = path.join(PROJECT_ROOT, 'runtime', 'faster-whisper', 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries');
const LOCAL_BINARIES = {
  ffmpeg: findFirst(IMAGEIO_BINARIES, process.platform === 'win32' ? /^ffmpeg-.*\.exe$/i : /^ffmpeg-/i),
  'yt-dlp': WHISPER_PYTHON,
  'faster-whisper': process.env.FASTER_WHISPER_BIN || WHISPER_PYTHON
};

const MEDIA_CACHE_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.m4a', '.mp3', '.wav', '.aac', '.flac', '.part', '.ytdl']);

if (require.main === module) {
  main().catch((error) => {
    console.error(`[video-tool] ${error.message || String(error)}`);
    process.exitCode = 1;
  });
}

async function main() {
  const [command, target, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help' || command === '-h') return printHelp();
  if (command === 'health') return printHealth(target);
  if (command === 'clean-cache') return cleanCache(target, parseArgs(rest));
  if (!target) throw new Error('缺少视频链接或 BV 号。运行 node tools/video-tool.js help 查看用法。');

  const args = parseArgs(rest);
  const outDir = path.resolve(args.out || '.');
  fs.mkdirSync(outDir, { recursive: true });
  const videoUrl = normalizeVideoUrl(target);

  if (command === 'info') return writeInfo(videoUrl, outDir, args);
  if (command === 'subtitles') return writeSubtitles(videoUrl, outDir, args);
  if (command === 'comments') return writeComments(videoUrl, outDir, args);
  if (command === 'merged') return downloadMerged(videoUrl, outDir, args);
  if (command === 'audio') {
    try { return await prepareAudio(videoUrl, outDir, args); }
    catch (error) {
      if (!isNoAudioStreamError(error)) throw error;
      const status = writeNoAudioStatus(outDir);
      console.log(path.join(outDir, 'audio', 'status.json'));
      return status;
    }
  }
  if (command === 'asr') return runAsr(videoUrl, outDir, args);
  if (command === 'bundle') return buildBundle(videoUrl, outDir, args);
  throw new Error(`未知命令：${command}`);
}

function printHealth(action) {
  const requirements = {
    info: [],
    subtitles: [],
    comments: [],
    merged: ['yt-dlp', 'ffmpeg'],
    audio: ['yt-dlp', 'ffmpeg'],
    asr: ['faster-whisper', 'ffmpeg', 'yt-dlp'],
    bundle: ['yt-dlp', 'ffmpeg', 'faster-whisper'],
    'clean-cache': []
  };
  if (!Object.prototype.hasOwnProperty.call(requirements, action)) throw new Error(`未知健康检查模块：${action || '-'}`);
  const dependencies = requirements[action].map(dependencyStatus);
  const missing = dependencies.filter((item) => !item.available).map((item) => item.command);
  console.log(JSON.stringify({
    ok: missing.length === 0,
    service: 'video-tool',
    action,
    node: process.version,
    response: 'pong',
    dependencies,
    missing,
    checkedAt: new Date().toISOString()
  }));
}

function printHelp() {
  console.log(`星藏家 video-tool

用法:
  node tools/video-tool.js info <视频链接或BV号> --out <目录> [--cookies <cookie.txt>]
  node tools/video-tool.js subtitles <视频链接或BV号> --out <目录> [--cookies <cookie.txt>]
  node tools/video-tool.js comments <视频链接或BV号> --out <目录> [--cookies <cookie.txt>] [--comment-limit 3]
  node tools/video-tool.js merged <视频链接或BV号> --out <目录> [--cookies <cookie.txt>] [--height 720]
  node tools/video-tool.js audio <视频链接或BV号> --out <目录> [--cookies <cookie.txt>] [--height 720]
  node tools/video-tool.js asr <视频链接或BV号> --out <目录> [--cookies <cookie.txt>]
  node tools/video-tool.js bundle <视频链接或BV号> --out <目录> [--cookies <cookie.txt>] [--frames 12] [--audio] [--asr] [--comments]
  node tools/video-tool.js clean-cache <视频工作目录>

说明:
  info/comments 可直接调用 Bilibili Web API。
  merged 需要本机可执行 yt-dlp 和 ffmpeg。
  asr 需要本机可执行 faster-whisper，并会优先复用 merged.mp4。
`);
}

async function writeInfo(videoUrl, outDir, args) {
  const info = await getVideoInfo(videoUrl, args);
  try {
    const coverFile = await downloadCover(info.pic, outDir, args);
    if (coverFile) info.coverFile = path.basename(coverFile);
  } catch (error) {
    info.coverDownloadError = String(error.message || error).slice(0, 500);
  }
  const file = path.join(outDir, 'info.json');
  fs.writeFileSync(file, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
  console.log(file);
}

async function writeComments(videoUrl, outDir, args) {
  const info = await getVideoInfo(videoUrl, args);
  const commentsDir = path.join(outDir, 'comments');
  fs.mkdirSync(commentsDir, { recursive: true });
  const limit = Number(args['comment-limit'] || 3);
  const comments = await getTopComments(info.aid, limit, args).catch((error) => ({
    unavailable: true,
    reason: error.message || String(error),
    items: []
  }));
  const file = path.join(commentsDir, 'comments.json');
  fs.writeFileSync(file, `${JSON.stringify({ bvid: info.bvid, aid: info.aid, limit, ...comments }, null, 2)}\n`, 'utf8');
  console.log(file);
}

async function writeSubtitles(videoUrl, outDir, args) {
  const info = await getVideoInfo(videoUrl, args);
  const subtitlesDir = path.join(outDir, 'subtitles');
  fs.rmSync(subtitlesDir, { recursive: true, force: true });
  fs.mkdirSync(subtitlesDir, { recursive: true });
  const index = { bvid: info.bvid, fetchedAt: new Date().toISOString(), available: false, count: 0, rejectedCount: 0, pages: [] };
  for (const page of info.pages || []) {
    const player = await fetchJson(`https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(info.bvid)}&cid=${encodeURIComponent(page.cid)}`, args);
    const entries = player.data?.subtitle?.subtitles || [];
    const pageRecord = { page: page.page, cid: page.cid, title: page.part || '', subtitles: [] };
    for (const entry of entries) {
      const language = safeFilePart(entry.lan || entry.lan_doc || `subtitle-${entry.id}`);
      const stem = `p${String(page.page || 1).padStart(2, '0')}-${language}`;
      const subtitleUrl = assertBilibiliResourceUrl(String(entry.subtitle_url || '').startsWith('//') ? `https:${entry.subtitle_url}` : entry.subtitle_url).toString();
      const payload = await fetchPlainJson(subtitleUrl, args);
      const body = Array.isArray(payload.body) ? payload.body : [];
      const videoDuration = Number(page.duration || ((info.pages || []).length === 1 ? info.duration : 0)) || null;
      const assessment = assessSubtitle(body, videoDuration);
      const jsonFile = path.join(subtitlesDir, `${stem}.json`);
      const srtFile = path.join(subtitlesDir, `${stem}.srt`);
      const textFile = path.join(subtitlesDir, `${stem}.txt`);
      fs.writeFileSync(jsonFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

      const baseRecord = {
        id: String(entry.id),
        language: entry.lan,
        languageName: entry.lan_doc,
        type: entry.type,
        aiType: entry.ai_type,
        url: subtitleUrl,
        json: path.basename(jsonFile),
        lines: body.length,
        subtitleDuration: assessment.subtitleDuration,
        videoDuration
      };
      if (!assessment.valid) {
        const { valid, subtitleDuration, ...diagnostics } = assessment;
        pageRecord.subtitles.push({
          ...baseRecord,
          valid: false,
          ...diagnostics
        });
        index.rejectedCount += 1;
        continue;
      }

      writeSubtitleSrt(srtFile, body);
      fs.writeFileSync(textFile, `${body.map((item) => String(item.content || '').trim()).filter(Boolean).join('\n')}\n`, 'utf8');
      pageRecord.subtitles.push({
        ...baseRecord,
        valid: true,
        srt: path.basename(srtFile),
        text: path.basename(textFile)
      });
      index.count += 1;
    }
    index.pages.push(pageRecord);
  }
  index.available = index.count > 0;
  const file = path.join(subtitlesDir, 'index.json');
  fs.writeFileSync(file, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  console.log(file);
}

async function downloadMerged(videoUrl, outDir, args) {
  requireCommand('yt-dlp');
  requireCommand('ffmpeg');
  const existing = findFirst(outDir, /^merged\.(mp4|mkv|webm)$/i);
  if (existing && fs.statSync(existing).size > 0) {
    console.log(`[video-tool] reuse cached merged video: ${existing}`);
    console.log(existing);
    return existing;
  }
  const height = Number(args.height || 720);
  const output = path.join(outDir, 'merged.%(ext)s');
  const format = `bv*[height<=${height}]+ba/b[height<=${height}]/best`;
  const cliArgs = [
    '-f', format,
    '--merge-output-format', 'mp4',
    '--newline',
    '--progress-template', 'download:%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
    '-o', output
  ];
  const ffmpeg = resolveCommand('ffmpeg');
  if (ffmpeg) cliArgs.push('--ffmpeg-location', ffmpeg);
  if (args.cookies) cliArgs.push('--cookies', path.resolve(args.cookies));
  cliArgs.push(videoUrl);
  run('yt-dlp', cliArgs);
  const merged = findFirst(outDir, /^merged\.(mp4|mkv|webm)$/i);
  if (!merged) throw new Error('yt-dlp 已结束，但未找到 merged.mp4/mkv/webm。');
  console.log(merged);
  return merged;
}

async function runAsr(videoUrl, outDir, args) {
  requireCommand('faster-whisper');
  const audioFile = await prepareAudio(videoUrl, outDir, args);
  const asrDir = path.join(outDir, 'asr');
  fs.mkdirSync(asrDir, { recursive: true });
  run('faster-whisper', [audioFile, '--model', String(args.model || 'medium'), '--language', String(args.language || 'auto'), '--output_dir', asrDir, '--output_format', 'all']);
  console.log(asrDir);
}

async function prepareAudio(videoUrl, outDir, args) {
  requireCommand('ffmpeg');
  let merged = findFirst(outDir, /^merged\.(mp4|mkv|webm)$/i);
  if (!merged) {
    await downloadMerged(videoUrl, outDir, args);
    merged = findFirst(outDir, /^merged\.(mp4|mkv|webm)$/i);
  }
  const audioDir = path.join(outDir, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const audioFile = path.join(audioDir, 'audio.wav');
  run('ffmpeg', ['-y', '-i', merged, '-vn', '-ac', '1', '-ar', '16000', audioFile], { capture: true });
  console.log(audioFile);
  return audioFile;
}

function writeNoAudioStatus(outDir) {
  const audioDir = path.join(outDir, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const status = {
    available: false,
    reason: 'NO_AUDIO_STREAM',
    message: '源视频不包含音频流，无法执行语音识别；后续总结应使用站内字幕与关键帧。',
    detectedAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(audioDir, 'status.json'), `${JSON.stringify(status, null, 2)}\n`, 'utf8');
  return status;
}

async function buildBundle(videoUrl, outDir, args) {
  const manifest = {
    videoUrl,
    createdAt: new Date().toISOString(),
    outputs: {},
    warnings: []
  };

  if (!args['skip-info']) {
    try {
      await writeInfo(videoUrl, outDir, args);
      manifest.outputs.info = 'info.json';
    } catch (error) {
      manifest.warnings.push(`info failed: ${error.message || String(error)}`);
    }
  }

  if (!args['skip-comments'] && args.comments !== false) {
    try {
      await writeComments(videoUrl, outDir, args);
      manifest.outputs.comments = 'comments/comments.json';
    } catch (error) {
      manifest.warnings.push(`comments failed: ${error.message || String(error)}`);
    }
  }

  try {
    await downloadMerged(videoUrl, outDir, args);
    manifest.outputs.merged = path.basename(findFirst(outDir, /^merged\.(mp4|mkv|webm)$/i) || 'merged.mp4');
  } catch (error) {
    manifest.warnings.push(`merged failed: ${error.message || String(error)}`);
  }

  if (!args['skip-subtitles']) {
    try {
      await writeSubtitles(videoUrl, outDir, args);
      manifest.outputs.subtitles = 'subtitles/';
    } catch (error) {
      manifest.warnings.push(`subtitles failed: ${error.message || String(error)}`);
    }
  }

  if (args.audio) {
    try {
      await prepareAudio(videoUrl, outDir, args);
      manifest.outputs.audio = 'audio/audio.wav';
    } catch (error) {
      if (isNoAudioStreamError(error)) {
        manifest.audio = writeNoAudioStatus(outDir);
        manifest.outputs.audioStatus = 'audio/status.json';
      } else {
        manifest.warnings.push(`audio failed: ${error.message || String(error)}`);
      }
    }
  }

  try {
    extractFrames(outDir, Number(args.frames || 12));
    manifest.outputs.frames = 'frames/';
  } catch (error) {
    manifest.warnings.push(`frames failed: ${error.message || String(error)}`);
  }

  if (args.asr) {
    try {
      await runAsr(videoUrl, outDir, args);
      manifest.outputs.asr = 'asr/';
      manifest.outputs.asrSrt = 'asr/transcript.srt';
      manifest.outputs.asrTimedText = 'asr/asr-transcript.txt';
      manifest.outputs.asrSegments = 'asr/asr-result.json';
      manifest.outputs.asrHasTimestamps = true;
    } catch (error) {
      manifest.warnings.push(`asr failed: ${error.message || String(error)}`);
    }
  }

  const file = path.join(outDir, 'manifest.json');
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(file);
}

function extractFrames(outDir, count) {
  requireCommand('ffmpeg');
  const merged = findFirst(outDir, /^merged\.(mp4|mkv|webm)$/i);
  if (!merged) throw new Error('未找到合轨视频，无法抽帧。');
  const framesDir = path.join(outDir, 'frames');
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });
  let info = {};
  try { info = JSON.parse(fs.readFileSync(path.join(outDir, 'info.json'), 'utf8')); } catch {}
  const wanted = Math.max(1, Math.min(60, Math.round(Number(count) || 12)));
  const duration = Math.max(0, Number(info.duration || 0));
  const interval = duration > 0 ? Math.max(0.5, duration / (wanted + 1)) : 30;
  const executable = resolveCommand('ffmpeg');
  const result = spawnSync(executable, [
    '-hide_banner', '-loglevel', 'error', '-i', merged,
    '-vf', `fps=1/${interval.toFixed(3)}`,
    '-frames:v', String(wanted),
    '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'
  ], {
    encoding: null,
    maxBuffer: 256 * 1024 * 1024,
    shell: false,
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const exitCode = signedWindowsExitCode(result.status);
    const detail = processFailureDetail(result.stderr?.toString('utf8'), '');
    throw new Error(`ffmpeg 抽帧失败，退出码 ${exitCode}${detail ? `\n${detail}` : ''}`);
  }
  const frames = splitJpegStream(Buffer.from(result.stdout || []), wanted);
  if (!frames.length) throw new Error('ffmpeg 抽帧结束，但没有返回可用的 JPEG 图片。');
  frames.forEach((buffer, index) => {
    fs.writeFileSync(path.join(framesDir, `frame-${String(index + 1).padStart(3, '0')}.jpg`), buffer);
  });
  return frames.map((_buffer, index) => `frames/frame-${String(index + 1).padStart(3, '0')}.jpg`);
}

function splitJpegStream(value, maximum = 60) {
  const buffer = Buffer.from(value || []);
  const frames = [];
  let offset = 0;
  while (offset < buffer.length && frames.length < maximum) {
    const start = buffer.indexOf(Buffer.from([0xff, 0xd8]), offset);
    if (start < 0) break;
    const end = buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
    if (end < 0) break;
    frames.push(buffer.subarray(start, end + 2));
    offset = end + 2;
  }
  return frames;
}

function cleanCache(target, args = {}) {
  if (!target) throw new Error('缺少视频工作目录。');
  const root = path.resolve(target);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`目录不存在：${root}`);
  const removed = [];
  const preserved = [];
  const preserveVideo = Boolean(args['preserve-video']);
  for (const file of walk(root)) {
    if (MEDIA_CACHE_EXTENSIONS.has(path.extname(file).toLowerCase())) {
      if (preserveVideo && path.dirname(file) === root && /^merged\.(mp4|mkv|webm)$/i.test(path.basename(file))) {
        preserved.push(file);
        continue;
      }
      fs.rmSync(file, { force: true });
      removed.push(file);
    }
  }
  console.log(JSON.stringify({ root, preserveVideo, preserved, removed }, null, 2));
}

async function getVideoInfo(videoUrl, args) {
  const bvid = extractBvid(videoUrl);
  const apiUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
  const json = await fetchJson(apiUrl, args);
  const data = json.data || {};
  return {
    bvid: data.bvid || bvid,
    aid: data.aid,
    title: data.title,
    owner: data.owner,
    pubdate: data.pubdate,
    ctime: data.ctime,
    desc: data.desc,
    pic: data.pic,
    duration: data.duration,
    dimension: data.dimension || null,
    pages: data.pages || [],
    redirectUrl: data.redirect_url || '',
    rights: data.rights || {},
    stat: data.stat || {},
    tags: await getTags(data.bvid || bvid, args).catch(() => []),
    url: videoUrl,
    fetchedAt: new Date().toISOString()
  };
}

async function getTags(bvid, args) {
  const json = await fetchJson(`https://api.bilibili.com/x/tag/archive/tags?bvid=${encodeURIComponent(bvid)}`, args);
  return (json.data || []).map((item) => item.tag_name).filter(Boolean);
}

async function getTopComments(aid, limit, args) {
  if (!aid) throw new Error('缺少 aid，无法读取评论。');
  const url = `https://api.bilibili.com/x/v2/reply/main?type=1&oid=${encodeURIComponent(aid)}&mode=3&ps=${encodeURIComponent(limit)}`;
  const json = await fetchJson(url, args);
  const replies = json.data?.replies || [];
  return {
    items: replies.slice(0, limit).map((item) => ({
      rpid: item.rpid,
      like: item.like,
      member: item.member?.uname,
      message: item.content?.message,
      ctime: item.ctime
    }))
  };
}

async function fetchJson(url, args) {
  const json = await fetchPlainJson(url, args);
  if (json.code !== 0) throw new Error(`Bilibili API ${json.code}: ${json.message || json.msg || 'unknown'}`);
  return json;
}

async function fetchPlainJson(url, args) {
  if (!url) throw new Error('Missing JSON resource URL.');
  const response = await fetch(url, { headers: requestHeaders(args, 'application/json, text/plain, */*', url), signal: AbortSignal.timeout(30000) });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Bilibili returned non-JSON: ${text.slice(0, 180)}`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 180)}`);
  return json;
}

function requestHeaders(args, accept = 'application/json, text/plain, */*', requestUrl = 'https://api.bilibili.com') {
  const headers = {
    referer: 'https://www.bilibili.com/',
    accept,
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  };
  let host = '';
  try { host = new URL(requestUrl).hostname.toLowerCase().replace(/\.$/, ''); } catch {}
  const cookie = host === 'bilibili.com' || host.endsWith('.bilibili.com')
    ? (args.cookies ? readNetscapeCookies(path.resolve(args.cookies)) : '')
    : '';
  if (cookie) headers.cookie = cookie;
  return headers;
}

async function downloadCover(source, outDir, args) {
  if (!source) return '';
  let url = assertBilibiliImageUrl(source);
  let response;
  for (let redirects = 0; redirects <= 4; redirects += 1) {
    response = await fetch(url.toString(), {
      headers: requestHeaders(args, 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8', url.toString()),
      redirect: 'manual',
      signal: AbortSignal.timeout(30000)
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    if (!location || redirects === 4) throw new Error('Bilibili cover redirected too many times.');
    url = assertBilibiliImageUrl(new URL(location, url).toString());
  }
  if (!response?.ok) throw new Error(`Bilibili cover HTTP ${response?.status || 0}.`);
  const declaredLength = Number(response.headers.get('content-length') || 0);
  const maximumBytes = 12 * 1024 * 1024;
  if (declaredLength > maximumBytes) throw new Error('Bilibili cover exceeds 12 MiB.');
  const type = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type && !type.startsWith('image/')) throw new Error(`Unexpected Bilibili cover type: ${type}.`);
  const content = await readLimitedResponse(response, maximumBytes);
  if (!content.length || content.length > maximumBytes) throw new Error('Bilibili cover is empty or too large.');
  const detected = detectRasterImage(content);
  if (!detected) throw new Error('Bilibili cover bytes are not a supported raster image.');
  if (type && type !== detected.mimeType && !(type === 'image/jpg' && detected.mimeType === 'image/jpeg')) {
    throw new Error(`Bilibili cover bytes do not match the declared type ${type}.`);
  }
  const extension = detected.extension;
  const file = path.join(outDir, `cover${extension}`);
  fs.writeFileSync(file, content);
  return file;
}

function detectRasterImage(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: 'image/png', extension: '.png' };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9) {
    return { mimeType: 'image/jpeg', extension: '.jpg' };
  }
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) {
    return { mimeType: 'image/gif', extension: '.gif' };
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mimeType: 'image/webp', extension: '.webp' };
  }
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp' && /avi[fs]/.test(buffer.subarray(8, Math.min(buffer.length, 40)).toString('ascii'))) {
    return { mimeType: 'image/avif', extension: '.avif' };
  }
  return null;
}

function assertBilibiliImageUrl(value) {
  return assertBilibiliResourceUrl(value);
}

function assertBilibiliResourceUrl(value) {
  const source = String(value || '').trim();
  const normalized = source.startsWith('//') ? `https:${source}` : source.replace(/^http:\/\//i, 'https://');
  const url = new URL(normalized);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const allowed = ['hdslb.com', 'biliimg.com', 'bilibili.com'];
  if (url.protocol !== 'https:' || url.username || url.password || !allowed.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    throw new Error(`Unsupported Bilibili resource host: ${host || '-'}.`);
  }
  return url;
}

async function readLimitedResponse(response, maximumBytes) {
  if (!response.body?.getReader) {
    const content = Buffer.from(await response.arrayBuffer());
    if (!content.length || content.length > maximumBytes) throw new Error('Bilibili cover is empty or too large.');
    return content;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error('Bilibili cover is too large.');
    }
    chunks.push(Buffer.from(value));
  }
  if (!total) throw new Error('Bilibili cover is empty.');
  return Buffer.concat(chunks, total);
}

function writeSubtitleSrt(file, body) {
  const lines = [];
  body.forEach((item, index) => {
    lines.push(String(index + 1), `${srtTime(item.from)} --> ${srtTime(item.to)}`, String(item.content || '').trim(), '');
  });
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
}

function assessSubtitle(body, videoDuration) {
  const lines = Array.isArray(body) ? body : [];
  const duration = Number(videoDuration) || 0;
  const subtitleDuration = lines.reduce((maximum, item) => Math.max(maximum, Number(item.to) || Number(item.from) || 0), 0);
  if (!lines.length) return { valid: false, reason: 'SUBTITLE_EMPTY', subtitleDuration };

  const toleranceSeconds = Math.max(10, duration * 0.05);
  if (duration && subtitleDuration > duration + toleranceSeconds) {
    return { valid: false, reason: 'SUBTITLE_DURATION_MISMATCH', subtitleDuration, toleranceSeconds };
  }

  const minimumLines = 3;
  const minimumTimelineCoverage = duration ? Math.min(30, duration * 0.25) : 0;
  if (duration && (lines.length < minimumLines || subtitleDuration < minimumTimelineCoverage)) {
    return { valid: false, reason: 'SUBTITLE_COVERAGE_TOO_LOW', subtitleDuration, minimumLines, minimumTimelineCoverage };
  }
  return { valid: true, subtitleDuration };
}

function srtTime(value) {
  const totalMs = Math.max(0, Math.round(Number(value || 0) * 1000));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const milliseconds = totalMs % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
}

function safeFilePart(value) {
  return String(value || 'subtitle').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'subtitle';
}

function parseArgs(rest) {
  const args = {};
  for (let i = 0; i < rest.length; i += 1) {
    const item = rest[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function normalizeVideoUrl(target) {
  const bvid = extractBvid(target);
  return `https://www.bilibili.com/video/${bvid}`;
}

function extractBvid(value) {
  const match = String(value).match(/BV[a-zA-Z0-9]{10}/i);
  if (!match) throw new Error(`无法从输入中解析 BV 号：${value}`);
  return match[0];
}

function readNetscapeCookies(file) {
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('\t'))
    .filter((parts) => {
      const domain = String(parts[0] || '').toLowerCase().replace(/^\./, '');
      return parts.length >= 7 && (domain === 'bilibili.com' || domain.endsWith('.bilibili.com'));
    })
    .map((parts) => `${parts[5]}=${parts[6]}`)
    .join('; ');
}

function requireCommand(command) {
  if (!dependencyStatus(command).available) throw new Error(`未找到 ${command}，请先运行 npm run setup:asr。`);
}

function dependencyStatus(command) {
  const executable = resolveCommand(command);
  if (!executable) return { command, available: false, source: '' };
  if (command === 'yt-dlp' && executable === WHISPER_PYTHON) {
    const probe = spawnSync(executable, ['-m', 'yt_dlp', '--version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    return {
      command,
      available: probe.status === 0,
      source: `${executable} -m yt_dlp`,
      version: String(probe.stdout || '').trim(),
      message: probe.status === 0 ? '项目 Python 中的 yt-dlp 可用' : String(probe.stderr || '').trim()
    };
  }
  if (command !== 'faster-whisper' || executable !== WHISPER_PYTHON || !fs.existsSync(WHISPER_CLI)) {
    return { command, available: true, source: executable };
  }
  const probe = spawnSync(executable, [WHISPER_CLI, '--health', '--model', 'medium'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000
  });
  try {
    const payload = JSON.parse(String(probe.stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1) || '{}');
    return {
      command,
      available: Boolean(payload.ok),
      source: executable,
      version: payload.fasterWhisper || '',
      model: payload.model || '',
      modelReady: Boolean(payload.modelReady),
      cudaDevices: Number(payload.cudaDevices || 0),
      message: payload.ok ? 'faster-whisper 与默认 medium 模型可用' : (payload.error || 'medium 模型尚未就绪')
    };
  } catch (error) {
    return { command, available: false, source: executable, message: String(probe.stderr || '').trim() || error.message };
  }
}

function resolveCommand(command) {
  const local = LOCAL_BINARIES[command];
  if (local && fs.existsSync(local)) return local;
  return '';
}

function run(command, args, options = {}) {
  const executable = resolveCommand(command);
  if (!executable) throw new Error(`未找到 ${command}，请先安装并加入 PATH。`);
  let finalArgs = args;
  if (command === 'faster-whisper' && executable === WHISPER_PYTHON && fs.existsSync(WHISPER_CLI)) finalArgs = [WHISPER_CLI, ...args];
  if (command === 'yt-dlp' && executable === WHISPER_PYTHON) finalArgs = ['-m', 'yt_dlp', ...args];
  const capture = Boolean(options.capture);
  const result = spawnSync(executable, finalArgs, capture
    ? { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, shell: false, windowsHide: true }
    : { stdio: 'inherit', shell: false, windowsHide: true });
  if (capture) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const exitCode = signedWindowsExitCode(result.status);
    const detail = processFailureDetail(result.stderr, result.stdout);
    const suffix = Number(result.status) !== exitCode ? `（Windows 原始值 ${result.status}）` : '';
    const error = new Error(`${command} 执行失败，退出码 ${exitCode}${suffix}${detail ? `\n${detail}` : ''}`);
    error.exitCode = exitCode;
    error.rawExitCode = result.status;
    error.stderr = String(result.stderr || '');
    if (isNoAudioStreamError(error)) error.code = 'NO_AUDIO_STREAM';
    throw error;
  }
  return result;
}

function signedWindowsExitCode(value) {
  const number = Number(value);
  return process.platform === 'win32' && number > 0x7fffffff ? number - 0x100000000 : number;
}

function processFailureDetail(stderr, stdout) {
  const text = `${String(stdout || '')}\n${String(stderr || '')}`.trim();
  if (!text) return '';
  return text.split(/\r?\n/).filter(Boolean).slice(-24).join('\n').slice(-4000);
}

function isNoAudioStreamError(error) {
  const text = `${String(error?.code || '')}\n${String(error?.message || error || '')}\n${String(error?.stderr || '')}`;
  return /NO_AUDIO_STREAM|Output file does not contain any stream|matches no streams|does not contain an audio stream/i.test(text);
}

function findFirst(dir, pattern) {
  if (!fs.existsSync(dir)) return '';
  const name = fs.readdirSync(dir).find((item) => pattern.test(item));
  return name ? path.join(dir, name) : '';
}

function* walk(root) {
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, item.name);
    if (item.isDirectory()) yield* walk(file);
    else yield file;
  }
}

module.exports = { assessSubtitle, buildBundle, extractFrames, isNoAudioStreamError, normalizeVideoUrl, prepareAudio, resolveCommand, splitJpegStream, writeNoAudioStatus };
