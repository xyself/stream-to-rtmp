const axios = require('axios');
const crypto = require('node:crypto');
const Interpreter = require('js-interpreter');

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

function initMd5Func(interpreter, globalObject) {
  const md5Wrapper = function(str) {
    return crypto.createHash('md5').update(str).digest('hex');
  };
  interpreter.setProperty(globalObject, 'md5',
      interpreter.createNativeFunction(md5Wrapper));
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

      // Stage 1: Safely evaluate the script to extract the decrypted ub98484234 function.
      // We replace all instances of "return eval(strc)(...);" with "return strc;}" globally.
      const modifiedCode = jsCode.replace(/return eval\(strc\)\(.*?\)[\s;]*}/g, 'return strc;}');

      const script1 = modifiedCode + `\nub98484234();`;
      const myInterpreter1 = new Interpreter(script1);
      myInterpreter1.run();

      const decrypted = myInterpreter1.value.toString();

      // Stage 2: Execute the decrypted logic with our own md5
      const modifiedDecrypted = decrypted.replace(/CryptoJS\.MD5\((.*?)\)\.toString\(\)/g, 'md5($1)');

      const did = crypto.randomBytes(16).toString('hex');
      const tt = Math.floor(Date.now() / 1000);

      const finalScript = `
        var fn = ${modifiedDecrypted};
        fn("${realId}", "${did}", ${tt});
      `;

      const myInterpreter2 = new Interpreter(finalScript, initMd5Func);
      myInterpreter2.run();
      const signQuery = myInterpreter2.value.toString();

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
