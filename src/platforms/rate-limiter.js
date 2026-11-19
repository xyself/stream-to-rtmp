const config = require('../config');

const DEFAULT_PLATFORM_INTERVALS_MS = {
  ...config.rateLimitMs,
};

class PlatformRateLimiter {
  constructor(intervalsMs = {}, { now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.intervalsMs = { ...DEFAULT_PLATFORM_INTERVALS_MS, ...intervalsMs };
    this.now = now;
    this.sleep = sleep;
    this.queues = new Map();
  }

  getInterval(platform) {
    const key = platform || 'default';
    return this.intervalsMs[key] ?? this.intervalsMs.default ?? 1000;
  }

  schedule(platform, fn) {
    const key = platform || 'default';
    const interval = this.getInterval(key);
    let entry = this.queues.get(key);
    if (!entry) {
      entry = { tail: Promise.resolve(), lastCompletedAt: 0 };
      this.queues.set(key, entry);
    }

    const runTask = async () => {
      if (interval > 0 && entry.lastCompletedAt > 0) {
        const elapsed = this.now() - entry.lastCompletedAt;
        const waitMs = interval - elapsed;
        if (waitMs > 0) {
          await this.sleep(waitMs);
        }
      }
      try {
        return await fn();
      } finally {
        entry.lastCompletedAt = this.now();
      }
    };

    const next = entry.tail.then(runTask, runTask);
    entry.tail = next.catch(() => {});
    return next;
  }
}

module.exports = new PlatformRateLimiter();
module.exports.PlatformRateLimiter = PlatformRateLimiter;
module.exports.DEFAULT_PLATFORM_INTERVALS_MS = DEFAULT_PLATFORM_INTERVALS_MS;
