const db = require('../db');
const rooms = require('../platforms');
const FFmpegService = require('../services/ffmpeg-service');

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36';
const NOT_LIVE_MESSAGE = '主播尚未开播';
const STREAM_ENDED_MESSAGE = 'STREAM_ENDED';

function resolveTargetUrls(task) {
  if (Array.isArray(task.targets) && task.targets.length > 0) {
    return task.targets.map((target) => target.target_url).filter(Boolean);
  }

  if (typeof db.getTaskTargets === 'function') {
    return db.getTaskTargets(task.id).map((target) => target.target_url).filter(Boolean);
  }

  return [task.primary_target_url || task.target_url].filter(Boolean);
}

function buildDefaultHeaders(platform, roomId) {
  if (platform === 'bilibili') {
    return {
      Referer: `https://live.bilibili.com/${roomId}`,
      'User-Agent': DEFAULT_USER_AGENT,
    };
  }

  if (platform === 'douyu') {
    return {
      Referer: `https://www.douyu.com/${roomId}`,
      'User-Agent': DEFAULT_USER_AGENT,
    };
  }

  return { 'User-Agent': DEFAULT_USER_AGENT };
}

function resolveRoomOptions(task) {
  return {
    headers: {
      ...buildDefaultHeaders(task.platform, task.room_id),
      ...(task.headers || {}),
    },
    metadata: {
      taskId: task.id,
      platform: task.platform,
      ...(task.metadata || {}),
    },
  };
}

class RetryPolicy {
  constructor({ baseDelay = 30000, stepDelay = 10000, maxDelay = 300000 } = {}) {
    this.baseDelay = baseDelay;
    this.stepDelay = stepDelay;
    this.maxDelay = maxDelay;
    this.attempts = 0;
  }

  nextDelay() {
    const delay = Math.min(this.attempts * this.stepDelay + this.baseDelay, this.maxDelay);
    this.attempts += 1;
    return delay;
  }

  reset() {
    this.attempts = 0;
  }
}

class PollPolicy {
  constructor({ notLiveDelay = 120000, streamEndedDelay = 30000 } = {}) {
    this.notLiveDelay = notLiveDelay;
    this.streamEndedDelay = streamEndedDelay;
    this.notLiveAttempts = 0;
    this.streamEndedAttempts = 0;
  }

  nextDelay(reason) {
    if (reason === STREAM_ENDED_MESSAGE) {
      this.streamEndedAttempts += 1;
      return this.streamEndedDelay;
    }

    this.notLiveAttempts += 1;
    return this.notLiveDelay;
  }

  reset() {
    this.notLiveAttempts = 0;
    this.streamEndedAttempts = 0;
  }
}

class StreamManager {
  constructor(task, { onNotify = () => {} } = {}) {
    this.task = task;
    this.roomOptions = resolveRoomOptions(task);
    this.room = rooms.create(task.platform, task.room_id, this.roomOptions);
    this.targetUrls = resolveTargetUrls(task);
    this.retryPolicy = new RetryPolicy(task.retryPolicy);
    this.pollPolicy = new PollPolicy(task.pollPolicy);
    this.onNotify = onNotify;
    this.lastNotifyType = null;
    this._pendingTimer = null;
    this._notifyTimer = null;
    this._streamStartedAt = null;
    this.freezeCount = 0;
    this.lastErrorMessage = null;
    this.errorCount = 0;
    this.lastSuccessAt = null;

    // 流量统计相关
    this.trafficStats = {
      totalBytes: 0,      // 累计发送字节（跨会话）
      lastRefreshAt: null, // 最近一次显式刷新时间
    };
    this.currentStreamUrl = null; // 当前会话使用的源流地址
    this.roomInfo = null; // 缓存房间信息 { hostName, roomName, isLive }
    
    this.ffmpeg = new FFmpegService({
      roomId: task.room_id,
      targetUrls: this.targetUrls,
      inputHeaders: this.roomOptions.headers,
      globalOutputOptions: task.ffmpeg?.outputOptions || [],
      transcodeVideo: db.getSetting?.('transcode_video') === '1',
        onStart: () => {
          db.updateError(this.task.id, null);
          this._streamStartedAt = Date.now();
          this.lastSuccessAt = new Date().toISOString();

          const wasOffline = this.lastNotifyType === 'offline' || this.lastNotifyType === 'stream_ended';
          
          // 异步获取房间信息和截图
          setTimeout(async () => {
            if (this.isStopping || !this.ffmpeg?.getTrafficStats().running) return;
            
            // 始终尝试获取房间信息
            try {
              this.roomInfo = await this.room.getInfo();
            } catch (err) {}

            if (wasOffline) {
              let imageBuffer = null;
              try {
                imageBuffer = await this.captureSnapshot();
              } catch (err) {}

              const infoLine = this.roomInfo?.hostName
                ? `\n👤 ${this.roomInfo.hostName}` + (this.roomInfo.roomName ? ` — ${this.roomInfo.roomName}` : '')
                : '';

              this.onNotify({
                taskId: this.task.id,
                type: 'live_start',
                message: `🟢 开播了！正在推流中...${infoLine}`,
                imageBuffer,
              });
            }
          }, 5000); // 5秒延迟，确保流稳定且封面已更新
        },
      onError: (err) => {
        if (this.isStopping) return;
        this.handleFfmpegError(err.message);
      },
      onEnd: () => {
        if (this.isStopping) return;
        this.handleStreamEnded();
      },
    });
    this.process = null;
    this.isStopping = false;
  }

  async start() {
    this.isStopping = false;

    let streamUrl;
    try {
      streamUrl = await this.room.getStreamUrl();
    } catch (err) {
      if (this.isStopping) return;
      this.handleRoomError(err.message);
      return;
    }

    if (this.isStopping) return;
    this.currentStreamUrl = streamUrl;
    this.process = this.ffmpeg.start(streamUrl);
    this.trafficStats.lastRefreshAt = new Date().toISOString();
    this.retryPolicy.reset();
    this.pollPolicy.reset();
  }

  async captureSnapshot() {
    try {
      let streamUrl = null;
      let source = 'fresh-source';

      // 优先使用当前正在运行的流地址
      if (this.currentStreamUrl && this.ffmpeg && this.ffmpeg.getTrafficStats().running) {
        streamUrl = this.currentStreamUrl;
        source = 'running-stream';
      } else {
        // 否则获取最新的源流地址
        streamUrl = await this.room.getStreamUrl();
        source = 'fresh-source';
      }

      if (!streamUrl) {
        throw new Error('无法获取有效的直播流地址');
      }

      return await this.ffmpeg.captureFrame(streamUrl, {
        platform: this.task.platform,
        timeout: 25000, // 25秒超时用于B站等特殊平台
      });
    } catch (err) {
      throw new Error(`流不可用: ${err.message}`);
    }
  }

  getTrafficStats() {
    // 获取当前 FFmpeg 会话的统计
    const ffmpegStats = this.ffmpeg.getTrafficStats();

    // 将当前会话的字节并入累计总量
    const currentSessionBytes = ffmpegStats.sessionBytes || 0;
    
    // 返回合并后的统计
    return {
      totalBytes: this.trafficStats.totalBytes + currentSessionBytes,
      sessionBytes: currentSessionBytes,
      bitrateKbps: ffmpegStats.bitrateKbps || 0,
      updatedAt: ffmpegStats.updatedAt,
      startedAt: ffmpegStats.startedAt,
      running: ffmpegStats.running || false,
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
    } catch (err) {
      return null;
    }
  }

  checkHealth() {
    if (this.isStopping || !this.ffmpeg) return;
    const stats = this.ffmpeg.getTrafficStats();
    if (!stats.running) return;

    // 如果流已经运行超过 2 分钟，且码率为 0，则增加冻结计数
    const runtime = Date.now() - (this._streamStartedAt || 0);
    if (runtime > 120000 && stats.bitrateKbps === 0) {
      this.freezeCount += 1;
      if (this.freezeCount >= 4) { // 连续 4 次 tick (约 2 分钟)
        this.freezeCount = 0;
        this.handleFfmpegError('检测到画面冻结 (Bitrate 0)，正在自动重启...');
      }
    } else {
      this.freezeCount = 0;
      if (runtime > 60000 && this.lastNotifyType !== 'running') {
        this.lastNotifyType = 'running';
        this.lastErrorMessage = null;
      }
    }

    // 每 5 分钟强制检查一次平台侧的开播状态，防止主播下播但流未断开（某些平台的轮播机制）
    if (!this._lastLiveCheckAt || Date.now() - this._lastLiveCheckAt > 300000) {
      this._lastLiveCheckAt = Date.now();
      this.room.getInfo().then(info => {
        if (!info.isLive && this.ffmpeg?.getTrafficStats().running) {
          this.handleStreamEnded(); // 触发正常下播逻辑
        }
      }).catch(() => {});
    }
  }

  enableStats() {
    return this.ffmpeg.enableStats();
  }

  disableStats() {
    return this.ffmpeg.disableStats();
  }

  // 保存本次会话统计到累计总量
  saveSessionStats() {
    const ffmpegStats = this.ffmpeg.getTrafficStats();
    if (ffmpegStats.sessionBytes) {
      this.trafficStats.totalBytes += ffmpegStats.sessionBytes;
    }
  }

  formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  handleRoomError(msg) {
    this.errorCount += 1;
    this.saveSessionStats();
    this.stopStreaming();
    db.updateError(this.task.id, msg);

    // 判断错误类型：扩大未开播关键词覆盖
    const lowerMsg = msg.toLowerCase();
    const isOffline = lowerMsg.includes('房间未开播') ||
                      lowerMsg.includes('未开播') ||
                      lowerMsg.includes('主播尚未开播') ||
                      lowerMsg.includes('not live') ||
                      lowerMsg.includes('offline') ||
                      lowerMsg.includes('未直播') ||
                      lowerMsg.includes('live status is 0');
    const errorType = isOffline ? 'offline' : 'error';

    if (isOffline) {
      if (this.lastNotifyType !== 'offline') {
        this.lastNotifyType = 'offline';
        this.lastErrorMessage = null; // 重置错误消息，因为现在是下播状态
        const hostLabel = this.roomInfo?.hostName ? ` (${this.roomInfo.hostName})` : '';
        this.onNotify({
          taskId: this.task.id,
          type: 'offline',
          message: `主播${hostLabel}已下播，正在监测中...`,
        });
      }
    } else {
      if (this.lastNotifyType !== 'error' || this.lastErrorMessage !== msg) {
        this.lastNotifyType = 'error';
        this.lastErrorMessage = msg;
        this.onNotify({
          taskId: this.task.id,
          type: 'error',
          message: `遇到错误: ${msg}`,
        });
      }
    }

    const delay = this.pollPolicy.nextDelay(msg);
    this.retryPolicy.reset();
    this.scheduleStart(delay);
  }

  handleFfmpegError(msg) {
    this.errorCount += 1;
    this.saveSessionStats();
    this.stopStreaming();
    db.updateError(this.task.id, msg);

    if (this.lastNotifyType !== 'ffmpeg_error' || this.lastErrorMessage !== msg) {
      this.lastNotifyType = 'ffmpeg_error';
      this.lastErrorMessage = msg;
      this.onNotify({
        taskId: this.task.id,
        type: 'ffmpeg_error',
        message: `推流出错: ${msg}`,
      });
    }

    // 检测流 URL 过期错误（B站等平台的签名过期），立即重新获取新 URL
    const isUrlExpired = msg.includes('Error opening input file') ||
                         msg.includes('Input/output error') ||
                         msg.includes('exited with code 251') ||
                         msg.includes('exited with code 403');

    let delay;
    if (isUrlExpired) {
      delay = 20000; // URL 过期：20 秒后重新获取新 URL
      this.retryPolicy.reset(); // 重置重试计数
    } else {
      delay = this.retryPolicy.nextDelay();
    }

    this.scheduleStart(delay);
  }

  handleStreamEnded() {
    this.saveSessionStats();
    this.stopStreaming();
    db.updateError(this.task.id, STREAM_ENDED_MESSAGE);

    if (this.lastNotifyType !== 'stream_ended') {
      this.lastNotifyType = 'stream_ended';
      const hostLabel = this.roomInfo?.hostName ? ` (${this.roomInfo.hostName})` : '';
      this.onNotify({
        taskId: this.task.id,
        type: 'stream_ended',
        message: `直播已结束${hostLabel}，等待下一场直播...`,
      });
    }

    const delay = this.pollPolicy.nextDelay(STREAM_ENDED_MESSAGE);
    this.retryPolicy.reset();
    this.scheduleStart(delay);
  }

  handleError(msg) {
    this.handleFfmpegError(msg);
  }

  scheduleStart(delay) {
    if (this._pendingTimer) {
      clearTimeout(this._pendingTimer);
    }
    this._pendingTimer = setTimeout(() => {
      this._pendingTimer = null;
      if (this.isStopping) return;
      this.start();
    }, delay);
  }

  stopStreaming() {
    if (this._notifyTimer) {
      clearTimeout(this._notifyTimer);
      this._notifyTimer = null;
    }
    this.ffmpeg.stop();
    this.process = null;
  }

  stop() {
    this.isStopping = true;
    if (this._pendingTimer) {
      clearTimeout(this._pendingTimer);
      this._pendingTimer = null;
    }
    this.stopStreaming();
  }
}

module.exports = StreamManager;
module.exports.RetryPolicy = RetryPolicy;
module.exports.PollPolicy = PollPolicy;
module.exports.NOT_LIVE_MESSAGE = NOT_LIVE_MESSAGE;
module.exports.STREAM_ENDED_MESSAGE = STREAM_ENDED_MESSAGE;
