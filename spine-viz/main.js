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
const AMBIENT_PARTICLE_COUNT = 300;

// 颜色关键帧（blend 从 0→1 时的色彩变化）
const COLOR_DARK_PURPLE = new THREE.Color(0x2d1b69);  // blend=0  深蓝紫
const COLOR_MID_PURPLE  = new THREE.Color(0x7b4fb5);  // blend=0.5 浅紫
const COLOR_WARM_GOLD   = new THREE.Color(0xd4a24c);  // blend=1   暖金


// ============================================================
// 2. 场景初始化
// ============================================================

const canvas = document.getElementById('spine-canvas');

// 渲染器：WebGL，抗锯齿
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.NoToneMapping;  // 关闭 tone mapping，Bloom 效果更准

// 场景
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

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
 * 让每个粒子看起来像柔和的发光光点，而不是硬边圆圈
 *
 * vertexShader（顶点着色器）：决定每个粒子的位置和大小
 * fragmentShader（片元着色器）：决定每个粒子的颜色和透明度
 */
const spineVertexShader = /* glsl */`
  // 从 CPU 传来的每个粒子数据
  attribute float aSize;   // 粒子大小
  attribute float aAlpha;  // 粒子透明度

  // 传给片元着色器的数据
  varying float vAlpha;

  void main() {
    vAlpha = aAlpha;
    // 计算粒子在屏幕上的位置
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    // 大小随距离变化（近大远小），300.0 是缩放系数
    gl_PointSize = aSize * (300.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const spineFragmentShader = /* glsl */`
  uniform vec3 uColor;   // 整体颜色（由 blend 值决定）
  varying float vAlpha;

  void main() {
    // gl_PointCoord：当前像素在粒子内的位置（0-1，中心是0.5,0.5）
    float d = length(gl_PointCoord - vec2(0.5));

    // 超出圆形范围直接丢弃（不渲染）
    if (d > 0.5) discard;

    // 高斯衰减：中心最亮，边缘渐隐（exp 函数产生柔和的发光效果）
    float alpha = exp(-d * d * 10.0) * vAlpha;

    gl_FragColor = vec4(uColor, alpha);
  }
`;

// 创建脊柱粒子材质
const spineMaterial = new THREE.ShaderMaterial({
  vertexShader: spineVertexShader,
  fragmentShader: spineFragmentShader,
  uniforms: {
    uColor: { value: COLOR_DARK_PURPLE.clone() },  // 初始颜色
  },
  transparent: true,
  blending: THREE.AdditiveBlending,   // 叠加模式：粒子重叠时更亮（产生发光感）
  depthWrite: false,                  // 不写深度缓冲，避免透明粒子遮挡问题
});

// 构建粒子几何体数据
// 分别存储弯曲状态和直立状态的坐标，在 CPU 端做插值后传给 GPU
const spineGeometry = new THREE.BufferGeometry();

// 用 CatmullRomCurve3 将 13 个控制点插值成平滑曲线，然后采样 1000 个点
const curveCurved   = new THREE.CatmullRomCurve3(SPINE_CURVED);
const curveStraight = new THREE.CatmullRomCurve3(SPINE_STRAIGHT);

const pointsCurved   = curveCurved.getPoints(SPINE_PARTICLE_COUNT - 1);
const pointsStraight = curveStraight.getPoints(SPINE_PARTICLE_COUNT - 1);

// 为每个粒子生成随机偏移（让粒子形成"带状"而不是一条细线）
const offsets = [];
for (let i = 0; i < SPINE_PARTICLE_COUNT; i++) {
  // 在曲线垂直方向随机偏移 ±0.06
  offsets.push((Math.random() - 0.5) * 0.12);  // x 偏移
  offsets.push((Math.random() - 0.5) * 0.03);  // y 偏移（垂直方向偏移小一点）
}

// 粒子当前位置（初始 = 弯曲状态）
const positions = new Float32Array(SPINE_PARTICLE_COUNT * 3);
// 粒子大小（随机，2-6 范围）
const sizes     = new Float32Array(SPINE_PARTICLE_COUNT);
// 粒子透明度（随机，增加视觉层次感）
const alphas    = new Float32Array(SPINE_PARTICLE_COUNT);

for (let i = 0; i < SPINE_PARTICLE_COUNT; i++) {
  const p = pointsCurved[i];
  positions[i * 3]     = p.x + offsets[i * 2];
  positions[i * 3 + 1] = p.y + offsets[i * 2 + 1];
  positions[i * 3 + 2] = 0;

  sizes[i]  = 2 + Math.random() * 4;       // 随机大小 2-6
  alphas[i] = 0.4 + Math.random() * 0.6;   // 随机透明度 0.4-1.0
}

spineGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
spineGeometry.setAttribute('aSize',    new THREE.BufferAttribute(sizes, 1));
spineGeometry.setAttribute('aAlpha',   new THREE.BufferAttribute(alphas, 1));

const spineParticles = new THREE.Points(spineGeometry, spineMaterial);
scene.add(spineParticles);


// ============================================================
// 4. 环境微粒（背景漂浮的星尘）
// ============================================================

const ambientGeometry = new THREE.BufferGeometry();
const ambientPositions = new Float32Array(AMBIENT_PARTICLE_COUNT * 3);
const ambientSizes     = new Float32Array(AMBIENT_PARTICLE_COUNT);
const ambientAlphas    = new Float32Array(AMBIENT_PARTICLE_COUNT);
// 每个微粒的漂移速度（用于动画）
const ambientVelocities = [];

for (let i = 0; i < AMBIENT_PARTICLE_COUNT; i++) {
  // 随机分布在 [-3, 3] × [-2.5, 2.5] 的矩形区域
  ambientPositions[i * 3]     = (Math.random() - 0.5) * 6;
  ambientPositions[i * 3 + 1] = (Math.random() - 0.5) * 5;
  ambientPositions[i * 3 + 2] = (Math.random() - 0.5) * 2;

  ambientSizes[i]  = 0.5 + Math.random() * 1.5;
  ambientAlphas[i] = 0.05 + Math.random() * 0.2;

  // 随机漂移速度（很慢，产生缓慢飘浮感）
  ambientVelocities.push(
    (Math.random() - 0.5) * 0.003,
    (Math.random() - 0.5) * 0.002,
  );
}

ambientGeometry.setAttribute('position', new THREE.BufferAttribute(ambientPositions, 3));
ambientGeometry.setAttribute('aSize',    new THREE.BufferAttribute(ambientSizes, 1));
ambientGeometry.setAttribute('aAlpha',   new THREE.BufferAttribute(ambientAlphas, 1));

// 环境微粒用同样的着色器，但颜色固定为暗蓝紫
const ambientMaterial = new THREE.ShaderMaterial({
  vertexShader: spineVertexShader,
  fragmentShader: spineFragmentShader,
  uniforms: {
    uColor: { value: new THREE.Color(0x3a2060) },
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

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.8,   // strength：发光强度（随 blend 动态调整）
  0.4,   // radius：发光半径
  0.1,   // threshold：亮度阈值（超过这个值的像素才发光）
);
composer.addPass(bloomPass);


// ============================================================
// 6. 状态管理和 blend 控制
// ============================================================

let currentMode = 'IDLE';
let targetBlend = 0.0;    // 目标 blend 值（从传感器/滑块接收）
let smoothBlend = 0.0;    // 平滑后的 blend 值（EMA 滤波，防止跳变）


/**
 * 更新脊柱粒子位置
 * 根据 smoothBlend 在弯曲坐标和直立坐标之间插值
 * 每一帧调用一次
 */
function updateSpinePositions() {
  const pos = spineGeometry.attributes.position.array;

  for (let i = 0; i < SPINE_PARTICLE_COUNT; i++) {
    const curved   = pointsCurved[i];
    const straight = pointsStraight[i];

    // 线性插值（lerp）：blend=0 用弯曲坐标，blend=1 用直立坐标
    pos[i * 3]     = curved.x + (straight.x - curved.x) * smoothBlend + offsets[i * 2];
    pos[i * 3 + 1] = curved.y + (straight.y - curved.y) * smoothBlend + offsets[i * 2 + 1];
    pos[i * 3 + 2] = 0;
  }

  // 告诉 GPU 位置数据已更新，需要重新上传
  spineGeometry.attributes.position.needsUpdate = true;
}


/**
 * 根据 blend 值计算当前颜色
 * 0 → 深蓝紫，0.5 → 浅紫，1 → 暖金
 */
function getBlendColor(blend) {
  const color = new THREE.Color();
  if (blend < 0.5) {
    // 前半段：深蓝紫 → 浅紫
    color.lerpColors(COLOR_DARK_PURPLE, COLOR_MID_PURPLE, blend * 2);
  } else {
    // 后半段：浅紫 → 暖金
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

// 接收传感器数据（或模拟数据）
socket.on('sensor_data', (data) => {
  targetBlend = data.blend;
  updateDebugUI();
});

// 接收状态变化
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

// 滑块控制 blend（模拟呼吸）
blendSlider.addEventListener('input', () => {
  const value = blendSlider.value / 100;
  // 发送给 Flask，Flask 再广播回来（走 SocketIO 完整链路）
  socket.emit('set_blend', { value });
});

// 按钮：开始体验
btnStart.addEventListener('click', () => {
  socket.emit('button_press');
});

// 按钮：重置
btnReset.addEventListener('click', () => {
  // 先切到 SHOWING 状态，再按按钮就会重置
  // 简单做法：直接发 button_press，如果当前是 IDLE 就进入 GUIDE
  socket.emit('button_press');
});

// 更新调试面板显示
function updateDebugUI() {
  if (debugState) debugState.textContent = currentMode;
  if (debugBlend) debugBlend.textContent = smoothBlend.toFixed(3);
}


// ============================================================
// 9. 键盘快捷键
// ============================================================

document.addEventListener('keydown', (e) => {
  if (e.key === 'd' || e.key === 'D') {
    // D 键：显示/隐藏调试面板
    debugPanel.classList.toggle('hidden');
  }

  if (e.key === 'f' || e.key === 'F') {
    // F 键：全屏（展览时用）
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
  time += 0.016;  // 约 60fps，每帧 ~16ms

  // --- EMA 平滑 blend 值（防止传感器数据跳变导致粒子抖动）---
  // 平滑系数 0.08：值越小越平滑，但响应也越慢
  // 0.08 大约对应 0.5 秒的平滑时间
  smoothBlend += (targetBlend - smoothBlend) * 0.08;

  // --- 更新脊柱粒子位置（根据 blend 插值）---
  updateSpinePositions();

  // --- 粒子呼吸脉动（大小随时间微弱变化，产生"活着"的感觉）---
  const pulse = 1.0 + Math.sin(time * 0.8) * 0.1;  // ±10% 大小变化
  const sizeAttr = spineGeometry.attributes.aSize.array;
  for (let i = 0; i < SPINE_PARTICLE_COUNT; i++) {
    sizeAttr[i] = sizes[i] * pulse;
  }
  spineGeometry.attributes.aSize.needsUpdate = true;

  // --- 更新颜色（根据 blend 值）---
  const currentColor = getBlendColor(smoothBlend);
  spineMaterial.uniforms.uColor.value.copy(currentColor);

  // --- 更新 Bloom 强度（blend 越高，发光越强）---
  bloomPass.strength = 0.4 + smoothBlend * 0.8;  // 0.4 → 1.2

  // --- 更新环境微粒位置（缓慢漂浮）---
  const ambPos = ambientGeometry.attributes.position.array;
  for (let i = 0; i < AMBIENT_PARTICLE_COUNT; i++) {
    ambPos[i * 3]     += ambientVelocities[i * 2];
    ambPos[i * 3 + 1] += ambientVelocities[i * 2 + 1];

    // 碰到边界折返（在 [-3, 3] 范围内来回）
    if (Math.abs(ambPos[i * 3])     > 3.0) ambientVelocities[i * 2]     *= -1;
    if (Math.abs(ambPos[i * 3 + 1]) > 2.5) ambientVelocities[i * 2 + 1] *= -1;
  }
  ambientGeometry.attributes.position.needsUpdate = true;

  // --- 更新调试 UI（每帧刷新 blend 显示）---
  if (debugBlend) debugBlend.textContent = smoothBlend.toFixed(3);

  // --- 渲染（用 composer 而不是 renderer，才有 Bloom 效果）---
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
