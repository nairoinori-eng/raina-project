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
import { VINE1_SEGMENTS, VINE2_SEGMENTS } from './figma-vine-paths.js';
import { LEAF_SHAPES } from './leaf-shapes.js';
import { generateFlowerTemplate, PETAL_Z_LAYERS } from './flower-shapes.js';
import { IntroOverlays } from './intro-overlays.js';


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

const COLOR_DARK = new THREE.Color(0x3f2a82);  // 中等饱和深紫
const COLOR_MID  = new THREE.Color(0xd87890);  // 粉红过渡（饱和的中间色，不再灰）
const COLOR_GOLD = new THREE.Color(0xd49c58);  // 中等饱和暖金

// 高光色（接近白色的高亮，强烈正面光感）
const HL_DARK = new THREE.Color(0xc8a0f4);   // 柔和亮紫
const HL_MID  = new THREE.Color(0xffd8e8);   // 亮粉高光
const HL_GOLD = new THREE.Color(0xffe0a0);   // 柔和亮金

// 对比色1：暖色系（高饱和）
const AC1_DARK = new THREE.Color(0xff6840);  // 鲜橘红
const AC1_MID  = new THREE.Color(0xf8d030);  // 亮黄（粉里撞出来的暖 pop 色）
const AC1_GOLD = new THREE.Color(0xff3090);  // 亮品红（在金色中极醒目）

// 对比色2：冷色系（高饱和）
const AC2_DARK = new THREE.Color(0x20e0c0);  // 鲜翡翠
const AC2_MID  = new THREE.Color(0x30d0b0);  // 薄荷绿松石（粉的互补色，最强反差）
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

/** piecewise 3 段插值：blend<0.5 从 A→MID，blend≥0.5 从 MID→B。写回 out。 */
function lerpMid(out, A, MID, B, t) {
  if (t < 0.5) out.lerpColors(A, MID, t * 2);
  else         out.lerpColors(MID, B, (t - 0.5) * 2);
}

/** 不对称"拉长停留"：0~holdA 保持 0（紫色停留），1-holdB~1 保持 1（金色停留）。
 *  紫色 hold 更长（观众看得多），金色 hold 更短（过渡占大头）。 */
function remapDwellAsym(t, holdA, holdB) {
  if (t <= holdA)       return 0;
  if (t >= 1 - holdB)   return 1;
  return (t - holdA) / (1 - holdA - holdB);
}


// ============================================================
// 5. 场景 / 摄像机 / 渲染器
// ============================================================

const canvas = document.getElementById('spine-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(3.0);  // 锁定高清模式（uAlphaBoost 在 composer 初始化后一并设置）
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
  uniform float uAlphaBoost; // 高清模式亮度补偿
  varying float vAlpha;
  varying float vColorVar;
  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;
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
    float alpha = (core + halo) * vAlpha * uAlphaBoost;
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
  uniform float uFormation;    // 0 = scattered (IDLE), 1 = formed (spine visible)
  uniform float uGuideAlpha;   // overall alpha multiplier (0 during teaching)
  varying float vAlpha;
  varying float vColorVar;
  varying float vParamT;
  void main() {
    // ── Formed position (normal spine) ──
    float lb = clamp((uBlend - (1.0 - aParamT) * 0.28) / 0.72, 0.0, 1.0);
    vec2 center = mix(aCurvedPos, aStraightPos, lb);
    vec2 off = mix(aCurvedOff, aStraightOff, lb);
    vec3 formedPos = vec3(center.x + off.x * uBreatheExpand, center.y + off.y, aZPos);

    // ── Scattered position (IDLE star dust) ──
    // Use per-axis independent seeds to avoid correlation
    float sX = aPhase * 2.7 + aParamT * 13.1 + aColorVar * 7.3;
    float sY = aPhase * 5.1 + aParamT * 3.7  + aColorVar * 11.9;
    float sZ = aPhase * 3.9 + aParamT * 19.7 + aColorVar * 2.3;
    float rx = fract(sin(sX * 12.9898) * 43758.5453) * 2.0 - 1.0;
    float ry = fract(sin(sY * 78.233)  * 43758.5453) * 2.0 - 1.0;
    float rz = fract(sin(sZ * 45.164)  * 43758.5453) * 2.0 - 1.0;
    // Large spread across full screen (camera z=5 FOV 60, visible ~±2.9)
    vec3 scatterPos = vec3(rx * 7.5, ry * 5.0, rz * 2.5);
    // Per-particle drift speed for organic floating
    float driftSpd = 0.06 + fract(sX * 1.23) * 0.14;
    scatterPos.x += sin(uTime * driftSpd + sX * 6.28) * 0.6;
    scatterPos.y += cos(uTime * driftSpd * 0.75 + sY * 4.0) * 0.42;
    scatterPos.x += sin(uTime * 0.05 + sZ * 2.0) * 0.22;

    // ── Blend between scatter and formed ──
    vec3 pos = mix(scatterPos, formedPos, uFormation);

    // ── Size: varied dust in IDLE (small + large mix), normal when formed ──
    float sizeRand = fract(sX * 3.14);
    float idleSize = 0.015 + sizeRand * sizeRand * 0.09;
    float formedSize = aSize * (1.0 + sin(uTime * 1.57 + aPhase) * 0.06);
    float size = mix(idleSize, formedSize, uFormation);

    // ── Alpha: scattered particles visible in IDLE (~30% visible) ──
    float idleVisible = step(0.70, fract(sY * 0.618));
    float idleAlpha = (0.15 + fract(sZ * 2.71) * 0.20) * idleVisible;
    float formedAlpha = aAlpha * (0.55 + uBreathe * 0.45);
    float alpha = mix(idleAlpha, formedAlpha, uFormation) * uGuideAlpha;

    vAlpha = alpha;
    vColorVar = aColorVar;
    vParamT = aParamT;
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = size * (300.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

// Spine-specific fragment shader with segment highlighting support
const spineFragmentShader = /* glsl */`
  uniform vec3 uColor;
  uniform vec3 uHighlight;
  uniform vec3 uAccent1;
  uniform vec3 uAccent2;
  uniform float uSegmentHighlight;  // 0 = normal, 1 = thoracic orange + lumbar cyan
  uniform float uAlphaBoost; // 高清模式亮度补偿
  varying float vAlpha;
  varying float vColorVar;
  varying float vParamT;
  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;
    vec3 c;
    if (vColorVar > 0.0) {
      c = mix(uColor, uHighlight, clamp(vColorVar, 0.0, 1.0));
    } else if (vColorVar > -0.5) {
      c = mix(uColor, uAccent1, clamp(-vColorVar * 2.0, 0.0, 1.0));
    } else {
      c = mix(uColor, uAccent2, clamp((-vColorVar - 0.5) * 2.0, 0.0, 1.0));
    }
    c = clamp(c, 0.0, 0.88);
    // Segment highlight: 只高亮弯曲最严重的区域
    // 胸椎峰值 @ t ≈ 0.33 (T7)，腰椎峰值 @ t ≈ 0.75 (L3)
    // 用 AC1_DARK (鲜橘红) 和 AC2_DARK (鲜翡翠) 保证色板一致性
    if (uSegmentHighlight > 0.0) {
      vec3 thoracicCol = vec3(1.0, 0.408, 0.251);   // AC1_DARK 0xff6840
      vec3 lumbarCol   = vec3(0.125, 0.878, 0.753);  // AC2_DARK 0x20e0c0
      // 胸椎区域：t 从 0.12 升起，0.33 峰值，0.52 落下
      float thorZone = smoothstep(0.12, 0.28, vParamT)
                     * (1.0 - smoothstep(0.38, 0.52, vParamT));
      // 腰椎区域：t 从 0.58 升起，0.75 峰值，0.95 落下
      float lumbZone = smoothstep(0.58, 0.72, vParamT)
                     * (1.0 - smoothstep(0.82, 0.95, vParamT));
      vec3 hlColor = thoracicCol * thorZone + lumbarCol * lumbZone;
      float hlStrength = max(thorZone, lumbZone);
      c = mix(c, hlColor * 1.5, hlStrength * uSegmentHighlight);
    }
    float core  = exp(-d * d * 24.0);
    float halo  = exp(-d * d * 10.0) * 0.12;
    float alpha = (core + halo) * vAlpha * uAlphaBoost;
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

// 空心管参数（跟随 SPINE_SCALE 缩放）
const TUBE_OUTER   = 0.14 * SPINE_SCALE;
const TUBE_INNER   = 0.055 * SPINE_SCALE;
const TUBE_Y_SCALE = 1.9;              // Z 方向椭圆截面，增强立体感

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
    bBaseS[i] = (0.028 + Math.random() * 0.024) * Math.max(0.3, taperFactor) * gapFactor;
    bBaseA[i] = (0.10 + Math.random() * 0.07) * Math.max(0.3, taperFactor) * gapFactor;
  } else {
    const wallRatio = effectiveOuter > effectiveInner
      ? (r - effectiveInner) / (effectiveOuter - effectiveInner) : 0;
    bBaseS[i] = (0.032 + wallRatio * 0.024 + Math.random() * 0.016) * (0.6 + Math.random() * 0.7) * Math.max(0.2, taperFactor);
    bBaseA[i] = ((0.12 + wallRatio * 0.10) + Math.random() * 0.05) * taperFactor * gapFactor;
  }
  bPhase[i] = Math.random() * Math.PI * 2;

  // colorVar：明暗区掺撞色，粒子大小不变
  const zDepth = Math.abs(bZ[i]) / Math.max(effectiveOuter * TUBE_Y_SCALE, 0.01);
  const acRoll = Math.random();
  if (acRoll < 0.07) {
    // 暖撞色（暗部掺入）
    spColorVars[i] = -(0.15 + Math.random() * 0.25);
    bBaseA[i] *= 1.6;
  } else if (acRoll < 0.14) {
    // 冷撞色
    spColorVars[i] = -(0.50 + Math.random() * 0.35);
    bBaseA[i] *= 1.6;
  } else if (acRoll < 0.22) {
    // 高光粒子
    spColorVars[i] = 0.45 + Math.random() * 0.35;
    bBaseA[i] *= 1.4;
  } else {
    // 普通粒子：前亮后暗
    spColorVars[i] = (1 - zDepth) * 0.35 + (Math.random() - 0.5) * 0.10;
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
    const gz     = Math.sin(vAngle) * vr * 1.9; // Z 方向椭圆，与 TUBE_Y_SCALE 一致
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
    if (vacRoll < 0.03) {
      spColorVars[gi] = -(0.20 + Math.random() * 0.20);
      vBaseAlph[idx] *= 2.2;
    } else if (vacRoll < 0.06) {
      spColorVars[gi] = -(0.55 + Math.random() * 0.30);
      vBaseAlph[idx] *= 2.2;
    } else if (vacRoll < 0.12) {
      spColorVars[gi] = 0.5 + Math.random() * 0.3;
      vBaseAlph[idx] *= 1.8;
    } else {
      spColorVars[gi] = (1 - vzDepth) * 0.35 + (Math.random() - 0.5) * 0.08;
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
  vertexShader: spineVertexShader, fragmentShader: spineFragmentShader,
  uniforms: {
    uColor:             { value: COLOR_DARK.clone() },
    uHighlight:         { value: HL_DARK.clone() },
    uAccent1:           { value: AC1_DARK.clone() },
    uAccent2:           { value: AC2_DARK.clone() },
    uAlphaBoost:        { value: 1.0 },
    uBlend:             { value: 0.0 },
    uBreatheExpand:     { value: 1.0 },
    uBreathe:           { value: 0.0 },
    uTime:              { value: 0.0 },
    uFormation:         { value: 0.0 },   // 0=scattered, 1=formed
    uGuideAlpha:        { value: 1.0 },   // overall alpha (0 during teaching)
    uSegmentHighlight:  { value: 0.0 },   // 0=normal, 1=thoracic/lumbar highlight
  },
  transparent: true,
  blending:    THREE.AdditiveBlending,
  depthWrite:  false,
});
const spinePoints = new THREE.Points(spineGeo, spineMat);
spinePoints.frustumCulled = false;
spineGroup.add(spinePoints);

// ── 正常直脊柱对比线（虚线，教学段使用）──
const comparisonPoints = [];
for (let i = 0; i <= 80; i++) {
  comparisonPoints.push(curveStraight.getPoint(i / 80));
}
const comparisonGeo = new THREE.BufferGeometry().setFromPoints(comparisonPoints);
const comparisonMat = new THREE.LineDashedMaterial({
  color: 0xbbbbcc,
  transparent: true,
  opacity: 0,
  dashSize: 0.12,
  gapSize: 0.10,
  linewidth: 1,
});
const comparisonLine = new THREE.Line(comparisonGeo, comparisonMat);
comparisonLine.computeLineDistances();
// 放在脊柱中线（x=0），代表"如果没弯曲应该在哪里"
comparisonLine.position.z = -0.1;
spineGroup.add(comparisonLine);


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
    uColor:      { value: COLOR_DARK.clone() },
    uHighlight:  { value: HL_DARK.clone() },
    uAccent1:    { value: AC1_DARK.clone() },
    uAccent2:    { value: AC2_DARK.clone() },
    uAlphaBoost: { value: 1.0 },
  },
  transparent: true,
  blending:    THREE.AdditiveBlending,
  depthWrite:  false,
});
spineGroup.add(new THREE.Points(diffuseGeo, diffuseMat));


// ============================================================
// 9. vineGeo (Layer F — Figma路径藤蔓系统)
// ============================================================

const VINE_ALL_SEGMENTS = [VINE1_SEGMENTS]; // 只保留主藤蔓
const N_VINES = 3; // vineId 0=主藤蔓, 1/2=点缀藤蔓（依次生长）

// ── 点缀藤蔓配置（薄、细、装饰性）──
// 螺旋缠绕：x=R*sin(θ), z=R*cos(θ)，永远在骨骼外圈
const ACCENT_VINES = [
  { radius: 0.34, freq: 2.5, phase: Math.PI * 0.35, ppv: 15000, width: 0.012, alpha: 0.85 },
  { radius: 0.26, freq: 3.5, phase: Math.PI * 1.30, ppv: 12000, width: 0.010, alpha: 0.80 },
];
const ACCENT_TOTAL = ACCENT_VINES.reduce((s, a) => s + a.ppv, 0);

// ── 分支尖端弥散粒子 ──
// 从3个分支尖端弥散（位置从实际曲线计算，不硬编码）
const DRIFT_SEG_INDICES = [7, 9, 12]; // VINE1中弥散的3个分支段
const DRIFT_PPV = 5000; // 每个分支弥散粒子数
const DRIFT_TOTAL = DRIFT_SEG_INDICES.length * DRIFT_PPV;

// ── 藤蔓拓扑分析（自动检测主干/分支/末梢）──
function vineKey(pt) {
  return `${pt[0].toFixed(3)},${pt[1].toFixed(3)}`;
}

function analyzeVineTopology(segments) {
  const conns = new Map();
  for (const seg of segments) {
    const sk = vineKey(seg[0]);
    const ek = vineKey(seg[seg.length - 1]);
    conns.set(sk, (conns.get(sk) || 0) + 1);
    conns.set(ek, (conns.get(ek) || 0) + 1);
  }
  return segments.map(seg => {
    const sc = conns.get(vineKey(seg[0])) || 1;
    const ec = conns.get(vineKey(seg[seg.length - 1])) || 1;
    const depth = (sc >= 3 && ec >= 3) ? 0
                : (sc >= 3 || ec >= 3) ? 1 : 2;
    const rootAtStart = sc >= ec;
    return { depth, rootAtStart };
  });
}

// ── 脊柱 x 偏移查找表（straight→curved 映射）──
const SPINE_LUT_N = 500;
const spineLutY = new Float32Array(SPINE_LUT_N);
const spineLutX = new Float32Array(SPINE_LUT_N);
for (let i = 0; i < SPINE_LUT_N; i++) {
  const t = i / (SPINE_LUT_N - 1);
  const pt = curveCurved.getPoint(t);
  spineLutY[i] = pt.y;
  spineLutX[i] = pt.x;
}

function getSpineXAtY(y) {
  if (y >= spineLutY[0]) return spineLutX[0];
  if (y <= spineLutY[SPINE_LUT_N - 1]) return spineLutX[SPINE_LUT_N - 1];
  let lo = 0, hi = SPINE_LUT_N - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (spineLutY[mid] > y) lo = mid; else hi = mid;
  }
  const frac = (y - spineLutY[lo]) / (spineLutY[hi] - spineLutY[lo]);
  return spineLutX[lo] + frac * (spineLutX[hi] - spineLutX[lo]);
}

// ── 预计算曲线和弧长 ──
const VINE_X_SCALE = 1.5;  // 藤蔓横向扩展，拉开与脊柱的距离
const VINE_Y_SCALE = 1.35; // 藤蔓纵向拉伸，覆盖到脊柱尖端
const VINE_WIDTHS = [0.012, 0.005, 0.003];
const VINE_GROW_THRESHOLDS = [0.05, 0.10, 0.15];
const VINE_GROW_DURATION = 2.0;

const VINE_BRANCH_EXTEND = 1.6; // 分支从junction向外延伸倍率
const vineData = VINE_ALL_SEGMENTS.map((segments) => {
  const topo = analyzeVineTopology(segments);
  const curves = segments.map((seg, si) => {
    const pts = seg.map(([x, y]) => new THREE.Vector3(x, y, 0));
    // 分支加长：从root端向外拉伸
    const { depth, rootAtStart } = topo[si];
    if (depth > 0) {
      const rootIdx = rootAtStart ? 0 : pts.length - 1;
      const root = pts[rootIdx];
      for (let i = 0; i < pts.length; i++) {
        if (i === rootIdx) continue;
        pts[i].x = root.x + (pts[i].x - root.x) * VINE_BRANCH_EXTEND;
        pts[i].y = root.y + (pts[i].y - root.y) * VINE_BRANCH_EXTEND;
      }
    }
    return new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.15);
  });
  const lengths = curves.map(c => c.getLength());
  return { segments, topo, curves, lengths };
});

// 按弧长比例分配粒子（目标 >= 21000）
const VINE_TARGET_TOTAL = 60000;
const totalArcLen = vineData.reduce((s, vd) =>
  s + vd.lengths.reduce((a, b) => a + b, 0), 0);

vineData.forEach(vd => {
  const vineLen = vd.lengths.reduce((a, b) => a + b, 0);
  const vineTarget = Math.round(VINE_TARGET_TOTAL * vineLen / totalArcLen);
  vd.ppvs = vd.lengths.map(len =>
    Math.max(30, Math.round(vineTarget * len / vineLen))
  );
});

// ── 从曲线计算弥散发射点（精确位于分支尖端）──
const driftEmitters = DRIFT_SEG_INDICES.map(si => {
  const curve = vineData[0].curves[si];
  const { rootAtStart } = vineData[0].topo[si];
  const tipT = rootAtStart ? 0.998 : 0.002; // 接近端点避免边界问题
  const tipPt = curve.getPointAt(tipT);
  const tipTan = curve.getTangentAt(tipT);
  // 方向：从root指向tip（向外）
  const sign = rootAtStart ? 1 : -1;
  const rawDx = tipTan.x * sign * VINE_X_SCALE;
  const rawDy = tipTan.y * sign * VINE_Y_SCALE;
  const dLen = Math.sqrt(rawDx * rawDx + rawDy * rawDy) || 1;
  return {
    sx: tipPt.x * VINE_X_SCALE,
    sy: tipPt.y * VINE_Y_SCALE,
    dx: rawDx / dLen,
    dy: rawDy / dLen,
  };
});

const N_VINE_TOTAL = vineData.reduce((sum, vd) =>
  sum + vd.ppvs.reduce((a, b) => a + b, 0), 0) + ACCENT_TOTAL + DRIFT_TOTAL;

// 全局 y 范围
let vineYMax = -Infinity, vineYMin = Infinity;
for (const vd of vineData) {
  for (const seg of vd.segments) {
    for (const [, y] of seg) {
      if (y > vineYMax) vineYMax = y;
      if (y < vineYMin) vineYMin = y;
    }
  }
}
const vineYRange = vineYMax - vineYMin;

// ── 预分配粒子数组 ──
const vnStraightX = new Float32Array(N_VINE_TOTAL);
const vnStraightY = new Float32Array(N_VINE_TOTAL);
const vnCurvedX   = new Float32Array(N_VINE_TOTAL);
const vnCurvedY   = new Float32Array(N_VINE_TOTAL);
const vnZPos      = new Float32Array(N_VINE_TOTAL);
const vnParamT    = new Float32Array(N_VINE_TOTAL);
const vnVineId    = new Float32Array(N_VINE_TOTAL);
const vnSizes     = new Float32Array(N_VINE_TOTAL);
const vnAlphas    = new Float32Array(N_VINE_TOTAL);
const vnColorVars = new Float32Array(N_VINE_TOTAL);
const vnPhase     = new Float32Array(N_VINE_TOTAL);

let particleIdx = 0;
for (let vi = 0; vi < vineData.length; vi++) {
  const vd = vineData[vi];
  const pulsePhase = vi * 1.3 + 0.2;

  for (let si = 0; si < vd.curves.length; si++) {
    // 弥散分支由专门的弥散系统处理，跳过
    if (vi === 0 && DRIFT_SEG_INDICES.includes(si)) continue;
    const curve = vd.curves[si];
    const ppv = vd.ppvs[si];
    const { depth, rootAtStart } = vd.topo[si];
    const baseWidth = VINE_WIDTHS[Math.min(depth, 2)];

    for (let p = 0; p < ppv; p++) {
      const t = p / Math.max(1, ppv - 1);
      const pt = curve.getPointAt(t);
      const tangent = curve.getTangentAt(t);

      const sx = pt.x * VINE_X_SCALE;
      const sy = pt.y * VINE_Y_SCALE;

      // curved: 扩展后的坐标 + 脊柱弯曲偏移
      const spineX = getSpineXAtY(sy);
      const cx = sx + spineX;
      const cy = sy;

      // 粗细渐变：root端粗 → tip端细
      const taperT = rootAtStart ? t : (1 - t);
      const taper = depth === 0
        ? (0.85 + 0.15 * (1 - taperT))
        : (1.0 - taperT * 0.92);
      const width = baseWidth * taper;

      // 垂直于藤蔓切线方向展宽
      const perpX = -tangent.y;
      const perpY = tangent.x;
      const spread = gaussRand() * width;

      vnStraightX[particleIdx] = sx + perpX * spread;
      vnStraightY[particleIdx] = sy + perpY * spread;
      vnCurvedX[particleIdx]   = cx + perpX * spread;
      vnCurvedY[particleIdx]   = cy + perpY * spread;

      // Z 深度：切线方向驱动缠绕
      // 藤蔓往右摆(tangent.x>0)=前面，往左摆=后面
      // 两根藤蔓反向，形成交织
      const yNorm = (vineYMax - sy) / vineYRange;
      const vineFactor = vi === 0 ? 1 : -1;
      const wrapR = 0.06;
      vnZPos[particleIdx] = tangent.x * wrapR * vineFactor + gaussRand() * 0.008;

      vnParamT[particleIdx] = yNorm;
      vnVineId[particleIdx] = vi;
      vnPhase[particleIdx]  = pulsePhase;

      const baseSize = depth === 0 ? 0.038 : depth === 1 ? 0.030 : 0.022;
      vnSizes[particleIdx] = baseSize + Math.random() * 0.010;
      vnAlphas[particleIdx] = (depth === 0 ? 0.90 : 0.75) + Math.random() * 0.10;

      // 颜色渐变：顶部暖亮 → 底部深冷 + Z深度立体
      const yNormColor = (vineYMax - sy) / vineYRange;
      const gradient = 0.4 - yNormColor * 0.9; // +0.4(顶/高光) → -0.5(底/冷调)
      const z = vnZPos[particleIdx];
      const zBias = z > 0.03 ? 0.15 : z < -0.03 ? -0.15 : 0.0;
      vnColorVars[particleIdx] = gradient + zBias + (Math.random() - 0.5) * 0.12;

      particleIdx++;
    }
  }
}

// ── 点缀藤蔓（螺旋缠绕，永远在骨骼外圈）──
function vineEnvelope(t) {
  return 0.6 + 0.4 * Math.sin(t * Math.PI);
}
ACCENT_VINES.forEach((accent, accentIdx) => {
  for (let p = 0; p < accent.ppv; p++) {
    const t = p / (accent.ppv - 1);
    const cpS = curveStraight.getPoint(t);
    const cpC = curveCurved.getPoint(t);
    const tanC = curveCurved.getTangent(t);

    // 螺旋角度
    const theta = t * Math.PI * accent.freq * 2 + accent.phase;
    const env = vineEnvelope(t);
    const r = accent.radius * env;

    // x = R*sin(θ), z = R*cos(θ) → 圆形缠绕，永不穿过骨骼
    const helixX = r * Math.sin(theta);
    const helixZ = r * Math.cos(theta);
    const spread = gaussRand() * accent.width;

    // straight: 螺旋偏移
    const sx = helixX + spread;
    const sy = cpS.y;

    // curved: 沿脊柱切线法向偏移
    const perpCX = -tanC.y;
    const perpCY =  tanC.x;
    const cx = cpC.x + perpCX * (helixX + spread);
    const cy = cpC.y + perpCY * (helixX + spread);

    vnStraightX[particleIdx] = sx;
    vnStraightY[particleIdx] = sy;
    vnCurvedX[particleIdx]   = cx;
    vnCurvedY[particleIdx]   = cy;

    // Z: cos分量 → 前面(z>0)亮, 后面(z<0)暗
    vnZPos[particleIdx] = helixZ + gaussRand() * 0.005;

    const yNorm = (vineYMax - sy) / vineYRange;
    vnParamT[particleIdx]  = yNorm;
    vnVineId[particleIdx]  = accentIdx + 1; // 1,2,3 依次长出
    vnPhase[particleIdx]   = accent.phase;
    vnSizes[particleIdx]   = 0.022 + Math.random() * 0.006;
    vnAlphas[particleIdx]  = accent.alpha + Math.random() * 0.10;
    vnColorVars[particleIdx] = (Math.random() - 0.5) * 0.15;

    particleIdx++;
  }
});

// ── 分支弥散（整个分支逐渐化开：根部实→尖端散→远处消失）──
for (const si of DRIFT_SEG_INDICES) {
  const curve = vineData[0].curves[si];
  const { rootAtStart } = vineData[0].topo[si];
  const tipT = rootAtStart ? 0.998 : 0.002;
  const tipPt = curve.getPointAt(tipT);
  const tipTan = curve.getTangentAt(tipT);
  const outSign = rootAtStart ? 1 : -1;
  // 尖端在脊柱左边还是右边？决定飘散的横向偏移
  const tipWorldX = tipPt.x * VINE_X_SCALE;
  const sideBias = tipWorldX > 0 ? 1.0 : -1.0; // 正=右侧→往右飘，负=左侧→往左飘

  for (let p = 0; p < DRIFT_PPV; p++) {
    // rawT: 0=分支根部, 1=尖端, 1~5=超出尖端飘散到屏幕边缘
    const rawT = (p / (DRIFT_PPV - 1)) * 5.0;

    // 计算沿曲线位置 + 超出尖端的延伸
    let px, py, tanX, tanY;
    const clampedT = Math.min(rawT, 1.0);
    const ct = rootAtStart
      ? Math.max(0.002, Math.min(0.998, clampedT))
      : Math.max(0.002, Math.min(0.998, 1.0 - clampedT));
    const curvePt = curve.getPointAt(ct);
    const curveTan = curve.getTangentAt(ct);

    if (rawT <= 0.95) {
      // 在分支曲线上
      px = curvePt.x; py = curvePt.y;
      tanX = curveTan.x * outSign; tanY = curveTan.y * outSign;
    } else {
      // 0.95+延伸：一出尖端就往左/右弯，带蜿蜒
      const beyond = Math.max(0, rawT - 0.95) * 1.2;
      // 沿切线少量前进，主要是横向飘
      const forwardDrift = beyond * 0.3;
      const lateralDrift = (beyond * 0.25 + beyond * beyond * 0.08) * sideBias;
      const baseX = tipPt.x + tipTan.x * outSign * forwardDrift + lateralDrift;
      const baseY = tipPt.y + tipTan.y * outSign * forwardDrift;
      // 蜿蜒S曲线
      const waveAmp = 0.03 + beyond * 0.08;
      const wave = Math.sin(beyond * 2.5 + si * 2.5);
      px = baseX;
      py = baseY + wave * waveAmp;
      tanX = tipTan.x * outSign; tanY = tipTan.y * outSign;
    }

    // 散布：根部实线 → 尖端微宽 → 远处渐散但仍成线
    const spreadWidth = rawT < 0.5
      ? 0.003 + rawT * 0.010
      : rawT < 1.0
        ? 0.008 + (rawT - 0.5) * 0.012
        : 0.014 + (rawT - 1.0) * 0.008; // 远处max≈0.046，仍可见
    const perpX = -tanY, perpY = tanX;
    const spread = gaussRand() * spreadWidth;

    const sx = px * VINE_X_SCALE + perpX * spread;
    const sy = py * VINE_Y_SCALE + perpY * spread;
    const spineX = getSpineXAtY(sy);

    vnCurvedX[particleIdx]   = sx + spineX;
    vnCurvedY[particleIdx]   = sy;
    vnStraightX[particleIdx] = sx;
    vnStraightY[particleIdx] = sy;
    vnZPos[particleIdx]      = gaussRand() * 0.01;

    const yNorm = Math.max(0, Math.min(1, (vineYMax - sy) / vineYRange));
    vnParamT[particleIdx]    = yNorm;
    vnVineId[particleIdx]    = 0;
    vnPhase[particleIdx]     = Math.random() * 3.0;

    // 根部实 → 缓慢变淡 → 屏幕边缘消失
    const fadeAlpha = rawT < 1.0 ? 0.75 - rawT * 0.10
                    : Math.max(0.0, 0.65 * (1.0 - (rawT - 1.0) / 4.0));
    vnAlphas[particleIdx]    = fadeAlpha;
    vnSizes[particleIdx]     = 0.042 + Math.random() * 0.012;
    vnColorVars[particleIdx] = 0.1 + Math.random() * 0.2;

    particleIdx++;
  }
}

// ── GPU attributes ──
const vnPositions = new Float32Array(N_VINE_TOTAL * 3);
for (let i = 0; i < N_VINE_TOTAL; i++) {
  vnPositions[i * 3]     = vnCurvedX[i];
  vnPositions[i * 3 + 1] = vnCurvedY[i];
  vnPositions[i * 3 + 2] = vnZPos[i];
}

const vineGeo = new THREE.BufferGeometry();
vineGeo.setAttribute('position',   new THREE.BufferAttribute(vnPositions, 3));
vineGeo.setAttribute('aSize',      new THREE.BufferAttribute(vnSizes, 1));
vineGeo.setAttribute('aAlpha',     new THREE.BufferAttribute(vnAlphas, 1));
vineGeo.setAttribute('aColorVar',  new THREE.BufferAttribute(vnColorVars, 1));

const vnGpuCurvedPos   = new Float32Array(N_VINE_TOTAL * 2);
const vnGpuStraightPos = new Float32Array(N_VINE_TOTAL * 2);
for (let i = 0; i < N_VINE_TOTAL; i++) {
  vnGpuCurvedPos[i * 2]     = vnCurvedX[i];
  vnGpuCurvedPos[i * 2 + 1] = vnCurvedY[i];
  vnGpuStraightPos[i * 2]     = vnStraightX[i];
  vnGpuStraightPos[i * 2 + 1] = vnStraightY[i];
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
  uniform vec3 uVineGrowth;
  uniform float uSpineXs[33];
  uniform float uSpineYs[33];
  uniform float uSpineHalfW;
  uniform float uSpineRotY;
  uniform float uFormation;  // hide vines during intro (0=hidden, 1=visible)

  varying float vAlpha;
  varying float vColorVar;

  // 查骨骼曲线中心 X（按 y 线性插值 33 个 catmull-rom 采样点）。
  // 按 y 降序存储（C7 最高 → S1 最低）。累加器写法避免 loop 里 return。
  float spineCenterXCurved(float y) {
    float result = (y > uSpineYs[0]) ? uSpineXs[0] : uSpineXs[32];
    for (int i = 0; i < 32; i++) {
      float y0 = uSpineYs[i];       // 上端
      float y1 = uSpineYs[i + 1];   // 下端
      if (y <= y0 && y >= y1) {
        float k = (y - y1) / (y0 - y1 + 1e-6);
        result = mix(uSpineXs[i + 1], uSpineXs[i], k);
      }
    }
    return result;
  }

  void main() {
    float alpha;
    float sz;
    vec3 pos;

    {
      float lb = clamp((uBlend - (1.0 - aParamT) * 0.28) / 0.72, 0.0, 1.0);
      vec2 pos2d = mix(aCurvedPos, aStraightPos, lb);

      // blend 高时藤蔓 X 外扩（直立态弧度拉大，增加视觉张力）
      float spreadFactor = 1.0 + smoothstep(0.5, 1.0, uBlend) * 0.35;
      pos2d.x *= spreadFactor;

      // 随风摇曳
      float swayBase = 1.0 - aParamT * 0.3;
      float vineAmp = aVineId < 0.5 ? 1.0 : aVineId < 1.5 ? 1.4 : 0.7;
      float vineFreq = aVineId < 0.5 ? 1.0 : aVineId < 1.5 ? 0.8 : 1.3;
      float swayX = sin(uTime * 0.35 * vineFreq + aParamT * 3.0 + aVinePhase) * 0.03 * swayBase * vineAmp;
      float swayY = sin(uTime * 0.6 * vineFreq + aParamT * 8.0 + aVinePhase * 2.0) * 0.06 * swayBase * vineAmp
                  + sin(uTime * 1.2 * vineFreq + aParamT * 14.0) * 0.02 * swayBase * vineAmp;
      pos2d.x += swayX;
      pos2d.y += swayY;

      pos = vec3(pos2d.x, pos2d.y, aZPos);

      // 3根藤蔓依次生长
      float myGrowth = aVineId < 0.5 ? uVineGrowth.x
                     : aVineId < 1.5 ? uVineGrowth.y
                     : uVineGrowth.z;
      float growFront = myGrowth * 1.15;
      float visible = smoothstep(growFront + 0.01, growFront - 0.12, aParamT);

      // 光流脉冲（每根藤蔓节奏错开）
      float pulseOff = aVineId < 0.5 ? 0.0 : aVineId < 1.5 ? 0.55 : 1.10;
      float pulsePos = mod(uTime * 0.13 + pulseOff, 1.6) - 0.15;
      float pulse = exp(-pow((aParamT - pulsePos) * 5.0, 2.0));
      float pulsePos2 = mod(uTime * 0.20 + pulseOff + 0.7, 1.8) - 0.1;
      float pulse2 = exp(-pow((aParamT - pulsePos2) * 7.0, 2.0)) * 0.4;
      float totalPulse = pulse + pulse2;

      float endFade = smoothstep(0.0, 0.04, aParamT) * smoothstep(1.0, 0.93, aParamT);

      // 遮挡判定：考虑 spineGroup 的 Y 轴旋转，把 (local x, local z) 转到世界空间再比较。
      // 骨骼是竖直柱（local z 恒 0），只受 uBlend 混合影响 local x。
      float spineCxLocal = mix(spineCenterXCurved(pos2d.y), 0.0, uBlend);
      float cy = cos(uSpineRotY);
      float sy = sin(uSpineRotY);
      // 粒子世界 (x, z)
      float pWorldX =  pos2d.x * cy + aZPos * sy;
      float pWorldZ = -pos2d.x * sy + aZPos * cy;
      // 骨骼中心世界 (x, z)（local z=0）
      float spineWorldX =  spineCxLocal * cy;
      float spineWorldZ = -spineCxLocal * sy;
      // 2D 水平距离（世界空间）+ 软过渡
      float dxWorld = abs(pWorldX - spineWorldX);
      float xOcclusion = 1.0 - smoothstep(uSpineHalfW - 0.04, uSpineHalfW, dxWorld);
      // 深度相对：>0 粒子在骨骼前，<0 在骨骼后
      float zRel = pWorldZ - spineWorldZ;
      float zDepthFade = 0.25 + 0.75 * smoothstep(-0.06, 0.01, zRel);
      float depthFade = mix(1.0, zDepthFade, xOcclusion);

      float effectivePulse = totalPulse * depthFade;
      alpha = aAlpha * visible * endFade * depthFade * (0.65 + effectivePulse * 0.45);
      alpha *= uFormation;  // hide vines during intro
      sz = aSize * (1.0 + effectivePulse * 0.5);

      vAlpha = alpha;
      vColorVar = aColorVar + totalPulse * 0.5;
    }

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = sz * (300.0 / -mv.z);
    gl_Position  = projectionMatrix * mv;
  }
`;

// 藤蔓配色：与骨骼互补反相 + 饱和中点（每档都有色相，不走灰）
// A 套（blend=0）：骨骼深紫时 → 藤蔓金
const VINE_A_COLOR = new THREE.Color(0x584012);  // 深金基调（压暗）
const VINE_A_HL    = new THREE.Color(0x3e3018);  // 闷金
const VINE_A_AC1   = new THREE.Color(0x8a5830);  // 暗琥珀点缀
const VINE_A_AC2   = new THREE.Color(0x4a2e08);  // 深青铜阴影
// MID 套（blend=0.5）：翠绿过渡（粉红的对比色），高光/暗部都压得更深
const VINE_MID_COLOR = new THREE.Color(0x3a6848);  // 暗翠绿（压低亮度）
const VINE_MID_HL    = new THREE.Color(0x1e3428);  // 深闷翠
const VINE_MID_AC1   = new THREE.Color(0x142820);  // 深墨翠
const VINE_MID_AC2   = new THREE.Color(0x081810);  // 近黑暗部
// B 套（blend=1）：骨骼金时 → 藤蔓花青
const VINE_B_COLOR = new THREE.Color(0x1a3854);  // 花青基调
const VINE_B_HL    = new THREE.Color(0x3a5a78);  // 沉花青高光（压低亮度）
const VINE_B_AC1   = new THREE.Color(0x10243e);  // 深夜蓝
const VINE_B_AC2   = new THREE.Color(0x244e7c);  // 中花青

// 骨骼曲线采样给 shader 做遮挡判定：
// 沿 curveCurved 均匀取 33 个点（比直接用 13 控制点插值精度更高，
// 匹配骨骼粒子实际摆位的 catmull-rom spline）。
const SPINE_SAMPLE_N = 33;
const SPINE_XS_FLAT = new Array(SPINE_SAMPLE_N);
const SPINE_YS_FLAT = new Array(SPINE_SAMPLE_N);
{
  const samples = [];
  for (let i = 0; i < SPINE_SAMPLE_N; i++) {
    samples.push(curveCurved.getPoint(i / (SPINE_SAMPLE_N - 1)));
  }
  // 按 y 从大到小（C7 顶 → S1 底）排序，跟原 13 点顺序一致
  samples.sort((a, b) => b.y - a.y);
  for (let i = 0; i < SPINE_SAMPLE_N; i++) {
    SPINE_XS_FLAT[i] = samples[i].x;
    SPINE_YS_FLAT[i] = samples[i].y;
  }
}

const vineMat = new THREE.ShaderMaterial({
  vertexShader: vineVertexShader, fragmentShader,
  uniforms: {
    uColor:     { value: VINE_A_COLOR.clone() },
    uHighlight: { value: VINE_A_HL.clone() },
    uAccent1:   { value: VINE_A_AC1.clone() },
    uAccent2:   { value: VINE_A_AC2.clone() },
    uAlphaBoost: { value: 1.0 },
    uBlend:      { value: 0.0 },
    uTime:       { value: 0.0 },
    uVineGrowth: { value: new THREE.Vector3(0, 0, 0) },
    uSpineXs:    { value: SPINE_XS_FLAT },
    uSpineYs:    { value: SPINE_YS_FLAT },
    uSpineHalfW: { value: 0.18 },
    uSpineRotY:  { value: 0.0 },
    uFormation:  { value: 0.0 },
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
const vineGrowStartTime = [-10, -10, -10];
const vineGrowProgress  = [0, 0, 0];







// ============================================================
// 9b. leafGeo (Layer F2 — Figma模板粒子叶子)
// ============================================================
// 每片叶子 = 从Figma模板采样 ~120个粒子，排成叶形
// 叶柄紧贴藤蔓，叶身摇曳
//

// ── 叶子形状数据预处理：采样模板内部点 ──
const PARTICLES_PER_LEAF = 1000;

// Poisson-disk 风格：在轮廓内用网格+随机采样
function pointInPolygon(px, py, polygon) {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    const intersect = ((yi > py) !== (yj > py))
      && (px < (xj - xi) * (py - yi) / (yj - yi + 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// 鞋带公式：闭合多边形面积（取绝对值）
function polygonArea(polygon) {
  let a = 0;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += (polygon[j][0] + polygon[i][0]) * (polygon[j][1] - polygon[i][1]);
  }
  return Math.abs(a) * 0.5;
}

// 为每个叶子模板预计算粒子偏移点（局部坐标）
function sampleLeafTemplate(shape) {
  const contour = shape.contour;
  const veins = shape.veins;
  // 轮廓边界
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of contour) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const leafHeight = maxY - minY;

  const points = [];
  // 70%填充点 + 叶脉点 + 轮廓点
  // 1. 内部填充（随机采样 + 拒绝法）
  const targetFill = Math.floor(PARTICLES_PER_LEAF * 0.65);
  let tries = 0;
  while (points.length < targetFill && tries < 5000) {
    tries++;
    const px = minX + Math.random() * (maxX - minX);
    const py = minY + Math.random() * (maxY - minY);
    if (pointInPolygon(px, py, contour)) {
      // y 归一化（0=根 1=尖）
      const yNorm = (py - minY) / leafHeight;
      points.push({ x: px, y: py, yNorm, isVein: false, isEdge: false });
    }
  }
  // 2. 叶脉点（有 veins 数据）
  if (veins && veins.length > 0) {
    const nVeins = Math.floor(PARTICLES_PER_LEAF * 0.20);
    for (let i = 0; i < nVeins; i++) {
      const v = veins[Math.floor(Math.random() * veins.length)];
      const yNorm = (v[1] - minY) / leafHeight;
      points.push({ x: v[0], y: v[1], yNorm, isVein: true, isEdge: false });
    }
  }
  // 3. 轮廓边缘点
  const nEdge = PARTICLES_PER_LEAF - points.length;
  for (let i = 0; i < nEdge; i++) {
    const c = contour[Math.floor(Math.random() * contour.length)];
    const yNorm = (c[1] - minY) / leafHeight;
    points.push({ x: c[0], y: c[1], yNorm, isVein: false, isEdge: true });
  }
  // 随机洗牌，这样 instance 取前 N 个也能拿到 fill/vein/edge 均匀混合
  for (let i = points.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [points[i], points[j]] = [points[j], points[i]];
  }
  return { points, minY, maxY, area: polygonArea(contour) };
}

const LEAF_TEMPLATES = LEAF_SHAPES.map(shape => sampleLeafTemplate(shape));

// 参考面积：3 个模板里最大的那个（用于归一化粒子数）
const LEAF_REF_AREA = Math.max(...LEAF_TEMPLATES.map(t => t.area));

// ── 叶子放置采样（沿藤蔓自然步进，不规律间距）──
const leafSources = [];

// 主藤主干段
const trunkSegs = [];
for (let si = 0; si < vineData[0].topo.length; si++) {
  if (vineData[0].topo[si].depth === 0) trunkSegs.push(si);
}
// 主干总长度
const trunkLens = trunkSegs.map(si => vineData[0].lengths[si]);
const trunkTotalLen = trunkLens.reduce((a, b) => a + b, 0);

function sampleMainTrunkAt(globalT) {
  // globalT (0~1) → 哪一段哪个t
  let accum = 0;
  for (let i = 0; i < trunkSegs.length; i++) {
    const segLen = trunkLens[i];
    const segEnd = accum + segLen;
    if (globalT * trunkTotalLen <= segEnd || i === trunkSegs.length - 1) {
      const localT = (globalT * trunkTotalLen - accum) / segLen;
      const curve = vineData[0].curves[trunkSegs[i]];
      const pt = curve.getPointAt(Math.max(0.01, Math.min(0.99, localT)));
      const tan = curve.getTangentAt(Math.max(0.01, Math.min(0.99, localT)));
      return { pt, tan };
    }
    accum = segEnd;
  }
}

// 沿藤蔓步进，随机间距 0.03~0.18
function walkVineForLeaves(vineId, sourceArr, maxLeaves) {
  let t = 0.10 + Math.random() * 0.08; // 起点延后，避开最顶端
  let placed = 0;
  let rejected = 0;
  while (t < 0.95 && placed < maxLeaves && rejected < 200) {
    let accepted = true;
    if (vineId === 0) {
      // 主藤：Z = tan.x * 0.06，tan.x 大幅负=背后，拒绝
      const { pt, tan } = sampleMainTrunkAt(t);
      if (tan.x < -0.2) {
        accepted = false;
      } else {
        sourceArr.push({
          type: 'figma',
          rawX: pt.x, rawY: pt.y,
          tanX: tan.x, tanY: tan.y,
          vineId: 0,
        });
      }
    } else {
      // 辅藤：螺旋 Z = r*cos(theta)，cos<0=背后
      const accent = ACCENT_VINES[vineId - 1];
      const theta = t * Math.PI * accent.freq * 2 + accent.phase;
      const zCos = Math.cos(theta);
      if (zCos < 0.15) {
        accepted = false;
      } else {
        const cpS = curveStraight.getPoint(t);
        const cpC = curveCurved.getPoint(t);
        const tanC = curveCurved.getTangent(t);
        const env = 0.6 + 0.4 * Math.sin(t * Math.PI);
        const r = accent.radius * env;
        const helixX = r * Math.sin(theta);
        sourceArr.push({
          type: 'accent',
          vineId,
          t,
          helixX,
          cpSY: cpS.y,
          cpCX: cpC.x, cpCY: cpC.y,
          tanCX: tanC.x, tanCY: tanC.y,
        });
      }
    }
    if (accepted) {
      placed++;
      // 不规律间距：指数分布让有簇有疏
      const gap = 0.035 + Math.pow(Math.random(), 1.5) * 0.16;
      t += gap;
    } else {
      rejected++;
      // 前进到可接受位置
      t += 0.02;
    }
  }
}

walkVineForLeaves(0, leafSources, 12); // 主藤
walkVineForLeaves(1, leafSources, 4);  // 辅藤A
walkVineForLeaves(2, leafSources, 3);  // 辅藤B

// 主藤下部大弯曲（seg 11）强制放 2 片叶子
{
  const seg11 = vineData[0].curves[11];
  if (seg11) {
    const targetTs = [0.30, 0.60];
    for (const localT of targetTs) {
      const pt = seg11.getPointAt(localT);
      const tan = seg11.getTangentAt(localT);
      leafSources.push({
        type: 'figma',
        rawX: pt.x, rawY: pt.y,
        tanX: tan.x, tanY: tan.y,
        vineId: 0,
      });
    }
  }
}

// 主藤补缺：每隔一段检查是否有叶子，没有则补
// 先把已有主藤叶子的世界位置收集起来
const existingMainLeaves = [];
for (const src of leafSources) {
  if (src.type === 'figma') {
    existingMainLeaves.push({
      sx: src.rawX * VINE_X_SCALE,
      sy: src.rawY * VINE_Y_SCALE,
    });
  } else if (src.type === 'drift') {
    existingMainLeaves.push({ sx: src.worldX, sy: src.worldY });
  }
}
// 沿主干检查，空缺处补叶
const GAP_CHECK_STEP = 0.18;
const GAP_CHECK_RADIUS_SQ = 0.45 * 0.45;
for (let checkT = 0.15; checkT < 0.88; checkT += GAP_CHECK_STEP) {
  const { pt, tan } = sampleMainTrunkAt(checkT);
  const csx = pt.x * VINE_X_SCALE;
  const csy = pt.y * VINE_Y_SCALE;
  // 拒绝大幅背面
  if (tan.x < -0.55) continue;
  // 检查附近是否已有叶子
  let found = false;
  for (const ex of existingMainLeaves) {
    const dx = ex.sx - csx, dy = ex.sy - csy;
    if (dx * dx + dy * dy < GAP_CHECK_RADIUS_SQ) {
      found = true;
      break;
    }
  }
  if (!found) {
    leafSources.push({
      type: 'figma',
      rawX: pt.x, rawY: pt.y,
      tanX: tan.x, tanY: tan.y,
      vineId: 0,
    });
    existingMainLeaves.push({ sx: csx, sy: csy });
  }
}

// 弥散分支上不放叶子（drift粒子sway相位随机，叶柄会脱离）

// 补充屏幕右侧叶子：主藤 seg 8 中段 x 明显为正（右）的位置
{
  const seg8 = vineData[0].curves[8];
  if (seg8) {
    const rightTs = [0.32, 0.42];
    for (const t of rightTs) {
      const pt = seg8.getPointAt(t);
      const tan = seg8.getTangentAt(t);
      leafSources.push({
        type: 'figma',
        rawX: pt.x, rawY: pt.y,
        tanX: tan.x, tanY: tan.y,
        vineId: 0,
      });
    }
  }
}

// 补充 seg 9 分支交叉处叶子（seg 10 起点即交叉点 [0.289,-0.619]）
{
  const seg10 = vineData[0].curves[10];
  if (seg10) {
    const junctionTs = [0.02, 0.06];
    for (const t of junctionTs) {
      const pt = seg10.getPointAt(t);
      const tan = seg10.getTangentAt(t);
      leafSources.push({
        type: 'figma',
        rawX: pt.x, rawY: pt.y,
        tanX: tan.x, tanY: tan.y,
        vineId: 0,
      });
    }
  }
}


// ── 生成叶子实例数据 ──
const leafInstances = [];
let leafGlobalIdx = 0;

// Y密度限制：同一y高度不超过3片叶子
const Y_DENSITY_WINDOW = 0.18;
const Y_DENSITY_MAX = 3;
const placedYs = [];
const placedXYs = [];

for (const src of leafSources) {
  // 计算叶柄位置（直立态 / 弯曲态）
  let stemSX, stemSY, stemCX, stemCY, tangentWorldX, tangentWorldY;
  let hostVineId = 0;
  let stemParamT = 0;

  if (src.type === 'figma') {
    // 主藤：figma路径坐标 → 世界坐标
    stemSX = src.rawX * VINE_X_SCALE;
    stemSY = src.rawY * VINE_Y_SCALE;
    const spineX = getSpineXAtY(stemSY);
    stemCX = stemSX + spineX;
    stemCY = stemSY;
    tangentWorldX = src.tanX * VINE_X_SCALE;
    tangentWorldY = src.tanY * VINE_Y_SCALE;
    stemParamT = (vineYMax - stemSY) / vineYRange;
    hostVineId = 0;
  } else if (src.type === 'drift') {
    // 弥散分支：已是世界坐标
    stemSX = src.worldX;
    stemSY = src.worldY;
    const spineX = getSpineXAtY(stemSY);
    stemCX = stemSX + spineX;
    stemCY = stemSY;
    tangentWorldX = src.tanX;
    tangentWorldY = src.tanY;
    stemParamT = Math.max(0, Math.min(1, (vineYMax - stemSY) / vineYRange));
    hostVineId = 0;
  } else {
    // 辅藤：螺旋公式
    stemSX = src.helixX;
    stemSY = src.cpSY;
    stemCX = src.cpCX + (-src.tanCY) * src.helixX;
    stemCY = src.cpCY + (src.tanCX) * src.helixX;
    tangentWorldX = src.tanCX;
    tangentWorldY = src.tanCY;
    stemParamT = (vineYMax - stemSY) / vineYRange;
    hostVineId = src.vineId;
  }

  // 朝外方向（垂直于切线，远离脊柱）
  const outX = -tangentWorldY;
  const outY = tangentWorldX;
  const outLen = Math.sqrt(outX * outX + outY * outY) || 1;
  const onx = outX / outLen;
  const ony = outY / outLen;
  // 判断"外"是左还是右：根据当前位置是否在脊柱右侧
  const sideBias = stemSX > 0 ? 1 : -1;
  const dotSign = (onx * sideBias >= 0) ? 1 : -1;
  const leafOutX = onx * dotSign;
  const leafOutY = ony * dotSign;

  // 分组：一组最多3片
  const groupRoll = Math.random();
  const groupSize = groupRoll < 0.60 ? 1 : groupRoll < 0.85 ? 2 : 3;

  for (let g = 0; g < groupSize; g++) {
    // 叶柄位置：沿切线方向微偏（簇内分散）
    const offsetAlongTangent = (g - (groupSize - 1) / 2) * 0.03;
    const sx = stemSX + tangentWorldX / outLen * offsetAlongTangent;
    const sy = stemSY + tangentWorldY / outLen * offsetAlongTangent;
    const cx = stemCX + tangentWorldX / outLen * offsetAlongTangent;
    const cy = stemCY + tangentWorldY / outLen * offsetAlongTangent;
    const sParamT = Math.max(0, Math.min(1, (vineYMax - sy) / vineYRange));

    // Y密度检查：同一y高度±0.18内已有3片，跳过
    let nearbyCount = 0;
    for (const py of placedYs) {
      if (Math.abs(py - sy) < Y_DENSITY_WINDOW) nearbyCount++;
    }
    if (nearbyCount >= Y_DENSITY_MAX) continue;

    // 全局2D距离检查：所有叶子之间距离不能小于0.32
    // 红框区域 y ∈ [0.2, 0.6] 严格到 0.55，稀释密度
    const strictRedBox = (sy >= 0.2 && sy <= 0.6);
    const minDistSq = strictRedBox ? 0.55 * 0.55 : 0.32 * 0.32;
    let tooClose = false;
    for (const [ox, oy] of placedXYs) {
      const dx = ox - sx, dy = oy - sy;
      if (dx * dx + dy * dy < minDistSq) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;
    placedXYs.push([sx, sy]);
    placedYs.push(sy);

    // 叶子朝向角度：(leafOutX, leafOutY) 是叶尖指向
    const angle = Math.atan2(leafOutY, leafOutX) - Math.PI / 2;

    // 重力感 + 朝外夹紧：永远朝远离脊柱的方向
    const side = sideBias;
    // 右侧：角度在 [-π/2, 0]（下到右水平）
    // 左侧：角度在 [-π, -π/2]（下到左水平）
    const centerWorldAngle = side > 0 ? -Math.PI * 0.28 : -Math.PI * 0.72;
    let worldTipAngle = centerWorldAngle + (Math.random() - 0.5) * Math.PI * 0.35;
    const clusterAngleOffset = (g - (groupSize - 1) / 2) * 0.20;
    worldTipAngle += clusterAngleOffset;
    // 夹紧到朝外下半象限
    if (side > 0) {
      worldTipAngle = Math.max(-Math.PI * 0.5, Math.min(-0.05, worldTipAngle));
    } else {
      worldTipAngle = Math.max(-Math.PI + 0.05, Math.min(-Math.PI * 0.5, worldTipAngle));
    }
    const finalAngle = worldTipAngle - Math.PI / 2;

    // 大小：每片都略有不同，差距明显但小叶不要过多
    const sizeMod = 0.85 + 0.3 * Math.sin(sParamT * Math.PI);
    const sizeRand = Math.pow(Math.random(), 0.85); // 略偏大
    const scale = (0.09 + sizeRand * 0.15) * sizeMod * (g === 0 ? 1.0 : 0.75);
    // 范围：最小 ~0.08, 最大 ~0.24, 差距 3x

    // 叶子宽度：非常轻微的压缩，避免变成线条
    const widthSquash = 0.88 + Math.random() * 0.12; // 0.88~1.00

    // 每片叶子独立 Z 深度
    const leafZ = (Math.random() - 0.5) * 0.18;

    // 卷曲（强烈）
    const curlStrength = (Math.random() - 0.5) * 0.55;
    // 叶片沿长度方向的整体弯折（叶尖偏向一侧）
    const bendStrength = (Math.random() - 0.5) * 0.35;

    // 色系
    const colorRoll = Math.random();
    const colorType = colorRoll < 0.40 ? 0 : colorRoll < 0.70 ? 1 : 2;

    // 模板选择
    // 模板权重：柳叶形(0) 10%，中型(1) 40%，心形(2) 50%
    const tRoll = Math.random();
    const templateIdx = tRoll < 0.10 ? 0 : tRoll < 0.50 ? 1 : 2;

    leafInstances.push({
      stemSX: sx, stemSY: sy, stemCX: cx, stemCY: cy,
      stemParamT: sParamT,
      hostVineId,
      angle: finalAngle,
      scale,
      widthSquash,
      colorType,
      leafParamT: sParamT,
      templateIdx,
      leafIdx: leafGlobalIdx++,
      leafZ,
      curlStrength,
      bendStrength,
    });

    // 叠加组合叶：30%的概率再加1-2片叠在同一位置，角度明显错开
    if (Math.random() < 0.30) {
      const extraCount = 1 + (Math.random() < 0.3 ? 1 : 0); // 大多只加1片，少数加2片
      for (let ex = 0; ex < extraCount; ex++) {
        // 角度错开 ±0.4~0.8 rad（清晰可辨是两片）
        const extraAngleOffset = (Math.random() < 0.5 ? 1 : -1) * (0.4 + Math.random() * 0.4);
        // 稍微缩小，错落有致
        const extraScale = scale * (0.70 + Math.random() * 0.25);
        // 不同模板
        const exTRoll = Math.random();
        const extraTemplate = exTRoll < 0.10 ? 0 : exTRoll < 0.50 ? 1 : 2;
        // 颜色稍微不同
        const exCRoll = Math.random();
        const extraColorType = exCRoll < 0.70 ? 0 : exCRoll < 0.85 ? 1 : 2;
        // 轻微位置偏移（0.02）让两片不完全重合
        const jx = (Math.random() - 0.5) * 0.03;
        const jy = (Math.random() - 0.5) * 0.03;

        leafInstances.push({
          stemSX: sx + jx, stemSY: sy + jy,
          stemCX: cx + jx, stemCY: cy + jy,
          stemParamT: sParamT,
          hostVineId,
          angle: finalAngle + extraAngleOffset,
          scale: extraScale,
          widthSquash: 0.88 + Math.random() * 0.12,
          colorType: extraColorType,
          leafParamT: sParamT,
          templateIdx: extraTemplate,
          leafIdx: leafGlobalIdx++,
          leafZ: (Math.random() - 0.5) * 0.18,
          curlStrength: (Math.random() - 0.5) * 0.55,
          bendStrength: (Math.random() - 0.5) * 0.35,
        });
      }
    }
  }
}

const N_LEAVES = leafInstances.length;
// 每片叶子粒子数：按"渲染世界面积 = 模板面积 × scale²"驱动，
// 保证每片叶子的粒子密度（per 单位渲染面积）一致。
// 校准：最大叶子（面积最大模板 × MAX_SCALE）保持 2600 粒子，
// 与原公式的上限持平，质感保留。
const MIN_SCALE = 0.08, MAX_SCALE = 0.24;
const LEAF_MAX_PARTICLES = 2600;
const LEAF_DENSITY = LEAF_MAX_PARTICLES / (LEAF_REF_AREA * MAX_SCALE * MAX_SCALE);
for (const leaf of leafInstances) {
  const t = LEAF_TEMPLATES[leaf.templateIdx];
  const worldArea = t.area * leaf.scale * leaf.scale;
  leaf.particleCount = Math.max(150, Math.round(LEAF_DENSITY * worldArea));
}
const N_LEAF_TOTAL = leafInstances.reduce((s, l) => s + l.particleCount, 0);

// ── 分配粒子属性数组 ──
const lfStemCurved   = new Float32Array(N_LEAF_TOTAL * 2);
const lfStemStraight = new Float32Array(N_LEAF_TOTAL * 2);
const lfLocal        = new Float32Array(N_LEAF_TOTAL * 2); // 局部坐标（已按叶角度旋转）
const lfStemInfo     = new Float32Array(N_LEAF_TOTAL * 2); // (stemParamT, hostVineId)
const lfLeafInfo     = new Float32Array(N_LEAF_TOTAL * 4); // (leafParamT, leafIdx, yNormInLeaf, leafZ)
const lfGrowGroup    = new Float32Array(N_LEAF_TOTAL);     // 0-3 组别
const lfSizes        = new Float32Array(N_LEAF_TOTAL);
const lfAlphas       = new Float32Array(N_LEAF_TOTAL);
const lfColorVars    = new Float32Array(N_LEAF_TOTAL);

let lfIdx = 0;
// 粒子大小参考：scale = MAX_SCALE 时保持当前 baseSize，小叶子等比缩小
const LEAF_SIZE_REF_SCALE = MAX_SCALE;
for (const leaf of leafInstances) {
  const template = LEAF_TEMPLATES[leaf.templateIdx];
  const cosA = Math.cos(leaf.angle);
  const sinA = Math.sin(leaf.angle);
  // 粒子大小乘数：大叶 1.0，小叶（MIN_SCALE/MAX_SCALE = 0.33）
  const sizeMult = leaf.scale / LEAF_SIZE_REF_SCALE;

  for (let p = 0; p < leaf.particleCount; p++) {
    const pt = template.points[p % template.points.length];

    // 粒子级随机抖动（大幅增加）
    const jitter = 0.08;
    const jx = (Math.random() - 0.5) * jitter;
    const jy = (Math.random() - 0.5) * jitter;

    // 卷曲：沿叶片长度方向的 x 偏移（S 弯）
    // S 弯卷曲 + 整体弯折（叶尖偏向一侧，二次方）
    const curlX = Math.sin(pt.y * 3.0) * leaf.curlStrength
                + pt.y * pt.y * leaf.bendStrength;

    // 模板坐标 + 卷曲 + 抖动，x 再乘宽度压缩（模拟倾斜）
    const lx = (pt.x * leaf.widthSquash + curlX + jx) * leaf.scale;
    const ly = (pt.y + jy) * leaf.scale;

    // 旋转到世界方向
    const wx = lx * cosA - ly * sinA;
    const wy = lx * sinA + ly * cosA;

    lfStemCurved[lfIdx * 2]     = leaf.stemCX;
    lfStemCurved[lfIdx * 2 + 1] = leaf.stemCY;
    lfStemStraight[lfIdx * 2]     = leaf.stemSX;
    lfStemStraight[lfIdx * 2 + 1] = leaf.stemSY;
    lfLocal[lfIdx * 2]     = wx;
    lfLocal[lfIdx * 2 + 1] = wy;
    lfStemInfo[lfIdx * 2]     = leaf.stemParamT;
    lfStemInfo[lfIdx * 2 + 1] = leaf.hostVineId;
    lfLeafInfo[lfIdx * 4]     = leaf.leafParamT;
    lfLeafInfo[lfIdx * 4 + 1] = leaf.leafIdx;
    lfLeafInfo[lfIdx * 4 + 2] = pt.yNorm; // 0=叶柄端, 1=叶尖端
    lfLeafInfo[lfIdx * 4 + 3] = leaf.leafZ;
    // 按 leafParamT 分 4 组：0-0.25→0, 0.25-0.5→1, 0.5-0.75→2, 0.75-1→3
    lfGrowGroup[lfIdx] = Math.min(3, Math.floor(leaf.leafParamT * 4));

    // 粒子大小：叶脉亮，边缘稍大，内部中等；整体乘 sizeMult 让小叶子等比缩小
    let baseSize;
    if (pt.isVein) baseSize = 0.028 + Math.random() * 0.008;
    else if (pt.isEdge) baseSize = 0.030 + Math.random() * 0.008;
    else baseSize = 0.022 + Math.random() * 0.010;
    lfSizes[lfIdx] = baseSize * sizeMult;

    // alpha：叶脉更亮
    lfAlphas[lfIdx] = pt.isEdge ? 0.90 + Math.random() * 0.10  // 边缘高亮描边
      : (pt.isVein ? 0.65 : 0.40) + Math.random() * 0.10;

    // 色系驱动 colorVar
    // 叶脉保持深绿（negative small），普通粒子按yNorm渐变到色系色
    const tipGrad = pt.yNorm;
    let cv;
    if (pt.isVein) {
      cv = -0.1 + (Math.random() - 0.5) * 0.1;
    } else if (leaf.colorType === 0) {
      // 绿→金：colorVar正值（→highlight）
      cv = tipGrad * 0.7 + (Math.random() - 0.5) * 0.1;
    } else if (leaf.colorType === 1) {
      // 绿→紫：colorVar负值 > -0.5（→accent1）
      cv = -tipGrad * 0.4 + (Math.random() - 0.5) * 0.08;
    } else {
      // 绿→粉：colorVar < -0.5（→accent2）
      cv = -0.55 - tipGrad * 0.4 + (Math.random() - 0.5) * 0.08;
    }
    lfColorVars[lfIdx] = cv;

    lfIdx++;
  }
}

// ── GPU geometry ──
const lfPositions3 = new Float32Array(N_LEAF_TOTAL * 3);
for (let i = 0; i < N_LEAF_TOTAL; i++) {
  lfPositions3[i * 3]     = lfStemCurved[i * 2] + lfLocal[i * 2];
  lfPositions3[i * 3 + 1] = lfStemCurved[i * 2 + 1] + lfLocal[i * 2 + 1];
  lfPositions3[i * 3 + 2] = 0;
}

const leafGeo = new THREE.BufferGeometry();
leafGeo.setAttribute('position',      new THREE.BufferAttribute(lfPositions3, 3));
leafGeo.setAttribute('aStemCurved',   new THREE.BufferAttribute(lfStemCurved, 2));
leafGeo.setAttribute('aStemStraight', new THREE.BufferAttribute(lfStemStraight, 2));
leafGeo.setAttribute('aLocal',        new THREE.BufferAttribute(lfLocal, 2));
leafGeo.setAttribute('aStemInfo',     new THREE.BufferAttribute(lfStemInfo, 2));
leafGeo.setAttribute('aLeafInfo',     new THREE.BufferAttribute(lfLeafInfo, 4));
leafGeo.setAttribute('aGrowGroup',    new THREE.BufferAttribute(lfGrowGroup, 1));
leafGeo.setAttribute('aSize',         new THREE.BufferAttribute(lfSizes, 1));
leafGeo.setAttribute('aAlpha',        new THREE.BufferAttribute(lfAlphas, 1));
leafGeo.setAttribute('aColorVar',     new THREE.BufferAttribute(lfColorVars, 1));

// ── 叶子 vertex shader ──
const leafVertexShader = /* glsl */`
  attribute vec2 aStemCurved;
  attribute vec2 aStemStraight;
  attribute vec2 aLocal;
  attribute vec2 aStemInfo;   // (stemParamT, hostVineId)
  attribute vec4 aLeafInfo;   // (leafParamT, leafIdx, yNormInLeaf, leafZ)
  attribute float aSize;
  attribute float aAlpha;
  attribute float aColorVar;

  attribute float aGrowGroup;

  uniform float uBlend;
  uniform float uTime;
  uniform vec4 uLeafGrowths; // 4 组生长进度

  varying float vAlpha;
  varying float vColorVar;

  void main() {
    float stemParamT = aStemInfo.x;
    float hostVineId = aStemInfo.y;
    float leafParamT = aLeafInfo.x;
    float leafIdx = aLeafInfo.y;
    float yInLeaf = aLeafInfo.z; // 0=叶柄, 1=叶尖

    // 1. 叶柄位置（双态插值）
    float lb = clamp((uBlend - (1.0 - stemParamT) * 0.28) / 0.72, 0.0, 1.0);
    vec2 stemPos = mix(aStemCurved, aStemStraight, lb);

    // 2. 叶柄跟随藤蔓摇曳（与对应藤蔓摇曳公式一致）
    float swayBase = 1.0 - stemParamT * 0.3;
    float vineAmp = hostVineId < 0.5 ? 1.0 : (hostVineId < 1.5 ? 1.4 : 0.7);
    float vineFreq = hostVineId < 0.5 ? 1.0 : (hostVineId < 1.5 ? 0.8 : 1.3);
    // 对齐藤蔓 shader 中 aVinePhase 的实际值
    // 主藤 pulsePhase = 0.2, 辅藤A = PI*0.35≈1.100, 辅藤B = PI*1.30≈4.084
    float vinePhase = hostVineId < 0.5 ? 0.2 : (hostVineId < 1.5 ? 1.100 : 4.084);
    float swayX = sin(uTime * 0.35 * vineFreq + stemParamT * 3.0 + vinePhase) * 0.03 * swayBase * vineAmp;
    float swayY = sin(uTime * 0.6 * vineFreq + stemParamT * 8.0 + vinePhase * 2.0) * 0.06 * swayBase * vineAmp
                + sin(uTime * 1.2 * vineFreq + stemParamT * 14.0) * 0.02 * swayBase * vineAmp;
    stemPos.x += swayX;
    stemPos.y += swayY;

    // 3. 叶身局部摇曳（加强上下飘动）
    float leafSwayAmp = yInLeaf * yInLeaf * 0.06; // 放大
    float leafPhase = leafIdx * 1.37;
    // Y 方向主导（上下飘），X 方向次之
    vec2 leafSway = vec2(
      sin(uTime * 0.8 + leafPhase) * leafSwayAmp * 0.5,
      sin(uTime * 1.3 + leafPhase * 1.6) * leafSwayAmp * 1.2
      + sin(uTime * 2.2 + leafPhase * 0.7) * leafSwayAmp * 0.4
    );

    // 4. 分组触发式生长：粒子从叶柄→叶尖逐步显现（不缩放）
    float myGrowth = aGrowGroup < 0.5 ? uLeafGrowths.x
                   : aGrowGroup < 1.5 ? uLeafGrowths.y
                   : aGrowGroup < 2.5 ? uLeafGrowths.z
                   : uLeafGrowths.w;
    float leafGrow = smoothstep(0.0, 1.0, myGrowth);

    // yInLeaf: 0=叶柄, 1=叶尖
    // 粒子在 yInLeaf < leafGrow 时显现，边缘柔化
    float reveal = smoothstep(leafGrow - 0.15, leafGrow, yInLeaf);
    float particleVisible = 1.0 - reveal; // leafGrow=1 时全部可见

    // 5. 最终位置（始终在最终位置，不缩放）
    vec2 pos2d = stemPos + aLocal + leafSway;
    vec3 pos = vec3(pos2d.x, pos2d.y, aLeafInfo.w);

    float alpha = aAlpha * particleVisible;
    float sz = aSize * step(0.01, particleVisible); // 不可见时 size=0

    vAlpha = alpha;
    vColorVar = aColorVar;

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = sz * (300.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

// ── 叶子颜色：4 色跨色相（强反差，叶子之间看起来色彩丰富）──
// A 套（blend=0）：骨骼深紫时 → 叶子金（暖色域 4 色相）
const LEAF_A_COLOR = new THREE.Color(0x8a6618);  // 金基座
const LEAF_A_HL    = new THREE.Color(0xf0d040);  // 亮黄（pop）
const LEAF_A_AC1   = new THREE.Color(0xe85020);  // 橘红
const LEAF_A_AC2   = new THREE.Color(0xd83868);  // 玫红（跳出暖色域）
// MID 套（blend=0.5）：嫩翠过渡（高饱和撞色，粉色骨骼阶段要 pop）
const LEAF_MID_COLOR = new THREE.Color(0x9ae0a8);  // 嫩翠基座
const LEAF_MID_HL    = new THREE.Color(0xf8e830);  // 亮柠黄（强 pop）
const LEAF_MID_AC1   = new THREE.Color(0xf040a0);  // 亮洋红（撞粉系的浓色）
const LEAF_MID_AC2   = new THREE.Color(0x9040f0);  // 亮紫罗兰（冷跳色）
// B 套（blend=1）：骨骼金时 → 叶子花青（冷色域 4 色相）
const LEAF_B_COLOR = new THREE.Color(0x244e7c);  // 花青基座
const LEAF_B_HL    = new THREE.Color(0x40c8e0);  // 亮青（pop）
const LEAF_B_AC1   = new THREE.Color(0x30c078);  // 翡翠
const LEAF_B_AC2   = new THREE.Color(0x7860d0);  // 紫罗兰

const leafMat = new THREE.ShaderMaterial({
  vertexShader: leafVertexShader,
  fragmentShader, // 复用藤蔓的soft-circle fragment shader
  uniforms: {
    uColor:     { value: LEAF_A_COLOR.clone() },
    uHighlight: { value: LEAF_A_HL.clone() },
    uAccent1:   { value: LEAF_A_AC1.clone() },
    uAccent2:   { value: LEAF_A_AC2.clone() },
    uAlphaBoost: { value: 1.0 },
    uBlend: { value: 0.0 },
    uTime:  { value: 0.0 },
    uLeafGrowths: { value: new THREE.Vector4(0, 0, 0, 0) },
  },
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});

// 叶子分组触发式生长：4组独立阈值
// 组 0: 顶部 (paramT 0-0.25) → blend 0.22
// 组 1: 上中 (paramT 0.25-0.5) → blend 0.30
// 组 2: 下中 (paramT 0.5-0.75) → blend 0.38
// 组 3: 底部 (paramT 0.75-1.0) → blend 0.46
const LEAF_GROW_THRESHOLDS = [0.22, 0.30, 0.38, 0.46];
const LEAF_GROW_DURATION = 2.0; // 每组 2 秒长完
const leafGrowTriggered = [false, false, false, false];
const leafGrowStartTime = [-10, -10, -10, -10];
const leafGrowProgress = [0, 0, 0, 0];

const leafPoints = new THREE.Points(leafGeo, leafMat);
leafPoints.frustumCulled = false;
spineGroup.add(leafPoints);



// ============================================================
// 9b. 花朵粒子系统（3D morphing 绽放，侧面朝向）
// ============================================================

// ── 花朵宿主选择：从 leafInstances 中挑 25% 大叶 ──
const flowerInstances = [];
const sortedLeaves = leafInstances
  .map((l, i) => ({ ...l, _origIdx: i }))
  .sort((a, b) => b.scale - a.scale);

// 数量增加到 40%
const N_FLOWER_TARGET = Math.max(12, Math.round(leafInstances.length * 0.40));
const flowerPlacedXYs = [];
let flowerPlaced = 0;
for (let i = 0; i < sortedLeaves.length && flowerPlaced < N_FLOWER_TARGET; i++) {
  const host = sortedLeaves[i];

  if (Math.abs(host.stemSX) < 0.12) continue;

  let tooClose = false;
  for (const [ox, oy] of flowerPlacedXYs) {
    const dx = ox - host.stemSX, dy = oy - host.stemSY;
    if (dx * dx + dy * dy < 0.08 * 0.08) { tooClose = true; break; }
  }
  if (tooClose) continue;
  flowerPlacedXYs.push([host.stemSX, host.stemSY]);
  flowerPlaced++;

  // 平均大小调大，差异仍保留
  const sizeRand = 0.7 + Math.random() * 0.6; // 0.7~1.3
  const scale = (0.14 + host.scale * 0.40) * sizeRand;

  // 花朝外（远离脊柱）
  const isRight = host.stemSX > 0;
  const outwardAngle = isRight
    ? (40 + Math.random() * 35) * Math.PI / 180
    : (105 + Math.random() * 35) * Math.PI / 180;
  const flowerAngle = outwardAngle;

  // 倾斜 18~28°
  const tiltX = (18 + Math.random() * 10) * Math.PI / 180;

  // Z 深度：推到藤蔓前面，避免重叠被切割
  const flowerZ = 0.15 + Math.random() * 0.08;

  const flowerSeed = 100 + i * 7;
  const groupIdx = Math.min(3, Math.floor(i / Math.ceil(N_FLOWER_TARGET / 4)));
  const colorType = Math.floor(Math.random() * 3);

  flowerInstances.push({
    hostLeaf: host, scale, angle: flowerAngle,
    tiltX, flowerZ,
    seed: flowerSeed, growGroup: groupIdx, colorType,
  });
}

// ── 生成花朵粒子 ──
const FLOWER_PARTICLES_PER = 900;
for (const fl of flowerInstances) {
  fl.template = generateFlowerTemplate(FLOWER_PARTICLES_PER, fl.seed);
  fl.particleCount = fl.template.length;
}
const N_FLOWER_TOTAL = flowerInstances.reduce((s, f) => s + f.particleCount, 0);

// ── 属性数组（只用 bloomPos，不需要 bud/half）──
const flBloomPos     = new Float32Array(N_FLOWER_TOTAL * 3);
const flStemCurved   = new Float32Array(N_FLOWER_TOTAL * 2);
const flStemStraight = new Float32Array(N_FLOWER_TOTAL * 2);
const flStemInfo     = new Float32Array(N_FLOWER_TOTAL * 2);
const flGrowGroup    = new Float32Array(N_FLOWER_TOTAL);
const flPetalIdx     = new Float32Array(N_FLOWER_TOTAL);
const flDistFromCenter = new Float32Array(N_FLOWER_TOTAL);
const flSizes        = new Float32Array(N_FLOWER_TOTAL);
const flAlphas       = new Float32Array(N_FLOWER_TOTAL);
const flColorVars    = new Float32Array(N_FLOWER_TOTAL);

let flIdx = 0;
for (const fl of flowerInstances) {
  const host = fl.hostLeaf;

  // 花朵中心 = 叶柄 + 向上偏移 0.04（在叶子上方，从叶腋长出）
  const upOffset = 0.04 + Math.random() * 0.02;
  const flCX = host.stemCX;
  const flCY = host.stemCY + upOffset;
  const flSX = host.stemSX;
  const flSY = host.stemSY + upOffset;

  // 3D 旋转：先 X 轴倾斜（花碗口朝外），再 Z 轴旋转到叶片方向
  const cosA = Math.cos(fl.angle), sinA = Math.sin(fl.angle);
  const cosT = Math.cos(fl.tiltX), sinT = Math.sin(fl.tiltX);

  function transform3D(pos3) {
    let x = pos3[0] * fl.scale;
    let y = pos3[1] * fl.scale;
    let z = pos3[2] * fl.scale;
    // 1. 绕 X 轴倾斜（花碗口朝外，跟叶片面方向一致）
    const ry = y * cosT - z * sinT;
    const rz = y * sinT + z * cosT;
    // 2. 绕 Z 轴旋转到叶片展开方向
    const fx = x * cosA - ry * sinA;
    const fy = x * sinA + ry * cosA;
    return [fx, fy, rz];
  }

  for (let p = 0; p < fl.particleCount; p++) {
    const pt = fl.template[p];
    const bloom = transform3D(pt.bloomPos);

    const i3 = flIdx * 3;
    flBloomPos[i3] = bloom[0]; flBloomPos[i3+1] = bloom[1]; flBloomPos[i3+2] = bloom[2] + fl.flowerZ;

    flStemCurved[flIdx * 2] = flCX;     flStemCurved[flIdx * 2 + 1] = flCY;
    flStemStraight[flIdx * 2] = flSX;   flStemStraight[flIdx * 2 + 1] = flSY;
    flStemInfo[flIdx * 2] = host.stemParamT;
    flStemInfo[flIdx * 2 + 1] = host.hostVineId;
    flGrowGroup[flIdx] = fl.growGroup;
    flPetalIdx[flIdx] = pt.petalIndex;
    // 粒子离花心的归一化距离（用于瓣内渐进显现）
    const dist = Math.sqrt(pt.bloomPos[0] * pt.bloomPos[0] + pt.bloomPos[1] * pt.bloomPos[1]);
    flDistFromCenter[flIdx] = Math.min(1, dist / 0.52);

    const isStamen = pt.petalIndex === 5;
    const isEdge = pt.isEdge;
    const baseSize = isStamen ? 0.016 + Math.random() * 0.005
      : isEdge ? 0.015 + Math.random() * 0.004  // 描边稍大更连续
      : 0.017 + Math.random() * 0.005;
    flSizes[flIdx] = baseSize * (fl.scale / 0.08);

    // additive blending 下用亮描边（发光轮廓） + 中等填充
    const layerAlpha = isStamen ? 0.90
      : isEdge ? 0.75 + Math.random() * 0.15  // 描边亮（发光轮廓线）
      : pt.petalIndex < 2 ? 0.35 + Math.random() * 0.10
      : pt.petalIndex < 4 ? 0.40 + Math.random() * 0.10
      : 0.50 + Math.random() * 0.10;
    flAlphas[flIdx] = layerAlpha;

    // 颜色：描边用深色(base)，填充瓣内渐变+撞色
    const distNorm = flDistFromCenter[flIdx];
    let cv;
    if (isStamen) {
      cv = 0.85 + Math.random() * 0.15;
    } else if (isEdge) {
      // 描边：暖金 + 淡粉交替（两种轮廓色）
      cv = (pt.petalIndex % 2 === 0)
        ? 0.60 + Math.random() * 0.15   // 偶数瓣暖金描边
        : -(0.10 + Math.random() * 0.10); // 奇数瓣淡粉描边
    } else {
      // 统一暖白，根→尖微渐变，瓣间只有细微色温差
      cv = distNorm * 0.35 + (Math.random() - 0.5) * 0.10;
    }
    flColorVars[flIdx] = cv;
    flIdx++;
  }
}

// ── GPU geometry ──
const flPositions3 = new Float32Array(N_FLOWER_TOTAL * 3);
for (let i = 0; i < N_FLOWER_TOTAL; i++) {
  flPositions3[i * 3]     = flStemCurved[i * 2] + flBloomPos[i * 3];
  flPositions3[i * 3 + 1] = flStemCurved[i * 2 + 1] + flBloomPos[i * 3 + 1];
  flPositions3[i * 3 + 2] = flBloomPos[i * 3 + 2];
}

const flowerGeo = new THREE.BufferGeometry();
flowerGeo.setAttribute('position',       new THREE.BufferAttribute(flPositions3, 3));
flowerGeo.setAttribute('aBloomPos',      new THREE.BufferAttribute(flBloomPos, 3));
flowerGeo.setAttribute('aStemCurved',    new THREE.BufferAttribute(flStemCurved, 2));
flowerGeo.setAttribute('aStemStraight',  new THREE.BufferAttribute(flStemStraight, 2));
flowerGeo.setAttribute('aStemInfo',      new THREE.BufferAttribute(flStemInfo, 2));
flowerGeo.setAttribute('aGrowGroup',     new THREE.BufferAttribute(flGrowGroup, 1));
flowerGeo.setAttribute('aPetalIdx',      new THREE.BufferAttribute(flPetalIdx, 1));
flowerGeo.setAttribute('aDistFromCenter',new THREE.BufferAttribute(flDistFromCenter, 1));
flowerGeo.setAttribute('aSize',          new THREE.BufferAttribute(flSizes, 1));
flowerGeo.setAttribute('aAlpha',         new THREE.BufferAttribute(flAlphas, 1));
flowerGeo.setAttribute('aColorVar',      new THREE.BufferAttribute(flColorVars, 1));

// ── 花朵 vertex shader（花瓣逐片显现，直接全开态）──
const flowerVertexShader = /* glsl */`
  attribute vec3 aBloomPos;
  attribute vec2 aStemCurved;
  attribute vec2 aStemStraight;
  attribute vec2 aStemInfo;
  attribute float aGrowGroup;
  attribute float aPetalIdx;      // 0~4 花瓣, 5 花蕊
  attribute float aDistFromCenter; // 0=花心, 1=花瓣尖端
  attribute float aSize;
  attribute float aAlpha;
  attribute float aColorVar;

  uniform float uBlend;
  uniform float uTime;
  uniform vec4 uFlowerGrowths;

  varying float vAlpha;
  varying float vColorVar;

  void main() {
    float stemParamT = aStemInfo.x;
    float hostVineId = aStemInfo.y;

    // 1. 花朵中心（双态插值）
    float lb = clamp((uBlend - (1.0 - stemParamT) * 0.28) / 0.72, 0.0, 1.0);
    vec2 stemPos = mix(aStemCurved, aStemStraight, lb);

    // 2. 摇曳
    float swayBase = 1.0 - stemParamT * 0.3;
    float vineAmp = hostVineId < 0.5 ? 1.0 : (hostVineId < 1.5 ? 1.4 : 0.7);
    float vineFreq = hostVineId < 0.5 ? 1.0 : (hostVineId < 1.5 ? 0.8 : 1.3);
    float vinePhase = hostVineId < 0.5 ? 0.2 : (hostVineId < 1.5 ? 1.100 : 4.084);
    stemPos.x += sin(uTime * 0.35 * vineFreq + stemParamT * 3.0 + vinePhase) * 0.025 * swayBase * vineAmp;
    stemPos.y += sin(uTime * 0.6 * vineFreq + stemParamT * 8.0 + vinePhase * 2.0) * 0.05 * swayBase * vineAmp;

    // 3. 生长进度
    float myGrowth = aGrowGroup < 0.5 ? uFlowerGrowths.x
                   : aGrowGroup < 1.5 ? uFlowerGrowths.y
                   : aGrowGroup < 2.5 ? uFlowerGrowths.z
                   : uFlowerGrowths.w;
    float growEase = smoothstep(0.0, 1.0, myGrowth);

    // 4. 花瓣逐片显现：花蕊先出，然后瓣0→瓣4依次
    // 花蕊(idx=5)占 0.00~0.12，每瓣占 ~0.17 的窗口，有重叠
    float petalStart = aPetalIdx > 4.5
      ? 0.0                              // 花蕊最先
      : 0.08 + aPetalIdx * 0.16;         // 瓣0: 0.08, 瓣1: 0.24, ... 瓣4: 0.72
    float petalEnd = petalStart + 0.25;   // 每瓣 0.25 宽度渐入
    float petalReveal = smoothstep(petalStart, petalEnd, growEase);

    // 瓣内从花心向外渐进（类似叶子的渗透效果）
    float innerReveal = smoothstep(petalReveal - 0.15, petalReveal, aDistFromCenter);
    float particleVisible = petalReveal * (1.0 - innerReveal);

    // 5. 最终位置（始终在全开位置）
    vec3 pos = vec3(stemPos.x + aBloomPos.x,
                    stemPos.y + aBloomPos.y,
                    aBloomPos.z);

    float alpha = aAlpha * particleVisible;
    float sz = aSize * step(0.01, particleVisible);
    vAlpha = alpha;
    vColorVar = aColorVar;

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = sz * (300.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

// ── 花朵颜色：暖白带微色，三套统一 ──
const FLOWER_A_COLOR = new THREE.Color(0xd8c8b8);  // 暖白
const FLOWER_A_HL    = new THREE.Color(0xf0e8d8);  // 亮暖白
const FLOWER_A_AC1   = new THREE.Color(0xe0c8b0);  // 微暖粉
const FLOWER_A_AC2   = new THREE.Color(0xc8b8b0);  // 微灰暖

const FLOWER_MID_COLOR = new THREE.Color(0xd8c8b8);
const FLOWER_MID_HL    = new THREE.Color(0xf0e8d0);
const FLOWER_MID_AC1   = new THREE.Color(0xdcc0a8);
const FLOWER_MID_AC2   = new THREE.Color(0xc8b8b0);

const FLOWER_B_COLOR = new THREE.Color(0xd0c4b8);
const FLOWER_B_HL    = new THREE.Color(0xf0e8d0);
const FLOWER_B_AC1   = new THREE.Color(0xd8c0a8);
const FLOWER_B_AC2   = new THREE.Color(0xc0b4b0);

const flowerMat = new THREE.ShaderMaterial({
  vertexShader: flowerVertexShader,
  fragmentShader,
  uniforms: {
    uColor:     { value: FLOWER_A_COLOR.clone() },
    uHighlight: { value: FLOWER_A_HL.clone() },
    uAccent1:   { value: FLOWER_A_AC1.clone() },
    uAccent2:   { value: FLOWER_A_AC2.clone() },
    uAlphaBoost: { value: 1.5 },
    uBlend: { value: 0.0 },
    uTime:  { value: 0.0 },
    uFlowerGrowths: { value: new THREE.Vector4(0, 0, 0, 0) },
  },
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});

// 花朵显现（叶子长完后，花瓣逐片出现）
const FLOWER_GROW_THRESHOLDS = [0.40, 0.48, 0.56, 0.65];
const FLOWER_GROW_DURATION = 3.5;
const flowerGrowTriggered = [false, false, false, false];
const flowerGrowStartTime = [-10, -10, -10, -10];
const flowerGrowProgress = [0, 0, 0, 0];

const flowerPoints = new THREE.Points(flowerGeo, flowerMat);
flowerPoints.frustumCulled = false;
spineGroup.add(flowerPoints);


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
    uColor:      { value: new THREE.Color(0x18102e) },
    uHighlight:  { value: new THREE.Color(0x18102e) },
    uAccent1:    { value: new THREE.Color(0x18102e) },
    uAccent2:    { value: new THREE.Color(0x18102e) },
    uAlphaBoost: { value: 1.0 },
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
composer.setPixelRatio(3.0);  // 锁定高清模式
composer.addPass(new RenderPass(scene, camera));

// 锁定高清模式下的 alpha 补偿：boost = pow(3.0/1.5, 2) = 4.0
{
  const lockedBoost = Math.pow(3.0 / 1.5, 2.0);
  spineMat  .uniforms.uAlphaBoost.value = lockedBoost;
  diffuseMat.uniforms.uAlphaBoost.value = lockedBoost;
  vineMat   .uniforms.uAlphaBoost.value = lockedBoost;
  leafMat   .uniforms.uAlphaBoost.value = lockedBoost;
  ambMat    .uniforms.uAlphaBoost.value = lockedBoost;
}

// Bloom 用半分辨率渲染（性能关键优化）
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 2)),
  0.15,  // strength
  0.15,  // radius
  0.45   // threshold
);
composer.addPass(bloomPass);

// 锁定高清模式下的 alpha 补偿：boost = pow(3.0/1.5, 2) = 4.0
{
  const lockedBoost = Math.pow(3.0 / 1.5, 2.0);
  spineMat  .uniforms.uAlphaBoost.value = lockedBoost;
  diffuseMat.uniforms.uAlphaBoost.value = lockedBoost;
  vineMat   .uniforms.uAlphaBoost.value = lockedBoost;
  ambMat    .uniforms.uAlphaBoost.value = lockedBoost;
}


// ============================================================
// 11. 状态 / blend 控制 + 引导动画状态
// ============================================================

let currentMode   = 'IDLE';   // IDLE → GUIDE → EXPERIENCE
let targetBlend   = 0.0;
let smoothBlend   = 0.0;
let blendVelocity = 0.0;
const WAVE = 0.28;

// ── 引导动画状态 ──
let guideStartTime = 0;       // 引导开始的绝对时间(秒)
let guideElapsed   = 0;       // 引导已经过的秒数
let guideSpeed     = 3.0;     // 引导速度倍率（默认 3x 快进）
let guideManualProgress = -1; // 手动进度（-1 = 自动）

// 把胸椎/腰椎峰值 3D 点传给 overlays 用于屏幕投影
const THORACIC_PEAK_WORLD = SPINE_CURVED[4].clone();   // 最右凸
const LUMBAR_PEAK_WORLD   = SPINE_CURVED[9].clone();   // 最左凸

const overlays = new IntroOverlays({
  camera,
  spineGroup,
  anchors: {
    thoracic: THORACIC_PEAK_WORLD,
    lumbar:   LUMBAR_PEAK_WORLD,
  },
});


// ============================================================
// 11b. 引导动画控制函数
// ============================================================

function startGuide() {
  if (currentMode !== 'IDLE') return;
  currentMode = 'GUIDE';
  guideStartTime = performance.now() / 1000;
  overlays.hideIdleUI();
  updateDebugUI();
  console.log('[raina] 60s 认知引导开始');
}

function enterExperience() {
  currentMode = 'EXPERIENCE';
  overlays.clearAll();
  // 确保 formation = 1, guideAlpha = 1
  spineMat.uniforms.uFormation.value  = 1.0;
  spineMat.uniforms.uGuideAlpha.value = 1.0;
  vineMat.uniforms.uFormation.value   = 1.0;
  updateDebugUI();
  console.log('[raina] 呼吸体验阶段开始');
}

function resetToIdle() {
  currentMode = 'IDLE';
  targetBlend   = 0.0;
  smoothBlend   = 0.0;
  blendVelocity = 0.0;
  spineMat.uniforms.uFormation.value  = 0.0;
  spineMat.uniforms.uGuideAlpha.value = 1.0;
  vineMat.uniforms.uFormation.value   = 0.0;

  // 重置藤蔓
  for (let v = 0; v < N_VINES; v++) {
    vineGrowTriggered[v] = false;
    vineGrowProgress[v] = 0;
    vineGrowStartTime[v] = -10;
  }
  vineMat.uniforms.uVineGrowth.value.set(0, 0, 0);

  // 重置叶子
  for (let g = 0; g < 4; g++) {
    leafGrowTriggered[g] = false;
    leafGrowProgress[g] = 0;
    leafGrowStartTime[g] = -10;
  }
  leafMat.uniforms.uLeafGrowths.value.set(0, 0, 0, 0);

  // 重置花朵
  for (let g = 0; g < 4; g++) {
    flowerGrowTriggered[g] = false;
    flowerGrowProgress[g] = 0;
    flowerGrowStartTime[g] = -10;
  }
  flowerMat.uniforms.uFlowerGrowths.value.set(0, 0, 0, 0);

  overlays.showIdleUI();
  updateDebugUI();
}


// ============================================================
// 12. 动画主循环
// ============================================================

let time = 0;
let fpsFrames = 0, fpsLast = performance.now();
const debugFps = document.getElementById('debug-fps');
const debugParticles = document.getElementById('debug-particles');
// 统计总粒子数
const totalParticleCount = N_SPINE + N_DFULL + N_AMB + N_VINE_TOTAL + N_LEAF_TOTAL + N_FLOWER_TOTAL;
if (debugParticles) debugParticles.textContent = totalParticleCount.toLocaleString();

function animate() {
  requestAnimationFrame(animate);
  time += 0.016;

  // FPS
  fpsFrames++;
  const now = performance.now();
  if (now - fpsLast >= 1000) {
    if (debugFps) debugFps.textContent = fpsFrames;
    fpsFrames = 0;
    fpsLast = now;
  }

  // ── 分模式更新 ──
  switch (currentMode) {
    case 'IDLE':       updateIdle(time);       break;
    case 'GUIDE':      updateGuide(time);      break;
    case 'EXPERIENCE': updateExperience(time); break;
  }

  // ── 公共：环境星尘始终更新 ──
  const ap = ambGeo.attributes.position.array;
  for (let i = 0; i < N_AMB; i++) {
    ap[i*3]   = ambBase[i*3]   + Math.cos(time * ambOrbitSpd[i]       + ambOrbitPh[i]) * ambOrbitR[i];
    ap[i*3+1] = ambBase[i*3+1] + Math.sin(time * ambOrbitSpd[i] * 0.7 + ambOrbitPh[i]) * ambOrbitR[i];
  }
  ambGeo.attributes.position.needsUpdate = true;

  if (debugBlend) debugBlend.textContent = smoothBlend.toFixed(3);
  composer.render();
}

// ── IDLE 更新 ──────────────────────────────────────────────
function updateIdle(t) {
  spineMat.uniforms.uFormation.value  = 0.0;
  spineMat.uniforms.uGuideAlpha.value = 1.0;
  spineMat.uniforms.uBlend.value      = 0.0;
  spineMat.uniforms.uBreatheExpand.value = 1.0;
  spineMat.uniforms.uBreathe.value    = 0.0;
  spineMat.uniforms.uTime.value       = t;
  spineMat.uniforms.uSegmentHighlight.value = 0.0;
  comparisonMat.opacity = 0;
  vineMat.uniforms.uFormation.value   = 0.0;
  vineMat.uniforms.uTime.value        = t;

  // IDLE 不旋转，粒子纯漂浮
  spineGroup.rotation.y = 0;

  // 颜色：固定在暗蓝紫
  spineMat.uniforms.uColor.value.copy(COLOR_DARK);
  spineMat.uniforms.uHighlight.value.copy(HL_DARK);
  spineMat.uniforms.uAccent1.value.copy(AC1_DARK);
  spineMat.uniforms.uAccent2.value.copy(AC2_DARK);

  bloomPass.strength = 0.08;
}

// ── GUIDE 更新（60s 认知引导时间线）─────────────────────────
function updateGuide(t) {
  // 手动进度优先，否则用速度倍率
  if (guideManualProgress >= 0) {
    guideElapsed = guideManualProgress;
  } else {
    guideElapsed = (performance.now() / 1000 - guideStartTime) * guideSpeed;
  }

  // 检查结束（86s 完整引导）
  if (guideElapsed >= 86) {
    enterExperience();
    return;
  }

  // 更新叠加层
  overlays.updateGuide(guideElapsed);

  // 脊柱旋转：病理解释段 (26-40s) 冻结，其余阶段正常摆动
  const inPathology = (guideElapsed >= 26 && guideElapsed < 40);
  if (!branchEditMode) {
    const rotTarget = inPathology ? 0 : Math.sin(t * 0.52) * 0.35;
    // 平滑过渡避免跳变
    spineGroup.rotation.y += (rotTarget - spineGroup.rotation.y) * 0.08;
  }

  // 时间总是同步
  spineMat.uniforms.uTime.value = t;
  vineMat.uniforms.uTime.value  = t;

  // blend 在引导期间保持0
  spineMat.uniforms.uBlend.value = 0.0;

  // 颜色：固定在暗蓝紫（blend=0 的颜色）
  spineMat.uniforms.uColor.value.copy(COLOR_DARK);
  spineMat.uniforms.uHighlight.value.copy(HL_DARK);
  spineMat.uniforms.uAccent1.value.copy(AC1_DARK);
  spineMat.uniforms.uAccent2.value.copy(AC2_DARK);
  diffuseMat.uniforms.uColor.value.copy(COLOR_DARK);
  diffuseMat.uniforms.uHighlight.value.copy(HL_DARK);
  diffuseMat.uniforms.uAccent1.value.copy(AC1_DARK);
  diffuseMat.uniforms.uAccent2.value.copy(AC2_DARK);

  // 藤蔓始终隐藏
  vineMat.uniforms.uFormation.value = 0.0;

  const e = guideElapsed;

  // 默认重置段相关 uniform
  spineMat.uniforms.uBreatheExpand.value = 1.0;

  if (e < 3) {
    // ─── 0-3s：粒子快速凝聚成脊柱 ───
    const formation = e / 3;
    spineMat.uniforms.uFormation.value        = formation;
    spineMat.uniforms.uGuideAlpha.value       = 1.0;
    spineMat.uniforms.uBreathe.value          = 0.0;
    spineMat.uniforms.uSegmentHighlight.value = 0.0;
    comparisonMat.opacity = 0;
    bloomPass.strength = 0.08 + formation * 0.08;

  } else if (e < 26) {
    // ─── 3-26s：情感叙事段，脊柱正常展示 ───
    const pulse = smoothstep(0, 1, (e - 4) / 3) * 0.35;
    spineMat.uniforms.uFormation.value        = 1.0;
    spineMat.uniforms.uGuideAlpha.value       = 1.0;
    spineMat.uniforms.uBreathe.value          = pulse;
    spineMat.uniforms.uSegmentHighlight.value = 0.0;
    comparisonMat.opacity = 0;
    bloomPass.strength = 0.16;

  } else if (e < 40) {
    // ─── 26-40s：病理解释（胸椎橙 / 腰椎青高亮 + 正常脊柱对比线）───
    // 段高亮在 26-28s 内淡入，38-40s 淡出
    let segHL = 1.0;
    if (e < 28) segHL = (e - 26) / 2;
    else if (e > 38) segHL = (40 - e) / 2;
    // 对比线在 28-32s 淡入，36-40s 淡出
    let lineOp = 0;
    if (e >= 28 && e < 32) lineOp = ((e - 28) / 4) * 0.45;
    else if (e >= 32 && e < 36) lineOp = 0.45;
    else if (e >= 36 && e < 40) lineOp = (1 - (e - 36) / 4) * 0.45;

    spineMat.uniforms.uFormation.value        = 1.0;
    spineMat.uniforms.uGuideAlpha.value       = 1.0;
    spineMat.uniforms.uBreathe.value          = 0.35;
    spineMat.uniforms.uSegmentHighlight.value = segHL;
    comparisonMat.opacity = lineOp;
    bloomPass.strength = 0.18;

  } else if (e < 44) {
    // ─── 40-44s：脊柱淡出，准备进入教学 ───
    const segT = (e - 40) / 4;
    const guideAlpha = Math.max(0, 1 - segT * 1.2);
    spineMat.uniforms.uFormation.value        = 1.0;
    spineMat.uniforms.uGuideAlpha.value       = guideAlpha;
    spineMat.uniforms.uBreathe.value          = 0.35 * guideAlpha;
    spineMat.uniforms.uSegmentHighlight.value = 0.0;
    comparisonMat.opacity = 0;
    bloomPass.strength = 0.18 * guideAlpha + 0.04;

  } else if (e < 76) {
    // ─── 44-76s：人体轮廓教学段 + 呼吸节拍器（脊柱隐藏）───
    spineMat.uniforms.uFormation.value        = 1.0;
    spineMat.uniforms.uGuideAlpha.value       = 0.0;
    spineMat.uniforms.uBreathe.value          = 0.0;
    spineMat.uniforms.uSegmentHighlight.value = 0.0;
    comparisonMat.opacity = 0;
    bloomPass.strength = 0.04;

  } else {
    // ─── 76-86s："现在换你试试" + 3-2-1-开始 → 过渡 ───
    const segT = (e - 76) / 10;
    const guideAlpha = Math.min(1, segT * 3.0);
    const breathe = guideAlpha * breatheCurve(t) * 0.5;

    spineMat.uniforms.uFormation.value        = 1.0;
    spineMat.uniforms.uGuideAlpha.value       = guideAlpha;
    spineMat.uniforms.uBreathe.value          = breathe;
    spineMat.uniforms.uBreatheExpand.value    = 1 + breathe * 0.1;
    spineMat.uniforms.uSegmentHighlight.value = 0.0;
    comparisonMat.opacity = 0;
    bloomPass.strength = 0.04 + guideAlpha * 0.14;
  }
}

// ── EXPERIENCE 更新（原有呼吸体验逻辑）──────────────────────
function updateExperience(t) {
  // 弹簧物理平滑 blend
  const springF = (targetBlend - smoothBlend) * 0.035;
  blendVelocity = blendVelocity * 0.82 + springF;
  smoothBlend   = Math.max(0, Math.min(1, smoothBlend + blendVelocity));

  const breathe       = breatheCurve(t);
  // 呼吸脉动随 blend 微增（不夸张）
  const expandAmt = 0.15 + smoothBlend * 0.10; // 0.15→0.25
  const breatheExpand = 1 + breathe * expandAmt;

  if (!branchEditMode) spineGroup.rotation.y = Math.sin(t * 0.52) * 0.35;

  // 呼吸镜头感：相机随呼吸微微前后移动
  const camBreathZ = 5.0 + breathe * smoothBlend * 0.12; // blend高时吸气靠近
  camera.position.z = camBreathZ;

  // Layer A + B
  spineMat.uniforms.uFormation.value        = 1.0;
  spineMat.uniforms.uGuideAlpha.value       = 1.0;
  spineMat.uniforms.uSegmentHighlight.value = 0.0;
  spineMat.uniforms.uBlend.value            = smoothBlend;
  spineMat.uniforms.uBreatheExpand.value    = breatheExpand;
  spineMat.uniforms.uBreathe.value          = breathe;
  spineMat.uniforms.uTime.value             = t;

  // 颜色同步（基色 + 高光 + 两种对比色 都跟随 blend）
  // colorBlend: 两端不对称"停留"的重映射 blend，用于颜色。
  // 紫色停留 0~0.3（30%），过渡 0.3~0.9（60%），金色只停留 0.9~1（10%）。
  const colorBlend = remapDwellAsym(smoothBlend, 0.3, 0.1);
  const blendColor = getBlendColor(colorBlend);
  const hlColor    = getHighlightColor(colorBlend);
  const ac1Color   = getAccent1Color(colorBlend);
  const ac2Color   = getAccent2Color(colorBlend);
  spineMat.uniforms.uColor.value.copy(blendColor);
  spineMat.uniforms.uHighlight.value.copy(hlColor);
  spineMat.uniforms.uAccent1.value.copy(ac1Color);
  spineMat.uniforms.uAccent2.value.copy(ac2Color);
  diffuseMat.uniforms.uColor.value.copy(blendColor);
  diffuseMat.uniforms.uHighlight.value.copy(hlColor);
  diffuseMat.uniforms.uAccent1.value.copy(ac1Color);
  diffuseMat.uniforms.uAccent2.value.copy(ac2Color);

  // 藤蔓
  vineMat.uniforms.uFormation.value = 1.0;
  for (let v = 0; v < N_VINES; v++) {
    if (!vineGrowTriggered[v] && smoothBlend >= VINE_GROW_THRESHOLDS[v]) {
      vineGrowTriggered[v] = true;
      vineGrowStartTime[v] = t;
    }
    if (vineGrowTriggered[v] && smoothBlend < VINE_GROW_THRESHOLDS[v] - 0.03) {
      vineGrowTriggered[v] = false;
      vineGrowStartTime[v] = t - (1.0 - vineGrowProgress[v]) * VINE_GROW_DURATION;
    }
    if (vineGrowTriggered[v]) {
      vineGrowProgress[v] = Math.min(1.0, (t - vineGrowStartTime[v]) / VINE_GROW_DURATION);
    } else {
      vineGrowProgress[v] = Math.max(0.0, 1.0 - (t - vineGrowStartTime[v]) / VINE_GROW_DURATION);
    }
  }
  vineMat.uniforms.uVineGrowth.value.set(vineGrowProgress[0], vineGrowProgress[1], vineGrowProgress[2]);
  vineMat.uniforms.uBlend.value = smoothBlend;
  vineMat.uniforms.uTime.value  = t;
  vineMat.uniforms.uSpineRotY.value = spineGroup.rotation.y;
  // 藤蔓配色跟随 colorBlend（同骨骼），中点用翠绿（粉红的对比色）保饱和度
  lerpMid(vineMat.uniforms.uColor    .value, VINE_A_COLOR, VINE_MID_COLOR, VINE_B_COLOR, colorBlend);
  lerpMid(vineMat.uniforms.uHighlight.value, VINE_A_HL,    VINE_MID_HL,    VINE_B_HL,    colorBlend);
  lerpMid(vineMat.uniforms.uAccent1  .value, VINE_A_AC1,   VINE_MID_AC1,   VINE_B_AC1,   colorBlend);
  lerpMid(vineMat.uniforms.uAccent2  .value, VINE_A_AC2,   VINE_MID_AC2,   VINE_B_AC2,   colorBlend);

  // 叶子 uniforms
  // 叶子分组触发式生长（4组独立动画）
  for (let g = 0; g < 4; g++) {
    if (!leafGrowTriggered[g] && smoothBlend >= LEAF_GROW_THRESHOLDS[g]) {
      leafGrowTriggered[g] = true;
      leafGrowStartTime[g] = t;
    }
    if (leafGrowTriggered[g] && smoothBlend < LEAF_GROW_THRESHOLDS[g] - 0.05) {
      leafGrowTriggered[g] = false;
      leafGrowStartTime[g] = t - (1.0 - leafGrowProgress[g]) * LEAF_GROW_DURATION;
    }
    if (leafGrowTriggered[g]) {
      leafGrowProgress[g] = Math.min(1.0, (t - leafGrowStartTime[g]) / LEAF_GROW_DURATION);
    } else {
      const elapsed = t - leafGrowStartTime[g];
      leafGrowProgress[g] = Math.max(0.0, 1.0 - elapsed / LEAF_GROW_DURATION);
    }
  }
  leafMat.uniforms.uLeafGrowths.value.set(
    leafGrowProgress[0], leafGrowProgress[1], leafGrowProgress[2], leafGrowProgress[3]
  );
  leafMat.uniforms.uBlend.value = smoothBlend;
  leafMat.uniforms.uTime.value  = t;
  // 叶子配色跟随 colorBlend（同骨骼），中点用嫩翠保饱和度
  lerpMid(leafMat.uniforms.uColor    .value, LEAF_A_COLOR, LEAF_MID_COLOR, LEAF_B_COLOR, colorBlend);
  lerpMid(leafMat.uniforms.uHighlight.value, LEAF_A_HL,    LEAF_MID_HL,    LEAF_B_HL,    colorBlend);
  lerpMid(leafMat.uniforms.uAccent1  .value, LEAF_A_AC1,   LEAF_MID_AC1,   LEAF_B_AC1,   colorBlend);
  lerpMid(leafMat.uniforms.uAccent2  .value, LEAF_A_AC2,   LEAF_MID_AC2,   LEAF_B_AC2,   colorBlend);

  // 花朵 uniforms：两阶段动画
  // 阶段1：花苞出现（跟叶子同阈值）
  for (let g = 0; g < 4; g++) {
    if (!flowerGrowTriggered[g] && smoothBlend >= FLOWER_GROW_THRESHOLDS[g]) {
      flowerGrowTriggered[g] = true;
      flowerGrowStartTime[g] = t;
    }
    if (flowerGrowTriggered[g] && smoothBlend < FLOWER_GROW_THRESHOLDS[g] - 0.05) {
      flowerGrowTriggered[g] = false;
      flowerGrowStartTime[g] = t - (1.0 - flowerGrowProgress[g]) * FLOWER_GROW_DURATION;
    }
    if (flowerGrowTriggered[g]) {
      flowerGrowProgress[g] = Math.min(1.0, (t - flowerGrowStartTime[g]) / FLOWER_GROW_DURATION);
    } else {
      const elapsed = t - flowerGrowStartTime[g];
      flowerGrowProgress[g] = Math.max(0.0, 1.0 - elapsed / FLOWER_GROW_DURATION);
    }
  }
  flowerMat.uniforms.uFlowerGrowths.value.set(
    flowerGrowProgress[0], flowerGrowProgress[1], flowerGrowProgress[2], flowerGrowProgress[3]
  );
  flowerMat.uniforms.uBlend.value = smoothBlend;
  flowerMat.uniforms.uTime.value  = t;
  lerpMid(flowerMat.uniforms.uColor    .value, FLOWER_A_COLOR, FLOWER_MID_COLOR, FLOWER_B_COLOR, colorBlend);
  lerpMid(flowerMat.uniforms.uHighlight.value, FLOWER_A_HL,    FLOWER_MID_HL,    FLOWER_B_HL,    colorBlend);
  lerpMid(flowerMat.uniforms.uAccent1  .value, FLOWER_A_AC1,   FLOWER_MID_AC1,   FLOWER_B_AC1,   colorBlend);
  lerpMid(flowerMat.uniforms.uAccent2  .value, FLOWER_A_AC2,   FLOWER_MID_AC2,   FLOWER_B_AC2,   colorBlend);

  // Layer C
  for (let i = 0; i < N_DIFF; i++) {
    dT[i] += dDt[i];
    if (dT[i] >= 1.0) resetDiffuse(i, smoothBlend);
    const tt = dT[i], u = 1-tt, u2=u*u, u3=u2*u, t2=tt*tt, t3=t2*tt;
    dfPositions[i*3]   = u3*dPx[i]+3*u2*tt*dBzX1[i]+3*u*t2*dBzX2[i]+t3*dBzX3[i];
    dfPositions[i*3+1] = u3*dPy[i]+3*u2*tt*dBzY1[i]+3*u*t2*dBzY2[i]+t3*dBzY3[i];
    dfPositions[i*3+2] = 0.1;
    dfSizes[i]  = dBSize[i];
    dfAlphas[i] = dBAlpha[i] * smoothstep(0,0.08,tt) * (1-smoothstep(0.85,1,tt));
  }
  // Layer D
  for (let i = 0; i < N_GLOW; i++) {
    const gi = N_DIFF+i, t0 = i/(N_GLOW-1);
    const endFade = smoothstep(0,0.08,t0)*smoothstep(1,0.92,t0);
    dfPositions[gi*3]   = glowCurvedX[i]+(glowStraightX[i]-glowCurvedX[i])*smoothBlend;
    dfPositions[gi*3+1] = glowY[i];
    dfPositions[gi*3+2] = -0.5;
    dfAlphas[gi] = (0.035+breathe*0.025)*endFade;
  }
  if (N_DFULL > 0) {
    diffuseGeo.attributes.position.needsUpdate = true;
    diffuseGeo.attributes.aSize.needsUpdate    = true;
    diffuseGeo.attributes.aAlpha.needsUpdate   = true;
  }

  // Bloom 随呼吸脉动（blend 高时光晕跟呼吸强挂钩）
  const breathBloomPulse = breathe * (0.04 + smoothBlend * 0.10); // blend高时脉动更强
  bloomPass.strength = userBloomStrength + breathBloomPulse;
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
  if (data.mode === 'START_GUIDE') { startGuide(); return; }
  if (data.mode === 'EXPERIENCE') { enterExperience(); }
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

// 高清粒子精度（pixel ratio 1.0~4.0）
const pixelRatioSlider = document.getElementById('pixel-ratio-slider');
const pixelRatioVal = document.getElementById('pixel-ratio-val');
let userPixelRatio = 3.0;
pixelRatioSlider.addEventListener('input', () => {
  userPixelRatio = pixelRatioSlider.value / 10;
  pixelRatioVal.textContent = userPixelRatio.toFixed(1);
  renderer.setPixelRatio(userPixelRatio);
  composer.setPixelRatio(userPixelRatio);
  // 高分辨率下粒子视觉变小，用 alpha 补偿保持亮度
  // 用二次方补偿（粒子面积是平方比例）
  const boost = Math.max(1.0, Math.pow(userPixelRatio / 1.5, 2.0));
  spineMat.uniforms.uAlphaBoost.value = boost;
  diffuseMat.uniforms.uAlphaBoost.value = boost;
  vineMat.uniforms.uAlphaBoost.value = boost;
  leafMat.uniforms.uAlphaBoost.value = boost;
  ambMat.uniforms.uAlphaBoost.value = boost;
});

// 边缘物理泛光（bloom strength 0.0~2.0，覆盖animate里的breath调制）
const bloomSlider = document.getElementById('bloom-slider');
const bloomVal = document.getElementById('bloom-val');
let userBloomStrength = 0.12;
bloomSlider.addEventListener('input', () => {
  userBloomStrength = bloomSlider.value / 100;
  bloomVal.textContent = userBloomStrength.toFixed(2);
});

// 电影级曝光率（toneMappingExposure 0.2~3.0）
const exposureSlider = document.getElementById('exposure-slider');
const exposureVal = document.getElementById('exposure-val');
exposureSlider.addEventListener('input', () => {
  const exp = exposureSlider.value / 100;
  exposureVal.textContent = exp.toFixed(2);
  renderer.toneMappingExposure = exp;
});

document.getElementById('btn-start').addEventListener('click', () => startGuide());
document.getElementById('btn-skip').addEventListener('click', () => {
  // 跳过引导直接进入体验模式
  currentMode = 'EXPERIENCE';
  overlays.clearAll();
  spineMat.uniforms.uFormation.value  = 1.0;
  spineMat.uniforms.uGuideAlpha.value = 1.0;
  vineMat.uniforms.uFormation.value   = 1.0;
  updateDebugUI();
  console.log('[raina] 跳过引导，直接进入体验');
});
document.getElementById('btn-reset').addEventListener('click', () => resetToIdle());

// ── 引导进度/速度控制 ──
const guideProgressSlider = document.getElementById('guide-progress-slider');
const guideProgressVal    = document.getElementById('guide-progress-val');
const guideSpeedSlider    = document.getElementById('guide-speed-slider');
const guideSpeedVal       = document.getElementById('guide-speed-val');

if (guideProgressSlider) {
  guideProgressSlider.addEventListener('input', () => {
    const v = parseFloat(guideProgressSlider.value);
    guideProgressVal.textContent = v.toFixed(1);
    guideManualProgress = v;
    // 自动进入 GUIDE 模式
    if (currentMode !== 'GUIDE') {
      currentMode = 'GUIDE';
      guideStartTime = performance.now() / 1000;
      overlays.hideIdleUI();
      updateDebugUI();
    }
  });
  guideProgressSlider.addEventListener('change', () => {
    // 松手后恢复自动播放，从当前位置继续
    guideStartTime = performance.now() / 1000 - guideManualProgress / guideSpeed;
    guideManualProgress = -1;
  });
}
if (guideSpeedSlider) {
  guideSpeedSlider.addEventListener('input', () => {
    guideSpeed = parseFloat(guideSpeedSlider.value) / 10;
    guideSpeedVal.textContent = guideSpeed.toFixed(1);
    // 重算起始时间保持当前进度
    if (currentMode === 'GUIDE' && guideManualProgress < 0) {
      guideStartTime = performance.now() / 1000 - guideElapsed / guideSpeed;
    }
  });
}

function updateDebugUI() {
  if (debugState) debugState.textContent = currentMode;
  if (debugBlend) debugBlend.textContent = smoothBlend.toFixed(3);
  // 同步引导进度滑块
  if (guideProgressSlider && currentMode === 'GUIDE' && guideManualProgress < 0) {
    guideProgressSlider.value = Math.min(86, guideElapsed);
    if (guideProgressVal) guideProgressVal.textContent = guideElapsed.toFixed(1);
  }
}


// ============================================================
// 15. 键盘快捷键
// ============================================================

// ============================================================
// 15b. 分支藤蔓编辑器（按B进入）
// ============================================================

let branchEditMode = false;
const branchEditorData = [];   // 所有已完成分支 [[x,y], ...]
let currentBranchPts = [];     // 当前正在编辑的分支

// 编辑器预览用的临时 Three.js 对象
let branchPreviewLine = null;
let branchPreviewDots = null;

function screenToWorld(mx, my) {
  const ndc = new THREE.Vector3(
    (mx / window.innerWidth) * 2 - 1,
    -(my / window.innerHeight) * 2 + 1,
    0
  );
  ndc.unproject(camera);
  // 投射到 z=0 平面
  const dir = ndc.sub(camera.position).normalize();
  const dist = -camera.position.z / dir.z;
  const pt = camera.position.clone().add(dir.multiplyScalar(dist));
  return [parseFloat(pt.x.toFixed(3)), parseFloat(pt.y.toFixed(3))];
}

function updateBranchPreview() {
  // 清除旧预览
  if (branchPreviewLine) { scene.remove(branchPreviewLine); branchPreviewLine.geometry.dispose(); }
  if (branchPreviewDots) { scene.remove(branchPreviewDots); branchPreviewDots.geometry.dispose(); }

  const allPts = [...branchEditorData, currentBranchPts].filter(b => b.length >= 2);

  // 绘制所有分支曲线（白色线条）
  const lineVerts = [];
  for (const branch of allPts) {
    const curve = new THREE.CatmullRomCurve3(branch.map(([x,y]) => new THREE.Vector3(x, y, 0.5)));
    const pts = curve.getPoints(branch.length * 20);
    for (let i = 0; i < pts.length - 1; i++) {
      lineVerts.push(pts[i].x, pts[i].y, pts[i].z, pts[i+1].x, pts[i+1].y, pts[i+1].z);
    }
  }
  if (lineVerts.length > 0) {
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(lineVerts, 3));
    branchPreviewLine = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: 0x00ff88, linewidth: 1 }));
    scene.add(branchPreviewLine);
  }

  // 绘制所有控制点（红色小圆点）
  const dotVerts = [];
  const dotSizes = [];
  for (const branch of [...branchEditorData, [currentBranchPts]].flat()) {
    if (!Array.isArray(branch)) continue;
    for (const b of (Array.isArray(branch[0]) ? [branch] : [[branch]])) {
      // skip
    }
  }
  // 简化：直接画所有点
  const allDots = [...branchEditorData.flat(), ...currentBranchPts];
  if (allDots.length > 0) {
    const dg = new THREE.BufferGeometry();
    const dp = new Float32Array(allDots.length * 3);
    const ds = new Float32Array(allDots.length);
    for (let i = 0; i < allDots.length; i++) {
      dp[i*3] = allDots[i][0]; dp[i*3+1] = allDots[i][1]; dp[i*3+2] = 0.5;
      ds[i] = 8.0;
    }
    dg.setAttribute('position', new THREE.BufferAttribute(dp, 3));
    dg.setAttribute('aSize', new THREE.BufferAttribute(ds, 1));
    branchPreviewDots = new THREE.Points(dg, new THREE.PointsMaterial({ color: 0xff4444, size: 8, sizeAttenuation: false }));
    scene.add(branchPreviewDots);
  }
}

function enterBranchEdit() {
  branchEditMode = true;
  currentBranchPts = [];
  // 暂停脊柱旋转，方便编辑
  spineGroup.rotation.y = 0;
  console.log('🌿 分支编辑模式 ON — 点击放置控制点 | 回车=确认当前分支 | Z=撤销 | X=导出 | B=退出');
}

function exitBranchEdit() {
  branchEditMode = false;
  if (currentBranchPts.length >= 2) {
    branchEditorData.push([...currentBranchPts]);
  }
  currentBranchPts = [];
  // 清除预览
  if (branchPreviewLine) { scene.remove(branchPreviewLine); branchPreviewLine.geometry.dispose(); branchPreviewLine = null; }
  if (branchPreviewDots) { scene.remove(branchPreviewDots); branchPreviewDots.geometry.dispose(); branchPreviewDots = null; }
  console.log('🌿 分支编辑模式 OFF');
}

function exportBranches() {
  // 把当前分支也加进去
  const all = [...branchEditorData];
  if (currentBranchPts.length >= 2) all.push([...currentBranchPts]);

  console.log('===== 分支藤蔓坐标导出 =====');
  console.log('共 ' + all.length + ' 根分支');
  console.log('');
  console.log('const branchPaths = [');
  for (let i = 0; i < all.length; i++) {
    const pts = all[i].map(([x,y]) => `[${x}, ${y}]`).join(', ');
    console.log(`  [${pts}],  // 分支${i+1}`);
  }
  console.log('];');
  console.log('');
  console.log('===== 复制以上内容发给开发者 =====');
}

canvas.addEventListener('click', (e) => {
  if (!branchEditMode) return;
  // 不在调试面板区域才处理
  if (e.target !== canvas) return;
  const [wx, wy] = screenToWorld(e.clientX, e.clientY);
  currentBranchPts.push([wx, wy]);
  console.log(`  控制点 ${currentBranchPts.length}: [${wx}, ${wy}]`);
  updateBranchPreview();
});

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); startGuide(); }
  if (e.key === 'r' || e.key === 'R') { if (!branchEditMode) resetToIdle(); }
  if (e.key === 'd' || e.key === 'D') debugPanel.classList.toggle('hidden');
  if (e.key === 'f' || e.key === 'F') {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  }
  if (e.key === 'b' || e.key === 'B') {
    if (branchEditMode) exitBranchEdit();
    else enterBranchEdit();
  }
  if (branchEditMode) {
    if (e.key === 'Enter') {
      if (currentBranchPts.length >= 2) {
        branchEditorData.push([...currentBranchPts]);
        console.log(`✅ 分支 ${branchEditorData.length} 已保存（${currentBranchPts.length}个控制点）`);
        currentBranchPts = [];
        updateBranchPreview();
      } else {
        console.log('⚠️ 至少需要2个控制点');
      }
    }
    if (e.key === 'z' || e.key === 'Z') {
      if (currentBranchPts.length > 0) {
        const removed = currentBranchPts.pop();
        console.log(`↩ 撤销控制点 [${removed}]`);
        updateBranchPreview();
      }
    }
    if (e.key === 'x' || e.key === 'X') {
      exportBranches();
    }
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
