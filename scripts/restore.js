require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const sync = require('../src/db/gist-sync');

const SEED_PATH = path.join(__dirname, '../rooms.json');

function getDbPath() {
  const p = process.env.DATABASE_PATH;
  return p ? path.resolve(p) : path.join(__dirname, '../data/data.db');
}

function isDbEmpty(dbPath) {
  if (!fs.existsSync(dbPath)) return true;
  try {
    const db = new DatabaseSync(dbPath);
    const row = db.prepare("SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name='tasks'").get();
    if (!row || row.n === 0) { db.close(); return true; }
    const count = db.prepare('SELECT COUNT(*) as n FROM tasks').get();
    db.close();
    return !count || count.n === 0;
  } catch {
    return true;
  }
}

function seedFromFile(dbPath) {
  if (!fs.existsSync(SEED_PATH)) return false;
  try {
    const rooms = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
    if (!Array.isArray(rooms) || rooms.length === 0) return false;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const { importRoomsIntoDb } = require('../src/db/gist-sync');
    const db = new DatabaseSync(dbPath);
    importRoomsIntoDb(db, rooms);
    db.close();
    console.log(`[seed] ✅ 已从 rooms.json 导入 ${rooms.length} 个房间`);
    return true;
  } catch (err) {
    console.error('[seed] ❌ 导入失败:', err.message);
    return false;
  }
}

async function main() {
  const dbPath = getDbPath();

  if (sync.isConfigured()) {
    try {
      await sync.downloadDefault();
      console.log('[Gist] 预启动恢复完成');
    } catch (err) {
      console.error('[Gist] 预启动恢复失败:', err.message);
    }
  } else {
    console.log('[Gist] 未配置，跳过 Gist 恢复');
  }

  if (isDbEmpty(dbPath)) {
    console.log('[seed] DB 为空，尝试从 rooms.json 种子文件导入...');
    seedFromFile(dbPath);
  }
}

main();
