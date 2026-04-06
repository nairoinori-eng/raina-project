/**
 * raina-project — Three.js 粒子脊柱主程序 v4
 * =============================================
 * 四层架构：
 *   Layer A  骨骼柱体（5000，静止，两端渐隐）
 *   Layer B  椎节椭圆（13×300=3900，宽扁，明亮）
 *   Layer C  弥散粒子流（4000，弧线轨迹，从椎节侧边飘出）
 *   Layer D  脊柱辉光线（60个大粒子，跟随曲线弯曲）
 *   Layer E  环境星尘（300，圆形轨道）
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass }     from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { io } from 'socket.io-client';


// ============================================================
// 1. 脊柱坐标（13控制点 S 型脊柱）
// ============================================================

const SPINE_SCALE = 1.18;   // 整体缩放（上下留约15%余量）

const SPINE_CURVED = [
  new THREE.Vector3( 0.00 * SPINE_SCALE,  2.00 * SPINE_SCALE, 0),  // C7
  new THREE.Vector3( 0.08 * SPINE_SCALE,  1.60 * SPINE_SCALE, 0),  // T1
  new THREE.Vector3( 0.22 * SPINE_SCALE,  1.20 * SPINE_SCALE, 0),  // T3
  new THREE.Vector3( 0.36 * SPINE_SCALE,  0.80 * SPINE_SCALE, 0),  // T5
  new THREE.Vector3( 0.42 * SPINE_SCALE,  0.35 * SPINE_SCALE, 0),  // T7
  new THREE.Vector3( 0.34 * SPINE_SCALE, -0.05 * SPINE_SCALE, 0),  // T9
  new THREE.Vector3( 0.14 * SPINE_SCALE, -0.35 * SPINE_SCALE, 0),  // T11
  new THREE.Vector3(-0.06 * SPINE_SCALE, -0.60 * SPINE_SCALE, 0),  // L1
  new THREE.Vector3(-0.22 * SPINE_SCALE, -0.90 * SPINE_SCALE, 0),  // L2
  new THREE.Vector3(-0.34 * SPINE_SCALE, -1.20 * SPINE_SCALE, 0),  // L3
  new THREE.Vector3(-0.24 * SPINE_SCALE, -1.50 * SPINE_SCALE, 0),  // L4
  new THREE.Vector3(-0.08 * SPINE_SCALE, -1.80 * SPINE_SCALE, 0),  // L5
  new THREE.Vector3( 0.00 * SPINE_SCALE, -2.00 * SPINE_SCALE, 0),  // S1
];
const SPINE_STRAIGHT = SPINE_CURVED.map(p => new THREE.Vector3(0, p.y, 0));

const curveCurved   = new THREE.CatmullRomCurve3(SPINE_CURVED);
const curveStraight = new THREE.CatmullRomCurve3(SPINE_STRAIGHT);


// ============================================================
// 2. 粒子数量
// ============================================================

const N_BONE  = 5000;                  // Layer A
const N_VERT  = 3900;                  // Layer B (13 × 300)
const N_SPINE = N_BONE + N_VERT;       // spineGeo 总量

const N_DIFF  = 4000;                  // Layer C
const N_GLOW  = 60;                    // Layer D
const N_DFULL = N_DIFF + N_GLOW;       // diffuseGeo 总量

const N_AMB   = 300;                   // Layer E


// ============================================================
// 3. 颜色（低饱和度，优雅克制）
// ============================================================

const COLOR_DARK = new THREE.Color(0x18102e);
const COLOR_MID  = new THREE.Color(0x4a2e6e);
const COLOR_GOLD = new THREE.Color(0x9a7230);


// ============================================================
// 4. 工具函数
// ============================================================

function gaussRand() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function smoothstep(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** 非对称呼吸曲线：4s亮起 → 2s保持 → 4s暗下（10s周期） */
function breatheCurve(t) {
  const phase = (t % 10.0) / 10.0;
  if (phase < 0.40) return Math.sin(phase / 0.40 * Math.PI * 0.5);
  if (phase < 0.60) return 1.0;
  return Math.cos((phase - 0.60) / 0.40 * Math.PI * 0.5);
}

function getBlendColor(blend) {
  const c = new THREE.Color();
  if (blend < 0.5) {
    c.lerpColors(COLOR_DARK, COLOR_MID, blend * 2);
  } else {
    c.lerpColors(COLOR_MID, COLOR_GOLD, (blend - 0.5) * 2);
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
scene.background = new THREE.Color(0x05050d);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0, 5);
camera.lookAt(0, 0, 0);


// ============================================================
// 6. Shader（逐粒子颜色偏移）
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
    vec3 c = uColor + vec3(vColorVar * 0.12, vColorVar * 0.03, -vColorVar * 0.10);
    c = clamp(c, 0.0, 1.0);
    // 收紧核心，削弱光晕 — 保持粒子颗粒感
    float core  = exp(-d * d * 24.0);          // 更锐利的核心
    float halo  = exp(-d * d * 10.0) * 0.15;   // 更弱更紧凑的光晕
    float alpha = (core + halo) * vAlpha;
    gl_FragColor = vec4(c, alpha);
  }
`;


// ============================================================
// 7. spineGeo (Layer A + Layer B)
// ============================================================

const spPositions = new Float32Array(N_SPINE * 3);
const spSizes     = new Float32Array(N_SPINE);
const spAlphas    = new Float32Array(N_SPINE);
const spColorVars = new Float32Array(N_SPINE);


// ── Layer A：骨骼柱体（5000粒子，静止，空心管状）─────────────

// 空心管参数：大跨度 + 明确的中空（跟随 SPINE_SCALE 缩放）
const TUBE_OUTER   = 0.10 * SPINE_SCALE;        // 外壁半径
const TUBE_INNER   = 0.055 * SPINE_SCALE;       // 内壁半径
const TUBE_THICK   = 0.018 * SPINE_SCALE;       // 壁厚度
const TUBE_Y_SCALE = 0.28;                       // Y方向压扁

const bCpX   = new Float32Array(N_BONE);
const bCpY   = new Float32Array(N_BONE);
const bSpX   = new Float32Array(N_BONE);
const bSpY   = new Float32Array(N_BONE);
const bT     = new Float32Array(N_BONE);
const bOffX  = new Float32Array(N_BONE);
const bOffY  = new Float32Array(N_BONE);
const bZ     = new Float32Array(N_BONE);
const bBaseS = new Float32Array(N_BONE);   // base size
const bBaseA = new Float32Array(N_BONE);   // base alpha
const bPhase = new Float32Array(N_BONE);

for (let i = 0; i < N_BONE; i++) {
  bT[i] = Math.random();
  const cp = curveCurved.getPoint(bT[i]);
  const sp = curveStraight.getPoint(bT[i]);
  bCpX[i] = cp.x;  bCpY[i] = cp.y;
  bSpX[i] = sp.x;  bSpY[i] = sp.y;

  // 薄壁空心管：粒子严格分布在 [TUBE_INNER, TUBE_OUTER] 薄环上
  const angle = Math.random() * Math.PI * 2;
  // 半径：在薄壁环内均匀分布（不是从中心开始的高斯）
  const r = TUBE_INNER + Math.pow(Math.random(), 0.5) * (TUBE_OUTER - TUBE_INNER);

  bOffX[i] = Math.cos(angle) * r;
  bOffY[i] = Math.sin(angle) * r * TUBE_Y_SCALE;
  bZ[i]    = gaussRand() * 0.35;

  // 外壁粒子更大更亮，强化轮廓感
  const wallRatio = (r - TUBE_INNER) / (TUBE_OUTER - TUBE_INNER);  // 0=内壁, 1=外壁
  bBaseS[i] = (0.09 + wallRatio * 0.07) * (0.6 + Math.random() * 0.8);
  bBaseA[i] = (0.08 + wallRatio * 0.10) + Math.random() * 0.04;
  bPhase[i] = Math.random() * Math.PI * 2;

  spColorVars[i] = (Math.random() - 0.5) * 0.25;
  // 初始位置（动画第一帧会覆盖，先占位）
  spPositions[i*3]   = cp.x + bOffX[i];
  spPositions[i*3+1] = cp.y + bOffY[i];
  spPositions[i*3+2] = bZ[i];
}


// ── Layer B：椎节椭圆（3900粒子，宽扁，加粗强调）─────────────

const SIGMA_VX = 0.14 * SPINE_SCALE;   // X 宽（横向）
const SIGMA_VY = 0.028 * SPINE_SCALE;  // Y 窄（纵向）

const vCurvedX  = new Float32Array(N_VERT);
const vDeltaX   = new Float32Array(N_VERT);  // straightX - curvedX = -cx
const vBaseY    = new Float32Array(N_VERT);
const vBaseZ    = new Float32Array(N_VERT);
const vST       = new Float32Array(N_VERT);
const vBaseSize = new Float32Array(N_VERT);
const vBaseAlph = new Float32Array(N_VERT);

for (let vi = 0; vi < 13; vi++) {
  const cx = SPINE_CURVED[vi].x;
  const cy = SPINE_CURVED[vi].y;
  const t  = vi / 12;

  for (let j = 0; j < 300; j++) {
    const idx = vi * 300 + j;
    const gx  = gaussRand() * SIGMA_VX;
    const gy  = gaussRand() * SIGMA_VY;

    vCurvedX[idx] = cx + gx;
    vDeltaX[idx]  = -cx;
    vBaseY[idx]   = cy + gy;
    vBaseZ[idx]   = gaussRand() * 0.15;
    vST[idx]      = t;

    const distX = Math.abs(gx) / SIGMA_VX;
    const distY = Math.abs(gy) / SIGMA_VY;
    const dist  = Math.min(1, Math.sqrt(distX*distX + distY*distY) * 0.6);

    // 大粒子，明显大于骨骼 — 椎节要"鼓出来"
    vBaseSize[idx] = (0.22 - dist * 0.08) * (0.70 + Math.random() * 0.70);
    vBaseAlph[idx] = (0.50 - dist * 0.22) + Math.random() * 0.12;

    const gi = N_BONE + idx;
    spPositions[gi*3]   = cx + gx;
    spPositions[gi*3+1] = cy + gy;
    spPositions[gi*3+2] = vBaseZ[idx];
    spSizes[gi]         = vBaseSize[idx];
    spAlphas[gi]        = vBaseAlph[idx];
    spColorVars[gi]     = (Math.random() - 0.5) * 0.35;
  }
}

const spineGeo = new THREE.BufferGeometry();
spineGeo.setAttribute('position',  new THREE.BufferAttribute(spPositions, 3));
spineGeo.setAttribute('aSize',     new THREE.BufferAttribute(spSizes, 1));
spineGeo.setAttribute('aAlpha',    new THREE.BufferAttribute(spAlphas, 1));
spineGeo.setAttribute('aColorVar', new THREE.BufferAttribute(spColorVars, 1));

const spineMat = new THREE.ShaderMaterial({
  vertexShader, fragmentShader,
  uniforms:    { uColor: { value: COLOR_DARK.clone() } },
  transparent: true,
  blending:    THREE.AdditiveBlending,
  depthWrite:  false,
});
scene.add(new THREE.Points(spineGeo, spineMat));


// ============================================================
// 8. diffuseGeo (Layer C + Layer D)
// ============================================================

const dfPositions = new Float32Array(N_DFULL * 3);
const dfSizes     = new Float32Array(N_DFULL);
const dfAlphas    = new Float32Array(N_DFULL);
const dfColorVars = new Float32Array(N_DFULL);


// ── Layer C：弥散粒子流（4000粒子）─────────────────────────

// 5条光带方向（相对于水平轴的角度偏移）
const STREAM_ANGLES = [-0.55, -0.28, 0.0, 0.28, 0.55];

const dPx      = new Float32Array(N_DIFF);
const dPy      = new Float32Array(N_DIFF);
const dAngle   = new Float32Array(N_DIFF);
const dCurveK  = new Float32Array(N_DIFF);  // 弧线曲率（慢旋转）
const dSpeed   = new Float32Array(N_DIFF);
const dAge     = new Float32Array(N_DIFF);
const dMaxAge  = new Float32Array(N_DIFF);
const dVi      = new Uint8Array(N_DIFF);    // 所属椎节（0-12）
const dSide    = new Int8Array(N_DIFF);     // 出发侧（+1右, -1左）
const dBSize   = new Float32Array(N_DIFF);
const dBAlpha  = new Float32Array(N_DIFF);

function resetDiffuse(i, blend) {
  const vi   = Math.floor(Math.random() * 13);
  const side = Math.random() < 0.5 ? 1 : -1;
  const si   = Math.floor(Math.random() * 5);

  dVi[i]    = vi;
  dSide[i]  = side;

  // 弧线初始方向：水平向外 + 光带角度 + 微小随机扰动
  dAngle[i]  = (side > 0 ? 0 : Math.PI) + STREAM_ANGLES[si] + (Math.random() - 0.5) * 0.12;
  // 曲率：极慢旋转让轨迹形成弧线
  dCurveK[i] = (Math.random() < 0.5 ? 1 : -1) * (0.3 + Math.random() * 0.7);
  dSpeed[i]  = 0.003 + Math.random() * 0.004;   // 非常慢
  dMaxAge[i] = 400 + Math.random() * 600;        // 7-17秒
  dAge[i]    = 0;

  // 出生位置：紧贴椎节外侧顶点（跟随 blend）
  const vtX = SPINE_CURVED[vi].x * (1 - blend) + side * (SIGMA_VX + 0.01);
  const vtY = SPINE_CURVED[vi].y + (Math.random() - 0.5) * 0.025;
  dPx[i] = vtX;
  dPy[i] = vtY;

  // 大小差异明显（小的很小，大的是小的2-3倍）
  const sz = Math.random();
  dBSize[i]  = 0.020 + sz * sz * 0.060;         // 非线性：多数小，少数大
  dBAlpha[i] = 0.04  + Math.random() * 0.08;

  dfColorVars[i] = (Math.random() - 0.5) * 0.18;
}

// 初始化弥散粒子，错开相位
for (let i = 0; i < N_DIFF; i++) {
  resetDiffuse(i, 0);
  // 错开相位：估算粒子在弧线上的初始位置
  const stagger = Math.random();
  dAge[i] = stagger * dMaxAge[i];
  const steps = dAge[i];
  // 简化估算（不考虑弧线曲率）
  dPx[i] += Math.cos(dAngle[i]) * dSpeed[i] * steps;
  dPy[i] += Math.sin(dAngle[i]) * dSpeed[i] * steps;
}


// ── Layer D：辉光线（60个大粒子，跟随曲线）──────────────────

// 预计算辉光点的曲线位置（初始化时固定，animate 内仅做线性插值）
const glowCurvedX  = new Float32Array(N_GLOW);
const glowStraightX = new Float32Array(N_GLOW);
const glowY         = new Float32Array(N_GLOW);

for (let i = 0; i < N_GLOW; i++) {
  const t0 = i / (N_GLOW - 1);
  const cp = curveCurved.getPoint(t0);
  const sp = curveStraight.getPoint(t0);
  glowCurvedX[i]   = cp.x;
  glowStraightX[i] = sp.x;
  glowY[i]         = cp.y;
  dfSizes[N_DIFF + i]     = 0.40;   // 大型软圆（屏幕 ~24px）
  dfColorVars[N_DIFF + i] = 0;
}

const diffuseGeo = new THREE.BufferGeometry();
diffuseGeo.setAttribute('position',  new THREE.BufferAttribute(dfPositions, 3));
diffuseGeo.setAttribute('aSize',     new THREE.BufferAttribute(dfSizes, 1));
diffuseGeo.setAttribute('aAlpha',    new THREE.BufferAttribute(dfAlphas, 1));
diffuseGeo.setAttribute('aColorVar', new THREE.BufferAttribute(dfColorVars, 1));

const diffuseMat = new THREE.ShaderMaterial({
  vertexShader, fragmentShader,
  uniforms:    { uColor: { value: COLOR_DARK.clone() } },
  transparent: true,
  blending:    THREE.AdditiveBlending,
  depthWrite:  false,
});
scene.add(new THREE.Points(diffuseGeo, diffuseMat));


// ============================================================
// 9. ambGeo (Layer E)
// ============================================================

const ambBase     = new Float32Array(N_AMB * 3);
const ambOrbitR   = new Float32Array(N_AMB);
const ambOrbitSpd = new Float32Array(N_AMB);
const ambOrbitPh  = new Float32Array(N_AMB);
const ambPos      = new Float32Array(N_AMB * 3);
const ambSizes    = new Float32Array(N_AMB);
const ambAlphas   = new Float32Array(N_AMB);
const ambCVars    = new Float32Array(N_AMB);

for (let i = 0; i < N_AMB; i++) {
  ambBase[i*3]   = (Math.random() - 0.5) * 10;
  ambBase[i*3+1] = (Math.random() - 0.5) * 7;
  ambBase[i*3+2] = (Math.random() - 0.5) * 1.5;
  ambPos[i*3]   = ambBase[i*3];
  ambPos[i*3+1] = ambBase[i*3+1];
  ambPos[i*3+2] = ambBase[i*3+2];
  ambSizes[i]    = 0.010 + Math.random() * 0.015;
  ambAlphas[i]   = 0.05  + Math.random() * 0.08;
  ambOrbitR[i]   = 0.04  + Math.random() * 0.18;
  ambOrbitSpd[i] = 0.04  + Math.random() * 0.12;
  ambOrbitPh[i]  = Math.random() * Math.PI * 2;
  ambCVars[i]    = (Math.random() - 0.5) * 0.15;
}

const ambGeo = new THREE.BufferGeometry();
ambGeo.setAttribute('position',  new THREE.BufferAttribute(ambPos, 3));
ambGeo.setAttribute('aSize',     new THREE.BufferAttribute(ambSizes, 1));
ambGeo.setAttribute('aAlpha',    new THREE.BufferAttribute(ambAlphas, 1));
ambGeo.setAttribute('aColorVar', new THREE.BufferAttribute(ambCVars, 1));

const ambMat = new THREE.ShaderMaterial({
  vertexShader, fragmentShader,
  uniforms:    { uColor: { value: new THREE.Color(0x18102e) } },
  transparent: true,
  blending:    THREE.AdditiveBlending,
  depthWrite:  false,
});
scene.add(new THREE.Points(ambGeo, ambMat));


// ============================================================
// 10. 后处理
// ============================================================

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.30,  // strength（降低，避免过度模糊）
  0.35,  // radius（收紧模糊半径）
  0.35   // threshold（更高，只让最亮的部分发光）
);
composer.addPass(bloomPass);


// ============================================================
// 11. 状态 / blend 控制
// ============================================================

let currentMode   = 'IDLE';
let targetBlend   = 0.0;
let smoothBlend   = 0.0;
let blendVelocity = 0.0;
const WAVE = 0.28;


// ============================================================
// 12. 动画主循环
// ============================================================

let time = 0;

function animate() {
  requestAnimationFrame(animate);
  time += 0.016;

  // 弹簧物理平滑 blend
  const springF = (targetBlend - smoothBlend) * 0.035;
  blendVelocity = blendVelocity * 0.82 + springF;
  smoothBlend   = Math.max(0, Math.min(1, smoothBlend + blendVelocity));

  const breathe     = breatheCurve(time);
  const spreadScale = 1 + breathe * 0.04;

  // ── Layer A：骨骼柱体（位置 + 大小 + 透明度）──────────────
  for (let i = 0; i < N_BONE; i++) {
    const lb = Math.max(0, Math.min(1,
      (smoothBlend - (1 - bT[i]) * WAVE) / (1 - WAVE)
    ));
    const bx = bCpX[i] + (bSpX[i] - bCpX[i]) * lb;
    const by = bCpY[i] + (bSpY[i] - bCpY[i]) * lb;

    // 两端渐隐（上下各 7% 范围内平滑淡出）
    const endFade = smoothstep(0.0, 0.07, bT[i]) * smoothstep(1.0, 0.93, bT[i]);

    spPositions[i*3]   = bx + bOffX[i] * spreadScale;
    spPositions[i*3+1] = by + bOffY[i] * spreadScale;
    spPositions[i*3+2] = bZ[i];

    // 轻微脉动（±6%）+ 呼吸调制 + 两端渐隐
    spSizes[i]  = bBaseS[i] * (1.0 + Math.sin(time * 1.57 + bPhase[i]) * 0.06);
    spAlphas[i] = bBaseA[i] * breathe * endFade;
  }

  // ── Layer B：椎节椭圆（仅 X 随 blend 变化）────────────────
  for (let j = 0; j < N_VERT; j++) {
    const gi = N_BONE + j;
    const lb = Math.max(0, Math.min(1,
      (smoothBlend - (1 - vST[j]) * WAVE) / (1 - WAVE)
    ));
    spPositions[gi*3] = vCurvedX[j] + vDeltaX[j] * lb;
    // 椎节也随呼吸轻微调整透明度（幅度更小，保持"实"的感觉）
    spAlphas[gi] = vBaseAlph[j] * (0.75 + breathe * 0.25);
  }

  spineGeo.attributes.position.needsUpdate = true;
  spineGeo.attributes.aSize.needsUpdate    = true;
  spineGeo.attributes.aAlpha.needsUpdate   = true;

  // 颜色同步
  const blendColor = getBlendColor(smoothBlend);
  spineMat.uniforms.uColor.value.copy(blendColor);
  diffuseMat.uniforms.uColor.value.copy(blendColor);

  // ── Layer C：弥散粒子流（弧线轨迹）────────────────────────
  for (let i = 0; i < N_DIFF; i++) {
    dAge[i]++;

    if (dAge[i] >= dMaxAge[i]) {
      resetDiffuse(i, smoothBlend);
    }

    const ratio   = dAge[i] / dMaxAge[i];
    const fadeIn  = smoothstep(0.0, 0.10, ratio);
    const fadeOut = 1.0 - smoothstep(0.85, 1.0, ratio);
    const alpha   = dBAlpha[i] * fadeIn * fadeOut;

    // 弧线运动：方向极慢旋转
    dAngle[i] += dCurveK[i] * 0.00045;
    dPx[i]    += Math.cos(dAngle[i]) * dSpeed[i];
    dPy[i]    += Math.sin(dAngle[i]) * dSpeed[i];

    dfPositions[i*3]   = dPx[i];
    dfPositions[i*3+1] = dPy[i];
    dfPositions[i*3+2] = 0.1;
    dfSizes[i]  = dBSize[i];
    dfAlphas[i] = alpha;
  }

  // ── Layer D：辉光线（跟随脊柱曲线，随 blend 变直）──────────
  for (let i = 0; i < N_GLOW; i++) {
    const gi = N_DIFF + i;
    const t0 = i / (N_GLOW - 1);
    const endFade = smoothstep(0, 0.08, t0) * smoothstep(1, 0.92, t0);

    dfPositions[gi*3]   = glowCurvedX[i] + (glowStraightX[i] - glowCurvedX[i]) * smoothBlend;
    dfPositions[gi*3+1] = glowY[i];
    dfPositions[gi*3+2] = -0.5;
    dfAlphas[gi] = (0.035 + breathe * 0.025) * endFade;
  }

  diffuseGeo.attributes.position.needsUpdate = true;
  diffuseGeo.attributes.aSize.needsUpdate    = true;
  diffuseGeo.attributes.aAlpha.needsUpdate   = true;

  // ── Layer E：环境星尘（圆形轨道）──────────────────────────
  const ap = ambGeo.attributes.position.array;
  for (let i = 0; i < N_AMB; i++) {
    ap[i*3]   = ambBase[i*3]   + Math.cos(time * ambOrbitSpd[i]       + ambOrbitPh[i]) * ambOrbitR[i];
    ap[i*3+1] = ambBase[i*3+1] + Math.sin(time * ambOrbitSpd[i] * 0.7 + ambOrbitPh[i]) * ambOrbitR[i];
  }
  ambGeo.attributes.position.needsUpdate = true;

  // Bloom 随呼吸调整（幅度收小，保持颗粒感）
  bloomPass.strength = 0.20 + breathe * 0.12 + smoothBlend * 0.10;

  if (debugBlend) debugBlend.textContent = smoothBlend.toFixed(3);

  composer.render();
}


// ============================================================
// 13. SocketIO（与 Flask 通信）
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
// 14. 调试面板
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
// 15. 键盘快捷键
// ============================================================

document.addEventListener('keydown', (e) => {
  if (e.key === 'd' || e.key === 'D') debugPanel.classList.toggle('hidden');
  if (e.key === 'f' || e.key === 'F') {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  }
});


// ============================================================
// 16. 窗口缩放
// ============================================================

window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
});

animate();
