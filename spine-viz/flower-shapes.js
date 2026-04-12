// 程序化生成的花朵形状数据（3 态 morphing：花苞 / 半开 / 全开）
// 坐标系：花蕊中心 (0,0)，单位归一化到约 [-1,1]
// 每瓣独立 petalIndex（0~4），花蕊 petalIndex=5
//
// 花苞：蛋形包络，花瓣分层包裹（外层占左右半，中层上部，内层顶尖）
// 半开：玫瑰螺旋，外瓣展开 + 内瓣紧卷
// 全开：胖圆花瓣径向铺开

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export function generateFlowerTemplate(particlesPerFlower = 500, seed = 42) {
  const rand = seededRandom(seed);
  const N_PETALS = 5;
  const PARTICLES_STAMEN = Math.floor(particlesPerFlower * 0.10);
  const PARTICLES_PETALS = particlesPerFlower - PARTICLES_STAMEN;
  const PER_PETAL = Math.floor(PARTICLES_PETALS / N_PETALS);

  // 蛋形包络：v(0=底, 1=顶) → 半径
  function eggR(v) {
    return 0.22 * Math.pow(Math.sin(v * Math.PI), 0.6);
  }
  const EGG_BOT = -0.25, EGG_TOP = 0.32;
  const EGG_H = EGG_TOP - EGG_BOT;

  const points = [];

  for (let pi = 0; pi < N_PETALS; pi++) {
    const bloomAngle = (pi / N_PETALS) * Math.PI * 2 - Math.PI / 2
                     + (rand() - 0.5) * 0.10;
    const layer = pi < 2 ? 0 : pi < 4 ? 1 : 2;

    const nPts = (pi < N_PETALS - 1)
      ? PER_PETAL
      : PARTICLES_PETALS - PER_PETAL * (N_PETALS - 1);

    for (let i = 0; i < nPts; i++) {
      // 采样标准花瓣空间 u(-1~1宽) v(0~1长)，半圆拒绝
      let u, v;
      do { u = (rand() - 0.5) * 2; v = rand(); } while (u * u + v * v > 1.0);

      // ═══════ BLOOM：胖圆花瓣 ═══════
      const bloomR = 0.32;
      const bloomW = 0.26, bloomH = 0.26;
      const blx = u * bloomW;
      const bly = v * bloomH + bloomR;
      const bc = Math.cos(bloomAngle), bs = Math.sin(bloomAngle);
      const bloomX = blx * bc - bly * bs;
      const bloomY = blx * bs + bly * bc;

      // ═══════ BUD：蛋形包裹 ═══════
      let budX, budY;
      if (layer === 0) {
        // 外层：各占蛋形左/右半，几乎覆盖整个蛋
        const side = pi === 0 ? -1 : 1;
        const budV = 0.06 + (1 - v) * 0.88; // 花瓣尖→蛋顶，根→蛋底
        const er = eggR(budV);
        budY = EGG_BOT + budV * EGG_H;
        budX = er * (side * 0.40 + u * 0.60);
      } else if (layer === 1) {
        // 中层：上部 60%，更窄
        const side = pi === 2 ? -1 : 1;
        const budV = 0.38 + (1 - v) * 0.54;
        const er = eggR(budV) * 0.72;
        budY = EGG_BOT + budV * EGG_H;
        budX = er * (side * 0.28 + u * 0.45);
      } else {
        // 内层：顶部 30%，很窄
        const budV = 0.62 + (1 - v) * 0.30;
        const er = eggR(budV) * 0.35;
        budY = EGG_BOT + budV * EGG_H;
        budX = er * u * 0.40;
      }

      // ═══════ HALF：玫瑰螺旋 ═══════
      let halfX, halfY;
      if (layer === 0) {
        // 外层：大幅展开，接近 bloom 位置
        const hR = bloomR * 0.75;
        const hW = bloomW * 0.85, hH = bloomH * 0.80;
        const hx = u * hW;
        const hy = v * hH + hR;
        halfX = hx * bc - hy * bs;
        halfY = hx * bs + hy * bc;
      } else if (layer === 1) {
        // 中层：半展开 + 螺旋角度偏移
        const spiralAngle = bloomAngle + 0.35;
        const hR = bloomR * 0.38;
        const hW = bloomW * 0.55, hH = bloomH * 0.50;
        const hx = u * hW;
        const hy = v * hH + hR;
        const sc = Math.cos(spiralAngle), ss = Math.sin(spiralAngle);
        halfX = hx * sc - hy * ss;
        halfY = hx * ss + hy * sc;
      } else {
        // 内层：紧卷漩涡核心
        const spiralAngle = bloomAngle + 0.7;
        const hR = 0.07;
        const hW = 0.05, hH = 0.06;
        const hx = u * hW;
        const hy = v * hH + hR;
        const sc = Math.cos(spiralAngle), ss = Math.sin(spiralAngle);
        halfX = hx * sc - hy * ss;
        halfY = hx * ss + hy * sc;
      }

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
    const r = rand() * 0.08;
    const a = rand() * Math.PI * 2;
    const bloomX = Math.cos(a) * r;
    const bloomY = Math.sin(a) * r;
    const halfX = bloomX * 0.35;
    const halfY = bloomY * 0.35 + 0.04;
    const budX = bloomX * 0.08;
    const budY = bloomY * 0.08 + EGG_TOP - 0.06;
    points.push({
      budPos: [budX, budY], halfPos: [halfX, halfY],
      bloomPos: [bloomX, bloomY], petalIndex: 5,
    });
  }

  return points;
}

export const FLOWER_TEMPLATE = generateFlowerTemplate(500, 42);
export const PETAL_Z_LAYERS = [0.0, 0.03, 0.06, 0.09, 0.12, 0.15];

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
    const y = cy - pos[1] * scale;
    const r = pt.petalIndex === 5 ? 2.5 : 2;
    svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${colors[pt.petalIndex]}" opacity="0.8"/>\n`;
  }
  svg += `</svg>`;
  return svg;
}
