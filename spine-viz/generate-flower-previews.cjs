// 生成花朵 3 态预览 SVG
// 用法：node generate-flower-previews.cjs

function seededRandom(seed) {
  let s = seed;
  return () => { s = (s * 16807 + 0) % 2147483647; return (s - 1) / 2147483646; };
}

function generateFlowerTemplate(n = 500, seed = 42) {
  const rand = seededRandom(seed);
  const N = 5;
  const NS = Math.floor(n * 0.10);
  const NP = n - NS;
  const PP = Math.floor(NP / N);

  function eggR(v) { return 0.22 * Math.pow(Math.sin(v * Math.PI), 0.6); }
  const EB = -0.25, ET = 0.32, EH = ET - EB;

  const pts = [];
  for (let pi = 0; pi < N; pi++) {
    const ba = (pi / N) * Math.PI * 2 - Math.PI / 2 + (rand() - 0.5) * 0.10;
    const layer = pi < 2 ? 0 : pi < 4 ? 1 : 2;
    const nPts = (pi < N - 1) ? PP : NP - PP * (N - 1);

    for (let i = 0; i < nPts; i++) {
      let u, v;
      do { u = (rand() - 0.5) * 2; v = rand(); } while (u * u + v * v > 1.0);

      // BLOOM
      const bR = 0.32, bW = 0.26, bH = 0.26;
      const blx = u * bW, bly = v * bH + bR;
      const bc = Math.cos(ba), bs = Math.sin(ba);
      const bloomX = blx * bc - bly * bs, bloomY = blx * bs + bly * bc;

      // BUD
      let budX, budY;
      if (layer === 0) {
        const side = pi === 0 ? -1 : 1;
        const bv = 0.06 + (1 - v) * 0.88;
        const er = eggR(bv);
        budY = EB + bv * EH;
        budX = er * (side * 0.40 + u * 0.60);
      } else if (layer === 1) {
        const side = pi === 2 ? -1 : 1;
        const bv = 0.38 + (1 - v) * 0.54;
        const er = eggR(bv) * 0.72;
        budY = EB + bv * EH;
        budX = er * (side * 0.28 + u * 0.45);
      } else {
        const bv = 0.62 + (1 - v) * 0.30;
        const er = eggR(bv) * 0.35;
        budY = EB + bv * EH;
        budX = er * u * 0.40;
      }

      // HALF
      let halfX, halfY;
      if (layer === 0) {
        const hR = bR * 0.75, hW = bW * 0.85, hH = bH * 0.80;
        const hx = u * hW, hy = v * hH + hR;
        halfX = hx * bc - hy * bs; halfY = hx * bs + hy * bc;
      } else if (layer === 1) {
        const sa = ba + 0.35, hR = bR * 0.38, hW = bW * 0.55, hH = bH * 0.50;
        const hx = u * hW, hy = v * hH + hR;
        const sc = Math.cos(sa), ss = Math.sin(sa);
        halfX = hx * sc - hy * ss; halfY = hx * ss + hy * sc;
      } else {
        const sa = ba + 0.7, hR = 0.07, hW = 0.05, hH = 0.06;
        const hx = u * hW, hy = v * hH + hR;
        const sc = Math.cos(sa), ss = Math.sin(sa);
        halfX = hx * sc - hy * ss; halfY = hx * ss + hy * sc;
      }

      pts.push({ budPos: [budX, budY], halfPos: [halfX, halfY], bloomPos: [bloomX, bloomY], petalIndex: pi });
    }
  }

  for (let i = 0; i < NS; i++) {
    const r = rand() * 0.08, a = rand() * Math.PI * 2;
    const bx = Math.cos(a) * r, by = Math.sin(a) * r;
    pts.push({ budPos: [bx * 0.08, by * 0.08 + ET - 0.06], halfPos: [bx * 0.35, by * 0.35 + 0.04], bloomPos: [bx, by], petalIndex: 5 });
  }
  return pts;
}

function toSVG(pts, state, size = 400) {
  const pad = 40, scale = (size - pad * 2) / 2, cx = size / 2, cy = size / 2;
  const colors = ['#e85050', '#e8a050', '#e8e050', '#50b8e8', '#a050e8', '#f0d040'];
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">\n<rect width="${size}" height="${size}" fill="#1a1a2e"/>\n`;
  for (const pt of pts) {
    const p = state === 'bud' ? pt.budPos : state === 'half' ? pt.halfPos : pt.bloomPos;
    const x = cx + p[0] * scale, y = cy - p[1] * scale;
    s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${pt.petalIndex === 5 ? 2.5 : 2}" fill="${colors[pt.petalIndex]}" opacity="0.8"/>\n`;
  }
  return s + '</svg>';
}

const fs = require('fs'), path = require('path');
const pts = generateFlowerTemplate(500, 42);
const dir = path.join(__dirname, 'flowers');
for (const st of ['bud', 'half', 'bloom']) {
  fs.writeFileSync(path.join(dir, `preview-${st}.svg`), toSVG(pts, st));
  console.log(`写入 preview-${st}.svg`);
}
console.log('完成！');
