#!/usr/bin/env node
// Phase 6 E6：打工委託（src/missions/jobs.js + createMissions 整合 + 地圖色表 / 圖例）無頭驗證
// 用法：node tools/test/p6-e6.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// three 以 loader hook 換成最小替身（同 missions-events.mjs），.json → ES module、.css → 空字串；不需要 node_modules / public
// 項目：夜市跑單（時段限制、接單 2–3 客且彼此 ≥ 20 m、時限 / 報酬公式、完成 / 逾時 / 開車 > 3 s / KO / 放棄、冷卻 150 / 60 s）；
//   代客泊車（指定車辨識、停妥位置 / 朝向 / 速度門檻與 1 s 維持、車毀 / 逾時 / 離車過遠三種失敗、損壞比報酬、release、冷卻 120 / 60 s）；
//   simDt = 0 不推進、60 / 120 / 144 Hz 子步等價；createMissions 互斥（委託 / 外送 / 垃圾車 / 打工同一把鎖）、nearest 打工優先、
//   category / listings、MISSION_STAT_EVENTS 統計、serialize 併入 events / restore 分流、色表 / 圖例 / 圖釘、jobs.js 不 import three / DOM
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
const J = await import('../../src/missions/jobs.js');
const { createMissions, trackMissionStats, MISSION_STAT_EVENTS } = await import('../../src/missions/index.js');
const { normalizeCatalog, BUILTIN_MISSIONS } = await import('../../src/missions/catalog.js');
const { NIGHT_MARKET_DELIVERY } = await import('../../src/missions/events.js');
const { MARKER_COLORS } = await import('../../src/map/marker-colors.js');
const { MARKER_LABELS, PIN_KINDS } = await import('../../src/map/big-map.js');
const { createBus } = await import('../../src/core/events.js');
const { createJobs, NIGHT_MARKET_RUN: NR, VALET_PARKING: VP, JOB_DEFS, runTimeLimit, runReward, valetTimeLimit, valetReward, isParked, angleDeltaDeg } = J;
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

const STEP = 1 / 60;
const STALL = { x: 557.2, z: -125.1, yaw: 0 }; // 與外送取餐點重合（§22.2）
const STALL_BACK = { x: 557.2, z: -126.48 }; // 攤主側 0.78 + 0.6
const CUST = [
  { x: 600, z: -125 }, // 42.8 m
  { x: 610, z: -125 }, // 與上者 10 m → 被拒
  { x: 557, z: -60 }, // 65 m
  { x: 480, z: -125 }, // 77 m
  { x: 557, z: -250 }, // 125 m
];
const STAND = { id: 'hotel', standX: 300, standZ: 0, carX: 304, carZ: 0, carYaw: 0, slotX: 304, slotZ: 60, slotYaw: Math.PI / 2 };

function makeSidewalk(points = CUST) {
  let i = 0;
  const calls = [];
  const fn = (x, z, rng, minM, maxM) => {
    calls.push({ x, z, minM, maxM, rngFn: typeof rng === 'function' });
    const p = points[i % points.length];
    i++;
    return p ? { x: p.x, z: p.z } : null;
  };
  fn.calls = calls;
  return fn;
}

function setupJobs(opts = {}) {
  const bus = createBus();
  const log = [];
  for (const n of ['job:available', 'job:start', 'job:stage', 'job:complete', 'job:fail', 'nav:destination', 'nav:clear', 'ui:sound']) bus.on(n, (p) => log.push({ n, p }));
  const clock = { t: 1000 };
  const money = [];
  const released = [];
  const spawned = [];
  const health = new Map();
  let hour = opts.hour === undefined ? 19 : opts.hour;
  const sidewalkNear = opts.sidewalkNear || makeSidewalk();
  const jobs = createJobs({
    bus,
    now: () => clock.t,
    rng: opts.rng || (() => 0.9),
    addMoney: (n, r) => money.push({ n, r }),
    getGameHour: () => hour,
    spots: opts.spots === undefined ? { stall: STALL, stallBack: STALL_BACK, sidewalkNear, valet: [STAND] } : opts.spots,
    spawnValetCar: opts.noSpawn ? null : (pose) => {
      const car = { pos: { x: pose.x, z: pose.z }, yaw: pose.yaw, speed: 0, id: spawned.length };
      spawned.push({ pose, car });
      health.set(car, 1000);
      return car;
    },
    releaseValetCar: (v) => released.push(v),
    healthOf: (v) => (health.has(v) ? health.get(v) : null),
    routeLength: opts.routeLength || null,
    isBusy: opts.isBusy || (() => false),
  });
  const ctx = { x: 0, z: 0, driving: false, vehicle: null };
  const tick = (dt = STEP, n = 1) => {
    for (let i = 0; i < n; i++) {
      clock.t += dt;
      jobs.update(dt, ctx);
    }
  };
  const at = (p) => {
    ctx.x = p.x;
    ctx.z = p.z;
  };
  return { jobs, bus, log, money, released, spawned, health, clock, ctx, tick, at, setHour: (h) => (hour = h), sidewalkNear, of: (n) => log.filter((e) => e.n === n) };
}

// ======================= 1. 定義 / 公式 =======================
check('JOB_DEFS = [夜市跑單, 代客泊車]，category 皆為 job、id 不與既有事件重複', JOB_DEFS.length === 2 && JOB_DEFS[0] === NR && JOB_DEFS[1] === VP && JOB_DEFS.every((d) => d.category === 'job') && !JOB_DEFS.some((d) => d.id === NIGHT_MARKET_DELIVERY.id || d.id === 'garbage-truck'));
check('跑單定值：window 18–24、冷卻 150 / 失敗 60、2–3 客、40–160 m、間距 20 m、只限步行 3 s', NR.window.start === 18 && NR.window.end === 24 && NR.cooldownSec === 150 && NR.failCooldownSec === 60 && NR.customersMin === 2 && NR.customersMax === 3 && NR.customerMinM === 40 && NR.customerMaxM === 160 && NR.customerGapM === 20 && NR.vehicleGraceSec === 3 && NR.startRadius === 2.5 && NR.deliverRadius === 3);
check('泊車定值：不限時段、≤ 1.2 m / ≤ 15° / ≤ 0.5 m/s / 維持 1.0 s、離車 40 m × 5 s、冷卻 120 / 60', VP.window === null && VP.parkDistM === 1.2 && VP.parkAngleDeg === 15 && VP.parkSpeed === 0.5 && VP.parkHoldSec === 1 && VP.lostM === 40 && VP.lostSec === 5 && VP.cooldownSec === 120 && VP.failCooldownSec === 60);
check('道具鍵名：攤位 night_market_stall_oyster / _tea（fallback night_market_stall）、泊車亭 valet_stand（fallback null）', NR.propKey === 'night_market_stall_oyster' && NR.altPropKeys.includes('night_market_stall_tea') && NR.fallbackPropKey === 'night_market_stall' && VP.propKey === 'valet_stand' && VP.fallbackPropKey === null);
check('跑單時限 = Σ 直線 × 1.3 / 3.5 + 20（向上取整）', runTimeLimit([100, 50]) === Math.ceil((150 * 1.3) / 3.5 + 20) && runTimeLimit([]) === 20, String(runTimeLimit([100, 50])));
check('跑單報酬 = Σ (80 + 0.25 × 路段) + 剩餘秒 × 1', runReward([100, 40], 30) === Math.round(80 + 25 + 80 + 10 + 30) && runReward([100, 40], 30, false) === 195);
check('泊車時限 = 路線長 / 8 + 45；報酬 = 300 × (1 − 損壞 × 0.7) + 剩餘 × 2', valetTimeLimit(160) === 65 && valetReward(0, 10) === 320 && valetReward(0.5, 0) === 195 && valetReward(2, 0) === 90);
check('angleDeltaDeg 跨 ±180 正規化', Math.abs(angleDeltaDeg(Math.PI - 0.01, -Math.PI + 0.01) + 1.146) < 0.01);

// ======================= 2. 夜市跑單 =======================
{
  const E = setupJobs({ hour: 12 });
  E.at(STALL_BACK);
  E.tick();
  check('跑單：時段外（12 時）不開放、接單點無互動', !E.jobs.isOpen(NR.id) && (E.jobs.nearest(STALL_BACK) === null || E.jobs.nearest(STALL_BACK).id !== `job:${NR.id}`));
  E.setHour(23.9);
  E.tick();
  check('跑單：23.9 時開放並發 job:available（座標 = stallBack）', E.jobs.isOpen(NR.id) && E.of('job:available').some((e) => e.p.id === NR.id && e.p.x === STALL_BACK.x && e.p.z === STALL_BACK.z));
  E.setHour(24.0);
  E.tick();
  check('跑單：24 時（= 0 時）關閉', !E.jobs.isOpen(NR.id));
  E.setHour(18);
  E.tick();
  check('跑單：18 時整開放', E.jobs.isOpen(NR.id));
  check('跑單：攤主側 2.5 m 外無互動、2.4 m 內有（priority 3）', E.jobs.nearest({ x: STALL_BACK.x + 2.6, z: STALL_BACK.z }) === null && E.jobs.nearest({ x: STALL_BACK.x + 2.4, z: STALL_BACK.z })?.priority === 3);
  check('跑單：開放時標記 job-start', E.jobs.markers().some((m) => m.kind === 'job-start' && m.x === STALL_BACK.x));
  const it = E.jobs.nearest(STALL_BACK);
  const ok = it.act();
  const st = E.of('job:start')[0];
  const act = E.jobs.active();
  check('跑單接單：rng 0.9 → 3 位客人，job:start 帶 limitSec', ok && st && st.p.id === NR.id && st.p.customers === 3 && act.total === 3 && Number.isFinite(st.p.limitSec));
  const dests = E.jobs.markers().filter((m) => m.kind === 'job-dest');
  const pairOk = dests.every((a, i) => dests.every((b, j) => i === j || Math.hypot(a.x - b.x, a.z - b.z) >= 20));
  check('跑單：客人 3 個 job-dest 標記、彼此 ≥ 20 m（太近的候選被拒）', dests.length === 3 && pairOk && !dests.some((d) => d.x === 610));
  const call = E.sidewalkNear.calls[0];
  check('跑單：sidewalkNear(stall.x, stall.z, rng, 40, 160)', call.x === STALL.x && call.z === STALL.z && call.minM === 40 && call.maxM === 160 && call.rngFn);
  // 路段：攤位起最近鄰 → (600,-125) 42.8、(557,-60) 距上 76.7、(480,-125) 距上 100.9
  const l1 = Math.hypot(600 - 557.2, -125 + 126.48);
  const l2 = Math.hypot(557 - 600, -60 + 125);
  const l3 = Math.hypot(480 - 557, -125 + 60);
  check('跑單時限依最近鄰路段計算', act.limitSec === runTimeLimit([l1, l2, l3]), `${act.limitSec}`);
  check('跑單進行中：攤位不再有接單互動、標記不含 job-start', E.jobs.nearest(STALL_BACK) === null && !E.jobs.markers().some((m) => m.kind === 'job-start'));
  check('跑單：nav:destination source job', E.of('nav:destination').some((e) => e.p.source === 'job'));
  // 送餐：3.1 m 外無、2.9 m 內有
  E.at({ x: 600, z: -125 });
  check('跑單：客人 3 m 外不能送、3 m 內可送', E.jobs.nearest({ x: 603.1, z: -125 }) === null && E.jobs.nearest({ x: 602.9, z: -125 })?.id === `job:${NR.id}:deliver`);
  E.jobs.nearest({ x: 600, z: -125 }).act();
  E.tick(STEP, 600); // 10 s 步行
  E.at({ x: 557, z: -60 });
  E.jobs.nearest({ x: 557, z: -60 }).act();
  check('跑單：送 2/3 後仍進行中、剩 1 個 job-dest', E.jobs.isEngaged() && E.jobs.active().delivered === 2 && E.jobs.markers().filter((m) => m.kind === 'job-dest').length === 1);
  const before = E.jobs.active();
  const left = before.limitSec - before.elapsedSec;
  E.at({ x: 480, z: -125 });
  E.jobs.nearest({ x: 480, z: -125 }).act();
  const done = E.of('job:complete')[0];
  check('跑單完成：job:complete 報酬 = 公式（含剩餘秒）、入帳 reason job', done && done.p.reward === runReward([l1, l2, l3], left) && E.money.length === 1 && E.money[0].r === 'job' && E.money[0].n === done.p.reward, JSON.stringify(done && done.p));
  check('跑單完成：nav:clear source job、不再進行', E.of('nav:clear').some((e) => e.p.source === 'job') && !E.jobs.isEngaged());
  E.at(STALL_BACK);
  E.tick(STEP, 60 * 149);
  check('跑單冷卻 150 s：149 s 時仍未開放', !E.jobs.isOpen(NR.id));
  E.tick(STEP, 61);
  check('跑單冷卻 150 s：150 s 後重新開放（可重複）', E.jobs.isOpen(NR.id));
  check('跑單：serialize completed 計數 1', E.jobs.serialize().completed[NR.id] === 1);
}
{
  const E = setupJobs({ rng: () => 0.1 });
  E.at(STALL_BACK);
  E.tick();
  E.jobs.nearest(STALL_BACK).act();
  check('跑單：rng 0.1 → 2 位客人', E.jobs.active().total === 2);
}
{
  const E = setupJobs({ sidewalkNear: makeSidewalk([{ x: 600, z: -125 }, null]) });
  E.at(STALL_BACK);
  E.tick();
  const ok = E.jobs.nearest(STALL_BACK).act();
  check('跑單：找不到 ≥ 2 位合格客人 → 不接單、仍開放', ok === false && !E.jobs.isEngaged() && E.jobs.isOpen(NR.id));
}
{
  // 開車 > 3 s → fail 'vehicle'
  const E = setupJobs();
  E.at(STALL_BACK);
  E.tick();
  E.jobs.nearest(STALL_BACK).act();
  E.ctx.driving = true;
  E.tick(STEP, 180);
  const at3 = E.jobs.isEngaged();
  E.tick(STEP, 1);
  const fl = E.of('job:fail')[0];
  check('跑單：連續開車剛好 3.0 s 尚未失敗、超過即 fail vehicle', at3 && fl && fl.p.reason === 'vehicle' && !E.jobs.isEngaged());
  check('跑單失敗：不入帳', E.money.length === 0);
  E.ctx.driving = false;
  E.tick(STEP, 60 * 59);
  const at59 = E.jobs.isOpen(NR.id);
  E.tick(STEP, 61);
  check('跑單失敗冷卻 60 s', !at59 && E.jobs.isOpen(NR.id));
  // 開車中斷再開不累計
  E.jobs.nearest(STALL_BACK).act();
  E.ctx.driving = true;
  E.tick(STEP, 150);
  E.ctx.driving = false;
  E.tick(STEP, 1);
  E.ctx.driving = true;
  E.tick(STEP, 150);
  check('跑單：開車 2.5 s → 下車 → 再開 2.5 s 不失敗（連續才算）', E.jobs.isEngaged());
  E.ctx.driving = false;
  E.jobs.onPlayerKo();
  check('跑單：KO → fail ko', E.of('job:fail').at(-1).p.reason === 'ko');
}
{
  const E = setupJobs();
  E.at(STALL_BACK);
  E.tick();
  E.jobs.nearest(STALL_BACK).act();
  const lim = E.jobs.active().limitSec;
  E.tick(0, 1000);
  check('跑單：simDt = 0 不推進（elapsed 仍 0）', E.jobs.active().elapsedSec === 0);
  E.tick(STEP, Math.round(lim * 60) - 1);
  const alive = E.jobs.isEngaged();
  E.tick(STEP, 1);
  check('跑單：逾時 → fail timeout（剛好在 limit 那一子步）', alive && E.of('job:fail')[0]?.p.reason === 'timeout');
  E.tick(STEP, 3700);
  E.jobs.nearest(STALL_BACK).act();
  E.jobs.abandon();
  check('跑單：abandon → fail abandon', E.of('job:fail').at(-1).p.reason === 'abandon');
  E.setHour(23.99);
  E.tick(STEP, 3700);
  E.jobs.nearest(STALL_BACK).act();
  E.setHour(0.5);
  E.tick(STEP, 60);
  check('跑單：接單後跨出時段仍可跑完（不作廢）', E.jobs.isEngaged());
}
// 60 / 120 / 144 Hz 子步等價：同一段實際時間，逾時發生在同一個模擬子步
{
  function simulate(hz) {
    const E = setupJobs();
    E.at(STALL_BACK);
    E.tick();
    E.jobs.nearest(STALL_BACK).act();
    let acc = 0;
    let sub = 0;
    const frame = 1 / hz;
    for (let f = 0; f < hz * 400 && E.jobs.isEngaged(); f++) {
      acc += frame;
      const n = Math.min(5, Math.floor(acc / STEP + 1e-9));
      acc -= n * STEP;
      sub += n;
      E.clock.t += n * STEP;
      E.jobs.update(n * STEP, E.ctx);
    }
    return sub;
  }
  const a = simulate(60);
  const b = simulate(120);
  const c = simulate(144);
  check('跑單逾時：60 / 120 / 144 Hz 在同一個子步數失敗', a === b && b === c && a > 0, `${a} / ${b} / ${c}`);
}

// ======================= 3. 代客泊車 =======================
function carSet(car, x, z, yaw, speed) {
  car.pos.x = x;
  car.pos.z = z;
  car.yaw = yaw;
  car.speed = speed;
}
{
  const E = setupJobs({ hour: null });
  E.at({ x: STAND.standX, z: STAND.standZ });
  E.tick();
  check('泊車：不限時段（無遊戲時刻來源也開放）', E.jobs.isOpen(VP.id) && !E.jobs.isOpen(NR.id));
  const it = E.jobs.nearest({ x: STAND.standX + 1, z: STAND.standZ });
  check('泊車：泊車亭 2.5 m 內接單互動', it && it.id === `job:${VP.id}`);
  it.act();
  const car = E.spawned[0]?.car;
  check('泊車接單：spawnValetCar 收到 car 位姿', car && E.spawned[0].pose.x === STAND.carX && E.spawned[0].pose.z === STAND.carZ && E.spawned[0].pose.yaw === STAND.carYaw);
  const lim = E.jobs.active().limitSec;
  check('泊車時限 = 直線 × 1.3 / 8 + 45（無路網）', lim === valetTimeLimit(60 * 1.3), String(lim));
  check('泊車 stage car：標記 job-car 在車上、無 job-dest', E.jobs.active().stage === 'car' && E.jobs.markers().length === 1 && E.jobs.markers()[0].kind === 'job-car' && E.jobs.markers()[0].x === STAND.carX);
  // 別台車停進車格不算（指定車辨識 = 物件參照）
  const other = { pos: { x: STAND.slotX, z: STAND.slotZ }, yaw: STAND.slotYaw, speed: 0 };
  E.ctx.vehicle = other;
  E.ctx.driving = true;
  E.tick(STEP, 120);
  check('泊車：駕駛別台車停進車格不算完成', E.jobs.isEngaged() && E.jobs.active().stage === 'car');
  E.ctx.vehicle = car;
  E.tick();
  check('泊車：上指定車 → stage park、標記 job-dest = 車格、job:stage park', E.jobs.active().stage === 'park' && E.jobs.markers()[0].kind === 'job-dest' && E.jobs.markers()[0].x === STAND.slotX && E.of('job:stage').some((e) => e.p.stage === 'park'));
  const deg = Math.PI / 180;
  carSet(car, STAND.slotX + 1.21, STAND.slotZ, STAND.slotYaw, 0);
  E.tick(STEP, 120);
  check('泊車門檻：距車格 1.21 m 不算停妥', E.jobs.isEngaged());
  carSet(car, STAND.slotX, STAND.slotZ, STAND.slotYaw + 15.5 * deg, 0);
  E.tick(STEP, 120);
  check('泊車門檻：偏 15.5° 不算停妥', E.jobs.isEngaged());
  carSet(car, STAND.slotX, STAND.slotZ, STAND.slotYaw, 0.55);
  E.tick(STEP, 120);
  check('泊車門檻：速度 0.55 m/s 不算停妥', E.jobs.isEngaged());
  check('isParked：1.19 m / 14.9° / 0.49 m/s 同時成立 → true；不在車上 → false', isParked({ x: STAND.slotX + 1.19, z: STAND.slotZ, yaw: STAND.slotYaw - 14.9 * deg, speed: -0.49 }, STAND, true) && !isParked({ x: STAND.slotX, z: STAND.slotZ, yaw: STAND.slotYaw, speed: 0 }, STAND, false));
  // 維持 0.5 s 後中斷 → 歸零
  carSet(car, STAND.slotX + 1.0, STAND.slotZ, STAND.slotYaw + 10 * deg, 0.3);
  E.tick(STEP, 30);
  carSet(car, STAND.slotX + 1.0, STAND.slotZ, STAND.slotYaw, 1.0);
  E.tick(STEP, 1);
  carSet(car, STAND.slotX + 1.0, STAND.slotZ, STAND.slotYaw, 0);
  E.tick(STEP, 59);
  check('泊車：停妥維持中斷會重算（0.5 s + 中斷 + 0.98 s 未完成）', E.jobs.isEngaged());
  E.health.set(car, 600); // 損壞 40%
  const a = E.jobs.active();
  const leftAfter = a.limitSec - (a.elapsedSec + STEP);
  E.tick(STEP, 1);
  const done = E.of('job:complete')[0];
  check('泊車：條件連續 1.0 s → 完成', done && done.p.id === VP.id);
  check('泊車報酬 = 300 × (1 − 0.4 × 0.7) + 剩餘 × 2、入帳 reason job', done && done.p.reward === valetReward(0.4, leftAfter) && E.money[0].r === 'job' && done.p.damagePct === 40, JSON.stringify(done && done.p));
  check('泊車完成：releaseValetCar(指定車)', E.released.length === 1 && E.released[0] === car);
  E.tick(STEP, 60 * 119);
  const cool = !E.jobs.isOpen(VP.id);
  E.tick(STEP, 61);
  check('泊車冷卻 120 s', cool && E.jobs.isOpen(VP.id));
}
{
  // 失敗 1：車毀（vehicle:disabled 指定車）；別台車毀不影響
  const E = setupJobs();
  E.at({ x: STAND.standX, z: STAND.standZ });
  E.tick();
  E.jobs.nearest({ x: STAND.standX, z: STAND.standZ }).act();
  const car = E.spawned[0].car;
  E.bus.emit('vehicle:disabled', { vehicle: { pos: { x: 0, z: 0 } } });
  const alive = E.jobs.isEngaged();
  E.bus.emit('vehicle:disabled', { vehicle: car });
  check('泊車失敗 destroyed：只認指定車的 vehicle:disabled', alive && E.of('job:fail')[0]?.p.reason === 'destroyed' && E.released[0] === car);
  E.tick(STEP, 60 * 59);
  const cool = !E.jobs.isOpen(VP.id);
  E.tick(STEP, 61);
  check('泊車失敗冷卻 60 s', cool && E.jobs.isOpen(VP.id));
  // 失敗 1b：healthOf = 0（未經 bus）也算車毀
  E.jobs.nearest({ x: STAND.standX, z: STAND.standZ }).act();
  E.health.set(E.spawned[1].car, 0);
  E.tick();
  check('泊車失敗 destroyed：healthOf 歸 0 亦判定', E.of('job:fail').at(-1).p.reason === 'destroyed');
}
{
  // 失敗 2：逾時（路線長由 routeLength 注入）
  const E = setupJobs({ routeLength: () => ({ lengthM: 160 }) });
  E.at({ x: STAND.standX, z: STAND.standZ });
  E.tick();
  E.jobs.nearest({ x: STAND.standX, z: STAND.standZ }).act();
  check('泊車時限吃 routeLength：160 m → 65 s', E.jobs.active().limitSec === 65);
  E.ctx.vehicle = E.spawned[0].car;
  E.tick(STEP, 65 * 60 - 1);
  const alive = E.jobs.isEngaged();
  E.tick(STEP, 1);
  check('泊車失敗 timeout（65 s）', alive && E.of('job:fail')[0]?.p.reason === 'timeout' && E.released.length === 1);
}
{
  // 失敗 3：離車 > 40 m 持續 5 s
  const E = setupJobs();
  E.at({ x: STAND.standX, z: STAND.standZ });
  E.tick();
  E.jobs.nearest({ x: STAND.standX, z: STAND.standZ }).act();
  const car = E.spawned[0].car;
  E.at({ x: STAND.carX, z: 41 }); // 距車 41 m
  E.tick(STEP, 299);
  const at499 = E.jobs.isEngaged();
  E.at({ x: STAND.carX, z: 39 });
  E.tick(STEP, 1);
  E.at({ x: STAND.carX, z: 41 });
  E.tick(STEP, 299);
  const reset = E.jobs.isEngaged();
  E.tick(STEP, 1);
  check('泊車失敗 lost：> 40 m 連續 5 s（回到 40 m 內歸零）', at499 && reset && E.of('job:fail')[0]?.p.reason === 'lost' && E.released[0] === car);
  // 在車上即使遠也不算
  E.tick(STEP, 3700);
  E.jobs.nearest({ x: STAND.standX, z: STAND.standZ }).act();
  E.ctx.vehicle = E.spawned[1].car;
  E.at({ x: 9999, z: 9999 });
  E.tick(STEP, 600);
  check('泊車：玩家在指定車上不計離車', E.jobs.isEngaged());
  E.jobs.onPlayerKo();
  check('泊車：KO → fail ko 且 release', E.of('job:fail').at(-1).p.reason === 'ko' && E.released.length === 2);
  E.ctx.vehicle = null;
}
{
  const E = setupJobs({ noSpawn: true });
  E.tick();
  check('泊車：缺 spawnValetCar → 泊車不作用（跑單照常）', !E.jobs.isOpen(VP.id) && E.jobs.isOpen(NR.id) && E.jobs.enabled().join() === NR.id);
  const N = setupJobs({ spots: null });
  N.tick();
  check('缺 jobSpots → 兩種打工都不作用', N.jobs.enabled().length === 0 && N.jobs.markers().length === 0 && N.jobs.nearest({ x: 0, z: 0 }) === null);
}
{
  // serialize / restore（進行中作廢不發 fail、release 指定車）
  const E = setupJobs();
  E.at({ x: STAND.standX, z: STAND.standZ });
  E.tick();
  E.jobs.nearest({ x: STAND.standX, z: STAND.standZ }).act();
  E.jobs.abandon();
  const ser = E.jobs.serialize();
  check('serialize：失敗冷卻 60 s', ser.cooldowns[VP.id] === 60, JSON.stringify(ser));
  E.jobs.nearest({ x: 0, z: 0 });
  const F = setupJobs();
  F.at({ x: STAND.standX, z: STAND.standZ });
  F.tick();
  F.jobs.nearest({ x: STAND.standX, z: STAND.standZ }).act();
  const fails = F.of('job:fail').length;
  F.jobs.restore({ completed: { [NR.id]: 3, 'night-market-delivery': 9, bogus: 1 }, cooldowns: { [VP.id]: 999, [NR.id]: 30 } });
  const s2 = F.jobs.serialize();
  check('restore：進行中作廢（不發 fail、release 車）、未知 id 忽略、冷卻夾到 max(cd, failCd)', !F.jobs.isEngaged() && F.of('job:fail').length === fails && F.released.length === 1 && s2.completed[NR.id] === 3 && !('night-market-delivery' in s2.completed) && s2.cooldowns[VP.id] === 120 && s2.cooldowns[NR.id] === 30, JSON.stringify(s2));
}

// ======================= 4. createMissions 整合 =======================
const LANDMARKS = [
  { id: 148849083, slug: 'shin_kong_mitsukoshi', name: '新光三越', x: 584, z: -91, radius: 25 },
  { id: 'national_taichung_theater', slug: 'national_taichung_theater', name: '臺中國家歌劇院', x: 330, z: 380, radius: 25 },
  { id: 'taichung_city_hall', slug: 'taichung_city_hall', name: '臺中市政府', x: 820, z: 470, radius: 25 },
  { id: 222636758, slug: 'taichung_city_council', name: '臺中市議會', x: 1010, z: 400, radius: 25 },
  { id: 'qiuhonggu_pavilion', slug: 'qiuhonggu_pavilion', name: '秋紅谷', x: 120, z: -330, radius: 15 },
  { id: 'lin_hotel', slug: 'lin_hotel', name: '林酒店', x: -150, z: -420, radius: 25 },
];
const notFound = async () => {
  throw new Error('404');
};
function setupMs(extra = {}) {
  const bus = createBus();
  const log = [];
  for (const n of ['mission:start', 'mission:fail', 'event:available', 'event:start', 'event:closed', 'job:available', 'job:start', 'job:complete', 'job:fail']) bus.on(n, (p) => log.push({ n, p }));
  const clock = { t: 1000 };
  const money = [];
  const released = [];
  let hour = extra.hour === undefined ? 19 : extra.hour;
  const spawned = [];
  const ms = createMissions({
    bus, scene: null, root: null, doc: null, landmarks: LANDMARKS, addMoney: (n, r) => money.push({ n, r }), fetchJson: notFound, now: () => clock.t, rng: () => 0.9, info: () => {},
    getGameHour: () => hour,
    jobSpots: { stall: STALL, stallBack: STALL_BACK, sidewalkNear: makeSidewalk(), valet: [STAND] },
    spawnValetCar: (pose) => {
      const car = { pos: { x: pose.x, z: pose.z }, yaw: pose.yaw, speed: 0 };
      spawned.push(car);
      return car;
    },
    releaseValetCar: (v) => released.push(v),
    healthOf: () => 1000,
    ...extra,
  });
  const ctx = { x: 0, z: 0, driving: false, vehicle: null };
  const tick = (n = 1, dt = STEP) => {
    for (let i = 0; i < n; i++) {
      clock.t += dt;
      ms.update(dt, ctx);
    }
  };
  const at = (p) => {
    ctx.x = p.x;
    ctx.z = p.z;
  };
  return { ms, bus, log, money, released, spawned, clock, ctx, tick, at, setHour: (h) => (hour = h), of: (n) => log.filter((e) => e.n === n) };
}
{
  check('MISSION_STAT_EVENTS 增 job:complete → missionsDone、job:fail → missionsFailed', MISSION_STAT_EVENTS['job:complete'] === 'missionsDone' && MISSION_STAT_EVENTS['job:fail'] === 'missionsFailed' && MISSION_STAT_EVENTS['mission:complete'] === 'missionsDone');
  const { list } = normalizeCatalog(BUILTIN_MISSIONS, LANDMARKS);
  check('catalog 正規化補 category: mission', list.length === 3 && list.every((m) => m.category === 'mission'));
  check('時段事件定義 category nearby', NIGHT_MARKET_DELIVERY.category === 'nearby');

  const E = setupMs();
  await E.ms.ready;
  const stats = { missionsDone: 0, missionsFailed: 0 };
  trackMissionStats(E.bus, stats);
  E.at(STALL_BACK);
  E.tick(2);
  const it = E.ms.nearest(STALL_BACK);
  check('整合：攤主側 2.5 m 內打工優先於重疊的外送取餐點（radius 12）', it && it.id === `job:${NR.id}` && E.ms.events.isOpen(NIGHT_MARKET_DELIVERY.id));
  check('整合：攤位 3 m 外（仍在取餐 radius 12 內）→ 外送取餐', E.ms.nearest({ x: STALL_BACK.x, z: STALL_BACK.z + 5 })?.id === `event:${NIGHT_MARKET_DELIVERY.id}`);
  const kinds = new Set(E.ms.markers().map((m) => m.kind));
  check('整合 markers：mission-start + event-start + job-start 並存', kinds.has('mission-start') && kinds.has('event-start') && kinds.has('job-start'));
  const L = [];
  const out = E.ms.listings(STALL_BACK, L);
  const cats = new Set(out.map((x) => x.category));
  const keysOk = out.every((x) => ['id', 'title', 'category', 'reward', 'distanceM', 'navigable', 'x', 'z', 'active'].every((k) => k in x));
  check('listings：mission / nearby / job 三類、欄位齊全、重用 out', out === L && cats.has('mission') && cats.has('nearby') && cats.has('job') && keysOk && out.every((x) => x.navigable && !x.active), JSON.stringify(out.map((x) => [x.id, x.category, x.reward, x.distanceM])));
  const firstObj = out[0];
  E.ms.listings(STALL_BACK, L);
  check('listings：元素物件重用（不配置）', L[0] === firstObj);
  it.act();
  check('整合：打工進行中 → isBusy：委託起點 / 外送取餐點互動與標記隱藏，只剩 job-dest', E.ms.nearest({ x: STALL_BACK.x, z: STALL_BACK.z + 5 }) === null && E.ms.markers().every((m) => m.kind === 'job-dest'));
  const L2 = E.ms.listings(STALL_BACK, L);
  check('listings：打工進行中 → 只有該打工 navigable 且 active', L2.filter((x) => x.navigable).length === 1 && L2.find((x) => x.navigable).id === NR.id && L2.find((x) => x.navigable).active, JSON.stringify(L2.map((x) => [x.id, x.navigable, x.active])));
  const ev0 = E.of('event:start').length;
  E.ms.events.nearest && E.ms.nearest(NIGHT_MARKET_DELIVERY.pickup);
  check('整合：打工中外送取餐不可接', E.of('event:start').length === ev0 && E.ms.nearest(NIGHT_MARKET_DELIVERY.pickup) === null);
  check('整合：objective 由 jobObjective 提供', E.ms.jobObjective() && /夜市跑單/.test(E.ms.jobObjective().text) && E.ms.jobActive().id === NR.id);
  E.ms.abandon();
  check('整合：abandon 走打工 → job:fail abandon、統計 missionsFailed +1', E.of('job:fail')[0]?.p.reason === 'abandon' && stats.missionsFailed === 1);
  const ser = E.ms.serialize();
  check('serialize：打工冷卻併入 missions.events.cooldowns', ser.events && ser.events.cooldowns[NR.id] === 60, JSON.stringify(ser.events));
  // 送完一次 → missionsDone
  E.tick(60 * 61);
  E.ms.nearest(STALL_BACK).act();
  for (const c of E.ms.markers().filter((mk) => mk.kind === 'job-dest').map((mk) => ({ x: mk.x, z: mk.z }))) {
    E.at(c);
    E.ms.nearest(c)?.act();
  }
  check('整合：跑單完成 → missionsDone +1、入帳 job', stats.missionsDone === 1 && E.money.some((m) => m.r === 'job'));
  const ser2 = E.ms.serialize();
  check('serialize：events.completed 含 night-market-run', ser2.events.completed[NR.id] === 1);
  // restore 分流：events / jobs 各自取自己的 id
  const R = setupMs();
  await R.ms.ready;
  R.ms.restore({ completed: {}, best: {}, cooldowns: {}, active: null, events: { completed: { [NR.id]: 4, [NIGHT_MARKET_DELIVERY.id]: 2 }, cooldowns: { [VP.id]: 50, [NIGHT_MARKET_DELIVERY.id]: 100 } } });
  const rs = R.ms.serialize();
  check('restore 分流：jobs 與外送各自還原（id 不互吃）', rs.events.completed[NR.id] === 4 && rs.events.completed[NIGHT_MARKET_DELIVERY.id] === 2 && rs.events.cooldowns[VP.id] === 50 && rs.events.cooldowns[NIGHT_MARKET_DELIVERY.id] === 100, JSON.stringify(rs.events));
}
{
  // 委託進行中 → 打工不開放；泊車進行中 → 垃圾車不出現；垃圾車追車中 → 打工不開放
  const LINE = [{ x: 0, z: -200 }, { x: 0, z: 200 }];
  const E = setupMs({ hour: 17, routeFor: () => LINE });
  await E.ms.ready;
  E.at({ x: STAND.standX, z: STAND.standZ });
  E.tick(2);
  check('整合：17 時跑單不開放、泊車開放、垃圾車出現（未追車）', !E.ms.jobs.isOpen(NR.id) && E.ms.jobs.isOpen(VP.id) && E.ms.truck.isOpen());
  E.ms.nearest({ x: STAND.standX, z: STAND.standZ }).act();
  E.tick(2);
  check('整合：泊車進行中 → 未追車的垃圾車收走', !E.ms.truck.isOpen() && E.of('event:closed').some((e) => e.p.id === 'garbage-truck'));
  E.tick(60 * 40);
  check('整合：泊車進行中垃圾車不再出現', !E.ms.truck.isOpen());
  E.ms.abandon();
  check('整合：放棄泊車 → release 指定車', E.released.length === 1 && E.released[0] === E.spawned[0]);
  // 追垃圾車
  E.tick(60 * 200);
  E.at(E.ms.truckState() || { x: 0, z: 0 });
  E.tick(2);
  check('整合：追垃圾車中 → 打工不開放（isBusy）', E.ms.truck.isEngaged() && !E.ms.jobs.isOpen(VP.id) && !E.ms.markers().some((m) => m.kind === 'job-start'));
  E.ms.truck.abandon();
  E.tick(2);
  check('整合：垃圾車結束 → 泊車重新開放', E.ms.jobs.isOpen(VP.id));
  // 委託進行中
  const offer = E.ms.offers()[0];
  const m = E.ms.catalog().find((c) => c.slug === offer);
  E.at(m.from);
  E.tick(1);
  E.ms.nearest(m.from).act();
  E.tick(2);
  check('整合：委託進行中 → 打工不開放、listings 只有委託 navigable', E.of('mission:start').length === 1 && !E.ms.jobs.isOpen(VP.id) && E.ms.listings(m.from).filter((x) => x.navigable).every((x) => x.category === 'mission' && x.active));
}
{
  const E = setupMs({ jobSpots: null });
  await E.ms.ready;
  E.at(STALL_BACK);
  E.tick(2);
  check('整合：未注入 jobSpots → 打工完全不作用（既有行為不變）', !E.ms.markers().some((m) => m.kind.startsWith('job-')) && E.ms.nearest(STALL_BACK)?.id === `event:${NIGHT_MARKET_DELIVERY.id}`);
  const F = setupMs({ jobs: false });
  await F.ms.ready;
  check('整合：jobs: false 關閉', F.ms.jobs === null);
}

// ======================= 5. 地圖色表 / 圖例 / 靜態 =======================
check('marker-colors：job-start / job-dest / job-car 有色碼且互不相同、不撞既有色', ['job-start', 'job-dest', 'job-car'].every((k) => /^#[0-9a-f]{6}$/i.test(MARKER_COLORS[k])) && new Set(Object.values(MARKER_COLORS)).size === Object.keys(MARKER_COLORS).length);
check('big-map：MARKER_LABELS 與色表同一份 kind 清單、job-dest 為圖釘、job-start / job-car 為圓點', Object.keys(MARKER_COLORS).join() === Object.keys(MARKER_LABELS).join() && PIN_KINDS.has('job-dest') && !PIN_KINDS.has('job-start') && !PIN_KINDS.has('job-car'));
const jobsSrc = fs.readFileSync(path.join(ROOT, 'src/missions/jobs.js'), 'utf8');
check('jobs.js 不 import three / DOM / daynight / navigation / main', !/^import /m.test(jobsSrc) && !/document\.|window\./.test(jobsSrc));
const trafficSrc = fs.existsSync(path.join(ROOT, 'src/traffic.js')) ? fs.readFileSync(path.join(ROOT, 'src/traffic.js'), 'utf8') : '';
const carTypes = (trafficSrc.match(/CAR_TYPES\s*=\s*\[[^\]]*\]/) || [''])[0];
check('traffic.js CAR_TYPES 不含 garbage_truck', !carTypes.includes('garbage_truck'));
check('全程無 console.error', errors === 0, String(errors));

console.log(`${failed ? 'FAIL' : 'PASS'} ${failed ? failed : passed}/${passed + failed}`);
process.exit(failed ? 1 : 0);
