const BaseRoom = require('./base-room');
const douyuEngine = require('../engines/douyu');

class DouyuRoom extends BaseRoom {
  constructor(roomId, options = {}) {
    super({ roomId, engine: douyuEngine, ...options });
    this.platform = 'douyu';
  }
}

module.exports = DouyuRoom;
