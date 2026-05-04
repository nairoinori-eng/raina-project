function seededRandom(seed) {
  let s = seed;
  return () => { s = (s * 16807 + 0) % 2147483647; return (s - 1) / 2147483646; };
}

function generateFlowerTemplate(n = 500, seed = 42) {
  const rand = seededRandom(seed);
  const N = 5, NS = Math.floor(n * 0.10), NP = n - NS, PP = Math.floor(NP / N);
  const DEG = Math.PI / 180;
  const points = [];

  const petalDefs = [];
  for (let pi = 0; pi < N; pi++) {
    const ba = pi * 72 * DEG - 90 * DEG;
    const layer = pi < 2 ? 0 : pi < 4 ? 1 : 2;

    const bloom = { cx: Math.cos(ba)*0.28, cy: Math.sin(ba)*0.28, rx: 0.24, ry: 0.24, angle: ba };

    let bud;
    if (layer === 0) {
      const side = pi === 0 ? -1 : 1;
      bud = { cx: side*0.06, cy: 0.03, rx: 0.14, ry: 0.22, angle: side*5*DEG };
    } else if (layer === 1) {
      const side = pi === 2 ? -1 : 1;
      bud = { cx: side*0.03, cy: 0.10, rx: 0.09, ry: 0.15, angle: side*3*DEG };
    } else {
      bud = { cx: 0, cy: 0.18, rx: 0.04, ry: 0.08, angle: 0 };
    }

    let half;
    if (layer === 0) {
      half = { cx: Math.cos(ba)*0.20, cy: Math.sin(ba)*0.20, rx: 0.20, ry: 0.20, angle: ba };
    } else if (layer === 1) {
      const sa = ba + 25*DEG;
      half = { cx: Math.cos(sa)*0.10, cy: Math.sin(sa)*0.10, rx: 0.12, ry: 0.12, angle: sa };
    } else {
      const sa = ba + 50*DEG;
      half = { cx: Math.cos(sa)*0.04, cy: Math.sin(sa)*0.04, rx: 0.05, ry: 0.06, angle: sa };
    }

    petalDefs.push({ bloom, bud, half });
  }

  for (let pi = 0; pi < N; pi++) {
    const def = petalDefs[pi];
    const nPts = (pi < N - 1) ? PP : NP - PP * (N - 1);
    for (let i = 0; i < nPts; i++) {
      let du, dv;
      do { du = (rand()-0.5)*2; dv = (rand()-0.5)*2; } while (du*du + dv*dv > 1.0);

      function tr(st) {
        const c = Math.cos(st.angle), s = Math.sin(st.angle);
        const lx = du * st.rx, ly = dv * st.ry;
        return [st.cx + lx*c - ly*s, st.cy + lx*s + ly*c];
      }
      points.push({ budPos: tr(def.bud), halfPos: tr(def.half), bloomPos: tr(def.bloom), petalIndex: pi });
    }
  }

  for (let i = 0; i < NS; i++) {
    const r = Math.sqrt(rand()) * 0.08, a = rand() * Math.PI * 2;
    const bx = Math.cos(a)*r, by = Math.sin(a)*r;
    points.push({ budPos: [bx*0.1, by*0.1+0.22], halfPos: [bx*0.4, by*0.4], bloomPos: [bx, by], petalIndex: 5 });
  }
  return points;
}

function toSVG(pts, state, size = 400) {
  const pad = 40, scale = (size-pad*2)/2, cx = size/2, cy = size/2;
  const colors = ['#e85050','#e8a050','#e8e050','#50b8e8','#a050e8','#f0d040'];
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">\n<rect width="${size}" height="${size}" fill="#1a1a2e"/>\n`;
  for (const pt of pts) {
    const p = state==='bud'?pt.budPos:state==='half'?pt.halfPos:pt.bloomPos;
    s += `<circle cx="${(cx+p[0]*scale).toFixed(1)}" cy="${(cy-p[1]*scale).toFixed(1)}" r="${pt.petalIndex===5?2.5:2}" fill="${colors[pt.petalIndex]}" opacity="0.8"/>\n`;
  }
  return s + '</svg>';
}

const fs = require('fs'), path = require('path');
const pts = generateFlowerTemplate(500, 42);
const dir = path.join(__dirname, 'flowers');
for (const st of ['bud','half','bloom']) {
  fs.writeFileSync(path.join(dir, `preview-${st}.svg`), toSVG(pts, st));
  console.log(`写入 preview-${st}.svg`);
}
console.log('完成！');
