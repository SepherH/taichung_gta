// 彈藥拾取（契約 §13）：createAmmoPickups({ scene, bus, points, amount = 12, respawnSec = 90, heightAt?, canPickup? })
//   → { update(dt, playerPos), nearest(pos) → interactable|null, markers() → [{ x, z, kind: 'ammo', label }], dispose() }
// 玩家進入 PICKUP_RADIUS（1.5 m）自動拾取（不必按 E）→ emit pickup:ammo { amount, x, z }，該點隱藏 respawnSec 秒後重生
// 由整合層訂閱 pickup:ammo 呼叫 weapons.addAmmo(amount)；canPickup() 回 false（例：備彈已滿）時不拾取、彈藥盒留著
// nearest(pos)：INTERACT_RADIUS 內最近的可拾取點 → interactable { id, text, dist, priority: 0, act() }（按 E 也可撿；自動拾取為主）；
//   canPickup() 回 false 時回 null（備彈已滿不提示）
// 外觀：共用幾何 / 材質的小彈藥盒（綠色盒 + 黃色標），緩慢旋轉上下浮動；scene 省略時只跑邏輯（測試）
// 每幀不配置新物件（markers 陣列與 interactable 物件重用）
import * as THREE from 'three';

export const PICKUP_RADIUS = 1.5;
export const INTERACT_RADIUS = 3;
const BOB_HEIGHT = 0.45; // 彈藥盒離地高度（m）
const BOB_AMP = 0.08;
const SPIN = 1.6; // rad/s

// 七期路口人行道上的預設點位（世界 x/z；由 citymodel 的 junctions 取老虎城周邊 700 m 內、彼此相距 ≥ 180 m 的具名路口，
// 在路口斜角 radius + 3–6 m 處取「不在車道（含 0.8 m 餘裕）、不在建築 1.5 m 內、不在水域」的點，寫死為常數）
export const DEFAULT_AMMO_POINTS = [
  { x: 88.8, z: -21.8 }, // 河南路三段（老虎城旁）
  { x: -7.1, z: 141.0 }, // 市政北二路 / 河南路三段
  { x: -138.6, z: -42.5 }, // 朝馬七街 / 朝富路
  { x: -19.5, z: -246.5 }, // 朝馬二街 / 朝富路
  { x: -259.1, z: 159.8 }, // 朝富路 / 龍門路
  { x: 308.3, z: -71.3 }, // 惠民路 / 市政北七路
  { x: -319.9, z: -55.5 }, // 黎明路二段 / 市政北二路
];

let sharedGeo = null;
let sharedMats = null;
function crateParts() {
  if (!sharedGeo) {
    sharedGeo = { box: new THREE.BoxGeometry(0.42, 0.26, 0.28), band: new THREE.BoxGeometry(0.44, 0.07, 0.3) };
    sharedMats = {
      box: new THREE.MeshStandardMaterial({ color: 0x4a5a2a, roughness: 0.8 }),
      band: new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.5, emissive: 0x3a2a00 }),
    };
  }
  return { geo: sharedGeo, mats: sharedMats };
}

export function createAmmoPickups({ scene = null, bus = null, points = DEFAULT_AMMO_POINTS, amount = 12, respawnSec = 90, heightAt = null, canPickup = null } = {}) {
  const list = (points || []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.z)).map((p, i) => ({
    id: `ammo-${i}`,
    x: p.x,
    z: p.z,
    y: Number.isFinite(p.y) ? p.y : heightAt ? heightAt(p.x, p.z) : 0,
    active: true,
    respawnT: 0,
    mesh: null,
  }));
  let time = 0;
  let disposed = false;
  const markerList = [];
  const markerObjs = list.map((p) => ({ x: p.x, z: p.z, kind: 'ammo', label: '彈藥' }));

  if (scene) {
    const { geo, mats } = crateParts();
    for (const p of list) {
      const g = new THREE.Group();
      g.name = p.id;
      g.add(new THREE.Mesh(geo.box, mats.box), new THREE.Mesh(geo.band, mats.band));
      g.position.set(p.x, p.y + BOB_HEIGHT, p.z);
      scene.add(g);
      p.mesh = g;
    }
  }

  function take(p) {
    if (!p.active || disposed) return false;
    if (canPickup && !canPickup()) return false;
    p.active = false;
    p.respawnT = respawnSec;
    if (p.mesh) p.mesh.visible = false;
    if (bus) bus.emit('pickup:ammo', { amount, x: p.x, z: p.z });
    return true;
  }

  const inter = { id: '', text: '撿彈藥', dist: 0, priority: 0, act: null, _p: null };
  inter.act = () => (inter._p ? take(inter._p) : false);

  function update(dt, playerPos) {
    if (disposed) return;
    time += dt;
    const r2 = PICKUP_RADIUS * PICKUP_RADIUS;
    for (const p of list) {
      if (!p.active) {
        p.respawnT -= dt;
        if (p.respawnT <= 0) {
          p.active = true;
          p.respawnT = 0;
          if (p.mesh) p.mesh.visible = true;
        } else continue;
      }
      if (p.mesh) {
        p.mesh.rotation.y = time * SPIN;
        p.mesh.position.y = p.y + BOB_HEIGHT + Math.sin(time * 2.2 + p.x) * BOB_AMP;
      }
      if (playerPos) {
        const dx = playerPos.x - p.x;
        const dz = playerPos.z - p.z;
        if (dx * dx + dz * dz <= r2 && (playerPos.y === undefined || Math.abs(playerPos.y - p.y) < 2.5)) take(p);
      }
    }
  }

  function nearest(pos) {
    if (disposed || !pos) return null;
    if (canPickup && !canPickup()) return null; // 備彈已滿：不顯示「撿彈藥」提示（take 也不會消耗彈藥盒）
    let best = null;
    let bestD = INTERACT_RADIUS;
    for (const p of list) {
      if (!p.active) continue;
      const d = Math.hypot(pos.x - p.x, pos.z - p.z);
      if (d <= bestD) {
        bestD = d;
        best = p;
      }
    }
    if (!best) return null;
    inter.id = best.id;
    inter.dist = bestD;
    inter._p = best;
    return inter;
  }

  function markers() {
    markerList.length = 0;
    for (let i = 0; i < list.length; i++) if (list[i].active) markerList.push(markerObjs[i]);
    return markerList;
  }

  function dispose() {
    disposed = true;
    for (const p of list) {
      if (p.mesh && p.mesh.parent) p.mesh.parent.remove(p.mesh);
      p.mesh = null;
    }
  }

  return { update, nearest, markers, dispose, points: list };
}
