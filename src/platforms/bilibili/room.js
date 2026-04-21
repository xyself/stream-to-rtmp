const BaseRoom = require('../base-room');
const engine = require('./index');

class BilibiliRoom extends BaseRoom {
  constructor(roomId, options = {}) {
    super({ roomId, engine, ...options });
    this.platform = 'bilibili';
  }
}

module.exports = BilibiliRoom;
