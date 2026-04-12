// 生成花朵 3 态预览 SVG（node 运行一次即可）
// 用法：node generate-flower-previews.cjs

// 因为 flower-shapes.js 是 ESM，这里内联生成逻辑
function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function generateFlowerTemplate(particlesPerFlower = 500, seed = 42) {
  const rand = seededRandom(seed);
  const N_PETALS = 5;
  const PARTICLES_STAMEN = Math.floor(particlesPerFlower * 0.12);
  const PARTICLES_PETALS = particlesPerFlower - PARTICLES_STAMEN;
  const PARTICLES_PER_PETAL = Math.floor(PARTICLES_PETALS / N_PETALS);
  const points = [];

  for (let pi = 0; pi < N_PETALS; pi++) {
    const baseAngle = (pi / N_PETALS) * Math.PI * 2 - Math.PI / 2;
    const angleJitter = (rand() - 0.5) * 0.15;
    const petalAngle = baseAngle + angleJitter;
    const nPts = (pi < N_PETALS - 1)
      ? PARTICLES_PER_PETAL
      : PARTICLES_PETALS - PARTICLES_PER_PETAL * (N_PETALS - 1);

    for (let i = 0; i < nPts; i++) {
      const bloomCenterR = 0.50;
      const bloomRx = 0.22 + rand() * 0.02;
      const bloomRy = 0.45 + rand() * 0.02;
      let lx, ly, tries = 0;
      do {
        lx = (rand() - 0.5) * 2 * bloomRx;
        ly = (rand() - 0.5) * 2 * bloomRy;
        tries++;
      } while ((lx * lx) / (bloomRx * bloomRx) + (ly * ly) / (bloomRy * bloomRy) > 1.0 && tries < 50);

      const cos = Math.cos(petalAngle), sin = Math.sin(petalAngle);
      const bloomX = (lx) * cos - (ly + bloomCenterR) * sin;
      const bloomY = (lx) * sin + (ly + bloomCenterR) * cos;

      const layerFactor = pi < 2 ? 0.70 : pi < 4 ? 0.50 : 0.30;
      const halfCenterR = 0.15 + (bloomCenterR - 0.15) * layerFactor;
      const halfRx = bloomRx * (0.5 + layerFactor * 0.3);
      const halfRy = bloomRy * (0.4 + layerFactor * 0.3);
      const halfLocalX = lx * (halfRx / bloomRx);
      const halfLocalY = ly * (halfRy / bloomRy);
      const halfX = (halfLocalX) * cos - (halfLocalY + halfCenterR) * sin;
      const halfY = (halfLocalX) * sin + (halfLocalY + halfCenterR) * cos;

      const budR = 0.08 + rand() * 0.10;
      const budAngle = petalAngle + (rand() - 0.5) * 0.5;
      const budSpread = 0.04;
      const budX = Math.cos(budAngle) * budR + (rand() - 0.5) * budSpread;
      const budY = Math.sin(budAngle) * budR + (rand() - 0.5) * budSpread;

      points.push({ budPos: [budX, budY], halfPos: [halfX, halfY], bloomPos: [bloomX, bloomY], petalIndex: pi });
    }
  }

  for (let i = 0; i < PARTICLES_STAMEN; i++) {
    const r = rand() * 0.10;
    const a = rand() * Math.PI * 2;
    const bloomX = Math.cos(a) * r;
    const bloomY = Math.sin(a) * r;
    const halfX = bloomX * 0.6;
    const halfY = bloomY * 0.6;
    const budX = bloomX * 0.25 + (rand() - 0.5) * 0.02;
    const budY = bloomY * 0.25 + (rand() - 0.5) * 0.02;
    points.push({ budPos: [budX, budY], halfPos: [halfX, halfY], bloomPos: [bloomX, bloomY], petalIndex: 5 });
  }
  return points;
}

function flowerToSVG(points, state, size = 400) {
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

const fs = require('fs');
const path = require('path');

const points = generateFlowerTemplate(500, 42);
const dir = path.join(__dirname, 'flowers');

for (const state of ['bud', 'half', 'bloom']) {
  const svg = flowerToSVG(points, state);
  const file = path.join(dir, `preview-${state}.svg`);
  fs.writeFileSync(file, svg);
  console.log(`写入 ${file}`);
}
console.log('完成！打开 SVG 文件查看 3 个形态预览。');
