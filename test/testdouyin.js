const axios = require('axios');
const { exec } = require('child_process');

// ==========================================
// 1. 配置区域
// ==========================================
const TEST_ROOM_ID = '966274205377'; // 替换为你想测试的抖音房间号

// ==========================================
// 2. 核心解析引擎
// ==========================================
class DouyinRegexEngine {
  constructor() {
    this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    this.http = axios.create({
      timeout: 15000,
      headers: {
        'User-Agent': this.userAgent,
        'Cookie': '__ac_nonce=0658d6780004b23f5d0a8;', 
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      }
    });
  }

  async getStreamUrls(roomId) {
    const url = `https://live.douyin.com/${roomId}`;
    const res = await this.http.get(url);
    const html = res.data;

    const roomMatch = html.match(/room\\":{.*?\\"id_str\\":\\"(\d+)\\".*?,\\"status\\":(\d+).*?"title\\":\\"([^"]*)\\"/);
    if (!roomMatch) throw new Error('未能匹配到房间信息');

    const status = roomMatch[2];
    if (status === '4') throw new Error(`主播已下播`);

    // 提取 M3U8
    let m3u8 = null;
    const m3u8Match = html.match(/hls_pull_url_map\\":(\{.*?\})/);
    if (m3u8Match) {
      const hlsMap = JSON.parse(m3u8Match[1].replace(/\\"/g, '"'));
      m3u8 = (hlsMap.FULL_HD1 || hlsMap.HD1 || Object.values(hlsMap)[0]).replace('http://', 'https://');
    }

    // 提取 FLV
    let flv = null;
    const flvMatch = html.match(/flv\\":\\"(.*?)\\"/);
    if (flvMatch) {
      flv = flvMatch[1].replace(/\\"/g, '"').replace(/\\\\u0026/g, '&').replace(/\\u0026/g, '&').replace('http://', 'https://');
    }

    return { flv, m3u8 };
  }
}

// ==========================================
// 3. 执行测试
// ==========================================
async function runTest() {
  const engine = new DouyinRegexEngine();
  try {
    console.log(`⏳ 正在解析抖音房间: ${TEST_ROOM_ID}`);
    const urls = await engine.getStreamUrls(TEST_ROOM_ID);
    
    console.log(`\n🎬 FLV: ${urls.flv}\n🎬 M3U8: ${urls.m3u8}`);

    const playUrl = urls.flv || urls.m3u8;
    const cmd = playUrl.includes('flv') ? `ffplay -fflags nobuffer "${playUrl}"` : `ffplay "${playUrl}"`;
    
    console.log(`\n▶️ 启动播放器: ${cmd}`);
    exec(cmd);
  } catch (err) { console.error(`❌ 错误: ${err.message}`); }
}
runTest();