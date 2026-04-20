const db = require('../db');
const rooms = require('../rooms');
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
  constructor({ notLiveDelay = 30000, streamEndedDelay = 30000 } = {}) {
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
  constructor(task) {
    this.task = task;
    this.roomOptions = resolveRoomOptions(task);
    this.room = rooms.create(task.platform, task.room_id, this.roomOptions);
    this.targetUrls = resolveTargetUrls(task);
    this.retryPolicy = new RetryPolicy(task.retryPolicy);
    this.pollPolicy = new PollPolicy(task.pollPolicy);
    this.ffmpeg = new FFmpegService({
      roomId: task.room_id,
      targetUrls: this.targetUrls,
      inputHeaders: this.roomOptions.headers,
      globalOutputOptions: task.ffmpeg?.outputOptions || [],
      onStart: () => {
        console.log(`[推流启动] 房间: ${this.task.room_id}`);
        db.updateError(this.task.id, null);
      },
      onError: (err) => {
        if (this.isStopping) return;
        this.handleFfmpegError(err.message);
      },
      onEnd: () => {
        if (this.isStopping) return;
        console.log('[推流结束] 主播可能下播，准备进入轮询...');
        this.handleStreamEnded();
      },
    });
    this.process = null;
    this.isStopping = false;
  }

  async start() {
    this.isStopping = false;
    console.log(`[${this.task.room_id}] 正在准备推流...`);

    try {
      const streamUrl = await this.room.getStreamUrl();
      this.process = this.ffmpeg.start(streamUrl);
      this.retryPolicy.reset();
      this.pollPolicy.reset();
    } catch (err) {
      this.handleRoomError(err.message);
    }
  }

  async captureSnapshot() {
    try {
      const streamUrl = await this.room.getStreamUrl();
      return this.ffmpeg.captureFrame(streamUrl);
    } catch (err) {
      throw new Error(`流不可用: ${err.message}`);
    }
  }

  handleRoomError(msg) {
    this.stopStreaming();
    db.updateError(this.task.id, msg);

    const delay = this.pollPolicy.nextDelay(msg);
    this.retryPolicy.reset();
    console.log(`[${this.task.room_id}] 异常: ${msg}。将在 ${delay / 1000}s 后重试...`);
    this.scheduleStart(delay);
  }

  handleFfmpegError(msg) {
    this.stopStreaming();
    db.updateError(this.task.id, msg);

    const delay = this.retryPolicy.nextDelay();
    console.log(`[${this.task.room_id}] 异常: ${msg}。将在 ${delay / 1000}s 后重试...`);
    this.scheduleStart(delay);
  }

  handleStreamEnded() {
    this.stopStreaming();
    db.updateError(this.task.id, STREAM_ENDED_MESSAGE);

    const delay = this.pollPolicy.nextDelay(STREAM_ENDED_MESSAGE);
    this.retryPolicy.reset();
    console.log(`[${this.task.room_id}] 异常: ${STREAM_ENDED_MESSAGE}。将在 ${delay / 1000}s 后重试...`);
    this.scheduleStart(delay);
  }

  handleError(msg) {
    this.handleFfmpegError(msg);
  }

  scheduleStart(delay) {
    setTimeout(() => {
      if (this.isStopping) return;
      this.start();
    }, delay);
  }

  stopStreaming() {
    this.ffmpeg.stop();
    this.process = null;
  }

  stop() {
    this.isStopping = true;
    this.stopStreaming();
  }
}

module.exports = StreamManager;
module.exports.RetryPolicy = RetryPolicy;
module.exports.PollPolicy = PollPolicy;
module.exports.NOT_LIVE_MESSAGE = NOT_LIVE_MESSAGE;
module.exports.STREAM_ENDED_MESSAGE = STREAM_ENDED_MESSAGE;
