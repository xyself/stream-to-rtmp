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
const { spawnSync } = require('child_process');

// 看门脚本约定的特殊退出码：42 = 环境缺失（FFmpeg 不可用），看门遇到 42 不再重启
const EXIT_MISSING_FFMPEG = 42;



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



    // 等待所有推流任务真正退出（SIGINT -> 等待进程退出 -> 10 秒兜底）
    // stopAll 返回 Promise：等每个 FFmpeg 进程退出或超时
    if (scheduler && typeof scheduler.stopAll === 'function') {
      try {
        await Promise.race([
          scheduler.stopAll(),
          new Promise((resolve) => setTimeout(resolve, 12000)),
        ]);
      } catch (err) {
        logger.error('❌ 停止任务失败:', err.message);
      }
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
    // 兜底：5 秒后强制退出（unref 使其不阻止自然退出）
    setTimeout(() => processRef.exit?.(0), 5000).unref();

  }



  function startServer() {

    const app = express();

    // 只使用 PORT

    const port = parseInt(process.env.PORT, 10) || 8080;

    // 默认只监听本地回环；需要对外访问时显式配置 BIND_HOST=0.0.0.0
    const bindHost = process.env.BIND_HOST || '127.0.0.1';
    const dashboardToken = process.env.DASHBOARD_TOKEN || '';

    // 对外监听但没配 token：直接拒绝启动（避免面板裸奔）
    const isLocalBind = bindHost === '127.0.0.1' || bindHost === 'localhost' || bindHost === '::1';
    if (!isLocalBind && !dashboardToken) {
      logger.error('❌ BIND_HOST 对外开放但未配置 DASHBOARD_TOKEN：为安全起见拒绝启动，请配置 DASHBOARD_TOKEN 或改回 127.0.0.1');
      processRef.exit?.(1);
      return;
    }

    // 面板鉴权：配置了 DASHBOARD_TOKEN 后，数据 API 需要 Authorization: Bearer <token> 请求头
    // （面板页面本身仍可用 ?token=xxx 打开：浏览器直接访问页面时无法自定义请求头）
    function checkDashboardAuth(req, res, next) {
      if (!dashboardToken) return next();
      const header = String(req.headers.authorization || '');
      const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      const provided = bearer || String(req.query.token || '');
      const a = Buffer.from(provided);
      const b = Buffer.from(dashboardToken);
      if (a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
      res.status(401).json({ error: 'unauthorized' });
    }

    // 基础安全头
    app.use((req, res, next) => {
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      next();
    });

    // /api/* 简易限流：单 IP 每分钟最多 120 次，防误刷/爬虫打爆接口
    const rateBuckets = new Map();
    const apiRateLimit = (req, res, next) => {
      const ip = req.ip || req.socket?.remoteAddress || 'unknown';
      const now = Date.now();
      let bucket = rateBuckets.get(ip);
      if (!bucket || now - bucket.start > 60000) {
        bucket = { start: now, count: 0 };
        rateBuckets.set(ip, bucket);
      }
      bucket.count += 1;
      if (bucket.count > 120) return res.status(429).json({ error: 'too many requests' });
      next();
    };
    setInterval(() => {
      const now = Date.now();
      for (const [ip, bucket] of rateBuckets) {
        if (now - bucket.start > 120000) rateBuckets.delete(ip);
      }
    }, 120000).unref();
    app.use('/api/', apiRateLimit);

    // 1. 健康检查接口（容器健康检查用，保持公开）

    app.get('/health', (req, res) => {

      res.json({ status: 'ok', uptime: process.uptime() });

    });



    // 1b. 任务级健康检查（需要鉴权，给外部监控用）：
    // 有监控任务、运行超过 2 分钟、但一路推流都没有 -> 返回 503 degraded
    app.get('/healthz', checkDashboardAuth, (req, res) => {

      const stats = (typeof scheduler.getStats === 'function') ? scheduler.getStats() : {};

      const activeStreams = stats.activeStreams || 0;

      const totalMonitoring = stats.totalMonitoring || 0;

      const healthy = !(totalMonitoring > 0 && activeStreams === 0 && process.uptime() > 120);

      res.status(healthy ? 200 : 503).json({

        status: healthy ? 'ok' : 'degraded',

        uptime: process.uptime(),

        activeStreams,

        totalMonitoring,

        enabledTasks: stats.enabledTasks || 0,

      });

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

        // 隐私白名单：只暴露运营指标，不返回房间号 / 主播名 / 标题
        tasks: trafficStats.map((task) => ({

          platform: task.platform,

          status: task.status,

          bitrateKbps: task.traffic?.bitrateKbps || 0,

          sessionBytes: task.traffic?.sessionBytes || 0,

          errorCount: task.traffic?.errorCount || 0,

          lastSuccessAt: task.traffic?.lastSuccessAt,
          startedAt: task.traffic?.startedAt,
        })),

      });

    });



    server = app.listen(port, bindHost, () => {

      logger.log(`🌐 Web 面板及健康检查服务已启动，监听: ${bindHost}:${port}`);
      if (!dashboardToken) {
        logger.log('⚠️ 未配置 DASHBOARD_TOKEN，面板无鉴权（仅建议本机访问）');
      } else if (dashboardToken.length < 16) {
        logger.log('⚠️ DASHBOARD_TOKEN 过短（<16 位），建议换成更长的随机字符串');
      }

    });

  }



  async function bootstrap() {

    // 启动资源守门：FFmpeg 必须可用，否则看门会无限重启一个起不来的进程
    const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
    try {
      const probe = spawnSync(ffmpegPath, ['-version'], { timeout: 10000 });
      if (probe.status !== 0 || probe.error) {
        throw new Error(probe.error?.message || `退出码 ${probe.status}`);
      }
    } catch (err) {
      logger.error(`❌ FFmpeg 不可用 (${ffmpegPath}): ${err.message}，请安装 FFmpeg 或设置 FFMPEG_PATH 后重试`);
      processRef.exit?.(EXIT_MISSING_FFMPEG);
      return;
    }

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

      // 409：有另一个实例在用同一个 bot token 轮询（幽灵进程），给中文提示
      const isConflict409 = err?.error_code === 409 || /409|Conflict/i.test(String(err?.description || err?.message || ''));
      if (isConflict409) {
        logger.error('❌ Telegram 409 冲突：检测到另一个实例正在用同一个 bot token 运行（幽灵进程）。');
        logger.error('   请先杀掉旧进程再启动：pkill -f "node main.js"（注意确认是本应用的进程）');
      } else {
        logger.error('❌ 系统启动过程中发生致命错误:', err);
      }

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