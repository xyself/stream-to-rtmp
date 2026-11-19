const config = require('../../config');
const http = require('../http');

function getDouyinCookie() {
  try {
    const db = require('../../db');
    const dbCookie = db.getSetting?.('douyin_cookie');
    if (dbCookie) return dbCookie;
  } catch {}
  return config.http.douyinCookie;
}

function normalizeStreamUrl(url) {
  if (!url || typeof url !== 'string') return null;
  return url
    .replace(/\\"/g, '"')
    .replace(/\\\\u0026/g, '&')
    .replace(/\\u0026/g, '&')
    .replace(/\\\\/g, '')
    .replace(/^http:\/\//i, 'https://');
}

/**
 * 从抖音直播间 SSR HTML 中解析房间状态与流地址：
 * 优先解析内嵌 JSON 对象（支持字段顺序任意变化），回退到转义匹配。
 */
function parseDouyinRoomHtml(html = '') {
  const source = String(html || '');

  // 尝试反转义 SSR payload（常见于 self.__pace_f.push([1,"..."])）
  const unescaped = source
    .replace(/\\"/g, '"')
    .replace(/\\\\u0026/g, '&')
    .replace(/\\u0026/g, '&');

  // 提取 room 块字段（不依赖 id_str / status / title 相对顺序）
  const roomAnchorIdx = unescaped.indexOf('"room":{');
  const roomWindow = roomAnchorIdx >= 0 ? unescaped.slice(roomAnchorIdx, roomAnchorIdx + 12000) : unescaped;

  const statusMatch = roomWindow.match(/"status"\s*:\s*(\d+)/);
  const titleMatch = roomWindow.match(/"title"\s*:\s*"([^"]*)"/);
  const idMatch = roomWindow.match(/"id_str"\s*:\s*"(\d+)"/);

  if (!statusMatch || (!idMatch && !titleMatch)) {
    throw new Error('未能匹配到房间信息，页面结构可能已变更');
  }

  const isLive = statusMatch[1] === '2';
  const title = titleMatch ? titleMatch[1] : '';

  const userMatch = unescaped.match(/"(?:user|owner)"\s*:\s*\{[^{}]*?"nickname"\s*:\s*"([^"]+)"/);
  const hostName = userMatch ? userMatch[1] : '';

  const coverMatch = unescaped.match(/"cover"\s*:\s*\{[^{}]*?"url_list"\s*:\s*\[\s*"([^"]+)"/);
  const cover = coverMatch ? normalizeStreamUrl(coverMatch[1]) : '';

  let m3u8 = null;
  const hlsMatch = unescaped.match(/"hls_pull_url_map"\s*:\s*(\{[^{}]+\})/);
  if (hlsMatch) {
    try {
      const hlsMap = JSON.parse(hlsMatch[1]);
      const candidate = hlsMap.FULL_HD1 || hlsMap.HD1 || Object.values(hlsMap)[0];
      m3u8 = normalizeStreamUrl(candidate);
    } catch {}
  }

  let flv = null;
  const flvMapMatch = unescaped.match(/"flv_pull_url"\s*:\s*(\{[^{}]+\})/);
  if (flvMapMatch) {
    try {
      const flvMap = JSON.parse(flvMapMatch[1]);
      const candidate = flvMap.FULL_HD1 || flvMap.HD1 || Object.values(flvMap)[0];
      flv = normalizeStreamUrl(candidate);
    } catch {}
  }
  if (!flv) {
    const flvSingleMatch = unescaped.match(/"flv"\s*:\s*"([^"]+)"/);
    if (flvSingleMatch) {
      flv = normalizeStreamUrl(flvSingleMatch[1]);
    }
  }

  return { title, roomName: title, hostName, cover, flv, m3u8, streamUrl: flv || m3u8, isLive };
}

class DouyinEngine {
  getHeaders(overrideHeaders = {}) {
    return {
      'User-Agent': config.http.userAgent,
      Cookie: getDouyinCookie(),
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      ...overrideHeaders,
    };
  }

  async _fetchPageData(roomId, options = {}) {
    const res = await http.get(`https://live.douyin.com/${roomId}`, {
      headers: this.getHeaders(options.headers),
      responseType: 'text',
    });
    return parseDouyinRoomHtml(res.data);
  }

  async getInfo(roomId, options = {}) {
    try {
      const { title, hostName, cover, isLive } = await this._fetchPageData(roomId, options);
      return { hostName, roomName: title, isLive, realId: roomId, cover };
    } catch (err) {
      throw new Error(`抖音解析失败: ${err.message}`);
    }
  }

  async getStreamUrls(roomId, options = {}) {
    try {
      const { flv, m3u8, isLive } = await this._fetchPageData(roomId, options);
      if (!isLive) throw new Error('主播已下播');
      const urls = [...new Set([flv, m3u8].filter(Boolean))];
      if (urls.length === 0) throw new Error('未找到可用流地址');
      return urls;
    } catch (err) {
      throw new Error(`抖音解析失败: ${err.message}`);
    }
  }

  async getStreamUrl(roomId, options = {}) {
    const urls = await this.getStreamUrls(roomId, options);
    return urls[0];
  }
}

module.exports = new DouyinEngine();
module.exports.DouyinEngine = DouyinEngine;
module.exports.parseDouyinRoomHtml = parseDouyinRoomHtml;
