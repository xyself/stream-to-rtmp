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
}

module.exports = BaseRoom;
