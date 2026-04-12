// 程序化生成的花朵形状数据（3 态 morphing：花苞 / 半开 / 全开）
// 坐标系：花蕊中心 (0,0)，单位归一化到约 [-1,1]
// 每瓣独立 petalIndex（0~4），花蕊 petalIndex=5
// 后续可替换为 Figma SVG 提取数据，接口不变
//
// 三态核心差异是花瓣朝向角度：
//   花苞：花瓣全部竖直向上包裹，窄长水滴
//   半开：外层瓣向外翻折 ~60°，内层还竖着，杯状
//   全开：花瓣完全放平，径向铺开

// ── 工具函数 ──
function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// ── 花瓣生成器 ──
export function generateFlowerTemplate(particlesPerFlower = 500, seed = 42) {
  const rand = seededRandom(seed);
  const N_PETALS = 5;
  const PARTICLES_STAMEN = Math.floor(particlesPerFlower * 0.12);
  const PARTICLES_PETALS = particlesPerFlower - PARTICLES_STAMEN;
  const PARTICLES_PER_PETAL = Math.floor(PARTICLES_PETALS / N_PETALS);

  const points = [];

  for (let pi = 0; pi < N_PETALS; pi++) {
    // 全开态的径向方向角（5 瓣均匀 + 轻微抖动）
    const bloomAngle = (pi / N_PETALS) * Math.PI * 2 - Math.PI / 2
                     + (rand() - 0.5) * 0.15;

    // 层次：0,1 外层 / 2,3 中层 / 4 内层
    const layerDepth = pi < 2 ? 0 : pi < 4 ? 1 : 2; // 0=外, 1=中, 2=内

    const nPts = (pi < N_PETALS - 1)
      ? PARTICLES_PER_PETAL
      : PARTICLES_PETALS - PARTICLES_PER_PETAL * (N_PETALS - 1);

    for (let i = 0; i < nPts; i++) {
      // 先在"标准花瓣"局部坐标采样（椭圆，长轴 Y 方向）
      // 花瓣局部坐标：x 横向, y 纵向（从根部 0 到尖端 1）
      const petalRx = 0.32 + rand() * 0.04; // 半宽（宽圆饱满）
      const petalRy = 0.42 + rand() * 0.03; // 半长
      let lx, ly;
      let tries = 0;
      do {
        lx = (rand() - 0.5) * 2 * petalRx;
        ly = rand() * petalRy; // 只取正半轴（根→尖）
        tries++;
      } while ((lx * lx) / (petalRx * petalRx) + (ly * ly) / (petalRy * petalRy) > 1.0 && tries < 80);
      // ly: 0=花瓣根部, ~petalRy=花瓣尖端
      const tAlongPetal = ly / petalRy; // 0~1 沿花瓣长度归一化

      // ────────────────────────────────────
      // 全开 Bloom：花瓣径向平铺
      // 花瓣方向 = bloomAngle，中心偏移 0.45
      // ────────────────────────────────────
      const bloomOffset = 0.20; // 花瓣根部离中心
      const bCos = Math.cos(bloomAngle), bSin = Math.sin(bloomAngle);
      const bloomX = lx * bCos - (ly + bloomOffset) * bSin;
      const bloomY = lx * bSin + (ly + bloomOffset) * bCos;

      // ────────────────────────────────────
      // 花苞 Bud：所有花瓣竖直向上包裹
      // 方向统一朝上（~PI/2），但每瓣横向微偏形成包裹
      // 花瓣变窄，纵向拉长，紧贴中心
      // ────────────────────────────────────
      const budUpAngle = 0 + (pi - 2) * 0.12; // angle=0 朝上(+Y)，微微扇开
      const budNarrow = 0.35; // 横向压缩
      const budLx = lx * budNarrow;
      const budLy = ly * 0.7; // 纵向稍压
      const budOffset = 0.03 + layerDepth * 0.02; // 内层更贴中心
      const budCos = Math.cos(budUpAngle), budSin = Math.sin(budUpAngle);
      const budX = budLx * budCos - (budLy + budOffset) * budSin;
      const budY = budLx * budSin + (budLy + budOffset) * budCos;

      // ────────────────────────────────────
      // 半开 Half：外层翻折、内层半竖
      // 外层瓣朝向在 bloom 和竖直之间插值（偏 bloom 方向 ~60%）
      // 内层瓣还基本竖着（偏竖直 ~80%）
      // ────────────────────────────────────
      const halfOpenFactor = layerDepth === 0 ? 0.65
                           : layerDepth === 1 ? 0.35
                           : 0.12;
      // 角度在"竖直"和"bloom径向"之间插值
      const halfAngle = budUpAngle + (bloomAngle - budUpAngle) * halfOpenFactor;
      // 花瓣宽度也部分展开
      const halfNarrow = budNarrow + (1.0 - budNarrow) * halfOpenFactor * 0.7;
      const halfLx = lx * halfNarrow;
      const halfLy = ly * (0.7 + 0.3 * halfOpenFactor);
      const halfOffset = budOffset + (bloomOffset - budOffset) * halfOpenFactor;
      const hCos = Math.cos(halfAngle), hSin = Math.sin(halfAngle);
      const halfX = halfLx * hCos - (halfLy + halfOffset) * hSin;
      const halfY = halfLx * hSin + (halfLy + halfOffset) * hCos;

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
    const r = rand() * 0.10;
    const a = rand() * Math.PI * 2;
    const bloomX = Math.cos(a) * r;
    const bloomY = Math.sin(a) * r;
    // 半开：花蕊缩小，略上移（被花瓣半遮）
    const halfX = bloomX * 0.5;
    const halfY = bloomY * 0.5 + 0.06;
    // 花苞：花蕊极小，藏在顶部
    const budX = bloomX * 0.15;
    const budY = bloomY * 0.15 + 0.12;

    points.push({
      budPos:   [budX, budY],
      halfPos:  [halfX, halfY],
      bloomPos: [bloomX, bloomY],
      petalIndex: 5,
    });
  }

  return points;
}

// ── 默认模板（500 粒子）──
export const FLOWER_TEMPLATE = generateFlowerTemplate(500, 42);

// ── Z 层级映射：petalIndex → Z 偏移 ──
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
    const y = cy - pos[1] * scale;
    const r = pt.petalIndex === 5 ? 2.5 : 2;
    const col = colors[pt.petalIndex];
    svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${col}" opacity="0.8"/>\n`;
  }

  svg += `</svg>`;
  return svg;
}
