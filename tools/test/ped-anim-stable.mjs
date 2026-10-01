#!/usr/bin/env node
// 路人走路腳抖回歸（fix1-P1）：高更新率（dt 1/120、1/144）下行走中的骨架路人不得在 walk ↔ idle 間來回切、walk clip 不得反覆從頭播
// 根因：traffic.js sync 以「當幀位移 / 渲染幀時間」算動畫速度，但位置只在固定 1/60 的物理子步（或 mid 級 AI 間隔）推進，
//   > 60Hz 時約半數幀速度為 0 → 低於 animator IDLE_BELOW → 轉 idle → 下一幀回 walk（_enter reset + crossFade）
// 用法：node tools/test/ped-anim-stable.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 做法：Traffic（mock RAPIER，同 crowd.mjs）+ 真 PhysicsWorld 固定步累加器；玩家站在出生點，各 dt 跑 2 s 暖機 + 6 s 量測，
//   只統計整段都在漫步（ped.state 'walk'）且已存在 ≥ 1 s 的骨架路人；依 LOD（near / mid）分開記錄：
//   - walk ↔ idle 切換次數 = 0、進入 walk（= walk action reset + 重播）次數 = 0
//   - 送進 animator 的速度與路人路線速度 ped.speed 的相對誤差 > 25% 的取樣比例 < 2%（timeScale 不再在 1.0–2.2 間跳）
//   沒有角色 glb（工作區無 public/）時路人為方塊人：animator 狀態機照跑（無 mixer），斷言同樣有效
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

// 程序化車的車牌貼圖用 2D canvas：最小替身
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
const { getTerrain } = await import('../../src/citymodel.js');
const { computeSpawn } = await import('../../src/places.js');
const { Traffic } = await import('../../src/traffic.js');
const { qualityBudget } = await import('../../src/core/quality.js');
const { loadCharacterModels, CharacterAnimator } = await import('../../src/characters/index.js');
const { CombatSystem } = await import('../../src/combat.js');
const { PhysicsWorld } = await import('../../src/physics/world.js');
const { GROUPS } = await import('../../src/physics/groups.js');
const { createContactRouter } = await import('../../src/physics/contacts.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLIC = path.join(ROOT, 'public');
const STEP = 1 / 60; // mock World.timestep（PhysicsWorld 預設固定步）

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

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
console.log(`INFO  角色模型：${chars.fallback ? '無 glb，方塊人（animator 狀態機照跑）' : chars.variants.join(',')}`);
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
      this.timestep = STEP;
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


// animator 送入的速度：包一層 update 記下最後一次的 speed（只觀察，不改行為）
const origUpdate = CharacterAnimator.prototype.update;
CharacterAnimator.prototype.update = function (dt, ctx = {}) {
  this._testSpeed = ctx.speed ?? 0;
  this._testUpdates = (this._testUpdates || 0) + 1;
  return origUpdate.call(this, dt, ctx);
};

const LOCO = new Set(['idle', 'walk', 'run']);
const WARM = 2;
const MEASURE = 6;
const MIN_AGE = 1; // 骨架掛上後至少 1 s 才統計（掛上時 animator reset 回 idle，第一次進 walk 屬正常）
const SPEED_TOL = 0.25;

function run(dt) {
  const RAPIER = makeMockRapier();
  const pw = new PhysicsWorld(RAPIER);
  const router = createContactRouter(RAPIER, pw);
  pw.onAfterStep((d) => router.drain(d));
  pw.stepOnce();
  const game = { clock: 0 };
  const combat = new CombatSystem({ now: () => game.clock });
  const scene = new THREE.Scene();
  const traffic = new Traffic(scene, { center: spawn, terrain, physics: { RAPIER, pw, router, groups: GROUPS }, combat, budget: qualityBudget('high') });
  const player = { x: spawn.x, y: spawn.y, z: spawn.z };
  const firstSeen = new Map(); // ped → { citizen, t }（骨架池重用：同一個 ped 物件換掛市民時重新計時）
  const last = new Map(); // ped → { anim 狀態, ped.state, updates }
  const stat = {};
  const S = (lv) => stat[lv] || (stat[lv] = { peds: new Set(), switches: 0, walkEnter: 0, samples: 0, off: 0, zero: 0, minR: Infinity, maxR: 0 });
  const frames = Math.round((WARM + MEASURE) / dt);
  let t = 0;
  for (let f = 1; f <= frames; f++) {
    traffic.setView(player.x, player.z + 7, 0, -1, Math.PI / 2);
    traffic.setBlockers([player]);
    traffic.setContext({ playerInVehicle: false, vehicles: [] });
    pw.step(dt);
    game.clock += dt;
    t += dt;
    combat.update(dt);
    traffic.sync(dt, player);
    for (const p of traffic.peds) {
      const seen = firstSeen.get(p);
      if (!seen || seen.citizen !== p.citizen) firstSeen.set(p, { citizen: p.citizen, t });
      const a = p.anim;
      const prev = last.get(p);
      const cur = { st: a.state, ped: p.state, n: a._testUpdates || 0 };
      last.set(p, cur);
      if (t <= WARM || !prev || t - firstSeen.get(p).t < MIN_AGE) continue;
      if (prev.ped !== 'walk' || p.state !== 'walk' || !LOCO.has(prev.st) || !LOCO.has(cur.st)) continue;
      const s = S(p.citizen.level);
      s.peds.add(p);
      if (prev.st !== cur.st) {
        s.switches++;
        if (cur.st === 'walk') s.walkEnter++;
      }
      if (cur.n !== prev.n) {
        // 本幀有推進 animator：送入速度 vs 路線速度
        const r = a._testSpeed / p.speed;
        s.samples++;
        if (Math.abs(r - 1) > SPEED_TOL) s.off++;
        if (a._testSpeed === 0) s.zero++;
        s.minR = Math.min(s.minR, r);
        s.maxR = Math.max(s.maxR, r);
      }
    }
  }
  return stat;
}

for (const [label, dt] of [['1/60', 1 / 60], ['1/120', 1 / 120], ['1/144', 1 / 144]]) {
  const stat = run(dt);
  let total = 0;
  for (const lv of ['near', 'mid']) {
    const s = stat[lv];
    if (!s) {
      console.log(`INFO  dt ${label} ${lv}：無漫步中的骨架路人`);
      continue;
    }
    total += s.peds.size;
    const perSec = (n) => (n / s.peds.size / MEASURE).toFixed(2);
    const offFrac = s.samples ? s.off / s.samples : 0;
    console.log(`INFO  dt ${label} ${lv}：${s.peds.size} 人、切換 ${s.switches}（${perSec(s.switches)} /人·s）、進 walk ${s.walkEnter}、` +
      `速度取樣 ${s.samples}（0 速 ${s.zero}、偏差 >${SPEED_TOL * 100}% ${s.off}、速度 / 路線速度 ${s.minR.toFixed(2)}–${s.maxR.toFixed(2)}）`);
    check(`dt ${label} ${lv}：walk ↔ idle 切換 0 次`, s.switches === 0, `${s.switches} 次 / ${s.peds.size} 人`);
    check(`dt ${label} ${lv}：walk 不被重新進入（clip 不 reset）`, s.walkEnter === 0, `${s.walkEnter} 次`);
    check(`dt ${label} ${lv}：動畫速度偏離路線速度 >${SPEED_TOL * 100}% 的取樣 < 2%`, offFrac < 0.02, `${(offFrac * 100).toFixed(1)}%（${s.off}/${s.samples}）`);
  }
  check(`dt ${label}：有漫步中的骨架路人可量測`, total > 0, `${total} 人`);
}

console.log(`\nped-anim-stable.mjs：${passed} 通過 / ${failed} 失敗`);
console.log(failed ? `FAIL ${failed}/${passed + failed}` : `PASS ${passed}/${passed + failed}`);
process.exit(failed ? 1 : 0);
