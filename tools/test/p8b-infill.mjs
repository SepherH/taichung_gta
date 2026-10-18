#!/usr/bin/env node
// P8b 街廓填充建築（tools/build-city.mjs 填充步驟）無頭驗證：node tools/test/p8b-infill.mjs（純 Node，不依賴 three）
// 項目：填充建築數量（≥ 1000）與欄位（f 1、負數 id 不重複、排在 OSM 建築之後、l / h / s）、類型組成（大樓 / 公寓 / 透天厝）、
//   輪廓合法（逆時針、在 bounds 內）、不壓道路（依等級留人行道）/ 步道 / 公園 / 水域 / L 綠地廣場 / 秋紅谷 / 下沉廣場 / OSM 建築（外擴 3 m）、
//   填充建築彼此不重疊（裙樓上的塔樓完全落在裙樓內除外）、透天厝面寬 / 進深、空地比例、
//   同一種子產出完全相同且與 repo 內 osm-city.json 一致、遊戲固定點位（出生點一帶、重生點、噴漆廠、小吃點、夜市取餐點、泊車亭、地標 / 光柱點）不被覆蓋。
// 任一項不符 exit 1。
import { register } from 'node:module';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POLICE_STATION, HOSPITAL, SPRAY_SHOPS } from '../../src/wanted/places.js';
import { FOOD_SPOTS } from '../../src/collect/food-spots.js';
import { NIGHT_MARKET_DELIVERY } from '../../src/missions/events.js';
import { VALET_SITES } from '../../src/job-props.js';
import { TIGER_CITY_ID } from '../../src/data/city.js';

// src 內的 JSON import（landmark-points.js → osm-city.json）以 loader hook 轉成 ES module
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
const { landmarkPoints } = await import('../../src/core/landmark-points.js');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CITY = resolve(ROOT, 'src/data/osm-city.json');
const city = JSON.parse(readFileSync(CITY, 'utf8'));

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
};

// 門檻（與 tools/build-city.mjs 的填充參數對應；容差 0.15 m 吸收輸出四捨五入到 0.1 m）
const MIN_COUNT = 1000;
const TOL = 0.15;
const PED_ROAD_TYPES = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street']);
const PED_CLEAR = 3.1; // 人行道行走線（路緣外 1.3 / 2.6 m）+ places.js ROUTE_CLEAR_PAD 0.5
const OTHER_ROAD_CLEAR = 1.5; // service / link
const FOOT_CLEAR = 1.5;
const AREA_CLEAR = 2;
const OSM_CLEAR = 3;
const NAMED_CLEAR = 12; // 具名建築（地標範圍）
const POINT_CLEAR = 15;
const SPAWN_ZONE = 12; // 出生點在老虎城外牆 3–8 m 帶（places.js computeSpawn）
const L_BLOCK_KINDS = new Set(['park', 'garden', 'playground', 'pitch', 'grass', 'pedestrian', 'plaza', 'common', 'recreation_ground', 'dog_park']);
const VACANT_RATIO = [0.08, 0.17]; // 空地 /（空地 + 投影），建置輸出的統計

// ---------- 幾何 ----------
const ring = (p) => {
  const out = [];
  for (let i = 0; i < p.length; i += 2) out.push([p[i], p[i + 1]]);
  return out;
};
function signedAreaNorthUp(r) {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const [x1, z1] = r[i];
    const [x2, z2] = r[(i + 1) % r.length];
    a += x1 * -z2 - x2 * -z1;
  }
  return a / 2;
}
function inside(x, z, r) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i];
    const [xj, zj] = r[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
function segDist(x, z, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
  return Math.hypot(x - ax - t * dx, z - az - t * dz);
}
function cross(ax, az, bx, bz, cx, cz, dx, dz) {
  const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
// 線段到多邊形的距離（相交或在內 = 0）
function segPolyDist(ax, az, bx, bz, r) {
  if (inside(ax, az, r) || inside(bx, bz, r)) return 0;
  let d = Infinity;
  for (let i = 0; i < r.length; i++) {
    const [px, pz] = r[i];
    const [qx, qz] = r[(i + 1) % r.length];
    if (cross(ax, az, bx, bz, px, pz, qx, qz)) return 0;
    d = Math.min(d, segDist(px, pz, ax, az, bx, bz), segDist(ax, az, px, pz, qx, qz), segDist(bx, bz, px, pz, qx, qz));
  }
  return d;
}
// 多邊形之間的距離（重疊 = 0）
function polyDist(a, b) {
  if (a.some(([x, z]) => inside(x, z, b)) || b.some(([x, z]) => inside(x, z, a))) return 0;
  let d = Infinity;
  for (let i = 0; i < a.length; i++) {
    const [ax, az] = a[i];
    const [bx, bz] = a[(i + 1) % a.length];
    d = Math.min(d, segPolyDist(ax, az, bx, bz, b));
    if (d === 0) return 0;
  }
  return d;
}
function pointPolyDist(x, z, r) {
  if (inside(x, z, r)) return 0;
  let d = Infinity;
  for (let i = 0; i < r.length; i++) d = Math.min(d, segDist(x, z, r[i][0], r[i][1], r[(i + 1) % r.length][0], r[(i + 1) % r.length][1]));
  return d;
}
const bboxOf = (r, pad = 0) => {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const [x, z] of r) {
    x0 = Math.min(x0, x);
    z0 = Math.min(z0, z);
    x1 = Math.max(x1, x);
    z1 = Math.max(z1, z);
  }
  return { x0: x0 - pad, z0: z0 - pad, x1: x1 + pad, z1: z1 + pad };
};
// 粗網格索引：insert(item, bbox)、query(bbox) → Set
function grid(cell = 40) {
  const m = new Map();
  const keys = (b) => {
    const out = [];
    for (let i = Math.floor(b.x0 / cell); i <= Math.floor(b.x1 / cell); i++) for (let j = Math.floor(b.z0 / cell); j <= Math.floor(b.z1 / cell); j++) out.push(i * 100003 + j);
    return out;
  };
  return {
    insert(item, b) {
      for (const k of keys(b)) {
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(item);
      }
    },
    query(b) {
      const s = new Set();
      for (const k of keys(b)) for (const it of m.get(k) || []) s.add(it);
      return s;
    },
  };
}

// ---------- 欄位與數量 ----------
const osmB = city.B.filter((b) => !b.f);
const inf = city.B.filter((b) => b.f === 1);
check(`填充建築 ${inf.length} 棟（≥ ${MIN_COUNT}）、OSM 建築 ${osmB.length} 棟`, inf.length >= MIN_COUNT && osmB.length > 0);
const firstInf = city.B.findIndex((b) => b.f);
check('填充建築全部排在 OSM 建築之後（OSM 索引不變）', firstInf === osmB.length && city.B.slice(firstInf).every((b) => b.f === 1));
const ids = new Set(city.B.map((b) => b.i));
check('id 不重複、填充建築 id 全為負整數（OSM way id 為正）', ids.size === city.B.length && inf.every((b) => Number.isInteger(b.i) && b.i < 0) && osmB.every((b) => b.i > 0));
const badField = inf.filter((b) => !(b.s === 1 && Number.isInteger(b.l) && b.l >= 2 && b.h > 0 && Math.abs(b.h - b.l * (b.t === 'commercial' ? 4.5 : 3.3)) < 0.06 && typeof b.t === 'string' && !b.n));
check('欄位：s 1（估算）、l 整數樓層、h = l × 層高、無名稱', badField.length === 0, `不符 ${badField.length}`);
const byType = {};
for (const b of inf) byType[b.t] = (byType[b.t] || 0) + 1;
const towers = inf.filter((b) => b.t !== 'commercial' && b.l >= 15);
const houses = inf.filter((b) => b.t === 'house');
const mids = inf.filter((b) => b.t === 'apartments' && b.l >= 6 && b.l <= 12);
check('類型組成：大樓（15–35 層）/ 6–12 層公寓 / 4–5 層透天厝皆有', towers.length > 50 && mids.length > 100 && houses.length > 500 && towers.every((b) => b.l <= 35),
  `${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join('、')}；大樓 ${towers.length}、公寓 ${mids.length}`);
check('透天厝 4–5 層', houses.every((b) => b.l === 4 || b.l === 5));

// ---------- 輪廓 ----------
const B = city.bounds;
const rings = new Map(inf.map((b) => [b, ring(b.p)]));
const badRing = inf.filter((b) => {
  const r = rings.get(b);
  return r.length < 4 || signedAreaNorthUp(r) <= 1 || r.some(([x, z]) => x < B.x0 || x > B.x1 || z < B.z0 || z > B.z1);
});
check('輪廓 ≥ 4 點、逆時針（北方朝上）、面積 > 1 m²、全在 bounds 內', badRing.length === 0, `不符 ${badRing.length}`);
// 透天厝面寬 4–6 m（沿最短邊）、進深 12–18 m
const dims = (r) => {
  const e = r.map(([x, z], i) => Math.hypot(r[(i + 1) % r.length][0] - x, r[(i + 1) % r.length][1] - z)).sort((a, b) => a - b);
  return [e[0], e[e.length - 1]];
};
const badHouse = houses.filter((b) => {
  const [w, d] = dims(rings.get(b));
  return w < 4 - 0.15 - 0.2 || w > 6 + 0.2 || d < 12 - 0.2 || d > 18 + 0.2;
});
check('透天厝面寬 4–6 m、進深 12–18 m', badHouse.length === 0, `不符 ${badHouse.length}`);

// ---------- 不壓障礙 ----------
const infGrid = grid();
for (const b of inf) infGrid.insert(b, bboxOf(rings.get(b)));
function nearInf(bbox) {
  return infGrid.query(bbox);
}
let roadHits = 0;
let roadMin = Infinity;
for (const r of city.R) {
  if (r.u) continue;
  const clear = r.w / 2 + (PED_ROAD_TYPES.has(r.t) ? PED_CLEAR : OTHER_ROAD_CLEAR) - TOL;
  const pts = ring(r.p);
  for (let k = 0; k < pts.length - 1; k++) {
    const [ax, az] = pts[k];
    const [bx, bz] = pts[k + 1];
    for (const b of nearInf(bboxOf([pts[k], pts[k + 1]], clear))) {
      const d = segPolyDist(ax, az, bx, bz, rings.get(b)) - r.w / 2;
      roadMin = Math.min(roadMin, d);
      if (d + r.w / 2 < clear) roadHits++;
    }
  }
}
check(`不壓道路：離路緣 ≥ 人行道 ${PED_CLEAR} m（service / link ${OTHER_ROAD_CLEAR} m）`, roadHits === 0, `違規 ${roadHits}、最近離路緣 ${roadMin.toFixed(2)} m`);
let footHits = 0;
for (const f of city.F) {
  if (f.u) continue;
  const clear = f.w / 2 + FOOT_CLEAR - TOL;
  const pts = ring(f.p);
  for (let k = 0; k < pts.length - 1; k++) {
    for (const b of nearInf(bboxOf([pts[k], pts[k + 1]], clear))) if (segPolyDist(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1], rings.get(b)) < clear) footHits++;
  }
}
check(`不壓步道（離中心線 ≥ 半寬 + ${FOOT_CLEAR} m）`, footHits === 0, `違規 ${footHits}`);
const areaCheck = (label, polys, clear) => {
  let hits = 0;
  for (const p of polys) {
    const r = ring(p);
    for (const b of nearInf(bboxOf(r, clear))) if (polyDist(rings.get(b), r) < clear - TOL) hits++;
  }
  check(`不壓 ${label}（間距 ≥ ${clear} m）`, hits === 0, `${polys.length} 個面，違規 ${hits}`);
};
areaCheck('公園 P', city.P.map((p) => p.p), AREA_CLEAR);
areaCheck('水域 W', city.W.map((w) => w.p), AREA_CLEAR);
areaCheck('綠地 / 廣場（L）', city.L.filter((l) => L_BLOCK_KINDS.has(l.k)).map((l) => l.p), AREA_CLEAR);
areaCheck('秋紅谷外框 / 下沉廣場', [...city.T.basins.map((b) => b.p), ...city.T.plazas.map((q) => q.p)], AREA_CLEAR);
areaCheck('OSM 建築（外擴 3 m）', osmB.map((b) => b.p), OSM_CLEAR);
areaCheck('具名 OSM 建築 / 地標（外擴 12 m）', osmB.filter((b) => b.n).map((b) => b.p), NAMED_CLEAR);

// 填充建築彼此：不重疊；唯一例外是裙樓（commercial）上的塔樓，輪廓完全落在裙樓內且比裙樓高
let overlap = 0;
let stacked = 0;
for (const a of inf) {
  const ra = rings.get(a);
  for (const b of nearInf(bboxOf(ra))) {
    if (b.i >= a.i) continue;
    const rb = rings.get(b);
    if (polyDist(ra, rb) > 0.05) continue;
    const [podium, tower] = a.t === 'commercial' ? [a, b] : [b, a];
    const contained = podium.t === 'commercial' && tower.t !== 'commercial' && tower.h > podium.h && rings.get(tower).every(([x, z]) => inside(x, z, rings.get(podium)));
    if (contained) stacked++;
    else overlap++;
  }
}
check('填充建築彼此不重疊（裙樓上的塔樓除外，間距 > 0.05 m）', overlap === 0, `重疊 ${overlap}、裙樓 + 塔樓 ${stacked} 組`);

// ---------- 遊戲點位 ----------
const points = [
  { name: POLICE_STATION.name, ...POLICE_STATION },
  { name: HOSPITAL.name, ...HOSPITAL },
  ...SPRAY_SHOPS,
  ...FOOD_SPOTS.map((f) => ({ name: `小吃 ${f.id}`, x: f.x, z: f.z })),
  { name: '夜市取餐點', ...NIGHT_MARKET_DELIVERY.pickup },
  ...VALET_SITES.flatMap((v) => [{ name: `泊車亭 ${v.id}`, ...v.stand }, { name: `泊車客人車 ${v.id}`, ...v.car }, { name: `泊車車格 ${v.id}`, ...v.slot }]),
];
const blockedPts = [];
for (const p of points) {
  for (const b of nearInf({ x0: p.x - POINT_CLEAR, z0: p.z - POINT_CLEAR, x1: p.x + POINT_CLEAR, z1: p.z + POINT_CLEAR })) {
    if (pointPolyDist(p.x, p.z, rings.get(b)) < POINT_CLEAR - TOL) blockedPts.push(`${p.name}↔${b.i}`);
  }
}
check(`重生點 / 噴漆廠 / 小吃點 / 夜市取餐點 / 泊車亭 ${points.length} 處周圍 ${POINT_CLEAR} m 內無填充建築`, blockedPts.length === 0, blockedPts.slice(0, 5).join('、'));
// 出生點（places.js computeSpawn：老虎城外牆 3–8 m、河南路三段側）：老虎城輪廓外 SPAWN_ZONE 內無填充建築
const tiger = osmB.find((b) => b.i === TIGER_CITY_ID);
const tr = tiger ? ring(tiger.p) : null;
const spawnHits = tr ? [...nearInf(bboxOf(tr, SPAWN_ZONE))].filter((b) => polyDist(rings.get(b), tr) < SPAWN_ZONE) : [];
check(`出生點一帶：老虎城外牆 ${SPAWN_ZONE} m 內無填充建築`, !!tr && spawnHits.length === 0, `違規 ${spawnHits.length}`);
// 地標 / 光柱點（public/models/manifest.json 錨點，任務起訖與打卡都用它）：不在填充建築內、離輪廓 ≥ 5 m
const manifestPath = resolve(ROOT, 'public/models/manifest.json');
if (existsSync(manifestPath)) {
  const lm = landmarkPoints(JSON.parse(readFileSync(manifestPath, 'utf8')));
  const bad = [];
  for (const p of lm) for (const b of nearInf({ x0: p.x - 5, z0: p.z - 5, x1: p.x + 5, z1: p.z + 5 })) if (pointPolyDist(p.x, p.z, rings.get(b)) < 5) bad.push(`${p.slug}↔${b.i}`);
  check(`地標 / 光柱點 ${lm.length} 處不被填充建築覆蓋（離輪廓 ≥ 5 m）`, lm.length > 0 && bad.length === 0, bad.join('、'));
} else {
  console.log('SKIP  地標 / 光柱點：public/models/manifest.json 不存在（具名 OSM 建築外擴 12 m 已涵蓋地標輪廓）');
}

// ---------- 可重現 ----------
const tmp = mkdtempSync(join(tmpdir(), 'p8b-infill-'));
const outs = [];
let log = '';
for (let k = 0; k < 2; k++) {
  const out = join(tmp, `city-${k}.json`);
  const r = spawnSync(process.execPath, [resolve(ROOT, 'tools/build-city.mjs')], { cwd: ROOT, env: { ...process.env, CITY_OUT: out }, encoding: 'utf8' });
  if (r.status === 0) outs.push(readFileSync(out, 'utf8'));
  else outs.push(null);
  log = r.stdout || '';
}
rmSync(tmp, { recursive: true, force: true });
check('同一種子兩次產出完全相同', outs[0] !== null && outs[0] === outs[1], `${outs[0] ? (outs[0].length / 1024).toFixed(1) : '-'} KB`);
check('repo 內 src/data/osm-city.json = 建置輸出（未手改、已重新產生）', outs[0] === readFileSync(CITY, 'utf8'));
const m = /空地 \/（空地 \+ 投影）([\d.]+)%/.exec(log);
const ratio = m ? Number(m[1]) / 100 : NaN;
check(`留空地塊（停車場 / 工地）比例 ${VACANT_RATIO[0] * 100}–${VACANT_RATIO[1] * 100}%`, ratio >= VACANT_RATIO[0] && ratio <= VACANT_RATIO[1], `${(ratio * 100).toFixed(1)}%`);

console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
