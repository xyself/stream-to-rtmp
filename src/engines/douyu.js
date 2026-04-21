const axios = require('axios');
const vm = require('node:vm');
const crypto = require('node:crypto');

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36';

const CRYPTO_JS_CDNS = [
  'https://cdnjs.cloudflare.com/ajax/libs/crypto-js/3.1.9-1/crypto-js.min.js',
  'https://cdn.jsdelivr.net/npm/crypto-js@3.1.9-1/crypto-js.min.js',
  'https://cdn.staticfile.org/crypto-js/3.1.9-1/crypto-js.min.js',
  'https://cdn.bootcdn.net/ajax/libs/crypto-js/3.1.9-1/crypto-js.min.js',
];

const ROOM_ID_PATTERNS = [
  /\$ROOM\.room_id\s*=\s*(\d+)/,
  /room_id\s*=\s*(\d+)/,
  /"room_id.?":(\d+)/,
  /data-onlineid=(\d+)/,
];

function buildHeaders(defaultHeaders = {}, overrideHeaders = {}) {
  return {
    ...defaultHeaders,
    ...overrideHeaders,
  };
}

let cachedCryptoJS = null;

class DouyuEngine {
  constructor() {
    this.agent = DEFAULT_USER_AGENT;
  }

  async loadCryptoJS() {
    if (cachedCryptoJS) return cachedCryptoJS;
    for (const url of CRYPTO_JS_CDNS) {
      try {
        const res = await axios.get(url, { timeout: 5000 });
        if (res.status === 200 && res.data) {
          cachedCryptoJS = res.data;
          return cachedCryptoJS;
        }
      } catch {}
    }
    throw new Error('无法加载 CryptoJS，请检查网络');
  }

  async fetchRoomID(roomId, requestHeaders) {
    try {
      const res = await axios.get(`https://www.douyu.com/${roomId}`, {
        headers: requestHeaders,
      });
      const body = typeof res.data === 'string' ? res.data : '';
      for (const pattern of ROOM_ID_PATTERNS) {
        const match = body.match(pattern);
        if (match) return match[1];
      }
      if (body.includes('该房间目前没有开放')) throw new Error('房间未开放');
      if (body.includes('房间已被关闭')) throw new Error('房间已被关闭');
    } catch (err) {
      if (err.message === '房间未开放' || err.message === '房间已被关闭') throw err;
    }
    return roomId;
  }

  /**
   * 获取房间信息：主播名、房间名、开播状态
   */
  async getInfo(roomId, options = {}) {
    const requestHeaders = buildHeaders({ 'User-Agent': this.agent }, options.headers);
    const realId = await this.fetchRoomID(roomId, requestHeaders);

    const res = await axios.get(`https://www.douyu.com/betard/${realId}`, {
      headers: requestHeaders,
    });

    const room = res.data?.room || {};
    return {
      hostName: room.owner_name || '',
      roomName: room.room_name || '',
      isLive: room.show_status === 1 && room.videoLoop === 0,
      realId,
    };
  }

  async getStreamUrl(roomId, options = {}) {
    try {
      const requestHeaders = buildHeaders({ 'User-Agent': this.agent }, options.headers);
      const realId = await this.fetchRoomID(roomId, requestHeaders);

      // 1. 获取混淆后的签名 JS 代码
      const encRes = await axios.get(`https://www.douyu.com/swf_api/homeH5Enc?rids=${realId}`, {
        headers: requestHeaders,
      });
      const jsCode = encRes.data.data[`room${realId}`];

      // 2. 构造加密环境
      const cryptoJsCode = await this.loadCryptoJS();

      const sandbox = {
        CryptoJS: null,
        navigator: { userAgent: requestHeaders['User-Agent'] || this.agent },
        window: {},
        document: {},
      };

      const context = vm.createContext(sandbox);
      vm.runInContext(cryptoJsCode, context);
      vm.runInContext(jsCode, context);

      // 生成随机设备 ID 并调用签名函数
      const did = crypto.randomBytes(16).toString('hex');
      const tt = Math.floor(Date.now() / 1000);
      const signFunc = `ub98484234("${realId}", "${did}", ${tt})`;
      const signQuery = vm.runInContext(signFunc, context);

      // 3. 请求 API 获取最终流地址
      const apiRes = await axios.post(`https://www.douyu.com/lapi/live/getH5Play/${realId}`, signQuery, {
        headers: buildHeaders({
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': this.agent,
          Referer: `https://www.douyu.com/${realId}`,
        }, options.headers),
      });

      if (apiRes.data.error !== 0) throw new Error(apiRes.data.msg);

      const { rtmp_url, rtmp_live } = apiRes.data.data;
      return `${rtmp_url}/${rtmp_live}`;
    } catch (err) {
      throw new Error(`斗鱼解析失败: ${err.message}`);
    }
  }
}

module.exports = new DouyuEngine();
