require('dotenv').config();

const http = require('http');

const express = require('express');

const { renderDashboard } = require('./src/web/dashboard');



// 使用系统 FFmpeg，或通过 FFMPEG_PATH 环境变量指定自定义路径

if (process.env.FFMPEG_PATH) {

  const FFmpeg = require('fluent-ffmpeg');

  FFmpeg.setFfmpegPath(process.env.FFMPEG_PATH);

  console.log('🔧 使用自定义 FFmpeg:', process.env.FFMPEG_PATH);

} else {

  console.log('🔧 使用系统 FFmpeg');

}



const defaultDb = require('./src/db');

const defaultScheduler = require('./src/core/scheduler');

const defaultBot = require('./src/bot');

const r2sync = require('./src/db/r2-sync');



function createApp({

  scheduler = defaultScheduler,

  bot = defaultBot,

  db = defaultDb,

  logger = console,

  processRef = process,

} = {}) {

  let shuttingDown = false;

  let readySent = false;

  let server = null; // 合并为一个 server 实例



  function sendReady() {

    if (readySent) return;

    readySent = true;

    if (typeof processRef.send === 'function') {

      processRef.send('ready');

    }

  }



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

      logger.error('❌ 停止机器人时出错:', err);

    }



    // 先备份到 R2，再关闭数据库

    try {

      await r2sync.uploadRooms(db);

      if (typeof db.close === 'function') db.close();

    } catch (err) {

      logger.error('❌ R2 备份失败:', err.message);

    }



    logger.log('✅ 系统已全面退出。');

    processRef.exit?.(0);

  }



  function startServer() {

    const app = express();

    // 只使用 PORT

    const port = parseInt(process.env.PORT, 10) || 8000;



    // 1. 健康检查接口

    app.get('/health', (req, res) => {

      res.json({ status: 'ok', uptime: process.uptime() });

    });



    // 2. 流量监控面板主页

    app.get('/', (req, res) => {

      res.send(renderDashboard());

    });



    // 3. 流量监控数据 API

    app.get('/api/flow', (req, res) => {

      // 按需启用流量统计（如果尚未启用）

      if (typeof scheduler.enableAllStats === 'function') {

        scheduler.enableAllStats();

      }

      

      const stats = (typeof scheduler.getStats === 'function') ? scheduler.getStats() : { runningManagers: 0 };

      const trafficStats = (typeof scheduler.getTrafficStats === 'function') ? scheduler.getTrafficStats() : [];

      

      // 计算总码率

      const totalBitrate = trafficStats.reduce((sum, task) => sum + (task.traffic?.bitrateKbps || 0), 0);

      

      res.json({

        active: stats.runningManagers || 0,

        totalBitrate: Math.round(totalBitrate),

        tasks: trafficStats.map((task) => ({

          roomId: task.room_id,

          platform: task.platform,

          status: task.status,

          bitrateKbps: task.traffic?.bitrateKbps || 0,

          sessionBytes: task.traffic?.sessionBytes || 0,

        })),

      });

    });



    server = app.listen(port, () => {

      logger.log(`🌐 Web 面板及健康检查服务已启动，端口: ${port}`);

    });

  }



  async function bootstrap() {

    logger.log('🚀 正在初始化直播转播系统 (grammY 版)...');

    

    // 启动合并后的服务

    startServer();



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

      // 每次用户触发 DB 写操作后，延迟 3 秒上传到 R2（防抖）

      if (r2sync.isConfigured()) {

        let uploadTimer = null;

        db.onWrite = () => {

          clearTimeout(uploadTimer);

          uploadTimer = setTimeout(async () => {

            try { await r2sync.uploadRooms(db); } catch {}

          }, 3000);

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

        logger.error('⚠️ 注册 Telegram Bot 命令失败，继续启动机器人:', err);

      }



      logger.log('🤖 正在启动 Telegram long polling...');

      await bot.start({

        onStart: async (info) => {

          logger.log('------------------------------------');

          logger.log(`🤖 机器人 @${info.username} 已上线`);

          logger.log('------------------------------------');

          sendReady();

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