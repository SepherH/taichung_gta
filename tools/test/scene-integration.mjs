#!/usr/bin/env node
// I2 場景整合無頭檢查（Node + node_modules/three）：照 main.js 的建構順序
//   buildWorld → buildQiuhonggu → stripDeckOverlays → loadLandmarkModels → buildBuildings
// 統計場景 draw call / 三角形 / 貼圖數，並檢查：facade / street 群組在場景中、可平鋪貼圖已套用且失敗時退回、
// 夜間窗光材質仍登記、紅橋 glb 甲板頂面與 terrain.walkables 紅橋甲板高度差、展示館底部 ≈ 路面、所有地標底部不浮空不深埋。
// mock：最小 document / canvas、<img>（依 public/ 是否有檔決定 load / error）、fetch / Request（讀 public/ 檔案，GLTFLoader 可解析 glb）
// JSON 以 loader hook 轉成 ES module（等同 Vite 的 JSON import）
// 用法：node tools/test/scene-integration.mjs（任一斷言失敗 exit 1）；TILES=off 模擬貼圖全部載入失敗
import { register } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLIC = path.join(ROOT, 'public');
const TILES_OFF = process.env.TILES === 'off';

const DECK_TOL = 0.1; // 紅橋 glb 甲板 vs walkables 甲板（規格 < 0.1 m；超過只列出供裁決，不 FAIL）
const BOTTOM_TOL = 0.3; // 地標底部 vs 地面
const PAVILION_TOL = 0.05; // 展示館原點 vs 路面

// ---------- mock ----------
const ctx2d = new Proxy({}, {
  get: (_, k) => (k === 'measureText' ? () => ({ width: 100 }) : () => {}),
  set: () => true,
});
// 相對 base './' 的 URL → public/ 下的檔案路徑
const toFile = (url) => path.join(PUBLIC, String(url).replace(/^(\.\/|\/)/, '').split('?')[0]);
class FakeImage {
  constructor() {
    this.listeners = {};
    this.width = 0;
    this.height = 0;
    this.complete = false;
  }

  addEventListener(type, fn) {
    this.listeners[type] = fn;
  }

  removeEventListener(type) {
    delete this.listeners[type];
  }

  set src(url) {
    this._src = url;
    const ok = !TILES_OFF && fs.existsSync(toFile(url));
    setTimeout(() => {
      if (ok) {
        this.width = 512;
        this.height = 512;
        this.complete = true;
      }
      const fn = this.listeners[ok ? 'load' : 'error'];
      if (fn) fn.call(this, { type: ok ? 'load' : 'error' });
    }, 0);
  }

  get src() {
    return this._src;
  }
}
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d, style: {} }),
  createElementNS: (_, name) => (name === 'img' ? new FakeImage() : { width: 0, height: 0, getContext: () => ctx2d, style: {} }),
};
// Node 的 Request 不接受相對 URL：換成只記 url 的最小版本（FileLoader 用 new Request(url) + fetch(req)）
globalThis.Request = class {
  constructor(url, opts = {}) {
    this.url = url;
    this.headers = opts.headers;
  }
};
globalThis.ProgressEvent = class {
  constructor(type, init = {}) {
    Object.assign(this, { type }, init);
  }
};
globalThis.fetch = async (req) => {
  const url = typeof req === 'string' ? req : req.url;
  const file = toFile(url);
  if (!fs.existsSync(file)) return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
  const type = file.endsWith('.json') ? 'application/json' : 'application/octet-stream';
  return new Response(fs.readFileSync(file), { status: 200, headers: { 'content-type': type } });
};

const THREE = await import('three');
const { getTerrain, surfaceFootways, surfaceRoads } = await import('../../src/citymodel.js');
const { buildWorld } = await import('../../src/world.js');
const { buildQiuhonggu, stripDeckOverlays } = await import('../../src/qiuhonggu.js');
const { buildBuildings } = await import('../../src/buildings.js');
const { loadLandmarkModels } = await import('../../src/landmarks/index.js');
const { nightMaterials } = await import('../../src/daynight.js');
const street = await import('../../src/street.js');
const { closestOnSegment, pointInPolygon } = await import('../../src/geom.js');

let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${msg}`);
  if (!ok) failed++;
};
const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : String(v));

// ---------- 照 main.js 的順序建構 ----------
const terrain = getTerrain();
const scene = new THREE.Scene();
const t0 = performance.now();
const world = buildWorld(scene, { anisotropy: 4 });
const qiuhonggu = buildQiuhonggu(terrain, { footways: surfaceFootways });
scene.add(qiuhonggu.group);
const stripped = stripDeckOverlays(world.group, terrain);
const landmarks = await loadLandmarkModels();
const buildings = buildBuildings(scene, { anisotropy: 4, landmarks });
if (street.tilesSettled) await street.tilesSettled();
else await new Promise((r) => setTimeout(r, 50));
scene.updateMatrixWorld(true);
const ms = performance.now() - t0;

// ---------- 統計 ----------
const TEX_KEYS = ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap', 'bumpMap', 'lightMap'];
function sceneStats(root) {
  let draws = 0;
  let tris = 0;
  const textures = new Set();
  const sources = new Set();
  const tileSources = new Set();
  root.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    const g = o.geometry;
    const count = g.index ? g.index.count : g.attributes.position.count;
    const inst = o.isInstancedMesh ? o.count : 1;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    draws += Array.isArray(o.material) ? g.groups.length : 1;
    tris += Array.isArray(o.material) ? (g.groups.reduce((s, gr) => s + gr.count, 0) / 3) * inst : (count / 3) * inst;
    for (const m of mats) {
      const list = TEX_KEYS.map((k) => m[k]);
      if (m.userData && m.userData.windowMap) list.push(m.userData.windowMap);
      for (const t of list) {
        if (!t || !t.isTexture) continue;
        textures.add(t);
        sources.add(t.source);
        if (t.userData && t.userData.tile) tileSources.add(t.userData.tile);
      }
    }
  });
  return { draws, tris: Math.round(tris), textures: textures.size, sources: sources.size, tiles: [...tileSources].sort() };
}
const S = sceneStats(scene);
console.log(`場景建構 ${ms.toFixed(0)} ms（含 glb 解析）；stripDeckOverlays 回傳 ${stripped}`);
console.log(`STAT draw call ${S.draws}、三角形 ${S.tris}、貼圖物件 ${S.textures}、貼圖來源（GPU 上傳）${S.sources}`);
console.log(`STAT 已套用可平鋪貼圖 ${S.tiles.length} 種：${S.tiles.join(', ') || '無'}`);
for (const name of ['world', 'street-details', 'facade-details', 'qiuhonggu', 'name-plates']) {
  const g = scene.getObjectByName(name);
  if (g) console.log(`STAT   ${name}：${JSON.stringify(sceneStats(g)).replace(/"tiles":\[[^\]]*\],?/, '')}`);
}
{
  let d = 0;
  let t = 0;
  for (const o of buildings.landmarkObjects) {
    const s = sceneStats(o);
    d += s.draws;
    t += s.tris;
  }
  console.log(`STAT   地標 glb ${buildings.landmarkObjects.length} 個：draw call ${d}、三角形 ${t}`);
}

// ---------- 1. facade / street 群組在場景中 ----------
for (const name of ['facade-details', 'street-details']) {
  const g = scene.getObjectByName(name);
  let meshes = 0;
  if (g) g.traverse((o) => o.isMesh && meshes++);
  let inScene = false;
  for (let p = g; p; p = p.parent) if (p === scene) inScene = true;
  check(!!g && inScene && meshes > 0, `${name} 群組在場景中（mesh ${meshes}）`);
}

// ---------- 2. 可平鋪貼圖 ----------
{
  const want = ['asphalt', 'concrete', 'glass_blue', 'glass_dark', 'grass', 'sidewalk_gray', 'sidewalk_redbrick', 'stone_cream', 'stone_granite'];
  if (TILES_OFF) check(S.tiles.length === 0, `貼圖全部載入失敗 → 退回 canvas 貼圖（已套用 ${S.tiles.length} 種）`);
  else check(want.every((k) => S.tiles.includes(k)), `9 種可平鋪貼圖都已套用（${S.tiles.length}/9）`);
  // 平鋪設定：RepeatWrapping + sRGB + anisotropy 沿用參數
  let bad = 0;
  let n = 0;
  scene.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      const t = m.map;
      if (!t || !t.userData || !t.userData.tile) continue;
      n++;
      if (t.wrapS !== THREE.RepeatWrapping || t.wrapT !== THREE.RepeatWrapping || t.colorSpace !== THREE.SRGBColorSpace || t.anisotropy !== 4) bad++;
    }
  });
  check(bad === 0, `可平鋪貼圖 ${n} 處：RepeatWrapping / SRGB / anisotropy 4 不符 ${bad} 處`);
}

// ---------- 3. 夜間窗光 ----------
{
  const night = new Set(nightMaterials.map((e) => e.material));
  let walls = 0;
  let lit = 0;
  for (const m of buildings.meshes) {
    const mat = m.material;
    if (!mat.emissiveMap) continue;
    walls++;
    if (night.has(mat) && mat.emissive.getHex() === 0xffffff) lit++;
  }
  check(walls > 0 && lit === walls, `帶窗光的建築外牆材質 ${walls} 組，皆登記 registerNight 且保留 emissiveMap（${lit}/${walls}）`);
}

// ---------- 4. 地標高度對齊 ----------
const byFile = new Map();
for (const { entry, object } of landmarks.values()) byFile.set(entry.file, { entry, object });
check(byFile.size === 12, `manifest 地標載入 ${byFile.size} / 12`);

// 地面：footprint 地標 = 錨點高度場；基準為水面 / 路面者 = 該基準面
const lake = terrain.lakes[0];
const rows = [];
let maxBottom = 0;
for (const { entry, object } of byFile.values()) {
  const box = new THREE.Box3().setFromObject(object);
  const datum = object.userData.datum || 'landmarkBase';
  let bottom;
  let ground;
  if (datum === 'water') {
    // 原點 = 湖水面：底部取原點（墩柱依 notes 下伸入水 1.5 m，屬設計）
    bottom = object.position.y;
    ground = lake ? lake.y : NaN;
  } else if (datum === 'road') {
    bottom = object.position.y;
    ground = 0; // 七期路面（reference §6.6：谷外全區 y = 0）
  } else {
    bottom = box.min.y;
    ground = terrain.heightAt(object.position.x, object.position.z);
  }
  const d = Math.abs(bottom - ground);
  maxBottom = Math.max(maxBottom, d);
  rows.push({ name: entry.name, datum, bottom, ground, min: box.min.y, d });
}
for (const r of rows) console.log(`LM   ${r.name}｜基準 ${r.datum}｜底部 y ${f3(r.bottom)}｜地面 y ${f3(r.ground)}｜模型最低點 ${f3(r.min)}`);
check(rows.length > 0 && maxBottom < BOTTOM_TOL, `所有地標底部與地面差最大 ${f3(maxBottom)} m（< ${BOTTOM_TOL}）`);

const pavilion = byFile.get('qiuhonggu_pavilion.glb');
check(!!pavilion && pavilion.object.userData.datum === 'road' && Math.abs(pavilion.object.position.y) < PAVILION_TOL,
  `展示館基準 = 路面：原點 y ${pavilion ? f3(pavilion.object.position.y) : '無'}（路面 0）`);

// 紅橋：glb 甲板頂面（沿 walkables 各段中心線向下打射線，取第一個朝上的面）vs terrain.walkables 甲板
const bridge = byFile.get('qiuhonggu_red_bridge.glb');
const deckWalk = terrain.walkables.filter((w) => w.kind === 'bridge');
if (bridge && deckWalk.length) {
  check(bridge.object.userData.datum === 'water' && Math.abs(bridge.object.position.y - lake.y) < 1e-6, `紅橋基準 = 湖水面：原點 y ${f3(bridge.object.position.y)}（水面 ${f3(lake.y)}）`);
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const diffs = [];
  let missed = 0;
  for (const w of deckWalk) {
    const p = w.poly;
    // 段矩形中心與中心線上 ±30% 兩點
    const cx = (p[0] + p[2] + p[4] + p[6]) / 4;
    const cz = (p[1] + p[3] + p[5] + p[7]) / 4;
    const ax = (p[0] + p[6]) / 2;
    const az = (p[1] + p[7]) / 2;
    const bx = (p[2] + p[4]) / 2;
    const bz = (p[3] + p[5]) / 2;
    for (const t of [-0.3, 0, 0.3]) {
      const x = cx + (bx - ax) * t;
      const z = cz + (bz - az) * t;
      ray.set(new THREE.Vector3(x, w.heightAt(x, z) + 5, z), down);
      const hit = ray.intersectObject(bridge.object, true).find((h) => h.face && h.face.normal.clone().transformDirection(h.object.matrixWorld).y > 0.9);
      if (!hit) {
        missed++;
        continue;
      }
      diffs.push(hit.point.y - w.heightAt(x, z));
    }
  }
  const maxAbs = diffs.reduce((m, d) => Math.max(m, Math.abs(d)), 0);
  const mean = diffs.reduce((s, d) => s + d, 0) / (diffs.length || 1);
  console.log(`INFO 紅橋甲板：glb 頂面 − walkables 甲板 平均 ${mean.toFixed(4)} m、最大 |差| ${maxAbs.toFixed(4)} m（${diffs.length} 點命中、${missed} 點未命中；walkables 甲板 y ${f3(deckWalk[0].heightAt(0, 0))}）`);
  check(diffs.length > 0, `紅橋 glb 甲板射線命中 ${diffs.length} 點`);
  console.log(`${maxAbs < DECK_TOL - 5e-4 ? 'OK  ' : 'WARN'} 紅橋甲板高度差 ${maxAbs.toFixed(4)} m（規格 < ${DECK_TOL}；不符時以 glb 為視覺，列出供裁決，不改 terrain）`);
  // glb 存在 → 程序化紅橋甲板 / 欄杆 / 柱墩已移除；Z 字步道仍在
  check(qiuhonggu.group.userData.redBridge === 'glb', `程序化紅橋網格已讓位給 glb（qiuhonggu.userData.redBridge = ${qiuhonggu.group.userData.redBridge}）`);
} else check(false, '紅橋 glb 或 walkables 紅橋甲板缺漏');

// ---------- 5. 招牌名稱去掉 Blender「.數字」後綴 ----------
{
  const texts = [];
  for (const { object } of byFile.values()) object.traverse((o) => o.userData.signText && texts.push(o.userData.signText));
  const bad = texts.filter((t) => /\.\d+$/.test(t));
  check(texts.length > 0 && bad.length === 0, `招牌 ${texts.length} 面，文字帶「.數字」後綴 ${bad.length} 面（${texts.join('、')}）`);
}

// ---------- 6. world 源頭不畫紅橋甲板 ribbon ----------
// 判定同 stripDeckOverlays：三頂點都在紅橋 walkable 範圍內、且高出甲板 0–0.1 m
{
  const decks = terrain.walkables.filter((w) => w.kind === 'bridge');
  let onDeck = 0;
  world.group.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || o.name === 'terrain') return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += 3) {
      let all = true;
      for (let k = 0; k < 3 && all; k++) {
        const x = pos.getX(i + k);
        const y = pos.getY(i + k);
        const z = pos.getZ(i + k);
        all = decks.some((w) => {
          const dy = y - w.heightAt(x, z);
          return dy > 0 && dy < 0.1 && pointInPolygon(x, z, w.poly);
        });
      }
      if (all) onDeck++;
    }
  });
  check(onDeck === 0, `world 群組內貼在紅橋甲板上的三角形 ${onDeck}（源頭略過 ${stripped}，stripDeckOverlays 相容回報）`);
}

// ---------- 7. 行道樹對齊樹穴（路緣外 0.85 m） ----------
// 樹沒有記錄所屬道路：以「最近主要道路緣」量測，路口轉角 / 彎道處可能量到另一條路，故看 95 百分位
{
  const devs = [];
  const cp = {};
  const majors = surfaceRoads.filter((r) => ['primary', 'secondary', 'tertiary'].includes(r.type));
  for (const t of world.trees.slice(0, world.stats.streetTrees)) {
    let best = Infinity;
    for (const r of majors) {
      for (let i = 0; i + 1 < r.pts.length; i++) {
        closestOnSegment(t.x, t.z, r.pts[i].x, r.pts[i].z, r.pts[i + 1].x, r.pts[i + 1].z, cp);
        best = Math.min(best, Math.sqrt(cp.d2) - r.hw);
      }
    }
    devs.push(Math.abs(best - 0.85));
  }
  devs.sort((a, b) => a - b);
  const p95 = devs[Math.floor(devs.length * 0.95)];
  const within = devs.filter((d) => d < 0.05).length;
  check(devs.length > 0 && p95 < 0.05, `行道樹 ${devs.length} 棵距最近主要道路緣 0.85 m：95 百分位偏差 ${f3(p95)} m、偏差 < 0.05 m 者 ${within} 棵、最大 ${f3(devs[devs.length - 1])} m`);
}

if (failed) {
  console.log(`\n${failed} 項失敗`);
  process.exit(1);
}
console.log('\n全部通過');
