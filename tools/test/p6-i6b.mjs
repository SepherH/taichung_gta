#!/usr/bin/env node
// Phase 6 I6b 接線回歸：遊戲內手機（docs/dev/interfaces.md §23.3、§20 時間步）
// 用法：node tools/test/p6-i6b.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）；不需要 node_modules
// 項目：
//   1. canOpenPhone 互斥表（開始前 / 暫停 / 全螢幕面板 / 選單 / 直向遮罩 → 不開）
//   2. createPhoneLink + 真 createPhone（假 DOM）：開啟鎖輸入（input.enabled = false、onLock 一次）、Esc / T / 返回關閉後下一次 sync 才還原、
//      暫停 / 面板開著不還原、toggle / reset、frame 只在開啟時注入資料（listings 陣列重用）、地圖 / 設定 App 的關閉順序
//   3. main.js 接線（原始碼檢查）：phone 不列入 panelOpen、updateGame 先 syncPhone、T = actions.pressed('phone')、onOpenMap / onOpenSettings / onNavigate、
//      setData 來源、phoneLink.frame(dt)（渲染 dt）、pauseGame / closePanels 收手機、syncPanels 開面板先關手機、手機開著駕駛維持手煞、HUD 提示含手機
//   4. 觸控：SLOTS 含 tl4、tb-phone 預設 tl4 隱藏、main.js 以 onTap 重新註冊；style.css 解析後推算各尺寸（直 / 橫 × 步行 / 駕駛）按鈕矩形不重疊、
//      直向駕駛 tb-view / 換台鈕不進左半轉向區、手機鈕不壓喇叭
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

const HOOK = `
export async function load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default "";' };
  return next(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(HOOK)}`, import.meta.url);

let pass = 0;
let fail = 0;
function check(name, cond, info = '') {
  if (cond) pass++;
  else {
    fail++;
    console.log(`FAIL ${name}${info ? ' — ' + info : ''}`);
  }
}
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

// ---------- 最小 DOM 替身 ----------
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
let created = 0;
class FakeEl extends Listeners {
  constructor(tag) {
    super();
    created++;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this._cls = new Set();
    this.dataset = {};
    this.attrs = {};
    this.hidden = false;
    this.disabled = false;
    this._text = '';
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
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this.children.forEach((c) => (c.parentNode = null));
    this.children = [];
    this._text = String(v);
  }
  appendChild(c) {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
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
  // 真 DOM：停用的按鈕不觸發 click
  click() {
    if (this.tagName === 'BUTTON' && this.disabled) return;
    const e = new FakeEvent('click');
    for (let n = this; n && !e.propagationStopped; n = n.parentNode) n.dispatchEvent(e);
  }
  *walk() {
    for (const c of this.children) {
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
const doc = { createElement: (t) => new FakeEl(t) };
const win = new Listeners();
const key = (code, extra = {}) => {
  const e = new FakeEvent('keydown', { code, ...extra });
  win.dispatchEvent(e);
  return e;
};


const { createPhone, formatClock } = await import('../../src/ui/phone.js');
const { canOpenPhone, createPhoneLink } = await import('../../src/ui/phone-link.js');

// ======================= 1. 互斥表 =======================
{
  const ok = { started: true, paused: false, panelOpen: false, menuOpen: false, blocked: false };
  check('canOpenPhone：遊戲中、無面板 / 選單 → 可開', canOpenPhone(ok) === true);
  for (const k of ['paused', 'panelOpen', 'menuOpen', 'blocked']) check(`canOpenPhone：${k} → 不開`, canOpenPhone({ ...ok, [k]: true }) === false);
  check('canOpenPhone：未開始 → 不開', canOpenPhone({ ...ok, started: false }) === false);
  check('canOpenPhone：null → 不開', canOpenPhone(null) === false);
}

// ======================= 2. createPhoneLink + 真 createPhone =======================
{
  const root = new FakeEl('div');
  const events = [];
  const bus = { emit: (n, p) => events.push(n) };
  const calls = { map: 0, settings: 0, nav: [] };
  const world = { started: true, paused: false, panel: false, menu: false, blocked: false };
  const input = { enabled: true };
  let locks = 0;
  let fills = 0;
  const listBuf = [];
  const JOBS = [
    { id: 'm1', title: '送便當', category: 'mission', reward: 500, distanceM: 820, navigable: true, x: 10, z: 20, active: false },
    { id: 'garbage', title: '垃圾車', category: 'nearby', reward: 200, distanceM: 150, navigable: true, x: 1, z: 2, active: false },
    { id: 'night-market-run', title: '夜市跑單', category: 'job', reward: 260, distanceM: 90, navigable: true, x: 7, z: 8, active: false },
    { id: 'valet-parking', title: '代客泊車', category: 'job', reward: 300, distanceM: 2400, navigable: false, x: 9, z: 9, active: false },
  ];
  const listings = (pos, out) => {
    out.length = 0;
    for (const j of JOBS) out.push(j);
    return out;
  };
  const focus = { x: 3, z: 4 };
  const env = { hour: 13.5, icon: 'rain', money: 4321 };
  let phone = null;
  let link = null;
  const syncPhone = () => link.sync();
  // 同 main.js：地圖 App = 關手機 → 開大地圖 → syncPanels（鎖輸入）→ syncPhone；設定 App = 關手機 → openPause（pauseGame 鎖輸入）→ syncPhone
  phone = createPhone({
    root, bus, doc, keyTarget: win,
    onOpenMap: () => {
      phone.close();
      world.panel = true;
      calls.map++;
      input.enabled = false; // syncPanels 開面板
      syncPhone();
    },
    onOpenSettings: () => {
      phone.close();
      world.paused = true;
      world.menu = true;
      calls.settings++;
      input.enabled = false; // pauseGame
      link.reset();
      syncPhone();
    },
    onNavigate: (it) => calls.nav.push([it.x, it.z, it.title, 'phone']),
    now: () => 0,
  });
  link = createPhoneLink({
    phone, input,
    canOpen: () => canOpenPhone({ started: world.started, paused: world.paused, panelOpen: world.panel, menuOpen: world.menu, blocked: world.blocked }),
    canResume: () => world.started && !world.paused && !world.panel && !world.menu,
    onLock: () => locks++,
    fillData: (d) => {
      fills++;
      d.hour = env.hour;
      d.weatherIcon = env.icon;
      d.money = env.money;
      d.jobs = listings(focus, listBuf);
    },
  });

  // 互斥：暫停 / 面板 / 選單 / 遮罩時 open 無效、不動輸入
  for (const k of ['paused', 'panel', 'menu', 'blocked']) {
    world[k] = true;
    const r = link.open();
    check(`互斥：${k} 時 open() 回 false、手機未開、input 不動`, r === false && !phone.isOpen() && input.enabled === true && locks === 0);
    world[k] = false;
  }
  link.frame(0.016);
  check('關閉中 frame：不呼叫 fillData（listings 不跑）', fills === 0);

  // 開啟：先注入資料再 open → 鎖屏時鐘 = 13:30；輸入鎖定、onLock 一次、phone:open
  check('open() → true、isOpen', link.open() === true && phone.isOpen());
  check('開啟 → input.enabled = false、onLock 一次', input.enabled === false && locks === 1);
  check('開啟前先 setData：鎖屏時鐘 / 天氣已是注入值', phone.element.findClass('ph-lock-clock').textContent === formatClock(13.5) && /雨/.test(phone.element.findClass('ph-lock-weather').textContent));
  check('phone:open 事件', events.includes('phone:open'));
  check('再 open() → false（冪等，不重複鎖）', link.open() === false && locks === 1);
  check('sync() 冪等：開著回 true、不重複 onLock', link.sync() === true && locks === 1);

  // 每幀注入：fillData 每幀一次、jobs 陣列重用；金錢寫進狀態列
  const f0 = fills;
  env.money = 9999;
  link.frame(0.016);
  link.frame(0.016);
  check('開啟中 frame：每幀 fillData 一次', fills === f0 + 2);
  check('jobs = listings 輸出（同一陣列重用）', link.data.jobs === listBuf && listBuf.length === 4);
  check('金錢注入 → 狀態列更新', /9,?999/.test(phone.element.findClass('ph-bar-money').textContent), phone.element.findClass('ph-bar-money').textContent);

  // 鎖屏 LOCK_SEC 後解鎖 → 任務 App：附近 / 委託 / 打工 分頁計數來自 listings
  for (let i = 0; i < 60; i++) link.frame(1 / 60);
  check('鎖屏吃渲染 dt 自動解鎖 → 首頁', phone.app === 'home');
  phone.element.findClass('ph-app-jobs').click();
  const tabs = Object.fromEntries(phone.element.findAllClass('ph-tab').map((b) => [b.dataset.tab, b.textContent]));
  check('任務 App 分頁：附近 1 / 委託 1 / 打工 2', tabs.nearby === '附近 1' && tabs.mission === '委託 1' && tabs.job === '打工 2', JSON.stringify(tabs));
  phone.element.findAllClass('ph-tab').find((b) => b.dataset.tab === 'job').click();
  link.frame(0.6);
  const rows = phone.element.findAllClass('ph-row').filter((r) => r.visible);
  const goBtns = rows.map((r) => r.findClass('ph-go'));
  check('打工分頁 2 列；navigable false → 導航鈕停用', rows.length === 2 && goBtns[0].disabled === false && goBtns[1].disabled === true);
  goBtns[0].click();
  check('導航 → onNavigate(item)（x, z, title, phone）', calls.nav.length === 1 && calls.nav[0].join() === '7,8,夜市跑單,phone', JSON.stringify(calls.nav));
  check('導航不關手機、輸入維持鎖定', phone.isOpen() && input.enabled === false);

  // Esc：App 頁 → 首頁（不關）；再 Esc → 關閉；keydown 內不還原輸入，下一次 sync 才還原
  let e = key('Escape', { timeStamp: 1 });
  check('Esc（任務 App）→ 回首頁、stopPropagation', phone.isOpen() && phone.app === 'home' && e.propagationStopped);
  e = key('Escape', { timeStamp: 2 });
  check('Esc（首頁）→ 關閉；同一個 keydown 內 input 仍停用（不讓 input.js 再收到 Esc 開暫停）', !phone.isOpen() && input.enabled === false && e.propagationStopped);
  check('下一幀 sync → input.enabled = true', link.sync() === false && input.enabled === true);
  check('關閉後 sync 冪等', link.sync() === false && input.enabled === true && locks === 1);

  // T：開著時按 T（首頁）= 關閉
  link.open();
  for (let i = 0; i < 60; i++) link.frame(1 / 60);
  key('KeyT', { timeStamp: 3 });
  link.sync();
  check('T 關閉 → sync 還原輸入、onLock 共 2 次', !phone.isOpen() && input.enabled === true && locks === 2);
  // M / P / G 吞掉（不開大地圖 / 暫停）
  link.open();
  e = key('KeyM', { timeStamp: 4 });
  check('手機開著按 M：被吞（stopPropagation）、手機不關', phone.isOpen() && e.propagationStopped && e.defaultPrevented);

  // toggle：開著 → 關且立即還原
  check('toggle（開著）→ 關閉、立即 sync 還原輸入', link.toggle() === false && !phone.isOpen() && input.enabled === true);
  check('toggle（關著）→ 開啟、鎖輸入', link.toggle() === true && phone.isOpen() && input.enabled === false);

  // 暫停中關手機 → 不還原（交給 resumeGame）
  world.paused = true;
  phone.close();
  link.sync();
  check('暫停中關閉：sync 不還原 input（resumeGame 負責）', input.enabled === false);
  world.paused = false;
  input.enabled = true;

  // 地圖 App：關手機 → 面板開 → syncPhone 見面板開著不還原輸入
  link.open();
  for (let i = 0; i < 60; i++) link.frame(1 / 60);
  phone.element.findClass('ph-app-map').click();
  check('地圖 App：onOpenMap 一次、手機關閉、大地圖（面板）接手鎖輸入', calls.map === 1 && !phone.isOpen() && input.enabled === false);
  link.sync();
  check('地圖開著：之後的 sync 也不還原輸入', input.enabled === false);
  world.panel = false;
  input.enabled = true; // syncPanels 關面板還原

  // 設定 App：關手機 → openPause('settings')（pauseGame → reset）
  link.open();
  for (let i = 0; i < 60; i++) link.frame(1 / 60);
  phone.element.findClass('ph-app-settings').click();
  check('設定 App：onOpenSettings 一次、手機關閉、暫停中輸入維持停用', calls.settings === 1 && !phone.isOpen() && input.enabled === false);
  world.paused = false;
  world.menu = false;
  input.enabled = true; // resumeGame

  // reset：開著時（例：回主選單）→ 關閉並忘記狀態；之後 sync 不再改輸入
  link.open();
  input.enabled = false;
  link.reset();
  input.enabled = false; // quitToMenu 自行設定
  check('reset：手機關閉、之後 sync 不動 input', !phone.isOpen() && link.sync() === false && input.enabled === false);
  input.enabled = true;
  check('reset 後可再開', link.open() === true && input.enabled === false);
  link.reset();
  phone.destroy();
  check('destroy 移除 keydown listener', win.listenerCount('keydown') === 0);
}

// ======================= 3. main.js 接線 =======================
{
  const m = read('src/main.js');
  const has = (s) => m.includes(s);
  const block = (start, endMark = '\n  };') => {
    const i = m.indexOf(start);
    return i < 0 ? '' : m.slice(i, m.indexOf(endMark, i) + endMark.length);
  };
  check('main.js：import createPhone / canOpenPhone, createPhoneLink / isInputBlocked',
    has("import { createPhone } from './ui/phone.js';") && has("import { canOpenPhone, createPhoneLink } from './ui/phone-link.js';") && /import \{[^}]*\bisInputBlocked\b[^}]*\} from '\.\/mobile\.js';/.test(m));
  const create = block('const phone = createPhone({', '\n  });');
  const iClose = create.indexOf('phone.close();');
  const iBig = create.indexOf('bigMap.open();');
  const iSyncP = create.indexOf('syncPanels();');
  check('onOpenMap：phone.close → bigMap.open → syncPanels（再 syncPhone）', iClose > 0 && iBig > iClose && iSyncP > iBig && /onOpenMap: \(\) => \{\s*phone\.close\(\);\s*bigMap\.open\(\);\s*syncPanels\(\);\s*syncPhone\(\);\s*\}/.test(create));
  check("onOpenSettings：phone.close → menu.openPause('settings')", /onOpenSettings: \(\) => \{\s*phone\.close\(\);\s*menu\.openPause\('settings'\);/.test(create));
  check("onNavigate：nav.setDestination(it.x, it.z, it.title, 'phone', focus)", create.includes("onNavigate: (it) => nav.setDestination(it.x, it.z, it.title, 'phone', focus),"));
  check('createPhone：root / bus / isTouch 注入', /root: document\.body,\s*bus,\s*isTouch: touch,/.test(create));
  const linkSrc = block('const phoneLink = createPhoneLink({', '\n  });');
  check('setData 來源：dayNight.hour / weather.getState().icon / economy.money / missions.listings(focus, phoneJobs)',
    linkSrc.includes('d.hour = dayNight.hour;') && linkSrc.includes('d.weatherIcon = weather.getState().icon;') && linkSrc.includes('d.money = economy.money;') && linkSrc.includes('d.jobs = missions.listings(focus, phoneJobs);'));
  check('canOpen：started / paused / panelOpen() / menu.isOpen() / isInputBlocked()',
    linkSrc.includes('canOpenPhone({ started: state.started, paused: state.paused, panelOpen: panelOpen(), menuOpen: menu.isOpen(), blocked: isInputBlocked() })'));
  check('onLock：releaseLock、清提示、駕駛中手煞', /onLock: \(\) => \{\s*releaseLock\(\);\s*hud\.setPrompt\(null\);\s*hud\.setInteractPrompt\?\.\(null\);\s*if \(state\.mode === 'drive' && state\.vehicle\) state\.vehicle\.setControls\(driveControls\(\{ x: 0, y: 0 \}, true\)\);/.test(linkSrc));
  const panelLine = (m.match(/const panelOpen = \(\) => [^\n]*/) || [''])[0];
  check('手機不列入 panelOpen（世界不暫停）', panelLine.length > 0 && !/phone/.test(panelLine));
  const upd = block('const updateGame = (dt) => {', '\n  };');
  const iPhoneSync = upd.indexOf('let phoneOpen = syncPhone();');
  const iPanels = upd.indexOf('if (syncPanels()) return;');
  check('updateGame：先 syncPhone 再 syncPanels', iPhoneSync > 0 && iPanels > iPhoneSync);
  const iPause = upd.indexOf('if (snap.pressed.pause)');
  const iMap = upd.indexOf('if (snap.pressed.map)');
  const iT = upd.indexOf("if (input.actions.pressed('phone') && openPhone()) phoneOpen = true;");
  check("T：input.actions.pressed('phone') → openPhone（在暫停 / 地圖判斷之後、駕駛控制之前）", iT > iPause && iT > iMap && iT < upd.indexOf("if (state.mode === 'drive')"));
  check('手機開著駕駛：維持手煞、油門記 0', upd.includes('v.setControls(phoneOpen ? driveControls({ x: 0, y: 0 }, true) : driveControls(snap.move, snap.down.jump));') && upd.includes('lastThrottle = phoneOpen ? 0 : snap.move.y;'));
  const iFrame = upd.indexOf('phoneLink.frame(dt);');
  check('每幀 phoneLink.frame(dt)（渲染 dt；在 missions.update 之後）', iFrame > upd.indexOf('missions.update(worldStep.simDt, missionCtx);') && !/phoneLink\.frame\(worldStep/.test(m));
  const sp = block('const syncPanels = () => {');
  check('syncPanels：開面板先關手機', /if \(open\) \{\s*if \(phone\.isOpen\(\)\) phone\.close\(\);/.test(sp));
  check('closePanels / pauseGame：phoneLink.reset()', /const closePanels = \(\) => \{[\s\S]*?phoneLink\.reset\(\);[\s\S]*?\n  \};/.test(m) && /const pauseGame = \(\) => \{[\s\S]*?phoneLink\.reset\(\);[\s\S]*?\n  \};/.test(m));
  check("觸控：registerTouchButton tb-phone（tl4、always、onTap → openPhone）", has("registerTouchButton({ id: 'tb-phone', label: '手機', slot: 'tl4', showWhen: 'always', onTap: () => openPhone() });"));
  check('phone:close 不同步還原輸入（不訂閱 bus phone:close 呼叫 sync）', !/bus\.on\('phone:close'/.test(m));
  check('HUD 步行按鍵提示含手機', /walk: \[[^\]]*\['通用', 'phone'\]\]/.test(m.replace(/\]\],\n/g, ']]\n')) || /walk: \[.*\['通用', 'phone'\]\],/.test(m));
  const { KEYMAP_HELP, TOUCH_HELP, ACTIONS } = await import('../../src/core/actions.js');
  const flat = (h) => h.flatMap((g) => g.items);
  check('actions：phone = KeyT、非預留；KEYMAP_HELP「T 手機」、TOUCH_HELP 手機列', ACTIONS.phone.keys.includes('KeyT') && !ACTIONS.phone.reserved
    && flat(KEYMAP_HELP).some((i) => i.action === 'phone' && i.keys === 'T') && flat(TOUCH_HELP).some((i) => i.action === 'phone' && /手機/.test(i.keys)));
}

// ======================= 4. 觸控 tl4 / 版面 =======================
{
  const t = read('src/touch.js');
  const defaults = t.slice(t.indexOf('const DEFAULT_BUTTONS'), t.indexOf('];', t.indexOf('const DEFAULT_BUTTONS')));
  check('touch.js：SLOTS 含 tl4', /export const SLOTS = \[[^\]]*'tl4'[^\]]*\]/.test(t));
  check('touch.js：tb-phone 預設 slot tl4、always、隱藏佔位；tb-guide 仍在 tl3', defaults.includes("{ id: 'tb-phone', label: '手機', code: 'KeyT', mode: 'tap', slot: 'tl4', showWhen: 'always', hidden: true }") && defaults.includes("{ id: 'tb-guide', label: '圖鑑', onTap: () => {}, mode: 'tap', slot: 'tl3'"));

  // ---- 迷你 CSS 解析：頂層規則 + 一層 @media；只處理本檔用到的選擇器形式與 px / calc(Npx + env()) 值 ----
  const css = read('src/style.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let order = 0;
  const parseRules = (text, media) => {
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let mm;
    while ((mm = re.exec(text))) {
      const decls = {};
      for (const d of mm[2].split(';')) {
        const k = d.indexOf(':');
        if (k > 0) decls[d.slice(0, k).trim()] = d.slice(k + 1).trim();
      }
      for (const sel of mm[1].split(',')) rules.push({ media, sel: sel.trim(), decls, order: order++ });
    }
  };
  {
    let i = 0;
    let top = '';
    while (i < css.length) {
      const at = css.indexOf('@media', i);
      if (at < 0) {
        top += css.slice(i);
        break;
      }
      top += css.slice(i, at);
      const open = css.indexOf('{', at);
      let depth = 1;
      let j = open + 1;
      for (; j < css.length && depth; j++) depth += css[j] === '{' ? 1 : css[j] === '}' ? -1 : 0;
      parseRules(top, null);
      top = '';
      parseRules(css.slice(open + 1, j - 1), css.slice(at + 6, open).trim());
      i = j;
    }
    parseRules(top, null);
  }
  const mediaOk = (q, W, H) => {
    if (!q) return true;
    return q.split(/\s+and\s+/).every((c) => {
      const mm = c.match(/\(\s*([a-z-]+)\s*:\s*([a-z0-9]+)\s*\)/);
      if (!mm) return false;
      const [, f, v] = mm;
      if (f === 'orientation') return v === (H > W ? 'portrait' : 'landscape');
      if (f === 'max-width') return W <= parseFloat(v);
      if (f === 'max-height') return H <= parseFloat(v);
      if (f === 'min-width') return W >= parseFloat(v);
      return false;
    });
  };
  // 選擇器：.tbtn.slot-x 或 body.touch-drive / body.touch-walk .tbtn.slot-x；回傳特異度（不符 = -1）
  const selMatch = (sel, slot, mode) => {
    const mm = sel.match(/^(?:body\.(touch-drive|touch-walk|touch)\s+)?\.tbtn\.slot-([a-z0-9]+)$/);
    if (!mm || mm[2] !== slot) return -1;
    if (mm[1] && mm[1] !== 'touch' && mm[1] !== `touch-${mode}`) return -1;
    return mm[1] ? 31 : 20;
  };
  const val = (v) => {
    if (v === undefined) return undefined;
    if (v === 'auto') return 'auto';
    const mm = v.match(/^(?:calc\()?\s*(-?\d+(?:\.\d+)?)px/);
    return mm ? Number(mm[1]) : undefined;
  };
  const rectOf = (slot, W, H, mode, name = slot) => {
    const cs = {};
    const prio = {};
    for (const r of rules) {
      const sp = selMatch(r.sel, slot, mode);
      if (sp < 0 || !mediaOk(r.media, W, H)) continue;
      for (const [k, v] of Object.entries(r.decls)) {
        const p = sp * 1e6 + r.order;
        if (prio[k] === undefined || p >= prio[k]) {
          prio[k] = p;
          cs[k] = v;
        }
      }
    }
    const w = val(cs.width) ?? 64;
    const h = val(cs.height) ?? 64;
    const left = val(cs.left);
    const right = val(cs.right);
    const top = val(cs.top);
    const bottom = val(cs.bottom);
    const x = typeof left === 'number' ? left : W - right - w;
    const y = typeof top === 'number' ? top : H - bottom - h;
    return { x, y, w, h, name };
  };
  const pedalTop = (W, H) => {
    let top = 202;
    for (const r of rules) {
      if (!mediaOk(r.media, W, H)) continue;
      if (r.sel === 'body.touch-drive #touch-pedals' && r.decls['padding-top']) top = val(r.decls['padding-top']);
    }
    return top;
  };
  const R = (x, y, w, h, name, minGap = 4) => ({ x, y, w, h, name, minGap });
  const gap = (a, b) => Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));

  const SIZES = [[360, 740], [390, 844], [360, 640], [375, 667], [430, 932], [768, 1024], [568, 320], [640, 360], [667, 375], [740, 360], [844, 390], [932, 430], [1024, 768]];
  const bad = [];
  const padBad = [];
  const coords = {};
  for (const [W, H] of SIZES) {
    const portrait = H > W;
    for (const mode of ['walk', 'drive']) {
      const drive = mode === 'drive';
      const btn = (slot, name) => rectOf(slot, W, H, mode, name);
      const phoneR = btn('tl4', '手機');
      const viewR = btn('view', '視角');
      const radioR = btn('top2', '換台');
      const mine = [phoneR, viewR];
      if (drive) mine.push(radioR);
      coords[`${W}x${H} ${mode}`] = mine.map((r) => `${r.name} ${r.x}–${r.x + r.w}/${r.y}–${r.y + r.h}`).join('，');
      const others = [btn('tl1', '暫停'), btn('tl2', '地圖')];
      if (!drive) others.push(btn('tl3', '圖鑑'));
      if (drive) {
        others.push(btn('top1', '喇叭'), btn('sec2', '下車'), btn('sec3', '手煞'), btn('interact', '互動'));
        const pt = pedalTop(W, H);
        others.push(R(W / 2 + 12, pt, W / 2 - 24, H - 16 - pt, '踏板', 12));
      }
      // HUD（間距 ≥ 2）
      others.push(R(10, 10, 120, 162, '小地圖群組', 2));
      const statusW = portrait ? Math.min(220, W - 160) : 220;
      others.push(R(W - 16 - statusW, 76, statusW, 30, '#status', 2));
      if (portrait) {
        others.push(R(10, 180, W / 2 - 14, 60, '#prompt', 2));
        if (!drive) others.push(R(W / 2 + 4, 132, W / 2 - 14, 140, '#hint-card', 2));
      } else {
        others.push(R(140, 76, W / 2 - 144, 44, '#prompt', 2));
        if (!drive && H <= 540) others.push(R(W - 16 - 52, 14, 52, 52, '裝填鈕'));
        if (!drive && H < 380) others.push(R(W - 76 - 112, 26, 112, 28, '武器面板', 2));
      }
      const all = [...mine, ...others];
      for (const me of mine) {
        if (!(me.x >= 0 && me.y >= 0 && me.x + me.w <= W && me.y + me.h <= H)) bad.push(`${W}x${H} ${mode} ${me.name} 出界`);
        if (me.w < 44 || me.h < 44) bad.push(`${W}x${H} ${mode} ${me.name} < 44px`);
        for (const o of all) {
          if (o === me) continue;
          // 手機 / 視角 / 換台彼此、與喇叭：≥ 8px；其餘按鈕 ≥ 4px（左上小鈕列窄直向本來就 4px）；HUD ≥ 2；踏板 ≥ 12
          const need = mine.includes(o) || o.name === '喇叭' ? 8 : o.minGap;
          const g = gap(me, o);
          if (g < need) bad.push(`${W}x${H} ${mode} ${me.name}↔${o.name} 間距 ${g}`);
        }
        if (portrait && drive && me !== phoneR && me.x < W / 2) padBad.push(`${W}x${H} ${me.name} x ${me.x}`);
      }
    }
  }
  check('版面：13 種尺寸 × 步行 / 駕駛，手機 / 視角 / 換台鈕不與其他觸控鈕、踏板、小地圖、#status、提示、武器面板重疊且 ≥ 44px', bad.length === 0, [...new Set(bad)].join('; '));
  check('直向駕駛：視角鈕 / 換台鈕在右半（不進左半轉向區 #touch-pad）', padBad.length === 0, padBad.join('; '));
  // 指定尺寸的座標（任務要求寫明；改版面時這裡會一起變）
  const expect = {
    '360x740 walk': '手機 296–344/12–60，視角 136–180/114–158',
    '360x740 drive': '手機 244–292/12–60，視角 292–336/274–318，換台 290–338/210–258',
    '390x844 walk': '手機 296–344/12–60，視角 136–180/114–158',
    '390x844 drive': '手機 244–292/12–60，視角 322–366/274–318，換台 320–368/210–258',
    '568x320 walk': '手機 280–324/12–56，視角 332–376/12–56',
    '568x320 drive': '手機 280–324/12–56，視角 332–376/12–56，換台 430–486/12–68',
    '844x390 walk': '手機 308–356/12–60，視角 640–696/12–68',
    '844x390 drive': '手機 308–356/12–60，視角 640–696/12–68，換台 706–762/12–68',
  };
  const diff = Object.entries(expect).filter(([k, v]) => coords[k] !== v).map(([k, v]) => `${k}: ${coords[k]}（預期 ${v}）`);
  check('座標：360×740 / 390×844 直向、568×320 / 844×390 橫向（步行 / 駕駛）', diff.length === 0, diff.join('; '));
  if (process.env.P6I6B_VERBOSE) for (const [k, v] of Object.entries(coords)) console.log(`  ${k}: ${v}`);
}

console.log(`${fail ? 'FAIL' : 'PASS'} ${fail ? `${fail}/${pass + fail}` : `${pass}/${pass + fail}`}`);
if (fail) process.exit(1);
