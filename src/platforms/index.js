const BilibiliRoom = require('./bilibili/room');
const DouyuRoom = require('./douyu/room');
const DouyinRoom = require('./douyin/room');

const registry = {
  bilibili: BilibiliRoom,
  douyu: DouyuRoom,
  douyin: DouyinRoom,
};

function create(platform, roomId, options = {}) {
  const RoomClass = registry[platform];
  if (!RoomClass) {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  return new RoomClass(roomId, options);
}

module.exports = { create, registry };
