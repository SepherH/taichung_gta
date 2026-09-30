// 地標模型：依 public/models/manifest.json 載入實景 glb，取代對應 OSM 建築的通用擠出。
//
// manifest.json：陣列，每筆
//   { id（OSM way id）, name, file（同目錄下的 .glb 檔名）, anchorLat, anchorLon, height, heightSource,
//     footprint（true = 取代通用擠出與通用名稱牌）, notes }
// glb 契約：單位公尺；模型原點 = anchorLat / anchorLon 的地面點；+X 東、+Y 上、−Z 北（與世界座標 x 東 / z 南一致，不旋轉）。
// 物件名稱以「sign:」開頭的平面為招牌佔位：執行期貼上冒號後的文字（置中、不鏡像、夜間自發光）。
//
// 缺檔（manifest 不存在）→ 安靜回傳空表，全部走通用擠出；單一模型載入失敗 → console.warn 並退回通用擠出。
// 碰撞一律沿用 OSM 輪廓（buildings.js 負責）。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import osm from '../data/osm-city.json';
import { makeCanvas, fitText } from '../utils.js';
import { registerNight } from '../daynight.js';

const MODEL_DIR = `${import.meta.env.BASE_URL}models/`;

// 與 tools/build-city.mjs 完全相同的投影（原點與係數由轉檔工具輸出）
export function projectLatLon(lat, lon) {
  return { x: (lon - osm.o.lon) * osm.o.kx, z: -(lat - osm.o.lat) * osm.o.kz };
}

// 讀 manifest；檔案不存在（404 或開發伺服器回退成 index.html）時回傳 null，不報錯
async function fetchManifest(url) {
  let res;
  try {
    res = await fetch(url, { cache: 'no-cache' });
  } catch {
    return null;
  }
  if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) return null;
  try {
    const list = await res.json();
    if (Array.isArray(list)) return list;
  } catch {
    // 落到下方警告
  }
  console.warn('[landmarks] manifest.json 格式不正確，全部改用通用擠出');
  return null;
}

function validEntry(e) {
  return (
    e && Number.isFinite(Number(e.id)) && typeof e.file === 'string' && e.file && !e.file.includes('/') &&
    Number.isFinite(e.anchorLat) && Number.isFinite(e.anchorLon)
  );
}

// 招牌：依平面實際寬高比畫字卡，自行計算 UV（從平面正面看文字由左到右、正立）
function applySign(mesh, text) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  if (!pos || pos.count < 3) return;
  mesh.updateWorldMatrix(true, false);
  const m = mesh.matrixWorld;
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  const n = new THREE.Vector3();
  if (geo.attributes.normal) {
    const t = new THREE.Vector3();
    for (let i = 0; i < geo.attributes.normal.count; i++) n.add(t.fromBufferAttribute(geo.attributes.normal, i));
    n.applyMatrix3(nm);
  }
  if (n.lengthSq() < 1e-8) {
    const a = new THREE.Vector3().fromBufferAttribute(pos, 0).applyMatrix4(m);
    const b = new THREE.Vector3().fromBufferAttribute(pos, 1).applyMatrix4(m);
    const c = new THREE.Vector3().fromBufferAttribute(pos, 2).applyMatrix4(m);
    n.crossVectors(b.sub(a), c.sub(a));
  }
  n.normalize();
  // 立面招牌以世界上方為「上」；平放的招牌以北方（−Z）為「上」
  const up = Math.abs(n.y) > 0.9 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(up, n).normalize();
  up.crossVectors(n, right).normalize();
  const p = new THREE.Vector3();
  const s = new Float32Array(pos.count);
  const t = new Float32Array(pos.count);
  let s0 = Infinity;
  let s1 = -Infinity;
  let t0 = Infinity;
  let t1 = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(m);
    s[i] = p.dot(right);
    t[i] = p.dot(up);
    s0 = Math.min(s0, s[i]);
    s1 = Math.max(s1, s[i]);
    t0 = Math.min(t0, t[i]);
    t1 = Math.max(t1, t[i]);
  }
  const w = s1 - s0;
  const h = t1 - t0;
  if (w < 1e-4 || h < 1e-4) return;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (s[i] - s0) / w;
    uv[i * 2 + 1] = (t[i] - t0) / h;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));

  const aspect = w / h;
  const CW = aspect >= 1 ? 1024 : Math.max(64, Math.round(1024 * aspect));
  const CH = aspect >= 1 ? Math.max(64, Math.round(1024 / aspect)) : 1024;
  const canvas = makeCanvas(CW, CH);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1d2024';
  ctx.fillRect(0, 0, CW, CH);
  fitText(ctx, text, CW / 2, CH / 2, CW * 0.9, Math.floor(CH * 0.62));
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, CW / 2, CH / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    emissiveMap: tex,
    emissive: 0xffffff,
    emissiveIntensity: 0,
    roughness: 0.6,
    side: THREE.FrontSide,
  });
  registerNight(mat, 1.1);
  mesh.material = mat;
}

// 整理模型：陰影、招牌、夜間發光
function prepareModel(root) {
  const signs = [];
  const seen = new Set();
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    // 招牌名稱：GLTFLoader 會把 name 的「:」去掉，原名在 userData.name；多 primitive 時在父節點
    const signName = [o.userData.name, o.name, o.parent && o.parent.userData.name]
      .find((nm) => typeof nm === 'string' && nm.startsWith('sign:'));
    if (signName) {
      signs.push([o, signName.slice(5).trim()]);
      return;
    }
    for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!mat || seen.has(mat) || !mat.emissive) continue;
      seen.add(mat);
      const lit = mat.emissiveMap || mat.emissive.r + mat.emissive.g + mat.emissive.b > 0.01;
      if (lit && mat.emissiveIntensity > 0) registerNight(mat, Math.max(1, mat.emissiveIntensity));
    }
  });
  for (const [mesh, text] of signs) if (text) applySign(mesh, text);
}

// 載入所有地標模型；回傳 Map<wayId, { entry, object }>（object 已擺到世界座標，尚未加入場景）
// onProgress(done, total, name)：每完成一個模型呼叫一次
export async function loadLandmarkModels(onProgress = () => {}) {
  const result = new Map();
  const list = await fetchManifest(`${MODEL_DIR}manifest.json`);
  if (!list) return result;
  const entries = list.filter((e) => {
    if (validEntry(e)) return true;
    console.warn('[landmarks] manifest 項目欄位不完整，略過：', e && (e.id || e.name));
    return false;
  });
  const loader = new GLTFLoader();
  let done = 0;
  await Promise.all(
    entries.map(async (e) => {
      try {
        const gltf = await loader.loadAsync(`${MODEL_DIR}${e.file}`);
        const root = gltf.scene;
        const p = projectLatLon(e.anchorLat, e.anchorLon);
        root.position.set(p.x, 0, p.z);
        root.name = `landmark-${e.id}`;
        root.userData.landmark = e;
        root.updateMatrixWorld(true);
        prepareModel(root);
        result.set(Number(e.id), { entry: e, object: root });
      } catch (err) {
        console.warn(`[landmarks] ${e.name || e.id}（${e.file}）載入失敗，退回通用擠出：`, err && err.message ? err.message : err);
      }
      done++;
      onProgress(done, entries.length, e.name || String(e.id));
    }),
  );
  return result;
}
