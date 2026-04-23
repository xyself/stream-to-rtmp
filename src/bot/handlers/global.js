const db = require('../../db');
const scheduler = require('../../core/scheduler');
const views = require('../views');
const gistSync = require('../../db/gist-sync');

function register(bot, { safeEditMessageText, buildDashboardKeyboard, getSystemInfo, getRecentErrors }) {
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
}

module.exports = { register };
