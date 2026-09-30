#!/usr/bin/env node
// F3b 行人密度管理無頭驗證：真實角色 glb + Traffic（mock RAPIER，同 combat-integration.mjs 的最小版；密度管理不依賴真物理）
// 用法：node tools/test/crowd.mjs（任一斷言失敗 exit 1）
// 項目：玩家沿出生點道路方向移動 300 m（5 m/s）+ 原地 20 s，每秒記錄半徑 80 m 內人數（high 40–60、low 25–35）；
//   生成點不在建築 / 湖 / 車道內、補生成在 60–100 m 且視野外；物件池新建骨架數 ≤ 上限；120 m 外沒有行人剛體；
//   全部生成點（places.js pedestrianRoutes）的位置檢查與各類型數量；效能：50 行人 + 10 車每幀 CPU（mixer / AI / combat / 生成管理）
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

// 程序化車（工作區無車輛 glb 時）的車牌貼圖用 2D canvas：最小替身
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
const { getTerrain, buildingAt, inWater, onRoadSurface, surfaceRoads } = await import('../../src/citymodel.js');
const { closestOnSegment } = await import('../../src/geom.js');
const { computeSpawn, pedestrianRoutes, PED_SPOT_WEIGHTS } = await import('../../src/places.js');
const { Traffic } = await import('../../src/traffic.js');
const { PED_TARGET, SPAWN_ROAD_NAME } = await import('../../src/data/city.js');
const { loadCharacterModels, CharacterAnimator } = await import('../../src/characters/index.js');
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

const chars = await loadCharacterModels('./models/characters/manifest.json', { fetch: fsFetch });
check('角色 glb 三種 variant 載入', chars.variants.length >= 3 && !chars.fallback, chars.variants.join(','));
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


// 位置檢查：不在建築內、湖內、任何車道路面上（比「車道中央」更嚴）
const badSpot = (x, z) => (buildingAt(x, z, 0) ? '建築' : inWater(x, z, 0) ? '湖' : onRoadSurface(x, z, 0, false) ? '車道' : null);

// ======================= 1. 生成點資料 =======================
{
  const { routes, spots } = pedestrianRoutes();
  const kinds = {};
  let bad = 0;
  let badWhy = '';
  for (const sp of spots) {
    kinds[sp.route.kind] = (kinds[sp.route.kind] || 0) + 1;
    const why = badSpot(sp.x, sp.z);
    if (why) {
      bad++;
      badWhy = `${why} (${f2(sp.x)}, ${f2(sp.z)})`;
    }
  }
  check(`生成點 ${spots.length} 個（${routes.length} 條路線區段）皆不在建築 / 湖 / 車道內`, bad === 0, bad ? `${bad} 個違規，例 ${badWhy}` : '');
  check('五類生成點都有：人行道 / 步道 / 廣場 / 秋紅谷 / 百貨門口', Object.keys(PED_SPOT_WEIGHTS).every((k) => kinds[k] > 0), JSON.stringify(kinds));
  const qhg = spots.filter((s) => s.route.kind === 'qiuhonggu');
  const low = qhg.filter((s) => terrain.querySurface(s.x, s.z, Infinity, q).y < -3).length;
  check('秋紅谷生成點多數在谷底（湖邊步道 / 坡道，terrain y < −3 m）', low > qhg.length / 2, `${low} / ${qhg.length}`);
}

// ======================= 2. 密度：移動 300 m + 原地 20 s =======================
function buildTraffic(crowd) {
  const RAPIER = makeMockRapier();
  const pw = new PhysicsWorld(RAPIER);
  const router = createContactRouter(RAPIER, pw);
  pw.onAfterStep((dt) => router.drain(dt));
  const physics = { RAPIER, pw, router, groups: GROUPS };
  pw.stepOnce();
  const game = { clock: 0 };
  const combat = new CombatSystem({ now: () => game.clock });
  const scene = new THREE.Scene();
  const traffic = new Traffic(scene, { center: spawn, terrain, physics, combat, crowd });
  return Object.assign(game, { pw, combat, traffic, physics, scene });
}

// 測試路徑：沿出生點所在道路（河南路三段）直線 300 m——往北（主路徑，斷言）；往南（道路兩側 OSM 空地、步行路線稀少）只記錄不斷言
function spawnRoadDir() {
  const seg = { x: 0, z: 0, d2: 0, t: 0 };
  let best = null;
  for (const r of surfaceRoads) {
    if (r.name !== SPAWN_ROAD_NAME) continue;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i];
      const b = r.pts[i + 1];
      closestOnSegment(spawn.x, spawn.z, a.x, a.z, b.x, b.z, seg);
      if (!best || seg.d2 < best.d2) best = { d2: seg.d2, dx: b.x - a.x, dz: b.z - a.z };
    }
  }
  const l = Math.hypot(best.dx, best.dz) * (best.dz > 0 ? -1 : 1); // 北 = −Z
  return { x: best.dx / l, z: best.dz / l };
}
const PATH_MAIN = spawnRoadDir();
const PATH_SPARSE = { x: -PATH_MAIN.x, z: -PATH_MAIN.z };
const CAM_BACK = 7; // 鏡頭在玩家後方（m），同 camera.js 預設距離
const HALF_FOV = Math.atan(Math.tan((60 * Math.PI) / 360) * (16 / 9)); // 60° 垂直視角、16:9

function runCrowd(crowd, [lo, hi], head = PATH_MAIN, assert = true) {
  const game = buildTraffic(crowd);
  const { traffic, pw, combat } = game;
  const target = PED_TARGET[crowd];
  const spawns = [];
  const orig = traffic._spawnPed.bind(traffic);
  traffic._spawnPed = (spot) => {
    const p = orig(spot);
    if (p) spawns.push({ x: p.x, z: p.z, kind: spot.route.kind, d: Math.hypot(p.x - player.x, p.z - player.z), hidden: traffic._hidden(p.x, p.z) });
    return p;
  };
  const initial = traffic.peds.length;
  const player = { x: spawn.x, y: spawn.y, z: spawn.z };
  const counts = [];
  let farBodies = 0;
  const SPEED = 5;
  const moveFrames = Math.round(300 / SPEED / DT);
  const stillFrames = Math.round(20 / DT);
  for (let f = 1; f <= moveFrames + stillFrames; f++) {
    if (f <= moveFrames) {
      player.x += head.x * SPEED * DT;
      player.z += head.z * SPEED * DT;
    }
    traffic.setView(player.x - head.x * CAM_BACK, player.z - head.z * CAM_BACK, head.x, head.z, HALF_FOV);
    traffic.setBlockers([player]);
    traffic.setContext({ playerInVehicle: false, vehicles: [] });
    pw.step(DT);
    game.clock += DT;
    combat.update(DT);
    traffic.sync(DT, player);
    if (f % 60 === 0) {
      counts.push(traffic.peds.filter((p) => Math.hypot(p.x - player.x, p.z - player.z) <= 80).length);
      farBodies += traffic.peds.filter((p) => p.body && Math.hypot(p.x - player.x, p.z - player.z) > 121).length;
    }
  }
  const moved = counts.slice(0, Math.round(moveFrames * DT));
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
  const spotsNear = (x, z) => traffic.spotGrid.query(x - 80, z - 80, x + 80, z + 80, []).filter((sp) => Math.hypot(sp.x - x, sp.z - z) <= 80).length;
  console.log(`INFO  [${crowd}] 路徑 (${f2(head.x)}, ${f2(head.z)})：每秒 80 m 內人數：${counts.join(' ')}`);
  if (!assert) {
    console.log(`INFO  [${crowd}] 稀疏路徑（不斷言）：min ${min} / max ${max} / 平均 ${f2(avg)}；路徑中段 80 m 內生成點 ${spotsNear(spawn.x + head.x * 150, spawn.z + head.z * 150)} 個`);
    return game;
  }
  check(`[${crowd}] 開場補滿目標 ${target} 人`, initial === target, `${initial}`);
  check(`[${crowd}] 移動 300 m + 原地 20 s，每秒 80 m 內人數 ${lo}–${hi}`, min >= lo && max <= hi, `min ${min} / max ${max} / 平均 ${f2(avg)}（移動段 ${moved.length} 秒）`);
  const later = spawns.slice(0);
  const badPos = later.filter((s) => badSpot(s.x, s.z));
  check(`[${crowd}] 補生成 ${later.length} 人：位置皆不在建築 / 湖 / 車道內`, later.length > 0 && badPos.length === 0, badPos.length ? JSON.stringify(badPos[0]) : '');
  const ring = later.filter((s) => s.d >= 60 - 0.5 && s.d <= 100 + 0.5 && s.hidden); // 規格環帶 60–100 m（實作取 60–80 m）
  const dmin = Math.min(...later.map((s) => s.d));
  const dmax = Math.max(...later.map((s) => s.d));
  check(`[${crowd}] 補生成皆在 60–100 m 且視野外（視錐外或被建築遮擋）`, ring.length === later.length, `距離 ${f2(dmin)}–${f2(dmax)} m、視野外 ${later.filter((s) => s.hidden).length} / ${later.length}`);
  const kinds = {};
  for (const s of later) kinds[s.kind] = (kinds[s.kind] || 0) + 1;
  console.log(`INFO  [${crowd}] 補生成類型：${JSON.stringify(kinds)}；回收 ${traffic.stats.recycled}、池中 ${traffic.pedPool.length}`);
  check(`[${crowd}] 物件池：新建骨架 ${traffic.stats.pedCreated} ≤ 上限 ${traffic.poolMax}（生成 ${traffic.stats.spawned} 次）`, traffic.stats.pedCreated <= traffic.poolMax && traffic.stats.spawned > traffic.stats.pedCreated);
  check(`[${crowd}] 120 m 外沒有行人剛體；回收者剛體已移除`, farBodies === 0 && traffic.pedPool.every((p) => p.body === null && !p.mesh.visible));
  const variants = new Set(traffic.peds.map((p) => p.character.variant));
  const shirts = new Set();
  for (const p of traffic.peds) p.mesh.traverse((o) => o.isMesh && [].concat(o.material).forEach((m) => m.name === 'shirt' && shirts.add(m.color.getHexString())));
  check(`[${crowd}] 三種角色變體、多種服色`, variants.size === 3 && shirts.size >= 4, `variant ${[...variants].join(',')}、shirt ${shirts.size} 色`);
  return game;
}

runCrowd('high', [40, 60]);
runCrowd('low', [25, 35]);
runCrowd('high', [40, 60], PATH_SPARSE, false);

// ======================= 3. 效能：50 行人 + 10 車 =======================
{
  const game = buildTraffic('high');
  const { traffic, pw, combat } = game;
  // 車流 8 台 + 2 台同路段加開，湊 10 台
  for (let k = 0; traffic.cars.length < 10 && k < 50; k++) {
    const road = traffic.cars[k % traffic.cars.length].road;
    const s = road.length * (0.2 + 0.6 * ((k * 0.37) % 1));
    const tmp = traffic._tmp;
    const { samplePolyline } = await import('../../src/geom.js');
    samplePolyline(road, s, tmp);
    traffic._spawnCar(game.scene, game.physics, 'sedan', '#888888', road, 1, s, 1);
  }
  const player = { x: spawn.x, y: spawn.y, z: spawn.z };
  const head = PATH_MAIN;
  // 讓部分行人進入打鬥 / 逃跑（AI 較忙）
  const actor = { id: 'perf-player', kind: 'player', pos: player, yaw: 0, hp: 100, maxHp: 100, faction: 'player', anim: { state: 'idle', trigger: () => true, on: () => () => {} }, body: { knockdown() {}, settleCheck: () => ({ settled: true, clearToStand: true }), standUp() {} } };
  combat.register(actor);
  for (const [i, p] of traffic.peds.entries()) if (i % 4 === 0) traffic.brains.get(p.actor.id).onAttacked({ attacker: actor });
  const time = { mixer: 0, ai: 0, manage: 0 };
  const wrap = (obj, name, key) => {
    const fn = obj[name];
    obj[name] = function (...args) {
      const t0 = performance.now();
      const r = fn.apply(this, args);
      time[key] += performance.now() - t0;
      return r;
    };
  };
  wrap(CharacterAnimator.prototype, 'update', 'mixer');
  wrap(NpcBrain.prototype, 'update', 'ai');
  wrap(traffic, '_manageCrowd', 'manage');
  const FRAMES = 1200;
  let tStep = 0;
  let tCombat = 0;
  let tSync = 0;
  for (let f = 0; f < FRAMES; f++) {
    player.x += head.x * 3 * DT;
    player.z += head.z * 3 * DT;
    traffic.setView(player.x - head.x * CAM_BACK, player.z - head.z * CAM_BACK, head.x, head.z, HALF_FOV);
    traffic.setBlockers([player]);
    const t0 = performance.now();
    pw.step(DT);
    const t1 = performance.now();
    game.clock += DT;
    combat.update(DT);
    const t2 = performance.now();
    traffic.sync(DT, player);
    const t3 = performance.now();
    tStep += t1 - t0;
    tCombat += t2 - t1;
    tSync += t3 - t2;
  }
  // 降頻：玩家停住 30 幀，近處（< 55 m）mixer / AI 每幀、遠處（> 65 m）mixer 每 3 幀、AI 每 5 幀
  const calls = new Map();
  const countCall = (proto, name, key) => {
    const fn = proto[name];
    proto[name] = function (...args) {
      const c = calls.get(this) || { mixer: 0, ai: 0 };
      c[key]++;
      calls.set(this, c);
      return fn.apply(this, args);
    };
    return () => (proto[name] = fn);
  };
  const undo = [countCall(CharacterAnimator.prototype, 'update', 'mixer'), countCall(NpcBrain.prototype, 'update', 'ai')];
  for (let f = 0; f < 30; f++) {
    pw.step(DT);
    game.clock += DT;
    combat.update(DT);
    traffic._crowdT = -1; // 這 30 幀不跑密度管理（避免生成 / 回收改變名單）
    traffic.sync(DT, player);
  }
  undo.forEach((u) => u());
  let nearOk = true;
  let farOk = true;
  let nNear = 0;
  let nFar = 0;
  for (const p of traffic.peds) {
    const d = Math.hypot(p.x - player.x, p.z - player.z);
    const c = calls.get(p.anim) || { mixer: 0 };
    const ai = (calls.get(traffic.brains.get(p.actor.id)) || { ai: 0 }).ai;
    if (d < 55) {
      nNear++;
      if (c.mixer !== 30 || ai !== 30) nearOk = false;
    } else if (d > 65) {
      nFar++;
      if (c.mixer !== 10 || ai !== 6) farOk = false;
    }
  }
  check(`降頻：60 m 內 mixer / AI 每幀（${nNear} 人）、60 m 外 mixer 每 3 幀 / AI 每 5 幀（${nFar} 人）`, nearOk && farOk && nNear > 0 && nFar > 0);

  const per = (t) => t / FRAMES;
  const listed = per(time.mixer + time.ai + time.manage + tCombat);
  console.log(`INFO  效能（node，${traffic.peds.length} 行人 + ${traffic.cars.length} 車、${FRAMES} 幀平均）：mixer ${per(time.mixer).toFixed(3)} ms、AI ${per(time.ai).toFixed(3)} ms、combat ${per(tCombat).toFixed(3)} ms、生成管理 ${per(time.manage).toFixed(3)} ms；`
    + `traffic.sync 全部（含上列與網格擺放）${per(tSync).toFixed(3)} ms、物理子步前後的車道 / 人行道邏輯（mock 世界）${per(tStep).toFixed(3)} ms`);
  check(`效能：mixer + AI + combat + 生成管理 ≤ 1.5 ms / 幀（${traffic.peds.length} 人 + ${traffic.cars.length} 車）`, listed <= 1.5 && traffic.peds.length >= 45 && traffic.cars.length === 10, `${listed.toFixed(3)} ms`);
}

console.log(`\ncrowd.mjs：${passed} 通過 / ${failed} 失敗`);
process.exit(failed ? 1 : 0);
