// 觸控操作（B3）：左半螢幕浮動搖桿、右半螢幕拖曳轉視角 / 雙指捏合縮放（步行）或兩塊大踏板（駕駛）、虛擬按鈕
// 一律用 Pointer Events，每個 pointerId 只綁定一個控制（搖桿 / 視角區 / 各踏板 / 各按鈕各自追蹤），多指同時操作互不搶
// 按鈕以虛擬鍵碼寫入 Input（hold = 按住期間在 keys、按下當幀在 pressed；tap = 只在 pressed），鍵碼對齊 core/actions.js：
//   Space 跳 / 手煞車、ShiftLeft 衝刺、KeyF 上下車 / 扶起、Mouse0 攻擊、KeyE 互動、KeyH 喇叭、Escape 暫停、KeyM 大地圖、KeyT 手機（隱藏）
// 圖鑑鈕 tb-guide 沒有對應鍵位（core/actions 無此動作）：以 onTap 回呼開啟，整合層用 registerTouchButton 以同 id 重新註冊帶入回呼後顯示
// 搖桿推到底（≥ 0.9）= 衝刺（input.js 搖桿相容層寫入 ShiftLeft）
// 駕駛：右半區換成 #touch-pedals（左 = 煞車、右 = 油門），深度 = 手指在踏板內的縱向位置（越下越深），寫入 input.setPedals
// input.enabled = false（開始前 / 暫停 / 選單）時整個觸控層不吃操作，且 Input 會呼叫 onDisable 釋放所有按住中的觸控
//
// 之後的單元新增按鈕只需：registerTouchButton({ id, label, code, mode: 'hold'|'tap', slot, showWhen: 'walk'|'drive'|'always', hidden })
//   不寫入鍵碼的功能鈕改給 onTap(input)（= onPress，按下時呼叫一次），此時可省略 code；hidden: true = 建立但不顯示
//   同 id 重新註冊 = 取代（放開舊按鈕並重建）；setTouchButtonVisible(id, on) 動態顯示 / 隱藏（例：tb-interact 有提示才顯示）
// slot：main（右下主鈕）/ sec1（主鈕左側）/ sec2（主鈕上方）/ sec3（主鈕左上）/ attack（大號紅色攻擊鈕）/
//   interact（攻擊鈕左側，互動鈕；不與武器鈕欄 wp-tb-* 重疊；駕駛時橫向移到下車鈕左側、直向移到右半下車鈕正下方，見 style.css slot-interact）/
//   top1、top2、top3（右上小鈕，由右往左）/ tl1、tl2、tl3（左上小鈕：暫停、地圖、圖鑑，由左往右，排在小地圖右側；
//   隱藏的手機鈕仍佔 tl3，日後啟用須另排位置）
//   駕駛模式（body.touch-drive）時 sec2 / sec3 由 style.css 移到踏板上方一列，不與踏板重疊
// 攻擊鈕：id 為 ATTACK_ID 或 label 在 ATTACK_LABELS 內的按鈕一律改放 attack slot
// 已移除的舊按鈕 id（DEPRECATED_IDS：翻正、靈敏度、舊揮拳、油門 / 煞車鈕）再註冊會被忽略（回傳 null），由 F 扶起與設定頁滑桿取代
// 鏡頭拖曳區 = 右半螢幕的 #touch-look；按鈕疊在其上並 capture 自己的指標，從按鈕上開始的拖曳不會轉鏡頭
import { isInputBlocked } from './mobile.js';

const RADIUS = 64; // 搖桿半徑（px）
const DEAD = 0.08; // 死區；死區外重新映射到 0..1
const PINCH_K = 2; // 捏合每 px 距離變化換算的 wheel 量（張開 = 拉近）
const PEDAL_MIN = 0.35; // 踏板最上緣的深度（碰到就有此力道），最下緣 = 1
const END_EVENTS = ['pointerup', 'pointercancel', 'lostpointercapture'];

const ATTACK_ID = 'tb-attack';
const ATTACK_LABELS = ['攻擊', '揮拳'];
export const DEPRECATED_IDS = ['tb-flip', 'tb-sens', 'tb-punch', 'tb-gas', 'tb-brake'];

export const SLOTS = ['main', 'sec1', 'sec2', 'sec3', 'attack', 'interact', 'top1', 'top2', 'top3', 'tl1', 'tl2', 'tl3'];

const DEFAULT_BUTTONS = [
  // 步行
  { id: 'tb-jump', label: '跳', code: 'Space', mode: 'tap', slot: 'main', showWhen: 'walk' },
  { id: 'tb-run', label: '跑', code: 'ShiftLeft', mode: 'hold', slot: 'sec1', showWhen: 'walk' },
  { id: 'tb-enter', label: '上車', code: 'KeyF', mode: 'tap', slot: 'sec2', showWhen: 'walk' },
  // hold：按下當幀 pressed（拳 / 棒單擊）、按住期間 down（手槍連發）
  { id: ATTACK_ID, label: '攻擊', code: 'Mouse0', mode: 'hold', slot: 'attack', showWhen: 'walk' },
  // 互動（接委託 / 打卡 / 外送取餐 / 收集小吃）：預設隱藏，hud.setInteractPrompt 有提示時才顯示；步行與駕駛都可用（駕駛位置見 style.css）
  { id: 'tb-interact', label: '互動', code: 'KeyE', mode: 'tap', slot: 'interact', showWhen: 'always', hidden: true },
  // 駕駛（油門 / 煞車改為踏板）
  { id: 'tb-exit', label: '下車', code: 'KeyF', mode: 'tap', slot: 'sec2', showWhen: 'drive' },
  { id: 'tb-handbrake', label: '手煞', code: 'Space', mode: 'hold', slot: 'sec3', showWhen: 'drive' },
  { id: 'tb-horn', label: '喇叭', code: 'KeyH', mode: 'hold', slot: 'top1', showWhen: 'drive' },
  // 共用：左上三顆小鈕
  { id: 'tb-pause', label: '暫停', code: 'Escape', mode: 'tap', slot: 'tl1', showWhen: 'always' },
  { id: 'tb-map', label: '地圖', code: 'KeyM', mode: 'tap', slot: 'tl2', showWhen: 'always' },
  { id: 'tb-phone', label: '手機', code: 'KeyT', mode: 'tap', slot: 'tl3', showWhen: 'always', hidden: true },
  // 圖鑑：整合層以同 id 重新註冊並給 onTap（開圖鑑）後才顯示；步行專屬（駕駛中不開全螢幕面板）
  { id: 'tb-guide', label: '圖鑑', onTap: () => {}, mode: 'tap', slot: 'tl3', showWhen: 'walk', hidden: true },
];

const registry = new Map(); // id → def
let ui = null; // initTouch 後：{ root, input, buttons: Map id → { def, el, pointerId }, resetAll }
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
  if (b.def.mode === 'hold' && !b.def.onPress && !b.def.onTap) ui.input.touchRelease(b.def.code);
}

function createButtonEl(def) {
  const el = document.createElement('button');
  el.id = def.id;
  el.type = 'button';
  el.className = `tbtn slot-${def.slot}`;
  el.setAttribute('data-show', def.showWhen);
  el.textContent = def.label;
  el.hidden = !!def.hidden;
  const b = { def, el, pointerId: null };
  el.addEventListener('pointerdown', (e) => {
    prevent(e);
    if (!accepting() || b.pointerId !== null) return;
    b.pointerId = e.pointerId;
    capture(el, e.pointerId);
    el.classList.add('active');
    if (def.onTap) def.onTap(ui.input);
    else if (def.onPress) def.onPress(ui.input);
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

// 回傳按鈕元素（尚未 initTouch 時回傳 null，initTouch 時再建立）；已移除的舊按鈕 id 一律忽略並回傳 null
export function registerTouchButton(def) {
  if (def && DEPRECATED_IDS.includes(def.id)) return null;
  const d = { mode: 'tap', slot: 'top2', showWhen: 'always', ...def };
  if (!d.id || (!d.code && !d.onPress && !d.onTap)) throw new Error('registerTouchButton 需要 id 與 code（或 onTap / onPress）');
  if (d.id === ATTACK_ID || ATTACK_LABELS.includes(d.label)) d.slot = 'attack';
  registry.set(d.id, d);
  return ui ? mountButton(d) : null;
}

for (const def of DEFAULT_BUTTONS) registerTouchButton(def);

// 動態顯示 / 隱藏已註冊的按鈕（尚未 initTouch 時只記在定義上，建立時套用）；隱藏時放開按住中的指標；未知 id 回 false
export function setTouchButtonVisible(id, on) {
  const d = registry.get(id);
  if (!d) return false;
  const hidden = !on;
  d.hidden = hidden;
  const b = ui && ui.buttons.get(id);
  if (b && b.el.hidden !== hidden) {
    if (hidden) releaseButton(b);
    b.el.hidden = hidden;
  }
  return true;
}

// 按鈕目前是否設為顯示（已註冊且非 hidden；不含 CSS 依模式隱藏）
export function isTouchButtonVisible(id) {
  const d = registry.get(id);
  return !!d && !d.hidden;
}

// ---------- 模式 ----------
// 'walk' | 'drive'；hud.js 每幀依 state.driving 呼叫
function applyModeClass() {
  document.body.classList.toggle('touch-walk', mode === 'walk');
  document.body.classList.toggle('touch-drive', mode === 'drive');
}

export function getTouchMode() {
  return mode;
}

export function setTouchMode(next) {
  if ((next !== 'walk' && next !== 'drive') || next === mode) return;
  mode = next;
  if (!ui) return;
  applyModeClass();
  // 切換時放開所有按鈕（例如按「上車」的同一根手指）、視角區與踏板，避免殘留按住狀態；搖桿保留（轉向不中斷）
  for (const b of ui.buttons.values()) releaseButton(b);
  ui.look.reset();
  ui.pedals.reset();
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
    if (!accepting() || mode !== 'walk' || pts.size >= 2) return;
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
  return {
    reset: () => {
      pts.clear();
      pinchDist = 0;
    },
  };
}

// ---------- 駕駛踏板 ----------
function buildPedals(root, input) {
  const wrap = document.createElement('div');
  wrap.id = 'touch-pedals';
  root.appendChild(wrap);
  const make = (id, label) => {
    const el = document.createElement('div');
    el.id = id;
    el.className = 'tpedal';
    const fill = document.createElement('div');
    fill.className = 'tpedal-fill';
    const text = document.createElement('span');
    text.className = 'tpedal-label';
    text.textContent = label;
    el.appendChild(fill);
    el.appendChild(text);
    wrap.appendChild(el);
    return { el, fill, id: null, depth: 0 };
  };
  const brake = make('pedal-brake', '煞車');
  const gas = make('pedal-gas', '油門');
  const push = () => input.setPedals(gas.depth, brake.depth);

  const depthAt = (p, clientY) => {
    const r = p.el.getBoundingClientRect ? p.el.getBoundingClientRect() : null;
    const top = r && r.height > 0 ? r.top : 0;
    const h = r && r.height > 0 ? r.height : Math.max(1, window.innerHeight);
    const t = Math.min(1, Math.max(0, (clientY - top) / h));
    return PEDAL_MIN + (1 - PEDAL_MIN) * t;
  };
  const setDepth = (p, d) => {
    p.depth = d;
    p.fill.style.height = `${Math.round(d * 100)}%`;
  };
  const release = (p) => {
    if (p.id === null) return;
    p.id = null;
    p.el.classList.remove('active');
    setDepth(p, 0);
    push();
  };

  for (const p of [brake, gas]) {
    p.el.addEventListener('pointerdown', (e) => {
      prevent(e);
      if (!accepting() || mode !== 'drive' || p.id !== null) return;
      p.id = e.pointerId;
      capture(p.el, e.pointerId);
      p.el.classList.add('active');
      setDepth(p, depthAt(p, e.clientY));
      push();
    });
    p.el.addEventListener('pointermove', (e) => {
      prevent(e);
      if (e.pointerId !== p.id) return;
      setDepth(p, depthAt(p, e.clientY));
      push();
    });
    for (const type of END_EVENTS) {
      p.el.addEventListener(type, (e) => {
        prevent(e);
        if (e.pointerId === p.id) release(p);
      });
    }
    p.el.addEventListener('contextmenu', prevent);
  }
  return {
    reset: () => {
      release(brake);
      release(gas);
    },
  };
}

// ---------- 初始化 ----------
export function initTouch(input) {
  if (ui) return ui;
  const root = document.createElement('div');
  root.id = 'touch-ui';
  document.body.appendChild(root);
  ui = { root, input, buttons: new Map() };
  const stick = buildStick(root, input);
  ui.look = buildLook(root, input);
  ui.pedals = buildPedals(root, input);
  for (const def of registry.values()) mountButton(def);

  // 全部歸零：搖桿、鏡頭指標、踏板、按鈕、觸控寫入的鍵
  const resetAll = () => {
    stick.reset();
    ui.look.reset();
    ui.pedals.reset();
    for (const b of ui.buttons.values()) releaseButton(b);
    input.resetTouch();
  };
  ui.resetAll = resetAll;
  input.onDisable = resetAll; // 暫停 / 選單開啟（input.enabled = false）→ 釋放所有按住中的觸控
  window.addEventListener('blur', resetAll);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') resetAll();
  });

  // 每幀（Input.endFrame）檢查遮罩：上滑全螢幕 / 直向提示遮罩期間輸入歸零，駕駛中拉手煞車讓車煞停
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
