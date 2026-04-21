const BaseRoom = require('../base-room');
const engine = require('./index');

class DouyinRoom extends BaseRoom {
  constructor(roomId, options = {}) {
    super({ roomId, engine, ...options });
    this.platform = 'douyin';
  }
}

module.exports = DouyinRoom;
