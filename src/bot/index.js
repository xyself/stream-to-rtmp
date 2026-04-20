const { Bot, InlineKeyboard, Keyboard, session } = require('grammy');
const db = require('../db');
const scheduler = require('../core/scheduler');
const views = require('./views');

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
    .text('📈 流量查看')
    .resized();
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
    .text('🔄 刷新检测', `refresh:${task.id}`)
    .row()
    .text('🗑️ 删除任务', `del:${task.id}`)
    .row()
    .text('⬅️ 返回列表', 'back_list');

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

function isValidRelayTargetUrl(value) {
  return /^(rtmp|rtmps):\/\//i.test(value);
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
  await ctx.reply(
    `✅ 任务已下发并已触发立即检测\n房间：${roomId} (${views.platformLabel(platform)})\n主 RTMP：已配置\n额外 RTMP：0 条\n状态：监控中（FFmpeg 会在检测到开播后立即启动）\n\n如需追加更多 RTMP/RTMPS，请直接发送命令：\n/addrtmp ${roomId} rtmp://backup/live/xxx [更多地址...]`
  );
}

async function addRoomConversation(conversation, ctx) {
  await ctx.reply('✨ 新建转播任务\n\n请输入直播间 ID（只能填纯数字，不要发房间链接）：');
  const idMsg = await conversation.wait();
  const roomId = getMessageTextOrEmpty(idMsg.message);
  if (!roomId) {
    await ctx.reply('❌ 请发送文本格式的房间 ID。');
    return;
  }
  if (!isNumericRoomId(roomId)) {
    await ctx.reply('❌ 房间 ID 只能填写纯数字，例如 1001，不要输入直播间链接。');
    return;
  }

  const platformKeyboard = new InlineKeyboard()
    .text('Bilibili', 'p:bilibili')
    .text('斗鱼', 'p:douyu');
  await ctx.reply('请选择直播平台：', { reply_markup: platformKeyboard });

  const callbackCtx = await conversation.waitForCallbackQuery(/^p:/);
  await conversation.external(() => callbackCtx.answerCallbackQuery());
  const platform = callbackCtx.callbackQuery.data.split(':')[1];

  await ctx.reply('请输入主 RTMP/RTMPS 推流地址：');
  const urlMsg = await conversation.wait();
  const targetUrl = getMessageTextOrEmpty(urlMsg.message);
  if (!targetUrl) {
    await ctx.reply('❌ 请发送文本格式的 RTMP/RTMPS 地址。');
    return;
  }
  if (!isValidRelayTargetUrl(targetUrl)) {
    await ctx.reply('❌ 主推流地址无效，必须以 rtmp:// 或 rtmps:// 开头。');
    return;
  }

  try {
    await saveRoomTask(ctx, { roomId, platform, targetUrl });
  } catch (err) {
    await ctx.reply(`❌ 保存失败：${err.message}`);
  }
}

function createRelayBot(token = process.env.TG_TOKEN) {
  const bot = new Bot(token, {
    client: {
      timeoutSeconds: 60,
    },
  });
  const mainKeyboard = buildMainKeyboard();

  const showDashboard = async (ctx) => {
    await ctx.reply(views.renderDashboard(scheduler.getStats()), { reply_markup: mainKeyboard });
  };

  const showRooms = async (ctx) => {
    const tasks = db.getAllTasks();
    if (tasks.length === 0) {
      await ctx.reply(views.renderRoomList(tasks), { reply_markup: mainKeyboard });
      return;
    }

    await ctx.reply(views.renderRoomList(tasks), {
      reply_markup: buildTaskListKeyboard(tasks),
    });
  };

  const startAddRoom = async (ctx) => {
    const state = ensureAddRoomState(ctx.session);
    state.step = 'wait_room_id';
    state.roomId = null;
    state.platform = null;
    await ctx.reply('✨ 新建转播任务\n\n请输入直播间 ID（只能填纯数字，不要发房间链接）：');
  };

  const showTraffic = async (ctx) => {
    await ctx.reply(views.renderRoomTraffic(scheduler.getTrafficStats()), { reply_markup: mainKeyboard });
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

  bot.callbackQuery(/^manage:(\d+)/, async (ctx) => {
    const taskId = ctx.match[1];
    const task = db.getTaskById(taskId);
    if (!task) {
      await ctx.answerCallbackQuery('任务已不存在');
      return;
    }

    await ctx.editMessageText(
      views.renderTaskDetail(task, scheduler.isTaskRunning(task)),
      { reply_markup: buildTaskDetailKeyboard(task) }
    );
  });

  bot.callbackQuery(/^toggle:(\d+):(\w+)/, async (ctx) => {
    const [, id, status] = ctx.match;
    const newStatus = status === 'ENABLED' ? 'DISABLED' : 'ENABLED';
    db.updateTaskStatus(id, newStatus);
    await scheduler.tick?.();
    await ctx.answerCallbackQuery(`状态已切换至 ${newStatus}`);

    const task = db.getTaskById(id);
    await ctx.editMessageText(
      views.renderTaskDetail(task, scheduler.isTaskRunning(task)),
      { reply_markup: buildTaskDetailKeyboard(task) }
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
    await ctx.editMessageText(
      views.renderTaskDetail(latestTask, scheduler.isTaskRunning(latestTask)),
      { reply_markup: buildTaskDetailKeyboard(latestTask) }
    );
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
        { source: imageBuffer },
        { caption: `📸 ${task.platform} 房间 ${task.room_id} 截图 (${new Date().toLocaleString()})` }
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
    await ctx.editMessageText('🗑️ 任务已物理删除');
  });

  bot.callbackQuery('back_list', async (ctx) => {
    await ctx.answerCallbackQuery();
    const tasks = db.getAllTasks();
    await ctx.editMessageText(views.renderRoomList(tasks), {
      reply_markup: tasks.length ? buildTaskListKeyboard(tasks) : undefined,
    });
  });

  bot.callbackQuery(/^p:(bilibili|douyu)$/, async (ctx) => {
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

    const state = ensureAddRoomState(ctx.session);

    if (state.step === 'wait_room_id') {
      if (!isNumericRoomId(text)) {
        resetAddRoomState(ctx.session);
        await ctx.reply('❌ 房间 ID 只能填写纯数字，例如 1001，不要输入直播间链接。');
        return;
      }

      state.roomId = text;
      state.step = 'wait_platform';
      const platformKeyboard = new InlineKeyboard()
        .text('Bilibili', 'p:bilibili')
        .text('斗鱼', 'p:douyu');
      await ctx.reply('请选择直播平台：', { reply_markup: platformKeyboard });
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

    await next();
  });

  return bot;
}

module.exports = createRelayBot();
module.exports.createRelayBot = createRelayBot;
module.exports.createChatGuard = createChatGuard;
module.exports.parseAllowedChatId = parseAllowedChatId;
module.exports.buildMainKeyboard = buildMainKeyboard;
module.exports.buildTaskListKeyboard = buildTaskListKeyboard;
module.exports.buildTaskDetailKeyboard = buildTaskDetailKeyboard;
module.exports.registerBotCommands = registerBotCommands;
module.exports.addRoomConversation = addRoomConversation;
module.exports.parseExtraTargetUrls = parseExtraTargetUrls;
module.exports.ensureAddRoomState = ensureAddRoomState;
module.exports.resetAddRoomState = resetAddRoomState;
module.exports.saveRoomTask = saveRoomTask;
