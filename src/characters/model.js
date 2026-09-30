// 角色模型：依 public/models/characters/manifest.json 載入骨架人形 glb，快取後以 SkeletonUtils.clone 複製、依材質槽換色。
//
// manifest 欄位（美術線產出）：skeleton（骨名）、materialSlots（skin / shirt / pants / hair / shoes）、fps、
//   clips [{ name, duration, loop }]、variants [{ id, file, height, colors }]、events.punch.hitWindow、poses
// glb 契約：身高 1.75 m、原點在兩腳底中心（地面）、+Y 上、面向 glTF +Z；材質名稱 = 材質槽名稱。
//
// 面向換算：遊戲 yaw 定義為前進方向 = (sin(yaw), cos(yaw))（player.js / vehicle.js），即 yaw = 0 面向世界 +Z；
//   既有 humanoid.js 的方塊人前方也是本地 +Z，與 glTF +Z 相同 → root.rotation.y = yaw，不需額外偏移（MODEL_YAW_OFFSET = 0）。
//
// 共用：同 variant 的所有複本共用幾何（clone 只複製節點與骨架）；材質依「variant + 槽 + 顏色」快取，同色共用。
// 缺檔 / 載入失敗 → createCharacter 退回 humanoid.js 的方塊人形並標記 fallback: true（只 console.warn 一次，不丟例外）。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { createHumanoid } from '../humanoid.js';

// Vite base 為 './'；在 node（無頭測試）沒有 import.meta.env 時同樣以 './' 為基準
const BASE_URL = import.meta.env?.BASE_URL ?? './';
export const DEFAULT_CHARACTER_MANIFEST = `${BASE_URL}models/characters/manifest.json`;
export const DEFAULT_VARIANT = 'pedestrian';
// glTF 前方 +Z 與遊戲 yaw = 0 的前方相同（見檔頭說明）
export const MODEL_YAW_OFFSET = 0;

const cache = {
  manifest: null,
  variants: new Map(), // id → { entry, scene, clips: Map<name, AnimationClip> }
  loading: null,
};
const paintCache = new Map(); // `${variant}|${slot}|${hex}` → Material
let warned = false;

function warnOnce(msg, err) {
  if (warned) return;
  warned = true;
  console.warn(`[characters] ${msg}，改用方塊人形`, err && err.message ? err.message : err || '');
}

// 讀 JSON；不存在（404 或開發伺服器回退成 index.html）時回傳 null
async function fetchJson(fetchImpl, url) {
  try {
    const res = await fetchImpl(url, { cache: 'no-cache' });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function dirOf(url) {
  const i = url.lastIndexOf('/');
  return i < 0 ? '' : url.slice(0, i + 1);
}

async function loadVariant(loader, fetchImpl, dir, entry) {
  const res = await fetchImpl(`${dir}${entry.file}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const gltf = await loader.parseAsync(await res.arrayBuffer(), dir);
  const clips = new Map();
  for (const c of gltf.animations) clips.set(c.name, c);
  return { entry, scene: gltf.scene, clips };
}

// 載入全部變體（重複呼叫共用同一次載入）；回傳 { manifest, variants: [已載入 id], fallback }
// opts.fetch：可替換 fetch（無頭測試用 fs 實作）
export function loadCharacterModels(manifestUrl = DEFAULT_CHARACTER_MANIFEST, opts = {}) {
  if (!cache.loading) cache.loading = doLoad(manifestUrl, opts.fetch || globalThis.fetch.bind(globalThis));
  return cache.loading;
}

async function doLoad(manifestUrl, fetchImpl) {
  const manifest = await fetchJson(fetchImpl, manifestUrl);
  if (!manifest || !Array.isArray(manifest.variants)) {
    warnOnce('manifest 不存在或格式不正確');
    return { manifest: null, variants: [], fallback: true };
  }
  cache.manifest = manifest;
  const dir = dirOf(manifestUrl);
  const loader = new GLTFLoader();
  await Promise.all(
    manifest.variants.map(async (e) => {
      if (!e || typeof e.id !== 'string' || typeof e.file !== 'string') return;
      try {
        cache.variants.set(e.id, await loadVariant(loader, fetchImpl, dir, e));
      } catch (err) {
        warnOnce(`${e.id}（${e.file}）載入失敗`, err);
      }
    }),
  );
  // 三個變體共用同一副骨架與動作（manifest notes）：某檔缺的 clip 由其他變體補上
  for (const v of cache.variants.values()) {
    for (const other of cache.variants.values()) {
      for (const [name, clip] of other.clips) if (!v.clips.has(name)) v.clips.set(name, clip);
    }
  }
  return { manifest, variants: [...cache.variants.keys()], fallback: cache.variants.size === 0 };
}

export function getCharacterManifest() {
  return cache.manifest;
}

// 換色材質：以原材質複製後改顏色，依 variant + 槽 + 顏色快取
function paintedMaterial(variant, slot, color, src) {
  const c = new THREE.Color(color);
  const key = `${variant}|${slot}|${c.getHexString()}`;
  let m = paintCache.get(key);
  if (!m) {
    m = src.clone();
    m.color.copy(c);
    paintCache.set(key, m);
  }
  return m;
}

function fallbackCharacter(variant, colors) {
  return { root: createHumanoid(colors), mixer: null, clips: new Map(), bones: new Map(), variant, fallback: true };
}

// 建立角色；回傳 { root, mixer, clips: Map<name, AnimationClip>, bones: Map<name, Bone>, variant, fallback }
// colors 未給的槽沿用 manifest 該變體的預設色
export function createCharacter({ variant = DEFAULT_VARIANT, colors = {} } = {}) {
  const tpl = cache.variants.get(variant);
  if (!tpl) {
    warnOnce(`變體 ${variant} 未載入`);
    return fallbackCharacter(variant, colors);
  }
  const slots = new Set(cache.manifest.materialSlots || []);
  const want = { ...(tpl.entry.colors || {}), ...colors };
  const root = SkeletonUtils.clone(tpl.scene);
  const bones = new Map();
  root.traverse((o) => {
    if (o.isBone) bones.set(o.name, o);
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = false;
    const paint = (mat) => (mat && slots.has(mat.name) && want[mat.name] ? paintedMaterial(variant, mat.name, want[mat.name], mat) : mat);
    o.material = Array.isArray(o.material) ? o.material.map(paint) : paint(o.material);
  });
  root.name = `character-${variant}`;
  return { root, mixer: new THREE.AnimationMixer(root), clips: new Map(tpl.clips), bones, variant, fallback: false };
}

// 移除角色：停止動作、釋放 mixer 綁定快取、從場景拿掉；共用幾何與材質留在快取不 dispose
export function disposeCharacter(character) {
  if (character.mixer) {
    character.mixer.stopAllAction();
    character.mixer.uncacheRoot(character.root);
    character.mixer = null;
  }
  character.root.removeFromParent();
}
