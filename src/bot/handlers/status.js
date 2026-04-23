const scheduler = require('../../core/scheduler');
const views = require('../views');

function register(bot, { mainKeyboard }) {
  const showDetailedStatus = async (ctx) => {
    // 强制刷新一次房间信息以确保最新
    if (typeof scheduler.refreshAllRoomInfo === 'function') {
      await scheduler.refreshAllRoomInfo();
    }
    
    const stats = scheduler.getTrafficStats();
    const runningTasks = stats.filter(t => t.traffic && t.traffic.running);
    
    // 发送文字状态
    await ctx.reply(views.renderDetailedStatus(runningTasks), { 
      parse_mode: 'HTML', 
      reply_markup: mainKeyboard 
    });

    // 如果有正在运行的任务，尝试发送一张当前最火的封面图（如果有）
    if (runningTasks.length > 0) {
      const topTask = runningTasks[0];
      const coverUrl = topTask.traffic?.roomInfo?.cover;
      if (coverUrl) {
        await ctx.replyWithPhoto(coverUrl, { 
          caption: `📸 实时监控: ${views.platformLabel(topTask.platform)} #${topTask.room_id}` 
        }).catch(() => {});
      }
    }
  };

  const showFfmpegParams = async (ctx) => {
    const stats = scheduler.getTrafficStats();
    await ctx.reply(views.renderFfmpegParams(stats), { 
      parse_mode: 'HTML', 
      reply_markup: mainKeyboard 
    });
  };

  bot.command('status', showDetailedStatus);
  bot.hears('📊 推流状态', showDetailedStatus);
  bot.hears('🛠️ FFmpeg 参数', showFfmpegParams);
}

module.exports = { register };
