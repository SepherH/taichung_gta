#!/usr/bin/env node
// Phase 6 F6 實測修正回歸（docs/dev/interfaces.md §23.3、§23.4、§24；§20 時間步）
// 用法：node tools/test/p6-f6.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）；不需要 node_modules（three 只在選用段，缺 → SKIP 不計分）
// 項目（實測回報 → 以真模組重現；版面推算見 tools/test/attribution.mjs 的 F6 段）：
//   1. 手機「設定」App：真 createPhone + createPhoneLink + 真 createMenu，onOpenSettings 由 main.js 原始碼抽出執行、game:pause 接 pauseGame 同款處理
//      → 手機關、暫停選單開在設定頁且可見、之後幾幀（暫停中只跑 syncPhone / frame）選單不被關掉、輸入維持停用
//   2. 任務 App「導航」：真 createJobs.listings → 手機列表 → 點「導航」→ onNavigate（main.js 原始碼抽出）→ 導航器 destination() = 接單點；
//      選用段（有 three）：真 createNavigator + 真路網，站在出生點（距泊車亭約 40 m）導航後跑幾幀仍在；20 m 內 = 抵達清除（預期行為）
//   3. 開手機先鎖屏：main.js 的 openPhone → phoneLink.open() → phone.open() 無參數 → locked；鎖屏只吃渲染 dt（0.8 s），e.timeStamp 與 now 同時基
//   4. 觸控極短點擊：pointerdown 當下鎖存 pressed（input.touchPress / onTap），同幀放開不漏；endFrame 才清
//   5. 代客泊車停妥判定 / 結算：停妥 1 s（simDt）才入帳、角度 / 距離 / 速度門檻、上車前（entering，ctx.vehicle null）不計、結算損壞比在 endRun 前讀
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

const HOOK = `
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default "";' };
  if (url.endsWith('.json')) return { format: 'module', shortCircuit: true, source: 'export default ' + readFileSync(fileURLToPath(url), 'utf8') + ';' };
  return next(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(HOOK)}`, import.meta.url);

let pass = 0;
let fail = 0;
function check(name, cond, info = '') {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info && !cond ? `  — ${info}` : ''}`);
}
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const mainSrc = read('src/main.js');

// ---------- 最小 DOM 替身（click 沿 parentNode 冒泡；停用按鈕不觸發，同真 DOM）----------
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
    this.disabled = false;
    this._text = '';
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
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
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
    return new Proxy({}, { get: (_, k) => (k === 'measureText' ? () => ({ width: 10 }) : () => {}), set: () => true });
  }
  setPointerCapture() {}
  focus() {}
  scrollIntoView() {}
  querySelector() {
    return null;
  }
  click() {
    if (this.tagName === 'BUTTON' && this.disabled) return;
    const e = new FakeEvent('click');
    for (let n = this; n && !e.propagationStopped; n = n.parentNode) n.dispatchEvent(e);
  }
  *walk() {
    for (const c of this.children) {
      if (typeof c === 'string') continue;
      yield c;
      yield* c.walk();
    }
  }
  findClass(c) {
    for (const e of this.walk()) if (e._cls.has(c)) return e;
    return null;
  }
  findAllClass(c) {
    return [...this.walk()].filter((e) => e._cls.has(c));
  }
  get visible() {
    for (let e = this; e; e = e.parentNode) if (e.hidden) return false;
    return true;
  }
}
const doc = Object.assign(new Listeners(), { createElement: (t) => new FakeEl(t), documentElement: new FakeEl('html'), fullscreenEnabled: false, fullscreenElement: null });
const win = new Listeners();
globalThis.document = doc;
globalThis.window = win;
const key = (target, code, extra = {}) => {
  const e = new FakeEvent('keydown', { code, timeStamp: performance.now(), ...extra });
  target.dispatchEvent(e);
  return e;
};

// main.js 的 createPhone({ ... }) 參數段裡的一個 callback 原始碼（箭頭函式本體），以注入的名稱執行
function mainCallback(name) {
  const at = mainSrc.indexOf('const phone = createPhone({');
  const seg = mainSrc.slice(at, mainSrc.indexOf('\n  });', at));
  const m = new RegExp(`\\n    ${name}: (\\([^)]*\\) => (?:\\{[\\s\\S]*?\\n    \\}|[^\\n]*?)),?(?:\\n|$)`).exec(seg);
  return m ? m[1].replace(/,$/, '') : null;
}

const { createPhone, LOCK_SEC } = await import('../../src/ui/phone.js');
const { canOpenPhone, createPhoneLink } = await import('../../src/ui/phone-link.js');
const { createMenu } = await import('../../src/ui/menu.js');
const { createJobs, isParked, VALET_PARKING, valetReward } = await import('../../src/missions/jobs.js');
const JP = await import('../../src/job-props.js');

// 共用：依 main.js 接線組出 phone / phoneLink / menu / 假世界（暫停 = pauseGame 同款：phoneLink.reset、input 停用）
function rig({ nav = null, focus = { x: 0, z: 0 }, listings = null } = {}) {
  const body = new FakeEl('body');
  const keys = new Listeners(); // 每組手機自己的 keydown 目標（多組同時開著時互不吞鍵）
  const handlers = {};
  const bus = {
    emit: (n, p) => (handlers[n] || []).slice().forEach((f) => f(p)),
    on: (n, f) => ((handlers[n] ||= []).push(f), () => {}),
  };
  const state = { started: true, paused: false };
  const input = { enabled: true };
  const settingsVals = {};
  const settings = { get: (k) => settingsVals[k], set: (k, v) => ((settingsVals[k] = v), true), subscribe: () => () => {}, getAll: () => ({ ...settingsVals }), reset: () => {} };
  const menu = createMenu({ root: body, settings, bus, keymapHelp: [], touchHelp: [], isTouch: false, attribution: '© OSM', getStats: () => ({}), getMoney: () => 0, hasSave: () => true, mapView: null });
  let panel = false;
  const bigMap = { open: () => (panel = true), isOpen: () => panel };
  const syncPanels = () => panel;
  let phone = null;
  let phoneLink = null;
  const syncPhone = () => phoneLink.sync();
  const mk = (name, args, deps) => {
    const src = mainCallback(name);
    if (!src) return null;
    return Function(...Object.keys(deps), `return ${src};`)(...Object.values(deps));
  };
  const deps = { phone: { close: () => phone.close() }, menu, bigMap, syncPanels, syncPhone, nav, focus };
  phone = createPhone({
    root: body,
    bus,
    doc,
    keyTarget: keys,
    onOpenMap: mk('onOpenMap', '', deps),
    onOpenSettings: mk('onOpenSettings', '', deps),
    onNavigate: mk('onNavigate', 'it', deps),
  });
  const jobsBuf = [];
  phoneLink = createPhoneLink({
    phone,
    input,
    canOpen: () => canOpenPhone({ started: state.started, paused: state.paused, panelOpen: panel, menuOpen: menu.isOpen(), blocked: false }),
    canResume: () => state.started && !state.paused && !panel && !menu.isOpen(),
    fillData: (d) => {
      d.hour = 19.5;
      d.weatherIcon = 'sun';
      d.money = 100;
      d.jobs = listings ? listings(focus, jobsBuf) : [];
    },
  });
  bus.on('game:pause', ({ paused } = {}) => {
    if (paused) {
      if (state.paused) return;
      state.paused = true;
      phoneLink.reset();
      input.enabled = false;
    } else {
      state.paused = false;
      input.enabled = true;
    }
  });
  // 一幀：loop.js updateWorld 暫停時不呼叫 updateGame；updateGame 開頭 syncPhone、結尾 phoneLink.frame(dt)
  const frame = (dt = 1 / 60) => {
    if (state.paused) return;
    syncPhone();
    if (syncPanels()) return;
    phoneLink.frame(dt);
  };
  return { body, keys, bus, state, input, menu, phone, phoneLink, frame, deps };
}

// ======================= 1. 手機「設定」App =======================
{
  const src = mainCallback('onOpenSettings');
  check('main.js onOpenSettings 抽得出（phone.close → menu.openPause(\'settings\') → syncPhone）', !!src && /phone\.close\(\);[\s\S]*menu\.openPause\('settings'\);[\s\S]*syncPhone\(\);/.test(src), String(src));
  const R = rig();
  check('開手機（T / tb-phone → phoneLink.open）', R.phoneLink.open() === true && R.phone.isOpen() && R.input.enabled === false);
  for (let i = 0; i < 60; i++) R.frame(1 / 60); // 1 s：鎖屏自動解鎖
  check('1 s 後鎖屏已解、在首頁', R.phone.app === 'home');
  R.phone.element.findClass('ph-app-settings').click();
  check('點「設定」：手機關閉', !R.phone.isOpen());
  check('點「設定」：暫停選單開啟、狀態 pause、頁 = settings', R.menu.isOpen() && R.menu.state === 'pause' && R.menu.page === 'settings', `${R.menu.state} / ${R.menu.page}`);
  const page = R.menu.el.findClass('tg-page-settings');
  check('設定頁 DOM 可見（選單根與設定頁皆未 hidden）', !!page && page.visible && !R.menu.el.hidden);
  check('暫停中：state.paused、輸入停用（不被手機 sync 還原）', R.state.paused && R.input.enabled === false);
  for (let i = 0; i < 30; i++) R.frame(1 / 60);
  check('之後 30 幀：選單仍開在設定頁、手機仍關、輸入仍停用', R.menu.isOpen() && R.menu.page === 'settings' && !R.phone.isOpen() && R.input.enabled === false);
  // 鎖屏中直接點（JS 對隱藏按鈕 click）也走同一路徑
  const R2 = rig();
  R2.phoneLink.open();
  R2.phone.element.findClass('ph-app-settings').click();
  check('鎖屏中對（隱藏的）設定鈕 click：同樣進設定頁', !R2.phone.isOpen() && R2.menu.page === 'settings' && R2.state.paused);
  // 選單「繼續」→ 恢復輸入；手機不自動再開
  R.menu.close();
  R.frame(1 / 60);
  check('選單關閉（繼續）→ 輸入恢復、手機維持關閉', R.input.enabled === true && !R.phone.isOpen() && !R.state.paused);
}

// ======================= 2. 任務 App「導航」 =======================
{
  const src = mainCallback('onNavigate');
  check('main.js onNavigate = nav.setDestination(it.x, it.z, it.title, \'phone\', focus)', !!src && /nav\.setDestination\(it\.x, it\.z, it\.title, 'phone', focus\)/.test(src), String(src));
  const valet = JP.valetSpots(JP.VALET_SITES, () => 0);
  const mkJobs = () => {
    const j = createJobs({
      now: () => 0, rng: () => 0.5, getGameHour: () => 19,
      spots: { stall: { x: 557, z: -127, yaw: 1 }, stallBack: { x: 557.4, z: -128.2 }, sidewalkNear: () => ({ x: 600, z: -100 }), valet },
      spawnValetCar: () => ({ pos: { x: 0, z: 0 } }), releaseValetCar: () => {},
    });
    j.update(1 / 60, { x: 0, z: 0, driving: false, vehicle: null });
    return j;
  };
  // 假導航器（同 navigation.js applyDest：非有限座標拒收）
  let dest = null;
  const fakeNav = {
    setDestination: (x, z, label, source) => (Number.isFinite(x) && Number.isFinite(z) ? ((dest = { x, z, label, source }), true) : false),
    destination: () => dest,
  };
  const jobs = mkJobs();
  const focus = { x: 0, z: 0 };
  const R = rig({ nav: fakeNav, focus, listings: (pos, out) => ((out.length = 0), jobs.listings(pos, out)) });
  R.phoneLink.open();
  for (let i = 0; i < 60; i++) R.frame(1 / 60);
  R.phone.element.findClass('ph-app-jobs').click();
  R.phone.setTab('job');
  for (let i = 0; i < 40; i++) R.frame(1 / 60); // 列表 0.5 s 刷新
  const rows = R.phone.element.findAllClass('ph-row').filter((r) => r.visible);
  const row = rows.find((r) => /代客泊車/.test(r.textContent));
  const go = row && row.findClass('ph-go');
  check('打工分頁有「代客泊車」列、導航鈕可按', !!go && !go.disabled, rows.map((r) => r.textContent).join(' | '));
  if (go) go.click();
  const d = fakeNav.destination();
  check('點「導航」→ destination = 泊車亭接單點、source phone', !!d && Math.abs(d.x - valet[0].standX) < 1e-6 && Math.abs(d.z - valet[0].standZ) < 1e-6 && d.source === 'phone', JSON.stringify(d));
  check('導航後手機不關、輸入維持鎖定', R.phone.isOpen() && R.input.enabled === false);

  let THREE = null;
  try {
    THREE = await import('three');
  } catch {
    console.log('SKIP  真 createNavigator 段（找不到 three）');
  }
  if (THREE) {
    const { buildRoadGraph, createNavigator, ARRIVE_M } = await import('../../src/navigation.js');
    const { surfaceRoads } = await import('../../src/citymodel.js');
    const graph = buildRoadGraph(surfaceRoads);
    const s = valet[0];
    const run = (px, pz) => {
      const nav = createNavigator({ bus: null, graph });
      const at = { x: px, z: pz };
      const jb = mkJobs();
      const R3 = rig({ nav, focus: at, listings: (pos, out) => ((out.length = 0), jb.listings(pos, out)) });
      R3.phoneLink.open();
      for (let i = 0; i < 60; i++) R3.frame(1 / 60);
      R3.phone.element.findClass('ph-app-jobs').click();
      R3.phone.setTab('job');
      R3.frame(0.6);
      const g = R3.phone.element.findAllClass('ph-row').filter((r) => r.visible).find((r) => /代客泊車/.test(r.textContent));
      if (g) g.findClass('ph-go').click();
      const before = nav.destination();
      for (let i = 0; i < 10; i++) nav.update(1 / 60, at); // main.js：nav.update(dt, focus) 每幀
      return { before, after: nav.destination() };
    };
    // 出生點附近（離亭約 40 m，§24.2）：沿亭 → 客人車方向外推 40 m
    const far = run(s.standX - 40, s.standZ);
    check('真導航器：40 m 外點導航 → destination 非 null、跑 10 幀仍在', !!far.before && !!far.after, JSON.stringify(far));
    const near = run(s.standX + ARRIVE_M * 0.5, s.standZ);
    check(`真導航器：${ARRIVE_M} m 內點導航 → 下一幀即「抵達」清除（navigation.js ARRIVE_M，預期行為）`, !!near.before && near.after === null, JSON.stringify(near));
  }
}

// ======================= 3. 開手機先鎖屏 =======================
{
  check('main.js：openPhone = () => phoneLink.open()（不帶 App）', /const openPhone = \(\) => phoneLink\.open\(\);/.test(mainSrc));
  check('main.js：T 與 tb-phone 都走 openPhone()', /input\.actions\.pressed\('phone'\) && openPhone\(\)/.test(mainSrc) && /id: 'tb-phone'[^\n]*onTap: \(\) => openPhone\(\)/.test(mainSrc));
  const linkSrc = read('src/ui/phone-link.js');
  check('phone-link.js open()：phone.open() 無參數', /\n    phone\.open\(\);\n/.test(linkSrc));
  const R = rig();
  R.phoneLink.open();
  check('open() → 鎖屏（locked、app = lock、ph-lock 可見、首頁隱藏）', R.phone.locked && R.phone.app === 'lock' && R.phone.element.findClass('ph-lock').visible && !R.phone.element.findClass('ph-home').visible);
  R.frame(0.5);
  check('渲染 0.5 s：仍鎖屏', R.phone.locked);
  R.frame(LOCK_SEC - 0.5 + 0.01);
  check(`渲染累計 ≥ ${LOCK_SEC} s：自動解鎖到首頁`, !R.phone.locked && R.phone.app === 'home');
  // 背景分頁（rAF 不跑）：沒有幀 → 一直鎖屏；stepFrames(60) 推 1 s → 已解鎖（實測看到首頁的成因之一）
  const R2 = rig();
  R2.phoneLink.open();
  check('沒有幀推進：維持鎖屏（鎖屏不看牆鐘 now）', R2.phone.locked);
  for (let i = 0; i < 60; i++) R2.frame(1 / 60);
  check('推 60 幀 × 1/60：已解鎖（截圖前推幀 ≥ 0.8 s 就看不到鎖屏）', !R2.phone.locked);
  // 時基：now() 預設 performance.now()，與 KeyboardEvent.timeStamp（DOMHighResTimeStamp）同時基；開啟後的新按鍵不被當成「開啟那一下」
  const phoneSrc = read('src/ui/phone.js');
  check('phone.js now 預設 = performance.now（同 e.timeStamp 時基）', /now = \(\) => \(globalThis\.performance && performance\.now \? performance\.now\(\) : Date\.now\(\)\)/.test(phoneSrc));
  const R3 = rig();
  R3.phoneLink.open();
  const e = key(R3.keys, 'Escape');
  check('開啟後新的 Esc（timeStamp > openedAt）→ 鎖屏按返回 = 關閉', !R3.phone.isOpen() && e.propagationStopped);
  const R4 = rig();
  const t0 = performance.now();
  R4.phoneLink.open();
  const e2 = key(R4.keys, 'Escape', { timeStamp: t0 - 1 });
  check('開啟同一個按鍵事件（timeStamp ≤ openedAt）不處理：手機仍開、仍鎖屏', R4.phone.isOpen() && R4.phone.locked && !e2.propagationStopped);
}

// ======================= 4. 觸控極短點擊（事件層鎖存） =======================
{
  const touchSrc = read('src/touch.js');
  const inputSrc = read('src/input.js');
  const down = /el\.addEventListener\('pointerdown', \(e\) => \{([\s\S]*?)\n  \}\);/.exec(touchSrc);
  check('touch.js 按鈕 pointerdown 當下：onTap 回呼或 input.touchPress（不靠逐幀取樣）', !!down && /def\.onTap\(ui\.input\)/.test(down[1]) && /ui\.input\.touchPress\(def\.code, def\.mode === 'hold'\)/.test(down[1]));
  check('tb-view = tap 虛擬 KeyV、tb-phone 由 main.js 以 onTap 開手機', /id: 'tb-view'[^\n]*code: 'KeyV', mode: 'tap'/.test(touchSrc) && /id: 'tb-phone'[^\n]*onTap: \(\) => openPhone\(\)/.test(mainSrc));
  // 以 input.js 的 touchPress / touchRelease / endFrame 原始碼建出最小 Input（不 import input.js：其依賴 window / mobile）
  const method = (name) => new RegExp(`\\n  ${name}\\(([^)]*)\\) \\{([\\s\\S]*?)\\n  \\}`).exec(inputSrc);
  const tp = method('touchPress');
  const tr = method('touchRelease');
  const ef = method('endFrame');
  check('input.js touchPress / touchRelease / endFrame 抽得出', !!tp && !!tr && !!ef);
  if (tp && tr && ef) {
    const inp = { _enabled: true, pressed: new Set(), touchHolds: new Map(), _syncKeys() {}, onFrame: null };
    inp.touchPress = Function(...tp[1].split(',').map((s) => s.trim()), tp[2]);
    inp.touchRelease = Function(...tr[1].split(',').map((s) => s.trim()).filter(Boolean), tr[2]);
    inp.endFrame = Function(ef[2]);
    // 同一幀之間按下又放開（tap 不呼叫 touchRelease；hold 才會）
    inp.touchPress('KeyV', false);
    check('tap：按下即 pressed（放開在下一幀前也不漏）', inp.pressed.has('KeyV'));
    inp.touchPress('KeyF', true);
    inp.touchRelease('KeyF');
    check('hold：同幀按下又放開 → pressed 仍在（down 已放）', inp.pressed.has('KeyF') && !inp.touchHolds.has('KeyF'));
    inp.endFrame();
    check('endFrame（loop.js 每 tick 最後）才清 pressed', inp.pressed.size === 0);
  }
  check('loop.js tick：updateWorld（含 updateGame 讀 pressed）在 endFrame 之前', /updateWorld\(dt\);[\s\S]*?d\.endFrame\(\);/.test(read('src/core/loop.js')));
}

// ======================= 5. 代客泊車停妥判定與結算 =======================
{
  const slot = { slotX: 10, slotZ: 20, slotYaw: 2.61 };
  check('isParked：車格中心、角度一致、靜止 → 真', isParked({ x: 10, z: 20, yaw: 2.61, speed: 0 }, slot, true));
  check('isParked：距離 1.3 m（> 1.2）→ 假', !isParked({ x: 11.3, z: 20, yaw: 2.61, speed: 0 }, slot, true));
  check('isParked：角度 16°→ 假、14° → 真；跨 ±π 包角正確', !isParked({ x: 10, z: 20, yaw: 2.61 + (16 * Math.PI) / 180, speed: 0 }, slot, true) && isParked({ x: 10, z: 20, yaw: 2.61 + (14 * Math.PI) / 180, speed: 0 }, slot, true) && isParked({ x: 10, z: 20, yaw: 2.61 - 2 * Math.PI, speed: 0 }, slot, true));
  check('isParked：速度 0.6 m/s → 假、不在車上 → 假', !isParked({ x: 10, z: 20, yaw: 2.61, speed: 0.6 }, slot, true) && !isParked({ x: 10, z: 20, yaw: 2.61, speed: 0 }, slot, false));

  const valet = JP.valetSpots(JP.VALET_SITES, () => 0);
  const s = valet[0];
  const money = [];
  const released = [];
  const evs = [];
  let hp = 1000;
  const car = { pos: { x: s.carX, z: s.carZ }, yaw: s.carYaw, speed: 0 };
  const jobs = createJobs({
    bus: { emit: (n, p) => evs.push([n, p]) },
    now: () => 0, rng: () => 0.5, addMoney: (n, r) => money.push([n, r]), getGameHour: () => 12,
    spots: { stall: { x: 557, z: -127, yaw: 1 }, stallBack: { x: 557.4, z: -128.2 }, sidewalkNear: () => null, valet },
    spawnValetCar: () => car, releaseValetCar: (v) => released.push(v), healthOf: () => hp,
  });
  const ctx = { x: s.standX, z: s.standZ, driving: false, vehicle: null };
  jobs.update(1 / 60, ctx);
  const it = jobs.nearest({ x: s.standX, z: s.standZ });
  if (it) it.act();
  check('接單 → 進行中、stage car', jobs.isEngaged() && jobs.active() && jobs.active().stage === 'car', JSON.stringify(jobs.active()));
  // entering：玩家已在車旁、上車動畫中 ctx.vehicle 仍 null → 不算停妥（即使把車移到車格）
  car.pos.x = s.slotX;
  car.pos.z = s.slotZ;
  car.yaw = s.slotYaw;
  for (let i = 0; i < 90; i++) {
    ctx.x = s.slotX + 1;
    ctx.z = s.slotZ;
    jobs.update(1 / 60, ctx);
  }
  check('entering（ctx.vehicle null）1.5 s：不入帳、stage 仍 car', money.length === 0 && jobs.active().stage === 'car');
  ctx.driving = true;
  ctx.vehicle = car;
  jobs.update(1 / 60, ctx);
  check('進 drive（ctx.vehicle === 指定車）→ stage park、nav:destination 車格', jobs.active().stage === 'park' && evs.some(([n, p]) => n === 'nav:destination' && p.source === 'job' && p.x === s.slotX));
  hp = 800; // 損壞比 0.2
  for (let i = 0; i < 30; i++) jobs.update(1 / 60, ctx);
  check('停妥 0.5 s：尚未入帳', money.length === 0);
  car.speed = 0.6;
  jobs.update(1 / 60, ctx);
  car.speed = 0;
  for (let i = 0; i < 50; i++) jobs.update(1 / 60, ctx);
  check('中途超速一幀 → 維持計時歸零（再 0.83 s 仍未入帳）', money.length === 0);
  for (let i = 0; i < 12; i++) jobs.update(1 / 60, ctx);
  const done = evs.find(([n]) => n === 'job:complete');
  check('停妥滿 1 s → 入帳一次 reason job、job:complete、releaseValetCar(指定車)', money.length === 1 && money[0][1] === 'job' && !!done && released.length === 1 && released[0] === car, JSON.stringify(money));
  if (done) {
    const p = done[1];
    const expect = valetReward(0.2, p.leftSec, VALET_PARKING);
    check('結算 = 300 × (1 − 0.2 × 0.7) + 剩餘秒 × 2（損壞比在 endRun 前讀）', Math.abs(money[0][0] - expect) <= 2 && p.damagePct === 20, `${money[0][0]} vs ${expect} dmg ${p.damagePct}`);
  }
  for (let i = 0; i < 120; i++) jobs.update(1 / 60, ctx);
  check('結算後不重複入帳、打工已結束', money.length === 1 && !jobs.isEngaged());
  // simDt = 0（暫停 / 無子步）不推進停妥計時
  const j2 = createJobs({
    now: () => 0, rng: () => 0.5, addMoney: (n, r) => money.push([n, r]), getGameHour: () => 12,
    spots: { stall: { x: 557, z: -127, yaw: 1 }, stallBack: { x: 557.4, z: -128.2 }, sidewalkNear: () => null, valet },
    spawnValetCar: () => car, releaseValetCar: () => {}, healthOf: () => 1000,
  });
  const c2 = { x: s.standX, z: s.standZ, driving: false, vehicle: null };
  j2.update(1 / 60, c2);
  const it2 = j2.nearest({ x: s.standX, z: s.standZ });
  if (it2) it2.act();
  Object.assign(c2, { x: s.slotX, z: s.slotZ, driving: true, vehicle: car });
  for (let i = 0; i < 200; i++) j2.update(0, c2);
  check('simDt = 0 × 200 幀：停妥不入帳（§20）', money.length === 1 && j2.isEngaged());
}

console.log(fail ? `FAIL ${fail}/${pass + fail}` : `PASS ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
