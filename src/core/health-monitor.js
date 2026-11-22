const config = require('../config');

/**
 * 独立流健康监测器（从 StreamManager 解耦）
 * 职责：冻结检测、码率暴跌检测与恢复、黑帧周期抽检、主备自动回切探测、中断恢复计时。
 */
class StreamHealthMonitor {
  constructor({ healthConfig = config.health, now = () => Date.now() } = {}) {
    this.cfg = { ...config.health, ...healthConfig };
    this.now = now;
    this.resetSession();
    this.lastBlackAlertAt = 0;
    this.lastLiveCheckAt = 0;
    this.recoverTrack = {};
    this._failbackProbing = false;
  }

  resetSession() {
    this.freezeCount = 0;
    this.bitratePeak = 0;
    this.lowBitrateTicks = 0;
    this.lastCheckedBytes = null;
    this.consecutiveOfflineChecks = 0;
    this.failbackCountdown = this.cfg.failbackIntervalTicks;
    this.blackCheckCountdown = this.cfg.blackCheckIntervalTicks;
  }

  recordLiveVerifyResult(isLive, { immediateOnStall = false } = {}) {
    if (isLive) {
      this.consecutiveOfflineChecks = 0;
      return false;
    }
    this.consecutiveOfflineChecks += 1;
    const threshold = immediateOnStall ? 1 : Math.max(1, this.cfg.offlineConfirmCount || 2);
    return this.consecutiveOfflineChecks >= threshold;
  }

  markAlertStart(type) {
    if (!this.recoverTrack[type]) {
      this.recoverTrack[type] = this.now();
    }
  }

  popRecoverMinutes(type) {
    const startedAt = this.recoverTrack[type];
    if (!startedAt) return null;
    delete this.recoverTrack[type];
    return Math.max(1, Math.round((this.now() - startedAt) / 60000));
  }

  clearRecoverTrack() {
    this.recoverTrack = {};
  }

  static formatInterruptMinutes(minutes) {
    if (minutes >= 60) {
      return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
    }
    return `${minutes} 分钟`;
  }

  /**
   * 评估一次健康 tick，返回触发的动作集合：
   * - frozen: boolean（需要立即重启 FFmpeg）
   * - freezeReason: string | null（冻结具体原因：码率为0 / 进度停滞 / 字节未增长）
   * - isStalling: boolean（当前 tick 已出现停滞迹象）
   * - markRunning: boolean（运行满 60 秒且正常）
   * - bitrateDropAlert: string | null
   * - bitrateRecovered: boolean
   * - shouldProbeFailback: boolean
   * - shouldCheckBlackFrame: boolean
   * - shouldVerifyLiveStatus: boolean
   */
  evaluateTick({ runtimeMs, bitrateKbps, lastNotifyType, sessionBytes, lastProgressAt } = {}) {
    const nowMs = this.now();
    const result = {
      frozen: false,
      freezeReason: null,
      isStalling: false,
      markRunning: false,
      bitrateDropAlert: null,
      bitrateRecovered: false,
      shouldProbeFailback: false,
      shouldCheckBlackFrame: false,
      shouldVerifyLiveStatus: false,
    };

    const staleThreshold = this.cfg.progressStaleMs || 45000;
    const progressStale =
      typeof lastProgressAt === 'number' && lastProgressAt > 0
        ? nowMs - lastProgressAt > staleThreshold
        : lastProgressAt === null && runtimeMs > staleThreshold;
    const bytesStagnant =
      typeof sessionBytes === 'number' &&
      this.lastCheckedBytes !== null &&
      sessionBytes <= this.lastCheckedBytes;

    if (typeof sessionBytes === 'number') {
      this.lastCheckedBytes = sessionBytes;
    }

    const isZeroBitrate = (bitrateKbps || 0) <= 0;
    const progressFresh =
      typeof lastProgressAt === 'number' && lastProgressAt > 0 && nowMs - lastProgressAt <= staleThreshold;
    const stalledThisTick =
      runtimeMs > this.cfg.freezeGraceMs &&
      (progressStale || (!progressFresh && (isZeroBitrate || bytesStagnant)));

    // 1. 画面冻结 / 僵尸流检测（综合码率为 0、进度无更新、字节停滞三个维度）
    if (stalledThisTick) {
      result.isStalling = true;
      this.freezeCount += 1;
      const reason = progressStale
        ? 'FFmpeg 进度长时间停滞'
        : bytesStagnant
          ? '推流字节停止增长'
          : 'Bitrate 0';

      if (this.freezeCount >= this.cfg.freezeTicksThreshold) {
        this.freezeCount = 0;
        result.frozen = true;
        result.freezeReason = reason;
        return result;
      }

      // 刚出现卡顿时提前复核一次平台开播状态（避免在 -reconnect_at_eof 里苦等 5 分钟）
      if (!this.lastLiveCheckAt || nowMs - this.lastLiveCheckAt > 15000) {
        this.lastLiveCheckAt = nowMs;
        result.shouldVerifyLiveStatus = true;
      }
      return result;
    } else {
      this.freezeCount = 0;
      if (runtimeMs > 60000 && lastNotifyType !== 'running' && lastNotifyType !== 'bitrate_drop') {
        result.markRunning = true;
      }
    }

    // 2. 码率下跌告警与恢复
    if (runtimeMs > this.cfg.bitrateDropGraceMs && bitrateKbps > 0) {
      this.bitratePeak = Math.max(this.bitratePeak || 0, bitrateKbps);
      if (this.bitratePeak > 500 && bitrateKbps < this.bitratePeak * this.cfg.bitrateDropRatio) {
        this.lowBitrateTicks += 1;
        if (this.lowBitrateTicks >= this.cfg.bitrateDropTicksThreshold && lastNotifyType !== 'bitrate_drop') {
          this.markAlertStart('bitrate_drop');
          result.bitrateDropAlert =
            `码率大幅下跌: ${Math.round(this.bitratePeak)}k → ${Math.round(bitrateKbps)}k（峰值一半以下持续约 90 秒），可能是源站限速或网络抖动`;
        }
      } else {
        this.lowBitrateTicks = 0;
        if (lastNotifyType === 'bitrate_drop') {
          result.bitrateRecovered = true;
        }
      }
    }

    // 3. 主线路回切倒计时
    this.failbackCountdown -= 1;
    if (this.failbackCountdown <= 0) {
      this.failbackCountdown = this.cfg.failbackIntervalTicks;
      result.shouldProbeFailback = true;
    }

    // 4. 黑帧检测倒计时
    this.blackCheckCountdown -= 1;
    if (this.blackCheckCountdown <= 0 && runtimeMs > this.cfg.freezeGraceMs) {
      this.blackCheckCountdown = this.cfg.blackCheckIntervalTicks;
      result.shouldCheckBlackFrame = true;
    }

    // 5. 平台在播状态定期复核
    if (!this.lastLiveCheckAt || nowMs - this.lastLiveCheckAt > this.cfg.liveVerifyIntervalMs) {
      this.lastLiveCheckAt = nowMs;
      result.shouldVerifyLiveStatus = true;
    }

    return result;
  }
}

module.exports = StreamHealthMonitor;
