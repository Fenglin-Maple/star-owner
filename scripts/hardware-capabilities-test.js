const fs = require('fs');
const path = require('path');
const { detectAsrHardware, evaluateAsrHardware } = require('../src/core/hardware-capabilities');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  const runtime = { ok: true, modelReady: true, fasterWhisper: '1.2.0', ctranslate2: '4.6.0', cudaDevices: 1 };
  const nvidia = evaluateAsrHardware({
    platform: 'win32', arch: 'x64', totalMemoryBytes: 16 * 1024 ** 3, cpuThreads: 16,
    gpu: { available: true, name: 'RTX test', totalMiB: 8192 }, model: 'medium', pythonAvailable: true, runtimeHealth: runtime
  });
  assert(nvidia.localAsrSupported && nvidia.preferredMode === 'cuda' && nvidia.nvidia.detected && nvidia.nvidia.supported, 'supported NVIDIA/CUDA environment was rejected');

  const cpuOnly = evaluateAsrHardware({
    platform: 'win32', arch: 'x64', totalMemoryBytes: 16 * 1024 ** 3, cpuThreads: 8,
    gpu: { available: false }, model: 'medium', pythonAvailable: true, runtimeHealth: { ...runtime, cudaDevices: 0 }
  });
  assert(cpuOnly.localAsrSupported && cpuOnly.preferredMode === 'cpu' && !cpuOnly.nvidia.detected && cpuOnly.cpu.supported, 'supported CPU fallback was rejected');

  const missingCuda = evaluateAsrHardware({
    platform: 'win32', arch: 'x64', totalMemoryBytes: 4 * 1024 ** 3, cpuThreads: 8,
    gpu: { available: true, name: 'RTX without CUDA', totalMiB: 8192 }, model: 'medium', pythonAvailable: true, runtimeHealth: { ...runtime, cudaDevices: 0 }
  });
  assert(!missingCuda.localAsrSupported && missingCuda.nvidia.detected && !missingCuda.nvidia.supported && missingCuda.issues.some((item) => item.includes('CUDA')), 'missing CTranslate2 CUDA device was not reported');

  const smallModel = evaluateAsrHardware({
    platform: 'win32', arch: 'x64', totalMemoryBytes: 8 * 1024 ** 3, cpuThreads: 4,
    gpu: { available: true, name: '3GB NVIDIA', totalMiB: 3072 }, model: 'small', pythonAvailable: true, runtimeHealth: runtime
  });
  const mediumModel = evaluateAsrHardware({
    platform: 'win32', arch: 'x64', totalMemoryBytes: 6 * 1024 ** 3, cpuThreads: 4,
    gpu: { available: true, name: '3GB NVIDIA', totalMiB: 3072 }, model: 'medium', pythonAvailable: true, runtimeHealth: runtime
  });
  assert(smallModel.nvidia.supported && !mediumModel.localAsrSupported, 'model-specific GPU/RAM requirements were not enforced');

  const unsupportedArchitecture = evaluateAsrHardware({
    platform: 'linux', arch: 'arm64', totalMemoryBytes: 32 * 1024 ** 3, cpuThreads: 16,
    gpu: { available: false }, model: 'medium', pythonAvailable: true, runtimeHealth: { ...runtime, cudaDevices: 0 }
  });
  assert(!unsupportedArchitecture.cpu.supported && unsupportedArchitecture.issues.some((item) => item.includes('Windows x64')), 'unsupported bundled CPU runtime architecture was accepted');

  const emptyProject = path.join(__dirname, '..', '.cache', 'hardware-capabilities-empty');
  fs.rmSync(emptyProject, { recursive: true, force: true });
  fs.mkdirSync(emptyProject, { recursive: true });
  const missingRuntime = await detectAsrHardware({ projectRoot: emptyProject, gpu: { available: false }, model: 'medium' });
  assert(!missingRuntime.localAsrSupported && !missingRuntime.runtime.pythonAvailable && missingRuntime.issues.some((item) => item.includes('Python')), 'missing project-local ASR runtime was not detected');
  fs.rmSync(emptyProject, { recursive: true, force: true });
  console.log('ASR hardware capability test passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
