const FFmpeg = require('fluent-ffmpeg');

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

  /**
   * 针对 HTTP-FLV 深度优化的输入参数
   */
  buildInputOptions(streamUrl) {
    const options = [
      '-loglevel', 'warning',
      '-stats',
      '-nostdin',
    ];

    if (streamUrl.startsWith('http')) {
      options.push(
        // 重连设置
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        // 核心降延迟：禁用内部缓冲，丢弃损坏包
        '-fflags', 'nobuffer+discardcorrupt', 
        // 快速分析流格式（秒开）
        '-analyzeduration', '1000000', 
        '-probesize', '1000000',
        // 读写超时 (10秒)，防止因源站不断开连接但无数据导致的进程僵死
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
          '-tune', 'zerolatency', // 转码模式下必须开启零延迟
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
      const prevCmd = this.ffmpegCommand;
      this.ffmpegCommand = null;
      prevCmd.kill('SIGINT');
    }

    this.stoppedManually = false;
    this.streamUrl = streamUrl;
    this.trafficStats.startedAt = new Date().toISOString();
    if (this.killTimeout) { clearTimeout(this.killTimeout); this.killTimeout = null; }

    const cmd = FFmpeg(streamUrl);
    cmd.inputOptions(this.buildInputOptions(streamUrl));
    cmd.outputOptions(this.buildOutputOptions());

    if (this.targetUrls.length === 1) {
      cmd.outputOptions('-f', 'flv').output(this.targetUrls[0]);
    } else {
      const tee = this.targetUrls.map(t => `[f=flv]${t}`).join('|');
      cmd.outputOptions('-f', 'tee').output(tee);
    }

    cmd.on('start', (cmdline, proc) => {
      if (this.ffmpegCommand === cmd) this.onStart(cmdline);
      
      if (proc && proc.stderr) {
        proc.stderr.on('data', data => {
          data.toString().split('\n').forEach(line => this.parseStderrProgress(line));
        });
      }
    });

    cmd.on('progress', progress => {
      if (this.ffmpegCommand === cmd) this.parseProgressData(progress);
    });

    cmd.on('error', err => {
      if (this.ffmpegCommand !== cmd) return;
      this.ffmpegCommand = null;
      this.onError(err);
    });

    cmd.on('end', () => {
      if (this.ffmpegCommand !== cmd) return;
      this.ffmpegCommand = null;
      if (!this.stoppedManually) this.onEnd();
    });

    this.ffmpegCommand = cmd;
    cmd.run();
    return cmd;
  }

  async captureFrame(streamUrl, options = {}) {
    if (!streamUrl) throw new Error('流地址不可用');

    const timeout = options.timeout || 20000;
    return new Promise((resolve, reject) => {
      const chunks = [];
      const cmd = FFmpeg(streamUrl)
        .inputOptions([
          '-loglevel', 'error',
          '-nostdin',
          '-ss', '0',
          '-analyzeduration', '1000000',
          '-probesize', '1000000',
          '-an', '-sn',
          ...Object.entries(this.inputHeaders).filter(([, v]) => v).length > 0
            ? ['-headers', Object.entries(this.inputHeaders).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\r\n')]
            : [],
        ])
        .outputOptions([
          '-frames:v', '1',
          '-f', 'image2pipe',
          '-c:v', 'mjpeg',
          '-q:v', '5',
          '-update', '1'
        ]);

      const timeoutHandle = setTimeout(() => {
        cmd.kill('SIGKILL');
        reject(new Error(`截图超时 (${timeout}ms)`));
      }, timeout);

      const ffStream = cmd.pipe();
      ffStream.on('data', chunk => chunks.push(chunk));
      
      cmd.on('end', () => {
        clearTimeout(timeoutHandle);
        const buffer = Buffer.concat(chunks);
        buffer.length > 0 ? resolve(buffer) : reject(new Error('未捕获到帧数据'));
      });

      cmd.on('error', err => {
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

  parseProgressData(data) {
    if (!data) return;
    if (data.currentKbps) this.trafficStats.bitrateKbps = data.currentKbps;
    if (data.targetSize) this.trafficStats.sessionBytes = data.targetSize * 1024;
    this.trafficStats.updatedAt = new Date().toISOString();
    this.onProgress(data);
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