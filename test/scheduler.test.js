const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');

const schedulerPath = path.resolve(__dirname, '../src/core/scheduler.js');

function loadScheduler({ dbMock, StreamManagerClass }) {
  const originalLoad = Module._load;
  delete require.cache[schedulerPath];

  Module._load = function patched(request, parent, isMain) {
    if (request === '../db') return dbMock;
    if (request === './manager') return StreamManagerClass;
    return originalLoad.apply(this, arguments);
  };

  try {
    return require(schedulerPath);
  } finally {
    Module._load = originalLoad;
  }
}

test('scheduler refreshTask restarts a running enabled task immediately', async () => {
  const events = [];

  class StreamManagerMock {
    constructor(task) {
      this.task = task;
      events.push(['construct', task.id]);
    }

    start() {
      events.push(['start', this.task.id]);
    }

    stop() {
      events.push(['stop', this.task.id]);
    }
  }

  const scheduler = loadScheduler({
    dbMock: {
      getEnabledTasks() {
        return [{ id: 1, platform: 'bilibili', room_id: '1001', status: 'ENABLED' }];
      },
      getAllTasks() {
        return [{ id: 1, platform: 'bilibili', room_id: '1001', status: 'ENABLED', targets: [] }];
      },
      getTaskById(id) {
        return { id, platform: 'bilibili', room_id: '1001', status: 'ENABLED' };
      },
    },
    StreamManagerClass: StreamManagerMock,
  });

  try {
    await scheduler.tick();
    events.length = 0;

    await scheduler.refreshTask({ id: 1, platform: 'bilibili', room_id: '1001', status: 'ENABLED' });

    assert.deepEqual(events, [
      ['stop', 1],
      ['construct', 1],
      ['start', 1],
    ]);
  } finally {
    scheduler.stopAll();
  }
});

test('scheduler refreshTask stops disabled task without restarting it', async () => {
  const events = [];

  class StreamManagerMock {
    constructor(task) {
      this.task = task;
      events.push(['construct', task.id]);
    }

    start() {
      events.push(['start', this.task.id]);
    }

    stop() {
      events.push(['stop', this.task.id]);
    }
  }

  const scheduler = loadScheduler({
    dbMock: {
      getEnabledTasks() {
        return [{ id: 2, platform: 'bilibili', room_id: '1002', status: 'ENABLED' }];
      },
      getAllTasks() {
        return [{ id: 2, platform: 'bilibili', room_id: '1002', status: 'DISABLED', targets: [] }];
      },
      getTaskById(id) {
        return { id, platform: 'bilibili', room_id: '1002', status: 'DISABLED' };
      },
    },
    StreamManagerClass: StreamManagerMock,
  });

  try {
    await scheduler.tick();
    events.length = 0;

    await scheduler.refreshTask({ id: 2, platform: 'bilibili', room_id: '1002', status: 'DISABLED' });

    assert.deepEqual(events, [
      ['stop', 2],
    ]);
  } finally {
    scheduler.stopAll();
  }
});
