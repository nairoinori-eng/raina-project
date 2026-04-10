/**
 * Main entry — state machine, animation loop, and 60-second timeline.
 *
 * States:  IDLE  →  GUIDE (60s)  →  EXPERIENCE
 *
 * Controls:
 *   Space  – start guide (from IDLE)
 *   R      – reset to IDLE (dev helper)
 */
import { setupScene } from './scene.js';
import { ParticleSystem } from './particles.js';
import { OverlayManager } from './overlays.js';

// ── State enum ──────────────────────────────────
const State = Object.freeze({
  IDLE:       'idle',
  GUIDE:      'guide',
  EXPERIENCE: 'experience',
});

// ── Globals ─────────────────────────────────────
let state          = State.IDLE;
let guideStartTime = 0;          // seconds (performance clock)

const { scene, camera, renderer, composer, bloomPass } = setupScene();
const particles = new ParticleSystem(scene);
const overlays  = new OverlayManager();

// Pre-compute spine targets for the curved state
particles.setSpineBlend(0);

// ── State transitions ───────────────────────────

function startGuide() {
  if (state !== State.IDLE) return;
  state = State.GUIDE;
  guideStartTime = performance.now() / 1000;
  overlays.hideIdleUI();
  // Spine targets already set (blend 0 = fully curved)
}

function enterExperience() {
  state = State.EXPERIENCE;
  overlays.clearAll();
  // Experience phase would connect to sensor data here
  console.log('[raina] Experience phase started — awaiting sensor integration');
}

function resetToIdle() {
  state = State.IDLE;
  overlays.showIdleUI();
  particles.setSpineBlend(0);
  particles.setComparisonLineOpacity(0);
  bloomPass.strength = 1.2;
}

// ── Animation loop ──────────────────────────────

function animate() {
  requestAnimationFrame(animate);
  const time = performance.now() / 1000;

  switch (state) {
    case State.IDLE:
      updateIdle(time);
      break;

    case State.GUIDE: {
      const elapsed = time - guideStartTime;
      updateGuide(elapsed, time);
      if (elapsed >= 60) enterExperience();
      break;
    }

    case State.EXPERIENCE:
      updateExperience(time);
      break;
  }

  composer.render();
}

// ── IDLE update ─────────────────────────────────

function updateIdle(time) {
  particles.update({
    time,
    lerpToSpine:    0,
    spineOpacity:   0.5,
    pulseIntensity: 0,
    colorMode:      'default',
  });
}

// ── GUIDE update (60-second timeline) ───────────

function updateGuide(elapsed, time) {
  // Update all overlay elements
  overlays.updateGuide(elapsed);

  if (elapsed < 12) {
    // ─── Segment 1: "我的脊柱" (0–12s) ──────────
    // Particles coalesce into S-curve spine
    const coalesce = Math.min(1, elapsed / 4);          // ramp up 0→1 over 4s
    const pulse    = Math.min(1, Math.max(0, (elapsed - 2) / 4)); // start pulse at 2s

    particles.update({
      time,
      lerpToSpine:    coalesce,
      spineOpacity:   1,
      pulseIntensity: pulse * 0.7,
      colorMode:      'default',
    });

    // Gradually increase bloom
    bloomPass.strength = 1.2 + coalesce * 0.3;

  } else if (elapsed < 22) {
    // ─── Segment 2: "什么是脊柱侧弯" (12–22s) ──
    const segT = (elapsed - 12) / 10;   // 0→1 within segment

    // Highlight thoracic=orange / lumbar=cyan
    const highlightP = Math.min(1, segT * 2.5);   // ramp in first 4s

    particles.update({
      time,
      lerpToSpine:    1,
      spineOpacity:   1,
      pulseIntensity: 0.5,
      colorMode:      'segments',
      colorProgress:  highlightP,
    });

    // Comparison straight spine line fades in at 17s (segT ≈ 0.5)
    const lineAlpha = Math.min(0.35, Math.max(0, (segT - 0.4) * 1.2));
    particles.setComparisonLineOpacity(lineAlpha);

  } else if (elapsed < 32) {
    // ─── Segment 3a: "找到凸起侧" (22–32s) ─────
    const segT = (elapsed - 22) / 10;

    // Spine fades out, body silhouette fades in (handled by overlays)
    const spineFade = Math.max(0, 1 - segT * 3);      // fade over ~3.3s
    const lineAlpha = Math.max(0, 0.35 - segT * 1.2);  // line fades out

    particles.update({
      time,
      lerpToSpine:    1,
      spineOpacity:   spineFade,
      pulseIntensity: spineFade * 0.3,
      colorMode:      'default',
      ambientDim:     Math.min(0.4, segT),
    });
    particles.setComparisonLineOpacity(lineAlpha);

    // Soften bloom during teaching
    bloomPass.strength = 1.2 - segT * 0.3;

  } else if (elapsed < 45) {
    // ─── Segment 3b: "演示+跟做" (32–45s) ───────
    // Spine stays hidden; body + pacer active (handled by overlays)
    particles.update({
      time,
      lerpToSpine:    1,
      spineOpacity:   0,
      pulseIntensity: 0,
      ambientDim:     0.4,
    });
    particles.setComparisonLineOpacity(0);
    bloomPass.strength = 0.9;

  } else if (elapsed < 55) {
    // ─── Segment 3c: "预告" (45–55s) ────────────
    const segT = (elapsed - 45) / 10;

    // Spine fades back in, slightly straighter & warmer
    const spineFade = Math.min(1, segT * 2.5);
    const blend     = segT * 0.08;  // barely straighten (0 → 0.08)

    particles.setSpineBlend(blend);
    particles.update({
      time,
      lerpToSpine:    1,
      spineOpacity:   spineFade,
      pulseIntensity: spineFade * 0.5,
      colorMode:      'warm',
      colorProgress:  segT * 0.3,
      ambientDim:     Math.max(0, 0.4 - segT * 0.4),
    });

    // Bloom ramps up
    bloomPass.strength = 0.9 + segT * 0.6;

  } else {
    // ─── Segment 4: "开始" (55–60s) ─────────────
    const segT = (elapsed - 55) / 5;

    particles.update({
      time,
      lerpToSpine:    1,
      spineOpacity:   1,
      pulseIntensity: 0.6,
      colorMode:      'warm',
      colorProgress:  0.3 + segT * 0.1,
    });

    bloomPass.strength = 1.5 + segT * 0.3;
  }
}

// ── EXPERIENCE placeholder ──────────────────────

function updateExperience(time) {
  // Placeholder — keeps the scene alive after guide ends.
  // In production this connects to sensor data and the blend parameter.
  particles.update({
    time,
    lerpToSpine:    1,
    spineOpacity:   1,
    pulseIntensity: 0.6,
    colorMode:      'warm',
    colorProgress:  0.4,
  });
}

// ── Input handling ──────────────────────────────

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    startGuide();
  }
  if (e.code === 'KeyR') {
    e.preventDefault();
    resetToIdle();
  }
});

// Future: SocketIO button event
// socket.on('START_GUIDE', startGuide);

// ── Start ───────────────────────────────────────
animate();
console.log('[raina] 与脊柱的对话 — 按空格开始 60s 认知引导');
