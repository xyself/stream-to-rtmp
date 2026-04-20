#!/usr/bin/env bash
set -euo pipefail
cd /mnt/c/fuhrer/code/my/bilibili-live-forward-youtube-master
mkdir -p .hermes-logs
LOG_FILE=".hermes-logs/bot-$(date +%Y%m%d-%H%M%S).log"
echo "$LOG_FILE"
exec npm start >> "$LOG_FILE" 2>&1
