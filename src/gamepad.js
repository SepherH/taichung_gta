// 遊戲手把（Gamepad API）：每幀輪詢 navigator.getGamepads()，把按鍵 / 搖桿 / 扳機轉成 Input 的獨立來源（padKeys + 手把類比量）
// 取手把：第一支 mapping === 'standard'，沒有則取第一支非 null；斷線（gamepaddisconnected 或輪詢不到）→ 釋放所有按住鍵、
//   歸零搖桿 / 踏板 / 視角累積量，不殘留卡鍵。navigator 或 getGamepads 不存在時整個模組為 no-op（不拋例外）
// 輪詢掛在 Input.addFrameHook（endFrame 清 pressed 之後）：本幀的按下沿留到下一幀 updateGame 讀，與鍵盤事件相同時序
//
// 兩種模式（依 input.enabled 判斷）：
//   遊戲中（enabled）：standard mapping 按鍵 → 虛擬鍵碼（ACTIONS 既有鍵），左搖桿 / RT / LT → 類比，右搖桿 → 視角
//     步行 / 駕駛判斷：opts.getMode()（main.js 的 state.mode）優先，未給時用 input.touchMode——不另造狀態
//   選單 / 暫停 / 手機 / 大地圖 / 面板（未 enabled）：十字鍵與左搖桿送合成 ArrowUp/Down/Left/Right（按住 400 ms 後每 120 ms 重複），
//     A = Enter、B = Escape、Start = Escape、Back = KeyM，以合成 KeyboardEvent 送到 window，讓 menu.js / phone.js / 大地圖的鍵盤處理直接生效
//   模式切換當下仍按著的鍵一律「鎖住」到放開為止（例：選單按 A 開始遊戲，進遊戲後不會變成按住跳；遊戲中按 Start 開暫停，選單內不會再送 Escape）
//   步行 ↔ 駕駛切換視同模式切換：切換當下按住的扳機 / 鍵同樣鎖到放開（駕駛踏板不受影響）；扳機當按鍵有遲滯（按下 0.5、放開 0.4）
//
// 按鍵配置（standard mapping 索引）：
//   0 A：Space（跳 / 手煞車）　1 B：KeyE（互動）　2 X：步行 KeyR（裝填）/ 駕駛 KeyH（喇叭）　3 Y：KeyF（上下車）
//   4 LB：KeyQ（步行 = 武器循環、駕駛 = 換台，沿用 CONTEXT_ACTIONS）　5 RB：KeyV（鏡頭）
//   6 LT：步行 Mouse2（瞄準）/ 駕駛 煞車倒車類比　7 RT：步行 Mouse0（攻擊）/ 駕駛 油門類比
//   8 Back：KeyM（大地圖）　9 Start：Escape（暫停）　10 L3：ShiftLeft（衝刺，按住）　11 R3：KeyC（回頭看，按住）
//   12 ↑：KeyT（手機）　13 ↓：KeyN（時間快轉）
//   14 ←：上一把武器——有 opts.getPrevSlot()（Phase 14，五槽跳過未購買）時送 Digit{上一個已擁有槽 + 1}；否則有 opts.getSlot()（main.js 傳 weapons.pending 優先、否則 weapons.slot，0 起算）時送直選鍵 Digit{上一格}；未給則退回 KeyQ（只能往下一把）
//   15 →：下一把武器——送 KeyQ（weaponCycle，沿用武器循環的排隊 / 跳格邏輯）；← / → 只在步行有效，駕駛中不送
// 震動：rumble(strong, weak, ms)；手把沒有 vibrationActuator.playEffect 時略過（回 false）
import { LOOK_RAD_PER_UNIT } from './input.js';

export const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
export const MOVE_DEADZONE = 0.15; // 左搖桿死區（徑向），死區外重新映射到 0..1
export const LOOK_DEADZONE = 0.12; // 右搖桿死區（徑向）
export const TRIGGER_PRESS = 0.5; // 扳機當按鍵用（步行攻擊 / 瞄準）的按下門檻
export const TRIGGER_RELEASE = 0.4; // 已按住的扳機要低於此值才放開（遲滯，避免 0.5 附近抖動產生多次按下沿）
export const TRIGGER_DEADZONE = 0.05; // 扳機當踏板用的死區
export const LOOK_EXP = 2; // 視角非線性曲線：推動量 m → m^LOOK_EXP（小推量好微調，推到底全速）
export const LOOK_TURN_RATE = 1.25 * Math.PI; // 推到底、倍率 1.0 時水平轉速（rad/s ≈ 225°/s）
export const LOOK_PITCH_SCALE = 0.65; // 垂直轉速相對水平的比例
export const MENU_STICK = 0.5; // 選單中左搖桿推過此值視為方向鍵
export const REPEAT_DELAY = 400; // 選單方向鍵：按住多久開始重複（ms）
export const REPEAT_INTERVAL = 120; // 之後每隔多久重複一次（ms）
const STICK_KEY = 0.5; // 與 input.js 觸控搖桿相容層一致：推過此值寫入方向鍵（給只讀按鍵的舊碼）
const MAX_DT = 0.1; // 視角積分的單幀上限（s）
const LOOK_UNITS = LOOK_TURN_RATE / LOOK_RAD_PER_UNIT; // 推到底每秒的視角量（滑鼠 px 單位）

// 遊戲中：按鍵索引 → 虛擬鍵碼（drive 時另見 codeFor）
const GAME_CODES = {
  [PAD.A]: 'Space',
  [PAD.B]: 'KeyE',
  [PAD.Y]: 'KeyF',
  [PAD.LB]: 'KeyQ',
  [PAD.RB]: 'KeyV',
  [PAD.BACK]: 'KeyM',
  [PAD.START]: 'Escape',
  [PAD.L3]: 'ShiftLeft',
  [PAD.R3]: 'KeyC',
  [PAD.UP]: 'KeyT',
  [PAD.DOWN]: 'KeyN',
};
// 選單中：按鍵索引 → 合成鍵（方向另由十字鍵 / 左搖桿處理）
const MENU_CODES = { [PAD.A]: 'Enter', [PAD.B]: 'Escape', [PAD.START]: 'Escape', [PAD.BACK]: 'KeyM' };
const KEY_NAMES = { Enter: 'Enter', Escape: 'Escape', KeyM: 'm', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight' };
const BUTTON_COUNT = 16;

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// 徑向死區：長度 ≤ dz → 0；死區外長度重新映射到 0..1（方向不變）
export function radialDeadzone(x, y, dz) {
  const len = Math.hypot(x, y);
  if (len <= dz) return { x: 0, y: 0, mag: 0 };
  const mag = Math.min(1, (len - dz) / (1 - dz));
  return { x: (x / len) * mag, y: (y / len) * mag, mag };
}

// 單軸死區：|v| ≤ dz → 0；之外重新映射到 0..1（保留正負）
export function axisDeadzone(v, dz) {
  const a = Math.abs(v);
  if (a <= dz) return 0;
  return Math.sign(v) * Math.min(1, (a - dz) / (1 - dz));
}

// 取手把：第一支 standard，否則第一支非 null
export function pickGamepad(list) {
  if (!list) return null;
  let first = null;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p) continue;
    if (p.mapping === 'standard') return p;
    if (!first) first = p;
  }
  return first;
}

const NOOP = Object.freeze({
  supported: false,
  connected: false,
  poll() {},
  rumble() {
    return false;
  },
  release() {},
  dispose() {},
});

// opts：getMode()（'walk' | 'drive' | …，預設讀 input.touchMode）、getSlot()（目前武器槽 0 起算）、getPrevSlot()（上一個已擁有槽，Phase 14）、
//   navigator / window / KeyboardEvent / now()（測試替身；預設取全域）、autoPoll（預設 true：掛 input.addFrameHook）
export function createGamepad(input, opts = {}) {
  const nav = 'navigator' in opts ? opts.navigator : globalThis.navigator;
  if (!input || !nav || typeof nav.getGamepads !== 'function') return NOOP;
  const win = 'window' in opts ? opts.window : globalThis.window;
  const KbEvent = 'KeyboardEvent' in opts ? opts.KeyboardEvent : globalThis.KeyboardEvent;
  const now = opts.now || (() => (globalThis.performance && performance.now ? performance.now() : Date.now()));

  let pad = null; // 目前使用中的手把
  let active = false; // 上一次輪詢是否有手把（斷線轉換只釋放一次，不在沒手把時每幀清視角）
  let lastT = null;
  let lastMenu = null;
  let lastDrive = null;
  let prevHeld = new Array(BUTTON_COUNT).fill(false);
  const suppressed = new Set(); // 模式切換時仍按著的鍵：放開前不算按下
  const repeat = { dir: null, next: 0 };
  const desired = new Map(); // 本幀遊戲中要按住的虛擬鍵 → 是否為按下沿

  const readPads = () => {
    try {
      return nav.getGamepads();
    } catch (err) {
      return null;
    }
  };

  const raw = (p, i) => {
    const b = p.buttons && p.buttons[i];
    if (!b) return 0;
    if (typeof b === 'number') return b;
    return b.pressed ? Math.max(1e-6, num(b.value) || 1) : num(b.value);
  };
  const isDown = (p, i) => (i === PAD.LT || i === PAD.RT ? raw(p, i) >= (prevHeld[i] ? TRIGGER_RELEASE : TRIGGER_PRESS) : raw(p, i) > 0);
  const axis = (p, i) => clamp(num(p.axes && p.axes[i]), -1, 1);

  const dispatchKey = (code, isRepeat) => {
    if (!win || typeof win.dispatchEvent !== 'function') return;
    const key = KEY_NAMES[code] || code;
    for (const type of ['keydown', 'keyup']) {
      const init = { key, code, repeat: type === 'keydown' && isRepeat, bubbles: true, cancelable: true };
      let ev;
      if (typeof KbEvent === 'function') {
        try {
          ev = new KbEvent(type, init);
        } catch (err) {
          ev = null;
        }
      }
      if (!ev) ev = { type, ...init, timeStamp: now(), preventDefault() {}, stopPropagation() {} };
      try {
        win.dispatchEvent(ev);
      } catch (err) {
        console.error('[gamepad] 合成按鍵失敗', err);
      }
    }
  };

  const resetState = () => {
    prevHeld = new Array(BUTTON_COUNT).fill(false);
    suppressed.clear();
    repeat.dir = null;
    lastT = null;
    lastMenu = null;
    lastDrive = null;
  };

  // 斷線 / 外部要求：釋放所有手把按住鍵、歸零類比量與視角累積量
  const release = () => {
    input.resetPad();
    input.dx = 0;
    input.dy = 0;
    resetState();
  };

  const isDrive = () => {
    const m = typeof opts.getMode === 'function' ? opts.getMode() : input.touchMode;
    return m === 'drive';
  };

  const codeFor = (i, drive) => {
    if (i === PAD.X) return drive ? 'KeyH' : 'KeyR';
    if (i === PAD.RT) return drive ? null : 'Mouse0'; // 駕駛 = 油門類比
    if (i === PAD.LT) return drive ? null : 'Mouse2'; // 駕駛 = 煞車倒車類比
    if (i === PAD.LEFT || i === PAD.RIGHT) {
      if (drive) return null;
      if (i === PAD.RIGHT) return 'KeyQ';
      // Phase 14：opts.getPrevSlot()（上一個已擁有的槽，0 起算；五槽且跳過未購買者）優先，送 Digit{槽 + 1}
      const prev = typeof opts.getPrevSlot === 'function' ? opts.getPrevSlot() : null;
      if (Number.isInteger(prev) && prev >= 0) return `Digit${prev + 1}`;
      const slot = typeof opts.getSlot === 'function' ? opts.getSlot() : null;
      return Number.isInteger(slot) && slot >= 0 ? `Digit${((slot + 2) % 3) + 1}` : 'KeyQ';
    }
    return GAME_CODES[i] || null;
  };

  const gamePoll = (p, held, edge, dt, drive) => {
    desired.clear();
    const want = (code, e) => {
      if (code) desired.set(code, desired.get(code) || e);
    };
    for (let i = 0; i < BUTTON_COUNT; i++) if (held[i]) want(codeFor(i, drive), edge[i]);

    const lx = axis(p, 0);
    const ly = -axis(p, 1); // 手把上推為負 → 前正
    let mx = 0;
    let my = 0;
    let throttle = 0;
    let brake = 0;
    if (drive) {
      mx = axisDeadzone(lx, MOVE_DEADZONE);
      throttle = Math.max(0, axisDeadzone(raw(p, PAD.RT), TRIGGER_DEADZONE));
      brake = Math.max(0, axisDeadzone(raw(p, PAD.LT), TRIGGER_DEADZONE));
    } else {
      const m = radialDeadzone(lx, ly, MOVE_DEADZONE);
      mx = m.x;
      my = m.y;
    }
    // 方向鍵相容層（同觸控搖桿：駕駛只寫 A / D）；不產生按下沿
    if (mx > STICK_KEY) want('KeyD', false);
    if (mx < -STICK_KEY) want('KeyA', false);
    if (!drive) {
      if (my > STICK_KEY) want('KeyW', false);
      if (my < -STICK_KEY) want('KeyS', false);
    }
    input.setPadAnalog(mx, my, throttle, brake, drive);

    for (const code of [...input.padKeys]) if (!desired.has(code)) input.padUp(code);
    for (const [code, e] of desired) if (!input.padKeys.has(code) || e) input.padDown(code, e);

    // 右搖桿視角：徑向死區 → 曲線 → 每秒視角量 × dt（滑鼠 px 單位；倍率與反轉 Y 由 input.padLook 套用）
    const r = radialDeadzone(axis(p, 2), axis(p, 3), LOOK_DEADZONE);
    if (r.mag > 0 && dt > 0) {
      const k = (Math.pow(r.mag, LOOK_EXP) / r.mag) * LOOK_UNITS * dt;
      input.padLook(r.x * k, r.y * k * LOOK_PITCH_SCALE);
    }
  };

  const menuDir = (p, held) => {
    if (held[PAD.UP]) return 'ArrowUp';
    if (held[PAD.DOWN]) return 'ArrowDown';
    if (held[PAD.LEFT]) return 'ArrowLeft';
    if (held[PAD.RIGHT]) return 'ArrowRight';
    const x = axis(p, 0);
    const y = axis(p, 1);
    if (Math.max(Math.abs(x), Math.abs(y)) < MENU_STICK) return null;
    if (Math.abs(x) > Math.abs(y)) return x > 0 ? 'ArrowRight' : 'ArrowLeft';
    return y > 0 ? 'ArrowDown' : 'ArrowUp';
  };

  const menuPoll = (p, held, edge, t, entering) => {
    const dir = menuDir(p, held);
    if (entering) {
      // 剛切進選單時仍推著的方向：放開前不送
      repeat.dir = dir;
      repeat.next = Infinity;
    } else if (dir !== repeat.dir) {
      repeat.dir = dir;
      repeat.next = t + REPEAT_DELAY;
      if (dir) dispatchKey(dir, false);
    } else if (dir && t >= repeat.next) {
      repeat.next = t + REPEAT_INTERVAL; // 卡頓後不補發，避免連發兩次
      dispatchKey(dir, true);
    }
    for (const i of [PAD.A, PAD.B, PAD.START, PAD.BACK]) {
      // 送出前再確認仍在選單模式：同一輪 A（開始遊戲）之後不再補送 B / Start
      if (edge[i] && !input.enabled) dispatchKey(MENU_CODES[i], false);
    }
  };

  const poll = () => {
    const p = pickGamepad(readPads());
    if (!p) {
      if (active) release();
      active = false;
      pad = null;
      return;
    }
    if (pad && p.index !== pad.index) release(); // 換手把：舊手把的按住狀態不帶過去
    pad = p;
    active = true;
    const t = num(now());
    const dt = lastT === null ? 0 : clamp((t - lastT) / 1000, 0, MAX_DT);
    lastT = t;

    const cur = new Array(BUTTON_COUNT);
    for (let i = 0; i < BUTTON_COUNT; i++) cur[i] = isDown(p, i);
    const menu = !input.enabled;
    // 剛接上、剛切換 menu↔game，或遊戲中步行↔駕駛切換：切換當下按住的鍵（含踏板轉成的 Mouse0 / Mouse2）等放開才生效
    const drive = !menu && isDrive();
    const entering = lastMenu === null || menu !== lastMenu || (!menu && drive !== lastDrive);
    if (entering) {
      suppressed.clear();
      for (let i = 0; i < BUTTON_COUNT; i++) if (cur[i]) suppressed.add(i);
    }
    lastMenu = menu;
    lastDrive = drive;
    const held = new Array(BUTTON_COUNT);
    const edge = new Array(BUTTON_COUNT);
    for (let i = 0; i < BUTTON_COUNT; i++) {
      if (!cur[i]) suppressed.delete(i);
      held[i] = cur[i] && !suppressed.has(i);
      edge[i] = held[i] && !prevHeld[i];
    }
    prevHeld = held;

    if (menu) {
      if (input.padKeys.size) input.resetPad();
      input.setPadAnalog(0, 0, 0, 0, false);
      menuPoll(p, held, edge, t, entering);
    } else {
      gamePoll(p, held, edge, dt, drive);
    }
  };

  const onConnect = () => {}; // 連線不需處理：下一次輪詢自動接上
  const onDisconnect = (e) => {
    const g = e && e.gamepad;
    if (!pad || !g || g.index === pad.index) {
      if (active) release();
      active = false;
      pad = null;
    }
  };
  if (win && typeof win.addEventListener === 'function') {
    win.addEventListener('gamepadconnected', onConnect);
    win.addEventListener('gamepaddisconnected', onDisconnect);
  }
  const unhook = opts.autoPoll === false || typeof input.addFrameHook !== 'function' ? () => {} : input.addFrameHook(poll);

  // 震動：strong / weak 0..1、ms 毫秒；不支援時回 false
  const rumble = (strong, weak, ms) => {
    const act = pad && pad.vibrationActuator;
    if (!act || typeof act.playEffect !== 'function') return false;
    try {
      const r = act.playEffect('dual-rumble', {
        startDelay: 0,
        duration: Math.max(0, num(ms)),
        strongMagnitude: clamp(num(strong), 0, 1),
        weakMagnitude: clamp(num(weak), 0, 1),
      });
      if (r && typeof r.catch === 'function') r.catch(() => {});
      return true;
    } catch (err) {
      return false;
    }
  };

  return {
    supported: true,
    get connected() {
      return active;
    },
    poll,
    rumble,
    release,
    dispose() {
      unhook();
      if (win && typeof win.removeEventListener === 'function') {
        win.removeEventListener('gamepadconnected', onConnect);
        win.removeEventListener('gamepaddisconnected', onDisconnect);
      }
      if (active) release();
      active = false;
      pad = null;
    },
  };
}
