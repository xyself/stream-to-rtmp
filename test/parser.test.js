const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isSessionExpired,
  cleanExpiredSessions,
  resetAllSessions,
  ensureAddRoomState,
  resetAddRoomState,
  parseLiveRoomInput,
  SESSION_TIMEOUT_MS,
} = require('../src/bot/utils/parser');

test('session utilities', async (t) => {
  await t.test('isSessionExpired', () => {
    // Missing startedAt
    assert.equal(isSessionExpired({}), false);
    assert.equal(isSessionExpired(null), false);
    assert.equal(isSessionExpired(undefined), false);

    const now = Date.now();
    // Recent session
    assert.equal(isSessionExpired({ startedAt: now - 1000 }), false);
    // Expired session
    assert.equal(isSessionExpired({ startedAt: now - SESSION_TIMEOUT_MS - 1000 }), true);
  });

  await t.test('cleanExpiredSessions', () => {
    const now = Date.now();
    const sessionData = {
      addRoom: { startedAt: now - 1000, step: 'some-step' },
      editRoom: { startedAt: now - SESSION_TIMEOUT_MS - 1000, roomId: '216132' },
      editRtmp: { startedAt: now - 1000, url: 'rtmp://...' },
      addRtmp: { startedAt: now - SESSION_TIMEOUT_MS - 1000, step: 'init' },
    };

    cleanExpiredSessions(sessionData);

    // addRoom was not expired
    assert.deepEqual(sessionData.addRoom, { startedAt: now - 1000, step: 'some-step' });
    // editRoom was expired
    assert.equal(sessionData.editRoom, null);
    // editRtmp was not expired
    assert.deepEqual(sessionData.editRtmp, { startedAt: now - 1000, url: 'rtmp://...' });
    // addRtmp was expired
    assert.equal(sessionData.addRtmp, null);

    // Test addRoom expiration specially as it resets to an object
    const expiredAddRoom = {
      addRoom: { startedAt: now - SESSION_TIMEOUT_MS - 1000, step: 'some-step' },
    };
    cleanExpiredSessions(expiredAddRoom);
    assert.deepEqual(expiredAddRoom.addRoom, { step: null, roomId: null, platform: null });
  });

  await t.test('resetAllSessions', () => {
    const sessionData = {
      addRoom: { step: 'active' },
      editRoom: { roomId: '894220' },
      editRtmp: { url: 'rtmp://...' },
      addRtmp: { step: 'init' },
    };

    resetAllSessions(sessionData);

    assert.deepEqual(sessionData.addRoom, { step: null, roomId: null, platform: null });
    assert.equal(sessionData.editRoom, null);
    assert.equal(sessionData.editRtmp, null);
    assert.equal(sessionData.addRtmp, null);
  });

  await t.test('ensureAddRoomState', () => {
    const sessionData = {};
    const result = ensureAddRoomState(sessionData);

    assert.deepEqual(sessionData.addRoom, { step: null, roomId: null, platform: null });
    assert.equal(result, sessionData.addRoom);

    // Should return existing if valid
    const existing = { step: 'step1', roomId: '491197958619', platform: 'douyin' };
    sessionData.addRoom = existing;
    const result2 = ensureAddRoomState(sessionData);
    assert.equal(result2, existing);
  });

  await t.test('resetAddRoomState', () => {
    const sessionData = {
      addRoom: { step: 'active' },
      editRoom: { roomId: '216132' },
    };

    resetAddRoomState(sessionData);

    assert.deepEqual(sessionData.addRoom, { step: null, roomId: null, platform: null });
    // Other sessions should remain untouched
    assert.deepEqual(sessionData.editRoom, { roomId: '216132' });
  });

  await t.test('parseLiveRoomInput', () => {
    // Douyin
    assert.deepEqual(parseLiveRoomInput('https://live.douyin.com/491197958619'), { roomId: '491197958619', platform: 'douyin' });
    // Douyu
    assert.deepEqual(parseLiveRoomInput('https://www.douyu.com/216132'), { roomId: '216132', platform: 'douyu' });
    // Bilibili
    assert.deepEqual(parseLiveRoomInput('https://live.bilibili.com/894220'), { roomId: '894220', platform: 'bilibili' });

    // Numeric ID
    assert.deepEqual(parseLiveRoomInput('123456'), { roomId: '123456', platform: null });

    // Error cases
    assert.ok(parseLiveRoomInput('https://space.bilibili.com/123').error);
    assert.ok(parseLiveRoomInput('https://v.douyin.com/abc').error);
    assert.ok(parseLiveRoomInput('invalid input').error);
  });
});
