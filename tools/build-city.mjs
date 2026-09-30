#!/usr/bin/env node
// OSM → 遊戲城市資料轉檔工具（純 Node，無相依套件）
// 讀 data/osm/qiqi-raw-v2.json（Overpass API「out tags geom」輸出）→ 寫 src/data/osm-city.json
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
//   L 地表分區（v2 新增）：i id、k 種類（landuse / leisure 原值，或 parking / plaza / pedestrian 等正規化值）、n name、p 輪廓
//   T 地形特徵（v2 新增，供地形高度場使用）：
//     basins 下凹谷地：i、n、p 外框、li 湖面 id、lake 湖面輪廓（無則 null）、
//       exclude 不下凹子區域輪廓陣列、xi 與 exclude 對應的 { i, est, note }、
//       edges 外框每條邊 { a, b, side W/N/E/S（外法線方位）, kind grass_slope/ramp/terrace/flat, width 水平邊坡寬 m, est }、
//       levels { road, walkway, water, lakebed, est }（相對路面高度 m）、features 下行路徑等 { k, i?, p 點 [x, z] 或折線, est, note }
//     plazas 下沉廣場：i（無 OSM 元素為 null）、n、p、depth（m，負值往下）、est、note、stairs 寬大階梯所在邊的索引陣列（邊 k = 頂點 k → k+1）
//     note 全區其他地面高度說明
//   est 1 = 推測 / 估算數值（依 docs/ref/tiger-city-reference.md 標「推測 / 估」者），只能當參數預設值
// 多邊形類（B、P、W、L、T）與折線（R、F）都保證落在 bounds 外擴 CLIP_MARGIN 內：折線在外擴框處截斷，面狀分區以外擴框裁切。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'data/osm/qiqi-raw-v2.json');
const OUT = resolve(ROOT, 'src/data/osm-city.json');
const VERSION = 2;

// 資料擷取範圍（與 Overpass 查詢的 bbox 相同；v2 擴大到含臺中市政府、市議會、捷運市政府站）
const BBOX = { south: 24.156, west: 120.632, north: 24.17, east: 120.651 };
const ORIGIN_WAY = 150999799; // 老虎城購物中心
const M_PER_DEG = 111320; // 每度緯度的公尺數（球體近似）
const CLIP_MARGIN = 60; // 道路 / 面狀分區裁切時保留到邊界外多少公尺

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

// 惠來溪涵管（市政北六路下方，reference §6.5）：即使 raw 內有也不可當地面水域
const CULVERT_WAYS = new Set([617359972]);

// L 地表分區：leisure 收錄的值（公園 / 綠地 / 運動場等地面鋪面不同的面）
const L_LEISURE = new Set(['park', 'garden', 'playground', 'common', 'recreation_ground', 'pitch', 'dog_park', 'nature_reserve', 'track']);
// natural 綠地正規化為 grass
const L_NATURAL_GRASS = new Set(['grassland', 'scrub', 'heath']);

// ---------- T 地形特徵參數（全部出自 docs/ref/tiger-city-reference.md §6，數字皆為推測 / 估算，只當預設值） ----------
const BASIN_PARK_NAME = '秋紅谷'; // OSM 名稱含此字的 leisure=park（way 224961782 秋紅谷廣場）
const BASIN_PARKING_WAY = 336765602; // 秋紅谷停車場（§3、§6.2：與路面同高，不下凹）
// 邊坡型態與水平寬（§6.3「水平寬為截圖估算」；此處取各區間中值附近，推測）
const EDGE_RULES = {
  W: { kind: 'grass_slope', width: 20 }, // 西側朝富路：草坡 + 喬木，約 15–25 m（估）
  N: { kind: 'ramp', width: 35 }, // 北側臺灣大道：展示館與弧形坡道，約 30–40 m（估）
  E: { kind: 'terrace', width: 25 }, // 東側停車場側：階梯式平台，約 20–30 m（估）
  S: { kind: 'grass_slope', width: 18 }, // 南側市政北七路：草坡 + 樹，約 15–20 m（估）
};
const PARKING_EDGE = { kind: 'terrace', width: 25 }; // 與停車場相鄰的邊：§6.4「停車場西南緣就是往谷內下降的階梯平台」（推測寬度同東側）
const PARKING_ADJ_TOL = 5; // 外框邊中點距停車場輪廓 ≤ 此值（m）視為相鄰
// 相對路面高度（§6.1 建議：水面 −7、湖邊步道 −6；湖床比水面再低 2 m 為推測）
const BASIN_LEVELS = { road: 0, walkway: -6, water: -7, lakebed: -9 };
// 下行路徑約略位置（§6.2，由 3D 截圖判讀的估計經緯度）
const RAMP_START = { lat: 24.168, lon: 120.6388 }; // 北端弧形坡道起點
const TERRACE_LINE = [{ lat: 24.167, lon: 120.6393 }, { lat: 24.1666, lon: 120.6398 }]; // 東側階梯平台線段
const ZIGZAG_FOLDS = 2; // 白色 Z 字湖上步道的折點數（§6.2「曲折（Z 字）」，折數推測）
const ZIGZAG_AMPLITUDE = 0.2; // Z 字折點橫向偏移 / 步道長度（推測）
const PAVILION_NAME = /展示館|秋紅谷景觀生態公園/; // 北側展示館在 OSM 的可能名稱（§6.2）
// 老虎城下沉廣場（§1、§5、§6.5：前廣場中央往下約一層樓，深度推測 4–5 m）
const PLAZA_NAME = '老虎城下沉廣場';
const PLAZA_DEPTH = -4.5;
const PLAZA_FRONT_STRIP = 10; // 臨街一側保留地面層前廣場的寬度（m，推測：§1 街景為「前廣場往內接下沉廣場」）
const HENAN_FACING_BEARING = 121; // 面向河南路三段的外法線方位（§0 格網：河南路走向 31° + 90°）
const PLAZA_SEARCH_RADIUS = 80; // 在老虎城中心多少公尺內找 place=square / area:highway 等 OSM 面

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

function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// 點到多邊形邊界的最短距離
function distToRing(x, z, ring) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % ring.length];
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - (ax + t * dx), z - (az + t * dz)));
  }
  return best;
}

// 四捨五入 + 去重複收尾點 + 統一逆時針；少於 3 點或面積 < 1 m² 回傳 null
function normalizeRing(pts) {
  let ring = dedupeRing(pts.map(([x, z]) => [r1(x), r1(z)]));
  if (ring.length < 3) return null;
  const area = signedAreaNorthUp(ring);
  if (Math.abs(area) < 1) return null;
  if (area < 0) ring = ring.reverse();
  return ring;
}

function projectRing(geometry) {
  return normalizeRing(geometry.map((g) => [projX(g.lon), projZ(g.lat)]));
}

const projectPoint = ({ lat, lon }) => [r1(projX(lon)), r1(projZ(lat))];

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

// 線段與（外擴後的）範圍的交集參數區間（Liang–Barsky）；不相交回傳 null
function segmentClipT(a, b, m) {
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
  const hit = clip(-dx, a[0] - x0) && clip(dx, x1 - a[0]) && clip(-dz, a[1] - z0) && clip(dz, z1 - a[1]);
  return hit ? [t0, t1] : null;
}

// 把折線切成落在外擴範圍內的連續片段；跨出外擴框的線段在框線處截斷
function clipLine(line) {
  const lerp = (a, b, t) => [r1(a[0] + (b[0] - a[0]) * t), r1(a[1] + (b[1] - a[1]) * t)];
  const push = (arr, p) => {
    const q = arr[arr.length - 1];
    if (!q || q[0] !== p[0] || q[1] !== p[1]) arr.push(p);
  };
  const parts = [];
  let cur = null;
  for (let i = 0; i < line.length - 1; i++) {
    const t = segmentClipT(line[i], line[i + 1], CLIP_MARGIN);
    if (!t) {
      cur = null;
      continue;
    }
    if (!cur || t[0] > 0) {
      cur = [];
      parts.push(cur);
    }
    push(cur, t[0] > 0 ? lerp(line[i], line[i + 1], t[0]) : line[i]);
    push(cur, t[1] < 1 ? lerp(line[i], line[i + 1], t[1]) : line[i + 1]);
    if (t[1] < 1) cur = null;
  }
  return parts.filter((p) => p.length >= 2);
}

// 多邊形以外擴範圍裁切（Sutherland–Hodgman，軸對齊矩形為凸，結果仍是單一多邊形）
function clipRingToBox(ring) {
  const m = CLIP_MARGIN;
  const planes = [
    (p) => p[0] - (bounds.x0 - m),
    (p) => bounds.x1 + m - p[0],
    (p) => p[1] - (bounds.z0 - m),
    (p) => bounds.z1 + m - p[1],
  ];
  let pts = ring;
  for (const f of planes) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const fa = f(a);
      const fb = f(b);
      if (fa >= 0) out.push(a);
      if (fa >= 0 !== fb >= 0) {
        const t = fa / (fa - fb);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    pts = out;
    if (pts.length < 3) return null;
  }
  return normalizeRing(pts);
}

const ringOutsideMargin = (ring) => ring.some(([x, z]) => !inBounds(x, z, CLIP_MARGIN));

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
  parks: 0, water: 0, landcover: 0, landcoverKinds: {}, clippedAreas: 0, culverts: 0,
  relations: { assembledOuter: 0, skippedInner: 0, openOuter: 0 },
  skipped: { outside: 0, degenerate: 0, relationNoGeometry: 0, buildingOverMargin: 0 },
};
const B = [];
const R = [];
const F = [];
const P = [];
const W = [];
const L = [];
const warnings = [];

// relation 多邊形：outer 成員依端點接成封閉環（內環略過並計數）；成員沒有幾何時（只輸出 tags 的 relation）回傳空陣列
function outerRingsOf(el) {
  if (el.type === 'way') return el.geometry ? [el.geometry] : [];
  if (el.type !== 'relation' || !Array.isArray(el.members)) return [];
  const pieces = [];
  for (const m of el.members) {
    if (m.type !== 'way' || !Array.isArray(m.geometry) || m.geometry.length < 2) continue;
    if (m.role === 'inner') stats.relations.skippedInner++;
    else if (m.role === 'outer' || m.role === '') pieces.push(m.geometry.slice());
  }
  const same = (a, b) => a.lat === b.lat && a.lon === b.lon;
  const rings = [];
  while (pieces.length) {
    const ring = pieces.shift();
    while (!same(ring[0], ring[ring.length - 1])) {
      const end = ring[ring.length - 1];
      const k = pieces.findIndex((p) => same(p[0], end) || same(p[p.length - 1], end));
      if (k < 0) break;
      const next = pieces.splice(k, 1)[0];
      if (!same(next[0], end)) next.reverse();
      ring.push(...next.slice(1));
    }
    if (same(ring[0], ring[ring.length - 1])) {
      rings.push(ring);
      stats.relations.assembledOuter++;
    } else {
      stats.relations.openOuter++;
    }
  }
  return rings;
}

function ringInBounds(ring) {
  return ring.some(([x, z]) => inBounds(x, z));
}

// 面狀分區：投影 → 範圍檢查 → 以外擴框裁切；回傳可輸出的環陣列
function areaRings(el) {
  const rings = [];
  for (const geo of outerRingsOf(el)) {
    let ring = projectRing(geo);
    if (!ring) {
      stats.skipped.degenerate++;
      continue;
    }
    if (!ringInBounds(ring)) {
      stats.skipped.outside++;
      continue;
    }
    if (ringOutsideMargin(ring)) {
      ring = clipRingToBox(ring);
      stats.clippedAreas++;
      if (!ring) continue;
    }
    rings.push(ring);
  }
  return rings;
}

// L 種類正規化：只收地面鋪面 / 草地有差異的面；建築物本身（含立體停車場）不收
function landcoverKind(tags) {
  if (tags.building && tags.building !== 'no') return null;
  if (tags['area:highway']) return tags['area:highway'];
  if (tags.place === 'square') return 'plaza';
  if (tags.highway === 'pedestrian' && tags.area === 'yes') return 'pedestrian';
  if (tags.amenity === 'parking') return 'parking';
  if (L_LEISURE.has(tags.leisure)) return tags.leisure;
  if (tags.landuse) return tags.landuse;
  if (L_NATURAL_GRASS.has(tags.natural)) return 'grass';
  return null;
}

const isCulvert = (el, tags) => CULVERT_WAYS.has(el.id) || tags.tunnel === 'culvert' || tags.covered === 'yes' || (parseInt(tags.layer, 10) || 0) < 0;

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
      // 建築輪廓不裁切（切開會多出假牆面）：超出外擴框的邊界建築整棟略過
      if (ringOutsideMargin(ring)) {
        stats.skipped.buildingOverMargin++;
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
    // 步行區面（highway=pedestrian + area=yes）同時收進 L，F 保留原本的折線輸出
    const kind = landcoverKind(tags);
    if (kind) pushLandcover(el, tags, kind, areaRings(el));
    continue;
  }

  const isPark = ['park', 'garden', 'playground', 'common', 'recreation_ground'].includes(tags.leisure);
  const isWater = tags.natural === 'water' || tags.water || tags.landuse === 'reservoir';
  if (isWater && isCulvert(el, tags)) {
    stats.culverts++;
    continue;
  }
  const kind = isWater ? null : landcoverKind(tags);
  if (!isPark && !isWater && !kind) continue;
  const rings = areaRings(el);
  for (const ring of rings) {
    if (!isPark && !isWater) break;
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
  if (kind) pushLandcover(el, tags, kind, rings);
}

function pushLandcover(el, tags, kind, rings) {
  for (const ring of rings) {
    const o = { i: el.id, k: kind };
    if (tags.name) o.n = tags.name;
    o.p = flat(ring);
    L.push(o);
    stats.landcover++;
    stats.landcoverKinds[kind] = (stats.landcoverKinds[kind] || 0) + 1;
  }
}

// ---------- T 地形特徵 ----------
const unflat = (p) => {
  const out = [];
  for (let i = 0; i < p.length; i += 2) out.push([p[i], p[i + 1]]);
  return out;
};
const areaOf = (ring) => Math.abs(signedAreaNorthUp(ring));

// 逆時針環第 i 條邊（i → i+1）外法線的方位角（0 = 北、90 = 東）
function edgeNormalBearing(ring, i) {
  const [ax, az] = ring[i];
  const [bx, bz] = ring[(i + 1) % ring.length];
  const de = bx - ax;
  const dn = -(bz - az);
  return ((Math.atan2(dn, -de) * 180) / Math.PI + 360) % 360;
}
const bearingToSide = (deg) => (deg >= 315 || deg < 45 ? 'N' : deg < 135 ? 'E' : deg < 225 ? 'S' : 'W');
const bearingDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

// 逆時針環的凹頂點索引
function reflexVertices(ring) {
  const n = ring.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const [px, pz] = ring[(i + n - 1) % n];
    const [cx, cz] = ring[i];
    const [nx, nz] = ring[(i + 1) % n];
    const cross = (cx - px) * -(nz - cz) - -(cz - pz) * (nx - cx);
    if (cross < 0) out.push(i);
  }
  return out;
}

// L 形缺角：凹頂點與兩個相鄰頂點補成平行四邊形
function notchQuad(ring, i) {
  const n = ring.length;
  const prev = ring[(i + n - 1) % n];
  const cur = ring[i];
  const next = ring[(i + 1) % n];
  return normalizeRing([cur, next, [prev[0] + next[0] - cur[0], prev[1] + next[1] - cur[1]], prev]);
}

// 凸多邊形指定邊向內平移 d 公尺後重新求交點（其他邊不動）
function insetEdges(ring, edgeSet, d) {
  const n = ring.length;
  const lines = ring.map((a, i) => {
    const b = ring[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ux = (b[0] - a[0]) / len;
    const uz = (b[1] - a[1]) / len;
    // 逆時針（北朝上）的內側在邊方向左手；換回 (x, z) 為 (uz, -ux)
    const off = edgeSet.has(i) ? d : 0;
    return { p: [a[0] + uz * off, a[1] - ux * off], u: [ux, uz] };
  });
  const out = [];
  for (let i = 0; i < n; i++) {
    const l1 = lines[(i + n - 1) % n];
    const l2 = lines[i];
    const den = l1.u[0] * l2.u[1] - l1.u[1] * l2.u[0];
    const t = ((l2.p[0] - l1.p[0]) * l2.u[1] - (l2.p[1] - l1.p[1]) * l2.u[0]) / den;
    out.push([l1.p[0] + l1.u[0] * t, l1.p[1] + l1.u[1] * t]);
  }
  return normalizeRing(out);
}

// 水平線 z 與多邊形的交段（依 x 排序成對）
function horizontalChords(ring, z) {
  const xs = [];
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % ring.length];
    if (az > z !== bz > z) xs.push(ax + ((z - az) / (bz - az)) * (bx - ax));
  }
  xs.sort((a, b) => a - b);
  const segs = [];
  for (let i = 0; i + 1 < xs.length; i += 2) segs.push([xs[i], xs[i + 1]]);
  return segs;
}

// 多邊形內離邊界最遠的點（1 m 格點搜尋），當作「湖中央」
function poleOfInaccessibility(ring) {
  const xs = ring.map((p) => p[0]);
  const zs = ring.map((p) => p[1]);
  let best = null;
  for (let x = Math.min(...xs); x <= Math.max(...xs); x += 1) {
    for (let z = Math.min(...zs); z <= Math.max(...zs); z += 1) {
      if (!pointInRing(x, z, ring)) continue;
      const d = distToRing(x, z, ring);
      if (!best || d > best.d) best = { x, z, d };
    }
  }
  return [best.x, best.z];
}

const T_EST = []; // 所有 est:1 項目（統計列印用）

function buildBasin() {
  const el = elements.find((e) => e.type === 'way' && e.tags?.leisure === 'park' && e.tags?.name?.includes(BASIN_PARK_NAME));
  if (!el) throw new Error(`raw 內找不到名稱含「${BASIN_PARK_NAME}」的 leisure=park`);
  const ring = projectRing(el.geometry);
  const basin = { i: el.id, n: el.tags.name, p: flat(ring) };

  // 湖面：輸出的 W 中重心落在谷內者取面積最大
  const lakes = W.map((w) => ({ i: w.i, ring: unflat(w.p) }))
    .filter((w) => pointInRing(...centroid(w.ring), ring))
    .sort((a, b) => areaOf(b.ring) - areaOf(a.ring));
  const lake = lakes[0] || null;
  basin.li = lake ? lake.i : null;
  basin.lake = lake ? flat(lake.ring) : null;
  if (!lake) warnings.push(`${el.tags.name} 內找不到 natural=water / water=* 湖面，lake = null`);

  // 不下凹子區域：秋紅谷停車場
  const parkingEl = elements.find((e) => e.type === 'way' && e.id === BASIN_PARKING_WAY && e.geometry);
  let parking;
  if (parkingEl) {
    parking = projectRing(parkingEl.geometry);
    basin.xi = [{ i: BASIN_PARKING_WAY, est: 0, note: 'OSM 秋紅谷停車場輪廓（§6.2 與路面同高）' }];
  } else {
    const reflex = reflexVertices(ring);
    if (reflex.length !== 1) throw new Error(`raw 無停車場 way ${BASIN_PARKING_WAY}，且谷地外框凹頂點 ${reflex.length} 個，無法推算`);
    parking = notchQuad(ring, reflex[0]);
    const note = `raw v2 無 way ${BASIN_PARKING_WAY}；以谷地外框 L 形缺角（凹頂點 ${reflex[0]} 與相鄰兩頂點）補成平行四邊形推算（§3、§6.2：東北角平面停車場約 115 × 120 m）`;
    basin.xi = [{ i: BASIN_PARKING_WAY, est: 1, note }];
    warnings.push(note);
    T_EST.push(`basin.exclude 停車場輪廓（缺角推算）`);
  }
  basin.exclude = [flat(parking)];

  // 外框每條邊：外法線方位 → 邊坡型態（§6.3）；與停車場相鄰者為階梯平台（§6.4）
  basin.edges = ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length];
    const side = bearingToSide(edgeNormalBearing(ring, i));
    const nearParking = distToRing((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, parking) <= PARKING_ADJ_TOL;
    const rule = nearParking ? PARKING_EDGE : EDGE_RULES[side];
    return { a: i, b: (i + 1) % ring.length, side, kind: rule.kind, width: rule.width, est: 1 };
  });
  T_EST.push('basin.edges 邊坡型態 / 寬度（§6.3 截圖估算）');
  basin.levels = { ...BASIN_LEVELS, est: 1 };
  T_EST.push('basin.levels road 0 / walkway −6 / water −7 / lakebed −9（§6.1 推測）');

  basin.features = buildBasinFeatures(ring, lake ? lake.ring : null, basin.edges);
  return { basin, ring, lake, parking };
}

function buildBasinFeatures(ring, lakeRing, edges) {
  const f = [];
  const add = (o) => {
    f.push(o);
    if (o.est) T_EST.push(`feature ${o.k}：${o.note}`);
  };
  add({ k: 'ramp_start', p: projectPoint(RAMP_START), est: 1, note: '§6.2 北端弧形坡道起點 24.1680,120.6388（估）' });
  add({ k: 'terrace_line', p: flat(TERRACE_LINE.map(projectPoint)), est: 1, note: '§6.2 東側階梯平台線段 24.1670,120.6393→24.1666,120.6398（估）' });

  if (lakeRing) {
    const zs = lakeRing.map((p) => p[1]);
    const zMid = (Math.min(...zs) + Math.max(...zs)) / 2;
    const chord = horizontalChords(lakeRing, zMid).sort((a, b) => b[1] - b[0] - (a[1] - a[0]))[0];
    add({ k: 'red_bridge', p: [r1(chord[0]), r1(zMid), r1(chord[1]), r1(zMid)], est: 1, note: '§6.2 跨湖紅橋大致東西向跨越湖中段：取湖面南北中線的東西向弦' });

    const c = poleOfInaccessibility(lakeRing);
    const shoreX = horizontalChords(lakeRing, c[1]).find(([x0, x1]) => c[0] >= x0 && c[0] <= x1)[1];
    const shore = [shoreX, c[1]];
    const len = shoreX - c[0];
    let amp = ZIGZAG_AMPLITUDE * len;
    let pts;
    // 折點須落在湖面內；超出就把橫向偏移減半重算
    for (;;) {
      pts = [shore];
      for (let k = 1; k <= ZIGZAG_FOLDS; k++) {
        const t = k / (ZIGZAG_FOLDS + 1);
        pts.push([shoreX - len * t, c[1] + (k % 2 ? amp : -amp)]);
      }
      pts.push(c);
      if (pts.slice(1).every(([x, z]) => pointInRing(x, z, lakeRing)) || amp < 0.5) break;
      amp /= 2;
    }
    add({ k: 'zigzag_walk', p: flat(pts.map(([x, z]) => [r1(x), r1(z)])), est: 1, note: '§6.2 白色 Z 字湖上步道由東岸伸進湖中央：湖中央取湖面內離岸最遠點，東岸取其正東岸點，折點等分並交錯橫移（推算）' });
  }

  // 北側展示館：raw 有名稱相符或位於谷內的建築就用 OSM，否則以北側邊推估
  const hall = B.find((b) => PAVILION_NAME.test(b.n || '')) || B.find((b) => pointInRing(...centroid(unflat(b.p)), ring));
  if (hall) {
    add({ k: 'pavilion', i: hall.i, p: centroid(unflat(hall.p)).map(r1), est: 0, note: `OSM 建築 ${hall.i}${hall.n ? ' ' + hall.n : ''}（§6.2 北側展示館）` });
  } else {
    const north = edges.filter((e) => e.side === 'N' && e.kind === EDGE_RULES.N.kind)
      .map((e) => ({ e, len: Math.hypot(ring[e.b][0] - ring[e.a][0], ring[e.b][1] - ring[e.a][1]) }))
      .sort((a, b) => b.len - a.len)[0].e;
    const a = ring[north.a];
    const b = ring[north.b];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const inset = north.width / 2;
    const p = [(a[0] + b[0]) / 2 + ((b[1] - a[1]) / len) * inset, (a[1] + b[1]) / 2 - ((b[0] - a[0]) / len) * inset];
    add({ k: 'pavilion', p: p.map(r1), est: 1, note: '§6.2 北端近臺灣大道的綠頂橢圓展示館；raw 無對應建築 / 名稱，取最長北側邊中點向內退半個坡道寬推估' });
  }

  // OSM 湖上步橋（bridge=yes 且中點在湖面內）：真實幾何，供對照 §6.2 紅橋 / Z 字步道
  if (lakeRing) {
    for (const r of F) {
      if (!r.br) continue;
      const pts = unflat(r.p);
      const mid = pts[Math.floor(pts.length / 2)];
      if (!pointInRing(mid[0], mid[1], lakeRing)) continue;
      f.push({ k: 'lake_bridge_osm', i: r.i, p: r.p, est: 0, note: `OSM highway=${r.t} bridge=yes 跨湖（與 §6.2 紅橋 / Z 字步道的對應未查證）` });
    }
  }
  return f;
}

function buildPlaza() {
  const tigerRing = projectRing(originEl.geometry);
  const plazaTags = (t) => t.place === 'square' || t['area:highway'] || (t.highway === 'pedestrian' && t.area === 'yes') || /下沉/.test(t.name || '');
  const osmPlaza = elements.find((e) => {
    if (e.type !== 'way' || !e.geometry || !plazaTags(e.tags || {})) return false;
    const r = projectRing(e.geometry);
    return r && Math.hypot(...centroid(r)) <= PLAZA_SEARCH_RADIUS;
  });
  let ring;
  let note;
  let i = null;
  if (osmPlaza) {
    ring = projectRing(osmPlaza.geometry);
    i = osmPlaza.id;
    note = `OSM 面 way ${osmPlaza.id}；深度依 §6.5 推測 4–5 m`;
  } else {
    const reflex = reflexVertices(tigerRing);
    if (reflex.length !== 1) throw new Error(`老虎城輪廓凹頂點 ${reflex.length} 個，無法推算下沉廣場`);
    const quad = notchQuad(tigerRing, reflex[0]);
    const outer = new Set(quad.map((_, k) => k).filter((k) => {
      const a = quad[k];
      const b = quad[(k + 1) % quad.length];
      return distToRing((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, tigerRing) > 1;
    }));
    ring = insetEdges(quad, outer, PLAZA_FRONT_STRIP);
    note = `raw v2 老虎城 ${PLAZA_SEARCH_RADIUS} m 內無 place=square / area:highway / 步行區面；依 §1「L 形缺角＝前廣場 + 下沉廣場」取缺角平行四邊形（約合 §5 的 45 × 40 m），臨街兩邊各退 ${PLAZA_FRONT_STRIP} m 保留地面層前廣場（推測）；深度 §6.5 推測 4–5 m`;
  }
  // 寬大階梯：不貼建築的邊中，外法線最朝向河南路三段者（§1 主立面朝東南面向河南路）
  const open = ring.map((_, k) => k).filter((k) => {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    return distToRing((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, tigerRing) > 1;
  });
  const stairs = open.sort((a, b) => bearingDiff(edgeNormalBearing(ring, a), HENAN_FACING_BEARING) - bearingDiff(edgeNormalBearing(ring, b), HENAN_FACING_BEARING))[0];
  T_EST.push(`plaza ${PLAZA_NAME}：${osmPlaza ? 'OSM 幾何' : '輪廓推算'}、depth ${PLAZA_DEPTH}、階梯邊 ${stairs}`);
  return { plaza: { i, n: PLAZA_NAME, p: flat(ring), depth: PLAZA_DEPTH, est: 1, note, stairs: [stairs] }, ring };
}

const basinInfo = buildBasin();
const plazaInfo = buildPlaza();
const T = {
  basins: [basinInfo.basin],
  plazas: [plazaInfo.plaza],
  note: '除 basins（秋紅谷，停車場不下凹）與 plazas（老虎城下沉廣場）外，全區地面 y = 0（reference §6.5：其餘大致平坦）',
};

const out = {
  v: VERSION,
  src: '© OpenStreetMap contributors (ODbL)',
  o: { lat: lat0, lon: lon0, kx: KX, kz: M_PER_DEG },
  bounds,
  B,
  R,
  F,
  P,
  W,
  L,
  T,
};
const json = JSON.stringify(out);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, json);

// ---------- 統計 ----------
const MAIN_ROADS = ['臺灣大道', '河南路', '朝富路', '市政北七路', '惠來路'];
const lineLength = (p) => {
  let s = 0;
  for (let i = 2; i < p.length; i += 2) s += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return s;
};
const sortObj = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
const bs = basinInfo.basin;
console.log(`資料來源 ${SRC.replace(ROOT + '/', '')}，輸出 v${VERSION}`);
console.log(`原點（老虎城輪廓中心）：lat ${out.o.lat}, lon ${out.o.lon}，kx ${out.o.kx}`);
console.log(`世界邊界：x ${bounds.x0} ~ ${bounds.x1}，z ${bounds.z0} ~ ${bounds.z1}（${r1(bounds.x1 - bounds.x0)} m × ${r1(bounds.z1 - bounds.z0)} m）`);
console.log(`建築 ${stats.buildings} 棟（height ${stats.fromHeight}、levels ${stats.fromLevels}、估算 ${stats.estimated}）`);
console.log(`  類型：${sortObj(stats.buildingTypes)}`);
console.log(`車道路 ${stats.roads} 段：${sortObj(stats.roadTypes)}`);
console.log(`步道類 ${stats.footways} 段：${sortObj(stats.footTypes)}`);
console.log(`地下（tunnel / layer<0）${stats.underground} 段；橋樑 / layer>0 ${stats.bridges} 段（貼地處理）`);
console.log(`主要道路車道總長：${MAIN_ROADS.map((n) => `${n} ${Math.round(R.filter((r) => (r.n || '').includes(n)).reduce((s, r) => s + lineLength(r.p), 0))} m`).join('、')}`);
console.log(`公園 ${stats.parks}、水域 ${stats.water}、地表分區 ${stats.landcover}（${sortObj(stats.landcoverKinds)}）；面狀裁切 ${stats.clippedAreas}`);
console.log(`涵管：略過 ${stats.culverts}；way ${[...CULVERT_WAYS].join(', ')} ${[...CULVERT_WAYS].every((id) => !elements.some((e) => e.id === id)) ? 'raw 內無' : 'raw 內有（已排除於 W）'}`);
console.log(`multipolygon：組成外環 ${stats.relations.assembledOuter}、略過內環 ${stats.relations.skippedInner}、未閉合外環 ${stats.relations.openOuter}、無成員幾何 ${stats.skipped.relationNoGeometry}`);
console.log(`略過：範圍外 ${stats.skipped.outside}、退化幾何 ${stats.skipped.degenerate}、建築超出外擴框 ${stats.skipped.buildingOverMargin}`);
console.log(`地標：${[222413435, 222636758].map((id) => `${id} ${B.some((b) => b.i === id) ? '在 B' : '缺'}`).join('、')}；捷運市政府站 ${B.filter((b) => (b.n || '').includes('市政府站')).map((b) => b.i).join(' / ') || '缺'}`);
console.log(`秋紅谷 ${bs.i}：外框 ${Math.round(areaOf(basinInfo.ring))} m²、湖面 ${basinInfo.lake ? Math.round(areaOf(basinInfo.lake.ring)) + ' m²（way ' + bs.li + '）' : '無'}、停車場 ${Math.round(areaOf(basinInfo.parking))} m²`);
console.log(`  邊坡：${bs.edges.map((e) => `${e.a}-${e.b} ${e.side}/${e.kind}/${e.width}`).join('；')}`);
console.log(`  features：${bs.features.map((f) => f.k + (f.est ? '(est)' : '')).join('、')}`);
console.log(`下沉廣場：${Math.round(areaOf(plazaInfo.ring))} m²，depth ${plazaInfo.plaza.depth}，stairs 邊 ${plazaInfo.plaza.stairs}`);
console.log(`est:1 項目：\n  ${T_EST.join('\n  ')}`);
for (const w of warnings) console.warn(`警告：${w}`);
console.log(`輸出 ${OUT.replace(ROOT + '/', '')}：${(Buffer.byteLength(json) / 1024).toFixed(1)} KB`);
