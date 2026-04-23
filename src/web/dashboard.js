/**
 * Web 面板视图模板
 * 流量监控仪表盘 HTML 生成
 */

function renderDashboard() {
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>StreamOps 🚀 监控面板</title>
  <style>
    :root {
      --bg: #0a0b0e;
      --card-bg: #161b22;
      --primary: #00f2fe;
      --secondary: #4facfe;
      --success: #00ff88;
      --error: #ff4b2b;
      --text: #e6edf3;
      --text-dim: #8b949e;
    }
    body { 
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; 
      margin: 0; 
      background: var(--bg); 
      color: var(--text);
      display: flex;
      flex-direction: column;
      align-items: center;
      min-height: 100vh;
    }
    header {
      width: 100%;
      padding: 40px 0;
      background: linear-gradient(135deg, var(--secondary) 0%, var(--primary) 100%);
      text-align: center;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
      margin-bottom: 40px;
    }
    h1 { margin: 0; font-size: 2.5rem; letter-spacing: -1px; text-shadow: 0 2px 4px rgba(0,0,0,0.3); }
    #summary { 
      margin-top: 10px; 
      font-size: 1.1rem; 
      opacity: 0.9;
      font-weight: 300;
    }
    .container { width: 90%; max-width: 1200px; padding-bottom: 50px; }
    #tasks { 
      display: grid; 
      grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); 
      gap: 25px; 
      list-style: none; 
      padding: 0; 
    }
    .card { 
      background: var(--card-bg); 
      border-radius: 16px; 
      padding: 24px; 
      position: relative;
      overflow: hidden;
      transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275), box-shadow 0.3s ease;
      border: 1px solid rgba(255,255,255,0.05);
      display: flex;
      flex-direction: column;
    }
    .card:hover { 
      transform: translateY(-5px); 
      box-shadow: 0 15px 35px rgba(0,0,0,0.4);
      border-color: rgba(0,242,254,0.3);
    }
    .card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; width: 4px; height: 100%;
      background: var(--success);
      opacity: 0.8;
    }
    .card.offline::before { background: var(--text-dim); }
    
    .card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 15px; }
    .platform-tag { 
      background: rgba(0,242,254,0.1); 
      color: var(--primary); 
      padding: 4px 10px; 
      border-radius: 6px; 
      font-size: 0.75rem; 
      font-weight: bold; 
      text-transform: uppercase;
    }
    .room-id { color: var(--text-dim); font-size: 0.85rem; }
    
    .anchor-info { margin-bottom: 20px; }
    .anchor-name { font-size: 1.25rem; font-weight: 600; margin-bottom: 4px; display: block; }
    .stream-title { font-size: 0.9rem; color: var(--text-dim); display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    
    .stats-grid { 
      display: grid; 
      grid-template-columns: 1fr 1fr; 
      gap: 15px; 
      margin-top: auto; 
      border-top: 1px solid rgba(255,255,255,0.05);
      padding-top: 15px;
    }
    .stat-item { display: flex; flex-direction: column; }
    .stat-label { font-size: 0.7rem; color: var(--text-dim); text-transform: uppercase; margin-bottom: 2px; }
    .stat-value { font-size: 1rem; font-weight: 500; }
    .bitrate-value { color: var(--success); }
    .error-value { color: var(--error); }
    
    .status-badge {
      position: absolute;
      top: 24px; right: 24px;
      width: 10px; height: 10px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 10px var(--success);
    }
    .offline .status-badge { background: var(--text-dim); box-shadow: none; }
    
    footer { margin-top: auto; padding: 30px; color: var(--text-dim); font-size: 0.8rem; text-align: center; }
  </style>
</head>
<body>
  <header>
    <h1>StreamOps 🚀</h1>
    <div id="summary">连接中...</div>
  </header>
  
  <div class="container">
    <ul id="tasks"></ul>
  </div>

  <footer>
    自动刷新频率: 10s | 数据实时同步中
  </footer>

  <script>
    function formatTime(iso) {
      if (!iso) return '—';
      return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    }
    
    function formatDuration(startedAt) {
      if (!startedAt) return '未开始';
      const diff = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
      const m = Math.floor(diff / 60);
      const h = Math.floor(m / 60);
      return h > 0 ? (h + 'h ' + (m % 60) + 'm') : ((m % 60) + 'm ' + (diff % 60) + 's');
    }

    async function update() {
      try {
        const res = await fetch('/api/flow');
        const data = await res.json();
        
        const totalKbps = Math.round(data.totalBitrate || 0);
        const totalMbps = (totalKbps / 1024).toFixed(1);
        document.getElementById('summary').innerHTML = 
          '活跃任务: <strong>' + data.active + '</strong> &nbsp; | &nbsp; 总带宽: <strong>' + totalMbps + ' Mbps</strong>';
        
        const tasksHtml = (data.tasks || []).map(t => {
          const kbps = Math.round(t.bitrateKbps || 0);
          const isRunning = kbps > 0 || t.startedAt;
          const isOffline = t.status !== 'ENABLED' || (!isRunning);
          const cls = isOffline ? 'card offline' : 'card';
          
          const info = t.roomInfo || {};
          const host = info.hostName || '未知主播';
          const title = info.roomName || '无标题';

          return \`
            <li class="\${cls}">
              <div class="status-badge"></div>
              <div class="card-header">
                <span class="platform-tag">\${t.platform}</span>
                <span class="room-id">#\${t.room_id}</span>
              </div>
              <div class="anchor-info">
                <span class="anchor-name">\${host}</span>
                <span class="stream-title" title="\${title}">\${title}</span>
              </div>
              <div class="stats-grid">
                <div class="stat-item">
                  <span class="stat-label">当前码率</span>
                  <span class="stat-value bitrate-value">\${kbps} kbps</span>
                </div>
                <div class="stat-item">
                  <span class="stat-label">直播时长</span>
                  <span class="stat-value">\${formatDuration(t.startedAt)}</span>
                </div>
                <div class="stat-item">
                  <span class="stat-label">异常统计</span>
                  <span class="stat-value \${t.errorCount > 0 ? 'error-value' : ''}">\${t.errorCount || 0} 次</span>
                </div>
                <div class="stat-item">
                  <span class="stat-label">最后成功</span>
                  <span class="stat-value">\${formatTime(t.lastSuccessAt)}</span>
                </div>
              </div>
            </li>\`;
        }).join('');
        document.getElementById('tasks').innerHTML = tasksHtml || '<div style="grid-column: 1/-1; text-align: center; opacity: 0.5;">暂无活跃转播任务</div>';
      } catch (e) {
        document.getElementById('summary').innerHTML = '<span style="color:var(--error)">同步数据失败，请检查网络</span>';
      }
    }
    update();
    setInterval(update, 10000);
  </script>
</body>
</html>
  `.trim();
}

module.exports = { renderDashboard };
