#!/usr/bin/env node
// OSM → 遊戲城市資料轉檔工具（純 Node，無相依套件）
// 讀 data/osm/qiqi-raw.json（Overpass API「out tags geom」輸出）→ 寫 src/data/osm-city.json
//
// 投影：以老虎城（way 150999799）輪廓中心為原點的等距圓柱近似，單位公尺，1:1 不壓縮。
//   x = (lon - lon0) * cos(lat0) * M，z = -(lat - lat0) * M（x 向東、z 向南，北方為 -z）
// 多邊形方向：統一為「由上往下看、北方朝上」時的逆時針（以 (x, 北=-z) 計算的有號面積 > 0）。
//
// 輸出鍵名（精簡）：
//   v 版本、src 資料來源、o 投影 {lat, lon, kx, kz}（x = (lon - o.lon) * o.kx、z = -(lat - o.lat) * o.kz，執行期擺放 glb 用）、bounds {x0, z0, x1, z1}（bbox 投影後的矩形）
//   B 建築：i id、n name、e name:en、t building 類型、l levels、h 高度（m）、s 1 = 高度為估算、p 輪廓 [x0, z0, x1, z1, …]
//   R 車道路 / F 步道類：i id、n name、t highway 類型、w 寬度（m）、ln lanes、o oneway（1 / -1）、
//     br 1 = bridge、tu 1 = tunnel、ly layer、u 1 = 地下（tunnel 或 layer<0，不畫在地面）、p 折線 [x0, z0, …]
//   P 公園 / W 水域：i id、n name、p 輪廓
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'data/osm/qiqi-raw.json');
const OUT = resolve(ROOT, 'src/data/osm-city.json');

// 資料擷取範圍（與 Overpass 查詢的 bbox 相同）
const BBOX = { south: 24.1575, west: 120.631, north: 24.1705, east: 120.647 };
const ORIGIN_WAY = 150999799; // 老虎城購物中心
const M_PER_DEG = 111320; // 每度緯度的公尺數（球體近似）
const CLIP_MARGIN = 60; // 道路裁切時保留到邊界外多少公尺

// 每層樓高：住宅 / 辦公 3.3m、零售 / 商業 / 公共 4.5m
const TALL_FLOOR_TYPES = new Set(['retail', 'commercial', 'public', 'supermarket']);
const floorHeight = (type) => (TALL_FLOOR_TYPES.has(type) ? 4.5 : 3.3);

// 沒有 levels 也沒有 height 時的保守預設樓層數（用 id 做種子在 ±15% 內變化）
const DEFAULT_LEVELS = {
  apartments: 8, residential: 5, house: 3, hotel: 6, dormitory: 5,
  office: 6, commercial: 3, retail: 2, supermarket: 2, public: 3, government: 4,
  industrial: 2, parking: 3, temple: 2, church: 2, roof: 1, construction: 1, yes: 3,
};

// 道路預設寬度（沒有 width、也沒有 lanes 時）
const DEFAULT_WIDTH = {
  trunk: 24, primary: 24, secondary: 16, tertiary: 12,
  trunk_link: 8, primary_link: 8, secondary_link: 8, tertiary_link: 8,
  residential: 8, unclassified: 8, living_street: 6, service: 5,
  footway: 2.5, path: 2.5, pedestrian: 2.5, cycleway: 2.5, steps: 2.5,
};
const FOOT_TYPES = new Set(['footway', 'path', 'pedestrian', 'cycleway', 'steps', 'track', 'bridleway', 'corridor']);
const LANE_WIDTH = 3.2;

const raw = JSON.parse(readFileSync(SRC, 'utf8'));
const elements = raw.elements || [];

// ---------- 投影 ----------
const originEl = elements.find((e) => e.type === 'way' && e.id === ORIGIN_WAY);
if (!originEl || !originEl.geometry) throw new Error(`找不到原點建築 way ${ORIGIN_WAY}`);
const originPts = dedupeRing(originEl.geometry.map((g) => [g.lon, g.lat]));
let lat0 = 0;
let lon0 = 0;
for (const [lon, lat] of originPts) {
  lat0 += lat;
  lon0 += lon;
}
lat0 /= originPts.length;
lon0 /= originPts.length;
const KX = Math.cos((lat0 * Math.PI) / 180) * M_PER_DEG;
const r1 = (v) => Math.round(v * 10) / 10;
const projX = (lon) => (lon - lon0) * KX;
const projZ = (lat) => -(lat - lat0) * M_PER_DEG;

// 原點改用投影後輪廓的面積重心（比頂點平均更貼近「輪廓中心」）
{
  const ring = originPts.map(([lon, lat]) => [projX(lon), projZ(lat)]);
  const c = centroid(ring);
  lon0 += c[0] / KX;
  lat0 -= c[1] / M_PER_DEG;
}

const bounds = {
  x0: r1(projX(BBOX.west)),
  z0: r1(projZ(BBOX.north)),
  x1: r1(projX(BBOX.east)),
  z1: r1(projZ(BBOX.south)),
};

function inBounds(x, z, margin = 0) {
  return x >= bounds.x0 - margin && x <= bounds.x1 + margin && z >= bounds.z0 - margin && z <= bounds.z1 + margin;
}

// ---------- 幾何小工具 ----------
function dedupeRing(pts) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q && q[0] === p[0] && q[1] === p[1]) continue;
    out.push(p);
  }
  while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  return out;
}

// 以 (x, 北) 計算的有號面積：> 0 為逆時針（北方朝上看）
function signedAreaNorthUp(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, z1] = ring[i];
    const [x2, z2] = ring[(i + 1) % ring.length];
    a += x1 * -z2 - x2 * -z1;
  }
  return a / 2;
}

function centroid(ring) {
  let a = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, z1] = ring[i];
    const [x2, z2] = ring[(i + 1) % ring.length];
    const f = x1 * z2 - x2 * z1;
    a += f;
    cx += (x1 + x2) * f;
    cz += (z1 + z2) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const n = ring.length;
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

// 投影 + 四捨五入 + 去重複收尾點 + 統一逆時針；少於 3 點回傳 null
function projectRing(geometry) {
  let ring = dedupeRing(geometry.map((g) => [r1(projX(g.lon)), r1(projZ(g.lat))]));
  if (ring.length < 3) return null;
  const area = signedAreaNorthUp(ring);
  if (Math.abs(area) < 1) return null;
  if (area < 0) ring = ring.reverse();
  return ring;
}

function projectLine(geometry) {
  const out = [];
  for (const g of geometry) {
    const p = [r1(projX(g.lon)), r1(projZ(g.lat))];
    const q = out[out.length - 1];
    if (q && q[0] === p[0] && q[1] === p[1]) continue;
    out.push(p);
  }
  return out;
}

// 線段是否與（外擴後的）範圍相交（Liang–Barsky）
function segmentHitsBox(a, b, m) {
  const x0 = bounds.x0 - m;
  const x1 = bounds.x1 + m;
  const z0 = bounds.z0 - m;
  const z1 = bounds.z1 + m;
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return clip(-dx, a[0] - x0) && clip(dx, x1 - a[0]) && clip(-dz, a[1] - z0) && clip(dz, z1 - a[1]);
}

// 把折線切成落在範圍內的連續片段（保留跨出邊界那一段的完整端點）
function clipLine(line) {
  const parts = [];
  let cur = null;
  for (let i = 0; i < line.length - 1; i++) {
    if (segmentHitsBox(line[i], line[i + 1], CLIP_MARGIN)) {
      if (!cur) {
        cur = [line[i]];
        parts.push(cur);
      }
      cur.push(line[i + 1]);
    } else {
      cur = null;
    }
  }
  return parts.filter((p) => p.length >= 2);
}

const flat = (pts) => pts.flat();

// 以 id 為種子的 [0, 1) 亂數（mulberry32 一次）
function hash01(id) {
  let t = (Number(id) * 2654435761 + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function num(v) {
  if (v === undefined || v === null) return null;
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------- 轉換 ----------
const stats = {
  buildings: 0, buildingTypes: {}, estimated: 0, fromHeight: 0, fromLevels: 0,
  roads: 0, roadTypes: {}, footways: 0, footTypes: {}, underground: 0, bridges: 0,
  parks: 0, water: 0, skipped: { outside: 0, degenerate: 0, relationNoGeometry: 0 },
};
const B = [];
const R = [];
const F = [];
const P = [];
const W = [];

// relation 多邊形：只取 outer 成員；成員沒有幾何時（例如只輸出 tags 的 relation）記錄後略過
function outerRingsOf(el) {
  if (el.type === 'way') return el.geometry ? [el.geometry] : [];
  if (el.type !== 'relation' || !Array.isArray(el.members)) return [];
  const rings = [];
  for (const m of el.members) {
    if (m.type === 'way' && (m.role === 'outer' || m.role === '') && Array.isArray(m.geometry)) rings.push(m.geometry);
  }
  return rings;
}

function ringInBounds(ring) {
  return ring.some(([x, z]) => inBounds(x, z));
}

for (const el of elements) {
  const tags = el.tags || {};
  if (tags.building && tags.building !== 'no') {
    const rings = outerRingsOf(el);
    if (!rings.length) {
      if (el.type === 'relation') stats.skipped.relationNoGeometry++;
      else stats.skipped.degenerate++;
      continue;
    }
    rings.forEach((geo, k) => {
      const ring = projectRing(geo);
      if (!ring) {
        stats.skipped.degenerate++;
        return;
      }
      if (!ringInBounds(ring)) {
        stats.skipped.outside++;
        return;
      }
      const type = tags.building;
      const levels = num(tags['building:levels']);
      const heightTag = num(tags.height);
      const b = { i: el.id };
      if (tags.name) b.n = tags.name;
      if (tags['name:en']) b.e = tags['name:en'];
      b.t = type;
      if (levels) b.l = levels;
      let h;
      if (heightTag) {
        h = heightTag;
        stats.fromHeight++;
      } else if (levels) {
        h = levels * floorHeight(type);
        stats.fromLevels++;
      } else {
        const base = (DEFAULT_LEVELS[type] ?? DEFAULT_LEVELS.yes) * floorHeight(type);
        h = base * (0.85 + 0.3 * hash01(el.id + k));
        b.s = 1;
        stats.estimated++;
      }
      b.h = r1(Math.max(2.5, h));
      b.p = flat(ring);
      B.push(b);
      stats.buildings++;
      stats.buildingTypes[type] = (stats.buildingTypes[type] || 0) + 1;
    });
    continue;
  }

  if (tags.highway && el.type === 'way' && Array.isArray(el.geometry)) {
    const type = tags.highway;
    const line = projectLine(el.geometry);
    if (line.length < 2) {
      stats.skipped.degenerate++;
      continue;
    }
    const parts = clipLine(line);
    if (!parts.length) {
      stats.skipped.outside++;
      continue;
    }
    const lanes = num(tags.lanes);
    let width = num(tags.width);
    if (!width && lanes && !FOOT_TYPES.has(type)) width = lanes * LANE_WIDTH;
    if (!width) width = DEFAULT_WIDTH[type] ?? 6;
    const layer = parseInt(tags.layer, 10) || 0;
    const tunnel = !!tags.tunnel && tags.tunnel !== 'no';
    const bridge = !!tags.bridge && tags.bridge !== 'no';
    const foot = FOOT_TYPES.has(type);
    for (const part of parts) {
      const r = { i: el.id };
      if (tags.name) r.n = tags.name;
      r.t = type;
      r.w = r1(width);
      if (lanes) r.ln = lanes;
      if (tags.oneway === 'yes' || tags.oneway === '1' || tags.oneway === 'true') r.o = 1;
      else if (tags.oneway === '-1' || tags.oneway === 'reverse') r.o = -1;
      if (bridge) r.br = 1;
      if (tunnel) r.tu = 1;
      if (layer) r.ly = layer;
      if (tunnel || layer < 0) {
        r.u = 1;
        stats.underground++;
      }
      if (bridge || layer > 0) stats.bridges++;
      r.p = flat(part);
      if (foot) {
        F.push(r);
        stats.footways++;
        stats.footTypes[type] = (stats.footTypes[type] || 0) + 1;
      } else {
        R.push(r);
        stats.roads++;
        stats.roadTypes[type] = (stats.roadTypes[type] || 0) + 1;
      }
    }
    continue;
  }

  const isPark = ['park', 'garden', 'playground', 'common', 'recreation_ground'].includes(tags.leisure);
  const isWater = tags.natural === 'water' || tags.water || tags.landuse === 'reservoir';
  if (isPark || isWater) {
    for (const geo of outerRingsOf(el)) {
      const ring = projectRing(geo);
      if (!ring) {
        stats.skipped.degenerate++;
        continue;
      }
      if (!ringInBounds(ring)) {
        stats.skipped.outside++;
        continue;
      }
      const o = { i: el.id };
      if (tags.name) o.n = tags.name;
      o.p = flat(ring);
      if (isWater) {
        W.push(o);
        stats.water++;
      } else {
        P.push(o);
        stats.parks++;
      }
    }
  }
}

const out = {
  v: 1,
  src: '© OpenStreetMap contributors (ODbL)',
  o: { lat: lat0, lon: lon0, kx: KX, kz: M_PER_DEG },
  bounds,
  B,
  R,
  F,
  P,
  W,
};
const json = JSON.stringify(out);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, json);

const sortObj = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
console.log(`原點（老虎城輪廓中心）：lat ${out.o.lat}, lon ${out.o.lon}，kx ${out.o.kx}`);
console.log(`世界邊界：x ${bounds.x0} ~ ${bounds.x1}，z ${bounds.z0} ~ ${bounds.z1}（${r1(bounds.x1 - bounds.x0)} m × ${r1(bounds.z1 - bounds.z0)} m）`);
console.log(`建築 ${stats.buildings} 棟（height ${stats.fromHeight}、levels ${stats.fromLevels}、估算 ${stats.estimated}）`);
console.log(`  類型：${sortObj(stats.buildingTypes)}`);
console.log(`車道路 ${stats.roads} 段：${sortObj(stats.roadTypes)}`);
console.log(`步道類 ${stats.footways} 段：${sortObj(stats.footTypes)}`);
console.log(`地下（tunnel / layer<0）${stats.underground} 段；橋樑 / layer>0 ${stats.bridges} 段（貼地處理）`);
console.log(`公園 ${stats.parks}、水域 ${stats.water}`);
console.log(`略過：範圍外 ${stats.skipped.outside}、退化幾何 ${stats.skipped.degenerate}、無幾何 relation ${stats.skipped.relationNoGeometry}`);
console.log(`輸出 ${OUT.replace(ROOT + '/', '')}：${(Buffer.byteLength(json) / 1024).toFixed(1)} KB`);
