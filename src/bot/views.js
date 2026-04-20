function platformLabel(platform) {
  return platform === 'bilibili' ? 'B站' : platform === 'douyu' ? '斗鱼' : platform;
}

function statusLabel(status) {
  return status === 'ENABLED' ? '🟢 运行中' : '⚪ 已禁用';
}

function statusIcon(status) {
  return status === 'ENABLED' ? '🟢' : '⚪';
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
    return '📭 房间管理\n\n当前还没有已配置房间，点击“➕ 添加房间”开始创建。';
  }

  const lines = ['🏠 房间管理', '', '选择一个房间进入控制台：'];
  tasks.forEach((task, index) => {
    lines.push(`${index + 1}. ${statusIcon(task.status)} ${platformLabel(task.platform)} · 房间 ${task.room_id}`);
  });
  return lines.join('\n');
}

function renderTaskList(tasks = []) {
  return renderRoomList(tasks);
}

function renderTaskDetail(task, isRunning) {
  const targetUrls = getTargetUrls(task);
  const primary = task.primary_target_url || task.target_url || targetUrls[0] || '';
  const targetLine = targetUrls.length === 0
    ? '全部 RTMP (0): 无'
    : [`全部 RTMP (${targetUrls.length})`, ...targetUrls.map((url, index) => `#${index + 1} ${maskTargetUrl(url)}`)].join('\n');

  return [
    '📺 房间控制台',
    `房间 ID: ${task.room_id}`,
    `平台: ${platformLabel(task.platform)}`,
    `状态: ${statusLabel(task.status)}`,
    `FFmpeg: ${isRunning ? '已启动' : '未运行'}`,
    `主推流: ${maskTargetUrl(primary)}`,
    targetLine,
    `最近错误: ${task.last_error || '无'}`,
  ].join('\n');
}

function renderDashboard({ totalTasks = 0, enabledTasks = 0, disabledTasks = 0, runningManagers = 0, totalTargets = 0 }) {
  return [
    '📺 管理面板',
    `房间总数: ${totalTasks}`,
    `运行中房间: ${enabledTasks}`,
    `暂停房间: ${disabledTasks}`,
    `FFmpeg 进程: ${runningManagers}`,
    `推流线路: ${totalTargets}`,
    '',
    '可用操作：房间管理 / 添加房间 / 流量查看',
  ].join('\n');
}

function renderSystemStatus(stats = {}) {
  return renderDashboard(stats);
}

function renderRoomTraffic(tasks = []) {
  if (tasks.length === 0) {
    return '📈 流量查看\n\n当前没有房间流量数据。';
  }

  const lines = ['📈 流量查看', ''];
  tasks.forEach((task, index) => {
    const traffic = task.traffic || {};
    lines.push(`${index + 1}. ${platformLabel(task.platform)} · 房间 ${task.room_id}`);
    lines.push(`状态: ${statusLabel(task.status)}`);
    lines.push(`累计流量: ${formatBytes(traffic.totalBytes || 0)}`);
    lines.push(`本次推流: ${formatBytes(traffic.sessionBytes || 0)}`);
    lines.push(`当前码率: ${Math.round(traffic.bitrateKbps || 0)} kbps`);
    lines.push(`更新时间: ${traffic.updatedAt || '暂无'}`);
    lines.push('');
  });
  return lines.join('\n').trim();
}

module.exports = {
  platformLabel,
  renderTaskList,
  renderRoomList,
  renderTaskDetail,
  renderDashboard,
  renderRoomTraffic,
  renderSystemStatus,
  formatBytes,
};
