const db = require('../db');
const StreamManager = require('./manager');

class Scheduler {
  constructor({ onNotify = () => {} } = {}) {
    this.runningManagers = new Map();
    this.timer = null;
    this.onNotify = onNotify;
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
    const manager = new StreamManager(task, { onNotify: this.onNotify });
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

    if (task.status !== 'ENABLED') {
      return;
    }

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
      }
    }

    for (const task of enabledTasks) {
      const taskKey = this.buildTaskKey(task);
      if (!this.runningManagers.has(taskKey)) {
        console.log(`[调度器] 发现新任务: ${taskKey}，正在启动...`);
        const manager = this.createManager(task);
        manager.start();
      }
    }
  }

  getStats() {
    const tasks = db.getAllTasks();
    const enabledTasks = tasks.filter((task) => task.status === 'ENABLED').length;
    const totalTargets = tasks.reduce((sum, task) => sum + ((Array.isArray(task.targets) && task.targets.length > 0) ? task.targets.length : 0), 0);
    return {
      totalTasks: tasks.length,
      enabledTasks,
      disabledTasks: tasks.length - enabledTasks,
      runningManagers: this.runningManagers.size,
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

  start(interval = 30000) {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), interval);
    this.tick();
    console.log('🚀 自动化调度系统已启动');
  }

  setOnNotify(callback) {
    this.onNotify = callback;
  }

  stopAll() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    for (const manager of this.runningManagers.values()) {
      manager.stop();
    }
    this.runningManagers.clear();
  }
}

module.exports = new Scheduler();
