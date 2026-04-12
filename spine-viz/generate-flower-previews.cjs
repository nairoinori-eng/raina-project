// 生成花朵 3 态预览 SVG（node 运行一次即可）
// 用法：node generate-flower-previews.cjs

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
    const bloomAngle = (pi / N_PETALS) * Math.PI * 2 - Math.PI / 2
                     + (rand() - 0.5) * 0.15;
    const layerDepth = pi < 2 ? 0 : pi < 4 ? 1 : 2;

    const nPts = (pi < N_PETALS - 1)
      ? PARTICLES_PER_PETAL
      : PARTICLES_PETALS - PARTICLES_PER_PETAL * (N_PETALS - 1);

    for (let i = 0; i < nPts; i++) {
      const petalRx = 0.32 + rand() * 0.04;
      const petalRy = 0.42 + rand() * 0.03;
      let lx, ly, tries = 0;
      do {
        lx = (rand() - 0.5) * 2 * petalRx;
        ly = rand() * petalRy;
        tries++;
      } while ((lx * lx) / (petalRx * petalRx) + (ly * ly) / (petalRy * petalRy) > 1.0 && tries < 80);

      // Bloom
      const bloomOffset = 0.20;
      const bCos = Math.cos(bloomAngle), bSin = Math.sin(bloomAngle);
      const bloomX = lx * bCos - (ly + bloomOffset) * bSin;
      const bloomY = lx * bSin + (ly + bloomOffset) * bCos;

      // Bud
      const budUpAngle = 0 + (pi - 2) * 0.12;
      const budNarrow = 0.35;
      const budLx = lx * budNarrow;
      const budLy = ly * 0.7;
      const budOffset = 0.03 + layerDepth * 0.02;
      const budCos = Math.cos(budUpAngle), budSin = Math.sin(budUpAngle);
      const budX = budLx * budCos - (budLy + budOffset) * budSin;
      const budY = budLx * budSin + (budLy + budOffset) * budCos;

      // Half
      const halfOpenFactor = layerDepth === 0 ? 0.65 : layerDepth === 1 ? 0.35 : 0.12;
      const halfAngle = budUpAngle + (bloomAngle - budUpAngle) * halfOpenFactor;
      const halfNarrow = budNarrow + (1.0 - budNarrow) * halfOpenFactor * 0.7;
      const halfLx = lx * halfNarrow;
      const halfLy = ly * (0.7 + 0.3 * halfOpenFactor);
      const halfOffset = budOffset + (bloomOffset - budOffset) * halfOpenFactor;
      const hCos = Math.cos(halfAngle), hSin = Math.sin(halfAngle);
      const halfX = halfLx * hCos - (halfLy + halfOffset) * hSin;
      const halfY = halfLx * hSin + (halfLy + halfOffset) * hCos;

      points.push({ budPos: [budX, budY], halfPos: [halfX, halfY], bloomPos: [bloomX, bloomY], petalIndex: pi });
    }
  }

  for (let i = 0; i < PARTICLES_STAMEN; i++) {
    const r = rand() * 0.10;
    const a = rand() * Math.PI * 2;
    const bloomX = Math.cos(a) * r;
    const bloomY = Math.sin(a) * r;
    const halfX = bloomX * 0.5;
    const halfY = bloomY * 0.5 + 0.06;
    const budX = bloomX * 0.15;
    const budY = bloomY * 0.15 + 0.12;
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
console.log('完成！');
