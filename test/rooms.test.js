const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');

const roomFactoryPath = path.resolve(__dirname, '../src/rooms/index.js');

test('room factory returns wrapped room instance for supported platform', async () => {
  const originalLoad = Module._load;
  delete require.cache[roomFactoryPath];

  class FakeBilibiliRoom {
    constructor(roomId) {
      this.roomId = roomId;
    }
    async getStreamUrl() {
      return `bilibili:${this.roomId}`;
    }
  }

  class FakeDouyuRoom {
    constructor(roomId) {
      this.roomId = roomId;
    }
    async getStreamUrl() {
      return `douyu:${this.roomId}`;
    }
  }

  Module._load = function patched(request, parent, isMain) {
    if (request === './bilibili-room') return FakeBilibiliRoom;
    if (request === './douyu-room') return FakeDouyuRoom;
    return originalLoad.apply(this, arguments);
  };

  try {
    const rooms = require(roomFactoryPath);
    const bilibili = rooms.create('bilibili', '1001');
    const douyu = rooms.create('douyu', '2002');

    assert.equal(await bilibili.getStreamUrl(), 'bilibili:1001');
    assert.equal(await douyu.getStreamUrl(), 'douyu:2002');
    assert.throws(() => rooms.create('huya', '3003'), /Unsupported platform: huya/);
  } finally {
    Module._load = originalLoad;
  }
});
