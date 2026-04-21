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

    this.ffmpegCommand = null;
    this.stoppedManually = false;
    this.streamUrl = null;
    this.killTimeout = null;

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
    const options = [
      '-loglevel', 'warning',
      '-stats',
      '-nostdin',
    ];

    if (streamUrl.startsWith('http')) {
      options.push(
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-fflags', 'nobuffer+discardcorrupt',
        '-analyzeduration', '1000000',
        '-probesize', '1000000',
        '-rw_timeout', '10000000'
      );
    }

    const headerEntries = Object.entries(this.inputHeaders).filter(([, v]) => v);
    if (headerEntries.length > 0) {
      const headerString = headerEntries.map(([k, v]) => `${k}: ${v}`).join('\r\n');
      options.push('-headers', headerString);
    }

    return options;
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
    this.trafficStats.startedAt = new Date().toISOString();
    if (this.killTimeout) { clearTimeout(this.killTimeout); this.killTimeout = null; }

    const inputOpts = this.buildInputOptions(streamUrl);
    const outputOpts = this.buildOutputOptions();

    const args = [];
    args.push('-i', streamUrl);
    args.push(...inputOpts);

    if (this.targetUrls.length === 1) {
      args.push('-f', 'flv', this.targetUrls[0]);
    } else {
      const tee = this.targetUrls.map(t => `[f=flv]${t}`).join('|');
      args.push('-f', 'tee', tee);
    }
    args.push(...outputOpts);

    const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
    const proc = spawn(ffmpegPath, args);

    proc.stderr.on('data', data => {
      data.toString().split('\n').forEach(line => this.parseStderrProgress(line));
    });

    proc.on('error', err => {
      if (this.ffmpegCommand !== proc) return;
      this.ffmpegCommand = null;
      this.onError(err);
    });

    proc.on('exit', (code, signal) => {
      if (this.ffmpegCommand !== proc) return;
      this.ffmpegCommand = null;
      if (!this.stoppedManually) this.onEnd();
    });

    this.ffmpegCommand = proc;
    this.onStart(`${ffmpegPath} ${args.join(' ')}`);
    return proc;
  }

  async captureFrame(streamUrl, options = {}) {
    if (!streamUrl) throw new Error('流地址不可用');

    const timeout = options.timeout || 20000;
    return new Promise((resolve, reject) => {
      const chunks = [];

      const inputOpts = [
        '-loglevel', 'error',
        '-nostdin',
        '-ss', '0',
        '-analyzeduration', '1000000',
        '-probesize', '1000000',
        '-an', '-sn',
      ];

      const headerEntries = Object.entries(this.inputHeaders).filter(([, v]) => v);
      if (headerEntries.length > 0) {
        const headerString = headerEntries.map(([k, v]) => `${k}: ${v}`).join('\r\n');
        inputOpts.push('-headers', headerString);
      }

      const outputOpts = [
        '-frames:v', '1',
        '-f', 'image2pipe',
        '-c:v', 'mjpeg',
        '-q:v', '5',
      ];

      const args = ['-i', streamUrl, ...inputOpts, ...outputOpts, '-'];
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

  stop() {
    if (this.ffmpegCommand) {
      this.stoppedManually = true;
      const cmdRef = this.ffmpegCommand;
      this.ffmpegCommand = null;
      cmdRef.kill('SIGINT');

      if (this.killTimeout) clearTimeout(this.killTimeout);
      this.killTimeout = setTimeout(() => {
        try { cmdRef.kill('SIGKILL'); } catch(e) {}
      }, 5000);
    }
  }

  parseStderrProgress(line) {
    const bitrateMatch = line.match(/bitrate=\s*(\d+\.?\d*)\s*kbits?\/s/i);
    if (bitrateMatch) {
      this.trafficStats.bitrateKbps = parseFloat(bitrateMatch[1]);
      this.trafficStats.updatedAt = new Date().toISOString();
    }
  }

  getTrafficStats() {
    return {
      ...this.trafficStats,
      running: !!this.ffmpegCommand && !this.stoppedManually,
    };
  }
}

module.exports = FFmpegService;
