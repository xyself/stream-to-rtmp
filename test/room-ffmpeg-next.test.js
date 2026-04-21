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
  const events = {};
  const stub = {
    pid: 999,
    stdout: { on(name, handler) { handlers.stdout[name] = handler; }, setEncoding() {} },
    stderr: { on(name, handler) { handlers.stderr[name] = handler; }, setEncoding() {} },
    once(name, handler) { handlers.process[name] = handler; return this; },
    on(name, handler) { events[name] = handler; return this; },
    kill() {},
    emitSpawn() { handlers.process.spawn?.(); },
    emitClose(code = 0, signal = null) { events.close?.(code, signal); handlers.process.close?.(code, signal); },
    state: handlers,
  };
  // 立即异步触发 close 事件，模拟 ffprobe 快速返回
  setTimeout(() => stub.emitClose(0), 0);
  return stub;
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

test('ffmpeg service applies shared output options and request headers to every RTMP target', async () => {
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

  // 等待 ffprobe 完成（异步 close 事件）
  await new Promise((resolve) => setTimeout(resolve, 50));

  // 过滤出 ffmpeg 调用（排除 ffprobe 调用）
  const ffmpegCalls = spawnCalls.filter((call) => call.command.includes('ffmpeg') && !call.command.includes('ffprobe'));
  assert.ok(ffmpegCalls.length >= 1, `Expected at least 1 ffmpeg call, got ${ffmpegCalls.length}`);

  const ffmpegCall = ffmpegCalls[0];
  assert.ok(ffmpegCall.args.includes('-i'));
  assert.ok(ffmpegCall.args.includes('https://stream.example/live.flv'));
  const joined = ffmpegCall.args.join(' ');
  assert.match(joined, /-headers/);
  assert.match(joined, /Referer: https:\/\/live\.bilibili\.com\/123/);
  assert.match(joined, /User-Agent: UnitTestAgent\/1\.0/);
  assert.match(joined, /-rtmp_live live/);
  assert.ok(ffmpegCall.args.includes('tee'));
  assert.ok(ffmpegCall.args.some((arg) => arg.includes('[f=flv]rtmp://main/live/123|[f=flv]rtmp://backup/live/123')));
});
