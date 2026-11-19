const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

function resolveDatabasePath() {
  const configured = process.env.DATABASE_PATH;
  return configured ? path.resolve(configured) : config.paths.database;
}

function ensureDirectoryExists(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function initializeSchema(database) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA cache_size = -1000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY,
      platform TEXT NOT NULL,
      room_id TEXT NOT NULL,
      primary_target_url TEXT,
      target_url TEXT,
      cookie TEXT,
      transcode_mode TEXT DEFAULT 'default',
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

    CREATE TABLE IF NOT EXISTS bitrate_samples (
      id INTEGER PRIMARY KEY,
      task_id INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      kbps INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_task_targets_task_id ON task_targets(task_id);
    CREATE INDEX IF NOT EXISTS idx_bitrate_samples_task_ts ON bitrate_samples(task_id, ts);
  `);

  // 平滑迁移已有数据库：若旧表还没有 cookie / transcode_mode 列则自动补齐
  const columns = database.prepare('PRAGMA table_info(tasks)').all();
  if (!columns.some((col) => col.name === 'cookie')) {
    database.exec('ALTER TABLE tasks ADD COLUMN cookie TEXT;');
  }
  if (!columns.some((col) => col.name === 'transcode_mode')) {
    database.exec("ALTER TABLE tasks ADD COLUMN transcode_mode TEXT DEFAULT 'default';");
  }
}

function openDatabase(filePath) {
  ensureDirectoryExists(filePath);
  const database = new DatabaseSync(filePath);
  initializeSchema(database);
  return database;
}

function createStore(filePath = resolveDatabasePath()) {
  const database = openDatabase(filePath);

  function withTransaction(fn) {
    database.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      const res = fn();
      database.exec('COMMIT');
      return res;
    } catch (err) {
      database.exec('ROLLBACK');
      throw err;
    }
  }

  const selectTaskTargetsStmt = database.prepare(`
    SELECT id, task_id, target_url, created_at
    FROM task_targets
    WHERE task_id = ?
    ORDER BY id ASC
  `);
  const findTaskByPlatformRoomStmt = database.prepare(`
    SELECT id, platform, room_id, primary_target_url, target_url, cookie, transcode_mode, status, last_error, created_at
    FROM tasks
    WHERE platform = ? AND room_id = ?
  `);
  const insertTaskStmt = database.prepare(`
    INSERT INTO tasks (platform, room_id, primary_target_url, target_url, cookie, transcode_mode, status, last_error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'ENABLED', NULL, ?)
    RETURNING id, platform, room_id, primary_target_url, target_url, cookie, transcode_mode, status, last_error, created_at
  `);
  const updateTaskForAddStmt = database.prepare(`
    UPDATE tasks
    SET primary_target_url = ?, target_url = ?, cookie = COALESCE(?, cookie), transcode_mode = COALESCE(?, transcode_mode, 'default'), status = 'ENABLED'
    WHERE id = ?
  `);
  const findTaskByIdStmt = database.prepare(`
    SELECT id, platform, room_id, primary_target_url, target_url, cookie, transcode_mode, status, last_error, created_at
    FROM tasks
    WHERE id = ?
  `);
  const insertTargetStmt = database.prepare(`
    INSERT OR IGNORE INTO task_targets (task_id, target_url, created_at)
    VALUES (?, ?, ?)
  `);
  const findTargetStmt = database.prepare(`
    SELECT id, task_id, target_url, created_at
    FROM task_targets
    WHERE task_id = ? AND target_url = ?
  `);
  const selectAllTasksStmt = database.prepare(`
    SELECT id, platform, room_id, primary_target_url, target_url, cookie, transcode_mode, status, last_error, created_at
    FROM tasks
    ORDER BY datetime(created_at) DESC
  `);
  const selectEnabledTasksStmt = database.prepare(`
    SELECT id, platform, room_id, primary_target_url, target_url, cookie, transcode_mode, status, last_error, created_at
    FROM tasks
    WHERE status = 'ENABLED'
    ORDER BY datetime(created_at) DESC
  `);
  const updateTaskStatusStmt = database.prepare(`
    UPDATE tasks SET status = ? WHERE id = ?
  `);
  const updateErrorStmt = database.prepare(`
    UPDATE tasks SET last_error = ? WHERE id = ?
  `);
  const deleteTaskStmt = database.prepare(`
    DELETE FROM tasks WHERE id = ?
  `);
  const updatePrimaryUrlStmt = database.prepare(`
    UPDATE tasks SET primary_target_url = ?, target_url = ? WHERE id = ?
  `);
  const deleteTargetByUrlStmt = database.prepare(`
    DELETE FROM task_targets WHERE task_id = ? AND target_url = ?
  `);
  const updateRoomIdStmt = database.prepare(`
    UPDATE tasks SET room_id = ? WHERE id = ?
  `);
  const updateTaskCookieStmt = database.prepare(`
    UPDATE tasks SET cookie = ? WHERE id = ?
  `);
  const updateTaskTranscodeModeStmt = database.prepare(`
    UPDATE tasks SET transcode_mode = ? WHERE id = ?
  `);
  const deleteTargetByIdStmt = database.prepare(`
    DELETE FROM task_targets WHERE id = ? AND task_id = ?
  `);
  const enableAllTasksStmt = database.prepare(`
    UPDATE tasks SET status = 'ENABLED'
  `);
  const disableAllTasksStmt = database.prepare(`
    UPDATE tasks SET status = 'DISABLED'
  `);
  const getSettingStmt = database.prepare(`
    SELECT value FROM settings WHERE key = ?
  `);
  const getAllSettingsStmt = database.prepare(`
    SELECT key, value FROM settings ORDER BY key ASC
  `);
  const setSettingStmt = database.prepare(`
    INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)
  `);
  const insertBitrateSampleStmt = database.prepare(`
    INSERT INTO bitrate_samples (task_id, ts, kbps) VALUES (?, ?, ?)
  `);
  const selectTaskBitrateSamplesStmt = database.prepare(`
    SELECT task_id, ts, kbps
    FROM bitrate_samples
    WHERE task_id = ? AND ts >= ? AND ts <= ?
    ORDER BY ts ASC
  `);
  const selectAllBitrateSamplesStmt = database.prepare(`
    SELECT task_id, ts, kbps
    FROM bitrate_samples
    WHERE ts >= ? AND ts <= ?
    ORDER BY ts ASC
  `);
  const pruneBitrateSamplesStmt = database.prepare(`
    DELETE FROM bitrate_samples WHERE ts < ?
  `);

  function normalizeTargetUrls(primaryTargetUrl, extraTargetUrls = []) {
    return [primaryTargetUrl, ...extraTargetUrls]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean)
      .filter((value, index, list) => list.indexOf(value) === index);
  }

  function getTaskTargets(taskId) {
    return selectTaskTargetsStmt.all(Number(taskId)).map((target) => ({ ...target }));
  }

  function hydrateTask(taskRow) {
    if (!taskRow) return undefined;
    const rawTargets = getTaskTargets(taskRow.id);
    const primaryTargetUrl = taskRow.primary_target_url || taskRow.target_url || rawTargets[0]?.target_url || null;

    // 保证主推流地址始终位于 targets[0]，防止修改主地址后因自增 ID 顺序导致主备倒置（脏数据）
    const targets = [...rawTargets].sort((a, b) => {
      if (a.target_url === primaryTargetUrl) return -1;
      if (b.target_url === primaryTargetUrl) return 1;
      return a.id - b.id;
    });

    return {
      ...taskRow,
      primary_target_url: primaryTargetUrl,
      target_url: primaryTargetUrl,
      targets,
    };
  }

  function insertTarget(taskId, targetUrl) {
    const numericTaskId = Number(taskId);
    const createdAt = new Date().toISOString();
    insertTargetStmt.run(numericTaskId, targetUrl, createdAt);
    const row = findTargetStmt.get(numericTaskId, targetUrl);
    return row ? { ...row } : null;
  }

  let _onWrite = null;

  return {
    set onWrite(fn) {
      _onWrite = fn;
    },
    get onWrite() {
      return _onWrite;
    },

    getDatabase() {
      return database;
    },

    addTask(task) {
      const result = withTransaction(() => {
        const targetUrls = normalizeTargetUrls(task.targetUrl, task.extraTargetUrls || []);
        if (targetUrls.length === 0) {
          throw new Error('至少需要一个 RTMP 地址');
        }
        const cleanedCookie = typeof task.cookie === 'string' && task.cookie.trim()
          ? task.cookie.trim()
          : null;
        const validModes = ['default', 'copy', 'audio_fix', 'transcode'];
        const transcodeMode = validModes.includes(task.transcodeMode) ? task.transcodeMode : 'default';

        let taskRow = findTaskByPlatformRoomStmt.get(task.platform, task.roomId);
        if (taskRow) {
          updateTaskForAddStmt.run(targetUrls[0], targetUrls[0], cleanedCookie, transcodeMode, taskRow.id);
          taskRow = findTaskByIdStmt.get(taskRow.id);
        } else {
          taskRow = insertTaskStmt.get(
            task.platform,
            task.roomId,
            targetUrls[0],
            targetUrls[0],
            cleanedCookie,
            transcodeMode,
            new Date().toISOString()
          );
        }

        for (const targetUrl of targetUrls) {
          insertTarget(taskRow.id, targetUrl);
        }

        const hydratedTask = hydrateTask(taskRow);
        return {
          taskId: hydratedTask.id,
          task: hydratedTask,
          targets: hydratedTask.targets,
        };
      });
      _onWrite?.('room');
      return result;
    },

    addTarget(taskId, targetUrl) {
      const result = withTransaction(() => {
        const cleaned = typeof targetUrl === 'string' ? targetUrl.trim() : '';
        if (!cleaned) throw new Error('RTMP 地址不能为空');
        const task = findTaskByIdStmt.get(Number(taskId));
        if (!task) throw new Error(`任务不存在: ${taskId}`);
        return insertTarget(taskId, cleaned);
      });
      _onWrite?.('room');
      return result;
    },

    getTaskTargets(taskId) {
      return getTaskTargets(taskId);
    },

    getAllTasks() {
      return selectAllTasksStmt.all().map(hydrateTask);
    },

    getEnabledTasks() {
      return selectEnabledTasksStmt.all().map(hydrateTask);
    },

    getTaskById(id) {
      return hydrateTask(findTaskByIdStmt.get(Number(id)));
    },

    updateTaskStatus(id, status) {
      const result = withTransaction(() => {
        const r = updateTaskStatusStmt.run(status, Number(id));
        return { changes: r.changes };
      });
      _onWrite?.('status');
      return result;
    },

    updateError(id, errorMsg) {
      return withTransaction(() => {
        const r = updateErrorStmt.run(errorMsg, Number(id));
        return { changes: r.changes };
      });
    },

    deleteTask(id) {
      const result = withTransaction(() => {
        const r = deleteTaskStmt.run(Number(id));
        return { changes: r.changes };
      });
      _onWrite?.('room');
      return result;
    },

    updatePrimaryTarget(taskId, newUrl) {
      withTransaction(() => {
        const numericTaskId = Number(taskId);
        const cleaned = typeof newUrl === 'string' ? newUrl.trim() : '';
        if (!cleaned) throw new Error('RTMP 地址不能为空');
        const task = findTaskByIdStmt.get(numericTaskId);
        if (!task) throw new Error(`任务不存在: ${taskId}`);
        const oldUrl = task.primary_target_url || task.target_url;
        updatePrimaryUrlStmt.run(cleaned, cleaned, numericTaskId);
        if (oldUrl) deleteTargetByUrlStmt.run(numericTaskId, oldUrl);
        insertTarget(numericTaskId, cleaned);
      });
      _onWrite?.('room');
    },

    updateRoomId(taskId, newRoomId) {
      withTransaction(() => {
        const numericTaskId = Number(taskId);
        const cleaned = typeof newRoomId === 'string' ? newRoomId.trim() : '';
        if (!cleaned || !/^\d+$/.test(cleaned)) {
          throw new Error('房间 ID 只能是纯数字');
        }
        const task = findTaskByIdStmt.get(numericTaskId);
        if (!task) throw new Error(`任务不存在: ${taskId}`);
        updateRoomIdStmt.run(cleaned, numericTaskId);
      });
      _onWrite?.('room');
    },

    updateTaskCookie(taskId, cookie) {
      withTransaction(() => {
        const numericTaskId = Number(taskId);
        const task = findTaskByIdStmt.get(numericTaskId);
        if (!task) throw new Error(`任务不存在: ${taskId}`);
        const cleaned = typeof cookie === 'string' && cookie.trim() ? cookie.trim() : null;
        updateTaskCookieStmt.run(cleaned, numericTaskId);
      });
      _onWrite?.('room');
    },

    updateTaskTranscodeMode(taskId, mode) {
      const validModes = ['default', 'copy', 'audio_fix', 'transcode'];
      const targetMode = validModes.includes(mode) ? mode : 'default';
      withTransaction(() => {
        const numericTaskId = Number(taskId);
        const task = findTaskByIdStmt.get(numericTaskId);
        if (!task) throw new Error(`任务不存在: ${taskId}`);
        updateTaskTranscodeModeStmt.run(targetMode, numericTaskId);
      });
      _onWrite?.('room');
      return targetMode;
    },

    deleteTargetById(taskId, targetId) {
      const result = withTransaction(() => {
        const numericTaskId = Number(taskId);
        const numericTargetId = Number(targetId);
        deleteTargetByIdStmt.run(numericTargetId, numericTaskId);
        const remaining = selectTaskTargetsStmt.all(numericTaskId);
        const newPrimary = remaining[0]?.target_url || null;
        updatePrimaryUrlStmt.run(newPrimary, newPrimary, numericTaskId);
        return { remaining: remaining.length };
      });
      _onWrite?.('room');
      return result;
    },

    enableAllTasks() {
      enableAllTasksStmt.run();
      _onWrite?.('status');
    },

    disableAllTasks() {
      disableAllTasksStmt.run();
      _onWrite?.('status');
    },

    getSetting(key) {
      const row = getSettingStmt.get(key);
      return row ? row.value : null;
    },

    getAllSettings() {
      const rows = getAllSettingsStmt.all();
      return rows.reduce((acc, row) => {
        acc[row.key] = row.value;
        return acc;
      }, {});
    },

    setSetting(key, value) {
      setSettingStmt.run(key, String(value));
      _onWrite?.('setting');
    },

    recordBitrateSample(taskId, kbps, ts = Date.now()) {
      try {
        const numericTaskId = Number(taskId);
        if (!Number.isFinite(numericTaskId) || numericTaskId <= 0) return;
        const safeKbps = Math.max(0, Math.round(Number(kbps) || 0));
        insertBitrateSampleStmt.run(numericTaskId, Math.round(ts), safeKbps);
      } catch {}
    },

    getBitrateSamples(taskId, startMs, endMs) {
      try {
        return selectTaskBitrateSamplesStmt.all(Number(taskId), Math.round(startMs), Math.round(endMs));
      } catch {
        return [];
      }
    },

    getAllBitrateSamples(startMs, endMs) {
      try {
        return selectAllBitrateSamplesStmt.all(Math.round(startMs), Math.round(endMs));
      } catch {
        return [];
      }
    },

    pruneBitrateSamples(beforeMs = Date.now() - 72 * 3600 * 1000) {
      try {
        pruneBitrateSamplesStmt.run(Math.round(beforeMs));
      } catch {}
    },

    checkpoint(mode = 'PASSIVE') {
      try {
        const validModes = ['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE'];
        const targetMode = validModes.includes(mode) ? mode : 'PASSIVE';
        database.exec(`PRAGMA wal_checkpoint(${targetMode});`);
      } catch (err) {
        console.error('SQLite WAL checkpoint 失败:', err.message);
      }
    },

    close() {
      try {
        database.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        database.close();
      } catch {}
    },
  };
}

module.exports = createStore();
module.exports.createStore = createStore;
module.exports.resolveDatabasePath = resolveDatabasePath;
module.exports.initializeSchema = initializeSchema;
