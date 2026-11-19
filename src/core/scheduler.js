const config = require('../config');
const db = require('../db');
const StreamManager = require('./manager');

class Scheduler {
  constructor({ onNotify = () => {} } = {}) {
    this.runningManagers = new Map();
    this.timer = null;
    this.onNotify = onNotify;
    this.bootGraceUntil = 0;
  }

  buildTaskKey(task) {
    return `${task.platform}:${task.room_id}`;
  }

  isTaskRunning(task) {
    return this.runningManagers.has(this.buildTaskKey(task));
  }

  getTaskManager(task) {
    return this.runningManagers.get(this.buildTaskKey(task));
  }

  createManager(task) {
    const manager = new StreamManager(task, {
      onNotify: this.onNotify,
      isBootGrace: () => Date.now() < this.bootGraceUntil,
    });
    this.runningManagers.set(this.buildTaskKey(task), manager);
    return manager;
  }

  removeManager(task) {
    this.runningManagers.delete(this.buildTaskKey(task));
  }

  stopManager(task) {
    const taskKey = this.buildTaskKey(task);
    const manager = this.runningManagers.get(taskKey);
    if (!manager) return;
    manager.stop();
    this.runningManagers.delete(taskKey);
  }

  async refreshTask(task) {
    if (!task) return;
    this.stopManager(task);
    if (task.status !== 'ENABLED') return;

    const latestTask = db.getTaskById?.(task.id) || task;
    const manager = this.createManager(latestTask);
    await manager.start();
  }

  async tick() {
    const enabledTasks = db.getEnabledTasks();
    const enabledKeys = new Set(enabledTasks.map((task) => this.buildTaskKey(task)));

    for (const [taskKey, manager] of this.runningManagers.entries()) {
      if (!enabledKeys.has(taskKey)) {
        manager.stop();
        this.runningManagers.delete(taskKey);
      } else if (typeof manager.checkHealth === 'function') {
        manager.checkHealth();
      }
    }

    const toStart = enabledTasks.filter((task) => !this.runningManagers.has(this.buildTaskKey(task)));
    if (toStart.length > 0) {
      (async () => {
        for (const task of toStart) {
          if (this._stopped) return;
          const taskKey = this.buildTaskKey(task);
          if (this.runningManagers.has(taskKey)) continue;
          const manager = this.createManager(task);
          try {
            await manager.start();
          } catch (err) {
            const msg = `任务启动失败: ${err.message}`;
            if (manager.lastErrorMessage !== msg) {
              manager.lastErrorMessage = msg;
              this.onNotify?.({
                taskId: task.id,
                type: 'error',
                message: msg,
              });
            }
          }
          await new Promise((resolve) => setTimeout(resolve, config.polling.staggerStartMs));
        }
      })().catch(() => {});
    }
  }

  getDigestStats() {
    const list = [];
    for (const manager of this.runningManagers.values()) {
      if (typeof manager.getDailyStats === 'function') {
        list.push(manager.getDailyStats());
      }
    }
    return list;
  }

  resetDigestStats() {
    for (const manager of this.runningManagers.values()) {
      if (typeof manager.resetDailyStats === 'function') {
        manager.resetDailyStats();
      }
    }
  }

  getStats() {
    const tasks = db.getAllTasks();
    const enabledTasks = tasks.filter((task) => task.status === 'ENABLED').length;
    const totalTargets = tasks.reduce(
      (sum, task) => sum + (Array.isArray(task.targets) ? task.targets.length : 0),
      0
    );
    let activeStreams = 0;
    for (const manager of this.runningManagers.values()) {
      if (manager.getTrafficStats?.().running) activeStreams++;
    }

    return {
      totalTasks: tasks.length,
      enabledTasks,
      disabledTasks: tasks.length - enabledTasks,
      activeStreams,
      totalMonitoring: this.runningManagers.size,
      totalTargets,
    };
  }

  getTrafficStats() {
    return db.getAllTasks().map((task) => {
      const manager = this.runningManagers.get(this.buildTaskKey(task));
      const traffic = typeof manager?.getTrafficStats === 'function'
        ? manager.getTrafficStats()
        : {
            totalBytes: 0,
            sessionBytes: 0,
            bitrateKbps: 0,
            updatedAt: null,
          };
      return { ...task, traffic };
    });
  }

  async refreshAllRoomInfo() {
    const promises = [];
    for (const manager of this.runningManagers.values()) {
      if (typeof manager.refreshRoomInfo === 'function') {
        promises.push(manager.refreshRoomInfo());
      }
    }
    await Promise.all(promises);
  }

  start(interval = config.polling.schedulerTickMs) {
    if (this.timer) return;
    this._stopped = false;
    this.bootGraceUntil = Date.now() + config.polling.bootGraceMs;
    this.timer = setInterval(() => this.tick(), interval);
    this.tick();
  }

  stopAll() {
    this._stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    const stops = [];
    for (const manager of this.runningManagers.values()) {
      const p = manager.stop();
      if (p && typeof p.then === 'function') stops.push(p);
    }
    this.runningManagers.clear();
    return Promise.allSettled(stops);
  }

  setOnNotify(callback) {
    this.onNotify = callback;
  }
}

const defaultScheduler = new Scheduler();

module.exports = defaultScheduler;
module.exports.Scheduler = Scheduler;
