/**
 * OverlayManager — controls all HTML/CSS/SVG overlays
 * for the 60-second cognitive guidance animation.
 *
 * Manages: narration text, data display, IDLE UI,
 *          body silhouette, glowing dot, arrow, chest expansion,
 *          and breathing pacer.
 */

// ── Text schedule ──────────────────────────────
const TEXT_SCHEDULE = [
  // Segment 1 — emotional connection
  { text: '这是我的脊柱。',                            start: 4,  end: 8  },
  { text: '15岁那年，我发现它弯了。',                    start: 8,  end: 12 },

  // Segment 2 — disease intro + data
  { text: '脊柱不该弯的地方弯了。\n凸起的一侧肋骨被挤在一起，\n凹陷的一侧被拉开。',
                                                       start: 12, end: 17 },
  { text: '身体一直在代偿这个不平衡。\n看起来站直了，其实里面是歪的。',
                                                       start: 17, end: 22 },

  // Segment 3a — locate convex side
  { text: '首先，找到你背部凸起的那一侧。',              start: 22, end: 27 },
  { text: '等一下，你要把气吸到这一边\n——凸起来的这边。', start: 27, end: 32 },

  // Segment 3b — breathing demo + practice
  { text: '吸气的时候，不要让胸部整体鼓起来。\n想象只用凸起这一侧的肺在呼吸。',
                                                       start: 32, end: 37 },

  // Segment 3c — preview
  { text: '接下来，你要做的就是这个动作。',              start: 45, end: 50 },
  { text: '你的每一次呼吸，\n都会改变它的形状。',        start: 50, end: 55 },

  // Segment 4 — transition
  { text: '准备好了吗？',                               start: 55, end: 58 },
  { text: '开始。',                                     start: 58, end: 60 },
];

// Breathing pacer config — teaching rhythm (faster than experience)
const BREATH_CYCLE = 6;       // seconds per cycle
const INHALE_DUR   = 3;       // seconds
const HOLD_DUR     = 1.5;     // seconds
const EXHALE_DUR   = 1.5;     // seconds
const PACER_START  = 37;      // start time within guide
const PACER_END    = 44;      // end time

// ── Class ─────────────────────────────────────
export class OverlayManager {
  constructor() {
    // Cache DOM references
    this.$idleUI        = document.getElementById('idle-ui');
    this.$guideText     = document.getElementById('guide-text');
    this.$dataDisplay   = document.getElementById('data-display');
    this.$bodyContainer = document.getElementById('body-container');
    this.$glowDot       = document.getElementById('glow-dot');
    this.$arrowSvg      = document.getElementById('arrow-svg');
    this.$chestExpand   = document.getElementById('chest-expand');
    this.$ribHalf       = this.$chestExpand?.querySelector('.rib-half');
    this.$pacer         = document.getElementById('breathing-pacer');
    this.$pacerRing     = document.getElementById('pacer-ring');
    this.$pacerLabel    = document.getElementById('pacer-label');

    this._lastTextIdx = -1;
  }

  /* ── IDLE ──────────────────────────────────── */

  hideIdleUI() {
    this.$idleUI?.classList.add('fade-out');
  }

  showIdleUI() {
    this.$idleUI?.classList.remove('fade-out');
    this.$guideText.classList.remove('visible');
    this.$guideText.textContent = '';
    this.$dataDisplay.classList.remove('visible');
    this._hideBody();
    this._hidePacer();
    this._lastTextIdx = -1;
  }

  /* ── Guide update (called every frame) ─────── */

  /**
   * Master update — call with elapsed seconds since guide start.
   */
  updateGuide(elapsed) {
    this._updateText(elapsed);
    this._updateData(elapsed);
    this._updateBody(elapsed);
    this._updatePacer(elapsed);
  }

  /* ── Text ──────────────────────────────────── */

  _updateText(t) {
    let found = -1;
    for (let i = 0; i < TEXT_SCHEDULE.length; i++) {
      const s = TEXT_SCHEDULE[i];
      if (t >= s.start && t < s.end) { found = i; break; }
    }

    if (found === -1) {
      this.$guideText.classList.remove('visible');
      this._lastTextIdx = -1;
      return;
    }

    const entry = TEXT_SCHEDULE[found];
    if (found !== this._lastTextIdx) {
      // New text — reset & fade in
      this.$guideText.classList.remove('visible');
      // Force reflow so transition replays
      void this.$guideText.offsetWidth;
      this.$guideText.textContent = entry.text;
      this.$guideText.classList.add('visible');
      this._lastTextIdx = found;
    }

    // Fade out near the end
    const remaining = entry.end - t;
    if (remaining < 0.6) {
      this.$guideText.style.opacity = Math.max(0, remaining / 0.6);
    } else {
      this.$guideText.style.opacity = '';
    }
  }

  /* ── Data display ──────────────────────────── */

  _updateData(t) {
    // Show from 20s to 22s (end of segment 2)
    if (t >= 19.5 && t < 22) {
      this.$dataDisplay.classList.add('visible');
    } else {
      this.$dataDisplay.classList.remove('visible');
    }
  }

  /* ── Body silhouette + teaching elements ───── */

  _updateBody(t) {
    // Body visible during segment 3a-3b (22–45s)
    if (t >= 22 && t < 44) {
      this.$bodyContainer.classList.add('visible');
    } else {
      this.$bodyContainer.classList.remove('visible');
    }

    // Glow dot: 22–32s
    if (t >= 22.5 && t < 32) {
      this.$glowDot.classList.add('visible');
    } else {
      this.$glowDot.classList.remove('visible');
    }

    // Arrow: 27–32s
    if (t >= 27 && t < 32) {
      this.$arrowSvg.classList.add('visible');
    } else {
      this.$arrowSvg.classList.remove('visible');
    }

    // Chest expansion: 32–44s
    if (t >= 32 && t < 44) {
      this.$chestExpand.classList.add('visible');
      this.$ribHalf?.classList.add('animating');
    } else {
      this.$chestExpand.classList.remove('visible');
      this.$ribHalf?.classList.remove('animating');
    }
  }

  _hideBody() {
    this.$bodyContainer.classList.remove('visible');
    this.$glowDot.classList.remove('visible');
    this.$arrowSvg.classList.remove('visible');
    this.$chestExpand.classList.remove('visible');
    this.$ribHalf?.classList.remove('animating');
  }

  /* ── Breathing pacer ───────────────────────── */

  _updatePacer(t) {
    if (t < PACER_START || t >= PACER_END) {
      this._hidePacer();
      return;
    }

    this.$pacer.classList.add('visible');

    const cycleT = (t - PACER_START) % BREATH_CYCLE;
    let scale, label, borderColor;

    if (cycleT < INHALE_DUR) {
      // Inhale
      const p = cycleT / INHALE_DUR;
      scale = 0.5 + p * 0.8;   // 0.5 → 1.3
      label = '吸气';
      borderColor = `rgba(200,180,255,${0.4 + p * 0.3})`;
    } else if (cycleT < INHALE_DUR + HOLD_DUR) {
      // Hold
      scale = 1.3;
      label = '停';
      borderColor = 'rgba(255,220,160,0.7)';
    } else {
      // Exhale
      const p = (cycleT - INHALE_DUR - HOLD_DUR) / EXHALE_DUR;
      scale = 1.3 - p * 0.8;   // 1.3 → 0.5
      label = '呼气';
      borderColor = `rgba(200,180,255,${0.7 - p * 0.3})`;
    }

    this.$pacerRing.style.transform    = `scale(${scale})`;
    this.$pacerRing.style.borderColor  = borderColor;
    this.$pacerLabel.textContent       = label;
  }

  _hidePacer() {
    this.$pacer.classList.remove('visible');
    this.$pacerRing.style.transform = 'scale(0.5)';
    this.$pacerLabel.textContent    = '';
  }

  /* ── Cleanup ───────────────────────────────── */

  clearAll() {
    this.$guideText.classList.remove('visible');
    this.$guideText.textContent = '';
    this.$dataDisplay.classList.remove('visible');
    this._hideBody();
    this._hidePacer();
  }
}
