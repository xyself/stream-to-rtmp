'use strict';

const zlib = require('node:zlib');

const BJT_OFFSET_MS = 8 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const SESSION_GAP_MS = 4 * 60 * 1000; // 超过 4 分钟无采样或收到 0 码率视为分场边界

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
 * 计算 24 小时时间窗口（北京时间 UTC+8）
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
    startMs,
    endMs,
    startLabel,
    endLabel,
    label,
    tickLabels,
  };
}

/**
 * 从 24 小时采样点中自动切分多场次直播（例如一天播了 3 次，自动切分为第 1 场、第 2 场、第 3 场）
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
    // 单点场次默认按 1 分钟估算展示时长
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
 * 构建 24 小时均匀分桶码率数组（供波浪曲线图与 Unicode 缩略条使用）
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
    for (let i = 0; i < pts.length; i++) {
      const p1 = pts[i];
      const idx1 = Math.min(bucketCount - 1, Math.max(0, Math.floor((p1.ts - startMs) / bucketMs)));
      buckets[idx1] = Math.max(buckets[idx1], p1.kbps);

      if (i + 1 < pts.length) {
        const p2 = pts[i + 1];
        const idx2 = Math.min(bucketCount - 1, Math.max(0, Math.floor((p2.ts - startMs) / bucketMs)));
        for (let b = idx1 + 1; b < idx2; b++) {
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
 * 生成 24 格 Unicode 波浪缩略线（每格代表 1 小时）
 */
function renderUnicodeWave(samples = [], startMs, endMs) {
  const { buckets } = buildWaveSeries(samples, startMs, endMs, 24);
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

// ─── 纯 Node.js 零依赖高清 PNG 波浪图渲染器 ─────────────────────────────────

const FONT_5X7 = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ':': ['00000', '00100', '00100', '00000', '00100', '00100', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  '#': ['01010', '11111', '01010', '01010', '11111', '01010', '00000'],
  'k': ['10000', '10000', '10010', '10100', '11000', '10100', '10010'],
  'b': ['10000', '10000', '11110', '10001', '10001', '10001', '11110'],
  'p': ['00000', '00000', '11110', '10001', '11110', '10000', '10000'],
  's': ['00000', '01111', '10000', '01110', '00001', '11110', '00000'],
  'm': ['00000', '00000', '11010', '10101', '10101', '10101', '10101'],
  'h': ['10000', '10000', '11110', '10001', '10001', '10001', '10001'],
  'B': ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  'J': ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  'T': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  'S': ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

let _crcTable = null;
function getCrcTable() {
  if (_crcTable) return _crcTable;
  _crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    _crcTable[n] = c >>> 0;
  }
  return _crcTable;
}

function crc32(buf) {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
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
  for (let y = 0; y < height; y++) {
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

/**
 * 渲染高清 24h 波浪曲线图 PNG Buffer
 * - 支持多场次高亮色带（如一天播了 3 次，清晰标注 #1 / #2 / #3 场次时间段）
 * - 支持中午 12:00 → 次日 12:00（默认）或 00:00 → 24:00 刻度
 */
function renderWaveChartPng({
  samples = [],
  mode = 'noon',
  nowMs = Date.now(),
  width = 880,
  height = 380,
} = {}) {
  const windowInfo = get24HourWindow(mode, nowMs);
  const bucketCount = 240; // 每 6 分钟一个高精度采样格
  const { buckets, sessions } = buildWaveSeries(samples, windowInfo.startMs, windowInfo.endMs, bucketCount);

  const rgba = Buffer.alloc(width * height * 4);

  const blendPixel = (x, y, r, g, b, a = 255) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || xi >= width || yi < 0 || yi >= height) return;
    const idx = (yi * width + xi) * 4;
    if (a >= 255) {
      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = 255;
    } else {
      const alpha = a / 255;
      const inv = 1 - alpha;
      rgba[idx] = Math.round(r * alpha + rgba[idx] * inv);
      rgba[idx + 1] = Math.round(g * alpha + rgba[idx + 1] * inv);
      rgba[idx + 2] = Math.round(b * alpha + rgba[idx + 2] * inv);
      rgba[idx + 3] = 255;
    }
  };

  // 1. 深色背景 (#0b111e)
  for (let i = 0; i < width * height * 4; i += 4) {
    rgba[i] = 11;
    rgba[i + 1] = 17;
    rgba[i + 2] = 30;
    rgba[i + 3] = 255;
  }

  const drawRect = (x0, y0, w, h, r, g, b, a = 255) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        blendPixel(x, y, r, g, b, a);
      }
    }
  };

  const drawText = (text, x, y, scale, r, g, b, a = 255) => {
    const str = String(text);
    let cursorX = x;
    for (let i = 0; i < str.length; i++) {
      const glyph = FONT_5X7[str[i]] || FONT_5X7[' '];
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (glyph[row][col] === '1') {
            drawRect(cursorX + col * scale, y + row * scale, scale, scale, r, g, b, a);
          }
        }
      }
      cursorX += 6 * scale;
    }
  };

  const padLeft = 72;
  const padRight = 32;
  const padTop = 44;
  const padBottom = 46;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  // 绘图区底板 (#0f172a)
  drawRect(padLeft, padTop, plotW, plotH, 15, 23, 42, 255);

  const rawPeak = Math.max(1000, ...buckets);
  const maxKbps = Math.ceil((rawPeak * 1.15) / 500) * 500;

  // 2. 多场次高亮背景色带（让一天播 3 次的每一场时段区间一目了然）
  const sessionColors = [
    [16, 185, 129],  // 翠绿 #1
    [6, 182, 212],   // 青蓝 #2
    [139, 92, 246],  // 紫罗兰 #3
    [245, 158, 11],  // 琥珀 #4
  ];

  sessions.forEach((sess, idx) => {
    const col = sessionColors[idx % sessionColors.length];
    const xStart = padLeft + Math.max(0, Math.round(((sess.startMs - windowInfo.startMs) / DAY_MS) * plotW));
    const xEnd = padLeft + Math.min(plotW, Math.max(xStart - padLeft + 4, Math.round(((sess.endMs - windowInfo.startMs) / DAY_MS) * plotW)));
    drawRect(xStart, padTop, Math.max(3, xEnd - xStart), plotH, col[0], col[1], col[2], 22);
    // 顶部场次色条与标签 (#1 14:00-16:30)
    drawRect(xStart, padTop, Math.max(3, xEnd - xStart), 3, col[0], col[1], col[2], 210);
    const badgeText = `#${sess.index} ${sess.startTimeStr}-${sess.endTimeStr}`;
    const labelX = Math.min(padLeft + plotW - badgeText.length * 6, Math.max(padLeft + 4, xStart));
    drawText(badgeText, labelX, padTop - 14, 1, col[0], col[1], col[2], 240);
  });

  // 3. 水平码率刻度网格线 (0%, 25%, 50%, 75%, 100%)
  for (let i = 0; i <= 4; i++) {
    const ratio = i / 4;
    const y = Math.round(padTop + plotH - ratio * plotH);
    const valKbps = Math.round(maxKbps * ratio);
    for (let x = padLeft; x <= padLeft + plotW; x++) {
      if (i === 0 || x % 4 < 2) {
        blendPixel(x, y, 51, 65, 85, i === 0 ? 220 : 120);
      }
    }
    const label = `${valKbps}k`;
    drawText(label, Math.max(8, padLeft - label.length * 6 - 8), y - 3, 1, 148, 163, 184, 220);
  }

  // 4. 垂直 24 小时时间刻度线 (每 3 小时一条，共 9 个刻度)
  for (let i = 0; i <= 8; i++) {
    const x = Math.round(padLeft + (i / 8) * plotW);
    const isMidpoint = i === 4; // noon 模式下 i=4 正好是 00:00 午夜分界线
    for (let y = padTop; y <= padTop + plotH; y++) {
      if (i === 0 || i === 8 || y % 4 < 2) {
        blendPixel(x, y, isMidpoint ? 99 : 51, isMidpoint ? 102 : 65, isMidpoint ? 241 : 85, isMidpoint ? 180 : 110);
      }
    }
    const tick = windowInfo.tickLabels[i] || '';
    drawText(tick, x - Math.round((tick.length * 6) / 2), padTop + plotH + 12, 1, isMidpoint ? 165 : 148, isMidpoint ? 180 : 163, isMidpoint ? 252 : 184, 235);
  }

  // 5. 若当前时间落在 24h 窗口内，绘制当前时刻的竖向游标线
  if (nowMs >= windowInfo.startMs && nowMs <= windowInfo.endMs) {
    const nowX = Math.round(padLeft + ((nowMs - windowInfo.startMs) / DAY_MS) * plotW);
    for (let y = padTop; y <= padTop + plotH; y += 3) {
      blendPixel(nowX, y, 250, 204, 21, 150);
    }
  }

  // 6. 绘制平滑波浪曲线与波浪下方渐变填充
  // 将 240 个分桶映射为像素级平滑曲线（3 点移动均值滤波让波浪曲线柔顺自然，同时严格保留 0 值断播边界）
  const pixelValues = new Float64Array(plotW);
  for (let px = 0; px < plotW; px++) {
    const pos = (px / Math.max(1, plotW - 1)) * (bucketCount - 1);
    const idx0 = Math.floor(pos);
    const idx1 = Math.min(bucketCount - 1, idx0 + 1);
    const frac = pos - idx0;
    const v0 = buckets[idx0];
    const v1 = buckets[idx1];
    if (v0 === 0 || v1 === 0) {
      pixelValues[px] = frac < 0.5 ? v0 : v1;
    } else {
      pixelValues[px] = v0 + (v1 - v0) * frac;
    }
  }

  // 对非零区段做轻微平滑形成优美波浪线
  const smoothed = new Float64Array(plotW);
  for (let px = 0; px < plotW; px++) {
    if (pixelValues[px] <= 0) {
      smoothed[px] = 0;
      continue;
    }
    let sum = 0;
    let weight = 0;
    for (let d = -3; d <= 3; d++) {
      const nx = px + d;
      if (nx >= 0 && nx < plotW && pixelValues[nx] > 0) {
        const w = 4 - Math.abs(d);
        sum += pixelValues[nx] * w;
        weight += w;
      }
    }
    smoothed[px] = weight > 0 ? sum / weight : pixelValues[px];
  }

  let prevY = null;
  for (let px = 0; px < plotW; px++) {
    const val = smoothed[px];
    const x = padLeft + px;
    const yBottom = padTop + plotH;
    const y = Math.round(yBottom - Math.min(1, val / maxKbps) * (plotH - 6));

    if (val > 0) {
      // 波浪下方渐变填充
      for (let fy = y; fy < yBottom; fy++) {
        const depthRatio = 1 - (fy - y) / Math.max(1, yBottom - y);
        const alpha = Math.round(18 + depthRatio * 95);
        blendPixel(x, fy, 16, 185, 129, alpha);
      }

      // 连续抗锯齿波浪主线 (2.5px 翠绿亮边)
      const yFrom = prevY !== null ? Math.min(prevY, y) : y;
      const yTo = prevY !== null ? Math.max(prevY, y) : y;
      for (let ly = yFrom; ly <= yTo; ly++) {
        blendPixel(x, ly, 52, 211, 153, 255);
        blendPixel(x, ly - 1, 16, 185, 129, 220);
        blendPixel(x, ly + 1, 6, 182, 212, 180);
      }
      prevY = y;
    } else {
      prevY = null;
      // 停播期间贴底细暗线
      blendPixel(x, yBottom - 1, 71, 85, 105, 140);
    }
  }

  // 顶部标题角标 (BJT 12:00-12:00 / 00:00-24:00)
  const topTitle = `BJT ${windowInfo.startLabel} - ${windowInfo.endLabel}`;
  drawText(topTitle, padLeft, 12, 1, 226, 232, 240, 230);

  return {
    pngBuffer: encodeRgbaToPng(width, height, rgba),
    windowInfo,
    sessions,
    buckets,
    maxKbps,
  };
}

module.exports = {
  formatBeijingTime,
  get24HourWindow,
  extractBroadcastSessions,
  buildWaveSeries,
  renderUnicodeWave,
  renderWaveChartPng,
};
