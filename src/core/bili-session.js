const crypto = require('crypto');
const path = require('path');

const LEGACY_BILI_SESSION = 'persist:bili-orchestrator';

function projectBiliPartition(projectRoot) {
  const resolved = path.resolve(String(projectRoot || process.cwd()));
  const identity = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const digest = crypto.createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 32);
  return `persist:star-owner-bili-${digest}`;
}

function isBilibiliCookieDomain(domain) {
  const normalized = String(domain || '').replace(/^\./, '').toLowerCase();
  return normalized === 'bilibili.com' || normalized.endsWith('.bilibili.com');
}

function cookieUrl(cookie) {
  const host = String(cookie?.domain || '').replace(/^\./, '');
  if (!isBilibiliCookieDomain(host)) return '';
  return `${cookie?.secure ? 'https' : 'http'}://${host}${cookie?.path || '/'}`;
}

function hasStoredBilibiliUser(store) {
  return (store?.list?.('users') || []).some((user) => !user?.internal && String(user?.mid || user?.id || '').trim());
}

async function migrateLegacyBiliPartition({ sessionModule, targetPartition, store, legacyPartition = LEGACY_BILI_SESSION } = {}) {
  const targetName = String(targetPartition || '');
  if (!sessionModule?.fromPartition || !targetName || targetName === legacyPartition) return { copied: 0, skipped: 'invalid-partition' };
  const markerId = 'biliPartitionMigration';
  const marker = store?.get?.('settings', markerId);
  if (marker?.targetPartition === targetName) return { copied: 0, skipped: 'already-migrated' };

  const sourceSession = sessionModule.fromPartition(legacyPartition);
  const targetSession = sessionModule.fromPartition(targetName);
  const sourceCookies = (await sourceSession.cookies.get({})).filter((cookie) => isBilibiliCookieDomain(cookie.domain));
  const targetCookies = (await targetSession.cookies.get({})).filter((cookie) => isBilibiliCookieDomain(cookie.domain));
  const shouldCopy = hasStoredBilibiliUser(store) && targetCookies.length === 0;
  let copied = 0;
  let errors = 0;
  if (shouldCopy) {
    for (const cookie of sourceCookies) {
      const url = cookieUrl(cookie);
      if (!url) continue;
      try {
        const details = {
          url,
          name: cookie.name,
          value: cookie.value,
          path: cookie.path || '/',
          secure: Boolean(cookie.secure),
          httpOnly: Boolean(cookie.httpOnly),
          sameSite: cookie.sameSite || 'unspecified'
        };
        if (cookie.domain) details.domain = cookie.domain;
        if (Number.isFinite(Number(cookie.expirationDate)) && Number(cookie.expirationDate) > 0) details.expirationDate = Number(cookie.expirationDate);
        await targetSession.cookies.set(details);
        copied += 1;
      } catch {
        errors += 1;
      }
    }
  }
  if (store?.set && store?.commit) {
    store.set('settings', markerId, {
      id: markerId,
      sourcePartition: legacyPartition,
      targetPartition: targetName,
      copied,
      errors,
      skipped: shouldCopy ? '' : (hasStoredBilibiliUser(store) ? 'target-already-has-cookies' : 'blank-project'),
      migratedAt: new Date().toISOString()
    });
    store.commit();
  }
  return { copied, errors, skipped: shouldCopy ? '' : 'not-eligible' };
}

module.exports = { LEGACY_BILI_SESSION, migrateLegacyBiliPartition, projectBiliPartition };
