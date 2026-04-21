const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const ffmpegServicePath = path.resolve(__dirname, 'src/services/ffmpeg-service.js');

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

const spawnCalls = [];
const child = createChildProcessStub();
const FFmpegService = loadFFmpegService((command, args, options) => {
  console.log('Spawn called:', command, args.join(' ').slice(0, 200));
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

console.log('Starting service...');
service.start('https://stream.example/live.flv');
console.log('Spawn calls after start:', spawnCalls.length);

child.emitSpawn();
console.log('Spawn calls after emitSpawn:', spawnCalls.length);

assert.equal(spawnCalls.length, 1, 'Expected 1 spawn call');
console.log('Test passed!');
