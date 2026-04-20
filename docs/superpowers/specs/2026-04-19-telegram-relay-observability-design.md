# 2026-04-19 Telegram relay observability design

## 目标

在不大改现有架构的前提下，增强 Telegram 控制面的可观测性与诊断能力，具体包括：

1. 真实流量统计：让“流量查看”展示 FFmpeg 实际推流过程中的累计流量、本次会话流量、当前码率、最近更新时间。
2. 截图功能：在 Telegram 房间详情页新增“发送截图”，使用 FFmpeg 从当前可用流抓取单帧图片并回传到 Telegram。
3. 保留现有 A 路线：不重构调度器/房间引擎，只在 manager / ffmpeg service / bot views 上做最小侵入增强。

## 已确认现状

- Telegram 房间详情页已存在“刷新检测”按钮，调用 `scheduler.refreshTask(task)` 立即停止并重建 manager。
- 实际转发链路为：`room.getStreamUrl()` -> `ffmpeg.start(streamUrl)` -> 推送到 RTMP/RTMPS 目标。
- `scheduler.getTrafficStats()` 已尝试读取 `manager.getTrafficStats()`，但当前 `StreamManager` 未实现该接口，因此流量面板实际上是占位值。
- 当前代码库没有任何截图发送链路，也没有 `sendPhoto` / `replyWithPhoto` 相关实现。

## 方案选择

采用 A + 真实流量统计 + 截图功能，其中截图实现采用“方案 1”：

- 使用 FFmpeg 对当前可用流抓取单帧图片。
- 优先使用运行中 manager 当前转发所使用的流地址；若当前无活动流，则重新向 `room.getStreamUrl()` 取源流并截图。
- 不引入浏览器截图或额外视频解析库。

## 设计

### 1. 真实流量统计

在 `FFmpegService` 中增加对 FFmpeg `stderr` 进度输出的解析，维护内部运行态：

- `sessionBytes`: 当前 FFmpeg 会话已发送字节数。
- `bitrateKbps`: 当前码率（以 kbps 表示）。
- `updatedAt`: 最近一次收到有效进度信息的时间。
- `startedAt`: 当前会话开始时间。

在 `StreamManager` 中维护跨会话累计统计：

- `totalBytes`: 累计发送字节（会话结束后将本次会话流量并入总量）。
- `sessionBytes`: 透传当前 FFmpegService 的会话流量。
- `bitrateKbps`: 透传当前 FFmpegService 的实时码率。
- `updatedAt`: 透传最后更新时间。
- `running`: 当前 FFmpeg 是否在运行。
- `lastRefreshAt`: 最近一次显式 refresh/reconnect 的时间。

`scheduler.getTrafficStats()` 继续汇总任务列表，但优先从运行中的 manager 获取真实值；未运行任务维持 0 / null。

### 2. Telegram 房间详情增强

在 `views.renderTaskDetail()` 中补充：

- 流量摘要（本次 / 累计 / 当前码率）
- 最近更新时间
- 最近刷新时间（若有）
- FFmpeg 运行态

保留原有错误展示与 RTMP 列表。

### 3. 截图功能

新增 `FFmpegService.captureFrame(streamUrl, options)` 静态能力，内部调用 ffmpeg：

- 输入：流地址、请求头、输出文件路径或临时文件路径。
- 输出：生成的 JPEG/PNG 文件路径。
- 失败时抛出明确错误。

抓图命令目标：

- 最小化开销，只拉一帧。
- 设置超时，防止 Telegram 回调卡死。
- 继承与正常拉流相同的请求头（Referer / User-Agent）。

`StreamManager` 新增：

- `currentStreamUrl`: FFmpeg 成功 start 时记录本次使用的输入流地址。
- `captureSnapshot()`: 
  1. 如果当前 manager 正在运行且持有 `currentStreamUrl`，优先对该 URL 抓图。
  2. 否则调用 `room.getStreamUrl()` 获取当前源流后抓图。
  3. 返回截图文件路径与来源类型（running-stream / fresh-source）。

### 4. Scheduler 对外接口

新增：

- `scheduler.captureTaskSnapshot(task)`：
  - 若该 task 当前有 running manager，则直接委托 manager 截图。
  - 若没有 running manager，但 task 为 ENABLED 或 DISABLED，也允许临时构建只用于截图的 manager 或临时解析 room 源流后截图。

为避免副作用，优先不把截图请求混进正常 `runningManagers` 生命周期；若任务未运行，则构建临时 manager，仅执行截图，不注册进 `runningManagers`。

### 5. Telegram Bot 交互

在房间详情键盘新增：

- `📸 发送截图`

点击后：

1. `answerCallbackQuery('正在抓取截图…')`
2. 调用 `scheduler.captureTaskSnapshot(task)`
3. 成功：通过 Telegram 发送图片，caption 说明来源（当前转发流 / 最新源流）
4. 失败：弹出明确错误，例如“当前无法获取直播源，截图失败”

## 错误处理

- FFmpeg 截图失败：返回简短错误，不影响主转发进程。
- 当前任务不存在：沿用现有“任务已不存在”。
- 源流不可获取：明确区分“未开播/源流解析失败/ffmpeg 抓图失败”。
- 截图临时文件发送后删除，避免磁盘堆积。

## 测试计划

遵循 TDD：

1. 先为 `FFmpegService` 补进度解析与截图命令构建测试。
2. 再为 `StreamManager` 补真实流量聚合、`currentStreamUrl`、截图优先级测试。
3. 为 `Scheduler` 补 `captureTaskSnapshot()` 的运行中/未运行分支测试。
4. 为 `Bot` 补房间详情按钮与截图回调测试。
5. 为 `views` 补任务详情中的流量/截图状态展示测试。

## 范围边界

本轮不做：

- 浏览器截图
- 视频预览或连续缩略图
- 新的前端管理后台
- 大规模重构 room / scheduler 架构

## 规格自检

- 无 TODO / 占位项。
- 与用户确认一致：真实流量统计 + 截图功能，截图采用 FFmpeg 单帧抓图方案。
- 范围可由单次实现计划覆盖。
