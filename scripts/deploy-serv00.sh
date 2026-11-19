#!/bin/sh
# stream-to-rtmp Serv00 (FreeBSD) / 小内存主机一键部署脚本
#
# 首次部署：sh scripts/deploy-serv00.sh
# 更新代码：sh scripts/deploy-serv00.sh   （自动 git pull + 重启）
#
# 做的事情：
#   1. 补全 FreeBSD/Serv00 PATH，检查 node / ffmpeg / git / devil binexec
#   2. 克隆或更新代码，安装依赖
#   3. 生成 .env 并交互式填写全部配置项（未填 PORT 时自动设 DISABLE_WEB=1，避免端口无权限报错）
#   4. 自动写入 Serv00 512MB 安全阈值（MEM_ALERT_MB=384 / CRITICAL_MEM_MB=448 / FFMPEG_THREADS=2）
#   5. 如配了 Gist 且本地无数据库，自动从 Gist 恢复房间列表
#   6. 通过 scripts/auto-start.sh 启动（单实例锁 + 内存限制 + 退出码 100 秒级滚动重启）
#   7. 安装 cron 看门（自带完整 PATH）：每 5 分钟检查一次，进程死了自动拉起
set -e

export PATH="$HOME/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

APP_DIR="$HOME/domains/stream-to-rtmp"
REPO_URL="https://github.com/xyself/stream-to-rtmp.git"
NODE_OPTS="--max-semi-space-size=2 --max-old-space-size=192 --v8-pool-size=2 --expose-gc"
WATCHDOG_PATTERN="stream-to-rtmp/scripts/auto-start.sh"
MAIN_PATTERN="stream-to-rtmp/main.js"
WATCHDOG_MARK="# stream-to-rtmp-watchdog"

log() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# ---------- 0. 环境检查 ----------
if command -v devil >/dev/null 2>&1; then
  log ">> 检测到 Serv00 环境，确保开启自定义二进制执行权限 (devil binexec on)..."
  devil binexec on >/dev/null 2>&1 || true
fi

command -v node >/dev/null 2>&1 || die "没找到 node，请先装好 Node.js (>= 22)"
command -v git >/dev/null 2>&1 || die "没找到 git"
command -v crontab >/dev/null 2>&1 || die "没找到 crontab"

FFMPEG_FOUND=""
for cand in "$HOME/bin/ffmpeg" "/usr/local/bin/ffmpeg" "$(command -v ffmpeg 2>/dev/null || true)"; do
  if [ -n "$cand" ] && [ -x "$cand" ]; then
    FFMPEG_FOUND="$cand"
    break
  fi
done
[ -n "$FFMPEG_FOUND" ] || die "没找到可用 ffmpeg（已检查 ~/bin/ffmpeg、/usr/local/bin/ffmpeg 与 PATH）"

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
[ "$NODE_MAJOR" -ge 22 ] || die "node 版本过低 ($(node -v))，需要 >= 22"
log "node: $(node -v) ($(command -v node))"
log "ffmpeg: $("$FFMPEG_FOUND" -version 2>/dev/null | head -n 1) ($FFMPEG_FOUND)"

# ---------- 1. 拉代码 ----------
if [ -d "$APP_DIR/.git" ]; then
  log ">> 更新代码..."
  git -C "$APP_DIR" pull --ff-only
else
  log ">> 克隆代码..."
  mkdir -p "$HOME/domains"
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
chmod +x scripts/auto-start.sh scripts/deploy-serv00.sh 2>/dev/null || true

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
get_val() { grep -E "^$1=" .env | tail -n 1 | cut -d= -f2-; }
set_val() {
  key="$1"; val="$2"
  tmpfile="$(mktemp)"
  grep -vE "^${key}=" .env > "$tmpfile" || true
  printf '%s=%s\n' "$key" "$val" >> "$tmpfile"
  mv "$tmpfile" .env
}
prompt_if_empty() {
  key="$1"; prompt="$2"; def="$3"; secret="$4"
  val="$(get_val "$key")"
  if [ -z "$val" ]; then
    printf '%s' "$prompt"
    [ -n "$def" ] && printf ' [%s]' "$def"
    printf ': '
    if [ "$secret" = "secret" ]; then stty -echo; fi
    read -r input
    if [ "$secret" = "secret" ]; then stty echo; printf '\n'; fi
    [ -z "$input" ] && input="$def"
    set_val "$key" "$input"
  fi
}

log ">> 极简配置（默认只需填 2 项即可启动）"
prompt_if_empty "TG_TOKEN" "Telegram Bot Token（必填）" "" "secret"
prompt_if_empty "TG_CHAT_ID" "Telegram 数字 ID（必填，多个逗号分隔）" ""

# 仅在用户需要时才追问可选配置（Gist / Web 面板 / 自定义 FFmpeg）
if [ -z "$(get_val GIST_TOKEN)" ] && [ -z "$(get_val PORT)" ]; then
  printf '是否需要配置可选项（Gist 备份 / Web 面板端口 / 自定义 FFmpeg）？[y/N]: '
  read -r WANT_OPT
  case "$WANT_OPT" in
    y|Y|yes|YES)
      prompt_if_empty "GIST_TOKEN" "Gist Token（可选）" "" "secret"
      prompt_if_empty "GIST_ID" "Gist ID（可选）" ""
      prompt_if_empty "FFMPEG_PATH" "ffmpeg 路径（留空自动探测）" ""
      prompt_if_empty "PORT" "Web 面板端口（填 devil port 申请的端口；回车=禁用面板）" ""
      ;;
  esac
fi

FINAL_PORT="$(get_val PORT)"
if [ -n "$FINAL_PORT" ] && [ "$FINAL_PORT" != "0" ] && [ "$FINAL_PORT" != "off" ]; then
  set_val "DISABLE_WEB" "0"
  prompt_if_empty "DASHBOARD_TOKEN" "面板访问令牌（建议 16 位以上随机字符）" ""
else
  set_val "PORT" "0"
  set_val "DISABLE_WEB" "1"
fi

# Serv00 / FreeBSD 资源安全默认值（静默自动适配，无需手填）
if [ "$(uname -s)" = "FreeBSD" ] || command -v devil >/dev/null 2>&1; then
  set_val "AUTO_DOWNLOAD_FFMPEG" "0"
fi

[ -n "$(get_val TG_TOKEN)" ] || die "TG_TOKEN 为空，先填好 .env 再跑"
[ -n "$(get_val TG_CHAT_ID)" ] || die "TG_CHAT_ID 为空（必填），先填好 .env 再跑"

# ---------- 4. Gist 恢复（可选） ----------
if grep -qE '^GIST_TOKEN=.+' .env && grep -qE '^GIST_ID=.+' .env && [ ! -f data/data.db ]; then
  log ">> 从 Gist 恢复房间列表..."
  node scripts/restore.js || log "Gist 恢复失败，跳过"
fi
mkdir -p logs data
rm -f .stopped

# ---------- 5. 停止旧进程并以 auto-start.sh 启动 ----------
if pgrep -f "$WATCHDOG_PATTERN" >/dev/null 2>&1 || pgrep -f "$MAIN_PATTERN" >/dev/null 2>&1; then
  log ">> 停止旧进程..."
  pkill -f "$WATCHDOG_PATTERN" || true
  pkill -f "$MAIN_PATTERN" || true
  sleep 3
fi

log ">> 启动看门狗与主服务..."
NODE_OPTIONS="$NODE_OPTS" nohup /bin/sh "$APP_DIR/scripts/auto-start.sh" >/dev/null 2>&1 &
sleep 3
if pgrep -f "$MAIN_PATTERN" >/dev/null 2>&1 || pgrep -f "$WATCHDOG_PATTERN" >/dev/null 2>&1; then
  log ">> 启动成功"
else
  die "启动失败，查看日志： tail -n 50 $APP_DIR/logs/app.log"
fi

# ---------- 6. cron 看门（显式注入完整 PATH，防 FreeBSD cron 找不到 node/ffmpeg） ----------
CRON_PATH="$HOME/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
CRON_LINE="*/5 * * * * PATH=\"$CRON_PATH\" pgrep -f \"$WATCHDOG_PATTERN\" >/dev/null 2>&1 || (cd $APP_DIR && PATH=\"$CRON_PATH\" NODE_OPTIONS=\"$NODE_OPTS\" nohup /bin/sh $APP_DIR/scripts/auto-start.sh >/dev/null 2>&1 &) $WATCHDOG_MARK"

EXISTING_CRON=$(crontab -l 2>/dev/null | grep -vF "$WATCHDOG_MARK" || true)
(printf '%s\n' "$EXISTING_CRON"; printf '%s\n' "$CRON_LINE") | sed '/^$/d' | crontab -
log ">> cron 看门已更新（每 5 分钟检查 auto-start.sh）"

log "=== 完成 ==="
log "去 TG 给机器人发 /start 测试"
log "看日志： tail -f $APP_DIR/logs/app.log"
log "手动停机： touch $APP_DIR/.stopped && pkill -f \"$WATCHDOG_PATTERN\" && pkill -f \"$MAIN_PATTERN\""
log "以后更新： sh $APP_DIR/scripts/deploy-serv00.sh"
