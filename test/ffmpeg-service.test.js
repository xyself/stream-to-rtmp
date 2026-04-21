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
  return {
    pid: 4321,
    stdout: {
      on(name, handler) {
        handlers.stdout[name] = handler;
      },
    },
    stderr: {
      on(name, handler) {
        handlers.stderr[name] = handler;
      },
    },
    once(name, handler) {
      handlers.process[name] = handler;
      return this;
    },
    kill(signal) {
      handlers.killedWith = signal;
    },
    emitSpawn() {
      handlers.process.spawn?.();
    },
    emitClose(code = 0, signal = null) {
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
}

test('ffmpeg service starts multiple independent outputs for multiple RTMP targets and forwards lifecycle callbacks', () => {
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
  child.emitSpawn();
  child.emitStderr('frame=1 fps=1\n');
  child.emitClose(0, null);
  service.stop();

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, 'ffmpeg');
  assert.ok(spawnCalls[0].args.includes('rtmp://target/live/main'));
  assert.ok(spawnCalls[0].args.includes('rtmps://target/live/backup'));
  assert.ok(spawnCalls[0].args.includes('flv'));
  assert.ok(!spawnCalls[0].args.includes('tee'));
  assert.deepEqual(events, [
    ['start', `ffmpeg ${spawnCalls[0].args.join(' ')}`],
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

  await assert.rejects(capturePromise, /ffmpeg 执行失败: Connection refused/);
});

test('ffmpeg service captureFrame maps spawn errors to stream unavailable errors', async () => {
  const child = createChildProcessStub();
  const FFmpegService = loadFFmpegService(() => child);
  const service = new FFmpegService({ roomId: '123', targetUrls: ['rtmp://target/live/main'] });

  const capturePromise = service.captureFrame('https://stream.example/live.flv');
  child.emitError(new Error('spawn ffmpeg ENOENT'));

  await assert.rejects(capturePromise, /流不可用: spawn ffmpeg ENOENT/);
});
