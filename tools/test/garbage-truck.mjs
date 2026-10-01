#!/usr/bin/env node
// 垃圾車時段事件（src/missions/garbage-truck.js）無頭驗證 + createMissions 整合 + 旋律（src/audio/voices.js）+ 車型接入靜態檢查
// 用法：node tools/test/garbage-truck.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// three 以 loader hook 換成最小替身（同 missions-events.mjs），.json → ES module、.css → 空字串；不需要 node_modules
// 項目：時段外 / 無路線不開放；開放後車沿折線（含真實路網 findRoute 折線）前進、停靠、折返；時限內到車尾互動 → complete 且獎勵入帳（reason 'event'）；
//   逾時 / 跟丟 → fail（不扣錢）、沒靠近過 → 只 closed；冷卻中不再開放、冷卻後可重複；serialize / restore 往返；
//   createMissions 整合（標記 kind、互動、統計、存檔合併、未注入 routeFor 時不作用）；旋律音符序列非空且無音檔引用；
//   manifest 有 garbage_truck（與美術建議條目一致）、CAR_TYPES / PARKED_TYPES 不含它、beacon 列入 EMISSIVE_MATERIALS
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
const GT = await import('../../src/missions/garbage-truck.js');
const { createMissions, trackMissionStats } = await import('../../src/missions/index.js');
const { createBus } = await import('../../src/core/events.js');
const { buildRoadGraph, findRoute } = await import('../../src/navigation.js');
const { surfaceRoads } = await import('../../src/citymodel.js');
const { PARKED_TYPES } = await import('../../src/data/city.js');
const VO = await import('../../src/audio/voices.js');
const { createGarbageTruck, createRouteFollower, truckRearPoint, garbageReward, GARBAGE_TRUCK_EVENT: DEF, REAR_Z, DUMP_RADIUS, ENGAGE_M, LOST_M, LOST_SEC } = GT;
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
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// 點到折線的最短距離
function distToPolyline(p, pts) {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const L2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / L2));
    best = Math.min(best, Math.hypot(a.x + dx * t - p.x, a.z + dz * t - p.z));
  }
  return best;
}

// ======================= 1. 純函式 =======================
{
  const r0 = truckRearPoint(10, 20, 0);
  const r1 = truckRearPoint(10, 20, Math.PI / 2);
  check('truckRearPoint：heading 0（面向 +Z）→ 車尾在 z − 3.43；heading π/2（面向 +X）→ 車尾在 x − 3.43', near(r0.x, 10) && near(r0.z, 20 + REAR_Z) && near(r1.x, 10 + REAR_Z) && near(r1.z, 20), `${r1.x},${r1.z}`);
  check('garbageReward：整數、對剩餘秒數單調遞增、0 秒 = 基本 250', garbageReward(0) === 250 && garbageReward(100) > garbageReward(10) && Number.isInteger(garbageReward(33.3)));
  check('事件定義：傍晚 16–18、可重複冷卻（完成 240 s / 失敗 120 s）、時限 180 s', DEF.window.start === 16 && DEF.window.end === 18 && DEF.cooldownSec > 0 && DEF.failCooldownSec > 0 && DEF.limitSec === 180);
}

// ======================= 2. 折線行駛器 =======================
{
  const pts = [{ x: 0, z: 0 }, { x: 0, z: 200 }, { x: 100, z: 200 }];
  const f = createRouteFollower(pts, { speed: 5 });
  for (let i = 0; i < 20; i++) f.step(0.1);
  let st = f.state();
  check('行駛器：5 m/s × 2 s → 沿第一段前進 10 m、heading 0', near(st.x, 0) && near(st.z, 10, 1e-6) && near(st.heading, 0) && !st.stopped, `${st.x},${st.z}`);
  for (let i = 0; i < 400; i++) f.step(0.1); // s = 210
  st = f.state();
  check('行駛器：轉過彎角後在第二段（x 10, z 200），heading 收斂到 π/2', near(st.x, 10, 1e-6) && near(st.z, 200) && near(st.heading, Math.PI / 2, 1e-3), `${st.x},${st.z},${st.heading.toFixed(3)}`);
  for (let i = 0; i < 190; i++) f.step(0.1); // s = 300 − 5 → 折返
  st = f.state();
  check('行駛器：走到終點折返（ping-pong），s 從 300 回到 295、往回開', st.dir === -1 && near(st.s, 295, 1e-6) && near(st.x, 95, 1e-6), `s ${st.s}`);
  const g = createRouteFollower(pts, { speed: 5, stopEveryM: 20, stopSec: 3 });
  for (let i = 0; i < 40; i++) g.step(0.1);
  const a = g.state().s;
  const stoppedA = g.state().stopped;
  for (let i = 0; i < 20; i++) g.step(0.1);
  const b = g.state().s;
  for (let i = 0; i < 20; i++) g.step(0.1);
  const c = g.state().s;
  check('行駛器：每 20 m 停靠 3 s（停靠中不前進，結束後繼續）', near(a, 20) && stoppedA && near(b, 20) && c > 20, `${a} ${b} ${c}`);
  const lane = createRouteFollower(pts, { speed: 5, laneOffsetM: 2 });
  lane.step(1);
  check('行駛器：laneOffsetM 偏到行進方向右側（面向 +Z 時右側為 −X）', near(lane.state().x, -2) && near(lane.state().z, 5));
  check('行駛器：不足 2 點 → length 0、step 不丟例外', createRouteFollower([{ x: 0, z: 0 }]).length === 0 && !!createRouteFollower(null).step(1));
}

// ======================= 3. 事件狀態機 =======================
const LINE = [{ x: 0, z: 0 }, { x: 0, z: 400 }, { x: 300, z: 400 }];
function setup(opts = {}) {
  const clock = { t: 1000, hour: opts.hour ?? 17 };
  const money = [];
  const log = [];
  const state = { busy: false };
  let routeCalls = 0;
  const truck = createGarbageTruck({
    def: opts.def,
    getGameHour: () => clock.hour,
    routeFor: opts.noRoute ? null : opts.routeFor || (() => {
      routeCalls++;
      return LINE;
    }),
    isBusy: () => state.busy,
    addMoney: (n, reason) => money.push({ n, reason }),
    bus: { emit: (n, p) => log.push({ n, p }) },
    now: () => clock.t,
    rng: () => 0.5,
  });
  const of = (n) => log.filter((e) => e.n === n);
  const step = (sec, pos) => {
    const n = Math.max(1, Math.round(sec / 0.1));
    for (let i = 0; i < n; i++) {
      clock.t += 0.1;
      truck.update(0.1, pos ? { x: pos.x, z: pos.z } : null);
    }
  };
  return { truck, clock, money, log, of, step, state, routeCalls: () => routeCalls };
}
const FAR = { x: 2000, z: 2000 };
const rearOf = (t) => ({ x: t.rearX, z: t.rearZ });

{
  const e = setup({ hour: 12 });
  e.step(5, FAR);
  check('時段外（12 時）不開放：無 event:available、truck() null、markers 空、nearest null', e.of('event:available').length === 0 && e.truck.truck() === null && e.truck.markers().length === 0 && e.truck.nearest({ x: 0, z: 0 }) === null && e.routeCalls() === 0);
  e.clock.hour = 18.5;
  e.step(2, FAR);
  check('時段外（18:30，夜市時段）不開放', e.of('event:available').length === 0);
  const nr = setup({ noRoute: true });
  nr.step(5, FAR);
  check('時段內但沒有路線來源 → 不開放', nr.of('event:available').length === 0 && nr.truck.truck() === null);
  const bad = setup({ routeFor: () => [{ x: 0, z: 0 }, { x: 0, z: 10 }] });
  bad.step(5, FAR);
  check('路線太短（< MIN_ROUTE_M）→ 不開放', bad.of('event:available').length === 0);
  const nh = createGarbageTruck({ routeFor: () => LINE });
  nh.update(0.1, { x: 0, z: 0 });
  check('沒有任何遊戲時刻來源 → 不開放', nh.truck() === null);
  const ctxH = createGarbageTruck({ routeFor: () => LINE, now: () => 0 });
  ctxH.update(0.1, { x: 0, z: 0, gameHour: 16.5 });
  check('ctx.gameHour 亦可作為時刻來源', ctxH.truck() !== null);
}

{
  const e = setup();
  e.step(0.1, FAR);
  const av = e.of('event:available');
  const t = e.truck.truck();
  check('時段內（17 時）開放：event:available 一次（id garbage-truck、帶座標）、truck() 有 x / z / heading', av.length === 1 && av[0].p.id === 'garbage-truck' && Number.isFinite(av[0].p.x) && t && Number.isFinite(t.heading) && t.phase === 'open');
  const mk = e.truck.markers();
  check('標記：kind event-truck、座標 = 車體', mk.length === 1 && mk[0].kind === 'event-truck' && mk[0].x === t.x && mk[0].z === t.z);
  const z0 = t.z;
  e.step(10, FAR);
  const t1 = e.truck.truck();
  check('開放後車沿折線前進（10 s 約 5.5 m/s × 10，離折線 ≤ 車道偏移）', t1.z - z0 > 40 && t1.z - z0 < 60 && distToPolyline(t1, LINE) <= DEF.laneOffsetM + 1e-6, `Δz ${(t1.z - z0).toFixed(1)}`);
  check('未靠近前不發 event:start、objective / active 為 null', e.of('event:start').length === 0 && e.truck.objective() === null && e.truck.active() === null);
  check('遠處 nearest → null', e.truck.nearest(FAR) === null);
  // 走到車旁 → 追車開始
  e.step(0.1, { x: t1.x + 30, z: t1.z });
  check(`玩家進入 ${ENGAGE_M} m 內 → event:start（kind truck、帶 limitSec）`, e.of('event:start').length === 1 && e.of('event:start')[0].p.limitSec === DEF.limitSec && e.truck.truck().phase === 'chase' && e.truck.objective() !== null);
  const t2 = e.truck.truck();
  const front = { x: t2.x + Math.sin(t2.heading) * 4, z: t2.z + Math.cos(t2.heading) * 4 };
  check('車頭附近 nearest → null（只有車尾投入口可倒）', e.truck.nearest(front) === null);
  const it = e.truck.nearest(rearOf(t2));
  check('車尾投入口 nearest → interactable（id event:garbage-truck、priority 3、有 text）', it && it.id === 'event:garbage-truck' && it.priority === 3 && typeof it.text === 'string' && it.dist <= DUMP_RADIUS);
  const left = DEF.limitSec - 10.2;
  it.act();
  const done = e.of('event:complete');
  check('互動 → event:complete，獎勵入帳 reason event、金額 = garbageReward(剩餘秒)', done.length === 1 && e.money.length === 1 && e.money[0].reason === 'event' && e.money[0].n === done[0].p.reward && Math.abs(done[0].p.reward - garbageReward(left)) <= 1, JSON.stringify(e.money));
  check('完成後車收走：truck() null、markers 空、completedCount 1', e.truck.truck() === null && e.truck.markers().length === 0 && e.truck.completedCount() === 1);
  e.step(DEF.cooldownSec - 20, FAR);
  check('冷卻中（完成 240 s）不再開放', e.of('event:available').length === 1);
  e.step(25, FAR);
  check('冷卻後仍在時段內 → 再次開放（可重複）', e.of('event:available').length === 2 && e.truck.truck() !== null);
  e.clock.hour = 19;
  e.step(1, FAR);
  check('出現後跨出時段不作廢（跑完本趟）', e.truck.truck() !== null);
  const s = e.truck.serialize();
  check('serialize：completed 1（冷卻已過 → 無 cooldowns）', s.completed['garbage-truck'] === 1 && !('garbage-truck' in s.cooldowns), JSON.stringify(s));
}

{
  // 逾時：追車後沒倒成
  const e = setup();
  e.step(0.1, FAR);
  const t = e.truck.truck();
  e.step(0.1, { x: t.x, z: t.z + 20 });
  let follow = 0;
  for (let i = 0; i < DEF.limitSec * 10 + 5 && e.truck.truck(); i++) {
    const tt = e.truck.truck();
    follow = Math.max(follow, Math.hypot(tt.rearX - tt.x, tt.rearZ - tt.z));
    e.step(0.1, { x: tt.x + 20, z: tt.z }); // 跟在旁邊 20 m，但不按 E
  }
  const fl = e.of('event:fail');
  check('追車後逾時 → event:fail reason timeout、不扣錢', fl.length === 1 && fl[0].p.reason === 'timeout' && e.money.length === 0);
  const cd = e.truck.serialize().cooldowns['garbage-truck'];
  check('逾時失敗也有冷卻（failCooldownSec）', cd > 0 && cd <= DEF.failCooldownSec, String(cd));
  e.step(DEF.failCooldownSec - 10, FAR);
  check('失敗冷卻中不開放', e.of('event:available').length === 1);
  e.step(15, FAR);
  check('失敗冷卻結束 → 再開放', e.of('event:available').length === 2);
  check('車尾到車體距離 = 3.43 m（投入口換算）', near(follow, -REAR_Z, 1e-6));
}

{
  // 跟丟：追車後拉開 > LOST_M 持續 LOST_SEC
  const e = setup();
  e.step(0.1, FAR);
  const t = e.truck.truck();
  e.step(0.1, { x: t.x + 10, z: t.z });
  e.step(LOST_SEC - 2, FAR);
  check(`遠離 < ${LOST_SEC} s 尚未失敗`, e.of('event:fail').length === 0);
  e.step(3, FAR);
  const fl = e.of('event:fail');
  check(`追車後遠離 > ${LOST_M} m 持續 ${LOST_SEC} s → event:fail reason lost、不扣錢`, fl.length === 1 && fl[0].p.reason === 'lost' && e.money.length === 0);
}

{
  // 從沒靠近：逾時只收走，不計失敗
  const e = setup();
  e.step(DEF.limitSec + 1, FAR);
  check('玩家從沒靠近 → 逾時只發 event:closed（不發 start / fail、不計統計），一樣進失敗冷卻', e.of('event:closed').length === 1 && e.of('event:fail').length === 0 && e.of('event:start').length === 0 && e.truck.serialize().cooldowns['garbage-truck'] > 0);
  // 未追車也可直接到車尾倒（補發 start）
  const d = setup();
  d.step(0.1, FAR);
  const t = d.truck.truck();
  const it = d.truck.nearest(rearOf(t));
  it.act();
  check('未發 start 時直接在車尾互動 → 先補 event:start 再 event:complete（統計一致）', d.of('event:start').length === 1 && d.of('event:complete').length === 1 && d.log.findIndex((x) => x.n === 'event:start') < d.log.findIndex((x) => x.n === 'event:complete'));
  // abandon
  const a = setup();
  a.step(0.1, FAR);
  const ta = a.truck.truck();
  a.step(0.1, { x: ta.x, z: ta.z });
  a.truck.abandon();
  check('追車中 abandon → event:fail reason abandon', a.of('event:fail').length === 1 && a.of('event:fail')[0].p.reason === 'abandon');
  // busy
  const b = setup();
  b.state.busy = true;
  b.step(3, FAR);
  check('委託 / 外送進行中（isBusy）不開放', b.of('event:available').length === 0);
  b.state.busy = false;
  b.step(0.1, FAR);
  b.state.busy = true;
  b.step(0.1, FAR);
  check('未追車時開始委託 / 外送 → 垃圾車收走（event:closed、不計失敗）', b.of('event:closed').length === 1 && b.truck.truck() === null && b.of('event:fail').length === 0);
}

{
  // serialize / restore
  const e = setup();
  e.step(0.1, FAR);
  e.truck.nearest(rearOf(e.truck.truck())).act();
  const s = e.truck.serialize();
  check('serialize：{ completed: { garbage-truck: 1 }, cooldowns: { garbage-truck: 240 } }', s.completed['garbage-truck'] === 1 && s.cooldowns['garbage-truck'] === DEF.cooldownSec, JSON.stringify(s));
  const r = setup();
  r.truck.restore(JSON.parse(JSON.stringify(s)));
  check('restore 往返：serialize 相同', JSON.stringify(r.truck.serialize()) === JSON.stringify(s));
  r.step(5, FAR);
  check('restore 後冷卻中不開放', r.of('event:available').length === 0);
  r.step(DEF.cooldownSec, FAR);
  check('restore 的冷卻到期 → 開放', r.of('event:available').length === 1);
  r.truck.restore({ completed: { 'garbage-truck': 2.7, other: 5 }, cooldowns: { 'garbage-truck': 99999, other: 10 } });
  const s2 = r.truck.serialize();
  check('restore：取整、未知 id 忽略、冷卻夾到 max(cooldownSec, failCooldownSec)、進行中的車收走（不發 fail）', s2.completed['garbage-truck'] === 2 && !('other' in s2.completed) && s2.cooldowns['garbage-truck'] === DEF.cooldownSec && r.truck.truck() === null && r.of('event:fail').length === 0, JSON.stringify(s2));
  r.truck.restore(null);
  check('restore(null) → 清空', JSON.stringify(r.truck.serialize()) === '{"completed":{},"cooldowns":{}}');
}

// ======================= 4. 真實路網折線 =======================
const graph = buildRoadGraph(surfaceRoads);
{
  const A = { x: 330, z: 380 };
  const B = { x: 820, z: 470 };
  const route = findRoute(graph, A, B);
  const e = setup({ routeFor: () => route.points });
  e.step(0.1, FAR);
  let maxOff = 0;
  let moved = 0;
  let prev = { ...e.truck.truck() };
  for (let i = 0; i < 600; i++) {
    e.step(0.1, FAR);
    const t = e.truck.truck();
    if (!t) break;
    maxOff = Math.max(maxOff, distToPolyline(t, route.points));
    moved += Math.hypot(t.x - prev.x, t.z - prev.z);
    prev = { x: t.x, z: t.z };
  }
  check(`真實路網 findRoute 折線（${route.points.length} 點、${Math.round(route.lengthM)} m）：60 s 內車身始終在路線 ${DEF.laneOffsetM} m 車道偏移內、實際行駛 > 200 m`, route.points.length >= 2 && maxOff <= DEF.laneOffsetM + 0.01 && moved > 200, `off ${maxOff.toFixed(2)} moved ${moved.toFixed(0)}`);
  const obj = { points: route.points };
  const e2 = setup({ routeFor: () => obj });
  e2.step(0.1, FAR);
  check('routeFor 也接受 findRoute 原樣回傳的 { points, lengthM }', e2.truck.truck() !== null);
}

// ======================= 5. createMissions 整合 =======================
const LANDMARKS = [
  { id: 'national_taichung_theater', slug: 'national_taichung_theater', name: '臺中國家歌劇院', x: 330, z: 380, radius: 25 },
  { id: 'taichung_city_hall', slug: 'taichung_city_hall', name: '臺中市政府', x: 820, z: 470, radius: 25 },
  { id: 148849083, slug: 'shin_kong_mitsukoshi', name: '新光三越', x: 584, z: -91, radius: 25 },
  { id: 222636758, slug: 'taichung_city_council', name: '臺中市議會', x: 1010, z: 400, radius: 25 },
  { id: 'qiuhonggu_pavilion', slug: 'qiuhonggu_pavilion', name: '秋紅谷', x: 120, z: -330, radius: 15 },
  { id: 'lin_hotel', slug: 'lin_hotel', name: '林酒店', x: -150, z: -420, radius: 25 },
];
const notFound = async () => {
  throw new Error('404');
};
function setupMs(extra = {}, hour = 17) {
  const bus = createBus();
  const log = [];
  for (const n of ['event:available', 'event:closed', 'event:start', 'event:complete', 'event:fail', 'mission:start']) bus.on(n, (p) => log.push({ n, p }));
  const stats = { missionsDone: 0, missionsFailed: 0 };
  trackMissionStats(bus, stats);
  const clock = { t: 1000 };
  const money = [];
  const ms = createMissions({ bus, scene: null, root: null, doc: null, landmarks: LANDMARKS, addMoney: (n, r) => money.push({ n, r }), fetchJson: notFound, now: () => clock.t, rng: () => 0.42, info: () => {}, ...extra });
  const step = (sec, pos) => {
    const n = Math.max(1, Math.round(sec / 0.1));
    for (let i = 0; i < n; i++) {
      clock.t += 0.1;
      ms.update(0.1, { x: pos.x, z: pos.z, gameHour: hour });
    }
  };
  return { ms, log, money, stats, clock, step, of: (n) => log.filter((e) => e.n === n) };
}
{
  const route = findRoute(graph, { x: 330, z: 380 }, { x: 820, z: 470 });
  const routeFor = () => route.points;
  const env = setupMs({ routeFor });
  await env.ms.ready;
  env.step(0.2, FAR);
  const t = env.ms.truckState();
  check('createMissions(routeFor)：時段內垃圾車出現，truckState() 有 { x, z, heading }', t && Number.isFinite(t.x) && Number.isFinite(t.z) && Number.isFinite(t.heading) && env.ms.truck && env.ms.truck.isOpen());
  check('missions.markers() 附加 kind event-truck（與委託起點並列）', env.ms.markers().some((m) => m.kind === 'event-truck') && env.ms.markers().some((m) => m.kind === 'mission-start'));
  env.step(0.1, { x: t.x + 10, z: t.z });
  check('追車中：markers 只剩 event-truck、委託起點互動關閉', env.ms.markers().length === 1 && env.ms.markers()[0].kind === 'event-truck' && env.ms.truck.isEngaged());
  const offer = env.ms.catalog().find((c) => c.slug === env.ms.offers()[0]);
  check('追車中站在委託起點 nearest → null（不開放委託）', env.ms.nearest(offer.from) === null);
  const tt = env.ms.truckState();
  const it = env.ms.nearest({ x: tt.rearX, z: tt.rearZ });
  check('missions.nearest(車尾) → 垃圾車 interactable', it && it.id === 'event:garbage-truck');
  it.act();
  check('倒垃圾 → 入帳 reason event、trackMissionStats missionsDone +1（不需改 index.js 統計表）', env.money.length === 1 && env.money[0].r === 'event' && env.stats.missionsDone === 1 && env.stats.missionsFailed === 0);
  const s = env.ms.serialize();
  check('missions.serialize().events 帶 garbage-truck 完成次數 / 冷卻', s.events && s.events.completed['garbage-truck'] === 1 && s.events.cooldowns['garbage-truck'] === DEF.cooldownSec, JSON.stringify(s.events));
  const env2 = setupMs({ routeFor });
  await env2.ms.ready;
  env2.ms.restore(JSON.parse(JSON.stringify(s)));
  const s2 = env2.ms.serialize();
  check('missions restore 往返：events 相同、冷卻中不出現', JSON.stringify(s2.events) === JSON.stringify(s.events) && (env2.step(1, FAR), env2.ms.truckState() === null));
  // 失敗計入統計
  const env3 = setupMs({ routeFor });
  await env3.ms.ready;
  env3.step(0.2, FAR);
  const t3 = env3.ms.truckState();
  env3.step(0.1, { x: t3.x, z: t3.z });
  env3.ms.abandon();
  check('追車中 missions.abandon() → 垃圾車 fail abandon、missionsFailed +1', env3.of('event:fail').length === 1 && env3.of('event:fail')[0].p.reason === 'abandon' && env3.stats.missionsFailed === 1);
  // 未注入 routeFor：不作用
  const env4 = setupMs({});
  await env4.ms.ready;
  env4.step(2, FAR);
  check('未注入 routeFor → missions.truck null、無 event-truck 標記、serialize 無 events', env4.ms.truck === null && env4.ms.truckState() === null && !env4.ms.markers().some((m) => m.kind === 'event-truck') && !('events' in env4.ms.serialize()));
  const env5 = setupMs({ routeFor, garbageTruck: false });
  await env5.ms.ready;
  check('garbageTruck: false → 關閉', env5.ms.truck === null);
}
// 5b. eventActive() / eventObjective() 也回垃圾車；目標列 / 字幕操作詞依注入的 isTouch / interactLabel
{
  const route = findRoute(graph, { x: 330, z: 380 }, { x: 820, z: 470 });
  const routeFor = () => route.points;
  const run = async (extra) => {
    const env = setupMs({ routeFor, ...extra });
    await env.ms.ready;
    const subs = [];
    env.ms.ui.subtitle = (text) => subs.push(text); // 無 DOM 時 ui 為 noop 物件：換掉 subtitle 收字幕
    env.step(0.2, FAR);
    const before = { act: env.ms.eventActive(), obj: env.ms.eventObjective() };
    const t = env.ms.truckState();
    env.step(0.1, { x: t.x + 10, z: t.z });
    return { env, subs, before };
  };
  const D = await run({});
  check('追車前 eventActive() / eventObjective() 為 null', D.before.act === null && D.before.obj === null);
  const ea = D.env.ms.eventActive();
  const eo = D.env.ms.eventObjective();
  check('追車中 eventActive() → 垃圾車（id garbage-truck、kind truck、stage chase、limitSec / elapsedSec / timerSec、to = 車尾座標，欄位比照外送）',
    ea && ea.id === 'garbage-truck' && ea.kind === 'truck' && ea.stage === 'chase' && ea.limitSec === DEF.limitSec && ea.timerSec > 0 && ea.elapsedSec >= 0
      && ea.to && near(ea.to.x, D.env.ms.truckState().rearX) && near(ea.to.z, D.env.ms.truckState().rearZ) && 'from' in ea && 'routeM' in ea && ea === D.env.ms.truck.active(), JSON.stringify(ea));
  check('追車中 eventObjective() → 垃圾車目標 { text, timerSec, distM, rewardNow }（= truck.objective()）', eo && eo === D.env.ms.truck.objective() && typeof eo.text === 'string' && eo.timerSec > 0 && Number.isFinite(eo.distM) && eo.rewardNow > 0);
  check('追車中 active() / objective() 仍只描述委託（null，HUD 行為不變）', D.env.ms.active() === null && D.env.ms.objective() === null);
  check('桌機（預設）：目標列 / 字幕「到車尾按 E 倒垃圾」', /車尾按 E 倒垃圾/.test(eo.text) && D.subs.length >= 2 && D.subs.slice(0, 2).every((x) => /按 E 倒垃圾/.test(x)), D.subs.join(' | '));
  const tt = D.env.ms.truckState();
  D.env.ms.nearest({ x: tt.rearX, z: tt.rearZ }).act();
  check('倒完垃圾後 eventActive() / eventObjective() 回 null', D.env.ms.eventActive() === null && D.env.ms.eventObjective() === null);
  const T = await run({ isTouch: true });
  const to = T.env.ms.eventObjective();
  check('觸控（isTouch: true）：目標列改「點「互動」鈕」、不含「按 E」', to && /車尾點「互動」鈕 倒垃圾/.test(to.text) && !/按\s*E/.test(to.text), to && to.text);
  check('觸控：垃圾車出現 / 開始追車字幕改「點「互動」鈕」、不含「按 E」', T.subs.length >= 2 && T.subs.every((x) => !/按\s*E/.test(x)) && T.subs.slice(0, 2).every((x) => /點「互動」鈕 倒垃圾/.test(x)), T.subs.join(' | '));
  const tt2 = T.env.ms.truckState();
  check('觸控：互動提示原文仍為「按 E 倒垃圾」（由 hud.js touchPromptText 轉換，不重複改）', T.env.ms.nearest({ x: tt2.rearX, z: tt2.rearZ }).text === '按 E 倒垃圾');
  const L = await run({ isTouch: true, interactLabel: '按互動' });
  check('interactLabel 可直接覆寫', /車尾按互動 倒垃圾/.test(L.env.ms.eventObjective().text));
  check('createGarbageTruck 未給 interactLabel → 預設「按 E」', (() => {
    const e = setup();
    e.step(0.2, FAR);
    const tr = e.truck.truck();
    e.step(0.1, { x: tr.x, z: tr.z });
    return /按 E 倒垃圾/.test(e.truck.objective().text);
  })());
}

// ======================= 6. 旋律 =======================
{
  const tune = VO.GARBAGE_TRUCK_TUNE;
  const pitched = tune.notes.filter((n) => n[0] !== null);
  check(`旋律《${tune.title}》音符序列非空（${pitched.length} 音）、音高皆為合理 MIDI、步數為正整數`, pitched.length >= 30 && pitched.every((n) => Number.isInteger(n[0]) && n[0] >= 48 && n[0] <= 96) && tune.notes.every((n) => Number.isInteger(n[1]) && n[1] > 0));
  check('旋律開頭為《給愛麗絲》E5–D#5–E5–D#5–E5–B4–D5–C5–A4', JSON.stringify(pitched.slice(0, 9).map((n) => n[0])) === JSON.stringify([76, 75, 76, 75, 76, 71, 74, 72, 69]));
  check('garbageTruckLevel：近 1、遠 0、null 0、單調遞減', VO.garbageTruckLevel(5) === 1 && VO.garbageTruckLevel(VO.GARBAGE_TRUCK_FAR_M) === 0 && VO.garbageTruckLevel(null) === 0 && VO.garbageTruckLevel(50) > VO.garbageTruckLevel(100) && VO.garbageTruckLevel(100) > 0);
  check('garbageTruckLoopSec：一輪 > 5 s', VO.garbageTruckLoopSec() > 5, VO.garbageTruckLoopSec().toFixed(2));
  const src = fs.readFileSync(path.join(ROOT, 'src/audio/voices.js'), 'utf8');
  check('voices.js 無音檔引用（.mp3/.ogg/.wav/.m4a/.aac/.flac、decodeAudioData、new Audio、fetch）', !/\.(mp3|ogg|wav|m4a|aac|flac|opus)\b|decodeAudioData|new\s+Audio\s*\(|\bfetch\s*\(|MediaElementSource/i.test(src));
  // 假 AudioContext：驗 LOOPS.garbage_truck 以振盪器排程音符、音量依距離
  const param = () => ({ value: 0, last: null, setValueAtTime(v) { this.value = v; }, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime(v) { this.last = v; } });
  const oscs = [];
  const ctx = {
    currentTime: 0,
    createGain: () => ({ gain: param(), connect() {} }),
    createOscillator: () => {
      const o = { type: '', frequency: param(), connect() {}, start(t) { o.t = t; }, stop() {} };
      oscs.push(o);
      return o;
    },
  };
  const v = { ctx, out: null, sources: [] };
  const ctrl = VO.LOOPS.garbage_truck(v, {});
  let maxSrc = 0;
  for (let i = 0; i < 600; i++) {
    ctx.currentTime = i / 60;
    ctrl.set({ garbageTruckDist: 30 }, ctx.currentTime);
    maxSrc = Math.max(maxSrc, v.sources.length);
  }
  const freqs = new Set(pitched.map((n) => Math.round(VO.midiHz(n[0]))));
  check('LOOPS.garbage_truck：10 s 內以振盪器排程旋律（音高屬於曲目）、已結束音源會移除', oscs.length > 40 && oscs.filter((o) => o.type === 'triangle').every((o) => freqs.has(Math.round(o.frequency.value))) && maxSrc < 60, `osc ${oscs.length} maxSrc ${maxSrc}`);
  check('LOOPS.garbage_truck：level 增益 = garbageTruckLevel(garbageTruckDist)', Math.abs(ctrl.level.gain.last - VO.garbageTruckLevel(30)) < 1e-9 && (ctrl.set({ garbageTruckDist: null }, 10), ctrl.level.gain.last === 0));
  check('LOOPS.garbage_truck：循環（排完一輪後回到開頭）', ctrl.notesPlayed() > pitched.length);
}

// ======================= 7. 車型接入（靜態）=======================
{
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/models/vehicles/manifest.json'), 'utf8'));
  const entry = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/models/garbage_truck-manifest-entry.json'), 'utf8'));
  const gt = manifest.vehicles.find((x) => x.id === 'garbage_truck');
  check('vehicles/manifest.json 有 garbage_truck，且與美術建議條目逐欄相同', !!gt && JSON.stringify(gt) === JSON.stringify(entry));
  check('manifest 原有五車仍在', ['sedan', 'taxi', 'suv', 'bus', 'scooter'].every((id) => manifest.vehicles.some((x) => x.id === id)));
  const traffic = fs.readFileSync(path.join(ROOT, 'src/traffic.js'), 'utf8');
  const m = traffic.match(/const CAR_TYPES = (\[[^\]]*\])/);
  const carTypes = m ? new Function(`return ${m[1]};`)() : null;
  check('traffic.js CAR_TYPES 不含 garbage_truck、traffic.js 全檔未提及垃圾車', Array.isArray(carTypes) && !carTypes.includes('garbage_truck') && !/garbage/.test(traffic), JSON.stringify(carTypes));
  check('PARKED_TYPES（路邊停車）不含 garbage_truck', PARKED_TYPES.every((p) => p.type !== 'garbage_truck'));
  const vsrc = fs.readFileSync(path.join(ROOT, 'src/vehicle.js'), 'utf8');
  const vm = vsrc.match(/export const VEHICLE_TYPES = (\{[\s\S]*?\n\});/);
  const VT = new Function(`return ${vm[1]};`)();
  const g = VT.garbage_truck;
  check('VEHICLE_TYPES.garbage_truck：label 垃圾車、maxSpeed 低於其餘車型、mass 9000（重車）', g && g.label === '垃圾車' && Object.entries(VT).every(([k, x]) => k === 'garbage_truck' || x.maxSpeed > g.maxSpeed) && g.mass === 9000 && g.accel < VT.sedan.accel);
  const msrc = fs.readFileSync(path.join(ROOT, 'src/vehicle-model.js'), 'utf8');
  const em = msrc.match(/export const EMISSIVE_MATERIALS = (\[[^\]]*\])/);
  check('vehicle-model EMISSIVE_MATERIALS 含 beacon（垃圾車警示燈夜間發光）', em && new Function(`return ${em[1]};`)().includes('beacon'));
  const mains = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  check('main.js 尚未以 manifest 逐筆隨機生成車輛（垃圾車只由事件整合層建立）', !/vehicles\.(forEach|map)\s*\(/.test(mains.replace(/\/\/.*$/gm, '')) || !/garbage/.test(mains));
  const gsrc = fs.readFileSync(path.join(ROOT, 'src/missions/garbage-truck.js'), 'utf8');
  const imports = [...gsrc.matchAll(/^import .* from '([^']+)';$/gm)].map((x) => x[1]);
  check('garbage-truck.js 純邏輯：只 import ./events.js（不 import three / DOM / navigation）', JSON.stringify(imports) === JSON.stringify(['./events.js']) && !/\bdocument\.|(?<!\.)\bwindow\./.test(gsrc.replace(/\/\/.*$/gm, '')));
}

console.error = origError;
check('全程無 console.error', errors === 0, String(errors));
console.log(failed ? `FAIL ${failed}/${passed + failed}` : `PASS ${passed}/${passed + failed}`);
process.exit(failed ? 1 : 0);
