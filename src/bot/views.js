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
  if (url.length <= 36) return url;
  return `${url.slice(0, 24)}...${url.slice(-8)}`;
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

  const lines = [
    '<b>🏠 房间管理</b>',
    '',
    '<i>选择房间进入控制台：</i>',
    '',
  ];
  
  tasks.forEach((task, index) => {
    const status = task.status === 'ENABLED' ? '✅' : '🛑';
    lines.push(`${index + 1}. ${status} ${escapeHtml(platformLabel(task.platform))} · #${escapeHtml(task.room_id)}`);
  });
  
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
  lines.push(`  🔍 监听任务: ${stats.totalMonitoring ?? 0} 个房间`);
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
];

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
    lines.push(`<code>${escapeHtml(traffic.lastArgs.join(' '))}</code>\n`);
  });

  if (count === 0) {
    return '当前没有正在运行的推流任务，无 FFmpeg 参数可查。';
  }

  return lines.join('\n');
}

module.exports = {
  platformLabel,
  escapeHtml,
  renderTaskList,
  renderRoomList,
  renderTaskDetail,
  renderDashboard,
  renderRoomTraffic,
  renderDetailedStatus,
  renderSystemStatus,
  formatBytes,
  maskTargetUrl,
  getTargetUrls,
  progressBar,
  formatUptime,
  renderNotificationSettings,
  NOTIFICATION_TYPES,
  renderFfmpegParams,
};
