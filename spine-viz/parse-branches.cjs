/**
 * parse-branches.cjs — 从SVG提取藤蔓路径坐标
 *
 * 红色路径 = 脊柱参考线（用于坐标校准）
 * 绿色路径 = 藤蔓（提取为世界坐标）
 */

const fs = require('fs');

// ── SVG路径解析 ──

function parseSVGPaths(svgContent) {
  const paths = [];
  // 匹配 <g ...><path d="..."> 结构
  const gRegex = /<g\s+([^>]*)><path\s+d="([^"]*)"/g;
  let match;
  while ((match = gRegex.exec(svgContent)) !== null) {
    const attrs = match[1];
    const d = match[2];
    // 提取 stroke 颜色
    const strokeMatch = attrs.match(/stroke="([^"]*)"/);
    const stroke = strokeMatch ? strokeMatch[1] : '#000000';
    paths.push({ stroke, d });
  }
  return paths;
}

// 判断是否为绿色
function isGreen(color) {
  if (!color.startsWith('#') || color.length < 7) return false;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return g > 100 && g > r * 1.2 && g > b * 1.2;
}

// 判断是否为红色
function isRed(color) {
  if (!color.startsWith('#') || color.length < 7) return false;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return r > 120 && r > g * 2 && r > b * 2;
}

// ── 贝塞尔曲线采样 ──

function cubicBezierPoint(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return [
    u*u*u*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t*t*t*p3[0],
    u*u*u*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t*t*t*p3[1]
  ];
}

// 解析SVG path d属性，返回采样点
function samplePath(d) {
  const points = [];
  let cx = 0, cy = 0;

  // 简单的SVG path解析器
  const tokens = d.match(/[MCLZmclz]|[-+]?\d*\.?\d+/g);
  if (!tokens) return points;

  let i = 0;
  let cmd = '';

  function nextNum() {
    while (i < tokens.length && /[MCLZmclz]/.test(tokens[i])) {
      cmd = tokens[i]; i++;
    }
    if (i >= tokens.length) return NaN;
    return parseFloat(tokens[i++]);
  }

  while (i < tokens.length) {
    if (/[MCLZmclz]/.test(tokens[i])) {
      cmd = tokens[i]; i++;
    }

    if (cmd === 'M') {
      cx = parseFloat(tokens[i++]); cy = parseFloat(tokens[i++]);
      points.push([cx, cy]);
      cmd = 'L'; // 后续隐式为L
    } else if (cmd === 'L') {
      cx = parseFloat(tokens[i++]); cy = parseFloat(tokens[i++]);
      points.push([cx, cy]);
    } else if (cmd === 'C') {
      const x1 = parseFloat(tokens[i++]), y1 = parseFloat(tokens[i++]);
      const x2 = parseFloat(tokens[i++]), y2 = parseFloat(tokens[i++]);
      const x3 = parseFloat(tokens[i++]), y3 = parseFloat(tokens[i++]);
      // 采样贝塞尔曲线，每段10个采样点
      for (let t = 0.1; t <= 1.0; t += 0.1) {
        const pt = cubicBezierPoint([cx, cy], [x1, y1], [x2, y2], [x3, y3], t);
        points.push(pt);
      }
      cx = x3; cy = y3;
    } else if (cmd === 'Z' || cmd === 'z') {
      // 闭合路径，跳过
    } else {
      i++; // 跳过不认识的
    }
  }

  return points;
}

// ── 主流程 ──

const svgFiles = ['spine-viz/branches/1.svg', 'spine-viz/branches/2.svg'];

// 第一步：从红色路径提取脊柱参考线
let spineTopY = Infinity, spineBotY = -Infinity, spineCenterX = 0;
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

if (spineXSamples.length > 0) {
  spineCenterX = spineXSamples.reduce((a, b) => a + b) / spineXSamples.length;
}

console.log(`脊柱参考线: centerX=${spineCenterX.toFixed(1)}, topY=${spineTopY.toFixed(1)}, botY=${spineBotY.toFixed(1)}`);

// 坐标转换
const WORLD_TOP = 2.36;
const WORLD_BOT = -2.36;
const PX_PER_WORLD = (spineBotY - spineTopY) / (WORLD_TOP - WORLD_BOT);

function toWorld(px, py) {
  const wx = (px - spineCenterX) / Math.abs(PX_PER_WORLD);
  const wy = WORLD_TOP - (py - spineTopY) / Math.abs(PX_PER_WORLD);
  return [parseFloat(wx.toFixed(4)), parseFloat(wy.toFixed(4))];
}

// 第二步：提取绿色藤蔓路径（每个SVG文件 = 一根完整藤蔓）
const vineData = [];

for (let fi = 0; fi < svgFiles.length; fi++) {
  const content = fs.readFileSync(svgFiles[fi], 'utf-8');
  const paths = parseSVGPaths(content);

  // 收集该文件所有绿色路径的点
  let allPts = [];
  for (const p of paths) {
    if (!isGreen(p.stroke)) continue;
    const pts = samplePath(p.d);
    allPts.push(...pts);
  }

  if (allPts.length === 0) continue;

  // 按Y坐标排序（从上到下）
  allPts.sort((a, b) => a[1] - b[1]);

  // 去重（合并距离很近的点）
  const deduped = [allPts[0]];
  for (let i = 1; i < allPts.length; i++) {
    const prev = deduped[deduped.length - 1];
    const dx = allPts[i][0] - prev[0];
    const dy = allPts[i][1] - prev[1];
    if (dx*dx + dy*dy > 25) { // 间距>5像素才保留
      deduped.push(allPts[i]);
    }
  }

  // 均匀采样（每隔约15个点取一个，控制总量在合理范围）
  const step = Math.max(1, Math.floor(deduped.length / 80));
  const sampled = [];
  for (let i = 0; i < deduped.length; i += step) {
    sampled.push(toWorld(deduped[i][0], deduped[i][1]));
  }
  // 确保最后一个点
  const last = deduped[deduped.length - 1];
  const lastW = toWorld(last[0], last[1]);
  if (sampled.length > 0) {
    const sl = sampled[sampled.length - 1];
    if (Math.abs(sl[0] - lastW[0]) > 0.01 || Math.abs(sl[1] - lastW[1]) > 0.01) {
      sampled.push(lastW);
    }
  }

  console.log(`藤蔓${fi+1} (${svgFiles[fi]}): ${allPts.length}个原始点 → ${deduped.length}去重 → ${sampled.length}采样`);
  vineData.push(sampled);
}

// 第三步：输出结果
let output = `// 从SVG提取的藤蔓路径（世界坐标）
// 脊柱参考线: centerX=${spineCenterX.toFixed(1)}px, topY=${spineTopY.toFixed(1)}px, botY=${spineBotY.toFixed(1)}px
// x: 0=脊柱中心, 正=右侧, 负=左侧
// y: ${WORLD_TOP}=顶部, ${WORLD_BOT}=底部

const vinePaths = [
`;

for (let vi = 0; vi < vineData.length; vi++) {
  output += `  // 藤蔓${vi+1} (${vineData[vi].length}个控制点)\n  [\n`;
  for (let pi = 0; pi < vineData[vi].length; pi++) {
    const [x, y] = vineData[vi][pi];
    output += `    [${x}, ${y}]${pi < vineData[vi].length - 1 ? ',' : ''}\n`;
  }
  output += `  ]${vi < vineData.length - 1 ? ',' : ''}\n`;
}

output += `];\n`;

fs.writeFileSync('spine-viz/vine-paths-data.js', output);
console.log('\n输出到 spine-viz/vine-paths-data.js');
