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

test('manager uses poll policy when room is not live yet', async () => {
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
    roomFactory: {
      create: () => ({
        getStreamUrl: async () => {
          throw new Error('主播尚未开播');
        },
      }),
    },
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
    const manager = new StreamManager({ id: 31, platform: 'bilibili', room_id: '101', primary_target_url: 'rtmp://out' });
    await manager.start();

    assert.deepEqual(dbCalls, [[31, '主播尚未开播']]);
    assert.deepEqual(delays, [30000]);
    assert.equal(manager.retryPolicy.attempts, 0);
    assert.equal(manager.pollPolicy.notLiveAttempts, 1);
    assert.equal(manager.pollPolicy.streamEndedAttempts, 0);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test('manager uses retry policy when ffmpeg exits with error', () => {
  const delays = [];
  const dbCalls = [];
  const originalSetTimeout = global.setTimeout;

  class FFmpegServiceMock {
    constructor(options) {
      this.options = options;
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
    const manager = new StreamManager({ id: 32, platform: 'douyu', room_id: '202', primary_target_url: 'rtmp://out' });
    manager.ffmpeg.options.onError(new Error('ffmpeg crashed'));
    manager.ffmpeg.options.onError(new Error('ffmpeg crashed again'));

    assert.deepEqual(dbCalls, [[32, 'ffmpeg crashed'], [32, 'ffmpeg crashed again']]);
    assert.deepEqual(delays, [30000, 40000]);
    assert.equal(manager.retryPolicy.attempts, 2);
    assert.equal(manager.pollPolicy.notLiveAttempts, 0);
    assert.equal(manager.pollPolicy.streamEndedAttempts, 0);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test('manager returns to poll policy when stream ends normally', () => {
  const delays = [];
  const dbCalls = [];
  const originalSetTimeout = global.setTimeout;

  class FFmpegServiceMock {
    constructor(options) {
      this.options = options;
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
    const manager = new StreamManager({ id: 33, platform: 'douyu', room_id: '303', primary_target_url: 'rtmp://out' });
    manager.retryPolicy.attempts = 2;
    manager.ffmpeg.options.onEnd();

    assert.deepEqual(dbCalls, [[33, 'STREAM_ENDED']]);
    assert.deepEqual(delays, [30000]);
    assert.equal(manager.retryPolicy.attempts, 0);
    assert.equal(manager.pollPolicy.notLiveAttempts, 0);
    assert.equal(manager.pollPolicy.streamEndedAttempts, 1);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test('manager resets both policies after successful ffmpeg start', async () => {
  class FFmpegServiceMock {
    constructor(options) {
      this.options = options;
    }

    start() {
      this.options.onStart();
      return { pid: 404 };
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
    roomFactory: { create: () => ({ getStreamUrl: async () => 'https://stream.example/live.flv' }) },
    FFmpegServiceClass: FFmpegServiceMock,
    dbMock: {
      updateError() {},
      getTaskTargets() {
        return [{ id: 1, target_url: 'rtmp://out' }];
      },
    },
  });

  const manager = new StreamManager({ id: 34, platform: 'bilibili', room_id: '404', primary_target_url: 'rtmp://out' });
  manager.retryPolicy.attempts = 3;
  manager.pollPolicy.notLiveAttempts = 2;
  manager.pollPolicy.streamEndedAttempts = 1;

  await manager.start();

  assert.equal(manager.retryPolicy.attempts, 0);
  assert.equal(manager.pollPolicy.notLiveAttempts, 0);
  assert.equal(manager.pollPolicy.streamEndedAttempts, 0);
});
