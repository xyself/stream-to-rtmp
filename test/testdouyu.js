const axios = require('axios');
const vm = require('node:vm');
const crypto = require('node:crypto');
const CryptoJS = require('crypto-js');
const { exec } = require('child_process');

// ==========================================
// 1. 配置区域
// ==========================================
const TEST_ROOM_ID = '216132'; 
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36';

const ROOM_ID_PATTERNS = [
  /\$ROOM\.room_id\s*=\s*(\d+)/,
  /room_id\s*=\s*(\d+)/,
  /"room_id.?":(\d+)/,
];

function buildHeaders(defaultHeaders = {}, overrideHeaders = {}) {
  return { ...defaultHeaders, ...overrideHeaders };
}

// ==========================================
// 2. 核心引擎类 (DouyuEngine)
// ==========================================
class DouyuEngine {
  constructor() {
    this.agent = DEFAULT_USER_AGENT;
  }


  async fetchRoomID(roomId, requestHeaders) {
    const res = await axios.get(`https://www.douyu.com/${roomId}`, { headers: requestHeaders });
    const body = res.data.toString();
    for (const pattern of ROOM_ID_PATTERNS) {
      const match = body.match(pattern);
      if (match) return match[1];
    }
    return roomId;
  }

  /**
   * 获取所有可用格式和线路
   */
  async getAllFormats(roomId) {
    try {
      const requestHeaders = { 'User-Agent': this.agent };
      const realId = await this.fetchRoomID(roomId, requestHeaders);

      // 1. 签名 environment preparation
      const encRes = await axios.get(`https://www.douyu.com/swf_api/homeH5Enc?rids=${realId}`, { headers: requestHeaders });
      const jsCode = encRes.data.data[`room${realId}`];
      const sandbox = { CryptoJS, navigator: { userAgent: this.agent }, window: {}, document: {} };
      const context = vm.createContext(sandbox);
      vm.runInContext(jsCode, context);

      const did = crypto.randomBytes(16).toString('hex');
      const tt = Math.floor(Date.now() / 1000);
      const signFunc = `ub98484234("${realId}", "${did}", ${tt})`;
      const signQuery = vm.runInContext(signFunc, context);

      const allStreams = [];

      // 2. 获取 FLV 线路 (PC Web 接口)
      console.log('⏳ 正在扫描 PC 端 FLV 线路...');
      const pcApiRes = await axios.post(`https://www.douyu.com/lapi/live/getH5Play/${realId}`, signQuery, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': this.agent, 'Referer': `https://www.douyu.com/${realId}` }
      });

      if (pcApiRes.data.error === 0) {
        const d = pcApiRes.data.data;
        allStreams.push({ protocol: 'FLV', type: 'PC-Web', url: `${d.rtmp_url}/${d.rtmp_live}` });
        // 如果有多线路，可以在这里继续解析 cdn 列表
      }

      // 3. 获取 M3U8 线路 (移动端接口)
      console.log('⏳ 正在扫描移动端 M3U8 线路...');
      const mobileUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
      const h5ApiRes = await axios.post(`https://m.douyu.com/api/room/ratestream`, signQuery, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': mobileUA, 'Referer': `https://m.douyu.com/${realId}` }
      });

      if (h5ApiRes.data.code === 0 && h5ApiRes.data.data) {
        allStreams.push({ protocol: 'M3U8', type: 'Mobile-H5', url: h5ApiRes.data.data.url });
      }

      return allStreams;
    } catch (err) {
      throw new Error(`全格式解析失败: ${err.message}`);
    }
  }
}

// ==========================================
// 3. 测试运行逻辑
// ==========================================
async function runTest() {
  const engine = new DouyuEngine();
  console.log(`\n🚀 开始扫描斗鱼房间 [${TEST_ROOM_ID}] 的所有可用格式...\n`);

  try {
    const streams = await engine.getAllFormats(TEST_ROOM_ID);

    if (streams.length === 0) {
      console.log('❌ 未发现任何可用直播流，主播可能未开播。');
      return;
    }

    console.log('✅ 发现以下可用线路:');
    streams.forEach((s, index) => {
      console.log(`\n[线路 ${index + 1}] 协议: ${s.protocol} | 来源: ${s.type}`);
      console.log(`🔗 地址: ${s.url}`);
    });

    // 默认播放第一条线路 (通常是延迟最低的 FLV)
    const bestStream = streams[0];
    console.log(`\n🚀 自动启动播放器 (默认选择: ${bestStream.protocol})...`);
    
    // 如果是 FLV 加 nobuffer，如果是 M3U8 则不加
    const ffplayFlags = bestStream.protocol === 'FLV' ? '-fflags nobuffer' : '';
    const playCommand = `ffplay ${ffplayFlags} "${bestStream.url}"`;

    exec(playCommand, (error) => {
      if (error) console.error(`🚨 播放失败: ${error.message}`);
    });

  } catch (error) {
    console.error(`🚨 发生错误: ${error.message}`);
  }
}

runTest();