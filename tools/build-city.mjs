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
//     f 1 = 推測填充建築（非 OSM；id 為負數、排在 OSM 建築之後，見「填充建築」段）
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
// 填充建築要避開的遊戲固定點位（純資料模組，不依賴 three / JSON）
import { POLICE_STATION, HOSPITAL, SPRAY_SHOPS } from '../src/wanted/places.js';
import { FOOD_SPOTS } from '../src/collect/food-spots.js';
import { NIGHT_MARKET_DELIVERY } from '../src/missions/events.js';
import { VALET_SITES } from '../src/job-props.js';
// 選單巡覽看點（與 src/ui/menu-tour.js 共用的純資料模組）
import { STOP_DEFS } from '../src/data/view-stops.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'data/osm/qiqi-raw-v2.json');
const OUT = process.env.CITY_OUT ? resolve(process.env.CITY_OUT) : resolve(ROOT, 'src/data/osm-city.json'); // CITY_OUT：改寫到別處（測試驗證可重現用）
// INFILL_EXTRA_KEEP="x,z;x,z"：額外不可建點位（測試驗證填充對輸入的局部穩定性用）
const EXTRA_KEEP = (process.env.INFILL_EXTRA_KEEP || '').split(';').filter(Boolean).map((t) => { const [x, z] = t.split(',').map(Number); return { x, z }; });
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
// 寬度取自 DEFAULT_WIDTH 的道路物件（R / F 元素；不寫進輸出 JSON）
const DEFAULT_WIDTH_ROADS = new WeakSet();
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
    const widthDefault = !width; // 無 width / lanes 標籤：寬度為等級預設值（不輸出，供填充判定七期主幹道）
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
      if (widthDefault) DEFAULT_WIDTH_ROADS.add(r);
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

// ---------- 填充建築（推測，f: 1） ----------
// OSM 在七期一帶只畫了少數建築，大部分街廓是空地：以固定種子在空地上產生推測建築輪廓，寫進 B（f: 1、id 為負數），與 OSM 建築走同一條擠出管線。
// 做法：INFILL_CELL 網格標出不可建區 → 沿道路兩側依道路等級排臨街地塊 → 街廓內部以網格取樣補中層公寓；部分地塊留空（停車場 / 工地，只佔位不輸出）。
// 不可建：地面道路與橋（半寬 + 依等級的人行道退縮）、步道、公園 P、水域 W、L 綠地 / 廣場、秋紅谷外框、下沉廣場、OSM 建築外擴（具名建築 = 地標範圍再加大）、
//   遊戲固定點位（重生點、噴漆廠、小吃點、夜市取餐點、泊車亭）周圍、bounds 內縮帶。
// 類型（臺中七期與周邊街景，數字皆推測）：主要幹道（trunk / primary / secondary）= 15–35 層住宅 / 辦公大樓（退縮、約半數有 2–4 層裙樓、間距寬）；
//   tertiary 與巷道 = 4–5 層透天厝連棟（面寬 4–6 m、進深 12–18 m、沿街連續）與 6–12 層公寓；街廓內部 = 6–12 層公寓為主、少數 13–18 層。
// 裙樓上的塔樓輪廓完全落在裙樓輪廓內（同一棟的上下兩個量體）——這是填充建築之間唯一的重疊；其餘彼此至少隔 UNIT_GAP。
const INFILL_SEED = 20261018;
const INFILL_CELL = 1; // 網格（m）；格子是否可建以格心判定並外加半對角線，取樣點落在可建格即保證離障礙 ≥ 退縮量
const INFILL_EDGE = 4; // bounds 內縮（m）
const CELL_PAD = INFILL_CELL * Math.SQRT1_2;
const ROAD_SETBACK = { trunk: 5, primary: 5, secondary: 4.5, tertiary: 4, residential: 3.5, unclassified: 3.5, living_street: 3.5, service: 1.5 };
const ROAD_SETBACK_DEFAULT = 3; // *_link 等
const FOOT_SETBACK = 1.5;
const AREA_PAD = 2; // P / W / L 外擴
const BASIN_PAD = 8;
const PLAZA_PAD = 3;
const OSM_PAD = 3;
const LANDMARK_PAD = 12; // 具名 OSM 建築：地標 glb 可能超出輪廓，門口另有出生點 / 人流
const KEEP_CLEAR_R = 15;
// 選單巡覽看點（src/data/view-stops.js STOP_DEFS，與 menu-tour.js tourStops 同規則：具名建築同名取面積最大者、秋紅谷 = T.basins 名稱比對的外框形心、
//   夜市攤車 = NIGHT_MARKET_DELIVERY.pickup（執行期 stallRow 原攤車格在其旁數公尺，相對下列半徑可忽略）；老虎城 = 出生點）：
//   VIEW_CLEAR_R 內不放填充建築（沿路低飛的鏡頭連 5 層透天都會擋）、LOW_RISE_R 內只放透天厝（≤ 5 層）；巡覽遮擋率上限 10%、鏡位會避開建築
const LOW_RISE_R = 170;
const VIEW_CLEAR_R = 110;
const L_BLOCK_KINDS = new Set(['park', 'garden', 'playground', 'pitch', 'grass', 'pedestrian', 'plaza', 'common', 'recreation_ground', 'dog_park']);
const TOWER_ROADS = new Set(['trunk', 'primary', 'secondary']);
const MID_ROADS = new Set(['tertiary']);
// 七期主要道路在 OSM 多標 tertiary（市政路、河南路、朝富路等，寬 12 m 以上或雙向分隔）：沿線實景以大樓為主，與幹道同列「大樓路段」，但混入臨街公寓 / 透天
//   判定：名稱在 QIQI_MAIN_NAMES，或 OSM 有明確 width / lanes 標籤且寬 > QIQI_MAIN_W（無標籤時寬度 = DEFAULT_WIDTH.tertiary = 12，不算）；
//   七期外的西屯路二段、龍門路、大墩路、環中路三段、朝馬路等未標寬度的 tertiary 回到透天 / 公寓
const QIQI_MAIN_W = 12;
const QIQI_MAIN_NAMES = ['臺灣大道', '河南路', '朝富路', '市政北七路', '惠來路', '市政路', '市政北一路', '惠中路'];
const QIQI_TOWER_P = 0.55;
const isQiqiMain = (r) => r.t === 'tertiary' && ((!DEFAULT_WIDTH_ROADS.has(r) && r.w > QIQI_MAIN_W) || QIQI_MAIN_NAMES.some((n) => (r.n || '').startsWith(n)));
const LANE_ROADS = new Set(['residential', 'unclassified', 'living_street']);
const VACANT_P = { tower: 0.12, mid: 0.12, lane: 0.12, interior: 0.12 }; // 留空地塊機率（目標空地比例約 10–15%）
const UNIT_GAP = 0.15; // 相鄰透天厝之間的縫（m）：共牆不共面，避免女兒牆與鄰棟外牆 z-fighting
const GAP = { tower: 10, apartment: 5, row: 3, vacant: 0 }; // 佔位外擴（m）＝與後放建築的最小間距
const FRONT_RETRY = [0, 3, 6, 10]; // 臨街地塊放不下時往內退的距離（m）
const FAIL_STEP = 3; // 地塊放不下時沿線前進（m）；lot 回傳 ≤ 此值表示失敗
const STOREY = 3.3;
const PODIUM_STOREY = 4.5;

// 亂數以「單元」各自建串流：臨街 = hash(INFILL_SEED, 0, 道路索引, 線段, 側)、街廓內部 = hash(INFILL_SEED, 1, 格點 i, j)；
//   id 同樣按單元分段（-(單元序 × INFILL_ID_STRIDE + 單元內序)），點位 / 障礙的局部變動只影響附近單元，不讓全城重排或 id 位移
const INFILL_ID_STRIDE = 100;
function infillHash(...vals) {
  let h = 2166136261;
  for (const v of vals) {
    h = Math.imul(h ^ (v >>> 0), 16777619);
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
    h ^= h >>> 15;
  }
  return h >>> 0;
}

function infillRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 道路沿線 / 街廓內部的填充建築；回傳 { list: B 格式陣列, stats }
function buildInfill(osmB, roads, foots, parks, waters, landcover, basinRing, plazaRing, basins) {
  let rng = null; // 目前單元的亂數串流（beginUnit 切換）
  const rand = (a, b) => a + (b - a) * rng();
  const randInt = (a, b) => a + Math.floor(rng() * (b - a + 1));
  const gx0 = bounds.x0 + INFILL_EDGE;
  const gz0 = bounds.z0 + INFILL_EDGE;
  const GW = Math.floor((bounds.x1 - INFILL_EDGE - gx0) / INFILL_CELL);
  const GH = Math.floor((bounds.z1 - INFILL_EDGE - gz0) / INFILL_CELL);
  const FREE = 0;
  const BLOCKED = 1;
  const TAKEN = 2;
  const VACANT = 3;
  const grid = new Uint8Array(GW * GH);
  const cellOf = (x, z) => {
    const i = Math.floor((x - gx0) / INFILL_CELL);
    const j = Math.floor((z - gz0) / INFILL_CELL);
    return i < 0 || j < 0 || i >= GW || j >= GH ? -1 : j * GW + i;
  };
  // bbox 內每個格心呼叫 hit(cx, cz)，為真則設為 value（只覆寫 FREE；BLOCKED 一律覆寫）
  const stampWhere = (x0, z0, x1, z1, value, hit) => {
    const i0 = Math.max(0, Math.floor((x0 - gx0) / INFILL_CELL));
    const j0 = Math.max(0, Math.floor((z0 - gz0) / INFILL_CELL));
    const i1 = Math.min(GW - 1, Math.floor((x1 - gx0) / INFILL_CELL));
    const j1 = Math.min(GH - 1, Math.floor((z1 - gz0) / INFILL_CELL));
    let n = 0;
    for (let j = j0; j <= j1; j++) {
      const cz = gz0 + (j + 0.5) * INFILL_CELL;
      for (let i = i0; i <= i1; i++) {
        const k = j * GW + i;
        if (grid[k] !== FREE && value !== BLOCKED) continue;
        if (grid[k] === BLOCKED) continue;
        if (!hit(gx0 + (i + 0.5) * INFILL_CELL, cz)) continue;
        grid[k] = value;
        n++;
      }
    }
    return n;
  };
  const segDist = (x, z, ax, az, bx, bz) => {
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
    return Math.hypot(x - ax - t * dx, z - az - t * dz);
  };
  const blockCapsule = (ax, az, bx, bz, r) => {
    const R = r + CELL_PAD;
    stampWhere(Math.min(ax, bx) - R, Math.min(az, bz) - R, Math.max(ax, bx) + R, Math.max(az, bz) + R, BLOCKED, (x, z) => segDist(x, z, ax, az, bx, bz) <= R);
  };
  const blockRing = (ring, pad) => {
    const R = pad + CELL_PAD;
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    for (const [x, z] of ring) {
      x0 = Math.min(x0, x);
      z0 = Math.min(z0, z);
      x1 = Math.max(x1, x);
      z1 = Math.max(z1, z);
    }
    stampWhere(x0 - R, z0 - R, x1 + R, z1 + R, BLOCKED, (x, z) => pointInRing(x, z, ring) || distToRing(x, z, ring) <= R);
  };
  const blockCircle = (cx, cz, r) => {
    const R = r + CELL_PAD;
    stampWhere(cx - R, cz - R, cx + R, cz + R, BLOCKED, (x, z) => Math.hypot(x - cx, z - cz) <= R);
  };

  // 1. 不可建區
  const setbackOf = (t) => ROAD_SETBACK[t] ?? ROAD_SETBACK_DEFAULT;
  for (const r of roads) {
    if (r.u) continue;
    const pts = unflat(r.p);
    for (let k = 0; k < pts.length - 1; k++) blockCapsule(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1], r.w / 2 + setbackOf(r.t));
  }
  for (const f of foots) {
    if (f.u) continue;
    const pts = unflat(f.p);
    for (let k = 0; k < pts.length - 1; k++) blockCapsule(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1], f.w / 2 + FOOT_SETBACK);
  }
  for (const a of [...parks, ...waters]) blockRing(unflat(a.p), AREA_PAD);
  for (const l of landcover) if (L_BLOCK_KINDS.has(l.k)) blockRing(unflat(l.p), AREA_PAD);
  blockRing(basinRing, BASIN_PAD);
  blockRing(plazaRing, PLAZA_PAD);
  for (const b of osmB) blockRing(unflat(b.p), b.n ? LANDMARK_PAD : OSM_PAD);
  const keep = [
    POLICE_STATION, HOSPITAL, ...SPRAY_SHOPS, ...FOOD_SPOTS, NIGHT_MARKET_DELIVERY.pickup,
    ...VALET_SITES.flatMap((v) => [v.stand, v.car, v.slot]),
  ];
  for (const p of [...keep, ...EXTRA_KEEP]) blockCircle(p.x, p.z, KEEP_CLEAR_R);
  const lowRiseAt = [];
  for (const d of STOP_DEFS) {
    if (d.source === 'stall') {
      lowRiseAt.push([NIGHT_MARKET_DELIVERY.pickup.x, NIGHT_MARKET_DELIVERY.pickup.z]);
      continue;
    }
    if (d.source === 'basin') {
      const b = basins.find((s) => s.n && d.re.test(s.n));
      if (b) lowRiseAt.push(centroid(unflat(b.p)));
      continue;
    }
    let best = null;
    for (const b of osmB) if (b.n && d.re.test(b.n) && (!best || areaOf(unflat(b.p)) > areaOf(unflat(best.p)))) best = b;
    if (best) lowRiseAt.push(centroid(unflat(best.p)));
  }
  const lowRise = (x, z) => lowRiseAt.some(([cx, cz]) => Math.hypot(x - cx, z - cz) < LOW_RISE_R);
  for (const [cx, cz] of lowRiseAt) blockCircle(cx, cz, VIEW_CLEAR_R);
  const openCells = grid.reduce((s, v) => s + (v === FREE ? 1 : 0), 0);

  // 道路線段索引（夾在同名雙向車道之間的分隔島判定、街廓內部的朝向）
  const SEG_BIN = 50;
  const segBins = new Map();
  const binKey = (i, j) => i * 100003 + j;
  for (const r of roads) {
    if (r.u) continue;
    const pts = unflat(r.p);
    for (let k = 0; k < pts.length - 1; k++) {
      const s = { ax: pts[k][0], az: pts[k][1], bx: pts[k + 1][0], bz: pts[k + 1][1], hw: r.w / 2, n: r.n || '', t: r.t };
      const pad = s.hw + 1;
      for (let i = Math.floor((Math.min(s.ax, s.bx) - pad) / SEG_BIN); i <= Math.floor((Math.max(s.ax, s.bx) + pad) / SEG_BIN); i++) {
        for (let j = Math.floor((Math.min(s.az, s.bz) - pad) / SEG_BIN); j <= Math.floor((Math.max(s.az, s.bz) + pad) / SEG_BIN); j++) {
          const key = binKey(i, j);
          if (!segBins.has(key)) segBins.set(key, []);
          segBins.get(key).push(s);
        }
      }
    }
  }
  const segsNear = (x, z, R) => {
    const out = new Set();
    for (let i = Math.floor((x - R) / SEG_BIN); i <= Math.floor((x + R) / SEG_BIN); i++) {
      for (let j = Math.floor((z - R) / SEG_BIN); j <= Math.floor((z + R) / SEG_BIN); j++) for (const s of segBins.get(binKey(i, j)) || []) out.add(s);
    }
    return out;
  };
  // 地塊背後（沿 n 往內）不遠處又碰到同名道路 → 地塊夾在雙向分隔車道 / 側車道之間，不蓋
  const betweenSameName = (name, cx, cz, nx, nz, hd) => {
    if (!name) return false;
    for (const d of [hd + 2, hd + 8, hd + 16]) {
      const px = cx + nx * d;
      const pz = cz + nz * d;
      for (const s of segsNear(px, pz, 30)) if (s.n === name && segDist(px, pz, s.ax, s.az, s.bx, s.bz) <= s.hw + 4) return true;
    }
    return false;
  };
  // 最近道路方向（街廓內部朝向）；找不到回傳 null
  const nearestDir = (x, z, R) => {
    let best = null;
    let bd = R;
    for (const s of segsNear(x, z, R)) {
      const d = segDist(x, z, s.ax, s.az, s.bx, s.bz);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    if (!best) return null;
    const L = Math.hypot(best.bx - best.ax, best.bz - best.az) || 1;
    return [(best.bx - best.ax) / L, (best.bz - best.az) / L];
  };

  // 2. 矩形工具：中心 (cx, cz)、沿 t 半寬 hw、沿 n（n = t 轉 90°）半深 hd
  const rectFree = (cx, cz, tx, tz, hw, hd) => {
    const nx = -tz;
    const nz = tx;
    const nu = Math.max(1, Math.ceil((2 * hw) / (INFILL_CELL / 2)));
    const nv = Math.max(1, Math.ceil((2 * hd) / (INFILL_CELL / 2)));
    for (let a = 0; a <= nu; a++) {
      const u = -hw + (2 * hw * a) / nu;
      for (let b = 0; b <= nv; b++) {
        const v = -hd + (2 * hd * b) / nv;
        const k = cellOf(cx + tx * u + nx * v, cz + tz * u + nz * v);
        if (k < 0 || grid[k] !== FREE) return false;
      }
    }
    return true;
  };
  const rectStamp = (cx, cz, tx, tz, hw, hd, gap, value) => {
    const nx = -tz;
    const nz = tx;
    const H = hw + gap + CELL_PAD;
    const D = hd + gap + CELL_PAD;
    const ext = Math.abs(tx) * H + Math.abs(nx) * D;
    const ezt = Math.abs(tz) * H + Math.abs(nz) * D;
    return stampWhere(cx - ext, cz - ezt, cx + ext, cz + ezt, value, (x, z) => {
      const u = (x - cx) * tx + (z - cz) * tz;
      const v = (x - cx) * nx + (z - cz) * nz;
      return Math.abs(u) <= H && Math.abs(v) <= D;
    });
  };
  const rectRing = (cx, cz, tx, tz, hw, hd) => {
    const nx = -tz;
    const nz = tx;
    const ring = [
      [cx - tx * hw - nx * hd, cz - tz * hw - nz * hd],
      [cx + tx * hw - nx * hd, cz + tz * hw - nz * hd],
      [cx + tx * hw + nx * hd, cz + tz * hw + nz * hd],
      [cx - tx * hw + nx * hd, cz - tz * hw + nz * hd],
    ].map(([x, z]) => [r1(x), r1(z)]);
    return signedAreaNorthUp(ring) > 0 ? ring : ring.reverse();
  };

  // 3. 產生
  const list = [];
  const stats = { towers: 0, podiums: 0, apartments: 0, rows: 0, houses: 0, interior: 0, vacantLots: 0, vacantArea: 0, footprint: 0, openArea: openCells * INFILL_CELL * INFILL_CELL };
  let unitId = 0;
  let unitN = 0;
  let unitMax = 0;
  const beginUnit = (unit, ...key) => {
    rng = infillRng(infillHash(INFILL_SEED, ...key));
    unitId = unit;
    unitN = 0;
  };
  const emit = (t, levels, storey, ring) => {
    if (++unitN >= INFILL_ID_STRIDE) throw new Error(`填充單元 ${unitId} 建築數超過 INFILL_ID_STRIDE ${INFILL_ID_STRIDE}`);
    unitMax = Math.max(unitMax, unitN);
    const b = { i: -(unitId * INFILL_ID_STRIDE + unitN), t, l: levels, h: r1(levels * storey), s: 1, f: 1, p: flat(ring) };
    list.push(b);
    stats.footprint += areaOf(ring);
    return b;
  };
  // 留空地塊（停車場 / 工地）：已確認可建的地塊整塊佔位、不輸出建築；回傳 0（呼叫端加上前進量）
  const vacant = (cx, cz, tx, tz, hw, hd) => {
    stats.vacantLots++;
    stats.vacantArea += rectStamp(cx, cz, tx, tz, hw, hd, GAP.vacant, VACANT) * INFILL_CELL * INFILL_CELL;
    return 0;
  };
  // 臨街地塊：frame = { ax, az, tx, tz, nx, nz }（n 指向地塊內側）、s = 沿線起點、front = 地塊前緣離中心線距離；回傳前進量
  const at = (f, s, d) => [f.ax + f.tx * s + f.nx * d, f.az + f.tz * s + f.nz * d];
  // 大樓地塊：依序試「裙樓 + 塔樓」/ 標準塔樓 / 瘦高塔樓（窄街廓），都放不下 → 臨街公寓
  const towerLot = (r, f, s, front) => {
    const variants = [
      rng() < 0.5 ? { tw: rand(20, 28), td: rand(18, 26), podium: true } : null,
      { tw: rand(20, 28), td: rand(18, 26), podium: false },
      { tw: rand(15, 20), td: rand(14, 18), podium: false, slim: true },
    ];
    for (const v of variants) {
      if (!v) continue;
      const { tw, td, podium } = v;
      const fw = podium ? tw + rand(8, 16) : tw;
      const fd = podium ? td + rand(8, 14) : td;
      const back = podium ? rand(2, 4) : v.slim ? rand(3, 5) : rand(5, 9); // 臨街退縮（人行空間 / 前庭）
      const [cx, cz] = at(f, s + fw / 2, front + back + fd / 2);
      if (lowRise(cx, cz)) return rowLot(r, f, s, front, VACANT_P.tower) || FAIL_STEP;
      if (!rectFree(cx, cz, f.tx, f.tz, fw / 2, fd / 2)) continue;
      if (betweenSameName(r.n, cx, cz, f.nx, f.nz, fd / 2)) return FAIL_STEP;
      if (rng() < VACANT_P.tower) return vacant(cx, cz, f.tx, f.tz, fw / 2, fd / 2) + fw + rand(6, 12);
      rectStamp(cx, cz, f.tx, f.tz, fw / 2, fd / 2, GAP.tower, TAKEN);
      const levels = v.slim ? randInt(15, 25) : randInt(15, 35);
      const type = rng() < 0.62 ? 'apartments' : 'office';
      if (podium) {
        emit('commercial', randInt(2, 4), PODIUM_STOREY, rectRing(cx, cz, f.tx, f.tz, fw / 2, fd / 2));
        stats.podiums++;
        // 塔樓：沿街置中、往後退（離裙樓前緣 ≥ 3 m、後緣 ≥ 2 m、兩側 ≥ 4 m）
        const room = fd - td - 5;
        const off = -fd / 2 + 3 + td / 2 + room * rng();
        emit(type, levels, STOREY, rectRing(cx + f.nx * off, cz + f.nz * off, f.tx, f.tz, tw / 2, td / 2));
      } else {
        emit(type, levels, STOREY, rectRing(cx, cz, f.tx, f.tz, tw / 2, td / 2));
      }
      stats.towers++;
      return fw + rand(12, 24);
    }
    return apartmentLot(r, f, s, front, VACANT_P.tower) || FAIL_STEP;
  };
  const apartmentLot = (r, f, s, front, pVacant) => {
    const w = rand(18, 30);
    const d = rand(12, 18);
    const [cx, cz] = at(f, s + w / 2, front + rand(1, 3) + d / 2);
    if (lowRise(cx, cz) || !rectFree(cx, cz, f.tx, f.tz, w / 2, d / 2)) return 0;
    if (betweenSameName(r.n, cx, cz, f.nx, f.nz, d / 2)) return 0;
    if (rng() < pVacant) return vacant(cx, cz, f.tx, f.tz, w / 2, d / 2) + w + rand(3, 6);
    rectStamp(cx, cz, f.tx, f.tz, w / 2, d / 2, GAP.apartment, TAKEN);
    emit('apartments', randInt(6, 12), STOREY, rectRing(cx, cz, f.tx, f.tz, w / 2, d / 2));
    stats.apartments++;
    return w + rand(6, 12);
  };
  const rowLot = (r, f, s, front, pVacant) => {
    const n = randInt(4, 10);
    const d = rand(12, 18);
    const back = rand(0, 1);
    const base = rand(4.3, 5.5);
    const units = [];
    let u = 0;
    let lv = rng() < 0.5 ? 4 : 5;
    for (let k = 0; k < n; k++) {
      const w = Math.max(4, Math.min(6, base + rand(-0.5, 0.5)));
      const [cx, cz] = at(f, s + u + w / 2, front + back + d / 2);
      if (!rectFree(cx, cz, f.tx, f.tz, (w - UNIT_GAP) / 2, d / 2)) break;
      if (k === 0 && betweenSameName(r.n, cx, cz, f.nx, f.nz, d / 2)) break;
      if (rng() < 0.35) lv = lv === 4 ? 5 : 4;
      units.push({ cx, cz, w, lv });
      u += w;
    }
    if (units.length < 2) return 0;
    const [rcx, rcz] = at(f, s + u / 2, front + back + d / 2);
    if (rng() < pVacant) return vacant(rcx, rcz, f.tx, f.tz, u / 2, d / 2) + u + rand(3, 6);
    rectStamp(rcx, rcz, f.tx, f.tz, u / 2, d / 2, GAP.row, TAKEN);
    for (const q of units) emit('house', q.lv, STOREY, rectRing(q.cx, q.cz, f.tx, f.tz, (q.w - UNIT_GAP) / 2, d / 2));
    stats.rows++;
    stats.houses += units.length;
    return u + rand(3, 8);
  };
  const smallLot = (r, f, s, front, pApartment) => {
    const pVacant = MID_ROADS.has(r.t) ? VACANT_P.mid : VACANT_P.lane;
    const first = rng() < pApartment ? apartmentLot : rowLot;
    const second = first === apartmentLot ? rowLot : apartmentLot;
    return first(r, f, s, front, pVacant) || second(r, f, s, front, pVacant) || FAIL_STEP;
  };
  // 臨街單元序：依 roads 索引 / 線段 / 側固定編號（與是否放得下無關）
  const unitBase = [];
  let frontUnits = 0;
  for (const r of roads) {
    unitBase.push(frontUnits);
    frontUnits += 2 * Math.max(0, r.p.length / 2 - 1);
  }
  const frontage = (pick, lot) => {
    for (let ri = 0; ri < roads.length; ri++) {
      const r = roads[ri];
      if (r.u || r.br || !pick(r)) continue;
      const front = r.w / 2 + setbackOf(r.t) + 2 * CELL_PAD + 0.1; // 前緣取樣點所在格的格心離退縮線 > CELL_PAD，才不會被判為不可建
      const pts = unflat(r.p);
      for (let k = 0; k < pts.length - 1; k++) {
        const [ax, az] = pts[k];
        const [bx, bz] = pts[k + 1];
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 10) continue;
        const tx = (bx - ax) / L;
        const tz = (bz - az) / L;
        for (const side of [1, -1]) {
          const sb = side === 1 ? 0 : 1;
          beginUnit(1 + unitBase[ri] + 2 * k + sb, 0, ri, k, sb);
          // n = t 轉 90°（rectRing 的深方向）× side；side = −1 時 t 反向讓 n 仍為 t 轉 90°
          const f = side === 1 ? { ax, az, tx, tz, nx: -tz, nz: tx } : { ax: bx, az: bz, tx: -tx, tz: -tz, nx: tz, nz: -tx };
          let s = rand(0, 6);
          while (s < L - 4) {
            // 前緣貼退縮線放不下（平行步道 / 側車道 / 停車場出入口）時，整塊往內退再試
            let adv = 0;
            for (const back of FRONT_RETRY) {
              adv = lot(r, f, s, front + back);
              if (adv > FAIL_STEP) break;
            }
            s += adv;
          }
        }
      }
    }
  };
  frontage((r) => TOWER_ROADS.has(r.t), towerLot);
  frontage(isQiqiMain, (r, f, s, front) => (rng() < QIQI_TOWER_P ? towerLot(r, f, s, front) : smallLot(r, f, s, front, 0.6)));
  frontage((r) => MID_ROADS.has(r.t) && !isQiqiMain(r), (r, f, s, front) => smallLot(r, f, s, front, 0.5));
  frontage((r) => LANE_ROADS.has(r.t), (r, f, s, front) => smallLot(r, f, s, front, 0.3));

  // 街廓內部：剩餘空地以 8 m 格點取樣（依 hash(INFILL_SEED, 格點) 排序 = 固定種子洗牌），朝向取最近道路；每個格點各自一條亂數串流
  const STEP = 8;
  const pts = [];
  const NI = Math.ceil((GW * INFILL_CELL - STEP / 2) / STEP);
  for (let j = 0, z = gz0 + STEP / 2; z < gz0 + GH * INFILL_CELL; j++, z += STEP) {
    for (let i = 0, x = gx0 + STEP / 2; x < gx0 + GW * INFILL_CELL; i++, x += STEP) pts.push({ x, z, i, j, order: infillHash(INFILL_SEED, 2, i, j) });
  }
  pts.sort((a, b) => a.order - b.order || a.j - b.j || a.i - b.i);
  for (const { x, z, i, j } of pts) {
    beginUnit(1 + frontUnits + j * NI + i, 1, i, j);
    const k = cellOf(x, z);
    if (k < 0 || grid[k] !== FREE || lowRise(x, z)) continue;
    const dir = nearestDir(x, z, 150);
    if (!dir) continue;
    const [tx, tz] = dir;
    for (const [w, d] of [[rand(20, 30), rand(13, 17)], [rand(12, 18), rand(10, 13)]]) {
      if (!rectFree(x, z, tx, tz, w / 2, d / 2)) continue;
      if (rng() < VACANT_P.interior) {
        vacant(x, z, tx, tz, w / 2, d / 2);
        break;
      }
      rectStamp(x, z, tx, tz, w / 2, d / 2, GAP.apartment, TAKEN);
      const levels = rng() < 0.2 ? randInt(13, 18) : randInt(6, 12);
      emit('apartments', levels, STOREY, rectRing(x, z, tx, tz, w / 2, d / 2));
      stats.interior++;
      break;
    }
  }
  stats.unitMax = unitMax;
  return { list, stats };
}

const infill = buildInfill(B, R, F, P, W, L, basinInfo.ring, plazaInfo.ring, T.basins);
B.push(...infill.list);

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
{
  const s = infill.stats;
  const vacantRatio = s.vacantArea / (s.vacantArea + s.footprint);
  console.log(`填充建築（推測，f: 1）${infill.list.length} 棟：大樓 ${s.towers}（裙樓 ${s.podiums}）、臨街公寓 ${s.apartments}、透天厝 ${s.houses}（${s.rows} 排）、街廓內部公寓 ${s.interior}`);
  const tert = R.filter((r) => r.t === 'tertiary' && !r.u && !r.br);
  console.log(`  tertiary 大樓路段 ${tert.filter(isQiqiMain).length} / ${tert.length} 段；單元內建築數上限 ${s.unitMax}（id 分段 ${INFILL_ID_STRIDE}）`);
  console.log(`  可建空地 ${Math.round(s.openArea)} m²、建築投影 ${Math.round(s.footprint)} m²、留空地塊 ${s.vacantLots} 塊 ${Math.round(s.vacantArea)} m²（空地 /（空地 + 投影）${(vacantRatio * 100).toFixed(1)}%）`);
}
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
