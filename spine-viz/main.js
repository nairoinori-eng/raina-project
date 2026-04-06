/**
 * raina-project — Three.js 粒子脊柱主程序 v2
 * ============================================
 * 核心目标：TouchDesigner 级别颗粒感
 *   - 每个粒子清晰可见（2-5px），不是模糊光团
 *   - Simplex Noise 驱动有机漂移
 *   - 高斯分布：核心亮密、边缘暗稀
 *   - blend 变化时从下往上级联流动
 *   - 整体5秒呼吸脉动
 *   - Vignette 暗角 + 克制 Bloom
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass }     from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { io } from 'socket.io-client';


// ============================================================
// 1. 脊柱坐标数据（设计者本人 S 型脊柱，13个控制点）
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

// 粒子数量
const N_SPINE   = 2500;  // 脊柱主体（更多小粒子 = 颗粒感）
const N_AMBIENT = 200;   // 背景环境粒子

// 颜色
const COLOR_DARK_PURPLE = new THREE.Color(0x2d1b69);
const COLOR_MID_PURPLE  = new THREE.Color(0x7b4fb5);
const COLOR_WARM_GOLD   = new THREE.Color(0xd4a24c);


// ============================================================
// 2. 工具函数
// ============================================================

/** Box-Muller 变换：生成标准正态分布随机数 */
function gaussRand() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 根据 blend 值计算颜色（深蓝紫→浅紫→暖金） */
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
// 3. 场景 / 摄像机 / 渲染器
// ============================================================

const canvas = document.getElementById('spine-canvas');

// alpha: false（EffectComposer + alpha:true 会导致白屏），改用 scene.background
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene  = new THREE.Scene();
scene.background = new THREE.Color(0x06060f);  // 极深蓝黑，CSS Vignette 覆盖在上方

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0, 5);
camera.lookAt(0, 0, 0);

// 摄像机到 z=0 的距离 = 5，gl_PointSize 缩放系数 = 300/5 = 60
// 所以 aSize = 0.05 → 屏幕 3px；aSize = 0.10 → 屏幕 6px


// ============================================================
// 4. Shader（顶点 + 片元）
// ============================================================

const vertexShader = /* glsl */`
  attribute float aSize;   // 粒子世界尺寸
  attribute float aAlpha;  // 粒子基础透明度

  varying float vAlpha;

  void main() {
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // 300.0 / -mv.z：让粒子随距离缩放（近大远小）
    gl_PointSize = aSize * (300.0 / -mv.z);
    gl_Position  = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */`
  uniform vec3 uColor;
  varying float vAlpha;

  void main() {
    // gl_PointCoord: 粒子内部坐标，中心 = (0.5, 0.5)
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;

    // 双层叠加：亮核心 + 柔晕
    // 衰减指数：core=12（锐核），halo=3（宽晕）
    float core  = exp(-d * d * 12.0);
    float halo  = exp(-d * d * 3.0) * 0.4;
    float alpha = (core + halo) * vAlpha;

    gl_FragColor = vec4(uColor, alpha);
  }
`;


// ============================================================
// 5. 脊柱粒子系统（核心）
// ============================================================

/**
 * 内置平滑噪声（不依赖外部库）
 * 用多层 sin/cos 叠加模拟 Perlin Noise 效果
 * 输入：x, y 坐标 + 时间；输出：-1 到 1 的平滑随机值
 */
function smoothNoise(x, y, t) {
  return (
    Math.sin(x * 1.7 + t * 0.8) * Math.cos(y * 2.3 + t * 0.6) * 0.5 +
    Math.sin(x * 3.1 + t * 0.4) * Math.cos(y * 1.9 + t * 0.9) * 0.3 +
    Math.sin(x * 5.3 + t * 0.2) * Math.cos(y * 4.1 + t * 0.5) * 0.2
  );
}

// 每个粒子的静态数据（初始化时确定，运行时不变）
const spineT      = new Float32Array(N_SPINE);  // 在曲线上的位置 [0,1]，0=顶 1=底
const gaussOffX   = new Float32Array(N_SPINE);  // 高斯偏移 x
const gaussOffY   = new Float32Array(N_SPINE);  // 高斯偏移 y
const noiseOffX   = new Float32Array(N_SPINE);  // 噪声采样基点 x
const noiseOffY   = new Float32Array(N_SPINE);  // 噪声采样基点 y
const baseSizes   = new Float32Array(N_SPINE);  // 粒子基础尺寸
const baseAlphas  = new Float32Array(N_SPINE);  // 粒子基础透明度
const pulsePhase  = new Float32Array(N_SPINE);  // 大小脉动相位

// 曲线采样点（根据随机 spineT 采样，存储弯曲和直立两个位置）
const curvedPts   = [];
const straightPts = [];

// 高斯分布参数
const sigma = 0.042;  // 脊柱"宽度"标准差（越大越胖）

for (let i = 0; i < N_SPINE; i++) {
  // 在曲线上随机取一个位置（非均匀，更自然）
  spineT[i] = Math.random();
  curvedPts.push(curveCurved.getPoint(spineT[i]));
  straightPts.push(curveStraight.getPoint(spineT[i]));

  // 高斯偏移：从脊柱中心线向外扩散
  gaussOffX[i] = gaussRand() * sigma;
  gaussOffY[i] = gaussRand() * sigma * 0.25;  // y 方向更窄

  // 离中心的距离（0=中心线，1=边缘）
  const dist = Math.min(1, Math.sqrt(gaussOffX[i]**2 + gaussOffY[i]**2) / (2.5 * sigma));

  // 核心粒子：亮一些；边缘粒子：暗淡
  // 注意：AdditiveBlending 叠加模式，3-4个粒子重叠时 alpha 会累加
  // 所以单粒子 alpha 要控制在 0.1-0.25，否则叠加后变白
  baseSizes[i]  = (0.075 - dist * 0.038) + Math.random() * 0.018;  // 屏幕约 2-5px
  baseAlphas[i] = (0.22  - dist * 0.16)  + Math.random() * 0.06;   // 0.02-0.28

  // 噪声采样基点（每粒子不同，防止同步漂移）
  noiseOffX[i] = Math.random() * 100;
  noiseOffY[i] = Math.random() * 100;

  // 脉动相位（每粒子错开）
  pulsePhase[i] = Math.random() * Math.PI * 2;
}

// BufferGeometry
const spinePositions = new Float32Array(N_SPINE * 3);
const spineSizes     = new Float32Array(N_SPINE);
const spineAlphas    = new Float32Array(N_SPINE);

// 初始位置 = 弯曲状态
for (let i = 0; i < N_SPINE; i++) {
  const p = curvedPts[i];
  spinePositions[i*3]   = p.x + gaussOffX[i];
  spinePositions[i*3+1] = p.y + gaussOffY[i];
  spinePositions[i*3+2] = 0;
  spineSizes[i]  = baseSizes[i];
  spineAlphas[i] = baseAlphas[i];
}

const spineGeo = new THREE.BufferGeometry();
spineGeo.setAttribute('position', new THREE.BufferAttribute(spinePositions, 3));
spineGeo.setAttribute('aSize',    new THREE.BufferAttribute(spineSizes, 1));
spineGeo.setAttribute('aAlpha',   new THREE.BufferAttribute(spineAlphas, 1));

const spineMat = new THREE.ShaderMaterial({
  vertexShader,
  fragmentShader,
  uniforms: { uColor: { value: COLOR_DARK_PURPLE.clone() } },
  transparent: true,
  blending:    THREE.AdditiveBlending,
  depthWrite:  false,
});

scene.add(new THREE.Points(spineGeo, spineMat));


// ============================================================
// 6. 环境微粒（背景星尘）
// ============================================================

const ambBase      = new Float32Array(N_AMBIENT * 3);
const ambOrbitR    = new Float32Array(N_AMBIENT);
const ambOrbitSpd  = new Float32Array(N_AMBIENT);
const ambOrbitPh   = new Float32Array(N_AMBIENT);
const ambPositions = new Float32Array(N_AMBIENT * 3);
const ambSizes     = new Float32Array(N_AMBIENT);
const ambAlphas    = new Float32Array(N_AMBIENT);

for (let i = 0; i < N_AMBIENT; i++) {
  // 铺满全屏（相机FOV=60，z=5，宽约8.5单位，高约5.8单位）
  ambBase[i*3]   = (Math.random() - 0.5) * 10;
  ambBase[i*3+1] = (Math.random() - 0.5) * 7;
  ambBase[i*3+2] = (Math.random() - 0.5) * 1.5;

  ambPositions[i*3]   = ambBase[i*3];
  ambPositions[i*3+1] = ambBase[i*3+1];
  ambPositions[i*3+2] = ambBase[i*3+2];

  // 非常小的粒子（1-2px 感），暗淡，不抢主体
  ambSizes[i]  = 0.015 + Math.random() * 0.020;   // 屏幕约 1-2px
  ambAlphas[i] = 0.12  + Math.random() * 0.15;

  ambOrbitR[i]   = 0.06 + Math.random() * 0.20;
  ambOrbitSpd[i] = 0.05 + Math.random() * 0.15;
  ambOrbitPh[i]  = Math.random() * Math.PI * 2;
}

const ambGeo = new THREE.BufferGeometry();
ambGeo.setAttribute('position', new THREE.BufferAttribute(ambPositions, 3));
ambGeo.setAttribute('aSize',    new THREE.BufferAttribute(ambSizes, 1));
ambGeo.setAttribute('aAlpha',   new THREE.BufferAttribute(ambAlphas, 1));

const ambMat = new THREE.ShaderMaterial({
  vertexShader,
  fragmentShader,
  uniforms: { uColor: { value: new THREE.Color(0x2a1855) } },
  transparent: true,
  blending:    THREE.AdditiveBlending,
  depthWrite:  false,
});

scene.add(new THREE.Points(ambGeo, ambMat));


// ============================================================
// 7. 后处理：Bloom（克制）
// ============================================================

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.4,   // strength（随呼吸动态调整）
  0.35,  // radius（不扩散太远）
  0.28   // threshold（小粒子需要低一点才能触发晕光）
);
composer.addPass(bloomPass);


// ============================================================
// 8. 状态 / blend 控制
// ============================================================

let currentMode   = 'IDLE';
let targetBlend   = 0.0;
let smoothBlend   = 0.0;
let blendVelocity = 0.0;  // 弹簧物理速度


// ============================================================
// 9. 动画主循环
// ============================================================

let time = 0;

function animate() {
  requestAnimationFrame(animate);
  time += 0.016;  // ~60fps

  // ── 弹簧物理平滑 blend（ease-in-out 感） ──
  const springF = (targetBlend - smoothBlend) * 0.035;
  blendVelocity = blendVelocity * 0.82 + springF;
  smoothBlend   = Math.max(0, Math.min(1, smoothBlend + blendVelocity));

  // ── 整体呼吸脉动（5秒周期） ──
  // 2π/5 ≈ 1.257
  const breathe     = Math.sin(time * 1.257) * 0.5 + 0.5;  // 0→1→0，5s
  const spreadScale = 1 + breathe * 0.06;                   // 高斯偏移轻微膨胀

  // ── 更新脊柱粒子 ──
  const pos  = spineGeo.attributes.position.array;
  const sz   = spineGeo.attributes.aSize.array;
  // const al = spineGeo.attributes.aAlpha.array;  // alpha 固定不变

  // 级联波参数：底部粒子（spineT=1）先响应，顶部（spineT=0）后响应
  const WAVE = 0.28;

  for (let i = 0; i < N_SPINE; i++) {
    // 级联 localBlend：底部领先 WAVE
    const localBlend = Math.max(0, Math.min(1,
      (smoothBlend - (1 - spineT[i]) * WAVE) / (1 - WAVE)
    ));

    // 基础位置：弯曲 ↔ 直立 插值（用 localBlend）
    const cp = curvedPts[i];
    const sp = straightPts[i];
    const bx = cp.x + (sp.x - cp.x) * localBlend;
    const by = cp.y + (sp.y - cp.y) * localBlend;

    // 平滑噪声有机漂移（极慢，像在水中悬浮）
    const nx = smoothNoise(noiseOffX[i], noiseOffY[i],      time * 0.10) * 0.028;
    const ny = smoothNoise(noiseOffX[i], noiseOffY[i] + 50, time * 0.08) * 0.020;

    // 高斯偏移随呼吸轻微膨胀
    pos[i*3]   = bx + gaussOffX[i] * spreadScale + nx;
    pos[i*3+1] = by + gaussOffY[i] * spreadScale + ny;
    pos[i*3+2] = 0;

    // 大小脉动（每粒子相位不同，±8%，周期约4s）
    // 2π/4 ≈ 1.57
    const pulse = 1.0 + Math.sin(time * 1.57 + pulsePhase[i]) * 0.08;
    sz[i] = baseSizes[i] * pulse;
  }

  spineGeo.attributes.position.needsUpdate = true;
  spineGeo.attributes.aSize.needsUpdate    = true;

  // ── 更新颜色（整体 smoothBlend 控制色调） ──
  spineMat.uniforms.uColor.value.copy(getBlendColor(smoothBlend));

  // ── Bloom 随呼吸起伏（克制范围） ──
  bloomPass.strength = 0.30 + breathe * 0.12 + smoothBlend * 0.08;

  // ── 更新环境微粒（圆形轨道漂浮） ──
  const ap = ambGeo.attributes.position.array;
  for (let i = 0; i < N_AMBIENT; i++) {
    ap[i*3]   = ambBase[i*3]   + Math.cos(time * ambOrbitSpd[i]       + ambOrbitPh[i]) * ambOrbitR[i];
    ap[i*3+1] = ambBase[i*3+1] + Math.sin(time * ambOrbitSpd[i] * 0.7 + ambOrbitPh[i]) * ambOrbitR[i];
  }
  ambGeo.attributes.position.needsUpdate = true;

  // ── 调试 UI ──
  if (debugBlend) debugBlend.textContent = smoothBlend.toFixed(3);

  composer.render();
}

animate();


// ============================================================
// 10. SocketIO（与 Flask 通信）
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
// 11. 调试面板
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
// 12. 键盘快捷键
// ============================================================

document.addEventListener('keydown', (e) => {
  if (e.key === 'd' || e.key === 'D') debugPanel.classList.toggle('hidden');
  if (e.key === 'f' || e.key === 'F') {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  }
});


// ============================================================
// 13. 窗口缩放响应
// ============================================================

window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
});
