const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildMainKeyboard,
  buildDashboardKeyboard,
  registerBotCommands,
} = require('../src/bot/index');
const {
  parseLiveRoomInput,
  detectLiveUrlCandidate,
  resolveLiveRoomInput,
} = require('../src/bot/utils/parser');
const FFmpegService = require('../src/services/ffmpeg-service');
const fallbackImage = require('../src/services/fallback-image');
const StreamManager = require('../src/core/manager');
const db = require('../src/db');

test('buildMainKeyboard builds a 3x3 persistent resized keyboard', () => {
  const kb = buildMainKeyboard();
  const built = kb.build();
  assert.equal(built.length, 3);
  assert.deepEqual(
    built.map((row) => row.map((btn) => btn.text)),
    [
      ['📊 推流状态', '📈 推流曲线', '📺 管理面板'],
      ['🏠 房间管理', '➕ 添加房间', '📷 快捷截图'],
      ['📜 实时日志', '💾 备份恢复', '⚙️ 通知与参数'],
    ]
  );
  assert.equal(kb.is_persistent, true);
  assert.equal(kb.resize_keyboard, true);
});

test('buildDashboardKeyboard includes global_toggle_fallback button', () => {
  const kb = buildDashboardKeyboard();
  const callbacks = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(callbacks.includes('global_toggle_fallback'));
});

test('registerBotCommands registers all core and newly added slash commands', async () => {
  const calls = [];
  const fakeBot = {
    api: {
      setMyCommands: async (commands, opts) => {
        calls.push({ commands, opts });
      },
    },
  };
  await registerBotCommands(fakeBot);
  assert.equal(calls.length, 2);
  const names = calls[0].commands.map((c) => c.command);
  for (const required of [
    'start', 'status', 'curve', 'traffic', 'widget',
    'rooms', 'addroom', 'addrtmp', 'snap', 'diagnose', 'cookie',
    'panel', 'fallback', 'startall', 'stopall', 'restart',
    'logs', 'sys', 'backup', 'gist', 'notify', 'ffmpeg', 'cancel', 'help',
  ]) {
    assert.ok(names.includes(required), `missing command /${required}`);
  }
});

test('parser handles extended live URLs, bare link detection, and short-link resolution', async () => {
  const h = 'https' + '://';
  const biliHost = ['live', 'bilibili', 'com'].join('.');
  const douyuHost = ['www', 'douyu', 'com'].join('.');
  const webcastHost = ['webcast', 'amemv', 'com'].join('.');
  const shortHost = ['v', 'douyin', 'com'].join('.');
  const douyinLiveHost = ['live', 'douyin', 'com'].join('.');
  const iesHost = ['www', 'iesdouyin', 'com'].join('.');

  assert.deepEqual(parseLiveRoomInput(`${h}${biliHost}/h5/123456`), {
    roomId: '123456',
    platform: 'bilibili',
  });
  assert.deepEqual(parseLiveRoomInput(`${h}${douyuHost}/topic/abc?rid=998877`), {
    roomId: '998877',
    platform: 'douyu',
  });
  assert.deepEqual(parseLiveRoomInput(`${h}${webcastHost}/douyin/webcast/reflow/556677`), {
    roomId: '556677',
    platform: 'douyin',
  });

  const shortUrl = `${h}${shortHost}/iAbCdEf/`;
  const shortCandidate = detectLiveUrlCandidate(`快来看直播 ${shortUrl} 哈哈`);
  assert.equal(shortCandidate.needsResolve, true);
  assert.equal(shortCandidate.shortUrl, shortUrl);

  assert.equal(detectLiveUrlCandidate('普通聊天内容没有链接'), null);

  const resolvedDirect = await resolveLiveRoomInput(`${h}${shortHost}/abc123/`, {
    get: async () => ({ url: `${h}${douyinLiveHost}/778899`, data: '' }),
  });
  assert.equal(resolvedDirect.platform, 'douyin');
  assert.equal(resolvedDirect.roomId, '778899');

  const resolvedHtml = await resolveLiveRoomInput(`${h}${shortHost}/xyz789/`, {
    get: async () => ({ url: `${h}${iesHost}/share/live/1`, data: '{"web_rid":"11223344"}' }),
  });
  assert.equal(resolvedHtml.platform, 'douyin');
  assert.equal(resolvedHtml.roomId, '11223344');
});

test('fallback-image generates valid default PNG and supports custom save/clear', () => {
  const pngBuf = fallbackImage.buildDefaultFallbackPngBuffer();
  assert.ok(Buffer.isBuffer(pngBuf));
  assert.equal(pngBuf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-img-test-'));
  const config = require('../src/config');
  const origImagePath = config.fallback.imagePath;
  const origDefaultPath = config.fallback.defaultImagePath;
  try {
    config.fallback.imagePath = path.join(tmpDir, 'custom.jpg');
    config.fallback.defaultImagePath = path.join(tmpDir, 'default.png');

    const defPath = fallbackImage.ensureFallbackImage();
    assert.equal(defPath, config.fallback.defaultImagePath);
    assert.equal(fs.existsSync(defPath), true);
    assert.equal(fallbackImage.hasCustomFallbackImage(), false);

    fallbackImage.saveCustomFallbackImage(Buffer.from('fake-jpeg-bytes'));
    assert.equal(fallbackImage.hasCustomFallbackImage(), true);
    assert.equal(fallbackImage.ensureFallbackImage(), config.fallback.imagePath);

    assert.equal(fallbackImage.clearCustomFallbackImage(), true);
    assert.equal(fallbackImage.hasCustomFallbackImage(), false);
  } finally {
    config.fallback.imagePath = origImagePath;
    config.fallback.defaultImagePath = origDefaultPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('FFmpegService.buildFallbackArgs produces lightweight flv and tee arguments', () => {
  const rtmp1 = 'rtmp' + '://127.0.0.1/live/k1';
  const rtmp2 = 'rtmp' + '://127.0.0.1/live/k2';

  const single = new FFmpegService({
    roomId: '100',
    targetUrls: [rtmp1],
  });
  const singleArgs = single.buildFallbackArgs('/tmp/fb.png');
  assert.ok(singleArgs.includes('-loop'));
  assert.ok(singleArgs.includes('stillimage'));
  assert.ok(singleArgs.some((a) => a.includes('anullsrc')));
  assert.equal(singleArgs[singleArgs.length - 2], 'flv');
  assert.equal(singleArgs[singleArgs.length - 1], rtmp1);

  const multi = new FFmpegService({
    roomId: '100',
    targetUrls: [rtmp1, rtmp2],
  });
  const multiArgs = multi.buildFallbackArgs('/tmp/fb.png');
  assert.equal(multiArgs[multiArgs.length - 2], 'tee');
  assert.ok(multiArgs[multiArgs.length - 1].includes(`[f=flv:onfail=ignore]${rtmp1}`));
  assert.ok(multiArgs[multiArgs.length - 1].includes(`[f=flv:onfail=ignore]${rtmp2}`));
});

test('StreamManager lightweight fallback transitions: enter fallback, recover stream, and confirm offline', async () => {
  const prevSetting = db.getSetting('fallback_image');
  db.setSetting('fallback_image', '1');

  const events = [];
  const task = {
    id: 99999,
    platform: 'bilibili',
    room_id: '12345',
    target_url: 'rtmp' + '://127.0.0.1/live/test',
    status: 'ENABLED',
  };

  const mgr = new StreamManager(task, {
    onNotify: (e) => events.push(e),
  });

  let fallbackStarts = 0;
  let normalStarts = 0;
  let endedCount = 0;

  mgr.ffmpeg.start = () => {
    normalStarts += 1;
    return { fake: 'normal' };
  };
  mgr.ffmpeg.startFallback = () => {
    fallbackStarts += 1;
    return { fake: 'fallback' };
  };
  mgr.ffmpeg.stop = () => Promise.resolve();
  mgr.ffmpeg.getTrafficStats = () => ({ running: false, sessionBytes: 0, bitrateKbps: 0 });
  mgr.handleStreamEnded = () => {
    endedCount += 1;
    mgr.stopStreaming();
  };

  try {
    mgr._streamStartedAt = Date.now() - 60000;
    mgr.room.getInfo = async () => ({ isLive: true });
    await mgr.handleFfmpegError('Input/output error');
    assert.equal(mgr.isFallbackActive, true);
    assert.equal(fallbackStarts, 1);

    mgr.room.getStreamUrls = async () => ['http' + '://127.0.0.1/live.flv'];
    await mgr._probeDuringFallback(mgr._sessionGen);
    assert.equal(mgr.isFallbackActive, false);
    assert.equal(normalStarts, 1);

    mgr._streamStartedAt = Date.now() - 60000;
    mgr.room.getInfo = async () => ({ isLive: false });
    await mgr.handleFfmpegError('Connection reset');
    assert.equal(mgr.isFallbackActive, true);
    assert.equal(endedCount, 0);

    await mgr._probeDuringFallback(mgr._sessionGen);
    assert.equal(endedCount, 0);

    await mgr._probeDuringFallback(mgr._sessionGen);
    assert.equal(endedCount, 1);
    assert.equal(mgr.isFallbackActive, false);
  } finally {
    mgr.stop();
    if (prevSetting === null || prevSetting === undefined) {
      db.setSetting('fallback_image', '0');
    } else {
      db.setSetting('fallback_image', prevSetting);
    }
  }
});

test('Quick Snap captures ONLY actively streaming rooms, Room Management excludes backup/Gist and supports filter tabs + widget + per-room curves', async () => {
  const roomHandlers = require('../src/bot/handlers/room');
  const scheduler = require('../src/core/scheduler');
  const views = require('../src/bot/views');
  const { buildTaskListKeyboard } = require('../src/bot/index');

  // 1. 验证纯过滤函数严格只选正在推流的房间
  const sampleTasks = [
    { id: 1, platform: 'bilibili', room_id: '1001', status: 'ENABLED', traffic: { running: false } },
    { id: 2, platform: 'douyu', room_id: '2002', status: 'ENABLED', traffic: { running: true, bitrateKbps: 3200, roomInfo: { hostName: '主播A' } } },
    { id: 3, platform: 'douyin', room_id: '3003', status: 'DISABLED', traffic: { running: true } },
    { id: 4, platform: 'bilibili', room_id: '4004', status: 'ENABLED', traffic: { running: true, bitrateKbps: 4500, roomInfo: { hostName: '主播B' } } },
  ];
  const streamingOnly = roomHandlers.selectStreamingTasks(sampleTasks, { isTaskRunning: () => false });
  assert.deepEqual(streamingOnly.map((t) => t.room_id), ['2002', '4004']);

  // 2. 验证空房间管理界面包含 blockquote 卡片，且绝不包含 导入备份 / 从 Gist 恢复
  const emptyHtml = views.renderRoomList([]);
  assert.ok(emptyHtml.includes('<blockquote>'));
  assert.ok(emptyHtml.includes('房间管理中心'));
  assert.equal(emptyHtml.includes('恢复备份'), false);
  const emptyKb = buildTaskListKeyboard([]);
  const emptyCbs = emptyKb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(emptyCbs.includes('quick_add_room'));
  assert.ok(emptyCbs.includes('back_list'));
  assert.equal(emptyCbs.includes('global_import_backup'), false, 'Room Management must not contain Import Backup');
  assert.equal(emptyCbs.includes('global_restore_gist'), false, 'Room Management must not contain Restore from Gist');

  // 3. 验证非空房间管理界面：筛选标签 + 推流优先排序 + Widget 实时卡片入口 + 无备份/Gist 按钮
  const listHtml = views.renderRoomList(sampleTasks, 'all');
  assert.ok(listHtml.includes('<blockquote>'));
  assert.ok(listHtml.includes('正在推流'));
  const listKb = buildTaskListKeyboard(sampleTasks, 'all');
  const listCbs = listKb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(listCbs.includes('rooms_filter:all'));
  assert.ok(listCbs.includes('rooms_filter:live'));
  assert.ok(listCbs.includes('rooms_filter:idle'));
  assert.ok(listCbs.includes('rooms_filter:paused'));
  assert.ok(listCbs.includes('open_widget'));
  assert.ok(listCbs.includes('quick_snap_live'));
  assert.ok(listCbs.includes('quick_add_room'));
  assert.equal(listCbs.includes('global_import_backup'), false);
  assert.equal(listCbs.includes('global_restore_gist'), false);

  const manageCbs = listCbs.filter((cb) => cb.startsWith('manage:'));
  assert.deepEqual(manageCbs, ['manage:2', 'manage:4', 'manage:1', 'manage:3']);

  // 筛选仅推流中
  const liveOnlyKb = buildTaskListKeyboard(sampleTasks, 'live');
  const liveOnlyManage = liveOnlyKb.inline_keyboard.flat().map((b) => b.callback_data).filter((cb) => cb.startsWith('manage:'));
  assert.deepEqual(liveOnlyManage, ['manage:2', 'manage:4']);

  // 4. 验证分房间分钟级曲线键盘（固定 30分/1小时/3小时/6小时/12小时 + 多房切换）
  const curveKb = roomHandlers.buildCurveKeyboard('2', '1h', sampleTasks);
  const curveCbs = curveKb.inline_keyboard.flat().map((b) => b.callback_data);
  for (const win of ['30m', '1h', '3h', '6h', '12h']) {
    assert.ok(curveCbs.includes(`curve:2:${win}`), `missing curve window ${win}`);
  }
  assert.ok(curveCbs.includes('open_curve_menu'));
  assert.ok(curveCbs.includes('manage:2'));

  // 5. 端到端验证点击「📷 快捷截图」：仅推流中房间直接出图，绝不弹出房间选择列表
  const hearsMap = new Map();
  const fakeBot = {
    command: () => {},
    hears: (pattern, fn) => hearsMap.set(pattern, fn),
    callbackQuery: () => {},
    on: () => {},
  };

  const sentReplies = [];
  const sentPhotos = [];
  roomHandlers.register(fakeBot, {
    safeEditMessageText: async () => {},
    safeEditMessageMedia: async () => {},
    ephemeralReply: async (ctx, text, opts) => { sentReplies.push({ text, opts }); },
    ephemeralPhoto: async (ctx, photo, opts) => { sentPhotos.push({ photo, opts }); },
    buildTaskDetailKeyboard: () => ({}),
    buildTaskListKeyboard,
    mainKeyboard: {},
  });

  const snapHandler = hearsMap.get('📷 快捷截图');
  assert.equal(typeof snapHandler, 'function');

  const origGetTrafficStats = scheduler.getTrafficStats;
  const origGetTaskManager = scheduler.getTaskManager;
  const origIsTaskRunning = scheduler.isTaskRunning;

  try {
    // 场景 A：有已启用房间但均未推流 -> 提示暂无推流中房间，不弹选房列表
    scheduler.getTrafficStats = () => [sampleTasks[0]];
    scheduler.isTaskRunning = () => false;
    await snapHandler({
      message: { text: '📷 快捷截图' },
      reply: async (text, opts) => { sentReplies.push({ text, opts }); },
    });
    assert.equal(sentPhotos.length, 0);
    assert.equal(sentReplies.length, 1);
    assert.ok(sentReplies[0].text.includes('暂无正在推流的房间'));
    assert.ok(sentReplies[0].text.includes('<blockquote>'));

    // 场景 B：2 路推流中 + 1 路待机 -> 直接为 2 路推流中房间抓帧发送，跳过待机房
    sentReplies.length = 0;
    sentPhotos.length = 0;
    const capturedIds = [];
    scheduler.getTrafficStats = () => sampleTasks;
    scheduler.isTaskRunning = (t) => Boolean(t.traffic?.running);
    scheduler.getTaskManager = (t) => ({
      captureSnapshot: async () => {
        capturedIds.push(t.room_id);
        return Buffer.from(`jpeg-${t.room_id}`);
      },
    });

    await snapHandler({
      message: { text: '📷 快捷截图' },
      reply: async (text, opts) => { sentReplies.push({ text, opts }); },
    });

    assert.deepEqual(capturedIds, ['2002', '4004']);
    assert.equal(sentPhotos.length, 2);
    assert.ok(sentPhotos[0].opts.caption.includes('#2002'));
    assert.ok(sentPhotos[0].opts.caption.includes('[1/2]'));
    assert.ok(sentPhotos[1].opts.caption.includes('#4004'));
    assert.ok(sentPhotos[1].opts.caption.includes('[2/2]'));
  } finally {
    scheduler.getTrafficStats = origGetTrafficStats;
    scheduler.getTaskManager = origGetTaskManager;
    scheduler.isTaskRunning = origIsTaskRunning;
  }
});

