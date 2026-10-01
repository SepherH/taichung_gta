#!/usr/bin/env node
// B1 選單無頭驗證：menu-model 狀態轉換與鍵盤導覽、確認對話框流程、格式化函式、map-view 座標轉換往返誤差、
//   map 繪製在假 canvas context 上（真 citymodel 資料）、menu.js 在最小 DOM 替身上的事件流程（開始 / 暫停 / 回主選單 / 設定）、menu.css 規範
// I4b 增補：設定頁 showBlood / recoil / aimAssist 三列、開始畫面內容標示、暫停選單「圖鑑」鈕（onOpenGuide）、ui:sound 音效事件、
//   操作說明頁由真 KEYMAP_HELP / TOUCH_HELP 產生（新動作有出現）
// 用法：node tools/test/menu.mjs（任一斷言失敗 exit 1；最後一行印 PASS n/n 或 FAIL k/n）
import { register } from 'node:module';

const HOOK = `
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function load(url, context, next) {
  if (url.endsWith('.json')) {
    return { format: 'module', shortCircuit: true, source: 'export default ' + readFileSync(fileURLToPath(url), 'utf8') + ';' };
  }
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default "";' };
  return next(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(HOOK)}`, import.meta.url);

// ---------- 最小 DOM 替身 ----------
const drawStats = { calls: 0, paths: 0, bad: 0, text: 0 };
const ctx2d = new Proxy(
  {},
  {
    get: (_, k) => {
      if (k === 'measureText') return (s) => ({ width: String(s).length * 12 });
      if (k === 'moveTo' || k === 'lineTo' || k === 'translate' || k === 'fillRect' || k === 'fillText' || k === 'strokeText') {
        return (...a) => {
          drawStats.calls++;
          if (k === 'fillText') drawStats.text++;
          for (const v of a) if (typeof v === 'number' && !Number.isFinite(v)) drawStats.bad++;
        };
      }
      if (k === 'beginPath') return () => drawStats.paths++;
      return () => {};
    },
    set: () => true,
  },
);

class FakeEvent {
  constructor(type, init = {}) {
    Object.assign(this, init);
    this.type = type;
    this.defaultPrevented = false;
    this.propagationStopped = false;
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this.propagationStopped = true;
  }
}

class Listeners {
  constructor() {
    this._l = {};
  }
  addEventListener(t, fn) {
    (this._l[t] ||= []).push(fn);
  }
  removeEventListener(t, fn) {
    const a = this._l[t];
    if (a) this._l[t] = a.filter((f) => f !== fn);
  }
  dispatchEvent(e) {
    for (const fn of (this._l[e.type] || []).slice()) fn(e);
    return !e.defaultPrevented;
  }
  listenerCount(t) {
    return (this._l[t] || []).length;
  }
}

class FakeEl extends Listeners {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this._cls = new Set();
    this.dataset = {};
    this.style = {};
    this.attrs = {};
    this.hidden = false;
    this._text = '';
    this.width = 0;
    this.height = 0;
    this.scrollTop = 0;
    this.value = '';
    const self = this;
    this.classList = {
      add: (...c) => c.forEach((x) => self._cls.add(x)),
      remove: (...c) => c.forEach((x) => self._cls.delete(x)),
      toggle: (c, on) => {
        const v = on === undefined ? !self._cls.has(c) : !!on;
        if (v) self._cls.add(c);
        else self._cls.delete(c);
        return v;
      },
      contains: (c) => self._cls.has(c),
    };
  }
  get className() {
    return [...this._cls].join(' ');
  }
  set className(v) {
    this._cls = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get textContent() {
    return this._text + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  set textContent(v) {
    this.children.forEach((c) => typeof c !== 'string' && (c.parentNode = null));
    this.children = [];
    this._text = String(v);
  }
  appendChild(c) {
    if (typeof c !== 'string') {
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = this;
    }
    this.children.push(c);
    return c;
  }
  append(...cs) {
    for (const c of cs) this.appendChild(c);
  }
  removeChild(c) {
    this.children = this.children.filter((x) => x !== c);
    c.parentNode = null;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  get clientWidth() {
    return 800;
  }
  get clientHeight() {
    return 500;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 500 };
  }
  getContext() {
    return ctx2d;
  }
  setPointerCapture() {}
  focus() {
    doc.activeElement = this;
  }
  scrollIntoView() {}
  click() {
    this.dispatchEvent(new FakeEvent('click'));
  }
  *walk() {
    for (const c of this.children) {
      if (typeof c === 'string') continue;
      yield c;
      yield* c.walk();
    }
  }
  querySelector(sel) {
    const tags = sel.split(',').map((s) => s.trim().toUpperCase());
    for (const e of this.walk()) if (tags.includes(e.tagName)) return e;
    return null;
  }
  findClass(c) {
    for (const e of this.walk()) if (e._cls.has(c)) return e;
    return null;
  }
  findAllClass(c) {
    return [...this.walk()].filter((e) => e._cls.has(c));
  }
  // 自身與祖先皆未 hidden
  get visible() {
    for (let e = this; e; e = e.parentNode) if (e.hidden) return false;
    return true;
  }
}

const doc = Object.assign(new Listeners(), {
  createElement: (t) => new FakeEl(t),
  fullscreenEnabled: true,
  fullscreenElement: null,
  documentElement: new FakeEl('html'),
  activeElement: null,
});
doc.documentElement.requestFullscreen = () => {
  doc.fullscreenElement = doc.documentElement;
  return Promise.resolve();
};
doc.exitFullscreen = () => {
  doc.fullscreenElement = null;
  return Promise.resolve();
};
globalThis.document = doc;
const win = Object.assign(new Listeners(), { devicePixelRatio: 2 });
globalThis.window = win;

const { readFileSync } = await import('node:fs');
const { fileURLToPath } = await import('node:url');
const M = await import('../../src/ui/menu-model.js');
const V = await import('../../src/ui/map-view.js');
const { createMenu } = await import('../../src/ui/menu.js');
const { BOUNDS, ATTRIBUTION } = await import('../../src/citymodel.js');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const j = (v) => JSON.stringify(v);

// ======================= menu-model：狀態轉換與鍵盤導覽 =======================
{
  const m = M.createMenuModel({ fullscreen: false });
  check('初始 closed、按鍵不處理', m.state === 'closed' && m.key('Escape') === null);

  m.showStart({ canContinue: true });
  check('有存檔：開始畫面項目與預設焦點 = 繼續遊戲', j(m.items) === j(['continue', 'newGame', 'settings', 'help']) && m.focus === 'continue');
  check('開始畫面最上層 Esc 不關閉', m.key('Escape').type === 'none' && m.state === 'start');
  check('開始畫面 P / M 不處理', m.key('KeyP') === null && m.key('KeyM') === null);
  m.key('ArrowUp');
  check('↑ 由第一項繞到最後一項', m.focus === 'help');
  m.key('ArrowDown');
  check('↓ 繞回第一項', m.focus === 'continue');
  let fx = m.key('Enter');
  check('Enter 繼續遊戲 → start { continued:true } 且關閉', fx.type === 'start' && fx.continued === true && m.state === 'closed');

  m.showStart({ canContinue: false });
  check('無存檔：不列繼續、焦點 = 開始新遊戲', !m.items.includes('continue') && m.focus === 'newGame');
  fx = m.activate();
  check('無存檔開始新遊戲不需確認', fx.type === 'start' && fx.continued === false && m.confirm === null);

  // 確認對話框：覆蓋進度
  m.showStart({ canContinue: true });
  m.key('ArrowDown');
  fx = m.key('Enter');
  check('有存檔開始新遊戲 → 確認框（預設焦點 取消）', fx.type === 'confirm' && m.confirm && m.confirm.id === 'newGame' && m.focus === 'no');
  check('確認框文案含「覆蓋目前進度」', /覆蓋目前進度/.test(m.confirm.text));
  fx = m.key('Enter');
  check('確認框 Enter（取消）→ 回開始畫面', fx.type === 'cancel' && m.state === 'start' && !m.confirm && m.focus === 'newGame');
  m.key('Enter');
  check('確認框開著時 P 被吃掉', m.key('KeyP').type === 'none' && m.confirm !== null);
  m.key('Escape');
  check('確認框 Esc = 取消', !m.confirm && m.state === 'start');
  m.key('Enter');
  m.key('ArrowLeft');
  check('確認框 ← 切到確定', m.focus === 'yes');
  fx = m.key('Enter');
  check('確認後 → start { continued:false }', fx.type === 'start' && fx.continued === false && m.state === 'closed');

  // 子頁堆疊
  m.showStart({ canContinue: false });
  m.setItems('settings', ['a', 'b', 'reset']);
  m.focusItem('settings');
  fx = m.key('Enter');
  check('開始畫面 → 設定子頁', fx.type === 'page' && m.page === 'settings' && m.depth === 2 && m.focus === 'a');
  m.key('ArrowDown');
  fx = m.key('ArrowRight');
  check('list 子頁 ↓ 移動、→ 調整', fx.type === 'adjust' && fx.item === 'b' && fx.dir === 1);
  fx = m.key('Enter');
  check('list 子頁 Enter → activate 項目', fx.type === 'activate' && fx.page === 'settings' && fx.item === 'b');
  fx = m.key('Escape');
  check('子頁 Esc → 回主清單、焦點留在「設定」', fx.type === 'back' && m.page === 'root' && m.focus === 'settings' && m.state === 'start');
  check('開始畫面不能開地圖 / 統計頁', m.openPage('map') === null && m.openPage('stats') === null);

  // 暫停
  m.close();
  const p = M.createMenuModel({ fullscreen: true });
  p.openPause();
  check('暫停：項目含全螢幕、焦點 = 繼續', j(p.items) === j(['resume', 'map', 'settings', 'help', 'stats', 'fullscreen', 'quit']) && p.focus === 'resume');
  check('fullscreen:false 時不列全螢幕', !M.pauseItems({ fullscreen: false }).includes('fullscreen'));
  fx = p.key('Escape');
  check('暫停最上層 Esc = 繼續', fx.type === 'resume' && p.state === 'closed');
  p.openPause('map');
  check('openPause("map") 直接開地圖頁', p.page === 'map' && p.tab === 'map' && p.rootFocus === 'map');
  fx = p.key('ArrowLeft');
  check('free 子頁方向鍵 → arrow 效果', fx.type === 'arrow' && fx.dx === -1 && fx.dy === 0);
  fx = p.key('Equal');
  check('地圖頁 = / - 鍵縮放', fx.type === 'zoom' && fx.dir === 1 && p.key('Minus').dir === -1);
  fx = p.key('KeyM');
  check('地圖頁 M = 繼續', fx.type === 'resume' && p.state === 'closed');
  p.openPause();
  p.key('KeyM');
  check('暫停主清單 M → 地圖頁', p.page === 'map');
  p.openPage('stats');
  check('子頁為平行分頁（替換不加深）', p.page === 'stats' && p.depth === 2);
  fx = p.key('KeyP');
  check('子頁中 P = 繼續', fx.type === 'resume' && p.state === 'closed');
  p.openPause('settings');
  p.openPause('help');
  check('已暫停時 openPause(tab) 只切分頁', p.page === 'help' && p.depth === 2);
  p.key('Escape');
  check('子頁 Esc 回暫停主清單（不直接繼續）、焦點留在該頁項目', p.state === 'pause' && p.page === 'root' && p.focus === 'help');
  p.focusItem('resume');
  p.key('ArrowUp');
  check('暫停主清單 ↑ 繞到「回主選單」', p.focus === 'quit');
  fx = p.key('Enter');
  check('回主選單 → 確認框', fx.type === 'confirm' && p.confirm.id === 'quit');
  p.key('Escape');
  check('回主選單確認 Esc 取消 → 仍暫停', p.state === 'pause' && !p.confirm);
  p.key('Enter');
  p.key('ArrowRight');
  fx = p.key('Enter');
  check('確認回主選單 → quitToMenu', fx.type === 'quitToMenu' && p.state === 'closed');
  p.openPause();
  p.key('Tab');
  check('Tab 往下、Shift+Tab 往上', p.focus === 'map' && (p.key('Tab', { shift: true }), p.focus === 'resume'));
  check('未知鍵不處理（不攔截）', p.key('KeyW') === null);
  check('fullscreen 項目 → fullscreen 效果', p.activate('fullscreen').type === 'fullscreen' && p.state === 'pause');
  check('pauseItems 預設無圖鑑、guide:true 時排在地圖後', !M.pauseItems().includes('guide') && j(M.pauseItems({ guide: true })) === j(['resume', 'map', 'guide', 'settings', 'help', 'stats', 'quit']));
  const g = M.createMenuModel({ guide: true });
  g.openPause();
  const gfx = g.activate('guide');
  check('guide 項目 → { type: guide } 並關閉', gfx.type === 'guide' && g.state === 'closed' && M.ITEM_LABELS.guide === '圖鑑');
}

// ======================= 格式化 =======================
check('formatDuration', M.formatDuration(0) === '0:00:00' && M.formatDuration(3725.9) === '1:02:05' && M.formatDuration(36000) === '10:00:00' && M.formatDuration(NaN) === '0:00:00' && M.formatDuration(-3) === '0:00:00');
check('formatKm', M.formatKm(1234) === '1.2 km' && M.formatKm(0) === '0.0 km' && M.formatKm(-5) === '0.0 km' && M.formatKm(15960) === '16.0 km');
check(
  'formatMoney',
  M.formatMoney(1234) === 'NT$1,234' && M.formatMoney(0) === 'NT$0' && M.formatMoney(1234567.4) === 'NT$1,234,567' && M.formatMoney(-50) === '-NT$50' && M.formatMoney(999) === 'NT$999' && M.formatMoney(undefined) === 'NT$0',
  M.formatMoney(1234567.4),
);

// ======================= map-view：座標轉換 =======================
{
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let maxErr = 0;
  for (let i = 0; i < 2000; i++) {
    const view = { cx: BOUNDS.minX + rnd() * 1900, cz: BOUNDS.minZ + rnd() * 1500, scale: 0.05 + rnd() * 6, w: 200 + rnd() * 1800, h: 200 + rnd() * 1200 };
    const x = BOUNDS.minX + rnd() * 2000;
    const z = BOUNDS.minZ + rnd() * 1600;
    const s = V.worldToScreen(view, x, z);
    const w = V.screenToWorld(view, s.x, s.y);
    maxErr = Math.max(maxErr, Math.abs(w.x - x), Math.abs(w.z - z));
  }
  check('世界↔螢幕往返誤差 < 1e-6（2000 點）', maxErr < 1e-6, `max ${maxErr.toExponential(2)}`);

  const view = { cx: 100, cz: -50, scale: 1.2, w: 800, h: 500 };
  const c = V.worldToScreen(view, 100, -50);
  check('視圖中心投影到畫面中心', Math.abs(c.x - 400) < 1e-9 && Math.abs(c.y - 250) < 1e-9);
  const north = V.worldToScreen(view, 100, -150);
  const east = V.worldToScreen(view, 200, -50);
  check('北朝上（-Z 在上）、東在右（+X 在右）', north.y < c.y && Math.abs(north.x - c.x) < 1e-9 && east.x > c.x);

  const anchor = V.screenToWorld(view, 130, 420);
  const z2 = V.zoomAt(view, 2.5, 130, 420);
  const a2 = V.screenToWorld(z2, 130, 420);
  check('zoomAt 錨點世界座標不變', Math.abs(a2.x - anchor.x) < 1e-6 && Math.abs(a2.z - anchor.z) < 1e-6 && Math.abs(z2.scale - 3) < 1e-9);
  const pb = V.panBy(view, 60, -30);
  const moved = V.worldToScreen(pb, 100, -50);
  check('panBy：世界點跟著拖曳位移', Math.abs(moved.x - 460) < 1e-9 && Math.abs(moved.y - 220) < 1e-9);
  const cl = V.clampView({ cx: 1e6, cz: -1e6, scale: 100, w: 800, h: 500 });
  check('clampView 夾住中心與最大比例', cl.cx === BOUNDS.maxX && cl.cz === BOUNDS.minZ && cl.scale === 6);
  const cl2 = V.clampView({ cx: 0, cz: 0, scale: 1e-6, w: 800, h: 500 });
  check('clampView 最小比例 = 整圖 0.8 倍', Math.abs(cl2.scale - V.fitScale(800, 500) * 0.8) < 1e-12);
}

// ======================= map 繪製（真 citymodel 資料、假 context）=======================
{
  let threw = null;
  const counts = [];
  try {
    for (const scale of [0.2, 0.7, 2, 6]) {
      const before = drawStats.paths;
      V.drawMap(ctx2d, { cx: 300, cz: 100, scale, w: 1024, h: 640 }, { x: 300, z: 100, yaw: 0.7 });
      counts.push(drawStats.paths - before);
    }
    V.drawMap(ctx2d, { cx: 0, cz: 0, scale: 0.5, w: 400, h: 300 }, null);
    V.drawMap(ctx2d, { cx: 0, cz: 0, scale: 0.5, w: 400, h: 300 }, { x: NaN, z: 1, yaw: 0 });
  } catch (err) {
    threw = err;
  }
  check('drawMap 四種比例 + 無玩家 / 非法玩家座標不丟例外', !threw, threw ? threw.message : counts.join('/'));
  check('drawMap 有畫出道路 / 建築路徑（整圖比例 ≥ 800 條 path）', counts[0] >= 800, `paths ${counts[0]}`);
  check('drawMap 沒有非有限座標', drawStats.bad === 0, `bad ${drawStats.bad}`);
  const t0 = drawStats.text;
  V.drawMap(ctx2d, { cx: 300, cz: 100, scale: 0.8, w: 1400, h: 900 }, { x: 300, z: 100, yaw: 0 });
  check('主要道路標字（比例 0.8 時有道路名稱）', drawStats.text - t0 >= 4, `fillText ${drawStats.text - t0}`);

  let player = { x: 50, z: 60, yaw: 0 };
  const mv = V.createMapView({ getPlayer: () => player });
  const canvas = mv.el.querySelector('canvas');
  const p0 = drawStats.paths;
  mv.draw();
  check('未開啟時 draw() 不繪製', drawStats.paths === p0);
  mv.open();
  const v0 = mv.getView();
  check('open：置中玩家、canvas 依 devicePixelRatio 放大', mv.isOpen() && v0.cx === 50 && v0.cz === 60 && canvas.width === 1600 && canvas.height === 1000, `${canvas.width}x${canvas.height}`);
  check('open 時有繪製', drawStats.paths > p0);
  canvas.dispatchEvent(new FakeEvent('pointerdown', { pointerId: 1, clientX: 400, clientY: 250, button: 0, pointerType: 'touch' }));
  canvas.dispatchEvent(new FakeEvent('pointermove', { pointerId: 1, clientX: 470, clientY: 250 }));
  canvas.dispatchEvent(new FakeEvent('pointerup', { pointerId: 1 }));
  const v1 = mv.getView();
  check('單指拖曳向右 → 視圖中心往西', v1.cx < v0.cx && Math.abs((v0.cx - v1.cx) * v0.scale - 70) < 1e-6);
  canvas.dispatchEvent(new FakeEvent('pointerdown', { pointerId: 1, clientX: 300, clientY: 250, pointerType: 'touch' }));
  canvas.dispatchEvent(new FakeEvent('pointerdown', { pointerId: 2, clientX: 500, clientY: 250, pointerType: 'touch' }));
  canvas.dispatchEvent(new FakeEvent('pointermove', { pointerId: 2, clientX: 700, clientY: 250 }));
  canvas.dispatchEvent(new FakeEvent('pointerup', { pointerId: 1 }));
  canvas.dispatchEvent(new FakeEvent('pointerup', { pointerId: 2 }));
  const v2 = mv.getView();
  check('雙指張開 → 放大', v2.scale > v1.scale * 1.5, `${v1.scale.toFixed(2)} → ${v2.scale.toFixed(2)}`);
  const wheel = new FakeEvent('wheel', { clientX: 400, clientY: 250, deltaY: 300, deltaMode: 0 });
  canvas.dispatchEvent(wheel);
  check('滾輪向下 → 縮小且 preventDefault', mv.getView().scale < v2.scale && wheel.defaultPrevented);
  const btns = mv.el.findAllClass('tg-map-btn');
  const s3 = mv.getView().scale;
  btns[0].click();
  check('+ 鈕放大 1.5 倍', Math.abs(mv.getView().scale / s3 - 1.5) < 1e-9);
  btns[1].click();
  player = { x: 400, z: 300, yaw: 1 };
  btns[2].click();
  check('「回到自己」置中目前玩家位置', mv.getView().cx === 400 && mv.getView().cz === 300);
  mv.panKeys(1, 0);
  check('panKeys → 方向鍵平移', mv.getView().cx > 400);
  mv.close();
  const p1 = drawStats.paths;
  mv.draw();
  check('close 後停止繪製', !mv.isOpen() && drawStats.paths === p1);
  mv.destroy();
}

// ======================= menu.js（最小 DOM 替身）=======================
{
  const events = []; // 遊戲事件（ui:sound 另記在 sounds，不混入既有斷言）
  const sounds = [];
  const handlers = {};
  const bus = {
    on(n, fn) {
      (handlers[n] ||= []).push(fn);
      return () => (handlers[n] = handlers[n].filter((f) => f !== fn));
    },
    emit(n, p) {
      if (n === 'ui:sound') sounds.push(p && p.kind);
      else events.push([n, p]);
      for (const fn of handlers[n] || []) fn(p);
    },
  };
  const lastSound = () => sounds.at(-1);
  const DEF = {
    quality: 'auto', lookSensMouse: 1, lookSensTouch: 1, invertY: false, volumeMaster: 0.8, volumeMusic: 0.6, volumeSfx: 0.9,
    showBlood: true, recoil: 1, aimAssist: true, showFps: false, showHints: true, uiScale: 1,
  };
  const RANGE = { uiScale: [0.8, 1.3], recoil: [0.2, 1] };
  const vals = { ...DEF };
  const subs = [];
  const setCalls = [];
  const settings = {
    get: (k) => vals[k],
    set: (k, v) => {
      setCalls.push([k, v]);
      if (!(k in DEF)) return false; // 同 core/settings.js：未知鍵（例：schema 尚無 weather）回 false 不存
      if (typeof DEF[k] === 'number') {
        const [lo, hi] = RANGE[k] || (k.startsWith('vol') ? [0, 1] : [0.3, 3]);
        v = Math.round(Math.min(hi, Math.max(lo, v)) * 100) / 100;
      }
      vals[k] = v;
      subs.forEach((fn) => fn(k, v, { ...vals }));
      return true;
    },
    getAll: () => ({ ...vals }),
    reset: () => {
      Object.assign(vals, DEF);
      subs.forEach((fn) => fn(undefined, undefined, { ...vals }));
    },
    subscribe: (fn) => {
      subs.push(fn);
      return () => subs.splice(subs.indexOf(fn), 1);
    },
  };
  const keymapHelp = [
    { group: '步行', items: [{ keys: 'KEY-A1', action: 'move', desc: '移動說明甲' }] },
    { group: '通用', items: [{ keys: 'KEY-B2', action: 'pause', desc: '暫停說明乙' }] },
  ];
  const touchHelp = [{ group: '步行', items: [{ keys: 'TOUCH-C3', action: 'move', desc: '觸控說明丙' }] }];
  let saved = true;
  const body = new FakeEl('body');
  const mapView = V.createMapView({ getPlayer: () => ({ x: 0, z: 0, yaw: 0 }) });
  const menu = createMenu({
    root: body,
    settings,
    bus,
    keymapHelp,
    touchHelp,
    isTouch: false,
    attribution: ATTRIBUTION,
    getStats: () => ({ playTimeSec: 3725, distWalkM: 1500, distDriveM: 22000, pedsHit: 3, pedsKnockedOut: 4, carjacks: 1, crashes: 2, kos: 0, moneyEarned: 1234, moneySpent: 100 }),
    getMoney: () => 1650,
    hasSave: () => saved,
    mapView,
  });
  const el = menu.el;
  const key = (code, extra = {}) => {
    const e = new FakeEvent('keydown', { code, ...extra });
    win.dispatchEvent(e);
    return e;
  };
  const navBtn = (id) => el.findAllClass('tg-nav-item').find((b) => b.dataset.item === id);

  check('createMenu 掛到 root、初始隱藏', body.children.includes(el) && el.hidden && !menu.isOpen());
  const ids = [...el.walk()].map((e) => e.id).filter(Boolean);
  check('元素 class / id 皆 tg- 前綴', ids.every((i) => i.startsWith('tg-')) && [...el.walk()].every((e) => [...e._cls].every((c) => c.startsWith('tg-'))));
  menu.showStart({ canContinue: true });
  check('showStart：開啟、標題與副標', menu.isOpen() && !el.hidden && el.textContent.includes('臺中GTA') && el.textContent.includes('七期精華區'));
  const attr = el.findClass('tg-menu-attr');
  const link = attr.querySelector('a');
  check('頁尾授權文字含 OSM 連結', attr.textContent.includes('OpenStreetMap') && attr.textContent.includes('ODbL') && link && /openstreetmap\.org\/copyright/.test(link.href));
  check('有存檔：繼續遊戲在第一個', el.findAllClass('tg-nav-item')[0].dataset.item === 'continue');
  // 內容標示
  const notice = el.findClass('tg-menu-notice');
  check('開始畫面內容標示「本遊戲含槍械、暴力與血液畫面」', !!notice && notice.visible && notice.textContent === '本遊戲含槍械、暴力與血液畫面' && el.dataset.mode === 'start');
  check('內容標示在標頭（不在按鈕左欄內）', !!notice && notice.parentNode === el.findClass('tg-menu-brand') && !el.findClass('tg-menu-nav').findClass('tg-menu-notice'));
  check('開始畫面沒有「圖鑑」（未提供 onOpenGuide）', !navBtn('guide'));
  navBtn('newGame').click();
  const conf = el.findClass('tg-confirm');
  check('開始新遊戲 → 選單內確認框（非 confirm()）', conf.visible && conf.textContent.includes('覆蓋目前進度') && events.length === 0);
  check('ui:sound：開確認框 = open', lastSound() === 'open', String(lastSound()));
  el.findClass('tg-confirm-no').click();
  check('取消 → 確認框關閉、仍在開始畫面', !conf.visible && menu.state === 'start');
  check('ui:sound：取消 = cancel', lastSound() === 'cancel', String(lastSound()));
  navBtn('continue').click();
  check('繼續遊戲 → emit game:start { continued:true } 並關閉', j(events.at(-1)) === j(['game:start', { continued: true }]) && !menu.isOpen() && el.hidden);
  check('ui:sound：開始 = confirm', lastSound() === 'confirm', String(lastSound()));

  // 暫停 + 統計
  menu.openPause('stats');
  check('openPause("stats") → emit game:pause { paused:true, tab:"stats" }', j(events.at(-1)) === j(['game:pause', { paused: true, tab: 'stats' }]));
  check('ui:sound：開暫停選單 = open', lastSound() === 'open', String(lastSound()));
  check('暫停選單不顯示內容標示（CSS 隱藏規則）、未提供 onOpenGuide 時無「圖鑑」', el.dataset.mode === 'pause' && !navBtn('guide'));
  check('右上金錢 NT$1,650', el.findClass('tg-menu-money').textContent === 'NT$1,650');
  const stats = el.findClass('tg-page-stats');
  const st = stats.textContent;
  check(
    '統計頁欄位與格式',
    stats.visible && ['遊玩時間', '1:02:05', '步行距離', '1.5 km', '22.0 km', '撞到行人', '打倒路人', '搶車次數', '車禍', '被打倒次數', 'NT$1,234', 'NT$100', '目前金錢', 'NT$1,650'].every((s) => st.includes(s)),
  );
  bus.emit('player:money', { money: 2000, delta: 350, reason: 'loot' });
  check('player:money 即時更新右上金錢', el.findClass('tg-menu-money').textContent === 'NT$2,000');
  check('全螢幕項目（fullscreenEnabled）', !!navBtn('fullscreen') && navBtn('fullscreen').textContent === '全螢幕');

  // 指標事件不外傳
  const pd = new FakeEvent('pointerdown');
  el.dispatchEvent(pd);
  const tm = new FakeEvent('touchmove');
  el.dispatchEvent(tm);
  check('overlay pointer / touch 事件 stopPropagation', pd.propagationStopped && tm.propagationStopped);

  // 「繼續」click 內同步 emit
  const n0 = events.length;
  let syncOk = false;
  const off = bus.on('game:pause', (p) => {
    if (p.paused === false) syncOk = true;
  });
  navBtn('resume').click();
  off();
  check('「繼續」click 內同步 emit game:pause { paused:false }', syncOk && events.length === n0 + 1 && !menu.isOpen());
  check('ui:sound：繼續 = close', lastSound() === 'close', String(lastSound()));

  // 鍵盤：Esc 開關、M 地圖、地圖頁開啟 mapView
  menu.openPause();
  check('openPause() 無 tab 時 payload 不帶 tab 值', j(events.at(-1)) === j(['game:pause', { paused: true }]));
  let e = key('KeyM');
  check('暫停中 M → 地圖頁、mapView 開啟、按鍵被攔截', menu.page === 'map' && mapView.isOpen() && e.defaultPrevented);
  key('Escape');
  check('地圖頁 Esc → 回主清單、mapView 關閉', menu.page === 'root' && !mapView.isOpen() && menu.isOpen());
  e = key('KeyW');
  check('未處理的鍵不 preventDefault', !e.defaultPrevented);
  key('Escape');
  check('主清單 Esc → 繼續', !menu.isOpen() && j(events.at(-1)) === j(['game:pause', { paused: false }]));
  e = key('Escape');
  check('選單關閉時不攔截鍵盤', !e.defaultPrevented);

  // 操作說明：內容由注入資料產生
  menu.openPause('help');
  const help = el.findClass('tg-page-help');
  check('操作說明預設鍵盤分頁、內容來自 keymapHelp', help.textContent.includes('KEY-A1') && help.textContent.includes('暫停說明乙') && !help.textContent.includes('TOUCH-C3'));
  key('ArrowRight');
  check('→ 切到觸控分頁（touchHelp）', help.textContent.includes('TOUCH-C3') && !help.textContent.includes('KEY-A1'));

  // 設定：鍵盤調整與恢復預設
  navBtn('settings').click();
  check('設定頁開啟', menu.page === 'settings' && el.findClass('tg-page-settings').visible);
  key('ArrowDown');
  key('ArrowRight');
  check('鍵盤 ↓ → 滑鼠靈敏度 +0.1', vals.lookSensMouse === 1.1 && setCalls.at(-1)[0] === 'lookSensMouse');
  const out = el.findAllClass('tg-set-row').find((r) => r.dataset.item === 'lookSensMouse').findClass('tg-range-val');
  check('滑桿顯示 1.1×', out.textContent === '1.1×', out.textContent);
  key('ArrowUp');
  key('ArrowRight');
  check('畫質 → 下一段（自動 → 低）', vals.quality === 'low');
  const range = el.findAllClass('tg-range').find((r) => r.attrs['aria-label'] === '介面大小');
  range.value = '1.2';
  range.dispatchEvent(new FakeEvent('input'));
  check('滑桿 input 事件即時 settings.set', vals.uiScale === 1.2);
  const toggle = el.findAllClass('tg-set-row').find((r) => r.dataset.item === 'invertY').findClass('tg-toggle');
  const ns = sounds.length;
  toggle.click();
  check('反轉 Y 開關', vals.invertY === true && toggle.textContent === '開');
  check('ui:sound：設定開關 = click', sounds.length === ns + 1 && lastSound() === 'click', sounds.slice(ns).join(','));
  const setText = el.findClass('tg-page-settings').textContent;
  check('畫質附註保留、音效「後續版本」註記已移除', setText.includes('重新整理後完整套用') && !setText.includes('後續版本'));
  // 新設定列（§11）
  const rowOf = (k) => el.findAllClass('tg-set-row').find((r) => r.dataset.item === k);
  const order = el.findAllClass('tg-set-row').map((r) => r.dataset.item);
  check('新設定列 showBlood / recoil / aimAssist 存在（在音效之後）', ['showBlood', 'recoil', 'aimAssist'].every((k) => order.indexOf(k) > order.indexOf('volumeSfx')), order.join(','));
  check('列標題：顯示血液 / 後座力 / 瞄準輔助', rowOf('showBlood').textContent.includes('顯示血液') && rowOf('recoil').textContent.includes('後座力') && rowOf('aimAssist').textContent.includes('瞄準輔助'));
  const recoilRange = rowOf('recoil').findClass('tg-range');
  check('後座力滑桿 20%–100%、step 0.1、顯示 100%', recoilRange.min === '0.2' && recoilRange.max === '1' && recoilRange.step === '0.1' && rowOf('recoil').findClass('tg-range-val').textContent === '100%');
  recoilRange.value = '0.2';
  recoilRange.dispatchEvent(new FakeEvent('input'));
  check('後座力滑桿 input → settings.set(recoil, 0.2)、顯示 20%', vals.recoil === 0.2 && rowOf('recoil').findClass('tg-range-val').textContent === '20%');
  const bloodTg = rowOf('showBlood').findClass('tg-toggle');
  check('顯示血液預設「開」', bloodTg.textContent === '開' && bloodTg.getAttribute('aria-checked') === 'true');
  bloodTg.click();
  check('顯示血液可關閉', vals.showBlood === false && bloodTg.textContent === '關');
  check('瞄準輔助附註「只作用於觸控」', rowOf('aimAssist').textContent.includes('觸控') && rowOf('aimAssist').findClass('tg-toggle').textContent === '開');
  // 鍵盤走到 recoil 列 ← 調整
  for (let i = 0; i < 20 && !rowOf('recoil')._cls.has('tg-focus'); i++) key('ArrowDown');
  key('ArrowRight');
  check('鍵盤 → 調整後座力（0.2 → 0.3）', Math.abs(vals.recoil - 0.3) < 1e-9, String(vals.recoil));
  el.findClass('tg-reset-btn').click();
  check('恢復預設', j(vals) === j(DEF) && out.textContent === '1.0×' && toggle.textContent === '關' && bloodTg.textContent === '開' && rowOf('recoil').findClass('tg-range-val').textContent === '100%');
  // Phase 5：天氣列（自動 / 晴 / 雨 / 霧）；settings 不認得 weather 鍵 → 選單本地值 + bus weather:setting
  const wRow = rowOf('weather');
  const wBtns = wRow ? wRow.findAllClass('tg-seg-btn') : [];
  check('天氣列存在且排在最後（不改變既有列的鍵盤順序）、四段：自動 / 晴 / 雨 / 霧', !!wRow && order.at(-2) === 'weather' && j(wBtns.map((b) => b.textContent)) === j(['自動', '晴', '雨', '霧']), order.join(','));
  check('天氣預設「自動」亮起', wBtns.length === 4 && wBtns[0]._cls.has('tg-on') && !wBtns[2]._cls.has('tg-on'));
  const w0 = events.length;
  wBtns[2].click();
  const wEv = events.slice(w0).filter((e) => e[0] === 'weather:setting');
  check('點「雨」→ settings.set(weather, rain) 嘗試寫入、不支援時本地保存並 emit weather:setting { value: rain }', setCalls.at(-1)[0] === 'weather' && setCalls.at(-1)[1] === 'rain' && j(wEv) === j([['weather:setting', { value: 'rain' }]]) && wBtns[2]._cls.has('tg-on') && !wBtns[0]._cls.has('tg-on'));
  check('天氣切換音效 click、不污染 settings 值', lastSound() === 'click' && !('weather' in vals));
  el.findClass('tg-reset-btn').click();
  check('恢復預設 → 天氣回「自動」並 emit weather:setting { value: auto }', wBtns[0]._cls.has('tg-on') && j(events.at(-1)) === j(['weather:setting', { value: 'auto' }]) && j(vals) === j(DEF));

  // 回主選單
  key('Escape');
  check('設定頁 Esc → 主清單焦點留在「設定」', menu.page === 'root' && doc.activeElement === navBtn('settings'));
  for (let i = 0; i < 4; i++) key('ArrowDown');
  check('↓×4 → 焦點「回主選單」', doc.activeElement === navBtn('quit'));
  key('Enter');
  check('回主選單 → 確認框', el.findClass('tg-confirm').visible);
  key('ArrowLeft');
  saved = true;
  key('Enter');
  check('確認 → emit game:quitToMenu 並切回開始畫面（有存檔可繼續）', j(events.at(-1)) === j(['game:quitToMenu', {}]) && menu.state === 'start' && navBtn('continue'));
  check('開始畫面時 openPause 不處理', menu.openPause() === false && menu.state === 'start');
  navBtn('newGame').click();
  el.findClass('tg-confirm-yes').click();
  check('確認覆蓋 → game:start { continued:false }', j(events.at(-1)) === j(['game:start', { continued: false }]) && !menu.isOpen());

  // 觸控預設分頁
  const menu2 = createMenu({ root: body, settings, bus, keymapHelp, touchHelp, isTouch: true, attribution: ATTRIBUTION, mapView: null });
  menu2.openPause('help');
  check('isTouch → 操作說明預設觸控分頁', menu2.el.findClass('tg-page-help').textContent.includes('TOUCH-C3'));
  menu2.close();
  menu2.destroy();

  // 暫停選單「圖鑑」（onOpenGuide）
  let guideCalls = 0;
  const menu3 = createMenu({ root: body, settings, bus, keymapHelp, touchHelp, attribution: ATTRIBUTION, onOpenGuide: () => guideCalls++ });
  const nav3 = (id) => menu3.el.findAllClass('tg-nav-item').find((b) => b.dataset.item === id);
  menu3.showStart({ canContinue: false });
  check('onOpenGuide：開始畫面仍不列「圖鑑」', !nav3('guide'));
  nav3('newGame').click();
  menu3.openPause();
  const items3 = menu3.el.findAllClass('tg-nav-item').map((b) => b.dataset.item);
  check('onOpenGuide：暫停選單「圖鑑」排在地圖後', items3.indexOf('guide') === items3.indexOf('map') + 1 && nav3('guide').textContent === '圖鑑', items3.join(','));
  const g0 = events.length;
  nav3('guide').click();
  check('點「圖鑑」→ 呼叫 onOpenGuide、選單關閉、不 emit game:pause', guideCalls === 1 && !menu3.isOpen() && events.length === g0);
  check('ui:sound：圖鑑 = open', lastSound() === 'open', String(lastSound()));
  menu3.openPause();
  for (let i = 0; i < 2; i++) key('ArrowDown');
  key('Enter');
  check('鍵盤 ↓↓ Enter 也開圖鑑', guideCalls === 2 && !menu3.isOpen());
  menu3.destroy();

  // 操作說明由真 KEYMAP_HELP / TOUCH_HELP 產生：Phase 4 新動作有出現
  const A = await import('../../src/core/actions.js');
  const menu4 = createMenu({ root: body, settings, bus, keymapHelp: A.KEYMAP_HELP, touchHelp: A.TOUCH_HELP, isTouch: false, attribution: ATTRIBUTION });
  menu4.openPause('help');
  const h4 = menu4.el.findClass('tg-page-help');
  const kbText = h4.textContent;
  key('ArrowRight');
  const tText = h4.textContent;
  check('操作說明（鍵盤）含互動 E / 武器 Q / 裝填 R / 瞄準', ['互動', '循環切換武器', '裝填', '肩後瞄準', '大地圖'].every((w) => kbText.includes(w)));
  check('操作說明（觸控）含「互動」鈕 / 「武器」鈕', tText.includes('「互動」鈕') && tText.includes('「武器」鈕'));
  menu4.close();
  menu4.destroy();
  check('ui:sound kind 全在契約列舉內', sounds.length > 0 && sounds.every((k) => ['click', 'confirm', 'cancel', 'reward', 'fail', 'open', 'close'].includes(k)), [...new Set(sounds)].join(','));

  const kd = win.listenerCount('keydown');
  menu.destroy();
  check('destroy 移除 DOM 與鍵盤監聽', !body.children.includes(el) && win.listenerCount('keydown') === kd - 1 && subs.length === 0);
}

// ======================= menu.css 規範 =======================
{
  const ROOT = fileURLToPath(new URL('../../', import.meta.url));
  const css = readFileSync(`${ROOT}src/ui/menu.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const z = [...css.matchAll(/z-index:\s*(\d+)/g)].map((m) => +m[1]);
  check('z-index 皆在 70–79', z.length > 0 && z.every((v) => v >= 70 && v <= 79), z.join(','));
  const sels = [...css.matchAll(/([^{}@]+)\{/g)].map((m) => m[1]).filter((s) => !/^\s*(from|to|\d)/.test(s));
  const tokens = sels.join(' ').match(/[.#][A-Za-z_][\w-]*/g) || [];
  check('CSS class / id 皆 tg- 前綴', tokens.every((t) => t.startsWith('.tg-') || t.startsWith('#tg-')), tokens.filter((t) => !/^[.#]tg-/.test(t)).join(','));
  check('安全區 padding（四邊 env(safe-area-inset-*)）', ['top', 'right', 'bottom', 'left'].every((s) => css.includes(`env(safe-area-inset-${s})`)));
  check('直向版面（orientation: portrait）', /@media\s*\(orientation:\s*portrait\)/.test(css));
  check('按鈕 ≥ 44px', /\.tg-btn\s*\{[^}]*min-height:\s*44px/.test(css));
  check('內容標示樣式：字級 ≥ 13px（clamp）、暫停模式隱藏', /\.tg-menu-notice\s*\{[^}]*font-size:\s*calc\(clamp\(13px/.test(css) && /\.tg-menu\[data-mode='pause'\] \.tg-menu-notice[^{]*\{[^}]*display:\s*none/.test(css));
  const thumbs = [...css.matchAll(/range-thumb\s*\{[^}]*width:\s*(\d+)px/g), ...css.matchAll(/slider-thumb\s*\{[^}]*width:\s*(\d+)px/g)].map((m) => +m[1]);
  check('滑桿 thumb ≥ 28px', thumbs.length >= 2 && thumbs.every((w) => w >= 28), thumbs.join(','));
  check('讀 --tg-ui-scale、字級 clamp()', css.includes('var(--tg-ui-scale') && /clamp\(/.test(css));

  // 實測修正：844×390 暫停選單「回主選單」超出畫面、直向「全螢幕 / 回主選單」在分頁列外看不到
  const rules = [];
  (function parse(src, media) {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf('{', i);
      if (open < 0) break;
      const prelude = src.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < src.length && depth > 0) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
        j++;
      }
      const inner = src.slice(open + 1, j - 1);
      if (/^@(media|supports)/.test(prelude)) parse(inner, `${media} ${prelude}`.trim());
      else if (!prelude.startsWith('@')) {
        const decl = {};
        for (const d of inner.split(';')) {
          const k = d.indexOf(':');
          if (k > 0) decl[d.slice(0, k).trim()] = d.slice(k + 1).trim();
        }
        rules.push({ sels: prelude.split(',').map((x) => x.trim()), media, decl });
      }
      i = j;
    }
  })(css, '');
  const find = (sel, mediaRe) => rules.filter((r) => r.sels.includes(sel) && (mediaRe ? mediaRe.test(r.media) : !r.media)).reduce((a, r) => Object.assign(a, r.decl), {});
  const NAV = ".tg-menu[data-mode='pause'] .tg-menu-nav";
  check('橫向左欄可垂直捲動（overflow-y: auto、min-height: 0）', find('.tg-menu-nav')['overflow-y'] === 'auto' && find('.tg-menu-nav')['min-height'] === '0');
  const short = /max-height:\s*460px/;
  const shortItem = find(".tg-menu[data-mode='pause'] .tg-nav-item", short);
  check('矮螢幕（≤ 460px 高）暫停選單縮小行高 / 間距 / 標頭', /^4px/.test(shortItem.padding || '') && find('.tg-menu-nav', short).gap === '4px' && /18px/.test(find('.tg-menu-pausetitle', short)['font-size'] || ''), JSON.stringify(shortItem));
  const vHint = find(`${NAV}::after`, /max-height:\s*430px\)\s*and\s*\(orientation:\s*landscape/);
  check('矮螢幕橫向左欄有底緣黏著的捲動提示（sticky bottom、不吃指標）', vHint.position === 'sticky' && vHint.bottom === '0' && vHint['pointer-events'] === 'none' && !!vHint.content);
  const portNav = find(NAV, /orientation:\s*portrait/);
  check('直向分頁列可水平捲動（overflow-x: auto、pan-x）', portNav['overflow-x'] === 'auto' && portNav['touch-action'] === 'pan-x' && portNav['flex-direction'] === 'row');
  const hHint = rules.find((r) => r.sels.includes(`${NAV}::after`) && /^@media \(orientation: portrait\)$/.test(r.media));
  check('直向分頁列有右緣黏著的捲動提示（sticky right、不吃指標）', !!hHint && hHint.decl.position === 'sticky' && hHint.decl.right === '0' && hHint.decl['pointer-events'] === 'none' && /›/.test(hHint.decl.content || ''));
  const sup = find(`${NAV}::after`, /@supports \(animation-timeline: scroll\(\)\)$/);
  check('支援捲動時間軸：沒溢出不顯示、捲到底淡出', sup.opacity === '0' && /scroll\(nearest block\)/.test(sup['animation-timeline'] || '') && /@keyframes tg-scroll-hint/.test(css));
  check('直向分頁項目不換行、仍 ≥ 44px（tg-btn）', find(".tg-menu[data-mode='pause'] .tg-nav-item", /orientation:\s*portrait/)['white-space'] === 'nowrap' && find('.tg-btn')['min-height'] === '44px');
}

const total = passed + failed;
console.log(failed ? `FAIL ${failed}/${total}` : `PASS ${passed}/${total}`);
process.exit(failed ? 1 : 0);
