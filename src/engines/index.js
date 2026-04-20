const bilibili = require('./bilibili');
const douyu = require('./douyu');

const registry = {
  bilibili,
  douyu,
};

function get(platform) {
  const engine = registry[platform];
  if (!engine) {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  return engine;
}

module.exports = {
  get,
  registry,
};
