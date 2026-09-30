#!/usr/bin/env node
// 行人密度 + 分層模擬無頭驗證（四檔畫質預算）：真實角色 glb + Traffic（mock RAPIER，同 combat-integration.mjs 的最小版；密度管理不依賴真物理）
// 用法：node tools/test/crowd.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：四檔（low / mid / high / ultra，core/quality.js 的 qualityBudget）玩家沿出生點道路移動 300 m（5 m/s）+ 原地 20 s，每秒記錄半徑 80 m 內人數
//   （骨架 + 替身；區間推導見 expectedNear80）；high ≥ 50、low ≥ 25（主控裁決）；生成點不在建築 / 湖 / 車道內、補生成在 spawnMin–radius 且視野外；
//   新建骨架數 ≤ poolMax；pedNear 內一律骨架；替身只在 pedFar 外；啟用中的行人剛體只在 physicsRadius（+ 遲滯）內；
//   降頻（near 每幀、mid 視野內 mixer / AI 每 3 幀、mid 視野外 mixer 凍結、替身無大腦）；
//   效能：四檔每幀 CPU（車流 + 行人 AI + mixer + 生成管理 + 分層，不含渲染與 mock 物理本體）high < 4 ms、low < 3 ms
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
const { SPAWN_ROAD_NAME } = await import('../../src/data/city.js');
const { crowdPlan } = await import('../../src/crowd.js');
const { QUALITY_IDS, qualityBudget } = await import('../../src/core/quality.js');
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


// ======================= 2. 四檔密度：移動 300 m + 原地 20 s =======================
// 畫質預算直接取 core/quality.js 的 qualityBudget（主控裁決後的最終畫質表：peds 40 / 80 / 140 / 200、cars 18 / 30 / 45 / 60；pedNear / pedFar 同契約 §3）
const TIERS = Object.fromEntries(QUALITY_IDS.map((id) => [id, qualityBudget(id)]));
check('畫質表人數 = 主控裁決 40 / 80 / 140 / 200', QUALITY_IDS.map((id) => TIERS[id].peds).join('/') === '40/80/140/200', QUALITY_IDS.map((id) => TIERS[id].peds).join('/'));
// 主控裁決的 80 m 內人數下限
const NEAR80_MIN = { low: 25, high: 50 };

// 80 m 內人數的合理區間推導：crowdPlan 在 radius（= pedFar + 20）內維持 target 人，均勻分布時 80 m 內期望 target × (80 / radius)²；
// traffic.js 另在 80 m 內維持 I = ceil(target × (80 / radius)² × 1.15) 人（CROWD_INNER_BOOST，缺人時在 physicsRadius（上限 60）–80 m 視野外補）
// → I：low 37 / mid 49 / high 61 / ultra 66。補生成每 0.1 s 最多 4 人、只補視野外，移動中會短暫低於 I；原地時過多者要等走到視野外才回收
// → 區間取 [0.8 I, 1.3 I]，下限再與主控裁決（high ≥ 50、low ≥ 25）取大
function expectedNear80(budget) {
  const plan = crowdPlan(budget);
  const E = Math.min(plan.target, Math.ceil(plan.target * (80 / plan.radius) ** 2 * 1.15));
  const lo = Math.max(Math.floor(0.8 * E), NEAR80_MIN[budget.id] || 0);
  return { E, lo, hi: Math.ceil(1.3 * E), plan };
}

function buildTraffic(budget) {
  const RAPIER = makeMockRapier();
  const pw = new PhysicsWorld(RAPIER);
  const router = createContactRouter(RAPIER, pw);
  pw.onAfterStep((dt) => router.drain(dt));
  const physics = { RAPIER, pw, router, groups: GROUPS };
  pw.stepOnce();
  const game = { clock: 0 };
  const combat = new CombatSystem({ now: () => game.clock });
  const scene = new THREE.Scene();
  const traffic = new Traffic(scene, { center: spawn, terrain, physics, combat, budget });
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
const posOf = (c) => c.ped || c;
const distOf = (c, pl) => Math.hypot(posOf(c).x - pl.x, posOf(c).z - pl.z);

function runCrowd(tier, head = PATH_MAIN, assert = true) {
  const budget = TIERS[tier];
  const { E, lo, hi, plan } = expectedNear80(budget);
  const game = buildTraffic(budget);
  const { traffic, pw, combat } = game;
  const player = { x: spawn.x, y: spawn.y, z: spawn.z };
  const spawns = [];
  const orig = traffic._spawnPed.bind(traffic);
  traffic._spawnPed = (spot) => {
    const c = orig(spot);
    if (c) spawns.push({ x: c.x, z: c.z, kind: spot.route.kind, d: Math.hypot(c.x - player.x, c.z - player.z), hidden: traffic._hidden(c.x, c.z) });
    return c;
  };
  const initial = traffic.citizens.length;
  const counts = [];
  let nearNotSkel = 0;
  let impInside = 0;
  let impPoolFull = 0; // 骨架池已滿（poolMax）時 far 內改用替身：crowd.js 設計如此，只記錄
  let activeFar = 0;
  let bodyFar = 0;
  let bothOrNone = 0;
  let maxSkel = 0;
  let maxTotal = 0; // 市民總數（骨架 + 替身）每幀最大值
  let maxShown = 0; // 顯示中的骨架 + 替身（交叉核對：替身也算人數）
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
    maxSkel = Math.max(maxSkel, traffic.peds.length);
    maxTotal = Math.max(maxTotal, traffic.citizens.length);
    maxShown = Math.max(maxShown, traffic.peds.length + traffic.impostors.count);
    if (f % 60 === 0) {
      counts.push(traffic.citizens.filter((c) => distOf(c, player) <= 80).length);
      for (const c of traffic.citizens) {
        const d = distOf(c, player);
        if (d < plan.near && c.rep !== 'skeleton') nearNotSkel++;
        if (c.rep === 'impostor' && d < plan.far - 0.5) (traffic.peds.length < plan.poolMax ? impInside++ : impPoolFull++);
        const skel = c.rep === 'skeleton' && c.ped.mesh.visible;
        const imp = traffic.impostors.isShown(c.slot);
        if (skel === imp) bothOrNone++;
      }
      for (const p of traffic.peds) {
        const d = Math.hypot(p.x - player.x, p.z - player.z);
        if (p.body.active && d > plan.physicsRadius + 15 + 2) activeFar++;
        if (d > plan.far + plan.hysteresis + 2) bodyFar++;
      }
    }
  }
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
  console.log(`INFO  [${tier}] 路徑 (${f2(head.x)}, ${f2(head.z)})：每秒 80 m 內人數：${counts.join(' ')}`);
  if (!assert) {
    console.log(`INFO  [${tier}] 稀疏路徑（不斷言）：min ${min} / max ${max} / 平均 ${f2(avg)}`);
    return game;
  }
  check(`[${tier}] 開場補滿目標 ${plan.target} 人（radius ${plan.radius} m）`, initial === plan.target, `${initial}`);
  // 實測修正：low 檔市民總數曾到 46 > budget.peds 40——總數（骨架 + 替身）每幀都 ≤ peds × 1.05
  const totalCap = Math.floor(budget.peds * 1.05 + 1e-9);
  check(`[${tier}] 市民總數（骨架 + 替身）每幀 ≤ peds × 1.05 = ${totalCap}`, maxTotal <= totalCap && maxShown <= totalCap, `總數最多 ${maxTotal}、顯示中骨架 + 替身最多 ${maxShown}`);
  check(`[${tier}] 移動 300 m + 原地 20 s，每秒 80 m 內人數 ${lo}–${hi}（I = ${E}）`, min >= lo && max <= hi && traffic.innerTarget === E, `min ${min} / max ${max} / 平均 ${f2(avg)}`);
  const badPos = spawns.filter((s) => badSpot(s.x, s.z));
  check(`[${tier}] 補生成 ${spawns.length} 人：位置皆不在建築 / 湖 / 車道內`, spawns.length > 0 && badPos.length === 0, badPos.length ? JSON.stringify(badPos[0]) : '');
  const ring = spawns.filter((s) => s.d >= traffic.innerMin - 0.5 && s.d <= plan.radius + 0.5 && s.hidden);
  check(`[${tier}] 補生成皆在 ${traffic.innerMin}–${plan.radius} m 且視野外（視錐外或被建築遮擋）`, ring.length === spawns.length, `距離 ${f2(Math.min(...spawns.map((s) => s.d)))}–${f2(Math.max(...spawns.map((s) => s.d)))} m、視野外 ${spawns.filter((s) => s.hidden).length} / ${spawns.length}`);
  const kinds = {};
  for (const s of spawns) kinds[s.kind] = (kinds[s.kind] || 0) + 1;
  console.log(`INFO  [${tier}] 補生成類型：${JSON.stringify(kinds)}；回收 ${traffic.stats.recycled}、池中 ${traffic.pedPool.length}、借骨架 ${traffic.stats.stolen}、骨架同時最多 ${maxSkel}`);
  check(`[${tier}] 骨架池：新建 ${traffic.stats.pedCreated} ≤ poolMax ${plan.poolMax}（掛骨架 ${traffic.stats.spawned} 人次以上重用）`, traffic.stats.pedCreated <= plan.poolMax && traffic.pedPool.every((p) => p.body === null && !p.mesh.visible));
  check(`[${tier}] 分層：pedNear ${plan.near} m 內一律骨架、替身只在 pedFar ${plan.far} m 外（骨架池未滿時）、骨架 / 替身每人恰好顯示一種`, nearNotSkel === 0 && impInside === 0 && bothOrNone === 0, `近處非骨架 ${nearNotSkel}、far 內替身 ${impInside}（池滿時 ${impPoolFull} 人次）、顯示衝突 ${bothOrNone}`);
  check(`[${tier}] 物理分層：啟用中的行人剛體只在 physicsRadius ${plan.physicsRadius} m（+ 遲滯 15）內、pedFar 外沒有行人剛體`, activeFar === 0 && bodyFar === 0, `超出 ${activeFar} / ${bodyFar}`);
  const variants = new Set(traffic.peds.map((p) => p.character.variant));
  const shirts = new Set();
  for (const p of traffic.peds) p.mesh.traverse((o) => o.isMesh && [].concat(o.material).forEach((m) => m.name === 'shirt' && shirts.add(m.color.getHexString())));
  check(`[${tier}] 三種角色變體、多種服色`, variants.size === 3 && shirts.size >= 4, `variant ${[...variants].join(',')}、shirt ${shirts.size} 色`);
  return game;
}

for (const tier of ['low', 'mid', 'high', 'ultra']) runCrowd(tier);
runCrowd('high', PATH_SPARSE, false);

// ======================= 3. 降頻 + 效能（四檔）=======================
const perfRows = [];
for (const tier of ['low', 'mid', 'high', 'ultra']) {
  const budget = TIERS[tier];
  const game = buildTraffic(budget);
  const { traffic, pw, combat } = game;
  const player = { x: spawn.x, y: spawn.y, z: spawn.z };
  const head = PATH_MAIN;
  // 讓近處四分之一的行人進入打鬥 / 逃跑（AI 較忙）
  const actor = { id: 'perf-player', kind: 'player', pos: player, yaw: 0, hp: 100, maxHp: 100, faction: 'player', anim: { state: 'idle', trigger: () => true, on: () => () => {} }, body: { knockdown() {}, settleCheck: () => ({ settled: true, clearToStand: true }), standUp() {} } };
  combat.register(actor);
  for (const [i, p] of traffic.peds.entries()) if (i % 4 === 0 && Math.hypot(p.x - player.x, p.z - player.z) < 40) p.brain.onAttacked({ attacker: actor });
  const time = { mixer: 0, ai: 0, manage: 0, lod: 0, lane: 0 };
  const undo = [];
  const wrap = (obj, name, key) => {
    const fn = obj[name];
    obj[name] = function (...args) {
      const t0 = performance.now();
      const r = fn.apply(this, args);
      time[key] += performance.now() - t0;
      return r;
    };
    undo.push(() => (obj[name] = fn));
  };
  wrap(CharacterAnimator.prototype, 'update', 'mixer');
  wrap(NpcBrain.prototype, 'update', 'ai');
  wrap(traffic, '_manageCrowd', 'manage');
  wrap(traffic, '_manageCars', 'manage');
  wrap(traffic, '_updateLod', 'lod');
  wrap(traffic, '_step', 'lane');
  wrap(traffic, '_afterStep', 'lane');
  const FRAMES = 1200;
  let tSync = 0;
  let tCombat = 0;
  for (let f = 0; f < FRAMES; f++) {
    player.x += head.x * 3 * DT;
    player.z += head.z * 3 * DT;
    traffic.setView(player.x - head.x * CAM_BACK, player.z - head.z * CAM_BACK, head.x, head.z, HALF_FOV);
    traffic.setBlockers([player]);
    pw.step(DT);
    game.clock += DT;
    const t1 = performance.now();
    combat.update(DT);
    const t2 = performance.now();
    traffic.sync(DT, player);
    tSync += performance.now() - t2;
    tCombat += t2 - t1;
  }
  undo.reverse().forEach((u) => u());
  const per = (t) => t / FRAMES;
  // 每幀 CPU = traffic.sync（含 mixer / AI / 生成管理 / 分層 / 網格與替身擺放 / 行人剛體休眠切換）+ 物理子步前後的車道 / 人行道邏輯 + combat
  const total = per(tSync + time.lane + tCombat);
  perfRows.push({ tier, total, time: Object.fromEntries(Object.entries(time).map(([k, v]) => [k, per(v)])), peds: traffic.citizens.length, skel: traffic.peds.length, cars: traffic.cars.length });
  console.log(`INFO  效能 [${tier}]（node，市民 ${traffic.citizens.length}（骨架 ${traffic.peds.length}）+ 車 ${traffic.cars.length}、${FRAMES} 幀平均）：每幀 ${total.toFixed(3)} ms = sync ${per(tSync).toFixed(3)}`
    + `（mixer ${per(time.mixer).toFixed(3)}、AI ${per(time.ai).toFixed(3)}、生成管理 ${per(time.manage).toFixed(3)}、分層 ${per(time.lod).toFixed(3)}）+ 車道 / 人行道子步 ${per(time.lane).toFixed(3)} + combat ${per(tCombat).toFixed(3)}`);
  if (tier === 'high' || tier === 'low') {
    const lim = tier === 'high' ? 4 : 3;
    check(`效能 [${tier}]：每幀 CPU < ${lim} ms（市民 ${traffic.citizens.length} + 車 ${traffic.cars.length}）`, total < lim && traffic.cars.length === budget.cars, `${total.toFixed(3)} ms`);
  }

  if (tier !== 'high') continue;
  // 降頻：玩家停住 30 幀（不跑密度管理）：near 每幀；mid 視野內 mixer / AI 每 3 幀；mid 視野外 mixer 凍結、AI 每 3 幀；替身沒有大腦
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
  const undo2 = [countCall(CharacterAnimator.prototype, 'update', 'mixer'), countCall(NpcBrain.prototype, 'update', 'ai')];
  for (let f = 0; f < 30; f++) {
    pw.step(DT);
    game.clock += DT;
    combat.update(DT);
    traffic._crowdT = -1; // 這 30 幀不跑密度管理（避免生成 / 回收改變名單）
    traffic.sync(DT, player);
  }
  undo2.forEach((u) => u());
  const plan = traffic.plan;
  const stat = { near: [0, 0], midIn: [0, 0], midOut: [0, 0], imp: [0, 0] };
  for (const c of traffic.citizens) {
    const p = c.ped;
    if (!p) {
      stat.imp[0]++;
      continue;
    }
    const cm = calls.get(p.anim) || { mixer: 0 };
    const ai = (calls.get(p.brain) || { ai: 0 }).ai;
    const lv = c.level === 'near' ? 'near' : c.inView ? 'midIn' : 'midOut';
    if (c.dist > plan.near - 5 && c.dist < plan.near + plan.hysteresis + 5) continue; // 邊界附近遲滯中，不判
    if (traffic._forceNear(p)) continue;
    stat[lv][0]++;
    const want = lv === 'near' ? [30, 30] : lv === 'midIn' ? [10, 10] : [0, 10];
    if (cm.mixer !== want[0] || ai !== want[1]) stat[lv][1]++;
  }
  check(`降頻 [high]：near 每幀（${stat.near[0]} 人）、mid 視野內 mixer / AI 每 3 幀（${stat.midIn[0]} 人）、mid 視野外 mixer 凍結（${stat.midOut[0]} 人）、替身 ${stat.imp[0]} 人無大腦`,
    stat.near[0] > 0 && stat.midIn[0] + stat.midOut[0] > 0 && stat.near[1] + stat.midIn[1] + stat.midOut[1] === 0 && traffic.brains.size === traffic.peds.length,
    `不符 near ${stat.near[1]} / midIn ${stat.midIn[1]} / midOut ${stat.midOut[1]}`);
}
console.log(`INFO  四檔每幀 CPU：${perfRows.map((r) => `${r.tier} ${r.total.toFixed(3)} ms`).join('、')}`);

console.log(`\ncrowd.mjs：${passed} 通過 / ${failed} 失敗`);
console.log(failed ? `FAIL ${failed}/${passed + failed}` : `PASS ${passed}/${passed}`);
process.exit(failed ? 1 : 0);
