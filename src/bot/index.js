const { Bot, InlineKeyboard, Keyboard, session, InputFile } = require('grammy');
const os = require('os');
const fs = require('fs');
const path = require('path');
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
  // 白名单为空直接拒绝（fail-closed）；正常启动时 main.js 已拒绝空 TG_CHAT_ID，这里是兜底
  if (!allowedChatId || allowedChatId.size === 0) return async (ctx, next) => {};
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
  const nightlyOn = db.getSetting?.('nightly_restart') !== '0';
  const failbackOn = db.getSetting?.('auto_failback') !== '0';
  const keyboard = new InlineKeyboard()
    .text('▶️ 全部开启', 'global_enable_all')
    .text('🛑 全部暂停', 'global_disable_all')
    .row()
    .text('🔄 刷新全部', 'global_refresh_all')
    .text('🧹 清理重启', 'global_clean_restart')
    .row()
    .text(`🎬 画质转码: ${transcodeOn ? '✅ 开启' : '⚪ 关闭'}`, 'global_toggle_transcode').row()
    .text(`🌙 凌晨重启: ${nightlyOn ? '✅ 开' : '⛔ 关'}`, 'global_toggle_nightly')
    .text(`🔀 自动切回主线路: ${failbackOn ? '✅ 开' : '⛔ 关'}`, 'global_toggle_failback').row()
    .text('📩 测试通知', 'global_test_notify')
    .text('📜 查日志', 'global_view_logs').row();
  keyboard.text('☁️ 上传到 Gist', 'global_sync_gist').text('📥 从 Gist 恢复', 'global_restore_gist');
  return keyboard;
}

function buildTaskListKeyboard(tasks) {
  const keyboard = new InlineKeyboard();
  tasks.forEach((task) => {
    const icon = task.status === 'ENABLED' ? '✅' : '🛑';
    keyboard.text(`${icon} ${views.platformLabel(task.platform)} ${task.room_id}`, `manage:${task.id}`).row();
  });
  return keyboard;
}

// 📊 推流状态：先列房间，点进去看详情
function buildStatusListKeyboard(entries) {
  const keyboard = new InlineKeyboard();
  entries.forEach((entry) => {
    const running = entry.traffic?.running;
    const icon = entry.status !== 'ENABLED' ? '🛑' : running ? '🟢' : '⚪';
    const kbps = Math.round(entry.traffic?.bitrateKbps || 0);
    const extra = running && kbps > 0 ? ` · ${kbps}k` : '';
    keyboard.text(`${icon} ${views.platformLabel(entry.platform)} #${entry.room_id}${extra}`, `tstatus:${entry.id}`).row();
  });
  return keyboard;
}

function buildTaskDetailKeyboard(task) {
  const keyboard = new InlineKeyboard()
    .text(task.status === 'ENABLED' ? '🛑 停止监控' : '▶️ 开启监控', `toggle:${task.id}:${task.status}`)
    .row();
  if (task.status === 'ENABLED') {
    keyboard.text('📸 获取截图', `screenshot:${task.id}`).row();
    keyboard.text('📊 本场统计', `stat:${task.id}`).text('🔀 切换线路', `failover:${task.id}`).row();
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

// 告警消息的一键干预按钮：报错时直接在通知上点，不用翻面板
function buildAlertKeyboard(taskId) {
  return new InlineKeyboard()
    .text('🔄 立即重试', `alert_retry:${taskId}`)
    .text('🛑 暂停任务', `alert_pause:${taskId}`)
    .row()
    .text('📸 看画面', `alert_snap:${taskId}`)
    .text('📺 查看详情', `alert_detail:${taskId}`);
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
    output_failed: 'notify_output_failed',
    black_screen: 'notify_black_screen',
    bitrate_drop: 'notify_bitrate_drop',
    failover: 'notify_failover',
    resource: 'notify_resource',
    recover: 'notify_recover',
    session_summary: 'notify_session_summary',
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

  const refreshDashboard = async (ctx) => {
    await safeEditMessageText(ctx, views.renderDashboard({
      system: getSystemInfo(),
      stats: scheduler.getStats(),
      recentErrors: getRecentErrors(),
    }), { parse_mode: 'HTML', reply_markup: buildDashboardKeyboard() });
  };

  // #10：TG 里查日志（最近 20 行，URL 脱敏）
  // 只读文件末尾 64KB：app.log 最大 50MB，整文件 readFileSync 会堵死事件循环导致按钮卡死
  const readLogLines = ({ onlyErrors = false, limit = 20 } = {}) => {
    const logPath = path.join(__dirname, '../../logs/app.log');
    const TAIL_BYTES = 64 * 1024;
    let tail = '';
    let truncated = false;
    try {
      const size = fs.statSync(logPath).size;
      truncated = size > TAIL_BYTES;
      const start = truncated ? size - TAIL_BYTES : 0;
      const len = truncated ? TAIL_BYTES : size;
      const fd = fs.openSync(logPath, 'r');
      try {
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, start);
        tail = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return ['日志文件不存在（可能还没产生日志）'];
    }
    let lines = tail.split('\n').filter((l) => l.trim());
    if (truncated) lines = lines.slice(1); // 丢掉第一行（可能是被截断的半行）
    if (onlyErrors) {
      lines = lines.filter((l) => /error|❌|失败|fail|exception|超时|断开|熔断/i.test(l));
    }
    return lines.slice(-limit).map((l) =>
      // 脱敏：URL（含推流密钥）只留 host
      l.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'`]+)/g, (m) => views.maskTargetUrl(m))
    );
  };

  const showLogs = async (ctx, edit = false) => {
    const onlyErrors = ctx.session.logFilter === 'errors';
    const lines = readLogLines({ onlyErrors });
    const body = lines.length
      ? lines.map((l) => views.escapeHtml(l.length > 300 ? l.slice(0, 300) + '…' : l)).join('\n')
      : '(没有符合条件的日志)';
    let text = `<b>📜 日志</b>（最近 ${lines.length} 行${onlyErrors ? ' · 只看报错' : ''}）\n<code>${body}</code>`;
    if (text.length > 4000) text = text.slice(0, 4000) + '…</code>';
    const kb = new InlineKeyboard()
      .text('🔄 刷新', 'log_refresh')
      .text(onlyErrors ? '📜 看全部' : '⚠️ 只看报错', 'log_filter').row()
      .text('⬅️ 返回面板', 'log_back');
    const opts = { parse_mode: 'HTML', reply_markup: kb };
    if (edit) {
      await safeEditMessageText(ctx, text, opts);
    } else {
      await ctx.reply(text, opts);
    }
  };

  const showTraffic = async (ctx) => {
    if (typeof scheduler.enableAllStats === 'function') {
      scheduler.enableAllStats();
    }
    await ctx.reply(views.renderRoomTraffic(scheduler.getTrafficStats()), { parse_mode: 'HTML', reply_markup: mainKeyboard });
  };

  const showStatus = async (ctx) => {
    // 先刷一遍房间信息，保证封面最新（最多等 3 秒）
    try {
      await Promise.race([
        scheduler.refreshAllRoomInfo(),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    } catch (err) {}

    const stats = scheduler.getTrafficStats();
    if (stats.length === 0) {
      return await ctx.reply('当前还没有配置房间');
    }

    // 有封面的房间：一间一条图文消息，标题紧凑，按钮进详情
    const noCover = [];
    for (const entry of stats) {
      const cover = entry.traffic?.roomInfo?.cover;
      if (!cover) { noCover.push(entry); continue; }

      const running = entry.traffic?.running;
      const kbps = Math.round(entry.traffic?.bitrateKbps || 0);
      const icon = entry.status !== 'ENABLED' ? '🛑' : running ? '🟢' : '⚪';
      const stateLine = entry.status !== 'ENABLED' ? '已暂停'
        : running ? `推流中${kbps > 0 ? ` · ${kbps} kbps` : ''}`
        : '待机 / 等待开播';
      const caption =
        `${icon} <b>${views.escapeHtml(views.platformLabel(entry.platform))} #${views.escapeHtml(entry.room_id)}</b>\n${stateLine}`;
      // 添加时间戳防止 TG 缓存旧封面
      const coverUrl = cover.includes('?')
        ? `${cover}&t=${Date.now()}`
        : `${cover}?t=${Date.now()}`;
      try {
        await ctx.replyWithPhoto(coverUrl, {
          caption,
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text('📺 查看详情', `tstatus:${entry.id}`),
        });
      } catch (err) {
        noCover.push(entry); // 图发不出就进文字列表
      }
    }

    // 没封面的房间：一条文字列表兜底
    if (noCover.length > 0) {
      await ctx.reply(views.renderStatusList(noCover), {
        parse_mode: 'HTML',
        reply_markup: buildStatusListKeyboard(noCover),
      });
    }
  };

  bot.callbackQuery(/^tstatus:(\d+)/, async (ctx) => {
    const task = db.getTaskById(ctx.match[1]);
    if (!task) { await ctx.answerCallbackQuery('房间不存在'); return; }
    await ctx.answerCallbackQuery('正在加载…');
    // 点进详情时刷一下该房间信息，保证封面/标题最新（最多等 3 秒）
    try {
      const manager = scheduler.getTaskManager?.(task);
      if (manager?.refreshRoomInfo) {
        await Promise.race([
          manager.refreshRoomInfo(),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
      }
    } catch (err) { /* 刷新失败就用缓存数据 */ }
    const entry = scheduler.getTrafficStats().find((s) => String(s.id) === ctx.match[1]);
    if (!entry) { await ctx.reply('房间不存在'); return; }
    const statusText = views.renderDetailedStatus([entry]);
    const roomInfo = entry.traffic?.roomInfo || {};
    const backKb = new InlineKeyboard().text('⬅️ 返回房间列表', 'tstatus_back');
    if (roomInfo.cover) {
      // 添加时间戳防止 TG 缓存旧封面
      const coverUrl = roomInfo.cover.includes('?')
        ? `${roomInfo.cover}&t=${Date.now()}`
        : `${roomInfo.cover}?t=${Date.now()}`;
      try {
        await ctx.replyWithPhoto(coverUrl, { caption: statusText, parse_mode: 'HTML', reply_markup: backKb });
        return;
      } catch (err) { /* 封面发送失败就降级为纯文本 */ }
    }
    await ctx.reply(statusText, { parse_mode: 'HTML', reply_markup: backKb });
  });

  bot.callbackQuery('tstatus_back', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showStatus(ctx);
  });

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

  bot.callbackQuery(/^alert_retry:(.+)/, async (ctx) => {
    const task = db.getTaskById(ctx.match[1]);
    if (!task) { await ctx.answerCallbackQuery('任务不存在'); return; }
    await ctx.answerCallbackQuery('正在重试…');
    try { await scheduler.refreshTask?.(task); } catch (err) {
      await ctx.reply(`重试失败: ${err.message}`);
    }
  });

  bot.callbackQuery(/^alert_pause:(.+)/, async (ctx) => {
    const task = db.getTaskById(ctx.match[1]);
    if (!task) { await ctx.answerCallbackQuery('任务不存在'); return; }
    db.updateTaskStatus(task.id, 'DISABLED');
    await scheduler.tick?.();
    await ctx.answerCallbackQuery('已暂停该任务');
  });

  bot.callbackQuery(/^alert_detail:(.+)/, async (ctx) => {
    const task = db.getTaskById(ctx.match[1]);
    if (!task) { await ctx.answerCallbackQuery('任务不存在'); return; }
    await ctx.answerCallbackQuery();
    await ctx.reply(views.renderTaskDetail(task, scheduler.isTaskRunning(task)), {
      parse_mode: 'HTML',
      reply_markup: buildTaskDetailKeyboard(task),
    });
  });

  bot.callbackQuery(/^alert_snap:(.+)/, async (ctx) => {
    const task = db.getTaskById(ctx.match[1]);
    if (!task) { await ctx.answerCallbackQuery('任务不存在'); return; }
    const manager = scheduler.getTaskManager?.(task);
    if (!manager) { await ctx.answerCallbackQuery({ text: '任务当前没在推流，截不到画面', show_alert: true }); return; }
    await ctx.answerCallbackQuery('正在截图…');
    try {
      const imageBuffer = await manager.captureSnapshot();
      await ctx.replyWithPhoto(
        new InputFile(imageBuffer, `alert_${task.room_id}.jpg`),
        { caption: `📸 ${views.platformLabel(task.platform)} #${task.room_id} 当前画面` }
      );
    } catch (err) {
      await ctx.reply(`截图失败: ${err.message || '未知错误'}`);
    }
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

  // #14：凌晨自动重启开关
  bot.callbackQuery('global_toggle_nightly', async (ctx) => {
    const newValue = db.getSetting('nightly_restart') === '0' ? '1' : '0';
    db.setSetting('nightly_restart', newValue);
    await ctx.answerCallbackQuery(newValue === '1' ? '✅ 凌晨自动重启已开启（每天 4 点）' : '⛔ 凌晨自动重启已关闭');
    await refreshDashboard(ctx);
  });

  // #11：故障自动切回主线路开关
  bot.callbackQuery('global_toggle_failback', async (ctx) => {
    const newValue = db.getSetting('auto_failback') === '0' ? '1' : '0';
    db.setSetting('auto_failback', newValue);
    await ctx.answerCallbackQuery(newValue === '1' ? '✅ 已开启：主线路恢复后自动切回' : '⛔ 已关闭：只手动切换');
    await refreshDashboard(ctx);
  });

  // #6：测试通知通道
  bot.callbackQuery('global_test_notify', async (ctx) => {
    await ctx.answerCallbackQuery('已发送测试通知');
    const now = new Date().toLocaleString('zh-CN', { hour12: false });
    await ctx.reply(`📩 <b>测试通知</b>\nTG 通知通道正常 ✅\n🕐 ${now}`, { parse_mode: 'HTML' });
  });

  // #10：查日志
  bot.callbackQuery('global_view_logs', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showLogs(ctx);
  });

  bot.callbackQuery('log_refresh', async (ctx) => {
    await ctx.answerCallbackQuery('已刷新');
    await showLogs(ctx, true);
  });

  bot.callbackQuery('log_filter', async (ctx) => {
    ctx.session.logFilter = ctx.session.logFilter === 'errors' ? 'all' : 'errors';
    await ctx.answerCallbackQuery(ctx.session.logFilter === 'errors' ? '只看报错' : '查看全部');
    await showLogs(ctx, true);
  });

  bot.callbackQuery('log_back', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showDashboard(ctx);
  });

  roomHandlers.register(bot, sharedDeps);
  rtmpHandlers.register(bot, sharedDeps);

  return bot;
}

const defaultBot = createRelayBot();
defaultBot.pendingNotifications = [];

defaultBot.handleManagerNotification = function(notification) {
  const { taskId, type, message } = notification;
  const task = taskId ? db.getTaskById(taskId) : null;
  if (taskId && !task) return;
  if (!isNotificationEnabled(type)) return;

  // 告警去重：
  // - error / ffmpeg_error / 监控告警类：同任务同类型 10 分钟内只发一次
  //   （之前按整条消息原文比对，ffmpeg 报错里带变化的 stderr 从未命中，等于没去重）
  // - 状态变化类（开播/下播/结束）：沿用整条消息比对，避免漏掉真实的状态翻转
  const alertTypes = ['error', 'ffmpeg_error', 'output_failed', 'black_screen', 'bitrate_drop', 'failover', 'resource'];
  const key = `${taskId || 'global'}-${type}`;
  if (alertTypes.includes(type)) {
    const now = Date.now();
    if (!this._lastNotifiedAt) this._lastNotifiedAt = {};
    if (now - (this._lastNotifiedAt[key] || 0) < 10 * 60 * 1000) return;
    this._lastNotifiedAt[key] = now;
  } else {
    if (this._lastNotified?.[key] === message) return;
    if (!this._lastNotified) this._lastNotified = {};
    this._lastNotified[key] = message;
  }

  const label = task ? `${views.platformLabel(task.platform)} #${task.room_id}` : '系统';
  const friendly = (type === 'error' || type === 'ffmpeg_error') ? views.humanizeError(message) : message;
  let text = '';
  switch (type) {
    case 'live_start':    text = `🖥️${label}\n💬 ${message}`; break;
    case 'offline':       text = `📌 ${label}\n💬 ${message}`; break;
    case 'stream_ended':  text = `🔴 ${label}\n💬 ${message}`; break;
    case 'error':         text = `⚠️ ${label}\n💬 ${friendly}`; break;
    case 'ffmpeg_error':  text = `❌ ${label}\n💬 ${friendly}`; break;
    case 'output_failed': text = `🔌 ${label}\n💬 ${message}`; break;
    case 'black_screen':  text = `⬛ ${label}\n💬 ${message}`; break;
    case 'bitrate_drop':  text = `📉 ${label}\n💬 ${message}`; break;
    case 'failover':      text = `🔀 ${label}\n💬 ${message}`; break;
    case 'resource':      text = `💾 ${label}\n💬 ${message}`; break;
    case 'recover':       text = `✅ ${label}\n💬 ${message}`; break;
    case 'session_summary': text = message; break; // 本场小结自带 HTML 排版
    default: return;
  }

  const chatIds = parseAllowedChatId();
  if (!chatIds || !chatIds.size || typeof this.api?.sendMessage !== 'function') return;

  // 报错类通知带一键干预按钮：立即重试 / 暂停任务 / 查看详情
  const alertKeyboard = (type === 'error' || type === 'ffmpeg_error') ? buildAlertKeyboard(taskId) : undefined;
  // 本场小结自带 HTML 排版，其他类型保持纯文本（报错原文可能含尖括号，转 HTML 会炸）
  const useHtml = type === 'session_summary';

  const sendToAll = async () => {
    for (const chatId of chatIds) {
      try {
        if (type === 'live_start' && notification.imageBuffer) {
          await this.api.sendPhoto(chatId, new InputFile(notification.imageBuffer, `live_${task.room_id}.jpg`), { caption: text });
        } else if (type === 'live_start' && notification.coverUrl) {
          // #5：截图失败时用房间封面兜底，实在发不出再降级纯文字
          try {
            await this.api.sendPhoto(chatId, notification.coverUrl, { caption: text });
          } catch {
            await this.api.sendMessage(chatId, text);
          }
        } else {
          await this.api.sendMessage(chatId, text, {
            ...(useHtml ? { parse_mode: 'HTML' } : {}),
            ...(alertKeyboard ? { reply_markup: alertKeyboard } : {}),
          });
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
module.exports.buildAlertKeyboard = buildAlertKeyboard;
module.exports.registerBotCommands = registerBotCommands;
module.exports.saveRoomTask = roomHandlers.saveRoomTask;

