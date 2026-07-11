const path = require('path');
const { pathToFileURL } = require('url');
const { isBilibiliHost, parseHttpUrl } = require('./network-policy');

function secureMainWindow(window, rendererFile) {
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
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const guard = (event, url) => {
      if (!isAllowedBilibiliNavigation(url)) event.preventDefault();
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
  });
}

function isAllowedBilibiliNavigation(value) {
  try {
    const url = parseHttpUrl(value);
    return isBilibiliHost(url.hostname);
  } catch {
    return false;
  }
}

module.exports = { isAllowedBilibiliNavigation, secureMainWindow };
