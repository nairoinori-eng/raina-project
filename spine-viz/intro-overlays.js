/**
 * IntroOverlays — 60s 认知引导的 HTML/CSS 叠加层管理
 * 控制：叙事文字、个人数据、人体剪影、呼吸节拍器、IDLE UI
 */

// ── 文字时间表 ──
const TEXT_SCHEDULE = [
  { text: '这是我的脊柱。',                                              start: 4,  end: 8  },
  { text: '15岁那年，我发现它弯了。',                                      start: 8,  end: 12 },
  { text: '脊柱不该弯的地方弯了。凸起的一侧肋骨被挤在一起，凹陷的一侧被拉开。',
                                                                         start: 12, end: 17 },
  { text: '身体一直在代偿这个不平衡。看起来站直了，其实里面是歪的。',
                                                                         start: 17, end: 22 },
  { text: '首先，找到你背部凸起的那一侧。',                                start: 22, end: 27 },
  { text: '等一下，你要把气吸到这一边——凸起来的这边。',                     start: 27, end: 32 },
  { text: '吸气的时候，不要让胸部整体鼓起来。想象只用凸起这一侧的肺在呼吸。',
                                                                         start: 32, end: 37 },
  { text: '接下来，你要做的就是这个动作。',                                start: 45, end: 50 },
  { text: '你的每一次呼吸，都会改变它的形状。',                            start: 50, end: 55 },
  { text: '准备好了吗？',                                                 start: 55, end: 58 },
  { text: '开始。',                                                       start: 58, end: 60 },
];

const PACER_START = 37, PACER_END = 44;
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
      <svg viewBox="0 0 200 440" class="body-svg">
        <ellipse cx="100" cy="28" rx="15" ry="18"/>
        <line x1="100" y1="46" x2="100" y2="60"/>
        <path d="M93 60C80 60,55 72,42 88"/><path d="M107 60C120 60,145 72,158 88"/>
        <path d="M42 88Q34 135,30 185"/><path d="M158 88Q166 135,170 185"/>
        <path d="M52 88C54 135,58 185,62 235Q64 265,73 295"/>
        <path d="M148 88C146 135,142 185,138 235Q136 265,127 295"/>
        <path d="M100 60C100 95,113 140,110 190C107 240,92 275,96 305" stroke-dasharray="4,4" class="spine-line"/>
        <path d="M73 295Q70 310,73 320L82 340"/><path d="M127 295Q130 310,127 320L118 340"/>
        <line x1="82" y1="340" x2="78" y2="420"/><line x1="118" y1="340" x2="122" y2="420"/>
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

  // ── 数据 ──
  _updateData(t) {
    if (t >= 19.5 && t < 22) this.$data.classList.add('vis');
    else this.$data.classList.remove('vis');
  }

  // ── 人体 ──
  _updateBody(t) {
    if (t >= 22 && t < 44) this.$body.classList.add('vis');
    else this.$body.classList.remove('vis');

    const dot = this.$body.querySelector('.glow-dot');
    const arrow = this.$body.querySelector('.arrow-ind');
    const chest = this.$body.querySelector('.chest-exp');
    const rib   = this.$body.querySelector('.rib-half');

    if (t >= 22.5 && t < 32) dot.classList.add('vis'); else dot.classList.remove('vis');
    if (t >= 27 && t < 32) arrow.classList.add('vis'); else arrow.classList.remove('vis');
    if (t >= 32 && t < 44) { chest.classList.add('vis'); rib.classList.add('anim'); }
    else { chest.classList.remove('vis'); rib.classList.remove('anim'); }
  }

  // ── 呼吸节拍器 ──
  _updatePacer(t) {
    if (t < PACER_START || t >= PACER_END) { this.$pacer.classList.remove('vis'); return; }
    this.$pacer.classList.add('vis');
    const ct = (t - PACER_START) % BREATH_CYCLE;
    let scale, label;
    if (ct < INHALE) { scale = 0.5 + (ct / INHALE) * 0.8; label = '吸气'; }
    else if (ct < INHALE + HOLD) { scale = 1.3; label = '停'; }
    else { scale = 1.3 - ((ct - INHALE - HOLD) / (BREATH_CYCLE - INHALE - HOLD)) * 0.8; label = '呼气'; }
    this.$ring.style.transform = `scale(${scale})`;
    this.$label.textContent = label;
  }
}
