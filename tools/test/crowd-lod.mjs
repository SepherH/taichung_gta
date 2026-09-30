#!/usr/bin/env node
// C2 群眾分層模擬無頭驗證（src/crowd.js，純邏輯 + 真 three 的 InstancedMesh；不需 Rapier / 角色 glb）
// 用法：node tools/test/crowd-lod.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：四檔 crowdPlan 數值、分級遲滯、forceNear、stagger 公平性（10000 幀統計）、替身 set / hide / count / commit、
//   swapPolicy（窮舉輸入：骨架與替身恰好顯示其一）、效能：120 人 × 10000 幀 classify + stagger < 50 ms
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

// 角色模組的方塊人退路可能用到 2D canvas：最小替身
const ctx2d = new Proxy({}, {
  get: (_, k) => (k === 'measureText' ? () => ({ width: 100 }) : () => {}),
  set: () => true,
});
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d, style: {} }),
};

const THREE = await import('three');
const { crowdPlan, createCrowdLod, createStagger, createCrowdImpostors, swapPolicy, LEVELS } = await import('../../src/crowd.js');
const { MODEL_YAW_OFFSET } = await import('../../src/characters/index.js');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// 契約 §3 QUALITY_TIERS（人數 / 半徑欄位）
const TIERS = {
  low: { id: 'low', peds: 30, cars: 18, pedNear: 30, pedFar: 70, motorbikeShare: 0.4 },
  mid: { id: 'mid', peds: 60, cars: 30, pedNear: 40, pedFar: 90, motorbikeShare: 0.4 },
  high: { id: 'high', peds: 90, cars: 45, pedNear: 50, pedFar: 110, motorbikeShare: 0.4 },
  ultra: { id: 'ultra', peds: 120, cars: 60, pedNear: 60, pedFar: 130, motorbikeShare: 0.4 },
};
// 期望：radius = far + 20；poolMax = ceil(target × (far / radius)² × 1.3)
const EXPECT = { low: 24, mid: 53, high: 84, ultra: 118 };

// ======================= 1. crowdPlan 四檔 =======================
const plans = {};
for (const [id, b] of Object.entries(TIERS)) {
  const p = crowdPlan(b);
  plans[id] = p;
  const ok = p.target === b.peds && p.near === b.pedNear && p.far === b.pedFar && p.physicsRadius === b.pedNear + 10
    && p.poolMax === EXPECT[id] && p.poolMax < Math.ceil(b.peds * 1.5) && p.hysteresis > 0
    && p.mixerEvery.near === 1 && p.mixerEvery.mid === 3 && p.mixerEvery.midHidden === 0
    && p.aiEvery.near === 1 && p.aiEvery.mid === 3 && p.aiEvery.far === 6
    && p.radius === b.pedFar + 20 && p.recycle > p.radius && p.spawnMin >= p.physicsRadius && p.spawnMin < p.radius;
  check(`crowdPlan(${id})：target ${p.target} / poolMax ${p.poolMax} / near ${p.near} / far ${p.far} / physics ${p.physicsRadius}`, ok,
    `radius ${p.radius}、recycle ${p.recycle}、spawn ${p.spawnMin}–${p.radius}、far 內預期 ${p.expectedSkeleton.toFixed(1)} 人`);
}
{
  const keys = ['target', 'poolMax', 'near', 'far', 'hysteresis', 'mixerEvery', 'aiEvery', 'physicsRadius'];
  const p = crowdPlan(TIERS.high);
  const sub = ['near', 'nearHidden', 'mid', 'midHidden'].every((k) => Number.isFinite(p.mixerEvery[k])) && ['near', 'mid', 'far'].every((k) => Number.isFinite(p.aiEvery[k]));
  check('crowdPlan 回傳欄位齊全（mixerEvery 四鍵、aiEvery 三鍵）', keys.every((k) => k in p) && sub);
  const d = crowdPlan({});
  check('crowdPlan 缺欄位 → 預設（= high）', d.target === 90 && d.near === 50 && d.far === 110);
  const q = crowdPlan({ peds: 40, pedNear: 30, pedFar: 60, crowdRadius: 60 });
  check('crowdRadius = far 時 poolMax 不超過目標人數', q.poolMax === 40, `${q.poolMax}`);
  p.mixerEvery.near = 99;
  check('crowdPlan 回傳副本（改了不影響下一次）', crowdPlan(TIERS.high).mixerEvery.near === 1);
}

// ======================= 2. 分級：邊界、遲滯、forceNear =======================
{
  const plan = plans.high; // near 50、far 110、h 5
  const lod = createCrowdLod(plan);
  const c = (prev, d, v = true, f = false) => lod.classify(prev, d, v, f);
  check('初次分級（prev null）：49 near / 50 mid / 109 mid / 110 far', c(null, 49) === 'near' && c(null, 50) === 'mid' && c(null, 109) === 'mid' && c(null, 110) === 'far');
  check('near 半徑內一律 near（任何 prev）', LEVELS.every((l) => c(l, 49.9) === 'near') && [null, 'near', 'mid', 'far'].every((l) => c(l, 0) === 'near'));
  check('遲滯 near→mid：52 仍 near、55 仍 near、55.1 才 mid', c('near', 52) === 'near' && c('near', 55) === 'near' && c('near', 55.1) === 'mid');
  check('遲滯 mid→far（視野內）：114 仍 mid、115.1 才 far', c('mid', 114) === 'mid' && c('mid', 115.1) === 'far');
  check('視野外同一遲滯：114 仍 mid、115.1 才 far', c('mid', 114, false) === 'mid' && c('mid', 115.1, false) === 'far');
  check('far→mid：一過 far 邊界（109.9）就升級；110 仍 far', c('far', 109.9) === 'mid' && c('far', 110) === 'far' && c('far', 112) === 'far');
  check('跳級：near 直接到 far（瞬移 200 m）、far 直接到 near（10 m）', c('near', 200) === 'far' && c('far', 10) === 'near');
  check('forceNear：任何距離 / 視野都回 near', [0, 80, 500].every((d) => c('far', d, false, true) === 'near' && c('mid', d, true, true) === 'near'));
  // 沿邊界來回抖動 ±2 m：遲滯下不閃爍
  let flips = 0;
  let lvl = c(null, 49);
  for (let f = 0; f < 1000; f++) {
    const d = 51 + 2 * Math.sin(f * 0.7);
    const n = c(lvl, d);
    if (n !== lvl) flips++;
    lvl = n;
  }
  let flipsFar = 0;
  lvl = 'mid';
  for (let f = 0; f < 1000; f++) {
    const d = 111 + 2 * Math.sin(f * 0.7);
    const n = c(lvl, d, f % 7 !== 0);
    if (n !== lvl) flipsFar++;
    lvl = n;
  }
  check('邊界 ±2 m 抖動 1000 幀：near/mid 邊界最多 1 次切換、mid/far 邊界最多 1 次', flips <= 1 && flipsFar <= 1, `${flips} / ${flipsFar}`);
  check('mixerEvery / aiEvery 查表', lod.mixerEvery('near', true) === 1 && lod.mixerEvery('mid', true) === 3 && lod.mixerEvery('mid', false) === 0 && lod.mixerEvery('far', true) === 0
    && lod.aiEvery('near') === 1 && lod.aiEvery('mid') === 3 && lod.aiEvery('far') === 6);
}

// ======================= 3. stagger 公平性（10000 幀） =======================
{
  const st = createStagger();
  const FRAMES = 10000;
  const N = 120;
  let ok = true;
  let detail = '';
  for (const every of [1, 2, 3, 5, 6]) {
    const per = new Array(N).fill(0);
    const perFrame = [];
    let windowOk = true;
    const last = new Array(N).fill(-1);
    for (let f = 0; f < FRAMES; f++) {
      let n = 0;
      for (let i = 0; i < N; i++) {
        if (!st.shouldTick(i, f, every)) continue;
        per[i]++;
        n++;
        if (last[i] >= 0 && f - last[i] !== every) windowOk = false;
        last[i] = f;
      }
      perFrame.push(n);
    }
    const lo = Math.floor(FRAMES / every);
    const perOk = per.every((c) => c === lo || c === lo + 1);
    const fMin = Math.min(...perFrame);
    const fMax = Math.max(...perFrame);
    if (!(perOk && windowOk && fMax - fMin <= 1)) {
      ok = false;
      detail += `every ${every}：每人 ${Math.min(...per)}–${Math.max(...per)}、每幀 ${fMin}–${fMax}、間隔${windowOk ? '正確' : '錯誤'}；`;
    } else {
      detail += `every ${every}：每人 ${lo}${lo * every === FRAMES ? '' : '±1'} 次、每幀 ${fMin}–${fMax} 人；`;
    }
  }
  check('stagger：每個 index 每 every 幀剛好一次、同幀更新人數最多差 1（120 人 × 10000 幀）', ok, detail);
  let frozen = 0;
  for (let f = 0; f < 1000; f++) for (let i = 0; i < 10; i++) if (st.shouldTick(i, f, 0)) frozen++;
  const sparse = [3, 17, 42, 1001, 99999];
  const sparseOk = sparse.every((i) => {
    let n = 0;
    for (let f = 0; f < 600; f++) if (st.shouldTick(i, f, 6)) n++;
    return n === 100;
  });
  check('stagger：every 0 永不更新；不連號的大 index 也每 6 幀一次', frozen === 0 && sparseOk);
}

// ======================= 4. 替身 InstancedMesh =======================
{
  const scene = new THREE.Scene();
  const imp = createCrowdImpostors(THREE, scene, { max: 8, height: 1.75 });
  const meshes = scene.children.filter((o) => o.isInstancedMesh);
  check('替身：3 個 InstancedMesh（3 draw calls）加入場景、有 instanceColor 前 count 0', meshes.length === 3 && imp.count === 0 && meshes.every((m) => m.count === 0));
  imp.set(0, 10, 2, -5, 0, { shirt: '#ff0000', pants: '#0000ff', skin: '#e0ac85' });
  imp.set(3, 0, 0, 0, Math.PI / 2, { shirt: 0x00ff00, pants: 0x222222, skin: 0xf1c9a5, height: 1.9 });
  imp.commit();
  const [legs, torso, head] = imp.meshes;
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  torso.getMatrixAt(0, m);
  m.decompose(p, q, s);
  check('set：位置 = 腳底、縮放 = 身高', Math.abs(p.x - 10) < 1e-6 && Math.abs(p.y - 2) < 1e-6 && Math.abs(p.z + 5) < 1e-6 && Math.abs(s.y - 1.75) < 1e-6);
  head.getMatrixAt(3, m);
  m.decompose(p, q, s);
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const exp = { x: Math.sin(Math.PI / 2 + MODEL_YAW_OFFSET), z: Math.cos(Math.PI / 2 + MODEL_YAW_OFFSET) };
  check('set：朝向慣例同骨架模型（本地 +Z 前方、yaw + MODEL_YAW_OFFSET）、look.height 覆寫身高', Math.abs(fwd.x - exp.x) < 1e-6 && Math.abs(fwd.z - exp.z) < 1e-6 && Math.abs(s.y - 1.9) < 1e-6);
  // 頭頂高度 = 身高：頭的幾何包圍盒 max.y × 縮放
  head.geometry.computeBoundingBox();
  legs.geometry.computeBoundingBox();
  check('替身人形：腳底 y = 0、頭頂 = 身高（單位幾何 0–1）', Math.abs(head.geometry.boundingBox.max.y - 1) < 1e-6 && Math.abs(legs.geometry.boundingBox.min.y) < 1e-6);
  const c = new THREE.Color();
  torso.getColorAt(0, c);
  const red = c.getHex() === 0xff0000;
  legs.getColorAt(0, c);
  const blue = c.getHex() === 0x0000ff;
  torso.getColorAt(3, c);
  check('instanceColor：軀幹 = shirt、腿 = pants（CSS 字串與數值都可）', red && blue && c.getHex() === 0x00ff00);
  check('count / commit：2 人顯示、繪製數 = 最大 slot + 1 = 4', imp.count === 2 && meshes.every((mm) => mm.count === 4 && mm.visible) && torso.instanceMatrix.version > 0);
  const vBefore = torso.instanceMatrix.version;
  imp.commit();
  check('commit：沒有改動時不重新上傳緩衝', torso.instanceMatrix.version === vBefore);
  const h1 = imp.hide(3);
  const h2 = imp.hide(3);
  imp.commit();
  torso.getMatrixAt(3, m);
  check('hide：縮成 0、重複 hide 回 false、繪製數縮回 1', h1 && !h2 && m.elements.every((e, k) => e === (k === 15 ? 1 : 0)) && imp.count === 1 && meshes.every((mm) => mm.count === 1));
  check('越界 slot 不寫入', imp.set(8, 0, 0, 0, 0) === false && imp.set(-1, 0, 0, 0, 0) === false && imp.hide(99) === false && imp.count === 1);
  imp.hide(0);
  imp.commit();
  check('全部 hide 後 count 0、網格不繪製', imp.count === 0 && meshes.every((mm) => mm.count === 0 && !mm.visible));
  // 同色重設不重寫顏色緩衝
  imp.set(1, 0, 0, 0, 0, { shirt: '#123456', pants: '#654321', skin: '#abcdef' });
  imp.commit();
  const cv = torso.instanceColor.version;
  imp.set(1, 1, 0, 0, 0, { shirt: '#123456', pants: '#654321', skin: '#abcdef' });
  imp.commit();
  check('每幀移動但顏色不變：顏色緩衝不重新上傳', torso.instanceColor.version === cv);
  imp.dispose();
  check('dispose：從場景移除', scene.children.filter((o) => o.isInstancedMesh).length === 0 && imp.set(0, 0, 0, 0, 0) === false);
}

// ======================= 5. swapPolicy =======================
{
  let xorOk = true;
  const reps = [null, 'skeleton', 'impostor'];
  for (const rep of reps) for (const level of LEVELS) for (const can of [true, false]) {
    const r = swapPolicy(rep, level, can);
    if (r.skeletonVisible === r.impostorVisible) xorOk = false;
    if (r.acquire && r.release) xorOk = false;
    if (r.acquire && !can) xorOk = false;
  }
  check('swapPolicy 窮舉（rep × level × 池有無）：骨架與替身恰好顯示其一、不同時 acquire / release', xorOk);
  const a = swapPolicy('impostor', 'mid', true);
  const b = swapPolicy('impostor', 'near', false);
  const r = swapPolicy('skeleton', 'far', true);
  const k = swapPolicy('skeleton', 'mid', false);
  const n0 = swapPolicy(null, 'far', true);
  const n1 = swapPolicy(null, 'near', true);
  check('替身 → 骨架：池有 → acquire 且同幀只顯示骨架；池空 → 維持替身', a.acquire && a.rep === 'skeleton' && a.skeletonVisible && !a.impostorVisible && !b.acquire && b.rep === 'impostor' && b.impostorVisible);
  check('骨架 → 替身：release 且同幀只顯示替身；骨架留在 near / mid 不動', r.release && r.rep === 'impostor' && r.impostorVisible && !r.skeletonVisible && !k.acquire && !k.release && k.skeletonVisible);
  check('剛生成：far → 替身、near → acquire 骨架', n0.rep === 'impostor' && !n0.acquire && n1.acquire && n1.rep === 'skeleton');
  // 模擬：一人從 200 m 走到 0 再走回 200 m，每幀用 classify + swapPolicy，檢查顯示連續與切換次數
  const lod = createCrowdLod(plans.mid);
  let rep = null;
  let level = null;
  let swaps = 0;
  let gap = false;
  for (let f = 0; f <= 4000; f++) {
    const d = Math.abs(200 - f * 0.1) + 0.3 * Math.sin(f);
    level = lod.classify(level, d, true, false);
    const s2 = swapPolicy(rep, level, true);
    if (s2.skeletonVisible === s2.impostorVisible) gap = true;
    if (rep && s2.rep !== rep) swaps++;
    rep = s2.rep;
  }
  check('走近再走遠（含 ±0.3 m 抖動）：只切換 2 次、每幀都恰好顯示一種', swaps === 2 && !gap, `切換 ${swaps} 次`);
}

// ======================= 6. 效能：120 人 × 10000 幀 classify + stagger =======================
{
  const plan = plans.ultra;
  const lod = createCrowdLod(plan);
  const st = createStagger();
  const N = 120;
  const FRAMES = 10000;
  const dist = new Float64Array(N);
  const vel = new Float64Array(N);
  const levels = new Array(N).fill(null);
  for (let i = 0; i < N; i++) {
    dist[i] = (i * 1.37) % 170;
    vel[i] = ((i % 7) - 3) * 0.02;
  }
  const run = () => {
    let ticks = 0;
    for (let f = 0; f < FRAMES; f++) {
      for (let i = 0; i < N; i++) {
        let d = dist[i] + vel[i];
        if (d < 0 || d > 170) {
          vel[i] = -vel[i];
          d = dist[i];
        }
        dist[i] = d;
        const inView = (i + f) % 3 !== 0;
        const l = lod.classify(levels[i], d, inView, i % 23 === 0);
        levels[i] = l;
        if (st.shouldTick(i, f, lod.mixerEvery(l, inView))) ticks++;
        if (st.shouldTick(i, f, lod.aiEvery(l))) ticks++;
      }
    }
    return ticks;
  };
  run(); // 暖機（JIT）
  const t0 = performance.now();
  const ticks = run();
  const ms = performance.now() - t0;
  const cnt = { near: 0, mid: 0, far: 0 };
  for (const l of levels) cnt[l]++;
  check(`效能：120 人 × 10000 幀 classify + stagger（mixer / AI 各一次）< 50 ms`, ms < 50, `${ms.toFixed(2)} ms（${ticks} 次 tick；末幀 near ${cnt.near} / mid ${cnt.mid} / far ${cnt.far}）`);
}

const total = passed + failed;
console.log(`\ncrowd-lod.mjs：${passed} 通過 / ${failed} 失敗`);
console.log(failed ? `FAIL ${failed}/${total}` : `PASS ${passed}/${total}`);
process.exit(failed ? 1 : 0);
