// 車流與行人：沿固定路線巡迴，不做避障（只有「前方有東西就停」的簡單判斷）
import { TRAFFIC_LOOPS, PEDESTRIAN_COUNT, CITY_SEED, SURFACE_OFFSET } from './data/city.js';
import { roadById } from './world.js';
import { Vehicle } from './vehicle.js';
import { createHumanoid, animateHumanoid } from './humanoid.js';
import { mulberry32, angleDelta, randPick } from './utils.js';

const CAR_COLORS = ['#f2f2f2', '#1f1f22', '#8a8f94', '#b01e28', '#2d5fb0', '#d9d2c0', '#3f6b4a'];
const SHIRTS = ['#d84a4a', '#3a6fd8', '#f2c14e', '#ffffff', '#6a4c93', '#2a9d8f', '#e76f51', '#8d99ae'];
const PANTS = ['#2b2f3a', '#1d3557', '#5c4d3c', '#3d3d3d', '#6b705c'];
const SKINS = ['#f1c9a5', '#e0ac85', '#c68b5f'];
const HAIRS = ['#1b1b1b', '#3b2a20', '#5a4a3a', '#9a9a9a'];

// 路徑：封閉折線；依距離取點
class LoopPath {
  constructor(points) {
    this.points = points;
    this.lengths = [];
    this.total = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      this.lengths.push(L);
      this.total += L;
    }
  }

  // 回傳 { x, z, dx, dz }（dx/dz 為前進方向單位向量）
  sample(s, out) {
    let d = ((s % this.total) + this.total) % this.total;
    for (let i = 0; i < this.points.length; i++) {
      const L = this.lengths[i];
      if (d <= L || i === this.points.length - 1) {
        const a = this.points[i];
        const b = this.points[(i + 1) % this.points.length];
        const t = L > 0 ? Math.min(1, d / L) : 0;
        out.x = a.x + (b.x - a.x) * t;
        out.z = a.z + (b.z - a.z) * t;
        out.dx = L > 0 ? (b.x - a.x) / L : 1;
        out.dz = L > 0 ? (b.z - a.z) / L : 0;
        return out;
      }
      d -= L;
    }
    return out;
  }
}

// 由四條道路組成車流迴圈（靠右行駛）
function buildCarLoop(loop) {
  const [nId, sId, wId, eId] = loop.roads;
  const N = roadById(nId);
  const S = roadById(sId);
  const W = roadById(wId);
  const E = roadById(eId);
  if (!N || !S || !W || !E) return null;
  // 車道偏移：避開中央分隔島，約在內側第一車道
  const laneOff = (r) => Math.max(4, r.median / 2 + 2.5);
  const oN = laneOff(N);
  const oS = laneOff(S);
  const oW = laneOff(W);
  const oE = laneOff(E);
  let pts;
  if (loop.clockwise) {
    // 順時針：北側往東、東側往南、南側往西、西側往北（內圈）
    pts = [
      { x: W.c + oW, z: N.c + oN },
      { x: E.c - oE, z: N.c + oN },
      { x: E.c - oE, z: S.c - oS },
      { x: W.c + oW, z: S.c - oS },
    ];
  } else {
    // 逆時針：北側往西、西側往南、南側往東、東側往北（外圈）
    pts = [
      { x: E.c + oE, z: N.c - oN },
      { x: W.c - oW, z: N.c - oN },
      { x: W.c - oW, z: S.c + oS },
      { x: E.c + oE, z: S.c + oS },
    ];
  }
  return new LoopPath(pts);
}

// 人行道矩形迴圈
function buildRingPath(ring, reverse) {
  const pts = [
    { x: ring.x0, z: ring.z0 },
    { x: ring.x1, z: ring.z0 },
    { x: ring.x1, z: ring.z1 },
    { x: ring.x0, z: ring.z1 },
  ];
  if (reverse) pts.reverse();
  return new LoopPath(pts);
}

export class Traffic {
  constructor(scene, cells, heightAt) {
    this.heightAt = heightAt;
    const rng = mulberry32(CITY_SEED + 1);
    this.cars = [];
    this.peds = [];
    const tmp = { x: 0, z: 0, dx: 0, dz: 1 };

    for (const loop of TRAFFIC_LOOPS) {
      const path = buildCarLoop(loop);
      if (!path) continue;
      for (let k = 0; k < loop.cars; k++) {
        const type = randPick(rng, ['sedan', 'sedan', 'taxi', 'suv']);
        const color = type === 'taxi' ? '#f5c518' : randPick(rng, CAR_COLORS);
        const s = (path.total * k) / loop.cars + rng() * 30;
        path.sample(s, tmp);
        const v = new Vehicle(scene, type, color, tmp.x, tmp.z, Math.atan2(tmp.dx, tmp.dz));
        v.ai = true;
        this.cars.push({ v, path, s, cruise: loop.speed * (0.9 + rng() * 0.2), speed: loop.speed });
      }
    }

    const candidates = cells.filter((c) => c.interior && c.ring.x1 - c.ring.x0 > 20 && c.ring.z1 - c.ring.z0 > 20);
    for (let i = 0; i < PEDESTRIAN_COUNT && candidates.length; i++) {
      const cell = candidates[Math.floor(rng() * candidates.length)];
      const path = buildRingPath(cell.ring, rng() < 0.5);
      const mesh = createHumanoid({
        shirt: randPick(rng, SHIRTS),
        pants: randPick(rng, PANTS),
        skin: randPick(rng, SKINS),
        hair: randPick(rng, HAIRS),
      });
      scene.add(mesh);
      this.peds.push({ mesh, path, s: rng() * path.total, speed: 1.1 + rng() * 0.5, phase: rng() * 6, yaw: 0 });
    }
    this._tmp = tmp;
  }

  // blockers：[{ x, z }] 會讓車流停下來的東西（玩家、玩家的車、路邊的車）
  update(dt, blockers) {
    const tmp = this._tmp;
    for (const car of this.cars) {
      const v = car.v;
      const fx = Math.sin(v.yaw);
      const fz = Math.cos(v.yaw);
      let target = car.cruise;
      // 前方 14m、左右 2.6m 內有東西就停
      const check = (x, z) => {
        const dx = x - v.pos.x;
        const dz = z - v.pos.z;
        const along = dx * fx + dz * fz;
        const lat = Math.abs(dx * fz - dz * fx);
        if (along > 0.5 && along < 14 && lat < 2.6) target = 0;
      };
      for (const b of blockers) check(b.x, b.z);
      for (const other of this.cars) {
        if (other !== car) check(other.v.pos.x, other.v.pos.z);
      }
      const accel = target < car.speed ? 12 : 4;
      if (car.speed < target) car.speed = Math.min(target, car.speed + accel * dt);
      else car.speed = Math.max(target, car.speed - accel * dt);
      car.s += car.speed * dt;
      car.path.sample(car.s, tmp);
      v.pos.set(tmp.x, this.heightAt(tmp.x, tmp.z), tmp.z);
      const want = Math.atan2(tmp.dx, tmp.dz);
      v.yaw += angleDelta(v.yaw, want) * Math.min(1, 7 * dt);
      v.speed = car.speed;
      v.animate(dt);
      v.syncMesh();
    }

    for (const p of this.peds) {
      p.s += p.speed * dt;
      p.path.sample(p.s, tmp);
      p.mesh.position.set(tmp.x, this.heightAt(tmp.x, tmp.z) + SURFACE_OFFSET, tmp.z);
      const want = Math.atan2(tmp.dx, tmp.dz);
      p.yaw += angleDelta(p.yaw, want) * Math.min(1, 8 * dt);
      p.mesh.rotation.y = p.yaw;
      p.phase += dt * p.speed * 2.3;
      animateHumanoid(p.mesh, p.phase, 0.8);
    }
  }

  // 車流車輛的碰撞圓（給玩家與玩家的車用）
  circles(out = []) {
    for (const car of this.cars) {
      for (const c of car.v.circles()) out.push({ x: c.x, z: c.z, r: c.r });
    }
    return out;
  }
}
