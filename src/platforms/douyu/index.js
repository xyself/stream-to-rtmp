const axios = require('axios');
const vm = require('node:vm');
const crypto = require('node:crypto');
const CryptoJS = require('crypto-js');

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36';

const ROOM_ID_PATTERNS = [
  /\$ROOM\.room_id\s*=\s*(\d+)/,
  /room_id\s*=\s*(\d+)/,
  /"room_id.?":(\d+)/,
  /data-onlineid=(\d+)/,
];

function buildHeaders(defaultHeaders = {}, overrideHeaders = {}) {
  return { ...defaultHeaders, ...overrideHeaders };
}

class DouyuEngine {
  constructor() {
    this.agent = DEFAULT_USER_AGENT;
  }

  async fetchRoomID(roomId, requestHeaders) {
    try {
      const res = await axios.get(`https://www.douyu.com/${roomId}`, { headers: requestHeaders });
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

  async getInfo(roomId, options = {}) {
    const requestHeaders = buildHeaders({ 'User-Agent': this.agent }, options.headers);
    const realId = await this.fetchRoomID(roomId, requestHeaders);

    const res = await axios.get(`https://www.douyu.com/betard/${realId}`, { headers: requestHeaders });
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

      const info = await this.getInfo(roomId, options);
      if (!info.isLive) throw new Error('房间未开播');
      const realId = info.realId;

      const encRes = await axios.get(`https://www.douyu.com/swf_api/homeH5Enc?rids=${realId}`, { headers: requestHeaders });
      const jsCode = encRes.data.data[`room${realId}`];

      const sandbox = {
        CryptoJS,
        navigator: { userAgent: requestHeaders['User-Agent'] || this.agent },
        window: {},
        document: {},
      };
      const context = vm.createContext(sandbox);
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
