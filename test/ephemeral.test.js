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

test('safeEditMessageText automatically falls back to ctx.reply on photo/caption messages and 400 message can\'t be edited', async () => {
  // Case 1: callback from a photo message (e.g. clicking "房间控制台" on a curve chart or snapshot)
  const replies1 = [];
  const photoCtx = {
    chat: { id: 1001 },
    callbackQuery: {
      id: 'cb-from-photo',
      message: { message_id: 88, photo: [{ file_id: 'abc' }], caption: '曲线图' },
    },
    editMessageText: async () => { throw new Error('must not call editMessageText on photo message'); },
    reply: async (text, opts) => { replies1.push({ text, opts }); return { message_id: 89 }; },
  };
  await ephemeral.safeEditMessageText(photoCtx, '<b>单房间控制台</b>', { parse_mode: 'HTML' });
  assert.equal(replies1.length, 1);
  assert.equal(replies1[0].text, '<b>单房间控制台</b>');

  // Case 2: editMessageText throws Telegram 400 "message can't be edited"
  const replies2 = [];
  const expiredCtx = {
    chat: { id: 1002 },
    callbackQuery: {
      id: 'cb-expired',
      message: { message_id: 12, text: 'old message' },
    },
    editMessageText: async () => {
      throw new Error("Call to 'editMessageText' failed! (400: Bad Request: message can't be edited)");
    },
    reply: async (text, opts) => { replies2.push({ text, opts }); return { message_id: 13 }; },
  };
  await ephemeral.safeEditMessageText(expiredCtx, '刷新后的面板', { parse_mode: 'HTML' });
  assert.equal(replies2.length, 1);
  assert.equal(replies2[0].text, '刷新后的面板');

  // Case 3: "message is not modified" is silently ignored without duplicate reply
  let repliedOnSame = false;
  const sameCtx = {
    chat: { id: 1003 },
    callbackQuery: { id: 'cb-same', message: { message_id: 14, text: 'same' } },
    editMessageText: async () => { throw new Error('400: Bad Request: message is not modified'); },
    reply: async () => { repliedOnSame = true; },
  };
  await ephemeral.safeEditMessageText(sameCtx, 'same', { parse_mode: 'HTML' });
  assert.equal(repliedOnSame, false);
});

test('safeEditMessageMedia edits photo in place and falls back cleanly to replyWithPhoto when uneditable', async () => {
  const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const kb = new InlineKeyboard().text('1小时', 'curve:1:1h');

  // Case 1: in-place edit succeeds
  const mediaEdits = [];
  const okCtx = {
    chat: { id: 2001 },
    callbackQuery: { id: 'cb-chart', message: { message_id: 500, photo: [{ file_id: 'p1' }] } },
    editMessageMedia: async (media, opts) => { mediaEdits.push({ media, opts }); return true; },
    replyWithPhoto: async () => { throw new Error('should edit in place'); },
  };
  await ephemeral.safeEditMessageMedia(okCtx, pngBuf, {
    caption: '<b>近1小时曲线</b>',
    parse_mode: 'HTML',
    reply_markup: kb,
    filename: 'curve_1h.png',
  });
  assert.equal(mediaEdits.length, 1);
  assert.equal(mediaEdits[0].media.type, 'photo');
  assert.equal(mediaEdits[0].media.caption, '<b>近1小时曲线</b>');
  assert.equal(mediaEdits[0].opts.reply_markup, kb);

  // Case 2: editMessageMedia fails with 400 -> sends fresh unconsumed InputFile via replyWithPhoto
  const fallbackPhotos = [];
  const failCtx = {
    chat: { id: 2002 },
    callbackQuery: { id: 'cb-chart-old', message: { message_id: 501, photo: [{ file_id: 'p2' }] } },
    editMessageMedia: async () => { throw new Error("400: Bad Request: message can't be edited"); },
    replyWithPhoto: async (file, opts) => {
      fallbackPhotos.push({ file, opts });
      assert.equal(file.consumed, false);
      return { message_id: 502 };
    },
  };
  await ephemeral.safeEditMessageMedia(failCtx, pngBuf, {
    caption: '兜底新图',
    parse_mode: 'HTML',
    reply_markup: kb,
  });
  assert.equal(fallbackPhotos.length, 1);
  assert.equal(fallbackPhotos[0].opts.caption, '兜底新图');
});

test('safeEditMessageText never tries to edit a plain user message without callbackQuery, and 📊 推流状态 replies cleanly', async () => {
  const replies = [];
  const plainUserMsgCtx = {
    chat: { id: 3001 },
    message: { message_id: 99, text: '📊 推流状态' },
    editMessageText: async () => {
      throw new Error("must not call editMessageText on a user's own message");
    },
    reply: async (text, opts) => {
      replies.push({ text, opts });
      return { message_id: 100 };
    },
  };

  await ephemeral.safeEditMessageText(plainUserMsgCtx, '<b>📊 推流状态总览</b>', { parse_mode: 'HTML' });
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, '<b>📊 推流状态总览</b>');
});
