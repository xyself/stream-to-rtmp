# StreamOps 🚀 - 多路直播转播系统

基于 Node.js 和 FFmpeg 的自动化直播转播系统，支持从 Bilibili、斗鱼、抖音等平台实时抓取直播流并推送到 YouTube/RTMP 目标。通过 Telegram 机器人进行全功能远程控制，并配备现代化的 Web 监控面板。

## ✨ 核心特性

- 📱 **Telegram 全功能控制**：无需命令行，通过聊天机器人即可完成房间添加、任务启停、状态查询及参数微调。
- 📊 **现代化 Web 面板**：实时监控各路推流的码率、运行时间、错误统计及主播信息。
- 🛠️ **精细化资源监控**：实时查看服务器及本服务的 CPU/内存占用情况。
- 🖼️ **图文监控**：推流启动时及查询状态时，自动抓取直播间实时关键帧/封面。
- 🔄 **高可靠性**：支持断流自动重连、画面冻结检测重启、下播自动释放进程。
- ☁️ **云端同步**：内置 Gist 同步功能，实现跨设备配置备份与恢复。
- ⚙️ **灵活转码**：支持全量视频转码 (libx264) 或 极速拷贝模式 (copy)。
1
## 🚀 快速开始

### 1. 环境准备
- Node.js 25.8.2+
- FFmpeg (系统中已安装或通过 `.env` 指定路径)
- 一个 Telegram Bot Token (通过 @BotFather 获取)

### 2. 安装
```bash
git clone <repository-url>
cd stream-to-rtmp
npm install
```

### 3. 配置
在根目录创建 `.env` 文件：
```env
TG_TOKEN=你的机器人Token
TG_CHAT_ID=你的Telegram数字ID (多个用逗号分隔)
FFMPEG_PATH=ffmpeg (或具体路径)
DATABASE_PATH=./data/data.db
GIST_TOKEN=你的GithubToken (可选)
GIST_ID=你的GistID (可选)
```

### 4. 运行
```bash
npm start
```

## 🖥️ 管理入口

- **Telegram Bot**: 发送 `/start` 调出控制中心。
- **Web Dashboard**: 访问 `http://localhost:3000` 查看实时监控面板。

## 🛠️ 技术架构

- **Runtime**: Node.js (grammY + Express)
- **Database**: SQLite (通过 `src/db/` 管理)
- **Engine**: 插件化设计，支持快速扩展新平台
- **Streaming**: FFmpeg 子进程封装 (FFmpegService)

## 📝 开发者指南

详见 [AGENTS.md](AGENTS.md) 了解代码结构与开发规范。

## 📜 许可证
ISC
