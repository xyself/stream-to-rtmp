const test = require('node:test');
const assert = require('node:assert/strict');
const { InputFile, InlineKeyboard } = require('grammy');
const ephemeral = require('../src/bot/ephemeral');
const { buildDashboardKeyboard } = require('../src/bot');

test('buildEphemeralParams nests callback_query_id and respects ephemeral message replacement rule', () => {
  const fromNormal = ephemeral.buildEphemeralParams(
    { callbackQuery: { id: 'cb-1', message: { message_id: 10 } } },
    { replace: true }
  );
  assert.deepEqual(fromNormal, {
    callback_query_id: 'cb-1',
    replace_callback_query_message: true,
  });

  // Bot API 10.4: callback queries from ephemeral messages must NOT pass replace_callback_query_message: true
  const fromEphemeral = ephemeral.buildEphemeralParams(
    { callbackQuery: { id: 'cb-2', message: { ephemeral_message_id: 55 } } },
    { replace: true }
  );
  assert.deepEqual(fromEphemeral, {
    callback_query_id: 'cb-2',
  });

  const fromEphemeralCmd = ephemeral.buildEphemeralParams({
    message: { ephemeral_message_id: 77 },
    from: { id: 9001 },
  });
  assert.deepEqual(fromEphemeralCmd, { receiver_user_id: 9001 });
});

test('sendEphemeralMessage uses ephemeral_message_parameters and falls back to ctx.reply on error', async () => {
  const rawCalls = [];
  const bot = {
    api: {
      raw: {
        sendMessage: async (p) => {
          rawCalls.push(p);
          return { ephemeral_message_id: 101 };
        },
      },
    },
  };

  const kb = new InlineKeyboard().text('刷新', 'log_refresh');
  const ctx = {
    chat: { id: -100123 },
    callbackQuery: { id: 'cb-logs', message: { message_id: 20 } },
    reply: async () => { throw new Error('should not hit fallback'); },
  };

  await ephemeral.sendEphemeralMessage(bot, ctx, '<b>日志</b>', {
    parse_mode: 'HTML',
    reply_markup: kb,
  });

  assert.equal(rawCalls.length, 1);
  assert.equal('callback_query_id' in rawCalls[0], false);
  assert.deepEqual(rawCalls[0].ephemeral_message_parameters, { callback_query_id: 'cb-logs' });
  assert.equal(rawCalls[0].parse_mode, 'HTML');
  assert.equal(rawCalls[0].reply_markup, kb);

  // Fallback path when Telegram rejects ephemeral (e.g. >15s or private/client restriction)
  let fallbackText = null;
  let fallbackOpts = null;
  const failingBot = {
    api: {
      raw: {
        sendMessage: async () => { throw new Error('Bad Request: QUERY_ID_INVALID'); },
      },
    },
  };
  const fallbackCtx = {
    chat: { id: 12345 },
    callbackQuery: { id: 'cb-expired', message: { message_id: 21 } },
    reply: async (t, opts) => { fallbackText = t; fallbackOpts = opts; return { message_id: 99 }; },
  };

  await ephemeral.sendEphemeralMessage(failingBot, fallbackCtx, '参数详情', { parse_mode: 'HTML' });
  assert.equal(fallbackText, '参数详情');
  assert.equal(fallbackOpts.parse_mode, 'HTML');
});

test('sendEphemeralPhoto sends ephemeral photo and seamlessly falls back without reusing consumed InputFile', async () => {
  const rawPhotoCalls = [];
  const fallbackCalls = [];
  const imgBuf = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

  const bot = {
    api: {
      raw: {
        sendPhoto: async (p) => {
          rawPhotoCalls.push(p);
          return { ephemeral_message_id: 202 };
        },
      },
    },
  };
  const ctx = {
    chat: { id: -100999 },
    callbackQuery: { id: 'cb-snap', message: { message_id: 50 } },
    replyWithPhoto: async () => { throw new Error('should not hit fallback'); },
  };

  await ephemeral.sendEphemeralPhoto(bot, ctx, new InputFile(imgBuf, 'snap.jpg'), {
    caption: '📸 截图',
  });
  assert.equal(rawPhotoCalls.length, 1);
  assert.deepEqual(rawPhotoCalls[0].ephemeral_message_parameters, { callback_query_id: 'cb-snap' });
  assert.equal(rawPhotoCalls[0].caption, '📸 截图');

  // Test fallback when slow capture exceeds 15s callback_query_id window
  const failingBot = {
    api: {
      raw: {
        sendPhoto: async () => { throw new Error('Bad Request: query is too old'); },
      },
    },
  };
  const fallbackCtx = {
    chat: { id: -100999 },
    callbackQuery: { id: 'cb-slow', message: { message_id: 51 } },
    replyWithPhoto: async (photo, opts) => {
      fallbackCalls.push({ photo, opts });
      assert.equal(photo.consumed, false);
      return { message_id: 303 };
    },
  };

  await ephemeral.sendEphemeralPhoto(failingBot, fallbackCtx, new InputFile(imgBuf, 'slow.jpg'), {
    caption: '📸 兜底截图',
  });
  assert.equal(fallbackCalls.length, 1);
  assert.equal(fallbackCalls[0].opts.caption, '📸 兜底截图');
});

test('safeEditMessageText uses editEphemeralMessageText when callback originates from ephemeral message', async () => {
  const edited = [];
  const ctx = {
    chat: { id: -100888 },
    from: { id: 42 },
    callbackQuery: {
      id: 'cb-refresh',
      message: {
        chat: { id: -100888 },
        ephemeral_message_id: 321,
        receiver_user: { id: 42 },
      },
    },
    api: {
      raw: {
        editEphemeralMessageText: async (p) => { edited.push(p); return true; },
      },
    },
    editMessageText: async () => { throw new Error('must use editEphemeralMessageText'); },
  };

  await ephemeral.safeEditMessageText(ctx, '新日志内容', { parse_mode: 'HTML' });
  assert.equal(edited.length, 1);
  assert.deepEqual(edited[0], {
    chat_id: -100888,
    receiver_user_id: 42,
    ephemeral_message_id: 321,
    text: '新日志内容',
    parse_mode: 'HTML',
  });
});

test('buildDashboardKeyboard includes global_ffmpeg_params button for ephemeral dashboard access', () => {
  const kb = buildDashboardKeyboard();
  const callbacks = kb.inline_keyboard.flat().map((btn) => btn.callback_data);
  assert.equal(callbacks.includes('global_view_logs'), true);
  assert.equal(callbacks.includes('global_test_notify'), true);
  assert.equal(callbacks.includes('global_ffmpeg_params'), true);
});
