const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');

const enginesIndexPath = path.resolve(__dirname, '../src/engines/index.js');

test('engine registry returns room resolver for supported platform', () => {
  const originalLoad = Module._load;
  delete require.cache[enginesIndexPath];

  const bilibiliStub = { name: 'bilibili-engine' };
  const douyuStub = { name: 'douyu-engine' };
  const douyinStub = { name: 'douyin-engine' };

  Module._load = function patched(request, parent, isMain) {
    if (request === './bilibili') return bilibiliStub;
    if (request === './douyu') return douyuStub;
    if (request === './douyin') return douyinStub;
    return originalLoad.apply(this, arguments);
  };

  try {
    const registry = require(enginesIndexPath);
    assert.equal(registry.get('bilibili'), bilibiliStub);
    assert.equal(registry.get('douyu'), douyuStub);
    assert.equal(registry.get('douyin'), douyinStub);
    assert.throws(() => registry.get('huya'), /Unsupported platform: huya/);
  } finally {
    Module._load = originalLoad;
  }
});
