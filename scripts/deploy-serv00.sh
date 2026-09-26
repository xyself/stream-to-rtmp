#!/bin/sh
# stream-to-rtmp serv00 / 小内存主机一键部署脚本
#
# 首次部署：bash scripts/deploy-serv00.sh
# 更新代码：bash scripts/deploy-serv00.sh   （自动 git pull + 重启）
#
# 做的事情：
#   1. 检查 node / ffmpeg / git 是否存在
#   2. 克隆或更新代码，安装依赖
#   3. 生成 .env 并交互式填写全部配置项（必填 + 可选，PORT 填了才追问面板相关）
#   4. 如配了 Gist 且本地无数据库，自动从 Gist 恢复房间列表
#   5. 以低内存参数启动（NODE_OPTIONS=--max-old-space-size=256）
#   6. 安装 cron 看门：每 5 分钟检查一次，进程死了自动拉起
set -e

APP_DIR="$HOME/apps/stream-to-rtmp"
REPO_URL="https://github.com/xyself/stream-to-rtmp.git"
NODE_OPTS="--max-old-space-size=256"
PROC_PATTERN="stream-to-rtmp/main.js"
WATCHDOG_MARK="# stream-to-rtmp-watchdog"

log() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# ---------- 0. 环境检查 ----------
command -v node >/dev/null 2>&1 || die "没找到 node，请先装好 Node.js"
command -v ffmpeg >/dev/null 2>&1 || die "没找到 ffmpeg，请先装好 ffmpeg"
command -v git >/dev/null 2>&1 || die "没找到 git"
command -v crontab >/dev/null 2>&1 || die "没找到 crontab"
log "node: $(node -v)"
log "ffmpeg: $(ffmpeg -version 2>/dev/null | head -n 1)"

# ---------- 1. 拉代码 ----------
if [ -d "$APP_DIR/.git" ]; then
  log ">> 更新代码..."
  git -C "$APP_DIR" pull --ff-only
else
  log ">> 克隆代码..."
  mkdir -p "$HOME/apps"
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

# ---------- 2. 装依赖 ----------
log ">> 安装依赖..."
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi

# ---------- 3. .env ----------
[ -f .env ] || { log ">> 从模板生成 .env"; cp .env.example .env; }

# 交互式填写：已填则跳过（不用 sed -i，FreeBSD/Linux 通用）
get_val() { grep -E "^$1=" .env | cut -d= -f2-; }
prompt_if_empty() {
  key="$1"; prompt="$2"; def="$3"
  val="$(get_val "$key")"
  if [ -z "$val" ]; then
    printf '%s' "$prompt"
    [ -n "$def" ] && printf ' [%s]' "$def"
    printf ': '
    read -r input
    [ -z "$input" ] && input="$def"
    tmpfile="$(mktemp)"
    grep -vE "^${key}=" .env > "$tmpfile" || true
    printf '%s=%s\n' "$key" "$input" >> "$tmpfile"
    mv "$tmpfile" .env
  fi
}
log ">> 填写配置（标'可选'的直接回车跳过）"
prompt_if_empty "TG_TOKEN" "Telegram Bot Token（必填）" ""
prompt_if_empty "TG_CHAT_ID" "Telegram 数字 ID（必填，多个逗号分隔）" ""
prompt_if_empty "LOW_MEMORY" "低内存模式 1=开 0=关" "1"
prompt_if_empty "GIST_TOKEN" "Gist Token（可选，用于同步房间配置）" ""
prompt_if_empty "GIST_ID" "Gist ID（可选）" ""
prompt_if_empty "FFMPEG_PATH" "ffmpeg 路径（可选，默认用系统 PATH）" ""
prompt_if_empty "DATABASE_PATH" "数据库路径" "./data/data.db"
prompt_if_empty "PORT" "Web 面板端口（可选，回车=不启动面板）" ""
if [ -n "$(get_val PORT)" ]; then
  prompt_if_empty "BIND_HOST" "面板监听地址" "127.0.0.1"
  prompt_if_empty "DASHBOARD_TOKEN" "面板访问令牌（建议设置）" ""
fi

[ -n "$(get_val TG_TOKEN)" ] || die "TG_TOKEN 为空，先填好 .env 再跑"
[ -n "$(get_val TG_CHAT_ID)" ] || die "TG_CHAT_ID 为空（必填），先填好 .env 再跑"

# ---------- 4. Gist 恢复（可选） ----------
if grep -qE '^GIST_TOKEN=.+' .env && grep -qE '^GIST_ID=.+' .env && [ ! -f data/data.db ]; then
  log ">> 从 Gist 恢复房间列表..."
  node scripts/restore.js || log "Gist 恢复失败，跳过"
fi
mkdir -p logs data

# ---------- 5. 启动 ----------
if pgrep -f "$PROC_PATTERN" >/dev/null 2>&1; then
  log ">> 停止旧进程..."
  pkill -f "$PROC_PATTERN" || true
  sleep 3
fi
log ">> 启动..."
NODE_OPTIONS="$NODE_OPTS" nohup node "$APP_DIR/main.js" >> logs/app.log 2>&1 &
sleep 2
if pgrep -f "$PROC_PATTERN" >/dev/null 2>&1; then
  log ">> 启动成功"
else
  die "启动失败，查看日志： tail -n 50 $APP_DIR/logs/app.log"
fi

# ---------- 6. cron 看门 ----------
if crontab -l 2>/dev/null | grep -qF "$WATCHDOG_MARK"; then
  log ">> cron 看门已存在，跳过"
else
  log ">> 安装 cron 看门（每 5 分钟检查）..."
  CRON_LINE="*/5 * * * * pgrep -f \"$PROC_PATTERN\" > /dev/null 2>&1 || (cd $APP_DIR && NODE_OPTIONS=\"$NODE_OPTS\" nohup node $APP_DIR/main.js >> logs/app.log 2>&1 &) $WATCHDOG_MARK"
  (crontab -l 2>/dev/null; printf '%s\n' "$CRON_LINE") | crontab -
  log ">> cron 看门已安装"
fi

log "=== 完成 ==="
log "去 TG 给机器人发 /start 测试"
log "看日志： tail -f $APP_DIR/logs/app.log"
log "以后更新： bash $APP_DIR/scripts/deploy-serv00.sh"
