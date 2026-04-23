const axios = require('axios');
const { exec } = require('child_process');

// ==========================================
// 1. 配置区域
// ==========================================
const TEST_ROOM_ID = '894220'; // 替换为你想测试的B站房间号

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36';

function buildHeaders(defaultHeaders = {}, overrideHeaders = {}) {
  return { ...defaultHeaders, ...overrideHeaders };
}

// ==========================================
// 2. 核心引擎类
// ==========================================
class BilibiliEngine {
  constructor() {
    this.agent = DEFAULT_USER_AGENT;
  }

  async getRealId(roomId) {
    const url = `https://api.live.bilibili.com/room/v1/Room/room_init?id=${roomId}`;
    const res = await axios.get(url, { headers: { 'User-Agent': this.agent } });
    if (res.data.code !== 0) throw new Error('B站房间不存在或已失效');
    return res.data.data.room_id.toString();
  }

  async getInfo(roomId) {
    const realId = await this.getRealId(roomId);
    const headers = { 'User-Agent': this.agent };
    const roomRes = await axios.get(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${realId}&from=room`, { headers });
    const roomData = roomRes.data.data;
    const userRes = await axios.get(`https://api.live.bilibili.com/live_user/v1/UserInfo/get_anchor_in_room?roomid=${realId}`, { headers });
    
    return {
      hostName: userRes.data.data?.info?.uname || '未知主播',
      roomName: roomData.title || '',
      isLive: roomData.live_status === 1,
      realId
    };
  }

  async getStreamUrls(roomId) {
    const realId = await this.getRealId(roomId);
    const headers = { 'User-Agent': this.agent, Referer: `https://live.bilibili.com/${realId}` };
    const apiUrl = `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${realId}&protocol=0,1&format=0,1,2&codec=0,1&qn=10000&platform=web&ptype=8`;
    const res = await axios.get(apiUrl, { headers });
    const playurl = res.data.data?.playurl_info?.playurl;
    if (!playurl) throw new Error('主播尚未开播');

    let flv = null, m3u8 = null;
    for (const stream of playurl.stream) {
      if (stream.protocol_name === 'http_stream') { // FLV
        const f = stream.format.find(f => f.format_name === 'flv');
        if (f) flv = f.codec[0].url_info[0].host + f.codec[0].base_url + f.codec[0].url_info[0].extra;
      }
      if (stream.protocol_name === 'http_hls') { // M3U8
        const f = stream.format.find(f => f.format_name === 'ts' || f.format_name === 'fmp4');
        if (f) m3u8 = f.codec[0].url_info[0].host + f.codec[0].base_url + f.codec[0].url_info[0].extra;
      }
    }
    return { flv, m3u8 };
  }
}

// ==========================================
// 3. 执行测试
// ==========================================
async function runTest() {
  const engine = new BilibiliEngine();
  try {
    const info = await engine.getInfo(TEST_ROOM_ID);
    console.log(`🚀 Bilibili: ${info.hostName} | ${info.roomName} [${info.isLive ? '直播中' : '未开播'}]`);
    if (!info.isLive) return;

    const urls = await engine.getStreamUrls(TEST_ROOM_ID);
    console.log(`\n🎬 FLV: ${urls.flv}\n🎬 M3U8: ${urls.m3u8}`);

    const playUrl = urls.flv || urls.m3u8;
    const cmd = playUrl.includes('flv') ? `ffplay -fflags nobuffer "${playUrl}"` : `ffplay "${playUrl}"`;
    
    console.log(`\n▶️ 启动播放器: ${cmd}`);
    exec(cmd);
  } catch (err) { console.error(`❌ 错误: ${err.message}`); }
}
runTest();