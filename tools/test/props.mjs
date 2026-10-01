#!/usr/bin/env node
// 道具模型（src/prop-model.js）：manifest 解析、擺放數學（不需 three）；有 three 時另載入 glb 驗節點與 counter 世界座標
// 用法：node tools/test/props.mjs（未安裝 three → glb 部分顯示 SKIP，純數學部分照跑）
globalThis.self ??= globalThis; // 內嵌貼圖 glb 在 node 端否則 parse 失敗
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parsePropManifest, propPlacement, propWorldPoint, placeProp,
  loadPropModels, createPropModel, propInfo, propEmissiveMaterials,
} from '../../src/prop-model.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const propsDir = resolve(root, 'public/models/props');
const manifestPath = resolve(propsDir, 'manifest.json');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) pass++;
  else {
    fail++;
    console.error(`FAIL ${name}${detail ? `：${detail}` : ''}`);
  }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const nearPt = (p, q, eps = 1e-6) => near(p.x, q.x, eps) && near(p.y, q.y, eps) && near(p.z, q.z, eps);
const fmt = (p) => `(${p.x.toFixed(4)}, ${p.y.toFixed(4)}, ${p.z.toFixed(4)})`;

// ---------- manifest 解析 ----------
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const entries = parsePropManifest(manifest);
const stall = entries.find((e) => e.id === 'night_market_stall');
check('manifest 有 night_market_stall', !!stall);
check('stall counter = [0, 0.95, 0.7]', stall && JSON.stringify(stall.counter) === '[0,0.95,0.7]', stall && JSON.stringify(stall.counter));
check('stall 尺寸為正', stall && stall.width > 0 && stall.depth > 0 && stall.height > 0);
const origWarn = console.warn;
console.warn = () => {};
check('壞條目略過', parsePropManifest({ props: [{ id: 'x' }, { id: 'y', file: 'y.glb', width: 1, depth: 1, height: 1, counter: [0, 1] }] }).length === 0);
check('非 manifest → []', parsePropManifest(null).length === 0 && parsePropManifest({}).length === 0);
console.warn = origWarn;

// ---------- 擺放數學 ----------
const PICK = { x: 556.3, z: -107.9 };
// 面向 +X：yaw = π/2，本地 +Z → 世界 +X
{
  const p = propPlacement({ ...PICK, faceX: PICK.x + 10, faceZ: PICK.z });
  check('面向 +X yaw = π/2', near(p.yaw, Math.PI / 2), p.yaw);
  const c = propWorldPoint([0, 0.95, 0.7], p);
  check('面向 +X counter', nearPt(c, { x: PICK.x + 0.7, y: 0.95, z: PICK.z }), fmt(c));
  const side = propWorldPoint([1, 0, 0], p); // 本地 +X 轉到世界 −Z
  check('面向 +X 本地 +X → 世界 −Z', nearPt(side, { x: PICK.x, y: 0, z: PICK.z - 1 }), fmt(side));
}
// 四個方向 + 斜向：counter 落在「擺放點往面向方向 0.7 m」
for (const [dx, dz] of [[0, 1], [0, -1], [-1, 0], [3, 4], [-5, -2]]) {
  const p = propPlacement({ ...PICK, y: 1.2, faceX: PICK.x + dx, faceZ: PICK.z + dz });
  const len = Math.hypot(dx, dz);
  const c = propWorldPoint([0, 0.95, 0.7], p);
  const want = { x: PICK.x + (0.7 * dx) / len, y: 1.2 + 0.95, z: PICK.z + (0.7 * dz) / len };
  check(`面向 (${dx}, ${dz}) counter`, nearPt(c, want), `${fmt(c)} ≠ ${fmt(want)}`);
}
// 面向點與擺放點重合 → 退回 yaw（預設 0）
check('重合退回 0', propPlacement({ ...PICK, faceX: PICK.x, faceZ: PICK.z }).yaw === 0);
check('重合退回 opts.yaw', propPlacement({ ...PICK, faceX: PICK.x, faceZ: PICK.z, yaw: 1 }).yaw === 1);
check('只給 yaw', propPlacement({ ...PICK, yaw: -0.5 }).yaw === -0.5 && propPlacement(PICK).y === 0);
// anchor：counter 水平位置落在擺放點、本體往背向退 0.7 m
{
  const p = propPlacement({ ...PICK, faceX: PICK.x, faceZ: PICK.z - 10, anchor: [0, 0.95, 0.7] });
  const c = propWorldPoint([0, 0.95, 0.7], p);
  check('anchor counter 落在取餐點', nearPt(c, { x: PICK.x, y: 0.95, z: PICK.z }), fmt(c));
  check('anchor 本體退後', nearPt(p, { x: PICK.x, y: 0, z: PICK.z + 0.7, yaw: p.yaw }), fmt(p));
}
// placeProp 套用到鴨子型別物件
{
  const obj = { position: { set(x, y, z) { Object.assign(this, { x, y, z }); } }, rotation: { y: 0 } };
  const p = placeProp(obj, { ...PICK, y: 0.3, faceX: PICK.x - 1, faceZ: PICK.z });
  check('placeProp 寫入位置 / 朝向', obj.position.x === p.x && obj.position.y === 0.3 && obj.position.z === p.z && obj.rotation.y === p.yaw && near(p.yaw, -Math.PI / 2));
}
check('未載入前 createPropModel → null', createPropModel('night_market_stall') === null);

// ---------- glb（需 three） ----------
let THREE = null;
try {
  THREE = await import('three');
} catch {
  console.log('props: SKIP glb 部分（未安裝 three）');
}
if (THREE) {
  const glbPath = resolve(propsDir, stall.file);
  check('glb 檔存在', existsSync(glbPath), glbPath);
  // 本機檔案版 fetch：URL 為 public 下的相對路徑
  const fetchFile = async (url) => {
    const p = resolve(root, 'public', url.replace(/^\.?\//, ''));
    if (!existsSync(p)) return { ok: false, status: 404, headers: { get: () => '' } };
    const buf = readFileSync(p);
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (k.toLowerCase() === 'content-type' && p.endsWith('.json') ? 'application/json' : 'application/octet-stream') },
      json: async () => JSON.parse(buf.toString('utf8')),
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  };
  const loaded = await loadPropModels('models/props/manifest.json', { fetch: fetchFile });
  check('loadPropModels 載入 stall', loaded.has('night_market_stall'), [...loaded.keys()].join(','));
  check('重複呼叫共用載入', loadPropModels('models/props/manifest.json', { fetch: fetchFile }) === loadPropModels('models/props/manifest.json'));
  check('propInfo', propInfo('night_market_stall')?.counter?.[2] === 0.7);
  check('propInfo 未知 id → null', propInfo('nope') === null);
  const obj = createPropModel('night_market_stall');
  check('createPropModel 非 null', !!obj && obj.isObject3D);
  check('createPropModel 未知 id → null', createPropModel('nope') === null);
  if (obj) {
    check('節點 body', !!obj.getObjectByName('body'));
    check('節點 sign', !!obj.getObjectByName('sign'));
    const box = new THREE.Box3().setFromObject(obj);
    check('外接盒高 ≈ manifest height', near(box.max.y - box.min.y, stall.height, 0.05), `${(box.max.y - box.min.y).toFixed(3)}`);
    check('原點在地面', near(box.min.y, 0, 0.02), box.min.y.toFixed(3));
    const emi = propEmissiveMaterials('night_market_stall');
    check('發光材質含 bulb', emi.some((m) => m.name === 'bulb'), emi.map((m) => m.name).join(','));
    // counter 世界座標：three 的 localToWorld 與 propWorldPoint 一致，且落在預期位置
    for (const [fx, fz] of [[PICK.x + 10, PICK.z], [PICK.x, PICK.z - 10], [PICK.x - 3, PICK.z + 4]]) {
      const p = placeProp(obj, { ...PICK, y: 0.5, faceX: fx, faceZ: fz });
      obj.updateMatrixWorld(true);
      const w = obj.localToWorld(new THREE.Vector3(...stall.counter));
      const len = Math.hypot(fx - PICK.x, fz - PICK.z);
      const want = { x: PICK.x + (0.7 * (fx - PICK.x)) / len, y: 0.5 + 0.95, z: PICK.z + (0.7 * (fz - PICK.z)) / len };
      check(`three counter 面向 (${fx}, ${fz})`, nearPt(w, want, 1e-4) && nearPt(w, propWorldPoint(stall.counter, p), 1e-4), `${fmt(w)} ≠ ${fmt(want)}`);
    }
    const twin = createPropModel('night_market_stall');
    check('複本為獨立節點', twin && twin.getObjectByName('body') !== obj.getObjectByName('body'));
  }
}

console.log(`props: ${pass}/${pass + fail} passed`);
process.exit(fail > 0 ? 1 : 0);
