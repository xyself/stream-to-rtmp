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

function isMessageNotModifiedError(err) {
  const msg = String(err?.description || err?.message || '');
  return /message is not modified/i.test(msg);
}

function isUneditableMessageError(err) {
  const msg = String(err?.description || err?.message || '');
  return /message can't be edited|there is no text in the message to edit|message to edit not found|message_id_invalid|message is not found/i.test(msg);
}

function isMediaCallbackMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.photo || msg.video || msg.document || msg.animation || msg.audio || msg.sticker || msg.voice) {
    return true;
  }
  // 存在 caption 但没有 text 的消息均为媒体消息，不可直接调用 editMessageText
  if (msg.text === undefined && msg.caption !== undefined) {
    return true;
  }
  return false;
}

async function fallbackSendText(ctx, text, options = {}) {
  if (typeof ctx?.reply === 'function') {
    return await ctx.reply(text, options);
  }
  const chatId = ctx?.chat?.id ?? ctx?.callbackQuery?.message?.chat?.id ?? ctx?.from?.id;
  if (chatId !== undefined && typeof ctx?.api?.sendMessage === 'function') {
    return await ctx.api.sendMessage(chatId, text, options);
  }
  throw new Error('Cannot fallback send message: missing ctx.reply and chatId');
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
 * 安全编辑文本消息：
 * 1. 若按钮来自图片/媒体消息（如曲线图、截图、封面），直接降级为发送新文本消息，避免 400: message can't be edited。
 * 2. 若原消息是临时消息（存在 ephemeral_message_id），优先使用 Bot API 10.4 editEphemeralMessageText，失败则降级发送新消息。
 * 3. 若编辑普通消息返回 message is not modified，静默忽略；返回不可编辑（超 48 小时/已删除/非文本）则自动降级发送新消息。
 */
async function safeEditMessageText(ctx, text, options = {}) {
  const msg = ctx?.callbackQuery?.message;

  // 非回调消息（如普通文本/命令消息）不可调用 editMessageText 编辑用户自己的消息，直接回复新消息
  if (!msg || isMediaCallbackMessage(msg)) {
    return await fallbackSendText(ctx, text, options);
  }

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
        if (isMessageNotModifiedError(err)) return;
        if (isUneditableMessageError(err)) {
          return await fallbackSendText(ctx, text, options);
        }
        throw err;
      }
    }
  }

  if (typeof ctx?.editMessageText !== 'function') {
    return await fallbackSendText(ctx, text, options);
  }

  try {
    return await ctx.editMessageText(text, options);
  } catch (err) {
    if (isMessageNotModifiedError(err)) return;
    if (isUneditableMessageError(err)) {
      return await fallbackSendText(ctx, text, options);
    }
    throw err;
  }
}

/**
 * 安全原地刷新图片消息（用于曲线图时间窗口/房间切换，避免刷屏）；
 * 若原消息不是可编辑的普通图片消息或编辑失败，自动无缝降级为发送新图片消息。
 */
async function safeEditMessageMedia(ctx, photoBufferOrFile, options = {}) {
  const {
    caption = '',
    parse_mode: parseMode = 'HTML',
    reply_markup: replyMarkup,
    filename = 'chart.png',
    fallbackSendPhoto,
  } = options;

  const msg = ctx?.callbackQuery?.message;
  const canEditInPlace = Boolean(
    msg &&
    !msg.ephemeral_message_id &&
    isMediaCallbackMessage(msg) &&
    typeof ctx?.editMessageMedia === 'function'
  );

  if (canEditInPlace) {
    try {
      const media = {
        type: 'photo',
        media: makeFreshPhotoInput(photoBufferOrFile, filename),
        caption,
        parse_mode: parseMode,
      };
      return await ctx.editMessageMedia(media, replyMarkup ? { reply_markup: replyMarkup } : undefined);
    } catch (err) {
      if (isMessageNotModifiedError(err)) return;
      // 任何编辑失败（超 48 小时、媒体类型限制等）均无缝降级为发送新图
    }
  }

  const freshPhoto = makeFreshPhotoInput(photoBufferOrFile, filename);
  const photoOpts = {
    caption,
    parse_mode: parseMode,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  };
  if (typeof fallbackSendPhoto === 'function') {
    return await fallbackSendPhoto(ctx, freshPhoto, photoOpts);
  }
  if (typeof ctx?.replyWithPhoto === 'function') {
    return await ctx.replyWithPhoto(freshPhoto, photoOpts);
  }
  const chatId = ctx?.chat?.id ?? msg?.chat?.id ?? ctx?.from?.id;
  if (chatId !== undefined && typeof ctx?.api?.sendPhoto === 'function') {
    return await ctx.api.sendPhoto(chatId, freshPhoto, photoOpts);
  }
  throw new Error('Cannot send or edit photo: missing replyWithPhoto and chatId');
}

module.exports = {
  buildEphemeralParams,
  makeFreshPhotoInput,
  isMessageNotModifiedError,
  isUneditableMessageError,
  isMediaCallbackMessage,
  sendEphemeralMessage,
  sendEphemeralPhoto,
  safeEditMessageText,
  safeEditMessageMedia,
};
