// 樓宇細節產生器（去方塊感）：疊加在 buildings.js 的 OSM 輪廓擠出方塊上，
//   女兒牆（沿輪廓，凹多邊形正確）、高樓屋頂退台量體 + 機房 / 水塔、中低層住商首層騎樓、
//   高樓挑高雨棚、住宅陽台板 + 欄杆帶。
// 固定種子（seed 與建築 id 混合）：同一棟每次載入相同；共用材質、同類細節合併成單一 BufferGeometry，draw call 數固定。
// 只疊加、不修改原牆：騎樓以「牆外柱列 + 首層店面帶 + 上方樓板外挑」表現（首層不內縮：碰撞沿用 OSM 輪廓，內縮會出現看得到卻走不進的空間）。
// 首層店面帶：柱與柱之間各貼一格店面（深灰框 + 玻璃 + 招牌帶，白天有輕微明暗、夜間微亮店面光），
//   與退台量體共用同一張窗格貼圖 / 材質（寫進 setbacks 群組，不新增 draw call）：退台牆只用貼圖最下兩列（v ≤ 0.25），
//   店面格畫在最上一列（v 0.875–1），兩者互不取樣。
// 高樓屋頂退台採「真實性優先」：總高維持 OSM 高度——主體降 tierH、退台量體補在主體頂到 OSM 高度之間；
//   回傳 bodies（id → 主體高度），buildings.js 依此擠出主體（colliders 仍用 OSM 高度，退台頂 = OSM 頂）。
// 高度基準一律取 terrain.buildingBase(id)（平地 = 0）；各尺寸比例依 reference §3–§5 的七期街景調性，數字皆為推測預設值。
import * as THREE from 'three';
import { signedArea, polygonArea, polygonCentroid, pointInPolygon, closestOnPolygon, triangulate } from './geom.js';
import { makeCanvas, mulberry32, clamp, randRange } from './utils.js';
import { registerNight } from './daynight.js';
import { DetailWriter, RoadIndex, BuildingIndex, geometryStats } from './street.js';

// 測試 / 除錯用開關（false 時回傳空群組）
export const ENABLE_FACADE = true;

// 不做細節的建築類型（施工中、雨棚 / 頂蓋、橋）
const SKIP_TYPES = new Set(['construction', 'roof', 'bridge']);
// 首層騎樓：中低層住商（臺灣街屋常見形式；OSM 未標騎樓，屬推測）
const ARCADE_TYPES = new Set(['apartments', 'residential', 'house', 'commercial', 'retail', 'yes']);
const BALCONY_TYPES = new Set(['apartments', 'residential']);
const OFFICE_TYPES = new Set(['office', 'government']);
const COMMERCIAL_TYPES = new Set(['commercial', 'retail', 'supermarket', 'public']);

const MIN_AREA = 15; // 小於此面積（m²）的附屬建物不加細節
const FLOOR_H = 3.3; // 每層高（與 buildings.js / build-city 的住宅 / 辦公規則一致）
const FLOOR_H_COMMERCIAL = 4.5;

// 女兒牆（推測：一般 RC 女兒牆高 0.6–1.1 m、厚 0.25 m）
const PARAPET_H_MIN = 0.6;
const PARAPET_H_MAX = 1.1;
const PARAPET_T = 0.25;
const PARAPET_MITER = 3; // 銳角處斜接長度上限（× 厚度）

// 屋頂退台 + 機房 / 水塔（高度門檻依規格；退台層數與尺寸推測）
const TOWER_H = 30;
const SETBACK_MIN = 1.5;
const SETBACK_MAX = 4;
const SETBACK_MITER = 2.5;
const SETBACK_MIN_AREA = 60;
const ROOM_RATIO = 0.09; // 機房佔頂面比例（上限 15% 內）
const ROOF_UNIT_MAX = 0.15;
const ROOM_H = 3;
const ROOM_MARGIN = 1; // 機房離屋頂邊緣至少
const TANK_H = 1.8;
const TANK_SIDES = 8;

// 騎樓 / 雨棚（臨路判定依規格：邊中點到最近路面 < 15 m）
const ROAD_NEAR = 15;
const FACING_DOT = 0.5; // 邊外法線與「往道路方向」夾角餘弦下限
const MIN_EDGE = 6;
const COL_SPACING_MIN = 4;
const COL_SPACING_MAX = 6;
const COL_SIZE = 0.5;
const COL_END_INSET = 0.35;
const ARCADE_H_MIN = 3.6;
const ARCADE_H_MAX = 4.5;
const ARCADE_SLAB_OUT = 0.7;
const ARCADE_SLAB_T = 0.3;
const BAND_OFFSET = 0.03; // 首層店面帶離牆距離（避免與原牆 z-fighting）
const CANOPY_Y = 5.5; // 高樓挑高雨棚高度（推測）
const CANOPY_OUT = 1.5;
const CANOPY_T = 0.2;
const CANOPY_END_INSET = 0.5;

// 陽台（reference §3：七期豪宅大面陽台水平分割；數量刻意少）
const BALCONY_DEPTH = 1.1;
const BALCONY_SLAB_T = 0.15;
const RAIL_H = 1.0;
const BALCONY_MIN_W = 2.5;
const BALCONY_MAX_W = 7;
const BALCONY_PAIR_EDGE = 28; // 邊長 ≥ 此值時一層放兩座
const BALCONY_MAX = 20; // 每棟上限
const SHOP_SEED = 0x5a0f7e11; // 店面格挑選亂數的種子混合值

const COLORS = {
  parapet: new THREE.Color(0xcfccc5),
  room: new THREE.Color(0xbdbab3),
  tank: new THREE.Color(0xd8d8d4),
  band: new THREE.Color(0xe0e0e0), // 店面帶乘在貼圖店面格上（深灰框 / 玻璃的明暗由貼圖提供）
  column: new THREE.Color(0xe4e2dd),
  slab: new THREE.Color(0xd3d0ca),
  canopy: new THREE.Color(0x8e959b),
  rail: new THREE.Color(0x5d6770),
};
// 退台量體外牆色：七期米色石材豪宅 / 深色玻璃商辦（reference §5 近似色）
const TIER_TINTS = {
  residential: ['#cdbfa6', '#d9d4ca', '#c9bfae'],
  office: ['#6f8fa0', '#3e4a5c', '#7a8a96'],
  commercial: ['#b8bcc0', '#c9c6c0'],
  generic: ['#c2beb8', '#cdc8bf'],
};
// 退台窗格貼圖：一張 = 8 開間 × 8 層（與 buildings.js 相同慣例），左上角保留純牆格
const TIER_BAY = 3.6;
const SOLID_UV = [0.06, 0.06];
// 店面格：貼圖最上一列（canvas 第 0 列）的 8 格；V 範圍內縮半個像素，避免與相鄰列 / 包裹邊雙線性混色
const TEX_SIZE = 256;
const SHOP_ROW_V0 = 7 / 8 + 0.5 / TEX_SIZE;
const SHOP_ROW_V1 = 1 - 0.5 / TEX_SIZE;
const SHOP_FRAME_U = 1.5 / TEX_SIZE; // 店面格左框中央（柱列兩端的短段取此處的框色）
const UP = [0, 1, 0];

function heightOf(b) {
  return Number.isFinite(b.height) ? b.height : b.h;
}

function tintKey(type) {
  if (BALCONY_TYPES.has(type) || type === 'hotel' || type === 'house') return 'residential';
  if (OFFICE_TYPES.has(type)) return 'office';
  if (COMMERCIAL_TYPES.has(type)) return 'commercial';
  return 'generic';
}

// ---------- 多邊形工具（x, z 扁平陣列） ----------
// 去除重複點與共線點，並統一為 OSM 慣例方向（有號面積 < 0，邊 a→b 的外法線 = (-ez, ex)）
function cleanPolygon(p) {
  let pts = [];
  for (let i = 0; i < p.length; i += 2) pts.push([p[i], p[i + 1]]);
  pts = pts.filter((q, i) => {
    const r = pts[(i + 1) % pts.length];
    return Math.hypot(q[0] - r[0], q[1] - r[1]) > 0.05;
  });
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length];
      const b = pts[i];
      const c = pts[(i + 1) % pts.length];
      const cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      const L = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
      if (Math.abs(cr) / L < 0.02) {
        pts.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  if (pts.length < 3) return null;
  const flat = pts.flat();
  if (signedArea(flat) > 0) {
    const rev = [];
    for (let i = pts.length - 1; i >= 0; i--) rev.push(pts[i][0], pts[i][1]);
    return rev;
  }
  return flat;
}

// 各邊：起點、單位方向、外法線、長度
function edgesOf(p) {
  const n = p.length / 2;
  const out = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = p[i * 2];
    const az = p[i * 2 + 1];
    const ex = p[j * 2] - ax;
    const ez = p[j * 2 + 1] - az;
    const L = Math.hypot(ex, ez);
    out.push({ ax, az, bx: p[j * 2], bz: p[j * 2 + 1], tx: ex / L, tz: ez / L, nx: -ez / L, nz: ex / L, L });
  }
  return out;
}

// 向內平移 d（斜接）；clampMiter = true 時銳角斜接長度截斷，否則超限回傳 null
function offsetInward(p, d, maxMiter, clampMiter) {
  const E = edgesOf(p);
  const n = E.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const e1 = E[(i + n - 1) % n];
    const e2 = E[i];
    const k = 1 + e1.nx * e2.nx + e1.nz * e2.nz;
    if (k < 1e-3) return null;
    let mx = ((e1.nx + e2.nx) * d) / k;
    let mz = ((e1.nz + e2.nz) * d) / k;
    const m = Math.hypot(mx, mz);
    if (m > maxMiter * d) {
      if (!clampMiter) return null;
      mx *= (maxMiter * d) / m;
      mz *= (maxMiter * d) / m;
    }
    out.push(p[i * 2] - mx, p[i * 2 + 1] - mz);
  }
  return out;
}

function segmentsCross(ax, az, bx, bz, cx, cz, dx, dz) {
  const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

// 內縮結果檢查：方向不變、無邊翻轉、無自交、全在原輪廓內
function validInset(orig, inner) {
  if (!inner || signedArea(inner) >= 0 || polygonArea(inner) < SETBACK_MIN_AREA) return false;
  const E0 = edgesOf(orig);
  const E1 = edgesOf(inner);
  for (let i = 0; i < E0.length; i++) {
    if (!(E1[i].L > 0.3) || E0[i].tx * E1[i].tx + E0[i].tz * E1[i].tz < 0.5) return false;
  }
  const n = E1.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const a = E1[i];
      const b = E1[j];
      if (segmentsCross(a.ax, a.az, a.bx, a.bz, b.ax, b.az, b.bx, b.bz)) return false;
    }
  }
  for (let i = 0; i < inner.length; i += 2) if (!pointInPolygon(inner[i], inner[i + 1], orig)) return false;
  return true;
}

// 點在多邊形內且離邊界 ≥ m
function insideWithMargin(x, z, p, m) {
  return pointInPolygon(x, z, p) && closestOnPolygon(x, z, p).d2 >= m * m;
}

// ---------- 幾何片段 ----------
// 立面四邊形：沿 (ax, az)→(bx, bz)，y0→y1，法線 (nx, 0, nz)
function wall(w, ax, az, bx, bz, y0, y1, nx, nz, c, uv = null) {
  w.quad([ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az], [nx, 0, nz], c, uv);
}

// 定向方塊：中心 (cx, cz)、長軸 (tx, tz)、半長 hl、半深 hd、y0→y1（不含底面）
function box(w, cx, cz, tx, tz, hl, hd, y0, y1, c) {
  const nx = -tz;
  const nz = tx;
  const P = (s, d) => [cx + tx * s + nx * d, cz + tz * s + nz * d];
  const [a, b, cc, d] = [P(-hl, -hd), P(hl, -hd), P(hl, hd), P(-hl, hd)];
  wall(w, a[0], a[1], b[0], b[1], y0, y1, -nx, -nz, c);
  wall(w, b[0], b[1], cc[0], cc[1], y0, y1, tx, tz, c);
  wall(w, cc[0], cc[1], d[0], d[1], y0, y1, nx, nz, c);
  wall(w, d[0], d[1], a[0], a[1], y0, y1, -tx, -tz, c);
  w.quad([a[0], y1, a[1]], [b[0], y1, b[1]], [cc[0], y1, cc[1]], [d[0], y1, d[1]], UP, c);
}

// 頂面（耳切三角化，凹多邊形正確）
function cap(w, p, y, c, uv = null) {
  const t = triangulate(p);
  for (let k = 0; k < t.length; k += 3) {
    const q = [t[k], t[k + 1], t[k + 2]].map((i) => [p[i * 2], y, p[i * 2 + 1]]);
    w.tri(q[0], q[1], q[2], UP, c, uv);
  }
}

// 女兒牆：外側面貼齊輪廓、內側面向內 PARAPET_T、頂蓋
function parapet(w, p, yTop, ph, c) {
  const inner = offsetInward(p, PARAPET_T, PARAPET_MITER, true);
  if (!inner) return false;
  const E = edgesOf(p);
  const n = E.length;
  const y1 = yTop + ph;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const e = E[i];
    const ia = [inner[i * 2], inner[i * 2 + 1]];
    const ib = [inner[j * 2], inner[j * 2 + 1]];
    wall(w, e.ax, e.az, e.bx, e.bz, yTop, y1, e.nx, e.nz, c);
    wall(w, ia[0], ia[1], ib[0], ib[1], yTop, y1, -e.nx, -e.nz, c);
    w.quad([e.ax, y1, e.az], [e.bx, y1, e.bz], [ib[0], y1, ib[1]], [ia[0], y1, ia[1]], UP, c);
  }
  return true;
}

// 退台量體：外牆帶窗格 UV（公尺計，開間對齊），頂面取純牆格
function tier(w, p, y0, y1, c, floorH, uOff) {
  const texU = TIER_BAY * 8;
  const texV = floorH * 8;
  let run = 0;
  for (const e of edgesOf(p)) {
    const u0 = uOff + Math.round(run / TIER_BAY) / 8;
    const u1 = u0 + e.L / texU;
    const v1 = (y1 - y0) / texV;
    wall(w, e.ax, e.az, e.bx, e.bz, y0, y1, e.nx, e.nz, c, [u0, 0, u1, 0, u1, v1, u0, v1]);
    run += e.L;
  }
  cap(w, p, y1, c, [SOLID_UV[0], SOLID_UV[1], SOLID_UV[0], SOLID_UV[1], SOLID_UV[0], SOLID_UV[1]]);
}

// 屋頂機房（沿最長邊方向的方塊）+ 其上水塔；佔頂面 ≤ ROOF_UNIT_MAX
function roofUnits(w, p, yRoof, rng, stats) {
  const area = polygonArea(p);
  const E = edgesOf(p);
  const e = E.reduce((a, b) => (b.L > a.L ? b : a));
  const side = Math.sqrt(area * ROOM_RATIO);
  const w0 = clamp(side * 1.3, 2.5, 12);
  const d0 = clamp(side / 1.3, 2, 9);
  // 候選中心：重心，再來是面積最大的幾個三角形重心（凹多邊形重心可能落在外面）
  const centers = [polygonCentroid(p)];
  const t = triangulate(p);
  const tris = [];
  for (let k = 0; k < t.length; k += 3) {
    const q = [t[k], t[k + 1], t[k + 2]];
    const tri = q.flatMap((i) => [p[i * 2], p[i * 2 + 1]]);
    tris.push({ a: polygonArea(tri), c: polygonCentroid(tri) });
  }
  tris.sort((a, b) => b.a - a.a);
  for (const tr of tris.slice(0, 3)) centers.push(tr.c);
  for (const s of [1, 0.75, 0.55]) {
    const hl = (w0 * s) / 2;
    const hd = (d0 * s) / 2;
    if (4 * hl * hd > area * ROOF_UNIT_MAX) continue;
    for (const c of centers) {
      const ok = [[-1, -1], [1, -1], [1, 1], [-1, 1]].every(([a, b]) => {
        const x = c.x + e.tx * hl * a + e.nx * hd * b;
        const z = c.z + e.tz * hl * a + e.nz * hd * b;
        return insideWithMargin(x, z, p, ROOM_MARGIN);
      });
      if (!ok) continue;
      const h = ROOM_H * (0.9 + rng() * 0.2);
      box(w, c.x, c.z, e.tx, e.tz, hl, hd, yRoof, yRoof + h, COLORS.room);
      stats.roofUnits++;
      // 水塔：機房頂上的八角柱
      const r = Math.min(1.2, Math.min(hl, hd) * 0.6);
      if (r >= 0.6) {
        const y0 = yRoof + h;
        for (let k = 0; k < TANK_SIDES; k++) {
          const a0 = (k / TANK_SIDES) * Math.PI * 2;
          const a1 = ((k + 1) / TANK_SIDES) * Math.PI * 2;
          const am = (a0 + a1) / 2;
          const p0 = [c.x + Math.cos(a0) * r, c.z + Math.sin(a0) * r];
          const p1 = [c.x + Math.cos(a1) * r, c.z + Math.sin(a1) * r];
          wall(w, p0[0], p0[1], p1[0], p1[1], y0, y0 + TANK_H, Math.cos(am), Math.sin(am), COLORS.tank);
          w.tri([c.x, y0 + TANK_H, c.z], [p0[0], y0 + TANK_H, p0[1]], [p1[0], y0 + TANK_H, p1[1]], UP, COLORS.tank);
        }
        stats.waterTanks++;
      }
      return;
    }
  }
}

// 臨路邊：邊長夠、外側不是鄰棟（共用牆）、外法線朝向 15 m 內的道路
function roadFacingEdges(b, E, ctx) {
  const out = [];
  const near = {};
  for (const e of E) {
    if (e.L < MIN_EDGE) continue;
    const mx = (e.ax + e.bx) / 2;
    const mz = (e.az + e.bz) / 2;
    if (ctx.bldIdx.at(mx + e.nx * 1.2, mz + e.nz * 1.2, 0, b)) continue;
    if (!ctx.roadIdx.nearest(mx, mz, ROAD_NEAR, near)) continue;
    const vx = near.x - mx;
    const vz = near.z - mz;
    const vl = Math.hypot(vx, vz);
    if (vl > 1e-3 && (vx * e.nx + vz * e.nz) / vl < FACING_DOT) continue;
    out.push(e);
  }
  return out;
}

// 外挑物淨空：沿邊 [s0, s1] 外推 depth 的幾個取樣點不可落在任何建築內（含本棟凹角）
function clearOutside(e, s0, s1, depth, ctx) {
  for (const f of [0, 0.5, 1]) {
    const s = s0 + (s1 - s0) * f;
    const x = e.ax + e.tx * s + e.nx * (depth + 0.1);
    const z = e.az + e.tz * s + e.nz * (depth + 0.1);
    if (ctx.bldIdx.at(x, z, 0.1)) return false;
  }
  return true;
}

// 騎樓：首層店面帶（貼牆外，寫進 wShop = 退台共用材質群組）+ 柱列（間距 4–6 m）+ 上方外挑樓板；
// 店面帶依柱位切段，每段一格店面（shopRng 挑 8 種店面格之一），柱列兩端的短段取店面框色
function arcade(w, wShop, e, base, arcH, shopRng) {
  const mx = (e.ax + e.bx) / 2;
  const mz = (e.az + e.bz) / 2;
  const so = ARCADE_SLAB_OUT / 2;
  box(w, mx + e.nx * so, mz + e.nz * so, e.tx, e.tz, e.L / 2, so, base + arcH, base + arcH + ARCADE_SLAB_T, COLORS.slab);
  const span = e.L - COL_END_INSET * 2;
  let m = Math.round(span / 5);
  const lo = Math.ceil(span / COL_SPACING_MAX);
  const hi = Math.floor(span / COL_SPACING_MIN);
  if (lo <= hi) m = clamp(m, lo, hi);
  m = Math.max(1, m);
  const co = BAND_OFFSET + COL_SIZE / 2 + 0.02;
  for (let k = 0; k <= m; k++) {
    const s = COL_END_INSET + (span * k) / m;
    box(w, e.ax + e.tx * s + e.nx * co, e.az + e.tz * s + e.nz * co, e.tx, e.tz, COL_SIZE / 2, COL_SIZE / 2, base, base + arcH, COLORS.column);
  }
  const bx = e.nx * BAND_OFFSET;
  const bz = e.nz * BAND_OFFSET;
  const seg = (s0, s1, uv) => {
    wall(wShop, e.ax + e.tx * s0 + bx, e.az + e.tz * s0 + bz, e.ax + e.tx * s1 + bx, e.az + e.tz * s1 + bz, base, base + arcH, e.nx, e.nz, COLORS.band, uv);
  };
  const frameU = (i) => i / 8 + SHOP_FRAME_U;
  const frame = (i) => {
    const u = frameU(i);
    return [u, SHOP_ROW_V0, u, SHOP_ROW_V0, u, SHOP_ROW_V1, u, SHOP_ROW_V1];
  };
  const first = Math.floor(shopRng() * 8) % 8;
  seg(0, COL_END_INSET, frame(first));
  for (let k = 0; k < m; k++) {
    const i = k === 0 ? first : Math.floor(shopRng() * 8) % 8;
    const u0 = i / 8 + 0.5 / TEX_SIZE;
    const u1 = (i + 1) / 8 - 0.5 / TEX_SIZE;
    seg(COL_END_INSET + (span * k) / m, COL_END_INSET + (span * (k + 1)) / m, [u0, SHOP_ROW_V0, u1, SHOP_ROW_V0, u1, SHOP_ROW_V1, u0, SHOP_ROW_V1]);
  }
  seg(e.L - COL_END_INSET, e.L, frame(first));
  return m + 1;
}

// 高樓挑高雨棚：懸挑 1.5 m 薄板
function canopy(w, e, base) {
  const mx = (e.ax + e.bx) / 2;
  const mz = (e.az + e.bz) / 2;
  const ho = CANOPY_OUT / 2;
  box(w, mx + e.nx * ho, mz + e.nz * ho, e.tx, e.tz, e.L / 2 - CANOPY_END_INSET, ho, base + CANOPY_Y, base + CANOPY_Y + CANOPY_T, COLORS.canopy);
}

// 陽台：樓板 + 三面欄杆帶（雙面）
function balcony(w, e, s, width, y) {
  const cx = e.ax + e.tx * s;
  const cz = e.az + e.tz * s;
  const hd = BALCONY_DEPTH / 2;
  const hw = width / 2;
  box(w, cx + e.nx * hd, cz + e.nz * hd, e.tx, e.tz, hw, hd, y, y + BALCONY_SLAB_T, COLORS.slab);
  const y0 = y + BALCONY_SLAB_T;
  const y1 = y0 + RAIL_H;
  const P = (a, d) => [cx + e.tx * a + e.nx * d, cz + e.tz * a + e.nz * d];
  const fl = P(-hw, BALCONY_DEPTH);
  const fr = P(hw, BALCONY_DEPTH);
  const bl = P(-hw, 0.02);
  const br = P(hw, 0.02);
  for (const sgn of [1, -1]) {
    wall(w, fl[0], fl[1], fr[0], fr[1], y0, y1, e.nx * sgn, e.nz * sgn, COLORS.rail);
    wall(w, bl[0], bl[1], fl[0], fl[1], y0, y1, -e.tx * sgn, -e.tz * sgn, COLORS.rail);
    wall(w, br[0], br[1], fr[0], fr[1], y0, y1, e.tx * sgn, e.tz * sgn, COLORS.rail);
  }
}

// ---------- 貼圖 / 材質 ----------
// 窗格貼圖 8 × 8 格：退台牆取樣最下兩列（第 6、7 列；第 7 列左下角為純牆格），第 0 列畫首層店面格（drawShopCell）
function makeTierTextures(anisotropy, rng) {
  const S = TEX_SIZE;
  const cell = S / 8;
  const wallC = makeCanvas(S, S);
  const wctx = wallC.getContext('2d');
  wctx.fillStyle = '#ffffff';
  wctx.fillRect(0, 0, S, S);
  const litC = makeCanvas(S, S);
  const lctx = litC.getContext('2d');
  lctx.fillStyle = '#000000';
  lctx.fillRect(0, 0, S, S);
  const warm = ['#ffd9a0', '#ffe8c0', '#fff2d8'];
  for (let i = 0; i < 8; i++) drawShopCell(wctx, lctx, i * cell, cell, rng);
  for (let i = 0; i < 8; i++) {
    for (let j = 1; j < 8; j++) {
      if (i === 0 && j === 7) continue; // 純牆格（頂面取樣）
      const x = i * cell + 4;
      const y = j * cell + 6;
      wctx.fillStyle = '#5a6672';
      wctx.fillRect(x, y, cell - 8, cell - 12);
      if (rng() < 0.35) {
        lctx.fillStyle = warm[Math.floor(rng() * warm.length) % warm.length];
        lctx.fillRect(x, y, cell - 8, cell - 12);
      }
    }
  }
  const toTex = (c) => {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = anisotropy;
    return t;
  };
  return { map: toTex(wallC), emissiveMap: toTex(litC) };
}

// 首層店面格（canvas 第 0 列，x0 起 cell 寬）：由下而上 = 踢腳板、玻璃（上亮下暗的反光漸層 + 中央門框）、招牌帶、頂框；
// 顏色是乘上 COLORS.band 前的值：整體深灰、玻璃偏藍灰，白天看得出框與玻璃的明暗。
// 夜間：emissiveMap 在玻璃與招牌處放暗暖色（材質 emissiveIntensity 上限 1.2，約為亮窗的 1/5～1/3 →「微亮店面光」），每格亮度略有差異
function drawShopCell(wctx, lctx, x0, cell, rng) {
  const frameW = 2;
  const kick = 3; // 踢腳板（px，canvas 由上往下畫：店面格底 = 本格 y 最大處）
  const sign = 7; // 招牌帶
  const top = 2; // 頂框（與上方列包裹相鄰，保持淺色以免退台牆底緣混出深線）
  const glassY0 = top + sign;
  const glassY1 = cell - kick;
  wctx.fillStyle = '#6e7276'; // 框
  wctx.fillRect(x0, 0, cell, cell);
  wctx.fillStyle = '#c8c8c6';
  wctx.fillRect(x0, 0, cell, top);
  wctx.fillStyle = ['#7d8186', '#6a7078', '#858078'][Math.floor(rng() * 3) % 3]; // 招牌帶
  wctx.fillRect(x0 + frameW, top, cell - frameW * 2, sign - 1);
  wctx.fillStyle = '#505356'; // 踢腳板
  wctx.fillRect(x0, glassY1, cell, kick);
  // 玻璃反光：上亮下暗分 4 段（不用 createLinearGradient，node 測試的 canvas 替身只有 fillRect）
  const glassH = glassY1 - glassY0;
  const shades = ['#5e6a76', '#4e5964', '#414b56', '#343c46'];
  shades.forEach((c, k) => {
    wctx.fillStyle = c;
    const y = glassY0 + Math.round((glassH * k) / shades.length);
    wctx.fillRect(x0 + frameW, y, cell - frameW * 2, glassY0 + Math.round((glassH * (k + 1)) / shades.length) - y);
  });
  wctx.fillStyle = '#6e7276'; // 中央門框
  wctx.fillRect(x0 + cell / 2 - 0.5, glassY0, 1, glassY1 - glassY0);
  lctx.fillStyle = ['#3a3024', '#5e4c34', '#7a6444', '#8c7450'][Math.floor(rng() * 4) % 4];
  lctx.fillRect(x0 + frameW, glassY0, cell - frameW * 2, glassY1 - glassY0);
  lctx.fillStyle = '#6a5a40';
  lctx.fillRect(x0 + frameW, top, cell - frameW * 2, sign - 1);
}

function defaultMaterials(anisotropy, seed) {
  const tex = makeTierTextures(anisotropy, mulberry32(seed ^ 0x5eedf00d));
  const setback = new THREE.MeshStandardMaterial({
    vertexColors: true, map: tex.map, emissiveMap: tex.emissiveMap, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.75, metalness: 0.08,
  });
  registerNight(setback, 1.2);
  const solid = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.04 });
  return { setback, solid };
}

// ---------- 對外入口 ----------
// buildingList：citymodel.buildings（id、poly、height / h、type、levels、name…）
// terrain：{ buildingBase(id), heightAt, querySurface }（本檔只用 buildingBase）
// landmarks：Map<wayId, …>，其中的建築一律跳過（由 glb 地標提供外觀）
// roads：citymodel.surfaceRoads（騎樓 / 雨棚的臨路判定；未提供則不做騎樓與雨棚）
// sharedMaterials：{ setback?, solid? } 可覆寫預設共用材質
// 回傳 { group, stats, bodies（有退台者 id → { height, tierH, inset }：主體擠出高度 = height，總高仍 = OSM 高度） }
export function buildFacadeDetails(buildingList, {
  terrain, seed = 1, anisotropy = 4, landmarks = new Map(), sharedMaterials = {}, roads = [], enabled = ENABLE_FACADE,
} = {}) {
  const group = new THREE.Group();
  group.name = 'facade-details';
  const stats = {
    enabled, parapets: 0, setbacks: 0, setbackSkipped: 0, roofUnits: 0, waterTanks: 0,
    arcadeBuildings: 0, arcadeEdges: 0, arcadeColumns: 0, canopyBuildings: 0, canopyEdges: 0, balconies: 0,
  };
  if (!enabled) return { group, stats: { ...stats, ...geometryStats(group) }, bodies: new Map() };

  const W = {
    parapets: new DetailWriter(),
    setbacks: new DetailWriter(), // 退台量體 + 首層店面帶（共用窗格貼圖材質）
    roofUnits: new DetailWriter(),
    arcades: new DetailWriter(),
    canopies: new DetailWriter(),
    balconies: new DetailWriter(),
  };
  const ctx = {
    roadIdx: new RoadIndex(roads.filter((r) => !r.under && !r.foot && r.type !== 'service')),
    bldIdx: new BuildingIndex(buildingList),
  };
  const parapetSpans = []; // 女兒牆頂點區段（驗證用：{ id, top（主體頂）, start, end }）
  const bodies = new Map(); // 有退台的建築：id → { height（主體高，自底部起算）, tierH, inset }
  const tint = new THREE.Color();

  for (const b of buildingList) {
    if (landmarks.has(b.id) || SKIP_TYPES.has(b.type)) continue;
    const h = heightOf(b);
    if (!(h > 0)) continue;
    const p = cleanPolygon(b.poly);
    if (!p || polygonArea(p) < MIN_AREA) continue;
    const rng = mulberry32((Math.imul(seed >>> 0, 2654435761) ^ b.id) >>> 0);
    const base = terrain.buildingBase(b.id);
    const top = base + h;
    const floorH = COMMERCIAL_TYPES.has(b.type) ? FLOOR_H_COMMERCIAL : FLOOR_H;
    const E = edgesOf(p);

    // 女兒牆（主體頂；有退台時主體頂 = OSM 頂 − tierH）
    const start = W.parapets.pos.length / 3;
    const ph = randRange(rng, PARAPET_H_MIN, PARAPET_H_MAX);
    let bodyTop = top;

    // 高樓：退台 + 機房 / 水塔
    if (h >= TOWER_H) {
      const inset = randRange(rng, SETBACK_MIN, SETBACK_MAX);
      const inner = offsetInward(p, inset, SETBACK_MITER, false);
      let roofPoly = p;
      if (validInset(p, inner)) {
        const tierH = floorH * (rng() < 0.5 ? 1 : 2);
        const list = TIER_TINTS[tintKey(b.type)];
        tint.set(list[Math.floor(rng() * list.length) % list.length]);
        bodyTop = top - tierH;
        tier(W.setbacks, inner, bodyTop, top, tint, floorH, Math.floor(rng() * 8) / 8);
        parapet(W.parapets, inner, top, PARAPET_H_MIN, COLORS.parapet);
        roofPoly = inner;
        bodies.set(b.id, { height: h - tierH, tierH, inset });
        stats.setbacks++;
      } else {
        stats.setbackSkipped++;
      }
      roofUnits(W.roofUnits, roofPoly, top, rng, stats);
    }
    if (parapet(W.parapets, p, bodyTop, ph, COLORS.parapet)) stats.parapets++;
    parapetSpans.push({ id: b.id, top: bodyTop, start, end: W.parapets.pos.length / 3 });

    // 首層：中低層住商騎樓 / 高樓雨棚（只在臨路邊）
    const tower = h >= TOWER_H;
    const out = tower ? CANOPY_OUT : ARCADE_SLAB_OUT;
    const facing = roadFacingEdges(b, E, ctx).filter((e) => clearOutside(e, 0, e.L, out, ctx));
    if (facing.length) {
      if (tower) {
        for (const e of facing) canopy(W.canopies, e, base);
        stats.canopyBuildings++;
        stats.canopyEdges += facing.length;
      } else if (ARCADE_TYPES.has(b.type) && h >= ARCADE_H_MIN * 1.6) {
        const arcH = Math.min(clamp(floorH * 1.2, ARCADE_H_MIN, ARCADE_H_MAX), h * 0.5);
        const shopRng = mulberry32((b.id ^ SHOP_SEED) >>> 0); // 獨立亂數：不影響後續陽台等配置
        for (const e of facing) stats.arcadeColumns += arcade(W.arcades, W.setbacks, e, base, arcH, shopRng);
        stats.arcadeBuildings++;
        stats.arcadeEdges += facing.length;
      }
    }

    // 住宅陽台：長邊每 2–3 層一座（或兩座），不放在鄰棟共用牆
    if (BALCONY_TYPES.has(b.type)) {
      const floors = b.levels > 0 ? b.levels : Math.round(h / FLOOR_H);
      const maxL = Math.max(...E.map((e) => e.L));
      const longEdges = E.filter((e) => e.L >= Math.max(MIN_EDGE + 2, maxL * 0.7))
        .filter((e) => !ctx.bldIdx.at((e.ax + e.bx) / 2 + e.nx * 1.5, (e.az + e.bz) / 2 + e.nz * 1.5, 0, b))
        .sort((a, c) => c.L - a.L)
        .slice(0, 2);
      const step = rng() < 0.5 ? 2 : 3;
      let count = 0;
      for (let f = 2; f <= floors - 1 && count < BALCONY_MAX; f += step) {
        const y = base + f * FLOOR_H;
        if (y + BALCONY_SLAB_T + RAIL_H > bodyTop - 0.5) break;
        for (const e of longEdges) {
          const pair = e.L >= BALCONY_PAIR_EDGE;
          const width = clamp(e.L * (pair ? 0.28 : 0.35), BALCONY_MIN_W, BALCONY_MAX_W);
          for (const fr of pair ? [0.27, 0.73] : [0.5]) {
            if (count >= BALCONY_MAX) break;
            const c = e.L * fr;
            if (!clearOutside(e, c - width / 2, c + width / 2, BALCONY_DEPTH, ctx)) continue;
            balcony(W.balconies, e, c, width, y);
            count++;
          }
        }
      }
      stats.balconies += count;
    }
  }

  const mats = { ...defaultMaterials(anisotropy, seed >>> 0), ...sharedMaterials };
  for (const [key, w] of Object.entries(W)) {
    if (w.empty) continue;
    const mesh = new THREE.Mesh(w.toGeometry(), key === 'setbacks' ? mats.setback : mats.solid);
    mesh.name = `facade-${key}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (key === 'parapets') mesh.geometry.userData.spans = parapetSpans;
    group.add(mesh);
  }
  return { group, stats: { ...stats, ...geometryStats(group) }, bodies };
}
