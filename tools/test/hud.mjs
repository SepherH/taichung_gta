#!/usr/bin/env node
// HUD API 無頭驗證（假 DOM）：契約方法齊全且可呼叫、金錢 +/− 跳動、血條、時速錶 / 路牌 / 車名、FPS、介面縮放 CSS 變數、
// 新手提示卡（同 id 只出一次、localStorage 'tcgta.hints.seen' 跨實例、關閉鈕、停用 / 重設、觸控駕駛中延後）、
// setControlsHint 由 KEYMAP_HELP / TOUCH_HELP 產生且 hud.js / index.html 不含寫死鍵位；另驗老虎城深色玻璃覆寫（landmarks/index.js）
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
const ctx2d = new Proxy({}, {
  get: (_, k) => (k === 'measureText' ? () => ({ width: 100 }) : () => {}),
  set: () => true,
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
const { HUD, HINTS_KEY, formatMoney, touchPromptText } = hudMod;
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
const METHODS = ['update', 'setMoney', 'setHealth', 'setPrompt', 'showHint', 'setHintsEnabled', 'resetHints', 'setControlsHint', 'setFps', 'setUiScale', 'toast', 'setVisible'];
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
