#!/usr/bin/env node
// 大地圖無頭驗證（契約 §17）：DOM / canvas 最小替身 + 真 citymodel
// 用法：node tools/test/big-map.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：開關 / toggle / aria、root 掛載、dirty 旗標（靜止不重繪）、點擊 → onPick 座標轉換、拖曳不觸發 onPick、
//   雙指捏合（以中點為錨、不觸發 onPick）、滾輪縮放以指標為錨、縮放範圍 clamp、地圖外點擊忽略、
//   清除目的地（bus nav:clear / onClear）、關閉鈕與 onClose、授權標示、圖例、標記 kind 顏色、路線、地標缺省退回、按鈕 ≥ 44 px、
//   時段事件標記（event-start / event-dest 顏色 / 圖例 / 圖釘）、main.js 不改寫 MARKER_COLORS（靜態）
import { register } from 'node:module';

const HOOK = `
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function load(url, context, next) {
  if (url.endsWith('.json')) {
    return { format: 'module', shortCircuit: true, source: 'export default ' + readFileSync(fileURLToPath(url), 'utf8') + ';' };
  }
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
  return next(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(HOOK)}`, import.meta.url);

// ---------- 2D context 替身：記錄屬性設定與文字 ----------
function makeCtx() {
  const log = { fillStyle: [], strokeStyle: [], text: [], calls: 0 };
  const ctx = new Proxy(
    {},
    {
      get: (_, k) => {
        if (k === '__log') return log;
        if (k === 'measureText') return (s) => ({ width: String(s).length * 12 });
        if (k === 'fillText') return (s) => log.text.push(String(s));
        return () => {
          log.calls++;
        };
      },
      set: (_, k, v) => {
        if (k === 'fillStyle' || k === 'strokeStyle') log[k].push(v);
        return true;
      },
    },
  );
  return ctx;
}

// ---------- DOM 替身 ----------
const W = 800;
const H = 600;
class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.listeners = {};
    this.attrs = {};
    this.style = {};
    this.textContent = '';
    this.className = '';
    this.width = 0;
    this.height = 0;
    this._ctx = null;
    const self = this;
    this.classList = {
      _set() {
        return new Set(self.className.split(/\s+/).filter(Boolean));
      },
      add(c) {
        const s = this._set();
        s.add(c);
        self.className = [...s].join(' ');
      },
      remove(c) {
        const s = this._set();
        s.delete(c);
        self.className = [...s].join(' ');
      },
      contains(c) {
        return this._set().has(c);
      },
      toggle(c, force) {
        const on = force === undefined ? !this.contains(c) : !!force;
        if (on) this.add(c);
        else this.remove(c);
        return on;
      },
    };
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
    return this.attrs[k] ?? null;
  }
  addEventListener(t, fn) {
    (this.listeners[t] ||= []).push(fn);
  }
  removeEventListener(t, fn) {
    this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn);
  }
  dispatch(t, ev = {}) {
    const e = { type: t, preventDefault() {}, stopPropagation() {}, ...ev };
    for (const fn of [...(this.listeners[t] || [])]) fn(e);
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: W, height: H };
  }
  getContext() {
    if (!this._ctx) this._ctx = makeCtx();
    return this._ctx;
  }
  setPointerCapture() {}
}
globalThis.document = { createElement: (t) => new FakeEl(t) };

const fs = await import('node:fs');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');
const { BOUNDS, ATTRIBUTION } = await import('../../src/citymodel.js');
const { screenToWorld, fitScale } = await import('../../src/ui/map-view.js');
const { createBigMap, drawBigMap, MARKER_COLORS, MARKER_LABELS, PIN_KINDS, TAP_PX } = await import('../../src/map/big-map.js');
const { createBus } = await import('../../src/core/events.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(3) : String(v));
const walk = (el, fn) => {
  fn(el);
  for (const c of el.children) walk(c, fn);
};
const find = (el, pred) => {
  let hit = null;
  walk(el, (e) => {
    if (!hit && pred(e)) hit = e;
  });
  return hit;
};
const byLabel = (el, label) => find(el, (e) => e.tagName === 'BUTTON' && e.attrs['aria-label'] === label);

// ---------- 建立 ----------
const bus = createBus();
const sounds = [];
const clears = [];
bus.on('ui:sound', (e) => sounds.push(e.kind));
bus.on('nav:clear', (e) => clears.push(e));
const root = new FakeEl('div');
const player = { x: (BOUNDS.minX + BOUNDS.maxX) / 2, z: (BOUNDS.minZ + BOUNDS.maxZ) / 2, yaw: 0.5 };
const picks = [];
let closedByBtn = 0;
const markers = Object.keys(MARKER_COLORS).map((kind, i) => ({ x: player.x + 20 * i, z: player.z + 10, kind, label: kind }));
const route = [
  { x: player.x, z: player.z },
  { x: player.x + 100, z: player.z },
  { x: player.x + 100, z: player.z + 80 },
];
const map = createBigMap({
  root,
  bus,
  getPlayer: () => player,
  getMarkers: () => markers,
  getRoute: () => route,
  onPick: (x, z) => picks.push({ x, z }),
  onClose: () => closedByBtn++,
});
const el = map.el;
const canvas = find(el, (e) => e.tagName === 'CANVAS');

check('面板掛到 root、前綴 mp-', root.children.includes(el) && el.className.includes('mp-panel') && canvas.className === 'mp-canvas');
check('初始關閉、不繪', !map.isOpen() && map.stats().renders === 0 && el.attrs['aria-hidden'] === 'true');
map.draw();
check('關閉時 draw() 不繪', map.stats().renders === 0);

map.open();
check('open → 開啟、繪一次、aria-hidden=false', map.isOpen() && el.classList.contains('mp-open') && map.stats().renders === 1 && el.attrs['aria-hidden'] === 'false');
check('開啟時以玩家為中心', Math.abs(map.getView().cx - player.x) < 1e-6 && Math.abs(map.getView().cz - player.z) < 1e-6);
check('canvas 尺寸跟版面', canvas.width === W && canvas.height === H);
check('open 發 ui:sound open', sounds.includes('open'));
const r0 = map.stats().renders;
check('靜止不重繪（dirty 旗標）', map.stats().renders === r0 && map.stats().dirty === false);
map.draw();
check('draw() 標記後重繪一次', map.stats().renders === r0 + 1);

// ---------- 時段事件標記（正式定義於 big-map.js）----------
check('事件標記 event-start / event-dest 有正式顏色（色碼字串、與其他 kind 不重複）', ['event-start', 'event-dest'].every((k) => /^#[0-9a-f]{6}$/i.test(MARKER_COLORS[k] || '')) && new Set(Object.values(MARKER_COLORS)).size === Object.keys(MARKER_COLORS).length);
check('MARKER_COLORS / MARKER_LABELS 同一份 kind 清單（每個 kind 都有圖例文字）', Object.keys(MARKER_COLORS).join() === Object.keys(MARKER_LABELS).join() && Object.values(MARKER_LABELS).every((t) => typeof t === 'string' && t.length > 0));
check('圖釘樣式：event-dest 與 dest / mission-dest 同為圖釘、event-start 為圓點', PIN_KINDS.has('event-dest') && PIN_KINDS.has('dest') && PIN_KINDS.has('mission-dest') && !PIN_KINDS.has('event-start'));
{
  const shape = (kind) => {
    const calls = [];
    const rec = new Proxy({}, { get: (_, k) => (k === 'measureText' ? () => ({ width: 0 }) : (...a) => calls.push(k)), set: () => true });
    drawBigMap(rec, { cx: 0, cz: 0, scale: 1, w: W, h: H }, { markers: [{ x: 0, z: 0, kind }], landmarks: [] });
    return calls.filter((c) => c === 'lineTo').length;
  };
  check('繪製：event-dest 畫圖釘（同 mission-dest 筆畫）、event-start 畫圓點（同 mission-start）', shape('event-dest') === shape('mission-dest') && shape('event-dest') > 0 && shape('event-start') === shape('mission-start'), `${shape('event-dest')}/${shape('event-start')}`);
}
{
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8').replace(/\/\/.*$/gm, '');
  check('靜態：main.js 不再改寫 big-map MARKER_COLORS（無別名 import、無補色）', !/MARKER_COLORS\s+as\b/.test(mainSrc) && !/BIG_MAP_COLORS|EVENT_MAP_COLORS/.test(mainSrc) && !/MARKER_COLORS\s*\[[^\]]+\]\s*=(?!=)/.test(mainSrc));
}

// ---------- 繪製內容 ----------
const log = canvas.getContext().__log;
check('標記 kind 顏色全部出現', Object.values(MARKER_COLORS).every((c) => log.fillStyle.includes(c)));
check('路線以亮色線繪製', log.strokeStyle.includes('#35f2ff'));
check('地標缺省 → 退回具名建築名稱標籤', log.text.length > 0, `${log.text.length} 個標籤，例：${log.text[0] || ''}`);
const ctxA = makeCtx();
drawBigMap(ctxA, { cx: player.x, cz: player.z, scale: 1, w: W, h: H }, { landmarks: [{ name: '臺中國家歌劇院', x: player.x, z: player.z }], markers: null, route: null, player: null });
check('注入地標 → 名稱標籤', ctxA.__log.text.includes('臺中國家歌劇院'));
const ctxB = makeCtx();
drawBigMap(ctxB, { cx: player.x, cz: player.z, scale: 1, w: W, h: H }, {});
check('資料全缺也能繪製（不丟例外）', ctxB.__log.calls > 0);

// ---------- 點擊 → onPick ----------
const ptr = (type, id, x, y, extra = {}) => canvas.dispatch(type, { pointerId: id, clientX: x, clientY: y, pointerType: 'touch', button: 0, ...extra });
let v = map.getView();
const exp = screenToWorld(v, 250, 180);
ptr('pointerdown', 1, 250, 180);
ptr('pointerup', 1, 250, 180);
check('點擊 → onPick 一次', picks.length === 1);
check('點擊座標轉換正確', picks.length === 1 && Math.abs(picks[0].x - exp.x) < 1e-6 && Math.abs(picks[0].z - exp.z) < 1e-6, picks[0] ? `(${f2(picks[0].x)}, ${f2(picks[0].z)}) vs (${f2(exp.x)}, ${f2(exp.z)})` : '');
check('點擊畫面中心 = 視圖中心', (() => {
  picks.length = 0;
  v = map.getView();
  ptr('pointerdown', 2, W / 2, H / 2);
  ptr('pointerup', 2, W / 2, H / 2);
  return picks.length === 1 && Math.abs(picks[0].x - v.cx) < 1e-6 && Math.abs(picks[0].z - v.cz) < 1e-6;
})());
// 小抖動（< 6 px）仍算點擊
picks.length = 0;
ptr('pointerdown', 3, 300, 300);
ptr('pointermove', 3, 303, 302);
ptr('pointerup', 3, 303, 302);
check(`移動 < ${TAP_PX} px 仍視為點擊`, picks.length === 1);

// ---------- 拖曳 ----------
picks.length = 0;
v = map.getView();
ptr('pointerdown', 4, 400, 300);
ptr('pointermove', 4, 420, 300);
ptr('pointermove', 4, 440, 310);
ptr('pointerup', 4, 440, 310);
const v2 = map.getView();
check('拖曳不觸發 onPick', picks.length === 0);
check('拖曳平移：地圖跟著手指走', Math.abs(v2.cx - (v.cx - 40 / v.scale)) < 1e-6 && Math.abs(v2.cz - (v.cz - 10 / v.scale)) < 1e-6, `Δcx ${f2(v2.cx - v.cx)}`);
// 拖出去再拖回原點：總位移曾 ≥ 6 px → 仍不算點擊
ptr('pointerdown', 5, 400, 300);
ptr('pointermove', 5, 440, 300);
ptr('pointermove', 5, 400, 300);
ptr('pointerup', 5, 400, 300);
check('拖出再拖回不算點擊', picks.length === 0);
const rDrag = map.stats().renders;
check('拖曳時有重繪', rDrag > r0 + 1);

// ---------- 雙指捏合 ----------
map.setView({ ...map.getView(), cx: player.x, cz: player.z, scale: 1 });
v = map.getView();
const anchor = screenToWorld(v, 400, 300);
ptr('pointerdown', 10, 350, 300);
ptr('pointerdown', 11, 450, 300);
ptr('pointermove', 10, 300, 300);
ptr('pointermove', 11, 500, 300);
const vp = map.getView();
const anchorAfter = screenToWorld(vp, 400, 300);
ptr('pointerup', 10, 300, 300);
ptr('pointerup', 11, 500, 300);
check('雙指捏合放大', vp.scale > v.scale * 1.5, `${f2(v.scale)} → ${f2(vp.scale)}`);
check('捏合以兩指中點為錨', Math.abs(anchorAfter.x - anchor.x) < 1e-6 && Math.abs(anchorAfter.z - anchor.z) < 1e-6);
check('捏合不觸發 onPick', picks.length === 0);

// ---------- 滾輪 ----------
map.setView({ ...map.getView(), cx: player.x, cz: player.z, scale: 1 });
v = map.getView();
const wa = screenToWorld(v, 200, 150);
canvas.dispatch('wheel', { clientX: 200, clientY: 150, deltaY: -200, deltaMode: 0 });
const vw = map.getView();
const wb = screenToWorld(vw, 200, 150);
check('滾輪縮放以指標為錨', vw.scale > v.scale && Math.abs(wa.x - wb.x) < 1e-6 && Math.abs(wa.z - wb.z) < 1e-6);
canvas.dispatch('wheel', { clientX: 400, clientY: 300, deltaY: -1e6, deltaMode: 0 });
check('放大上限 clamp = 6 px/m', Math.abs(map.getView().scale - 6) < 1e-9, f2(map.getView().scale));
canvas.dispatch('wheel', { clientX: 400, clientY: 300, deltaY: 1e6, deltaMode: 0 });
const minS = fitScale(W, H) * 0.8;
check('縮小下限 clamp = 整圖 0.8 倍', Math.abs(map.getView().scale - minS) < 1e-9, `${f2(map.getView().scale)} vs ${f2(minS)}`);
map.setView({ ...map.getView(), cx: BOUNDS.maxX + 5000, cz: BOUNDS.minZ - 5000 });
check('中心 clamp 在地圖範圍內', map.getView().cx === BOUNDS.maxX && map.getView().cz === BOUNDS.minZ);
map.zoomBy(1e9);
check('+ 鈕路徑同樣 clamp', map.getView().scale === 6);

// ---------- 地圖外點擊 ----------
map.setView({ ...map.getView(), cx: BOUNDS.minX, cz: BOUNDS.minZ, scale: 1 });
picks.length = 0;
ptr('pointerdown', 20, 10, 10);
ptr('pointerup', 20, 10, 10);
check('地圖範圍外點擊忽略', picks.length === 0);
// 滑鼠右鍵不拖曳
v = map.getView();
ptr('pointerdown', 21, 400, 300, { pointerType: 'mouse', button: 2 });
ptr('pointermove', 21, 450, 300, { pointerType: 'mouse', button: 2 });
ptr('pointerup', 21, 450, 300, { pointerType: 'mouse', button: 2 });
check('滑鼠右鍵不平移', map.getView().cx === v.cx);

// ---------- 按鈕 ----------
const meBtn = byLabel(el, '回到自己');
map.setView({ ...map.getView(), cx: BOUNDS.minX, cz: BOUNDS.minZ });
meBtn.dispatch('click');
check('「回到自己」', Math.abs(map.getView().cx - player.x) < 1e-6 && Math.abs(map.getView().cz - player.z) < 1e-6);
byLabel(el, '清除目的地').dispatch('click');
check('「清除目的地」→ bus nav:clear { source: map }', clears.length === 1 && clears[0].source === 'map');
let cleared = 0;
const map2 = createBigMap({ root, onClear: () => cleared++ });
map2.open();
byLabel(map2.el, '清除目的地').dispatch('click');
check('注入 onClear 時呼叫之', cleared === 1);
check('無 bus / getter 也可開啟繪製', map2.isOpen() && map2.stats().renders >= 1);
map2.destroy();
check('destroy 自 root 移除', !root.children.includes(map2.el));
const legend = find(el, (e) => e.className.split(' ')[0] === 'mp-legend');
check('圖例存在且預設展開（寬螢幕）', !!legend && legend.classList.contains('mp-legend-open'));
byLabel(el, '顯示或隱藏圖例').dispatch('click');
check('圖例可收合', !legend.classList.contains('mp-legend-open'));
const legendText = [];
walk(legend, (e) => e.className === 'mp-legend-text' && legendText.push(e.textContent));
check('圖例含全部標記種類', ['委託起點', '委託目的地', '目的地', '打卡地標', '小吃', '彈藥'].every((t) => legendText.includes(t)), legendText.join('、'));
check('圖例含時段事件兩類標記（外送取餐點 / 外送送達點）', ['外送取餐點', '外送送達點'].every((t) => legendText.includes(t)), legendText.join('、'));
const attr = find(el, (e) => e.className === 'mp-attr');
check('授權標示在面板內（OpenStreetMap / ODbL）', !!attr && attr.textContent === ATTRIBUTION && /OpenStreetMap/.test(attr.textContent) && /ODbL/.test(attr.textContent));

// toggle / close
check('toggle 關閉', map.toggle() === false && !map.isOpen() && !el.classList.contains('mp-open'));
const rClosed = map.stats().renders;
map.draw();
ptr('pointerdown', 30, 400, 300);
ptr('pointerup', 30, 400, 300);
check('關閉後不繪、不觸發 onPick', map.stats().renders === rClosed && picks.length === 0);
check('toggle 開啟', map.toggle() === true && map.isOpen());
find(el, (e) => e.attrs['aria-label'] === '關閉地圖').dispatch('click');
check('關閉鈕 → close + onClose', !map.isOpen() && closedByBtn === 1 && sounds.includes('close'));

// ---------- CSS ----------
const css = fs.readFileSync(path.join(ROOT, 'src/map/map.css'), 'utf8');
check('CSS：z-index 85、按鈕 ≥ 44 px、safe-area、touch-action none', /z-index:\s*85/.test(css) && /min-width:\s*44px/.test(css) && /min-height:\s*44px/.test(css) && /safe-area-inset/.test(css) && /touch-action:\s*none/.test(css));
const selectors = css.match(/^[^\s@/{}][^{]*\{/gm) || [];
check('CSS 選擇器全部 mp- 前綴', selectors.every((s) => s.split(',').every((p) => /^\s*\.mp-/.test(p))), `${selectors.length} 條`);

map.destroy();
check('destroy 後移除', !root.children.includes(el));

console.log(failed ? `FAIL ${failed}/${passed + failed}` : `PASS ${passed}/${passed + failed}`);
process.exit(failed ? 1 : 0);
