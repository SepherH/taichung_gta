// 依 OSM 資料計算出生點、路邊停放車輛與行人生成路線的位置（不寫死座標）
// y 一律取 querySurface（唯一高度場）；出生點 / 停車點不落在湖面，坡度 > PLACE_MAX_SLOPE 的點不用
// 行人路線（pedestrianRoutes）：人行道（道路緣外）、步道（OSM footway / pedestrian / path）、廣場（L 地表分區 pedestrian 內的弦）、
//   秋紅谷湖邊步道與坡道（terrain.lakesides / rampPaths，y 取 terrain）、百貨門口（CROWD_MALL_IDS 輪廓臨路側外緣）；
//   每條路線只保留連續「不在建築 / 水域 / 車道 / 陡坡、在界內」的區段，沿線每 PED_SPOT_STEP 一個生成點，依 PED_SPOT_WEIGHTS 加權
import { TIGER_CITY_ID, SPAWN_ROAD_NAME, PARKED_TYPES, PARKED_RADIUS, CITY_SEED, CROWD_MALL_IDS } from './data/city.js';
import { buildingById, surfaceRoads, surfaceFootways, buildingAt, onRoadSurface, junctionClearance, inBounds, inWater, querySurface, getTerrain } from './citymodel.js';
import osm from './data/osm-city.json';
import { closestOnSegment, distanceToPolygon, polygonCentroid, polylineInfo, samplePolyline, pointInPolygon, polygonBBox, polygonArea } from './geom.js';
import { mulberry32 } from './utils.js';
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

// ---------- 行人生成路線 ----------
// 權重：人流較多的地方（百貨門口、廣場、秋紅谷）抽中機率較高（手感值，推測，非人流實測）
export const PED_SPOT_WEIGHTS = { sidewalk: 1, footway: 1, plaza: 2, qiuhonggu: 2, mall: 4 };
export const PED_SPOT_STEP = 2.5; // 生成點沿線間距（m）：80 m 半徑內常見 200–400 點，約為目標人數的 4–8 倍（補生成還要避開視野與人）
const PED_ROUTE_ROAD_TYPES = new Set(['primary', 'secondary', 'tertiary', 'residential', 'unclassified']);
// 人行道行走線：路緣（半寬）外多少（m）；內外兩條（七期人行道含騎樓約 3–4 m 寬，推測），人不會全排成一列
const SIDEWALK_GAPS = [1.3, 2.6];
const ROUTE_CHECK_STEP = 2; // 路線可行走檢查的取樣間距（m）
const ROUTE_MIN_LEN = 10; // 可行走區段最短長度（m），太短的不用
const ROUTE_CLEAR_PAD = 0.5; // 與建築 / 水域保持的距離（m）
const ROUTE_ROAD_PAD = 0.3; // 與車道邊保持的距離（m）
const ROUTE_MAX_SLOPE = 30; // 行走線最大坡度（°）：秋紅谷坡道（估）可走，邊坡草地不走
const ROUTE_MIN_NY = Math.cos((ROUTE_MAX_SLOPE * Math.PI) / 180);
const PLAZA_CHORD_AREA = 300; // 廣場每多少 m² 一條弦
const PLAZA_CHORDS_MAX = 16;
const PLAZA_CHORD_LEN = [8, 24]; // 弦長範圍（m）
const LAKESIDE_GAP = 4; // 湖邊步道相鄰 piece 中心相距超過此值（m）就斷開
const MALL_GAP = 3; // 百貨門口行走線：輪廓外多少（m）
const MALL_EDGE_MIN = 8; // 輪廓邊最短長度（m）
const MALL_ROAD_REACH = 35; // 臨路側：行走線中點距地面車道（中心線 − 半寬）在此距離內
const _pq = {};

// 行走點可用：界內、不在建築 / 水域 / 車道、非陡坡
export function pedWalkable(x, z) {
  if (!inBounds(x, z, 3) || buildingAt(x, z, ROUTE_CLEAR_PAD) || inWater(x, z, ROUTE_CLEAR_PAD)) return false;
  if (onRoadSurface(x, z, ROUTE_ROAD_PAD, false)) return false;
  querySurface(x, z, Infinity, _pq);
  return _pq.ny >= ROUTE_MIN_NY && !(_pq.waterY !== null && !_pq.walkable);
}

// 折線 line 在偏移 off 處的點（off > 0 = 前進方向右側，同 traffic.js 的人行道偏移）
function offsetPoint(line, off, s, tmp) {
  samplePolyline(line, s, tmp);
  tmp.px = tmp.x - tmp.dz * off;
  tmp.pz = tmp.z + tmp.dx * off;
  return tmp;
}

// 可行走的連續區段 → routes.push({ road: line, off, s0, s1, kind })
function addRoute(routes, line, off, kind, kindAt = null) {
  const tmp = {};
  let start = null;
  let last = 0;
  const flush = () => {
    if (start !== null && last - start >= ROUTE_MIN_LEN) {
      const mid = offsetPoint(line, off, (start + last) / 2, tmp);
      routes.push({ road: line, off, s0: start, s1: last, kind: kindAt ? kindAt(mid.px, mid.pz) : kind });
    }
    start = null;
  };
  for (let s = 0; s <= line.length + 1e-6; s += ROUTE_CHECK_STEP) {
    const p = offsetPoint(line, off, Math.min(s, line.length), tmp);
    if (pedWalkable(p.px, p.pz)) {
      if (start === null) start = s;
      last = Math.min(s, line.length);
    } else flush();
  }
  flush();
}

let pedRoutesCache = null;

// 全部行人路線與生成點（固定種子、只算一次）：{ routes, spots: [{ x, z, route, s, w }] }
export function pedestrianRoutes() {
  if (pedRoutesCache) return pedRoutesCache;
  const routes = [];
  const terrain = getTerrain();
  const basins = terrain.patches.filter((p) => p.kind === 'basin' && p.feature && p.feature.src).map((p) => p.feature.src.p);
  const inBasin = (x, z) => basins.some((poly) => pointInPolygon(x, z, poly));
  // 人行道：道路兩側路緣外
  for (const r of surfaceRoads) {
    if (!PED_ROUTE_ROAD_TYPES.has(r.type) || r.length < ROUTE_MIN_LEN) continue;
    for (const side of [1, -1]) for (const gap of SIDEWALK_GAPS) addRoute(routes, r, side * (r.hw + gap), 'sidewalk');
  }
  // 步道（天橋 / 高架與階梯不走）；秋紅谷範圍內的歸 qiuhonggu
  for (const r of surfaceFootways) {
    if (r.bridge || r.layer > 0 || r.type === 'steps' || r.length < ROUTE_MIN_LEN) continue;
    addRoute(routes, r, 0, 'footway', (x, z) => (inBasin(x, z) ? 'qiuhonggu' : 'footway'));
  }
  // 秋紅谷：湖邊步道（lakeside piece 中心連線）與北端坡道
  for (const ls of terrain.lakesides) {
    let flat = [];
    const flushLake = () => {
      if (flat.length >= 4) addRoute(routes, polylineInfo(flat), 0, 'qiuhonggu');
      flat = [];
    };
    for (const pc of ls.pieces) {
      const q = pc.quad;
      const cx = (q[0] + q[2] + q[4] + q[6]) / 4;
      const cz = (q[1] + q[3] + q[5] + q[7]) / 4;
      const n = flat.length;
      if (n && Math.hypot(cx - flat[n - 2], cz - flat[n - 1]) > LAKESIDE_GAP) flushLake();
      flat.push(cx, cz);
    }
    flushLake();
  }
  for (const rp of terrain.rampPaths) addRoute(routes, polylineInfo(rp.pts.flatMap((p) => [p.x, p.z])), 0, 'qiuhonggu');
  // 廣場：L 地表分區 pedestrian 內的隨機弦（固定種子）
  const rng = mulberry32(CITY_SEED + 21);
  for (const l of osm.L || []) {
    if (l.k !== 'pedestrian') continue;
    const bb = polygonBBox(l.p);
    const n = Math.min(PLAZA_CHORDS_MAX, Math.max(2, Math.round(polygonArea(l.p) / PLAZA_CHORD_AREA)));
    for (let k = 0; k < n; k++) {
      let ax = 0;
      let az = 0;
      let ok = false;
      for (let tries = 0; tries < 30 && !ok; tries++) {
        ax = bb.x0 + rng() * (bb.x1 - bb.x0);
        az = bb.z0 + rng() * (bb.z1 - bb.z0);
        ok = pointInPolygon(ax, az, l.p);
      }
      if (!ok) continue;
      const ang = rng() * Math.PI * 2;
      const len = PLAZA_CHORD_LEN[0] + rng() * (PLAZA_CHORD_LEN[1] - PLAZA_CHORD_LEN[0]);
      const bx = ax + Math.cos(ang) * len;
      const bz = az + Math.sin(ang) * len;
      if (!pointInPolygon(bx, bz, l.p)) continue;
      addRoute(routes, polylineInfo([ax, az, bx, bz]), 0, 'plaza');
    }
  }
  // 百貨門口：輪廓各邊外 MALL_GAP 的平行線，只取臨路側
  for (const id of CROWD_MALL_IDS) {
    const b = buildingById(id);
    if (!b) continue;
    const p = b.poly;
    const n = p.length / 2;
    for (let i = 0; i < n; i++) {
      const ax = p[i * 2];
      const az = p[i * 2 + 1];
      const bx = p[((i + 1) % n) * 2];
      const bz = p[((i + 1) % n) * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < MALL_EDGE_MIN) continue;
      const tx = (bx - ax) / L;
      const tz = (bz - az) / L;
      // 外法線：邊中點往法線 1 m 不在輪廓內的那一側
      let nx = tz;
      let nz = -tx;
      if (pointInPolygon((ax + bx) / 2 + nx, (az + bz) / 2 + nz, p)) {
        nx = -nx;
        nz = -nz;
      }
      const mx = (ax + bx) / 2 + nx * MALL_GAP;
      const mz = (az + bz) / 2 + nz * MALL_GAP;
      if (!onRoadSurface(mx, mz, MALL_ROAD_REACH, false)) continue;
      const line = polylineInfo([ax + nx * MALL_GAP + tx, az + nz * MALL_GAP + tz, bx + nx * MALL_GAP - tx, bz + nz * MALL_GAP - tz]);
      addRoute(routes, line, 0, 'mall');
    }
  }
  // 生成點
  const spots = [];
  const tmp = {};
  for (const route of routes) {
    const w = PED_SPOT_WEIGHTS[route.kind];
    for (let s = route.s0 + 1; s <= route.s1 - 1; s += PED_SPOT_STEP) {
      offsetPoint(route.road, route.off, s, tmp);
      spots.push({ x: tmp.px, z: tmp.pz, route, s, w });
    }
  }
  pedRoutesCache = { routes, spots };
  return pedRoutesCache;
}
