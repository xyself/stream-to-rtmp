'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { isMuslLinux } = require('../core/runtime-env');

const LOCAL_BIN_DIR = path.join(__dirname, '../../bin');
const LOCAL_FFMPEG_BIN = path.join(LOCAL_BIN_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

/**
 * 检测宿主机是否安装了 xz 与 tar（部分精简容器/VPS 无 xz-utils，直接调 tar -xJf 会报 xz: Cannot exec）
 */
function hasSystemTarXz() {
  try {
    const xzCheck = spawnSync('xz', ['--version'], { timeout: 3000 });
    const tarCheck = spawnSync('tar', ['--version'], { timeout: 3000 });
    return xzCheck.status === 0 && tarCheck.status === 0;
  } catch {
    return false;
  }
}

/**
 * 检测宿主机是否具备 python3 + 内置 lzma/tarfile（无 xz-utils 的精简容器可直接用 Python 解压官方 BtbN .tar.xz）
 */
function hasPythonLzma() {
  try {
    const pyCheck = spawnSync('python3', ['-c', 'import lzma, tarfile'], { timeout: 3000 });
    return pyCheck.status === 0;
  } catch {
    return false;
  }
}

function canExtractTarXz() {
  return hasSystemTarXz() || hasPythonLzma();
}

/**
 * 获取各平台静态编译版 FFmpeg 下载源
 * 说明：FFmpeg 官网 (ffmpeg.org/download.html) 本身只发源码，Linux 官方指定静态构建为 BtbN 与 JohnVanSickle；
 * 当宿主机具备 tar+xz 或 python3+lzma 时优先拉取官方 BtbN 正式版，避免旧 glibc 静态版在现代 Linux 发生 DNS NSS SIGSEGV。
 */
function getStaticDownloadCandidates(
  platform = process.platform,
  arch = process.arch,
  customUrl = process.env.FFMPEG_DOWNLOAD_URL,
  canUseTarXz = canExtractTarXz(),
  musl = isMuslLinux({ platform })
) {
  const list = [];
  if (customUrl && String(customUrl).trim()) {
    const url = String(customUrl).trim();
    const type =
      url.endsWith('.tar.xz') || url.endsWith('.txz')
        ? 'tar.xz'
        : url.endsWith('.gz')
          ? 'gz'
          : 'raw';
    list.push({
      name: '自定义 FFmpeg 源 (FFMPEG_DOWNLOAD_URL)',
      url,
      type,
    });
  }

  // Alpine / musl 容器无法运行 glibc 编译的 BtbN 或 ffmpeg-static 二进制，优先使用 apk 安装的系统 FFmpeg
  if (platform === 'linux' && musl) {
    return list;
  }

  if (platform === 'linux' && arch === 'x64') {
    if (canUseTarXz) {
      list.push(
        {
          name: 'FFmpeg 9.0 官方正式版静态构建 (ffmpeg.org / BtbN Linux x64)',
          url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-linux64-gpl-9.0.tar.xz',
          type: 'tar.xz',
        },
        {
          name: 'FFmpeg 8.1 官方正式版静态构建 (ffmpeg.org / BtbN Linux x64)',
          url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-linux64-gpl-8.1.tar.xz',
          type: 'tar.xz',
        }
      );
    }
    // 纯 Node.js 原生 zlib 解压源（无需宿主机安装 xz 或 tar，100% 兼容精简容器与 VPS）
    list.push({
      name: 'FFmpeg 官方静态单文件版 (Node.js 原生 gzip 解压 · 免 xz/tar)',
      url: 'https://github.com/eugeneware/ffmpeg-static/releases/latest/download/ffmpeg-linux-x64.gz',
      type: 'gz',
    });
  } else if (platform === 'linux' && arch === 'arm64') {
    if (canUseTarXz) {
      list.push(
        {
          name: 'FFmpeg 9.0 官方正式版静态构建 (ffmpeg.org / BtbN Linux arm64)',
          url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-linuxarm64-gpl-9.0.tar.xz',
          type: 'tar.xz',
        },
        {
          name: 'FFmpeg 8.1 官方正式版静态构建 (ffmpeg.org / BtbN Linux arm64)',
          url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-linuxarm64-gpl-8.1.tar.xz',
          type: 'tar.xz',
        }
      );
    }
    list.push({
      name: 'FFmpeg 官方静态单文件版 (Node.js 原生 gzip 解压 · 免 xz/tar)',
      url: 'https://github.com/eugeneware/ffmpeg-static/releases/latest/download/ffmpeg-linux-arm64.gz',
      type: 'gz',
    });
  } else if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) {
    list.push({
      name: `FFmpeg 官方静态单文件版 (macOS ${arch})`,
      url: `https://github.com/eugeneware/ffmpeg-static/releases/latest/download/ffmpeg-darwin-${arch}.gz`,
      type: 'gz',
    });
  }

  return list;
}

/**
 * 检测某个 ffmpeg 可执行文件是否可用并返回版本号
 */
function probeFfmpegBinary(binPath) {
  if (!binPath) return { ok: false, version: null, binPath: null };
  try {
    const probe = spawnSync(binPath, ['-version'], { timeout: 10000 });
    if (probe.status !== 0 || probe.error) {
      return {
        ok: false,
        version: null,
        binPath,
        error: probe.error?.message || `退出码 ${probe.status}`,
      };
    }
    const firstLine = String(probe.stdout || '').split('\n')[0] || '';
    const verMatch = firstLine.match(/ffmpeg version\s+([^\s]+)/i);
    return {
      ok: true,
      version: verMatch ? verMatch[1] : 'unknown',
      rawFirstLine: firstLine.trim(),
      binPath,
    };
  } catch (err) {
    return { ok: false, version: null, binPath, error: err.message };
  }
}

/**
 * 校验 FFmpeg 在当前宿主机 glibc 环境下执行 DNS/HTTPS 不会发生 SIGSEGV/SIGILL（退出码 139/132）
 * 部分旧版全静态编译二进制（如 Debian 8 glibc 编译产物）运行 -version 正常，但一做域名解析即段错误。
 */
function verifyFfmpegNetworkSafe(binPath) {
  if (!binPath) return { ok: false, error: '无效路径' };
  try {
    const res = spawnSync(
      binPath,
      ['-nostdin', '-loglevel', 'error', '-rw_timeout', '4000000', '-i', 'https://api.live.bilibili.com/robots.txt', '-t', '1', '-f', 'null', '-'],
      { timeout: 6000 }
    );
    const crashedBySignal = ['SIGSEGV', 'SIGILL', 'SIGBUS', 'SIGABRT'].includes(res.signal);
    const crashedByCode = res.status === 139 || res.status === 132 || res.status === 134 || res.status === 135;
    if (crashedBySignal || crashedByCode) {
      return {
        ok: false,
        error: `网络/DNS 自检崩溃 (${res.signal || `exit ${res.status}`})，当前系统 glibc 与该静态二进制不兼容`,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * 返回按优先级排序的 FFmpeg 候选路径列表（支持 Serv00/FreeBSD cron 精简 PATH 环境自动发现 /usr/local/bin/ffmpeg）
 */
function getFfmpegCandidates(explicitEnvPath = process.env.FFMPEG_PATH) {
  const candidates = [];
  const pushUnique = (p) => {
    if (p && !candidates.includes(p)) candidates.push(p);
  };

  if (explicitEnvPath && String(explicitEnvPath).trim() !== '') {
    pushUnique(String(explicitEnvPath).trim());
    return candidates;
  }

  if (fs.existsSync(LOCAL_FFMPEG_BIN)) {
    try {
      fs.accessSync(LOCAL_FFMPEG_BIN, fs.constants.X_OK);
      pushUnique(LOCAL_FFMPEG_BIN);
    } catch {}
  }

  const homeBin = path.join(os.homedir(), 'bin', 'ffmpeg');
  if (fs.existsSync(homeBin)) {
    try {
      fs.accessSync(homeBin, fs.constants.X_OK);
      pushUnique(homeBin);
    } catch {}
  }

  // Serv00 / FreeBSD cron 默认 PATH 不含 /usr/local/bin，主动补充常见系统路径
  const extraSystemPaths =
    process.platform === 'freebsd'
      ? ['/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']
      : process.platform === 'darwin'
        ? ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']
        : ['/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];

  // 先放系统 PATH 中的 ffmpeg（若 resolveActualExecutablePath 可解析到真实文件）
  const pathResolved = resolveActualExecutablePath('ffmpeg');
  if (pathResolved && pathResolved !== 'ffmpeg') {
    pushUnique('ffmpeg');
  }

  for (const sysPath of extraSystemPaths) {
    if (fs.existsSync(sysPath)) {
      try {
        fs.accessSync(sysPath, fs.constants.X_OK);
        if (pathResolved !== sysPath) pushUnique(sysPath);
      } catch {}
    }
  }

  pushUnique('ffmpeg');
  return candidates;
}

/**
 * 解析当前应当使用的 FFmpeg 路径（当 .env 未填 FFMPEG_PATH 时自动按优先级查找）：
 * 1. .env 中显式指定的 FFMPEG_PATH
 * 2. 项目内置下载目录 ./bin/ffmpeg（最新静态版）
 * 3. 用户主目录 ~/bin/ffmpeg
 * 4. 系统环境变量 PATH 中的 ffmpeg（以及 FreeBSD/Serv00 下的 /usr/local/bin/ffmpeg）
 */
function resolveFfmpegBin(explicitEnvPath = process.env.FFMPEG_PATH) {
  return getFfmpegCandidates(explicitEnvPath)[0] || 'ffmpeg';
}

/**
 * 从候选列表中挑出第一个真正可执行且通过网络/DNS 安全自检的 FFmpeg（防止误拷进 Alpine/FreeBSD 的异构 ./bin/ffmpeg 阻塞启动）
 */
function findWorkingFfmpegBin({ explicitEnvPath = process.env.FFMPEG_PATH, checkNetwork = true } = {}) {
  const candidates = getFfmpegCandidates(explicitEnvPath);
  let lastFailure = { ok: false, version: null, binPath: candidates[0] || 'ffmpeg', error: '未找到可用的 FFmpeg' };

  for (const candidate of candidates) {
    const probe = probeFfmpegBinary(candidate);
    if (!probe.ok) {
      lastFailure = probe;
      continue;
    }
    if (checkNetwork) {
      const net = verifyFfmpegNetworkSafe(candidate);
      if (!net.ok) {
        lastFailure = { ...probe, ok: false, error: net.error };
        continue;
      }
    }
    return probe;
  }
  return lastFailure;
}

/**
 * 将命令名（如 'ffmpeg'）或相对路径解析为磁盘上的真实绝对路径
 */
function resolveActualExecutablePath(binPath) {
  if (!binPath) return '';
  const trimmed = String(binPath).trim();
  if (trimmed.includes('/') || trimmed.includes('\\') || path.isAbsolute(trimmed)) {
    const abs = path.resolve(trimmed);
    try {
      return fs.realpathSync(abs);
    } catch {
      return abs;
    }
  }

  const pathEnv = process.env.PATH || '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, trimmed + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) {
          try {
            return fs.realpathSync(candidate);
          } catch {
            return candidate;
          }
        }
      } catch {}
    }
  }
  return trimmed;
}

let _cachedRuntimeInfo = null;

/**
 * 获取当前生效的 FFmpeg 完整运行时信息（版本号、真实安装路径、来源类型、是否为自定义/内置二进制）
 */
function getFfmpegRuntimeInfo({ forceRefresh = false, explicitEnvPath = process.env.FFMPEG_PATH } = {}) {
  const binPath = resolveFfmpegBin(explicitEnvPath);
  if (!forceRefresh && _cachedRuntimeInfo && _cachedRuntimeInfo.binPath === binPath) {
    return _cachedRuntimeInfo;
  }

  const homeBin = path.join(os.homedir(), 'bin', 'ffmpeg');
  let sourceType = 'system_path';
  let sourceLabel = '系统默认 PATH';
  let isCustomBinary = false;

  if (explicitEnvPath && String(explicitEnvPath).trim() !== '') {
    sourceType = 'env_custom';
    sourceLabel = '自定义环境变量 (FFMPEG_PATH)';
    isCustomBinary = true;
  } else if (binPath === LOCAL_FFMPEG_BIN) {
    sourceType = 'bundled_latest';
    sourceLabel = '项目内置最新静态版 (./bin/ffmpeg)';
    isCustomBinary = true;
  } else if (binPath === homeBin) {
    sourceType = 'user_home';
    sourceLabel = '用户主目录二进制 (~/bin/ffmpeg)';
    isCustomBinary = true;
  }

  const resolvedPath = resolveActualExecutablePath(binPath);
  const probe = probeFfmpegBinary(binPath);

  _cachedRuntimeInfo = {
    ok: probe.ok,
    version: probe.ok ? probe.version : 'unknown',
    rawFirstLine: probe.rawFirstLine || '',
    binPath,
    resolvedPath,
    sourceType,
    sourceLabel,
    isCustomBinary,
    error: probe.error || null,
  };

  return _cachedRuntimeInfo;
}

/**
 * 自动下载并解压静态版 FFmpeg 到 ./bin/ffmpeg
 * 支持：
 * - 'gz'：使用 Node.js 内置 zlib.gunzipSync 直接解压（不依赖 tar / xz，精简容器 100% 可用）
 * - 'raw'：单文件直存
 * - 'tar.xz'：当宿主机具备 tar + xz 时解压官方正式版归档
 */
async function downloadLatestFfmpeg({ logger = console } = {}) {
  const candidates = getStaticDownloadCandidates();
  if (candidates.length === 0) {
    const hint = isMuslLinux()
      ? '当前为 Alpine/musl 容器环境，无法直接运行 glibc 静态包，请通过 apk add ffmpeg 安装或在 .env 配置 FFMPEG_DOWNLOAD_URL / FFMPEG_PATH'
      : process.platform === 'freebsd'
        ? '当前为 FreeBSD/Serv00 环境，请直接使用系统预装的 /usr/local/bin/ffmpeg 或将 FreeBSD 版二进制放入 ~/bin/ffmpeg'
        : `当前系统架构 (${process.platform}/${process.arch}) 暂不支持自动下载静态编译包，请使用系统自带 ffmpeg 或手动放入 ./bin/ffmpeg`;
    throw new Error(hint);
  }

  fs.mkdirSync(LOCAL_BIN_DIR, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamops-ffmpeg-'));
  const archivePath = path.join(tmpDir, 'ffmpeg.tar.xz');

  let lastErr = null;
  try {
    for (const candidate of candidates) {
      try {
        logger.log(`⬇️ 正在下载静态版 FFmpeg: ${candidate.name} ...`);
        const res = await fetch(candidate.url, {
          redirect: 'follow',
          signal: AbortSignal.timeout(180000),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 1024 * 1024) {
          throw new Error(`下载文件异常过小 (${buf.length} bytes)`);
        }

        const targetTmp = `${LOCAL_FFMPEG_BIN}.tmp.${process.pid}`;
        if (candidate.type === 'gz') {
          const decompressed = zlib.gunzipSync(buf);
          fs.writeFileSync(targetTmp, decompressed);
        } else if (candidate.type === 'raw') {
          fs.writeFileSync(targetTmp, buf);
        } else {
          fs.writeFileSync(archivePath, buf);

          const extractDir = path.join(tmpDir, 'extracted');
          fs.mkdirSync(extractDir, { recursive: true });
          if (hasSystemTarXz()) {
            const tarRes = spawnSync('tar', ['-xJf', archivePath, '-C', extractDir], {
              timeout: 60000,
            });
            if (tarRes.status !== 0) {
              throw new Error(`tar 解压失败: ${String(tarRes.stderr || '').trim() || tarRes.status}`);
            }
          } else if (hasPythonLzma()) {
            const pyScript = [
              'import os, sys, tarfile',
              'archive, out_dir = sys.argv[1], sys.argv[2]',
              'with tarfile.open(archive, "r:xz") as tf:',
              '    for m in tf.getmembers():',
              '        if m.isfile() and os.path.basename(m.name) == "ffmpeg":',
              '            with tf.extractfile(m) as src, open(os.path.join(out_dir, "ffmpeg"), "wb") as dst:',
              '                dst.write(src.read())',
              '            break',
            ].join('\n');
            const pyRes = spawnSync('python3', ['-c', pyScript, archivePath, extractDir], {
              timeout: 60000,
            });
            if (pyRes.status !== 0) {
              throw new Error(`python3 解压 .tar.xz 失败: ${String(pyRes.stderr || '').trim() || pyRes.status}`);
            }
          } else {
            throw new Error('当前环境既无 xz 命令也无 python3 lzma，无法解压 .tar.xz 归档');
          }

          const foundBin = findFileRecursive(extractDir, 'ffmpeg');
          if (!foundBin) {
            throw new Error('解压归档中未找到 ffmpeg 二进制文件');
          }
          fs.copyFileSync(foundBin, targetTmp);
        }

        fs.chmodSync(targetTmp, 0o755);

        const probe = probeFfmpegBinary(targetTmp);
        if (!probe.ok) {
          try { fs.rmSync(targetTmp, { force: true }); } catch {}
          throw new Error(`下载的二进制无法在当前系统运行: ${probe.error}`);
        }

        const netCheck = verifyFfmpegNetworkSafe(targetTmp);
        if (!netCheck.ok) {
          try { fs.rmSync(targetTmp, { force: true }); } catch {}
          throw new Error(netCheck.error);
        }

        fs.renameSync(targetTmp, LOCAL_FFMPEG_BIN);

        _cachedRuntimeInfo = null;
        logger.log(`✅ FFmpeg 已安装至 ${LOCAL_FFMPEG_BIN} (版本: ${probe.version})`);
        return {
          ok: true,
          binPath: LOCAL_FFMPEG_BIN,
          version: probe.version,
          source: candidate.name,
        };
      } catch (err) {
        lastErr = err;
        logger.warn?.(`⚠️ 从 [${candidate.name}] 获取 FFmpeg 失败: ${err.message}`);
      }
    }
    throw lastErr || new Error('所有 FFmpeg 静态源下载均失败');
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

function findFileRecursive(dir, targetName) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === targetName) {
      return fullPath;
    }
    if (entry.isDirectory()) {
      const found = findFileRecursive(fullPath, targetName);
      if (found) return found;
    }
  }
  return null;
}

module.exports = {
  LOCAL_BIN_DIR,
  LOCAL_FFMPEG_BIN,
  hasSystemTarXz,
  hasPythonLzma,
  canExtractTarXz,
  getStaticDownloadCandidates,
  probeFfmpegBinary,
  verifyFfmpegNetworkSafe,
  getFfmpegCandidates,
  resolveFfmpegBin,
  findWorkingFfmpegBin,
  resolveActualExecutablePath,
  getFfmpegRuntimeInfo,
  downloadLatestFfmpeg,
};
