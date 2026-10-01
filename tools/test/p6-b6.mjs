#!/usr/bin/env node
// Phase 6 B6 回歸（docs/dev/interfaces.md §20 時間步、§23.1 攤車碰撞盒、§23.5 垃圾車警示燈）
// 用法：node tools/test/p6-b6.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// three 以 loader hook 換成最小替身（同 garbage-truck.mjs），.json → ES module、.css → 空字串；不需要 node_modules
// 項目：
//   1. 幀率不變性：委託（createMissions）/ 夜市外送（createTimedEvents）/ 垃圾車（createGarbageTruck）以 FixedStepper（1/60 子步）的 simDt 推進，
//      60 / 120 / 144 Hz 與抖動幀（含零子步、雙子步幀）推進相同模擬時間 → 計時（elapsed / timer）、位置、事件序列（含發生的子步序號）一致
//      容差：秒數 TIME_TOL 1e-9、位置 POS_TOL 1e-6 m；事件序列 120 / 144 Hz 逐筆相同、抖動幀 ≤ 2 子步；
//      外送 event:available 容許早 1 子步（events.js 零子步幀也做開放判定，屬 E6）。敏感度：144 Hz 改餵渲染 dt 必須抓得到不一致
//   2. propColliderBox：攤車半尺寸 [1.11, 1.52, 0.78]、yaw 0.7 時中心 = placement + 旋轉後偏移、未知 id 退回 manifest 外接盒 / null
//   3. beaconLevel 晝夜：夜間峰值 > 白天峰值、白天 ≤ BEACON_DAY、會閃爍；truck().beaconT 只吃 simDt；applyBeacon 只動 beacon 材質
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

const { FixedStepper, DEFAULT_STEP } = await import('../../src/physics/world.js');
const GT = await import('../../src/missions/garbage-truck.js');
const { createTimedEvents, NIGHT_MARKET_DELIVERY: NM } = await import('../../src/missions/events.js');
const { createMissions } = await import('../../src/missions/index.js');
const { createBus } = await import('../../src/core/events.js');
const PM = await import('../../src/prop-model.js');
const { createGarbageTruck, beaconLevel, applyBeacon, BEACON_DAY, BEACON_NIGHT, GARBAGE_TRUCK_EVENT: DEF } = GT;

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;

const STEP = DEFAULT_STEP;
const TIME_TOL = 1e-9; // s
const POS_TOL = 1e-6; // m
const JITTER_EVENT_TOL = 2; // 子步：抖動幀（含雙子步）下事件的發生子步容差（幀尾判定的量化；120 / 144 Hz 每幀 ≤ 1 子步，要求 0）
// 抖動幀：1/60 上下浮動，含零子步（0.4 / 60）與雙子步（1.6 / 60 累加後）幀
const JITTER = [0.4, 1.6, 1, 0.7, 1.3, 0.25, 1.75, 1].map((k) => k / 60);
const PATTERNS = [
  { name: '60 Hz', dts: [1 / 60] },
  { name: '120 Hz', dts: [1 / 120] },
  { name: '144 Hz', dts: [1 / 144] },
  { name: '抖動', dts: JITTER },
];

// 以渲染幀推進到恰好 nSteps 個子步；每幀 tick(simDt, simT, renderDt)（零子步幀也呼叫，simDt = 0）
// 回傳 { frames, zeroFrames, multiFrames }；renderDt 模式（敏感度檢查）把渲染 dt 當 simDt 餵
function drive(dts, nSteps, tick, { feedRender = false } = {}) {
  const st = new FixedStepper(STEP);
  let steps = 0;
  let frames = 0;
  let zeroFrames = 0;
  let multiFrames = 0;
  let simT = 0;
  let renderT = 0;
  while (steps < nSteps) {
    let dt = dts[frames % dts.length];
    if (steps + st.preview(dt) > nSteps) dt = Math.max(1e-6, (nSteps - steps) * STEP - st.acc + 1e-10);
    const r = st.advance(dt, () => {});
    steps += r.steps;
    simT = steps * STEP;
    renderT += dt;
    frames++;
    if (r.steps === 0) zeroFrames++;
    if (r.steps > 1) multiFrames++;
    tick(feedRender ? dt : r.simDt, feedRender ? renderT : simT, dt);
  }
  return { frames, zeroFrames, multiFrames, steps };
}

// 事件序列：[名稱, 發生時的子步序號]（同一子步內的順序也比）
function logger(clock) {
  const log = [];
  return { log, emit: (n, p) => log.push(`${n}@${Math.round(clock.sim / STEP)}${p && p.reason ? ':' + p.reason : ''}`) };
}

// ---------- 1a. 垃圾車 ----------
const LINE = [{ x: 0, z: 0 }, { x: 0, z: 400 }, { x: 300, z: 400 }];
function runTruck(dts, opts) {
  const clock = { sim: 0 };
  const L = logger(clock);
  const truck = createGarbageTruck({ getGameHour: () => 17, routeFor: () => LINE, bus: { emit: L.emit }, now: () => 1000 + clock.sim, rng: () => 0.5 });
  const samples = [];
  const N1 = 2833; // 47.2 s：開放 → 追車 → 停靠數次
  const N2 = Math.round((DEF.limitSec + 5) / STEP); // 再跑到逾時
  const info = drive(dts, N1, (simDt, simT) => {
    clock.sim = simT;
    truck.update(simDt, { x: 5, z: 30, night: 1 });
  }, opts);
  const tk = truck.truck();
  samples.push(tk && { x: tk.x, z: tk.z, heading: tk.heading, stopped: tk.stopped, beaconT: tk.beaconT, beaconLevel: tk.beaconLevel, elapsed: truck.active() && truck.active().elapsedSec });
  const info2 = drive(dts, N2, (simDt, simT) => {
    clock.sim = N1 * STEP + simT;
    truck.update(simDt, { x: 5, z: 30, night: 1 });
  }, opts);
  return { samples, log: L.log, zero: info.zeroFrames + info2.zeroFrames, multi: info.multiFrames + info2.multiFrames };
}

// ---------- 1b. 夜市外送 ----------
const DESTS = [{ slug: 'far', name: '遠方', x: 557.2, z: 600, radius: 20 }];
function runDelivery(dts, opts) {
  const clock = { sim: 0 };
  const L = logger(clock);
  const ev = createTimedEvents({ getGameHour: () => 20, destinations: DESTS, routeLength: () => 900, bus: { emit: L.emit }, now: () => 1000 + clock.sim, rng: () => 0.5 });
  const PICK = { x: NM.pickup.x, z: NM.pickup.z };
  drive(dts, 30, (simDt, simT) => {
    clock.sim = simT;
    ev.update(simDt, PICK);
  }, opts);
  const it = ev.nearest(PICK);
  if (it) it.act();
  const base = 30 * STEP;
  let a = null;
  const N1 = 1777; // 29.6 s 中途取樣
  const info = drive(dts, N1, (simDt, simT) => {
    clock.sim = base + simT;
    ev.update(simDt, PICK);
  }, opts);
  const ac = ev.active();
  a = ac && { elapsed: ac.elapsedSec, timer: ac.timerSec, limit: ac.limitSec };
  const limit = ac ? ac.limitSec : 0;
  const info2 = drive(dts, Math.round((limit + 3) / STEP), (simDt, simT) => {
    clock.sim = base + N1 * STEP + simT;
    ev.update(simDt, PICK);
  }, opts);
  return { picked: !!it, a, log: L.log, zero: info.zeroFrames + info2.zeroFrames };
}

// ---------- 1c. 委託 ----------
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
async function runMission(dts, opts) {
  const clock = { sim: 0 };
  const bus = createBus();
  const L = logger(clock);
  for (const n of ['mission:start', 'mission:complete', 'mission:fail', 'mission:stage']) bus.on(n, (p) => L.emit(n, p));
  const ms = createMissions({ bus, scene: null, root: null, doc: null, landmarks: LANDMARKS, addMoney: () => {}, fetchJson: notFound, now: () => 1000 + clock.sim, rng: () => 0.42, info: () => {}, events: false });
  await ms.ready;
  const FAR = { x: -500, z: 800 };
  drive(dts, 12, (simDt, simT) => {
    clock.sim = simT;
    ms.update(simDt, FAR);
  }, opts);
  const slug = ms.offers()[0];
  const m = ms.catalog().find((c) => c.slug === slug);
  let base = 12 * STEP;
  drive(dts, 6, (simDt, simT) => {
    clock.sim = base + simT;
    ms.update(simDt, { x: m.from.x, z: m.from.z });
  }, opts);
  base += 6 * STEP;
  const it = ms.nearest(m.from);
  if (it) it.act();
  const N1 = 2501; // 41.68 s
  const info = drive(dts, N1, (simDt, simT) => {
    clock.sim = base + simT;
    ms.update(simDt, { x: m.from.x, z: m.from.z });
  }, opts);
  const ac = ms.active();
  const a = ac && { elapsed: ac.elapsedSec, timer: ac.timerSec };
  ms.dispose();
  return { started: !!ac, a, log: L.log, zero: info.zeroFrames };
}

{
  const res = PATTERNS.map((p) => ({ name: p.name, r: runTruck(p.dts) }));
  const ref = res[0].r;
  check('垃圾車 60 Hz 基準：有車、已追車、47.2 s 時計時 = 47.2 s、之後 fail（lost）→ 冷卻後再開放', !!ref.samples[0] && near(ref.samples[0].elapsed, 2833 * STEP, TIME_TOL) && ref.log.some((s) => s.startsWith('event:start@')) && ref.log.some((s) => s.startsWith('event:fail@')) && ref.log.filter((s) => s.startsWith('event:available@')).length >= 2, ref.log.join(' '));
  for (const { name, r } of res.slice(1)) {
    const a = ref.samples[0];
    const b = r.samples[0];
    const same = b && near(a.elapsed, b.elapsed, TIME_TOL) && near(a.beaconT, b.beaconT, TIME_TOL) && near(a.x, b.x, POS_TOL) && near(a.z, b.z, POS_TOL) && near(a.heading, b.heading, 1e-9) && a.stopped === b.stopped && near(a.beaconLevel, b.beaconLevel, 1e-9);
    check(`垃圾車 ${name}：計時 / 位置 / 朝向 / 警示燈與 60 Hz 一致（時間 ±${TIME_TOL} s、位置 ±${POS_TOL} m）`, same, b && `Δelapsed ${(b.elapsed - a.elapsed).toExponential(1)} Δz ${(b.z - a.z).toExponential(1)}`);
    if (name !== '抖動') check(`垃圾車 ${name}：事件序列（含發生子步）與 60 Hz 相同`, r.log.join() === ref.log.join(), r.log.join(' '));
    else {
      // 抖動含雙子步幀：判定（跟丟計時、冷卻到期）在幀尾做一次 → 事件落在幀尾子步，容許每筆 ≤ JITTER_EVENT_TOL 子步；名稱 / 順序須相同
      const key = (s) => s.replace(/@\d+/, '');
      const at = (s) => Number(s.match(/@(\d+)/)[1]);
      const ok = r.log.length === ref.log.length && r.log.every((s, i) => key(s) === key(ref.log[i]) && Math.abs(at(s) - at(ref.log[i])) <= JITTER_EVENT_TOL);
      check(`垃圾車 抖動：事件名稱 / 順序與 60 Hz 相同、發生子步差 ≤ ${JITTER_EVENT_TOL}`, ok, r.log.join(' '));
    }
  }
  const r120 = res[1].r;
  const rJ = res[3].r;
  check('驅動有效：120 / 144 Hz 有零子步幀、抖動幀含零子步與雙子步', r120.zero > 0 && res[2].r.zero > 0 && rJ.zero > 0 && rJ.multi > 0, `120 Hz 零子步 ${r120.zero}、抖動 零 ${rJ.zero} / 雙 ${rJ.multi}`);
  const bad = runTruck(PATTERNS[2].dts, { feedRender: true });
  check('敏感度：144 Hz 改餵渲染 dt（違反 §20）→ 計時與 60 Hz 不一致（測試抓得到）', !near(bad.samples[0].z, ref.samples[0].z, POS_TOL) || bad.log.join() !== ref.log.join());
}
{
  const res = PATTERNS.map((p) => ({ name: p.name, r: runDelivery(p.dts) }));
  const ref = res[0].r;
  check('外送 60 Hz 基準：取餐成功、29.6 s 時 elapsed = 29.6 s、逾時 fail', ref.picked && ref.a && near(ref.a.elapsed, 1777 * STEP, TIME_TOL) && ref.log.some((s) => s.includes('event:fail') && s.endsWith(':timeout')), ref.log.join(' '));
  for (const { name, r } of res.slice(1)) {
    const ok = r.a && near(r.a.elapsed, ref.a.elapsed, TIME_TOL) && near(r.a.timer, ref.a.timer, TIME_TOL) && r.a.limit === ref.a.limit;
    check(`外送 ${name}：elapsed / timer 與 60 Hz 一致（±${TIME_TOL} s）`, ok, r.a && `Δ ${(r.a.elapsed - ref.a.elapsed).toExponential(1)}`);
    // 已知差異（events.js 屬 E6，B6 不改）：開放判定在零子步幀也會做 → event:available 可能比 60 Hz 早 1 子步；其餘事件須逐筆相同
    const strip = (log) => log.filter((s) => !s.startsWith('event:available@'));
    const avail = (log) => log.filter((s) => s.startsWith('event:available@')).map((s) => Number(s.split('@')[1]));
    const da = avail(r.log).map((v, i) => Math.abs(v - avail(ref.log)[i]));
    check(`外送 ${name}：事件序列相同（event:available 容許 ≤ 1 子步）`, strip(r.log).join() === strip(ref.log).join() && da.length === avail(ref.log).length && da.every((d) => d <= 1), r.log.join(' '));
  }
}
{
  const res = [];
  for (const p of PATTERNS) res.push({ name: p.name, r: await runMission(p.dts) });
  const ref = res[0].r;
  check('委託 60 Hz 基準：接單成功、41.68 s 時 elapsed = 41.68 s', ref.started && near(ref.a.elapsed, 2501 * STEP, TIME_TOL), JSON.stringify(ref.a));
  for (const { name, r } of res.slice(1)) {
    const ok = r.a && near(r.a.elapsed, ref.a.elapsed, TIME_TOL) && (ref.a.timer === null ? r.a.timer === null : near(r.a.timer, ref.a.timer, TIME_TOL));
    check(`委託 ${name}：elapsed / timer 與 60 Hz 一致（±${TIME_TOL} s）、事件序列相同`, ok && r.log.join() === ref.log.join(), r.a && `Δ ${(r.a.elapsed - ref.a.elapsed).toExponential(1)} | ${r.log.join(' ')}`);
  }
}

// ======================= 2. propColliderBox（§23.1） =======================
{
  const C = PM.PROP_COLLIDERS.night_market_stall;
  check('PROP_COLLIDERS.night_market_stall = §23.1 定值', C && C.halfW === 1.11 && C.halfD === 0.78 && C.halfH === 1.52 && C.offX === 0 && C.offY === 1.52 && C.offZ === 0);
  const pl = { x: 557.2, y: 3.4, z: -125.1, yaw: 0.7 };
  const b = PM.propColliderBox('night_market_stall', pl);
  check('攤車碰撞盒半尺寸 [1.11, 1.52, 0.78]', b && near(b.width / 2, 1.11, 1e-12) && near(b.height / 2, 1.52, 1e-12) && near(b.depth / 2, 0.78, 1e-12), JSON.stringify(b));
  // 盒中心（世界）= addStaticBox 的 (x, y + height/2, z)；應 = placement + 旋轉後 (offX, offY, offZ)
  const c = Math.cos(pl.yaw);
  const s = Math.sin(pl.yaw);
  const ox = C.offX * c + C.offZ * s;
  const oz = -C.offX * s + C.offZ * c;
  check('yaw 0.7：盒中心 = placement + 旋轉後偏移、yaw 沿用、底面 = placement.y', near(b.x, pl.x + ox, 1e-9) && near(b.z, pl.z + oz, 1e-9) && near(b.y + b.height / 2, pl.y + C.offY, 1e-9) && near(b.y, pl.y, 1e-9) && b.yaw === pl.yaw);
  // 水平偏移非 0 時的旋轉方向（與 propWorldPoint 同一套）：暫掛測試 id
  PM.PROP_COLLIDERS.__t = { halfW: 1, halfD: 0.5, halfH: 1, offX: 0.3, offY: 1.2, offZ: -0.4 };
  const t = PM.propColliderBox('__t', pl);
  const w = PM.propWorldPoint([0.3, 1.2, -0.4], pl);
  check('水平偏移依 yaw 轉到世界（與 propWorldPoint 一致）、y = placement.y + offY − halfH', near(t.x, w.x, 1e-9) && near(t.z, w.z, 1e-9) && near(t.y, pl.y + 0.2, 1e-9));
  delete PM.PROP_COLLIDERS.__t;
  check('未知 id 且 manifest 無條目 → null', PM.propColliderBox('nope', pl) === null);
  // manifest 已登記（glb 缺 three loader 也會登記條目）→ 退回外接盒
  const manifest = { props: [{ id: 'crate', file: 'crate.glb', width: 1, depth: 2, height: 0.5 }] };
  const fakeFetch = async (url) => ({ ok: url.endsWith('manifest.json'), status: 404, headers: { get: () => 'application/json' }, json: async () => manifest });
  const origWarn = console.warn;
  console.warn = () => {};
  await PM.loadPropModels('/t/manifest.json', { fetch: fakeFetch });
  console.warn = origWarn;
  const f = PM.propColliderBox('crate', { x: 1, y: 2, z: 3, yaw: 0.5 });
  check('未列於 PROP_COLLIDERS 的 manifest 道具 → 退回外接盒尺寸、位置 = placement', f && f.width === 1 && f.depth === 2 && f.height === 0.5 && f.x === 1 && f.y === 2 && f.z === 3 && f.yaw === 0.5, JSON.stringify(f));
}

// ======================= 3. beaconLevel 晝夜 =======================
{
  let dayMax = 0;
  let dayMin = Infinity;
  let nightMax = 0;
  let nightMin = Infinity;
  for (let i = 0; i <= 600; i++) {
    const t = i / 120;
    const d = beaconLevel(t, 0);
    const n = beaconLevel(t, 1);
    dayMax = Math.max(dayMax, d);
    dayMin = Math.min(dayMin, d);
    nightMax = Math.max(nightMax, n);
    nightMin = Math.min(nightMin, n);
  }
  check(`beaconLevel 白天低：峰值 ≤ BEACON_DAY ${BEACON_DAY}`, dayMax <= BEACON_DAY + 1e-12 && dayMin >= 0, `${dayMin.toFixed(3)}–${dayMax.toFixed(3)}`);
  check(`beaconLevel 夜間有值：峰值 ≈ BEACON_NIGHT ${BEACON_NIGHT} 且遠大於白天`, near(nightMax, BEACON_NIGHT, 1e-9) && nightMax > dayMax * 5, `${nightMin.toFixed(3)}–${nightMax.toFixed(3)}`);
  check('beaconLevel 閃爍：夜間最暗 < 峰值的 5%', nightMin < nightMax * 0.05);
  check('beaconLevel night 內插單調、boolean / 非法值可用', beaconLevel(0, 0.5) > beaconLevel(0, 0) && beaconLevel(0, 0.5) < beaconLevel(0, 1) && beaconLevel(0, true) === beaconLevel(0, 1) && beaconLevel(0, false) === beaconLevel(0, 0) && Number.isFinite(beaconLevel(NaN, 'x')));
  // truck().beaconT 只隨 simDt 推進；simDt = 0 不動
  const tr = createGarbageTruck({ getGameHour: () => 17, routeFor: () => LINE, now: () => 0 });
  for (let i = 0; i < 30; i++) tr.update(1 / 60, { x: 5, z: 30, night: 1 }); // 第 1 子步開放並推進（開放 = 本幀模擬區間起點）
  const t1 = tr.truck().beaconT;
  for (let i = 0; i < 10; i++) tr.update(0, { x: 5, z: 30, night: 1 });
  check('truck().beaconT 吃 simDt：30 子步 = 0.5 s、simDt 0 的幀不推進；beaconLevel = beaconLevel(beaconT, night)', near(t1, 0.5, TIME_TOL) && tr.truck().beaconT === t1 && near(tr.truck().beaconLevel, beaconLevel(t1, 1), 1e-12));
  tr.update(1 / 60, { x: 5, z: 30, night: 0 });
  check('ctx.night 0 → 白天亮度', tr.truck().beaconLevel <= BEACON_DAY + 1e-12);
  const black = { name: 'beacon', emissive: { r: 0, g: 0, b: 0, setHex(h) { this.hex = h; this.r = 1; } }, emissiveIntensity: 0 };
  const lit = { name: 'beacon_amber', emissive: { r: 1, g: 0.5, b: 0, setHex(h) { this.hex = h; } }, emissiveIntensity: 0 };
  const other = { name: 'headlight', emissive: { r: 1, g: 1, b: 1, setHex() {} }, emissiveIntensity: 0.3 };
  const n = applyBeacon([black, lit, other, null], 1.7);
  check('applyBeacon：只動名稱含 beacon 的材質、emissive 黑者補琥珀色、其他材質不變', n === 2 && black.emissiveIntensity === 1.7 && black.emissive.hex === GT.BEACON_COLOR && lit.emissiveIntensity === 1.7 && lit.emissive.hex === undefined && other.emissiveIntensity === 0.3);
  applyBeacon([black], NaN);
  check('applyBeacon 非法 level → 0', black.emissiveIntensity === 0);
}

console.log(failed ? `FAIL ${failed}/${passed + failed}` : `PASS ${passed}/${passed}`);
process.exit(failed ? 1 : 0);
