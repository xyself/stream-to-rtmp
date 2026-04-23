const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');

const ffmpegServicePath = path.resolve(__dirname, '../src/services/ffmpeg-service.js');

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
    pid: 4321,
    stdout: {
      on(name, handler) {
        handlers.stdout[name] = handler;
      },
      setEncoding() {},
    },
    stderr: {
      on(name, handler) {
        handlers.stderr[name] = handler;
      },
      setEncoding() {},
    },
    once(name, handler) {
      handlers.process[name] = handler;
      return this;
    },
    on(name, handler) {
      if(!events[name]) events[name] = []; events[name].push(handler);
      return this;
    },
    kill(signal) {
      handlers.killedWith = signal;
    },
    emitSpawn() {
      handlers.process.spawn?.();
    },
    emitClose(code = 0, signal = null) {
      events.close?.(code, signal);
      handlers.process.close?.(code, signal);
    },
    emitError(error) {
      handlers.process.error?.(error);
    },
    emitStderr(message) {
      handlers.stderr.data?.(Buffer.from(message));
    },
    emitStdout(message) {
      handlers.stdout.data?.(Buffer.isBuffer(message) ? message : Buffer.from(message));
    },
    state: handlers,
  };
  // 立即异步触发 close 事件，模拟 ffprobe 快速返回
  setTimeout(() => stub.emitClose(0), 0);
  return stub;
}

test('ffmpeg service starts tee output for multiple RTMP targets and forwards lifecycle callbacks', async () => {
  const events = [];
  const spawnCalls = [];
  const child = createChildProcessStub();

  const FFmpegService = loadFFmpegService((command, args, options) => {
    spawnCalls.push({ command, args, options });
    return child;
  });

  const service = new FFmpegService({
    roomId: '123',
    targetUrls: ['rtmp://target/live/main', 'rtmps://target/live/backup'],
    onStart(commandLine) {
      events.push(['start', commandLine]);
    },
    onProgress(progress) {
      events.push(['progress', progress.type, progress.message.trim()]);
    },
    onError(error) {
      events.push(['error', error.message]);
    },
    onEnd() {
      events.push(['end']);
    },
  });

  service.start('https://stream.example/live.flv');

  // 等待 ffprobe 完成，然后触发 ffmpeg 事件
  await new Promise((resolve) => setTimeout(resolve, 50));

  child.emitSpawn();
  child.emitStderr('frame=1 fps=1\n');
  child.emitClose(0, null);
  setTimeout(() => {}, 50);
  setTimeout(() => {}, 50);
  setTimeout(() => {}, 50); // allow async events to resolve
  service.stop();

  // 过滤出 ffmpeg 调用（排除 ffprobe）
  const ffmpegCalls = spawnCalls.filter((call) => call.command.includes('ffmpeg') && !call.command.includes('ffprobe'));
  assert.ok(ffmpegCalls.length >= 1, `Expected at least 1 ffmpeg call, got ${ffmpegCalls.length}`);

  const ffmpegCall = ffmpegCalls[0];
  assert.ok(ffmpegCall.args.includes('-f'));
  assert.ok(ffmpegCall.args.includes('tee'));
  assert.ok(ffmpegCall.args.some((arg) => arg.includes('[f=flv]rtmp://target/live/main|[f=flv]rtmps://target/live/backup')));
  assert.deepEqual(events, [
    ['start', `ffmpeg ${ffmpegCall.args.join(' ')}`],
    ['progress', 'stderr', 'frame=1 fps=1'],
    ['end'],
  ]);
  assert.equal(child.state.killedWith, undefined);
});

test('ffmpeg service kills spawned process with SIGINT on stop', () => {
  const child = createChildProcessStub();
  const FFmpegService = loadFFmpegService(() => child);

  const service = new FFmpegService({
    roomId: '123',
    targetUrls: ['rtmp://target/live/main'],
  });

  service.start('https://stream.example/live.flv');
  service.stop();

  assert.equal(child.state.killedWith, 'SIGINT');
});

test('ffmpeg service captures one jpeg frame into memory with request headers', async () => {
  const spawnCalls = [];
  const child = createChildProcessStub();
  const FFmpegService = loadFFmpegService((command, args, options) => {
    spawnCalls.push({ command, args, options });
    return child;
  });

  const service = new FFmpegService({
    roomId: '123',
    targetUrls: ['rtmp://target/live/main'],
    inputHeaders: {
      Referer: 'https://live.bilibili.com/123',
      'User-Agent': 'test-agent',
    },
  });

  const capturePromise = service.captureFrame('https://stream.example/live.flv');
  child.emitStdout(Buffer.from([0xff, 0xd8, 0xff, 0xdb]));
  child.emitClose(0, null);

  const image = await capturePromise;
  assert.deepEqual(image, Buffer.from([0xff, 0xd8, 0xff, 0xdb]));
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, 'ffmpeg');
  assert.deepEqual(spawnCalls[0].options, { stdio: ['ignore', 'pipe', 'pipe'] });
  assert.ok(spawnCalls[0].args.includes('-headers'));
  assert.ok(spawnCalls[0].args.includes('Referer: https://live.bilibili.com/123\r\nUser-Agent: test-agent'));
  assert.deepEqual(spawnCalls[0].args.slice(-7), [
    '-frames:v', '1',
    '-f', 'image2',
    '-vcodec', 'mjpeg',
    'pipe:1',
  ]);
});

test('ffmpeg service captureFrame throws when no frame bytes are produced', async () => {
  const child = createChildProcessStub();
  const FFmpegService = loadFFmpegService(() => child);
  const service = new FFmpegService({ roomId: '123', targetUrls: ['rtmp://target/live/main'] });

  const capturePromise = service.captureFrame('https://stream.example/live.flv');
  child.emitClose(0, null);

  await assert.rejects(capturePromise, /未获取到有效帧/);
});

test('ffmpeg service captureFrame reports non-zero ffmpeg exit codes with stderr context', async () => {
  const child = createChildProcessStub();
  const FFmpegService = loadFFmpegService(() => child);
  const service = new FFmpegService({ roomId: '123', targetUrls: ['rtmp://target/live/main'] });

  const capturePromise = service.captureFrame('https://stream.example/live.flv');
  child.emitStderr('Connection refused');
  child.emitClose(1, null);
  setTimeout(() => {}, 50);

  await assert.rejects(capturePromise, /ffmpeg 执行失败: Connection refused/);
});

test('ffmpeg service captureFrame maps spawn errors to stream unavailable errors', async () => {
  const child = createChildProcessStub();
  const FFmpegService = loadFFmpegService(() => child);
  const service = new FFmpegService({ roomId: '123', targetUrls: ['rtmp://target/live/main'] });

  const capturePromise = service.captureFrame('https://stream.example/live.flv');
  child.emitError(new Error('spawn ffmpeg ENOENT'));
  setTimeout(() => {}, 50);

  await assert.rejects(capturePromise, /流不可用: spawn ffmpeg ENOENT/);
});
