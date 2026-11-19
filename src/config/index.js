const path = require('node:path');
const { resolveFfmpegBin } = require('../services/ffmpeg-installer');
const { getRuntimeProfile } = require('../core/runtime-env');

function intEnv(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function strEnv(key, fallback = '') {
  const raw = process.env[key];
  return raw !== undefined && String(raw).trim() !== '' ? String(raw).trim() : fallback;
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function getConfig() {
  const runtime = getRuntimeProfile();
  const rawPort = strEnv('PORT', '');
  const disableWeb =
    strEnv('DISABLE_WEB', '0') === '1' ||
    rawPort === '0' ||
    rawPort.toLowerCase() === 'off' ||
    rawPort.toLowerCase() === 'false';

  return {
    timezone: strEnv('TZ', 'Asia/Shanghai'),
    runtime,
    server: {
      disableWeb,
      port: intEnv('PORT', 3000),
      bindHost: strEnv('BIND_HOST', '0.0.0.0'),
      dashboardToken: strEnv('DASHBOARD_TOKEN', ''),
      apiRateLimitPerMin: intEnv('API_RATE_LIMIT_PER_MIN', 120),
    },
    paths: {
      database: strEnv('DATABASE_PATH', path.join(__dirname, '../../data/data.db')),
      logFile: strEnv('LOG_FILE_PATH', path.join(__dirname, '../../logs/app.log')),
      seedRooms: path.join(__dirname, '../../rooms.json'),
    },
    http: {
      userAgent: strEnv('HTTP_USER_AGENT', DEFAULT_USER_AGENT),
      timeoutMs: intEnv('PLATFORM_TIMEOUT_MS', 15000),
      douyinCookie: strEnv('DOUYIN_COOKIE', '__ac_nonce=0658d6780004b23f5d0a8;'),
    },
    rateLimitMs: {
      bilibili: intEnv('RATE_LIMIT_BILIBILI_MS', 1500),
      douyin: intEnv('RATE_LIMIT_DOUYIN_MS', 2000),
      douyu: intEnv('RATE_LIMIT_DOUYU_MS', 1000),
      default: intEnv('RATE_LIMIT_DEFAULT_MS', 1000),
    },
    polling: {
      schedulerTickMs: intEnv('SCHEDULER_TICK_MS', 30000),
      staggerStartMs: intEnv('STAGGER_START_MS', 2500),
      bootGraceMs: intEnv('BOOT_GRACE_MS', 90000),
      notLiveDelayMs: intEnv('POLL_NOT_LIVE_MS', 120000),
      douyuNotLiveDelayMs: intEnv('POLL_DOUYU_NOT_LIVE_MS', 45000),
      streamEndedDelayMs: intEnv('POLL_STREAM_ENDED_MS', 30000),
      streamEndedFastPolls: intEnv('POLL_STREAM_ENDED_FAST_COUNT', 10),
      urlExpiredRetryMs: intEnv('URL_EXPIRED_RETRY_MS', 20000),
      retryBaseDelayMs: intEnv('RETRY_BASE_MS', 30000),
      retryStepDelayMs: intEnv('RETRY_STEP_MS', 10000),
      retryMaxDelayMs: intEnv('RETRY_MAX_MS', 300000),
      circuitBreakerThreshold: intEnv('CIRCUIT_BREAKER_THRESHOLD', 20),
    },
    ffmpeg: {
      get bin() {
        return resolveFfmpegBin(process.env.FFMPEG_PATH);
      },
      probeSize: strEnv('FFMPEG_PROBESIZE', '1000000'),
      analyzeDuration: strEnv('FFMPEG_ANALYZEDURATION', '1000000'),
      rwTimeoutUs: strEnv('FFMPEG_RW_TIMEOUT_US', '10000000'),
      videoCodec: strEnv('FFMPEG_VIDEO_CODEC', 'libx264'),
      videoPreset: strEnv('FFMPEG_VIDEO_PRESET', 'veryfast'),
      videoCrf: strEnv('FFMPEG_VIDEO_CRF', '23'),
      videoMaxrate: strEnv('FFMPEG_VIDEO_MAXRATE', '4500k'),
      videoBufsize: strEnv('FFMPEG_VIDEO_BUFSIZE', '9000k'),
      audioCodec: strEnv('FFMPEG_AUDIO_CODEC', 'aac'),
      audioBitrate: strEnv('FFMPEG_AUDIO_BITRATE', '128k'),
      threads: intEnv('FFMPEG_THREADS', runtime.recommendedFfmpegThreads),
      snapshotTimeoutMs: intEnv('SNAPSHOT_TIMEOUT_MS', 25000),
    },
    health: {
      freezeGraceMs: intEnv('FREEZE_GRACE_MS', 120000),
      freezeTicksThreshold: intEnv('FREEZE_TICKS_THRESHOLD', 4),
      progressStaleMs: intEnv('PROGRESS_STALE_MS', 45000),
      bitrateDropGraceMs: intEnv('BITRATE_DROP_GRACE_MS', 300000),
      bitrateDropRatio: 0.5,
      bitrateDropTicksThreshold: intEnv('BITRATE_DROP_TICKS', 3),
      failbackIntervalTicks: intEnv('FAILBACK_INTERVAL_TICKS', 20),
      blackCheckEnabled: strEnv('BLACK_CHECK_ENABLED', '0') === '1',
      blackCheckIntervalTicks: intEnv('BLACK_CHECK_INTERVAL_TICKS', 8),
      blackAlertCooldownMs: intEnv('BLACK_ALERT_COOLDOWN_MS', 3600000),
      liveVerifyIntervalMs: intEnv('LIVE_VERIFY_INTERVAL_MS', 300000),
      offlineConfirmCount: intEnv('OFFLINE_CONFIRM_COUNT', 2),
    },
    housekeeping: {
      digestHour: intEnv('DIGEST_HOUR', 8),
      defaultRestartHour: intEnv('DAILY_RESTART_HOUR', 10),
      // 0 表示按系统/容器内存比例告警（>= 90%）；Serv00 默认按 384/448MB 告警防止 512MB 账号被杀
      memAlertMb: intEnv('MEM_ALERT_MB', runtime.defaultMemAlertMb),
      criticalMemMb: intEnv('CRITICAL_MEM_MB', runtime.defaultCriticalMemMb),
      diskAlertPct: intEnv('DISK_ALERT_PCT', 85),
      resourceAlertCooldownMs: intEnv('RESOURCE_ALERT_COOLDOWN_MS', 3600000),
    },
  };
}

module.exports = getConfig();
module.exports.getConfig = getConfig;
module.exports.DEFAULT_USER_AGENT = DEFAULT_USER_AGENT;
