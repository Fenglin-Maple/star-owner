const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DependencyManager, contentChecksumForProbes } = require('../src/core/dependency-manager');

const IS_DARWIN = process.platform === 'darwin';

// win32 原 fixture（逐字保留）：Lib/site-packages、python.exe、.dll、model.bin
const LEGACY_RUNTIME_PROBES = [
  'runtime/python/cpython-3.12.13-windows-x86_64-none/python.exe',
  'runtime/faster-whisper/Lib/site-packages/faster_whisper',
  'runtime/faster-whisper/Lib/site-packages/yt_dlp',
  'runtime/vc-runtime/msvcp140.dll'
];
const SMALL_PROBES = ['runtime/models/small/model.bin', 'runtime/models/small/config.json'];
// darwin fixture：POSIX venv 布局（bin/python + lib/python*/site-packages）与 MLX 模型权重
const DARWIN_RUNTIME_PROBES = [
  'runtime/faster-whisper/bin/python',
  'runtime/faster-whisper/lib/python3.12/site-packages/mlx_whisper',
  'runtime/faster-whisper/lib/python3.12/site-packages/yt_dlp'
];
const DARWIN_SMALL_PROBES = ['runtime/models/small/config.json', 'runtime/models/small/weights.npz'];

const RUNTIME_PROBES = IS_DARWIN ? DARWIN_RUNTIME_PROBES : LEGACY_RUNTIME_PROBES;
const SMALL = IS_DARWIN ? DARWIN_SMALL_PROBES : SMALL_PROBES;
// 模型“载荷文件”相对路径（回滚断言用）：win32 为 model.bin，darwin 为 MLX weights.npz
const MODEL_PAYLOAD_REL = IS_DARWIN ? 'weights.npz' : 'model.bin';

function createStore() {
  const settings = new Map();
  return {
    get: (scope, id) => settings.get(`${scope}:${id}`) || null,
    set: (scope, id, value) => settings.set(`${scope}:${id}`, value),
    save: () => {},
    commit: () => {}
  };
}

function writeProbes(root, probes, prefix = 'fixture') {
  for (const relative of probes) {
    const target = path.join(root, relative);
    if (path.extname(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${prefix}:${relative}`);
    } else {
      fs.mkdirSync(target, { recursive: true });
    }
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'star-owner-dependency-manifest-'));
  try {
    const legacyRoot = path.join(root, 'legacy-v1');
    writeProbes(legacyRoot, RUNTIME_PROBES, 'legacy-runtime');
    writeProbes(legacyRoot, SMALL, 'legacy-small');
    const legacy = new DependencyManager({ store: createStore(), projectRoot: legacyRoot, version: '1.4.12', dependencyVersion: '1.0.0' });
    if (IS_DARWIN) {
      // macOS local-config 语义：darwin definitions 无 GitHub 资产（assetName 为空），
      // 即使旧版 v1.0.0 探针齐备也不会被认领，而是记入 rejectedPackages（应走 npm run manifest:mac 生成本地清单）
      const legacyState = legacy.state();
      assert(!legacyState.packages.find((item) => item.id === 'runtime-base')?.available, 'v1.0.0 runtime was adopted on macOS without a local manifest');
      assert(!legacyState.packages.find((item) => item.id === 'model-small')?.available, 'v1.0.0 small model was adopted on macOS without a local manifest');
      assert.deepStrictEqual(legacyState.manifestAdoption.rejectedPackages.sort(), ['model-small', 'runtime-base'], 'macOS legacy adoption must reject GitHub-asset packages');
      assert.strictEqual(legacyState.manifestAdoption.eligible, true, 'macOS legacy adoption eligibility flag mismatch');
      assert.strictEqual(legacyState.manifestAdoption.completed, true, 'macOS legacy adoption marker was not completed');
      // 模拟 npm run manifest:mac：写入内容 SHA-256 匹配的本地清单 → local-config-valid
      const smallManifestFile = path.join(legacyRoot, 'runtime', '.dependency-manifests', 'model-small.json');
      const smallDefinition = legacy.definitions().find((item) => item.id === 'model-small');
      const realChecksum = contentChecksumForProbes(legacyRoot, smallDefinition.probes);
      legacy.stagePackageManifest(legacyRoot, smallDefinition, {
        checksum: realChecksum,
        source: 'test-manifest-mac',
        sourceAssetName: '',
        sourceReleaseVersion: '1.0.0'
      });
      const adoptedSmall = readJson(smallManifestFile);
      assert.strictEqual(adoptedSmall.packageId, 'model-small');
      assert.strictEqual(adoptedSmall.dependencyReleaseVersion, '1.0.0');
      assert.strictEqual(adoptedSmall.assetName, '', 'macOS manifest must keep assetName empty (local-config mode)');
      assert.strictEqual(adoptedSmall.checksum, realChecksum);
      assert.strictEqual(legacy.state().packages.find((item) => item.id === 'model-small')?.manifestStatus, 'local-config-valid', 'macOS local-config manifest was not accepted');
      assert.strictEqual(legacy.state().packages.find((item) => item.id === 'model-small')?.available, true, 'macOS local-config package was not available');

      fs.writeFileSync(smallManifestFile, JSON.stringify({ ...adoptedSmall, assetName: 'Star-Owner-v1.0.0-model-small.zip' }));
      assert.strictEqual(legacy.state().packages.find((item) => item.id === 'model-small')?.manifestStatus, 'asset-mismatch', 'wrong dependency asset identity was accepted');
      fs.writeFileSync(smallManifestFile, JSON.stringify({ ...adoptedSmall, checksum: '0'.repeat(64) }));
      assert.strictEqual(legacy.state().packages.find((item) => item.id === 'model-small')?.manifestStatus, 'checksum-mismatch', 'wrong dependency content checksum was accepted');
      fs.writeFileSync(smallManifestFile, JSON.stringify({ ...adoptedSmall, packageId: 'model-large-v3-turbo' }));
      assert.strictEqual(legacy.state().packages.find((item) => item.id === 'model-small')?.manifestStatus, 'package-mismatch', 'wrong package identity was accepted');
      fs.writeFileSync(smallManifestFile, JSON.stringify(adoptedSmall));
      const newer = new DependencyManager({ store: createStore(), projectRoot: legacyRoot, version: '2.0.0', dependencyVersion: '2.0.0' });
      assert.strictEqual(newer.state().packages.find((item) => item.id === 'model-small')?.manifestStatus, 'version-mismatch', 'old dependency manifest was accepted by a newer dependency release');
      fs.rmSync(smallManifestFile, { force: true });
      const noReadoption = new DependencyManager({ store: createStore(), projectRoot: legacyRoot, version: '1.4.12', dependencyVersion: '1.0.0' });
      assert.strictEqual(noReadoption.state().packages.find((item) => item.id === 'model-small')?.manifestStatus, 'missing', 'a deleted manifest was silently re-adopted after migration completed');

      // yexca 验收标准：多分片模型删除/清空任意必需分片后，manifest 与健康检查必须失败
      const shardRoot = path.join(root, 'shards');
      writeProbes(shardRoot, DARWIN_SMALL_PROBES, 'shard-model');
      // 构造带 index 的双分片模型（model.safetensors.index.json 引用 shard-a/shard-b）
      const shardDir = path.join(shardRoot, 'runtime', 'models', 'small');
      fs.writeFileSync(path.join(shardDir, 'model.safetensors.index.json'), JSON.stringify({ weight_map: { 'a.weight': 'shard-a.safetensors', 'b.weight': 'shard-b.safetensors' } }));
      fs.writeFileSync(path.join(shardDir, 'shard-a.safetensors'), 'shard-a-content');
      fs.writeFileSync(path.join(shardDir, 'shard-b.safetensors'), 'shard-b-content');
      const shardManager = new DependencyManager({ store: createStore(), projectRoot: shardRoot, version: '1.4.12', dependencyVersion: '1.0.0' });
      const shardDefinition = shardManager.definitions().find((item) => item.id === 'model-small');
      const shardProbes = shardDefinition.probes;
      // index + 全部分片必须全部进入探针（去重排序）
      assert(shardProbes.includes('runtime/models/small/model.safetensors.index.json'), 'index 未纳入探针');
      assert(shardProbes.includes('runtime/models/small/shard-a.safetensors'), '分片 A 未纳入探针');
      assert(shardProbes.includes('runtime/models/small/shard-b.safetensors'), '分片 B 未纳入探针');
      const shardChecksum = contentChecksumForProbes(shardRoot, shardProbes);
      shardManager.stagePackageManifest(shardRoot, shardDefinition, { checksum: shardChecksum, source: 'test-manifest-shards', sourceAssetName: '', sourceReleaseVersion: '1.0.0' });
      assert.strictEqual(shardManager.state().packages.find((item) => item.id === 'model-small')?.available, true, '完整双分片模型应可用');
      // 删除分片 B → 探针缺失，健康检查必须失败
      fs.rmSync(path.join(shardDir, 'shard-b.safetensors'), { force: true });
      const afterDelete = shardManager.state().packages.find((item) => item.id === 'model-small');
      assert(!afterDelete.available, '删除任意必需分片后模型仍被判为可用');
      assert(['probes-missing', 'checksum-mismatch'].includes(afterDelete.manifestStatus), `删除分片后状态应为 probes-missing/checksum-mismatch，实际 ${afterDelete.manifestStatus}`);
      // 恢复分片 B、清空分片 A → 内容校验必须失败
      fs.writeFileSync(path.join(shardDir, 'shard-b.safetensors'), 'shard-b-content');
      fs.writeFileSync(path.join(shardDir, 'shard-a.safetensors'), 'tampered');
      const afterTamper = shardManager.state().packages.find((item) => item.id === 'model-small');
      assert(!afterTamper.available, '篡改任意分片后模型仍被判为可用');
      assert.strictEqual(afterTamper.manifestStatus, 'checksum-mismatch', `篡改分片后应为 checksum-mismatch，实际 ${afterTamper.manifestStatus}`);
      fs.writeFileSync(path.join(shardDir, 'shard-a.safetensors'), 'shard-a-content');
      assert.strictEqual(shardManager.state().packages.find((item) => item.id === 'model-small')?.available, true, '恢复分片后模型应重新可用');
    } else {
      const legacyState = legacy.state();
      assert(legacyState.packages.find((item) => item.id === 'runtime-base')?.available, 'v1.0.0 runtime was not adopted once');
      assert(legacyState.packages.find((item) => item.id === 'model-small')?.available, 'v1.0.0 small model was not adopted once');
      assert.deepStrictEqual(legacyState.manifestAdoption.adoptedPackages.sort(), ['model-small', 'runtime-base'], 'legacy adoption recorded the wrong package set');
      const smallManifestFile = path.join(legacyRoot, 'runtime', '.dependency-manifests', 'model-small.json');
      const adoptedSmall = readJson(smallManifestFile);
      assert.strictEqual(adoptedSmall.packageId, 'model-small');
      assert.strictEqual(adoptedSmall.dependencyReleaseVersion, '1.0.0');
      assert.strictEqual(adoptedSmall.assetName, 'Star-Owner-v1.0.0-model-small.zip');
      assert.strictEqual(adoptedSmall.checksum, '82792d0eccee4579b279224676e87824e8652133947cf197f480377315a8c878');

      fs.writeFileSync(smallManifestFile, JSON.stringify({ ...adoptedSmall, assetName: 'Star-Owner-v1.0.0-model-medium.zip' }));
      assert.strictEqual(legacy.state().packages.find((item) => item.id === 'model-small')?.manifestStatus, 'asset-mismatch', 'wrong dependency asset identity was accepted');
      fs.writeFileSync(smallManifestFile, JSON.stringify({ ...adoptedSmall, checksum: '0'.repeat(64) }));
      assert.strictEqual(legacy.state().packages.find((item) => item.id === 'model-small')?.manifestStatus, 'checksum-mismatch', 'wrong official dependency checksum was accepted');
      fs.writeFileSync(smallManifestFile, JSON.stringify({ ...adoptedSmall, packageId: 'model-large-v3-turbo' }));
      assert.strictEqual(legacy.state().packages.find((item) => item.id === 'model-small')?.manifestStatus, 'package-mismatch', 'wrong package identity was accepted');
      fs.writeFileSync(smallManifestFile, JSON.stringify(adoptedSmall));
      const newer = new DependencyManager({ store: createStore(), projectRoot: legacyRoot, version: '2.0.0', dependencyVersion: '2.0.0' });
      assert.strictEqual(newer.state().packages.find((item) => item.id === 'model-small')?.manifestStatus, 'version-mismatch', 'old dependency manifest was accepted by a newer dependency release');
      fs.rmSync(smallManifestFile, { force: true });
      const noReadoption = new DependencyManager({ store: createStore(), projectRoot: legacyRoot, version: '1.4.12', dependencyVersion: '1.0.0' });
      assert.strictEqual(noReadoption.state().packages.find((item) => item.id === 'model-small')?.manifestStatus, 'missing', 'a deleted manifest was silently re-adopted after migration completed');
    }

    const futureRoot = path.join(root, 'future-release');
    writeProbes(futureRoot, SMALL, 'unknown-release');
    const future = new DependencyManager({ store: createStore(), projectRoot: futureRoot, version: '2.0.0', dependencyVersion: '2.0.0' });
    assert(!future.state().packages.find((item) => item.id === 'model-small')?.available, 'unknown unmanifested dependency release was adopted');
    assert.deepStrictEqual(future.state().manifestAdoption.rejectedPackages, ['model-small'], 'rejected legacy adoption was not recorded');

    const installRoot = path.join(root, 'transaction-install');
    const manager = new DependencyManager({ store: createStore(), projectRoot: installRoot, version: '9.9.9', dependencyVersion: '9.9.9' });
    const definition = manager.definitions().find((item) => item.id === 'model-small');
    const stagingRoot = path.join(installRoot, 'runtime', '.install-staging-model-small-fixture');
    writeProbes(stagingRoot, SMALL, 'installed');
    // darwin 健康检查会重算探针内容 SHA-256，清单校验值必须等于真实内容校验和（win32 仅做官方校验值比对，保留 'a'.repeat(64) 原断言）
    const installedChecksum = IS_DARWIN ? contentChecksumForProbes(stagingRoot, definition.probes) : 'a'.repeat(64);
    manager.stagePackageManifest(stagingRoot, definition, {
      checksum: installedChecksum,
      source: 'test-install',
      sourceAssetName: definition.assetName,
      sourceReleaseVersion: '9.9.9'
    });
    let committedJournal = null;
    const finalize = manager.finalizeCommittedInstall.bind(manager);
    manager.finalizeCommittedInstall = (journal) => {
      committedJournal = JSON.parse(JSON.stringify(journal));
      return finalize(journal);
    };
    manager.installStagedRuntime(stagingRoot, definition);
    assert(manager.state().packages.find((item) => item.id === 'model-small')?.available, 'manifested dependency install was not available');
    assert(committedJournal.entries.some((entry) => entry.relative === 'runtime/.dependency-manifests/model-small.json'), 'manifest was not part of the atomic install journal');

    const modelTarget = path.join(installRoot, 'runtime', 'models', 'small');
    const manifestTarget = path.join(installRoot, 'runtime', '.dependency-manifests', 'model-small.json');
    const oldManifest = readJson(manifestTarget);
    const backupRoot = path.join(installRoot, 'runtime', '.install-backup-model-small-recovery');
    const modelBackup = path.join(backupRoot, 'runtime', 'models', 'small');
    const manifestBackup = path.join(backupRoot, 'runtime', '.dependency-manifests', 'model-small.json');
    fs.cpSync(modelTarget, modelBackup, { recursive: true });
    fs.mkdirSync(path.dirname(manifestBackup), { recursive: true });
    fs.copyFileSync(manifestTarget, manifestBackup);
    fs.writeFileSync(path.join(modelTarget, MODEL_PAYLOAD_REL), 'interrupted-new-model');
    fs.writeFileSync(manifestTarget, JSON.stringify({ ...oldManifest, checksum: 'b'.repeat(64) }));
    const interruptedStaging = path.join(installRoot, 'runtime', '.install-staging-model-small-recovery');
    fs.mkdirSync(interruptedStaging, { recursive: true });
    fs.writeFileSync(path.join(installRoot, 'runtime', '.install-transaction.json'), JSON.stringify({
      id: 'model-small',
      phase: 'installing',
      stagingRoot: interruptedStaging,
      backupRoot,
      entries: [
        { relative: 'runtime/models/small', target: modelTarget, backup: modelBackup, hadOriginal: true, status: 'installed' },
        { relative: 'runtime/.dependency-manifests/model-small.json', target: manifestTarget, backup: manifestBackup, hadOriginal: true, status: 'installed' }
      ]
    }));
    const recovered = new DependencyManager({ store: createStore(), projectRoot: installRoot, version: '9.9.9', dependencyVersion: '9.9.9' });
    assert.strictEqual(recovered.state().recovery.action, 'rolled-back-interrupted-install', 'interrupted manifest transaction was not rolled back');
    assert.strictEqual(fs.readFileSync(path.join(modelTarget, MODEL_PAYLOAD_REL), 'utf8'), `installed:runtime/models/small/${MODEL_PAYLOAD_REL}`, 'rollback did not restore the previous model payload');
    assert.strictEqual(readJson(manifestTarget).checksum, installedChecksum, 'rollback did not restore the previous package manifest');
    assert(recovered.state().packages.find((item) => item.id === 'model-small')?.available, 'rolled-back package no longer passed manifest validation');
    console.log('dependency manifest test passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
