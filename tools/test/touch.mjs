// 觸控輸入無頭測試：以最小 DOM mock 載入 src/touch.js 與 src/input.js，模擬搖桿 / 鏡頭拖曳 / 駕駛踏板 / 按鈕 / 多指 / 失焦 / enabled
// 另測 src/input.js 的滑鼠代碼、連續靈敏度（初值取 core/settings）、反轉 Y、snapshot；src/mobile.js 的直向提示、上滑全螢幕遮罩
// （「不用全螢幕，直接玩」、4 秒無變化縮成小提示）、NoSleep 後備、畫質分級與自適應解析度。用法：node tools/test/touch.mjs（任一斷言失敗 exit 1）

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
for (const id of ['start-btn', 'fs-back', 'swipe-up', 'rotate-mask']) {
  const e = body.appendChild(new El(id === 'rotate-mask' ? 'div' : 'button'));
  e.id = id;
  if (id !== 'start-btn') e.classList.add('hidden');
}
// localStorage / sessionStorage mock；throwStore = true 時模擬無痕模式存取丟例外
const store = new Map();
const session = new Map();
let throwStore = false;
const mkStorage = (m) => ({
  getItem(k) {
    if (throwStore) throw new Error('SecurityError');
    return m.has(k) ? m.get(k) : null;
  },
  setItem(k, v) {
    if (throwStore) throw new Error('SecurityError');
    m.set(k, String(v));
  },
});
window.localStorage = mkStorage(store);
window.sessionStorage = mkStorage(session);
// 無 Wake Lock API（模擬 iOS < 16.4）：NoSleep 後備用 canvas.captureStream + video
const origCreate = document.createElement;
let videoPlays = 0;
let videoPauses = 0;
document.createElement = (t) => {
  const e = origCreate(t);
  if (t === 'canvas') {
    e.getContext = () => ({ fillStyle: '', fillRect() {} });
    e.captureStream = () => ({ fake: 'stream' });
  }
  if (t === 'video') {
    e.play = () => {
      videoPlays++;
      e.paused = false;
      return Promise.resolve();
    };
    e.pause = () => {
      videoPauses++;
      e.paused = true;
    };
  }
  return e;
};
globalThis.window = window;
globalThis.document = document;

const inputMod = await import('../../src/input.js');
const { Input, LOOK_RAD_PER_UNIT, SENS_LEVELS, onSensitivityChange } = inputMod;
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

const canvas = new El('canvas');
const input = new Input(canvas);
input.enabled = true;
const $ = (id) => document.getElementById(id);
const pad = $('touch-pad');
const look = $('touch-look');
const pe = (id, x, y) => ({ pointerId: id, clientX: x, clientY: y });

check('body.touch 已設定', body.classList.contains('touch') && mobile.isTouch());
check('觸控 DOM 已建立（搖桿 / 視角 / 踏板 / 按鈕）', !!pad && !!look && !!$('tstick-base') && !!$('touch-pedals') && !!$('pedal-gas') && !!$('pedal-brake') && !!$('tb-jump') && !!$('tb-attack'));
check('初始為步行模式', body.classList.contains('touch-walk') && !body.classList.contains('touch-drive'));

// 1. 左搖桿推到 (+64, 0)
pad.dispatch('pointerdown', pe(1, 200, 300));
pad.dispatch('pointermove', pe(1, 264, 300));
let a = input.moveAxis();
check('搖桿 (+64,0) → x≈1', near(a.x, 1, 1e-3) && near(a.y, 0) && a.analog, `x=${a.x.toFixed(4)} mag=${a.mag.toFixed(4)}`);
check('搖桿推到底 = 衝刺：KeyD + ShiftLeft', input.down('KeyD') && input.down('ShiftLeft') && !input.down('KeyW'));
pad.dispatch('pointermove', pe(1, 200, 236));
a = input.moveAxis();
check('搖桿 (0,-64) → y≈1（往上 = 前）', near(a.y, 1, 1e-3) && near(a.x, 0, 1e-9) && input.down('KeyW'), `y=${a.y.toFixed(4)}`);
pad.dispatch('pointermove', pe(1, 400, 300));
a = input.moveAxis();
check('超出半徑 clamp 到 1', near(a.x, 1, 1e-3) && a.mag <= 1);
// 推到 0.9 邊界：v = (0.9·0.92+0.08) → m = 0.9
pad.dispatch('pointermove', pe(1, 200 + 64 * (0.9 * 0.92 + 0.08), 300));
check('搖桿 = 0.9 → 衝刺（≥ 0.9）', input.down('ShiftLeft'), `x=${input.moveAxis().x.toFixed(4)}`);
pad.dispatch('pointermove', pe(1, 200 + 64 * (0.85 * 0.92 + 0.08), 300));
check('搖桿 0.85 → 不衝刺', !input.down('ShiftLeft') && input.down('KeyD'));
// 2. 死區
pad.dispatch('pointermove', pe(1, 204, 300)); // 4px / 64 = 0.0625 < 0.08
a = input.moveAxis();
check('死區內 → 0', a.x === 0 && a.y === 0 && !a.analog && !input.down('KeyD'), `x=${a.x}`);
pad.dispatch('pointermove', pe(1, 232, 300)); // 0.5 → (0.5-0.08)/0.92
a = input.moveAxis();
check('死區重映射 0.5 → 0.4565', near(a.x, 0.42 / 0.92, 1e-4) && !input.down('KeyD'), `x=${a.x.toFixed(4)}`);

// 3. 多指：左搖桿 + 右拖鏡頭
pad.dispatch('pointermove', pe(1, 264, 300));
look.dispatch('pointerdown', pe(2, 700, 250));
look.dispatch('pointermove', pe(2, 800, 270));
pad.dispatch('pointermove', pe(3, 100, 100)); // 別的指標在搖桿區移動不影響
pad.dispatch('pointerdown', pe(3, 100, 100)); // 第二根手指按搖桿區：不搶已綁定的搖桿
pad.dispatch('pointermove', pe(3, 30, 100));
a = input.moveAxis();
const k = Math.PI / (LOOK_RAD_PER_UNIT * window.innerWidth * 0.5);
check('多指：第二根手指不搶搖桿，搖桿維持 x≈1', near(a.x, 1, 1e-3));
check('多指：鏡頭 dx/dy 累加', near(input.dx, 100 * k, 1e-6) && near(input.dy, 20 * k, 1e-6), `dx=${input.dx.toFixed(2)} dy=${input.dy.toFixed(2)}`);
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

// 4. 步行按鈕
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
const atk = $('tb-attack');
check('攻擊鈕：attack slot（最大紅鈕）、步行顯示', atk.classList.contains('slot-attack') && atk.attrs['data-show'] === 'walk' && atk.textContent === '攻擊');
atk.dispatch('pointerdown', pe(8, 800, 300));
const atkHeld = input.wasPressed('Mouse0') && input.snapshot().pressed.attack && input.down('Mouse0') && input.snapshot().down.attack;
atk.dispatch('pointerup', pe(8, 800, 300));
check('攻擊鈕 hold → 按下當幀 pressed、按住 down（手槍連發）、放開釋放', atkHeld && !input.down('Mouse0'));
input.endFrame();
const enter = $('tb-enter');
enter.dispatch('pointerdown', pe(9, 900, 200));
check('上車鈕 → KeyF（enterExit）', input.wasPressed('KeyF') && input.snapshot().pressed.enterExit);
enter.dispatch('pointerup', pe(9, 900, 200));
input.endFrame();
// 同一按鈕第二根手指不重複按
run.dispatch('pointerdown', pe(10, 800, 400));
run.dispatch('pointerdown', pe(11, 810, 400));
run.dispatch('pointerup', pe(11, 810, 400));
check('同鈕第二根手指被忽略（放開它不影響）', input.down('ShiftLeft'));
run.dispatch('pointerup', pe(10, 800, 400));
check('原手指放開 → ShiftLeft 放開', !input.down('ShiftLeft'));
input.endFrame();

// 5. 左上三顆小鈕
const pauseBtn = $('tb-pause');
const mapBtn = $('tb-map');
const phoneBtn = $('tb-phone');
check(
  '左上小鈕：暫停 / 地圖 / 手機（手機隱藏）',
  pauseBtn.classList.contains('slot-tl1') && mapBtn.classList.contains('slot-tl2') && phoneBtn.classList.contains('slot-tl3') && phoneBtn.hidden === true && !pauseBtn.hidden && pauseBtn.attrs['data-show'] === 'always',
);
pauseBtn.dispatch('pointerdown', pe(12, 60, 20));
pauseBtn.dispatch('pointerup', pe(12, 60, 20));
check('暫停鈕 → Escape（snapshot.pressed.pause）', input.wasPressed('Escape') && input.snapshot().pressed.pause);
input.endFrame();
mapBtn.dispatch('pointerdown', pe(13, 120, 20));
mapBtn.dispatch('pointerup', pe(13, 120, 20));
check('地圖鈕 → KeyM（snapshot.pressed.map）', input.wasPressed('KeyM') && input.snapshot().pressed.map);
input.endFrame();
check('已移除：翻正 / 靈敏度 / 油門 / 煞車按鈕', !$('tb-flip') && !$('tb-sens') && !$('tb-gas') && !$('tb-brake'));
check('main.js 舊註冊（tb-flip / tb-punch）被忽略', touch.registerTouchButton({ id: 'tb-flip', label: '翻正', code: 'KeyR', slot: 'top2', showWhen: 'drive' }) === null && touch.registerTouchButton({ id: 'tb-punch', label: '揮拳', code: 'KeyE', slot: 'sec3' }) === null && !$('tb-flip') && !$('tb-punch'));

// 5b. Phase 4：互動鈕 tb-interact（KeyE、有提示才顯示）、圖鑑鈕 tb-guide（onTap 回呼）、setTouchButtonVisible
{
  const inter = $('tb-interact');
  check('互動鈕：interact slot、步行、預設隱藏', !!inter && inter.classList.contains('slot-interact') && inter.attrs['data-show'] === 'walk' && inter.hidden === true && inter.textContent === '互動');
  check('SLOTS 含 interact', touch.SLOTS.includes('interact'));
  check('setTouchButtonVisible(tb-interact, true) → 顯示', touch.setTouchButtonVisible('tb-interact', true) === true && inter.hidden === false && touch.isTouchButtonVisible('tb-interact'));
  inter.dispatch('pointerdown', pe(40, 700, 350));
  check('互動鈕 tap → KeyE（snapshot.pressed.interact）、不按住', input.wasPressed('KeyE') && input.snapshot().pressed.interact && !input.down('KeyE'));
  touch.setTouchButtonVisible('tb-interact', false);
  check('提示消失 → 隱藏並放開按住中的指標', inter.hidden === true && !inter.classList.contains('active') && !touch.isTouchButtonVisible('tb-interact'));
  inter.dispatch('pointerup', pe(40, 700, 350));
  input.endFrame();
  check('setTouchButtonVisible 未知 id 回 false', touch.setTouchButtonVisible('tb-nope', true) === false && !touch.isTouchButtonVisible('tb-nope'));

  const guide0 = $('tb-guide');
  check('圖鑑鈕：預設隱藏（尚未接回呼）、tl3、步行專屬', !!guide0 && guide0.hidden === true && guide0.classList.contains('slot-tl3') && guide0.attrs['data-show'] === 'walk');
  guide0.dispatch('pointerdown', pe(41, 250, 20));
  guide0.dispatch('pointerup', pe(41, 250, 20));
  check('預設圖鑑鈕 tap 不寫入任何鍵', input.pressed.size === 0);
  let guideArg = null;
  let guideCalls = 0;
  const g = touch.registerTouchButton({ id: 'tb-guide', label: '圖鑑', slot: 'tl3', showWhen: 'walk', onTap: (inp) => {
    guideCalls++;
    guideArg = inp;
  } });
  const root = $('touch-ui');
  check('同 id 重新註冊 → 取代舊元素（只剩一顆）並顯示', g === $('tb-guide') && g !== guide0 && root.children.filter((c) => c.id === 'tb-guide').length === 1 && g.hidden === false);
  g.dispatch('pointerdown', pe(42, 250, 20));
  check('onTap：按下呼叫一次、傳入 input、不寫入鍵', guideCalls === 1 && guideArg === input && input.pressed.size === 0 && input.keys.size === 0);
  g.dispatch('pointerdown', pe(43, 252, 22));
  check('onTap：同鈕第二根手指不重複觸發', guideCalls === 1);
  g.dispatch('pointerup', pe(42, 250, 20));
  input.enabled = false;
  g.dispatch('pointerdown', pe(44, 250, 20));
  check('onTap：input 停用（暫停 / 面板開啟）時不觸發', guideCalls === 1);
  input.enabled = true;
  let threw = false;
  try {
    touch.registerTouchButton({ id: 'tb-x', label: 'x' });
  } catch {
    threw = true;
  }
  check('registerTouchButton 無 code / onTap / onPress 丟例外', threw);
  check('地圖鈕仍送 KeyM（main 改開大地圖）', $('tb-map').attrs['data-show'] === 'always');
  // 步行時可見按鈕的 slot 不重複（不與攻擊 / 跳 / 上車 / 跑 / 左上小鈕衝突）
  const walkVis = root.children.filter((c) => c.classList && c.classList.contains('tbtn') && !c.hidden && c.attrs['data-show'] !== 'drive');
  touch.setTouchButtonVisible('tb-interact', true);
  const walkVis2 = root.children.filter((c) => c.classList && c.classList.contains('tbtn') && !c.hidden && c.attrs['data-show'] !== 'drive');
  const slotOf = (c) => [...c.classList.set].find((x) => x.startsWith('slot-'));
  const slots = walkVis2.map(slotOf);
  check('步行可見按鈕 slot 互不重複（含互動 / 圖鑑）', new Set(slots).size === slots.length && walkVis2.length === walkVis.length + 1, slots.join(','));
  // 駕駛時步行專屬鈕由 CSS 隱藏
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../../src/style.css', import.meta.url), 'utf8');
  check('style.css：駕駛時隱藏 data-show="walk"（互動 / 圖鑑 / 攻擊…）', /body\.touch-drive \.tbtn\[data-show="walk"\][^{]*\{[^}]*display:\s*none/.test(css));
  check('style.css：.tbtn.slot-interact 已定義、≥ 44px', /\.tbtn\.slot-interact\s*\{[^}]*width:\s*(4[4-9]|[5-9]\d)px[^}]*height:\s*(4[4-9]|[5-9]\d)px/.test(css));
  touch.setTouchButtonVisible('tb-interact', false);
  input.endFrame();
}

// 6. 駕駛模式：踏板取代右半視角區
touch.setTouchMode('drive');
check('駕駛模式 body class', body.classList.contains('touch-drive') && !body.classList.contains('touch-walk') && touch.getTouchMode() === 'drive');
const gas = $('pedal-gas');
const brake = $('pedal-brake');
input.consumeMouse();
look.dispatch('pointerdown', pe(20, 700, 250));
look.dispatch('pointermove', pe(20, 800, 250));
check('駕駛時視角拖曳區不作用', input.dx === 0);
look.dispatch('pointerup', pe(20, 800, 250));
// 踏板深度 = 縱向位置（mock 無 getBoundingClientRect → 以整個螢幕高 500 計）；最上 0.35、最下 1
gas.dispatch('pointerdown', pe(21, 900, 500));
a = input.moveAxis();
check('油門踏到底 → y = 1（類比）', near(a.y, 1) && a.analog && !input.down('KeyW'), `y=${a.y}`);
gas.dispatch('pointermove', pe(21, 900, 250));
a = input.moveAxis();
check('油門中段 → y = 0.675', near(a.y, 0.35 + 0.65 * 0.5), `y=${a.y}`);
gas.dispatch('pointermove', pe(21, 900, 0));
check('油門最上緣 → y = 0.35', near(input.moveAxis().y, 0.35));
check('油門深度條', gas.children[0].style.height === '35%');
// 多指：搖桿轉向 + 油門 + 煞車同時
pad.dispatch('pointerdown', pe(22, 200, 300));
pad.dispatch('pointermove', pe(22, 264, 300));
gas.dispatch('pointermove', pe(21, 900, 500));
a = input.moveAxis();
check('駕駛：全轉向 + 全油門 → x=1、y=1（各軸獨立 clamp）', near(a.x, 1, 1e-3) && near(a.y, 1) && !input.down('ShiftLeft'), `x=${a.x.toFixed(3)} y=${a.y.toFixed(3)}`);
brake.dispatch('pointerdown', pe(23, 600, 375));
a = input.moveAxis();
check('油門 1 + 煞車 0.8375 → y = throttle − brake', near(a.y, 1 - (0.35 + 0.65 * 0.75)), `y=${a.y.toFixed(4)}`);
gas.dispatch('pointerup', pe(21, 900, 500));
a = input.moveAxis();
check('放開油門 → 只剩煞車（倒車負）', near(a.y, -(0.35 + 0.65 * 0.75)));
brake.dispatch('pointermove', pe(21, 600, 0)); // 別的 pointerId 不影響
check('其他指標移動不影響煞車', near(input.moveAxis().y, -(0.35 + 0.65 * 0.75)));
brake.dispatch('pointercancel', pe(23, 600, 375));
check('pointercancel → 煞車歸零、轉向維持', input.moveAxis().y === 0 && input.down('KeyD'));
pad.dispatch('pointermove', pe(22, 200, 236));
check('駕駛時搖桿往上不衝刺、不給油', !input.down('ShiftLeft') && input.moveAxis().y === 0);
pad.dispatch('pointerup', pe(22, 200, 236));
// 鍵盤 W 仍可駕駛（桌機接藍牙鍵盤）
window.dispatch('keydown', { code: 'KeyW', repeat: false, preventDefault() {} });
check('駕駛：鍵盤 W → y = 1', input.moveAxis().y === 1);
window.dispatch('keyup', { code: 'KeyW' });
input.setPedals(2, -1);
check('setPedals clamp 到 0..1', input.pedals.throttle === 1 && input.pedals.brake === 0);
input.setPedals(0, 0);
// 駕駛按鈕
const hb = $('tb-handbrake');
hb.dispatch('pointerdown', pe(24, 800, 300));
check('手煞鈕（hold）→ Space 按住（snapshot.down.jump）', input.down('Space') && input.snapshot().down.jump);
hb.dispatch('pointerup', pe(24, 800, 300));
const horn = $('tb-horn');
horn.dispatch('pointerdown', pe(25, 950, 20));
check('喇叭鈕 → KeyH（按住 + 本幀 pressed.horn）、駕駛顯示', input.down('KeyH') && input.snapshot().pressed.horn && horn.attrs['data-show'] === 'drive');
horn.dispatch('pointerup', pe(25, 950, 20));
input.endFrame();
const exitBtn = $('tb-exit');
exitBtn.dispatch('pointerdown', pe(26, 900, 200));
check('下車鈕 → KeyF', input.wasPressed('KeyF'));
exitBtn.dispatch('pointerup', pe(26, 900, 200));
input.endFrame();
// 踏板按住中切回步行 → 釋放
gas.dispatch('pointerdown', pe(27, 900, 500));
touch.setTouchMode('walk');
check('切回步行 → 踏板釋放', input.pedals.throttle === 0 && input.moveAxis().y === 0 && !gas.classList.contains('active'));
gas.dispatch('pointerdown', pe(28, 900, 500));
check('步行時踏板不作用', input.pedals.throttle === 0);
gas.dispatch('pointerup', pe(28, 900, 500));
touch.setTouchMode('drive');

// 7. visibilitychange hidden → 全歸零
gas.dispatch('pointerdown', pe(30, 900, 400));
pad.dispatch('pointerdown', pe(31, 200, 300));
pad.dispatch('pointermove', pe(31, 264, 300));
document.visibilityState = 'hidden';
document.dispatch('visibilitychange');
document.visibilityState = 'visible';
a = input.moveAxis();
check('visibilitychange hidden → 全歸零', a.x === 0 && a.y === 0 && input.keys.size === 0 && input.dx === 0 && !gas.classList.contains('active'));
gas.dispatch('pointermove', pe(30, 900, 500));
pad.dispatch('pointermove', pe(31, 264, 300));
check('歸零後舊指標不再作用', input.pedals.throttle === 0 && input.moveAxis().x === 0);
// blur
hb.dispatch('pointerdown', pe(32, 900, 400));
window.dispatch('blur');
check('blur → 全歸零', input.keys.size === 0);
touch.setTouchMode('walk');

// 8. enabled = false（暫停 / 選單）：釋放所有按住中的觸控，且不再吃操作
pad.dispatch('pointerdown', pe(40, 200, 300));
pad.dispatch('pointermove', pe(40, 264, 300));
run.dispatch('pointerdown', pe(41, 800, 400));
look.dispatch('pointerdown', pe(42, 700, 250));
look.dispatch('pointermove', pe(42, 720, 250));
window.dispatch('keydown', { code: 'KeyA', repeat: false, preventDefault() {} });
canvas.dispatch('mousedown', { button: 2 });
check('停用前：搖桿 / 按鈕 / 鍵盤 / 右鍵皆按住', input.down('ShiftLeft') && input.down('KeyD') && input.down('KeyA') && input.down('Mouse2') && input.dx !== 0);
input.enabled = false;
a = input.moveAxis();
check('enabled=false → 清空所有按住狀態與累積', input.keys.size === 0 && a.x === 0 && a.y === 0 && input.dx === 0 && input.pressed.size === 0 && !run.classList.contains('active') && !$('tstick-base').classList.contains('active'));
pad.dispatch('pointermove', pe(40, 264, 300));
look.dispatch('pointermove', pe(42, 800, 250));
run.dispatch('pointerdown', pe(43, 800, 400));
jump.dispatch('pointerdown', pe(44, 900, 400));
check('停用中：觸控不吃操作（舊指標與新按下皆無效）', input.keys.size === 0 && input.pressed.size === 0 && input.dx === 0 && input.moveAxis().x === 0);
window.dispatch('keydown', { code: 'KeyW', repeat: false, preventDefault() {} });
canvas.dispatch('mousedown', { button: 0 });
check('停用中：鍵盤 / 滑鼠不吃', input.keys.size === 0 && !input.wasPressed('Mouse0'));
window.dispatch('keyup', { code: 'KeyW' });
window.dispatch('keyup', { code: 'KeyA' });
input.enabled = true;
run.dispatch('pointerup', pe(43, 800, 400));
jump.dispatch('pointerup', pe(44, 900, 400));
run.dispatch('pointerdown', pe(45, 800, 400));
check('重新啟用後按鈕恢復', input.down('ShiftLeft'));
run.dispatch('pointerup', pe(45, 800, 400));
input.endFrame();

// 9. 滑鼠按鍵代碼、連續靈敏度、反轉 Y、snapshot
canvas.dispatch('mousedown', { button: 0 });
check('canvas 左鍵 → Mouse0（pressed + 按住）', input.wasPressed('Mouse0') && input.down('Mouse0') && input.snapshot().down.attack);
window.dispatch('mouseup', { button: 0 });
check('mouseup → 放開 Mouse0', !input.down('Mouse0'));
canvas.dispatch('mousedown', { button: 2 });
check('canvas 右鍵 → Mouse2', input.wasPressed('Mouse2') && input.down('Mouse2'));
window.dispatch('mouseup', { button: 2 });
input.endFrame();
const uiEl = new El('button');
body.appendChild(uiEl);
uiEl.dispatch('mousedown', { button: 0 });
check('UI 元素上的點擊不算 Mouse0', !input.wasPressed('Mouse0'));
input.consumeMouse();
check('預設倍率 1.0（滑鼠 / 觸控）', input.sensMul('mouse') === 1 && input.sensMul('touch') === 1);
input.dragging = true;
window.dispatch('mousemove', { movementX: 800, movementY: 0 });
window.dispatch('mousemove', { movementX: 0, movementY: 0 });
let mm = input.consumeMouse();
check('滑鼠倍率 1.0：800 px → 單次上限 200 px（防跳動）', near(mm.dx, 200));
for (let i = 0; i < 4; i++) window.dispatch('mousemove', { movementX: 200, movementY: 0 });
mm = input.consumeMouse();
check('滑鼠倍率 1.0：累計 800 px ≈ 360°', near(mm.dx * LOOK_RAD_PER_UNIT, 2 * Math.PI, 1e-9));
input.setSensitivity({ mouse: 1.7 });
window.dispatch('mousemove', { movementX: 100, movementY: -50 });
mm = input.consumeMouse();
check('setSensitivity 連續倍率 1.7（觸控不變）', near(mm.dx, 170) && near(mm.dy, -85) && input.sensMul('touch') === 1, `dx=${mm.dx}`);
input.setSensitivity({ mouse: 99, touch: 0.01 });
check('setSensitivity clamp 0.3–3.0', input.sensMul('mouse') === 3 && input.sensMul('touch') === 0.3);
input.setSensitivity({ mouse: NaN, touch: 'x' });
check('setSensitivity 非法值維持原值', input.sensMul('mouse') === 3 && input.sensMul('touch') === 0.3);
input.setSensitivity({ mouse: 1, touch: 1 });
input.setInvertY(true);
window.dispatch('mousemove', { movementX: 10, movementY: 30 });
mm = input.consumeMouse();
check('反轉 Y：滑鼠 dy 取負、dx 不變', near(mm.dx, 10) && near(mm.dy, -30));
input.dragging = false;
input.setInvertY(false);
// 觸控拖曳換算（yaw 變化 = dx × LOOK_RAD_PER_UNIT，與 camera.js 相同換算）
const yawOfDrag = (id, px, W = window.innerWidth, py = 0) => {
  window.innerWidth = W;
  look.dispatch('pointerdown', pe(id, 520, 250));
  look.dispatch('pointermove', pe(id, 520 + px * 0.5, 250 + py * 0.5));
  look.dispatch('pointermove', pe(id, 520 + px, 250 + py));
  look.dispatch('pointerup', pe(id, 520 + px, 250 + py));
  const r = input.consumeMouse();
  window.innerWidth = 1000;
  return { yaw: r.dx * LOOK_RAD_PER_UNIT, pitch: r.dy * LOOK_RAD_PER_UNIT };
};
let yaw = yawOfDrag(50, 500).yaw;
check('觸控倍率 1.0：拖半個螢幕寬（1000px 寬）→ yaw ≈ π', near(yaw, Math.PI, 1e-9), `yaw=${((yaw * 180) / Math.PI).toFixed(1)}°`);
yaw = yawOfDrag(51, 400, 800).yaw;
check('換算依實際螢幕寬（800px 寬拖 400px）→ ≈ π', near(yaw, Math.PI, 1e-9));
input.setSensitivity({ touch: 2 });
yaw = yawOfDrag(52, 500).yaw;
check('觸控倍率 2.0 → 2π', near(yaw, 2 * Math.PI, 1e-9));
input.setSensitivity({ touch: 1 });
input.setInvertY(true);
const pitchInv = yawOfDrag(53, 0, 1000, 100).pitch;
input.setInvertY(false);
const pitchNorm = yawOfDrag(54, 0, 1000, 100).pitch;
check('反轉 Y 也套用觸控', pitchNorm > 0 && near(pitchInv, -pitchNorm));
// snapshot
window.dispatch('keydown', { code: 'KeyV', repeat: false, preventDefault() {} });
window.dispatch('keydown', { code: 'KeyC', repeat: false, preventDefault() {} });
window.dispatch('keydown', { code: 'KeyN', repeat: false, preventDefault() {} });
window.dispatch('keydown', { code: 'KeyE', repeat: false, preventDefault() {} });
input.dx = 5;
const snap = input.snapshot();
check(
  'snapshot 結構（move / look / wheel / down / pressed）',
  snap.move && typeof snap.move.x === 'number' && snap.look.dx === 5 && snap.wheel === 0 && snap.down.lookBack && !snap.down.sprint && snap.pressed.camera && snap.pressed.timeSkip && snap.pressed.interact && !snap.pressed.attack,
);
check('snapshot 不清除累積量', input.dx === 5);
for (const c of ['KeyV', 'KeyC', 'KeyN', 'KeyE']) window.dispatch('keyup', { code: c });
input.consumeMouse();
input.endFrame();
// 舊匯出相容
check('相容匯出：SENS_LEVELS 保留、onSensitivityChange 回傳取消函式', SENS_LEVELS.length === 3 && typeof onSensitivityChange(() => {}) === 'function');
check('O 鍵循環已移除', !('SENS_KEY' in inputMod) && typeof input.cycleSensitivity === 'undefined');
window.dispatch('keydown', { code: 'KeyO', repeat: false, preventDefault() {} });
window.dispatch('keyup', { code: 'KeyO' });
check('按 O 不改靈敏度', input.sensMul('mouse') === 1);
input.endFrame();
// 從按鈕上開始的拖曳不轉鏡頭（按鈕 capture 該指標；#touch-look 不認得此 pointerId）
jump.dispatch('pointerdown', pe(60, 900, 400));
jump.dispatch('pointermove', pe(60, 700, 350));
look.dispatch('pointermove', pe(60, 600, 300));
jump.dispatch('pointerup', pe(60, 600, 300));
mm = input.consumeMouse();
check('從按鈕開始拖曳 → 不轉鏡頭', mm.dx === 0 && mm.dy === 0);
input.endFrame();
// registerTouchButton（後續單元擴充）
const el = touch.registerTouchButton({ id: 'tb-test', label: 'Test', code: 'KeyJ', mode: 'tap', slot: 'sec3', showWhen: 'walk' });
check('registerTouchButton 新增後出現在 DOM', $('tb-test') === el && el.classList.contains('slot-sec3') && el.attrs['data-show'] === 'walk');
el.dispatch('pointerdown', pe(61, 800, 300));
check('新按鈕 tap → pressed 含 KeyJ', input.wasPressed('KeyJ'));
el.dispatch('pointerup', pe(61, 800, 300));
input.endFrame();

// 10. 開始遊戲手勢 → body.playing + 全螢幕、不鎖方向；直向一次性提示；NoSleep 後備
let locks = 0;
window.screen.orientation = { lock: () => { locks++; return Promise.resolve(); } };
touch.setTouchMode('drive');
window.innerWidth = 500;
window.innerHeight = 1000;
check('未開始遊戲時不封鎖', !mobile.isInputBlocked());
$('start-btn').dispatch('click');
await Promise.resolve();
await Promise.resolve();
check('開始手勢 → body.playing 且 requestFullscreen 1 次', body.classList.contains('playing') && fsRequests === 1, `fsRequests=${fsRequests}`);
check('橫直向都可玩：不鎖方向', locks === 0);
const video = $('nosleep-video');
check('無 Wake Lock API → 靜音 inline 迴圈影片後備播放中', !!video && video.muted && video.loop && video.playsInline && video.srcObject && videoPlays === 1);
const rmask = $('rotate-mask');
check('直向 → 顯示一次性提示並暫時封鎖', mobile.isInputBlocked() && rmask.style.display === 'flex' && !!$('portrait-ok'));
$('pedal-gas').dispatch('pointerdown', pe(70, 400, 900));
check('提示期間踏板無效', input.pedals.throttle === 0);
input.endFrame();
check('提示期間駕駛 → 手煞車 Space', input.down('Space') && input.moveAxis().mag === 0);
$('portrait-ok').dispatch('click');
check('按「仍用直向遊玩」→ 關閉提示、記 sessionStorage', rmask.style.display === 'none' && session.get('tcgta.portraitOk') === '1' && !mobile.isInputBlocked());
input.endFrame();
check('直向關閉提示後解除手煞車', !input.down('Space'));
$('pedal-gas').dispatch('pointerdown', pe(71, 400, 1000));
check('直向時觸控照常可用（踏板）', near(input.moveAxis().y, 1));
$('pedal-gas').dispatch('pointerup', pe(71, 400, 1000));
window.innerWidth = 1000;
window.innerHeight = 500;
window.dispatch('resize');
window.innerWidth = 500;
window.innerHeight = 1000;
window.dispatch('resize');
check('轉回直向不再提示（本分頁已選）', rmask.style.display === 'none' && !mobile.isInputBlocked());
window.innerWidth = 1000;
window.innerHeight = 500;
input.endFrame();
touch.setTouchMode('walk');
// 遊戲暫停 / 繼續 → NoSleep 只在進行中啟用
mobile.setGameActive(false);
check('暫停 → 影片後備暫停', videoPauses === 1 && video.paused);
mobile.setGameActive(true);
check('繼續 → 影片後備重新播放（不重建）', videoPlays === 2 && document.getElementById('nosleep-video') === video && body.children.filter((c) => c.id === 'nosleep-video').length === 1);
document.visibilityState = 'hidden';
document.dispatch('visibilitychange');
document.visibilityState = 'visible';
document.dispatch('visibilitychange');
check('背景 → 暫停、回前景 → 重新播放', videoPauses === 2 && videoPlays === 3);

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
check(
  'pixelRatioFor 用 QUALITY_TIERS.dprCap（low 1 / mid 1.25 / high 1.5 / ultra 2）',
  near(mobile.pixelRatioFor('low', 3, 0.55), 0.55) && mobile.pixelRatioFor('mid', 3, 1) === 1.25 && mobile.pixelRatioFor('high', 3, 1) === 1.5 && mobile.pixelRatioFor('ultra', 3, 1) === 2 && mobile.pixelRatioFor('high', 1, 1) === 1,
);
check('qualityTier 觸控 auto = low', mobile.qualityTier() === 'low');
mobile.setQualitySetting('ultra');
check('qualityTier 讀設定（ultra）', mobile.qualityTier() === 'ultra' && mobile.qualityTier('mid') === 'mid');
window.location.search = '?touch=1&q=mid';
check('qualityTier：URL ?q= 優先於設定', mobile.qualityTier() === 'mid');
window.location.search = '?touch=1';
mobile.setQualitySetting('auto');
// applyRendererQuality：low 關陰影、high 陰影貼圖 2048
const mkRenderer = () => ({ pr: 0, shadowMap: { enabled: true }, setPixelRatio(v) { this.pr = v; } });
const mkScene = (size) => {
  const light = { isLight: true, castShadow: true, shadow: { mapSize: { x: size, y: size, set(a, b) { this.x = a; this.y = b; } }, map: { disposed: false, dispose() { this.disposed = true; } } } };
  return { light, traverse: (fn) => fn(light) };
};
let rr = mkRenderer();
let sc = mkScene(4096);
check('applyRendererQuality low → 關陰影、pixelRatio 1', mobile.applyRendererQuality(rr, 1, sc, 'low') === 'low' && rr.shadowMap.enabled === false && rr.pr === 1);
rr = mkRenderer();
sc = mkScene(4096);
const oldMap = sc.light.shadow.map;
mobile.applyRendererQuality(rr, 1, sc, 'high');
check('applyRendererQuality high → 陰影 2048、釋放舊貼圖、pixelRatio 1.5', sc.light.shadow.mapSize.x === 2048 && oldMap.disposed && sc.light.shadow.map === null && rr.shadowMap.enabled && rr.pr === 1.5);
rr = mkRenderer();
check('applyRendererQuality 預設讀 qualityTier（觸控 low）', mobile.applyRendererQuality(rr) === 'low' && rr.shadowMap.enabled === false);

// ---------- input 初值取 core/settings（不再固定 1 / 讀舊鍵） ----------
{
  const { settings } = await import('../../src/core/settings.js');
  settings.set('lookSensMouse', 2.2);
  settings.set('lookSensTouch', 0.7);
  settings.set('invertY', true);
  const in2 = new Input(new El('canvas'));
  check('Input 初值取 settings（滑鼠 2.2 / 觸控 0.7 / 反轉 Y）', in2.sensMul('mouse') === 2.2 && in2.sensMul('touch') === 0.7 && in2.invertY === true, JSON.stringify(in2.sens));
  settings.reset();
  const in3 = new Input(new El('canvas'));
  check('設定回預設 → 新 Input 初值 1 / 1 / 不反轉', in3.sensMul('mouse') === 1 && in3.sensMul('touch') === 1 && in3.invertY === false);
}

// ---------- 上滑全螢幕遮罩：「不用全螢幕，直接玩」與 4 秒無變化自動解除封鎖（全新 mobile.js 實例 + 假計時器） ----------
{
  const timers = [];
  let now = 0;
  let seq = 0;
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms = 0) => {
    const id = ++seq;
    timers.push({ id, t: now + ms, fn });
    return id;
  };
  globalThis.clearTimeout = (id) => {
    const i = timers.findIndex((x) => x.id === id);
    if (i >= 0) timers.splice(i, 1);
  };
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.t - b.t || a.id - b.id);
      if (!timers.length || timers[0].t > end) break;
      const x = timers.shift();
      now = x.t;
      x.fn();
    }
    now = end;
  };
  let resizes = 0;
  window.dispatchEvent = (e) => {
    if (e.type === 'resize') resizes++;
    window.dispatch(e.type);
  };
  window.scrollTo = () => {};
  Object.assign(window.screen, { width: 900, height: 2000 }); // 螢幕短邊 900：只靠 innerHeight 增加 ≥ 60 px 判定網址列收起
  window.innerWidth = 1000;
  window.innerHeight = 500;
  docEl.requestFullscreen = () => Promise.reject(new Error('被拒'));
  const m2 = await import('../../src/mobile.js?swipe=1');
  m2.initMobile();
  $('start-btn').dispatch('click');
  for (let i = 0; i < 4; i++) await Promise.resolve();
  const sw = $('swipe-up');
  const skip = $('swipe-skip');
  check('全螢幕被拒 → 上滑遮罩顯示、附「不用全螢幕，直接玩」鈕、橫向封鎖輸入', !sw.classList.contains('hidden') && !!skip && skip.textContent === '不用全螢幕，直接玩' && m2.isInputBlocked() && body.classList.contains('swipe-mask'));
  advance(3999);
  check('3.99 秒：仍封鎖', m2.isInputBlocked() && !sw.classList.contains('mini'));
  advance(1);
  check('4 秒 innerHeight 沒變化 → 縮成角落小提示、解除封鎖', sw.classList.contains('mini') && !sw.classList.contains('hidden') && !m2.isInputBlocked() && !body.classList.contains('swipe-mask'));
  // 小提示狀態下網址列真的收起 → 遮罩完全關閉
  window.innerHeight = 580;
  window.dispatch('resize');
  advance(300);
  check('小提示時網址列收起（+80 px）→ 遮罩關閉', sw.classList.contains('hidden') && !sw.classList.contains('mini') && !m2.isInputBlocked());
  // 工具列回來 → 完整遮罩再出現；期間高度有變化（玩家在滑）→ 4 秒到不縮，再等一輪
  window.innerHeight = 500;
  window.dispatch('resize');
  advance(300);
  check('工具列回來 → 完整遮罩重新封鎖', !sw.classList.contains('hidden') && !sw.classList.contains('mini') && m2.isInputBlocked());
  advance(1000);
  window.innerHeight = 520;
  window.dispatch('resize');
  advance(3000);
  check('4 秒內高度有變化 → 不縮（仍封鎖）', m2.isInputBlocked() && !sw.classList.contains('mini'));
  advance(4000);
  check('再 4 秒沒變化 → 縮成小提示', sw.classList.contains('mini') && !m2.isInputBlocked());
  // 「不用全螢幕，直接玩」→ 關閉、記 sessionStorage、還原捲動版面，之後本分頁不再出現
  docEl.classList.add('swipe-scroll');
  const r0 = resizes;
  skip.dispatch('click');
  check('按「不用全螢幕，直接玩」→ 關閉、不封鎖、記 sessionStorage、還原版面', sw.classList.contains('hidden') && !m2.isInputBlocked() && session.get('tcgta.noFullscreen') === '1' && !docEl.classList.contains('swipe-scroll') && resizes === r0 + 1);
  window.innerHeight = 400;
  window.dispatch('resize');
  advance(300);
  check('之後工具列變化 → 本分頁不再出現遮罩', sw.classList.contains('hidden') && !m2.isInputBlocked());
  globalThis.setTimeout = realSet;
  globalThis.clearTimeout = realClear;
}

console.log(pass === total ? `PASS ${pass}/${total}` : `FAIL ${total - pass}/${total}`);
process.exit(pass === total ? 0 : 1);
