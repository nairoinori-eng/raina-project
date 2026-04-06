/**
 * raina-project — Three.js 粒子脊柱主程序 v3
 * =============================================
 * 改动：σ→0.06 脊柱变细 / 30k 粒子 / 随机游走 /
 *       生命周期状态机 / 逐粒子颜色偏移 / 体积光柱
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass }     from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { io } from 'socket.io-client';


// ============================================================
// 1. 脊柱坐标（13控制点 S 型脊柱）
// ============================================================

const SPINE_CURVED = [
  new THREE.Vector3( 0.00,  2.00, 0),  // C7
  new THREE.Vector3( 0.08,  1.60, 0),  // T1
  new THREE.Vector3( 0.22,  1.20, 0),  // T3
  new THREE.Vector3( 0.36,  0.80, 0),  // T5
  new THREE.Vector3( 0.42,  0.35, 0),  // T7 — 胸椎最大右凸
  new THREE.Vector3( 0.34, -0.05, 0),  // T9
  new THREE.Vector3( 0.14, -0.35, 0),  // T11
  new THREE.Vector3(-0.06, -0.60, 0),  // L1
  new THREE.Vector3(-0.22, -0.90, 0),  // L2
  new THREE.Vector3(-0.34, -1.20, 0),  // L3 — 腰椎最大左凸
  new THREE.Vector3(-0.24, -1.50, 0),  // L4
  new THREE.Vector3(-0.08, -1.80, 0),  // L5
  new THREE.Vector3( 0.00, -2.00, 0),  // S1
];
const SPINE_STRAIGHT = SPINE_CURVED.map(p => new THREE.Vector3(0, p.y, 0));

const curveCurved   = new THREE.CatmullRomCurve3(SPINE_CURVED);
const curveStraight = new THREE.CatmullRomCurve3(SPINE_STRAIGHT);


// ============================================================
// 2. 粒子数量 / 分布常量
// ============================================================

const N_MAIN        = 30000;   // 脊柱主体粒子
const N_VERT        = 1300;    // 椎节高亮粒子（13 × 100）
const N_SPINE_TOTAL = N_MAIN + N_VERT;
const N_AMBIENT     = 500;     // 环境星尘

const SIGMA      = 0.06;       // 主体粒子高斯扩散（X 方向）
const SIGMA_VERT = 0.025;      // 椎节粒子扩散
const WAVE       = 0.28;       // 级联波延迟参数


// ============================================================
// 3. 颜色
// ============================================================

const COLOR_DARK_PURPLE = new THREE.Color(0x2d1b69);
const COLOR_MID_PURPLE  = new THREE.Color(0x7b4fb5);
const COLOR_WARM_GOLD   = new THREE.Color(0xd4a24c);


// ============================================================
// 4. 工具函数
// ============================================================

function gaussRand() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function getBlendColor(blend) {
  const c = new THREE.Color();
  if (blend < 0.5) {
    c.lerpColors(COLOR_DARK_PURPLE, COLOR_MID_PURPLE, blend * 2);
  } else {
    c.lerpColors(COLOR_MID_PURPLE, COLOR_WARM_GOLD, (blend - 0.5) * 2);
  }
  return c;
}


// ============================================================
// 5. 场景 / 摄像机 / 渲染器
// ============================================================

const canvas = document.getElementById('spine-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x06060f);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0, 5);
camera.lookAt(0, 0, 0);


// ============================================================
// 6. Shader（逐粒子颜色偏移 aColorVar）
// ============================================================

const vertexShader = /* glsl */`
  attribute float aSize;
  attribute float aAlpha;
  attribute float aColorVar;

  varying float vAlpha;
  varying float vColorVar;

  void main() {
    vAlpha    = aAlpha;
    vColorVar = aColorVar;
    vec4 mv   = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (300.0 / -mv.z);
    gl_Position  = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */`
  uniform  vec3  uColor;
  varying  float vAlpha;
  varying  float vColorVar;

  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;

    // 逐粒子色偏移：正值偏暖（+R -B），负值偏冷（-R +B）
    vec3 c = uColor + vec3(vColorVar * 0.15, vColorVar * 0.04, -vColorVar * 0.12);
    c = clamp(c, 0.0, 1.0);

    float core  = exp(-d * d * 12.0);
    float halo  = exp(-d * d *  3.0) * 0.4;
    float alpha = (core + halo) * vAlpha;

    gl_FragColor = vec4(c, alpha);
  }
`;


// ============================================================
// 7. 共享几何体缓冲区（主体 + 椎节）
// ============================================================

const allPositions = new Float32Array(N_SPINE_TOTAL * 3);
const allSizes     = new Float32Array(N_SPINE_TOTAL);
const allAlphas    = new Float32Array(N_SPINE_TOTAL);
const allColorVars = new Float32Array(N_SPINE_TOTAL);


// ============================================================
// 8. 主体粒子数据（N_MAIN 个）
// ============================================================

const cpX    = new Float32Array(N_MAIN);  // curved point X
const cpY    = new Float32Array(N_MAIN);  // curved point Y
const spX    = new Float32Array(N_MAIN);  // straight point X
const spY    = new Float32Array(N_MAIN);  // straight point Y

const sT      = new Float32Array(N_MAIN);  // spine t ∈ [0,1]
const gOffX   = new Float32Array(N_MAIN);  // gaussian offset X
const gOffY   = new Float32Array(N_MAIN);  // gaussian offset Y
const zDepth  = new Float32Array(N_MAIN);  // z-depth
const bSizes  = new Float32Array(N_MAIN);  // base size
const bAlphas = new Float32Array(N_MAIN);  // base alpha
const pPhase  = new Float32Array(N_MAIN);  // pulse phase

const velX   = new Float32Array(N_MAIN);
const velY   = new Float32Array(N_MAIN);
const driftX = new Float32Array(N_MAIN);
const driftY = new Float32Array(N_MAIN);

const pAge    = new Float32Array(N_MAIN);
const pMaxAge = new Float32Array(N_MAIN);

const gatherX = new Float32Array(N_MAIN);
const gatherY = new Float32Array(N_MAIN);


function resetParticle(i) {
  sT[i] = Math.random();

  const cp = curveCurved.getPoint(sT[i]);
  const sp = curveStraight.getPoint(sT[i]);
  cpX[i] = cp.x;  cpY[i] = cp.y;
  spX[i] = sp.x;  spY[i] = sp.y;

  gOffX[i] = gaussRand() * SIGMA;
  gOffY[i] = gaussRand() * SIGMA * 0.28;
  zDepth[i] = gaussRand() * 0.35;

  const dist = Math.min(1,
    Math.sqrt(gOffX[i] * gOffX[i] + gOffY[i] * gOffY[i]) / (2.5 * SIGMA)
  );
  bSizes[i]  = (0.055 - dist * 0.025) + Math.random() * 0.015;
  bAlphas[i] = (0.10  - dist * 0.07)  + Math.random() * 0.025;
  pPhase[i]  = Math.random() * Math.PI * 2;

  velX[i] = 0;  velY[i] = 0;
  driftX[i] = 0;  driftY[i] = 0;

  pMaxAge[i] = 100 + Math.random() * 300;
  pAge[i]    = 0;

  const angle = Math.random() * Math.PI * 2;
  const d2    = 0.3 + Math.random() * 0.5;
  gatherX[i]  = cp.x + gOffX[i] + Math.cos(angle) * d2;
  gatherY[i]  = cp.y + gOffY[i] + Math.sin(angle) * d2;

  allColorVars[i] = (Math.random() - 0.5) * 0.25;
}

// 初始化主体粒子，错开出生相位
for (let i = 0; i < N_MAIN; i++) {
  resetParticle(i);
  pAge[i] = Math.random() * pMaxAge[i];
}


// ============================================================
// 9. 椎节高亮粒子（N_VERT = 13 × 100）
// ============================================================

const vtCurvedX = new Float32Array(N_VERT);
const vtDeltaX  = new Float32Array(N_VERT);  // straightX - curvedX = -cx
const vtBaseY   = new Float32Array(N_VERT);
const vtBaseZ   = new Float32Array(N_VERT);
const vtST      = new Float32Array(N_VERT);

for (let vi = 0; vi < 13; vi++) {
  const cx = SPINE_CURVED[vi].x;
  const cy = SPINE_CURVED[vi].y;
  const sx = SPINE_STRAIGHT[vi].x;  // = 0
  const t  = vi / 12;

  for (let j = 0; j < 100; j++) {
    const idx = vi * 100 + j;
    const gx  = gaussRand() * SIGMA_VERT;
    const gy  = gaussRand() * SIGMA_VERT * 0.4;

    vtCurvedX[idx] = cx + gx;
    vtDeltaX[idx]  = sx - cx;
    vtBaseY[idx]   = cy + gy;
    vtBaseZ[idx]   = gaussRand() * 0.2;
    vtST[idx]      = t;

    const gi = N_MAIN + idx;
    allPositions[gi*3]   = cx + gx;
    allPositions[gi*3+1] = cy + gy;
    allPositions[gi*3+2] = vtBaseZ[idx];
    allSizes[gi]         = 0.07 + Math.random() * 0.04;
    allAlphas[gi]        = 0.35 + Math.random() * 0.15;
    allColorVars[gi]     = (Math.random() - 0.5) * 0.40;
  }
}


// ============================================================
// 10. 脊柱 Points（主体 + 椎节共用一个几何体）
// ============================================================

const spineGeo = new THREE.BufferGeometry();
spineGeo.setAttribute('position',  new THREE.BufferAttribute(allPositions, 3));
spineGeo.setAttribute('aSize',     new THREE.BufferAttribute(allSizes, 1));
spineGeo.setAttribute('aAlpha',    new THREE.BufferAttribute(allAlphas, 1));
spineGeo.setAttribute('aColorVar', new THREE.BufferAttribute(allColorVars, 1));

const spineMat = new THREE.ShaderMaterial({
  vertexShader,
  fragmentShader,
  uniforms:    { uColor: { value: COLOR_DARK_PURPLE.clone() } },
  transparent: true,
  blending:    THREE.AdditiveBlending,
  depthWrite:  false,
});
scene.add(new THREE.Points(spineGeo, spineMat));


// ============================================================
// 11. 体积光柱（脊柱背后，z=-0.5）
// ============================================================

const volumeGeo = new THREE.PlaneGeometry(0.9, 4.2);
const volumeMat = new THREE.ShaderMaterial({
  uniforms: {
    uColor: { value: new THREE.Color() },
    uAlpha: { value: 0.08 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform vec3  uColor;
    uniform float uAlpha;
    varying vec2  vUv;
    void main() {
      float edge = 1.0 - abs(vUv.x - 0.5) * 2.0;
      float ends = smoothstep(0.0, 0.1, vUv.y) * smoothstep(1.0, 0.9, vUv.y);
      gl_FragColor = vec4(uColor, uAlpha * edge * edge * ends);
    }
  `,
  transparent: true,
  depthWrite:  false,
  blending:    THREE.AdditiveBlending,
  side:        THREE.DoubleSide,
});
const volumeMesh = new THREE.Mesh(volumeGeo, volumeMat);
volumeMesh.position.set(0, 0, -0.5);
scene.add(volumeMesh);


// ============================================================
// 12. 环境微粒（N_AMBIENT 个背景星尘）
// ============================================================

const ambBase      = new Float32Array(N_AMBIENT * 3);
const ambOrbitR    = new Float32Array(N_AMBIENT);
const ambOrbitSpd  = new Float32Array(N_AMBIENT);
const ambOrbitPh   = new Float32Array(N_AMBIENT);
const ambPositions = new Float32Array(N_AMBIENT * 3);
const ambSizes     = new Float32Array(N_AMBIENT);
const ambAlphas    = new Float32Array(N_AMBIENT);
const ambColorVars = new Float32Array(N_AMBIENT);

for (let i = 0; i < N_AMBIENT; i++) {
  ambBase[i*3]   = (Math.random() - 0.5) * 10;
  ambBase[i*3+1] = (Math.random() - 0.5) * 7;
  ambBase[i*3+2] = (Math.random() - 0.5) * 1.5;

  ambPositions[i*3]   = ambBase[i*3];
  ambPositions[i*3+1] = ambBase[i*3+1];
  ambPositions[i*3+2] = ambBase[i*3+2];

  ambSizes[i]     = 0.012 + Math.random() * 0.018;
  ambAlphas[i]    = 0.07  + Math.random() * 0.10;
  ambOrbitR[i]    = 0.06  + Math.random() * 0.20;
  ambOrbitSpd[i]  = 0.05  + Math.random() * 0.15;
  ambOrbitPh[i]   = Math.random() * Math.PI * 2;
  ambColorVars[i] = (Math.random() - 0.5) * 0.20;
}

const ambGeo = new THREE.BufferGeometry();
ambGeo.setAttribute('position',  new THREE.BufferAttribute(ambPositions, 3));
ambGeo.setAttribute('aSize',     new THREE.BufferAttribute(ambSizes, 1));
ambGeo.setAttribute('aAlpha',    new THREE.BufferAttribute(ambAlphas, 1));
ambGeo.setAttribute('aColorVar', new THREE.BufferAttribute(ambColorVars, 1));

const ambMat = new THREE.ShaderMaterial({
  vertexShader,
  fragmentShader,
  uniforms:    { uColor: { value: new THREE.Color(0x2a1855) } },
  transparent: true,
  blending:    THREE.AdditiveBlending,
  depthWrite:  false,
});
scene.add(new THREE.Points(ambGeo, ambMat));


// ============================================================
// 13. 后处理：Bloom
// ============================================================

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.7,   // strength（动态调整）
  0.6,   // radius
  0.15   // threshold
);
composer.addPass(bloomPass);


// ============================================================
// 14. 状态 / blend 控制
// ============================================================

let currentMode   = 'IDLE';
let targetBlend   = 0.0;
let smoothBlend   = 0.0;
let blendVelocity = 0.0;


// ============================================================
// 15. 动画主循环
// ============================================================

let time = 0;

function animate() {
  requestAnimationFrame(animate);
  time += 0.016;

  // 弹簧物理平滑 blend
  const springF = (targetBlend - smoothBlend) * 0.035;
  blendVelocity = blendVelocity * 0.82 + springF;
  smoothBlend   = Math.max(0, Math.min(1, smoothBlend + blendVelocity));

  // 全局呼吸脉动（5秒周期）
  const breathe     = Math.sin(time * 1.257) * 0.5 + 0.5;
  const spreadScale = 1 + breathe * 0.06;

  // ── 主体粒子更新 ──────────────────────────────────────────
  for (let i = 0; i < N_MAIN; i++) {
    pAge[i]++;

    // 随机游走：速度微扰 + 均值回归
    velX[i] += (Math.random() - 0.5) * 0.0008;
    if (velX[i] >  0.006) velX[i] =  0.006;
    if (velX[i] < -0.006) velX[i] = -0.006;
    driftX[i] = (driftX[i] + velX[i]) * 0.998;

    velY[i] += (Math.random() - 0.5) * 0.0006;
    if (velY[i] >  0.005) velY[i] =  0.005;
    if (velY[i] < -0.005) velY[i] = -0.005;
    driftY[i] = (driftY[i] + velY[i]) * 0.998;

    // 死亡 → 重生
    if (pAge[i] >= pMaxAge[i]) {
      resetParticle(i);
      allPositions[i*3]   = gatherX[i];
      allPositions[i*3+1] = gatherY[i];
      allPositions[i*3+2] = zDepth[i];
      allAlphas[i]        = 0;
      continue;
    }

    // 级联 localBlend（底部粒子先响应）
    const localBlend = Math.max(0, Math.min(1,
      (smoothBlend - (1 - sT[i]) * WAVE) / (1 - WAVE)
    ));

    const bx      = cpX[i] + (spX[i] - cpX[i]) * localBlend;
    const by      = cpY[i] + (spY[i] - cpY[i]) * localBlend;
    const stableX = bx + gOffX[i] * spreadScale;
    const stableY = by + gOffY[i] * spreadScale;

    const ratio = pAge[i] / pMaxAge[i];
    let px, py, alpha;

    if (ratio < 0.2) {
      // GATHERING：从随机点飞向稳定位置
      const t = ratio / 0.2;
      px    = gatherX[i] + (stableX - gatherX[i]) * t;
      py    = gatherY[i] + (stableY - gatherY[i]) * t;
      alpha = bAlphas[i] * t;

    } else if (ratio < 0.8) {
      // STABLE：稳定漂浮
      px    = stableX + driftX[i];
      py    = stableY + driftY[i];
      alpha = bAlphas[i];

    } else {
      // DISPERSING：向聚合点方向飘散
      const t = (ratio - 0.8) / 0.2;
      px    = stableX + (gatherX[i] - stableX) * t + driftX[i] * (1 - t);
      py    = stableY + (gatherY[i] - stableY) * t + driftY[i] * (1 - t);
      alpha = bAlphas[i] * (1 - t);
    }

    allPositions[i*3]   = px;
    allPositions[i*3+1] = py;
    allPositions[i*3+2] = zDepth[i];

    allSizes[i]  = bSizes[i] * (1.0 + Math.sin(time * 1.57 + pPhase[i]) * 0.08);
    allAlphas[i] = alpha;

    // 颜色缓慢漂变
    allColorVars[i] += (Math.random() - 0.5) * 0.002;
    if (allColorVars[i] >  0.25) allColorVars[i] =  0.25;
    if (allColorVars[i] < -0.25) allColorVars[i] = -0.25;
  }

  // ── 椎节粒子：仅更新 X（随 blend 变化，Y/Z 静止）──────────
  for (let j = 0; j < N_VERT; j++) {
    const gi = N_MAIN + j;
    const localBlend = Math.max(0, Math.min(1,
      (smoothBlend - (1 - vtST[j]) * WAVE) / (1 - WAVE)
    ));
    allPositions[gi*3] = vtCurvedX[j] + vtDeltaX[j] * localBlend;
  }

  spineGeo.attributes.position.needsUpdate  = true;
  spineGeo.attributes.aSize.needsUpdate     = true;
  spineGeo.attributes.aAlpha.needsUpdate    = true;
  spineGeo.attributes.aColorVar.needsUpdate = true;

  // 颜色同步
  const blendColor = getBlendColor(smoothBlend);
  spineMat.uniforms.uColor.value.copy(blendColor);

  // 体积光柱：颜色 + 呼吸透明度
  volumeMat.uniforms.uColor.value.copy(blendColor);
  volumeMat.uniforms.uAlpha.value = 0.05 + breathe * 0.06;

  // Bloom 随呼吸 + blend 动态调整
  bloomPass.strength = 0.6 + breathe * 0.35 + smoothBlend * 0.25;

  // 环境微粒（圆形轨道漂浮）
  const ap = ambGeo.attributes.position.array;
  for (let i = 0; i < N_AMBIENT; i++) {
    ap[i*3]   = ambBase[i*3]   + Math.cos(time * ambOrbitSpd[i]       + ambOrbitPh[i]) * ambOrbitR[i];
    ap[i*3+1] = ambBase[i*3+1] + Math.sin(time * ambOrbitSpd[i] * 0.7 + ambOrbitPh[i]) * ambOrbitR[i];
  }
  ambGeo.attributes.position.needsUpdate = true;

  if (debugBlend) debugBlend.textContent = smoothBlend.toFixed(3);

  composer.render();
}


// ============================================================
// 16. SocketIO（与 Flask 通信）
// ============================================================

const socket = io('http://localhost:5000');

socket.on('connect',    () => { console.log('✅ Flask 已连接'); updateDebugUI(); });
socket.on('disconnect', () => { console.log('❌ Flask 断开');   });

socket.on('sensor_data', (data) => {
  targetBlend = data.blend;
  updateDebugUI();
});

socket.on('state_change', (data) => {
  currentMode = data.mode;
  if (data.blend !== undefined) targetBlend = data.blend;
  updateDebugUI();
  console.log(`[状态] → ${currentMode}`);
});


// ============================================================
// 17. 调试面板
// ============================================================

const debugPanel  = document.getElementById('debug-panel');
const debugState  = document.getElementById('debug-state');
const debugBlend  = document.getElementById('debug-blend');
const blendSlider = document.getElementById('blend-slider');

blendSlider.addEventListener('input', () => {
  socket.emit('set_blend', { value: blendSlider.value / 100 });
});

document.getElementById('btn-start').addEventListener('click', () => socket.emit('button_press'));
document.getElementById('btn-reset').addEventListener('click', () => socket.emit('button_press'));

function updateDebugUI() {
  if (debugState) debugState.textContent = currentMode;
  if (debugBlend) debugBlend.textContent = smoothBlend.toFixed(3);
}


// ============================================================
// 18. 键盘快捷键
// ============================================================

document.addEventListener('keydown', (e) => {
  if (e.key === 'd' || e.key === 'D') debugPanel.classList.toggle('hidden');
  if (e.key === 'f' || e.key === 'F') {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  }
});


// ============================================================
// 19. 窗口缩放
// ============================================================

window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
});

animate();
