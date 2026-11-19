require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');
const { resolveDatabasePath } = require('../db');
const sync = require('../db/gist-sync');

function isDbEmpty(dbPath) {
  if (!fs.existsSync(dbPath)) return true;
  try {
    const db = new DatabaseSync(dbPath);
    const row = db.prepare("SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name='tasks'").get();
    if (!row || row.n === 0) {
      db.close();
      return true;
    }
    const count = db.prepare('SELECT COUNT(*) as n FROM tasks').get();
    db.close();
    return !count || count.n === 0;
  } catch {
    return true;
  }
}

function seedFromFile(dbPath) {
  const seedPath = config.paths.seedRooms;
  if (!fs.existsSync(seedPath)) return false;
  try {
    const rooms = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    if (!Array.isArray(rooms) && !Array.isArray(rooms?.rooms)) return false;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    sync.importRoomsIntoDb(db, rooms);
    db.close();
    const count = Array.isArray(rooms) ? rooms.length : rooms.rooms.length;
    console.log(`[seed] ✅ 导入 ${count} 个房间`);
    return true;
  } catch (err) {
    console.error('[seed] ❌ 导入失败:', err.message);
    return false;
  }
}

let running = false;

async function restoreOnce() {
  if (running) return;
  running = true;

  const dbPath = resolveDatabasePath();

  try {
    if (sync.isConfigured()) {
      try {
        await sync.downloadDefault();
        console.log('[Gist] 恢复完成');
      } catch (err) {
        console.error('[Gist] 恢复失败:', err.message);
      }
    }

    if (isDbEmpty(dbPath)) {
      console.log('[seed] DB为空，尝试初始化...');
      seedFromFile(dbPath);
    }
  } finally {
    running = false;
  }
}

module.exports = { restoreOnce };