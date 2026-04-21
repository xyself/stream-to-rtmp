/**
 * Web 面板视图模板
 * 流量监控仪表盘 HTML 生成
 */

function renderDashboard() {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>流量监控</title>
  <style>
    body { font-family: monospace; margin: 20px; background: #000; color: #0f0; }
    #summary { font-size: 18px; font-weight: bold; margin-bottom: 10px; }
    #tasks { list-style: none; padding: 0; }
    #tasks li { margin: 5px 0; padding: 5px; background: #111; border-left: 3px solid #0f0; }
    .platform { color: #0ff; }
    .bitrate { color: #ff0; }
    .offline { border-left-color: #666 !important; color: #666; }
    .offline .platform { color: #888; }
  </style>
</head>
<body>
  <h1>📊 实时流量</h1>
  <div id="summary">加载中...</div>
  <ul id="tasks"></ul>
  <p style="color: #888; font-size: 12px;">每 10 分钟刷新</p>
  <script>
    async function update() {
      try {
        const res = await fetch('/api/flow');
        const data = await res.json();
        const totalKbps = Math.round(data.totalBitrate || 0);
        const totalMbps = (totalKbps / 1024).toFixed(1);
        document.getElementById('summary').innerHTML = 
          \`转播中: \${data.active} 个 | 总码率: \${totalMbps} Mbps (\${totalKbps} kbps)\`;
        
        const tasksHtml = (data.tasks || []).map(t => {
          const kbps = Math.round(t.bitrateKbps || 0);
          const mbps = (kbps / 1024).toFixed(2);
          const isOffline = t.status !== 'ENABLED' || kbps === 0;
          const cls = isOffline ? 'offline' : '';
          const rateText = kbps > 0 ? \`<span class="bitrate">\${mbps} Mbps</span>\` : '<span class="bitrate">离线</span>';
          return \`<li class="\${cls}"><span class="platform">\${t.platform}</span> #\${t.room_id} | \${rateText}</li>\`;
        }).join('');
        document.getElementById('tasks').innerHTML = tasksHtml || '<li style="border-left-color:#666">无活跃任务</li>';
      } catch (e) {
        document.getElementById('summary').innerHTML = '获取数据失败';
      }
    }
    update();
    setInterval(update, 600000);
  </script>
</body>
</html>
  `.trim();
}

module.exports = { renderDashboard };
