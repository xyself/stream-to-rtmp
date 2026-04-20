const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');

const botPath = path.resolve(__dirname, '../src/bot/index.js');

function createGrammyStub() {
  class InlineKeyboard {
    constructor() {
      this.buttons = [];
    }

    text(label, data) {
      this.buttons.push({ label, data });
      return this;
    }

    row() {
      this.buttons.push({ row: true });
      return this;
    }
  }

  class Keyboard {
    constructor() {
      this.buttons = [];
    }

    text(label) {
      this.buttons.push(label);
      return this;
    }

    row() {
      this.buttons.push('|');
      return this;
    }

    resized() {
      return this;
    }
  }

  class Bot {
    constructor(token) {
      this.token = token;
      this.handlers = { command: [], hears: [], callbackQuery: [], on: [] };
      this.middlewares = [];
      this.api = {
        async setMyCommands(commands) {
          this.commands = commands;
        },
      };
    }

    use(middleware) {
      this.middlewares.push(middleware);
    }

    command(name, handler) {
      this.handlers.command.push({ name, handler });
    }

    hears(trigger, handler) {
      this.handlers.hears.push({ trigger, handler });
    }

    callbackQuery(pattern, handler) {
      this.handlers.callbackQuery.push({ pattern, handler });
    }

    on(filter, handler) {
      this.handlers.on.push({ filter, handler });
    }
  }

  return {
    Bot,
    InlineKeyboard,
    Keyboard,
    session: () => 'session-middleware',
  };
}

function loadBot({ dbMock, schedulerMock, viewsMock }) {
  const grammyStub = createGrammyStub();
  const conversationsStub = {
    conversations: () => 'conversation-middleware',
    createConversation: (handler) => ({ name: handler.name, handler }),
  };

  const originalLoad = Module._load;
  delete require.cache[botPath];

  Module._load = function patched(request, parent, isMain) {
    if (request === 'grammy') return grammyStub;
    if (request === '@grammyjs/conversations') return conversationsStub;
    if (request === '../db') return dbMock;
    if (request === '../core/scheduler') return schedulerMock;
    if (request === './views') return viewsMock;
    return originalLoad.apply(this, arguments);
  };

  try {
    const exported = require(botPath);
    return { ...exported, __grammy: grammyStub };
  } finally {
    Module._load = originalLoad;
  }
}

function createConversationScript(steps) {
  let index = 0;
  return {
    async wait() {
      return steps[index++];
    },
    async waitForCallbackQuery() {
      return steps[index++];
    },
    async external(fn) {
      return fn();
    },
  };
}

test('rejects messages from chat ids outside configured private bot chat', async () => {
  const allowedChatId = 'test-private-chat';
  const botModule = loadBot({
    dbMock: {
      addTask() {},
      addTarget() {},
      getAllTasks() { return []; },
      getTaskById() { return null; },
      updateTaskStatus() {},
      deleteTask() {},
    },
    schedulerMock: { isTaskRunning: () => false, getStats: () => ({}) },
    viewsMock: {
      platformLabel: (platform) => platform,
      renderTaskList: () => '',
      renderTaskDetail: () => '',
      renderSystemStatus: () => '',
    },
  });

  const authMiddleware = botModule.createChatGuard(allowedChatId);
  const replies = [];
  const callbackAnswers = [];
  const ctx = {
    chat: { id: 1 },
    answerCallbackQuery: async (payload) => callbackAnswers.push(payload),
    reply: async (text) => replies.push(text),
  };
  let nextCalled = false;

  await authMiddleware(ctx, async () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.deepEqual(callbackAnswers[0], { text: '❌ 未授权会话', show_alert: true });
  assert.match(replies[0], /无权使用这个机器人/);
});

test('allows messages from configured private bot chat id', async () => {
  const allowedChatId = 'test-private-chat';
  const botModule = loadBot({
    dbMock: {
      addTask() {},
      addTarget() {},
      getAllTasks() { return []; },
      getTaskById() { return null; },
      updateTaskStatus() {},
      deleteTask() {},
    },
    schedulerMock: { isTaskRunning: () => false, getStats: () => ({}) },
    viewsMock: {
      platformLabel: (platform) => platform,
      renderTaskList: () => '',
      renderTaskDetail: () => '',
      renderSystemStatus: () => '',
    },
  });

  const authMiddleware = botModule.createChatGuard(allowedChatId);
  let nextCalled = false;

  await authMiddleware({ chat: { id: allowedChatId }, reply: async () => {} }, async () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
});

test('main keyboard exposes 管理面板、房间管理、添加房间和流量查看入口', () => {
  const botModule = loadBot({
    dbMock: {
      addTask() {},
      addTarget() {},
      getAllTasks() { return []; },
      getTaskById() { return null; },
      updateTaskStatus() {},
      deleteTask() {},
    },
    schedulerMock: { isTaskRunning: () => false, getStats: () => ({}) },
    viewsMock: {
      platformLabel: (platform) => platform,
      renderTaskList: () => '',
      renderTaskDetail: () => '',
      renderSystemStatus: () => '',
      renderDashboard: () => '',
      renderRoomList: () => '',
      renderRoomTraffic: () => '',
    },
  });

  const keyboard = botModule.buildMainKeyboard();
  assert.deepEqual(keyboard.buttons, ['📺 管理面板', '🏠 房间管理', '➕ 添加房间', '|', '📈 流量查看']);
});

test('registerBotCommands exposes dashboard room management and traffic commands', async () => {
  const calls = [];
  const botModule = loadBot({
    dbMock: {
      addTask() {},
      addTarget() {},
      getAllTasks() { return []; },
      getTaskById() { return null; },
      updateTaskStatus() {},
      deleteTask() {},
    },
    schedulerMock: { isTaskRunning: () => false, getStats: () => ({}), getTrafficStats: () => [] },
    viewsMock: {
      platformLabel: (platform) => platform,
      renderTaskList: () => '',
      renderTaskDetail: () => '',
      renderSystemStatus: () => '',
      renderDashboard: () => '',
      renderRoomList: () => '',
      renderRoomTraffic: () => '',
    },
  });

  const bot = {
    api: {
      async setMyCommands(commands) {
        calls.push(commands);
      },
    },
  };

  await botModule.registerBotCommands(bot);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].map((item) => item.command), ['start', 'panel', 'rooms', 'addroom', 'traffic']);
});

test('createRelayBot wires panel/room/traffic entry points', () => {
  const botModule = loadBot({
    dbMock: {
      addTask() {},
      addTarget() {},
      getAllTasks() { return []; },
      getTaskById() { return null; },
      updateTaskStatus() {},
      deleteTask() {},
    },
    schedulerMock: { isTaskRunning: () => false, getStats: () => ({}) },
    viewsMock: {
      renderDashboard: () => 'dashboard',
      renderRoomList: () => 'rooms',
      renderRoomTraffic: () => 'traffic',
      renderTaskDetail: () => 'detail',
      platformLabel: (platform) => platform,
    },
  });

  const bot = botModule.createRelayBot('token');

  assert.ok(bot.handlers.command.some(({ name }) => name === 'panel'));
  assert.ok(bot.handlers.command.some(({ name }) => name === 'rooms'));
  assert.ok(bot.handlers.command.some(({ name }) => name === 'addroom'));
  assert.ok(bot.handlers.command.some(({ name }) => name === 'traffic'));
  assert.ok(bot.handlers.callbackQuery.some(({ pattern }) => String(pattern) === '/^manage:(\\d+)/'));
  assert.ok(bot.handlers.callbackQuery.some(({ pattern }) => String(pattern) === '/^refresh:(\\d+)/'));
  assert.ok(bot.handlers.callbackQuery.some(({ pattern }) => String(pattern) === '/^capture:(\\d+)/'));
  assert.ok(bot.handlers.callbackQuery.some(({ pattern }) => String(pattern) === '/^p:(bilibili|douyu)$/'));
  assert.ok(bot.handlers.on.some(({ filter }) => filter === 'message:text'));
  assert.ok(bot.handlers.hears.some((entry) => entry.trigger === '📺 管理面板'));
  assert.ok(bot.handlers.hears.some((entry) => entry.trigger === '🏠 房间管理'));
  assert.ok(bot.handlers.hears.some((entry) => entry.trigger === '➕ 添加房间'));
  assert.ok(bot.handlers.hears.some((entry) => entry.trigger === '📈 流量查看'));
});

test('dashboard, rooms and traffic handlers render the expected entry views', async () => {
  const replies = [];
  const tasks = [
    { id: 7, platform: 'bilibili', room_id: '1001', status: 'ENABLED' },
  ];
  const botModule = loadBot({
    dbMock: {
      addTask() {},
      addTarget() {},
      getAllTasks() { return tasks; },
      getTaskById() { return null; },
      updateTaskStatus() {},
      deleteTask() {},
    },
    schedulerMock: {
      isTaskRunning: () => false,
      getStats: () => ({ totalTasks: 1, enabledTasks: 1, disabledTasks: 0, runningManagers: 1, totalTargets: 2 }),
      getTrafficStats: () => [{
        id: 7,
        platform: 'bilibili',
        room_id: '1001',
        status: 'ENABLED',
        traffic: { totalBytes: 2048, sessionBytes: 1024, bitrateKbps: 1888, updatedAt: '2026-04-19 06:00:00' },
      }],
    },
    viewsMock: {
      platformLabel: (platform) => platform,
      renderTaskList: () => 'legacy-task-list',
      renderTaskDetail: () => '',
      renderSystemStatus: () => 'legacy-status',
      renderDashboard: (stats) => `dashboard:${stats.totalTasks}/${stats.totalTargets}`,
      renderRoomList: (items) => `rooms:${items.length}`,
      renderRoomTraffic: (items) => `traffic:${items.length}`,
    },
  });

  const bot = botModule.createRelayBot('fake-token');
  const panelHandler = bot.handlers.command.find((entry) => entry.name === 'panel').handler;
  const roomsHandler = bot.handlers.command.find((entry) => entry.name === 'rooms').handler;
  const trafficHandler = bot.handlers.command.find((entry) => entry.name === 'traffic').handler;

  const ctx = {
    reply: async (text, extra) => replies.push({ text, extra }),
  };

  await panelHandler(ctx);
  await roomsHandler(ctx);
  await trafficHandler(ctx);

  assert.equal(replies[0].text, 'dashboard:1/2');
  assert.equal(replies[1].text, 'rooms:1');
  assert.equal(replies[2].text, 'traffic:1');
  assert.ok(replies[1].extra.reply_markup);
});

test('add room conversation saves task immediately after first RTMP address', async () => {
  const calls = [];
  const tickCalls = [];
  const replies = [];
  const dbMock = {
    addTask(payload) {
      calls.push(payload);
      return { taskId: 1 };
    },
    addTarget() {},
    getAllTasks() { return []; },
    getTaskById() { return null; },
    updateTaskStatus() {},
    deleteTask() {},
  };

  const botModule = loadBot({
    dbMock,
    schedulerMock: {
      isTaskRunning: () => false,
      getStats: () => ({}),
      tick: async () => { tickCalls.push('tick'); },
    },
    viewsMock: {
      platformLabel: (platform) => platform,
      renderTaskList: () => '',
      renderTaskDetail: () => '',
      renderSystemStatus: () => '',
    },
  });

  const conversation = createConversationScript([
    { message: { text: '1001' } },
    {
      callbackQuery: { data: 'p:bilibili' },
      answerCallbackQuery: async () => {},
    },
    { message: { text: 'rtmp://main/live/1001' } },
  ]);

  const ctx = {
    session: {},
    reply: async (text) => {
      replies.push(text);
    },
  };

  await botModule.addRoomConversation(conversation, ctx);

  assert.deepEqual(calls, [{
    platform: 'bilibili',
    roomId: '1001',
    targetUrl: 'rtmp://main/live/1001',
    extraTargetUrls: [],
  }]);
  assert.deepEqual(tickCalls, ['tick']);
  assert.match(replies.at(-1), /额外 RTMP：0 条/);
  assert.match(replies.at(-1), /\/addrtmp 1001/);
});

test('add room conversation rejects non-numeric room id before asking platform', async () => {
  const replies = [];
  const botModule = loadBot({
    dbMock: {
      addTask() { throw new Error('should not be called'); },
      addTarget() {},
      getAllTasks() { return []; },
      getTaskById() { return null; },
      updateTaskStatus() {},
      deleteTask() {},
    },
    schedulerMock: {
      isTaskRunning: () => false,
      getStats: () => ({}),
      tick: async () => { throw new Error('should not be called'); },
    },
    viewsMock: {
      platformLabel: (platform) => platform,
      renderTaskList: () => '',
      renderTaskDetail: () => '',
      renderSystemStatus: () => '',
    },
  });

  const conversation = createConversationScript([
    { message: { text: 'https://live.bilibili.com/1001' } },
  ]);

  const ctx = {
    session: {},
    reply: async (text) => replies.push(text),
  };

  await botModule.addRoomConversation(conversation, ctx);

  assert.match(replies[0], /纯数字/);
  assert.match(replies.at(-1), /房间 ID 只能填写纯数字/);
});


test('task detail keyboard includes refresh and capture callback actions', () => {
  const botModule = loadBot({
    dbMock: {
      addTask() {},
      addTarget() {},
      getAllTasks() { return []; },
      getTaskById() { return null; },
      updateTaskStatus() {},
      deleteTask() {},
    },
    schedulerMock: { isTaskRunning: () => false, getStats: () => ({}) },
    viewsMock: {
      platformLabel: (platform) => platform,
      renderTaskList: () => '',
      renderTaskDetail: () => '',
      renderSystemStatus: () => '',
    },
  });

  const keyboard = botModule.buildTaskDetailKeyboard({ id: 3, status: 'ENABLED' });
  assert.equal(keyboard.buttons.some((button) => button.data === 'refresh:3'), true);
  assert.equal(keyboard.buttons.some((button) => button.data === 'capture:3'), true);
});

test('task detail keyboard no longer includes add-rtmp callback action', () => {
  const botModule = loadBot({
    dbMock: {
      addTask() {},
      addTarget() {},
      getAllTasks() { return []; },
      getTaskById() { return null; },
      updateTaskStatus() {},
      deleteTask() {},
    },
    schedulerMock: { isTaskRunning: () => false, getStats: () => ({}) },
    viewsMock: {
      platformLabel: (platform) => platform,
      renderTaskList: () => '',
      renderTaskDetail: () => '',
      renderSystemStatus: () => '',
    },
  });

  const keyboard = botModule.buildTaskDetailKeyboard({ id: 3, status: 'ENABLED' });
  assert.equal(keyboard.buttons.some((button) => button.data === 'add_rtmp:3'), false);
});

test('parseExtraTargetUrls supports newline and comma separated input', () => {
  const botModule = loadBot({
    dbMock: {
      addTask() {},
      addTarget() {},
      getAllTasks() { return []; },
      getTaskById() { return null; },
      updateTaskStatus() {},
      deleteTask() {},
    },
    schedulerMock: { isTaskRunning: () => false, getStats: () => ({}) },
    viewsMock: {
      platformLabel: (platform) => platform,
      renderTaskList: () => '',
      renderTaskDetail: () => '',
      renderSystemStatus: () => '',
    },
  });

  assert.deepEqual(
    botModule.parseExtraTargetUrls('rtmp://a\nrtmp://b,rtmp://c，rtmp://d'),
    ['rtmp://a', 'rtmp://b', 'rtmp://c', 'rtmp://d']
  );
});

test('parseExtraTargetUrls also accepts rtmps targets', () => {
  const botModule = loadBot({
    dbMock: {
      addTask() {},
      addTarget() {},
      getAllTasks() { return []; },
      getTaskById() { return null; },
      updateTaskStatus() {},
      deleteTask() {},
    },
    schedulerMock: { isTaskRunning: () => false, getStats: () => ({}) },
    viewsMock: {
      platformLabel: (platform) => platform,
      renderTaskList: () => '',
      renderTaskDetail: () => '',
      renderSystemStatus: () => '',
    },
  });

  assert.deepEqual(
    botModule.parseExtraTargetUrls('rtmps://dc4-1.rtmp.t.me/s/aaa\nrtmp://b'),
    ['rtmps://dc4-1.rtmp.t.me/s/aaa', 'rtmp://b']
  );
});

