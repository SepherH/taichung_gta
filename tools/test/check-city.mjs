#!/usr/bin/env node
// osm-city.json 無頭檢查（純 Node）：筆數、多邊形方向、地標、秋紅谷 / 下沉廣場地形特徵、座標範圍
// 用法：node tools/test/check-city.mjs（任一項不符 exit 1）
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const city = JSON.parse(readFileSync(resolve(ROOT, 'src/data/osm-city.json'), 'utf8'));

const CLIP_MARGIN = 60; // 與 tools/build-city.mjs 相同
const CITY_HALL_WAY = 222413435;
const COUNCIL_WAY = 222636758;
const ORIGIN_WAY = 150999799;
const CULVERT_WAY = 617359972;
const MRT_NAME = '市政府站';
const MAIN_ROADS = ['臺灣大道', '河南路', '朝富路', '市政北七路', '惠來路'];
const MAIN_ROAD_MIN_LENGTH = 300; // 每條主要道路在範圍內至少要有的車道長度（m）
const ORIGIN_TOL = 1; // 老虎城輪廓重心離原點的容差（m）
// 面積量級：秋紅谷約 3 公頃、湖面約 1 公頃（reference §6.1），容許同一數量級內
const BASIN_AREA = [15000, 60000];
const LAKE_AREA = [3000, 30000];
const SIDES = new Set(['W', 'N', 'E', 'S']);
const KINDS = new Set(['grass_slope', 'ramp', 'terrace', 'flat']);

let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${msg}`);
  if (!ok) failed++;
};

const unflat = (p) => {
  const out = [];
  for (let i = 0; i < p.length; i += 2) out.push([p[i], p[i + 1]]);
  return out;
};
// 以 (x, 北=-z) 計算的有號面積：> 0 為逆時針
function signedArea(ring) {
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
const round = (v) => Math.round(v * 10) / 10;

// ---------- 版本與筆數 ----------
check(city.v === 2, `版本 v = ${city.v}`);
for (const k of ['B', 'R', 'F', 'P', 'W', 'L']) check(Array.isArray(city[k]) && city[k].length > 0, `${k} ${city[k]?.length} 筆`);
const T = city.T || {};
check(Array.isArray(T.basins) && T.basins.length >= 1, `T.basins ${T.basins?.length} 筆`);
check(Array.isArray(T.plazas) && T.plazas.length >= 1, `T.plazas ${T.plazas?.length} 筆`);
check(typeof T.note === 'string' && T.note.length > 0, 'T.note 存在');

// ---------- 多邊形：逆時針、無重複收尾 / 相鄰重複點 ----------
const polygons = [];
for (const k of ['B', 'P', 'W', 'L']) for (const o of city[k]) polygons.push({ tag: `${k} ${o.i}`, p: o.p });
for (const b of T.basins) {
  polygons.push({ tag: `T.basin ${b.i}`, p: b.p });
  if (b.lake) polygons.push({ tag: `T.basin ${b.i} lake`, p: b.lake });
  b.exclude.forEach((p, k) => polygons.push({ tag: `T.basin ${b.i} exclude ${k}`, p }));
}
for (const pl of T.plazas) polygons.push({ tag: `T.plaza ${pl.n}`, p: pl.p });
const badPoly = [];
for (const { tag, p } of polygons) {
  const ring = unflat(p);
  const dupClose = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const dupAdj = ring.some((q, i) => i > 0 && q[0] === ring[i - 1][0] && q[1] === ring[i - 1][1]);
  if (ring.length < 3 || p.length % 2 || signedArea(ring) <= 0 || dupClose || dupAdj) badPoly.push(tag);
}
check(badPoly.length === 0, `多邊形 ${polygons.length} 個皆逆時針且無重複收尾點${badPoly.length ? '；不符：' + badPoly.slice(0, 5).join('、') : ''}`);

// ---------- 地標（輪廓須完整落在 bounds 內，不靠外擴容差） ----------
const bd = city.bounds;
const insideStrict = (p) => unflat(p).every(([x, z]) => x >= bd.x0 && x <= bd.x1 && z >= bd.z0 && z <= bd.z1);
for (const [id, label] of [[CITY_HALL_WAY, '臺中市政府'], [COUNCIL_WAY, '臺中市議會']]) {
  const b = city.B.find((o) => o.i === id);
  const ring = b ? unflat(b.p) : null;
  check(!!b && insideStrict(b.p), `${label} ${id} 在 B 且完整在 bounds 內：${b ? `${ring.length} 頂點、${Math.round(signedArea(ring))} m²、高 ${b.h} m` : '缺'}`);
}
const mrt = city.B.filter((b) => (b.n || '').includes(MRT_NAME));
check(mrt.length > 0 && mrt.every((b) => insideStrict(b.p)), `捷運市政府站 ${mrt.length} 筆：${mrt.map((b) => `${b.i} @ (${centroid(unflat(b.p)).map(round).join(', ')})`).join('；')}`);
const tiger = city.B.find((b) => b.i === ORIGIN_WAY);
const tc = tiger ? centroid(unflat(tiger.p)) : [Infinity, Infinity];
check(Math.hypot(...tc) <= ORIGIN_TOL, `老虎城輪廓中心 (${tc.map((v) => v.toFixed(2)).join(', ')})，距原點 ${Math.hypot(...tc).toFixed(2)} m`);
check(!city.W.some((w) => w.i === CULVERT_WAY), `惠來溪涵管 ${CULVERT_WAY} 不在 W`);

// ---------- 主要道路 ----------
const lineLength = (p) => {
  let s = 0;
  for (let i = 2; i < p.length; i += 2) s += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return s;
};
for (const n of MAIN_ROADS) {
  const len = city.R.filter((r) => (r.n || '').includes(n)).reduce((s, r) => s + lineLength(r.p), 0);
  check(len >= MAIN_ROAD_MIN_LENGTH, `主要道路 ${n} 車道總長 ${Math.round(len)} m`);
}

// ---------- 秋紅谷 ----------
const basin = T.basins.find((b) => (b.n || '').includes('秋紅谷'));
check(!!basin, `秋紅谷 basin ${basin?.i}`);
if (basin) {
  const ring = unflat(basin.p);
  const area = signedArea(ring);
  check(area >= BASIN_AREA[0] && area <= BASIN_AREA[1], `秋紅谷外框面積 ${Math.round(area)} m²（${(area / 10000).toFixed(2)} ha）`);
  const lake = basin.lake ? unflat(basin.lake) : null;
  const lakeArea = lake ? signedArea(lake) : 0;
  check(!!lake && lakeArea >= LAKE_AREA[0] && lakeArea <= LAKE_AREA[1], `湖面面積 ${Math.round(lakeArea)} m²（${(lakeArea / 10000).toFixed(2)} ha，way ${basin.li}）`);
  check(!!lake && lake.every(([x, z]) => pointInRing(x, z, ring) || ring.some((q) => Math.hypot(q[0] - x, q[1] - z) < 1)), '湖面位於秋紅谷外框內');
  const parkingIdx = (basin.xi || []).findIndex((x) => x.i === 336765602);
  const parking = parkingIdx >= 0 ? unflat(basin.exclude[parkingIdx]) : null;
  check(!!parking, `停車場 336765602 在 exclude：${parking ? Math.round(signedArea(parking)) + ' m²' + (basin.xi[parkingIdx].est ? '（est）' : '') : '缺'}`);
  const edgesOk = basin.edges.length === ring.length && basin.edges.every((e, k) => e.a === k && e.b === (k + 1) % ring.length && SIDES.has(e.side) && KINDS.has(e.kind) && e.width > 0 && e.est === 1);
  check(edgesOk, `邊坡 ${basin.edges.length} 條：${basin.edges.map((e) => `${e.a}-${e.b} ${e.side}/${e.kind}/${e.width}`).join('；')}`);
  const lv = basin.levels;
  check(lv && lv.road === 0 && lv.lakebed < lv.water && lv.water < lv.walkway && lv.walkway < lv.road && lv.est === 1, `levels ${JSON.stringify(lv)}`);
  const need = ['ramp_start', 'terrace_line', 'red_bridge', 'zigzag_walk', 'pavilion'];
  const have = new Set(basin.features.map((f) => f.k));
  check(need.every((k) => have.has(k)), `features：${basin.features.map((f) => `${f.k}${f.est ? '(est)' : ''}`).join('、')}`);
  const inBasin = basin.features.filter((f) => f.k !== 'terrace_line').every((f) => unflat(f.p).every(([x, z]) => pointInRing(x, z, ring)));
  check(inBasin, 'features 點位（除階梯平台線）皆在秋紅谷外框內');
  const onLake = basin.features.filter((f) => f.k === 'zigzag_walk').every((f) => unflat(f.p).slice(1).every(([x, z]) => pointInRing(x, z, lake)));
  check(onLake, 'Z 字步道折點位於湖面內');
}

// ---------- 下沉廣場 ----------
for (const pl of T.plazas) {
  const ring = unflat(pl.p);
  const ok = pl.depth < 0 && Array.isArray(pl.stairs) && pl.stairs.every((k) => Number.isInteger(k) && k >= 0 && k < ring.length);
  check(ok, `${pl.n}：${Math.round(signedArea(ring))} m²、depth ${pl.depth}、stairs ${JSON.stringify(pl.stairs)}、est ${pl.est}、i ${pl.i}`);
}

// ---------- 座標範圍 ----------
let coords = 0;
const outside = [];
const scan = (tag, p) => {
  for (let i = 0; i < p.length; i += 2) {
    coords++;
    const [x, z] = [p[i], p[i + 1]];
    if (x < bd.x0 - CLIP_MARGIN || x > bd.x1 + CLIP_MARGIN || z < bd.z0 - CLIP_MARGIN || z > bd.z1 + CLIP_MARGIN) {
      outside.push(tag);
      return;
    }
  }
};
for (const k of ['B', 'R', 'F', 'P', 'W', 'L']) for (const o of city[k]) scan(`${k} ${o.i}`, o.p);
for (const { tag, p } of polygons.filter((q) => q.tag.startsWith('T.'))) scan(tag, p);
for (const b of T.basins) for (const f of b.features) scan(`T.feature ${f.k}`, f.p);
check(outside.length === 0, `座標 ${coords} 個皆在 bounds ±${CLIP_MARGIN} m 內${outside.length ? '；超出：' + outside.slice(0, 5).join('、') : ''}`);

console.log(failed ? `\n${failed} 項不符` : '\n全部通過');
process.exit(failed ? 1 : 0);
