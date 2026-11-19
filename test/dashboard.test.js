const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { renderDashboard } = require('../src/web/dashboard');
const ringLogger = require('../src/core/logger');
const { createApp } = require('../main');

test('renderDashboard outputs valid HTML, zero external font links, upgraded controls, and valid JS', () => {
  const html = renderDashboard();
  assert.equal(html.startsWith('<!DOCTYPE html>'), true);
  assert.equal(html.includes('Plus Jakarta Sans'), true);
  assert.equal(html.includes('JetBrains Mono'), true);
  assert.equal(html.includes('fonts.googleapis.com'), false, 'should not depend on external Google Fonts CDN');
  assert.equal(html.includes('fonts.gstatic.com'), false, 'should not preconnect external Google Fonts CDN');
  assert.equal(html.includes('tabular-nums'), true);
  assert.equal(html.includes('linear-gradient(135deg'), false);

  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch && scriptMatch[1], 'inline script should exist');
  // Verify client JS parses cleanly with zero syntax errors
  new vm.Script(scriptMatch[1]);

  // Verify core & newly added interactive controls exist
  for (const id of [
    'refresh-btn',
    'poll-interval',
    'theme-toggle',
    'platform-filter',
    'search-input',
    'bitrate-chart',
    'detail-drawer',
    'topbar-runtime-chip',
    'chart-mode-switch',
    'curve-sessions-bar',
    'gauge-mem-bar',
    'gauge-disk-bar',
    'logs-section',
    'log-console',
  ]) {
    assert.equal(html.includes(`id="${id}"`), true, `missing element #${id}`);
  }

  // Verify smart sorting, URL token scrubbing, and background visibility pause exist in script
  assert.equal(scriptMatch[1].includes('compareTasks'), true);
  assert.equal(scriptMatch[1].includes('visibilitychange'), true);
  assert.equal(scriptMatch[1].includes('replaceState'), true);
  assert.equal(scriptMatch[1].includes('/api/curve?mode='), true);
  assert.equal(scriptMatch[1].includes('/api/logs?onlyErrors='), true);
});

test('sanitizeLogForPublic scrubs RTMP URLs, room IDs, chatId, and tokens', () => {
  const raw =
    '[12:00:01] [ERROR] [1847873667] 推流失败 rtmp://live-push.example.com/live/secret_key_12345 chatId=987654321 room_id: 7159938 #1847873667 token=abc123xyz';
  const cleaned = ringLogger.sanitizeLogForPublic(raw);
  assert.equal(cleaned.includes('1847873667'), false, 'room ID should be redacted');
  assert.equal(cleaned.includes('7159938'), false, 'room_id value should be redacted');
  assert.equal(cleaned.includes('secret_key_12345'), false, 'RTMP stream key should be redacted');
  assert.equal(cleaned.includes('987654321'), false, 'chatId should be redacted');
  assert.equal(cleaned.includes('abc123xyz'), false, 'token should be redacted');
  assert.equal(cleaned.includes('[room-***]'), true);
  assert.equal(cleaned.includes('rtmp://live-push.example.com/****'), true);
});

test('Web Dashboard HTTP routes enforce auth gate cleanly and serve /api/flow, /api/curve, /api/logs', async () => {
  const prevToken = process.env.DASHBOARD_TOKEN;
  const secretToken = 'test_dashboard_secret_token_999';
  process.env.DASHBOARD_TOKEN = secretToken;

  const now = Date.now();
  const sampleBase = now - 30 * 60 * 1000;
  const fakeDb = {
    getSetting: () => '0',
    getAllBitrateSamples: (startMs, endMs) => {
      const rows = [
        { task_id: 1, ts: sampleBase, kbps: 3200 },
        { task_id: 2, ts: sampleBase, kbps: 1800 },
        { task_id: 1, ts: sampleBase + 60000, kbps: 3500 },
        { task_id: 1, ts: sampleBase + 120000, kbps: 3400 },
      ];
      return rows.filter((r) => r.ts >= startMs && r.ts <= endMs);
    },
  };
  const fakeScheduler = {
    getStats: () => ({ activeStreams: 1, totalMonitoring: 2, enabledTasks: 2, totalTasks: 2, totalTargets: 2 }),
    getTrafficStats: () => [
      {
        platform: 'bilibili',
        status: 'ENABLED',
        traffic: { running: true, bitrateKbps: 3500, sessionBytes: 1024 * 1024, totalBytes: 2048 * 1024, errorCount: 0 },
      },
    ],
  };

  ringLogger.info('✅ 测试通道 [1847873667] 推流至 rtmp://push.example.com/live/my_secret_key');

  const app = createApp({
    db: fakeDb,
    scheduler: fakeScheduler,
    bot: { isConfigured: false, isRunning: () => false },
    logger: { log() {}, warn() {}, error() {} },
  });

  const server = app.startServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. GET / must return 200 static HTML even when DASHBOARD_TOKEN is enabled so the auth form renders
    const rootRes = await fetch(`${baseUrl}/`);
    assert.equal(rootRes.status, 200);
    const rootHtml = await rootRes.text();
    assert.equal(rootHtml.includes('id="auth-panel"'), true);

    // 2. Data APIs must reject unauthenticated requests with 401
    for (const path of ['/api/flow', '/api/curve?mode=noon', '/api/logs?limit=10']) {
      const unauth = await fetch(`${baseUrl}${path}`);
      assert.equal(unauth.status, 401, `${path} should require token`);
    }

    const authHeader = { Authorization: `Bearer ${secretToken}` };

    // 3. /api/flow returns memory, diskPct, runtimeEnv
    const flowRes = await fetch(`${baseUrl}/api/flow`, { headers: authHeader });
    assert.equal(flowRes.status, 200);
    const flowJson = await flowRes.json();
    assert.equal(typeof flowJson.memory?.rssMB, 'number');
    assert.equal(typeof flowJson.runtimeEnv, 'string');
    assert.equal(flowJson.active, 1);

    // 4. /api/curve returns 144 buckets & aggregated multi-task peak (3200 + 1800 = 5000)
    const curveRes = await fetch(`${baseUrl}/api/curve?mode=noon`, { headers: authHeader });
    assert.equal(curveRes.status, 200);
    const curveJson = await curveRes.json();
    assert.equal(curveJson.mode, 'noon');
    assert.equal(Array.isArray(curveJson.buckets), true);
    assert.equal(curveJson.buckets.length, 144);
    assert.equal(curveJson.peakKbps, 5000);
    assert.equal(curveJson.sessions.length >= 1, true);

    const midnightRes = await fetch(`${baseUrl}/api/curve?mode=midnight`, { headers: authHeader });
    assert.equal(midnightRes.status, 200);
    const midnightJson = await midnightRes.json();
    assert.equal(midnightJson.mode, 'midnight');

    // 5. /api/logs returns sanitized lines without raw room IDs or RTMP keys
    const logsRes = await fetch(`${baseUrl}/api/logs?onlyErrors=0&limit=20`, { headers: authHeader });
    assert.equal(logsRes.status, 200);
    const logsJson = await logsRes.json();
    assert.equal(Array.isArray(logsJson.lines), true);
    const joined = logsJson.lines.join('\n');
    assert.equal(joined.includes('1847873667'), false, 'logs endpoint must redact room ID');
    assert.equal(joined.includes('my_secret_key'), false, 'logs endpoint must redact RTMP stream key');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (prevToken === undefined) delete process.env.DASHBOARD_TOKEN;
    else process.env.DASHBOARD_TOKEN = prevToken;
  }
});

