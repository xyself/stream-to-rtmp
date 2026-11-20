'use strict';

const zlib = require('node:zlib');

const BJT_OFFSET_MS = 8 * 3600 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const SESSION_GAP_MS = 4 * 60 * 1000; // 超过 4 分钟无采样或收到 0 码率视为分场边界

const MINUTE_WINDOWS = {
  '30m': {
    mode: '30m',
    durationMin: 30,
    bucketMin: 1,
    bucketCount: 30,
    tickStepMin: 5,
    tickCount: 6,
    labelZh: '近 30 分钟',
    shortTag: '30M',
    stepTag: '1M STEP',
  },
  '1h': {
    mode: '1h',
    durationMin: 60,
    bucketMin: 1,
    bucketCount: 60,
    tickStepMin: 10,
    tickCount: 6,
    labelZh: '近 1 小时',
    shortTag: '1H',
    stepTag: '1M STEP',
  },
  '3h': {
    mode: '3h',
    durationMin: 180,
    bucketMin: 2,
    bucketCount: 90,
    tickStepMin: 30,
    tickCount: 6,
    labelZh: '近 3 小时',
    shortTag: '3H',
    stepTag: '2M STEP',
  },
  '6h': {
    mode: '6h',
    durationMin: 360,
    bucketMin: 3,
    bucketCount: 120,
    tickStepMin: 60,
    tickCount: 6,
    labelZh: '近 6 小时',
    shortTag: '6H',
    stepTag: '3M STEP',
  },
  '12h': {
    mode: '12h',
    durationMin: 720,
    bucketMin: 5,
    bucketCount: 144,
    tickStepMin: 120,
    tickCount: 6,
    labelZh: '近 12 小时',
    shortTag: '12H',
    stepTag: '5M STEP',
  },
};

const MINUTE_WINDOW_ORDER = ['30m', '1h', '3h', '6h', '12h'];

/**
 * 将 UTC 毫秒时间戳格式化为北京时间 HH:mm 或 MM-DD HH:mm
 */
function formatBeijingTime(tsMs, includeDate = false) {
  const d = new Date(tsMs + BJT_OFFSET_MS);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return includeDate ? `${mm}-${dd} ${hh}:${mi}` : `${hh}:${mi}`;
}

/**
 * 计算滚动分钟级时间窗口（30m / 1h / 3h / 6h / 12h，北京时间 UTC+8）
 */
function getMinuteWindow(mode = '1h', nowMs = Date.now()) {
  const spec = MINUTE_WINDOWS[mode] || MINUTE_WINDOWS['1h'];
  // 将结束时间向上对齐到整分钟，使横轴刻度整洁
  const endMs = Math.ceil(nowMs / MINUTE_MS) * MINUTE_MS;
  const durationMs = spec.durationMin * MINUTE_MS;
  const startMs = endMs - durationMs;

  const tickLabels = [];
  for (let i = 0; i <= spec.tickCount; i += 1) {
    const t = startMs + i * spec.tickStepMin * MINUTE_MS;
    tickLabels.push(formatBeijingTime(t, false));
  }

  const startLabel = formatBeijingTime(startMs, spec.durationMin >= 360);
  const endLabel = formatBeijingTime(endMs, spec.durationMin >= 360);
  const label = `${spec.labelZh}（北京时间 ${formatBeijingTime(startMs, false)} → ${formatBeijingTime(endMs, false)}）`;

  return {
    mode: spec.mode,
    kind: 'minute',
    isMinuteScale: true,
    durationMin: spec.durationMin,
    bucketMin: spec.bucketMin,
    bucketCount: spec.bucketCount,
    shortTag: spec.shortTag,
    stepTag: spec.stepTag,
    labelZh: spec.labelZh,
    startMs,
    endMs,
    startLabel,
    endLabel,
    label,
    tickLabels,
  };
}

/**
 * 计算 24 小时时间窗口（北京时间 UTC+8，供 Web 面板与历史兼容）
 * - mode = 'noon'（默认）：中午 12:00 → 次日中午 12:00（跨零点不断线）
 * - mode = 'midnight'：今日 00:00 → 24:00（自然日）
 */
function get24HourWindow(mode = 'noon', nowMs = Date.now()) {
  const normalizedMode = mode === 'midnight' ? 'midnight' : 'noon';
  const bjtNow = new Date(nowMs + BJT_OFFSET_MS);
  const year = bjtNow.getUTCFullYear();
  const month = bjtNow.getUTCMonth();
  const date = bjtNow.getUTCDate();
  const hour = bjtNow.getUTCHours();

  let startBjtMs;
  if (normalizedMode === 'noon') {
    const todayNoonBjt = Date.UTC(year, month, date, 12, 0, 0, 0);
    startBjtMs = hour >= 12 ? todayNoonBjt : todayNoonBjt - DAY_MS;
  } else {
    startBjtMs = Date.UTC(year, month, date, 0, 0, 0, 0);
  }

  const startMs = startBjtMs - BJT_OFFSET_MS;
  const endMs = startMs + DAY_MS;

  const tickLabels = normalizedMode === 'noon'
    ? ['12:00', '15:00', '18:00', '21:00', '00:00', '03:00', '06:00', '09:00', '12:00']
    : ['00:00', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00', '24:00'];

  const startLabel = formatBeijingTime(startMs, true);
  const endLabel = formatBeijingTime(endMs, true);
  const label = normalizedMode === 'noon'
    ? `北京时间 ${startLabel} → ${endLabel} (中午12点周期)`
    : `北京时间 ${startLabel} → ${endLabel} (0-24点自然日)`;

  return {
    mode: normalizedMode,
    kind: 'day',
    isMinuteScale: false,
    durationMin: 1440,
    bucketMin: 6,
    bucketCount: 240,
    shortTag: '24H',
    stepTag: '6M STEP',
    labelZh: normalizedMode === 'noon' ? '24h (12:00→12:00)' : '今日 0-24 时',
    startMs,
    endMs,
    startLabel,
    endLabel,
    label,
    tickLabels,
  };
}

/**
 * 统一解析窗口：支持分钟级（30m / 1h / 3h / 6h / 12h）与 24h 兼容模式（noon / midnight）
 */
function getCurveWindow(mode = '1h', nowMs = Date.now()) {
  if (mode === 'noon' || mode === 'midnight') {
    return get24HourWindow(mode, nowMs);
  }
  return getMinuteWindow(mode, nowMs);
}

/**
 * 从采样点中自动切分多场次直播（例如窗口内播了多场，自动切分为第 1 场、第 2 场...）
 */
function extractBroadcastSessions(samples = [], startMs = 0, endMs = Infinity) {
  const sorted = (Array.isArray(samples) ? samples : [])
    .filter((s) => s && s.ts >= startMs && s.ts <= endMs)
    .sort((a, b) => a.ts - b.ts);

  const rawSessions = [];
  let current = null;

  for (const pt of sorted) {
    const kbps = Number(pt.kbps) || 0;
    if (kbps <= 0) {
      if (current) {
        current.endMs = Math.max(current.endMs, pt.ts);
        rawSessions.push(current);
        current = null;
      }
      continue;
    }

    if (!current) {
      current = {
        startMs: pt.ts,
        endMs: pt.ts,
        points: [{ ts: pt.ts, kbps }],
      };
    } else if (pt.ts - current.endMs > SESSION_GAP_MS) {
      rawSessions.push(current);
      current = {
        startMs: pt.ts,
        endMs: pt.ts,
        points: [{ ts: pt.ts, kbps }],
      };
    } else {
      current.endMs = pt.ts;
      current.points.push({ ts: pt.ts, kbps });
    }
  }

  if (current) {
    rawSessions.push(current);
  }

  return rawSessions.map((sess, idx) => {
    const pts = sess.points;
    const sumKbps = pts.reduce((acc, p) => acc + p.kbps, 0);
    const avgKbps = pts.length > 0 ? Math.round(sumKbps / pts.length) : 0;
    const peakKbps = pts.reduce((max, p) => Math.max(max, p.kbps), 0);
    const rawDurationSec = Math.max(60, Math.round((sess.endMs - sess.startMs) / 1000));
    const durationMin = Math.max(1, Math.round(rawDurationSec / 60));
    const estimatedBytes = Math.round((avgKbps * 1000 / 8) * rawDurationSec);

    return {
      index: idx + 1,
      startMs: sess.startMs,
      endMs: Math.max(sess.endMs, sess.startMs + 60000),
      startTimeStr: formatBeijingTime(sess.startMs, false),
      endTimeStr: formatBeijingTime(Math.max(sess.endMs, sess.startMs + 60000), false),
      durationMin,
      avgKbps,
      peakKbps,
      estimatedBytes,
      points: pts,
    };
  });
}

/**
 * 构建时间窗口均匀分桶码率数组（供波浪曲线图与 Unicode 缩略条使用）
 */
function buildWaveSeries(samples = [], startMs, endMs, bucketCount = 144) {
  const sessions = extractBroadcastSessions(samples, startMs, endMs);
  const buckets = new Array(bucketCount).fill(0);
  const span = Math.max(1, endMs - startMs);
  const bucketMs = span / bucketCount;

  for (const sess of sessions) {
    const pts = sess.points;
    if (pts.length === 1) {
      const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((pts[0].ts - startMs) / bucketMs)));
      buckets[idx] = Math.max(buckets[idx], pts[0].kbps);
      continue;
    }
    for (let i = 0; i < pts.length; i += 1) {
      const p1 = pts[i];
      const idx1 = Math.min(bucketCount - 1, Math.max(0, Math.floor((p1.ts - startMs) / bucketMs)));
      buckets[idx1] = Math.max(buckets[idx1], p1.kbps);

      if (i + 1 < pts.length) {
        const p2 = pts[i + 1];
        const idx2 = Math.min(bucketCount - 1, Math.max(0, Math.floor((p2.ts - startMs) / bucketMs)));
        for (let b = idx1 + 1; b < idx2; b += 1) {
          const ratio = (b - idx1) / Math.max(1, idx2 - idx1);
          const interp = Math.round(p1.kbps + (p2.kbps - p1.kbps) * ratio);
          buckets[b] = Math.max(buckets[b], interp);
        }
      }
    }
  }

  return { buckets, sessions };
}

/**
 * 生成 24 格 Unicode 波浪缩略线
 */
function renderUnicodeWave(samples = [], startMs, endMs, slots = 24) {
  const { buckets } = buildWaveSeries(samples, startMs, endMs, slots);
  const maxVal = Math.max(1000, ...buckets);
  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  return buckets
    .map((val) => {
      if (val <= 0) return '▁';
      const idx = Math.min(blocks.length - 1, Math.max(1, Math.round((val / maxVal) * (blocks.length - 1))));
      return blocks[idx];
    })
    .join('');
}

// ─── 纯 Node.js 零依赖高清抗锯齿矢量字体 & 现代深色仪表盘 PNG 渲染器 ─────────────

// 归一化坐标系 [0..1, 0..1] 上的几何圆角无衬线笔画（每条 polyline 为 [[x,y], ...]）
const VECTOR_GLYPHS = {
  '0': [[[0.5, 0.04], [0.78, 0.08], [0.88, 0.25], [0.88, 0.75], [0.78, 0.92], [0.5, 0.96], [0.22, 0.92], [0.12, 0.75], [0.12, 0.25], [0.22, 0.08], [0.5, 0.04]]],
  '1': [[[0.26, 0.24], [0.52, 0.05], [0.52, 0.95]], [[0.24, 0.95], [0.8, 0.95]]],
  '2': [[[0.15, 0.26], [0.25, 0.1], [0.5, 0.04], [0.76, 0.1], [0.86, 0.26], [0.82, 0.44], [0.15, 0.95], [0.88, 0.95]]],
  '3': [[[0.18, 0.2], [0.3, 0.06], [0.55, 0.04], [0.8, 0.12], [0.86, 0.27], [0.78, 0.42], [0.46, 0.48], [0.78, 0.54], [0.88, 0.72], [0.8, 0.9], [0.54, 0.96], [0.26, 0.92], [0.15, 0.8]]],
  '4': [[[0.7, 0.95], [0.7, 0.05], [0.12, 0.67], [0.9, 0.67]]],
  '5': [[[0.84, 0.05], [0.22, 0.05], [0.17, 0.45], [0.45, 0.37], [0.74, 0.43], [0.87, 0.62], [0.82, 0.86], [0.56, 0.96], [0.26, 0.92], [0.15, 0.8]]],
  '6': [[[0.82, 0.18], [0.68, 0.06], [0.44, 0.05], [0.22, 0.18], [0.13, 0.48], [0.15, 0.8], [0.34, 0.95], [0.64, 0.95], [0.85, 0.82], [0.87, 0.6], [0.72, 0.43], [0.44, 0.41], [0.16, 0.54]]],
  '7': [[[0.14, 0.06], [0.88, 0.06], [0.38, 0.95]]],
  '8': [[[0.5, 0.48], [0.25, 0.42], [0.16, 0.26], [0.26, 0.1], [0.5, 0.04], [0.74, 0.1], [0.84, 0.26], [0.75, 0.42], [0.5, 0.48], [0.22, 0.55], [0.12, 0.74], [0.24, 0.92], [0.5, 0.96], [0.76, 0.92], [0.88, 0.74], [0.78, 0.55], [0.5, 0.48]]],
  '9': [[[0.18, 0.82], [0.34, 0.95], [0.6, 0.95], [0.8, 0.8], [0.87, 0.48], [0.84, 0.18], [0.64, 0.05], [0.36, 0.05], [0.16, 0.18], [0.14, 0.4], [0.3, 0.56], [0.6, 0.57], [0.85, 0.44]]],
  'A': [[[0.1, 0.95], [0.5, 0.05], [0.9, 0.95]], [[0.24, 0.66], [0.76, 0.66]]],
  'B': [[[0.18, 0.95], [0.18, 0.05], [0.62, 0.05], [0.82, 0.15], [0.82, 0.36], [0.64, 0.48], [0.18, 0.48]], [[0.64, 0.48], [0.86, 0.6], [0.86, 0.82], [0.66, 0.95], [0.18, 0.95]]],
  'C': [[[0.86, 0.22], [0.72, 0.08], [0.48, 0.04], [0.24, 0.14], [0.12, 0.36], [0.12, 0.64], [0.24, 0.86], [0.48, 0.96], [0.72, 0.92], [0.86, 0.78]]],
  'D': [[[0.18, 0.05], [0.18, 0.95], [0.56, 0.95], [0.8, 0.83], [0.88, 0.6], [0.88, 0.4], [0.8, 0.17], [0.56, 0.05], [0.18, 0.05]]],
  'E': [[[0.84, 0.05], [0.18, 0.05], [0.18, 0.95], [0.86, 0.95]], [[0.18, 0.49], [0.72, 0.49]]],
  'F': [[[0.84, 0.05], [0.18, 0.05], [0.18, 0.95]], [[0.18, 0.5], [0.72, 0.5]]],
  'G': [[[0.85, 0.2], [0.7, 0.07], [0.48, 0.04], [0.22, 0.16], [0.12, 0.4], [0.12, 0.64], [0.24, 0.86], [0.5, 0.96], [0.78, 0.88], [0.86, 0.68], [0.86, 0.52], [0.54, 0.52]]],
  'H': [[[0.18, 0.05], [0.18, 0.95]], [[0.82, 0.05], [0.82, 0.95]], [[0.18, 0.49], [0.82, 0.49]]],
  'I': [[[0.26, 0.05], [0.74, 0.05]], [[0.5, 0.05], [0.5, 0.95]], [[0.26, 0.95], [0.74, 0.95]]],
  'J': [[[0.78, 0.05], [0.78, 0.72], [0.68, 0.9], [0.46, 0.96], [0.24, 0.9], [0.14, 0.76]]],
  'K': [[[0.18, 0.05], [0.18, 0.95]], [[0.84, 0.05], [0.22, 0.54]], [[0.38, 0.44], [0.86, 0.95]]],
  'L': [[[0.2, 0.05], [0.2, 0.95], [0.86, 0.95]]],
  'M': [[[0.12, 0.95], [0.12, 0.05], [0.5, 0.62], [0.88, 0.05], [0.88, 0.95]]],
  'N': [[[0.18, 0.95], [0.18, 0.05], [0.82, 0.95], [0.82, 0.05]]],
  'O': [[[0.5, 0.04], [0.78, 0.12], [0.88, 0.34], [0.88, 0.66], [0.78, 0.88], [0.5, 0.96], [0.22, 0.88], [0.12, 0.66], [0.12, 0.34], [0.22, 0.12], [0.5, 0.04]]],
  'P': [[[0.18, 0.95], [0.18, 0.05], [0.64, 0.05], [0.84, 0.16], [0.84, 0.42], [0.64, 0.53], [0.18, 0.53]]],
  'Q': [[[0.5, 0.04], [0.78, 0.12], [0.88, 0.34], [0.88, 0.66], [0.78, 0.88], [0.5, 0.96], [0.22, 0.88], [0.12, 0.66], [0.12, 0.34], [0.22, 0.12], [0.5, 0.04]], [[0.62, 0.72], [0.92, 0.98]]],
  'R': [[[0.18, 0.95], [0.18, 0.05], [0.64, 0.05], [0.84, 0.16], [0.84, 0.41], [0.64, 0.52], [0.18, 0.52]], [[0.54, 0.52], [0.86, 0.95]]],
  'S': [[[0.84, 0.2], [0.72, 0.08], [0.48, 0.04], [0.24, 0.1], [0.16, 0.26], [0.26, 0.42], [0.72, 0.56], [0.86, 0.72], [0.78, 0.9], [0.5, 0.96], [0.24, 0.9], [0.14, 0.78]]],
  'T': [[[0.1, 0.05], [0.9, 0.05]], [[0.5, 0.05], [0.5, 0.95]]],
  'U': [[[0.18, 0.05], [0.18, 0.7], [0.28, 0.89], [0.5, 0.96], [0.72, 0.89], [0.82, 0.7], [0.82, 0.05]]],
  'V': [[[0.12, 0.05], [0.5, 0.95], [0.88, 0.05]]],
  'W': [[[0.08, 0.05], [0.28, 0.95], [0.5, 0.38], [0.72, 0.95], [0.92, 0.05]]],
  'X': [[[0.16, 0.05], [0.84, 0.95]], [[0.84, 0.05], [0.16, 0.95]]],
  'Y': [[[0.14, 0.05], [0.5, 0.52], [0.86, 0.05]], [[0.5, 0.52], [0.5, 0.95]]],
  'Z': [[[0.16, 0.05], [0.84, 0.05], [0.16, 0.95], [0.84, 0.95]]],
  'k': [[[0.2, 0.05], [0.2, 0.95]], [[0.8, 0.36], [0.24, 0.68]], [[0.42, 0.58], [0.84, 0.95]]],
  'b': [[[0.2, 0.05], [0.2, 0.95]], [[0.2, 0.44], [0.46, 0.34], [0.74, 0.42], [0.84, 0.64], [0.74, 0.88], [0.46, 0.95], [0.2, 0.84]]],
  'p': [[[0.2, 0.36], [0.2, 1.15]], [[0.2, 0.44], [0.46, 0.34], [0.74, 0.42], [0.84, 0.64], [0.74, 0.88], [0.46, 0.95], [0.2, 0.84]]],
  's': [[[0.8, 0.44], [0.64, 0.34], [0.36, 0.34], [0.2, 0.44], [0.26, 0.58], [0.72, 0.68], [0.82, 0.82], [0.68, 0.95], [0.36, 0.95], [0.18, 0.86]]],
  'm': [[[0.12, 0.95], [0.12, 0.36]], [[0.12, 0.48], [0.32, 0.35], [0.5, 0.48], [0.5, 0.95]], [[0.5, 0.48], [0.7, 0.35], [0.88, 0.48], [0.88, 0.95]]],
  'h': [[[0.2, 0.05], [0.2, 0.95]], [[0.2, 0.48], [0.46, 0.35], [0.76, 0.45], [0.82, 0.62], [0.82, 0.95]]],
  ':': [[[0.5, 0.32], [0.5, 0.34]], [[0.5, 0.78], [0.5, 0.8]]],
  '.': [[[0.5, 0.88], [0.5, 0.9]]],
  ',': [[[0.52, 0.84], [0.42, 1.05]]],
  '-': [[[0.2, 0.52], [0.8, 0.52]]],
  '+': [[[0.18, 0.52], [0.82, 0.52]], [[0.5, 0.2], [0.5, 0.84]]],
  '/': [[[0.76, 0.06], [0.24, 0.96]]],
  '#': [[[0.34, 0.08], [0.24, 0.92]], [[0.72, 0.08], [0.62, 0.92]], [[0.1, 0.36], [0.9, 0.36]], [[0.08, 0.66], [0.88, 0.66]]],
  '~': [[[0.1, 0.56], [0.3, 0.38], [0.7, 0.66], [0.9, 0.48]]],
  '|': [[[0.5, 0.06], [0.5, 0.94]]],
  '·': [[[0.5, 0.5], [0.5, 0.52]]],
  ' ': [],
};

let _crcTable = null;
function getCrcTable() {
  if (_crcTable) return _crcTable;
  _crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    _crcTable[n] = c >>> 0;
  }
  return _crcTable;
}

function crc32(buf) {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodeRgbaToPng(width, height, rgba) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // filter type 0 (None)
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw, { level: 6 });
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', idat),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function formatKbpsCompact(val) {
  const n = Math.round(Number(val) || 0);
  if (n >= 10000) return `${(n / 1000).toFixed(1)}M`;
  if (n >= 1000) return `${n.toLocaleString('en-US')}k`;
  return `${n}k`;
}

function formatAxisKbps(val) {
  const n = Math.round(Number(val) || 0);
  if (n === 0) return '0';
  if (n >= 1000) {
    const k = n / 1000;
    return Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`;
  }
  return `${n}`;
}

function formatBytesAscii(bytes = 0) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function platformAsciiTag(platform = '') {
  const map = { bilibili: 'BILI', douyu: 'DOUYU', douyin: 'DOUYIN' };
  return map[String(platform).toLowerCase()] || String(platform || 'ROOM').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

/**
 * Fritsch-Carlson 单调三次样条插值（平滑圆润且绝不出现过冲震荡）
 */
function interpolateMonotoneCubic(xs, ys, targetX) {
  const n = xs.length;
  if (n === 0) return 0;
  if (n === 1) return ys[0];
  if (targetX <= xs[0]) return ys[0];
  if (targetX >= xs[n - 1]) return ys[n - 1];

  const d = new Float64Array(n - 1);
  const m = new Float64Array(n);
  for (let i = 0; i < n - 1; i += 1) {
    const h = xs[i + 1] - xs[i];
    d[i] = h > 0 ? (ys[i + 1] - ys[i]) / h : 0;
  }
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i += 1) {
    if (d[i - 1] * d[i] <= 0) {
      m[i] = 0;
    } else {
      const h0 = xs[i] - xs[i - 1];
      const h1 = xs[i + 1] - xs[i];
      const w1 = 2 * h1 + h0;
      const w2 = h1 + 2 * h0;
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }

  // 二分查找区间
  let lo = 0;
  let hi = n - 2;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= targetX && targetX <= xs[mid + 1]) {
      lo = mid;
      break;
    }
    if (targetX < xs[mid]) hi = mid - 1;
    else lo = mid + 1;
  }
  const idx = Math.max(0, Math.min(n - 2, lo));
  const h = xs[idx + 1] - xs[idx];
  if (h <= 0) return ys[idx];
  const t = (targetX - xs[idx]) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return Math.max(0, h00 * ys[idx] + h10 * h * m[idx] + h01 * ys[idx + 1] + h11 * h * m[idx + 1]);
}

/**
 * 渲染 2× 高清现代深色仪表盘 PNG 推流码率曲线
 * - 支持分钟级滚动窗口（30m / 1h / 3h / 6h / 12h）及 24h 兼容模式（noon / midnight）
 * - 零外部依赖：SDF 抗锯齿圆角卡片、抗锯齿几何矢量字体、单调三次样条平滑曲线、均值参考线、峰值与实时光点
 */
function renderWaveChartPng({
  samples = [],
  mode = '1h',
  nowMs = Date.now(),
  width = 1280,
  height = 640,
  title = '',
  currentKbps = null,
} = {}) {
  const windowInfo = getCurveWindow(mode, nowMs);
  const bucketCount = windowInfo.bucketCount || 60;
  const spanMs = Math.max(1, windowInfo.endMs - windowInfo.startMs);
  const { buckets, sessions } = buildWaveSeries(samples, windowInfo.startMs, windowInfo.endMs, bucketCount);

  const rgba = Buffer.alloc(width * height * 4);

  // 背景底色 (#0B0F19)
  for (let i = 0; i < width * height * 4; i += 4) {
    rgba[i] = 11;
    rgba[i + 1] = 15;
    rgba[i + 2] = 25;
    rgba[i + 3] = 255;
  }

  const blendPixel = (x, y, r, g, b, a = 255) => {
    const xi = x | 0;
    const yi = y | 0;
    if (xi < 0 || xi >= width || yi < 0 || yi >= height || a <= 0) return;
    const idx = (yi * width + xi) * 4;
    if (a >= 255) {
      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = 255;
    } else {
      const alpha = a / 255;
      const inv = 1 - alpha;
      rgba[idx] = (r * alpha + rgba[idx] * inv + 0.5) | 0;
      rgba[idx + 1] = (g * alpha + rgba[idx + 1] * inv + 0.5) | 0;
      rgba[idx + 2] = (b * alpha + rgba[idx + 2] * inv + 0.5) | 0;
      rgba[idx + 3] = 255;
    }
  };

  const drawRect = (x0, y0, w, h, r, g, b, a = 255) => {
    const xs = Math.max(0, Math.round(x0));
    const ys = Math.max(0, Math.round(y0));
    const xe = Math.min(width, Math.round(x0 + w));
    const ye = Math.min(height, Math.round(y0 + h));
    for (let y = ys; y < ye; y += 1) {
      for (let x = xs; x < xe; x += 1) {
        blendPixel(x, y, r, g, b, a);
      }
    }
  };

  // SDF 抗锯齿圆角矩形（填充 + 可选 1px 细边框）
  const drawRoundedRect = (x0, y0, w, h, radius, fillRgb, borderRgb = null) => {
    const xMin = Math.max(0, Math.floor(x0 - 1));
    const yMin = Math.max(0, Math.floor(y0 - 1));
    const xMax = Math.min(width - 1, Math.ceil(x0 + w + 1));
    const yMax = Math.min(height - 1, Math.ceil(y0 + h + 1));
    const cx = x0 + w * 0.5;
    const cy = y0 + h * 0.5;
    const bx = w * 0.5 - radius;
    const by = h * 0.5 - radius;

    for (let y = yMin; y <= yMax; y += 1) {
      const dy = Math.abs(y + 0.5 - cy) - by;
      for (let x = xMin; x <= xMax; x += 1) {
        const dx = Math.abs(x + 0.5 - cx) - bx;
        const ox = Math.max(dx, 0);
        const oy = Math.max(dy, 0);
        const dist = Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - radius;

        if (dist <= 0.75) {
          const fillCov = Math.max(0, Math.min(1, 0.5 - dist));
          if (fillRgb && fillCov > 0) {
            blendPixel(x, y, fillRgb[0], fillRgb[1], fillRgb[2], Math.round((fillRgb[3] ?? 255) * fillCov));
          }
          if (borderRgb && dist >= -1.75) {
            const bCov = Math.max(0, Math.min(1, 1 - Math.abs(dist + 0.5)));
            if (bCov > 0) {
              blendPixel(x, y, borderRgb[0], borderRgb[1], borderRgb[2], Math.round((borderRgb[3] ?? 255) * bCov));
            }
          }
        }
      }
    }
  };

  // 抗锯齿实心圆
  const drawCircle = (cx, cy, radius, r, g, b, a = 255) => {
    const xMin = Math.max(0, Math.floor(cx - radius - 1.5));
    const xMax = Math.min(width - 1, Math.ceil(cx + radius + 1.5));
    const yMin = Math.max(0, Math.floor(cy - radius - 1.5));
    const yMax = Math.min(height - 1, Math.ceil(cy + radius + 1.5));
    for (let y = yMin; y <= yMax; y += 1) {
      for (let x = xMin; x <= xMax; x += 1) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - radius;
        if (d < 1) {
          const cov = Math.max(0, Math.min(1, 0.5 - d));
          if (cov > 0) blendPixel(x, y, r, g, b, Math.round(a * cov));
        }
      }
    }
  };

  // SDF 抗锯齿圆帽线段（用于清晰矢量字与光滑曲线）
  const drawCapsule = (x1, y1, x2, y2, radius, r, g, b, a = 255) => {
    const pad = radius + 1.5;
    const xMin = Math.max(0, Math.floor(Math.min(x1, x2) - pad));
    const xMax = Math.min(width - 1, Math.ceil(Math.max(x1, x2) + pad));
    const yMin = Math.max(0, Math.floor(Math.min(y1, y2) - pad));
    const yMax = Math.min(height - 1, Math.ceil(Math.max(y1, y2) + pad));
    const vx = x2 - x1;
    const vy = y2 - y1;
    const lenSq = vx * vx + vy * vy;

    for (let y = yMin; y <= yMax; y += 1) {
      const py = y + 0.5 - y1;
      for (let x = xMin; x <= xMax; x += 1) {
        const px = x + 0.5 - x1;
        let t = 0;
        if (lenSq > 1e-6) {
          t = Math.max(0, Math.min(1, (px * vx + py * vy) / lenSq));
        }
        const dx = px - t * vx;
        const dy = py - t * vy;
        const dist = Math.hypot(dx, dy) - radius;
        if (dist < 1) {
          const cov = Math.max(0, Math.min(1, 0.5 - dist));
          if (cov > 0) blendPixel(x, y, r, g, b, Math.round(a * cov));
        }
      }
    }
  };

  const measureVectorText = (text, size) => {
    const str = String(text || '');
    if (!str) return 0;
    const charW = size * 0.62;
    const gap = size * 0.14;
    let total = 0;
    for (let i = 0; i < str.length; i += 1) {
      const ch = str[i];
      const factor = (ch === ':' || ch === '.' || ch === ',' || ch === '·' || ch === '|') ? 0.5 : ch === ' ' ? 0.55 : 1;
      total += charW * factor + (i + 1 < str.length ? gap : 0);
    }
    return total;
  };

  const drawVectorText = (text, x, y, size, r, g, b, { alpha = 255, weight = 1.0, align = 'left' } = {}) => {
    const str = String(text || '');
    if (!str) return;
    const totalW = measureVectorText(str, size);
    let cursorX = align === 'right' ? x - totalW : align === 'center' ? x - totalW * 0.5 : x;
    const charW = size * 0.62;
    const gap = size * 0.14;
    const strokeRadius = Math.max(0.75, size * 0.068 * weight);

    for (let i = 0; i < str.length; i += 1) {
      const ch = str[i];
      const lookup = VECTOR_GLYPHS[ch] ? ch : VECTOR_GLYPHS[ch.toUpperCase()] ? ch.toUpperCase() : ' ';
      const glyph = VECTOR_GLYPHS[lookup] || [];
      const factor = (ch === ':' || ch === '.' || ch === ',' || ch === '·' || ch === '|') ? 0.5 : ch === ' ' ? 0.55 : 1;
      const w = charW * factor;

      for (const poly of glyph) {
        for (let k = 0; k < poly.length - 1; k += 1) {
          const [ax, ay] = poly[k];
          const [bx, by] = poly[k + 1];
          drawCapsule(
            cursorX + ax * w,
            y + ay * size,
            cursorX + bx * w,
            y + by * size,
            strokeRadius,
            r,
            g,
            b,
            alpha
          );
        }
      }
      cursorX += w + gap;
    }
  };

  // 1. 现代深色主卡片容器 (#111827 + 1px #1F2937 边框)
  const cardX = 28;
  const cardY = 24;
  const cardW = width - 56;
  const cardH = height - 48;
  drawRoundedRect(cardX, cardY, cardW, cardH, 20, [17, 24, 39, 255], [31, 41, 55, 255]);

  // 计算核心遥测指标
  const activeBuckets = buckets.filter((v) => v > 0);
  const peakKbps = activeBuckets.length > 0 ? Math.max(...activeBuckets) : 0;
  const avgKbps = activeBuckets.length > 0
    ? Math.round(activeBuckets.reduce((a, b) => a + b, 0) / activeBuckets.length)
    : 0;
  const lastActiveVal = (() => {
    if (currentKbps !== null && currentKbps !== undefined) return Math.round(Number(currentKbps) || 0);
    for (let i = buckets.length - 1; i >= 0; i -= 1) {
      if (buckets[i] > 0) return Math.round(buckets[i]);
    }
    return 0;
  })();
  const totalActiveMin = sessions.reduce((s, item) => s + item.durationMin, 0);
  const totalEstimatedBytes = sessions.reduce((s, item) => s + item.estimatedBytes, 0);

  // 2. 顶部 KPI 抬头区 (y = 48..126)
  const headerTitle = String(title || 'BITRATE TELEMETRY').toUpperCase();
  drawVectorText(headerTitle, cardX + 34, cardY + 26, 25, 248, 250, 252, { weight: 1.32 });

  const subMeta = `${windowInfo.shortTag} WINDOW  ·  ${windowInfo.stepTag}  ·  BJT ${formatBeijingTime(windowInfo.startMs, false)} - ${formatBeijingTime(windowInfo.endMs, false)}`;
  drawVectorText(subMeta, cardX + 34, cardY + 66, 13, 148, 163, 184, { weight: 0.95 });

  // 右侧三联 KPI（无胶囊、细竖线分隔、等宽右对齐）
  const kpiRight = cardX + cardW - 34;
  const kpiCols = [
    {
      label: 'PEAK',
      value: peakKbps > 0 ? formatKbpsCompact(peakKbps) : '--',
      color: peakKbps > 0 ? [56, 189, 248] : [100, 116, 139],
      x: kpiRight,
    },
    {
      label: 'AVG',
      value: avgKbps > 0 ? formatKbpsCompact(avgKbps) : '--',
      color: avgKbps > 0 ? [248, 250, 252] : [100, 116, 139],
      x: kpiRight - 156,
    },
    {
      label: 'NOW',
      value: lastActiveVal > 0 ? formatKbpsCompact(lastActiveVal) : 'IDLE',
      color: lastActiveVal > 0 ? [16, 185, 129] : [100, 116, 139],
      x: kpiRight - 312,
    },
  ];
  for (let i = 0; i < kpiCols.length; i += 1) {
    const col = kpiCols[i];
    drawVectorText(col.label, col.x, cardY + 24, 11, 148, 163, 184, { align: 'right', weight: 1.0 });
    drawVectorText(col.value, col.x, cardY + 46, 23, col.color[0], col.color[1], col.color[2], { align: 'right', weight: 1.28 });
    if (i > 0) {
      drawRect(col.x + 26, cardY + 26, 1, 50, 31, 41, 55, 255);
    }
  }

  // 顶栏底部分割线
  drawRect(cardX + 24, cardY + 102, cardW - 48, 1, 31, 41, 55, 255);

  // 3. 绘图区几何坐标
  const plotX = cardX + 94;
  const plotY = cardY + 132;
  const plotW = cardW - 134;
  const plotH = cardH - 224;
  const yBottom = plotY + plotH;

  // 计算干净的 Y 轴上限（按 500 或 1000 kbps 整步长取整）
  const rawPeak = Math.max(1000, peakKbps);
  const yStep = rawPeak > 4000 ? 1000 : 500;
  const maxKbps = Math.max(1000, Math.ceil((rawPeak * 1.18) / (yStep * 4)) * (yStep * 4));

  // 水平网格线 & Y 轴刻度 (0%, 25%, 50%, 75%, 100%)
  for (let i = 0; i <= 4; i += 1) {
    const ratio = i / 4;
    const y = Math.round(yBottom - ratio * plotH);
    const valKbps = Math.round(maxKbps * ratio);
    for (let x = plotX; x <= plotX + plotW; x += 1) {
      if (i === 0) {
        blendPixel(x, y, 51, 65, 85, 220);
      } else if ((x - plotX) % 8 < 4) {
        blendPixel(x, y, 30, 41, 59, 210);
      }
    }
    const yLabel = formatAxisKbps(valKbps);
    drawVectorText(yLabel, plotX - 16, y - 6, 13, 148, 163, 184, { align: 'right', weight: 0.95 });
  }
  drawVectorText('KBPS', plotX - 16, plotY - 22, 10, 100, 116, 139, { align: 'right', weight: 1.0 });

  // 垂直时间刻度线 & X 轴时间标签
  const tickCount = Math.max(1, windowInfo.tickLabels.length - 1);
  for (let i = 0; i <= tickCount; i += 1) {
    const x = Math.round(plotX + (i / tickCount) * plotW);
    for (let y = plotY; y <= yBottom; y += 1) {
      if ((y - plotY) % 8 < 3) {
        blendPixel(x, y, 30, 41, 59, 140);
      }
    }
    const tick = windowInfo.tickLabels[i] || '';
    const align = i === 0 ? 'left' : i === tickCount ? 'right' : 'center';
    drawVectorText(tick, x, yBottom + 16, 13, 148, 163, 184, { align, weight: 0.95 });
  }

  // 4. 分段提取连续非零区段并用 Fritsch-Carlson 单调三次样条绘制丝滑曲线
  const segments = [];
  let curSeg = null;
  for (let b = 0; b < bucketCount; b += 1) {
    if (buckets[b] > 0) {
      const px = bucketCount > 1 ? (b / (bucketCount - 1)) * (plotW - 1) : plotW * 0.5;
      if (!curSeg) {
        curSeg = { xs: [], ys: [] };
        segments.push(curSeg);
      }
      curSeg.xs.push(px);
      curSeg.ys.push(buckets[b]);
    } else {
      curSeg = null;
    }
  }

  // 如果有平均码率，先绘制虚线均值参考线（琥珀金 #F59E0B）
  if (avgKbps > 0) {
    const avgY = Math.round(yBottom - Math.min(1, avgKbps / maxKbps) * (plotH - 8));
    for (let x = plotX; x <= plotX + plotW; x += 1) {
      if ((x - plotX) % 10 < 5) {
        blendPixel(x, avgY, 245, 158, 11, 145);
      }
    }
    drawVectorText(`AVG ${formatKbpsCompact(avgKbps)}`, plotX + plotW, avgY - 16, 11, 245, 158, 11, {
      align: 'right',
      alpha: 210,
      weight: 1.0,
    });
  }

  // 逐段绘制柔和渐变填充 + 3px 抗锯齿平滑曲线
  let peakPoint = null;
  let lastPoint = null;

  for (const seg of segments) {
    if (seg.xs.length === 1) {
      const sx = plotX + seg.xs[0];
      const sy = yBottom - Math.min(1, seg.ys[0] / maxKbps) * (plotH - 8);
      // 单点竖柱微光
      for (let fy = Math.round(sy); fy < yBottom; fy += 1) {
        const depth = 1 - (fy - sy) / Math.max(1, yBottom - sy);
        blendPixel(Math.round(sx), fy, 16, 185, 129, Math.round(12 + depth * 65));
      }
      drawCircle(sx, sy, 4.5, 52, 211, 153, 255);
      if (!peakPoint || seg.ys[0] >= peakPoint.val) peakPoint = { x: sx, y: sy, val: seg.ys[0] };
      lastPoint = { x: sx, y: sy, val: seg.ys[0] };
      continue;
    }

    const startPx = Math.max(0, Math.floor(seg.xs[0]));
    const endPx = Math.min(plotW - 1, Math.ceil(seg.xs[seg.xs.length - 1]));
    const curvePts = [];

    for (let px = startPx; px <= endPx; px += 1) {
      const val = interpolateMonotoneCubic(seg.xs, seg.ys, px);
      const x = plotX + px;
      const y = yBottom - Math.min(1, val / maxKbps) * (plotH - 8);
      curvePts.push({ x, y, val });

      if (!peakPoint || val > peakPoint.val) {
        peakPoint = { x, y, val };
      }
      lastPoint = { x, y, val };

      // 柔和垂直渐变面积填充 (#10B981)
      const yStart = Math.max(plotY, Math.ceil(y));
      for (let fy = yStart; fy < yBottom; fy += 1) {
        const depth = 1 - (fy - y) / Math.max(1, yBottom - y);
        const alpha = Math.round(6 + depth * depth * 78);
        blendPixel(x, fy, 16, 185, 129, alpha);
      }
    }

    // 柔光外描边 + 锐利抗锯齿翡翠绿主曲线
    for (let i = 0; i < curvePts.length - 1; i += 1) {
      const a = curvePts[i];
      const b = curvePts[i + 1];
      drawCapsule(a.x, a.y, b.x, b.y, 4.2, 16, 185, 129, 42);
      drawCapsule(a.x, a.y, b.x, b.y, 1.8, 52, 211, 153, 255);
    }
  }

  // 峰值高亮标记点
  if (peakPoint && peakKbps > 0) {
    drawCircle(peakPoint.x, peakPoint.y, 7.5, 56, 189, 248, 55);
    drawCircle(peakPoint.x, peakPoint.y, 4.0, 56, 189, 248, 255);
    drawCircle(peakPoint.x, peakPoint.y, 1.8, 248, 250, 252, 255);
  }

  // 末端实时光点（避免和峰值点完全重叠时仍清晰）
  if (lastPoint && lastActiveVal > 0) {
    drawCircle(lastPoint.x, lastPoint.y, 8.5, 16, 185, 129, 60);
    drawCircle(lastPoint.x, lastPoint.y, 4.2, 52, 211, 153, 255);
    drawCircle(lastPoint.x, lastPoint.y, 2.0, 248, 250, 252, 255);
  }

  // 空数据状态居中提示
  if (activeBuckets.length === 0) {
    const emptyY = Math.round(plotY + plotH * 0.45);
    drawVectorText('NO BITRATE SAMPLES IN THIS WINDOW', plotX + plotW * 0.5, emptyY, 16, 148, 163, 184, {
      align: 'center',
      weight: 1.05,
    });
    drawVectorText('SAMPLES RECORD EVERY 30S WHILE STREAMING', plotX + plotW * 0.5, emptyY + 28, 12, 100, 116, 139, {
      align: 'center',
      weight: 0.9,
    });
  }

  // 5. 底部遥测汇总栏
  const footerDividerY = cardY + cardH - 48;
  drawRect(cardX + 24, footerDividerY, cardW - 48, 1, 31, 41, 55, 255);

  const activeText = `ACTIVE ${totalActiveMin}M / ${windowInfo.durationMin}M  ·  SESSIONS ${sessions.length}  ·  DATA ~${formatBytesAscii(totalEstimatedBytes)}`;
  drawVectorText(activeText, cardX + 34, footerDividerY + 17, 12, 148, 163, 184, { weight: 0.95 });
  drawVectorText('STREAMOPS TELEMETRY · UTC+8', cardX + cardW - 34, footerDividerY + 17, 11, 100, 116, 139, {
    align: 'right',
    weight: 0.95,
  });

  return {
    pngBuffer: encodeRgbaToPng(width, height, rgba),
    windowInfo,
    sessions,
    buckets,
    maxKbps,
    avgKbps,
    peakKbps,
    currentKbps: lastActiveVal,
    totalActiveMin,
    totalEstimatedBytes,
  };
}

module.exports = {
  MINUTE_WINDOWS,
  MINUTE_WINDOW_ORDER,
  formatBeijingTime,
  getMinuteWindow,
  get24HourWindow,
  getCurveWindow,
  extractBroadcastSessions,
  buildWaveSeries,
  renderUnicodeWave,
  renderWaveChartPng,
  encodeRgbaToPng,
  platformAsciiTag,
};
