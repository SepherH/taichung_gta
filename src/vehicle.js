// 車輛：外型（轎車 / 計程車 / 休旅車 / 機車）與街機式駕駛手感
// 本地座標前方為 +Z；yaw 定義與玩家相同：前進方向 = (sin(yaw), cos(yaw))
import * as THREE from 'three';
import { cachedStandardMaterial, clamp, makeTextTexture } from './utils.js';
import { pushOutOfCircles } from './collision.js';
import { registerNight } from './daynight.js';
import { SURFACE_OFFSET } from './data/city.js';

export const VEHICLE_TYPES = {
  sedan: { label: '轎車', length: 4.5, width: 1.85, height: 1.45, maxSpeed: 34, maxReverse: 8, accel: 8, brake: 18, turnRate: 1.7, camScale: 1.35 },
  taxi: { label: '計程車', length: 4.5, width: 1.85, height: 1.45, maxSpeed: 32, maxReverse: 8, accel: 8, brake: 18, turnRate: 1.7, camScale: 1.35 },
  suv: { label: '休旅車', length: 4.9, width: 2.0, height: 1.8, maxSpeed: 31, maxReverse: 7, accel: 7, brake: 16, turnRate: 1.5, camScale: 1.45 },
  scooter: { label: '機車', length: 1.9, width: 0.7, height: 1.1, maxSpeed: 22, maxReverse: 3, accel: 9, brake: 14, turnRate: 2.4, camScale: 1.0, twoWheeler: true },
};

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
    const tall = type === 'suv';
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
    const wx = W / 2 - 0.08;
    const wz = L / 2 - 0.85;
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

export class Vehicle {
  constructor(scene, type, color, x, z, yaw) {
    this.type = type;
    this.spec = VEHICLE_TYPES[type];
    this.mesh = createVehicleMesh(type, color);
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
    this._circles = [{ x: 0, z: 0, r: 0 }, { x: 0, z: 0, r: 0 }];
    this.syncMesh();
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
  update(dt, ctrl, collision, heightAt, obstacles) {
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

    this.pos.y = heightAt(this.pos.x, this.pos.z);
    this.animate(dt);
    this.syncMesh();
  }

  animate(dt) {
    const r = this.spec.twoWheeler ? 0.26 : 0.34;
    this.wheelSpin += (this.speed * dt) / r;
    for (const w of this.mesh.userData.wheels) w.rotation.x = this.wheelSpin;
    for (const h of this.mesh.userData.frontWheels) h.rotation.y = this.steer * 0.45;
    // 機車轉彎時車身傾斜
    if (this.spec.twoWheeler) {
      this.mesh.rotation.z = -this.steer * clamp(Math.abs(this.speed) / 15, 0, 1) * 0.35;
    }
  }

  syncMesh() {
    this.mesh.position.copy(this.pos);
    this.mesh.position.y += SURFACE_OFFSET;
    this.mesh.rotation.y = this.yaw;
  }

  speedKmh() {
    return Math.abs(this.speed) * 3.6;
  }
}

// 管理所有可駕駛車輛（路邊停放）
export class VehicleManager {
  constructor(scene, list, heightAt) {
    this.vehicles = list.map((d) => {
      const v = new Vehicle(scene, d.type, d.color, d.x, d.z, d.yaw);
      v.pos.y = heightAt(d.x, d.z);
      v.syncMesh();
      return v;
    });
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

  // 無人駕駛的車輛只在還有速度時才更新（例如跳車後滑行）
  updateIdle(dt, collision, heightAt, obstaclesFor) {
    for (const v of this.vehicles) {
      if (v.driven) continue;
      if (Math.abs(v.speed) > 0.05 || Math.hypot(v.vx, v.vz) > 0.05) {
        v.update(dt, null, collision, heightAt, obstaclesFor(v));
      }
    }
  }

  circlesExcept(except, out = []) {
    for (const v of this.vehicles) {
      if (v === except) continue;
      for (const c of v.circles()) out.push({ x: c.x, z: c.z, r: c.r });
    }
    return out;
  }
}

// 下車位置：先試左側（駕駛座），再試右側、車尾
export function exitPosition(vehicle, collision) {
  const fx = Math.sin(vehicle.yaw);
  const fz = Math.cos(vehicle.yaw);
  const lx = fz; // 左方 = -右方，右方 = (-fz, fx)
  const lz = -fx;
  const side = vehicle.spec.width / 2 + 0.8;
  const tries = [
    [vehicle.pos.x + lx * side, vehicle.pos.z + lz * side],
    [vehicle.pos.x - lx * side, vehicle.pos.z - lz * side],
    [vehicle.pos.x - fx * (vehicle.spec.length / 2 + 1), vehicle.pos.z - fz * (vehicle.spec.length / 2 + 1)],
  ];
  for (const [x, z] of tries) {
    if (!collision.pointBlocked(x, 1, z, 0.4)) return { x, z };
  }
  const r = collision.resolveCircle(tries[0][0], tries[0][1], 0.4);
  return { x: r.x, z: r.z };
}

