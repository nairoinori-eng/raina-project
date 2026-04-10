/**
 * parse-branches.cjs — 从SVG提取分支藤蔓路径
 * 每段绿色path = 一根独立分支，保持原始路径顺序
 */

const fs = require('fs');

// ── SVG路径解析 ──

function parseSVGPaths(svgContent) {
  const paths = [];
  const gRegex = /<g\s+([^>]*)><path\s+d="([^"]*)"/g;
  let match;
  while ((match = gRegex.exec(svgContent)) !== null) {
    const attrs = match[1];
    const d = match[2];
    const strokeMatch = attrs.match(/stroke="([^"]*)"/);
    const stroke = strokeMatch ? strokeMatch[1] : '#000000';
    const opacityMatch = attrs.match(/stroke-opacity="([^"]*)"/);
    const opacity = opacityMatch ? parseFloat(opacityMatch[1]) : 1.0;
    paths.push({ stroke, opacity, d });
  }
  return paths;
}

function isGreen(color) {
  if (!color.startsWith('#') || color.length < 7) return false;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return g > 100 && g > r * 1.2 && g > b * 1.2;
}

function isRed(color) {
  if (!color.startsWith('#') || color.length < 7) return false;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return r > 120 && r > g * 2 && r > b * 2;
}

// ── 贝塞尔曲线采样 ──

function cubicBezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return [
    u*u*u*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t*t*t*p3[0],
    u*u*u*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t*t*t*p3[1]
  ];
}

function samplePath(d) {
  const points = [];
  let cx = 0, cy = 0;
  const tokens = d.match(/[MCLZmclz]|[-+]?\d*\.?\d+/g);
  if (!tokens) return points;

  let i = 0;
  let cmd = '';

  while (i < tokens.length) {
    if (/[MCLZmclz]/.test(tokens[i])) {
      cmd = tokens[i]; i++;
    }

    if (cmd === 'M') {
      cx = parseFloat(tokens[i++]); cy = parseFloat(tokens[i++]);
      points.push([cx, cy]);
      cmd = 'L';
    } else if (cmd === 'L') {
      cx = parseFloat(tokens[i++]); cy = parseFloat(tokens[i++]);
      points.push([cx, cy]);
    } else if (cmd === 'C') {
      const x1 = parseFloat(tokens[i++]), y1 = parseFloat(tokens[i++]);
      const x2 = parseFloat(tokens[i++]), y2 = parseFloat(tokens[i++]);
      const x3 = parseFloat(tokens[i++]), y3 = parseFloat(tokens[i++]);
      // 每段贝塞尔8个采样
      for (let t = 0.125; t <= 1.0; t += 0.125) {
        points.push(cubicBezier([cx, cy], [x1, y1], [x2, y2], [x3, y3], t));
      }
      cx = x3; cy = y3;
    } else if (cmd === 'Z' || cmd === 'z') {
      // skip
    } else {
      i++;
    }
  }
  return points;
}

// 计算路径长度
function pathLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i-1][0], dy = pts[i][1] - pts[i-1][1];
    len += Math.sqrt(dx*dx + dy*dy);
  }
  return len;
}

// 路径均匀重采样
function resamplePath(pts, numPoints) {
  const totalLen = pathLength(pts);
  if (totalLen < 1 || pts.length < 2) return pts;

  const step = totalLen / (numPoints - 1);
  const result = [pts[0]];
  let dist = 0, pi = 0;

  for (let i = 1; i < numPoints; i++) {
    const targetDist = i * step;
    while (pi < pts.length - 1) {
      const dx = pts[pi+1][0] - pts[pi][0], dy = pts[pi+1][1] - pts[pi][1];
      const segLen = Math.sqrt(dx*dx + dy*dy);
      if (dist + segLen >= targetDist) {
        const frac = (targetDist - dist) / segLen;
        result.push([
          pts[pi][0] + dx * frac,
          pts[pi][1] + dy * frac
        ]);
        break;
      }
      dist += segLen;
      pi++;
    }
  }
  return result;
}

// ── 主流程 ──

const svgFiles = ['spine-viz/branches/1.svg', 'spine-viz/branches/2.svg'];

// 1. 提取脊柱参考线
let spineTopY = Infinity, spineBotY = -Infinity;
let spineXSamples = [];

for (const file of svgFiles) {
  const content = fs.readFileSync(file, 'utf-8');
  const paths = parseSVGPaths(content);
  for (const p of paths) {
    if (!isRed(p.stroke)) continue;
    const pts = samplePath(p.d);
    for (const [x, y] of pts) {
      spineXSamples.push(x);
      if (y < spineTopY) spineTopY = y;
      if (y > spineBotY) spineBotY = y;
    }
  }
}

const spineCenterX = spineXSamples.length > 0
  ? spineXSamples.reduce((a, b) => a + b) / spineXSamples.length : 966;

console.log(`脊柱: centerX=${spineCenterX.toFixed(1)}, topY=${spineTopY.toFixed(1)}, botY=${spineBotY.toFixed(1)}`);

const WORLD_TOP = 2.36, WORLD_BOT = -2.36;
const PX_PER_WORLD = Math.abs((spineBotY - spineTopY) / (WORLD_TOP - WORLD_BOT));

function toWorld(px, py) {
  const wx = (px - spineCenterX) / PX_PER_WORLD;
  const wy = WORLD_TOP - (py - spineTopY) / PX_PER_WORLD;
  return [parseFloat(wx.toFixed(4)), parseFloat(wy.toFixed(4))];
}

// 2. 提取绿色路径，每段独立
const branches = [];

for (let fi = 0; fi < svgFiles.length; fi++) {
  const content = fs.readFileSync(svgFiles[fi], 'utf-8');
  const paths = parseSVGPaths(content);

  for (const p of paths) {
    if (!isGreen(p.stroke)) continue;
    if (p.opacity < 0.01) continue;  // 跳过不可见

    const pts = samplePath(p.d);
    if (pts.length < 3) continue;

    const len = pathLength(pts);
    if (len < 30) continue;  // 跳过太短的碎片（<30px）

    // 检查是否基本贴着脊柱（如果x变化太小，可能是脊柱线碎片）
    const xValues = pts.map(p => p[0]);
    const xRange = Math.max(...xValues) - Math.min(...xValues);
    const avgX = xValues.reduce((a,b) => a+b) / xValues.length;
    if (xRange < 15 && Math.abs(avgX - spineCenterX) < 20) continue;  // 贴着脊柱的竖线

    // PNG转SVG生成的是闭合轮廓（去程+回程），提取中心线
    // 检测是否闭合（首尾距离<10px）
    const firstPt = pts[0], lastPt = pts[pts.length - 1];
    const closeDist = Math.sqrt((firstPt[0]-lastPt[0])**2 + (firstPt[1]-lastPt[1])**2);
    let centerLine;

    if (closeDist < 20 && pts.length >= 6) {
      // 闭合轮廓：前半段和后半段（逆序）取中点
      const half = Math.floor(pts.length / 2);
      const fwd = pts.slice(0, half);
      const bwd = pts.slice(half).reverse();
      // 对齐两段长度
      const minLen = Math.min(fwd.length, bwd.length);
      centerLine = [];
      for (let ci = 0; ci < minLen; ci++) {
        centerLine.push([
          (fwd[ci][0] + bwd[ci][0]) / 2,
          (fwd[ci][1] + bwd[ci][1]) / 2
        ]);
      }
    } else {
      // 非闭合，直接使用
      centerLine = pts;
    }

    if (centerLine.length < 2) continue;
    const centerLen = pathLength(centerLine);
    if (centerLen < 15) continue;

    // 均匀重采样（每30px一个点，最少4最多30）
    const numSamples = Math.max(4, Math.min(30, Math.round(centerLen / 30)));
    const resampled = resamplePath(centerLine, numSamples);

    // 转世界坐标
    const worldPts = resampled.map(([x, y]) => toWorld(x, y));

    branches.push({
      file: fi + 1,
      numOrigPts: pts.length,
      pixelLen: Math.round(len),
      points: worldPts
    });
  }
}

console.log(`\n共提取 ${branches.length} 根分支藤蔓：`);
for (let i = 0; i < branches.length; i++) {
  const b = branches[i];
  const yRange = [b.points[0][1].toFixed(2), b.points[b.points.length-1][1].toFixed(2)];
  console.log(`  #${i}: SVG${b.file}, ${b.points.length}点, ${b.pixelLen}px, y: ${yRange[0]}→${yRange[1]}`);
}

// 3. 输出
let output = `// 从SVG提取的分支藤蔓路径（世界坐标）
// 脊柱: centerX=${spineCenterX.toFixed(1)}px, topY=${spineTopY.toFixed(1)}px, botY=${spineBotY.toFixed(1)}px
// 每根分支保持原始路径顺序
// x: 0=脊柱中心, +右 -左 | y: 2.36=顶 -2.36=底

export const branchPaths = [\n`;

for (let i = 0; i < branches.length; i++) {
  const b = branches[i];
  output += `  // #${i}: SVG${b.file}, ${b.points.length}点, ${b.pixelLen}px长\n  [\n`;
  for (let j = 0; j < b.points.length; j++) {
    const [x, y] = b.points[j];
    output += `    [${x}, ${y}]${j < b.points.length - 1 ? ',' : ''}\n`;
  }
  output += `  ]${i < branches.length - 1 ? ',' : ''}\n`;
}

output += `];\n`;

fs.writeFileSync('spine-viz/vine-paths-data.js', output);
console.log(`\n输出到 spine-viz/vine-paths-data.js`);
