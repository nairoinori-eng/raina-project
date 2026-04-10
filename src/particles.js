/**
 * Particle system for spine visualization.
 *
 * Uses Points + custom ShaderMaterial with per-particle
 * position, color, size, and opacity attributes.
 */
import * as THREE from 'three';
import { createSpineCurve, getSegment } from './spine.js';

// ── Constants ───────────────────────────────────
const SPINE_COUNT   = 800;
const AMBIENT_COUNT = 2200;
const TOTAL         = SPINE_COUNT + AMBIENT_COUNT;

// ── Shaders ─────────────────────────────────────
const vertexShader = /* glsl */ `
  attribute float aSize;
  attribute float aOpacity;
  attribute vec3  aColor;

  varying vec3  vColor;
  varying float vOpacity;

  void main() {
    vColor   = aColor;
    vOpacity = aOpacity;

    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(aSize * (160.0 / -mv.z), 1.0, 45.0);
    gl_Position  = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3  vColor;
  varying float vOpacity;

  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;
    float a = exp(-d * d * 10.0) * vOpacity;
    gl_FragColor = vec4(vColor, a);
  }
`;

// ── Helpers ─────────────────────────────────────

/** Random number in [lo, hi) */
function rand(lo, hi) { return lo + Math.random() * (hi - lo); }

/** HSL → THREE.Color shorthand */
function hsl(h, s, l) { return new THREE.Color().setHSL(h, s, l); }

// ── Class ───────────────────────────────────────
export class ParticleSystem {
  constructor(scene) {
    this.scene = scene;

    // Per-particle bookkeeping
    this.basePos   = [];   // IDLE random positions
    this.curPos    = [];   // current positions
    this.vel       = [];   // IDLE drift velocities
    this.spineT    = [];   // t along spine (spine particles only)
    this.spineOff  = [];   // fixed random offset from spine center (spine particles only)
    this.targets   = [];   // current target positions (all particles)

    this._initGeometry();
    this._initSpineMapping();

    // Normal comparison line (hidden by default)
    this.comparisonLine = this._createComparisonLine();
  }

  /* ── Initialisation ─────────────────────────── */

  _initGeometry() {
    const pos     = new Float32Array(TOTAL * 3);
    const colors  = new Float32Array(TOTAL * 3);
    const sizes   = new Float32Array(TOTAL);
    const opacs   = new Float32Array(TOTAL);

    for (let i = 0; i < TOTAL; i++) {
      // Scatter randomly
      const x = rand(-9, 9);
      const y = rand(-6, 6);
      const z = rand(-2.5, 2.5);

      pos[i * 3]     = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;

      const p = new THREE.Vector3(x, y, z);
      this.basePos.push(p.clone());
      this.curPos.push(p.clone());
      this.targets.push(p.clone());

      this.vel.push(new THREE.Vector3(
        rand(-0.003, 0.003),
        rand(-0.002, 0.002),
        rand(-0.001, 0.001),
      ));

      // Blue-purple palette with variation
      const c = hsl(rand(0.68, 0.82), rand(0.25, 0.5), rand(0.25, 0.45));
      colors[i * 3]     = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;

      sizes[i] = i < SPINE_COUNT ? rand(1.8, 3.5) : rand(1.0, 2.5);
      opacs[i] = i < SPINE_COUNT ? rand(0.4, 0.7) : rand(0.15, 0.4);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor',   new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('aSize',    new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('aOpacity', new THREE.BufferAttribute(opacs, 1));

    const mat = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.geometry = geo;
    this.material = mat;
    this.points   = new THREE.Points(geo, mat);
    this.scene.add(this.points);
  }

  _initSpineMapping() {
    for (let i = 0; i < SPINE_COUNT; i++) {
      this.spineT.push(i / (SPINE_COUNT - 1));
      this.spineOff.push(new THREE.Vector3(
        rand(-0.08, 0.08),
        rand(-0.03, 0.03),
        rand(-0.18, 0.18),
      ));
    }
  }

  _createComparisonLine() {
    const curve  = createSpineCurve(1.0); // fully straight
    const pts    = curve.getPoints(60);
    const geo    = new THREE.BufferGeometry().setFromPoints(pts);
    const mat    = new THREE.LineBasicMaterial({
      color: 0x888888,
      transparent: true,
      opacity: 0,
    });
    const line = new THREE.Line(geo, mat);
    this.scene.add(line);
    return line;
  }

  /* ── Spine target helpers ───────────────────── */

  /** Recompute spine particle targets for a given blend. */
  setSpineBlend(blend) {
    const curve = createSpineCurve(blend);
    for (let i = 0; i < SPINE_COUNT; i++) {
      const pt = curve.getPoint(this.spineT[i]);
      this.targets[i].copy(pt).add(this.spineOff[i]);
    }
  }

  /* ── Per-frame updates ──────────────────────── */

  /**
   * Main per-frame update.
   * @param {object} p
   * @param {number} p.time           – absolute clock (seconds)
   * @param {number} p.lerpToSpine    – 0 = IDLE drift, 1 = fully at spine (spine particles)
   * @param {number} p.spineOpacity   – opacity multiplier for spine particles [0-1]
   * @param {number} p.pulseIntensity – breathing pulse amplitude [0-1]
   * @param {string} p.colorMode      – 'default' | 'segments' | 'warm'
   * @param {number} p.colorProgress  – transition progress for color mode [0-1]
   * @param {number} p.ambientDim     – dim ambient particles [0-1, 0 = normal]
   */
  update({
    time = 0,
    lerpToSpine = 0,
    spineOpacity = 1,
    pulseIntensity = 0,
    colorMode = 'default',
    colorProgress = 0,
    ambientDim = 0,
  } = {}) {
    const pos  = this.geometry.attributes.position.array;
    const cols = this.geometry.attributes.aColor.array;
    const szs  = this.geometry.attributes.aSize.array;
    const ops  = this.geometry.attributes.aOpacity.array;

    for (let i = 0; i < TOTAL; i++) {
      const cur = this.curPos[i];

      if (i < SPINE_COUNT) {
        // ── Spine particle ──
        if (lerpToSpine > 0) {
          const target = this.targets[i];
          const factor = Math.min(lerpToSpine * 0.06, 0.12);
          cur.lerp(target, factor);
        } else {
          // Idle drift
          cur.add(this.vel[i]);
          this._bounceCheck(cur, this.vel[i], 9, 6, 2.5);
        }

        // Pulse
        const baseSz = 2.2 + (i % 5) * 0.25;
        const pulse  = Math.sin(time * 2.0 + i * 0.08) * 0.6 * pulseIntensity;
        szs[i] = baseSz + pulse;

        // Opacity
        const breathAlpha = 0.5 + Math.sin(time * 1.5 + i * 0.12) * 0.15 * pulseIntensity;
        ops[i] = Math.max(0, breathAlpha * spineOpacity);

        // Color
        this._updateColor(i, cols, colorMode, colorProgress, time);
      } else {
        // ── Ambient particle ──
        cur.add(this.vel[i]);
        this._bounceCheck(cur, this.vel[i], 9, 6, 2.5);
        ops[i] = (0.15 + Math.sin(time * 0.7 + i * 0.05) * 0.08) * (1 - ambientDim * 0.5);
      }

      pos[i * 3]     = cur.x;
      pos[i * 3 + 1] = cur.y;
      pos[i * 3 + 2] = cur.z;
    }

    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aColor.needsUpdate   = true;
    this.geometry.attributes.aSize.needsUpdate    = true;
    this.geometry.attributes.aOpacity.needsUpdate  = true;
  }

  /** Boundary bounce for drifting particles */
  _bounceCheck(p, v, bx, by, bz) {
    if (Math.abs(p.x) > bx) { v.x *= -1; p.x = THREE.MathUtils.clamp(p.x, -bx, bx); }
    if (Math.abs(p.y) > by) { v.y *= -1; p.y = THREE.MathUtils.clamp(p.y, -by, by); }
    if (Math.abs(p.z) > bz) { v.z *= -1; p.z = THREE.MathUtils.clamp(p.z, -bz, bz); }
  }

  /** Per-particle color update based on mode */
  _updateColor(i, cols, mode, progress, time) {
    const t   = this.spineT[i];
    const idx = i * 3;

    if (mode === 'segments' && progress > 0) {
      // Thoracic → warm orange, Lumbar → cyan
      const seg = getSegment(t);
      const targetR = seg === 'thoracic' ? 1.0  : 0.2;
      const targetG = seg === 'thoracic' ? 0.55 : 0.75;
      const targetB = seg === 'thoracic' ? 0.2  : 0.85;
      // Pulsing brightness on highlighted particles
      const bright = 1.0 + Math.sin(time * 3 + i * 0.15) * 0.15;
      cols[idx]     = THREE.MathUtils.lerp(cols[idx],     targetR * bright, progress * 0.05);
      cols[idx + 1] = THREE.MathUtils.lerp(cols[idx + 1], targetG * bright, progress * 0.05);
      cols[idx + 2] = THREE.MathUtils.lerp(cols[idx + 2], targetB * bright, progress * 0.05);
    } else if (mode === 'warm' && progress > 0) {
      // Shift toward warm gold
      cols[idx]     = THREE.MathUtils.lerp(cols[idx],     0.85, progress * 0.03);
      cols[idx + 1] = THREE.MathUtils.lerp(cols[idx + 1], 0.65, progress * 0.03);
      cols[idx + 2] = THREE.MathUtils.lerp(cols[idx + 2], 0.3,  progress * 0.03);
    } else if (mode === 'default') {
      // Revert toward blue-purple
      const def = hsl(0.72 + t * 0.1, 0.4, 0.35);
      cols[idx]     = THREE.MathUtils.lerp(cols[idx],     def.r, 0.02);
      cols[idx + 1] = THREE.MathUtils.lerp(cols[idx + 1], def.g, 0.02);
      cols[idx + 2] = THREE.MathUtils.lerp(cols[idx + 2], def.b, 0.02);
    }
  }

  /* ── Comparison line helpers ────────────────── */

  setComparisonLineOpacity(opacity) {
    this.comparisonLine.material.opacity = opacity;
  }
}
