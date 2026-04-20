const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');

const roomFactoryPath = path.resolve(__dirname, '../src/rooms/index.js');
const ffmpegServicePath = path.resolve(__dirname, '../src/services/ffmpeg-service.js');

function loadRoomsWithStubs({ BilibiliRoom, DouyuRoom }) {
  const originalLoad = Module._load;
  delete require.cache[roomFactoryPath];

  Module._load = function patched(request, parent, isMain) {
    if (request === './bilibili-room') return BilibiliRoom;
    if (request === './douyu-room') return DouyuRoom;
    return originalLoad.apply(this, arguments);
  };

  try {
    return require(roomFactoryPath);
  } finally {
    Module._load = originalLoad;
  }
}

function loadFFmpegService(spawnImpl) {
  const originalLoad = Module._load;
  delete require.cache[ffmpegServicePath];

  Module._load = function patched(request, parent, isMain) {
    if (request === 'child_process') return { spawn: spawnImpl };
    return originalLoad.apply(this, arguments);
  };

  try {
    return require(ffmpegServicePath);
  } finally {
    Module._load = originalLoad;
  }
}

function createChildProcessStub() {
  const handlers = { stdout: {}, stderr: {}, process: {} };
  return {
    pid: 999,
    stdout: { on(name, handler) { handlers.stdout[name] = handler; } },
    stderr: { on(name, handler) { handlers.stderr[name] = handler; } },
    once(name, handler) { handlers.process[name] = handler; return this; },
    kill() {},
    emitSpawn() { handlers.process.spawn?.(); },
    state: handlers,
  };
}

test('room factory passes headers and metadata overrides into room instances', async () => {
  class FakeBilibiliRoom {
    constructor(roomId, options = {}) {
      this.roomId = roomId;
      this.options = options;
    }

    async getStreamUrl() {
      return { roomId: this.roomId, options: this.options };
    }
  }

  class FakeDouyuRoom {
    constructor(roomId, options = {}) {
      this.roomId = roomId;
      this.options = options;
    }

    async getStreamUrl() {
      return { roomId: this.roomId, options: this.options };
    }
  }

  const rooms = loadRoomsWithStubs({ BilibiliRoom: FakeBilibiliRoom, DouyuRoom: FakeDouyuRoom });
  const bilibili = rooms.create('bilibili', '1001', {
    headers: { Referer: 'https://live.bilibili.com/1001' },
    metadata: { source: 'task-1' },
  });
  const douyu = rooms.create('douyu', '2002', {
    headers: { Referer: 'https://www.douyu.com/2002' },
    metadata: { source: 'task-2' },
  });

  assert.deepEqual(await bilibili.getStreamUrl(), {
    roomId: '1001',
    options: {
      headers: { Referer: 'https://live.bilibili.com/1001' },
      metadata: { source: 'task-1' },
    },
  });
  assert.deepEqual(await douyu.getStreamUrl(), {
    roomId: '2002',
    options: {
      headers: { Referer: 'https://www.douyu.com/2002' },
      metadata: { source: 'task-2' },
    },
  });
});

test('ffmpeg service applies shared output options and request headers to every RTMP target', () => {
  const spawnCalls = [];
  const child = createChildProcessStub();
  const FFmpegService = loadFFmpegService((command, args, options) => {
    spawnCalls.push({ command, args, options });
    return child;
  });

  const service = new FFmpegService({
    roomId: '123',
    targetUrls: ['rtmp://main/live/123', 'rtmp://backup/live/123'],
    inputHeaders: {
      Referer: 'https://live.bilibili.com/123',
      'User-Agent': 'UnitTestAgent/1.0',
    },
    globalOutputOptions: ['-rtmp_live live'],
  });

  service.start('https://stream.example/live.flv');
  child.emitSpawn();

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, 'ffmpeg');
  assert.ok(spawnCalls[0].args.includes('-i'));
  assert.ok(spawnCalls[0].args.includes('https://stream.example/live.flv'));
  const joined = spawnCalls[0].args.join(' ');
  assert.match(joined, /-headers/);
  assert.match(joined, /Referer: https:\/\/live\.bilibili\.com\/123/);
  assert.match(joined, /User-Agent: UnitTestAgent\/1\.0/);
  assert.match(joined, /-rtmp_live live/);
  assert.ok(spawnCalls[0].args.includes('tee'));
  assert.ok(spawnCalls[0].args.some((arg) => arg.includes('[f=flv]rtmp://main/live/123|[f=flv]rtmp://backup/live/123')));
});
