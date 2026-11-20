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

function register(bot, { safeEditMessageText, ephemeralReply, ephemeralPhoto, buildTaskDetailKeyboard, buildTaskListKeyboard, mainKeyboard }) {
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
      reply_markup: tasks.length ? buildTaskListKeyboard(tasks) : mainKeyboard,
    });
  };

  const showQuickSnap = async (ctx) => {
    const raw = getMessageTextOrEmpty(ctx.message).replace(/^\/snap\s*/i, '').trim();
    const tasks = scheduler.getTrafficStats();
    if (raw && isNumericRoomId(raw)) {
      const target = tasks.find((t) => String(t.room_id) === raw);
      if (!target) {
        await ctx.reply(`❌ 未找到房间 #${raw}`);
        return;
      }
      const manager = scheduler.getTaskManager?.(target);
      if (!manager || target.status !== 'ENABLED') {
        await ctx.reply(`❌ 房间 #${raw} 未启用或未运行，无法截图`);
        return;
      }
      try {
        const imageBuffer = await manager.captureSnapshot();
        await sendPhoto(
          ctx,
          new InputFile(imageBuffer, `screenshot_${target.room_id}.jpg`),
          { caption: `📸 ${views.platformLabel(target.platform)} #${target.room_id} 截图\n${new Date().toLocaleString('zh-CN', { hour12: false })}` }
        );
      } catch (err) {
        await sendReply(ctx, `❌ 获取截图失败: ${err.message}`);
      }
      return;
    }

    const enabled = tasks.filter((t) => t.status === 'ENABLED');
    if (enabled.length === 0) {
      await ctx.reply('📷 当前没有已启用的房间可截图。', { reply_markup: mainKeyboard });
      return;
    }
    const kb = new InlineKeyboard();
    enabled.forEach((t) => {
      const running = t.traffic?.running;
      const icon = running ? '🟢' : '✅';
      const host = t.traffic?.roomInfo?.hostName ? ` (${t.traffic.roomInfo.hostName})` : '';
      kb.text(`${icon} ${views.platformLabel(t.platform)} #${t.room_id}${host}`, `screenshot:${t.id}`).row();
    });
    await ctx.reply('📷 <b>快捷截图</b>\n点击下方房间立即抓取当前实时画面（也可直接发 <code>/snap 房间号</code>）：', {
      parse_mode: 'HTML',
      reply_markup: kb,
    });
  };

  const showQuickDiagnose = async (ctx) => {
    const raw = getMessageTextOrEmpty(ctx.message).replace(/^\/diagnose\s*/i, '').trim();
    const tasks = scheduler.getTrafficStats();
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
      await ctx.reply('🩺 当前没有配置任何房间。', { reply_markup: mainKeyboard });
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
  bot.command('snap', showQuickSnap);
  bot.command('diagnose', showQuickDiagnose);
  bot.hears('➕ 添加房间', startAddRoom);
  bot.hears('🏠 房间管理', showRooms);
  bot.hears('📷 快捷截图', showQuickSnap);

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
    const task = db.getTaskById(ctx.match[1]);
    if (!task) { await ctx.answerCallbackQuery('任务已不存在'); return; }

    if (task.status !== 'ENABLED') {
      await ctx.answerCallbackQuery({ text: '❌ 任务未启用，无法截图', show_alert: true });
      return;
    }

    const manager = scheduler.getTaskManager(task);
    if (!manager) {
      await ctx.answerCallbackQuery({ text: '❌ 任务未运行，无法截图', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery({ text: '正在获取截图...' });
    try {
      const imageBuffer = await manager.captureSnapshot();
      await sendPhoto(
        ctx,
        new InputFile(imageBuffer, `screenshot_${task.room_id}.jpg`),
        { caption: `📸 ${views.platformLabel(task.platform)} #${task.room_id} 截图\n${new Date().toLocaleString('zh-CN', { hour12: false })}` }
      );
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

  // 📈 24小时推流波浪曲线图（默认中午 12:00 → 次日中午 12:00，支持切换 00:00 → 24:00）
  const sendRoomWaveChart = async (ctx, targetId = 'all', mode = 'noon') => {
    const windowInfo = curveChart.get24HourWindow(mode);
    let task = null;
    let samples = [];

    if (targetId !== 'all') {
      task = getHydratedTaskWithTraffic(targetId);
      if (!task) {
        if (ctx.callbackQuery) await ctx.answerCallbackQuery('任务已不存在');
        else await ctx.reply('❌ 未找到指定房间');
        return;
      }
      samples = db.getBitrateSamples(task.id, windowInfo.startMs, windowInfo.endMs);
      // 若当前正处于推流中，补充当前时刻实时采样点以确保波浪线即时显示
      if (task.traffic?.running && task.traffic?.bitrateKbps > 0) {
        const now = Date.now();
        if (now >= windowInfo.startMs && now <= windowInfo.endMs) {
          samples = [...samples, { task_id: task.id, ts: now, kbps: Math.round(task.traffic.bitrateKbps) }];
        }
      }
    } else {
      samples = db.getAllBitrateSamples(windowInfo.startMs, windowInfo.endMs);
      const allLive = scheduler.getTrafficStats?.() || [];
      const now = Date.now();
      if (now >= windowInfo.startMs && now <= windowInfo.endMs) {
        for (const t of allLive) {
          if (t.traffic?.running && t.traffic?.bitrateKbps > 0) {
            samples.push({ task_id: t.id, ts: now, kbps: Math.round(t.traffic.bitrateKbps) });
          }
        }
      }
    }

    const { pngBuffer, sessions } = curveChart.renderWaveChartPng({
      samples,
      mode: windowInfo.mode,
    });
    const unicodeWave = curveChart.renderUnicodeWave(samples, windowInfo.startMs, windowInfo.endMs);
    const caption = views.renderWaveChartCaption({
      task,
      windowInfo,
      sessions,
      unicodeWave,
    });

    const kb = new InlineKeyboard()
      .text(
        windowInfo.mode === 'noon' ? '✅ 🕛 12:00→次日12:00' : '🕛 12:00→次日12:00',
        `curve:${targetId}:noon`
      )
      .text(
        windowInfo.mode === 'midnight' ? '✅ 🌅 00:00→24:00' : '🌅 00:00→24:00',
        `curve:${targetId}:midnight`
      )
      .row();

    if (task) {
      kb.text('⚙️ 返回房间控制台', `manage:${task.id}`);
    } else {
      kb.text('📊 返回推流状态总览', 'tstatus_back');
    }

    await sendPhoto(
      ctx,
      new InputFile(pngBuffer, `wave_${targetId}_${windowInfo.mode}.png`),
      {
        caption,
        parse_mode: 'HTML',
        reply_markup: kb,
      }
    );
  };

  bot.command('curve', async (ctx) => {
    const raw = getMessageTextOrEmpty(ctx.message).replace(/^\/curve\s*/i, '').trim();
    if (raw && isNumericRoomId(raw)) {
      const found = db.getAllTasks().find((t) => String(t.room_id) === raw);
      if (found) {
        await sendRoomWaveChart(ctx, String(found.id), 'noon');
        return;
      }
    }
    await sendRoomWaveChart(ctx, 'all', 'noon');
  });

  bot.hears('📈 推流曲线', async (ctx) => {
    await sendRoomWaveChart(ctx, 'all', 'noon');
  });

  const showSnapSelector = async (ctx) => {
    const raw = getMessageTextOrEmpty(ctx.message).replace(/^\/snap\s*/i, '').trim();
    const tasks = scheduler.getTrafficStats?.() || db.getAllTasks();
    if (raw && isNumericRoomId(raw)) {
      const found = tasks.find((t) => String(t.room_id) === raw);
      if (found) {
        const manager = scheduler.getTaskManager(found);
        if (!manager || found.status !== 'ENABLED') {
          await sendReply(ctx, `❌ ${views.platformLabel(found.platform)} #${found.room_id} 未启用或未运行，无法截图`);
          return;
        }
        try {
          const imageBuffer = await manager.captureSnapshot();
          await sendPhoto(
            ctx,
            new InputFile(imageBuffer, `screenshot_${found.room_id}.jpg`),
            { caption: `📸 ${views.platformLabel(found.platform)} #${found.room_id} 截图\n${new Date().toLocaleString('zh-CN', { hour12: false })}` }
          );
        } catch (error) {
          await sendReply(ctx, `❌ 获取截图失败: ${error.message || '未知错误'}`);
        }
        return;
      }
    }

    const enabled = tasks.filter((t) => t.status === 'ENABLED');
    if (enabled.length === 0) {
      await sendReply(ctx, '📷 当前没有启用中的直播房间，无法截图。');
      return;
    }
    const kb = new InlineKeyboard();
    enabled.forEach((task) => {
      const running = task.traffic?.running;
      const host = task.traffic?.roomInfo?.hostName ? ` (${task.traffic.roomInfo.hostName})` : '';
      kb.text(`${running ? '🟢' : '⚪'} ${views.platformLabel(task.platform)} #${task.room_id}${host}`, `screenshot:${task.id}`).row();
    });
    await sendReply(ctx, '📷 <b>快捷截图</b>\n点击要截取实时画面的房间（也可直接发 <code>/snap 房间号</code>）：', {
      parse_mode: 'HTML',
      reply_markup: kb,
    });
  };

  bot.command('snap', showSnapSelector);
  bot.hears('📷 快捷截图', showSnapSelector);

  const showDiagnoseSelector = async (ctx) => {
    const raw = getMessageTextOrEmpty(ctx.message).replace(/^\/diagnose\s*/i, '').trim();
    const tasks = scheduler.getTrafficStats?.() || db.getAllTasks();
    if (raw && isNumericRoomId(raw)) {
      const found = tasks.find((t) => String(t.room_id) === raw);
      if (found) {
        await sendReply(ctx, `🔍 正在诊断 ${views.platformLabel(found.platform)} #${found.room_id}，请稍候...`);
        try {
          const report = await diagnoseTask(found);
          const kb = new InlineKeyboard()
            .text('🔄 重新诊断', `diagnose:${found.id}`)
            .text('⚙️ 返回控制台', `manage:${found.id}`);
          await sendReply(ctx, views.renderDiagnoseReport(found, report), { parse_mode: 'HTML', reply_markup: kb });
        } catch (err) {
          await sendReply(ctx, `❌ 诊断失败：${err.message}`);
        }
        return;
      }
    }

    if (tasks.length === 0) {
      await sendReply(ctx, '🔍 当前没有配置任何房间。');
      return;
    }
    const kb = new InlineKeyboard();
    tasks.forEach((task) => {
      const host = task.traffic?.roomInfo?.hostName ? ` (${task.traffic.roomInfo.hostName})` : '';
      kb.text(`🔍 ${views.platformLabel(task.platform)} #${task.room_id}${host}`, `diagnose:${task.id}`).row();
    });
    await sendReply(ctx, '🔍 <b>链路诊断</b>\n选择要诊断拉流与编码链路的房间（或发 <code>/diagnose 房间号</code>）：', {
      parse_mode: 'HTML',
      reply_markup: kb,
    });
  };

  bot.command('diagnose', showDiagnoseSelector);

  bot.callbackQuery(/^curve:(\d+|all):(noon|midnight)$/, async (ctx) => {
    const [, targetId, mode] = ctx.match;
    await ctx.answerCallbackQuery(
      mode === 'noon' ? '📈 生成 12:00→次日12:00 波浪曲线...' : '📈 生成 00:00→24:00 波浪曲线...'
    );
    try {
      await sendRoomWaveChart(ctx, targetId, mode);
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
      scheduler.stopManager?.(task);
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
        reply_markup: tasks.length ? buildTaskListKeyboard(tasks) : undefined,
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
        scheduler.stopManager?.(task);
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
            const titlePart = info.title ? `标题：${views.escapeHtml(info.title)}\n` : '';
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

module.exports = { register, saveRoomTask, getHydratedTaskWithTraffic };
