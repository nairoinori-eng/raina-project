#!/usr/bin/env python3
"""
从Figma导出的SVG中提取叶子图片，做边缘检测生成叶子轮廓数据。
"""
import re
import base64
import os
import json
from io import BytesIO

import numpy as np
from PIL import Image
import cv2

LEAVES_DIR = os.path.join(os.path.dirname(__file__), 'leaves')
OUT_FILE = os.path.join(os.path.dirname(__file__), 'leaf-shapes.js')

def extract_pngs_from_svg(svg_path):
    """从SVG文件中提取所有base64 PNG数据，返回PIL Image列表。"""
    with open(svg_path, 'r') as f:
        content = f.read()
    # 匹配 xlink:href="data:image/png;base64,..."
    pngs = re.findall(r'data:image/png;base64,([A-Za-z0-9+/=]+)', content)
    images = []
    for p in pngs:
        img_bytes = base64.b64decode(p)
        img = Image.open(BytesIO(img_bytes))
        images.append(img)
    return images

def combine_leaf_and_veins(images):
    """如果有两张图(叶身+叶脉)，合并成一张灰度叶片 + 叶脉mask"""
    if len(images) == 1:
        leaf = np.array(images[0].convert('RGBA'))
        vein_mask = None
    else:
        # 找面积最大的作为叶片，其他作为叶脉
        sizes = [np.array(img.convert('RGBA'))[:,:,3].sum() for img in images]
        leaf_idx = np.argmax(sizes)
        leaf = np.array(images[leaf_idx].convert('RGBA'))
        # 其他合并成叶脉
        vein_mask = None
        for i, img in enumerate(images):
            if i == leaf_idx:
                continue
            arr = np.array(img.convert('RGBA'))
            if vein_mask is None:
                vein_mask = arr[:,:,3]
            else:
                vein_mask = np.maximum(vein_mask, arr[:,:,3])
    return leaf, vein_mask

def extract_contour(leaf_rgba):
    """用alpha通道找轮廓。"""
    alpha = leaf_rgba[:,:,3]
    # 二值化
    _, binary = cv2.threshold(alpha, 128, 255, cv2.THRESH_BINARY)
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    # 取最大轮廓
    if not contours:
        return None
    contour = max(contours, key=cv2.contourArea)
    # 简化：每隔几个点取一个
    return contour.squeeze()

def normalize_leaf(contour, vein_mask, leaf_shape):
    """
    归一化到标准坐标系：
    - 原点在叶柄底部（x中心，y最大）
    - y轴朝上（叶尖y正，叶柄y=0）
    - 归一化宽度到[-1, 1]
    """
    h, w = leaf_shape[:2]
    # 轮廓坐标 (col, row) = (x, y)
    xs = contour[:, 0].astype(np.float32)
    ys = contour[:, 1].astype(np.float32)

    # 找叶柄底部：y最大的点群的x中心（图像y轴朝下，所以最大y=最底部=叶柄）
    bottom_thresh = ys.max() - 0.05 * (ys.max() - ys.min())
    bottom_mask = ys > bottom_thresh
    stem_x = xs[bottom_mask].mean()
    stem_y = ys.max()

    # 归一化
    height = ys.max() - ys.min()
    scale = 2.0 / height  # 总高度 = 2单位

    # 翻转y轴（图像y朝下→世界y朝上）
    norm_x = (xs - stem_x) * scale
    norm_y = (stem_y - ys) * scale  # 叶柄底 y=0，叶尖 y>0

    contour_norm = np.column_stack([norm_x, norm_y])

    # 叶脉mask转成点云
    veins_norm = []
    if vein_mask is not None:
        vein_pts = np.argwhere(vein_mask > 100)  # (row, col)
        if len(vein_pts) > 0:
            # 下采样
            idx = np.random.choice(len(vein_pts), min(200, len(vein_pts)), replace=False)
            vein_pts = vein_pts[idx]
            vx = (vein_pts[:, 1].astype(np.float32) - stem_x) * scale
            vy = (stem_y - vein_pts[:, 0].astype(np.float32)) * scale
            veins_norm = list(zip(vx.tolist(), vy.tolist()))

    return contour_norm.tolist(), veins_norm

def simplify_contour(contour, target_points=80):
    """道格拉斯-普克简化 或 均匀下采样。"""
    n = len(contour)
    if n <= target_points:
        return contour
    step = n / target_points
    indices = [int(i * step) for i in range(target_points)]
    return [contour[i] for i in indices]

def main():
    svg_files = sorted([f for f in os.listdir(LEAVES_DIR) if f.endswith('.svg')])
    leaves = []
    for svg_file in svg_files:
        print(f"处理 {svg_file}...")
        svg_path = os.path.join(LEAVES_DIR, svg_file)
        imgs = extract_pngs_from_svg(svg_path)
        print(f"  提取到 {len(imgs)} 张PNG")
        leaf_arr, vein_mask = combine_leaf_and_veins(imgs)
        print(f"  叶片尺寸: {leaf_arr.shape}, 叶脉: {'有' if vein_mask is not None else '无'}")
        contour = extract_contour(leaf_arr)
        if contour is None:
            print(f"  无法提取轮廓, 跳过")
            continue
        contour_norm, veins_norm = normalize_leaf(contour, vein_mask, leaf_arr.shape)
        contour_simplified = simplify_contour(contour_norm, 80)
        name = svg_file.replace('.svg', '').replace(' ', '_').replace('(', '').replace(')', '')
        leaves.append({
            'name': name,
            'contour': contour_simplified,
            'veins': veins_norm,
        })
        print(f"  轮廓点: {len(contour_simplified)}, 叶脉点: {len(veins_norm)}")

    # 写入 leaf-shapes.js
    with open(OUT_FILE, 'w') as f:
        f.write('// 从Figma SVG自动提取的叶子形状数据\n')
        f.write('// 坐标系: 叶柄底(0,0), 叶尖朝y正方向, 高度约2个单位\n\n')
        f.write('export const LEAF_SHAPES = [\n')
        for leaf in leaves:
            f.write(f"  {{\n")
            f.write(f"    name: '{leaf['name']}',\n")
            f.write(f"    contour: [\n")
            for pt in leaf['contour']:
                f.write(f"      [{pt[0]:.4f}, {pt[1]:.4f}],\n")
            f.write(f"    ],\n")
            f.write(f"    veins: [\n")
            for pt in leaf['veins']:
                f.write(f"      [{pt[0]:.4f}, {pt[1]:.4f}],\n")
            f.write(f"    ],\n")
            f.write(f"  }},\n")
        f.write('];\n')
    print(f"\n写入 {OUT_FILE}")
    print(f"共 {len(leaves)} 片叶子模板")

if __name__ == '__main__':
    main()
