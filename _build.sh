#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")"
echo "=== 步骤 1: 构建前端 (vite build) ==="
npx vite build
if [ $? -ne 0 ]; then
  echo "❌ 前端构建失败"
  exit 1
fi
echo "✅ 前端构建完成"
echo ""
echo "=== 步骤 2: 打包 Electron APP ==="
npx electron-builder
if [ $? -ne 0 ]; then
  echo "❌ 打包失败"
  exit 1
fi
echo "✅ 打包完成！"
echo ""
echo "输出目录: $(pwd)/release"