const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { initializeSchema, resolveDatabasePath } = require('./index');
const http = require('../platforms/http');

const GIST_API = 'https://api.github.com/gists';
const FILE_NAME = 'rooms.json';

let _lastUploadedContent = null;

function isConfigured() {
  return !!(process.env.GIST_TOKEN && process.env.GIST_ID);
}

function getHeaders() {
  return {
    Authorization: `Bearer ${process.env.GIST_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'stream-to-rtmp',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function exportRooms(db) {
  return db.getAllTasks().map((task) => {
    const item = {
      platform: task.platform,
      room_id: task.room_id,
      status: task.status || 'ENABLED',
      targets: (task.targets || []).map((t) => t.target_url).filter(Boolean),
    };
    if (task.cookie && String(task.cookie).trim()) {
      item.cookie = String(task.cookie).trim();
    }
    if (task.transcode_mode && task.transcode_mode !== 'default') {
      item.transcode_mode = task.transcode_mode;
    }
    return item;
  });
}

function importRoomsIntoDb(database, payload) {
  initializeSchema(database);

  const rooms = Array.isArray(payload) ? payload : (Array.isArray(payload?.rooms) ? payload.rooms : []);
  const settings = (!Array.isArray(payload) && payload?.settings && typeof payload.settings === 'object')
    ? payload.settings
    : {};

  const now = new Date().toISOString();
  const upsertTask = database.prepare(`
    INSERT INTO tasks (platform, room_id, primary_target_url, target_url, cookie, transcode_mode, status, last_error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(platform, room_id) DO UPDATE SET
      primary_target_url = excluded.primary_target_url,
      target_url         = excluded.target_url,
      cookie             = COALESCE(excluded.cookie, tasks.cookie),
      transcode_mode     = COALESCE(excluded.transcode_mode, tasks.transcode_mode, 'default'),
      status             = excluded.status
  `);
  const findTask = database.prepare('SELECT id FROM tasks WHERE platform = ? AND room_id = ?');
  const clearTaskTargets = database.prepare('DELETE FROM task_targets WHERE task_id = ?');
  const upsertTarget = database.prepare(`
    INSERT OR IGNORE INTO task_targets (task_id, target_url, created_at) VALUES (?, ?, ?)
  `);
  const upsertSetting = database.prepare(`
    INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)
  `);

  let importedRooms = 0;
  let importedTargets = 0;
  let importedSettings = 0;

  database.exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    for (const room of rooms) {
      if (!room?.platform || !room?.room_id) continue;
      const primary = room.targets?.[0] || null;
      const cookie = typeof room.cookie === 'string' && room.cookie.trim() ? room.cookie.trim() : null;
      const validModes = ['default', 'copy', 'audio_fix', 'transcode'];
      const transcodeMode = validModes.includes(room.transcode_mode) ? room.transcode_mode : 'default';
      upsertTask.run(
        String(room.platform),
        String(room.room_id),
        primary,
        primary,
        cookie,
        transcodeMode,
        room.status || 'ENABLED',
        now
      );
      importedRooms += 1;
      const row = findTask.get(String(room.platform), String(room.room_id));
      if (row) {
        clearTaskTargets.run(row.id);
        for (const url of room.targets || []) {
          if (url && typeof url === 'string') {
            upsertTarget.run(row.id, url.trim(), now);
            importedTargets += 1;
          }
        }
      }
    }
    for (const [key, val] of Object.entries(settings)) {
      if (val !== undefined && val !== null) {
        upsertSetting.run(key, String(val));
        importedSettings += 1;
      }
    }
    database.exec('COMMIT');
    return { importedRooms, importedTargets, importedSettings };
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
}

function buildSnapshotPayload(db) {
  const rooms = exportRooms(db);
  const settings = typeof db.getAllSettings === 'function' ? db.getAllSettings() : {};
  // 若无自定义 settings，保持纯数组格式兼容老版本；有 settings 时使用带 settings 扩展字段的对象或附加元数据
  if (Object.keys(settings).length === 0) {
    return rooms;
  }
  return {
    version: 2,
    rooms,
    settings,
  };
}

function seedContentCache(db) {
  if (_lastUploadedContent !== null) return;
  const rooms = exportRooms(db);
  const settings = typeof db.getAllSettings === 'function' ? db.getAllSettings() : {};
  if (rooms.length > 0 || Object.keys(settings).length > 0) {
    _lastUploadedContent = JSON.stringify(buildSnapshotPayload(db), null, 2);
  }
}

async function uploadRooms(db) {
  if (!isConfigured()) return false;
  try {
    const rooms = exportRooms(db);
    const settings = typeof db.getAllSettings === 'function' ? db.getAllSettings() : {};
    // 仅当数据库完全空白且从未同步过时跳过，防止空库首次启动覆盖远端；若用户主动删光最后一个房间则允许同步空列表
    if (rooms.length === 0 && Object.keys(settings).length === 0 && _lastUploadedContent === null) {
      return false;
    }
    const content = JSON.stringify(buildSnapshotPayload(db), null, 2);
    if (_lastUploadedContent === content) {
      return true;
    }
    await http.request(`${GIST_API}/${process.env.GIST_ID}`, {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify({ files: { [FILE_NAME]: { content } } }),
      responseType: 'json',
    });
    _lastUploadedContent = content;
    return true;
  } catch {
    return false;
  }
}

async function restoreRooms(localDbPath) {
  if (!isConfigured()) return false;
  try {
    const res = await http.get(`${GIST_API}/${process.env.GIST_ID}`, {
      headers: getHeaders(),
      responseType: 'json',
    });
    const file = res.data?.files?.[FILE_NAME];
    if (!file?.content) return false;
    const parsed = JSON.parse(file.content);
    fs.mkdirSync(path.dirname(localDbPath), { recursive: true });
    const database = new DatabaseSync(localDbPath);
    importRoomsIntoDb(database, parsed);
    database.close();
    return true;
  } catch {
    return false;
  }
}

async function downloadDefault() {
  return restoreRooms(resolveDatabasePath());
}

module.exports = {
  uploadRooms,
  restoreRooms,
  downloadDefault,
  isConfigured,
  exportRooms,
  buildSnapshotPayload,
  importRoomsIntoDb,
  seedContentCache,
};
