const { Bot, InlineKeyboard, Keyboard, session, InputFile } = require('grammy');
const os = require('os');
const fs = require('fs');
const db = require('../db');
const scheduler = require('../core/scheduler');
const views = require('./views');

async function safeEditMessageText(ctx, text, options) {
  try {
    await ctx.editMessageText(text, options);
  } catch (err) {
    if (err.message?.includes('message is not modified')) return;
    throw err;
  }
}

function parseAllowedChatId(value = process.env.TG_CHAT_ID) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).trim();
}

function createChatGuard(allowedChatId = parseAllowedChatId()) {
  if (!allowedChatId) {
    return async (ctx, next) => next();
  }

  return async (ctx, next) => {
    const chatId = ctx?.chat?.id;
    if (String(chatId) !== allowedChatId) {
      if (typeof ctx?.answerCallbackQuery === 'function') {
        await ctx.answerCallbackQuery({ text: '❌ 未授权会话', show_alert: true });
      }
      if (typeof ctx?.reply === 'function') {
        await ctx.reply('❌ 当前会话无权使用这个机器人。');
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
    .text('📈 流量查看').text('🔔 通知管理').text('❌ 取消操作')
    .resized();
}

function getSystemInfo() {
  const cpus = os.cpus();
  const loadAvg = os.loadavg()[0];
  const cpuCount = cpus.length || 1;
  const cpuPercent = Math.min(100, Math.round((loadAvg / cpuCount) * 100));

  const totalMem = os.totalmem();
  const usedMem = totalMem - os.freemem();

  let dbSize = null;
  try {
    const dbPath = db.resolveDatabasePath();
    const stat = fs.statSync(dbPath);
    dbSize = views.formatBytes(stat.size);
  } catch {}

  return {
    cpuPercent,
    cpuBar: views.progressBar(cpuPercent),
    memUsed: views.formatBytes(usedMem),
    memTotal: views.formatBytes(totalMem),
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
    const val = db.getSetting(item.key);
    settings[item.key] = val !== '0';
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
  const val = db.getSetting(key);
  return val !== '0';
}

function buildNotificationKeyboard(settings) {
  const keyboard = new InlineKeyboard();
  for (const item of views.NOTIFICATION_TYPES) {
    const enabled = settings[item.key] !== false;
    const icon = enabled ? '✅' : '⛔';
    keyboard.text(`${icon} ${item.label}`, `ntoggle:${item.key}`).row();
  }
  return keyboard;
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
    .text(`🎬 画质转码: ${transcodeOn ? '✅ 开启' : '⚪ 关闭'}`, 'global_toggle_transcode');
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

  // 只有已启用的任务显示截图按钮
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

async function registerBotCommands(bot) {
  if (!bot?.api?.setMyCommands) return;
  await bot.api.setMyCommands([
    { command: 'start', description: '打开直播转播控制中心' },
    { command: 'panel', description: '查看管理面板' },
    { command: 'rooms', description: '查看房间列表' },
    { command: 'addroom', description: '添加新的直播房间' },
    { command: 'traffic', description: '查看房间流量统计' },
  ]);
}

function parseExtraTargetUrls(input = '') {
  return input
    .split(/\r?\n|,|，/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function getMessageTextOrEmpty(message) {
  if (typeof message?.text === 'string') return message.text.trim();
  if (typeof message?.caption === 'string') return message.caption.trim();
  return '';
}

function isNumericRoomId(value) {
  return /^\d+$/.test(value);
}

function parseLiveRoomInput(input) {
  const text = input.trim();

  // 纯数字 → 需要选平台
  if (/^\d+$/.test(text)) {
    return { roomId: text, platform: null };
  }

  // Bilibili 直播间: https://live.bilibili.com/12345
  const biliLive = text.match(/live\.bilibili\.com\/(\d+)/i);
  if (biliLive) return { roomId: biliLive[1], platform: 'bilibili' };

  // Bilibili 空间 → 不是直播间，但用户可能混淆，友好提示
  if (/space\.bilibili\.com/i.test(text)) {
    return { error: '这是 B 站个人空间链接，请发送直播间链接（live.bilibili.com/房间号）' };
  }

  // 斗鱼直播间: https://www.douyu.com/12345
  const douyuLive = text.match(/douyu\.com\/(\d+)/i);
  if (douyuLive) return { roomId: douyuLive[1], platform: 'douyu' };

  // 抖音直播间: https://live.douyin.com/123456789
  const douyinLive = text.match(/live\.douyin\.com\/(\d+)/i);
  if (douyinLive) return { roomId: douyinLive[1], platform: 'douyin' };

  // 抖音短链接: https://v.douyin.com/xxxx
  if (/v\.douyin\.com/i.test(text)) {
    return { error: '请发送抖音直播间链接（live.douyin.com/房间号），不支持短链接' };
  }

  return { error: '无法识别，请发送直播间链接或纯数字房间号' };
}

function isValidRelayTargetUrl(value) {
  return /^(rtmp|rtmps):\/\//i.test(value);
}

const SESSION_TIMEOUT_MS = 5 * 60 * 1000;

function isSessionExpired(state) {
  if (!state?.startedAt) return false;
  return Date.now() - state.startedAt > SESSION_TIMEOUT_MS;
}

function cleanExpiredSessions(sessionData) {
  if (isSessionExpired(sessionData.addRoom)) {
    sessionData.addRoom = { step: null, roomId: null, platform: null };
  }
  if (isSessionExpired(sessionData.editRoom)) {
    sessionData.editRoom = null;
  }
  if (isSessionExpired(sessionData.editRtmp)) {
    sessionData.editRtmp = null;
  }
  if (isSessionExpired(sessionData.addRtmp)) {
    sessionData.addRtmp = null;
  }
}

function resetAllSessions(sessionData) {
  sessionData.addRoom = { step: null, roomId: null, platform: null };
  sessionData.editRoom = null;
  sessionData.editRtmp = null;
  sessionData.addRtmp = null;
}

function ensureAddRoomState(sessionData) {
  if (!sessionData.addRoom || typeof sessionData.addRoom !== 'object') {
    sessionData.addRoom = { step: null, roomId: null, platform: null };
  }
  return sessionData.addRoom;
}

function resetAddRoomState(sessionData) {
  sessionData.addRoom = { step: null, roomId: null, platform: null };
}

async function saveRoomTask(ctx, { roomId, platform, targetUrl }) {
  db.addTask({ platform, roomId, targetUrl, extraTargetUrls: [] });
  await scheduler.tick?.();
  
  const message = [
    `<b>✅ 任务已下发</b>`,
    '',
    `<b>📌 任务信息</b>`,
    `  平台：${views.escapeHtml(views.platformLabel(platform))}`,
    `  房间：#${views.escapeHtml(roomId)}`,
    `  状态：✅ 已启用`,
    '',
    `<b>📤 推流地址</b>`,
    `<code>${views.escapeHtml(targetUrl)}</code>`,
    '',
    `⚙️ 监控中（FFmpeg 会在检测到开播后立即启动）`,
    '',
    `<i>💡 如需追加备用线路，进入「🏠 房间管理」点击对应房间即可操作</i>`,
  ].join('\n');
  
  await ctx.reply(message, { parse_mode: 'HTML' });
}

function createRelayBot(token = process.env.TG_TOKEN) {
  const bot = new Bot(token, {
    client: {
      timeoutSeconds: 60,
    },
  });
  const mainKeyboard = buildMainKeyboard();

  const showDashboard = async (ctx) => {
    const text = views.renderDashboard({
      system: getSystemInfo(),
      stats: scheduler.getStats(),
      recentErrors: getRecentErrors(),
    });
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: buildDashboardKeyboard() });
  };

  const showRooms = async (ctx) => {
    const tasks = db.getAllTasks();
    if (tasks.length === 0) {
      await ctx.reply(views.renderRoomList(tasks), { parse_mode: 'HTML', reply_markup: mainKeyboard });
      return;
    }

    await ctx.reply(views.renderRoomList(tasks), {
      parse_mode: 'HTML',
      reply_markup: buildTaskListKeyboard(tasks),
    });
  };

  const startAddRoom = async (ctx) => {
    const state = ensureAddRoomState(ctx.session);
    state.step = 'wait_room_id';
    state.roomId = null;
    state.platform = null;
    state.startedAt = Date.now();
    await ctx.reply('✨ 新建转播任务\n\n请发送直播间链接或房间号：\n\n<i>支持：\n· https://live.bilibili.com/房间号\n· https://www.douyu.com/房间号\n· https://live.douyin.com/房间号\n· 纯数字房间号（需手动选平台）</i>', { parse_mode: 'HTML' });
  };

  const showTraffic = async (ctx) => {
    await ctx.reply(views.renderRoomTraffic(scheduler.getTrafficStats()), { parse_mode: 'HTML', reply_markup: mainKeyboard });
  };

  bot.use(createChatGuard());
  bot.use(session({
    initial: () => ({
      addRoom: { step: null, roomId: null, platform: null },
    }),
  }));

  bot.command('start', async (ctx) => {
    resetAddRoomState(ctx.session);
    await ctx.reply('🚀 直播转播控制中心', { reply_markup: mainKeyboard });
  });

  bot.command('panel', showDashboard);
  bot.command('rooms', showRooms);
  bot.command('addroom', startAddRoom);
  bot.command('traffic', showTraffic);
  bot.command('addrtmp', async (ctx) => {
    const text = getMessageTextOrEmpty(ctx.message);
    const parts = text.split(/\s+/).filter(Boolean);

    if (parts.length < 3) {
      await ctx.reply('用法：\n/addrtmp 房间号 rtmp://地址 [更多 rtmp/rtmps 地址...]');
      return;
    }

    const roomId = parts[1];
    const targetUrls = parts.slice(2);

    if (!isNumericRoomId(roomId)) {
      await ctx.reply('❌ 房间号必须是纯数字。');
      return;
    }

    if (targetUrls.some((value) => !isValidRelayTargetUrl(value))) {
      await ctx.reply('❌ 请输入有效的 RTMP/RTMPS 地址，必须以 rtmp:// 或 rtmps:// 开头。');
      return;
    }

    const task = db.getAllTasks().find((item) => String(item.room_id) === roomId);
    if (!task) {
      await ctx.reply(`❌ 未找到房间 ${roomId} 对应的任务。`);
      return;
    }

    try {
      for (const targetUrl of targetUrls) {
        db.addTarget(task.id, targetUrl);
      }
      await scheduler.tick?.();
      await ctx.reply(`✅ 已为房间 ${roomId} 增加 ${targetUrls.length} 条 RTMP/RTMPS。`);
    } catch (err) {
      await ctx.reply(`❌ 增加 RTMP 失败：${err.message}`);
    }
  });

  bot.hears('📺 管理面板', showDashboard);
  bot.hears('➕ 添加房间', startAddRoom);
  bot.hears('🏠 房间管理', showRooms);
  bot.hears('📈 流量查看', showTraffic);

  bot.hears('🔔 通知管理', async (ctx) => {
    const settings = getNotificationSettings();
    await ctx.reply(views.renderNotificationSettings(settings), {
      parse_mode: 'HTML',
      reply_markup: buildNotificationKeyboard(settings),
    });
  });

  bot.hears('❌ 取消操作', async (ctx) => {
    resetAllSessions(ctx.session);
    await ctx.reply('✅ 已取消当前操作', { reply_markup: mainKeyboard });
  });

  bot.callbackQuery(/^ntoggle:(.+)/, async (ctx) => {
    const key = ctx.match[1];
    const current = db.getSetting(key);
    const newValue = current === '0' ? '1' : '0';
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
    const text = views.renderDashboard({
      system: getSystemInfo(),
      stats: scheduler.getStats(),
      recentErrors: getRecentErrors(),
    });
    await safeEditMessageText(ctx, text, { parse_mode: 'HTML', reply_markup: buildDashboardKeyboard() });
  });

  bot.callbackQuery('global_disable_all', async (ctx) => {
    db.disableAllTasks();
    await scheduler.tick?.();
    await ctx.answerCallbackQuery('已全部暂停');
    const text = views.renderDashboard({
      system: getSystemInfo(),
      stats: scheduler.getStats(),
      recentErrors: getRecentErrors(),
    });
    await safeEditMessageText(ctx, text, { parse_mode: 'HTML', reply_markup: buildDashboardKeyboard() });
  });

  bot.callbackQuery('global_refresh_all', async (ctx) => {
    const tasks = db.getAllTasks().filter((t) => t.status === 'ENABLED');
    for (const task of tasks) {
      await scheduler.refreshTask?.(task);
    }
    await ctx.answerCallbackQuery(`已刷新 ${tasks.length} 个任务`);
    const text = views.renderDashboard({
      system: getSystemInfo(),
      stats: scheduler.getStats(),
      recentErrors: getRecentErrors(),
    });
    await safeEditMessageText(ctx, text, { parse_mode: 'HTML', reply_markup: buildDashboardKeyboard() });
  });

  bot.callbackQuery('global_clean_restart', async (ctx) => {
    scheduler.stopAll();
    await scheduler.tick?.();
    await ctx.answerCallbackQuery('已清理并重启所有任务');
    const text = views.renderDashboard({
      system: getSystemInfo(),
      stats: scheduler.getStats(),
      recentErrors: getRecentErrors(),
    });
    await safeEditMessageText(ctx, text, { parse_mode: 'HTML', reply_markup: buildDashboardKeyboard() });
  });

  bot.callbackQuery('global_toggle_transcode', async (ctx) => {
    const current = db.getSetting('transcode_video');
    const newValue = current === '1' ? '0' : '1';
    db.setSetting('transcode_video', newValue);

    const label = newValue === '1' ? '✅ 转码已开启' : '⚪ 转码已关闭';
    await ctx.answerCallbackQuery(`${label}（重启任务后生效）`);
    const text = views.renderDashboard({
      system: getSystemInfo(),
      stats: scheduler.getStats(),
      recentErrors: getRecentErrors(),
    });
    await safeEditMessageText(ctx, text, { parse_mode: 'HTML', reply_markup: buildDashboardKeyboard() });
  });

  bot.callbackQuery(/^manage:(\d+)/, async (ctx) => {
    const taskId = ctx.match[1];
    const task = db.getTaskById(taskId);
    if (!task) {
      await ctx.answerCallbackQuery('任务已不存在');
      return;
    }

    await safeEditMessageText(ctx,
      views.renderTaskDetail(task, scheduler.isTaskRunning(task)),
      { parse_mode: 'HTML', reply_markup: buildTaskDetailKeyboard(task) }
    );
  });

  bot.callbackQuery(/^toggle:(\d+):(\w+)/, async (ctx) => {
    const [, id, status] = ctx.match;
    const newStatus = status === 'ENABLED' ? 'DISABLED' : 'ENABLED';
    db.updateTaskStatus(id, newStatus);
    await scheduler.tick?.();
    await ctx.answerCallbackQuery(`状态已切换至 ${newStatus}`);

    const task = db.getTaskById(id);
    await safeEditMessageText(ctx,
      views.renderTaskDetail(task, scheduler.isTaskRunning(task)),
      { parse_mode: 'HTML', reply_markup: buildTaskDetailKeyboard(task) }
    );
  });

  bot.callbackQuery(/^refresh:(\d+)/, async (ctx) => {
    const taskId = ctx.match[1];
    const task = db.getTaskById(taskId);
    if (!task) {
      await ctx.answerCallbackQuery('任务已不存在');
      return;
    }

    await scheduler.refreshTask?.(task);
    const latestTask = db.getTaskById(taskId) || task;
    await ctx.answerCallbackQuery('已触发立即刷新');

    const newText = views.renderTaskDetail(latestTask, scheduler.isTaskRunning(latestTask));
    const newKeyboard = buildTaskDetailKeyboard(latestTask);

    await safeEditMessageText(ctx, newText, { parse_mode: 'HTML', reply_markup: newKeyboard });
  });

  bot.callbackQuery(/^screenshot:(\d+)/, async (ctx) => {
    const taskId = ctx.match[1];
    const task = db.getTaskById(taskId);
    if (!task) {
      await ctx.answerCallbackQuery('任务已不存在');
      return;
    }
    
    if (task.status !== 'ENABLED') {
      await ctx.answerCallbackQuery({
        text: '❌ 任务未启用，无法截图',
        show_alert: true
      });
      return;
    }

    const manager = scheduler.getTaskManager(task);
    if (!manager) {
      await ctx.answerCallbackQuery({
        text: '❌ 任务未运行，无法截图',
        show_alert: true
      });
      return;
    }

    await ctx.answerCallbackQuery({ text: '正在获取截图...' });
    
    try {
      const imageBuffer = await manager.captureSnapshot();
      await ctx.replyWithPhoto(
        new InputFile(imageBuffer, `screenshot_${task.room_id}.jpg`),
        { caption: `📸 ${views.platformLabel(task.platform)} #${task.room_id} 截图\n${new Date().toLocaleString()}` }
      );
    } catch (error) {
      const errorMessage = error.message || '未知错误';
      let userMessage = '❌ 获取截图失败';
      
      if (errorMessage.includes('流不可用')) {
        userMessage = '❌ 获取截图失败: 直播流不可用';
      } else if (errorMessage.includes('ffmpeg 执行失败')) {
        userMessage = `❌ 获取截图失败: ${errorMessage}`;
      } else if (errorMessage.includes('未获取到有效帧')) {
        userMessage = '❌ 获取截图失败: 未获取到有效视频帧';
      } else {
        userMessage = `❌ 获取截图失败: ${errorMessage}`;
      }
      
      await ctx.reply(userMessage);
    }
  });

  bot.callbackQuery(/^del:(\d+)/, async (ctx) => {
    db.deleteTask(ctx.match[1]);
    await ctx.answerCallbackQuery('任务已删除');
    await safeEditMessageText(ctx, '🗑️ 任务已物理删除');
  });

  bot.callbackQuery(/^editroom:(\d+)/, async (ctx) => {
    const taskId = ctx.match[1];
    const task = db.getTaskById(taskId);
    if (!task) {
      await ctx.answerCallbackQuery('任务已不存在');
      return;
    }

    await ctx.answerCallbackQuery();
    await ctx.reply(
      `✏️ 修改房间号\n\n` +
      `平台：${views.platformLabel(task.platform)}\n` +
      `当前房间号：${task.room_id}\n\n` +
      `请发送新的房间 ID（纯数字）：`
    );

    ctx.session.editRoom = {
      step: 'wait_new_room_id',
      taskId: taskId,
      startedAt: Date.now(),
    };
  });

  bot.callbackQuery(/^editrtmp:(\d+)/, async (ctx) => {
    const taskId = ctx.match[1];
    const task = db.getTaskById(taskId);
    if (!task) {
      await ctx.answerCallbackQuery('任务已不存在');
      return;
    }

    await ctx.answerCallbackQuery();
    const currentUrl = task.primary_target_url || task.target_url || '未配置';
    await ctx.reply(
      `✏️ 修改推流地址\n\n` +
      `房间：${views.platformLabel(task.platform)} #${task.room_id}\n\n` +
      `当前主推流地址：\n\`\`\`\n${currentUrl}\n\`\`\`\n\n` +
      `请发送新的 RTMP/RTMPS 推流地址：`
    );

    ctx.session.editRtmp = {
      step: 'wait_new_url',
      taskId: taskId,
      startedAt: Date.now(),
    };
  });

  bot.callbackQuery(/^addrtmp_ui:(\d+)/, async (ctx) => {
    const taskId = ctx.match[1];
    const task = db.getTaskById(taskId);
    if (!task) {
      await ctx.answerCallbackQuery('任务已不存在');
      return;
    }

    await ctx.answerCallbackQuery();
    await ctx.reply(`请输入新的 RTMP/RTMPS 推流地址（支持多个，用回车或逗号分隔）:\n\n房间：${views.platformLabel(task.platform)} #${task.room_id}`);
    ctx.session.addRtmp = { 
      step: 'wait_rtmp_urls',
      taskId: taskId,
      startedAt: Date.now(),
    };
  });

  bot.callbackQuery(/^delurl_ui:(\d+)/, async (ctx) => {
    const taskId = ctx.match[1];
    const task = db.getTaskById(taskId);
    if (!task) {
      await ctx.answerCallbackQuery('任务已不存在');
      return;
    }

    const targets = task.targets || [];
    if (targets.length === 0) {
      await ctx.answerCallbackQuery({ text: '当前没有推流地址', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();

    const keyboard = new InlineKeyboard();
    targets.forEach((target, idx) => {
      const label = `${idx + 1}. ${views.maskTargetUrl(target.target_url)}`;
      keyboard.text(label, `delurl:${taskId}:${target.id}`).row();
    });
    keyboard.text('⬅️ 取消', `manage:${taskId}`);

    const lines = [`🗑️ <b>选择要删除的推流地址：</b>`];
    targets.forEach((t, i) => {
      lines.push('');
      const tag = i === 0 ? ' ⭐主推流' : '';
      lines.push(`<b>${i + 1}.</b>${tag}`);
      lines.push(`<code>${views.escapeHtml(t.target_url)}</code>`);
    });

    await safeEditMessageText(ctx, lines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  });

  bot.callbackQuery(/^delurl:(\d+):(\d+)/, async (ctx) => {
    const [, taskId, targetId] = ctx.match;

    try {
      db.deleteTargetById(taskId, targetId);
      await ctx.answerCallbackQuery('已删除');

      const task = db.getTaskById(taskId);
      if (!task) {
        await safeEditMessageText(ctx, '任务已不存在');
        return;
      }

      await scheduler.refreshTask?.(task);

      await safeEditMessageText(ctx,
        views.renderTaskDetail(task, scheduler.isTaskRunning(task)),
        { parse_mode: 'HTML', reply_markup: buildTaskDetailKeyboard(task) }
      );
    } catch (err) {
      await ctx.answerCallbackQuery({ text: `删除失败：${err.message}`, show_alert: true });
    }
  });

  bot.callbackQuery('back_list', async (ctx) => {
    await ctx.answerCallbackQuery();
    const tasks = db.getAllTasks();
    await safeEditMessageText(ctx, views.renderRoomList(tasks), {
      parse_mode: 'HTML',
      reply_markup: tasks.length ? buildTaskListKeyboard(tasks) : undefined,
    });
  });

  bot.callbackQuery(/^p:(bilibili|douyu|douyin)$/, async (ctx) => {
    const state = ensureAddRoomState(ctx.session);
    if (state.step !== 'wait_platform') {
      await ctx.answerCallbackQuery({ text: '当前没有待选择的平台步骤', show_alert: false });
      return;
    }
    state.platform = ctx.match[1];
    state.step = 'wait_target_url';
    await ctx.answerCallbackQuery();
    await ctx.reply('请输入主 RTMP/RTMPS 推流地址：');
  });

  bot.on('message:text', async (ctx, next) => {
    const text = getMessageTextOrEmpty(ctx.message);
    if (text.startsWith('/')) {
      await next();
      return;
    }

    cleanExpiredSessions(ctx.session);
    const state = ensureAddRoomState(ctx.session);

    if (state.step === 'wait_room_id') {
      const parsed = parseLiveRoomInput(text);

      if (parsed.error) {
        await ctx.reply(`❌ ${parsed.error}`);
        return;
      }

      state.roomId = parsed.roomId;

      if (parsed.platform) {
        state.platform = parsed.platform;
        state.step = 'wait_target_url';
        const label = views.platformLabel(parsed.platform);
        await ctx.reply(`✅ 已识别：<b>${label}</b> 房间 <b>#${parsed.roomId}</b>\n\n请输入主 RTMP/RTMPS 推流地址：`, { parse_mode: 'HTML' });
      } else {
        state.step = 'wait_platform';
        const platformKeyboard = new InlineKeyboard()
          .text('Bilibili', 'p:bilibili')
          .text('斗鱼', 'p:douyu')
          .text('抖音', 'p:douyin');
        await ctx.reply('请选择直播平台：', { reply_markup: platformKeyboard });
      }
      return;
    }

    if (state.step === 'wait_target_url') {
      if (!isValidRelayTargetUrl(text)) {
        resetAddRoomState(ctx.session);
        await ctx.reply('❌ 主推流地址无效，必须以 rtmp:// 或 rtmps:// 开头。');
        return;
      }

      const payload = {
        roomId: state.roomId,
        platform: state.platform,
        targetUrl: text,
      };
      resetAddRoomState(ctx.session);

      try {
        await saveRoomTask(ctx, payload);
      } catch (err) {
        await ctx.reply(`❌ 保存失败：${err.message}`);
      }
      return;
    }

    // 处理修改房间号的输入
    const editRoomState = ctx.session.editRoom;
    if (editRoomState?.step === 'wait_new_room_id') {
      if (!isNumericRoomId(text)) {
        await ctx.reply('❌ 房间 ID 只能填写纯数字，例如 1001。');
        return;
      }

      const task = db.getTaskById(editRoomState.taskId);
      if (!task) {
        await ctx.reply('❌ 任务已不存在');
        ctx.session.editRoom = null;
        return;
      }

      try {
        db.updateRoomId(editRoomState.taskId, text);
        const latestTask = db.getTaskById(editRoomState.taskId);
        await scheduler.refreshTask?.(latestTask || task);

        await ctx.reply(
          `✅ 房间号已更新\n\n` +
          `平台：${views.platformLabel(task.platform)}\n` +
          `${task.room_id} → ${text}\n\n` +
          `⚙️ 已自动重启推流任务。`
        );
        ctx.session.editRoom = null;
      } catch (err) {
        await ctx.reply(`❌ 修改失败：${err.message}`);
      }
      return;
    }

    // 处理修改推流地址的输入
    const editRtmpState = ctx.session.editRtmp;
    if (editRtmpState?.step === 'wait_new_url') {
      if (!isValidRelayTargetUrl(text)) {
        await ctx.reply('❌ 推流地址无效，必须以 rtmp:// 或 rtmps:// 开头。');
        return;
      }

      const task = db.getTaskById(editRtmpState.taskId);
      if (!task) {
        await ctx.reply('❌ 任务已不存在');
        ctx.session.editRtmp = null;
        return;
      }

      try {
        db.updatePrimaryTarget(editRtmpState.taskId, text);
        const latestTask = db.getTaskById(editRtmpState.taskId);
        await scheduler.refreshTask?.(latestTask || task);

        await ctx.reply(
          `✅ 推流地址已更新\n\n` +
          `房间：${views.platformLabel(task.platform)} #${task.room_id}\n\n` +
          `新主推流地址：\n\`\`\`\n${text}\n\`\`\`\n\n` +
          `⚙️ 已自动重启推流任务。`
        );
        ctx.session.editRtmp = null;
      } catch (err) {
        await ctx.reply(`❌ 修改失败：${err.message}`);
      }
      return;
    }

    // 处理添加备用源的输入
    const addRtmpState = ctx.session.addRtmp;
    if (addRtmpState?.step === 'wait_rtmp_urls') {
      const urls = parseExtraTargetUrls(text);
      if (urls.length === 0) {
        await ctx.reply('❌ 请输入有效的 RTMP/RTMPS 地址。');
        return;
      }

      const invalidUrls = urls.filter(url => !isValidRelayTargetUrl(url));
      if (invalidUrls.length > 0) {
        await ctx.reply(`❌ 以下地址无效（必须以 rtmp:// 或 rtmps:// 开头）:\n${invalidUrls.join('\n')}`);
        return;
      }

      const task = db.getTaskById(addRtmpState.taskId);
      if (!task) {
        await ctx.reply('❌ 任务已不存在');
        ctx.session.addRtmp = null;
        return;
      }

      try {
        for (const url of urls) {
          db.addTarget(task.id, url);
        }
        await scheduler.tick?.();
        
        const message = [
          '✅ 备用推流地址已添加',
          '',
          `房间：${views.platformLabel(task.platform)} #${task.room_id}`,
          `新增线路：${urls.length} 条`,
          '',
          '📋 全部推流地址：',
        ];
        
        const allUrls = views.getTargetUrls(db.getTaskById(addRtmpState.taskId) || task);
        allUrls.forEach((url, idx) => {
          message.push(`${idx + 1}. ${views.maskTargetUrl(url)}`);
        });
        
        await ctx.reply(message.join('\n'));
        ctx.session.addRtmp = null;
      } catch (err) {
        await ctx.reply(`❌ 添加失败：${err.message}`);
      }
      return;
    }

    await next();
  });

  return bot;
}

// 为 bot 实例添加通知功能
const defaultBot = createRelayBot();

// 存储待发送的通知
defaultBot.pendingNotifications = [];

// 处理来自 StreamManager 的通知
defaultBot.handleManagerNotification = function(notification) {
  const { taskId, type, message } = notification;
  const task = db.getTaskById(taskId);
  if (!task) return;

  // 检查通知开关
  if (!isNotificationEnabled(type)) return;

  // 只在状态变化时发送通知
  const key = `${taskId}-${type}`;
  if (this._lastNotified && this._lastNotified[key] === message) {
    return;
  }

  if (!this._lastNotified) this._lastNotified = {};
  this._lastNotified[key] = message;

  // 组装通知消息
  const label = `${views.platformLabel(task.platform)} #${task.room_id}`;
  let text = '';
  switch (type) {
    case 'live_start':
      text = `🖥️${label}\n💬 ${message}`;
      break;
    case 'offline':
      text = `📌 ${label}\n💬 ${message}`;
      break;
    case 'stream_ended':
      text = `🔴 ${label}\n💬 ${message}`;
      break;
    case 'error':
      text = `⚠️ ${label}\n💬 错误: ${message}`;
      break;
    case 'ffmpeg_error':
      text = `❌ ${label}\n💬 ${message}`;
      break;
    default:
      return;
  }

  // 发送通知
  const chatId = parseAllowedChatId();
  if (!chatId || typeof this.api?.sendMessage !== 'function') return;

  if (type === 'live_start' && notification.imageBuffer) {
    this.api.sendPhoto(chatId, new InputFile(notification.imageBuffer, `live_${task.room_id}.jpg`), {
      caption: text,
    }).catch((err) => {
      console.error('发送开播截图失败，回退文字通知:', err.message);
      this.api.sendMessage(chatId, text).catch(() => {});
    });
  } else {
    this.api.sendMessage(chatId, text).catch((err) => {
      console.error('发送 Telegram 通知失败:', err.message);
    });
  }
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
module.exports.parseExtraTargetUrls = parseExtraTargetUrls;
module.exports.ensureAddRoomState = ensureAddRoomState;
module.exports.resetAddRoomState = resetAddRoomState;
module.exports.saveRoomTask = saveRoomTask;
module.exports.parseLiveRoomInput = parseLiveRoomInput;
