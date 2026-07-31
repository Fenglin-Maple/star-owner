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

function projectRuntimeEnvironment(environment = process.env, projectRoot = PROJECT_ROOT) {
  const source = environment || {};
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (!BLOCKED_RUNTIME_ENV_KEYS.has(String(key).toLowerCase())) env[key] = value;
  }

  const root = path.resolve(projectRoot);
  const venv = path.join(root, 'runtime', 'faster-whisper');
  const pythonRoot = path.join(root, 'runtime', 'python');
  const ffmpegBinaries = path.join(venv, process.platform === 'win32' ? 'Lib' : 'lib/python3', 'site-packages', 'imageio_ffmpeg', 'binaries');
  const sitePackages = path.join(venv, process.platform === 'win32' ? 'Lib' : 'lib/python3', 'site-packages');
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

module.exports = { nodeChildProcessSpec, projectRuntimeEnvironment, readUtf8, resolveSystemExecutable, utf8ChildEnvironment };
