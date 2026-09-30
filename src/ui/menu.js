// 選單 UI：開始畫面（含內容標示）、暫停選單（繼續 / 地圖 / 圖鑑 / 設定 / 操作說明 / 統計 / 全螢幕 / 回主選單）、選單內確認對話框
// 狀態與鍵盤導覽由 menu-model.js 決定，本檔只負責 DOM、事件與把效果轉成 bus 事件 / settings.set
// 依賴全部注入（settings / bus / keymapHelp / touchHelp / getStats / getMoney / hasSave / mapView / onOpenGuide），不 import src/core/**
// 「圖鑑」只在有給 onOpenGuide 時列出：點下後選單關閉（不 emit game:pause）並呼叫 onOpenGuide()，圖鑑關閉後由整合層決定回暫停選單或繼續
// 音效：選單操作一律 bus.emit('ui:sound', { kind })（開頁 / 開選單 open、繼續 close、開始 / 確定 confirm、返回 / 取消 cancel、其餘 click）
// 背景半透明，場景由整合層持續渲染；overlay 上的指標 / 觸控事件一律 stopPropagation，不傳到遊戲 canvas 與觸控層
import './menu.css';
import { createMenuModel, ITEM_LABELS, PAGE_TITLES, formatDuration, formatKm, formatMoney } from './menu-model.js';

const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';
const START_TIP = '小提示：新光三越、老虎城一帶最熱鬧，路上行人也最多。';
export const CONTENT_NOTICE = '本遊戲含槍械、暴力與血液畫面';

// 設定頁的列（鍵名 / 範圍對齊契約 §2 SETTINGS_SCHEMA）
const pct = (v) => `${Math.round(v * 100)}%`;
const mul = (v) => `${v.toFixed(1)}×`;
const SETTING_ROWS = [
  {
    key: 'quality',
    type: 'segment',
    label: '畫質',
    options: [
      ['auto', '自動'],
      ['low', '低'],
      ['mid', '中'],
      ['high', '高'],
      ['ultra', '極致'],
    ],
    note: '人車數量即時套用；解析度與陰影重新整理後完整套用',
  },
  { key: 'lookSensMouse', type: 'range', label: '滑鼠靈敏度', min: 0.3, max: 3, step: 0.1, fmt: mul },
  { key: 'lookSensTouch', type: 'range', label: '觸控靈敏度', min: 0.3, max: 3, step: 0.1, fmt: mul },
  { key: 'invertY', type: 'toggle', label: '反轉 Y 軸' },
  { key: 'volumeMaster', type: 'range', label: '主音量', min: 0, max: 1, step: 0.05, fmt: pct },
  { key: 'volumeMusic', type: 'range', label: '音樂', min: 0, max: 1, step: 0.05, fmt: pct },
  { key: 'volumeSfx', type: 'range', label: '音效', min: 0, max: 1, step: 0.05, fmt: pct },
  { key: 'showBlood', type: 'toggle', label: '顯示血液', note: '關閉後不顯示地面血跡與血滴' },
  { key: 'recoil', type: 'range', label: '後座力', min: 0.2, max: 1, step: 0.1, fmt: pct },
  { key: 'aimAssist', type: 'toggle', label: '瞄準輔助', note: '只作用於觸控操作' },
  { key: 'showFps', type: 'toggle', label: '顯示 FPS' },
  { key: 'showHints', type: 'toggle', label: '新手提示' },
  { key: 'uiScale', type: 'range', label: '介面大小', min: 0.8, max: 1.3, step: 0.05, fmt: pct },
];

// 統計頁欄位（getStats() 的鍵 → 標題與格式）
const STAT_ROWS = [
  ['playTimeSec', '遊玩時間', formatDuration],
  ['distWalkM', '步行距離', formatKm],
  ['distDriveM', '駕駛距離', formatKm],
  ['pedsHit', '撞到行人', String],
  ['pedsKnockedOut', '打倒路人', String],
  ['carjacks', '搶車次數', String],
  ['crashes', '車禍', String],
  ['kos', '被打倒次數', String],
  ['moneyEarned', '累計收入', formatMoney],
  ['moneySpent', '累計支出', formatMoney],
];

// 會被攔下、不傳到遊戲層的指標 / 觸控事件
const STOP_EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'wheel', 'contextmenu', 'touchstart', 'touchmove', 'touchend', 'touchcancel'];

export function createMenu({
  root,
  settings,
  bus,
  keymapHelp = [],
  touchHelp = [],
  isTouch = false,
  attribution = '',
  getStats = () => ({}),
  getMoney = () => 0,
  hasSave = () => false,
  mapView = null,
  onOpenGuide = null,
}) {
  const doc = globalThis.document;
  const win = typeof window !== 'undefined' ? window : null;
  const fsEnabled = !!(doc.fullscreenEnabled || doc.webkitFullscreenEnabled);
  const hasGuide = typeof onOpenGuide === 'function';
  const model = createMenuModel({ fullscreen: fsEnabled, guide: hasGuide });
  // 介面音效（§10 ui:sound）；bus 缺 emit 或 listener 例外都不影響選單
  const sound = (kind) => {
    try {
      if (bus && bus.emit) bus.emit('ui:sound', { kind });
    } catch (err) {
      // 忽略
    }
  };
  const cleanups = [];
  const listen = (target, type, fn, opts) => {
    if (!target || !target.addEventListener) return;
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  };

  const h = (tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const button = (cls, text, fn) => {
    const b = h('button', `tg-btn ${cls}`, text);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  };

  // ---------- 骨架 ----------
  const el = h('div', 'tg-menu');
  el.id = 'tg-menu';
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  const frame = h('div', 'tg-menu-frame');
  el.appendChild(frame);

  const head = h('header', 'tg-menu-head');
  const brand = h('div', 'tg-menu-brand');
  const title = h('h1', 'tg-menu-title', '臺中GTA');
  const subtitle = h('div', 'tg-menu-sub', '七期精華區');
  const pauseTitle = h('div', 'tg-menu-pausetitle', '暫停');
  // 內容標示：只在開始畫面顯示（menu.css 控制），位於標題下方、不與左欄按鈕重疊
  const notice = h('div', 'tg-menu-notice', CONTENT_NOTICE);
  notice.setAttribute('role', 'note');
  brand.append(title, subtitle, notice, pauseTitle);
  const moneyEl = h('div', 'tg-menu-money');
  head.append(brand, moneyEl);

  const body = h('div', 'tg-menu-body');
  const nav = h('nav', 'tg-menu-nav');
  nav.setAttribute('role', 'menu');
  const content = h('section', 'tg-menu-content');
  const pageHead = h('div', 'tg-page-head');
  const backBtn = button('tg-page-back', '← 返回', () => run(model.back()));
  const pageTitle = h('h2', 'tg-page-title');
  pageHead.append(backBtn, pageTitle);
  const scroller = h('div', 'tg-page-scroll');
  content.append(pageHead, scroller);
  body.append(nav, content);

  const foot = h('footer', 'tg-menu-foot');
  const hintEl = h('div', 'tg-menu-hint');
  const attrEl = h('div', 'tg-menu-attr');
  renderAttribution(attrEl, attribution);
  foot.append(hintEl, attrEl);
  frame.append(head, body, foot);

  // 確認對話框
  const confirmEl = h('div', 'tg-confirm');
  confirmEl.hidden = true;
  const confirmBox = h('div', 'tg-confirm-box');
  confirmBox.setAttribute('role', 'alertdialog');
  const confirmText = h('p', 'tg-confirm-text');
  const confirmBtns = h('div', 'tg-confirm-btns');
  const yesBtn = button('tg-confirm-yes', '確定', () => run(model.answer(true)));
  const noBtn = button('tg-confirm-no', '取消', () => run(model.answer(false)));
  confirmBtns.append(noBtn, yesBtn);
  confirmBox.append(confirmText, confirmBtns);
  confirmEl.appendChild(confirmBox);
  el.appendChild(confirmEl);

  for (const t of STOP_EVENTS) listen(el, t, (e) => e.stopPropagation(), t.startsWith('touch') || t === 'wheel' ? { passive: true } : undefined);

  // ---------- 主清單 ----------
  const navBtns = new Map();
  let navKey = '';
  function buildNav() {
    const items = model.rootItems;
    const key = items.join(',');
    if (key === navKey) return;
    navKey = key;
    nav.textContent = '';
    navBtns.clear();
    for (const id of items) {
      const b = button(`tg-nav-item tg-nav-${id}`, labelFor(id), () => {
        kbNav = false;
        // 暫停選單的「繼續」：在同一個 click 內同步 emit（整合層要在同一個使用者手勢內重新鎖定滑鼠）
        run(model.activate(id));
      });
      b.setAttribute('role', 'menuitem');
      b.dataset.item = id;
      nav.appendChild(b);
      navBtns.set(id, b);
    }
  }
  const fsActive = () => !!(doc.fullscreenElement || doc.webkitFullscreenElement);
  function labelFor(id) {
    if (id === 'fullscreen') return fsActive() ? '離開全螢幕' : '全螢幕';
    return ITEM_LABELS[id] || id;
  }

  // ---------- 子頁：設定 ----------
  const pagesEl = {};
  const settingsPage = h('div', 'tg-page tg-page-settings');
  const rowEls = new Map(); // key → { row, update(value) }
  for (const def of SETTING_ROWS) {
    const row = h('div', `tg-set-row tg-set-${def.type}`);
    row.dataset.item = def.key;
    const label = h('div', 'tg-set-label', def.label);
    row.appendChild(label);
    let update;
    if (def.type === 'segment') {
      const seg = h('div', 'tg-seg');
      seg.setAttribute('role', 'radiogroup');
      const btns = def.options.map(([v, text]) => {
        const b = button('tg-seg-btn', text, () => {
          kbNav = false;
          model.focusItem(def.key);
          settings.set(def.key, v);
          refreshSetting(def.key);
          sound('click');
          render();
        });
        b.dataset.value = v;
        seg.appendChild(b);
        return b;
      });
      row.appendChild(seg);
      update = (value) => btns.forEach((b) => b.classList.toggle('tg-on', b.dataset.value === value));
    } else if (def.type === 'range') {
      const wrap = h('div', 'tg-range-wrap');
      const input = h('input', 'tg-range');
      input.type = 'range';
      input.min = String(def.min);
      input.max = String(def.max);
      input.step = String(def.step);
      input.setAttribute('aria-label', def.label);
      const out = h('span', 'tg-range-val');
      input.addEventListener('input', () => {
        model.focusItem(def.key);
        settings.set(def.key, parseFloat(input.value));
        refreshSetting(def.key);
      });
      input.addEventListener('change', () => sound('click')); // 放開滑桿時一次，拖曳中不連發
      wrap.append(input, out);
      row.appendChild(wrap);
      update = (value) => {
        const v = Number(value);
        if (!Number.isFinite(v)) return; // 設定尚未提供此鍵（舊版 settings）時維持滑桿原狀
        if (String(input.value) !== String(v)) input.value = String(v);
        out.textContent = def.fmt(v);
      };
    } else {
      const tg = button('tg-toggle', '', () => {
        kbNav = false;
        model.focusItem(def.key);
        settings.set(def.key, !settings.get(def.key));
        refreshSetting(def.key);
        sound('click');
        render();
      });
      tg.setAttribute('role', 'switch');
      row.appendChild(tg);
      update = (value) => {
        tg.classList.toggle('tg-on', !!value);
        tg.setAttribute('aria-checked', value ? 'true' : 'false');
        tg.textContent = value ? '開' : '關';
      };
    }
    if (def.note) row.appendChild(h('div', 'tg-set-note', def.note));
    settingsPage.appendChild(row);
    rowEls.set(def.key, { row, def, update });
  }
  const resetRow = h('div', 'tg-set-row tg-set-reset');
  resetRow.dataset.item = 'reset';
  resetRow.appendChild(
    button('tg-reset-btn', '恢復預設', () => {
      kbNav = false;
      model.focusItem('reset');
      resetSettings();
      sound('confirm');
      render();
    }),
  );
  settingsPage.appendChild(resetRow);
  pagesEl.settings = settingsPage;
  model.setItems('settings', [...SETTING_ROWS.map((d) => d.key), 'reset']);

  function refreshSetting(key) {
    const r = rowEls.get(key);
    if (r) r.update(settings.get(key));
  }
  function refreshSettings() {
    for (const key of rowEls.keys()) refreshSetting(key);
  }
  function resetSettings() {
    settings.reset();
    refreshSettings();
  }
  if (settings.subscribe) {
    const off = settings.subscribe((key) => {
      if (key && rowEls.has(key)) refreshSetting(key);
      else refreshSettings();
    });
    if (typeof off === 'function') cleanups.push(off);
  }

  // 鍵盤調整設定：←→ 改值、Enter 切換 / 下一段 / 恢復預設
  function adjustSetting(key, dir, enter = false) {
    if (key === 'reset') {
      if (enter) resetSettings();
      return;
    }
    const r = rowEls.get(key);
    if (!r) return;
    const { def } = r;
    const cur = settings.get(key);
    if (def.type === 'toggle') {
      settings.set(key, enter ? !cur : dir > 0);
    } else if (def.type === 'segment') {
      const vals = def.options.map((o) => o[0]);
      let i = vals.indexOf(cur);
      i = enter ? (i + 1) % vals.length : Math.min(vals.length - 1, Math.max(0, i + dir));
      settings.set(key, vals[i]);
    } else {
      const v = Math.min(def.max, Math.max(def.min, Number(cur) + dir * def.step));
      settings.set(key, Math.round(v / def.step) * def.step);
    }
    refreshSetting(key);
  }

  // ---------- 子頁：操作說明（內容全部由 keymapHelp / touchHelp 產生）----------
  const helpPage = h('div', 'tg-page tg-page-help');
  const helpTabs = h('div', 'tg-tabs');
  helpTabs.setAttribute('role', 'tablist');
  const helpBody = h('div', 'tg-help-body');
  const helpSets = [
    ['keyboard', '鍵盤', keymapHelp],
    ['touch', '觸控', touchHelp],
  ].filter(([, , list]) => Array.isArray(list) && list.length);
  let helpTab = isTouch && helpSets.some((s) => s[0] === 'touch') ? 'touch' : helpSets[0] ? helpSets[0][0] : null;
  const helpTabBtns = new Map();
  for (const [id, text] of helpSets) {
    const b = button('tg-tab', text, () => {
      helpTab = id;
      sound('click');
      renderHelp();
    });
    b.setAttribute('role', 'tab');
    helpTabs.appendChild(b);
    helpTabBtns.set(id, b);
  }
  if (helpSets.length > 1) helpPage.appendChild(helpTabs);
  helpPage.appendChild(helpBody);
  pagesEl.help = helpPage;
  function renderHelp() {
    helpBody.textContent = '';
    for (const [id, b] of helpTabBtns) {
      b.classList.toggle('tg-on', id === helpTab);
      b.setAttribute('aria-selected', id === helpTab ? 'true' : 'false');
    }
    const set = helpSets.find((s) => s[0] === helpTab);
    if (!set) {
      helpBody.appendChild(h('p', 'tg-empty', '目前沒有操作說明。'));
      return;
    }
    for (const g of set[2]) {
      const sec = h('section', 'tg-help-group');
      sec.appendChild(h('h3', 'tg-help-title', g.group));
      for (const it of g.items || []) {
        const row = h('div', 'tg-help-row');
        row.append(h('kbd', 'tg-kbd', String(it.keys)), h('span', 'tg-help-desc', it.desc || ''));
        sec.appendChild(row);
      }
      helpBody.appendChild(sec);
    }
  }
  renderHelp();

  // ---------- 子頁：統計 ----------
  const statsPage = h('div', 'tg-page tg-page-stats');
  pagesEl.stats = statsPage;
  function renderStats() {
    statsPage.textContent = '';
    let s = {};
    try {
      s = getStats() || {};
    } catch (err) {
      console.error('[menu] getStats 失敗', err);
    }
    const grid = h('dl', 'tg-stats');
    const add = (label, value) => {
      const row = h('div', 'tg-stat');
      row.append(h('dt', 'tg-stat-k', label), h('dd', 'tg-stat-v', value));
      grid.appendChild(row);
    };
    add('目前金錢', formatMoney(readMoney()));
    for (const [key, label, fmt] of STAT_ROWS) add(label, fmt(Number.isFinite(s[key]) ? s[key] : 0));
    statsPage.appendChild(grid);
  }

  // ---------- 子頁：地圖 ----------
  const mapPage = h('div', 'tg-page tg-page-map');
  if (mapView && mapView.el) mapPage.appendChild(mapView.el);
  else mapPage.appendChild(h('p', 'tg-empty', '地圖尚未載入。'));
  pagesEl.map = mapPage;
  let mapOpen = false;

  // 暫停選單在主清單時右側的預設內容
  const homePage = h('div', 'tg-page tg-page-home');
  homePage.appendChild(h('p', 'tg-home-text', '遊戲已暫停。'));
  pagesEl.root = homePage;

  for (const p of Object.values(pagesEl)) {
    p.hidden = true;
    scroller.appendChild(p);
  }

  // ---------- 金錢 ----------
  function readMoney() {
    try {
      const m = getMoney();
      return Number.isFinite(m) ? m : 0;
    } catch {
      return 0;
    }
  }
  const setMoney = (m) => {
    moneyEl.textContent = formatMoney(m);
  };
  if (bus && bus.on) {
    const off = bus.on('player:money', (p) => {
      if (p && Number.isFinite(p.money)) setMoney(p.money);
    });
    if (typeof off === 'function') cleanups.push(off);
  }

  // ---------- 全螢幕 ----------
  function toggleFullscreen() {
    const de = doc.documentElement;
    try {
      if (fsActive()) {
        const p = (doc.exitFullscreen || doc.webkitExitFullscreen || (() => {})).call(doc);
        if (p && p.catch) p.catch(() => {});
      } else if (de) {
        const req = de.requestFullscreen || de.webkitRequestFullscreen;
        const p = req && req.call(de, { navigationUI: 'hide' });
        if (p && p.catch) p.catch(() => {});
      }
    } catch (err) {
      console.error('[menu] 全螢幕切換失敗', err);
    }
  }
  const onFsChange = () => {
    const b = navBtns.get('fullscreen');
    if (b) b.textContent = labelFor('fullscreen');
  };
  listen(doc, 'fullscreenchange', onFsChange);
  listen(doc, 'webkitfullscreenchange', onFsChange);

  // ---------- 鍵盤 ----------
  let kbNav = false;
  let openedAt = -Infinity;
  const now = () => (globalThis.performance && performance.now ? performance.now() : Date.now());
  function onKey(e) {
    if (model.state === 'closed') return;
    // 開啟選單的同一個按鍵事件（例如整合層在 keydown 內呼叫 openPause）不再處理，避免一開就關
    if (e.timeStamp && e.timeStamp < 1e12 && e.timeStamp <= openedAt) return;
    if (e.repeat && (e.code === 'Escape' || e.code === 'KeyP' || e.code === 'KeyM' || e.code === 'Enter')) {
      e.preventDefault();
      return;
    }
    const fx = model.key(e.code, { shift: e.shiftKey });
    if (!fx) return;
    e.preventDefault();
    e.stopPropagation();
    kbNav = true;
    run(fx);
  }
  if (win) listen(win, 'keydown', onKey, true);

  // ---------- 效果執行 ----------
  // 效果 → 介面音效種類（focus / arrow / zoom / none 等不出聲，避免鍵盤導覽時連發）
  const FX_SOUND = {
    start: 'confirm',
    quitToMenu: 'confirm',
    resume: 'close',
    guide: 'open',
    page: 'open',
    confirm: 'open',
    cancel: 'cancel',
    back: 'cancel',
    activate: 'click',
    adjust: 'click',
    fullscreen: 'click',
  };
  function run(fx) {
    if (!fx) {
      render();
      return;
    }
    if (FX_SOUND[fx.type]) sound(FX_SOUND[fx.type]);
    switch (fx.type) {
      case 'start':
        render();
        bus.emit('game:start', { continued: !!fx.continued });
        break;
      case 'resume':
        render();
        bus.emit('game:pause', { paused: false });
        break;
      case 'quitToMenu':
        bus.emit('game:quitToMenu', {});
        model.showStart({ canContinue: safeHasSave() });
        render();
        break;
      case 'fullscreen':
        toggleFullscreen();
        render();
        break;
      case 'guide':
        // 選單關閉但不 emit game:pause（遊戲仍暫停，由圖鑑面板接手輸入）；整合層在圖鑑關閉時恢復
        render();
        try {
          onOpenGuide();
        } catch (err) {
          console.error('[menu] onOpenGuide 失敗', err);
        }
        break;
      case 'activate':
        if (fx.page === 'settings') adjustSetting(fx.item, 0, true);
        render();
        break;
      case 'adjust':
        if (fx.page === 'settings') adjustSetting(fx.item, fx.dir);
        render();
        break;
      case 'arrow':
        if (fx.page === 'map' && mapView && mapView.panKeys) mapView.panKeys(fx.dx, fx.dy);
        else if (fx.page === 'help' && fx.dx && helpSets.length > 1) {
          const i = helpSets.findIndex((s) => s[0] === helpTab);
          helpTab = helpSets[(i + fx.dx + helpSets.length) % helpSets.length][0];
          renderHelp();
        } else if (fx.dy) scroller.scrollTop += fx.dy * 60;
        break;
      case 'zoom':
        if (mapView && mapView.zoomBy) mapView.zoomBy(fx.dir > 0 ? 1.5 : 1 / 1.5);
        break;
      default:
        render();
    }
  }

  function safeHasSave() {
    try {
      return !!hasSave();
    } catch {
      return false;
    }
  }

  // ---------- 繪製狀態 ----------
  let shownPage = null;
  function render() {
    const state = model.state;
    const open = state !== 'closed';
    el.hidden = !open;
    el.dataset.mode = state;
    if (!open) {
      showPage(null);
      return;
    }
    buildNav();
    const page = model.page;
    const sub = page !== 'root';
    el.dataset.sub = sub ? '1' : '0';
    hintEl.textContent = state === 'start' ? START_TIP : isTouch ? '點選左側項目；點「繼續」回到遊戲' : 'Enter 選擇・Esc 返回・P 繼續';
    // 主清單焦點 / 目前分頁
    const rootFocus = model.rootFocus;
    for (const [id, b] of navBtns) {
      b.classList.toggle('tg-focus', !sub && id === rootFocus);
      b.classList.toggle('tg-on', sub && id === page);
      b.setAttribute('aria-current', sub && id === page ? 'page' : 'false');
    }
    pageTitle.textContent = sub ? PAGE_TITLES[page] || '' : '';
    showPage(state === 'pause' || sub ? page : null);
    // 子頁項目焦點
    const focus = model.focus;
    if (page === 'settings') {
      for (const [key, r] of rowEls) r.row.classList.toggle('tg-focus', kbNav && key === focus);
      resetRow.classList.toggle('tg-focus', kbNav && focus === 'reset');
    }
    // 確認框
    const c = model.confirm;
    confirmEl.hidden = !c;
    if (c) {
      confirmText.textContent = c.text;
      yesBtn.textContent = c.yes;
      noBtn.textContent = c.no;
      yesBtn.classList.toggle('tg-focus', c.index === 0);
      noBtn.classList.toggle('tg-focus', c.index === 1);
    }
    if (kbNav) moveDomFocus(c, sub, rootFocus, focus);
  }

  // 鍵盤操作時把瀏覽器焦點跟著移動（觸控 / 滑鼠操作時不動，避免手機跳出鍵盤或捲動）
  function moveDomFocus(c, sub, rootFocus, focus) {
    let target = null;
    if (c) target = c.index === 0 ? yesBtn : noBtn;
    else if (!sub) target = navBtns.get(rootFocus);
    else if (model.page === 'settings') {
      const r = rowEls.get(focus);
      const row = r ? r.row : focus === 'reset' ? resetRow : null;
      target = row && row.querySelector ? row.querySelector('input, button') : null;
      if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
    }
    if (target && target.focus) {
      try {
        target.focus({ preventScroll: true });
      } catch {
        // 舊瀏覽器不支援參數
      }
    }
  }

  function showPage(id) {
    if (id === shownPage) return;
    if (shownPage && pagesEl[shownPage]) pagesEl[shownPage].hidden = true;
    if (shownPage === 'map' && mapOpen) {
      mapOpen = false;
      if (mapView) mapView.close();
    }
    shownPage = id;
    if (!id || !pagesEl[id]) return;
    pagesEl[id].hidden = false;
    scroller.scrollTop = 0;
    if (id === 'settings') refreshSettings();
    if (id === 'stats') renderStats();
    if (id === 'map' && mapView) {
      mapOpen = true;
      mapView.open();
    }
  }

  root.appendChild(el);

  // ---------- 對外 API（契約 §8）----------
  const api = {
    el,
    showStart({ canContinue = false } = {}) {
      model.showStart({ canContinue });
      openedAt = now();
      kbNav = false;
      render();
    },
    hideStart() {
      if (model.state !== 'start') return;
      model.close();
      render();
    },
    // tab：'map' | 'settings' | 'help' | 'stats'；開始畫面顯示中時不處理（回傳 false）；圖鑑關閉後可呼叫 openPause() 回暫停選單
    openPause(tab) {
      if (model.state === 'start') return false;
      const wasOpen = model.state === 'pause';
      model.openPause(tab);
      openedAt = now();
      kbNav = false;
      setMoney(readMoney());
      render();
      if (!wasOpen) {
        sound('open');
        bus.emit('game:pause', { paused: true, tab: model.tab || undefined });
      }
      return true;
    },
    // 關閉：暫停中 = 繼續遊戲（emit game:pause { paused:false }）；開始畫面 = 單純隱藏
    close() {
      const st = model.state;
      if (st === 'closed') return;
      model.close();
      render();
      if (st === 'pause') {
        sound('close');
        bus.emit('game:pause', { paused: false });
      }
    },
    isOpen: () => model.state !== 'closed',
    get state() {
      return model.state;
    },
    get page() {
      return model.page;
    },
    destroy() {
      if (mapOpen && mapView) mapView.close();
      mapOpen = false;
      for (const fn of cleanups.splice(0)) fn();
      if (el.parentNode) el.parentNode.removeChild(el);
    },
  };
  return api;
}

// 授權文字：純文字，其中的「OpenStreetMap」包成指向版權頁的連結；另接受 { text, href }
function renderAttribution(target, attribution) {
  const doc = globalThis.document;
  const text = typeof attribution === 'string' ? attribution : (attribution && attribution.text) || '';
  const href = (attribution && attribution.href) || OSM_COPYRIGHT_URL;
  const word = 'OpenStreetMap';
  const i = text.indexOf(word);
  const link = (label) => {
    const a = doc.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = label;
    return a;
  };
  if (i >= 0) {
    target.append(text.slice(0, i), link(word), text.slice(i + word.length));
  } else {
    target.append(text || '地圖資料 © ');
    if (!text) target.append(link('OpenStreetMap contributors'), '（ODbL）');
  }
}
