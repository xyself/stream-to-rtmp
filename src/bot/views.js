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
  const m = String(url).match(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]+)/);
  if (m) return `${m[1]}/****`;
  return '****';
}

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

function progressBar(percent, length = 10) {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * length);
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

function sortTasksByActivity(tasks = []) {
  const rank = (t) => {
    if (t.status !== 'ENABLED') return 2;
    return t.traffic?.running ? 0 : 1;
  };
  return [...tasks].sort((a, b) => rank(a) - rank(b));
}

function filterTasksByState(tasks = [], filter = 'all') {
  const list = Array.isArray(tasks) ? tasks : [];
  if (filter === 'live') {
    return list.filter((t) => t.status === 'ENABLED' && Boolean(t.traffic?.running));
  }
  if (filter === 'idle') {
    return list.filter((t) => t.status === 'ENABLED' && !t.traffic?.running);
  }
  if (filter === 'paused') {
    return list.filter((t) => t.status !== 'ENABLED');
  }
  return list;
}

function renderRoomList(tasks = [], filter = 'all') {
  if (tasks.length === 0) {
    return [
      '<b>🏠 房间管理中心</b>',
      '',
      '<blockquote>📭 <b>还没有配置任何转播房间</b>',
      '支持 <b>B站</b> · <b>斗鱼</b> · <b>抖音</b> 直播间链接（含 <code>b23.tv</code> / <code>v.douyin.com</code> 短链），直接发送给机器人即可自动识别建房。</blockquote>',
      '',
      '<i>💡 点击下方「➕ 立即添加房间」，或直接发送「直播间链接 + rtmp地址」一行极速建房</i>',
    ].join('\n');
  }

  const live = [];
  const idle = [];
  const paused = [];
  for (const task of tasks) {
    if (task.status !== 'ENABLED') {
      paused.push(task);
      continue;
    }
    if (task.traffic?.running) {
      live.push(task);
      continue;
    }
    idle.push(task);
  }

  const filterLabels = {
    all: '',
    live: ' · 筛选: 🟢 推流中',
    idle: ' · 筛选: ⚪ 待机',
    paused: ' · 筛选: 🛑 已暂停',
  };
  const activeFilter = filterLabels[filter] !== undefined ? filter : 'all';
  const totalKbps = live.reduce((sum, t) => sum + Math.round(t.traffic?.bitrateKbps || 0), 0);
  const rateSummary = totalKbps > 0 ? ` · ⚡ <code>${totalKbps} kbps</code>` : '';

  const lines = [
    `<b>🏠 房间管理中心</b> · 共 <b>${tasks.length}</b> 房${filterLabels[activeFilter]}`,
    `<code>🟢 ${live.length} 推流中</code> · <code>⚪ ${idle.length} 待机</code> · <code>🛑 ${paused.length} 暂停</code>${rateSummary}`,
    '',
  ];

  const renderGroupCard = (icon, title, group, detail) => {
    if (group.length === 0) return;
    const cardLines = [`${icon} <b>${title} (${group.length})</b>`];
    for (const task of group) {
      const host = task.traffic?.roomInfo?.hostName
        ? ` · ${escapeHtml(task.traffic.roomInfo.hostName)}`
        : '';
      const cookieTag = task.cookie ? ' 🍪' : '';
      cardLines.push(`▸ <b>${escapeHtml(platformLabel(task.platform))}</b> <code>#${escapeHtml(task.room_id)}</code>${host}${cookieTag}${detail(task)}`);
    }
    lines.push(`<blockquote>${cardLines.join('\n')}</blockquote>`);
  };

  const visibleCount = filterTasksByState(tasks, activeFilter).length;
  if (visibleCount === 0) {
    const emptyReason = activeFilter === 'live'
      ? '当前暂无正在推流的房间'
      : activeFilter === 'idle'
        ? '当前暂无待机监听中的房间'
        : '当前暂无已暂停的房间';
    lines.push(`<blockquote>📭 <b>${emptyReason}</b>\n点击上方筛选标签可切换查看全部房间。</blockquote>`);
  } else {
    if (activeFilter === 'all' || activeFilter === 'live') {
      renderGroupCard('🟢', '正在推流', live, (t) => {
        const kbps = Math.round(t.traffic?.bitrateKbps || 0);
        const dur = t.traffic?.startedAt
          ? ` · ${formatUptime((Date.now() - new Date(t.traffic.startedAt).getTime()) / 1000)}`
          : '';
        return kbps > 0 ? ` · <code>${kbps} kbps</code>${dur}` : '';
      });
    }
    if (activeFilter === 'all' || activeFilter === 'idle') {
      renderGroupCard('⚪', '待机监听', idle, () => ' · <i>等待开播</i>');
    }
    if (activeFilter === 'all' || activeFilter === 'paused') {
      renderGroupCard('🛑', '已暂停', paused, () => '');
    }
  }

  lines.push('');
  lines.push('<i>👇 点击下方房间按钮进入单房间控制台，或点「🎛️ 实时卡片」打开内联面板</i>');
  return lines.join('\n');
}

function renderCurveRoomPicker(tasks = []) {
  if (!tasks || tasks.length === 0) {
    return [
      '<b>📈 分房间推流曲线</b>',
      '',
      '<blockquote>📭 <b>当前还没有配置任何直播房间</b>',
      '添加房间并开播推流后，可按单房间查看 <b>30分 / 1小时 / 3小时 / 6小时 / 12小时</b> 高清码率曲线。</blockquote>',
    ].join('\n');
  }

  const sorted = sortTasksByActivity(tasks);
  const liveCount = sorted.filter((t) => t.status === 'ENABLED' && t.traffic?.running).length;
  const cardLines = [`<b>选择要查看码率曲线的直播间</b>（支持 30分 / 1h / 3h / 6h / 12h 切换）`];
  for (const task of sorted) {
    const running = task.status === 'ENABLED' && Boolean(task.traffic?.running);
    const icon = task.status !== 'ENABLED' ? '🛑' : running ? '🟢' : '⚪';
    const host = task.traffic?.roomInfo?.hostName ? ` · ${escapeHtml(task.traffic.roomInfo.hostName)}` : '';
    const kbps = Math.round(task.traffic?.bitrateKbps || 0);
    const detail = running && kbps > 0 ? ` · <code>${kbps} kbps</code>` : '';
    cardLines.push(`${icon} <b>${escapeHtml(platformLabel(task.platform))}</b> <code>#${escapeHtml(task.room_id)}</code>${host}${detail}`);
  }

  return [
    `<b>📈 分房间推流曲线</b> · <code>🟢 ${liveCount} 推流中</code> / 共 ${sorted.length} 房`,
    '',
    `<blockquote>${cardLines.join('\n')}</blockquote>`,
    '',
    '<i>👇 点击下方房间查看深色高清仪表盘曲线（也可发 <code>/curve 房间号</code> 直达）</i>',
  ].join('\n');
}

function renderQuickSnapEmpty(tasks = []) {
  if (tasks.length === 0) {
    return [
      '<b>📷 快捷截图</b>',
      '',
      '<blockquote>📭 <b>当前还没有配置任何直播房间</b>',
      '添加房间并在主播开播推流后，点击「📷 快捷截图」即可直接抓取实时画面。</blockquote>',
    ].join('\n');
  }

  const enabledCount = tasks.filter((t) => t.status === 'ENABLED').length;
  return [
    '<b>📷 快捷截图</b>',
    '',
    `<blockquote>⏸️ <b>当前暂无正在推流的房间</b>`,
    `共配置 <b>${tasks.length}</b> 个房间（其中 <b>${enabledCount}</b> 个正在待机监听）。`,
    `快捷截图仅针对<b>正在推流中</b>的直播间自动抓帧，主播开播后点击即可一键出图。</blockquote>`,
    '',
    '<i>💡 如需指定房间抓帧，可发送 <code>/snap 房间号</code></i>',
  ].join('\n');
}

function renderSnapshotCaption(task, { indexLabel = '' } = {}) {
  const traffic = task.traffic || {};
  const roomInfo = traffic.roomInfo || {};
  const host = roomInfo.hostName ? ` · ${escapeHtml(roomInfo.hostName)}` : '';
  const idxTag = indexLabel ? ` <code>${escapeHtml(indexLabel)}</code>` : '';
  const kbps = Math.round(traffic.bitrateKbps || 0);
  const duration = traffic.running && traffic.startedAt
    ? formatUptime((Date.now() - new Date(traffic.startedAt).getTime()) / 1000)
    : '实时抓帧';
  const nowStr = new Date().toLocaleString('zh-CN', { hour12: false });

  const metaLines = [
    `⚡ 码率：<code>${kbps > 0 ? `${kbps} kbps` : '检测中'}</code>  ｜  ⏱️ 时长：<code>${escapeHtml(duration)}</code>`,
  ];
  if (roomInfo.roomName) {
    metaLines.push(`📝 标题：${escapeHtml(roomInfo.roomName)}`);
  }
  metaLines.push(`🕒 时间：<code>${escapeHtml(nowStr)}</code>`);

  return [
    `📸 <b>${escapeHtml(platformLabel(task.platform))} #${escapeHtml(task.room_id)}</b>${host}${idxTag}`,
    `<blockquote>${metaLines.join('\n')}</blockquote>`,
  ].join('\n');
}

function transcodeModeLabel(mode = 'default') {
  const map = {
    default: '跟随全局',
    copy: '直推 Copy (零CPU)',
    audio_fix: '仅音频修复 (Copy+AAC)',
    transcode: '视频转码 (H.264+AAC)',
  };
  return map[mode] || '跟随全局';
}

function nextTranscodeMode(current = 'default') {
  const order = ['default', 'copy', 'audio_fix', 'transcode'];
  const idx = order.indexOf(current);
  return order[(idx + 1) % order.length];
}

/**
 * 二合一单房间全功能控制台：
 * 整合【主播/标题 + 实时码率/时长/流量 + 房间独立 Cookie & 编码策略 + 完整 RTMP 密钥对比列表 + 报错信息】
 */
function renderTaskDetail(task, isRunning) {
  const targetUrls = getTargetUrls(task);
  const traffic = task.traffic || {};
  const roomInfo = traffic.roomInfo || {};
  const running = Boolean(isRunning ?? traffic.running);
  const kbps = Math.round(traffic.bitrateKbps || 0);
  const duration = running && traffic.startedAt
    ? formatUptime((Date.now() - new Date(traffic.startedAt).getTime()) / 1000)
    : '未推流';
  const hasRoomCookie = Boolean(task.cookie && String(task.cookie).trim());
  const modeLabel = transcodeModeLabel(task.transcode_mode || 'default');

  const lines = [
    `<b>📺 ${escapeHtml(platformLabel(task.platform))} · #${escapeHtml(task.room_id)}</b>`,
    `${statusLabel(task.status)}  ·  FFmpeg ${running ? '🟢 推流中' : '⚪ 待机'}`,
    '',
  ];

  const telemetryLines = [];
  if (roomInfo.hostName) telemetryLines.push(`👤 主播：<b>${escapeHtml(roomInfo.hostName)}</b>`);
  if (roomInfo.roomName) telemetryLines.push(`📝 标题：${escapeHtml(roomInfo.roomName)}`);
  if (telemetryLines.length > 0) telemetryLines.push('');
  telemetryLines.push(`<b>📊 实时遥测 &amp; 房间策略</b>`);
  telemetryLines.push(`⚡ 码率：<code>${kbps > 0 ? `${kbps} kbps` : '0 kbps'}</code>  ｜  ⏱️ 时长：<code>${escapeHtml(duration)}</code>`);
  telemetryLines.push(`📤 本场：<code>${formatBytes(traffic.sessionBytes || 0)}</code>  ｜  📦 累计：<code>${formatBytes(traffic.totalBytes || 0)}</code>`);
  telemetryLines.push(`🎬 编码策略：<b>${escapeHtml(modeLabel)}</b>`);
  telemetryLines.push(`🍪 房间Cookie：${hasRoomCookie ? `✅ 已独立配置 (${String(task.cookie).length} 字符)` : '⚪ 未配置 (默认)'}`);
  if ((traffic.errorCount || 0) > 0) {
    telemetryLines.push(`⚠️ 累计错误：<b>${traffic.errorCount} 次</b>`);
  }
  lines.push(`<blockquote>${telemetryLines.join('\n')}</blockquote>`);

  if (targetUrls.length > 0) {
    const urlCardLines = [`<b>📤 推流地址 (${targetUrls.length})</b>`];
    targetUrls.forEach((url, idx) => {
      urlCardLines.push(idx === 0 ? `<b>${idx + 1}.</b> ⭐主推流` : `<b>${idx + 1}.</b> 备用线路 #${idx}`);
      urlCardLines.push(`<code>${escapeHtml(url)}</code>`);
    });
    lines.push(`<blockquote>${urlCardLines.join('\n')}</blockquote>`);
  } else {
    lines.push(`<blockquote><b>📤 推流地址</b>：未配置</blockquote>`);
  }

  if (task.last_error && task.last_error !== 'STREAM_ENDED') {
    lines.push(`<blockquote>⚠️ <b>最近异常</b>：${escapeHtml(task.last_error)}</blockquote>`);
  }

  return lines.join('\n');
}

function renderDeleteConfirm(task) {
  const targetUrls = getTargetUrls(task);
  return [
    `<b>⚠️ 确认删除房间任务？</b>`,
    '',
    `平台：<b>${escapeHtml(platformLabel(task.platform))}</b>`,
    `房间：<b>#${escapeHtml(task.room_id)}</b>`,
    `关联推流地址：<b>${targetUrls.length} 条</b>`,
    '',
    `<i>删除后将立即停止该房间的 FFmpeg 推流并从数据库彻底移除，是否继续？</i>`,
  ].join('\n');
}

function renderDashboard({ system = {}, stats = {}, recentErrors = [] } = {}) {
  const lines = [
    `<b>📊 全局控制台</b>（运行：${escapeHtml(system.uptime || '未知')}）`,
  ];

  if (system.runtimeLabel || system.nodeVersion || system.gitSha) {
    const envTag = system.runtimeLabel ? escapeHtml(system.runtimeLabel) : 'Linux';
    const nodeTag = system.nodeVersion ? ` · Node ${escapeHtml(system.nodeVersion)}` : '';
    const shaTag = system.gitSha ? ` · <code>${escapeHtml(system.gitSha)}</code>` : '';
    lines.push(`🌐 环境：<code>${envTag}${nodeTag}</code>${shaTag}`);
  }

  lines.push('');
  const sysCard = [`<b>🖥️ 服务器与配额状态</b>`];

  const cpuExtra = system.cpuLabel ? ` (${escapeHtml(system.cpuLabel)})` : '';
  sysCard.push(`CPU：[${system.cpuBar || '░░░░░░░░░░'}] ${system.cpuPercent ?? 0}%${cpuExtra}`);

  const ramExtra = system.memLabel ? ` (${system.memPct ?? 0}% · ${escapeHtml(system.memLabel)})` : (system.memPct != null ? ` (${system.memPct}%)` : '');
  sysCard.push(`RAM：${escapeHtml(system.memUsed || '?')} / ${escapeHtml(system.memTotal || '?')}${ramExtra}`);

  if (system.disk) {
    const diskLabel = system.disk.label ? ` · ${escapeHtml(system.disk.label)}` : '';
    sysCard.push(`DISK：${escapeHtml(system.disk.used)} / ${escapeHtml(system.disk.total)} (${system.disk.pct}%${diskLabel})`);
  }

  if (system.processes) {
    sysCard.push(`PROC：${system.processes.used} / ${system.processes.limit} 进程 (${system.processes.pct}% · 限额 ${system.processes.limit})`);
  }

  const heapTag = system.heapUsed ? ` (V8堆 ${escapeHtml(system.heapUsed)})` : '';
  sysCard.push(`SVC：服务占用 ${escapeHtml(system.serviceMem || '?')}${heapTag}`);

  if (system.dbSize) {
    sysCard.push(`DB：${escapeHtml(system.dbSize)} (SQLite)`);
  }
  if (system.ffmpegVersion) {
    const customBadge = system.ffmpegCustomBinary ? '✅ 自定义/内置' : 'ℹ️ 系统PATH';
    sysCard.push(`FFmpeg：<code>${escapeHtml(system.ffmpegVersion)}</code> · ${customBadge} (${escapeHtml(system.ffmpegSource || '系统内置')})`);
    if (system.ffmpegPath) {
      sysCard.push(`路径：<code>${escapeHtml(system.ffmpegPath)}</code>`);
    }
  }
  lines.push(`<blockquote>${sysCard.join('\n')}</blockquote>`);

  const statsCard = [
    `<b>📈 任务统计</b>`,
    `🏠 总计: <b>${stats.totalTasks ?? 0}</b>  ｜  ✅ 运行: <b>${stats.enabledTasks ?? 0}</b>  ｜  🛑 暂停: <b>${stats.disabledTasks ?? 0}</b>`,
    `⚙️ 活跃推流: <b>${stats.activeStreams ?? 0} 路</b>  ｜  🔍 房间监听: <b>${stats.totalMonitoring ?? 0} 个</b>`,
    `📤 推流线路: <b>${stats.totalTargets ?? 0} 条</b>`,
    `🎬 全局视频: ${system.transcodeVideo ? 'libx264 转码' : '原画直推 (copy)'}  ｜  🔊 音频修复: ${system.transcodeAudio ? 'AAC 48kHz' : '直推 (copy)'}`,
  ];
  lines.push(`<blockquote>${statsCard.join('\n')}</blockquote>`);

  if (recentErrors.length > 0) {
    const errCard = [`<b>⚠️ 最近警告</b>`];
    recentErrors.slice(0, 5).forEach((err, idx) => {
      errCard.push(`${idx + 1}. ${escapeHtml(err)}`);
    });
    lines.push(`<blockquote>${errCard.join('\n')}</blockquote>`);
  } else {
    lines.push('');
    lines.push(`🟢 <b>状态诊断</b>：全链路正常运行，无错误告警`);
  }

  return lines.join('\n');
}

/**
 * 📊 推流状态：单条汇总看板（彻底避免多房间连发多张图刷屏）
 */
function renderStatusList(entries = []) {
  if (entries.length === 0) {
    return [
      '<b>📊 推流状态总览</b>',
      '',
      '<blockquote>📭 <b>当前还没有配置任何直播房间</b>',
      '添加直播间并开启监控后，这里将实时聚合各路推流码率、开播时长与流量统计。</blockquote>',
      '',
      '<i>💡 点击下方按钮立即添加房间</i>',
    ].join('\n');
  }
  const sorted = sortTasksByActivity(entries);
  const liveCount = sorted.filter((e) => e.traffic?.running).length;
  const enabledCount = sorted.filter((e) => e.status === 'ENABLED').length;
  const totalKbps = sorted.reduce((sum, e) => sum + Math.round(e.traffic?.bitrateKbps || 0), 0);

  const lines = [
    '<b>📊 推流状态总览</b>',
    `<code>🟢 ${liveCount} 推流中</code> · <code>⚪ ${Math.max(0, enabledCount - liveCount)} 待机</code> · <code>🛑 ${sorted.length - enabledCount} 暂停</code> · ⚡ <code>${totalKbps} kbps</code>`,
    '',
  ];

  const cardLines = [];
  sorted.forEach((entry, idx) => {
    const traffic = entry.traffic || {};
    const roomInfo = traffic.roomInfo || {};
    const running = Boolean(traffic.running);
    const kbps = Math.round(traffic.bitrateKbps || 0);
    const icon = entry.status !== 'ENABLED' ? '🛑' : running ? '🟢' : '⚪';
    const host = roomInfo.hostName ? ` · ${escapeHtml(roomInfo.hostName)}` : '';
    const title = roomInfo.roomName ? `\n   <i>${escapeHtml(roomInfo.roomName)}</i>` : '';
    const runtime = running && traffic.startedAt
      ? formatUptime((Date.now() - new Date(traffic.startedAt).getTime()) / 1000)
      : null;
    const stateDesc = entry.status !== 'ENABLED'
      ? '已暂停'
      : running
        ? `<code>${kbps} kbps</code> · ${runtime || '推流中'} · ${formatBytes(traffic.sessionBytes || 0)}`
        : '<i>等待开播</i>';

    cardLines.push(`${idx + 1}. ${icon} <b>${escapeHtml(platformLabel(entry.platform))}</b> <code>#${escapeHtml(entry.room_id)}</code>${host}`);
    cardLines.push(`   ${stateDesc}${title}`);
  });
  lines.push(`<blockquote>${cardLines.join('\n')}</blockquote>`);

  lines.push('');
  lines.push('<i>👇 点击下方房间查看实时封面与详情</i>');
  return lines.join('\n');
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
    lines.push(`  流量：本次 ${formatBytes(traffic.sessionBytes || 0)} / 累计 ${formatBytes(traffic.totalBytes || 0)}`);
    lines.push(`  错误：${traffic.errorCount || 0} 次`);
    if (traffic.lastSuccessAt) {
      lines.push(`  成功：${new Date(traffic.lastSuccessAt).toLocaleString('zh-CN', { hour12: false })}`);
    }
    lines.push('');
  });

  return lines.join('\n');
}

const NOTIFICATION_TYPES = [
  { key: 'notify_live_start',   label: '🟢 开播通知', desc: '主播开播时推送封面或实况' },
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

function renderDiagnoseReport(task, diag) {
  const label = `${escapeHtml(platformLabel(task.platform))} #${escapeHtml(task.room_id)}`;
  const encDesc = diag.encoding?.transcodeVideo
    ? 'libx264 视频转码 + AAC 48kHz 双声道'
    : diag.encoding?.transcodeAudio
      ? '原画视频直推 (Copy) + AAC 48kHz 音频修复'
      : '音视频原画直推 (Copy 零CPU)';

  if (!diag.ok) {
    return [
      `<b>🩺 房间源流 &amp; Cookie 诊断报告</b>`,
      `房间：<b>${label}</b>`,
      '',
      `❌ <b>平台接口连通失败</b>（耗时 ${diag.latencyMs}ms）`,
      `原因：<code>${escapeHtml(diag.error || '未知错误')}</code>`,
      `🍪 Cookie 状态：${escapeHtml(diag.cookieSource)}`,
      `🎬 当前编码策略：${escapeHtml(encDesc)}`,
      '',
      `<i>💡 建议检查房间号是否正确，或点击「🍪 房间Cookie」更新该房间 Cookie。</i>`,
    ].join('\n');
  }

  const info = diag.info || {};
  const lines = [
    `<b>🩺 房间源流 &amp; Cookie 诊断报告</b>`,
    `房间：<b>${label}</b>`,
    '',
    `<b>1️⃣ 平台 API 连通性</b>：✅ 正常 (${diag.latencyMs} ms)`,
    `  · 主播昵称：<b>${escapeHtml(info.hostName || '未知')}</b>`,
    `  · 房间标题：${escapeHtml(info.roomName || '无')}`,
    `  · 开播状态：${info.isLive ? '🟢 <b>正在直播中</b>' : '⚪ 未开播（待机中）'}`,
    '',
    `<b>2️⃣ 身份凭证 &amp; 编码策略</b>`,
    `  · Cookie 来源：${escapeHtml(diag.cookieSource)}`,
    `  · 生效编码器：<b>${escapeHtml(encDesc)}</b>`,
  ];

  lines.push('');
  lines.push(`<b>3️⃣ 源流线路探测</b>`);
  if (!info.isLive) {
    lines.push(`  · 主播当前未开播，开播后将自动拉取最高可用画质流。`);
  } else if (diag.streamError) {
    lines.push(`  · ❌ 拉取源流失败：<code>${escapeHtml(diag.streamError)}</code>`);
  } else {
    lines.push(`  · 可用 CDN 线路：<b>${diag.streamCount} 条</b>（主备自动容灾）`);
    lines.push(`  · 封装协议：<b>${escapeHtml(diag.protocol)}</b>`);
    if (diag.sampleHost) {
      lines.push(`  · 首选节点：<code>${escapeHtml(diag.sampleHost)}</code>`);
    }
    if (diag.hasHevcHint && !diag.encoding?.transcodeVideo) {
      lines.push(`  · ⚠️ <b>检测到 H.265/HEVC 迹象</b>：若目标 RTMP 平台不支持 Enhanced RTMP，建议点「🎬 编码模式」切换为「视频转码」`);
    } else {
      lines.push(`  · ✅ 编码兼容性良好`);
    }
  }

  return lines.join('\n');
}

function renderWaveChartCaption({
  task,
  windowInfo,
  sessions = [],
  unicodeWave = '',
  avgKbps = null,
  peakKbps = null,
  currentKbps = null,
}) {
  const host = task?.traffic?.roomInfo?.hostName
    ? ` · ${escapeHtml(task.traffic.roomInfo.hostName)}`
    : '';
  const titleLabel = task
    ? `${escapeHtml(platformLabel(task.platform))} #${escapeHtml(task.room_id)}${host}`
    : '全局汇总（全部房间）';

  const isMinute = Boolean(windowInfo?.isMinuteScale);
  const headerTitle = isMinute
    ? `<b>📈 推流码率曲线</b> · <b>${titleLabel}</b>`
    : `<b>📈 24小时推流码率波浪曲线</b> · <b>${titleLabel}</b>`;

  const metaLines = [
    `🕒 窗口：<code>${escapeHtml(windowInfo?.label || '')}</code>`,
  ];
  const liveK = currentKbps != null ? Math.round(currentKbps) : Math.round(task?.traffic?.bitrateKbps || 0);
  const avgK = avgKbps != null
    ? Math.round(avgKbps)
    : (sessions.length > 0
      ? Math.round(sessions.reduce((s, it) => s + it.avgKbps, 0) / sessions.length)
      : 0);
  const peakK = peakKbps != null
    ? Math.round(peakKbps)
    : sessions.reduce((m, it) => Math.max(m, it.peakKbps || 0), 0);

  if (liveK > 0 || avgK > 0 || peakK > 0) {
    const nowText = liveK > 0 ? `${liveK}k` : 'OFF';
    metaLines.push(`⚡ 实时 <code>${nowText}</code> · 均值 <code>${avgK}k</code> · 峰值 <code>${peakK}k</code>`);
  }
  if (unicodeWave) {
    metaLines.push(`🌊 走势：<code>${escapeHtml(unicodeWave)}</code>`);
  }

  const lines = [
    headerTitle,
    `<blockquote>${metaLines.join('\n')}</blockquote>`,
  ];

  if (sessions.length === 0) {
    lines.push(
      isMinute
        ? `📭 <b>当前时段内暂无推流采样记录</b>（可切换更大时间窗口查看）`
        : `📭 <b>本 24 小时周期内暂无开播推流记录</b>`
    );
    lines.push(`<i>推流启动后系统每 30 秒自动采样一次，自动追踪码率波动与开播场次</i>`);
  } else {
    const totalMin = sessions.reduce((s, item) => s + item.durationMin, 0);
    const maxPeak = sessions.reduce((m, item) => Math.max(m, item.peakKbps), 0);
    const sessionLines = [
      `🎬 <b>本时段共开播 ${sessions.length} 场</b>（累计 ${totalMin} 分钟 · 峰值 ${maxPeak} kbps）`,
    ];
    sessions.slice(0, 6).forEach((sess) => {
      const h = Math.floor(sess.durationMin / 60);
      const m = sess.durationMin % 60;
      const durStr = h > 0 ? `${h}h${m}m` : `${m}m`;
      sessionLines.push(
        `  <b>#${sess.index}场</b> <code>${sess.startTimeStr}-${sess.endTimeStr}</code> (${durStr}) · 均 <b>${sess.avgKbps}k</b> / 峰 <b>${sess.peakKbps}k</b> · ~${formatBytes(sess.estimatedBytes)}`
      );
    });
    if (sessions.length > 6) {
      sessionLines.push(`  <i>…其余 ${sessions.length - 6} 场已显示在上方曲线图中</i>`);
    }
    lines.push(`<blockquote>${sessionLines.join('\n')}</blockquote>`);
  }

  return lines.join('\n');
}

module.exports = {
  platformLabel,
  transcodeModeLabel,
  nextTranscodeMode,
  escapeHtml,
  humanizeError,
  sortTasksByActivity,
  filterTasksByState,
  renderRoomList,
  renderCurveRoomPicker,
  renderQuickSnapEmpty,
  renderSnapshotCaption,
  renderTaskDetail,
  renderDeleteConfirm,
  renderDashboard,
  renderRoomTraffic,
  renderDetailedStatus,
  renderStatusList,
  renderDiagnoseReport,
  renderWaveChartCaption,
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
