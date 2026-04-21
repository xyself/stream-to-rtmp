const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

function isConfigured() {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET
  );
}

function createClient() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

function getKey() {
  return process.env.R2_KEY || 'rooms.json';
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// 从 db store 导出房间+RTMP为 JSON
function exportRooms(db) {
  return db.getAllTasks().map((task) => ({
    platform: task.platform,
    room_id: task.room_id,
    status: task.status || 'ENABLED',
    targets: (task.targets || []).map((t) => t.target_url).filter(Boolean),
  }));
}

// 将 JSON 数据导入到 SQLite（用于预启动恢复，直接操作文件）
function importRoomsIntoDb(database, rooms) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY,
      platform TEXT NOT NULL,
      room_id TEXT NOT NULL,
      primary_target_url TEXT,
      target_url TEXT,
      status TEXT NOT NULL DEFAULT 'ENABLED',
      last_error TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(platform, room_id)
    );
    CREATE TABLE IF NOT EXISTS task_targets (
      id INTEGER PRIMARY KEY,
      task_id INTEGER NOT NULL,
      target_url TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(task_id, target_url),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const now = new Date().toISOString();
  const upsertTask = database.prepare(`
    INSERT INTO tasks (platform, room_id, primary_target_url, target_url, status, last_error, created_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(platform, room_id) DO UPDATE SET
      primary_target_url = excluded.primary_target_url,
      target_url         = excluded.target_url,
      status             = excluded.status
  `);
  const findTask = database.prepare('SELECT id FROM tasks WHERE platform = ? AND room_id = ?');
  const upsertTarget = database.prepare(`
    INSERT OR IGNORE INTO task_targets (task_id, target_url, created_at) VALUES (?, ?, ?)
  `);

  const doImport = database.transaction(() => {
    for (const room of rooms) {
      const primary = room.targets?.[0] || null;
      upsertTask.run(room.platform, room.room_id, primary, primary, room.status || 'ENABLED', now);
      const row = findTask.get(room.platform, room.room_id);
      if (row) {
        for (const url of room.targets || []) {
          upsertTarget.run(row.id, url, now);
        }
      }
    }
  });
  doImport();
}

// 上传：从 db store 导出 JSON 到 R2
async function uploadRooms(db) {
  if (!isConfigured()) return false;
  try {
    const rooms = exportRooms(db);
    const json = JSON.stringify(rooms, null, 2);
    await createClient().send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: getKey(),
      Body: json,
      ContentType: 'application/json',
    }));
    console.log(`[R2] ✅ 已同步 ${rooms.length} 个房间到 R2`);
    return true;
  } catch (err) {
    console.error('[R2] ❌ 上传失败:', err.message);
    return false;
  }
}

// 恢复：从 R2 下载 JSON 并写入本地 SQLite（预启动脚本使用）
async function restoreRooms(localDbPath) {
  if (!isConfigured()) {
    console.log('[R2] 未配置，跳过恢复');
    return false;
  }
  try {
    const res = await createClient().send(new GetObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: getKey(),
    }));
    const buf = await streamToBuffer(res.Body);
    const rooms = JSON.parse(buf.toString('utf8'));
    fs.mkdirSync(path.dirname(localDbPath), { recursive: true });
    const database = new DatabaseSync(localDbPath);
    importRoomsIntoDb(database, rooms);
    database.close();
    console.log(`[R2] ✅ 已从 R2 恢复 ${rooms.length} 个房间`);
    return true;
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      console.log('[R2] 首次部署，R2 暂无数据，将使用空数据库');
      return false;
    }
    console.error('[R2] ❌ 恢复失败:', err.message);
    return false;
  }
}

function getDefaultLocalPath() {
  const configured = process.env.DATABASE_PATH;
  return configured ? path.resolve(configured) : path.join(__dirname, '../../data/data.db');
}

async function downloadDefault() {
  return restoreRooms(getDefaultLocalPath());
}

module.exports = { uploadRooms, restoreRooms, downloadDefault, isConfigured };
