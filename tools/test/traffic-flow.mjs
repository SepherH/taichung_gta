#!/usr/bin/env node
// C1 車流擴量 + 號誌接線 + 轉接器 / 喇叭無頭驗證：Traffic（mock RAPIER，同 crowd.mjs）+ 真 traffic-lights.js + 真角色 glb
// 用法：node tools/test/traffic-flow.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：
//   1. 預算相容：budget 物件 / 舊 crowd 字串 'high' | 'low' 的車數與人數；lights 省略時不管號誌
//   2. 號誌模擬 300 s（high 45 台，dt 1/60）：沒有任何車在紅燈越過停止線（每步以車頭沿路位置判定跨線，當下該車進場方向燈色為紅即違規）；
//      紅燈有車停等、排隊跟車；綠燈起步反應時間 0.3–0.8 s（實測從轉綠到開始動）；沒有車連續停超過 120 s（不卡死）；
//      機車比例 35–45%、公車 ≤ 2（每秒檢查）；行人路線不穿越車道（說明行人不看號誌的依據）
//   3. setBudget high → low → ultra：每次 30 s 內車數 / 車種 / 人數 / 骨架池收斂，每次管理的增減有上限、切換期間每幀 CPU 峰值
//   4. 轉接器：carjackCandidates（排序、車速 > 6 m/s 不列、欄位）、releaseCar（移除、回傳位姿、之後補車）、
//      spawnEjectedDriver（倒地 → 起身 → 大腦逃跑或還手）
//   5. 喇叭：attachBus 訂閱 vehicle:horn → 前方 15 m 內行人 brain.hear、後方 / 遠處不呼叫；前方同車道車 0.5 s 內開始加速離開；取消訂閱後不再反應
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

// 程序化車的車牌貼圖 / 號誌倒數用 2D canvas：最小替身
const ctx2d = new Proxy({}, {
  get: (_, k) => (k === 'measureText' ? () => ({ width: 100 }) : () => {}),
  set: () => true,
});
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d, style: {} }),
};

const fs = await import('node:fs');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');
const THREE = await import('three');
const { getTerrain, onRoadSurface } = await import('../../src/citymodel.js');
const { computeSpawn, pedestrianRoutes } = await import('../../src/places.js');
const { samplePolyline } = await import('../../src/geom.js');
const { Traffic, crowdCap } = await import('../../src/traffic.js');
const { createTrafficLights } = await import('../../src/traffic-lights.js');
const { loadCharacterModels } = await import('../../src/characters/index.js');
const { CombatSystem } = await import('../../src/combat.js');
const { NpcBrain } = await import('../../src/npc-ai.js');
const { PhysicsWorld } = await import('../../src/physics/world.js');
const { GROUPS } = await import('../../src/physics/groups.js');
const { createContactRouter } = await import('../../src/physics/contacts.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLIC = path.join(ROOT, 'public');
const DT = 1 / 60;

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : String(v));

function fsFetch(url) {
  const file = path.join(PUBLIC, url.replace(/^\.\//, ''));
  if (!fs.existsSync(file)) return Promise.resolve({ ok: false, status: 404, headers: { get: () => 'text/html' } });
  const buf = fs.readFileSync(file);
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: () => (file.endsWith('.json') ? 'application/json' : 'model/gltf-binary') },
    json: async () => JSON.parse(buf.toString('utf8')),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  });
}

await loadCharacterModels('./models/characters/manifest.json', { fetch: fsFetch });
const terrain = getTerrain();
const q = {};
const spawn = computeSpawn();

// ======================= mock RAPIER（同 physics-integration.mjs 的最小版）=======================
function makeMockRapier() {
  const RBT = { Dynamic: 0, Fixed: 1, KinematicPositionBased: 2 };
  const DAMP = 0.9;
  const vec = (v) => ({ x: v.x, y: v.y, z: v.z });
  class Desc {
    constructor(type) {
      this.type = type;
      this.t = { x: 0, y: 0, z: 0 };
      this.q = { x: 0, y: 0, z: 0, w: 1 };
      this.mass = 1;
    }
    setTranslation(x, y, z) {
      this.t = { x, y, z };
      return this;
    }
    setRotation(r) {
      this.q = { ...r };
      return this;
    }
    setAdditionalMassProperties(m) {
      this.mass = m;
      return this;
    }
    setCcdEnabled() {
      return this;
    }
    setCanSleep() {
      return this;
    }
  }
  class Body {
    constructor(d) {
      this.t = { ...d.t };
      this.q = { ...d.q };
      this.type = d.type;
      this.m = d.mass;
      this.lv = { x: 0, y: 0, z: 0 };
      this.av = { x: 0, y: 0, z: 0 };
      this.enabled = true;
      this.next = null;
      this.nextQ = null;
    }
    translation() { return vec(this.t); }
    rotation() { return { ...this.q }; }
    linvel() { return vec(this.lv); }
    angvel() { return vec(this.av); }
    setTranslation(t) { this.t = vec(t); }
    setRotation(r) { this.q = { ...r }; }
    setLinvel(v) { this.lv = vec(v); }
    setAngvel(v) { this.av = vec(v); }
    setNextKinematicTranslation(t) { this.next = vec(t); }
    setNextKinematicRotation(r) { this.nextQ = { ...r }; }
    setBodyType(t) { this.type = t; }
    bodyType() { return this.type; }
    setEnabled(on) { this.enabled = on; }
    isEnabled() { return this.enabled; }
    applyImpulse(j) {
      if (this.type !== RBT.Dynamic) return;
      this.lv.x += j.x / this.m;
      this.lv.y += j.y / this.m;
      this.lv.z += j.z / this.m;
    }
    applyTorqueImpulse() {}
    setEnabledRotations() {}
    mass() { return this.m; }
    isSleeping() { return false; }
  }
  class ColDesc {
    constructor(kind, a, b) {
      this.kind = kind;
      this.lift = kind === 'capsule' ? a + b : 0;
    }
  }
  ColDesc.prototype.setMass = function (m) {
    this.mass = m;
    return this;
  };
  for (const k of ['setDensity', 'setFriction', 'setRestitution', 'setActiveEvents', 'setContactForceEventThreshold', 'setCollisionGroups', 'setSolverGroups']) {
    ColDesc.prototype[k] = function () {
      return this;
    };
  }
  let nextHandle = 1;
  class Collider {
    constructor(desc, body) {
      this.handle = nextHandle++;
      this.body = body;
      this.lift = desc.lift;
      if (body && desc.mass) body.m = desc.mass;
    }
    parent() { return this.body; }
    setSolverGroups() {}
  }
  const ground = new Collider(new ColDesc('ground'), null);
  const vehicleController = () => new Proxy({ wheels: 0 }, {
    get(o, k) {
      if (k === 'addWheel') return () => o.wheels++;
      if (k === 'wheelHardPoint') return () => ({ x: 0, y: 0, z: 0 });
      if (k === 'wheelSuspensionLength') return () => 0.25;
      if (k === 'wheelRotation' || k === 'wheelSteering' || k === 'currentVehicleSpeed') return () => 0;
      if (k === 'wheelIsInContact') return () => true;
      return () => {};
    },
    set: () => true,
  });
  class CharController {
    constructor(offset) {
      this.offset = offset;
      this.mv = { x: 0, y: 0, z: 0 };
      this.gr = false;
    }
    computeColliderMovement(col, d) {
      const t = col.body.t;
      const lift = col.lift + this.offset;
      const x = t.x + d.x;
      const z = t.z + d.z;
      const g = terrain.querySurface(x, z, t.y - lift + 0.4, q).y;
      const foot = Math.max(g, t.y - lift + d.y);
      this.gr = foot <= g + 1e-6;
      this.mv = { x: d.x, y: foot + lift - t.y, z: d.z };
    }
    computedMovement() { return this.mv; }
    computedGrounded() { return this.gr; }
    numComputedCollisions() { return 0; }
  }
  for (const k of ['setUp', 'enableAutostep', 'setMaxSlopeClimbAngle', 'setMinSlopeSlideAngle', 'enableSnapToGround', 'setApplyImpulsesToDynamicBodies', 'setSlideEnabled']) {
    CharController.prototype[k] = () => {};
  }
  class World {
    constructor() {
      this.bodies = [];
      this.colliders = new Map([[ground.handle, ground]]);
      this.timestep = DT;
    }
    createRigidBody(d) {
      const b = new Body(d);
      this.bodies.push(b);
      return b;
    }
    createCollider(d, body) {
      const c = new Collider(d, body);
      this.colliders.set(c.handle, c);
      return c;
    }
    getCollider(h) { return this.colliders.get(h); }
    createVehicleController() { return vehicleController(); }
    createCharacterController(offset) { return new CharController(offset); }
    removeRigidBody() {}
    removeCharacterController() {}
    removeVehicleController() {}
    propagateModifiedBodyPositionsToColliders() {}
    step(eq) {
      for (const b of this.bodies) {
        if (!b.enabled) continue;
        if (b.type === RBT.KinematicPositionBased) {
          if (b.next) b.t = b.next;
          if (b.nextQ) b.q = b.nextQ;
          b.next = null;
          b.nextQ = null;
        } else if (b.type === RBT.Dynamic) {
          b.t.x += b.lv.x * this.timestep;
          b.t.y += b.lv.y * this.timestep;
          b.t.z += b.lv.z * this.timestep;
          for (const k of ['x', 'y', 'z']) b.lv[k] *= DAMP;
        }
      }
      if (eq) eq.stepped++;
    }
    castRayAndGetNormal(ray, maxToi) {
      const g = terrain.querySurface(ray.origin.x, ray.origin.z, ray.origin.y, q).y;
      const toi = ray.origin.y - g;
      return toi >= 0 && toi <= maxToi ? { timeOfImpact: toi, normal: { x: 0, y: 1, z: 0 }, collider: ground } : null;
    }
    castRay(ray, maxToi) {
      const h = this.castRayAndGetNormal(ray, maxToi);
      return h ? { timeOfImpact: h.timeOfImpact, collider: ground } : null;
    }
    intersectionsWithShape() {}
    intersectionWithShape() { return null; }
    castShape() { return null; }
  }
  class EventQueue {
    constructor() {
      this.collisions = [];
      this.forces = [];
      this.stepped = 0;
    }
    clear() {}
    drainCollisionEvents(cb) {
      for (const e of this.collisions.splice(0)) cb(...e);
    }
    drainContactForceEvents(cb) {
      for (const e of this.forces.splice(0)) {
        cb({ collider1: () => e.h1, collider2: () => e.h2, totalForceMagnitude: () => e.force, maxForceMagnitude: () => e.force, maxForceDirection: () => e.dir });
      }
    }
    free() {}
  }
  class Ray {
    constructor(origin, dir) {
      this.origin = origin;
      this.dir = dir;
    }
  }
  return {
    World, EventQueue, Ray,
    RigidBodyType: RBT,
    RigidBodyDesc: { dynamic: () => new Desc(RBT.Dynamic), kinematicPositionBased: () => new Desc(RBT.KinematicPositionBased), fixed: () => new Desc(RBT.Fixed) },
    ColliderDesc: { cuboid: () => new ColDesc('cuboid'), capsule: (hh, r) => new ColDesc('capsule', hh, r) },
    Capsule: class {},
    Ball: class {},
    ActiveEvents: { COLLISION_EVENTS: 1, CONTACT_FORCE_EVENTS: 2 },
    QueryFilterFlags: { EXCLUDE_SENSORS: 8 },
  };
}


// ======================= 共用 =======================
// 假 qualityBudget 物件（主控裁決後的最終畫質表）
const TIERS = {
  low: { id: 'low', peds: 40, cars: 18, pedNear: 30, pedFar: 70, motorbikeShare: 0.4 },
  mid: { id: 'mid', peds: 80, cars: 30, pedNear: 40, pedFar: 90, motorbikeShare: 0.4 },
  high: { id: 'high', peds: 140, cars: 45, pedNear: 50, pedFar: 110, motorbikeShare: 0.4 },
  ultra: { id: 'ultra', peds: 200, cars: 60, pedNear: 60, pedFar: 130, motorbikeShare: 0.4 },
};

// 假事件匯流排（契約 §1 的 on / emit 形狀）
function fakeBus() {
  const map = new Map();
  return {
    on(name, fn) {
      if (!map.has(name)) map.set(name, new Set());
      map.get(name).add(fn);
      return () => map.get(name).delete(fn);
    },
    emit(name, payload) {
      for (const fn of [...(map.get(name) || [])]) fn(payload);
    },
    count: (name) => (map.get(name) ? map.get(name).size : 0),
  };
}

function build(opts) {
  const RAPIER = makeMockRapier();
  const pw = new PhysicsWorld(RAPIER);
  const router = createContactRouter(RAPIER, pw);
  pw.onAfterStep((dt) => router.drain(dt));
  const physics = { RAPIER, pw, router, groups: GROUPS };
  pw.stepOnce();
  const game = { clock: 0 };
  const combat = new CombatSystem({ now: () => game.clock });
  const scene = new THREE.Scene();
  const traffic = new Traffic(scene, { center: spawn, terrain, physics, combat, ...opts });
  game.frame = (player = spawn, lights = null) => {
    if (lights) lights.update(DT);
    pw.step(DT);
    game.clock += DT;
    combat.update(DT);
    traffic.sync(DT, player);
  };
  return Object.assign(game, { pw, combat, traffic, physics, scene });
}

const mix = (t) => {
  let bus = 0;
  let bike = 0;
  for (const c of t.cars) {
    if (c.type === 'bus') bus++;
    else if (c.type === 'scooter') bike++;
  }
  return { bus, bike, n: t.cars.length, share: t.cars.length ? bike / t.cars.length : 0 };
};

// ======================= 1. 預算相容 =======================
{
  const a = build({ crowd: 'low' }).traffic;
  const b = build({ budget: TIERS.mid }).traffic;
  const c = build({}).traffic;
  check('舊 crowd: \'low\' → low 列（車 18、人 40）；budget 物件優先；都省略 → high 列（車 45、人 140）',
    a.cars.length === 18 && a.plan.target === 40 && b.cars.length === 30 && b.plan.target === 80 && c.cars.length === 45 && c.plan.target === 140,
    `low ${a.cars.length} / ${a.plan.target}、mid ${b.cars.length} / ${b.plan.target}、預設 ${c.cars.length} / ${c.plan.target}`);
  const m = mix(c);
  check('開場車種：公車 ≤ 2（且 ≥ 1）、機車比例 35–45%', m.bus >= 1 && m.bus <= 2 && m.share >= 0.35 && m.share <= 0.45, `公車 ${m.bus}、機車 ${m.bike} / ${m.n}（${(m.share * 100).toFixed(1)}%）`);
  check('lights 省略：不做號誌查詢（相容舊測試）', c.lights === null);
}

// ======================= 2. 號誌 300 s =======================
{
  const lights = createTrafficLights();
  const game = build({ budget: { ...TIERS.high, peds: 0 }, lights });
  const { traffic } = game;
  const violations = [];
  let crossings = 0;
  let onYellow = 0;
  let holdSteps = 0;
  let queued = 0;
  const reacts = [];
  const pendingGo = new Map(); // car → 轉綠時刻
  const stopped = new Map(); // car → 連續停止秒數
  let maxStopped = 0;
  const crossCheck = (car, road, dir, f0, f1, x0, z0) => {
    for (const st of lights.roadStops(road)) {
      if (st.dir !== dir) continue;
      if (dir * (st.stopS - f0) >= 0 && dir * (st.stopS - f1) < 0) {
        crossings++;
        const col = lights.approachState(st.signal, x0, z0).color;
        if (col === 'red') violations.push({ t: f2(game.clock), sig: st.signal.id, type: car.type, speed: f2(car.speed) });
        else if (col === 'yellow') onYellow++;
      }
    }
  };
  const leaderAhead = (car) => {
    const fx = Math.sin(car.v.yaw);
    const fz = Math.cos(car.v.yaw);
    return traffic.cars.some((o) => {
      if (o === car) return false;
      const dx = o.v.pos.x - car.v.pos.x;
      const dz = o.v.pos.z - car.v.pos.z;
      const along = dx * fx + dz * fz;
      return along > 0.5 && along < 14 + (car.v.spec.length - 4.5) / 2 + (o.v.spec.length - 4.5) / 2 + 1 && Math.abs(dx * fz - dz * fx) < 2.1;
    });
  };
  const origDrive = traffic._driveCar.bind(traffic);
  traffic._driveCar = (car, dt, bl) => {
    const r0 = car.road;
    const d0 = car.dir;
    const s0 = car.s;
    const x0 = car.v.pos.x;
    const z0 = car.v.pos.z;
    const hold0 = car.sigHold;
    const delay0 = car.goDelay;
    origDrive(car, dt, bl);
    const half = car.v.spec.length / 2;
    const ds = car.speed * dt;
    if (car.road === r0 && car.dir === d0) crossCheck(car, r0, d0, s0 + d0 * half, car.s + d0 * half, x0, z0);
    else if (car.road !== r0) {
      crossCheck(car, r0, d0, s0 + d0 * half, s0 + d0 * (half + ds), x0, z0);
      const f1 = car.s + car.dir * half;
      crossCheck(car, car.road, car.dir, f1 - car.dir * ds, f1, x0, z0);
    }
    if (car.sigHold) holdSteps++;
    // 起步反應：本步剛從停等轉為放行（goDelay 設定）→ 記下時刻；之後第一次車速 > 0.05 m/s 時算出反應時間
    // 只量排頭車（前方 14 m 車道內沒有其他車；排在後面的車要等前車開走，不算反應時間）
    if (hold0 && !car.sigHold && car.goDelay > 0 && delay0 <= 0 && !leaderAhead(car)) pendingGo.set(car, game.clock);
    if (pendingGo.has(car) && car.speed > 0.05) {
      reacts.push(game.clock - pendingGo.get(car));
      pendingGo.delete(car);
    }
  };
  let shareMin = 1;
  let shareMax = 0;
  let busMax = 0;
  const SIM = 300;
  for (let f = 1; f <= SIM * 60; f++) {
    game.frame(spawn, lights);
    if (f % 60 === 0) {
      const m = mix(traffic);
      shareMin = Math.min(shareMin, m.share);
      shareMax = Math.max(shareMax, m.share);
      busMax = Math.max(busMax, m.bus);
      for (const car of traffic.cars) {
        const t = car.speed < 0.1 ? (stopped.get(car) || 0) + 1 : 0;
        stopped.set(car, t);
        maxStopped = Math.max(maxStopped, t);
        // 排隊：自己停著、不是號誌直接擋（sigHold 為假或停止線還遠）而前方 14 m 內有停著的車
        if (car.speed < 0.1 && traffic.cars.some((o) => o !== car && o.speed < 0.1 && Math.hypot(o.v.pos.x - car.v.pos.x, o.v.pos.z - car.v.pos.z) < 16 && ((o.v.pos.x - car.v.pos.x) * Math.sin(car.v.yaw) + (o.v.pos.z - car.v.pos.z) * Math.cos(car.v.yaw)) > 0.5)) queued++;
      }
    }
  }
  const s = traffic.stats;
  console.log(`INFO  號誌模擬 ${SIM} s：車 ${traffic.cars.length} 台、跨停止線 ${crossings} 次（黃燈 ${onYellow}）、號誌停等 ${f2(holdSteps / 60)} 車秒、排隊樣本 ${queued}、換路 ${s.switches}、掉頭 ${s.uTurns}、補車 ${s.carsSpawned}、回收 ${s.carsRemoved}`);
  check(`模擬 ${SIM} s：沒有任何車在紅燈越過停止線`, violations.length === 0 && crossings > 100, violations.length ? JSON.stringify(violations.slice(0, 3)) : `跨線 ${crossings} 次全在綠 / 黃燈`);
  check('紅燈有車在停止線前停等、後車排隊跟車', holdSteps > 60 * 60 && queued > 20, `停等 ${f2(holdSteps / 60)} 車秒、排隊樣本 ${queued}`);
  const rMin = Math.min(...reacts);
  const rMax = Math.max(...reacts);
  check('綠燈起步反應時間 0.3–0.8 s（實測轉綠到開始動）', reacts.length >= 20 && rMin >= 0.3 - DT && rMax <= 0.8 + 2 * DT && s.goReact.every((v) => v >= 0.3 && v <= 0.8),
    `${reacts.length} 次、${f2(rMin)}–${f2(rMax)} s、平均 ${f2(reacts.reduce((a, b) => a + b, 0) / reacts.length)} s`);
  check('不卡死：沒有車連續停止超過 120 s', maxStopped <= 120, `最長連續停止 ${maxStopped} s`);
  check(`${SIM} s 內每秒：機車比例 35–45%、公車 ≤ 2`, shareMin >= 0.35 && shareMax <= 0.45 && busMax <= 2, `機車 ${(shareMin * 100).toFixed(1)}–${(shareMax * 100).toFixed(1)}%、公車最多 ${busMax}`);

  // 行人不看號誌的依據：places.js 行人路線（1 m 取樣）沒有任何點落在車道路面上
  const { routes } = pedestrianRoutes();
  const tmp = {};
  let onRoad = 0;
  let onRoadSig = 0;
  let inJunction = 0;
  let samples = 0;
  for (const r of routes) {
    let touched = false;
    for (let t = r.s0; t <= r.s1; t += 1) {
      samplePolyline(r.road, t, tmp);
      const x = tmp.x - tmp.dz * r.off;
      const z = tmp.z + tmp.dx * r.off;
      samples++;
      if (onRoadSurface(x, z, 0, false)) {
        onRoad++;
        if (lights.signalAt(x, z)) onRoadSig++;
      }
      if (!touched && lights.signalAt(x, z)) touched = true;
    }
    if (touched) inJunction++;
  }
  // places.js 以 ROUTE_CHECK_STEP 間距檢查可行走，1 m 取樣偶有幾點擦到車道路緣（非路口）；號誌路口內必須為 0
  check('行人路線不穿越號誌路口車道（因此行人不需依 pedWalk 等燈）', onRoadSig === 0 && onRoad <= samples * 1e-4, `${routes.length} 條路線 ${samples} 個取樣點、在車道上 ${onRoad}（號誌路口內 ${onRoadSig}）；經過號誌路口判定圈（路緣外側轉角）${inJunction} 條`);
}

// ======================= 3. setBudget 升降 =======================
{
  const game = build({ budget: TIERS.high });
  const { traffic } = game;
  const player = { x: spawn.x, y: spawn.y, z: spawn.z };
  // 鏡頭固定朝北（視野內的車 / 人不回收、不在眼前生成）
  traffic.setView(player.x, player.z + 7, 0, -1, Math.atan(Math.tan((60 * Math.PI) / 360) * (16 / 9)));
  for (let f = 0; f < 120; f++) game.frame(player);
  const inRadius = () => traffic.citizens.filter((c) => Math.hypot((c.ped || c).x - player.x, (c.ped || c).z - player.z) <= traffic.plan.radius).length;
  for (const tier of ['low', 'ultra', 'mid']) {
    const b = TIERS[tier];
    traffic.setBudget(b);
    let conv = null;
    let maxCarDelta = 0;
    let maxPedDelta = 0;
    let peak = 0;
    let prevCars = traffic.cars.length;
    let prevCit = traffic.citizens.length;
    const cap = Math.floor(b.peds * 1.05 + 1e-9);
    let capAt = null; // 市民總數（骨架 + 替身）首次 ≤ cap 的時間（降級時多的人每次管理回收 4 人，分攤數秒）
    let overAfter = 0; // 之後的市民總數最大值
    for (let f = 1; f <= 30 * 60; f++) {
      const t0 = performance.now();
      game.frame(player);
      peak = Math.max(peak, performance.now() - t0);
      maxCarDelta = Math.max(maxCarDelta, Math.abs(traffic.cars.length - prevCars));
      maxPedDelta = Math.max(maxPedDelta, Math.abs(traffic.citizens.length - prevCit));
      prevCars = traffic.cars.length;
      prevCit = traffic.citizens.length;
      if (conv === null) {
        const m = mix(traffic);
        const n = inRadius();
        const want = Math.round(b.cars * 0.4);
        const ok = m.n === b.cars && Math.abs(m.bike - want) <= 1 && m.bus <= 2 && n >= b.peds * 0.9 && n <= b.peds * 1.1 && traffic.peds.length <= traffic.poolMax && traffic.peds.length + traffic.pedPool.length <= traffic.poolMax + 1;
        if (ok) conv = f / 60;
      }
      const total = Math.max(traffic.citizens.length, traffic.peds.length + traffic.impostors.count);
      if (capAt === null && total <= cap) capAt = f / 60;
      if (capAt !== null) overAfter = Math.max(overAfter, total);
    }
    const m = mix(traffic);
    check(`setBudget → ${tier}：30 s 內收斂（車 ${b.cars}、機車 ≈ 40%、公車 ≤ 2、radius 內人數 ±10%、骨架 ≤ poolMax ${traffic.poolMax}）`, conv !== null,
      `${conv === null ? '未收斂' : f2(conv) + ' s'}；車 ${m.n}（機車 ${m.bike}、公車 ${m.bus}）、radius 內 ${inRadius()} 人、骨架 ${traffic.peds.length} + 池 ${traffic.pedPool.length}`);
    check(`setBudget → ${tier}：市民總數（骨架 + 替身）10 s 內壓到 peds × 1.05 = ${cap} 以下且之後每幀不超過（crowdCap ${crowdCap(b.peds)}）`,
      capAt !== null && capAt <= 10 && overAfter <= cap && crowdCap(b.peds) === cap, `${capAt === null ? '未壓到' : f2(capAt) + ' s 壓到'}、之後最多 ${overAfter} 人、末 ${traffic.citizens.length} 人`);
    check(`setBudget → ${tier}：逐步增減（每幀車 ≤ 2 台、市民 ≤ 12 人）、切換期間每幀峰值 ${f2(peak)} ms < 16 ms`, maxCarDelta <= 2 && maxPedDelta <= 12 && peak < 16, `車 ±${maxCarDelta}、市民 ±${maxPedDelta}`);
  }
}

// ======================= 4. 轉接器 =======================
{
  const lights = createTrafficLights();
  const game = build({ budget: TIERS.high, lights });
  const { traffic, combat } = game;
  for (let f = 0; f < 60 * 20; f++) game.frame(spawn, lights);
  // 找一台停著的車（紅燈停等）；沒有就讓最近一台停下
  let car = traffic.cars.find((c) => c.speed < 0.5 && !c.body.isWrecked);
  if (!car) {
    car = traffic.cars[0];
    car.speed = 0;
  }
  const fast = traffic.cars.find((c) => c.speed > 6.5);
  const cands = traffic.carjackCandidates(car.v.pos.x, car.v.pos.z, 1000);
  const sorted = cands.every((c, i) => i === 0 || Math.hypot(c.x - car.v.pos.x, c.z - car.v.pos.z) >= Math.hypot(cands[i - 1].x - car.v.pos.x, cands[i - 1].z - car.v.pos.z) - 1e-9);
  const keys = ['car', 'x', 'z', 'yaw', 'type', 'color', 'speed', 'driverVariant'];
  check('carjackCandidates：依距離排序、第一筆是目標車、車速 > 6 m/s 不列、欄位齊全',
    cands.length > 0 && cands[0].car === car && sorted && cands.every((c) => c.speed <= 6 && keys.every((k) => k in c)) && (!fast || !cands.some((c) => c.car === fast)) && traffic.carjackCandidates(car.v.pos.x, car.v.pos.z, 0.001).length <= 1,
    `${cands.length} 台候選（最快的一台 ${fast ? f2(fast.speed) + ' m/s 未列' : '無'}）、driverVariant ${cands[0] && cands[0].driverVariant}`);
  const n0 = traffic.cars.length;
  const pose = { x: car.v.pos.x, z: car.v.pos.z, yaw: car.v.yaw };
  const rel = traffic.releaseCar(car);
  check('releaseCar：回傳 { type, color, x, y, z, yaw, vx, vz, driverVariant }、自車流移除（剛體釋放、網格離開場景）',
    rel && ['type', 'color', 'x', 'y', 'z', 'yaw', 'vx', 'vz', 'driverVariant'].every((k) => k in rel) && Math.abs(rel.x - pose.x) < 1e-9 && Math.abs(rel.yaw - pose.yaw) < 1e-9 &&
      traffic.cars.length === n0 - 1 && !traffic.cars.includes(car) && car.body.body === null && car.v.mesh.parent === null && traffic.releaseCar(car) === null,
    rel ? `${rel.type} ${rel.color}、(${f2(rel.x)}, ${f2(rel.z)})、v (${f2(rel.vx)}, ${f2(rel.vz)})` : 'null');
  let back = null;
  for (let f = 1; f <= 60 * 5 && back === null; f++) {
    game.frame(spawn, lights);
    if (traffic.cars.length === n0) back = f / 60;
  }
  check('releaseCar 後車流自行補車（視野外）', back !== null, back === null ? '未補回' : `${f2(back)} s 補回 ${n0} 台`);

  // spawnEjectedDriver：倒地 → 起身 → 依性格逃跑或還手（以玩家 Actor 為攻擊者）
  // 玩家站在車旁（密度管理中心 = 車位置，同遊戲中搶車當下）
  const at = { x: pose.x, y: 0, z: pose.z };
  const player = { id: 'player', kind: 'player', pos: { x: pose.x + 2, y: 0, z: pose.z }, yaw: 0, hp: 100, maxHp: 100, faction: 'player', anim: { state: 'idle', trigger: () => true, on: () => () => {} }, body: { knockdown() {}, settleCheck: () => ({ settled: true, clearToStand: true }), standUp() {} } };
  combat.register(player);
  traffic.setContext({ player });
  const results = [];
  for (const variant of ['pedestrian', 'pedestrian_heavy', 'pedestrian_f', 'pedestrian', 'pedestrian_heavy', 'pedestrian', 'pedestrian_heavy', 'pedestrian_heavy', 'pedestrian_f', 'pedestrian_heavy']) {
    const cit0 = traffic.citizens.length;
    const p = traffic.spawnEjectedDriver({ x: pose.x + Math.cos(pose.yaw) * 1.2, z: pose.z - Math.sin(pose.yaw) * 1.2, yaw: pose.yaw + Math.PI / 2, variant });
    if (p) console.log(`INFO  拖出司機 ${variant}：state ${p.state}、combat ${combat.stateOf(p.actor)}、anim ${p.anim.state}、variant ${p.variant}、isDown ${p.body.isDown}、市民 ${cit0} → ${traffic.citizens.length}`);
    const r = { variant, ok0: !!p && p.state === 'down' && combat.stateOf(p.actor) === 'knockdown' && p.anim.state === 'knockdown' && p.variant === variant && p.body.isDown && traffic.citizens.length === cit0 + 1, mode: null, getup: false };
    for (let f = 0; f < 60 * 8 && p; f++) {
      game.frame(at, lights);
      if (p.anim.state === 'getup') r.getup = true;
      const st = p.brain && p.brain.state;
      if (r.getup && (st === 'flee' || st === 'fight') && !r.mode) {
        r.mode = st;
        r.fights = p.brain.fights; // 性格（braveness 門檻）決定還手 / 逃跑
      }
    }
    results.push(r);
  }
  const modes = results.map((r) => r.mode);
  check('spawnEjectedDriver：生成即倒地（combat knockdown、倒地動畫、剛體 dynamic、variant 照給）', results.every((r) => r.ok0));
  check('spawnEjectedDriver：起身後依 NpcBrain 性格對玩家還手（fights）或逃跑', results.every((r) => r.getup && r.mode === (r.fights ? 'fight' : 'flee')), `起身 ${results.filter((r) => r.getup).length}/${results.length}；${modes.join(', ')}`);
}

// ======================= 5. 喇叭 =======================
{
  const game = build({ budget: TIERS.high });
  const { traffic } = game;
  const bus = fakeBus();
  const off = traffic.attachBus(bus);
  for (let f = 0; f < 30; f++) game.frame();
  // brain.hear 由 C2 同時實作中：這裡以間諜包一層（原本沒有就只記錄）
  const heard = [];
  const had = NpcBrain.prototype.hear;
  NpcBrain.prototype.hear = function (evt) {
    heard.push({ brain: this, evt });
    if (had) had.call(this, evt);
  };
  const p = traffic.peds.find((x) => x.state === 'walk' && x.citizen.level === 'near');
  const others = traffic.peds.filter((x) => x !== p);
  // 喇叭在行人後方 10 m、朝向行人
  const hx = p.x - 10;
  const hz = p.z;
  const shouldHear = traffic.peds.filter((x) => Math.hypot(x.x - hx, x.z - hz) <= 15 && x.x - hx >= 0);
  bus.emit('vehicle:horn', { vehicle: { yaw: Math.PI / 2 }, x: hx, z: hz, dirX: 1, dirZ: 0 });
  const got = new Set(heard.map((h) => h.brain));
  const evt = heard.find((h) => h.brain === p.brain);
  check('喇叭：前方 15 m 內行人 brain.hear({ type: \'horn\', x, z, dirX, dirZ })，後方 / 15 m 外不呼叫',
    evt && evt.evt.type === 'horn' && evt.evt.dirX === 1 && shouldHear.every((x) => got.has(x.brain)) && others.filter((x) => !shouldHear.includes(x)).every((x) => !got.has(x.brain)),
    `應聽到 ${shouldHear.length} 人、實際 ${got.size} 人`);
  // 前方同車道的車：喇叭在車後 8 m、同方向；對向車 / 側邊車不反應
  const car = traffic.cars.find((c) => c.speed > 2 && !c.bus);
  const fx = Math.sin(car.v.yaw);
  const fz = Math.cos(car.v.yaw);
  const before = traffic.cars.map((c) => c.hornDelay);
  const res = traffic.onHorn({ vehicle: null, x: car.v.pos.x - fx * 8, z: car.v.pos.z - fz * 8, dirX: fx, dirZ: fz });
  const reacted = traffic.cars.filter((c, i) => c.hornDelay >= 0 && before[i] < 0);
  check('喇叭：前方同車道車流車被標記（0.5 s 內反應）', reacted.includes(car) && car.hornDelay <= 0.5 && reacted.every((c) => Math.sin(c.v.yaw) * fx + Math.cos(c.v.yaw) * fz > 0.7), `反應 ${res.cars} 台`);
  const v0 = car.cruise;
  let boosted = null;
  for (let f = 1; f <= 60 && boosted === null; f++) {
    game.frame();
    if (car.hornBoost > 0) boosted = f / 60;
  }
  check('喇叭：前車 0.5 s 內開始加速離開（巡航 × 1.3，不減速讓道）', boosted !== null && boosted <= 0.5 + DT, boosted === null ? '未反應' : `${f2(boosted)} s，巡航 ${f2(v0)} → 目標 ${f2(v0 * 1.3)} m/s`);
  off();
  heard.length = 0;
  bus.emit('vehicle:horn', { vehicle: null, x: hx, z: hz, dirX: 1, dirZ: 0 });
  check('喇叭：取消訂閱後不再反應', heard.length === 0 && bus.count('vehicle:horn') === 0);
  if (had) NpcBrain.prototype.hear = had;
  else delete NpcBrain.prototype.hear;
}

console.log(`\ntraffic-flow.mjs：${passed} 通過 / ${failed} 失敗`);
console.log(failed ? `FAIL ${failed}/${passed + failed}` : `PASS ${passed}/${passed}`);
process.exit(failed ? 1 : 0);
