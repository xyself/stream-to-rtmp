const db = require('../db');
const rooms = require('../platforms');
const FFmpegService = require('../services/ffmpeg-service');
const views = require('../bot/views');

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36';
const NOT_LIVE_MESSAGE = '主播尚未开播';
const STREAM_ENDED_MESSAGE = 'STREAM_ENDED';

// 熔断阈值：连续多少次推流侧失败后自动禁用任务
const CIRCUIT_BREAKER_THRESHOLD = 20;

// 退避抖动：±20%，避免多任务同时重试打爆平台接口
function withJitter(delay, ratio = 0.2) {
  const delta = delay * ratio;
  return Math.round(delay - delta + Math.random() * delta * 2);
}

// 脱敏：只保留协议+主机名，路径（含推流密钥）打码；用于日志与通知
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
    return withJitter(delay);
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
      // 下播后快轮询加期限：前 10 次 30 秒（约 5 分钟），之后退回常规间隔，
      // 避免整晚高频骚扰平台接口（又浪费又招风控）
      const delay = this.streamEndedAttempts <= 10 ? this.streamEndedDelay : this.notLiveDelay;
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
    this.isBootGrace = isBootGrace; // 启动静默期（#18）：刚重启时不补"已下播"类播报
    this.roomOptions = resolveRoomOptions(task);
    this.room = rooms.create(task.platform, task.room_id, this.roomOptions);
    this.targetUrls = resolveTargetUrls(task);
    this.retryPolicy = new RetryPolicy(task.retryPolicy);
    // 开播轮询按平台分开：斗鱼默认 45 秒（接口松），B站保持 120 秒（防风控）；
    // 用户在任务里显式配了 notLiveDelay 则以用户配置为准
    const pollCfg = { ...(task.pollPolicy || {}) };
    if (task.platform === 'douyu' && pollCfg.notLiveDelay === undefined) {
      pollCfg.notLiveDelay = 45000;
    }
    this.pollPolicy = new PollPolicy(pollCfg);
    this.onNotify = onNotify;
    this.lastNotifyType = null;
    this._pendingTimer = null;
    this._notifyTimer = null;
    this._streamStartedAt = null;
    this.freezeCount = 0;
    this.lastErrorMessage = null;
    this.errorCount = 0;
    this.lastSuccessAt = null;
    this.consecutiveStreamFailures = 0; // 连续推流侧失败次数（熔断用；"未开播"不算）

    // 备用源流线路（B站多 CDN；单线路平台为空）
    this.backupUrls = [];
    this.primaryUrl = null; // 本次取流的主线路地址（自动切回用）
    this.failbackCountdown = 20; // 在备用线路上每 20 次 tick（约 10 分钟）探测一次主线路
    this._failbackProbing = false;
    // 码率下跌告警：本会话码率峰值做基线
    this.bitratePeak = 0;
    this.lowBitrateTicks = 0;
    // 黑帧检测：每 8 次 tick（约 4 分钟）检测一次
    this.blackCheckCountdown = 8;
    this.lastBlackAlertAt = 0;

    // 每日统计（每日小结用；小结推送后清零）
    this.dailyLiveSeconds = 0;
    this.dailyDrops = 0;
    // 本场统计（下播小结用；每次 start 清零）
    this.sessionDrops = 0;

    // 恢复通知追踪：告警类型 -> 首次告警时间戳；恢复时推送"本次中断 X 分钟"（#1）
    this.recoverTrack = {};

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
          this.consecutiveStreamFailures = 0; // 推流成功，熔断计数清零

          const wasOffline = this.lastNotifyType === 'offline' || this.lastNotifyType === 'stream_ended';
          // 报错（取流/推流失败）后恢复也算"回来了"，否则用户只收到报错、收不到恢复通知
          const wasError = this.lastNotifyType === 'error' || this.lastNotifyType === 'ffmpeg_error';
          const shouldNotifyLive = wasOffline || wasError;

          // 异步获取房间信息和截图
          if (this._notifyTimer) clearTimeout(this._notifyTimer);
          this._notifyTimer = setTimeout(async () => {
            this._notifyTimer = null;
            if (this.isStopping || !this.ffmpeg?.getTrafficStats().running) return;

            // 始终尝试获取房间信息
            try {
              this.roomInfo = await this.room.getInfo();
            } catch (err) {
              console.error(`[${this.task.room_id}] 获取房间信息失败:`, err.message);
            }

            if (shouldNotifyLive) {
              let imageBuffer = null;
              try {
                imageBuffer = await this.captureSnapshot();
              } catch (err) {
                console.error(`[${this.task.room_id}] 截图失败:`, err.message);
              }

              const infoLine = this.roomInfo?.hostName
                ? `\n👤 ${this.roomInfo.hostName}` + (this.roomInfo.roomName ? ` — ${this.roomInfo.roomName}` : '')
                : '';

              // 下播后开播 vs 报错后恢复，文案区分开
              // #1：报错后恢复带上中断时长；#5：截图失败时用房间封面兜底
              let recoverSuffix = '';
              if (wasError) {
                const minutes = this.popRecoverMinutes('ffmpeg_error') ?? this.popRecoverMinutes('error');
                if (minutes !== null) {
                  recoverSuffix = `（本次中断约 ${this.formatInterruptMinutes(minutes)}）`;
                }
              }
              const liveMsg = wasOffline ? '🟢 开播了！正在推流中...' : `🟢 推流恢复了${recoverSuffix}，正在推流中...`;
              this.onNotify({
                taskId: this.task.id,
                type: 'live_start',
                message: `${liveMsg}${infoLine}`,
                imageBuffer,
                coverUrl: this.roomInfo?.cover || null,
              });
              // 发完立刻改状态：60 秒内再重连不会重复发（之后 tick 满 60 秒会置为 running）
              this.lastNotifyType = 'live_start';
            }
          }, 5000); // 5秒延迟，确保流稳定且封面已更新
        },
      onError: (err) => {
        if (this.isStopping) return;
        this.handleFfmpegError(err.message);
      },
      onOutputFailed: (targetUrl, reason) => {
        // 多路输出中某一路目标断开：tee 的 onfail=ignore 会默默跳过，这里补一条告警
        if (this.isStopping) return;
        this.onNotify({
          taskId: this.task.id,
          type: 'output_failed',
          message: `推流目标断开: ${maskHost(targetUrl)}，其他线路继续推流中`,
        });
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

    let urls;
    try {
      // 一次取流拿到全部可用线路：主线路在前，备用线路留作故障切换
      urls = await this.room.getStreamUrls();
    } catch (err) {
      if (this.isStopping) return;
      this.handleRoomError(err.message);
      return;
    }

    if (this.isStopping) return;
    const streamUrl = urls[0];
    this.backupUrls = urls.slice(1);
    this.primaryUrl = streamUrl; // 记下主线路（自动切回用）
    // 新会话：码率基线、本场断流计数清零
    this.bitratePeak = 0;
    this.lowBitrateTicks = 0;
    this.sessionDrops = 0;
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
        return;
      }
    } else {
      this.freezeCount = 0;
      if (runtime > 60000 && this.lastNotifyType !== 'running') {
        this.lastNotifyType = 'running';
        this.lastErrorMessage = null;
      }
    }

    // 每日统计：推流秒数累加（tick 每 30 秒一次）
    this.dailyLiveSeconds += 30;

    // 码率下跌告警：运行 5 分钟后，以本会话峰值为基线，
    // 码率跌到峰值一半以下连续 3 次 tick（约 90 秒）则告警（源站限速/网络抖动）
    if (runtime > 300000 && stats.bitrateKbps > 0) {
      this.bitratePeak = Math.max(this.bitratePeak || 0, stats.bitrateKbps);
      if (this.bitratePeak > 500 && stats.bitrateKbps < this.bitratePeak * 0.5) {
        this.lowBitrateTicks += 1;
        if (this.lowBitrateTicks >= 3 && this.lastNotifyType !== 'bitrate_drop') {
          this.lastNotifyType = 'bitrate_drop';
          this.markAlertStart('bitrate_drop'); // #1：记下开始时间
          this.onNotify({
            taskId: this.task.id,
            type: 'bitrate_drop',
            message: `码率大幅下跌: ${Math.round(this.bitratePeak)}k → ${Math.round(stats.bitrateKbps)}k（峰值一半以下持续约 90 秒），可能是源站限速或网络抖动`,
          });
        }
      } else {
        this.lowBitrateTicks = 0;
        if (this.lastNotifyType === 'bitrate_drop') {
          this.lastNotifyType = 'running';
          this.notifyRecovered('bitrate_drop', '码率下跌告警'); // #1：码率回来推恢复
        }
      }
    }

    // 主线路自动切回（#11）：在备用线路上运行时，定期探测主线路是否恢复
    this.failbackCountdown -= 1;
    if (this.failbackCountdown <= 0) {
      this.failbackCountdown = 20;
      this.tryFailbackToPrimary().catch(() => {});
    }

    // 黑帧检测：每 8 次 tick（约 4 分钟）抽查一次，连续黑屏 3 秒以上告警
    // （有些假死码率不为 0：定格末帧、纯黑屏但有音频，冻结检测抓不到）
    this.blackCheckCountdown -= 1;
    if (this.blackCheckCountdown <= 0 && runtime > 120000) {
      this.blackCheckCountdown = 8;
      this.checkBlackFrame().catch(() => {});
    }

    // 每 5 分钟强制检查一次平台侧的开播状态，防止主播下播但流未断开（某些平台的轮播机制）
    if (!this._lastLiveCheckAt || Date.now() - this._lastLiveCheckAt > 300000) {
      this._lastLiveCheckAt = Date.now();
      this.room.getInfo().then(info => {
        if (!info.isLive && this.ffmpeg?.getTrafficStats().running) {
          this.handleStreamEnded(); // 触发正常下播逻辑
        }
      }).catch((err) => {
        console.error(`[${this.task.room_id}] 平台状态检查失败:`, err.message);
      });
    }
  }

  // 黑帧抽查：拉 6 秒流看是否连续黑屏 3 秒以上；1 小时内只告警一次
  async checkBlackFrame() {
    if (this.isStopping || !this.currentStreamUrl) return;
    let isBlack = false;
    try {
      isBlack = await this.ffmpeg.detectBlackFrame(this.currentStreamUrl, { seconds: 6 });
    } catch (err) {
      return; // 检测失败不告警（源流抖动时拉不到 6 秒很常见）
    }
    if (this.isStopping) return;
    if (isBlack && Date.now() - this.lastBlackAlertAt > 3600000) {
      this.lastBlackAlertAt = Date.now();
      this.markAlertStart('black_screen'); // #1：记下开始时间
      this.onNotify({
        taskId: this.task.id,
        type: 'black_screen',
        message: `画面疑似黑屏（连续 3 秒以上黑帧），推流仍在继续，请抽查确认`,
      });
    } else if (!isBlack) {
      this.notifyRecovered('black_screen', '黑屏告警'); // #1：画面回来推恢复
    }
  }

  // 主线路自动切回（#11）：抽帧探测主线路，活了就切回去
  async tryFailbackToPrimary() {
    if (this.isStopping || this._failbackProbing) return;
    if (typeof db.getSetting === 'function' && db.getSetting('auto_failback') === '0') return;
    const primary = this.primaryUrl;
    const current = this.currentStreamUrl;
    if (!primary || !current || primary === current) return;
    if (!this.ffmpeg?.getTrafficStats().running) return; // 没在推就不用切，下次取流自然回到主线路
    this._failbackProbing = true;
    try {
      await this.ffmpeg.captureFrame(primary, { platform: this.task.platform, timeout: 15000 });
    } catch (err) {
      this._failbackProbing = false;
      return; // 主线路还没好，下次再试
    }
    if (this.isStopping) { this._failbackProbing = false; return; }
    this._failbackProbing = false;
    console.log(`[${this.task.room_id}] 主线路已恢复，自动切回`);
    this.stopStreaming();
    this.consecutiveStreamFailures = 0;
    this.bitratePeak = 0;
    this.lowBitrateTicks = 0;
    this.currentStreamUrl = primary;
    this.backupUrls = [];
    this.process = this.ffmpeg.start(primary);
    this.onNotify({
      taskId: this.task.id,
      type: 'failover',
      message: `主线路已恢复，自动切回主线路继续推流`,
    });
  }

  // 每日小结用统计
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

  // ---- 恢复通知（#1）：告警时记下开始时间，恢复时推"本次中断 X 分钟" ----
  markAlertStart(type) {
    if (!this.recoverTrack[type]) this.recoverTrack[type] = Date.now();
  }

  // 取出某告警的中断时长（分钟）并清除追踪；没追踪过返回 null
  popRecoverMinutes(type) {
    const startedAt = this.recoverTrack[type];
    if (!startedAt) return null;
    delete this.recoverTrack[type];
    return Math.max(1, Math.round((Date.now() - startedAt) / 60000));
  }

  clearRecoverTrack() {
    this.recoverTrack = {};
  }

  formatInterruptMinutes(minutes) {
    if (minutes >= 60) return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
    return `${minutes} 分钟`;
  }

  // 某告警恢复：推一条"✅ …已恢复，本次中断约 X 分钟"
  notifyRecovered(type, desc) {
    const minutes = this.popRecoverMinutes(type);
    if (minutes === null) return;
    this.onNotify({
      taskId: this.task.id,
      type: 'recover',
      message: `${desc}已恢复，本次中断约 ${this.formatInterruptMinutes(minutes)}`,
    });
  }

  handleRoomError(msg) {
    this.errorCount += 1;
    this.saveSessionStats();
    this.stopStreaming();
    db.updateError(this.task.id, msg);
    this.clearRecoverTrack(); // 会话结束，未完成的恢复追踪清掉

    // 判断错误类型：扩大未开播关键词覆盖
    const lowerMsg = msg.toLowerCase();
    const isOffline = lowerMsg.includes('房间未开播') ||
                      lowerMsg.includes('未开播') ||
                      lowerMsg.includes('主播尚未开播') ||
                      lowerMsg.includes('not live') ||
                      lowerMsg.includes('offline') ||
                      lowerMsg.includes('未直播') ||
                      lowerMsg.includes('live status is 0');
    const isRateLimited = lowerMsg.includes('限流') || lowerMsg.includes('rate limit');
    const errorType = isOffline ? 'offline' : 'error';

    if (isOffline) {
      if (this.lastNotifyType !== 'offline') {
        this.lastNotifyType = 'offline';
        this.lastErrorMessage = null; // 重置错误消息，因为现在是下播状态
        // #18：刚重启的静默期内不补"已下播"播报（避免每次重启刷一堆）
        if (!this.isBootGrace?.()) {
          const hostLabel = this.roomInfo?.hostName ? ` (${this.roomInfo.hostName})` : '';
          this.onNotify({
            taskId: this.task.id,
            type: 'offline',
            message: `主播${hostLabel}已下播，正在监测中...`,
          });
        }
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
    if (isRateLimited) {
      // 限流类错误走退避重试（越限越慢），而不是固定 2 分钟轮询去撞墙
      this.pollPolicy.reset();
      this.scheduleStart(this.retryPolicy.nextDelay());
    } else {
      this.scheduleStart(delay);
    }
  }

  async handleFfmpegError(msg) {
    // 先验播：FFmpeg 报错时先查平台真实开播状态。
    // 下播时源流无数据→输出空转→接收端掐连接（224 broken pipe 等），
    // 本质是"正常结束"不是故障，直接走下播流程，不发误报
    try {
      const info = await this.room.getInfo();
      if (this.isStopping) return;
      if (info && info.isLive === false) {
        console.log(`[${this.task.room_id}] 平台显示已下播，FFmpeg 报错按正常结束处理`);
        this.handleStreamEnded();
        return;
      }
    } catch (err) {
      // 平台查不到（接口挂/风控）：按原流程走，宁可误报、不可漏报
      if (this.isStopping) return;
      console.error(`[${this.task.room_id}] 下播预检失败，按故障处理:`, err.message);
    }

    this.errorCount += 1;
    this.consecutiveStreamFailures += 1;
    this.saveSessionStats();
    this.stopStreaming();
    db.updateError(this.task.id, msg);

    // 熔断：连续 20 次推流侧失败（不含"主播未开播"），自动禁用任务，
    // 避免某个坏掉的任务无限烧平台接口 + 刷屏
    if (this.consecutiveStreamFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      db.updateTaskStatus?.(this.task.id, 'DISABLED');
      this.onNotify({
        taskId: this.task.id,
        type: 'error',
        message: `任务已自动熔断：连续 ${this.consecutiveStreamFailures} 次推流失败，已暂停该任务（手动开启可恢复）`,
      });
      return; // 不再排期；scheduler.tick 会清理掉已禁用的 manager
    }

    if (this.lastNotifyType !== 'ffmpeg_error' || this.lastErrorMessage !== msg) {
      this.lastNotifyType = 'ffmpeg_error';
      this.lastErrorMessage = msg;
      this.markAlertStart('ffmpeg_error'); // #1：记下断流开始时间，恢复时算时长
      this.onNotify({
        taskId: this.task.id,
        type: 'ffmpeg_error',
        message: `推流出错: ${msg}`,
      });
    }

    // 检测流 URL 过期错误（B站等平台的签名过期），立即重新获取新 URL
    // 注意 ffmpeg 原文是 "Error opening input files"（复数），HTTP 层会报 404
    const isUrlExpired = /error opening input files?/i.test(msg) ||
                         /input\/output error/i.test(msg) ||
                         /\b404\b/.test(msg) ||
                         /exited with code (251|403)/.test(msg);

    let delay;
    if (isUrlExpired) {
      delay = 20000; // URL 过期：20 秒后重新获取新 URL
      this.retryPolicy.reset(); // 重置重试计数
    } else if (this.tryFailover(msg)) {
      return; // 已切换到备用线路，立即重推，不走退避
    } else {
      delay = this.retryPolicy.nextDelay();
    }

    this.dailyDrops += 1; // 记一次断流（每日小结用；备用线路切换不算断流）
    this.sessionDrops += 1; // 本场断流（下播小结用）
    this.scheduleStart(delay);
  }

  // 备用线路切换：输入侧故障（非 URL 过期类）且有备用线路时，立即换线路重推
  // 返回 true = 已切换，调用方直接 return
  tryFailover(msg) {
    if (!this.backupUrls || this.backupUrls.length === 0) return false;
    const isInputError = /error opening input|input\/output error|connection (reset|refused|timed out)|http error|failed to resolve|server returned/i.test(msg);
    if (!isInputError) return false;

    const backupUrl = this.backupUrls.shift();
    console.log(`[${this.task.room_id}] 输入线路故障，切换备用线路: ${maskHost(backupUrl)}（剩余 ${this.backupUrls.length} 条）`);
    // 切换线路不算连续失败：避免"主线路坏+切线路"被误计入熔断
    this.consecutiveStreamFailures = 0;
    this.bitratePeak = 0;
    this.lowBitrateTicks = 0;
    this.currentStreamUrl = backupUrl;
    this.process = this.ffmpeg.start(backupUrl);
    this.onNotify({
      taskId: this.task.id,
      type: 'failover',
      message: `输入线路故障，已自动切换到备用线路继续推流`,
    });
    return true;
  }

  // TG 面板「🔀 切换线路」：主动换下一条备用线路
  manualFailover() {
    if (!this.backupUrls || this.backupUrls.length === 0) return false;
    const backupUrl = this.backupUrls.shift();
    console.log(`[${this.task.room_id}] 手动切换备用线路: ${maskHost(backupUrl)}（剩余 ${this.backupUrls.length} 条）`);
    this.stopStreaming();
    this.consecutiveStreamFailures = 0;
    this.bitratePeak = 0;
    this.lowBitrateTicks = 0;
    this.currentStreamUrl = backupUrl;
    this.process = this.ffmpeg.start(backupUrl);
    this.onNotify({
      taskId: this.task.id,
      type: 'failover',
      message: `已手动切换到备用线路继续推流`,
    });
    return true;
  }

  handleStreamEnded() {
    // #4 下播小结：先取本场数据（saveSessionStats 之前拿 sessionBytes）
    const sessBytes = this.ffmpeg?.getTrafficStats().sessionBytes || 0;
    const durationSec = this._streamStartedAt ? Math.round((Date.now() - this._streamStartedAt) / 1000) : 0;
    const hadSession = durationSec > 0;
    this.saveSessionStats();
    this.stopStreaming();
    db.updateError(this.task.id, STREAM_ENDED_MESSAGE);
    this.clearRecoverTrack(); // 会话结束，未完成的恢复追踪清掉

    if (this.lastNotifyType !== 'stream_ended') {
      this.lastNotifyType = 'stream_ended';
      // #18：刚重启的静默期内不补"直播结束"播报
      if (!this.isBootGrace?.()) {
        const hostLabel = this.roomInfo?.hostName ? ` (${this.roomInfo.hostName})` : '';
        this.onNotify({
          taskId: this.task.id,
          type: 'stream_ended',
          message: `直播已结束${hostLabel}，等待下一场直播...`,
        });
      }
    }

    // #4：真播过一场才推小结（刚启动就结束/误触发不打扰）
    if (hadSession) {
      this.onNotify({
        taskId: this.task.id,
        type: 'session_summary',
        message: views.renderSessionSummary({
          platform: this.task.platform,
          roomId: this.task.room_id,
          hostName: this.roomInfo?.hostName,
          durationSec,
          drops: this.sessionDrops,
          peakKbps: Math.round(this.bitratePeak || 0),
          bytes: sessBytes,
        }),
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
    const stopped = this.ffmpeg.stop();
    this.process = null;
    return stopped; // Promise：FFmpeg 进程真正退出后 resolve（优雅关闭时 await 用）
  }

  stop() {
    this.isStopping = true;
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
