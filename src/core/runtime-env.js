'use strict';

const fs = require('node:fs');
const os = require('node:os');

const UNLIMITED_CGROUP_BYTES = 1024 * 1024 * 1024 * 1024 * 1024; // 1 PiB sentinel

function safeReadFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

function safeExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

/**
 * 检测当前是否运行在容器环境中（Docker / Podman / Kubernetes / Cloud Run / Zeabur 等）
 */
function isContainer({
  platform = process.platform,
  env = process.env,
  existsFn = safeExists,
  readFileFn = safeReadFile,
} = {}) {
  if (env.CONTAINER === '1' || env.DOCKER === '1' || env.KUBERNETES_SERVICE_HOST || env.K_SERVICE) {
    return true;
  }
  if (platform !== 'linux') return false;
  if (existsFn('/.dockerenv') || existsFn('/run/.containerenv')) {
    return true;
  }
  const cgroup = readFileFn('/proc/1/cgroup') || '';
  return /(docker|kubepods|containerd|podman|lxc|crio)/i.test(cgroup);
}

/**
 * 检测 Linux 是否为 musl libc（如 Alpine Linux 容器），避免错误下载 glibc 编译的 FFmpeg 二进制
 */
function isMuslLinux({
  platform = process.platform,
  existsFn = safeExists,
  getReport = () => (typeof process.report?.getReport === 'function' ? process.report.getReport() : null),
} = {}) {
  if (platform !== 'linux') return false;
  if (existsFn('/etc/alpine-release')) return true;
  if (existsFn('/lib/ld-musl-x86_64.so.1') || existsFn('/lib/ld-musl-aarch64.so.1')) return true;
  if (process.platform === 'linux') {
    try {
      const report = getReport();
      if (report?.header && !report.header.glibcVersionRuntime) {
        return true;
      }
    } catch {}
  }
  return false;
}

/**
 * 检测是否运行在 Serv00 / FreeBSD 共享主机环境
 */
function isServ00({
  platform = process.platform,
  env = process.env,
  existsFn = safeExists,
} = {}) {
  if (env.SERV00 === '1') return true;
  if (platform !== 'freebsd') return false;
  if (
    existsFn('/bin/devil') ||
    existsFn('/usr/local/devil/bin/devil') ||
    existsFn('/usr/local/bin/devil')
  ) {
    return true;
  }
  const home = env.HOME || '';
  return /^\/(usr\/)?home\/[^/]+/.test(home);
}

function toMB(val, unit) {
  const n = parseFloat(val);
  const u = (unit || 'M').toUpperCase();
  if (u === 'G') return Math.round(n * 1024);
  if (u === 'K') return Math.round(n / 1024);
  if (u === 'T') return Math.round(n * 1024 * 1024);
  return Math.round(n);
}

function stripAnsi(str) {
  return typeof str === 'string' ? str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '') : '';
}

/**
 * 解析 Serv00 devil info limits 终端输出
 */
function parseDevilLimits(output) {
  if (!output || typeof output !== 'string') return null;
  const clean = stripAnsi(output);
  const res = {};

  const diskMatch = clean.match(/Disk quota:\s*\[.*?\]\s*([\d.]+)%\s*\(([\d.]+)([MKGT]?)\/([\d.]+)([MKGT]?)\)/i);
  if (diskMatch) {
    res.disk = {
      usePct: parseFloat(diskMatch[1]),
      usedMB: toMB(diskMatch[2], diskMatch[3]),
      limitMB: toMB(diskMatch[4], diskMatch[5]),
      raw: `${diskMatch[2]}${diskMatch[3]}/${diskMatch[4]}${diskMatch[5]}`,
    };
  }

  const ramMatch = clean.match(/RAM memory:\s*\[.*?\]\s*([\d.]+)%\s*\(([\d.]+)([MKGT]?)\/([\d.]+)([MKGT]?)\)/i);
  if (ramMatch) {
    res.memory = {
      usePct: Math.round(parseFloat(ramMatch[1])),
      usedMB: toMB(ramMatch[2], ramMatch[3]),
      limitMB: toMB(ramMatch[4], ramMatch[5]),
      raw: `${ramMatch[2]}${ramMatch[3]}/${ramMatch[4]}${ramMatch[5]}`,
    };
  }

  const procMatch = clean.match(/Processes:\s*\[.*?\]\s*([\d.]+)%\s*\((\d+)\/(\d+)\)/i);
  if (procMatch) {
    res.processes = {
      usePct: parseFloat(procMatch[1]),
      used: parseInt(procMatch[2], 10),
      limit: parseInt(procMatch[3], 10),
    };
  }

  const cpuMatch = clean.match(/CPU:\s*\[.*?\]\s*([\d.]+)%/i);
  if (cpuMatch) {
    res.cpu = {
      usePct: parseFloat(cpuMatch[1]),
    };
  }

  return Object.keys(res).length > 0 ? res : null;
}

let cachedServ00Limits = null;
let lastServ00LimitsFetch = 0;
const SERV00_LIMITS_TTL_MS = 30000; // 30 秒缓存，防止频繁执行 devil 命令

/**
 * 读取 Serv00 真实配额数据（RAM 512MB / 磁盘 3.0GB / CPU / 进程数）
 */
function getServ00Limits({
  forceRefresh = false,
  execFn = null,
} = {}) {
  const now = Date.now();
  if (!forceRefresh && cachedServ00Limits && now - lastServ00LimitsFetch < SERV00_LIMITS_TTL_MS) {
    return cachedServ00Limits;
  }

  try {
    let output = '';
    if (typeof execFn === 'function') {
      output = execFn();
    } else {
      const { execSync } = require('node:child_process');
      const devilBin = ['/bin/devil', '/usr/local/devil/bin/devil', '/usr/local/bin/devil', 'devil'].find((b) => {
        try {
          return b === 'devil' || fs.existsSync(b);
        } catch {
          return false;
        }
      }) || 'devil';
      output = execSync(`${devilBin} info limits`, {
        encoding: 'utf8',
        timeout: 4000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    }

    const parsed = parseDevilLimits(output);
    if (parsed) {
      cachedServ00Limits = parsed;
      lastServ00LimitsFetch = now;
      return parsed;
    }
  } catch {
    // devil 命令不可用或超时
  }

  return cachedServ00Limits;
}

/**
 * 读取 Linux 容器 cgroup v2 / v1 内存限额与当前用量
 * 无容器限额或非 Linux 环境时返回 null
 */
function getCgroupMemoryStats({
  platform = process.platform,
  readFileFn = safeReadFile,
} = {}) {
  if (platform !== 'linux') return null;

  // cgroup v2
  const v2Max = readFileFn('/sys/fs/cgroup/memory.max');
  const v2Cur = readFileFn('/sys/fs/cgroup/memory.current');
  if (v2Max && v2Cur && v2Max !== 'max') {
    const limitBytes = Number(v2Max);
    const usedBytes = Number(v2Cur);
    if (
      Number.isFinite(limitBytes) &&
      limitBytes > 0 &&
      limitBytes < UNLIMITED_CGROUP_BYTES &&
      Number.isFinite(usedBytes) &&
      usedBytes >= 0
    ) {
      return {
        version: 'v2',
        limitBytes,
        usedBytes,
        limitMB: Math.round(limitBytes / (1024 * 1024)),
        usedMB: Math.round(usedBytes / (1024 * 1024)),
        usePct: Math.min(100, Math.round((usedBytes / limitBytes) * 100)),
      };
    }
  }

  // cgroup v1
  const v1Max = readFileFn('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  const v1Cur = readFileFn('/sys/fs/cgroup/memory/memory.usage_in_bytes');
  if (v1Max && v1Cur) {
    const limitBytes = Number(v1Max);
    const usedBytes = Number(v1Cur);
    const hostTotal = os.totalmem();
    if (
      Number.isFinite(limitBytes) &&
      limitBytes > 0 &&
      limitBytes < UNLIMITED_CGROUP_BYTES &&
      limitBytes <= hostTotal * 1.05 &&
      Number.isFinite(usedBytes) &&
      usedBytes >= 0
    ) {
      return {
        version: 'v1',
        limitBytes,
        usedBytes,
        limitMB: Math.round(limitBytes / (1024 * 1024)),
        usedMB: Math.round(usedBytes / (1024 * 1024)),
        usePct: Math.min(100, Math.round((usedBytes / limitBytes) * 100)),
      };
    }
  }

  return null;
}

/**
 * 汇总当前运行环境特征与推荐资源阈值
 */
function getRuntimeProfile(opts = {}) {
  const platform = opts.platform || process.platform;
  const container = isContainer(opts);
  const musl = isMuslLinux(opts);
  const serv00 = isServ00(opts);
  const freebsd = platform === 'freebsd';

  let kind = platform;
  if (serv00) {
    kind = 'serv00';
  } else if (freebsd) {
    kind = 'freebsd';
  } else if (container && musl) {
    kind = 'docker-alpine';
  } else if (container) {
    kind = 'docker-linux';
  }

  return {
    kind,
    platform,
    arch: opts.arch || process.arch,
    isContainer: container,
    isMusl: musl,
    isServ00: serv00,
    isFreeBSD: freebsd,
    // Serv00 单账号总内存通常为 512MB，不适合用宿主机总内存百分比判断
    defaultMemAlertMb: serv00 ? 384 : 0,
    defaultCriticalMemMb: serv00 ? 448 : 0,
    // Serv00/FreeBSD 受单用户进程/线程上限约束，软转码时限制线程数避免资源耗尽
    recommendedFfmpegThreads: serv00 || freebsd ? 2 : 0,
  };
}

module.exports = {
  isContainer,
  isMuslLinux,
  isServ00,
  getCgroupMemoryStats,
  getRuntimeProfile,
  parseDevilLimits,
  getServ00Limits,
};
