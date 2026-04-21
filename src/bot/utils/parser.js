function parseAllowedChatId(value = process.env.TG_CHAT_ID) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).trim();
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

function parseLiveRoomInput(input) {
  const text = input.trim();

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

function isValidRelayTargetUrl(value) {
  return /^(rtmp|rtmps):\/\//i.test(value);
}

const SESSION_TIMEOUT_MS = 5 * 60 * 1000;

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
}

function resetAllSessions(sessionData) {
  sessionData.addRoom = { step: null, roomId: null, platform: null };
  sessionData.editRoom = null;
  sessionData.editRtmp = null;
  sessionData.addRtmp = null;
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
  isValidRelayTargetUrl,
  isSessionExpired,
  cleanExpiredSessions,
  resetAllSessions,
  ensureAddRoomState,
  resetAddRoomState,
};
