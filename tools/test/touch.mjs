// 觸控輸入無頭測試：以最小 DOM mock 載入 src/touch.js 與 src/input.js，模擬搖桿 / 鏡頭拖曳 / 按鈕 / 失焦
// 另測 src/mobile.js 的自適應解析度控制器邊界。用法：node tools/test/touch.mjs（任一斷言失敗 exit 1）

// ---------- 最小 DOM mock ----------
class ClassList {
  constructor() {
    this.set = new Set();
  }
  add(...c) {
    c.forEach((x) => this.set.add(x));
  }
  remove(...c) {
    c.forEach((x) => this.set.delete(x));
  }
  contains(c) {
    return this.set.has(c);
  }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : !!force;
    if (on) this.set.add(c);
    else this.set.delete(c);
    return on;
  }
}

class Target {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this.listeners.get(type);
    if (l) this.listeners.set(type, l.filter((f) => f !== fn));
  }
  dispatch(type, props = {}) {
    const e = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...props };
    for (const fn of this.listeners.get(type) || []) fn(e);
    return e;
  }
}

class El extends Target {
  constructor(tag) {
    super();
    this.tagName = tag;
    this.id = '';
    this.children = [];
    this.parent = null;
    this.style = {};
    this.attrs = {};
    this.classList = new ClassList();
    this.textContent = '';
  }
  set className(v) {
    this.classList = new ClassList();
    v.split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  appendChild(c) {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  setPointerCapture() {}
  find(id) {
    if (this.id === id) return this;
    for (const c of this.children) {
      const r = c.find(id);
      if (r) return r;
    }
    return null;
  }
}

const body = new El('body');
const docEl = new El('html');
const document = new Target();
Object.assign(document, {
  body,
  documentElement: docEl,
  visibilityState: 'visible',
  pointerLockElement: null,
  createElement: (t) => new El(t),
  getElementById: (id) => body.find(id),
});
const window = new Target();
Object.assign(window, {
  innerWidth: 1000,
  innerHeight: 500,
  devicePixelRatio: 3,
  location: { search: '?touch=1' },
  navigator: {},
  screen: { width: 500, height: 1000 },
  matchMedia: () => ({ matches: false }),
});
let fsRequests = 0;
docEl.requestFullscreen = () => {
  fsRequests++;
  return Promise.resolve();
};
window.screen.orientation = { lock: () => Promise.reject(new Error('不支援')) };
// index.html 的靜態元素
for (const id of ['start-btn', 'fs-back', 'swipe-up']) {
  const e = body.appendChild(new El('button'));
  e.id = id;
  if (id !== 'start-btn') e.classList.add('hidden');
}
globalThis.window = window;
globalThis.document = document;

const { Input } = await import('../../src/input.js');
const touch = await import('../../src/touch.js');
const mobile = await import('../../src/mobile.js');

// ---------- 斷言 ----------
let pass = 0;
let total = 0;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
function check(name, ok, detail = '') {
  total++;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
}

const input = new Input(new El('canvas'));
input.enabled = true;
const $ = (id) => document.getElementById(id);
const pad = $('touch-pad');
const look = $('touch-look');
const pe = (id, x, y) => ({ pointerId: id, clientX: x, clientY: y });

check('body.touch 已設定', body.classList.contains('touch') && mobile.isTouch());
check('觸控 DOM 已建立', !!pad && !!look && !!$('tstick-base') && !!$('tb-jump') && !!$('tb-gas'));
check('初始為步行模式', body.classList.contains('touch-walk') && !body.classList.contains('touch-drive'));

// 1. 左搖桿推到 (+64, 0)
pad.dispatch('pointerdown', pe(1, 200, 300));
pad.dispatch('pointermove', pe(1, 264, 300));
let a = input.moveAxis();
check('搖桿 (+64,0) → x≈1', near(a.x, 1, 1e-3) && near(a.y, 0) && a.analog, `x=${a.x.toFixed(4)} mag=${a.mag.toFixed(4)}`);
check('搖桿相容層：KeyD + ShiftLeft', input.down('KeyD') && input.down('ShiftLeft') && !input.down('KeyW'));
pad.dispatch('pointermove', pe(1, 200, 236));
a = input.moveAxis();
check('搖桿 (0,-64) → y≈1（往上 = 前）', near(a.y, 1, 1e-3) && near(a.x, 0, 1e-9) && input.down('KeyW'), `y=${a.y.toFixed(4)}`);
pad.dispatch('pointermove', pe(1, 400, 300));
a = input.moveAxis();
check('超出半徑 clamp 到 1', near(a.x, 1, 1e-3) && a.mag <= 1);
// 2. 死區
pad.dispatch('pointermove', pe(1, 204, 300)); // 4px / 64 = 0.0625 < 0.08
a = input.moveAxis();
check('死區內 → 0', a.x === 0 && a.y === 0 && !a.analog && !input.down('KeyD'), `x=${a.x}`);
pad.dispatch('pointermove', pe(1, 232, 300)); // 0.5 → (0.5-0.08)/0.92
a = input.moveAxis();
check('死區重映射 0.5 → 0.4565', near(a.x, 0.42 / 0.92, 1e-4) && !input.down('KeyD'), `x=${a.x.toFixed(4)}`);

// 3. 兩指同時：左搖桿 + 右拖鏡頭
pad.dispatch('pointermove', pe(1, 264, 300));
look.dispatch('pointerdown', pe(2, 700, 250));
look.dispatch('pointermove', pe(2, 800, 270));
pad.dispatch('pointermove', pe(3, 100, 100)); // 別的指標在搖桿區移動不影響
a = input.moveAxis();
const k = Math.PI / (0.0045 * window.innerWidth);
check('雙指：搖桿維持 x≈1', near(a.x, 1, 1e-3));
check('雙指：鏡頭 dx/dy 累加', near(input.dx, 100 * k, 1e-6) && near(input.dy, 20 * k, 1e-6), `dx=${input.dx.toFixed(2)} dy=${input.dy.toFixed(2)}`);
check('拖一個螢幕寬 ≈ 180°', near(window.innerWidth * k * 0.0045, Math.PI, 1e-9));
const m = input.consumeMouse();
check('consumeMouse 取出後歸零', m.dx > 0 && input.dx === 0);
// 捏合
look.dispatch('pointerdown', pe(4, 900, 250)); // 與 id2 (800,270) 距離
const d0 = Math.hypot(100, 20);
look.dispatch('pointermove', pe(4, 950, 250));
const d1 = Math.hypot(150, 20);
check('雙指捏合張開 → wheel 負（拉近）', near(input.wheel, -(d1 - d0) * 2, 1e-6) && input.dx === 0, `wheel=${input.wheel.toFixed(2)}`);
look.dispatch('pointerup', pe(4, 950, 250));
// pointercancel
pad.dispatch('pointercancel', pe(1, 264, 300));
a = input.moveAxis();
check('pointercancel 後搖桿歸零', a.x === 0 && a.y === 0 && !input.down('KeyD') && !input.down('ShiftLeft'));
look.dispatch('pointercancel', pe(2, 800, 270));
input.consumeMouse();
look.dispatch('pointermove', pe(2, 900, 270));
check('pointercancel 後鏡頭不再累加', input.dx === 0);
// lostpointercapture 也視為結束
pad.dispatch('pointerdown', pe(5, 200, 300));
pad.dispatch('pointermove', pe(5, 136, 300));
check('搖桿向左 → KeyA', input.down('KeyA') && near(input.moveAxis().x, -1, 1e-3));
pad.dispatch('lostpointercapture', pe(5, 136, 300));
check('lostpointercapture 後歸零', input.moveAxis().x === 0 && !input.down('KeyA'));

// 4. 按鈕
const jump = $('tb-jump');
jump.dispatch('pointerdown', pe(6, 900, 400));
check('tap（跳）→ pressed 含 Space', input.wasPressed('Space') && !input.down('Space'));
jump.dispatch('pointerup', pe(6, 900, 400));
input.endFrame();
check('endFrame 清除 pressed', !input.wasPressed('Space'));
const run = $('tb-run');
run.dispatch('pointerdown', pe(7, 800, 400));
check('hold（跑）→ keys 含 ShiftLeft', input.down('ShiftLeft') && input.wasPressed('ShiftLeft') && run.classList.contains('active'));
run.dispatch('pointerup', pe(7, 800, 400));
check('放開 → keys 移除 ShiftLeft', !input.down('ShiftLeft') && !run.classList.contains('active'));
input.endFrame();

// 5. 模式切換（hud.js 依 state.driving 呼叫）
touch.setTouchMode('drive');
check('駕駛模式 body class', body.classList.contains('touch-drive') && !body.classList.contains('touch-walk'));
const gas = $('tb-gas');
gas.dispatch('pointerdown', pe(8, 900, 400));
a = input.moveAxis();
check('油門鈕 → KeyW 且 moveAxis.y=1（數位）', input.down('KeyW') && a.y === 1 && !a.analog);
pad.dispatch('pointerdown', pe(9, 200, 300));
pad.dispatch('pointermove', pe(9, 200, 236));
check('駕駛時搖桿往上不跑、y 只來自油門鈕', !input.down('ShiftLeft') && input.moveAxis().y === 1);
pad.dispatch('pointermove', pe(9, 264, 300));
check('駕駛時搖桿轉向 → KeyD', input.down('KeyD'));

// 6. visibilitychange hidden → 全歸零
look.dispatch('pointerdown', pe(10, 700, 250));
look.dispatch('pointermove', pe(10, 750, 250));
document.visibilityState = 'hidden';
document.dispatch('visibilitychange');
document.visibilityState = 'visible';
a = input.moveAxis();
check('visibilitychange hidden → 全歸零', a.x === 0 && a.y === 0 && input.keys.size === 0 && input.dx === 0 && !gas.classList.contains('active'));
look.dispatch('pointermove', pe(10, 800, 250));
pad.dispatch('pointermove', pe(9, 264, 300));
check('歸零後舊指標不再作用', input.dx === 0 && input.moveAxis().x === 0);
// blur
gas.dispatch('pointerdown', pe(11, 900, 400));
window.dispatch('blur');
check('blur → 全歸零', input.keys.size === 0);
touch.setTouchMode('walk');

// 7. registerTouchButton
const el = touch.registerTouchButton({ id: 'tb-attack', label: 'Punch', code: 'KeyJ', mode: 'tap', slot: 'sec3', showWhen: 'walk' });
check('registerTouchButton 新增後出現在 DOM', $('tb-attack') === el && el.classList.contains('slot-sec3') && el.attrs['data-show'] === 'walk');
el.dispatch('pointerdown', pe(12, 800, 300));
check('新按鈕 tap → pressed 含 KeyJ', input.wasPressed('KeyJ'));
input.endFrame();

// 8. 開始遊戲手勢 → body.playing + 全螢幕；直向遮罩期間輸入封鎖（駕駛中拉手煞車）
touch.setTouchMode('drive');
window.innerWidth = 500;
window.innerHeight = 1000;
check('未開始遊戲時不封鎖', !mobile.isInputBlocked());
$('start-btn').dispatch('click');
await Promise.resolve();
check('開始手勢 → body.playing 且 requestFullscreen 1 次', body.classList.contains('playing') && fsRequests === 1, `fsRequests=${fsRequests}`);
check('直向 → isInputBlocked', mobile.isInputBlocked());
$('tb-gas').dispatch('pointerdown', pe(14, 900, 400));
check('遮罩期間按鈕無效', !input.down('KeyW'));
input.endFrame();
check('遮罩期間駕駛 → 手煞車 Space', input.down('Space') && input.moveAxis().mag === 0);
window.innerWidth = 1000;
window.innerHeight = 500;
input.endFrame();
check('轉回橫向 → 解除手煞車', !input.down('Space') && !mobile.isInputBlocked());
touch.setTouchMode('walk');

// 9. 未啟用（開始前）不接受觸控
input.enabled = false;
$('tb-run').dispatch('pointerdown', pe(13, 800, 400));
check('enabled=false 時按鈕無效', !input.down('ShiftLeft'));
input.enabled = true;

// ---------- 自適應解析度 ----------
function runFps(ctrl, fps, seconds) {
  const dt = 1 / fps;
  const n = Math.round(seconds * fps);
  const changes = [];
  for (let i = 0; i < n; i++) if (ctrl.tick(dt)) changes.push(ctrl.scale);
  return changes;
}
const c1 = mobile.createScaleController();
// fpsAvg 由 60 lerp 到 30：第 1 秒末約 30.0x（< 40），連 2 秒 → 第 2 秒降一次
runFps(c1, 30, 1.999);
check('30fps 1.99 秒：尚未降', c1.scale === 1, `scale=${c1.scale}`);
runFps(c1, 30, 0.02);
check('30fps 連 2 秒 → 0.85', c1.scale === 0.85, `scale=${c1.scale} fpsAvg=${c1.fpsAvg.toFixed(2)}`);
const s2 = runFps(c1, 30, 20);
check('持續低 fps → 下限 0.55', c1.scale === 0.55, `序列=${[1, 0.85, ...s2].join('→')}`);
// 回升邊界：新控制器（fpsAvg 初值 60）從下限起跑，避免接續上一段的評估相位
const cUp = mobile.createScaleController();
cUp.scale = 0.55;
runFps(cUp, 60, 5.99);
check('60fps 5.99 秒不回升', cUp.scale === 0.55, `scale=${cUp.scale}`);
runFps(cUp, 60, 0.02);
check('60fps 連 6 秒 → 0.65', cUp.scale === 0.65, `scale=${cUp.scale}`);
const s4 = runFps(cUp, 60, 40);
check('持續高 fps → 上限 1', cUp.scale === 1, `序列=${[0.65, ...s4].join('→')}`);
const c2 = mobile.createScaleController();
runFps(c2, 50, 30);
check('50fps（40..57 之間）不變', c2.scale === 1);
const c3 = mobile.createScaleController();
runFps(c3, 30, 1.5);
runFps(c3, 60, 1);
runFps(c3, 30, 1.5);
check('低 fps 中斷後重新計數', c3.scale === 1, `fpsAvg=${c3.fpsAvg.toFixed(2)}`);
check('pixelRatio low: min(3,1.5)×0.55', near(mobile.pixelRatioFor('low', 3, 0.55), 0.825) && mobile.pixelRatioFor('high', 3, 1) === 2);
check('qualityTier 觸控 = low', mobile.qualityTier() === 'low');

console.log(`\n通過 ${pass} / ${total}`);
process.exit(pass === total ? 0 : 1);
