function parseAllowedChatId(value = process.env.TG_CHAT_ID) {
  if (value === undefined || value === null || value === '') return null;
  const ids = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  return ids.length > 0 ? new Set(ids) : null;
}

function parseExtraTargetUrls(input = '') {
  return input
    .split(/\r?\n|,|，/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function getMessageTextOrEmpty(message) {
  if (typeof message?.text === 'string') return message.text.trim();
  if (typeof message?.caption === 'string') return message.caption.trim();
  return '';
}

function isNumericRoomId(value) {
  return /^\d+$/.test(value);
}

function isValidRelayTargetUrl(value) {
  return /^(rtmp|rtmps):\/\//i.test(value);
}

function parsePlatformAlias(token = '') {
  const lower = String(token).trim().toLowerCase();
  if (['bilibili', 'bili', 'b站', '哔哩哔哩'].includes(lower)) return 'bilibili';
  if (['douyu', '斗鱼'].includes(lower)) return 'douyu';
  if (['douyin', '抖音'].includes(lower)) return 'douyin';
  return null;
}

function parseLiveRoomInput(input) {
  const text = String(input || '').trim();

  if (/^\d+$/.test(text)) {
    return { roomId: text, platform: null };
  }

  const biliLive = text.match(/live\.bilibili\.com\/(\d+)/i);
  if (biliLive) return { roomId: biliLive[1], platform: 'bilibili' };

  if (/space\.bilibili\.com/i.test(text)) {
    return { error: '这是 B 站个人空间链接，请发送直播间链接（live.bilibili.com/房间号）' };
  }

  const douyuLive = text.match(/douyu\.com\/(\d+)/i);
  if (douyuLive) return { roomId: douyuLive[1], platform: 'douyu' };

  const douyinLive = text.match(/live\.douyin\.com\/(\d+)/i);
  if (douyinLive) return { roomId: douyinLive[1], platform: 'douyin' };

  if (/v\.douyin\.com/i.test(text)) {
    return { error: '请发送抖音直播间链接（live.douyin.com/房间号），不支持短链接' };
  }

  return { error: '无法识别，请发送直播间链接或纯数字房间号' };
}

/**
 * 解析“一条消息极速添加房间”输入：
 * 支持：
 * 1) https://live.bilibili.com/1000 rtmp://a.rtmp.youtube.com/live2/key1 [rtmp://backup...]
 * 2) bilibili 1000 rtmp://... 或 B站 1000 rtmp://...
 */
function parseQuickAddInput(input = '') {
  const text = String(input || '').trim().replace(/^\/addroom\s+/i, '');
  if (!text) return null;

  const tokens = text
    .split(/[\s,，]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const rtmpUrls = tokens.filter((t) => isValidRelayTargetUrl(t));
  if (rtmpUrls.length === 0) return null;

  const nonRtmpTokens = tokens.filter((t) => !isValidRelayTargetUrl(t));
  if (nonRtmpTokens.length === 0) return null;

  // 情况 1：包含直播间链接
  for (const token of nonRtmpTokens) {
    const parsed = parseLiveRoomInput(token);
    if (parsed.roomId && parsed.platform) {
      return {
        platform: parsed.platform,
        roomId: parsed.roomId,
        targetUrl: rtmpUrls[0],
        extraTargetUrls: rtmpUrls.slice(1),
      };
    }
  }

  // 情况 2：平台别名 + 纯数字房间号（如 "b站 1000 rtmp://..." 或 "1000 bilibili rtmp://..."）
  let platform = null;
  let roomId = null;
  for (const token of nonRtmpTokens) {
    const p = parsePlatformAlias(token);
    if (p && !platform) {
      platform = p;
      continue;
    }
    if (isNumericRoomId(token) && !roomId) {
      roomId = token;
    }
  }

  if (platform && roomId) {
    return {
      platform,
      roomId,
      targetUrl: rtmpUrls[0],
      extraTargetUrls: rtmpUrls.slice(1),
    };
  }

  return null;
}

const SESSION_TIMEOUT_MS = 60 * 1000;

function isSessionExpired(state) {
  if (!state?.startedAt) return false;
  return Date.now() - state.startedAt > SESSION_TIMEOUT_MS;
}

function cleanExpiredSessions(sessionData) {
  if (isSessionExpired(sessionData.addRoom)) {
    sessionData.addRoom = { step: null, roomId: null, platform: null };
  }
  if (isSessionExpired(sessionData.editRoom)) sessionData.editRoom = null;
  if (isSessionExpired(sessionData.editRtmp)) sessionData.editRtmp = null;
  if (isSessionExpired(sessionData.addRtmp)) sessionData.addRtmp = null;
  if (isSessionExpired(sessionData.setCookie)) sessionData.setCookie = null;
  if (isSessionExpired(sessionData.editRoomCookie)) sessionData.editRoomCookie = null;
}

function resetAllSessions(sessionData) {
  sessionData.addRoom = { step: null, roomId: null, platform: null };
  sessionData.editRoom = null;
  sessionData.editRtmp = null;
  sessionData.addRtmp = null;
  sessionData.setCookie = null;
  sessionData.editRoomCookie = null;
}

function ensureAddRoomState(sessionData) {
  if (!sessionData.addRoom || typeof sessionData.addRoom !== 'object') {
    sessionData.addRoom = { step: null, roomId: null, platform: null };
  }
  return sessionData.addRoom;
}

function resetAddRoomState(sessionData) {
  sessionData.addRoom = { step: null, roomId: null, platform: null };
}

module.exports = {
  parseAllowedChatId,
  parseExtraTargetUrls,
  getMessageTextOrEmpty,
  isNumericRoomId,
  parseLiveRoomInput,
  parseQuickAddInput,
  parsePlatformAlias,
  isValidRelayTargetUrl,
  isSessionExpired,
  cleanExpiredSessions,
  resetAllSessions,
  ensureAddRoomState,
  resetAddRoomState,
};
