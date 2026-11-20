const config = require('../config');
const db = require('../db');
const rooms = require('../platforms');
const FFmpegService = require('../services/ffmpeg-service');
const fallbackImage = require('../services/fallback-image');
const StreamHealthMonitor = require('./health-monitor');
const eventBus = require('./events');
const views = require('../bot/views');

const NOT_LIVE_MESSAGE = '主播尚未开播';
const STREAM_ENDED_MESSAGE = 'STREAM_ENDED';

function isOfflineMessage(msg) {
  const lowerMsg = String(msg || '').toLowerCase();
  return (
    lowerMsg.includes('房间未开播') ||
    lowerMsg.includes('未开播') ||
    lowerMsg.includes('主播尚未开播') ||
    lowerMsg.includes('已下播') ||
    lowerMsg.includes('主播已下播') ||
    lowerMsg.includes('下播') ||
    lowerMsg.includes('not live') ||
    lowerMsg.includes('offline') ||
    lowerMsg.includes('未直播') ||
    lowerMsg.includes('live status is 0')
  );
}

function withJitter(delay, ratio = 0.2) {
  const delta = delay * ratio;
  return Math.round(delay - delta + Math.random() * delta * 2);
}

function maskHost(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/***`;
  } catch {
    return '***';
  }
}

function resolveTargetUrls(task) {
  if (Array.isArray(task.targets) && task.targets.length > 0) {
    return task.targets.map((target) => target.target_url).filter(Boolean);
  }
  if (typeof db.getTaskTargets === 'function' && task.id !== undefined && task.id !== null) {
    const dbTargets = db.getTaskTargets(task.id).map((target) => target.target_url).filter(Boolean);
    if (dbTargets.length > 0) return dbTargets;
  }
  return [task.primary_target_url || task.target_url].filter(Boolean);
}

function resolveTaskCookie(task) {
  if (task?.cookie && String(task.cookie).trim()) {
    return String(task.cookie).trim();
  }
  const platform = task?.platform;
  if (platform) {
    try {
      const dbCookie = db.getSetting?.(`${platform}_cookie`);
      if (dbCookie && String(dbCookie).trim()) return String(dbCookie).trim();
    } catch {}
  }
  if (platform === 'douyin' && config.http.douyinCookie) {
    return config.http.douyinCookie;
  }
  return '';
}

function buildDefaultHeaders(platform, roomId, cookie = '') {
  const ua = config.http.userAgent;
  const headers = { 'User-Agent': ua };
  if (platform === 'bilibili') {
    headers.Referer = `https://live.bilibili.com/${roomId}`;
  } else if (platform === 'douyu') {
    headers.Referer = `https://www.douyu.com/${roomId}`;
  } else if (platform === 'douyin') {
    headers.Referer = `https://live.douyin.com/${roomId}`;
  }
  if (cookie) {
    headers.Cookie = cookie;
  }
  return headers;
}

function resolveRoomOptions(task) {
  const cookie = resolveTaskCookie(task);
  return {
    headers: {
      ...buildDefaultHeaders(task.platform, task.room_id, cookie),
      ...(task.headers || {}),
    },
    metadata: {
      taskId: task.id,
      platform: task.platform,
      ...(task.metadata || {}),
    },
  };
}

function resolveEncodingConfig(task) {
  const mode = task?.transcode_mode || 'default';
  if (mode === 'copy') {
    return { mode: 'copy', transcodeVideo: false, transcodeAudio: false };
  }
  if (mode === 'audio_fix') {
    return { mode: 'audio_fix', transcodeVideo: false, transcodeAudio: true };
  }
  if (mode === 'transcode') {
    return { mode: 'transcode', transcodeVideo: true, transcodeAudio: true };
  }
  return {
    mode: 'default',
    transcodeVideo: db.getSetting?.('transcode_video') === '1',
    transcodeAudio: db.getSetting?.('transcode_audio') === '1',
  };
}

async function diagnoseTask(task) {
  const startAt = Date.now();
  const options = resolveRoomOptions(task);
  const room = rooms.create(task.platform, task.room_id, options);
  const cookieSource = task?.cookie && String(task.cookie).trim()
    ? `房间独立 Cookie (${String(task.cookie).length} 字符)`
    : options.headers?.Cookie
      ? `平台默认 Cookie (${String(options.headers.Cookie).length} 字符)`
      : '未配置 Cookie（匿名访客模式）';

  try {
    const info = await room.getInfo();
    const infoLatencyMs = Date.now() - startAt;
    let streamUrls = [];
    let streamError = null;
    if (info.isLive) {
      try {
        streamUrls = await room.getStreamUrls();
      } catch (err) {
        streamError = err.message;
      }
    }
    const primaryStream = streamUrls[0] || '';
    const isHls = /\.m3u8(\?|$)/i.test(primaryStream);
    const hasHevcHint = /hevc|h265|codec=1/i.test(primaryStream);
    let sampleHost = '';
    try {
      if (primaryStream) sampleHost = new URL(primaryStream).host;
    } catch {}

    return {
      ok: true,
      latencyMs: Date.now() - startAt,
      infoLatencyMs,
      cookieSource,
      encoding: resolveEncodingConfig(task),
      info,
      streamCount: streamUrls.length,
      protocol: primaryStream ? (isHls ? 'HLS (m3u8)' : 'FLV (HTTP-FLV)') : '未拉取（未开播）',
      hasHevcHint,
      sampleHost,
      streamError,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - startAt,
      cookieSource,
      encoding: resolveEncodingConfig(task),
      error: err.message,
    };
  }
}

class RetryPolicy {
  constructor({
    baseDelay = config.polling.retryBaseDelayMs,
    stepDelay = config.polling.retryStepDelayMs,
    maxDelay = config.polling.retryMaxDelayMs,
  } = {}) {
    this.baseDelay = baseDelay;
    this.stepDelay = stepDelay;
    this.maxDelay = maxDelay;
    this.attempts = 0;
  }

  nextDelay() {
    const delay = Math.min(this.attempts * this.stepDelay + this.baseDelay, this.maxDelay);
    this.attempts += 1;
    return withJitter(delay);
  }

  reset() {
    this.attempts = 0;
  }
}

class PollPolicy {
  constructor({
    notLiveDelay = config.polling.notLiveDelayMs,
    streamEndedDelay = config.polling.streamEndedDelayMs,
  } = {}) {
    this.notLiveDelay = notLiveDelay;
    this.streamEndedDelay = streamEndedDelay;
    this.notLiveAttempts = 0;
    this.streamEndedAttempts = 0;
  }

  nextDelay(reason) {
    if (reason === STREAM_ENDED_MESSAGE) {
      this.streamEndedAttempts += 1;
      const delay = this.streamEndedAttempts <= config.polling.streamEndedFastPolls
        ? this.streamEndedDelay
        : this.notLiveDelay;
      return withJitter(delay);
    }
    this.notLiveAttempts += 1;
    return withJitter(this.notLiveDelay);
  }

  reset() {
    this.notLiveAttempts = 0;
    this.streamEndedAttempts = 0;
  }
}

class StreamManager {
  constructor(task, { onNotify = () => {}, isBootGrace = null } = {}) {
    this.task = task;
    this.isBootGrace = isBootGrace;
    this.roomOptions = resolveRoomOptions(task);
    this.encodingConfig = resolveEncodingConfig(task);
    this.room = rooms.create(task.platform, task.room_id, this.roomOptions);
    this.targetUrls = resolveTargetUrls(task);
    this.retryPolicy = new RetryPolicy(task.retryPolicy);

    const pollCfg = { ...(task.pollPolicy || {}) };
    if (task.platform === 'douyu' && pollCfg.notLiveDelay === undefined) {
      pollCfg.notLiveDelay = config.polling.douyuNotLiveDelayMs;
    }
    this.pollPolicy = new PollPolicy(pollCfg);

    this.onNotify = onNotify;
    this.lastNotifyType = null;
    this._pendingTimer = null;
    this._notifyTimer = null;
    this._pendingLiveNotify = null;
    this._sessionGen = 0;
    this._handlingFfmpegError = false;
    this._streamStartedAt = null;
    this._lastSampledAt = 0;
    this.lastErrorMessage = null;
    this.errorCount = 0;
    this.lastSuccessAt = null;
    this.consecutiveStreamFailures = 0;

    this.backupUrls = [];
    this.primaryUrl = null;
    this.health = new StreamHealthMonitor();

    this.dailyLiveSeconds = 0;
    this.dailyDrops = 0;
    this.sessionDrops = 0;

    this.trafficStats = {
      totalBytes: 0,
      lastRefreshAt: null,
    };
    this.currentStreamUrl = null;
    this.roomInfo = null;
    this.isFallbackActive = false;
    this._fallbackStartedAt = null;
    this._fallbackTimer = null;
    this._fallbackOfflineCount = 0;
    this._checkingBlackFrame = false;
    this._verifyingLive = false;

    this.ffmpeg = new FFmpegService({
      roomId: task.room_id,
      targetUrls: this.targetUrls,
      inputHeaders: this.roomOptions.headers,
      globalOutputOptions: task.ffmpeg?.outputOptions || [],
      transcodeVideo: this.encodingConfig.transcodeVideo,
      transcodeAudio: this.encodingConfig.transcodeAudio,
      onStart: () => this._handleFfmpegStarted(),
      onError: (err) => {
        if (!this.isStopping) {
          this.handleFfmpegError(err.message).catch((e) => {
            console.error(`[${this.task.room_id}] 处理 FFmpeg 错误异常:`, e.message);
          });
        }
      },
      onOutputFailed: (targetUrl) => {
        if (this.isStopping) return;
        this._emitNotify({
          taskId: this.task.id,
          type: 'output_failed',
          message: `推流目标断开: ${maskHost(targetUrl)}，其他线路继续推流中`,
        });
      },
      onEnd: () => {
        if (this.isStopping) return;
        if (this.isFallbackEnabled() && this._streamStartedAt && !this.isFallbackActive) {
          this.enterFallbackMode('拉流中断 (EOF)').catch((err) => {
            console.error(`[${this.task.room_id}] 启动保底图失败:`, err.message);
            this.handleStreamEnded();
          });
          return;
        }
        this.handleStreamEnded();
      },
    });
    this.process = null;
    this.isStopping = false;
  }

  _emitNotify(payload) {
    eventBus.publish(payload);
    this.onNotify?.(payload);
  }

  async _deliverLiveStartNotification({ wasOffline, wasError }, expectedGen) {
    if (this.isStopping || expectedGen !== this._sessionGen) return;
    this._pendingLiveNotify = null;

    const activeTraffic = this.ffmpeg?.getTrafficStats?.();
    if (activeTraffic?.bitrateKbps > 0) {
      this._lastSampledAt = Date.now();
      db.recordBitrateSample?.(this.task.id, Math.round(activeTraffic.bitrateKbps), this._lastSampledAt);
    }

    try {
      this.roomInfo = await this.room.getInfo();
    } catch (err) {
      console.error(`[${this.task.room_id}] 获取房间信息失败:`, err.message);
    }
    if (this.isStopping || expectedGen !== this._sessionGen) return;

    const liveNotifyEnabled = db.getSetting?.('notify_live_start') !== '0';
    const snapshotEnabled = db.getSetting?.('live_snapshot') === '1';
    let imageBuffer = null;

    if (liveNotifyEnabled && snapshotEnabled) {
      try {
        imageBuffer = await this.captureSnapshot();
      } catch (err) {
        console.error(`[${this.task.room_id}] 截图失败:`, err.message);
      }
    }
    if (this.isStopping || expectedGen !== this._sessionGen) return;

    const infoLine = this.roomInfo?.hostName
      ? `\n👤 ${this.roomInfo.hostName}` + (this.roomInfo.roomName ? ` — ${this.roomInfo.roomName}` : '')
      : '';

    let recoverSuffix = '';
    if (wasError) {
      const minutes = this.health.popRecoverMinutes('ffmpeg_error') ?? this.health.popRecoverMinutes('error');
      if (minutes !== null) {
        recoverSuffix = `（本次中断约 ${StreamHealthMonitor.formatInterruptMinutes(minutes)}）`;
      }
    }
    const liveMsg = wasOffline ? '🟢 开播了！正在推流中...' : `🟢 推流恢复了${recoverSuffix}，正在推流中...`;
    this._emitNotify({
      taskId: this.task.id,
      type: 'live_start',
      message: `${liveMsg}${infoLine}`,
      imageBuffer,
      coverUrl: this.roomInfo?.cover || null,
    });
    this.lastNotifyType = 'live_start';
  }

  _handleFfmpegStarted() {
    db.updateError(this.task.id, null);
    this._streamStartedAt = Date.now();
    this.lastSuccessAt = new Date().toISOString();
    this.consecutiveStreamFailures = 0;

    const wasOffline = this.lastNotifyType === 'offline' || this.lastNotifyType === 'stream_ended';
    const wasError = this.lastNotifyType === 'error' || this.lastNotifyType === 'ffmpeg_error';
    const shouldNotifyLive = wasOffline || wasError;
    const gen = this._sessionGen;
    this._pendingLiveNotify = shouldNotifyLive ? { wasOffline, wasError, gen } : null;

    if (this._notifyTimer) clearTimeout(this._notifyTimer);
    this._notifyTimer = setTimeout(async () => {
      this._notifyTimer = null;
      if (this.isStopping || gen !== this._sessionGen) return;

      const traffic = this.ffmpeg?.getTrafficStats?.();
      if (!traffic?.running) return;

      if ((traffic.sessionBytes || 0) <= 0) {
        await new Promise((r) => setTimeout(r, 3000));
        if (this.isStopping || gen !== this._sessionGen) return;
        const recheck = this.ffmpeg?.getTrafficStats?.();
        if (!recheck?.running || (recheck.sessionBytes || 0) <= 0) {
          console.log(`[${this.task.room_id}] 推流启动但暂未收到有效音视频数据，待收到首帧后补发开播通知`);
          return;
        }
      }

      if (this._pendingLiveNotify) {
        const pending = this._pendingLiveNotify;
        await this._deliverLiveStartNotification(pending, gen);
      } else {
        const activeTraffic = this.ffmpeg?.getTrafficStats?.();
        if (activeTraffic?.bitrateKbps > 0) {
          this._lastSampledAt = Date.now();
          db.recordBitrateSample?.(this.task.id, Math.round(activeTraffic.bitrateKbps), this._lastSampledAt);
        }
        try {
          this.roomInfo = await this.room.getInfo();
        } catch (err) {
          console.error(`[${this.task.room_id}] 获取房间信息失败:`, err.message);
        }
      }
    }, 5000);
  }

  async start() {
    this.isStopping = false;
    const gen = ++this._sessionGen;

    let urls;
    try {
      urls = await this.room.getStreamUrls();
    } catch (err) {
      if (this.isStopping || gen !== this._sessionGen) return;
      this.handleRoomError(err.message);
      return;
    }

    if (this.isStopping || gen !== this._sessionGen) return;
    await this.stopStreaming();
    if (this.isStopping || gen !== this._sessionGen) return;

    const streamUrl = urls[0];
    this.backupUrls = urls.slice(1);
    this.primaryUrl = streamUrl;
    this.health.resetSession();
    this.sessionDrops = 0;
    this.currentStreamUrl = streamUrl;
    this.process = this.ffmpeg.start(streamUrl);
    this.trafficStats.lastRefreshAt = new Date().toISOString();
    this.retryPolicy.reset();
    this.pollPolicy.reset();
  }

  async captureSnapshot() {
    try {
      const streamUrl = (this.currentStreamUrl && this.ffmpeg?.getTrafficStats().running)
        ? this.currentStreamUrl
        : await this.room.getStreamUrl();

      if (!streamUrl) {
        throw new Error('无法获取有效的直播流地址');
      }

      return await this.ffmpeg.captureFrame(streamUrl, {
        platform: this.task.platform,
        timeout: config.ffmpeg.snapshotTimeoutMs,
      });
    } catch (err) {
      throw new Error(`流不可用: ${err.message}`);
    }
  }

  getTrafficStats() {
    const ffmpegStats = this.ffmpeg.getTrafficStats();
    const currentSessionBytes = ffmpegStats.sessionBytes || 0;
    return {
      totalBytes: this.trafficStats.totalBytes + currentSessionBytes,
      sessionBytes: currentSessionBytes,
      bitrateKbps: ffmpegStats.bitrateKbps || 0,
      updatedAt: ffmpegStats.updatedAt,
      startedAt: ffmpegStats.startedAt,
      running: ffmpegStats.running || false,
      fallbackActive: !!this.isFallbackActive,
      lastRefreshAt: this.trafficStats.lastRefreshAt,
      errorCount: this.errorCount,
      lastSuccessAt: this.lastSuccessAt,
      roomInfo: this.roomInfo,
      lastArgs: ffmpegStats.lastArgs,
    };
  }

  async refreshRoomInfo() {
    try {
      this.roomInfo = await this.room.getInfo();
      return this.roomInfo;
    } catch {
      return null;
    }
  }

  checkHealth() {
    if (this.isStopping || !this.ffmpeg || this._handlingFfmpegError || this.isFallbackActive) return;
    const stats = this.ffmpeg.getTrafficStats();
    if (!stats.running) return;

    const now = Date.now();
    const gen = this._sessionGen;

    // 弱网建连慢导致前 8 秒未播报开播时，一旦后续收到真实音视频流量立即补发，永不丢通知
    if (this._pendingLiveNotify && (stats.sessionBytes || 0) > 0 && (stats.bitrateKbps || 0) > 0) {
      const pending = this._pendingLiveNotify;
      this._pendingLiveNotify = null;
      this._deliverLiveStartNotification(pending, pending.gen).catch(() => {});
    }

    const runtimeMs = now - (this._streamStartedAt || 0);
    const evaluation = this.health.evaluateTick({
      runtimeMs,
      bitrateKbps: stats.bitrateKbps || 0,
      lastNotifyType: this.lastNotifyType,
      sessionBytes: stats.sessionBytes || 0,
      lastProgressAt: stats.lastProgressAt ?? null,
    });

    if (!evaluation.isStalling && stats.bitrateKbps > 0 && now - (this._lastSampledAt || 0) >= 28000) {
      this._lastSampledAt = now;
      db.recordBitrateSample?.(this.task.id, Math.round(stats.bitrateKbps), now);
    }

    if (evaluation.frozen) {
      this.handleFfmpegError(`检测到画面冻结 (${evaluation.freezeReason || 'Bitrate 0'})，正在自动重启...`).catch((e) => {
        console.error(`[${this.task.room_id}] 冻结重启处理异常:`, e.message);
      });
      return;
    }

    if (evaluation.markRunning && !this._pendingLiveNotify) {
      this.lastNotifyType = 'running';
      this.lastErrorMessage = null;
    }

    if (!evaluation.isStalling) {
      this.dailyLiveSeconds += Math.round(config.polling.schedulerTickMs / 1000);
    }

    if (evaluation.bitrateDropAlert) {
      this.lastNotifyType = 'bitrate_drop';
      this._emitNotify({
        taskId: this.task.id,
        type: 'bitrate_drop',
        message: evaluation.bitrateDropAlert,
      });
    } else if (evaluation.bitrateRecovered) {
      this.lastNotifyType = 'running';
      this.notifyRecovered('bitrate_drop', '码率下跌告警');
    }

    if (evaluation.shouldProbeFailback) {
      this.tryFailbackToPrimary().catch(() => {});
    }

    if (evaluation.shouldCheckBlackFrame) {
      this.checkBlackFrame().catch(() => {});
    }

    if (evaluation.shouldVerifyLiveStatus && !this._verifyingLive) {
      this._verifyingLive = true;
      this.room
        .getInfo()
        .then((info) => {
          if (this.isStopping || gen !== this._sessionGen) return;
          if (!this.ffmpeg?.getTrafficStats().running) return;
          const confirmedOffline = this.health.recordLiveVerifyResult(Boolean(info?.isLive), {
            immediateOnStall: evaluation.isStalling,
          });
          if (confirmedOffline) {
            this.handleStreamEnded();
          }
        })
        .catch((err) => {
          console.error(`[${this.task.room_id}] 平台状态检查失败:`, err.message);
        })
        .finally(() => {
          this._verifyingLive = false;
        });
    }
  }

  async checkBlackFrame({ force = false } = {}) {
    if (this.isStopping || !this.currentStreamUrl || this._checkingBlackFrame) return;
    const enabled = force || config.health.blackCheckEnabled || db.getSetting?.('black_frame_check') === '1';
    if (!enabled) return;

    this._checkingBlackFrame = true;
    let isBlack = false;
    try {
      isBlack = await this.ffmpeg.detectBlackFrame(this.currentStreamUrl, { seconds: 20, duration: 15 });
    } catch {
      return;
    } finally {
      this._checkingBlackFrame = false;
    }
    if (this.isStopping) return;
    if (isBlack && Date.now() - this.health.lastBlackAlertAt > config.health.blackAlertCooldownMs) {
      this.health.lastBlackAlertAt = Date.now();
      this.health.markAlertStart('black_screen');
      this._emitNotify({
        taskId: this.task.id,
        type: 'black_screen',
        message: '画面疑似黑屏（连续 15 秒以上黑帧），推流仍在继续，请抽查确认',
      });
    } else if (!isBlack) {
      this.notifyRecovered('black_screen', '黑屏告警');
    }
  }

  async tryFailbackToPrimary() {
    if (this.isStopping || this.health._failbackProbing || this._handlingFfmpegError) return;
    if (typeof db.getSetting === 'function' && db.getSetting('auto_failback') === '0') return;
    const primary = this.primaryUrl;
    const current = this.currentStreamUrl;
    if (!primary || !current || primary === current) return;
    if (!this.ffmpeg?.getTrafficStats().running) return;
    const gen = this._sessionGen;
    this.health._failbackProbing = true;
    try {
      await this.ffmpeg.captureFrame(primary, { platform: this.task.platform, timeout: 15000 });
    } catch {
      this.health._failbackProbing = false;
      return;
    }
    this.health._failbackProbing = false;
    if (this.isStopping || gen !== this._sessionGen) return;

    console.log(`[${this.task.room_id}] 主线路已恢复，自动切回`);
    await this.stopStreaming();
    if (this.isStopping || gen !== this._sessionGen) return;
    this.consecutiveStreamFailures = 0;
    this.health.resetSession();
    this.currentStreamUrl = primary;
    // 保留备用线路，避免切回主线后再次抖动时无备线可切
    this.backupUrls = [...new Set([current, ...(this.backupUrls || [])].filter((u) => u && u !== primary))];
    this.process = this.ffmpeg.start(primary);
    this._emitNotify({
      taskId: this.task.id,
      type: 'failover',
      message: '主线路已恢复，自动切回主线路继续推流',
    });
  }

  getDailyStats() {
    return {
      taskId: this.task.id,
      platform: this.task.platform,
      roomId: this.task.room_id,
      liveMinutes: Math.round(this.dailyLiveSeconds / 60),
      drops: this.dailyDrops,
      bytes: this.trafficStats.totalBytes + (this.ffmpeg?.getTrafficStats().sessionBytes || 0),
      running: !!this.ffmpeg?.getTrafficStats().running,
    };
  }

  resetDailyStats() {
    this.dailyLiveSeconds = 0;
    this.dailyDrops = 0;
  }

  saveSessionStats() {
    const ffmpegStats = this.ffmpeg.getTrafficStats();
    if (ffmpegStats.sessionBytes) {
      this.trafficStats.totalBytes += ffmpegStats.sessionBytes;
    }
  }

  notifyRecovered(type, desc) {
    const minutes = this.health.popRecoverMinutes(type);
    if (minutes === null) return;
    this._emitNotify({
      taskId: this.task.id,
      type: 'recover',
      message: `${desc}已恢复，本次中断约 ${StreamHealthMonitor.formatInterruptMinutes(minutes)}`,
    });
  }

  handleRoomError(msg) {
    const isOffline = isOfflineMessage(msg);
    const lowerMsg = String(msg || '').toLowerCase();
    const isRateLimited = lowerMsg.includes('限流') || lowerMsg.includes('rate limit');

    this.saveSessionStats();
    this.stopStreaming();
    this.health.clearRecoverTrack();

    if (isOffline) {
      db.updateError(this.task.id, null);
      if (this.lastNotifyType !== 'offline') {
        this.lastNotifyType = 'offline';
        this.lastErrorMessage = null;
        if (!this.isBootGrace?.()) {
          const hostLabel = this.roomInfo?.hostName ? ` (${this.roomInfo.hostName})` : '';
          this._emitNotify({
            taskId: this.task.id,
            type: 'offline',
            message: `主播${hostLabel}已下播，正在监测中...`,
          });
        }
      }
    } else {
      this.errorCount += 1;
      db.updateError(this.task.id, msg);
      if (this.lastNotifyType !== 'error' || this.lastErrorMessage !== msg) {
        this.lastNotifyType = 'error';
        this.lastErrorMessage = msg;
        this._emitNotify({
          taskId: this.task.id,
          type: 'error',
          message: `遇到错误: ${msg}`,
        });
      }
    }

    const delay = this.pollPolicy.nextDelay(msg);
    this.retryPolicy.reset();
    if (isRateLimited) {
      this.pollPolicy.reset();
      this.scheduleStart(this.retryPolicy.nextDelay());
    } else {
      this.scheduleStart(delay);
    }
  }

  isFallbackEnabled() {
    const val = db.getSetting?.('fallback_image');
    if (val === '1') return true;
    if (val === '0') return false;
    return Boolean(config.fallback?.enabledDefault);
  }

  _clearFallbackTimer() {
    if (this._fallbackTimer) {
      clearTimeout(this._fallbackTimer);
      this._fallbackTimer = null;
    }
  }

  async enterFallbackMode(reason = '源流中断', { initialOfflineCount = 0 } = {}) {
    if (this.isStopping || this.isFallbackActive) return false;
    const gen = this._sessionGen;
    this.saveSessionStats();
    await this.stopStreaming();
    if (this.isStopping || gen !== this._sessionGen) return false;

    try {
      const imgPath = fallbackImage.ensureFallbackImage();
      this.process = this.ffmpeg.startFallback(imgPath);
      this.isFallbackActive = true;
      this._fallbackStartedAt = Date.now();
      this._fallbackOfflineCount = initialOfflineCount;
    } catch (err) {
      this.isFallbackActive = false;
      this._fallbackStartedAt = null;
      this._fallbackOfflineCount = 0;
      this.process = null;
      throw err;
    }

    console.log(`[${this.task.room_id}] 已切入轻量断流保底图（原因: ${reason}）`);
    this._emitNotify({
      taskId: this.task.id,
      type: 'failover',
      message: `🖼️ 检测到断流（${reason}），已切换保底图顶住推流，后台每 ${Math.round((config.fallback?.probeIntervalMs || 15000) / 1000)} 秒探测恢复中...`,
    });

    this._scheduleFallbackProbe(gen);
    return true;
  }

  _scheduleFallbackProbe(gen) {
    this._clearFallbackTimer();
    const interval = config.fallback?.probeIntervalMs || 15000;
    this._fallbackTimer = setTimeout(() => {
      this._fallbackTimer = null;
      this._probeDuringFallback(gen).catch((err) => {
        console.error(`[${this.task.room_id}] 保底探测异常:`, err.message);
      });
    }, interval);
  }

  async _probeDuringFallback(gen) {
    if (this.isStopping || !this.isFallbackActive || gen !== this._sessionGen) return;

    const maxMs = config.fallback?.maxDurationMs || 180000;
    const elapsed = Date.now() - (this._fallbackStartedAt || Date.now());
    if (elapsed >= maxMs) {
      console.log(`[${this.task.room_id}] 保底图已达最长时长 (${Math.round(elapsed / 1000)}s)，停止保底并转入常规重试`);
      await this.stopStreaming();
      if (this.isStopping || gen !== this._sessionGen) return;
      this._emitNotify({
        taskId: this.task.id,
        type: 'ffmpeg_error',
        message: `🖼️ 保底图已持续 ${Math.round(elapsed / 1000)} 秒仍未恢复源流，已停止保底推流防止空烧流量`,
      });
      this.scheduleStart(this.retryPolicy.nextDelay());
      return;
    }

    let info = null;
    try {
      info = await this.room.getInfo();
    } catch (err) {
      if (this.isStopping || !this.isFallbackActive || gen !== this._sessionGen) return;
      console.error(`[${this.task.room_id}] 保底期间查询状态失败（维持保底）:`, err.message);
      this._scheduleFallbackProbe(gen);
      return;
    }

    if (this.isStopping || !this.isFallbackActive || gen !== this._sessionGen) return;

    if (info && info.isLive === false) {
      this._fallbackOfflineCount += 1;
      const confirmTarget = config.fallback?.offlineConfirmCount || 3;
      console.log(`[${this.task.room_id}] 保底防抖复核：平台显示未开播 (${this._fallbackOfflineCount}/${confirmTarget})`);
      if (this._fallbackOfflineCount >= confirmTarget) {
        this.handleStreamEnded();
        return;
      }
      this._scheduleFallbackProbe(gen);
      return;
    }

    // 平台显示在播（或未知），重置离线计数并尝试重拉真实流
    this._fallbackOfflineCount = 0;
    try {
      const urls = await this.room.getStreamUrls();
      if (this.isStopping || !this.isFallbackActive || gen !== this._sessionGen) return;
      if (Array.isArray(urls) && urls.length > 0) {
        console.log(`[${this.task.room_id}] 源流已恢复，退出保底图切回真实画面`);
        await this.stopStreaming();
        if (this.isStopping || gen !== this._sessionGen) return;
        const streamUrl = urls[0];
        this.backupUrls = urls.slice(1);
        this.primaryUrl = streamUrl;
        this.currentStreamUrl = streamUrl;
        this.consecutiveStreamFailures = 0;
        this.health.resetSession();
        this.process = this.ffmpeg.start(streamUrl);
        this.trafficStats.lastRefreshAt = new Date().toISOString();
        this.retryPolicy.reset();
        this._emitNotify({
          taskId: this.task.id,
          type: 'recover',
          message: `✅ 源流已恢复（保底耗时 ${Math.round(elapsed / 1000)} 秒），已切回正常直播画面`,
        });
        return;
      }
    } catch (err) {
      if (this.isStopping || !this.isFallbackActive || gen !== this._sessionGen) return;
      console.error(`[${this.task.room_id}] 保底期间重拉流失败:`, err.message);
    }

    this._scheduleFallbackProbe(gen);
  }

  async handleFfmpegError(msg) {
    if (this.isStopping || this._handlingFfmpegError) return;
    this._handlingFfmpegError = true;
    const gen = this._sessionGen;
    const wasFallback = this.isFallbackActive;
    const hadActiveStream = Boolean(this._streamStartedAt);

    try {
      let checkedOffline = false;
      try {
        const info = await this.room.getInfo();
        if (this.isStopping || gen !== this._sessionGen) return;
        if (info && info.isLive === false) {
          if (!wasFallback && hadActiveStream && this.isFallbackEnabled()) {
            checkedOffline = true;
          } else {
            console.log(`[${this.task.room_id}] 平台显示已下播，FFmpeg 报错按正常结束处理`);
            this.handleStreamEnded();
            return;
          }
        }
      } catch (err) {
        if (this.isStopping || gen !== this._sessionGen) return;
        console.error(`[${this.task.room_id}] 下播预检失败，按故障处理:`, err.message);
      }

      if (checkedOffline) {
        this.dailyDrops += 1;
        this.sessionDrops += 1;
        const entered = await this.enterFallbackMode('疑似下播/断线，进入防抖保底', { initialOfflineCount: 1 });
        if (entered) return;
      }

      this.errorCount += 1;
      this.consecutiveStreamFailures += 1;
      this.saveSessionStats();
      await this.stopStreaming();
      if (this.isStopping || gen !== this._sessionGen) return;
      db.updateError(this.task.id, msg);

      if (this.consecutiveStreamFailures >= config.polling.circuitBreakerThreshold) {
        db.updateTaskStatus?.(this.task.id, 'DISABLED');
        this._emitNotify({
          taskId: this.task.id,
          type: 'error',
          force: true,
          message: `任务已自动熔断：连续 ${this.consecutiveStreamFailures} 次推流失败，已暂停该任务（手动开启可恢复）`,
        });
        return;
      }

      if (this.lastNotifyType !== 'ffmpeg_error' || this.lastErrorMessage !== msg) {
        this.lastNotifyType = 'ffmpeg_error';
        this.lastErrorMessage = msg;
        this.health.markAlertStart('ffmpeg_error');
        this._emitNotify({
          taskId: this.task.id,
          type: 'ffmpeg_error',
          message: `推流出错: ${msg}`,
        });
      }

      // 优先秒切已获取的备用源流线路（避免单节点故障白等 20s 刷新全流程）
      if (!wasFallback && this.tryFailover(msg)) {
        return;
      }

      // 备线不可用时，如开启轻量保底图且本场已在推流，切入保底图顶住下游 RTMP
      if (!wasFallback && hadActiveStream && this.isFallbackEnabled()) {
        this.dailyDrops += 1;
        this.sessionDrops += 1;
        try {
          const entered = await this.enterFallbackMode(msg, { initialOfflineCount: 0 });
          if (entered) return;
        } catch (err) {
          console.error(`[${this.task.room_id}] 启动保底图失败，退回常规重试:`, err.message);
        }
      }

      const isUrlExpired =
        /error opening input files?/i.test(msg) ||
        /input\/output error/i.test(msg) ||
        /\b404\b/.test(msg) ||
        /exited with code (251|403)/.test(msg);

      let delay;
      if (isUrlExpired) {
        delay = config.polling.urlExpiredRetryMs;
        this.retryPolicy.reset();
      } else {
        delay = this.retryPolicy.nextDelay();
      }

      this.dailyDrops += 1;
      this.sessionDrops += 1;
      this.scheduleStart(delay);
    } finally {
      this._handlingFfmpegError = false;
    }
  }

  tryFailover(msg) {
    if (!this.backupUrls || this.backupUrls.length === 0) return false;
    const isInputError =
      /error opening input|input\/output error|connection (reset|refused|timed out)|http error|failed to resolve|server returned|画面冻结/i.test(msg);
    if (!isInputError) return false;

    const backupUrl = this.backupUrls.shift();
    console.log(`[${this.task.room_id}] 输入线路故障，切换备用线路: ${maskHost(backupUrl)}（剩余 ${this.backupUrls.length} 条）`);
    this.consecutiveStreamFailures = 0;
    this.health.resetSession();
    this.currentStreamUrl = backupUrl;
    this.process = this.ffmpeg.start(backupUrl);
    this._emitNotify({
      taskId: this.task.id,
      type: 'failover',
      message: '输入线路故障，已自动切换到备用线路继续推流',
    });
    return true;
  }

  async manualFailover() {
    if (!this.backupUrls || this.backupUrls.length === 0) return false;
    const backupUrl = this.backupUrls.shift();
    console.log(`[${this.task.room_id}] 手动切换备用线路: ${maskHost(backupUrl)}（剩余 ${this.backupUrls.length} 条）`);
    const gen = ++this._sessionGen;
    await this.stopStreaming();
    if (this.isStopping || gen !== this._sessionGen) return false;
    this.consecutiveStreamFailures = 0;
    this.health.resetSession();
    this.currentStreamUrl = backupUrl;
    this.process = this.ffmpeg.start(backupUrl);
    this._emitNotify({
      taskId: this.task.id,
      type: 'failover',
      message: '已手动切换到备用线路继续推流',
    });
    return true;
  }

  handleStreamEnded() {
    const sessBytes = this.ffmpeg?.getTrafficStats().sessionBytes || 0;
    const durationSec = this._streamStartedAt ? Math.round((Date.now() - this._streamStartedAt) / 1000) : 0;
    const hadSession = durationSec > 0;
    const peakKbps = Math.round(this.health.bitratePeak || 0);

    this.saveSessionStats();
    this.stopStreaming();
    this._streamStartedAt = null;
    if (hadSession) {
      db.recordBitrateSample?.(this.task.id, 0, Date.now());
    }
    db.updateError(this.task.id, STREAM_ENDED_MESSAGE);
    this.health.clearRecoverTrack();

    if (this.lastNotifyType !== 'stream_ended') {
      this.lastNotifyType = 'stream_ended';
      if (!this.isBootGrace?.()) {
        const hostLabel = this.roomInfo?.hostName ? ` (${this.roomInfo.hostName})` : '';
        this._emitNotify({
          taskId: this.task.id,
          type: 'stream_ended',
          message: `直播已结束${hostLabel}，等待下一场直播...`,
        });
      }
    }

    if (hadSession) {
      this._emitNotify({
        taskId: this.task.id,
        type: 'session_summary',
        message: views.renderSessionSummary({
          platform: this.task.platform,
          roomId: this.task.room_id,
          hostName: this.roomInfo?.hostName,
          durationSec,
          drops: this.sessionDrops,
          peakKbps,
          bytes: sessBytes,
        }),
      });
    }

    const delay = this.pollPolicy.nextDelay(STREAM_ENDED_MESSAGE);
    this.retryPolicy.reset();
    this.scheduleStart(delay);
  }

  handleError(msg) {
    return this.handleFfmpegError(msg).catch((e) => {
      console.error(`[${this.task.room_id}] 处理错误异常:`, e.message);
    });
  }

  scheduleStart(delay) {
    if (this._pendingTimer) {
      clearTimeout(this._pendingTimer);
    }
    this._pendingTimer = setTimeout(() => {
      this._pendingTimer = null;
      if (this.isStopping) return;
      this.start().catch((err) => {
        console.error(`[${this.task.room_id}] 定时启动推流异常:`, err.message);
      });
    }, delay);
  }

  stopStreaming() {
    this._pendingLiveNotify = null;
    this._clearFallbackTimer();
    this.isFallbackActive = false;
    this._fallbackStartedAt = null;
    this._fallbackOfflineCount = 0;
    if (this._notifyTimer) {
      clearTimeout(this._notifyTimer);
      this._notifyTimer = null;
    }
    const stopped = this.ffmpeg.stop();
    this.process = null;
    return stopped;
  }

  stop() {
    this.isStopping = true;
    this._sessionGen += 1;
    if (this._pendingTimer) {
      clearTimeout(this._pendingTimer);
      this._pendingTimer = null;
    }
    return this.stopStreaming();
  }
}

module.exports = StreamManager;
module.exports.RetryPolicy = RetryPolicy;
module.exports.PollPolicy = PollPolicy;
module.exports.NOT_LIVE_MESSAGE = NOT_LIVE_MESSAGE;
module.exports.STREAM_ENDED_MESSAGE = STREAM_ENDED_MESSAGE;
module.exports.isOfflineMessage = isOfflineMessage;
module.exports.resolveEncodingConfig = resolveEncodingConfig;
module.exports.diagnoseTask = diagnoseTask;

