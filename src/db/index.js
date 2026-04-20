const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const defaultDatabasePath = path.resolve(process.cwd(), 'data/data.db');

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

  return {
    addTask(task) {
      return addTaskTransaction(task);
    },

    addTarget(taskId, targetUrl) {
      const cleaned = typeof targetUrl === 'string' ? targetUrl.trim() : '';
      if (!cleaned) {
        throw new Error('RTMP 地址不能为空');
      }

      const task = findTaskByIdStmt.get(Number(taskId));
      if (!task) {
        throw new Error(`任务不存在: ${taskId}`);
      }

      return insertTarget(taskId, cleaned);
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
      const result = updateTaskStatusStmt.run(status, Number(id));
      return { changes: result.changes };
    },

    updateError(id, errorMsg) {
      const result = updateErrorStmt.run(errorMsg, Number(id));
      return { changes: result.changes };
    },

    deleteTask(id) {
      const result = deleteTaskStmt.run(Number(id));
      return { changes: result.changes };
    },
  };
}

module.exports = createStore();
module.exports.createStore = createStore;
module.exports.resolveDatabasePath = resolveDatabasePath;
