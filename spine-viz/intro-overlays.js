/**
 * IntroOverlays — 82s 认知引导的 HTML/CSS 叠加层管理
 *
 * 字幕：
 *   group 'A'/'B'/'D' → 同段内堆叠（新句出现在上一句下方），整段一起淡出
 *   anchor → 锚定到脊柱 3D 峰值点（独立显示）
 *   countdown: true → 居中单独显示（节拍器 prompts 等）
 *   start / end 是行的开始与结束时间（秒）
 *   分组的行用 GROUP_ENDS 控制整体淡出时间
 */

// 各分组的统一淡出时间（整体相比原版 +1s 留出"凝聚后停 1s 再上字"的留白）
const GROUP_ENDS = { A: 22, A2: 33, B: 47, D: 83 };

// ── 文字时间表 ──
const TEXT_SCHEDULE = [
  // ─── 段 1 · 知病 (5-22s) - 堆叠 group A ───
  { text: '十五岁那年，我的脊柱向我宣告了它的偏离。',          start: 5,    group: 'A' },
  { text: '统计说，每一百人中，我们这样的会有两个。',          start: 9.5,  group: 'A' },
  // 数字"标签"锚定到脊柱凸起点（像穹窿/峡谷一样独立显示）
  { text: '胸椎右凸 <span class="hl-warm">28</span> 度', start: 13.5, end: 17, anchor: 'thoracic', side: 'right' },
  { text: '腰椎左凸 <span class="hl-warm">18</span> 度', start: 13.5, end: 17, anchor: 'lumbar', side: 'left' },
  { text: '数字标定了弯折的弧度。',                          start: 15.5, group: 'A' },
  { text: '于是，身体里仿佛有了两片失衡的陆地：',              start: 18.5, group: 'A' },
  // 22s group A 整体淡出
  { text: '一侧的肋骨被温柔而固执地推开，成为撑开的穹窿。',     start: 22,   end: 27,   anchor: 'thoracic', side: 'right' },
  { text: '另一侧的则彼此靠近，蜷缩进更深的阴影里，就像幽闭的峡谷。', start: 27,   end: 31,   anchor: 'lumbar',   side: 'left' },
  { text: '我们便如此共生。',                                start: 31,   group: 'A2' },

  // ─── 段 2a/b · 学法引入 (33-47s) - 堆叠 group B ───
  { text: '但呼吸，是身体里仍能调动的事。',                    start: 33,   group: 'B' },
  { text: '有一种呼吸——它不让气息均匀地涨满胸腔，',           start: 36,   group: 'B' },
  { text: '而是有方向地，专门送往凹陷的那一侧。',              start: 39.5, group: 'B' },
  { text: '让被挤压的肋骨，从内部，一次次轻轻推开。',          start: 42.5, group: 'B' },
  { text: '这就是施罗斯呼吸法（Schroth）。',                  start: 45,   group: 'B' },

  // ─── 段 2c · 节拍器跟做 (47-75s) ───
  { text: '现在，跟着试一次。', start: 47, end: 48, countdown: true },
  // 48-72s: 节拍器 3 轮（pacer 自带 label）
  { text: '感受这道气流，正抵达那片峡谷。', start: 72, end: 75, countdown: true },

  // ─── 段 3 · 入静 (75-83s) - 堆叠 group D ───
  { text: '接下来，跟着你的呼吸——',          start: 75, group: 'D' },
  { text: '让它，慢慢回到自己的形状。',        start: 79, group: 'D' },
];

// 呼吸节拍器：48-72s = 24s = 3 轮 × 8s
const PACER_START = 48, PACER_END = 72;
const BREATH_CYCLE = 8, INHALE = 3, HOLD = 1.5;

export class IntroOverlays {
  constructor({ camera, spineGroup, anchors } = {}) {
    this._lines = [];        // [{p, start, groupEnd, anchor?, side?}]
    this._lastCdText = null;
    this._camera = camera || null;
    this._spineGroup = spineGroup || null;
    this._anchors = anchors || null;  // { thoracic: Vector3, lumbar: Vector3 }
    this._createDOM();
  }

  _createDOM() {
    // ── IDLE UI ──
    this.$idle = document.createElement('div');
    this.$idle.id = 'intro-idle';
    this.$idle.innerHTML = `
      <h1 class="intro-title">脊时呼吸</h1>
      <p class="intro-title-en">Breathe With Your Spine</p>
      <p class="intro-tagline">用呼吸，重塑一根脊柱</p>
      <p class="intro-hint">按下空格键开始体验</p>
    `;
    document.body.appendChild(this.$idle);

    // ── 叙事字幕容器（左侧固定）──
    // 按组分别创建子容器，每组是一个 flex column
    this.$text = document.createElement('div');
    this.$text.id = 'intro-text';

    const groupDivs = {};
    TEXT_SCHEDULE.forEach(entry => {
      if (entry.countdown) return;
      const p = document.createElement('p');
      p.className = 'intro-line';
      p.innerHTML = entry.text;

      if (entry.anchor) {
        // 三维锚定：每帧从 3D 点投影到屏幕，fixed 定位
        p.classList.add('intro-line-fixed');
        document.body.appendChild(p);
      } else if (entry.pos) {
        // 固定百分比定位（legacy）
        p.classList.add('intro-line-fixed');
        p.style.top  = entry.pos.top;
        p.style.left = entry.pos.left;
        document.body.appendChild(p);
      } else {
        // 堆叠：放进分组容器（同段内多句累积显示在上一句下方）
        if (!groupDivs[entry.group]) {
          const g = document.createElement('div');
          g.className = 'intro-group';
          this.$text.appendChild(g);
          groupDivs[entry.group] = g;
        }
        groupDivs[entry.group].appendChild(p);
      }

      this._lines.push({
        p,
        start: entry.start,
        groupEnd: entry.end || GROUP_ENDS[entry.group],
        anchor: entry.anchor || null,
        side: entry.side || null,
      });
    });
    document.body.appendChild(this.$text);

    // ── 倒数字幕（居中单独显示）──
    this.$countdown = document.createElement('div');
    this.$countdown.id = 'intro-countdown';
    document.body.appendChild(this.$countdown);

    // ── 人体剪影 ──
    this.$body = document.createElement('div');
    this.$body.id = 'intro-body';
    this.$body.innerHTML = `
      <svg viewBox="0 0 240 500" class="body-svg">
        <ellipse cx="120" cy="32" rx="18" ry="22"/>
        <line x1="120" y1="54" x2="120" y2="72"/>
        <path d="M110 72 C100 72, 72 78, 58 95"/>
        <path d="M130 72 C140 72, 168 78, 182 95"/>
        <path d="M58 95 Q50 145, 44 200 Q40 230, 38 260"/>
        <path d="M182 95 Q190 145, 196 200 Q200 230, 202 260"/>
        <path d="M65 95 C68 140, 70 185, 72 230 C74 260, 78 290, 82 310"/>
        <path d="M175 95 C172 140, 170 185, 168 230 C166 260, 162 290, 158 310"/>
        <path d="M120 72 C120 110, 132 155, 128 205 C124 255, 112 290, 116 325" stroke-dasharray="5,5" class="spine-line"/>
        <path d="M82 310 C78 320, 80 335, 88 345"/>
        <path d="M158 310 C162 320, 160 335, 152 345"/>
        <path d="M88 345 C86 375, 84 410, 82 450 L80 480"/>
        <path d="M152 345 C154 375, 156 410, 158 450 L160 480"/>
      </svg>
      <div class="glow-dot"></div>
      <svg class="arrow-ind" viewBox="0 0 120 30">
        <defs><marker id="ah" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
          <polygon points="0 0,10 3.5,0 7" fill="rgba(255,180,100,0.85)"/></marker></defs>
        <line x1="10" y1="15" x2="95" y2="15" stroke="rgba(255,180,100,0.85)" stroke-width="2" marker-end="url(#ah)"/>
      </svg>
      <div class="chest-exp"><div class="rib-half"></div></div>
    `;
    document.body.appendChild(this.$body);

    // ── 呼吸节拍器 ──
    this.$pacer = document.createElement('div');
    this.$pacer.id = 'intro-pacer';
    this.$pacer.innerHTML = '<div class="pacer-ring"></div><div class="pacer-label"></div>';
    document.body.appendChild(this.$pacer);
    this.$ring  = this.$pacer.querySelector('.pacer-ring');
    this.$label = this.$pacer.querySelector('.pacer-label');
  }

  hideIdleUI() { this.$idle.classList.add('out'); }

  showIdleUI() {
    this.$idle.classList.remove('out');
    this._lines.forEach(({ p }) => { p.classList.remove('vis'); p.style.opacity = ''; });
    this.$countdown.classList.remove('vis', 'big');
    this.$countdown.innerHTML = '';
    this._lastCdText = null;
    this.$body.classList.remove('vis');
    this.$pacer.classList.remove('vis');
  }

  updateGuide(e) {
    this._updateText(e);
    this._updateBody(e);
    this._updatePacer(e);
  }

  clearAll() {
    this._lines.forEach(({ p }) => { p.classList.remove('vis'); p.style.opacity = ''; });
    this.$countdown.classList.remove('vis', 'big');
    this.$countdown.innerHTML = '';
    this._lastCdText = null;
    this.$body.classList.remove('vis');
    this.$pacer.classList.remove('vis');
    this.$idle.classList.add('out');
  }

  // ── 叙事字幕（组内堆叠）+ 倒数（居中）──
  _updateText(t) {
    // 叙事行：纯 CSS transition 控制 fade in/out（避免手动 opacity 跟 CSS 冲突）
    for (const line of this._lines) {
      const { p, start, groupEnd } = line;
      if (t >= start && t < groupEnd) {
        p.classList.add('vis');
        if (line.anchor) this._positionAnchored(line);
      } else {
        p.classList.remove('vis');
      }
    }

    // 倒数
    const cd = TEXT_SCHEDULE.find(e => e.countdown && t >= e.start && t < e.end);
    if (cd) {
      if (cd.text !== this._lastCdText) {
        this.$countdown.innerHTML = cd.text;
        this.$countdown.classList.toggle('big', !!cd.big);
        this.$countdown.classList.remove('vis');
        void this.$countdown.offsetWidth;
        this.$countdown.classList.add('vis');
        this._lastCdText = cd.text;
      }
      const rem = cd.end - t;
      this.$countdown.style.opacity = rem < 0.4 ? Math.max(0, rem / 0.4) : '';
    } else {
      this.$countdown.classList.remove('vis');
      this._lastCdText = null;
    }
  }

  // ── 三维锚定字幕：把 3D 点投影到屏幕，贴着骨骼 ──
  _positionAnchored(line) {
    if (!this._camera || !this._spineGroup || !this._anchors) return;
    const anchor3D = this._anchors[line.anchor];
    if (!anchor3D) return;

    // 1. 本地 → 世界（跟随 spineGroup 的旋转/位移）
    const world = anchor3D.clone();
    this._spineGroup.localToWorld(world);
    // 2. 世界 → NDC（-1..1）
    world.project(this._camera);
    // 3. NDC → 屏幕像素
    const sx = (world.x * 0.5 + 0.5) * window.innerWidth;
    const sy = (-world.y * 0.5 + 0.5) * window.innerHeight;

    // 4. 根据 side 计算偏移。右侧：锚点右 +40px；左侧：文字右缘在锚点左 -40px
    const GAP = 40;
    const p = line.p;
    if (line.side === 'right') {
      p.style.left = `${sx + GAP}px`;
    } else {
      // 先测量文字宽度（offsetWidth 在 vis 状态下有效）
      const w = p.offsetWidth || 300;
      p.style.left = `${sx - GAP - w}px`;
    }
    // 垂直方向：让文字中线对齐锚点 y
    const h = p.offsetHeight || 24;
    p.style.top = `${sy - h * 0.5}px`;
  }

  // ── 人体剪影：批次 1 暂时隐藏（批次 2 重新设计或移除）──
  _updateBody(_t) {
    this.$body.classList.remove('vis');
    const dot = this.$body.querySelector('.glow-dot');
    const arrow = this.$body.querySelector('.arrow-ind');
    const chest = this.$body.querySelector('.chest-exp');
    const rib   = this.$body.querySelector('.rib-half');
    if (dot)   dot.classList.remove('vis');
    if (arrow) arrow.classList.remove('vis');
    if (chest) chest.classList.remove('vis');
    if (rib)   rib.classList.remove('anim');
  }

  // ── 呼吸节拍器：3 轮跟做 ──
  // 轮 1（47-55s）：完整指令（吸气-把气送向凹陷的那一侧 / 撑开-让肋骨从内部张开 / 呼气-慢慢让气出来）
  // 轮 2（55-63s）：简化（吸气 / 撑开 / 呼气）
  // 轮 3（63-71s）：纯视觉，无字（71-74s 由 TEXT_SCHEDULE 显示"感受这道气流..."）
  // 同时计算 _pacerBreatheT 供 app.js 同步脊柱呼吸
  _updatePacer(t) {
    if (t < PACER_START || t >= PACER_END) {
      this.$pacer.classList.remove('vis');
      this._pacerBreatheT = 0;
      return;
    }
    this.$pacer.classList.add('vis');

    const elapsed = t - PACER_START;
    const cycleIndex = Math.floor(elapsed / BREATH_CYCLE);  // 0 / 1 / 2
    const ct = elapsed % BREATH_CYCLE;

    let breatheT, phase;
    if (ct < INHALE) {
      breatheT = ct / INHALE;
      phase = 'inhale';
    } else if (ct < INHALE + HOLD) {
      breatheT = 1.0;
      phase = 'hold';
    } else {
      breatheT = 1 - (ct - INHALE - HOLD) / (BREATH_CYCLE - INHALE - HOLD);
      phase = 'exhale';
    }
    this._pacerBreatheT = breatheT;

    // 每轮文字
    let label = '';
    if (cycleIndex === 0) {
      if (phase === 'inhale')      label = '吸气 — 把气送向凹陷的那一侧';
      else if (phase === 'hold')   label = '撑开 — 让肋骨从内部张开';
      else                         label = '呼气 — 慢慢让气出来';
    } else if (cycleIndex === 1) {
      if (phase === 'inhale')      label = '吸气';
      else if (phase === 'hold')   label = '撑开';
      else                         label = '呼气';
    }
    // cycle 2 (轮 3): 无字

    const scale = 0.5 + breatheT * 0.8;
    this.$ring.style.transform = `scale(${scale})`;
    this.$label.textContent = label;
  }

  // 给 app.js 用：返回当前节拍器呼吸进度（0=收缩底, 1=吸到顶/撑开峰）
  getPacerBreatheT() {
    return this._pacerBreatheT || 0;
  }
}
