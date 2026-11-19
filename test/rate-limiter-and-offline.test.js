const test = require('node:test');
const assert = require('node:assert/strict');
const { PlatformRateLimiter } = require('../src/platforms/rate-limiter');
const BaseRoom = require('../src/platforms/base-room');
const StreamManager = require('../src/core/manager');
const { isOfflineMessage } = StreamManager;
const db = require('../src/db');

test('PlatformRateLimiter serializes same-platform calls and enforces minimum interval', async () => {
  let fakeNow = 1000;
  const sleeps = [];
  const limiter = new PlatformRateLimiter(
    { bilibili: 1500 },
    {
      now: () => fakeNow,
      sleep: async (ms) => {
        sleeps.push(ms);
        fakeNow += ms;
      },
    }
  );

  const order = [];
  const p1 = limiter.schedule('bilibili', async () => {
    order.push(['start-1', fakeNow]);
    fakeNow += 200;
    order.push(['end-1', fakeNow]);
    return 'r1';
  });
  const p2 = limiter.schedule('bilibili', async () => {
    order.push(['start-2', fakeNow]);
    fakeNow += 100;
    order.push(['end-2', fakeNow]);
    return 'r2';
  });

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, 'r1');
  assert.equal(r2, 'r2');
  assert.deepEqual(sleeps, [1500]);
  assert.deepEqual(order, [
    ['start-1', 1000],
    ['end-1', 1200],
    ['start-2', 2700],
    ['end-2', 2800],
  ]);
});

test('PlatformRateLimiter runs different platforms concurrently and recovers from errors', async () => {
  const limiter = new PlatformRateLimiter({ bilibili: 50, douyu: 50 });
  const events = [];

  const biliErr = limiter.schedule('bilibili', async () => {
    events.push('bili-1-fail');
    throw new Error('boom');
  });
  const douyuOk = limiter.schedule('douyu', async () => {
    events.push('douyu-1-ok');
    return 'ok';
  });
  const biliNext = limiter.schedule('bilibili', async () => {
    events.push('bili-2-ok');
    return 'recovered';
  });

  await assert.rejects(biliErr, /boom/);
  assert.equal(await douyuOk, 'ok');
  assert.equal(await biliNext, 'recovered');
  assert.ok(events.includes('douyu-1-ok'));
  assert.ok(events.includes('bili-2-ok'));
});

test('BaseRoom routes getInfo, getStreamUrl, and getStreamUrls through rateLimiter', async () => {
  const scheduledPlatforms = [];
  const fakeLimiter = {
    schedule: async (platform, fn) => {
      scheduledPlatforms.push(platform);
      return fn();
    },
  };

  const room = new BaseRoom({
    roomId: '100',
    platform: 'bilibili',
    rateLimiter: fakeLimiter,
    engine: {
      getInfo: async () => ({ isLive: true, hostName: 'H', roomName: 'R' }),
      getStreamUrl: async () => 'https://example.com/1.flv',
      getStreamUrls: async () => ['https://example.com/1.flv', 'https://example.com/2.flv'],
    },
  });

  await room.getInfo();
  await room.getStreamUrl();
  const urls = await room.getStreamUrls();

  assert.equal(urls.length, 2);
  assert.deepEqual(scheduledPlatforms, ['bilibili', 'bilibili', 'bilibili']);
});

test('isOfflineMessage recognizes offline messages vs real errors', () => {
  assert.equal(isOfflineMessage('B站解析失败: 主播尚未开播'), true);
  assert.equal(isOfflineMessage('斗鱼解析失败: 房间未开播'), true);
  assert.equal(isOfflineMessage('抖音解析失败: 主播已下播'), true);
  assert.equal(isOfflineMessage('B站解析失败: B站接口返回异常 (code=-412)'), false);
  assert.equal(isOfflineMessage('网络请求失败，请检查网络: timeout'), false);
});

test('StreamManager.handleRoomError does not increment errorCount or persist last_error for offline rooms', () => {
  const recordedUpdates = [];
  const origUpdateError = db.updateError;
  db.updateError = (id, msg) => {
    recordedUpdates.push([id, msg]);
    return { changes: 0 };
  };

  const manager = new StreamManager(
    {
      id: 999,
      platform: 'bilibili',
      room_id: '12345',
      primary_target_url: 'rtmp://example.com/live/key',
    },
    { isBootGrace: () => true }
  );

  try {
    manager.handleRoomError('B站解析失败: 主播尚未开播');
    assert.equal(manager.errorCount, 0);
    assert.equal(manager.lastNotifyType, 'offline');
    assert.deepEqual(recordedUpdates.at(-1), [999, null]);

    manager.handleRoomError('B站解析失败: B站接口返回异常 (code=-412)');
    assert.equal(manager.errorCount, 1);
    assert.equal(manager.lastNotifyType, 'error');
    assert.deepEqual(recordedUpdates.at(-1), [999, 'B站解析失败: B站接口返回异常 (code=-412)']);
  } finally {
    manager.stop();
    db.updateError = origUpdateError;
  }
});
