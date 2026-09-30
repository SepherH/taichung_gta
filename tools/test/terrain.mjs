#!/usr/bin/env node
// 地形唯一高度場無頭檢查（純 Node，不經 Vite）：用 fs 讀 osm-city.json 後 createTerrain
// 檢查：高度 / 查詢一致、平地恆 0、谷底 / 步道 / 停車場 / 道路高度、patch 無裂縫、網格與貼地細分、高度 = 網格三角形平面、法線坡度、walkables、統計
// 用法：node tools/test/terrain.mjs（任一斷言失敗 exit 1）
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTerrain, buildPatchMesh, drapeRibbon } from '../../src/terrain.js';
import { pointInPolygon, closestOnPolygon, closestOnSegment, polygonBBox, polylineInfo } from '../../src/geom.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const osm = JSON.parse(readFileSync(resolve(ROOT, 'src/data/osm-city.json'), 'utf8'));

const RANDOM_POINTS = 20000;
const Y_FOOT = 0.07; // 與 world.js 步道圖層高度相同
const LAKEBED_TOL = 0.05;
const WALKWAY_BAND = [1.6, 2.4]; // 湖岸外此距離帶（m）視為湖邊步道區（terrain.js LAKE_WALKWAY = 3）
const WALKWAY_TOL = 0.3;
const ROAD_TOL = 0.01;
const MESH_TOL = 1e-4;
const DRAPE_TOL = 0.02;
const DRAPE_STEP = 1.01;
const MIN_NY = 0.3;

let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${msg}`);
  if (!ok) failed++;
};
const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : String(v));

// 固定種子亂數（結果可重現）
let seed = 20260930;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

const t0 = performance.now();
const terrain = createTerrain(osm);
const buildMs = performance.now() - t0;
const { patches, walkables, stats } = terrain;
const basin = osm.T.basins[0];
const lv = basin.levels;
const basinPatch = patches.find((p) => p.kind === 'basin');
const inPatch = (x, z) => patches.some((p) => x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1);
const inWalkable = (x, z) => walkables.some((w) => pointInPolygon(x, z, w.poly));

// ---------- 1. 隨機點：heightAt 與 querySurface.y 一致、patch 外恆 0 ----------
{
  const b = osm.bounds;
  let maxDiff = 0;
  let maxOut = 0;
  let nIn = 0;
  let nOut = 0;
  const q = {};
  for (let i = 0; i < RANDOM_POINTS; i++) {
    let x;
    let z;
    if (i % 2) {
      const p = patches[i % patches.length];
      x = p.x0 - 2 + rnd() * (p.x1 - p.x0 + 4);
      z = p.z0 - 2 + rnd() * (p.z1 - p.z0 + 4);
    } else {
      x = b.x0 + rnd() * (b.x1 - b.x0);
      z = b.z0 + rnd() * (b.z1 - b.z0);
    }
    const h = terrain.heightAt(x, z);
    if (!inWalkable(x, z)) maxDiff = Math.max(maxDiff, Math.abs(terrain.querySurface(x, z, Infinity, q).y - h));
    if (inPatch(x, z)) nIn++;
    else {
      nOut++;
      maxOut = Math.max(maxOut, Math.abs(h));
    }
  }
  check(maxDiff === 0, `隨機 ${RANDOM_POINTS} 點（patch 內 ${nIn}、外 ${nOut}）無 walkable 處 |heightAt − querySurface.y| 最大 ${maxDiff}`);
  check(maxOut === 0, `patch 外 heightAt 恆 0（最大 |h| = ${maxOut}）`);
}

// ---------- 2. 谷底 / 湖邊步道 / 停車場 / 道路 ----------
{
  let lo = 0;
  for (const h of basinPatch.heights) lo = Math.min(lo, h);
  check(Math.abs(lo - lv.lakebed) < LAKEBED_TOL, `秋紅谷最低點 ${f3(lo)}（lakebed ${lv.lakebed}）`);

  const bb = polygonBBox(basin.p);
  let n = 0;
  let maxDev = 0;
  for (let i = 0; i < 40000 && n < 2000; i++) {
    const x = bb.x0 + rnd() * (bb.x1 - bb.x0);
    const z = bb.z0 + rnd() * (bb.z1 - bb.z0);
    if (!pointInPolygon(x, z, basin.p) || pointInPolygon(x, z, basin.lake)) continue;
    const d = Math.sqrt(closestOnPolygon(x, z, basin.lake).d2);
    if (d < WALKWAY_BAND[0] || d > WALKWAY_BAND[1]) continue;
    n++;
    maxDev = Math.max(maxDev, Math.abs(terrain.heightAt(x, z) - lv.walkway));
  }
  check(n > 100 && maxDev < WALKWAY_TOL, `湖岸外 ${WALKWAY_BAND.join('–')} m 步道區 ${n} 點 ≈ walkway ${lv.walkway}（最大偏差 ${f3(maxDev)}）`);

  let maxEx = 0;
  let nEx = 0;
  for (const ex of basin.exclude) {
    const eb = polygonBBox(ex);
    for (let i = 0; i < 20000 && nEx < 3000; i++) {
      const x = eb.x0 + rnd() * (eb.x1 - eb.x0);
      const z = eb.z0 + rnd() * (eb.z1 - eb.z0);
      if (!pointInPolygon(x, z, ex)) continue;
      nEx++;
      maxEx = Math.max(maxEx, Math.abs(terrain.heightAt(x, z)));
    }
  }
  check(nEx > 0 && maxEx === 0, `停車場 exclude 內 ${nEx} 點 heightAt = 0（最大 |h| = ${maxEx}）`);

  let maxRoad = 0;
  let nRoad = 0;
  let worst = null;
  for (const r of osm.R) {
    if (r.u) continue;
    const hw = r.w / 2;
    const info = polylineInfo(r.p);
    for (let i = 0; i < info.pts.length - 1; i++) {
      const a = info.pts[i];
      const b = info.pts[i + 1];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L < 1e-6) continue;
      const ux = (b.x - a.x) / L;
      const uz = (b.z - a.z) / L;
      const nL = Math.ceil(L);
      const nW = Math.ceil(2 * hw);
      for (let s = 0; s <= nL; s++) {
        for (let k = 0; k <= nW; k++) {
          const along = (L * s) / nL;
          const across = -hw + (2 * hw * k) / nW;
          const x = a.x + ux * along - uz * across;
          const z = a.z + uz * along + ux * across;
          if (!inPatch(x, z)) continue;
          nRoad++;
          const h = Math.abs(terrain.heightAt(x, z));
          if (h > maxRoad) {
            maxRoad = h;
            worst = r.i;
          }
        }
      }
    }
  }
  check(maxRoad < ROAD_TOL, `道路 ribbon（依寬度）在 patch 內 ${nRoad} 點 heightAt 最大偏差 ${maxRoad.toExponential(2)}${worst ? `（way ${worst}）` : ''}`);
  console.log(`INFO 道路與下凹區重疊（ribbon + 2 m，已排除下凹）：${stats.roadOverlaps.length} 條 ${stats.roadOverlaps.map((r) => `${r.id}${r.name ? ` ${r.name}` : ''}`).join('、')}`);
}

// ---------- 3. 無裂縫：邊框 = 0、網格頂點 = heightAt、貼地細分 ----------
{
  let border = 0;
  for (const p of patches) {
    for (let c = 0; c < p.cols; c++) border = Math.max(border, Math.abs(p.heights[c]), Math.abs(p.heights[(p.rows - 1) * p.cols + c]));
    for (let r = 0; r < p.rows; r++) border = Math.max(border, Math.abs(p.heights[r * p.cols]), Math.abs(p.heights[r * p.cols + p.cols - 1]));
  }
  check(border === 0 && stats.borderFixes === 0, `patch 邊框頂點高度恰為 0（最大 |h| = ${border}，建立時強制修正 ${stats.borderFixes} 點）`);

  let maxMesh = 0;
  let tris = 0;
  for (const p of patches) {
    const m = buildPatchMesh(p);
    for (let i = 0; i < m.positions.length; i += 3) {
      maxMesh = Math.max(maxMesh, Math.abs(m.positions[i + 1] - terrain.heightAt(m.positions[i], m.positions[i + 2])));
    }
    const grouped = m.groups.reduce((s, g) => s + g.count, 0);
    check(grouped === m.indices.length, `${p.id} 網格分組 ${m.groups.map((g) => `${g.surface} ${g.count / 3}`).join(' / ')} 三角形，合計 = 索引數`);
    tris += m.indices.length / 3;
  }
  check(maxMesh < MESH_TOL, `buildPatchMesh 頂點 y 與 heightAt 最大差 ${maxMesh.toExponential(2)}（共 ${tris} 三角形）`);

  // heightAt 與「所在網格三角形平面」一致：由 buildPatchMesh 的索引反查每格的三角形（不依賴 terrain.js 的內插程式），隨機點以重心座標求平面高度
  // 所屬格取 buildPatchMesh 回傳的 triCells（秋紅谷折線切分會新增頂點，不能再由頂點編號反推格）
  {
    let maxTri = 0;
    let n = 0;
    let miss = 0;
    for (const p of patches) {
      const m = buildPatchMesh(p);
      const P = m.positions;
      const cellTris = new Map();
      for (let t = 0; t < m.indices.length; t += 3) {
        const cell = m.triCells[t / 3];
        const key = Math.floor(cell / (p.cols - 1)) * p.cols + (cell % (p.cols - 1));
        if (!cellTris.has(key)) cellTris.set(key, []);
        cellTris.get(key).push(m.indices[t], m.indices[t + 1], m.indices[t + 2]);
      }
      const per = RANDOM_POINTS / patches.length;
      for (let k = 0; k < per; k++) {
        const x = p.x0 + rnd() * (p.x1 - p.x0);
        const z = p.z0 + rnd() * (p.z1 - p.z0);
        const c = Math.min(p.cols - 2, Math.floor((x - p.x0) / p.cell));
        const r = Math.min(p.rows - 2, Math.floor((z - p.z0) / p.cell));
        const tris = cellTris.get(r * p.cols + c) || [];
        let y = NaN;
        for (let t = 0; t < tris.length && Number.isNaN(y); t += 3) {
          const [ax, ay, az] = [P[tris[t] * 3], P[tris[t] * 3 + 1], P[tris[t] * 3 + 2]];
          const [bx, by, bz] = [P[tris[t + 1] * 3], P[tris[t + 1] * 3 + 1], P[tris[t + 1] * 3 + 2]];
          const [cx, cy, cz] = [P[tris[t + 2] * 3], P[tris[t + 2] * 3 + 1], P[tris[t + 2] * 3 + 2]];
          const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
          const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
          const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
          const l3 = 1 - l1 - l2;
          if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
          y = l1 * ay + l2 * by + l3 * cy;
        }
        if (Number.isNaN(y)) {
          miss++;
          continue;
        }
        n++;
        maxTri = Math.max(maxTri, Math.abs(terrain.heightAt(x, z) - y));
      }
    }
    check(miss === 0 && n === RANDOM_POINTS && maxTri < MESH_TOL, `隨機 ${n} 點 heightAt 與所在網格三角形平面最大差 ${maxTri.toExponential(2)}（找不到所在三角形 ${miss} 點）`);
  }

  const inBasin = osm.F.filter((f) => !f.u && f.p.some((v, i) => i % 2 === 0 && pointInPolygon(v, f.p[i + 1], basin.p)));
  let maxD = 0;
  let maxStep = 0;
  let verts = 0;
  for (const f of inBasin) {
    const surface = f.br ? terrain.topSurface : terrain;
    const out = { pos: [], nor: [] };
    drapeRibbon(surface, polylineInfo(f.p).pts, f.w / 2, Y_FOOT, out);
    const P = out.pos;
    verts += P.length / 3;
    for (let i = 0; i < P.length; i += 3) maxD = Math.max(maxD, Math.abs(P[i + 1] - Y_FOOT - surface.heightAt(P[i], P[i + 2])));
    for (let i = 0; i < P.length; i += 9) {
      const e = [0, 1, 2].map((k) => {
        const a = i + k * 3;
        const b = i + ((k + 1) % 3) * 3;
        return Math.hypot(P[a] - P[b], P[a + 2] - P[b + 2]);
      });
      e.sort((u, v) => u - v);
      maxStep = Math.max(maxStep, e[1]);
    }
  }
  check(maxD < DRAPE_TOL, `drapeRibbon：秋紅谷內 ${inBasin.length} 條步道 ${verts} 頂點與地表（橋用 topSurface）最大差 ${maxD.toExponential(2)}（已扣分層偏移 ${Y_FOOT}）`);
  check(maxStep <= DRAPE_STEP, `drapeRibbon 相鄰頂點間距（每個三角形較短兩邊）最大 ${f3(maxStep)} m`);
}

// ---------- 4. 法線 / 坡度 ----------
{
  const q = {};
  terrain.querySurface(900, 600, Infinity, q);
  const flatOk = q.nx === 0 && q.ny === 1 && q.nz === 0;
  terrain.querySurface(basinPatch.x0 + 1, basinPatch.z0 + 1, Infinity, q);
  check(flatOk && q.nx === 0 && q.ny === 1 && q.nz === 0, `平地法線 (0,1,0)（patch 外與 patch 內平坦處）`);
  let minNy = 1;
  for (let r = 0; r < basinPatch.rows - 1; r++) {
    for (let c = 0; c < basinPatch.cols - 1; c++) {
      terrain.querySurface(basinPatch.x0 + (c + 0.5) * basinPatch.cell, basinPatch.z0 + (r + 0.5) * basinPatch.cell, -100, q);
      minNy = Math.min(minNy, q.ny);
    }
  }
  const deg = (Math.acos(minNy) * 180) / Math.PI;
  check(minNy > MIN_NY, `秋紅谷坡面最小 ny ${f3(minNy)}（最大坡度 ${deg.toFixed(1)}°）`);
  for (const p of patches) {
    if (p.kind === 'basin') continue;
    let m = 1;
    for (let r = 0; r < p.rows - 1; r++) {
      for (let c = 0; c < p.cols - 1; c++) {
        terrain.querySurface(p.x0 + (c + 0.5) * p.cell, p.z0 + (r + 0.5) * p.cell, -100, q);
        m = Math.min(m, q.ny);
      }
    }
    console.log(`INFO ${p.id} 最小 ny ${f3(m)}（${((Math.acos(m) * 180) / Math.PI).toFixed(1)}°，下沉廣場矮牆為可接受的陡坡）`);
  }
}

// ---------- 5. walkables ----------
{
  const q = {};
  const bridges = walkables.filter((w) => w.kind === 'bridge');
  let tested = 0;
  let okHigh = 0;
  let okLow = 0;
  let deckY = NaN;
  let bedY = NaN;
  for (const w of bridges) {
    // 矩形中心（段中點）
    let cx = 0;
    let cz = 0;
    for (let i = 0; i < w.poly.length; i += 2) {
      cx += w.poly[i] / 4;
      cz += w.poly[i + 1] / 4;
    }
    if (!pointInPolygon(cx, cz, basin.lake)) continue;
    const ground = terrain.heightAt(cx, cz);
    const deck = w.heightAt(cx, cz);
    if (ground > deck - 1) continue;
    tested++;
    terrain.querySurface(cx, cz, Infinity, q);
    if (Math.abs(q.y - deck) < 1e-9 && q.walkable) okHigh++;
    deckY = q.y;
    terrain.querySurface(cx, cz, ground + 0.1, q);
    if (Math.abs(q.y - ground) < 1e-9 && !q.walkable && q.kind === 'lakebed') okLow++;
    bedY = q.y;
  }
  check(tested > 0 && okHigh === tested, `紅橋（OSM ${bridges[0] ? bridges[0].id.split('#')[0] : '無'}）甲板：${tested} 段湖上中點 yHint 高 → 甲板 ${f3(deckY)}（${okHigh}/${tested}）`);
  check(tested > 0 && okLow === tested, `紅橋下 yHint 低於甲板 → 湖床 ${f3(bedY)}、kind lakebed（${okLow}/${tested}）`);
  const stairs = walkables.find((w) => w.kind === 'stairs');
  if (stairs) {
    let cx = 0;
    let cz = 0;
    for (let i = 0; i < stairs.poly.length; i += 2) {
      cx += stairs.poly[i] / 4;
      cz += stairs.poly[i + 1] / 4;
    }
    terrain.querySurface(cx, cz, Infinity, q);
    check(Math.abs(q.y - stairs.heightAt(cx, cz)) < 0.05, `下沉廣場大階梯斜面中點 y ${f3(q.y)}（斜面 ${f3(stairs.heightAt(cx, cz))}、高度場 ${f3(terrain.heightAt(cx, cz))}）`);
  } else check(false, '下沉廣場缺 stairs walkable');
  console.log(`INFO walkables ${walkables.length} 筆：${[...new Set(walkables.map((w) => w.id.split('#')[0]))].join('、')}`);
}

// ---------- 6. walkable 端點 / 湖邊棧板 / 北端坡道 / 退台邊線 ----------
{
  // 每個 walkable 端點與相鄰地面高差：端緣外 ENDPOINT_PROBE 處 heightAt 與端緣甲板高差 ≤ STEP_TOL（玩家 STEP_UP 0.35 以內）
  // 紅橋 / Z 字步道 = 折線兩端（端緣在湖中者無相鄰地面，不計）；下沉廣場大階梯 = 頂 / 底兩緣；木平台（qiuhonggu 追加）= 每一邊
  const ENDPOINT_PROBE = 0.3;
  const STEP_TOL = 0.3 + 1e-6; // 1e-6 只吸收 Float32 高度場的捨入
  const LATERAL = [-0.8, 0, 0.8]; // 端緣上取樣位置（半寬比例）
  const results = [];
  const probeEdge = (label, ax, az, bx, bz, ox, oz, deckAt) => {
    // (ax, az)→(bx, bz) 為端緣，(ox, oz) 為朝外單位向量
    let worst = 0;
    for (const f of LATERAL) {
      const t = (f + 1) / 2;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      worst = Math.max(worst, Math.abs(deckAt(x, z) - terrain.heightAt(x + ox * ENDPOINT_PROBE, z + oz * ENDPOINT_PROBE)));
    }
    results.push({ label, worst });
  };
  const chains = new Map();
  for (const w of walkables) {
    if (w.kind !== 'bridge' && w.kind !== 'boardwalk') continue;
    const k = w.id.split('#')[0];
    if (!chains.has(k)) chains.set(k, []);
    chains.get(k).push(w);
  }
  let inLake = 0;
  for (const [k, list] of chains) {
    list.sort((a, b) => Number(a.id.split('#')[1]) - Number(b.id.split('#')[1]));
    // segmentWalkables 矩形：頂點 0 / 3 為起端緣、1 / 2 為終端緣
    for (const [w, i0, i1, j0, j1] of [[list[0], 3, 0, 1, 2], [list[list.length - 1], 1, 2, 3, 0]]) {
      const P = w.poly;
      const ex = (P[i0 * 2] + P[i1 * 2]) / 2;
      const ez = (P[i0 * 2 + 1] + P[i1 * 2 + 1]) / 2;
      const L = Math.hypot(ex - (P[j0 * 2] + P[j1 * 2]) / 2, ez - (P[j0 * 2 + 1] + P[j1 * 2 + 1]) / 2);
      const ox = (ex - (P[j0 * 2] + P[j1 * 2]) / 2) / L;
      const oz = (ez - (P[j0 * 2 + 1] + P[j1 * 2 + 1]) / 2) / L;
      if (pointInPolygon(ex + ox * ENDPOINT_PROBE, ez + oz * ENDPOINT_PROBE, basin.lake)) {
        inLake++;
        continue;
      }
      probeEdge(`${k} ${w === list[0] ? '起' : '終'}端`, P[i0 * 2], P[i0 * 2 + 1], P[i1 * 2], P[i1 * 2 + 1], ox, oz, w.heightAt);
    }
  }
  const outward = (P, i, j) => {
    // 邊 i→j 的外法線（不指向多邊形內）
    const L = Math.hypot(P[j * 2] - P[i * 2], P[j * 2 + 1] - P[i * 2 + 1]);
    let nx = -(P[j * 2 + 1] - P[i * 2 + 1]) / L;
    let nz = (P[j * 2] - P[i * 2]) / L;
    if (pointInPolygon((P[i * 2] + P[j * 2]) / 2 + nx * 0.05, (P[i * 2 + 1] + P[j * 2 + 1]) / 2 + nz * 0.05, P)) {
      nx = -nx;
      nz = -nz;
    }
    return [nx, nz];
  };
  for (const w of walkables.filter((v) => v.kind === 'stairs')) {
    // 階梯 walkable 頂點 0→1 = 頂緣（街面）、2→3 = 底緣（廣場底）
    const P = w.poly;
    for (const [i, j, name] of [[0, 1, '頂緣'], [2, 3, '底緣']]) probeEdge(`${w.id} ${name}`, P[i * 2], P[i * 2 + 1], P[j * 2], P[j * 2 + 1], ...outward(P, i, j), w.heightAt);
  }
  // 木平台：與遊戲載入流程相同，由 qiuhonggu 追加（需要 three）
  const { buildQiuhonggu } = await import('../../src/qiuhonggu.js');
  buildQiuhonggu(terrain);
  const plat = walkables.find((w) => w.id.startsWith('platform:'));
  if (plat) {
    const P = plat.poly;
    const n = P.length / 2;
    for (let i = 0; i < n; i++) probeEdge(`${plat.id} 邊 ${i}`, P[i * 2], P[i * 2 + 1], P[((i + 1) % n) * 2], P[((i + 1) % n) * 2 + 1], ...outward(P, i, (i + 1) % n), plat.heightAt);
  }
  const bad = results.filter((r) => !(r.worst <= STEP_TOL));
  const kinds = ['bridge:', 'zigzag:', 'stairs:', 'platform:'].map((p) => results.filter((r) => r.label.startsWith(p)).length);
  check(
    bad.length === 0 && kinds.every((c) => c > 0),
    `walkable 端點與相鄰地面高差 ≤ 0.3（紅橋 ${kinds[0]}、Z 字 ${kinds[1]}、階梯 ${kinds[2]}、木平台 ${kinds[3]} 緣；湖中端 ${inLake} 個不計）最大 ${f3(Math.max(...results.map((r) => r.worst)))}${bad.length ? `；超標 ${bad.map((r) => `${r.label} ${f3(r.worst)}`).join('、')}` : ''}`,
  );
  const zig = results.filter((r) => r.label.startsWith('zigzag:'));
  console.log(`INFO 落地平台 ${terrain.landings.length} 處；Z 字步道岸端高差 ${zig.map((r) => f3(r.worst)).join(' / ')}`);

  // 湖邊木棧板：固定高度平板，footprint 內每點 ≥ heightAt + 0.02（patchMaxOver 精確最大值，另以隨機點獨立複核）
  const LAKESIDE_GAP = 0.02;
  for (const ls of terrain.lakesides) {
    let worst = Infinity;
    let worstRand = Infinity;
    for (const pc of ls.pieces) {
      worst = Math.min(worst, ls.y - terrain.maxHeightOver(pc.quad));
      const Q = pc.quad;
      for (let k = 0; k < 8; k++) {
        const u = rnd();
        const v = rnd();
        const ax = Q[0] + (Q[2] - Q[0]) * u;
        const az = Q[1] + (Q[3] - Q[1]) * u;
        const bx = Q[6] + (Q[4] - Q[6]) * u;
        const bz = Q[7] + (Q[5] - Q[7]) * u;
        worstRand = Math.min(worstRand, ls.y - terrain.heightAt(ax + (bx - ax) * v, az + (bz - az) * v));
      }
    }
    const total = ls.pieces.length + stats.lakesideSkipped;
    check(
      ls.pieces.length > 0 && worst >= LAKESIDE_GAP && worstRand >= LAKESIDE_GAP && ls.pieces.length / total > 0.9,
      `${ls.id} 棧板面 y ${f3(ls.y)}：${ls.pieces.length} 塊（略過 ${stats.lakesideSkipped}）面 − 其下地形最高點 最小 ${f3(worst)}（隨機點 ${f3(worstRand)}；≥ ${LAKESIDE_GAP}）`,
    );
  }

  // 北端坡道：鋪面帶格 kind = 'ramp'，中心線上取樣點 querySurface.kind = 'ramp'
  const q = {};
  for (const rp of terrain.rampPaths) {
    let n = 0;
    let ok = 0;
    for (let i = 0; i + 1 < rp.pts.length; i++) {
      const a = rp.pts[i];
      const b = rp.pts[i + 1];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      for (let s = 0.5; s < L; s += 1) {
        const x = a.x + ((b.x - a.x) * s) / L;
        const z = a.z + ((b.z - a.z) * s) / L;
        if (terrain.heightAt(x, z) > -0.05) continue; // 坡頂路面段
        n++;
        // querySurface 的 kind 以 OSM 步道優先（坡底與湖邊步道交會處為 sidewalk），格種類必為 ramp
        const kind = terrain.querySurface(x, z, Infinity, q).kind;
        if (terrain.cellKindAt(x, z) === 'ramp' && (kind === 'ramp' || kind === 'sidewalk')) ok++;
      }
    }
    const top = rp.pts[0];
    const bot = rp.pts[rp.pts.length - 1];
    check(n > 10 && ok === n, `${rp.id} 坡道中心線 ${n} 點 格 kind = ramp（${ok}/${n}）；坡頂 y ${f3(terrain.heightAt(top.x, top.z))} → 坡底 y ${f3(terrain.heightAt(bot.x, bot.z))}、鋪面格 ${stats.rampCells}`);
  }

  // 退台白色邊線為平滑折線：相鄰線段夾角最大值（網格階梯狀為 90°）
  let maxTurn = 0;
  for (const p of terrain.terracePaths) {
    for (let i = 3; i + 3 < p.length; i += 3) {
      const d1x = p[i] - p[i - 3];
      const d1z = p[i + 2] - p[i - 1];
      const d2x = p[i + 3] - p[i];
      const d2z = p[i + 5] - p[i + 2];
      const l = Math.hypot(d1x, d1z) * Math.hypot(d2x, d2z);
      if (l < 1e-12) continue;
      maxTurn = Math.max(maxTurn, (Math.acos(Math.max(-1, Math.min(1, (d1x * d2x + d1z * d2z) / l))) * 180) / Math.PI);
    }
  }
  console.log(`INFO 退台白色邊線 ${terrain.terracePaths.length} 條平滑折線，相鄰線段最大轉角 ${maxTurn.toFixed(1)}°`);
}

// ---------- 6b. 折線貼合切分（秋紅谷渲染網格；高度場 / 物理不變）----------
// 對照組 = 同一 patch 不帶 creases 的舊網格。量兩件事（修正前後數字）：
//  (1) 退台 / 邊坡上下緣：沿平滑折線往平台側 0.3 m 取樣，渲染法線（網格重心內插）偏離正上 > 2° 的比例（沿網格鋸齒時平台邊緣被斜面法線帶歪）
//  (2) 湖邊步道材質邊界：到湖岸 3 m（LAKE_WALKWAY）兩側 ±0.3 m 以外，渲染材質與「< 3 m 為鋪面」不符的比例（逐格判定時邊界呈 1.5 m 階梯）
{
  const p = basinPatch;
  const sampler = (m) => {
    const cellTris = new Map();
    for (let t = 0; t < m.indices.length; t += 3) {
      const cell = m.triCells[t / 3];
      if (!cellTris.has(cell)) cellTris.set(cell, []);
      cellTris.get(cell).push(t);
    }
    const surfOf = new Array(m.indices.length / 3);
    for (const g of m.groups) for (let t = g.start / 3; t < (g.start + g.count) / 3; t++) surfOf[t] = g.surface;
    return (x, z) => {
      const c = Math.min(p.cols - 2, Math.floor((x - p.x0) / p.cell));
      const r = Math.min(p.rows - 2, Math.floor((z - p.z0) / p.cell));
      for (const t of cellTris.get(r * (p.cols - 1) + c) || []) {
        const [a, b, cc] = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
        const P = m.positions;
        const det = (P[b * 3 + 2] - P[cc * 3 + 2]) * (P[a * 3] - P[cc * 3]) + (P[cc * 3] - P[b * 3]) * (P[a * 3 + 2] - P[cc * 3 + 2]);
        const l1 = ((P[b * 3 + 2] - P[cc * 3 + 2]) * (x - P[cc * 3]) + (P[cc * 3] - P[b * 3]) * (z - P[cc * 3 + 2])) / det;
        const l2 = ((P[cc * 3 + 2] - P[a * 3 + 2]) * (x - P[cc * 3]) + (P[a * 3] - P[cc * 3]) * (z - P[cc * 3 + 2])) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
        const N = m.normals;
        const nx = l1 * N[a * 3] + l2 * N[b * 3] + l3 * N[cc * 3];
        const ny = l1 * N[a * 3 + 1] + l2 * N[b * 3 + 1] + l3 * N[cc * 3 + 1];
        const nz = l1 * N[a * 3 + 2] + l2 * N[b * 3 + 2] + l3 * N[cc * 3 + 2];
        return { ny: ny / Math.hypot(nx, ny, nz), surface: surfOf[t / 3] };
      }
      return null;
    };
  };
  const mNew = buildPatchMesh(p);
  const mOld = buildPatchMesh({ ...p, creases: null });
  const sNew = sampler(mNew);
  const sOld = sampler(mOld);
  const TILT = Math.cos((2 * Math.PI) / 180);
  let nFlat = 0;
  let badNew = 0;
  let badOld = 0;
  for (const cp of p.creases.paths) {
    const L = cp.pts;
    for (let i = 0; i + 5 < L.length; i += 3) {
      const mx = (L[i] + L[i + 3]) / 2;
      const mz = (L[i + 2] + L[i + 5]) / 2;
      const len = Math.hypot(L[i + 3] - L[i], L[i + 5] - L[i + 2]);
      if (len < 1e-6) continue;
      const nx = -(L[i + 5] - L[i + 2]) / len;
      const nz = (L[i + 3] - L[i]) / len;
      // 平台側 = 高度場較接近平台的一側（上緣平台在上、下緣平台在下）
      const ha = terrain.heightAt(mx + nx * 0.3, mz + nz * 0.3);
      const hb = terrain.heightAt(mx - nx * 0.3, mz - nz * 0.3);
      const side = (ha > hb) === cp.flatAbove ? 1 : -1;
      const x = mx + nx * 0.3 * side;
      const z = mz + nz * 0.3 * side;
      const a = sNew(x, z);
      const b = sOld(x, z);
      if (!a || !b) continue;
      nFlat++;
      if (a.ny < TILT) badNew++;
      if (b.ny < TILT) badOld++;
    }
  }
  const pct = (k, n) => `${((100 * k) / Math.max(1, n)).toFixed(1)}%`;
  check(nFlat > 1000 && badNew * 10 <= badOld,
    `退台 / 邊坡上下緣折線 ${p.creases.paths.length} 條：平台側 0.3 m 取樣 ${nFlat} 點，法線偏離正上 > 2° 者 修正前 ${badOld}（${pct(badOld, nFlat)}）→ 修正後 ${badNew}（${pct(badNew, nFlat)}）`);

  const lake = basin.lake ? basin.lake : null;
  if (lake) {
    const q = {};
    let nW = 0;
    let wrongNew = 0;
    let wrongOld = 0;
    for (let i = 0; i < 40000; i++) {
      const x = p.x0 + rnd() * (p.x1 - p.x0);
      const z = p.z0 + rnd() * (p.z1 - p.z0);
      if (pointInPolygon(x, z, lake)) continue;
      const d = Math.sqrt(closestOnPolygon(x, z, lake, q).d2);
      if (d > 5 || Math.abs(d - 3) < 0.3) continue;
      const kind = terrain.cellKindAt(x, z);
      if (!['walkway', 'grass', 'terrace', 'riser', 'ramp'].includes(kind)) continue;
      const a = sNew(x, z);
      const b = sOld(x, z);
      if (!a || !b) continue;
      nW++;
      const want = d < 3 ? 'concrete' : 'grass';
      if (a.surface !== want) wrongNew++;
      if (b.surface !== want) wrongOld++;
    }
    check(nW > 500 && wrongNew === 0,
      `湖邊步道材質邊界（到湖岸 3 m）±0.3 m 外 ${nW} 點：材質不符 修正前 ${wrongOld}（${pct(wrongOld, nW)}）→ 修正後 ${wrongNew}（${pct(wrongNew, nW)}）`);
  }
  const rendered = patches.reduce((sum, q) => sum + (q === p ? mNew : buildPatchMesh(q)).indices.length / 3, 0);
  check(rendered <= 100000, `折線切分：秋紅谷 ${mNew.splitTriangles} 個三角形切開、新增頂點 ${mNew.addedVertices}；渲染網格總三角形 ${rendered}（修正前 ${stats.triangles}，≤ 100000）`);
}

// ---------- 7. 效能與統計 ----------
{
  const q = {};
  const n = 20000;
  const s0 = performance.now();
  for (let i = 0; i < n; i++) terrain.querySurface(basinPatch.x0 + rnd() * 220, basinPatch.z0 + rnd() * 310, Infinity, q);
  const us = ((performance.now() - s0) * 1000) / n;
  check(us < 50, `querySurface 平均 ${us.toFixed(2)} µs / 次（谷地範圍隨機 ${n} 次）`);
  console.log(`INFO createTerrain ${buildMs.toFixed(0)} ms；patch ${patches.length} 個`);
  for (const p of stats.patches) console.log(`INFO   ${p.id}：cell ${p.cell} m、${p.cols}×${p.rows} 頂點（${p.width}×${p.depth} m）、${p.triangles} 三角形`);
  check(stats.triangles <= 100000, `patch 網格總三角形 ${stats.triangles}（≤ 100000）`);
  console.log(`INFO 秋紅谷下凹體積 ${Math.round(stats.basinVolume)} m³（§6.1 滯洪量約 20 萬 m³）`);
  console.log(`INFO 建築平台：壓平 ${stats.flattened.length} 棟、嵌入邊坡（取最小值）${stats.embedded.length} 棟${stats.embedded.map((b) => ` ${b.id}${b.name}`).join('')}`);
  console.log(`INFO 退台白色邊線 ${terrain.terraceLines.length / 6} 段`);
}

if (failed) {
  console.log(`\n${failed} 項失敗`);
  process.exit(1);
}
console.log('\n全部通過');
