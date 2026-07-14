const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { findRuntimePython, serviceEnvironment } = require('./asr-service');
const { PROJECT_ROOT } = require('./workspace');

const execFileAsync = promisify(execFile);

async function detectAsrHardware({ gpu = {}, model = 'medium', projectRoot = PROJECT_ROOT } = {}) {
  const python = findRuntimePython(projectRoot);
  const script = path.join(projectRoot, 'tools', 'faster-whisper-cli.py');
  let health = {};
  let runtimeError = '';
  if (python && fs.existsSync(script)) {
    try {
      const result = await execFileAsync(python, [script, '--model', model, '--health'], {
        cwd: projectRoot,
        windowsHide: true,
        timeout: 30000,
        env: serviceEnvironment(projectRoot)
      });
      health = parseHealth(result.stdout);
    } catch (error) {
      health = parseHealth(error.stdout);
      runtimeError = health.error || error.message || String(error);
    }
  } else {
    runtimeError = !python ? 'Project-local Python runtime is missing.' : 'faster-whisper health script is missing.';
  }
  return evaluateAsrHardware({
    platform: process.platform,
    arch: process.arch,
    totalMemoryBytes: os.totalmem(),
    cpuThreads: os.cpus()?.length || 0,
    gpu,
    model,
    pythonAvailable: Boolean(python),
    runtimeHealth: health,
    runtimeError
  });
}

function evaluateAsrHardware(input = {}) {
  const totalMemoryMiB = Math.round(Number(input.totalMemoryBytes || 0) / 1024 / 1024);
  const selectedModel = ['small', 'medium'].includes(input.model) ? input.model : 'medium';
  const runtimeHealth = input.runtimeHealth || {};
  const runtimeReady = Boolean(input.pythonAvailable && runtimeHealth.ok && runtimeHealth.modelReady);
  const nvidiaDetected = Boolean(input.gpu?.available);
  const cudaDeviceCount = Number(runtimeHealth.cudaDevices || 0);
  const modelRequirements = {
    small: { gpuTotalMiB: 2048, cpuMemoryMiB: 6144 },
    medium: { gpuTotalMiB: 4096, cpuMemoryMiB: 8192 }
  };
  const requirement = modelRequirements[selectedModel];
  const gpuSupported = runtimeReady && nvidiaDetected && cudaDeviceCount > 0 && Number(input.gpu.totalMiB || 0) >= requirement.gpuTotalMiB;
  const cpuArchitectureSupported = input.platform === 'win32' && input.arch === 'x64';
  const cpuSupported = runtimeReady && cpuArchitectureSupported && totalMemoryMiB >= requirement.cpuMemoryMiB && Number(input.cpuThreads || 0) >= 2;
  const issues = [];
  if (!input.pythonAvailable) issues.push('缺少项目内 Python/ASR 运行时。');
  else if (!runtimeHealth.ok) issues.push(`ASR 运行时健康检查失败：${input.runtimeError || runtimeHealth.error || '未知错误'}`);
  else if (!runtimeHealth.modelReady) issues.push(`所选 ${selectedModel} 模型未完整安装。`);
  if (!nvidiaDetected) issues.push('未检测到可由 nvidia-smi 管理的 NVIDIA 显卡。');
  else if (cudaDeviceCount < 1) issues.push('CTranslate2 未检测到可用 CUDA 设备，可能是驱动或 CUDA 运行库不兼容。');
  else if (Number(input.gpu.totalMiB || 0) < requirement.gpuTotalMiB) issues.push(`${selectedModel} 模型建议至少 ${requirement.gpuTotalMiB} MiB 显存。`);
  if (!cpuArchitectureSupported) issues.push('当前内置 CPU ASR 运行时仅支持 Windows x64。');
  else if (totalMemoryMiB < requirement.cpuMemoryMiB) issues.push(`${selectedModel} 模型的 CPU ASR 建议至少 ${requirement.cpuMemoryMiB} MiB 系统内存。`);
  if (Number(input.cpuThreads || 0) < 2) issues.push('CPU ASR 至少需要 2 个逻辑处理器线程。');
  const preferredMode = gpuSupported ? 'cuda' : cpuSupported ? 'cpu' : 'unavailable';
  return {
    checkedAt: new Date().toISOString(),
    selectedModel,
    localAsrSupported: gpuSupported || cpuSupported,
    preferredMode,
    runtime: {
      ready: runtimeReady,
      pythonAvailable: Boolean(input.pythonAvailable),
      fasterWhisper: runtimeHealth.fasterWhisper || '',
      ctranslate2: runtimeHealth.ctranslate2 || '',
      modelReady: Boolean(runtimeHealth.modelReady),
      error: input.runtimeError || runtimeHealth.error || ''
    },
    system: { platform: input.platform || '', arch: input.arch || '', totalMemoryMiB, cpuThreads: Number(input.cpuThreads || 0) },
    nvidia: {
      detected: nvidiaDetected,
      name: String(input.gpu?.name || ''),
      totalMiB: Number(input.gpu?.totalMiB || 0),
      cudaDeviceCount,
      supported: gpuSupported
    },
    cpu: { supported: cpuSupported, architectureSupported: cpuArchitectureSupported, minimumMemoryMiB: requirement.cpuMemoryMiB },
    issues,
    recommendation: gpuSupported
      ? '使用 NVIDIA CUDA 常驻 ASR。'
      : cpuSupported
        ? '未找到可用 CUDA 通道，可在设置中手动开启 CPU ASR；速度会明显降低。'
        : '当前硬件或项目运行时不满足本地 ASR 条件，请修复依赖、显卡驱动或切换更小模型。'
  };
}

function parseHealth(value) {
  try { return JSON.parse(String(value || '').trim().split(/\r?\n/).filter(Boolean).at(-1) || '{}'); }
  catch { return {}; }
}

module.exports = { detectAsrHardware, evaluateAsrHardware };
