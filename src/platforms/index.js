const BaseRoom = require('./base-room');
const bilibiliEngine = require('./bilibili');
const douyuEngine = require('./douyu');
const douyinEngine = require('./douyin');

const engines = {
  bilibili: bilibiliEngine,
  douyu: douyuEngine,
  douyin: douyinEngine,
};

function create(platform, roomId, options = {}) {
  const engine = engines[platform];
  if (!engine) {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  return new BaseRoom({
    roomId,
    engine,
    platform,
    ...options,
  });
}

module.exports = { create, engines };
