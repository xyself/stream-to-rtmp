FROM node:25

# 安装 FFmpeg（node:25 基于 Debian，ffmpeg-static 可正常工作）
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/data

ENV NODE_ENV=production \
    DATABASE_PATH=/app/data/data.db \
    PORT=8000

CMD ["node", "main.js"]