/**
 * IntroOverlays — 60s 认知引导的 HTML/CSS 叠加层管理
 * 控制：叙事文字、个人数据、人体剪影、呼吸节拍器、IDLE UI
 */

// ── 文字时间表 ──
// ── 文字时间表（总长 86s）──
const TEXT_SCHEDULE = [
  // 第一段：情感开场 (0-30s, 第一人称)
  { text: '这是我的脊柱。',                            start: 5,    end: 12 },
  { text: '十五岁那年，医生说它弯了。',                  start: 12,   end: 18 },
  { text: '胸椎向右 28 度，腰椎向左 18 度。',            start: 18,   end: 24 },
  { text: '它已经这样，陪我十年了。',                    start: 24,   end: 30 },

  // 第二段：病理解释 (30-44s)
  { text: '凸起的那一侧，肋骨被撑得太开；',              start: 30,   end: 37 },
  { text: '凹陷的那一侧，肋骨被挤在一起。',              start: 37,   end: 44 },

  // 第三段：呼吸原理 (44-58s)
  { text: '有一种呼吸，专门送气到凹陷的那一边，',         start: 44,   end: 52 },
  { text: '把被挤扁的肋骨，重新撑开。',                   start: 52,   end: 58 },

  // 第四段：跟我一起 (58-64s)
  { text: '跟我一起试试。',                              start: 58,   end: 64 },

  // 64-76s: 呼吸节拍器 × 2 循环（无主文字，由节拍器自己显示标签）

  // 第五段：换你 + 倒数 (76-86s)
  { text: '现在，换你试试。',                            start: 76,   end: 80 },
  { text: '3',                                           start: 80,   end: 81 },
  { text: '2',                                           start: 81,   end: 82 },
  { text: '1',                                           start: 82,   end: 83 },
  { text: '开始。',                                       start: 83,   end: 86 },
];

// 呼吸节拍器：64-76s (12s = 2 x 6s 循环)
const PACER_START = 64, PACER_END = 76;
const BREATH_CYCLE = 6, INHALE = 3, HOLD = 1.5;

export class IntroOverlays {
  constructor() {
    // 动态创建引导叠加层
    this._createDOM();
    this._lastTextIdx = -1;
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

    // ── 引导文字 ──
    this.$text = document.createElement('div');
    this.$text.id = 'intro-text';
    document.body.appendChild(this.$text);

    // ── 数据展示 ──
    this.$data = document.createElement('div');
    this.$data.id = 'intro-data';
    this.$data.innerHTML = '我的脊柱：胸椎右凸 <span class="hl-o">28°</span> / 腰椎左凸 <span class="hl-c">18°</span>';
    document.body.appendChild(this.$data);

    // ── 人体剪影 ──
    this.$body = document.createElement('div');
    this.$body.id = 'intro-body';
    this.$body.innerHTML = `
      <svg viewBox="0 0 240 500" class="body-svg">
        <!-- 头 -->
        <ellipse cx="120" cy="32" rx="18" ry="22"/>
        <!-- 颈 -->
        <line x1="120" y1="54" x2="120" y2="72"/>
        <!-- 肩 -->
        <path d="M110 72 C100 72, 72 78, 58 95"/>
        <path d="M130 72 C140 72, 168 78, 182 95"/>
        <!-- 手臂 -->
        <path d="M58 95 Q50 145, 44 200 Q40 230, 38 260"/>
        <path d="M182 95 Q190 145, 196 200 Q200 230, 202 260"/>
        <!-- 躯干左侧 -->
        <path d="M65 95 C68 140, 70 185, 72 230 C74 260, 78 290, 82 310"/>
        <!-- 躯干右侧 -->
        <path d="M175 95 C172 140, 170 185, 168 230 C166 260, 162 290, 158 310"/>
        <!-- 脊柱 S 弯 -->
        <path d="M120 72 C120 110, 132 155, 128 205 C124 255, 112 290, 116 325" stroke-dasharray="5,5" class="spine-line"/>
        <!-- 骨盆 -->
        <path d="M82 310 C78 320, 80 335, 88 345"/>
        <path d="M158 310 C162 320, 160 335, 152 345"/>
        <!-- 腿 -->
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
    this.$text.classList.remove('vis');
    this.$text.textContent = '';
    this.$data.classList.remove('vis');
    this.$body.classList.remove('vis');
    this.$pacer.classList.remove('vis');
    this._lastTextIdx = -1;
  }

  updateGuide(e) {
    this._updateText(e);
    this._updateData(e);
    this._updateBody(e);
    this._updatePacer(e);
  }

  clearAll() {
    this.$text.classList.remove('vis'); this.$text.textContent = '';
    this.$data.classList.remove('vis');
    this.$body.classList.remove('vis');
    this.$pacer.classList.remove('vis');
    this.$idle.classList.add('out');
  }

  // ── 文字 ──
  _updateText(t) {
    let found = -1;
    for (let i = 0; i < TEXT_SCHEDULE.length; i++) {
      if (t >= TEXT_SCHEDULE[i].start && t < TEXT_SCHEDULE[i].end) { found = i; break; }
    }
    if (found === -1) { this.$text.classList.remove('vis'); this._lastTextIdx = -1; return; }
    if (found !== this._lastTextIdx) {
      this.$text.classList.remove('vis');
      void this.$text.offsetWidth;
      this.$text.textContent = TEXT_SCHEDULE[found].text;
      this.$text.classList.add('vis');
      this._lastTextIdx = found;
    }
    const rem = TEXT_SCHEDULE[found].end - t;
    this.$text.style.opacity = rem < 0.6 ? Math.max(0, rem / 0.6) : '';
  }

  // ── 数据（与 "胸椎28°" 文字同步，18-24s）──
  _updateData(t) {
    if (t >= 18 && t < 24) this.$data.classList.add('vis');
    else this.$data.classList.remove('vis');
  }

  // ── 人体（教学段 44-76s）──
  _updateBody(t) {
    if (t >= 44 && t < 76) this.$body.classList.add('vis');
    else this.$body.classList.remove('vis');

    const dot = this.$body.querySelector('.glow-dot');
    const arrow = this.$body.querySelector('.arrow-ind');
    const chest = this.$body.querySelector('.chest-exp');
    const rib   = this.$body.querySelector('.rib-half');

    // 发光圆点：标记凹陷侧 (44.5-58s)
    if (t >= 44.5 && t < 58) dot.classList.add('vis'); else dot.classList.remove('vis');
    // 箭头：从凸起指向凹陷 (52-58s)
    if (t >= 52 && t < 58) arrow.classList.add('vis'); else arrow.classList.remove('vis');
    // 胸廓膨胀动画：跟做段 (58-76s)
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
