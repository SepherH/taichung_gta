#!/usr/bin/env node
// I3 角色與對抗整合無頭驗證：真實 glb 角色 / 車輛 + CharacterAnimator + CombatSystem + NpcBrain，以遊戲本體的
// Player / VehicleManager / Vehicle / Traffic 接線（同 main.js 的 stepWorld：pw.step → combat.update → 同步）跑
// 用法：
//   node tools/test/combat-integration.mjs             完整版（真的 import rapier；需要 dist/rapier.mjs）：世界碰撞體 + 真物理，
//                                                       另加「車以 30 km/h 實際撞上行人 → knockdown」
//   node tools/test/combat-integration.mjs --no-rapier 以 mock RAPIER 跑同一套接線（不模擬真物理：車撞行人以碰撞開始事件注入）
// 項目：vehicle-model 六種真 glb（含垃圾車）（節點 / 輪數 / spec 取自 manifest / 輪子同步）、玩家出拳命中一次扣血 → 行人 hit / fight / flee、
//   連 3 拳 knockdown → settle → getup → 回 wander、NPC 還手扣玩家血、車撞行人 knockdown、擊退不穿牆、上車 enter_car → drive、
//   玩家在車內不受拳擊、效能（30 行人 + 10 車的 mixer + AI 每幀 CPU 時間）
// exit code：0 = 全過；1 = 有斷言失敗；2 = 完整版找不到 rapier
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
// GLTFLoader 解析內嵌貼圖的 glb（例：垃圾車 decal）會用到 self（瀏覽器全域 self.URL）；node 端只在「車輛模型載入期間」補上（見下方 withSelf），
// 不可設成檔頭全域：角色 hero.glb 也有內嵌貼圖，無 self 時在 node 解析失敗（本測試預期 3 種行人 variant、主角退回行人模型），
// 有 self 時 hero 變成載入成功 → variant 4 種、玩家改用 hero 骨架（Hips 高不同）→「三種 variant」與「駕駛中座位點」兩項斷言失敗
async function withSelf(fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'self');
  const prev = globalThis.self;
  if (!had) globalThis.self = globalThis;
  try {
    return await fn();
  } finally {
    if (!had) delete globalThis.self;
    else globalThis.self = prev;
  }
}

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
const { default: osm } = await import('../../src/data/osm-city.json');
const { getTerrain, surfaceFootways, buildingAt } = await import('../../src/citymodel.js');
const { samplePolyline } = await import('../../src/geom.js');
const { computeSpawn, computeParkedVehicles } = await import('../../src/places.js');
const { Player, nearestFootway, nearestRoadEdge, mousePunchListener } = await import('../../src/player.js');
const { Vehicle, VehicleManager, VEHICLE_TYPES, wheelMeshMap } = await import('../../src/vehicle.js');
const { Traffic } = await import('../../src/traffic.js');
const { loadCharacterModels, createCharacter, getCharacterManifest, CharacterAnimator } = await import('../../src/characters/index.js');
const { loadVehicleModels, createVehicleModel, SEAT_HIPS_HEIGHT } = await import('../../src/vehicle-model.js');
const { CombatSystem, PUNCH_DAMAGE, ASSIST_TURN_SEC, HIT_RADIUS } = await import('../../src/combat.js');
const { angleDelta } = await import('../../src/utils.js');
const { NpcBrain, wireCombatToBrains, FIGHT_CHANCE, FIGHT_CHANCE_HEAVY } = await import('../../src/npc-ai.js');
const { CITY_SEED } = await import('../../src/data/city.js');
const { PhysicsWorld, initPhysics } = await import('../../src/physics/world.js');
const { GROUPS } = await import('../../src/physics/groups.js');
const { CharacterBody } = await import('../../src/physics/character.js');
const { createContactRouter } = await import('../../src/physics/contacts.js');
const { setActiveByDistance, ACTIVE_RADIUS } = await import('../../src/physics/npc-bodies.js');
const { deriveVehicleSpec, chassisLayout } = await import('../../src/physics/vehicle-body.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLIC = path.join(ROOT, 'public');
const NO_RAPIER = process.argv.includes('--no-rapier');
const DT = 1 / 60;
const KMH30 = 30 / 3.6;

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : String(v));

// 以 fs 模擬 fetch：URL 相對 public/（Vite base './'）
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
const vehTable = await withSelf(() => loadVehicleModels('./models/vehicles/manifest.json', { fetch: fsFetch }));
// 工作區（外包環境）可能連 vehicles/manifest.json 都沒有：視為空表（車輛 glb 檢查 SKIP，車輛走程式建模退路）
const vManifestFile = path.join(PUBLIC, 'models/vehicles/manifest.json');
const vManifest = fs.existsSync(vManifestFile) ? JSON.parse(fs.readFileSync(vManifestFile, 'utf8')) : { vehicles: [] };
check('角色 glb 三種 variant 載入（非方塊人）', chars.variants.length === 3 && !chars.fallback, chars.variants.join(','));

const terrain = getTerrain();
const scene = new THREE.Scene();
const spawn = computeSpawn();
const parked = computeParkedVehicles(spawn);
const q = {};

// ======================= 1. vehicle-model：真 glb 六種車（含垃圾車）=======================
// 工作區（外包環境）只有 vehicles/manifest.json、沒有車輛 glb：此段標 SKIP 不計入（宿主有 glb 時照常檢查）
const vehGlbPresent = vManifest.vehicles.length > 0 && vManifest.vehicles.every((e) => fs.existsSync(path.join(PUBLIC, 'models/vehicles', e.file)));
if (!vehGlbPresent) console.log('SKIP  vehicle-model 真 glb 檢查（工作區缺 public/models/vehicles/*.glb）');
else {
  const want = { sedan: 4, taxi: 4, suv: 4, bus: 4, scooter: 2, garbage_truck: 4 };
  let nodesOk = true;
  let specOk = true;
  const det = [];
  for (const e of vManifest.vehicles) {
    const m = createVehicleModel(e.id, null);
    if (!m) {
      nodesOk = false;
      det.push(`${e.id}:null`);
      continue;
    }
    const names = Object.keys(e.wheels);
    const nodes = names.map((n) => m.root.getObjectByName(n));
    const wheelsOk = m.root.userData.wheels.length === want[e.id] && nodes.every(Boolean) && !!m.root.getObjectByName('body');
    const fronts = m.root.userData.frontWheels.length === (e.id === 'scooter' ? 1 : 2);
    let paint = null;
    m.root.traverse((o) => {
      if (o.isMesh) for (const x of [].concat(o.material)) if (x.name === 'paint') paint = x;
    });
    const paintOk = paint && paint.color.getHexString() === new THREE.Color(e.paint).getHexString();
    const posOk = names.every((n, i) => nodes[i].position.distanceTo(new THREE.Vector3(...e.wheels[n])) < 1e-3);
    if (!wheelsOk || !fronts || !paintOk || !posOk) nodesOk = false;
    const s = m.spec;
    const sOk = ['length', 'width', 'height', 'wheelbase', 'wheelRadius', 'mass'].every((k) => s[k] === e[k]) &&
      s.track === e.track && s.seat.x === e.seat[0] && s.seat.y === e.seat[1] && s.seat.z === e.seat[2] && s.twoWheeler === (e.id === 'scooter');
    if (!sOk) specOk = false;
    det.push(`${e.id}:${m.root.userData.wheels.length}輪/${e.mass}kg`);
  }
  check(`vehicle-model：manifest 全部 ${vManifest.vehicles.length} 種車 glb 節點 body + 輪子節點 / 輪數 / 前輪數 / 輪位 / paint 預設色與 manifest 一致`, nodesOk && vehTable.size === vManifest.vehicles.length && vehTable.size === Object.keys(want).length, det.join(' '));
  check('vehicle-model：spec（長寬高 / 軸距 / 輪距 / 輪徑 / 質量 / 座位點）取自 manifest', specOk);
  const red = createVehicleModel('sedan', '#ff0000');
  let redPaint = null;
  red.root.traverse((o) => o.isMesh && [].concat(o.material).forEach((x) => x.name === 'paint' && (redPaint = x)));
  check('vehicle-model：呼叫端車色覆寫 paint、公車門在 −X 側', redPaint.color.getHexString() === 'ff0000' && createVehicleModel('bus').spec.doorSide === -1 && red.spec.doorSide === 1);

  // Vehicle：glb spec 回灌 VehicleBody（質量 / 軸距 / 輪距 / 輪徑），手感欄位保留 VEHICLE_TYPES
  let backOk = true;
  let mapOk = true;
  for (const type of Object.keys(VEHICLE_TYPES)) {
    const v = new Vehicle(scene, type, null, 0, 0, 0);
    const e = vManifest.vehicles.find((x) => x.id === type);
    const spec = deriveVehicleSpec({ type, ...v.spec });
    if (spec.mass !== e.mass || spec.wheelbase !== e.wheelbase || spec.wheelRadius !== e.wheelRadius || spec.maxSpeed !== VEHICLE_TYPES[type].maxSpeed || !v.mesh.userData.glb) backOk = false;
    const layout = chassisLayout(spec);
    const map = wheelMeshMap(v.wheelRig.map((r) => r.holder.position), layout.wheels);
    if (new Set(map).size !== map.length || map.some((i) => i < 0)) mapOk = false;
    scene.remove(v.mesh);
  }
  check('Vehicle：glb spec 回灌 VehicleBody（mass / wheelbase / wheelRadius 取 manifest、maxSpeed 保留手感值）', backOk);
  check('Vehicle：glb 輪子節點 ↔ VehicleBody 輪序一一對應', mapOk);

  // 輪子同步：以假 VehicleBody 的 getState 驅動 glb 輪子節點轉動 / 轉向 / 懸吊
  const v = new Vehicle(scene, 'sedan', '#ffffff', 0, 0, 0);
  const vb = { layout: chassisLayout(deriveVehicleSpec({ type: 'sedan', ...v.spec })), susp: { restLength: 0.3 }, kinematic: false, forwardSpeed: () => 5 };
  vb.getState = () => ({ wheels: vb.layout.wheels.map((w) => ({ rotation: 1.25, steer: w.front ? 0.3 : 0, suspensionLength: 0.2 })) });
  const interp = { interpolate: () => ({ x: 0, y: vb.layout.centerY, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 }) };
  v.attachBody(vb, interp);
  v.syncBody(0);
  const fl = v.mesh.getObjectByName('wheel_fl');
  const rr = v.mesh.getObjectByName('wheel_rr');
  const wantY = vb.layout.wheels[0].y - 0.2 + vb.layout.centerY;
  check('Vehicle：glb 輪子依 getState 滾動 / 前輪轉向 / 懸吊高度', fl.rotation.x === 1.25 && fl.rotation.y === 0.3 && rr.rotation.y === 0 && Math.abs(fl.position.y - wantY) < 1e-9, `fl y ${f2(fl.position.y)}`);
  scene.remove(v.mesh);
}

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

// ======================= 遊戲接線（同 main.js 載入段 + stepWorld）=======================
async function buildGame(RAPIER, withColliders) {
  const pw = new PhysicsWorld(RAPIER);
  if (withColliders) {
    const { buildWorldColliders, osmWithBuildings } = await import('../../src/physics/colliders.js');
    const { buildBuildings } = await import('../../src/buildings.js');
    const { buildQiuhonggu } = await import('../../src/qiuhonggu.js');
    buildQiuhonggu(terrain, { footways: surfaceFootways });
    const blds = buildBuildings(new THREE.Scene(), { anisotropy: 1 });
    buildWorldColliders(RAPIER, pw.world, { osm: osmWithBuildings(osm, blds.colliders), terrain });
  }
  const router = createContactRouter(RAPIER, pw);
  pw.onAfterStep((dt) => router.drain(dt));
  const physics = { RAPIER, pw, router, groups: GROUPS };
  pw.stepOnce();
  const game = { pw, router, clock: 0, driving: null, hits: [], knockdowns: [] };
  const combat = new CombatSystem({ now: () => game.clock });
  const vehicles = new VehicleManager(scene, parked, terrain, physics);
  const traffic = new Traffic(scene, { center: spawn, terrain, physics, combat });
  const player = new Player(scene, spawn);
  const character = new CharacterBody(RAPIER, pw, { x: spawn.x, y: spawn.y, z: spawn.z });
  player.attachPhysics(character);
  player.attachCombat(combat);
  player.placeAt(spawn.x, spawn.z, spawn.yaw, terrain);
  combat.on('hit', (e) => game.hits.push(e));
  combat.on('knockdown', (e) => game.knockdowns.push(e));
  Object.assign(game, { combat, vehicles, traffic, player, character });
  const blockers = [];
  const entities = [];
  game.step = (dt = DT) => {
    blockers.length = 0;
    blockers.push(game.driving ? game.driving.pos : player.pos);
    for (const v of vehicles.vehicles) blockers.push(v.pos);
    traffic.setBlockers(blockers);
    traffic.setContext({ playerInVehicle: !!game.driving, vehicles: [] });
    pw.step(dt);
    game.clock += dt;
    combat.update(dt);
    if (!game.driving) player.syncPhysics(dt);
    vehicles.sync();
    traffic.sync(dt, player.pos);
    entities.length = 0;
    const c = game.driving ? game.driving.pos : player.pos;
    setActiveByDistance(traffic.bodies(vehicles.bodies(entities)), c.x, c.z, ACTIVE_RADIUS);
  };
  return game;
}

function mockInput() {
  const keys = new Set();
  const pressed = new Set();
  return {
    keys,
    pressed,
    down: (c) => keys.has(c),
    wasPressed: (c) => pressed.has(c),
    moveAxis() {
      const x = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
      const y = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
      const l = Math.hypot(x, y);
      return l > 1 ? { x: x / l, y: y / l, mag: 1, analog: false } : { x, y, mag: l, analog: false };
    },
  };
}

// 把玩家放在行人面前 dist 公尺、面向行人（行人 yaw 前方）
function faceOff(game, ped, dist) {
  const fx = Math.sin(ped.yaw);
  const fz = Math.cos(ped.yaw);
  const x = ped.x + fx * dist;
  const z = ped.z + fz * dist;
  game.player.placeAt(x, z, Math.atan2(ped.x - x, ped.z - z), terrain);
}

async function runScenarios(RAPIER, label, real) {
  const game = await buildGame(RAPIER, real);
  const { player, traffic, combat } = game;
  const input = mockInput();
  const frame = (each) => {
    player.update(DT, input, 0);
    game.step();
    if (each) each();
  };
  const brainOf = (p) => traffic.brains.get(p.actor.id);
  const nearest = (list) => list.reduce((a, b) => (Math.hypot(b.x - player.pos.x, b.z - player.pos.z) < Math.hypot(a.x - player.pos.x, a.z - player.pos.z) ? b : a));
  const peds = traffic.peds;
  check(`[${label}] 行人使用骨架角色（非方塊人）、三種 variant 皆出現、每人一個 animator / brain / combat 註冊`,
    peds.every((p) => !p.character.fallback && p.anim && traffic.brains.has(p.actor.id) && combat.stateOf(p.actor) === 'normal') &&
      new Set(peds.map((p) => p.character.variant)).size === 3 && !player.character.fallback,
    `${peds.length} 人：${[...new Set(peds.map((p) => p.character.variant))].join(',')}`);
  const buses = traffic.cars.filter((c) => c.v.type === 'bus');
  check(`[${label}] 公車加入車流（≤ 2 台、只在主幹道 primary / secondary）`, buses.length >= 1 && buses.length <= 2 && buses.every((c) => c.road.type === 'primary' || c.road.type === 'secondary'), `${buses.length} 台 / 共 ${traffic.cars.length} 台：${buses.map((c) => c.road.name).join('、')}`);

  // ---- A. 出拳命中一次扣血 → 行人 hit / fight / flee ----
  for (let i = 0; i < 30; i++) frame();
  const victim = nearest(peds.filter((p) => !brainOf(p).fights));
  faceOff(game, victim, 0.8);
  game.hits.length = 0;
  const hp0 = victim.actor.hp;
  const accepted = player.punch();
  let sawHitAnim = false;
  for (let i = 0; i < 40; i++) frame(() => { if (victim.anim.state === 'hit') sawHitAnim = true; });
  const hitsOnVictim = game.hits.filter((h) => h.target === victim.actor).length;
  check(`[${label}] 玩家對面前行人出拳 → 命中一次、扣 ${PUNCH_DAMAGE}、行人播 hit`, accepted && hitsOnVictim === 1 && victim.actor.hp === hp0 - PUNCH_DAMAGE && sawHitAnim, `命中 ${hitsOnVictim} 次、hp ${hp0} → ${victim.actor.hp}`);
  const mode = brainOf(victim).state;
  check(`[${label}] 被打的行人進入 flee（或 fight），ped.state = react`, (mode === 'flee' || mode === 'fight') && victim.state === 'react', `brain ${mode}、ped ${victim.state}`);
  // 大腦意圖確實套用到行人移動與朝向：再跑 1 秒，逃跑者離玩家更遠、面向跑的方向
  const dBefore = Math.hypot(victim.x - player.pos.x, victim.z - player.pos.z);
  const vx0 = victim.x;
  const vz0 = victim.z;
  for (let i = 0; i < 60; i++) frame();
  const dAfter = Math.hypot(victim.x - player.pos.x, victim.z - player.pos.z);
  const runYaw = Math.atan2(victim.x - vx0, victim.z - vz0);
  const faceErr = Math.abs(angleDelta(victim.yaw, runYaw));
  check(`[${label}] NpcBrain 每幀呼叫、意圖套用到移動與朝向：${mode === 'flee' ? '逃跑者遠離' : '還手者逼近'}玩家`,
    mode === 'flee' ? dAfter > dBefore + 2 && faceErr < 0.5 : dAfter <= dBefore, `距離 ${f2(dBefore)} → ${f2(dAfter)} m、朝向誤差 ${f2(faceErr)} rad`);
  const witnesses = peds.filter((p) => p !== victim && brainOf(p).state === 'flee').length;
  check(`[${label}] 同一拳只計一次（命中窗期間持續重疊不重複計傷）`, hitsOnVictim === 1, `目擊逃跑 ${witnesses} 人`);

  // ---- B. 連 3 拳 → knockdown；對手還手扣玩家血 ----
  const fighter = nearest(peds.filter((p) => brainOf(p).fights && p !== victim));
  faceOff(game, fighter, 0.8);
  player.actor.hp = player.actor.maxHp;
  let playerHitBy = 0;
  let playerHitAnim = false;
  const offHit = combat.on('hit', (e) => e.target === player.actor && e.attacker === fighter.actor && playerHitBy++);
  let punches = 0;
  let downed = false;
  for (let i = 0; i < 60 * 10 && !downed; i++) {
    // 測試扮演玩家瞄準：每幀面向對手（出拳由 combat 判斷冷卻 / 硬直）
    player.yaw = Math.atan2(fighter.x - player.pos.x, fighter.z - player.pos.z);
    if (Math.hypot(fighter.x - player.pos.x, fighter.z - player.pos.z) > 0.9) faceOff(game, fighter, 0.8);
    if (player.punch()) punches++;
    frame();
    if (playerHitBy && player.anim.state === 'hit') playerHitAnim = true;
    downed = combat.stateOf(fighter.actor) === 'knockdown';
  }
  offHit();
  const fighterHits = game.hits.filter((h) => h.target === fighter.actor).length;
  check(`[${label}] 還手的行人被連打 → knockdown（剛體切 dynamic、倒地動畫）`, downed && fighter.state === 'down' && fighter.body.isDown && fighter.anim.state === 'knockdown', `出拳 ${punches}、命中 ${fighterHits}、hp ${fighter.actor.hp}`);
  check(`[${label}] NPC 還手打到玩家扣血`, playerHitBy >= 1 && player.actor.hp < player.actor.maxHp, `被打 ${playerHitBy} 次、玩家 hp ${player.actor.hp}`);
  check(`[${label}] 玩家被 NPC 打中播 hit 動畫`, playerHitAnim);
  // 倒地 → 落穩 → 起身 → 回 wander（玩家走遠讓對方不再逃）
  let getup = false;
  let settledOk = false;
  let wander = false;
  let downSec = null;
  const downAt = game.clock;
  player.placeAt(player.pos.x + 60, player.pos.z, 0, terrain);
  for (let i = 0; i < 60 * 25 && !wander; i++) {
    frame();
    if (fighter.settle.settled) settledOk = true;
    if (fighter.anim.state === 'getup' && !getup) downSec = game.clock - downAt;
    if (fighter.anim.state === 'getup') getup = true;
    wander = getup && brainOf(fighter).state === 'wander' && (fighter.state === 'return' || fighter.state === 'walk');
  }
  check(`[${label}] 拳擊 knockdown → ${f2(downSec)} s 後起身（1.5–3 s）`, downSec !== null && downSec >= 1.5 - 1e-9 && downSec <= 3);
  check(`[${label}] knockdown → settle → getup（standUp 回 kinematic）→ 回 wander 走回人行道`, settledOk && getup && wander && !fighter.body.isDown && combat.stateOf(fighter.actor) === 'normal', `settled=${settledOk} getup=${getup} wander=${wander} state=${fighter.state}`);

  // ---- C. 擊退不穿牆：行人貼著建築、往建築方向擊退 ----
  {
    const p = peds.find((x) => x !== fighter && x !== victim);
    let placed = false;
    for (let a = 0; a < 64 && !placed; a++) {
      const ang = (a / 64) * Math.PI * 2;
      for (let d = 1; d < 80 && !placed; d += 0.5) {
        const x = p.x + Math.cos(ang) * d;
        const z = p.z + Math.sin(ang) * d;
        if (buildingAt(x, z, 0)) {
          // 退回牆外 0.6 m，往牆的方向擊退 3 m（遠大於 KNOCKBACK_DIST）
          p.x = x - Math.cos(ang) * 0.6;
          p.z = z - Math.sin(ang) * 0.6;
          if (buildingAt(p.x, p.z, 0.3)) continue;
          p.state = 'react';
          p.intent.moveX = 0;
          p.intent.moveZ = 0;
          p.kbx = Math.cos(ang) * 3 * 12;
          p.kbz = Math.sin(ang) * 3 * 12;
          placed = true;
        }
      }
    }
    let inside = false;
    for (let i = 0; i < 30; i++) {
      traffic._updatePed(p, DT);
      if (buildingAt(p.x, p.z, 0)) inside = true;
    }
    check(`[${label}] 擊退位移不穿牆（2D 建築檢查滑動 / 停住）`, placed && !inside);
  }

  // ---- D. 車撞行人（30 km/h）→ knockdown ----
  {
    const car = game.vehicles.vehicles[1];
    // 真物理接近路線：從車道側（行人路線偏移 off 的反方向）車頭距行人 3 m、橫越路緣朝行人衝過去
    const approach = (p) => {
      const tg = { x: 0, z: 0, dx: 0, dz: 1 };
      samplePolyline(p.road, p.s, tg);
      const side = Math.sign(p.off) || 1;
      const fx = -tg.dz * side; // 道路右側單位向量 (−dz, dx) × off 的正負 = 由道路中心指向行人
      const fz = tg.dx * side;
      const back = car.spec.length / 2 + 3;
      return { fx, fz, back, cx: p.x - fx * back, cz: p.z - fz * back };
    };
    // 路線上（車身起點 → 行人）不得有其他車（路邊停車 / 車流）或建築，否則車先撞上別的東西停下、永遠碰不到行人
    const others = [...game.vehicles.vehicles.filter((v) => v !== car).map((v) => v.pos), ...traffic.cars.map((c) => c.v.pos)];
    const clear = (p) => {
      const a = approach(p);
      for (let d = -car.spec.length / 2; d <= a.back; d += 0.5) {
        const x = a.cx + a.fx * d;
        const z = a.cz + a.fz * d;
        if (buildingAt(x, z, 0.5) || others.some((o) => Math.hypot(o.x - x, o.z - z) < 3.5)) return false;
      }
      return true;
    };
    const cands = peds.filter((p) => p !== fighter && p.state === 'walk' && !p.body.isDown);
    const ped = real ? nearest(cands.filter(clear)) : nearest(cands);
    game.knockdowns.length = 0;
    if (!real) {
      // mock：碰撞開始事件注入（相對速度 30 km/h）
      car.body.body.setLinvel({ x: KMH30, y: 0, z: 0 }, true);
      game.pw.eventQueue.collisions.push([car.body.collider.handle, ped.body.collider.handle, true]);
      game.step();
      car.body.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    } else {
      // 真物理：沿 approach 路線以 30 km/h 衝向行人（油門維持車速）
      const { fx, fz, cx, cz } = approach(ped);
      const dirYaw = Math.atan2(fx, fz);
      const y = terrain.querySurface(cx, cz, Infinity, q).y;
      game.vehicles.drive(car, true);
      const b = car.body.body;
      b.setTranslation({ x: cx, y: y + car.body.layout.centerY + 0.05, z: cz }, true);
      b.setRotation({ x: 0, y: Math.sin(dirYaw / 2), z: 0, w: Math.cos(dirYaw / 2) }, true);
      b.setLinvel({ x: fx * KMH30, y: 0, z: fz * KMH30 }, true);
      car.interp.reset();
      car.setControls({ throttle: 1 });
      game.driving = car;
      for (let i = 0; i < 90 && !game.knockdowns.some((k) => k.target === ped.actor); i++) game.step();
      car.setControls({ handbrake: true });
      game.driving = null;
      game.vehicles.drive(car, false);
    }
    const kd = game.knockdowns.find((k) => k.target === ped.actor);
    check(`[${label}] 車以 30 km/h 撞行人 → combat.onVehicleHit → knockdown（${real ? '真物理接觸' : '碰撞事件注入'}）`, !!kd && kd.cause === 'vehicle' && ped.state === 'down' && ped.body.isDown, kd ? `relSpeed ${f2(kd.relSpeed)} m/s、傷害 ${kd.damage}` : '未倒地');
  }

  // ---- E. 上車 enter_car → drive（輸入鎖定）→ 下車 ----
  {
    const car = game.vehicles.vehicles[0];
    const side = car.spec.width / 2 + 0.9;
    const lx = car.pos.x + Math.cos(car.yaw) * side;
    const lz = car.pos.z - Math.sin(car.yaw) * side;
    player.placeAt(lx, lz, Math.atan2(car.pos.x - lx, car.pos.z - lz), terrain);
    for (let i = 0; i < 20; i++) frame();
    const accepted = player.anim.trigger('enter_car');
    player.locked = true;
    input.keys.add('KeyW');
    const start = player.pos.clone();
    let frames = 0;
    while (player.anim.state === 'enter_car' && frames < 200) {
      frame();
      frames++;
    }
    input.keys.delete('KeyW');
    const moved = player.pos.distanceTo(start);
    const inDrive = player.anim.state === 'drive';
    // main.js enterVehicle 的同一組動作
    game.vehicles.drive(car, true);
    player.enterVehicle();
    player.locked = false;
    player.actor.untargetable = true;
    game.driving = car;
    for (let i = 0; i < 60; i++) {
      game.step();
      player.sitOn(car, DT);
    }
    const seat = car.spec.seat;
    const local = car.mesh.worldToLocal(player.mesh.position.clone());
    const seatOk = Math.abs(local.x - seat.x) < 1e-6 && Math.abs(local.y - (seat.y - SEAT_HIPS_HEIGHT)) < 1e-6 && Math.abs(local.z - seat.z) < 1e-6;
    check(`[${label}] 上車：trigger enter_car → 播完（${f2(frames * DT)} s）進 drive；期間按 W 不移動`, accepted && inDrive && moved < 0.05 && Math.abs(frames * DT - 1.3333) < 0.05, `位移 ${f2(moved)} m`);
    check(`[${label}] 駕駛中：anim 停在 drive、膠囊停用、角色原點 = manifest 座位點 − Hips 高`, player.anim.state === 'drive' && !game.character.enabled && seatOk, `local (${f2(local.x)}, ${f2(local.y)}, ${f2(local.z)})`);
    // 車內不受拳擊：行人站在旁邊出拳
    const puncher = peds.find((p) => !p.body.isDown);
    const hpIn = player.actor.hp;
    puncher.actor.pos.x = player.pos.x;
    puncher.actor.pos.z = player.pos.z - 0.5;
    puncher.actor.pos.y = player.pos.y;
    puncher.actor.yaw = 0;
    combat.requestPunch(puncher.actor);
    for (let i = 0; i < 30; i++) puncher.anim.update(DT, {}), game.clock += DT, combat.update(DT);
    check(`[${label}] 玩家在車內：untargetable，行人拳擊不扣血`, player.actor.hp === hpIn, `hp ${hpIn} → ${player.actor.hp}`);
    const exited = player.exitVehicle(car);
    game.vehicles.drive(car, false);
    game.driving = null;
    player.actor.untargetable = false;
    for (let i = 0; i < 30; i++) frame();
    check(`[${label}] 下車：站到車旁、動畫離開 drive 回移動狀態`, exited && game.character.enabled && ['idle', 'walk', 'run'].includes(player.anim.state), player.anim.state);
  }

  // ---- F. 玩家在出生點 hp 歸零 → 倒地 → recoverAfterKnockout 就近起身 → revive（同 main.js updateKnockout）----
  {
    player.placeAt(spawn.x, spawn.z, spawn.yaw, terrain);
    for (let i = 0; i < 10; i++) frame();
    const attacker = peds.find((p) => !p.body.isDown);
    player.actor.hp = PUNCH_DAMAGE;
    attacker.actor.pos.x = player.pos.x;
    attacker.actor.pos.z = player.pos.z - 0.6;
    attacker.actor.pos.y = player.pos.y;
    attacker.actor.yaw = 0;
    const ok = combat.requestPunch(attacker.actor);
    // 只推進攻擊者動畫與 combat（不跑 traffic.sync，避免行人位置覆寫測試擺放的 actor.pos）
    for (let i = 0; i < 30; i++) attacker.anim.update(DT, {}), game.clock += DT, combat.update(DT);
    const down = combat.stateOf(player.actor) === 'knockdown' && player.anim.state === 'knockdown';
    input.keys.add('KeyW');
    const p0 = player.pos.clone();
    for (let i = 0; i < 30; i++) frame();
    const lockedMove = player.pos.distanceTo(p0);
    input.keys.delete('KeyW');
    const downAt = player.pos.clone();
    const oldSpot = nearestFootway(downAt.x, downAt.z);
    const source = player.recoverAfterKnockout(terrain);
    const moved = Math.hypot(player.pos.x - downAt.x, player.pos.z - downAt.z);
    check(`[${label}] 出生點 KO → 起身位置距倒地點 ≤ 3 m（原地找空位）`, source === 'local' && moved <= 3, `來源 ${source}、距倒地點 ${f2(moved)} m（舊版最近步道 ${f2(oldSpot ? Math.sqrt(oldSpot.d2) : NaN)} m）`);
    const edge = nearestRoadEdge(downAt.x, downAt.z, 30);
    check(`[${label}] 出生點 30 m 內有道路邊備援起身點`, !!edge, edge ? `距 ${f2(Math.hypot(edge.x - downAt.x, edge.z - downAt.z))} m` : 'null');
    combat.revive(player.actor);
    let up = false;
    for (let i = 0; i < 240 && !up; i++) {
      frame();
      up = combat.stateOf(player.actor) === 'normal';
    }
    check(`[${label}] 玩家 hp 0 → knockdown（倒地期間鎖移動）→ revive → getup 回 normal、hp 回滿`, ok && down && lockedMove < 0.05 && up && player.actor.hp === player.actor.maxHp, `倒地位移 ${f2(lockedMove)} m、hp ${player.actor.hp}`);
  }
  // ---- G. 滑鼠左鍵：未鎖定 pointer 時點畫面也出拳（main.js 用的同一個監聽器）----
  {
    player.placeAt(spawn.x, spawn.z, spawn.yaw, terrain);
    combat.revive(player.actor);
    for (let i = 0; i < 240 && combat.stateOf(player.actor) !== 'normal'; i++) frame();
    for (let i = 0; i < 60; i++) frame();
    const listeners = [];
    const dom = { addEventListener: (type, cb) => type === 'mousedown' && listeners.push(cb) };
    const consume = mousePunchListener(dom, { enabled: true });
    globalThis.document.pointerLockElement = null; // 未鎖定
    for (const cb of listeners) cb({ button: 2 });
    const right = consume();
    for (const cb of listeners) cb({ button: 0 });
    const left = consume();
    const again = consume();
    const accepted = left && player.punch();
    const st = player.anim.state;
    for (let i = 0; i < 60; i++) frame();
    check(`[${label}] 未鎖定 pointer：左鍵點擊 → 出拳（右鍵不算、讀一次即清除）`, !right && left && !again && accepted && st === 'punch', `left=${left} punch=${accepted} anim=${st}`);
  }

  // ---- H. 輔助瞄準：2.0 m、偏 70° 的行人 → 0.15 s 內轉向面對、小衝步後命中 ----
  {
    const tgt = nearest(peds.filter((p) => p.state === 'walk' && combat.stateOf(p.actor) === 'normal' && !p.body.isDown));
    const ang = Math.atan2(tgt.x - spawn.x, tgt.z - spawn.z);
    const px = tgt.x - Math.sin(ang) * 2;
    const pz = tgt.z - Math.cos(ang) * 2;
    player.placeAt(px, pz, ang + (70 * Math.PI) / 180, terrain);
    for (let i = 0; i < 3; i++) frame();
    player.yaw = Math.atan2(tgt.x - player.pos.x, tgt.z - player.pos.z) + (70 * Math.PI) / 180;
    game.hits.length = 0;
    const ok = player.punch();
    const assisted = player._assist && player._assist.target === tgt.actor;
    let tFace = null;
    let t = 0;
    for (let i = 0; i < 40; i++) {
      frame();
      t += DT;
      const err = Math.abs(angleDelta(player.yaw, Math.atan2(tgt.x - player.pos.x, tgt.z - player.pos.z)));
      if (tFace === null && err < 0.02) tFace = t;
    }
    const hit = game.hits.some((h) => h.target === tgt.actor && h.attacker === player.actor);
    check(`[${label}] 輔助瞄準：2 m、偏 70° 的行人 → ${ASSIST_TURN_SEC} s 內轉向面對、小衝步進 ${HIT_RADIUS} m 命中`,
      ok && assisted && tFace !== null && tFace <= ASSIST_TURN_SEC + DT + 1e-9 && hit, `轉正 ${f2(tFace)} s、命中 ${hit}`);
  }

  // ---- I. 反擊比例：逐一打場上行人一拳，看大腦反應（fight / flee）----
  // 還手與否只由每人固定種子的 braveness 決定（npc-ai.js：braveness ≥ 1 − FIGHT_CHANCE / FIGHT_CHANCE_HEAVY），
  //   本情境每打完一人就把對方交還漫步，MAX_FIGHTERS 不會介入 → 比例 = 抽到的人裡「勇敢者」的比例，屬抽樣波動；
  //   抽到誰取決於工作區有哪些模型（宿主 97 人、工作區 81 人），所以不寫死 20–40%，改用實際抽到的體型組成推導區間：
  //   期望 μ = Σpᵢ / n（一般 0.25、壯碩 0.45；三體型各 1/3 時 μ = (2 × 0.25 + 0.45) / 3 ≈ 0.317）、σ = √Σpᵢ(1 − pᵢ) / n，
  //   斷言 |比例 − μ| ≤ 3σ（n = 97 時約 ±0.14：0.18–0.46，宿主 40.2% 在內）
  //   另外兩條無波動的斷言：每人的反應與其 braveness 特質一致（規則沒有讓比例上升）；同一市民只計一次
  //   （FX1 發現：市民換骨架 / 行人物件回收後同一 actor 會出現在兩個 ped 物件上，舊版會被打兩次、計兩次）
  {
    let fight = 0;
    let flee = 0;
    let tried = 0;
    let mismatch = 0;
    let dup = 0;
    let sumP = 0;
    let sumVar = 0;
    let heavyN = 0;
    const seen = new Set();
    for (const p of peds.slice()) {
      if (!p.alive || p.state === 'down' || combat.stateOf(p.actor) !== 'normal' || brainOf(p).state === 'fight') continue;
      if (seen.has(p.actor.id)) {
        dup++;
        continue;
      }
      player.actor.hp = player.actor.maxHp;
      if (combat.stateOf(player.actor) !== 'normal') combat.revive(player.actor);
      for (let i = 0; i < 240 && combat.stateOf(player.actor) !== 'normal'; i++) frame();
      // 先前事件的恐慌可能讓對方已在逃跑：出拳前交還漫步，讀到的 fight / flee 才是對這一拳的反應
      const b0 = brainOf(p);
      b0.pending.length = 0;
      b0.target = null;
      b0.fleeFrom = null;
      b0._enter('wander');
      // 等出拳冷卻 / 上一拳動作結束（每幀重新擺到對方面前）
      let ok = false;
      for (let i = 0; i < 90 && !ok; i++) {
        faceOff(game, p, 0.8);
        player.yaw = Math.atan2(p.x - player.pos.x, p.z - player.pos.z);
        ok = player.punch();
        if (!ok) frame();
      }
      if (!ok) continue;
      tried++;
      seen.add(p.actor.id);
      let mode = null;
      for (let i = 0; i < 30 && !mode; i++) {
        frame();
        const m = brainOf(p).state;
        if (m === 'fight' || m === 'flee') mode = m;
      }
      const b = brainOf(p);
      if (mode === 'fight' || mode === 'flee') {
        if (mode === 'fight') fight++;
        else flee++;
        const pi = b.heavy ? FIGHT_CHANCE_HEAVY : FIGHT_CHANCE;
        sumP += pi;
        sumVar += pi * (1 - pi);
        if (b.heavy) heavyN++;
        if ((mode === 'fight') !== b.fights) mismatch++;
      }
      // 讓對方回漫步，避免追打影響下一位
      if (b) {
        b.target = null;
        b.fleeFrom = null;
        b._enter('wander');
      }
    }
    const n = fight + flee;
    const ratio = fight / Math.max(1, n);
    const mu = sumP / Math.max(1, n);
    const sigma = Math.sqrt(sumVar) / Math.max(1, n);
    check(`[${label}] 反擊比例：打 ${tried} 人（不重複；略過重複市民 ${dup}），還手 ${fight}、逃跑 ${flee}（壯碩 ${heavyN}）→ 期望 ${(mu * 100).toFixed(1)}% ± 3σ ${(3 * sigma * 100).toFixed(1)}%`,
      n >= 30 && Math.abs(ratio - mu) <= 3 * sigma, `${(ratio * 100).toFixed(1)}%`);
    check(`[${label}] 每人反應與 braveness 特質一致（還手 ⇔ braveness ≥ 1 − 還手機率）：不一致 ${mismatch} 人`, n >= 30 && mismatch === 0);
    // 大樣本（同 traffic 的 id 格式 ped-N 與 CITY_SEED、三體型輪流）：還手特質比例 ≈ (2 × 0.25 + 0.45) / 3，3000 人 3σ ≈ 2.5%
    const N = 3000;
    let brave = 0;
    let exp = 0;
    let v = 0;
    for (let i = 0; i < N; i++) {
      const heavy = i % 3 === 2;
      if (new NpcBrain({ actor: { id: `ped-${i}`, pos: { x: 0, y: 0, z: 0 } }, heavy, seed: CITY_SEED }).fights) brave++;
      const pi = heavy ? FIGHT_CHANCE_HEAVY : FIGHT_CHANCE;
      exp += pi;
      v += pi * (1 - pi);
    }
    check(`[${label}] 還手特質大樣本：${N} 人 ${((brave / N) * 100).toFixed(1)}%（期望 ${((exp / N) * 100).toFixed(1)}% ± 3σ ${((3 * Math.sqrt(v) / N) * 100).toFixed(1)}%）`,
      Math.abs(brave - exp) <= 3 * Math.sqrt(v));
  }
  return game;
}

await runScenarios(makeMockRapier(), 'mock', false);

// ======================= 效能：30 行人 + 10 台車（mixer + AI）=======================
{
  const PEDS = 30;
  const CARS = 10;
  const FRAMES = 600;
  const clips = getCharacterManifest().clips;
  const variants = ['pedestrian', 'pedestrian_f', 'pedestrian_heavy'];
  let clock = 0;
  const combat = new CombatSystem({ now: () => clock });
  const brains = new Map();
  const actors = [];
  const perfScene = new THREE.Scene();
  for (let i = 0; i < PEDS; i++) {
    const ch = createCharacter({ variant: variants[i % 3], colors: { shirt: ['#d84a4a', '#3a6fd8', '#f2c14e'][i % 3] } });
    perfScene.add(ch.root);
    const anim = new CharacterAnimator(ch, clips);
    const actor = {
      id: `perf-${i}`, kind: 'pedestrian', pos: { x: (i % 6) * 3, y: 0, z: Math.floor(i / 6) * 3 }, yaw: 0, hp: 100, maxHp: 100, anim, faction: 'civilian',
      body: { knockdown() {}, settleCheck: () => ({ settled: true, clearToStand: true }), standUp() {} },
    };
    combat.register(actor);
    brains.set(actor.id, new NpcBrain({ actor, heavy: i % 3 === 2 }));
    actors.push(actor);
  }
  wireCombatToBrains(combat, brains);
  // 讓一部分人進入 flee / fight（有打鬥時 AI 較忙）
  for (let i = 0; i < PEDS; i += 3) brains.get(actors[i].id).onAttacked({ attacker: actors[(i + 1) % PEDS] });
  const cars = [];
  const types = ['sedan', 'taxi', 'suv', 'bus', 'scooter'];
  for (let i = 0; i < CARS; i++) {
    const v = new Vehicle(perfScene, types[i % types.length], null, i * 8, 40, 0);
    v.speed = 10;
    cars.push(v);
  }
  const ctx = { combat, playerInVehicle: false, vehicles: [] };
  let tMixer = 0;
  let tAi = 0;
  let tCars = 0;
  for (let f = 0; f < FRAMES; f++) {
    clock += DT;
    const t0 = performance.now();
    combat.update(DT);
    for (const a of actors) {
      const it = brains.get(a.id).update(DT, ctx);
      a.pos.x += it.moveX * DT * (it.run ? 4.5 : 1.3);
      a.pos.z += it.moveZ * DT * (it.run ? 4.5 : 1.3);
      a._speed = Math.hypot(it.moveX, it.moveZ) * (it.run ? 4.5 : 1.3) || 1.3;
    }
    const t1 = performance.now();
    for (const a of actors) a.anim.update(DT, { speed: a._speed });
    const t2 = performance.now();
    for (const v of cars) {
      v.animate(DT);
      v.syncMesh();
    }
    const t3 = performance.now();
    tAi += t1 - t0;
    tMixer += t2 - t1;
    tCars += t3 - t2;
  }
  const per = (t) => t / FRAMES;
  console.log(`INFO  效能（node，${PEDS} 行人 + ${CARS} 車、${FRAMES} 幀平均）：mixer ${per(tMixer).toFixed(3)} ms/幀、AI + combat ${per(tAi).toFixed(3)} ms/幀、車輪動畫 ${per(tCars).toFixed(3)} ms/幀、合計 ${per(tMixer + tAi + tCars).toFixed(3)} ms/幀`);
  check('效能：30 行人 + 10 車 mixer + AI 每幀 < 8 ms（node 單執行緒，60 fps 預算的一半）', per(tMixer + tAi + tCars) < 8, `${per(tMixer + tAi + tCars).toFixed(3)} ms`);
}

console.log(`\n--no-rapier 部分：${passed} 通過 / ${failed} 失敗`);
if (NO_RAPIER) {
  console.log('（--no-rapier：完整版物理測試未執行）');
  process.exit(failed ? 1 : 0);
}

// ======================= 完整版（需要 rapier）=======================
let RAPIER;
try {
  RAPIER = await initPhysics();
} catch (e) {
  console.error(`\n錯誤：無法載入 @dimforge/rapier3d-compat 執行檔（dist/rapier.mjs）：${e.message}`);
  console.error('完整版需要 rapier；只跑 mock 請加 --no-rapier。');
  process.exit(2);
}
await runScenarios(RAPIER, 'rapier', true);
console.log(`\n結果：${passed} 通過 / ${failed} 失敗`);
process.exit(failed ? 1 : 0);
