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
    stdout: { on(name, handler) { 
      console.log('stdout.on:', name);
      handlers.stdout[name] = handler; 
    }},
    stderr: { on(name, handler) { 
      console.log('stderr.on:', name);
      handlers.stderr[name] = handler; 
    }},
    once(name, handler) { 
      console.log('process.once:', name);
      handlers.process[name] = handler; 
      return this; 
    },
    kill() { console.log('kill called'); },
    emitSpawn() { 
      console.log('emitSpawn called');
      handlers.process.spawn?.(); 
    },
    state: handlers,
  };
}

const spawnCalls = [];
const child = createChildProcessStub();
const FFmpegService = loadFFmpegService((command, args, options) => {
  console.log('Spawn called:', command);
  console.log('Args:', JSON.stringify(args, null, 2));
  spawnCalls.push({ command, args, options });
  return child;
});

const service = new FFmpegService({
  roomId: '123',
  targetUrls: ['rtmp://main/live/123'],
  inputHeaders: {},
});

console.log('\n=== Starting service with single target ===');
service.start('https://stream.example/live.flv');
console.log('Spawn calls after start:', spawnCalls.length);

// 重置测试多输出
const spawnCalls2 = [];
const child2 = createChildProcessStub();
const FFmpegService2 = loadFFmpegService((command, args, options) => {
  console.log('\n=== Spawn called for multi-target ===');
  console.log('Command:', command);
  console.log('Args:', JSON.stringify(args, null, 2));
  spawnCalls2.push({ command, args, options });
  return child2;
});

const service2 = new FFmpegService2({
  roomId: '123',
  targetUrls: ['rtmp://main/live/123', 'rtmp://backup/live/123'],
  inputHeaders: {},
});

console.log('\n=== Starting service with multi target ===');
service2.start('https://stream.example/live.flv');
console.log('Spawn calls after start:', spawnCalls2.length);
