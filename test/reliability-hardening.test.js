const test = require('node:test');
const assert = require('node:assert/strict');

const FFmpegService = require('../src/services/ffmpeg-service');
const StreamHealthMonitor = require('../src/core/health-monitor');
const StreamManager = require('../src/core/manager');
const { extractBilibiliPlayUrls } = require('../src/platforms/bilibili');
const { DouyinEngine } = require('../src/platforms/douyin');
const bot = require('../src/bot');
const db = require('../src/db');

test('FFmpegService puts -rw_timeout and -fflags before -i, terminates -headers with CRLF, parses bitrate=N/A, and triggers error when all tee outputs fail', () => {
  const errors = [];
  const svc = new FFmpegService({
    roomId: '1001',
    targetUrls: ['rtmp://push1.example.com/live/a', 'rtmp://push2.example.com/live/b'],
    inputHeaders: { Referer: 'https://live.bilibili.com/1001', 'User-Agent': 'TestAgent' },
    onError: (err) => errors.push(err.message),
  });

  const { preInput, postInput } = svc.buildInputOptions('https://cdn.example.com/live/1001.flv');
  assert.ok(preInput.includes('-rw_timeout'), '-rw_timeout must be in preInput (before -i)');
  assert.ok(preInput.includes('-fflags'), '-fflags must be in preInput (before -i)');
  assert.equal(postInput.includes('-rw_timeout'), false, '-rw_timeout must not be placed after -i');

  const headersIdx = preInput.indexOf('-headers');
  assert.ok(headersIdx >= 0 && preInput[headersIdx + 1].endsWith('\r\n'), '-headers must end with CRLF');

  const emptyTargetSvc = new FFmpegService({ roomId: '1001', targetUrls: [] });
  assert.throws(() => emptyTargetSvc.start('https://cdn.example.com/live/1001.flv'), /缺少推流目标地址/);

  // Parse normal stats line then bitrate=N/A
  const isProg1 = svc.parseStderrProgress('frame=  120 fps=30 q=-1.0 size=    512KiB time=00:00:04.00 bitrate=3200.5kbits/s speed=1.0x');
  assert.equal(isProg1, true);
  assert.equal(svc.trafficStats.bitrateKbps, 3200.5);
  assert.equal(svc.trafficStats.sessionBytes, 512 * 1024);
  assert.ok(typeof svc.trafficStats.lastProgressAt === 'number');

  const isProg2 = svc.parseStderrProgress('frame=  120 fps=0 q=-1.0 size=    512KiB time=00:00:04.00 bitrate=N/A speed=0x');
  assert.equal(isProg2, true);
  assert.equal(svc.trafficStats.bitrateKbps, 0, 'bitrate=N/A must reset bitrateKbps to 0');

  // Multi-target tee mode progress: size=N/A time=00:00:02.02 bitrate=N/A speed=1.38x
  svc.sourceBitrateKbps = 3200;
  const isTeeProg = svc.parseStderrProgress('size=N/A time=00:00:02.00 bitrate=N/A speed=1.38x');
  assert.equal(isTeeProg, true);
  assert.equal(svc.trafficStats.bitrateKbps, 3200, 'bitrate=N/A with active speed should use sourceBitrateKbps');
  assert.ok(svc.trafficStats.sessionBytes > 0, 'sessionBytes should be estimated from stream time in tee mode');

  const isErrorLine = svc.parseStderrProgress('[flv @ 0x1] Server returned 404 Not Found');
  assert.equal(isErrorLine, false, 'Error lines must not be classified as progress lines');

  // Tee mode: failing 1 of 2 slaves should not trigger fatal error; failing 2 of 2 must trigger fatal error
  svc.parseOutputErrors("[tee] Slave '[f=flv:onfail=ignore]rtmp://push1.example.com/live/a': error writing");
  assert.equal(errors.length, 0);
  svc.parseOutputErrors("[tee] Slave '[f=flv:onfail=ignore]rtmp://push2.example.com/live/b': error writing");
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('所有 RTMP 推流目标线路均已断开'));
});

test('StreamHealthMonitor detects stale progress and stagnant bytes even when cached bitrateKbps is non-zero, and debounces offline checks', () => {
  let clock = 200000;
  const monitor = new StreamHealthMonitor({
    healthConfig: {
      freezeGraceMs: 60000,
      freezeTicksThreshold: 2,
      progressStaleMs: 30000,
      liveVerifyIntervalMs: 300000,
      offlineConfirmCount: 2,
    },
    now: () => clock,
  });

  // Healthy tick with fresh progress and growing bytes
  const ok1 = monitor.evaluateTick({
    runtimeMs: 90000,
    bitrateKbps: 4200,
    lastNotifyType: 'running',
    sessionBytes: 100000,
    lastProgressAt: clock - 2000,
  });
  assert.equal(ok1.frozen, false);
  assert.equal(ok1.isStalling, false);

  // Stream freezes silently: bitrateKbps stays stuck at 4200, bytes stop growing, progress is stale (>30s)
  clock += 35000;
  const stall1 = monitor.evaluateTick({
    runtimeMs: 125000,
    bitrateKbps: 4200,
    lastNotifyType: 'running',
    sessionBytes: 100000,
    lastProgressAt: clock - 37000,
  });
  assert.equal(stall1.isStalling, true);
  assert.equal(stall1.frozen, false);
  assert.equal(stall1.shouldVerifyLiveStatus, true, 'First stall tick should trigger early platform live check');

  clock += 30000;
  const stall2 = monitor.evaluateTick({
    runtimeMs: 155000,
    bitrateKbps: 4200,
    lastNotifyType: 'running',
    sessionBytes: 100000,
    lastProgressAt: clock - 67000,
  });
  assert.equal(stall2.frozen, true, 'Second stalled tick must trigger frozen restart even with cached 4200 kbps');
  assert.ok(stall2.freezeReason && stall2.freezeReason.includes('停滞'));

  // Offline verification debounce: 1st false is ignored when stream is healthy; 2nd consecutive false confirms offline
  assert.equal(monitor.recordLiveVerifyResult(false), false);
  assert.equal(monitor.recordLiveVerifyResult(true), false, 'Transient live=true resets offline counter');
  assert.equal(monitor.recordLiveVerifyResult(false), false);
  assert.equal(monitor.recordLiveVerifyResult(false), true, '2nd consecutive false confirms offline');

  // When already stalling, 1st offline check confirms immediately
  monitor.resetSession();
  assert.equal(monitor.recordLiveVerifyResult(false, { immediateOnStall: true }), true);
});

test('StreamManager prioritizes backup URL failover over urlExpired delay and delivers deferred live-start notifications', async () => {
  const notifications = [];
  const startedUrls = [];
  const origUpdateError = db.updateError;
  db.updateError = () => ({ changes: 0 });

  const manager = new StreamManager(
    {
      id: 888,
      platform: 'bilibili',
      room_id: '55555',
      primary_target_url: 'rtmp://example.com/live/key',
    },
    {
      onNotify: (n) => notifications.push(n),
      isBootGrace: () => false,
    }
  );

  try {
    manager.room = {
      getInfo: async () => ({ isLive: true, hostName: '测试主播', roomName: '测试房间', cover: null }),
      getStreamUrls: async () => ['https://cdn1.example.com/a.flv', 'https://cdn2.example.com/b.flv'],
    };
    manager.ffmpeg.start = (url) => {
      startedUrls.push(url);
      manager.ffmpeg.ffmpegCommand = { kill: () => {}, on: () => {} };
      manager.ffmpeg.stoppedManually = false;
      manager.ffmpeg.trafficStats.startedAt = new Date().toISOString();
      return manager.ffmpeg.ffmpegCommand;
    };
    manager.ffmpeg.stop = () => {
      manager.ffmpeg.ffmpegCommand = null;
      return Promise.resolve();
    };

    // Simulate active primary stream with backup URL available
    manager.primaryUrl = 'https://cdn1.example.com/a.flv';
    manager.currentStreamUrl = 'https://cdn1.example.com/a.flv';
    manager.backupUrls = ['https://cdn2.example.com/b.flv'];

    // Input/output error should immediately failover to cdn2 instead of waiting 20s for urlExpiredRetryMs
    await manager.handleFfmpegError('FFmpeg exited with code 1: Input/output error');
    assert.equal(startedUrls.length, 1);
    assert.equal(startedUrls[0], 'https://cdn2.example.com/b.flv');
    assert.equal(manager.backupUrls.length, 0);
    assert.ok(notifications.some((n) => n.type === 'failover'));

    // Deferred live-start notification should be delivered on checkHealth when bytes finally arrive
    manager._pendingLiveNotify = { wasOffline: true, wasError: false, gen: manager._sessionGen };
    manager._streamStartedAt = Date.now() - 15000;
    manager.ffmpeg.trafficStats = {
      sessionBytes: 65536,
      bitrateKbps: 2800,
      updatedAt: new Date().toISOString(),
      lastProgressAt: Date.now(),
      startedAt: new Date().toISOString(),
    };
    manager.checkHealth();
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(notifications.some((n) => n.type === 'live_start'), 'Deferred live_start must be delivered once bytes arrive');
  } finally {
    manager.stop();
    db.updateError = origUpdateError;
  }
});

test('extractBilibiliPlayUrls prioritizes AVC (H.264) over HEVC (H.265) streams', () => {
  const playurl = {
    stream: [
      {
        format: [
          {
            format_name: 'flv',
            codec: [
              {
                codec_name: 'hevc',
                codec_id: 1,
                base_url: '/live-bvc/hevc.flv',
                url_info: [{ host: 'https://hevc.cdn.com', extra: '?q=1' }],
              },
              {
                codec_name: 'avc',
                codec_id: 0,
                base_url: '/live-bvc/avc.flv',
                url_info: [{ host: 'https://avc.cdn.com', extra: '?q=1' }],
              },
            ],
          },
        ],
      },
    ],
  };

  const urls = extractBilibiliPlayUrls(playurl);
  assert.deepEqual(urls, [
    'https://avc.cdn.com/live-bvc/avc.flv?q=1',
    'https://hevc.cdn.com/live-bvc/hevc.flv?q=1',
  ]);
});

test('DouyinEngine.getStreamUrls returns both FLV and HLS URLs for automatic failover', async () => {
  const engine = new DouyinEngine();
  engine._fetchPageData = async () => ({
    isLive: true,
    flv: 'https://pull.douyin.com/live/room.flv',
    m3u8: 'https://pull.douyin.com/live/room.m3u8',
  });

  const urls = await engine.getStreamUrls('123456');
  assert.deepEqual(urls, [
    'https://pull.douyin.com/live/room.flv',
    'https://pull.douyin.com/live/room.m3u8',
  ]);
});

test('bot.handleManagerNotification delivers repeated live_start & stream_ended across 3 broadcasts with identical titles and never drops forced circuit-breaker alerts', async () => {
  const sentMessages = [];
  const origGetTaskById = db.getTaskById;
  const origGetSetting = db.getSetting;
  const origChatId = process.env.TG_CHAT_ID;
  const origApi = bot.api;

  db.getTaskById = (id) => ({ id: Number(id), platform: 'bilibili', room_id: '10086' });
  db.getSetting = () => '1';
  process.env.TG_CHAT_ID = '999999';
  bot.api = {
    sendMessage: async (chatId, text) => {
      sentMessages.push({ chatId, text });
    },
    sendPhoto: async (chatId, _photo, opts) => {
      sentMessages.push({ chatId, text: opts?.caption || '' });
    },
  };
  bot._lastLifecycleState = {};
  bot._lastNotifiedAt = {};

  try {
    // 3 identical-title broadcasts in a single day
    for (let i = 0; i < 3; i++) {
      bot.handleManagerNotification({
        taskId: 77,
        type: 'live_start',
        message: '🟢 开播了！正在推流中...\n👤 主播A — 固定标题',
      });
      bot.handleManagerNotification({
        taskId: 77,
        type: 'stream_ended',
        message: '直播已结束 (主播A)，等待下一场直播...',
      });
    }
    // Duplicate consecutive stream_ended should be suppressed
    bot.handleManagerNotification({
      taskId: 77,
      type: 'stream_ended',
      message: '直播已结束 (主播A)，等待下一场直播...',
    });

    // Normal error followed immediately by forced circuit breaker error
    bot.handleManagerNotification({
      taskId: 77,
      type: 'error',
      message: '遇到错误: 网络超时',
    });
    bot.handleManagerNotification({
      taskId: 77,
      type: 'error',
      message: '遇到错误: 第二次普通错误（应被10分钟去重抑制）',
    });
    bot.handleManagerNotification({
      taskId: 77,
      type: 'error',
      force: true,
      message: '任务已自动熔断：连续 20 次推流失败',
    });

    await new Promise((r) => setTimeout(r, 30));

    const liveStarts = sentMessages.filter((m) => m.text.includes('开播了'));
    const streamEnds = sentMessages.filter((m) => m.text.includes('直播已结束'));
    const circuitBreakers = sentMessages.filter((m) => m.text.includes('任务已自动熔断'));

    assert.equal(liveStarts.length, 3, 'All 3 live_start notifications must be sent even with identical title');
    assert.equal(streamEnds.length, 3, 'All 3 stream_ended notifications must be sent while duplicate 4th is suppressed');
    assert.equal(circuitBreakers.length, 1, 'Forced circuit breaker alert must never be suppressed by 10-min dedup');
  } finally {
    db.getTaskById = origGetTaskById;
    db.getSetting = origGetSetting;
    if (origChatId === undefined) delete process.env.TG_CHAT_ID;
    else process.env.TG_CHAT_ID = origChatId;
    bot.api = origApi;
  }
});
