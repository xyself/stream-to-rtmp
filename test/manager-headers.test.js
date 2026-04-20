const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');

const managerPath = path.resolve(__dirname, '../src/core/manager.js');

function loadManager({ roomFactory, FFmpegServiceClass, dbMock }) {
  const originalLoad = Module._load;
  delete require.cache[managerPath];

  Module._load = function patched(request, parent, isMain) {
    if (request === '../rooms') return roomFactory;
    if (request === '../services/ffmpeg-service') return FFmpegServiceClass;
    if (request === '../db') return dbMock;
    return originalLoad.apply(this, arguments);
  };

  try {
    return require(managerPath);
  } finally {
    Module._load = originalLoad;
  }
}

test('manager forwards platform headers to room resolver and ffmpeg service', async () => {
  const roomFactoryCalls = [];
  const ffmpegCtorCalls = [];
  const ffmpegStarts = [];
  const updateErrorCalls = [];

  class FFmpegServiceMock {
    constructor(options) {
      ffmpegCtorCalls.push(options);
      this.options = options;
    }

    start(streamUrl) {
      ffmpegStarts.push({ streamUrl, options: this.options });
      this.options.onStart('ffmpeg start');
      return { pid: 77 };
    }

    stop() {}
  }

  const room = {
    async getStreamUrl() {
      return 'https://stream.example/live.flv';
    },
  };

  const StreamManager = loadManager({
    roomFactory: {
      create(platform, roomId, options) {
        roomFactoryCalls.push({ platform, roomId, options });
        return room;
      },
    },
    FFmpegServiceClass: FFmpegServiceMock,
    dbMock: {
      updateError(id, value) {
        updateErrorCalls.push([id, value]);
      },
      getTaskTargets() {
        return [{ id: 1, target_url: 'rtmp://main/live/123' }];
      },
    },
  });

  const task = {
    id: 23,
    platform: 'bilibili',
    room_id: '123',
    headers: {
      Referer: 'https://live.bilibili.com/123',
      'User-Agent': 'ManagerTestAgent/1.0',
    },
    ffmpeg: {
      outputOptions: ['-rtmp_live live'],
    },
  };

  const manager = new StreamManager(task);
  await manager.start();

  assert.deepEqual(roomFactoryCalls, [{
    platform: 'bilibili',
    roomId: '123',
    options: {
      headers: {
        Referer: 'https://live.bilibili.com/123',
        'User-Agent': 'ManagerTestAgent/1.0',
      },
      metadata: { taskId: 23, platform: 'bilibili' },
    },
  }]);

  assert.equal(ffmpegCtorCalls.length, 1);
  assert.deepEqual(ffmpegCtorCalls[0].inputHeaders, {
    Referer: 'https://live.bilibili.com/123',
    'User-Agent': 'ManagerTestAgent/1.0',
  });
  assert.deepEqual(ffmpegCtorCalls[0].globalOutputOptions, ['-rtmp_live live']);
  assert.deepEqual(ffmpegStarts, [{
    streamUrl: 'https://stream.example/live.flv',
    options: ffmpegCtorCalls[0],
  }]);
  assert.deepEqual(updateErrorCalls, [[23, null]]);
});

test('manager builds default platform headers when task does not provide them', async () => {
  const roomFactoryCalls = [];
  const ffmpegCtorCalls = [];

  class FFmpegServiceMock {
    constructor(options) {
      ffmpegCtorCalls.push(options);
    }

    start() {
      return { pid: 1 };
    }

    stop() {}
  }

  const StreamManager = loadManager({
    roomFactory: {
      create(platform, roomId, options) {
        roomFactoryCalls.push({ platform, roomId, options });
        return { getStreamUrl: async () => 'https://stream.example/default.flv' };
      },
    },
    FFmpegServiceClass: FFmpegServiceMock,
    dbMock: {
      updateError() {},
      getTaskTargets() {
        return [{ id: 2, target_url: 'rtmp://main/live/456' }];
      },
    },
  });

  const manager = new StreamManager({
    id: 24,
    platform: 'douyu',
    room_id: '456',
  });

  await manager.start();

  assert.deepEqual(roomFactoryCalls[0], {
    platform: 'douyu',
    roomId: '456',
    options: {
      headers: {
        Referer: 'https://www.douyu.com/456',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
      },
      metadata: { taskId: 24, platform: 'douyu' },
    },
  });

  assert.deepEqual(ffmpegCtorCalls[0].inputHeaders, {
    Referer: 'https://www.douyu.com/456',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
  });
  assert.deepEqual(ffmpegCtorCalls[0].globalOutputOptions, []);
});
