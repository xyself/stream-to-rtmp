# 2026-04-19 Node25 破坏式重构设计

## 目标

对 `bilibili-live-forward-youtube-master` 做一次明确的破坏式重构，目标如下：

1. 运行时统一到 **Node.js 25**。
2. **彻底弃用旧 DB 文件与 SQLite 持久化契约**。
3. 引入更适合本项目的轻量持久化方案，优先可读、可恢复、可直接手工编辑。
4. 重写机器人控制层，让“房间管理 / 状态查看 / 流量查看 / 启停控制”逻辑更清晰。
5. 保留核心业务能力：
   - 直播间解析（Bilibili / Douyu）
   - FFmpeg 拉流推流
   - 多 RTMP 目标输出
   - Telegram 管理入口

---

## 现状扫描结论

### 1. 当前系统的主要耦合点

- `src/db/index.js`：当前已经使用 `node:sqlite`，并且还承担了 JSON → SQLite 的迁移逻辑。
- `src/core/manager.js`：直接依赖 `db`，在运行过程中写错误状态、补全目标地址。
- `src/core/scheduler.js`：应承担任务生命周期管理，但当前整体架构仍偏“脚本式”。
- `src/bot/index.js`：功能已扩张，承担了控制台、会话输入、状态展示等多种职责。
- `test/*.test.js`：测试大量绑定旧契约，尤其是 SQLite、`DATABASE_PATH`、`ecosystem.config.js`、旧部署文案。

### 2. 可以直接废弃的旧契约

这次重构明确允许破坏式变更，因此以下内容可以直接废弃：

- SQLite 文件头 / `node:sqlite` 持久化契约
- `DATABASE_PATH=./data/data.db` 这一旧默认值
- 任何 JSON → SQLite 自动迁移逻辑
- `ecosystem.config.js` / PM2 ready signal 兼容层
- 旧测试里对 `SQLite format 3\0`、`/app/data/data.db`、`main.js + pm2` 的强绑定断言

### 3. 保留的核心域模型

保留并重构以下业务对象：

- **RelayTask**：一个直播源房间的转播任务
- **RelayTarget**：一个任务对应的一个 RTMP 输出地址
- **RuntimeSession**：当前运行中的 FFmpeg / 轮询 / 重试状态
- **PlatformEngine**：平台解析能力（bilibili / douyu）

---

## 新持久化方案

## 方案选择

本次默认采用：

- `data/state.json`：当前系统真实状态快照
- `data/events.jsonl`：事件追加日志（便于审计和恢复）

而不是继续使用 SQLite。

### 选择理由

1. 项目数据量很小，主要是配置型数据，不是高并发事务型业务。
2. Telegram bot 运维场景下，人工直接查看或修复 JSON 比操作 sqlite 更方便。
3. Node 25 下直接使用 `fs/promises` + 原子写入即可稳定满足需求。
4. 后续如果要迁移到别的存储（Postgres/Redis/Cloud KV），从文件状态模型迁出更简单。

## 持久化文件结构

### `data/state.json`

```json
{
  "version": 2,
  "updatedAt": "2026-04-19T00:00:00.000Z",
  "tasks": [
    {
      "id": "task_001",
      "platform": "bilibili",
      "roomId": "12345",
      "status": "enabled",
      "targets": [
        {
          "id": "target_001",
          "url": "rtmp://a/live/stream"
        }
      ],
      "lastError": null,
      "createdAt": "2026-04-19T00:00:00.000Z",
      "updatedAt": "2026-04-19T00:00:00.000Z"
    }
  ]
}
```

### `data/events.jsonl`

每行一个 JSON 事件，例如：

```json
{"type":"task.created","taskId":"task_001","at":"2026-04-19T00:00:00.000Z"}
{"type":"target.added","taskId":"task_001","targetId":"target_001","at":"2026-04-19T00:00:05.000Z"}
{"type":"relay.error","taskId":"task_001","message":"STREAM_ENDED","at":"2026-04-19T00:01:00.000Z"}
```

## 写入策略

- 状态写入采用**原子覆盖**：先写临时文件，再 `rename`
- 事件日志采用**追加写入**
- 启动时若 `state.json` 缺失，则自动初始化
- **不做旧 DB 自动迁移**：用户已明确旧 DB 弃用，允许删除

---

## 新架构设计

## 分层

### 1. `src/storage/`
负责状态持久化与查询，不关心 Telegram / FFmpeg。

建议文件：

- `src/storage/file-store.js`
- `src/storage/schema.js`
- `src/storage/index.js`

职责：

- 加载 / 初始化状态
- 原子保存状态
- 追加事件日志
- 提供任务与 target 的 CRUD

### 2. `src/domain/`
负责纯业务规则。

建议文件：

- `src/domain/task-service.js`
- `src/domain/runtime-state.js`

职责：

- 创建任务
- 添加 / 删除目标
- 启用 / 禁用任务
- 校验输入（平台、roomId、RTMP URL）

### 3. `src/runtime/`
负责运行态进程编排。

建议文件：

- `src/runtime/relay-manager.js`
- `src/runtime/relay-registry.js`
- `src/runtime/retry-policy.js`

职责：

- 创建房间解析器
- 拉取 stream url
- 启动 / 停止 ffmpeg
- 管理重试与轮询
- 维护内存态 metrics

### 4. `src/platforms/`
替代当前 `engines` + `rooms` 的分裂模型。

建议文件：

- `src/platforms/index.js`
- `src/platforms/bilibili.js`
- `src/platforms/douyu.js`

职责：

- 暴露统一接口 `createResolver(platform, roomId, options)`
- 内部屏蔽不同平台 stream url 获取细节

### 5. `src/bot/`
负责 Telegram 交互。

建议拆分：

- `src/bot/index.js`
- `src/bot/handlers.js`
- `src/bot/keyboards.js`
- `src/bot/views.js`
- `src/bot/session.js`

职责：

- 命令注册
- 菜单路由
- 会话输入
- 文案渲染
- 与 domain/runtime 交互

---

## 机器人交互重构

## 目标

让 bot 从“把所有逻辑塞进一个入口文件”改成“薄控制器”。

## 交互能力

至少保留并优化以下入口：

- `/start`：主菜单
- `/rooms`：房间列表
- `/addroom`：新增房间转播任务
- `/traffic`：查看流量 / 运行状态
- 单任务详情页：
  - 启用 / 禁用
  - 添加目标
  - 删除任务
  - 查看最近错误

## 设计原则

- bot handler 不直接操作底层文件
- bot handler 只调用 `task-service` 和 `relay-registry`
- 文案渲染与业务逻辑分离
- callback data 采用统一前缀风格，例如：
  - `room:list`
  - `room:view:<taskId>`
  - `room:toggle:<taskId>`
  - `room:delete:<taskId>`

---

## 测试策略

旧测试不再被视为金标准，需要按新契约重写。

## 保留测试方向

1. **storage 测试**
   - 初始化状态文件
   - 原子写入
   - task CRUD
   - target CRUD

2. **runtime 测试**
   - 启动 relay 时调用 resolver + ffmpeg
   - 发生房间未开播/推流结束时进入轮询
   - ffmpeg error 时指数/阶梯重试

3. **bot 测试**
   - 主菜单是否暴露正确入口
   - 添加房间会话是否正确写入任务
   - 详情按钮是否触发对应 service

4. **bootstrap 测试**
   - 启动应用时初始化 storage、runtime、bot
   - 优雅退出时停止所有 relay 与 bot

## 明确删除的测试方向

- SQLite 文件头断言
- `DATABASE_PATH=./data/data.db`
- `ecosystem.config.js`
- PM2 ready signal 契约
- 旧 README 文案中对 SQLite 的描述

---

## 目录级变更计划

### 删除 / 废弃

- `src/db/`
- 与 SQLite 绑定的测试
- 与 ecosystem/pm2 强绑定的部署测试

### 新增

- `src/storage/`
- `src/domain/`
- `src/runtime/`
- `src/platforms/`

### 重写

- `src/bot/index.js`
- `main.js`
- `README.md`
- `.env.example`
- `Dockerfile`
- `docker-compose.yml`
- `package.json`

---

## 运行与部署约束

## Node 版本

- `package.json` 增加：

```json
"engines": {
  "node": ">=25.0.0"
}
```

## 默认数据目录

统一改为：

- `DATA_DIR=./data`
- `STATE_FILE=./data/state.json`
- `EVENT_LOG_FILE=./data/events.jsonl`

## 启动方式

保留最小化入口：

- `npm start`
- `node main.js`
- Docker 直接启动

不再为 PM2 做专门兼容层。

---

## 执行原则

1. 先删除旧 `db` 文件与 SQLite 运行数据。
2. 先建立新 storage 契约，再改 runtime。
3. 再重写 bot 控制层。
4. 最后重写测试、README、部署文件。
5. 所有完成判断以“新测试通过 + 实际启动成功”为准。

---

## 结论

这次重构不是“兼容升级”，而是一次**明确放弃历史包袱**的版本切换：

- 放弃 SQLite
- 放弃旧部署契约
- 放弃向后兼容旧 DB
- 采用 Node 25 + 文件状态存储 + 更清晰的分层架构

该方案更适合当前项目规模，也更适合 Telegram bot 这类轻运维场景。
