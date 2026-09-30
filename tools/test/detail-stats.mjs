// D3 樓宇 / 街道細節產生器無頭驗證：node tools/test/detail-stats.mjs
// 以最小 document / canvas mock 讓 three 的 CanvasTexture 可建立；citymodel.js 內的 JSON import 以 loader hook 轉成 ES module。
// mock terrain：heightAt = 0、buildingBase = 0，秋紅谷外框（osm-city.json T.basins[0].p）內回傳 −6。
// 任一斷言失敗 exit 1。
import { register } from 'node:module';
import fs from 'node:fs';

register(
  'data:text/javascript,' +
    encodeURIComponent(`
import fs from 'node:fs';
export async function load(url, context, next) {
  if (url.endsWith('.json')) {
    return { format: 'module', shortCircuit: true, source: 'export default ' + fs.readFileSync(new URL(url), 'utf8') + ';' };
  }
  return next(url, context);
}`),
);

// ---------- 最小 DOM / canvas mock ----------
const ctx2d = new Proxy({}, {
  get: (t, k) => (k in t ? t[k] : k === 'measureText' ? () => ({ width: 10 }) : () => {}),
  set: (t, k, v) => ((t[k] = v), true),
});
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }) };

const root = new URL('../../', import.meta.url);
const osm = JSON.parse(fs.readFileSync(new URL('src/data/osm-city.json', root), 'utf8'));
const { buildings, surfaceRoads, surfaceFootways, junctions } = await import(new URL('src/citymodel.js', root));
const { pointInPolygon } = await import(new URL('src/geom.js', root));
const { buildFacadeDetails } = await import(new URL('src/facade.js', root));
const { buildStreetDetails } = await import(new URL('src/street.js', root));
const THREE = await import('three');

const basin = osm.T.basins[0].p;
const BASIN_Y = -6;
const flatTerrain = {
  heightAt: (x, z) => (pointInPolygon(x, z, basin) ? BASIN_Y : 0),
  buildingBase: () => 0,
  querySurface(x, z, yHint, out = {}) {
    out.y = this.heightAt(x, z);
    out.nx = 0;
    out.ny = 1;
    out.nz = 0;
    out.kind = out.y < 0 ? 'basin' : 'ground';
    return out;
  },
};
// 傾斜地形（驗證 y 確實取自 terrain，而非寫死 0；盆地外皆 ≥ 0，不誤觸下凹判定）
const tiltTerrain = { ...flatTerrain, heightAt: (x, z) => flatTerrain.heightAt(x, z) + (x + 600) * 0.004 + (z + 700) * 0.003, buildingBase: (id) => (id % 7) * 0.1 };

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
}

const SEED = 20260930;
const run = (terrain) => ({
  facade: buildFacadeDetails(buildings, { terrain, seed: SEED, anisotropy: 1, landmarks: new Map(), roads: surfaceRoads }),
  street: buildStreetDetails({
    roads: surfaceRoads, footways: surfaceFootways, junctions, buildings, terrain, seed: SEED, anisotropy: 1, basins: [basin],
  }),
});

const t0 = Date.now();
const A = run(flatTerrain);
const buildMs = Date.now() - t0;
const B = run(flatTerrain);
const T = run(tiltTerrain);

const meshes = (g) => {
  const out = [];
  g.traverse((o) => o.isMesh && out.push(o));
  return out;
};
const vertexCounts = (g) => meshes(g).map((m) => `${m.name}:${m.geometry.attributes.position.count}:${m.isInstancedMesh ? m.count : 1}`).join(',');

// ---------- 統計 ----------
for (const [k, r] of Object.entries({ facade: A.facade, street: A.street })) {
  const s = r.stats;
  console.log(`${k}: meshes=${s.meshes} triangles=${s.triangles} vertices=${s.vertices}`);
}
const fs1 = A.facade.stats;
const ss1 = A.street.stats;
console.log(`facade counts: parapets=${fs1.parapets} setbacks=${fs1.setbacks} setbackSkipped=${fs1.setbackSkipped} roofUnits=${fs1.roofUnits} waterTanks=${fs1.waterTanks} arcadeBuildings=${fs1.arcadeBuildings} arcadeColumns=${fs1.arcadeColumns} canopyBuildings=${fs1.canopyBuildings} balconies=${fs1.balconies}`);
console.log(`street counts: sidewalkLength=${ss1.sidewalkLength}m junctionPatches=${ss1.junctionPatches} crosswalks=${ss1.crosswalks} stopLines=${ss1.stopLines} scooterBoxes=${ss1.scooterBoxes} treePits=${ss1.treePits} signalPoles=${ss1.signalPoles} scooterBays=${ss1.scooterBays} hydrants=${ss1.hydrants} bins=${ss1.bins} busStops=${ss1.busStops}`);
console.log(`build time (facade + street, 1 run): ${buildMs} ms`);

// ---------- 斷言 ----------
// 無 NaN（幾何頂點與實例矩陣）
let nan = 0;
for (const r of [A, T]) {
  for (const m of [...meshes(r.facade.group), ...meshes(r.street.group)]) {
    for (const v of m.geometry.attributes.position.array) if (!Number.isFinite(v)) nan++;
    if (m.isInstancedMesh) for (let i = 0; i < m.count * 16; i++) if (!Number.isFinite(m.instanceMatrix.array[i])) nan++;
  }
}
check('無 NaN 頂點 / 實例矩陣', nan === 0, `nan=${nan}`);

// 女兒牆頂點 y ≥ 建築頂（平地與傾斜地形兩組）
for (const [label, r] of [['flat', A], ['tilt', T]]) {
  const pm = r.facade.group.getObjectByName('facade-parapets');
  const pos = pm.geometry.attributes.position.array;
  let bad = 0;
  let checked = 0;
  for (const sp of pm.geometry.userData.spans) {
    for (let i = sp.start; i < sp.end; i++) {
      checked++;
      if (pos[i * 3 + 1] < sp.top - 1e-4) bad++;
    }
  }
  check(`女兒牆頂點 y ≥ 建築頂（${label}）`, bad === 0 && checked > 0, `checked=${checked} bad=${bad}`);
}

// 街具實例 y 與 terrain.heightAt 差 < 0.05；盆地內無街具
for (const [label, r, terrain] of [['flat', A, flatTerrain], ['tilt', T, tiltTerrain]]) {
  const m4 = new THREE.Matrix4();
  const p = new THREE.Vector3();
  let n = 0;
  let maxDy = 0;
  let inBasin = 0;
  for (const m of meshes(r.street.group)) {
    if (!m.isInstancedMesh) continue;
    for (let i = 0; i < m.count; i++) {
      m.getMatrixAt(i, m4);
      p.setFromMatrixPosition(m4);
      n++;
      maxDy = Math.max(maxDy, Math.abs(p.y - terrain.heightAt(p.x, p.z)));
      if (pointInPolygon(p.x, p.z, basin)) inBasin++;
    }
  }
  check(`街具 instance y 與 heightAt 差 < 0.05（${label}）`, n > 0 && maxDy < 0.05, `instances=${n} maxDy=${maxDy.toFixed(4)}`);
  check(`盆地內無街具（${label}）`, inBasin === 0, `inBasin=${inBasin}`);
}

// 人行道 / 路口鋪面頂點也跟著地形（傾斜地形：每個頂點 y − heightAt 落在 [−0.05, 0.25]）
{
  let bad = 0;
  let n = 0;
  for (const name of ['street-sidewalk', 'street-sidewalk-strip', 'street-junction', 'street-markings', 'street-tree-pits']) {
    const m = T.street.group.getObjectByName(name);
    const a = m.geometry.attributes.position.array;
    for (let i = 0; i < a.length; i += 3) {
      n++;
      const dy = a[i + 1] - tiltTerrain.heightAt(a[i], a[i + 2]);
      if (dy < -0.05 || dy > 0.25) bad++;
    }
  }
  check('地面細節頂點 y 取自 terrain（tilt）', bad === 0, `vertices=${n} bad=${bad}`);
}

// 屋頂退台：主體降 tierH，主體 + 退台 = OSM 高度（真實性優先）
{
  const byId = new Map(buildings.map((b) => [b.id, b]));
  let bad = 0;
  for (const [id, body] of A.facade.bodies) {
    const b = byId.get(id);
    if (!b || Math.abs(body.height + body.tierH - b.height) > 1e-9 || !(body.height > 0)) bad++;
  }
  check('退台建築總高 = OSM 高度', A.facade.bodies.size === fs1.setbacks && bad === 0, `bodies=${A.facade.bodies.size} setbacks=${fs1.setbacks} bad=${bad}`);
}

// 同一 seed 兩次產生：頂點數完全相同
check('同 seed 兩次頂點數相同（facade）', vertexCounts(A.facade.group) === vertexCounts(B.facade.group) && A.facade.stats.vertices === B.facade.stats.vertices, `vertices=${A.facade.stats.vertices}/${B.facade.stats.vertices}`);
check('同 seed 兩次頂點數相同（street）', vertexCounts(A.street.group) === vertexCounts(B.street.group) && A.street.stats.vertices === B.street.stats.vertices, `vertices=${A.street.stats.vertices}/${B.street.stats.vertices}`);

// 效能預算
const draws = fs1.meshes + ss1.meshes;
const tris = fs1.triangles + ss1.triangles;
check('draw call ≤ 30', draws <= 30, `drawCalls=${draws}`);
check('三角形 ≤ 450000', tris <= 450000, `triangles=${tris}`);

// 各類數量皆 > 0（公車站牌依資料應為 0）
for (const [k, v] of Object.entries({
  parapets: fs1.parapets, setbacks: fs1.setbacks, roofUnits: fs1.roofUnits, arcadeBuildings: fs1.arcadeBuildings, canopyBuildings: fs1.canopyBuildings, balconies: fs1.balconies,
  crosswalks: ss1.crosswalks, stopLines: ss1.stopLines, scooterBoxes: ss1.scooterBoxes, signalPoles: ss1.signalPoles, scooterBays: ss1.scooterBays, junctionPatches: ss1.junctionPatches,
})) check(`${k} > 0`, v > 0, `${v}`);
check('無 bus_stop 資料 → 公車站牌 0', ss1.busStops === 0 && !JSON.stringify(osm).includes('bus_stop'));

// 關閉旗標：回傳空群組
const off = buildFacadeDetails(buildings, { terrain: flatTerrain, enabled: false });
const off2 = buildStreetDetails({ roads: surfaceRoads, terrain: flatTerrain, enabled: false });
check('enabled=false 回傳空群組', off.stats.meshes === 0 && off2.stats.meshes === 0);

console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
