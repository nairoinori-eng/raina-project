// 程序化生成的花朵形状数据（3 态 morphing：花苞 / 半开 / 全开）
// 坐标系：花蕊中心 (0,0)，单位归一化到约 [-1,1]
// 每瓣独立 petalIndex（0~4），花蕊 petalIndex=5
// 后续可替换为 Figma SVG 提取数据，接口不变

// ── 工具函数 ──
function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function pointInEllipse(px, py, cx, cy, rx, ry, angle) {
  const cos = Math.cos(-angle), sin = Math.sin(-angle);
  const dx = px - cx, dy = py - cy;
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;
  return (lx * lx) / (rx * rx) + (ly * ly) / (ry * ry) <= 1.0;
}

// ── 花瓣生成器 ──
// 返回 { budPos, halfPos, bloomPos, petalIndex } 数组
// nPetals=5, nStamen=1(花蕊)
export function generateFlowerTemplate(particlesPerFlower = 500, seed = 42) {
  const rand = seededRandom(seed);
  const N_PETALS = 5;
  const PARTICLES_STAMEN = Math.floor(particlesPerFlower * 0.12); // 12% 花蕊
  const PARTICLES_PETALS = particlesPerFlower - PARTICLES_STAMEN;
  const PARTICLES_PER_PETAL = Math.floor(PARTICLES_PETALS / N_PETALS);

  const points = [];

  // ── 花瓣 ──
  for (let pi = 0; pi < N_PETALS; pi++) {
    const baseAngle = (pi / N_PETALS) * Math.PI * 2 - Math.PI / 2;
    // 每瓣有轻微角度偏移（自然感）
    const angleJitter = (rand() - 0.5) * 0.15;
    const petalAngle = baseAngle + angleJitter;

    const nPts = (pi < N_PETALS - 1)
      ? PARTICLES_PER_PETAL
      : PARTICLES_PETALS - PARTICLES_PER_PETAL * (N_PETALS - 1);

    for (let i = 0; i < nPts; i++) {
      // ── 全开态 (bloom) ──
      // 花瓣 = 拉长椭圆，中心在距花蕊 0.5 处，长轴径向 0.45，短轴 0.22
      const bloomCenterR = 0.50;
      const bloomRx = 0.22 + rand() * 0.02; // 短轴（横向）
      const bloomRy = 0.45 + rand() * 0.02; // 长轴（径向）
      // 椭圆内随机撒点（拒绝法）
      let lx, ly;
      let tries = 0;
      do {
        lx = (rand() - 0.5) * 2 * bloomRx;
        ly = (rand() - 0.5) * 2 * bloomRy;
        tries++;
      } while ((lx * lx) / (bloomRx * bloomRx) + (ly * ly) / (bloomRy * bloomRy) > 1.0 && tries < 50);

      // 局部 → 世界：先平移到花瓣中心，再旋转
      const cos = Math.cos(petalAngle), sin = Math.sin(petalAngle);
      const bloomX = (lx) * cos - (ly + bloomCenterR) * sin;
      const bloomY = (lx) * sin + (ly + bloomCenterR) * cos;

      // ── 半开态 (half) ──
      // 花瓣收窄、拉近花蕊，外层瓣展开多，内层少
      // 用 petalIndex 模拟层次：0,1 外层（展开 70%），2,3 中层（50%），4 内层（30%）
      const layerFactor = pi < 2 ? 0.70 : pi < 4 ? 0.50 : 0.30;
      const halfCenterR = 0.15 + (bloomCenterR - 0.15) * layerFactor;
      const halfRx = bloomRx * (0.5 + layerFactor * 0.3);
      const halfRy = bloomRy * (0.4 + layerFactor * 0.3);
      const halfLocalX = lx * (halfRx / bloomRx);
      const halfLocalY = ly * (halfRy / bloomRy);
      const halfX = (halfLocalX) * cos - (halfLocalY + halfCenterR) * sin;
      const halfY = (halfLocalX) * sin + (halfLocalY + halfCenterR) * cos;

      // ── 花苞态 (bud) ──
      // 所有花瓣挤到中心，变成紧密水滴形
      const budR = 0.08 + rand() * 0.10; // 紧贴中心
      const budAngle = petalAngle + (rand() - 0.5) * 0.5; // 角度模糊
      const budSpread = 0.04; // 很小的横向展开
      const budX = Math.cos(budAngle) * budR + (rand() - 0.5) * budSpread;
      const budY = Math.sin(budAngle) * budR + (rand() - 0.5) * budSpread;

      points.push({
        budPos:   [budX, budY],
        halfPos:  [halfX, halfY],
        bloomPos: [bloomX, bloomY],
        petalIndex: pi,
      });
    }
  }

  // ── 花蕊 ──
  for (let i = 0; i < PARTICLES_STAMEN; i++) {
    // 全开：中心密集小圆
    const r = rand() * 0.10;
    const a = rand() * Math.PI * 2;
    const bloomX = Math.cos(a) * r;
    const bloomY = Math.sin(a) * r;
    // 半开：稍挤
    const halfX = bloomX * 0.6;
    const halfY = bloomY * 0.6;
    // 花苞：极小
    const budX = bloomX * 0.25 + (rand() - 0.5) * 0.02;
    const budY = bloomY * 0.25 + (rand() - 0.5) * 0.02;

    points.push({
      budPos:   [budX, budY],
      halfPos:  [halfX, halfY],
      bloomPos: [bloomX, bloomY],
      petalIndex: 5, // 花蕊
    });
  }

  return points;
}

// ── 默认模板（500 粒子）──
export const FLOWER_TEMPLATE = generateFlowerTemplate(500, 42);

// ── Z 层级映射：petalIndex → Z 偏移 ──
// 底层花瓣 Z 靠后，顶层靠前，花蕊最前
export const PETAL_Z_LAYERS = [0.0, 0.03, 0.06, 0.09, 0.12, 0.15];

// ── 预览 SVG 导出（供调试用）──
export function flowerToSVG(state = 'bloom', size = 400) {
  const points = FLOWER_TEMPLATE;
  const pad = 40;
  const scale = (size - pad * 2) / 2;
  const cx = size / 2, cy = size / 2;

  const colors = ['#e85050', '#e8a050', '#e8e050', '#50b8e8', '#a050e8', '#f0d040'];

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">\n`;
  svg += `<rect width="${size}" height="${size}" fill="#1a1a2e"/>\n`;

  for (const pt of points) {
    const pos = state === 'bud' ? pt.budPos : state === 'half' ? pt.halfPos : pt.bloomPos;
    const x = cx + pos[0] * scale;
    const y = cy - pos[1] * scale; // Y 翻转
    const r = pt.petalIndex === 5 ? 2.5 : 2;
    const col = colors[pt.petalIndex];
    svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${col}" opacity="0.8"/>\n`;
  }

  svg += `</svg>`;
  return svg;
}
