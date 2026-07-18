#!/usr/bin/env bash
# ===========================================================================
# build-clean.sh  —  在「干净环境」下打包 ComicApp
#
# 用途：
#   你的 mimocode / Cursor / VS Code 终端会把几十个工具目录 + 巨型变量(如
#   SAFE_RM_DENIED_PATH) 塞进 PATH/环境，导致 electron-builder 的子进程
#   (codesign / xcodebuild / hdiutil) 报「PATH 太长 / argument list too long」。
#
#   本脚本运行时会：
#     1. 丢弃所有「值超过 2KB 的环境变量」(无论来源, PATH 也在此列)
#     2. 把 PATH 重置为最小可用集合(基础路径 + 当前 node + 项目 .bin)
#     3. 防止 electron-builder 重建原生模块(保护 better_sqlite3.node)
#     4. 打包前后备份/校验 better_sqlite3 二进制
#
# 用法：
#   cd /Users/konalo/projects/comic-app
#   ./build-clean.sh
# ===========================================================================
set -e

# 1) 丢弃超大环境变量(IDE 注入的垃圾全在这里清掉, PATH 也会被一并清掉)
for var in $(env | cut -d= -f1); do
  val="${!var}"
  if [ "${#val}" -gt 2048 ]; then
    unset "$var" 2>/dev/null || true
  fi
done

# 2) 重置最小 PATH(保留当前在用的 node, 保证 npm/electron 可用)
NODE_DIR="$(dirname "$(command -v node)")"
export PATH="${NODE_DIR}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:${HOME}/.local/bin:${PWD}/node_modules/.bin"

# 3) 防止原生模块被重建(默认 electron-builder 不重建, 这里双保险)
export ELECTRON_BUILDER_NODE_GYP_REBUILD=false

cd "$(dirname "$0")"

# 4) 备份健康二进制
BS_NODE="node_modules/better-sqlite3/build/Release/better_sqlite3.node"
if [ -f "$BS_NODE" ]; then
  cp -f "$BS_NODE" /tmp/better_sqlite3.node.bak
  echo "[i] 已备份 better_sqlite3.node ($(stat -f%z "$BS_NODE") bytes)"
fi

echo "[i] 干净 PATH 条目数: $(echo "$PATH" | tr ':' '\n' | wc -l | tr -d ' ')"
echo "[i] 开始打包: vite build && electron-builder"
npm run build

# 5) 校验二进制未被破坏
if [ -f "$BS_NODE" ]; then
  sz=$(stat -f%z "$BS_NODE")
  if [ "$sz" -lt 100000 ]; then
    echo "[!] better_sqlite3 二进制被破坏(${sz} bytes), 从备份恢复"
    cp -f /tmp/better_sqlite3.node.bak "$BS_NODE"
  else
    echo "[+] better_sqlite3.node 完好 (${sz} bytes)"
  fi
fi

echo "[+] 打包完成 -> release/"
ls -la release/ 2>/dev/null || true
