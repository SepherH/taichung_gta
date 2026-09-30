#!/usr/bin/env node
// I1 物理整合無頭驗證：真實 terrain（含 qiuhonggu 追加的木平台 walkable）+ buildings.js 建築高度 + 全部世界碰撞體，
// 以遊戲本體的 Player / VehicleManager / Vehicle / Traffic / PhysicsOccluder 接線跑
// 用法：
//   node tools/test/physics-integration.mjs             完整版（真的 import rapier；需要 dist/rapier.mjs）
//   node tools/test/physics-integration.mjs --no-rapier 只跑純邏輯：heightfield 三角形切分 / 索引一致、建築資料來源、
//                                                        網格同步與控制對應數學、道路投影，以及用 mock RAPIER 跑完整主迴圈接線
//                                                        （上下車、撞人倒地 → 起身回人行道、NPC 車 wrecked → 恢復對位、停放車被撞醒來）
// exit code：0 = 全過；1 = 有斷言失敗；2 = 完整版找不到 rapier
// JSON 以 loader hook 轉成 ES module（等同 Vite 的 JSON import）；document / canvas 用最小 mock（同 placement.mjs）
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

const ctx2d = new Proxy({}, {
  get: (_, k) => (k === 'measureText' ? () => ({ width: 100 }) : () => {}),
  set: () => true,
});
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d, style: {} }),
};

const THREE = await import('three');
const { default: osm } = await import('../../src/data/osm-city.json');
const { getTerrain, surfaceFootways, surfaceRoads, TRAFFIC_TYPES } = await import('../../src/citymodel.js');
const { buildBuildings } = await import('../../src/buildings.js');
const { buildQiuhonggu } = await import('../../src/qiuhonggu.js');
const { computeSpawn, computeParkedVehicles } = await import('../../src/places.js');
const { Player, moveIntent } = await import('../../src/player.js');
const { Vehicle, VehicleManager, VEHICLE_TYPES, driveControls, wheelMeshMap, meshOrigin } = await import('../../src/vehicle.js');
const { Traffic, projectOnRoad } = await import('../../src/traffic.js');
const { PhysicsOccluder } = await import('../../src/collision.js');
const { samplePolyline, closestOnPolygon } = await import('../../src/geom.js');
const { angleDelta } = await import('../../src/utils.js');
const { PhysicsWorld, initPhysics } = await import('../../src/physics/world.js');
const { buildWorldColliders, osmWithBuildings, patchToHeightfield } = await import('../../src/physics/colliders.js');
const { GROUPS } = await import('../../src/physics/groups.js');
const { CharacterBody } = await import('../../src/physics/character.js');
const { createContactRouter } = await import('../../src/physics/contacts.js');
const { setActiveByDistance, ACTIVE_RADIUS, NPC_WRECK_IMPULSE, NPC_WRECK_MIN_SEC } = await import('../../src/physics/npc-bodies.js');
const { VehicleBody, rotateVec, yawQuat, yawOf, chassisLayout, deriveVehicleSpec } = await import('../../src/physics/vehicle-body.js');

const NO_RAPIER = process.argv.includes('--no-rapier');
const DT = 1 / 60;
const HF_TOL = 0.02; // heightfield castRay 與 heightAt 的容差（m）
const Y_TOL = 0.1; // 角色終點高度容差（m）
const CAR_CLEAR_TOL = 0.05; // 車底最低點可低於 heightAt 的量（m）
const PARK_DRIFT_TOL = 0.05; // 停放車靜置 3 秒的漂移上限（m）

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : String(v));

let seed = 20260930;
function rand() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}

// ---------- 場景資料（同遊戲載入流程：qiuhonggu 追加木平台 walkable、buildings.js 決定建築高度）----------
const terrain = getTerrain();
const walkablesBefore = terrain.walkables.length;
const scene = new THREE.Scene();
buildQiuhonggu(terrain, { footways: surfaceFootways });
const blds = buildBuildings(scene, { anisotropy: 1 });
const worldOsm = osmWithBuildings(osm, blds.colliders);
const basinPatch = terrain.patches.find((p) => p.kind === 'basin');
const plazaPatch = terrain.patches.find((p) => p.kind === 'plaza');
const basin = basinPatch.feature.src;
const lv = basin.levels;
const plazaDepth = osm.T.plazas[0].depth;
const spawn = computeSpawn();
const parked = computeParkedVehicles(spawn);
const q = {};

// 路線：北端坡道起點 → 湖邊步道（同 placement.mjs）
const rampStart = basin.features.find((f) => f.k === 'ramp_start');
const rs = { x: rampStart.p[0], z: rampStart.p[1] };
const LD = (() => {
  const cp = {};
  closestOnPolygon(rs.x, rs.z, terrain.lakes[0].poly, cp);
  const d = Math.hypot(cp.x - rs.x, cp.z - rs.z);
  return { ux: (cp.x - rs.x) / d, uz: (cp.z - rs.z) / d, shore: { x: cp.x, z: cp.z } };
})();
const walkwayPt = { x: LD.shore.x - LD.ux * 1.5, z: LD.shore.z - LD.uz * 1.5 };
// 坡頂：由 ramp_start 反湖方向找到路面高（h ≥ −0.01）
function march(x, z, ux, uz, pred, maxD = 80) {
  for (let s = 0; s < maxD; s += 0.25) {
    const px = x + ux * s;
    const pz = z + uz * s;
    if (pred(terrain.heightAt(px, pz))) return { x: px, z: pz };
  }
  return null;
}
const rampTop = march(rs.x, rs.z, -LD.ux, -LD.uz, (h) => h >= -0.01);
// 紅橋折線
const bridgeFeat = basin.features.find((f) => f.k === 'lake_bridge_osm') || basin.features.find((f) => f.k === 'red_bridge');
const bridgePts = [];
for (let i = 0; i < bridgeFeat.p.length; i += 2) bridgePts.push({ x: bridgeFeat.p[i], z: bridgeFeat.p[i + 1] });
const bridgeWalk = terrain.walkables.find((w) => w.kind === 'bridge');
// 下沉廣場大階梯：頂邊 = walkable 高度較高的兩個頂點
const stairs = terrain.walkables.find((w) => w.kind === 'stairs');
const stairsGeom = (() => {
  const v = [];
  for (let i = 0; i < stairs.poly.length; i += 2) v.push({ x: stairs.poly[i], z: stairs.poly[i + 1], y: stairs.heightAt(stairs.poly[i], stairs.poly[i + 1]) });
  const byY = [...v].sort((a, b) => b.y - a.y);
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
  const top = mid(byY[0], byY[1]);
  const bottom = mid(byY[2], byY[3]);
  const L = Math.hypot(bottom.x - top.x, bottom.z - top.z);
  return { top, bottom, len: L, ux: (bottom.x - top.x) / L, uz: (bottom.z - top.z) / L, topY: byY[0].y, bottomY: byY[3].y };
})();

// ======================= 純邏輯（不需要 rapier）=======================

// ---------- heightfield：patchToHeightfield 的輸出以 parry 切分重建，與 terrain.heightAt 一致 ----------
// parry3d HeightField::triangles_at 預設（未設 ZIGZAG_SUBDIVISION）每格兩個三角形 (p00, p10, p01) / (p10, p11, p01)，
// p_ij：i 沿局部 z（列）、j 沿局部 x（行），即對角線連 (x0, z1)–(x1, z0)（西南 ↔ 東北），須與 terrain.js 檔頭慣例相同
function mockHfRapier() {
  const desc = { setTranslation() { return desc; } };
  return { HeightFieldFlags: { FIX_INTERNAL_EDGES: 1 }, ColliderDesc: { heightfield: () => desc } };
}
function parryHeight(hf, x, z) {
  const { nrows, ncols, heights, scale, center } = hf;
  const lx = x - center.x + scale.x / 2;
  const lz = z - center.z + scale.z / 2;
  const cw = scale.x / ncols;
  const ch = scale.z / nrows;
  const j = Math.min(ncols - 1, Math.max(0, Math.floor(lx / cw)));
  const i = Math.min(nrows - 1, Math.max(0, Math.floor(lz / ch)));
  const u = lx / cw - j;
  const v = lz / ch - i;
  const H = (ii, jj) => heights[jj * (nrows + 1) + ii];
  const h00 = H(i, j);
  const h10 = H(i + 1, j);
  const h01 = H(i, j + 1);
  const h11 = H(i + 1, j + 1);
  if (u + v <= 1) return h00 + (h01 - h00) * u + (h10 - h00) * v;
  return h11 + (h10 - h11) * (1 - u) + (h01 - h11) * (1 - v);
}
function patchSamples(patch, n) {
  const pts = [];
  const w = (patch.cols - 1) * patch.cell;
  const d = (patch.rows - 1) * patch.cell;
  for (let k = 0; k < n; k++) pts.push({ x: patch.x0 + rand() * w, z: patch.z0 + rand() * d });
  return pts;
}
for (const patch of [basinPatch, plazaPatch]) {
  const hf = patchToHeightfield(mockHfRapier(), patch);
  let maxDiff = 0;
  let maxAlt = 0; // 反向對角線的差（證明取樣點確實分辨得出切分方向）
  for (const p of patchSamples(patch, 3000)) {
    maxDiff = Math.max(maxDiff, Math.abs(parryHeight(hf, p.x, p.z) - terrain.heightAt(p.x, p.z)));
    const c = Math.floor((p.x - patch.x0) / patch.cell);
    const r = Math.floor((p.z - patch.z0) / patch.cell);
    const u = (p.x - patch.x0) / patch.cell - c;
    const v = (p.z - patch.z0) / patch.cell - r;
    const Hp = (cc, rr) => patch.heights[Math.min(patch.rows - 1, rr) * patch.cols + Math.min(patch.cols - 1, cc)];
    const alt = u >= v
      ? Hp(c, r) + (Hp(c + 1, r) - Hp(c, r)) * u + (Hp(c + 1, r + 1) - Hp(c + 1, r)) * v
      : Hp(c, r) + (Hp(c + 1, r + 1) - Hp(c, r + 1)) * u + (Hp(c, r + 1) - Hp(c, r)) * v;
    maxAlt = Math.max(maxAlt, Math.abs(alt - terrain.heightAt(p.x, p.z)));
  }
  check(`heightfield(${patch.kind})：parry 切分重建 3000 點與 heightAt 差 < 1e-4`, maxDiff < 1e-4, `最大差 ${maxDiff.toExponential(2)}（若用另一條對角線最大差 ${f3(maxAlt)} m）`);
}

// ---------- 世界碰撞體的資料來源 ----------
{
  const byId = new Map(blds.colliders.map((c) => [c.id, c]));
  const same = worldOsm.B.length === blds.colliders.length && worldOsm.B.every((b) => byId.get(b.i).h === b.h && byId.get(b.i).poly === b.p);
  const overriddenDiff = blds.overridden.filter((id) => byId.get(id).h !== osm.B.find((b) => b.i === id).h).length;
  check('colliders 來源：osmWithBuildings 的建築 = buildings.colliders（高度含地標 manifest 覆寫）', same && worldOsm.bounds === osm.bounds && worldOsm.T === osm.T, `${worldOsm.B.length} 棟、地標覆寫 ${blds.overridden.length} 棟（高度與 OSM 不同 ${overriddenDiff} 棟）`);
  const kinds = new Set(terrain.walkables.map((w) => w.kind));
  check('colliders 來源：walkables 含紅橋 / Z 字步道 / 大階梯與 qiuhonggu 追加的平台', kinds.has('bridge') && kinds.has('boardwalk') && kinds.has('stairs') && terrain.walkables.length > walkablesBefore, `${walkablesBefore} → ${terrain.walkables.length} 個（${[...kinds].join('、')}）`);
}

// ---------- 網格同步 / 控制對應數學 ----------
{
  let ok = true;
  const det = [];
  for (const type of Object.keys(VEHICLE_TYPES)) {
    const v = new Vehicle(scene, type, '#ffffff', 0, 0, 0);
    const layout = chassisLayout(deriveVehicleSpec({ type, ...v.spec }));
    const holders = v.mesh.userData.wheels.map((w) => w.parent.position);
    const map = wheelMeshMap(holders, layout.wheels);
    const perm = new Set(map).size === map.length && map.every((i) => i >= 0);
    const signs = map.every((i, k) => Math.sign(layout.wheels[i].x) === Math.sign(holders[k].x) && layout.wheels[i].front === holders[k].z > 0);
    if (!perm || !signs) ok = false;
    det.push(`${type}:[${map.join(',')}]`);
    scene.remove(v.mesh);
  }
  check('vehicle：網格輪子 ↔ VehicleBody 輪序一一對應（左右、前後一致）', ok, det.join(' '));

  const c = 0.8;
  const m0 = meshOrigin({ x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: 0, w: 1 }, c);
  // 繞前進軸（+Z）滾 90°：車身 up 變成水平，網格原點應在底盤中心側面 c 公尺
  const qr = { x: 0, y: 0, z: Math.sin(Math.PI / 4), w: Math.cos(Math.PI / 4) };
  const m1 = meshOrigin({ x: 0, y: 0, z: 0 }, qr, c);
  const up = rotateVec(qr, { x: 0, y: 1, z: 0 });
  check('vehicle：網格原點 = 底盤中心沿車身 up 往下 centerY', Math.abs(m0.y - (2 - c)) < 1e-12 && m0.x === 1 && Math.abs(m1.x + up.x * c) < 1e-12 && Math.abs(m1.y) < 1e-12);

  const fwd = driveControls({ x: 0, y: 1 }, false);
  const right = driveControls({ x: 1, y: 0 }, false);
  const back = driveControls({ x: 0, y: -1 }, true);
  check('vehicle：輸入 → 控制（W 油門、D 右轉 = steer −1、S 煞車 / 倒車、Space 手煞車）', fwd.throttle === 1 && right.steer === -1 && back.throttle === -1 && back.handbrake && !fwd.handbrake);

  const a = moveIntent({ x: 0, y: 1 }, 0);
  const b = moveIntent({ x: 1, y: 0 }, 0);
  const c2 = moveIntent({ x: 0, y: 1 }, Math.PI / 2);
  check('player：移動意圖相對鏡頭（yaw 0 前 = +Z、右 = −X；yaw 90° 前 = +X）', Math.abs(a.z - 1) < 1e-12 && Math.abs(b.x + 1) < 1e-12 && Math.abs(c2.x - 1) < 1e-12);
}

// ---------- 道路投影（wrecked 恢復 / 行人回人行道）----------
{
  const road = surfaceRoads.find((r) => TRAFFIC_TYPES.has(r.type) && r.length > 60);
  const tmp = { x: 0, z: 0, dx: 0, dz: 1 };
  let maxErr = 0;
  for (const [s, lat] of [[10, 2.5], [road.length / 2, -1.7], [road.length - 5, 0.4]]) {
    samplePolyline(road, s, tmp);
    const pr = projectOnRoad(road, tmp.x - tmp.dz * lat, tmp.z + tmp.dx * lat);
    maxErr = Math.max(maxErr, Math.abs(pr.s - s), Math.abs(pr.lat - lat));
  }
  check('traffic：projectOnRoad 還原沿線距離與帶號橫向偏移', maxErr < 1e-6, `最大誤差 ${maxErr.toExponential(2)}`);
}

// ---------- mock RAPIER：跑遊戲主迴圈接線（不模擬真物理，只驗證呼叫順序、狀態機、網格同步）----------
// 動態剛體：位置依速度積分、每步速度衰減（讓被撞的東西很快停下）；kinematic：移到 next 目標；角色：位移後腳底夾在 querySurface 上
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
    setRotation(q) {
      this.q = { ...q };
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
    setRotation(q) { this.q = { ...q }; }
    setLinvel(v) { this.lv = vec(v); }
    setAngvel(v) { this.av = vec(v); }
    setNextKinematicTranslation(t) { this.next = vec(t); }
    setNextKinematicRotation(q) { this.nextQ = { ...q }; }
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
      if (body && desc.mass) body.m = desc.mass; // 行人質量設在 collider 上
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
    // 射線只打地面：命中 querySurface 高度
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
  // 事件佇列：測試以 pending 注入碰撞開始 / 接觸力事件，drain 時送出
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

// 遊戲本體同一套接線（main.js 的載入段 + stepWorld）；RAPIER 為真 rapier 或 mock
function buildGame(RAPIER, stats = null) {
  const pw = new PhysicsWorld(RAPIER);
  const colliderStats = stats ? buildWorldColliders(RAPIER, pw.world, { osm: worldOsm, terrain }) : { handles: { lake: [], wall: [] } };
  const router = createContactRouter(RAPIER, pw);
  pw.onAfterStep((dt) => router.drain(dt));
  const physics = { RAPIER, pw, router, groups: GROUPS };
  pw.stepOnce();
  const vehicles = new VehicleManager(scene, parked, terrain, physics);
  const traffic = new Traffic(scene, { center: spawn, terrain, physics });
  const player = new Player(scene, spawn);
  const character = new CharacterBody(RAPIER, pw, { x: spawn.x, y: spawn.y, z: spawn.z });
  player.attachPhysics(character);
  player.placeAt(spawn.x, spawn.z, spawn.yaw, terrain);
  const occluder = new PhysicsOccluder(pw, colliderStats);
  const game = { pw, router, vehicles, traffic, player, character, occluder, colliderStats, driving: null };
  const blockers = [];
  const entities = [];
  game.step = (dt = DT) => {
    blockers.length = 0;
    blockers.push(game.driving ? game.driving.pos : player.pos);
    for (const v of vehicles.vehicles) blockers.push(v.pos);
    traffic.setBlockers(blockers);
    pw.step(dt);
    if (!game.driving) player.syncPhysics(dt);
    vehicles.sync();
    traffic.sync(dt);
    entities.length = 0;
    const c = game.driving ? game.driving.pos : player.pos;
    setActiveByDistance(traffic.bodies(vehicles.bodies(entities)), c.x, c.z, ACTIVE_RADIUS);
  };
  return game;
}

// 模擬輸入：按住的鍵與本幀剛按下的鍵；moveAxis 同 input.js（鍵盤數位 ±1）
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

// 按住 W、鏡頭朝向目標走到 (tx, tz)；回傳是否在 maxFrames 內抵達
function walkTo(game, input, tx, tz, maxFrames, stopDist = 0.3, each = null) {
  const p = game.player;
  input.keys.add('KeyW');
  let f = 0;
  for (; f < maxFrames; f++) {
    const dx = tx - p.pos.x;
    const dz = tz - p.pos.z;
    if (Math.hypot(dx, dz) < stopDist) break;
    p.update(DT, input, Math.atan2(dx, dz));
    game.step();
    if (each) each();
  }
  input.keys.delete('KeyW');
  return f < maxFrames;
}
function idle(game, input, frames, each = null) {
  for (let f = 0; f < frames; f++) {
    game.player.update(DT, input, 0);
    game.step();
    if (each) each(f);
  }
}
const finite = (o) => Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.z);

{
  const R = makeMockRapier();
  const game = buildGame(R);
  const { player, traffic, vehicles, router } = game;
  const input = mockInput();
  const eq = game.pw.eventQueue;

  // 1. 步行 3 秒 + 1 秒跑：每子步 move 一次、腳底貼 querySurface、網格跟上
  const x0 = player.pos.x;
  const z0 = player.pos.z;
  let maxFoot = 0;
  input.keys.add('KeyW');
  for (let f = 0; f < 240; f++) {
    if (f === 180) input.keys.add('ShiftLeft');
    player.update(DT, input, spawn.yaw);
    game.step();
    maxFoot = Math.max(maxFoot, Math.abs(player.pos.y - terrain.querySurface(player.pos.x, player.pos.z, player.pos.y + 0.4, q).y));
  }
  input.keys.clear();
  const moved = Math.hypot(player.pos.x - x0, player.pos.z - z0);
  check('mock 主迴圈：步行 3 s + 跑 1 s，位移 / 腳底貼地 / 網格同步', moved > 15 && maxFoot < 1e-6 && player.mesh.position.distanceTo(player.pos) < 0.2 && player.speed > 8, `位移 ${f3(moved)} m、腳底最大差 ${maxFoot.toExponential(2)}、末速 ${f3(player.speed)} m/s`);

  // 2. 跳躍：Space 在下一個子步起跳
  input.pressed.add('Space');
  player.update(DT, input, 0);
  input.pressed.clear();
  game.step();
  const vyJump = game.character.vy;
  idle(game, input, 60);
  check('mock 主迴圈：Space → 第一個子步起跳、1 s 後落地', vyJump > 5 && player.onGround, `起跳後 vy ${f3(vyJump)}、落地 ${player.onGround}`);

  // 3. 上車 / 駕駛 / 下車（findFreeSpot）
  const car = vehicles.vehicles[0];
  vehicles.drive(car, true);
  player.enterVehicle();
  game.driving = car;
  car.setControls(driveControls({ x: 0, y: 1 }, false));
  for (let f = 0; f < 30; f++) game.step();
  const dynamic = !car.body.kinematic;
  const exited = player.exitVehicle(car);
  vehicles.drive(car, false);
  game.driving = null;
  for (let f = 0; f < 90; f++) game.step();
  const dSide = Math.hypot(player.pos.x - car.pos.x, player.pos.z - car.pos.z);
  check('mock 主迴圈：上車 setEnabled(false) → 駕駛切 dynamic → 下車 findFreeSpot 站在車旁 → 靜止 1 s 後切回 kinematic 停放', dynamic && exited && game.character.enabled && dSide > car.spec.width / 2 && dSide < 5 && car.body.kinematic, `下車點離車 ${f3(dSide)} m、停放 kinematic=${car.body.kinematic}`);

  // 4. 車流：kinematic 跟車道、網格有限
  const npc = traffic.cars.reduce((a, b) => (b.v.pos.distanceTo(player.pos) < a.v.pos.distanceTo(player.pos) ? b : a));
  const s0 = { x: npc.v.pos.x, z: npc.v.pos.z };
  for (let f = 0; f < 120; f++) game.step();
  const npcMoved = Math.hypot(npc.v.pos.x - s0.x, npc.v.pos.z - s0.z);
  const bodyGap = Math.hypot(npc.body.getPose().x - npc.v.pos.x, npc.body.getPose().z - npc.v.pos.z);
  check('mock 主迴圈：NPC 車 kinematic 跟車道（剛體 = 車道 pose）、網格位置有限', traffic.cars.every((c) => finite(c.v.mesh.position)) && bodyGap < 1e-9 && (npcMoved > 5 || traffic.cars.some((c) => c.speed > 1)), `車 ${traffic.cars.length} 台、最近一台 2 s 移動 ${f3(npcMoved)} m（距玩家 ${f3(npc.v.pos.distanceTo(player.pos))} m）`);

  // 5. 車撞 NPC 車（接觸力事件）→ wrecked、跳過車道邏輯 → 4 s 後停下 recover → 對位回車道
  const other = vehicles.vehicles[1];
  vehicles.drive(other, true);
  const force = (NPC_WRECK_IMPULSE * 1.5) / DT;
  eq.forces.push({ h1: other.body.collider.handle, h2: npc.body.collider.handle, force, dir: { x: 1, y: 0, z: 0 } });
  game.step();
  const wrecked = npc.body.isWrecked;
  const laneS = npc.s;
  for (let f = 0; f < 60; f++) game.step();
  const skipped = npc.s === laneS;
  let recovered = false;
  for (let f = 0; f < Math.ceil((NPC_WRECK_MIN_SEC + 1) / DT) && !recovered; f++) {
    game.step();
    recovered = !npc.body.isWrecked;
  }
  const pr = projectOnRoad(npc.road, npc.v.pos.x, npc.v.pos.z);
  for (let f = 0; f < 60; f++) game.step();
  check('mock 主迴圈：車撞 NPC 車 → wrecked（期間跳過車道邏輯）→ 停下後 recover 並投影回道路繼續行駛', wrecked && skipped && recovered && Math.sqrt(pr.d2) < npc.road.hw + 1 && npc.speed > 0, `wrecked=${wrecked} 車道 s 凍結=${skipped} 恢復=${recovered} 離道路中心 ${f3(Math.sqrt(pr.d2))} m、恢復後速度 ${f3(npc.speed)}`);

  // 6. 車撞行人（碰撞開始事件）→ dynamic 飛出 → 落穩起身 → 走回人行道 → 繼續來回走
  // 取離玩家最近的行人（半徑外的剛體會被 setActiveByDistance 停用而凍結）
  const nearest = (list, pos) => list.reduce((a, b) => (Math.hypot(b.x - player.pos.x, b.z - player.pos.z) < Math.hypot(a.x - player.pos.x, a.z - player.pos.z) ? b : a));
  const ped = nearest(traffic.peds);
  const hitter = other.body;
  hitter.body.setLinvel({ x: 10, y: 0, z: 0 }, true);
  eq.collisions.push([hitter.collider.handle, ped.body.collider.handle, true]);
  game.step();
  hitter.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  const down = ped.state === 'down' && ped.body.isDown;
  const hitAt = ped.body.getPosition();
  let returned = false;
  let walked = false;
  for (let f = 0; f < 600 && !walked; f++) {
    game.step();
    if (ped.state === 'return') returned = true;
    if (returned && ped.state === 'walk') walked = true;
  }
  const onPath = (() => {
    const t = {};
    traffic._pathPoint(ped, t);
    return Math.hypot(t.x - ped.x, t.z - ped.z);
  })();
  const flew = Math.hypot(hitAt.x - ped.x, hitAt.z - ped.z);
  check('mock 主迴圈：車撞行人 → 倒地飛出 → 落穩起身 → 走回人行道 → 繼續走', down && returned && walked && onPath < 0.2 && !ped.body.isDown, `倒地=${down} 起身走回=${returned} 回到路線=${walked}（距路線點 ${f3(onPath)} m）、撞擊點到結束位置 ${f3(flew)} m`);
  vehicles.drive(other, false);

  // 7. 停放車被撞：kinematic → dynamic 並吃下衝量
  const victim = vehicles.vehicles[2];
  eq.forces.push({ h1: car.body.collider.handle, h2: victim.body.collider.handle, force: 2000 / DT, dir: { x: 0, y: 0, z: 1 } });
  vehicles.drive(car, true);
  game.step();
  const woke = !victim.body.kinematic;
  vehicles.drive(car, false);
  check('mock 主迴圈：停放車被撞（超過門檻）→ 醒來切 dynamic', woke);

  // 8. 翻車自救：抬高 1 m、插值對齊
  const yb = car.body.body.translation().y;
  car.flip();
  vehicles.sync();
  check('mock 主迴圈：flip() 抬高並重設插值（網格立即到新位置）', Math.abs(car.body.body.translation().y - yb - 1) < 1e-9 && Math.abs(car.mesh.position.y - (car.pos.y + 0.1)) < 1e-9);

  // 9. 遠距簡化：出生點附近啟用、遠處停用
  const far = traffic.bodies().filter((b) => !b.active).length;
  check('mock 主迴圈：setActiveByDistance（半徑 250 m）每幀切換、停用者網格仍有限', traffic.cars.every((c) => finite(c.v.mesh.position)) && traffic.peds.every((p) => finite(p.mesh.position)), `目前停用 ${far} 個`);
  // 10. 事件佇列每幀清空、PhysicsWorld 一幀一步（dt = 1/60）
  const before = eq.stepped;
  game.step(DT);
  game.step(DT * 3);
  check('mock 主迴圈：step(1/60) = 1 子步、step(3/60) = 3 子步', eq.stepped - before === 4, `子步 ${eq.stepped - before}`);
  void router;
}

console.log(`\n純邏輯：${passed} 通過 / ${failed} 失敗`);
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
  console.error('完整版物理測試需要 rapier；只跑純邏輯請加 --no-rapier。');
  process.exit(2);
}
const pureFailed = failed;
try {
  const game = buildGame(RAPIER, true);
  const { pw, player, vehicles } = game;
  const st = game.colliderStats;
  console.log(`\n建世界：${f3(st.ms)} ms；collider ${st.colliders}（建築凸塊 ${st.buildingPieces}、heightfield ${st.heightfields}、平地 cuboid ${st.groundBoxes}、walkable ${st.walkables}、湖面柱 ${st.lakePieces}、牆 ${st.walls}、略過 ${st.skipped}）`);
  const input = mockInput();
  const DOWN = { x: 0, y: -1, z: 0 };

  // ---------- heightfield castRay 與 heightAt ----------
  const hfSet = new Set(st.handles.heightfield.map((c) => c.handle));
  for (const patch of [basinPatch, plazaPatch]) {
    let maxDiff = 0;
    let miss = 0;
    for (const p of patchSamples(patch, 3000)) {
      const hit = pw.castRay({ x: p.x, y: 50, z: p.z }, DOWN, 100, { predicate: (c) => hfSet.has(c.handle) });
      if (!hit) {
        miss++;
        continue;
      }
      maxDiff = Math.max(maxDiff, Math.abs(hit.y - terrain.heightAt(p.x, p.z)));
    }
    check(`heightfield(${patch.kind})：patch 內 3000 點 castRay 與 heightAt 差 < ${HF_TOL}`, miss === 0 && maxDiff < HF_TOL, `最大差 ${f3(maxDiff)}、未命中 ${miss}`);
  }

  // ---------- 出生點：2 秒內穩定 ----------
  {
    player.placeAt(spawn.x, spawn.z, spawn.yaw, terrain);
    let tGround = -1;
    let drift = 0;
    let yRef = null;
    idle(game, input, 120, (f) => {
      if (tGround < 0 && player.onGround) tGround = (f + 1) * DT;
      if (f === 89) yRef = player.pos.y;
      if (f >= 90) drift = Math.max(drift, Math.abs(player.pos.y - yRef));
    });
    // 除錯：腳下地面 collider 種類與射線命中高度（區分「換算錯」與「地面 collider 本身偏低」）
    const under = pw.castRay({ x: player.pos.x, y: player.pos.y + 0.5, z: player.pos.z }, DOWN, 3, { excludeCollider: game.character.collider });
    const kindOf = (c) => Object.keys(st.handles).find((k) => st.handles[k].some((o) => o.handle === c.handle)) || 'other';
    check('出生點：角色 2 秒內落地且穩定（最後 0.5 s y 變化 < 0.01、y ≈ spawn.y ±0.05）', tGround >= 0 && drift < 0.01 && Math.abs(player.pos.y - spawn.y) < 0.05, `落地 ${f3(tGround)} s、末段變化 ${f3(drift)}、y ${f3(player.pos.y)} vs ${f3(spawn.y)}、腳下 ${under ? `${kindOf(under.collider)} y ${f3(under.y)}` : '無命中'}`);
  }

  // ---------- 停放車：靜置 3 秒不漂移（遊戲狀態 = kinematic；另測喚醒成 dynamic、拉手煞車無人操作）----------
  {
    const p0 = vehicles.vehicles.map((v) => v.pos.clone());
    const awake = vehicles.vehicles[0];
    vehicles.drive(awake, true);
    awake.setControls({ handbrake: true });
    for (let f = 0; f < 30; f++) game.step(); // 懸吊先落定 0.5 s
    const a0 = awake.pos.clone();
    for (let f = 0; f < 180; f++) game.step();
    let maxD = 0;
    vehicles.vehicles.forEach((v, i) => {
      if (v !== awake) maxD = Math.max(maxD, v.pos.distanceTo(p0[i]));
    });
    const awakeDrift = Math.hypot(awake.pos.x - a0.x, awake.pos.z - a0.z);
    check(`停放車：${vehicles.vehicles.length - 1} 台 kinematic 靜置 3 s 位移 < ${PARK_DRIFT_TOL}；喚醒的 dynamic 車拉手煞車 3 s 水平漂移 < ${PARK_DRIFT_TOL}`, maxD < PARK_DRIFT_TOL && awakeDrift < PARK_DRIFT_TOL, `kinematic 最大 ${f3(maxD)} m、dynamic（${awake.type}）${f3(awakeDrift)} m`);
    vehicles.drive(awake, false);
  }

  // ---------- 角色：北端坡道起點 → 湖邊步道 ----------
  {
    player.placeAt(rs.x, rs.z, 0, terrain);
    idle(game, input, 20);
    const ok = walkTo(game, input, walkwayPt.x, walkwayPt.z, 60 * 60, 0.5);
    idle(game, input, 60);
    check(`角色：北端坡道起點走到湖邊步道 y ≈ walkway ${lv.walkway} ±${Y_TOL}`, ok && Math.abs(player.pos.y - lv.walkway) < Y_TOL && player.onGround, `抵達 ${ok}、y ${f3(player.pos.y)}、距目標 ${f3(Math.hypot(player.pos.x - walkwayPt.x, player.pos.z - walkwayPt.z))} m`);
  }

  // ---------- 角色：紅橋中央 ----------
  {
    const P = bridgePts;
    const L = Math.hypot(P[1].x - P[0].x, P[1].z - P[0].z);
    const ux = (P[1].x - P[0].x) / L;
    const uz = (P[1].z - P[0].z) / L;
    player.placeAt(P[0].x - ux * 4, P[0].z - uz * 4, 0, terrain);
    idle(game, input, 20);
    const mid = Math.floor(P.length / 2);
    let ok = true;
    for (let i = 0; i <= mid && ok; i++) ok = walkTo(game, input, P[i].x, P[i].z, 60 * 30, 0.5);
    idle(game, input, 30);
    const deckY = bridgeWalk.heightAt(player.pos.x, player.pos.z);
    check(`角色：走上紅橋中央 y ≈ 甲板 ±${Y_TOL}`, ok && Math.abs(player.pos.y - deckY) < Y_TOL && player.onGround, `抵達 ${ok}、y ${f3(player.pos.y)} vs 甲板 ${f3(deckY)}`);
  }

  // ---------- 角色：東岸 → Z 字湖上步道湖心端（瀏覽器實測東端卡在 x≈128.6 的回歸）----------
  {
    const zf = basin.features.find((f) => f.k === 'zigzag_walk');
    const Z = [];
    for (let i = 0; i < zf.p.length; i += 2) Z.push({ x: zf.p[i], z: zf.p[i + 1] });
    const L = Math.hypot(Z[1].x - Z[0].x, Z[1].z - Z[0].z);
    const ux = (Z[1].x - Z[0].x) / L;
    const uz = (Z[1].z - Z[0].z) / L;
    player.placeAt(Z[0].x - ux * 5, Z[0].z - uz * 5, 0, terrain);
    idle(game, input, 20);
    let ok = true;
    for (let i = 0; i < Z.length && ok; i++) ok = walkTo(game, input, Z[i].x, Z[i].z, 60 * 30, 0.5);
    idle(game, input, 30);
    const zw = terrain.walkables.find((w) => w.kind === 'boardwalk');
    const deckY = zw.heightAt(player.pos.x, player.pos.z);
    check(`角色：東岸走上 Z 字步道到湖心端 y ≈ 甲板 ±${Y_TOL}`, ok && Math.abs(player.pos.y - deckY) < Y_TOL && player.onGround, `抵達 ${ok}、(${f3(player.pos.x)}, ${f3(player.pos.z)}) y ${f3(player.pos.y)} vs 甲板 ${f3(deckY)}`);
  }

  // ---------- 角色：下沉廣場大階梯走到底 ----------
  {
    const S = stairsGeom;
    player.placeAt(S.top.x - S.ux * 2, S.top.z - S.uz * 2, 0, terrain);
    idle(game, input, 20);
    const ok = walkTo(game, input, S.bottom.x + S.ux * 2, S.bottom.z + S.uz * 2, 60 * 20, 0.5);
    idle(game, input, 30);
    check(`角色：下沉廣場大階梯走下去到底 y ≈ ${plazaDepth} ±${Y_TOL}`, ok && Math.abs(player.pos.y - plazaDepth) < Y_TOL && player.onGround, `抵達 ${ok}、y ${f3(player.pos.y)}（階梯頂 ${f3(S.topY)} 底 ${f3(S.bottomY)}）`);
  }

  // ---------- 車：北端坡道頂 → 坡底，不穿地 ----------
  const bottomClear = (vb) => {
    const t = vb.body.translation();
    const r = vb.body.rotation();
    const { half } = vb.layout;
    let worst = Infinity;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const c = rotateVec(r, { x: sx * half.x, y: -half.y, z: sz * half.z });
        const x = t.x + c.x;
        const z = t.z + c.z;
        worst = Math.min(worst, t.y + c.y - terrain.heightAt(x, z));
      }
    }
    return worst;
  };
  const makeCar = (x, z, yaw) => {
    const v = new Vehicle(scene, 'sedan', '#ffffff', x, z, yaw);
    const y = terrain.querySurface(x, z, Infinity, q).y;
    const vb = new VehicleBody(RAPIER, pw, { type: 'sedan', ...v.spec }, { x, y, z, yaw, groups: GROUPS, ccd: true });
    v.attachBody(vb, pw.register(vb.body));
    const off = pw.onBeforeStep((dt) => vb.preStep(dt));
    return { v, vb, done: () => { off(); pw.unregister(v.interp); vb.dispose(); scene.remove(v.mesh); } };
  };
  {
    const sx = rampTop.x + LD.ux * 1;
    const sz = rampTop.z + LD.uz * 1;
    const { v, vb, done } = makeCar(sx, sz, Math.atan2(LD.ux, LD.uz));
    const y0 = v.pos.y;
    let minClear = Infinity;
    let frames = 0;
    let reached = false;
    for (; frames < 60 * 30; frames++) {
      const dx = walkwayPt.x - v.pos.x;
      const dz = walkwayPt.z - v.pos.z;
      const dist = Math.hypot(dx, dz);
      const steer = Math.max(-1, Math.min(1, angleDelta(v.yaw, Math.atan2(dx, dz)) * 2));
      const fs = vb.forwardSpeed();
      v.setControls({ throttle: dist > 6 && fs < 7 ? 1 : 0, brake: dist <= 6 ? 1 : 0, steer });
      pw.step(DT);
      vehicles.sync();
      v.syncBody(pw.alpha);
      minClear = Math.min(minClear, bottomClear(vb));
      if (Math.abs(v.pos.y - lv.walkway) < 0.3 && Math.abs(fs) < 0.3 && frames > 60) {
        reached = true;
        break;
      }
    }
    check(`車：sedan 從北端坡道頂（y ${f3(y0)}）開到坡底不穿地（每步車底最低點 ≥ heightAt − ${CAR_CLEAR_TOL}）`, reached && minClear >= -CAR_CLEAR_TOL, `抵達坡底 ${reached}（${frames} 步、y ${f3(v.pos.y)} vs walkway ${lv.walkway}）、車底最小離地 ${f3(minClear)} m`);
    done();
  }

  // ---------- 車：開上下沉廣場大階梯被擋或明顯減速 ----------
  {
    const S = stairsGeom;
    const { v, vb, done } = makeCar(S.bottom.x + S.ux * 8, S.bottom.z + S.uz * 8, Math.atan2(-S.ux, -S.uz));
    for (let f = 0; f < 30; f++) pw.step(DT);
    let vFoot = null;
    let vTop = null;
    let maxAlong = -Infinity;
    for (let f = 0; f < 60 * 8; f++) {
      v.setControls({ throttle: 1 });
      pw.step(DT);
      v.syncBody(pw.alpha);
      // 沿階梯往上的進度（0 = 底邊、len = 頂邊）
      const along = -((v.pos.x - S.bottom.x) * S.ux + (v.pos.z - S.bottom.z) * S.uz);
      maxAlong = Math.max(maxAlong, along);
      if (vFoot === null && along >= -vb.layout.half.z) vFoot = vb.forwardSpeed();
      if (vTop === null && along >= S.len) vTop = vb.forwardSpeed();
    }
    const blocked = vTop === null;
    const slowed = !blocked && vFoot !== null && vTop < 0.7 * vFoot;
    check('車：開上下沉廣場大階梯被擋或明顯減速（到頂速度 < 階梯底速度 70%）', blocked || slowed, `階梯底速度 ${f3(vFoot)} m/s、${blocked ? `未到頂（最遠 ${f3(maxAlong)} / ${f3(S.len)} m）` : `到頂速度 ${f3(vTop)} m/s`}`);
    done();
  }

  // ---------- 鏡頭：PhysicsOccluder 掃掠擋得住建築 ----------
  {
    const b = blds.colliders.find((c) => c.h > 20);
    const cx = b.poly.reduce((s, v, i) => (i % 2 === 0 ? s + v : s), 0) / (b.poly.length / 2);
    const cz = b.poly.reduce((s, v, i) => (i % 2 === 1 ? s + v : s), 0) / (b.poly.length / 2);
    const from = { x: cx + 80, y: b.base + 5, z: cz };
    const frac = game.occluder.sweep(from, { x: cx - 80, y: b.base + 5, z: cz }, 0.35);
    check('鏡頭：球體掃掠穿過建築的連線被擋（比例 < 1）', frac < 1, `建築 ${b.id} 比例 ${f3(frac)}`);
  }

  // ---------- 主迴圈：完整一幀耗時（含車流、行人、遠距簡化）----------
  {
    const t0 = performance.now();
    for (let f = 0; f < 300; f++) {
      player.update(DT, input, 0);
      game.step();
    }
    const avg = (performance.now() - t0) / 300;
    check('主迴圈：300 幀平均物理 + 同步耗時 < 8 ms', avg < 8, `${f3(avg)} ms`);
  }
} catch (e) {
  check('完整版執行中發生例外', false, e && e.stack ? e.stack : String(e));
}
console.log(`\n完整版：${passed} 通過 / ${failed} 失敗（其中純邏輯失敗 ${pureFailed}）`);
process.exit(failed ? 1 : 0);
