// 武器模型（契約 §13）：loadWeaponModels(base) 讀 <base>manifest.json 與 glb；缺檔 / 404 / 回退成 index.html / 解析失敗 →
//   佔位幾何（球棒 0.85 m 圓柱、手槍 L 形方塊），只 console.info 一次，不丟例外、不 console.error
// manifest：{ bat:{ file, gripOffset:[x,y,z], tipOffset:[x,y,z], length, type }, pistol:{ …, muzzleOffset? } }
//   也接受陣列形式 [{ id: 'bat', file, … }]（id 缺時讀 name / type）與美術實檔形式
//   { units, axes, socket, weapons: [ { id, name, type, file, length, gripOffset, tipOffset, offHandOffset, sweep: { from, to, radius }, socketRotation: [x,y,z,w] } ] }
// 回傳 Promise<{ bat, pistol, smg, shotgun }>，每把：{ id, object（THREE.Object3D，原點 = 握把附近、模型本地座標）, grip, tip, muzzle（THREE.Vector3，
//   武器本地座標；球棒 muzzle = null；手槍無 muzzleOffset 時 = tipOffset）, offHand（THREE.Vector3|null）, length, type,
//   socketQuaternion（THREE.Quaternion；掛到 weapon_socket 骨時設 object.quaternion，缺 = 單位四元數）,
//   sweep（{ from, to: THREE.Vector3, radius }，球棒近戰判定段；缺 = grip→tip 的 40%–100% 段、半徑 0.04；手槍 null）, placeholder: boolean }
// 本地座標慣例（佔位幾何）：球棒握把在原點、棒身沿 +Y；手槍握把在原點、槍管沿 +Z（槍口 (0, 0.075, 0.2)）
// 本地座標慣例（美術實檔 glTF）：原點 = 握點、+Z 前端（棒頭 / 槍口）、+Y 上；掛上後 position = 0、quaternion = socketQuaternion
// W3 attachWeapon(character, model.object, { gripOffset: model.grip }) 掛到右手；棒頭 / 槍口世界座標 = object.localToWorld(tip / muzzle 的複本)
// makeBatSegment(model) → getBatSegment(gripOut, tipOut)：以 sweep 段的世界座標填入（注入 createWeapons 的 getBatSegment）
// Phase 14：回傳另含 smg / shotgun（manifest 有該項才載 glb；缺項 / 載入失敗 → 佔位長槍幾何 placeholderLongGun）；
//   長槍 muzzle = tipOffset（或 muzzleOffset）、offHand = offHandOffset（左手扶握點；目前無雙手 clip / IK，供日後使用）；
//   缺檔提示只在 manifest 列了長槍但 glb 讀不到時併入「武器模型缺檔」那一則（manifest 沒列 = 安靜用佔位）
import * as THREE from 'three';

const BASE_URL = import.meta.env?.BASE_URL ?? './';
export const DEFAULT_WEAPON_BASE = 'models/weapons/';
export const BAT_LENGTH = 0.85;
export const PISTOL_MUZZLE = [0, 0.075, 0.2];
export const SWEEP_FROM = 0.4; // 缺 sweep 時：grip→tip 的 40%–100% 段
export const SWEEP_RADIUS = 0.04;

let infoShown = false;
function infoOnce(msg) {
  if (infoShown) return;
  infoShown = true;
  console.info(msg);
}

// 測試用：重設「只提示一次」
export function _resetWeaponModelInfo() {
  infoShown = false;
}

// 預設 JSON 讀取：非 2xx、內容不是 JSON（dev server 回退成 index.html）→ null
async function defaultFetchJson(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const text = await res.text();
    if (/^\s*</.test(text)) return null;
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

// 預設 glb 讀取（動態載入 GLTFLoader；失敗回 null）
async function defaultLoadGltf(url) {
  try {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const gltf = await new GLTFLoader().loadAsync(url);
    return gltf && gltf.scene ? gltf.scene : null;
  } catch (err) {
    return null;
  }
}

function vec3(a, fallback) {
  if (Array.isArray(a) && a.length === 3 && a.every(Number.isFinite)) return new THREE.Vector3(a[0], a[1], a[2]);
  return fallback ? fallback.clone() : null;
}

// [x,y,z,w] → 正規化 THREE.Quaternion；缺 / 非有限數 / 長度 0 → 單位四元數
function quat(a) {
  const q = new THREE.Quaternion();
  if (!Array.isArray(a) || a.length !== 4 || !a.every(Number.isFinite)) return q;
  const len = Math.hypot(a[0], a[1], a[2], a[3]);
  if (!(len > 1e-9)) return q;
  return q.set(a[0] / len, a[1] / len, a[2] / len, a[3] / len);
}

// 球棒掃掠段：manifest sweep（from / to / radius）優先；缺則 grip→tip 的 40%–100% 段、半徑 0.04
export function batSweep(sweep, grip, tip) {
  const s = sweep && typeof sweep === 'object' ? sweep : {};
  const from = vec3(s.from, null) || grip.clone().lerp(tip, SWEEP_FROM);
  const to = vec3(s.to, null) || tip.clone();
  const radius = Number.isFinite(s.radius) && s.radius > 0 ? s.radius : SWEEP_RADIUS;
  return { from, to, radius };
}

const LONG_GUNS = { smg: { label: '衝鋒槍', length: 0.454 }, shotgun: { label: '散彈槍', length: 1.018 } };
const placeholderFor = (id) => (id === 'bat' ? placeholderBat() : LONG_GUNS[id] ? placeholderLongGun(id) : placeholderPistol());

// 單把 manifest 項目 → 正規化欄位（不含 object）；entry 缺 → 佔位幾何的數值
export function normalizeWeaponEntry(id, entry) {
  const ph = placeholderFor(id);
  const e = entry && typeof entry === 'object' ? entry : null;
  if (!e) {
    return { id, grip: ph.grip, tip: ph.tip, muzzle: ph.muzzle, offHand: null, length: ph.length, type: ph.type, socketQuaternion: ph.socketQuaternion, sweep: ph.sweep };
  }
  const length = Number.isFinite(e.length) && e.length > 0 ? e.length : ph.length;
  const grip = vec3(e.gripOffset, ph.grip);
  const tip = vec3(e.tipOffset, id === 'bat' ? new THREE.Vector3(0, length, 0) : ph.tip);
  const muzzle = id === 'pistol' || LONG_GUNS[id] ? vec3(e.muzzleOffset, tip) : null;
  return {
    id,
    grip,
    tip,
    muzzle,
    offHand: vec3(e.offHandOffset, null),
    length,
    type: typeof e.type === 'string' && e.type ? e.type : ph.type,
    socketQuaternion: quat(e.socketRotation),
    sweep: id === 'bat' ? batSweep(e.sweep, grip, tip) : null,
  };
}

// 球棒掃掠段 → 世界座標的 getBatSegment（createWeapons 注入用）
// 模型沒掛到場景（parent 為 null）或隱藏時回 false → weapons.js 退回程序揮擊弧；每次呼叫不配置新物件
export function makeBatSegment(model) {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  return function getBatSegment(gripOut, tipOut) {
    const obj = model && model.object;
    const sw = model && model.sweep;
    if (!obj || !sw || !obj.parent || !obj.visible) return false;
    obj.updateWorldMatrix(true, false);
    a.copy(sw.from).applyMatrix4(obj.matrixWorld);
    b.copy(sw.to).applyMatrix4(obj.matrixWorld);
    gripOut.x = a.x;
    gripOut.y = a.y;
    gripOut.z = a.z;
    tipOut.x = b.x;
    tipOut.y = b.y;
    tipOut.z = b.z;
    return true;
  };
}

// manifest（物件或陣列）→ { bat, pistol } 項目（缺者 null）
export function normalizeWeaponManifest(m) {
  const out = { bat: null, pistol: null };
  if (!m || typeof m !== 'object') return out;
  if (Array.isArray(m)) {
    for (const e of m) {
      if (!e || typeof e !== 'object') continue;
      const id = e.id || e.name || e.type;
      if (id === 'bat' || id === 'pistol') out[id] = e;
    }
    return out;
  }
  const list = Array.isArray(m.weapons) ? normalizeWeaponManifest(m.weapons) : null;
  out.bat = (m.bat && typeof m.bat === 'object' ? m.bat : null) || (list && list.bat);
  out.pistol = (m.pistol && typeof m.pistol === 'object' ? m.pistol : null) || (list && list.pistol);
  return out;
}

// 佔位球棒：握把在原點、沿 +Y 0.85 m 的圓柱（棒頭粗、握把細）
export function placeholderBat() {
  const geo = new THREE.CylinderGeometry(0.035, 0.02, BAT_LENGTH, 10);
  geo.translate(0, BAT_LENGTH / 2, 0);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xb08850, roughness: 0.7 }));
  mesh.name = 'bat_placeholder';
  const root = new THREE.Group();
  root.name = 'weapon_bat';
  root.add(mesh);
  return {
    id: 'bat', object: root, grip: new THREE.Vector3(0, 0, 0), tip: new THREE.Vector3(0, BAT_LENGTH, 0), muzzle: null, offHand: null,
    length: BAT_LENGTH, type: 'melee', socketQuaternion: new THREE.Quaternion(),
    sweep: { from: new THREE.Vector3(0, BAT_LENGTH * SWEEP_FROM, 0), to: new THREE.Vector3(0, BAT_LENGTH, 0), radius: SWEEP_RADIUS },
    placeholder: true,
  };
}

// manifest（物件或陣列）→ { smg, shotgun } 項目（缺者 null）
export function normalizeLongGunManifest(m) {
  const out = { smg: null, shotgun: null };
  if (!m || typeof m !== 'object') return out;
  const list = Array.isArray(m) ? m : Array.isArray(m.weapons) ? m.weapons : null;
  if (list) {
    for (const e of list) {
      if (!e || typeof e !== 'object') continue;
      const id = e.id || e.name;
      if (id === 'smg' || id === 'shotgun') out[id] = e;
    }
  }
  if (!Array.isArray(m)) for (const id of ['smg', 'shotgun']) if (m[id] && typeof m[id] === 'object') out[id] = m[id];
  return out;
}

// 佔位長槍（衝鋒槍 / 散彈槍）：槍身沿 +Z（長度同 manifest）、握把往下；槍口在 (0, 0.05, length × 0.75)
export function placeholderLongGun(id) {
  const g = LONG_GUNS[id] || LONG_GUNS.smg;
  const L = g.length;
  const mat = new THREE.MeshStandardMaterial({ color: id === 'shotgun' ? 0x4a3524 : 0x24262a, roughness: 0.55, metalness: 0.35 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.06, L), mat);
  body.position.set(0, 0.05, L * 0.25);
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.1, 0.045), mat);
  handle.position.set(0, 0, 0);
  handle.rotation.x = -0.25;
  const root = new THREE.Group();
  root.name = `weapon_${id}`;
  root.add(body, handle);
  const m = new THREE.Vector3(0, 0.05, L * 0.75);
  return {
    id, object: root, grip: new THREE.Vector3(0, 0, 0), tip: m.clone(), muzzle: m, offHand: new THREE.Vector3(0, 0, L * 0.4), length: L, type: 'ranged',
    socketQuaternion: new THREE.Quaternion(), sweep: null, placeholder: true,
  };
}

// 佔位手槍：L 形（槍身沿 +Z + 往下的握把）
export function placeholderPistol() {
  const mat = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.5, metalness: 0.4 });
  const slide = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.04, 0.2), mat);
  slide.position.set(0, 0.075, 0.1);
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.1, 0.045), mat);
  handle.position.set(0, 0.03, 0.01);
  handle.rotation.x = -0.25;
  const root = new THREE.Group();
  root.name = 'weapon_pistol';
  root.add(slide, handle);
  const m = new THREE.Vector3(...PISTOL_MUZZLE);
  return {
    id: 'pistol', object: root, grip: new THREE.Vector3(0, 0, 0), tip: m.clone(), muzzle: m, offHand: null, length: 0.2, type: 'gun',
    socketQuaternion: new THREE.Quaternion(), sweep: null, placeholder: true,
  };
}

async function loadOne(id, entry, base, loadGltf) {
  const ph = placeholderFor(id);
  if (!entry || typeof entry.file !== 'string' || !entry.file) return { model: ph, missing: true };
  const scene = await loadGltf(base + entry.file);
  if (!scene) return { model: ph, missing: true };
  const n = normalizeWeaponEntry(id, entry);
  scene.name = `weapon_${id}`;
  n.object = scene;
  n.placeholder = false;
  return { model: n, missing: false };
}

// opts：{ fetchJson(url) → obj|null, loadGltf(url) → Object3D|null }（node 測試注入）
export async function loadWeaponModels(base = DEFAULT_WEAPON_BASE, opts = {}) {
  const fetchJson = opts.fetchJson || defaultFetchJson;
  const loadGltf = opts.loadGltf || defaultLoadGltf;
  const root = /^(\w+:|\/|\.)/.test(base) ? base : BASE_URL + base;
  const dir = root.endsWith('/') ? root : root + '/';
  let manifest = null;
  try {
    manifest = await fetchJson(dir + 'manifest.json');
  } catch (err) {
    manifest = null;
  }
  const m = normalizeWeaponManifest(manifest);
  const lg = normalizeLongGunManifest(manifest);
  let bat;
  let pistol;
  let smg;
  let shotgun;
  try {
    [bat, pistol, smg, shotgun] = await Promise.all([
      loadOne('bat', m.bat, dir, loadGltf),
      loadOne('pistol', m.pistol, dir, loadGltf),
      lg.smg ? loadOne('smg', lg.smg, dir, loadGltf) : { model: placeholderLongGun('smg'), missing: false },
      lg.shotgun ? loadOne('shotgun', lg.shotgun, dir, loadGltf) : { model: placeholderLongGun('shotgun'), missing: false },
    ]);
  } catch (err) {
    bat = { model: placeholderBat(), missing: true };
    pistol = { model: placeholderPistol(), missing: true };
    smg = { model: placeholderLongGun('smg'), missing: false };
    shotgun = { model: placeholderLongGun('shotgun'), missing: false };
  }
  if (bat.missing || pistol.missing || smg.missing || shotgun.missing) {
    const miss = [bat.missing ? '球棒' : null, pistol.missing ? '手槍' : null, smg.missing ? '衝鋒槍' : null, shotgun.missing ? '散彈槍' : null].filter(Boolean).join('、');
    infoOnce(`武器模型缺檔（${miss}），改用佔位幾何`);
  }
  return { bat: bat.model, pistol: pistol.model, smg: smg.model, shotgun: shotgun.model };
}
