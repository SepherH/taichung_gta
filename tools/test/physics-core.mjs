// D2c1 物理核心無頭驗證：node tools/test/physics-core.mjs [--no-rapier]
// --no-rapier：只跑不需要 rapier 的純邏輯（群組矩陣、凸分解、patch→heightfield 索引換算、矩形差集、
//              湖面通道差集、walkable 細分、固定步累加器、插值、事件路由、手感參數推導），以 mock 物件代替 rapier
// 完整版：另外真的 import rapier 建世界、跑角色與查詢
// exit code：0 = 全過；1 = 有斷言失敗；2 = 找不到 rapier 執行檔（完整版才會）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as G from '../../src/physics/groups.js';
import { convexDecompose, isConvex, signedAreaFlat, cleanPolygon, subtractConvex } from '../../src/physics/decompose.js';
import { FixedStepper, InterpolatedBody, PhysicsWorld, initPhysics } from '../../src/physics/world.js';
import { patchToHeightfield, patchRect, rectDifference, groundTiles, lakeBlockPieces, walkableMesh, buildWorldColliders, buildingPieces } from '../../src/physics/colliders.js';
import * as CH from '../../src/physics/character.js';
import { pointInPolygon, closestOnPolygon, polygonBBox } from '../../src/geom.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NO_RAPIER = process.argv.includes('--no-rapier');
const osm = JSON.parse(readFileSync(join(ROOT, 'src/data/osm-city.json'), 'utf8'));

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const fmt = (v, d = 4) => (typeof v === 'number' ? v.toFixed(d) : String(v));

// 可重現亂數
let seed = 12345;
function rand() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}

// ======================= 純邏輯（不需要 rapier）=======================

// ---------- 群組 ----------
{
  const names = ['WORLD', 'PLAYER', 'VEHICLE', 'NPC_CAR', 'PEDESTRIAN', 'SENSOR', 'DEBRIS'];
  const bits = names.map((n) => G[n]);
  check('groups：7 組位元互不重疊且各為單一位元', new Set(bits).size === 7 && bits.every((b) => b > 0 && (b & (b - 1)) === 0));
  let sym = true;
  for (const a of names) for (const b of names) if (G.canInteract(G.GROUPS[a], G.GROUPS[b]) !== G.canInteract(G.GROUPS[b], G.GROUPS[a])) sym = false;
  check('groups：碰撞矩陣對稱', sym);
  const ci = (a, b) => G.canInteract(G.GROUPS[a], G.GROUPS[b]);
  check('groups：PEDESTRIAN↔VEHICLE / NPC_CAR 會碰', ci('PEDESTRIAN', 'VEHICLE') && ci('PEDESTRIAN', 'NPC_CAR'));
  check('groups：SENSOR 不碰 WORLD / SENSOR，會偵測 PLAYER', !ci('SENSOR', 'WORLD') && !ci('SENSOR', 'SENSOR') && ci('SENSOR', 'PLAYER'));
  check('groups：PLAYER 碰 WORLD、不碰 DEBRIS', ci('PLAYER', 'WORLD') && !ci('PLAYER', 'DEBRIS'));
  check('groups：queryGroups(WORLD) 只命中 WORLD', G.canInteract(G.queryGroups(G.WORLD), G.GROUPS.WORLD) && !G.canInteract(G.queryGroups(G.WORLD), G.GROUPS.VEHICLE));
  console.log('      數值：' + names.map((n) => `${n}=0x${G[n].toString(16)} groups=0x${G.GROUPS[n].toString(16).padStart(8, '0')}`).join(' '));
}

// ---------- 凸分解 ----------
{
  // 合成：L 形 + 重複點 + 共線點（OSM 方向，有號面積為負）
  const L = [0, 0, 0, 0, 10, 0, 10, 4, 4, 4, 4, 7, 4, 10, 0, 10, 0, 5];
  const pl = convexDecompose(L);
  const aL = pl.reduce((s, p) => s + signedAreaFlat(p), 0);
  check('decompose：L 形（含重複 / 共線點）→ 2 塊凸、面積 64', pl.length === 2 && pl.every(isConvex) && Math.abs(aL - 64) < 1e-9, `塊數 ${pl.length} 面積 ${fmt(aL)}`);
  check('decompose：極小面積 / 退化輸入 → 空陣列', convexDecompose([0, 0, 1, 0, 2, 0]).length === 0 && convexDecompose([0, 0, 1e-3, 0, 0, 1e-3]).length === 0);
  // 梳子形（多凹口）
  const comb = [0, 0, 10, 0, 10, 6, 8, 6, 8, 2, 6, 2, 6, 6, 4, 6, 4, 2, 2, 2, 2, 6, 0, 6];
  const pc = convexDecompose(comb);
  check('decompose：梳子形全凸且面積守恆', pc.every(isConvex) && Math.abs(pc.reduce((s, p) => s + signedAreaFlat(p), 0) - Math.abs(signedAreaFlat(comb))) < 1e-9, `塊數 ${pc.length}`);

  let pieces = 0;
  let nonConvex = 0;
  let maxRel = 0;
  let concave = 0;
  for (const b of osm.B) {
    const ps = convexDecompose(b.p);
    pieces += ps.length;
    for (const p of ps) if (!isConvex(p)) nonConvex++;
    const A = Math.abs(signedAreaFlat(b.p));
    const s = ps.reduce((acc, p) => acc + signedAreaFlat(p), 0);
    maxRel = Math.max(maxRel, Math.abs(s - A) / A);
    if (!isConvex(cleanPolygon(b.p))) concave++;
  }
  check(`decompose：osm 建築 ${osm.B.length} 棟 → ${pieces} 凸塊，全部凸`, nonConvex === 0, `非凸 ${nonConvex}`);
  check('decompose：每棟面積差 < 0.5%', maxRel < 0.005, `最大相對誤差 ${maxRel.toExponential(2)}，凹多邊形 ${concave} 棟`);

  // 長條切短（buildingPieces）：全凸、面積守恆、外框 ≤ 20 m；建築 148849083 的斜向長條被切開
  let spanPieces = 0;
  let spanBad = 0;
  let spanRel = 0;
  let spanMax = 0;
  for (const b of osm.B) {
    const ps = buildingPieces(b.p);
    spanPieces += ps.length;
    for (const p of ps) {
      if (!isConvex(p)) spanBad++;
      const bb = polygonBBox(p);
      spanMax = Math.max(spanMax, bb.x1 - bb.x0, bb.z1 - bb.z0);
    }
    const A = convexDecompose(b.p).reduce((acc, p) => acc + signedAreaFlat(p), 0);
    spanRel = Math.max(spanRel, Math.abs(ps.reduce((acc, p) => acc + signedAreaFlat(p), 0) - A) / A);
  }
  check('decompose：長條凸塊切短後全凸、面積守恆、外框 ≤ 20 m', spanBad === 0 && spanRel < 1e-9 && spanMax <= 20 + 1e-9, `${spanPieces} 塊、非凸 ${spanBad}、面積相對誤差 ${spanRel.toExponential(2)}、最大外框 ${fmt(spanMax, 2)} m`);

  // 凹口內部點不在任何凸塊內（純幾何版；完整版另以 castRay 驗證）
  const notch = findNotchBuildings(3);
  let ok = notch.length === 3;
  for (const n of notch) {
    const ps = convexDecompose(n.b.p);
    if (ps.some((p) => pointInPolygon(n.x, n.z, p))) ok = false;
  }
  check('decompose：3 棟凹多邊形建築的凹口點不在任何凸塊內', ok, notch.map((n) => `${n.b.i}@(${fmt(n.x, 1)},${fmt(n.z, 1)})`).join(' '));
}

// 凸包（Andrew monotone chain），只供測試找凹口
function hull(flat) {
  const pts = [];
  for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [];
  for (const p of pts) {
    while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop();
    lo.push(p);
  }
  const up = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop();
    up.push(p);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1)).flat();
}

// 找凹口明顯的建築：凹口點 = 在凸包內、在輪廓外、離輪廓 ≥ 1 m、不在任何其他建築內
function findNotchBuildings(count) {
  const out = [];
  const cp = {};
  for (const b of osm.B) {
    if (out.length >= count) break;
    const c = cleanPolygon(b.p);
    if (!c || isConvex(c)) continue;
    const H = hull(b.p);
    const bb = polygonBBox(b.p);
    let found = null;
    for (let gx = bb.x0; gx <= bb.x1 && !found; gx += 0.5) {
      for (let gz = bb.z0; gz <= bb.z1 && !found; gz += 0.5) {
        if (!pointInPolygon(gx, gz, H) || pointInPolygon(gx, gz, b.p)) continue;
        closestOnPolygon(gx, gz, b.p, cp);
        if (cp.d2 < 1) continue;
        if (osm.B.some((o) => pointInPolygon(gx, gz, o.p))) continue;
        found = { b, x: gx, z: gz };
      }
    }
    if (found) out.push(found);
  }
  return out;
}

// ---------- patch → heightfield 索引 / scale 換算（mock RAPIER）----------
function mockHfRapier() {
  const calls = [];
  const desc = {
    t: null,
    setTranslation(x, y, z) {
      this.t = { x, y, z };
      return this;
    },
  };
  return {
    calls,
    ColliderDesc: {
      heightfield(nrows, ncols, heights, scale, flags) {
        calls.push({ nrows, ncols, heights, scale, flags });
        return desc;
      },
    },
    HeightFieldFlags: { FIX_INTERNAL_EDGES: 1 },
  };
}

// 依 Rapier（parry3d）慣例取樣 heightfield：列 i 沿 z、行 j 沿 x、column-major、原點置中；格內雙線性（與 mock 相同插值）
function sampleRapierHF(hf, wx, wz) {
  const { nrows, ncols, heights, scale, center } = hf;
  const u = (wx - center.x + scale.x / 2) / (scale.x / ncols);
  const v = (wz - center.z + scale.z / 2) / (scale.z / nrows);
  const j = Math.min(ncols - 1, Math.max(0, Math.floor(u)));
  const i = Math.min(nrows - 1, Math.max(0, Math.floor(v)));
  const fu = u - j;
  const fv = v - i;
  const H = (ii, jj) => heights[jj * (nrows + 1) + ii] * scale.y;
  return H(i, j) * (1 - fu) * (1 - fv) + H(i, j + 1) * fu * (1 - fv) + H(i + 1, j) * (1 - fu) * fv + H(i + 1, j + 1) * fu * fv;
}

// terrain 契約的 patch 取樣：heights[row * cols + col]，雙線性
function samplePatch(p, x, z) {
  const u = (x - p.x0) / p.cell;
  const v = (z - p.z0) / p.cell;
  const c = Math.min(p.cols - 2, Math.max(0, Math.floor(u)));
  const r = Math.min(p.rows - 2, Math.max(0, Math.floor(v)));
  const fu = u - c;
  const fv = v - r;
  const H = (rr, cc) => p.heights[rr * p.cols + cc];
  return H(r, c) * (1 - fu) * (1 - fv) + H(r, c + 1) * fu * (1 - fv) + H(r + 1, c) * (1 - fu) * fv + H(r + 1, c + 1) * fu * fv;
}

{
  // 非正方、非對稱 patch：行列若轉置錯誤一定會被抓到
  const cols = 41;
  const rows = 23;
  const p = { id: 'asym', kind: 'test', x0: 100, z0: -50, cell: 1.5, cols, rows, heights: new Float32Array(cols * rows) };
  for (let r = 1; r < rows - 1; r++) for (let c = 1; c < cols - 1; c++) p.heights[r * cols + c] = -(0.3 * c + 0.07 * r * r) / 10;
  const R = mockHfRapier();
  const hf = patchToHeightfield(R, p);
  const call = R.calls[0];
  check(
    'heightfield：nrows = rows−1、ncols = cols−1、heights 長度 (nrows+1)(ncols+1)',
    call.nrows === rows - 1 && call.ncols === cols - 1 && call.heights.length === rows * cols,
    `nrows ${call.nrows} ncols ${call.ncols} len ${call.heights.length}`,
  );
  check('heightfield：scale = ((cols−1)·cell, 1, (rows−1)·cell)', call.scale.x === 60 && call.scale.y === 1 && call.scale.z === 33);
  check('heightfield：平移到 patch 中心', hf.desc.t.x === 130 && hf.desc.t.z === -33.5 && hf.desc.t.y === 0, JSON.stringify(hf.desc.t));
  let maxGrid = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) maxGrid = Math.max(maxGrid, Math.abs(sampleRapierHF(hf, p.x0 + c * p.cell, p.z0 + r * p.cell) - p.heights[r * cols + c]));
  let maxRand = 0;
  for (let k = 0; k < 3000; k++) {
    const x = p.x0 + rand() * 60;
    const z = p.z0 + rand() * 33;
    maxRand = Math.max(maxRand, Math.abs(sampleRapierHF(hf, x, z) - samplePatch(p, x, z)));
  }
  check('heightfield：格點與 3000 隨機點依 Rapier 慣例取樣 = terrain 取樣', maxGrid < 1e-6 && maxRand < 1e-5, `格點最大差 ${maxGrid.toExponential(2)} 隨機最大差 ${maxRand.toExponential(2)}`);
}

// ---------- 平地矩形差集 ----------
{
  const b = osm.bounds;
  const holes = [
    { x0: 16.9 - 30, z0: -500, x1: 300, z1: -180 }, // 類秋紅谷
    { x0: 250, z0: -250, x1: 400, z1: -100 }, // 與上一個重疊
    { x0: b.x1 - 50, z0: 0, x1: b.x1 + 80, z1: 100 }, // 超出 bounds
    { x0: -100, z0: 300, x1: -40, z1: 360 },
  ];
  const rects = rectDifference({ x0: b.x0, z0: b.z0, x1: b.x1, z1: b.z1 }, holes);
  let overlap = 0;
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const c = rects[j];
      if (Math.min(a.x1, c.x1) - Math.max(a.x0, c.x0) > 1e-9 && Math.min(a.z1, c.z1) - Math.max(a.z0, c.z0) > 1e-9) overlap++;
    }
  let bad = 0;
  for (let k = 0; k < 20000; k++) {
    const x = b.x0 + rand() * (b.x1 - b.x0);
    const z = b.z0 + rand() * (b.z1 - b.z0);
    const inHole = holes.some((h) => x > h.x0 && x < h.x1 && z > h.z0 && z < h.z1);
    const n = rects.filter((r) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1).length;
    if (inHole ? n !== 0 : n !== 1) bad++;
  }
  check(`ground：bounds − 4 個 patch 矩形 → ${rects.length} 個 cuboid，互不重疊`, overlap === 0, `重疊對 ${overlap}`);
  check('ground：20000 隨機點恰被 1 個 cuboid 或 patch 覆蓋（無縫）', bad === 0, `錯誤點 ${bad}`);
  const one = rectDifference({ x0: b.x0, z0: b.z0, x1: b.x1, z1: b.z1 }, [patchRect({ x0: 0, z0: 0, cell: 1, cols: 61, rows: 61 })]);
  check('ground：單一內部 patch → 4 個 cuboid', one.length === 4, `${one.length}`);
  // 切塊：每個差集矩形切成邊長 ≤ 64 m 的方塊，面積守恆、方塊互不重疊（同一矩形內等分）
  const tiles = rects.map((r) => ({ r, t: groundTiles(r) }));
  let maxSpan = 0;
  let areaErr = 0;
  let tOverlap = 0;
  for (const { r, t } of tiles) {
    let a = 0;
    for (const q of t) {
      maxSpan = Math.max(maxSpan, q.x1 - q.x0, q.z1 - q.z0);
      a += (q.x1 - q.x0) * (q.z1 - q.z0);
    }
    areaErr = Math.max(areaErr, Math.abs(a - (r.x1 - r.x0) * (r.z1 - r.z0)) / ((r.x1 - r.x0) * (r.z1 - r.z0)));
    for (let i = 0; i < t.length; i++)
      for (let j = i + 1; j < t.length; j++) if (Math.min(t[i].x1, t[j].x1) - Math.max(t[i].x0, t[j].x0) > 1e-9 && Math.min(t[i].z1, t[j].z1) - Math.max(t[i].z0, t[j].z0) > 1e-9) tOverlap++;
  }
  const nTiles = tiles.reduce((s, x) => s + x.t.length, 0);
  check('ground：差集矩形切成 ≤ 64 m 方塊（面積守恆、不重疊）', maxSpan <= 64 + 1e-9 && areaErr < 1e-9 && tOverlap === 0, `${rects.length} 矩形 → ${nTiles} 塊、最大邊 ${fmt(maxSpan, 2)} m、面積相對誤差 ${areaErr.toExponential(1)}、重疊 ${tOverlap}`);
}

// ---------- 湖面阻擋柱通道 ----------
{
  // 凹湖（U 形）+ 一條橫越的 walkable（寬 2 m）
  const lake = [0, 0, 30, 0, 30, 30, 20, 30, 20, 12, 10, 12, 10, 30, 0, 30];
  const plank = { id: 'plank', kind: 'bridge', poly: [-5, 5, 35, 5, 35, 7, -5, 7], heightAt: () => 0.25 };
  const pieces = lakeBlockPieces(lake, [plank]);
  const area = pieces.reduce((s, p) => s + signedAreaFlat(p), 0);
  const expect = Math.abs(signedAreaFlat(lake)) - 30 * 2.2; // 通道寬 2 + 0.2，全落在湖的矩形下半部
  check('lake：通道差集後凸塊全凸', pieces.every(isConvex), `塊數 ${pieces.length}`);
  check('lake：面積 = 湖 − 通道（寬 walkable + 0.2）', Math.abs(area - expect) < 1e-6, `面積 ${fmt(area)} 期望 ${fmt(expect)}`);
  const inAny = (x, z) => pieces.some((p) => pointInPolygon(x, z, p));
  check('lake：通道內點（含邊緣 0.05 m）不被阻擋、通道外湖面被阻擋', !inAny(15, 6) && !inAny(15, 4.95) && !inAny(15, 7.05) && inAny(15, 2) && inAny(25, 20) && !inAny(15, 20));
  let ovl = 0;
  for (let k = 0; k < 5000; k++) {
    const x = rand() * 30;
    const z = rand() * 30;
    if (pieces.filter((p) => pointInPolygon(x, z, p)).length > 1) ovl++;
  }
  check('lake：凸塊互不重疊（5000 點）', ovl === 0);
  const d = subtractConvex([0, 0, 4, 0, 4, 4, 0, 4], [10, 10, 11, 10, 11, 11, 10, 11]);
  check('lake：不相交的差集保留原凸塊', d.length === 1 && Math.abs(signedAreaFlat(d[0]) - 16) < 1e-9);
}

// ---------- walkable 細分 trimesh ----------
{
  const w = { id: 'w', kind: 'stairs', poly: [0, 0, 0, 10, 6, 10, 6, 0], heightAt: (x, z) => -6 + 0.6 * z };
  const m = walkableMesh(w);
  let maxDy = 0;
  for (let i = 0; i < m.vertices.length; i += 3) maxDy = Math.max(maxDy, Math.abs(m.vertices[i + 1] - w.heightAt(m.vertices[i], m.vertices[i + 2])));
  let area = 0;
  let up = true;
  let maxEdge = 0;
  const V = (k) => [m.vertices[k * 3], m.vertices[k * 3 + 1], m.vertices[k * 3 + 2]];
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [V(m.indices[t]), V(m.indices[t + 1]), V(m.indices[t + 2])];
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const ny = uz * vx - ux * vz;
    if (ny <= 0) up = false;
    area += Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])) / 2;
    maxEdge = Math.max(maxEdge, Math.hypot(ux, uz), Math.hypot(vx, vz), Math.hypot(c[0] - b[0], c[2] - b[2]));
    void uy;
    void vy;
  }
  check('walkable：頂點高度 = heightAt、投影面積守恆、法線朝上、邊長 ≤ 2 m', maxDy < 1e-5 && Math.abs(area - 60) < 1e-6 && up && maxEdge <= 2 + 1e-9, `三角形 ${m.indices.length / 3} 最長邊 ${fmt(maxEdge)}`);
}

// ---------- 固定步累加器 ----------
{
  const s = new FixedStepper(1 / 60, 5);
  let calls = 0;
  const r = s.advance(0.1, () => calls++);
  check('fixed step：frameDt 0.1 → steps 5、餘量丟棄、alpha ∈ [0,1)', r.steps === 5 && calls === 5 && s.acc === 0 && s.dropped > 0 && r.alpha >= 0 && r.alpha < 1, `steps ${r.steps} alpha ${fmt(r.alpha)} dropped ${fmt(s.dropped)}`);
  const s2 = new FixedStepper(1 / 60, 5);
  let total = 0;
  let alphaOk = true;
  let n = 0;
  for (let k = 0; k < 2000; k++) {
    const dt = 0.004 + rand() * 0.04;
    total += dt;
    const q = s2.advance(dt, () => n++);
    if (!(q.alpha >= 0 && q.alpha < 1)) alphaOk = false;
  }
  const sim = n / 60 + s2.acc + s2.dropped;
  check('fixed step：2000 隨機幀 alpha 皆 ∈ [0,1)、模擬時間 + 餘量 + 丟棄 = 實際時間', alphaOk && Math.abs(sim - total) < 1e-6, `實際 ${fmt(total)} s 模擬 ${fmt(n / 60)} s`);
  const s3 = new FixedStepper(1 / 60, 5);
  const q3 = s3.advance(1 / 60, () => {});
  check('fixed step：frameDt = step → 1 步', q3.steps === 1);
}

// ---------- 插值 ----------
{
  const pos = { x: 0, y: 0, z: 0 };
  const rot = { x: 0, y: 0, z: 0, w: 1 };
  const body = { translation: () => ({ ...pos }), rotation: () => ({ ...rot }) };
  const h = new InterpolatedBody(body);
  pos.x = 10;
  rot.y = Math.sin(Math.PI / 4);
  rot.w = Math.cos(Math.PI / 4);
  h.capture();
  const o = h.interpolate(0.5, {});
  const yaw = 2 * Math.atan2(o.qy, o.qw);
  check('interp：位置線性、旋轉 nlerp（0→90° 中點 45°）', Math.abs(o.x - 5) < 1e-9 && Math.abs(yaw - Math.PI / 4) < 1e-6, `x ${fmt(o.x)} yaw ${fmt((yaw * 180) / Math.PI, 2)}°`);
  h.reset();
  check('interp：reset 後 alpha 任意皆為目前位置', Math.abs(h.interpolate(0.3, {}).x - 10) < 1e-9);
}

// ---------- PhysicsWorld（mock RAPIER）：子步、回呼、事件路由、暫停 ----------
{
  const log = { steps: 0, cleared: 0, withQueue: 0 };
  class MockQueue {
    constructor(autoDrain) {
      this.autoDrain = autoDrain;
      this.events = [];
      this.forces = [];
    }
    clear() {
      log.cleared++;
      this.events.length = 0;
      this.forces.length = 0;
    }
    drainCollisionEvents(f) {
      for (const e of this.events) f(...e);
      this.events.length = 0;
    }
    drainContactForceEvents(f) {
      for (const e of this.forces) f(e);
      this.forces.length = 0;
    }
    free() {}
  }
  const colliders = new Map([
    [1, { handle: 1, tag: 'car' }],
    [2, { handle: 2, tag: 'ped' }],
  ]);
  class MockWorld {
    constructor(g) {
      this.gravity = g;
      this.timestep = 0;
    }
    step(q) {
      log.steps++;
      if (q) log.withQueue++;
      q.events.push([1, 2, true]);
    }
    getCollider(h) {
      return colliders.get(h);
    }
    free() {}
  }
  const pw = new PhysicsWorld({ World: MockWorld, EventQueue: MockQueue }, { gravity: -9.81, step: 1 / 60, maxSubSteps: 5 });
  const body = { translation: () => ({ x: log.steps, y: 0, z: 0 }), rotation: () => ({ x: 0, y: 0, z: 0, w: 1 }) };
  let synced = null;
  pw.register(body, (o) => (synced = { ...o }));
  let before = 0;
  pw.onBeforeStep(() => before++);
  const r = pw.step(0.1);
  check('world(mock)：step(0.1) → 5 子步、每步帶 eventQueue、beforeStep 5 次', r.steps === 5 && log.steps === 5 && log.withQueue === 5 && before === 5 && pw.world.timestep === 1 / 60 && pw.eventQueue.autoDrain === false);
  check('world(mock)：onSync 收到插值結果', synced && Math.abs(synced.x - (4 + (5 - 4) * r.alpha)) < 1e-9, `x ${synced && fmt(synced.x)}`);
  const got = [];
  pw.drainContacts((c1, c2, started) => got.push([c1.tag, c2.tag, started]));
  check('world(mock)：drainContacts 把 handle 轉成 collider，同幀 5 子步事件都保留', got.length === 5 && got[0][0] === 'car' && got[0][1] === 'ped' && got[0][2] === true, `${got.length} 筆`);
  pw.eventQueue.forces.push({ collider1: () => 2, collider2: () => 9, totalForceMagnitude: () => 1200, maxForceMagnitude: () => 800, maxForceDirection: () => ({ x: 1, y: 0, z: 0 }) });
  const f = [];
  pw.drainContactForces((e) => f.push(e));
  check('world(mock)：drainContactForces 轉成純數值物件、已移除 collider 為 null', f.length === 1 && f[0].collider1.tag === 'ped' && f[0].collider2 === null && f[0].totalForceMagnitude === 1200);
  const clearedBefore = log.cleared;
  pw.step(0.01);
  check('world(mock)：每幀開頭清空事件佇列', log.cleared === clearedBefore + 1);
  pw.pause();
  const rp = pw.step(0.5);
  pw.resume();
  const rr = pw.step(1 / 60);
  check('world(mock)：pause 期間不前進、resume 後累加器歸零', rp.steps === 0 && pw.stepper.acc < 1e-9 && rr.steps === 1);
}

// ---------- 手感參數推導 ----------
{
  const src = readFileSync(join(ROOT, 'src/player.js'), 'utf8');
  // player.js 不再自帶手感常數：一律由 physics/character.js import（單一來源），半徑仍與 CH.RADIUS 相同
  const dup = ['WALK_SPEED', 'RUN_SPEED', 'ACCEL', 'DECEL', 'JUMP_SPEED', 'GRAVITY'].filter((n) => new RegExp(`const ${n} = `).test(src));
  const imp = /import \{[^}]*\bWALK_SPEED\b[^}]*\bRUN_SPEED\b[^}]*\bJUMP_SPEED\b[^}]*\bGRAVITY\b[^}]*\bstepVelocity\b[^}]*\} from '\.\/physics\/character\.js'/.test(src);
  check(
    'character：player.js 手感常數由 physics/character.js import（無重複定義）、半徑相同',
    imp && dup.length === 0 && Number((src.match(/PLAYER_RADIUS = ([0-9.]+)/) || [])[1]) === CH.RADIUS,
    dup.length ? `重複定義 ${dup.join(', ')}` : '',
  );
  check(
    'character：走 4.2、衝刺 7.0；走速 0.5 s、衝刺頂速 1.5 s、衝刺放開 ≤ 0.3 s 停',
    CH.WALK_SPEED === 4.2 && CH.RUN_SPEED === 7 && Math.abs(CH.WALK_SPEED / CH.ACCEL - 0.5) < 1e-9 &&
      Math.abs(CH.WALK_SPEED / CH.ACCEL + (CH.RUN_SPEED - CH.WALK_SPEED) / CH.SPRINT_ACCEL - 1.5) < 1e-9 && CH.RUN_SPEED / CH.DECEL <= 0.3,
    `衝刺停止 ${fmt(CH.RUN_SPEED / CH.DECEL, 3)} s`,
  );
  // 離散頂點（起跳步先位移、之後每步先扣重力再位移，同 CharacterBody.move）
  let dy = CH.JUMP_SPEED * CH.PHYSICS_STEP;
  let peak = dy;
  for (let vy = CH.JUMP_SPEED - CH.GRAVITY * CH.PHYSICS_STEP; vy > 0; vy -= CH.GRAVITY * CH.PHYSICS_STEP) peak = dy += vy * CH.PHYSICS_STEP;
  check('character：60 Hz 離散跳高 ≈ JUMP_HEIGHT 0.94 ±0.01、coyote 0.12 s、緩衝 0.15 s', Math.abs(peak - 0.94) < 0.01 && CH.JUMP_HEIGHT === 0.94 && CH.COYOTE_TIME === 0.12 && CH.JUMP_BUFFER === 0.15, `頂點 ${fmt(peak, 3)} m`);
  const jumpH = CH.JUMP_SPEED ** 2 / (2 * CH.GRAVITY);
  const airT = (2 * CH.JUMP_SPEED) / CH.GRAVITY;
  const height = 2 * (CH.HALF_HEIGHT + CH.RADIUS);
  console.log(`      推導：連續公式跳高 ${fmt(jumpH, 3)} m（離散 ${fmt(peak, 3)} m）、滯空 ${fmt(airT, 3)} s、膠囊總高 ${fmt(height, 2)} m、中心離腳底 ${fmt(CH.HALF_HEIGHT + CH.RADIUS + CH.OFFSET, 2)} m、跑速每步 ${fmt(CH.RUN_SPEED / 60, 3)} m`);
  check('character：0.3 m 台階 < autostep 0.35 < 1 m 台階；跳高 < 1 m（1 m 台階跳不上去也合理）', 0.3 < CH.AUTOSTEP_MAX_HEIGHT && CH.AUTOSTEP_MAX_HEIGHT < 1 && jumpH < 1);
  check('character：爬坡 45° < 滑落 50°、每步跑速 < 半徑（不穿薄牆）', CH.MAX_SLOPE_CLIMB < CH.MIN_SLOPE_SLIDE && CH.RUN_SPEED / 60 < CH.RADIUS);
}

console.log(`\n純邏輯：${passed} 通過 / ${failed} 失敗`);

// ======================= 完整版（需要 rapier）=======================
if (NO_RAPIER) {
  console.log('（--no-rapier：完整版物理測試未執行）');
  process.exit(failed ? 1 : 0);
}

let RAPIER;
try {
  RAPIER = await initPhysics();
} catch (e) {
  console.error(`\n錯誤：無法載入 @dimforge/rapier3d-compat 執行檔（dist/rapier.mjs）：${e.message}`);
  console.error('完整版物理測試需要 rapier；只跑純邏輯請加 --no-rapier。');
  process.exit(2);
}

const pureFailed = failed;
const DT = 1 / 60;
try {

// ---------- 場景配置：在沒有建築的空地放 mock 碗形 patch、mock 湖、台階 ----------
const bboxes = osm.B.map((b) => polygonBBox(b.p));
const taken = [];
function freeArea(w, d, clearance = 15) {
  const B = osm.bounds;
  for (let z = B.z0 + 40; z + d < B.z1 - 40; z += 10) {
    for (let x = B.x0 + 40; x + w < B.x1 - 40; x += 10) {
      const r = { x0: x - clearance, z0: z - clearance, x1: x + w + clearance, z1: z + d + clearance };
      const hit = (o) => o.x0 < r.x1 && o.x1 > r.x0 && o.z0 < r.z1 && o.z1 > r.z0;
      if (bboxes.some(hit) || taken.some(hit)) continue;
      const a = { x0: x, z0: z, x1: x + w, z1: z + d };
      taken.push(r);
      return a;
    }
  }
  throw new Error('找不到空地');
}

const BOWL = 60;
const BOWL_DEPTH = 6;
const bowlArea = freeArea(BOWL + 20, BOWL + 20);
const bx0 = bowlArea.x0 + 10;
const bz0 = bowlArea.z0 + 10;
const bcx = bx0 + BOWL / 2;
const bcz = bz0 + BOWL / 2;
const bowlH = (x, z) => {
  const r = Math.hypot(x - bcx, z - bcz);
  return r >= BOWL / 2 ? 0 : (-BOWL_DEPTH * (1 + Math.cos((Math.PI * r) / (BOWL / 2)))) / 2;
};
const bowl = { id: 'bowl', kind: 'mock', x0: bx0, z0: bz0, cell: 1, cols: BOWL + 1, rows: BOWL + 1, heights: new Float32Array((BOWL + 1) ** 2) };
for (let r = 0; r <= BOWL; r++) for (let c = 0; c <= BOWL; c++) bowl.heights[r * (BOWL + 1) + c] = bowlH(bx0 + c, bz0 + r);
const BRIDGE_Y = 0.25;
const BRIDGE_HALF_W = 1.5;
const bridge = { id: 'bridge', kind: 'bridge', poly: [bcx - 36, bcz - BRIDGE_HALF_W, bcx + 36, bcz - BRIDGE_HALF_W, bcx + 36, bcz + BRIDGE_HALF_W, bcx - 36, bcz + BRIDGE_HALF_W], heightAt: () => BRIDGE_Y };

const lakeArea = freeArea(60, 60);
const lx = lakeArea.x0 + 15;
const lz = lakeArea.z0 + 15;
// 凹湖（U 形，30 × 30），湖面步道高度 0（mock），阻擋柱底 −3
const mockLakePoly = [lx, lz, lx + 30, lz, lx + 30, lz + 30, lx + 20, lz + 30, lx + 20, lz + 12, lx + 10, lz + 12, lx + 10, lz + 30, lx, lz + 30];
const plank = { id: 'plank', kind: 'boardwalk', poly: [lx - 3, lz + 5, lx + 33, lz + 5, lx + 33, lz + 7, lx - 3, lz + 7], heightAt: () => BRIDGE_Y };

const terrain = {
  patches: [bowl],
  walkables: [bridge, plank],
  heightAt: (x, z) => (x >= bx0 && x <= bx0 + BOWL && z >= bz0 && z <= bz0 + BOWL ? bowlH(x, z) : 0),
  buildingBase: () => 0,
};

const pw = new PhysicsWorld(RAPIER);
const stats = buildWorldColliders(RAPIER, pw.world, { osm, terrain, lake: { poly: mockLakePoly, walkway: 0, bottom: -3 } });
// 台階（測試專用固定 cuboid）：0.3 m 與 1 m，4 × 4 m
const stepArea = freeArea(30, 20);
const stepLow = { x0: stepArea.x0 + 8, z0: stepArea.z0 + 2, h: 0.3 };
const stepHigh = { x0: stepArea.x0 + 8, z0: stepArea.z0 + 12, h: 1.0 };
for (const s of [stepLow, stepHigh]) {
  pw.world.createCollider(RAPIER.ColliderDesc.cuboid(2, s.h / 2, 2).setTranslation(s.x0 + 2, s.h / 2, s.z0 + 2).setCollisionGroups(G.GROUPS.WORLD).setSolverGroups(G.GROUPS.WORLD));
}
pw.stepOnce(); // 更新 broad phase，之後查詢才看得到
const set = (k) => new Set(stats.handles[k].map((c) => c.handle));
const walkSet = set('walkable');
const groundSet = set('ground');
const hfSet = set('heightfield');
const lakeSet = set('lake');
console.log(
  `\n建世界：${fmt(stats.ms, 1)} ms；collider ${stats.colliders}（建築凸塊 ${stats.buildingPieces}、heightfield ${stats.heightfields}、平地 cuboid ${stats.groundBoxes}、walkable ${stats.walkables}、湖面柱 ${stats.lakePieces}、牆 ${stats.walls}、略過 ${stats.skipped}）`,
);
check('build：建築凸塊數 = 凸分解（含長條切短）總數、無略過', stats.skipped === 0 && stats.buildingPieces === osm.B.reduce((s, b) => s + buildingPieces(b.p).length, 0));
{
  const want = rectDifference({ x0: osm.bounds.x0, z0: osm.bounds.z0, x1: osm.bounds.x1, z1: osm.bounds.z1 }, [patchRect(bowl)]).flatMap(groundTiles).length;
  check('build：單一內部 patch → 4 個差集矩形切塊後的平地 cuboid 數', stats.groundBoxes === want, `${stats.groundBoxes} / 應為 ${want}`);
}

const DOWN = { x: 0, y: -1, z: 0 };

// ---------- heightfield 一致性 ----------
{
  let maxDiff = 0;
  let miss = 0;
  let n = 0;
  while (n < 3000) {
    const x = bx0 - 10 + rand() * (BOWL + 20);
    const z = bz0 - 10 + rand() * (BOWL + 20);
    n++;
    const hit = pw.castRay({ x, y: 10, z }, DOWN, 40, { predicate: (c) => !walkSet.has(c.handle) });
    if (!hit) {
      miss++;
      continue;
    }
    maxDiff = Math.max(maxDiff, Math.abs(hit.y - terrain.heightAt(x, z)));
  }
  check('heightfield：碗內外 3000 點 castRay 命中高度與 heightAt 差 < 0.02', miss === 0 && maxDiff < 0.02, `最大差 ${fmt(maxDiff)}，未命中 ${miss}`);
}

// ---------- 凹口 castRay ----------
{
  const notch = findNotchBuildings(3);
  let ok = notch.length === 3;
  const det = [];
  for (const nb of notch) {
    const hit = pw.castRay({ x: nb.x, y: 300, z: nb.z }, DOWN, 400);
    const good = hit && groundSet.has(hit.collider.handle) && Math.abs(hit.y) < 0.01;
    const c = polygonCentroidInside(nb.b.p);
    const top = pw.castRay({ x: c.x, y: 300, z: c.z }, DOWN, 400);
    const goodTop = top && stats.handles.building.includes(top.collider) && top.y >= nb.b.h - 0.05;
    if (!good || !goodTop) ok = false;
    det.push(`${nb.b.i}:凹口 y=${hit ? fmt(hit.y, 3) : 'miss'} 屋頂 y=${top ? fmt(top.y, 2) : 'miss'}/${nb.b.h}`);
  }
  check('decompose(rapier)：3 棟凹多邊形凹口 castRay 命中地面、屋內命中屋頂', ok, det.join(' '));
}

// 輪廓內一點（凸分解最大塊的頂點平均）
function polygonCentroidInside(p) {
  const ps = convexDecompose(p);
  ps.sort((a, b) => signedAreaFlat(b) - signedAreaFlat(a));
  const q = ps[0];
  let x = 0;
  let z = 0;
  for (let i = 0; i < q.length; i += 2) {
    x += q[i];
    z += q[i + 1];
  }
  return { x: (x * 2) / q.length, z: (z * 2) / q.length };
}

// ---------- 湖面阻擋 / 通道（射線）----------
{
  const inCh = pw.castRay({ x: lx + 15, y: 10, z: lz + 6 }, DOWN, 20);
  const onLake = pw.castRay({ x: lx + 25, y: 10, z: lz + 20 }, DOWN, 20);
  check(
    'lake(rapier)：通道上命中 walkable（y = 0.25）、湖面其他處命中阻擋柱頂（y = 1.2）',
    inCh && walkSet.has(inCh.collider.handle) && Math.abs(inCh.y - BRIDGE_Y) < 0.01 && onLake && lakeSet.has(onLake.collider.handle) && Math.abs(onLake.y - 1.2) < 0.01,
    `通道 ${inCh ? fmt(inCh.y, 3) : 'miss'} 湖面 ${onLake ? fmt(onLake.y, 3) : 'miss'}`,
  );
}

// ---------- 角色 ----------
const ch = new CH.CharacterBody(RAPIER, pw, { x: 0, y: 5, z: 0 });
function simulate(seconds, input, stop = null) {
  const n = Math.round(seconds / DT);
  let r = ch.result;
  for (let i = 0; i < n; i++) {
    r = ch.move(DT, typeof input === 'function' ? input(r) : input);
    pw.stepOnce();
    if (stop && stop(r, i)) return { r, t: (i + 1) * DT };
  }
  return { r, t: n * DT };
}
const IDLE = { moveX: 0, moveZ: 0 };

{
  const a = freeArea(10, 10);
  ch.teleport(a.x0 + 5, 3, a.z0 + 5);
  let tLand = -1;
  const { r } = simulate(2, IDLE, (q, i) => {
    if (q.grounded && tLand < 0) tLand = (i + 1) * DT;
    return false;
  });
  check('character：平地 2 秒內落地、腳底 y ≈ 0 ±0.03', r.grounded && tLand >= 0 && tLand <= 2 && Math.abs(r.y) < 0.03, `落地 ${fmt(tLand, 2)} s y=${fmt(r.y)}`);

  // 平地原地跳：頂點 ≈ 0.94 m、落地後回到地面（需宿主執行：真 Rapier 控制器的 grounded / snap 行為）
  let top = r.y;
  let first = true;
  const jr = simulate(1.5, () => {
    const it = { moveX: 0, moveZ: 0, jump: first };
    first = false;
    return it;
  }, (q) => {
    top = Math.max(top, q.y);
    return false;
  }).r;
  check('character(rapier)：平地起跳頂點 ≈ 0.94 ±0.03 m、1.5 s 內落回', Math.abs(top - CH.JUMP_HEIGHT) < 0.03 && jr.grounded && Math.abs(jr.y) < 0.03, `頂點 ${fmt(top, 3)} 終點 y=${fmt(jr.y)}`);
}

{
  // 朝建築直走 3 秒：從建築內部往 +x 找出口，再往外 6 m 起步，沿 −x 跑向牆
  const cp = {};
  let pick = null;
  for (const b of osm.B) {
    if (b.h < 6 || Math.abs(signedAreaFlat(b.p)) < 300) continue;
    const c = polygonCentroidInside(b.p);
    let x = c.x;
    while (pointInPolygon(x, c.z, b.p) && x < c.x + 300) x += 0.25;
    const sx = x + 6;
    let clear = !osm.B.some((o) => pointInPolygon(sx, c.z, o.p) || (closestOnPolygon(sx, c.z, o.p, cp), cp.d2 < 4));
    // 起點到牆之間沒有其他建築
    for (let t = x + 0.5; t < sx && clear; t += 0.5) if (osm.B.some((o) => pointInPolygon(t, c.z, o.p))) clear = false;
    if (clear) {
      pick = { b, sx, z: c.z, exitX: x };
      break;
    }
  }
  if (!pick) throw new Error('找不到可做撞牆測試的建築');
  ch.teleport(pick.sx, 0, pick.z);
  simulate(0.3, IDLE);
  // 每一步都檢查膠囊中心不在任何建築內、且與目標建築保持 ≥ 半徑 − 0.05；記錄最接近距離（證明真的撞到牆）
  let pen = 0;
  let minD = Infinity;
  let blocker = null; // 第一個擋住水平移動的 collider（除錯：失敗時可看出被誰擋住）
  let stall = null; // 第一次「離牆 > 0.6 m 卻幾乎沒前進」的那一步：列出該步全部碰撞（含 |ny| > 0.7 的地面接觸）
  const kindOf = (h) => (Object.keys(stats.handles).find((k) => stats.handles[k].some((o) => o.handle === h)) || 'other') + (stats.buildingOf.has(h) ? ':' + stats.buildingOf.get(h) : '');
  let stepNo = 0;
  const { r } = simulate(3, { moveX: -1, moveZ: 0, run: true }, (q) => {
    stepNo++;
    if (osm.B.some((o) => pointInPolygon(q.x, q.z, o.p))) pen++;
    closestOnPolygon(q.x, q.z, pick.b.p, cp);
    const d = Math.sqrt(cp.d2);
    if (d < CH.RADIUS - 0.05) pen++;
    minD = Math.min(minD, d);
    const c = ch.controller;
    for (let i = 0; i < c.numComputedCollisions() && !blocker; i++) {
      const col = c.computedCollision(i);
      if (!col || !col.collider || Math.abs(col.normal1.y) > 0.7) continue;
      blocker = `${kindOf(col.collider.handle)} @(${fmt(q.x, 2)}, ${fmt(q.z, 2)}) n=(${fmt(col.normal1.x, 2)}, ${fmt(col.normal1.z, 2)})`;
    }
    // 起步加速 0.35 s 之後、離牆仍 > 0.6 m 而本步水平速度 < 1 m/s：記錄一次
    if (!stall && stepNo > 30 && d > 0.6 && q.speed < 1) {
      const cols = [];
      for (let i = 0; i < c.numComputedCollisions(); i++) {
        const col = c.computedCollision(i);
        if (col && col.collider) cols.push(`${kindOf(col.collider.handle)} n=(${fmt(col.normal1.x, 2)}, ${fmt(col.normal1.y, 2)}, ${fmt(col.normal1.z, 2)}) toi=${fmt(col.toi, 3)}`);
      }
      stall = `第 ${stepNo} 步 @(${fmt(q.x, 2)}, ${fmt(q.y, 3)}, ${fmt(q.z, 2)}) 離牆 ${fmt(d, 3)} 速度 ${fmt(q.speed, 2)} grounded ${q.grounded}；碰撞 ${cols.length ? cols.join(' | ') : '無'}`;
    }
    return false;
  });
  check('character：朝建築直跑 3 秒不穿牆（每步檢查）', pen === 0 && minD < 0.6, `建築 ${pick.b.i} 起點離出口牆 ${fmt(pick.sx - pick.exitX, 2)} m、最近離牆 ${fmt(minD, 3)} m、穿入步數 ${pen}、終點 (${fmt(r.x, 1)}, ${fmt(r.z, 1)})、首個水平阻擋 ${blocker || '無'}、停滯 ${stall || '無'}`);

  // 下車點：從建築內部靠出口 1.5 m 處要求，應回傳建築外無碰撞點
  const spot = ch.findFreeSpot(pick.exitX - 1.5, 0, pick.z, 4);
  const spotOk = spot && !osm.B.some((o) => pointInPolygon(spot.x, spot.z, o.p)) && Math.abs(spot.y) < 0.05;
  check('character：findFreeSpot 在建築內要求 → 回傳建築外地面點', !!spotOk, spot ? `(${fmt(spot.x, 2)}, ${fmt(spot.y, 3)}, ${fmt(spot.z, 2)})` : 'null');
}

{
  // 走下碗坡：從南側碗外沿 −z 走到中心（避開沿 x 橫跨的橋）
  ch.teleport(bcx, 0, bcz + BOWL / 2 + 3);
  simulate(0.3, IDLE);
  simulate(20, { moveX: 0, moveZ: -1 }, (q) => q.z <= bcz + 0.3);
  const { r } = simulate(1, IDLE);
  check('character：走下碗坡到底 y ≈ −6 ±0.1', Math.abs(r.y + BOWL_DEPTH) < 0.1 && r.grounded, `y=${fmt(r.y)} 離中心 ${fmt(Math.hypot(r.x - bcx, r.z - bcz), 2)} m`);
}

{
  // 走上橋中央：從碗西側平地沿 +x 上橋（橋面 0.25 m，靠 autostep 上去）
  ch.teleport(bcx - 40, 0, bcz);
  simulate(0.3, IDLE);
  simulate(20, { moveX: 1, moveZ: 0 }, (q) => q.x >= bcx);
  const { r } = simulate(0.5, IDLE);
  check('character：走上橋中央 y ≈ 橋面', Math.abs(r.y - BRIDGE_Y) < 0.05 && r.grounded && Math.abs(r.x - bcx) < 2, `y=${fmt(r.y)} x−cx=${fmt(r.x - bcx, 2)}`);
}

{
  ch.teleport(stepLow.x0 - 3, 0, stepLow.z0 + 2);
  simulate(0.3, IDLE);
  simulate(3, { moveX: 1, moveZ: 0 }, (q) => q.x >= stepLow.x0 + 2);
  const lo = simulate(0.5, IDLE).r;
  const loOk = Math.abs(lo.y - stepLow.h) < 0.05 && lo.x > stepLow.x0;
  ch.teleport(stepHigh.x0 - 3, 0, stepHigh.z0 + 2);
  simulate(0.3, IDLE);
  const hi = simulate(2, { moveX: 1, moveZ: 0 }).r;
  const hiOk = hi.y < 0.1 && hi.x < stepHigh.x0 - CH.RADIUS + 0.05;
  check('character：0.3 m 台階可上、1 m 台階不可上', loOk && hiOk, `0.3 m→y=${fmt(lo.y, 3)}；1 m→y=${fmt(hi.y, 3)} x−邊=${fmt(hi.x - stepHigh.x0, 3)}`);
}

{
  // 朝湖直走被擋：從湖南側（z 小的一側）外 6 m 沿 +z 走向湖心
  ch.teleport(lx + 25, 0, lz - 6);
  simulate(0.3, IDLE);
  const { r } = simulate(4, { moveX: 0, moveZ: 1 });
  const inLake = pointInPolygon(r.x, r.z, mockLakePoly);
  check('character：朝湖直走被阻擋柱擋下', !inLake && r.y < 0.5 && r.z < lz, `z−湖邊=${fmt(r.z - lz, 3)} y=${fmt(r.y, 3)}`);
}

// ---------- 固定步 ----------
{
  const res = pw.step(0.1);
  check('fixed step(rapier)：step(0.1) → steps 5、alpha ∈ [0,1)', res.steps === 5 && res.alpha >= 0 && res.alpha < 1, `steps ${res.steps} alpha ${fmt(res.alpha)}`);
}

// ---------- 步進耗時 ----------
{
  const a = freeArea(10, 10);
  ch.teleport(a.x0 + 5, 0, a.z0 + 5);
  const t0 = performance.now();
  for (let i = 0; i < 1000; i++) {
    const ang = i * 0.01;
    ch.move(DT, { moveX: Math.cos(ang), moveZ: Math.sin(ang) });
    pw.stepOnce();
  }
  const avg = (performance.now() - t0) / 1000;
  console.log(`      1000 步平均步進 ${fmt(avg, 3)} ms（含角色控制器）`);
  check('perf：1000 步平均 < 4 ms', avg < 4, `${fmt(avg, 3)} ms`);
}

ch.dispose();
pw.dispose();
} catch (e) {
  check('完整版執行中發生例外', false, e && e.stack ? e.stack : String(e));
}
console.log(`\n完整版：${passed} 通過 / ${failed} 失敗（其中純邏輯失敗 ${pureFailed}）`);
process.exit(failed ? 1 : 0);
