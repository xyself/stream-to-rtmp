const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const config = require('../../config');
const http = require('../http');

const LOCAL_CRYPTO_JS_PATH = path.join(__dirname, 'crypto-js.min.js');

const ROOM_ID_PATTERNS = [
  /\$ROOM\.room_id\s*=\s*(\d+)/,
  /room_id\s*=\s*(\d+)/,
  /"room_id.?":(\d+)/,
  /data-onlineid=(\d+)/,
];

function buildHeaders(defaultHeaders = {}, overrideHeaders = {}) {
  return {
    'User-Agent': config.http.userAgent,
    ...defaultHeaders,
    ...overrideHeaders,
  };
}

let cachedCryptoJS = null;
let cachedDid = null;

function loadBundledCryptoJS() {
  if (cachedCryptoJS) return cachedCryptoJS;
  cachedCryptoJS = fs.readFileSync(LOCAL_CRYPTO_JS_PATH, 'utf8');
  return cachedCryptoJS;
}

function getDouyuDid() {
  if (cachedDid) return cachedDid;
  try {
    const db = require('../../db');
    cachedDid = db.getSetting?.('douyu_did');
    if (!cachedDid) {
      cachedDid = crypto.randomBytes(16).toString('hex');
      db.setSetting?.('douyu_did', cachedDid);
    }
  } catch {
    cachedDid = crypto.randomBytes(16).toString('hex');
  }
  return cachedDid;
}

class DouyuEngine {
  constructor() {
    this._realIdCache = new Map();
  }

  async fetchRoomID(roomId, requestHeaders) {
    const key = String(roomId);
    if (this._realIdCache.has(key)) {
      return this._realIdCache.get(key);
    }
    try {
      const res = await http.get(`https://www.douyu.com/${roomId}`, {
        headers: requestHeaders,
        responseType: 'text',
      });
      const body = typeof res.data === 'string' ? res.data : '';
      for (const pattern of ROOM_ID_PATTERNS) {
        const match = body.match(pattern);
        if (match) {
          this._realIdCache.set(key, match[1]);
          return match[1];
        }
      }
      if (body.includes('该房间目前没有开放')) throw new Error('房间未开放');
      if (body.includes('房间已被关闭')) throw new Error('房间已被关闭');
    } catch (err) {
      if (err.message === '房间未开放' || err.message === '房间已被关闭') throw err;
      if (!err.response) {
        throw new Error(`网络请求失败，请检查网络: ${err.message}`);
      }
    }
    this._realIdCache.set(key, key);
    return key;
  }

  async getInfo(roomId, options = {}) {
    const requestHeaders = buildHeaders({}, options.headers);
    const realId = await this.fetchRoomID(roomId, requestHeaders);

    try {
      const openRes = await http.get(`https://open.douyucdn.cn/api/RoomApi/room/${realId}`, {
        headers: requestHeaders,
        responseType: 'json',
      });
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
    } catch {}

    const res = await http.get(`https://www.douyu.com/betard/${realId}`, {
      headers: requestHeaders,
      responseType: 'json',
    });
    const room = res.data?.room || {};
    return {
      hostName: room.owner_name || '',
      roomName: room.room_name || '',
      isLive: room.show_status === 1,
      realId,
      cover: room.room_src || '',
    };
  }

  async getStreamUrl(roomId, options = {}) {
    try {
      const requestHeaders = buildHeaders({}, options.headers);
      const info = await this.getInfo(roomId, options);
      if (!info.isLive) throw new Error('房间未开播');
      const realId = info.realId;

      const encRes = await http.get(`https://www.douyu.com/swf_api/homeH5Enc?rids=${realId}`, {
        headers: requestHeaders,
        responseType: 'json',
      });
      const jsCode = encRes.data?.data?.[`room${realId}`];
      if (!jsCode) {
        throw new Error('斗鱼签名脚本获取失败（房间可能不存在，或斗鱼接口已变更）');
      }

      const cryptoJsCode = loadBundledCryptoJS();
      const sandbox = {
        CryptoJS: null,
        navigator: { userAgent: requestHeaders['User-Agent'] },
        window: {},
        document: {},
      };
      const context = vm.createContext(sandbox);
      vm.runInContext(cryptoJsCode, context, { timeout: 2000 });
      vm.runInContext(jsCode, context, { timeout: 2000 });

      const did = getDouyuDid();
      const tt = Math.floor(Date.now() / 1000);
      const signQuery = vm.runInContext(`ub98484234("${realId}", "${did}", ${tt})`, context, { timeout: 2000 });

      const apiRes = await http.post(`https://www.douyu.com/lapi/live/getH5Play/${realId}`, signQuery, {
        headers: buildHeaders(
          {
            'Content-Type': 'application/x-www-form-urlencoded',
            Referer: `https://www.douyu.com/${realId}`,
          },
          options.headers
        ),
        responseType: 'json',
      });

      if (apiRes.data?.error !== 0) {
        const msg = apiRes.data?.msg || '未知错误';
        if (/限流|rate.?limit|频繁/i.test(msg)) throw new Error(`触发平台限流: ${msg}`);
        throw new Error(msg);
      }
      const { rtmp_url, rtmp_live } = apiRes.data.data;
      return `${rtmp_url}/${rtmp_live}`;
    } catch (err) {
      throw new Error(`斗鱼解析失败: ${err.message}`);
    }
  }
}

module.exports = new DouyuEngine();
module.exports.DouyuEngine = DouyuEngine;
