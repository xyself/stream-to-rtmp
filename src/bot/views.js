function platformLabel(platform) {
  const labels = { bilibili: 'B站', douyu: '斗鱼', douyin: '抖音' };
  return labels[platform] || platform;
}

function statusLabel(status) {
  return status === 'ENABLED' ? '🟢 运行中' : '⚪ 已禁用';
}

function escapeHtml(text = '') {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function maskTargetUrl(url = '') {
  if (!url) return '未配置';
  // 只保留 scheme://host，路径与查询（含推流密钥）全部打码
  const m = String(url).match(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]+)/);
  if (m) return `${m[1]}/****`;
  return '****';
}

// 把参数数组里形如 URL（含密钥）的参数整体打码，用于展示 FFmpeg 命令行
function maskSensitiveArgs(args = []) {
  return (Array.isArray(args) ? args : []).map((arg) => {
    const s = String(arg);
    return s.includes('://') ? maskTargetUrl(s) : s;
  });
}

function getTargetUrls(task = {}) {
  if (Array.isArray(task.targets)) {
    return task.targets.map((target) => target.target_url).filter(Boolean);
  }

  return [task.primary_target_url || task.target_url].filter(Boolean);
}

function formatBytes(bytes = 0) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(2)} ${units[unitIndex]}`;
}

function renderRoomList(tasks = []) {
  if (tasks.length === 0) {
    return '<b>📭 房间管理</b>\n\n当前还没有已配置房间\n点击「➕ 添加房间」开始创建';
  }

  // 按状态分组：推流中 / 待机轮询 / 已暂停
  const live = [];
  const idle = [];
  const paused = [];
  for (const task of tasks) {
    if (task.status !== 'ENABLED') { paused.push(task); continue; }
    if (task.traffic?.running) { live.push(task); continue; }
    idle.push(task);
  }

  const lines = [
    `<b>🏠 房间管理</b> · 共 ${tasks.length} 个房间`,
    '',
  ];

  const renderGroup = (icon, title, group, detail) => {
    if (group.length === 0) return;
    lines.push(`${icon} <b>${title}</b>（${group.length}）`);
    for (const task of group) {
      lines.push(`▪️ ${escapeHtml(platformLabel(task.platform))} #${escapeHtml(task.room_id)}${detail(task)}`);
    }
    lines.push('');
  };

  renderGroup('🟢', '推流中', live, (t) => {
    const kbps = Math.round(t.traffic?.bitrateKbps || 0);
    return kbps > 0 ? ` · ${kbps} kbps` : '';
  });
  renderGroup('⚪', '待机 / 轮询中', idle, () => ' · 等待开播');
  renderGroup('🛑', '已暂停', paused, () => '');

  lines.push('<i>点下方按钮进入房间控制台</i>');
  return lines.join('\n');
}

function renderTaskList(tasks = []) {
  return renderRoomList(tasks);
}

function renderTaskDetail(task, isRunning) {
  const targetUrls = getTargetUrls(task);

  const lines = [
    `<b>📺 ${escapeHtml(platformLabel(task.platform))} · #${escapeHtml(task.room_id)}</b>`,
    `${statusLabel(task.status)}  ·  FFmpeg ${isRunning ? '✅' : '⚪'}`,
  ];

  lines.push('');
  if (targetUrls.length > 0) {
    lines.push(`<b>📤 推流地址 (${targetUrls.length})</b>`);
    targetUrls.forEach((url, idx) => {
      lines.push('');
      if (idx === 0) {
        lines.push(`<b>${idx + 1}.</b> ⭐主推流`);
      } else {
        lines.push(`<b>${idx + 1}.</b>`);
      }
      lines.push(`<code>${escapeHtml(url)}</code>`);
    });
  } else {
    lines.push(`<b>📤 推流地址</b>：未配置`);
  }

  if (task.last_error) {
    lines.push('');
    lines.push(`⚠️ ${escapeHtml(task.last_error)}`);
  }

  return lines.join('\n');
}

function progressBar(percent, length = 10) {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round(clamped / 100 * length);
  return '█'.repeat(filled) + '░'.repeat(length - filled);
}

function formatUptime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '未知';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}天 ${hours}小时`;
  if (hours > 0) return `${hours}小时 ${minutes}分钟`;
  return `${minutes}分钟`;
}

function renderDashboard({ system = {}, stats = {}, recentErrors = [] } = {}) {
  const lines = [
    `<b>📊 全局控制台</b>（运行：${escapeHtml(system.uptime || '未知')}）`,
    '',
    `<b>🖥️服务器状态</b>`,
    `  CPU：[${system.cpuBar || '░░░░░░░░░░'}] ${system.cpuPercent ?? 0}%`,
    `  RAM：${escapeHtml(system.memUsed || '?')} / ${escapeHtml(system.memTotal || '?')}`,
    `  SVC：服务占用 ${escapeHtml(system.serviceMem || '?')}`,
  ];

  if (system.dbSize) {
    lines.push(`  DB：${escapeHtml(system.dbSize)}`);
  }

  lines.push('');
  lines.push(`<b>📈 任务统计</b>`);
  lines.push(`  🏠 总计: ${stats.totalTasks ?? 0}  ｜  ✅ 运行: ${stats.enabledTasks ?? 0}  ｜  🛑 暂停: ${stats.disabledTasks ?? 0}`);
  lines.push(`  ⚙️ FFmpeg: ${stats.activeStreams ?? 0} 个活跃推流`);
  lines.push(`  🔍 任务监听: ${stats.totalMonitoring ?? 0} 个房间`);
  lines.push(`  📤 推流线路: ${stats.totalTargets ?? 0} 条`);
  lines.push(`  🎬 画质转码: ${system.transcodeVideo ? 'libx264 veryfast' : '关闭 (copy)'}`);

  if (recentErrors.length > 0) {
    lines.push('');
    lines.push(`<b>⚠️ 最近警告</b>`);
    recentErrors.slice(0, 5).forEach((err, idx) => {
      lines.push(`  ${idx + 1}. ${escapeHtml(err)}`);
    });
  }

  return lines.join('\n');
}

function renderSystemStatus(stats = {}) {
  return renderDashboard({ stats });
}

// 📊 推流状态：一级列表（点房间进详情）
function renderStatusList(entries = []) {
  const liveCount = entries.filter((e) => e.traffic?.running).length;
  const enabledCount = entries.filter((e) => e.status === 'ENABLED').length;
  return [
    '<b>📊 推流状态</b>',
    '',
    `🟢 ${liveCount} 路推流中 · ⚪ ${enabledCount - liveCount} 待机 · 共 ${entries.length} 个房间`,
    '',
    '<i>点下方房间查看详情：</i>',
  ].join('\n');
}

function renderRoomTraffic(tasks = []) {
  if (tasks.length === 0) {
    return '<b>📈 流量查看</b>\n\n当前没有房间流量数据';
  }

  const lines = [
    '<b>📈 流量查看</b>',
    '',
  ];
  
  tasks.forEach((task, index) => {
    const traffic = task.traffic || {};
    const kbps = Math.round(traffic.bitrateKbps || 0);
    lines.push(`<b>${index + 1}. ${escapeHtml(platformLabel(task.platform))} · #${escapeHtml(task.room_id)}</b>`);
    lines.push(`  ${statusLabel(task.status)}  ·  ${kbps > 0 ? kbps + ' kbps' : '无数据'}`);
    lines.push(`  📊 累计 ${formatBytes(traffic.totalBytes || 0)}  ｜  📤 本次 ${formatBytes(traffic.sessionBytes || 0)}`);
    if (traffic.updatedAt) {
      lines.push(`  🕐 ${traffic.updatedAt}`);
    }
    lines.push('');
  });
  
  return lines.join('\n');
}

function renderDetailedStatus(tasks = []) {
  if (tasks.length === 0) {
    return '<b>🚀 健康监控</b>\n\n当前没有正在运行的任务';
  }

  const lines = ['<b>🚀 推流健康监控</b>', ''];

  tasks.forEach((task, index) => {
    const traffic = task.traffic || {};
    const roomInfo = traffic.roomInfo || {};
    const isRunning = traffic.running;
    const kbps = Math.round(traffic.bitrateKbps || 0);
    const duration = isRunning && traffic.startedAt 
      ? formatUptime((Date.now() - new Date(traffic.startedAt).getTime()) / 1000)
      : '未推流';
    
    const hostLine = roomInfo.hostName ? `\n  主播：${escapeHtml(roomInfo.hostName)}` : '';
    const titleLine = roomInfo.roomName ? `\n  标题：${escapeHtml(roomInfo.roomName)}` : '';

    lines.push(`<b>${index + 1}. ${escapeHtml(platformLabel(task.platform))} · #${escapeHtml(task.room_id)}</b>${hostLine}${titleLine}`);
    lines.push(`  状态：${isRunning ? '🟢 正在推流' : '⚪ 待机/重试'}`);
    lines.push(`  时长：${duration}`);
    lines.push(`  码率：${kbps > 0 ? kbps + ' kbps' : '0 kbps'}`);
    lines.push(`  错误：${traffic.errorCount || 0} 次`);
    if (traffic.lastSuccessAt) {
      lines.push(`  成功：${new Date(traffic.lastSuccessAt).toLocaleString('zh-CN', { hour12: false })}`);
    }
    lines.push('');
  });

  return lines.join('\n');
}

const NOTIFICATION_TYPES = [
  { key: 'notify_live_start',   label: '🟢 开播通知', desc: '主播开播时推送截图' },
  { key: 'notify_stream_ended', label: '🔴 关播通知', desc: '直播结束时推送' },
  { key: 'notify_ffmpeg_error', label: '⚠️ 断流通知', desc: 'FFmpeg 推流出错时推送' },
  { key: 'notify_offline',      label: '📌 下播通知', desc: '房间下播 / 未开播时推送' },
  { key: 'notify_output_failed', label: '🔌 输出断开', desc: '某路推流目标断开时推送' },
  { key: 'notify_black_screen',  label: '⬛ 黑屏告警', desc: '画面疑似黑屏时推送' },
  { key: 'notify_bitrate_drop',  label: '📉 码率下跌', desc: '码率大幅下跌时推送' },
  { key: 'notify_failover',      label: '🔀 线路切换', desc: '切换备用线路时推送' },
  { key: 'notify_resource',      label: '💾 资源告警', desc: '内存/磁盘水位偏高时推送' },
  { key: 'notify_digest',        label: '📊 每日小结', desc: '每天早上 8 点推送推流小结' },
  { key: 'notify_recover',       label: '✅ 恢复通知', desc: '断流/黑屏/码率告警恢复时推送中断时长' },
  { key: 'notify_session_summary', label: '📋 下播小结', desc: '下播时自动推送本场时长/断流/峰值码率' },
];

// 下播自动推送的本场小结
function renderSessionSummary({ platform, roomId, hostName, durationSec, drops, peakKbps, bytes } = {}) {
  const hostLabel = hostName ? `（${escapeHtml(hostName)}）` : '';
  return [
    `📋 <b>本场小结</b> ${escapeHtml(platformLabel(platform))} #${escapeHtml(roomId)}${hostLabel}`,
    `⏱️ 推流时长：${formatUptime(durationSec || 0)}`,
    `🔌 断流次数：${drops || 0} 次`,
    `📈 峰值码率：${peakKbps > 0 ? peakKbps + ' kbps' : '无数据'}`,
    `📊 本场流量：${formatBytes(bytes || 0)}`,
  ].join('\n');
}

function renderNotificationSettings(settings = {}) {
  const lines = [
    `<b>🔔 通知管理</b>`,
    '',
  ];

  for (const item of NOTIFICATION_TYPES) {
    const enabled = settings[item.key] !== false;
    const icon = enabled ? '✅' : '⛔';
    lines.push(`${icon} <b>${item.label}</b>`);
    lines.push(`     ${item.desc}`);
  }

  lines.push('');
  lines.push('<i>点击下方按钮切换通知开关</i>');

  return lines.join('\n');
}

function renderFfmpegParams(tasks) {
  const lines = ['<b>🛠️ FFmpeg 运行参数</b>\n'];
  let count = 0;

  tasks.forEach((task) => {
    const traffic = task.traffic || {};
    if (!traffic.running || !traffic.lastArgs) return;
    
    count++;
    lines.push(`<b>${count}. ${escapeHtml(platformLabel(task.platform))} #${escapeHtml(task.room_id)}</b>`);
    lines.push(`<code>${escapeHtml(maskSensitiveArgs(traffic.lastArgs).join(' '))}</code>\n`);
  });

  if (count === 0) {
    return '当前没有正在运行的推流任务，无 FFmpeg 参数可查。';
  }

  return lines.join('\n');
}

// 把技术性报错翻译成人话；未知错误原文透出（截断，避免刷屏）
function humanizeError(message = '') {
  const msg = String(message);
  if (/404|error opening input|input\/output error|地址过期|url.*expir/i.test(msg)) {
    return '取流地址可能已过期，20 秒后自动换新地址重试';
  }
  if (/exited with code (187|251)/.test(msg)) {
    return '平台侧连接抖动断连，正在自动重连…';
  }
  if (/exited with code 196/.test(msg)) {
    return '输出端握手超时，正在重试…';
  }
  if (/exited with code 224|broken pipe/i.test(msg)) {
    return '接收端断开了连接，正在重试…';
  }
  if (/限流|rate.?limit|too many requests/i.test(msg)) {
    return '触发平台限流，正在退避重试…';
  }
  return msg.length > 300 ? msg.slice(0, 300) + '…' : msg;
}

module.exports = {
  platformLabel,
  escapeHtml,
  humanizeError,
  renderTaskList,
  renderRoomList,
  renderTaskDetail,
  renderDashboard,
  renderRoomTraffic,
  renderDetailedStatus,
  renderStatusList,
  renderSystemStatus,
  formatBytes,
  maskTargetUrl,
  maskSensitiveArgs,
  getTargetUrls,
  progressBar,
  formatUptime,
  renderNotificationSettings,
  NOTIFICATION_TYPES,
  renderFfmpegParams,
  renderSessionSummary,
};
