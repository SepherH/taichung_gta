// 選單運鏡巡覽（M6，契約 docs/dev/interfaces.md §25）：未進入遊戲（開始畫面 / 回到主選單）時鏡頭以電影式運鏡循環巡覽全區
// 純邏輯、不 import three / DOM：鏡頭只用 camera.position.set(x, y, z) 與 camera.quaternion.set(x, y, z, w)（自算 lookAt 四元數），node 可直接測
//
// 鏡位（tourStops）：全部由既有資料推導，不寫死座標——
//   OSM 具名建築（citymodel namedBuildings，依名稱比對、同名取面積最大者）：老虎城（Tiger City）、新光三越、臺中國家歌劇院、市政府、捷運市政府站；
//   秋紅谷 = osm-city.json T.basins（下凹公園輪廓）；夜市攤車 = main.js stallRow 的原攤車格（缺 → missions/events.js NIGHT_MARKET_DELIVERY.pickup）
//   巡覽順序：以老虎城為起點、窮舉排列取總距離最短的封閉迴圈（鏡位 ≤ 8 個，≤ 5040 種）
// 鏡頭型態（SHOT_TYPES）依序輪替：環繞 orbit / 推軌 dolly / 升降 crane / 沿道路低空飛行 road，每段 8–12 s（SHOT_SEC）；
//   段間以三次 Hermite 曲線滑行（端點位置與速度連續 = C1，弧頂加高越過市區），秒數 = 距離 ÷ GLIDE_SPEED（夾在 GLIDE_MIN–GLIDE_MAX）
// 路徑建立（buildTour，載入時一次）：整輪以 SAMPLE_HZ 取樣 → 水平 / 看點以 SMOOTH_SEC 窗口循環平滑 →
//   高度下限 floor = max(地形（含湖面）+ SAFE_CLEAR, 水平 BUILDING_PAD 內建築頂 + ROOF_CLEAR) → 上升率 ≤ CLIMB_RATE 的前後向包絡（提早爬升）；
//   執行期以 Catmull-Rom 在樣本間內插（不配置物件），末樣本接回首樣本（循環）
// 時間（§20 / §25）：巡覽計時吃渲染 dt（屬「相機」），與 simDt 無關——卡頓丟子步時運鏡不變慢；暫停 / 切背景時 loop 不呼叫 update，計時停住
// 減少動態效果（reducedMotion() 為 true，main.js 接 matchMedia('(prefers-reduced-motion: reduce)')）：改走老虎城慢速環繞 REDUCED_OMEGA rad/s；
//   偏好中途切換時以 blend 平順轉場
// 進出遊戲：stop() 記下巡覽最後鏡位 → 遊戲中每幀 rig.update 之後呼叫 handoff(dt)，HANDOFF 秒內由巡覽鏡位內插到玩家鏡頭（位置 smoothstep 線性 + 四元數 slerp，
//   途中高度不低於 floor 的殘量），結束後不再改動鏡頭；start()（回主選單）由當下鏡頭內插回巡覽路徑（巡覽時間接續上次）
import { SpatialGrid, closestOnPolygon, pointInPolygon, polygonBBox, polygonCentroid, polylineInfo, samplePolyline, closestOnSegment } from '../geom.js';

export const SAMPLE_HZ = 10; // 路徑取樣頻率（Hz）
export const SAFE_CLEAR = 4; // 高度下限：地形（湖面取較高者）+ 此值（m）
export const BUILDING_PAD = 10; // 鏡頭水平此距離內的建築都算在下方（m）
export const ROOF_CLEAR = 6; // 建築頂上方安全距離（m）
export const CLIMB_RATE = 12; // 為了越過建築，提早爬升 / 延後下降的最大垂直速率（m/s）
export const SMOOTH_SEC = 1.2; // 水平與看點的循環平滑窗口（s）
export const SHOT_TYPES = ['orbit', 'dolly', 'crane', 'road'];
export const SHOT_SEC = { orbit: 12, dolly: 9, crane: 10, road: 11 }; // 每段秒數（規格 8–12 s）
export const GLIDE_SPEED = 45; // 段間滑行平均速度（m/s）
export const GLIDE_MIN = 4; // 段間滑行秒數下限（s）
export const GLIDE_MAX = 14; // 段間滑行秒數上限（s）
export const ROAD_SPEED = 14; // 低空飛行速度（m/s）
export const ROAD_ALT = 10; // 低空飛行離路面高度（m）
export const ROAD_TYPES = new Set(['primary', 'secondary', 'tertiary']); // 低空飛行選用的道路等級
export const REDUCED_OMEGA = 0.03; // 減少動態效果：慢速環繞角速度（rad/s；原出生點環繞為 0.05）
export const REDUCED_RADIUS = 150; // 減少動態效果：環繞半徑（m，同原出生點環繞）
export const REDUCED_ALT = 70; // 減少動態效果：環繞高度下限（m，同原出生點環繞；整圈取 floor 最大值與此值較高者，全程固定高度）
export const HANDOFF_MIN = 1; // 進出遊戲鏡頭內插秒數下限（s）
export const HANDOFF_MAX = 2.5; // 進出遊戲鏡頭內插秒數上限（s）
export const HANDOFF_SPEED = 80; // 內插秒數 = 距離 ÷ 此值（m/s），夾在上下限之間
export const STALL_SIZE = { ext: 3, top: 2.5 }; // 夜市攤車無 OSM 輪廓：鏡位用的外徑 / 高度（m，同 prop manifest 攤車尺寸量級）

// 鏡位定義：key、顯示名、比對 namedBuildings 名稱的規則（basin / stall 另由專屬資料推導）
export const STOP_DEFS = [
  { key: 'tiger', name: 'Tiger City（老虎城）', re: /^老虎城/ },
  { key: 'shinkong', name: '新光三越', re: /^新光三越$/ },
  { key: 'stall', name: '夜市攤車', source: 'stall' },
  { key: 'opera', name: '臺中國家歌劇院', re: /歌劇院/ },
  { key: 'cityhall', name: '臺中市政府', re: /^臺中市政府臺灣大道市政大樓$/ },
  { key: 'mrt', name: '捷運市政府站', re: /^捷運市政府站$/ },
  { key: 'qiuhonggu', name: '秋紅谷', source: 'basin', re: /秋紅谷/ },
];

const smooth = (k) => k * k * (3 - 2 * k);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// 地面（鏡頭用）：高度場高度（不站甲板），湖面範圍取水面與湖床較高者——同 camera.js groundAt
function makeGround(terrain) {
  const q = {};
  return (x, z) => {
    const s = terrain.querySurface(x, z, -Infinity, q);
    return s.waterY !== null && s.waterY !== undefined ? Math.max(s.y, s.waterY) : s.y;
  };
}

// 高度下限函式：floor(x, z) = max(地面 + SAFE_CLEAR, BUILDING_PAD 內建築頂 + ROOF_CLEAR)
export function makeFloor(terrain, buildings) {
  const ground = makeGround(terrain);
  const grid = new SpatialGrid(25);
  for (const b of buildings) grid.insert(b, b.bbox.x0, b.bbox.z0, b.bbox.x1, b.bbox.z1);
  const list = [];
  const cp = {};
  const base = (b) => (typeof terrain.buildingBase === 'function' ? terrain.buildingBase(b.id) : 0);
  return (x, z) => {
    let f = ground(x, z) + SAFE_CLEAR;
    const p = BUILDING_PAD;
    grid.query(x - p, z - p, x + p, z + p, list);
    for (const b of list) {
      const top = base(b) + b.height + ROOF_CLEAR;
      if (top <= f) continue;
      if (x < b.bbox.x0 - p || x > b.bbox.x1 + p || z < b.bbox.z0 - p || z > b.bbox.z1 + p) continue;
      if (pointInPolygon(x, z, b.poly) || closestOnPolygon(x, z, b.poly, cp).d2 < p * p) f = top;
    }
    return f;
  };
}

// 鏡位清單：[{ key, name, source, x, z, ext（水平外徑 m）, top（離地高 m）, base（地面 y）, id? }]，資料缺者略過
export function tourStops({ namedBuildings = [], basins = [], stall = null, terrain }) {
  const ground = makeGround(terrain);
  const out = [];
  for (const d of STOP_DEFS) {
    if (d.source === 'stall') {
      if (!stall || !Number.isFinite(stall.x) || !Number.isFinite(stall.z)) continue;
      out.push({ key: d.key, name: d.name, source: stall.source || 'stallRow', x: stall.x, z: stall.z, ext: STALL_SIZE.ext, top: STALL_SIZE.top, base: ground(stall.x, stall.z) });
      continue;
    }
    if (d.source === 'basin') {
      const b = basins.find((s) => s && s.n && d.re.test(s.n) && Array.isArray(s.p));
      if (!b) continue;
      const c = polygonCentroid(b.p);
      const bb = polygonBBox(b.p);
      out.push({ key: d.key, name: d.name, source: `osm T.basins ${b.i}`, x: c.x, z: c.z, ext: Math.max(bb.x1 - bb.x0, bb.z1 - bb.z0), top: 0, base: 0 });
      continue;
    }
    let best = null;
    for (const b of namedBuildings) if (d.re.test(b.name) && (!best || b.area > best.area)) best = b;
    if (!best) continue;
    const base = typeof terrain.buildingBase === 'function' ? terrain.buildingBase(best.id) : 0;
    out.push({
      key: d.key, name: d.name, source: `osm B ${best.id}`, id: best.id, x: best.center.x, z: best.center.z,
      ext: Math.max(best.bbox.x1 - best.bbox.x0, best.bbox.z1 - best.bbox.z0), top: best.height, base,
    });
  }
  return out;
}

// 封閉迴圈最短排列（第一站固定）
function orderStops(stops) {
  if (stops.length <= 3) return stops.slice();
  const rest = stops.slice(1);
  const d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  let best = null;
  let bestLen = Infinity;
  const perm = (arr, k) => {
    if (k === arr.length) {
      let len = d(stops[0], arr[0]) + d(arr[arr.length - 1], stops[0]);
      for (let i = 1; i < arr.length; i++) len += d(arr[i - 1], arr[i]);
      if (len < bestLen) {
        bestLen = len;
        best = arr.slice();
      }
      return;
    }
    for (let i = k; i < arr.length; i++) {
      [arr[k], arr[i]] = [arr[i], arr[k]];
      perm(arr, k + 1);
      [arr[k], arr[i]] = [arr[i], arr[k]];
    }
  };
  perm(rest, 0);
  return [stops[0], ...best];
}

// 鏡位附近的道路：回傳 { road, s（最近點的里程）, x, z, dist } 或 null；needLen > 0 時只取長度足夠者
function nearestRoad(roads, x, z, needLen = 0) {
  const seg = { x: 0, z: 0, d2: 0, t: 0 };
  let best = null;
  for (const r of roads) {
    if (!ROAD_TYPES.has(r.type) || r.length < needLen) continue;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i];
      const b = r.pts[i + 1];
      closestOnSegment(x, z, a.x, a.z, b.x, b.z, seg);
      if (!best || seg.d2 < best.d2) best = { road: r, d2: seg.d2, x: seg.x, z: seg.z, s: r.cum[i] + seg.t * (r.cum[i + 1] - r.cum[i]) };
    }
  }
  if (best) best.dist = Math.sqrt(best.d2);
  return best;
}

// 單一鏡位的運鏡：回傳 { type, sec, pos(u, out), look(u, out) }，u ∈ [0, 1]
function makeShot(type, stop, roads) {
  const c = stop;
  const near = nearestRoad(roads, c.x, c.z);
  // 鏡頭擺放方向：朝最近道路（開放空間）一側；找不到道路時朝南
  let dx = 0;
  let dz = 1;
  if (near && near.dist > 1) {
    dx = (near.x - c.x) / near.dist;
    dz = (near.z - c.z) / near.dist;
  }
  const sx = -dz; // 側向（推軌方向）
  const sz = dx;
  const lookY = c.base + c.top * 0.4;
  const R = c.ext / 2;
  const sec = SHOT_SEC[type];
  if (type === 'orbit') {
    const r = R + 60;
    const h = c.base + c.top + 25;
    const a0 = Math.atan2(dz, dx);
    const sweep = (14 * sec) / r; // 弧長速度約 14 m/s
    return {
      type, sec,
      pos: (u, o) => {
        const a = a0 + sweep * u;
        o.x = c.x + Math.cos(a) * r;
        o.y = h;
        o.z = c.z + Math.sin(a) * r;
      },
      look: (u, o) => {
        o.x = c.x;
        o.y = lookY;
        o.z = c.z;
      },
    };
  }
  if (type === 'dolly') {
    const d = R + (c.top < 10 ? 22 : 40);
    const len = c.top < 10 ? 40 : 70;
    const h = c.base + Math.max(8, c.top * 0.5);
    return {
      type, sec,
      pos: (u, o) => {
        const t = (u - 0.5) * len;
        o.x = c.x + dx * d + sx * t;
        o.y = h;
        o.z = c.z + dz * d + sz * t;
      },
      look: (u, o) => {
        const t = (u - 0.5) * len * 0.3;
        o.x = c.x + sx * t;
        o.y = c.base + Math.max(1, c.top * 0.4);
        o.z = c.z + sz * t;
      },
    };
  }
  if (type === 'crane') {
    const d = R + 45;
    const y0 = c.base + 8;
    const y1 = c.base + c.top + 50;
    return {
      type, sec,
      pos: (u, o) => {
        o.x = c.x + dx * d;
        o.y = y0 + (y1 - y0) * smooth(u);
        o.z = c.z + dz * d;
      },
      look: (u, o) => {
        o.x = c.x;
        o.y = c.base + c.top * (0.6 - 0.3 * u);
        o.z = c.z;
      },
    };
  }
  // road：沿最近的主要道路低空飛行，里程中點對準鏡位最近點，看前方 LOOK_AHEAD
  const len = ROAD_SPEED * sec;
  const rd = nearestRoad(roads, c.x, c.z, len + 40);
  if (!rd) return makeShot('orbit', stop, roads);
  const info = { pts: rd.road.pts, cum: rd.road.cum, length: rd.road.length };
  const s0 = clamp(rd.s - len / 2, 0, rd.road.length - len);
  const tmp = { x: 0, z: 0 };
  const LOOK_AHEAD = 35;
  return {
    type, sec,
    pos: (u, o) => {
      samplePolyline(info, s0 + len * u, tmp);
      o.x = tmp.x;
      o.y = c.base + ROAD_ALT;
      o.z = tmp.z;
    },
    look: (u, o) => {
      samplePolyline(info, Math.min(rd.road.length, s0 + len * u + LOOK_AHEAD), tmp);
      o.x = tmp.x;
      o.y = c.base + ROAD_ALT * 0.4;
      o.z = tmp.z;
    },
  };
}

// 數值切線（每秒）：f(u, o) 在 u 端點，shot 秒數 sec
function tangent(f, u, sec, out) {
  const a = {};
  const b = {};
  const h = 0.01;
  const u0 = Math.max(0, u - h);
  const u1 = Math.min(1, u + h);
  f(u0, a);
  f(u1, b);
  const k = 1 / ((u1 - u0) * sec);
  out.x = (b.x - a.x) * k;
  out.y = (b.y - a.y) * k;
  out.z = (b.z - a.z) * k;
  return out;
}

// 段間滑行：三次 Hermite（位置與速度連續），弧頂加高 bump
function makeGlide(A, B) {
  const pa = {};
  const pb = {};
  const la = {};
  const lb = {};
  A.pos(1, pa);
  B.pos(0, pb);
  A.look(1, la);
  B.look(0, lb);
  const dist = Math.hypot(pb.x - pa.x, pb.z - pa.z);
  const sec = clamp(dist / GLIDE_SPEED, GLIDE_MIN, GLIDE_MAX);
  const va = tangent(A.pos, 1, A.sec, {});
  const vb = tangent(B.pos, 0, B.sec, {});
  const wa = tangent(A.look, 1, A.sec, {});
  const wb = tangent(B.look, 0, B.sec, {});
  const bump = Math.min(80, dist * 0.12);
  const herm = (p0, v0, p1, v1, s, o) => {
    const s2 = s * s;
    const s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1;
    const h10 = s3 - 2 * s2 + s;
    const h01 = -2 * s3 + 3 * s2;
    const h11 = s3 - s2;
    o.x = h00 * p0.x + h10 * sec * v0.x + h01 * p1.x + h11 * sec * v1.x;
    o.y = h00 * p0.y + h10 * sec * v0.y + h01 * p1.y + h11 * sec * v1.y;
    o.z = h00 * p0.z + h10 * sec * v0.z + h01 * p1.z + h11 * sec * v1.z;
  };
  return {
    type: 'glide', sec,
    // bump = 16 s²(1 − s)²：端點值與一階導數皆 0，不破壞 C1
    pos: (s, o) => {
      herm(pa, va, pb, vb, s, o);
      o.y += bump * 16 * s * s * (1 - s) * (1 - s);
    },
    look: (s, o) => herm(la, wa, lb, wb, s, o),
  };
}

// 循環移動平均（半窗 w 個樣本）
function smoothCyclic(arr, w) {
  const n = arr.length;
  if (w <= 0 || n < 3) return;
  const src = Float64Array.from(arr);
  const k = 2 * w + 1;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = -w; j <= w; j++) s += src[(i + j + n) % n];
    arr[i] = s / k;
  }
}

// 高度：≥ floor，且上升 / 下降率 ≤ CLIMB_RATE（前後向循環包絡，跑兩圈讓循環接縫也滿足）
function liftCyclic(y, floor, dtS) {
  const n = y.length;
  for (let i = 0; i < n; i++) if (y[i] < floor[i]) y[i] = floor[i];
  const k = CLIMB_RATE * dtS;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < 2 * n; i++) {
      const a = i % n;
      const p = (a - 1 + n) % n;
      if (y[a] < y[p] - k) y[a] = y[p] - k;
    }
    for (let i = 2 * n - 1; i >= 0; i--) {
      const a = i % n;
      const p = (a + 1) % n;
      if (y[a] < y[p] - k) y[a] = y[p] - k;
    }
  }
}

// 由 shot 序列（已含 glide）取樣成循環路徑
function samplePath(parts, floorAt) {
  const dtS = 1 / SAMPLE_HZ;
  let total = 0;
  for (const p of parts) total += p.sec;
  const n = Math.max(4, Math.round(total * SAMPLE_HZ));
  const duration = n * dtS; // 取整到樣本格（各段秒數按比例微調 < 0.1 s）
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const pz = new Float64Array(n);
  const lx = new Float64Array(n);
  const ly = new Float64Array(n);
  const lz = new Float64Array(n);
  const o = {};
  let pi = 0;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * total;
    while (pi < parts.length - 1 && t >= acc + parts[pi].sec) acc += parts[pi++].sec;
    const u = clamp((t - acc) / parts[pi].sec, 0, 1);
    parts[pi].pos(u, o);
    px[i] = o.x;
    py[i] = o.y;
    pz[i] = o.z;
    parts[pi].look(u, o);
    lx[i] = o.x;
    ly[i] = o.y;
    lz[i] = o.z;
  }
  const w = Math.round((SMOOTH_SEC * SAMPLE_HZ) / 2);
  for (const a of [px, pz, lx, ly, lz]) smoothCyclic(a, w);
  smoothCyclic(py, w);
  const floor = new Float64Array(n);
  // 樣本間 Catmull-Rom 內插的水平位置也要在建築範圍外：floor 取本樣本與前後半格的最大值
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    floor[i] = Math.max(floorAt(px[i], pz[i]), floorAt((px[i] + px[j]) / 2, (pz[i] + pz[j]) / 2));
  }
  // 包絡用前後各一格擴張的 floor：樣本高度 ≥ 相鄰樣本的 floor，執行期的 floor 夾限（samplePathAt）在樣本點上不會生效 → 不產生跳階
  const lift = new Float64Array(n);
  for (let i = 0; i < n; i++) lift[i] = Math.max(floor[(i - 1 + n) % n], floor[i], floor[(i + 1) % n]);
  liftCyclic(py, lift, dtS);
  smoothCyclic(py, 2);
  liftCyclic(py, lift, dtS);
  // 段落表（以實際取整後的時間尺度）
  const scale = duration / total;
  const segments = [];
  let t0 = 0;
  for (const p of parts) {
    segments.push({ type: p.type, name: p.name || '', key: p.key || '', t0: t0 * scale, t1: (t0 + p.sec) * scale, sec: p.sec * scale });
    t0 += p.sec;
  }
  return { n, duration, px, py, pz, lx, ly, lz, floor, segments };
}

const cr = (p0, p1, p2, p3, t) => {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
};

// 取路徑 t 秒的鏡位 / 看點（t 自動取模）
export function samplePathAt(path, t, pos, look) {
  const { n } = path;
  let f = ((t % path.duration) + path.duration) % path.duration;
  f *= SAMPLE_HZ;
  const i1 = Math.floor(f) % n;
  const k = f - Math.floor(f);
  const i0 = (i1 - 1 + n) % n;
  const i2 = (i1 + 1) % n;
  const i3 = (i1 + 2) % n;
  pos.x = cr(path.px[i0], path.px[i1], path.px[i2], path.px[i3], k);
  pos.y = cr(path.py[i0], path.py[i1], path.py[i2], path.py[i3], k);
  pos.z = cr(path.pz[i0], path.pz[i1], path.pz[i2], path.pz[i3], k);
  // Catmull-Rom 可能略低於兩端樣本：不低於兩端的 floor
  const fl = Math.max(path.floor[i1], path.floor[i2]);
  if (pos.y < fl) pos.y = fl;
  look.x = cr(path.lx[i0], path.lx[i1], path.lx[i2], path.lx[i3], k);
  look.y = cr(path.ly[i0], path.ly[i1], path.ly[i2], path.ly[i3], k);
  look.z = cr(path.lz[i0], path.lz[i1], path.lz[i2], path.lz[i3], k);
}

// 完整巡覽：{ stops, segments, duration, ... } —— deps = { terrain, buildings, namedBuildings, roads, basins, stall }
export function buildTour(deps) {
  const floorAt = makeFloor(deps.terrain, deps.buildings || []);
  const stops = orderStops(tourStops(deps));
  if (stops.length === 0) return null;
  const roads = deps.roads || [];
  const shots = stops.map((s, i) => {
    const sh = makeShot(SHOT_TYPES[i % SHOT_TYPES.length], s, roads);
    sh.name = s.name;
    sh.key = s.key;
    return sh;
  });
  const parts = [];
  for (let i = 0; i < shots.length; i++) {
    parts.push(shots[i]);
    const g = makeGlide(shots[i], shots[(i + 1) % shots.length]);
    g.name = `${shots[i].name} → ${shots[(i + 1) % shots.length].name}`;
    parts.push(g);
  }
  const path = samplePath(parts, floorAt);
  return { ...path, stops, floorAt };
}

// 減少動態效果：老虎城（第一個鏡位）固定高度慢速環繞一整圈為一輪
export function buildReducedTour(deps) {
  const floorAt = makeFloor(deps.terrain, deps.buildings || []);
  const stops = tourStops(deps);
  const c = stops.find((s) => s.key === 'tiger') || stops[0] || { x: 0, z: 0, base: 0, top: 10, name: '原點' };
  const sec = (2 * Math.PI) / REDUCED_OMEGA;
  // 固定高度（不上下起伏）：取整圈 floor 的最大值與 REDUCED_ALT 較高者
  let alt = REDUCED_ALT;
  for (let i = 0; i < 360; i++) {
    const a = (i / 360) * 2 * Math.PI;
    alt = Math.max(alt, floorAt(c.x + Math.cos(a) * REDUCED_RADIUS, c.z + Math.sin(a) * REDUCED_RADIUS));
  }
  const part = {
    type: 'orbit-slow', sec, name: c.name, key: c.key,
    pos: (u, o) => {
      const a = u * 2 * Math.PI;
      o.x = c.x + Math.cos(a) * REDUCED_RADIUS;
      o.y = alt;
      o.z = c.z + Math.sin(a) * REDUCED_RADIUS;
    },
    look: (u, o) => {
      o.x = c.x;
      o.y = 10;
      o.z = c.z;
    },
  };
  const path = samplePath([part], floorAt);
  return { ...path, stops: [c], floorAt, center: c };
}

// lookAt 四元數（three.js 相機慣例：本地 −Z 朝前、+Y 朝上）→ out { x, y, z, w }
export function lookQuat(px, py, pz, tx, ty, tz, out) {
  let zx = px - tx;
  let zy = py - ty;
  let zz = pz - tz;
  let l = Math.hypot(zx, zy, zz) || 1;
  zx /= l;
  zy /= l;
  zz /= l;
  // x = up(0,1,0) × z
  let xx = zz;
  let xz = -zx;
  l = Math.hypot(xx, xz);
  if (l < 1e-6) {
    xx = 1;
    xz = 0;
  } else {
    xx /= l;
    xz /= l;
  }
  // y = z × x（x 的 y 分量為 0）
  const yx = zy * xz;
  const yy = zz * xx - zx * xz;
  const yz = -zy * xx;
  const m11 = xx, m12 = yx, m13 = zx;
  const m21 = 0, m22 = yy, m23 = zy;
  const m31 = xz, m32 = yz, m33 = zz;
  const tr = m11 + m22 + m33;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    out.w = 0.25 / s;
    out.x = (m32 - m23) * s;
    out.y = (m13 - m31) * s;
    out.z = (m21 - m12) * s;
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    out.w = (m32 - m23) / s;
    out.x = 0.25 * s;
    out.y = (m12 + m21) / s;
    out.z = (m13 + m31) / s;
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    out.w = (m13 - m31) / s;
    out.x = (m12 + m21) / s;
    out.y = 0.25 * s;
    out.z = (m23 + m32) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    out.w = (m21 - m12) / s;
    out.x = (m13 + m31) / s;
    out.y = (m23 + m32) / s;
    out.z = 0.25 * s;
  }
  return out;
}

// 四元數球面內插 a → b（k ∈ [0, 1]）→ out
export function slerpQuat(a, b, k, out) {
  let bx = b.x, by = b.y, bz = b.z, bw = b.w;
  let cos = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let ka = 1 - k;
  let kb = k;
  if (cos < 0.9995) {
    const th = Math.acos(cos);
    const s = Math.sin(th);
    ka = Math.sin((1 - k) * th) / s;
    kb = Math.sin(k * th) / s;
  }
  out.x = a.x * ka + bx * kb;
  out.y = a.y * ka + by * kb;
  out.z = a.z * ka + bz * kb;
  out.w = a.w * ka + bw * kb;
  const l = Math.hypot(out.x, out.y, out.z, out.w) || 1;
  out.x /= l;
  out.y /= l;
  out.z /= l;
  out.w /= l;
  return out;
}

// 控制器：main.js 只接線（updateAttract → update；startGame → stop；updateGame rig.update 之後 → handoff；quitToMenu → start）
// opts = { camera, terrain, buildings, namedBuildings, roads, basins, stall, reducedMotion: () => boolean, focus?（寫入 { x, y, z } 的物件） }
export function createMenuTour(opts) {
  const { camera } = opts;
  const reduced = typeof opts.reducedMotion === 'function' ? opts.reducedMotion : () => false;
  const full = buildTour(opts);
  const slow = buildReducedTour(opts);
  const focus = opts.focus || { x: 0, y: 0, z: 0 };
  const pos = { x: 0, y: 0, z: 0 };
  const look = { x: 0, y: 0, z: 0 };
  const q = { x: 0, y: 0, z: 0, w: 1 };
  const qo = { x: 0, y: 0, z: 0, w: 1 };
  // 內插：from = 起點鏡頭（位置 + 四元數），t / dur；kind 'in'（回到巡覽）| 'out'（接回玩家）
  const blend = { kind: null, t: 0, dur: 1, fx: 0, fy: 0, fz: 0, fq: { x: 0, y: 0, z: 0, w: 1 } };
  let path = reduced() ? slow : full || slow;
  let time = 0;
  let active = true;
  let first = true;

  const grab = () => {
    blend.fx = camera.position.x;
    blend.fy = camera.position.y;
    blend.fz = camera.position.z;
    blend.fq.x = camera.quaternion.x;
    blend.fq.y = camera.quaternion.y;
    blend.fq.z = camera.quaternion.z;
    blend.fq.w = camera.quaternion.w;
  };
  const beginBlend = (kind, tx, ty, tz) => {
    grab();
    blend.kind = kind;
    blend.t = 0;
    blend.dur = clamp(Math.hypot(tx - blend.fx, ty - blend.fy, tz - blend.fz) / HANDOFF_SPEED, HANDOFF_MIN, HANDOFF_MAX);
  };
  // 依 blend 進度把鏡頭從 from 內插到 (x, y, z, qTo)；回傳是否仍在內插
  const applyBlend = (dt, x, y, z, qTo) => {
    blend.t += dt;
    const u = clamp(blend.t / blend.dur, 0, 1);
    const k = smooth(u);
    // 高度先行：回到巡覽（in）先升高再橫移；接回玩家（out）先橫移再下降——貼近街面的那一端走近乎垂直的線，不斜穿旁邊的建築
    const ky = blend.kind === 'in' ? smooth(Math.min(1, u * 2)) : smooth(Math.max(0, u * 2 - 1));
    const bx = blend.fx + (x - blend.fx) * k;
    let by = blend.fy + (y - blend.fy) * ky;
    const bz = blend.fz + (z - blend.fz) * k;
    // 保險：途中不低於 floor；權重在兩端 25% 內漸變到 0（兩端分別是玩家鏡頭與巡覽鏡位，本身就合法）
    const fl = path.floorAt(bx, bz);
    if (by < fl) by += (fl - by) * smooth(Math.min(1, 4 * Math.min(u, 1 - u)));
    camera.position.set(bx, by, bz);
    slerpQuat(blend.fq, qTo, k, qo);
    camera.quaternion.set(qo.x, qo.y, qo.z, qo.w);
    if (blend.t >= blend.dur) {
      blend.kind = null;
      return false;
    }
    return true;
  };

  return {
    get active() {
      return active;
    },
    get mode() {
      return path === slow ? 'reduced' : 'tour';
    },
    get time() {
      return time;
    },
    get blending() {
      return blend.kind;
    },
    get path() {
      return path;
    },
    full,
    slow,
    focus,
    // 選單期間每幀：dt = 渲染幀時間（§20 屬相機；不吃 simDt）
    update(dt) {
      if (!active) return;
      const wantSlow = reduced() || !full;
      if ((path === slow) !== wantSlow) {
        // 偏好切換：從當下鏡頭內插到新路徑（新路徑時間從 0 起）
        path = wantSlow ? slow : full;
        time = 0;
        samplePathAt(path, time, pos, look);
        beginBlend('in', pos.x, pos.y, pos.z);
      }
      time = (time + dt) % path.duration;
      samplePathAt(path, time, pos, look);
      lookQuat(pos.x, pos.y, pos.z, look.x, look.y, look.z, q);
      focus.x = look.x;
      focus.z = look.z;
      focus.y = 0;
      if (first) {
        first = false;
        blend.kind = null;
      }
      if (blend.kind === 'in') applyBlend(dt, pos.x, pos.y, pos.z, q);
      else {
        camera.position.set(pos.x, pos.y, pos.z);
        camera.quaternion.set(q.x, q.y, q.z, q.w);
      }
    },
    // 進入遊戲：停止巡覽，記下最後鏡位供 handoff 內插
    stop() {
      if (!active) return;
      active = false;
      grab();
      blend.kind = 'out';
      blend.t = 0;
      blend.dur = null; // 第一幀 handoff 才知道玩家鏡頭位置
    },
    // 遊戲中每幀 rig.update 之後呼叫：內插期間覆寫鏡頭，結束後不動；回傳是否仍在內插
    handoff(dt) {
      if (active || blend.kind !== 'out') return false;
      const tx = camera.position.x;
      const ty = camera.position.y;
      const tz = camera.position.z;
      q.x = camera.quaternion.x;
      q.y = camera.quaternion.y;
      q.z = camera.quaternion.z;
      q.w = camera.quaternion.w;
      if (blend.dur === null) blend.dur = clamp(Math.hypot(tx - blend.fx, ty - blend.fy, tz - blend.fz) / HANDOFF_SPEED, HANDOFF_MIN, HANDOFF_MAX);
      return applyBlend(dt, tx, ty, tz, q);
    },
    // 回到主選單：恢復巡覽（時間接續），從當下鏡頭內插回路徑
    start() {
      if (active) return;
      active = true;
      first = false;
      samplePathAt(path, time, pos, look);
      beginBlend('in', pos.x, pos.y, pos.z);
    },
  };
}
