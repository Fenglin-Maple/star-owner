const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'workspace', 'debug');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join('');
}

async function inspectFrame(frame) {
  try {
    return await frame.executeJavaScript(`
      (async () => {
        const compact = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const visible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
        };
        const describe = (el) => {
          const box = el.getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            text: compact(el.innerText || el.textContent).slice(0, 120),
            id: el.id || '',
            className: typeof el.className === 'string' ? el.className.slice(0, 180) : '',
            role: el.getAttribute('role') || '',
            name: el.getAttribute('name') || '',
            type: el.getAttribute('type') || '',
            placeholder: el.getAttribute('placeholder') || '',
            ariaLabel: el.getAttribute('aria-label') || '',
            href: el.getAttribute('href') || '',
            disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
            rect: {
              x: Math.round(box.x),
              y: Math.round(box.y),
              width: Math.round(box.width),
              height: Math.round(box.height)
            },
            html: compact(el.outerHTML).slice(0, 500)
          };
        };
        return {
          href: location.href,
          title: document.title,
          bodyText: compact(document.body?.innerText || '').slice(0, 5000),
          passwordLoginDryRun: await (async () => {
            const setValue = (el, value) => {
              if (!el) return false;
              const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              setter ? setter.call(el, value) : (el.value = value);
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            };
            const root = document.querySelector('.login-pwd') || document.querySelector('.main__right') || document;
            const user = root.querySelector('input[type="text"], input[type="tel"]');
            const pass = root.querySelector('input[type="password"]');
            const okUser = setValue(user, 'inspect@example.com');
            const okPass = setValue(pass, 'inspect-password');
            await sleep(500);
            const button = root.querySelector('.btn_wp .btn_primary, .btn_primary, button[type="submit"], button');
            return {
              okUser,
              okPass,
              buttonText: compact(button?.innerText || button?.textContent || ''),
              buttonClass: typeof button?.className === 'string' ? button.className : '',
              buttonDisabled: Boolean(button?.disabled || button?.getAttribute('aria-disabled') === 'true' || /\\bdisabled\\b/i.test(String(button?.className || '')))
            };
          })(),
          inputs: [...document.querySelectorAll('input, textarea')]
            .filter(visible)
            .map(describe),
          clickables: [...document.querySelectorAll('button, a, span, div, li, [role="button"], [role="tab"]')]
            .filter(visible)
            .map(describe)
            .filter((item) => item.text || item.role || item.id || item.className || item.ariaLabel)
            .slice(0, 220),
          iframes: [...document.querySelectorAll('iframe')]
            .map((el) => ({
              src: el.src,
              title: el.title || '',
              visible: visible(el),
              rect: (() => {
                const box = el.getBoundingClientRect();
                return {
                  x: Math.round(box.x),
                  y: Math.round(box.y),
                  width: Math.round(box.width),
                  height: Math.round(box.height)
                };
              })()
            }))
        };
      })()
    `);
  } catch (error) {
    return { error: error.message || String(error), url: frame.url };
  }
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  await app.whenReady();

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'persist:bili-orchestrator-inspect'
    }
  });

  const target = 'https://passport.bilibili.com/login';
  await win.loadURL(target);
  await sleep(7000);

  const frames = [win.webContents.mainFrame, ...win.webContents.mainFrame.frames];
  const result = {
    inspectedAt: new Date().toISOString(),
    target,
    finalUrl: win.webContents.getURL(),
    frameCount: frames.length,
    frames: []
  };

  for (const frame of frames) {
    result.frames.push({
      name: frame.name,
      url: frame.url,
      data: await inspectFrame(frame)
    });
  }

  const stamp = timestamp();
  const jsonPath = path.join(outDir, `bili-login-inspect-${stamp}.json`);
  const screenshotPath = path.join(outDir, `bili-login-inspect-${stamp}.png`);
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), 'utf8');
  const image = await win.webContents.capturePage();
  fs.writeFileSync(screenshotPath, image.toPNG());

  console.log(JSON.stringify({ ok: true, jsonPath, screenshotPath, finalUrl: result.finalUrl, frameCount: frames.length }, null, 2));
  await win.close();
  app.quit();
}

main().catch((error) => {
  console.error(error);
  app.quit();
  process.exitCode = 1;
});
