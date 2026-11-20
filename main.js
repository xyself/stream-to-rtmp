require('dotenv').config({ quiet: true });

// 静默 Node.js 内置 node:sqlite 的 ExperimentalWarning（其余警告照常输出）
const _origEmitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
  const msg = typeof warning === 'string' ? warning : warning?.message || '';
  const type = typeof args[0] === 'string' ? args[0] : args[0]?.type || warning?.name || '';
  if (type === 'ExperimentalWarning' && /sqlite/i.test(msg)) return;
  return _origEmitWarning(warning, ...args);
};

const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const config = require('./src/config');
const ringLogger = require('./src/core/logger');
const { getMemoryStats, getDiskUsePct, getDiskStats, getSystemCpuPct } = require('./src/core/housekeeping');
const curveChart = require('./src/core/curve-chart');
const { restoreOnce } = require('./src/init/restore');
const defaultDb = require('./src/db');
const defaultScheduler = require('./src/core/scheduler');
const gistSync = require('./src/db/gist-sync');

const EXIT_MISSING_FFMPEG = 42;

function getDefaultBot() {
  if (!process.env.TG_TOKEN?.trim()) {
    return {
      isConfigured: false,
      isRunning: () => false,
      parseAllowedChatId: () => null,
      handleManagerNotification: () => {},
      start: async () => {},
      stop: async () => {},
    };
  }
  return require('./src/bot');
}

function createApp({
  scheduler = defaultScheduler,
  bot = getDefaultBot(),
  db = defaultDb,
  logger = console,
  processRef = process,
} = {}) {
  let shuttingDown = false;
  let server = null;

  function installBotErrorLogging() {
    if (typeof bot?.catch !== 'function') return;
    bot.catch((err) => {
      logger.error('❌ Telegram bot 运行时异常:', err.message ?? err);
    });
  }

  async function gracefulShutdown(signal, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.log(`\n[${signal}] 正在执行优雅退出程序...`);

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

    try {
      await gistSync.uploadRooms(db);
      if (typeof db.close === 'function') db.close();
    } catch (err) {
      logger.error('❌ Gist 备份失败:', err.message);
    }

    logger.log('✅ 系统已全面退出。');
    setTimeout(() => processRef.exit?.(exitCode), 1500).unref();
  }

  function startServer({ port: portOverride, host: hostOverride } = {}) {
    const rawPort = String(process.env.PORT ?? '').trim();
    const disableWeb =
      portOverride === undefined &&
      (process.env.DISABLE_WEB === '1' ||
        rawPort === '0' ||
        rawPort.toLowerCase() === 'off' ||
        rawPort.toLowerCase() === 'false' ||
        (rawPort === '' && config.server.disableWeb));

    if (disableWeb) {
      logger.log('ℹ️ Web 面板已禁用（DISABLE_WEB=1 或 PORT=0），仅运行任务调度器与 Telegram 机器人');
      return null;
    }

    const port = portOverride !== undefined ? portOverride : parseInt(rawPort, 10) || config.server.port;
    const bindHost = hostOverride || process.env.BIND_HOST || config.server.bindHost;
    const dashboardToken = process.env.DASHBOARD_TOKEN || config.server.dashboardToken;
    const ffmpegInstaller = require('./src/services/ffmpeg-installer');

    function isAuthorized(req, urlObj) {
      if (!dashboardToken) return true;
      const header = String(req.headers.authorization || '');
      const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      const provided = bearer || String(urlObj.searchParams.get('token') || '');
      const a = Buffer.from(provided);
      const b = Buffer.from(dashboardToken);
      return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
    }

    const rateBuckets = new Map();
    const limitPerMin = config.server.apiRateLimitPerMin;
    function isRateLimited(req) {
      const ip = String(req.socket?.remoteAddress || 'unknown');
      const now = Date.now();
      let bucket = rateBuckets.get(ip);
      if (!bucket || now - bucket.start > 60000) {
        bucket = { start: now, count: 0 };
        rateBuckets.set(ip, bucket);
      }
      bucket.count += 1;
      return bucket.count > limitPerMin;
    }
    setInterval(() => {
      const now = Date.now();
      for (const [ip, bucket] of rateBuckets) {
        if (now - bucket.start > 120000) rateBuckets.delete(ip);
      }
    }, 120000).unref();

    function sendJson(res, status, payload) {
      const body = JSON.stringify(payload);
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(body);
    }

    function sendHtml(res, status, html) {
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(html);
    }

    server = http.createServer(async (req, res) => {
      try {
        const method = req.method || 'GET';
        const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
        const pathname = urlObj.pathname;

        if (pathname.startsWith('/api/') && isRateLimited(req)) {
          return sendJson(res, 429, { error: 'too many requests' });
        }

        if ((method === 'GET' || method === 'HEAD') && pathname === '/health') {
          const ffInfo = ffmpegInstaller.getFfmpegRuntimeInfo();
          return sendJson(res, 200, {
            status: 'ok',
            runtimeEnv: config.runtime?.kind || process.platform,
            uptime: process.uptime(),
            nodeVersion: process.version,
            ffmpegVersion: ffInfo.version || ffmpegVersion,
            ffmpegPath: ffInfo.resolvedPath,
            ffmpegCustomBinary: ffInfo.isCustomBinary,
          });
        }

        if ((method === 'GET' || method === 'HEAD') && pathname === '/healthz') {
          if (!isAuthorized(req, urlObj)) return sendJson(res, 401, { error: 'unauthorized' });
          const stats = typeof scheduler.getStats === 'function' ? scheduler.getStats() : {};
          const activeStreams = stats.activeStreams || 0;
          const totalMonitoring = stats.totalMonitoring || 0;
          const ffInfo = ffmpegInstaller.getFfmpegRuntimeInfo();
          const schedulerHealthy = scheduler._stopped !== true;
          const healthy = Boolean(ffInfo.ok && schedulerHealthy);
          return sendJson(res, healthy ? 200 : 503, {
            status: healthy ? 'ok' : 'degraded',
            runtimeEnv: config.runtime?.kind || process.platform,
            uptime: process.uptime(),
            nodeVersion: process.version,
            ffmpegVersion: ffInfo.version || ffmpegVersion,
            ffmpegPath: ffInfo.resolvedPath,
            ffmpegSource: ffInfo.sourceLabel,
            ffmpegCustomBinary: ffInfo.isCustomBinary,
            activeStreams,
            totalMonitoring,
            enabledTasks: stats.enabledTasks || 0,
          });
        }

        if ((method === 'GET' || method === 'HEAD') && pathname === '/') {
          // GET / 仅返回不含任何业务数据的静态页面壳子；数据接口受 DASHBOARD_TOKEN 严格鉴权，确保前端登录门禁可正常展示
          const { renderDashboard } = require('./src/web/dashboard');
          return sendHtml(res, 200, renderDashboard());
        }

        if (method === 'GET' && pathname === '/api/flow') {
          if (!isAuthorized(req, urlObj)) return sendJson(res, 401, { error: 'unauthorized' });
          const stats = typeof scheduler.getStats === 'function' ? scheduler.getStats() : { runningManagers: 0 };
          const trafficStats = typeof scheduler.getTrafficStats === 'function' ? scheduler.getTrafficStats() : [];

          const totalBitrate = trafficStats.reduce((sum, task) => sum + (task.traffic?.bitrateKbps || 0), 0);
          const totalSessionBytes = trafficStats.reduce((sum, task) => sum + (task.traffic?.sessionBytes || 0), 0);
          const ffInfo = ffmpegInstaller.getFfmpegRuntimeInfo();
          const mem = process.memoryUsage();
          const memStats = getMemoryStats();
          const diskStats = getDiskStats();
          const diskPct = diskStats ? diskStats.usePct : getDiskUsePct();
          const cpuPct = getSystemCpuPct();

          return sendJson(res, 200, {
            active: stats.activeStreams || 0,
            totalMonitoring: stats.totalMonitoring || 0,
            enabledTasks: stats.enabledTasks || 0,
            totalTasks: stats.totalTasks ?? trafficStats.length,
            totalTargets: stats.totalTargets || 0,
            totalBitrate: Math.round(totalBitrate),
            totalSessionBytes,
            uptimeSeconds: Math.floor(process.uptime()),
            serviceMemBytes: mem.rss,
            serviceHeapUsedBytes: mem.heapUsed,
            memory: {
              ...memStats,
              alertMb: config.housekeeping?.memAlertMb || 0,
              criticalMb: config.housekeeping?.criticalMemMb || 0,
            },
            disk: diskStats,
            diskPct,
            diskAlertPct: config.housekeeping?.diskAlertPct || 85,
            cpuPct,
            processes: memStats.processes || null,
            runtimeEnv: config.runtime?.kind || process.platform,
            nodeVersion: process.version,
            ffmpegVersion: ffInfo.version || ffmpegVersion,
            ffmpegPath: ffInfo.resolvedPath,
            ffmpegConfiguredBin: ffInfo.binPath,
            ffmpegSource: ffInfo.sourceLabel,
            ffmpegSourceType: ffInfo.sourceType,
            ffmpegCustomBinary: ffInfo.isCustomBinary,
            ffmpegBanner: ffInfo.rawFirstLine,
            transcodeVideo: db.getSetting?.('transcode_video') === '1',
            transcodeAudio: db.getSetting?.('transcode_audio') === '1',
            gitVersion: require('./src/services/updater').getCurrentVersion().sha,
            generatedAt: new Date().toISOString(),

            // 隐私白名单：只暴露运营指标，不返回房间号 / 主播名 / 标题
            tasks: trafficStats.map((task) => ({
              platform: task.platform,
              status: task.status,
              running: Boolean(task.traffic?.running),
              bitrateKbps: task.traffic?.bitrateKbps || 0,
              sessionBytes: task.traffic?.sessionBytes || 0,
              totalBytes: task.traffic?.totalBytes || 0,
              errorCount: task.traffic?.errorCount || 0,
              lastSuccessAt: task.traffic?.lastSuccessAt,
              startedAt: task.traffic?.startedAt,
            })),
          });
        }

        if (method === 'GET' && pathname === '/api/system/check-update') {
          if (!isAuthorized(req, urlObj)) return sendJson(res, 401, { error: 'unauthorized' });
          const updater = require('./src/services/updater');
          const result = await updater.checkUpdate();
          return sendJson(res, 200, result);
        }

        if (method === 'POST' && pathname === '/api/system/apply-update') {
          if (!isAuthorized(req, urlObj)) return sendJson(res, 401, { error: 'unauthorized' });
          const updater = require('./src/services/updater');
          try {
            const result = await updater.applyUpdate();
            sendJson(res, 200, { ok: true, result });
            setTimeout(() => gracefulShutdown('WEB_REMOTE_UPDATE', 100), 1000).unref();
            return;
          } catch (err) {
            return sendJson(res, 500, { ok: false, error: err.message });
          }
        }

        if (method === 'GET' && pathname === '/api/curve') {
          if (!isAuthorized(req, urlObj)) return sendJson(res, 401, { error: 'unauthorized' });
          const modeParam = String(urlObj.searchParams.get('mode') || 'noon').toLowerCase();
          const mode = modeParam === 'midnight' || modeParam === 'day' ? 'midnight' : 'noon';
          const nowMs = Date.now();
          const windowInfo = curveChart.get24HourWindow(mode, nowMs);
          const rawSamples =
            typeof db.getAllBitrateSamples === 'function'
              ? db.getAllBitrateSamples(windowInfo.startMs, windowInfo.endMs)
              : [];

          // 将多路任务按分钟聚合成总输出码率（保留 0 值断播边界）
          const perMinByTask = new Map();
          for (const row of rawSamples) {
            const minuteTs = Math.floor(Number(row.ts || 0) / 60000) * 60000;
            if (!perMinByTask.has(minuteTs)) perMinByTask.set(minuteTs, new Map());
            perMinByTask.get(minuteTs).set(row.task_id, Math.max(0, Number(row.kbps) || 0));
          }
          const aggregatedSamples = [...perMinByTask.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([ts, taskMap]) => {
              let sumKbps = 0;
              for (const v of taskMap.values()) sumKbps += v;
              return { ts, kbps: Math.round(sumKbps) };
            });

          const bucketCount = 144; // 每 10 分钟一格
          const { buckets, sessions } = curveChart.buildWaveSeries(
            aggregatedSamples,
            windowInfo.startMs,
            windowInfo.endMs,
            bucketCount
          );
          const nonZero = buckets.filter((v) => v > 0);
          const peakKbps = nonZero.length > 0 ? Math.max(...nonZero) : 0;
          const avgKbps = nonZero.length > 0 ? Math.round(nonZero.reduce((a, b) => a + b, 0) / nonZero.length) : 0;
          const totalLiveMinutes = sessions.reduce((sum, s) => sum + (s.durationMin || 0), 0);

          return sendJson(res, 200, {
            mode,
            window: windowInfo,
            nowMs,
            bucketCount,
            buckets,
            peakKbps,
            avgKbps,
            totalLiveMinutes,
            sampleCount: aggregatedSamples.length,
            sessions: sessions.map((s) => ({
              index: s.index,
              startMs: s.startMs,
              endMs: s.endMs,
              startTimeStr: s.startTimeStr,
              endTimeStr: s.endTimeStr,
              durationMin: s.durationMin,
              avgKbps: s.avgKbps,
              peakKbps: s.peakKbps,
              estimatedBytes: s.estimatedBytes,
            })),
          });
        }

        if (method === 'GET' && pathname === '/api/logs') {
          if (!isAuthorized(req, urlObj)) return sendJson(res, 401, { error: 'unauthorized' });
          const onlyErrors = urlObj.searchParams.get('onlyErrors') === '1';
          const rawLimit = Number.parseInt(urlObj.searchParams.get('limit') || '50', 10);
          const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(5, rawLimit)) : 50;
          const lines = ringLogger
            .queryLines({ onlyErrors, limit })
            .map((line) => ringLogger.sanitizeLogForPublic(line));
          return sendJson(res, 200, {
            onlyErrors,
            count: lines.length,
            lines,
            generatedAt: new Date().toISOString(),
          });
        }

        if (method === 'POST' && pathname === '/api/ffmpeg/probe') {
          if (!isAuthorized(req, urlObj)) return sendJson(res, 401, { error: 'unauthorized' });
          const ffInfo = ffmpegInstaller.getFfmpegRuntimeInfo({ forceRefresh: true });
          if (ffInfo.ok && ffInfo.version) {
            ffmpegVersion = ffInfo.version;
          }
          return sendJson(res, 200, ffInfo);
        }

        if (method === 'POST' && pathname === '/api/ffmpeg/upgrade') {
          if (!isAuthorized(req, urlObj)) return sendJson(res, 401, { error: 'unauthorized' });
          try {
            await ffmpegInstaller.downloadLatestFfmpeg({ logger });
            const ffInfo = ffmpegInstaller.getFfmpegRuntimeInfo({ forceRefresh: true });
            if (ffInfo.ok && ffInfo.version) {
              ffmpegVersion = ffInfo.version;
            }
            return sendJson(res, 200, { ok: true, ffmpeg: ffInfo });
          } catch (err) {
            return sendJson(res, 500, { ok: false, error: err.message });
          }
        }

        return sendJson(res, 404, { error: 'not found' });
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { error: err.message || 'internal error' });
        }
      }
    });

    server.listen(port, bindHost, () => {
      logger.log(`🌐 Web 面板及健康检查服务已启动，监听: ${bindHost}:${port}`);
      if (!dashboardToken) {
        logger.log('⚠️ 未配置 DASHBOARD_TOKEN，面板无鉴权（仅建议受信任环境访问）');
      } else if (dashboardToken.length < 16) {
        logger.log('⚠️ DASHBOARD_TOKEN 过短（<16 位），建议换成更长的随机字符串');
      }
    });

    server.on('error', (err) => {
      if (err?.code === 'EACCES' || err?.code === 'EADDRINUSE') {
        logger.error(
          `⚠️ Web 面板端口 ${bindHost}:${port} 无法绑定 (${err.code})；` +
            'Serv00 请先执行 devil port add tcp random 申请专属端口并写入 .env 的 PORT，或设置 DISABLE_WEB=1 仅运行 Telegram 机器人'
        );
      } else {
        logger.error(`⚠️ Web 面板服务异常: ${err.message}`);
      }
    });

    return server;
  }

  let ffmpegVersion = 'unknown';

  async function bootstrap() {
    const ffmpegInstaller = require('./src/services/ffmpeg-installer');
    const hasLocalBin = fs.existsSync(ffmpegInstaller.LOCAL_FFMPEG_BIN);

    // 默认开启首次部署自动拉取最新静态版到 ./bin/ffmpeg（避开宿主机老旧版本）
    // 如需禁用自动拉取可在 .env 设置 AUTO_DOWNLOAD_FFMPEG=0
    const autoDownloadEnabled =
      !process.env.FFMPEG_PATH &&
      process.env.AUTO_DOWNLOAD_FFMPEG !== '0' &&
      process.env.NODE_ENV !== 'test';

    if (!hasLocalBin && autoDownloadEnabled && ffmpegInstaller.getStaticDownloadCandidates().length > 0) {
      logger.log('🚀 首次部署检测：正在自动拉取最新静态版 FFmpeg 到 ./bin/ffmpeg（避免使用系统老旧版本）...');
      try {
        await ffmpegInstaller.downloadLatestFfmpeg({ logger });
      } catch (dlErr) {
        logger.warn(`⚠️ 自动拉取最新静态版 FFmpeg 未成功 (${dlErr.message})，将回退使用系统内置 FFmpeg`);
      }
    }

    const explicitFfmpegPath = process.env.FFMPEG_PATH;
    const probeRes =
      typeof ffmpegInstaller.findWorkingFfmpegBin === 'function'
        ? ffmpegInstaller.findWorkingFfmpegBin({
            explicitEnvPath: explicitFfmpegPath,
            checkNetwork: process.env.NODE_ENV !== 'test',
          })
        : ffmpegInstaller.probeFfmpegBinary(explicitFfmpegPath || config.ffmpeg.bin);

    if (!probeRes.ok) {
      logger.error(
        `❌ FFmpeg 不可用 (${probeRes.binPath || explicitFfmpegPath || config.ffmpeg.bin}): ${probeRes.error || '未找到可执行文件'}，请安装 FFmpeg、运行 npm run update-ffmpeg 或设置 FFMPEG_PATH 后重试`
      );
      processRef.exit?.(EXIT_MISSING_FFMPEG);
      return;
    }

    // 若因跨平台拷贝导致 ./bin/ffmpeg 不可用而回退到了系统 FFmpeg，将工作路径写入环境变量，确保 FFmpegService 后续子进程一致使用可用版本
    const resolvedDefault = ffmpegInstaller.resolveFfmpegBin(explicitFfmpegPath);
    if (!explicitFfmpegPath && probeRes.binPath && probeRes.binPath !== resolvedDefault) {
      logger.warn(`⚠️ 默认路径 ${resolvedDefault} 在当前系统不兼容，已自动回退至可用 FFmpeg: ${probeRes.binPath}`);
      process.env.FFMPEG_PATH = probeRes.binPath;
    }

    ffmpegVersion = probeRes.version || 'unknown';
    logger.log(
      `🎬 FFmpeg 就绪: ${ffmpegVersion} (${probeRes.binPath}) | 运行环境: ${config.runtime?.kind || process.platform}`
    );

    await restoreOnce();

    logger.log('🚀 正在初始化直播转播系统 (grammY 版)...');

    const allowedChatIds = bot.parseAllowedChatId?.();
    const hasBotToken = bot.isConfigured !== false && Boolean(process.env.TG_TOKEN?.trim());
    const botReady = hasBotToken && Boolean(allowedChatIds && allowedChatIds.size > 0);
    if (!botReady) {
      logger.warn('⚠️ 未配置 TG_TOKEN 或 TG_CHAT_ID：Telegram 机器人暂不启动，仅运行 Web 监控面板与任务调度器');
    }

    startServer();

    try {
      logger.log('📦 数据库服务：就绪');

      if (typeof scheduler.setOnNotify === 'function') {
        scheduler.setOnNotify((notification) => {
          if (typeof bot?.handleManagerNotification === 'function') {
            bot.handleManagerNotification(notification);
          }
        });
      }

      scheduler.start();
      logger.log('⚙️ 任务调度器：已启动');

      try {
        require('./src/core/housekeeping').startHousekeeping({
          scheduler,
          bot,
          onRestart: () => gracefulShutdown('NIGHTLY_RESTART', 100),
        });
        logger.log('🧹 后台杂务（每日小结/资源水位/自动维护）：已启动');
      } catch (err) {
        logger.error('后台杂务启动失败:', err.message);
      }

      if (typeof bot?.setShutdownHandler === 'function') {
        bot.setShutdownHandler((exitCode = 100) => gracefulShutdown('REMOTE_UPDATE', exitCode));
      }

      if (gistSync.isConfigured()) {
        gistSync.seedContentCache(db);
      }
      let uploadTimer = null;
      let pendingRoomChange = false;
      db.onWrite = (reason) => {
        if (reason === 'room') pendingRoomChange = true;
        clearTimeout(uploadTimer);
        uploadTimer = setTimeout(async () => {
          const shouldPushTgBackup = pendingRoomChange;
          pendingRoomChange = false;
          if (gistSync.isConfigured()) {
            try {
              await gistSync.uploadRooms(db);
            } catch (err) {
              logger.error('Gist 上传失败:', err.message);
            }
          }
          if (shouldPushTgBackup && typeof bot?.sendAutoBackupToChat === 'function') {
            try {
              await bot.sendAutoBackupToChat(db);
            } catch (err) {
              logger.error('Telegram 自动备份推送失败:', err.message);
            }
          }
        }, 30000);
        uploadTimer.unref?.();
      };

      processRef.on?.('SIGTERM', () => gracefulShutdown('SIGTERM'));
      processRef.on?.('SIGINT', () => gracefulShutdown('SIGINT'));

      if (botReady) {
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

            try {
              const updater = require('./src/services/updater');
              const updateState = updater.consumeUpdateState();
              if (updateState && updateState.notifyChatId && chatIds?.has(String(updateState.notifyChatId))) {
                const fromSha = updateState.fromSha || '旧版本';
                const toSha = updateState.toSha || '最新版';
                const updateMsg = [
                  '🎉 <b>系统远程一键更新成功！</b>',
                  '',
                  `📦 <b>版本跃迁</b>：<code>${fromSha}</code> ➔ <code>${toSha}</code>`,
                  `⚙️ <b>运行时</b>：Node <code>${process.version}</code>`,
                  `🟢 <b>状态</b>：服务与推流监控已全部恢复。`,
                ].join('\n');
                await bot.api.sendMessage(updateState.notifyChatId, updateMsg, { parse_mode: 'HTML' }).catch(() => {});
              }
            } catch (uErr) {
              logger.error('检查更新恢复状态异常:', uErr.message);
            }
          },
        });
        logger.log('ℹ️ bot.start() 已退出');
      } else {
        logger.log('ℹ️ 系统已就绪（Web 面板运行中；配置 TG_TOKEN 与 TG_CHAT_ID 后可启用 Telegram 控制中心）');
      }
    } catch (err) {
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
    startServer,
    gracefulShutdown,
  };
}

process.on('unhandledRejection', (reason) => {
  console.error('⚠️ 监测到未处理的异步异常:', reason);
});

module.exports = { createApp };

if (require.main === module) {
  ringLogger.installConsoleCapture();
  const app = createApp();
  app.bootstrap();
}