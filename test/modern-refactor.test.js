const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const StreamHealthMonitor = require('../src/core/health-monitor');
const { Logger, maskUrlInText } = require('../src/core/logger');
const { RelayEventBus, EVENTS } = require('../src/core/events');
const { parseDouyinRoomHtml } = require('../src/platforms/douyin/index');
const { getMemoryStats, getDiskUsePct, getZonedDateParts } = require('../src/core/housekeeping');
const platforms = require('../src/platforms');
const gistSync = require('../src/db/gist-sync');

test('Logger ring buffer captures, masks sensitive RTMP URLs, and filters errors', () => {
    const testLogger = new Logger({ maxEntries: 5, logFilePath: '/nonexistent/app.log' });
    testLogger.info('[System] Booting relay service');
    testLogger.error('[FFmpeg] Push failed to rtmp://live-push.bilivideo.com/live-bvc/?streamname=live_123456_secret');
    testLogger.warn('[Douyu] Rate limit warning');

    const allLines = testLogger.queryLines({ limit: 10, onlyErrors: false });
    assert.equal(allLines.length, 3);
    assert.ok(allLines[1].includes('rtmp://live-push.bilivideo.com/****'), 'RTMP secret key should be masked');
    assert.ok(!allLines[1].includes('live_123456_secret'), 'Raw RTMP stream key must not leak in logs');

    const errorLines = testLogger.queryLines({ limit: 10, onlyErrors: true });
    assert.equal(errorLines.length, 2); // ERROR + WARN
});

test('maskUrlInText masks embedded RTMP/HTTP credentials and stream keys', () => {
    const raw = 'ffmpeg -i https://example.com/live/room1.flv?token=abcdef -f flv rtmp://a.rtmp.youtube.com/live2/xxxx-yyyy-zzzz';
    const masked = maskUrlInText(raw);
    assert.ok(!masked.includes('xxxx-yyyy-zzzz'));
    assert.ok(!masked.includes('token=abcdef'));
    assert.ok(masked.includes('rtmp://a.rtmp.youtube.com/****'));
});

test('StreamHealthMonitor detects stream freeze, bitrate drop & recovery, and countdowns', () => {
    let clock = 10000;
    const monitor = new StreamHealthMonitor({
        healthConfig: {
            freezeGraceMs: 10000,
            freezeTicksThreshold: 3,
            bitrateDropGraceMs: 20000,
            bitrateDropRatio: 0.5,
            bitrateDropTicksThreshold: 2,
            failbackIntervalTicks: 2,
            blackCheckIntervalTicks: 2,
            liveVerifyIntervalMs: 50000
        },
        now: () => clock
    });

    // Establish peak bitrate of 3000 kbps
    const warmTick = monitor.evaluateTick({ runtimeMs: 30000, bitrateKbps: 3000, lastNotifyType: 'running' });
    assert.equal(warmTick.frozen, false);
    assert.equal(warmTick.bitrateDropAlert, null);

    // Drop bitrate below 50% (1000 kbps) for 2 ticks -> triggers bitrateDropAlert
    clock += 15000;
    const dropTick1 = monitor.evaluateTick({ runtimeMs: 45000, bitrateKbps: 1000, lastNotifyType: 'running' });
    assert.equal(dropTick1.bitrateDropAlert, null);
    assert.equal(dropTick1.shouldProbeFailback, true);
    assert.equal(dropTick1.shouldCheckBlackFrame, true);

    clock += 15000;
    const dropTick2 = monitor.evaluateTick({ runtimeMs: 60000, bitrateKbps: 900, lastNotifyType: 'running' });
    assert.ok(dropTick2.bitrateDropAlert && dropTick2.bitrateDropAlert.includes('码率大幅下跌'));

    // Recover bitrate -> triggers bitrateRecovered and calculates interrupt minutes
    clock += 65000;
    const recoverTick = monitor.evaluateTick({ runtimeMs: 125000, bitrateKbps: 2800, lastNotifyType: 'bitrate_drop' });
    assert.equal(recoverTick.bitrateRecovered, true);
    const mins = monitor.popRecoverMinutes('bitrate_drop');
    assert.ok(mins >= 1);

    // Freeze (0 kbps) for 3 ticks -> triggers frozen
    monitor.evaluateTick({ runtimeMs: 140000, bitrateKbps: 0, lastNotifyType: 'running' });
    monitor.evaluateTick({ runtimeMs: 155000, bitrateKbps: 0, lastNotifyType: 'running' });
    const freezeTick = monitor.evaluateTick({ runtimeMs: 170000, bitrateKbps: 0, lastNotifyType: 'running' });
    assert.equal(freezeTick.frozen, true);
});

test('parseDouyinRoomHtml extracts live status, host, title, and FLV/HLS stream regardless of JSON key order', () => {
    const sampleHtml = `
        <script>self.__pace_f.push([1,"{\\"room\\":{\\"title\\":\\"深夜测试直播间\\",\\"owner\\":{\\"nickname\\":\\"测试主播A\\"},\\"cover\\":{\\"url_list\\":[\\"http://p3.douyinpic.com/cover.jpg\\"]},\\"stream_url\\":{\\"flv_pull_url\\":{\\"FULL_HD1\\":\\"http://pull-flv-f11.douyincdn.com/stage/stream-123.flv\\"}},\\"status\\":2}}"])</script>
    `;

    const parsed = parseDouyinRoomHtml(sampleHtml);
    assert.ok(parsed);
    assert.equal(parsed.isLive, true);
    assert.equal(parsed.roomName, '深夜测试直播间');
    assert.equal(parsed.hostName, '测试主播A');
    assert.equal(parsed.cover, 'https://p3.douyinpic.com/cover.jpg');
    assert.equal(parsed.streamUrl, 'https://pull-flv-f11.douyincdn.com/stage/stream-123.flv');
});

test('platforms.create instantiates BaseRoom directly without redundant Room subclasses', () => {
    const room = platforms.create('bilibili', '1000');
    assert.equal(room.platform, 'bilibili');
    assert.equal(room.roomId, '1000');
    assert.equal(typeof room.getInfo, 'function');
    assert.equal(typeof room.getStreamUrl, 'function');
});

test('housekeeping native metrics return memory, disk usage, and timezone-aware date parts without shell exec', () => {
    const mem = getMemoryStats();
    assert.ok(mem.rssMB > 10, 'Node process RSS should be > 10 MB');
    assert.ok(mem.sysUsePct >= 0 && mem.sysUsePct <= 100, 'System memory usage percentage should be between 0 and 100');

    const diskPct = getDiskUsePct(process.cwd());
    assert.ok(diskPct >= 0 && diskPct <= 100, `Disk use percentage should be between 0 and 100, got ${diskPct}`);

    const parts = getZonedDateParts(new Date('2025-05-01T16:05:00Z').getTime(), 'Asia/Shanghai');
    assert.equal(parts.dateStr, '2025-5-2');
    assert.equal(parts.hour, 0);
    assert.equal(parts.minute, 5);
});

test('RelayEventBus safely publishes error and lifecycle events without throwing unhandled error', () => {
    const bus = new RelayEventBus();
    const received = [];
    bus.on(EVENTS.NOTIFY, (payload) => received.push(payload));
    // Publishing type: 'error' with no 'error' listener attached must not crash
    bus.publish({ taskId: 1, type: 'error', message: 'test error' });
    bus.publish({ taskId: 1, type: 'running', message: 'stream started' });
    assert.equal(received.length, 2);
    assert.equal(received[0].type, 'error');
    assert.equal(received[1].type, 'running');
});

test('gistSync.importRoomsIntoDb supports both v1 array and v2 { rooms, settings } payload with transaction', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamops-gist-'));
    const dbPath = path.join(tmpDir, 'rooms.db');
    const database = new DatabaseSync(dbPath);

    try {
        gistSync.importRoomsIntoDb(database, {
            version: 2,
            rooms: [
                { platform: 'bilibili', room_id: '777', status: 'ENABLED', targets: ['rtmp://localhost/live/777'] }
            ],
            settings: {
                transcode_video: '1'
            }
        });
        const tasks = database.prepare('SELECT platform, room_id, primary_target_url FROM tasks').all();
        assert.equal(tasks.length, 1);
        assert.equal(tasks[0].room_id, '777');
        const setting = database.prepare("SELECT value FROM settings WHERE key = 'transcode_video'").get();
        assert.equal(setting.value, '1');
    } finally {
        database.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('views.renderTaskDetail displays 2-in-1 room telemetry, streamer info, and full RTMP stream URLs', () => {
    const views = require('../src/bot/views');
    const html = views.renderTaskDetail({
        id: 1,
        platform: 'bilibili',
        room_id: '12345',
        status: 'ENABLED',
        traffic: {
            running: true,
            bitrateKbps: 3450,
            sessionBytes: 104857600,
            totalBytes: 524288000,
            startedAt: new Date(Date.now() - 1800 * 1000).toISOString(),
            roomInfo: { hostName: '测试主播X', roomName: '今晚冲分' }
        },
        targets: [
            { id: 10, target_url: 'rtmp://a.rtmp.youtube.com/live2/secret-key-9999' },
            { id: 11, target_url: 'rtmps://live-push.bilivideo.com/live-bvc/?streamname=live_secret_8888&extra=1' }
        ],
        last_error: null
    }, true);

    assert.ok(html.includes('测试主播X'));
    assert.ok(html.includes('今晚冲分'));
    assert.ok(html.includes('3450 kbps'));
    assert.ok(html.includes('rtmp://a.rtmp.youtube.com/live2/secret-key-9999'));
    assert.ok(html.includes('rtmps://live-push.bilivideo.com/live-bvc/?streamname=live_secret_8888&amp;extra=1'));
});

test('parseQuickAddInput parses single-message room link or platform+ID with one or more RTMP URLs', () => {
    const { parseQuickAddInput } = require('../src/bot/utils/parser');

    const fromLink = parseQuickAddInput('https://live.bilibili.com/2233 rtmp://a.rtmp.youtube.com/live2/k1 rtmps://backup.host/live/k2');
    assert.deepEqual(fromLink, {
        platform: 'bilibili',
        roomId: '2233',
        targetUrl: 'rtmp://a.rtmp.youtube.com/live2/k1',
        extraTargetUrls: ['rtmps://backup.host/live/k2']
    });

    const fromAlias = parseQuickAddInput('/addroom 抖音 889900 rtmp://push.example.com/live/main');
    assert.deepEqual(fromAlias, {
        platform: 'douyin',
        roomId: '889900',
        targetUrl: 'rtmp://push.example.com/live/main',
        extraTargetUrls: []
    });
});

test('buildTaskDetailKeyboard includes editrtmp, editcookie, curve, diagnose, transcode_mode, and del_confirm buttons, and buildDashboardKeyboard includes audio_fix, auto_backup, and curve buttons', () => {
    const { buildTaskDetailKeyboard, buildDashboardKeyboard } = require('../src/bot/index');
    const detailKb = buildTaskDetailKeyboard({ id: 42, status: 'ENABLED', cookie: 'SESSDATA=abc', transcode_mode: 'audio_fix' });
    const detailCallbacks = detailKb.inline_keyboard.flat().map((b) => b.callback_data);
    assert.ok(detailCallbacks.includes('editrtmp:42'), 'Should include editrtmp:42 button');
    assert.ok(detailCallbacks.includes('editcookie:42'), 'Should include editcookie:42 button');
    assert.ok(detailCallbacks.includes('curve:42:noon'), 'Should include curve:42:noon button');
    assert.ok(detailCallbacks.includes('diagnose:42'), 'Should include diagnose:42 button');
    assert.ok(detailCallbacks.includes('transcode_mode:42'), 'Should include transcode_mode:42 button');
    assert.ok(detailCallbacks.includes('del_confirm:42'), 'Should use del_confirm:42 for delete confirmation');

    const dashKb = buildDashboardKeyboard();
    const dashCallbacks = dashKb.inline_keyboard.flat().map((b) => b.callback_data);
    assert.ok(dashCallbacks.includes('global_export_backup'), 'Should include global_export_backup button');
    assert.ok(dashCallbacks.includes('global_import_backup'), 'Should include global_import_backup button');
    assert.ok(dashCallbacks.includes('global_set_restart_hour'), 'Should include global_set_restart_hour button');
    assert.ok(dashCallbacks.includes('global_toggle_audio_fix'), 'Should include global_toggle_audio_fix button');
    assert.ok(dashCallbacks.includes('global_toggle_auto_backup'), 'Should include global_toggle_auto_backup button');
    assert.ok(dashCallbacks.includes('curve:all:noon'), 'Should include curve:all:noon button');
});

test('different Bilibili/Douyin rooms support independent per-room Cookies and transcode_mode in DB, backup snapshot, and StreamManager', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { createStore } = require('../src/db');
    const gistSync = require('../src/db/gist-sync');
    const StreamManager = require('../src/core/manager');
    const FFmpegService = require('../src/services/ffmpeg-service');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cookie-'));
    const dbPath = path.join(tmpDir, 'cookie-test.db');
    const store = createStore(dbPath);
    try {
        const roomA = store.addTask({
            platform: 'bilibili',
            roomId: '1001',
            targetUrl: 'rtmp://localhost/live/a',
            cookie: 'SESSDATA=bili_account_A;',
            transcodeMode: 'copy'
        });
        const roomB = store.addTask({
            platform: 'bilibili',
            roomId: '1002',
            targetUrl: 'rtmp://localhost/live/b',
            cookie: 'SESSDATA=bili_account_B;',
            transcodeMode: 'audio_fix'
        });

        assert.equal(roomA.task.cookie, 'SESSDATA=bili_account_A;');
        assert.equal(roomA.task.transcode_mode, 'copy');
        assert.equal(roomB.task.cookie, 'SESSDATA=bili_account_B;');
        assert.equal(roomB.task.transcode_mode, 'audio_fix');

        // 动态修改 roomB 的 Cookie 和转码模式
        store.updateTaskCookie(roomB.taskId, 'SESSDATA=bili_account_B_updated;');
        store.updateTaskTranscodeMode(roomB.taskId, 'transcode');
        const updatedB = store.getTaskById(roomB.taskId);
        assert.equal(updatedB.cookie, 'SESSDATA=bili_account_B_updated;');
        assert.equal(updatedB.transcode_mode, 'transcode');

        // 验证 FFmpegService 的 audio_fix 参数：视频 copy，音频 AAC 48kHz 双声道
        const audioFixFfmpeg = new FFmpegService({
            roomId: '1002',
            targetUrls: ['rtmp://localhost/live/a'],
            transcodeVideo: false,
            transcodeAudio: true
        });
        const audioOpts = audioFixFfmpeg.buildOutputOptions().join(' ');
        assert.ok(audioOpts.includes('-c:v copy'), 'Audio fix mode should keep video stream copy');
        assert.ok(audioOpts.includes('-c:a aac -b:a 128k -ar 48000 -ac 2'), 'Audio fix mode should re-encode audio to AAC 48kHz stereo');

        // 验证 StreamManager 为两个不同 B站房间注入各自独立的 Cookie 请求头与编码策略
        const mgrA = new StreamManager(store.getTaskById(roomA.taskId));
        const mgrB = new StreamManager(updatedB);
        assert.equal(mgrA.room.headers.Cookie, 'SESSDATA=bili_account_A;');
        assert.equal(mgrB.room.headers.Cookie, 'SESSDATA=bili_account_B_updated;');
        assert.deepEqual(StreamManager.resolveEncodingConfig({ transcode_mode: 'audio_fix' }), {
            transcodeVideo: false,
            transcodeAudio: true,
            mode: 'audio_fix'
        });

        // 验证导出备份快照包含各自的独立 cookie 与 transcode_mode
        const exported = gistSync.exportRooms(store);
        const expA = exported.find((r) => r.room_id === '1001');
        const expB = exported.find((r) => r.room_id === '1002');
        assert.equal(expA.cookie, 'SESSDATA=bili_account_A;');
        assert.equal(expA.transcode_mode, 'copy');
        assert.equal(expB.cookie, 'SESSDATA=bili_account_B_updated;');
        assert.equal(expB.transcode_mode, 'transcode');
    } finally {
        store.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('curveChart defaults to Beijing 12:00->12:00 window, separates 3 broadcast sessions in a single day, and renders a PNG wave chart', () => {
    const curveChart = require('../src/core/curve-chart');
    const views = require('../src/bot/views');

    // 北京时间 2026-05-10 20:00:00 (UTC 2026-05-10 12:00:00)
    const nowUtcMs = Date.UTC(2026, 4, 10, 12, 0, 0);
    const noonWin = curveChart.get24HourWindow('noon', nowUtcMs);
    assert.equal(noonWin.mode, 'noon');
    assert.ok(noonWin.label.includes('12:00'), 'Default window should be 12:00 -> next day 12:00');
    assert.equal(noonWin.endMs - noonWin.startMs, 24 * 3600 * 1000);

    const midnightWin = curveChart.get24HourWindow('midnight', nowUtcMs);
    assert.equal(midnightWin.mode, 'midnight');
    assert.ok(midnightWin.label.includes('00:00') && midnightWin.label.includes('0-24点自然日'));
    assert.equal(midnightWin.tickLabels[0], '00:00');
    assert.equal(midnightWin.tickLabels[8], '24:00');

    // 模拟一天内开播 3 次（#1 下午场、#2 晚间场、#3 凌晨场）
    const samples = [];
    // 第 1 场：窗口开启后 +1h ~ +2h (3000 kbps)
    for (let m = 60; m <= 120; m += 2) {
        samples.push({ ts: noonWin.startMs + m * 60 * 1000, kbps: 3000 + (m % 5) * 100 });
    }
    samples.push({ ts: noonWin.startMs + 121 * 60 * 1000, kbps: 0 }); // 下播标记

    // 第 2 场：窗口开启后 +6h ~ +8h (4500 kbps)
    for (let m = 360; m <= 480; m += 2) {
        samples.push({ ts: noonWin.startMs + m * 60 * 1000, kbps: 4500 });
    }
    samples.push({ ts: noonWin.startMs + 481 * 60 * 1000, kbps: 0 }); // 下播标记

    // 第 3 场：窗口开启后 +14h ~ +15.5h (2600 kbps)
    for (let m = 840; m <= 930; m += 2) {
        samples.push({ ts: noonWin.startMs + m * 60 * 1000, kbps: 2600 });
    }
    samples.push({ ts: noonWin.startMs + 931 * 60 * 1000, kbps: 0 }); // 下播标记

    const sessions = curveChart.extractBroadcastSessions(samples, noonWin.startMs, noonWin.endMs);
    assert.equal(sessions.length, 3, 'Should clearly separate 3 distinct broadcast sessions in the 24h cycle');
    assert.equal(sessions[0].index, 1);
    assert.equal(sessions[1].index, 2);
    assert.equal(sessions[2].index, 3);
    assert.ok(sessions[1].avgKbps >= 4400);

    const { pngBuffer: pngBuf } = curveChart.renderWaveChartPng({
        samples,
        mode: 'noon',
        nowMs: nowUtcMs
    });
    assert.ok(Buffer.isBuffer(pngBuf));
    // PNG 文件魔数校验: 89 50 4E 47 0D 0A 1A 0A
    assert.equal(pngBuf[0], 0x89);
    assert.equal(pngBuf[1], 0x50);
    assert.equal(pngBuf[2], 0x4e);
    assert.equal(pngBuf[3], 0x47);
    assert.ok(pngBuf.length > 3000, 'Rendered wave chart PNG should contain non-trivial image data');

    const unicodeWave = curveChart.renderUnicodeWave(samples, noonWin.startMs, noonWin.endMs, 24);
    const caption = views.renderWaveChartCaption({
        task: { id: 1, platform: 'bilibili', room_id: '2233' },
        windowInfo: noonWin,
        sessions,
        unicodeWave
    });
    assert.ok(caption.includes('共开播 3 场'));
    assert.ok(caption.includes('#1场'));
    assert.ok(caption.includes('#2场'));
    assert.ok(caption.includes('#3场'));
});

test('ffmpegInstaller resolves priority order, returns runtime info with resolved installation path, and Web Dashboard renders FFmpeg verification component', () => {
    const ffmpegInstaller = require('../src/services/ffmpeg-installer');
    const { buildDashboardKeyboard } = require('../src/bot/index');
    const { renderDashboard } = require('../src/web/dashboard');

    assert.equal(ffmpegInstaller.resolveFfmpegBin('/custom/path/ffmpeg'), '/custom/path/ffmpeg');
    const defaultResolved = ffmpegInstaller.resolveFfmpegBin('');
    assert.ok(typeof defaultResolved === 'string' && defaultResolved.length > 0);

    const runtimeInfo = ffmpegInstaller.getFfmpegRuntimeInfo({ forceRefresh: true });
    assert.ok(runtimeInfo.ok, 'System or bundled FFmpeg should be detected');
    assert.ok(runtimeInfo.version && runtimeInfo.version !== 'unknown', 'FFmpeg version should be parsed');
    assert.ok(runtimeInfo.resolvedPath.includes('ffmpeg'), 'Resolved installation path should point to ffmpeg executable');
    assert.equal(typeof runtimeInfo.isCustomBinary, 'boolean');

    const customInfo = ffmpegInstaller.getFfmpegRuntimeInfo({ forceRefresh: true, explicitEnvPath: '/custom/opt/ffmpeg' });
    assert.equal(customInfo.sourceType, 'env_custom');
    assert.equal(customInfo.isCustomBinary, true);
    assert.equal(customInfo.resolvedPath, '/custom/opt/ffmpeg');

    // Reset cache back to default
    ffmpegInstaller.getFfmpegRuntimeInfo({ forceRefresh: true });

    // When xz is available, official release branch (n9.0 / n8.1) is included alongside .gz fallback
    const withXzCandidates = ffmpegInstaller.getStaticDownloadCandidates('linux', 'x64', '', true);
    assert.ok(withXzCandidates.length >= 3);
    assert.ok(withXzCandidates[0].url.includes('ffmpeg-n9.0-latest-linux64-gpl-9.0.tar.xz'));
    assert.ok(withXzCandidates.some((c) => c.type === 'gz'));

    // When xz is NOT installed on host, only pure Node.js .gz candidate is returned (never triggers tar: xz: Cannot exec)
    const noXzCandidates = ffmpegInstaller.getStaticDownloadCandidates('linux', 'x64', '', false);
    assert.equal(noXzCandidates.length, 1);
    assert.equal(noXzCandidates[0].type, 'gz');

    const dashKb = buildDashboardKeyboard();
    const dashCallbacks = dashKb.inline_keyboard.flat().map((b) => b.callback_data);
    assert.ok(dashCallbacks.includes('global_update_ffmpeg'), 'Dashboard should include 1-click FFmpeg upgrade button');

    const webHtml = renderDashboard();
    assert.ok(webHtml.includes('id="ffmpeg-verify-section"'), 'Web dashboard should render FFmpeg verification component');
    assert.ok(webHtml.includes('id="ffmpeg-ver-value"'), 'Web dashboard should display detected FFmpeg version');
    assert.ok(webHtml.includes('id="ffmpeg-path-value"'), 'Web dashboard should display resolved FFmpeg installation path');
    assert.ok(webHtml.includes('id="ffmpeg-priority-chain"'), 'Web dashboard should display FFmpeg resolution priority chain');
});





