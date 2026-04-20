const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');

const mainPath = path.resolve(__dirname, '../main.js');
const packageJson = require('../package.json');

function loadMain({ scheduler, bot }) {
  const originalLoad = Module._load;
  delete require.cache[mainPath];

  Module._load = function patched(request, parent, isMain) {
    if (request === 'dotenv') return { config: () => ({ parsed: {} }) };
    if (request === './src/db') return {};
    if (request === './src/core/scheduler') return scheduler;
    if (request === './src/bot') return bot;
    return originalLoad.apply(this, arguments);
  };

  try {
    return require(mainPath);
  } finally {
    Module._load = originalLoad;
  }
}

test('package manifest points at main.js and exposes start/test scripts', () => {
  assert.equal(packageJson.main, 'main.js');
  assert.equal(packageJson.scripts.start, 'node main.js');
  assert.equal(packageJson.scripts.test, 'node --test test/*.js');
});

test('package manifest exposes docker-friendly start command', () => {
  assert.match(packageJson.description, /Telegram control panel/i);
  assert.equal(packageJson.scripts.start, 'node main.js');
});

test('main module exports createApp and does not auto-bootstrap during require', () => {
  let schedulerStarts = 0;
  let botStarts = 0;

  const mainModule = loadMain({
    scheduler: {
      start() {
        schedulerStarts += 1;
      },
      stopAll() {},
    },
    bot: {
      start() {
        botStarts += 1;
        return Promise.resolve();
      },
      stop() {
        return Promise.resolve();
      },
      isRunning() {
        return false;
      },
    },
  });

  assert.equal(typeof mainModule.createApp, 'function');
  assert.equal(schedulerStarts, 0);
  assert.equal(botStarts, 0);
});

test('bootstrap starts scheduler, registers shutdown handlers, and sends ready after bot startup', async () => {
  let schedulerStarts = 0;
  let startOptions;
  let resolvePolling;
  const registeredSignals = [];
  const sentMessages = [];

  const scheduler = {
    start() {
      schedulerStarts += 1;
    },
    stopAll() {},
  };

  const bot = {
    async registerBotCommands() {},
    start(options) {
      startOptions = options;
      return new Promise((resolve) => {
        resolvePolling = resolve;
      });
    },
    stop() {
      return Promise.resolve();
    },
    isRunning() {
      return true;
    },
  };

  const mainModule = loadMain({ scheduler, bot });
  const app = mainModule.createApp({
    scheduler,
    bot,
    logger: { log() {}, error() {} },
    processRef: {
      on(signal, handler) {
        registeredSignals.push({ signal, handler });
        return this;
      },
      send(message) {
        sentMessages.push(message);
      },
      exit() {},
    },
  });

  const readyPromise = app.bootstrap();

  await Promise.resolve();

  assert.equal(schedulerStarts, 1);
  assert.deepEqual(registeredSignals.map((entry) => entry.signal), ['SIGTERM', 'SIGINT']);
  assert.equal(typeof startOptions?.onStart, 'function');

  await startOptions.onStart({ username: 'relay_test_bot' });
  resolvePolling();
  await readyPromise;

  assert.deepEqual(sentMessages, ['ready']);
});

test('bootstrap continues starting bot when registerBotCommands fails', async () => {
  let schedulerStarts = 0;
  let startOptions;
  let resolvePolling;
  const sentMessages = [];
  const errors = [];
  const exits = [];
  const commandError = new Error('setMyCommands timeout');

  const scheduler = {
    start() {
      schedulerStarts += 1;
    },
    stopAll() {},
  };

  const bot = {
    async registerBotCommands() {
      throw commandError;
    },
    start(options) {
      startOptions = options;
      return new Promise((resolve) => {
        resolvePolling = resolve;
      });
    },
    stop() {
      return Promise.resolve();
    },
    isRunning() {
      return true;
    },
  };

  const mainModule = loadMain({ scheduler, bot });
  const app = mainModule.createApp({
    scheduler,
    bot,
    logger: {
      log() {},
      error(...args) {
        errors.push(args);
      },
      warn(...args) {
        errors.push(args);
      },
    },
    processRef: {
      on() {
        return this;
      },
      send(message) {
        sentMessages.push(message);
      },
      exit(code) {
        exits.push(code);
      },
    },
  });

  const readyPromise = app.bootstrap();

  await Promise.resolve();

  assert.equal(schedulerStarts, 1);
  assert.equal(typeof startOptions?.onStart, 'function');
  assert.deepEqual(exits, []);
  assert.ok(errors.some((entry) => entry.some((value) => String(value).includes('setMyCommands timeout'))));

  await startOptions.onStart({ username: 'relay_test_bot' });
  resolvePolling();
  await readyPromise;

  assert.deepEqual(sentMessages, ['ready']);
  assert.deepEqual(exits, []);
});

test('gracefulShutdown stops scheduler and bot, then exits cleanly', async () => {
  const calls = [];

  const scheduler = {
    start() {},
    stopAll() {
      calls.push('scheduler.stopAll');
    },
  };

  const bot = {
    start() {
      return Promise.resolve();
    },
    async stop() {
      calls.push('bot.stop');
    },
    isRunning() {
      return true;
    },
  };

  const mainModule = loadMain({ scheduler, bot });
  const app = mainModule.createApp({
    scheduler,
    bot,
    logger: { log() {}, error() {} },
    processRef: {
      on() {
        return this;
      },
      send() {},
      exit(code) {
        calls.push(`process.exit:${code}`);
      },
    },
  });

  await app.gracefulShutdown('SIGTERM');

  assert.deepEqual(calls, ['scheduler.stopAll', 'bot.stop', 'process.exit:0']);
});
