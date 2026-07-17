const path = require('path');
const { pathToFileURL } = require('url');
const { isBilibiliHost, parseHttpUrl } = require('./network-policy');

function secureMainWindow(window, rendererFile, options = {}) {
  const rendererUrl = pathToFileURL(path.resolve(rendererFile)).toString();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== rendererUrl) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event, preferences, params) => {
    delete preferences.preload;
    delete preferences.preloadURL;
    Object.assign(preferences, {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true
    });
    if (!isAllowedBilibiliNavigation(params.src)) event.preventDefault();
  });
  window.webContents.on('did-attach-webview', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (isBilibiliVideoNavigation(url) && typeof options.openBilibiliVideo === 'function') {
        options.openBilibiliVideo(url);
      }
      return { action: 'deny' };
    });
    const guard = (event, url) => {
      if (!isAllowedBilibiliNavigation(url)) {
        event.preventDefault();
        return;
      }
      if (isBilibiliVideoNavigation(url) && typeof options.openBilibiliVideo === 'function') {
        event.preventDefault();
        options.openBilibiliVideo(url);
      }
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
  });
}

function isBilibiliVideoNavigation(value) {
  try {
    const url = parseHttpUrl(value);
    if (!isAllowedBilibiliNavigation(url.toString())) return false;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    if (hostname === 'b23.tv' || hostname.endsWith('.b23.tv')) return true;
    const pathname = url.pathname.toLowerCase();
    return pathname.startsWith('/video/')
      || pathname.startsWith('/bangumi/play/')
      || pathname.startsWith('/bangumi/media/')
      || pathname.startsWith('/cheese/play/')
      || pathname.startsWith('/festival/')
      || pathname.startsWith('/medialist/play/');
  } catch {
    return false;
  }
}

function isAllowedBilibiliNavigation(value) {
  try {
    const url = parseHttpUrl(value);
    return !url.username && !url.password && isBilibiliHost(url.hostname);
  } catch {
    return false;
  }
}

module.exports = { isAllowedBilibiliNavigation, isBilibiliVideoNavigation, secureMainWindow };
