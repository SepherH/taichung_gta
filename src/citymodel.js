// 城市模型：載入 osm-city.json（tools/build-city.mjs 產出），整理成各模組共用的結構與空間查詢
// 純 JS（不依賴 three），小地圖、碰撞、車流、擺放檢查都從這裡取資料
import osm from './data/osm-city.json';
import { polygonBBox, polygonCentroid, polygonArea, pointInPolygon, closestOnPolygon, closestOnSegment, polylineInfo, SpatialGrid } from './geom.js';

// 車流行駛的道路類型
export const TRAFFIC_TYPES = new Set(['primary', 'secondary', 'tertiary']);
// 會畫中線 / 車道線、兩側種行道樹與路燈的主要道路
export const MAJOR_TYPES = new Set(['primary', 'secondary', 'tertiary']);

export const BOUNDS = {
  minX: osm.bounds.x0,
  maxX: osm.bounds.x1,
  minZ: osm.bounds.z0,
  maxZ: osm.bounds.z1,
};

export const ATTRIBUTION = '地圖資料 © OpenStreetMap contributors（ODbL）';

// ---------- 建築 ----------
export const buildings = osm.B.map((b) => {
  const bbox = polygonBBox(b.p);
  return {
    id: b.i,
    name: b.n || '',
    nameEn: b.e || '',
    type: b.t,
    levels: b.l || 0,
    height: b.h,
    estimated: !!b.s,
    poly: b.p,
    bbox,
    center: polygonCentroid(b.p),
    area: polygonArea(b.p),
  };
});
export const namedBuildings = buildings.filter((b) => b.name);
export function buildingById(id) {
  return buildings.find((b) => b.id === id) || null;
}

const buildingGrid = new SpatialGrid(25);
for (const b of buildings) buildingGrid.insert(b, b.bbox.x0, b.bbox.z0, b.bbox.x1, b.bbox.z1);
const _bq = [];
const _cp = {};

// 點（外擴 pad）是否落在任何建築輪廓內；回傳該建築或 null
export function buildingAt(x, z, pad = 0) {
  const list = buildingGrid.query(x - pad, z - pad, x + pad, z + pad, _bq);
  for (const b of list) {
    if (x < b.bbox.x0 - pad || x > b.bbox.x1 + pad || z < b.bbox.z0 - pad || z > b.bbox.z1 + pad) continue;
    if (pointInPolygon(x, z, b.poly)) return b;
    if (pad > 0 && closestOnPolygon(x, z, b.poly, _cp).d2 < pad * pad) return b;
  }
  return null;
}

// 最近的具名建築（輪廓距離 ≤ maxDist）；回傳 { building, dist } 或 null
export function nearestNamedBuilding(x, z, maxDist = 12) {
  const list = buildingGrid.query(x - maxDist, z - maxDist, x + maxDist, z + maxDist, _bq);
  let best = null;
  let bestD = maxDist;
  for (const b of list) {
    if (!b.name) continue;
    const d = pointInPolygon(x, z, b.poly) ? 0 : Math.sqrt(closestOnPolygon(x, z, b.poly, _cp).d2);
    if (d <= bestD) {
      bestD = d;
      best = b;
    }
  }
  return best ? { building: best, dist: bestD } : null;
}

// ---------- 道路 ----------
function makeRoad(r, foot) {
  const info = polylineInfo(r.p);
  return {
    id: r.i,
    name: r.n || '',
    type: r.t,
    width: r.w,
    hw: r.w / 2,
    lanes: r.ln || 0,
    oneway: r.o || 0,
    bridge: !!r.br,
    tunnel: !!r.tu,
    layer: r.ly || 0,
    under: !!r.u, // tunnel 或 layer<0：不畫在地面、不參與碰撞 / 擺放 / 車流
    foot,
    pts: info.pts,
    cum: info.cum,
    length: info.length,
  };
}
export const roads = osm.R.map((r) => makeRoad(r, false));
export const footways = osm.F.map((r) => makeRoad(r, true));
export const surfaceRoads = roads.filter((r) => !r.under);
export const surfaceFootways = footways.filter((r) => !r.under);

// 線段網格（地面道路 + 步道）
const segGrid = new SpatialGrid(25);
for (const r of [...surfaceRoads, ...surfaceFootways]) {
  for (let i = 0; i < r.pts.length - 1; i++) {
    const a = r.pts[i];
    const b = r.pts[i + 1];
    const seg = { road: r, i, ax: a.x, az: a.z, bx: b.x, bz: b.z };
    segGrid.insert(seg, Math.min(a.x, b.x) - r.hw, Math.min(a.z, b.z) - r.hw, Math.max(a.x, b.x) + r.hw, Math.max(a.z, b.z) + r.hw);
  }
}
const _sq = [];
const _sp = { x: 0, z: 0, d2: 0, t: 0 };

// 點是否在路面上（距任一路段中心線 < 半寬 + pad）；includeFoot=false 時忽略步道
// except：忽略的道路（例如停車時自己所在的那條）
export function onRoadSurface(x, z, pad = 0, includeFoot = true, except = null) {
  const R = 16 + pad;
  const list = segGrid.query(x - R, z - R, x + R, z + R, _sq);
  for (const s of list) {
    if (!includeFoot && s.road.foot) continue;
    if (except && s.road === except) continue;
    const lim = s.road.hw + pad;
    closestOnSegment(x, z, s.ax, s.az, s.bx, s.bz, _sp);
    if (_sp.d2 < lim * lim) return s.road;
  }
  return null;
}

// 最近的具名道路；回傳 { road, dist, onSurface } 或 null
export function nearestNamedRoad(x, z, maxDist = 120, includeFoot = false) {
  let R = 30;
  while (R <= maxDist) {
    const list = segGrid.query(x - R, z - R, x + R, z + R, _sq);
    let best = null;
    let bestD = Infinity;
    for (const s of list) {
      if (!s.road.name) continue;
      if (!includeFoot && s.road.foot) continue;
      closestOnSegment(x, z, s.ax, s.az, s.bx, s.bz, _sp);
      // 以「距路緣」比較，寬路不會被窄巷搶走
      const d = Math.sqrt(_sp.d2) - s.road.hw;
      if (d < bestD) {
        bestD = d;
        best = s.road;
      }
    }
    if (best && bestD <= R) return { road: best, dist: Math.max(0, bestD), onSurface: bestD <= 0 };
    R *= 2;
  }
  return null;
}

// ---------- 路口 ----------
// 以頂點座標（0.1m 精度，OSM 共用節點投影後完全相同）為鍵，記錄經過該點的所有地面車道路
export function nodeKey(x, z) {
  return Math.round(x * 10) * 1000003 + Math.round(z * 10);
}
export const nodeRoads = new Map();
for (const r of surfaceRoads) {
  r.pts.forEach((p, idx) => {
    const k = nodeKey(p.x, p.z);
    let list = nodeRoads.get(k);
    if (!list) {
      list = [];
      nodeRoads.set(k, list);
    }
    list.push({ road: r, idx });
  });
}
// 路口：兩條以上道路共用的節點；radius = 相連道路的最大半寬
// 節點的連接度：道路端點算 1、中間點算 2；兩段同一路的首尾相接（度 = 2）不算路口
export function nodeDegree(list) {
  let d = 0;
  for (const e of list) d += e.idx === 0 || e.idx === e.road.pts.length - 1 ? 1 : 2;
  return d;
}
export const junctions = [];
for (const list of nodeRoads.values()) {
  const set = new Set(list.map((e) => e.road));
  if (set.size < 2 || nodeDegree(list) < 3) continue;
  const p = list[0].road.pts[list[0].idx];
  let hw = 0;
  for (const r of set) hw = Math.max(hw, r.hw);
  junctions.push({ x: p.x, z: p.z, radius: hw, roads: [...set] });
}
const junctionGrid = new SpatialGrid(40);
for (const j of junctions) junctionGrid.insert(j, j.x - j.radius, j.z - j.radius, j.x + j.radius, j.z + j.radius);
const _jq = [];

// 點與最近路口的距離減去路口半徑（< 0 表示在路口範圍內）
export function junctionClearance(x, z, except = null) {
  const R = 40;
  const list = junctionGrid.query(x - R, z - R, x + R, z + R, _jq);
  let best = Infinity;
  for (const j of list) {
    if (except && j.roads.length === 1 && j.roads[0] === except) continue;
    const d = Math.hypot(x - j.x, z - j.z) - j.radius;
    if (d < best) best = d;
  }
  return best;
}

// ---------- 公園 / 水域 ----------
export const parks = osm.P.map((p) => ({ id: p.i, name: p.n || '', poly: p.p, bbox: polygonBBox(p.p) }));
export const water = osm.W.map((w) => ({ id: w.i, name: w.n || '', poly: w.p, bbox: polygonBBox(w.p) }));

export function inWater(x, z, pad = 0) {
  for (const w of water) {
    if (x < w.bbox.x0 - pad || x > w.bbox.x1 + pad || z < w.bbox.z0 - pad || z > w.bbox.z1 + pad) continue;
    if (pointInPolygon(x, z, w.poly)) return w;
    if (pad > 0 && closestOnPolygon(x, z, w.poly, _cp).d2 < pad * pad) return w;
  }
  return null;
}

export function inBounds(x, z, margin = 0) {
  return x >= BOUNDS.minX + margin && x <= BOUNDS.maxX - margin && z >= BOUNDS.minZ + margin && z <= BOUNDS.maxZ - margin;
}

// 點所在路面（外擴 pad）上的所有具名道路名稱（不重複，寬路優先）
export function namedRoadsAt(x, z, pad = 1) {
  const R = 16 + pad;
  const list = segGrid.query(x - R, z - R, x + R, z + R, _sq);
  const hits = [];
  for (const s of list) {
    if (!s.road.name || s.road.foot) continue;
    const lim = s.road.hw + pad;
    closestOnSegment(x, z, s.ax, s.az, s.bx, s.bz, _sp);
    if (_sp.d2 < lim * lim) hits.push(s.road);
  }
  hits.sort((a, b) => b.width - a.width);
  const names = [];
  for (const r of hits) if (!names.includes(r.name)) names.push(r.name);
  return names;
}
