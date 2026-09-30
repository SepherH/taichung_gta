// 任務光柱（契約 §16）：半透明加色圓柱 + 緩慢脈動；物件池（幾何共用、材質每柱一份以便各自脈動）
// 起點 kind 'start'（金黃）、目的地 kind 'dest'（青藍）；柱高 220 m，高過七期最高樓，遠處也看得到
// update 只改既有物件的 opacity / scale，不配置新物件
// 檔名刻意避開 beacon 等廣告阻擋字樣（原 beacon.js 會被瀏覽器阻擋外掛攔下，整個模組圖不執行）
import * as THREE from 'three';

export const BEACON_HEIGHT = 220;
export const BEACON_RADIUS = 2.4;
export const BEACON_COLORS = { start: 0xffc93f, dest: 0x3fd8ff };
const BASE_OPACITY = 0.3;
const PULSE_SPEED = 1.6; // rad/s，約 4 s 一個週期

export function createBeaconPool({ scene, heightAt = null } = {}) {
  const geo = new THREE.CylinderGeometry(BEACON_RADIUS, BEACON_RADIUS, BEACON_HEIGHT, 20, 1, true);
  geo.translate(0, BEACON_HEIGHT / 2 - 12, 0); // 底部略埋入地面，地形起伏（秋紅谷谷底）也不露底
  const coreGeo = new THREE.CylinderGeometry(BEACON_RADIUS * 0.35, BEACON_RADIUS * 0.35, BEACON_HEIGHT, 10, 1, true);
  coreGeo.translate(0, BEACON_HEIGHT / 2 - 12, 0);
  const pool = [];
  const live = [];
  let time = 0;

  function makeMaterial(opacity) {
    return new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
  }

  function build() {
    const group = new THREE.Group();
    group.name = 'mission-beacon';
    const shell = new THREE.Mesh(geo, makeMaterial(BASE_OPACITY));
    const core = new THREE.Mesh(coreGeo, makeMaterial(BASE_OPACITY * 1.6));
    shell.renderOrder = 5;
    core.renderOrder = 5;
    group.add(shell, core);
    return { group, shell, core, kind: 'start', phase: 0, owner: null };
  }

  // 取一根光柱放到 (x, z)；owner 供呼叫端辨識
  function acquire(kind, x, z, owner = null) {
    const b = pool.pop() || build();
    b.kind = kind === 'dest' ? 'dest' : 'start';
    b.owner = owner;
    b.phase = live.length * 1.3;
    const color = BEACON_COLORS[b.kind];
    b.shell.material.color.setHex(color);
    b.core.material.color.setHex(color);
    const y = typeof heightAt === 'function' ? Number(heightAt(x, z)) || 0 : 0;
    b.group.position.set(x, y, z);
    b.group.visible = true;
    if (scene && !b.group.parent) scene.add(b.group);
    live.push(b);
    return b;
  }

  function release(b) {
    const i = live.indexOf(b);
    if (i < 0) return;
    live.splice(i, 1);
    b.group.visible = false;
    b.owner = null;
    if (b.group.parent) b.group.parent.remove(b.group);
    pool.push(b);
  }

  function releaseAll() {
    while (live.length) release(live[live.length - 1]);
  }

  function update(dt) {
    time += dt > 0 ? dt : 0;
    for (let i = 0; i < live.length; i++) {
      const b = live[i];
      const s = Math.sin(time * PULSE_SPEED + b.phase);
      const k = 0.72 + 0.28 * s;
      b.shell.material.opacity = BASE_OPACITY * k;
      b.core.material.opacity = BASE_OPACITY * 1.6 * (0.8 + 0.2 * s);
      const r = 1 + 0.12 * s;
      b.shell.scale.set(r, 1, r);
    }
  }

  function dispose() {
    releaseAll();
    for (const b of pool) {
      b.shell.material.dispose();
      b.core.material.dispose();
    }
    pool.length = 0;
    geo.dispose();
    coreGeo.dispose();
  }

  return { acquire, release, releaseAll, update, dispose, live, pool };
}
