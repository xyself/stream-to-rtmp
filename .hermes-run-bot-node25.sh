#!/usr/bin/env bash
set -euo pipefail
cd /mnt/c/fuhrer/code/my/bilibili-live-forward-youtube-master
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm use 25 >/dev/null
mkdir -p .hermes-logs
LOG_FILE=".hermes-logs/bot-node25-$(date +%Y%m%d-%H%M%S).log"
echo "$LOG_FILE"
exec npm start >> "$LOG_FILE" 2>&1
