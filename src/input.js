// 鍵盤、滑鼠與觸控輸入：以 KeyboardEvent.code 記錄按住狀態與「本幀剛按下」
//
// keys（按住）由五個來源合成：實體鍵盤、滑鼠按鍵（Mouse0 左鍵 / Mouse2 右鍵，只算 canvas 上的點擊）、觸控按鈕（hold）、
//   觸控搖桿相容層、遮罩期間強制鍵；pressed 為本幀剛按下（含觸控 tap / hold 按下、滑鼠按下）
// 觸控搖桿相容層：推過 STICK_KEY 的方向寫入 KeyW / KeyA / KeyS / KeyD（駕駛時只寫 KeyA / KeyD 轉向），
//   步行中推過 STICK_RUN 視為 ShiftLeft（衝刺），讓只讀按鍵的 player.js / main.js 不改也能用觸控
//
// moveAxis() → { x, y, mag, analog }
//   x：右正、y：前正（步行 = 相對鏡頭前方；駕駛 = 油門正 / 煞車倒車負）
//   步行：鍵盤數位 ±1 + 觸控搖桿類比，合成後 clamp 在單位圓內
//   駕駛（setTouchMode('drive')）：x = 鍵盤 + 搖桿轉向；y = 鍵盤 W/S + 觸控踏板（setPedals：throttle − brake）；
//     兩軸各自 clamp 到 ±1（全油門轉彎不會被單位圓壓成 0.71）
//   mag：0..1 的推動量；analog：是否含觸控搖桿 / 踏板的類比值
//
// 鏡頭轉動量 dx / dy 的單位 = 「倍率 1.0 下的滑鼠 px」，camera.js 乘 LOOK_RAD_PER_UNIT 換成弧度：
//   滑鼠 / pointer lock：movementX × 滑鼠倍率（800 px ≈ 360°）；觸控：touchLook() 依螢幕寬換算（拖半個螢幕寬 ≈ 180°）× 觸控倍率
// 靈敏度：setSensitivity({ mouse, touch }) 連續倍率（0.3–3.0），反轉 Y：setInvertY(bool)；兩者由整合層以 core/settings 驅動，
//   初值取 core/settings 單例（lookSensMouse / lookSensTouch / invertY），整合層 setSensitivity 之前也是設定值
// enabled = false（開始前 / 暫停 / 選單）：不吃任何輸入，並清空所有按住狀態（鍵盤、滑鼠、觸控、搖桿、踏板），通知觸控層釋放指標
import { isTouch, initMobile } from './mobile.js';
import { initTouch } from './touch.js';
import { createActionReader } from './core/actions.js';
import { settings } from './core/settings.js';

const PREVENT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);
const STICK_KEY = 0.5; // 搖桿推過此值寫入對應方向鍵
const STICK_RUN = 0.9; // 步行中搖桿推過此值視為衝刺
export const LOOK_RAD_PER_UNIT = (2 * Math.PI) / 800; // 倍率 1.0：滑鼠移動 800 px ≈ 轉 360°
const TOUCH_HALF_TURN = Math.PI; // 觸控倍率 1.0：橫向拖過半個螢幕寬 ≈ 轉 180°
const MOUSE_STEP_MAX = 200; // 單次 mousemove 位移上限（px），避免 pointer lock 偶發的大跳動
const SENS_MIN = 0.3;
const SENS_MAX = 3;
const MOUSE_CODES = { 0: 'Mouse0', 2: 'Mouse2' };

// @deprecated 三段靈敏度已改為連續倍率（setSensitivity）；保留匯出僅供舊碼相容
export const SENS_LEVELS = [
  { id: 'low', label: '低', mul: 0.6 },
  { id: 'mid', label: '中', mul: 1 },
  { id: 'high', label: '高', mul: 1.6 },
];

// @deprecated O 鍵 / 觸控「靈敏度」鈕已移除，不會再觸發；保留匯出讓 hud.js 舊的訂閱不出錯。回傳取消訂閱函式
export function onSensitivityChange() {
  return () => {};
}

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

function sensValue(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v, SENS_MIN, SENS_MAX) : fallback;
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
    this._enabled = false; // 遊戲開始後才接受輸入
    // 連續倍率（setSensitivity）；初值一律取設定
    this.sens = { mouse: sensValue(settings.get('lookSensMouse'), 1), touch: sensValue(settings.get('lookSensTouch'), 1) };
    this.invertY = settings.get('invertY') === true;

    // 按住狀態的來源
    this.kbKeys = new Set();
    this.mouseKeys = new Set(); // Mouse0 / Mouse2
    this.touchHolds = new Map(); // code → 按住中的觸控按鈕數
    this.stickKeys = new Set();
    this.blockKeys = new Set(); // 遮罩期間強制的鍵（駕駛中拉手煞車）
    this.stick = { x: 0, y: 0 };
    this.pedals = { throttle: 0, brake: 0 }; // 觸控踏板類比深度 0..1
    this.touchMode = 'walk';
    this.onFrame = null; // 觸控模組每幀的檢查（initTouch 設定）
    this.onDisable = null; // enabled 轉為 false 時呼叫（initTouch 設定：釋放所有觸控指標）
    this.actions = createActionReader(this);

    window.addEventListener('keydown', (e) => {
      if (!this._enabled) return;
      if (PREVENT.has(e.code)) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
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

    // 只掛在 canvas 上：UI 元素（選單、按鈕）上的點擊不算攻擊
    dom.addEventListener('mousedown', (e) => {
      if (!this._enabled) return;
      this.dragging = true;
      const code = MOUSE_CODES[e.button];
      if (code) {
        this.pressed.add(code);
        this.mouseKeys.add(code);
        this._syncKeys();
      }
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
    window.addEventListener('mouseup', (e) => {
      this.dragging = false;
      const code = MOUSE_CODES[e.button];
      if (code && this.mouseKeys.delete(code)) this._syncKeys();
    });
    window.addEventListener('mousemove', (e) => {
      if (!this._enabled) return;
      if (document.pointerLockElement === dom || this.dragging) {
        const k = this.sens.mouse;
        this.dx += clamp(e.movementX || 0, -MOUSE_STEP_MAX, MOUSE_STEP_MAX) * k;
        this.dy += clamp(e.movementY || 0, -MOUSE_STEP_MAX, MOUSE_STEP_MAX) * k * (this.invertY ? -1 : 1);
      }
    });
    dom.addEventListener(
      'wheel',
      (e) => {
        if (!this._enabled) return;
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

  get enabled() {
    return this._enabled;
  }

  // 關閉時清空所有按住狀態與累積量，並通知觸控層釋放指標（暫停 / 選單開啟時不殘留按住的鍵）
  set enabled(on) {
    const next = !!on;
    if (next === this._enabled) return;
    this._enabled = next;
    if (next) return;
    this.releaseAll();
    if (this.onDisable) this.onDisable();
  }

  releaseAll() {
    this.kbKeys.clear();
    this.mouseKeys.clear();
    this.pressed.clear();
    this.dragging = false;
    this.resetTouch();
  }

  _syncKeys() {
    this.keys.clear();
    for (const c of this.kbKeys) this.keys.add(c);
    for (const c of this.mouseKeys) this.keys.add(c);
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
    if (this.touchMode === 'drive') {
      const { throttle, brake } = this.pedals;
      x = clamp(x + sx, -1, 1);
      y = clamp(y + throttle - brake, -1, 1);
      return { x, y, mag: Math.min(1, Math.hypot(x, y)), analog: sx !== 0 || throttle !== 0 || brake !== 0 };
    }
    const sy = this.stick.y;
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
  // 連續倍率（0.3–3.0，1.0 = 中檔）；省略或非法的欄位維持原值
  setSensitivity({ mouse, touch } = {}) {
    this.sens.mouse = sensValue(mouse, this.sens.mouse);
    this.sens.touch = sensValue(touch, this.sens.touch);
  }

  setInvertY(on) {
    this.invertY = !!on;
  }

  sensMul(kind) {
    return this.sens[kind] ?? 1;
  }

  // ---------- 本幀輸入快照（不清除累積量；清除仍用 consumeMouse / endFrame） ----------
  snapshot() {
    const a = this.actions;
    return {
      move: this.moveAxis(),
      look: { dx: this.dx, dy: this.dy },
      wheel: this.wheel,
      down: {
        sprint: a.down('sprint'),
        jump: a.down('jump'),
        attack: a.down('attack'),
        lookBack: a.down('lookBack'),
      },
      pressed: {
        attack: a.pressed('attack'),
        jump: a.pressed('jump'),
        interact: a.pressed('interact'),
        enterExit: a.pressed('enterExit'),
        horn: a.pressed('horn'),
        camera: a.pressed('camera'),
        map: a.pressed('map'),
        pause: a.pressed('pause'),
        timeSkip: a.pressed('timeSkip'),
      },
    };
  }

  // ---------- 觸控介面（touch.js 呼叫） ----------
  // 單指拖曳鏡頭：mx / my 為螢幕 px 位移，依目前螢幕寬換算（旋轉螢幕後自動跟著變）
  touchLook(mx, my) {
    if (!this._enabled) return;
    const halfW = Math.max(1, window.innerWidth * 0.5);
    const k = (TOUCH_HALF_TURN / (LOOK_RAD_PER_UNIT * halfW)) * this.sens.touch;
    this.dx += mx * k;
    this.dy += my * k * (this.invertY ? -1 : 1);
  }

  touchPress(code, hold) {
    if (!this._enabled) return;
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

  // 觸控踏板類比深度（0..1）；駕駛模式下 moveAxis().y = throttle − brake
  setPedals(throttle, brake) {
    this.pedals.throttle = clamp(Number(throttle) || 0, 0, 1);
    this.pedals.brake = clamp(Number(brake) || 0, 0, 1);
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
      if (Math.hypot(x, y) >= STICK_RUN) s.add('ShiftLeft');
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
    this.pedals.throttle = 0;
    this.pedals.brake = 0;
    this.stickKeys.clear();
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
    this._syncKeys();
  }

  clearKeyboard() {
    this.kbKeys.clear();
    this.mouseKeys.clear();
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
