#!/bin/bash
# 正常启动 comic-app (并解除看门狗挂起)
# 用法: bash scripts/comic_app_start.sh
set -u
APP_DIR="/Users/konalo/projects/comic-app"
LOG="$APP_DIR/dev.log"
NPM="/Users/konalo/Library/Application Support/QClaw/openclaw/config/bin/node/npm"
LOCK="/Users/konalo/Library/Application Support/comic-app/single-instance.lock"

# 1) 解除看门狗挂起
rm -f "$APP_DIR/.watchdog_suspend"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 已解除看门狗挂起"

# 2) 清残留 + 删锁
rm -f "$LOCK" 2>/dev/null
for p in $(pgrep -f "projects/comic-app" 2>/dev/null); do kill -9 "$p" 2>/dev/null; done
sleep 2

# 3) 后台启动
cd "$APP_DIR" || exit 1
nohup "$NPM" run dev > "$LOG" 2>&1 & disown
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 已启动 comic-app (dev), 日志: $LOG"
sleep 14
curl -sS -m 5 -o /dev/null -w "5173: %{http_code}\n" http://localhost:5173 2>/dev/null
