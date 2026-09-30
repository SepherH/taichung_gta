#!/usr/bin/env node
// D4-0 地標點無頭測試：src/core/landmark-points.js（契約 §17）
// 用法：node tools/test/landmark-points.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：以 public/models/manifest.json 驗 12 筆、slug、radius、座標落在 citymodel BOUNDS 內；
//   內建投影與 landmarks/index.js 的 projectLatLon 一致；注入投影；缺檔 / 非法輸入安靜退回；模組本身不 import three
// 比照 tools/test/crowd.mjs：掛 JSON import hook、document 最小替身
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
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({}), style: {} }) };

const fs = await import('node:fs');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const { landmarkPoints, landmarkSlug, projectLatLonPure, LANDMARK_RADIUS, LANDMARK_RADIUS_SMALL } = await import('../../src/core/landmark-points.js');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ---------- 模組不 import three ----------
{
  const src = fs.readFileSync(path.join(ROOT, 'src/core/landmark-points.js'), 'utf8');
  const imports = src.split('\n').filter((l) => /^\s*import\s/.test(l));
  check('模組只 import osm-city.json（不拖入 three / landmarks/index.js）', imports.length === 1 && imports[0].includes('osm-city.json') && !/three|landmarks\//.test(src.replace(/^\/\/.*$/gm, '')), imports.join(' | '));
}

// ---------- 以實際 manifest 驗證 ----------
const manifestPath = path.join(ROOT, 'public/models/manifest.json');
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
check('public/models/manifest.json 存在且為陣列', Array.isArray(manifest));
{
  const pts = landmarkPoints(manifest || []);
  check('12 筆地標點', pts.length === 12, `實得 ${pts.length}`);
  const slugOk = (manifest || []).every((e, i) => pts[i] && pts[i].slug === e.file.replace(/\.glb$/, '') && pts[i].id === e.id && pts[i].name === e.name);
  check('slug = file 去 .glb、id / name 原樣、順序與 manifest 一致', slugOk);
  check('slug 不重複且不含副檔名 / 路徑', new Set(pts.map((p) => p.slug)).size === pts.length && pts.every((p) => !/\.|\//.test(p.slug)));
  check('slug 抽樣：tiger_city / qiuhonggu_red_bridge / national_taichung_theater', ['tiger_city', 'qiuhonggu_red_bridge', 'national_taichung_theater'].every((s) => pts.some((p) => p.slug === s)));
  const radiusOk = (manifest || []).every((e, i) => pts[i] && pts[i].radius === (e.footprint === false ? 15 : 25));
  check('radius：footprint true → 25、false → 15', radiusOk && LANDMARK_RADIUS === 25 && LANDMARK_RADIUS_SMALL === 15);
  check('footprint false 的兩筆（展示館 / 紅橋）radius 15', pts.filter((p) => p.radius === 15).map((p) => p.slug).sort().join(',') === 'qiuhonggu_pavilion,qiuhonggu_red_bridge');
  check('每筆欄位齊全（id, slug, name, x, z, radius）', pts.every((p) => Object.keys(p).sort().join(',') === 'id,name,radius,slug,x,z' && Number.isFinite(p.x) && Number.isFinite(p.z)));

  const { BOUNDS } = await import('../../src/citymodel.js');
  const outside = pts.filter((p) => !(p.x >= BOUNDS.minX && p.x <= BOUNDS.maxX && p.z >= BOUNDS.minZ && p.z <= BOUNDS.maxZ));
  check('座標全部落在 citymodel BOUNDS 內', outside.length === 0, outside.map((p) => `${p.slug}(${p.x.toFixed(1)},${p.z.toFixed(1)})`).join(' '));

  // 內建投影 vs landmarks/index.js 的 projectLatLon（測試端才 import，會帶入 three）
  const { projectLatLon } = await import('../../src/landmarks/index.js');
  let maxErr = 0;
  for (const e of manifest || []) {
    const a = projectLatLonPure(e.anchorLat, e.anchorLon);
    const b = projectLatLon(e.anchorLat, e.anchorLon);
    maxErr = Math.max(maxErr, Math.abs(a.x - b.x), Math.abs(a.z - b.z));
  }
  check('內建投影與 projectLatLon 一致（12 筆最大誤差 0）', maxErr === 0, `最大誤差 ${maxErr}`);
  const injected = landmarkPoints(manifest || [], projectLatLon);
  check('注入 projectLatLon 的結果與預設完全相同', JSON.stringify(injected) === JSON.stringify(pts));
  // 秋紅谷（寶輝）在原點東側附近、北方 → z 為負
  const bh = pts.find((p) => p.slug === 'baohui_qiuhonggu');
  check('方位合理：寶輝秋紅谷在原點北方（z < 0）、東方（x > 0）', bh && bh.z < 0 && bh.x > 0, bh ? `(${bh.x.toFixed(1)}, ${bh.z.toFixed(1)})` : '');
}

// ---------- 注入投影 ----------
{
  const calls = [];
  const pts = landmarkPoints([{ id: 1, name: 'A', file: 'a.glb', anchorLat: 10, anchorLon: 20, footprint: true }], (lat, lon) => {
    calls.push([lat, lon]);
    return { x: lon * 2, z: lat * 3 };
  });
  check('注入 project：以 (lat, lon) 呼叫、結果直接採用', calls.length === 1 && calls[0][0] === 10 && calls[0][1] === 20 && pts[0].x === 40 && pts[0].z === 30);
  const bad = landmarkPoints([{ id: 1, file: 'a.glb', anchorLat: 1, anchorLon: 1 }], () => ({ x: NaN, z: 0 }));
  check('投影結果非有限數 → 略過該筆', bad.length === 0);
  const nonFn = landmarkPoints([{ id: 1, file: 'a.glb', anchorLat: 24.164, anchorLon: 120.64 }], 'nope');
  check('project 非函式 → 退回內建投影', nonFn.length === 1 && nonFn[0].x === projectLatLonPure(24.164, 120.64).x);
}

// ---------- 缺檔 / 非法輸入 ----------
{
  let threw = false;
  let r = [];
  try {
    r = [landmarkPoints(null), landmarkPoints(undefined), landmarkPoints({}), landmarkPoints('x'), landmarkPoints([])];
  } catch (err) {
    threw = true;
  }
  check('manifest 缺檔（null / undefined / 非陣列 / 空陣列）→ 空陣列、不丟例外', !threw && r.every((a) => Array.isArray(a) && a.length === 0));
  const list = [
    null,
    5,
    { id: 1, file: 'sub/x.glb', anchorLat: 24.16, anchorLon: 120.64 },
    { id: 2, file: 'x.fbx', anchorLat: 24.16, anchorLon: 120.64 },
    { id: 3, file: 'x.glb', anchorLat: '24.16', anchorLon: 120.64 },
    { id: 4, file: 'x.glb', anchorLat: 24.16, anchorLon: NaN },
    { id: 5, file: '.glb', anchorLat: 24.16, anchorLon: 120.64 },
    { id: 6, file: 'Good.GLB', anchorLat: 24.16, anchorLon: 120.64 },
    { id: 7, file: 'Good.glb', anchorLat: 24.165, anchorLon: 120.641 },
    { file: 'noid.glb', anchorLat: 24.16, anchorLon: 120.64 },
  ];
  const pts = landmarkPoints(list);
  check('非法筆略過（路徑 / 非 glb / 錨點非數 / 空檔名）', pts.map((p) => p.slug).join(',') === 'Good,noid', pts.map((p) => p.slug).join(','));
  check('slug 重複保留第一筆；.GLB 大小寫皆可', pts[0].id === 6);
  check('缺 id → 用 slug、缺 name → 用 slug、缺 footprint → 25 m', pts[1].id === 'noid' && pts[1].name === 'noid' && pts[1].radius === 25);
  check('landmarkSlug 單元', landmarkSlug('tiger_city.glb') === 'tiger_city' && landmarkSlug('a/b.glb') === null && landmarkSlug(3) === null && landmarkSlug('x.gltf') === null);
  const again = landmarkPoints(manifest || []);
  check('純函式：同輸入同輸出、回新陣列', JSON.stringify(again) === JSON.stringify(landmarkPoints(manifest || [])) && again !== landmarkPoints(manifest || []));
}

console.log(failed === 0 ? `PASS ${passed}/${passed + failed}` : `FAIL ${failed}/${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
