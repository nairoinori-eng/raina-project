#!/usr/bin/env python3
"""验证提取的叶子形状是否正确"""
import numpy as np
from PIL import Image, ImageDraw

# 手动解析leaf-shapes.js
import re
with open('spine-viz/leaf-shapes.js', 'r') as f:
    content = f.read()

# 简单提取3片叶子的数据
leaves = []
blocks = content.split("name: '")[1:]
for block in blocks:
    name = block.split("'")[0]
    contour_block = block.split('contour: [')[1].split('],\n    veins')[0]
    contour = re.findall(r'\[([-\d.]+),\s*([-\d.]+)\]', contour_block)
    contour = [(float(x), float(y)) for x, y in contour]

    veins_block = block.split('veins: [')[1].split(']')[0] if 'veins: [' in block else ''
    veins = re.findall(r'\[([-\d.]+),\s*([-\d.]+)\]', veins_block)
    veins = [(float(x), float(y)) for x, y in veins]

    leaves.append({'name': name, 'contour': contour, 'veins': veins})

# 画到一张图上
W, H = 600, 400
img = Image.new('RGB', (W, H), 'white')
draw = ImageDraw.Draw(img)

for i, leaf in enumerate(leaves):
    # 世界坐标 → 像素坐标
    cx = 100 + i * 200  # 中心x
    cy = 350            # 叶柄y
    scale = 130          # 1单位=130像素

    # 画轮廓
    pts = [(cx + x * scale, cy - y * scale) for x, y in leaf['contour']]
    draw.polygon(pts, outline='green', fill=(200, 240, 200))

    # 画叶脉
    for vx, vy in leaf['veins']:
        px = cx + vx * scale
        py = cy - vy * scale
        draw.ellipse([px-1, py-1, px+1, py+1], fill='darkgreen')

    # 画叶柄原点
    draw.ellipse([cx-3, cy-3, cx+3, cy+3], fill='red')
    draw.text((cx-30, cy+10), leaf['name'][-10:], fill='black')

img.save('spine-viz/leaves/preview.png')
print('Saved to spine-viz/leaves/preview.png')
