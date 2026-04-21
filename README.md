# stream-to-rtmp

通过 Telegram 机器人管理直播转推任务，将 Bilibili / 斗鱼 / 抖音直播自动拉取并推送到 YouTube 或任意 RTMP 目的地，支持单房间多路输出。

## 功能

- Telegram 机器人全程控制，无需服务器面板
- 支持 Bilibili、斗鱼、抖音平台
- 单房间多路 RTMP 同时输出
- 开播/断流/错误自动 Telegram 通知（去重，不轰炸）
- 开播时自动截图发送
- 未开播轮询（2 分钟）、断流自动重试（30 秒）
- SQLite 持久化，支持 GitHub Gist 数据备份同步
- Docker / 云平台可直接部署，资源占用低

## 环境要求

- Node.js 25+
- FFmpeg（容器内已内置）
- Telegram Bot Token（[@BotFather](https://t.me/BotFather) 获取）

## 环境变量

复制 `.env.example` 为 `.env` 并填写：

```env
# 必填
TG_TOKEN=your_bot_token
TG_CHAT_ID=your_chat_id          # 支持逗号分隔多个 ID

# 数据库路径（本地开发用此值；Docker 容器内由 Dockerfile 自动覆盖为 /app/data/data.db）
DATABASE_PATH=./data/data.db

# GitHub Gist 同步（可选，不填则跳过）
GIST_TOKEN=github_pat_xxxxxxxx   # 需要 gist scope
GIST_ID=abc123def456             # Gist URL 末尾的 ID

# Web 面板（可选，不填则不启动）
# PORT=8000

# 自定义 FFmpeg 路径（可选）
# FFMPEG_PATH=/usr/bin/ffmpeg
```

## 本地启动

```bash
npm install
cp .env.example .env
# 编辑 .env 填入必填项
node main.js
```

## Docker 部署

```bash
# 构建并启动
docker compose up -d --build

# 查看日志
docker compose logs -f
```

数据库文件持久化在 `./data/data.db`，通过 `volumes: - ./data:/app/data` 挂载。

## 云平台部署（Koyeb / Railway 等）

1. 配置环境变量（参考上方列表）
2. 挂载持久卷到 `/app/data`（否则重启数据丢失）
3. 配置 Gist 同步变量，容器启动时自动从 Gist 恢复数据

启动命令已内置：`node scripts/restore.js && node main.js`

## 使用说明

1. 给机器人发送 `/start`
2. 点击 **添加房间** → 输入平台、房间号、RTMP 地址
3. 在 **房间管理** 里启停任务、追加多路 RTMP 或删除
4. 在 **管理面板** 查看运行状态和实时码率
5. 开播时机器人自动发送通知和截图

## 目录结构

```
main.js                  启动入口
scripts/restore.js       容器启动前从 Gist 恢复数据
src/
  bot/                   Telegram 机器人与命令处理
  core/                  调度器与推流状态机
  db/                    SQLite 封装 + Gist 同步
  engines/               平台 API（Bilibili / 斗鱼 / 抖音）
  services/              FFmpeg 子进程封装
```
