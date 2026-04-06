#!/bin/bash
# 双击这个文件 = 拉取最新代码 + 启动前端（Vite）
cd ~/raina-project
git pull origin claude/add-capabilities-docs-CdrcV
cd spine-viz
npm run dev
