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

const N_DIFF  = 0;                     // Layer C（暂时关闭弥散粒子）
const N_GLOW  = 0;                     // Layer D（暂时关闭辉光线）
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
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));  // 降低像素密度提升帧率
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
// 9. vineGeo (Layer F — 藤蔓系统，精确复刻参考图走势)
// ============================================================
//
// 参考图走势分析：
//   2条主藤蔓并行蜿蜒，像两股绳子拧在一起，沿相同方向绕脊柱：
//     顶部→左侧 → 摆到右侧 → 摆回左侧 → 摆回右侧 → 底部收回
//     约2个完整正弦周期，两根主藤微小相位差形成绳索感
//   1条细藤蔓，更贴近脊柱，频率略高
//   叶片从藤蔓远离脊柱最远处向外展开
//

const N_VINES = 3;
const VINE_PPV = 7000;     // 每根7000粒子，细腻质感
// 分支藤蔓（从SVG提取的40段路径）
const BRANCH_PPB = 300;   // 每段分支300粒子
const SVG_BRANCH_PATHS = [
[[0.2991,2.124],[0.2632,1.9561],[0.1748,1.8077]],
[[-0.1511,1.5776],[-0.1601,1.494],[-0.1606,1.4095],[-0.1245,1.3343]],
[[0.0019,1.0574],[0.0512,1.0794],[0.0721,1.1275],[0.1152,1.1029]],
[[-0.2473,0.747],[-0.2602,0.8115],[-0.2941,0.9444],[-0.2738,0.8117],[-0.2732,0.6707],[-0.2851,0.6138],[-0.2844,0.4743],[-0.241,0.4486],[-0.254,0.5869],[-0.2211,0.7237],[-0.1633,0.8523],[-0.0629,0.9427],[-0.0928,0.9522],[-0.0243,1.0054],[-0.1126,0.9732],[-0.1961,0.8596],[-0.2375,0.7612],[-0.1572,0.8775],[-0.1205,0.9306]],
[[0.0019,0.9831],[0.0311,0.9829],[0.0274,0.9709],[0.0001,0.9638]],
[[0.0019,-0.1578],[0.0706,-0.0639],[0.0606,-0.0049],[0.0887,-0.1157]],
[[0.0019,-0.2103],[0.1425,-0.1589],[0.2548,-0.0837],[0.2205,-0.1487],[0.3615,-0.0986]],
[[0.3734,-0.0835],[0.3966,-0.0813],[0.4152,-0.0888],[0.4383,-0.0917]],
[[0.4608,-0.0791],[0.532,-0.0841],[0.6066,-0.0966],[0.5752,-0.0859]],
[[-0.3872,-1.1151],[-0.3847,-0.9729],[-0.3509,-0.8366],[-0.3051,-0.7037],[-0.2762,-0.5645],[-0.1842,-0.481],[-0.163,-0.4377],[-0.104,-0.3141]],
[[0.2117,-0.984],[0.2264,-1.1009],[0.2722,-1.2277],[0.306,-1.3664]],
[[-0.3872,-1.1151],[-0.3849,-1.0908],[-0.3809,-1.111],[-0.3791,-1.1347]],
[[-0.3916,-1.1413],[-0.4385,-1.2326],[-0.4128,-1.272],[-0.4328,-1.3058]],
[[0.2554,-1.3337],[0.2558,-1.3699],[0.2524,-1.4063],[0.2472,-1.4407]],
[[-0.2298,-1.7402],[-0.2382,-1.832],[-0.2522,-1.9982],[-0.2087,-2.134],[-0.1528,-2.247],[-0.0374,-2.3389],[-0.1459,-2.2116],[-0.0998,-2.0818],[-0.0277,-2.0037],[-0.1693,-2.0928],[-0.2227,-1.9799],[-0.1671,-1.824],[-0.0448,-1.7114],[-0.1083,-1.7104],[-0.2151,-1.8199],[-0.1676,-1.6591],[-0.0958,-1.5072],[-0.0243,-1.3555],[-0.0773,-1.4255],[-0.1263,-1.4933],[-0.0972,-1.3539],[-0.1513,-1.5128],[-0.2113,-1.6697],[-0.1887,-1.6543],[-0.1533,-1.574],[-0.0903,-1.6282],[-0.0803,-1.7207],[-0.135,-1.8107],[-0.234,-1.9465],[-0.2429,-1.9587]],
[[0.0019,-1.6265],[0.0892,-1.5748],[0.1663,-1.5105],[0.2432,-1.4471]],
[[0.1068,-1.5916],[0.1338,-1.5646],[0.1623,-1.5391],[0.1913,-1.5142]],
[[0.0019,-1.985],[0.0835,-1.948],[0.1562,-1.8947],[0.2163,-1.8278]],
[[-0.2429,-1.9587],[-0.2386,-1.9371],[-0.2353,-1.9153],[-0.2338,-1.8933]],
[[0.0019,-2.0199],[0.0863,-2.0018],[0.1023,-2.0111],[0.0191,-2.0339]],
[[-0.2167,-2.0462],[-0.2205,-2.0182],[-0.2211,-1.99],[-0.2186,-1.9619]],
[[-0.0025,2.2245],[0.0498,2.2624],[0.0513,2.2129],[0.1464,2.2548]],
[[-0.1686,2.0496],[-0.1255,2.2044],[-0.1517,2.1073],[-0.1246,2.0506]],
[[-0.3959,1.9273],[-0.4302,2.0321],[-0.4894,2.1259],[-0.5591,2.2125]],
[[-0.3894,1.9491],[-0.4016,1.913],[-0.4033,1.9322],[-0.3735,1.7804],[-0.3523,1.6272],[-0.3392,1.5867]],
[[-0.2298,1.9447],[-0.2714,1.8242],[-0.291,1.7097],[-0.312,1.5838]],
[[-0.3304,1.6781],[-0.3392,1.5107],[-0.3186,1.3445],[-0.2587,1.2035]],
[[-0.326,1.5164],[-0.32,1.5223],[-0.3204,1.4917],[-0.3186,1.4611]],
[[-0.291,1.3197],[-0.305,1.3641],[-0.3181,1.4087],[-0.3333,1.4496]],
[[-0.2735,1.2104],[-0.2312,1.1624],[-0.184,1.1196],[-0.138,1.0917]],
[[0.0019,0.6727],[0.0692,0.7329],[0.0757,0.7],[0.0104,0.6375]],
[[-0.2211,0.4629],[-0.1123,0.5669],[-0.084,0.5931],[-0.1505,0.4583],[-0.1757,0.3204],[-0.207,0.3246]],
[[-0.2211,0.4629],[-0.1847,0.4575],[-0.2118,0.3106]],
[[-0.2342,0.4367],[-0.2404,0.3817],[-0.2312,0.327],[-0.227,0.2805]],
[[0.2292,-0.3939],[0.2176,-0.3737],[0.2073,-0.3528],[0.205,-0.3327]],
[[0.2947,-0.5206],[0.2704,-0.4531],[0.2601,-0.5827],[0.2249,-0.6999]],
[[-0.2298,-1.0976],[-0.2527,-1.1731],[-0.2604,-1.2515],[-0.2706,-1.319]],
[[-0.1948,-1.4954],[-0.26,-1.6271],[-0.2827,-1.7732],[-0.2605,-1.9132]],
[[0.1592,-2.1817],[0.1543,-2.093],[0.218,-2.1109],[0.2664,-2.0111]],
[[0.1461,-2.1992],[0.1157,-2.2341],[0.1018,-2.2614],[0.1399,-2.2379]],
];
const N_BRANCH_TOTAL = SVG_BRANCH_PATHS.length * BRANCH_PPB;
const N_VINE_TOTAL = N_VINES * VINE_PPV + N_BRANCH_TOTAL;

// ── 藤蔓路径：相对于脊柱的偏移函数 ──
// 每根藤蔓定义为 spinePoint(t) + perpOffset(t)
// perpOffset 沿切线法向（弯曲态跟随切线旋转，直立态水平）

// 振幅包络：顶部中等→中部最大→底部收窄
function vineEnvelope(t) {
  // 模拟参考图：中段延伸最远，两端收拢
  return 0.6 + 0.4 * Math.sin(t * Math.PI);  // 0.6→1.0→0.6
}

// 藤蔓A：主藤1 — 2个完整周期，振幅加大拉开间距
function vineOffsetA(t) {
  const env = vineEnvelope(t) * 0.58;
  const wave = Math.sin(t * Math.PI * 4 + 0.3)
             + 0.15 * Math.sin(t * Math.PI * 7.2 + 1.0);
  return env * wave;
}

// 藤蔓B：主藤2 — 与A ~90°错位
function vineOffsetB(t) {
  const env = vineEnvelope(t) * 0.52;
  const wave = Math.sin(t * Math.PI * 4 + 0.3 + 1.5)
             + 0.18 * Math.sin(t * Math.PI * 6.8 + 2.8);
  return env * wave;
}

// 藤蔓C：细藤 — 贴近脊柱，稍快频率
function vineOffsetC(t) {
  const env = vineEnvelope(t) * 0.30;
  const wave = Math.sin(t * Math.PI * 5.2 + 1.8)
             + 0.20 * Math.sin(t * Math.PI * 8.5 + 0.5);
  return env * wave;
}

const vineOffsetFns = [vineOffsetA, vineOffsetB, vineOffsetC];

// Z方向偏移 — 与横向偏移成90°相位差，形成真实缠绕
// 横向用 sin(ωt+φ)，Z 用 cos(ωt+φ)，这样：
//   横向=0（穿越脊柱）时 Z 最大或最小（前方或后方）
//   横向=极值（远离脊柱）时 Z≈0（侧面）
function vineZOffsetA(t) {
  const env = vineEnvelope(t) * 0.22;
  return env * Math.cos(t * Math.PI * 4 + 0.3);
}
function vineZOffsetB(t) {
  const env = vineEnvelope(t) * 0.20;
  return env * Math.cos(t * Math.PI * 4 + 0.3 + 1.5);
}
function vineZOffsetC(t) {
  const env = vineEnvelope(t) * 0.12;
  return env * Math.cos(t * Math.PI * 5.2 + 1.8);
}
const vineZFns = [vineZOffsetA, vineZOffsetB, vineZOffsetC];

// 藤蔓粗细（粒子径向展宽，小值=更集中更实）
const vineWidths = [0.022, 0.018, 0.012];

// 生长触发阈值：blend 到达此值时触发该藤蔓的生长动画
const VINE_GROW_THRESHOLDS = [0.25, 0.45, 0.65];
const VINE_GROW_DURATION = 2.0;  // 生长动画持续秒数

// ── 预计算每根藤蔓在 curved 和 straight 两态下的粒子位置 ──
const vnCurvedPosX   = new Float32Array(N_VINE_TOTAL);
const vnCurvedPosY   = new Float32Array(N_VINE_TOTAL);
const vnStraightPosX = new Float32Array(N_VINE_TOTAL);
const vnStraightPosY = new Float32Array(N_VINE_TOTAL);
const vnZPos         = new Float32Array(N_VINE_TOTAL);
const vnParamT       = new Float32Array(N_VINE_TOTAL);
const vnVineId       = new Float32Array(N_VINE_TOTAL);
const vnSizes        = new Float32Array(N_VINE_TOTAL);
const vnAlphas       = new Float32Array(N_VINE_TOTAL);
const vnColorVars    = new Float32Array(N_VINE_TOTAL);
const vnPhase        = new Float32Array(N_VINE_TOTAL);

for (let v = 0; v < N_VINES; v++) {
  const offsetFn = vineOffsetFns[v];
  const width = vineWidths[v];
  const pulsePhase = v * 1.3 + 0.2;

  for (let p = 0; p < VINE_PPV; p++) {
    const idx = v * VINE_PPV + p;
    const t = p / (VINE_PPV - 1);

    // 获取脊柱中心点（两态）
    const cpCurved   = curveCurved.getPoint(t);
    const cpStraight = curveStraight.getPoint(t);

    // 获取切线（两态）
    const tanCurved   = curveCurved.getTangent(t);
    const tanStraight = curveStraight.getTangent(t);  // (0, -1, 0)

    // 藤蔓横向偏移量
    const offset = offsetFn(t);

    // 粒子径向展宽（藤蔓粗细）
    const spread = gaussRand() * width;
    const totalOffset = offset + spread;

    // 弯曲态：沿切线法向偏移
    const perpCX = -tanCurved.y;
    const perpCY =  tanCurved.x;
    vnCurvedPosX[idx] = cpCurved.x + perpCX * totalOffset;
    vnCurvedPosY[idx] = cpCurved.y + perpCY * totalOffset;

    // 直立态：法向 = 水平
    vnStraightPosX[idx] = cpStraight.x + totalOffset;
    vnStraightPosY[idx] = cpStraight.y;

    // Z深度：与横向偏移90°相位差，形成缠绕
    vnZPos[idx] = vineZFns[v](t) + (Math.random() - 0.5) * 0.015;

    vnParamT[idx]  = t;
    vnVineId[idx]  = v;
    vnPhase[idx]   = pulsePhase;
    vnSizes[idx]   = (v < 2 ? 0.055 : 0.040) + Math.random() * 0.025;
    vnAlphas[idx]  = (v < 2 ? 0.75 : 0.55) + Math.random() * 0.20;

    // 颜色分配
    const cRoll = Math.random();
    if (cRoll < 0.08)      vnColorVars[idx] = -(0.25 + Math.random() * 0.25);
    else if (cRoll < 0.15) vnColorVars[idx] = -(0.55 + Math.random() * 0.4);
    else if (cRoll < 0.30) vnColorVars[idx] = 0.4 + Math.random() * 0.5;
    else vnColorVars[idx] = (Math.random() - 0.5) * 0.15;
  }
}

// ── 分支藤蔓粒子（从SVG路径生成）──
// y坐标转脊柱参数t
function yToSpineT(y) {
  return Math.max(0, Math.min(1, (straightTopY - y) / (straightTopY - straightBotY)));
}

let brIdx = N_VINES * VINE_PPV;
for (let bi = 0; bi < SVG_BRANCH_PATHS.length; bi++) {
  const pts = SVG_BRANCH_PATHS[bi];
  if (pts.length < 2) { brIdx += BRANCH_PPB; continue; }

  // 直立态CatmullRom曲线
  const ctrlS = pts.map(([x, y]) => new THREE.Vector3(x, y, 0));
  const curvS = new THREE.CatmullRomCurve3(ctrlS);

  // 弯曲态：每个控制点按y高度加脊柱x偏移
  const ctrlC = pts.map(([x, y]) => {
    const t = yToSpineT(y);
    const spineX = curveCurved.getPoint(t).x;
    return new THREE.Vector3(x + spineX, y, 0);
  });
  const curvC = new THREE.CatmullRomCurve3(ctrlC);

  // 分支属于哪根主藤（SVG1=前21段→vine0, SVG2=后19段→vine1）
  const vineId = bi < 21 ? 0 : 1;
  // 分支的大致脊柱t（用中间点的y）
  const midY = pts[Math.floor(pts.length / 2)][1];
  const branchSpineT = yToSpineT(midY);

  for (let bp = 0; bp < BRANCH_PPB; bp++) {
    if (brIdx >= N_VINE_TOTAL) break;
    const bt = bp / (BRANCH_PPB - 1);
    const ptC = curvC.getPoint(bt);
    const ptS = curvS.getPoint(bt);
    const tanS = curvS.getTangent(bt);

    // 径向展宽（末端更细）
    const taper = 1.0 - bt * 0.5;
    const spread = gaussRand() * 0.016 * taper;
    vnCurvedPosX[brIdx] = ptC.x + (-tanS.y) * spread;
    vnCurvedPosY[brIdx] = ptC.y + tanS.x * spread;
    vnStraightPosX[brIdx] = ptS.x + (-tanS.y) * spread;
    vnStraightPosY[brIdx] = ptS.y + tanS.x * spread;

    // Z深度：继承主藤在该位置的Z
    vnZPos[brIdx] = vineZFns[vineId](branchSpineT) + (Math.random() - 0.5) * 0.02;

    vnParamT[brIdx] = branchSpineT;
    vnVineId[brIdx] = vineId;
    vnPhase[brIdx] = vineId * 1.3 + 0.2;

    vnSizes[brIdx] = (0.042 + Math.random() * 0.018) * taper;
    vnAlphas[brIdx] = (0.50 + Math.random() * 0.18) * taper;
    vnColorVars[brIdx] = 0.1 + Math.random() * 0.2;

    brIdx++;
  }
}

// ── GPU attributes ──
const vnPositions = new Float32Array(N_VINE_TOTAL * 3);
// 初始位置设为弯曲态
for (let i = 0; i < N_VINE_TOTAL; i++) {
  vnPositions[i * 3]     = vnCurvedPosX[i];
  vnPositions[i * 3 + 1] = vnCurvedPosY[i];
  vnPositions[i * 3 + 2] = vnZPos[i];
}

const vineGeo = new THREE.BufferGeometry();
vineGeo.setAttribute('position',   new THREE.BufferAttribute(vnPositions, 3));
vineGeo.setAttribute('aSize',      new THREE.BufferAttribute(vnSizes, 1));
vineGeo.setAttribute('aAlpha',     new THREE.BufferAttribute(vnAlphas, 1));
vineGeo.setAttribute('aColorVar',  new THREE.BufferAttribute(vnColorVars, 1));

// GPU双态定位 attributes
const vnGpuCurvedPos   = new Float32Array(N_VINE_TOTAL * 2);
const vnGpuStraightPos = new Float32Array(N_VINE_TOTAL * 2);
for (let i = 0; i < N_VINE_TOTAL; i++) {
  vnGpuCurvedPos[i * 2]     = vnCurvedPosX[i];
  vnGpuCurvedPos[i * 2 + 1] = vnCurvedPosY[i];
  vnGpuStraightPos[i * 2]     = vnStraightPosX[i];
  vnGpuStraightPos[i * 2 + 1] = vnStraightPosY[i];
}
vineGeo.setAttribute('aCurvedPos',   new THREE.BufferAttribute(vnGpuCurvedPos, 2));
vineGeo.setAttribute('aStraightPos', new THREE.BufferAttribute(vnGpuStraightPos, 2));
vineGeo.setAttribute('aZPos',        new THREE.BufferAttribute(vnZPos, 1));
vineGeo.setAttribute('aParamT',      new THREE.BufferAttribute(vnParamT, 1));
vineGeo.setAttribute('aVineId',      new THREE.BufferAttribute(vnVineId, 1));
vineGeo.setAttribute('aVinePhase',   new THREE.BufferAttribute(vnPhase, 1));

// 藤蔓 vertex shader：GPU双态插值 + 触发式生长 + 能量脉冲
const vineVertexShader = /* glsl */`
  attribute vec2 aCurvedPos;
  attribute vec2 aStraightPos;
  attribute float aZPos;
  attribute float aParamT;
  attribute float aVineId;
  attribute float aVinePhase;
  attribute float aSize;
  attribute float aAlpha;
  attribute float aColorVar;

  uniform float uBlend;
  uniform float uTime;
  uniform vec3 uVineGrowth;  // 每根藤蔓的生长进度 (0→1)

  varying float vAlpha;
  varying float vColorVar;

  void main() {
    // blend 插值：WAVE 级联（与脊柱一致）
    float lb = clamp((uBlend - (1.0 - aParamT) * 0.28) / 0.72, 0.0, 1.0);
    vec2 pos2d = mix(aCurvedPos, aStraightPos, lb);
    vec3 pos = vec3(pos2d.x, pos2d.y, aZPos);

    // 触发式生长：读取JS侧传入的生长进度
    float myGrowth = aVineId < 0.5 ? uVineGrowth.x
                   : (aVineId < 1.5 ? uVineGrowth.y : uVineGrowth.z);
    float growFront = myGrowth * 1.15;
    float visible = smoothstep(growFront + 0.01, growFront - 0.12, aParamT);

    // 能量脉冲：高斯光团从上往下流动
    float pulsePos = mod(uTime * 0.10 + aVinePhase, 1.5) - 0.2;
    float pulse = exp(-pow((aParamT - pulsePos) * 8.0, 2.0));

    // 两端渐隐
    float endFade = smoothstep(0.0, 0.04, aParamT) * smoothstep(1.0, 0.93, aParamT);

    // 前后遮挡：Z<0 的粒子在骨骼后面，明显变暗
    float depthFade = 0.15 + 0.85 * smoothstep(-0.15, 0.02, aZPos);

    float alpha = aAlpha * visible * endFade * depthFade * (0.8 + pulse * 0.2);
    float sz    = aSize * (1.0 + pulse * 0.3);

    vAlpha    = alpha;
    vColorVar = aColorVar + pulse * 0.3;

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = sz * (300.0 / -mv.z);
    gl_Position  = projectionMatrix * mv;
  }
`;

// 藤蔓固定配色：压暗，安静衬托脊柱
const VINE_COLOR = new THREE.Color(0x2a3d30);   // 深苔绿（基色）
const VINE_HL    = new THREE.Color(0x507050);   // 暗灰绿（高光）
const VINE_AC1   = new THREE.Color(0x4a5838);   // 暗橄榄（暖调）
const VINE_AC2   = new THREE.Color(0x1e4848);   // 深青（冷调）

const vineMat = new THREE.ShaderMaterial({
  vertexShader: vineVertexShader, fragmentShader,
  uniforms: {
    uColor:     { value: VINE_COLOR },
    uHighlight: { value: VINE_HL },
    uAccent1:   { value: VINE_AC1 },
    uAccent2:   { value: VINE_AC2 },
    uBlend:      { value: 0.0 },
    uTime:       { value: 0.0 },
    uVineGrowth: { value: new THREE.Vector3(0, 0, 0) },
  },
  transparent: true,
  blending:    THREE.AdditiveBlending,
  depthWrite:  false,
});
const vinePoints = new THREE.Points(vineGeo, vineMat);
vinePoints.frustumCulled = false;
spineGroup.add(vinePoints);

// 藤蔓生长状态（JS侧管理，触发式动画）
const vineGrowTriggered = [false, false, false];
const vineGrowStartTime = [0, 0, 0];
const vineGrowProgress  = [0, 0, 0];


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

// Bloom 用半分辨率渲染（性能关键优化）
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 2)),
  0.15,  // strength
  0.15,  // radius
  0.45   // threshold
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
  // 藤蔓生长状态管理：触发式动画
  for (let v = 0; v < 3; v++) {
    if (!vineGrowTriggered[v] && smoothBlend >= VINE_GROW_THRESHOLDS[v]) {
      vineGrowTriggered[v] = true;
      vineGrowStartTime[v] = time;
    }
    if (vineGrowTriggered[v] && smoothBlend < VINE_GROW_THRESHOLDS[v] - 0.05) {
      // blend 回落，触发收回动画
      vineGrowTriggered[v] = false;
      vineGrowStartTime[v] = time - (1.0 - vineGrowProgress[v]) * VINE_GROW_DURATION;
    }
    if (vineGrowTriggered[v]) {
      vineGrowProgress[v] = Math.min(1.0, (time - vineGrowStartTime[v]) / VINE_GROW_DURATION);
    } else {
      // 收回：从当前进度反向
      const elapsed = time - vineGrowStartTime[v];
      vineGrowProgress[v] = Math.max(0.0, 1.0 - elapsed / VINE_GROW_DURATION);
    }
  }
  vineMat.uniforms.uVineGrowth.value.set(vineGrowProgress[0], vineGrowProgress[1], vineGrowProgress[2]);
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

  if (N_DFULL > 0) {
    diffuseGeo.attributes.position.needsUpdate = true;
    diffuseGeo.attributes.aSize.needsUpdate    = true;
    diffuseGeo.attributes.aAlpha.needsUpdate   = true;
  }

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
  bloomPass.resolution.set(Math.floor(w / 2), Math.floor(h / 2));
});

animate();
