const axios = require('axios');

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36';

function buildHeaders(defaultHeaders = {}, overrideHeaders = {}) {
  return {
    ...defaultHeaders,
    ...overrideHeaders,
  };
}

class BilibiliEngine {
  constructor() {
    this.agent = DEFAULT_USER_AGENT;
  }

  /**
   * 对应 Go 中的 parseRealId：处理短号逻辑
   */
  async getRealId(roomId, options = {}) {
    const headers = buildHeaders({ 'User-Agent': this.agent }, options.headers);
    const url = `https://api.live.bilibili.com/room/v1/Room/room_init?id=${roomId}`;
    const res = await axios.get(url, { headers });
    if (res.data.code !== 0) throw new Error('B站房间不存在或已失效');
    return res.data.data.room_id.toString();
  }

  /**
   * 对应 Go 中的 GetStreamInfos 核心逻辑
   */
  async getStreamUrl(roomId, options = {}) {
    try {
      const realId = await this.getRealId(roomId, options);
      const headers = buildHeaders({
        'User-Agent': this.agent,
        Referer: `https://live.bilibili.com/${realId}`,
      }, options.headers);
      // qn=10000(原画), platform=web
      const apiUrl = `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${realId}&protocol=0,1&format=0,1,2&codec=0,1&qn=10000&platform=web&ptype=8`;

      const res = await axios.get(apiUrl, { headers });

      const playurl = res.data.data?.playurl_info?.playurl;
      if (!playurl) throw new Error('主播尚未开播');

      for (const stream of playurl.stream) {
        const flvFormat = stream.format.find((f) => f.format_name === 'flv');
        if (flvFormat) {
          const codec = flvFormat.codec[0];
          const hostInfo = codec.url_info[0];
          return hostInfo.host + codec.base_url + hostInfo.extra;
        }
      }

      const firstCodec = playurl.stream[0].format[0].codec[0];
      return firstCodec.url_info[0].host + firstCodec.base_url + firstCodec.url_info[0].extra;
    } catch (err) {
      throw new Error(`B站解析失败: ${err.message}`);
    }
  }
}

module.exports = new BilibiliEngine();
