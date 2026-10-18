// v1-neon 霓虹招牌 / 夜色 / 濕亮路面 無頭驗證：node tools/test/v1-neon.mjs
// 不需 node_modules：neon.js / environment.js / citymodel.js 皆不 import three；buildNeon 以假 THREE 組裝，canvas 用 Proxy 替身。
// 驗：招牌數量與位置（不在道路上、貼立面、高度合理）、夜亮日暗、閃爍不重建幾何、tier 開關、draw call / 三角形增量上限、固定種子可重現、夜色參數。
// 任一斷言失敗 exit 1。
import { register } from 'node:module';

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

const root = new URL('../../', import.meta.url);
const { buildings, surfaceRoads, getTerrain } = await import(new URL('src/citymodel.js', root));
const { pointInPolygon, closestOnPolygon } = await import(new URL('src/geom.js', root));
const N = await import(new URL('src/neon.js', root));
const { createEnvironment } = await import(new URL('src/environment.js', root));

let failed = 0;
let passed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (ok) passed++;
  else failed++;
}

// ---------- 假 THREE / canvas ----------
const ctx2d = new Proxy({}, {
  get: (t, k) => (k in t ? t[k] : k === 'measureText' ? () => ({ width: 10 }) : () => {}),
  set: (t, k, v) => ((t[k] = v), true),
});
const makeCanvas = (w, h) => ({ width: w, height: h, getContext: () => ctx2d });
class BufferAttribute {
  constructor(array, itemSize) {
    this.array = array;
    this.itemSize = itemSize;
    this.count = array.length / itemSize;
  }
}
class BufferGeometry {
  constructor() {
    this.attributes = {};
    this.disposed = false;
  }
  setAttribute(k, a) {
    this.attributes[k] = a;
  }
  computeBoundingSphere() {}
  dispose() {
    this.disposed = true;
  }
}
class Material {
  constructor(o = {}) {
    Object.assign(this, { roughness: 1, metalness: 0, envMapIntensity: 1, envMap: null, needsUpdate: false }, o);
  }
  dispose() {}
}
const THREE = {
  BufferAttribute,
  BufferGeometry,
  MeshStandardMaterial: Material,
  CanvasTexture: class { constructor(c) { this.image = c; } dispose() {} },
  Mesh: class { constructor(g, m) { this.geometry = g; this.material = m; this.parent = null; } },
  SRGBColorSpace: 'srgb',
  EquirectangularReflectionMapping: 303,
};
const scene = {
  children: [],
  add(o) { this.children.push(o); o.parent = this; },
  remove(o) { this.children = this.children.filter((c) => c !== o); o.parent = null; },
};

const terrain = getTerrain();
const night = [];
const registerNight = (material, max) => night.push({ material, max });

// ---------- 貼圖集 ----------
{
  const cells = N.atlasCells();
  const inUnit = cells.every((c) => c.u0 >= 0 && c.u1 <= 1 && c.v0 >= 0 && c.v1 <= 1 && c.u1 > c.u0 && c.v1 > c.v0);
  let overlap = 0;
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i];
      const b = cells[j];
      if (a.u0 < b.u1 && b.u0 < a.u1 && a.v0 < b.v1 && b.v0 < a.v1) overlap++;
    }
  }
  check('貼圖集：64 格（32 橫 + 32 直）、UV ∈ [0,1]、互不重疊', cells.length === 64 && inUnit && overlap === 0, `overlap ${overlap}`);
  const names = new Set(cells.map((c) => c.name));
  const colors = new Set(cells.map((c) => c.color));
  check('店名涵蓋 ≥ 12 種、色彩含粉紅 / 紫 / 青 / 橘', names.size >= 12 && ['#ff2e88', '#b14dff', '#00e5ff', '#ff8a00'].every((c) => colors.has(c)), `${names.size} 名 / ${colors.size} 色`);
  check('店名不含露骨字詞', ![...names].some((n) => /色情|性|援交|成人|脫衣/.test(n)));
}

// ---------- 擺放 ----------
const SEED = 20261018;
const opts = { roads: surfaceRoads, terrain, seed: SEED };
const t0 = Date.now();
const signs = N.placeNeonSigns(buildings, opts);
const placeMs = Date.now() - t0;
const kinds = {};
for (const s of signs) kinds[s.kind] = (kinds[s.kind] || 0) + 1;
check('招牌數量 300–MAX_SIGNS、四類（shop / blade / roof / side）皆有', signs.length >= 300 && signs.length <= N.MAX_SIGNS && ['shop', 'blade', 'roof', 'side'].every((k) => kinds[k] > 0),
  `${signs.length} ${JSON.stringify(kinds)} ${placeMs}ms`);

const byId = new Map(buildings.map((b) => [b.id, b]));
const roadGrid = N.makeRoadGrid(surfaceRoads, { service: true });
let onRoad = 0;
for (const s of signs) for (const c of s.corners) if (roadGrid.onRoad(c[0], c[2])) onRoad++;
check('招牌四角皆不在車道路面上（含 service）', onRoad === 0, `on road ${onRoad}`);

// 貼立面：平貼類（shop / side）背緣中點離輪廓 ≤ 0.15 m 且在輪廓外；直立招牌內緣離輪廓 ≤ 0.2 m、外緣在輪廓外；頂招牌在輪廓內
const cp = {};
let notAttached = 0;
let badHeight = 0;
const sample = [];
for (const s of signs) {
  const b = byId.get(s.id);
  const base = terrain.buildingBase(b.id);
  const top = base + b.height;
  const [a, bb, c, d] = s.corners;
  const mx = (a[0] + bb[0]) / 2;
  const mz = (a[2] + bb[2]) / 2;
  const y0 = a[1];
  const y1 = d[1];
  let ok = true;
  if (s.kind === 'shop' || s.kind === 'side') {
    const dist = Math.sqrt(closestOnPolygon(mx, mz, b.poly, cp).d2);
    ok = dist <= 0.15 && !pointInPolygon(mx, mz, b.poly);
  } else if (s.kind === 'blade') {
    const din = Math.sqrt(closestOnPolygon(a[0], a[2], b.poly, cp).d2);
    ok = din <= 0.2 && !pointInPolygon(bb[0], bb[2], b.poly);
  } else {
    ok = pointInPolygon(mx, mz, b.poly);
  }
  if (!ok) notAttached++;
  const hOk = {
    shop: y0 >= base + 1.2 && y1 <= base + 5.5 && y1 <= top,
    blade: Math.abs(y0 - (base + 3.5)) < 1e-6 && y1 <= top,
    side: y0 >= base + 6 && y1 <= top,
    roof: y0 >= top + 1 && y0 <= top + 2 && y1 - y0 <= 5,
  }[s.kind];
  if (!hOk || !(y1 > y0)) badHeight++;
  if (sample.length < 3 && (!ok || !hOk)) sample.push(`${s.kind}#${s.id}`);
}
check('招牌貼在建築立面 / 屋頂（距輪廓 ≤ 0.15–0.2 m、方向正確）', notAttached === 0, `${notAttached} ${sample.join(',')}`);
check('招牌高度合理（店面帶上方 / 二樓直立 / 樓頂上方 / 側面不超出樓頂）', badHeight === 0, `${badHeight}`);
check('招牌只在填充透天厝店面帶 / 中低層 / 大樓（shop 皆為填充透天厝）', signs.filter((s) => s.kind === 'shop').every((s) => byId.get(s.id).inferred && byId.get(s.id).type === 'house'));

const anim = signs.filter((s) => s.mode !== N.MODE.steady);
const animFrac = anim.length / signs.length;
check('閃爍 / 呼吸 / 跑馬燈比例 10–20%、三種模式皆有', animFrac >= 0.1 && animFrac <= 0.2 && [1, 2, 3].every((m) => anim.some((s) => s.mode === m)), `${(animFrac * 100).toFixed(1)}%`);

// 固定種子可重現
const strip = (list) => JSON.stringify(list.map(({ wall, ...s }) => s));
const again = N.placeNeonSigns(buildings, opts);
check('固定種子可重現（兩次擺放完全相同）', strip(again) === strip(signs));
check('不同種子結果不同', strip(N.placeNeonSigns(buildings, { ...opts, seed: SEED + 1 })) !== strip(signs));
const skipAll = new Set(signs.map((s) => s.id));
check('skip（地標 glb 取代者）不放招牌', N.placeNeonSigns(buildings, { ...opts, skip: skipAll }).every((s) => !skipAll.has(s.id)));

// ---------- 組裝：draw call / 三角形 / 夜亮日暗 ----------
N.resetNeon();
const roadMat = new Material({ roughness: 0.92, metalness: 0 });
const junctionMat = new Material({ roughness: 0.92, metalness: 0 });
N.registerWetSurface(roadMat);
N.registerWetSurface(junctionMat);
const neon = N.buildNeon(scene, { THREE, registerNight, buildings, roads: surfaceRoads, terrain, seed: SEED, makeCanvas });
const geo = neon.mesh.geometry;

// ---------- 每幀配置量測子行程（V1_NEON_ALLOC=1）----------
// 在任何其他 updateNeon / environment 呼叫之前執行並結束（同 v3-events）：避免測試直接以各種物件字面量呼叫 updateNeon 的型別回饋污染最佳化結果
// （遊戲內 updateNeon 只由 environment.update 呼叫，參數物件單態）。父行程以 --min/max-semi-space-size=128 --expose-gc 啟動本段：
// 量測迴圈在 128 MB 新生代內不觸發 scavenge，heapUsed 差 = 實際配置量；同一迴圈加「每次配置一物件」對照組證明量得到；
// PerformanceObserver('gc') 確認量測期間除了量前的 gc() 外沒有 GC（否則量測無效 = 失敗）
if (process.env.V1_NEON_ALLOC === '1') {
  const color = (r, g, b) => ({ r, g, b });
  // 非整數 night / rain / overcast（黃昏小雨）：整數值走 Smi 會漏測浮點裝箱
  const dn = {
    base: { hour: 19, elev: -0.1, day: 0.3, night: 0.7, sky: color(0.07, 0.04, 0.19), sunColor: color(0.6, 0.53, 1), sunIntensity: 0.7, hemiIntensity: 0.9, hemiSky: color(0.4, 0.36, 0.7), hemiGround: color(0.2, 0.16, 0.3) },
  };
  const wEnv = { rain: 0.35, fog: 0.1, fogNearMul: 0.8, fogFarMul: 0.9, sunMul: 0.7, hemiMul: 0.85, overcast: 0.4, haze: 0.1 };
  const weather = { getEnv: () => wEnv, getTier: () => 'high' }; // 同 weather.js：getEnv 回共用物件
  // apply: true 的路徑（scene / 光源寫入；Color 替身同 THREE.Color：isColor + setRGB）
  class FakeColor {
    constructor() {
      this.isColor = true;
      this.r = 0.5;
      this.g = 0.5;
      this.b = 0.5;
    }
    setRGB(r, g, b) {
      this.r = r;
      this.g = g;
      this.b = b;
      return this;
    }
  }
  const env = createEnvironment({ apply: false });
  const envApply = createEnvironment({ scene: { background: new FakeColor(), fog: { color: new FakeColor(), near: 1, far: 2 } } });
  const src = { dayNight: dn, weather }; // 呼叫端重用參數物件（main.js 同）
  const srcApply = { dayNight: { base: dn.base, hemi: { intensity: 1, color: new FakeColor(), groundColor: new FakeColor() }, sun: { intensity: 1, color: new FakeColor() } }, weather };
  const { PerformanceObserver } = await import('node:perf_hooks');
  let gcs = 0;
  const obs = new PerformanceObserver((list) => (gcs += list.getEntries().length));
  obs.observe({ entryTypes: ['gc'] });
  const frame = () => {
    env.update(0.016, src);
    envApply.update(0.016, srcApply);
  };
  for (let i = 0; i < 100000; i++) frame(); // 暖機（最佳化完成後量測）
  const ITER = 200000;
  const sink = [];
  const measure = (alloc) => {
    global.gc();
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < ITER; i++) {
      frame();
      if (alloc) sink[i & 7] = { i };
    }
    return (process.memoryUsage().heapUsed - h0) / ITER;
  };
  const tick = () => new Promise((r) => setTimeout(r, 20)); // 讓 gc 觀察項送達
  await tick();
  const g0 = gcs;
  const per = measure(false);
  await tick();
  const g1 = gcs;
  const perAlloc = measure(true);
  await tick();
  obs.disconnect();
  console.log(JSON.stringify({ per, perAlloc, gcPer: g1 - g0, gcAlloc: gcs - g1 }));
  process.exit(0);
}

const triangles = geo.attributes.position.count / 3;
check('新增 draw call ≤ 4（招牌單一 mesh = 1）', neon.stats.drawCalls <= 4 && scene.children.length === 1, `drawCalls ${neon.stats.drawCalls}`);
check('三角形增量 ≤ 20000', triangles <= 20000 && triangles === neon.stats.triangles, `triangles ${triangles}`);
check('幾何屬性齊全（position / normal / uv / neon）且長度一致',
  ['position', 'normal', 'uv', 'neon'].every((k) => geo.attributes[k] && geo.attributes[k].count === geo.attributes.position.count));
const uvArr = geo.attributes.uv.array;
check('UV 皆在貼圖集範圍', uvArr.every((v) => v >= 0 && v <= 1));
{
  // 三角形繞向（逆時針）與法線屬性一致 → 正面朝向法線方向（FrontSide 可見）；平貼招牌法線朝建築外
  const P = geo.attributes.position.array;
  const Nn = geo.attributes.normal.array;
  let bad = 0;
  for (let t = 0; t < P.length / 9; t++) {
    const o = t * 9;
    const ux = P[o + 3] - P[o];
    const uy = P[o + 4] - P[o + 1];
    const uz = P[o + 5] - P[o + 2];
    const vx = P[o + 6] - P[o];
    const vy = P[o + 7] - P[o + 1];
    const vz = P[o + 8] - P[o + 2];
    const cx = uy * vz - uz * vy;
    const cz = ux * vy - uy * vx;
    if (cx * Nn[o] + cz * Nn[o + 2] <= 0) bad++;
  }
  let inward = 0;
  for (const s of signs) {
    if (s.kind !== 'shop' && s.kind !== 'side') continue;
    const b = byId.get(s.id);
    const mx = (s.corners[0][0] + s.corners[1][0]) / 2;
    const mz = (s.corners[0][2] + s.corners[1][2]) / 2;
    if (pointInPolygon(mx - s.nx * 0.5, mz - s.nz * 0.5, b.poly) === false) inward++;
  }
  check('三角形繞向與法線一致（正面可見）、平貼招牌法線朝外', bad === 0 && inward === 0, `bad ${bad} inward ${inward}`);
}

const entry = night.find((n) => n.material === neon.material);
check('招牌材質登記 registerNight（上限 NEON_NIGHT_MAX）', !!entry && entry.max === N.NEON_NIGHT_MAX);
// 同 DayNight.update：emissiveIntensity = max × night
const glow = (nv) => {
  for (const n of night) n.material.emissiveIntensity = n.max * nv;
  return neon.material.emissiveIntensity;
};
const dayI = glow(0);
const nightI = glow(1);
check('夜間亮、白天暗（emissive 0 → 2.2；白天底色深）', dayI === 0 && nightI >= 2 && neon.material.color < 0x505050, `day ${dayI} night ${nightI}`);

// ---------- 閃爍：只改 uniform，不重建幾何 ----------
const posRef = geo.attributes.position.array;
const geoRef = neon.mesh.geometry;
const snap = Float32Array.from(posRef);
const t1 = neon.uniforms.uNeonTime.value;
for (let i = 0; i < 120; i++) N.updateNeon(1 / 60, { night: 1, rain: 0 });
const sameGeo = neon.mesh.geometry === geoRef && geoRef.attributes.position.array === posRef && posRef.every((v, i) => v === snap[i]);
check('閃爍：120 幀後 geometry / 頂點陣列同一物件且內容不變、uniform 時間前進', sameGeo && Math.abs(neon.uniforms.uNeonTime.value - t1 - 2) < 1e-6 && neon.uniforms.uNeonAnim.value === 1);
const varies = (mode) => {
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < 600; k++) {
    const g = N.neonGain(mode, 0.37, 0.5, k * 0.05);
    lo = Math.min(lo, g);
    hi = Math.max(hi, g);
  }
  return hi - lo;
};
check('neonGain：steady 恆為 1、flicker / pulse / chase 隨時間變化', varies(0) === 0 && N.neonGain(0, 0.1, 0.2, 3) === 1 && varies(1) > 0.5 && varies(2) > 0.5 && varies(3) > 0.5);

// ---------- 濕亮 / tier ----------
N.setNeonTier('high');
N.updateNeon(0.016, { night: 1, rain: 0 });
check('high：夜間濕亮（envMap 霓虹、粗糙度下降、金屬度上升）', roadMat.envMap && roadMat.roughness < 0.5 && roadMat.metalness > 0.2 && roadMat.envMapIntensity > 0.5 && junctionMat.roughness === roadMat.roughness,
  `rough ${roadMat.roughness.toFixed(2)} metal ${roadMat.metalness.toFixed(2)}`);
N.updateNeon(0.016, { night: 0, rain: 0 });
check('high：白天晴天路面回原值（rough 0.92 / metal 0 / env 0）', Math.abs(roadMat.roughness - 0.92) < 1e-9 && roadMat.metalness === 0 && roadMat.envMapIntensity === 0);
N.updateNeon(0.016, { night: 0, rain: 1 });
check('high：白天下雨也濕亮', roadMat.roughness < 0.5);
N.setNeonTier('mid');
N.updateNeon(0.016, { night: 1, rain: 0 });
check('mid：濕亮啟用、閃爍啟用', !!roadMat.envMap && roadMat.roughness < 0.5 && neon.uniforms.uNeonAnim.value === 1);
N.setNeonTier('low');
const tLow = neon.uniforms.uNeonTime.value;
for (let i = 0; i < 30; i++) N.updateNeon(1 / 60, { night: 1, rain: 1 });
check('low：關閉濕亮（envMap 移除、粗糙度還原）與閃爍（uAnim 0、時間凍結）',
  roadMat.envMap === null && roadMat.roughness === 0.92 && roadMat.metalness === 0 && neon.uniforms.uNeonAnim.value === 0 && neon.uniforms.uNeonTime.value === tLow);
let recompiles = 0;
roadMat.needsUpdate = false;
for (let i = 0; i < 10; i++) {
  N.updateNeon(1 / 60, { night: 1, tier: 'low' });
  if (roadMat.needsUpdate) recompiles++;
}
check('tier 不變時不觸發材質重編譯', recompiles === 0);

// ---------- environment 串接 + 夜色 ----------
{
  const color = (r, g, b) => ({ r, g, b });
  const base = (nightV, sky) => ({
    base: { hour: 22, elev: -0.8, day: 1 - nightV, night: nightV, sky, sunColor: color(0.6, 0.53, 1), sunIntensity: 0.7, hemiIntensity: 0.9, hemiSky: color(0.4, 0.36, 0.7), hemiGround: color(0.2, 0.16, 0.3) },
  });
  const wEnv = { rain: 0, fog: 0, fogNearMul: 1, fogFarMul: 1, sunMul: 1, hemiMul: 1, overcast: 0, haze: 0 }; // 同 weather.js getEnv：共用物件
  const weather = { getEnv: () => wEnv, getTier: () => 'high' };
  const env = createEnvironment({ apply: false });
  env.update(0.016, { dayNight: base(0, color(0.27, 0.57, 0.89)), weather });
  const p = env.getParams();
  check('白天天空不受夜色影響（night = 0 原值）', Math.abs(p.sky.r - 0.27) < 1e-9 && Math.abs(p.sky.b - 0.89) < 1e-9);
  env.update(0.016, { dayNight: base(1, color(0.07, 0.04, 0.19)), weather });
  check('夜間天空深藍紫（b > r > g）、霧色 = 天空色', p.sky.b > p.sky.r && p.sky.r > p.sky.g && ['r', 'g', 'b'].every((k) => p.fog.color[k] === p.sky[k]));
  check('environment → neon：weather.getTier() 帶入 tier、濕亮生效', N.neonState().tier === 'high' && roadMat.envMap && roadMat.roughness < 0.5);
  const lowW = { ...weather, getTier: () => 'low' };
  env.update(0.016, { dayNight: base(1, color(0.07, 0.04, 0.19)), weather: lowW });
  check('environment：tier 切 low → 濕亮關閉', N.neonState().tier === 'low' && roadMat.envMap === null);
  // 每幀不配置：見上方 V1_NEON_ALLOC 子行程（--min/max-semi-space-size=128 + --expose-gc，在其他 updateNeon 呼叫之前量測）
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const r = spawnSync(process.execPath, ['--min-semi-space-size=128', '--max-semi-space-size=128', '--expose-gc', fileURLToPath(import.meta.url)], { env: { ...process.env, V1_NEON_ALLOC: '1' }, encoding: 'utf8' });
  let res = null;
  try {
    res = JSON.parse((r.stdout || '').trim().split('\n').pop());
  } catch {
    res = null;
  }
  check(
    res ? `environment + neon 每次 update 不配置（apply 關 / 開各一次：${res.per.toFixed(2)} B/次；對照每次配置一物件 ${res.perAlloc.toFixed(1)} B/次；量測期間 GC ${res.gcPer} / ${res.gcAlloc}）` : 'environment + neon 每次 update 不配置（子行程量測失敗）',
    !!res && res.per < 1 && res.perAlloc - res.per >= 12 && res.gcPer <= 1 && res.gcAlloc <= 1,
    res ? '' : (r.stderr || '').slice(0, 300),
  );
}

neon.dispose();
check('dispose：mesh 移出場景、幾何釋放', scene.children.length === 0 && geo.disposed);

// ---------- 回歸：濕路 envMap 與日夜 / null 同步（v1-rf-fix #1） ----------
{
  N.resetNeon();
  const m = new Material({ roughness: 0.92, metalness: 0 });
  N.registerWetSurface(m);
  const tex = { id: 'env' };
  N.setWetEnvMap(tex);
  N.updateNeon(0.016, { night: 1, rain: 0 });
  const wetOk = m.envMap === tex && m.roughness < 0.5 && m.metalness > 0.2;
  N.setWetEnvMap(null);
  N.updateNeon(0.016, { night: 0, rain: 0 });
  check('setWetEnvMap(null)：envMap 移除、粗糙度 / 金屬度 / 強度還原，日夜切換後不再卡濕亮',
    wetOk && m.envMap === null && m.roughness === 0.92 && m.metalness === 0 && m.envMapIntensity === 1);
  N.updateNeon(0.016, { night: 1, rain: 0 });
  check('envMap 為 null 時夜間 update 不改材質', m.envMap === null && m.roughness === 0.92 && m.metalness === 0);
  const tex2 = { id: 'env2' };
  N.setWetEnvMap(tex);
  N.setWetEnvMap(tex2);
  check('換貼圖：材質改指新 envMap', m.envMap === tex2);
}

// ---------- 回歸：dispose 全面釋放（v1-rf-fix #2） ----------
{
  N.resetNeon();
  const counts = { tex: 0, mat: 0, geo: 0 };
  const texes = [];
  class CTex { constructor(c) { this.image = c; texes.push(this); } dispose() { this.disposed = (this.disposed || 0) + 1; counts.tex++; } }
  class CMat extends Material { dispose() { counts.mat++; } }
  class CGeo extends BufferGeometry { dispose() { counts.geo++; } }
  const T2 = { ...THREE, CanvasTexture: CTex, MeshStandardMaterial: CMat, BufferGeometry: CGeo };
  const sc = { children: [], add(o) { this.children.push(o); o.parent = this; }, remove(o) { this.children = this.children.filter((c) => c !== o); o.parent = null; } };
  const reg = [];
  const registerNight2 = (material, max) => reg.push({ material, max });
  const unregisterNight2 = (material) => { const i = reg.findIndex((r) => r.material === material); if (i >= 0) reg.splice(i, 1); };
  const road = new Material({ roughness: 0.92, metalness: 0 });
  N.registerWetSurface(road);
  const nb = N.buildNeon(sc, { THREE: T2, registerNight: registerNight2, unregisterNight: unregisterNight2, buildings, roads: surfaceRoads, terrain, seed: SEED, makeCanvas });
  const envT = N.neonState().envMap;
  N.updateNeon(0.016, { night: 1, rain: 0 });
  check('dispose 前：envMap 已掛到濕路、招牌材質已登記夜亮', road.envMap === envT && !!envT && reg.length === 1 && texes.length === 2);
  const hook = nb.material.onBeforeCompile;
  nb.dispose();
  check('dispose：貼圖集 + envTex 各釋放 1 次（共 2）、材質 1、幾何 1', counts.tex === 2 && texes.every((t) => t.disposed === 1) && counts.mat === 1 && counts.geo === 1, JSON.stringify(counts));
  check('dispose：state.envMap 清空、濕路材質還原且不再指向已釋放貼圖', N.neonState().envMap === null && road.envMap === null && road.roughness === 0.92 && road.metalness === 0);
  check('dispose：夜亮登記移除、onBeforeCompile 掛勾已換成空函式、mesh 移出場景', reg.length === 0 && nb.material.onBeforeCompile !== hook && sc.children.length === 0);
  N.updateNeon(0.016, { night: 1, rain: 0 });
  check('dispose 後 updateNeon 不再改濕路材質', road.envMap === null && road.roughness === 0.92);
  nb.dispose();
  check('dispose 重複呼叫為 no-op（不重複釋放）', counts.tex === 2 && counts.mat === 1 && counts.geo === 1);
  // 重建：第二次 buildNeon 不洩漏第一次的 envTex
  const nb1 = N.buildNeon(sc, { THREE: T2, buildings, roads: surfaceRoads, terrain, seed: SEED, makeCanvas });
  const env1 = N.neonState().envMap;
  nb1.dispose();
  const nb2 = N.buildNeon(sc, { THREE: T2, buildings, roads: surfaceRoads, terrain, seed: SEED, makeCanvas });
  check('重建 world：舊 envTex 於 dispose 釋放、新 envTex 取代', env1.disposed === 1 && N.neonState().envMap !== env1 && N.neonState().envMap.disposed === undefined);
  nb2.dispose();
}

// ---------- 回歸：白天色調與舊版完全相同（v1-rf-fix #3） ----------
// daynight.js import three，無頭跑不動 → 讀原始碼文字解析 SKY_KEYS / _warm
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('src/daynight.js', root), 'utf8');
  const block = src.match(/const SKY_KEYS = \[([\s\S]*?)\n\];/)[1];
  const keys = [...block.matchAll(/\[([\d.]+), '(#[0-9a-fA-F]{6})'\]/g)].map((m) => [Number(m[1]), m[2]]);
  const OLD = [[0, '#0a0f24'], [4.5, '#0d1330'], [5.4, '#3a3560'], [6.2, '#f2a36b'], [7.4, '#a8cdee'], [12, '#8ec5f2'], [16.5, '#a3c9ea'], [17.7, '#f0a060'], [18.5, '#6a4a78'], [19.4, '#1a1c40'], [24, '#0a0f24']];
  const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  const samp = (K, h) => {
    for (let i = 0; i < K.length - 1; i++) {
      const [h0, c0] = K[i];
      const [h1, c1] = K[i + 1];
      if (h >= h0 && h <= h1) {
        const t = (h - h0) / (h1 - h0);
        const a = hex(c0);
        const b = hex(c1);
        return a.map((v, j) => v + (b[j] - v) * t);
      }
    }
  };
  const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const lerp3 = (a, b, t) => a.map((v, j) => v + (b[j] - v) * t);
  const warm = Number(src.match(/this\._warm = new THREE\.Color\((0x[0-9a-fA-F]{6})\)/)[1]);
  const warmHex = '#' + warm.toString(16).padStart(6, '0');
  let n = 0;
  let skyBad = 0;
  let sunBad = 0;
  for (let h = 0; h < 24; h += 0.01) {
    const elev = Math.sin(((h - 6) / 12) * Math.PI);
    const day = ss(-0.08, 0.2, elev);
    const nightV = 1 - ss(-0.12, 0.08, elev);
    if (!(day >= 0.999 && nightV === 0)) continue;
    n++;
    const a = samp(keys, h);
    const b = samp(OLD, h);
    if (!a.every((v, j) => Math.abs(v - b[j]) < 1e-12)) skyBad++;
    const k = ss(0, 0.4, elev);
    const sa = lerp3(hex(warmHex), hex('#fff6e8'), k);
    const sb = lerp3(hex('#ffb070'), hex('#fff6e8'), k);
    if (!sa.every((v, j) => Math.abs(v - sb[j]) < 1e-12)) sunBad++;
  }
  check('白天（day≥0.999 且 night=0，約 6.75–17.25 時）天空色與舊 SKY_KEYS 逐點一致', n > 1000 && skyBad === 0, `${n} 點 bad ${skyBad}`);
  check('白天太陽色（_warm）與舊值 0xffb070 一致', warm === 0xffb070 && sunBad === 0, `bad ${sunBad}`);
  const at = (h) => samp(keys, h);
  const dusk = at(18.4);
  const nightC = at(21);
  check('黃昏洋紅（18.4 時 r>g、b>g）、夜晚深藍紫（21 時 b>r>g）仍保留', dusk[0] > dusk[1] && dusk[2] > dusk[1] && nightC[2] > nightC[0] && nightC[0] > nightC[1]);
}

console.log(`${failed ? 'FAIL' : 'PASS'} ${passed}/${passed + failed}`);
process.exit(failed ? 1 : 0);
