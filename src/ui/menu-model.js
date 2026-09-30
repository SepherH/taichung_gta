// 選單狀態機（純邏輯，不碰 DOM，node 可測）：closed / start / pause 三態、頁面堆疊（主清單 → 子頁）、
// 鍵盤導覽（↑↓ 選擇、Enter 確認、Esc 返回上一層、最上層 Esc 或 P = 繼續）、選單內確認對話框，以及顯示用格式化函式
// 所有操作回傳「效果」物件（{ type, ... }）交給 menu.js 執行（emit 事件、改設定、捲動內容等），本檔不 emit 任何事件

// 主清單項目的顯示文字
export const ITEM_LABELS = {
  continue: '繼續遊戲',
  newGame: '開始新遊戲',
  resume: '繼續',
  map: '地圖',
  guide: '圖鑑',
  settings: '設定',
  help: '操作說明',
  stats: '統計',
  fullscreen: '全螢幕',
  quit: '回主選單',
};

// 子頁標題
export const PAGE_TITLES = { map: '地圖', settings: '設定', help: '操作說明', stats: '統計' };

// 開始畫面 / 暫停選單可開的子頁
export const START_PAGES = ['settings', 'help'];
export const PAUSE_PAGES = ['map', 'settings', 'help', 'stats'];

// 子頁的鍵盤模式：list = ↑↓ 在頁內項目間移動、←→ 調整；free = 方向鍵整組交給頁面（地圖平移、內容捲動、切分頁）
export const PAGE_MODES = { map: 'free', settings: 'list', help: 'free', stats: 'free' };

// 確認對話框文案（yes 為確定鈕、no 為取消鈕）
export const CONFIRMS = {
  newGame: { text: '開始新遊戲將覆蓋目前進度，確定嗎？', yes: '覆蓋並開始', no: '取消' },
  quit: { text: '確定要回到主選單嗎？', yes: '回主選單', no: '取消' },
};

export function startItems({ canContinue = false } = {}) {
  return canContinue ? ['continue', 'newGame', 'settings', 'help'] : ['newGame', 'settings', 'help'];
}

// guide：整合層有提供圖鑑（createMenu 的 onOpenGuide）時才列「圖鑑」（排在地圖後面）
export function pauseItems({ fullscreen = false, guide = false } = {}) {
  const items = guide ? ['resume', 'map', 'guide', 'settings', 'help', 'stats'] : ['resume', 'map', 'settings', 'help', 'stats'];
  if (fullscreen) items.push('fullscreen');
  items.push('quit');
  return items;
}

// opts.fullscreen：document.fullscreenEnabled 為真時暫停選單才列「全螢幕」；opts.guide：列「圖鑑」（啟動 → { type: 'guide' }）
export function createMenuModel({ fullscreen = false, guide = false } = {}) {
  let state = 'closed';
  let canContinue = false;
  let stack = []; // [{ id: 'root' | 子頁 id, items: string[], index }]
  let confirm = null; // { id, text, yes, no, index: 0 = 確定 / 1 = 取消 }
  const pageItems = {}; // 子頁的可聚焦項目（由 menu.js 設定）

  const top = () => stack[stack.length - 1] || null;
  const pages = () => (state === 'pause' ? PAUSE_PAGES : state === 'start' ? START_PAGES : []);

  function makeRoot() {
    const items = state === 'pause' ? pauseItems({ fullscreen, guide }) : startItems({ canContinue });
    return { id: 'root', items, index: 0 };
  }

  function showStart(opts = {}) {
    state = 'start';
    canContinue = !!opts.canContinue;
    confirm = null;
    stack = [makeRoot()]; // 有存檔時「繼續遊戲」排第一 = 預設焦點
    return { type: 'show', state };
  }

  function openPause(tab) {
    if (state !== 'pause') {
      state = 'pause';
      confirm = null;
      stack = [makeRoot()];
    }
    if (tab && PAUSE_PAGES.includes(tab)) openPage(tab);
    return { type: 'show', state, tab: currentTab() };
  }

  function close() {
    state = 'closed';
    stack = [];
    confirm = null;
  }

  function currentTab() {
    return stack.length > 1 ? top().id : null;
  }

  // 開子頁：子頁彼此是平行分頁（已在子頁時直接替換，不越疊越深）
  function openPage(id) {
    if (!pages().includes(id)) return null;
    const root = stack[0];
    const ri = root.items.indexOf(id);
    if (ri >= 0) root.index = ri;
    const entry = { id, items: (pageItems[id] || []).slice(), index: 0 };
    if (stack.length > 1) stack[stack.length - 1] = entry;
    else stack.push(entry);
    return { type: 'page', page: id };
  }

  function setItems(pageId, items) {
    pageItems[pageId] = items.slice();
    for (const e of stack) {
      if (e.id !== pageId) continue;
      e.items = items.slice();
      e.index = Math.min(e.index, Math.max(0, e.items.length - 1));
    }
  }

  function move(delta) {
    const t = top();
    if (!t || !t.items.length) return null;
    const n = t.items.length;
    t.index = (((t.index + delta) % n) + n) % n;
    return { type: 'focus', item: t.items[t.index] };
  }

  function focusItem(id) {
    const t = top();
    if (!t) return false;
    const i = t.items.indexOf(id);
    if (i < 0) return false;
    t.index = i;
    return true;
  }

  function resume() {
    close();
    return { type: 'resume' };
  }

  function ask(id) {
    confirm = { id, ...CONFIRMS[id], index: 1 }; // 預設焦點在「取消」，避免誤按 Enter 覆蓋進度
    return { type: 'confirm', id };
  }

  // 啟動項目（id 省略 = 目前焦點）；主清單項目在這裡決定流程，子頁項目原樣交給 menu.js
  function activate(id) {
    if (state === 'closed') return null;
    if (confirm) return answer(confirm.index === 0);
    const t = top();
    if (id === undefined) id = t.items[t.index];
    if (id === undefined) return null;
    if (t.id !== 'root' && t.items.includes(id)) {
      focusItem(id);
      return { type: 'activate', page: t.id, item: id };
    }
    const root = stack[0];
    if (!root.items.includes(id)) return null;
    root.index = root.items.indexOf(id);
    switch (id) {
      case 'continue':
        close();
        return { type: 'start', continued: true };
      case 'newGame':
        if (canContinue) return ask('newGame');
        close();
        return { type: 'start', continued: false };
      case 'resume':
        return resume();
      case 'fullscreen':
        return { type: 'fullscreen' };
      case 'guide':
        // 圖鑑是獨立全螢幕面板（food-guide，z 80–89）：選單先關閉再交給整合層開啟
        close();
        return { type: 'guide' };
      case 'quit':
        return ask('quit');
      default:
        return openPage(id);
    }
  }

  function answer(yes) {
    if (!confirm) return null;
    const id = confirm.id;
    confirm = null;
    if (!yes) return { type: 'cancel', id };
    if (id === 'newGame') {
      close();
      return { type: 'start', continued: false };
    }
    if (id === 'quit') {
      close();
      return { type: 'quitToMenu' };
    }
    return null;
  }

  // 返回上一層：確認框 → 取消；子頁 → 主清單；暫停主清單 → 繼續遊戲；開始畫面主清單 → 不動
  function back() {
    if (confirm) return answer(false);
    if (stack.length > 1) {
      const page = stack.pop().id;
      return { type: 'back', page };
    }
    if (state === 'pause') return resume();
    return { type: 'none' };
  }

  // 鍵盤：回傳效果；null = 本選單不處理（menu.js 不攔截該鍵）
  function key(code, { shift = false } = {}) {
    if (state === 'closed') return null;
    if (confirm) {
      if (code === 'Escape') return answer(false);
      if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space') return answer(confirm.index === 0);
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab'].includes(code)) {
        confirm.index = 1 - confirm.index;
        return { type: 'focus', item: confirm.index === 0 ? 'yes' : 'no' };
      }
      return { type: 'none' }; // 對話框開著時吃掉其他鍵
    }
    const t = top();
    const sub = t.id !== 'root';
    const free = sub && PAGE_MODES[t.id] === 'free';
    switch (code) {
      case 'Escape':
      case 'Backspace':
        if (code === 'Backspace' && !sub) return { type: 'none' };
        return back();
      case 'KeyP':
        return state === 'pause' ? resume() : null;
      case 'KeyM':
        if (state !== 'pause') return null;
        return t.id === 'map' ? resume() : openPage('map');
      case 'Enter':
      case 'NumpadEnter':
        return activate();
      case 'Tab':
        return free ? { type: 'none' } : move(shift ? -1 : 1);
      case 'ArrowUp':
      case 'ArrowDown': {
        const d = code === 'ArrowUp' ? -1 : 1;
        if (free) return { type: 'arrow', page: t.id, dx: 0, dy: d };
        return move(d);
      }
      case 'ArrowLeft':
      case 'ArrowRight': {
        const d = code === 'ArrowLeft' ? -1 : 1;
        if (free) return { type: 'arrow', page: t.id, dx: d, dy: 0 };
        if (sub && t.items.length) return { type: 'adjust', page: t.id, item: t.items[t.index], dir: d };
        return { type: 'none' };
      }
      case 'Equal':
      case 'NumpadAdd':
      case 'Minus':
      case 'NumpadSubtract':
        if (t.id !== 'map') return null;
        return { type: 'zoom', dir: code === 'Equal' || code === 'NumpadAdd' ? 1 : -1 };
      default:
        return null;
    }
  }

  return {
    get state() {
      return state;
    },
    get canContinue() {
      return canContinue;
    },
    get page() {
      const t = top();
      return t ? t.id : null;
    },
    get tab() {
      return currentTab();
    },
    get depth() {
      return stack.length;
    },
    get rootItems() {
      return stack[0] ? stack[0].items.slice() : [];
    },
    get rootFocus() {
      return stack[0] ? stack[0].items[stack[0].index] : null;
    },
    get items() {
      const t = top();
      return t ? t.items.slice() : [];
    },
    get focus() {
      if (confirm) return confirm.index === 0 ? 'yes' : 'no';
      const t = top();
      return t ? (t.items[t.index] ?? null) : null;
    },
    get confirm() {
      return confirm ? { ...confirm } : null;
    },
    showStart,
    openPause,
    close,
    openPage,
    setItems,
    move,
    focusItem,
    activate,
    answer,
    back,
    key,
  };
}

// ---------- 格式化 ----------
const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

// 秒 → h:mm:ss
export function formatDuration(sec) {
  const s = Math.floor(num(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

// 公尺 → 「1.2 km」（小數一位）
export function formatKm(m) {
  return `${(num(m) / 1000).toFixed(1)} km`;
}

// 金額 → 「NT$1,234」（四捨五入到元，負數前置減號）
export function formatMoney(n) {
  const v = Number.isFinite(n) ? Math.round(n) : 0;
  const digits = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${v < 0 ? '-' : ''}NT$${digits}`;
}
