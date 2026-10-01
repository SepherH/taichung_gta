#!/usr/bin/env node
// P6 遊戲內手機（契約 §23.3）：純函式（時鐘 / 距離 / 分類 / 返回目標）、createPhone 在最小 DOM 替身上的流程
//   （DOM 延遲建立、open / close / isOpen 冪等與事件、Esc / T 關閉且 stopPropagation、鎖屏自動解鎖吃渲染 dt、
//    setData 後任務 App 分三類、分頁切換、navigable false 停用、onNavigate / onOpenMap / onOpenSettings 呼叫一次、destroy）、phone.css 規範
// 用法：node tools/test/p6-p6.mjs（任一斷言失敗 exit 1；最後一行印 PASS n/n 或 FAIL k/n）
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

const P = await import('../../src/ui/phone.js');
const { createPhone, formatClock, formatDistance, countJobs, jobsInTab, backTarget, JOB_TABS, LOCK_SEC } = P;

// ---------- 純函式 ----------
check('formatClock 0', formatClock(0) === '00:00');
check('formatClock 13.5', formatClock(13.5) === '13:30');
check('formatClock 23.999', formatClock(23.999) === '23:59', formatClock(23.999));
check('formatClock 24 → 00:00', formatClock(24) === '00:00');
check('formatClock 7.25', formatClock(7.25) === '07:15');
check('formatClock NaN', formatClock(NaN) === '--:--');
check('formatDistance 349.6', formatDistance(349.6) === '350 m');
check('formatDistance 1234', formatDistance(1234) === '1.2 km');
check('formatDistance undefined', formatDistance(undefined) === '—');
check('JOB_TABS 三類順序', JOB_TABS.map((t) => t[0]).join() === 'nearby,mission,job');

const JOBS = [
  { id: 'm1', title: '送便當', category: 'mission', reward: 500, distanceM: 820, navigable: true, x: 10, z: 20, active: false },
  { id: 'm2', title: '送花', category: 'mission', reward: 300, distanceM: 150, navigable: true, x: 1, z: 2, active: false },
  { id: 'ev', title: '夜市外送', category: 'nearby', reward: 400, distanceM: 1500, navigable: false, x: 5, z: 6, active: false },
  { id: 'night-market-run', title: '夜市跑單', category: 'job', reward: 260, distanceM: 90, navigable: true, x: 7, z: 8, active: false },
  { id: 'valet-parking', title: '代客泊車', category: 'job', reward: 300, distanceM: 2400, navigable: true, x: 9, z: 9, active: true },
  { id: 'x', title: '未知', category: 'other', reward: 1, distanceM: 1, navigable: true, x: 0, z: 0, active: false },
];
const cnt = countJobs(JOBS);
check('countJobs 分三類（未知不計）', cnt.nearby === 1 && cnt.mission === 2 && cnt.job === 2, JSON.stringify(cnt));
const tabOut = [];
const r1 = jobsInTab(JOBS, 'mission', tabOut);
check('jobsInTab 重用 out', r1 === tabOut);
check('jobsInTab 依距離排序', r1.map((j) => j.id).join() === 'm2,m1');
check('jobsInTab 進行中置頂', jobsInTab(JOBS, 'job').map((j) => j.id).join() === 'valet-parking,night-market-run');
check('jobsInTab 非陣列 → 空', jobsInTab(null, 'job').length === 0);
check('backTarget app 頁 → home', backTarget({ locked: false, app: 'jobs' }) === 'home');
check('backTarget 首頁 → close', backTarget({ locked: false, app: 'home' }) === 'close');
check('backTarget 鎖屏 → close', backTarget({ locked: true, app: 'home' }) === 'close');

// ---------- createPhone ----------
const events = [];
const bus = { emit: (n, p) => events.push([n, p]) };
const calls = { map: 0, settings: 0, nav: [] };
const root = new FakeEl('div');
let clock = 1000;
const phone = createPhone({
  root,
  bus,
  doc,
  keyTarget: win,
  onOpenMap: () => calls.map++,
  onOpenSettings: () => calls.settings++,
  onNavigate: (it) => calls.nav.push(it),
  now: () => clock,
});
const count = (n) => events.filter((e) => e[0] === n).length;

check('建立時只註冊 keydown capture', win.listenerCount('keydown') === 1);
check('DOM 延遲到第一次 open', root.children.length === 0 && phone.element === null);
check('初始 isOpen false', phone.isOpen() === false);

// 關閉中按 Esc / T 不吞（交給暫停選單 / input）
const e0 = key('Escape');
check('關閉中 Esc 不處理', !e0.propagationStopped && !e0.defaultPrevented);
check('關閉中 close() 冪等不發事件', (phone.close(), events.length === 0));

phone.setData({ hour: 21.75, weatherIcon: 'rain', money: 12345, jobs: JOBS });
phone.open();
const el = phone.element;
check('open → isOpen', phone.isOpen() === true);
check('open 建 DOM 掛在 root', root.children.length === 1 && el && el.parentNode === root);
check('open emit phone:open + ui:sound open', count('phone:open') === 1 && events.some((e) => e[0] === 'ui:sound' && e[1].kind === 'open'));
check('phone:open payload {}', JSON.stringify(events.find((e) => e[0] === 'phone:open')[1]) === '{}');
const nEl = created;
phone.open();
check('open 冪等（不重發、不重建）', count('phone:open') === 1 && created === nEl && root.children.length === 1);
check('無指定 App → 鎖屏', phone.app === 'lock' && phone.locked);
check('鎖屏顯示時間', el.findClass('ph-lock-clock').textContent === '21:45');
check('鎖屏顯示天氣', el.findClass('ph-lock-weather').textContent.includes('雨'));
check('狀態列金錢', el.findClass('ph-bar-money').textContent === 'NT$12,345');
check('class 前綴 ph-', el.findAllClass('ph-phone').length === 0 && el.classList.contains('ph-phone'));

// 鎖屏吃渲染 dt：dt 0 不推進，累計 ≥ LOCK_SEC 解鎖
phone.update(0);
check('update(0) 不解鎖', phone.locked);
phone.update(LOCK_SEC / 2);
check('半程仍鎖', phone.locked);
phone.update(LOCK_SEC / 2 + 1e-6);
check('滿 LOCK_SEC 自動解鎖 → home', !phone.locked && phone.app === 'home');
check('首頁可見、鎖屏隱藏', el.findClass('ph-home').visible && !el.findClass('ph-lock').visible);

// 時鐘在 update 時刷新（setData 只存參照）
phone.setData({ hour: 22.0, weatherIcon: 'sun', money: 12345, jobs: JOBS });
check('setData 不立即寫 DOM', el.findClass('ph-bar-clock').textContent === '21:45');
phone.update(1 / 60);
check('update 後時鐘刷新', el.findClass('ph-bar-clock').textContent === '22:00');
check('首頁任務 badge = 5', el.findClass('ph-badge').textContent === '5' && el.findClass('ph-badge').visible);

// 觸控友善：所有按鈕 type=button；面板吞指標事件
const btns = [...el.walk()].filter((n) => n.tagName === 'BUTTON');
check('按鈕 type=button', btns.length >= 5 && btns.every((b) => b.attrs.type === 'button'));
const pd = new FakeEvent('pointerdown');
el.dispatchEvent(pd);
check('面板 pointerdown stopPropagation', pd.propagationStopped);

// 任務 App：分三類
el.findClass('ph-app-jobs').click();
check('點任務 → app jobs', phone.app === 'jobs' && el.findClass('ph-jobs').visible && !el.findClass('ph-home').visible);
const tabs = el.findAllClass('ph-tab');
check('三個分頁', tabs.length === 3 && tabs.map((t) => t.dataset.tab).join() === 'nearby,mission,job');
check('分頁標籤含數量', tabs[1].textContent === '委託 2' && tabs[0].textContent === '附近 1');
const visRows = () => el.findAllClass('ph-row').filter((r) => r.visible);
check('預設分頁 附近', phone.tab === 'nearby' && tabs[0].classList.contains('ph-on'));
check('附近 1 列', visRows().length === 1 && visRows()[0].findClass('ph-row-title').textContent === '夜市外送');
check('附近 酬勞 · 距離', visRows()[0].findClass('ph-row-meta').textContent === 'NT$400 · 1.5 km');
check('navigable false → 導航停用', visRows()[0].findClass('ph-go').disabled === true);
visRows()[0].findClass('ph-go').click();
check('停用鈕不呼叫 onNavigate', calls.nav.length === 0);

tabs[1].click();
check('切到 委託', phone.tab === 'mission' && tabs[1].classList.contains('ph-on') && !tabs[0].classList.contains('ph-on'));
check('委託 2 列（近 → 遠）', visRows().map((r) => r.findClass('ph-row-title').textContent).join() === '送花,送便當');
check('委託 導航啟用', visRows().every((r) => r.findClass('ph-go').disabled === false));
check('委託 無空白提示', !el.findClass('ph-empty').visible);
visRows()[1].findClass('ph-go').click();
check('onNavigate 呼叫一次、參數為項目', calls.nav.length === 1 && calls.nav[0] === JOBS[0]);

tabs[2].click();
check('切到 打工', phone.tab === 'job');
const jr = visRows();
check('打工 2 列、進行中置頂並標示', jr.length === 2 && jr[0].classList.contains('ph-active') && jr[0].findClass('ph-row-title').textContent === '● 代客泊車');
check('列池化：列數不超過最大分類', el.findAllClass('ph-row').length === 2);

// 資料變動：列表依 update 節流刷新
const JOBS2 = JOBS.filter((j) => j.id !== 'night-market-run');
phone.setData({ hour: 22, weatherIcon: 'sun', jobs: JOBS2 });
phone.update(0.1);
check('節流內不刷新列表', visRows().length === 2);
phone.update(0.5);
check('刷新後打工 1 列', visRows().length === 1);
check('money 省略 → 狀態列清空', el.findClass('ph-bar-money').textContent === '');
phone.setData({ hour: 22, weatherIcon: 'sun', jobs: [] });
phone.setTab('mission');
check('空列表顯示提示', visRows().length === 0 && el.findClass('ph-empty').visible);
check('badge 0 隱藏', !el.findClass('ph-badge').visible);
phone.setTab('bogus');
check('非法分頁忽略', phone.tab === 'mission');

// Esc：App 頁先回首頁，stopPropagation
const e1 = key('Escape');
check('Esc 在 App 頁 → 回首頁', phone.app === 'home' && phone.isOpen());
check('Esc preventDefault + stopPropagation', e1.defaultPrevented && e1.propagationStopped);
// M / P 吞掉不動作
const em = key('KeyM');
check('開啟中 M 被吞且不關', em.propagationStopped && phone.isOpen());
const ew = key('KeyW');
check('其他鍵不處理', !ew.propagationStopped && !ew.defaultPrevented);
const er = key('Escape', { repeat: true });
check('repeat Esc 只吞不關', er.propagationStopped && phone.isOpen());
const e2 = key('Escape');
check('首頁 Esc → 關閉', !phone.isOpen() && e2.propagationStopped);
check('close emit phone:close + ui:sound close', count('phone:close') === 1 && events.some((e) => e[0] === 'ui:sound' && e[1].kind === 'close'));
check('關閉後 DOM 隱藏但保留', el.hidden && el.parentNode === root);
phone.close();
check('close 冪等', count('phone:close') === 1);

// T 鍵：同一按鍵事件（timeStamp ≤ openedAt）不關；之後的 T 關閉
clock = 2000;
phone.open('jobs');
check('open(app) 跳過鎖屏', phone.app === 'jobs' && !phone.locked);
check('重開時保留上次分頁', phone.tab === 'mission');
const t0 = key('KeyT', { timeStamp: 1999 });
check('開啟用的同一 T 事件不處理', phone.isOpen() && !t0.propagationStopped);
key('KeyT', { timeStamp: 2100 });
check('T 在 App 頁 → 回首頁', phone.app === 'home' && phone.isOpen());
key('KeyT', { timeStamp: 2200 });
check('T 在首頁 → 關閉', !phone.isOpen());

// 返回鈕
phone.open('jobs');
el.findClass('ph-back').click();
check('返回鈕 App → 首頁', phone.app === 'home');
el.findClass('ph-back').click();
check('返回鈕 首頁 → 關閉', !phone.isOpen());

// 鎖屏點一下解鎖、鎖屏 Esc 直接關
phone.open();
el.findClass('ph-unlock').click();
check('點解鎖 → home', phone.app === 'home');
phone.close();
phone.open();
key('Escape');
check('鎖屏 Esc → 關閉', !phone.isOpen());

// 地圖 / 設定 App：各呼叫一次
phone.open('home');
check("open('home') 不鎖屏", phone.app === 'home');
el.findClass('ph-app-map').click();
check('onOpenMap 呼叫一次', calls.map === 1 && calls.settings === 0);
el.findClass('ph-app-settings').click();
check('onOpenSettings 呼叫一次', calls.settings === 1 && calls.map === 1);
phone.close();
phone.open('map');
check("open('map') 開啟並呼叫 onOpenMap", phone.isOpen() && calls.map === 2);
phone.close();

// toggle
phone.toggle();
check('toggle 開', phone.isOpen());
phone.toggle();
check('toggle 關', !phone.isOpen());

// callback 缺 / 拋錯不影響
const quiet = console.error;
console.error = () => {};
const p2 = createPhone({ root: new FakeEl('div'), doc, keyTarget: new Listeners(), onOpenMap: () => { throw new Error('x'); } });
p2.open('map');
check('callback 拋錯、bus 缺 → 不崩', p2.isOpen());
p2.update(NaN);
check('update(NaN) 不推進鎖屏', p2.isOpen());
p2.destroy();
console.error = quiet;

// destroy
phone.open();
const closesBefore = count('phone:close');
phone.destroy();
check('destroy 關閉並發 phone:close', count('phone:close') === closesBefore + 1);
check('destroy 移除 DOM', root.children.length === 0);
check('destroy 移除 keydown', win.listenerCount('keydown') === 0);
phone.open();
check('destroy 後 open 無效', !phone.isOpen());

// ---------- phone.css 規範 ----------
const css = readFileSync(new URL('../../src/ui/phone.css', import.meta.url), 'utf8');
const cssNoComment = css.replace(/\/\*[\s\S]*?\*\//g, '');
const classes = [...cssNoComment.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]);
check('css class 全部 ph- 前綴', classes.length > 10 && classes.every((c) => c.startsWith('ph-')), classes.filter((c) => !c.startsWith('ph-')).join());
const zs = [...css.matchAll(/z-index:\s*(\d+)/g)].map((m) => +m[1]);
check('z-index = 80', zs.length === 1 && zs[0] === 80);
check('按鈕 ≥ 44px', /\.ph-phone button\s*{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px;/.test(css));
check('有直向媒體查詢', /@media \(orientation: portrait\)/.test(css));
const src = readFileSync(new URL('../../src/ui/phone.js', import.meta.url), 'utf8');
check('不 import missions / main / core', !/from ['"][^'"]*(missions|main|core)\//.test(src) && !/main\.js['"]/.test(src));

const total = pass + fail;
console.log(fail === 0 ? `PASS ${pass}/${total}` : `FAIL ${fail}/${total}`);
process.exit(fail === 0 ? 0 : 1);
