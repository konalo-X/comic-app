#!/bin/bash
# comic-app 外部存活看门狗
# 进程自身无法从内部死锁中恢复，必须靠外部进程兜底。
# 每 3 分钟由 cron 触发一次：
#   探测 1: 5173 端口能否响应 (HTTP 200)
#   探测 2: job_queue 中最近一次任务更新(updated_at)距现在是否超过阈值(队列整体停滞)
# 任一失败 => kill 全部 dev 进程 + 删 single-instance.lock + nohup 重启
# 日志: /Users/konalo/projects/comic-app/watchdog.log
# 重启标记: /Users/konalo/projects/comic-app/.last_restart

set -u

APP_DIR="/Users/konalo/projects/comic-app"
LOG="$APP_DIR/watchdog.log"
DEV_LOG="$APP_DIR/dev.log"
DB="/Users/konalo/Library/Application Support/comic-app/comics.sqlite"
LOCK="/Users/konalo/Library/Application Support/comic-app/single-instance.lock"
NPM="/Users/konalo/Library/Application Support/QClaw/openclaw/config/bin/node/npm"
PORT=5173

# 队列停滞阈值(秒): 最近一次任务更新超过这么久 = 整体冻死
STALL_THRESHOLD=720   # 12 分钟
# 端口探测超时(秒)
PORT_TIMEOUT=5

# electron 主进程(承载 job queue 的后端)特征: comic-app 项目下的 Electron.app
ELECTRON_PATTERN="projects/comic-app/node_modules/electron/dist/Electron.app"

ts() { date "+%Y-%m-%d %H:%M:%S"; }

log() { echo "[$(ts)] $*" | tee -a "$LOG"; }

touch "$LOG" 2>/dev/null || true

# ---------- 探测 1: 端口 ----------
port_ok=0
http_code=$(curl -sS -m "$PORT_TIMEOUT" -o /dev/null -w "%{http_code}" "http://localhost:$PORT" 2>/dev/null)
if [ "$http_code" = "200" ]; then
  port_ok=1
fi

# ---------- 探测 2: 队列最近更新 ----------
db_ok=0
last_update_sec=0
if [ -f "$DB" ]; then
  # 最近一次任意任务 updated_at (毫秒) -> 距今秒数
  last_update_sec=$(sqlite3 "$DB" "SELECT COALESCE(CAST((strftime('%s','now')*1000 - MAX(updated_at))/1000 AS INTEGER), 999999) FROM job_queue;" 2>/dev/null)
  if [ -z "$last_update_sec" ]; then last_update_sec=999999; fi
  # 队列里有活跃任务(active/waiting/delayed)且最近更新在阈值内 => 视为健康
  active_count=$(sqlite3 "$DB" "SELECT COUNT(*) FROM job_queue WHERE status IN ('active','waiting','delayed');" 2>/dev/null)
  if [ "${active_count:-0}" -gt 0 ] && [ "$last_update_sec" -lt "$STALL_THRESHOLD" ]; then
    db_ok=1
  elif [ "${active_count:-0}" -eq 0 ]; then
    # 队列全空(都已 completed/failed 清理)——不算故障，可能闲置
    db_ok=1
  fi
fi

# ---------- 判定 ----------
need_restart=0
reason=""
if [ "$port_ok" -ne 1 ]; then
  need_restart=1; reason="端口 $PORT 无响应(http_code='$http_code')"
elif [ "$db_ok" -ne 1 ]; then
  need_restart=1; reason="队列停滞(最近更新 ${last_update_sec}s 前, 超阈值 ${STALL_THRESHOLD}s)"
fi

# ---------- 探测 3: electron 主进程(后端)存在性 ----------
if [ "$need_restart" -ne 1 ]; then
  electron_count=$(pgrep -f "$ELECTRON_PATTERN" 2>/dev/null | wc -l | tr -d ' ')
  if [ "${electron_count:-0}" -eq 0 ]; then
    need_restart=1; reason="electron 主进程(后端)不存在"
  fi
fi

if [ "$need_restart" -ne 1 ]; then
  log "HEALTHY (port=$http_code, last_update=${last_update_sec}s ago)"
  exit 0
fi

log "UNHEALTHY: $reason => 执行重启"

# ---------- 重启 ----------
# 1) 杀掉所有 comic-app dev 相关进程
# 真实进程树: concurrently -> (vite 二进制, cross-env -> electron . -> Electron.app 主进程)
# 用 comic-app 项目路径精确匹配，避免误杀其他 Electron 应用(QClaw/VSCode)
for pat in \
  "projects/comic-app/node_modules/.bin/concurrently" \
  "projects/comic-app/node_modules/.bin/vite" \
  "projects/comic-app/node_modules/.bin/cross-env" \
  "projects/comic-app/node_modules/electron/dist/Electron.app" \
  "projects/comic-app/node_modules/.bin/electron" \
  "npm run dev"; do
  pids=$(pgrep -f "$pat" 2>/dev/null)
  if [ -n "$pids" ]; then
    for p in $pids; do kill -9 "$p" 2>/dev/null; done
  fi
done
# 兜底: 任何命令行含 comic-app 项目绝对路径且是 node/electron 的残留进程
sleep 1
for p in $(pgrep -f "projects/comic-app" 2>/dev/null); do
  kill -9 "$p" 2>/dev/null
done
sleep 3

# 2) 删单实例锁
rm -f "$LOCK" 2>/dev/null

# 3) nohup 重启
cd "$APP_DIR" || exit 1
nohup "$NPM" run dev > "$DEV_LOG" 2>&1 & disown

# 4) 等启动
sleep 14

# 5) 验证
new_code=$(curl -sS -m "$PORT_TIMEOUT" -o /dev/null -w "%{http_code}" "http://localhost:$PORT" 2>/dev/null)
new_electron=$(pgrep -f "projects/comic-app/node_modules/electron/dist/Electron.app" | head -1)
if [ "$new_code" = "200" ] && [ -n "$new_electron" ]; then
  log "RESTARTED OK (electron_pid=$new_electron, port=$new_code)"
  date "+%Y-%m-%d %H:%M:%S" > "$APP_DIR/.last_restart"
else
  log "RESTART FAILED (electron_pid='$new_electron', port='$new_code') —— 需人工介入"
fi
