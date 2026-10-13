// 通緝 UI（Phase 7 契約 C，前綴 wanted-）：右上星星列、被捕 / 送醫全螢幕畫面、情境提示卡、小地圖搜索圈
// 只負責 DOM 與 2D 繪製；星數 / 狀態由整合層從 wanted 事件轉呼叫，本檔不訂閱 bus
// 樣式在 wanted.css（比照 missions/ui.js：本檔不 import css，由整合層載入），node 可用假 DOM 測試
// 星星列 / 提示卡掛在 root（HUD 容器）；BUSTED / WASTED 掛在 body 以蓋過所有面板，元素一律 pointer-events none，
// 點擊跳過改由 doc 層 pointerdown / click 監聽（提示卡關閉鈕是唯一可點元素）

export const STAR_COUNT = 5;
export const OVERLAY_SEC = 3.5; // 被捕 / 送醫畫面自動結束秒數
export const SKIP_DELAY_SEC = 0.6; // 畫面出現後多久才接受點擊跳過（避免連按射擊直接略過）
export const HINT_SEC = 8; // 提示卡自動收起秒數
export const HINTS_STORAGE_KEY = 'tcgta.hints'; // localStorage：已看過的通緝提示 key（JSON 陣列；僅未注入 hints（HUD）時的獨立退路）
export const OVERLAY_REASONS = Object.freeze(['done', 'skipped', 'preempted', 'disposed']); // 被捕 / 送醫 Promise resolve 的 reason
export const GRAYSCALE_FILTER = 'grayscale(1) contrast(1.1)';
export const SEARCH_BLINK_SEC = 0.5; // 搜索圈藍紅交替週期（每段秒數）
export const SEARCH_COLORS = {
  blue: { fill: 'rgba(60, 140, 255, 0.22)', stroke: 'rgba(60, 140, 255, 0.85)' },
  red: { fill: 'rgba(255, 60, 60, 0.22)', stroke: 'rgba(255, 60, 60, 0.85)' },
};
export const OVERLAY_TEXT = {
  busted: { title: '被捕 BUSTED', sub: (n) => `你被帶回警察局・罰鍰 ${formatFine(n)}` },
  wasted: { title: '送醫 WASTED', sub: (n) => `你被送到醫院・醫藥費 ${formatFine(n)}` },
};

// 金額 → NT$1,234（同 missions formatNT 的千分位寫法）
export function formatFine(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  return `NT$${String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

// 小地圖搜索圈：半透明實心圓 + 外框，顏色每 SEARCH_BLINK_SEC 秒藍紅交替
export function drawSearchCircle(ctx, { cx, cy, r, t = 0 } = {}) {
  if (!ctx || !(r > 0) || !Number.isFinite(cx) || !Number.isFinite(cy)) return;
  const phase = Math.floor((Number(t) || 0) / SEARCH_BLINK_SEC);
  const c = ((phase % 2) + 2) % 2 === 0 ? SEARCH_COLORS.blue : SEARCH_COLORS.red;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = c.fill;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = c.stroke;
  ctx.stroke();
  ctx.restore();
}

function getStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function loadSeen() {
  try {
    const raw = getStorage()?.getItem(HINTS_STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch {
    return new Set();
  }
}

function saveSeen(seen) {
  try {
    getStorage()?.setItem(HINTS_STORAGE_KEY, JSON.stringify([...seen]));
  } catch {
    // 無痕模式 / 配額滿：只保留本次執行的記憶
  }
}

// hints 選用：HUD（showHint(id, text)）；注入時通緝提示改走 HUD 的提示卡與 tcgta.hints.seen（hud.resetHints() 一併重置），本檔不另存
export function createWantedUI({ root, canvas, doc = globalThis.document, hints = null } = {}) {
  if (!doc || typeof doc.createElement !== 'function') return createNullUi();
  const host = root || doc.body;
  const overlayHost = doc.body || host;
  const el = (tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const later = (fn, sec) => globalThis.setTimeout(fn, sec * 1000);
  const cancel = (id) => {
    if (id != null) globalThis.clearTimeout(id);
  };

  // ---------- 星星列 ----------
  const row = el('div', 'wanted-stars');
  row.setAttribute('aria-label', '通緝等級');
  const stars = [];
  for (let i = 0; i < STAR_COUNT; i++) {
    const s = el('span', 'wanted-star', '★');
    stars.push(s);
    row.appendChild(s);
  }
  row.hidden = true;
  host.appendChild(row);
  const shown = { n: 0, flashing: false };

  function setStars(n, { flashing = false } = {}) {
    const v = Math.max(0, Math.min(STAR_COUNT, Math.floor(Number(n) || 0)));
    const f = !!flashing && v > 0;
    if (v !== shown.n) {
      for (let i = 0; i < STAR_COUNT; i++) stars[i].classList.toggle('wanted-on', i < v);
      row.setAttribute('aria-label', `通緝等級 ${v}`);
      row.hidden = v === 0;
      shown.n = v;
    }
    if (f !== shown.flashing) {
      row.classList.toggle('wanted-flashing', f);
      shown.flashing = f;
    }
  }

  // ---------- 提示卡 ----------
  const hint = el('div', 'wanted-hint');
  hint.setAttribute('role', 'status');
  const hintText = el('span', 'wanted-hint-text');
  const hintClose = el('button', 'wanted-hint-close', '×');
  hintClose.type = 'button';
  hintClose.setAttribute('aria-label', '關閉提示');
  hint.appendChild(hintText);
  hint.appendChild(hintClose);
  hint.hidden = true;
  host.appendChild(hint);
  const seen = loadSeen();
  let hintTimer = null;

  function closeHint() {
    cancel(hintTimer);
    hintTimer = null;
    hint.hidden = true;
  }
  hintClose.addEventListener('click', (e) => {
    if (e && e.stopPropagation) e.stopPropagation();
    closeHint();
  });

  // 同 key 只顯示一次（跨執行記在 localStorage；storage 不可用時本次執行內仍只一次）；回傳是否顯示
  function showHint(key, text) {
    if (hints && typeof hints.showHint === 'function') return !!hints.showHint(key, text);
    const k = String(key || '');
    if (!k || !text || seen.has(k)) return false;
    seen.add(k);
    saveSeen(seen);
    hintText.textContent = String(text);
    hint.hidden = false;
    cancel(hintTimer);
    hintTimer = later(closeHint, HINT_SEC);
    return true;
  }

  // ---------- 被捕 / 送醫 ----------
  let active = null; // { overlay, resolve, timer, skipTimer, skipReady, prevFilter }

  // reason：done（時間到）/ skipped（點擊跳過）/ preempted（被新畫面搶占）/ disposed；呼叫端只在 done / skipped 時重生
  function finish(reason = 'done') {
    const a = active;
    if (!a) return;
    active = null;
    cancel(a.timer);
    cancel(a.skipTimer);
    doc.removeEventListener?.('pointerdown', onSkip, true);
    doc.removeEventListener?.('click', onSkip, true);
    if (a.overlay.parentNode) a.overlay.parentNode.removeChild(a.overlay);
    if (canvas && canvas.style) canvas.style.filter = a.prevFilter;
    a.resolve({ reason });
  }

  // 畫面存在期間的點擊一律吞掉（不傳到下層觸控鈕 / canvas，避免同一下點擊觸發攻擊或上車）
  function onSkip(e) {
    if (!active) return;
    e?.stopPropagation?.();
    e?.preventDefault?.();
    if (active.skipReady) finish('skipped');
  }

  function showOverlay(kind, amount) {
    finish('preempted'); // 前一個畫面未結束 → 先收掉（還原濾鏡）再開新的
    const txt = OVERLAY_TEXT[kind];
    const overlay = el('div', `wanted-overlay wanted-${kind}`);
    overlay.setAttribute('role', 'alert');
    overlay.appendChild(el('div', 'wanted-overlay-title', txt.title));
    overlay.appendChild(el('div', 'wanted-overlay-sub', txt.sub(amount)));
    overlayHost.appendChild(overlay);
    const prevFilter = canvas && canvas.style ? canvas.style.filter || '' : '';
    if (canvas && canvas.style) canvas.style.filter = GRAYSCALE_FILTER;
    return new Promise((resolve) => {
      const a = { overlay, resolve, prevFilter, skipReady: false, timer: null, skipTimer: null };
      active = a;
      a.timer = later(() => finish('done'), OVERLAY_SEC);
      a.skipTimer = later(() => {
        a.skipReady = true;
      }, SKIP_DELAY_SEC);
      doc.addEventListener?.('pointerdown', onSkip, true);
      doc.addEventListener?.('click', onSkip, true);
    });
  }

  const showBusted = ({ fine = 0 } = {}) => showOverlay('busted', fine);
  const showWasted = ({ fee = 0 } = {}) => showOverlay('wasted', fee);

  function dispose() {
    finish('disposed');
    closeHint();
    for (const n of [row, hint]) if (n.parentNode) n.parentNode.removeChild(n);
  }

  return {
    setStars,
    showBusted,
    showWasted,
    showHint,
    dispose,
    get overlayActive() {
      return active !== null;
    },
    els: { row, stars, hint, hintText, hintClose },
  };
}

// 無 DOM（node 無 document）：全部 no-op，被捕 / 送醫立即 resolve
function createNullUi() {
  const noop = () => {};
  return {
    setStars: noop,
    showBusted: () => Promise.resolve({ reason: 'done' }),
    showWasted: () => Promise.resolve({ reason: 'done' }),
    showHint: () => false,
    dispose: noop,
    overlayActive: false,
    els: null,
  };
}
