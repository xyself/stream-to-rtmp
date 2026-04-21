const { InlineKeyboard, InputFile } = require('grammy');
const db = require('../../db');
const scheduler = require('../../core/scheduler');
const views = require('../views');
const {
  parseLiveRoomInput,
  isNumericRoomId,
  isValidRelayTargetUrl,
  getMessageTextOrEmpty,
  ensureAddRoomState,
  resetAddRoomState,
  cleanExpiredSessions,
} = require('../utils/parser');

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

function register(bot, { safeEditMessageText, buildTaskDetailKeyboard, buildTaskListKeyboard, mainKeyboard }) {
  const startAddRoom = async (ctx) => {
    const state = ensureAddRoomState(ctx.session);
    state.step = 'wait_room_id';
    state.roomId = null;
    state.platform = null;
    state.startedAt = Date.now();
    await ctx.reply(
      '✨ 新建转播任务\n\n请发送直播间链接或房间号：\n\n<i>支持：\n· https://live.bilibili.com/房间号\n· https://www.douyu.com/房间号\n· https://live.douyin.com/房间号\n· 纯数字房间号（需手动选平台）</i>',
      { parse_mode: 'HTML' }
    );
  };

  const showRooms = async (ctx) => {
    const tasks = db.getAllTasks();
    await ctx.reply(views.renderRoomList(tasks), {
      parse_mode: 'HTML',
      reply_markup: tasks.length ? buildTaskListKeyboard(tasks) : mainKeyboard,
    });
  };

  bot.command('addroom', startAddRoom);
  bot.command('rooms', showRooms);
  bot.hears('➕ 添加房间', startAddRoom);
  bot.hears('🏠 房间管理', showRooms);

  bot.callbackQuery(/^manage:(\d+)/, async (ctx) => {
    const task = db.getTaskById(ctx.match[1]);
    if (!task) { await ctx.answerCallbackQuery('任务已不存在'); return; }
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
    const task = db.getTaskById(ctx.match[1]);
    if (!task) { await ctx.answerCallbackQuery('任务已不存在'); return; }
    await scheduler.refreshTask?.(task);
    const latestTask = db.getTaskById(ctx.match[1]) || task;
    await ctx.answerCallbackQuery('已触发立即刷新');
    await safeEditMessageText(ctx,
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
      await ctx.replyWithPhoto(
        new InputFile(imageBuffer, `screenshot_${task.room_id}.jpg`),
        { caption: `📸 ${views.platformLabel(task.platform)} #${task.room_id} 截图\n${new Date().toLocaleString()}` }
      );
    } catch (error) {
      const msg = error.message || '未知错误';
      const userMessage = msg.includes('流不可用') ? '❌ 获取截图失败: 直播流不可用'
        : msg.includes('未获取到有效帧') ? '❌ 获取截图失败: 未获取到有效视频帧'
        : `❌ 获取截图失败: ${msg}`;
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
    if (!task) { await ctx.answerCallbackQuery('任务已不存在'); return; }
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `✏️ 修改房间号\n\n平台：${views.platformLabel(task.platform)}\n当前房间号：${task.room_id}\n\n请发送新的房间 ID（纯数字）：`
    );
    ctx.session.editRoom = { step: 'wait_new_room_id', taskId, startedAt: Date.now() };
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
    if (text.startsWith('/')) { await next(); return; }

    cleanExpiredSessions(ctx.session);
    const state = ensureAddRoomState(ctx.session);

    if (state.step === 'wait_room_id') {
      const parsed = parseLiveRoomInput(text);
      if (parsed.error) { await ctx.reply(`❌ ${parsed.error}`); return; }
      state.roomId = parsed.roomId;
      if (parsed.platform) {
        state.platform = parsed.platform;
        state.step = 'wait_target_url';
        await ctx.reply(
          `✅ 已识别：<b>${views.platformLabel(parsed.platform)}</b> 房间 <b>#${parsed.roomId}</b>\n\n请输入主 RTMP/RTMPS 推流地址：`,
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
      if (!isValidRelayTargetUrl(text)) {
        resetAddRoomState(ctx.session);
        await ctx.reply('❌ 主推流地址无效，必须以 rtmp:// 或 rtmps:// 开头。');
        return;
      }
      const payload = { roomId: state.roomId, platform: state.platform, targetUrl: text };
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

    await next();
  });
}

module.exports = { register, saveRoomTask };
