const BaseRoom = require('./base-room');
const bilibiliEngine = require('../engines/bilibili');

class BilibiliRoom extends BaseRoom {
  constructor(roomId, options = {}) {
    super({ roomId, engine: bilibiliEngine, ...options });
    this.platform = 'bilibili';
  }
}

module.exports = BilibiliRoom;
