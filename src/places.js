// 依 OSM 資料計算出生點與路邊停放車輛的位置（不寫死座標）
// y 一律取 querySurface（唯一高度場）；出生點 / 停車點不落在湖面，坡度 > PLACE_MAX_SLOPE 的點不用
import { TIGER_CITY_ID, SPAWN_ROAD_NAME, PARKED_TYPES, PARKED_RADIUS } from './data/city.js';
import { buildingById, surfaceRoads, buildingAt, onRoadSurface, junctionClearance, inBounds, inWater, querySurface } from './citymodel.js';
import { closestOnSegment, distanceToPolygon, polygonCentroid } from './geom.js';
import { VEHICLE_TYPES } from './vehicle.js';

const PLACE_MAX_SLOPE = 12; // 出生 / 停車允許的最大地面坡度（°）
const MIN_NY = Math.cos((PLACE_MAX_SLOPE * Math.PI) / 180);
const _q = {};

// 可放置：不在湖面範圍、地面坡度 ≤ PLACE_MAX_SLOPE；回傳地面 y，不可放置回傳 null
function surfaceY(x, z) {
  querySurface(x, z, Infinity, _q);
  if (_q.waterY !== null && !_q.walkable) return null;
  if (_q.ny < MIN_NY) return null;
  return _q.y;
}

// 取得老虎城建築（找不到時退回原點）
export function tigerCity() {
  return buildingById(TIGER_CITY_ID);
}

// 出生點：老虎城輪廓外、靠河南路三段那一側的人行鋪面上，面向老虎城
// yaw 定義：前進方向 = (sin(yaw), cos(yaw))；回傳 { x, y, z, yaw, … }
export function computeSpawn() {
  const tiger = tigerCity();
  const c = tiger ? polygonCentroid(tiger.poly) : { x: 0, z: 0 };
  // 河南路三段上最靠近老虎城中心的點
  const seg = { x: 0, z: 0, d2: 0, t: 0 };
  let best = null;
  for (const r of surfaceRoads) {
    if (r.name !== SPAWN_ROAD_NAME) continue;
    for (let i = 0; i < r.pts.length - 1; i++) {
      closestOnSegment(c.x, c.z, r.pts[i].x, r.pts[i].z, r.pts[i + 1].x, r.pts[i + 1].z, seg);
      if (!best || seg.d2 < best.d2) best = { x: seg.x, z: seg.z, d2: seg.d2, road: r };
    }
  }
  if (!best || !tiger) {
    const x = c.x;
    const z = c.z + 80;
    return { x, y: querySurface(x, z, Infinity, _q).y, z, yaw: Math.PI, fallback: true };
  }
  const d = Math.sqrt(best.d2) || 1;
  const ux = (c.x - best.x) / d;
  const uz = (c.z - best.z) / d;
  const yaw = Math.atan2(ux, uz);
  // 從路緣往老虎城走，取第一個「不在路面、不在建築、距老虎城外牆 3–8m」的點
  for (let t = best.road.hw + 1; t < d; t += 0.5) {
    const x = best.x + ux * t;
    const z = best.z + uz * t;
    const dist = distanceToPolygon(x, z, tiger.poly);
    if (dist > 8) continue;
    if (dist < 3) break;
    if (buildingAt(x, z, 1)) continue;
    if (onRoadSurface(x, z, 0.6, false)) continue;
    const y = surfaceY(x, z);
    if (y === null) continue;
    return { x, y, z, yaw, road: best.road.name };
  }
  // 沿線找不到：退回路緣外 3m
  const t = best.road.hw + 3;
  const x = best.x + ux * t;
  const z = best.z + uz * t;
  return { x, y: querySurface(x, z, Infinity, _q).y, z, yaw, road: best.road.name, fallback: true };
}

// 路邊停放車輛：老虎城周邊 PARKED_RADIUS 內道路的路邊（貼近路緣、順著道路方向），由近到遠挑
const PARK_ROAD_TYPES = new Set(['secondary', 'tertiary', 'residential', 'unclassified', 'living_street']);

export function computeParkedVehicles(spawn) {
  const tiger = tigerCity();
  const c = tiger ? polygonCentroid(tiger.poly) : { x: 0, z: 0 };
  const cands = [];
  for (const r of surfaceRoads) {
    if (!PARK_ROAD_TYPES.has(r.type) || r.width < 10) continue;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i];
      const b = r.pts[i + 1];
      const L = r.cum[i + 1] - r.cum[i];
      if (L < 8) continue;
      const dx = (b.x - a.x) / L;
      const dz = (b.z - a.z) / L;
      for (let s = 4; s < L - 4; s += 2) {
        const px = a.x + dx * s;
        const pz = a.z + dz * s;
        if (Math.hypot(px - c.x, pz - c.z) > PARKED_RADIUS) continue;
        for (const side of [1, -1]) cands.push({ r, px, pz, dx, dz, side });
      }
    }
  }
  const out = [];
  const taken = [];
  const order = PARKED_TYPES.slice();
  const sx = spawn ? spawn.x : c.x;
  const sz = spawn ? spawn.z : c.z;
  cands.sort((p, q) => Math.hypot(p.px - sx, p.pz - sz) - Math.hypot(q.px - sx, q.pz - sz));
  for (const spec of order) {
    const vt = VEHICLE_TYPES[spec.type];
    const off = (r) => r.hw - (vt.width / 2 + 0.35);
    let placed = null;
    for (const cd of cands) {
      // 路邊 = 道路右側（side=1）或左側（side=-1）；雙向道停在左側時車頭反向，單行道都順向
      const rx = -cd.dz * cd.side;
      const rz = cd.dx * cd.side;
      const o = off(cd.r);
      const x = cd.px + rx * o;
      const z = cd.pz + rz * o;
      const fx = cd.r.oneway || cd.side === 1 ? cd.dx * (cd.r.oneway === -1 ? -1 : 1) : -cd.dx;
      const fz = cd.r.oneway || cd.side === 1 ? cd.dz * (cd.r.oneway === -1 ? -1 : 1) : -cd.dz;
      if (!inBounds(x, z, 5)) continue;
      if (Math.hypot(x - sx, z - sz) < 5) continue;
      if (taken.some((t) => Math.hypot(t.x - x, t.z - z) < 13)) continue; // 前後留空間，玩家開得出去
      if (junctionClearance(x, z) < 5) continue;
      const half = vt.length / 2;
      let ok = true;
      for (const k of [-1, 0, 1]) {
        const qx = x + fx * half * k;
        const qz = z + fz * half * k;
        if (buildingAt(qx, qz, vt.width / 2 + 0.3) || onRoadSurface(qx, qz, -0.5, false, cd.r) || inWater(qx, qz, 1) || surfaceY(qx, qz) === null) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      placed = { type: spec.type, color: spec.color, x, y: surfaceY(x, z), z, yaw: Math.atan2(fx, fz), road: cd.r.name };
      break;
    }
    if (placed) {
      out.push(placed);
      taken.push(placed);
    }
  }
  return out;
}
