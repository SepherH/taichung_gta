// 地標模型：依 public/models/manifest.json 載入實景 glb，取代對應 OSM 建築的通用擠出。
//
// manifest.json：陣列，每筆
//   { id（OSM way id；沒有 OSM 輪廓的物件為字串 id，如 qiuhonggu_pavilion）, name, file（同目錄下的 .glb 檔名）, anchorLat, anchorLon, height, heightSource,
//     footprint（true = 取代通用擠出與通用名稱牌）, notes }
// glb 契約：單位公尺；模型原點 = anchorLat / anchorLon 的地面點；+X 東、+Y 上、−Z 北（與世界座標 x 東 / z 南一致，不旋轉）。
// 物件名稱以「sign:」開頭的平面為招牌佔位：執行期貼上冒號後的文字（置中、不鏡像、夜間自發光）；
//   Blender 重複名稱的「.001」等結尾「.數字」後綴不是文字的一部分，取字時去掉（docs/models/README.md 座標約定）。
//
// 缺檔（manifest 不存在）→ 安靜回傳空表，全部走通用擠出；單一模型載入失敗 → console.warn 並退回通用擠出。
// 碰撞一律沿用 OSM 輪廓（buildings.js 負責）。
// 擺放高度（原點 y）依 manifest 各筆 notes 的「原點 z=0 = …」決定基準（datumOf）：
//   湖水面（紅橋）→ 錨點所在湖的水面 terrain.lakes[].y（= osm T.basins[].levels.water）；
//   路面（展示館）→ 錨點所在盆地的路面高 levels.road，不在盆地內則取錨點高度場；
//   其他 → terrain.landmarkBase(id)（唯一高度場；有輪廓者 = 建築平台，不在 patch 內者為 0）。
// 招牌等附屬物是模型子節點，隨根節點同一基準。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import osm from '../data/osm-city.json';
import { makeCanvas, fitText } from '../utils.js';
import { registerNight } from '../daynight.js';
import { getTerrain } from '../citymodel.js';
import { pointInPolygon } from '../geom.js';

// 路徑相對 Vite base（'./'）；Node 無頭測試沒有 import.meta.env 時同樣取 './'
const MODEL_DIR = `${(import.meta.env && import.meta.env.BASE_URL) || './'}models/`;
// notes 內的原點高度說明，例「原點 z=0 = 湖水面，推測…」「原點 z=0 = 北端路面高度（…）」
const DATUM_RE = /原點\s*z\s*=\s*0\s*=\s*([^，。；,;（(]+)/;
// Blender 重複物件名稱的結尾後綴（sign:市政府站.001）
const BLENDER_SUFFIX = /\.\d+$/;

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
    e && (Number.isFinite(Number(e.id)) || (typeof e.id === 'string' && e.id !== '')) &&
    typeof e.file === 'string' && e.file && !e.file.includes('/') &&
    Number.isFinite(e.anchorLat) && Number.isFinite(e.anchorLon)
  );
}

// 結果表的 key：OSM way id 用數字（與 citymodel buildings 的 id 相同），字串 id 原樣
function entryKey(e) {
  return Number.isFinite(Number(e.id)) ? Number(e.id) : e.id;
}

// 原點基準：'water'（湖水面）/ 'road'（路面）/ 'landmarkBase'（預設）
export function datumOf(entry) {
  const m = DATUM_RE.exec(entry.notes || '');
  if (m && m[1].includes('水面')) return 'water';
  if (m && m[1].includes('路面')) return 'road';
  return 'landmarkBase';
}

// 依基準求原點 y（x, z = 錨點世界座標）
export function originHeight(entry, x, z, terrain = getTerrain()) {
  const datum = datumOf(entry);
  if (datum === 'water') {
    const lake = terrain.lakes.find((l) => pointInPolygon(x, z, l.poly)) || terrain.lakes[0];
    return lake ? lake.y : osm.T.basins[0].levels.water;
  }
  if (datum === 'road') {
    const basin = (osm.T.basins || []).find((b) => pointInPolygon(x, z, b.p));
    return basin ? basin.levels.road : terrain.heightAt(x, z);
  }
  return terrain.landmarkBase(entry.id, x, z);
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
  mesh.userData.signText = text;
}

// ---------- 深色玻璃修正（老虎城店面玻璃） ----------
// 沿革：Phase 2 白天亮度約 9–11（幾乎全黑）→ 第一版只在自發光偏暗時補最低自發光，但 glb 自帶 emissive 0x594a35 主導顏色，
//   亮度 76 卻整面平塗棕色 (88,75,54)，不像玻璃（瀏覽器實測）。
// 原因：場景沒有環境貼圖（scene.environment），金屬面只反射環境 → 沒環境就全黑；glb 的暖色自發光又把整面塗成棕色。
// 現行做法：只套用在 DARK_GLASS_FILES 列出的模型（其他地標的玻璃目前正常，不動），材質判定（任一成立）：
//   ⓪ 名稱符合 GLASS_FORCE_RE（tiger_shopfront_glass：已知的店面玻璃，不看顏色）；
//   ① 名稱含 glass / window / 玻璃 / 櫥窗 / 店面（不分大小寫）且顏色偏暗（亮度 < GLASS_DARK_LUMA）；
//   ② 名稱不明但「透明（transparent 或 opacity < 1 或 transmission > 0）+ 顏色很暗 + metalness ≥ GLASS_METAL_MIN」。
// 覆寫（不改 public/models 下的檔；數值皆為絕對值，重複套用結果不變）：
//   底色 GLASS_COLOR 冷深藍灰、metalness GLASS_METALNESS、roughness GLASS_ROUGHNESS、envMap = 簡單天空漸層（glassEnvMap，
//   或呼叫端傳入場景現有環境）→ 白天是帶天空反射的藍灰玻璃；
//   自發光改成暖色店內燈光 GLASS_NIGHT_EMISSIVE、拿掉 glb 的 emissiveMap，強度交給 registerNight（白天 0、夜間最高 GLASS_NIGHT_INTENSITY）；
//   opacity 至少 GLASS_OPACITY（避免透出室內的黑）、transmission 歸零。
const DARK_GLASS_FILES = new Set(['tiger_city.glb']);
const GLASS_FORCE_RE = /tiger_shopfront_glass/i;
const GLASS_NAME_RE = /glass|window|玻璃|櫥窗|店面/i;
const GLASS_DARK_LUMA = 0.12; // 線性亮度
const GLASS_METAL_MIN = 0.5;
const GLASS_COLOR = new THREE.Color(0x566a7e); // 冷深藍灰（sRGB）：metalness 0.75 下 F0 約 0.12，反射天空後約 sRGB 90 上下
const GLASS_METALNESS = 0.75;
const GLASS_ROUGHNESS = 0.12;
const GLASS_ENV_INTENSITY = 1;
const GLASS_NIGHT_EMISSIVE = new THREE.Color(0xffb46e); // 夜間店內暖光（sRGB）
const GLASS_NIGHT_INTENSITY = 0.3;
const GLASS_OPACITY = 0.88;
// 天空漸層環境貼圖（equirect，由上到下：天頂藍 → 地平線淺灰藍 → 地面深灰）；MeshStandardMaterial 渲染時由 three 轉成 PMREM
const ENV_W = 64;
const ENV_H = 32;
const ENV_ZENITH = new THREE.Color(0x6fa6d8);
const ENV_HORIZON = new THREE.Color(0xdde6ee);
const ENV_GROUND = new THREE.Color(0x3c4046);
let envMapCache = null;

function linearLuma(c) {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

// 玻璃用的天空漸層環境貼圖（共用一張）
export function glassEnvMap() {
  if (envMapCache) return envMapCache;
  const data = new Uint8Array(ENV_W * ENV_H * 4);
  const c = new THREE.Color();
  const rgb = { r: 0, g: 0, b: 0 };
  for (let j = 0; j < ENV_H; j++) {
    // DataTexture 第 0 列在 v = 0（equirect 最下方 = 正下方）
    const v = (j + 0.5) / ENV_H;
    if (v >= 0.5) c.copy(ENV_HORIZON).lerp(ENV_ZENITH, Math.pow((v - 0.5) * 2, 0.6));
    else c.copy(ENV_HORIZON).lerp(ENV_GROUND, Math.min(1, (0.5 - v) * 6));
    c.getRGB(rgb, THREE.SRGBColorSpace); // 線性空間內插、以 sRGB 存（貼圖 colorSpace = sRGB）
    for (let i = 0; i < ENV_W; i++) {
      const k = (j * ENV_W + i) * 4;
      data[k] = Math.round(rgb.r * 255);
      data[k + 1] = Math.round(rgb.g * 255);
      data[k + 2] = Math.round(rgb.b * 255);
      data[k + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, ENV_W, ENV_H, THREE.RGBAFormat);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  envMapCache = tex;
  return tex;
}

// 是否為要修正的深色玻璃材質（判定依據見上方註解）
export function isDarkGlass(mat) {
  if (!mat || !mat.color || !mat.isMeshStandardMaterial) return false;
  if (GLASS_FORCE_RE.test(mat.name || '')) return true;
  const dark = linearLuma(mat.color) < GLASS_DARK_LUMA;
  if (!dark) return false;
  if (GLASS_NAME_RE.test(mat.name || '')) return true;
  const see = mat.transparent || mat.opacity < 1 || (mat.transmission || 0) > 0;
  return see && (mat.metalness || 0) >= GLASS_METAL_MIN;
}

// 就地覆寫模型內的深色玻璃材質；envMap 預設為 glassEnvMap()（可傳場景現有環境）。回傳修正的材質數（同一材質只算一次）
export function fixDarkGlass(root, { envMap = null } = {}) {
  const done = new Set();
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!mat || done.has(mat) || !(mat.userData.darkGlassFixed || isDarkGlass(mat))) continue;
      done.add(mat);
      mat.color.copy(GLASS_COLOR);
      mat.metalness = GLASS_METALNESS;
      mat.roughness = GLASS_ROUGHNESS;
      mat.envMap = envMap || glassEnvMap();
      mat.envMapIntensity = GLASS_ENV_INTENSITY;
      if (mat.emissive) {
        mat.emissive.copy(GLASS_NIGHT_EMISSIVE);
        mat.emissiveMap = null;
        if (!mat.userData.darkGlassNight) {
          // 白天 0（不讓暖色主導）、夜間由日夜系統調到 GLASS_NIGHT_INTENSITY
          mat.emissiveIntensity = 0;
          registerNight(mat, GLASS_NIGHT_INTENSITY);
          mat.userData.darkGlassNight = true;
        }
      }
      if (mat.transparent || mat.opacity < 1) mat.opacity = Math.max(mat.opacity, GLASS_OPACITY);
      if ('transmission' in mat) mat.transmission = 0;
      mat.userData.darkGlassFixed = true;
      mat.needsUpdate = true;
    }
  });
  return done.size;
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
      signs.push([o, signName.slice(5).trim().replace(BLENDER_SUFFIX, '')]);
      return;
    }
    for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
      // 已修正的深色玻璃在 fixDarkGlass 內以夜間暖光上限登記過 registerNight，這裡不重複登記（否則 glb 原強度會蓋過）
      if (!mat || seen.has(mat) || !mat.emissive || mat.userData.darkGlassFixed) continue;
      seen.add(mat);
      const lit = mat.emissiveMap || mat.emissive.r + mat.emissive.g + mat.emissive.b > 0.01;
      if (lit && mat.emissiveIntensity > 0) registerNight(mat, Math.max(1, mat.emissiveIntensity));
    }
  });
  for (const [mesh, text] of signs) if (text) applySign(mesh, text);
}

// 載入所有地標模型；回傳 Map<id, { entry, object }>（OSM way id 為數字 key、字串 id 原樣；object 已擺到世界座標，尚未加入場景）
// onProgress(done, total, name)：每完成一個模型呼叫一次；options.envMap：老虎城玻璃的反射環境（預設 glassEnvMap 天空漸層）
export async function loadLandmarkModels(onProgress = () => {}, { envMap = null } = {}) {
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
        root.position.set(p.x, originHeight(e, p.x, p.z), p.z);
        root.name = `landmark-${e.id}`;
        root.userData.landmark = e;
        root.userData.datum = datumOf(e);
        root.updateMatrixWorld(true);
        if (DARK_GLASS_FILES.has(e.file)) root.userData.darkGlassFixed = fixDarkGlass(root, { envMap });
        prepareModel(root);
        result.set(entryKey(e), { entry: e, object: root });
      } catch (err) {
        console.warn(`[landmarks] ${e.name || e.id}（${e.file}）載入失敗，退回通用擠出：`, err && err.message ? err.message : err);
      }
      done++;
      onProgress(done, entries.length, e.name || String(e.id));
    }),
  );
  return result;
}
