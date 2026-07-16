const fs = require('fs');
const path = require('path');
const { timestampForFile, userCookiesDir } = require('./workspace');

const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

class BiliClient {
  constructor(sessionProvider) {
    this.sessionProvider = sessionProvider;
    this.assetCache = new Map();
  }

  session() {
    return this.sessionProvider();
  }

  async cookieHeader(url = 'https://www.bilibili.com') {
    const cookies = await this.session().cookies.get({ url });
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  }

  async fetchJson(endpoint) {
    const cookie = await this.cookieHeader('https://www.bilibili.com');
    const response = await fetch(endpoint, {
      signal: AbortSignal.timeout(30000),
      headers: {
        cookie,
        referer: 'https://www.bilibili.com/',
        accept: 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'user-agent': BROWSER_USER_AGENT
      }
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Bilibili returned non-JSON: ${text.slice(0, 180)}`);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 180)}`);
    if (json.code !== 0) throw new Error(`Bilibili API ${json.code}: ${json.message || json.msg || 'unknown'}`);
    return json.data;
  }

  async nav() {
    const data = await this.fetchJson('https://api.bilibili.com/x/web-interface/nav');
    return {
      isLogin: Boolean(data.isLogin),
      mid: data.mid,
      name: data.uname,
      face: normalizeBilibiliAssetUrl(data.face)
    };
  }

  async listFolders(mid) {
    const data = await this.fetchJson(`https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${encodeURIComponent(mid)}`);
    return (data.list || []).map((folder) => ({
      id: String(folder.id),
      name: folder.title,
      mediaCount: folder.media_count || 0,
      updatedAt: unixToIso(folder.mtime || folder.ctime)
    }));
  }

  async fetchImageDataUrl(value) {
    const url = normalizeBilibiliAssetUrl(value);
    assertBilibiliImageUrl(url);
    if (this.assetCache.has(url)) return this.assetCache.get(url);
    const biliSession = this.session();
    const fetchImage = typeof biliSession?.fetch === 'function' ? biliSession.fetch.bind(biliSession) : global.fetch;
    const response = await fetchImage(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        referer: 'https://www.bilibili.com/',
        accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'user-agent': BROWSER_USER_AGENT
      }
    });
    if (!response.ok) throw new Error(`Bilibili image HTTP ${response.status}`);
    assertBilibiliImageUrl(response.url || url);
    const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
      throw new Error(`Bilibili avatar returned unsupported content type ${contentType || 'unknown'}.`);
    }
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize > 5 * 1024 * 1024) throw new Error('Bilibili avatar exceeds the 5 MiB safety limit.');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error('Bilibili avatar returned an empty image.');
    if (bytes.length > 5 * 1024 * 1024) throw new Error('Bilibili avatar exceeds the 5 MiB safety limit.');
    if (!matchesImageSignature(bytes, contentType)) throw new Error(`Bilibili avatar bytes do not match ${contentType}.`);
    const dataUrl = `data:${contentType};base64,${bytes.toString('base64')}`;
    this.assetCache.set(url, dataUrl);
    while (this.assetCache.size > 8) this.assetCache.delete(this.assetCache.keys().next().value);
    return dataUrl;
  }

  async listVideos(folderId, onProgress = () => {}) {
    const videos = [];
    const pageSize = 20;
    let reportedTotal = 0;
    let completedPages = false;
    for (let page = 1; page <= 200; page += 1) {
      const url = `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${encodeURIComponent(folderId)}&pn=${page}&ps=${pageSize}&keyword=&order=mtime&type=0&tid=0&platform=web`;
      const data = await this.fetchJson(url);
      const list = data.medias || [];
      for (const item of list) videos.push(normalizeVideo(item));
      const hasMore = data.has_more === undefined ? list.length === pageSize : Boolean(data.has_more);
      const total = Number(data.info?.media_count || data.info?.mediaCount || 0);
      reportedTotal = Math.max(reportedTotal, total);
      onProgress({
        page,
        pageSize,
        loaded: videos.length,
        total: total || null,
        progress: total ? Math.min(1, videos.length / total) : null,
        done: !hasMore || list.length === 0
      });
      if (!hasMore || list.length === 0) {
        completedPages = true;
        break;
      }
      if (page === 200) throw new Error(`Bilibili favorite pagination exceeded 200 pages (${videos.length} items loaded).`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const visibleCount = videos.length;
    const visibilityGap = Math.max(0, reportedTotal - visibleCount);
    return {
      videos,
      reportedTotal: reportedTotal || visibleCount,
      visibleCount,
      visibilityGap,
      completedPages
    };
  }

  async exportCookies(userName) {
    const dir = userCookiesDir(userName);
    const file = path.join(dir, `bilibili-cookies-${timestampForFile()}.txt`);
    const cookies = await this.session().cookies.get({});
    const lines = [
      '# Netscape HTTP Cookie File',
      '# Generated by Xing Cang Jia. Keep this file private.'
    ];
    for (const cookie of cookies) {
      if (!isBilibiliCookieDomain(cookie.domain)) continue;
      const domain = cookie.domain.startsWith('.') ? cookie.domain : `.${cookie.domain}`;
      const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
      const secure = cookie.secure ? 'TRUE' : 'FALSE';
      const expires = cookie.expirationDate ? Math.floor(cookie.expirationDate) : 0;
      lines.push([domain, includeSubdomains, cookie.path || '/', secure, expires, cookie.name, cookie.value].join('\t'));
    }
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    return file;
  }
}

function normalizeVideo(item) {
  return {
    bvid: item.bvid || '',
    aid: item.id || item.aid || '',
    title: item.title || '',
    cover: item.cover || item.pic || '',
    description: item.intro || item.desc || '',
    duration: item.duration || 0,
    owner: item.upper?.name || item.owner?.name || '',
    favoriteAddedAt: unixToIso(item.fav_time || item.mtime),
    publishedAt: unixToIso(item.pubtime || item.ctime),
    url: item.link || (item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : '')
  };
}

function unixToIso(value) {
  const number = Number(value || 0);
  if (!number) return '';
  const milliseconds = number > 1e12 ? number : number * 1000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function normalizeBilibiliAssetUrl(value) {
  const source = String(value || '').trim();
  if (source.startsWith('//')) return `https:${source}`;
  if (source.startsWith('http://')) return `https://${source.slice('http://'.length)}`;
  return source;
}

function isBilibiliCookieDomain(value) {
  const domain = String(value || '').trim().toLowerCase().replace(/^\./, '');
  return domain === 'bilibili.com' || domain.endsWith('.bilibili.com');
}

function assertBilibiliImageUrl(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:') throw new Error('Bilibili image URL must use HTTPS.');
  if (url.username || url.password) throw new Error('Bilibili image URL cannot contain credentials.');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const allowed = ['hdslb.com', 'biliimg.com', 'bilibili.com'];
  if (!allowed.some((domain) => host === domain || host.endsWith(`.${domain}`))) throw new Error(`Refusing non-Bilibili image host: ${host}`);
  return url.toString();
}

function matchesImageSignature(buffer, contentType) {
  if (contentType === 'image/png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (contentType === 'image/jpeg') return buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9;
  if (contentType === 'image/gif') return buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'));
  if (contentType === 'image/webp') return buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (contentType === 'image/avif') return buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp' && buffer.subarray(8, Math.min(buffer.length, 40)).includes(Buffer.from('avif'));
  return false;
}

module.exports = { BiliClient, assertBilibiliImageUrl, isBilibiliCookieDomain, normalizeBilibiliAssetUrl };
