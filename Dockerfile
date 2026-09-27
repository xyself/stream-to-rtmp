FROM node:25-alpine

# 安装 FFmpeg（Alpine 使用 apk）；tzdata 用于容器时区
RUN apk add --no-cache ffmpeg tzdata

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/data

ENV NODE_ENV=production \
    DATABASE_PATH=/app/data/data.db \
    PORT=8080 \
    TZ=Asia/Shanghai

# exec 让 node 直接成为 PID 1：docker stop 的 SIGTERM 能送达 node，优雅关闭才走得通
CMD ["sh", "-c", "node scripts/restore.js && exec node main.js"]

# 容器健康检查：alpine 自带 busybox wget；/health 只看进程存活
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=60s \
  CMD wget -q -O /dev/null http://localhost:8080/health || exit 1