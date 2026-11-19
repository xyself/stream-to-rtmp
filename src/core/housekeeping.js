const fs = require('node:fs');
const os = require('node:os');
const config = require('../config');
const db = require('../db');
const views = require('../bot/views');
const { getCgroupMemoryStats, getRuntimeProfile } = require('./runtime-env');

function getZonedDateParts(ms = Date.now(), timeZone = config.timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(ms)
      .reduce((acc, part) => {
        acc[part.type] = part.value;
        return acc;
      }, {});
    const year = Number(parts.year);
    const month = Number(parts.month);
    const day = Number(parts.day);
    const hour = Number(parts.hour) % 24;
    const minute = Number(parts.minute);
    return {
      year,
      month,
      day,
      hour,
      minute,
      dateStr: `${year}-${month}-${day}`,
      shortDateStr: `${month}-${day}`,
      timeStr: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    };
  } catch {
    const d = new Date(ms + 8 * 3600 * 1000);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      dateStr: `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`,
      shortDateStr: `${d.getUTCMonth() + 1}-${d.getUTCDate()}`,
      timeStr: `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`,
    };
  }
}

/**
 * 获取当前服务内存与容器/系统内存占比（无需派生 ps aux 子进程）
 * - Linux 容器（存在 cgroup v1/v2 限额）：精准按容器内存配额计算使用率
 * - 常规宿主机：按 os.totalmem/os.freemem 计算系统内存使用率
 */
function getMemoryStats({ cgroupStats = getCgroupMemoryStats() } = {}) {
  const rssMB = Math.round(process.memoryUsage().rss / (1024 * 1024));
  if (cgroupStats && cgroupStats.limitMB > 0) {
    return {
      rssMB,
      sysUsePct: cgroupStats.usePct,
      limitMB: cgroupStats.limitMB,
      usedMB: cgroupStats.usedMB,
      source: `cgroup-${cgroupStats.version}`,
    };
  }
  const totalSys = os.totalmem();
  const usedSys = totalSys - os.freemem();
  const sysUsePct = totalSys > 0 ? Math.round((usedSys / totalSys) * 100) : 0;
  return {
    rssMB,
    sysUsePct,
    limitMB: totalSys > 0 ? Math.round(totalSys / (1024 * 1024)) : 0,
    usedMB: Math.round(usedSys / (1024 * 1024)),
    source: 'host',
  };
}

/**
 * 使用 Node 22 原生 fs.statfsSync 获取磁盘使用率（无需派生 df -k 子进程）
 */
function getDiskUsePct(targetPath = process.cwd()) {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const stat = fs.statfsSync(targetPath);
    const total = Number(stat.blocks) * Number(stat.bsize);
    const avail = Number(stat.bavail) * Number(stat.bsize);
    if (!Number.isFinite(total) || total <= 0) return null;
    return Math.round(((total - avail) / total) * 100);
  } catch {
    return null;
  }
}

async function sendDailyDigest(scheduler, bot) {
  try {
    if (db.getSetting('notify_digest') === '0') return;
  } catch {}
  const stats = scheduler.getDigestStats();
  const { shortDateStr } = getZonedDateParts();
  const lines = [`📊 每日推流小结（${shortDateStr}）`];
  if (stats.length === 0) {
    lines.push('暂无启用中的任务');
  }
  for (const s of stats) {
    const status = s.running ? '🟢 推流中' : '⚪ 空闲';
    lines.push(
      `🖥️ ${views.platformLabel(s.platform)} #${s.roomId}：` +
        `推流 ${s.liveMinutes} 分钟，断流 ${s.drops} 次，流量 ${views.formatBytes(s.bytes)}，${status}`
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

let lastResourceAlertAt = 0;

async function checkResources(bot) {
  try {
    db.checkpoint?.('PASSIVE');
    db.pruneBitrateSamples?.();
  } catch {}

  if (typeof global.gc === 'function') {
    try {
      global.gc();
    } catch {}
  }

  const problems = [];
  const { rssMB, sysUsePct, limitMB, source } = getMemoryStats();
  const runtime = config.runtime || getRuntimeProfile();
  if (config.housekeeping.memAlertMb > 0) {
    if (rssMB >= config.housekeeping.memAlertMb) {
      problems.push(`服务内存 ${rssMB}MB（阈值 ${config.housekeeping.memAlertMb}MB）`);
    }
  } else if (!runtime.isFreeBSD && sysUsePct >= 90) {
    const label = source.startsWith('cgroup') ? `容器内存使用率 ${sysUsePct}%（限额 ${limitMB}MB，` : `系统内存使用率 ${sysUsePct}%（`;
    problems.push(`${label}服务 RSS ${rssMB}MB）`);
  }

  const diskPct = getDiskUsePct();
  if (diskPct !== null && diskPct >= config.housekeeping.diskAlertPct) {
    problems.push(`磁盘 ${diskPct}%（水位 ${config.housekeeping.diskAlertPct}%）`);
  }
  if (problems.length === 0) return;
  if (Date.now() - lastResourceAlertAt < config.housekeeping.resourceAlertCooldownMs) return;
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
  let lastConfiguredHour = null;
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
    const hStr =
      db.getSetting('daily_restart_hour') ||
      db.getSetting('nightly_restart_hour') ||
      String(config.housekeeping.defaultRestartHour);
    const h = parseInt(hStr, 10);
    return Number.isFinite(h) && h >= 0 && h < 24 ? h : config.housekeeping.defaultRestartHour;
  }

  function calculateNextTargetTime(afterMs = Date.now()) {
    const baseHour = getBaseRestartHour();
    const parts = getZonedDateParts(afterMs);
    const todayStr = parts.dateStr;

    // 计算距离当日目标小时的毫秒差
    const diffMinutes = (baseHour - parts.hour) * 60 - parts.minute;
    let targetMs = afterMs + diffMinutes * 60 * 1000;

    let lastRestartDate = null;
    try {
      lastRestartDate = db.getSetting('last_daily_restart_date');
    } catch {}

    if (lastRestartDate === todayStr || targetMs <= afterMs - 5 * 60 * 1000) {
      targetMs += 24 * 3600 * 1000;
    }
    return targetMs;
  }

  async function dailyMaintenanceRestart() {
    if (isRestarting) return;
    try {
      if (db.getSetting('daily_restart') === '0' || db.getSetting('nightly_restart') === '0') return;
    } catch {}

    const now = Date.now();
    const configuredHour = getBaseRestartHour();
    if (!nextRestartTime || lastConfiguredHour !== configuredHour) {
      lastConfiguredHour = configuredHour;
      postponeCount = 0;
      nextRestartTime = calculateNextTargetTime(now);
    }

    if (now < nextRestartTime) return;

    const managers = [...(scheduler.runningManagers?.values() || [])].filter(
      (m) => m.ffmpeg?.getTrafficStats().running
    );
    const isStreaming = managers.length > 0;
    const enablePostpone = db.getSetting('daily_restart_postpone') !== '0';

    const { rssMB } = getMemoryStats();
    const criticalLimit = config.housekeeping.criticalMemMb;
    const isCriticalMem = criticalLimit > 0 && rssMB >= criticalLimit;

    if (isStreaming && enablePostpone && !isCriticalMem) {
      postponeCount += 1;
      nextRestartTime = now + 3600 * 1000;
      const nextParts = getZonedDateParts(nextRestartTime);
      console.log(
        `[housekeeping] 当前 ${managers.length} 路正在推流，每日维护重启顺延至 ${nextParts.timeStr} (已累计顺延 ${postponeCount} 次)`
      );

      if (postponeCount === 1 || postponeCount % 3 === 0) {
        await sendAll(
          `⏳ <b>系统维护延后通知</b>\n检测到当前有 ${managers.length} 路直播正在推流，为保障直播不中断，每日维护重启自动顺延 1 小时至 <b>${nextParts.timeStr}</b> 再次检查（累计顺延 ${postponeCount} 次）。`
        ).catch(() => {});
      }
      return;
    }

    isRestarting = true;
    const streamDesc = isStreaming ? `（当前 ${managers.length} 路推流一并重置）` : '（当前无推流，静默重置）';
    const { dateStr: todayStr } = getZonedDateParts(now);

    try {
      db.setSetting('last_daily_restart_date', todayStr);
    } catch {}

    postponeCount = 0;
    nextRestartTime = calculateNextTargetTime(now + 24 * 3600 * 1000 - 10 * 60 * 1000);

    await sendAll(
      `🔄 <b>系统每日维护重启</b>\n系统正在执行滚动重启以彻底重置内存${streamDesc}，预计 3~5 秒内自动拉起恢复…`
    );

    try {
      db.checkpoint?.('TRUNCATE');
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 2000));

    if (typeof onRestart === 'function') {
      onRestart();
      return;
    }

    let done = 0;
    for (const m of managers) {
      try {
        await scheduler.refreshTask?.(m.task);
        done += 1;
      } catch (err) {
        console.error(`[housekeeping] 维护重启 ${m.task?.room_id} 失败:`, err.message);
      }
      await new Promise((resolve) => setTimeout(resolve, 30000));
    }
    await sendAll(`✅ 每日自动维护完成：${done}/${managers.length} 路推流已重启`);
    isRestarting = false;
  }

  setInterval(() => {
    try {
      const parts = getZonedDateParts();
      if (parts.hour === config.housekeeping.digestHour && parts.minute < 5 && lastDigestDate !== parts.dateStr) {
        lastDigestDate = parts.dateStr;
        sendDailyDigest(scheduler, bot).catch((err) => console.error('每日小结失败:', err.message));
      }
      dailyMaintenanceRestart().catch((err) => console.error('每日维护重启检查失败:', err.message));
    } catch (err) {
      console.error('定时器异常:', err.message);
    }
  }, 60000).unref();

  setInterval(() => {
    checkResources(bot).catch((err) => console.error('资源检查异常:', err.message));
  }, 5 * 60000).unref();
  setTimeout(() => checkResources(bot).catch(() => {}), 30000).unref();

  if (typeof bot._pushWidgetUpdate === 'function') {
    setInterval(() => {
      const widgetMsgs = bot._widgetMessages || {};
      for (const chatId of Object.keys(widgetMsgs)) {
        bot._pushWidgetUpdate(chatId).catch(() => {});
      }
    }, 60000).unref();
  }
}

module.exports = {
  startHousekeeping,
  getMemoryStats,
  getDiskUsePct,
  getZonedDateParts,
};
