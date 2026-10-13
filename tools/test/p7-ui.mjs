#!/usr/bin/env node
// 通緝 UI 無頭驗證（假 DOM + 假計時器）：setStars 0–5 與 flashing class、BUSTED / WASTED 文案含金額且 resolve 後還原畫布 filter、
// 點擊跳過（SKIP_DELAY 前無效）、showHint 同 key 只一次（含 localStorage 丟例外）、drawSearchCircle 對假 ctx 畫 arc 且顏色隨 t 交替、
// dispose 移除節點與監聽；另驗 wanted.css 前綴、行動版規則限定 body.touch、pointer-events
// 用法：node tools/test/p7-ui.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
import fs from 'node:fs';

const ROOT = new URL('../../', import.meta.url).pathname;
let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  — ${detail}` : ''}`);
}

// ---------- document 最小替身 ----------
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
    this.classList = new ClassList();
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.listeners = {};
    this.hidden = false;
    this._text = '';
    this.style = { filter: '' };
  }
  set className(v) {
    this.classList = new ClassList();
    for (const c of String(v).split(/\s+/)) if (c) this.classList.add(c);
  }
  get className() {
    return [...this.classList.set].join(' ');
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }
  appendChild(c) {
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  removeChild(c) {
    this.children = this.children.filter((x) => x !== c);
    c.parentNode = null;
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
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }
  dispatch(type) {
    for (const fn of [...(this.listeners[type] || [])]) fn({ type, preventDefault() {}, stopPropagation() {} });
  }
}

function makeDoc() {
  const doc = new El('#document');
  doc.body = new El('body');
  doc.createElement = (tag) => new El(tag);
  return doc;
}
const find = (node, cls) => {
  if (node.classList && node.classList.contains(cls)) return node;
  for (const c of node.children || []) {
    const r = find(c, cls);
    if (r) return r;
  }
  return null;
};

// ---------- 假計時器（ui.js 呼叫當下才取 globalThis.setTimeout） ----------
let now = 0;
let timers = [];
let nextId = 1;
globalThis.setTimeout = (fn, ms) => {
  const id = nextId++;
  timers.push({ id, at: now + ms, fn });
  return id;
};
globalThis.clearTimeout = (id) => {
  timers = timers.filter((t) => t.id !== id);
};
function advance(ms) {
  const end = now + ms;
  for (;;) {
    timers.sort((a, b) => a.at - b.at);
    const t = timers[0];
    if (!t || t.at > end) break;
    timers.shift();
    now = t.at;
    t.fn();
  }
  now = end;
}
const flush = () => new Promise((r) => setImmediate(r));

// ---------- localStorage 替身 ----------
const store = new Map();
let storageThrows = false;
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  get() {
    if (storageThrows === 'access') throw new Error('SecurityError');
    return {
      getItem: (k) => {
        if (storageThrows) throw new Error('blocked');
        return store.has(k) ? store.get(k) : null;
      },
      setItem: (k, v) => {
        if (storageThrows) throw new Error('QuotaExceeded');
        store.set(k, String(v));
      },
    };
  },
});

const mod = await import('../../src/wanted/ui.js');
const {
  createWantedUI, drawSearchCircle, STAR_COUNT, OVERLAY_SEC, SKIP_DELAY_SEC, HINT_SEC, HINTS_STORAGE_KEY,
  GRAYSCALE_FILTER, SEARCH_BLINK_SEC, SEARCH_COLORS, formatFine,
} = mod;

check('export 齊全', typeof createWantedUI === 'function' && typeof drawSearchCircle === 'function' && STAR_COUNT === 5 &&
  OVERLAY_SEC === 3.5 && HINTS_STORAGE_KEY === 'tcgta.hints' && GRAYSCALE_FILTER === 'grayscale(1) contrast(1.1)');

// ---------- setStars ----------
{
  const doc = makeDoc();
  const root = new El('div');
  const ui = createWantedUI({ root, canvas: new El('canvas'), doc });
  const row = find(root, 'wanted-stars');
  check('星星列掛在 root、5 格星', row && row.children.length === STAR_COUNT && row.children.every((s) => s.textContent === '★'));
  check('初始 0 星整列隱藏', row.hidden === true);
  let allOk = true;
  for (let n = 0; n <= 5; n++) {
    ui.setStars(n);
    const lit = row.children.filter((s) => s.classList.contains('wanted-on')).length;
    if (lit !== n || row.hidden !== (n === 0)) allOk = false;
  }
  check('setStars 0–5：亮星數 = n、n=0 隱藏', allOk);
  ui.setStars(3, { flashing: true });
  check('flashing → 列加 wanted-flashing', row.classList.contains('wanted-flashing') && !row.hidden);
  ui.setStars(3, { flashing: false });
  check('flashing 關閉 → 移除 class', !row.classList.contains('wanted-flashing'));
  ui.setStars(0, { flashing: true });
  check('0 星時不閃且隱藏', row.hidden && !row.classList.contains('wanted-flashing'));
  ui.setStars(9);
  check('超出範圍 clamp 到 5', row.children.filter((s) => s.classList.contains('wanted-on')).length === 5);
  ui.setStars(-2);
  check('負數 clamp 到 0', row.hidden && row.children.every((s) => !s.classList.contains('wanted-on')));
  ui.dispose();
}

// ---------- showBusted / showWasted ----------
{
  const doc = makeDoc();
  const root = new El('div');
  const canvas = new El('canvas');
  canvas.style.filter = 'saturate(1.2)';
  const ui = createWantedUI({ root, canvas, doc });
  let done = false;
  const p = ui.showBusted({ fine: 1500 }).then(() => {
    done = true;
  });
  const ov = find(doc.body, 'wanted-overlay');
  check('BUSTED 掛在 body、標題「被捕 BUSTED」、藍色系 class', ov && ov.classList.contains('wanted-busted') && find(ov, 'wanted-overlay-title').textContent === '被捕 BUSTED');
  check('BUSTED 副標含罰鍰金額', find(ov, 'wanted-overlay-sub').textContent === '你被帶回警察局・罰鍰 NT$1,500', find(ov, 'wanted-overlay-sub').textContent);
  check('顯示中畫布灰階', canvas.style.filter === GRAYSCALE_FILTER);
  doc.dispatch('pointerdown');
  await flush();
  check(`${SKIP_DELAY_SEC} 秒前點擊不跳過`, !done && ui.overlayActive);
  advance(OVERLAY_SEC * 1000 - 1);
  await flush();
  check('未滿 3.5 秒仍顯示', !done);
  advance(1);
  await p;
  check('3.5 秒後 resolve、還原原 filter、移除節點', done && canvas.style.filter === 'saturate(1.2)' && !find(doc.body, 'wanted-overlay') && !ui.overlayActive);

  done = false;
  const p2 = ui.showWasted({ fee: 2000 }).then(() => {
    done = true;
  });
  const ov2 = find(doc.body, 'wanted-overlay');
  check('WASTED 標題「送醫 WASTED」、紅色系 class', ov2.classList.contains('wanted-wasted') && find(ov2, 'wanted-overlay-title').textContent === '送醫 WASTED');
  check('WASTED 副標含醫藥費金額', find(ov2, 'wanted-overlay-sub').textContent === '你被送到醫院・醫藥費 NT$2,000');
  advance(SKIP_DELAY_SEC * 1000);
  doc.dispatch('click');
  await p2;
  check('點擊後提前 resolve 並還原 filter', done && canvas.style.filter === 'saturate(1.2)' && now < OVERLAY_SEC * 1000 * 3);
  check('結束後移除 doc 監聽', (doc.listeners.pointerdown || []).length === 0 && (doc.listeners.click || []).length === 0);

  // 連續呼叫：前一個先 resolve，filter 仍還原成最初值（不是灰階）
  let first = false;
  const pa = ui.showBusted({ fine: 10 }).then(() => {
    first = true;
  });
  const pb = ui.showWasted({ fee: 20 });
  await pa;
  check('重疊呼叫：前一個先 resolve、只剩一個畫面', first && doc.body.children.filter((c) => c.classList.contains('wanted-overlay')).length === 1);
  advance(OVERLAY_SEC * 1000);
  await pb;
  check('重疊呼叫結束後 filter 還原原值', canvas.style.filter === 'saturate(1.2)');

  // dispose 中途：resolve 並還原
  let disposedDone = false;
  ui.showBusted({ fine: 0 }).then(() => {
    disposedDone = true;
  });
  ui.dispose();
  await flush();
  check('顯示中 dispose → resolve、還原 filter、移除畫面', disposedDone && canvas.style.filter === 'saturate(1.2)' && !find(doc.body, 'wanted-overlay'));
  check('formatFine 千分位、負數 / 非數字歸 0', formatFine(1234567) === 'NT$1,234,567' && formatFine(-5) === 'NT$0' && formatFine('x') === 'NT$0');
}

// ---------- 無 canvas 也可用 ----------
{
  const doc = makeDoc();
  const ui = createWantedUI({ root: new El('div'), doc });
  const p = ui.showWasted({ fee: 1 });
  advance(OVERLAY_SEC * 1000);
  await p;
  check('canvas 未提供時仍正常 resolve', !ui.overlayActive);
  ui.dispose();
}

// ---------- showHint ----------
{
  store.clear();
  storageThrows = false;
  const doc = makeDoc();
  const root = new El('div');
  const ui = createWantedUI({ root, doc });
  const card = find(root, 'wanted-hint');
  check('提示卡初始隱藏', card && card.hidden);
  check('首次 showHint 顯示文字', ui.showHint('first-star', '警察在找你') === true && !card.hidden && card.textContent.includes('警察在找你'));
  check('寫入 localStorage tcgta.hints', JSON.parse(store.get('tcgta.hints')).includes('first-star'));
  find(card, 'wanted-hint-close').dispatch('click');
  check('關閉鈕收起提示卡', card.hidden);
  check('同 key 第二次不顯示', ui.showHint('first-star', '警察在找你') === false && card.hidden);
  check('不同 key 可顯示', ui.showHint('search', '躲出搜索圈') === true && !card.hidden);
  advance(HINT_SEC * 1000);
  check(`${HINT_SEC} 秒自動收起`, card.hidden);
  ui.dispose();
  const ui2 = createWantedUI({ root: new El('div'), doc: makeDoc() });
  check('跨實例：已看過的 key 從 localStorage 讀回不再顯示', ui2.showHint('first-star', 'x') === false);
  ui2.dispose();

  storageThrows = true;
  let ui3;
  let threw = false;
  try {
    ui3 = createWantedUI({ root: new El('div'), doc: makeDoc() });
    check('localStorage get/set 丟例外：仍顯示且同 key 只一次', ui3.showHint('k', 't') === true && ui3.showHint('k', 't') === false);
  } catch {
    threw = true;
  }
  storageThrows = 'access';
  try {
    const ui4 = createWantedUI({ root: new El('div'), doc: makeDoc() });
    check('存取 localStorage 本身丟例外也不壞', ui4.showHint('k', 't') === true && ui4.showHint('k', 't') === false);
    ui4.dispose();
  } catch {
    threw = true;
  }
  check('storage 例外未拋出', !threw);
  if (ui3) ui3.dispose();
  storageThrows = false;
  check('空 key / 空文字不顯示', createWantedUI({ root: new El('div'), doc: makeDoc() }).showHint('', 'x') === false);
}

// ---------- drawSearchCircle ----------
{
  const log = [];
  const st = {};
  const ctx = new Proxy({}, {
    get: (_, k) => (k in st ? st[k] : (...a) => log.push([k, a, st.fillStyle, st.strokeStyle])),
    set: (_, k, v) => {
      st[k] = v;
      return true;
    },
  });
  drawSearchCircle(ctx, { cx: 50, cy: 60, r: 30, t: 0 });
  const arcs = log.filter((c) => c[0] === 'arc');
  check('arc 呼叫 ≥ 1 次、圓心半徑正確', arcs.length >= 1 && arcs[0][1][0] === 50 && arcs[0][1][1] === 60 && arcs[0][1][2] === 30);
  const fill0 = log.find((c) => c[0] === 'fill')[2];
  check('有 fill 與 stroke、save / restore 成對', log.some((c) => c[0] === 'stroke') && log.filter((c) => c[0] === 'save').length === log.filter((c) => c[0] === 'restore').length);
  log.length = 0;
  drawSearchCircle(ctx, { cx: 50, cy: 60, r: 30, t: SEARCH_BLINK_SEC });
  const fill1 = log.find((c) => c[0] === 'fill')[2];
  log.length = 0;
  drawSearchCircle(ctx, { cx: 50, cy: 60, r: 30, t: SEARCH_BLINK_SEC * 2 });
  const fill2 = log.find((c) => c[0] === 'fill')[2];
  check('顏色隨 t 藍紅交替', fill0 === SEARCH_COLORS.blue.fill && fill1 === SEARCH_COLORS.red.fill && fill2 === fill0, `${fill0} / ${fill1} / ${fill2}`);
  check('半透明', /rgba\(.*0\.\d+\)/.test(fill0) && /rgba\(.*0\.\d+\)/.test(fill1));
  log.length = 0;
  drawSearchCircle(ctx, { cx: 0, cy: 0, r: 0, t: 0 });
  drawSearchCircle(null, { cx: 0, cy: 0, r: 5 });
  check('r ≤ 0 / 無 ctx 不畫也不拋錯', log.length === 0);
}

// ---------- dispose ----------
{
  const doc = makeDoc();
  const root = new El('div');
  const ui = createWantedUI({ root, doc });
  ui.setStars(2);
  ui.showHint('dispose-test', 'x');
  check('dispose 前 root 有星星列與提示卡', root.children.length === 2);
  ui.dispose();
  check('dispose 移除所有節點、提示計時器清除', root.children.length === 0 && doc.body.children.length === 0 && timers.length === 0);
  ui.dispose();
  check('重複 dispose 不拋錯', true);
}

// ---------- 無 document ----------
{
  const saved = globalThis.document;
  delete globalThis.document;
  const ui = createWantedUI({});
  await ui.showBusted({ fine: 1 });
  check('無 document → no-op UI，showBusted 立即 resolve', ui.els === null && ui.showHint('a', 'b') === false);
  if (saved) globalThis.document = saved;
}

// ---------- 審查 🟡：overlay resolve reason、點擊吞掉、提示走 HUD ----------
{
  const doc = makeDoc();
  const ui = createWantedUI({ root: new El('div'), canvas: new El('canvas'), doc });
  const reasons = [];
  const p1 = ui.showBusted({ fine: 1 }).then((r) => reasons.push(r && r.reason));
  const p2 = ui.showWasted({ fee: 1 }).then((r) => reasons.push(r && r.reason));
  await p1;
  advance(SKIP_DELAY_SEC * 1000);
  let stopped = 0;
  let prevented = 0;
  for (const fn of [...(doc.listeners.pointerdown || [])]) fn({ type: 'pointerdown', stopPropagation() { stopped++; }, preventDefault() { prevented++; } });
  await p2;
  const p3 = ui.showBusted({ fine: 1 }).then((r) => reasons.push(r && r.reason));
  advance(OVERLAY_SEC * 1000);
  await p3;
  const p4 = ui.showBusted({ fine: 1 }).then((r) => reasons.push(r && r.reason));
  ui.dispose();
  await p4;
  check('overlay resolve reason：preempted / skipped / done / disposed', reasons.join() === 'preempted,skipped,done,disposed', reasons.join());
  check('跳過畫面的點擊 stopPropagation + preventDefault（不傳到下層）', stopped === 1 && prevented === 1);
  // 跳過延遲前的點擊也吞掉
  const doc2 = makeDoc();
  const ui2 = createWantedUI({ root: new El('div'), doc: doc2 });
  const p5 = ui2.showBusted({ fine: 1 });
  let early = 0;
  for (const fn of [...(doc2.listeners.click || [])]) fn({ type: 'click', stopPropagation() { early++; }, preventDefault() {} });
  check('跳過延遲前的點擊同樣吞掉、不結束畫面', early === 1 && ui2.overlayActive);
  advance(OVERLAY_SEC * 1000);
  await p5;
  ui2.dispose();
  // 注入 hints（HUD）→ showHint 交給 HUD（tcgta.hints.seen、hud.resetHints() 可重置），不寫本檔 key
  store.delete('tcgta.hints');
  const calls = [];
  const hud = { seen: new Set(), showHint(id, text) { calls.push([id, text]); if (this.seen.has(id)) return false; this.seen.add(id); return true; }, resetHints() { this.seen.clear(); } };
  const root3 = new El('div');
  const ui3 = createWantedUI({ root: root3, doc: makeDoc(), hints: hud });
  const r1 = ui3.showHint('wanted', '警察在找你');
  const r2 = ui3.showHint('wanted', '警察在找你');
  hud.resetHints();
  const r3 = ui3.showHint('wanted', '警察在找你');
  check('hints 注入：委派 hud.showHint、hud.resetHints 後可再顯示、不另寫 tcgta.hints、本檔提示卡不顯示',
    r1 === true && r2 === false && r3 === true && calls.length === 3 && !store.has('tcgta.hints') && find(root3, 'wanted-hint').hidden);
  ui3.dispose();
}

// ---------- CSS 靜態檢查 ----------
{
  const css = fs.readFileSync(`${ROOT}src/wanted/wanted.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [...css.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim()).filter((s) => s && !s.startsWith('@') && !/^(from|to|\d+%)$/.test(s));
  const bad = selectors.flatMap((s) => s.split(',')).map((s) => s.trim()).filter((s) => !/^(body\.touch(-walk|-drive)?\s+)?\.(wanted|tw)-/.test(s));
  check('選擇器一律 .wanted- / .tw- 前綴（可帶 body.touch 前綴）', bad.length === 0, bad.join(' | '));
  const mediaBlocks = [...css.matchAll(/@media[^{]+\{([\s\S]*?)\n\}/g)].map((m) => m[1]);
  const mediaSel = mediaBlocks.flatMap((b) => [...b.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim()));
  check('@media 內規則皆限定 body.touch', mediaSel.length > 0 && mediaSel.every((s) => s.startsWith('body.touch')), mediaSel.join(' | '));
  const pe = [...css.matchAll(/pointer-events:\s*(\w+)/g)].map((m) => m[1]);
  check('pointer-events 只有關閉鈕為 auto', pe.filter((v) => v === 'auto').length === 1 && /\.wanted-hint-close\s*\{[^}]*pointer-events:\s*auto/.test(css));
  check('safe-area 有處理', /env\(safe-area-inset-top\)/.test(css) && /env\(safe-area-inset-right\)/.test(css) && /env\(safe-area-inset-bottom\)/.test(css));
  const src = fs.readFileSync(`${ROOT}src/wanted/ui.js`, 'utf8');
  check('ui.js 不 import css（比照 missions/ui.js，由整合層載入）', !/import\s+['"][^'"]+\.css['"]/.test(src));
}

console.log(`\n${failed ? 'FAIL' : 'PASS'} ${failed ? failed : passed}/${passed + failed}`);
if (failed) process.exit(1);
