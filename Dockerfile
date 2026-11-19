# 默认使用 Node.js 26 + Debian Bookworm Slim（glibc 环境）：
# 1. 原生支持最新 Node 26（node:sqlite / fetch / 新版 V8），亦可通过 --build-arg NODE_VERSION=22 切换
# 2. 原生兼容 BtbN 官方最新 FFmpeg 9.0 静态构建（彻底规避 Alpine musl 兼容问题与老旧发行版 FFmpeg）
ARG NODE_VERSION=26
FROM node:${NODE_VERSION}-bookworm-slim

ARG INSTALL_LATEST_FFMPEG=1

# 安装基础依赖：ca-certificates(HTTPS)、tzdata(时区)、xz-utils(解压官方 .tar.xz)、ffmpeg(离线兜底)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    tzdata \
    xz-utils \
    ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi

COPY . .

RUN mkdir -p /app/data /app/logs /app/bin

# 构建阶段默认内置最新官方 FFmpeg 9.0 到 /app/bin/ffmpeg（若构建机无外网则自动回退系统 apt ffmpeg，不阻塞构建）
RUN if [ "$INSTALL_LATEST_FFMPEG" = "1" ]; then \
      node scripts/update-ffmpeg.js || echo "WARN: 离线/拉取失败，将使用系统内置 ffmpeg"; \
    fi

ENV NODE_ENV=production \
    NODE_OPTIONS="--max-semi-space-size=2 --max-old-space-size=192 --v8-pool-size=2" \
    UV_THREADPOOL_SIZE=2 \
    DATABASE_PATH=/app/data/data.db \
    PORT=3000 \
    BIND_HOST=0.0.0.0 \
    TZ=Asia/Shanghai \
    AUTO_DOWNLOAD_FFMPEG=0

EXPOSE 3000

# main.js 启动时会自动执行 restoreOnce()；配合 docker compose init: true 回收僵尸进程并优雅接收 SIGTERM
CMD ["node", "main.js"]

# 零外部依赖健康检查：自动跟随环境变量 PORT，无需 wget/curl
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=45s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"