const config = require('../config');

/**
 * 统一 HTTP 客户端（基于 Node 22 原生 fetch + AbortSignal.timeout）
 * 消除项目内 axios 与原生 fetch 混用，统一超时、User-Agent 与错误处理。
 */
async function request(url, {
  method = 'GET',
  headers = {},
  body = undefined,
  timeout = config.http.timeoutMs,
  responseType = 'auto',
} = {}) {
  const mergedHeaders = {
    'User-Agent': config.http.userAgent,
    ...headers,
  };

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: mergedHeaders,
      body,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    const error = new Error(err?.name === 'TimeoutError' ? `请求超时 (${timeout}ms)` : (err?.message || '网络请求失败'));
    error.cause = err;
    error.response = null;
    throw error;
  }

  let data;
  if (responseType === 'arraybuffer') {
    data = Buffer.from(await res.arrayBuffer());
  } else {
    const rawText = await res.text();
    data = rawText;
    if (responseType === 'json' || (responseType === 'auto' && /^[\[{]/.test(rawText.trim()))) {
      try {
        data = JSON.parse(rawText);
      } catch {
        data = rawText;
      }
    }
  }

  if (!res.ok) {
    const error = new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    error.status = res.status;
    error.response = { status: res.status, data };
    throw error;
  }

  return {
    status: res.status,
    url: res.url,
    headers: res.headers,
    data,
  };
}

function get(url, options = {}) {
  return request(url, { ...options, method: 'GET' });
}

function post(url, body, options = {}) {
  return request(url, { ...options, method: 'POST', body });
}

module.exports = {
  request,
  get,
  post,
};
