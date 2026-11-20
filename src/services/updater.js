const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const DEFAULT_REPO = process.env.UPDATE_REPO || 'xyself/stream-to-rtmp';
const DEFAULT_BRANCH = process.env.UPDATE_BRANCH || 'main';
const STATE_FILE = path.join(process.cwd(), 'data', 'update-state.json');

// 覆盖更新时严格保留的本地运行时目录与文件（绝不覆盖或删除）
const PRESERVED_ROOT_ENTRIES = new Set([
  '.env',
  '.git',
  'data',
  'logs',
  'bin',
  'node_modules',
  '.stopped',
  '.auto-start.lock',
  '.playwright-cli',
  '.aistudio',
  'metadata.json',
]);

function getStateFilePath(cwd = process.cwd()) {
  return path.join(cwd, 'data', 'update-state.json');
}

function getVersionFilePath(cwd = process.cwd()) {
  return path.join(cwd, 'data', '.version.json');
}

function buildExecEnv() {
  const extraPath = ['/usr/local/bin', '/usr/bin', '/bin'];
  const current = String(process.env.PATH || '');
  const merged = [...new Set([...current.split(':').filter(Boolean), ...extraPath])].join(':');
  return {
    ...process.env,
    PATH: merged,
  };
}

function parseGithubRepoFromUrl(url) {
  const m = String(url || '').match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?(?:\s|$|#|\?)/);
  return m && m[1] ? m[1] : null;
}

function detectRepoSlug(cwd = process.cwd()) {
  const envRepo = String(process.env.UPDATE_REPO || process.env.GITHUB_REPO || '').trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(envRepo)) {
    return envRepo;
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    const repoField = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    const parsed = parseGithubRepoFromUrl(repoField);
    if (parsed) return parsed;
  } catch {}

  return DEFAULT_REPO;
}

function readRecordedVersion(cwd = process.cwd()) {
  const vPath = getVersionFilePath(cwd);
  if (!fs.existsSync(vPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(vPath, 'utf8'));
    if (data && typeof data.sha === 'string' && data.sha.trim()) {
      return {
        sha: data.sha.trim(),
        msg: data.msg || '',
        date: data.date || null,
        ok: true,
        mode: 'tarball',
      };
    }
  } catch {}
  return null;
}

/**
 * 纯文件系统读取（不调用 git 命令）：
 * 如果用户初始通过 git clone 部署且尚未执行过压缩包更新，
 * 尝试读取 .git/HEAD 获取初始 commit 短 SHA，便于准确比对是否已是最新。
 */
function readSeedShaFromDotGit(cwd = process.cwd()) {
  try {
    const headPath = path.join(cwd, '.git', 'HEAD');
    if (!fs.existsSync(headPath)) return null;
    const headContent = fs.readFileSync(headPath, 'utf8').trim();
    if (/^[0-9a-f]{7,40}$/i.test(headContent)) {
      return headContent.slice(0, 7);
    }
    const refMatch = headContent.match(/^ref:\s*(.+)$/);
    if (!refMatch) return null;
    const refName = refMatch[1].trim();
    const refPath = path.join(cwd, '.git', refName);
    if (fs.existsSync(refPath)) {
      const refSha = fs.readFileSync(refPath, 'utf8').trim();
      if (/^[0-9a-f]{7,40}$/i.test(refSha)) return refSha.slice(0, 7);
    }
    const packedPath = path.join(cwd, '.git', 'packed-refs');
    if (fs.existsSync(packedPath)) {
      const lines = fs.readFileSync(packedPath, 'utf8').split('\n');
      for (const line of lines) {
        if (!line || line.startsWith('#') || line.startsWith('^')) continue;
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2 && parts[1] === refName && /^[0-9a-f]{7,40}$/i.test(parts[0])) {
          return parts[0].slice(0, 7);
        }
      }
    }
  } catch {}
  return null;
}

function writeRecordedVersion(cwd, info) {
  const vPath = getVersionFilePath(cwd);
  fs.mkdirSync(path.dirname(vPath), { recursive: true });
  fs.writeFileSync(
    vPath,
    JSON.stringify(
      {
        sha: info.sha,
        msg: info.msg || '',
        date: info.date || null,
        mode: 'tarball',
        updatedAt: Date.now(),
      },
      null,
      2
    ),
    'utf8'
  );
}

function readPkgVersion(cwd = process.cwd()) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    return pkg.version || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

function isHexSha(str) {
  return /^[0-9a-f]{7,40}$/i.test(String(str || '').trim());
}

/**
 * 获取当前本地版本信息（纯免 Git 模式：优先读取 data/.version.json）
 */
function getCurrentVersion(cwd = process.cwd()) {
  const recorded = readRecordedVersion(cwd);
  if (recorded) return recorded;

  const seedSha = readSeedShaFromDotGit(cwd);
  if (seedSha) {
    return {
      sha: seedSha,
      msg: '免 Git 压缩包模式',
      date: null,
      ok: true,
      mode: 'tarball',
    };
  }

  const pkgVer = readPkgVersion(cwd);
  return {
    sha: `v${pkgVer}`,
    msg: '免 Git 压缩包模式（尚未记录提交号）',
    date: null,
    ok: true,
    mode: 'tarball',
    isUninitialized: true,
  };
}

function buildGithubHeaders() {
  const headers = {
    'User-Agent': 'stream-to-rtmp-updater',
    Accept: 'application/vnd.github+json',
  };
  const ghToken = process.env.GITHUB_TOKEN || process.env.GIST_TOKEN;
  if (ghToken && String(ghToken).trim()) {
    headers.Authorization = `Bearer ${String(ghToken).trim()}`;
  }
  return headers;
}

async function fetchJsonWithTimeout(url, { timeout = 20000, fetchImpl = global.fetch } = {}) {
  const res = await fetchImpl(url, {
    headers: buildGithubHeaders(),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`GitHub API HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 120)}` : ''}`);
  }
  return res.json();
}

/**
 * 检查更新（纯免 Git HTTP 模式：直接请求 GitHub Commits / Compare API）
 */
async function checkUpdateViaHttp({
  repo,
  branch = DEFAULT_BRANCH,
  timeout = 20000,
  cwd = process.cwd(),
  fetchImpl = global.fetch,
  localVersion = getCurrentVersion(cwd),
} = {}) {
  const repoSlug = repo || detectRepoSlug(cwd);
  const headData = await fetchJsonWithTimeout(
    `https://api.github.com/repos/${repoSlug}/commits/${encodeURIComponent(branch)}`,
    { timeout, fetchImpl }
  );

  const remoteFullSha = String(headData?.sha || '').trim();
  const remoteSha = remoteFullSha.slice(0, 7);
  const remoteMsg = String(headData?.commit?.message || '').split('\n')[0].trim();
  const remoteDate = headData?.commit?.committer?.date || headData?.commit?.author?.date || null;

  if (!remoteSha) {
    throw new Error('无法从 GitHub API 解析最新提交版本号');
  }

  const localSha = localVersion.sha;
  if (!localVersion.isUninitialized && isHexSha(localSha)) {
    if (localSha.toLowerCase() === remoteSha.toLowerCase() || remoteFullSha.toLowerCase().startsWith(localSha.toLowerCase())) {
      return {
        ok: true,
        mode: 'tarball',
        repo: repoSlug,
        branch,
        hasUpdate: false,
        localSha,
        remoteSha,
        remoteMsg,
        remoteDate,
        commitsBehind: 0,
        commitLogs: [],
        hasPackageJsonChange: false,
      };
    }

    try {
      const compare = await fetchJsonWithTimeout(
        `https://api.github.com/repos/${repoSlug}/compare/${encodeURIComponent(localSha)}...${encodeURIComponent(branch)}`,
        { timeout, fetchImpl }
      );
      const commits = Array.isArray(compare?.commits) ? compare.commits : [];
      const commitsBehind = Number(compare?.ahead_by || commits.length || 0);
      const commitLogs = commits
        .slice(-5)
        .reverse()
        .map((c) => `${String(c.sha || '').slice(0, 7)} ${String(c.commit?.message || '').split('\n')[0].trim()}`);
      const changedFiles = Array.isArray(compare?.files) ? compare.files.map((f) => f.filename) : [];
      const hasPackageJsonChange = changedFiles.includes('package.json');

      return {
        ok: true,
        mode: 'tarball',
        repo: repoSlug,
        branch,
        hasUpdate: commitsBehind > 0 || localSha !== remoteSha,
        localSha,
        remoteSha,
        remoteMsg,
        remoteDate,
        commitsBehind: commitsBehind || 1,
        commitLogs: commitLogs.length ? commitLogs : [`${remoteSha} ${remoteMsg}`],
        hasPackageJsonChange,
      };
    } catch {
      // compare API 失败时仍可降级展示最新单条提交
    }
  }

  return {
    ok: true,
    mode: 'tarball',
    repo: repoSlug,
    branch,
    hasUpdate: true,
    localSha,
    remoteSha,
    remoteMsg,
    remoteDate,
    commitsBehind: 1,
    commitLogs: [`${remoteSha} ${remoteMsg || '同步 GitHub 最新版本'}`],
    hasPackageJsonChange: true,
    firstSync: Boolean(localVersion.isUninitialized),
  };
}

/**
 * 检查远程是否有新提交（仅免 Git 压缩包模式，不依赖 git）
 */
async function checkUpdate({
  branch = DEFAULT_BRANCH,
  repo = null,
  timeout = 25000,
  cwd = process.cwd(),
  fetchImpl = global.fetch,
} = {}) {
  try {
    const current = getCurrentVersion(cwd);
    return await checkUpdateViaHttp({ repo, branch, timeout, cwd, fetchImpl, localVersion: current });
  } catch (err) {
    return { ok: false, error: `检查更新失败: ${err.message}` };
  }
}

function restoreScriptPermissions(cwd) {
  const scriptsDir = path.join(cwd, 'scripts');
  if (!fs.existsSync(scriptsDir)) return;
  try {
    for (const name of fs.readdirSync(scriptsDir)) {
      if (name.endsWith('.sh')) {
        fs.chmodSync(path.join(scriptsDir, name), 0o755);
      }
    }
  } catch {}
}

function readDepsSignature(cwd) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    return JSON.stringify(pkg.dependencies || {});
  } catch {
    return '';
  }
}

async function runIncrementalNpmInstall(cwd, onProgress) {
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  onProgress('检测到依赖包更新，正在轻量增量安装...');
  await execFileAsync(npmBin, ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd,
    env: buildExecEnv(),
    timeout: 120000,
  });
}

function copyTreeFiltered(srcDir, dstDir) {
  fs.cpSync(srcDir, dstDir, { recursive: true, force: true });
}

function writeUpdateStateFile(cwd, payload) {
  const statePath = getStateFilePath(cwd);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(payload, null, 2), 'utf8');
}

/**
 * 免 Git 压缩包更新：直接下载 GitHub tar.gz 压缩包，备份旧代码，安全覆盖（保留 .env/data/bin/node_modules），
 * 按需增量安装依赖并执行 node --check 语法校验，失败自动回滚。
 */
async function applyUpdateViaTarball({
  repo = null,
  branch = DEFAULT_BRANCH,
  timeout = 60000,
  cwd = process.cwd(),
  notifyChatId = null,
  onProgress = () => {},
  fetchImpl = global.fetch,
  tarballUrlOverride = null,
  targetVersionInfo = null,
} = {}) {
  const repoSlug = repo || detectRepoSlug(cwd);
  const current = getCurrentVersion(cwd);
  const oldSha = current.sha;
  const oldDepsSig = readDepsSignature(cwd);

  let targetMeta = targetVersionInfo;
  if (!targetMeta) {
    onProgress('正在查询 GitHub 最新版本信息...');
    const check = await checkUpdateViaHttp({ repo: repoSlug, branch, timeout: 20000, cwd, fetchImpl, localVersion: current });
    targetMeta = {
      sha: check.remoteSha,
      msg: check.remoteMsg || '',
      date: check.remoteDate || null,
    };
  }

  const tmpRoot = path.join(cwd, 'data', '.update-tmp');
  const backupRoot = path.join(cwd, 'data', '.update-backup');
  const tarPath = path.join(tmpRoot, 'source.tar.gz');
  const extractDir = path.join(tmpRoot, 'extracted');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(backupRoot, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  fs.mkdirSync(backupRoot, { recursive: true });

  const appliedEntries = [];
  const backedUpEntries = [];

  try {
    const tarballUrl =
      tarballUrlOverride ||
      `https://codeload.github.com/${repoSlug}/tar.gz/refs/heads/${encodeURIComponent(branch)}`;

    onProgress('正在下载 GitHub 最新源码压缩包...');
    const res = await fetchImpl(tarballUrl, {
      headers: {
        'User-Agent': 'stream-to-rtmp-updater',
        ...(process.env.GITHUB_TOKEN || process.env.GIST_TOKEN
          ? { Authorization: `Bearer ${String(process.env.GITHUB_TOKEN || process.env.GIST_TOKEN).trim()}` }
          : {}),
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) {
      throw new Error(`下载更新包失败: HTTP ${res.status}`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) {
      throw new Error(`更新包体积异常 (${buf.length} bytes)，已中止更新`);
    }
    fs.writeFileSync(tarPath, buf);

    onProgress('正在解压源码包...');
    await execFileAsync('tar', ['-xzf', tarPath, '-C', extractDir], {
      cwd,
      env: buildExecEnv(),
      timeout: 30000,
    });

    const topEntries = fs.readdirSync(extractDir).filter((name) => !name.startsWith('.'));
    if (topEntries.length === 0) {
      throw new Error('压缩包解压为空目录');
    }
    const sourceRoot =
      topEntries.length === 1 && fs.statSync(path.join(extractDir, topEntries[0])).isDirectory()
        ? path.join(extractDir, topEntries[0])
        : extractDir;

    if (!fs.existsSync(path.join(sourceRoot, 'main.js')) || !fs.existsSync(path.join(sourceRoot, 'package.json'))) {
      throw new Error('更新包内容校验失败：缺少 main.js 或 package.json');
    }

    onProgress('正在备份当前代码并安全覆盖更新...');
    const newRootEntries = fs.readdirSync(sourceRoot).filter((name) => !PRESERVED_ROOT_ENTRIES.has(name));

    // 先备份将被替换的现有代码项（用于语法校验失败时无损回滚）
    for (const entry of newRootEntries) {
      const dstPath = path.join(cwd, entry);
      if (fs.existsSync(dstPath)) {
        copyTreeFiltered(dstPath, path.join(backupRoot, entry));
        backedUpEntries.push(entry);
      }
    }

    // 替换覆盖代码文件，跳过所有受保护的运行时目录/配置
    for (const entry of newRootEntries) {
      const srcPath = path.join(sourceRoot, entry);
      const dstPath = path.join(cwd, entry);
      const srcStat = fs.statSync(srcPath);
      if (srcStat.isDirectory()) {
        fs.rmSync(dstPath, { recursive: true, force: true });
      }
      copyTreeFiltered(srcPath, dstPath);
      appliedEntries.push(entry);
    }

    restoreScriptPermissions(cwd);

    // 检测 package.json 依赖是否变更
    const newDepsSig = readDepsSignature(cwd);
    if (oldDepsSig && newDepsSig && oldDepsSig !== newDepsSig) {
      try {
        await runIncrementalNpmInstall(cwd, onProgress);
      } catch (err) {
        console.warn('[updater] 依赖安装警告:', err.message);
      }
    }

    // 使用当前运行中的 Node 解释器做防崩语法自检
    onProgress('正在执行代码语法防崩校验...');
    try {
      await execFileAsync(process.execPath, ['--check', 'main.js'], {
        cwd,
        env: buildExecEnv(),
        timeout: 10000,
      });
    } catch (checkErr) {
      console.error('[updater] 语法自检失败，正在从本地备份紧急回滚...');
      for (const entry of appliedEntries) {
        fs.rmSync(path.join(cwd, entry), { recursive: true, force: true });
      }
      for (const entry of backedUpEntries) {
        copyTreeFiltered(path.join(backupRoot, entry), path.join(cwd, entry));
      }
      restoreScriptPermissions(cwd);
      throw new Error(`更新代码语法校验失败，已自动回滚至 ${oldSha}: ${checkErr.message}`);
    }

    const newSha = targetMeta.sha || 'latest';
    writeRecordedVersion(cwd, {
      sha: newSha,
      msg: targetMeta.msg,
      date: targetMeta.date,
    });

    try {
      writeUpdateStateFile(cwd, {
        updatedAt: Date.now(),
        fromSha: oldSha,
        toSha: newSha,
        mode: 'tarball',
        notifyChatId,
        success: true,
      });
    } catch (err) {
      console.warn('[updater] 记录更新状态失败:', err.message);
    }

    return {
      success: true,
      mode: 'tarball',
      fromSha: oldSha,
      toSha: newSha,
    };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(backupRoot, { recursive: true, force: true });
  }
}

/**
 * 执行代码更新（统一免 Git 压缩包模式）
 */
async function applyUpdate(options = {}) {
  return applyUpdateViaTarball(options);
}

/**
 * 消费并清除更新完成状态文件（用于重启后向用户发送通知）
 */
function consumeUpdateState(cwd = process.cwd()) {
  const statePath = getStateFilePath(cwd);
  if (!fs.existsSync(statePath)) return null;
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    fs.unlinkSync(statePath);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

module.exports = {
  getCurrentVersion,
  checkUpdate,
  checkUpdateViaHttp,
  applyUpdate,
  applyUpdateViaTarball,
  consumeUpdateState,
  STATE_FILE,
  PRESERVED_ROOT_ENTRIES,
};
