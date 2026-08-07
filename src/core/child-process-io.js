const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const BLOCKED_RUNTIME_ENV_KEYS = new Set([
  'path',
  'pythonpath',
  'pythonhome',
  'pythonuserbase',
  'pythonstartup',
  'pythonexecutable',
  'pythonioencoding',
  'pythonutf8',
  'pythonunbuffered',
  'pythoninspector',
  'virtual_env',
  'conda_prefix',
  'conda_default_env',
  'conda_exe',
  'node_path',
  'node_options',
  'electron_run_as_node',
  'faster_whisper_bin',
  'npm_config_node_options',
  'npm_node_execpath',
  'npm_execpath'
]);

function utf8ChildEnvironment(environment = process.env) {
  return {
    ...environment,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8'
  };
}

function findVenvSitePackages(venv) {
  if (process.platform === 'win32') {
    const windowsSitePackages = path.join(venv, 'Lib', 'site-packages');
    return fs.existsSync(windowsSitePackages) ? windowsSitePackages : '';
  }
  const lib = path.join(venv, 'lib');
  if (!fs.existsSync(lib)) return '';
  for (const entry of fs.readdirSync(lib, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('python')) continue;
    const candidate = path.join(lib, entry.name, 'site-packages');
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

/**
 * 跨平台解析项目内置运行时二进制，统一收敛 FFmpeg / Python / site-packages 的解析逻辑：
 * - whisperPython: win32 -> runtime/faster-whisper/Scripts/python.exe；POSIX -> runtime/faster-whisper/bin/python（不存在返回 ''）
 * - imageioBinaries: win32 -> Lib/site-packages/imageio_ffmpeg/binaries；POSIX -> 扫描 lib 下 python* 子目录的 site-packages 中的 imageio_ffmpeg/binaries
 * - sitePackages: 复用 findVenvSitePackages（win32: Lib/site-packages；POSIX: lib 下 python* 子目录的 site-packages）
 * - venvRoot: runtime/faster-whisper
 */
function resolveRuntimeBinaries(projectRoot = PROJECT_ROOT) {
  const root = path.resolve(projectRoot);
  const venvRoot = path.join(root, 'runtime', 'faster-whisper');
  let whisperPython;
  let imageioBinaries = '';
  if (process.platform === 'win32') {
    whisperPython = path.join(venvRoot, 'Scripts', 'python.exe');
    imageioBinaries = path.join(venvRoot, 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries');
  } else {
    const posixPython = path.join(venvRoot, 'bin', 'python');
    whisperPython = fs.existsSync(posixPython) ? posixPython : '';
    const lib = path.join(venvRoot, 'lib');
    if (fs.existsSync(lib)) {
      for (const entry of fs.readdirSync(lib, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('python')) continue;
        const candidate = path.join(lib, entry.name, 'site-packages', 'imageio_ffmpeg', 'binaries');
        if (fs.existsSync(candidate)) {
          imageioBinaries = candidate;
          break;
        }
      }
    }
  }
  return {
    whisperPython,
    imageioBinaries,
    sitePackages: findVenvSitePackages(venvRoot),
    venvRoot
  };
}

function projectRuntimeEnvironment(environment = process.env, projectRoot = PROJECT_ROOT) {
  const source = environment || {};
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (!BLOCKED_RUNTIME_ENV_KEYS.has(String(key).toLowerCase())) env[key] = value;
  }

  const root = path.resolve(projectRoot);
  const { venvRoot: venv, sitePackages, imageioBinaries: ffmpegBinaries } = resolveRuntimeBinaries(root);
  const pythonRoot = path.join(root, 'runtime', 'python');
  const localPaths = [
    path.join(root, 'node_modules', '.bin'),
    path.join(root, 'runtime', 'vc-runtime'),
    path.join(venv, process.platform === 'win32' ? 'Scripts' : 'bin'),
    ffmpegBinaries,
    path.join(sitePackages, 'nvidia', 'cublas', 'bin'),
    path.join(sitePackages, 'nvidia', 'cudnn', 'bin'),
    path.join(sitePackages, 'nvidia', 'cuda_nvrtc', 'bin')
  ];
  if (fs.existsSync(pythonRoot)) {
    for (const entry of fs.readdirSync(pythonRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      localPaths.push(path.join(pythonRoot, entry.name));
    }
  }
  if (process.platform === 'win32') {
    const systemRoot = source.SystemRoot || source.WINDIR || '';
    if (systemRoot) {
      localPaths.push(
        path.join(systemRoot, 'System32'),
        path.join(systemRoot, 'System32', 'Wbem'),
        path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')
      );
    }
  }
  const uniquePaths = [];
  const seen = new Set();
  for (const candidate of localPaths) {
    if (!fs.existsSync(candidate)) continue;
    const normalized = path.resolve(candidate).toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    uniquePaths.push(candidate);
  }

  env.PATH = uniquePaths.join(path.delimiter);
  if (fs.existsSync(sitePackages)) env.PYTHONPATH = sitePackages;
  else delete env.PYTHONPATH;
  env.PYTHONNOUSERSITE = '1';
  env.PYTHONUTF8 = '1';
  env.PYTHONIOENCODING = 'utf-8';
  if (fs.existsSync(venv)) env.VIRTUAL_ENV = venv;
  else delete env.VIRTUAL_ENV;
  return env;
}

function resolveSystemExecutable(name, environment = process.env) {
  const executable = String(name || '');
  if (!executable) return '';
  const systemRoot = environment?.SystemRoot || environment?.WINDIR || '';
  const candidates = process.platform === 'win32'
    ? [
      systemRoot && path.join(systemRoot, 'System32', executable),
      systemRoot && path.join(systemRoot, 'Sysnative', executable),
      systemRoot && path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', executable),
      systemRoot && path.join(systemRoot, executable)
    ]
    : [`/usr/bin/${executable}`, `/bin/${executable}`, `/usr/local/bin/${executable}`];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || '';
}

function resolveNvidiaSmi(environment = process.env) {
  const source = environment || {};
  const systemRoot = source.SystemRoot || source.WINDIR || '';
  const programRoots = [source.ProgramW6432, source.ProgramFiles, source['ProgramFiles(x86)']].filter(Boolean);
  const candidates = process.platform === 'win32'
    ? [
      systemRoot && path.join(systemRoot, 'System32', 'nvidia-smi.exe'),
      systemRoot && path.join(systemRoot, 'Sysnative', 'nvidia-smi.exe'),
      ...programRoots.map((root) => path.join(root, 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'))
    ]
    : ['/usr/bin/nvidia-smi', '/bin/nvidia-smi', '/usr/local/bin/nvidia-smi'];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || '';
}

function readUtf8(stream, onData) {
  if (!stream) return stream;
  stream.setEncoding('utf8');
  stream.on('data', onData);
  return stream;
}

function nodeChildProcessSpec(environment = process.env) {
  const env = projectRuntimeEnvironment(environment);
  if (process.versions?.electron) env.ELECTRON_RUN_AS_NODE = '1';
  else delete env.ELECTRON_RUN_AS_NODE;
  return { executable: process.execPath, env };
}

module.exports = { findVenvSitePackages, nodeChildProcessSpec, projectRuntimeEnvironment, readUtf8, resolveNvidiaSmi, resolveRuntimeBinaries, resolveSystemExecutable, utf8ChildEnvironment };
