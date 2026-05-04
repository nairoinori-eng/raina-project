// 花朵形状数据（3 态 morphing：花苞 / 半开 / 全开）
// 输出 3D 坐标 [x, y, z] + isEdge 标记（描边粒子）
// 花苞大小 ≈ 一片花瓣大小（自然法则）

function seededRandom(seed) {
  let s = seed;
  return () => { s = (s * 16807 + 0) % 2147483647; return (s - 1) / 2147483646; };
}

export function generateFlowerTemplate(particlesPerFlower = 500, seed = 42) {
  const rand = seededRandom(seed);
  const N_PETALS = 5;
  const PARTICLES_STAMEN = Math.floor(particlesPerFlower * 0.08);
  const PARTICLES_PETALS = particlesPerFlower - PARTICLES_STAMEN;
  const PER_PETAL = Math.floor(PARTICLES_PETALS / N_PETALS);
  // 每瓣 35% 做描边（密实连续轮廓线）
  const EDGE_RATIO = 0.35;

  const DEG = Math.PI / 180;
  const points = [];

  const petalDefs = [];
  for (let pi = 0; pi < N_PETALS; pi++) {
    const bloomAngle = pi * 72 * DEG - 90 * DEG;
    const layer = pi < 2 ? 0 : pi < 4 ? 1 : 2;

    // BLOOM：胖圆花瓣
    const bloom = { cx: Math.cos(bloomAngle) * 0.28, cy: Math.sin(bloomAngle) * 0.28, rx: 0.24, ry: 0.24, angle: bloomAngle };

    // BUD：花苞大小 ≈ 一片花瓣（直径 ~0.48）
    let bud;
    if (layer === 0) {
      const side = pi === 0 ? -1 : 1;
      bud = { cx: side * 0.06, cy: 0.02, rx: 0.20, ry: 0.28, angle: side * 5 * DEG };
    } else if (layer === 1) {
      const side = pi === 2 ? -1 : 1;
      bud = { cx: side * 0.04, cy: 0.08, rx: 0.14, ry: 0.22, angle: side * 3 * DEG };
    } else {
      bud = { cx: 0, cy: 0.16, rx: 0.07, ry: 0.12, angle: 0 };
    }

    // HALF：玫瑰螺旋
    let half;
    if (layer === 0) {
      half = { cx: Math.cos(bloomAngle) * 0.20, cy: Math.sin(bloomAngle) * 0.20, rx: 0.20, ry: 0.20, angle: bloomAngle };
    } else if (layer === 1) {
      const sa = bloomAngle + 25 * DEG;
      half = { cx: Math.cos(sa) * 0.10, cy: Math.sin(sa) * 0.10, rx: 0.12, ry: 0.12, angle: sa };
    } else {
      const sa = bloomAngle + 50 * DEG;
      half = { cx: Math.cos(sa) * 0.04, cy: Math.sin(sa) * 0.04, rx: 0.05, ry: 0.06, angle: sa };
    }

    petalDefs.push({ bloom, bud, half, bloomAngle, layer });
  }

  for (let pi = 0; pi < N_PETALS; pi++) {
    const def = petalDefs[pi];
    const nPts = (pi < N_PETALS - 1) ? PER_PETAL : PARTICLES_PETALS - PER_PETAL * (N_PETALS - 1);
    const nEdge = Math.floor(nPts * EDGE_RATIO);
    const nFill = nPts - nEdge;

    function transform2d(state, du, dv) {
      const c = Math.cos(state.angle), s = Math.sin(state.angle);
      const lx = du * state.rx, ly = dv * state.ry;
      return [state.cx + lx * c - ly * s, state.cy + lx * s + ly * c];
    }

    function makePoint(du, dv, isEdge) {
      const [bx, by] = transform2d(def.bloom, du, dv);
      const bloomDist = Math.sqrt(bx * bx + by * by);
      const bloomZ = 0.25 * (1 - Math.pow(bloomDist / 0.55, 1.5));

      const [hx, hy] = transform2d(def.half, du, dv);
      const halfDist = Math.sqrt(hx * hx + hy * hy);
      const halfZ = 0.15 * (1 - Math.pow(halfDist / 0.35, 1.5));

      const [ux, uy] = transform2d(def.bud, du, dv);
      const budZ = pi * 0.015;

      return {
        budPos:   [ux, uy, budZ],
        halfPos:  [hx, hy, halfZ],
        bloomPos: [bx, by, bloomZ],
        petalIndex: pi,
        isEdge,
      };
    }

    // 填充粒子（圆盘内）
    for (let i = 0; i < nFill; i++) {
      let du, dv;
      do { du = (rand() - 0.5) * 2; dv = (rand() - 0.5) * 2; } while (du * du + dv * dv > 1.0);
      points.push(makePoint(du, dv, false));
    }

    // 描边粒子（圆盘边缘）
    for (let i = 0; i < nEdge; i++) {
      const angle = rand() * Math.PI * 2;
      // 沿椭圆边缘 ± 微小扰动
      const r = 0.92 + rand() * 0.08;
      const du = Math.cos(angle) * r;
      const dv = Math.sin(angle) * r;
      points.push(makePoint(du, dv, true));
    }
  }

  // 花蕊
  for (let i = 0; i < PARTICLES_STAMEN; i++) {
    const r = Math.sqrt(rand()) * 0.08;
    const a = rand() * Math.PI * 2;
    const bx = Math.cos(a) * r, by = Math.sin(a) * r;
    points.push({
      budPos:   [bx * 0.1, by * 0.1 + 0.20, 0.08],
      halfPos:  [bx * 0.4, by * 0.4, 0.10],
      bloomPos: [bx, by, 0.18],
      petalIndex: 5,
      isEdge: false,
    });
  }

  return points;
}

export const FLOWER_TEMPLATE = generateFlowerTemplate(500, 42);
export const PETAL_Z_LAYERS = [0.0, 0.03, 0.06, 0.09, 0.12, 0.15];
