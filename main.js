require('dotenv').config();

// fluent-ffmpeg 会自动查找系统中的 FFmpeg 或使用 FFMPEG_PATH 环境变量
if (process.env.FFMPEG_PATH) {
  console.log('🔧 使用配置的 FFmpeg:', process.env.FFMPEG_PATH);
  const FFmpeg = require('fluent-ffmpeg');
  FFmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
} else {
  console.log('🔍 使用系统 FFmpeg...');
}

const defaultDb = require('./src/db');
const defaultScheduler = require('./src/core/scheduler');
const defaultBot = require('./src/bot');

function createApp({
  scheduler = defaultScheduler,
  bot = defaultBot,
  db = defaultDb,
  logger = console,
  processRef = process,
} = {}) {
  void db;

  let shuttingDown = false;
  let readySent = false;

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
      logger.error('❌ Telegram bot 运行时异常:', err);
    });
  }

  async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.log(`\n[${signal}] 正在执行优雅退出程序...`);

    if (scheduler && typeof scheduler.stopAll === 'function') {
      scheduler.stopAll();
    }

    try {
      if (!bot || typeof bot.isRunning !== 'function' || bot.isRunning()) {
        await bot?.stop?.();
      }
      logger.log('✅ 机器人已安全下线');
    } catch (err) {
      logger.error('❌ 停止机器人时出错:', err);
    }

    logger.log('✅ 系统已全面退出。');
    processRef.exit?.(0);
  }

  async function bootstrap() {
    logger.log('🚀 正在初始化直播转播系统 (grammY 版)...');

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
