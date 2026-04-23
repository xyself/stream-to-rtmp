const { Bot, InlineKeyboard, Keyboard, session, InputFile } = require('grammy');
const os = require('os');
const fs = require('fs');
const db = require('../db');
const scheduler = require('../core/scheduler');
const views = require('./views');
const { parseAllowedChatId, resetAllSessions } = require('./utils/parser');
const roomHandlers = require('./handlers/room');
const rtmpHandlers = require('./handlers/rtmp');
const gistSync = require('../db/gist-sync');

async function safeEditMessageText(ctx, text, options) {
  try {
    await ctx.editMessageText(text, options);
  } catch (err) {
    if (err.message?.includes('message is not modified')) return;
    throw err;
  }
}

function createChatGuard(allowedChatId = parseAllowedChatId()) {
  if (!allowedChatId) return async (ctx, next) => next();
  return async (ctx, next) => {
    const chatId = ctx?.chat?.id;
    if (!allowedChatId.has(String(chatId))) {
      if (ctx?.callbackQuery) {
        await ctx.answerCallbackQuery().catch(() => {});
      }
      if (chatId) {
        await ctx.api.leaveChat(chatId).catch(() => {});
      }
      return;
    }
    await next();
  };
}

function buildMainKeyboard() {
  return new Keyboard()
    .text('📺 管理面板').text('🏠 房间管理').text('➕ 添加房间')
    .row()
    .text('🔔 通知管理').text('📊 推流状态').text('🛠️ FFmpeg 参数')
    .resized();
}

function buildDashboardKeyboard() {
  const transcodeOn = db.getSetting?.('transcode_video') === '1';
  return new InlineKeyboard()
    .text('▶️ 全部开启', 'global_enable_all')
    .text('🛑 全部暂停', 'global_disable_all')
    .row()
    .text('🔄 刷新全部', 'global_refresh_all')
    .text('🧹 清理重启', 'global_clean_restart')
    .row()
    .text(`🎬 画质转码: ${transcodeOn ? '✅ 开启' : '⚪ 关闭'}`, 'global_toggle_transcode')
    .row()
    .text('☁️ 上传到 Gist', 'global_sync_gist').text('📥 从 Gist 恢复', 'global_restore_gist');
}

function buildTaskListKeyboard(tasks) {
  const keyboard = new InlineKeyboard();
  tasks.forEach((task) => {
    const icon = task.status === 'ENABLED' ? '✅' : '🛑';
    keyboard.text(`${icon} ${views.platformLabel(task.platform)} ${task.room_id}`, `manage:${task.id}`).row();
  });
  return keyboard;
}

function buildTaskDetailKeyboard(task) {
  const keyboard = new InlineKeyboard()
    .text(task.status === 'ENABLED' ? '🛑 停止监控' : '▶️ 开启监控', `toggle:${task.id}:${task.status}`)
    .row();
  if (task.status === 'ENABLED') {
    keyboard.text('📸 获取截图', `screenshot:${task.id}`).row();
  }
  keyboard
    .text('🔄 刷新', `refresh:${task.id}`)
    .text('✏️ 房间号', `editroom:${task.id}`)
    .row()
    .text('➕ 添加地址', `addrtmp_ui:${task.id}`)
    .text('➖ 删除地址', `delurl_ui:${task.id}`)
    .row()
    .text('🗑️ 删除任务', `del:${task.id}`)
    .text('⬅️ 返回', 'back_list');
  return keyboard;
}

function buildNotificationKeyboard(settings) {
  const keyboard = new InlineKeyboard();
  for (const item of views.NOTIFICATION_TYPES) {
    const enabled = settings[item.key] !== false;
    keyboard.text(`${enabled ? '✅' : '⛔'} ${item.label}`, `ntoggle:${item.key}`).row();
  }
  return keyboard;
}

function getSystemInfo() {
  const cpus = os.cpus();
  const loadAvg = os.loadavg()[0];
  const cpuCount = cpus.length || 1;
  const cpuPercent = Math.min(100, Math.round((loadAvg / cpuCount) * 100));
  const totalMem = os.totalmem();
  const usedMem = totalMem - os.freemem();
  
  // 核心服务占用
  const serviceMem = process.memoryUsage().rss;
  
  let dbSize = null;
  try {
    const stat = fs.statSync(db.resolveDatabasePath());
    dbSize = views.formatBytes(stat.size);
  } catch {}
  
  return {
    cpuPercent,
    cpuBar: views.progressBar(cpuPercent),
    memUsed: views.formatBytes(usedMem),
    memTotal: views.formatBytes(totalMem),
    serviceMem: views.formatBytes(serviceMem),
    uptime: views.formatUptime(process.uptime()),
    dbSize,
    transcodeVideo: db.getSetting?.('transcode_video') === '1',
  };
}

function getRecentErrors() {
  return db.getAllTasks()
    .filter((t) => t.last_error)
    .map((t) => `[${views.platformLabel(t.platform)} #${t.room_id}] ${t.last_error}`);
}

function getNotificationSettings() {
  const settings = {};
  for (const item of views.NOTIFICATION_TYPES) {
    settings[item.key] = db.getSetting(item.key) !== '0';
  }
  return settings;
}

function isNotificationEnabled(type) {
  const keyMap = {
    live_start: 'notify_live_start',
    offline: 'notify_offline',
    stream_ended: 'notify_stream_ended',
    ffmpeg_error: 'notify_ffmpeg_error',
    error: 'notify_ffmpeg_error',
  };
  const key = keyMap[type];
  if (!key) return true;
  return db.getSetting(key) !== '0';
}

async function registerBotCommands(bot) {
  if (!bot?.api?.setMyCommands) return;
  await bot.api.setMyCommands([
    { command: 'start', description: '打开直播转播控制中心' },
    { command: 'panel', description: '查看管理面板' },
    { command: 'rooms', description: '查看房间列表' },
    { command: 'addroom', description: '添加新的直播房间' },
    { command: 'status', description: '推流健康监控面板' },
    { command: 'notify', description: '管理通知设置' },
  ]);
}

function createRelayBot(token = process.env.TG_TOKEN) {
  const bot = new Bot(token, { client: { timeoutSeconds: 60 } });
  const mainKeyboard = buildMainKeyboard();

  const sharedDeps = {
    safeEditMessageText,
    buildTaskDetailKeyboard,
    buildTaskListKeyboard,
    buildDashboardKeyboard,
    buildMainKeyboard,
    mainKeyboard,
    getSystemInfo,
    getRecentErrors,
    InputFile,
  };

  const showDashboard = async (ctx) => {
    const text = views.renderDashboard({
      system: getSystemInfo(),
      stats: scheduler.getStats(),
      recentErrors: getRecentErrors(),
    });
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: buildDashboardKeyboard() });
  };

  const showTraffic = async (ctx) => {
    if (typeof scheduler.enableAllStats === 'function') {
      scheduler.enableAllStats();
    }
    await ctx.reply(views.renderRoomTraffic(scheduler.getTrafficStats()), { parse_mode: 'HTML', reply_markup: mainKeyboard });
  };

  const showStatus = async (ctx) => {
    // 触发立即刷新房间信息，确保获取最新封面和标题
    try {
      await Promise.race([
        scheduler.refreshAllRoomInfo(),
        new Promise((resolve) => setTimeout(resolve, 3000)), // 最多等3秒
      ]);
    } catch (err) {}

    const stats = scheduler.getTrafficStats();
    if (stats.length === 0) {
      return await ctx.reply('当前没有正在运行的任务');
    }

    for (const task of stats) {
      const roomInfo = task.traffic?.roomInfo || {};
      const statusText = views.renderDetailedStatus([task]);
      
      if (roomInfo.cover) {
        // 添加时间戳防止 TG 缓存旧封面
        const coverUrl = roomInfo.cover.includes('?') 
          ? `${roomInfo.cover}&t=${Date.now()}` 
          : `${roomInfo.cover}?t=${Date.now()}`;
          
        try {
          await ctx.replyWithPhoto(coverUrl, {
            caption: statusText,
            parse_mode: 'HTML',
          });
          continue;
        } catch (err) {
          // 忽略发送失败
        }
      }
      await ctx.reply(statusText, { parse_mode: 'HTML' });
    }
  };

  bot.use(createChatGuard());
  bot.use(session({ initial: () => ({ addRoom: { step: null, roomId: null, platform: null } }) }));

  const showNotificationSettings = async (ctx) => {
    const settings = getNotificationSettings();
    await ctx.reply(views.renderNotificationSettings(settings), {
      parse_mode: 'HTML',
      reply_markup: buildNotificationKeyboard(settings),
    });
  };

  bot.command('start', async (ctx) => {
    resetAllSessions(ctx.session);
    await ctx.reply('🚀 直播转播控制中心', { reply_markup: mainKeyboard });
  });
  bot.command('panel', showDashboard);
  bot.command('status', showStatus);
  bot.command('notify', showNotificationSettings);
  bot.command('traffic', showTraffic);

  bot.hears('📺 管理面板', showDashboard);
  bot.hears('📊 推流状态', showStatus);
  bot.hears('🛠️ FFmpeg 参数', async (ctx) => {
    const stats = scheduler.getTrafficStats();
    await ctx.reply(views.renderFfmpegParams(stats), { parse_mode: 'HTML' });
  });
  bot.hears('🔔 通知管理', showNotificationSettings);


  bot.callbackQuery(/^ntoggle:(.+)/, async (ctx) => {
    const key = ctx.match[1];
    const newValue = db.getSetting(key) === '0' ? '1' : '0';
    db.setSetting(key, newValue);
    await ctx.answerCallbackQuery(newValue === '1' ? '✅ 已开启' : '⛔ 已关闭');
    const settings = getNotificationSettings();
    await safeEditMessageText(ctx, views.renderNotificationSettings(settings), {
      parse_mode: 'HTML',
      reply_markup: buildNotificationKeyboard(settings),
    });
  });

  bot.callbackQuery('global_enable_all', async (ctx) => {
    db.enableAllTasks();
    await scheduler.tick?.();
    await ctx.answerCallbackQuery('已全部开启');
    await safeEditMessageText(ctx, views.renderDashboard({ system: getSystemInfo(), stats: scheduler.getStats(), recentErrors: getRecentErrors() }), { parse_mode: 'HTML', reply_markup: buildDashboardKeyboard() });
  });

  bot.callbackQuery('global_disable_all', async (ctx) => {
    db.disableAllTasks();
    await scheduler.tick?.();
    await ctx.answerCallbackQuery('已全部暂停');
    await safeEditMessageText(ctx, views.renderDashboard({ system: getSystemInfo(), stats: scheduler.getStats(), recentErrors: getRecentErrors() }), { parse_mode: 'HTML', reply_markup: buildDashboardKeyboard() });
  });

  bot.callbackQuery('global_refresh_all', async (ctx) => {
    const tasks = db.getAllTasks().filter((t) => t.status === 'ENABLED');
    for (const task of tasks) { await scheduler.refreshTask?.(task); }
    await ctx.answerCallbackQuery(`已刷新 ${tasks.length} 个任务`);
    await safeEditMessageText(ctx, views.renderDashboard({ system: getSystemInfo(), stats: scheduler.getStats(), recentErrors: getRecentErrors() }), { parse_mode: 'HTML', reply_markup: buildDashboardKeyboard() });
  });

  bot.callbackQuery('global_clean_restart', async (ctx) => {
    scheduler.stopAll();
    await scheduler.tick?.();
    await ctx.answerCallbackQuery('已清理并重启所有任务');
    await safeEditMessageText(ctx, views.renderDashboard({ system: getSystemInfo(), stats: scheduler.getStats(), recentErrors: getRecentErrors() }), { parse_mode: 'HTML', reply_markup: buildDashboardKeyboard() });
  });

  bot.callbackQuery('global_sync_gist', async (ctx) => {
    if (!gistSync.isConfigured()) {
      await ctx.answerCallbackQuery({ text: '⚠️ 未配置 GIST_TOKEN / GIST_ID', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery('⏳ 正在同步...');
    const ok = await gistSync.uploadRooms(db);
    await safeEditMessageText(
      ctx,
      views.renderDashboard({ system: getSystemInfo(), stats: scheduler.getStats(), recentErrors: getRecentErrors() }),
      { parse_mode: 'HTML', reply_markup: buildDashboardKeyboard() }
    );
    await ctx.reply(ok ? '☁️ 已成功同步到 Gist' : '❌ 同步失败，请检查日志');
  });

  bot.callbackQuery('global_restore_gist', async (ctx) => {
    if (!gistSync.isConfigured()) {
      await ctx.answerCallbackQuery({ text: '⚠️ 未配置 GIST_TOKEN / GIST_ID', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery('⏳ 正在从 Gist 恢复...');
    const ok = await gistSync.downloadDefault();
    if (ok) {
      scheduler.stopAll();
      await scheduler.tick?.();
    }
    await safeEditMessageText(
      ctx,
      views.renderDashboard({ system: getSystemInfo(), stats: scheduler.getStats(), recentErrors: getRecentErrors() }),
      { parse_mode: 'HTML', reply_markup: buildDashboardKeyboard() }
    );
    await ctx.reply(ok ? '📥 已从 Gist 恢复，任务已重启' : '❌ 恢复失败，请检查日志');
  });

  bot.callbackQuery('global_toggle_transcode', async (ctx) => {
    const newValue = db.getSetting('transcode_video') === '1' ? '0' : '1';
    db.setSetting('transcode_video', newValue);
    await ctx.answerCallbackQuery(`${newValue === '1' ? '✅ 转码已开启' : '⚪ 转码已关闭'}（重启任务后生效）`);
    await safeEditMessageText(ctx, views.renderDashboard({ system: getSystemInfo(), stats: scheduler.getStats(), recentErrors: getRecentErrors() }), { parse_mode: 'HTML', reply_markup: buildDashboardKeyboard() });
  });

  roomHandlers.register(bot, sharedDeps);
  rtmpHandlers.register(bot, sharedDeps);

  return bot;
}

const defaultBot = createRelayBot();
defaultBot.pendingNotifications = [];

defaultBot.handleManagerNotification = function(notification) {
  const { taskId, type, message } = notification;
  const task = db.getTaskById(taskId);
  if (!task) return;
  if (!isNotificationEnabled(type)) return;

  const key = `${taskId}-${type}`;
  if (this._lastNotified?.[key] === message) return;
  if (!this._lastNotified) this._lastNotified = {};
  this._lastNotified[key] = message;

  const label = `${views.platformLabel(task.platform)} #${task.room_id}`;
  let text = '';
  switch (type) {
    case 'live_start':    text = `🖥️${label}\n💬 ${message}`; break;
    case 'offline':       text = `📌 ${label}\n💬 ${message}`; break;
    case 'stream_ended':  text = `🔴 ${label}\n💬 ${message}`; break;
    case 'error':         text = `⚠️ ${label}\n💬 错误: ${message}`; break;
    case 'ffmpeg_error':  text = `❌ ${label}\n💬 ${message}`; break;
    default: return;
  }

  const chatIds = parseAllowedChatId();
  if (!chatIds || !chatIds.size || typeof this.api?.sendMessage !== 'function') return;

  const sendToAll = async () => {
    for (const chatId of chatIds) {
      try {
        if (type === 'live_start' && notification.imageBuffer) {
          await this.api.sendPhoto(chatId, new InputFile(notification.imageBuffer, `live_${task.room_id}.jpg`), { caption: text });
        } else {
          await this.api.sendMessage(chatId, text);
        }
      } catch (err) {
        console.error(`发送 Telegram 通知失败 (chat: ${chatId}):`, err.message);
      }
    }
  };

  sendToAll();
};

module.exports = defaultBot;
module.exports.createRelayBot = createRelayBot;
module.exports.createChatGuard = createChatGuard;
module.exports.parseAllowedChatId = parseAllowedChatId;
module.exports.buildMainKeyboard = buildMainKeyboard;
module.exports.buildTaskListKeyboard = buildTaskListKeyboard;
module.exports.buildTaskDetailKeyboard = buildTaskDetailKeyboard;
module.exports.buildDashboardKeyboard = buildDashboardKeyboard;
module.exports.getSystemInfo = getSystemInfo;
module.exports.getRecentErrors = getRecentErrors;
module.exports.getNotificationSettings = getNotificationSettings;
module.exports.isNotificationEnabled = isNotificationEnabled;
module.exports.buildNotificationKeyboard = buildNotificationKeyboard;
module.exports.registerBotCommands = registerBotCommands;
module.exports.saveRoomTask = roomHandlers.saveRoomTask;
