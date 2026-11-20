const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const db = require('../src/db');
const config = require('../src/config');
const scheduler = require('../src/core/scheduler');
const { Scheduler } = require('../src/core/scheduler');
const StreamManager = require('../src/core/manager');
const FFmpegService = require('../src/services/ffmpeg-service');
const roomHandlers = require('../src/bot/handlers/room');
const rtmpHandlers = require('../src/bot/handlers/rtmp');
const botModule = require('../src/bot/index');
const platforms = require('../src/platforms');

test('Bug #1: /startall and /stopall call enableAllTasks/disableAllTasks and never permanently lock scheduler', async () => {
  const bot = botModule.createRelayBot('123456:TEST_TOKEN');
  assert.equal(bot.isConfigured, true);

  const origEnable = db.enableAllTasks;
  const origDisable = db.disableAllTasks;
  const origTick = scheduler.tick;
  const origStart = scheduler.start;
  const origStopAll = scheduler.stopAll;
  const origStopped = scheduler._stopped;
  const origAllowed = process.env.TG_CHAT_ID;

  let enabledCalled = 0;
  let disabledCalled = 0;
  let tickCalled = 0;
  let startCalled = 0;
  let stopAllCalled = 0;

  process.env.TG_CHAT_ID = '999';
  db.enableAllTasks = () => { enabledCalled += 1; };
  db.disableAllTasks = () => { disabledCalled += 1; };
  scheduler.tick = async () => { tickCalled += 1; };
  scheduler.start = () => {
    startCalled += 1;
    scheduler._stopped = false;
  };
  scheduler.stopAll = async () => {
    stopAllCalled += 1;
    scheduler._stopped = true;
  };
  scheduler._stopped = false;

  const sent = [];
  const fakeBot = botModule.createRelayBot('123456:TEST_TOKEN');
  fakeBot.botInfo = { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' };
  fakeBot.api.config.use(async (prev, method, payload) => {
    sent.push({ method, payload });
    return { ok: true, result: { message_id: sent.length, chat: { id: 999, type: 'private' }, date: 1, text: payload?.text || '' } };
  });

  try {
    await fakeBot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 10,
        date: 1700000000,
        chat: { id: 999, type: 'private' },
        from: { id: 999, is_bot: false, first_name: 'Tester' },
        text: '/stopall',
        entities: [{ offset: 0, length: 8, type: 'bot_command' }],
      },
    });
    assert.equal(disabledCalled, 1);
    assert.equal(tickCalled, 1);
    assert.equal(stopAllCalled, 0, '/stopall must NOT call stopAll() which kills polling timer');
    assert.equal(scheduler._stopped, false);

    // If scheduler happened to be stopped before /startall, /startall must restart it
    scheduler._stopped = true;
    await fakeBot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 11,
        date: 1700000001,
        chat: { id: 999, type: 'private' },
        from: { id: 999, is_bot: false, first_name: 'Tester' },
        text: '/startall',
        entities: [{ offset: 0, length: 9, type: 'bot_command' }],
      },
    });
    assert.equal(enabledCalled, 1);
    assert.equal(startCalled, 1);
    assert.equal(scheduler._stopped, false);
  } finally {
    db.enableAllTasks = origEnable;
    db.disableAllTasks = origDisable;
    scheduler.tick = origTick;
    scheduler.start = origStart;
    scheduler.stopAll = origStopAll;
    scheduler._stopped = origStopped;
    if (origAllowed === undefined) delete process.env.TG_CHAT_ID;
    else process.env.TG_CHAT_ID = origAllowed;
  }
});

test('Bug #2: selectStreamingTasks and Scheduler.isTaskStreaming distinguish standby monitoring from active streaming', () => {
  const sched = new Scheduler();
  const standbyTask = { id: 1, platform: 'bilibili', room_id: '101', status: 'ENABLED', traffic: { running: false } };
  const liveTask = { id: 2, platform: 'douyu', room_id: '202', status: 'ENABLED', traffic: { running: true } };

  // Both tasks have active StreamManager in runningManagers, but only liveTask has FFmpeg running
  sched.runningManagers.set(sched.buildTaskKey(standbyTask), {
    getTrafficStats: () => ({ running: false }),
  });
  sched.runningManagers.set(sched.buildTaskKey(liveTask), {
    getTrafficStats: () => ({ running: true }),
  });

  assert.equal(sched.isTaskRunning(standbyTask), true, 'Standby task is being monitored');
  assert.equal(sched.isTaskStreaming(standbyTask), false, 'Standby task is NOT actively streaming');
  assert.equal(sched.isTaskStreaming(liveTask), true, 'Live task IS actively streaming');

  const selected = roomHandlers.selectStreamingTasks([standbyTask, liveTask], sched);
  assert.deepEqual(selected.map((t) => t.room_id), ['202']);
});

test('Bug #3 & #6: Scheduler.refreshTask awaits old manager stop before starting new one, and tick() prevents overlapping stagger loops', async () => {
  const sched = new Scheduler();
  const origGetById = db.getTaskById;
  const origGetEnabled = db.getEnabledTasks;
  const origStagger = config.polling.staggerStartMs;

  const events = [];
  const task1 = { id: 1, platform: 'bilibili', room_id: '1001', status: 'ENABLED', target_url: 'rtmp://127.0.0.1/live/1' };
  const task2 = { id: 2, platform: 'douyu', room_id: '2002', status: 'ENABLED', target_url: 'rtmp://127.0.0.1/live/2' };

  try {
    // Part A: refreshTask awaits stop before start
    db.getTaskById = () => task1;
    sched.runningManagers.set(sched.buildTaskKey(task1), {
      stop: () => new Promise((resolve) => {
        setTimeout(() => {
          events.push('old_stopped');
          resolve();
        }, 40);
      }),
    });
    sched.createManager = (t) => {
      const m = {
        start: async () => {
          events.push(`new_started:${t.room_id}`);
        },
        stop: () => Promise.resolve(),
      };
      sched.runningManagers.set(sched.buildTaskKey(t), m);
      return m;
    };

    await sched.refreshTask(task1);
    assert.deepEqual(events, ['old_stopped', 'new_started:1001']);

    // Part B: overlapping tick() calls during stagger delay do not start duplicate managers
    sched.runningManagers.clear();
    sched._startingKeys.clear();
    config.polling.staggerStartMs = 60;
    db.getEnabledTasks = () => [task1, task2];

    const startCounts = { '1001': 0, '2002': 0 };
    sched.createManager = (t) => {
      const m = {
        start: async () => {
          startCounts[t.room_id] += 1;
        },
        stop: () => Promise.resolve(),
      };
      sched.runningManagers.set(sched.buildTaskKey(t), m);
      return m;
    };

    await sched.tick();
    // Immediately invoke tick() again while stagger loop is mid-sleep on task2
    await sched.tick();
    await sched.tick();
    await new Promise((r) => setTimeout(r, 180));

    assert.deepEqual(startCounts, { '1001': 1, '2002': 1 });
    assert.equal(sched._startingKeys.size, 0);
  } finally {
    db.getTaskById = origGetById;
    db.getEnabledTasks = origGetEnabled;
    config.polling.staggerStartMs = origStagger;
    await sched.stopAll();
  }
});

test('Bug #4: FFmpegService.captureFrame drains large stderr (>128KB) without deadlocking and waits for close', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-pipe-test-'));
  const fakeBin = path.join(tmpDir, 'fake-ffmpeg.js');
  // Fake ffmpeg binary that writes 160KB to stderr (exceeds 64KB Linux pipe buffer) + JPEG payload to stdout
  fs.writeFileSync(
    fakeBin,
    `#!/usr/bin/env node
const bigNoise = 'W'.repeat(160 * 1024) + '\\n';
process.stderr.write(bigNoise, () => {
  process.stdout.write(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), () => {
    process.exit(0);
  });
});
`,
    { mode: 0o755 }
  );

  const origPath = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = fakeBin;

  try {
    const ff = new FFmpegService({ roomId: '1', targetUrls: ['rtmp://127.0.0.1/live/k'] });
    const buf = await ff.captureFrame('http://127.0.0.1/test.flv', { timeout: 5000 });
    assert.equal(buf.length, 6);
    assert.equal(buf[0], 0xff);
    assert.equal(buf[1], 0xd8);
  } finally {
    if (origPath === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = origPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Bug #4b: FFmpegService.detectBlackFrame waits for close event and reliably detects black_start', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-black-test-'));
  const fakeBin = path.join(tmpDir, 'fake-black.js');
  fs.writeFileSync(
    fakeBin,
    `#!/usr/bin/env node
process.stderr.write('[blackdetect @ 0x1] black_start:0 black_end:16.2 black_duration:16.2\\n', () => {
  process.exit(0);
});
`,
    { mode: 0o755 }
  );

  const origPath = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = fakeBin;

  try {
    const ff = new FFmpegService({ roomId: '1', targetUrls: ['rtmp://127.0.0.1/live/k'] });
    const isBlack = await ff.detectBlackFrame('http://127.0.0.1/test.flv', { seconds: 2, duration: 1 });
    assert.equal(isBlack, true);
  } finally {
    if (origPath === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = origPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Bug #5, #7 & #9: enterFallbackMode rolls back on failure, checkHealth prevents overlapping black-frame/live-verify probes, and async errors are caught', async () => {
  const mgr = new StreamManager({
    id: 55555,
    platform: 'bilibili',
    room_id: '55555',
    target_url: 'rtmp://127.0.0.1/live/55555',
    status: 'ENABLED',
  });

  // Bug #5: startFallback throws -> isFallbackActive must remain false
  mgr.ffmpeg.stop = () => Promise.resolve();
  mgr.ffmpeg.startFallback = () => { throw new Error('spawn ENOENT'); };

  await assert.rejects(() => mgr.enterFallbackMode('test'), /spawn ENOENT/);
  assert.equal(mgr.isFallbackActive, false, 'isFallbackActive must roll back to false if startFallback fails');

  // Bug #7: overlapping checkBlackFrame calls are deduplicated by _checkingBlackFrame lock
  let detectCalls = 0;
  mgr.currentStreamUrl = 'http://127.0.0.1/live.flv';
  mgr.ffmpeg.detectBlackFrame = async () => {
    detectCalls += 1;
    await new Promise((r) => setTimeout(r, 40));
    return false;
  };

  await Promise.all([
    mgr.checkBlackFrame({ force: true }),
    mgr.checkBlackFrame({ force: true }),
    mgr.checkBlackFrame({ force: true }),
  ]);
  assert.equal(detectCalls, 1, 'Concurrent checkBlackFrame calls must not stack');
  assert.equal(mgr._checkingBlackFrame, false);

  // Bug #7b: overlapping live verification in checkHealth is deduplicated by _verifyingLive lock
  let infoCalls = 0;
  mgr.room.getInfo = async () => {
    infoCalls += 1;
    await new Promise((r) => setTimeout(r, 40));
    return { isLive: true };
  };
  mgr.ffmpeg.getTrafficStats = () => ({ running: true, bitrateKbps: 3000, sessionBytes: 100000, lastProgressAt: Date.now() });
  mgr._streamStartedAt = Date.now() - 120000;
  mgr.health.evaluateTick = () => ({
    frozen: false,
    isStalling: false,
    markRunning: false,
    bitrateDropAlert: null,
    bitrateRecovered: false,
    shouldProbeFailback: false,
    shouldCheckBlackFrame: false,
    shouldVerifyLiveStatus: true,
  });

  mgr.checkHealth();
  mgr.checkHealth();
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(infoCalls, 1, 'Concurrent room.getInfo live checks must not stack');
  assert.equal(mgr._verifyingLive, false);

  mgr.stop();
});

test('Bug #8: bare-link preview uses info.roomName so live room title is displayed', async () => {
  let textHandler = null;
  const fakeBot = {
    command: () => {},
    hears: () => {},
    callbackQuery: () => {},
    on: (ev, fn) => { if (ev === 'message:text') textHandler = fn; },
  };
  roomHandlers.register(fakeBot, {
    safeEditMessageText: async () => {},
    safeEditMessageMedia: async () => {},
    ephemeralReply: async () => {},
    ephemeralPhoto: async () => {},
    buildTaskDetailKeyboard: () => ({}),
    buildTaskListKeyboard: () => ({}),
    mainKeyboard: {},
  });

  const origCreate = platforms.create;
  const origGetAll = db.getAllTasks;
  const replies = [];
  try {
    db.getAllTasks = () => [];
    platforms.create = () => ({
      getInfo: async () => ({ hostName: '测试主播', roomName: '今晚排位冲大师', isLive: true }),
    });

    await textHandler(
      {
        message: { text: 'https://live.bilibili.com/778899' },
        session: { addRoom: { step: null, roomId: null, platform: null } },
        reply: async (text, opts) => { replies.push({ text, opts }); },
      },
      async () => {}
    );

    assert.equal(replies.length, 1);
    assert.ok(replies[0].text.includes('测试主播'));
    assert.ok(replies[0].text.includes('今晚排位冲大师'), 'Preview should display roomName as title');
  } finally {
    platforms.create = origCreate;
    db.getAllTasks = origGetAll;
  }
});

test('Bug #10: formatLogsHtml never truncates inside HTML entities and stays within Telegram 4000-char limit', () => {
  const trickyLines = [];
  for (let i = 0; i < 30; i += 1) {
    trickyLines.push(`[2026-11-20 12:00:${String(i).padStart(2, '0')}] <error> a&b & c<d > ${'&<>'.repeat(55)}`);
  }
  const html = botModule.formatLogsHtml(trickyLines, { onlyErrors: true, maxLen: 4000 });
  assert.ok(html.length <= 4000, `Expected <= 4000 chars, got ${html.length}`);
  assert.ok(html.endsWith('</code>'), 'Must properly close <code> tag');

  // Verify no dangling/broken HTML entity like "&am" or "&l" before </code>
  const inner = html.slice(html.indexOf('<code>') + 6, html.lastIndexOf('</code>'));
  assert.equal(/&(?!(?:amp|lt|gt|quot);)/.test(inner), false, 'Must not contain broken HTML entities');
});

test('Bug #11: deleting last RTMP target auto-disables task, stops manager, and never double-answers callbackQuery', async () => {
  let delurlHandler = null;
  const fakeBot = {
    command: () => {},
    callbackQuery: (pattern, fn) => {
      if (pattern instanceof RegExp && pattern.source.startsWith('^delurl:')) {
        delurlHandler = fn;
      }
    },
    on: () => {},
  };
  rtmpHandlers.register(fakeBot, {
    safeEditMessageText: async () => {},
    buildTaskDetailKeyboard: () => ({}),
  });
  assert.equal(typeof delurlHandler, 'function');

  const origDelete = db.deleteTargetById;
  const origGetById = db.getTaskById;
  const origUpdateStatus = db.updateTaskStatus;
  const origStopMgr = scheduler.stopManager;
  const origRefresh = scheduler.refreshTask;
  const origTraffic = scheduler.getTrafficStats;
  const origIsRunning = scheduler.isTaskRunning;

  let statusUpdatedTo = null;
  let stopMgrCalls = 0;
  let refreshCalls = 0;
  let answerCalls = 0;

  try {
    db.deleteTargetById = () => ({ remaining: 0 });
    db.getTaskById = () => ({
      id: 7,
      platform: 'bilibili',
      room_id: '700',
      status: statusUpdatedTo || 'ENABLED',
      targets: [],
    });
    db.updateTaskStatus = (id, status) => { statusUpdatedTo = status; };
    scheduler.stopManager = async () => { stopMgrCalls += 1; };
    scheduler.refreshTask = async () => { refreshCalls += 1; };
    scheduler.getTrafficStats = () => [];
    scheduler.isTaskRunning = () => false;

    const answers = [];
    await delurlHandler({
      match: ['delurl:7:99', '7', '99'],
      answerCallbackQuery: async (arg) => {
        answerCalls += 1;
        answers.push(arg);
      },
      reply: async () => {},
    });

    assert.equal(statusUpdatedTo, 'DISABLED', 'Task must be auto-disabled when last target is removed');
    assert.equal(stopMgrCalls, 1, 'Manager must be stopped');
    assert.equal(refreshCalls, 0, 'Must not call refreshTask when no targets remain');
    assert.equal(answerCalls, 1, 'Must answer callback query exactly once');
    assert.ok(String(answers[0]).includes('已自动暂停'));
  } finally {
    db.deleteTargetById = origDelete;
    db.getTaskById = origGetById;
    db.updateTaskStatus = origUpdateStatus;
    scheduler.stopManager = origStopMgr;
    scheduler.refreshTask = origRefresh;
    scheduler.getTrafficStats = origTraffic;
    scheduler.isTaskRunning = origIsRunning;
  }
});
