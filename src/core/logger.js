const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

const MAX_RING_SIZE = 500;
const ERROR_PATTERN = /error|❌|失败|fail|exception|超时|断开|熔断|warn|⚠️/i;
const BENIGN_NOTICE_PATTERN = /ExperimentalWarning:\s*SQLite|未配置\s*DASHBOARD_TOKEN/i;

function formatTimestamp(ms = Date.now(), timeZone = config.timezone) {
  try {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(ms)
      .reduce((acc, part) => {
        acc[part.type] = part.value;
        return acc;
      }, {});
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  } catch {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  }
}

function maskUrlInText(text = '') {
  return String(text).replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'`]+)/g, (match) => {
    const m = match.match(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]+)/);
    return m ? `${m[1]}/****` : '****';
  });
}

function sanitizeLogForPublic(text = '') {
  return maskUrlInText(text)
    .replace(/\[(\d{4,15})\]/g, '[room-***]')
    .replace(/#(\d{4,15})\b/g, '#***')
    .replace(/(chatId\s*[:=]\s*)-?\d+/gi, '$1***')
    .replace(/(room[_-]?id\s*[:=]\s*)\d+/gi, '$1***')
    .replace(/(token\s*[:=]\s*)[^\s,&"']+/gi, '$1***');
}

class Logger {
  constructor({ maxEntries = MAX_RING_SIZE, logFilePath = config.paths.logFile } = {}) {
    this.maxEntries = maxEntries;
    this.logFilePath = logFilePath;
    this.entries = [];
    this._consoleInstalled = false;
  }

  _serializeArgs(args) {
    return args
      .map((arg) => {
        if (arg instanceof Error) return arg.stack || arg.message;
        if (typeof arg === 'object' && arg !== null) {
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        }
        return String(arg);
      })
      .join(' ');
  }

  record(level, ...args) {
    const rawMessage = this._serializeArgs(args);
    const hasLeadingTs = /^\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\]/.test(rawMessage);
    const ts = formatTimestamp();
    const line = hasLeadingTs ? rawMessage : `[${ts}] ${rawMessage}`;

    this.entries.push({
      ts,
      level,
      line,
    });
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
    return line;
  }

  log(...args) {
    return this.record('log', ...args);
  }

  info(...args) {
    return this.record('info', ...args);
  }

  warn(...args) {
    return this.record('warn', ...args);
  }

  error(...args) {
    return this.record('error', ...args);
  }

  debug(...args) {
    return this.record('debug', ...args);
  }

  installConsoleCapture() {
    if (this._consoleInstalled) return;
    this._consoleInstalled = true;

    for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
      const orig = console[method].bind(console);
      console[method] = (...args) => {
        const line = this.record(method, ...args);
        orig(line);
      };
    }
  }

  _readTailFromFile(limit = 50) {
    if (!this.logFilePath || !fs.existsSync(this.logFilePath)) return [];
    const TAIL_BYTES = 64 * 1024;
    try {
      const size = fs.statSync(this.logFilePath).size;
      if (size <= 0) return [];
      const truncated = size > TAIL_BYTES;
      const start = truncated ? size - TAIL_BYTES : 0;
      const len = truncated ? TAIL_BYTES : size;
      const fd = fs.openSync(this.logFilePath, 'r');
      try {
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, start);
        let lines = buf
          .toString('utf8')
          .split('\n')
          .filter((l) => l.trim());
        if (truncated) lines = lines.slice(1);
        return lines.slice(-limit);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return [];
    }
  }

  queryLines({ onlyErrors = false, filterError = false, limit = 20, linesCount } = {}) {
    const effectiveLimit = Number.isFinite(linesCount) ? linesCount : limit;
    const effectiveOnlyErrors = Boolean(onlyErrors || filterError);
    let sourceLines = this.entries.map((e) => e.line);
    if (sourceLines.length === 0) {
      sourceLines = this._readTailFromFile(Math.max(effectiveLimit * 3, 60));
    }
    if (sourceLines.length === 0) {
      return ['暂无运行日志记录'];
    }
    if (effectiveOnlyErrors) {
      sourceLines = sourceLines.filter((l) => ERROR_PATTERN.test(l) && !BENIGN_NOTICE_PATTERN.test(l));
    }
    return sourceLines.slice(-effectiveLimit).map((l) => maskUrlInText(l));
  }
}

const defaultLogger = new Logger();

module.exports = defaultLogger;
module.exports.Logger = Logger;
module.exports.formatTimestamp = formatTimestamp;
module.exports.maskUrlInText = maskUrlInText;
module.exports.sanitizeLogForPublic = sanitizeLogForPublic;
