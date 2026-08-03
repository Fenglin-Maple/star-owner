const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DependencyManager } = require('../src/core/dependency-manager');

const LEGACY_RUNTIME_PROBES = [
  'runtime/python/cpython-3.12.13-windows-x86_64-none/python.exe',
  'runtime/faster-whisper/Lib/site-packages/faster_whisper',
  'runtime/faster-whisper/Lib/site-packages/yt_dlp',
  'runtime/vc-runtime/msvcp140.dll'
];
const SMALL_PROBES = ['runtime/models/small/model.bin', 'runtime/models/small/config.json'];

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
    writeProbes(legacyRoot, LEGACY_RUNTIME_PROBES, 'legacy-runtime');
    writeProbes(legacyRoot, SMALL_PROBES, 'legacy-small');
    const legacy = new DependencyManager({ store: createStore(), projectRoot: legacyRoot, version: '1.4.12', dependencyVersion: '1.0.0' });
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

    const futureRoot = path.join(root, 'future-release');
    writeProbes(futureRoot, SMALL_PROBES, 'unknown-release');
    const future = new DependencyManager({ store: createStore(), projectRoot: futureRoot, version: '2.0.0', dependencyVersion: '2.0.0' });
    assert(!future.state().packages.find((item) => item.id === 'model-small')?.available, 'unknown unmanifested dependency release was adopted');
    assert.deepStrictEqual(future.state().manifestAdoption.rejectedPackages, ['model-small'], 'rejected legacy adoption was not recorded');

    const installRoot = path.join(root, 'transaction-install');
    const manager = new DependencyManager({ store: createStore(), projectRoot: installRoot, version: '9.9.9', dependencyVersion: '9.9.9' });
    const definition = manager.definitions().find((item) => item.id === 'model-small');
    const stagingRoot = path.join(installRoot, 'runtime', '.install-staging-model-small-fixture');
    writeProbes(stagingRoot, SMALL_PROBES, 'installed');
    manager.stagePackageManifest(stagingRoot, definition, {
      checksum: 'a'.repeat(64),
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
    fs.writeFileSync(path.join(modelTarget, 'model.bin'), 'interrupted-new-model');
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
    assert.strictEqual(fs.readFileSync(path.join(modelTarget, 'model.bin'), 'utf8'), 'installed:runtime/models/small/model.bin', 'rollback did not restore the previous model payload');
    assert.strictEqual(readJson(manifestTarget).checksum, 'a'.repeat(64), 'rollback did not restore the previous package manifest');
    assert(recovered.state().packages.find((item) => item.id === 'model-small')?.available, 'rolled-back package no longer passed manifest validation');
    console.log('dependency manifest test passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
