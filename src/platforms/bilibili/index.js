const config = require('../../config');
const http = require('../http');

function buildHeaders(defaultHeaders = {}, overrideHeaders = {}) {
  return {
    'User-Agent': config.http.userAgent,
    ...defaultHeaders,
    ...overrideHeaders,
  };
}

function extractBilibiliPlayUrls(playurl) {
  const avcUrls = [];
  const otherUrls = [];
  const seen = new Set();

  const pushTo = (bucket, u) => {
    if (u && !seen.has(u)) {
      seen.add(u);
      bucket.push(u);
    }
  };

  for (const stream of playurl?.stream || []) {
    const flvFormat = (stream.format || []).find((f) => f.format_name === 'flv');
    if (flvFormat) {
      for (const codec of flvFormat.codec || []) {
        const isAvc = codec.codec_name === 'avc' || codec.codec_id === 0;
        const target = isAvc ? avcUrls : otherUrls;
        for (const urlInfo of codec.url_info || []) {
          pushTo(target, urlInfo.host + codec.base_url + urlInfo.extra);
        }
      }
    }
  }

  // 若无 FLV，回退到任意可用格式（同样 AVC 优先）
  if (avcUrls.length === 0 && otherUrls.length === 0) {
    for (const stream of playurl?.stream || []) {
      for (const format of stream.format || []) {
        for (const codec of format.codec || []) {
          const isAvc = codec.codec_name === 'avc' || codec.codec_id === 0;
          const target = isAvc ? avcUrls : otherUrls;
          for (const urlInfo of codec.url_info || []) {
            pushTo(target, urlInfo.host + codec.base_url + urlInfo.extra);
          }
        }
      }
    }
  }

  return [...avcUrls, ...otherUrls];
}

class BilibiliEngine {
  constructor() {
    this._realIdCache = new Map();
    this._hostNameCache = new Map(); // realId -> { hostName, ts }
  }

  async getRealId(roomId, options = {}) {
    const key = String(roomId);
    if (this._realIdCache.has(key)) {
      return this._realIdCache.get(key);
    }
    const headers = buildHeaders({}, options.headers);
    const res = await http.get(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${roomId}`, {
      headers,
      responseType: 'json',
    });
    if (res.data?.code !== 0) throw new Error('B站房间不存在或已失效');
    const realId = String(res.data.data.room_id);
    this._realIdCache.set(key, realId);
    return realId;
  }

  async getInfo(roomId, options = {}) {
    const realId = await this.getRealId(roomId, options);
    const headers = buildHeaders({}, options.headers);

    const roomRes = await http.get(
      `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${realId}&from=room`,
      { headers, responseType: 'json' }
    );
    if (roomRes.data?.code !== 0) throw new Error('B站房间不存在');

    const roomData = roomRes.data.data;
    const isLive = roomData.live_status === 1;
    const roomName = roomData.title || '';
    const cover = isLive
      ? (roomData.keyframe || roomData.user_cover)
      : (roomData.user_cover || roomData.keyframe);

    const cachedHost = this._hostNameCache.get(realId);
    const now = Date.now();
    let hostName = cachedHost?.hostName || '';
    if (!hostName || (isLive && now - (cachedHost?.ts || 0) > 30 * 60 * 1000)) {
      try {
        const userRes = await http.get(
          `https://api.live.bilibili.com/live_user/v1/UserInfo/get_anchor_in_room?roomid=${realId}`,
          { headers, responseType: 'json' }
        );
        if (userRes.data?.code === 0) {
          hostName = userRes.data.data?.info?.uname || '';
          if (hostName) this._hostNameCache.set(realId, { hostName, ts: now });
        }
      } catch {}
    }

    return { hostName, roomName, isLive, realId, cover };
  }

  async getStreamUrls(roomId, options = {}) {
    try {
      const info = await this.getInfo(roomId, options);
      if (!info.isLive) throw new Error('主播尚未开播');
      const realId = info.realId;
      const headers = buildHeaders(
        { Referer: `https://live.bilibili.com/${realId}` },
        options.headers
      );

      const apiUrl = `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${realId}&protocol=0,1&format=0,1,2&codec=0,1&qn=10000&platform=web&ptype=8`;
      const res = await http.get(apiUrl, { headers, responseType: 'json' });

      if (res.data?.code !== 0) {
        throw new Error(`B站接口返回异常 (code=${res.data?.code})：${res.data?.message || '未知错误'}`);
      }

      const playurl = res.data.data?.playurl_info?.playurl;
      if (!playurl) throw new Error('未获取到播放地址（可能暂无可用线路）');

      const urls = extractBilibiliPlayUrls(playurl);
      if (urls.length === 0) throw new Error('未获取到播放地址（可能暂无可用线路）');
      return urls;
    } catch (err) {
      throw new Error(`B站解析失败: ${err.message}`);
    }
  }

  async getStreamUrl(roomId, options = {}) {
    const urls = await this.getStreamUrls(roomId, options);
    return urls[0];
  }
}

module.exports = new BilibiliEngine();
module.exports.BilibiliEngine = BilibiliEngine;
module.exports.extractBilibiliPlayUrls = extractBilibiliPlayUrls;
