const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const updater = require('../src/services/updater');
const views = require('../src/bot/views');
const bot = require('../src/bot');

test('updater.getCurrentVersion returns valid short SHA in tarball-only mode', () => {
  const ver = updater.getCurrentVersion();
  assert.equal(ver.ok, true);
  assert.equal(ver.mode, 'tarball');
  assert.ok(typeof ver.sha === 'string' && ver.sha.length >= 7);
  assert.ok(typeof ver.msg === 'string' && ver.msg.length > 0);
});

test('updater.consumeUpdateState reads and deletes state file cleanly', () => {
  const testState = {
    updatedAt: Date.now(),
    fromSha: 'aaaaaaa',
    toSha: 'bbbbbbb',
    notifyChatId: 12345678,
    success: true,
  };

  fs.mkdirSync(path.dirname(updater.STATE_FILE), { recursive: true });
  fs.writeFileSync(updater.STATE_FILE, JSON.stringify(testState), 'utf8');

  assert.equal(fs.existsSync(updater.STATE_FILE), true);
  const consumed = updater.consumeUpdateState();
  assert.ok(consumed);
  assert.equal(consumed.fromSha, 'aaaaaaa');
  assert.equal(consumed.toSha, 'bbbbbbb');
  assert.equal(consumed.notifyChatId, 12345678);

  // 验证已被消费删除
  assert.equal(fs.existsSync(updater.STATE_FILE), false);
  assert.equal(updater.consumeUpdateState(), null);
});

test('updater works without Git: checks GitHub HTTP API, applies tarball while preserving .env/data, and rolls back on broken syntax', async () => {
  const tmpWork = fs.mkdtempSync(path.join(os.tmpdir(), 'streamops-nogit-'));
  const tmpPkg = fs.mkdtempSync(path.join(os.tmpdir(), 'streamops-tar-'));
  try {
    // 1. 模拟没有 .git 目录的环境（如 Docker / Zip 解压部署）
    fs.mkdirSync(path.join(tmpWork, 'data'), { recursive: true });
    fs.mkdirSync(path.join(tmpWork, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpWork, '.env'), 'TG_TOKEN=keep_me_secret\n', 'utf8');
    fs.writeFileSync(path.join(tmpWork, 'data', 'data.db'), 'sqlite-bytes', 'utf8');
    fs.writeFileSync(path.join(tmpWork, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', dependencies: { dotenv: '^17.0.0' } }), 'utf8');
    fs.writeFileSync(path.join(tmpWork, 'main.js'), 'const ver = 1; module.exports = ver;\n', 'utf8');
    fs.writeFileSync(path.join(tmpWork, 'src', 'hello.js'), 'module.exports = "v1";\n', 'utf8');

    const initVer = updater.getCurrentVersion(tmpWork);
    assert.equal(initVer.ok, true);
    assert.equal(initVer.mode, 'tarball');
    assert.equal(initVer.isUninitialized, true);

    // 2. Mock GitHub API 检查更新
    const mockFetchApi = async (url) => {
      if (String(url).includes('/commits/main')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sha: '1234567890abcdef1234567890abcdef12345678',
            commit: { message: 'feat: zero-git release\nbody', committer: { date: '2026-11-20T00:00:00Z' } },
          }),
        };
      }
      if (String(url).includes('/compare/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ahead_by: 2,
            commits: [
              { sha: 'aaaa111222', commit: { message: 'fix: step 1' } },
              { sha: '1234567890', commit: { message: 'feat: zero-git release' } },
            ],
            files: [{ filename: 'main.js' }],
          }),
        };
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const checkRes = await updater.checkUpdate({ cwd: tmpWork, repo: 'xyself/stream-to-rtmp', fetchImpl: mockFetchApi });
    assert.equal(checkRes.ok, true);
    assert.equal(checkRes.mode, 'tarball');
    assert.equal(checkRes.hasUpdate, true);
    assert.equal(checkRes.remoteSha, '1234567');

    // 3. 构造合法的新版源码 tar.gz 并执行免 Git 更新
    const goodRoot = path.join(tmpPkg, 'stream-to-rtmp-main');
    fs.mkdirSync(path.join(goodRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(goodRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(goodRoot, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', dependencies: { dotenv: '^17.0.0' } }), 'utf8');
    fs.writeFileSync(path.join(goodRoot, 'main.js'), 'const ver = 2; module.exports = ver;\n', 'utf8');
    fs.writeFileSync(path.join(goodRoot, 'src', 'hello.js'), 'module.exports = "v2";\n', 'utf8');
    fs.writeFileSync(path.join(goodRoot, 'scripts', 'auto-start.sh'), '#!/bin/sh\necho ok\n', 'utf8');
    // 刻意在包里塞一个 .env，验证不会被覆盖
    fs.writeFileSync(path.join(goodRoot, '.env'), 'TG_TOKEN=MUST_NOT_OVERWRITE\n', 'utf8');
    // 确保压缩后包体积 > 1024 字节
    fs.writeFileSync(path.join(goodRoot, 'README.md'), crypto.randomBytes(2048).toString('hex'), 'utf8');

    const goodTar = path.join(tmpPkg, 'good.tar.gz');
    execFileSync('tar', ['-czf', goodTar, '-C', tmpPkg, 'stream-to-rtmp-main']);
    const goodTarBuf = fs.readFileSync(goodTar);

    const mockFetchGoodTar = async (url) => {
      if (String(url).includes('tar.gz')) {
        return { ok: true, status: 200, arrayBuffer: async () => goodTarBuf };
      }
      return mockFetchApi(url);
    };

    const applyRes = await updater.applyUpdate({
      cwd: tmpWork,
      repo: 'xyself/stream-to-rtmp',
      fetchImpl: mockFetchGoodTar,
    });
    assert.equal(applyRes.success, true);
    assert.equal(applyRes.mode, 'tarball');
    assert.equal(applyRes.toSha, '1234567');

    // 验证新代码生效且 .env / data.db 完好无损
    assert.equal(fs.readFileSync(path.join(tmpWork, 'main.js'), 'utf8').includes('ver = 2'), true);
    assert.equal(fs.readFileSync(path.join(tmpWork, 'src', 'hello.js'), 'utf8').includes('"v2"'), true);
    assert.equal(fs.readFileSync(path.join(tmpWork, '.env'), 'utf8'), 'TG_TOKEN=keep_me_secret\n');
    assert.equal(fs.readFileSync(path.join(tmpWork, 'data', 'data.db'), 'utf8'), 'sqlite-bytes');

    // 验证版本已持久化到 data/.version.json，二次检查显示已是最新
    const afterVer = updater.getCurrentVersion(tmpWork);
    assert.equal(afterVer.sha, '1234567');
    const recheck = await updater.checkUpdate({ cwd: tmpWork, repo: 'xyself/stream-to-rtmp', fetchImpl: mockFetchApi });
    assert.equal(recheck.ok, true);
    assert.equal(recheck.hasUpdate, false);

    // 验证状态文件可被消费
    const consumed = updater.consumeUpdateState(tmpWork);
    assert.equal(consumed?.toSha, '1234567');

    // 4. 构造语法损坏的 tar.gz，验证自动回滚至 v2
    const badRoot = path.join(tmpPkg, 'stream-to-rtmp-bad');
    fs.mkdirSync(path.join(badRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(badRoot, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', dependencies: { dotenv: '^17.0.0' } }), 'utf8');
    fs.writeFileSync(path.join(badRoot, 'main.js'), 'const broken = (((;\n', 'utf8');
    fs.writeFileSync(path.join(badRoot, 'src', 'hello.js'), 'module.exports = "v3-bad";\n', 'utf8');
    fs.writeFileSync(path.join(badRoot, 'README.md'), crypto.randomBytes(2048).toString('hex'), 'utf8');
    const badTar = path.join(tmpPkg, 'bad.tar.gz');
    execFileSync('tar', ['-czf', badTar, '-C', tmpPkg, 'stream-to-rtmp-bad']);
    const badTarBuf = fs.readFileSync(badTar);

    const mockFetchBadTar = async () => ({ ok: true, status: 200, arrayBuffer: async () => badTarBuf });
    await assert.rejects(
      () =>
        updater.applyUpdate({
          cwd: tmpWork,
          repo: 'xyself/stream-to-rtmp',
          fetchImpl: mockFetchBadTar,
          targetVersionInfo: { sha: 'deadbee', msg: 'broken commit', date: null },
        }),
      /语法校验失败，已自动回滚/
    );

    // 确认已自动回滚回 v2 且 .env 仍在
    assert.equal(fs.readFileSync(path.join(tmpWork, 'main.js'), 'utf8').includes('ver = 2'), true);
    assert.equal(fs.readFileSync(path.join(tmpWork, 'src', 'hello.js'), 'utf8').includes('"v2"'), true);
    assert.equal(fs.readFileSync(path.join(tmpWork, '.env'), 'utf8'), 'TG_TOKEN=keep_me_secret\n');
  } finally {
    fs.rmSync(tmpWork, { recursive: true, force: true });
    fs.rmSync(tmpPkg, { recursive: true, force: true });
  }
});

test('views.renderDashboard displays gitSha in environment line', () => {
  const rendered = views.renderDashboard({
    system: {
      uptime: '1h',
      runtimeLabel: 'Serv00 FreeBSD',
      nodeVersion: 'v26.12.1',
      gitSha: 'c83c92c',
      cpuPercent: 0.5,
      memUsed: '168 MB',
      memTotal: '512 MB',
    },
    stats: {},
    recentErrors: [],
  });

  assert.ok(rendered.includes('Serv00 FreeBSD · Node v26.12.1'));
  assert.ok(rendered.includes('c83c92c'));
});

test('bot.buildDashboardKeyboard includes global_check_update button', () => {
  const kb = bot.buildDashboardKeyboard();
  const rows = kb.inline_keyboard || [];
  const allButtons = rows.flat();
  const updateBtn = allButtons.find((b) => b.callback_data === 'global_check_update');
  assert.ok(updateBtn, 'Dashboard keyboard should have global_check_update button');
  assert.ok(updateBtn.text.includes('检查更新'));
});

