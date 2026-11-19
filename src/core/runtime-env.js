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
  try {
    const report = getReport();
    if (report?.header && !report.header.glibcVersionRuntime) {
      return true;
    }
  } catch {}
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
  if (existsFn('/usr/local/bin/devil')) return true;
  const home = env.HOME || '';
  return /^\/usr\/home\/[^/]+/.test(home);
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
};
