const axios = require('axios');
const vm = require('node:vm');
const crypto = require('node:crypto');

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36';

function buildHeaders(defaultHeaders = {}, overrideHeaders = {}) {
  return {
    ...defaultHeaders,
    ...overrideHeaders,
  };
}

class DouyuEngine {
  constructor() {
    this.agent = DEFAULT_USER_AGENT;
  }

  async getStreamUrl(roomId, options = {}) {
    try {
      const requestHeaders = buildHeaders({ 'User-Agent': this.agent }, options.headers);

      // 1. 获取混淆后的签名 JS 代码
      const encRes = await axios.get(`https://www.douyu.com/swf_api/homeH5Enc?rids=${roomId}`, {
        headers: requestHeaders,
      });
      const jsCode = encRes.data.data[`room${roomId}`];

      // 2. 构造加密环境
      const sandbox = {
        CryptoJS: null,
        navigator: { userAgent: requestHeaders['User-Agent'] || this.agent },
        window: {},
        document: {},
      };

      // 动态加载 CryptoJS 依赖
      const cryptoJsCode = await axios.get('https://cdn.staticfile.org/crypto-js/3.1.9-1/crypto-js.min.js');

      const context = vm.createContext(sandbox);
      vm.runInContext(cryptoJsCode.data, context);
      vm.runInContext(jsCode, context);

      // 生成随机设备 ID 并调用签名函数
      const did = crypto.randomBytes(16).toString('hex');
      const tt = Math.floor(Date.now() / 1000);
      const signFunc = `ub98484234("${roomId}", "${did}", ${tt})`;
      const signQuery = vm.runInContext(signFunc, context);

      // 3. 请求 API 获取最终流地址
      const apiRes = await axios.post(`https://www.douyu.com/lapi/live/getH5Play/${roomId}`, signQuery, {
        headers: buildHeaders({
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': this.agent,
          Referer: `https://www.douyu.com/${roomId}`,
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
