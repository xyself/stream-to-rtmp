FROM node:25-alpine

# 安装 FFmpeg（Alpine 使用 apk）
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/data

ENV NODE_ENV=production \
    DATABASE_PATH=/app/data/data.db \
    PORT=8000

CMD ["sh", "-c", "node scripts/restore.js && node main.js"]