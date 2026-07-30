const DEFAULT_ASR_MODEL = 'large-v3-turbo';

const ASR_MODEL_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'small',
    label: '小模型',
    optionLabel: '小模型（更快）',
    description: '轻量多语言 ASR，速度更快、显存占用更低。',
    packageId: 'model-small',
    assetSlug: 'small',
    required: true,
    isDefault: false,
    gpuComputeType: 'float16',
    cpuComputeType: 'int8',
    gpuTotalMiB: 2048,
    gpuStartupFreeMiB: 1536,
    cpuMemoryMiB: 6144
  }),
  Object.freeze({
    id: 'medium',
    label: '中等模型',
    optionLabel: '中等模型（默认）',
    description: '默认多语言 ASR，在准确率、速度和 8GB 显存之间更均衡。',
    packageId: 'model-medium',
    assetSlug: 'medium',
    required: true,
    isDefault: true,
    gpuComputeType: 'float16',
    cpuComputeType: 'int8',
    gpuTotalMiB: 4096,
    gpuStartupFreeMiB: 3072,
    cpuMemoryMiB: 8192
  }),
  Object.freeze({
    id: 'large-v3-turbo',
    label: '大模型 Turbo',
    optionLabel: '大模型 Turbo（低显存）',
    description: 'large-v3-turbo 多语言 ASR；GPU 使用 int8_float16，面向 3GB 及以上 NVIDIA 显存。',
    packageId: 'model-large-v3-turbo',
    assetSlug: 'large-v3-turbo',
    required: false,
    isDefault: false,
    gpuComputeType: 'int8_float16',
    cpuComputeType: 'int8',
    gpuTotalMiB: 3072,
    gpuStartupFreeMiB: 2048,
    cpuMemoryMiB: 8192
  })
]);

const ASR_MODELS = Object.freeze(ASR_MODEL_DEFINITIONS
  .filter((model) => model.id !== 'medium')
  .map((model) => ({ ...model, required: model.id === DEFAULT_ASR_MODEL, isDefault: model.id === DEFAULT_ASR_MODEL })));
const ASR_MODEL_BY_ID = new Map(ASR_MODELS.map((model) => [model.id, model]));
const ASR_MODEL_BY_PACKAGE = new Map(ASR_MODELS.map((model) => [model.packageId, model]));

function normalizeAsrModel(value) {
  const id = String(value || '');
  return ASR_MODEL_BY_ID.has(id) ? id : DEFAULT_ASR_MODEL;
}

function getAsrModel(value) {
  return ASR_MODEL_BY_ID.get(normalizeAsrModel(value));
}

function getAsrModelByPackage(packageId) {
  return ASR_MODEL_BY_PACKAGE.get(String(packageId || '')) || null;
}

function isAsrModelPackage(packageId) {
  return ASR_MODEL_BY_PACKAGE.has(String(packageId || ''));
}

function asrComputeType(model, device) {
  const definition = getAsrModel(model);
  return device === 'cpu' ? definition.cpuComputeType : definition.gpuComputeType;
}

function publicAsrModels() {
  return ASR_MODELS.map((model) => ({ ...model }));
}

module.exports = {
  ASR_MODELS,
  DEFAULT_ASR_MODEL,
  asrComputeType,
  getAsrModel,
  getAsrModelByPackage,
  isAsrModelPackage,
  normalizeAsrModel,
  publicAsrModels
};
