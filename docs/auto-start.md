# StreamOps 自动启动与守护脚本教程 (auto-start.sh)

`scripts/auto-start.sh` 是一个轻量级的进程守护脚本。在移除 PM2 之后，该脚本可作为进程守护的替代方案，用于在生产环境中保证直播转播系统（Node.js 服务）的持续运行。

为了保持脚本的纯粹性与极简化，脚本本身**不再包含内部日志重定向逻辑**，所有的标准输出 (`stdout`) 和标准错误 (`stderr`) 都会直接输出到控制台。这种设计让用户可以自由选择如何处理日志（例如使用 shell 重定向或系统级守护服务）。

---

## 🛠️ 工作原理

该脚本通过一个简单的 `while true` 循环来实现进程守护，其核心逻辑如下：

1. **工作目录切换**：自动切换到项目根目录，确保相对路径（如数据库路径）能正确解析。
2. **启动服务**：启动 `node main.js`。
3. **异常重启**：
   - 监听 Node.js 进程的退出状态码 (`EXIT_CODE`)。
   - 如果退出码为 `0`（正常退出，如收到手动停止信号），则终止守护循环，干净利落地退出。
   - 如果退出码不为 `0`（异常崩溃、网络中断或进程报错），脚本会在等待 5 秒后自动重启 `node main.js`。

---

## 🚀 使用指南

### 1. 赋予执行权限
在使用脚本前，需要确保其在 Linux/macOS 环境下具有执行权限：
```bash
chmod +x scripts/auto-start.sh
```

### 2. 前台运行（测试/调试用）
如果要在控制台中测试守护逻辑，可以直接运行：
```bash
./scripts/auto-start.sh
```
此时终端会挂起，所有的实时日志直接打印在屏幕上。你可以按下 `Ctrl + C` 退出。

### 3. 后台运行并输出日志到文件
如果需要在后台运行，且手动收集日志，可以使用 Linux 标准的重定向语法：
```bash
# 创建日志文件夹
mkdir -p logs

# 在后台运行守护脚本，并将标准输出与错误全部重定向到日志文件
nohup ./scripts/auto-start.sh > logs/auto-start.log 2>&1 &
```
* **停止服务**：可以通过以下命令定位并结束脚本和 Node 进程：
  ```bash
  # 查找并终止守护脚本
  pkill -f auto-start.sh
  # 终止 Node 进程
  pkill -f "node main.js"
  ```
* **监控日志**：
  ```bash
  tail -f logs/auto-start.log
  ```

---

## ⚙️ 最佳实践：结合 Systemd 实现开机自启与日志管理（强烈推荐）

将此脚本交给 Systemd 是最完美的解决方案。Systemd 会自动收集输出到控制台的日志，并通过系统的 `journald` 对日志进行自动压缩和截断（防止撑爆磁盘）。

### 1. 创建服务配置文件
在 `/etc/systemd/system/` 目录下创建 `stream-to-rtmp.service` 文件（注意修改 `WorkingDirectory` 为您项目实际部署的绝对路径）：

```ini
[Unit]
Description=StreamOps Relay Bot Daemon
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/path/to/stream-to-rtmp
ExecStart=/bin/sh scripts/auto-start.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### 2. 管理系统服务
```bash
# 重新加载 Systemd 配置以识别新服务
systemctl daemon-reload

# 设置开机自启
systemctl enable stream-to-rtmp.service

# 启动服务
systemctl start stream-to-rtmp.service

# 查看服务运行状态
systemctl status stream-to-rtmp.service

# 查看服务日志（支持自动轮转与查询）
journalctl -u stream-to-rtmp.service -f
```
