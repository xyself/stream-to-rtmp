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
    
    // 流量统计相关
    this.trafficStats = {
      sessionBytes: 0,
      bitrateKbps: 0,
      updatedAt: null,
      startedAt: null,
    };
    this.killTimeout = null;
  }

  buildInputOptions(streamUrl) {
    const options = [
      '-loglevel', 'debug',
      '-stats',
      '-nostdin',
      '-re',
      '-reconnect', '1',
      '-reconnect_at_eof', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
    ];

    const headerEntries = Object.entries(this.inputHeaders).filter(([, value]) => value);
    if (headerEntries.length > 0) {
      const headerString = headerEntries
        .map(([key, value]) => `${key}: ${value}`)
        .join('\r\n');
      options.push('-headers', headerString);
    }

    return options;
  }

  buildOutputOptions() {
    const options = this.transcodeVideo
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-maxrate', '8000k', '-bufsize', '16000k', '-c:a', 'aac', '-b:a', '128k']
      : ['-c:v', 'copy', '-c:a', 'aac'];

    if (Array.isArray(this.globalOutputOptions) && this.globalOutputOptions.length > 0) {
      options.push(...this.globalOutputOptions);
    }

    return options;
  }

  parseProgressData(progressData) {
    if (!progressData || typeof progressData !== 'object') {
      return;
    }

    try {
      // fluent-ffmpeg progress: { frames, currentFps, currentKbps, targetSize, timemark, percent }
      // targetSize 单位 kB, currentKbps 是数字
      let kbps = 0;

      if (typeof progressData.currentKbps === 'number' && progressData.currentKbps > 0) {
        kbps = progressData.currentKbps;
      } else if (progressData.bitrate && typeof progressData.bitrate === 'string') {
        const match = progressData.bitrate.match(/(\d+\.?\d*)/);
        if (match) kbps = parseFloat(match[1]);
      }

      if (typeof progressData.targetSize === 'number' && progressData.targetSize > 0) {
        this.trafficStats.sessionBytes = progressData.targetSize * 1024;
      } else if (kbps > 0 && this.trafficStats.startedAt) {
        const elapsed = (Date.now() - new Date(this.trafficStats.startedAt).getTime()) / 1000;
        this.trafficStats.sessionBytes = Math.round((kbps / 8) * 1024 * elapsed);
      }

      if (kbps > 0) this.trafficStats.bitrateKbps = kbps;
      this.trafficStats.updatedAt = new Date().toISOString();

      this.onProgress(progressData);
    } catch (err) {
      console.error('[FFmpegService] 解析进度数据失败:', err.message);
    }
  }

  // 从 FFmpeg stderr 字符串解析流量信息（在需要更精确的地方调用）
  parseStderrProgress(stderrLine) {
    if (!stderrLine || typeof stderrLine !== 'string') {
      return;
    }

    try {
      // 格式: frame=  123 fps= 45 q=-1.0 Lsize=N/A time=00:00:05.12 bitrate=1024.5kbits/s speed=1.0x
      const lsizeMatch = stderrLine.match(/Lsize=(\d+(?:\.\d+)?|\w+)/);
      const bitrateMatch = stderrLine.match(/bitrate=(\d+\.?\d*)\s*kbits?\/s/i);

      if (lsizeMatch && lsizeMatch[1] !== 'N/A') {
        const bytes = parseInt(lsizeMatch[1], 10);
        if (!isNaN(bytes)) {
          this.trafficStats.sessionBytes = Math.max(bytes, this.trafficStats.sessionBytes);
        }
      }

      if (bitrateMatch) {
        this.trafficStats.bitrateKbps = parseFloat(bitrateMatch[1]);
      }

      if (lsizeMatch || bitrateMatch) {
        this.trafficStats.updatedAt = new Date().toISOString();
      }
    } catch (err) {
      // 解析失败无需中断流程
    }
  }

  getTrafficStats() {
    return {
      sessionBytes: this.trafficStats.sessionBytes,
      bitrateKbps: this.trafficStats.bitrateKbps,
      updatedAt: this.trafficStats.updatedAt,
      startedAt: this.trafficStats.startedAt,
      running: this.ffmpegCommand !== null && !this.stoppedManually,
    };
  }

  start(streamUrl) {
    if (!streamUrl) {
      throw new Error('缺少输入流地址');
    }

    if (!this.targetUrls.length) {
      throw new Error('缺少推流目标地址');
    }

    this.stop();
    this.stoppedManually = false;

    // 重置本次会话统计
    this.trafficStats = {
      sessionBytes: 0,
      bitrateKbps: 0,
      updatedAt: null,
      startedAt: new Date().toISOString(),
    };

    const cmd = FFmpeg(streamUrl);

    // 设置输入选项
    const inputOptions = this.buildInputOptions(streamUrl);
    cmd.inputOptions(inputOptions);

    // 设置输出选项
    const outputOptions = this.buildOutputOptions();
    cmd.outputOptions(outputOptions);

    // 处理输出目标 - 每个目标独立输出（避免 tee muxer 兼容性问题）
    cmd.outputOptions('-f', 'flv').output(this.targetUrls[0]);
    for (let i = 1; i < this.targetUrls.length; i++) {
      cmd.output(this.targetUrls[i]).outputOptions([...outputOptions, '-f', 'flv']);
    }

    // 监听事件
    let startLogged = false;
    cmd.on('start', (cmdline) => {
      if (!startLogged) {
        startLogged = true;
        this.onStart(cmdline);
      }
    });

    cmd.on('progress', (progress) => {
      this.parseProgressData(progress);
    });

    cmd.on('error', (err) => {
      this.ffmpegCommand = null;
      if (this.killTimeout) {
        clearTimeout(this.killTimeout);
        this.killTimeout = null;
      }
      this.onError(err);
    });

    cmd.on('end', () => {
      this.ffmpegCommand = null;
      if (this.killTimeout) {
        clearTimeout(this.killTimeout);
        this.killTimeout = null;
      }
      if (!this.stoppedManually) {
        this.onEnd();
      }
    });

    cmd.on('close', () => {
      if (this.killTimeout) {
        clearTimeout(this.killTimeout);
        this.killTimeout = null;
      }
      if (!this.stoppedManually && this.ffmpegCommand === cmd) {
        this.ffmpegCommand = null;
      }
    });

    this.ffmpegCommand = cmd;
    cmd.run();

    return cmd;
  }

  captureFrame(streamUrl, options = {}) {
    if (!streamUrl) {
      throw new Error('流不可用: 缺少输入流地址');
    }

    const timeout = options.timeout || 20000; // 默认 20 秒超时
    const platform = options.platform || 'unknown';

    return new Promise((resolve, reject) => {
      const cmd = FFmpeg(streamUrl);

      // 设置输入选项 - 优化用于快速帧提取
      const inputOptions = this.buildInputOptions(streamUrl);
      // 添加用于快速获取帧的参数
      inputOptions.push('-an');     // 禁用音频
      inputOptions.push('-sn');     // 禁用字幕
      cmd.inputOptions(inputOptions);

      // 设置输出选项 - 针对平台优化
      let outputOptions = [];
      
      if (platform === 'bilibili') {
        // B站特定优化：更激进的关键帧提取，降低质量以减小文件大小
        outputOptions = [
          '-frames:v', '1',
          '-f', 'image2pipe',
          '-c:v', 'mjpeg',
          '-q:v', '5',              // 降低质量，减小文件大小（避免 Telegram 413 错误）
        ];
      } else if (platform === 'douyu') {
        // 斗鱼特定优化
        outputOptions = [
          '-frames:v', '1',
          '-f', 'image2pipe',
          '-c:v', 'mjpeg',
          '-q:v', '5',
        ];
      } else {
        // 默认参数
        outputOptions = [
          '-frames:v', '1',
          '-f', 'image2pipe',
          '-c:v', 'mjpeg',
          '-q:v', '5',
        ];
      }

      cmd.outputOptions(outputOptions);

      const chunks = [];
      let settled = false;
      let startTime = Date.now();

      // 设置超时
      const timeoutHandle = setTimeout(() => {
        const elapsed = Date.now() - startTime;
        fail(new Error(`ffmpeg 截图超时: ${elapsed}ms 内未获取到帧数据 (平台: ${platform})`));
      }, timeout);

      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        try {
          cmd.kill('SIGKILL');
        } catch (e) {
          // 忽略错误
        }
        reject(error);
      };

      const succeed = (buffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        const elapsed = Date.now() - startTime;
        resolve(buffer);
      };

      cmd.on('start', (commandLine) => {
        console.log(`[FFmpegService] 截图命令已启动 (平台: ${platform}, 超时: ${timeout}ms)`);
        // 从 FFmpeg 子进程的 stdout 捕获图像数据
        const proc = cmd.ffmpegProc;
        if (proc && proc.stdout) {
          proc.stdout.on('data', (chunk) => {
            chunks.push(Buffer.from(chunk));
          });
          proc.stdout.on('error', (err) => {
            console.error(`[FFmpegService] 输出流错误: ${err.message}`);
          });
        }
      });

      cmd.on('error', (err) => {
        console.error(`[FFmpegService] FFmpeg进程错误: ${err.message}`);
        fail(new Error(`FFmpeg错误: ${err.message}`));
      });

      cmd.on('end', () => {
        const image = Buffer.concat(chunks);
        if (!image.length) {
          const elapsed = Date.now() - startTime;
          console.warn(`[FFmpegService] 未获取到帧数据 (经过 ${elapsed}ms, 平台: ${platform})`);
          fail(new Error('未获取到有效帧 - 可能是关键帧延迟或流不稳定'));
          return;
        }
        const elapsed = Date.now() - startTime;
        console.log(`[FFmpegService] 成功获取截图 - 大小: ${image.length} 字节 (耗时: ${elapsed}ms)`);
        succeed(image);
      });

      // 输出到 stdout（pipe:1），通过 start 事件中的 proc.stdout 捕获
      cmd.output('pipe:1');
      cmd.run();
    });
  }

  stop() {
    if (this.ffmpegCommand) {
      this.stoppedManually = true;
      const cmdRef = this.ffmpegCommand;
      this.ffmpegCommand = null;

      // 先尝试优雅退出
      cmdRef.kill('SIGINT');

      // 设置超时：5秒后若进程还未退出，强制 SIGKILL
      if (this.killTimeout) {
        clearTimeout(this.killTimeout);
      }
      this.killTimeout = setTimeout(() => {
        console.log(`[FFmpegService] FFmpeg 进程未能响应 SIGINT，正在强制终止...`);
        try {
          cmdRef.kill('SIGKILL');
        } catch (err) {
          // 进程可能已退出，忽略错误
        }
        this.killTimeout = null;
      }, 5000);
    } else if (this.killTimeout) {
      clearTimeout(this.killTimeout);
      this.killTimeout = null;
    }
  }
}

module.exports = FFmpegService;
