#!/bin/bash
# 双击这个文件 = 启动 Flask 后端
cd ~/raina-project
git pull origin claude/add-capabilities-docs-CdrcV
source ~/raina-venv/bin/activate
python3 flask_server/app.py
