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
  return { ...defaultHeaders, ...overrideHeaders };
}

let cachedCryptoJS = null;
let cryptoJSPromise = null; // 在途下载 Promise：多任务并发时只下载一次

// 平台接口统一超时：15 秒，避免某个请求 hang 住拖成僵尸任务
const PLATFORM_TIMEOUT = 15000;

class DouyuEngine {
  constructor() {
    this.agent = DEFAULT_USER_AGENT;
  }

  async loadCryptoJS() {
    if (cachedCryptoJS) return cachedCryptoJS;
    if (!cryptoJSPromise) {
      cryptoJSPromise = (async () => {
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
      })();
      // 失败时清掉，下次调用可重试
      cryptoJSPromise.catch(() => { cryptoJSPromise = null; });
    }
    return cryptoJSPromise;
  }

  async fetchRoomID(roomId, requestHeaders) {
    try {
      const res = await axios.get(`https://www.douyu.com/${roomId}`, { headers: requestHeaders, timeout: PLATFORM_TIMEOUT });
      const body = typeof res.data === 'string' ? res.data : '';
      for (const pattern of ROOM_ID_PATTERNS) {
        const match = body.match(pattern);
        if (match) return match[1];
      }
      if (body.includes('该房间目前没有开放')) throw new Error('房间未开放');
      if (body.includes('房间已被关闭')) throw new Error('房间已被关闭');
    } catch (err) {
      if (err.message === '房间未开放' || err.message === '房间已被关闭') throw err;
      // 网络层错误（无 HTTP 响应）直接抛出中文说明，不再静默回退到原房间号
      if (!err.response) {
        throw new Error(`网络请求失败，请检查网络: ${err.message}`);
      }
    }
    return roomId;
  }

  async getInfo(roomId, options = {}) {
    const requestHeaders = buildHeaders({ 'User-Agent': this.agent }, options.headers);
    const realId = await this.fetchRoomID(roomId, requestHeaders);

    try {
      // 优先使用 Open API 获取更全的信息
      const openRes = await axios.get(`https://open.douyucdn.cn/api/RoomApi/room/${realId}`, { headers: requestHeaders, timeout: PLATFORM_TIMEOUT });
      if (openRes.data?.error === 0) {
        const d = openRes.data.data;
        return {
          hostName: d.owner_name || '',
          roomName: d.room_name || '',
          isLive: d.room_status === '1',
          realId,
          cover: d.room_thumb || d.avatar || '',
        };
      }
    } catch (err) {
      // Open API 失败则尝试 fallback 到 betard
    }

    const res = await axios.get(`https://www.douyu.com/betard/${realId}`, { headers: requestHeaders, timeout: PLATFORM_TIMEOUT });
    const room = res.data?.room || {};
    return {
      hostName: room.owner_name || '',
      roomName: room.room_name || '',
      // 注意：斗鱼 API 现在对正常直播也返回 videoLoop=1，不能再用它判断轮播
      isLive: room.show_status === 1,
      realId,
      cover: room.room_src || '',
    };
  }

  async getStreamUrl(roomId, options = {}) {
    try {
      const requestHeaders = buildHeaders({ 'User-Agent': this.agent }, options.headers);

      const info = await this.getInfo(roomId, options);
      if (!info.isLive) throw new Error('房间未开播');
      const realId = info.realId;

      const encRes = await axios.get(`https://www.douyu.com/swf_api/homeH5Enc?rids=${realId}`, { headers: requestHeaders, timeout: PLATFORM_TIMEOUT });
      const jsCode = encRes.data?.data?.[`room${realId}`];
      if (!jsCode) {
        throw new Error('斗鱼签名脚本获取失败（房间可能不存在，或斗鱼接口已变更）');
      }

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

      const did = crypto.randomBytes(16).toString('hex');
      const tt = Math.floor(Date.now() / 1000);
      const signQuery = vm.runInContext(`ub98484234("${realId}", "${did}", ${tt})`, context);

      const apiRes = await axios.post(`https://www.douyu.com/lapi/live/getH5Play/${realId}`, signQuery, {
        headers: buildHeaders({
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': this.agent,
          Referer: `https://www.douyu.com/${realId}`,
        }, options.headers),
        timeout: PLATFORM_TIMEOUT,
      });

      if (apiRes.data.error !== 0) {
        const msg = apiRes.data.msg || '未知错误';
        // 限流类错误带上"限流"关键词：manager 会识别并走退避重试，而非固定轮询
        if (/限流|rate.?limit|频繁/i.test(msg)) throw new Error(`触发平台限流: ${msg}`);
        throw new Error(msg);
      }
      const { rtmp_url, rtmp_live } = apiRes.data.data;
      return `${rtmp_url}/${rtmp_live}`;
    } catch (err) {
      throw new Error(`斗鱼解析失败: ${err.message}`);
    }
  }

  getOptions(roomId) {
    return {
      headers: {
        'User-Agent': this.agent,
        'Referer': `https://www.douyu.com/${roomId}`,
      },
    };
  }
}

module.exports = new DouyuEngine();
