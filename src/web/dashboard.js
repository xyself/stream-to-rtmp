/**
 * Web 监控控制台视图模板
 * StreamOps 实时转播监控面板（无隐私泄露：仅展示聚合与脱敏通道指标）
 */

function renderDashboard() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>StreamOps · 直播转播控制台</title>
  <style>
    :root {
      --bg-canvas: #09090b;
      --bg-surface: #111114;
      --bg-elevated: #18181b;
      --bg-hover: #1f1f24;
      --border-hairline: rgba(255, 255, 255, 0.08);
      --border-strong: rgba(255, 255, 255, 0.16);
      --text-primary: #fafafa;
      --text-secondary: #a1a1aa;
      --text-muted: #71717a;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --accent-soft: rgba(59, 130, 246, 0.12);
      --ok: #22c55e;
      --ok-text: #4ade80;
      --ok-soft: rgba(34, 197, 94, 0.12);
      --warn: #f59e0b;
      --warn-text: #fbbf24;
      --warn-soft: rgba(245, 158, 11, 0.12);
      --err: #ef4444;
      --err-text: #f87171;
      --err-soft: rgba(239, 68, 68, 0.12);
      --chart-grid: rgba(255, 255, 255, 0.05);
      --skeleton-a: rgba(255, 255, 255, 0.04);
      --skeleton-b: rgba(255, 255, 255, 0.08);
      --track-bg: rgba(255, 255, 255, 0.10);
      --radius-sm: 6px;
      --radius-md: 8px;
      --radius-lg: 10px;
      --font-sans: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
    }

    html.light {
      --bg-canvas: #f8fafc;
      --bg-surface: #ffffff;
      --bg-elevated: #f1f5f9;
      --bg-hover: #e2e8f0;
      --border-hairline: rgba(15, 23, 42, 0.09);
      --border-strong: rgba(15, 23, 42, 0.18);
      --text-primary: #0f172a;
      --text-secondary: #475569;
      --text-muted: #64748b;
      --accent: #2563eb;
      --accent-hover: #1d4ed8;
      --accent-soft: rgba(37, 99, 235, 0.10);
      --ok: #16a34a;
      --ok-text: #15803d;
      --ok-soft: rgba(22, 163, 74, 0.10);
      --warn: #d97706;
      --warn-text: #b45309;
      --warn-soft: rgba(217, 119, 6, 0.10);
      --err: #dc2626;
      --err-text: #b91c1c;
      --err-soft: rgba(220, 38, 38, 0.10);
      --chart-grid: rgba(15, 23, 42, 0.06);
      --skeleton-a: rgba(15, 23, 42, 0.05);
      --skeleton-b: rgba(15, 23, 42, 0.10);
      --track-bg: rgba(15, 23, 42, 0.10);
    }

    html.theme-switching *, html.theme-switching *::before, html.theme-switching *::after {
      transition: none !important;
    }

    *, *::before, *::after {
      box-sizing: border-box;
    }

    html, body {
      margin: 0;
      padding: 0;
      background: var(--bg-canvas);
      color: var(--text-primary);
      font-family: var(--font-sans);
      font-size: 14px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      min-height: 100vh;
    }

    button, input, select {
      font-family: inherit;
      font-size: inherit;
      color: inherit;
    }

    button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    .tabular {
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
    }

    /* ── App Shell ── */
    .shell {
      display: grid;
      grid-template-columns: 248px minmax(0, 1fr);
      min-height: 100vh;
    }

    /* ── Left Sidebar ── */
    .sidebar {
      background: var(--bg-surface);
      border-right: 1px solid var(--border-hairline);
      padding: 20px 16px;
      display: flex;
      flex-direction: column;
      gap: 24px;
      position: sticky;
      top: 0;
      height: 100vh;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 4px 8px;
      font-size: 16px;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--text-primary);
      white-space: nowrap;
    }

    .brand-mark {
      width: 24px;
      height: 24px;
      border-radius: 6px;
      background: var(--accent);
      color: #ffffff;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .nav-section-label {
      font-size: 12px;
      font-weight: 500;
      color: var(--text-muted);
      padding: 0 10px;
      margin-bottom: 6px;
    }

    .side-nav {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .side-nav-btn {
      width: 100%;
      min-height: 40px;
      padding: 8px 10px;
      border: 1px solid transparent;
      border-radius: var(--radius-md);
      background: transparent;
      color: var(--text-secondary);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      cursor: pointer;
      font-weight: 500;
      text-align: left;
      white-space: nowrap;
      transition: background 150ms var(--ease-out), color 150ms var(--ease-out), border-color 150ms var(--ease-out);
    }

    .side-nav-btn:hover {
      background: var(--bg-elevated);
      color: var(--text-primary);
    }

    .side-nav-btn.active {
      background: var(--bg-elevated);
      border-color: var(--border-hairline);
      color: var(--text-primary);
    }

    .side-nav-left {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .side-nav-count {
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
      font-size: 12px;
      color: var(--text-muted);
    }

    .sidebar-controls {
      margin-top: auto;
      padding-top: 16px;
      border-top: 1px solid var(--border-hairline);
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .control-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 0 4px;
    }

    .control-label {
      font-size: 12px;
      color: var(--text-secondary);
      white-space: nowrap;
    }

    .select-compact, .theme-btn {
      min-height: 34px;
      padding: 6px 10px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-hairline);
      background: var(--bg-elevated);
      color: var(--text-primary);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      transition: border-color 150ms var(--ease-out), background 150ms var(--ease-out);
    }

    .select-compact:hover, .theme-btn:hover {
      border-color: var(--border-strong);
      background: var(--bg-hover);
    }

    /* ── Main Column ── */
    .main-col {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }

    /* ── 3-Zone Top Header Bar ── */
    .topbar {
      height: 64px;
      padding: 0 28px;
      border-bottom: 1px solid var(--border-hairline);
      background: var(--bg-canvas);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 32px;
      position: sticky;
      top: 0;
      z-index: 20;
    }

    .topbar-left {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .mobile-menu-btn {
      display: none;
      min-width: 40px;
      min-height: 40px;
      padding: 8px;
      border-radius: var(--radius-md);
      border: 1px solid var(--border-hairline);
      background: var(--bg-surface);
      color: var(--text-primary);
      cursor: pointer;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .breadcrumb {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .breadcrumb-root {
      color: var(--text-muted);
      font-weight: 500;
    }

    .breadcrumb-sep {
      color: var(--text-muted);
    }

    .breadcrumb-current {
      color: var(--text-primary);
      font-weight: 600;
    }

    .topbar-status-chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 34px;
      padding: 5px 12px;
      border-radius: var(--radius-md);
      border: 1px solid var(--border-hairline);
      background: var(--bg-surface);
      color: var(--text-secondary);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
      transition: border-color 150ms var(--ease-out), color 150ms var(--ease-out), background 150ms var(--ease-out);
    }

    .topbar-status-chip:hover {
      border-color: var(--border-strong);
      color: var(--text-primary);
      background: var(--bg-elevated);
    }

    .topbar-status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--ok);
      flex-shrink: 0;
    }

    .topbar-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
    }

    .primary-btn {
      min-height: 40px;
      padding: 8px 16px;
      border-radius: var(--radius-md);
      border: 1px solid transparent;
      background: var(--accent);
      color: #ffffff;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      white-space: nowrap;
      flex-shrink: 0;
      transition: background 150ms var(--ease-out), transform 120ms var(--ease-out);
    }

    .primary-btn:hover {
      background: var(--accent-hover);
    }

    .primary-btn:active {
      transform: scale(0.98);
    }

    .primary-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    /* ── Viewport Container ── */
    .viewport {
      width: 100%;
      max-width: 1280px;
      margin: 0 auto;
      padding: 28px;
      display: flex;
      flex-direction: column;
      gap: 24px;
      flex: 1;
    }

    /* ── Page Heading ── */
    .page-head {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }

    .page-title {
      margin: 0;
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--text-primary);
      text-wrap: balance;
    }

    .page-meta {
      margin-top: 4px;
      font-size: 13px;
      color: var(--text-secondary);
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    /* ── KPI Strip (4 Columns, Flat Single Elevation) ── */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 16px;
    }

    .kpi-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-hairline);
      border-radius: var(--radius-lg);
      padding: 18px 20px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .kpi-label {
      font-size: 12px;
      font-weight: 500;
      color: var(--text-secondary);
    }

    .kpi-value {
      font-size: 28px;
      font-weight: 600;
      line-height: 1.15;
      letter-spacing: -0.02em;
      color: var(--text-primary);
    }

    .kpi-sub {
      font-size: 12px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* ── Chart Panel ── */
    .panel {
      background: var(--bg-surface);
      border: 1px solid var(--border-hairline);
      border-radius: var(--radius-lg);
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }

    .panel-title {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .panel-subtitle {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 2px;
    }

    .panel-stats {
      display: flex;
      align-items: center;
      gap: 16px;
      font-size: 12px;
      color: var(--text-secondary);
    }

    .chart-header-controls {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }

    .chart-wrap {
      position: relative;
      width: 100%;
      height: 204px;
    }

    .chart-svg {
      width: 100%;
      height: 100%;
      display: block;
      overflow: visible;
    }

    .chart-tooltip {
      position: absolute;
      pointer-events: none;
      background: var(--bg-elevated);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      padding: 6px 10px;
      font-size: 12px;
      color: var(--text-primary);
      white-space: nowrap;
      opacity: 0;
      transition: opacity 120ms var(--ease-out);
      z-index: 5;
    }

    .curve-sessions-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      padding-top: 10px;
      border-top: 1px solid var(--border-hairline);
      font-size: 12px;
      color: var(--text-secondary);
    }

    .session-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 9px;
      border-radius: var(--radius-sm);
      background: var(--bg-elevated);
      border: 1px solid var(--border-hairline);
      color: var(--text-primary);
      font-size: 11.5px;
      white-space: nowrap;
    }

    .session-swatch {
      width: 8px;
      height: 8px;
      border-radius: 2px;
      flex-shrink: 0;
    }

    /* ── Resource Gauges & Log Console ── */
    .gauge-group {
      display: flex;
      flex-direction: column;
      gap: 14px;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--border-hairline);
    }

    .gauge-item {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .gauge-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 12.5px;
    }

    .gauge-track {
      width: 100%;
      height: 7px;
      border-radius: 4px;
      background: var(--track-bg);
      overflow: hidden;
    }

    .gauge-fill {
      height: 100%;
      border-radius: 4px;
      background: var(--accent);
      transition: width 240ms var(--ease-out), background 240ms var(--ease-out);
    }

    .gauge-fill.warn { background: var(--warn); }
    .gauge-fill.err { background: var(--err); }
    .gauge-fill.ok { background: var(--ok); }

    .log-console {
      background: var(--bg-canvas);
      border: 1px solid var(--border-hairline);
      border-radius: var(--radius-md);
      padding: 12px 14px;
      max-height: 300px;
      overflow-y: auto;
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1.65;
      color: var(--text-secondary);
    }

    .log-line {
      word-break: break-word;
      padding: 1px 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.025);
    }

    .log-line:last-child { border-bottom: none; }
    .log-line.is-err { color: var(--err-text); }
    .log-line.is-warn { color: var(--warn-text); }
    .log-line.is-ok { color: var(--ok-text); }

    /* ── Toolbar & Segmented Filter Controls ── */
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }

    .toolbar-left {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .segmented {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 3px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-hairline);
      border-radius: var(--radius-md);
    }

    .seg-btn {
      min-height: 34px;
      padding: 6px 12px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--text-secondary);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
      transition: background 150ms var(--ease-out), color 150ms var(--ease-out);
    }

    .seg-btn:hover {
      color: var(--text-primary);
    }

    .seg-btn.active {
      background: var(--bg-surface);
      color: var(--text-primary);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
    }

    .toolbar-right {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .search-input {
      min-height: 40px;
      width: 220px;
      padding: 8px 12px;
      border-radius: var(--radius-md);
      border: 1px solid var(--border-hairline);
      background: var(--bg-canvas);
      color: var(--text-primary);
      font-size: 13px;
      transition: border-color 150ms var(--ease-out);
    }

    .search-input::placeholder {
      color: var(--text-muted);
    }

    .search-input:focus {
      outline: none;
      border-color: var(--accent);
    }

    /* ── High-Density Data Table ── */
    .table-scroll {
      width: 100%;
      overflow-x: auto;
      border: 1px solid var(--border-hairline);
      border-radius: var(--radius-md);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 720px;
    }

    th {
      text-align: left;
      padding: 10px 14px;
      font-size: 12px;
      font-weight: 500;
      color: var(--text-muted);
      background: var(--bg-elevated);
      border-bottom: 1px solid var(--border-hairline);
      white-space: nowrap;
    }

    th.num, td.num {
      text-align: right;
    }

    td {
      padding: 11px 14px;
      font-size: 13px;
      color: var(--text-primary);
      border-bottom: 1px solid var(--border-hairline);
      vertical-align: middle;
      white-space: nowrap;
    }

    tbody tr:last-child td {
      border-bottom: none;
    }

    tbody tr.data-row {
      cursor: pointer;
      transition: background 120ms var(--ease-out);
    }

    tbody tr.data-row:hover {
      background: var(--bg-hover);
    }

    .state-tag {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 500;
    }

    .state-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .state-live { color: var(--ok-text); }
    .state-live .state-dot { background: var(--ok); }

    .state-standby { color: var(--warn-text); }
    .state-standby .state-dot { background: var(--warn); }

    .state-paused { color: var(--text-muted); }
    .state-paused .state-dot { background: var(--text-muted); }

    .state-err { color: var(--err-text); }

    .bitrate-cell {
      display: inline-flex;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
    }

    .mini-bar-track {
      width: 56px;
      height: 4px;
      border-radius: 2px;
      background: var(--track-bg);
      overflow: hidden;
      flex-shrink: 0;
    }

    .mini-bar-fill {
      height: 100%;
      background: var(--accent);
      border-radius: 2px;
      transition: width 200ms var(--ease-out);
    }

    .row-action-btn {
      min-height: 32px;
      padding: 4px 10px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-hairline);
      background: transparent;
      color: var(--text-secondary);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      transition: border-color 150ms var(--ease-out), color 150ms var(--ease-out), background 150ms var(--ease-out);
    }

    .row-action-btn:hover {
      border-color: var(--border-strong);
      color: var(--text-primary);
      background: var(--bg-elevated);
    }

    /* ── Card Grid View Mode ── */
    .cards-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
      gap: 16px;
    }

    .channel-card {
      background: var(--bg-canvas);
      border: 1px solid var(--border-hairline);
      border-radius: var(--radius-md);
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      cursor: pointer;
      transition: border-color 150ms var(--ease-out), background 150ms var(--ease-out);
    }

    .channel-card:hover {
      border-color: var(--border-strong);
      background: var(--bg-elevated);
    }

    .channel-card-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .channel-card-metrics {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--border-hairline);
    }

    .metric-pair {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .metric-k {
      font-size: 11px;
      color: var(--text-muted);
    }

    .metric-v {
      font-size: 14px;
      font-weight: 500;
      color: var(--text-primary);
    }

    /* ── Empty / Auth / Skeleton States ── */
    .state-box {
      border: 1px dashed var(--border-strong);
      border-radius: var(--radius-md);
      padding: 40px 24px;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
    }

    .state-box-title {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .state-box-desc {
      margin: 0;
      max-width: 480px;
      font-size: 13px;
      color: var(--text-secondary);
      line-height: 1.6;
    }

    .auth-form {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 8px;
      flex-wrap: wrap;
      justify-content: center;
    }

    .skeleton-row {
      height: 44px;
      border-radius: var(--radius-sm);
      background: linear-gradient(90deg, var(--skeleton-a) 25%, var(--skeleton-b) 50%, var(--skeleton-a) 75%);
      background-size: 200% 100%;
      animation: shimmer 1.4s infinite linear;
      margin-bottom: 8px;
    }

    @keyframes shimmer {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }

    /* ── Detail Drawer ── */
    .drawer-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.55);
      opacity: 0;
      pointer-events: none;
      transition: opacity 180ms var(--ease-out);
      z-index: 40;
    }

    .drawer-backdrop.open {
      opacity: 1;
      pointer-events: auto;
    }

    .drawer {
      position: fixed;
      top: 0;
      right: 0;
      width: min(440px, 100vw);
      height: 100vh;
      background: var(--bg-surface);
      border-left: 1px solid var(--border-hairline);
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 20px;
      transform: translateX(100%);
      transition: transform 200ms var(--ease-out);
      z-index: 50;
      overflow-y: auto;
    }

    .drawer.open {
      transform: translateX(0);
    }

    .drawer-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border-hairline);
    }

    .drawer-list {
      display: flex;
      flex-direction: column;
      border: 1px solid var(--border-hairline);
      border-radius: var(--radius-md);
      overflow: hidden;
    }

    .drawer-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 14px;
      border-bottom: 1px solid var(--border-hairline);
      font-size: 13px;
    }

    .drawer-item:last-child {
      border-bottom: none;
    }

    .drawer-k {
      color: var(--text-secondary);
    }

    /* ── System View Grid ── */
    .system-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
    }

    .kv-list {
      display: flex;
      flex-direction: column;
    }

    .kv-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 0;
      border-bottom: 1px solid var(--border-hairline);
      font-size: 13px;
      gap: 12px;
    }

    .kv-row:last-child {
      border-bottom: none;
    }

    .kv-label {
      color: var(--text-secondary);
    }

    .kv-val {
      color: var(--text-primary);
      font-weight: 500;
      text-align: right;
    }

    /* ── FFmpeg Binary Verification Component ── */
    .ffmpeg-verify-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-hairline);
      border-radius: var(--radius-lg);
      padding: 18px 20px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .ffmpeg-verify-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }

    .ffmpeg-verify-title-group {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .ffmpeg-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: var(--radius-sm);
      font-size: 12px;
      font-weight: 600;
      border: 1px solid transparent;
    }

    .ffmpeg-badge.custom-ok {
      background: var(--ok-soft);
      color: var(--ok-text);
      border-color: rgba(34, 197, 94, 0.28);
    }

    .ffmpeg-badge.system-default {
      background: var(--accent-soft);
      color: var(--accent);
      border-color: rgba(59, 130, 246, 0.28);
    }

    .ffmpeg-verify-grid {
      display: grid;
      grid-template-columns: minmax(180px, 1fr) minmax(280px, 2fr) minmax(220px, 1.3fr);
      gap: 14px;
      align-items: stretch;
    }

    .ffmpeg-meta-box {
      background: var(--bg-canvas);
      border: 1px solid var(--border-hairline);
      border-radius: var(--radius-md);
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 6px;
      min-width: 0;
    }

    .ffmpeg-meta-label {
      font-size: 11px;
      font-weight: 500;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .ffmpeg-meta-main {
      font-size: 15px;
      font-weight: 600;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .ffmpeg-path-code {
      font-family: var(--font-mono);
      font-size: 12.5px;
      color: var(--ok-text);
      background: var(--bg-elevated);
      border: 1px solid var(--border-hairline);
      border-radius: var(--radius-sm);
      padding: 6px 10px;
      overflow-x: auto;
      white-space: nowrap;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }

    .ffmpeg-priority-steps {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      margin-top: 2px;
    }

    .ffmpeg-step-chip {
      font-family: var(--font-mono);
      font-size: 11px;
      padding: 3px 8px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-hairline);
      background: var(--bg-elevated);
      color: var(--text-muted);
      white-space: nowrap;
    }

    .ffmpeg-step-chip.active {
      background: var(--ok-soft);
      color: var(--ok-text);
      border-color: rgba(34, 197, 94, 0.35);
      font-weight: 600;
    }

    /* ── Quiet Footer ── */
    .footer {
      padding: 16px 28px 24px;
      border-top: 1px solid var(--border-hairline);
      color: var(--text-muted);
      font-size: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }

    /* ── Mobile Drawer Sidebar & Responsive ── */
    @media (max-width: 1024px) {
      .kpi-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .system-grid {
        grid-template-columns: 1fr;
      }
      .ffmpeg-verify-grid {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 820px) {
      .shell {
        grid-template-columns: 1fr;
      }
      .sidebar {
        position: fixed;
        left: 0;
        top: 0;
        width: 260px;
        z-index: 60;
        transform: translateX(-100%);
        transition: transform 200ms var(--ease-out);
      }
      .sidebar.open {
        transform: translateX(0);
      }
      .mobile-menu-btn {
        display: inline-flex;
      }
      .topbar {
        padding: 0 16px;
        gap: 12px;
      }
      .topbar-status-chip {
        display: none;
      }
      .viewport {
        padding: 18px 16px;
      }
      .footer {
        padding: 16px;
      }
      .search-input {
        width: 100%;
      }
    }

    @media (max-width: 520px) {
      .kpi-grid {
        grid-template-columns: 1fr;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        transition-duration: 0.01ms !important;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar" id="sidebar" aria-label="主导航">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1"/>
          </svg>
        </span>
        <span>StreamOps</span>
      </div>

      <div>
        <div class="nav-section-label">工作区</div>
        <nav class="side-nav">
          <button type="button" class="side-nav-btn active" data-view="overview">
            <span class="side-nav-left">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>
              <span>实时总览</span>
            </span>
            <span class="side-nav-count" id="nav-count-active">0</span>
          </button>
          <button type="button" class="side-nav-btn" data-view="channels">
            <span class="side-nav-left">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
              <span>推流通道</span>
            </span>
            <span class="side-nav-count" id="nav-count-total">0</span>
          </button>
          <button type="button" class="side-nav-btn" data-view="system">
            <span class="side-nav-left">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
              <span>运行环境</span>
            </span>
          </button>
        </nav>
      </div>

      <div class="sidebar-controls">
        <div class="control-row">
          <label for="poll-interval" class="control-label">轮询周期</label>
          <select id="poll-interval" class="select-compact">
            <option value="5000">5 秒</option>
            <option value="10000" selected>10 秒</option>
            <option value="30000">30 秒</option>
            <option value="0">已暂停</option>
          </select>
        </div>
        <div class="control-row">
          <span class="control-label">界面外观</span>
          <button type="button" id="theme-toggle" class="theme-btn">切换浅色</button>
        </div>
      </div>
    </aside>

    <div class="main-col">
      <!-- 3-Zone Top Bar -->
      <header class="topbar">
        <div class="topbar-left">
          <button type="button" class="mobile-menu-btn" id="mobile-menu-btn" aria-label="打开导航菜单">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
          <div class="breadcrumb">
            <span class="breadcrumb-root">StreamOps</span>
            <span class="breadcrumb-sep">/</span>
            <span class="breadcrumb-current" id="breadcrumb-view">实时总览</span>
          </div>
        </div>

        <div class="topbar-actions">
          <button type="button" class="topbar-status-chip tabular" id="topbar-runtime-chip" title="点击查看 FFmpeg 路径校验、资源水位与实时日志">
            <span class="topbar-status-dot" id="topbar-ff-dot"></span>
            <span id="topbar-ff-summary">FFmpeg 检测中...</span>
          </button>
          <button type="button" class="primary-btn" id="refresh-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            <span id="refresh-label">立即刷新</span>
          </button>
        </div>
      </header>

      <main class="viewport" id="main-viewport">
        <section class="page-head">
          <div>
            <h1 class="page-title" id="view-title">直播转播实时监控</h1>
            <div class="page-meta" id="view-meta">
              <span id="sync-status">正在连接控制面...</span>
            </div>
          </div>
        </section>

        <!-- Auth Gate (only shown when server returns 401) -->
        <section class="panel" id="auth-panel" style="display:none;">
          <div class="state-box">
            <h2 class="state-box-title">需要访问令牌（DASHBOARD_TOKEN）</h2>
            <p class="state-box-desc">当前服务已开启面板鉴权。请输入访问令牌后通过请求头获取实时转播数据，令牌仅保存在当前浏览器会话中。</p>
            <form class="auth-form" id="auth-form">
              <input type="password" id="token-input" class="search-input" placeholder="输入 DASHBOARD_TOKEN" autocomplete="off" required>
              <button type="submit" class="primary-btn">验证并连接</button>
            </form>
            <div id="auth-error" style="color:var(--err-text); font-size:12px; min-height:18px;"></div>
          </div>
        </section>

        <!-- Overview + Channels shared KPI Strip -->
        <section class="kpi-grid" id="kpi-section">
          <div class="kpi-card">
            <span class="kpi-label">活跃推流通道</span>
            <span class="kpi-value tabular" id="kpi-active">—</span>
            <span class="kpi-sub tabular" id="kpi-active-sub">已启用 — 路</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">总输出码率</span>
            <span class="kpi-value tabular" id="kpi-bitrate">—</span>
            <span class="kpi-sub tabular" id="kpi-bitrate-sub">0 kbps 实时聚合</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">本场累计传输</span>
            <span class="kpi-value tabular" id="kpi-bytes">—</span>
            <span class="kpi-sub tabular" id="kpi-targets-sub">推流线路 — 条</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">轮询监控与异常</span>
            <span class="kpi-value tabular" id="kpi-monitoring">—</span>
            <span class="kpi-sub tabular" id="kpi-error-sub">累计异常 0 次</span>
          </div>
        </section>

        <!-- FFmpeg Version & Installation Path Verification Component -->
        <section class="ffmpeg-verify-card" id="ffmpeg-verify-section" aria-label="FFmpeg 二进制版本与路径校验">
          <div class="ffmpeg-verify-top">
            <div class="ffmpeg-verify-title-group">
              <h2 class="panel-title" style="display:inline-flex; align-items:center; gap:8px;">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                <span>FFmpeg 引擎版本与安装路径校验</span>
              </h2>
              <span class="ffmpeg-badge system-default" id="ffmpeg-status-badge">正在检测二进制...</span>
            </div>
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
              <button type="button" class="row-action-btn" id="ffmpeg-probe-btn">重新探测路径</button>
              <button type="button" class="row-action-btn" id="ffmpeg-upgrade-btn">拉取最新静态版 (./bin/ffmpeg)</button>
            </div>
          </div>

          <div class="ffmpeg-verify-grid">
            <div class="ffmpeg-meta-box">
              <div class="ffmpeg-meta-label">
                <span style="white-space:nowrap;">当前生效版本</span>
                <span class="tabular" id="ffmpeg-source-tag" style="color:var(--text-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">—</span>
              </div>
              <div class="ffmpeg-meta-main tabular" id="ffmpeg-ver-value">—</div>
              <div class="panel-subtitle tabular" id="ffmpeg-banner-sub" style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">等待读取 ffmpeg -version 输出</div>
            </div>

            <div class="ffmpeg-meta-box">
              <div class="ffmpeg-meta-label">
                <span>实际安装执行路径 (Resolved Binary Path)</span>
                <button type="button" class="row-action-btn" id="ffmpeg-copy-path-btn" style="min-height:24px; padding:2px 8px; font-size:11px;">复制路径</button>
              </div>
              <div class="ffmpeg-path-code" id="ffmpeg-path-box" title="当前进程实际调用的 FFmpeg 绝对路径">
                <span id="ffmpeg-path-value">—</span>
              </div>
              <div class="panel-subtitle" id="ffmpeg-path-hint">当 .env 中 FFMPEG_PATH 留空时，系统自动优先调用 ./bin/ffmpeg</div>
            </div>

            <div class="ffmpeg-meta-box">
              <div class="ffmpeg-meta-label">
                <span>寻址优先级链路 (Resolution Priority)</span>
              </div>
              <div class="ffmpeg-priority-steps" id="ffmpeg-priority-chain">
                <span class="ffmpeg-step-chip" data-ff-step="env_custom" title="优先级 1：.env 环境变量 FFMPEG_PATH">1. FFMPEG_PATH</span>
                <span class="ffmpeg-step-chip" data-ff-step="bundled_latest" title="优先级 2：项目内置最新版 ./bin/ffmpeg">2. ./bin/ffmpeg</span>
                <span class="ffmpeg-step-chip" data-ff-step="user_home" title="优先级 3：用户目录 ~/bin/ffmpeg">3. ~/bin/ffmpeg</span>
                <span class="ffmpeg-step-chip" data-ff-step="system_path" title="优先级 4：操作系统环境变量 PATH">4. System PATH</span>
              </div>
              <div class="panel-subtitle" id="ffmpeg-action-feedback">亮起项代表当前正在生效的二进制来源</div>
            </div>
          </div>
        </section>

        <!-- Overview Chart (24h SQLite Wave Curve + Realtime 5m Mode) -->
        <section class="panel" id="chart-section">
          <div class="panel-header">
            <div>
              <h2 class="panel-title" id="chart-title">24 小时推流码率波浪线</h2>
              <div class="panel-subtitle" id="chart-subtitle">北京时间 12:00 → 次日 12:00 · 持久化采样</div>
            </div>
            <div class="chart-header-controls">
              <div class="segmented" role="tablist" aria-label="曲线周期切换" id="chart-mode-switch">
                <button type="button" class="seg-btn active" data-curve-mode="noon">24h (12:00→12:00)</button>
                <button type="button" class="seg-btn" data-curve-mode="midnight">今日 0-24 时</button>
                <button type="button" class="seg-btn" data-curve-mode="live">实时 5 分钟</button>
              </div>
              <div class="panel-stats tabular">
                <span>峰值 <strong id="chart-peak">0 kbps</strong></span>
                <span>·</span>
                <span>均值 <strong id="chart-avg">0 kbps</strong></span>
              </div>
            </div>
          </div>
          <div class="chart-wrap" id="chart-wrap">
            <svg class="chart-svg" id="bitrate-chart" viewBox="0 0 800 204" preserveAspectRatio="none" role="img" aria-label="推流码率趋势图"></svg>
            <div class="chart-tooltip tabular" id="chart-tooltip"></div>
          </div>
          <div class="curve-sessions-bar" id="curve-sessions-bar" style="display:none;"></div>
        </section>

        <!-- Channels List / Cards Panel -->
        <section class="panel" id="channels-section">
          <div class="toolbar">
            <div class="toolbar-left">
              <div class="segmented" role="tablist" aria-label="状态筛选">
                <button type="button" class="seg-btn active" data-status="all">全部</button>
                <button type="button" class="seg-btn" data-status="live">推流中</button>
                <button type="button" class="seg-btn" data-status="standby">待机</button>
                <button type="button" class="seg-btn" data-status="paused">已暂停</button>
              </div>
              <select id="platform-filter" class="select-compact" aria-label="平台筛选">
                <option value="all">全部平台</option>
                <option value="bilibili">Bilibili</option>
                <option value="douyu">斗鱼</option>
                <option value="douyin">抖音</option>
              </select>
            </div>
            <div class="toolbar-right">
              <input type="search" id="search-input" class="search-input" placeholder="筛选平台或任务编号..." aria-label="筛选通道">
              <div class="segmented" role="group" aria-label="视图模式">
                <button type="button" class="seg-btn active" data-layout="table">列表</button>
                <button type="button" class="seg-btn" data-layout="cards">卡片</button>
              </div>
            </div>
          </div>

          <div id="channels-body">
            <div class="skeleton-row"></div>
            <div class="skeleton-row"></div>
            <div class="skeleton-row"></div>
          </div>
        </section>

        <!-- System Runtime Panel -->
        <section class="system-grid" id="system-section" style="display:none;">
          <div class="panel">
            <div class="panel-header">
              <div>
                <h2 class="panel-title">运行进程与资源水位</h2>
                <div class="panel-subtitle" id="sys-runtime-sub">实时读取自控制面 /api/flow 接口</div>
              </div>
            </div>

            <div class="gauge-group">
              <div class="gauge-item">
                <div class="gauge-head">
                  <span class="kv-label" id="gauge-mem-label">内存水位</span>
                  <span class="tabular" id="gauge-mem-val">—</span>
                </div>
                <div class="gauge-track"><div class="gauge-fill ok" id="gauge-mem-bar" style="width:0%;"></div></div>
              </div>
              <div class="gauge-item">
                <div class="gauge-head">
                  <span class="kv-label">磁盘水位</span>
                  <span class="tabular" id="gauge-disk-val">—</span>
                </div>
                <div class="gauge-track"><div class="gauge-fill ok" id="gauge-disk-bar" style="width:0%;"></div></div>
              </div>
            </div>

            <div class="kv-list">
              <div class="kv-row">
                <span class="kv-label">运行环境</span>
                <span class="kv-val tabular" id="sys-runtime-env">—</span>
              </div>
              <div class="kv-row">
                <span class="kv-label">服务运行时长</span>
                <span class="kv-val tabular" id="sys-uptime">—</span>
              </div>
              <div class="kv-row">
                <span class="kv-label">Node.js 内存占用 (RSS)</span>
                <span class="kv-val tabular" id="sys-mem">—</span>
              </div>
              <div class="kv-row">
                <span class="kv-label">视频编码模式</span>
                <span class="kv-val" id="sys-transcode">—</span>
              </div>
              <div class="kv-row">
                <span class="kv-label">Node.js 运行时版本</span>
                <span class="kv-val tabular" id="sys-node-ver">—</span>
              </div>
              <div class="kv-row">
                <span class="kv-label">FFmpeg 引擎版本</span>
                <span class="kv-val tabular" id="sys-ffmpeg-ver">—</span>
              </div>
              <div class="kv-row">
                <span class="kv-label">FFmpeg 实际安装路径</span>
                <span class="kv-val tabular" id="sys-ffmpeg-path" style="word-break:break-all;">—</span>
              </div>
              <div class="kv-row">
                <span class="kv-label">FFmpeg 寻址来源</span>
                <span class="kv-val" id="sys-ffmpeg-source">—</span>
              </div>
              <div class="kv-row">
                <span class="kv-label">总配置房间 / 目标线路</span>
                <span class="kv-val tabular" id="sys-capacity">—</span>
              </div>
            </div>
          </div>

          <div class="panel">
            <div class="panel-header">
              <div>
                <h2 class="panel-title">接口与隐私说明</h2>
                <div class="panel-subtitle">遵循房间隐私脱敏策略</div>
              </div>
            </div>
            <div class="kv-list">
              <div class="kv-row">
                <span class="kv-label">健康探针</span>
                <span class="kv-val tabular">GET /health</span>
              </div>
              <div class="kv-row">
                <span class="kv-label">就绪检查</span>
                <span class="kv-val tabular">GET /healthz</span>
              </div>
              <div class="kv-row">
                <span class="kv-label">实时流指标</span>
                <span class="kv-val tabular">GET /api/flow</span>
              </div>
              <div class="kv-row">
                <span class="kv-label">24h 波浪曲线</span>
                <span class="kv-val tabular">GET /api/curve?mode=noon</span>
              </div>
              <div class="kv-row">
                <span class="kv-label">脱敏运行日志</span>
                <span class="kv-val tabular">GET /api/logs?limit=50</span>
              </div>
              <div class="kv-row">
                <span class="kv-label">隐私脱敏边界</span>
                <span class="kv-val">不返回房间号、主播名、ChatID 与推流密钥</span>
              </div>
            </div>
          </div>
        </section>

        <!-- Sanitized Live Logs Panel (System View) -->
        <section class="panel" id="logs-section" style="display:none;">
          <div class="panel-header">
            <div>
              <h2 class="panel-title">运行日志（自动脱敏 · 只读）</h2>
              <div class="panel-subtitle" id="logs-subtitle">最近 50 条内存环形日志 · 已隐藏房间号与 RTMP 推流密钥</div>
            </div>
            <div class="chart-header-controls">
              <div class="segmented" role="tablist" aria-label="日志级别筛选">
                <button type="button" class="seg-btn active" data-log-filter="all">全部日志</button>
                <button type="button" class="seg-btn" data-log-filter="errors">仅警告 / 错误</button>
              </div>
              <button type="button" class="row-action-btn" id="logs-refresh-btn">刷新日志</button>
            </div>
          </div>
          <div class="log-console" id="log-console">正在读取运行日志...</div>
        </section>
      </main>

      <footer class="footer">
        <span>StreamOps Relay Monitor</span>
        <span class="tabular" id="footer-sync">等待首次同步</span>
      </footer>
    </div>
  </div>

  <!-- Channel Detail Drawer -->
  <div class="drawer-backdrop" id="drawer-backdrop"></div>
  <aside class="drawer" id="detail-drawer" aria-label="通道详情" aria-hidden="true">
    <div class="drawer-head">
      <div>
        <div style="font-size:16px; font-weight:600;" id="drawer-title">通道详情</div>
        <div style="font-size:12px; color:var(--text-muted);" id="drawer-sub">匿名通道运行明细</div>
      </div>
      <button type="button" class="row-action-btn" id="drawer-close">关闭</button>
    </div>
    <div class="drawer-list" id="drawer-kv"></div>
    <p style="margin:0; font-size:12px; color:var(--text-muted); line-height:1.6;">
      说明：Web 控制台仅展示脱敏后的运营状态。如需查看完整房间号、抓帧画面或修改推流地址，请在 Telegram 控制中心操作。
    </p>
  </aside>

  <script>
    (function () {
      const HISTORY_KEY = 'streamops_flow_history_v1';
      const THEME_KEY = 'streamops_theme_v1';
      const MAX_POINTS = 30;
      const SESSION_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#06b6d4', '#ec4899'];

      const state = {
        view: 'overview',
        statusFilter: 'all',
        platformFilter: 'all',
        search: '',
        layout: 'table',
        pollMs: 10000,
        timerId: null,
        loading: true,
        unauthorized: false,
        manualToken: '',
        data: null,
        selectedTaskIndex: null,
        history: loadHistory(),
        curveMode: 'noon',
        curveData: null,
        lastCurveFetchAt: 0,
        logFilter: 'all',
        logsData: null,
        logsLoaded: false,
        pausedByVisibility: false,
      };

      const PLATFORM_NAMES = {
        bilibili: 'Bilibili',
        douyu: '斗鱼',
        douyin: '抖音',
      };

      const RUNTIME_NAMES = {
        serv00: 'Serv00 FreeBSD',
        'docker-linux': 'Docker Linux',
        'k8s-linux': 'K8s Linux',
        'container-linux': 'Container Linux',
        linux: 'Linux',
        freebsd: 'FreeBSD',
        darwin: 'macOS',
        win32: 'Windows',
      };

      function esc(s) {
        return String(s ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }

      function platformLabel(p) {
        return PLATFORM_NAMES[String(p || '').toLowerCase()] || String(p || '未知');
      }

      function runtimeLabel(kind) {
        const k = String(kind || '').toLowerCase();
        return RUNTIME_NAMES[k] || String(kind || '未知环境');
      }

      function shortFfmpegVer(ver) {
        const raw = String(ver || '').trim();
        if (!raw || raw === '未知') return '未知';
        const first = raw.split('-')[0];
        return first.length <= 16 ? first : raw.slice(0, 16);
      }

      function formatBytes(bytes) {
        const n = Number(bytes || 0);
        if (!Number.isFinite(n) || n <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
        return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
      }

      function formatDurationSec(sec) {
        const s = Math.max(0, Math.floor(Number(sec || 0)));
        const d = Math.floor(s / 86400);
        const h = Math.floor((s % 86400) / 3600);
        const m = Math.floor((s % 3600) / 60);
        const rem = s % 60;
        if (d > 0) return d + 'd ' + h + 'h ' + m + 'm';
        if (h > 0) return h + 'h ' + m + 'm';
        return m + 'm ' + rem + 's';
      }

      function formatMinutesCn(totalMin) {
        const m = Math.max(0, Math.round(Number(totalMin || 0)));
        const h = Math.floor(m / 60);
        const rem = m % 60;
        if (h > 0) return h + ' 小时 ' + rem + ' 分钟';
        return rem + ' 分钟';
      }

      function formatElapsed(iso) {
        if (!iso) return '—';
        const diff = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
        return formatDurationSec(diff);
      }

      function formatClock(iso) {
        if (!iso) return '—';
        try {
          return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        } catch {
          return '—';
        }
      }

      function formatBeijingHHMM(ms) {
        const d = new Date(Number(ms || 0) + 8 * 3600 * 1000);
        const hh = String(d.getUTCHours()).padStart(2, '0');
        const mm = String(d.getUTCMinutes()).padStart(2, '0');
        return hh + ':' + mm;
      }

      function loadHistory() {
        try {
          const raw = sessionStorage.getItem(HISTORY_KEY);
          const arr = JSON.parse(raw || '[]');
          return Array.isArray(arr) ? arr.slice(-MAX_POINTS) : [];
        } catch {
          return [];
        }
      }

      function saveHistory(points) {
        try {
          sessionStorage.setItem(HISTORY_KEY, JSON.stringify(points.slice(-MAX_POINTS)));
        } catch {}
      }

      function dashboardToken() {
        if (state.manualToken) return state.manualToken;
        try {
          const params = new URLSearchParams(location.search);
          const urlToken = params.get('token');
          if (urlToken) {
            state.manualToken = urlToken;
            sessionStorage.setItem('streamops_token', urlToken);
            params.delete('token');
            const qs = params.toString();
            const cleanUrl = location.pathname + (qs ? '?' + qs : '') + location.hash;
            if (window.history && typeof window.history.replaceState === 'function') {
              window.history.replaceState(null, '', cleanUrl);
            }
            return urlToken;
          }
          return sessionStorage.getItem('streamops_token') || '';
        } catch {
          return '';
        }
      }

      function authHeaders() {
        const token = dashboardToken();
        return token ? { Authorization: 'Bearer ' + token } : {};
      }

      function taskState(t) {
        if (t.status !== 'ENABLED') return 'paused';
        const kbps = Math.round(t.bitrateKbps || 0);
        if (t.running || kbps > 0 || t.startedAt) return 'live';
        return 'standby';
      }

      function taskStateLabel(kind) {
        if (kind === 'live') return '推流中';
        if (kind === 'standby') return '待机中';
        return '已暂停';
      }

      function taskSortRank(t) {
        if (t._kind !== 'paused' && (t.errorCount || 0) > 0) return 0;
        if (t._kind === 'live') return 1;
        if (t._kind === 'standby') return 2;
        return 3;
      }

      function compareTasks(a, b) {
        const ra = taskSortRank(a);
        const rb = taskSortRank(b);
        if (ra !== rb) return ra - rb;
        if (ra === 0) {
          const errDiff = (b.errorCount || 0) - (a.errorCount || 0);
          if (errDiff !== 0) return errDiff;
        }
        const kbpsDiff = Math.round(b.bitrateKbps || 0) - Math.round(a.bitrateKbps || 0);
        if (kbpsDiff !== 0) return kbpsDiff;
        return a._idx - b._idx;
      }

      // ── Theme ──
      function applyTheme(theme) {
        const isLight = theme === 'light';
        document.documentElement.classList.add('theme-switching');
        document.documentElement.classList.toggle('light', isLight);
        void document.documentElement.offsetHeight;
        document.documentElement.classList.remove('theme-switching');
        const btn = document.getElementById('theme-toggle');
        if (btn) btn.textContent = isLight ? '切换深色' : '切换浅色';
        try { localStorage.setItem(THEME_KEY, isLight ? 'light' : 'dark'); } catch {}
      }

      try {
        applyTheme(localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark');
      } catch {
        applyTheme('dark');
      }

      document.getElementById('theme-toggle').addEventListener('click', () => {
        const isLight = document.documentElement.classList.contains('light');
        applyTheme(isLight ? 'dark' : 'light');
      });

      // ── Mobile Sidebar ──
      const sidebar = document.getElementById('sidebar');
      const backdrop = document.getElementById('drawer-backdrop');
      const drawer = document.getElementById('detail-drawer');

      function closeAllOverlays() {
        sidebar.classList.remove('open');
        drawer.classList.remove('open');
        drawer.setAttribute('aria-hidden', 'true');
        backdrop.classList.remove('open');
        state.selectedTaskIndex = null;
      }

      document.getElementById('mobile-menu-btn').addEventListener('click', () => {
        sidebar.classList.add('open');
        backdrop.classList.add('open');
      });
      backdrop.addEventListener('click', closeAllOverlays);
      document.getElementById('drawer-close').addEventListener('click', closeAllOverlays);
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeAllOverlays();
      });

      // ── View Switching ──
      function setView(viewName) {
        state.view = viewName;
        document.querySelectorAll('[data-view]').forEach((btn) => {
          btn.classList.toggle('active', btn.dataset.view === viewName);
        });
        const names = {
          overview: ['实时总览', '直播转播实时监控'],
          channels: ['推流通道', '通道运行明细与筛选'],
          system: ['运行环境', '服务运行时、FFmpeg 与脱敏日志'],
        };
        const [crumb, title] = names[viewName] || names.overview;
        document.getElementById('breadcrumb-view').textContent = crumb;
        document.getElementById('view-title').textContent = title;

        const showKpi = !state.unauthorized && viewName !== 'system';
        const showFfmpegVerify = !state.unauthorized && viewName === 'system';
        const showChart = !state.unauthorized && viewName === 'overview';
        const showChannels = !state.unauthorized && (viewName === 'overview' || viewName === 'channels');
        const showSystem = !state.unauthorized && viewName === 'system';
        const showLogs = !state.unauthorized && viewName === 'system';

        document.getElementById('kpi-section').style.display = showKpi ? '' : 'none';
        document.getElementById('ffmpeg-verify-section').style.display = showFfmpegVerify ? '' : 'none';
        document.getElementById('chart-section').style.display = showChart ? '' : 'none';
        document.getElementById('channels-section').style.display = showChannels ? '' : 'none';
        document.getElementById('system-section').style.display = showSystem ? '' : 'none';
        const logsSection = document.getElementById('logs-section');
        if (logsSection) logsSection.style.display = showLogs ? '' : 'none';

        if (showLogs && !state.logsLoaded) {
          fetchLogs();
        }

        if (window.innerWidth <= 820) {
          sidebar.classList.remove('open');
          if (!drawer.classList.contains('open')) backdrop.classList.remove('open');
        }
      }

      document.querySelectorAll('[data-view]').forEach((btn) => {
        btn.addEventListener('click', () => setView(btn.dataset.view));
      });

      const runtimeChip = document.getElementById('topbar-runtime-chip');
      if (runtimeChip) {
        runtimeChip.addEventListener('click', () => setView('system'));
      }

      // ── Curve Mode Switcher ──
      document.querySelectorAll('[data-curve-mode]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const nextMode = btn.dataset.curveMode || 'noon';
          if (state.curveMode === nextMode) return;
          state.curveMode = nextMode;
          document.querySelectorAll('[data-curve-mode]').forEach((b) => {
            b.classList.toggle('active', b === btn);
          });
          if (nextMode === 'live') {
            renderChart();
          } else {
            fetchCurve(true);
          }
        });
      });

      // ── Logs Filter & Refresh ──
      document.querySelectorAll('[data-log-filter]').forEach((btn) => {
        btn.addEventListener('click', () => {
          state.logFilter = btn.dataset.logFilter || 'all';
          document.querySelectorAll('[data-log-filter]').forEach((b) => {
            b.classList.toggle('active', b === btn);
          });
          fetchLogs();
        });
      });

      const logsRefreshBtn = document.getElementById('logs-refresh-btn');
      if (logsRefreshBtn) {
        logsRefreshBtn.addEventListener('click', () => fetchLogs(true));
      }

      // ── Filters & Layout ──
      document.querySelectorAll('[data-status]').forEach((btn) => {
        btn.addEventListener('click', () => {
          state.statusFilter = btn.dataset.status;
          document.querySelectorAll('[data-status]').forEach((b) => b.classList.toggle('active', b === btn));
          renderChannels();
        });
      });

      document.getElementById('platform-filter').addEventListener('change', (e) => {
        state.platformFilter = e.target.value;
        renderChannels();
      });

      document.getElementById('search-input').addEventListener('input', (e) => {
        state.search = String(e.target.value || '').trim().toLowerCase();
        renderChannels();
      });

      document.querySelectorAll('[data-layout]').forEach((btn) => {
        btn.addEventListener('click', () => {
          state.layout = btn.dataset.layout;
          document.querySelectorAll('[data-layout]').forEach((b) => b.classList.toggle('active', b === btn));
          renderChannels();
        });
      });

      // ── Polling Control & Visibility Pause ──
      function restartTimer() {
        if (state.timerId) {
          clearInterval(state.timerId);
          state.timerId = null;
        }
        if (document.hidden) {
          state.pausedByVisibility = true;
          return;
        }
        state.pausedByVisibility = false;
        if (state.pollMs > 0) {
          state.timerId = setInterval(() => {
            if (document.hidden) return;
            fetchFlow();
          }, state.pollMs);
        }
      }

      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          if (state.timerId) {
            clearInterval(state.timerId);
            state.timerId = null;
          }
          state.pausedByVisibility = true;
        } else {
          state.pausedByVisibility = false;
          restartTimer();
          fetchFlow();
          if (state.curveMode !== 'live' && Date.now() - state.lastCurveFetchAt > 30000) {
            fetchCurve();
          }
        }
      });

      document.getElementById('poll-interval').addEventListener('change', (e) => {
        state.pollMs = Number(e.target.value) || 0;
        restartTimer();
        updateMetaLine();
      });

      document.getElementById('refresh-btn').addEventListener('click', () => {
        fetchFlow(true);
        if (state.curveMode !== 'live') fetchCurve(true);
        if (state.view === 'system') fetchLogs(true);
      });

      // ── Auth Form ──
      document.getElementById('auth-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = document.getElementById('token-input');
        const val = String(input.value || '').trim();
        if (!val) return;
        state.manualToken = val;
        try { sessionStorage.setItem('streamops_token', val); } catch {}
        document.getElementById('auth-error').textContent = '';
        await fetchFlow(true);
        if (!state.unauthorized) {
          if (state.curveMode !== 'live') fetchCurve(true);
          if (state.view === 'system') fetchLogs(true);
        }
      });

      // ── Detail Drawer ──
      function openDrawer(taskIndex) {
        const tasks = state.data?.tasks || [];
        const t = tasks[taskIndex];
        if (!t) return;
        state.selectedTaskIndex = taskIndex;
        const kind = taskState(t);
        const kbps = Math.round(t.bitrateKbps || 0);
        document.getElementById('drawer-title').textContent = '通道 #' + (taskIndex + 1) + ' · ' + platformLabel(t.platform);
        document.getElementById('drawer-sub').textContent = '状态：' + taskStateLabel(kind);

        const rows = [
          ['通道编号', '任务 #' + (taskIndex + 1)],
          ['直播平台', platformLabel(t.platform)],
          ['运行状态', taskStateLabel(kind)],
          ['任务开关', t.status === 'ENABLED' ? '已启用' : '已禁用'],
          ['实时码率', kbps + ' kbps'],
          ['本场流量', formatBytes(t.sessionBytes)],
          ['累计流量', formatBytes(t.totalBytes)],
          ['连续推流时长', t.startedAt ? formatElapsed(t.startedAt) : '未开播'],
          ['开始时间', t.startedAt ? formatClock(t.startedAt) : '—'],
          ['最近成功拉流', formatClock(t.lastSuccessAt)],
          ['异常次数', (t.errorCount || 0) + ' 次'],
        ];

        document.getElementById('drawer-kv').innerHTML = rows.map(([k, v]) => (
          '<div class="drawer-item"><span class="drawer-k">' + esc(k) + '</span><span class="tabular">' + esc(v) + '</span></div>'
        )).join('');

        drawer.classList.add('open');
        drawer.setAttribute('aria-hidden', 'false');
        backdrop.classList.add('open');
      }

      // ── Chart Rendering: 24h SQLite Wave Curve + Realtime 5m Mode ──
      function buildSmoothPath(points) {
        if (!points.length) return '';
        if (points.length === 1) {
          return 'M' + points[0].x.toFixed(1) + ' ' + points[0].y.toFixed(1);
        }
        let d = 'M' + points[0].x.toFixed(1) + ' ' + points[0].y.toFixed(1);
        for (let i = 0; i < points.length - 1; i++) {
          const p0 = points[Math.max(0, i - 1)];
          const p1 = points[i];
          const p2 = points[i + 1];
          const p3 = points[Math.min(points.length - 1, i + 2)];
          const cp1x = p1.x + (p2.x - p0.x) / 6;
          const cp1y = p1.y + (p2.y - p0.y) / 6;
          const cp2x = p2.x - (p3.x - p1.x) / 6;
          const cp2y = p2.y - (p3.y - p1.y) / 6;
          d += ' C' + cp1x.toFixed(1) + ' ' + cp1y.toFixed(1) + ',' + cp2x.toFixed(1) + ' ' + cp2y.toFixed(1) + ',' + p2.x.toFixed(1) + ' ' + p2.y.toFixed(1);
        }
        return d;
      }

      function renderChart24h() {
        const svg = document.getElementById('bitrate-chart');
        const tooltip = document.getElementById('chart-tooltip');
        const sessionsBar = document.getElementById('curve-sessions-bar');
        const titleEl = document.getElementById('chart-title');
        const subEl = document.getElementById('chart-subtitle');
        const curve = state.curveData;

        const W = 800;
        const H = 204;
        const padL = 48;
        const padR = 14;
        const padT = 18;
        const padB = 28;
        const innerW = W - padL - padR;
        const innerH = H - padT - padB;
        const baseY = padT + innerH;

        if (titleEl) {
          titleEl.textContent = state.curveMode === 'midnight'
            ? '今日 0-24 时推流码率波浪线'
            : '24 小时推流码率波浪线';
        }
        if (subEl) {
          const rawLabel = String(curve?.window?.label || '');
          const winLabel = rawLabel
            ? ((rawLabel.startsWith('北京时间') ? rawLabel : '北京时间 ' + rawLabel) + ' · SQLite 持久化采样')
            : (state.curveMode === 'midnight'
              ? '北京时间 今日 00:00 → 24:00 · SQLite 持久化采样'
              : '北京时间 12:00 → 次日 12:00 · SQLite 持久化采样');
          subEl.textContent = winLabel;
        }

        if (!curve || !Array.isArray(curve.buckets)) {
          svg.innerHTML = '<text x="' + (W / 2) + '" y="' + (H / 2) + '" text-anchor="middle" fill="var(--text-muted)" font-size="13">正在加载 24 小时持久化码率曲线...</text>';
          if (sessionsBar) sessionsBar.style.display = 'none';
          return;
        }

        const buckets = curve.buckets;
        const n = buckets.length || 144;
        const peak = Number(curve.peakKbps || 0);
        const avg = Number(curve.avgKbps || 0);
        document.getElementById('chart-peak').textContent = peak.toLocaleString() + ' kbps';
        document.getElementById('chart-avg').textContent = avg.toLocaleString() + ' kbps';

        const maxY = Math.max(1000, Math.ceil((peak * 1.2) / 500) * 500);
        const gridSteps = [0, 0.25, 0.5, 0.75, 1];
        const startMs = Number(curve.window?.startMs || 0);
        const endMs = Number(curve.window?.endMs || (startMs + 86400000));
        const spanMs = Math.max(1, endMs - startMs);
        const sessions = Array.isArray(curve.sessions) ? curve.sessions : [];

        let markup = '<defs><linearGradient id="waveAreaGrad" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="var(--accent)" stop-opacity="0.30"/>' +
          '<stop offset="100%" stop-color="var(--accent)" stop-opacity="0.02"/>' +
          '</linearGradient></defs>';

        // Broadcast session background bands
        sessions.forEach((s, idx) => {
          const color = SESSION_COLORS[idx % SESSION_COLORS.length];
          const x1 = padL + Math.max(0, Math.min(1, (s.startMs - startMs) / spanMs)) * innerW;
          const x2 = padL + Math.max(0, Math.min(1, (s.endMs - startMs) / spanMs)) * innerW;
          const bw = Math.max(4, x2 - x1);
          markup += '<rect x="' + x1.toFixed(1) + '" y="' + padT + '" width="' + bw.toFixed(1) + '" height="' + innerH + '" fill="' + color + '" fill-opacity="0.08"/>';
          if (bw >= 18) {
            markup += '<text x="' + (x1 + bw / 2).toFixed(1) + '" y="' + (padT + 11) + '" text-anchor="middle" fill="' + color + '" font-size="10" font-weight="600" font-family="var(--font-mono)">#' + (s.index || (idx + 1)) + '</text>';
          }
        });

        // Horizontal Y grid
        for (const ratio of gridSteps) {
          const y = (padT + innerH * (1 - ratio)).toFixed(1);
          const labelVal = Math.round(maxY * ratio);
          const label = labelVal >= 1000 ? (labelVal / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(labelVal);
          markup += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="var(--chart-grid)" stroke-width="1"/>';
          markup += '<text x="' + (padL - 8) + '" y="' + (Number(y) + 4) + '" text-anchor="end" fill="var(--text-muted)" font-size="11" font-family="var(--font-mono)">' + label + '</text>';
        }

        // Midnight divider for noon→noon window
        if (state.curveMode === 'noon') {
          const midX = (padL + innerW * 0.5).toFixed(1);
          markup += '<line x1="' + midX + '" y1="' + padT + '" x2="' + midX + '" y2="' + baseY + '" stroke="var(--border-strong)" stroke-width="1" stroke-dasharray="3 3"/>';
        }

        // 9 Beijing time ticks across 24h (every 3 hours)
        for (let i = 0; i <= 8; i++) {
          const frac = i / 8;
          const tx = padL + frac * innerW;
          const tickMs = startMs + frac * spanMs;
          const label = i === 8 && state.curveMode === 'midnight' ? '24:00' : formatBeijingHHMM(tickMs);
          const anchor = i === 0 ? 'start' : (i === 8 ? 'end' : 'middle');
          markup += '<text x="' + tx.toFixed(1) + '" y="' + (H - 7) + '" text-anchor="' + anchor + '" fill="var(--text-muted)" font-size="10.5" font-family="var(--font-mono)">' + esc(label) + '</text>';
        }

        // Compute bucket points
        const coords = buckets.map((kbps, i) => {
          const x = padL + (i / Math.max(1, n - 1)) * innerW;
          const val = Math.max(0, Number(kbps || 0));
          const y = Math.max(padT, Math.min(baseY, baseY - (val / maxY) * innerH));
          const bucketMs = startMs + (i / n) * spanMs;
          return { x, y, kbps: Math.round(val), label: formatBeijingHHMM(bucketMs) };
        });

        // Draw segmented smooth waves for active runs so offline spans rest cleanly on baseline
        let seg = [];
        const flushSegment = () => {
          if (seg.length === 0) return;
          const first = seg[0];
          const last = seg[seg.length - 1];
          const clamped = seg.map((p) => ({ x: p.x, y: p.y }));
          if (clamped.length === 1) {
            markup += '<line x1="' + first.x.toFixed(1) + '" y1="' + baseY + '" x2="' + first.x.toFixed(1) + '" y2="' + first.y.toFixed(1) + '" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round"/>';
            markup += '<circle cx="' + first.x.toFixed(1) + '" cy="' + first.y.toFixed(1) + '" r="3" fill="var(--accent)"/>';
          } else {
            const pathD = buildSmoothPath(clamped);
            const areaD = pathD + ' L' + last.x.toFixed(1) + ' ' + baseY.toFixed(1) + ' L' + first.x.toFixed(1) + ' ' + baseY.toFixed(1) + ' Z';
            markup += '<path d="' + areaD + '" fill="url(#waveAreaGrad)"/>';
            markup += '<path d="' + pathD + '" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
          }
          seg = [];
        };

        for (let i = 0; i < coords.length; i++) {
          if (coords[i].kbps > 0) {
            if (seg.length === 0 && i > 0) {
              seg.push({ x: coords[i - 1].x, y: baseY });
            }
            seg.push(coords[i]);
          } else if (seg.length > 0) {
            seg.push({ x: coords[i].x, y: baseY });
            flushSegment();
          }
        }
        flushSegment();

        // Current-time cursor
        const nowMs = Number(curve.nowMs || Date.now());
        if (nowMs >= startMs && nowMs <= endMs) {
          const nowX = padL + ((nowMs - startMs) / spanMs) * innerW;
          markup += '<line x1="' + nowX.toFixed(1) + '" y1="' + padT + '" x2="' + nowX.toFixed(1) + '" y2="' + baseY + '" stroke="var(--ok)" stroke-width="1.2" stroke-dasharray="3 3" opacity="0.85"/>';
          markup += '<circle cx="' + nowX.toFixed(1) + '" cy="' + padT + '" r="3" fill="var(--ok)"/>';
        }

        if (peak === 0) {
          const cx = padL + innerW / 2;
          const cy = padT + innerH / 2;
          markup += '<rect x="' + (cx - 196).toFixed(1) + '" y="' + (cy - 13).toFixed(1) + '" width="392" height="26" rx="6" fill="var(--bg-surface)" fill-opacity="0.92" stroke="var(--border-hairline)" stroke-width="1"/>';
          markup += '<text x="' + cx.toFixed(1) + '" y="' + (cy + 4).toFixed(1) + '" text-anchor="middle" fill="var(--text-muted)" font-size="12">当前 24h 时间窗暂无推流采样，开播后自动绘制码率波浪线</text>';
        }

        // Hover hit targets (grouped every 2 buckets = 72 smooth columns for crisp DOM perf)
        const step = 2;
        const colW = (innerW / Math.ceil(n / step)) + 0.5;
        for (let i = 0; i < coords.length; i += step) {
          const c = coords[i];
          const c2 = coords[Math.min(coords.length - 1, i + 1)];
          const hit = c2.kbps > c.kbps ? c2 : c;
          markup += '<rect x="' + (c.x - colW / 2).toFixed(1) + '" y="' + padT + '" width="' + colW.toFixed(1) + '" height="' + innerH + '" fill="transparent" data-wave-idx="' + (hit === c2 ? Math.min(coords.length - 1, i + 1) : i) + '" style="cursor:crosshair;"/>';
        }

        svg.innerHTML = markup;

        svg.querySelectorAll('[data-wave-idx]').forEach((hit) => {
          hit.addEventListener('mouseenter', () => {
            const c = coords[Number(hit.dataset.waveIdx)];
            if (!c) return;
            tooltip.textContent = c.label + ' · ' + (c.kbps > 0 ? (c.kbps.toLocaleString() + ' kbps') : '未推流 (0 kbps)');
            const leftPct = Math.min(84, Math.max(12, (c.x / W) * 100));
            const topPct = Math.max(6, Math.min(68, (c.y / H) * 100 - 16));
            tooltip.style.left = leftPct + '%';
            tooltip.style.top = topPct + '%';
            tooltip.style.transform = 'translateX(-50%)';
            tooltip.style.opacity = '1';
          });
          hit.addEventListener('mouseleave', () => {
            tooltip.style.opacity = '0';
          });
        });

        // Sessions summary bar
        if (sessionsBar) {
          sessionsBar.style.display = 'flex';
          if (sessions.length === 0) {
            sessionsBar.innerHTML = '<span style="color:var(--text-muted);">窗口场次：暂无开播记录（每分钟自动落库采样，刷新或重启后不丢失）</span>';
          } else {
            const summary = '<span class="tabular" style="font-weight:500; color:var(--text-primary);">共 ' + sessions.length + ' 场 · 累计 ' + esc(formatMinutesCn(curve.totalLiveMinutes)) + '</span>';
            const chips = sessions.slice(0, 6).map((s, idx) => {
              const color = SESSION_COLORS[idx % SESSION_COLORS.length];
              return (
                '<span class="session-chip tabular">' +
                  '<span class="session-swatch" style="background:' + color + ';"></span>' +
                  '<span>#' + (s.index || (idx + 1)) + ' ' + esc(s.startTimeStr) + '–' + esc(s.endTimeStr) + '</span>' +
                  '<span style="color:var(--text-muted);">· ' + Math.round(s.avgKbps || 0).toLocaleString() + ' kbps</span>' +
                '</span>'
              );
            }).join('');
            sessionsBar.innerHTML = summary + chips;
          }
        }
      }

      function renderChartLive() {
        const svg = document.getElementById('bitrate-chart');
        const tooltip = document.getElementById('chart-tooltip');
        const sessionsBar = document.getElementById('curve-sessions-bar');
        const titleEl = document.getElementById('chart-title');
        const subEl = document.getElementById('chart-subtitle');

        if (titleEl) titleEl.textContent = '实时聚合码率趋势（最近 5 分钟）';
        if (subEl) subEl.textContent = '基于前端最近 30 次轮询采样 · 仅作即时波动参考';
        if (sessionsBar) sessionsBar.style.display = 'none';

        const pts = state.history;
        const W = 800;
        const H = 204;
        const padL = 48;
        const padR = 14;
        const padT = 18;
        const padB = 28;
        const innerW = W - padL - padR;
        const innerH = H - padT - padB;

        if (!pts.length) {
          svg.innerHTML = '<text x="' + (W / 2) + '" y="' + (H / 2) + '" text-anchor="middle" fill="var(--text-muted)" font-size="13">等待采集实时码率数据...</text>';
          return;
        }

        const values = pts.map((p) => Number(p.kbps || 0));
        const peak = Math.max(...values, 0);
        const avg = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
        document.getElementById('chart-peak').textContent = peak.toLocaleString() + ' kbps';
        document.getElementById('chart-avg').textContent = avg.toLocaleString() + ' kbps';

        const maxY = Math.max(1000, Math.ceil((peak * 1.2) / 500) * 500);
        const gridSteps = [0, 0.25, 0.5, 0.75, 1];

        let markup = '<defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="var(--accent)" stop-opacity="0.28"/>' +
          '<stop offset="100%" stop-color="var(--accent)" stop-opacity="0.01"/>' +
          '</linearGradient></defs>';

        for (const ratio of gridSteps) {
          const y = (padT + innerH * (1 - ratio)).toFixed(1);
          const labelVal = Math.round(maxY * ratio);
          const label = labelVal >= 1000 ? (labelVal / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(labelVal);
          markup += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="var(--chart-grid)" stroke-width="1"/>';
          markup += '<text x="' + (padL - 8) + '" y="' + (Number(y) + 4) + '" text-anchor="end" fill="var(--text-muted)" font-size="11" font-family="var(--font-mono)">' + label + '</text>';
        }

        const coords = pts.map((p, idx) => {
          const x = pts.length === 1 ? padL + innerW / 2 : padL + (idx / (pts.length - 1)) * innerW;
          const y = padT + innerH - (Number(p.kbps || 0) / maxY) * innerH;
          return { x, y, ...p };
        });

        if (coords.length >= 2) {
          const linePath = coords.map((c, idx) => (idx === 0 ? 'M' : 'L') + c.x.toFixed(1) + ' ' + c.y.toFixed(1)).join(' ');
          const areaPath = linePath + ' L' + coords[coords.length - 1].x.toFixed(1) + ' ' + (padT + innerH) + ' L' + coords[0].x.toFixed(1) + ' ' + (padT + innerH) + ' Z';
          markup += '<path d="' + areaPath + '" fill="url(#areaGrad)"/>';
          markup += '<path d="' + linePath + '" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
        }

        const firstT = pts[0].label || '';
        const lastT = pts[pts.length - 1].label || '';
        markup += '<text x="' + padL + '" y="' + (H - 7) + '" fill="var(--text-muted)" font-size="11" font-family="var(--font-mono)">' + esc(firstT) + '</text>';
        if (pts.length > 1) {
          markup += '<text x="' + (W - padR) + '" y="' + (H - 7) + '" text-anchor="end" fill="var(--text-muted)" font-size="11" font-family="var(--font-mono)">' + esc(lastT) + '</text>';
        }

        coords.forEach((c, idx) => {
          const isLast = idx === coords.length - 1;
          markup += '<circle cx="' + c.x.toFixed(1) + '" cy="' + c.y.toFixed(1) + '" r="' + (isLast ? '4' : '2.5') + '" fill="var(--accent)" opacity="' + (isLast ? '1' : '0.65') + '"/>';
          markup += '<rect x="' + (c.x - 12).toFixed(1) + '" y="' + padT + '" width="24" height="' + innerH + '" fill="transparent" data-pt-idx="' + idx + '" style="cursor:crosshair;"/>';
        });

        svg.innerHTML = markup;

        svg.querySelectorAll('[data-pt-idx]').forEach((hit) => {
          hit.addEventListener('mouseenter', () => {
            const c = coords[Number(hit.dataset.ptIdx)];
            if (!c) return;
            tooltip.textContent = c.label + ' · ' + c.kbps + ' kbps · ' + c.active + ' 路推流';
            const leftPct = Math.min(82, Math.max(12, (c.x / W) * 100));
            tooltip.style.left = leftPct + '%';
            tooltip.style.top = Math.max(4, (c.y / H) * 100 - 16) + '%';
            tooltip.style.transform = 'translateX(-50%)';
            tooltip.style.opacity = '1';
          });
          hit.addEventListener('mouseleave', () => {
            tooltip.style.opacity = '0';
          });
        });
      }

      function renderChart() {
        if (state.curveMode === 'live') {
          renderChartLive();
        } else {
          renderChart24h();
        }
      }

      // ── Channels Rendering (Smart Priority Sorting) ──
      function renderChannels() {
        const container = document.getElementById('channels-body');
        if (state.loading && !state.data) {
          container.innerHTML = '<div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div>';
          return;
        }

        const rawTasks = (state.data?.tasks || []).map((t, idx) => ({ ...t, _idx: idx, _kind: taskState(t) }));
        if (rawTasks.length === 0) {
          container.innerHTML =
            '<div class="state-box">' +
              '<h3 class="state-box-title">当前暂无配置中的转播房间</h3>' +
              '<p class="state-box-desc">请在 Telegram 控制中心发送 /addroom 添加 Bilibili、斗鱼或抖音直播间。任务开启后，本页面将实时显示各路推流码率、传输字节与开播耗时。</p>' +
              '<button type="button" class="row-action-btn" id="empty-go-system">查看运行环境状态</button>' +
            '</div>';
          const btn = document.getElementById('empty-go-system');
          if (btn) btn.addEventListener('click', () => setView('system'));
          return;
        }

        const filtered = rawTasks
          .filter((t) => {
            if (state.statusFilter !== 'all' && t._kind !== state.statusFilter) return false;
            if (state.platformFilter !== 'all' && String(t.platform || '').toLowerCase() !== state.platformFilter) return false;
            if (state.search) {
              const hay = ('任务 #' + (t._idx + 1) + ' ' + platformLabel(t.platform) + ' ' + t.platform + ' ' + taskStateLabel(t._kind)).toLowerCase();
              if (!hay.includes(state.search)) return false;
            }
            return true;
          })
          .sort(compareTasks);

        if (filtered.length === 0) {
          container.innerHTML =
            '<div class="state-box">' +
              '<h3 class="state-box-title">没有匹配的推流通道</h3>' +
              '<p class="state-box-desc">当前筛选条件下暂无通道，请调整状态标签、平台选择或搜索关键词。</p>' +
              '<button type="button" class="row-action-btn" id="reset-filters-btn">重置筛选条件</button>' +
            '</div>';
          const resetBtn = document.getElementById('reset-filters-btn');
          if (resetBtn) {
            resetBtn.addEventListener('click', () => {
              state.statusFilter = 'all';
              state.platformFilter = 'all';
              state.search = '';
              document.getElementById('platform-filter').value = 'all';
              document.getElementById('search-input').value = '';
              document.querySelectorAll('[data-status]').forEach((b) => b.classList.toggle('active', b.dataset.status === 'all'));
              renderChannels();
            });
          }
          return;
        }

        const maxKbps = Math.max(8000, ...filtered.map((t) => Math.round(t.bitrateKbps || 0)));

        if (state.layout === 'cards') {
          container.innerHTML = '<div class="cards-grid">' + filtered.map((t) => {
            const kbps = Math.round(t.bitrateKbps || 0);
            const stateCls = t._kind === 'live' ? 'state-live' : t._kind === 'standby' ? 'state-standby' : 'state-paused';
            return (
              '<div class="channel-card" data-open-idx="' + t._idx + '">' +
                '<div class="channel-card-top">' +
                  '<div style="font-weight:600;">任务 #' + (t._idx + 1) + ' <span style="color:var(--text-muted); font-weight:400;">· ' + esc(platformLabel(t.platform)) + '</span></div>' +
                  '<span class="state-tag ' + stateCls + '"><span class="state-dot"></span>' + esc(taskStateLabel(t._kind)) + '</span>' +
                '</div>' +
                '<div class="channel-card-metrics">' +
                  '<div class="metric-pair"><span class="metric-k">实时码率</span><span class="metric-v tabular">' + kbps + ' kbps</span></div>' +
                  '<div class="metric-pair"><span class="metric-k">直播时长</span><span class="metric-v tabular">' + (t.startedAt ? esc(formatElapsed(t.startedAt)) : '未开始') + '</span></div>' +
                  '<div class="metric-pair"><span class="metric-k">本场流量</span><span class="metric-v tabular">' + esc(formatBytes(t.sessionBytes)) + '</span></div>' +
                  '<div class="metric-pair"><span class="metric-k">异常次数</span><span class="metric-v tabular ' + (t.errorCount > 0 ? 'state-err' : '') + '">' + (t.errorCount || 0) + ' 次</span></div>' +
                '</div>' +
              '</div>'
            );
          }).join('') + '</div>';
        } else {
          container.innerHTML =
            '<div class="table-scroll"><table>' +
              '<thead><tr>' +
                '<th>通道</th>' +
                '<th>平台</th>' +
                '<th>状态</th>' +
                '<th class="num">实时码率</th>' +
                '<th class="num">本场流量</th>' +
                '<th class="num">直播时长</th>' +
                '<th class="num">异常</th>' +
                '<th class="num">最近成功</th>' +
                '<th class="num">操作</th>' +
              '</tr></thead>' +
              '<tbody>' +
                filtered.map((t) => {
                  const kbps = Math.round(t.bitrateKbps || 0);
                  const pct = Math.min(100, Math.round((kbps / maxKbps) * 100));
                  const stateCls = t._kind === 'live' ? 'state-live' : t._kind === 'standby' ? 'state-standby' : 'state-paused';
                  return (
                    '<tr class="data-row" data-open-idx="' + t._idx + '">' +
                      '<td class="tabular" style="font-weight:600;">#' + (t._idx + 1) + '</td>' +
                      '<td>' + esc(platformLabel(t.platform)) + '</td>' +
                      '<td><span class="state-tag ' + stateCls + '"><span class="state-dot"></span>' + esc(taskStateLabel(t._kind)) + '</span></td>' +
                      '<td class="num"><div class="bitrate-cell"><div class="mini-bar-track"><div class="mini-bar-fill" style="width:' + pct + '%"></div></div><span class="tabular">' + kbps + ' kbps</span></div></td>' +
                      '<td class="num tabular">' + esc(formatBytes(t.sessionBytes)) + '</td>' +
                      '<td class="num tabular">' + (t.startedAt ? esc(formatElapsed(t.startedAt)) : '—') + '</td>' +
                      '<td class="num tabular ' + (t.errorCount > 0 ? 'state-err' : '') + '">' + (t.errorCount || 0) + '</td>' +
                      '<td class="num tabular">' + esc(formatClock(t.lastSuccessAt)) + '</td>' +
                      '<td class="num"><button type="button" class="row-action-btn" data-open-idx="' + t._idx + '">详情</button></td>' +
                    '</tr>'
                  );
                }).join('') +
              '</tbody>' +
            '</table></div>';
        }

        container.querySelectorAll('[data-open-idx]').forEach((el) => {
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            openDrawer(Number(el.dataset.openIdx));
          });
        });
      }

      // ── Sanitized Logs Rendering ──
      function renderLogs() {
        const consoleEl = document.getElementById('log-console');
        const subEl = document.getElementById('logs-subtitle');
        if (!consoleEl) return;
        const payload = state.logsData;
        if (!payload) {
          consoleEl.textContent = '正在读取运行日志...';
          return;
        }
        const lines = Array.isArray(payload.lines) ? payload.lines : [];
        if (subEl) {
          const modeTxt = payload.onlyErrors ? '仅警告 / 错误' : '全部日志';
          subEl.textContent = '当前筛选：' + modeTxt + ' · 共 ' + lines.length + ' 条 · 更新于 ' + formatClock(payload.generatedAt);
        }
        if (lines.length === 0) {
          consoleEl.innerHTML = '<div class="log-line" style="color:var(--text-muted);">' +
            (payload.onlyErrors ? '暂无警告或错误日志，系统运行平稳。' : '内存环形缓冲区暂无日志记录。') +
            '</div>';
          return;
        }
        consoleEl.innerHTML = lines.map((line) => {
          const s = String(line || '');
          let cls = 'log-line';
          if (s.includes('❌') || /\bERROR\b/i.test(s) || s.includes('失败') || s.includes('崩溃')) {
            cls += ' is-err';
          } else if (s.includes('⚠️') || /\bWARN\b/i.test(s) || s.includes('告警')) {
            cls += ' is-warn';
          } else if (s.includes('✅')) {
            cls += ' is-ok';
          }
          return '<div class="' + cls + '">' + esc(s) + '</div>';
        }).join('');
        consoleEl.scrollTop = consoleEl.scrollHeight;
      }

      function updateMetaLine() {
        const d = state.data;
        const pollLabel = state.pollMs > 0 ? ('每 ' + (state.pollMs / 1000) + ' 秒自动同步') : '自动轮询已暂停';
        if (state.unauthorized) {
          document.getElementById('sync-status').textContent = '等待访问令牌验证';
          return;
        }
        if (!d) {
          document.getElementById('sync-status').textContent = '正在同步数据 · ' + pollLabel;
          return;
        }
        const ts = formatClock(d.generatedAt || new Date().toISOString());
        document.getElementById('sync-status').textContent =
          '最近同步 ' + ts + ' · ' + pollLabel + ' · ' + (d.transcodeVideo ? '画质转码 (libx264)' : '直连转发 (copy)');
        document.getElementById('footer-sync').textContent = '同步于 ' + ts;
      }

      function renderAll() {
        const d = state.data || {};
        const tasks = d.tasks || [];
        const totalErrors = tasks.reduce((s, t) => s + (t.errorCount || 0), 0);
        const totalKbps = Math.round(d.totalBitrate || 0);
        const totalMbps = (totalKbps / 1024).toFixed(2);
        const totalSessionBytes = d.totalSessionBytes ?? tasks.reduce((s, t) => s + (t.sessionBytes || 0), 0);

        document.getElementById('nav-count-active').textContent = String(d.active || 0);
        document.getElementById('nav-count-total').textContent = String(tasks.length);

        document.getElementById('kpi-active').textContent = String(d.active || 0) + ' 路';
        document.getElementById('kpi-active-sub').textContent = '已启用 ' + (d.enabledTasks ?? tasks.filter((t) => t.status === 'ENABLED').length) + ' / 共 ' + (d.totalTasks ?? tasks.length) + ' 个房间';

        document.getElementById('kpi-bitrate').textContent = totalMbps + ' Mbps';
        document.getElementById('kpi-bitrate-sub').textContent = totalKbps.toLocaleString() + ' kbps 实时聚合';

        document.getElementById('kpi-bytes').textContent = formatBytes(totalSessionBytes);
        document.getElementById('kpi-targets-sub').textContent = '配置推流线路 ' + (d.totalTargets ?? 0) + ' 条';

        document.getElementById('kpi-monitoring').textContent = String(d.totalMonitoring || 0) + ' 房间';
        const errEl = document.getElementById('kpi-error-sub');
        errEl.textContent = '累计异常 ' + totalErrors + ' 次';
        errEl.style.color = totalErrors > 0 ? 'var(--err-text)' : '';

        // FFmpeg Verification Component & Topbar Runtime Chip
        const ffVer = d.ffmpegVersion || '未知';
        const ffPath = d.ffmpegPath || d.ffmpegConfiguredBin || 'ffmpeg';
        const ffSource = d.ffmpegSource || '系统默认 PATH';
        const ffSourceType = d.ffmpegSourceType || 'system_path';
        const ffCustom = Boolean(d.ffmpegCustomBinary);
        const ffBanner = d.ffmpegBanner || ('ffmpeg version ' + ffVer);
        const rtName = runtimeLabel(d.runtimeEnv);

        const topbarSummary = document.getElementById('topbar-ff-summary');
        const topbarDot = document.getElementById('topbar-ff-dot');
        if (topbarSummary) {
          topbarSummary.textContent = 'FFmpeg ' + shortFfmpegVer(ffVer) + (ffCustom ? ' ✓' : '') + ' · ' + rtName;
        }
        if (topbarDot) {
          topbarDot.style.background = ffCustom ? 'var(--ok)' : 'var(--accent)';
        }

        const badgeEl = document.getElementById('ffmpeg-status-badge');
        if (badgeEl) {
          badgeEl.className = 'ffmpeg-badge ' + (ffCustom ? 'custom-ok' : 'system-default');
          badgeEl.textContent = ffCustom
            ? '✓ 已启用自定义/内置最新版二进制'
            : '● 当前使用系统默认 PATH 二进制';
        }
        document.getElementById('ffmpeg-ver-value').textContent = ffVer;
        document.getElementById('ffmpeg-source-tag').textContent = ffSource;
        document.getElementById('ffmpeg-banner-sub').textContent = ffBanner;
        document.getElementById('ffmpeg-path-value').textContent = ffPath;
        document.getElementById('ffmpeg-path-hint').textContent = ffCustom
          ? '已验证：当前正优先调用自定义/内置二进制，已避开宿主机默认旧版'
          : '提示：如需替换系统旧版，可放入 ./bin/ffmpeg 或点击右上角「拉取最新静态版」';

        document.querySelectorAll('[data-ff-step]').forEach((chip) => {
          chip.classList.toggle('active', chip.dataset.ffStep === ffSourceType);
        });

        // Resource Water-Level Gauges (Memory & Disk)
        const memInfo = d.memory || {};
        const memPct = Math.max(0, Math.min(100, Number(memInfo.sysUsePct || 0)));
        const memSourceLabel = String(memInfo.source || '').startsWith('cgroup') ? '容器配额' : '宿主机';
        const memLabelEl = document.getElementById('gauge-mem-label');
        const memValEl = document.getElementById('gauge-mem-val');
        const memBarEl = document.getElementById('gauge-mem-bar');
        if (memLabelEl) memLabelEl.textContent = '内存水位（' + memSourceLabel + '）';
        if (memValEl) {
          if (memInfo.limitMB > 0) {
            memValEl.textContent = memPct + '% · ' + (memInfo.usedMB || 0) + ' / ' + memInfo.limitMB + ' MB (Node ' + (memInfo.rssMB || 0) + ' MB)';
          } else {
            memValEl.textContent = 'Node RSS ' + (memInfo.rssMB || 0) + ' MB';
          }
        }
        if (memBarEl) {
          memBarEl.style.width = memPct + '%';
          const isMemErr = memPct >= 85 || (memInfo.criticalMb > 0 && memInfo.rssMB >= memInfo.criticalMb);
          const isMemWarn = !isMemErr && (memPct >= 70 || (memInfo.alertMb > 0 && memInfo.rssMB >= memInfo.alertMb));
          memBarEl.className = 'gauge-fill ' + (isMemErr ? 'err' : isMemWarn ? 'warn' : 'ok');
        }

        const diskPct = d.diskPct;
        const diskAlert = Number(d.diskAlertPct || 85);
        const diskValEl = document.getElementById('gauge-disk-val');
        const diskBarEl = document.getElementById('gauge-disk-bar');
        if (diskValEl && diskBarEl) {
          if (typeof diskPct === 'number' && Number.isFinite(diskPct)) {
            const clampedDisk = Math.max(0, Math.min(100, diskPct));
            diskValEl.textContent = clampedDisk + '%（告警阈值 ' + diskAlert + '%）';
            diskBarEl.style.width = clampedDisk + '%';
            diskBarEl.className = 'gauge-fill ' + (clampedDisk >= 90 ? 'err' : clampedDisk >= diskAlert ? 'warn' : 'ok');
          } else {
            diskValEl.textContent = '当前环境暂不可用';
            diskBarEl.style.width = '0%';
            diskBarEl.className = 'gauge-fill ok';
          }
        }

        // System panel KV list
        const rtEnvEl = document.getElementById('sys-runtime-env');
        if (rtEnvEl) rtEnvEl.textContent = rtName + (d.runtimeEnv ? ' (' + d.runtimeEnv + ')' : '');
        document.getElementById('sys-uptime').textContent = formatDurationSec(d.uptimeSeconds || 0);
        document.getElementById('sys-mem').textContent =
          formatBytes(d.serviceMemBytes || 0) +
          (d.serviceHeapUsedBytes ? ' (JS堆 ' + formatBytes(d.serviceHeapUsedBytes) + ')' : '');
        document.getElementById('sys-transcode').textContent = d.transcodeVideo
          ? '开启 (libx264 转码)'
          : (d.transcodeAudio ? '音频标准化 (视频 copy + AAC 48kHz)' : '关闭 (原生流 copy 转发)');
        document.getElementById('sys-node-ver').textContent = d.nodeVersion || '—';
        document.getElementById('sys-ffmpeg-ver').textContent = ffVer;
        document.getElementById('sys-ffmpeg-path').textContent = ffPath;
        document.getElementById('sys-ffmpeg-source').textContent = ffSource + (ffCustom ? ' (自定义生效)' : ' (系统默认)');
        document.getElementById('sys-capacity').textContent = (d.totalTasks ?? tasks.length) + ' 房间 / ' + (d.totalTargets ?? 0) + ' 条线路';

        updateMetaLine();
        renderChart();
        renderChannels();

        if (state.selectedTaskIndex !== null) {
          openDrawer(state.selectedTaskIndex);
        }
      }

      // ── FFmpeg Verification Interactive Actions ──
      document.getElementById('ffmpeg-copy-path-btn').addEventListener('click', async () => {
        const pathText = document.getElementById('ffmpeg-path-value').textContent || '';
        const btn = document.getElementById('ffmpeg-copy-path-btn');
        try {
          await navigator.clipboard.writeText(pathText);
          btn.textContent = '已复制 ✓';
          setTimeout(() => { btn.textContent = '复制路径'; }, 1800);
        } catch {
          btn.textContent = '复制失败';
          setTimeout(() => { btn.textContent = '复制路径'; }, 1800);
        }
      });

      document.getElementById('ffmpeg-probe-btn').addEventListener('click', async () => {
        const btn = document.getElementById('ffmpeg-probe-btn');
        const feedback = document.getElementById('ffmpeg-action-feedback');
        btn.disabled = true;
        btn.textContent = '探测中...';
        try {
          const res = await fetch('/api/ffmpeg/probe', {
            method: 'POST',
            headers: authHeaders(),
          });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const info = await res.json();
          feedback.textContent = '✓ 已重新探测：' + (info.version || '未知') + ' @ ' + (info.resolvedPath || info.binPath);
          await fetchFlow(true);
        } catch (err) {
          feedback.textContent = '探测失败：' + (err.message || '网络错误');
        } finally {
          btn.disabled = false;
          btn.textContent = '重新探测路径';
        }
      });

      document.getElementById('ffmpeg-upgrade-btn').addEventListener('click', async () => {
        const btn = document.getElementById('ffmpeg-upgrade-btn');
        const feedback = document.getElementById('ffmpeg-action-feedback');
        btn.disabled = true;
        btn.textContent = '正在下载最新版...';
        feedback.textContent = '正在从官方静态源下载最新 FFmpeg 至 ./bin/ffmpeg，请稍候...';
        try {
          const res = await fetch('/api/ffmpeg/upgrade', {
            method: 'POST',
            headers: authHeaders(),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok || !body.ok) {
            throw new Error(body.error || ('HTTP ' + res.status));
          }
          feedback.textContent = '✓ 已升级至最新静态版：' + (body.ffmpeg?.version || '') + ' (' + (body.ffmpeg?.resolvedPath || './bin/ffmpeg') + ')';
          await fetchFlow(true);
        } catch (err) {
          feedback.textContent = '升级未完成：' + (err.message || '下载失败');
        } finally {
          btn.disabled = false;
          btn.textContent = '拉取最新静态版 (./bin/ffmpeg)';
        }
      });

      // ── Data Fetchers ──
      async function fetchCurve(force = false) {
        if (state.unauthorized || state.curveMode === 'live') return;
        const now = Date.now();
        if (!force && state.curveData && state.curveData.mode === state.curveMode && now - state.lastCurveFetchAt < 55000) {
          return;
        }
        try {
          const mode = state.curveMode === 'midnight' ? 'midnight' : 'noon';
          const res = await fetch('/api/curve?mode=' + encodeURIComponent(mode), {
            headers: authHeaders(),
          });
          if (res.status === 401 || !res.ok) return;
          const data = await res.json();
          if (state.curveMode === mode) {
            state.curveData = data;
            state.lastCurveFetchAt = Date.now();
            renderChart();
          }
        } catch {}
      }

      async function fetchLogs(isManual = false) {
        if (state.unauthorized) return;
        const btn = document.getElementById('logs-refresh-btn');
        if (isManual && btn) {
          btn.disabled = true;
          btn.textContent = '读取中...';
        }
        try {
          const onlyErrors = state.logFilter === 'errors' ? '1' : '0';
          const res = await fetch('/api/logs?onlyErrors=' + onlyErrors + '&limit=50', {
            headers: authHeaders(),
          });
          if (res.status === 401 || !res.ok) return;
          state.logsData = await res.json();
          state.logsLoaded = true;
          renderLogs();
        } catch {
          const consoleEl = document.getElementById('log-console');
          if (consoleEl) consoleEl.textContent = '日志拉取失败，请稍后重试。';
        } finally {
          if (isManual && btn) {
            btn.disabled = false;
            btn.textContent = '刷新日志';
          }
        }
      }

      async function fetchFlow(isManual = false) {
        const refreshBtn = document.getElementById('refresh-btn');
        const refreshLabel = document.getElementById('refresh-label');
        if (isManual) {
          refreshBtn.disabled = true;
          refreshLabel.textContent = '同步中...';
        }
        try {
          const res = await fetch('/api/flow', {
            headers: authHeaders(),
          });
          if (res.status === 401) {
            state.unauthorized = true;
            state.loading = false;
            document.getElementById('auth-panel').style.display = '';
            document.getElementById('auth-error').textContent = state.manualToken ? '令牌无效，请检查后重试' : '';
            setView(state.view);
            updateMetaLine();
            return;
          }
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const data = await res.json();
          state.unauthorized = false;
          state.loading = false;
          state.data = data;
          document.getElementById('auth-panel').style.display = 'none';
          setView(state.view);

          const point = {
            ts: Date.now(),
            label: formatClock(data.generatedAt || new Date().toISOString()),
            kbps: Math.round(data.totalBitrate || 0),
            active: Number(data.active || 0),
          };
          state.history = state.history.concat(point).slice(-MAX_POINTS);
          saveHistory(state.history);
          renderAll();

          if (state.curveMode !== 'live') {
            fetchCurve(false);
          }
        } catch (err) {
          state.loading = false;
          document.getElementById('sync-status').innerHTML = '<span style="color:var(--err-text)">数据同步异常：' + esc(err.message || '网络错误') + '</span>';
          renderChannels();
        } finally {
          if (isManual) {
            refreshBtn.disabled = false;
            refreshLabel.textContent = '立即刷新';
          }
        }
      }

      setView('overview');
      fetchFlow();
      restartTimer();
    })();
  </script>
</body>
</html>`;
}

module.exports = { renderDashboard };
