#!/bin/bash
# 双击这个文件 = 启动前端 + 自动同步最新代码
cd "$(dirname "$0")/spine-viz"
npm install --silent

echo "🚀 启动 Vite..."
npm run dev &
VITE_PID=$!

echo "🔄 自动同步中（每5秒拉取最新代码，Vite 自动热更新）..."
while kill -0 $VITE_PID 2>/dev/null; do
  sleep 5
  git -C "$(dirname "$0")" pull origin claude/add-capabilities-docs-CdrcV -q 2>/dev/null
done
