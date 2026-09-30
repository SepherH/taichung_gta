// D2c2 物理核心（二）無頭驗證：車輛射線懸吊、NPC 剛體、碰撞事件路由
// 用法：
//   node tools/test/physics-vehicle.mjs             完整版（真的 import rapier 跑物理；需要 dist/rapier.mjs）
//   node tools/test/physics-vehicle.mjs --no-rapier 只跑不需要 rapier 的純邏輯（手感推導、mock 物件、d.ts 簽名核對）
// exit code：0 = 全部通過、1 = 有斷言失敗、2 = 完整版找不到 rapier
// 車型數值直接從 src/vehicle.js 的 VEHICLE_TYPES 原始碼解析（該檔 import three，不能在 node 直接載入）
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VehicleBody, deriveVehicleSpec, chassisLayout, suspensionFor, frictionSlipFor, engineAccel, driveCommand, steerLimit,
  rotateVec, yawQuat, yawOf, rollOf, upOf, wheelRayGroups, membershipOf, filterOf, makeGroups, HANDLING, SUSPENSION, COM_DROP, GRAVITY,
  ROLL_ASSIST_MAX_ROLL, OVERTURN_PROMPT_SEC,
} from '../../src/physics/vehicle-body.js';
import {
  createNpcCar, createPedestrianBody, setActiveByDistance, attachNpcReactions,
  NPC_WRECK_IMPULSE, NPC_WRECK_MIN_SEC, PED_MASS, PED_SETTLE_SEC, pedLaunch, pedLaunchFlight,
} from '../../src/physics/npc-bodies.js';
import { createContactRouter, HIT_THRESHOLDS, REARM_SEC } from '../../src/physics/contacts.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DTS = join(ROOT, 'node_modules', '@dimforge', 'rapier3d-compat', 'dist');
const NO_RAPIER = process.argv.includes('--no-rapier');
const DT = 1 / 60;
const KMH50 = 50 / 3.6;
const DEG = Math.PI / 180;
const TYPES = ['sedan', 'suv', 'taxi', 'scooter'];

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const f2 = (v) => v.toFixed(2);
const f3 = (v) => v.toFixed(3);

function loadVehicleTypes() {
  const src = readFileSync(join(ROOT, 'src', 'vehicle.js'), 'utf8');
  const m = src.match(/export const VEHICLE_TYPES = (\{[\s\S]*?\n\});/);
  if (!m) throw new Error('src/vehicle.js 找不到 VEHICLE_TYPES');
  const table = new Function(`return ${m[1]};`)();
  return Object.fromEntries(Object.entries(table).map(([type, v]) => [type, { type, ...v }]));
}
const VT = loadVehicleTypes();

// ================= d.ts 簽名解析（mock 呼叫的每個 API 都要在 d.ts 找得到、參數個數相符） =================

function splitParams(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if ('(<{['.includes(ch)) depth++;
    else if (')>}]'.includes(ch) && !(ch === '>' && cur.endsWith('='))) depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((p) => p.trim()).filter(Boolean);
}

function listDts(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...listDts(join(dir, e.name)));
    else if (e.name.endsWith('.d.ts')) out.push(join(dir, e.name));
  }
  return out;
}

function parseDts() {
  const classes = new Map();
  const enums = new Map();
  for (const file of listDts(DTS)) {
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const re = /export declare (class|enum) (\w+)[^{]*\{([\s\S]*?)\n\}/g;
    let m;
    while ((m = re.exec(text))) {
      const [, kind, name, body] = m;
      if (kind === 'enum') {
        const members = {};
        for (const mm of body.matchAll(/^\s*(\w+)\s*=\s*(-?\d+)/gm)) members[mm[1]] = Number(mm[2]);
        enums.set(name, members);
        continue;
      }
      const api = new Map();
      for (const line of body.split('\n')) {
        const fm = line.match(/^\s*(static\s+)?(?:(get|set)\s+)?(\w+)\s*(?:<[^(]*>)?\((.*)\)\s*(?::|;)/);
        if (fm) {
          const params = splitParams(fm[4]);
          const kindName = fm[2] || (fm[1] ? 'static' : fm[3] === 'constructor' ? 'constructor' : 'method');
          const min = params.filter((p) => !/^\w+\?/.test(p) && !p.startsWith('...')).length;
          api.set(`${kindName}:${fm[3]}`, { min, max: params.length });
          continue;
        }
        const pm = line.match(/^\s*(readonly\s+)?(\w+)\??\s*:/);
        if (pm) api.set(`prop:${pm[2]}`, { readonly: !!pm[1] });
      }
      if (!classes.has(name)) classes.set(name, api);
    }
  }
  return { classes, enums };
}

// ================= Rapier mock（行為夠用即可；所有存取經 Proxy 記錄，最後對 d.ts 核對） =================

const calls = new Map(); // key → { cls, kind, name, argcs:Set }
function record(cls, kind, name, argc) {
  const key = `${cls}|${kind}|${name}`;
  if (!calls.has(key)) calls.set(key, { cls, kind, name, argcs: new Set() });
  if (argc !== undefined) calls.get(key).argcs.add(argc);
}

function track(obj, cls) {
  const proxy = new Proxy(obj, {
    get(t, p) {
      const v = Reflect.get(t, p, t);
      if (typeof p !== 'string' || p.startsWith('_') || v === undefined) return v;
      if (typeof v === 'function') {
        return (...args) => {
          record(cls, 'method', p, args.length);
          const r = v.apply(t, args);
          return r === t ? proxy : r;
        };
      }
      record(cls, 'get', p);
      return v;
    },
    set(t, p, v) {
      if (typeof p === 'string' && !p.startsWith('_')) record(cls, 'set', p);
      return Reflect.set(t, p, v, t);
    },
  });
  return proxy;
}

function trackClass(C, cls) {
  return new Proxy(C, {
    get(t, p) {
      const v = Reflect.get(t, p);
      if (typeof v === 'function' && typeof p === 'string') {
        return (...args) => {
          record(cls, 'static', p, args.length);
          return v.apply(t, args);
        };
      }
      return v;
    },
    construct(t, args) {
      record(cls, 'constructor', 'constructor', args.length);
      return track(new t(...args), cls);
    },
  });
}

function strictEnum(name, members) {
  return new Proxy(members, {
    get(t, p) {
      if (typeof p !== 'string') return undefined;
      if (!(p in t)) throw new Error(`d.ts 的 enum ${name} 沒有成員 ${p}`);
      return t[p];
    },
  });
}

function makeMockRapier(dts) {
  const RBT = dts.enums.get('RigidBodyType');
  class RigidBodyDesc {
    constructor(type) {
      this._type = type;
      this._t = { x: 0, y: 0, z: 0 };
      this._q = { x: 0, y: 0, z: 0, w: 1 };
      this._mass = 0;
      this._com = null;
      this._ccd = false;
    }
    static dynamic() { return track(new RigidBodyDesc(RBT.Dynamic), 'RigidBodyDesc'); }
    static kinematicPositionBased() { return track(new RigidBodyDesc(RBT.KinematicPositionBased), 'RigidBodyDesc'); }
    setTranslation(x, y, z) { this._t = { x, y, z }; return this; }
    setRotation(q) { this._q = { ...q }; return this; }
    setCcdEnabled(b) { this._ccd = b; return this; }
    setAdditionalMassProperties(m, com, inertia, frame) { this._mass = m; this._com = com; this._inertia = inertia; this._frame = frame; return this; }
  }
  class ColliderDesc {
    constructor(shape) { this._shape = shape; this._events = 0; this._cg = null; this._sg = null; this._mass = null; }
    static cuboid(hx, hy, hz) { return track(new ColliderDesc({ type: 'cuboid', hx, hy, hz }), 'ColliderDesc'); }
    static capsule(halfHeight, radius) { return track(new ColliderDesc({ type: 'capsule', halfHeight, radius }), 'ColliderDesc'); }
    setDensity(d) { this._density = d; return this; }
    setMass(m) { this._mass = m; return this; }
    setFriction(f) { this._friction = f; return this; }
    setRestitution(r) { this._restitution = r; return this; }
    setActiveEvents(e) { this._events = e; return this; }
    setContactForceEventThreshold(t) { this._threshold = t; return this; }
    setCollisionGroups(g) { this._cg = g; return this; }
    setSolverGroups(g) { this._sg = g; return this; }
  }
  class Capsule { constructor(halfHeight, radius) { this.halfHeight = halfHeight; this.radius = radius; } }
  class Ray { constructor(origin, dir) { this.origin = origin; this.dir = dir; } }
  return {
    RigidBodyDesc: trackClass(RigidBodyDesc, 'RigidBodyDesc'),
    ColliderDesc: trackClass(ColliderDesc, 'ColliderDesc'),
    Capsule: trackClass(Capsule, 'Capsule'),
    Ray: trackClass(Ray, 'Ray'),
    RigidBodyType: strictEnum('RigidBodyType', RBT),
    ActiveEvents: strictEnum('ActiveEvents', dts.enums.get('ActiveEvents')),
    QueryFilterFlags: strictEnum('QueryFilterFlags', dts.enums.get('QueryFilterFlags')),
  };
}

class MockBody {
  constructor(desc) {
    this._type = desc._type;
    this._t = { ...desc._t };
    this._q = { ...desc._q };
    this._lv = { x: 0, y: 0, z: 0 };
    this._av = { x: 0, y: 0, z: 0 };
    this._mass = desc._mass;
    this._com = desc._com;
    this._ccd = desc._ccd;
    this._enabled = true;
    this._rot = [true, true, true];
    this._torques = [];
    this._impulses = [];
  }
  translation() { return { ...this._t }; }
  rotation() { return { ...this._q }; }
  linvel() { return { ...this._lv }; }
  angvel() { return { ...this._av }; }
  mass() { return this._mass; }
  setTranslation(t) { this._t = { ...t }; }
  setRotation(q) { this._q = { ...q }; }
  setLinvel(v) { this._lv = { ...v }; }
  setAngvel(v) { this._av = { ...v }; }
  setNextKinematicTranslation(t) { this._t = { ...t }; }
  setNextKinematicRotation(q) { this._q = { ...q }; }
  setBodyType(type) { this._type = type; }
  bodyType() { return this._type; }
  setEnabled(b) { this._enabled = b; }
  isEnabled() { return this._enabled; }
  isCcdEnabled() { return this._ccd; }
  setEnabledRotations(x, y, z) { this._rot = [x, y, z]; }
  applyImpulse(j) {
    this._impulses.push({ ...j });
    if (this._type === 0 && this._mass > 0) {
      this._lv.x += j.x / this._mass;
      this._lv.y += j.y / this._mass;
      this._lv.z += j.z / this._mass;
    }
  }
  applyTorqueImpulse(j) { this._torques.push({ ...j }); }
}

class MockCollider {
  constructor(handle, desc, parent) {
    this.handle = handle;
    this._desc = desc;
    this._parent = parent;
    this._sg = desc._sg;
  }
  parent() { return this._parent; }
  setSolverGroups(g) { this._sg = g; }
}

class MockVehicleController {
  constructor(body) {
    this._body = body;
    this._wheels = [];
    this._fwd = 0;
    this._up = 1;
    this._updates = [];
    this._contact = true; // 測試可設 false 模擬四輪離地
  }
  set setIndexForwardAxis(axis) { this._fwd = axis; }
  get indexForwardAxis() { return this._fwd; }
  set indexUpAxis(axis) { this._up = axis; }
  get indexUpAxis() { return this._up; }
  addWheel(conn, dir, axle, rest, radius) { this._wheels.push({ conn, dir, axle, rest, radius, steer: 0, engine: 0, brake: 0 }); }
  setWheelSuspensionStiffness(i, v) { this._wheels[i].stiffness = v; }
  setWheelSuspensionCompression(i, v) { this._wheels[i].compression = v; }
  setWheelSuspensionRelaxation(i, v) { this._wheels[i].relaxation = v; }
  setWheelMaxSuspensionTravel(i, v) { this._wheels[i].maxTravel = v; }
  setWheelMaxSuspensionForce(i, v) { this._wheels[i].maxForce = v; }
  setWheelFrictionSlip(i, v) { this._wheels[i].frictionSlip = v; }
  setWheelSideFrictionStiffness(i, v) { this._wheels[i].side = v; }
  setWheelSteering(i, v) { this._wheels[i].steer = v; }
  setWheelEngineForce(i, v) { this._wheels[i].engine = v; }
  setWheelBrake(i, v) { this._wheels[i].brake = v; }
  updateVehicle(dt, flags, groups) { this._updates.push({ dt, flags, groups }); }
  currentVehicleSpeed() {
    const f = rotateVec(this._body._q, { x: 0, y: 0, z: 1 });
    return this._body._lv.x * f.x + this._body._lv.y * f.y + this._body._lv.z * f.z;
  }
  wheelHardPoint(i) {
    const c = rotateVec(this._body._q, this._wheels[i].conn);
    return { x: this._body._t.x + c.x, y: this._body._t.y + c.y, z: this._body._t.z + c.z };
  }
  wheelSuspensionLength(i) { return this._wheels[i].rest; }
  wheelRotation() { return 0; }
  wheelSteering(i) { return this._wheels[i].steer; }
  wheelIsInContact() { return this._contact; }
}

class MockWorld {
  constructor() {
    this.timestep = DT;
    this._colliders = new Map();
    this._bodies = new Set();
    this._controllers = new Set();
    this._nextHandle = 1;
    this._blocker = () => null;
  }
  createRigidBody(desc) {
    const b = track(new MockBody(desc), 'RigidBody');
    this._bodies.add(b);
    return b;
  }
  createCollider(desc, parent) {
    const c = track(new MockCollider(this._nextHandle++, desc, parent), 'Collider');
    if (desc._mass && !parent._mass) parent._mass = desc._mass;
    this._colliders.set(c.handle, c);
    return c;
  }
  createVehicleController(body) {
    const vc = track(new MockVehicleController(body), 'DynamicRayCastVehicleController');
    this._controllers.add(vc);
    return vc;
  }
  removeVehicleController(vc) { this._controllers.delete(vc); }
  removeRigidBody(body) { this._bodies.delete(body); }
  getCollider(handle) { return this._colliders.get(handle); }
  castRay(ray, maxToi) {
    if (ray.dir.y >= 0 || ray.origin.y < 0 || ray.origin.y > maxToi) return null;
    return { timeOfImpact: ray.origin.y, collider: null };
  }
  intersectionWithShape(pos) { return this._blocker(pos); }
}

class MockForceEvent {
  constructor(h1, h2, force, dir) { this._h1 = h1; this._h2 = h2; this._f = force; this._d = dir; }
  collider1() { return this._h1; }
  collider2() { return this._h2; }
  totalForceMagnitude() { return this._f; }
  maxForceDirection() { return { ...this._d }; }
}

class MockEventQueue {
  constructor() { this._force = []; this._coll = []; }
  drainContactForceEvents(f) {
    const list = this._force;
    this._force = [];
    for (const e of list) f(track(e, 'TempContactForceEvent'));
  }
  drainCollisionEvents(f) {
    const list = this._coll;
    this._coll = [];
    for (const [a, b, s] of list) f(a, b, s);
  }
}

// 測試用 collision groups（D2c1 的 groups.js 之後會提供同名鍵；此處只為了驗證位元運算）
function testGroups() {
  const bit = { WORLD: 0, PLAYER: 1, VEHICLE: 2, NPC_CAR: 3, PEDESTRIAN: 4, SENSOR: 5, DEBRIS: 6 };
  const all = 0x7f;
  const out = {};
  for (const [k, b] of Object.entries(bit)) out[k] = makeGroups(1 << b, k === 'SENSOR' ? (1 << 1) | (1 << 2) : all & ~(1 << 5));
  return out;
}

// ================= 純邏輯測試 =================

function runPureTests(dts) {
  console.log('\n[純邏輯] 規格推導 / 懸吊幾何');
  check('VEHICLE_TYPES 解析出 4 種車型', TYPES.every((t) => VT[t]), Object.keys(VT).join(','));
  const sedan = deriveVehicleSpec(VT.sedan);
  const scooter = deriveVehicleSpec(VT.scooter);
  check('缺值推導：wheelbase = L×0.6、track = W×0.85、輪半徑 0.34 / 0.26',
    near(sedan.wheelbase, 2.7, 1e-9) && near(sedan.track, 1.85 * 0.85, 1e-9) && sedan.wheelRadius === 0.34 && scooter.wheelRadius === 0.26 && scooter.twoWheeler,
    `sedan wb=${f2(sedan.wheelbase)} track=${f3(sedan.track)} mass=${sedan.mass}`);
  const custom = deriveVehicleSpec({ ...VT.sedan, wheelbase: 2.9, track: 1.6, wheelRadius: 0.33, mass: 1500 });
  check('manifest 欄位優先於推導值', custom.wheelbase === 2.9 && custom.track === 1.6 && custom.wheelRadius === 0.33 && custom.mass === 1500);

  for (const t of TYPES) {
    const spec = deriveVehicleSpec(VT[t]);
    const L = chassisLayout(spec);
    const s = suspensionFor(spec);
    const hardAbove = L.centerY + L.wheels[0].y;
    const wheelBottom = hardAbove - (s.restLength - L.sag) - spec.wheelRadius;
    const reach = s.restLength + spec.wheelRadius >= hardAbove;
    check(`${t}：靜態下沉 ${f3(L.sag)} m 在 0.04–0.15 且 < maxTravel、靜止時輪底貼地、射線搆得到地面`,
      L.sag >= 0.04 && L.sag <= 0.15 && L.sag < s.maxTravel && near(wheelBottom, 0, 1e-9) && reach && L.comHeight > 0,
      `質心高 ${f3(L.comHeight)} m、硬點離地 ${f3(hardAbove)} m`);
    const fs = frictionSlipFor(spec, L);
    const brakeNeed = (0.5 * spec.brake) / GRAVITY; // 縱向衝量以 0.5 權重計入打滑判斷
    const rollLimit = spec.twoWheeler ? Infinity : (spec.track / 2) / L.comHeight;
    check(`${t}：frictionSlip ${f2(fs)} 低於翻覆門檻 ${f2(rollLimit)}、足夠支撐煞車 ${f2(brakeNeed)}`, fs < rollLimit && fs > brakeNeed);
  }

  console.log('\n[純邏輯] 手感曲線（1D 縱向模型，理想抓地）');
  for (const t of TYPES) {
    const spec = deriveVehicleSpec(VT[t]);
    const n = spec.twoWheeler ? 2 : 4;
    let v = 0;
    let t50 = null;
    let vmaxSeen = 0;
    for (let i = 0; i < 600; i++) {
      const cmd = driveCommand(spec, { throttle: 1, brake: 0 }, v, DT);
      v += ((cmd.engineForce * n) / spec.mass) * DT;
      vmaxSeen = Math.max(vmaxSeen, v);
      if (t50 === null && v >= KMH50) t50 = (i + 1) * DT;
    }
    check(`${t}：0→50 km/h ${f2(t50)} s 在 2.5–5.5、10 s 達極速 ${f2(v / spec.maxSpeed * 100)}% ≥ 90%、不超速`,
      t50 >= 2.5 && t50 <= 5.5 && v >= 0.9 * spec.maxSpeed && vmaxSeen <= spec.maxSpeed * 1.001);
    // 煞車：衝量 × 輪數 / (m·dt) = spec.brake
    const b = driveCommand(spec, { throttle: 0, brake: 1 }, KMH50, DT);
    const decel = (b.brakeImpulse * n) / (spec.mass * DT);
    const coast = driveCommand(spec, { throttle: 0, brake: 0 }, 10, DT);
    check(`${t}：煞車減速 ${f2(decel)} = brake、理想煞車距離 ${f2((KMH50 * KMH50) / (2 * decel))} m、滑行阻力 3 m/s²、煞車時引擎力為 0`,
      near(decel, spec.brake, 1e-9) && b.engineForce === 0 && near((coast.brakeImpulse * n) / (spec.mass * DT), HANDLING.coastDecel, 1e-9));
    // 坡道平衡速度：engineAccel(v) = g·sinθ
    const eq = (deg) => {
      const need = GRAVITY * Math.sin(deg * DEG);
      let lo = 0;
      let hi = spec.maxSpeed;
      if (engineAccel(spec, 0) < need) return 0;
      for (let k = 0; k < 60; k++) {
        const mid = (lo + hi) / 2;
        if (engineAccel(spec, mid) > need) lo = mid;
        else hi = mid;
      }
      return lo;
    };
    const e10 = eq(10) / spec.maxSpeed;
    const e25 = eq(25) / spec.maxSpeed;
    check(`${t}：10° 坡平衡速度 ${f2(e10 * 100)}% 極速（可爬）、25° 坡 ${f2(e25 * 100)}%（明顯減速 < 75%）`, e10 > 0.8 && e25 < 0.75);
    const rev = driveCommand(spec, { throttle: -1, brake: 0 }, 5, DT);
    check(`${t}：前進中打倒車 = 煞車（引擎力 0）`, rev.engineForce === 0 && rev.brakeImpulse > 0);
  }

  console.log('\n[純邏輯] 轉向上限');
  for (const t of TYPES) {
    const spec = deriveVehicleSpec(VT[t]);
    let mono = true;
    let prev = Infinity;
    for (let v = 0; v <= spec.maxSpeed; v += 0.5) {
      const a = steerLimit(spec, v);
      if (a > prev + 1e-12 || a > HANDLING.maxWheelAngle + 1e-12) mono = false;
      prev = a;
    }
    let maxErr = 0;
    for (const v of [8, 15, 20]) {
      const legacy = (spec.turnRate * Math.min(1, v / 4)) / (1 + v / 18);
      const phys = (v * Math.tan(steerLimit(spec, v))) / spec.wheelbase;
      maxErr = Math.max(maxErr, Math.abs(phys - legacy) / legacy);
    }
    check(`${t}：轉角上限隨速度遞減、≤ ${HANDLING.maxWheelAngle} rad、偏航率與既有手感誤差 ${f2(maxErr * 100)}% < 5%`, mono && maxErr < 0.05,
      `低速 ${f3(steerLimit(spec, 1))} / 極速 ${f3(steerLimit(spec, spec.maxSpeed))} rad`);
  }

  console.log('\n[純邏輯] 四元數 / collision groups');
  const qa = yawQuat(1.2);
  const qr = { x: 0, y: 0, z: Math.sin(5 * DEG), w: Math.cos(5 * DEG) };
  const fwd = rotateVec(yawQuat(Math.PI / 2), { x: 0, y: 0, z: 1 });
  check('yawOf(yawQuat) 還原、繞前進軸 10° 的 roll = 10°、yaw 90° 前方 = +X、upOf 單位向量',
    near(yawOf(qa), 1.2, 1e-9) && near(rollOf(qr), 10 * DEG, 1e-9) && near(fwd.x, 1, 1e-9) && near(upOf(qr).y, Math.cos(10 * DEG), 1e-9));
  const G = testGroups();
  const rg = wheelRayGroups(G);
  const mOf = (k) => membershipOf(G[k]);
  check('車輪射線 groups：身分 VEHICLE、打 WORLD / VEHICLE / NPC_CAR / DEBRIS、不打 PEDESTRIAN / SENSOR',
    membershipOf(rg) === mOf('VEHICLE') && (filterOf(rg) & mOf('WORLD')) && (filterOf(rg) & mOf('NPC_CAR')) && (filterOf(rg) & mOf('DEBRIS')) &&
      !(filterOf(rg) & mOf('PEDESTRIAN')) && !(filterOf(rg) & mOf('SENSOR')));

  console.log('\n[純邏輯] VehicleBody（mock Rapier）');
  const R = makeMockRapier(dts);
  const RBT = dts.enums.get('RigidBodyType');
  for (const t of TYPES) {
    const w = new MockWorld();
    const vb = new VehicleBody(R, { world: w }, VT[t], { x: 1, y: 2, z: 3, yaw: 0.5, groups: G, ccd: t === 'sedan' });
    const vc = [...w._controllers][0];
    const n = t === 'scooter' ? 2 : 4;
    const bt = vb.body;
    check(`${t}：${n} 輪、前進軸 = 2（+Z）、質心下移 ${COM_DROP} m、collider density 0、groups = VEHICLE、CCD ${t === 'sedan'}`,
      vc._wheels.length === n && vc._fwd === 2 && vc._up === 1 && bt._com.y === -COM_DROP && bt._mass === vb.spec.mass &&
        vb.collider._desc._density === 0 && vb.collider._desc._cg === G.VEHICLE && bt._ccd === (t === 'sedan') &&
        vc._wheels.every((wh) => wh.radius === vb.spec.wheelRadius && wh.dir.y === -1 && wh.axle.x === -1 && wh.stiffness > 0));
  }
  {
    const w = new MockWorld();
    const vb = new VehicleBody(R, w, VT.sedan, { groups: G });
    const vc = [...w._controllers][0];
    vb.setControls({ throttle: 1 });
    vb.preStep(DT);
    const sumF = vc._wheels.reduce((s, wh) => s + wh.engine, 0);
    check('全油門：四輪引擎力合計 = m × engineAccel(0)、updateVehicle(dt, EXCLUDE_SENSORS, 射線 groups)',
      near(sumF, vb.spec.mass * engineAccel(vb.spec, 0), 1e-6) && vc._updates.length === 1 && vc._updates[0].dt === DT &&
        vc._updates[0].groups === wheelRayGroups(G) && vc._updates[0].flags === dts.enums.get('QueryFilterFlags').EXCLUDE_SENSORS,
      `ΣF = ${sumF.toFixed(0)} N`);
    vb.setControls({ throttle: 0, steer: 1 });
    vb.preStep(DT);
    const expSteer = HANDLING.steerRate * DT * steerLimit(vb.spec, 0);
    check('轉向平滑：一步後前輪轉角 = 4/s × dt × 上限、後輪 0', near(vc._wheels[0].steer, expSteer, 1e-9) && vc._wheels[2].steer === 0,
      `${f3(vc._wheels[0].steer)} rad`);
    vb.setControls({ throttle: 1, handbrake: true });
    vb.preStep(DT);
    check('手煞車：後輪 frictionSlip × 0.35、後輪引擎 0 且鎖煞、前輪照常出力',
      near(vc._wheels[2].frictionSlip, vb.frictionSlip * HANDLING.handbrakeRearFriction, 1e-9) && vc._wheels[2].engine === 0 &&
        vc._wheels[2].brake > 0 && vc._wheels[0].engine > 0 && near(vc._wheels[0].frictionSlip, vb.frictionSlip, 1e-9));
    vb.setControls({ throttle: 0 });
    vb.preStep(DT);
    check('放開手煞車：後輪抓地恢復', near(vc._wheels[3].frictionSlip, vb.frictionSlip, 1e-9));
    vb.setControls({ brake: 1, throttle: 1 });
    vb.preStep(DT);
    check('煞車優先於油門：引擎力 0、煞車衝量 = m·brake·dt/4', vc._wheels.every((wh) => wh.engine === 0 && near(wh.brake, (vb.spec.mass * vb.spec.brake * DT) / 4, 1e-9)));
    const st = vb.getState();
    check('getState：位置 / 四元數 / 帶號速度 / 4 輪（x,y,z,rotation,steer,inContact,suspensionLength）',
      ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw', 'speed'].every((k) => typeof st[k] === 'number') && st.wheels.length === 4 &&
        st.wheels.every((wh) => ['x', 'y', 'z', 'rotation', 'steer', 'suspensionLength'].every((k) => typeof wh[k] === 'number') && wh.inContact === true));
    const y0 = vb.body._t.y;
    vb.body._q = { x: Math.sin(0.8), y: 0, z: 0, w: Math.cos(0.8) };
    vb.body._lv = { x: 3, y: 0, z: 0 };
    vb.flip();
    check('flip()：抬高 1 m、轉正（up.y = 1）、速度歸零', near(vb.body._t.y, y0 + 1, 1e-9) && near(upOf(vb.body._q).y, 1, 1e-9) && vb.body._lv.x === 0);
    vb.setKinematic(true);
    const k1 = vb.body._type === RBT.KinematicPositionBased;
    const nUpd = vc._updates.length;
    vb.preStep(DT);
    vb.setKinematic(false);
    check('setKinematic：切 KinematicPositionBased（期間不 updateVehicle）→ 切回 Dynamic', k1 && vc._updates.length === nUpd && vb.body._type === RBT.Dynamic);
    vb.dispose();
    check('dispose()：移除 vehicle controller 與剛體', w._controllers.size === 0 && w._bodies.size === 0);
  }
  {
    const w = new MockWorld();
    const vb = new VehicleBody(R, w, VT.scooter, { groups: G });
    vb.body._q = { x: 0, y: 0, z: Math.sin(5 * DEG), w: Math.cos(5 * DEG) };
    vb.preStep(DT);
    const tq = vb.body._torques.at(-1);
    check('機車防傾：右傾 10° 時施加繞前進軸的反向力矩衝量', tq && tq.z < 0 && Math.abs(tq.x) < 1e-9, `τ·dt = ${f3(tq.z)} N·m·s`);
  }
  {
    // 汽車翻覆：只在有輪接地且 |roll| < 60° 時回正；翻覆持續 OVERTURN_PROMPT_SEC 後才該提示按 R
    const w = new MockWorld();
    const vb = new VehicleBody(R, w, VT.sedan, { groups: G });
    const vc = [...w._controllers][0];
    const rollQ = (deg) => ({ x: 0, y: 0, z: Math.sin((deg * DEG) / 2), w: Math.cos((deg * DEG) / 2) });
    vb.body._q = rollQ(30);
    vb.preStep(DT);
    const t30 = vb.body._torques.length;
    vb.body._q = rollQ(ROLL_ASSIST_MAX_ROLL / DEG + 1);
    const n0 = vb.body._torques.length;
    const steps = Math.ceil(OVERTURN_PROMPT_SEC / DT);
    for (let i = 0; i < steps - 1; i++) vb.preStep(DT);
    const early = vb.overturnedTime < OVERTURN_PROMPT_SEC;
    vb.preStep(DT);
    const noTorque61 = vb.body._torques.length === n0;
    const due = vb.overturnedTime >= OVERTURN_PROMPT_SEC - 1e-9;
    check(`汽車回正輔助：roll 30° 接地 → 施力；roll ${f2(ROLL_ASSIST_MAX_ROLL / DEG + 1)}° → 不施力、${steps} 步後 overturnedTime ${f2(vb.overturnedTime)} s ≥ ${OVERTURN_PROMPT_SEC}（前一步未達）`,
      t30 === 1 && noTorque61 && due && early);
    vb.body._q = rollQ(180);
    vb.overturnedTime = 0;
    for (let i = 0; i < 30; i++) vb.preStep(DT);
    check('汽車倒扣（roll 180°）：0.5 s 內不施加回正力矩', vb.body._torques.length === n0);
    vb.body._q = rollQ(20);
    vc._contact = false;
    vb.preStep(DT);
    check('汽車四輪離地（roll 20°）：不施力、overturnedTime 累計', vb.body._torques.length === n0 && vb.overturnedTime > 0);
    vc._contact = true;
    vb.preStep(DT);
    check('重新接地且 roll < 60°：恢復施力、overturnedTime 歸零', vb.body._torques.length === n0 + 1 && vb.overturnedTime === 0);
    vb.body._q = rollQ(180);
    vb.preStep(DT);
    vb.flip();
    check('flip() 後 overturnedTime 歸零', vb.overturnedTime === 0);
    const sc = new VehicleBody(R, new MockWorld(), VT.scooter, { groups: G });
    sc.body._q = rollQ(70);
    sc.preStep(DT);
    check('機車 roll 70° 仍維持防傾力矩', sc.body._torques.length === 1 && sc.body._torques[0].z < 0);
  }
  {
    // 手煞車偏航率上限：超出 handbrakeMaxYawRate 才施加反向偏航力矩
    const w = new MockWorld();
    const vb = new VehicleBody(R, w, VT.sedan, { groups: G });
    vb.setControls({ handbrake: true, steer: 1 });
    vb.body._av = { x: 0, y: HANDLING.handbrakeMaxYawRate - 0.1, z: 0 };
    vb.preStep(DT);
    const below = vb.body._torques.filter((t) => Math.abs(t.y) > 1e-9).length;
    vb.body._av = { x: 0, y: HANDLING.handbrakeMaxYawRate + 1, z: 0 };
    vb.preStep(DT);
    const tq = vb.body._torques.at(-1);
    const expect = -vb.inertia.y * 1 * Math.min(1, HANDLING.handbrakeYawDamping * DT);
    vb.setControls({ steer: 1 });
    const n1 = vb.body._torques.length;
    vb.preStep(DT);
    const released = vb.body._torques.slice(n1).filter((t) => Math.abs(t.y) > 1e-9).length;
    check(`手煞車偏航阻尼：${HANDLING.handbrakeMaxYawRate} rad/s 以下不施力、超出 1 rad/s → τ·dt ${f2(tq.y)}（預期 ${f2(expect)}）、放開手煞車不施力`,
      below === 0 && near(tq.y, expect, 1e-6) && released === 0);
  }

  console.log('\n[純邏輯] NPC 車 / 行人（mock Rapier）');
  {
    const w = new MockWorld();
    const npc = createNpcCar(R, w, VT.sedan, { x: 0, y: 0, z: 0, yaw: 0 }, { groups: G });
    check('NPC 車預設 kinematicPositionBased、groups = NPC_CAR、開接觸力事件',
      npc.body._type === RBT.KinematicPositionBased && npc.collider._desc._cg === G.NPC_CAR && (npc.collider._desc._events & dts.enums.get('ActiveEvents').CONTACT_FORCE_EVENTS));
    npc.setTargetPose(0, 0, 0, 0, DT);
    npc.setTargetPose(0, 0, 0.2, 0, DT);
    check('setTargetPose → setNextKinematicTranslation（y = 地面 + 車身中心高）、估出車道速度 12 m/s',
      near(npc.body._t.z, 0.2, 1e-9) && near(npc.body._t.y, npc.layout.centerY, 1e-9) && near(npc.laneVel.z, 12, 1e-6));
    const weak = npc.hit({ impulse: NPC_WRECK_IMPULSE * 0.5, dir: { x: 1, y: 0, z: 0 } });
    const strong = npc.hit({ impulse: NPC_WRECK_IMPULSE * 2, dir: { x: 1, y: 0, z: 0 } });
    check('低於門檻不 wreck；超過門檻 → Dynamic + 沿用車道速度 + 施加衝量',
      !weak && strong && npc.isWrecked && npc.body._type === RBT.Dynamic && near(npc.body._lv.x, (NPC_WRECK_IMPULSE * 2) / npc.spec.mass, 1e-6) && near(npc.body._lv.z, 12, 1e-6));
    npc.update(1);
    const early = npc.recover();
    npc.update(NPC_WRECK_MIN_SEC);
    const stillMoving = npc.canRecover;
    npc.body._lv = { x: 0.2, y: 0, z: 0 };
    const ok = npc.recover();
    check(`wrecked 未滿 ${NPC_WRECK_MIN_SEC} s 或速度 ≥ 0.5 不能交還；滿足後 recover() → kinematic`,
      !early && !stillMoving && ok && !npc.isWrecked && npc.body._type === RBT.KinematicPositionBased && typeof npc.getPose().yaw === 'number');
  }
  {
    const w = new MockWorld();
    const ped = createPedestrianBody(R, w, { x: 5, y: 0, z: 5, yaw: 0 }, { groups: G });
    const sg = ped.collider._sg;
    check('行人：kinematic 膠囊（半高 0.6、半徑 0.3）、kinematic 期間 solver groups 排除車輛（仍保留碰撞事件）',
      ped.body._type === RBT.KinematicPositionBased && ped.collider._desc._shape.halfHeight === 0.6 && ped.collider._desc._shape.radius === 0.3 &&
        !(filterOf(sg) & mOf('VEHICLE')) && !(filterOf(sg) & mOf('NPC_CAR')) && (filterOf(sg) & mOf('WORLD')) && ped.isGhost &&
        (ped.collider._desc._events & dts.enums.get('ActiveEvents').COLLISION_EVENTS));
    const first = ped.hit({ impulse: 99999, dir: { x: 0, y: 0, z: 1 } });
    check('hit → Dynamic、yawOnly 只開 Y 軸旋轉、恢復實體碰撞、衝量上限 70 kg × 12 m/s',
      first && ped.isDown && ped.body._type === RBT.Dynamic && ped.body._rot.join() === 'false,true,false' && ped.collider._sg === G.PEDESTRIAN &&
        near(ped.body._lv.z, 12, 1e-9));
    let r = ped.settleCheck(DT);
    const movingNotSettled = !r.settled;
    ped.body._lv = { x: 0.1, y: 0, z: 0 };
    let steps = 0;
    do {
      r = ped.settleCheck(DT);
      steps++;
    } while (!r.settled && steps < 200);
    check(`settleCheck：移動中未落穩；速度 < 0.3 持續 ${PED_SETTLE_SEC} s（${steps} 步）後 settled 且 clearToStand`,
      movingNotSettled && r.settled && r.clearToStand && near(steps * DT, PED_SETTLE_SEC, DT * 1.01));
    w._blocker = () => ({ handle: 999 });
    const blocked = ped.settleCheck(DT);
    const noStand = ped.recover();
    w._blocker = () => null;
    const stand = ped.recover(0.3);
    check('站立空間被擋 → clearToStand false、recover() 回 null；空出後 recover() → kinematic、solver groups 回到排除車輛',
      blocked.settled && !blocked.clearToStand && noStand === null && stand && near(stand.y, 0, 1e-9) && ped.body._type === RBT.KinematicPositionBased &&
        ped.collider._sg === sg && !ped.isDown);
    const free = createPedestrianBody(R, w, { x: 0, y: 0, z: 0, yaw: 0 }, { groups: G, rotationMode: 'free' });
    free.hit({ impulse: 100, dir: { x: 1, y: 0, z: 0 } });
    let threw = false;
    try {
      createPedestrianBody(R, w, { x: 0, y: 0, z: 0 }, { rotationMode: 'ragdoll' });
    } catch {
      threw = true;
    }
    check('rotationMode free 允許三軸旋轉；未知模式丟錯', free.body._rot.join() === 'true,true,true' && threw);
  }
  {
    // 被車撞上拋分級：30 km/h 拋高 0.6–1.0 m、落地前水平飛 5–9 m（平地拋體近似；修正前一律 lift 0.25）
    const KMH30 = 30 / 3.6;
    const fl = pedLaunchFlight(PED_MASS * KMH30);
    const old = { apex: (0.25 * KMH30) ** 2 / (2 * GRAVITY), distance: (KMH30 * 2 * 0.25 * KMH30) / GRAVITY };
    check(`30 km/h 撞行人：拋高 ${f2(fl.apex)} m（0.6–1.0）、水平飛 ${f2(fl.distance)} m（5–9）；修正前 ${f2(old.apex)} m / ${f2(old.distance)} m`,
      fl.apex >= 0.6 && fl.apex <= 1.0 && fl.distance >= 5 && fl.distance <= 9);
    const tiers = [20, 40, 60].map((k) => pedLaunchFlight((PED_MASS * k) / 3.6));
    check(`上拋隨車速遞增：20 / 40 / 60 km/h 拋高 ${tiers.map((t) => f2(t.apex)).join(' / ')} m、飛 ${tiers.map((t) => f2(t.distance)).join(' / ')} m`,
      tiers[0].apex < fl.apex && fl.apex < tiers[1].apex && tiers[1].apex <= tiers[2].apex);
    const punch = pedLaunch(120);
    check(`拳擊擊倒（120 N·s）上拋維持 0.25 倍：${f3(punch.vertical)} m/s`, near(punch.vertical, (120 / PED_MASS) * 0.25, 1e-9));
    const w = new MockWorld();
    const ped = createPedestrianBody(R, w, { x: 0, y: 0, z: 0, yaw: 0 }, { groups: G });
    ped.hit({ impulse: PED_MASS * KMH30, dir: { x: 0, y: 0, z: 1 } });
    const l30 = pedLaunch(PED_MASS * KMH30);
    check(`hit(30 km/h) 初速：水平 ${f2(ped.body._lv.z)}、向上 ${f2(ped.body._lv.y)} m/s`, near(ped.body._lv.z, l30.horizontal, 1e-9) && near(ped.body._lv.y, l30.vertical, 1e-9));
  }
  {
    const w = new MockWorld();
    const npc = createNpcCar(R, w, VT.suv, { x: 100, y: 0, z: 0, yaw: 0 }, { groups: G });
    const far = createPedestrianBody(R, w, { x: 300, y: 0, z: 0, yaw: 0 }, { groups: G });
    const edge = createPedestrianBody(R, w, { x: 0, y: 0, z: 255, yaw: 0 }, { groups: G });
    const list = [npc, far, edge];
    const r1 = setActiveByDistance(list, 0, 0);
    check('setActiveByDistance(250)：300 m 外停用、255 m（緩衝內）保持啟用', r1.deactivated === 1 && !far.active && far.body._enabled === false && edge.active);
    far.setPose(240, 0, 0, 0);
    const r2 = setActiveByDistance(list, 0, 0);
    check('停用期間仍接受 pose，以新 pose 判距：回到半徑內重新啟用並套用（handle 不變）', r2.deactivated === 0 && r2.activated === 1 && far.active && near(far.body._t.x, 240, 1e-9));
    const r3 = setActiveByDistance(list, 100, 0);
    npc.hit({ impulse: NPC_WRECK_IMPULSE * 2, dir: { x: 0, y: 0, z: 1 } });
    setActiveByDistance(list, 500, 0);
    const wreckKept = !npc.active && npc.isWrecked;
    setActiveByDistance(list, 100, 0);
    check('停用 / 再啟用保留狀態（wrecked、位置）', r3.activated === 0 && far.active && wreckKept && npc.active && npc.isWrecked);
  }

  console.log('\n[純邏輯] 碰撞事件路由（mock EventQueue）');
  {
    const w = new MockWorld();
    const eq = new MockEventQueue();
    const router = createContactRouter(R, { world: w, eventQueue: eq });
    const car = new VehicleBody(R, w, VT.sedan, { groups: G, ccd: true });
    router.register(car.collider, car);
    const npc = createNpcCar(R, w, VT.taxi, { x: 0, y: 0, z: 6, yaw: 0 }, { groups: G, router });
    const ped = createPedestrianBody(R, w, { x: 0, y: 0, z: -6, yaw: 0 }, { groups: G, router });
    const wall = w.createCollider(R.ColliderDesc.cuboid(5, 2, 0.2), w.createRigidBody(R.RigidBodyDesc.kinematicPositionBased()));
    const got = { world: [], vehicle: [], ped: [] };
    router.onVehicleHitWorld((e) => got.world.push(e));
    router.onVehicleHitVehicle((e) => got.vehicle.push(e));
    const offPed = router.onVehicleHitPedestrian((e) => got.ped.push(e));
    const detach = attachNpcReactions(router);
    const force = (imp) => imp / DT;
    car.body._lv = { x: 0, y: 0, z: 20 };
    eq._force.push(new MockForceEvent(wall.handle, car.collider.handle, force(HIT_THRESHOLDS.world * 0.5), { x: 0, y: 0, z: 1 }));
    router.drain(DT);
    const below = got.world.length === 0;
    eq._force.push(new MockForceEvent(wall.handle, car.collider.handle, force(5000), { x: 0, y: 0, z: 1 }));
    router.drain(DT);
    eq._force.push(new MockForceEvent(car.collider.handle, wall.handle, force(5000), { x: 0, y: 0, z: 1 }));
    router.drain(DT);
    const once = got.world.length === 1;
    for (let i = 0; i < Math.ceil(REARM_SEC / DT) + 2; i++) router.drain(DT);
    eq._force.push(new MockForceEvent(wall.handle, car.collider.handle, force(5000), { x: 0, y: 0, z: 1 }));
    router.drain(DT);
    check('撞牆：低於門檻不發；超過門檻發 onVehicleHitWorld 一次、持續接觸不重發、分開 > REARM_SEC 後再發',
      below && once && got.world.length === 2 && got.world[0].vehicle === car && near(got.world[0].impulse, 5000, 1e-6) && got.world[0].dir.z < 0,
      `impulse=${got.world[0] && got.world[0].impulse.toFixed(0)} N·s、dir.z=${got.world[0] && got.world[0].dir.z}`);
    eq._force.push(new MockForceEvent(npc.collider.handle, car.collider.handle, force(NPC_WRECK_IMPULSE * 1.5), { x: 0, y: 0, z: -1 }));
    router.drain(DT);
    const ev = got.vehicle[0];
    check('車撞 NPC 車：a = 玩家車、b = NPC、dir 推向 b；attachNpcReactions 讓 NPC wreck 並被推向 +Z',
      ev && ev.a === car && ev.b === npc && ev.dir.z > 0 && npc.isWrecked && npc.body._lv.z > 0);
    car.body._lv = { x: 0, y: 0, z: -10 };
    eq._coll.push([ped.collider.handle, car.collider.handle, true]);
    router.drain(DT);
    eq._force.push(new MockForceEvent(ped.collider.handle, car.collider.handle, force(500), { x: 0, y: 0, z: 1 }));
    eq._coll.push([ped.collider.handle, car.collider.handle, false]);
    router.drain(DT);
    const pe = got.ped[0];
    check('車撞 kinematic 行人：碰撞開始事件估衝量 = 70 kg × 相對速度，只發一次；行人切 dynamic 往 −Z 飛',
      got.ped.length === 1 && pe.vehicle === car && pe.ped === ped && near(pe.impulse, PED_MASS * 10, 1e-6) && near(pe.relSpeed, 10, 1e-9) &&
        ped.isDown && ped.body._lv.z < 0);
    const slow = createPedestrianBody(R, w, { x: 9, y: 0, z: 9, yaw: 0 }, { groups: G, router });
    car.body._lv = { x: 0, y: 0, z: 1 };
    eq._coll.push([car.collider.handle, slow.collider.handle, true]);
    router.drain(DT);
    offPed();
    detach();
    router.unregister(slow.collider);
    check('低相對速度（1 m/s）不算撞人；取消訂閱 / unregister 生效', got.ped.length === 1 && !slow.isDown && router.entityOf(slow.collider.handle) === null);
  }

  console.log('\n[純邏輯] d.ts 簽名核對（mock 經手的每個 API）');
  let bad = [];
  for (const c of calls.values()) {
    const api = dts.classes.get(c.cls);
    if (!api) {
      bad.push(`${c.cls}（d.ts 無此類別）`);
      continue;
    }
    let sig;
    if (c.kind === 'get') sig = api.get(`get:${c.name}`) || api.get(`prop:${c.name}`) || api.get(`method:${c.name}`);
    else if (c.kind === 'set') sig = api.get(`set:${c.name}`) || (api.get(`prop:${c.name}`) && !api.get(`prop:${c.name}`).readonly ? {} : null);
    else sig = api.get(`${c.kind}:${c.name}`);
    if (!sig) {
      bad.push(`${c.cls}.${c.name}（${c.kind}）`);
      continue;
    }
    if (sig.min !== undefined) for (const n of c.argcs) if (n < sig.min || n > sig.max) bad.push(`${c.cls}.${c.name} 參數 ${n} 個（d.ts ${sig.min}–${sig.max}）`);
  }
  check(`${calls.size} 個 API（類別.方法）全數存在於 d.ts 且參數個數相符`, bad.length === 0, bad.join('；'));
}

// ================= 完整版（真的跑 Rapier） =================

async function loadRapier() {
  try {
    const mod = await import('@dimforge/rapier3d-compat');
    const RAPIER = mod.default ?? mod;
    await RAPIER.init();
    return RAPIER;
  } catch (err) {
    console.error('\n✘ 找不到可執行的 @dimforge/rapier3d-compat（需要 node_modules/@dimforge/rapier3d-compat/dist/rapier.mjs）。');
    console.error(`  原因：${err.code || ''} ${err.message.split('\n')[0]}`);
    console.error('  工作區只有型別檔時請改跑：node tools/test/physics-vehicle.mjs --no-rapier');
    process.exit(2);
  }
}

// 測試場景：平地、一面牆（z = WALL_Z）、10° / 25° 坡（各自獨立的 x 走廊）
const WALL_Z = 60;
const RAMP_Z0 = 20;
const RAMP_LEN = 20;
const LANE_X = { flat: 0, ramp10: 40, ramp25: 80 };

function buildWorld(RAPIER, groups) {
  const world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
  world.timestep = DT;
  const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const add = (desc) => world.createCollider(desc.setCollisionGroups(groups.WORLD).setSolverGroups(groups.WORLD).setFriction(1), fixed);
  add(RAPIER.ColliderDesc.cuboid(600, 0.5, 600).setTranslation(0, -0.5, 0));
  // 薄牆（0.3 m 厚），100 km/h 一步移動 0.46 m > 牆厚，沒有 CCD 就會穿過
  add(RAPIER.ColliderDesc.cuboid(10, 2, 0.15).setTranslation(LANE_X.flat, 2, WALL_Z + 0.15));
  for (const [key, deg] of [['ramp10', 10], ['ramp25', 25]]) {
    const th = deg * DEG;
    const ht = 0.25;
    const x = LANE_X[key];
    const q = { x: Math.sin(-th / 2), y: 0, z: 0, w: Math.cos(-th / 2) };
    add(RAPIER.ColliderDesc.cuboid(4, ht, RAMP_LEN / 2).setRotation(q)
      .setTranslation(x, (RAMP_LEN / 2) * Math.sin(th) - ht * Math.cos(th), RAMP_Z0 + (RAMP_LEN / 2) * Math.cos(th) + ht * Math.sin(th)));
    const h = RAMP_LEN * Math.sin(th);
    const zEnd = RAMP_Z0 + RAMP_LEN * Math.cos(th);
    add(RAPIER.ColliderDesc.cuboid(4, h / 2, 15).setTranslation(x, h / 2, zEnd + 15));
  }
  const eventQueue = new RAPIER.EventQueue(true);
  return { world, eventQueue };
}

function stepAll(env, vehicles, n, each) {
  for (let i = 0; i < n; i++) {
    for (const v of vehicles) v.preStep(DT);
    env.world.step(env.eventQueue);
    if (env.router) env.router.drain(DT);
    if (each && each(i) === false) return i;
  }
  return n;
}

const pitchOf = (q) => Math.asin(Math.max(-1, Math.min(1, rotateVec(q, { x: 0, y: 0, z: 1 }).y)));

async function runRapierTests() {
  const RAPIER = await loadRapier();
  const G = testGroups();
  console.log(`\n[Rapier ${RAPIER.version ? RAPIER.version() : ''}] 物理情境`);
  const fresh = (type, pose, opts = {}) => {
    const env = buildWorld(RAPIER, G);
    const vb = new VehicleBody(RAPIER, env.world, VT[type], { groups: G, ccd: true, ...pose, ...opts });
    return { env, vb };
  };
  const setForwardSpeed = (vb, v) => {
    const f = rotateVec(vb.body.rotation(), { x: 0, y: 0, z: 1 });
    vb.body.setLinvel({ x: f.x * v, y: 0, z: f.z * v }, true);
  };
  const flatZ = -40;
  const results = {};

  for (const t of TYPES) {
    const r = (results[t] = {});
    // 1. 靜置 3 秒
    {
      const { env, vb } = fresh(t, { x: LANE_X.flat, z: flatZ });
      stepAll(env, [vb], 180);
      const s = vb.getState();
      const q = { x: s.qx, y: s.qy, z: s.qz, w: s.qw };
      const comp = s.wheels.map((w) => vb.susp.restLength - w.suspensionLength);
      const roll = Math.abs(rollOf(q)) / DEG;
      const pitch = Math.abs(pitchOf(q)) / DEG;
      check(`${t} 靜置 3 s：輪全接地、roll ${f2(roll)}° pitch ${f2(pitch)}° < 2°、懸吊壓縮 [${comp.map(f3).join(', ')}] m 在 0.02–${f2(vb.susp.maxTravel)}`,
        s.wheels.every((w) => w.inContact) && roll < 2 && pitch < 2 && comp.every((c) => c > 0.02 && c < vb.susp.maxTravel));
    }
    // 2. 全油門直線 10 秒
    {
      const { env, vb } = fresh(t, { x: LANE_X.flat, z: -300 });
      stepAll(env, [vb], 30);
      vb.setControls({ throttle: 1 });
      let t50 = null;
      let vmax = 0;
      stepAll(env, [vb], 600, (i) => {
        const v = vb.forwardSpeed();
        vmax = Math.max(vmax, v);
        if (t50 === null && v >= KMH50) t50 = (i + 1) * DT;
      });
      r.t50 = t50;
      r.vmax = vmax;
      const err = Math.abs(vmax - vb.spec.maxSpeed) / vb.spec.maxSpeed;
      check(`${t} 全油門 10 s：最高 ${f2(vmax)} m/s vs maxSpeed ${vb.spec.maxSpeed}（差 ${f2(err * 100)}% < 10%）、0→50 km/h ${t50 === null ? '未達' : f2(t50) + ' s'}`,
        err < 0.1 && t50 !== null);
    }
    // 3. 全速 + 滿舵 5 秒
    {
      const { env, vb } = fresh(t, { x: LANE_X.flat, z: -300 });
      stepAll(env, [vb], 30);
      setForwardSpeed(vb, vb.spec.maxSpeed);
      vb.setControls({ throttle: 1, steer: 1 });
      let minUp = 1;
      stepAll(env, [vb], 300, () => {
        minUp = Math.min(minUp, upOf(vb.body.rotation()).y);
      });
      r.minUp = minUp;
      check(`${t} 全速 + 滿舵 5 s：最低 up.y = ${f3(minUp)} > 0.5（不翻${t === 'scooter' ? '、不倒' : ''}）`, minUp > 0.5);
    }
    // 4. 煞車距離 50 → 0
    {
      const { env, vb } = fresh(t, { x: LANE_X.flat, z: -300 });
      stepAll(env, [vb], 60);
      setForwardSpeed(vb, KMH50);
      const z0 = vb.body.translation().z;
      vb.setControls({ brake: 1 });
      const n = stepAll(env, [vb], 600, () => vb.forwardSpeed() > 0.1);
      r.brakeDist = vb.body.translation().z - z0;
      check(`${t} 煞車 50→0：${f2(r.brakeDist)} m（${f2((n + 1) * DT)} s；理想 ${f2((KMH50 * KMH50) / (2 * vb.spec.brake))} m），3–15 m`, r.brakeDist > 3 && r.brakeDist < 15);
    }
    // 5. 坡道
    {
      const climb = (key, deg) => {
        const { env, vb } = fresh(t, { x: LANE_X[key], z: RAMP_Z0 - 15 });
        stepAll(env, [vb], 30);
        vb.setControls({ throttle: 1 });
        const zEnd = RAMP_Z0 + RAMP_LEN * Math.cos(deg * DEG);
        let vTop = null;
        stepAll(env, [vb], 900, () => {
          const p = vb.body.translation();
          if (vTop === null && p.z >= zEnd) vTop = vb.forwardSpeed();
          return p.z < zEnd + 10;
        });
        const p = vb.body.translation();
        return { reached: vTop !== null, vTop, z: p.z, y: p.y };
      };
      const a = climb('ramp10', 10);
      const b = climb('ramp25', 25);
      r.ramp10 = a;
      r.ramp25 = b;
      check(`${t} 10° 坡：${a.reached ? `爬上（坡頂 ${f2(a.vTop)} m/s）` : '未爬上'}，最終 z=${f2(a.z)} y=${f2(a.y)}`, a.reached);
      check(`${t} 25° 坡：${b.reached ? `爬上但坡頂 ${f2(b.vTop)} m/s` : '爬不上'}，最終 z=${f2(b.z)} y=${f2(b.y)}（需爬不上或坡頂速度 < 10° 的 70%）`,
        !b.reached || (a.reached && b.vTop < 0.7 * a.vTop));
    }
    // 6. 100 km/h 正面撞牆
    {
      const { env, vb } = fresh(t, { x: LANE_X.flat, z: WALL_Z - 20 });
      env.router = createContactRouter(RAPIER, env.world, env.eventQueue);
      env.router.register(vb.collider, vb);
      const hits = [];
      env.router.onVehicleHitWorld((e) => hits.push(e));
      stepAll(env, [vb], 20);
      setForwardSpeed(vb, 100 / 3.6);
      let maxFront = -Infinity;
      stepAll(env, [vb], 120, () => {
        maxFront = Math.max(maxFront, vb.body.translation().z + vb.layout.half.z);
      });
      const maxImp = Math.max(0, ...hits.map((h) => h.impulse));
      check(`${t} 100 km/h 撞牆：車頭最遠 z=${f2(maxFront)}（牆面 ${WALL_Z}）不穿牆、onVehicleHitWorld ${hits.length} 次、最大衝量 ${maxImp.toFixed(0)} N·s > ${HIT_THRESHOLDS.world}`,
        maxFront < WALL_Z + 0.3 && hits.length >= 1 && maxImp > HIT_THRESHOLDS.world);
    }
  }

  // 6b. 70 km/h 手煞車 + 滿舵 2 s 的轉向角（目標 90–150°；修正前約 230°）、倒扣不自動翻回、側傾仍回正
  for (const t of ['sedan', 'taxi', 'suv']) {
    const { env, vb } = fresh(t, { x: LANE_X.flat, z: -300 });
    stepAll(env, [vb], 30);
    setForwardSpeed(vb, 70 / 3.6);
    vb.setControls({ throttle: 0, steer: 1, handbrake: true });
    let prev = yawOf(vb.body.rotation());
    let turned = 0;
    stepAll(env, [vb], 120, () => {
      const y = yawOf(vb.body.rotation());
      turned += Math.atan2(Math.sin(y - prev), Math.cos(y - prev));
      prev = y;
    });
    const deg = Math.abs(turned) / DEG;
    check(`${t} 70 km/h 手煞車 + 滿舵 2 s：轉 ${f2(deg)}°（90–150°）、末速 ${f2(Math.abs(vb.forwardSpeed()) * 3.6)} km/h`, deg >= 90 && deg <= 150);
  }
  {
    const { env, vb } = fresh('sedan', { x: LANE_X.flat, z: -250, y: 1.5 });
    vb.body.setRotation({ x: 0, y: 0, z: 1, w: 0 }, true); // 繞前進軸 180°：倒扣
    let dueAt = null;
    stepAll(env, [vb], 180, (i) => {
      if (dueAt === null && vb.overturnedTime >= OVERTURN_PROMPT_SEC - 1e-9) dueAt = (i + 1) * DT;
    });
    const upEnd = upOf(vb.body.rotation()).y;
    check(`sedan 倒扣 3 s：不自動翻回（最終 up.y ${f3(upEnd)} < 0）、${dueAt === null ? '未達提示' : f2(dueAt) + ' s 起可提示按 R'}（≥ ${OVERTURN_PROMPT_SEC} s）`,
      upEnd < 0 && dueAt !== null && dueAt >= OVERTURN_PROMPT_SEC - 1e-9);
    vb.flip();
    stepAll(env, [vb], 120);
    check(`按 R（flip）後轉正：up.y ${f3(upOf(vb.body.rotation()).y)} > 0.95、overturnedTime ${f2(vb.overturnedTime)}`, upOf(vb.body.rotation()).y > 0.95 && vb.overturnedTime === 0);
  }
  {
    const { env, vb } = fresh('sedan', { x: LANE_X.flat, z: -200, y: 0.6 });
    vb.body.setRotation({ x: 0, y: 0, z: Math.sin(20 * DEG), w: Math.cos(20 * DEG) }, true); // 側傾 40°
    stepAll(env, [vb], 180);
    const upEnd = upOf(vb.body.rotation()).y;
    check(`sedan 側傾 40° 放下 3 s：回正 up.y ${f3(upEnd)} > 0.95`, upEnd > 0.95);
  }

  // 7. 車撞 NPC 車、車撞行人
  {
    const env = buildWorld(RAPIER, G);
    env.router = createContactRouter(RAPIER, env.world, env.eventQueue);
    attachNpcReactions(env.router);
    const car = new VehicleBody(RAPIER, env.world, VT.sedan, { x: 0, z: -30, groups: G, ccd: true });
    env.router.register(car.collider, car);
    const npc = createNpcCar(RAPIER, env.world, VT.sedan, { x: 0, y: 0, z: -10, yaw: Math.PI / 2 }, { groups: G, router: env.router });
    stepAll(env, [car], 20);
    setForwardSpeed(car, 15);
    car.setControls({ throttle: 1 });
    const start = npc.body.translation();
    stepAll(env, [car], 180, () => {
      if (!npc.isWrecked) npc.setTargetPose(0, 0, -10, Math.PI / 2, DT);
      npc.update(DT);
    });
    const end = npc.body.translation();
    const moved = Math.hypot(end.x - start.x, end.z - start.z);
    check(`車撞 NPC 車（15 m/s）：NPC wrecked=${npc.isWrecked}、切 Dynamic、被推動 ${f2(moved)} m > 0.5`,
      npc.isWrecked && npc.body.bodyType() === RAPIER.RigidBodyType.Dynamic && moved > 0.5);
    car.setControls({ brake: 1 });
    stepAll(env, [car], 600, () => npc.update(DT));
    const rec = npc.recover();
    check(`NPC wrecked ${NPC_WRECK_MIN_SEC}+ s 且停下後 recover() 交還車道邏輯`, rec && npc.body.bodyType() === RAPIER.RigidBodyType.KinematicPositionBased);
  }
  for (const mode of ['yawOnly', 'free']) {
    const env = buildWorld(RAPIER, G);
    env.router = createContactRouter(RAPIER, env.world, env.eventQueue);
    attachNpcReactions(env.router);
    const car = new VehicleBody(RAPIER, env.world, VT.sedan, { x: 0, z: -30, groups: G, ccd: true });
    env.router.register(car.collider, car);
    const ped = createPedestrianBody(RAPIER, env.world, { x: 0, y: 0, z: -12, yaw: 0 }, { groups: G, router: env.router, rotationMode: mode });
    const pedHits = [];
    env.router.onVehicleHitPedestrian((e) => pedHits.push(e));
    stepAll(env, [car], 20);
    setForwardSpeed(car, 12);
    car.setControls({ throttle: 0.3 });
    let settle = { settled: false, clearToStand: false };
    let tSettle = null;
    stepAll(env, [car], 600, (i) => {
      if (ped.isDown) car.setControls({ brake: 1 });
      else ped.setPose(0, 0, -12, 0);
      settle = ped.settleCheck(DT);
      if (ped.isDown && settle.settled && tSettle === null) tSettle = (i + 1) * DT;
      return !(ped.isDown && settle.settled && settle.clearToStand && i > 240);
    });
    const p = ped.body.translation();
    check(`車撞行人（12 m/s，${mode}）：onVehicleHitPedestrian ${pedHits.length} 次（衝量 ${pedHits[0] ? pedHits[0].impulse.toFixed(0) : '-'} N·s）、行人切 dynamic、`
      + `${tSettle === null ? '未落穩' : `${f2(tSettle)} s 落穩`}、clearToStand=${settle.clearToStand}、停在 z=${f2(p.z)}`,
      pedHits.length === 1 && ped.isDown && settle.settled && settle.clearToStand);
  }

  // 7b. 30 km/h 撞行人：實際拋高與落地前水平距離（目標 0.6–1.0 m、5–9 m；修正前拋高 0.17–0.28 m）
  {
    const env = buildWorld(RAPIER, G);
    env.router = createContactRouter(RAPIER, env.world, env.eventQueue);
    attachNpcReactions(env.router);
    const car = new VehicleBody(RAPIER, env.world, VT.sedan, { x: 0, z: -40, groups: G, ccd: true });
    env.router.register(car.collider, car);
    const ped = createPedestrianBody(RAPIER, env.world, { x: 0, y: 0, z: -12, yaw: 0 }, { groups: G, router: env.router });
    stepAll(env, [car], 20);
    setForwardSpeed(car, 30 / 3.6);
    car.setControls({ throttle: 0.3 });
    let y0 = null;
    let z0 = null;
    let apex = 0;
    let flight = null;
    stepAll(env, [car], 300, () => {
      const p = ped.body.translation();
      if (!ped.isDown) {
        ped.setPose(0, 0, -12, 0);
        return true;
      }
      car.setControls({ brake: 1 });
      if (y0 === null) {
        y0 = p.y;
        z0 = p.z;
      }
      apex = Math.max(apex, p.y - y0);
      if (flight === null && apex > 0.05 && p.y <= y0 + 0.02) flight = Math.abs(p.z - z0);
      return flight === null;
    });
    check(`車撞行人 30 km/h（真物理）：拋高 ${f2(apex)} m（0.6–1.0）、落地前水平飛 ${flight === null ? '未落地' : f2(flight) + ' m'}（5–9）`,
      apex >= 0.6 && apex <= 1.0 && flight !== null && flight >= 5 && flight <= 9);
  }

  // 8. 1000 步平均耗時（10 台車 + 20 行人）
  {
    const env = buildWorld(RAPIER, G);
    env.router = createContactRouter(RAPIER, env.world, env.eventQueue);
    const cars = [];
    for (let i = 0; i < 10; i++) {
      const vb = new VehicleBody(RAPIER, env.world, VT[TYPES[i % 4]], { x: -200 + i * 40, z: -200, groups: G, ccd: i === 0 });
      vb.setControls({ throttle: 0.6, steer: 0.4 });
      env.router.register(vb.collider, vb);
      cars.push(vb);
    }
    const peds = [];
    for (let i = 0; i < 20; i++) peds.push(createPedestrianBody(RAPIER, env.world, { x: -200 + i * 20, y: 0, z: -150, yaw: 0 }, { groups: G, router: env.router }));
    const t0 = performance.now();
    stepAll(env, cars, 1000, (i) => {
      for (let k = 0; k < peds.length; k++) peds[k].setPose(-200 + k * 20 + Math.sin(i * DT) * 3, 0, -150, 0);
    });
    const avg = (performance.now() - t0) / 1000;
    check(`1000 步平均步進耗時 ${avg.toFixed(3)} ms（10 車 + 20 行人，含 preStep 與 drain）< 16.7 ms`, avg < 16.7);
  }
}

// ================= 主程式 =================

console.log(`D2c2 physics-vehicle 無頭驗證（${NO_RAPIER ? '--no-rapier：只跑純邏輯' : '完整版'}）`);
runPureTests(parseDts());
if (!NO_RAPIER) await runRapierTests();
console.log(`\n結果：${passed} 通過 / ${failed} 失敗${NO_RAPIER ? '（完整版 Rapier 情境未執行）' : ''}`);
process.exit(failed ? 1 : 0);
