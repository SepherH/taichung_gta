#!/usr/bin/env node
// P8c 選單運鏡穿模（src/ui/menu-tour.js）：以真 citymodel + 地標 glb 實際幾何，全時間軸取樣鏡頭位置，斷言鏡頭不在任何實體內部、
//   且離表面 ≥ 近平面 CAM_NEAR + 1 m（CLEAR_M）。
// 取樣範圍：巡覽整輪（60 Hz，> SAMPLE_HZ）、減少動態效果整圈、偏好切換內插、進出遊戲 handoff（整輪每 100 幀 × 每個鏡位旁的玩家鏡頭，雙向逐幀）；
//   以上各跑 STALL_VARIANTS 兩個攤車點（巡覽迴圈兩個方向，鏡位輪到的型態不同）。另驗平滑未退化、menu-tour.js LANDMARK_SOLIDS 涵蓋 glb 量體。
// 實體（包圍體）：
//   terrain：高度場（湖面取水面與湖床較高者）——鏡頭四周 CLEAR_M 內的地面
//   osm-building：通用擠出（footprint 地標除外）= 輪廓 × [base, base + 高]，外牆往外 FACADE_OUT（騎樓 / 雨棚 / 陽台），屋頂加 ROOF_EXTRA（女兒牆 / 機房 / 水塔）
//   name-plate：具名建築屋頂名稱牌（同 buildings.js platePlacement 的位置 / 寬高）
//   landmark:<檔名>：public/models manifest 的 glb 三角形（本檔自帶 GLB 解析，不依賴 three）；點到三角形距離 < CLEAR_M，
//     或該點鉛直線上下都有該模型的面（模型內部 / 懸空量體正下方，如捷運站站體）
//   street-clutter：行道樹 / 路燈 / 號誌桿（主要道路中心線 hw + CLUTTER_REACH 內）與公園樹木（公園輪廓 + CLUTTER_REACH 內），頂高 CLUTTER_TOP
// 進出遊戲兩端 HANDOFF_MASK_R 內（玩家鏡頭本身在街面，合法）只檢查建築 / 名稱牌 / 地標，不檢查地形與街道雜物。
// 用法：node tools/test/p8c-tour-clip.mjs [--diag]（--diag 印每類前幾筆位置）；任一斷言失敗 exit 1；最後一行印 PASS n/n 或 FAIL k/n
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIAG = process.argv.includes('--diag');

const cm = await import('../../src/citymodel.js');
const osm = (await import('../../src/data/osm-city.json')).default;
const { NIGHT_MARKET_DELIVERY } = await import('../../src/missions/events.js');
const T = await import('../../src/ui/menu-tour.js');
const geom = await import('../../src/geom.js');

let pass = 0;
let fail = 0;
function check(name, cond, info = '') {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? '  — ' + info : ''}`);
}

// 門檻（寫明數值）
const FPS = 60;
const DT = 1 / FPS;
const CAM_NEAR = 0.3; // main.js PerspectiveCamera near（m）
const CLEAR_M = CAM_NEAR + 1; // 鏡頭離任何實體表面的最小距離（m）
const FACADE_OUT = 1.5; // facade.js 雨棚外伸 CANOPY_OUT（騎樓板 0.7、陽台 1.1 皆較小）（m）
const ROOF_EXTRA = 3; // facade.js 屋頂機房 ROOM_H（女兒牆 ≤ 1.1、水塔 1.8 皆較低）（m）
const PLATE_ASPECT = 512 / 112; // buildings.js 名稱牌寬高比
const CLUTTER_TOP = 7.6; // 街道雜物頂高（m）：行道樹冠 (3.7 + 1.7) × 縮放上限 1.4 ≈ 7.6、路燈 7 m、號誌桿 6.4 m
const CLUTTER_REACH = 3.5; // 雜物離路緣 / 公園邊的水平範圍（m）：樹冠半徑 1.7 × 1.4 + 樹穴 0.85、號誌懸臂 3.6 伸向路內（路內已含）
const HANDOFF_STRIDE = 100; // 進出遊戲掃描：每隔幾幀進一次遊戲
const MAX_STEP_M = 1.6; // 同 p6-m6：巡覽 60 Hz 相鄰幀位移上限、進出遊戲平滑內插相鄰幀高度變化上限（m）
// 攤車鏡位變體：巡覽迴圈兩個方向總長幾乎相同，攤車點差幾公尺就會反轉順序、各鏡位換到別的型態
//   （main.js 實際傳 stallRow 原攤車格，離 NIGHT_MARKET_DELIVERY.pickup 數公尺 → 捷運站輪到 road 低空飛行）；兩個方向都掃
const STALL_VARIANTS = [
  { label: 'pickup', dx: 0 },
  { label: 'pickup+15m', dx: 15 },
];

const terrain = cm.getTerrain();
const depsFor = (v) => ({
  terrain,
  buildings: cm.buildings,
  namedBuildings: cm.namedBuildings,
  roads: cm.surfaceRoads,
  basins: osm.T.basins,
  stall: { x: NIGHT_MARKET_DELIVERY.pickup.x + v.dx, z: NIGHT_MARKET_DELIVERY.pickup.z, source: `NIGHT_MARKET_DELIVERY.pickup ${v.label}` },
});

// ---------- GLB 解析（世界座標三角形） ----------
function glbTriangles(file, ox, oy, oz) {
  const b = readFileSync(file);
  const jl = b.readUInt32LE(12);
  const j = JSON.parse(b.subarray(20, 20 + jl).toString('utf8'));
  const bin = b.subarray(20 + jl + 8);
  const acc = (i) => {
    const a = j.accessors[i];
    const bv = j.bufferViews[a.bufferView];
    const off = (bv.byteOffset || 0) + (a.byteOffset || 0);
    const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
    const size = { 5126: 4, 5125: 4, 5123: 2, 5121: 1 }[a.componentType];
    const stride = bv.byteStride || comps * size;
    const out = new Float64Array(a.count * comps);
    for (let k = 0; k < a.count; k++) {
      for (let c = 0; c < comps; c++) {
        const p = off + k * stride + c * size;
        const ct = a.componentType;
        out[k * comps + c] = ct === 5126 ? bin.readFloatLE(p) : ct === 5125 ? bin.readUInt32LE(p) : ct === 5123 ? bin.readUInt16LE(p) : bin.readUInt8(p);
      }
    }
    return out;
  };
  // 4×4 欄主序
  const mul = (A, B) => {
    const o = new Array(16).fill(0);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[c * 4 + r] += A[k * 4 + r] * B[c * 4 + k];
    return o;
  };
  const local = (n) => {
    if (n.matrix) return n.matrix.slice();
    const [x, y, z, w] = n.rotation || [0, 0, 0, 1];
    const [sx, sy, sz] = n.scale || [1, 1, 1];
    const [tx, ty, tz] = n.translation || [0, 0, 0];
    return [
      (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
      2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
      2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
      tx, ty, tz, 1,
    ];
  };
  const tris = [];
  const walk = (ni, M) => {
    const n = j.nodes[ni];
    const Wm = mul(M, local(n));
    if (n.mesh !== undefined) {
      for (const pr of j.meshes[n.mesh].primitives) {
        if ((pr.mode ?? 4) !== 4) continue;
        const P = acc(pr.attributes.POSITION);
        const I = pr.indices !== undefined ? acc(pr.indices) : Float64Array.from({ length: P.length / 3 }, (_, i) => i);
        const tv = (k, o) => {
          const x = P[k * 3];
          const y = P[k * 3 + 1];
          const z = P[k * 3 + 2];
          o.push(Wm[0] * x + Wm[4] * y + Wm[8] * z + Wm[12] + ox, Wm[1] * x + Wm[5] * y + Wm[9] * z + Wm[13] + oy, Wm[2] * x + Wm[6] * y + Wm[10] * z + Wm[14] + oz);
        };
        for (let t = 0; t + 2 < I.length; t += 3) {
          const o = [];
          tv(I[t], o);
          tv(I[t + 1], o);
          tv(I[t + 2], o);
          tris.push(o);
        }
      }
    }
    for (const c of n.children || []) walk(c, Wm);
  };
  const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const r of j.scenes[j.scene || 0].nodes) walk(r, I4);
  return tris;
}

// 點到三角形最近距離平方（Ericson, Real-Time Collision Detection 5.1.5）
function triDist2(px, py, pz, t) {
  const ax = t[0], ay = t[1], az = t[2], bx = t[3], by = t[4], bz = t[5], cx = t[6], cy = t[7], cz = t[8];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  const q = (x, y, z) => (px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2;
  if (d1 <= 0 && d2 <= 0) return q(ax, ay, az);
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return q(bx, by, bz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return q(ax + abx * v, ay + aby * v, az + abz * v);
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return q(cx, cy, cz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return q(ax + acx * w, ay + acy * w, az + acz * w);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return q(bx + (cx - bx) * w, by + (cy - by) * w, bz + (cz - bz) * w);
  }
  const den = 1 / (va + vb + vc);
  const v = vb * den;
  const w = vc * den;
  return q(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

// 三角形在 (x, z) 的鉛直投影高度（不在投影內 → null）
function triYAt(x, z, t) {
  const ax = t[0], az = t[2], bx = t[3], bz = t[5], cx = t[6], cz = t[8];
  const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  if (Math.abs(det) < 1e-9) return null;
  const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
  const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
  const l3 = 1 - l1 - l2;
  if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) return null;
  return l1 * t[1] + l2 * t[4] + l3 * t[7];
}

// ---------- 地標 glb（同 src/landmarks/index.js 的擺放：錨點投影 + datum 高度） ----------
const manifest = JSON.parse(readFileSync(resolve(ROOT, 'public/models/manifest.json'), 'utf8'));
const DATUM_RE = /原點\s*z\s*=\s*0\s*=\s*([^，。；,;（(]+)/;
function originHeight(e, x, z) {
  const m = DATUM_RE.exec(e.notes || '');
  if (m && m[1].includes('水面')) {
    const lake = terrain.lakes.find((l) => geom.pointInPolygon(x, z, l.poly)) || terrain.lakes[0];
    return lake ? lake.y : osm.T.basins[0].levels.water;
  }
  if (m && m[1].includes('路面')) {
    const basin = (osm.T.basins || []).find((b) => geom.pointInPolygon(x, z, b.p));
    return basin ? basin.levels.road : terrain.heightAt(x, z);
  }
  return terrain.landmarkBase(e.id, x, z);
}
const landmarks = [];
const overridden = new Set();
for (const e of manifest) {
  const x = (e.anchorLon - osm.o.lon) * osm.o.kx;
  const z = -(e.anchorLat - osm.o.lat) * osm.o.kz;
  const y = originHeight(e, x, z);
  const tris = glbTriangles(resolve(ROOT, 'public/models', e.file), x, y, z);
  const grid = new geom.SpatialGrid(8);
  let top = -Infinity;
  for (const t of tris) {
    grid.insert(t, Math.min(t[0], t[3], t[6]), Math.min(t[2], t[5], t[8]), Math.max(t[0], t[3], t[6]), Math.max(t[2], t[5], t[8]));
    top = Math.max(top, t[1], t[4], t[7]);
  }
  landmarks.push({ entry: e, key: `landmark:${e.file.replace(/\.glb$/, '')}`, tris, grid, base: y, top });
  if (e.footprint && Number.isFinite(Number(e.id))) overridden.add(Number(e.id));
}

// ---------- 名稱牌（同 buildings.js platePlacement；footprint 地標不放） ----------
const plates = [];
for (const b of cm.namedBuildings) {
  if (overridden.has(b.id)) continue;
  const p = b.poly;
  const n = p.length / 2;
  let best = 0;
  let bestL = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const L = Math.hypot(p[j * 2] - p[i * 2], p[j * 2 + 1] - p[i * 2 + 1]);
    if (L > bestL) {
      bestL = L;
      best = i;
    }
  }
  const j = (best + 1) % n;
  const tx = (p[j * 2] - p[best * 2]) / bestL;
  const tz = (p[j * 2 + 1] - p[best * 2 + 1]) / bestL;
  const width = Math.max(5, Math.min(36, bestL * 0.6));
  const cx = p[best * 2] + tx * bestL * 0.5 + tz * Math.min(2, width * 0.1);
  const cz = p[best * 2 + 1] + tz * bestL * 0.5 - tx * Math.min(2, width * 0.1);
  const y0 = terrain.buildingBase(b.id) + b.height + 0.6;
  plates.push({ b, ax: cx - tx * width / 2, az: cz - tz * width / 2, bx: cx + tx * width / 2, bz: cz + tz * width / 2, y0, y1: y0 + width / PLATE_ASPECT });
}

// ---------- 碰撞判定 ----------
const bGrid = new geom.SpatialGrid(25);
for (const b of cm.buildings) if (!overridden.has(b.id)) bGrid.insert(b, b.bbox.x0, b.bbox.z0, b.bbox.x1, b.bbox.z1);
// 行道樹 / 路燈（world.js：主要道路）與號誌桿（street.js：含主要道路、寬 ≥ 8 m 道路交會的路口，立在各臂路緣）
const majorRoads = cm.surfaceRoads.filter((r) => cm.MAJOR_TYPES.has(r.type) || (r.type !== 'service' && r.width >= 8));
const rGrid = new geom.SpatialGrid(25);
for (const r of majorRoads) {
  for (let i = 0; i < r.pts.length - 1; i++) {
    const a = r.pts[i];
    const c = r.pts[i + 1];
    rGrid.insert({ r, a, c }, Math.min(a.x, c.x), Math.min(a.z, c.z), Math.max(a.x, c.x), Math.max(a.z, c.z));
  }
}
const parks = osm.P.map((p) => ({ poly: p.p, bbox: geom.polygonBBox(p.p) }));
const sq = {};
const groundAt = (x, z) => {
  const s = terrain.querySurface(x, z, -Infinity, sq);
  return s.waterY !== null && s.waterY !== undefined ? Math.max(s.y, s.waterY) : s.y;
};
const tmpList = [];
const cp = {};
const seg = { x: 0, z: 0, d2: 0, t: 0 };
const REACH = CLEAR_M + FACADE_OUT;
// 回傳穿模類別（無 → null）；mask = 在進出遊戲兩端遮罩區內（只查建築 / 名稱牌 / 地標）
function clipAt(x, y, z, mask = false) {
  if (!mask) {
    let g = groundAt(x, z);
    for (const [ox, oz] of [[CLEAR_M, 0], [-CLEAR_M, 0], [0, CLEAR_M], [0, -CLEAR_M]]) g = Math.max(g, groundAt(x + ox, z + oz));
    if (y - g < CLEAR_M) return 'terrain';
  }
  bGrid.query(x - REACH, z - REACH, x + REACH, z + REACH, tmpList);
  for (const b of tmpList) {
    const base = terrain.buildingBase(b.id);
    const top = base + b.height;
    const inside = geom.pointInPolygon(x, z, b.poly);
    const dh = inside ? 0 : Math.sqrt(geom.closestOnPolygon(x, z, b.poly, cp).d2);
    // 外牆外伸物在屋頂以下；屋頂附屬物在輪廓內
    if (y < top + CLEAR_M && dh < CLEAR_M + (y <= top ? FACADE_OUT : 0)) return 'osm-building';
    if (inside && y < top + ROOF_EXTRA + CLEAR_M) return 'osm-building';
  }
  for (const p of plates) {
    if (y < p.y0 - CLEAR_M || y > p.y1 + CLEAR_M) continue;
    geom.closestOnSegment(x, z, p.ax, p.az, p.bx, p.bz, seg);
    const dv = y < p.y0 ? p.y0 - y : y > p.y1 ? y - p.y1 : 0;
    if (seg.d2 + dv * dv < CLEAR_M * CLEAR_M) return 'name-plate';
  }
  for (const L of landmarks) {
    if (y > L.top + CLEAR_M) continue;
    L.grid.query(x - CLEAR_M, z - CLEAR_M, x + CLEAR_M, z + CLEAR_M, tmpList);
    let above = false;
    let below = false;
    for (const t of tmpList) {
      if (triDist2(x, y, z, t) < CLEAR_M * CLEAR_M) return L.key;
      const ty = triYAt(x, z, t);
      if (ty === null) continue;
      if (ty > y) above = true;
      else below = true;
    }
    if (above && below) return L.key;
  }
  if (!mask) {
    const g = groundAt(x, z);
    if (y - g < CLUTTER_TOP + CLEAR_M) {
      const R = 12 + CLUTTER_REACH;
      rGrid.query(x - R, z - R, x + R, z + R, tmpList);
      for (const s of tmpList) {
        geom.closestOnSegment(x, z, s.a.x, s.a.z, s.c.x, s.c.z, seg);
        if (Math.sqrt(seg.d2) < s.r.hw + CLUTTER_REACH + CLEAR_M) return 'street-clutter';
      }
      for (const p of parks) {
        const m = CLUTTER_REACH + CLEAR_M;
        if (x < p.bbox.x0 - m || x > p.bbox.x1 + m || z < p.bbox.z0 - m || z > p.bbox.z1 + m) continue;
        if (geom.pointInPolygon(x, z, p.poly) || geom.closestOnPolygon(x, z, p.poly, cp).d2 < m * m) return 'street-clutter';
      }
    }
  }
  return null;
}

// 統計：source → category → { n, ex: [...] }
const stats = new Map();
function record(source, cat, info) {
  if (!stats.has(source)) stats.set(source, new Map());
  const m = stats.get(source);
  if (!m.has(cat)) m.set(cat, { n: 0, ex: [] });
  const e = m.get(cat);
  e.n++;
  if (e.ex.length < 4) e.ex.push(info);
}
const segAt = (path, t) => {
  const s = path.segments.find((g) => t >= g.t0 && t < g.t1) || path.segments[path.segments.length - 1];
  return `${s.type} ${s.name}`;
};

// ---------- 巡覽 / 減少動態效果：整輪 60 Hz ----------
const maxStep = {}; // source → 相鄰幀最大位移（handoff 為平滑內插的高度變化）
function scanPath(path, source, vlabel) {
  const p = {};
  const l = {};
  const n = Math.ceil(path.duration / DT);
  let frames = 0;
  let px = NaN;
  let py = NaN;
  let pz = NaN;
  for (let i = 0; i <= n; i++) {
    const t = i * DT;
    T.samplePathAt(path, t, p, l);
    frames++;
    if (i > 0) maxStep[source] = Math.max(maxStep[source] || 0, Math.hypot(p.x - px, p.y - py, p.z - pz));
    px = p.x;
    py = p.y;
    pz = p.z;
    const c = clipAt(p.x, p.y, p.z);
    if (c) record(source, c, `${vlabel} t=${t.toFixed(2)} ${segAt(path, Math.min(t, path.duration - 1e-9))} (${p.x.toFixed(0)}, ${p.y.toFixed(1)}, ${p.z.toFixed(0)})`);
  }
  return frames;
}

// ---------- 進出遊戲 handoff ----------
function mockCamera() {
  return {
    position: { x: 0, y: 50, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    quaternion: { x: 0, y: 0, z: 0, w: 1, set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; } },
  };
}
const groundY = (x, z) => terrain.querySurface(x, z, -Infinity, sq).y;
function nearRoadPose(stop) {
  let best = null;
  for (const r of cm.surfaceRoads) {
    for (const pt of r.pts) {
      if (cm.buildingAt(pt.x, pt.z, 0) || !cm.onRoadSurface(pt.x, pt.z, 0, false)) continue;
      const d = Math.hypot(pt.x - stop.x, pt.z - stop.z);
      if (!best || d < best.d) best = { x: pt.x, z: pt.z, d };
    }
  }
  const y = groundY(best.x, best.z) + 2.6;
  return { x: best.x, y, z: best.z, q: T.lookQuat(best.x, y, best.z, stop.x, y - 1, stop.z, {}) };
}
let tourFrames = 0;
let slowFrames = 0;
let handFrames = 0;
let handCycles = 0;
let prefFrames = 0;
const shotTypes = [];
let lastTour = null;
for (const variant of STALL_VARIANTS) {
  const deps = depsFor(variant);
  const tour = T.buildTour(deps);
  const slow = T.buildReducedTour(deps);
  lastTour = tour;
  shotTypes.push(tour.segments.filter((g) => g.type !== 'glide').map((g) => `${g.key}:${g.type}`));
  console.log(`  變體 ${variant.label}：${shotTypes[shotTypes.length - 1].join(' ')}`);
  tourFrames += scanPath(tour, 'tour', variant.label);
  slowFrames += scanPath(slow, 'reduced', variant.label);
  {
    const cam = mockCamera();
    const mt = T.createMenuTour({ ...deps, camera: cam, fade: () => {} });
    mt.update(DT);
    let prevY = NaN;
    const scan = (source, from, to, label, n) => {
      const x = cam.position.x;
      const y = cam.position.y;
      const z = cam.position.z;
      handFrames++;
      if (n > 0 && !mt.fading) maxStep[source] = Math.max(maxStep[source] || 0, Math.abs(y - prevY));
      prevY = y;
      const mask = Math.hypot(x - from.x, z - from.z) <= T.HANDOFF_MASK_R || Math.hypot(x - to.x, z - to.z) <= T.HANDOFF_MASK_R;
      const c = clipAt(x, y, z, mask);
      if (c) record(source, c, `${label} (${x.toFixed(0)}, ${y.toFixed(1)}, ${z.toFixed(0)})${mask ? ' [遮罩區]' : ''}`);
    };
    for (const stop of tour.stops) {
      const rig = nearRoadPose(stop);
      const rigWrite = () => {
        cam.position.set(rig.x, rig.y, rig.z);
        cam.quaternion.set(rig.q.x, rig.q.y, rig.q.z, rig.q.w);
      };
      let span = 0;
      while (span < mt.path.duration) {
        for (let i = 0; i < HANDOFF_STRIDE; i++) mt.update(DT);
        span += HANDOFF_STRIDE * DT;
        const tAt = mt.time;
        const from = { x: cam.position.x, z: cam.position.z };
        const label = `${variant.label} t=${tAt.toFixed(1)} ${segAt(mt.path, tAt)} ⇄ ${stop.key}`;
        mt.stop();
        for (let n = 0; n < 600; n++) {
          rigWrite();
          const still = mt.handoff(DT);
          scan('handoff-out', from, rig, label, n);
          if (!still) break;
        }
        rigWrite();
        mt.start();
        const p = {};
        const l = {};
        for (let n = 0; n < 600; n++) {
          mt.update(DT);
          T.samplePathAt(mt.path, mt.time, p, l);
          scan('handoff-in', rig, p, label, n);
          if (!mt.blending) break;
        }
        handCycles++;
      }
    }
  }
  // 減少動態效果偏好切換（雙向）的內插逐幀檢查
  {
    let pref = false;
    const cam = mockCamera();
    const mt = T.createMenuTour({ ...deps, camera: cam, reducedMotion: () => pref });
    for (const step of [137, 611, 1999, 4321, 777, 2500]) {
      for (let i = 0; i < step; i++) mt.update(DT);
      pref = !pref;
      for (let n = 0; n < 600; n++) {
        mt.update(DT);
        prefFrames++;
        const c = clipAt(cam.position.x, cam.position.y, cam.position.z);
        if (c) record('pref-blend', c, `${mt.mode} (${cam.position.x.toFixed(0)}, ${cam.position.y.toFixed(1)}, ${cam.position.z.toFixed(0)})`);
        if (!mt.blending) break;
      }
    }
  }
}

// ---------- 結果 ----------
console.log(`  取樣：巡覽 ${tourFrames} 幀、減少動態效果 ${slowFrames} 幀、進出遊戲 ${handCycles} 輪 ${handFrames} 幀、偏好切換 ${prefFrames} 幀`);
console.log(`  實體：OSM 建築 ${cm.buildings.length - overridden.size}、名稱牌 ${plates.length}、地標 glb ${landmarks.length}（${landmarks.reduce((a, L) => a + L.tris.length, 0)} 三角形）、主要道路 ${majorRoads.length}、公園 ${parks.length}`);
const totals = new Map();
for (const [source, m] of stats) {
  for (const [cat, e] of m) {
    totals.set(cat, (totals.get(cat) || 0) + e.n);
    console.log(`  穿模 ${source} / ${cat}：${e.n} 幀`);
    if (DIAG) for (const s of e.ex) console.log(`      ${s}`);
  }
}
const sources = ['tour', 'reduced', 'handoff-out', 'handoff-in', 'pref-blend'];
for (const s of sources) {
  const m = stats.get(s);
  const n = m ? [...m.values()].reduce((a, e) => a + e.n, 0) : 0;
  check(`${s}：鏡頭全程不在實體內、離表面 ≥ ${CLEAR_M} m（近平面 ${CAM_NEAR} + 1 m）`, n === 0, m ? [...m].map(([c, e]) => `${c} ${e.n}`).join(' / ') : '0 幀');
}
check('取樣頻率 ≥ SAMPLE_HZ', FPS >= T.SAMPLE_HZ);
check(`平滑不變：巡覽 / 減少動態效果相鄰幀位移、進出遊戲平滑內插相鄰幀高度變化 ≤ ${MAX_STEP_M} m（兩個攤車變體）`,
  ['tour', 'reduced', 'handoff-out', 'handoff-in'].every((k) => maxStep[k] <= MAX_STEP_M), Object.entries(maxStep).map(([k, v]) => `${k} ${v.toFixed(3)} m`).join(' / '));
check('地標 glb 全數載入（manifest 每筆都有三角形）', landmarks.length === manifest.length && landmarks.every((L) => L.tris.length > 0));
check('攤車變體涵蓋巡覽兩個方向、捷運站輪到 road 低空飛行', new Set(shotTypes.map((a) => a.join())).size === STALL_VARIANTS.length && shotTypes.some((a) => a.includes('mrt:road')), shotTypes.map((a) => a.join(' ')).join(' | '));
// menu-tour.js LANDMARK_SOLIDS 涵蓋 glb 實際量體：footprint 地標離地 > 2.5 m 的每個表面取樣點（三角形細分），都落在某一層 [pad, 頂高] 內
{
  const bad = [];
  for (const L of landmarks) {
    const id = Number(L.entry.id);
    if (!overridden.has(id)) continue;
    const tiers = T.LANDMARK_SOLIDS[id];
    const b = cm.buildingById(id);
    if (!tiers || !b) {
      bad.push(`${L.entry.name} 缺表`);
      continue;
    }
    let worst = 0;
    let worstD = 0;
    const probe = (x, y, z) => {
      const h = y - L.base;
      if (h <= 2.5) return;
      const d = geom.pointInPolygon(x, z, b.poly) ? 0 : Math.sqrt(geom.closestOnPolygon(x, z, b.poly, cp).d2);
      if (!tiers.some(([pad, top]) => d <= pad + 0.01 && h <= top) && h > worst) { worst = h; worstD = d; }
    };
    // 三角形以重心座標細分取樣（約每 2 m 一點，上限 40 段）：跨過凹形輪廓的三角形內部點也要涵蓋，只驗頂點會漏判
    for (const t of L.tris) {
      const e = (a, c) => Math.hypot(t[c] - t[a], t[c + 1] - t[a + 1], t[c + 2] - t[a + 2]);
      const S = Math.min(40, Math.max(1, Math.ceil(Math.max(e(0, 3), e(3, 6), e(0, 6)) / 2)));
      for (let i = 0; i <= S; i++) {
        for (let j = 0; i + j <= S; j++) {
          const u = i / S;
          const v = j / S;
          probe(t[0] + (t[3] - t[0]) * u + (t[6] - t[0]) * v, t[1] + (t[4] - t[1]) * u + (t[7] - t[1]) * v, t[2] + (t[5] - t[2]) * u + (t[8] - t[2]) * v);
        }
      }
    }
    if (worst > 0) bad.push(`${L.entry.name} 有表面超出（高 ${worst.toFixed(1)} m、離輪廓 ${worstD.toFixed(2)} m）`);
  }
  check('LANDMARK_SOLIDS 涵蓋每個 footprint 地標 glb 的量體', bad.length === 0, bad.join(' / '));
}
const summary = [...totals].map(([c, n]) => `${c} ${n}`).join(' / ') || '0';
console.log(`  合計穿模：${summary}`);
console.log(`${fail === 0 ? 'PASS' : 'FAIL'} ${fail === 0 ? pass : fail}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
