const BilibiliRoom = require('./bilibili-room');
const DouyuRoom = require('./douyu-room');

const registry = {
  bilibili: BilibiliRoom,
  douyu: DouyuRoom,
};

function create(platform, roomId, options = {}) {
  const RoomClass = registry[platform];
  if (!RoomClass) {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  return new RoomClass(roomId, options);
}

module.exports = {
  create,
  registry,
};
