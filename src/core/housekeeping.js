// 后台杂务：每日推流小结、内存/磁盘水位告警
// serv00 免费档只有 512MB 内存 / 3GB 磁盘，水位超了第一时间 TG 吱一声
const { exec } = require('child_process');
const db = require('../db');

const DIGEST_HOUR_CST = 8; // 北京时间每天 8 点推送小结
const MEM_ALERT_MB = 400;  // 内存水位线（serv00 免费档 512MB）
const DISK_ALERT_PCT = 85; // 磁盘水位线
const RESOURCE_ALERT_COOLDOWN = 3600000; // 资源告警 1 小时内只发一次

function cstNow() {
  return new Date(Date.now() + 8 * 3600 * 1000);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function platformLabel(p) {
  return { bilibili: 'B站', douyu: '斗鱼', douyin: '抖音' }[p] || p;
}

async function sendDailyDigest(scheduler, bot) {
  // 用户在通知管理里关掉小结就跳过
  try {
    if (db.getSetting('notify_digest') === '0') return;
  } catch (err) { /* 读不到配置就默认发 */ }
  const stats = scheduler.getDigestStats();
  const d = cstNow();
  const dateStr = `${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
  const lines = [`📊 每日推流小结（${dateStr}）`];
  if (stats.length === 0) {
    lines.push('暂无启用中的任务');
  }
  for (const s of stats) {
    const status = s.running ? '🟢 推流中' : '⚪ 空闲';
    lines.push(
      `🖥️ ${platformLabel(s.platform)} #${s.roomId}：` +
      `推流 ${s.liveMinutes} 分钟，断流 ${s.drops} 次，流量 ${formatBytes(s.bytes)}，${status}`
    );
  }
  const text = lines.join('\n');
  const chatIds = bot.parseAllowedChatId?.();
  if (chatIds) {
    for (const id of chatIds) {
      try {
        await bot.api.sendMessage(id, text);
      } catch (err) {
        console.error('每日小结发送失败:', err.message);
      }
    }
  }
  scheduler.resetDigestStats();
}

// 当前 node + ffmpeg 进程总内存（MB）；拿不到返回 null
function getTotalMemMB() {
  return new Promise((resolve) => {
    exec('ps aux', { timeout: 10000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      let totalKB = 0;
      for (const line of stdout.split('\n')) {
        if (!/node main\.js|ffmpeg/.test(line)) continue;
        const parts = line.trim().split(/\s+/);
        const rss = parseInt(parts[5], 10); // ps aux 第 6 列是 RSS（KB）
        if (Number.isFinite(rss)) totalKB += rss;
      }
      resolve(Math.round(totalKB / 1024));
    });
  });
}

// 当前目录所在磁盘使用率（%）；拿不到返回 null
function getDiskUsePct() {
  return new Promise((resolve) => {
    exec('df -k .', { timeout: 10000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const m = stdout.split('\n')[1]?.match(/\s(\d+)%(?:\s|$)/);
      resolve(m ? parseInt(m[1], 10) : null);
    });
  });
}

let lastResourceAlertAt = 0;

async function checkResources(bot) {
  // 定期被动清理 SQLite WAL 映射，释放共享内存页面
  try {
    db.checkpoint?.('PASSIVE');
  } catch {}

  // 主动尝试触发 V8 垃圾回收，将长期运行碎片归还系统
  if (typeof global.gc === 'function') {
    try {
      global.gc();
    } catch {}
  }

  const problems = [];
  const memMB = await getTotalMemMB();
  if (memMB !== null && memMB >= MEM_ALERT_MB) {
    problems.push(`内存 ${memMB}MB（水位 ${MEM_ALERT_MB}MB）`);
  }
  const diskPct = await getDiskUsePct();
  if (diskPct !== null && diskPct >= DISK_ALERT_PCT) {
    problems.push(`磁盘 ${diskPct}%（水位 ${DISK_ALERT_PCT}%）`);
  }
  if (problems.length === 0) return;
  if (Date.now() - lastResourceAlertAt < RESOURCE_ALERT_COOLDOWN) return;
  lastResourceAlertAt = Date.now();
  console.error(`[housekeeping] 资源水位告警: ${problems.join('，')}`);
  try {
    bot.handleManagerNotification?.({
      type: 'resource',
      message: `资源水位偏高：${problems.join('，')}，请检查是否需要减路数或清磁盘`,
    });
  } catch (err) {
    console.error('资源告警发送失败:', err.message);
  }
}

function startHousekeeping({ scheduler, bot, onRestart }) {
  let lastDigestDate = null;
  let nextRestartTime = null;
  let postponeCount = 0;
  let isRestarting = false;

  async function sendAll(text) {
    const chatIds = bot.parseAllowedChatId?.();
    if (!chatIds) return;
    for (const id of chatIds) {
      try {
        await bot.api.sendMessage(id, text, { parse_mode: 'HTML' });
      } catch (err) {
        console.error('定时通知发送失败:', err.message);
      }
    }
  }

  function getBaseRestartHour() {
    const hStr = db.getSetting('daily_restart_hour') || db.getSetting('nightly_restart_hour') || '10';
    const h = parseInt(hStr, 10);
    return Number.isFinite(h) && h >= 0 && h < 24 ? h : 10;
  }

  function calculateNextTargetTime(afterMs = Date.now()) {
    const baseHour = getBaseRestartHour();
    const cst = new Date(afterMs + 8 * 3600 * 1000);
    const todayStr = `${cst.getUTCFullYear()}-${cst.getUTCMonth() + 1}-${cst.getUTCDate()}`;
    const targetCst = new Date(Date.UTC(cst.getUTCFullYear(), cst.getUTCMonth(), cst.getUTCDate(), baseHour, 0, 0, 0));
    let targetUtcMs = targetCst.getTime() - 8 * 3600 * 1000;

    let lastRestartDate = null;
    try {
      lastRestartDate = db.getSetting('last_daily_restart_date');
    } catch {}

    // 如果今天已经重启过，或者今天目标时间已过去超过 5 分钟，则排到明天同一时间
    if (lastRestartDate === todayStr || targetUtcMs <= afterMs - 5 * 60 * 1000) {
      targetUtcMs += 24 * 3600 * 1000;
    }
    return targetUtcMs;
  }

  // #14 每日定时自动维护（重启 Node / 推流，彻底释放内存；serv00 只有 512MB）
  // 机制：默认每天早上 10 点，若检测到正在推流则自动顺延 1 小时，直至空闲或极端内存熔断
  async function dailyMaintenanceRestart() {
    if (isRestarting) return;
    try {
      if (db.getSetting('daily_restart') === '0' || db.getSetting('nightly_restart') === '0') return; // 用户关掉就跳过
    } catch (err) { /* 读不到配置就默认执行 */ }

    const now = Date.now();
    if (!nextRestartTime) {
      nextRestartTime = calculateNextTargetTime(now);
    }

    if (now < nextRestartTime) return;

    const managers = [...(scheduler.runningManagers?.values() || [])]
      .filter((m) => m.ffmpeg?.getTrafficStats().running);
    const isStreaming = managers.length > 0;
    const enablePostpone = db.getSetting('daily_restart_postpone') !== '0';

    // 极端内存水位兜底：若 Node 内存逼近 serv00 512MB 上限（>= 430MB），再不重启将被系统 OOM 强杀
    let memMB = null;
    try {
      memMB = await getTotalMemMB();
    } catch {}
    const isCriticalMem = memMB !== null && memMB >= 430;

    // 正在推流且非极端内存危机：顺延 1 小时
    if (isStreaming && enablePostpone && !isCriticalMem) {
      postponeCount += 1;
      nextRestartTime = now + 3600 * 1000; // 顺延 1 小时
      const nextCst = new Date(nextRestartTime + 8 * 3600 * 1000);
      const nextHourStr = `${String(nextCst.getUTCHours()).padStart(2, '0')}:${String(nextCst.getUTCMinutes()).padStart(2, '0')}`;
      console.log(`[housekeeping] 当前 ${managers.length} 路正在推流，每日维护重启顺延至 ${nextHourStr} (已累计顺延 ${postponeCount} 次)`);

      // 顺延提醒：第 1 次顺延及后续每顺延 3 次时通知一次，避免频繁骚扰
      if (postponeCount === 1 || postponeCount % 3 === 0) {
        await sendAll(`⏳ <b>系统维护延后通知</b>\n检测到当前有 ${managers.length} 路直播正在推流，为保障直播不中断，每日维护重启自动顺延 1 小时至上海时间 <b>${nextHourStr}</b> 再次检查（累计顺延 ${postponeCount} 次）。`).catch(() => {});
      }
      return;
    }

    // 允许重启（完全空闲或触发紧急内存熔断）
    isRestarting = true;
    const streamDesc = isStreaming ? `（当前 ${managers.length} 路推流一并重置）` : '（当前无推流，静默重置）';
    const cst = new Date(now + 8 * 3600 * 1000);
    const todayStr = `${cst.getUTCFullYear()}-${cst.getUTCMonth() + 1}-${cst.getUTCDate()}`;

    try {
      db.setSetting('last_daily_restart_date', todayStr);
    } catch {}

    postponeCount = 0;
    nextRestartTime = calculateNextTargetTime(now + 24 * 3600 * 1000 - 10 * 60 * 1000);

    await sendAll(`🔄 <b>系统每日维护重启</b>\n系统正在执行滚动重启以彻底重置内存${streamDesc}，预计 3~5 秒内自动拉起恢复…`);

    // 重启前截断清理 SQLite WAL 映射
    try {
      db.checkpoint?.('TRUNCATE');
    } catch {}

    // 留出 2 秒让 Telegram 通知网络请求发完
    await new Promise((resolve) => setTimeout(resolve, 2000));

    if (typeof onRestart === 'function') {
      onRestart();
      return;
    }

    // 兜底：如果未传入 onRestart，逐个重启推流
    let done = 0;
    for (const m of managers) {
      try {
        await scheduler.refreshTask?.(m.task);
        done += 1;
      } catch (err) {
        console.error(`[housekeeping] 维护重启 ${m.task?.room_id} 失败:`, err.message);
      }
      // 逐个重启、间隔 30 秒错峰，避免同时重连打爆平台接口
      await new Promise((resolve) => setTimeout(resolve, 30000));
    }
    await sendAll(`✅ 每日自动维护完成：${done}/${managers.length} 路推流已重启`);
    isRestarting = false;
  }

  // 每分钟检查一次：到点发小结 / 检查每日维护重启
  setInterval(() => {
    try {
      const d = cstNow();
      const today = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
      if (d.getUTCHours() === DIGEST_HOUR_CST && d.getUTCMinutes() < 5 && lastDigestDate !== today) {
        lastDigestDate = today;
        sendDailyDigest(scheduler, bot).catch((err) => console.error('每日小结失败:', err.message));
      }
      dailyMaintenanceRestart().catch((err) => console.error('每日维护重启检查失败:', err.message));
    } catch (err) {
      console.error('定时器异常:', err.message);
    }
  }, 60000);

  // 每 5 分钟检查一次资源水位
  setInterval(() => {
    checkResources(bot).catch((err) => console.error('资源检查异常:', err.message));
  }, 5 * 60000);
  // 启动 30 秒后先查一次
  setTimeout(() => checkResources(bot).catch(() => {}), 30000);

  // Bot API 10.4：每 60 秒向所有打开的 Widget 推送最新数据
  if (typeof bot._pushWidgetUpdate === 'function') {
    setInterval(() => {
      const widgetMsgs = bot._widgetMessages || {};
      for (const chatId of Object.keys(widgetMsgs)) {
        bot._pushWidgetUpdate(chatId).catch(() => {});
      }
    }, 60000);
  }
}

module.exports = { startHousekeeping };
