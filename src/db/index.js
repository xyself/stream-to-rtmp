const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// 使用绝对路径，而不是相对路径，避免因启动目录不同导致数据库路径漂移
const defaultDatabasePath = path.join(__dirname, '../../data/data.db');

function resolveDatabasePath() {
  const configured = process.env.DATABASE_PATH;
  return configured ? path.resolve(configured) : defaultDatabasePath;
}

function ensureDirectoryExists(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function createInitialState() {
  return {
    nextTaskId: 1,
    nextTargetId: 1,
    tasks: [],
    taskTargets: [],
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseJsonState(raw) {
  if (!raw.trim()) {
    return createInitialState();
  }

  const parsed = JSON.parse(raw);
  return {
    nextTaskId: Number.isInteger(parsed.nextTaskId) ? parsed.nextTaskId : 1,
    nextTargetId: Number.isInteger(parsed.nextTargetId) ? parsed.nextTargetId : 1,
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    taskTargets: Array.isArray(parsed.taskTargets) ? parsed.taskTargets : [],
  };
}

function isLikelyJsonDatabase(rawBuffer) {
  const prefix = rawBuffer.subarray(0, 32).toString('utf8').trimStart();
  return prefix.startsWith('{') || prefix.startsWith('[') || prefix.length === 0;
}

function initializeSchema(database) {
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

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_task_targets_task_id ON task_targets(task_id);
  `);
}

function migrateJsonStateIfNeeded(database, filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const rawBuffer = fs.readFileSync(filePath);
  if (!isLikelyJsonDatabase(rawBuffer)) {
    return;
  }

  const state = parseJsonState(rawBuffer.toString('utf8'));
  initializeSchema(database);

  const insertTask = database.prepare(`
    INSERT OR REPLACE INTO tasks (
      id, platform, room_id, primary_target_url, target_url, status, last_error, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTarget = database.prepare(`
    INSERT OR REPLACE INTO task_targets (
      id, task_id, target_url, created_at
    ) VALUES (?, ?, ?, ?)
  `);

  const migrate = database.transaction(() => {
    for (const task of state.tasks) {
      insertTask.run(
        Number(task.id),
        task.platform,
        task.room_id,
        task.primary_target_url || task.target_url || null,
        task.target_url || task.primary_target_url || null,
        task.status || 'ENABLED',
        task.last_error || null,
        task.created_at || new Date().toISOString()
      );
    }

    for (const target of state.taskTargets) {
      insertTarget.run(
        Number(target.id),
        Number(target.task_id),
        target.target_url,
        target.created_at || new Date().toISOString()
      );
    }
  });

  migrate();
}

function openDatabase(filePath) {
  ensureDirectoryExists(filePath);

  const shouldMigrateJson = fs.existsSync(filePath) && isLikelyJsonDatabase(fs.readFileSync(filePath));
  const database = new DatabaseSync(filePath);

  initializeSchema(database);

  if (shouldMigrateJson) {
    database.exec('DELETE FROM task_targets; DELETE FROM tasks;');
    migrateJsonStateIfNeeded(database, filePath);
  }

  return database;
}

function createStore(filePath = resolveDatabasePath()) {
  const database = openDatabase(filePath);

  const selectTaskTargetsStmt = database.prepare(`
    SELECT id, task_id, target_url, created_at
    FROM task_targets
    WHERE task_id = ?
    ORDER BY id ASC
  `);
  const findTaskByPlatformRoomStmt = database.prepare(`
    SELECT id, platform, room_id, primary_target_url, target_url, status, last_error, created_at
    FROM tasks
    WHERE platform = ? AND room_id = ?
  `);
  const insertTaskStmt = database.prepare(`
    INSERT INTO tasks (platform, room_id, primary_target_url, target_url, status, last_error, created_at)
    VALUES (?, ?, ?, ?, 'ENABLED', NULL, ?)
    RETURNING id, platform, room_id, primary_target_url, target_url, status, last_error, created_at
  `);
  const updateTaskForAddStmt = database.prepare(`
    UPDATE tasks
    SET primary_target_url = ?, target_url = ?, status = 'ENABLED'
    WHERE id = ?
  `);
  const findTaskByIdStmt = database.prepare(`
    SELECT id, platform, room_id, primary_target_url, target_url, status, last_error, created_at
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
    SELECT id, platform, room_id, primary_target_url, target_url, status, last_error, created_at
    FROM tasks
    ORDER BY datetime(created_at) DESC
  `);
  const selectEnabledTasksStmt = database.prepare(`
    SELECT id, platform, room_id, primary_target_url, target_url, status, last_error, created_at
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
  const setSettingStmt = database.prepare(`
    INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)
  `);

  function normalizeTargetUrls(primaryTargetUrl, extraTargetUrls = []) {
    return [primaryTargetUrl, ...extraTargetUrls]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean)
      .filter((value, index, list) => list.indexOf(value) === index);
  }

  function getTaskTargets(taskId) {
    return selectTaskTargetsStmt.all(Number(taskId)).map((target) => clone(target));
  }

  function hydrateTask(taskRow) {
    if (!taskRow) return undefined;

    const targets = getTaskTargets(taskRow.id);
    const primaryTargetUrl = taskRow.primary_target_url || taskRow.target_url || targets[0]?.target_url || null;

    return {
      ...clone(taskRow),
      primary_target_url: primaryTargetUrl,
      target_url: primaryTargetUrl,
      targets,
    };
  }

  function insertTarget(taskId, targetUrl) {
    const numericTaskId = Number(taskId);
    const createdAt = new Date().toISOString();
    insertTargetStmt.run(numericTaskId, targetUrl, createdAt);
    return clone(findTargetStmt.get(numericTaskId, targetUrl));
  }

  const addTaskTransaction = (task) => {
    database.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      const targetUrls = normalizeTargetUrls(task.targetUrl, task.extraTargetUrls || []);
      if (targetUrls.length === 0) {
        throw new Error('至少需要一个 RTMP 地址');
      }

      let taskRow = findTaskByPlatformRoomStmt.get(task.platform, task.roomId);
      if (taskRow) {
        updateTaskForAddStmt.run(targetUrls[0], targetUrls[0], taskRow.id);
        taskRow = findTaskByIdStmt.get(taskRow.id);
      } else {
        taskRow = insertTaskStmt.get(task.platform, task.roomId, targetUrls[0], targetUrls[0], new Date().toISOString());
      }

      for (const targetUrl of targetUrls) {
        insertTarget(taskRow.id, targetUrl);
      }

      database.exec('COMMIT');

      const hydratedTask = hydrateTask(taskRow);
      return {
        taskId: hydratedTask.id,
        task: hydratedTask,
        targets: hydratedTask.targets,
      };
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  };

  const updateErrorTransaction = (id, errorMsg) => {
    try {
      database.exec('BEGIN IMMEDIATE TRANSACTION');
      const result = updateErrorStmt.run(errorMsg, Number(id));
      database.exec('COMMIT');
      return { changes: result.changes };
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  };

  const updateTaskStatusTransaction = (id, status) => {
    try {
      database.exec('BEGIN IMMEDIATE TRANSACTION');
      const result = updateTaskStatusStmt.run(status, Number(id));
      database.exec('COMMIT');
      return { changes: result.changes };
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  };

  const deleteTaskTransaction = (id) => {
    try {
      database.exec('BEGIN IMMEDIATE TRANSACTION');
      const result = deleteTaskStmt.run(Number(id));
      database.exec('COMMIT');
      return { changes: result.changes };
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  };

  const updatePrimaryTargetTransaction = (taskId, newUrl) => {
    try {
      database.exec('BEGIN IMMEDIATE TRANSACTION');
      const numericTaskId = Number(taskId);
      const cleaned = typeof newUrl === 'string' ? newUrl.trim() : '';
      if (!cleaned) {
        throw new Error('RTMP 地址不能为空');
      }

      const task = findTaskByIdStmt.get(numericTaskId);
      if (!task) {
        throw new Error(`任务不存在: ${taskId}`);
      }

      const oldUrl = task.primary_target_url || task.target_url;

      updatePrimaryUrlStmt.run(cleaned, cleaned, numericTaskId);

      if (oldUrl) {
        deleteTargetByUrlStmt.run(numericTaskId, oldUrl);
      }

      insertTarget(numericTaskId, cleaned);

      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  };

  const updateRoomIdTransaction = (taskId, newRoomId) => {
    try {
      database.exec('BEGIN IMMEDIATE TRANSACTION');
      const numericTaskId = Number(taskId);
      const cleaned = typeof newRoomId === 'string' ? newRoomId.trim() : '';
      if (!cleaned || !/^\d+$/.test(cleaned)) {
        throw new Error('房间 ID 只能是纯数字');
      }

      const task = findTaskByIdStmt.get(numericTaskId);
      if (!task) {
        throw new Error(`任务不存在: ${taskId}`);
      }

      updateRoomIdStmt.run(cleaned, numericTaskId);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  };

  const deleteTargetByIdTransaction = (taskId, targetId) => {
    try {
      database.exec('BEGIN IMMEDIATE TRANSACTION');
      const numericTaskId = Number(taskId);
      const numericTargetId = Number(targetId);

      deleteTargetByIdStmt.run(numericTargetId, numericTaskId);

      const remaining = selectTaskTargetsStmt.all(numericTaskId);
      const newPrimary = remaining[0]?.target_url || null;
      updatePrimaryUrlStmt.run(newPrimary, newPrimary, numericTaskId);

      database.exec('COMMIT');
      return { remaining: remaining.length };
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  };

  const addTargetTransaction = (taskId, targetUrl) => {
    try {
      database.exec('BEGIN IMMEDIATE TRANSACTION');
      const cleaned = typeof targetUrl === 'string' ? targetUrl.trim() : '';
      if (!cleaned) {
        throw new Error('RTMP 地址不能为空');
      }

      const task = findTaskByIdStmt.get(Number(taskId));
      if (!task) {
        throw new Error(`任务不存在: ${taskId}`);
      }

      const result = insertTarget(taskId, cleaned);
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  };

  return {
    addTask(task) {
      return addTaskTransaction(task);
    },

    addTarget(taskId, targetUrl) {
      return addTargetTransaction(taskId, targetUrl);
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
      return updateTaskStatusTransaction(id, status);
    },

    updateError(id, errorMsg) {
      return updateErrorTransaction(id, errorMsg);
    },

    deleteTask(id) {
      return deleteTaskTransaction(id);
    },

    updatePrimaryTarget(taskId, newUrl) {
      return updatePrimaryTargetTransaction(taskId, newUrl);
    },

    updateRoomId(taskId, newRoomId) {
      return updateRoomIdTransaction(taskId, newRoomId);
    },

    deleteTargetById(taskId, targetId) {
      return deleteTargetByIdTransaction(taskId, targetId);
    },

    enableAllTasks() {
      enableAllTasksStmt.run();
    },

    disableAllTasks() {
      disableAllTasksStmt.run();
    },

    getSetting(key) {
      const row = getSettingStmt.get(key);
      return row ? row.value : null;
    },

    setSetting(key, value) {
      setSettingStmt.run(key, String(value));
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
