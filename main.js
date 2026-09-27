require('dotenv').config();

const http = require('http');

const express = require('express');

const { renderDashboard } = require('./src/web/dashboard');

const { restoreOnce } = require('./src/init/restore');

// 使用系统 FFmpeg，或通过 FFMPEG_PATH 环境变量指定自定义路径

if (process.env.FFMPEG_PATH) {

  console.log('🔧 使用自定义 FFmpeg:', process.env.FFMPEG_PATH);

} else {

  console.log('🔧 使用系统 FFmpeg');

}


const defaultDb = require('./src/db');

const defaultScheduler = require('./src/core/scheduler');

const defaultBot = require('./src/bot');

const gistSync = require('./src/db/gist-sync');

const crypto = require('crypto');



function createApp({

  scheduler = defaultScheduler,

  bot = defaultBot,

  db = defaultDb,

  logger = console,

  processRef = process,

} = {}) {

  let shuttingDown = false;

  let server = null; // 合并为一个 server 实例



  function installBotErrorLogging() {

    if (typeof bot?.catch !== 'function') return;

    bot.catch((err) => {

      logger.error('❌ Telegram bot 运行时异常:', err.message ?? err);

    });

  }



  async function gracefulShutdown(signal) {

    if (shuttingDown) return;

    shuttingDown = true;



    logger.log(`\n[${signal}] 正在执行优雅退出程序...`);



    if (scheduler && typeof scheduler.stopAll === 'function') {

      scheduler.stopAll();

    }



    // 关闭合并后的 Web 服务

    if (server) {

      server.close();

    }



    try {

      if (!bot || typeof bot.isRunning !== 'function' || bot.isRunning()) {

        await bot?.stop?.();

      }

      logger.log('✅ 机器人已安全下线');

    } catch (err) {

      logger.error('❌ 机器人停止失败:', err.message);

    }


    // 先备份到 Gist，再关闭数据库
    try {
      await gistSync.uploadRooms(db);
      if (typeof db.close === 'function') db.close();
    } catch (err) {
      logger.error('❌ Gist 备份失败:', err.message);

    }



    logger.log('✅ 系统已全面退出。');

    // 不立即调用 process.exit()，让事件循环自然排空
    // 兜底：2 秒后强制退出（unref 使其不阻止自然退出）
    setTimeout(() => processRef.exit?.(0), 2000).unref();

  }



  function startServer() {

    const app = express();

    // 只使用 PORT

    const port = parseInt(process.env.PORT, 10) || 8080;

    // 默认只监听本地回环；需要对外访问时显式配置 BIND_HOST=0.0.0.0
    const bindHost = process.env.BIND_HOST || '127.0.0.1';
    const dashboardToken = process.env.DASHBOARD_TOKEN || '';

    // 面板鉴权：配置了 DASHBOARD_TOKEN 后，面板与数据 API 需要 ?token=xxx
    function checkDashboardAuth(req, res, next) {
      if (!dashboardToken) return next();
      const provided = String(req.query.token || '');
      const a = Buffer.from(provided);
      const b = Buffer.from(dashboardToken);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
      res.status(401).json({ error: 'unauthorized' });
    }

    // 1. 健康检查接口（容器健康检查用，保持公开）

    app.get('/health', (req, res) => {

      res.json({ status: 'ok', uptime: process.uptime() });

    });



    // 2. 流量监控面板主页

    app.get('/', checkDashboardAuth, (req, res) => {

      res.send(renderDashboard());

    });



    // 3. 流量监控数据 API

    app.get('/api/flow', checkDashboardAuth, (req, res) => {

      // 按需启用流量统计（如果尚未启用）

      if (typeof scheduler.enableAllStats === 'function') {

        scheduler.enableAllStats();

      }



      const stats = (typeof scheduler.getStats === 'function') ? scheduler.getStats() : { runningManagers: 0 };

      const trafficStats = (typeof scheduler.getTrafficStats === 'function') ? scheduler.getTrafficStats() : [];



      // 计算总码率

      const totalBitrate = trafficStats.reduce((sum, task) => sum + (task.traffic?.bitrateKbps || 0), 0);



      res.json({
        active: stats.activeStreams || 0,
        totalMonitoring: stats.totalMonitoring || 0,
        totalBitrate: Math.round(totalBitrate),

        tasks: trafficStats.map((task) => ({

          roomId: task.room_id,

          platform: task.platform,

          status: task.status,

          bitrateKbps: task.traffic?.bitrateKbps || 0,

          sessionBytes: task.traffic?.sessionBytes || 0,

          errorCount: task.traffic?.errorCount || 0,

          lastSuccessAt: task.traffic?.lastSuccessAt,
          startedAt: task.traffic?.startedAt,
          roomInfo: task.traffic?.roomInfo,
        })),

      });

    });



    server = app.listen(port, bindHost, () => {

      logger.log(`🌐 Web 面板及健康检查服务已启动，监听: ${bindHost}:${port}`);
      if (!dashboardToken) {
        logger.log('⚠️ 未配置 DASHBOARD_TOKEN，面板无鉴权（仅建议本机访问）');
      }

    });

  }



  async function bootstrap() {
    
    await restoreOnce();

    logger.log('🚀 正在初始化直播转播系统 (grammY 版)...');

    // TG_CHAT_ID 为空时直接拒绝启动：避免机器人对所有人开放
    const allowedChatIds = bot.parseAllowedChatId?.();
    if (!allowedChatIds || allowedChatIds.size === 0) {
      logger.error('❌ 未配置 TG_CHAT_ID：为安全起见拒绝启动，请在 .env 中填写授权聊天 ID 后重试');
      processRef.exit?.(1);
      return;
    }

    // PORT 有值才启动 Web 服务

    if (process.env.PORT) startServer();



    try {

      logger.log('📦 数据库服务：就绪');



      // 设置 scheduler 的通知回调

      if (typeof scheduler.setOnNotify === 'function') {

        scheduler.setOnNotify((notification) => {

          if (typeof bot?.handleManagerNotification === 'function') {

            bot.handleManagerNotification(notification);

          }

        });

      }



      scheduler.start();

      logger.log('⚙️ 任务调度器：已启动');

      // 每次用户触发 DB 写操作后，延迟 30 秒同步到 Gist（防抖）

      if (gistSync.isConfigured()) {

        gistSync.seedContentCache(db);

        let uploadTimer = null;

        db.onWrite = () => {

          clearTimeout(uploadTimer);

          uploadTimer = setTimeout(async () => {

            try { await gistSync.uploadRooms(db); } catch (err) { logger.error('Gist 上传失败:', err.message); }

          }, 30000);

        };

      }

      processRef.on?.('SIGTERM', () => gracefulShutdown('SIGTERM'));

      processRef.on?.('SIGINT', () => gracefulShutdown('SIGINT'));



      installBotErrorLogging();



      try {

        logger.log('🤖 正在注册 Telegram Bot 命令...');

        await bot.registerBotCommands?.(bot);

        logger.log('✅ Telegram Bot 命令注册完成');

      } catch (err) {

        logger.error('⚠️ 注册 Telegram Bot 命令失败，继续启动机器人:', err.message);

      }



      logger.log('🤖 正在启动 Telegram long polling...');

      await bot.start({

        onStart: async (info) => {

          logger.log('------------------------------------');

          logger.log(`🤖 机器人 @${info.username} 已上线`);

          logger.log('------------------------------------');

          const chatIds = bot.parseAllowedChatId?.();
          if (chatIds) {
            for (const id of chatIds) {
              try {
                await bot.api.sendMessage(id, '🚀 <b>系统已重启，UI 已同步更新</b>', {
                  parse_mode: 'HTML',
                  reply_markup: bot.buildMainKeyboard?.(),
                });
              } catch (err) {
                logger.error(`发送重启通知失败 (chatId: ${id}):`, err.message);
              }
            }
          }

        },

      });

      logger.log('ℹ️ bot.start() 已退出');

    } catch (err) {

      logger.error('❌ 系统启动过程中发生致命错误:', err);

      processRef.exit?.(1);

    }

  }



  return {

    bootstrap,

    gracefulShutdown,

  };

}



process.on('unhandledRejection', (reason) => {

  console.error('⚠️ 监测到未处理的异步异常:', reason);

});



module.exports = { createApp };



if (require.main === module) {

  const app = createApp();

  app.bootstrap();

}