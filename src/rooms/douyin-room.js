const BaseRoom = require('./base-room');
const douyinEngine = require('../engines/douyin');

class DouyinRoom extends BaseRoom {
  constructor(roomId, options = {}) {
    super({ roomId, engine: douyinEngine, ...options });
    this.platform = 'douyin';
  }
}

module.exports = DouyinRoom;
