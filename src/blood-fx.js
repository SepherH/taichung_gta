// 流血特效（契約 §14）：只做地面血跡貼片與血滴粒子，不做肢解與傷口特寫；settings.showBlood 為 false 時不生成且清空。
//
// createBloodFx({ scene, settings, heightAt, atlasUrl, dropUrl, maxDecals = 16, maxDrops = 32, rng, loadTexture })
//   → { onHit(e), onKnockdown(e), update(dt, camera), clear(), stats() → { decals, drops, drawCalls, atlas }, dispose() }
//   - 地面貼片：單一 InstancedMesh（1 draw call），4×4 圖集（每個 instance 以 aDecal 屬性選格 + 透明度）、
//     depthWrite false + polygonOffset，高度 = heightAt(x, z) + DECAL_LIFT；DECAL_LIFE 秒後 DECAL_FADE 秒淡出回收；
//     池滿時覆寫最舊者（硬上限 maxDecals）
//   - 血滴：單一 Points（1 draw call，drawRange = 使用中數量），拋物線、無碰撞，落到生成時記下的地面高度即消失；
//     池滿時新的丟棄（硬上限 maxDrops）
//   - 物件池以「前段連續」維護（移除 = 與最後一個交換），update 只走使用中的；每幀不配置新物件
//   - 圖集：先用程序畫的 4×4 血跡（有 2D canvas → CanvasTexture；node 無 canvas → DataTexture），
//     atlasUrl / dropUrl 載入成功後換上實檔；404 / 回退成 index.html（解碼失敗）→ 保持程序貼圖，只 console.info 一次
//   - onHit(e)：combat:hit payload（weapon, x, y, z, dirX, dirZ）→ 擊中點噴血滴（拳 2–3 / 棒 4–6 / 槍 6–8 / 車 4–6），
//     機率生一片小貼片（拳 0.25、其餘 0.5）
//   - onKnockdown(e)：ped:knockdown payload（x, z, cause）→ 倒地點 1 片大貼片 + 8 滴
//   - heightAt(x, z) → 地面 y（number；缺 / 非有限值 → e.groundY ?? 0）
import * as THREE from 'three';

export const DECAL_LIFE = 12; // 貼片完整顯示秒數
export const DECAL_FADE = 2; // 之後淡出秒數
export const DECAL_LIFT = 0.02; // 貼地抬高（m），另加每格 DECAL_STACK 避免重疊貼片互相閃爍
const DECAL_STACK = 0.0015;
export const DROP_GRAVITY = 9.8;
export const DROP_SIZE = 0.07; // 血滴大小（m，sizeAttenuation）
// 各武器每次命中的血滴數 [min, max] 與小貼片機率
export const HIT_DROPS = {
  fist: [2, 3],
  bat: [4, 6],
  pistol: [6, 8],
  vehicle: [4, 6],
};
export const HIT_DECAL_CHANCE = { fist: 0.25, bat: 0.5, pistol: 0.5, vehicle: 0.5 };
export const KNOCKDOWN_DROPS = 8;
const SMALL_DECAL = [0.35, 0.6]; // 小貼片邊長（m）
const BIG_DECAL = [1.2, 1.7]; // 倒地大貼片邊長（m）
const HIT_HEIGHT = 1.2; // payload 沒有 y 時的擊中高度（地面以上 m）
const ATLAS_CELLS = 4;
const PROC_CELL = 32; // 程序圖集每格像素（DataTexture：128 × 128）

let infoLogged = false;
function infoOnce(msg) {
  if (infoLogged) return;
  infoLogged = true;
  console.info(`[blood-fx] ${msg}`);
}

// 可重現的小亂數（程序圖集用，不影響注入的 rng）
function hashRand(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// 程序血跡：每格幾個橢圓團 + 小噴點；回傳 [{ x, y, r, rx }]（0–1 格內座標）
function cellBlobs(cell) {
  const r = hashRand(cell * 7919 + 17);
  const blobs = [];
  const n = 3 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) {
    const main = i === 0;
    blobs.push({ x: 0.5 + (main ? 0 : (r() - 0.5) * 0.5), y: 0.5 + (main ? 0 : (r() - 0.5) * 0.5), r: main ? 0.22 + r() * 0.1 : 0.05 + r() * 0.12, rx: 0.7 + r() * 0.6 });
  }
  for (let i = 0; i < 6; i++) blobs.push({ x: 0.1 + r() * 0.8, y: 0.1 + r() * 0.8, r: 0.015 + r() * 0.03, rx: 1 });
  return blobs;
}

// 有 2D canvas → CanvasTexture；否則（node）→ DataTexture。圖集 4×4，每格 PROC_CELL 像素
export function proceduralAtlas() {
  const size = PROC_CELL * ATLAS_CELLS;
  const doc = globalThis.document;
  let ctx = null;
  let canvas = null;
  try {
    canvas = doc && typeof doc.createElement === 'function' ? doc.createElement('canvas') : null;
    ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  } catch {
    ctx = null;
  }
  if (ctx) {
    canvas.width = size;
    canvas.height = size;
    ctx.clearRect(0, 0, size, size);
    for (let c = 0; c < ATLAS_CELLS * ATLAS_CELLS; c++) {
      const ox = (c % ATLAS_CELLS) * PROC_CELL;
      const oy = Math.floor(c / ATLAS_CELLS) * PROC_CELL;
      for (const b of cellBlobs(c)) {
        ctx.fillStyle = 'rgba(110, 8, 8, 0.9)';
        ctx.beginPath();
        ctx.ellipse(ox + b.x * PROC_CELL, oy + b.y * PROC_CELL, b.r * PROC_CELL * b.rx, b.r * PROC_CELL, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.userData.procedural = 'canvas';
    return tex;
  }
  const data = new Uint8Array(size * size * 4);
  for (let c = 0; c < ATLAS_CELLS * ATLAS_CELLS; c++) {
    const ox = (c % ATLAS_CELLS) * PROC_CELL;
    const oy = Math.floor(c / ATLAS_CELLS) * PROC_CELL;
    const blobs = cellBlobs(c);
    for (let py = 0; py < PROC_CELL; py++) {
      for (let px = 0; px < PROC_CELL; px++) {
        const u = (px + 0.5) / PROC_CELL;
        const v = (py + 0.5) / PROC_CELL;
        let a = 0;
        for (const b of blobs) {
          const dx = (u - b.x) / b.rx;
          const dy = v - b.y;
          const d = Math.sqrt(dx * dx + dy * dy) / b.r;
          if (d < 1) a = Math.max(a, Math.min(1, (1 - d) * 4));
        }
        const i = ((oy + py) * size + ox + px) * 4;
        data[i] = 110;
        data[i + 1] = 8;
        data[i + 2] = 8;
        data[i + 3] = Math.round(a * 230);
      }
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  tex.userData.procedural = 'data';
  return tex;
}

// 圓形血滴貼圖（程序）：8 × 8 DataTexture 徑向漸層
function proceduralDrop() {
  const n = 8;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) / (n / 2);
      const i = (y * n + x) * 4;
      data[i] = 120;
      data[i + 1] = 6;
      data[i + 2] = 6;
      data[i + 3] = d < 1 ? Math.round(255 * Math.min(1, (1 - d) * 3)) : 0;
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  tex.userData.procedural = 'data';
  return tex;
}

// 預設貼圖載入：瀏覽器用 TextureLoader；node（無 document / Image）直接回報失敗
function defaultLoadTexture(url, onLoad, onError) {
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    onError(new Error('no image decoder'));
    return;
  }
  new THREE.TextureLoader().load(url, onLoad, undefined, onError);
}

// 貼片材質：Lambert（受日夜光照）+ 以 instance 屬性 aDecal（格 x, 格 y, 透明度）選圖集格與淡出
function decalMaterial(map) {
  const mat = new THREE.MeshLambertMaterial({
    map,
    color: 0xffffff,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aDecal;\nvarying vec3 vDecal;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvDecal = aDecal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDecal;')
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, ( vMapUv + vDecal.xy ) * ${(1 / ATLAS_CELLS).toFixed(4)} );
  diffuseColor *= sampledDiffuseColor;
#endif
  diffuseColor.a *= vDecal.z;`,
      );
  };
  mat.customProgramCacheKey = () => 'blood-decal-v1';
  return mat;
}

export function createBloodFx({
  scene,
  settings = null,
  heightAt = null,
  atlasUrl = 'art/fx/blood-atlas.png',
  dropUrl = 'art/fx/blood-drop.png',
  maxDecals = 16,
  maxDrops = 32,
  rng = Math.random,
  loadTexture = defaultLoadTexture,
} = {}) {
  const MAXD = Math.max(1, Math.floor(maxDecals));
  const MAXP = Math.max(1, Math.floor(maxDrops));

  // ---- 貼圖：先程序，實檔載入成功後換上 ----
  let atlasTex = proceduralAtlas();
  let dropTex = proceduralDrop();
  let atlasSource = atlasTex.userData.procedural;
  let disposed = false;

  // ---- 貼片 InstancedMesh ----
  const plane = new THREE.PlaneGeometry(1, 1);
  plane.rotateX(-Math.PI / 2); // 平躺，法線 +Y
  const aDecal = new THREE.InstancedBufferAttribute(new Float32Array(MAXD * 3), 3);
  aDecal.setUsage(THREE.DynamicDrawUsage);
  plane.setAttribute('aDecal', aDecal);
  const decalMat = decalMaterial(atlasTex);
  const decals = new THREE.InstancedMesh(plane, decalMat, MAXD);
  decals.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  decals.count = 0;
  decals.frustumCulled = false; // instance 散在各處，包圍球不會跟著更新
  decals.renderOrder = 1;
  decals.name = 'blood-decals';
  decals.visible = false;
  // 每片資料（平行陣列，前 nDecals 個使用中）
  const dX = new Float32Array(MAXD);
  const dY = new Float32Array(MAXD);
  const dZ = new Float32Array(MAXD);
  const dYaw = new Float32Array(MAXD);
  const dSize = new Float32Array(MAXD);
  const dAge = new Float32Array(MAXD);
  const dCell = new Uint8Array(MAXD);
  const dSeq = new Float64Array(MAXD); // 生成序號（最舊者先回收）
  let nDecals = 0;
  let seq = 0;

  // ---- 血滴 Points ----
  const pos = new Float32Array(MAXP * 3);
  const dropGeo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  dropGeo.setAttribute('position', posAttr);
  dropGeo.setDrawRange(0, 0);
  const dropMat = new THREE.PointsMaterial({ map: dropTex, color: 0xffffff, size: DROP_SIZE, sizeAttenuation: true, transparent: true, depthWrite: false, alphaTest: 0.05 });
  const drops = new THREE.Points(dropGeo, dropMat);
  drops.frustumCulled = false;
  drops.name = 'blood-drops';
  drops.visible = false;
  const vX = new Float32Array(MAXP);
  const vY = new Float32Array(MAXP);
  const vZ = new Float32Array(MAXP);
  const gY = new Float32Array(MAXP); // 生成時的地面高度
  let nDrops = 0;

  if (scene) scene.add(decals, drops);

  // ---- 實檔貼圖 ----
  if (atlasUrl) {
    loadTexture(
      atlasUrl,
      (tex) => {
        if (disposed) return tex.dispose();
        tex.colorSpace = THREE.SRGBColorSpace;
        atlasTex.dispose();
        atlasTex = tex;
        atlasSource = 'file';
        decalMat.map = tex;
        decalMat.needsUpdate = true;
      },
      () => infoOnce(`血跡圖集 ${atlasUrl} 不存在，改用程序血跡`),
    );
  }
  if (dropUrl) {
    loadTexture(
      dropUrl,
      (tex) => {
        if (disposed) return tex.dispose();
        tex.colorSpace = THREE.SRGBColorSpace;
        dropTex.dispose();
        dropTex = tex;
        dropMat.map = tex;
        dropMat.needsUpdate = true;
      },
      () => infoOnce(`血滴貼圖 ${dropUrl} 不存在，改用程序血滴`),
    );
  }

  // ---- 設定 ----
  const enabled = () => !settings || typeof settings.get !== 'function' || settings.get('showBlood') !== false;
  const unsub = settings && typeof settings.subscribe === 'function'
    ? settings.subscribe((key, value) => {
      if (key === 'showBlood' && value === false) clear();
    })
    : null;

  const tmpM = new THREE.Matrix4();
  const tmpQ = new THREE.Quaternion();
  const tmpP = new THREE.Vector3();
  const tmpS = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);

  function ground(x, z, fallback) {
    const h = heightAt ? heightAt(x, z) : null;
    return Number.isFinite(h) ? h : Number.isFinite(fallback) ? fallback : 0;
  }

  function writeDecal(i) {
    tmpQ.setFromAxisAngle(UP, dYaw[i]);
    tmpP.set(dX[i], dY[i], dZ[i]);
    tmpS.set(dSize[i], 1, dSize[i]);
    tmpM.compose(tmpP, tmpQ, tmpS);
    decals.setMatrixAt(i, tmpM);
    aDecal.array[i * 3] = dCell[i] % ATLAS_CELLS;
    aDecal.array[i * 3 + 1] = Math.floor(dCell[i] / ATLAS_CELLS);
    aDecal.array[i * 3 + 2] = decalAlpha(dAge[i]);
  }

  function decalAlpha(age) {
    return age <= DECAL_LIFE ? 1 : Math.max(0, 1 - (age - DECAL_LIFE) / DECAL_FADE);
  }

  function copyDecal(to, from) {
    dX[to] = dX[from];
    dY[to] = dY[from];
    dZ[to] = dZ[from];
    dYaw[to] = dYaw[from];
    dSize[to] = dSize[from];
    dAge[to] = dAge[from];
    dCell[to] = dCell[from];
    dSeq[to] = dSeq[from];
  }

  function spawnDecal(x, z, size, groundFallback) {
    let i = nDecals;
    if (i >= MAXD) {
      // 池滿：覆寫最舊者
      i = 0;
      for (let k = 1; k < nDecals; k++) if (dSeq[k] < dSeq[i]) i = k;
    } else nDecals++;
    dX[i] = x;
    dZ[i] = z;
    dY[i] = ground(x, z, groundFallback) + DECAL_LIFT + (seq % 8) * DECAL_STACK;
    dYaw[i] = rng() * Math.PI * 2;
    dSize[i] = size;
    dAge[i] = 0;
    dCell[i] = Math.floor(rng() * ATLAS_CELLS * ATLAS_CELLS) % (ATLAS_CELLS * ATLAS_CELLS);
    dSeq[i] = seq++;
    writeDecal(i);
    decals.count = nDecals;
    decals.visible = nDecals > 0; // 沒有貼片時整個略過（不送 draw call）
    decals.instanceMatrix.needsUpdate = true;
    aDecal.needsUpdate = true;
  }

  function removeDecal(i) {
    const last = nDecals - 1;
    if (i !== last) {
      copyDecal(i, last);
      writeDecal(i);
    }
    nDecals = last;
    decals.count = nDecals;
    decals.visible = nDecals > 0; // 沒有貼片時整個略過（不送 draw call）
    decals.instanceMatrix.needsUpdate = true;
  }

  function spawnDrop(x, y, z, vx, vy, vz, g) {
    if (nDrops >= MAXP) return false;
    const i = nDrops++;
    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = z;
    vX[i] = vx;
    vY[i] = vy;
    vZ[i] = vz;
    gY[i] = g;
    return true;
  }

  function removeDrop(i) {
    const last = nDrops - 1;
    if (i !== last) {
      pos[i * 3] = pos[last * 3];
      pos[i * 3 + 1] = pos[last * 3 + 1];
      pos[i * 3 + 2] = pos[last * 3 + 2];
      vX[i] = vX[last];
      vY[i] = vY[last];
      vZ[i] = vZ[last];
      gY[i] = gY[last];
    }
    nDrops = last;
  }

  // 噴一團血滴：以 (dirX, dirZ) 為主方向（攻擊方向），加散佈與上拋
  function spray(x, y, z, dirX, dirZ, n, g, speed) {
    let dx = Number.isFinite(dirX) ? dirX : 0;
    let dz = Number.isFinite(dirZ) ? dirZ : 0;
    const len = Math.hypot(dx, dz);
    if (len > 1e-6) {
      dx /= len;
      dz /= len;
    }
    for (let k = 0; k < n; k++) {
      const a = rng() * Math.PI * 2;
      const spread = 0.4 + rng() * 0.9;
      const s = speed * (0.5 + rng() * 0.8);
      if (!spawnDrop(x, y, z, dx * s + Math.cos(a) * spread, 0.8 + rng() * 1.8, dz * s + Math.sin(a) * spread, g)) break;
    }
    dropGeo.setDrawRange(0, nDrops);
    drops.visible = nDrops > 0;
    posAttr.needsUpdate = true;
  }

  function onHit(e) {
    if (!e || !enabled() || !Number.isFinite(e.x) || !Number.isFinite(e.z)) return;
    const w = HIT_DROPS[e.weapon] ? e.weapon : 'fist';
    const [lo, hi] = HIT_DROPS[w];
    const g = ground(e.x, e.z, e.groundY);
    const y = Number.isFinite(e.y) ? Math.max(e.y, g + 0.1) : g + HIT_HEIGHT;
    const n = lo + Math.floor(rng() * (hi - lo + 1));
    spray(e.x, y, e.z, e.dirX, e.dirZ, n, g, w === 'pistol' ? 2.2 : 1.4);
    if (rng() < HIT_DECAL_CHANCE[w]) {
      const off = 0.25 + rng() * 0.4; // 落在受擊者身後（攻擊方向）
      const dl = Math.hypot(e.dirX || 0, e.dirZ || 0) || 1;
      spawnDecal(e.x + ((e.dirX || 0) / dl) * off, e.z + ((e.dirZ || 0) / dl) * off, SMALL_DECAL[0] + rng() * (SMALL_DECAL[1] - SMALL_DECAL[0]), e.groundY);
    }
  }

  function onKnockdown(e) {
    if (!e || !enabled() || !Number.isFinite(e.x) || !Number.isFinite(e.z)) return;
    const g = ground(e.x, e.z, e.groundY);
    spawnDecal(e.x, e.z, BIG_DECAL[0] + rng() * (BIG_DECAL[1] - BIG_DECAL[0]), e.groundY);
    spray(e.x, g + 0.5, e.z, e.dirX, e.dirZ, KNOCKDOWN_DROPS, g, 0.8);
  }

  function update(dt, _camera) {
    if (!(dt > 0)) return;
    // 貼片：老化、淡出段才改透明度、到期回收（swap-remove 後同一格再檢查一次）
    let alphaDirty = false;
    for (let i = 0; i < nDecals; ) {
      dAge[i] += dt;
      const age = dAge[i];
      if (age >= DECAL_LIFE + DECAL_FADE) {
        removeDecal(i);
        alphaDirty = true;
        continue;
      }
      if (age > DECAL_LIFE) {
        aDecal.array[i * 3 + 2] = decalAlpha(age);
        alphaDirty = true;
      }
      i++;
    }
    if (alphaDirty) aDecal.needsUpdate = true;
    // 血滴：拋物線，落到地面即消失
    if (nDrops) {
      for (let i = 0; i < nDrops; ) {
        vY[i] -= DROP_GRAVITY * dt;
        const j = i * 3;
        pos[j] += vX[i] * dt;
        pos[j + 1] += vY[i] * dt;
        pos[j + 2] += vZ[i] * dt;
        if (pos[j + 1] <= gY[i]) {
          removeDrop(i);
          continue;
        }
        i++;
      }
      dropGeo.setDrawRange(0, nDrops);
    drops.visible = nDrops > 0;
      posAttr.needsUpdate = true;
    }
  }

  function clear() {
    nDecals = 0;
    nDrops = 0;
    decals.count = 0;
    decals.visible = false;
    dropGeo.setDrawRange(0, 0);
    drops.visible = false;
  }

  function stats() {
    return { decals: nDecals, drops: nDrops, drawCalls: (nDecals ? 1 : 0) + (nDrops ? 1 : 0), atlas: atlasSource };
  }

  function dispose() {
    disposed = true;
    if (unsub) unsub();
    clear();
    decals.removeFromParent();
    drops.removeFromParent();
    plane.dispose();
    dropGeo.dispose();
    decalMat.dispose();
    dropMat.dispose();
    atlasTex.dispose();
    dropTex.dispose();
  }

  return { onHit, onKnockdown, update, clear, stats, dispose, decals, drops, maxDecals: MAXD, maxDrops: MAXP };
}
