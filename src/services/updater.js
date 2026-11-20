const { execFile, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const STATE_FILE = path.join(process.cwd(), 'data', 'update-state.json');

/**
 * 获取当前 Git 仓库的本地版本信息
 */
function getCurrentVersion(cwd = process.cwd()) {
  try {
    const sha = execSync('git rev-parse --short HEAD', { cwd, encoding: 'utf8', timeout: 5000 }).trim();
    const msg = execSync('git log -1 --format=%s', { cwd, encoding: 'utf8', timeout: 5000 }).trim();
    const date = execSync('git log -1 --format=%cI', { cwd, encoding: 'utf8', timeout: 5000 }).trim();
    return { sha, msg, date, ok: true };
  } catch {
    return { sha: '未知', msg: '无法读取 Git 版本', date: null, ok: false };
  }
}

/**
 * 检查远程是否有新提交
 */
async function checkUpdate({ remote = 'origin', branch = 'main', timeout = 15000, cwd = process.cwd() } = {}) {
  const current = getCurrentVersion(cwd);
  if (!current.ok) {
    return { ok: false, error: '当前环境不是有效的 Git 仓库' };
  }

  try {
    await execFileAsync('git', ['fetch', remote, branch], { cwd, timeout });

    const localSha = current.sha;
    const { stdout: remoteShaOut } = await execFileAsync('git', ['rev-parse', '--short', `${remote}/${branch}`], { cwd, timeout: 5000 });
    const remoteSha = remoteShaOut.trim();

    if (localSha === remoteSha) {
      return {
        ok: true,
        hasUpdate: false,
        localSha,
        remoteSha,
        commitsBehind: 0,
        commitLogs: [],
        hasPackageJsonChange: false,
      };
    }

    const { stdout: countOut } = await execFileAsync('git', ['rev-list', '--count', `HEAD..${remote}/${branch}`], { cwd, timeout: 5000 });
    const commitsBehind = parseInt(countOut.trim(), 10) || 0;

    const { stdout: logOut } = await execFileAsync('git', ['log', `HEAD..${remote}/${branch}`, '--oneline', '-n', '5'], { cwd, timeout: 5000 });
    const commitLogs = logOut.trim().split('\n').filter(Boolean);

    const { stdout: diffOut } = await execFileAsync('git', ['diff', `HEAD..${remote}/${branch}`, '--name-only'], { cwd, timeout: 5000 });
    const changedFiles = diffOut.trim().split('\n').filter(Boolean);
    const hasPackageJsonChange = changedFiles.includes('package.json');

    return {
      ok: true,
      hasUpdate: commitsBehind > 0 || localSha !== remoteSha,
      localSha,
      remoteSha,
      commitsBehind,
      commitLogs,
      hasPackageJsonChange,
    };
  } catch (err) {
    return { ok: false, error: `检查更新失败: ${err.message}` };
  }
}

/**
 * 执行代码拉取、依赖按需安装及语法校验
 */
async function applyUpdate({ remote = 'origin', branch = 'main', timeout = 60000, cwd = process.cwd(), notifyChatId = null, onProgress = () => {} } = {}) {
  const current = getCurrentVersion(cwd);
  const oldSha = current.sha;

  onProgress('正在拉取最新代码...');
  // 1. 安全拉取
  await execFileAsync('git', ['pull', remote, branch], { cwd, timeout });

  const newCurrent = getCurrentVersion(cwd);
  const newSha = newCurrent.sha;

  // 2. 检测 package.json 是否变动
  try {
    const { stdout: pkgDiff } = await execFileAsync('git', ['diff', oldSha, newSha, '--name-only', 'package.json'], { cwd, timeout: 5000 });
    if (pkgDiff.trim() === 'package.json') {
      onProgress('检测到依赖包更新，正在轻量增量安装...');
      await execFileAsync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd, timeout: 90000 });
    }
  } catch (err) {
    console.warn('[updater] 依赖安装警告:', err.message);
  }

  // 3. 语法防崩自检
  onProgress('正在执行代码语法防崩校验...');
  try {
    await execFileAsync('node', ['--check', 'main.js'], { cwd, timeout: 10000 });
  } catch (checkErr) {
    console.error('[updater] 语法自检失败，正在紧急回滚至旧版本:', oldSha);
    await execFileAsync('git', ['reset', '--hard', oldSha], { cwd, timeout: 10000 }).catch(() => {});
    throw new Error(`更新代码语法校验失败，已自动回滚至 ${oldSha}: ${checkErr.message}`);
  }

  // 4. 写入状态标记供重启后通知
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({
        updatedAt: Date.now(),
        fromSha: oldSha,
        toSha: newSha,
        notifyChatId,
        success: true,
      }, null, 2),
      'utf8'
    );
  } catch (err) {
    console.warn('[updater] 记录更新状态失败:', err.message);
  }

  return {
    success: true,
    fromSha: oldSha,
    toSha: newSha,
  };
}

/**
 * 消费并清除更新完成状态文件（用于重启后向用户发送通知）
 */
function consumeUpdateState() {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    fs.unlinkSync(STATE_FILE);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

module.exports = {
  getCurrentVersion,
  checkUpdate,
  applyUpdate,
  consumeUpdateState,
  STATE_FILE,
};
