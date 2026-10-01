#!/usr/bin/env node
// 時段限定事件（夜市外送，src/missions/events.js）無頭驗證 + 與送貨委託（missions/index.js）的整合
// 用法：node tools/test/missions-events.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// three 以 loader hook 換成最小替身（光柱池只用到 Group / Mesh / 材質的屬性），.json → ES module、.css → 空字串；
//   因此不需要 node_modules 也能跑；路網用 citymodel surfaceRoads + navigation buildRoadGraph / findRoute（皆不需要真 three）
// 項目：時段判斷（含跨午夜）；時段內出現 / 時段外不出現；取餐 → 送達 → 獎勵（沿路網距離算時限）；逾時失敗不扣錢；
//   冷卻後可重複觸發、冷卻結束但已出時段不出現；repeatable false；獎勵對距離 / 剩餘秒數單調；取餐點座標落在真實道路上；
//   createMissions 整合：無時刻來源 / 時段外 / events:false 三者與原行為逐事件一致；委託與事件互斥；存檔往返；
//   委託統計 trackMissionStats：事件完成 missionsDone +1、逾時 / 放棄 missionsFailed +1、委託 + 事件各一次不重複計數
import { register } from 'node:module';

const THREE_STUB = `
class V { constructor() { this.x = 0; this.y = 0; this.z = 0; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } }
class C { setHex(h) { this.hex = h; return this; } }
export class Object3D { constructor() { this.position = new V(); this.scale = new V(); this.children = []; this.parent = null; this.visible = true; }
  add(...o) { for (const c of o) { if (c.parent) c.parent.remove(c); c.parent = this; this.children.push(c); } return this; }
  remove(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parent = null; return this; } }
export class Group extends Object3D {}
export class Scene extends Object3D {}
export class Mesh extends Object3D { constructor(g, m) { super(); this.geometry = g; this.material = m; } }
export class MeshBasicMaterial { constructor(o = {}) { Object.assign(this, o); this.color = new C(); } dispose() {} }
export class CylinderGeometry { translate() { return this; } dispose() {} }
export const AdditiveBlending = 2;
export const DoubleSide = 2;
export default {};
`;
const HOOK = `
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const STUB = ${JSON.stringify(THREE_STUB)};
export async function resolve(spec, context, next) {
  if (spec === 'three') return { url: 'data:text/javascript,' + encodeURIComponent(STUB), shortCircuit: true };
  return next(spec, context);
}
export async function load(url, context, next) {
  if (url.endsWith('.json')) return { format: 'module', shortCircuit: true, source: 'export default ' + readFileSync(fileURLToPath(url), 'utf8') + ';' };
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default "";' };
  return next(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(HOOK)}`, import.meta.url);

const fs = await import('node:fs');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');
const EV = await import('../../src/missions/events.js');
const { createMissions, trackMissionStats, MISSION_STAT_EVENTS } = await import('../../src/missions/index.js');
const { createBus } = await import('../../src/core/events.js');
const { buildRoadGraph, findRoute } = await import('../../src/navigation.js');
const { surfaceRoads } = await import('../../src/citymodel.js');
const osm = (await import('../../src/data/osm-city.json')).default;
const { createTimedEvents, inHourWindow, eventReward, eventTimeLimit, NIGHT_MARKET_DELIVERY: NM } = EV;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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

// 測試用地標：內建委託用到的 6 個 slug，座標取 OSM 同名建物附近（只需互相分開、離取餐點 ≥ 150 m）
const LANDMARKS = [
  { id: 148849083, slug: 'shin_kong_mitsukoshi', name: '新光三越', x: 584, z: -91, radius: 25 },
  { id: 'national_taichung_theater', slug: 'national_taichung_theater', name: '臺中國家歌劇院', x: 330, z: 380, radius: 25 },
  { id: 'taichung_city_hall', slug: 'taichung_city_hall', name: '臺中市政府', x: 820, z: 470, radius: 25 },
  { id: 222636758, slug: 'taichung_city_council', name: '臺中市議會', x: 1010, z: 400, radius: 25 },
  { id: 'qiuhonggu_pavilion', slug: 'qiuhonggu_pavilion', name: '秋紅谷', x: 120, z: -330, radius: 15 },
  { id: 'lin_hotel', slug: 'lin_hotel', name: '林酒店', x: -150, z: -420, radius: 25 },
];
const graph = buildRoadGraph(surfaceRoads);
const routeLength = (a, b) => {
  const r = findRoute(graph, a, b);
  return r ? r.lengthM : null;
};

function setupEvents(opts = {}) {
  const clock = { t: 1000, hour: opts.hour ?? 20 };
  const money = [];
  const log = [];
  const ev = createTimedEvents({
    defs: opts.defs,
    getGameHour: opts.noHour ? null : () => clock.hour,
    destinations: opts.destinations || LANDMARKS,
    routeLength: opts.routeLength === undefined ? routeLength : opts.routeLength,
    addMoney: (n, reason) => money.push({ n, reason }),
    bus: { emit: (n, p) => log.push({ n, p }) },
    now: () => clock.t,
    rng: opts.rng || (() => 0.5),
  });
  const of = (n) => log.filter((e) => e.n === n);
  const step = (sec, pos, extra = {}) => {
    const n = Math.max(1, Math.round(sec / 0.1));
    for (let i = 0; i < n; i++) {
      clock.t += 0.1;
      ev.update(0.1, { x: pos.x, z: pos.z, ...extra });
    }
  };
  return { ev, clock, money, log, of, step };
}
const PICK = { x: NM.pickup.x, z: NM.pickup.z };
const FAR = { x: -500, z: 800 };

// ======================= 1. 純函式 =======================
{
  check('時段 18–24：17.99 否、18 是、23.99 是、0 否', !inHourWindow(17.99, 18, 24) && inHourWindow(18, 18, 24) && inHourWindow(23.99, 18, 24) && !inHourWindow(0, 18, 24) && !inHourWindow(24, 18, 24));
  check('跨午夜 22–2：23、1.5 是；2、12、21.9 否', inHourWindow(23, 22, 2) && inHourWindow(1.5, 22, 2) && !inHourWindow(2, 22, 2) && !inHourWindow(12, 22, 2) && !inHourWindow(21.9, 22, 2));
  check('時刻非有限數 → 否；超過 24 取模', !inHourWindow(NaN, 18, 24) && !inHourWindow(null, 18, 24) && inHourWindow(44, 18, 24));
  let mono = true;
  for (let d = 0; d <= 3000; d += 250) for (let l = 0; l <= 300; l += 25) {
    if (!(eventReward(d + 250, l) > eventReward(d, l)) || !(eventReward(d, l + 25) > eventReward(d, l))) mono = false;
  }
  check('獎勵：距離 / 剩餘秒數各自嚴格遞增', mono);
  let monoRatio = true;
  for (let d = 200; d <= 3000; d += 200) for (const r of [0, 0.25, 0.5, 1]) if (!(eventReward(d + 200, eventTimeLimit(d + 200) * r) > eventReward(d, eventTimeLimit(d) * r))) monoRatio = false;
  check('獎勵：同剩餘時間比例下，距離越遠越多', monoRatio);
  check('時限隨距離遞增且 > 0', eventTimeLimit(0) > 0 && eventTimeLimit(1000) > eventTimeLimit(500));
}

// ======================= 2. 取餐點是真實道路上的點、靠近真實商圈 =======================
{
  const b = osm.B.find((x) => x.i === 148849083);
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < b.p.length; i += 2) {
    cx += b.p[i];
    cz += b.p[i + 1];
  }
  cx /= b.p.length / 2;
  cz /= b.p.length / 2;
  let bestRoad = Infinity;
  for (const r of surfaceRoads) {
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1];
      const c = r.pts[i];
      const dx = c.x - a.x;
      const dz = c.z - a.z;
      const L = dx * dx + dz * dz;
      const t = L ? Math.max(0, Math.min(1, ((PICK.x - a.x) * dx + (PICK.z - a.z) * dz) / L)) : 0;
      bestRoad = Math.min(bestRoad, Math.hypot(a.x + t * dx - PICK.x, a.z + t * dz - PICK.z));
    }
  }
  check('取餐點在車道中心線 1 m 內（步行 / 駕駛皆可到）', bestRoad < 1, bestRoad.toFixed(2));
  check('取餐點距新光三越輪廓中心 < 60 m、在地圖界內', b.n === '新光三越' && Math.hypot(cx - PICK.x, cz - PICK.z) < 60 && PICK.x > osm.bounds.x0 && PICK.x < osm.bounds.x1 && PICK.z > osm.bounds.z0 && PICK.z < osm.bounds.z1);
  const r = findRoute(graph, PICK, LANDMARKS[1]);
  check('路網查得到取餐點 → 地標的路線，且 ≥ 直線距離', r && r.lengthM >= Math.hypot(LANDMARKS[1].x - PICK.x, LANDMARKS[1].z - PICK.z), r && r.lengthM.toFixed(0));
}

// ======================= 3. 時段內出現 / 時段外不出現 =======================
{
  const E = setupEvents({ hour: 12 });
  E.step(0.5, PICK);
  check('時段外（12 時）：取餐點不出現（nearest / markers / offers 皆空、無 event:available）', E.ev.nearest(PICK) === null && E.ev.markers().length === 0 && E.ev.offers().length === 0 && E.of('event:available').length === 0);
  E.clock.hour = 18.5;
  E.step(0.1, PICK);
  const it = E.ev.nearest(PICK);
  check('進入時段（18:30）：取餐點出現、event:available 一次、priority 3', it && it.id === `event:${NM.id}` && it.priority === 3 && E.of('event:available').length === 1 && E.ev.markers()[0].kind === 'event-start');
  check('取餐點只在半徑內可互動', E.ev.nearest({ x: PICK.x + NM.pickup.radius + 1, z: PICK.z }) === null && E.ev.nearest({ x: PICK.x + NM.pickup.radius - 1, z: PICK.z }) !== null);
  E.clock.hour = 0.2;
  E.step(0.1, PICK);
  check('跨過午夜（00:12）：取餐點收起、event:closed', E.ev.nearest(PICK) === null && E.of('event:closed').length === 1 && E.ev.markers().length === 0);
  const N = setupEvents({ noHour: true });
  N.step(0.5, PICK);
  check('沒有時刻來源：事件完全不出現', N.ev.offers().length === 0 && N.ev.hour() === null && N.log.length === 0);
  N.step(0.1, PICK, { gameHour: 19 });
  check('update ctx.gameHour 也可作為時刻來源', N.ev.offers().includes(NM.id) && N.ev.hour() === 19);
  const X = setupEvents({ hour: 23, defs: [{ ...NM, id: 'late', window: { start: 22, end: 2 } }] });
  X.step(0.1, PICK);
  const x1 = X.ev.offers().includes('late');
  X.clock.hour = 1;
  X.step(0.1, PICK);
  const x2 = X.ev.offers().includes('late');
  X.clock.hour = 3;
  X.step(0.1, PICK);
  check('跨午夜時段 22–2：23 時 / 1 時出現、3 時不出現', x1 && x2 && !X.ev.offers().includes('late'));
}

// ======================= 4. 取餐 → 送達 → 獎勵 =======================
{
  const E = setupEvents({ hour: 20 });
  E.step(0.1, PICK);
  E.ev.nearest(PICK).act();
  const st = E.of('event:start').at(-1);
  const a = E.ev.active();
  const expectRoute = routeLength(PICK, a.to);
  check('取餐：event:start、nav:destination source event、取餐點收起', st && E.of('nav:destination').at(-1).p.source === 'event' && E.ev.nearest(PICK) === null && E.ev.offers().length === 0);
  check('送達點為既有地標、離取餐點 ≥ minDestM', LANDMARKS.includes(a.to) && Math.hypot(a.to.x - PICK.x, a.to.z - PICK.z) >= NM.minDestM);
  check('時限 = eventTimeLimit(路網距離)', Math.abs(a.routeM - expectRoute) < 1e-6 && a.limitSec === eventTimeLimit(expectRoute) && st.p.limitSec === a.limitSec, `${a.routeM.toFixed(0)} m / ${a.limitSec} s`);
  check('markers 只剩送達點', E.ev.markers().length === 1 && E.ev.markers()[0].kind === 'event-dest');
  E.step(20, PICK);
  const o = E.ev.objective();
  check('objective 倒數與即時獎勵', o && Math.abs(o.timerSec - (a.limitSec - 20)) < 0.3 && o.rewardNow === eventReward(a.routeM, o.timerSec));
  const left = E.ev.active().timerSec - 0.1; // active() 回傳重用物件：重新取一次才是最新值
  E.step(0.1, a.to);
  const c = E.of('event:complete').at(-1);
  check('送達結算：event:complete、addMoney(reason event) = eventReward(路線, 剩餘秒)', c && E.money.length === 1 && E.money[0].reason === 'event' && E.money[0].n === c.p.reward && c.p.reward === eventReward(a.routeM, left), JSON.stringify(c && c.p));
  check('結算後 nav:clear source event、active null', E.of('nav:clear').at(-1).p.source === 'event' && E.ev.active() === null);
  check('完成後冷卻中：取餐點不出現', E.ev.offers().length === 0 && E.ev.nearest(PICK) === null);
  E.step(NM.cooldownSec - 1, FAR);
  check('冷卻未滿仍不出現', E.ev.offers().length === 0);
  E.step(1.2, FAR);
  check('冷卻結束且仍在時段內：再次出現（可重複）', E.ev.offers().includes(NM.id) && E.of('event:available').length === 2);
  E.ev.nearest(PICK).act();
  E.step(0.1, E.ev.active().to);
  check('第二趟一樣可完成、completed 計 2', E.of('event:complete').length === 2 && E.ev.serialize().completed[NM.id] === 2);
  E.clock.hour = 10;
  E.step(NM.cooldownSec + 1, FAR);
  check('冷卻結束但已出時段：不出現', E.ev.offers().length === 0);
  E.clock.hour = 18;
  E.step(0.1, FAR);
  check('回到時段：再出現', E.ev.offers().includes(NM.id));
}

// ======================= 5. 逾時失敗不扣錢、獎勵與距離 / 剩餘時間 =======================
{
  const E = setupEvents({ hour: 21 });
  E.step(0.1, PICK);
  E.ev.nearest(PICK).act();
  const lim = E.ev.active().limitSec;
  E.step(lim + 0.5, PICK);
  const f = E.of('event:fail').at(-1);
  check('逾時失敗：event:fail timeout、沒有任何 addMoney（不扣也不給）', f && f.p.reason === 'timeout' && E.money.length === 0 && E.ev.active() === null);
  check('失敗後（failCooldownSec 0）仍在時段內立即可再接', E.ev.offers().includes(NM.id));
  E.ev.nearest(PICK).act();
  E.ev.abandon();
  check('abandon：event:fail abandon、不扣錢', E.of('event:fail').at(-1).p.reason === 'abandon' && E.money.length === 0);
  E.clock.hour = 23.9;
  E.step(0.1, PICK);
  E.ev.nearest(PICK).act();
  E.clock.hour = 0.5;
  E.step(1, PICK);
  check('已取餐後跨出時段：外送不作廢、可繼續送', E.ev.active() !== null);
  E.step(0.1, E.ev.active().to);
  check('跨出時段後送達仍領獎勵', E.money.length === 1 && E.of('event:complete').length === 1);

  // 同一送達點：越早到越多
  const run = (waitSec) => {
    const R = setupEvents({ hour: 20, destinations: [LANDMARKS[1]] });
    R.step(0.1, PICK);
    R.ev.nearest(PICK).act();
    R.step(waitSec, FAR);
    R.step(0.1, LANDMARKS[1]);
    return R.money[0] ? R.money[0].n : 0;
  };
  const r10 = run(10);
  const r60 = run(60);
  check('同一路線：剩餘時間越多獎勵越高', r10 > r60 && r60 > 0, `${r10} > ${r60}`);
  // 不同送達點、同樣耗時：越遠越多
  const runTo = (lm) => {
    const R = setupEvents({ hour: 20, destinations: [lm] });
    R.step(0.1, PICK);
    R.ev.nearest(PICK).act();
    const a = R.ev.active();
    R.step(10, FAR);
    R.step(0.1, lm);
    return { n: R.money[0].n, m: a.routeM };
  };
  const near = runTo(LANDMARKS[4]);
  const far = runTo(LANDMARKS[3]);
  check('同樣耗時：路線越遠獎勵越高', far.m > near.m && far.n > near.n, `${near.m.toFixed(0)} m→${near.n}；${far.m.toFixed(0)} m→${far.n}`);
  const noNav = setupEvents({ hour: 20, routeLength: () => null, destinations: [LANDMARKS[1]] });
  noNav.step(0.1, PICK);
  noNav.ev.nearest(PICK).act();
  const d1 = Math.hypot(LANDMARKS[1].x - PICK.x, LANDMARKS[1].z - PICK.z);
  check('路網查不到 → 直線 × 1.3 估算', Math.abs(noNav.ev.active().routeM - d1 * EV.ROUTE_FALLBACK_K) < 1e-6);
  const empty = setupEvents({ hour: 20, destinations: [LANDMARKS[0]] });
  empty.step(0.1, PICK);
  check('沒有夠遠的送達點：事件不開放', empty.ev.offers().length === 0);
  const once = setupEvents({ hour: 20, defs: [{ ...NM, id: 'once', repeatable: false, cooldownSec: 5 }] });
  once.step(0.1, PICK);
  once.ev.nearest(PICK).act();
  once.step(0.1, once.ev.active().to);
  once.step(10, FAR);
  check('repeatable false：完成一次後不再出現', once.ev.offers().length === 0 && once.of('event:complete').length === 1);
  // 存檔往返
  const s = setupEvents({ hour: 20 });
  s.step(0.1, PICK);
  s.ev.nearest(PICK).act();
  s.step(0.1, s.ev.active().to);
  const data = s.ev.serialize();
  const r2 = setupEvents({ hour: 20 });
  r2.ev.restore({ ...data, cooldowns: { ...data.cooldowns, nope: 3 }, completed: { ...data.completed, junk: 'x' } });
  r2.step(0.1, PICK);
  check('存檔往返：completed / 冷卻還原、未知 id 丟棄、冷卻中不出現', r2.ev.serialize().completed[NM.id] === 1 && r2.ev.serialize().cooldowns[NM.id] > 0 && r2.ev.serialize().cooldowns.nope === undefined && r2.ev.offers().length === 0);
  r2.ev.restore('garbage');
  r2.step(0.1, PICK);
  check('restore 垃圾資料不丟例外、清空', Object.keys(r2.ev.serialize().completed).length === 0 && r2.ev.offers().includes(NM.id));
}

// ======================= 6. createMissions 整合：既有委託不受影響 =======================
const okFetch = (data) => async () => JSON.parse(JSON.stringify(data));
const notFound = async () => {
  throw new Error('404');
};
function setupMs(extra = {}, ctxHour) {
  const bus = createBus();
  const log = [];
  const names = ['mission:available', 'mission:start', 'mission:stage', 'mission:complete', 'mission:fail', 'nav:destination', 'nav:clear', 'ui:sound', 'event:available', 'event:closed', 'event:start', 'event:complete', 'event:fail'];
  for (const n of names) bus.on(n, (p) => log.push({ n, p }));
  const clock = { t: 1000 };
  const money = [];
  const ms = createMissions({ bus, scene: null, root: null, doc: null, landmarks: LANDMARKS, addMoney: (n, r) => money.push({ n, r }), fetchJson: extra.fetchJson || notFound, now: () => clock.t, rng: () => 0.42, info: () => {}, ...extra });
  const step = (sec, pos) => {
    const n = Math.max(1, Math.round(sec / 0.1));
    for (let i = 0; i < n; i++) {
      clock.t += 0.1;
      ms.update(0.1, ctxHour === undefined ? { x: pos.x, z: pos.z } : { x: pos.x, z: pos.z, gameHour: ctxHour });
    }
  };
  return { ms, bus, log, money, clock, step, of: (n) => log.filter((e) => e.n === n) };
}
// 固定劇本：接第一個開放委託 → 送達 → 再接一個 → 逾時 / 放棄 → 存檔
async function scenario(env) {
  await env.ms.ready;
  env.step(0.2, FAR);
  const trace = [];
  for (let k = 0; k < 2; k++) {
    const slug = env.ms.offers()[0];
    const m = env.ms.catalog().find((c) => c.slug === slug);
    env.step(0.1, m.from);
    const it = env.ms.nearest(m.from);
    trace.push(it && it.id);
    if (it) it.act();
    env.step(3, m.from);
    trace.push(JSON.stringify(env.ms.objective()));
    if (k === 0) env.step(0.1, m.to);
    else env.ms.abandon();
    trace.push(env.ms.offers().join());
  }
  trace.push(JSON.stringify(env.ms.markers()));
  trace.push(JSON.stringify(env.ms.serialize()));
  return { trace: trace.join('|'), log: JSON.stringify(env.log.filter((e) => !e.n.startsWith('event:'))), money: JSON.stringify(env.money) };
}
{
  const base = await scenario(setupMs({ events: false }));
  const noHour = await scenario(setupMs({}));
  const dayHour = await scenario(setupMs({ getGameHour: () => 12, routeLength }));
  const dayCtx = await scenario(setupMs({ routeLength }, 9));
  check('無時刻來源：委託劇本逐事件 / 金錢 / 存檔與 events:false 一致', noHour.trace === base.trace && noHour.log === base.log && noHour.money === base.money);
  check('時段外（getGameHour 12 時）：與 events:false 一致', dayHour.trace === base.trace && dayHour.log === base.log && dayHour.money === base.money);
  check('時段外（ctx.gameHour 9 時）：與 events:false 一致', dayCtx.trace === base.trace && dayCtx.log === base.log && dayCtx.money === base.money);
  const night = setupMs({ getGameHour: () => 20, routeLength });
  const nightRes = await scenario(night);
  check('夜市時段內：委託流程（接單 / 結算 / 放棄 / 金錢）仍與原行為一致', nightRes.money === base.money && night.of('mission:complete').length === 1 && night.of('mission:fail').at(-1).p.reason === 'abandon');
  check('夜市時段內：委託報酬不變、事件不送 mission:* 事件', night.of('mission:complete')[0].p.reward === JSON.parse(base.money)[0].n && night.of('event:available').length >= 1);
  check('createMissions markers 附加 event-start 標記', night.ms.markers().some((mk) => mk.kind === 'event-start') && night.ms.markers().some((mk) => mk.kind === 'mission-start'));
  check('serialize：沒有事件狀態時不多欄位（形狀同 §18）', !('events' in JSON.parse(base.trace.split('|').at(-1))) && !('events' in night.ms.serialize()));
  for (const e of [night]) e.ms.dispose();
}
{
  const E = setupMs({ getGameHour: () => 20, routeLength });
  await E.ms.ready;
  E.step(0.2, FAR);
  const it = E.ms.nearest(PICK);
  check('整合：取餐點經 createMissions.nearest 取得（委託起點不在附近時）', it && it.id === `event:${NM.id}`);
  const startBeacons = E.ms.beacons.live.filter((b) => b.kind === 'start').length;
  check('整合：取餐點有光柱（委託 3 根 + 事件 1 根）', startBeacons === 4, String(startBeacons));
  it.act();
  E.step(0.1, PICK);
  const ea = E.ms.eventActive();
  check('整合：事件進行中 → 委託不能接、委託起點光柱隱藏、markers 只剩送達點、目的地光柱', ea && E.ms.nearest(E.ms.catalog().find((c) => c.slug === E.ms.offers()[0]).from) === null && E.ms.beacons.live.filter((b) => b.kind === 'start' && b.group.visible).length === 0 && E.ms.markers().length === 1 && E.ms.markers()[0].kind === 'event-dest' && E.ms.beacons.live.some((b) => b.kind === 'dest'));
  check('整合：active() / objective() 仍只描述委託（事件另走 eventObjective）', E.ms.active() === null && E.ms.objective() === null && E.ms.eventObjective().timerSec > 0);
  E.step(0.1, ea.to);
  check('整合：事件送達入帳 reason event、委託起點光柱恢復', E.money.length === 1 && E.money[0].r === 'event' && E.ms.beacons.live.filter((b) => b.kind === 'start' && b.group.visible).length === 3 && E.ms.beacons.live.every((b) => b.kind !== 'dest'));
  const sv = E.ms.serialize();
  check('整合：有事件狀態時 serialize 帶 events 欄位', sv.events && sv.events.completed[NM.id] === 1 && sv.events.cooldowns[NM.id] > 0);
  const R = setupMs({ getGameHour: () => 20, routeLength });
  R.ms.restore(sv);
  await R.ms.ready;
  R.step(0.2, FAR);
  check('整合：restore 還原事件冷卻（冷卻中取餐點不出現）', R.ms.events.offers().length === 0 && R.ms.serialize().events.completed[NM.id] === 1);
  // 委託進行中不開放事件
  const M = setupMs({ getGameHour: () => 20, routeLength });
  await M.ms.ready;
  M.step(0.2, FAR);
  const slug = M.ms.offers()[0];
  const m = M.ms.catalog().find((c) => c.slug === slug);
  M.step(0.1, m.from);
  M.ms.nearest(m.from).act();
  M.step(0.1, PICK);
  check('整合：委託進行中 → 取餐點不可互動、光柱隱藏', M.ms.nearest(PICK) === null && M.ms.active() && M.ms.beacons.live.filter((b) => b.kind === 'start' && b.group.visible).length === 0);
  M.ms.abandon();
  check('整合：委託進行中 abandon 只放棄委託', M.of('mission:fail').at(-1).p.reason === 'abandon' && M.of('event:fail').length === 0);
  E.ms.dispose();
  R.ms.dispose();
  M.ms.dispose();
  check('dispose 後光柱全部釋放', E.ms.beacons.live.length === 0 && M.ms.beacons.live.length === 0);
}

// ======================= 6b. 委託統計（missionsDone / missionsFailed）計入時段事件 =======================
{
  check('MISSION_STAT_EVENTS：委託與事件的完成 / 失敗對應 missionsDone / missionsFailed', MISSION_STAT_EVENTS['mission:complete'] === 'missionsDone' && MISSION_STAT_EVENTS['event:complete'] === 'missionsDone' && MISSION_STAT_EVENTS['mission:fail'] === 'missionsFailed' && MISSION_STAT_EVENTS['event:fail'] === 'missionsFailed' && Object.keys(MISSION_STAT_EVENTS).length === 4);
  const withStats = async (extra) => {
    const E = setupMs(extra);
    const stats = { missionsDone: 0, missionsFailed: 0, shotsFired: 7 };
    E.off = trackMissionStats(E.bus, stats);
    E.stats = stats;
    await E.ms.ready;
    E.step(0.2, FAR);
    return E;
  };
  const night = { getGameHour: () => 20, routeLength };
  // 事件完成 → missionsDone +1
  const A = await withStats(night);
  A.ms.nearest(PICK).act();
  A.step(0.1, PICK);
  A.step(0.1, A.ms.eventActive().to);
  check('事件完成：missionsDone +1、missionsFailed 不變、不發 mission:complete', A.stats.missionsDone === 1 && A.stats.missionsFailed === 0 && A.of('event:complete').length === 1 && A.of('mission:complete').length === 0, JSON.stringify(A.stats));
  check('trackMissionStats 不動其他統計欄位', A.stats.shotsFired === 7);
  // 事件逾時 → missionsFailed +1
  const T = await withStats(night);
  T.ms.nearest(PICK).act();
  T.step(0.1, PICK);
  T.step(T.ms.eventActive().limitSec + 1, FAR);
  check('事件逾時：missionsFailed +1、missionsDone 不變', T.of('event:fail').at(-1)?.p.reason === 'timeout' && T.stats.missionsFailed === 1 && T.stats.missionsDone === 0, JSON.stringify(T.stats));
  // 事件放棄 → 比照委託放棄（mission:fail abandon 計 missionsFailed）
  const B = await withStats(night);
  B.ms.nearest(PICK).act();
  B.step(0.1, PICK);
  B.ms.abandon();
  check('事件放棄：比照委託放棄計入 missionsFailed +1', B.of('event:fail').at(-1)?.p.reason === 'abandon' && B.stats.missionsFailed === 1 && B.stats.missionsDone === 0, JSON.stringify(B.stats));
  // 委託 + 事件各完成一次 → 各 +1（合計 2），不重複
  const C = await withStats(night);
  const slug = C.ms.offers()[0];
  const m = C.ms.catalog().find((c) => c.slug === slug);
  C.step(0.1, m.from);
  C.ms.nearest(m.from).act();
  C.step(0.1, m.from);
  C.step(0.1, m.to);
  check('委託完成一次：missionsDone = 1', C.stats.missionsDone === 1 && C.of('mission:complete').length === 1, JSON.stringify(C.stats));
  C.step(0.2, FAR);
  C.ms.nearest(PICK).act();
  C.step(0.1, PICK);
  C.step(0.1, C.ms.eventActive().to);
  check('委託 + 事件各完成一次：missionsDone = 2（各 +1，不重複計數）、missionsFailed = 0', C.stats.missionsDone === 2 && C.stats.missionsFailed === 0 && C.of('mission:complete').length === 1 && C.of('event:complete').length === 1, JSON.stringify(C.stats));
  // 既有委託計數行為不變：events:false 劇本（完成 1、放棄 1）
  const D = await withStats({ events: false });
  await scenario(D);
  check('既有委託計數不變（events:false 劇本：完成 1 → done 1、放棄 1 → failed 1）', D.stats.missionsDone === 1 && D.stats.missionsFailed === 1, JSON.stringify(D.stats));
  // 讀檔作廢進行中的事件：不發 event:fail、不計
  const R = await withStats(night);
  R.ms.nearest(PICK).act();
  R.step(0.1, PICK);
  R.ms.restore({});
  check('讀檔作廢進行中事件：不計 missionsFailed', R.stats.missionsFailed === 0 && R.of('event:fail').length === 0);
  // 取消訂閱後不再計數
  A.off();
  A.bus.emit('event:complete', { id: NM.id });
  A.bus.emit('mission:fail', { id: 'x', reason: 'abandon' });
  check('trackMissionStats 回傳的取消函式生效', A.stats.missionsDone === 1 && A.stats.missionsFailed === 0);
  check('trackMissionStats 無 bus / stats 不丟例外', typeof trackMissionStats(null, {}) === 'function' && typeof trackMissionStats(createBus(), null) === 'function');
  for (const e of [A, T, B, C, D, R]) e.ms.dispose();
}

// ======================= 7. 靜態檢查 =======================
{
  const src = fs.readFileSync(path.join(ROOT, 'src/missions/events.js'), 'utf8');
  check('events.js 不 import three / daynight / DOM / main / hud / economy', !/^import /m.test(src) && !/\bdocument\b/.test(src.replace(/\/\/.*$/gm, '')));
}

console.error = origError;
check('全程無 console.error', errors === 0, String(errors));
console.log(failed ? `FAIL ${failed}/${passed + failed}` : `PASS ${passed}/${passed + failed}`);
process.exit(failed ? 1 : 0);
