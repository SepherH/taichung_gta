// 觸控操作：左半螢幕浮動搖桿、右半螢幕拖曳轉視角 / 雙指捏合縮放、虛擬按鈕（步行 / 駕駛兩套配置）
// 一律用 Pointer Events，以 pointerId 追蹤每根手指，多指同時操作互不干擾（docs/ref/mobile-reference.md §3）
// 按鈕以虛擬鍵碼寫入 Input（hold = 按住期間在 keys、按下當幀在 pressed；tap = 只在 pressed），
// 鍵碼沿用 main.js / player.js 的既有語意：Space 跳 / 手煞車、ShiftLeft 跑、KeyF 上下車、KeyW 油門、KeyS 煞車倒車
//
// 之後的單元新增按鈕只需：registerTouchButton({ id, label, code, mode: 'hold'|'tap', slot, showWhen: 'walk'|'drive'|'always' })
//   不寫入鍵碼的功能鈕改給 onPress(input)（按下時呼叫，例如「靈敏度」循環切換），此時可省略 code
// slot：main（右下主鈕）/ sec1（主鈕左側）/ sec2（主鈕上方）/ sec3（主鈕左上）/ attack（主鈕左上的大號醒目攻擊鈕）/
//   top1、top2、top3（右上小鈕，由右往左）
// 攻擊鈕：id 為 ATTACK_ID 或 label 為 ATTACK_LABEL 的按鈕一律改放 attack slot（main.js 以 sec3 註冊「揮拳」也會變大）
// 鏡頭拖曳區 = 右半螢幕的 #touch-look；按鈕疊在其上並 capture 自己的指標，從按鈕上開始的拖曳不會轉鏡頭
import { isInputBlocked } from './mobile.js';

const RADIUS = 64; // 搖桿半徑（px）
const DEAD = 0.08; // 死區；死區外重新映射到 0..1
const PINCH_K = 2; // 捏合每 px 距離變化換算的 wheel 量（張開 = 拉近）
const END_EVENTS = ['pointerup', 'pointercancel', 'lostpointercapture'];

const ATTACK_ID = 'tb-punch';
const ATTACK_LABEL = '揮拳';

export const SLOTS = ['main', 'sec1', 'sec2', 'sec3', 'attack', 'top1', 'top2', 'top3'];

const DEFAULT_BUTTONS = [
  // 步行
  { id: 'tb-jump', label: '跳', code: 'Space', mode: 'tap', slot: 'main', showWhen: 'walk' },
  { id: 'tb-run', label: '跑', code: 'ShiftLeft', mode: 'hold', slot: 'sec1', showWhen: 'walk' },
  { id: 'tb-enter', label: '上車', code: 'KeyF', mode: 'tap', slot: 'sec2', showWhen: 'walk' },
  // 駕駛
  { id: 'tb-gas', label: '油門', code: 'KeyW', mode: 'hold', slot: 'main', showWhen: 'drive' },
  { id: 'tb-brake', label: '煞車', code: 'KeyS', mode: 'hold', slot: 'sec1', showWhen: 'drive' },
  { id: 'tb-exit', label: '下車', code: 'KeyF', mode: 'tap', slot: 'sec2', showWhen: 'drive' },
  { id: 'tb-handbrake', label: '手煞', code: 'Space', mode: 'hold', slot: 'sec3', showWhen: 'drive' },
  // 遊戲目前沒有喇叭邏輯；KeyG 為預留鍵碼，之後的單元讀 input.down('KeyG') 即可
  { id: 'tb-horn', label: '喇叭', code: 'KeyG', mode: 'hold', slot: 'top1', showWhen: 'drive' },
  // 共用：鏡頭靈敏度低 / 中 / 高循環（input.js 存 localStorage，hud.js toast 顯示檔位）
  { id: 'tb-sens', label: '靈敏度', onPress: (input) => input.cycleSensitivity('touch'), slot: 'top3', showWhen: 'always' },
];

const registry = new Map(); // id → def
let ui = null; // initTouch 後：{ root, input, buttons: Map id → { def, el, pointerId } }
let mode = 'walk';

function prevent(e) {
  e.preventDefault();
  if (e.stopPropagation) e.stopPropagation();
}

function capture(el, id) {
  try {
    el.setPointerCapture(id);
  } catch (err) {
    // 部分瀏覽器對已結束的指標會丟例外，忽略
  }
}

function accepting() {
  return ui && ui.input.enabled && !isInputBlocked();
}

// ---------- 按鈕 ----------
function releaseButton(b) {
  if (b.pointerId === null) return;
  b.pointerId = null;
  b.el.classList.remove('active');
  if (b.def.mode === 'hold' && !b.def.onPress) ui.input.touchRelease(b.def.code);
}

function createButtonEl(def) {
  const el = document.createElement('button');
  el.id = def.id;
  el.type = 'button';
  el.className = `tbtn slot-${def.slot}`;
  el.setAttribute('data-show', def.showWhen);
  el.textContent = def.label;
  const b = { def, el, pointerId: null };
  el.addEventListener('pointerdown', (e) => {
    prevent(e);
    if (!accepting() || b.pointerId !== null) return;
    b.pointerId = e.pointerId;
    capture(el, e.pointerId);
    el.classList.add('active');
    if (def.onPress) def.onPress(ui.input);
    else ui.input.touchPress(def.code, def.mode === 'hold');
  });
  for (const type of END_EVENTS) {
    el.addEventListener(type, (e) => {
      prevent(e);
      if (e.pointerId === b.pointerId) releaseButton(b);
    });
  }
  el.addEventListener('contextmenu', prevent);
  return b;
}

function mountButton(def) {
  const old = ui.buttons.get(def.id);
  if (old) {
    releaseButton(old);
    old.el.remove();
  }
  const b = createButtonEl(def);
  ui.buttons.set(def.id, b);
  ui.root.appendChild(b.el);
  return b.el;
}

// 回傳按鈕元素（尚未 initTouch 時回傳 null，initTouch 時再建立）
export function registerTouchButton(def) {
  const d = { mode: 'tap', slot: 'top2', showWhen: 'always', ...def };
  if (!d.id || (!d.code && !d.onPress)) throw new Error('registerTouchButton 需要 id 與 code（或 onPress）');
  if (d.id === ATTACK_ID || d.label === ATTACK_LABEL) d.slot = 'attack';
  registry.set(d.id, d);
  return ui ? mountButton(d) : null;
}

for (const def of DEFAULT_BUTTONS) registerTouchButton(def);

// ---------- 模式 ----------
// 'walk' | 'drive'；hud.js 每幀依 state.driving 呼叫，main.js 不需接線
function applyModeClass() {
  document.body.classList.toggle('touch-walk', mode === 'walk');
  document.body.classList.toggle('touch-drive', mode === 'drive');
}

export function setTouchMode(next) {
  if ((next !== 'walk' && next !== 'drive') || next === mode) return;
  mode = next;
  if (!ui) return;
  applyModeClass();
  // 切換時放開所有按鈕（例如按「上車」的同一根手指），避免殘留按住狀態
  for (const b of ui.buttons.values()) releaseButton(b);
  ui.input.setTouchMode(mode);
}

// ---------- 搖桿 ----------
function buildStick(root, input) {
  const pad = document.createElement('div');
  pad.id = 'touch-pad';
  const base = document.createElement('div');
  base.id = 'tstick-base';
  const head = document.createElement('div');
  head.id = 'tstick-head';
  base.appendChild(head);
  pad.appendChild(base);
  root.appendChild(pad);

  const st = { id: null, ox: 0, oy: 0 };
  const draw = (px, py) => {
    head.style.transform = `translate(${px}px, ${py}px)`;
  };
  const end = () => {
    st.id = null;
    base.classList.remove('active');
    base.style.left = '';
    base.style.top = '';
    draw(0, 0);
    input.setStick(0, 0);
  };
  pad.addEventListener('pointerdown', (e) => {
    prevent(e);
    if (!accepting() || st.id !== null) return;
    st.id = e.pointerId;
    st.ox = e.clientX;
    st.oy = e.clientY;
    capture(pad, e.pointerId);
    base.classList.add('active');
    base.style.left = `${e.clientX}px`;
    base.style.top = `${e.clientY}px`;
    draw(0, 0);
  });
  pad.addEventListener('pointermove', (e) => {
    prevent(e);
    if (e.pointerId !== st.id) return;
    let dx = e.clientX - st.ox;
    let dy = e.clientY - st.oy;
    const len = Math.hypot(dx, dy);
    if (len > RADIUS) {
      dx *= RADIUS / len;
      dy *= RADIUS / len;
    }
    draw(dx, dy);
    const v = Math.min(1, len / RADIUS);
    if (v < DEAD) {
      input.setStick(0, 0);
      return;
    }
    const m = (v - DEAD) / (1 - DEAD);
    const n = m / Math.min(len, RADIUS);
    // 螢幕往上 = 前進（y 正）
    input.setStick(dx * n, -dy * n);
  });
  for (const type of END_EVENTS) {
    pad.addEventListener(type, (e) => {
      prevent(e);
      if (e.pointerId === st.id) end();
    });
  }
  return { reset: () => st.id !== null && end() };
}

// ---------- 鏡頭拖曳 / 捏合 ----------
function buildLook(root, input) {
  const look = document.createElement('div');
  look.id = 'touch-look';
  root.appendChild(look);
  const pts = new Map(); // pointerId → { x, y }
  let pinchDist = 0;
  const twoDist = () => {
    const [a, b] = pts.values();
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  look.addEventListener('pointerdown', (e) => {
    prevent(e);
    if (!accepting() || pts.size >= 2) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    capture(look, e.pointerId);
    if (pts.size === 2) pinchDist = twoDist();
  });
  look.addEventListener('pointermove', (e) => {
    prevent(e);
    const p = pts.get(e.pointerId);
    if (!p) return;
    const mx = e.clientX - p.x;
    const my = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pts.size === 1) {
      input.touchLook(mx, my);
    } else {
      const d = twoDist();
      input.wheel -= (d - pinchDist) * PINCH_K;
      pinchDist = d;
    }
  });
  for (const type of END_EVENTS) {
    look.addEventListener(type, (e) => {
      prevent(e);
      pts.delete(e.pointerId);
    });
  }
  return { reset: () => pts.clear() };
}

// ---------- 初始化 ----------
export function initTouch(input) {
  if (ui) return ui;
  const root = document.createElement('div');
  root.id = 'touch-ui';
  document.body.appendChild(root);
  ui = { root, input, buttons: new Map() };
  const stick = buildStick(root, input);
  const look = buildLook(root, input);
  for (const def of registry.values()) mountButton(def);

  // 全部歸零：搖桿、鏡頭指標、按鈕、觸控寫入的鍵
  const resetAll = () => {
    stick.reset();
    look.reset();
    for (const b of ui.buttons.values()) releaseButton(b);
    input.resetTouch();
  };
  ui.resetAll = resetAll;
  window.addEventListener('blur', resetAll);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') resetAll();
  });

  // 每幀（Input.endFrame）檢查遮罩：直向 / 上滑遮罩期間輸入歸零，駕駛中拉手煞車讓車煞停
  let blocked = false;
  input.onFrame = () => {
    const b = isInputBlocked();
    if (b && !blocked) {
      resetAll();
      input.clearKeyboard();
    }
    if (b !== blocked || b) input.setBlockBrake(b && mode === 'drive');
    blocked = b;
  };

  applyModeClass();
  input.setTouchMode(mode);
  return ui;
}
