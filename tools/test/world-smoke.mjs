#!/usr/bin/env node
// world.js 無頭冒煙（Node + node_modules/three）：最小 mock document / canvas，跑 buildWorld 統計 mesh 數、三角形數與地面 draw call
// JSON 以 loader hook 轉成 ES module（等同 Vite 的 JSON import），不改正式碼
// 用法：node tools/test/world-smoke.mjs（buildWorld 失敗或地面 draw call 超標時 exit 1）
import { register } from 'node:module';

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

const GROUND_DRAW_BEFORE = 7; // 改版前地面圖層 draw call：地面、草地、水面、步道、車道、黃線、白線（另加路名地面字圖集）
const MAX_EXTRA_DRAW = 6;

// 2D context：所有方法 no-op，measureText 給固定寬度
const ctx2d = new Proxy({}, {
  get: (_, k) => (k === 'measureText' ? () => ({ width: 100 }) : () => {}),
  set: () => true,
});
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d, style: {} }),
};

const THREE = await import('three');
const { buildWorld } = await import('../../src/world.js');
const { water, parks } = await import('../../src/citymodel.js');
const { getTerrain } = await import('../../src/terrain.js');
const { pointInPolygon } = await import('../../src/geom.js');

const scene = new THREE.Scene();
const t0 = performance.now();
const { group, stats, trees } = buildWorld(scene);
const ms = performance.now() - t0;

let meshes = 0;
let draws = 0;
let tris = 0;
let groundDraws = 0;
let labelDraws = 0;
let terrainDraws = 0;
group.traverse((o) => {
  if (!o.isMesh) return;
  meshes++;
  const g = o.geometry;
  const count = g.index ? g.index.count : g.attributes.position.count;
  const inst = o.isInstancedMesh ? o.count : 1;
  const d = Array.isArray(o.material) ? g.groups.length : 1;
  draws += d;
  tris += (count / 3) * inst;
  if (o.isInstancedMesh) return;
  if (o.name === 'terrain') terrainDraws += d;
  else if (o.material.transparent) labelDraws += d; // 路名地面字圖集
  else groundDraws += d;
});
console.log(`buildWorld ${ms.toFixed(0)} ms：mesh ${meshes}、draw call ${draws}、三角形 ${Math.round(tris)}（含實例）`);
console.log(`地面圖層 draw call：既有圖層 ${groundDraws}（改版前 ${GROUND_DRAW_BEFORE}）+ 路名圖集 ${labelDraws} + 地形 patch ${terrainDraws}`);
const street = scene.getObjectByName('street-details');
let streetDraws = 0;
if (street) street.traverse((o) => o.isMesh && streetDraws++);
console.log(`街道細節（與 world 群組並列，不計入地面圖層）：draw call ${streetDraws}`);
console.log(`地形 patch 三角形 ${stats.patchTriangles}；路名 ${stats.labels}、行道樹 ${stats.streetTrees}、公園樹 ${stats.parkTrees}、路燈 ${stats.lamps}`);
const terrain = getTerrain();
const basinPoly = parks.find((p) => terrain.coveredAreaIds.has(p.id)).poly;
const inBasin = trees.filter((t) => pointInPolygon(t.x, t.z, basinPoly));
const inLake = trees.filter((t) => water.some((w) => pointInPolygon(t.x, t.z, w.poly)));
const onSlope = inBasin.filter((t) => terrain.heightAt(t.x, t.z) < -0.5).length;
console.log(`秋紅谷內樹 ${inBasin.length} 棵（其中坡面 / 谷底 ${onSlope} 棵）、湖面上 ${inLake.length} 棵`);
if (!street || street.parent !== scene || streetDraws === 0) {
  console.log('FAIL 街道細節群組不在場景中');
  process.exit(1);
}
if (inLake.length) {
  console.log('FAIL 湖面上有樹');
  process.exit(1);
}
const extra = groundDraws + terrainDraws - GROUND_DRAW_BEFORE;
if (extra > MAX_EXTRA_DRAW || terrainDraws === 0) {
  console.log(`FAIL 地面 draw call 增加 ${extra}（上限 ${MAX_EXTRA_DRAW}）`);
  process.exit(1);
}
console.log(`OK   地面 draw call 增加 ${extra}（上限 ${MAX_EXTRA_DRAW}）`);
