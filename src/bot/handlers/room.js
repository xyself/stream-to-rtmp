const { InlineKeyboard, InputFile } = require('grammy');
const db = require('../../db');
const scheduler = require('../../core/scheduler');
const { diagnoseTask } = require('../../core/manager');
const rooms = require('../../platforms');
const curveChart = require('../../core/curve-chart');
const views = require('../views');
const {
  detectLiveUrlCandidate,
  parseLiveRoomInput,
  resolveLiveRoomInput,
  parseQuickAddInput,
  isNumericRoomId,
  isValidRelayTargetUrl,
  getMessageTextOrEmpty,
  ensureAddRoomState,
  resetAddRoomState,
  cleanExpiredSessions,
} = require('../utils/parser');

function getHydratedTaskWithTraffic(taskId) {
  const numericId = String(taskId);
  const withTraffic = scheduler.getTrafficStats?.().find((t) => String(t.id) === numericId);
  if (withTraffic) return withTraffic;
  return db.getTaskById(taskId);
}

/**
 * 筛选当前正在推流中的房间（严格区分“正在推流”与“仅启用待机”）
 */
function selectStreamingTasks(tasks = [], sched = scheduler) {
  return (Array.isArray(tasks) ? tasks : []).filter(
    (t) => t && t.status === 'ENABLED' && Boolean(t.traffic?.running || sched?.isTaskStreaming?.(t))
  );
}

/**
 * 构建单房间分钟级曲线的交互键盘：
 * Row 1: 固定 5 档分钟级窗口 [30分 | 1小时 | 3小时 | 6小时 | 12小时]
 * Row 2 (多房间时): [◀ 上一房 | 📋 切换房间 | 下一房 ▶]
 * Row 3: [⚙️ 房间控制台 | 🔄 刷新]
 */
function buildCurveKeyboard(targetId, activeMode = '1h', allTasks = []) {
  const kb = new InlineKeyboard();
  const minuteModes = curveChart.MINUTE_WINDOW_ORDER || ['30m', '1h', '3h', '6h', '12h'];
  const shortLabels = { '30m': '30分', '1h': '1小时', '3h': '3小时', '6h': '6小时', '12h': '12小时' };

  for (const m of minuteModes) {
    const label = activeMode === m ? `✓${shortLabels[m]}` : shortLabels[m];
    kb.text(label, `curve:${targetId}:${m}`);
  }
  kb.row();

  const sorted = views.sortTasksByActivity ? views.sortTasksByActivity(allTasks || []) : (allTasks || []);
  if (targetId !== 'all' && sorted.length > 1) {
    const idx = sorted.findIndex((t) => String(t.id) === String(targetId));
    const safeIdx = idx >= 0 ? idx : 0;
    const prevTask = sorted[(safeIdx - 1 + sorted.length) % sorted.length];
    const nextTask = sorted[(safeIdx + 1) % sorted.length];
    const safeMode = minuteModes.includes(activeMode) ? activeMode : '1h';
    kb.text('◀ 上一房', `curve:${prevTask.id}:${safeMode}`)
      .text('📋 切换房间', 'open_curve_menu')
      .text('下一房 ▶', `curve:${nextTask.id}:${safeMode}`)
      .row();
  }

  if (targetId !== 'all') {
    kb.text('⚙️ 房间控制台', `manage:${targetId}`)
      .text('🔄 刷新', `curve:${targetId}:${activeMode}`);
  } else {
    kb.text('📋 分房查看', 'open_curve_menu')
      .text('🔄 刷新', `curve:all:${activeMode}`);
  }
  return kb;
}

async function saveRoomTask(ctx, { roomId, platform, targetUrl, extraTargetUrls = [] }) {
  db.addTask({ platform, roomId, targetUrl, extraTargetUrls });
  await scheduler.tick?.();

  const allUrls = [targetUrl, ...extraTargetUrls].filter(Boolean);
  const urlLines = allUrls.map((u, idx) =>
    `${idx + 1}. ${idx === 0 ? '⭐主推流' : `备用 #${idx}`}\n<code>${views.escapeHtml(u)}</code>`
  );

  const message = [
    `<b>✅ 任务已下发</b>`,
    '',
    `<b>📌 任务信息</b>`,
    `  平台：${views.escapeHtml(views.platformLabel(platform))}`,
    `  房间：#${views.escapeHtml(roomId)}`,
    `  状态：✅ 已启用`,
    '',
    `<b>📤 推流地址 (${allUrls.length})</b>`,
    ...urlLines,
    '',
    `⚙️ 监控中（FFmpeg 会在检测到开播后立即启动）`,
    '',
    `<i>💡 如需管理或追加备用线路，进入「🏠 房间管理」点击对应房间即可操作</i>`,
  ].join('\n');

  await ctx.reply(message, { parse_mode: 'HTML' });
}

function register(bot, {
  safeEditMessageText,
  safeEditMessageMedia,
  ephemeralReply,
  ephemeralPhoto,
  sendWidgetToChat,
  buildTaskDetailKeyboard,
  buildTaskListKeyboard,
  mainKeyboard,
}) {
  const sendReply = ephemeralReply || ((ctx, text, opts) => ctx.reply(text, opts));
  const sendPhoto = ephemeralPhoto || ((ctx, photo, opts) => ctx.replyWithPhoto(photo, opts));

  const startAddRoom = async (ctx) => {
    const rawText = getMessageTextOrEmpty(ctx.message);
    // 支持 /addroom https://live.bilibili.com/1000 rtmp://... 一行指令极速创建
    if (/^\/addroom\s+\S+/i.test(rawText)) {
      const quick = parseQuickAddInput(rawText);
      if (quick) {
        resetAddRoomState(ctx.session);
        try {
          await saveRoomTask(ctx, quick);
        } catch (err) {
          await ctx.reply(`❌ 保存失败：${err.message}`);
        }
        return;
      }
    }

    const state = ensureAddRoomState(ctx.session);
    state.step = 'wait_room_id';
    state.roomId = null;
    state.platform = null;
    state.startedAt = Date.now();
    await ctx.reply(
      '✨ <b>新建转播任务</b>\n\n' +
      '<b>方式 1（极速一行创建）</b>：\n直接发送 <code>直播间链接 + 空格 + rtmp://推流地址</code>\n\n' +
      '<b>方式 2（裸丢链接）</b>：\n平时直接把直播间链接（含 <code>v.douyin.com</code> / <code>b23.tv</code> 短链）发给 Bot 即可一键识别建房\n\n' +
      '<b>方式 3（分步引导）</b>：\n先发送直播间链接或纯数字房间号：\n' +
      '<i>· https://live.bilibili.com/房间号（或 b23.tv 短链）\n· https://www.douyu.com/房间号\n· https://live.douyin.com/房间号（或 v.douyin.com 短链）\n· 纯数字房间号（需手动选平台）</i>',
      { parse_mode: 'HTML' }
    );
  };

  const showRooms = async (ctx) => {
    const tasks = scheduler.getTrafficStats();
    await ctx.reply(views.renderRoomList(tasks), {
      parse_mode: 'HTML',
      reply_markup: buildTaskListKeyboard(tasks),
    });
  };

  const captureAndSendSnapshot = async (ctx, task, { indexLabel = '' } = {}) => {
    const manager = scheduler.getTaskManager?.(task);
    if (!manager) {
      throw new Error('推流管理器未就绪');
    }
    const imageBuffer = await manager.captureSnapshot();
    const kb = new InlineKeyboard()
      .text('🔄 重新抓帧', `screenshot:${task.id}`)
      .text('⚙️ 房间控制台', `manage:${task.id}`);
    await sendPhoto(
      ctx,
      new InputFile(imageBuffer, `screenshot_${task.room_id}.jpg`),
      {
        caption: views.renderSnapshotCaption(task, { indexLabel }),
        parse_mode: 'HTML',
        reply_markup: kb,
      }
    );
  };

  const showQuickSnap = async (ctx, isCallback = false) => {
    const raw = isCallback ? '' : getMessageTextOrEmpty(ctx.message).replace(/^\/snap\s*/i, '').trim();
    const tasks = scheduler.getTrafficStats?.() || db.getAllTasks();

    // 显式指定了 /snap 房间号
    if (raw && isNumericRoomId(raw)) {
      const target = tasks.find((t) => String(t.room_id) === raw);
      if (!target) {
        await sendReply(ctx, `❌ 未找到房间 <code>#${views.escapeHtml(raw)}</code>`, { parse_mode: 'HTML' });
        return;
      }
      const isStreaming = target.status === 'ENABLED' && Boolean(target.traffic?.running || scheduler.isTaskStreaming?.(target));
      if (!isStreaming) {
        const kb = new InlineKeyboard()
          .text('⚙️ 房间控制台', `manage:${target.id}`)
          .text('🩺 诊断测试', `diagnose:${target.id}`);
        await sendReply(
          ctx,
          `⏸️ <b>${views.escapeHtml(views.platformLabel(target.platform))} #${views.escapeHtml(target.room_id)}</b> 当前未在推流中，无法抓取实时画面。`,
          { parse_mode: 'HTML', reply_markup: kb }
        );
        return;
      }
      try {
        await captureAndSendSnapshot(ctx, target);
      } catch (err) {
        await sendReply(ctx, `❌ 获取截图失败: ${views.escapeHtml(err.message || '未知错误')}`, { parse_mode: 'HTML' });
      }
      return;
    }

    // 默认快捷截图：直接抓取所有【正在推流中】的房间，无需手动再选房间
    const streaming = selectStreamingTasks(tasks, scheduler);
    if (streaming.length === 0) {
      if (isCallback) {
        await ctx.answerCallbackQuery({ text: '⏸️ 当前暂无正在推流的房间', show_alert: true }).catch(() => {});
        return;
      }
      const emptyKb = new InlineKeyboard();
      if (tasks.length === 0) {
        emptyKb.text('➕ 立即添加房间', 'quick_add_room').text('🏠 房间管理', 'back_list');
      } else {
        emptyKb.text('📊 查看推流状态', 'tstatus_back').text('🏠 房间管理', 'back_list');
      }
      await sendReply(ctx, views.renderQuickSnapEmpty(tasks), {
        parse_mode: 'HTML',
        reply_markup: emptyKb,
      });
      return;
    }

    if (isCallback) {
      await ctx.answerCallbackQuery(`📸 正在为 ${streaming.length} 路推流抓帧...`).catch(() => {});
    } else if (streaming.length > 1) {
      await ctx.reply(`📷 检测到 <b>${streaming.length}</b> 路正在推流，正在自动抓帧...`, { parse_mode: 'HTML' });
    }

    // 顺序逐路抓帧，避免在 Serv00 / 低配容器中并发拉起多个 FFmpeg 截图进程打满配额
    const failed = [];
    for (let i = 0; i < streaming.length; i += 1) {
      const task = streaming[i];
      const indexLabel = streaming.length > 1 ? `[${i + 1}/${streaming.length}]` : '';
      try {
        await captureAndSendSnapshot(ctx, task, { indexLabel });
      } catch (err) {
        failed.push(`${views.platformLabel(task.platform)} #${task.room_id}：${err.message || '未知错误'}`);
      }
    }

    if (failed.length > 0) {
      await sendReply(
        ctx,
        `⚠️ <b>部分推流抓帧失败</b>\n<blockquote>${failed.map((f) => `• ${views.escapeHtml(f)}`).join('\n')}</blockquote>`,
        { parse_mode: 'HTML' }
      );
    }
  };

  const showQuickDiagnose = async (ctx) => {
    const raw = getMessageTextOrEmpty(ctx.message).replace(/^\/diagnose\s*/i, '').trim();
    const tasks = scheduler.getTrafficStats?.() || db.getAllTasks();
    if (raw && isNumericRoomId(raw)) {
      const target = tasks.find((t) => String(t.room_id) === raw);
      if (!target) {
        await ctx.reply(`❌ 未找到房间 #${raw}`);
        return;
      }
      await ctx.reply(`🩺 正在诊断 ${views.platformLabel(target.platform)} #${target.room_id}...`);
      try {
        const diag = await diagnoseTask(target);
        const kb = new InlineKeyboard()
          .text('🔄 重新诊断', `diagnose:${target.id}`)
          .text('⚙️ 房间控制台', `manage:${target.id}`);
        await sendReply(ctx, views.renderDiagnoseReport(target, diag), { parse_mode: 'HTML', reply_markup: kb });
      } catch (err) {
        await sendReply(ctx, `❌ 诊断失败：${err.message}`);
      }
      return;
    }

    if (tasks.length === 0) {
      const emptyKb = new InlineKeyboard().text('➕ 立即添加房间', 'quick_add_room');
      await ctx.reply(
        '<b>🩺 链路诊断</b>\n\n<blockquote>📭 当前还没有配置任何房间，添加房间后即可检测 API、Cookie 与源流线路。</blockquote>',
        { parse_mode: 'HTML', reply_markup: emptyKb }
      );
      return;
    }
    const kb = new InlineKeyboard();
    tasks.forEach((t) => {
      const host = t.traffic?.roomInfo?.hostName ? ` (${t.traffic.roomInfo.hostName})` : '';
      kb.text(`🩺 ${views.platformLabel(t.platform)} #${t.room_id}${host}`, `diagnose:${t.id}`).row();
    });
    await ctx.reply('🩺 <b>链路诊断</b>\n选择要检测 API / Cookie / 源流线路的房间（或发 <code>/diagnose 房间号</code>）：', {
      parse_mode: 'HTML',
      reply_markup: kb,
    });
  };

  bot.command('addroom', startAddRoom);
  bot.command('rooms', showRooms);
  bot.command('snap', (ctx) => showQuickSnap(ctx, false));
  bot.command('diagnose', showQuickDiagnose);
  bot.hears('➕ 添加房间', startAddRoom);
  bot.hears('🏠 房间管理', showRooms);
  bot.hears('📷 快捷截图', (ctx) => showQuickSnap(ctx, false));

  bot.callbackQuery('quick_add_room', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await startAddRoom(ctx);
  });

  bot.callbackQuery('quick_snap_live', async (ctx) => {
    await showQuickSnap(ctx, true);
  });

  bot.callbackQuery(/^rooms_filter:(all|live|idle|paused)$/, async (ctx) => {
    const filter = ctx.match[1];
    const tasks = scheduler.getTrafficStats();
    const filterToast = { all: '已显示全部房间', live: '仅显示推流中', idle: '仅显示待机', paused: '仅显示已暂停' };
    await ctx.answerCallbackQuery(filterToast[filter] || '已刷新').catch(() => {});
    await safeEditMessageText(ctx, views.renderRoomList(tasks, filter), {
      parse_mode: 'HTML',
      reply_markup: buildTaskListKeyboard(tasks, filter),
    });
  });

  bot.callbackQuery('open_widget', async (ctx) => {
    await ctx.answerCallbackQuery('🎛️ 正在打开实时卡片...').catch(() => {});
    if (typeof sendWidgetToChat === 'function') {
      await sendWidgetToChat(ctx);
    } else {
      await sendReply(ctx, '请发送 /widget 打开实时卡片');
    }
  });

  bot.callbackQuery(/^manage:(\d+)/, async (ctx) => {
    const taskId = ctx.match[1];
    let task = getHydratedTaskWithTraffic(taskId);
    if (!task) { await ctx.answerCallbackQuery('任务已不存在'); return; }
    await ctx.answerCallbackQuery();
    // 若还没有缓存过主播信息，顺手异步刷一下（最多等 2 秒）
    if (!task.traffic?.roomInfo) {
      try {
        const manager = scheduler.getTaskManager?.(task);
        if (manager?.refreshRoomInfo) {
          await Promise.race([
            manager.refreshRoomInfo(),
            new Promise((resolve) => setTimeout(resolve, 2000)),
          ]);
          task = getHydratedTaskWithTraffic(taskId) || task;
        }
      } catch {}
    }
    await safeEditMessageText(
      ctx,
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
    const task = getHydratedTaskWithTraffic(id);
    await safeEditMessageText(
      ctx,
      views.renderTaskDetail(task, scheduler.isTaskRunning(task)),
      { parse_mode: 'HTML', reply_markup: buildTaskDetailKeyboard(task) }
    );
  });

  bot.callbackQuery(/^refresh:(\d+)/, async (ctx) => {
    const taskId = ctx.match[1];
    const task = db.getTaskById(taskId);
    if (!task) { await ctx.answerCallbackQuery('任务已不存在'); return; }
    await scheduler.refreshTask?.(task);
    try {
      const manager = scheduler.getTaskManager?.(task);
      if (manager?.refreshRoomInfo) {
        await Promise.race([
          manager.refreshRoomInfo(),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
      }
    } catch {}
    const latestTask = getHydratedTaskWithTraffic(taskId) || task;
    await ctx.answerCallbackQuery('已触发立即刷新');
    await safeEditMessageText(
      ctx,
      views.renderTaskDetail(latestTask, scheduler.isTaskRunning(latestTask)),
      { parse_mode: 'HTML', reply_markup: buildTaskDetailKeyboard(latestTask) }
    );
  });

  bot.callbackQuery(/^screenshot:(\d+)/, async (ctx) => {
    const task = getHydratedTaskWithTraffic(ctx.match[1]);
    if (!task) { await ctx.answerCallbackQuery('任务已不存在'); return; }

    if (task.status !== 'ENABLED') {
      await ctx.answerCallbackQuery({ text: '❌ 任务未启用，无法截图', show_alert: true });
      return;
    }

    const isStreaming = Boolean(task.traffic?.running || scheduler.isTaskStreaming?.(task));
    if (!isStreaming) {
      await ctx.answerCallbackQuery({ text: '⏸️ 该房间当前未在推流中，开播后即可抓帧', show_alert: true });
      return;
    }

    const manager = scheduler.getTaskManager(task);
    if (!manager) {
      await ctx.answerCallbackQuery({ text: '❌ 任务未运行，无法截图', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery({ text: '📸 正在获取实时截图...' });
    try {
      await captureAndSendSnapshot(ctx, task);
    } catch (error) {
      const msg = error.message || '未知错误';
      const userMessage = msg.includes('流不可用') ? '❌ 获取截图失败: 直播流不可用'
        : msg.includes('未获取到有效帧') ? '❌ 获取截图失败: 未获取到有效视频帧'
        : `❌ 获取截图失败: ${msg}`;
      await sendReply(ctx, userMessage);
    }
  });

  bot.callbackQuery(/^stat:(\d+)/, async (ctx) => {
    const task = db.getTaskById(ctx.match[1]);
    if (!task) { await ctx.answerCallbackQuery('任务已不存在'); return; }
    await ctx.answerCallbackQuery();
    const entry = scheduler.getTrafficStats().find((s) => String(s.id) === String(task.id));
    await sendReply(ctx, views.renderDetailedStatus(entry ? [entry] : []), { parse_mode: 'HTML' });
  });

  bot.callbackQuery(/^failover:(\d+)/, async (ctx) => {
    const task = db.getTaskById(ctx.match[1]);
    if (!task) { await ctx.answerCallbackQuery('任务已不存在'); return; }
    const manager = scheduler.getTaskManager?.(task);
    if (!manager || !manager.backupUrls || manager.backupUrls.length === 0) {
      await ctx.answerCallbackQuery({ text: '没有备用线路可切换', show_alert: true });
      return;
    }
    const ok = await manager.manualFailover();
    await ctx.answerCallbackQuery(ok ? `已切换到备用线路（剩余 ${manager.backupUrls.length} 条）` : '切换失败');
  });

  // #1 & #2：单房间独立画质/音频修复编码模式切换
  bot.callbackQuery(/^transcode_mode:(\d+)/, async (ctx) => {
    const taskId = ctx.match[1];
    const task = db.getTaskById(taskId);
    if (!task) { await ctx.answerCallbackQuery('任务已不存在'); return; }
    const nextMode = views.nextTranscodeMode(task.transcode_mode || 'default');
    db.updateTaskTranscodeMode(taskId, nextMode);
    const latestTask = db.getTaskById(taskId);
    await scheduler.refreshTask?.(latestTask || task);
    const label = views.transcodeModeLabel(nextMode);
    await ctx.answerCallbackQuery(`🎬 编码策略已切换为：${label}`);
    const hydrated = getHydratedTaskWithTraffic(taskId) || latestTask;
    await safeEditMessageText(
      ctx,
      views.renderTaskDetail(hydrated, scheduler.isTaskRunning(hydrated)),
      { parse_mode: 'HTML', reply_markup: buildTaskDetailKeyboard(hydrated) }
    );
  });

  // #3：推流前“源流 & Cookie 一键诊断”
  bot.callbackQuery(/^diagnose:(\d+)/, async (ctx) => {
    const taskId = ctx.match[1];
    const task = db.getTaskById(taskId);
    if (!task) { await ctx.answerCallbackQuery('任务已不存在'); return; }
    await ctx.answerCallbackQuery('🩺 正在检测平台 API、Cookie 与源流线路...');
    try {
      const diag = await diagnoseTask(task);
      const kb = new InlineKeyboard()
        .text('🔄 重新诊断', `diagnose:${task.id}`)
        .text('⚙️ 返回房间控制台', `manage:${task.id}`);
      await sendReply(ctx, views.renderDiagnoseReport(task, diag), {
        parse_mode: 'HTML',
        reply_markup: kb,
      });
    } catch (err) {
      await sendReply(ctx, `❌ 诊断失败：${err.message}`);
    }
  });

  // 📈 分房间分钟级深色高清推流曲线图（30分 / 1小时 / 3小时 / 6小时 / 12小时，兼容旧 24h 按钮）
  const sendRoomWaveChart = async (ctx, targetId = 'all', mode = '1h', { editInPlace = false } = {}) => {
    const windowInfo = curveChart.getCurveWindow(mode);
    const allTasks = scheduler.getTrafficStats?.() || db.getAllTasks();
    let task = null;
    let samples = [];
    let liveKbps = 0;

    if (targetId !== 'all') {
      task = getHydratedTaskWithTraffic(targetId);
      if (!task) {
        if (ctx.callbackQuery) await ctx.answerCallbackQuery('任务已不存在').catch(() => {});
        else await ctx.reply('❌ 未找到指定房间');
        return;
      }
      samples = db.getBitrateSamples(task.id, windowInfo.startMs, windowInfo.endMs);
      if (task.traffic?.running && task.traffic?.bitrateKbps > 0) {
        liveKbps = Math.round(task.traffic.bitrateKbps);
        const now = Date.now();
        if (now >= windowInfo.startMs && now <= windowInfo.endMs) {
          samples = [...samples, { task_id: task.id, ts: now, kbps: liveKbps }];
        }
      }
    } else {
      samples = db.getAllBitrateSamples(windowInfo.startMs, windowInfo.endMs);
      const now = Date.now();
      if (now >= windowInfo.startMs && now <= windowInfo.endMs) {
        for (const t of allTasks) {
          if (t.traffic?.running && t.traffic?.bitrateKbps > 0) {
            const k = Math.round(t.traffic.bitrateKbps);
            liveKbps += k;
            samples.push({ task_id: t.id, ts: now, kbps: k });
          }
        }
      }
    }

    const chartTitle = task
      ? `${curveChart.platformAsciiTag(task.platform)} #${task.room_id}`
      : 'ALL ROOMS';
    const chart = curveChart.renderWaveChartPng({
      samples,
      mode: windowInfo.mode,
      title: chartTitle,
      currentKbps: liveKbps > 0 ? liveKbps : null,
    });
    const unicodeWave = curveChart.renderUnicodeWave(samples, windowInfo.startMs, windowInfo.endMs);
    const caption = views.renderWaveChartCaption({
      task,
      windowInfo,
      sessions: chart.sessions,
      unicodeWave,
      avgKbps: chart.avgKbps,
      peakKbps: chart.peakKbps,
      currentKbps: liveKbps,
    });

    const kb = buildCurveKeyboard(String(targetId), windowInfo.mode, allTasks);
    const filename = `curve_${task ? task.room_id : 'all'}_${windowInfo.mode}.png`;
    const photoOpts = {
      caption,
      parse_mode: 'HTML',
      reply_markup: kb,
      filename,
    };

    if (editInPlace && typeof safeEditMessageMedia === 'function') {
      await safeEditMessageMedia(ctx, chart.pngBuffer, photoOpts);
      return;
    }

    await sendPhoto(
      ctx,
      new InputFile(chart.pngBuffer, filename),
      {
        caption,
        parse_mode: 'HTML',
        reply_markup: kb,
      }
    );
  };

  const showCurveEntry = async (ctx, { isCallback = false, forcePicker = false } = {}) => {
    const tasks = scheduler.getTrafficStats?.() || db.getAllTasks();
    if (tasks.length === 0) {
      const emptyKb = new InlineKeyboard().text('➕ 立即添加房间', 'quick_add_room');
      const html = views.renderCurveRoomPicker([]);
      if (isCallback) {
        await safeEditMessageText(ctx, html, { parse_mode: 'HTML', reply_markup: emptyKb });
      } else {
        await ctx.reply(html, { parse_mode: 'HTML', reply_markup: emptyKb });
      }
      return;
    }

    // 只有 1 个房间时，直接渲染该房间的 1 小时曲线
    if (tasks.length === 1) {
      await sendRoomWaveChart(ctx, String(tasks[0].id), '1h', { editInPlace: false });
      return;
    }

    // 非强制选房时，若当前有正在推流的房间，优先直达首个推流中房间的 1 小时曲线（下方自带切房按钮）
    if (!forcePicker) {
      const streaming = selectStreamingTasks(tasks, scheduler);
      if (streaming.length > 0) {
        await sendRoomWaveChart(ctx, String(streaming[0].id), '1h', { editInPlace: false });
        return;
      }
    }

    // 多房间选择器卡片
    const sorted = views.sortTasksByActivity ? views.sortTasksByActivity(tasks) : tasks;
    const kb = new InlineKeyboard();
    sorted.forEach((t) => {
      const running = t.status === 'ENABLED' && Boolean(t.traffic?.running);
      const icon = t.status !== 'ENABLED' ? '🛑' : running ? '🟢' : '⚪';
      const host = t.traffic?.roomInfo?.hostName ? ` (${t.traffic.roomInfo.hostName})` : '';
      const kbps = Math.round(t.traffic?.bitrateKbps || 0);
      const rateTag = running && kbps > 0 ? ` · ${kbps}k` : '';
      kb.text(`${icon} ${views.platformLabel(t.platform)} #${t.room_id}${host}${rateTag}`, `curve:${t.id}:1h`).row();
    });
    kb.text('🏠 返回房间管理', 'back_list');

    const html = views.renderCurveRoomPicker(sorted);
    if (isCallback) {
      await safeEditMessageText(ctx, html, { parse_mode: 'HTML', reply_markup: kb });
    } else {
      await ctx.reply(html, { parse_mode: 'HTML', reply_markup: kb });
    }
  };

  bot.command('curve', async (ctx) => {
    const raw = getMessageTextOrEmpty(ctx.message).replace(/^\/curve\s*/i, '').trim();
    if (raw && isNumericRoomId(raw)) {
      const found = db.getAllTasks().find((t) => String(t.room_id) === raw);
      if (found) {
        await sendRoomWaveChart(ctx, String(found.id), '1h', { editInPlace: false });
        return;
      }
      await ctx.reply(`❌ 未找到房间 <code>#${views.escapeHtml(raw)}</code>`, { parse_mode: 'HTML' });
      return;
    }
    await showCurveEntry(ctx, { isCallback: false, forcePicker: false });
  });

  bot.hears('📈 推流曲线', async (ctx) => {
    await showCurveEntry(ctx, { isCallback: false, forcePicker: false });
  });

  bot.callbackQuery('open_curve_menu', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await showCurveEntry(ctx, { isCallback: true, forcePicker: true });
  });

  bot.callbackQuery(/^curve:(\d+|all):(30m|1h|3h|6h|12h|noon|midnight)$/, async (ctx) => {
    const [, targetId, mode] = ctx.match;
    const labelMap = {
      '30m': '近 30 分钟',
      '1h': '近 1 小时',
      '3h': '近 3 小时',
      '6h': '近 6 小时',
      '12h': '近 12 小时',
      noon: '12:00→次日12:00',
      midnight: '00:00→24:00',
    };
    await ctx.answerCallbackQuery(`📈 加载 ${labelMap[mode] || mode} 码率曲线...`).catch(() => {});
    const fromPhoto = Boolean(ctx.callbackQuery?.message?.photo);
    try {
      await sendRoomWaveChart(ctx, targetId, mode, { editInPlace: fromPhoto });
    } catch (err) {
      await sendReply(ctx, `❌ 生成推流曲线失败：${err.message}`);
    }
  });

  // 防手滑二次确认删除
  bot.callbackQuery(/^del_confirm:(\d+)/, async (ctx) => {
    const task = db.getTaskById(ctx.match[1]);
    if (!task) { await ctx.answerCallbackQuery('任务已不存在'); return; }
    await ctx.answerCallbackQuery('请确认是否删除');
    const confirmKb = new InlineKeyboard()
      .text('⚠️ 确认物理删除', `del:${task.id}`)
      .text('⬅️ 取消返回', `manage:${task.id}`);
    await safeEditMessageText(ctx, views.renderDeleteConfirm(task), {
      parse_mode: 'HTML',
      reply_markup: confirmKb,
    });
  });

  bot.callbackQuery(/^del:(\d+)/, async (ctx) => {
    const task = db.getTaskById(ctx.match[1]);
    if (task) {
      await scheduler.stopManager?.(task);
    }
    db.deleteTask(ctx.match[1]);
    await scheduler.tick?.();
    await ctx.answerCallbackQuery('任务已删除');
    const tasks = scheduler.getTrafficStats();
    await safeEditMessageText(
      ctx,
      `🗑️ 已删除房间任务\n\n${views.renderRoomList(tasks)}`,
      {
        parse_mode: 'HTML',
        reply_markup: buildTaskListKeyboard(tasks),
      }
    );
  });

  bot.callbackQuery(/^editroom:(\d+)/, async (ctx) => {
    const taskId = ctx.match[1];
    const task = db.getTaskById(taskId);
    if (!task) { await ctx.answerCallbackQuery('任务已不存在'); return; }
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `✏️ 修改房间号\n\n平台：${views.platformLabel(task.platform)}\n当前房间号：${task.room_id}\n\n请发送新的房间 ID（纯数字）：`
    );
    ctx.session.editRoom = { step: 'wait_new_room_id', taskId, startedAt: Date.now() };
  });

  // 房间级独立 Cookie 设置（B站不同房间可用不同账号解锁原画/防风控，抖音/斗鱼也可按房独立配置）
  bot.callbackQuery(/^editcookie:(\d+)/, async (ctx) => {
    const taskId = ctx.match[1];
    const task = db.getTaskById(taskId);
    if (!task) { await ctx.answerCallbackQuery('任务已不存在'); return; }
    await ctx.answerCallbackQuery();

    const platformHint = task.platform === 'bilibili'
      ? 'B站可填含 <code>SESSDATA=...</code> 的 Cookie（解锁登录态真原画码率，不同房间可绑定不同B站账号防风控）'
      : task.platform === 'douyin'
        ? '抖音可填含 <code>__ac_nonce=...; ttwid=...</code> 的网页版 Cookie'
        : '斗鱼可填自定义请求 Cookie';

    const currentCookieText = task.cookie
      ? `<code>${views.escapeHtml(task.cookie)}</code>`
      : '<i>未单独配置（使用默认访客/全局配置）</i>';

    const kb = new InlineKeyboard();
    if (task.cookie) {
      kb.text('🗑️ 清除此房间Cookie', `clearcookie:${task.id}`).row();
    }
    kb.text('⬅️ 返回房间控制台', `manage:${task.id}`);

    ctx.session.editRoomCookie = { step: 'wait_room_cookie', taskId, startedAt: Date.now() };
    await ctx.reply(
      `🍪 <b>设置房间独立 Cookie</b>\n\n` +
      `房间：<b>${views.escapeHtml(views.platformLabel(task.platform))} #${views.escapeHtml(task.room_id)}</b>\n` +
      `说明：${platformHint}\n\n` +
      `当前房间 Cookie：\n${currentCookieText}\n\n` +
      `请直接发送新的 Cookie 字符串（仅对该房间生效）：`,
      { parse_mode: 'HTML', reply_markup: kb }
    );
  });

  bot.callbackQuery(/^clearcookie:(\d+)/, async (ctx) => {
    const taskId = ctx.match[1];
    const task = db.getTaskById(taskId);
    if (!task) { await ctx.answerCallbackQuery('任务已不存在'); return; }
    db.updateTaskCookie(taskId, null);
    ctx.session.editRoomCookie = null;
    const latestTask = db.getTaskById(taskId);
    await scheduler.refreshTask?.(latestTask || task);
    await ctx.answerCallbackQuery('已清除该房间的独立 Cookie');
    const hydrated = getHydratedTaskWithTraffic(taskId) || latestTask;
    await safeEditMessageText(
      ctx,
      views.renderTaskDetail(hydrated, scheduler.isTaskRunning(hydrated)),
      { parse_mode: 'HTML', reply_markup: buildTaskDetailKeyboard(hydrated) }
    );
  });

  bot.callbackQuery('back_list', async (ctx) => {
    await ctx.answerCallbackQuery();
    const tasks = scheduler.getTrafficStats();
    await safeEditMessageText(ctx, views.renderRoomList(tasks), {
      parse_mode: 'HTML',
      reply_markup: buildTaskListKeyboard(tasks),
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
    state.startedAt = Date.now();
    await ctx.answerCallbackQuery();
    await ctx.reply('请输入主 RTMP/RTMPS 推流地址（支持多个，用空格或换行分隔）：');
  });

  bot.callbackQuery(/^quickadd:confirm:(bilibili|douyu|douyin):(\d+)$/, async (ctx) => {
    const [, platform, roomId] = ctx.match;
    const state = ensureAddRoomState(ctx.session);
    state.platform = platform;
    state.roomId = roomId;
    state.step = 'wait_target_url';
    state.startedAt = Date.now();
    await ctx.answerCallbackQuery('✅ 已确认房间，请发送推流地址');
    await ctx.reply(
      `✅ 已选定：<b>${views.platformLabel(platform)}</b> 房间 <b>#${roomId}</b>\n\n` +
      `请直接回复主 RTMP/RTMPS 推流地址（支持多条，用空格、逗号或换行分隔；输入 /cancel 可取消）：`,
      { parse_mode: 'HTML' }
    );
  });

  bot.callbackQuery('quickadd:cancel', async (ctx) => {
    resetAddRoomState(ctx.session);
    await ctx.answerCallbackQuery('已忽略');
    await safeEditMessageText(ctx, '已忽略该直播间链接。');
  });

  bot.on('message:text', async (ctx, next) => {
    const text = getMessageTextOrEmpty(ctx.message);
    if (text.startsWith('/')) { await next(); return; }

    cleanExpiredSessions(ctx.session);
    const state = ensureAddRoomState(ctx.session);

    // 房间级独立 Cookie 会话处理
    const editCookieState = ctx.session.editRoomCookie;
    if (editCookieState?.step === 'wait_room_cookie') {
      const task = db.getTaskById(editCookieState.taskId);
      if (!task) {
        await ctx.reply('❌ 任务已不存在');
        ctx.session.editRoomCookie = null;
        return;
      }
      try {
        db.updateTaskCookie(editCookieState.taskId, text);
        const latestTask = db.getTaskById(editCookieState.taskId);
        await scheduler.refreshTask?.(latestTask || task);
        ctx.session.editRoomCookie = null;
        const kb = new InlineKeyboard().text('⚙️ 返回房间控制台', `manage:${task.id}`);
        await ctx.reply(
          `✅ <b>房间独立 Cookie 已更新</b>\n\n` +
          `房间：<b>${views.escapeHtml(views.platformLabel(task.platform))} #${views.escapeHtml(task.room_id)}</b>\n` +
          `Cookie 长度：${text.length} 字符\n` +
          `<code>${views.escapeHtml(text)}</code>\n\n` +
          `⚙️ 已自动重启该房间监控任务并应用新 Cookie。`,
          { parse_mode: 'HTML', reply_markup: kb }
        );
      } catch (err) {
        await ctx.reply(`❌ 修改房间 Cookie 失败：${err.message}`);
      }
      return;
    }

    const inOtherSession = Boolean(
      ctx.session.editRtmp ||
      ctx.session.addRtmp ||
      ctx.session.editRoom ||
      ctx.session.setCookie ||
      ctx.session.editRoomCookie ||
      ctx.session.waitFallbackPhoto
    );

    // 无论是否在 wait_room_id 步骤，只要消息中同时包含【直播间链接/平台房间号 + rtmp地址】，且不在其他会话中，直接一步创建！
    if (!inOtherSession) {
      const quick = parseQuickAddInput(text);
      if (quick) {
        resetAddRoomState(ctx.session);
        try {
          await saveRoomTask(ctx, quick);
        } catch (err) {
          await ctx.reply(`❌ 保存失败：${err.message}`);
        }
        return;
      }
    }

    if (state.step === 'wait_room_id') {
      const parsed = await resolveLiveRoomInput(text);
      if (parsed.error) { await ctx.reply(`❌ ${parsed.error}`); return; }
      state.roomId = parsed.roomId;
      state.startedAt = Date.now();
      if (parsed.platform) {
        state.platform = parsed.platform;
        state.step = 'wait_target_url';
        await ctx.reply(
          `✅ 已识别：<b>${views.platformLabel(parsed.platform)}</b> 房间 <b>#${parsed.roomId}</b>\n\n请输入主 RTMP/RTMPS 推流地址（支持多个，用换行或逗号分隔）：`,
          { parse_mode: 'HTML' }
        );
      } else {
        state.step = 'wait_platform';
        await ctx.reply('请选择直播平台：', {
          reply_markup: new InlineKeyboard()
            .text('Bilibili', 'p:bilibili')
            .text('斗鱼', 'p:douyu')
            .text('抖音', 'p:douyin'),
        });
      }
      return;
    }

    if (state.step === 'wait_target_url') {
      const urls = text.split(/[\s,，]+/).map((u) => u.trim()).filter(Boolean);
      const validUrls = urls.filter((u) => isValidRelayTargetUrl(u));
      if (validUrls.length === 0) {
        resetAddRoomState(ctx.session);
        await ctx.reply('❌ 推流地址无效，必须以 rtmp:// 或 rtmps:// 开头。');
        return;
      }
      const payload = {
        roomId: state.roomId,
        platform: state.platform,
        targetUrl: validUrls[0],
        extraTargetUrls: validUrls.slice(1),
      };
      resetAddRoomState(ctx.session);
      try {
        await saveRoomTask(ctx, payload);
      } catch (err) {
        await ctx.reply(`❌ 保存失败：${err.message}`);
      }
      return;
    }

    const editRoomState = ctx.session.editRoom;
    if (editRoomState?.step === 'wait_new_room_id') {
      if (!isNumericRoomId(text)) { await ctx.reply('❌ 房间 ID 只能填写纯数字，例如 1001。'); return; }
      const task = db.getTaskById(editRoomState.taskId);
      if (!task) { await ctx.reply('❌ 任务已不存在'); ctx.session.editRoom = null; return; }
      try {
        await scheduler.stopManager?.(task);
        db.updateRoomId(editRoomState.taskId, text);
        const latestTask = db.getTaskById(editRoomState.taskId);
        await scheduler.refreshTask?.(latestTask || task);
        await ctx.reply(
          `✅ 房间号已更新\n\n平台：${views.platformLabel(task.platform)}\n${task.room_id} → ${text}\n\n⚙️ 已自动重启推流任务。`
        );
        ctx.session.editRoom = null;
      } catch (err) {
        await ctx.reply(`❌ 修改失败：${err.message}`);
      }
      return;
    }

    // 裸丢直播间链接（含短链）一键识别建房
    if (!inOtherSession && !state.step && detectLiveUrlCandidate(text)) {
      const resolved = await resolveLiveRoomInput(text);
      if (resolved.error) {
        await ctx.reply(`⚠️ ${resolved.error}`);
        return;
      }
      if (resolved.platform && resolved.roomId) {
        const existing = db.getAllTasks().find(
          (t) => t.platform === resolved.platform && String(t.room_id) === String(resolved.roomId)
        );
        if (existing) {
          const kb = new InlineKeyboard().text('⚙️ 打开房间控制台', `manage:${existing.id}`);
          await ctx.reply(
            `ℹ️ 检测到直播间：<b>${views.platformLabel(resolved.platform)} #${resolved.roomId}</b>\n该房间已在你的监控列表中。`,
            { parse_mode: 'HTML', reply_markup: kb }
          );
          return;
        }

        let infoLine = '';
        try {
          const probeRoom = rooms.create(resolved.platform, resolved.roomId);
          const info = await Promise.race([
            probeRoom.getInfo(),
            new Promise((resolve) => setTimeout(() => resolve(null), 2500)),
          ]);
          if (info) {
            const liveTag = info.isLive ? '🟢 正在直播' : '⚪ 当前未开播';
            const hostPart = info.hostName ? `主播：<b>${views.escapeHtml(info.hostName)}</b>\n` : '';
            const roomTitle = info.roomName || info.title || '';
            const titlePart = roomTitle ? `标题：${views.escapeHtml(roomTitle)}\n` : '';
            infoLine = `\n${hostPart}${titlePart}状态：${liveTag}\n`;
          }
        } catch {}

        const kb = new InlineKeyboard()
          .text('✅ 添加此房间', `quickadd:confirm:${resolved.platform}:${resolved.roomId}`)
          .text('❌ 忽略', 'quickadd:cancel');
        await ctx.reply(
          `🔗 <b>识别到直播间链接</b>\n\n` +
          `平台：<b>${views.platformLabel(resolved.platform)}</b>\n` +
          `房间号：<code>${resolved.roomId}</code>` +
          `${infoLine}\n是否添加到转播列表？`,
          { parse_mode: 'HTML', reply_markup: kb }
        );
        return;
      }
    }

    await next();
  });
}

module.exports = {
  register,
  saveRoomTask,
  getHydratedTaskWithTraffic,
  selectStreamingTasks,
  buildCurveKeyboard,
};
