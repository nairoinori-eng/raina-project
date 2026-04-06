/**
 * raina-project — Three.js 粒子脊柱主程序
 * ==========================================
 * 这是整个作品的视觉核心：
 *   - 一条由粒子组成的脊柱曲线
 *   - 根据 blend 值在"弯曲"和"变直"之间过渡
 *   - 颜色从蓝紫（弯曲）渐变到暖金（变直）
 *   - 有发光（Bloom）后处理效果
 *
 * 当前模式：用调试面板滑块控制 blend（模拟呼吸）
 * 硬件到货后：blend 值改为从 Flask-SocketIO 接收真实传感器数据
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { io } from 'socket.io-client';


// ============================================================
// 1. 脊柱坐标数据
// ============================================================
// 设计者本人的脊柱数据：S 型，胸椎右凸 + 腰椎左凸
// 坐标说明：x 轴正方向 = 向右，y 轴正方向 = 向上
// 13 个控制点，从上（C7颈椎）到下（S1骶椎）

const SPINE_CURVED = [
  new THREE.Vector3( 0.00,  2.00, 0),  // C7  — 顶部，居中
  new THREE.Vector3( 0.08,  1.60, 0),  // T1
  new THREE.Vector3( 0.22,  1.20, 0),  // T3
  new THREE.Vector3( 0.36,  0.80, 0),  // T5
  new THREE.Vector3( 0.42,  0.35, 0),  // T7  — 胸椎最大右凸（Cobb角约28°）
  new THREE.Vector3( 0.34, -0.05, 0),  // T9
  new THREE.Vector3( 0.14, -0.35, 0),  // T11
  new THREE.Vector3(-0.06, -0.60, 0),  // L1
  new THREE.Vector3(-0.22, -0.90, 0),  // L2
  new THREE.Vector3(-0.34, -1.20, 0),  // L3  — 腰椎最大左凸（Cobb角约18°）
  new THREE.Vector3(-0.24, -1.50, 0),  // L4
  new THREE.Vector3(-0.08, -1.80, 0),  // L5
  new THREE.Vector3( 0.00, -2.00, 0),  // S1  — 底部，回到居中
];

// 目标直立脊柱：所有 x=0，y 值与弯曲版相同
const SPINE_STRAIGHT = SPINE_CURVED.map(p => new THREE.Vector3(0, p.y, 0));

// 粒子数量（脊柱主体）
const SPINE_PARTICLE_COUNT = 1000;
// 环境微粒数量（背景漂浮光点）
const AMBIENT_PARTICLE_COUNT = 280;

// 颜色关键帧（blend 从 0→1 时的色彩变化）
const COLOR_DARK_PURPLE = new THREE.Color(0x2d1b69);  // blend=0  深蓝紫
const COLOR_MID_PURPLE  = new THREE.Color(0x7b4fb5);  // blend=0.5 浅紫
const COLOR_WARM_GOLD   = new THREE.Color(0xd4a24c);  // blend=1   暖金


// ============================================================
// 2. 场景初始化
// ============================================================

const canvas = document.getElementById('spine-canvas');

// 渲染器：WebGL，抗锯齿
// alpha: true → 画布背景透明，让 CSS 径向渐变透过来（修复4：背景渐变）
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
// 注：不再设置 toneMapping 和 scene.background，让 CSS 背景透过

// 场景（不设 background，透明显示 CSS 渐变背景）
const scene = new THREE.Scene();

// 摄像机：透视投影，站在 z=5 往原点看
const camera = new THREE.PerspectiveCamera(
  60,                                       // 视角
  window.innerWidth / window.innerHeight,   // 宽高比
  0.1,                                      // 近裁面
  100                                       // 远裁面
);
camera.position.set(0, 0, 5);
camera.lookAt(0, 0, 0);


// ============================================================
// 3. 粒子脊柱系统（核心）
// ============================================================

/**
 * 自定义 Shader（着色器程序）
 *
 * 修复6：粒子柔化——改为双层叠加：亮核心 + 大柔晕
 * 原来 exp(-d*d*10) 衰减太陡，看起来像硬边 LED 灯珠
 * 现在 core + halo 让粒子有亮核但周围有柔和光晕
 */
const spineVertexShader = /* glsl */`
  attribute float aSize;   // 粒子大小
  attribute float aAlpha;  // 粒子透明度

  varying float vAlpha;

  void main() {
    vAlpha = aAlpha;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (300.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const spineFragmentShader = /* glsl */`
  uniform vec3 uColor;
  varying float vAlpha;

  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;

    // 修复6：双层叠加
    // core = 小亮核（衰减快）
    // halo = 大柔晕（衰减慢，强度 35%）
    // 合并后粒子有柔和光晕，不是硬边圆点
    float core  = exp(-d * d * 8.0);
    float halo  = exp(-d * d * 2.5) * 0.35;
    float alpha = (core + halo) * vAlpha;

    gl_FragColor = vec4(uColor, alpha);
  }
`;

// 创建脊柱粒子材质
const spineMaterial = new THREE.ShaderMaterial({
  vertexShader: spineVertexShader,
  fragmentShader: spineFragmentShader,
  uniforms: {
    uColor: { value: COLOR_DARK_PURPLE.clone() },
  },
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});

// 用 CatmullRomCurve3 将 13 个控制点插值成平滑曲线，然后采样 1000 个点
const curveCurved   = new THREE.CatmullRomCurve3(SPINE_CURVED);
const curveStraight = new THREE.CatmullRomCurve3(SPINE_STRAIGHT);

const pointsCurved   = curveCurved.getPoints(SPINE_PARTICLE_COUNT - 1);
const pointsStraight = curveStraight.getPoints(SPINE_PARTICLE_COUNT - 1);

// 每个粒子在曲线垂直方向的随机偏移（形成"带状"分布而非细线）
const offsets = [];
for (let i = 0; i < SPINE_PARTICLE_COUNT; i++) {
  offsets.push((Math.random() - 0.5) * 0.12);  // x 偏移
  offsets.push((Math.random() - 0.5) * 0.03);  // y 偏移
}

// 修复2a：每个粒子独立漂移相位和频率（让每个粒子有自己的随机运动）
const driftPhaseX = new Float32Array(SPINE_PARTICLE_COUNT);
const driftPhaseY = new Float32Array(SPINE_PARTICLE_COUNT);
const driftFreq   = new Float32Array(SPINE_PARTICLE_COUNT);

// 修复2b：每个粒子独立大小脉动相位
const pulsePhase  = new Float32Array(SPINE_PARTICLE_COUNT);

for (let i = 0; i < SPINE_PARTICLE_COUNT; i++) {
  driftPhaseX[i] = Math.random() * Math.PI * 2;   // 0 ~ 2π 随机起始相位
  driftPhaseY[i] = Math.random() * Math.PI * 2;
  driftFreq[i]   = 0.3 + Math.random() * 0.5;     // 漂移频率 0.3-0.8（缓慢）
  pulsePhase[i]  = Math.random() * Math.PI * 2;   // 脉动起始相位，每粒子不同
}

// 粒子当前位置（初始 = 弯曲状态）
const positions = new Float32Array(SPINE_PARTICLE_COUNT * 3);
// 修复6：粒子大小稍微减小（1.5-5），配合柔化 shader 效果更好
const sizes     = new Float32Array(SPINE_PARTICLE_COUNT);
const alphas    = new Float32Array(SPINE_PARTICLE_COUNT);

for (let i = 0; i < SPINE_PARTICLE_COUNT; i++) {
  const p = pointsCurved[i];
  positions[i * 3]     = p.x + offsets[i * 2];
  positions[i * 3 + 1] = p.y + offsets[i * 2 + 1];
  positions[i * 3 + 2] = 0;

  sizes[i]  = 1.0 + Math.random() * 2.5;
  alphas[i] = 0.005 + Math.random() * 0.010;    // 极低alpha（叠加模式，50粒子叠加后约0.5亮度）
}

const spineGeometry = new THREE.BufferGeometry();
spineGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
spineGeometry.setAttribute('aSize',    new THREE.BufferAttribute(sizes, 1));
spineGeometry.setAttribute('aAlpha',   new THREE.BufferAttribute(alphas, 1));

const spineParticles = new THREE.Points(spineGeometry, spineMaterial);
scene.add(spineParticles);


// ============================================================
// 4. 环境微粒（背景漂浮的星尘）
// ============================================================
// 修复5：扩大分布范围（铺满屏幕），改为圆形轨道漂浮（更有机）

const ambientGeometry = new THREE.BufferGeometry();
const ambientPositions = new Float32Array(AMBIENT_PARTICLE_COUNT * 3);
const ambientSizes     = new Float32Array(AMBIENT_PARTICLE_COUNT);
const ambientAlphas    = new Float32Array(AMBIENT_PARTICLE_COUNT);

// 记录每个微粒的"中心基点"（轨道圆心）
const ambBase        = new Float32Array(AMBIENT_PARTICLE_COUNT * 3);
// 圆形轨道参数
const orbitRadius    = new Float32Array(AMBIENT_PARTICLE_COUNT);
const orbitSpeed     = new Float32Array(AMBIENT_PARTICLE_COUNT);
const orbitPhase     = new Float32Array(AMBIENT_PARTICLE_COUNT);

for (let i = 0; i < AMBIENT_PARTICLE_COUNT; i++) {
  // 分布范围扩大到 [-6,6]×[-4,4]，占据屏幕大部分空间
  ambBase[i * 3]     = (Math.random() - 0.5) * 12;  // x: -6 ~ 6
  ambBase[i * 3 + 1] = (Math.random() - 0.5) * 8;   // y: -4 ~ 4
  ambBase[i * 3 + 2] = (Math.random() - 0.5) * 2;   // z 轴深度变化

  // 初始位置 = 基点
  ambientPositions[i * 3]     = ambBase[i * 3];
  ambientPositions[i * 3 + 1] = ambBase[i * 3 + 1];
  ambientPositions[i * 3 + 2] = ambBase[i * 3 + 2];

  // 修复5：更小的尺寸（0.3-1.5px 感）
  ambientSizes[i]  = 0.3 + Math.random() * 1.2;
  // 修复5：alpha 范围调整为 0.10-0.30（更暗淡）
  ambientAlphas[i] = 0.10 + Math.random() * 0.20;

  // 圆形轨道参数（缓慢绕圈，产生有机漂浮感）
  orbitRadius[i] = 0.05 + Math.random() * 0.25;     // 漂浮半径 0.05-0.30
  orbitSpeed[i]  = 0.08 + Math.random() * 0.20;     // 绕圈速度（很慢）
  orbitPhase[i]  = Math.random() * Math.PI * 2;     // 初始角度随机
}

ambientGeometry.setAttribute('position', new THREE.BufferAttribute(ambientPositions, 3));
ambientGeometry.setAttribute('aSize',    new THREE.BufferAttribute(ambientSizes, 1));
ambientGeometry.setAttribute('aAlpha',   new THREE.BufferAttribute(ambientAlphas, 1));

// 环境微粒用同样的 shader，颜色固定为更暗的蓝紫
const ambientMaterial = new THREE.ShaderMaterial({
  vertexShader: spineVertexShader,
  fragmentShader: spineFragmentShader,
  uniforms: {
    uColor: { value: new THREE.Color(0x2a1a50) },  // 比主脊柱更暗
  },
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});

const ambientParticles = new THREE.Points(ambientGeometry, ambientMaterial);
scene.add(ambientParticles);


// ============================================================
// 5. 后处理：Bloom 发光效果
// ============================================================
// 修复1：大幅降低 Bloom，避免过曝白光团

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.6,    // strength：发光强度
  0.4,    // radius：发光扩散半径
  0.85,   // threshold：只有非常亮的核心才触发 bloom
);
composer.addPass(bloomPass);


// ============================================================
// 6. 状态管理和 blend 控制
// ============================================================

let currentMode = 'IDLE';
let targetBlend   = 0.0;  // 目标 blend 值（从传感器/滑块接收）
let smoothBlend   = 0.0;  // 平滑后的 blend 值
let blendVelocity = 0.0;  // 修复3：弹簧物理速度（让过渡有缓动感）


/**
 * 更新脊柱粒子位置
 * 修复2a：加入每粒子独立漂移（sin/cos + time），让粒子"活着"
 * @param {number} t — 当前时间（秒）
 */
function updateSpinePositions(t) {
  const pos = spineGeometry.attributes.position.array;

  for (let i = 0; i < SPINE_PARTICLE_COUNT; i++) {
    const curved   = pointsCurved[i];
    const straight = pointsStraight[i];

    // 基础位置：在弯曲和直立之间插值
    const baseX = curved.x + (straight.x - curved.x) * smoothBlend;
    const baseY = curved.y + (straight.y - curved.y) * smoothBlend;

    // 修复2a：叠加独立随机漂移（每粒子相位不同，产生"活着"的感觉）
    // 振幅 x=0.03，y=0.02（微弱但可见）
    const dx = Math.sin(t * driftFreq[i]       + driftPhaseX[i]) * 0.03;
    const dy = Math.cos(t * driftFreq[i] * 0.7 + driftPhaseY[i]) * 0.02;

    pos[i * 3]     = baseX + offsets[i * 2]     + dx;
    pos[i * 3 + 1] = baseY + offsets[i * 2 + 1] + dy;
    pos[i * 3 + 2] = 0;
  }

  spineGeometry.attributes.position.needsUpdate = true;
}


/**
 * 根据 blend 值计算当前颜色
 * 0 → 深蓝紫，0.5 → 浅紫，1 → 暖金
 */
function getBlendColor(blend) {
  const color = new THREE.Color();
  if (blend < 0.5) {
    color.lerpColors(COLOR_DARK_PURPLE, COLOR_MID_PURPLE, blend * 2);
  } else {
    color.lerpColors(COLOR_MID_PURPLE, COLOR_WARM_GOLD, (blend - 0.5) * 2);
  }
  return color;
}


// ============================================================
// 7. SocketIO 连接（与 Flask 通信）
// ============================================================

const socket = io('http://localhost:5000');

socket.on('connect', () => {
  console.log('✅ 已连接到 Flask 服务');
  updateDebugUI();
});

socket.on('disconnect', () => {
  console.log('❌ 与 Flask 断开连接');
});

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
// 8. 调试面板交互
// ============================================================

const debugPanel   = document.getElementById('debug-panel');
const debugState   = document.getElementById('debug-state');
const debugBlend   = document.getElementById('debug-blend');
const blendSlider  = document.getElementById('blend-slider');
const btnStart     = document.getElementById('btn-start');
const btnReset     = document.getElementById('btn-reset');

blendSlider.addEventListener('input', () => {
  const value = blendSlider.value / 100;
  socket.emit('set_blend', { value });
});

btnStart.addEventListener('click', () => {
  socket.emit('button_press');
});

btnReset.addEventListener('click', () => {
  socket.emit('button_press');
});

function updateDebugUI() {
  if (debugState) debugState.textContent = currentMode;
  if (debugBlend) debugBlend.textContent = smoothBlend.toFixed(3);
}


// ============================================================
// 9. 键盘快捷键
// ============================================================

document.addEventListener('keydown', (e) => {
  if (e.key === 'd' || e.key === 'D') {
    debugPanel.classList.toggle('hidden');
  }

  if (e.key === 'f' || e.key === 'F') {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  }
});


// ============================================================
// 10. 动画主循环
// ============================================================

let time = 0;

function animate() {
  requestAnimationFrame(animate);
  time += 0.016;

  // --- 修复3：弹簧物理平滑 blend（有加速→减速的自然缓动）---
  // 弹簧力朝向目标，速度被阻尼衰减，产生 ease-in-out 效果
  const springForce = (targetBlend - smoothBlend) * 0.035;
  blendVelocity = blendVelocity * 0.82 + springForce;
  smoothBlend  += blendVelocity;
  smoothBlend   = Math.max(0, Math.min(1, smoothBlend));  // 钳制在 0-1

  // --- 更新脊柱粒子位置（含独立漂移）---
  updateSpinePositions(time);

  // --- 修复2b：每粒子独立大小脉动（周期约3秒，相位各异）---
  // 2π / 3s ≈ 2.09
  const sizeAttr = spineGeometry.attributes.aSize.array;
  for (let i = 0; i < SPINE_PARTICLE_COUNT; i++) {
    const p = 1.0 + Math.sin(time * 2.09 + pulsePhase[i]) * 0.10;  // ±10%
    sizeAttr[i] = sizes[i] * p;
  }
  spineGeometry.attributes.aSize.needsUpdate = true;

  // --- 更新颜色（根据 blend 值）---
  const currentColor = getBlendColor(smoothBlend);
  spineMaterial.uniforms.uColor.value.copy(currentColor);

  // --- 修复1：Bloom 强度大幅降低（柔和微光，不过曝）---
  // 0.12（待机/弯曲）→ 0.32（完全伸直），远低于原来的 0.4-1.2
  bloomPass.strength = 0.5 + smoothBlend * 0.4;  // 0.5 → 0.9，柔和范围

  // --- 修复5：更新环境微粒位置（圆形轨道，有机漂浮）---
  const ambPos = ambientGeometry.attributes.position.array;
  for (let i = 0; i < AMBIENT_PARTICLE_COUNT; i++) {
    // 在基点周围做椭圆形轨道漂浮
    ambPos[i * 3]     = ambBase[i * 3]     + Math.cos(time * orbitSpeed[i]       + orbitPhase[i]) * orbitRadius[i];
    ambPos[i * 3 + 1] = ambBase[i * 3 + 1] + Math.sin(time * orbitSpeed[i] * 0.7 + orbitPhase[i]) * orbitRadius[i];
    // z 轴不变（深度固定）
  }
  ambientGeometry.attributes.position.needsUpdate = true;

  // --- 更新调试 UI ---
  if (debugBlend) debugBlend.textContent = smoothBlend.toFixed(3);

  // --- 渲染（用 composer 才有 Bloom 效果）---
  composer.render();
}

animate();


// ============================================================
// 11. 响应窗口大小变化
// ============================================================

window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;

  camera.aspect = w / h;
  camera.updateProjectionMatrix();

  renderer.setSize(w, h);
  composer.setSize(w, h);
});
