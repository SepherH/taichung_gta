#!/usr/bin/env node
// 送貨委託系統無頭驗證（契約 §16 / §18）：假 fetchJson、真地標點（public/models/manifest.json → landmarkPoints）、three 真 Scene、DOM 最小替身
// 用法：node tools/test/missions.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：catalog 別名容錯 / 地標對不到丟棄且 info 一次；缺檔（404 / 壞 JSON / 回退 index.html / 全部對不到）→ 內建 3 個委託；
//   完整流程（起點光柱 → interactable → 接單卡 E / Esc → 目的地 + nav:destination → 抵達結算 → 結算面板）× timed / fragile / heavy；
//   失敗（timeout / destroyed / ko / abandon）+ 重試；冷卻 120 s 與輪替；存檔往返與容錯；有 manifest 時畫面與事件不出現內建文案；
//   每幀回傳物件重用；CSS 按鈕 ≥ 44 px / z-index / safe-area；dispose 清乾淨；全程無 console.error
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

// ---------- DOM 最小替身 ----------
class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.hidden = false;
    this.style = {};
    this.dataset = {};
    this.attrs = {};
    this.listeners = {};
    this._text = '';
    this.type = '';
    this.alt = '';
    this._src = '';
    const self = this;
    this.classList = {
      add: (c) => {
        const s = new Set(self.className.split(/\s+/).filter(Boolean));
        s.add(c);
        self.className = [...s].join(' ');
      },
      remove: (c) => {
        self.className = self.className.split(/\s+/).filter((x) => x && x !== c).join(' ');
      },
      contains: (c) => self.className.split(/\s+/).includes(c),
    };
  }
  get firstChild() {
    return this.children[0] || null;
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this.children.forEach((c) => (c.parentNode = null));
    this.children = [];
    this._text = String(v);
  }
  get src() {
    return this._src;
  }
  set src(v) {
    this._src = v;
    srcLog.push(v);
  }
  appendChild(c) {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  append(...cs) {
    cs.forEach((c) => this.appendChild(c));
  }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  addEventListener(t, fn) {
    (this.listeners[t] = this.listeners[t] || []).push(fn);
  }
  removeEventListener(t, fn) {
    this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn);
  }
  dispatch(t, e = {}) {
    for (const fn of [...(this.listeners[t] || [])]) fn({ type: t, preventDefault() {}, stopPropagation() {}, ...e });
  }
  click() {
    this.dispatch('click');
  }
  focus() {}
}
const srcLog = [];
function makeDoc() {
  const doc = new FakeEl('#document');
  doc.body = new FakeEl('body');
  doc.createElement = (t) => new FakeEl(t);
  return doc;
}
const walk = (el, fn) => {
  fn(el);
  el.children.forEach((c) => walk(c, fn));
};
const find = (root, cls) => {
  let out = null;
  walk(root, (e) => {
    if (!out && e.className.split(/\s+/).includes(cls)) out = e;
  });
  return out;
};
const findAll = (root, cls) => {
  const out = [];
  walk(root, (e) => {
    if (e.className.split(/\s+/).includes(cls)) out.push(e);
  });
  return out;
};
// 目前可見的文字（hidden 的子樹不算）
const visibleText = (el) => (el.hidden ? '' : el._text + el.children.map(visibleText).join(''));
const key = (doc, code) => doc.dispatch('keydown', { code, repeat: false });

// ---------- 載入 ----------
const fs = await import('node:fs');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');
const THREE = await import('three');
const { landmarkPoints } = await import('../../src/core/landmark-points.js');
const { createBus } = await import('../../src/core/events.js');
const catalogMod = await import('../../src/missions/catalog.js');
const M = await import('../../src/missions/index.js');
const { createMissions, COOLDOWN_SEC, impactDamagePct, settleReward } = M;
const { BUILTIN_MISSIONS, normalizeCatalog, loadCatalog } = catalogMod;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifestList = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/models/manifest.json'), 'utf8'));
const LANDMARKS = landmarkPoints(manifestList);
const LM = Object.fromEntries(LANDMARKS.map((l) => [l.slug, l]));

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

let errors = 0;
const origError = console.error;
console.error = (...a) => {
  errors++;
  origError(...a);
};

// ---------- 測試用 manifest（文案全部與內建不同）----------
const MANIFEST = {
  items: [
    { slug: 'test-timed', name: '測試限時貨', file: 'timed.png', title: '測試限時委託', brief: '測試文案甲', client: '測試委託人甲', from: 'taichung_city_hall', to: 222636758, timeLimitSec: 200, reward: 400, conditions: ['timed'] },
    { slug: 'test-fragile', name: '測試易碎貨', file: 'fragile.png', title: '測試易碎委託', text: '測試文案乙', client: '測試委託人乙', start: '148849083', end: 'national_taichung_theater', reward: 500, conditions: ['fragile'] },
    { slug: 'test-heavy', title: '測試超重委託', desc: '測試文案丙', client: '測試委託人丙', from: 'qiuhonggu_pavilion', to: 'lin_hotel', reward: 600, conditions: 'heavy' },
    { slug: 'test-plain', name: '測試一般貨', title: '測試一般委託', brief: '測試文案丁', client: '測試委託人丁', from: 'tiger_city', to: 'top_city', timeLimit: 300, reward: 300, conditions: [] },
    { slug: 'test-lost', title: '對不到的委託', from: 'no_such_place', to: 'tiger_city', reward: 1 },
  ],
};
const okFetch = (data) => async () => JSON.parse(JSON.stringify(data));
const notFound = async () => {
  throw new Error('404');
};
const badJson = async () => {
  throw new SyntaxError('Unexpected token < in JSON');
};
const htmlFallback = async () => '<!doctype html><html></html>';

function setup(opts = {}) {
  const bus = createBus();
  const events = [];
  const names = ['mission:available', 'mission:start', 'mission:stage', 'mission:complete', 'mission:fail', 'nav:destination', 'nav:clear', 'ui:sound'];
  for (const n of names) bus.on(n, (p) => events.push({ n, p }));
  const scene = new THREE.Scene();
  const doc = opts.doc === null ? null : makeDoc();
  const clock = { t: 1000 };
  const money = [];
  const infos = [];
  const rngSeq = opts.rng || (() => 0.42);
  const ms = createMissions({
    bus,
    scene,
    root: doc ? doc.body : null,
    landmarks: LANDMARKS,
    addMoney: (n, reason) => money.push({ n, reason }),
    fetchJson: opts.fetchJson || okFetch(MANIFEST),
    now: () => clock.t,
    rng: rngSeq,
    doc,
    info: (...a) => infos.push(a.join(' ')),
  });
  const of = (n) => events.filter((e) => e.n === n);
  return { bus, events, of, scene, doc, clock, money, infos, ms };
}
// 在某點跑 update（dt 秒，分 0.1 s 步）
function run(env, sec, pos, driving = false) {
  const n = Math.max(1, Math.round(sec / 0.1));
  for (let i = 0; i < n; i++) {
    env.clock.t += 0.1;
    env.ms.update(0.1, { x: pos.x, z: pos.z, driving });
  }
}
const at = (slug, dx = 0) => ({ x: LM[slug].x + dx, z: LM[slug].z });
function acceptAt(env, slug, useKey = true) {
  ensureOffered(env, slug);
  const m = env.ms.catalog().find((c) => c.slug === slug);
  const p = at(m.from.slug);
  env.ms.update(0.016, p);
  const it = env.ms.nearest(p);
  if (!it || it.id !== `mission:${slug}`) return null;
  it.act();
  if (useKey) key(env.doc, 'KeyE');
  else find(env.doc.body, 'ms-btn-primary').click();
  return it;
}
// 讓指定委託出現在開放清單（rng 固定時靠冷卻 / 完成輪替，這裡直接用 retry 釘選以外的公開 API：restore 冷卻其他委託）
function ensureOffered(env, slug) {
  if (env.ms.offers().includes(slug)) return true;
  const cur = env.ms.serialize();
  const others = env.ms.offers();
  const cooldowns = { ...cur.cooldowns, ...Object.fromEntries(others.map((s) => [s, 60])) };
  delete cooldowns[slug];
  env.ms.restore({ ...cur, cooldowns });
  return env.ms.offers().includes(slug);
}

// ======================= 1. catalog =======================
{
  const res = normalizeCatalog(MANIFEST.items, LANDMARKS);
  const bySlug = Object.fromEntries(res.list.map((m) => [m.slug, m]));
  check('catalog：5 筆 → 4 筆可用、1 筆對不到', res.list.length === 4 && res.dropped.length === 1 && res.dropped[0] === 'test-lost');
  check('別名：start/end、數字 id 與字串 id 皆可對應', bySlug['test-fragile'].from.slug === 'shin_kong_mitsukoshi' && bySlug['test-timed'].to.slug === 'taichung_city_council');
  check('別名：text / desc → brief、title → name、timeLimit → timeLimitSec', bySlug['test-fragile'].brief === '測試文案乙' && bySlug['test-heavy'].brief === '測試文案丙' && bySlug['test-heavy'].name === '測試超重委託' && bySlug['test-plain'].timeLimitSec === 300);
  check('conditions 字串 / 陣列皆可、未知條件略過', bySlug['test-heavy'].conditions.join() === 'heavy' && bySlug['test-plain'].conditions.length === 0);
  const top = normalizeCatalog([{ slug: 'x', title: 'X', from: 'tiger_city', to: 'tiger_city' }, { title: 'Y', file: 'y.png', from: 'tiger_city', to: 'lin_hotel' }, { title: 'Z', file: '../evil.png', from: 'tiger_city', to: 'lin_hotel', slug: 'z' }], LANDMARKS);
  check('起訖相同丟棄；缺 slug 用檔名；含路徑的檔名不收', top.list.length === 2 && top.list[0].slug === 'y' && top.list[0].file === 'y.png' && top.list[1].file === '', top.list.map((m) => m.slug + ':' + m.file).join());
  const infos = [];
  const r1 = await loadCatalog({ fetchJson: okFetch(MANIFEST.items), landmarks: LANDMARKS, info: (s) => infos.push(s) });
  check('頂層陣列 manifest 可讀、對不到只 console.info 一次', r1.source === 'manifest' && r1.list.length === 4 && infos.length === 1 && infos[0].includes('test-lost'));
  const builtin = normalizeCatalog(BUILTIN_MISSIONS, LANDMARKS);
  check('內建 3 個委託全部對得到地標且涵蓋三種條件', builtin.list.length === 3 && ['fragile', 'heavy', 'timed'].every((c) => builtin.list.some((m) => m.conditions.includes(c))));
  for (const [label, fj] of [['404', notFound], ['壞 JSON', badJson], ['回退 index.html', htmlFallback], ['全部對不到', okFetch({ items: [MANIFEST.items[4]] })], ['未注入 fetchJson', null]]) {
    const inf = [];
    const r = await loadCatalog({ fetchJson: fj, landmarks: LANDMARKS, info: (s) => inf.push(s) });
    check(`缺檔（${label}）→ 內建 3 個委託、info 一次`, r.source === 'builtin' && r.list.length === 3 && inf.length === 1, `${r.source} ${r.list.length} info×${inf.length}`);
  }
  check('impactDamagePct：< 4 → 0、9.5 → 20、≥ 15 → 40', impactDamagePct(3.9) === 0 && Math.abs(impactDamagePct(9.5) - 20) < 1e-9 && impactDamagePct(15) === 40 && impactDamagePct(40) === 40 && impactDamagePct(NaN) === 0);
  const sr = settleReward(1000, 50, 100, 25);
  check('settleReward：損壞 50% × 0.7、剩 75% 時間 → 加成 22.5%', sr.base === 650 && sr.bonus === 225 && sr.reward === 875, JSON.stringify(sr));
}

// ======================= 2. 開放起點、接單卡 =======================
const E = setup();
{
  const info = await E.ms.ready;
  check('ready：source manifest、4 個委託', info.source === 'manifest' && info.count === 4);
  check('同時開放 3 個起點、mission:available × 3', E.ms.offers().length === 3 && E.of('mission:available').length === 3);
  const beacons = E.scene.children.filter((c) => c.name === 'mission-beacon' && c.visible);
  check('場景有 3 根起點光柱（加色、半透明、不寫深度）', beacons.length === 3 && beacons[0].children[0].material.blending === THREE.AdditiveBlending && beacons[0].children[0].material.transparent && !beacons[0].children[0].material.depthWrite);
  const avail = E.of('mission:available')[0].p;
  check('mission:available payload { id, title, x, z }', typeof avail.id === 'string' && typeof avail.title === 'string' && Number.isFinite(avail.x) && Number.isFinite(avail.z));
  check('對不到的委託 info 一次', E.infos.length === 1);
  const mk = E.ms.markers();
  check('markers：3 個 mission-start、有 label', mk.length === 3 && mk.every((m) => m.kind === 'mission-start' && m.label));
  check('markers() 重用同一陣列與物件', E.ms.markers() === mk && E.ms.markers()[0] === mk[0]);
  check('遠處 nearest → null', E.ms.nearest({ x: 5000, z: 5000 }) === null);
  // 光柱脈動
  const b0 = beacons[0].children[0];
  const o1 = b0.material.opacity;
  E.ms.update(0.7, { x: 5000, z: 5000 });
  check('光柱緩慢脈動（opacity 變化）', Math.abs(b0.material.opacity - o1) > 1e-4);

  ensureOffered(E, 'test-timed');
  const p = at('taichung_city_hall');
  const it = E.ms.nearest(p);
  check('起點 nearest → interactable（priority 3、按 E 接委託：標題）', it && it.priority === 3 && it.text === '按 E 接委託：測試限時委託' && typeof it.act === 'function' && it.dist < 1);
  check('interactable 物件重用', E.ms.nearest(p) === it);
  check('地標 radius + 8 m 內可接、外則否', !!E.ms.nearest(at('taichung_city_hall', 32)) && E.ms.nearest(at('taichung_city_hall', 34)) === null);
  it.act();
  const panel = find(E.doc.body, 'ms-panel');
  check('接單卡開啟、isModalOpen() 為真', !panel.hidden && E.ms.isModalOpen() && panel.dataset.mode === 'offer');
  const txt = visibleText(panel);
  check('接單卡含 標題 / 委託人 / 文案 / 條件 / 報酬 / 限時', ['測試限時委託', '測試委託人甲', '測試文案甲', '限時', 'NT$400', '3:20'].every((s) => txt.includes(s)), txt);
  const btns = findAll(panel, 'ms-btn').map((b) => b.textContent);
  check('按鈕「接下」「算了」', btns.join() === '接下,算了');
  check('圖卡讀 art/cargo/<file>', srcLog.includes('art/cargo/timed.png'));
  const img = find(panel, 'ms-card-img');
  img.dispatch('error');
  check('圖卡缺檔 → 純色卡片 + 貨物名（不丟例外）', img.hidden && !find(panel, 'ms-card-art-name').hidden && /hsl/.test(find(panel, 'ms-card-art').style.background));
  check('面板開啟中 nearest → null', E.ms.nearest(p) === null);
  key(E.doc, 'Escape');
  check('Esc = 算了：關閉、未開始', panel.hidden && !E.ms.isModalOpen() && E.ms.active() === null && E.of('mission:start').length === 0);
  check('ui:sound open / cancel', E.of('ui:sound').map((e) => e.p.kind).join() === 'open,cancel');
}

// ======================= 3. timed 完整流程 =======================
{
  const it = acceptAt(E, 'test-timed');
  const st = E.of('mission:start').at(-1);
  check('按 E = 接下：mission:start { id, title, cargo }', it && st && st.p.id === 'test-timed' && st.p.title === '測試限時委託' && st.p.cargo && st.p.cargo.name === '測試限時貨');
  const stage = E.of('mission:stage').at(-1).p;
  check('mission:stage deliver 指向目的地', stage.stage === 'deliver' && stage.x === LM.taichung_city_council.x && stage.text.includes('臺中市議會'));
  const nav = E.of('nav:destination').at(-1).p;
  check('nav:destination source mission', nav.source === 'mission' && nav.x === LM.taichung_city_council.x && nav.label === '臺中市議會');
  const mk = E.ms.markers();
  check('進行中 markers 只剩 mission-dest', mk.length === 1 && mk[0].kind === 'mission-dest');
  const vis = E.scene.children.filter((c) => c.name === 'mission-beacon' && c.visible);
  check('進行中只顯示目的地光柱', vis.length === 1 && Math.abs(vis[0].position.x - LM.taichung_city_council.x) < 1e-6);
  check('進行中 nearest → null（不能同時接兩單）', E.ms.nearest(at('taichung_city_hall')) === null);
  run(E, 50, at('taichung_city_hall', 60), true);
  const ob = E.ms.objective();
  check('objective：文字 / 倒數 / 距離', ob && ob.text.includes('測試限時貨') && Math.abs(ob.timerSec - 150) < 0.2 && ob.distM > 300 && ob.damagePct === null, JSON.stringify(ob));
  check('objective() 重用同一物件', E.ms.objective() === ob);
  const objEl = find(E.doc.body, 'ms-objective');
  check('自帶目標列顯示倒數 2:30', !objEl.hidden && visibleText(objEl).includes('2:30'), visibleText(objEl));
  check('非 heavy speedScale = 1', E.ms.speedScale() === 1);
  // 抵達（駕駛、radius + 8 內）
  run(E, 0.1, at('taichung_city_council', 30), true);
  const done = E.of('mission:complete').at(-1);
  const exp = settleReward(400, 0, 200, 50.1);
  check('抵達 radius + 8 m 內結算：mission:complete', done && done.p.id === 'test-timed' && done.p.damagePct === 0 && Math.abs(done.p.timeSec - 50.1) < 0.15, JSON.stringify(done && done.p));
  check('提早完成加成 = 剩餘比例 × 30%', done.p.bonus === exp.bonus && done.p.reward === 400 + exp.bonus, `${done.p.bonus} vs ${exp.bonus}`);
  check('addMoney(n, "mission")', E.money.length === 1 && E.money[0].n === done.p.reward && E.money[0].reason === 'mission');
  check('結算後 nav:clear source mission', E.of('nav:clear').at(-1).p.source === 'mission' && E.ms.active() === null);
  const panel = find(E.doc.body, 'ms-panel');
  const t = visibleText(panel);
  check('結算面板：用時 / 報酬 / 加成、「再接一單」「繼續」', panel.dataset.mode === 'result' && t.includes('0:51') && t.includes('提早加成') && findAll(panel, 'ms-btn').map((b) => b.textContent).join() === '再接一單,繼續', t);
  check('冷卻：完成的委託不在開放清單、其餘 3 個全開', !E.ms.offers().includes('test-timed') && E.ms.offers().length === 3);
  const navBefore = E.of('nav:destination').length;
  find(panel, 'ms-btn-primary').click();
  check('「再接一單」：關面板 + 導航到最近起點', panel.hidden && E.of('nav:destination').length === navBefore + 1 && E.of('nav:destination').at(-1).p.source === 'mission');
}

// ======================= 4. fragile：損壞度與結算 =======================
{
  const it = acceptAt(E, 'test-fragile', false);
  check('按「接下」接易碎委託', !!it && E.ms.active() && E.ms.active().slug === 'test-fragile');
  E.ms.onVehicleImpact({ relSpeed: 3 });
  check('relSpeed < 4 不計', E.ms.active().damagePct === 0);
  run(E, 1, at('shin_kong_mitsukoshi', 100), true);
  E.ms.onVehicleImpact({ relSpeed: 9.5 });
  check('9.5 m/s → 20%', Math.abs(E.ms.active().damagePct - 20) < 1e-9);
  E.ms.onVehicleImpact({ relSpeed: 15 });
  check('同一次碰撞（0.3 s 內）的連續回報只計超出部分 → 40%', Math.abs(E.ms.active().damagePct - 40) < 1e-9);
  run(E, 1, at('shin_kong_mitsukoshi', 100), true);
  const ob = E.ms.objective();
  check('objective.damagePct 與目標列損壞度', ob.damagePct === 40 && visibleText(find(E.doc.body, 'ms-objective')).includes('損壞 40%'));
  run(E, 1, at('national_taichung_theater', 10), false);
  const done = E.of('mission:complete').at(-1).p;
  check('易碎結算：報酬 × (1 − 0.4 × 0.7)、無時限無加成', done.id === 'test-fragile' && done.damagePct === 40 && done.reward === Math.round(500 * 0.72) && done.bonus === 0, JSON.stringify(done));
  check('結算面板顯示損壞度', visibleText(find(E.doc.body, 'ms-panel')).includes('40%'));
  key(E.doc, 'Escape');
  check('結算面板 Esc = 繼續', !E.ms.isModalOpen());
}

// ======================= 5. heavy + 冷卻輪替 =======================
{
  const it = acceptAt(E, 'test-heavy');
  check('接超重委託', !!it && E.ms.active().slug === 'test-heavy');
  E.ms.update(0.1, { ...at('qiuhonggu_pavilion', 60), driving: false });
  check('heavy 步行 speedScale() = 0.6', E.ms.speedScale() === 0.6);
  E.ms.update(0.1, { ...at('qiuhonggu_pavilion', 60), driving: true });
  check('heavy 駕駛 speedScale() = 1', E.ms.speedScale() === 1);
  run(E, 1, at('lin_hotel'), false);
  check('heavy 完成後 speedScale() = 1', E.of('mission:complete').at(-1).p.id === 'test-heavy' && E.ms.speedScale() === 1);
  key(E.doc, 'KeyE'); // 結算面板 E = 再接一單
  check('可用委託 < 3 → 開放全部可用者（只剩 test-plain）', E.ms.offers().join() === 'test-plain', E.ms.offers().join());
  const cd = E.ms.serialize().cooldowns;
  check('serialize 冷卻為剩餘秒數（≤ 120）', cd['test-heavy'] === COOLDOWN_SEC && cd['test-timed'] > 0 && cd['test-timed'] < cd['test-heavy'], JSON.stringify(cd));
  // 推進時間：test-timed 剩 cd 秒
  run(E, cd['test-timed'] - 2, { x: 5000, z: 5000 });
  const timedBack = E.ms.offers().includes('test-timed');
  run(E, 4, { x: 5000, z: 5000 });
  check('冷卻 120 s 後委託重新開放（以注入 now() 計）', !timedBack && E.ms.offers().includes('test-timed') && E.ms.offers().length >= 2, E.ms.offers().join());
}

// ======================= 6. 失敗與重試 =======================
{
  const F = setup();
  await F.ms.ready;
  ensureOffered(F, 'test-timed');
  acceptAt(F, 'test-timed');
  run(F, 201, at('taichung_city_hall', 60));
  const fl = F.of('mission:fail').at(-1);
  check('timed 超時 → mission:fail timeout', fl && fl.p.id === 'test-timed' && fl.p.reason === 'timeout');
  const panel = find(F.doc.body, 'ms-panel');
  check('失敗面板 +「重試」、nav:clear', panel.dataset.mode === 'fail' && visibleText(panel).includes('重試') && F.of('nav:clear').length === 1 && F.ms.isModalOpen());
  check('失敗不給錢', F.money.length === 0);
  // 讓 test-timed 被擠出開放清單，驗證「重試」會把它釘回來
  F.ms.update(0.1, { x: 5000, z: 5000 });
  find(panel, 'ms-btn-primary').click();
  const st = F.of('mission:stage').at(-1).p;
  const nav = F.of('nav:destination').at(-1).p;
  check('重試：回起點（stage pickup + nav:destination 指向起點）', st.stage === 'pickup' && st.id === 'test-timed' && nav.x === LM.taichung_city_hall.x && nav.source === 'mission');
  check('重試：該委託保證在開放清單', F.ms.offers().includes('test-timed'));
  F.ms.update(0.1, at('taichung_city_hall', 200));
  check('重試途中目標列提示回起點', visibleText(find(F.doc.body, 'ms-objective')).includes('重接'));
  acceptAt(F, 'test-timed');
  check('重試可重接', F.ms.active() && F.ms.active().slug === 'test-timed');
  F.ms.onPlayerKo();
  check('非易碎被擊倒 → fail ko', F.of('mission:fail').at(-1).p.reason === 'ko');
  key(F.doc, 'Escape');
  ensureOffered(F, 'test-fragile');
  acceptAt(F, 'test-fragile');
  F.ms.onPlayerKo();
  check('易碎被擊倒 → 損壞 +50%，任務繼續', F.ms.active() && F.ms.active().damagePct === 50);
  F.ms.onVehicleImpact({ relSpeed: 20 });
  run(F, 0.5, at('shin_kong_mitsukoshi', 100));
  F.ms.onVehicleImpact({ relSpeed: 12 });
  check('損壞未達 100% 仍進行（50 + 40 + 29）→ 下一撞 100%', F.ms.active() === null && F.of('mission:fail').at(-1).p.reason === 'destroyed', String(F.of('mission:fail').at(-1).p.reason));
  key(F.doc, 'Escape');
  acceptAt(F, 'test-plain');
  F.ms.abandon();
  check('abandon → fail abandon', F.of('mission:fail').at(-1).p.reason === 'abandon' && F.ms.active() === null);
  key(F.doc, 'Escape');
  const failIds = F.of('mission:fail').map((e) => e.p.reason).join();
  check('四種失敗原因全部出現', failIds === 'timeout,ko,destroyed,abandon', failIds);
  F.ms.dispose();
}

// ======================= 7. 存檔往返 =======================
{
  const data = E.ms.serialize();
  check('serialize 形狀 §18', data && typeof data.completed === 'object' && typeof data.best === 'object' && typeof data.cooldowns === 'object' && data.active === null && data.completed['test-timed'] === 1 && data.best['test-timed'] > 0);
  acceptAt(E, 'test-timed');
  const mid = E.ms.serialize();
  check('進行中 serialize active { slug, stage }', mid.active && mid.active.slug === 'test-timed' && mid.active.stage === 'deliver');
  const R = setup();
  R.ms.restore({ ...mid, completed: { ...mid.completed, 'unknown-slug': 3 }, best: { ...mid.best, bad: 'x' }, cooldowns: { 'test-plain': 999, nope: 5 } });
  await R.ms.ready;
  const back = R.ms.serialize();
  check('ready 前 restore 也生效：completed / best 往返', back.completed['test-timed'] === 1 && back.completed['test-fragile'] === 1 && back.best['test-timed'] === mid.best['test-timed']);
  check('未知 slug 丟棄', back.completed['unknown-slug'] === undefined && back.cooldowns.nope === undefined && back.best.bad === undefined);
  check('active 作廢、回到可接狀態', R.ms.active() === null && back.active === null && R.ms.offers().length > 0 && R.of('mission:start').length === 0);
  check('冷卻容錯（上限 120 s）且冷卻中者不開放', back.cooldowns['test-plain'] <= COOLDOWN_SEC && !R.ms.offers().includes('test-plain'));
  E.ms.restore({ completed: 5, best: null, cooldowns: [], active: 'x' });
  check('restore 垃圾資料不丟例外、作廢進行中任務', E.ms.active() === null && E.ms.serialize().active === null && E.of('nav:clear').at(-1).p.source === 'mission');
  E.ms.restore(null);
  check('restore(null) 清空', Object.keys(E.ms.serialize().completed).length === 0);
  R.ms.dispose();
}

// ======================= 8. 文案全部來自 manifest =======================
{
  const builtinStrings = BUILTIN_MISSIONS.flatMap((m) => [m.title, m.name, m.brief, m.client]);
  const payloadText = JSON.stringify(E.events.map((e) => e.p));
  let domText = '';
  walk(E.doc.body, (el) => (domText += el._text + '\n'));
  const hit = builtinStrings.filter((s) => payloadText.includes(s) || domText.includes(s));
  check('有 manifest 時事件與畫面不出現內建文案', hit.length === 0, hit.join(' | '));
  const titles = new Set(MANIFEST.items.map((m) => m.title));
  check('mission:available / start 的 title 全來自 manifest', E.events.filter((e) => e.n === 'mission:available' || e.n === 'mission:start').every((e) => titles.has(e.p.title)));
}

// ======================= 9. 缺檔路徑：內建委託完整跑完 =======================
{
  const B = setup({ fetchJson: notFound });
  const info = await B.ms.ready;
  check('404 → 內建 3 個委託、全開', info.source === 'builtin' && B.ms.offers().length === 3 && B.infos.length === 1);
  acceptAt(B, 'backup-backup-mic');
  const panelArt = find(B.doc.body, 'ms-card-art');
  check('內建委託（無圖）接單後面板關閉', !B.ms.isModalOpen() && panelArt === null);
  run(B, 2, at('taichung_city_council'), true);
  const done = B.of('mission:complete').at(-1);
  check('內建 timed 委託完成、有加成', done && done.p.id === 'backup-backup-mic' && done.p.bonus > 0);
  key(B.doc, 'KeyE');
  check('完成 1 個後可用 2 個 → 開放 2 個', B.ms.offers().length === 2);
  const beforeChildren = B.doc.body.children.length;
  const inScene = () => B.scene.children.filter((c) => c.name === 'mission-beacon').length;
  const beaconsBefore = inScene();
  B.ms.dispose();
  check('dispose：移除 DOM 與光柱', beforeChildren === 2 && B.doc.body.children.length === 0 && beaconsBefore === 2 && inScene() === 0);
  B.ms.update(0.1, { x: 0, z: 0 });
  check('dispose 後呼叫安全', B.ms.nearest({ x: 0, z: 0 }) === null);
}

// ======================= 10. 無 DOM（node / headless）=======================
{
  const H = setup({ doc: null, fetchJson: htmlFallback });
  await H.ms.ready;
  const m = H.ms.catalog().find((c) => c.slug === 'swimming-lake-water');
  ensureOffered(H, 'swimming-lake-water');
  H.ms.update(0.1, at(m.from.slug));
  H.ms.nearest(at(m.from.slug)).act();
  check('無 DOM：act() 直接接單、isModalOpen 恆假', H.ms.active() && H.ms.active().slug === 'swimming-lake-water' && !H.ms.isModalOpen());
  H.ms.dispose();
}

// ======================= 10b. 美術實檔 manifest（public/art/cargo/manifest.json）=======================
{
  const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/art/cargo/manifest.json'), 'utf8'));
  // 12 筆時 ensureOffered 只冷卻目前開放者不夠：其餘全部冷卻，只留指定委託
  const offerOnly = (env, slug) => {
    const cooldowns = Object.fromEntries(env.ms.catalog().filter((c) => c.slug !== slug).map((c) => [c.slug, 60]));
    env.ms.restore({ ...env.ms.serialize(), cooldowns });
    return env.ms.offers().includes(slug);
  };
  const items = real.items;
  const inf = [];
  const r = await loadCatalog({ fetchJson: okFetch(real), landmarks: LANDMARKS, info: (s) => inf.push(s) });
  check('實檔：12 筆全解析（數字 id / slug 起訖）、無丟棄、無 info', items.length === 12 && r.source === 'manifest' && r.list.length === 12 && r.dropped.length === 0 && inf.length === 0, `${r.list.length} dropped ${r.dropped.join()}`);
  const fileCount = (c) => items.filter((it) => Array.isArray(it.tags) && it.tags.includes(c)).length;
  const listCount = (c) => r.list.filter((m) => m.conditions.includes(c)).length;
  const counts = ['fragile', 'heavy', 'timed'].map((c) => `${c} ${listCount(c)}/${fileCount(c)}`).join('、');
  check('實檔：conditions 取自 tags，fragile / heavy / timed 計數與實檔一致（5 / 3 / 3）', ['fragile', 'heavy', 'timed'].every((c) => listCount(c) === fileCount(c)) && listCount('fragile') === 5 && listCount('heavy') === 3 && listCount('timed') === 3, counts);
  const by = Object.fromEntries(r.list.map((m) => [m.slug, m]));
  const chili = by['chili-sauce-bathtub'];
  check('未知 tag（smelly）不進 conditions、保留在 tags', chili && chili.conditions.join() === 'heavy' && chili.tags.join() === 'heavy,smelly', chili && `${chili.conditions} / ${chili.tags}`);
  check('無 tag 的委託：conditions / tags 皆空', by['tiger-balloon'] && by['tiger-balloon'].conditions.length === 0 && by['tiger-balloon'].tags.length === 0);
  check('實檔 timeLimit → timeLimitSec 全數讀到、distance / reward / 圖檔名保留', r.list.every((m, i) => m.timeLimitSec === items[i].timeLimit && m.distance === items[i].distance && m.reward === items[i].reward && m.file === items[i].file));
  const fromNum = by['glowing-sun-cakes'];
  check('from 數字 id、to slug 皆對應到地標', fromNum && fromNum.from.id !== undefined && String(fromNum.from.id) === '150999799' && fromNum.to.slug === 'qiuhonggu_pavilion');

  // 非 timed 委託超時不失敗；UI 顯示建議時間而非倒數
  const X = setup({ fetchJson: okFetch(real) });
  await X.ms.ready;
  const plain = by['tiger-balloon'];
  offerOnly(X, 'tiger-balloon');
  const it = acceptAt(X, 'tiger-balloon');
  const st = X.of('mission:start').at(-1);
  check('非 timed 接單：mission:start cargo.timeLimitSec = 0、suggestSec = 實檔 timeLimit、帶 tags', it && st && st.p.id === 'tiger-balloon' && st.p.cargo.timeLimitSec === 0 && st.p.cargo.suggestSec === plain.timeLimitSec && Array.isArray(st.p.cargo.tags), st && JSON.stringify(st.p.cargo));
  run(X, 2, at(plain.from.slug));
  const ob = X.ms.objective();
  const hudText = visibleText(find(X.doc.body, 'ms-obj-timer'));
  check('非 timed：objective.timerSec = null、suggestSec = 建議時間；目標列顯示「建議 3:15」（不倒數）', ob && ob.timerSec === null && ob.suggestSec === 195 && hudText === '建議 3:15' && X.ms.active().timerSec === null && X.ms.active().suggestSec === 195, `${JSON.stringify(ob)} [${hudText}]`);
  run(X, plain.timeLimitSec + 30, at(plain.from.slug));
  check('非 timed：超過 timeLimit 仍進行中、無 mission:fail', X.ms.active() && X.ms.active().slug === 'tiger-balloon' && X.of('mission:fail').length === 0 && visibleText(find(X.doc.body, 'ms-obj-timer')) === '建議 3:15');
  run(X, 0.2, at(plain.to.slug));
  const done = X.of('mission:complete').at(-1);
  check('非 timed：超時後送達仍完成，提早加成 = 0、基本報酬照給', done && done.p.id === 'tiger-balloon' && done.p.bonus === 0 && done.p.reward === plain.reward, done && JSON.stringify(done.p));
  key(X.doc, 'Escape');
  X.ms.update(0.1, at(plain.to.slug));

  // 非 timed 提早送達 → 以 timeLimit 為基準的加成
  const Y = setup({ fetchJson: okFetch(real) });
  await Y.ms.ready;
  offerOnly(Y, 'tiger-balloon');
  acceptAt(Y, 'tiger-balloon');
  run(Y, 0.2, at(plain.to.slug));
  const early = Y.of('mission:complete').at(-1);
  check('非 timed：提早送達有加成（timeLimit 為基準）', early && early.p.bonus > 0 && early.p.reward > plain.reward, early && JSON.stringify(early.p));
  Y.ms.dispose();

  // timed 委託照常倒數、超時失敗
  const Z = setup({ fetchJson: okFetch(real) });
  await Z.ms.ready;
  const seal = by['giant-official-seal'];
  offerOnly(Z, 'giant-official-seal');
  acceptAt(Z, 'giant-official-seal');
  const zs = Z.of('mission:start').at(-1);
  run(Z, 5, at(seal.from.slug));
  const zo = Z.ms.objective();
  check('timed：cargo.timeLimitSec = 105、objective 倒數', zs && zs.p.cargo.timeLimitSec === 105 && zs.p.cargo.suggestSec === 0 && zo && Math.abs(zo.timerSec - 100) < 0.2 && zo.suggestSec === null, zo && JSON.stringify(zo));
  run(Z, seal.timeLimitSec, at(seal.from.slug));
  const zf = Z.of('mission:fail').at(-1);
  check('timed：超時判失敗（timeout）', zf && zf.p.id === 'giant-official-seal' && zf.p.reason === 'timeout' && Z.ms.active() === null);
  Z.ms.dispose();
  X.ms.dispose();
}

// ======================= 11. CSS 靜態檢查 =======================
{
  const css = fs.readFileSync(path.join(ROOT, 'src/missions/missions.css'), 'utf8');
  const block = (sel) => {
    const i = css.indexOf(`${sel} {`);
    return i < 0 ? '' : css.slice(i, css.indexOf('}', i));
  };
  const btnH = Number((block('.ms-btn').match(/min-height:\s*(\d+)px/) || [])[1]);
  check('面板按鈕 min-height ≥ 44 px', btnH >= 44, String(btnH));
  check('目標列 z-index 55、面板 z-index 85', /z-index:\s*55/.test(block('.ms-hud')) && /z-index:\s*85/.test(block('.ms-panel')));
  check('safe-area 與直向排版', css.includes('env(safe-area-inset-top)') && css.includes('env(safe-area-inset-bottom)') && css.includes('orientation: portrait'));
  const classes = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-z][\w-]*)/g)].map((m) => m[1]).filter((c) => c !== 'touch');
  check('CSS class 全部 ms- 前綴', classes.every((c) => c.startsWith('ms-')), classes.filter((c) => !c.startsWith('ms-')).join());
  const src = ['index.js', 'ui.js', 'catalog.js', 'light-pillar.js', 'events.js'].map((f) => fs.readFileSync(path.join(ROOT, 'src/missions', f), 'utf8')).join('\n');
  check('不用 alert / confirm、不讀寫 main.js / hud.js', !/\b(alert|confirm)\s*\(/.test(src) && !/from '\.\.\/(main|hud)\.js'/.test(src));
}

console.error = origError;
check('全程無 console.error', errors === 0, String(errors));
console.log(failed ? `FAIL ${failed}/${passed + failed}` : `PASS ${passed}/${passed + failed}`);
process.exit(failed ? 1 : 0);
