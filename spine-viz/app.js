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

const N_BONE  = 80000;                 // Layer A（极致精细）
const N_VERT  = 39000;                 // Layer B (13 × 3000)
const N_SPINE = N_BONE + N_VERT;       // spineGeo 总量

const N_DIFF  = 6000;                  // Layer C（弥散粒子，减半提升帧率）
const N_GLOW  = 60;                    // Layer D
const N_DFULL = N_DIFF + N_GLOW;       // diffuseGeo 总量

const N_AMB   = 300;                   // Layer E


// ============================================================
// 3. 颜色（低饱和度，优雅克制）
// ============================================================

const COLOR_DARK = new THREE.Color(0x3a2d6e);  // 深蓝紫（压暗回来）
const COLOR_MID  = new THREE.Color(0x5c527a);  // 灰紫过渡
const COLOR_GOLD = new THREE.Color(0xc4a882);  // 灰金色

// 高光色（接近白色的高亮，强烈正面光感）
const HL_DARK = new THREE.Color(0xc0b0f0);   // 亮白紫
const HL_MID  = new THREE.Color(0xe0d0c0);   // 亮白金
const HL_GOLD = new THREE.Color(0xfff0d8);   // 近白暖光

// 对比色1：暖色系（高饱和）
const AC1_DARK = new THREE.Color(0xff6840);  // 鲜橘红
const AC1_MID  = new THREE.Color(0xf0a030);  // 鲜琥珀
const AC1_GOLD = new THREE.Color(0xff3090);  // 亮品红（在金色中极醒目）

// 对比色2：冷色系（高饱和）
const AC2_DARK = new THREE.Color(0x20e0c0);  // 鲜翡翠
const AC2_MID  = new THREE.Color(0x30d870);  // 鲜翠绿
const AC2_GOLD = new THREE.Color(0x2868ff);  // 亮宝蓝（金色的互补色）


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
  if (blend < 0.5) c.lerpColors(COLOR_DARK, COLOR_MID, blend * 2);
  else c.lerpColors(COLOR_MID, COLOR_GOLD, (blend - 0.5) * 2);
  return c;
}
function getHighlightColor(blend) {
  const c = new THREE.Color();
  if (blend < 0.5) c.lerpColors(HL_DARK, HL_MID, blend * 2);
  else c.lerpColors(HL_MID, HL_GOLD, (blend - 0.5) * 2);
  return c;
}
function getAccent1Color(blend) {
  const c = new THREE.Color();
  if (blend < 0.5) c.lerpColors(AC1_DARK, AC1_MID, blend * 2);
  else c.lerpColors(AC1_MID, AC1_GOLD, (blend - 0.5) * 2);
  return c;
}
function getAccent2Color(blend) {
  const c = new THREE.Color();
  if (blend < 0.5) c.lerpColors(AC2_DARK, AC2_MID, blend * 2);
  else c.lerpColors(AC2_MID, AC2_GOLD, (blend - 0.5) * 2);
  return c;
}


// ============================================================
// 5. 场景 / 摄像机 / 渲染器
// ============================================================

const canvas = document.getElementById('spine-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
// 不用色调映射（ACES会把暗色压太狠），用shader clamp防过曝即可

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05050d);

// 脊柱父容器：用于整体缓慢摆动，增加3D立体感
const spineGroup = new THREE.Group();
scene.add(spineGroup);

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
  uniform vec3 uColor;
  uniform vec3 uHighlight;
  uniform vec3 uAccent1;
  uniform vec3 uAccent2;
  varying float vAlpha;
  varying float vColorVar;
  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;
    // colorVar > 0: 高光，-0.5~0: 暖对比色，< -0.5: 冷对比色
    vec3 c;
    if (vColorVar > 0.0) {
      c = mix(uColor, uHighlight, clamp(vColorVar, 0.0, 1.0));
    } else if (vColorVar > -0.5) {
      c = mix(uColor, uAccent1, clamp(-vColorVar * 2.0, 0.0, 1.0));
    } else {
      c = mix(uColor, uAccent2, clamp((-vColorVar - 0.5) * 2.0, 0.0, 1.0));
    }
    c = clamp(c, 0.0, 0.88);
    float core  = exp(-d * d * 24.0);
    float halo  = exp(-d * d * 10.0) * 0.12;
    float alpha = (core + halo) * vAlpha;
    gl_FragColor = vec4(c, alpha);
  }
`;

const spineVertexShader = /* glsl */`
  attribute vec2 aCurvedPos;
  attribute vec2 aStraightPos;
  attribute vec2 aCurvedOff;
  attribute vec2 aStraightOff;
  attribute float aZPos;
  attribute float aParamT;
  attribute float aSize;
  attribute float aAlpha;
  attribute float aPhase;
  attribute float aColorVar;
  uniform float uBlend;
  uniform float uBreatheExpand;
  uniform float uBreathe;
  uniform float uTime;
  varying float vAlpha;
  varying float vColorVar;
  void main() {
    float lb = clamp((uBlend - (1.0 - aParamT) * 0.28) / 0.72, 0.0, 1.0);
    vec2 center = mix(aCurvedPos, aStraightPos, lb);
    vec2 off = mix(aCurvedOff, aStraightOff, lb);
    vec3 pos = vec3(center.x + off.x * uBreatheExpand, center.y + off.y, aZPos);
    float size = aSize * (1.0 + sin(uTime * 1.57 + aPhase) * 0.06);
    float alpha = aAlpha * (0.55 + uBreathe * 0.45);
    vAlpha = alpha;
    vColorVar = aColorVar;
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = size * (300.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
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

// 空心管参数（跟随 SPINE_SCALE 缩放）
const TUBE_OUTER   = 0.14 * SPINE_SCALE;
const TUBE_INNER   = 0.055 * SPINE_SCALE;
const TUBE_Y_SCALE = 1.0;              // Z深度=X深度，真正的圆形截面

// 管壁宽度沿脊柱变化（模拟真实椎体：颈椎窄→胸椎中→腰椎宽→骶椎收）
function tubeWidthAt(t) {
  // t=0(C7)→0.7, t~0.55(T11/L1)→1.3, t=0.8(L3/L4)→1.25, t=1(S1)→0.8
  const lumbarPeak = Math.exp(-Math.pow((t - 0.65) * 3.0, 2)) * 0.5;
  return 0.7 + lumbarPeak + t * 0.3;  // 基础从上到下渐宽 + 腰椎鼓起
}

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
    // 上端延伸：沿切线外推 + 柔和内收弯曲
    const rawExt = -bT[i];  // 0→TAPER_EXTEND
    const ext = rawExt * EXTEND_SCALE;
    const bend = rawExt * rawExt * 2.0;  // 二次曲线，越远越弯向中心
    cpx = curveTopPt.x - curveTopTan.x * ext + (0 - curveTopPt.x) * bend;
    cpy = curveTopPt.y - curveTopTan.y * ext;
    spx = 0;
    spy = straightTopY + ext;
  } else if (bT[i] > 1) {
    // 下端延伸：沿切线外推 + 柔和内收弯曲
    const rawExt = bT[i] - 1;  // 0→TAPER_EXTEND
    const ext = rawExt * EXTEND_SCALE;
    const bend = rawExt * rawExt * 2.0;
    cpx = curveBotPt.x + curveBotTan.x * ext + (0 - curveBotPt.x) * bend;
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

  // ── 椎间空腔：计算当前粒子距最近椎体中心的远近 ──
  // 13个椎体均匀分布在 t∈[0,1]，间距 = 1/12
  // 靠近椎体中心 → 粗亮，靠近两椎之间 → 细暗（椎间盘区域）
  const segPos = tClamped * 12;          // 0~12 连续值
  const distFromVert = Math.abs(segPos - Math.round(segPos));  // 0=椎体中心, 0.5=两椎之间
  // gapFactor: 1.0=椎体处（满宽满亮），~0.12=椎间盘处（窄暗但不完全空）
  const gapFactor = 0.12 + 0.88 * smoothstep(0.42, 0.18, distFromVert);
  // 椎体处管壁微微鼓出，椎间处收窄
  const gapWidth = 0.5 + 0.5 * gapFactor;  // 0.56~1.0

  const widthScale = tubeWidthAt(tClamped);
  const effectiveOuter = TUBE_OUTER * taperFactor * widthScale * gapWidth;
  const effectiveInner = TUBE_INNER * taperFactor * widthScale * gapWidth;

  // 25% 粒子填充管壁内部
  const isInterior = Math.random() < 0.25;

  // 左右两壁分布（保持中空感）+ 大角度范围（Z深度立体感）
  const sideSign = Math.random() < 0.5 ? 1 : -1;
  const angleMag = Math.random() * 1.35;   // 0~77°，比原来63°更宽，Z覆盖更深
  let r;
  if (isInterior) {
    r = Math.random() * effectiveInner;
  } else {
    r = effectiveInner + Math.pow(Math.random(), 0.5) * (effectiveOuter - effectiveInner);
  }
  const cosA = sideSign * Math.cos(angleMag) * r;
  bZ[i]      = Math.sin(angleMag) * r * TUBE_Y_SCALE;

  const ct         = curveCurved.getTangent(tClamped);
  bOffCurvedX[i]   = cosA * (-ct.y);
  bOffCurvedY[i]   = cosA * ct.x;
  bOffStraightX[i] = cosA;
  bOffStraightY[i] = 0;

  if (isInterior) {
    bBaseS[i] = (0.035 + Math.random() * 0.03) * Math.max(0.3, taperFactor) * gapFactor;
    bBaseA[i] = (0.10 + Math.random() * 0.07) * Math.max(0.3, taperFactor) * gapFactor;
  } else {
    const wallRatio = effectiveOuter > effectiveInner
      ? (r - effectiveInner) / (effectiveOuter - effectiveInner) : 0;
    bBaseS[i] = (0.04 + wallRatio * 0.03 + Math.random() * 0.02) * (0.6 + Math.random() * 0.7) * Math.max(0.2, taperFactor);
    bBaseA[i] = ((0.12 + wallRatio * 0.10) + Math.random() * 0.05) * taperFactor * gapFactor;
  }
  bPhase[i] = Math.random() * Math.PI * 2;

  // colorVar：Z靠前→高光(正值)，对比色粒子更大更亮才能突出
  const zDepth = Math.abs(bZ[i]) / Math.max(effectiveOuter * TUBE_Y_SCALE, 0.01);
  const acRoll = Math.random();
  if (acRoll < 0.10) {
    spColorVars[i] = -(0.25 + Math.random() * 0.25);   // 暖对比色
    bBaseA[i] *= 3.5;
  } else if (acRoll < 0.18) {
    spColorVars[i] = -(0.55 + Math.random() * 0.40);   // 冷对比色
    bBaseA[i] *= 3.5;
  } else if (acRoll < 0.28) {
    spColorVars[i] = 0.6 + Math.random() * 0.4;        // 强高光粒子
    bBaseA[i] *= 2.5;
  } else {
    spColorVars[i] = (1 - zDepth) * 0.4 + (Math.random() - 0.5) * 0.1;
  }
  spPositions[i*3]   = cpx + bOffCurvedX[i];
  spPositions[i*3+1] = cpy + bOffCurvedY[i];
  spPositions[i*3+2] = bZ[i];
  spSizes[i]  = bBaseS[i];
  spAlphas[i] = bBaseA[i];
}


// ── Layer B：椎节椭圆（3900粒子，宽扁，加粗强调）─────────────

const VERT_OUTER_BASE = 0.20 * SPINE_SCALE;  // 椎节外径基准
const VERT_INNER = 0.04 * SPINE_SCALE;       // 椎节内径

// 椎节大小随位置微调（腰椎稍大，但幅度克制避免毛刺）
function vertSizeAt(vi) {
  const t = vi / 12;
  const lumbarBump = Math.exp(-Math.pow((t - 0.65) * 3.5, 2)) * 0.15;
  return 1.0 + lumbarBump + t * 0.08;  // 1.0~1.2，很温和
}

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

  const vertScale = vertSizeAt(vi);
  const VERT_OUTER = VERT_OUTER_BASE * vertScale;

  for (let j = 0; j < 3000; j++) {
    const idx = vi * 800 + j;
    const vAngle = Math.random() * Math.PI * 2;
    // 85% 外壳（清晰轮廓），15% 内部填充（体积感）
    const isVertFill = Math.random() < 0.15;
    const vr = isVertFill
      ? Math.pow(Math.random(), 0.5) * VERT_OUTER
      : VERT_INNER + Math.random() * (VERT_OUTER - VERT_INNER);
    const cosA   = Math.cos(vAngle) * vr;
    const gz     = Math.sin(vAngle) * vr;
    // Y方向扩大分布范围，用 alpha 衰减制造上下渐变（立体感）
    const ySigma = 0.030 * SPINE_SCALE;
    const gy     = gaussRand() * ySigma;
    const yNorm  = Math.abs(gy) / ySigma;  // 归一化距离（0=中心，1~3=边缘）
    const yFalloff = Math.exp(-yNorm * yNorm * 1.2);  // 高斯衰减：中心亮、边缘暗

    // 弯曲态：截面垂直于曲线切线（与 Layer A 骨骼管一致）
    vOffCurvedX[idx]   = cosA * (-ct.y) + gy * ct.x;
    vOffCurvedY[idx]   = cosA * ct.x    + gy * ct.y;
    // 直立态：切线 = (0,-1,0)，垂直 = (1,0,0)
    vOffStraightX[idx] = cosA;
    vOffStraightY[idx] = gy;

    vCurvedX[idx] = cx;
    vDeltaX[idx]  = -cx;
    vGxOff[idx]   = cosA;
    vBaseY[idx]   = cy;
    vBaseZ[idx]   = gz;
    vST[idx]      = t;

    const wallRatio = VERT_OUTER > VERT_INNER
      ? Math.max(0, (vr - VERT_INNER) / (VERT_OUTER - VERT_INNER)) : 0;
    // 径向边缘柔化：越靠近外缘越暗，消除毛刺
    const radialNorm = vr / Math.max(VERT_OUTER, 0.001);
    const edgeSoft = 1.0 - smoothstep(0.7, 1.0, radialNorm);
    if (isVertFill) {
      vBaseSize[idx] = (0.04 + Math.random() * 0.03) * (0.7 + 0.3 * yFalloff);
      vBaseAlph[idx] = (0.10 + Math.random() * 0.07) * yFalloff * edgeSoft;
    } else {
      vBaseSize[idx] = (0.05 + wallRatio * 0.03) * (0.7 + Math.random() * 0.5) * (0.65 + 0.35 * yFalloff);
      vBaseAlph[idx] = ((0.18 + wallRatio * 0.10) + Math.random() * 0.04) * yFalloff * edgeSoft;
    }

    const gi = N_BONE + idx;
    spPositions[gi*3]   = cx + vOffCurvedX[idx];
    spPositions[gi*3+1] = cy + vOffCurvedY[idx];
    spPositions[gi*3+2] = gz;
    spSizes[gi]         = vBaseSize[idx];
    spAlphas[gi]        = vBaseAlph[idx];
    const vzDepth = Math.abs(gz) / Math.max(VERT_OUTER, 0.01);
    const vacRoll = Math.random();
    if (vacRoll < 0.10) {
      spColorVars[gi] = -(0.25 + Math.random() * 0.25);
      vBaseAlph[idx] *= 3.5;
    } else if (vacRoll < 0.18) {
      spColorVars[gi] = -(0.55 + Math.random() * 0.40);
      vBaseAlph[idx] *= 3.5;
    } else if (vacRoll < 0.28) {
      spColorVars[gi] = 0.6 + Math.random() * 0.4;
      vBaseAlph[idx] *= 2.5;
    } else {
      spColorVars[gi] = (1 - vzDepth) * 0.4 + (Math.random() - 0.5) * 0.12;
    }
  }
}

const spineGeo = new THREE.BufferGeometry();
spineGeo.setAttribute('position',  new THREE.BufferAttribute(spPositions, 3));
spineGeo.setAttribute('aSize',     new THREE.BufferAttribute(spSizes, 1));
spineGeo.setAttribute('aAlpha',    new THREE.BufferAttribute(spAlphas, 1));
spineGeo.setAttribute('aColorVar', new THREE.BufferAttribute(spColorVars, 1));

// ── GPU attribute packing (Layer A + Layer B into shared arrays) ──
const gpuCurvedPos   = new Float32Array(N_SPINE * 2);
const gpuStraightPos = new Float32Array(N_SPINE * 2);
const gpuCurvedOff   = new Float32Array(N_SPINE * 2);
const gpuStraightOff = new Float32Array(N_SPINE * 2);
const gpuZPos        = new Float32Array(N_SPINE);
const gpuParamT      = new Float32Array(N_SPINE);
const gpuPhase       = new Float32Array(N_SPINE);

// Pack Layer A (indices 0 .. N_BONE-1)
for (let i = 0; i < N_BONE; i++) {
  gpuCurvedPos[i * 2]     = bCpX[i];
  gpuCurvedPos[i * 2 + 1] = bCpY[i];
  gpuStraightPos[i * 2]     = bSpX[i];
  gpuStraightPos[i * 2 + 1] = bSpY[i];
  gpuCurvedOff[i * 2]     = bOffCurvedX[i];
  gpuCurvedOff[i * 2 + 1] = bOffCurvedY[i];
  gpuStraightOff[i * 2]     = bOffStraightX[i];
  gpuStraightOff[i * 2 + 1] = bOffStraightY[i];
  gpuZPos[i]   = bZ[i];
  gpuParamT[i] = bT[i];
  gpuPhase[i]  = bPhase[i];
}

// Pack Layer B (indices N_BONE .. N_SPINE-1)
for (let j = 0; j < N_VERT; j++) {
  const gi = N_BONE + j;
  gpuCurvedPos[gi * 2]     = vCurvedX[j];
  gpuCurvedPos[gi * 2 + 1] = vBaseY[j];
  gpuStraightPos[gi * 2]     = 0;           // straight spine X is always 0
  gpuStraightPos[gi * 2 + 1] = vBaseY[j];
  gpuCurvedOff[gi * 2]     = vOffCurvedX[j];
  gpuCurvedOff[gi * 2 + 1] = vOffCurvedY[j];
  gpuStraightOff[gi * 2]     = vOffStraightX[j];
  gpuStraightOff[gi * 2 + 1] = vOffStraightY[j];
  gpuZPos[gi]   = vBaseZ[j];
  gpuParamT[gi] = vST[j];
  gpuPhase[gi]  = 0.0;  // Layer B has no per-particle phase
}

spineGeo.setAttribute('aCurvedPos',   new THREE.BufferAttribute(gpuCurvedPos, 2));
spineGeo.setAttribute('aStraightPos', new THREE.BufferAttribute(gpuStraightPos, 2));
spineGeo.setAttribute('aCurvedOff',   new THREE.BufferAttribute(gpuCurvedOff, 2));
spineGeo.setAttribute('aStraightOff', new THREE.BufferAttribute(gpuStraightOff, 2));
spineGeo.setAttribute('aZPos',        new THREE.BufferAttribute(gpuZPos, 1));
spineGeo.setAttribute('aParamT',      new THREE.BufferAttribute(gpuParamT, 1));
spineGeo.setAttribute('aPhase',       new THREE.BufferAttribute(gpuPhase, 1));

const spineMat = new THREE.ShaderMaterial({
  vertexShader: spineVertexShader, fragmentShader,
  uniforms: {
    uColor:         { value: COLOR_DARK.clone() },
    uHighlight:     { value: HL_DARK.clone() },
    uAccent1:       { value: AC1_DARK.clone() },
    uAccent2:       { value: AC2_DARK.clone() },
    uBlend:         { value: 0.0 },
    uBreatheExpand: { value: 1.0 },
    uBreathe:       { value: 0.0 },
    uTime:          { value: 0.0 },
  },
  transparent: true,
  blending:    THREE.AdditiveBlending,
  depthWrite:  false,
});
const spinePoints = new THREE.Points(spineGeo, spineMat);
spinePoints.frustumCulled = false;
spineGroup.add(spinePoints);


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
  const vtX = spineX + side * (VERT_OUTER_BASE * 0.9 + 0.02);
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
  uniforms: {
    uColor:     { value: COLOR_DARK.clone() },
    uHighlight: { value: HL_DARK.clone() },
    uAccent1:   { value: AC1_DARK.clone() },
    uAccent2:   { value: AC2_DARK.clone() },
  },
  transparent: true,
  blending:    THREE.AdditiveBlending,
  depthWrite:  false,
});
spineGroup.add(new THREE.Points(diffuseGeo, diffuseMat));


// ============================================================
// 9. vineGeo (Layer F — 长藤蔓，沿脊柱全长蜿蜒缠绕)
// ============================================================

const N_VINES = 8;       // 8根长藤蔓
const VINE_PPV = 1500;   // 每根1500粒子（密实可见）
const N_VINE_TOTAL = N_VINES * VINE_PPV;

// 生成沿脊柱全长蜿蜒的藤蔓曲线
// 藤蔓跟随脊柱走向，左右摆动形成缠绕感
function makeLongVine(amplitude, freq, phase, zAmp) {
  const pts = [];
  const steps = 40;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const sp = curveCurved.getPoint(t);
    // 正弦波横向摆动 + 随机扰动 → 蜿蜒感
    const windX = Math.sin(t * Math.PI * freq + phase) * amplitude
                + Math.sin(t * Math.PI * freq * 2.3 + phase * 1.7) * amplitude * 0.3;
    const windY = Math.cos(t * Math.PI * freq * 0.6 + phase * 0.8) * amplitude * 0.15;
    const windZ = Math.sin(t * Math.PI * freq * 1.4 + phase * 2.1) * zAmp;
    pts.push(new THREE.Vector3(sp.x + windX, sp.y + windY, windZ));
  }
  return new THREE.CatmullRomCurve3(pts);
}

// 8根藤蔓：不同振幅/频率/相位，形成丰富的缠绕层次
const vineConfigs = [
  { amp: 0.28, freq: 3.0, phase: 0.0,  zAmp: 0.12 },   // 主藤1：宽幅慢摆
  { amp: 0.32, freq: 3.0, phase: 3.14, zAmp: 0.10 },   // 主藤2：与1对称
  { amp: 0.18, freq: 4.5, phase: 1.2,  zAmp: 0.08 },   // 细藤3：快摆
  { amp: 0.22, freq: 4.5, phase: 4.3,  zAmp: 0.09 },   // 细藤4：与3对称
  { amp: 0.38, freq: 2.0, phase: 0.8,  zAmp: 0.15 },   // 大藤5：最宽最慢
  { amp: 0.35, freq: 2.0, phase: 3.9,  zAmp: 0.14 },   // 大藤6：与5对称
  { amp: 0.14, freq: 6.0, phase: 2.5,  zAmp: 0.06 },   // 丝藤7：贴近脊柱快摆
  { amp: 0.16, freq: 5.5, phase: 5.2,  zAmp: 0.07 },   // 丝藤8：与7对称
];

const vineCurves = vineConfigs.map(c => makeLongVine(c.amp, c.freq, c.phase, c.zAmp));

// 粒子分布
const vnPositions = new Float32Array(N_VINE_TOTAL * 3);
const vnVineT     = new Float32Array(N_VINE_TOTAL);
const vnPhase     = new Float32Array(N_VINE_TOTAL);
const vnSizes     = new Float32Array(N_VINE_TOTAL);
const vnAlphas    = new Float32Array(N_VINE_TOTAL);
const vnColorVars = new Float32Array(N_VINE_TOTAL);

for (let v = 0; v < N_VINES; v++) {
  const curve = vineCurves[v];
  const pulsePhase = v * 0.4 + Math.random() * 0.5;  // 每根不同的脉冲相位
  const cfg = vineConfigs[v];
  // 粗藤vs细藤的粒子宽度
  const baseWidth = cfg.amp > 0.25 ? 0.025 : 0.018;

  for (let p = 0; p < VINE_PPV; p++) {
    const idx = v * VINE_PPV + p;
    const t = p / (VINE_PPV - 1);

    const pt = curve.getPoint(t);
    const tan = curve.getTangent(t);

    // 高斯展宽（藤蔓粗细）
    const spread = gaussRand() * baseWidth;
    const perpX = -tan.y, perpY = tan.x;

    vnPositions[idx * 3]     = pt.x + perpX * spread;
    vnPositions[idx * 3 + 1] = pt.y + perpY * spread;
    vnPositions[idx * 3 + 2] = pt.z + (Math.random() - 0.5) * 0.02;

    vnVineT[idx]   = t;
    vnPhase[idx]   = pulsePhase;
    vnSizes[idx]   = 0.025 + Math.random() * 0.015;
    vnAlphas[idx]  = 0.22 + Math.random() * 0.15;

    // 颜色分配
    const cRoll = Math.random();
    if (cRoll < 0.08)      vnColorVars[idx] = -(0.25 + Math.random() * 0.25);  // 暖对比
    else if (cRoll < 0.15) vnColorVars[idx] = -(0.55 + Math.random() * 0.4);   // 冷对比
    else if (cRoll < 0.35) vnColorVars[idx] = 0.4 + Math.random() * 0.5;       // 高光
    else vnColorVars[idx] = (Math.random() - 0.5) * 0.15;
  }
}

const vineGeo = new THREE.BufferGeometry();
vineGeo.setAttribute('position',   new THREE.BufferAttribute(vnPositions, 3));
vineGeo.setAttribute('aSize',      new THREE.BufferAttribute(vnSizes, 1));
vineGeo.setAttribute('aAlpha',     new THREE.BufferAttribute(vnAlphas, 1));
vineGeo.setAttribute('aColorVar',  new THREE.BufferAttribute(vnColorVars, 1));
vineGeo.setAttribute('aVineT',     new THREE.BufferAttribute(vnVineT, 1));
vineGeo.setAttribute('aVinePhase', new THREE.BufferAttribute(vnPhase, 1));

// 藤蔓 vertex shader：生长 + 能量脉冲流动
const vineVertexShader = /* glsl */`
  attribute float aSize;
  attribute float aAlpha;
  attribute float aColorVar;
  attribute float aVineT;
  attribute float aVinePhase;

  uniform float uBlend;
  uniform float uTime;

  varying float vAlpha;
  varying float vColorVar;

  void main() {
    // 生长：blend 0.15→0.7 时藤蔓从上端到下端逐渐显现
    float growth = clamp((uBlend - 0.15) / 0.55, 0.0, 1.0);
    float visible = smoothstep(growth + 0.02, growth - 0.10, aVineT);

    // 能量脉冲：高斯光团从上往下流动
    float pulseSpeed = 0.10;
    float pulsePos = mod(uTime * pulseSpeed + aVinePhase, 1.5) - 0.2;
    float pulse = exp(-pow((aVineT - pulsePos) * 8.0, 2.0));

    // 两端渐隐（藤蔓头尾自然消失）
    float endFade = smoothstep(0.0, 0.05, aVineT) * smoothstep(1.0, 0.92, aVineT);

    float alpha = aAlpha * visible * endFade * (0.3 + pulse * 0.7);
    float sz    = aSize * (0.8 + pulse * 0.5);

    vAlpha    = alpha;
    vColorVar = aColorVar + pulse * 0.3;

    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = sz * (300.0 / -mv.z);
    gl_Position  = projectionMatrix * mv;
  }
`;

const vineMat = new THREE.ShaderMaterial({
  vertexShader: vineVertexShader, fragmentShader,
  uniforms: {
    uColor:     { value: COLOR_DARK.clone() },
    uHighlight: { value: HL_DARK.clone() },
    uAccent1:   { value: AC1_DARK.clone() },
    uAccent2:   { value: AC2_DARK.clone() },
    uBlend:     { value: 0.0 },
    uTime:      { value: 0.0 },
  },
  transparent: true,
  blending:    THREE.AdditiveBlending,
  depthWrite:  false,
});
const vinePoints = new THREE.Points(vineGeo, vineMat);
vinePoints.frustumCulled = false;
spineGroup.add(vinePoints);


// ============================================================
// 10. ambGeo (Layer E)
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
  uniforms: {
    uColor:     { value: new THREE.Color(0x18102e) },
    uHighlight: { value: new THREE.Color(0x18102e) },
    uAccent1:   { value: new THREE.Color(0x18102e) },
    uAccent2:   { value: new THREE.Color(0x18102e) },
  },
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
let fpsFrames = 0, fpsLast = performance.now();
const debugFps = document.getElementById('debug-fps');

function animate() {
  requestAnimationFrame(animate);
  time += 0.016;

  // FPS 计算（每秒更新一次）
  fpsFrames++;
  const now = performance.now();
  if (now - fpsLast >= 1000) {
    if (debugFps) debugFps.textContent = fpsFrames;
    fpsFrames = 0;
    fpsLast = now;
  }

  // 弹簧物理平滑 blend
  const springF = (targetBlend - smoothBlend) * 0.035;
  blendVelocity = blendVelocity * 0.82 + springF;
  smoothBlend   = Math.max(0, Math.min(1, smoothBlend + blendVelocity));

  const breathe       = breatheCurve(time);
  const breatheExpand = 1 + breathe * 0.20;   // 横向呼吸扩张 ±20%

  // 脊柱缓慢摆动 ±20°，12秒一个周期
  spineGroup.rotation.y = Math.sin(time * 0.52) * 0.35;

  // ── Layer A + B：GPU-driven (uniforms only) ──────────────
  spineMat.uniforms.uBlend.value         = smoothBlend;
  spineMat.uniforms.uBreatheExpand.value = breatheExpand;
  spineMat.uniforms.uBreathe.value       = breathe;
  spineMat.uniforms.uTime.value          = time;

  // 颜色同步（基色 + 高光 + 两种对比色 都跟随 blend）
  const blendColor = getBlendColor(smoothBlend);
  const hlColor    = getHighlightColor(smoothBlend);
  const ac1Color   = getAccent1Color(smoothBlend);
  const ac2Color   = getAccent2Color(smoothBlend);
  spineMat.uniforms.uColor.value.copy(blendColor);
  spineMat.uniforms.uHighlight.value.copy(hlColor);
  spineMat.uniforms.uAccent1.value.copy(ac1Color);
  spineMat.uniforms.uAccent2.value.copy(ac2Color);
  diffuseMat.uniforms.uColor.value.copy(blendColor);
  diffuseMat.uniforms.uHighlight.value.copy(hlColor);
  diffuseMat.uniforms.uAccent1.value.copy(ac1Color);
  diffuseMat.uniforms.uAccent2.value.copy(ac2Color);
  // 藤蔓颜色 + 动画
  vineMat.uniforms.uColor.value.copy(blendColor);
  vineMat.uniforms.uHighlight.value.copy(hlColor);
  vineMat.uniforms.uAccent1.value.copy(ac1Color);
  vineMat.uniforms.uAccent2.value.copy(ac2Color);
  vineMat.uniforms.uBlend.value = smoothBlend;
  vineMat.uniforms.uTime.value  = time;

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
