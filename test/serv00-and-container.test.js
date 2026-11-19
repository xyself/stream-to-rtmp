const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const runtimeEnv = require('../src/core/runtime-env');
const ffmpegInstaller = require('../src/services/ffmpeg-installer');
const housekeeping = require('../src/core/housekeeping');
const { createApp } = require('../main');

test('runtimeEnv detects Serv00/FreeBSD, Docker Debian, and Docker Alpine profiles with safe defaults', () => {
  const serv00 = runtimeEnv.getRuntimeProfile({
    platform: 'freebsd',
    arch: 'x64',
    env: { HOME: '/usr/home/testuser' },
    existsFn: (p) => p === '/usr/local/bin/devil',
    readFileFn: () => null,
  });
  assert.equal(serv00.kind, 'serv00');
  assert.equal(serv00.isServ00, true);
  assert.equal(serv00.isFreeBSD, true);
  assert.equal(serv00.defaultMemAlertMb, 384);
  assert.equal(serv00.defaultCriticalMemMb, 448);
  assert.equal(serv00.recommendedFfmpegThreads, 2);

  const alpine = runtimeEnv.getRuntimeProfile({
    platform: 'linux',
    arch: 'x64',
    env: {},
    existsFn: (p) => p === '/.dockerenv' || p === '/etc/alpine-release',
    readFileFn: () => null,
  });
  assert.equal(alpine.kind, 'docker-alpine');
  assert.equal(alpine.isContainer, true);
  assert.equal(alpine.isMusl, true);

  const debianDocker = runtimeEnv.getRuntimeProfile({
    platform: 'linux',
    arch: 'x64',
    env: {},
    existsFn: (p) => p === '/.dockerenv',
    readFileFn: () => null,
    getReport: () => ({ header: { glibcVersionRuntime: '2.36' } }),
  });
  assert.equal(debianDocker.kind, 'docker-linux');
  assert.equal(debianDocker.isContainer, true);
  assert.equal(debianDocker.isMusl, false);
});

test('getCgroupMemoryStats parses cgroup v2/v1 container limits and ignores unlimited sentinels', () => {
  const v2 = runtimeEnv.getCgroupMemoryStats({
    platform: 'linux',
    readFileFn: (p) => {
      if (p === '/sys/fs/cgroup/memory.max') return String(512 * 1024 * 1024);
      if (p === '/sys/fs/cgroup/memory.current') return String(256 * 1024 * 1024);
      return null;
    },
  });
  assert.equal(v2.version, 'v2');
  assert.equal(v2.limitMB, 512);
  assert.equal(v2.usedMB, 256);
  assert.equal(v2.usePct, 50);

  const v2Unlimited = runtimeEnv.getCgroupMemoryStats({
    platform: 'linux',
    readFileFn: (p) => {
      if (p === '/sys/fs/cgroup/memory.max') return 'max';
      if (p === '/sys/fs/cgroup/memory.current') return '104857600';
      return null;
    },
  });
  assert.equal(v2Unlimited, null);

  const memStats = housekeeping.getMemoryStats({ cgroupStats: v2 });
  assert.equal(memStats.source, 'cgroup-v2');
  assert.equal(memStats.limitMB, 512);
  assert.equal(memStats.sysUsePct, 50);
});

test('ffmpegInstaller skips glibc downloads on Alpine/musl and FreeBSD/Serv00 unless custom URL is given', () => {
  const muslDefault = ffmpegInstaller.getStaticDownloadCandidates('linux', 'x64', '', true, true);
  assert.deepEqual(muslDefault, [], 'Alpine/musl must not download glibc static FFmpeg builds');

  const muslCustom = ffmpegInstaller.getStaticDownloadCandidates(
    'linux',
    'x64',
    'https://mirror.example.com/ffmpeg-musl.gz',
    true,
    true
  );
  assert.equal(muslCustom.length, 1);

  const freebsdDefault = ffmpegInstaller.getStaticDownloadCandidates('freebsd', 'x64', '', true, false);
  assert.deepEqual(freebsdDefault, [], 'FreeBSD/Serv00 must not download Linux FFmpeg builds');

  const glibcLinux = ffmpegInstaller.getStaticDownloadCandidates('linux', 'x64', '', true, false);
  assert.ok(glibcLinux.some((c) => c.url.includes('BtbN/FFmpeg-Builds')), 'glibc Linux should prioritize BtbN official release');
});

test('main.js respects DISABLE_WEB=1 so Serv00 Telegram-only deployments never fail binding a port', async () => {
  const logs = [];
  const origDisableWeb = process.env.DISABLE_WEB;
  const origTgToken = process.env.TG_TOKEN;
  const origTgChat = process.env.TG_CHAT_ID;
  const origNodeEnv = process.env.NODE_ENV;

  process.env.DISABLE_WEB = '1';
  process.env.TG_TOKEN = '';
  process.env.TG_CHAT_ID = '';
  process.env.NODE_ENV = 'test';

  let startedScheduler = false;
  const fakeScheduler = {
    setOnNotify: () => {},
    start: () => {
      startedScheduler = true;
    },
    stopAll: async () => {},
    getStats: () => ({ activeStreams: 0, totalMonitoring: 0 }),
    getTrafficStats: () => [],
  };
  const fakeBot = {
    isConfigured: false,
    parseAllowedChatId: () => new Set(),
    isRunning: () => false,
    stop: async () => {},
  };
  const fakeDb = {
    getAllTasks: () => [],
    getSetting: () => null,
    close: () => {},
  };

  const app = createApp({
    scheduler: fakeScheduler,
    bot: fakeBot,
    db: fakeDb,
    logger: {
      log: (m) => logs.push(String(m)),
      warn: (m) => logs.push(String(m)),
      error: (m) => logs.push(String(m)),
    },
    processRef: { on: () => {}, exit: () => {} },
  });

  try {
    await app.bootstrap();
    assert.equal(startedScheduler, true);
    assert.ok(
      logs.some((line) => line.includes('Web 面板已禁用')),
      'Should cleanly disable Express HTTP server when DISABLE_WEB=1'
    );
  } finally {
    await app.gracefulShutdown('TEST', 0);
    if (origDisableWeb === undefined) delete process.env.DISABLE_WEB;
    else process.env.DISABLE_WEB = origDisableWeb;
    if (origTgToken === undefined) delete process.env.TG_TOKEN;
    else process.env.TG_TOKEN = origTgToken;
    if (origTgChat === undefined) delete process.env.TG_CHAT_ID;
    else process.env.TG_CHAT_ID = origTgChat;
    if (origNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origNodeEnv;
  }
});

test('Serv00 shell scripts pass POSIX sh -n syntax validation', () => {
  for (const script of ['scripts/auto-start.sh', 'scripts/deploy-serv00.sh']) {
    const abs = path.join(__dirname, '..', script);
    const res = spawnSync('sh', ['-n', abs], { encoding: 'utf8' });
    assert.equal(res.status, 0, `${script} syntax error: ${res.stderr}`);
  }
});

test('runtimeEnv.parseDevilLimits correctly extracts disk, RAM, CPU, and process quota', () => {
  const sampleOutput = `
Resources utilization

       Disk quota: [\x1b[1;32m=====================================\x1b[0m] 1.59% (48.8M/3.0G)
        Processes: [\x1b[1;32m=====================================\x1b[0m] 35.00% (7/20)
       RAM memory: [\x1b[1;32m=====================================\x1b[0m] 32.62% (167.0M/512.0M)
              CPU: [\x1b[1;32m=====================================\x1b[0m] 0.50% (0.5/100)
       Mails sent: [=====================================] 0.00% (0/500)
  `;

  const limits = runtimeEnv.parseDevilLimits(sampleOutput);
  assert.ok(limits);
  assert.equal(limits.disk.usePct, 1.59);
  assert.equal(limits.disk.usedMB, 49);
  assert.equal(limits.disk.limitMB, 3072);
  assert.equal(limits.memory.usePct, 33);
  assert.equal(limits.memory.usedMB, 167);
  assert.equal(limits.memory.limitMB, 512);
  assert.equal(limits.processes.used, 7);
  assert.equal(limits.processes.limit, 20);
  assert.equal(limits.cpu.usePct, 0.5);

  const memStats = housekeeping.getMemoryStats({ serv00Limits: limits });
  assert.equal(memStats.source, 'serv00');
  assert.equal(memStats.limitMB, 512);
  assert.equal(memStats.usedMB, 167);
  assert.equal(memStats.sysUsePct, 33);

  const diskStats = housekeeping.getDiskStats(process.cwd(), { serv00Limits: limits });
  assert.equal(diskStats.source, 'serv00');
  assert.equal(diskStats.limitMB, 3072);
  assert.equal(diskStats.usePct, 2);

  const cpuPct = housekeeping.getSystemCpuPct({ serv00Limits: limits });
  assert.equal(cpuPct, 0.5);
});

test('runtimeEnv detects Serv00 with /bin/devil and /home/user path', () => {
  const serv00 = runtimeEnv.getRuntimeProfile({
    platform: 'freebsd',
    arch: 'x64',
    env: { HOME: '/home/chengua' },
    existsFn: (p) => p === '/bin/devil',
    readFileFn: () => null,
  });
  assert.equal(serv00.kind, 'serv00');
  assert.equal(serv00.isServ00, true);
});

test('views.renderDashboard accurately formats Serv00 quotas and suppresses fake errors', () => {
  const views = require('../src/bot/views');
  const rendered = views.renderDashboard({
    system: {
      uptime: '15m 30s',
      runtimeLabel: 'Serv00 FreeBSD',
      nodeVersion: 'v26.12.1',
      cpuPercent: 0.5,
      cpuBar: '░░░░░░░░░░',
      cpuLabel: 'Serv00 配额',
      memUsed: '168.00 MB',
      memTotal: '512.00 MB',
      memPct: 33,
      memLabel: 'Serv00 配额 512MB',
      disk: {
        used: '49.00 MB',
        total: '3.00 GB',
        pct: 2,
        label: 'Serv00 配额 3.0GB',
      },
      processes: {
        used: 7,
        limit: 20,
        pct: 35,
      },
      serviceMem: '102.50 MB',
      heapUsed: '16.20 MB',
      ffmpegVersion: '6.1.2',
    },
    stats: {
      totalTasks: 4,
      enabledTasks: 3,
      disabledTasks: 1,
      activeStreams: 0,
      totalMonitoring: 3,
      totalTargets: 4,
    },
    recentErrors: [],
  });

  assert.ok(rendered.includes('Serv00 FreeBSD · Node v26.12.1'));
  assert.ok(rendered.includes('CPU：[░░░░░░░░░░] 0.5% (Serv00 配额)'));
  assert.ok(rendered.includes('RAM：168.00 MB / 512.00 MB (33% · Serv00 配额 512MB)'));
  assert.ok(rendered.includes('DISK：49.00 MB / 3.00 GB (2% · Serv00 配额 3.0GB)'));
  assert.ok(rendered.includes('PROC：7 / 20 进程 (35% · 限额 20)'));
  assert.ok(rendered.includes('SVC：服务占用 102.50 MB (V8堆 16.20 MB)'));
  assert.ok(rendered.includes('🟢 <b>状态诊断</b>：全链路正常运行，无错误告警'));
  assert.ok(!rendered.includes('⚠️ 最近警告'));
});

test('bot.getSystemInfo and getRecentErrors correctly handle Serv00 quota and filter STREAM_ENDED', () => {
  const bot = require('../src/bot');
  const mockLimits = {
    disk: { usePct: 1.59, usedMB: 49, limitMB: 3072, raw: '49.0M/3.0G' },
    memory: { usePct: 33, usedMB: 168, limitMB: 512, raw: '168.0M/512.0M' },
    processes: { usePct: 35, used: 7, limit: 20 },
    cpu: { usePct: 0.5 },
  };

  const sys = bot.getSystemInfo({
    memStats: housekeeping.getMemoryStats({ serv00Limits: mockLimits }),
    cpuPercent: 0.5,
    diskStats: housekeeping.getDiskStats(process.cwd(), { serv00Limits: mockLimits }),
    runtime: { isServ00: true, isFreeBSD: true },
  });

  assert.equal(sys.runtimeLabel, 'Serv00 FreeBSD');
  assert.equal(sys.memTotal, '512.00 MB');
  assert.equal(sys.memUsed, '168.00 MB');
  assert.equal(sys.memPct, 33);
  assert.equal(sys.memLabel, 'Serv00 配额 512MB');
  assert.equal(sys.disk.total, '3.00 GB');
  assert.equal(sys.processes.limit, 20);
  assert.equal(sys.processes.used, 7);

  // 验证 STREAM_ENDED 被过滤
  const views = require('../src/bot/views');
  const db = require('../src/db');
  db.getAllTasks = () => [
    { platform: 'bilibili', room_id: '123', last_error: 'STREAM_ENDED' },
    { platform: 'douyu', room_id: '456', last_error: 'OFFLINE' },
    { platform: 'douyin', room_id: '789', last_error: 'FFMPEG_CRASH' },
  ];
  const errors = bot.getRecentErrors();
  assert.deepEqual(errors, ['[抖音 #789] FFMPEG_CRASH']);
});
