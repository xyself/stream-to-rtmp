const { Bot, InlineKeyboard, Keyboard, session, InputFile } = require('grammy');
const os = require('node:os');
const fs = require('node:fs');
const db = require('../db');
const scheduler = require('../core/scheduler');
const logger = require('../core/logger');
const views = require('./views');
const { parseAllowedChatId, resetAllSessions } = require('./utils/parser');
const roomHandlers = require('./handlers/room');
const rtmpHandlers = require('./handlers/rtmp');
const gistSync = require('../db/gist-sync');
const http = require('../platforms/http');
const widgetHelper = require('./widget');
const ffmpegInstaller = require('../services/ffmpeg-installer');
const fallbackImage = require('../services/fallback-image');
const housekeeping = require('../core/housekeeping');
const runtimeEnv = require('../core/runtime-env');
const updater = require('../services/updater');
const curveChart = require('../core/curve-chart');
const {
  safeEditMessageText,
  safeEditMessageMedia,
  sendEphemeralMessage,
  sendEphemeralPhoto,
} = require('./ephemeral');

let shutdownHandler = null;
function setShutdownHandler(fn) {
  shutdownHandler = fn;
}

function getFfmpegMeta(forceRefresh = false) {
  const info = ffmpegInstaller.getFfmpegRuntimeInfo({ forceRefresh });
  return {
    binPath: info.binPath,
    resolvedPath: info.resolvedPath,
    version: info.ok ? info.version : '未知',
    source: info.sourceLabel,
    isCustomBinary: info.isCustomBinary,
  };
}

function createChatGuard(allowedChatId = parseAllowedChatId()) {
  // 白名单为空直接拒绝（fail-closed）；正常启动时 main.js 已拒绝空 TG_CHAT_ID，这里是兜底
  if (!allowedChatId || allowedChatId.size === 0) return async (ctx, next) => {};
  return async (ctx, next) => {
    const widgetQuery = ctx?.update?.widget_query;
    const chatId = ctx?.chat?.id ?? widgetQuery?.chat?.id ?? widgetQuery?.from?.id;
    if (!allowedChatId.has(String(chatId))) {
      if (ctx?.callbackQuery) {
        await ctx.answerCallbackQuery().catch(() => {});
      }
      if (widgetQuery?.id) {
        await ctx.api.raw.answerWidgetQuery({ widget_query_id: widgetQuery.id, data: '未授权访问' }).catch(() => {});
      }
      if (ctx?.chat?.id) {
        await ctx.api.leaveChat(ctx.chat.id).catch(() => {});
      }
      return;
    }
    await next();
  };
}

function buildMainKeyboard() {
  return new Keyboard()
    .text('📊 推流状态').text('📈 推流曲线').text('📺 管理面板')
    .row()
    .text('🏠 房间管理').text('➕ 添加房间').text('📷 快捷截图')
    .row()
    .text('📜 实时日志').text('💾 备份恢复').text('⚙️ 通知与参数')
    .resized()
    .persistent();
}

function buildDashboardKeyboard() {
  const transcodeOn = db.getSetting?.('transcode_video') === '1';
  const audioFixOn = db.getSetting?.('transcode_audio') === '1';
  const nightlyOn = db.getSetting?.('daily_restart') !== '0' && db.getSetting?.('nightly_restart') !== '0';
  const failbackOn = db.getSetting?.('auto_failback') !== '0';
  const liveSnapshotOn = db.getSetting?.('live_snapshot') === '1';
  const fallbackOn = db.getSetting?.('fallback_image') === '1';
  const autoBackupOn = db.getSetting?.('auto_tg_backup') !== '0';
  const hour = db.getSetting?.('daily_restart_hour') || db.getSetting?.('nightly_restart_hour') || '10';
  const isFreeBsdOrServ00 = process.platform === 'freebsd' || Boolean(process.env.SERV00);

  const keyboard = new InlineKeyboard()
    .text('▶️ 全部开启', 'global_enable_all')
    .text('🛑 全部暂停', 'global_disable_all')
    .row()
    .text('🔄 刷新全部', 'global_refresh_all')
    .text('🧹 清理重启', 'global_clean_restart')
    .row()
    .text(`🎬 画质转码: ${transcodeOn ? '✅ 开启' : '⚪ 关闭'}`, 'global_toggle_transcode')
    .text(`🔊 音频修复: ${audioFixOn ? '✅ 开启' : '⚪ 关闭'}`, 'global_toggle_audio_fix')
    .row()
    .text(`📷 开播截图: ${liveSnapshotOn ? '✅ 开启' : '⚪ 省内存'}`, 'global_toggle_live_snapshot')
    .text(`🖼️ 断流保底图: ${fallbackOn ? '✅ 开' : '⚪ 关'}`, 'global_toggle_fallback')
    .row()
    .text(`💾 自动TG备份: ${autoBackupOn ? '✅ 开' : '⚪ 关'}`, 'global_toggle_auto_backup')
    .text(`🔀 自动切回主线: ${failbackOn ? '✅ 开' : '⛔ 关'}`, 'global_toggle_failback')
    .row()
    .text(`🔄 每日维护: ${nightlyOn ? `✅ ${hour}点` : '⛔ 关'}`, 'global_toggle_nightly')
    .text(`⏰ 维护时间: ${hour}:00`, 'global_set_restart_hour')
    .row()
    .text('📈 推流曲线', 'open_curve_menu')
    .text('📜 查日志', 'global_view_logs')
    .text('🛠️ FFmpeg 参数', 'global_ffmpeg_params')
    .row()
    .text('📤 导出备份文件', 'global_export_backup')
    .text('📥 导入备份文件', 'global_import_backup')
    .text('📩 测试通知', 'global_test_notify')
    .row()
    .text('☁️ 上传到 Gist', 'global_sync_gist')
    .text('📥 从 Gist 恢复', 'global_restore_gist')
    .text(isFreeBsdOrServ00 ? 'ℹ️ FFmpeg 说明' : '⬆️ 升级FFmpeg', isFreeBsdOrServ00 ? 'global_ffmpeg_info' : 'global_update_ffmpeg')
    .row()
    .text('🚀 检查更新与重启', 'global_check_update');
  return keyboard;
}

function buildTaskListKeyboard(tasks = [], filter = 'all') {
  const keyboard = new InlineKeyboard();
  if (!tasks || tasks.length === 0) {
    keyboard
      .text('➕ 立即添加房间', 'quick_add_room')
      .text('🔄 刷新', 'back_list');
    return keyboard;
  }

  const activeFilter = ['all', 'live', 'idle', 'paused'].includes(filter) ? filter : 'all';
  const liveCount = tasks.filter((t) => t.status === 'ENABLED' && Boolean(t.traffic?.running)).length;
  const idleCount = tasks.filter((t) => t.status === 'ENABLED' && !t.traffic?.running).length;
  const pausedCount = tasks.filter((t) => t.status !== 'ENABLED').length;

  keyboard
    .text(`${activeFilter === 'all' ? '✓' : ''}全部(${tasks.length})`, 'rooms_filter:all')
    .text(`${activeFilter === 'live' ? '✓' : ''}🟢${liveCount}`, 'rooms_filter:live')
    .text(`${activeFilter === 'idle' ? '✓' : ''}⚪${idleCount}`, 'rooms_filter:idle')
    .text(`${activeFilter === 'paused' ? '✓' : ''}🛑${pausedCount}`, 'rooms_filter:paused')
    .row();

  const filtered = views.filterTasksByState ? views.filterTasksByState(tasks, activeFilter) : tasks;
  const sorted = views.sortTasksByActivity ? views.sortTasksByActivity(filtered) : filtered;
  sorted.forEach((task) => {
    const running = task.traffic?.running;
    const icon = task.status !== 'ENABLED' ? '🛑' : running ? '🟢' : '⚪';
    const host = task.traffic?.roomInfo?.hostName ? ` (${task.traffic.roomInfo.hostName})` : '';
    const kbps = Math.round(task.traffic?.bitrateKbps || 0);
    const rateTag = running && kbps > 0 ? ` · ${kbps}k` : '';
    const cookieBadge = task.cookie ? ' 🍪' : '';
    keyboard.text(`${icon} ${views.platformLabel(task.platform)} #${task.room_id}${host}${rateTag}${cookieBadge}`, `manage:${task.id}`).row();
  });

  keyboard
    .text('➕ 添加房间', 'quick_add_room')
    .text('📷 截推流画面', 'quick_snap_live')
    .row()
    .text('🎛️ 实时卡片', 'open_widget')
    .text('🔄 刷新', `rooms_filter:${activeFilter}`);
  return keyboard;
}

// 📊 推流状态：先列房间，点进去看详情
function buildStatusListKeyboard(entries = []) {
  const keyboard = new InlineKeyboard();
  if (!entries || entries.length === 0) {
    keyboard
      .text('➕ 立即添加房间', 'quick_add_room')
      .text('🔄 刷新总览', 'tstatus_back');
    return keyboard;
  }

  const sorted = views.sortTasksByActivity ? views.sortTasksByActivity(entries) : entries;
  sorted.forEach((entry) => {
    const running = entry.traffic?.running;
    const icon = entry.status !== 'ENABLED' ? '🛑' : running ? '🟢' : '⚪';
    const kbps = Math.round(entry.traffic?.bitrateKbps || 0);
    const host = entry.traffic?.roomInfo?.hostName ? ` (${entry.traffic.roomInfo.hostName})` : '';
    const extra = running && kbps > 0 ? ` · ${kbps}k` : '';
    keyboard.text(`${icon} ${views.platformLabel(entry.platform)} #${entry.room_id}${host}${extra}`, `tstatus:${entry.id}`).row();
  });
  keyboard
    .text('📷 截推流画面', 'quick_snap_live')
    .text('📈 推流曲线', 'open_curve_menu')
    .text('🔄 刷新', 'tstatus_back');
  return keyboard;
}

function buildTaskDetailKeyboard(task) {
  const hasCookie = Boolean(task.cookie && String(task.cookie).trim());
  const modeMap = {
    default: '⚙️跟随',
    copy: '⚡直推',
    audio_fix: '🔊修音',
    transcode: '🎬转码',
  };
  const modeShort = modeMap[task.transcode_mode || 'default'] || '⚙️跟随';

  const keyboard = new InlineKeyboard()
    .text(task.status === 'ENABLED' ? '🛑 停止监控' : '▶️ 开启监控', `toggle:${task.id}:${task.status}`)
    .text('🔄 刷新', `refresh:${task.id}`)
    .row();
  if (task.status === 'ENABLED') {
    keyboard
      .text('📸 获取截图', `screenshot:${task.id}`)
      .text('📊 本场统计', `stat:${task.id}`)
      .text('🔀 切换线路', `failover:${task.id}`)
      .row();
  }
  keyboard
    .text('📈 推流曲线', `curve:${task.id}:1h`)
    .text('🩺 诊断测试', `diagnose:${task.id}`)
    .text(`🎬 编码:${modeShort}`, `transcode_mode:${task.id}`)
    .row()
    .text('✏️ 房间号', `editroom:${task.id}`)
    .text('✏️ 改主地址', `editrtmp:${task.id}`)
    .text(hasCookie ? '🍪 Cookie ✅' : '🍪 房间Cookie', `editcookie:${task.id}`)
    .row()
    .text('➕ 添加地址', `addrtmp_ui:${task.id}`)
    .text('➖ 删除地址', `delurl_ui:${task.id}`)
    .row()
    .text('🗑️ 删除任务', `del_confirm:${task.id}`)
    .text('⬅️ 返回列表', 'back_list');
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

function getSystemInfo(opts = {}) {
  const memStats = opts.memStats || housekeeping.getMemoryStats();
  const cpuPercent = opts.cpuPercent != null ? opts.cpuPercent : housekeeping.getSystemCpuPct();
  const diskStats = opts.diskStats !== undefined ? opts.diskStats : housekeeping.getDiskStats();
  const runtime = opts.runtime || runtimeEnv.getRuntimeProfile();

  const memUsage = process.memoryUsage();
  const serviceMem = memUsage.rss;
  const heapUsed = memUsage.heapUsed;

  let dbSize = null;
  try {
    const stat = fs.statSync(db.resolveDatabasePath());
    dbSize = views.formatBytes(stat.size);
  } catch {}

  const ffMeta = opts.ffMeta || getFfmpegMeta();

  let memLabel = '物理内存';
  if (memStats.source === 'serv00') {
    memLabel = 'Serv00 配额 512MB';
  } else if (memStats.source && memStats.source.startsWith('cgroup')) {
    memLabel = '容器配额';
  }

  let diskLabel = '磁盘';
  if (diskStats?.source === 'serv00') {
    diskLabel = 'Serv00 配额 3.0GB';
  }

  let runtimeLabel = 'Linux';
  if (runtime.isServ00) {
    runtimeLabel = 'Serv00 FreeBSD';
  } else if (runtime.isFreeBSD) {
    runtimeLabel = 'FreeBSD';
  } else if (runtime.isContainer) {
    runtimeLabel = runtime.isMusl ? 'Docker Alpine (musl)' : 'Docker Linux';
  }

  return {
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    cpuBar: views.progressBar(cpuPercent),
    cpuLabel: memStats.source === 'serv00' ? 'Serv00 配额' : null,
    memUsed: views.formatBytes(memStats.usedMB * 1024 * 1024),
    memTotal: views.formatBytes(memStats.limitMB * 1024 * 1024),
    memPct: memStats.sysUsePct,
    memLabel,
    memSource: memStats.source,
    disk: diskStats ? {
      used: views.formatBytes(diskStats.usedMB * 1024 * 1024),
      total: views.formatBytes(diskStats.limitMB * 1024 * 1024),
      pct: diskStats.usePct,
      label: diskLabel,
    } : null,
    processes: memStats.processes ? {
      used: memStats.processes.used,
      limit: memStats.processes.limit,
      pct: memStats.processes.usePct,
    } : null,
    serviceMem: views.formatBytes(serviceMem),
    heapUsed: views.formatBytes(heapUsed),
    uptime: views.formatUptime(process.uptime()),
    dbSize,
    runtimeLabel,
    nodeVersion: process.version,
    gitSha: opts.gitSha !== undefined ? opts.gitSha : updater.getCurrentVersion().sha,
    ffmpegVersion: ffMeta.version,
    ffmpegPath: ffMeta.resolvedPath,
    ffmpegSource: ffMeta.source,
    ffmpegCustomBinary: ffMeta.isCustomBinary,
    transcodeVideo: db.getSetting?.('transcode_video') === '1',
    transcodeAudio: db.getSetting?.('transcode_audio') === '1',
  };
}

function getRecentErrors() {
  const nonErrors = new Set(['STREAM_ENDED', 'OFFLINE', 'NORMAL_EXIT', 'NO_STREAM']);
  return db.getAllTasks()
    .filter((t) => t.last_error && !nonErrors.has(t.last_error))
    .map((t) => `[${views.platformLabel(t.platform)} #${t.room_id}] ${t.last_error}`);
}

/**
 * 安全构建 Telegram HTML 日志块：先按字符预算逐行装填再闭合 <code>，
 * 绝不在 HTML 转义后做裸 slice，防止把 &amp;/&lt;/&gt; 切碎导致 400 can't parse entities。
 */
function formatLogsHtml(lines = [], { onlyErrors = false, maxLen = 4000 } = {}) {
  const safeLines = Array.isArray(lines) ? lines : [];
  const header = `<b>📜 日志</b>（最近 ${safeLines.length} 行${onlyErrors ? ' · 只看报错' : ''}）\n`;
  if (safeLines.length === 0) {
    return `${header}<code>(没有符合条件的日志)</code>`;
  }

  const wrapperLen = header.length + '<code>'.length + '</code>'.length;
  const budget = Math.max(64, maxLen - wrapperLen);
  const kept = [];
  let used = 0;

  // 从最新日志往前装填，确保超出预算时优先保留最近日志且不截断实体
  for (let i = safeLines.length - 1; i >= 0; i -= 1) {
    const raw = String(safeLines[i] ?? '');
    const clippedRaw = raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;
    let escaped = views.escapeHtml(clippedRaw);
    const sep = kept.length > 0 ? 1 : 0;

    if (used + sep + escaped.length <= budget) {
      kept.push(escaped);
      used += sep + escaped.length;
    } else if (kept.length === 0) {
      // 单条日志就超预算：按原始字符二分缩短后再转义，避免切碎 HTML 实体
      let lo = 0;
      let hi = clippedRaw.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const candidate = `${views.escapeHtml(clippedRaw.slice(0, mid))}…`;
        if (candidate.length <= budget) lo = mid;
        else hi = mid - 1;
      }
      kept.push(`${views.escapeHtml(clippedRaw.slice(0, lo))}…`);
      break;
    } else {
      break;
    }
  }

  kept.reverse();
  return `${header}<code>${kept.join('\n')}</code>`;
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

  const commands = [
    { command: 'start',    description: '🚀 打开控制中心与底部键盘' },
    { command: 'status',   description: '📊 推流状态 & 房间详情' },
    { command: 'curve',    description: '📈 分房间分钟级推流码率曲线图' },
    { command: 'traffic',  description: '📡 实时流量 & 码率统计' },
    { command: 'widget',   description: '🎛️ 实时监控 Widget（Bot API 10.4）' },
    { command: 'rooms',    description: '🏠 房间列表管理（Cookie/编码/线路）' },
    { command: 'addroom',  description: '➕ 添加房间（支持贴链接或一行创建）' },
    { command: 'addrtmp',  description: '🔗 为房间追加 RTMP 推流线路' },
    { command: 'snap',     description: '📷 快捷截取直播间实时画面' },
    { command: 'diagnose', description: '🔍 房间拉流与推流链路诊断' },
    { command: 'cookie',   description: '🍪 为指定房间绑定独立 Cookie' },
    { command: 'panel',    description: '📺 全局控制台（开关/重启/备份）' },
    { command: 'fallback', description: '🖼️ 断流保底图开关与自定义图片' },
    { command: 'startall', description: '▶️ 一键开启全部房间推流' },
    { command: 'stopall',  description: '🛑 一键暂停全部房间推流' },
    { command: 'restart',  description: '🧹 清理异常进程并重启全部推流' },
    { command: 'logs',     description: '📜 查看最近运行日志' },
    { command: 'sys',      description: '🖥️ 服务器 CPU/内存/磁盘/FFmpeg 状态' },
    { command: 'backup',   description: '💾 导出 JSON 备份文件' },
    { command: 'gist',     description: '☁️ Gist 云端同步与恢复' },
    { command: 'notify',   description: '🔔 通知推送开关设置' },
    { command: 'ffmpeg',   description: '🛠️ 查看 FFmpeg 推流参数' },
    { command: 'update',   description: '🚀 检查更新并远程重启' },
    { command: 'cancel',   description: '❎ 取消当前输入会话' },
    { command: 'help',     description: '❓ 快捷操作与命令速查' },
  ];

  // 私聊命令列表（完整）
  await bot.api.setMyCommands(commands, { scope: { type: 'all_private_chats' } });
  // 默认兜底（老客户端）
  await bot.api.setMyCommands(commands);
}

function createRelayBot(token = process.env.TG_TOKEN) {
  if (!token || !String(token).trim()) {
    return {
      isConfigured: false,
      isRunning: () => false,
      start: async () => {},
      stop: async () => {},
      catch: () => {},
      api: null,
      _widgetMessages: {},
    };
  }
  const clientOpts = { timeoutSeconds: 60 };
  if (process.env.TG_API_ENV === 'test') {
    clientOpts.environment = 'test';
  }
  const bot = new Bot(token, { client: clientOpts });
  bot.isConfigured = true;
  const mainKeyboard = buildMainKeyboard();
  const ephemeralReply = (ctx, text, options = {}) => sendEphemeralMessage(bot, ctx, text, options);
  const ephemeralPhoto = (ctx, photo, options = {}) => sendEphemeralPhoto(bot, ctx, photo, options);

  const sendWidgetToChat = async (ctx) => {
    const system = getSystemInfo();
    const tasks = scheduler.getTrafficStats();
    const chatData = widgetHelper.buildChatData({ tasks, system });
    const caption = widgetHelper.buildCaption({ tasks, system });
    const fallbackDashboard = () => views.renderDashboard({
      system,
      stats: scheduler.getStats(),
      recentErrors: getRecentErrors(),
    });

    if (ctx.chat?.type && ctx.chat.type !== 'private') {
      await ctx.reply(
        '⚠️ Telegram Bot API 10.4 目前仅支持在机器人私聊中使用实时卡片 Widget（群组/频道暂不支持）\n\n' +
        fallbackDashboard(),
        { parse_mode: 'HTML', reply_markup: buildDashboardKeyboard() }
      );
      return;
    }

    try {
      const sent = await widgetHelper.sendWidget(bot, ctx.chat.id, chatData, { caption });
      const msgId = sent?.message_id ?? sent?.result?.message_id;
      if (msgId) {
        bot._widgetMessages = bot._widgetMessages || {};
        bot._widgetMessages[String(ctx.chat.id)] = msgId;
      }
    } catch (err) {
      const errMsg = err?.description || err?.message || '未知错误';
      console.error('[widget] sendWidget 失败:', errMsg);
      const isNotAllowed = /INPUT_MEDIA_WIDGET_NOT_ALLOWED/i.test(errMsg);
      const isMethodMissing = /unknown method|method not found|not supported|404/i.test(errMsg);
      const header = isNotAllowed
        ? `⚠️ Telegram 正式环境暂未对当前 Bot 开放 Widget 权限（<code>${views.escapeHtml(errMsg)}</code>），需等待官方分批放行，或使用 Telegram Test Server（<code>TG_API_ENV=test</code>）测试`
        : isMethodMissing
          ? `⚠️ 当前 Bot API 环境或客户端不支持 Widget（${views.escapeHtml(errMsg)}）`
          : `❌ Widget 发送失败：<code>${views.escapeHtml(errMsg)}</code>`;
      await ctx.reply(
        `${header}\n\n${views.renderRoomList(tasks)}`,
        { parse_mode: 'HTML', reply_markup: buildTaskListKeyboard(tasks) }
      );
    }
  };

  const sharedDeps = {
    safeEditMessageText,
    safeEditMessageMedia,
    ephemeralReply,
    ephemeralPhoto,
    sendWidgetToChat,
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

  // #10：TG 里查日志（优先从内存环形缓冲读取，无重定向文件时也能正常查询，且自动 URL 脱敏）
  const showLogs = async (ctx, edit = false) => {
    const onlyErrors = ctx.session.logFilter === 'errors';
    const lines = logger.queryLines({ onlyErrors, limit: 20 });
    const text = formatLogsHtml(lines, { onlyErrors });
    const kb = new InlineKeyboard()
      .text('🔄 刷新', 'log_refresh')
      .text(onlyErrors ? '📜 看全部' : '⚠️ 只看报错', 'log_filter').row()
      .text('⬅️ 返回面板', 'log_back');
    const opts = { parse_mode: 'HTML', reply_markup: kb };
    if (edit === true) {
      await safeEditMessageText(ctx, text, opts);
    } else {
      await ephemeralReply(ctx, text, opts);
    }
  };

  const showTraffic = async (ctx) => {
    await ctx.reply(views.renderRoomTraffic(scheduler.getTrafficStats()), { parse_mode: 'HTML', reply_markup: mainKeyboard });
  };

  const showStatus = async (ctx, edit = false) => {
    try {
      await Promise.race([
        Promise.resolve(scheduler.refreshAllRoomInfo?.()).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    } catch {}

    const stats = scheduler.getTrafficStats();
    const text = views.renderStatusList(stats);
    const opts = {
      parse_mode: 'HTML',
      reply_markup: buildStatusListKeyboard(stats),
    };
    if (edit === true) {
      await safeEditMessageText(ctx, text, opts);
    } else {
      await ctx.reply(text, opts);
    }
  };

  bot.use(createChatGuard());
  bot.use(session({ initial: () => ({ addRoom: { step: null, roomId: null, platform: null } }) }));

  bot.callbackQuery(/^tstatus:(\d+)/, async (ctx) => {
    const task = db.getTaskById(ctx.match[1]);
    if (!task) { await ctx.answerCallbackQuery('房间不存在'); return; }
    await ctx.answerCallbackQuery('正在加载…');
    try {
      const manager = scheduler.getTaskManager?.(task);
      if (manager?.refreshRoomInfo) {
        await Promise.race([
          manager.refreshRoomInfo(),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
      }
    } catch {}
    const entry = scheduler.getTrafficStats().find((s) => String(s.id) === ctx.match[1]);
    if (!entry) { await ctx.reply('房间不存在'); return; }
    const statusText = views.renderDetailedStatus([entry]);
    const roomInfo = entry.traffic?.roomInfo || {};
    const detailKb = new InlineKeyboard()
      .text('⚙️ 进入房间控制台', `manage:${entry.id}`)
      .text('📸 实时截图', `screenshot:${entry.id}`)
      .row()
      .text('⬅️ 返回状态总览', 'tstatus_back');
    if (roomInfo.cover) {
      const coverUrl = roomInfo.cover.includes('?')
        ? `${roomInfo.cover}&t=${Date.now()}`
        : `${roomInfo.cover}?t=${Date.now()}`;
      try {
        await ephemeralPhoto(ctx, coverUrl, { caption: statusText, parse_mode: 'HTML', reply_markup: detailKb });
        return;
      } catch {}
    }
    await ephemeralReply(ctx, statusText, { parse_mode: 'HTML', reply_markup: detailKb });
  });

  bot.callbackQuery('tstatus_back', async (ctx) => {
    await ctx.answerCallbackQuery('已刷新');
    await showStatus(ctx, true);
  });

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
  bot.command('status', async (ctx) => { await showStatus(ctx, false); });
  bot.command('notify', showNotificationSettings);
  bot.command('traffic', showTraffic);
  bot.command('logs', async (ctx) => { await showLogs(ctx); });

  // ─── Bot API 10.4 Widget ───────────────────────────────────────────────────
  // /widget 命令：发送 Widget；仅在真正不支持或报错时降级到原生房间卡片并展示真实错误原因
  bot.command('widget', sendWidgetToChat);

  // widget_query：用户在 Widget 里点了按钮
  // grammy 1.42 类型白名单不含 widget_query，ctx.chat 为 undefined，需从 query.chat / query.from 提取
  bot.use(async (ctx, next) => {
    if (!ctx.update?.widget_query) return next();
    const query = ctx.update.widget_query;
    const queryId = query.id;
    const chatId = query.chat?.id ?? query.from?.id;
    const messageId = query.message_id;
    if (chatId && messageId) {
      bot._widgetMessages = bot._widgetMessages || {};
      bot._widgetMessages[String(chatId)] = messageId;
    }

    let parsed = {};
    try { parsed = JSON.parse(query.data || '{}'); } catch {}

    const { i: taskId, a: action } = parsed;

    if (action === 'ref') {
      await widgetHelper.answerWidgetQuery(bot, queryId, '🔄 已刷新').catch(() => {});
      await _pushWidgetUpdate(chatId, messageId).catch(() => {});
    } else if (action === 'tog') {
      // 切换任务开启/暂停
      const task = taskId ? db.getTaskById(String(taskId)) : null;
      if (!task) {
        await widgetHelper.answerWidgetQuery(bot, queryId, '任务不存在').catch(() => {});
        return;
      }
      const newStatus = task.status === 'ENABLED' ? 'DISABLED' : 'ENABLED';
      db.updateTaskStatus(task.id, newStatus);
      await scheduler.tick?.();
      await widgetHelper.answerWidgetQuery(
        bot,
        queryId,
        newStatus === 'ENABLED'
          ? `▶ 已开启 ${views.platformLabel(task.platform)} #${task.room_id}`
          : `■ 已停止 ${views.platformLabel(task.platform)} #${task.room_id}`
      ).catch(() => {});
      // 推送更新后的 chat_data
      await _pushWidgetUpdate(chatId, messageId).catch(() => {});
    } else if (action === 'cur') {
      // 生成该房间的 1 小时深色高清推流曲线图
      const hydrated = taskId ? roomHandlers.getHydratedTaskWithTraffic(String(taskId)) : null;
      if (!hydrated) {
        await widgetHelper.answerWidgetQuery(bot, queryId, '房间不存在').catch(() => {});
        return;
      }
      await widgetHelper.answerWidgetQuery(bot, queryId, '📈 正在生成 1小时 推流曲线...').catch(() => {});
      if (chatId) {
        try {
          const windowInfo = curveChart.getCurveWindow('1h');
          let samples = db.getBitrateSamples(hydrated.id, windowInfo.startMs, windowInfo.endMs);
          const liveKbps = hydrated.traffic?.running && hydrated.traffic?.bitrateKbps > 0
            ? Math.round(hydrated.traffic.bitrateKbps)
            : 0;
          if (liveKbps > 0) {
            const now = Date.now();
            if (now >= windowInfo.startMs && now <= windowInfo.endMs) {
              samples = [...samples, { task_id: hydrated.id, ts: now, kbps: liveKbps }];
            }
          }
          const chart = curveChart.renderWaveChartPng({
            samples,
            mode: windowInfo.mode,
            title: `${curveChart.platformAsciiTag(hydrated.platform)} #${hydrated.room_id}`,
            currentKbps: liveKbps || null,
          });
          const unicodeWave = curveChart.renderUnicodeWave(samples, windowInfo.startMs, windowInfo.endMs);
          const caption = views.renderWaveChartCaption({
            task: hydrated,
            windowInfo,
            sessions: chart.sessions,
            unicodeWave,
            avgKbps: chart.avgKbps,
            peakKbps: chart.peakKbps,
            currentKbps: liveKbps,
          });
          const allTasks = scheduler.getTrafficStats?.() || db.getAllTasks();
          const kb = roomHandlers.buildCurveKeyboard(String(hydrated.id), windowInfo.mode, allTasks);
          await ephemeralPhoto(
            null,
            new InputFile(chart.pngBuffer, `curve_${hydrated.room_id}_1h.png`),
            {
              chatId,
              receiverUserId: query.from?.id,
              caption,
              parse_mode: 'HTML',
              reply_markup: kb,
            }
          );
        } catch (err) {
          await bot.api.sendMessage(chatId, `❌ 生成曲线失败: ${err.message}`).catch(() => {});
        }
      }
    } else if (action === 'snap') {
      // 截图
      const task = taskId ? db.getTaskById(String(taskId)) : null;
      if (!task) {
        await widgetHelper.answerWidgetQuery(bot, queryId, '任务不存在').catch(() => {});
        return;
      }
      const manager = scheduler.getTaskManager?.(task);
      if (!manager || !manager.getTrafficStats?.().running) {
        await widgetHelper.answerWidgetQuery(bot, queryId, '当前未推流，无法截图').catch(() => {});
        return;
      }
      await widgetHelper.answerWidgetQuery(bot, queryId, '📷 正在截图...').catch(() => {});
      if (chatId) {
        try {
          const imageBuffer = await manager.captureSnapshot();
          await ephemeralPhoto(
            null,
            new InputFile(imageBuffer, `snap_${task.room_id}.jpg`),
            {
              chatId,
              receiverUserId: query.from?.id,
              caption: `📸 ${views.platformLabel(task.platform)} #${task.room_id} 当前画面`,
            }
          );
        } catch (err) {
          await bot.api.sendMessage(chatId, `截图失败: ${err.message}`).catch(() => {});
        }
      }
    } else {
      await widgetHelper.answerWidgetQuery(bot, queryId, '').catch(() => {});
    }
  }); // end bot.use widget_query

  const showFfmpegParams = async (ctx) => {
    const stats = scheduler.getTrafficStats();
    await ephemeralReply(ctx, views.renderFfmpegParams(stats), { parse_mode: 'HTML' });
  };

  const renderFallbackPanel = () => {
    const enabled = db.getSetting?.('fallback_image') === '1';
    const info = fallbackImage.getFallbackImageInfo();
    const sizeKb = info.sizeBytes > 0 ? `${(info.sizeBytes / 1024).toFixed(1)} KB` : '自动生成';
    const text =
      `🖼️ <b>轻量断流保底图设置</b>\n\n` +
      `当前状态：<b>${enabled ? '✅ 已开启' : '⚪ 已关闭'}</b>\n` +
      `当前图片：<b>${info.isCustom ? '自定义图片' : '内置深灰极简图'}</b>（${sizeKb}）\n` +
      `判定策略：断流后先顶保底图，每 15s 复核平台状态并尝试重拉真流；连续 3 次显示未开播判定为真下播，最长保底 3 分钟自动熔断。\n\n` +
      `<i>💡 点击下方「上传自定义图片」后直接发送一张图片即可替换保底画面。</i>`;
    const kb = new InlineKeyboard()
      .text(enabled ? '⚪ 关闭断流保底图' : '✅ 开启断流保底图', 'fallback_toggle')
      .row()
      .text('📤 上传自定义图片', 'fallback_upload')
      .text('♻️ 恢复默认图', 'fallback_reset')
      .row()
      .text('⬅️ 返回管理面板', 'log_back');
    return { text, kb };
  };

  const showFallbackPanel = async (ctx, edit = false) => {
    const { text, kb } = renderFallbackPanel();
    const opts = { parse_mode: 'HTML', reply_markup: kb };
    if (edit === true) {
      await safeEditMessageText(ctx, text, opts);
    } else {
      await ctx.reply(text, opts);
    }
  };

  const showSystemStatus = async (ctx) => {
    const sys = getSystemInfo();
    const stats = scheduler.getStats();
    const diskText = sys.disk ? `${sys.disk.used} / ${sys.disk.total} (${sys.disk.pct}%)` : '暂不可用';
    const text =
      `🖥️ <b>服务器与运行环境状态</b>\n\n` +
      `• 运行模式：<code>${views.escapeHtml(sys.runtimeLabel || 'Standard')}</code>\n` +
      `• 系统 CPU：<b>${sys.cpuPercent ?? 0}%</b>（${os.cpus().length || 1} 核）\n` +
      `• 内存占用：<b>${views.escapeHtml(`${sys.memUsed} / ${sys.memTotal} (${sys.memPct ?? 0}%)`)}</b>\n` +
      `• 磁盘占用：<b>${views.escapeHtml(diskText)}</b>\n` +
      `• 运行时长：<b>${views.escapeHtml(sys.uptime || '-')}</b>\n` +
      `• 代码版本：<code>${views.escapeHtml(sys.gitSha || '未知')}</code>\n` +
      `• FFmpeg：<code>${views.escapeHtml(sys.ffmpegVersion || 'unknown')}</code>\n` +
      `• 活跃推流：<b>${stats.activeStreams || 0}</b> / ${stats.totalTasks || 0} 房间`;
    await ephemeralReply(ctx, text, { parse_mode: 'HTML' });
  };

  const showBackupMenu = async (ctx) => {
    const kb = new InlineKeyboard()
      .text('📤 导出 JSON 备份', 'global_export_backup')
      .text('📥 导入备份说明', 'global_import_backup')
      .row()
      .text('☁️ 上传到 Gist', 'global_sync_gist')
      .text('📥 从 Gist 恢复', 'global_restore_gist');
    await ctx.reply(
      `💾 <b>备份与云端同步</b>\n\n` +
      `• 可一键导出完整 <code>.json</code> 配置（含房间、多路 RTMP、独立 Cookie 与全局设置）\n` +
      `• 恢复时直接把 <code>.json</code> 文件发送或转发回本窗口即可自动热重载`,
      { parse_mode: 'HTML', reply_markup: kb }
    );
  };

  const showSettingsHub = async (ctx) => {
    const fallbackOn = db.getSetting?.('fallback_image') === '1';
    const kb = new InlineKeyboard()
      .text('🔔 通知开关设置', 'settings_notify')
      .text('🛠️ FFmpeg 参数', 'settings_ffmpeg')
      .row()
      .text(`🖼️ 断流保底图 (${fallbackOn ? '开' : '关'})`, 'settings_fallback')
      .text('🖥️ 服务器状态', 'settings_sys')
      .row()
      .text('🎛️ 实时 Widget', 'settings_widget')
      .text('📺 打开全局面板', 'log_back');
    await ctx.reply(
      `⚙️ <b>通知与系统参数</b>\n请选择要查看或调整的配置项：`,
      { parse_mode: 'HTML', reply_markup: kb }
    );
  };

  const showHelp = async (ctx) => {
    const text =
      `❓ <b>StreamOps 快捷用法速查</b>\n\n` +
      `1. <b>裸丢链接一键建房</b>：直接把 B站/斗鱼/抖音直播间链接（支持 <code>b23.tv</code> / <code>v.douyin.com</code> 短链）发给 Bot，点确认即可建房。\n` +
      `2. <b>一行极速建房（支持并发多推）</b>：\n` +
      `   <code>https://live.bilibili.com/1000 rtmp://主线 rtmp://第二路</code>\n` +
      `3. <b>一键还原配置</b>：直接把导出的 <code>.json</code> 备份文件发回本窗口。\n` +
      `4. <b>自定义断流保底图</b>：发送 <code>/fallback</code> 开启并上传任意图片。\n` +
      `5. <b>随时退出输入态</b>：发送 <code>/cancel</code> 清空当前会话。\n\n` +
      `常用快捷命令：<code>/status</code> · <code>/curve</code> · <code>/snap</code> · <code>/diagnose</code> · <code>/startall</code> · <code>/stopall</code> · <code>/restart</code> · <code>/sys</code> · <code>/gist</code>`;
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: mainKeyboard });
  };

  bot.hears('📺 管理面板', showDashboard);
  bot.hears('📊 推流状态', async (ctx) => { await showStatus(ctx, false); });
  bot.hears('🛠️ FFmpeg 参数', showFfmpegParams);
  bot.hears('🔔 通知管理', showNotificationSettings);
  bot.hears('📜 实时日志', async (ctx) => { await showLogs(ctx); });
  bot.hears('💾 备份恢复', showBackupMenu);
  bot.hears('⚙️ 通知与参数', showSettingsHub);

  bot.command('ffmpeg', showFfmpegParams);
  bot.command('fallback', async (ctx) => { await showFallbackPanel(ctx, false); });
  bot.command('sys', showSystemStatus);
  bot.command('gist', showBackupMenu);
  bot.command('help', showHelp);
  bot.command('cancel', async (ctx) => {
    resetAllSessions(ctx.session);
    await ctx.reply('❎ 已取消当前输入操作并重置会话。', { reply_markup: mainKeyboard });
  });
  bot.command('startall', async (ctx) => {
    db.enableAllTasks();
    if (scheduler._stopped) {
      scheduler.start();
    } else {
      await scheduler.tick();
    }
    await ctx.reply('▶️ 已一键开启全部房间监控与推流任务。', { reply_markup: mainKeyboard });
  });
  bot.command('stopall', async (ctx) => {
    db.disableAllTasks();
    await scheduler.tick();
    await ctx.reply('🛑 已一键暂停全部房间推流任务。', { reply_markup: mainKeyboard });
  });
  bot.command('restart', async (ctx) => {
    await ctx.reply('🧹 正在清理异常 FFmpeg 进程并重启全部推流...');
    await scheduler.stopAll();
    scheduler.start();
    await ctx.reply('✅ 全部推流任务已重启完成。', { reply_markup: mainKeyboard });
  });

  bot.callbackQuery('settings_notify', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showNotificationSettings(ctx);
  });
  bot.callbackQuery('settings_ffmpeg', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showFfmpegParams(ctx);
  });
  bot.callbackQuery('settings_fallback', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showFallbackPanel(ctx, true);
  });
  bot.callbackQuery('settings_sys', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showSystemStatus(ctx);
  });
  bot.callbackQuery('settings_widget', async (ctx) => {
    await ctx.answerCallbackQuery('正在打开实时面板...');
    await sendWidgetToChat(ctx);
  });

  bot.callbackQuery('global_toggle_fallback', async (ctx) => {
    const newValue = db.getSetting('fallback_image') === '1' ? '0' : '1';
    db.setSetting('fallback_image', newValue);
    await ctx.answerCallbackQuery(newValue === '1' ? '✅ 已开启轻量断流保底图' : '⚪ 已关闭断流保底图');
    await refreshDashboard(ctx);
  });

  bot.callbackQuery('fallback_toggle', async (ctx) => {
    const newValue = db.getSetting('fallback_image') === '1' ? '0' : '1';
    db.setSetting('fallback_image', newValue);
    await ctx.answerCallbackQuery(newValue === '1' ? '✅ 已开启轻量断流保底图' : '⚪ 已关闭断流保底图');
    await showFallbackPanel(ctx, true);
  });

  bot.callbackQuery('fallback_upload', async (ctx) => {
    ctx.session.waitFallbackPhoto = { startedAt: Date.now() };
    await ctx.answerCallbackQuery('请发送一张图片');
    await ctx.reply(
      `📤 <b>上传自定义断流保底图</b>\n\n` +
      `请直接向本窗口发送一张图片（推荐 16:9 横图，如 1280×720）。\n` +
      `<i>输入 /cancel 可取消上传。</i>`,
      { parse_mode: 'HTML' }
    );
  });

  bot.callbackQuery('fallback_reset', async (ctx) => {
    fallbackImage.clearCustomFallbackImage();
    await ctx.answerCallbackQuery('♻️ 已恢复默认极简保底图');
    await showFallbackPanel(ctx, true);
  });

  bot.on('message:photo', async (ctx, next) => {
    if (!ctx.session.waitFallbackPhoto) {
      await next();
      return;
    }
    const photos = ctx.message?.photo;
    if (!Array.isArray(photos) || photos.length === 0) {
      await ctx.reply('❌ 未识别到图片，请重新发送一张图片或发送 /cancel 取消。');
      return;
    }
    try {
      const largest = photos[photos.length - 1];
      const fileInfo = await ctx.api.getFile(largest.file_id);
      if (!fileInfo?.file_path) {
        throw new Error('无法获取 Telegram 图片下载路径');
      }
      const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
      const res = await http.get(fileUrl, { responseType: 'arraybuffer', timeout: 20000 });
      const buf = Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data);
      fallbackImage.saveCustomFallbackImage(buf);
      ctx.session.waitFallbackPhoto = null;
      await ctx.reply(
        `✅ <b>自定义断流保底图已保存！</b>（${(buf.length / 1024).toFixed(1)} KB）\n` +
        `下次触发断流保底时将自动使用这张图片。`,
        { parse_mode: 'HTML', reply_markup: renderFallbackPanel().kb }
      );
    } catch (err) {
      await ctx.reply(`❌ 保存保底图失败：${err.message}`);
    }
  });


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
    try {
      await scheduler.refreshTask?.(task);
      await ephemeralReply(ctx, `✅ 已触发重试：${views.platformLabel(task.platform)} #${task.room_id}`);
    } catch (err) {
      await ephemeralReply(ctx, `❌ 重试失败: ${err.message}`);
    }
  });

  bot.callbackQuery(/^alert_pause:(.+)/, async (ctx) => {
    const task = db.getTaskById(ctx.match[1]);
    if (!task) { await ctx.answerCallbackQuery('任务不存在'); return; }
    db.updateTaskStatus(task.id, 'DISABLED');
    await scheduler.tick?.();
    await ctx.answerCallbackQuery('已暂停该任务');
    await ephemeralReply(ctx, `⏸️ 已暂停：${views.platformLabel(task.platform)} #${task.room_id}`);
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
    if (!manager || !manager.getTrafficStats?.().running) {
      await ctx.answerCallbackQuery({ text: '任务当前没在推流，截不到画面', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery('正在截图…');
    try {
      const imageBuffer = await manager.captureSnapshot();
      await ephemeralPhoto(
        ctx,
        new InputFile(imageBuffer, `alert_${task.room_id}.jpg`),
        { caption: `📸 ${views.platformLabel(task.platform)} #${task.room_id} 当前画面` }
      );
    } catch (err) {
      await ephemeralReply(ctx, `截图失败: ${err.message || '未知错误'}`);
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
    // 先停掉所有推流+调度器，再用 start() 重建：stopAll() 会把 _stopped 置 true 并清掉定时器，
    // 直接调 tick() 的话启动循环第一行就 return，推流永远拉不起来（2026-09-28 修）。
    // start() 会清掉 _stopped、重建 30 秒定时器、走 90 秒静默期后逐个错峰拉起。
    await scheduler.stopAll();
    scheduler.start();
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
    await ephemeralReply(ctx, ok ? '☁️ 已成功同步到 Gist' : '❌ 同步失败，请检查日志');
  });

  bot.callbackQuery('global_restore_gist', async (ctx) => {
    if (!gistSync.isConfigured()) {
      await ctx.answerCallbackQuery({ text: '⚠️ 未配置 GIST_TOKEN / GIST_ID', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery('⏳ 正在从 Gist 恢复...');
    const ok = await gistSync.downloadDefault();
    if (ok) {
      await scheduler.stopAll();
      scheduler.start();
    }
    await safeEditMessageText(
      ctx,
      views.renderDashboard({ system: getSystemInfo(), stats: scheduler.getStats(), recentErrors: getRecentErrors() }),
      { parse_mode: 'HTML', reply_markup: buildDashboardKeyboard() }
    );
    await ephemeralReply(ctx, ok ? '📥 已从 Gist 恢复，任务已重启' : '❌ 恢复失败，请检查日志');
  });

  bot.callbackQuery('global_toggle_transcode', async (ctx) => {
    const newValue = db.getSetting('transcode_video') === '1' ? '0' : '1';
    db.setSetting('transcode_video', newValue);
    await ctx.answerCallbackQuery(`${newValue === '1' ? '✅ 视频转码已开启' : '⚪ 视频转码已关闭'}（重启任务后生效）`);
    await safeEditMessageText(ctx, views.renderDashboard({ system: getSystemInfo(), stats: scheduler.getStats(), recentErrors: getRecentErrors() }), { parse_mode: 'HTML', reply_markup: buildDashboardKeyboard() });
  });

  // #2：全局音频重编码修复（-c:v copy -c:a aac -b:a 128k -ar 48000 -ac 2）
  bot.callbackQuery('global_toggle_audio_fix', async (ctx) => {
    const newValue = db.getSetting('transcode_audio') === '1' ? '0' : '1';
    db.setSetting('transcode_audio', newValue);
    await ctx.answerCallbackQuery(
      newValue === '1'
        ? '✅ 已开启音频修复：视频保持 Copy，音频标准化为 AAC 48kHz 双声道'
        : '⚪ 已关闭全局音频修复（恢复双流 Copy）'
    );
    await refreshDashboard(ctx);
  });

  // #6：配置变更时自动向 Telegram 聊天窗推送 .json 备份文件
  bot.callbackQuery('global_toggle_auto_backup', async (ctx) => {
    const newValue = db.getSetting('auto_tg_backup') === '0' ? '1' : '0';
    db.setSetting('auto_tg_backup', newValue);
    await ctx.answerCallbackQuery(
      newValue === '1'
        ? '✅ 已开启：增删改房间后自动推送备份文件到聊天窗'
        : '⚪ 已关闭自动推送备份（仍可随时点「📤 导出备份文件」）'
    );
    await refreshDashboard(ctx);
  });

  // #14：每日定时维护重启开关（默认早上10点，推流中自动顺延1小时）
  bot.callbackQuery('global_toggle_nightly', async (ctx) => {
    const isCurrentlyOn = db.getSetting('daily_restart') !== '0' && db.getSetting('nightly_restart') !== '0';
    const newValue = isCurrentlyOn ? '0' : '1';
    db.setSetting('daily_restart', newValue);
    db.setSetting('nightly_restart', newValue);
    const hour = db.getSetting('daily_restart_hour') || db.getSetting('nightly_restart_hour') || '10';
    await ctx.answerCallbackQuery(newValue === '1' ? `✅ 每日自动维护已开启（每天 ${hour} 点，推流中自动顺延 1 小时）` : '⛔ 每日自动维护已关闭');
    await refreshDashboard(ctx);
  });

  // 维护时间选择器（一键切换每日维护小时）
  bot.callbackQuery('global_set_restart_hour', async (ctx) => {
    await ctx.answerCallbackQuery();
    const currentHour = String(db.getSetting('daily_restart_hour') || db.getSetting('nightly_restart_hour') || '10');
    const hours = ['4', '6', '8', '10', '12', '14', '16', '22'];
    const kb = new InlineKeyboard();
    hours.forEach((h, idx) => {
      const label = h === currentHour ? `✅ ${h}:00` : `${h}:00`;
      kb.text(label, `restart_hour:${h}`);
      if ((idx + 1) % 4 === 0) kb.row();
    });
    kb.text('⬅️ 返回面板', 'log_back');
    await safeEditMessageText(
      ctx,
      `<b>⏰ 设置每日自动维护重启时间</b>\n\n当前设置：<b>每天 ${currentHour}:00</b>（若该时刻正在推流，将自动顺延 1 小时再检查）\n\n请点击下方时间切换：`,
      { parse_mode: 'HTML', reply_markup: kb }
    );
  });

  bot.callbackQuery(/^restart_hour:(\d+)$/, async (ctx) => {
    const hour = ctx.match[1];
    db.setSetting('daily_restart_hour', hour);
    db.setSetting('nightly_restart_hour', hour);
    await ctx.answerCallbackQuery(`✅ 已将每日维护时间设为 ${hour}:00`);
    await refreshDashboard(ctx);
  });

  // ─── Telegram 聊天室一键导出/导入 JSON 备份文件 ──────────────────────────
  const exportBackupToChat = async (ctx) => {
    const rooms = gistSync.exportRooms(db);
    const settings = db.getAllSettings?.() || {};
    const snapshot = {
      version: 2,
      exportedAt: new Date().toISOString(),
      rooms,
      settings,
    };
    const jsonContent = JSON.stringify(snapshot, null, 2);
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `streamops-backup-${dateStr}.json`;
    const cookieRooms = rooms.filter((r) => r.cookie).length;
    const totalTargets = rooms.reduce((sum, r) => sum + (r.targets?.length || 0), 0);

    await ctx.replyWithDocument(
      new InputFile(Buffer.from(jsonContent, 'utf8'), filename),
      {
        caption:
          `📦 <b>StreamOps 全量配置备份</b>\n\n` +
          `🏠 房间数量：<b>${rooms.length}</b> 个（含独立Cookie房间 ${cookieRooms} 个）\n` +
          `📤 推流线路：<b>${totalTargets}</b> 条\n` +
          `⚙️ 全局设置：<b>${Object.keys(settings).length}</b> 项\n\n` +
          `<i>💡 恢复方法：随时将此 .json 文件直接发送或转发回本聊天窗口，即可一键还原全部房间与推流配置！</i>`,
        parse_mode: 'HTML',
      }
    );
  };

  bot.command('backup', exportBackupToChat);

  bot.callbackQuery('global_export_backup', async (ctx) => {
    await ctx.answerCallbackQuery('正在生成备份文件...');
    try {
      await exportBackupToChat(ctx);
    } catch (err) {
      await ctx.reply(`❌ 导出备份失败：${err.message}`);
    }
  });

  bot.callbackQuery('global_import_backup', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `📥 <b>导入 JSON 备份文件</b>\n\n` +
      `请直接向本窗口发送或转发之前导出的 <code>.json</code> 备份文件（支持 <code>streamops-backup-*.json</code> 或 Gist 的 <code>rooms.json</code>）：\n\n` +
      `<i>💡 发送文件后系统将自动校验并热重载所有房间、主备 RTMP 密钥、房间独立 Cookie 与全局设置。</i>`,
      { parse_mode: 'HTML' }
    );
  });

  // 监听用户直接发送/转发到聊天窗的 .json 备份文件，自动完成一键导入还原
  bot.on('message:document', async (ctx) => {
    const doc = ctx.message?.document;
    if (!doc) return;
    const fileName = String(doc.file_name || '').toLowerCase();
    const mimeType = String(doc.mime_type || '').toLowerCase();
    if (!fileName.endsWith('.json') && !mimeType.includes('json')) {
      await ctx.reply('❌ 仅支持导入 <code>.json</code> 格式的备份文件。', { parse_mode: 'HTML' });
      return;
    }
    if (doc.file_size && doc.file_size > 2 * 1024 * 1024) {
      await ctx.reply('❌ 备份文件体积过大（超过 2MB），已拒绝导入。');
      return;
    }

    try {
      const fileInfo = await ctx.getFile();
      if (!fileInfo?.file_path) {
        throw new Error('无法获取 Telegram 文件下载路径');
      }
      const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
      const res = await http.get(fileUrl, { responseType: 'text' });
      const rawText = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      const parsed = JSON.parse(rawText);

      const isValidArray = Array.isArray(parsed);
      const isValidObj = parsed && typeof parsed === 'object' && (Array.isArray(parsed.rooms) || typeof parsed.settings === 'object');
      if (!isValidArray && !isValidObj) {
        throw new Error('JSON 结构无效：缺少 rooms 数组或 settings 配置');
      }

      await scheduler.stopAll();
      const result = gistSync.importRoomsIntoDb(db.getDatabase(), parsed);
      db.onWrite?.();
      scheduler.start();

      await ctx.reply(
        `✅ <b>备份文件导入成功！</b>\n\n` +
        `📄 文件名：<code>${views.escapeHtml(doc.file_name || 'backup.json')}</code>\n` +
        `🏠 恢复房间：<b>${result.importedRooms}</b> 个\n` +
        `📤 恢复线路：<b>${result.importedTargets}</b> 条\n` +
        `⚙️ 恢复设置：<b>${result.importedSettings}</b> 项\n\n` +
        `🚀 调度器已自动热重载所有启用中的监控任务。`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      await ctx.reply(`❌ 导入备份失败：${err.message}`);
    }
  });

  // 快捷命令 /cookie [房间号] [Cookie内容]：支持按房间号直接设置独立 Cookie（B站/斗鱼/抖音通用）
  bot.command('cookie', async (ctx) => {
    const raw = String(ctx.message?.text || '').replace(/^\/cookie\s*/i, '').trim();
    const tasks = db.getAllTasks();
    if (!raw) {
      if (tasks.length === 0) {
        await ctx.reply('当前还没有已创建的房间。请先「➕ 添加房间」，然后在「🏠 房间管理」中点击对应房间设置独立 Cookie。');
        return;
      }
      const kb = new InlineKeyboard();
      tasks.forEach((t) => {
        const badge = t.cookie ? '✅ 已配Cookie' : '⚪ 未配置';
        kb.text(`${views.platformLabel(t.platform)} #${t.room_id} (${badge})`, `editcookie:${t.id}`).row();
      });
      await ctx.reply(
        `🍪 <b>房间独立 Cookie 管理</b>\n\n` +
        `点击下方房间即可单独设置或清除该房间的 Cookie（B站不同房间可绑定不同账号 Cookie 解锁原画/防风控，抖音/斗鱼同理）。\n\n` +
        `也可以直接发送指令：\n<code>/cookie 房间号 你的Cookie字符串</code>`,
        { parse_mode: 'HTML', reply_markup: kb }
      );
      return;
    }

    // 解析 /cookie 房间号 Cookie内容
    const firstSpace = raw.indexOf(' ');
    if (firstSpace > 0) {
      const candidateRoomId = raw.slice(0, firstSpace).trim();
      const cookieValue = raw.slice(firstSpace + 1).trim();
      const targetTask = tasks.find((t) => String(t.room_id) === candidateRoomId);
      if (targetTask && cookieValue) {
        db.updateTaskCookie(targetTask.id, cookieValue);
        const latestTask = db.getTaskById(targetTask.id);
        await scheduler.refreshTask?.(latestTask || targetTask);
        await ctx.reply(
          `✅ 已为 <b>${views.escapeHtml(views.platformLabel(targetTask.platform))} #${views.escapeHtml(targetTask.room_id)}</b> 绑定独立 Cookie：\n<code>${views.escapeHtml(cookieValue)}</code>\n\n⚙️ 已自动重启该房间监控任务。`,
          { parse_mode: 'HTML' }
        );
        return;
      }
    }

    // 兜底：若直接传了整段 Cookie 且未指定房间号，存入默认 douyin_cookie
    db.setSetting('douyin_cookie', raw);
    ctx.session.setCookie = null;
    await ctx.reply(
      `✅ 已更新全局默认抖音 Cookie：\n<code>${views.escapeHtml(raw)}</code>\n\n<i>💡 提示：如需为特定 B站/斗鱼/抖音房间单独绑定 Cookie，请进入「🏠 房间管理」→ 点击房间 → 点击「🍪 房间Cookie」。</i>`,
      { parse_mode: 'HTML' }
    );
  });

  // #11：故障自动切回主线路开关
  bot.callbackQuery('global_toggle_failback', async (ctx) => {
    const newValue = db.getSetting('auto_failback') === '0' ? '1' : '0';
    db.setSetting('auto_failback', newValue);
    await ctx.answerCallbackQuery(newValue === '1' ? '✅ 已开启：主线路恢复后自动切回' : '⛔ 已关闭：只手动切换');
    await refreshDashboard(ctx);
  });

  // 内存优化：开播实况截图开关（关则直接复用房间封面，零内存开销）
  bot.callbackQuery('global_toggle_live_snapshot', async (ctx) => {
    const newValue = db.getSetting('live_snapshot') === '1' ? '0' : '1';
    db.setSetting('live_snapshot', newValue);
    await ctx.answerCallbackQuery(newValue === '1' ? '✅ 已开启：开播时执行 FFmpeg 实况截图' : '⚪ 已关闭：开播时优先使用房间封面（节省内存）');
    await refreshDashboard(ctx);
  });

  // #6：测试通知通道
  bot.callbackQuery('global_test_notify', async (ctx) => {
    await ctx.answerCallbackQuery('已发送测试通知');
    const now = new Date().toLocaleString('zh-CN', { hour12: false });
    await ephemeralReply(ctx, `📩 <b>测试通知</b>\nTG 通知通道正常 ✅\n🕐 ${now}`, { parse_mode: 'HTML' });
  });

  // #10：查日志
  bot.callbackQuery('global_view_logs', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showLogs(ctx);
  });

  // 查看 FFmpeg 参数（面板按钮触发，支持临时消息展示）
  bot.callbackQuery('global_ffmpeg_params', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showFfmpegParams(ctx);
  });

  // FreeBSD / Serv00 原生编译版说明
  bot.callbackQuery('global_ffmpeg_info', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ephemeralReply(
      ctx,
      `ℹ️ <b>FreeBSD / Serv00 原生 FFmpeg 说明</b>\n\n` +
      `当前系统运行在 FreeBSD 环境下，使用系统预装的原生动态链接版本 <code>/usr/local/bin/ffmpeg</code> (6.1.2)。\n\n` +
      `💡 <b>为什么无需也不能升级为网络静态包？</b>\n` +
      `1. 网络上的静态包均为 Linux glibc 二进制，无法直接在 FreeBSD 内核执行；\n` +
      `2. stream-to-rtmp 默认采用原生音视频流直推 (<code>-c copy</code>)，FFmpeg 6.1.2 极其稳定且 CPU 占用近乎为零，是 Serv00 环境下的最优解。`,
      { parse_mode: 'HTML' }
    );
  });

  // 一键下载并切换至最新静态版 FFmpeg (./bin/ffmpeg)，无需填 .env
  bot.callbackQuery('global_update_ffmpeg', async (ctx) => {
    if (process.platform === 'freebsd' || Boolean(process.env.SERV00)) {
      await ctx.answerCallbackQuery();
      await ephemeralReply(
        ctx,
        `ℹ️ <b>FreeBSD / Serv00 原生 FFmpeg 说明</b>\n\n` +
        `当前为 FreeBSD/Serv00 环境，系统预装的 <code>/usr/local/bin/ffmpeg</code> (6.1.2) 为原生动态链接版本，采用 <code>-c copy</code> 极稳零损耗，无需且无法使用 Linux glibc 静态包。`,
        { parse_mode: 'HTML' }
      );
      return;
    }
    await ctx.answerCallbackQuery('⬇️ 正在后台下载最新静态版 FFmpeg，请稍候...');
    try {
      const res = await ffmpegInstaller.downloadLatestFfmpeg({ logger: console });
      getFfmpegMeta(true);
      await refreshDashboard(ctx);
      await ephemeralReply(
        ctx,
        `✅ <b>FFmpeg 已升级到最新静态版！</b>\n\n` +
        `🎬 当前版本：<code>${views.escapeHtml(res.version)}</code>\n` +
        `📦 来源：<code>${views.escapeHtml(res.source)}</code>\n` +
        `📍 路径：<code>${views.escapeHtml(res.binPath)}</code>\n\n` +
        `<i>💡 .env 中的 FFMPEG_PATH 保持留空即可，系统已自动优先调用此内置最新版（新开播或点击「🧹 清理重启」后全面生效）。</i>`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      await ephemeralReply(ctx, `❌ 自动升级 FFmpeg 失败：${views.escapeHtml(err.message)}`, { parse_mode: 'HTML' });
    }
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
    await refreshDashboard(ctx);
  });

  // ─── 远程一键检查更新与重启 ───────────────────────────────────────────────
  const handleCheckUpdate = async (ctx, isCallback = false) => {
    if (isCallback) {
      await ctx.answerCallbackQuery('⏳ 正在检查 GitHub 远程版本...').catch(() => {});
    }
    const res = await updater.checkUpdate();
    if (!res.ok) {
      const errText = `❌ <b>检查更新失败</b>\n\n${views.escapeHtml(res.error || '未知错误')}`;
      if (isCallback) {
        await ephemeralReply(ctx, errText, { parse_mode: 'HTML' });
      } else {
        await ctx.reply(errText, { parse_mode: 'HTML' });
      }
      return;
    }

    const modeTag = '免 Git 压缩包模式';
    if (!res.hasUpdate) {
      const tip = `✅ <b>当前已是最新版本！</b>\n\n版本：<code>${views.escapeHtml(res.localSha)}</code>（${modeTag}）\n暂无可用更新。`;
      if (isCallback) {
        await ephemeralReply(ctx, tip, { parse_mode: 'HTML' });
      } else {
        await ctx.reply(tip, { parse_mode: 'HTML' });
      }
      return;
    }

    const lines = [
      `🚀 <b>发现新版本！</b>（${modeTag}）`,
      '',
      `📌 当前版本：<code>${views.escapeHtml(res.localSha)}</code>`,
      `🌟 最新版本：<code>${views.escapeHtml(res.remoteSha)}</code>（落后 ${res.commitsBehind} 个提交）`,
      '',
      `📝 <b>更新内容：</b>`,
      ...res.commitLogs.map((log) => `• ${views.escapeHtml(log)}`),
      '',
    ];
    if (res.hasPackageJsonChange) {
      lines.push('📦 <i>检测到依赖项更新，拉取后将自动增量安装依赖。</i>');
      lines.push('');
    }
    lines.push('⚠️ <i>更新过程预计耗时 3~5 秒，期间如有正在推流的直播将短暂重连。是否继续？</i>');

    const kb = new InlineKeyboard()
      .text('🚀 确认更新并重启', 'global_do_update')
      .text('❌ 取消', 'global_cancel_update');

    if (isCallback) {
      await safeEditMessageText(ctx, lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb });
    } else {
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb });
    }
  };

  bot.command('update', async (ctx) => {
    await handleCheckUpdate(ctx, false);
  });

  bot.callbackQuery('global_check_update', async (ctx) => {
    await handleCheckUpdate(ctx, true);
  });

  bot.callbackQuery('global_cancel_update', async (ctx) => {
    await ctx.answerCallbackQuery('已取消更新').catch(() => {});
    await refreshDashboard(ctx);
  });

  bot.callbackQuery('global_do_update', async (ctx) => {
    await ctx.answerCallbackQuery('⏳ 开始执行远程更新...').catch(() => {});
    await safeEditMessageText(ctx, '⏳ <b>正在拉取最新代码并校验语法...</b>\n\n服务将在 3~5 秒内自动重启拉起，请稍候。', { parse_mode: 'HTML' });
    try {
      const notifyChatId = ctx.chat?.id;
      await updater.applyUpdate({
        notifyChatId,
        onProgress: (msg) => logger.log(`[updater] ${msg}`),
      });
      // 触发退出码 100 优雅重启
      if (typeof shutdownHandler === 'function') {
        shutdownHandler(100);
      } else {
        setTimeout(() => process.exit(100), 1000).unref();
      }
    } catch (err) {
      await safeEditMessageText(ctx, `❌ <b>更新失败并已回滚</b>\n\n${views.escapeHtml(err.message)}`, { parse_mode: 'HTML' });
    }
  });

  roomHandlers.register(bot, sharedDeps);
  rtmpHandlers.register(bot, sharedDeps);

  // ─── Widget 定时推送辅助 ───────────────────────────────────────────────────
  // 供 widget_query handler 和外部定时器调用：向已打开的 Widget 推送最新数据
  async function _pushWidgetUpdate(chatId, overrideMsgId = null) {
    if (!chatId) return;
    const msgId = overrideMsgId || bot._widgetMessages?.[String(chatId)];
    if (!msgId) return;
    const system = getSystemInfo();
    const tasks = scheduler.getTrafficStats();
    const chatData = widgetHelper.buildChatData({ tasks, system });
    try {
      await widgetHelper.editWidgetData(bot, chatId, msgId, chatData);
    } catch (err) {
      // message_id 失效（消息已删除 / 会话不存在）→ 清理记录；"message is not modified" 已在 editWidgetData 内忽略
      if (/message.*not found|message to edit not found|chat not found/i.test(err?.message || '')) {
        delete bot._widgetMessages[String(chatId)];
      }
    }
  }
  // 暴露给外部（如 housekeeping 定时器）
  bot._pushWidgetUpdate = _pushWidgetUpdate;
  bot._widgetMessages = {};
  bot.setShutdownHandler = setShutdownHandler;

  return bot;
}

const defaultBot = createRelayBot();

defaultBot.handleManagerNotification = function(notification) {
  const { taskId, type, message, force = false } = notification;
  const task = taskId ? db.getTaskById(taskId) : null;
  if (taskId && !task) return;
  if (!force && !isNotificationEnabled(type)) return;

  // 告警去重与状态翻转追踪：
  // - error / ffmpeg_error / 监控告警类：同任务同类型 10 分钟内只发一次（带 force: true 的熔断告警绝不吞掉）
  // - 生命周期状态翻转类（live_start / offline / stream_ended）：按任务追踪当前状态，
  //   状态翻转时立刻放行（一天开播多次、标题不变也能次次收到开播与下播通知），仅屏蔽连续重复状态
  const alertTypes = ['error', 'ffmpeg_error', 'output_failed', 'black_screen', 'bitrate_drop', 'failover', 'resource'];
  const lifecycleTypes = ['live_start', 'offline', 'stream_ended'];
  const key = `${taskId || 'global'}-${type}`;
  if (alertTypes.includes(type)) {
    const now = Date.now();
    if (!this._lastNotifiedAt) this._lastNotifiedAt = {};
    if (!force && now - (this._lastNotifiedAt[key] || 0) < 10 * 60 * 1000) return;
    this._lastNotifiedAt[key] = now;
  } else if (lifecycleTypes.includes(type)) {
    const taskKey = String(taskId || 'global');
    if (!this._lastLifecycleState) this._lastLifecycleState = {};
    if (!force && this._lastLifecycleState[taskKey] === type) return;
    this._lastLifecycleState[taskKey] = type;
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

// #6：当房间配置发生变更时，自动将最新 JSON 备份文件推送到白名单管理员私聊
defaultBot.sendAutoBackupToChat = async function(store = db) {
  if (store.getSetting?.('auto_tg_backup') === '0') return false;
  const chatIds = parseAllowedChatId();
  if (!chatIds || !chatIds.size || typeof this.api?.sendDocument !== 'function') return false;

  const rooms = gistSync.exportRooms(store);
  const settings = store.getAllSettings?.() || {};
  const snapshot = {
    version: 2,
    exportedAt: new Date().toISOString(),
    rooms,
    settings,
  };
  const jsonContent = JSON.stringify(snapshot, null, 2);
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `streamops-backup-${dateStr}.json`;
  const cookieRooms = rooms.filter((r) => r.cookie).length;
  const totalTargets = rooms.reduce((sum, r) => sum + (r.targets?.length || 0), 0);

  for (const chatId of chatIds) {
    try {
      await this.api.sendDocument(
        chatId,
        new InputFile(Buffer.from(jsonContent, 'utf8'), filename),
        {
          caption:
            `💾 <b>配置变更自动备份</b>\n` +
            `🏠 房间：<b>${rooms.length}</b> 个（独立Cookie ${cookieRooms} 个）｜📤 线路：<b>${totalTargets}</b> 条\n` +
            `<i>直接转发此 .json 文件回本窗口即可一键恢复</i>`,
          parse_mode: 'HTML',
        }
      );
    } catch (err) {
      console.error(`自动备份推送失败 (chat: ${chatId}):`, err.message);
    }
  }
  return true;
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
module.exports.setShutdownHandler = setShutdownHandler;
module.exports.formatLogsHtml = formatLogsHtml;


