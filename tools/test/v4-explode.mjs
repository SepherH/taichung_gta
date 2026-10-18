#!/usr/bin/env node
// V4 車輛起火爆炸回歸（src/explosions.js，純邏輯、不需 three / rapier）：
//   損壞門檻 → 冒煙 → 起火 → 爆炸時序與加速、範圍傷害依距離遞減、擊飛、連鎖爆炸、殘骸不可駕駛、槍擊累積損壞（weapons → main.js weapon:impact 接線）、
//   犯行計算（main.js ped:dead / vehicle:explode 片段實際求值 + wanted）、池化上限（爆炸 ≤ 6、閃光 ≤ 2、粒子池、low 減半）、
//   cancel / clear / dispose、幀率無關（30 / 60 / 144 Hz）、每幀成本（3 個同時爆炸 < 1 ms）、假 THREE 走 GPU 緩衝路徑、
//   審查黃燈回歸（殘骸不重燃、犯行時效、倒地者核心必死、殘骸不行駛 / 不可搶、搶車帶狀態、車內被炸同幀下車仍 WASTED）
// 用法：node tools/test/v4-explode.mjs [-v]（最後一行 PASS n/n 或 FAIL k/n；任一失敗 exit 1）
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const X = await import('../../src/explosions.js');
const { createExplosions, SMOKE_AT, FIRE_AT, FUSE_MIN, FUSE_MAX, FUSE_ACCEL, BLAST_RADIUS, BLAST_POWER, CORE_FRAC, MAX_EXPLOSIONS, MAX_LIGHTS, PARTICLE_CAPS, BURST, WRECK_SMOKE_SEC, shakeTrauma, actorBlastDamage, fireStage, charMesh } = X;
const { createVehicleDamage } = await import('../../src/vehicle-damage.js');
const { CombatSystem, KNOCKDOWN_RULES, WEAPON_CAUSE } = await import('../../src/combat.js');
const { createBus } = await import('../../src/core/events.js');
const { createWeapons } = await import('../../src/weapons/weapons.js');
const { WEAPONS } = await import('../../src/weapons/defs.js');
const { createWanted, CRIMES, HEAT } = await import('../../src/wanted/wanted.js');

const VERBOSE = process.argv.includes('-v');
let pass = 0;
let total = 0;
const fails = [];
function ok(cond, msg, detail = '') {
  total++;
  if (cond) pass++;
  else fails.push(msg + (detail ? `  — ${detail}` : ''));
  if (VERBOSE || !cond) console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${detail ? '  — ' + detail : ''}`);
}

// ---------- 假物件 ----------
let clock = 0;
const now = () => clock;

function mockActor(id, x, z, { kind = 'pedestrian', y = 0, hp = 100 } = {}) {
  const handlers = {};
  return {
    id,
    kind,
    pos: { x, y, z },
    yaw: 0,
    hp,
    maxHp: hp,
    faction: kind === 'player' ? 'player' : 'civilian',
    anim: {
      state: 'idle',
      triggers: [],
      trigger(name) {
        this.triggers.push(name);
        return true;
      },
      on(evt, cb) {
        (handlers[evt] ||= []).push(cb);
        return () => {};
      },
    },
    body: {
      impulses: [],
      knockdown(imp) {
        this.impulses.push({ ...imp });
      },
      settleCheck: () => ({ settled: false, clearToStand: false }),
      standUp() {},
    },
  };
}

function mockVehicle(x, z, { type = 'sedan', mass = 1400, twoWheeler = false, withMesh = false } = {}) {
  const v = {
    type,
    pos: { x, y: 0, z },
    yaw: 0,
    spec: { length: 4.5, height: 1.45, mass, twoWheeler },
    power: 1,
    setPowerScale(k) {
      this.power = k;
    },
  };
  if (withMesh) {
    const mat = { color: { hex: 0xff0000, setHex(h) { this.hex = h; } }, emissive: { setHex() {} }, roughness: 0.3, metalness: 0.6, disposed: false, clone() { return { ...this, color: { hex: this.color.hex, setHex(h) { this.hex = h; } }, emissive: { setHex() {} }, dispose() { this.disposed = true; } }; } };
    const child = { isMesh: true, material: mat };
    v.mesh = { parent: {}, children: [child], traverse(fn) { fn(this); fn(child); } };
    v._origMat = mat;
    v._child = child;
  }
  return v;
}

// 一套世界：bus、combat、dmg、explosions（vehicles / actors 由陣列提供）
function world({ quality = 'high', THREE = null, scene = null, rngSeed = null } = {}) {
  clock = 0;
  const bus = createBus();
  const log = [];
  for (const n of ['vehicle:fire', 'vehicle:explode', 'explosion', 'explosion:shake', 'ped:dead', 'vehicle:damaged']) bus.on(n, (e) => log.push({ n, e, t: clock }));
  const combat = new CombatSystem({ now, bus });
  const dmg = createVehicleDamage({ bus });
  const cars = [];
  const actors = [];
  const wrecked = [];
  const impulses = [];
  let r = rngSeed ?? 0.5;
  const ex = createExplosions({
    bus,
    combat,
    THREE,
    scene,
    physics: { radialImpulse: (x, y, z, radius, power) => impulses.push({ x, y, z, radius, power }) },
    config: {
      healthOf: (v) => dmg.healthOf(v),
      maxHealthOf: (v) => dmg.maxHealthOf(v),
      addDamage: (v, n) => dmg.addDamage(v, n),
      vehicles: () => cars,
      onWreck: (v) => wrecked.push(v),
      quality: () => quality,
      rng: rngSeed === null ? undefined : () => r,
    },
  });
  const addCar = (x, z, o) => {
    const v = mockVehicle(x, z, o);
    dmg.attach(v);
    cars.push(v);
    return v;
  };
  const addActor = (id, x, z, o) => {
    const a = mockActor(id, x, z, o);
    combat.register(a);
    actors.push(a);
    return a;
  };
  const of = (n) => log.filter((l) => l.n === n).map((l) => l.e);
  const run = (sec, hz = 60) => {
    const dt = 1 / hz;
    const n = Math.round(sec * hz);
    for (let i = 0; i < n; i++) {
      clock += dt;
      ex.update(dt, dt);
      combat.update(dt);
    }
  };
  return { bus, log, of, combat, dmg, ex, cars, actors, wrecked, impulses, addCar, addActor, run, setR: (v) => (r = v) };
}

// ---------- 0. 純函式 / 常數 ----------
{
  ok(SMOKE_AT === 0.7 && FIRE_AT === 0.85 && FUSE_MIN === 4 && FUSE_MAX === 6, '門檻：70% 冒煙、85% 起火、引信 4–6 s');
  ok(fireStage(0.69) === 0 && fireStage(0.7) === 1 && fireStage(0.849) === 1 && fireStage(0.85) === 2, 'fireStage 邊界');
  const d = [0.5, 2, 4, 6, 8, 9.5].map((x) => actorBlastDamage(x, BLAST_RADIUS, BLAST_POWER, 100));
  ok(d[0] >= 200 && d[1] >= 200 && d[2] > d[3] && d[3] > d[4] && d[5] === 0, '角色傷害：核心必死、之後依距離遞減、半徑外 0', d.map((v) => v.toFixed(0)).join(','));
  ok(shakeTrauma(0) === 1 && shakeTrauma(20) > shakeTrauma(30) && shakeTrauma(BLAST_RADIUS * 5 + 1) === 0, '鏡頭震動：距離衰減、範圍外 0');
  ok(KNOCKDOWN_RULES.explosion.hits === 1 && WEAPON_CAUSE.explosion === 'explosion', 'combat：weapon explosion 一下即倒、cause explosion');
  ok(WEAPONS.pistol.vehicleDamage === 34, '手槍打車 34 / 發');
}

// ---------- 1. 門檻 → 冒煙 → 起火 → 爆炸時序 ----------
{
  const W = world({ rngSeed: 0.5 }); // 引信 = 4 + 0.5 × 2 = 5 s
  const car = W.addCar(0, 0);
  W.dmg.addDamage(car, 690);
  ok(W.ex.stateOf(car) === 'ok', '損壞 69% → ok');
  W.dmg.addDamage(car, 10);
  ok(W.ex.stateOf(car) === 'smoke', '損壞 70% → smoke');
  W.dmg.addDamage(car, 150);
  ok(W.ex.stateOf(car) === 'fire' && W.of('vehicle:fire').length === 1, '損壞 85% → fire、發 vehicle:fire');
  ok(Math.abs(W.ex.fuseOf(car) - 5) < 1e-9 && Math.abs(W.of('vehicle:fire')[0].fuse - 5) < 1e-9, '剛好到門檻：引信 = 4–6 s 抽樣（5 s）', String(W.ex.fuseOf(car)));
  ok(W.of('vehicle:fire')[0].y > 1, '火在引擎蓋高度');
  W.run(4.9);
  ok(W.ex.stateOf(car) === 'fire' && W.of('vehicle:explode').length === 0, '4.9 s 仍在燒、未爆');
  ok(W.ex.stats().particles.fire > 0 && W.ex.stats().particles.smoke > 0, '燃燒中有火焰與黑煙粒子');
  W.run(0.2);
  const ev = W.of('vehicle:explode');
  ok(ev.length === 1 && W.ex.stateOf(car) === 'wreck', '5 s 時爆炸 → wreck');
  const t = W.log.find((l) => l.n === 'vehicle:explode').t;
  ok(Math.abs(t - 5) <= 1 / 60 + 1e-9, '爆炸時刻 = 引信', t.toFixed(4));
  ok(car.burnt === true && W.dmg.healthOf(car) === 0 && car.power === 0, '殘骸：burnt、耐久 0、熄火（功率 0）');
  ok(W.wrecked[0] === car && W.impulses.length === 1, 'onWreck 回呼、物理衝量一次');
  ok(W.of('explosion:shake').length === 1 && W.of('explosion').length === 1 && W.of('explosion')[0].vehicle === car, 'explosion / explosion:shake 事件');
  // 殘骸：再受損不再起火 / 爆炸
  W.ex.damageVehicle(car, 500);
  W.run(8);
  ok(W.of('vehicle:explode').length === 1 && W.ex.isWreck(car), '殘骸再受損不會再爆');
  // 殘骸冒煙 WRECK_SMOKE_SEC 後停
  W.run(WRECK_SMOKE_SEC);
  W.run(4);
  ok(W.ex.stats().particles.fire === 0 && W.ex.stats().particles.smoke === 0, `殘骸冒煙 ${WRECK_SMOKE_SEC} s 後停、粒子回收`);
}

// ---------- 2. 加速：起火中再受損縮短引信；耐久歸零後仍會加速；點燃那一擊超出門檻也算 ----------
{
  const W = world({ rngSeed: 0.5 });
  const a = W.addCar(0, 0);
  W.dmg.addDamage(a, 850);
  const f0 = W.ex.fuseOf(a);
  W.ex.damageVehicle(a, 50);
  ok(Math.abs(f0 - W.ex.fuseOf(a) - 50 * FUSE_ACCEL) < 1e-9, '起火中受 50 → 引信 −1 s');
  W.ex.damageVehicle(a, 200); // 耐久只剩 100：實扣 100，但要求 200 全部加速
  ok(W.dmg.healthOf(a) === 0 && Math.abs(f0 - W.ex.fuseOf(a) - 250 * FUSE_ACCEL) < 1e-9, '耐久歸零後再受損仍加速（依要求量）');
  W.ex.damageVehicle(a, 10000);
  W.run(1 / 60);
  ok(W.of('vehicle:explode').length === 1, '大量傷害 → 引信歸零、下一幀爆');
  // 一擊從滿血打到 95%：超出門檻 100 點 → 引信 5 − 2 = 3 s
  const b = W.addCar(100, 0);
  W.ex.damageVehicle(b, 950);
  ok(Math.abs(W.ex.fuseOf(b) - (5 - 100 * FUSE_ACCEL)) < 1e-9, '點燃那一擊超出門檻的部分也縮短引信', String(W.ex.fuseOf(b)));
  // 透過 bus 的 vehicle:damaged（例：撞擊 onImpact）也會加速
  const c = W.addCar(200, 0);
  W.dmg.addDamage(c, 860);
  const fc = W.ex.fuseOf(c);
  W.dmg.addDamage(c, 40);
  ok(Math.abs(fc - W.ex.fuseOf(c) - 40 * FUSE_ACCEL) < 1e-9, 'vehicle:damaged（非 damageVehicle）同樣加速');
}

// ---------- 3. 範圍傷害依距離遞減、擊飛、核心必死、車內減傷、犯行歸屬 ----------
{
  const W = world({ rngSeed: 0.5 });
  const player = W.addActor('player', 0.5, 0, { kind: 'player' });
  const near = W.addActor('p2', 3.5, 0);
  const mid = W.addActor('p4', 5, 0);
  const far = W.addActor('p7', 7, 0);
  const out = W.addActor('p10', 10, 0);
  const res = W.ex.explode(0, 0.7, 0, { source: player });
  ok(player.hp === 0, '玩家在核心即死', String(player.hp));
  ok(near.hp < mid.hp && mid.hp < far.hp && out.hp === 100, '行人傷害依距離遞減、半徑外無傷', [near.hp, mid.hp, far.hp, out.hp].map((v) => v.toFixed(1)).join(','));
  ok([near, mid, far].every((a) => W.combat.stateOf(a) === 'knockdown') && W.combat.stateOf(out) === 'normal', '半徑內一律倒地（combat 既有流程）');
  const imp = (a) => a.body.impulses[0];
  ok(imp(near).x > 0 && imp(near).y > 0 && Math.abs(imp(near).z) < 1e-6, '擊飛方向背離爆心、往上抬');
  ok(Math.hypot(imp(near).x, imp(near).z) > Math.hypot(imp(far).x, imp(far).z), '擊飛衝量依距離遞減');
  ok(res.actors === 4, '本次命中 4 名角色', String(res.actors));
  // 行人死亡事件：cause explosion、byPlayer
  W.ex.explode(3.5, 0.7, 0, { source: player }); // 已倒地者 combat 不受理
  const p2 = W.addActor('pp', 20, 0);
  W.ex.explode(20.5, 0.7, 0, { source: player });
  const dead = W.of('ped:dead').find((e) => e.ped === p2);
  ok(dead && dead.cause === 'explosion' && dead.byPlayer === true && dead.attacker === player, 'ped:dead { cause explosion, byPlayer, attacker = 玩家 }');
  // 車內（untargetable）：throughVehicle 只扣血、非核心 × 0.5
  const W2 = world();
  const inCar = W2.addActor('player', 5, 0, { kind: 'player' });
  inCar.untargetable = true;
  const ref = W2.addActor('ref', -5, 0);
  W2.ex.explode(0, 1, 0, {});
  ok(inCar.hp > ref.hp && Math.abs(100 - inCar.hp - (100 - ref.hp) * 0.5) < 1e-6 && W2.combat.stateOf(inCar) === 'normal', '玩家在車內：減半、不倒地（之後走 gangCarKo 下車流程）');
  inCar.hp = 100;
  W2.combat.revive?.(inCar);
  W2.ex.explode(5, 1, 0, {});
  ok(inCar.hp === 0, '自己的車在身邊爆炸（核心）→ 車內也即死');
}

// ---------- 4. 連鎖爆炸 ----------
{
  const W = world({ rngSeed: 0.5 });
  const a = W.addCar(0, 0);
  const b = W.addCar(3, 0);
  const c = W.addCar(6.5, 0);
  const far = W.addCar(40, 0);
  W.dmg.addDamage(a, 850);
  W.run(5.05);
  ok(W.ex.stateOf(a) === 'wreck' && W.ex.stateOf(b) === 'fire', '第一台爆炸 → 3 m 外的車起火');
  ok(W.dmg.healthOf(far) === 1000 && W.ex.stateOf(far) === 'ok', '40 m 外的車不受影響');
  ok(W.ex.fuseOf(b) < FUSE_MIN, '被炸點燃的引信較短（超出門檻部分加速）', W.ex.fuseOf(b).toFixed(2));
  W.run(6);
  ok(W.ex.stateOf(b) === 'wreck', '第二台接著爆炸（連鎖）');
  W.run(6);
  ok(W.of('vehicle:explode').length >= 2 && W.of('vehicle:explode').every((e) => e.vehicle !== far), '連鎖只波及範圍內車輛', String(W.of('vehicle:explode').length));
  ok(W.ex.stats().explosions <= MAX_EXPLOSIONS, '連鎖中爆炸紀錄不超過上限');
  // 爆炸來源沿連鎖傳遞（犯行歸屬）
  const W3 = world({ rngSeed: 0.5 });
  const pl = W3.addActor('player', 100, 100, { kind: 'player' });
  const x1 = W3.addCar(0, 0);
  const x2 = W3.addCar(2.5, 0);
  W3.ex.damageVehicle(x1, 900, { source: pl });
  W3.run(12);
  const evs = W3.of('vehicle:explode');
  ok(evs.length === 2 && evs.every((e) => e.byPlayer && e.source === pl), '連鎖爆炸的來源 = 最初的玩家（byPlayer）');
  void c;
}

// ---------- 5. 殘骸不可駕駛（VehicleManager.findNearby / findOverturned 跳過 burnt；traffic 不交還車道）----------
{
  const vsrc = read('src/vehicle.js');
  const fn = vsrc.slice(vsrc.indexOf('  findNearby(pos'), vsrc.indexOf('  findOverturned(pos'));
  const fo = vsrc.slice(vsrc.indexOf('  findOverturned(pos'));
  ok(/continue/.test(fn) && /v\.burnt\)\s*continue/.test(fn), 'findNearby 跳過 burnt（不能上車）');
  ok(/v\.burnt\)\s*continue/.test(fo), 'findOverturned 跳過 burnt（不能扶起）');
  const tsrc = read('src/traffic.js');
  ok(/!car\.v\.burnt && b\.canRecover && b\.recover\(\)/.test(tsrc) && /isWrecked && !car\.v\.burnt\) continue/.test(tsrc), 'traffic：燒焦殘骸不交還車道、遠了照回收');
  // 燒焦材質：複製後變黑，不動原材質
  const W = world({ rngSeed: 0.5 });
  const car = W.addCar(0, 0, { withMesh: true });
  W.dmg.addDamage(car, 900);
  W.run(6);
  ok(car._child.material !== car._origMat && car._child.material.color.hex === 0x141210 && car._origMat.color.hex === 0xff0000, '燒焦：材質複製後變黑、共用材質不變');
  car.mesh.parent = null; // 回收
  W.run(2.1);
  ok(car._child.material.disposed === true && W.ex.stateOf(car) === 'wreck', '回收後燒焦材質 dispose、狀態丟棄（stateOf 仍依 burnt 回 wreck）');
  const mats = charMesh({ traverse() {} });
  ok(Array.isArray(mats) && mats.length === 0, 'charMesh 對空網格安全');
}

// ---------- 6. 槍擊車輛：weapons → weapon:impact（vehicle）→ main.js 接線 → damageVehicle；約 25–35 發引爆 ----------
const mainSrc = read('src/main.js');
const sliceHandler = (evt, must) => {
  const re = new RegExp(`\\n  bus\\.on\\('${evt}', \\(e\\) => \\{[\\s\\S]*?\\n  \\}\\);\\n`, 'g');
  return (mainSrc.match(re) || []).find((m) => m.includes(must)) || null;
};
{
  const impactSrc = sliceHandler('weapon:impact', 'explosions.damageVehicle');
  ok(!!impactSrc, 'main.js：找得到 weapon:impact → explosions.damageVehicle 接線');
  const W = world({ rngSeed: 0.5 });
  const pa = W.addActor('player', 0, 0, { kind: 'player' });
  const car = W.addCar(0, 10);
  if (impactSrc) new Function('bus', 'explosions', 'player', impactSrc)(W.bus, W.ex, { actor: pa });
  const hitObj = { point: { x: 0, y: 1, z: 8 }, normal: { x: 0, y: 0, z: -1 }, actor: null, surface: 'vehicle', vehicle: car };
  const raycast = () => hitObj;
  const w = createWeapons({ bus: W.bus, combat: W.combat, player: { actor: pa }, raycast, sweep: () => [], settings: { get: () => undefined }, now });
  const aim = { origin: { x: 0, y: 1.6, z: -1 }, dir: { x: 0, y: 0, z: 1 }, aiming: true, muzzle: { x: 0.2, y: 1.35, z: 0.45 } };
  w.select(2);
  let shots = 0;
  let fireAt = null;
  const dt = 1 / 60;
  for (let i = 0; i < 60 * 30 && !W.of('vehicle:explode').length; i++) {
    clock += dt;
    w.update(dt, aim);
    if (w.attack(aim)) {
      shots++;
      if (fireAt === null && W.ex.stateOf(car) === 'fire') fireAt = shots;
    }
    W.ex.update(dt, dt);
    W.combat.update(dt);
  }
  const imp = W.log.filter((l) => l.n === 'vehicle:damaged');
  ok(imp.length > 0 && imp[0].e.delta === 34, '每發打到車扣 34 耐久');
  ok(fireAt === 25, '第 25 發起火', String(fireAt));
  ok(W.of('vehicle:explode').length === 1 && shots >= 25 && shots <= 35, `持續射擊 ${shots} 發引爆（25–35）`);
  ok(W.of('vehicle:explode')[0] && W.of('vehicle:explode')[0].byPlayer === true, '玩家槍擊引爆 → byPlayer');
  // 打到牆（surface world、無 vehicle）不扣車
  const W2 = world();
  const pa2 = W2.addActor('player', 0, 0, { kind: 'player' });
  const car2 = W2.addCar(0, 10);
  if (impactSrc) new Function('bus', 'explosions', 'player', impactSrc)(W2.bus, W2.ex, { actor: pa2 });
  const wall = { point: { x: 0, y: 1, z: 8 }, normal: { x: 0, y: 0, z: -1 }, actor: null, surface: 'world' };
  const w2 = createWeapons({ bus: W2.bus, combat: W2.combat, player: { actor: pa2 }, raycast: () => wall, sweep: () => [], settings: { get: () => undefined }, now });
  w2.select(2);
  for (let i = 0; i < 60; i++) {
    clock += dt;
    w2.update(dt, aim);
    w2.attack(aim);
  }
  ok(W2.dmg.healthOf(car2) === 1000, '打到牆不扣車');
  const rayLine = /rayHit\.vehicle = rayHit\.surface === 'vehicle' \? vehicleOfEntity\(ent\) : null;/.test(mainSrc);
  ok(rayLine, 'main.js raycast 以 collider 找到 Vehicle（rayHit.vehicle）');
}

// ---------- 7. 犯行計算（main.js 片段求值 + wanted）----------
{
  const deadSrc = sliceHandler('ped:dead', 'CRIMES.killPolice');
  const explodeSrc = sliceHandler('vehicle:explode', 'CRIMES.policeVehicle');
  ok(!!deadSrc && !!explodeSrc, 'main.js：找得到 ped:dead / vehicle:explode 犯行接線');
  const W = world({ rngSeed: 0.5 });
  const wanted = createWanted({ bus: W.bus });
  const reports = [];
  const reportCrime = (crime, x, z) => {
    reports.push(crime);
    wanted.report(crime, { x, z, witnessed: true });
    return true;
  };
  const officer = (a) => !!a && a.faction === 'police';
  const police = mockVehicle(30, 0, { type: 'police' });
  const deps = { bus: W.bus, isOfficer: officer, CRIMES, reportCrime, vigHooks: { fugitiveActor: () => false, fugitiveShot: () => false }, isPoliceCar: (v) => v && v.type === 'police', stolenPolice: new WeakSet() };
  const names = Object.keys(deps);
  if (deadSrc) new Function(...names, deadSrc)(...names.map((n) => deps[n]));
  if (explodeSrc) new Function(...names, explodeSrc)(...names.map((n) => deps[n]));
  const pl = W.addActor('player', 100, 100, { kind: 'player' });
  const ped = W.addActor('ped', 1, 0);
  const cop = W.addActor('cop', -1, 0);
  cop.faction = 'police';
  W.ex.explode(0, 0.7, 0, { source: pl });
  ok(reports.filter((r) => r === CRIMES.kill).length === 1 && reports.filter((r) => r === CRIMES.killPolice).length === 1, '玩家爆炸致死：行人 → kill、警員 → killPolice', reports.join(','));
  const heat1 = wanted.heat ?? null;
  // 炸警車
  W.cars.push(police);
  W.dmg.attach(police);
  W.ex.damageVehicle(police, 900, { source: pl });
  W.run(7);
  ok(reports.includes(CRIMES.policeVehicle), '玩家炸警車 → policeVehicle');
  ok(wanted.stars >= 2, `通緝星數上升（${wanted.stars} 星）`);
  // 非玩家造成的爆炸不算犯行
  const before = reports.length;
  const p3 = W.addActor('p3', 200, 0);
  W.ex.explode(200, 0.7, 0, { source: null });
  ok(reports.length === before && p3.hp === 0, '非玩家爆炸：有傷亡但不算犯行');
  ok(Object.keys(HEAT).length === 10, '沿用既有犯行種類（HEAT 未新增）');
  void heat1;
}

// ---------- 8. 池化上限、low 減半、閃光 ≤ 2 ----------
{
  const W = world();
  for (let i = 0; i < 10; i++) W.ex.explode(i * 30, 1, 0, {});
  const s = W.ex.stats();
  ok(s.explosions === MAX_EXPLOSIONS, `同時爆炸紀錄上限 ${MAX_EXPLOSIONS}`, String(s.explosions));
  ok(s.lights === MAX_LIGHTS && s.maxLights === 2, '閃光光源 ≤ 2 盞');
  ok(s.particles.fire <= s.caps.fire && s.particles.smoke <= s.caps.smoke && s.caps.fire === PARTICLE_CAPS.fire, '粒子不超過池大小', JSON.stringify(s.particles));
  W.run(0.5);
  W.run(1);
  ok(W.ex.stats().explosions === 0 && W.ex.stats().lights === 0, '爆炸紀錄 / 閃光到期回收');
  const one = (q) => {
    const Wq = world({ quality: q });
    Wq.ex.explode(0, 1, 0, {});
    return Wq.ex.stats();
  };
  const hi = one('high');
  const lo = one('low');
  ok(lo.caps.fire === PARTICLE_CAPS.fire / 2 && lo.caps.smoke === PARTICLE_CAPS.smoke / 2, 'quality low：粒子池減半');
  ok(lo.particles.fire + lo.particles.smoke === Math.round((hi.particles.fire + hi.particles.smoke) / 2), 'quality low：每次爆炸粒子數減半', `${hi.particles.fire + hi.particles.smoke} → ${lo.particles.fire + lo.particles.smoke}`);
  ok(hi.particles.fire + hi.particles.smoke === BURST.fireball + BURST.sparks + BURST.smoke + BURST.debris, '一次爆炸粒子數 = BURST 合計');
}

// ---------- 9. cancel / clear / dispose ----------
{
  const W = world({ rngSeed: 0.5 });
  const a = W.addCar(0, 0);
  W.dmg.addDamage(a, 870);
  ok(W.ex.cancel(a) === true && W.ex.stateOf(a) === 'smoke' && W.ex.fuseOf(a) === null, 'cancel：熄火、不再倒數');
  W.run(8);
  ok(W.of('vehicle:explode').length === 0, 'cancel 後不爆炸');
  ok(W.ex.cancel(a) === false, '沒在燒的 cancel 回 false');
  // 修好（repair）自動熄火
  const b = W.addCar(50, 0);
  W.dmg.addDamage(b, 900);
  W.dmg.repair(b);
  W.run(7);
  ok(W.ex.stateOf(b) === 'ok' && W.of('vehicle:explode').length === 0, '修好（耐久回門檻下）→ 自動熄火');
  // clear
  const c = W.addCar(100, 0);
  W.dmg.addDamage(c, 900);
  W.ex.explode(0, 1, 0, {});
  W.run(0.1);
  W.ex.clear();
  const s = W.ex.stats();
  ok(s.burning === 0 && s.explosions === 0 && s.lights === 0 && s.particles.fire === 0 && s.particles.smoke === 0, 'clear：火、爆炸、閃光、粒子全清', JSON.stringify(s));
  W.run(8);
  ok(W.of('vehicle:explode').length === 0, 'clear 後原本起火的車不會爆');
  // dispose：取消訂閱、之後 no-op
  const d = W.addCar(150, 0);
  W.ex.dispose();
  const fires = W.of('vehicle:fire').length;
  W.dmg.addDamage(d, 900);
  W.run(7);
  ok(W.ex.stateOf(d) !== 'fire' && W.of('vehicle:fire').length === fires, 'dispose 後不再起火（取消 vehicle:damaged 訂閱）');
  const r = W.ex.explode(0, 0, 0, {});
  ok(r.actors === 0 && W.of('explosion').length === 1, 'dispose 後 explode 為 no-op');
}

// ---------- 10. 幀率無關（30 / 60 / 144 Hz）----------
{
  const runAt = (hz) => {
    const W = world({ rngSeed: 0.3 });
    const a = W.addCar(0, 0);
    const b = W.addCar(3, 0);
    W.dmg.addDamage(a, 860);
    W.run(20, hz);
    const t = W.log.filter((l) => l.n === 'vehicle:explode').map((l) => l.t);
    void b;
    return t;
  };
  const t30 = runAt(30);
  const t60 = runAt(60);
  const t144 = runAt(144);
  ok(t30.length === 2 && t60.length === 2 && t144.length === 2, '三種幀率都連鎖爆兩台');
  // 每一段引信各自量化到幀：第 n 台（連鎖）容差 n 幀
  const close = (x, y, frame) => x.every((v, i) => Math.abs(v - y[i]) <= (i + 1) * frame + 1e-6);
  ok(close(t30, t144, 1 / 30) && close(t60, t144, 1 / 60), '爆炸時刻與幀率無關（每段 ≤ 1 幀）', `${t30.map((v) => v.toFixed(3))} / ${t60.map((v) => v.toFixed(3))} / ${t144.map((v) => v.toFixed(3))}`);
  // simDt = 0（暫停）→ 引信不走
  const W = world({ rngSeed: 0.5 });
  const a = W.addCar(0, 0);
  W.dmg.addDamage(a, 900);
  const f = W.ex.fuseOf(a);
  for (let i = 0; i < 600; i++) W.ex.update(1 / 60, 0);
  ok(W.ex.fuseOf(a) === f, 'simDt = 0（暫停）時引信不前進');
}

// ---------- 11. 每幀成本：3 個同時爆炸 + 4 台燃燒車 < 1 ms；穩態不長池 ----------
{
  const W = world();
  for (let i = 0; i < 4; i++) {
    const v = W.addCar(i * 20, 50);
    W.dmg.addDamage(v, 900);
  }
  for (let i = 0; i < 30; i++) W.addActor(`a${i}`, (i % 6) * 3, Math.floor(i / 6) * 3);
  const dt = 1 / 60;
  // 暖身
  for (let i = 0; i < 120; i++) W.ex.update(dt, 0);
  let tUpd = 0;
  let frames = 0;
  let tBoom = 0;
  for (let k = 0; k < 20; k++) {
    const t0 = performance.now();
    W.ex.explode(0, 1, 0, {});
    W.ex.explode(30, 1, 0, {});
    W.ex.explode(60, 1, 0, {});
    tBoom += performance.now() - t0;
    for (let i = 0; i < 60; i++) {
      const t1 = performance.now();
      W.ex.update(dt, 0, 0, 0);
      tUpd += performance.now() - t1;
      frames++;
    }
  }
  const avg = tUpd / frames;
  ok(avg < 1, `每幀 update 平均 ${avg.toFixed(4)} ms < 1 ms（3 爆炸 + 4 燃燒車）`);
  ok(tBoom / 60 < 1, `單次 explode（含 30 角色範圍判定）平均 ${(tBoom / 60).toFixed(4)} ms`);
  const s = W.ex.stats();
  ok(s.particles.fire <= s.caps.fire && s.particles.smoke <= s.caps.smoke, '長時間運作粒子不超過池');
  // 每幀路徑不配置：大量 update 後 heap 不明顯成長（粗略；有 --expose-gc 時才量）
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < 20000; i++) W.ex.update(dt, 0);
    globalThis.gc();
    const h1 = process.memoryUsage().heapUsed;
    ok(h1 - h0 < 512 * 1024, `穩態 20000 幀 heap 成長 ${((h1 - h0) / 1024).toFixed(0)} KB`);
  }
}

// ---------- 12. 假 THREE：GPU 緩衝 / 光源 / dispose 路徑 ----------
{
  const added = [];
  const removed = [];
  const scene = { add: (o) => added.push(o), remove: (o) => removed.push(o) };
  class BufferAttribute {
    constructor(array, size) {
      this.array = array;
      this.itemSize = size;
      this.needsUpdate = false;
    }
  }
  class BufferGeometry {
    constructor() {
      this.attributes = {};
      this.drawRange = { start: 0, count: Infinity };
      this.disposed = false;
    }
    setAttribute(n, a) {
      this.attributes[n] = a;
    }
    setDrawRange(s, c) {
      this.drawRange.start = s;
      this.drawRange.count = c;
    }
    dispose() {
      this.disposed = true;
    }
  }
  class ShaderMaterial {
    constructor(o) {
      Object.assign(this, o);
    }
    dispose() {
      this.disposed = true;
    }
  }
  class Points {
    constructor(g, m) {
      this.geometry = g;
      this.material = m;
    }
  }
  class PointLight {
    constructor(color, intensity, distance) {
      this.intensity = intensity;
      this.distance = distance;
      this.position = { set(x, y, z) { this.x = x; this.y = y; this.z = z; } };
    }
  }
  const THREE = { BufferAttribute, BufferGeometry, ShaderMaterial, Points, PointLight, AdditiveBlending: 2, NormalBlending: 1 };
  const W = world({ THREE, scene });
  const pts = added.filter((o) => o instanceof Points);
  const lts = added.filter((o) => o instanceof PointLight);
  ok(pts.length === 2 && lts.length === MAX_LIGHTS, '建立 2 個 Points 圖層 + 2 盞常駐光源');
  ok(pts.some((p) => p.material.blending === 2) && pts.every((p) => p.frustumCulled === false), '火焰層加色、不做視錐剔除');
  W.ex.explode(1, 2, 3, {});
  W.ex.update(1 / 60, 1 / 60);
  const fireLayer = pts.find((p) => p.material.blending === 2);
  const n = fireLayer.geometry.drawRange.count;
  ok(n === W.ex.stats().particles.fire && n > 0 && fireLayer.geometry.attributes.position.needsUpdate, 'drawRange = 存活粒子數、緩衝標記更新');
  const sz = fireLayer.geometry.attributes.aSize.array;
  const col = fireLayer.geometry.attributes.aColor.array;
  let finite = true;
  for (let i = 0; i < n; i++) if (!(sz[i] > 0) || !(col[i * 4 + 3] >= 0)) finite = false;
  ok(finite, '存活粒子大小 > 0、透明度 ≥ 0');
  ok(lts.some((l) => l.intensity > 0 && l.position.x === 1), '閃光亮起於爆心');
  W.run(1);
  ok(lts.every((l) => l.intensity === 0), '閃光衰減到 0');
  W.ex.dispose();
  ok(removed.length === 4 && pts.every((p) => p.geometry.disposed && p.material.disposed), 'dispose 移除圖層與光源、釋放 geometry / material');
}

// ---------- 13. 審查黃燈回歸（v4-rf-fix）----------
const tsrc13 = read('src/traffic.js');
const sliceBetween = (src, start, end) => {
  const i = src.indexOf(start);
  if (i < 0) return null;
  const j = src.indexOf(end, i + start.length);
  return j < 0 ? null : src.slice(i, j);
};
const sliceMethod = (src, head) => {
  const i = src.indexOf('\n  ' + head);
  if (i < 0) return null;
  const j = src.indexOf('\n  }\n', i);
  return j < 0 ? null : src.slice(i, j + 4);
};
const tryEval = (fn) => {
  try {
    return fn();
  } catch (err) {
    return null;
  }
};
// 13.1 clear / forget 後的燒焦殘骸再受損不重新起火（以 v.burnt 判定）
{
  const W = world({ rngSeed: 0.5 });
  const car = W.addCar(0, 0);
  const other = W.addCar(60, 0);
  W.dmg.addDamage(car, 900);
  W.run(10);
  W.ex.clear();
  W.ex.damageVehicle(car, 34);
  ok(W.ex.stateOf(car) === 'wreck', 'clear 後殘骸再受損：stateOf 仍是 wreck', W.ex.stateOf(car));
  W.run(10);
  ok(W.of('vehicle:explode').length === 1, 'clear 後殘骸再受損不會再爆', String(W.of('vehicle:explode').length));
  W.ex.forget(car);
  W.ex.explode(0, 0.7, 0, {}); // 殘骸在核心：不算波及車輛
  W.dmg.addDamage(car, 50);
  W.run(10);
  ok(W.of('vehicle:explode').length === 1 && W.of('vehicle:fire').length === 1, 'forget 後殘骸被炸 / 受損不重新起火');
  W.ex.setSource(car, W.addActor('player', 200, 200, { kind: 'player' }));
  ok(W.ex.stateOf(car) === 'wreck', 'setSource 不會替殘骸建出 ok 狀態');
  void other;
}
// 13.2 犯行歸屬：來源有時效；main.js 只在玩家駕駛的碰撞實扣時設定
{
  const W = world({ rngSeed: 0.5 });
  const pl = W.addActor('player', 100, 100, { kind: 'player' });
  const car = W.addCar(0, 0);
  W.ex.damageVehicle(car, 34, { source: pl });
  W.run(100);
  W.dmg.addDamage(car, 900); // 100 s 後非玩家來源造成起火
  W.run(10);
  const ev = W.of('vehicle:explode')[0];
  ok(ev && ev.byPlayer === false && ev.source === null, '玩家很久以前打過一槍、之後別人弄爆 → 不算玩家', ev ? String(ev.byPlayer) : 'no explode');
  const car2 = W.addCar(50, 0);
  W.ex.damageVehicle(car2, 900, { source: pl });
  W.run(10);
  ok(W.of('vehicle:explode')[1] && W.of('vehicle:explode')[1].byPlayer === true, '玩家點燃 → 引信到點爆炸仍算玩家');
  ok(sliceHandler('vehicle:damaged', 'setSource') === null, 'main.js：不再以「玩家正在駕駛」把任何 vehicle:damaged 歸給玩家');
  const impactSrc = sliceBetween(mainSrc, '  const impact = (entity, relSpeed, kind) => {', '\n  };\n');
  const calls = [];
  const mk = (d) => ({ onImpact: () => d });
  const run13 = (mine, d) => {
    calls.length = 0;
    const f = tryEval(() => new Function('byPlayer', 'reportImpact', 'dmg', 'blastSource', 'explosions', 'player', impactSrc + '\n  };\n  return impact;')(() => mine, () => {}, mk(d), (v, a) => calls.push(a), { setSource: (v, a) => calls.push(a) }, { actor: pl }));
    if (f) f({ owner: {} }, 10, 'static');
    return calls.length;
  };
  ok(!!impactSrc && run13(true, 40) === 1 && run13(true, 0) === 0 && run13(false, 40) === 0, 'main.js impact：只有玩家駕駛的碰撞實扣 > 0 才 setSource(玩家)');
}
// 13.3 核心必死：倒地 / 起身中的角色也生效
{
  clock = 0;
  const bus = createBus();
  const dead = [];
  const kos = [];
  bus.on('ped:dead', (e) => dead.push(e));
  const c = new CombatSystem({ now, bus });
  c.on('knockdown', (e) => kos.push(e));
  const ped = mockActor('p', 7, 0);
  c.register(ped);
  const ex = createExplosions({ combat: c });
  ex.explode(0, 0.7, 0, {});
  ok(c.stateOf(ped) === 'knockdown' && ped.hp > 0, '第一爆炸把人炸倒（未死）');
  clock += 0.35;
  const r = ex.explode(7, 0.7, 0, {});
  ok(ped.hp === 0 && r.actors === 1 && r.killed === 1, '倒地中在第二爆炸核心內 → 必死', `${ped.hp.toFixed(1)} / actors ${r.actors}`);
  ok(dead.length === 1 && dead[0].cause === 'explosion', '倒地中被炸死發 ped:dead（cause explosion）');
  // 起身中
  const g = mockActor('g', 30, 0);
  g.body.settleCheck = () => ({ settled: true, clearToStand: true });
  c.register(g);
  c.knockdownActor(g, {});
  clock += 2;
  c.update(0);
  ok(c.stateOf(g) === 'getup', '前置：角色起身中');
  ex.explode(30, 0.7, 0, {});
  ok(g.hp === 0 && c.stateOf(g) === 'knockdown', '起身中在核心內 → 必死並倒回地上', `${g.hp} ${c.stateOf(g)}`);
  // 玩家倒地中被炸死：重發 knockdown（main.js 接 player:ko → WASTED）
  const p = mockActor('player', 60, 0, { kind: 'player' });
  c.register(p);
  c.knockdownActor(p, { cause: 'fall' });
  kos.length = 0;
  ex.explode(60, 0.7, 0, {});
  ok(p.hp === 0 && kos.some((e) => e.target === p && e.cause === 'explosion'), '玩家倒地中被核心炸死 → 發 knockdown（接 WASTED）');
  // 核心外的倒地者不另外受傷（行為不變）
  const q = mockActor('q', 90, 0);
  c.register(q);
  c.knockdownActor(q, {});
  ex.explode(96, 0.7, 0, {});
  ok(q.hp === 100, '倒地者在核心外：照舊不受理');
}
// 13.4 燒焦殘骸（v.burnt）不再行駛、不可被搶；停用中爆炸也轉殘骸
{
  const stepSrc = sliceMethod(tsrc13, '_step(dt) {');
  const candSrc = sliceMethod(tsrc13, 'carjackCandidates(x, z, maxDist) {');
  const T = tryEval(() => new Function('CARJACK_MAX_SPEED', 'stepPeds', `return {${stepSrc},${candSrc}};`)(6, () => {}));
  const driven = [];
  const mkCar = (burnt) => ({ v: { burnt, pos: { x: 1, y: 0, z: 0 }, yaw: 0 }, speed: 0, type: 'sedan', body: { isWrecked: false, setTargetPose() {} } });
  const burntCar = mkCar(true);
  const okCar = mkCar(false);
  if (T) {
    Object.assign(T, { cars: [burntCar, okCar], blockers: [], _simAcc: 0, _driveCar: (car) => driven.push(car) });
    T._step(1 / 60);
  }
  ok(!!T && driven.length === 1 && driven[0] === okCar, 'traffic._step：燒焦殘骸不再沿車道行駛');
  const cands = T ? T.carjackCandidates(0, 0, 10) : [];
  ok(!!T && cands.length === 1 && cands[0].car === okCar, 'traffic.carjackCandidates：燒焦殘骸不可搶');
  ok(/car\.body\.isWrecked \|\| car\.v\.burnt\) continue;\n\s+const v = car\.v;\n\s+const dx = v\.pos\.x - x;/.test(tsrc13), 'traffic 喇叭反應跳過燒焦殘骸');
  const wreckSrc = sliceBetween(mainSrc, '      onWreck: (v) => {', '\n      },\n');
  const body = { isWrecked: false, active: false, setActive(on) { this.active = on; }, hit() { if (!this.active) return false; this.isWrecked = true; return true; } };
  const tc = { v: {}, body };
  const fn = tryEval(() => new Function('trafficCarOfVehicle', 'NPC_WRECK_IMPULSE', `return {${wreckSrc}\n      }}.onWreck;`)(() => tc, 1000));
  if (fn) fn(tc.v);
  ok(!!fn && body.isWrecked === true, 'main.js onWreck：停用中（ACTIVE_RADIUS 外）的車流車也轉殘骸');
  ok(!/c\.v\.ai = false/.test(mainSrc), 'main.js onWreck：移除無作用的 v.ai');
}
// 13.5 搶走受損 / 起火中的車流車：損壞與起火狀態帶到新 Vehicle
{
  const W = world({ rngSeed: 0.5 });
  const pl = W.addActor('player', 100, 100, { kind: 'player' });
  const oldV = W.addCar(0, 0);
  W.ex.damageVehicle(oldV, 900, { source: pl });
  W.run(1);
  const fuse = W.ex.fuseOf(oldV);
  const fires = W.of('vehicle:fire').length;
  const region = sliceBetween(mainSrc, '  // ---------- 搶車 ----------', '  const beginCarjack');
  const adapters = tryEval(() => new Function('createCarjack', 'bus', 'traffic', 'vehicles', 'dmg', 'adopted', 'explosions', 'player', 'state', 'combat', 'enterVehicle', region + '\n  return carjackAdapters;')(() => ({}), W.bus, { releaseCar: (c) => ({ type: 'sedan', x: c.v.pos.x, y: 0, z: c.v.pos.z, yaw: 0 }) }, { adopt: (pose) => mockVehicle(pose.x, pose.z) }, W.dmg, new Set(), W.ex, { actor: pl }, {}, W.combat, () => {}));
  let newV = null;
  if (adapters) {
    const pose = adapters.releaseCar({ v: oldV });
    newV = adapters.adopt(pose);
  }
  ok(!!newV && newV !== oldV && W.dmg.healthOf(newV) === W.dmg.healthOf(oldV), '搶車：新 Vehicle 耐久與原車相同', newV ? `${W.dmg.healthOf(newV)} vs ${W.dmg.healthOf(oldV)}` : 'no adapter');
  ok(!!newV && W.ex.stateOf(newV) === 'fire' && W.ex.fuseOf(newV) === fuse && W.of('vehicle:fire').length === fires, '搶車：起火狀態與引信原樣帶過（不重新點燃）');
  if (newV) {
    oldV.mesh = { parent: null };
    W.cars.push(newV);
    W.run(fuse + 0.1);
  }
  const ev = W.of('vehicle:explode').find((e) => e.vehicle === newV);
  ok(!!ev && ev.byPlayer === true, '搶來的起火車照原引信爆炸、來源保留');
  // 只受損未起火：耐久同樣帶過
  const W2 = world();
  const a = W2.addCar(0, 0);
  const b = W2.addCar(10, 0);
  W2.dmg.addDamage(a, 300);
  ok(typeof W2.ex.transfer === 'function' && W2.ex.transfer(a, b, () => W2.dmg.addDamage(b, 300)) === false && W2.dmg.healthOf(b) === 700 && W2.ex.stateOf(b) === 'ok', 'transfer：沒有起火狀態時只套耐久');
}
// 13.6 車內被炸到 hp 0 的同一幀按 F 下車 → 仍 WASTED
{
  clock = 0;
  const bus = createBus();
  const c = new CombatSystem({ now, bus });
  const kos = [];
  c.on('knockdown', (e) => kos.push(e));
  const pa = mockActor('player', 0, 0, { kind: 'player' });
  c.register(pa);
  pa.untargetable = true;
  const veh = {};
  const state = { mode: 'drive', vehicle: veh, respawn: null, koTimer: 0 };
  const exitVehicle = () => {
    state.mode = 'walk';
    state.vehicle = null;
    pa.untargetable = false;
    return true;
  };
  const region = sliceBetween(mainSrc, '  // 車內中彈', "  bus.on('gang:enter'");
  const G = tryEval(() => new Function('combat', 'player', 'state', 'exitVehicle', 'gangs', 'gangCtx', 'gangPlayer', 'playerPos', 'aim', region + '\n  return { updateGangs };')(c, { actor: pa }, state, exitVehicle, { update() {} }, {}, {}, () => ({ x: 0, z: 0 }), { aiming: false, dir: { x: 0, z: 1 } }));
  const ex = createExplosions({ combat: c });
  if (G) G.updateGangs(1 / 60, false); // 本幀 updateGangs（爆炸之前）
  ex.explode(0, 0.7, 0, {}); // updateExplosions：車內核心 → hp 0
  exitVehicle(); // 同一幀 drive 分支按 F 下車
  if (G) G.updateGangs(1 / 60, false); // 下一幀
  ok(pa.hp === 0 && !!G && c.stateOf(pa) === 'knockdown' && kos.some((e) => e.target === pa && e.cause === 'explosion'), '車內被炸 hp 0 同幀下車 → 仍倒地發 knockdown（player:ko → WASTED）', `${c.stateOf(pa)} / ${kos.length}`);
  ok(/updateExplosions\(dt\);\n\s+handleCarKo\(\);/.test(mainSrc), 'main.js：updateExplosions 之後同一幀處理車內 KO（F 下車前）');
}

console.log(`${fails.length ? 'FAIL' : 'PASS'} ${fails.length ? fails.length : pass}/${total}`);
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
