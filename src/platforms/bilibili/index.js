const axios = require('axios');

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36';

function buildHeaders(defaultHeaders = {}, overrideHeaders = {}) {
  return { ...defaultHeaders, ...overrideHeaders };
}

// 平台接口统一超时：15 秒，避免某个请求 hang 住拖成僵尸任务
const PLATFORM_TIMEOUT = 15000;

class BilibiliEngine {
  constructor() {
    this.agent = DEFAULT_USER_AGENT;
  }

  async getRealId(roomId, options = {}) {
    const headers = buildHeaders({ 'User-Agent': this.agent }, options.headers);
    const res = await axios.get(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${roomId}`, { headers, timeout: PLATFORM_TIMEOUT });
    if (res.data.code !== 0) throw new Error('B站房间不存在或已失效');
    return res.data.data.room_id.toString();
  }

  async getInfo(roomId, options = {}) {
    const realId = await this.getRealId(roomId, options);
    const headers = buildHeaders({ 'User-Agent': this.agent }, options.headers);

    const roomRes = await axios.get(
      `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${realId}&from=room`,
      { headers, timeout: PLATFORM_TIMEOUT }
    );
    if (roomRes.data.code !== 0) throw new Error('B站房间不存在');

    const roomData = roomRes.data.data;
    const isLive = roomData.live_status === 1;
    const roomName = roomData.title || '';
    const cover = isLive ? (roomData.keyframe || roomData.user_cover) : (roomData.user_cover || roomData.keyframe);

    let hostName = '';
    try {
      const userRes = await axios.get(
        `https://api.live.bilibili.com/live_user/v1/UserInfo/get_anchor_in_room?roomid=${realId}`,
        { headers, timeout: PLATFORM_TIMEOUT }
      );
      if (userRes.data.code === 0) {
        hostName = userRes.data.data?.info?.uname || '';
      }
    } catch {}

    return { hostName, roomName, isLive, realId, cover };
  }

  async getStreamUrl(roomId, options = {}) {
    try {
      const info = await this.getInfo(roomId, options);
      if (!info.isLive) throw new Error('主播尚未开播');
      const realId = info.realId;
      const headers = buildHeaders({
        'User-Agent': this.agent,
        Referer: `https://live.bilibili.com/${realId}`,
      }, options.headers);

      const apiUrl = `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${realId}&protocol=0,1&format=0,1,2&codec=0,1&qn=10000&platform=web&ptype=8`;
      const res = await axios.get(apiUrl, { headers, timeout: PLATFORM_TIMEOUT });

      // 先查返回码：B站风控（-352/-412 等）时 data 为空，
      // 不查码会走到"未开播"分支，把"被限流"误报成"主播下播"
      if (res.data.code !== 0) {
        throw new Error(`B站接口返回异常 (code=${res.data.code})：${res.data.message || '未知错误'}`);
      }

      const playurl = res.data.data?.playurl_info?.playurl;
      if (!playurl) throw new Error('未获取到播放地址（可能暂无可用线路）');

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

  getOptions(roomId) {
    return {
      headers: {
        'User-Agent': this.agent,
        'Referer': `https://live.bilibili.com/${roomId}`,
      },
    };
  }
}

module.exports = new BilibiliEngine();
