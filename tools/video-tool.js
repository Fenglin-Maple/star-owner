#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const WHISPER_PYTHON = path.join(PROJECT_ROOT, 'runtime', 'faster-whisper', 'Scripts', 'python.exe');
const WHISPER_CLI = path.join(PROJECT_ROOT, 'tools', 'faster-whisper-cli.py');
const LOCAL_BINARIES = {
  ffmpeg: optionalModulePath('ffmpeg-static'),
  'yt-dlp': path.join(path.dirname(require.resolve('yt-dlp-exec/package.json')), 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'),
  'faster-whisper': process.env.FASTER_WHISPER_BIN || WHISPER_PYTHON
};

const MEDIA_CACHE_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.m4a', '.mp3', '.wav', '.aac', '.flac', '.part', '.ytdl']);

if (require.main === module) {
  main().catch((error) => {
    console.error(`[video-tool] ${error.message || String(error)}`);
    process.exit(1);
  });
}

async function main() {
  const [command, target, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help' || command === '-h') return printHelp();
  if (command === 'health') return printHealth(target);
  if (command === 'clean-cache') return cleanCache(target);
  if (!target) throw new Error('缺少视频链接或 BV 号。运行 node tools/video-tool.js help 查看用法。');

  const args = parseArgs(rest);
  const outDir = path.resolve(args.out || '.');
  fs.mkdirSync(outDir, { recursive: true });
  const videoUrl = normalizeVideoUrl(target);

  if (command === 'info') return writeInfo(videoUrl, outDir, args);
  if (command === 'subtitles') return writeSubtitles(videoUrl, outDir, args);
  if (command === 'comments') return writeComments(videoUrl, outDir, args);
  if (command === 'merged') return downloadMerged(videoUrl, outDir, args);
  if (command === 'audio') return prepareAudio(videoUrl, outDir, args);
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
  console.log(`Bili Agent Orchestrator video-tool

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
      const subtitleUrl = String(entry.subtitle_url || '').startsWith('//') ? `https:${entry.subtitle_url}` : entry.subtitle_url;
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
  const height = Number(args.height || 720);
  const output = path.join(outDir, 'merged.%(ext)s');
  const format = `bv*[height<=${height}]+ba/b[height<=${height}]/best`;
  const cliArgs = ['-f', format, '--merge-output-format', 'mp4', '-o', output];
  const ffmpeg = resolveCommand('ffmpeg');
  if (ffmpeg) cliArgs.push('--ffmpeg-location', ffmpeg);
  if (args.cookies) cliArgs.push('--cookies', path.resolve(args.cookies));
  cliArgs.push(videoUrl);
  run('yt-dlp', cliArgs);
  const merged = findFirst(outDir, /^merged\.(mp4|mkv|webm)$/i);
  if (!merged) throw new Error('yt-dlp 已结束，但未找到 merged.mp4/mkv/webm。');
  console.log(merged);
}

async function runAsr(videoUrl, outDir, args) {
  requireCommand('faster-whisper');
  const audioFile = await prepareAudio(videoUrl, outDir, args);
  const asrDir = path.join(outDir, 'asr');
  fs.mkdirSync(asrDir, { recursive: true });
  run('faster-whisper', [audioFile, '--model', 'large-v3-turbo', '--language', 'zh', '--output_dir', asrDir, '--output_format', 'all']);
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
  run('ffmpeg', ['-y', '-i', merged, '-vn', '-ac', '1', '-ar', '16000', audioFile]);
  console.log(audioFile);
  return audioFile;
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
      manifest.warnings.push(`audio failed: ${error.message || String(error)}`);
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
  fs.mkdirSync(framesDir, { recursive: true });
  run('ffmpeg', ['-y', '-i', merged, '-vf', 'fps=1/30', '-frames:v', String(count), path.join(framesDir, 'frame-%03d.jpg')]);
}

function cleanCache(target) {
  if (!target) throw new Error('缺少视频工作目录。');
  const root = path.resolve(target);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`目录不存在：${root}`);
  const removed = [];
  for (const file of walk(root)) {
    if (MEDIA_CACHE_EXTENSIONS.has(path.extname(file).toLowerCase())) {
      fs.rmSync(file, { force: true });
      removed.push(file);
    }
  }
  console.log(JSON.stringify({ root, removed }, null, 2));
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
    duration: data.duration,
    pages: data.pages || [],
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
  const headers = {
    referer: 'https://www.bilibili.com/',
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  };
  const cookie = args.cookies ? readNetscapeCookies(path.resolve(args.cookies)) : '';
  if (cookie) headers.cookie = cookie;
  const response = await fetch(url, { headers });
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
  if (/^https?:\/\//i.test(target)) return target;
  const bvid = extractBvid(target);
  return `https://www.bilibili.com/video/${bvid}`;
}

function extractBvid(value) {
  const match = String(value).match(/BV[a-zA-Z0-9]+/);
  if (!match) throw new Error(`无法从输入中解析 BV 号：${value}`);
  return match[0];
}

function readNetscapeCookies(file) {
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('\t'))
    .filter((parts) => parts.length >= 7 && parts[0].includes('bilibili.com'))
    .map((parts) => `${parts[5]}=${parts[6]}`)
    .join('; ');
}

function requireCommand(command) {
  if (!commandAvailable(command)) throw new Error(`未找到 ${command}，请先安装并加入 PATH。`);
}

function commandAvailable(command) {
  return Boolean(resolveCommand(command));
}

function dependencyStatus(command) {
  const executable = resolveCommand(command);
  if (!executable) return { command, available: false, source: '' };
  if (command !== 'faster-whisper' || executable !== WHISPER_PYTHON || !fs.existsSync(WHISPER_CLI)) {
    return { command, available: true, source: executable };
  }
  const probe = spawnSync(executable, [WHISPER_CLI, '--health', '--model', 'small'], {
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
      message: payload.ok ? 'faster-whisper 与模型可用' : (payload.error || 'small 模型尚未就绪')
    };
  } catch (error) {
    return { command, available: false, source: executable, message: String(probe.stderr || '').trim() || error.message };
  }
}

function resolveCommand(command) {
  const local = LOCAL_BINARIES[command];
  if (local && fs.existsSync(local)) return local;
  const probe = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { encoding: 'utf8', windowsHide: true });
  if (probe.status !== 0) return '';
  return String(probe.stdout || '').split(/\r?\n/).map((item) => item.trim()).find(Boolean) || command;
}

function run(command, args) {
  const executable = resolveCommand(command);
  if (!executable) throw new Error(`未找到 ${command}，请先安装并加入 PATH。`);
  const finalArgs = command === 'faster-whisper' && executable === WHISPER_PYTHON && fs.existsSync(WHISPER_CLI)
    ? [WHISPER_CLI, ...args]
    : args;
  const result = spawnSync(executable, finalArgs, { stdio: 'inherit', shell: false, windowsHide: true });
  if (result.status !== 0) throw new Error(`${command} 执行失败，退出码 ${result.status}`);
}

function optionalModulePath(moduleName) {
  try {
    return require(moduleName);
  } catch {
    return '';
  }
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

module.exports = { assessSubtitle };
