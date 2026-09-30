#!/usr/bin/env node
// 流血特效無頭驗證（契約 §14 / §19，W3）：src/blood-fx.js
// 用法：node tools/test/blood.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：程序圖集（node 無 canvas → DataTexture、有 2D canvas 替身 → CanvasTexture）、實檔圖集（以 node zlib 解 PNG 注入）與缺檔退回（console.info 一次）、
//   單一 InstancedMesh + 單一 Points（draw call ≤ 2）、depthWrite false / polygonOffset、貼地高度、上限 16 / 32（池滿覆寫最舊貼片）、
//   12 s 後 2 s 淡出回收、血滴落地即消失、武器別血量（拳少、槍 / 棒多）、倒地 1 大片 + 8 滴、settings.showBlood 關閉清空且不再生成、
//   效能：16 貼片 + 32 滴 update 1000 次平均 < 0.05 ms
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

const fs = await import('node:fs');
const path = await import('node:path');
const zlib = await import('node:zlib');
const { fileURLToPath } = await import('node:url');
const THREE = await import('three');
const { createBloodFx, proceduralAtlas, DECAL_LIFE, DECAL_FADE, DECAL_LIFT, HIT_DROPS, KNOCKDOWN_DROPS } = await import('../../src/blood-fx.js');
const { createSettings } = await import('../../src/core/settings.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLIC = path.join(ROOT, 'public');
const DT = 1 / 60;

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const infos = [];
const errors = [];
const origInfo = console.info;
const origError = console.error;
console.info = (...a) => infos.push(a.join(' '));
console.error = (...a) => errors.push(a.join(' '));

// 可重現亂數
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// 最小 PNG 解碼（8-bit RGBA / RGB、非交錯）→ DataTexture：讓「實檔圖集」路徑在 node 也能跑
function decodePng(file) {
  const b = fs.readFileSync(file);
  let o = 8;
  let w = 0;
  let h = 0;
  let ct = 0;
  const idat = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o);
    const type = b.toString('ascii', o + 4, o + 8);
    const data = b.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      ct = data[9];
    } else if (type === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(w * h * 4);
  const stride = w * bpp;
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const up = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      cur[x] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      out[i] = cur[x * bpp];
      out[i + 1] = cur[x * bpp + 1];
      out[i + 2] = cur[x * bpp + 2];
      out[i + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
    }
    prev = cur;
  }
  const tex = new THREE.DataTexture(out, w, h, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}
// fs 版貼圖載入器（URL 相對 public/）：檔案存在 → 解 PNG；缺 → onError（同瀏覽器 404）
const fsLoadTexture = (url, onLoad, onError) => {
  const file = path.join(PUBLIC, url);
  if (!fs.existsSync(file)) return onError(new Error('404'));
  onLoad(decodePng(file));
};

const flat = () => 0;

// ---- 1. 貼圖：程序（DataTexture / CanvasTexture）、實檔、缺檔 ----
{
  const t = proceduralAtlas();
  check('node 無 canvas → 程序 DataTexture 4×4 圖集（128 px、有透明度）', t.isDataTexture && t.image.width === 128 && t.image.data.some((v, i) => i % 4 === 3 && v > 200) && t.image.data.some((v, i) => i % 4 === 3 && v === 0));
  const calls = [];
  const ctx2d = new Proxy({}, { get: (_, k) => (...a) => calls.push(k), set: () => true });
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d, style: {} }) };
  const c = proceduralAtlas();
  delete globalThis.document;
  check('有 2D canvas → CanvasTexture（畫了橢圓）', c.isCanvasTexture && calls.includes('ellipse') && c.userData.procedural === 'canvas', `${calls.filter((k) => k === 'ellipse').length} 個橢圓`);

  const scene = new THREE.Scene();
  const fx = createBloodFx({ scene, heightAt: flat, loadTexture: fsLoadTexture, rng: seeded(1) });
  const atlasOk = fx.decals.material.map && fx.decals.material.map.image.width === 1024;
  check('實檔 art/fx/blood-atlas.png（1024²）載入後換上', fx.stats().atlas === 'file' && atlasOk && fx.drops.material.map.image.width === 64, `atlas ${fx.stats().atlas}`);
  fx.dispose();
  check('dispose 後從場景移除', scene.children.length === 0);

  const i0 = infos.length;
  const fx2 = createBloodFx({ scene, heightAt: flat, atlasUrl: 'art/fx/no_such_atlas.png', dropUrl: 'art/fx/no_such_drop.png', loadTexture: fsLoadTexture });
  check('圖集缺檔 → 保持程序圖集、console.info 一次、無 console.error', fx2.stats().atlas === 'data' && infos.length - i0 === 1 && errors.length === 0, `info ${infos.length - i0}`);
  fx2.onHit({ weapon: 'pistol', x: 0, y: 1.2, z: 0, dirX: 1, dirZ: 0 });
  check('缺檔時照常生成', fx2.stats().drops > 0);
  fx2.dispose();
  // 預設載入器在 node（無 Image）→ 直接退回程序，不丟例外
  let threw = false;
  try {
    createBloodFx({ scene }).dispose();
  } catch {
    threw = true;
  }
  check('預設載入器在 node 不丟例外', !threw);
}

// ---- 2. 繪製結構、貼地、數量 ----
{
  const scene = new THREE.Scene();
  const heightAt = (x, z) => 3 + x * 0.1 + z * 0.05;
  const fx = createBloodFx({ scene, heightAt, loadTexture: fsLoadTexture, rng: seeded(7) });
  const m = fx.decals.material;
  check('貼片 = 單一 InstancedMesh（16 容量）、血滴 = 單一 Points（32 容量）', fx.decals.isInstancedMesh && fx.drops.isPoints && fx.decals.instanceMatrix.count === 16 && fx.drops.geometry.attributes.position.count === 32 && scene.children.length === 2);
  check('貼片材質 depthWrite false、polygonOffset、transparent', m.depthWrite === false && m.polygonOffset === true && m.polygonOffsetFactor < 0 && m.transparent === true);
  // 著色器注入：對 three 的 Lambert 原始碼跑 onBeforeCompile，確認插入點都存在（node 無 WebGL，無法實際編譯）
  const shader = { vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader, uniforms: {} };
  m.onBeforeCompile(shader);
  check('貼片著色器注入點都存在（aDecal / vDecal / 圖集格取樣 / 透明度）',
    shader.vertexShader.includes('attribute vec3 aDecal;') && shader.vertexShader.includes('vDecal = aDecal;') &&
    shader.fragmentShader.includes('varying vec3 vDecal;') && shader.fragmentShader.includes('vMapUv + vDecal.xy') && !shader.fragmentShader.includes('#include <map_fragment>'));
  check('空場景：兩者 visible false（0 draw call）', !fx.decals.visible && !fx.drops.visible && fx.stats().drawCalls === 0);
  fx.onKnockdown({ x: 10, z: 4, cause: 'bat' });
  const s = fx.stats();
  const mat = new THREE.Matrix4();
  fx.decals.getMatrixAt(0, mat);
  const p = new THREE.Vector3().setFromMatrixPosition(mat);
  const sc = new THREE.Vector3().setFromMatrixScale(mat);
  check(`倒地：1 片大貼片 + ${KNOCKDOWN_DROPS} 滴`, s.decals === 1 && s.drops === KNOCKDOWN_DROPS && sc.x >= 1.2, `decals ${s.decals} drops ${s.drops} 邊長 ${sc.x.toFixed(2)}`);
  const want = heightAt(10, 4) + DECAL_LIFT;
  check('貼片高度 = heightAt + 抬高（差 < 1.5 cm）、draw call 2', Math.abs(p.y - want) < 0.015 && p.x === 10 && p.z === 4 && s.drawCalls === 2, `y ${p.y.toFixed(4)} / ${want.toFixed(4)}`);
  // 血滴落地即消失（落點地面 = heightAt）
  let t = 0;
  while (fx.stats().drops && t < 5) {
    fx.update(DT);
    t += DT;
  }
  check('血滴落地即消失（< 2 s）、drawRange 歸零', fx.stats().drops === 0 && t < 2 && fx.drops.geometry.drawRange.count === 0 && !fx.drops.visible, `${t.toFixed(2)} s`);

  // 武器別血量：拳 2–3、棒 4–6、槍 6–8
  const counts = {};
  for (const w of ['fist', 'bat', 'pistol']) {
    const f = createBloodFx({ heightAt: flat, loadTexture: fsLoadTexture, rng: seeded(3) });
    let min = Infinity;
    let max = 0;
    let decalHits = 0;
    for (let k = 0; k < 200; k++) {
      f.clear();
      f.onHit({ weapon: w, x: 0, y: 1.3, z: 0, dirX: 0, dirZ: 1 });
      const st = f.stats();
      min = Math.min(min, st.drops);
      max = Math.max(max, st.drops);
      decalHits += st.decals;
    }
    counts[w] = { min, max, decal: decalHits / 200 };
    f.dispose();
  }
  check(`血滴數：拳 ${HIT_DROPS.fist.join('–')}、棒 ${HIT_DROPS.bat.join('–')}、槍 ${HIT_DROPS.pistol.join('–')}`,
    counts.fist.min === 2 && counts.fist.max === 3 && counts.bat.min === 4 && counts.bat.max === 6 && counts.pistol.min === 6 && counts.pistol.max === 8,
    JSON.stringify(counts));
  check('小貼片機率：棒 / 槍 ≈ 0.5、拳明顯較少', Math.abs(counts.bat.decal - 0.5) < 0.12 && Math.abs(counts.pistol.decal - 0.5) < 0.12 && counts.fist.decal < 0.4, `拳 ${counts.fist.decal} 棒 ${counts.bat.decal} 槍 ${counts.pistol.decal}`);
  const f2 = createBloodFx({ heightAt: flat, loadTexture: fsLoadTexture });
  f2.onHit({ weapon: 'pistol', z: 0 });
  f2.onHit(null);
  check('payload 缺座標 / null → 安靜略過', f2.stats().drops === 0);
  f2.onHit({ weapon: 'laser', x: 0, z: 0 });
  check('未知 weapon → 視同拳擊（2–3 滴）、無 y 時從地面 +1.2 m 噴', f2.stats().drops >= 2 && f2.stats().drops <= 3 && Math.abs(f2.drops.geometry.attributes.position.getY(0) - 1.2) < 1e-6);
  f2.dispose();
  fx.dispose();
}

// ---- 3. 上限與回收 ----
{
  const fx = createBloodFx({ heightAt: flat, loadTexture: fsLoadTexture, rng: seeded(11) });
  let maxD = 0;
  let maxP = 0;
  for (let k = 0; k < 300; k++) {
    fx.onHit({ weapon: 'pistol', x: k * 0.1, y: 1.2, z: 0, dirX: 1, dirZ: 0 });
    if (k % 7 === 0) fx.onKnockdown({ x: k, z: 0 });
    const st = fx.stats();
    maxD = Math.max(maxD, st.decals);
    maxP = Math.max(maxP, st.drops);
    if (k % 3 === 0) fx.update(DT);
  }
  check('連打 300 次：貼片 ≤ 16、血滴 ≤ 32（硬上限）', maxD === 16 && maxP === 32 && fx.decals.count <= 16 && fx.drops.geometry.drawRange.count <= 32, `max ${maxD} / ${maxP}`);
  fx.clear();
  // 池滿覆寫最舊：依序在 x = 0..19 生 20 片大貼片 → 留下 4..19
  for (let k = 0; k < 20; k++) fx.onKnockdown({ x: k, z: 0 });
  const mat = new THREE.Matrix4();
  const xs = [];
  for (let i = 0; i < fx.decals.count; i++) {
    fx.decals.getMatrixAt(i, mat);
    xs.push(Math.round(mat.elements[12]));
  }
  xs.sort((a, b) => a - b);
  check('池滿時最舊者先回收（x 0–3 被覆寫、留 4–19）', xs.length === 16 && xs[0] === 4 && xs[15] === 19, xs.join(','));
  // 淡出：12 s 完整、13 s 半透明、14 s 回收
  fx.clear();
  fx.onKnockdown({ x: 0, z: 0 });
  const alpha = () => fx.decals.geometry.attributes.aDecal.getZ(0);
  let t = 0;
  const step = (sec) => {
    const n = Math.round(sec / DT);
    for (let i = 0; i < n; i++) fx.update(DT);
    t += n * DT;
  };
  step(DECAL_LIFE - 0.1);
  const a12 = alpha();
  step(1.1);
  const a13 = alpha();
  const alive13 = fx.stats().decals;
  step(DECAL_FADE / 2 + 0.05);
  check(`貼片 ${DECAL_LIFE} s 內不透明、之後 ${DECAL_FADE} s 淡出、到期回收`, a12 === 1 && Math.abs(a13 - 0.5) < 0.02 && alive13 === 1 && fx.stats().decals === 0 && !fx.decals.visible, `α ${a12} → ${a13.toFixed(3)}、${fx.stats().decals} 片`);
  // 回收中間的貼片後其他貼片資料不錯亂（swap-remove）
  fx.clear();
  fx.onKnockdown({ x: 1, z: 0 });
  step(5);
  fx.onKnockdown({ x: 2, z: 0 });
  fx.onKnockdown({ x: 3, z: 0 });
  step(DECAL_LIFE + DECAL_FADE - 5 + 0.05); // 第一片到期
  const rest = [];
  for (let i = 0; i < fx.decals.count; i++) {
    fx.decals.getMatrixAt(i, mat);
    rest.push(Math.round(mat.elements[12]));
  }
  check('中間貼片到期回收後其餘兩片完整保留', rest.sort().join() === '2,3' && fx.decals.geometry.attributes.aDecal.getZ(0) === 1, rest.join(','));
  fx.dispose();
}

// ---- 4. settings.showBlood ----
{
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  const settings = createSettings({ storage });
  const fx = createBloodFx({ settings, heightAt: flat, loadTexture: fsLoadTexture, rng: seeded(5) });
  fx.onKnockdown({ x: 0, z: 0 });
  fx.onHit({ weapon: 'bat', x: 0, y: 1, z: 0, dirX: 1, dirZ: 0 });
  const before = fx.stats();
  settings.set('showBlood', false);
  const cleared = fx.stats();
  fx.onKnockdown({ x: 0, z: 0 });
  fx.onHit({ weapon: 'pistol', x: 0, y: 1, z: 0 });
  fx.update(DT);
  const off = fx.stats();
  check('showBlood 關 → 立即清空、之後不生成', before.decals >= 1 && before.drops > 0 && cleared.decals === 0 && cleared.drops === 0 && off.decals === 0 && off.drops === 0 && !fx.decals.visible && !fx.drops.visible);
  settings.set('showBlood', true);
  fx.onKnockdown({ x: 0, z: 0 });
  check('showBlood 重新開啟 → 恢復生成', fx.stats().decals === 1);
  fx.dispose();
  settings.set('showBlood', false);
  check('dispose 後取消訂閱（改設定不丟例外）', true);
  // 無 settings（注入省略）→ 預設開
  const fx2 = createBloodFx({ heightAt: flat, loadTexture: fsLoadTexture });
  fx2.onKnockdown({ x: 0, z: 0 });
  check('未注入 settings → 視同開啟', fx2.stats().decals === 1);
  fx2.dispose();
}

// ---- 5. 效能：16 貼片 + 32 滴 update 1000 次 ----
{
  // 地面極低：血滴在量測期間一直在空中（每次 update 都跑滿 32 滴）
  // （x ≥ 1000 處地面 0 放貼片；x = 0 處地面 −1e6 噴血滴）
  const fx = createBloodFx({ heightAt: (x) => (x >= 1000 ? 0 : -1e6), loadTexture: fsLoadTexture, rng: seeded(9) });
  // 先噴滿 32 滴，再以 16 次倒地蓋滿貼片（池滿：舊貼片被覆寫、倒地血滴被丟棄）→ 16 片同齡
  while (fx.stats().drops < 32) fx.onHit({ weapon: 'pistol', x: 0, y: 1, z: 0, dirX: 1, dirZ: 0 });
  for (let k = 0; k < 16; k++) fx.onKnockdown({ x: 1000 + k, z: 0 });
  for (let k = 0; k < 200; k++) fx.update(0.001); // 暖機
  const s0 = fx.stats();
  const N = 1000;
  const t0 = performance.now();
  for (let k = 0; k < N; k++) fx.update(0.005);
  const ms = (performance.now() - t0) / N;
  const s1 = fx.stats();
  check('16 貼片 + 32 滴 update 1000 次平均 < 0.05 ms（量測期間數量不變）', ms < 0.05 && s0.decals === 16 && s0.drops === 32 && s1.decals === 16 && s1.drops === 32, `${(ms * 1000).toFixed(2)} µs、${JSON.stringify([s0, s1])}`);
  // 淡出段（每幀改透明度）也在預算內
  for (let k = 0; k < 1460; k++) fx.update(0.005); // 貼片推進到約 12.5 s（淡出段）
  const t1 = performance.now();
  for (let k = 0; k < 100; k++) fx.update(0.001);
  const ms2 = (performance.now() - t1) / 100;
  check('淡出段 update 平均 < 0.05 ms', ms2 < 0.05 && fx.stats().decals === 16 && fx.decals.geometry.attributes.aDecal.getZ(0) < 1, `${(ms2 * 1000).toFixed(2)} µs、${fx.stats().decals} 片、α ${fx.decals.geometry.attributes.aDecal.getZ(0).toFixed(3)}`);
  fx.dispose();
}

console.info = origInfo;
console.error = origError;
console.log(`\n通過 ${passed}、失敗 ${failed}；靜音的資訊 ${infos.length}、錯誤 ${errors.length} 則`);
console.log(failed ? `FAIL ${failed}/${passed + failed}` : `PASS ${passed}/${passed}`);
process.exit(failed ? 1 : 0);
