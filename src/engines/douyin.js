const axios = require('axios');

// biliLive-tools 本地服务配置
const BTOOLS_BASE_URL = 'http://127.0.0.1:18110';
const BTOOLS_AUTH_TOKEN = 'Basic YTph';

class DouyinEngine {
  constructor() {
    this.baseUrl = BTOOLS_BASE_URL;
    this.headers = {
      'Authorization': BTOOLS_AUTH_TOKEN,
    };
  }

  /**
   * 构建抖音直播间 URL
   */
  _buildRoomUrl(roomId) {
    return `https://live.douyin.com/${roomId}`;
  }

  /**
   * 获取频道信息（房间ID、主播名、房间名）
   */
  async fetchChannelInfo(roomId) {
    const roomUrl = encodeURIComponent(this._buildRoomUrl(roomId));
    const url = `${this.baseUrl}/bgo/channel-info?url=${roomUrl}`;

    const res = await axios.get(url, {
      headers: this.headers,
      timeout: 15000,
    });

    if (res.status !== 200) {
      throw new Error(`biliLive-tools 请求失败: ${res.status}`);
    }

    const data = res.data;
    if (!data.id) {
      throw new Error('无法获取频道信息');
    }

    return data;
  }

  /**
   * 获取直播状态信息
   */
  async fetchLiveInfo(roomId) {
    const url = `${this.baseUrl}/bgo/live-info?platform=douyin&roomId=${encodeURIComponent(roomId)}`;

    const res = await axios.get(url, {
      headers: this.headers,
      timeout: 15000,
    });

    if (res.status !== 200) {
      throw new Error(`biliLive-tools 请求失败: ${res.status}`);
    }

    return res.data;
  }

  /**
   * 获取直播流地址
   */
  async fetchStreamInfo(roomId) {
    const url = `${this.baseUrl}/bgo/stream-info?platform=douyin&roomId=${encodeURIComponent(roomId)}`;

    const res = await axios.get(url, {
      headers: this.headers,
      timeout: 15000,
    });

    if (res.status !== 200) {
      throw new Error(`biliLive-tools 请求失败: ${res.status}`);
    }

    return res.data;
  }

  /**
   * 获取房间信息：主播名、房间名、开播状态
   */
  async getInfo(roomId) {
    try {
      // 先获取频道信息
      const channelInfo = await this.fetchChannelInfo(roomId);

      // 再获取直播状态
      const liveInfo = await this.fetchLiveInfo(channelInfo.id);

      return {
        hostName: liveInfo.owner || channelInfo.owner || '',
        roomName: liveInfo.title || channelInfo.title || '',
        isLive: liveInfo.living || false,
        realId: channelInfo.id,
      };
    } catch (err) {
      throw new Error(`抖音解析失败: ${err.message}`);
    }
  }

  /**
   * 获取直播流地址
   */
  async getStreamUrl(roomId) {
    try {
      // 先获取频道信息确保房间存在
      const channelInfo = await this.fetchChannelInfo(roomId);

      // 获取直播状态
      const liveInfo = await this.fetchLiveInfo(channelInfo.id);
      if (!liveInfo.living) {
        throw new Error('主播尚未开播');
      }

      // 获取流地址
      const streamInfo = await this.fetchStreamInfo(channelInfo.id);
      if (!streamInfo.stream) {
        throw new Error('未找到流地址');
      }

      return streamInfo.stream;
    } catch (err) {
      throw new Error(`抖音解析失败: ${err.message}`);
    }
  }
}

module.exports = new DouyinEngine();
