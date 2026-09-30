#!/usr/bin/env node
// C3 搶車 + 車輛耐久 / 冒煙無頭驗證：假 bus / 假 vehicle / 假 adapters，不需 Rapier、不需 vehicle.js / traffic.js 本體
// 用法：node tools/test/carjack.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：canStart 距離 / 車速 / 車門側；搶車時間線各 adapter 呼叫時刻、取消分支、事件；
//   耐久：各速度扣值落在目標區間、門檻 setPowerScale 與事件各一次、去重、機車係數、粒子池上限、120 m 外不產生粒子
import { register } from 'node:module';

const JSON_HOOK = `
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function load(url, context, next) {
  if (url.endsWith('.json')) {
    return { format: 'module', shortCircuit: true, source: 'export default ' + readFileSync(fileURLToPath(url), 'utf8') + ';' };
  }
  return next(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(JSON_HOOK)}`, import.meta.url);

// 煙霧貼圖用 2D canvas：最小替身
const ctx2d = new Proxy({}, {
  get: (_, k) => (k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : k === 'measureText' ? () => ({ width: 100 }) : () => {}),
  set: () => true,
});
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d, style: {} }),
};

const THREE = await import('three');
const { createCarjack, doorPoint } = await import('../../src/carjack.js');
const { createVehicleDamage, MAX_PARTICLES } = await import('../../src/vehicle-damage.js');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : String(v));
const kmh = (v) => v / 3.6;

function makeBus() {
  const log = [];
  return {
    log,
    emit(name, payload) {
      log.push({ name, payload });
    },
    count(name) {
      return log.filter((e) => e.name === name).length;
    },
  };
}

// ======================= 搶車 =======================
const SPEC = { length: 4.5, width: 1.85, height: 1.45 };
function candidate({ x = 0, z = 0, yaw = 0, speed = 0, type = 'taxi', twoWheeler = false } = {}) {
  const car = { id: 'npc1', spec: { ...SPEC, ...(twoWheeler ? { length: 1.9, width: 0.7, twoWheeler: true } : {}) } };
  return { car, x, z, yaw, type, color: 0xf5c518, speed, driverVariant: 'male_b' };
}
// yaw = 0 時左方為 +X：駕駛座車門約在 (0.925, 0.45)
{
  const cj = createCarjack({ bus: makeBus() });
  const c = candidate();
  const door = doorPoint(0, 0, 0, SPEC, 1);
  check('車門點在左側（+X）', door.x > 0.9 && door.outX === 1, `door=(${f2(door.x)}, ${f2(door.z)})`);
  check('左側 2.5 m 內可搶', cj.canStart({ x: door.x + 2.5, z: door.z }, [c]) === c);
  check('左側 3.2 m 外不可搶', cj.canStart({ x: door.x + 3.2, z: door.z }, [c]) === null);
  check('右側（副駕側）1 m 不可搶', cj.canStart({ x: -1.5, z: 0.45 }, [c]) === null);
  check('車速 6 m/s 可搶', cj.canStart({ x: 2, z: 0.45 }, [candidate({ speed: 6 })]) !== null);
  check('車速 6.5 m/s 不可搶', cj.canStart({ x: 2, z: 0.45 }, [candidate({ speed: 6.5 })]) === null);
  // 車朝 +X（yaw = π/2）：左方 = (0, −1)，玩家在 z < 0 才是駕駛座側
  const cr = candidate({ x: 10, z: 10, yaw: Math.PI / 2 });
  check('旋轉車身：駕駛座側（−Z）可搶', cj.canStart({ x: 10.4, z: 8 }, [cr]) === cr);
  check('旋轉車身：副駕側（+Z）不可搶', cj.canStart({ x: 10.4, z: 11.5 }, [cr]) === null);
  const near = candidate({ x: 1 });
  check('多台候選取車門最近者', cj.canStart({ x: 3, z: 0.45 }, [c, near]) === near);
  check('機車兩側都可搶', cj.canStart({ x: -1, z: 0.2 }, [candidate({ twoWheeler: true })]) !== null);
}

function makeAdapters({ disabledAt = Infinity, animOk = true } = {}) {
  const calls = [];
  let t = 0;
  const vehicle = { id: 'adopted', spec: SPEC };
  const a = {
    calls,
    vehicle,
    tick(dt) {
      t += dt;
    },
    releaseCar(car) {
      calls.push({ n: 'releaseCar', t, car });
      return { type: 'taxi', color: 0xf5c518, x: 0, y: 0.1, z: 0, yaw: 0, vx: 3, vz: 4, driverVariant: 'male_b' };
    },
    adopt(s) {
      calls.push({ n: 'adopt', t, s });
      return vehicle;
    },
    spawnEjectedDriver(p) {
      calls.push({ n: 'spawnEjectedDriver', t, p });
      return {};
    },
    playPlayerAnim(name) {
      calls.push({ n: 'playPlayerAnim', t, name });
      return animOk;
    },
    facePlayer(yaw) {
      calls.push({ n: 'facePlayer', t, yaw });
    },
    isPlayerDisabled() {
      return t >= disabledAt;
    },
    onEnter(v) {
      calls.push({ n: 'onEnter', t, v });
    },
  };
  return a;
}
const first = (a, n) => a.calls.find((c) => c.n === n);
const countOf = (a, n) => a.calls.filter((c) => c.n === n).length;

// 正常時間線
{
  const bus = makeBus();
  const cj = createCarjack({ bus });
  const a = makeAdapters();
  const c = candidate();
  const ok = cj.begin({ candidate: c, adapters: a });
  check('begin 回傳 true 且 active', ok && cj.active);
  check('t0：carjackStart 事件（payload.car）', bus.count('vehicle:carjackStart') === 1 && bus.log[0].payload.car === c.car);
  check('t0：playPlayerAnim(punch)', first(a, 'playPlayerAnim')?.name === 'punch' && first(a, 'playPlayerAnim').t === 0);
  const face = first(a, 'facePlayer');
  check('t0：玩家面向車門（朝 −X）', face && Math.abs(face.yaw - -Math.PI / 2) < 1e-6, `yaw=${f2(face && face.yaw)}`);
  const ad = first(a, 'adopt');
  check('t0：releaseCar → adopt 且速度歸零', first(a, 'releaseCar')?.t === 0 && ad && ad.t === 0 && ad.s.vx === 0 && ad.s.vz === 0 && ad.s.type === 'taxi' && ad.s.y === 0.1);
  check('begin 進行中再 begin 被拒', cj.begin({ candidate: c, adapters: a }) === false);
  check('進行中 canStart 回 null', cj.canStart({ x: 2, z: 0.45 }, [c]) === null);
  const DT = 1 / 60;
  let st = 'running';
  let steps = 0;
  let doneT = -1;
  while (st === 'running' && steps < 600) {
    a.tick(DT);
    st = cj.update(DT);
    steps++;
    if (st === 'done') doneT = steps * DT;
  }
  const ej = first(a, 'spawnEjectedDriver');
  check('t≈0.6：spawnEjectedDriver', ej && Math.abs(ej.t - 0.6) < DT * 1.5, `t=${f2(ej && ej.t)}`);
  const ejDist = ej ? Math.hypot(ej.p.x - 0.925, ej.p.z - 0.45) : NaN;
  check('司機在車門外 1.2 m、帶 variant', ej && Math.abs(ejDist - 1.2) < 1e-6 && ej.p.x > 2 && ej.p.variant === 'male_b', `x=${f2(ej && ej.p.x)} d=${f2(ejDist)}`);
  const en = first(a, 'onEnter');
  check('t≈1.1：onEnter(adopt 的車)', en && en.v === a.vehicle && Math.abs(en.t - 1.1) < DT * 1.5, `t=${f2(en && en.t)}`);
  check('update 回 done（≈1.1 s）', st === 'done' && Math.abs(doneT - 1.1) < DT * 1.5, `t=${f2(doneT)}`);
  const cjEv = bus.log.find((e) => e.name === 'vehicle:carjacked');
  check('carjacked 事件一次（payload.vehicle）', bus.count('vehicle:carjacked') === 1 && cjEv.payload.vehicle === a.vehicle);
  check('各 adapter 各呼叫一次', ['releaseCar', 'adopt', 'spawnEjectedDriver', 'onEnter', 'playPlayerAnim'].every((n) => countOf(a, n) === 1));
  check('結束後回 idle、非 active', cj.update(DT) === 'idle' && !cj.active);
}

// 取消：0.3 s 玩家被打倒 → cancelled；車留在原地（不 onEnter）、司機仍被放到車門外、無 carjacked
{
  const bus = makeBus();
  const cj = createCarjack({ bus });
  const a = makeAdapters({ disabledAt: 0.3 });
  cj.begin({ candidate: candidate(), adapters: a });
  let st = 'running';
  let t = 0;
  while (st === 'running' && t < 3) {
    a.tick(0.05);
    t += 0.05;
    st = cj.update(0.05);
  }
  check('取消分支回 cancelled', st === 'cancelled', `t=${f2(t)}`);
  check('取消：不 onEnter、無 carjacked 事件', countOf(a, 'onEnter') === 0 && bus.count('vehicle:carjacked') === 0);
  check('取消：adopt 過的車保留（adopt 一次）、司機生成一次', countOf(a, 'adopt') === 1 && countOf(a, 'spawnEjectedDriver') === 1);
  check('取消後 idle', cj.update(0.05) === 'idle' && !cj.active);
}
// 取消：拖出司機後（0.8 s）才倒地 → 司機不重複生成
{
  const cj = createCarjack({ bus: makeBus() });
  const a = makeAdapters({ disabledAt: 0.8 });
  cj.begin({ candidate: candidate(), adapters: a });
  let st = 'running';
  for (let i = 0; i < 100 && st === 'running'; i++) {
    a.tick(0.05);
    st = cj.update(0.05);
  }
  check('0.8 s 取消：司機只生成一次、不 onEnter', st === 'cancelled' && countOf(a, 'spawnEjectedDriver') === 1 && countOf(a, 'onEnter') === 0);
}
// cancel() 外部中止、動作被拒
{
  const bus = makeBus();
  const cj = createCarjack({ bus });
  const a = makeAdapters();
  cj.begin({ candidate: candidate(), adapters: a });
  cj.cancel();
  check('cancel()：下一幀回 cancelled、非 active', !cj.active && cj.update(0.016) === 'cancelled' && cj.update(0.016) === 'idle');
  const b2 = makeBus();
  const cj2 = createCarjack({ bus: b2 });
  const a2 = makeAdapters({ animOk: false });
  check('playPlayerAnim 被拒 → begin false、不 release、無事件', cj2.begin({ candidate: candidate(), adapters: a2 }) === false && countOf(a2, 'releaseCar') === 0 && b2.log.length === 0 && !cj2.active);
}
// 大 dt 一步跨過兩個時刻：仍依序拖出司機再上車
{
  const cj = createCarjack({ bus: makeBus() });
  const a = makeAdapters();
  cj.begin({ candidate: candidate(), adapters: a });
  a.tick(2);
  const st = cj.update(2);
  const iE = a.calls.findIndex((c) => c.n === 'spawnEjectedDriver');
  const iO = a.calls.findIndex((c) => c.n === 'onEnter');
  check('大 dt：司機先生成再 onEnter、回 done', st === 'done' && iE >= 0 && iE < iO);
}

// ======================= 耐久 =======================
function makeVehicle({ x = 0, z = 0, yaw = 0, mass = 1400, twoWheeler = false } = {}) {
  const power = [];
  return {
    pos: new THREE.Vector3(x, 0, z),
    yaw,
    spec: twoWheeler ? { length: 1.9, width: 0.7, height: 1.1, mass: 190, twoWheeler: true } : { length: 4.5, width: 1.85, height: 1.45, mass },
    power,
    setPowerScale(k) {
      power.push(k);
    },
  };
}
function oneHit(relSpeed, opts = {}, kind = 'static') {
  const dmg = createVehicleDamage({ bus: makeBus(), THREE, scene: new THREE.Scene() });
  const v = makeVehicle(opts);
  dmg.attach(v);
  return dmg.onImpact(v, { relSpeed, kind });
}
{
  const d30 = oneHit(kmh(30));
  const d60 = oneHit(kmh(60));
  check('30 km/h 撞牆扣 60–90', d30 >= 60 && d30 <= 90, f2(d30));
  check('60 km/h 撞牆扣 250–350', d60 >= 250 && d60 <= 350, f2(d60));
  check('< 4 m/s 不扣', oneHit(3.9) === 0 && oneHit(4) === 0);
  const dPed = oneHit(kmh(30), {}, 'ped');
  check('撞行人 ×0.2', Math.abs(dPed / d30 - 0.2) < 1e-9, f2(dPed));
  const dBike = oneHit(kmh(30), { twoWheeler: true });
  check('機車 ×0.7', Math.abs(dBike / d30 - 0.7) < 1e-9, f2(dBike));
  const dVeh = oneHit(kmh(30), {}, 'vehicle');
  check('撞車同撞牆係數', Math.abs(dVeh - d30) < 1e-9);
  const dSuv = oneHit(kmh(30), { mass: 1900 });
  check('質量係數：重車扣較多', dSuv > d30, f2(dSuv));
}
// 去重、門檻、事件
{
  const bus = makeBus();
  const scene = new THREE.Scene();
  const dmg = createVehicleDamage({ bus, THREE, scene });
  const v = makeVehicle();
  dmg.attach(v);
  check('attach 後耐久 1000、未 attach 回 null', dmg.healthOf(v) === 1000 && dmg.healthOf({}) === null);
  const a1 = dmg.onImpact(v, { relSpeed: 10, byPlayer: true });
  const a2 = dmg.onImpact(v, { relSpeed: 10, byPlayer: true });
  dmg.update(0.1);
  const a3 = dmg.onImpact(v, { relSpeed: 10, byPlayer: true });
  check('0.3 s 內同速重複撞擊不扣', a1 > 0 && a2 === 0 && a3 === 0, `${f2(a1)} ${f2(a2)} ${f2(a3)}`);
  check('去重：crash 事件只一次', bus.count('vehicle:crash') === 1 && bus.log.find((e) => e.name === 'vehicle:crash').payload.relSpeed === 10);
  dmg.update(0.25);
  const a4 = dmg.onImpact(v, { relSpeed: 10 });
  check('0.3 s 後再撞重新扣', Math.abs(a4 - a1) < 1e-9);
  const dEv = bus.log.filter((e) => e.name === 'vehicle:damaged');
  check('damaged 事件 payload', dEv.length === 2 && Math.abs(dEv[1].payload.health - (1000 - a1 - a4)) < 1e-9 && dEv[1].payload.delta === a4);
  // 撞到 ≤ 600
  let guard = 0;
  while (dmg.healthOf(v) > 600 && guard++ < 50) {
    dmg.update(0.4);
    dmg.onImpact(v, { relSpeed: 12 });
  }
  check('≤ 600 尚未降功率', v.power.length === 0, `hp=${f2(dmg.healthOf(v))}`);
  while (dmg.healthOf(v) > 300 && guard++ < 100) {
    dmg.update(0.4);
    dmg.onImpact(v, { relSpeed: 12 });
  }
  check('≤ 300 setPowerScale(0.6) 一次', v.power.length === 1 && v.power[0] === 0.6, `hp=${f2(dmg.healthOf(v))}`);
  while (dmg.healthOf(v) > 0 && guard++ < 200) {
    dmg.update(0.4);
    dmg.onImpact(v, { relSpeed: 12 });
  }
  dmg.update(0.4);
  dmg.onImpact(v, { relSpeed: 20, byPlayer: true });
  check('歸零 setPowerScale(0) 一次、之後不再呼叫', v.power.length === 2 && v.power[1] === 0, JSON.stringify(v.power));
  check('disabled 事件一次', bus.count('vehicle:disabled') === 1 && bus.log.find((e) => e.name === 'vehicle:disabled').payload.vehicle === v);
  check('熄火後不再發 damaged、耐久不為負', dmg.healthOf(v) === 0 && bus.log.filter((e) => e.name === 'vehicle:damaged').every((e) => e.payload.health >= 0) && bus.log.at(-1).name !== 'vehicle:damaged');
  check('非玩家撞擊不發 crash、撞行人不發 crash', (() => {
    const b = makeBus();
    const d = createVehicleDamage({ bus: b, THREE, scene });
    const w = makeVehicle();
    d.attach(w);
    d.onImpact(w, { relSpeed: 15 });
    d.update(0.5);
    d.onImpact(w, { relSpeed: 15, kind: 'ped', byPlayer: true });
    d.update(0.5);
    d.onImpact(w, { relSpeed: 7.9, byPlayer: true });
    return b.count('vehicle:crash') === 0;
  })());
  // 熄火車冒濃黑煙：在相機旁更新 5 s
  for (let i = 0; i < 300; i++) dmg.update(1 / 60, 0, 0);
  const st = dmg.particleStats;
  check('熄火車有產生煙霧粒子', st.alive > 0 && st.pool > 0, JSON.stringify(st));
  const sp = scene.children.find((c) => c.isSprite && c.visible);
  check('粒子從引擎蓋附近冒出', sp && sp.position.z > 0.8 && sp.position.y > 1.0, sp ? `(${f2(sp.position.x)}, ${f2(sp.position.y)}, ${f2(sp.position.z)})` : '');
  dmg.repair(v);
  check('repair：耐久回滿、setPowerScale(1)', dmg.healthOf(v) === 1000 && v.power.at(-1) === 1);
  dmg.dispose();
  check('dispose 後場景無煙霧 Sprite', scene.children.filter((c) => c.isSprite).length === 0);
}
// 粒子池上限、120 m 外不產生
{
  const scene = new THREE.Scene();
  const dmg = createVehicleDamage({ bus: makeBus(), THREE, scene });
  const cars = [];
  for (let i = 0; i < 40; i++) {
    const v = makeVehicle({ x: i * 2, z: 0 });
    dmg.attach(v, { maxHealth: 100 });
    dmg.onImpact(v, { relSpeed: 30 });
    cars.push(v);
  }
  for (let i = 0; i < 600; i++) dmg.update(1 / 60, 0, 0);
  const st = dmg.particleStats;
  check(`粒子池 ≤ ${MAX_PARTICLES}（40 台熄火車）`, st.pool <= MAX_PARTICLES && st.alive <= MAX_PARTICLES && st.pool === MAX_PARTICLES, JSON.stringify(st));
  check('場景 Sprite 數 ≤ 上限', scene.children.filter((c) => c.isSprite).length <= MAX_PARTICLES);
  dmg.dispose();

  const scene2 = new THREE.Scene();
  const dmg2 = createVehicleDamage({ bus: makeBus(), THREE, scene: scene2 });
  const far = makeVehicle({ x: 121, z: 0 });
  dmg2.attach(far, { maxHealth: 100 });
  dmg2.onImpact(far, { relSpeed: 30 });
  for (let i = 0; i < 300; i++) dmg2.update(1 / 60, 0, 0);
  check('120 m 外不產生粒子', dmg2.particleStats.pool === 0 && dmg2.particleStats.alive === 0);
  far.pos.x = 119;
  for (let i = 0; i < 60; i++) dmg2.update(1 / 60, 0, 0);
  check('進入 120 m 內開始冒煙', dmg2.particleStats.alive > 0);
  const white = makeVehicle({ x: 5 });
  dmg2.attach(white);
  check('健康車（> 600）不冒煙', (() => {
    const d3 = createVehicleDamage({ bus: makeBus(), THREE, scene: new THREE.Scene() });
    const h = makeVehicle();
    d3.attach(h);
    d3.onImpact(h, { relSpeed: 8 });
    for (let i = 0; i < 120; i++) d3.update(1 / 60, 0, 0);
    return d3.healthOf(h) > 600 && d3.particleStats.pool === 0;
  })());
  dmg2.detach(far);
  check('detach 後 healthOf 為 null、onImpact 回 0', dmg2.healthOf(far) === null && dmg2.onImpact(far, { relSpeed: 30 }) === 0);
  dmg2.dispose();
}

const total = passed + failed;
console.log(failed ? `FAIL ${failed}/${total}` : `PASS ${passed}/${total}`);
process.exit(failed ? 1 : 0);
