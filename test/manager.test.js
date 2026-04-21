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

test('start uses room object and ffmpeg service for process startup', async () => {
  const task = {
    id: 7,
    platform: 'bilibili',
    room_id: '123',
    primary_target_url: 'rtmp://target/live',
    targets: [{ id: 1, target_url: 'rtmp://target/live' }],
  };
  const dbCalls = [];
  const resolveCalls = [];
  const ffmpegStarts = [];

  const room = {
    async getStreamUrl() {
      resolveCalls.push('called');
      return 'https://stream.example/live.flv';
    },
  };

  class FFmpegServiceMock {
    constructor(options) {
      this.options = options;
    }

    start(streamUrl) {
      ffmpegStarts.push({ streamUrl, targets: this.options.targetUrls });
      this.options.onStart('ffmpeg ...');
      return { pid: 1 };
    }

    stop() {}

    getTrafficStats() {
      return {
        sessionBytes: 0,
        bitrateKbps: 0,
        updatedAt: null,
        startedAt: null,
        running: false,
      };
    }
  }

  const StreamManager = loadManager({
    roomFactory: { create: () => room },
    FFmpegServiceClass: FFmpegServiceMock,
    dbMock: {
      updateError(id, value) {
        dbCalls.push([id, value]);
      },
      getTaskTargets() {
        return [{ id: 1, target_url: 'rtmp://target/live' }];
      },
    },
  });

  const manager = new StreamManager(task);
  await manager.start();

  assert.equal(resolveCalls.length, 1);
  assert.deepEqual(ffmpegStarts, [{ streamUrl: 'https://stream.example/live.flv', targets: ['rtmp://target/live'] }]);
  assert.deepEqual(dbCalls, [[7, null]]);
});

test('manager hydrates RTMP targets from db when task payload does not include them', async () => {
  const ffmpegStarts = [];

  class FFmpegServiceMock {
    constructor(options) {
      this.options = options;
    }

    start(streamUrl) {
      ffmpegStarts.push({ streamUrl, targets: this.options.targetUrls });
      return { pid: 9 };
    }

    stop() {}

    getTrafficStats() {
      return {
        sessionBytes: 0,
        bitrateKbps: 0,
        updatedAt: null,
        startedAt: null,
        running: false,
      };
    }
  }

  const StreamManager = loadManager({
    roomFactory: { create: () => ({ getStreamUrl: async () => 'https://stream.example/fallback.flv' }) },
    FFmpegServiceClass: FFmpegServiceMock,
    dbMock: {
      updateError() {},
      getTaskTargets() {
        return [
          { id: 1, target_url: 'rtmp://main/live/fallback' },
          { id: 2, target_url: 'rtmp://backup/live/fallback' },
        ];
      },
    },
  });

  const manager = new StreamManager({
    id: 12,
    platform: 'douyu',
    room_id: '456',
    primary_target_url: 'rtmp://main/live/fallback',
  });

  await manager.start();

  assert.deepEqual(ffmpegStarts, [{
    streamUrl: 'https://stream.example/fallback.flv',
    targets: ['rtmp://main/live/fallback', 'rtmp://backup/live/fallback'],
  }]);
});

test('handleError records failure and schedules retry through retry policy', () => {
  const delays = [];
  const dbCalls = [];
  const originalSetTimeout = global.setTimeout;

  class FFmpegServiceMock {
    stop() {}

    getTrafficStats() {
      return {
        sessionBytes: 0,
        bitrateKbps: 0,
        updatedAt: null,
        startedAt: null,
        running: false,
      };
    }
  }

  const StreamManager = loadManager({
    roomFactory: { create: () => ({ getStreamUrl: async () => 'unused' }) },
    FFmpegServiceClass: FFmpegServiceMock,
    dbMock: {
      updateError(id, value) {
        dbCalls.push([id, value]);
      },
      getTaskTargets() {
        return [];
      },
    },
  });

  global.setTimeout = (fn, delay) => {
    delays.push(delay);
    return { fn, delay };
  };

  try {
    const manager = new StreamManager({ id: 9, platform: 'douyu', room_id: '456', primary_target_url: 'rtmp://out' });
    manager.handleError('boom');
    manager.handleError('boom-again');

    assert.deepEqual(dbCalls, [[9, 'boom'], [9, 'boom-again']]);
    assert.deepEqual(delays, [30000, 40000]);
    assert.equal(manager.retryPolicy.attempts, 2);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test('manager captures snapshot from current stream through ffmpeg service', async () => {
  const captureCalls = [];
  const room = {
    async getStreamUrl() {
      return 'https://stream.example/live.flv';
    },
  };

  class FFmpegServiceMock {
    constructor(options) {
      this.options = options;
    }

    start() {
      return { pid: 1 };
    }

    async captureFrame(streamUrl) {
      captureCalls.push({ streamUrl, headers: this.options.inputHeaders });
      return Buffer.from('jpeg-data');
    }

    stop() {}
  }

  const StreamManager = loadManager({
    roomFactory: { create: () => room },
    FFmpegServiceClass: FFmpegServiceMock,
    dbMock: {
      updateError() {},
      getTaskTargets() {
        return [{ id: 1, target_url: 'rtmp://target/live' }];
      },
    },
  });

  const manager = new StreamManager({
    id: 7,
    platform: 'bilibili',
    room_id: '123',
    targets: [{ id: 1, target_url: 'rtmp://target/live' }],
  });

  const image = await manager.captureSnapshot();

  assert.deepEqual(image, Buffer.from('jpeg-data'));
  assert.deepEqual(captureCalls, [{
    streamUrl: 'https://stream.example/live.flv',
    headers: {
      Referer: 'https://live.bilibili.com/123',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
    },
  }]);
});
