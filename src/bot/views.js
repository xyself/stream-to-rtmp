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

function renderRoomList(tasks = []) {
  if (tasks.length === 0) {
    return '<b>📭 房间管理</b>\n\n当前还没有已配置房间\n点击「➕ 添加房间」开始创建';
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

  const lines = [
    `<b>🏠 房间管理</b> · 共 ${tasks.length} 个房间`,
    '',
  ];

  const renderGroup = (icon, title, group, detail) => {
    if (group.length === 0) return;
    lines.push(`${icon} <b>${title}</b>（${group.length}）`);
    for (const task of group) {
      const host = task.traffic?.roomInfo?.hostName
        ? ` (${escapeHtml(task.traffic.roomInfo.hostName)})`
        : '';
      const cookieTag = task.cookie ? ' 🍪' : '';
      lines.push(`▪️ ${escapeHtml(platformLabel(task.platform))} #${escapeHtml(task.room_id)}${host}${cookieTag}${detail(task)}`);
    }
    lines.push('');
  };

  renderGroup('🟢', '推流中', live, (t) => {
    const kbps = Math.round(t.traffic?.bitrateKbps || 0);
    return kbps > 0 ? ` · ${kbps} kbps` : '';
  });
  renderGroup('⚪', '待机 / 轮询中', idle, () => ' · 等待开播');
  renderGroup('🛑', '已暂停', paused, () => '');

  lines.push('<i>点下方按钮进入单房间全功能控制台</i>');
  return lines.join('\n');
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
    `${statusLabel(task.status)}  ·  FFmpeg ${running ? '✅ 推流中' : '⚪ 待机'}`,
  ];

  if (roomInfo.hostName || roomInfo.roomName) {
    lines.push('');
    if (roomInfo.hostName) lines.push(`👤 主播：<b>${escapeHtml(roomInfo.hostName)}</b>`);
    if (roomInfo.roomName) lines.push(`📝 标题：${escapeHtml(roomInfo.roomName)}`);
  }

  lines.push('');
  lines.push(`<b>📊 实时遥测 & 房间策略</b>`);
  lines.push(`  ⚡ 码率：${kbps > 0 ? `${kbps} kbps` : '0 kbps'}  ｜  ⏱️ 时长：${duration}`);
  lines.push(`  📤 本场：${formatBytes(traffic.sessionBytes || 0)}  ｜  📦 累计：${formatBytes(traffic.totalBytes || 0)}`);
  lines.push(`  🎬 编码策略：<b>${escapeHtml(modeLabel)}</b>`);
  lines.push(`  🍪 房间Cookie：${hasRoomCookie ? `✅ 已独立配置 (${String(task.cookie).length} 字符)` : '⚪ 未配置 (默认)'}`);
  if ((traffic.errorCount || 0) > 0) {
    lines.push(`  ⚠️ 累计错误：${traffic.errorCount} 次`);
  }

  lines.push('');
  if (targetUrls.length > 0) {
    lines.push(`<b>📤 推流地址 (${targetUrls.length})</b>`);
    targetUrls.forEach((url, idx) => {
      lines.push('');
      if (idx === 0) {
        lines.push(`<b>${idx + 1}.</b> ⭐主推流`);
      } else {
        lines.push(`<b>${idx + 1}.</b> 备用线路 #${idx}`);
      }
      lines.push(`<code>${escapeHtml(url)}</code>`);
    });
  } else {
    lines.push(`<b>📤 推流地址</b>：未配置`);
  }

  if (task.last_error && task.last_error !== 'STREAM_ENDED') {
    lines.push('');
    lines.push(`⚠️ ${escapeHtml(task.last_error)}`);
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

  if (system.runtimeLabel || system.nodeVersion) {
    const envTag = system.runtimeLabel ? escapeHtml(system.runtimeLabel) : 'Linux';
    const nodeTag = system.nodeVersion ? ` · Node ${escapeHtml(system.nodeVersion)}` : '';
    lines.push(`🌐 环境：<code>${envTag}${nodeTag}</code>`);
  }

  lines.push('');
  lines.push(`<b>🖥️ 服务器与配额状态</b>`);

  const cpuExtra = system.cpuLabel ? ` (${escapeHtml(system.cpuLabel)})` : '';
  lines.push(`  CPU：[${system.cpuBar || '░░░░░░░░░░'}] ${system.cpuPercent ?? 0}%${cpuExtra}`);

  const ramExtra = system.memLabel ? ` (${system.memPct ?? 0}% · ${escapeHtml(system.memLabel)})` : (system.memPct != null ? ` (${system.memPct}%)` : '');
  lines.push(`  RAM：${escapeHtml(system.memUsed || '?')} / ${escapeHtml(system.memTotal || '?')}${ramExtra}`);

  if (system.disk) {
    const diskLabel = system.disk.label ? ` · ${escapeHtml(system.disk.label)}` : '';
    lines.push(`  DISK：${escapeHtml(system.disk.used)} / ${escapeHtml(system.disk.total)} (${system.disk.pct}%${diskLabel})`);
  }

  if (system.processes) {
    lines.push(`  PROC：${system.processes.used} / ${system.processes.limit} 进程 (${system.processes.pct}% · 限额 ${system.processes.limit})`);
  }

  const heapTag = system.heapUsed ? ` (V8堆 ${escapeHtml(system.heapUsed)})` : '';
  lines.push(`  SVC：服务占用 ${escapeHtml(system.serviceMem || '?')}${heapTag}`);

  if (system.dbSize) {
    lines.push(`  DB：${escapeHtml(system.dbSize)} (SQLite)`);
  }
  if (system.ffmpegVersion) {
    const customBadge = system.ffmpegCustomBinary ? '✅ 自定义/内置' : 'ℹ️ 系统PATH';
    lines.push(`  FFmpeg：<code>${escapeHtml(system.ffmpegVersion)}</code> · ${customBadge} (${escapeHtml(system.ffmpegSource || '系统内置')})`);
    if (system.ffmpegPath) {
      lines.push(`  路径：<code>${escapeHtml(system.ffmpegPath)}</code>`);
    }
  }

  lines.push('');
  lines.push(`<b>📈 任务统计</b>`);
  lines.push(`  🏠 总计: ${stats.totalTasks ?? 0}  ｜  ✅ 运行: ${stats.enabledTasks ?? 0}  ｜  🛑 暂停: ${stats.disabledTasks ?? 0}`);
  lines.push(`  ⚙️ 活跃推流: ${stats.activeStreams ?? 0} 路  ｜  🔍 房间监听: ${stats.totalMonitoring ?? 0} 个`);
  lines.push(`  📤 推流线路: ${stats.totalTargets ?? 0} 条`);
  lines.push(`  🎬 全局视频: ${system.transcodeVideo ? 'libx264 转码' : '原画直推 (copy)'}  ｜  🔊 音频修复: ${system.transcodeAudio ? 'AAC 48kHz' : '直推 (copy)'}`);

  if (recentErrors.length > 0) {
    lines.push('');
    lines.push(`<b>⚠️ 最近警告</b>`);
    recentErrors.slice(0, 5).forEach((err, idx) => {
      lines.push(`  ${idx + 1}. ${escapeHtml(err)}`);
    });
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
    return '<b>📊 推流状态</b>\n\n当前还没有配置任何直播房间。';
  }
  const liveCount = entries.filter((e) => e.traffic?.running).length;
  const enabledCount = entries.filter((e) => e.status === 'ENABLED').length;
  const totalKbps = entries.reduce((sum, e) => sum + Math.round(e.traffic?.bitrateKbps || 0), 0);

  const lines = [
    '<b>📊 推流状态总览</b>',
    `🟢 <b>${liveCount}</b> 路推流中 · ⚪ <b>${Math.max(0, enabledCount - liveCount)}</b> 待机 · 🛑 <b>${entries.length - enabledCount}</b> 暂停`,
    `⚡ 总实时码率：<b>${totalKbps} kbps</b>`,
    '',
  ];

  entries.forEach((entry, idx) => {
    const traffic = entry.traffic || {};
    const roomInfo = traffic.roomInfo || {};
    const running = Boolean(traffic.running);
    const kbps = Math.round(traffic.bitrateKbps || 0);
    const icon = entry.status !== 'ENABLED' ? '🛑' : running ? '🟢' : '⚪';
    const host = roomInfo.hostName ? ` · ${escapeHtml(roomInfo.hostName)}` : '';
    const title = roomInfo.roomName ? `\n     <i>${escapeHtml(roomInfo.roomName)}</i>` : '';
    const runtime = running && traffic.startedAt
      ? formatUptime((Date.now() - new Date(traffic.startedAt).getTime()) / 1000)
      : null;
    const stateDesc = entry.status !== 'ENABLED'
      ? '已暂停'
      : running
        ? `${kbps} kbps · ${runtime || '推流中'} · ${formatBytes(traffic.sessionBytes || 0)}`
        : '等待开播';

    lines.push(`${idx + 1}. ${icon} <b>${escapeHtml(platformLabel(entry.platform))} #${escapeHtml(entry.room_id)}</b>${host}`);
    lines.push(`     ${stateDesc}${title}`);
  });

  lines.push('');
  lines.push('<i>👇 点击下方房间查看实时封面与详情：</i>');
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

function renderWaveChartCaption({ task, windowInfo, sessions = [], unicodeWave = '' }) {
  const titleLabel = task
    ? `${escapeHtml(platformLabel(task.platform))} #${escapeHtml(task.room_id)}`
    : '全局汇总（全部房间）';

  const lines = [
    `<b>📈 24小时推流码率波浪曲线</b> · <b>${titleLabel}</b>`,
    `🕒 周期：<code>${escapeHtml(windowInfo.label)}</code>`,
    `🌊 24h 波浪缩略：<code>${escapeHtml(unicodeWave)}</code>`,
    '',
  ];

  if (sessions.length === 0) {
    lines.push(`📭 <b>本 24 小时周期内暂无开播推流记录</b>`);
    lines.push(`<i>（推流启动后系统每分钟自动采样，支持跨零点与一天多场次分段统计）</i>`);
  } else {
    const totalMin = sessions.reduce((s, item) => s + item.durationMin, 0);
    const maxPeak = sessions.reduce((m, item) => Math.max(m, item.peakKbps), 0);
    lines.push(`🎬 <b>本周期共开播 ${sessions.length} 场</b>（累计 ${totalMin} 分钟 · 峰值 ${maxPeak} kbps）：`);
    sessions.slice(0, 8).forEach((sess) => {
      const h = Math.floor(sess.durationMin / 60);
      const m = sess.durationMin % 60;
      const durStr = h > 0 ? `${h}h${m}m` : `${m}m`;
      lines.push(
        `  <b>#${sess.index}场</b> <code>${sess.startTimeStr}-${sess.endTimeStr}</code> (${durStr}) · 均 <b>${sess.avgKbps}k</b> / 峰 <b>${sess.peakKbps}k</b> · ~${formatBytes(sess.estimatedBytes)}`
      );
    });
    if (sessions.length > 8) {
      lines.push(`  <i>…其余 ${sessions.length - 8} 场已显示在上方波浪图中</i>`);
    }
  }

  return lines.join('\n');
}

module.exports = {
  platformLabel,
  transcodeModeLabel,
  nextTranscodeMode,
  escapeHtml,
  humanizeError,
  renderRoomList,
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
