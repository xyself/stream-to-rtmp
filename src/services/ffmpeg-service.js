const { spawn } = require('child_process');

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
    this.process = null;
    this.stoppedManually = false;
  }

  buildInputArgs(streamUrl) {
    const args = [
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
      args.push('-headers', headerString);
    }

    args.push('-i', streamUrl);
    return args;
  }

  buildOutputArgs() {
    const args = [
      '-c:v', 'copy',
      '-c:a', 'aac',
    ];

    if (Array.isArray(this.globalOutputOptions) && this.globalOutputOptions.length > 0) {
      args.push(...this.globalOutputOptions);
    }

    if (this.targetUrls.length === 1) {
      args.push('-f', 'flv', this.targetUrls[0]);
      return args;
    }

    const tee = this.targetUrls.map((target) => `[f=flv]${target}`).join('|');
    args.push('-f', 'tee', tee);
    return args;
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

    const args = [
      ...this.buildInputArgs(streamUrl),
      ...this.buildOutputArgs(),
    ];

    const child = spawn('ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.process = child;

    child.stdout?.on('data', (chunk) => {
      this.onProgress({ type: 'stdout', message: chunk.toString() });
    });

    child.stderr?.on('data', (chunk) => {
      const message = chunk.toString();
      this.onProgress({ type: 'stderr', message });
    });

    child.once('spawn', () => {
      this.onStart(`ffmpeg ${args.join(' ')}`);
    });

    child.once('error', (error) => {
      this.process = null;
      this.onError(error);
    });

    child.once('close', (code, signal) => {
      const manualStop = this.stoppedManually;
      this.process = null;

      if (manualStop) {
        this.onEnd();
        return;
      }

      if (code === 0 || signal === 'SIGINT') {
        this.onEnd();
        return;
      }

      this.onError(new Error(`FFmpeg exited with code ${code}${signal ? ` (signal: ${signal})` : ''}`));
    });

    return child;
  }

  captureFrame(streamUrl) {
    if (!streamUrl) {
      throw new Error('流不可用: 缺少输入流地址');
    }

    return new Promise((resolve, reject) => {
      const args = [
        ...this.buildInputArgs(streamUrl),
        '-frames:v', '1',
        '-f', 'image2',
        '-vcodec', 'mjpeg',
        'pipe:1',
      ];

      const child = spawn('ffmpeg', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const chunks = [];
      let stderr = '';
      let settled = false;
      
      // 设置超时，避免流异常时长时间阻塞
      const timeout = setTimeout(() => {
        fail(new Error('ffmpeg 执行失败: 截图操作超时'));
        try {
          child.kill('SIGKILL');
        } catch (e) {
          // 忽略终止过程中的错误
        }
      }, 10000); // 10秒超时

      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };

      const succeed = (buffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(buffer);
      };

      child.stdout?.on('data', (chunk) => {
        chunks.push(Buffer.from(chunk));
      });

      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.once('error', (error) => {
        fail(new Error(`流不可用: ${error.message}`));
      });

      child.once('close', (code, signal) => {
        if (code !== 0) {
          const detail = stderr.trim() || `退出码 ${code}${signal ? `, 信号 ${signal}` : ''}`;
          fail(new Error(`ffmpeg 执行失败: ${detail}`));
          return;
        }

        const image = Buffer.concat(chunks);
        if (!image.length) {
          fail(new Error('未获取到有效帧'));
          return;
        }

        succeed(image);
      });
    });
  }

  stop() {
    if (this.process) {
      this.stoppedManually = true;
      this.process.kill('SIGINT');
      this.process = null;
    }
  }
}

module.exports = FFmpegService;
