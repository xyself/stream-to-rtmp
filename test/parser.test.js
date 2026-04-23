const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isSessionExpired,
  cleanExpiredSessions,
  resetAllSessions,
  ensureAddRoomState,
  resetAddRoomState,
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
      editRoom: { startedAt: now - SESSION_TIMEOUT_MS - 1000, roomId: '123' },
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
      editRoom: { roomId: '123' },
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
    const existing = { step: 'step1', roomId: '1', platform: 'p' };
    sessionData.addRoom = existing;
    const result2 = ensureAddRoomState(sessionData);
    assert.equal(result2, existing);
  });

  await t.test('resetAddRoomState', () => {
    const sessionData = {
      addRoom: { step: 'active' },
      editRoom: { roomId: '123' },
    };

    resetAddRoomState(sessionData);

    assert.deepEqual(sessionData.addRoom, { step: null, roomId: null, platform: null });
    // Other sessions should remain untouched
    assert.deepEqual(sessionData.editRoom, { roomId: '123' });
  });
});
