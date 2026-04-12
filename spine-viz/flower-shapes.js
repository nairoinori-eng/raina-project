// 花朵形状数据（3 态 morphing：花苞 / 半开 / 全开）
// 照参考图手描：每个花瓣在每个状态 = 一个椭圆区域
// 粒子在圆盘内均匀采样，通过不同的位置/缩放/角度变换到 3 态

function seededRandom(seed) {
  let s = seed;
  return () => { s = (s * 16807 + 0) % 2147483647; return (s - 1) / 2147483646; };
}

export function generateFlowerTemplate(particlesPerFlower = 500, seed = 42) {
  const rand = seededRandom(seed);
  const N_PETALS = 5;
  const PARTICLES_STAMEN = Math.floor(particlesPerFlower * 0.10);
  const PARTICLES_PETALS = particlesPerFlower - PARTICLES_STAMEN;
  const PER_PETAL = Math.floor(PARTICLES_PETALS / N_PETALS);

  const DEG = Math.PI / 180;
  const points = [];

  // ── 每瓣在 3 态的椭圆参数：{cx, cy, rx, ry, angle} ──
  // 照参考图描出来的

  const petalDefs = [];
  for (let pi = 0; pi < N_PETALS; pi++) {
    const bloomAngle = pi * 72 * DEG - 90 * DEG;
    const layer = pi < 2 ? 0 : pi < 4 ? 1 : 2;

    // ── BLOOM：胖圆花瓣，径向排列 ──
    // 参考图：5 个近圆花瓣，均匀分布，互相重叠
    const bloom = {
      cx: Math.cos(bloomAngle) * 0.28,
      cy: Math.sin(bloomAngle) * 0.28,
      rx: 0.24, ry: 0.24,
      angle: bloomAngle,
    };

    // ── BUD：蛋形包裹，照参考图描 ──
    // 参考图：卵形花苞，底窄顶圆，3 层花瓣包裹
    let bud;
    if (layer === 0) {
      // 外层：左/右两半，覆盖整个蛋形
      const side = pi === 0 ? -1 : 1;
      bud = {
        cx: side * 0.06,
        cy: 0.03,
        rx: 0.14, ry: 0.22,
        angle: side * 5 * DEG, // 微微外倾
      };
    } else if (layer === 1) {
      // 中层：上部，更窄，比外层高
      const side = pi === 2 ? -1 : 1;
      bud = {
        cx: side * 0.03,
        cy: 0.10,
        rx: 0.09, ry: 0.15,
        angle: side * 3 * DEG,
      };
    } else {
      // 内层：顶部小尖
      bud = {
        cx: 0,
        cy: 0.18,
        rx: 0.04, ry: 0.08,
        angle: 0,
      };
    }

    // ── HALF：玫瑰螺旋，照参考图描 ──
    // 外层大幅展开，中层半开带螺旋，内层紧卷
    let half;
    if (layer === 0) {
      // 外层：已展开到接近 bloom 位置
      const halfAngle = bloomAngle;
      half = {
        cx: Math.cos(halfAngle) * 0.20,
        cy: Math.sin(halfAngle) * 0.20,
        rx: 0.20, ry: 0.20,
        angle: halfAngle,
      };
    } else if (layer === 1) {
      // 中层：半展开，带螺旋偏移
      const spiralAngle = bloomAngle + 25 * DEG;
      half = {
        cx: Math.cos(spiralAngle) * 0.10,
        cy: Math.sin(spiralAngle) * 0.10,
        rx: 0.12, ry: 0.12,
        angle: spiralAngle,
      };
    } else {
      // 内层：紧卷核心
      const spiralAngle = bloomAngle + 50 * DEG;
      half = {
        cx: Math.cos(spiralAngle) * 0.04,
        cy: Math.sin(spiralAngle) * 0.04,
        rx: 0.05, ry: 0.06,
        angle: spiralAngle,
      };
    }

    petalDefs.push({ bloom, bud, half, bloomAngle, layer });
  }

  // ── 生成粒子 ──
  for (let pi = 0; pi < N_PETALS; pi++) {
    const def = petalDefs[pi];
    const nPts = (pi < N_PETALS - 1) ? PER_PETAL : PARTICLES_PETALS - PER_PETAL * (N_PETALS - 1);

    for (let i = 0; i < nPts; i++) {
      // 在单位圆盘内均匀采样
      let du, dv;
      do { du = (rand() - 0.5) * 2; dv = (rand() - 0.5) * 2; } while (du * du + dv * dv > 1.0);

      // 变换到各态
      function transform(state) {
        const c = Math.cos(state.angle), s = Math.sin(state.angle);
        // 局部椭圆坐标
        const lx = du * state.rx;
        const ly = dv * state.ry;
        // 旋转 + 平移
        return [
          state.cx + lx * c - ly * s,
          state.cy + lx * s + ly * c,
        ];
      }

      points.push({
        budPos:   transform(def.bud),
        halfPos:  transform(def.half),
        bloomPos: transform(def.bloom),
        petalIndex: pi,
      });
    }
  }

  // ── 花蕊 ──
  for (let i = 0; i < PARTICLES_STAMEN; i++) {
    // 全开：中心密集圆
    const r = Math.sqrt(rand()) * 0.08; // sqrt 均匀分布
    const a = rand() * Math.PI * 2;
    const bloomX = Math.cos(a) * r;
    const bloomY = Math.sin(a) * r;
    // 半开：小簇
    const halfX = Math.cos(a) * r * 0.4;
    const halfY = Math.sin(a) * r * 0.4;
    // 花苞：藏在顶部
    const budX = Math.cos(a) * r * 0.1;
    const budY = Math.sin(a) * r * 0.1 + 0.22;

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
  const pad = 40, scale = (size - pad * 2) / 2;
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
