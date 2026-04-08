/**
 * raina-project — Three.js 粒子脊柱主程序 v6
 * =============================================
 * 五层架构：
 *   Layer A  骨骼柱体（20000，空心管，呼吸横向扩张）
 *   Layer B  椎节椭圆（13×800=10400，宽扁，呼吸完整调制+扩张）
 *   Layer C  弥散粒子流（12000，有机流动，全屏弥散）
 *   Layer D  脊柱辉光线（60个大粒子，跟随曲线弯曲）
 *   Layer E  环境星尘（300，圆形轨道）
 *
 * v6 修复：
 *   1. 椎节对齐到曲线切线方向（与骨骼管一致）
 *   2. 弥散粒子流随机角度/曲率/速度，打破规律性
 *   3. 弥散粒子终点覆盖全屏
 *   4. ACESFilmic ToneMapping + 限制 bloom，消除过曝
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass }     from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass }     from 'three/examples/jsm/postprocessing/OutputPass.js';
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

const N_BONE  = 20000;                 // Layer A
const N_VERT  = 10400;                 // Layer B (13 × 800)
const N_SPINE = N_BONE + N_VERT;       // spineGeo 总量

const N_DIFF  = 12000;                 // Layer C（弥散粒子，3倍数量）
const N_GLOW  = 60;                    // Layer D
const N_DFULL = N_DIFF + N_GLOW;       // diffuseGeo 总量

const N_AMB   = 300;                   // Layer E


// ============================================================
// 3. 颜色（低饱和度，优雅克制）
// ============================================================

const COLOR_DARK = new THREE.Color(0x2a2545);  // 降饱和但保持可见度
const COLOR_MID  = new THREE.Color(0x4d4568);  // 低饱和度灰紫，偏亮
const COLOR_GOLD = new THREE.Color(0xc4a882);  // 低饱和度高级灰金色


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

/** 统一呼吸曲线：2s亮起 → 2s保持 → 2s暗下 → 2s保持（8s周期） */
function breatheCurve(t) {
  const phase = (t % 8.0) / 8.0;
  if (phase < 0.25) return smoothstep(0, 1, phase / 0.25);       // 0→1: 2s 慢慢变亮
  if (phase < 0.50) return 1.0;                                    // 保持亮: 2s
  if (phase < 0.75) return smoothstep(1, 0, (phase - 0.50) / 0.25); // 1→0: 2s 慢慢变暗
  return 0.0;                                                      // 保持暗: 2s
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
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.85;

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
    c = clamp(c, 0.0, 0.82);  // 限制单粒子最大亮度，防叠加过曝
    // 收紧核心，削弱光晕 — 保持粒子颗粒感
    float core  = exp(-d * d * 24.0);
    float halo  = exp(-d * d * 10.0) * 0.12;
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

const bCpX          = new Float32Array(N_BONE);
const bCpY          = new Float32Array(N_BONE);
const bSpX          = new Float32Array(N_BONE);
const bSpY          = new Float32Array(N_BONE);
const bT            = new Float32Array(N_BONE);
const bOffCurvedX   = new Float32Array(N_BONE);  // 弯曲状态截面偏移（切线旋转）
const bOffCurvedY   = new Float32Array(N_BONE);
const bOffStraightX = new Float32Array(N_BONE);  // 直立状态截面偏移
const bOffStraightY = new Float32Array(N_BONE);
const bZ            = new Float32Array(N_BONE);
const bBaseS = new Float32Array(N_BONE);   // base size
const bBaseA = new Float32Array(N_BONE);   // base alpha
const bPhase = new Float32Array(N_BONE);

// 预计算端点位置和切线，用于上下延伸渐隐（taper）
const TAPER_EXTEND = 0.12;  // 两端各延伸 12%
const EXTEND_SCALE = 5.0 * SPINE_SCALE;  // t到世界坐标的近似缩放
const curveTopPt  = curveCurved.getPoint(0);
const curveBotPt  = curveCurved.getPoint(1);
const curveTopTan = curveCurved.getTangent(0);
const curveBotTan = curveCurved.getTangent(1);
const straightTopY = curveStraight.getPoint(0).y;
const straightBotY = curveStraight.getPoint(1).y;

for (let i = 0; i < N_BONE; i++) {
  // 扩展范围：[-TAPER, 1+TAPER]，两端渐隐延伸
  bT[i] = -TAPER_EXTEND + Math.random() * (1 + 2 * TAPER_EXTEND);

  let cpx, cpy, spx, spy;
  const tClamped = Math.max(0, Math.min(1, bT[i]));

  if (bT[i] < 0) {
    // 上端延伸：沿切线反方向外推
    const ext = -bT[i] * EXTEND_SCALE;
    cpx = curveTopPt.x - curveTopTan.x * ext;
    cpy = curveTopPt.y - curveTopTan.y * ext;
    spx = 0;
    spy = straightTopY + ext;
  } else if (bT[i] > 1) {
    // 下端延伸：沿切线正方向外推
    const ext = (bT[i] - 1) * EXTEND_SCALE;
    cpx = curveBotPt.x + curveBotTan.x * ext;
    cpy = curveBotPt.y + curveBotTan.y * ext;
    spx = 0;
    spy = straightBotY - ext;
  } else {
    const cp = curveCurved.getPoint(bT[i]);
    const sp = curveStraight.getPoint(bT[i]);
    cpx = cp.x; cpy = cp.y;
    spx = sp.x; spy = sp.y;
  }

  bCpX[i] = cpx;  bCpY[i] = cpy;
  bSpX[i] = spx;  bSpY[i] = spy;

  // 渐隐因子：越靠近延伸末端越窄越淡
  let taperFactor = 1.0;
  if (bT[i] < 0) {
    taperFactor = Math.pow(Math.max(0, 1 + bT[i] / TAPER_EXTEND), 1.5);
  } else if (bT[i] > 1) {
    taperFactor = Math.pow(Math.max(0, 1 - (bT[i] - 1) / TAPER_EXTEND), 1.5);
  }

  // 20% 粒子填充管壁内部
  const isInterior = Math.random() < 0.20;

  const sideSign = Math.random() < 0.5 ? 1 : -1;
  const angleMag = Math.random() * 1.1;
  const effectiveOuter = TUBE_OUTER * taperFactor;
  const effectiveInner = TUBE_INNER * taperFactor;
  let r;
  if (isInterior) {
    r = Math.random() * effectiveInner;  // 管壁内侧
  } else {
    r = effectiveInner + Math.pow(Math.random(), 0.5) * (effectiveOuter - effectiveInner);
  }
  const cosA = sideSign * Math.cos(angleMag) * r;
  bZ[i]      = Math.sin(angleMag) * r * TUBE_Y_SCALE;

  // 弯曲态切线（在延伸区用端点切线）
  const ct         = curveCurved.getTangent(tClamped);
  bOffCurvedX[i]   = cosA * (-ct.y);
  bOffCurvedY[i]   = cosA * ct.x;
  bOffStraightX[i] = cosA;
  bOffStraightY[i] = 0;

  if (isInterior) {
    // 内部填充粒子：稍小稍暗，但要看得见
    bBaseS[i] = (0.07 + Math.random() * 0.08) * Math.max(0.3, taperFactor);
    bBaseA[i] = (0.09 + Math.random() * 0.08) * Math.max(0.2, taperFactor);
  } else {
    const wallRatio = effectiveOuter > effectiveInner
      ? (r - effectiveInner) / (effectiveOuter - effectiveInner) : 0;
    bBaseS[i] = (0.11 + wallRatio * 0.07) * (0.6 + Math.random() * 0.8) * Math.max(0.2, taperFactor);
    bBaseA[i] = ((0.16 + wallRatio * 0.12) + Math.random() * 0.05) * taperFactor;
  }
  bPhase[i] = Math.random() * Math.PI * 2;

  spColorVars[i] = (Math.random() - 0.5) * 0.25;
  spPositions[i*3]   = cpx + bOffCurvedX[i];
  spPositions[i*3+1] = cpy + bOffCurvedY[i];
  spPositions[i*3+2] = bZ[i];
}


// ── Layer B：椎节椭圆（3900粒子，宽扁，加粗强调）─────────────

const VERT_OUTER = 0.15 * SPINE_SCALE;  // 椎节外径（略大于骨骼管，关节鼓出感）
const VERT_INNER = 0.04 * SPINE_SCALE;  // 椎节内径

const vCurvedX  = new Float32Array(N_VERT);
const vDeltaX   = new Float32Array(N_VERT);  // straightX - curvedX = -cx
const vGxOff    = new Float32Array(N_VERT);  // 每粒子横向高斯偏移（呼吸扩张用）
const vBaseY    = new Float32Array(N_VERT);
const vBaseZ    = new Float32Array(N_VERT);
const vST       = new Float32Array(N_VERT);
const vBaseSize = new Float32Array(N_VERT);
const vBaseAlph = new Float32Array(N_VERT);

// 预计算每个椎节在曲线上的切线（用于椎节盘对齐）
const vertTangentsCurved = [];
const vertTangentsStraight = [];
for (let vi = 0; vi < 13; vi++) {
  const t = vi / 12;
  vertTangentsCurved.push(curveCurved.getTangent(t));
  vertTangentsStraight.push(new THREE.Vector3(0, -1, 0)); // 直立时切线竖直
}

// 额外存储：椎节粒子的切线方向偏移（弯曲/直立两态）
const vOffCurvedX   = new Float32Array(N_VERT);
const vOffCurvedY   = new Float32Array(N_VERT);
const vOffStraightX = new Float32Array(N_VERT);
const vOffStraightY = new Float32Array(N_VERT);

for (let vi = 0; vi < 13; vi++) {
  const cx = SPINE_CURVED[vi].x;
  const cy = SPINE_CURVED[vi].y;
  const t  = vi / 12;
  const ct = vertTangentsCurved[vi];  // 弯曲态切线

  for (let j = 0; j < 800; j++) {
    const idx = vi * 800 + j;
    // 环形分布：粒子在垂直于切线的平面上形成圆盘
    const vAngle = Math.random() * Math.PI * 2;
    const vr     = VERT_INNER + Math.random() * (VERT_OUTER - VERT_INNER);
    const cosA   = Math.cos(vAngle) * vr;  // 截面内"水平"分量
    const gz     = Math.sin(vAngle) * vr;  // 截面内"深度"分量
    const gy     = gaussRand() * 0.012 * SPINE_SCALE;  // 沿切线方向的薄厚度

    // 弯曲态：截面垂直于曲线切线（与 Layer A 骨骼管一致）
    vOffCurvedX[idx]   = cosA * (-ct.y) + gy * ct.x;
    vOffCurvedY[idx]   = cosA * ct.x    + gy * ct.y;
    // 直立态：切线 = (0,-1,0)，垂直 = (1,0,0)
    vOffStraightX[idx] = cosA;
    vOffStraightY[idx] = gy;

    vCurvedX[idx] = cx;  // 存椎节中心 x（不含偏移）
    vDeltaX[idx]  = -cx;
    vGxOff[idx]   = cosA;  // 存截面偏移量（用于呼吸扩张）
    vBaseY[idx]   = cy;
    vBaseZ[idx]   = gz;
    vST[idx]      = t;

    // 外缘更亮，强化关节轮廓
    const wallRatio = (vr - VERT_INNER) / (VERT_OUTER - VERT_INNER);
    vBaseSize[idx] = (0.16 + wallRatio * 0.12) * (0.7 + Math.random() * 0.6);
    vBaseAlph[idx] = (0.22 + wallRatio * 0.14) + Math.random() * 0.06;

    const gi = N_BONE + idx;
    spPositions[gi*3]   = cx + vOffCurvedX[idx];
    spPositions[gi*3+1] = cy + vOffCurvedY[idx];
    spPositions[gi*3+2] = gz;
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


// ── Layer C：贝塞尔弧线粒子流（12000粒子）───────────────────

const dPx   = new Float32Array(N_DIFF);  // P0 出生点 X（贝塞尔起点，不再更新）
const dPy   = new Float32Array(N_DIFF);  // P0 出生点 Y
const dBzX1 = new Float32Array(N_DIFF);  // 贝塞尔控制点1
const dBzY1 = new Float32Array(N_DIFF);
const dBzX2 = new Float32Array(N_DIFF);  // 贝塞尔控制点2
const dBzY2 = new Float32Array(N_DIFF);
const dBzX3 = new Float32Array(N_DIFF);  // 贝塞尔终点
const dBzY3 = new Float32Array(N_DIFF);
const dT    = new Float32Array(N_DIFF);  // 当前 t ∈ [0,1]
const dDt   = new Float32Array(N_DIFF);  // 每帧步进
const dVi   = new Uint8Array(N_DIFF);
const dSide = new Int8Array(N_DIFF);
const dBSize  = new Float32Array(N_DIFF);
const dBAlpha = new Float32Array(N_DIFF);
const flowAngle = new Float32Array(13);  // 每椎节流向偏角（缓慢上下摆动）

function resetDiffuse(i, blend) {
  const vi   = Math.floor(Math.random() * 13);
  const side = Math.random() < 0.5 ? 1 : -1;
  dVi[i] = vi;  dSide[i] = side;

  // P0：出生在椎节外侧（沿曲线位置）
  const spineX = SPINE_CURVED[vi].x * (1 - blend);
  const vtX = spineX + side * (VERT_OUTER * 0.9 + 0.02);
  const vtY = SPINE_CURVED[vi].y + (Math.random() - 0.5) * 0.06;
  dPx[i] = vtX;
  dPy[i] = vtY;

  // 每个粒子独立随机流向角度（-70度 ~ +70度，不限上下）
  const flowAngle = (Math.random() - 0.5) * 2.4;  // ±~70度弧度
  const cosF = Math.cos(flowAngle);
  const sinF = Math.sin(flowAngle);

  // 总伸展距离：随机长短，覆盖到屏幕边缘（camera z=5, FOV=60 → ~±2.9）
  const reach = 0.8 + Math.random() * 2.4;   // 0.8 ~ 3.2 单位（最远可到屏幕边缘）

  // 中途弯曲程度：随机曲率
  const curvature = (Math.random() - 0.5) * 1.2;  // 上弯或下弯

  // 沿（side方向 + 角度偏转）构建贝塞尔控制点
  const dx1 = side * reach * 0.33;
  const dy1 = sinF * reach * 0.33 + curvature * 0.15;
  const dx2 = side * reach * 0.66;
  const dy2 = sinF * reach * 0.66 + curvature * 0.3;
  const dx3 = side * reach;
  const dy3 = sinF * reach + curvature * 0.15;

  // 每个控制点加小扰动防止完全重叠
  const n = () => (Math.random() - 0.5) * 0.12;
  dBzX1[i] = vtX + dx1 + n();   dBzY1[i] = vtY + dy1 + n();
  dBzX2[i] = vtX + dx2 + n();   dBzY2[i] = vtY + dy2 + n();
  dBzX3[i] = vtX + dx3 + n();   dBzY3[i] = vtY + dy3 + n();

  dT[i]  = 0;
  // 速度也随机化更大范围：短的快，长的慢
  dDt[i] = (0.0008 + Math.random() * 0.0014) * (2.0 / (0.8 + reach));

  const sz = Math.random();
  dBSize[i]  = 0.04 + sz * sz * 0.09;
  // 远距离粒子更透明
  dBAlpha[i] = (0.10 + Math.random() * 0.14) * (1.0 - reach * 0.12);
  dfColorVars[i] = (Math.random() - 0.5) * 0.25;
}

// 初始化：随机 t 起点，贝塞尔求值无需估算
for (let i = 0; i < N_DIFF; i++) {
  resetDiffuse(i, 0);
  dT[i] = Math.random();
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
  0.15,  // strength（克制，防过曝）
  0.15,  // radius（收紧光晕）
  0.45   // threshold（提高门槛，只让亮核心发光）
);
composer.addPass(bloomPass);

// OutputPass 应用 tone mapping 到最终画面，防止 AdditiveBlending 过曝
composer.addPass(new OutputPass());


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

  const breathe       = breatheCurve(time);
  const breatheExpand = 1 + breathe * 0.10;   // 横向呼吸扩张 ±10%

  // ── Layer A：骨骼柱体（位置 + 大小 + 透明度）──────────────
  for (let i = 0; i < N_BONE; i++) {
    const lb = Math.max(0, Math.min(1,
      (smoothBlend - (1 - bT[i]) * WAVE) / (1 - WAVE)
    ));
    const bx = bCpX[i] + (bSpX[i] - bCpX[i]) * lb;
    const by = bCpY[i] + (bSpY[i] - bCpY[i]) * lb;

    // 两端渐隐：延伸区 taperFactor 已内置于 bBaseA，这里不再额外压暗
    const endFade = 1.0;

    // 在弯曲/直立之间插值截面偏移（切线跟随，解决脱节）
    const offX = bOffCurvedX[i] * (1 - lb) + bOffStraightX[i] * lb;
    const offY = bOffCurvedY[i] * (1 - lb) + bOffStraightY[i] * lb;
    spPositions[i*3]   = bx + offX * breatheExpand;
    spPositions[i*3+1] = by + offY;
    spPositions[i*3+2] = bZ[i];

    // 整体呼吸：统一缓亮缓暗 + 两端渐隐
    spSizes[i]  = bBaseS[i] * (1.0 + Math.sin(time * 1.57 + bPhase[i]) * 0.06);
    spAlphas[i] = bBaseA[i] * (0.35 + breathe * 0.65) * endFade;  // 呼吸幅度大但不完全熄灭
  }

  // ── Layer B：椎节椭圆（切线对齐，随 blend 插值 + 呼吸扩张）────
  for (let j = 0; j < N_VERT; j++) {
    const gi = N_BONE + j;
    const lb = Math.max(0, Math.min(1,
      (smoothBlend - (1 - vST[j]) * WAVE) / (1 - WAVE)
    ));
    // 椎节中心：从弯曲位置插值到直立位置
    const centerX = vCurvedX[j] + vDeltaX[j] * lb;
    const centerY = vBaseY[j];
    // 截面偏移：在弯曲态和直立态之间插值（与 Layer A 一致的切线对齐方式）
    const offX = vOffCurvedX[j] * (1 - lb) + vOffStraightX[j] * lb;
    const offY = vOffCurvedY[j] * (1 - lb) + vOffStraightY[j] * lb;
    spPositions[gi*3]   = centerX + offX * breatheExpand;
    spPositions[gi*3+1] = centerY + offY;
    spAlphas[gi] = vBaseAlph[j] * (0.25 + breathe * 0.75);
  }

  spineGeo.attributes.position.needsUpdate = true;
  spineGeo.attributes.aSize.needsUpdate    = true;
  spineGeo.attributes.aAlpha.needsUpdate   = true;

  // 颜色同步
  const blendColor = getBlendColor(smoothBlend);
  spineMat.uniforms.uColor.value.copy(blendColor);
  diffuseMat.uniforms.uColor.value.copy(blendColor);

  // ── Layer C：贝塞尔弧线粒子流────────────────────────────────
  for (let i = 0; i < N_DIFF; i++) {
    dT[i] += dDt[i];
    if (dT[i] >= 1.0) {
      resetDiffuse(i, smoothBlend);
    }

    const t  = dT[i];
    const u  = 1 - t;
    const u2 = u * u, u3 = u2 * u;
    const t2 = t * t, t3 = t2 * t;

    const x = u3*dPx[i] + 3*u2*t*dBzX1[i] + 3*u*t2*dBzX2[i] + t3*dBzX3[i];
    const y = u3*dPy[i] + 3*u2*t*dBzY1[i] + 3*u*t2*dBzY2[i] + t3*dBzY3[i];

    const fadeIn  = smoothstep(0.0, 0.08, t);
    const fadeOut = 1.0 - smoothstep(0.85, 1.0, t);

    dfPositions[i*3]   = x;
    dfPositions[i*3+1] = y;
    dfPositions[i*3+2] = 0.1;
    dfSizes[i]  = dBSize[i];
    dfAlphas[i] = dBAlpha[i] * fadeIn * fadeOut;
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

  // Bloom 随呼吸调整（blend 高时反而收敛，防过曝）
  bloomPass.strength = 0.12 + breathe * 0.06 - smoothBlend * 0.03;

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
  targetBlend = blendSlider.value / 100;   // 本地直接生效，无需 Flask
  socket.emit('set_blend', { value: targetBlend });
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
