#!/bin/sh
# stream-to-rtmp 看门脚本：node 挂了自动拉起
# 用法：./scripts/auto-start.sh
#
# 约定：
#   - 退出码 0：正常退出，不再重启
#   - 退出码 42：环境缺失（FFmpeg 不可用 / node 版本过低），不再重启
#   - .stopped 文件存在：手动停机标记，不再重启
#     （手动停机：touch .stopped && pkill -f auto-start.sh；重新启用：rm .stopped 后再起本脚本）
#   - 60 秒内崩溃 5 次：放弃重启，避免无限崩溃循环烧 CPU
#   - 单实例：mkdir 原子锁，防双看门打架
#   - 日志：logs/app.log，超 50MB 自动轮转（只留一代，防吃光磁盘）

cd "$(dirname "$0")/.."

# ---- 0. node 版本检查（package.json engines 要求 >=22）----
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: 没找到 node" >&2
  exit 42
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "ERROR: node 版本过低 ($(node -v))，需要 >= 22" >&2
  exit 42
fi

# ---- 1. 单实例锁（mkdir 原子操作，FreeBSD/Linux 通用）----
LOCK_DIR=".auto-start.lock"
if mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "$$" > "$LOCK_DIR/pid"
else
  OLD_PID=$(cat "$LOCK_DIR/pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "auto-start.sh 已在运行 (pid $OLD_PID)，退出"
    exit 0
  fi
  # 锁残留但进程已死：接管
  echo "$$" > "$LOCK_DIR/pid"
fi
cleanup_lock() { rm -rf "$LOCK_DIR"; }
trap cleanup_lock EXIT INT TERM

# ---- 2. 内存上限默认 256MB（小内存主机）----
: "${NODE_OPTIONS:=--max-old-space-size=256}"
export NODE_OPTIONS

mkdir -p logs
LOG_FILE="logs/app.log"

# 日志轮转：超 50MB 则 mv 为 .1（只留一代，避免小磁盘被日志吃光）
rotate_log() {
  [ -f "$LOG_FILE" ] || return 0
  SIZE=$(stat -f %z "$LOG_FILE" 2>/dev/null || stat -c %s "$LOG_FILE" 2>/dev/null || echo 0)
  if [ "$SIZE" -gt 52428800 ]; then
    mv -f "$LOG_FILE" "$LOG_FILE.1"
    echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') 日志超 50MB，已轮转" >> "$LOG_FILE"
  fi
}

CRASH_COUNT=0
WINDOW_START=$(date +%s)

while true; do
  # 手动停机标记：存在则不再重启
  if [ -f .stopped ]; then
    echo "检测到 .stopped 停机标记，不再重启"
    break
  fi

  rotate_log
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') 启动 node main.js ..." >> "$LOG_FILE"
  node main.js >> "$LOG_FILE" 2>&1
  EXIT_CODE=$?

  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') node 退出，退出码 $EXIT_CODE" >> "$LOG_FILE"

  # 正常退出 / 环境缺失：不再重启
  if [ "$EXIT_CODE" -eq 0 ] || [ "$EXIT_CODE" -eq 42 ]; then
    break
  fi

  # 崩溃计数：60 秒窗口内超 5 次则放弃
  NOW=$(date +%s)
  if [ $((NOW - WINDOW_START)) -gt 60 ]; then
    CRASH_COUNT=0
    WINDOW_START=$NOW
  fi
  CRASH_COUNT=$((CRASH_COUNT + 1))
  if [ "$CRASH_COUNT" -ge 5 ]; then
    echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') 60 秒内崩溃 $CRASH_COUNT 次，放弃重启，请检查日志" >> "$LOG_FILE"
    break
  fi

  # 指数退避：5s, 10s, 20s, 40s，上限 60s
  DELAY=$((5 * (1 << (CRASH_COUNT - 1))))
  [ "$DELAY" -gt 60 ] && DELAY=60
  sleep "$DELAY"
done
