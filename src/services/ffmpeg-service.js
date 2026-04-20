const FFmpeg = require('fluent-ffmpeg');

class FFmpegService {
  constructor({
    roomId,
    targetUrl,
    targetUrls,
    inputHeaders = {},
    globalOutputOptions = [],
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
    this.onStart = onStart;
    this.onProgress = onProgress;
    this.onError = onError;
    this.onEnd = onEnd;
    this.ffmpegCommand = null;
    this.stoppedManually = false;
  }

  buildInputOptions(streamUrl) {
    const options = [
      '-loglevel', 'error',
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
    const options = [
      '-c:v', 'copy',
      '-c:a', 'aac',
    ];

    if (Array.isArray(this.globalOutputOptions) && this.globalOutputOptions.length > 0) {
      options.push(...this.globalOutputOptions);
    }

    return options;
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

    const cmd = FFmpeg(streamUrl);

    // 设置输入选项
    const inputOptions = this.buildInputOptions(streamUrl);
    cmd.inputOptions(inputOptions);

    // 设置输出选项
    const outputOptions = this.buildOutputOptions();
    cmd.outputOptions(outputOptions);

    // 处理输出目标
    if (this.targetUrls.length === 1) {
      // 单个输出
      cmd.outputOptions('-f', 'flv').output(this.targetUrls[0]);
    } else {
      // 多个输出 - 使用 tee muxer
      const tee = this.targetUrls.map((target) => `[f=flv]${target}`).join('|');
      cmd.outputOptions('-f', 'tee').output(tee);
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
      this.onProgress(progress);
    });

    cmd.on('error', (err) => {
      this.ffmpegCommand = null;
      this.onError(err);
    });

    cmd.on('end', () => {
      this.ffmpegCommand = null;
      if (!this.stoppedManually) {
        this.onEnd();
      }
    });

    cmd.on('close', () => {
      if (!this.stoppedManually && this.ffmpegCommand === cmd) {
        this.ffmpegCommand = null;
      }
    });

    this.ffmpegCommand = cmd;
    cmd.run();

    return cmd;
  }

  captureFrame(streamUrl) {
    if (!streamUrl) {
      throw new Error('流不可用: 缺少输入流地址');
    }

    return new Promise((resolve, reject) => {
      const cmd = FFmpeg(streamUrl);

      // 设置输入选项
      const inputOptions = this.buildInputOptions(streamUrl);
      cmd.inputOptions(inputOptions);

      // 设置输出选项 - 单帧 JPEG
      cmd.outputOptions([
        '-frames:v', '1',
        '-f', 'image2',
        '-vcodec', 'mjpeg',
      ]);

      const chunks = [];
      let settled = false;
      let startedStream = false;

      // 设置超时
      const timeout = setTimeout(() => {
        fail(new Error('ffmpeg 执行失败: 截图操作超时'));
      }, 10000);

      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
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
        clearTimeout(timeout);
        resolve(buffer);
      };

      cmd.on('start', () => {
        startedStream = true;
      });

      cmd.on('error', (err) => {
        fail(new Error(`流不可用: ${err.message}`));
      });

      cmd.on('end', () => {
        const image = Buffer.concat(chunks);
        if (!image.length) {
          fail(new Error('未获取到有效帧'));
          return;
        }
        succeed(image);
      });

      // 使用 pipe 输出到内存
      const stream = cmd.output('pipe:1');
      stream.on('data', (chunk) => {
        if (startedStream) {
          chunks.push(Buffer.from(chunk));
        }
      });

      cmd.run();
    });
  }

  stop() {
    if (this.ffmpegCommand) {
      this.stoppedManually = true;
      this.ffmpegCommand.kill('SIGINT');
      this.ffmpegCommand = null;
    }
  }
}

module.exports = FFmpegService;
