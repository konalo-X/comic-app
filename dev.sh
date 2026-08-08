#!/bin/bash
set -e

echo "🚀 漫快 Swift 开发模式启动..."
echo ""

# 检查依赖
echo "📦 检查依赖..."
swift package resolve

# 构建并运行
echo "🔨 构建并启动应用..."
echo ""
swift run ComicApp