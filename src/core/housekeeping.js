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

function startHousekeeping({ scheduler, bot }) {
  let lastDigestDate = null;

  // 每分钟检查一次：到点发小结
  setInterval(() => {
    try {
      const d = cstNow();
      const today = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
      if (d.getUTCHours() === DIGEST_HOUR_CST && d.getUTCMinutes() < 5 && lastDigestDate !== today) {
        lastDigestDate = today;
        sendDailyDigest(scheduler, bot).catch((err) => console.error('每日小结失败:', err.message));
      }
    } catch (err) {
      console.error('小结定时器异常:', err.message);
    }
  }, 60000);

  // 每 5 分钟检查一次资源水位
  setInterval(() => {
    checkResources(bot).catch((err) => console.error('资源检查异常:', err.message));
  }, 5 * 60000);
  // 启动 30 秒后先查一次
  setTimeout(() => checkResources(bot).catch(() => {}), 30000);
}

module.exports = { startHousekeeping };
