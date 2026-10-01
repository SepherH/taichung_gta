// 車輛模型：依 public/models/vehicles/manifest.json（美術線交付）載入車輛 glb；缺檔時回傳空表，呼叫端退回 vehicle.js 的程序化網格。
//
// manifest 格式：{ convention, vehicles: [ { id（對應 VEHICLE_TYPES：sedan / taxi / suv / bus / scooter / garbage_truck）, file（相對 manifest 目錄）,
//   length, width（含後照鏡）, height, wheelbase, track（機車 0）, wheelRadius, mass（kg）, seat [x, y, z]（駕駛 H 點）,
//   paint（預設車色）, wheels { 節點名: [x, y, z] }, notes } ] }；座標皆為 glTF（x 左右、y 上、z 前）
// glb 契約：原點 = 地面、外接盒中心正下方，+Y 上、面向 +Z（與 vehicle.js 本地座標相同，不旋轉）；
//   節點 body（車身）、wheel_fl / wheel_fr / wheel_rl / wheel_rr（機車 wheel_f / wheel_r），輪子原點在輪心、繞本地 X 滾動、繞本地 Y 轉向；
//   材質 paint = 車身主色（執行期換色）、headlight / taillight（計程車另有 taxisign、垃圾車另有 beacon）帶 emission
// 輪子旋轉順序設為 'YXZ'：rotation.x 滾動、rotation.y 轉向可同時設在同一節點；
//   root.userData.wheels / frontWheels 與 vehicle.js 的 animate() 相容
// 座位：manifest seat 為角色 drive 動作的 Hips 位置，角色原點 = seat − (0, SEAT_HIPS_HEIGHT, 0)（manifest convention）
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const BASE_URL = import.meta.env?.BASE_URL ?? './';
export const DEFAULT_VEHICLE_MANIFEST = `${BASE_URL}models/vehicles/manifest.json`;

const CAR_WHEELS = { fl: 'wheel_fl', fr: 'wheel_fr', rl: 'wheel_rl', rr: 'wheel_rr' };
const BIKE_WHEELS = { f: 'wheel_f', r: 'wheel_r' };
const FRONT_KEYS = new Set(['fl', 'fr', 'f']);
const PAINT_MATERIAL = 'paint';
// 夜間發光的材質名稱（vehicle.js 依此登記 daynight；beacon = 垃圾車琥珀色警示燈，夜間依 glb 原 emissiveIntensity 為上限發光）
export const EMISSIVE_MATERIALS = ['headlight', 'taillight', 'taxisign', 'beacon'];
// drive 動作 Hips 高於角色原點的量（m，manifest convention 與角色 manifest poses.driveHips）
export const SEAT_HIPS_HEIGHT = 0.3;
// 車門側：+1 = +X（左）、−1 = −X（右）；manifest notes 註明公車車門在右側（−X），其餘車型由駕駛座側（seat x 正負）上下車
const DOOR_SIDE = { bus: -1 };

const REQUIRED = ['length', 'width', 'height', 'wheelbase', 'wheelRadius', 'mass'];

const templates = new Map(); // type → { entry, scene, materials: Set<Material> }
const paintCache = new Map(); // `${type}|${hex}` → Material
const loads = new Map(); // manifest URL → Promise<Map>

async function fetchJson(fetchImpl, url) {
  try {
    const res = await fetchImpl(url, { cache: 'no-cache' });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function validEntry(e) {
  return (
    e && typeof e.id === 'string' && typeof e.file === 'string' && e.file &&
    REQUIRED.every((k) => Number.isFinite(e[k])) &&
    Array.isArray(e.seat) && e.seat.length === 3 && e.seat.every(Number.isFinite)
  );
}

// 找輪子節點；回傳 { 鍵: 節點 }，缺任何一個回傳 null
function findWheels(root) {
  for (const names of [CAR_WHEELS, BIKE_WHEELS]) {
    const out = {};
    for (const [k, n] of Object.entries(names)) out[k] = root.getObjectByName(n) || null;
    if (Object.values(out).every(Boolean)) return out;
  }
  return null;
}

// manifest 列出的輪子節點名稱須與 glb 一致（機車 track 0 → 兩輪）
function wheelsMatch(entry, wheels) {
  const listed = entry.wheels ? Object.keys(entry.wheels).sort() : null;
  const found = Object.values(wheels).map((w) => w.name).sort();
  return !listed || JSON.stringify(listed) === JSON.stringify(found);
}

// 載入全部車輛模型（同一個 manifest URL 重複呼叫共用同一次載入）；回傳 Map<type, entry>（無 manifest → 空 Map，不報錯）
// opts.fetch：可替換 fetch（無頭測試用）
export function loadVehicleModels(manifestUrl = DEFAULT_VEHICLE_MANIFEST, opts = {}) {
  if (!loads.has(manifestUrl)) loads.set(manifestUrl, doLoad(manifestUrl, opts.fetch || globalThis.fetch.bind(globalThis)));
  return loads.get(manifestUrl);
}

async function doLoad(manifestUrl, fetchImpl) {
  const out = new Map();
  const data = await fetchJson(fetchImpl, manifestUrl);
  const list = data && Array.isArray(data.vehicles) ? data.vehicles : null;
  if (!list) return out;
  const dir = manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1);
  const loader = new GLTFLoader();
  await Promise.all(
    list.map(async (e) => {
      if (!validEntry(e)) {
        console.warn('[vehicle-model] manifest 項目欄位不完整，略過：', e && (e.id || e.file));
        return;
      }
      try {
        const res = await fetchImpl(`${dir}${e.file}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const gltf = await loader.parseAsync(await res.arrayBuffer(), dir);
        const wheels = findWheels(gltf.scene);
        if (!gltf.scene.getObjectByName('body') || !wheels) throw new Error('缺 body 或輪子節點');
        if (!wheelsMatch(e, wheels)) throw new Error('輪子節點與 manifest wheels 不符');
        const materials = new Set();
        gltf.scene.traverse((o) => {
          if (o.isMesh) for (const m of [].concat(o.material)) if (m) materials.add(m);
        });
        templates.set(e.id, { entry: e, scene: gltf.scene, materials });
        out.set(e.id, e);
      } catch (err) {
        console.warn(`[vehicle-model] ${e.id}（${e.file}）載入失敗，退回程序化車：`, err && err.message ? err.message : err);
      }
    }),
  );
  return out;
}

// 已載入模型的共用材質（同車型所有複本共用，換色的 paint 除外）；供呼叫端登記夜間發光
export function vehicleTemplateMaterials(type) {
  const tpl = templates.get(type);
  return tpl ? [...tpl.materials] : [];
}

function paintedMaterial(type, color, src) {
  const c = new THREE.Color(color);
  const key = `${type}|${c.getHexString()}`;
  let m = paintCache.get(key);
  if (!m) {
    m = src.clone();
    m.color.copy(c);
    paintCache.set(key, m);
  }
  return m;
}

// manifest 規格 → VehicleBody / vehicle.js 可直接合併的 spec（同名欄位覆寫 VEHICLE_TYPES 的外形）
function specOf(type, entry) {
  const twoWheeler = !entry.track;
  const seat = { x: entry.seat[0], y: entry.seat[1], z: entry.seat[2] };
  return {
    length: entry.length,
    width: entry.width,
    height: entry.height,
    wheelbase: entry.wheelbase,
    track: twoWheeler ? 0 : entry.track,
    wheelRadius: entry.wheelRadius,
    mass: entry.mass,
    seat,
    doorSide: DOOR_SIDE[type] ?? (Math.sign(seat.x) || 1),
    twoWheeler,
  };
}

// 建立車輛模型；回傳 { root, wheels, spec } 或 null（該車型沒有模型 → 呼叫端退回程序化車）
// color 省略時用 manifest 的 paint 預設色
export function createVehicleModel(type, color) {
  const tpl = templates.get(type);
  if (!tpl) return null;
  const { entry } = tpl;
  const root = tpl.scene.clone(); // 共用幾何與材質
  const paint = color || entry.paint;
  const swap = (m) => (m && m.color && m.name === PAINT_MATERIAL ? paintedMaterial(type, paint, m) : m);
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    if (paint) o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
  });

  const wheels = findWheels(root);
  const all = [];
  const front = [];
  for (const [k, w] of Object.entries(wheels)) {
    w.rotation.order = 'YXZ';
    all.push(w);
    if (FRONT_KEYS.has(k)) front.push(w);
  }
  root.userData.wheels = all;
  root.userData.frontWheels = front;
  root.userData.glb = true;
  root.name = `vehicle-${type}`;
  return { root, wheels, spec: specOf(type, entry) };
}
