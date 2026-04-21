# Bilibili / Douyu 直播转推到 YouTube / 多路 RTMP

通过 Telegram 机器人管理直播间任务，把 B 站或斗鱼直播转推到 YouTube 或其他 RTMP 目的地。项目已整理为可直接启动部署的形态，默认入口为 `main.js`。

## 功能

- Telegram 机器人控制台
- 支持 Bilibili / 斗鱼房间
- 单房间多 RTMP 输出
- SQLite 持久化任务
- FFmpeg 自动拉流转推
- PM2 / Docker 可直接部署

## 环境要求

- Node.js 25.8.2+
- ffmpeg
- Telegram Bot Token

## 环境变量

创建 `.env`：

```env
TG_TOKEN=*** Telegram Bot Token
TG_CHAT_ID=允许操作机器人的 Chat ID
FFMPEG_PATH=ffmpeg
# SQLite 数据文件路径；如使用 Docker，建议挂载到 /app/data
DATABASE_PATH=./data/data.db
```

可参考 `.env.example`。

## 本地启动

```bash
npm install
cp .env.example .env
# 编辑 .env，填入 TG_TOKEN / TG_CHAT_ID
node main.js
```

## PM2 部署

```bash
npm install
pm2 start ecosystem.config.js
pm2 logs live-relay-bot
```

## Docker 部署

先准备 `.env` 文件，然后构建镜像：

```bash
docker build -t stream-to-rtmp .
```

直接启动部署（推荐）：

```bash
docker compose up -d --build
```

或手动运行：

```bash
docker run -d \
  --name stream-to-rtmp \
  --restart unless-stopped \
  --env-file .env \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/logs:/app/logs \
  stream-to-rtmp
```

容器启动后会直接执行 `node main.js`，可直接启动部署；数据库与日志建议通过挂载卷持久化。

## 目录说明

- `main.js`：统一启动入口
- `src/bot`：Telegram 机器人
- `src/core`：调度器与转推管理器
- `src/db`：SQLite 存储
- `src/services/ffmpeg-service.js`：FFmpeg 封装

## 使用说明

1. 给机器人发送 `/start`
2. 点击“管理面板”查看总览
3. 点击“添加房间”并输入房间号、平台、主 RTMP 地址
4. 按需追加更多 RTMP 输出
5. 在“房间管理”里启停、加 RTMP 或删除任务
6. 在“流量查看”里确认每个房间的累计流量与实时码率
