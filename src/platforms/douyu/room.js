const BaseRoom = require('../base-room');
const engine = require('./index');

class DouyuRoom extends BaseRoom {
  constructor(roomId, options = {}) {
    super({ roomId, engine, ...options });
    this.platform = 'douyu';
  }
}

module.exports = DouyuRoom;
