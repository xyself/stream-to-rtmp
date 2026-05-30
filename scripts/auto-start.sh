#!/bin/sh

# Auto-restart script for stream-to-rtmp
# Usage: ./scripts/auto-start.sh

cd "$(dirname "$0")/.."

while true; do
    node main.js
    
    EXIT_CODE=$?
    
    # 如果是正常退出（0），不再重启
    if [ $EXIT_CODE -eq 0 ]; then
        break
    fi
    
    # 等待 5 秒后重启
    sleep 5
done

