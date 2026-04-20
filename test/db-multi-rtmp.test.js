const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const dbModulePath = path.resolve(__dirname, '../src/db/index.js');

function loadDb(databasePath) {
  const previous = process.env.DATABASE_PATH;
  if (databasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = databasePath;
  }

  delete require.cache[dbModulePath];

  try {
    return require(dbModulePath);
  } finally {
    if (previous === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previous;
    }
  }
}

test('db module honors DATABASE_PATH and stores primary plus extra RTMP targets', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-relay-db-'));
  const databasePath = path.join(tempDir, 'relay-db.sqlite');
  const db = loadDb(databasePath);

  const result = db.addTask({
    platform: 'bilibili',
    roomId: '1001',
    targetUrl: 'rtmp://primary/live/room-1001',
    extraTargetUrls: ['rtmp://backup/live/room-1001', 'rtmp://restream/live/room-1001'],
  });

  const task = db.getTaskById(result.taskId);

  assert.equal(typeof db.addTarget, 'function');
  assert.equal(typeof db.getTaskTargets, 'function');
  assert.equal(task.primary_target_url, 'rtmp://primary/live/room-1001');
  assert.deepEqual(
    task.targets.map((target) => target.target_url),
    [
      'rtmp://primary/live/room-1001',
      'rtmp://backup/live/room-1001',
      'rtmp://restream/live/room-1001',
    ]
  );
  assert.equal(fs.existsSync(databasePath), true);
});

test('db module appends a new RTMP address without duplicating the room task', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-relay-db-'));
  const databasePath = path.join(tempDir, 'relay-db.sqlite');
  const db = loadDb(databasePath);
  const created = db.addTask({
    platform: 'douyu',
    roomId: '7788',
    targetUrl: 'rtmp://main/live/7788',
  });

  db.addTarget(created.taskId, 'rtmp://mirror/live/7788');

  assert.equal(db.getAllTasks().length, 1);
  assert.deepEqual(
    db.getTaskTargets(created.taskId).map((target) => target.target_url),
    ['rtmp://main/live/7788', 'rtmp://mirror/live/7788']
  );
});

test('db module hydrates target list for bot and scheduler consumers', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-relay-db-'));
  const databasePath = path.join(tempDir, 'relay-db.sqlite');
  const db = loadDb(databasePath);
  const created = db.addTask({
    platform: 'bilibili',
    roomId: '5566',
    targetUrl: 'rtmp://one/live/5566',
  });

  db.addTarget(created.taskId, 'rtmp://two/live/5566');
  const task = db.getTaskById(created.taskId);

  assert.deepEqual(
    task.targets.map((target) => target.target_url),
    ['rtmp://one/live/5566', 'rtmp://two/live/5566']
  );
});

test('db module persists as a SQLite database file instead of JSON text', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-relay-db-'));
  const databasePath = path.join(tempDir, 'relay-db.sqlite');
  const db = loadDb(databasePath);

  db.addTask({
    platform: 'bilibili',
    roomId: '9900',
    targetUrl: 'rtmp://primary/live/9900',
  });

  const header = fs.readFileSync(databasePath).subarray(0, 16).toString('utf8');
  assert.equal(header, 'SQLite format 3\u0000');
});
