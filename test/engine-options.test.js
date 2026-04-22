const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');

const bilibiliEnginePath = path.resolve(__dirname, '../src/platforms/bilibili/index.js');
const douyuEnginePath = path.resolve(__dirname, '../src/platforms/douyu/index.js');

function loadBilibiliEngine(axiosStub) {
  const originalLoad = Module._load;
  delete require.cache[bilibiliEnginePath];

  Module._load = function patched(request, parent, isMain) {
    if (request === 'axios') return axiosStub;
    return originalLoad.apply(this, arguments);
  };

  try {
    return require(bilibiliEnginePath);
  } finally {
    Module._load = originalLoad;
  }
}

function loadDouyuEngine({ axiosStub, vmStub, cryptoStub, cryptoJsStub }) {
  const originalLoad = Module._load;
  delete require.cache[douyuEnginePath];

  Module._load = function patched(request, parent, isMain) {
    if (request === 'axios') return axiosStub;
    if (request === 'node:vm') return vmStub;
    if (request === 'node:crypto') return cryptoStub;
    if (request === 'crypto-js') return cryptoJsStub;
    return originalLoad.apply(this, arguments);
  };

  try {
    return require(douyuEnginePath);
  } finally {
    Module._load = originalLoad;
  }
}

test('bilibili engine consumes caller-provided headers in both API requests', async () => {
  const calls = [];
  const axiosStub = {
    async get(url, options) {
      calls.push({ url, options });
      if (url.includes('room_init')) {
        return {
          data: {
            code: 0,
            data: { room_id: 778899 },
          },
        };
      }

      return {
        data: {
          data: {
            playurl_info: {
              playurl: {
                stream: [{
                  format: [{
                    format_name: 'flv',
                    codec: [{
                      base_url: '/live/test.flv',
                      url_info: [{ host: 'https://cn-gotcha.example', extra: '?token=abc' }],
                    }],
                  }],
                }],
              },
            },
          },
        },
      };
    },
  };

  const engine = loadBilibiliEngine(axiosStub);
  const streamUrl = await engine.getStreamUrl('12345', {
    headers: {
      'User-Agent': 'CallerUA/2.0',
      Referer: 'https://live.bilibili.com/custom-room',
      Cookie: 'SESSDATA=test-cookie',
    },
    metadata: { taskId: 99 },
  });

  assert.equal(streamUrl, 'https://cn-gotcha.example/live/test.flv?token=abc');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].options.headers, {
    'User-Agent': 'CallerUA/2.0',
    Referer: 'https://live.bilibili.com/custom-room',
    Cookie: 'SESSDATA=test-cookie',
  });
  assert.deepEqual(calls[1].options.headers, {
    'User-Agent': 'CallerUA/2.0',
    Referer: 'https://live.bilibili.com/custom-room',
    Cookie: 'SESSDATA=test-cookie',
  });
});

test('douyu engine consumes caller-provided headers for signature and play API requests', async () => {
  const getCalls = [];
  const postCalls = [];
  const axiosStub = {
    async get(url, options) {
      getCalls.push({ url, options });
      if (url.includes('homeH5Enc')) {
        return { data: { data: { room456: 'function ub98484234(){}' } } };
      }
      if (url.includes('456')) {
        return { data: { room: { owner_name: 'test', room_name: 'test', show_status: 1, videoLoop: 0 } } };
      }
      throw new Error(`unexpected url: ${url}`);
    },
    async post(url, body, options) {
      postCalls.push({ url, body, options });
      return {
        data: {
          error: 0,
          data: {
            rtmp_url: 'rtmp://douyu.example/live',
            rtmp_live: 'stream-key',
          },
        },
      };
    },
  };

  const vmStub = {
    createContext(sandbox) {
      return sandbox;
    },
    runInContext(code) {
      if (code.startsWith('ub98484234(')) {
        return 'v=123&did=fixeddid';
      }
      return undefined;
    },
  };

  const cryptoStub = {
    randomBytes() {
      return { toString: () => 'fixeddid' };
    },
  };

  const cryptoJsStub = {};

  const engine = loadDouyuEngine({ axiosStub, vmStub, cryptoStub, cryptoJsStub });
  const streamUrl = await engine.getStreamUrl('456', {
    headers: {
      'User-Agent': 'CallerDouyuUA/3.0',
      Referer: 'https://www.douyu.com/custom-room',
      Cookie: 'dy_did=custom',
    },
    metadata: { taskId: 100 },
  });

  assert.equal(streamUrl, 'rtmp://douyu.example/live/stream-key');
  assert.deepEqual(getCalls[0].options.headers, {
    'User-Agent': 'CallerDouyuUA/3.0',
    Referer: 'https://www.douyu.com/custom-room',
    Cookie: 'dy_did=custom',
  });
  assert.deepEqual(postCalls[0].options.headers, {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': 'CallerDouyuUA/3.0',
    Referer: 'https://www.douyu.com/custom-room',
    Cookie: 'dy_did=custom',
  });
});
