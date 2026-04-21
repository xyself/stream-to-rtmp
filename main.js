require('dotenv').config();
const http = require('http');
const express = require('express');

// 优先使用环境变量中的 FFmpeg，否则使用 ffmpeg-static 包中的
let ffmpegPath = process.env.FFMPEG_PATH;
if (!ffmpegPath) {
  try {
    ffmpegPath = require('ffmpeg-static');
  } catch (err) {
    // ffmpeg-static 未安装，忽略
  }
}

if (ffmpegPath) {
  const FFmpeg = require('fluent-ffmpeg');
  FFmpeg.setFfmpegPath(ffmpegPath);
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
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <title>流量监控</title>
          <style>
            body { font-family: monospace; margin: 20px; background: #000; color: #0f0; }
            #flow { font-size: 20px; font-weight: bold; }
          </style>
        </head>
        <body>
          <h1>📊 实时流量</h1>
          <div id="flow">加载中...</div>
          <p style="color: #888; font-size: 12px;">每小时刷新一次</p>
          <script>
            async function update() {
              try {
                const res = await fetch('/api/flow');
                const data = await res.json();
                document.getElementById('flow').innerHTML = \`转播中: \${data.active} | 今日: \${data.today}\`;
              } catch (e) {
                document.getElementById('flow').innerHTML = '获取数据失败';
              }
            }
            update();
            setInterval(update, 3600000);
          </script>
        </body>
        </html>
      `);
    });

    // 3. 流量监控数据 API
    app.get('/api/flow', (req, res) => {
      const active = (typeof scheduler.getRunning === 'function') ? scheduler.getRunning().length : 0;
      res.json({ active, today: 0 });
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