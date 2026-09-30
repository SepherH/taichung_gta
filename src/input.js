// 鍵盤與滑鼠輸入：以 KeyboardEvent.code 記錄按住狀態與「本幀剛按下」
import { clamp } from './utils.js';

const PREVENT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);

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

    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      if (PREVENT.has(e.code)) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
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
        // 限制單次位移，避免 pointer lock 偶發的大跳動
        this.dx += clamp(e.movementX || 0, -200, 200);
        this.dy += clamp(e.movementY || 0, -200, 200);
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
  }

  down(code) {
    return this.keys.has(code);
  }

  wasPressed(code) {
    return this.pressed.has(code);
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
  }
}
