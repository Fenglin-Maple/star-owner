const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { MAX_CLIPBOARD_IMAGE_BYTES, loadClipboardImage } = require('../src/core/image-clipboard');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectReject(promise, pattern, message) {
  try { await promise; }
  catch (error) {
    if (pattern.test(error.message || String(error))) return;
    throw error;
  }
  throw new Error(message);
}

(async () => {
  const root = path.join(__dirname, '..', '.cache', 'image-clipboard-test');
  const trusted = path.join(root, 'trusted');
  const outside = path.join(root, 'outside');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(trusted, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const trustedImage = path.join(trusted, 'frame.png');
  const outsideImage = path.join(outside, 'private.png');
  fs.writeFileSync(trustedImage, png);
  fs.writeFileSync(outsideImage, png);

  try {
    const dataImage = await loadClipboardImage(`data:image/png;base64,${png.toString('base64')}`);
    assert(dataImage.buffer.equals(png) && dataImage.sourceType === 'data', 'Data URL image was not decoded');

    const localImage = await loadClipboardImage(pathToFileURL(trustedImage).href, { trustedRoots: [trusted] });
    assert(localImage.buffer.equals(png) && localImage.sourceType === 'file', 'trusted Workspace image was not loaded');
    await expectReject(loadClipboardImage(pathToFileURL(outsideImage).href, { trustedRoots: [trusted] }), /Workspace/, 'outside file image was accepted');

    const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
    const remoteImage = await loadClipboardImage('https://images.example.test/frame.png', {
      lookup: publicLookup,
      fetchImpl: async () => new Response(png, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(png.length) } })
    });
    assert(remoteImage.buffer.equals(png) && remoteImage.sourceType === 'remote', 'public remote image was not loaded');
    await expectReject(loadClipboardImage('http://127.0.0.1/private.png', { lookup: publicLookup, fetchImpl: async () => new Response(png) }), /私有网络/, 'private-network image was accepted');
    await expectReject(loadClipboardImage('https://images.example.test/huge.png', {
      lookup: publicLookup,
      fetchImpl: async () => new Response(png, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(MAX_CLIPBOARD_IMAGE_BYTES + 1) } })
    }), /MiB/, 'oversized remote image was accepted');

    console.log('Image clipboard security test passed.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
