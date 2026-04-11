/**
 * IntroOverlays — 86s 认知引导的 HTML/CSS 叠加层管理
 *
 * 字幕结构：按叙事段分组（group A/B/C），每组的句子按时间先后
 * 逐句出现并堆叠在前一句下方，整组左对齐在屏幕左侧。
 * 组结束时一起淡出，下一组接着在相同位置从头开始。
 */

// ── 叙事段分组的结束时间（组内句子一起淡出）──
const GROUP_ENDS = { A: 26, B: 40, C: 64 };

// ── 文字时间表 ──
//   group: 'A'|'B'|'C' → 叙事段分组；不带 group 的是倒数（居中单独显示）
const TEXT_SCHEDULE = [
  // 组 A：情感叙事 (4-26s)
  { text: '这是我的脊柱。',                              start: 4,  group: 'A' },
  { text: '十五岁那年，医生说它弯了。',                    start: 9,  group: 'A' },
  { text: '胸椎向右 <span class="hl-o">28</span> 度，腰椎向左 <span class="hl-c">18</span> 度。',
    start: 15, group: 'A' },
  { text: '它已经这样，陪我十年了。',                      start: 21, group: 'A' },

  // 组 B：病理解释 (27-40s) - 分别定位在对应脊柱高亮处旁边
  { text: '凸起的那一侧，肋骨被撑得太开；',
    start: 27, group: 'B', pos: { top: '30%', left: '6%' } },
  { text: '凹陷的那一侧，肋骨被挤在一起。',
    start: 33, group: 'B', pos: { top: '66%', left: '6%' } },

  // 组 C：呼吸原理 (45-64s)
  { text: '有一种呼吸，专门送气到凹陷的那一边，',           start: 45, group: 'C' },
  { text: '把被挤扁的肋骨，重新撑开。',                    start: 52, group: 'C' },
  { text: '跟我一起试试。',                               start: 58, group: 'C' },

  // 64-76s：呼吸节拍器 × 2 循环（无主文字）

  // 倒数（单独居中显示）
  { text: '现在，换你试试。', start: 76, end: 79, countdown: true },
  { text: '3',               start: 79, end: 80, countdown: true, big: true },
  { text: '2',               start: 80, end: 81, countdown: true, big: true },
  { text: '1',               start: 81, end: 82, countdown: true, big: true },
  { text: '开始。',           start: 82, end: 86, countdown: true },
];

// 呼吸节拍器：64-76s (12s = 2 x 6s 循环)
const PACER_START = 64, PACER_END = 76;
const BREATH_CYCLE = 6, INHALE = 3, HOLD = 1.5;

export class IntroOverlays {
  constructor() {
    this._lines = [];        // [{p, start, groupEnd}]
    this._lastCdText = null;
    this._createDOM();
  }

  _createDOM() {
    // ── IDLE UI ──
    this.$idle = document.createElement('div');
    this.$idle.id = 'intro-idle';
    this.$idle.innerHTML = `
      <h1 class="intro-title">脊时呼吸</h1>
      <p class="intro-title-en">Breathe With Your Spine</p>
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

      if (entry.pos) {
        // 独立定位：直接挂到 body 上，用 fixed 定位
        p.classList.add('intro-line-fixed');
        p.style.top  = entry.pos.top;
        p.style.left = entry.pos.left;
        document.body.appendChild(p);
      } else {
        // 堆叠：放进分组容器
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
        groupEnd: GROUP_ENDS[entry.group],
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
    // 叙事行：独立显示/淡出
    for (const { p, start, groupEnd } of this._lines) {
      if (t >= start && t < groupEnd) {
        p.classList.add('vis');
        const rem = groupEnd - t;
        p.style.opacity = rem < 0.8 ? Math.max(0, rem / 0.8) : '';
      } else {
        p.classList.remove('vis');
        p.style.opacity = '';
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

  // ── 人体（教学段 44-76s）──
  _updateBody(t) {
    if (t >= 44 && t < 76) this.$body.classList.add('vis');
    else this.$body.classList.remove('vis');

    const dot = this.$body.querySelector('.glow-dot');
    const arrow = this.$body.querySelector('.arrow-ind');
    const chest = this.$body.querySelector('.chest-exp');
    const rib   = this.$body.querySelector('.rib-half');

    if (t >= 44.5 && t < 58) dot.classList.add('vis'); else dot.classList.remove('vis');
    if (t >= 52 && t < 58)   arrow.classList.add('vis'); else arrow.classList.remove('vis');
    if (t >= 58 && t < 76) { chest.classList.add('vis'); rib.classList.add('anim'); }
    else { chest.classList.remove('vis'); rib.classList.remove('anim'); }
  }

  // ── 呼吸节拍器 ──
  _updatePacer(t) {
    if (t < PACER_START || t >= PACER_END) { this.$pacer.classList.remove('vis'); return; }
    this.$pacer.classList.add('vis');
    const ct = (t - PACER_START) % BREATH_CYCLE;
    let scale, label;
    if (ct < INHALE) { scale = 0.5 + (ct / INHALE) * 0.8; label = '吸气'; }
    else if (ct < INHALE + HOLD) { scale = 1.3; label = '撑开'; }
    else { scale = 1.3 - ((ct - INHALE - HOLD) / (BREATH_CYCLE - INHALE - HOLD)) * 0.8; label = '呼气'; }
    this.$ring.style.transform = `scale(${scale})`;
    this.$label.textContent = label;
  }
}
