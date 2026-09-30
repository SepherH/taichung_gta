// 車輛：外型（轎車 / 計程車 / 休旅車 / 公車 / 機車）與駕駛
// 本地座標前方為 +Z、左方為 +X；yaw 定義與玩家相同：前進方向 = (sin(yaw), cos(yaw))
// 外觀：有 glb（vehicle-model.js，manifest 驅動）用 glb，否則退回本檔的程序化方塊車；glb 的長寬高 / 軸距 / 輪距 / 輪徑 / 質量 / 座位點
//   併入 this.spec（覆寫 VEHICLE_TYPES 的外形欄位，手感欄位 maxSpeed / accel / … 不變），VehicleBody / NPC 剛體以此 spec 建立
// 兩種模式：
// - 物理模式（attachBody 後，玩家駕駛 / 停放車）：Rapier 動態剛體 + 射線懸吊（src/physics/vehicle-body.js），
//   網格依插值後的底盤姿態擺放（網格原點在輪底 = 底盤中心沿車身 up 往下 layout.centerY），四輪依 getState 同步轉動 / 轉向 / 懸吊高度
//   停放車平時是 kinematic（原地不動、擋得住人車），被撞超過門檻（contacts.js）才醒來成為動態；無人駕駛的車靜止 PARK_REST_SEC 後再切回 kinematic
// - 無物理模式（車流 NPC 的車道擺放、tools/test/placement.mjs）：貼地 = 四個輪位 querySurface 的平均；pitch（正 = 車頭朝上）/
//   roll（正 = 左側高）依前後 / 左右輪高度差低通平滑；坡度 > MAX_DRIVE_SLOPE 的上坡、湖面、下沉廣場大階梯、退台間陡坡視同撞牆
import * as THREE from 'three';
import { cachedStandardMaterial, clamp, makeTextTexture } from './utils.js';
import { pushOutOfCircles } from './collision.js';
import { registerNight } from './daynight.js';
import { SURFACE_OFFSET } from './data/city.js';
import { VehicleBody, rotateVec, yawOf } from './physics/vehicle-body.js';
import { createVehicleModel, vehicleTemplateMaterials, EMISSIVE_MATERIALS, SEAT_HIPS_HEIGHT } from './vehicle-model.js';

export const VEHICLE_TYPES = {
  sedan: { label: '轎車', length: 4.5, width: 1.85, height: 1.45, maxSpeed: 34, maxReverse: 8, accel: 8, brake: 18, turnRate: 1.7, camScale: 1.35 },
  taxi: { label: '計程車', length: 4.5, width: 1.85, height: 1.45, maxSpeed: 32, maxReverse: 8, accel: 8, brake: 18, turnRate: 1.7, camScale: 1.35 },
  suv: { label: '休旅車', length: 4.9, width: 2.0, height: 1.8, maxSpeed: 31, maxReverse: 7, accel: 7, brake: 16, turnRate: 1.5, camScale: 1.45 },
  scooter: { label: '機車', length: 1.9, width: 0.7, height: 1.1, maxSpeed: 22, maxReverse: 3, accel: 9, brake: 14, turnRate: 2.4, camScale: 1.0, twoWheeler: true },
  // 公車：外形取 docs/ref/qiuhonggu-opera-vehicle-reference.md §4.1（12.19 × 2.50 × 3.14 m）；極速 / 加減速 / 轉向為手感設定（推測）
  bus: { label: '公車', length: 12.2, width: 2.5, height: 3.14, maxSpeed: 16, maxReverse: 4, accel: 2.5, brake: 7, turnRate: 0.8, camScale: 2.4 },
};

// 程序化車（無 glb）的座位點（本地座標，角色 drive 動作 Hips 位置；推測值，依方塊車外形目測）
const FALLBACK_SEAT = {
  sedan: { x: 0.37, y: 0.55, z: -0.2 },
  taxi: { x: 0.37, y: 0.55, z: -0.2 },
  suv: { x: 0.38, y: 0.75, z: -0.25 },
  bus: { x: 0.72, y: 1.35, z: 4.8 },
  scooter: { x: 0, y: 0.84, z: -0.25 },
};
const FALLBACK_PAINT = '#f2f2ee'; // 呼叫端未給車色（例：公車用 manifest 預設塗裝）而又沒有 glb 時的程序化車色
const WHEEL_RADIUS_MESH = 0.34; // 程序化汽車輪半徑（carWheelGeo）
const WHEEL_RADIUS_MESH_BIKE = 0.26; // 程序化機車輪半徑（scooterWheelGeo）
const nightRegistered = new WeakSet(); // glb 共用材質只登記一次夜間發光

const MAX_DRIVE_SLOPE = 30; // 可爬上的最大坡度（°）
const MIN_DRIVE_NY = Math.cos((MAX_DRIVE_SLOPE * Math.PI) / 180);
const DRIVE_STEP_UP = 0.35; // 輪子可直接開上的不連續高差（m）：湖上甲板高出步道 0.3 m（terrain.js DECK_RISE，推測）
const TILT_RATE = 8; // pitch / roll 低通的收斂速率（1/s）
const NO_DRIVE_CELLS = new Set(['stairs', 'riser']);
// 物理模式：無人駕駛的車速度 / 角速度低於門檻持續 PARK_REST_SEC 秒 → 切回 kinematic 停放
const PARK_REST_SPEED = 0.1;
const PARK_REST_SEC = 1;

// 駕駛輸入 → VehicleBody.setControls：axis = input.moveAxis()（駕駛時 y = 油門正 / 煞車倒車負，x = 轉向右正）；
// VehicleBody 的 steer +1 = 左轉，所以取 −x；throttle 負值在前進中是煞車、停下後才倒車（driveCommand）
export function driveControls(axis, handbrake) {
  return { throttle: axis.y, steer: -axis.x, brake: 0, handbrake: !!handbrake };
}

// 網格輪子 holder → VehicleBody 輪序（汽車 0 左前、1 右前、2 左後、3 右後；機車 0 前、1 後）：以左右（x 正負）與前後（z 正負）對應
export function wheelMeshMap(holders, layoutWheels) {
  return holders.map((h) => layoutWheels.findIndex((w) => Math.sign(w.x) === Math.sign(h.x) && w.front === h.z > 0));
}

// 底盤中心 (p, q) → 網格原點（輪底）：沿車身 up 往下 centerY
export function meshOrigin(p, q, centerY, out = { x: 0, y: 0, z: 0 }) {
  const d = rotateVec(q, { x: 0, y: -centerY, z: 0 });
  out.x = p.x + d.x;
  out.y = p.y + d.y;
  out.z = p.z + d.z;
  return out;
}

// 輪位（相對車身中心）：hx = 半輪距、hz = 半軸距；有 glb 規格（wheelbase / track）時直接取用，
// 否則與 createVehicleMesh 的輪子位置相同（機車取前後輪中點）
export function wheelOffsets(spec) {
  if (Number.isFinite(spec.wheelbase) && Number.isFinite(spec.track)) {
    return { hx: spec.twoWheeler ? spec.width / 2 : spec.track / 2, hz: spec.wheelbase / 2 };
  }
  if (spec.twoWheeler) return { hx: spec.width / 2, hz: spec.length / 2 - 0.3 };
  return { hx: spec.width / 2 - 0.08, hz: spec.length / 2 - 0.85 };
}

// 共用材質
const glassMat = new THREE.MeshStandardMaterial({ color: 0x1d2630, roughness: 0.15, metalness: 0.6 });
const tireMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 });
const headMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, emissive: 0xfff4d8, emissiveIntensity: 0 });
const tailMat = new THREE.MeshStandardMaterial({ color: 0x8a1010, emissive: 0xff2020, emissiveIntensity: 0 });
registerNight(headMat, 2.0);
registerNight(tailMat, 1.5);
let taxiSignMat = null;

const carWheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.26, 14).rotateZ(Math.PI / 2);
const scooterWheelGeo = new THREE.CylinderGeometry(0.26, 0.26, 0.12, 12).rotateZ(Math.PI / 2);

function part(geo, mat, x, y, z) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

// 建立車輛外型；回傳 Group，userData.wheels / frontWheels 供動畫使用
export function createVehicleMesh(type, color) {
  const spec = VEHICLE_TYPES[type];
  const g = new THREE.Group();
  const paint = cachedStandardMaterial(color, { roughness: 0.35, metalness: 0.3 });
  const wheels = [];
  const frontWheels = [];

  if (type === 'scooter') {
    const dark = cachedStandardMaterial('#1c1c1c');
    g.add(part(new THREE.BoxGeometry(0.46, 0.36, 1.15), paint, 0, 0.52, -0.1));
    g.add(part(new THREE.BoxGeometry(0.4, 0.1, 0.55), dark, 0, 0.32, 0.2));
    g.add(part(new THREE.BoxGeometry(0.38, 0.12, 0.62), dark, 0, 0.78, -0.25));
    g.add(part(new THREE.BoxGeometry(0.32, 0.85, 0.2), paint, 0, 0.72, 0.62));
    g.add(part(new THREE.BoxGeometry(0.72, 0.06, 0.06), dark, 0, 1.16, 0.64));
    g.add(part(new THREE.BoxGeometry(0.18, 0.1, 0.05), headMat, 0, 1.0, 0.73));
    g.add(part(new THREE.BoxGeometry(0.2, 0.08, 0.05), tailMat, 0, 0.62, -0.69));
    const fw = new THREE.Group();
    fw.position.set(0, 0.26, 0.66);
    fw.add(part(scooterWheelGeo, tireMat, 0, 0, 0));
    const rw = new THREE.Group();
    rw.position.set(0, 0.26, -0.62);
    rw.add(part(scooterWheelGeo, tireMat, 0, 0, 0));
    g.add(fw, rw);
    wheels.push(fw.children[0], rw.children[0]);
    frontWheels.push(fw);
  } else {
    const L = spec.length;
    const W = spec.width;
    const tall = type === 'suv' || type === 'bus';
    const bodyH = tall ? 0.85 : 0.65;
    const bodyY = tall ? 0.78 : 0.62;
    const cabH = tall ? 0.72 : 0.55;
    const cabLen = tall ? L * 0.62 : L * 0.5;
    g.add(part(new THREE.BoxGeometry(W, bodyH, L), paint, 0, bodyY, 0));
    const cabY = bodyY + bodyH / 2 + cabH / 2;
    g.add(part(new THREE.BoxGeometry(W * 0.86, cabH, cabLen), glassMat, 0, cabY, tall ? -0.25 : -0.2));
    g.add(part(new THREE.BoxGeometry(W * 0.84, 0.08, cabLen * 0.94), paint, 0, cabY + cabH / 2 + 0.04, tall ? -0.25 : -0.2));
    // 車燈
    for (const s of [-1, 1]) {
      g.add(part(new THREE.BoxGeometry(0.42, 0.16, 0.05), headMat, s * W * 0.32, bodyY + 0.1, L / 2 + 0.01));
      g.add(part(new THREE.BoxGeometry(0.42, 0.14, 0.05), tailMat, s * W * 0.32, bodyY + 0.12, -L / 2 - 0.01));
    }
    // 計程車頂燈
    if (type === 'taxi') {
      if (!taxiSignMat) {
        taxiSignMat = new THREE.MeshBasicMaterial({
          map: makeTextTexture('TAXI', { width: 256, height: 96, bg: '#f5c518', color: '#111111' }),
          toneMapped: false,
        });
      }
      g.add(part(new THREE.BoxGeometry(0.8, 0.26, 0.34), taxiSignMat, 0, cabY + cabH / 2 + 0.21, -0.2));
    }
    // 車輪
    const { hx: wx, hz: wz } = wheelOffsets(spec);
    for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
      const holder = new THREE.Group();
      holder.position.set(sx * wx, 0.34, sz * wz);
      const wheel = part(carWheelGeo, tireMat, 0, 0, 0);
      holder.add(wheel);
      g.add(holder);
      wheels.push(wheel);
      if (sz > 0) frontWheels.push(holder);
    }
  }
  g.userData.wheels = wheels;
  g.userData.frontWheels = frontWheels;
  return g;
}

// 輪子骨架：[{ holder（懸吊高度）, spin（rotation.x 滾動）, steer（rotation.y 轉向）}]
// glb 的輪子節點三者為同一個（旋轉順序 YXZ）；程序化車 holder = 轉向群組、spin = 其下的輪胎網格
function wheelRig(mesh) {
  return mesh.userData.wheels.map((w) => (mesh.userData.glb ? { holder: w, spin: w, steer: w } : { holder: w.parent, spin: w, steer: w.parent }));
}

// glb 的車燈 / 計程車燈箱材質登記夜間發光（上限 = 美術設定的 emissiveIntensity）
function registerModelNight(type) {
  for (const m of vehicleTemplateMaterials(type)) {
    if (!EMISSIVE_MATERIALS.includes(m.name) || nightRegistered.has(m)) continue;
    nightRegistered.add(m);
    registerNight(m, m.emissiveIntensity || 1);
  }
}

export class Vehicle {
  constructor(scene, type, color, x, z, yaw) {
    this.type = type;
    const model = createVehicleModel(type, color);
    if (model) registerModelNight(type);
    this.spec = { ...VEHICLE_TYPES[type], seat: FALLBACK_SEAT[type], doorSide: 1, ...(model ? model.spec : {}) };
    this.mesh = model ? model.root : createVehicleMesh(type, color || FALLBACK_PAINT);
    this.wheelRig = wheelRig(this.mesh);
    this.mesh.rotation.order = 'YXZ'; // 先 roll、再 pitch、最後 yaw
    scene.add(this.mesh);
    this.pos = new THREE.Vector3(x, 0, z);
    this.yaw = yaw;
    this.speed = 0; // 沿車頭方向的速度（m/s，負值為倒車）
    this.vx = 0; // 實際速度向量（手煞車時會與車頭方向分離，產生甩尾）
    this.vz = 0;
    this.steer = 0;
    this.driven = false;
    this.ai = false;
    this.wheelSpin = 0;
    this.pitch = 0;
    this.roll = 0;
    this.lean = 0; // 機車轉彎傾斜
    this.wheelY = [0, 0, 0, 0]; // 左前、右前、左後、右後輪位的地面高度
    this._circles = [{ x: 0, z: 0, r: 0 }, { x: 0, z: 0, r: 0 }];
    this._q = {};
    this.body = null; // 物理模式的 VehicleBody
    this.interp = null; // PhysicsWorld.register 的插值 handle
    this.rest = 0; // 無人駕駛時已靜止的秒數
    this.syncMesh();
  }

  // 切到物理模式：vb = VehicleBody、interp = PhysicsWorld.register(vb.body)
  attachBody(vb, interp) {
    this.body = vb;
    this.interp = interp;
    this._wheelIdx = wheelMeshMap(this.wheelRig.map((r) => r.holder.position), vb.layout.wheels);
    this._q4 = { x: 0, y: 0, z: 0, w: 1 };
    this._origin = { x: 0, y: 0, z: 0 };
  }

  setControls(c) {
    this.body.setControls(c);
  }

  // 翻車自救：抬高、轉正（VehicleBody.flip），插值狀態對齊新位置
  flip() {
    this.body.flip();
    this.interp.reset();
  }

  // 物理 step 之後呼叫：網格依插值姿態擺放；pos / yaw / speed 供鏡頭、HUD、上下車使用
  syncBody(alpha) {
    const vb = this.body;
    const o = this.interp.interpolate(alpha);
    const q = this._q4;
    q.x = o.qx;
    q.y = o.qy;
    q.z = o.qz;
    q.w = o.qw;
    const m = meshOrigin(o, q, vb.layout.centerY, this._origin);
    this.pos.set(m.x, m.y, m.z);
    this.yaw = yawOf(q);
    this.speed = vb.kinematic ? 0 : vb.forwardSpeed();
    this.mesh.position.set(m.x, m.y + SURFACE_OFFSET, m.z);
    this.mesh.quaternion.set(q.x, q.y, q.z, q.w);
    // 四輪：懸吊長度 → 輪心高度（網格本地 = 硬點 y − 懸吊長 + centerY）、滾動角（前進為正，同 animate）、前輪轉向角
    // kinematic 停放期間控制器不更新（懸吊長度無效），輪子放在靜態下沉位置、維持最後的滾動角
    const st = vb.kinematic ? null : vb.getState();
    const staticLen = vb.susp.restLength - vb.layout.sag;
    this.wheelRig.forEach((r, k) => {
      const i = this._wheelIdx[k];
      const w = st && st.wheels[i];
      r.holder.position.y = vb.layout.wheels[i].y - (w ? w.suspensionLength : staticLen) + vb.layout.centerY;
      if (!w) return;
      r.spin.rotation.x = w.rotation;
      r.steer.rotation.y = w.steer;
    });
  }

  // 駕駛座上角色原點的世界座標（座位點 = drive 動作 Hips，角色原點 = 座位點 − Hips 高）；網格矩陣需已更新
  seatWorld(out = new THREE.Vector3()) {
    const s = this.spec.seat;
    this.mesh.updateMatrixWorld();
    return this.mesh.localToWorld(out.set(s.x, s.y - SEAT_HIPS_HEIGHT, s.z));
  }

  // 輪位世界座標（k：0 左前、1 右前、2 左後、3 右後），寫進 out = { x, z }
  wheelPos(k, x = this.pos.x, z = this.pos.z, yaw = this.yaw, out = {}) {
    const { hx, hz } = wheelOffsets(this.spec);
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const sx = k % 2 === 0 ? hx : -hx; // 左方 = (cos, −sin) = 本地 +X
    const sz = k < 2 ? hz : -hz;
    out.x = x + fx * sz + fz * sx;
    out.z = z + fz * sz - fx * sx;
    return out;
  }

  // 貼地：四輪 querySurface（yHint = 目前車身高）→ 車身 y = 平均；pitch / roll 低通（snap = 直接到位）
  settle(terrain, dt, snap = false) {
    const { hx, hz } = wheelOffsets(this.spec);
    const p = {};
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      this.wheelPos(k, this.pos.x, this.pos.z, this.yaw, p);
      this.wheelY[k] = terrain.querySurface(p.x, p.z, this.pos.y, this._q).y;
      sum += this.wheelY[k];
    }
    const [lf, rf, lr, rr] = this.wheelY;
    this.pos.y = sum / 4;
    const pitch = Math.atan2((lf + rf - lr - rr) / 2, 2 * hz);
    const roll = this.spec.twoWheeler ? 0 : Math.atan2((lf + lr - rf - rr) / 2, 2 * hx);
    const k = snap ? 1 : 1 - Math.exp(-TILT_RATE * dt);
    this.pitch += (pitch - this.pitch) * k;
    this.roll += (roll - this.roll) * k;
  }

  // 以 (x, z, yaw) 擺放時，行進方向（dir > 0 前進）的兩個領先輪位是否開不上去
  drivableBlocked(terrain, x, z, yaw, dir) {
    const mx = Math.sin(yaw) * dir;
    const mz = Math.cos(yaw) * dir;
    const p = {};
    const q = this._q;
    for (const k of dir >= 0 ? [0, 1] : [2, 3]) {
      this.wheelPos(k, x, z, yaw, p);
      terrain.querySurface(p.x, p.z, this.pos.y, q);
      if (q.waterY !== null && !q.walkable) return true;
      if (q.walkable ? q.walkable.kind === 'stairs' : NO_DRIVE_CELLS.has(terrain.cellKindAt(p.x, p.z))) return true;
      if (q.y - this.wheelY[k] > DRIVE_STEP_UP) return true;
      if (q.ny < MIN_DRIVE_NY && q.nx * mx + q.nz * mz < 0) return true;
    }
    return false;
  }

  // 以兩個圓近似車身（前、後）
  circles() {
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const r = this.spec.width / 2 + 0.05;
    const off = Math.max(0, this.spec.length / 2 - r);
    this._circles[0].x = this.pos.x + fx * off;
    this._circles[0].z = this.pos.z + fz * off;
    this._circles[0].r = r;
    this._circles[1].x = this.pos.x - fx * off;
    this._circles[1].z = this.pos.z - fz * off;
    this._circles[1].r = r;
    return this._circles;
  }

  // ctrl：{ throttle, reverse, left, right, handbrake }；無人駕駛時傳 null（自然減速）
  // terrain：唯一高度場（querySurface / cellKindAt）
  update(dt, ctrl, collision, terrain, obstacles) {
    const s = this.spec;
    const c = ctrl || { throttle: false, reverse: false, left: false, right: false, handbrake: !this.driven };
    let v = this.speed;

    // 油門 / 煞車 / 倒車
    let acc = 0;
    if (c.throttle && !c.reverse) {
      if (v < -0.3) acc = s.brake;
      else acc = s.accel * (1 - Math.pow(Math.max(0, v) / s.maxSpeed, 2));
    } else if (c.reverse && !c.throttle) {
      if (v > 0.3) acc = -s.brake;
      else acc = -s.accel * 0.6 * (1 - Math.max(0, -v) / s.maxReverse);
    }
    v += acc * dt;

    // 摩擦：滾動阻力 + 空氣阻力 + 放開油門的引擎煞車 + 手煞車
    let drag = 0.8 + 0.004 * v * v;
    if (!c.throttle && !c.reverse) drag += 2.2;
    if (c.handbrake) drag += 9;
    const dv = Math.min(Math.abs(v), drag * dt);
    v -= Math.sign(v) * dv;
    v = clamp(v, -s.maxReverse, s.maxSpeed);

    // 轉向：低速轉不動、高速轉向變鈍
    const steerTarget = (c.left ? 1 : 0) - (c.right ? 1 : 0);
    const steerRate = steerTarget === 0 ? 6 : 4;
    this.steer += clamp(steerTarget - this.steer, -steerRate * dt, steerRate * dt);
    const av = Math.abs(v);
    const speedFactor = clamp(av / 4, 0, 1) / (1 + av / 18);
    let yawRate = this.steer * s.turnRate * speedFactor * Math.sign(v || 1);
    if (c.handbrake && av > 5) yawRate *= 1.6;
    this.yaw += yawRate * dt;

    // 抓地力：實際速度向車頭方向靠攏（手煞車時抓地變差 → 甩尾）
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const grip = c.handbrake ? 2.2 : 9;
    const kg = Math.min(1, grip * dt);
    this.vx += (fx * v - this.vx) * kg;
    this.vz += (fz * v - this.vz) * kg;
    this.speed = v;

    const ox = this.pos.x;
    const oz = this.pos.z;
    this.pos.x += this.vx * dt;
    this.pos.z += this.vz * dt;

    // 碰撞（建築與動態障礙物）
    let hitNx = 0;
    let hitNz = 0;
    let hit = false;
    for (let i = 0; i < 2; i++) {
      const circ = this.circles()[i];
      const res = collision.resolveCircle(circ.x, circ.z, circ.r, this.pos.y);
      let px = res.x - circ.x;
      let pz = res.z - circ.z;
      if (res.hit) { hit = true; hitNx = res.nx; hitNz = res.nz; }
      if (obstacles && obstacles.length) {
        const r2 = pushOutOfCircles(res.x, res.z, circ.r, obstacles);
        if (r2.hit) { hit = true; hitNx = r2.nx; hitNz = r2.nz; }
        px = r2.x - circ.x;
        pz = r2.z - circ.z;
      }
      this.pos.x += px;
      this.pos.z += pz;
    }
    if (hit) {
      // 撞擊方向與車頭相反 → 正面撞擊，反彈並大幅減速；側面擦撞只小幅減速
      const along = hitNx * fx + hitNz * fz;
      if (along * Math.sign(this.speed) < -0.5) this.speed = -this.speed * 0.2;
      else this.speed *= 0.9;
      this.vx = fx * this.speed;
      this.vz = fz * this.speed;
    }

    // 地形：領先輪位開不上去（陡坡 / 湖面 / 階梯）→ 退回原位，視同正面撞牆
    const mv = (this.pos.x - ox) * fx + (this.pos.z - oz) * fz;
    if (Math.abs(mv) > 1e-6 && this.drivableBlocked(terrain, this.pos.x, this.pos.z, this.yaw, Math.sign(mv))) {
      this.pos.x = ox;
      this.pos.z = oz;
      this.speed = -this.speed * 0.2;
      this.vx = fx * this.speed;
      this.vz = fz * this.speed;
    }

    this.settle(terrain, dt);
    this.animate(dt);
    this.syncMesh();
  }

  animate(dt) {
    const r = this.spec.wheelRadius ?? (this.spec.twoWheeler ? WHEEL_RADIUS_MESH_BIKE : WHEEL_RADIUS_MESH);
    this.wheelSpin += (this.speed * dt) / r;
    for (const w of this.mesh.userData.wheels) w.rotation.x = this.wheelSpin;
    for (const h of this.mesh.userData.frontWheels) h.rotation.y = this.steer * 0.45;
    // 機車轉彎時車身傾斜（疊加在地形 roll 上；機車的地形 roll 恆 0）
    this.lean = this.spec.twoWheeler ? -this.steer * clamp(Math.abs(this.speed) / 15, 0, 1) * 0.35 : 0;
  }

  syncMesh() {
    this.mesh.position.copy(this.pos);
    this.mesh.position.y += SURFACE_OFFSET;
    this.mesh.rotation.set(-this.pitch, this.yaw, this.roll + this.lean);
  }

  speedKmh() {
    return Math.abs(this.speed) * 3.6;
  }
}

// 管理所有可駕駛車輛（路邊停放）；list 的 y 為 places.js 的 querySurface 高度
// physics = { RAPIER, pw（PhysicsWorld）, router（contacts.js）, groups }：每台車建 VehicleBody（kinematic 停放），
// 物理子步前 preStep、子步後檢查無人車是否靜止可停放；被撞（onVehicleHitVehicle）時醒來並吃下衝量
export class VehicleManager {
  constructor(scene, list, terrain, physics) {
    const { RAPIER, pw, router, groups } = physics;
    this.pw = pw;
    this.vehicles = list.map((d) => {
      const v = new Vehicle(scene, d.type, d.color, d.x, d.z, d.yaw);
      const y = Number.isFinite(d.y) ? d.y : terrain.querySurface(d.x, d.z, Infinity, v._q).y;
      const vb = new VehicleBody(RAPIER, pw, { type: d.type, ...v.spec }, { x: d.x, y, z: d.z, yaw: d.yaw, groups, ccd: false });
      vb.setControls({ handbrake: true });
      vb.setKinematic(true);
      vb.owner = v;
      router.register(vb.collider, vb);
      v.attachBody(vb, pw.register(vb.body));
      v.syncBody(0);
      return v;
    });
    pw.onBeforeStep((dt) => {
      for (const v of this.vehicles) v.body.preStep(dt);
    });
    pw.onAfterStep((dt) => this._park(dt));
    router.onVehicleHitVehicle(({ a, b, impulse, dir }) => {
      this._wake(a, impulse, { x: -dir.x, y: -dir.y, z: -dir.z });
      this._wake(b, impulse, dir);
    });
  }

  // 被撞的停放車：切 dynamic 並施加衝量（dir = 受力方向）
  _wake(vb, impulse, dir) {
    if (vb.kind !== 'vehicle' || !vb.kinematic || !vb.active) return;
    vb.setKinematic(false);
    vb.owner.rest = 0;
    vb.body.applyImpulse({ x: dir.x * impulse, y: dir.y * impulse, z: dir.z * impulse }, true);
  }

  // 無人駕駛、動態中的車：速度與角速度都低於門檻持續 PARK_REST_SEC → 切回 kinematic
  _park(dt) {
    for (const v of this.vehicles) {
      const vb = v.body;
      if (v.driven || vb.kinematic || !vb.active) continue;
      const lv = vb.body.linvel();
      const av = vb.body.angvel();
      const still = Math.hypot(lv.x, lv.y, lv.z) < PARK_REST_SPEED && Math.hypot(av.x, av.y, av.z) < PARK_REST_SPEED;
      v.rest = still ? v.rest + dt : 0;
      if (v.rest >= PARK_REST_SEC) vb.setKinematic(true);
    }
  }

  // 玩家上車：切 dynamic；下車：拉手煞車，停下後由 _park 切回 kinematic
  drive(v, on) {
    v.driven = on;
    v.rest = 0;
    if (on) v.body.setKinematic(false);
    else v.setControls({ handbrake: true });
  }

  // 物理 step 之後同步所有車的網格
  sync() {
    for (const v of this.vehicles) v.syncBody(this.pw.alpha);
  }

  // 遠距簡化用（setActiveByDistance）：玩家駕駛中的車永遠啟用，不列入
  bodies(out = []) {
    for (const v of this.vehicles) if (!v.driven) out.push(v.body);
    return out;
  }

  // 找玩家附近可上車的車輛（距離車身圓心 - 半徑）
  findNearby(pos, maxDist = 2.6) {
    let best = null;
    let bestD = maxDist;
    for (const v of this.vehicles) {
      if (v.driven) continue;
      for (const c of v.circles()) {
        const d = Math.hypot(pos.x - c.x, pos.z - c.z) - c.r;
        if (d < bestD) {
          bestD = d;
          best = v;
        }
      }
    }
    return best;
  }
}
