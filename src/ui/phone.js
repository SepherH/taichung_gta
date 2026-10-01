// 遊戲內手機（Phase 6，契約 §23.3）：右下滑出的面板；鎖屏顯示遊戲時間與天氣，三個 App：任務 / 地圖 / 設定
// 只做模組、不接線：依賴全部注入（bus / onOpenMap / onOpenSettings / onNavigate），不 import missions / main / core/**
// 生命週期：createPhone 時只註冊 keydown（capture），DOM 延遲到第一次 open 才建立；destroy() 移除 DOM 與 listener
// 時間：update(dt) 吃「渲染 dt」（§20：只做鎖屏自動解鎖、時鐘 / 列表刷新）；手機不暫停模擬，鎖輸入由整合層 syncPhone 處理
// 資料：setData({ hour, weatherIcon, money?, jobs }) 只存參照、不配置；實際寫 DOM 在 update / open / 切頁時（數值有變才寫）
// 鍵盤：開啟中 Esc / T / Backspace = 返回（App 頁先回首頁、首頁 / 鎖屏再按 = 關閉）；M / P / G 吞掉（不開大地圖 / 暫停 / 圖鑑）；
//   處理過的鍵一律 preventDefault + stopPropagation（同 main.js onPanelKey），按住重複（repeat）只吞不動作
// 音效 / 事件：open → ui:sound { kind: 'open' } + phone:open {}；close → ui:sound { kind: 'close' } + phone:close {}；
//   切 App / 分頁 → ui:sound { kind: 'click' }；返回 → ui:sound { kind: 'cancel' }
// 面板上的指標 / 觸控事件一律 stopPropagation，不傳到遊戲 canvas 與觸控層
import './phone.css';
import { formatMoney } from './menu-model.js';

export const PHONE_APPS = ['home', 'jobs', 'map', 'settings'];
// 任務 App 分頁（category 值 → 標籤），順序 = 顯示順序
export const JOB_TABS = [
  ['nearby', '附近'],
  ['mission', '委託'],
  ['job', '打工'],
];
export const WEATHER_LABELS = { sun: ['☀', '晴'], rain: ['🌧', '雨'], fog: ['🌫', '霧'] };
export const LOCK_SEC = 0.8; // 鎖屏停留秒數（渲染時間）；點一下或任何返回以外的操作立即解鎖
const LIST_REFRESH_SEC = 0.5; // 任務列表刷新間隔（距離會隨玩家移動變）
const SWALLOW_KEYS = new Set(['KeyM', 'KeyP', 'KeyG']);
const BACK_KEYS = new Set(['Escape', 'KeyT', 'Backspace']);

// 0–24 浮點小時 → 'HH:MM'（非數值 → '--:--'；24 → 00:00）
export function formatClock(hour) {
  if (!Number.isFinite(hour)) return '--:--';
  const total = Math.floor((((hour % 24) + 24) % 24) * 60 + 1e-6);
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// 公尺 → '350 m' / '1.2 km'（非數值 → '—'）
export function formatDistance(m) {
  if (!Number.isFinite(m) || m < 0) return '—';
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

export function weatherLabel(icon) {
  return WEATHER_LABELS[icon] || ['·', '—'];
}

// 依分類計數（out 重用）：{ nearby, mission, job }；未知 category 不計
export function countJobs(jobs, out = { nearby: 0, mission: 0, job: 0 }) {
  out.nearby = 0;
  out.mission = 0;
  out.job = 0;
  if (Array.isArray(jobs)) for (const it of jobs) if (it && out[it.category] !== undefined) out[it.category]++;
  return out;
}

// 指定分類的項目（out 重用）；進行中的排最前，其餘依距離近 → 遠
export function jobsInTab(jobs, tab, out = []) {
  out.length = 0;
  if (!Array.isArray(jobs)) return out;
  for (const it of jobs) if (it && it.category === tab) out.push(it);
  out.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || dist(a) - dist(b));
  return out;
}
const dist = (it) => (Number.isFinite(it.distanceM) ? it.distanceM : Infinity);

// 純狀態：返回鍵（Esc / T / Backspace / 手機返回鈕）的結果
//   App 頁 → 回首頁（'home'）；首頁 / 鎖屏 → 'close'
export function backTarget(state) {
  if (!state.locked && state.app !== 'home') return 'home';
  return 'close';
}

export function createPhone({
  root,
  bus,
  doc = globalThis.document,
  keyTarget = globalThis.window,
  isTouch = false,
  onOpenMap,
  onOpenSettings,
  onNavigate,
  now = () => (globalThis.performance && performance.now ? performance.now() : Date.now()),
} = {}) {
  const state = { open: false, locked: false, app: 'home', tab: 'nearby', lockT: 0, listT: 0 };
  const data = { hour: NaN, weatherIcon: '', money: undefined, jobs: null };
  const shown = { clock: '', weather: '', money: '', counts: '' }; // 已寫進 DOM 的值（變了才寫）
  const counts = { nearby: 0, mission: 0, job: 0 };
  const tabItems = [];
  let openedAt = -Infinity;
  let dom = null;
  let destroyed = false;

  const emit = (name, payload) => {
    try {
      if (bus && bus.emit) bus.emit(name, payload);
    } catch (err) {
      console.error('[phone] bus.emit 失敗', name, err);
    }
  };
  const sound = (kind) => emit('ui:sound', { kind });
  const call = (fn, ...a) => {
    if (typeof fn !== 'function') return;
    try {
      fn(...a);
    } catch (err) {
      console.error('[phone] callback 失敗', err);
    }
  };

  // ---------- DOM（第一次 open 才建） ----------
  function el(tag, cls, text) {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function button(cls, text, onTap) {
    const b = el('button', cls, text);
    b.setAttribute('type', 'button');
    b.addEventListener('click', (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      onTap(e);
    });
    return b;
  }
  const stop = (e) => e.stopPropagation();
  const STOP_EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'touchstart', 'touchmove', 'touchend', 'mousedown', 'wheel', 'contextmenu'];

  function build() {
    const r = el('div', 'ph-phone');
    r.setAttribute('role', 'dialog');
    r.setAttribute('aria-label', '手機');
    if (isTouch) r.classList.add('ph-touch');
    r.hidden = true;
    for (const t of STOP_EVENTS) r.addEventListener(t, stop);

    // 狀態列：時間 · 天氣 · 金錢
    const bar = el('div', 'ph-bar');
    const barClock = el('span', 'ph-bar-clock', '--:--');
    const barWeather = el('span', 'ph-bar-weather', '');
    const barMoney = el('span', 'ph-bar-money', '');
    bar.append(barClock, barWeather, barMoney);

    // 鎖屏：大時鐘 + 天氣，點一下解鎖
    const lock = el('div', 'ph-lock');
    const lockClock = el('div', 'ph-lock-clock', '--:--');
    const lockWeather = el('div', 'ph-lock-weather', '');
    const unlock = button('ph-unlock', '點一下解鎖', () => setLocked(false));
    lock.append(lockClock, lockWeather, unlock);
    lock.addEventListener('click', () => setLocked(false));

    // 首頁：三個 App 圖示
    const home = el('div', 'ph-home');
    const appBtns = {
      jobs: button('ph-app ph-app-jobs', '', () => launch('jobs')),
      map: button('ph-app ph-app-map', '', () => launch('map')),
      settings: button('ph-app ph-app-settings', '', () => launch('settings')),
    };
    const APP_FACE = { jobs: ['📋', '任務'], map: ['🗺', '地圖'], settings: ['⚙', '設定'] };
    for (const k of ['jobs', 'map', 'settings']) {
      appBtns[k].dataset.app = k;
      appBtns[k].append(el('span', 'ph-app-icon', APP_FACE[k][0]), el('span', 'ph-app-label', APP_FACE[k][1]));
      home.appendChild(appBtns[k]);
    }
    const badge = el('span', 'ph-badge', '');
    badge.hidden = true;
    appBtns.jobs.appendChild(badge);

    // 任務 App：分頁 + 列表
    const jobs = el('div', 'ph-jobs');
    const tabsRow = el('div', 'ph-tabs');
    const tabBtns = {};
    for (const [key, label] of JOB_TABS) {
      const b = button('ph-tab', label, () => setTab(key));
      b.dataset.tab = key;
      tabBtns[key] = b;
      tabsRow.appendChild(b);
    }
    const list = el('div', 'ph-list');
    const empty = el('div', 'ph-empty', '目前沒有項目');
    jobs.append(tabsRow, list, empty);

    // 底部：返回 / 首頁
    const nav = el('div', 'ph-nav');
    const backBtn = button('ph-back', '返回', () => back());
    nav.appendChild(backBtn);

    r.append(bar, lock, home, jobs, nav);
    root.appendChild(r);
    return { root: r, barClock, barWeather, barMoney, lock, lockClock, lockWeather, home, appBtns, badge, jobs, tabBtns, list, empty, rows: [] };
  }

  // 列表列（池化重用）：標題 / 狀態、酬勞 · 距離、導航鈕
  function makeRow() {
    const row = el('div', 'ph-row');
    const main = el('div', 'ph-row-main');
    const title = el('div', 'ph-row-title', '');
    const meta = el('div', 'ph-row-meta', '');
    main.append(title, meta);
    const go = button('ph-go', '導航', () => {
      const it = row._item;
      if (!it || !it.navigable || go.disabled) return;
      sound('confirm');
      call(onNavigate, it);
    });
    row.append(main, go);
    return { row, title, meta, go };
  }

  // ---------- 渲染 ----------
  function renderStatus() {
    const clock = formatClock(data.hour);
    if (clock !== shown.clock) {
      shown.clock = clock;
      dom.barClock.textContent = clock;
      dom.lockClock.textContent = clock;
    }
    const w = data.weatherIcon || '';
    if (w !== shown.weather) {
      shown.weather = w;
      const [icon, label] = weatherLabel(w);
      dom.barWeather.textContent = icon;
      dom.lockWeather.textContent = `${icon} ${label}`;
    }
    const money = Number.isFinite(data.money) ? formatMoney(data.money) : '';
    if (money !== shown.money) {
      shown.money = money;
      dom.barMoney.textContent = money;
    }
    countJobs(data.jobs, counts);
    const total = counts.nearby + counts.mission + counts.job;
    const key = `${counts.nearby},${counts.mission},${counts.job}`;
    if (key !== shown.counts) {
      shown.counts = key;
      dom.badge.textContent = String(total);
      dom.badge.hidden = total === 0;
      for (const [k, label] of JOB_TABS) dom.tabBtns[k].textContent = counts[k] ? `${label} ${counts[k]}` : label;
    }
  }

  function renderList() {
    jobsInTab(data.jobs, state.tab, tabItems);
    const rows = dom.rows;
    while (rows.length < tabItems.length) {
      const r = makeRow();
      rows.push(r);
      dom.list.appendChild(r.row);
    }
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const it = tabItems[i];
      r.row._item = it || null;
      r.row.hidden = !it;
      if (!it) continue;
      setText(r.title, (it.active ? '● ' : '') + (it.title || '（未命名）'));
      setText(r.meta, `${Number.isFinite(it.reward) ? formatMoney(it.reward) : '—'} · ${formatDistance(it.distanceM)}`);
      r.row.classList.toggle('ph-active', !!it.active);
      r.go.disabled = !it.navigable;
    }
    dom.empty.hidden = tabItems.length > 0;
  }
  const setText = (e, t) => {
    if (e.textContent !== t) e.textContent = t;
  };

  function renderPage() {
    const onLock = state.locked;
    dom.lock.hidden = !onLock;
    dom.home.hidden = onLock || state.app !== 'home';
    dom.jobs.hidden = onLock || state.app !== 'jobs';
    dom.root.dataset.app = onLock ? 'lock' : state.app;
    for (const [k] of JOB_TABS) dom.tabBtns[k].classList.toggle('ph-on', k === state.tab);
    renderStatus();
    if (!onLock && state.app === 'jobs') renderList();
  }

  // ---------- 狀態轉換 ----------
  function setLocked(v) {
    if (!state.open || state.locked === v) return;
    state.locked = v;
    state.lockT = 0;
    renderPage();
  }

  function setTab(tab) {
    if (!JOB_TABS.some(([k]) => k === tab)) return;
    if (state.tab !== tab) sound('click');
    state.tab = tab;
    state.listT = 0;
    if (dom) renderPage();
  }

  // 地圖 / 設定是啟動器 App（沒有頁面）：直接呼叫注入的 callback（整合層通常會先 phone.close()）
  function launch(app) {
    if (!state.open) return;
    state.locked = false;
    if (app === 'jobs') {
      if (state.app !== 'jobs') sound('click');
      state.app = 'jobs';
      state.listT = 0;
      renderPage();
    } else if (app === 'map') {
      sound('click');
      call(onOpenMap);
    } else if (app === 'settings') {
      sound('click');
      call(onOpenSettings);
    } else if (app === 'home') {
      state.app = 'home';
      renderPage();
    }
  }

  function back() {
    if (!state.open) return;
    if (backTarget(state) === 'close') {
      close();
      return;
    }
    sound('cancel');
    state.app = 'home';
    renderPage();
  }

  function open(app) {
    if (destroyed) return;
    if (app !== undefined && !PHONE_APPS.includes(app)) app = undefined;
    if (!state.open) {
      if (!dom) dom = build();
      state.open = true;
      state.app = 'home';
      state.locked = app === undefined; // 無指定 App → 先顯示鎖屏（LOCK_SEC 後自動解鎖）
      state.lockT = 0;
      state.listT = 0;
      openedAt = now();
      dom.root.hidden = false;
      dom.root.classList.add('ph-shown');
      renderPage();
      sound('open');
      emit('phone:open', {});
    }
    if (app !== undefined) launch(app);
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    state.locked = false;
    if (dom) {
      dom.root.classList.remove('ph-shown');
      dom.root.hidden = true;
    }
    sound('close');
    emit('phone:close', {});
  }

  function onKey(e) {
    if (!state.open) return;
    // 開啟手機的同一個按鍵事件（整合層在 keydown 內呼叫 open）不再處理，避免一開就關
    if (e.timeStamp && e.timeStamp < 1e12 && e.timeStamp <= openedAt) return;
    const code = e.code;
    if (!BACK_KEYS.has(code) && !SWALLOW_KEYS.has(code)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat || SWALLOW_KEYS.has(code)) return;
    back();
  }
  if (keyTarget && keyTarget.addEventListener) keyTarget.addEventListener('keydown', onKey, true);

  return {
    open,
    close,
    toggle() {
      if (state.open) close();
      else open();
    },
    isOpen: () => state.open,
    // 渲染 dt（§20）：鎖屏自動解鎖、時鐘與列表刷新；關閉中不做事
    update(dt) {
      if (!state.open || !dom) return;
      const d = Number.isFinite(dt) && dt > 0 ? dt : 0;
      if (state.locked) {
        state.lockT += d;
        if (state.lockT >= LOCK_SEC) setLocked(false);
      }
      renderStatus();
      if (!state.locked && state.app === 'jobs') {
        state.listT += d;
        if (state.listT >= LIST_REFRESH_SEC) {
          state.listT = 0;
          renderList();
        }
      }
    },
    setData(d) {
      if (!d) return;
      data.hour = d.hour;
      data.weatherIcon = d.weatherIcon;
      data.money = d.money;
      data.jobs = d.jobs;
    },
    setTab,
    destroy() {
      if (destroyed) return;
      if (state.open) close();
      destroyed = true;
      if (keyTarget && keyTarget.removeEventListener) keyTarget.removeEventListener('keydown', onKey, true);
      if (dom) {
        for (const t of STOP_EVENTS) dom.root.removeEventListener(t, stop);
        if (dom.root.parentNode) dom.root.parentNode.removeChild(dom.root);
        dom = null;
      }
    },
    get app() {
      return state.locked ? 'lock' : state.app;
    },
    get tab() {
      return state.tab;
    },
    get locked() {
      return state.locked;
    },
    get element() {
      return dom ? dom.root : null;
    },
  };
}
