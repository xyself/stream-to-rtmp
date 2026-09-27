const { spawn } = require('child_process');

class FFmpegService {
  constructor({
    roomId,
    targetUrl,
    targetUrls,
    inputHeaders = {},
    globalOutputOptions = [],
    transcodeVideo = false,
    onStart = () => {},
    onProgress = () => {},
    onError = () => {},
    onEnd = () => {},
    onOutputFailed = () => {}, // 某一路 tee 输出目标断开时回调 (targetUrl, reason)
  }) {
    this.roomId = roomId;
    this.targetUrls = Array.isArray(targetUrls) && targetUrls.length > 0
      ? [...new Set(targetUrls.filter(Boolean))]
      : [targetUrl].filter(Boolean);
    this.inputHeaders = inputHeaders;
    this.globalOutputOptions = globalOutputOptions;
    this.transcodeVideo = transcodeVideo;
    this.onStart = onStart;
    this.onProgress = onProgress;
    this.onError = onError;
    this.onEnd = onEnd;
    this.onOutputFailed = onOutputFailed;
    this.failedOutputs = new Set(); // 本会话已上报断开的目标，避免重复告警

    this.ffmpegCommand = null;
    this.stoppedManually = false;
    this.streamUrl = null;

    this.trafficStats = {
      sessionBytes: 0,
      bitrateKbps: 0,
      updatedAt: null,
      startedAt: null,
    };
  }

  enableStats() { return true; }
  disableStats() { return true; }

  buildInputOptions(streamUrl) {
    const preInput = ['-loglevel', 'warning', '-stats', '-nostdin'];
    const postInput = [];

    if (streamUrl.startsWith('http')) {
      preInput.push(
        '-reconnect', '1',
        '-reconnect_at_eof', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-analyzeduration', '1000000',
        '-probesize', '1000000'
      );
      postInput.push('-fflags', 'nobuffer+discardcorrupt', '-rw_timeout', '10000000');
    }

    const headerEntries = Object.entries(this.inputHeaders).filter(([, v]) => v);
    if (headerEntries.length > 0) {
      const headerString = headerEntries.map(([k, v]) => `${k}: ${v}`).join('\r\n');
      preInput.push('-headers', headerString);
    }

    return { preInput, postInput };
  }

  buildOutputOptions() {
    const options = this.transcodeVideo
      ? [
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-tune', 'zerolatency',
          '-crf', '23',
          '-maxrate', '3000k',
          '-bufsize', '6000k',
          '-c:a', 'aac',
          '-b:a', '128k'
        ]
      : ['-c:v', 'copy', '-c:a', 'copy'];

    if (Array.isArray(this.globalOutputOptions)) {
      options.push(...this.globalOutputOptions);
    }
    return options;
  }

  start(streamUrl) {
    if (!streamUrl) throw new Error('缺少输入流地址');

    if (this.ffmpegCommand) {
      this.stop();
    }

    this.stoppedManually = false;
    this.streamUrl = streamUrl;
    this.failedOutputs = new Set(); // 新会话：输出断开记录清零
    this.trafficStats.startedAt = new Date().toISOString();

    const { preInput, postInput } = this.buildInputOptions(streamUrl);
    const outputOpts = this.buildOutputOptions();

    const args = [
      ...preInput,
      '-i', streamUrl,
      ...postInput,
      ...outputOpts,
    ];

    if (this.targetUrls.length === 1) {
      args.push('-f', 'flv', this.targetUrls[0]);
    } else {
      // onfail=ignore：一路目标挂了不断整条链，其他路继续推
      const tee = this.targetUrls.map(t => `[f=flv:onfail=ignore]${t}`).join('|');
      args.push('-f', 'tee', tee);
    }

    const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
    this.lastArgs = [ffmpegPath, ...args];
    const proc = spawn(ffmpegPath, args);

    this.stderrBuffer = [];

    proc.stderr.on('data', data => {
      const text = data.toString();
      text.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed) {
          this.parseStderrProgress(trimmed);
          this.parseOutputErrors(trimmed);
          this.stderrBuffer.push(trimmed);
          if (this.stderrBuffer.length > 10) this.stderrBuffer.shift();
        }
      });
    });

    proc.on('error', err => {
      if (this.ffmpegCommand !== proc) return;
      this.ffmpegCommand = null;
      this.onError(err);
    });

    proc.on('exit', (code, signal) => {
      if (this.ffmpegCommand !== proc) return;
      this.ffmpegCommand = null;
      if (this.stoppedManually) return;
      if (code !== 0 && code !== null) {
        const lastErrors = this.stderrBuffer.join('\n');
        const errorMsg = `FFmpeg exited with code ${code}${lastErrors ? `:\n${lastErrors}` : ''}`;
        this.onError(new Error(errorMsg));
      } else {
        this.onEnd();
      }
    });

    this.ffmpegCommand = proc;
    this.onStart(`${ffmpegPath} ${args.join(' ')}`);
    return proc;
  }

  // 解析 tee 多路输出里某一路目标的报错：
  // 形如 "[tee @ 0x..] Slave '[f=flv:onfail=ignore]rtmp://host/app/key': Error ..."，
  // onfail=ignore 会让 FFmpeg 默默跳过坏路，这里把它揪出来告警
  parseOutputErrors(line) {
    if (!/slave/i.test(line) || !/error|fail/i.test(line)) return;
    const m = line.match(/Slave '([^']+)'/i);
    if (!m) return;
    // 去掉 tee 的 [f=flv:onfail=ignore] 前缀，还原真实目标地址
    const raw = m[1].replace(/^\[[^\]]+\]/, '');
    const target = this.targetUrls.find(t => raw === t || raw.includes(t) || t.includes(raw));
    const key = target || raw;
    if (this.failedOutputs.has(key)) return; // 本会话已报过
    this.failedOutputs.add(key);
    try {
      this.onOutputFailed(target || raw, line);
    } catch {}
  }

  async captureFrame(streamUrl, options = {}) {
    if (!streamUrl) throw new Error('流地址不可用');

    const timeout = options.timeout || 20000;
    return new Promise((resolve, reject) => {
      const chunks = [];

      const preInput = [
        '-loglevel', 'error',
        '-nostdin',
        '-ss', '0',
        '-analyzeduration', '1000000',
        '-probesize', '1000000',
      ];

      const headerEntries = Object.entries(this.inputHeaders).filter(([, v]) => v);
      if (headerEntries.length > 0) {
        const headerString = headerEntries.map(([k, v]) => `${k}: ${v}`).join('\r\n');
        preInput.push('-headers', headerString);
      }

      const outputOpts = [
        '-an', '-sn',
        '-frames:v', '1',
        '-f', 'image2pipe',
        '-c:v', 'mjpeg',
        '-q:v', '5',
      ];

      const args = [...preInput, '-i', streamUrl, ...outputOpts, '-'];
      const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
      const proc = spawn(ffmpegPath, args);

      const timeoutHandle = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`截图超时 (${timeout}ms)`));
      }, timeout);

      proc.stdout.on('data', chunk => chunks.push(chunk));

      proc.on('exit', (code) => {
        clearTimeout(timeoutHandle);
        if (code === 0) {
          const buffer = Buffer.concat(chunks);
          buffer.length > 0 ? resolve(buffer) : reject(new Error('未捕获到帧数据'));
        } else {
          reject(new Error(`FFmpeg 退出码: ${code}`));
        }
      });

      proc.on('error', err => {
        clearTimeout(timeoutHandle);
        reject(err);
      });
    });
  }

  // 停止 FFmpeg：先 SIGINT 给 5 秒自己收尾，不走再 SIGKILL；
  // 返回 Promise，进程真正退出（或 10 秒兜底）后 resolve，优雅关闭时 await 用
  stop() {
    if (!this.ffmpegCommand) return Promise.resolve();
    this.stoppedManually = true;
    const cmdRef = this.ffmpegCommand;
    this.ffmpegCommand = null;

    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        clearTimeout(waitTimer);
        resolve();
      };
      cmdRef.on('exit', done);
      try {
        cmdRef.kill('SIGINT');
      } catch (e) {
        done();
        return;
      }
      // SIGKILL 兜底绑在局部变量上，不再存 this.killTimeout：
      // 之前 start() 里会清掉它，导致上一个进程的 SIGKILL 被取消、僵尸残留
      const killTimer = setTimeout(() => { try { cmdRef.kill('SIGKILL'); } catch (e) {} }, 5000);
      const waitTimer = setTimeout(done, 10000);
    });
  }

  parseStderrProgress(line) {
    const bitrateMatch = line.match(/bitrate=\s*(\d+\.?\d*)\s*kbits?\/s/i);
    if (bitrateMatch) {
      this.trafficStats.bitrateKbps = parseFloat(bitrateMatch[1]);
      this.trafficStats.updatedAt = new Date().toISOString();
    }
    // 解析累计输出字节：ffmpeg -stats 行形如 "size=    1234KiB"
    const sizeMatch = line.match(/size=\s*(\d+)KiB/i);
    if (sizeMatch) {
      this.trafficStats.sessionBytes = parseInt(sizeMatch[1], 10) * 1024;
      this.trafficStats.updatedAt = new Date().toISOString();
    }
  }

  getTrafficStats() {
    return {
      ...this.trafficStats,
      lastArgs: this.lastArgs,
      running: !!this.ffmpegCommand && !this.stoppedManually,
    };
  }

  // 黑帧检测：拉一段流，用 blackdetect 滤镜看是否长时间黑屏
  // 返回 true = 疑似黑屏；false = 画面正常；抛错 = 检测失败（不告警）
  async detectBlackFrame(streamUrl, options = {}) {
    if (!streamUrl) throw new Error('流地址不可用');
    const analyzeSeconds = options.seconds || 6;
    const timeout = (analyzeSeconds + 20) * 1000;

    return new Promise((resolve, reject) => {
      const stderrLines = [];
      const preInput = [
        '-loglevel', 'info', // blackdetect 的结果打在 info 级别日志里
        '-nostdin',
        '-analyzeduration', '1000000',
        '-probesize', '1000000',
      ];

      const headerEntries = Object.entries(this.inputHeaders).filter(([, v]) => v);
      if (headerEntries.length > 0) {
        const headerString = headerEntries.map(([k, v]) => `${k}: ${v}`).join('\r\n');
        preInput.push('-headers', headerString);
      }

      // blackdetect=d=3：连续 3 秒黑帧才算；pix_th=0.10：亮度低于 10% 视为黑
      const args = [
        ...preInput, '-i', streamUrl,
        '-vf', 'blackdetect=d=3:pix_th=0.10',
        '-an', '-t', String(analyzeSeconds),
        '-f', 'null', '-',
      ];
      const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
      const proc = spawn(ffmpegPath, args);

      const timeoutHandle = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`黑帧检测超时 (${timeout}ms)`));
      }, timeout);

      proc.stderr.on('data', data => stderrLines.push(data.toString()));

      proc.on('exit', (code) => {
        clearTimeout(timeoutHandle);
        if (code !== 0 && code !== null) {
          reject(new Error(`FFmpeg 退出码: ${code}`));
          return;
        }
        const log = stderrLines.join('\n');
        resolve(/black_start/i.test(log));
      });

      proc.on('error', err => {
        clearTimeout(timeoutHandle);
        reject(err);
      });
    });
  }
}

module.exports = FFmpegService;
