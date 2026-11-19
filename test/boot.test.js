const test = require('node:test');
const assert = require('node:assert/strict');
const { createRelayBot } = require('../src/bot');
const { parseAllowedChatId } = require('../src/bot/utils/parser');

test('createRelayBot gracefully returns unconfigured stub when TG_TOKEN is empty', () => {
  const bot = createRelayBot('');
  assert.equal(bot.isConfigured, false);
  assert.equal(bot.isRunning(), false);
  assert.equal(typeof bot.start, 'function');
  assert.equal(typeof bot.stop, 'function');
});

test('parseAllowedChatId returns null when TG_CHAT_ID is empty and parses comma-separated IDs', () => {
  assert.equal(parseAllowedChatId(''), null);
  const ids = parseAllowedChatId('12345, 67890');
  assert.equal(ids.has('12345'), true);
  assert.equal(ids.has('67890'), true);
});
