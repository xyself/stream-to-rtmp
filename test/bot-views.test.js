const assert = require('node:assert/strict');
const { test } = require('node:test');

const views = require('../src/bot/views');

test('room list text summarizes relay rooms for interactive menu', () => {
  const text = views.renderRoomList([
    { id: 1, platform: 'bilibili', room_id: '100', status: 'ENABLED' },
    { id: 2, platform: 'douyu', room_id: '200', status: 'DISABLED' },
  ]);

  assert.match(text, /房间管理/);
  assert.match(text, /1\. ✅ B站 · #100/);
  assert.match(text, /2\. 🛑 斗鱼 · #200/);
});

test('dashboard text highlights room totals system state and traffic entry', () => {
  const text = views.renderDashboard({
    system: { uptime: '3天 4小时', cpuBar: '████░░░░░░', cpuPercent: 40, memUsed: '1.80 GB', memTotal: '4.00 GB', dbSize: '12.40 MB' },
    stats: { totalTasks: 5, enabledTasks: 3, disabledTasks: 2, runningManagers: 2, totalTargets: 7 },
    recentErrors: ['[B站 #1001] FFmpeg 异常退出'],
  });

  assert.match(text, /全局控制台/);
  assert.match(text, /3天 4小时/);
  assert.match(text, /CPU/);
  assert.match(text, /40%/);
  assert.match(text, /1\.80 GB/);
  assert.match(text, /总计: 5/);
  assert.match(text, /运行: 3/);
  assert.match(text, /推流线路: 7/);
  assert.match(text, /FFmpeg 异常退出/);
});

test('room traffic text includes per-room traffic summary', () => {
  const text = views.renderRoomTraffic([
    {
      id: 9,
      platform: 'douyu',
      room_id: '7788',
      status: 'ENABLED',
      traffic: {
        totalBytes: 5 * 1024 * 1024 * 1024,
        sessionBytes: 512 * 1024 * 1024,
        bitrateKbps: 4096,
        updatedAt: '2026-04-19T06:40:00.000Z',
      },
    },
  ]);

  assert.match(text, /流量查看/);
  assert.match(text, /斗鱼 · #7788/);
  assert.match(text, /累计 5\.00 GB/);
  assert.match(text, /本次 512\.00 MB/);
  assert.match(text, /4096 kbps/);
});

test('task detail text includes scheduler state last error and multiple RTMP targets', () => {
  const text = views.renderTaskDetail({
    id: 9,
    platform: 'douyu',
    room_id: '7788',
    target_url: 'rtmp://example/live/secret',
    primary_target_url: 'rtmp://example/live/secret',
    targets: [
      { id: 1, target_url: 'rtmp://example/live/secret' },
      { id: 2, target_url: 'rtmp://backup/live/room-7788' },
    ],
    status: 'ENABLED',
    last_error: 'STREAM_ENDED',
  }, true);

  assert.match(text, /斗鱼/);
  assert.match(text, /#7788/);
  assert.match(text, /运行中/);
  assert.match(text, /FFmpeg ✅/);
  assert.match(text, /推流地址 \(2\)/);
  assert.match(text, /rtmp:\/\/example\/live\/secret/);
  assert.match(text, /rtmp:\/\/backup\/live\/room-7788/);
  assert.match(text, /STREAM_ENDED/);
});

test('task detail falls back to not configured when no rtmp target exists', () => {
  const text = views.renderTaskDetail({
    id: 10,
    platform: 'bilibili',
    room_id: '5566',
    status: 'DISABLED',
    last_error: null,
    targets: [],
  }, false);

  assert.match(text, /未配置/);
  assert.match(text, /#5566/);
});

test('system status text summarizes totals and running managers', () => {
  const text = views.renderSystemStatus({
    totalTasks: 5,
    enabledTasks: 3,
    disabledTasks: 2,
    runningManagers: 2,
  });

  assert.match(text, /全局控制台/);
  assert.match(text, /总计: 5/);
  assert.match(text, /运行: 3/);
  assert.match(text, /暂停: 2/);
  assert.match(text, /FFmpeg: 2/);
});
