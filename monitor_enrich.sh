#!/bin/bash

# 自动补全实时监控脚本
# 使用方法：./monitor_enrich.sh

echo "━━━━━━━━━━━━━━━━"
echo "📊 自动补全实时监控"
echo "━━━━━━━━━━━━━━━━"
echo ""

# 检查数据库文件
DB_PATH="$HOME/Projects/comic-app/comics.sqlite"
if [ ! -f "$DB_PATH" ]; then
    echo "❌ 数据库文件不存在: $DB_PATH"
    exit 1
fi

# 初始统计
echo "📋 初始状态："
sqlite3 "$DB_PATH" "SELECT '总漫画: ' || COUNT(*) || ' 本' FROM comics;"
sqlite3 "$DB_PATH" "SELECT '有简介: ' || COUNT(*) || ' 本 (' || ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM comics), 2) || '%)' FROM comics WHERE desc_text IS NOT NULL AND desc_text != '';"
sqlite3 "$DB_PATH" "SELECT '无简介: ' || COUNT(*) || ' 本 (' || ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM comics), 2) || '%)' FROM comics WHERE desc_text IS NULL OR desc_text = '';"
echo ""

# 实时监控（每5秒刷新）
echo "🔄 实时监控中... (按 Ctrl+C 停止)"
echo "━━━━━━━━━━━━━━━━"

count=0
while true; do
    count=$((count + 1))
    
    # 清屏（可选）
    # clear
    
    # 当前时间
    current_time=$(date "+%Y-%m-%d %H:%M:%S")
    echo "[$current_time] 第 $count 次检查"
    echo ""
    
    # 统计数据
    total=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM comics;")
    with_desc=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM comics WHERE desc_text IS NOT NULL AND desc_text != '';")
    without_desc=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM comics WHERE desc_text IS NULL OR desc_text = '';")
    
    percentage=$(echo "scale=2; $with_desc * 100 / $total" | bc)
    
    echo "📚 总漫画: $total 本"
    echo "✅ 有简介: $with_desc 本 ($percentage%)"
    echo "❌ 无简介: $without_desc 本"
    echo ""
    
    # 计算补全速度（需要记录上次的数据）
    if [ $count -eq 1 ]; then
        last_with_desc=$with_desc
    else
        speed=$((with_desc - last_with_desc))
        if [ $speed -gt 0 ]; then
            echo "⚡ 补全速度: $speed 本/5秒"
            # 预估剩余时间
            if [ $speed -gt 0 ]; then
                remaining=$((without_desc / speed * 5))
                remaining_min=$((remaining / 60))
                echo "⏱️  预估剩余时间: 约 ${remaining_min} 分钟"
            fi
        else
            echo "⚡ 补全速度: 0 本/5秒 (可能遇到错误)"
        fi
        last_with_desc=$with_desc
    fi
    
    echo "━━━━━━━━━━━━━━━━"
    echo ""
    
    # 等待5秒
    sleep 5
done
