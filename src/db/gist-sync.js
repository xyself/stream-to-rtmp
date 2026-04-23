const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const GIST_API = 'https://api.github.com/gists';
const FILE_NAME = 'rooms.json';

let _lastUploadedContent = null;

function isConfigured() {
  return !!(process.env.GIST_TOKEN && process.env.GIST_ID);
}

function getHeaders() {
  return {
    'Authorization': `Bearer ${process.env.GIST_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'stream-to-rtmp',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function exportRooms(db) {
  return db.getAllTasks().map((task) => ({
    platform: task.platform,
    room_id: task.room_id,
    status: task.status || 'ENABLED',
    targets: (task.targets || []).map((t) => t.target_url).filter(Boolean),
  }));
}

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

  database.exec('BEGIN IMMEDIATE TRANSACTION');
  try {
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
    database.exec('COMMIT');
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
}

function seedContentCache(db) {
  if (_lastUploadedContent !== null) return;
  const rooms = exportRooms(db);
  if (rooms.length > 0) {
    _lastUploadedContent = JSON.stringify(rooms, null, 2);
  }
}

async function uploadRooms(db) {
  if (!isConfigured()) return false;
  try {
    const rooms = exportRooms(db);
    if (rooms.length === 0) {
      return false;
    }
    const content = JSON.stringify(rooms, null, 2);
    if (_lastUploadedContent === content) {
      return true;
    }
    const res = await fetch(`${GIST_API}/${process.env.GIST_ID}`, {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify({ files: { [FILE_NAME]: { content } } }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    _lastUploadedContent = content;
    return true;
  } catch (err) {
    return false;
  }
}

async function restoreRooms(localDbPath) {
  if (!isConfigured()) {
    return false;
  }
  try {
    const res = await fetch(`${GIST_API}/${process.env.GIST_ID}`, { headers: getHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const file = data.files?.[FILE_NAME];
    if (!file) {
      return false;
    }
    const rooms = JSON.parse(file.content);
    fs.mkdirSync(path.dirname(localDbPath), { recursive: true });
    const database = new DatabaseSync(localDbPath);
    importRoomsIntoDb(database, rooms);
    database.close();
    return true;
  } catch (err) {
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

module.exports = { uploadRooms, restoreRooms, downloadDefault, isConfigured, importRoomsIntoDb, seedContentCache };
