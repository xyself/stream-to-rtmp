const axios = require('axios');

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const DEFAULT_COOKIE = '__ac_nonce=0658d6780004b23f5d0a8;';

function getDouyinCookie() {
  try {
    const db = require('../../db');
    const dbCookie = db.getSetting?.('douyin_cookie');
    if (dbCookie) return dbCookie;
  } catch {}
  return process.env.DOUYIN_COOKIE || DEFAULT_COOKIE;
}

class DouyinEngine {
  constructor() {
    this.userAgent = DEFAULT_USER_AGENT;
  }

  getHeaders() {
    return {
      'User-Agent': this.userAgent,
      'Cookie': getDouyinCookie(),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    };
  }

  async _fetchPageData(roomId) {
    const res = await axios.get(`https://live.douyin.com/${roomId}`, {
      timeout: 15000,
      headers: this.getHeaders(),
    });
    const html = res.data;

    const roomMatch = html.match(/room\\":{.*?\\"id_str\\":\\"(\d+)\\".*?,\\"status\\":(\d+).*?"title\\":\\"([^"]*)\\"/);
    if (!roomMatch) throw new Error('未能匹配到房间信息，页面结构可能已变更');

    const [, , status, title] = roomMatch;
    
    // 提取主播昵称
    const userMatch = html.match(/user\\":{.*?\\"nickname\\":\\"([^"]+)\\"/);
    const hostName = userMatch ? userMatch[1].replace(/\\\\/g, '') : '';

    // 提取封面图
    const coverMatch = html.match(/cover\\":{.*?\\"url_list\\":\[\\"([^"]+)\\"/);
    const cover = coverMatch ? coverMatch[1].replace(/\\\\u0026/g, '&').replace(/\\u0026/g, '&').replace(/\\\\/g, '') : '';

    const isLive = status === '2';

    let m3u8 = null;
    const m3u8Match = html.match(/hls_pull_url_map\\":(\{.*?\})/);
    if (m3u8Match) {
      const hlsMap = JSON.parse(m3u8Match[1].replace(/\\"/g, '"'));
      m3u8 = (hlsMap.FULL_HD1 || hlsMap.HD1 || Object.values(hlsMap)[0]).replace('http://', 'https://');
    }

    let flv = null;
    const flvMatch = html.match(/flv\\":\\"(.*?)\\"/);
    if (flvMatch) {
      flv = flvMatch[1].replace(/\\"/g, '"').replace(/\\\\u0026/g, '&').replace(/\\u0026/g, '&').replace('http://', 'https://');
    }

    return { title, hostName, cover, flv, m3u8, isLive };
  }

  async getInfo(roomId) {
    try {
      const { title, hostName, cover, isLive } = await this._fetchPageData(roomId);
      return { hostName, roomName: title, isLive, realId: roomId, cover };
    } catch (err) {
      throw new Error(`抖音解析失败: ${err.message}`);
    }
  }

  async getStreamUrl(roomId) {
    try {
      const { flv, m3u8, isLive } = await this._fetchPageData(roomId);
      if (!isLive) throw new Error('主播已下播');
      const url = flv || m3u8;
      if (!url) throw new Error('未找到可用流地址');
      return url;
    } catch (err) {
      throw new Error(`抖音解析失败: ${err.message}`);
    }
  }

  getOptions(roomId) {
    return {
      headers: {
        'User-Agent': this.userAgent,
        'Cookie': getDouyinCookie(),
        'Referer': `https://live.douyin.com/${roomId}`,
      },
    };
  }
}

module.exports = new DouyinEngine();
