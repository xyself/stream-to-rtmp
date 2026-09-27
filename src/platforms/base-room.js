class BaseRoom {
  constructor({ roomId, engine, headers = {}, metadata = {} }) {
    if (!roomId) throw new Error('roomId is required');
    if (!engine || typeof engine.getStreamUrl !== 'function') {
      throw new Error('engine.getStreamUrl is required');
    }

    this.roomId = roomId;
    this.engine = engine;
    this.headers = headers;
    this.metadata = metadata;
  }

  async getStreamUrl() {
    return this.engine.getStreamUrl(this.roomId, {
      headers: this.headers,
      metadata: this.metadata,
    });
  }

  // 返回全部可用源流线路（主线路在前）；引擎没实现时退化为单线路
  async getStreamUrls() {
    if (typeof this.engine.getStreamUrls === 'function') {
      return this.engine.getStreamUrls(this.roomId, {
        headers: this.headers,
        metadata: this.metadata,
      });
    }
    return [await this.getStreamUrl()];
  }

  async getInfo() {
    if (typeof this.engine.getInfo !== 'function') {
      return { hostName: '', roomName: '', isLive: false };
    }
    return this.engine.getInfo(this.roomId, {
      headers: this.headers,
      metadata: this.metadata,
    });
  }
}

module.exports = BaseRoom;
