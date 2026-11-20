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

function extractFirstUrl(text = '') {
  const match = String(text || '').match(/https?:\/\/[^\s<>"{}|\\^`\[\]]+/i);
  return match ? match[0].replace(/[),，。！？!?;；]+$/, '') : null;
}

function isShortLiveUrl(url = '') {
  return /(?:v\.douyin\.com|b23\.tv|bili2233\.cn)\//i.test(String(url || ''));
}

function parseLiveRoomInput(input) {
  const text = String(input || '').trim();

  if (/^\d+$/.test(text)) {
    return { roomId: text, platform: null };
  }

  const biliLive = text.match(/live\.bilibili\.com\/(?:h5\/)?(\d+)/i);
  if (biliLive) return { roomId: biliLive[1], platform: 'bilibili' };

  if (/space\.bilibili\.com/i.test(text)) {
    return { error: '这是 B 站个人空间链接，请发送直播间链接（live.bilibili.com/房间号）' };
  }

  const douyuRid = text.match(/douyu\.com\/[^?\s]*[?&]rid=(\d+)/i);
  if (douyuRid) return { roomId: douyuRid[1], platform: 'douyu' };

  const douyuLive = text.match(/douyu\.com\/(?:beta\/)?(\d+)/i);
  if (douyuLive) return { roomId: douyuLive[1], platform: 'douyu' };

  const douyinLive = text.match(/live\.douyin\.com\/(\d+)/i);
  if (douyinLive) return { roomId: douyinLive[1], platform: 'douyin' };

  const douyinWebcast = text.match(/webcast\.amemv\.com\/douyin\/webcast\/reflow\/(\d+)/i);
  if (douyinWebcast) return { roomId: douyinWebcast[1], platform: 'douyin' };

  if (isShortLiveUrl(text)) {
    return { shortUrl: extractFirstUrl(text), needsResolve: true };
  }

  return { error: '无法识别，请发送直播间链接或纯数字房间号' };
}

function detectLiveUrlCandidate(text = '') {
  const url = extractFirstUrl(text);
  if (!url) return null;
  const parsed = parseLiveRoomInput(url);
  if (parsed.platform && parsed.roomId) {
    return { platform: parsed.platform, roomId: parsed.roomId, url };
  }
  if (parsed.needsResolve && parsed.shortUrl) {
    return { shortUrl: parsed.shortUrl, needsResolve: true, url };
  }
  return null;
}

/**
 * 异步解析直播间输入：支持标准直播间链接、纯数字房间号，以及 b23.tv / v.douyin.com 短链自动跟随跳转。
 */
async function resolveLiveRoomInput(input, httpClient = null) {
  const syncParsed = parseLiveRoomInput(input);
  if (syncParsed.roomId || (syncParsed.error && !syncParsed.needsResolve)) {
    return syncParsed;
  }

  const targetUrl = syncParsed.shortUrl || extractFirstUrl(input);
  if (!targetUrl) {
    return { error: '无法识别，请发送直播间链接或纯数字房间号' };
  }

  try {
    let finalUrl = '';
    let bodyText = '';
    if (httpClient?.get) {
      const res = await httpClient.get(targetUrl, { responseType: 'text', timeout: 10000 });
      finalUrl = res.url || '';
      bodyText = typeof res.data === 'string' ? res.data : '';
    } else {
      const res = await fetch(targetUrl, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
      finalUrl = res.url || '';
      bodyText = await res.text().catch(() => '');
    }

    if (finalUrl) {
      const fromFinal = parseLiveRoomInput(finalUrl);
      if (fromFinal.platform && fromFinal.roomId) {
        return { ...fromFinal, resolvedUrl: finalUrl };
      }
    }

    // 兜底：从跳转页 HTML 中提取常见直播间 ID
    if (bodyText) {
      const webRid = bodyText.match(/"web_rid"\s*:\s*"(\d+)"/i);
      if (webRid) return { platform: 'douyin', roomId: webRid[1], resolvedUrl: finalUrl || targetUrl };

      const biliRoom = bodyText.match(/live\.bilibili\.com\/(\d+)/i);
      if (biliRoom) return { platform: 'bilibili', roomId: biliRoom[1], resolvedUrl: finalUrl || targetUrl };

      const douyuRoom = bodyText.match(/"room_id"\s*:\s*(\d+)/i);
      if (douyuRoom && /douyu/i.test(finalUrl || targetUrl)) {
        return { platform: 'douyu', roomId: douyuRoom[1], resolvedUrl: finalUrl || targetUrl };
      }
    }

    return { error: '短链跳转后未找到有效直播间号，请发送标准直播间链接（如 live.bilibili.com/房间号）' };
  } catch (err) {
    return { error: `解析短链接失败：${err.message}` };
  }
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
  if (isSessionExpired(sessionData.waitFallbackPhoto)) sessionData.waitFallbackPhoto = null;
}

function resetAllSessions(sessionData) {
  sessionData.addRoom = { step: null, roomId: null, platform: null };
  sessionData.editRoom = null;
  sessionData.editRtmp = null;
  sessionData.addRtmp = null;
  sessionData.setCookie = null;
  sessionData.editRoomCookie = null;
  sessionData.waitFallbackPhoto = null;
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
  extractFirstUrl,
  isShortLiveUrl,
  detectLiveUrlCandidate,
  parseLiveRoomInput,
  resolveLiveRoomInput,
  parseQuickAddInput,
  parsePlatformAlias,
  isValidRelayTargetUrl,
  isSessionExpired,
  cleanExpiredSessions,
  resetAllSessions,
  ensureAddRoomState,
  resetAddRoomState,
};
