const DEFAULT_MINIMUM_WAIT_MS = 2000;
const DEFAULT_QUIET_WAIT_MS = 1000;
const DEFAULT_MAXIMUM_WAIT_MS = 8000;
const DEFAULT_SAMPLE_INTERVAL_MS = 200;

function buildHiddenPageExtractionScript(options = {}) {
  const minimumWaitMs = boundedInteger(options.minimumWaitMs, DEFAULT_MINIMUM_WAIT_MS, 0, 5000);
  const quietWaitMs = boundedInteger(options.quietWaitMs, DEFAULT_QUIET_WAIT_MS, 200, 3000);
  const maximumWaitMs = boundedInteger(options.maximumWaitMs, DEFAULT_MAXIMUM_WAIT_MS, Math.max(minimumWaitMs + quietWaitMs, 1000), 15000);
  const sampleIntervalMs = boundedInteger(options.sampleIntervalMs, DEFAULT_SAMPLE_INTERVAL_MS, 100, 1000);
  return `(async () => {
    const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));
    const contentType = String(document.contentType || '').toLowerCase();
    if (contentType.startsWith('image/')) {
      return { title: document.title || '', url: location.href, text: '', links: [], contentType, isImage: true };
    }
    const snapshot = () => {
      const body = document.body;
      const text = body?.innerText || '';
      const resources = typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function'
        ? performance.getEntriesByType('resource').length
        : 0;
      return {
        text,
        signature: [text.length, text.slice(0, 1200), text.slice(-1200), body?.childElementCount || 0, resources].join('|')
      };
    };
    const startedAt = Date.now();
    let previous = snapshot();
    let stableSince = startedAt;
    let meaningfulTextSeen = Boolean(previous.text.trim());
    const adaptiveMinimumWait = previous.text.trim().length >= 3000 ? Math.min(${minimumWaitMs}, 900) : ${minimumWaitMs};
    while (Date.now() - startedAt < ${maximumWaitMs}) {
      await sleep(${sampleIntervalMs});
      const current = snapshot();
      if (current.text.trim()) meaningfulTextSeen = true;
      if (current.signature !== previous.signature) {
        previous = current;
        stableSince = Date.now();
      }
      const elapsed = Date.now() - startedAt;
      const quiet = Date.now() - stableSince >= ${quietWaitMs};
      if (elapsed >= adaptiveMinimumWait && quiet && meaningfulTextSeen) break;
    }
    const title = document.title || '';
    const text = (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 50000);
    const links = [...document.querySelectorAll('a[href]')]
      .slice(0, 40)
      .map((a) => ({ text: (a.innerText || '').trim().slice(0, 160), href: a.href }))
      .filter((item) => item.text && /^https?:/.test(item.href));
    return { title, url: location.href, text, links, contentType, isImage: false };
  })()`;
}

function isImageContentType(value) {
  return /^image\//i.test(String(value || '').trim());
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}

module.exports = {
  DEFAULT_MAXIMUM_WAIT_MS,
  DEFAULT_MINIMUM_WAIT_MS,
  DEFAULT_QUIET_WAIT_MS,
  buildHiddenPageExtractionScript,
  isImageContentType
};
