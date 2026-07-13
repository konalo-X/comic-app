#!/bin/bash
# 正常停止 comic-app (让看门狗不再自动拉起)
# 用法: bash scripts/comic_app_stop.sh
set -u
APP_DIR="/Users/konalo/projects/comic-app"
LOG="$APP_DIR/watchdog.log"
LOCK="/Users/konalo/Library/Application Support/comic-app/single-instance.lock"

# 1) 先挂起看门狗(关键: 防止它立刻又拉起)
touch "$APP_DIR/.watchdog_suspend"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 已挂起看门狗(.watchdog_suspend 已建)"

# 2) 杀掉所有 comic-app dev 相关进程
for pat in \
  "projects/comic-app/node_modules/.bin/concurrently" \
  "projects/comic-app/node_modules/.bin/vite" \
  "projects/comic-app/node_modules/.bin/cross-env" \
  "projects/comic-app/node_modules/electron/dist/Electron.app" \
  "projects/comic-app/node_modules/.bin/electron" \
  "npm run dev"; do
  pids=$(pgrep -f "$pat" 2>/dev/null)
  if [ -n "$pids" ]; then for p in $pids; do kill -9 "$p" 2>/dev/null; done; fi
done
sleep 1
for p in $(pgrep -f "projects/comic-app" 2>/dev/null); do kill -9 "$p" 2>/dev/null; done
sleep 2

# 3) 删单实例锁
rm -f "$LOCK" 2>/dev/null

echo "[$(date '+%Y-%m-%d %H:%M:%S')] comic-app 已停止。看门狗处于挂起态, 不会自动重启。"
echo "恢复运行请执行: bash scripts/comic_app_start.sh"
