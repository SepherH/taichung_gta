// 鏡頭段位提示（I6a，§23.2）：V 鍵 / 觸控「視角」鈕切段後，畫面上方短暫顯示「鏡頭：近 / 中 / 遠」CAM_VIEW_HINT_SEC 秒
// 計時吃渲染 dt（§20：HUD / UI 屬渲染時間；暫停時 hud.update 不跑 → 提示凍結，回到遊戲後續倒數）
// 本檔不 import three / css（樣式在 src/style.css #cam-view-hint），node 可測；doc 可注入假 DOM，無 document 時只算狀態不建元素
export const CAM_VIEW_LABELS = ['近', '中', '遠'];
export const CAM_VIEW_HINT_SEC = 1.2;

// 段位索引 → 提示文字；非 0–2 整數 → null
export function camViewText(index) {
  return Number.isInteger(index) && index >= 0 && index < CAM_VIEW_LABELS.length ? `鏡頭：${CAM_VIEW_LABELS[index]}` : null;
}

export function createCamViewHint({ doc = globalThis.document, parent = null, seconds = CAM_VIEW_HINT_SEC } = {}) {
  let el = null;
  if (doc && typeof doc.createElement === 'function') {
    el = doc.createElement('div');
    el.id = 'cam-view-hint';
    el.className = 'hidden';
    if (el.setAttribute) el.setAttribute('aria-live', 'polite');
    const host = parent || doc.body;
    if (host && typeof host.appendChild === 'function') host.appendChild(el);
  }
  let timer = 0;
  let text = null;
  const setShown = (on) => {
    if (el && el.classList) el.classList.toggle('hidden', !on);
  };
  return {
    // 顯示 index 對應段位（重設倒數）；非法 index 忽略，回傳是否顯示
    show(index) {
      const t = camViewText(index);
      if (!t) return false;
      text = t;
      timer = seconds;
      if (el) el.textContent = t;
      setShown(true);
      return true;
    },
    // 每幀（渲染 dt）：倒數到 0 隱藏
    update(dt) {
      if (timer <= 0) return;
      timer -= Number.isFinite(dt) && dt > 0 ? dt : 0;
      if (timer <= 0) {
        timer = 0;
        setShown(false);
      }
    },
    get visible() {
      return timer > 0;
    },
    get text() {
      return timer > 0 ? text : null;
    },
    get remaining() {
      return timer;
    },
    get el() {
      return el;
    },
    destroy() {
      if (el && el.parentNode && typeof el.parentNode.removeChild === 'function') el.parentNode.removeChild(el);
      el = null;
    },
  };
}

// 段位 ↔ 設定鍵（§23.2；整合層 main.js 用）：kind 'walk' → camWalkView、其餘（'drive'）→ camDriveView
export const CAM_VIEW_KEYS = { walk: 'camWalkView', drive: 'camDriveView' };
export function camViewSettingKey(kind) {
  return kind === 'walk' ? CAM_VIEW_KEYS.walk : CAM_VIEW_KEYS.drive;
}
export function isCamViewKey(key) {
  return key === CAM_VIEW_KEYS.walk || key === CAM_VIEW_KEYS.drive;
}
// settings（{ get }）→ rig.setViews 參數 { walk, drive }
export function camViewsFromSettings(settings) {
  return { walk: settings.get(CAM_VIEW_KEYS.walk), drive: settings.get(CAM_VIEW_KEYS.drive) };
}
