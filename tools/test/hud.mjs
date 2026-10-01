#!/usr/bin/env node
// HUD API 無頭驗證（假 DOM）：契約方法齊全且可呼叫、金錢 +/− 跳動、血條、時速錶 / 路牌 / 車名、FPS、介面縮放 CSS 變數、
// 新手提示卡（同 id 只出一次、localStorage 'tcgta.hints.seen' 跨實例、關閉鈕、停用 / 重設、觸控駕駛中延後）、
// setControlsHint 由 KEYMAP_HELP / TOUCH_HELP 產生且 hud.js / index.html 不含寫死鍵位；另驗老虎城深色玻璃覆寫（landmarks/index.js）
// 色碼同源：小地圖 MARKER_COLORS 來自 src/map/marker-colors.js（與大地圖同值，含垃圾車 event-truck 貼邊）；觸控駕駛中有互動提示也顯示 tb-interact；
// setPrompts（車輛 + 互動提示並列、互不覆蓋）
// I4b 增補：小地圖 state.route 路線繪製（亮青 3 px、只畫範圍內的段）、markers kind 著色與貼邊方向標記、setInteractPrompt / tb-interact、
//   每幀路徑不配置新物件（同內容重複呼叫不重算）
// 用法：node tools/test/hud.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
import { register } from 'node:module';

const JSON_HOOK = `
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function load(url, context, next) {
  if (url.endsWith('.json')) {
    return { format: 'module', shortCircuit: true, source: 'export default ' + readFileSync(fileURLToPath(url), 'utf8') + ';' };
  }
  return next(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(JSON_HOOK)}`, import.meta.url);

// ---------- document 最小替身 ----------
// rec.on 時記錄每個呼叫（[名稱, 參數, 當下 fillStyle / strokeStyle / lineWidth]），供小地圖繪製斷言
const rec = { on: false, log: [], st: {} };
const ctx2d = new Proxy({}, {
  get: (_, k) => {
    if (k === 'measureText') return () => ({ width: 100 });
    if (k in rec.st) return rec.st[k];
    return (...a) => {
      if (rec.on) rec.log.push([k, a, rec.st.fillStyle, rec.st.strokeStyle, rec.st.lineWidth]);
    };
  },
  set: (_, k, v) => {
    rec.st[k] = v;
    return true;
  },
});

class ClassList {
  constructor() {
    this.set = new Set();
  }
  add(...c) {
    for (const x of c) this.set.add(x);
  }
  remove(...c) {
    for (const x of c) this.set.delete(x);
  }
  contains(c) {
    return this.set.has(c);
  }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : !!force;
    if (on) this.set.add(c);
    else this.set.delete(c);
    return on;
  }
}

class El {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.id = '';
    this.classList = new ClassList();
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this._text = '';
    this.width = 0;
    this.height = 0;
    this.offsetWidth = 100;
    this.scrollWidth = 50;
    this.clientWidth = 100;
    const props = {};
    this.style = {
      props,
      setProperty: (k, v) => {
        props[k] = v;
      },
      getPropertyValue: (k) => props[k] || '',
    };
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }
  appendChild(c) {
    this.children.push(c);
    return c;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return k in this.attrs ? this.attrs[k] : null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  dispatch(type) {
    for (const fn of this.listeners[type] || []) fn({ type, preventDefault() {}, stopPropagation() {} });
  }
  getContext() {
    return ctx2d;
  }
  getClientRects() {
    return [1];
  }
}

const byId = new Map();
const docEl = new El('html');
globalThis.document = {
  documentElement: docEl,
  body: new El('body'),
  createElement: (tag) => new El(tag),
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
  getElementById: (id) => {
    if (!byId.has(id)) {
      const e = new El();
      e.id = id;
      byId.set(id, e);
    }
    return byId.get(id);
  },
};
const winListeners = {};
globalThis.window = {
  innerWidth: 1280,
  innerHeight: 800,
  location: { search: '?touch=0' },
  navigator: {},
  matchMedia: () => ({ matches: false }),
  addEventListener: (t, fn) => {
    (winListeners[t] = winListeners[t] || []).push(fn);
  },
};
globalThis.getComputedStyle = () => ({ visibility: 'visible' });

const fs = await import('node:fs');
const { fileURLToPath } = await import('node:url');
const THREE = await import('three');
const hudMod = await import('../../src/hud.js');
const { HUD, HINTS_KEY, formatMoney, touchPromptText, MARKER_COLORS, ROUTE_COLOR, ROUTE_WIDTH } = hudMod;
const touchMod = await import('../../src/touch.js');
const { KEYMAP_HELP, TOUCH_HELP } = await import('../../src/core/actions.js');
const { fixDarkGlass, isDarkGlass, glassEnvMap } = await import('../../src/landmarks/index.js');
const { nightMaterials } = await import('../../src/daynight.js');

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const hudSrc = fs.readFileSync(`${ROOT}src/hud.js`, 'utf8');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function safe(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

function memStorage() {
  const m = new Map();
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

const $ = (id) => document.getElementById(id);
const hidden = (id) => $(id).classList.contains('hidden');
const walkState = (extra = {}) => ({ x: 0, z: 0, yaw: 0, driving: false, speedKmh: 0, location: '七期', time: '16:30', fast: false, markers: [], ...extra });

// ---------- API 契約 ----------
const storage = memStorage();
const hud = new HUD({ storage });
const METHODS = ['update', 'setMoney', 'setHealth', 'setPrompt', 'setInteractPrompt', 'showHint', 'setHintsEnabled', 'resetHints', 'setControlsHint', 'setFps', 'setUiScale', 'toast', 'setVisible'];
const missing = METHODS.filter((m) => typeof hud[m] !== 'function');
check(`契約方法齊全（${METHODS.length} 個）`, !missing.length, missing.join(', '));
check('toggleHelp 已移除', typeof hud.toggleHelp !== 'function');
check('不再訂閱 onSensitivityChange（O 靈敏度 toast 已移除）', !/onSensitivityChange|SENS_TOAST_SEC/.test(hudSrc));

const calls = [
  () => hud.update(1 / 60, walkState()),
  () => hud.update(1 / 60, walkState({ driving: true, speedKmh: 42, money: 500, hp: 80, hpMax: 100, vehicleLabel: '計程車', roadName: '市政北七路' })),
  () => hud.update(1 / 60, { x: 1, z: 2, yaw: 0.3, driving: false, speedKmh: 0, location: '河南路', time: '17:00', fast: true, markers: [{ x: 3, z: 4 }] }),
  () => hud.setMoney(1000, 0),
  () => hud.setHealth(100, 100),
  () => hud.setPrompt('按 F 上車（計程車）'),
  () => hud.setPrompt(null),
  () => hud.showHint('api-test', '測試提示'),
  () => hud.setHintsEnabled(true),
  () => hud.resetHints(),
  () => hud.setControlsHint([{ keys: 'X', desc: '測試' }]),
  () => hud.setFps(60),
  () => hud.setFps(null),
  () => hud.setUiScale(1),
  () => hud.toast('測試訊息', 1),
  () => hud.setVisible(true),
];
const errs = calls.map(safe).filter(Boolean);
check(`每個方法都可呼叫不丟例外（${calls.length} 次）`, !errs.length, errs.map((e) => e.message).join('；'));
check('舊版 state（無新欄位）也能 update', !safe(() => hud.update(0.016, walkState())));

// ---------- 時間 / 金錢 ----------
hud.update(0.016, walkState({ time: '08:05', fast: true }));
check('時間：快轉時加 ⏩', $('clock').textContent === '08:05 ⏩', $('clock').textContent);
check('formatMoney 千分位', formatMoney(1234567) === 'NT$ 1,234,567' && formatMoney(0) === 'NT$ 0', formatMoney(1234567));
hud.setMoney(2500, 300);
check('setMoney：金額顯示', $('money').textContent === 'NT$ 2,500', $('money').textContent);
check('setMoney：+ 跳動（gain、pop）', !hidden('money-delta') && $('money-delta').textContent === '+NT$ 300' && $('money-delta').classList.contains('gain') && $('money-delta').classList.contains('pop'), $('money-delta').textContent);
hud.setMoney(2300, -200);
check('setMoney：− 跳動（loss）', $('money-delta').textContent === '−NT$ 200' && $('money-delta').classList.contains('loss') && !$('money-delta').classList.contains('gain'), $('money-delta').textContent);
for (let i = 0; i < 120; i++) hud.update(1 / 60, walkState());
check('+/− 約 1.8 s 後收起', hidden('money-delta'));
hud.update(0.016, walkState({ money: 2400 }));
check('update(state.money) 自動推算 +100', $('money').textContent === 'NT$ 2,400' && $('money-delta').textContent === '+NT$ 100' && !hidden('money-delta'), $('money-delta').textContent);
hud.setMoney(2700, 300, 'event');
check('setMoney reason event（外送入帳）：跳字前綴「外送」', $('money-delta').textContent === '外送 +NT$ 300', $('money-delta').textContent);
hud.setMoney(3000, 300, 'garbage');
check('setMoney reason garbage（垃圾車入帳）：跳字前綴「清運」、不顯示「外送」', $('money-delta').textContent === '清運 +NT$ 300', $('money-delta').textContent);

// ---------- 血條 ----------
hud.setHealth(50, 100);
check('setHealth：寬度 50%', $('health-fill').style.width === '50.0%', $('health-fill').style.width);
hud.setHealth(20, 100);
check('setHealth：低血量加 .low', $('health').classList.contains('low'));
hud.update(0.016, walkState({ hp: 90, hpMax: 100 }));
check('update(state.hp) 同步血條、解除 .low', $('health-fill').style.width === '90.0%' && !$('health').classList.contains('low'), $('health-fill').style.width);
hud.setHealth(-5, 100);
check('血量 clamp 到 0', $('health-fill').style.width === '0.0%');

// ---------- 駕駛：時速錶 / 路牌 / 車名 ----------
hud.update(0.016, walkState({ driving: true, speedKmh: 80, vehicleLabel: '計程車', roadName: '臺灣大道三段' }));
check('駕駛：顯示時速錶群組', !hidden('drive-panel'));
check('時速數字', $('speed-num').textContent === '80', $('speed-num').textContent);
check('時速弧形 stroke-dasharray = 80 / 160', $('speedo-arc').getAttribute('stroke-dasharray') === '50.0 100', $('speedo-arc').getAttribute('stroke-dasharray'));
check('路牌路名', $('road-name').textContent === '臺灣大道三段' && !hidden('road-sign'));
check('車名', $('vehicle-label').textContent === '計程車');
hud.update(0.016, walkState({ driving: true, speedKmh: -300, vehicleLabel: '機車', roadName: '' }));
check('倒車取絕對值、超過滿格 clamp、警示色', $('speed-num').textContent === '300' && $('speedo-arc').getAttribute('stroke-dasharray') === '100.0 100' && $('drive-panel').classList.contains('hot'));
check('無路名時隱藏路牌', hidden('road-sign'));
hud.update(0.016, walkState());
check('步行：隱藏時速錶群組', hidden('drive-panel'));

// ---------- 互動提示 ----------
hud.setPrompt('按 F 搶車');
check('setPrompt 顯示膠囊', !hidden('prompt') && $('prompt-text').textContent === '按 F 搶車');
hud.setPrompt(null);
check('setPrompt(null) 隱藏', hidden('prompt'));
check('觸控文字：步行指向「上車」鈕', touchPromptText('按 F 上車（計程車）', false) === '點「上車」鈕 上車（計程車）', touchPromptText('按 F 上車（計程車）', false));
check('觸控文字：駕駛指向「下車」鈕', touchPromptText('車子熄火了，按 F 下車', true) === '車子熄火了，點「下車」鈕 下車', touchPromptText('車子熄火了，按 F 下車', true));

// ---------- FPS / 介面縮放 ----------
hud.setFps(58.6);
check('setFps：顯示取整', !hidden('fps') && $('fps').textContent === '59 FPS', $('fps').textContent);
hud.setFps(null);
check('setFps(null) 隱藏', hidden('fps'));
hud.setUiScale(1.2);
const sp = docEl.style.props;
check('setUiScale：--ui-scale / --tg-ui-scale / --hud-scale（桌機 1280×800）', sp['--ui-scale'] === '1.2' && sp['--tg-ui-scale'] === '1.2' && sp['--hud-scale'] === '1.2', JSON.stringify(sp));
window.innerWidth = 640;
window.innerHeight = 360;
for (const fn of winListeners.resize || []) fn();
check('小視窗（640×360）resize 後 --hud-scale 限制 ≤ 1，--ui-scale 保留原值', sp['--hud-scale'] === '1' && sp['--ui-scale'] === '1.2', JSON.stringify(sp));
window.innerWidth = 1280;
window.innerHeight = 800;
hud.setUiScale('abc');
hud.setUiScale(0);
check('非法縮放值忽略', sp['--ui-scale'] === '1.2');

// ---------- 新手提示卡 ----------
hud.resetHints();
for (let i = 0; i < 60; i++) hud.update(1 / 60, walkState());
check('showHint：第一次排入並顯示', hud.showHint('move', '左半邊拖曳移動') === true && !hidden('hint-card') && $('hint-text').textContent === '左半邊拖曳移動');
check('showHint：同 id 再呼叫不重複', hud.showHint('move', '左半邊拖曳移動') === false);
check('已看過記入 localStorage', JSON.parse(storage.getItem(HINTS_KEY)).includes('move'), storage.getItem(HINTS_KEY));
check('第二張排隊（目前仍顯示第一張）', hud.showHint('attack', '點紅色鈕攻擊') === true && $('hint-text').textContent === '左半邊拖曳移動');
check('排隊中的同 id 不重複', hud.showHint('attack', '點紅色鈕攻擊') === false);
$('hint-close').dispatch('click');
check('× 關閉提示卡', hidden('hint-card'));
for (let i = 0; i < 60; i++) hud.update(1 / 60, walkState());
check('間隔後顯示下一張', !hidden('hint-card') && $('hint-text').textContent === '點紅色鈕攻擊');
for (let i = 0; i < 13 * 60; i++) hud.update(1 / 60, walkState());
check('約 12 s 自動收起', hidden('hint-card'));
const hud2 = new HUD({ storage });
check('新實例讀同一 localStorage：已看過的不再出現', hud2.showHint('move', 'x') === false && hud2.showHint('attack', 'x') === false);
hud2.setHintsEnabled(false);
check('setHintsEnabled(false)：不再顯示', hud2.showHint('pause', '按 Esc 暫停') === false);
hud2.setHintsEnabled(true);
check('重新開啟後可顯示新提示', hud2.showHint('pause', '暫停選單') === true);
hud2.setHintsEnabled(false);
check('停用時收起目前提示卡', hidden('hint-card'));
hud2.setHintsEnabled(true);
hud2.resetHints();
check('resetHints：清掉 localStorage 並可重新出現', storage.getItem(HINTS_KEY) === null && hud2.showHint('move', 'x') === true);
const throwing = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); }, removeItem() { throw new Error('SecurityError'); } };
const e3 = safe(() => {
  const h3 = new HUD({ storage: throwing });
  h3.showHint('a', 'x');
  h3.resetHints();
});
check('storage 丟例外（無痕）時不中斷', !e3, e3 && e3.message);
check('storage = null（node / 停用）時只存記憶體', !safe(() => new HUD({ storage: null }).showHint('a', 'x')));

// 觸控駕駛中延後（各實例共用同一組假 DOM：上面儲存例外測試的實例留著提示卡，先收起）
$('hint-card').classList.add('hidden');
const hudT = new HUD({ storage: memStorage() });
hudT.touch = true;
for (let i = 0; i < 60; i++) hudT.update(1 / 60, walkState({ driving: true }));
check('觸控駕駛中：提示排入但不顯示', hudT.showHint('enter', '點上車鈕上車') === true && hidden('hint-card'));
for (let i = 0; i < 60; i++) hudT.update(1 / 60, walkState());
check('下車後顯示', !hidden('hint-card') && $('hint-text').textContent === '點上車鈕上車');
hudT.update(1 / 60, walkState({ driving: true }));
check('顯示中上車：收起並放回佇列', hidden('hint-card') && hudT._hintQueue.length === 1);
for (let i = 0; i < 60; i++) hudT.update(1 / 60, walkState());
check('再下車後重新顯示', !hidden('hint-card'));
hudT.setPrompt('按 F 上車（計程車）');
check('觸控：提示膠囊改指向按鈕', $('prompt-text').textContent === '點「上車」鈕 上車（計程車）', $('prompt-text').textContent);

// ---------- setInteractPrompt / tb-interact ----------
{
  const h = new HUD({ storage: memStorage() });
  check('setInteractPrompt 方法存在', typeof h.setInteractPrompt === 'function');
  h.update(1 / 60, walkState());
  h.setInteractPrompt('按 E 接委託：鮮奶茶外送');
  check('桌機：setInteractPrompt 顯示膠囊原文', !hidden('prompt') && $('prompt-text').textContent === '按 E 接委託：鮮奶茶外送' && !touchMod.isTouchButtonVisible('tb-interact'));
  h.setInteractPrompt(null);
  check('setInteractPrompt(null) 隱藏膠囊', hidden('prompt'));
  check('觸控文字：駕駛「按 E」也指向「互動」鈕', touchPromptText('按 E 取餐', true) === '點「互動」鈕 取餐' && touchPromptText('翻車了！按 F 扶起，按 E 取餐', true) === '翻車了！點「下車」鈕 扶起，點「互動」鈕 取餐');
  check('觸控文字：步行「按 E」指向「互動」鈕', touchPromptText('按 E 打卡', false) === '點「互動」鈕 打卡' && touchPromptText('按 F 上車，按 E 打卡', false) === '點「上車」鈕 上車，點「互動」鈕 打卡');

  const t = new HUD({ storage: memStorage() });
  t.touch = true;
  t.update(1 / 60, walkState());
  const enter = $('tb-enter');
  t.setInteractPrompt('按 E 打卡：臺中國家歌劇院');
  check('觸控：互動提示 → 顯示 tb-interact、膠囊指向「互動」鈕', touchMod.isTouchButtonVisible('tb-interact') && $('prompt-text').textContent === '點「互動」鈕 打卡：臺中國家歌劇院', $('prompt-text').textContent);
  check('觸控：互動提示不把「上車」鈕標成 ready', !enter.classList.contains('ready'));
  const before = $('prompt-text').textContent;
  $('prompt-text').textContent = 'SENTINEL';
  for (let i = 0; i < 5; i++) t.setInteractPrompt('按 E 打卡：臺中國家歌劇院');
  check('同內容每幀重複呼叫不重寫 DOM（不重算字串）', $('prompt-text').textContent === 'SENTINEL');
  $('prompt-text').textContent = before;
  t.update(1 / 60, walkState({ driving: true }));
  check('觸控駕駛中有互動提示 → tb-interact 顯示、膠囊指向「互動」鈕', touchMod.isTouchButtonVisible('tb-interact') && $('prompt-text').textContent === '點「互動」鈕 打卡：臺中國家歌劇院', $('prompt-text').textContent);
  t.setInteractPrompt(null);
  check('觸控駕駛中無互動提示 → tb-interact 隱藏', !touchMod.isTouchButtonVisible('tb-interact') && hidden('prompt'));
  t.setInteractPrompt('按 E 取餐：夜市外送');
  check('觸控駕駛中再出現互動提示（取餐）→ 顯示', touchMod.isTouchButtonVisible('tb-interact') && $('prompt-text').textContent === '點「互動」鈕 取餐：夜市外送', $('prompt-text').textContent);
  t.setPrompt('翻車了！按 F 扶起');
  check('觸控駕駛中改為車輛提示 → tb-interact 隱藏、「上車」鈕不 ready', !touchMod.isTouchButtonVisible('tb-interact') && !enter.classList.contains('ready'));
  t.setInteractPrompt('按 E 打卡：臺中國家歌劇院');
  t.update(1 / 60, walkState());
  check('下車且提示仍在 → tb-interact 恢復顯示', touchMod.isTouchButtonVisible('tb-interact'));
  t.setPrompt('按 F 上車（計程車）');
  check('改為上車提示 → tb-interact 隱藏、「上車」鈕 ready', !touchMod.isTouchButtonVisible('tb-interact') && enter.classList.contains('ready'));
  t.setInteractPrompt('按 E 收集：太陽餅');
  t.setInteractPrompt(null);
  check('互動提示清除 → tb-interact 隱藏、膠囊隱藏', !touchMod.isTouchButtonVisible('tb-interact') && hidden('prompt'));

  // setPrompts：車輛提示與互動提示同時存在 → 同一膠囊並列、互不覆蓋（main.js setPrompts 兩者都有時呼叫；修「按 F 上車」被 setInteractPrompt(null) 蓋掉）
  check('setPrompts 方法存在', typeof t.setPrompts === 'function');
  t.update(1 / 60, walkState());
  t.setPrompts('按 F 上車（計程車）', '按 E 倒垃圾');
  check('觸控步行 setPrompts：車輛 + 互動提示並列（各自指向按鈕）、「上車」鈕 ready、tb-interact 顯示',
    $('prompt-text').textContent === '點「上車」鈕 上車（計程車）　點「互動」鈕 倒垃圾' && enter.classList.contains('ready') && touchMod.isTouchButtonVisible('tb-interact'), $('prompt-text').textContent);
  t.setPrompt('按 F 上車（計程車）');
  check('只剩車輛提示 → setPrompt：上車提示仍在、tb-interact 隱藏', $('prompt-text').textContent === '點「上車」鈕 上車（計程車）' && !hidden('prompt') && enter.classList.contains('ready') && !touchMod.isTouchButtonVisible('tb-interact'), $('prompt-text').textContent);
  t.setInteractPrompt('按 E 倒垃圾');
  check('只剩互動提示 → setInteractPrompt：「上車」鈕不 ready、tb-interact 顯示', $('prompt-text').textContent === '點「互動」鈕 倒垃圾' && !enter.classList.contains('ready') && touchMod.isTouchButtonVisible('tb-interact'), $('prompt-text').textContent);
  t.update(1 / 60, walkState({ driving: true }));
  t.setPrompts('翻車了！按 F 扶起', '按 E 倒垃圾');
  check('觸控駕駛 setPrompts：兩則並列、tb-interact 顯示、「上車」鈕不 ready', $('prompt-text').textContent === '翻車了！點「下車」鈕 扶起　點「互動」鈕 倒垃圾' && touchMod.isTouchButtonVisible('tb-interact') && !enter.classList.contains('ready'), $('prompt-text').textContent);
  t.setPrompt(null);
  check('setPrompt(null) 同時清掉兩則 → 膠囊隱藏、tb-interact 隱藏', hidden('prompt') && !touchMod.isTouchButtonVisible('tb-interact'));
  const d = new HUD({ storage: memStorage() });
  d.update(1 / 60, walkState());
  d.setPrompts('按 F 上車（機車）', '按 E 打卡：臺中國家歌劇院');
  check('桌機 setPrompts：膠囊原文並列（車輛在前）', !hidden('prompt') && $('prompt-text').textContent === '按 F 上車（機車）　按 E 打卡：臺中國家歌劇院', $('prompt-text').textContent);
  d.setPrompts('按 F 上車（機車）', null);
  check('桌機 setPrompts(車輛, null) = 只顯示車輛提示', $('prompt-text').textContent === '按 F 上車（機車）');
  d.setPrompts(null, null);
  check('桌機 setPrompts(null, null) 隱藏膠囊', hidden('prompt'));
}

// ---------- 小地圖：route 與 markers kind ----------
{
  const h = new HUD({ storage: memStorage() });
  const S = 200;
  $('minimap').width = S;
  const R = S / 2;
  const k = 0.7; // 步行每公尺像素
  const draw = (state) => {
    rec.log = [];
    rec.on = true;
    h.update(1 / 60, walkState(state));
    rec.on = false;
    return rec.log;
  };
  // 路線：往東出圈 → 2 km 外繞一段（不畫）→ 回到圈內（重新 moveTo）
  const P = { x: 100, z: 200 };
  const route = [
    { x: 100, z: 200 },
    { x: 150, z: 200 },
    { x: 2150, z: 200 },
    { x: 2150, z: 2200 },
    { x: 110, z: 230 },
    { x: 100, z: 260 },
  ];
  let log = draw({ ...P, route });
  const strokes = log.filter((c) => c[0] === 'stroke' && c[3] === ROUTE_COLOR);
  check('route：以亮青色描一次', strokes.length === 1 && /^#3ff6ff$/i.test(ROUTE_COLOR), `${strokes.length} 次`);
  const lw = strokes[0] && strokes[0][4];
  check('route：線寬換算為螢幕 3 px（世界座標系 lineWidth × k）', ROUTE_WIDTH === 3 && Math.abs(lw * k - 3) < 1e-9, String(lw));
  // 找路線 path 的 moveTo / lineTo（stroke 前、最近一次 beginPath 之後）
  const si = log.indexOf(strokes[0]);
  let bi = si;
  while (bi > 0 && log[bi][0] !== 'beginPath') bi--;
  const seg = log.slice(bi, si).filter((c) => c[0] === 'moveTo' || c[0] === 'lineTo');
  const moves = seg.filter((c) => c[0] === 'moveTo').length;
  const lines = seg.filter((c) => c[0] === 'lineTo').length;
  // 段 1（圈內）、段 2（由圈內出發）、段 4（終點回到圈內）、段 5（圈內）與小地圖圓相交；段 3 在 2 km 外 → 跳過並斷開
  check('route：只畫與小地圖範圍相交的段（5 段畫 4 段、跳過遠段、斷開處重新 moveTo）', lines === 4 && moves === 2, `moveTo ${moves} / lineTo ${lines}`);
  check('route：座標沒有非有限數', seg.every((c) => c[1].every(Number.isFinite)));
  log = draw({ ...P, route: null });
  check('route = null 不畫路線', !log.some((c) => c[0] === 'stroke' && c[3] === ROUTE_COLOR));
  log = draw({ ...P, route: [{ x: 5000, z: 5000 }, { x: 5100, z: 5000 }] });
  check('route 全在範圍外 → 不描線', !log.some((c) => c[0] === 'stroke' && c[3] === ROUTE_COLOR));
  log = draw({ ...P, route: [{ x: 100, z: 200 }, { x: NaN, z: 1 }, { x: 120, z: 200 }] });
  check('route 含非法點不丟例外、不畫非有限座標', log.filter((c) => c[0] === 'moveTo' || c[0] === 'lineTo').every((c) => c[1].every(Number.isFinite)));

  // markers：各 kind 顏色（範圍內，螢幕座標 = R + d × k）
  const kinds = ['mission-start', 'mission-dest', 'dest', 'checkin', 'food', 'ammo'];
  const markers = kinds.map((kind, i) => ({ x: P.x + 10 + i * 5, z: P.z - 20, kind, label: kind }));
  markers.push({ x: P.x - 30, z: P.z + 10 }); // 無 kind = 車
  log = draw({ ...P, markers });
  const arcs = log.filter((c) => c[0] === 'arc' && Math.abs(c[1][1] - (R + (P.z - 20 - P.z) * k)) < 1e-6 || (c[0] === 'arc' && Math.abs(c[1][0] - (R - 30 * k)) < 1e-6));
  const fills = log.filter((c) => c[0] === 'fill');
  const colorAt = (x, y) => {
    const i = log.findIndex((c) => c[0] === 'arc' && Math.abs(c[1][0] - x) < 1e-6 && Math.abs(c[1][1] - y) < 1e-6);
    if (i < 0) return null;
    const f = log.slice(i).find((c) => c[0] === 'fill');
    return f ? f[2] : null;
  };
  const got = kinds.map((kind, i) => colorAt(R + (10 + i * 5) * k, R - 20 * k));
  const want = kinds.map((kind) => MARKER_COLORS[kind]);
  check('markers：kind 依契約著色（任務起點黃 / 終點橘 / 目的地青 / 打卡紫 / 小吃粉 / 彈藥灰）', JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
  check('MARKER_COLORS 色系正確（與大地圖同值）', MARKER_COLORS['mission-start'] === '#ffd23f' && MARKER_COLORS['mission-dest'] === '#ff8c1a' && MARKER_COLORS.dest === '#2fe0e0' && MARKER_COLORS.checkin === '#b36bff' && MARKER_COLORS.food === '#ff7ab8' && MARKER_COLORS.ammo === '#9aa0a6' && MARKER_COLORS.car === '#4fc3ff');
  {
    const shared = await import('../../src/map/marker-colors.js');
    const kinds2 = Object.keys(shared.MARKER_COLORS);
    check('小地圖色碼與 map/marker-colors.js 同源（每個 kind 同值、另加車色 car）', kinds2.length >= 8 && kinds2.every((k) => MARKER_COLORS[k] === shared.MARKER_COLORS[k]) && MARKER_COLORS.car === shared.CAR_MARKER_COLOR && Object.keys(MARKER_COLORS).length === kinds2.length + 1);
    check('靜態：hud.js 不再寫死事件 / 任務標記色碼', /from '\.\/map\/marker-colors\.js'/.test(hudSrc) && !/'mission-start':\s*'#/.test(hudSrc));
  }
  check('markers：無 kind（可駕駛車輛）維持藍色', colorAt(R - 30 * k, R + 10 * k) === '#4fc3ff');
  check('markers：畫了 7 個圓點', arcs.length >= 1 && log.filter((c) => c[0] === 'arc').length >= 7 && fills.length >= 7);

  // 超出半徑：任務 / 目的地貼邊畫朝外三角形；打卡 / 小吃 / 彈藥 / 車不畫
  const far = [
    { x: P.x + 1000, z: P.z, kind: 'mission-start' }, // 正東
    { x: P.x, z: P.z - 1000, kind: 'dest' }, // 正北
    { x: P.x - 1000, z: P.z, kind: 'checkin' },
    { x: P.x, z: P.z + 1000, kind: 'food' },
    { x: P.x + 700, z: P.z + 700, kind: 'ammo' },
    { x: P.x + 700, z: P.z - 700 },
  ];
  log = draw({ ...P, markers: far });
  const tri = (color) => {
    const i = log.findIndex((c, j) => c[0] === 'fill' && c[2] === color && log[j - 1] && log[j - 1][0] === 'closePath');
    if (i < 0) return null;
    let b = i;
    while (b > 0 && log[b][0] !== 'beginPath') b--;
    return log.slice(b, i).filter((c) => c[0] === 'moveTo' || c[0] === 'lineTo').map((c) => c[1]);
  };
  const east = tri(MARKER_COLORS['mission-start']);
  const north = tri(MARKER_COLORS.dest);
  const inside = (pts) => pts.every(([x, y]) => Math.hypot(x - R, y - R) <= R);
  check('超出半徑的任務起點：貼右緣畫三角形、尖端朝東', !!east && inside(east) && east[0][0] > R + 80 && Math.abs(east[0][1] - R) < 1e-6 && east[0][0] > east[1][0], JSON.stringify(east));
  check('超出半徑的目的地：貼上緣、尖端朝北', !!north && inside(north) && north[0][1] < R - 80 && Math.abs(north[0][0] - R) < 1e-6 && north[0][1] < north[1][1], JSON.stringify(north));
  const farArcs = log.filter((c) => c[0] === 'arc' && c[1][2] < 10);
  {
    // 垃圾車 event-truck（會移動的事件目標）：超出半徑同樣貼邊畫三角形（正西）
    log = draw({ ...P, markers: [{ x: P.x - 1000, z: P.z, kind: 'event-truck' }] });
    const west = tri(MARKER_COLORS['event-truck']);
    check('超出半徑的垃圾車（event-truck）：有專屬色、貼左緣、尖端朝西', /^#[0-9a-f]{6}$/i.test(MARKER_COLORS['event-truck'] || '') && !!west && inside(west) && west[0][0] < R - 80 && west[0][0] < west[1][0], JSON.stringify(west));
    log = draw({ ...P, markers: far });
  }
  check('超出半徑的打卡 / 小吃 / 彈藥 / 車不畫', farArcs.length === 0 && ![MARKER_COLORS.checkin, MARKER_COLORS.food, MARKER_COLORS.ammo, MARKER_COLORS.car].some((c) => log.some((x) => x[0] === 'fill' && x[2] === c)));
  log = draw({ ...P, markers: [{ x: NaN, z: 0, kind: 'dest' }, null, { x: P.x, z: P.z, kind: 'nope' }] });
  check('非法 marker 略過、未知 kind 以車色畫', log.filter((c) => c[0] === 'arc' && c[1][2] < 10).length === 1);
  // 每幀路徑不配置新物件：原始碼檢查 _drawRoute / _drawMarkers 內沒有物件 / 陣列常值與 new
  const body = (name) => {
    const i = hudSrc.indexOf(`  ${name}(`);
    const j = hudSrc.indexOf('\n  }\n', i);
    return hudSrc.slice(i, j);
  };
  const hot = [body('_drawRoute'), body('_drawMarkers'), body('_setPrompt'), body('_syncInteractBtn')].join('\n');
  check('每幀路徑（路線 / 標記 / 提示）不配置新物件（無 new、{…}、[…] 常值、閉包）', !/\bnew\b|=\s*\{|=\s*\[|=>|\.map\(|\.filter\(|\.slice\(/.test(hot));
}

// ---------- setControlsHint ----------
const fromHelp = (help, group) => help.find((g) => g.group === group).items.map((it) => ({ keys: it.keys, desc: it.desc }));
const walkItems = fromHelp(KEYMAP_HELP, '步行');
hud.setControlsHint(walkItems);
const expected = walkItems.map((it) => `${it.keys} ${it.desc}`).join(' · ');
check('setControlsHint：桌機提示依傳入內容產生', $('ctrl-hint').textContent === expected && !hidden('ctrl-hint'), $('ctrl-hint').textContent);
check('setControlsHint：按鍵包在 <b>', $('ctrl-hint').children.filter((c) => c.tagName === 'B').length === walkItems.length);
check('觸控容器同步寫入', $('touch-hint').textContent === expected);
const touchItems = fromHelp(TOUCH_HELP, '步行');
hud.setControlsHint(touchItems);
check('改傳 TOUCH_HELP 即換成觸控文字', $('touch-hint').textContent.includes(touchItems[0].keys) && !$('touch-hint').textContent.includes(walkItems[0].keys));
check('KEYMAP_HELP 產生的提示不含已移除的鍵（O 靈敏度、R 翻車、E 揮拳、H 說明）', !/O 靈敏度|R 翻車|E 揮拳|H 說明|\bE\b.*揮拳/.test(expected), expected);
hud.setControlsHint([]);
check('setControlsHint([]) 清空並隱藏', $('ctrl-hint').textContent === '' && hidden('ctrl-hint'));
hud.setControlsHint(null);
check('setControlsHint(非陣列) 不丟例外、清空', $('ctrl-hint').textContent === '');
// hud.js 原始碼不得寫死鍵位 / 說明文字（字串常值中）
const literals = [...hudSrc.matchAll(/'([^'\\\n]*)'|`([^`]*)`/g)].map((m) => m[1] ?? m[2]).join('\n');
const HARD = ['W A S D', 'WASD', '滑鼠左鍵', 'Shift', '空白鍵', '靈敏度', '揮拳', '翻車', '按 E', '按 H', '按 R', '按 O', '收合此說明'];
const hits = HARD.filter((s) => literals.includes(s));
check('hud.js 字串常值不含寫死的鍵位 / 說明文字', !hits.length, hits.join(', '));

// ---------- 老虎城深色玻璃 ----------
// 實測：tiger_shopfront_glass 帶 glb 自發光 0x594a35，舊版只補「偏暗的自發光」→ 整面平塗棕色；現行改成冷藍灰反射玻璃 + 夜間暖光
const std = (o) => new THREE.MeshStandardMaterial(o);
const mats = {
  named: std({ name: 'Glass_Shopfront', color: 0x050608, metalness: 0.9, roughness: 0.05, transparent: true, opacity: 0.6 }),
  unnamed: std({ name: 'Material.012', color: 0x040405, metalness: 0.95, roughness: 0.1, transparent: true, opacity: 0.7 }),
  tiger: std({ name: 'tiger_shopfront_glass', color: 0x2a2620, emissive: 0x594a35, emissiveIntensity: 1, metalness: 0.9, roughness: 0.05, transparent: true, opacity: 0.6 }),
  wall: std({ name: 'Wall_Dark', color: 0x050505, metalness: 0.1, roughness: 0.8 }),
  metal: std({ name: 'Frame', color: 0x0a0a0a, metalness: 0.9, roughness: 0.3 }),
  bright: std({ name: 'glass_bright', color: 0x8aa8c0, metalness: 0.6, transparent: true, opacity: 0.5 }),
};
mats.tiger.emissiveMap = new THREE.Texture();
const root = new THREE.Group();
for (const m of Object.values(mats)) root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), m));
root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mats.named)); // 共用材質只算一次
check('判定：名稱含 glass 且暗 → 玻璃', isDarkGlass(mats.named));
check('判定：無名稱但透明 + 很暗 + 高 metalness → 玻璃', isDarkGlass(mats.unnamed));
check('判定：tiger_shopfront_glass 一律視為玻璃（glb 自發光主導、底色不必暗）', isDarkGlass(mats.tiger) && isDarkGlass(std({ name: 'tiger_shopfront_glass', color: 0xc0c0c0 })));
check('判定：暗色不透明牆 / 不透明金屬框 / 亮玻璃 不動', !isDarkGlass(mats.wall) && !isDarkGlass(mats.metal) && !isDarkGlass(mats.bright));
const nightBefore = nightMaterials.length;
const n = fixDarkGlass(root);
check('fixDarkGlass 修正 3 個材質（共用材質只算一次）', n === 3, `n = ${n}`);
// 冷色：藍 > 綠 > 紅（sRGB）；白天自發光 0（不讓暖色主導）；夜間以暖色登記 registerNight（上限 ≤ 0.5，只是少量店內光）
const hsl = {};
const glassOk = (m) => {
  m.color.getHSL(hsl);
  const c = m.color.clone().convertLinearToSRGB();
  return c.b > c.g && c.g > c.r && hsl.l > 0.15 && hsl.l < 0.45 &&
    m.metalness >= 0.6 && m.metalness <= 0.9 && m.roughness >= 0.05 && m.roughness <= 0.2 &&
    m.envMap && m.envMap.mapping === THREE.EquirectangularReflectionMapping && m.envMapIntensity > 0 &&
    m.emissiveIntensity === 0 && m.emissiveMap === null && m.emissive.r > m.emissive.b &&
    m.opacity >= 0.88 && m.userData.darkGlassFixed;
};
const t = mats.tiger;
const tc = t.color.clone().convertLinearToSRGB();
check('覆寫後：冷深藍灰底色、metalness 0.6–0.9、roughness 0.05–0.2、有 envMap（天空漸層）、白天自發光 0、拿掉 glb emissiveMap、不透明度下限',
  [mats.named, mats.unnamed, mats.tiger].every(glassOk),
  `tiger rgb ${[tc.r, tc.g, tc.b].map((v) => Math.round(v * 255)).join(',')} metal ${t.metalness} rough ${t.roughness} emi ${t.emissiveIntensity} env ${!!t.envMap}`);
const reg = nightMaterials.slice(nightBefore);
const tigerNight = reg.find((r) => r.material === mats.tiger);
check('夜間保留少量暖色自發光：每個玻璃材質登記 registerNight 一次、上限 0 < max ≤ 0.5、emissive 偏暖（R > B）',
  reg.length === 3 && tigerNight && tigerNight.max > 0 && tigerNight.max <= 0.5 && mats.tiger.emissive.r > mats.tiger.emissive.b, `登記 ${reg.length}、max ${tigerNight && tigerNight.max}`);
const env = glassEnvMap();
const px = (v) => { const j = Math.floor(v * env.image.height); const k = (j * env.image.width) * 4; return env.image.data.slice(k, k + 3); };
const top = px(0.99);
const hor = px(0.5);
const bot = px(0.02);
check('glassEnvMap：共用一張、equirect；上方天藍（B 最大）、地平線最亮、下方地面偏暗', glassEnvMap() === env && top[2] > top[0] && hor[1] > top[1] && bot[1] < hor[1] / 2,
  `top ${[...top]} hor ${[...hor]} bot ${[...bot]}`);
check('非玻璃材質維持原值', mats.wall.metalness === 0.1 && mats.metal.metalness === 0.9 && mats.bright.metalness === 0.6 && !mats.bright.userData.darkGlassFixed && !mats.bright.envMap);
const snap = (m) => JSON.stringify([m.metalness, m.roughness, m.color.getHex(), m.emissive.getHex(), m.emissiveIntensity, m.opacity]);
const before = [mats.named, mats.tiger].map(snap).join();
const custom = new THREE.Texture();
fixDarkGlass(root, { envMap: custom });
check('重複套用結果不變（冪等、不重複登記夜間）；可傳入場景現有環境 envMap', [mats.named, mats.tiger].map(snap).join() === before && nightMaterials.length - nightBefore === 3 && mats.tiger.envMap === custom);
const lmSrc = fs.readFileSync(`${ROOT}src/landmarks/index.js`, 'utf8');
check('只套用在老虎城 glb、且已修正材質不在 prepareModel 重複登記 registerNight', /DARK_GLASS_FILES = new Set\(\['tiger_city\.glb'\]\)/.test(lmSrc) && /darkGlassFixed\) continue/.test(lmSrc));

console.log(`\n${failed ? 'FAIL' : 'PASS'} ${failed ? failed : passed}/${passed + failed}`);
if (failed) process.exit(1);
