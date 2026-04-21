const { InlineKeyboard } = require('grammy');
const db = require('../../db');
const scheduler = require('../../core/scheduler');
const views = require('../views');
const {
  isValidRelayTargetUrl,
  isNumericRoomId,
  getMessageTextOrEmpty,
  parseExtraTargetUrls,
} = require('../utils/parser');

function register(bot, { safeEditMessageText, buildTaskDetailKeyboard }) {
  bot.command('addrtmp', async (ctx) => {
    const text = getMessageTextOrEmpty(ctx.message);
    const parts = text.split(/\s+/).filter(Boolean);
    if (parts.length < 3) {
      await ctx.reply('用法：\n/addrtmp 房间号 rtmp://地址 [更多 rtmp/rtmps 地址...]');
      return;
    }
    const roomId = parts[1];
    const targetUrls = parts.slice(2);
    if (!isNumericRoomId(roomId)) { await ctx.reply('❌ 房间号必须是纯数字。'); return; }
    if (targetUrls.some((v) => !isValidRelayTargetUrl(v))) {
      await ctx.reply('❌ 请输入有效的 RTMP/RTMPS 地址，必须以 rtmp:// 或 rtmps:// 开头。');
      return;
    }
    const task = db.getAllTasks().find((item) => String(item.room_id) === roomId);
    if (!task) { await ctx.reply(`❌ 未找到房间 ${roomId} 对应的任务。`); return; }
    try {
      for (const url of targetUrls) { db.addTarget(task.id, url); }
      await scheduler.tick?.();
      await ctx.reply(`✅ 已为房间 ${roomId} 增加 ${targetUrls.length} 条 RTMP/RTMPS。`);
    } catch (err) {
      await ctx.reply(`❌ 增加 RTMP 失败：${err.message}`);
    }
  });

  bot.callbackQuery(/^editrtmp:(\d+)/, async (ctx) => {
    const taskId = ctx.match[1];
    const task = db.getTaskById(taskId);
    if (!task) { await ctx.answerCallbackQuery('任务已不存在'); return; }
    await ctx.answerCallbackQuery();
    const currentUrl = task.primary_target_url || task.target_url || '未配置';
    await ctx.reply(
      `✏️ 修改推流地址\n\n房间：${views.platformLabel(task.platform)} #${task.room_id}\n\n` +
      `当前主推流地址：\n\`\`\`\n${currentUrl}\n\`\`\`\n\n请发送新的 RTMP/RTMPS 推流地址：`
    );
    ctx.session.editRtmp = { step: 'wait_new_url', taskId, startedAt: Date.now() };
  });

  bot.callbackQuery(/^addrtmp_ui:(\d+)/, async (ctx) => {
    const taskId = ctx.match[1];
    const task = db.getTaskById(taskId);
    if (!task) { await ctx.answerCallbackQuery('任务已不存在'); return; }
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `请输入新的 RTMP/RTMPS 推流地址（支持多个，用回车或逗号分隔）:\n\n房间：${views.platformLabel(task.platform)} #${task.room_id}`
    );
    ctx.session.addRtmp = { step: 'wait_rtmp_urls', taskId, startedAt: Date.now() };
  });

  bot.callbackQuery(/^delurl_ui:(\d+)/, async (ctx) => {
    const taskId = ctx.match[1];
    const task = db.getTaskById(taskId);
    if (!task) { await ctx.answerCallbackQuery('任务已不存在'); return; }
    const targets = task.targets || [];
    if (targets.length === 0) {
      await ctx.answerCallbackQuery({ text: '当前没有推流地址', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    const keyboard = new InlineKeyboard();
    targets.forEach((target, idx) => {
      keyboard.text(`${idx + 1}. ${views.maskTargetUrl(target.target_url)}`, `delurl:${taskId}:${target.id}`).row();
    });
    keyboard.text('⬅️ 取消', `manage:${taskId}`);
    const lines = [`🗑️ <b>选择要删除的推流地址：</b>`];
    targets.forEach((t, i) => {
      lines.push('');
      lines.push(`<b>${i + 1}.</b>${i === 0 ? ' ⭐主推流' : ''}`);
      lines.push(`<code>${views.escapeHtml(t.target_url)}</code>`);
    });
    await safeEditMessageText(ctx, lines.join('\n'), { parse_mode: 'HTML', reply_markup: keyboard });
  });

  bot.callbackQuery(/^delurl:(\d+):(\d+)/, async (ctx) => {
    const [, taskId, targetId] = ctx.match;
    try {
      db.deleteTargetById(taskId, targetId);
      await ctx.answerCallbackQuery('已删除');
      const task = db.getTaskById(taskId);
      if (!task) { await safeEditMessageText(ctx, '任务已不存在'); return; }
      await scheduler.refreshTask?.(task);
      await safeEditMessageText(ctx,
        views.renderTaskDetail(task, scheduler.isTaskRunning(task)),
        { parse_mode: 'HTML', reply_markup: buildTaskDetailKeyboard(task) }
      );
    } catch (err) {
      await ctx.answerCallbackQuery({ text: `删除失败：${err.message}`, show_alert: true });
    }
  });

  bot.on('message:text', async (ctx, next) => {
    const text = getMessageTextOrEmpty(ctx.message);
    if (text.startsWith('/')) { await next(); return; }

    const editRtmpState = ctx.session.editRtmp;
    if (editRtmpState?.step === 'wait_new_url') {
      if (!isValidRelayTargetUrl(text)) {
        await ctx.reply('❌ 推流地址无效，必须以 rtmp:// 或 rtmps:// 开头。');
        return;
      }
      const task = db.getTaskById(editRtmpState.taskId);
      if (!task) { await ctx.reply('❌ 任务已不存在'); ctx.session.editRtmp = null; return; }
      try {
        db.updatePrimaryTarget(editRtmpState.taskId, text);
        const latestTask = db.getTaskById(editRtmpState.taskId);
        await scheduler.refreshTask?.(latestTask || task);
        await ctx.reply(
          `✅ 推流地址已更新\n\n房间：${views.platformLabel(task.platform)} #${task.room_id}\n\n` +
          `新主推流地址：\n\`\`\`\n${text}\n\`\`\`\n\n⚙️ 已自动重启推流任务。`
        );
        ctx.session.editRtmp = null;
      } catch (err) {
        await ctx.reply(`❌ 修改失败：${err.message}`);
      }
      return;
    }

    const addRtmpState = ctx.session.addRtmp;
    if (addRtmpState?.step === 'wait_rtmp_urls') {
      const urls = parseExtraTargetUrls(text);
      if (urls.length === 0) { await ctx.reply('❌ 请输入有效的 RTMP/RTMPS 地址。'); return; }
      const invalidUrls = urls.filter((url) => !isValidRelayTargetUrl(url));
      if (invalidUrls.length > 0) {
        await ctx.reply(`❌ 以下地址无效（必须以 rtmp:// 或 rtmps:// 开头）:\n${invalidUrls.join('\n')}`);
        return;
      }
      const task = db.getTaskById(addRtmpState.taskId);
      if (!task) { await ctx.reply('❌ 任务已不存在'); ctx.session.addRtmp = null; return; }
      try {
        for (const url of urls) { db.addTarget(task.id, url); }
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
        allUrls.forEach((url, idx) => { message.push(`${idx + 1}. ${views.maskTargetUrl(url)}`); });
        await ctx.reply(message.join('\n'));
        ctx.session.addRtmp = null;
      } catch (err) {
        await ctx.reply(`❌ 添加失败：${err.message}`);
      }
      return;
    }

    await next();
  });
}

module.exports = { register };
