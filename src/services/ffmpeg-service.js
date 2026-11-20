const { spawn } = require('node:child_process');
const config = require('../config');

class FFmpegService {
  constructor({
    roomId,
    targetUrl,
    targetUrls,
    inputHeaders = {},
    globalOutputOptions = [],
    transcodeVideo = false,
    transcodeAudio = false,
    onStart = () => {},
    onProgress = () => {},
    onError = () => {},
    onEnd = () => {},
    onOutputFailed = () => {},
  }) {
    this.roomId = roomId;
    this.targetUrls = Array.isArray(targetUrls) && targetUrls.length > 0
      ? [...new Set(targetUrls.filter(Boolean))]
      : [targetUrl].filter(Boolean);
    this.inputHeaders = inputHeaders;
    this.globalOutputOptions = globalOutputOptions;
    this.transcodeVideo = transcodeVideo;
    this.transcodeAudio = transcodeAudio;
    this.onStart = onStart;
    this.onProgress = onProgress;
    this.onError = onError;
    this.onEnd = onEnd;
    this.onOutputFailed = onOutputFailed;
    this.failedOutputs = new Set();

    this.ffmpegCommand = null;
    this.stoppedManually = false;
    this.isFallbackMode = false;
    this.streamUrl = null;

    this.trafficStats = {
      sessionBytes: 0,
      bitrateKbps: 0,
      updatedAt: null,
      lastProgressAt: null,
      startedAt: null,
    };
  }

  buildInputOptions(streamUrl) {
    const preInput = ['-loglevel', 'warning', '-stats', '-nostdin'];
    const postInput = [];

    if (streamUrl.startsWith('http')) {
      preInput.push(
        '-reconnect', '1',
        '-reconnect_at_eof', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-rw_timeout', config.ffmpeg.rwTimeoutUs,
        '-fflags', 'nobuffer+discardcorrupt',
        '-analyzeduration', config.ffmpeg.analyzeDuration,
        '-probesize', config.ffmpeg.probeSize
      );
    }

    const headerEntries = Object.entries(this.inputHeaders).filter(([, v]) => v);
    if (headerEntries.length > 0) {
      const headerString = `${headerEntries.map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n`;
      preInput.push('-headers', headerString);
    }

    return { preInput, postInput };
  }

  buildOutputOptions() {
    const videoOpts = this.transcodeVideo
      ? [
          '-c:v', config.ffmpeg.videoCodec,
          '-preset', config.ffmpeg.videoPreset,
          '-tune', 'zerolatency',
          '-crf', config.ffmpeg.videoCrf,
          '-maxrate', config.ffmpeg.videoMaxrate,
          '-bufsize', config.ffmpeg.videoBufsize,
          ...(config.ffmpeg.threads > 0 ? ['-threads', String(config.ffmpeg.threads)] : []),
        ]
      : ['-c:v', 'copy'];

    const audioOpts = (this.transcodeVideo || this.transcodeAudio)
      ? [
          '-c:a', config.ffmpeg.audioCodec,
          '-b:a', config.ffmpeg.audioBitrate,
          '-ar', '48000',
          '-ac', '2',
        ]
      : ['-c:a', 'copy'];

    const options = [...videoOpts, ...audioOpts];

    if (Array.isArray(this.globalOutputOptions)) {
      options.push(...this.globalOutputOptions);
    }
    return options;
  }

  start(streamUrl) {
    if (!streamUrl) throw new Error('缺少输入流地址');
    if (!this.targetUrls || this.targetUrls.length === 0) {
      throw new Error('缺少推流目标地址');
    }

    if (this.ffmpegCommand) {
      this.stop();
    }

    this.stoppedManually = false;
    this.isFallbackMode = false;
    this.streamUrl = streamUrl;
    this.failedOutputs = new Set();
    this.trafficStats = {
      sessionBytes: 0,
      bitrateKbps: 0,
      updatedAt: null,
      lastProgressAt: null,
      startedAt: new Date().toISOString(),
    };

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
      const tee = this.targetUrls.map((t) => `[f=flv:onfail=ignore]${t}`).join('|');
      args.push('-f', 'tee', tee);
    }

    const ffmpegPath = process.env.FFMPEG_PATH || config.ffmpeg.bin;
    this.lastArgs = [ffmpegPath, ...args];
    const proc = spawn(ffmpegPath, args);

    this.stderrBuffer = [];

    proc.stderr.on('data', (data) => {
      if (this.ffmpegCommand !== proc) return;
      const text = data.toString();
      text.split(/[\r\n]+/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const isProgress = this.parseStderrProgress(trimmed);
        this.parseOutputErrors(trimmed);
        if (!isProgress) {
          this.stderrBuffer.push(trimmed);
          if (this.stderrBuffer.length > 15) this.stderrBuffer.shift();
        }
      });
    });

    proc.on('error', (err) => {
      if (this.ffmpegCommand !== proc) return;
      this.ffmpegCommand = null;
      this.onError(err);
    });

    proc.on('exit', (code, signal) => {
      if (this.ffmpegCommand !== proc) return;
      this.ffmpegCommand = null;
      if (this.stoppedManually) return;
      if (signal || (code !== 0 && code !== null)) {
        const lastErrors = this.stderrBuffer.join('\n');
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        const errorMsg = `FFmpeg exited with ${reason}${lastErrors ? `:\n${lastErrors}` : ''}`;
        this.onError(new Error(errorMsg));
      } else {
        this.onEnd();
      }
    });

    this.ffmpegCommand = proc;
    this.onStart(`${ffmpegPath} ${args.join(' ')}`);
    return proc;
  }

  buildFallbackArgs(imagePath) {
    const args = [
      '-loglevel', 'warning',
      '-stats',
      '-nostdin',
      '-re',
      '-loop', '1',
      '-framerate', '1',
      '-i', imagePath,
      '-f', 'lavfi',
      '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-c:v', config.ffmpeg.videoCodec || 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'stillimage',
      '-pix_fmt', 'yuv420p',
      '-s', '1280x720',
      '-r', '15',
      '-g', '30',
      '-b:v', '250k',
      '-maxrate', '300k',
      '-bufsize', '600k',
      '-c:a', config.ffmpeg.audioCodec || 'aac',
      '-b:a', '64k',
      '-ar', '48000',
      '-ac', '2',
      ...(config.ffmpeg.threads > 0 ? ['-threads', String(config.ffmpeg.threads)] : []),
    ];

    if (this.targetUrls.length === 1) {
      args.push('-f', 'flv', this.targetUrls[0]);
    } else {
      const tee = this.targetUrls.map((t) => `[f=flv:onfail=ignore]${t}`).join('|');
      args.push('-f', 'tee', tee);
    }
    return args;
  }

  startFallback(imagePath) {
    if (!imagePath) throw new Error('缺少保底图路径');
    if (!this.targetUrls || this.targetUrls.length === 0) {
      throw new Error('缺少推流目标地址');
    }

    if (this.ffmpegCommand) {
      this.stop();
    }

    this.stoppedManually = false;
    this.isFallbackMode = true;
    this.streamUrl = imagePath;
    this.failedOutputs = new Set();

    const args = this.buildFallbackArgs(imagePath);
    const ffmpegPath = process.env.FFMPEG_PATH || config.ffmpeg.bin;
    this.lastArgs = [ffmpegPath, ...args];
    const proc = spawn(ffmpegPath, args);

    this.stderrBuffer = [];

    proc.stderr.on('data', (data) => {
      if (this.ffmpegCommand !== proc) return;
      const text = data.toString();
      text.split(/[\r\n]+/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const isProgress = this.parseStderrProgress(trimmed);
        this.parseOutputErrors(trimmed);
        if (!isProgress) {
          this.stderrBuffer.push(trimmed);
          if (this.stderrBuffer.length > 15) this.stderrBuffer.shift();
        }
      });
    });

    proc.on('error', (err) => {
      if (this.ffmpegCommand !== proc) return;
      this.ffmpegCommand = null;
      this.isFallbackMode = false;
      this.onError(err);
    });

    proc.on('exit', (code, signal) => {
      if (this.ffmpegCommand !== proc) return;
      this.ffmpegCommand = null;
      this.isFallbackMode = false;
      if (this.stoppedManually) return;
      if (signal || (code !== 0 && code !== null)) {
        const lastErrors = this.stderrBuffer.join('\n');
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        const errorMsg = `Fallback FFmpeg exited with ${reason}${lastErrors ? `:\n${lastErrors}` : ''}`;
        this.onError(new Error(errorMsg));
      } else {
        this.onEnd();
      }
    });

    this.ffmpegCommand = proc;
    return proc;
  }

  parseOutputErrors(line) {
    if (!/slave/i.test(line) || !/error|fail/i.test(line)) return;
    const m = line.match(/Slave '([^']+)'/i);
    if (!m) return;
    const raw = m[1].replace(/^\[[^\]]+\]/, '');
    const target = this.targetUrls.find((t) => raw === t || raw.includes(t) || t.includes(raw));
    const key = target || raw;
    if (this.failedOutputs.has(key)) return;
    this.failedOutputs.add(key);

    if (this.targetUrls.length > 1 && this.failedOutputs.size >= this.targetUrls.length) {
      this.stop();
      this.onError(new Error('所有 RTMP 推流目标线路均已断开'));
      return;
    }

    try {
      this.onOutputFailed(target || raw, line);
    } catch {}
  }

  async captureFrame(streamUrl, options = {}) {
    if (!streamUrl) throw new Error('流地址不可用');

    const timeout = options.timeout || config.ffmpeg.snapshotTimeoutMs;
    return new Promise((resolve, reject) => {
      const chunks = [];

      const preInput = [
        '-loglevel', 'error',
        '-nostdin',
        '-ss', '0',
        '-analyzeduration', config.ffmpeg.analyzeDuration,
        '-probesize', config.ffmpeg.probeSize,
      ];

      const headerEntries = Object.entries(this.inputHeaders).filter(([, v]) => v);
      if (headerEntries.length > 0) {
        const headerString = `${headerEntries.map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n`;
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
      const ffmpegPath = process.env.FFMPEG_PATH || config.ffmpeg.bin;
      const proc = spawn(ffmpegPath, args);
      const stderrChunks = [];
      let stderrBytes = 0;
      let settled = false;

      const finish = (err, buf) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        if (err) reject(err);
        else resolve(buf);
      };

      const timeoutHandle = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        finish(new Error(`截图超时 (${timeout}ms)`));
      }, timeout);
      timeoutHandle.unref?.();

      proc.stdout?.on('data', (chunk) => chunks.push(chunk));
      // 必须持续消费 stderr，防止错误日志超过 64KB 填满 OS 管道缓冲区导致子进程死锁
      proc.stderr?.on('data', (chunk) => {
        if (stderrBytes < 4096) {
          const text = chunk.toString();
          stderrChunks.push(text);
          stderrBytes += text.length;
        }
      });

      proc.on('close', (code) => {
        if (code === 0) {
          const buffer = Buffer.concat(chunks);
          buffer.length > 0 ? finish(null, buffer) : finish(new Error('未捕获到帧数据'));
        } else {
          const detail = stderrChunks.join('').trim().split(/\r?\n/).slice(-2).join(' | ');
          finish(new Error(detail ? `FFmpeg 退出码: ${code} (${detail})` : `FFmpeg 退出码: ${code}`));
        }
      });

      proc.on('error', (err) => {
        finish(err);
      });
    });
  }

  stop() {
    this.isFallbackMode = false;
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
      } catch {
        done();
        return;
      }
      const killTimer = setTimeout(() => {
        try {
          cmdRef.kill('SIGKILL');
        } catch {}
      }, 5000);
      killTimer.unref?.();
      const waitTimer = setTimeout(done, 10000);
      waitTimer.unref?.();
    });
  }

  parseStderrProgress(line) {
    let matched = false;
    const nowMs = Date.now();
    const bitrateMatch = line.match(/bitrate=\s*(\d+\.?\d*)\s*kbits?\/s/i);
    if (bitrateMatch) {
      this.trafficStats.bitrateKbps = parseFloat(bitrateMatch[1]);
      this.trafficStats.updatedAt = new Date(nowMs).toISOString();
      this.trafficStats.lastProgressAt = nowMs;
      matched = true;
    } else if (/bitrate=\s*N\/A/i.test(line)) {
      this.trafficStats.bitrateKbps = 0;
      this.trafficStats.updatedAt = new Date(nowMs).toISOString();
      matched = true;
    }
    const sizeMatch = line.match(/size=\s*(\d+)\s*(?:KiB|kB)/i);
    if (sizeMatch) {
      this.trafficStats.sessionBytes = parseInt(sizeMatch[1], 10) * 1024;
      this.trafficStats.updatedAt = new Date(nowMs).toISOString();
      this.trafficStats.lastProgressAt = nowMs;
      matched = true;
    }
    if (!matched && /^(?:frame|size)=\s*\d+/i.test(line)) {
      matched = true;
    }
    return matched;
  }

  getTrafficStats() {
    return {
      ...this.trafficStats,
      lastArgs: this.lastArgs,
      running: !!this.ffmpegCommand && !this.stoppedManually,
      fallbackActive: !!this.isFallbackMode && !!this.ffmpegCommand && !this.stoppedManually,
    };
  }

  async detectBlackFrame(streamUrl, options = {}) {
    if (!streamUrl) throw new Error('流地址不可用');
    const analyzeSeconds = options.seconds || 20;
    const blackDuration = options.duration || 15;
    const timeout = (analyzeSeconds + 20) * 1000;

    return new Promise((resolve, reject) => {
      const stderrLines = [];
      const preInput = [
        '-loglevel', 'info',
        '-nostdin',
        '-analyzeduration', config.ffmpeg.analyzeDuration,
        '-probesize', config.ffmpeg.probeSize,
      ];

      const headerEntries = Object.entries(this.inputHeaders).filter(([, v]) => v);
      if (headerEntries.length > 0) {
        const headerString = `${headerEntries.map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n`;
        preInput.push('-headers', headerString);
      }

      const args = [
        ...preInput, '-i', streamUrl,
        '-vf', `blackdetect=d=${blackDuration}:pix_th=0.10`,
        '-an', '-t', String(analyzeSeconds),
        '-f', 'null', '-',
      ];
      const ffmpegPath = process.env.FFMPEG_PATH || config.ffmpeg.bin;
      const proc = spawn(ffmpegPath, args);
      let settled = false;

      const finish = (err, detected) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        if (err) reject(err);
        else resolve(detected);
      };

      const timeoutHandle = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        finish(new Error(`黑帧检测超时 (${timeout}ms)`));
      }, timeout);
      timeoutHandle.unref?.();

      proc.stdout?.resume?.();
      proc.stderr?.on('data', (data) => stderrLines.push(data.toString()));

      proc.on('close', (code) => {
        if (code !== 0 && code !== null) {
          finish(new Error(`FFmpeg 退出码: ${code}`));
          return;
        }
        const log = stderrLines.join('\n');
        finish(null, /black_start/i.test(log));
      });

      proc.on('error', (err) => {
        finish(err);
      });
    });
  }
}

module.exports = FFmpegService;
