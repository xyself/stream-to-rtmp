const { InputFile } = require('grammy');

/**
 * 构造 Bot API 10.4 的 EphemeralMessageParameters 对象。
 *
 * 官方规范（https://core.telegram.org/bots/api#ephemeralmessageparameters）：
 * - callback_query_id 必须放在 ephemeral_message_parameters 对象内（不能放在顶层参数）。
 * - 省略 receiver_user_id 时，仅点击按钮的用户可见该临时回复。
 * - 若按钮本身来自一条临时消息（message.ephemeral_message_id 存在），
 *   replace_callback_query_message 必须为 false（否则不能替换，应改用 editEphemeralMessageText）。
 */
function buildEphemeralParams(ctx, options = {}) {
  if (ctx?.callbackQuery?.id) {
    const fromEphemeral = Boolean(ctx.callbackQuery?.message?.ephemeral_message_id);
    const params = {
      callback_query_id: ctx.callbackQuery.id,
    };
    if (!fromEphemeral && options.replace) {
      params.replace_callback_query_message = true;
    }
    return params;
  }

  if (ctx?.message?.ephemeral_message_id && ctx?.from?.id) {
    return { receiver_user_id: ctx.from.id };
  }

  if (options.receiverUserId) {
    return { receiver_user_id: options.receiverUserId };
  }

  return null;
}

function makeFreshPhotoInput(photo, filename = 'snapshot.jpg') {
  if (Buffer.isBuffer(photo)) {
    return new InputFile(photo, filename);
  }
  if (photo && typeof photo === 'object' && 'fileData' in photo && Buffer.isBuffer(photo.fileData)) {
    return new InputFile(photo.fileData, photo.filename || filename);
  }
  return photo;
}

/**
 * 发送临时文本回复（Bot API 10.4 Ephemeral Messages），失败或不支持时自动降级到普通回复。
 */
async function sendEphemeralMessage(bot, ctx, text, options = {}) {
  const {
    replace = false,
    receiverUserId,
    reply_parameters: explicitReplyParams,
    chatId: explicitChatId,
    ...msgOpts
  } = options;

  const ephemeralParams = buildEphemeralParams(ctx, { replace, receiverUserId });
  const chatId = explicitChatId ?? ctx?.chat?.id ?? ctx?.callbackQuery?.message?.chat?.id ?? ctx?.from?.id;
  const rawSendMessage = bot?.api?.raw?.sendMessage || ctx?.api?.raw?.sendMessage;

  if (ephemeralParams && typeof rawSendMessage === 'function') {
    const payload = {
      ...(chatId !== undefined ? { chat_id: chatId } : {}),
      text,
      ...msgOpts,
      ephemeral_message_parameters: ephemeralParams,
    };
    if (!ctx?.callbackQuery?.id && ctx?.message?.ephemeral_message_id) {
      payload.reply_parameters = { ephemeral_message_id: ctx.message.ephemeral_message_id };
    } else if (explicitReplyParams) {
      payload.reply_parameters = explicitReplyParams;
    }

    try {
      return await rawSendMessage(payload);
    } catch (err) {
      // 旧客户端、私聊限制、或 callback_query_id 超过 15 秒有效期时自动降级到普通消息，不丢失回复
      if (typeof ctx?.reply === 'function') {
        return await ctx.reply(text, msgOpts);
      }
      if (chatId !== undefined && typeof bot?.api?.sendMessage === 'function') {
        return await bot.api.sendMessage(chatId, text, msgOpts);
      }
      throw err;
    }
  }

  if (typeof ctx?.reply === 'function') {
    return await ctx.reply(text, msgOpts);
  }
  if (chatId !== undefined && typeof bot?.api?.sendMessage === 'function') {
    return await bot.api.sendMessage(chatId, text, msgOpts);
  }
  throw new Error('Cannot send message: missing ctx.reply and chatId');
}

/**
 * 发送临时图片/截图（Bot API 10.4 Ephemeral Messages），失败或超过 15 秒超时时自动降级到普通图片消息。
 */
async function sendEphemeralPhoto(bot, ctx, photo, options = {}) {
  const {
    replace = false,
    receiverUserId,
    reply_parameters: explicitReplyParams,
    chatId: explicitChatId,
    filename,
    ...photoOpts
  } = options;

  const ephemeralParams = buildEphemeralParams(ctx, { replace, receiverUserId });
  const chatId = explicitChatId ?? ctx?.chat?.id ?? ctx?.callbackQuery?.message?.chat?.id ?? ctx?.from?.id;
  const rawSendPhoto = bot?.api?.raw?.sendPhoto || ctx?.api?.raw?.sendPhoto;

  if (ephemeralParams && typeof rawSendPhoto === 'function') {
    const payload = {
      ...(chatId !== undefined ? { chat_id: chatId } : {}),
      photo: makeFreshPhotoInput(photo, filename),
      ...photoOpts,
      ephemeral_message_parameters: ephemeralParams,
    };
    if (!ctx?.callbackQuery?.id && ctx?.message?.ephemeral_message_id) {
      payload.reply_parameters = { ephemeral_message_id: ctx.message.ephemeral_message_id };
    } else if (explicitReplyParams) {
      payload.reply_parameters = explicitReplyParams;
    }

    try {
      return await rawSendPhoto(payload);
    } catch (err) {
      // 截图耗时较长超过 15s callback_query_id 窗口，或环境不支持临时消息时，无缝降级为普通图片
      const fallbackPhoto = makeFreshPhotoInput(photo, filename);
      if (typeof ctx?.replyWithPhoto === 'function') {
        return await ctx.replyWithPhoto(fallbackPhoto, photoOpts);
      }
      if (chatId !== undefined && typeof bot?.api?.sendPhoto === 'function') {
        return await bot.api.sendPhoto(chatId, fallbackPhoto, photoOpts);
      }
      throw err;
    }
  }

  const normalPhoto = makeFreshPhotoInput(photo, filename);
  if (typeof ctx?.replyWithPhoto === 'function') {
    return await ctx.replyWithPhoto(normalPhoto, photoOpts);
  }
  if (chatId !== undefined && typeof bot?.api?.sendPhoto === 'function') {
    return await bot.api.sendPhoto(chatId, normalPhoto, photoOpts);
  }
  throw new Error('Cannot send photo: missing ctx.replyWithPhoto and chatId');
}

/**
 * 安全编辑文本消息：若原消息是临时消息（存在 ephemeral_message_id），自动改用 Bot API 10.4 editEphemeralMessageText。
 */
async function safeEditMessageText(ctx, text, options = {}) {
  const msg = ctx?.callbackQuery?.message;
  if (msg?.ephemeral_message_id) {
    const chatId = ctx?.chat?.id ?? msg.chat?.id;
    const receiverUserId = msg.receiver_user?.id ?? ctx?.from?.id;
    const editEphemeral = ctx?.api?.raw?.editEphemeralMessageText;
    if (chatId !== undefined && receiverUserId !== undefined && typeof editEphemeral === 'function') {
      try {
        return await editEphemeral({
          chat_id: chatId,
          receiver_user_id: receiverUserId,
          ephemeral_message_id: msg.ephemeral_message_id,
          text,
          ...options,
        });
      } catch (err) {
        if (err?.message?.includes('message is not modified')) return;
        throw err;
      }
    }
  }

  try {
    return await ctx.editMessageText(text, options);
  } catch (err) {
    if (err?.message?.includes('message is not modified')) return;
    throw err;
  }
}

module.exports = {
  buildEphemeralParams,
  makeFreshPhotoInput,
  sendEphemeralMessage,
  sendEphemeralPhoto,
  safeEditMessageText,
};
