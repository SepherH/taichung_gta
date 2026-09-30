// 鍵盤、滑鼠與觸控輸入：以 KeyboardEvent.code 記錄按住狀態與「本幀剛按下」
//
// keys（按住）由三個來源合成：實體鍵盤、觸控按鈕（hold）、觸控搖桿相容層；pressed 為本幀剛按下（含觸控 tap / hold 按下）
// 觸控搖桿相容層：推過 STICK_KEY 的方向寫入 KeyW / KeyA / KeyS / KeyD（駕駛時只寫 KeyA / KeyD 轉向），
//   步行中推過 STICK_RUN 視為 ShiftLeft（跑），讓只讀按鍵的 player.js / main.js 不改也能用觸控
//
// moveAxis() → { x, y, mag, analog }
//   x：右正、y：前正（步行 = 相對鏡頭前方；駕駛 = 油門正 / 煞車倒車負），兩者合成後 clamp 在單位圓內
//   mag：0..1 的推動量；analog：本次是否含觸控搖桿的類比值（false = 純鍵盤 / 按鈕的數位 ±1）
//   鍵盤（WASD / 方向鍵）與觸控按鈕（油門 KeyW、煞車 KeyS）為數位 ±1；觸控搖桿為類比（已套死區重映射）
//   駕駛模式下搖桿只貢獻 x（轉向），y 只來自鍵盤與油門 / 煞車鈕
//
// 鏡頭轉動量 dx / dy 的單位 = 「中檔靈敏度下的滑鼠 px」，camera.js 乘 LOOK_RAD_PER_UNIT 換成弧度：
//   滑鼠 / pointer lock：movementX × 滑鼠靈敏度倍率；觸控：touchLook() 依目前螢幕寬換算（拖半個螢幕寬 = TOUCH_HALF_TURN）× 觸控倍率
// 靈敏度：低 / 中 / 高三段（SENS_LEVELS），滑鼠與觸控各自存 localStorage；桌機按 SENS_KEY 循環、觸控由 touch.js「靈敏度」鈕循環，
//   切換後通知 onSensitivityChange 的訂閱者（hud.js 顯示 toast）
import { isTouch, initMobile } from './mobile.js';
import { initTouch } from './touch.js';

const PREVENT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);
const STICK_KEY = 0.5; // 搖桿推過此值寫入對應方向鍵
const STICK_RUN = 0.9; // 步行中搖桿推過此值視為跑
export const LOOK_RAD_PER_UNIT = (2 * Math.PI) / 800; // 中檔：滑鼠移動 800 px ≈ 轉 360°
const TOUCH_HALF_TURN = Math.PI; // 觸控中檔：橫向拖過半個螢幕寬 ≈ 轉 180°
const MOUSE_STEP_MAX = 200; // 單次 mousemove 位移上限（px），避免 pointer lock 偶發的大跳動
export const SENS_KEY = 'KeyO'; // 桌機循環切換滑鼠靈敏度（main.js / player.js 未占用）
export const SENS_LEVELS = [
  { id: 'low', label: '低', mul: 0.6 },
  { id: 'mid', label: '中', mul: 1 },
  { id: 'high', label: '高', mul: 1.6 },
];
const SENS_DEFAULT = 1; // 讀不到設定時用中檔
const SENS_STORE_KEY = { mouse: 'tcgta.lookSens.mouse', touch: 'tcgta.lookSens.touch' };

const sensListeners = new Set();

// 訂閱靈敏度切換：fn({ kind: 'mouse'|'touch', level })；回傳取消訂閱函式
export function onSensitivityChange(fn) {
  sensListeners.add(fn);
  return () => sensListeners.delete(fn);
}

function loadSens(kind) {
  try {
    const id = window.localStorage.getItem(SENS_STORE_KEY[kind]);
    const i = SENS_LEVELS.findIndex((l) => l.id === id);
    return i >= 0 ? i : SENS_DEFAULT;
  } catch (err) {
    return SENS_DEFAULT;
  }
}

function saveSens(kind, i) {
  try {
    window.localStorage.setItem(SENS_STORE_KEY[kind], SENS_LEVELS[i].id);
  } catch (err) {
    // 無痕模式 / 停用儲存：只在本次遊戲有效
  }
}

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

export class Input {
  constructor(dom) {
    this.dom = dom;
    this.keys = new Set();
    this.pressed = new Set();
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
    this.dragging = false;
    this.enabled = false; // 遊戲開始後才接受輸入
    this.sens = { mouse: loadSens('mouse'), touch: loadSens('touch') }; // SENS_LEVELS 索引

    // 按住狀態的來源
    this.kbKeys = new Set();
    this.touchHolds = new Map(); // code → 按住中的觸控按鈕數
    this.stickKeys = new Set();
    this.blockKeys = new Set(); // 遮罩期間強制的鍵（駕駛中拉手煞車）
    this.stick = { x: 0, y: 0 };
    this.touchMode = 'walk';
    this.onFrame = null; // 觸控模組每幀的檢查（initTouch 設定）

    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      if (PREVENT.has(e.code)) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      if (e.code === SENS_KEY && !e.repeat) this.cycleSensitivity('mouse');
      this.kbKeys.add(e.code);
      this._syncKeys();
    });
    window.addEventListener('keyup', (e) => {
      this.kbKeys.delete(e.code);
      this._syncKeys();
    });
    window.addEventListener('blur', () => {
      this.clearKeyboard();
      this.dragging = false;
    });

    dom.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      this.dragging = true;
      // 點擊畫面時嘗試鎖定滑鼠（Esc 解除）；失敗也沒關係，拖曳仍可轉視角
      if (e.button === 0 && document.pointerLockElement !== dom && dom.requestPointerLock) {
        try {
          const p = dom.requestPointerLock();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (err) {
          // 忽略：部分瀏覽器不支援
        }
      }
    });
    window.addEventListener('mouseup', () => {
      this.dragging = false;
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      if (document.pointerLockElement === dom || this.dragging) {
        const k = this.sensMul('mouse');
        this.dx += clamp(e.movementX || 0, -MOUSE_STEP_MAX, MOUSE_STEP_MAX) * k;
        this.dy += clamp(e.movementY || 0, -MOUSE_STEP_MAX, MOUSE_STEP_MAX) * k;
      }
    });
    dom.addEventListener(
      'wheel',
      (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        this.wheel += clamp(e.deltaY, -300, 300);
      },
      { passive: false },
    );
    dom.addEventListener('contextmenu', (e) => e.preventDefault());

    // 自註冊手機支援（不需改 main.js）
    initMobile();
    if (isTouch()) initTouch(this);
  }

  _syncKeys() {
    this.keys.clear();
    for (const c of this.kbKeys) this.keys.add(c);
    for (const c of this.touchHolds.keys()) this.keys.add(c);
    for (const c of this.stickKeys) this.keys.add(c);
    for (const c of this.blockKeys) this.keys.add(c);
  }

  down(code) {
    return this.keys.has(code);
  }

  wasPressed(code) {
    return this.pressed.has(code);
  }

  // 數位輸入（鍵盤與觸控按鈕，不含搖桿相容層）
  _digital(a, b) {
    return this.kbKeys.has(a) || this.kbKeys.has(b) || this.touchHolds.has(a) || this.touchHolds.has(b);
  }

  moveAxis() {
    let x = (this._digital('KeyD', 'ArrowRight') ? 1 : 0) - (this._digital('KeyA', 'ArrowLeft') ? 1 : 0);
    let y = (this._digital('KeyW', 'ArrowUp') ? 1 : 0) - (this._digital('KeyS', 'ArrowDown') ? 1 : 0);
    const sx = this.stick.x;
    const sy = this.touchMode === 'drive' ? 0 : this.stick.y;
    x += sx;
    y += sy;
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    return { x, y, mag: Math.min(1, len), analog: sx !== 0 || sy !== 0 };
  }

  // ---------- 鏡頭靈敏度 ----------
  sensLevel(kind) {
    return SENS_LEVELS[this.sens[kind]];
  }

  sensMul(kind) {
    return this.sensLevel(kind).mul;
  }

  // 低 → 中 → 高 → 低 循環；回傳新檔位
  cycleSensitivity(kind) {
    const i = (this.sens[kind] + 1) % SENS_LEVELS.length;
    this.sens[kind] = i;
    saveSens(kind, i);
    const level = SENS_LEVELS[i];
    for (const fn of sensListeners) fn({ kind, level });
    return level;
  }

  // ---------- 觸控介面（touch.js 呼叫） ----------
  // 單指拖曳鏡頭：mx / my 為螢幕 px 位移，依目前螢幕寬換算（旋轉螢幕後自動跟著變）
  touchLook(mx, my) {
    const halfW = Math.max(1, window.innerWidth * 0.5);
    const k = (TOUCH_HALF_TURN / (LOOK_RAD_PER_UNIT * halfW)) * this.sensMul('touch');
    this.dx += mx * k;
    this.dy += my * k;
  }

  touchPress(code, hold) {
    if (!this.enabled) return;
    this.pressed.add(code);
    if (!hold) return;
    this.touchHolds.set(code, (this.touchHolds.get(code) || 0) + 1);
    this._syncKeys();
  }

  touchRelease(code) {
    const n = (this.touchHolds.get(code) || 0) - 1;
    if (n > 0) this.touchHolds.set(code, n);
    else this.touchHolds.delete(code);
    this._syncKeys();
  }

  // x 右正、y 前正，已套死區重映射的 0..1 類比值
  setStick(x, y) {
    this.stick.x = x;
    this.stick.y = y;
    this._updateStickKeys();
  }

  setTouchMode(mode) {
    this.touchMode = mode;
    this._updateStickKeys();
  }

  _updateStickKeys() {
    const { x, y } = this.stick;
    const s = this.stickKeys;
    s.clear();
    if (x > STICK_KEY) s.add('KeyD');
    if (x < -STICK_KEY) s.add('KeyA');
    if (this.touchMode === 'walk') {
      if (y > STICK_KEY) s.add('KeyW');
      if (y < -STICK_KEY) s.add('KeyS');
      if (Math.hypot(x, y) > STICK_RUN) s.add('ShiftLeft');
    }
    this._syncKeys();
  }

  setBlockBrake(on) {
    this.blockKeys.clear();
    if (on) this.blockKeys.add('Space');
    this._syncKeys();
  }

  resetTouch() {
    this.touchHolds.clear();
    this.stick.x = 0;
    this.stick.y = 0;
    this.stickKeys.clear();
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
    this._syncKeys();
  }

  clearKeyboard() {
    this.kbKeys.clear();
    this._syncKeys();
  }

  consumeMouse() {
    const out = { dx: this.dx, dy: this.dy, wheel: this.wheel };
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
    return out;
  }

  // 每幀結束時清除「剛按下」
  endFrame() {
    this.pressed.clear();
    if (this.onFrame) this.onFrame();
  }
}
