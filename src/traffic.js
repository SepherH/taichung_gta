// 車流與行人：車流沿 OSM 的 primary / secondary / tertiary 折線靠右行駛（臺灣右側通行），
// 到端點就換到相連道路，沒有可接的路或出界就掉頭；行人沿道路邊緣來回走。
// 不做避障（只有「前方有東西就停」的簡單判斷）
import { TRAFFIC_CAR_COUNT, PEDESTRIAN_COUNT, CITY_SEED, SURFACE_OFFSET } from './data/city.js';
import { surfaceRoads, TRAFFIC_TYPES, nodeRoads, nodeKey, inBounds, buildingAt, inWater } from './citymodel.js';
import { samplePolyline } from './geom.js';
import { Vehicle } from './vehicle.js';
import { createHumanoid, animateHumanoid } from './humanoid.js';
import { mulberry32, angleDelta, randPick } from './utils.js';

const CAR_COLORS = ['#f2f2f2', '#1f1f22', '#8a8f94', '#b01e28', '#2d5fb0', '#d9d2c0', '#3f6b4a'];
const SHIRTS = ['#d84a4a', '#3a6fd8', '#f2c14e', '#ffffff', '#6a4c93', '#2a9d8f', '#e76f51', '#8d99ae'];
const PANTS = ['#2b2f3a', '#1d3557', '#5c4d3c', '#3d3d3d', '#6b705c'];
const SKINS = ['#f1c9a5', '#e0ac85', '#c68b5f'];
const HAIRS = ['#1b1b1b', '#3b2a20', '#5a4a3a', '#9a9a9a'];

const CRUISE = { primary: 13, secondary: 11, tertiary: 9 };
const PED_ROAD_TYPES = new Set(['primary', 'secondary', 'tertiary', 'residential', 'unclassified']);

// 車道偏移（相對道路中心線、行進方向右側）
// 刻意偏向內側，讓出路緣給路邊停車（places.js 的停車位置距路緣約 0.35m）
function laneOffset(road) {
  if (road.oneway) return Math.max(0, Math.min(road.hw * 0.35, road.hw - 3.8));
  return Math.min(road.hw * 0.4, 3.2);
}

const trafficRoads = surfaceRoads.filter((r) => TRAFFIC_TYPES.has(r.type) && r.length > 2);
const trafficSet = new Set(trafficRoads);

// 節點上可以接續的行駛選項：[{ road, dir, s }]
function optionsAt(x, z, fromRoad) {
  const list = nodeRoads.get(nodeKey(x, z)) || [];
  const out = [];
  for (const e of list) {
    const r = e.road;
    if (r === fromRoad || !trafficSet.has(r)) continue;
    const last = r.pts.length - 1;
    if (e.idx < last && r.oneway !== -1) out.push({ road: r, dir: 1, s: r.cum[e.idx] });
    if (e.idx > 0 && r.oneway !== 1) out.push({ road: r, dir: -1, s: r.cum[e.idx] });
  }
  return out;
}

function allowedDirs(road) {
  if (road.oneway === 1) return [1];
  if (road.oneway === -1) return [-1];
  return [1, -1];
}

export class Traffic {
  constructor(scene, { center = { x: 0, z: 0 }, heightAt }) {
    this.heightAt = heightAt;
    const rng = mulberry32(CITY_SEED + 1);
    this.rng = rng;
    this.cars = [];
    this.peds = [];
    this.stats = { uTurns: 0, switches: 0 };
    const tmp = { x: 0, z: 0, dx: 0, dz: 1, seg: 0 };
    this._tmp = tmp;

    // 車流：從出生點附近的主要道路上挑起點（依長度加權）
    const near = trafficRoads.filter((r) => r.pts.some((p) => Math.hypot(p.x - center.x, p.z - center.z) < 450));
    const pool = near.length ? near : trafficRoads;
    const total = pool.reduce((s, r) => s + r.length, 0);
    let guard = 0;
    while (this.cars.length < TRAFFIC_CAR_COUNT && pool.length && guard++ < 500) {
      let pick = rng() * total;
      let road = pool[0];
      for (const r of pool) {
        pick -= r.length;
        if (pick <= 0) {
          road = r;
          break;
        }
      }
      const s = road.length * (0.15 + rng() * 0.7);
      samplePolyline(road, s, tmp);
      if (!inBounds(tmp.x, tmp.z, 20)) continue;
      if (this.cars.some((c) => Math.hypot(c.v.pos.x - tmp.x, c.v.pos.z - tmp.z) < 25)) continue;
      const dir = randPick(rng, allowedDirs(road));
      const type = randPick(rng, ['sedan', 'sedan', 'taxi', 'suv']);
      const color = type === 'taxi' ? '#f5c518' : randPick(rng, CAR_COLORS);
      const v = new Vehicle(scene, type, color, tmp.x, tmp.z, Math.atan2(tmp.dx * dir, tmp.dz * dir));
      v.ai = true;
      const car = { v, road, dir, s, lat: dir * laneOffset(road), speed: 0, cruise: 1, factor: 0.9 + rng() * 0.2 };
      this._setCruise(car);
      car.speed = car.cruise;
      this._place(car, 0, true);
      this.cars.push(car);
    }

    // 行人：出生點附近道路的路緣外側，沿道路來回走
    const pedRoads = surfaceRoads.filter((r) => {
      if (!PED_ROAD_TYPES.has(r.type) || r.length < 30) return false;
      return r.pts.some((p) => Math.hypot(p.x - center.x, p.z - center.z) < 320);
    });
    guard = 0;
    while (this.peds.length < PEDESTRIAN_COUNT && pedRoads.length && guard++ < 400) {
      const road = pedRoads[Math.floor(rng() * pedRoads.length)];
      const side = rng() < 0.5 ? 1 : -1;
      const off = side * (road.hw + 1.3);
      if (!this._pedPathClear(road, off)) continue;
      const mesh = createHumanoid({
        shirt: randPick(rng, SHIRTS),
        pants: randPick(rng, PANTS),
        skin: randPick(rng, SKINS),
        hair: randPick(rng, HAIRS),
      });
      scene.add(mesh);
      const ped = { mesh, road, off, s: rng() * road.length, dir: rng() < 0.5 ? 1 : -1, speed: 1.1 + rng() * 0.5, phase: rng() * 6, yaw: 0 };
      this.peds.push(ped);
      this._updatePed(ped, 0, true);
    }
  }

  _setCruise(car) {
    car.cruise = (CRUISE[car.road.type] || 9) * car.factor;
  }

  // 行人路徑每 4m 檢查一次：不能穿過建築、水域或出界
  _pedPathClear(road, off) {
    const tmp = this._tmp;
    for (let s = 0; s <= road.length; s += 4) {
      samplePolyline(road, s, tmp);
      const x = tmp.x - tmp.dz * off;
      const z = tmp.z + tmp.dx * off;
      if (!inBounds(x, z, 3) || buildingAt(x, z, 0.5) || inWater(x, z, 0.5)) return false;
    }
    return true;
  }

  // 到達端點：換到相連道路；沒有可接的路就掉頭
  _advanceNode(car) {
    const endIdx = car.dir > 0 ? car.road.pts.length - 1 : 0;
    const p = car.road.pts[endIdx];
    const opts = optionsAt(p.x, p.z, car.road);
    if (opts.length) {
      const o = opts[Math.floor(this.rng() * opts.length)];
      car.road = o.road;
      car.dir = o.dir;
      car.s = o.s;
      car.lat = o.dir * laneOffset(o.road);
      this._setCruise(car);
      this.stats.switches++;
    } else {
      this._uTurn(car);
    }
  }

  _uTurn(car) {
    car.dir = -car.dir;
    car.s = Math.max(0, Math.min(car.road.length, car.s));
    this.stats.uTurns++;
  }

  _place(car, dt, snap = false) {
    const tmp = this._tmp;
    samplePolyline(car.road, car.s, tmp);
    // lat 為道路本身「前進方向右側」的偏移；掉頭時平滑移到對向車道
    const target = car.dir * laneOffset(car.road);
    if (snap) car.lat = target;
    else car.lat += Math.max(-4 * dt, Math.min(4 * dt, target - car.lat));
    const x = tmp.x - tmp.dz * car.lat;
    const z = tmp.z + tmp.dx * car.lat;
    const v = car.v;
    v.pos.set(x, this.heightAt(x, z), z);
    const want = Math.atan2(tmp.dx * car.dir, tmp.dz * car.dir);
    if (snap) v.yaw = want;
    else v.yaw += angleDelta(v.yaw, want) * Math.min(1, 6 * dt);
  }

  _updatePed(p, dt, snap = false) {
    const tmp = this._tmp;
    p.s += p.dir * p.speed * dt;
    if (p.s > p.road.length) {
      p.s = p.road.length;
      p.dir = -1;
    } else if (p.s < 0) {
      p.s = 0;
      p.dir = 1;
    }
    samplePolyline(p.road, p.s, tmp);
    const x = tmp.x - tmp.dz * p.off;
    const z = tmp.z + tmp.dx * p.off;
    p.mesh.position.set(x, this.heightAt(x, z) + SURFACE_OFFSET, z);
    const want = Math.atan2(tmp.dx * p.dir, tmp.dz * p.dir);
    if (snap) p.yaw = want;
    else p.yaw += angleDelta(p.yaw, want) * Math.min(1, 8 * dt);
    p.mesh.rotation.y = p.yaw;
    p.phase += dt * p.speed * 2.3;
    animateHumanoid(p.mesh, p.phase, 0.8);
  }

  // blockers：[{ x, z }] 會讓車流停下來的東西（玩家、玩家的車、路邊的車）
  update(dt, blockers) {
    for (const car of this.cars) {
      const v = car.v;
      const fx = Math.sin(v.yaw);
      const fz = Math.cos(v.yaw);
      let target = car.cruise;
      // 前方 14m、左右 2.1m 內有東西就停（約兩車半寬之和，貼路緣停放的車不會擋住車道）
      const check = (x, z) => {
        const dx = x - v.pos.x;
        const dz = z - v.pos.z;
        const along = dx * fx + dz * fz;
        const lat = Math.abs(dx * fz - dz * fx);
        if (along > 0.5 && along < 14 && lat < 2.1) target = 0;
      };
      for (const b of blockers) check(b.x, b.z);
      for (const other of this.cars) {
        if (other !== car) check(other.v.pos.x, other.v.pos.z);
      }
      const accel = target < car.speed ? 12 : 4;
      if (car.speed < target) car.speed = Math.min(target, car.speed + accel * dt);
      else car.speed = Math.max(target, car.speed - accel * dt);

      car.s += car.dir * car.speed * dt;
      // 到端點：換路或掉頭（最多處理兩次，避免極短路段卡住）
      for (let k = 0; k < 2; k++) {
        if (car.dir > 0 && car.s >= car.road.length) {
          const over = car.s - car.road.length;
          car.s = car.road.length;
          this._advanceNode(car);
          car.s += car.dir * over;
        } else if (car.dir < 0 && car.s <= 0) {
          const over = -car.s;
          car.s = 0;
          this._advanceNode(car);
          car.s += car.dir * over;
        } else break;
      }
      car.s = Math.max(0, Math.min(car.road.length, car.s));
      this._place(car, dt);
      // 開到世界邊界附近就掉頭
      if (!inBounds(v.pos.x, v.pos.z, 8) && !car.leaving) {
        car.leaving = true;
        this._uTurn(car);
      } else if (inBounds(v.pos.x, v.pos.z, 12)) {
        car.leaving = false;
      }
      v.speed = car.speed;
      v.animate(dt);
      v.syncMesh();
    }

    for (const p of this.peds) this._updatePed(p, dt);
  }

  // 車流車輛的碰撞圓（給玩家與玩家的車用）
  circles(out = []) {
    for (const car of this.cars) {
      for (const c of car.v.circles()) out.push({ x: c.x, z: c.z, r: c.r });
    }
    return out;
  }
}
