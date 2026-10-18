// V4 車輛起火與爆炸（罪惡之都）：車損門檻 → 冒煙 → 引擎蓋起火 → 4–6 s 後爆炸 → 燒焦殘骸；爆炸範圍傷害 / 擊飛 / 連鎖 / 物理衝量
// 純邏輯（不 import three）：THREE 由參數注入（省略 = 只跑邏輯，node 無頭測試用），粒子與光源全池化，每幀路徑不配置物件
//
// createExplosions({ THREE, scene, bus, combat, physics, config }) → {
//   explode(x, y, z, { radius, power, source, vehicle? }) → 本次結果（重用物件 { actors, vehicles, killed }）
//   update(dt, simDt = dt, camX?, camZ?)：simDt 推進引信（模擬時間；暫停時呼叫端給 0），dt 推進粒子 / 閃光（渲染時間）；
//     camX / camZ 給了才以 FIRE_VIS_RADIUS 剔除遠處火焰粒子（引信照走）
//   damageVehicle(vehicle, amount, { source }) → 實扣耐久：槍擊 / 爆炸對車的統一入口（config.addDamage + 起火判斷 + 起火中加速引信；
//     耐久已歸零的起火車再受損仍會加速）
//   setSource(vehicle, actor)：記下「這台車若爆炸算誰的」（玩家駕駛撞毀自己的車 → 玩家）；SOURCE_TTL 秒（模擬時間）內未再設定即失效，
//     爆炸時只採用仍有效的來源（很久以前打過一槍、之後被別人弄爆不算玩家）
//   transfer(from, to, restore?)：把 from 的起火狀態（階段 / 引信 / 來源）原樣搬到 to（搶走車流車換成新 Vehicle 時用）；
//     restore(to) 於期間呼叫且其 vehicle:damaged 不觸發起火判斷（整合層把耐久扣成與 from 相同）
//   stateOf(vehicle) → 'ok' | 'smoke' | 'fire' | 'wreck'；fuseOf(vehicle) → 剩餘秒數 | null；isWreck(vehicle)；
//   nearestFire(x, z) → 最近起火車 / 冒煙殘骸的水平距離（m；無 = Infinity，燃燒聲用）
//   cancel(vehicle)：熄滅該車的火（不爆炸；殘骸不受影響）；forget(vehicle)：丟掉該車狀態（回收時）
//   殘骸以 vehicle.burnt 為準：clear / forget 丟掉狀態後，場上的燒焦殘骸再受損也不會重新起火 / 爆炸
//   clear()：回主選單 / 新局——熄滅所有火、終止爆炸與閃光、清空粒子與殘骸冒煙（殘骸車本身照一般回收）
//   stats() → { explosions, maxExplosions, lights, maxLights, particles: { fire, smoke }, caps: { fire, smoke }, burning, wrecks }
//   dispose() }
//
// 車輛狀態（依 1 − health / maxHealth 的損壞比，耐久來自 config.healthOf / maxHealthOf，與 vehicle-damage.js 同一份）：
//   ≥ SMOKE_AT（70%）'smoke'（冒煙沿用 vehicle-damage 的煙）、≥ FIRE_AT（85%）'fire'：引擎蓋火焰 + 黑煙、引信 FUSE_MIN–FUSE_MAX 秒；
//   起火中每再受 1 點傷害引信縮短 FUSE_ACCEL 秒（點燃那一擊超出門檻的部分也算，但不低於 FUSE_FLOOR，連鎖爆炸有先後）；
//   修好（耐久回到門檻下，例：噴漆廠 repair）→ 自動熄火
//   爆炸：'wreck'——config.addDamage 扣到 0（熄火）、vehicle.burnt = true（VehicleManager.findNearby 不給上車）、
//     材質複製後變黑（不動共用材質）、config.onWreck(vehicle) 給整合層（車流車轉殘骸剛體等），殘骸冒黑煙 WRECK_SMOKE_SEC 秒
// 爆炸範圍（explode）：
//   角色（config.actors() 或 combat.entries 全部）：距離 d ≤ radius → combat.applyHit(weapon 'explosion'，必倒地、自帶擊飛衝量)；
//     傷害 = power × (1 − d / radius)，核心（d ≤ radius × CORE_FRAC）必死——倒地 / 起身中（applyHit 不受理）改走 combat.damageDown；
//     玩家在車內走 throughVehicle（車體擋掉 IN_VEHICLE_SHIELD）
//   車輛（config.vehicles()）：damageVehicle(power × VEHICLE_BLAST_MULT × 衰減) → 可連鎖起火 / 爆炸
//   物理：physics.radialImpulse(x, y, z, radius, power)（整合層以 Rapier 查詢實作；省略則略過）
// 事件（bus）：vehicle:fire { vehicle, x, y, z, fuse }、vehicle:explode { vehicle, x, y, z, source, byPlayer }、
//   explosion { x, y, z, radius, power, source, byPlayer, vehicle }、explosion:shake { x, y, z, radius, power }
//   （鏡頭震動強度由整合層以 shakeTrauma(距離, radius, power) 換算）
// config：{ healthOf(v), maxHealthOf?(v), addDamage(v, n) → 實扣, vehicles?() → iterable, actors?() → iterable, onWreck?(v),
//   quality?() → 'low'|…（low 粒子減半）, pointScale?() → 像素比例（畫面高 / (2·tan(fov/2))）, rng?() → 0..1 }
// 視覺：兩個 Points 圖層（火 = 加色、煙 / 碎片 = 一般混合），各一個 draw call；粒子池以「前段連續」維護（移除 = 與最後一個交換）；
//   閃光 PointLight ≤ MAX_LIGHTS 盞，建立後常駐場景（intensity 0 代表關閉；不切 visible，避免燈數變動觸發 shader 重編）

export const SMOKE_AT = 0.7; // 損壞比 ≥ 此值冒煙
export const FIRE_AT = 0.85; // 損壞比 ≥ 此值起火
export const FUSE_MIN = 4; // 起火 → 爆炸（秒）
export const FUSE_MAX = 6;
export const FUSE_ACCEL = 0.02; // 起火中每 1 點傷害縮短引信秒數（手槍 34 → 0.68 s）
export const FUSE_FLOOR = 0.35; // 點燃當下引信下限（秒）
export const DEFAULT_MAX_HEALTH = 1000;
export const BLAST_RADIUS = 9; // m
export const BLAST_POWER = 140; // 角色傷害基準（滿血 100：約 2.6 m 內致命）
export const CORE_FRAC = 0.3; // 核心半徑比例：必死
export const VEHICLE_BLAST_MULT = 10; // 車輛傷害 = power × 此值 × 衰減（約 3.5 m 內 ≥ 850 → 起火，連鎖）
export const IN_VEHICLE_SHIELD = 0.5; // 車內角色（非核心）受傷倍率
export const ACTOR_IMPULSE = 420; // 擊飛水平衝量（N·s，衰減前）
export const ACTOR_LIFT = 0.55; // 擊飛上抬比例
export const MAX_EXPLOSIONS = 6; // 同時爆炸紀錄上限（超過時回收最舊的）
export const EXPLOSION_LIFE = 1.2; // 一次爆炸的火球 / 餘燼噴發期（秒）
export const MAX_LIGHTS = 2;
export const FLASH_SEC = 0.45;
export const FLASH_INTENSITY = 60;
export const FLASH_DISTANCE = 34;
export const WRECK_SMOKE_SEC = 14; // 殘骸冒黑煙秒數
export const FIRE_VIS_RADIUS = 160; // m：超過此距離的燃燒車不產生粒子
export const SHAKE_RANGE = 5; // 鏡頭震動作用距離 = radius × 此值
export const SOURCE_TTL = 10; // 犯行來源有效秒數（模擬時間；> FUSE_MAX，點燃後到爆炸前一直有效）
export const PARTICLE_CAPS = { fire: 320, smoke: 256 }; // 高畫質池大小；low 減半
// 一次爆炸各類粒子數（low 減半）
export const BURST = { fireball: 16, sparks: 12, smoke: 14, debris: 14 };
// 燃燒車每秒粒子數
export const BURN_RATE = { flame: 22, smoke: 7, wreckSmoke: 5 };

const STAGE_NAMES = ['ok', 'smoke', 'fire', 'wreck'];
const CHAR_COLOR = 0x141210;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// 距離衰減 0–1（線性）
export function blastFalloff(d, radius) {
  if (!(radius > 0)) return 0;
  return clamp(1 - d / radius, 0, 1);
}

// 角色受到的爆炸傷害；核心必死（≥ maxHp × 2）
export function actorBlastDamage(d, radius, power, maxHp = 100) {
  const k = blastFalloff(d, radius);
  if (k <= 0) return 0;
  if (d <= radius * CORE_FRAC) return Math.max(power, maxHp * 2);
  return power * k;
}

// 車輛受到的爆炸傷害
export function vehicleBlastDamage(d, radius, power) {
  return power * VEHICLE_BLAST_MULT * blastFalloff(d, radius);
}

// 鏡頭震動 trauma（0–1）：距離 radius × SHAKE_RANGE 內，平方衰減，依 power 縮放
export function shakeTrauma(dist, radius = BLAST_RADIUS, power = BLAST_POWER) {
  const k = clamp(1 - dist / (Math.max(1, radius) * SHAKE_RANGE), 0, 1);
  return Math.min(1, k * k * (power / BLAST_POWER));
}

// 損壞比 → 階段 0 ok / 1 smoke / 2 fire
export function fireStage(ratio) {
  if (ratio >= FIRE_AT) return 2;
  if (ratio >= SMOKE_AT) return 1;
  return 0;
}

// 固定種子 LCG（可重現）
function lcg(seed = 4242) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// 燒焦：複製網格材質（不動共用 / 快取材質）後壓黑；回傳複製出的材質陣列（dispose 用）
export function charMesh(root) {
  const out = [];
  if (!root || typeof root.traverse !== 'function') return out;
  const darken = (m) => {
    if (!m || typeof m.clone !== 'function') return m;
    const c = m.clone();
    if (c.color && c.color.setHex) c.color.setHex(CHAR_COLOR);
    if (c.emissive && c.emissive.setHex) c.emissive.setHex(0);
    if ('emissiveIntensity' in c) c.emissiveIntensity = 0;
    if ('roughness' in c) c.roughness = 1;
    if ('metalness' in c) c.metalness = 0.15;
    out.push(c);
    return c;
  };
  root.traverse((o) => {
    if (!o || !o.isMesh || !o.material) return;
    o.material = Array.isArray(o.material) ? o.material.map(darken) : darken(o.material);
  });
  return out;
}

const VERT = `
attribute float aSize;
attribute vec4 aColor;
uniform float uScale;
varying vec4 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale / max(0.1, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = `
varying vec4 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  float a = 1.0 - smoothstep(0.35, 1.0, d);
  if (a <= 0.0) discard;
  gl_FragColor = vec4(vColor.rgb, vColor.a * a);
}`;

// 粒子圖層：結構陣列 + 前段連續；THREE 有給才建 Points（1 draw call）
function makeLayer(THREE, scene, cap, additive) {
  const P = new Float32Array(cap * 3);
  const V = new Float32Array(cap * 3);
  const age = new Float32Array(cap);
  const life = new Float32Array(cap);
  const s0 = new Float32Array(cap);
  const s1 = new Float32Array(cap);
  const grav = new Float32Array(cap);
  const drag = new Float32Array(cap);
  const C0 = new Float32Array(cap * 3);
  const C1 = new Float32Array(cap * 3);
  const A = new Float32Array(cap);
  let count = 0;
  let points = null;
  let geo = null;
  let mat = null;
  let posArr = null;
  let colArr = null;
  let sizeArr = null;
  if (THREE && THREE.BufferGeometry && THREE.ShaderMaterial && THREE.Points) {
    geo = new THREE.BufferGeometry();
    posArr = new Float32Array(cap * 3);
    colArr = new Float32Array(cap * 4);
    sizeArr = new Float32Array(cap);
    geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(colArr, 4));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizeArr, 1));
    geo.setDrawRange(0, 0);
    mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 700 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = additive ? 7 : 6;
    if (scene) scene.add(points);
  }

  function copy(dst, src) {
    P[dst * 3] = P[src * 3];
    P[dst * 3 + 1] = P[src * 3 + 1];
    P[dst * 3 + 2] = P[src * 3 + 2];
    V[dst * 3] = V[src * 3];
    V[dst * 3 + 1] = V[src * 3 + 1];
    V[dst * 3 + 2] = V[src * 3 + 2];
    C0[dst * 3] = C0[src * 3];
    C0[dst * 3 + 1] = C0[src * 3 + 1];
    C0[dst * 3 + 2] = C0[src * 3 + 2];
    C1[dst * 3] = C1[src * 3];
    C1[dst * 3 + 1] = C1[src * 3 + 1];
    C1[dst * 3 + 2] = C1[src * 3 + 2];
    age[dst] = age[src];
    life[dst] = life[src];
    s0[dst] = s0[src];
    s1[dst] = s1[src];
    grav[dst] = grav[src];
    drag[dst] = drag[src];
    A[dst] = A[src];
  }

  return {
    cap,
    get count() {
      return count;
    },
    // 池滿 → false（新的丟棄，不搶舊粒子）；c0 / c1 = 0xRRGGBB 起訖色
    spawn(x, y, z, vx, vy, vz, lf, sz0, sz1, c0, c1, alpha, g, dr) {
      if (count >= cap) return false;
      const i = count++;
      P[i * 3] = x;
      P[i * 3 + 1] = y;
      P[i * 3 + 2] = z;
      V[i * 3] = vx;
      V[i * 3 + 1] = vy;
      V[i * 3 + 2] = vz;
      age[i] = 0;
      life[i] = lf;
      s0[i] = sz0;
      s1[i] = sz1;
      C0[i * 3] = ((c0 >> 16) & 255) / 255;
      C0[i * 3 + 1] = ((c0 >> 8) & 255) / 255;
      C0[i * 3 + 2] = (c0 & 255) / 255;
      C1[i * 3] = ((c1 >> 16) & 255) / 255;
      C1[i * 3 + 1] = ((c1 >> 8) & 255) / 255;
      C1[i * 3 + 2] = (c1 & 255) / 255;
      A[i] = alpha;
      grav[i] = g;
      drag[i] = dr;
      return true;
    },
    step(dt, scale) {
      let i = 0;
      while (i < count) {
        age[i] += dt;
        if (age[i] >= life[i]) {
          count--;
          if (i !== count) copy(i, count);
          continue;
        }
        const k = Math.max(0, 1 - drag[i] * dt);
        V[i * 3] *= k;
        V[i * 3 + 1] = V[i * 3 + 1] * k - grav[i] * dt;
        V[i * 3 + 2] *= k;
        P[i * 3] += V[i * 3] * dt;
        P[i * 3 + 1] += V[i * 3 + 1] * dt;
        P[i * 3 + 2] += V[i * 3 + 2] * dt;
        if (posArr) {
          const t = age[i] / life[i];
          posArr[i * 3] = P[i * 3];
          posArr[i * 3 + 1] = P[i * 3 + 1];
          posArr[i * 3 + 2] = P[i * 3 + 2];
          colArr[i * 4] = C0[i * 3] + (C1[i * 3] - C0[i * 3]) * t;
          colArr[i * 4 + 1] = C0[i * 3 + 1] + (C1[i * 3 + 1] - C0[i * 3 + 1]) * t;
          colArr[i * 4 + 2] = C0[i * 3 + 2] + (C1[i * 3 + 2] - C0[i * 3 + 2]) * t;
          colArr[i * 4 + 3] = A[i] * (1 - t) * Math.min(1, t * 10);
          sizeArr[i] = s0[i] + (s1[i] - s0[i]) * t;
        }
        i++;
      }
      if (geo) {
        geo.attributes.position.needsUpdate = true;
        geo.attributes.aColor.needsUpdate = true;
        geo.attributes.aSize.needsUpdate = true;
        geo.setDrawRange(0, count);
        mat.uniforms.uScale.value = scale;
      }
    },
    clear() {
      count = 0;
      if (geo) geo.setDrawRange(0, 0);
    },
    dispose() {
      count = 0;
      if (points && scene) scene.remove(points);
      if (geo) geo.dispose();
      if (mat) mat.dispose();
    },
  };
}

export function createExplosions({ THREE = null, scene = null, bus = null, combat = null, physics = null, config = {} } = {}) {
  const cfg = config || {};
  const rng = cfg.rng || lcg();
  const emit = (name, payload) => {
    if (bus && bus.emit) bus.emit(name, payload);
  };
  const low = () => {
    try {
      return typeof cfg.quality === 'function' && cfg.quality() === 'low';
    } catch (err) {
      return false;
    }
  };
  const isLow = low();
  const capScale = isLow ? 0.5 : 1;
  const fire = makeLayer(THREE, scene, Math.round(PARTICLE_CAPS.fire * capScale), true);
  const smoke = makeLayer(THREE, scene, Math.round(PARTICLE_CAPS.smoke * capScale), false);

  // ---------- 閃光（≤ MAX_LIGHTS，常駐、intensity 0 = 關）----------
  const lights = [];
  for (let i = 0; i < MAX_LIGHTS; i++) {
    let light = null;
    if (THREE && THREE.PointLight) {
      light = new THREE.PointLight(0xffa040, 0, FLASH_DISTANCE, 2);
      if (scene) scene.add(light);
    }
    lights.push({ light, t: 0, dur: FLASH_SEC, peak: 0, intensity: 0 });
  }
  function flash(x, y, z, power) {
    let best = lights[0];
    for (const l of lights) if (l.t < best.t) best = l; // 空閒（t = 0）或剩餘最短者
    best.t = best.dur = FLASH_SEC;
    best.peak = FLASH_INTENSITY * clamp(power / BLAST_POWER, 0.4, 2);
    best.intensity = best.peak;
    if (best.light) {
      best.light.position.set(x, y + 1.2, z);
      best.light.intensity = best.peak;
    }
  }
  function stepLights(dt) {
    for (const l of lights) {
      if (l.t <= 0) continue;
      l.t = Math.max(0, l.t - dt);
      const k = l.t / l.dur;
      l.intensity = l.t > 0 ? l.peak * k * k : 0;
      if (l.light) l.light.intensity = l.intensity;
    }
  }

  // ---------- 爆炸紀錄（≤ MAX_EXPLOSIONS）----------
  const records = [];
  for (let i = 0; i < MAX_EXPLOSIONS; i++) records.push({ active: false, x: 0, y: 0, z: 0, age: 0, radius: 0, power: 0, emberAcc: 0 });
  let activeRecords = 0;
  function takeRecord() {
    let oldest = records[0];
    for (const r of records) {
      if (!r.active) return r;
      if (r.age > oldest.age) oldest = r;
    }
    activeRecords--; // 回收最舊的（稍後重新啟用）
    oldest.active = false;
    return oldest;
  }

  const burst = (n) => Math.max(1, Math.round(n * capScale));
  function spawnBurst(x, y, z, radius) {
    const r = Math.max(2, radius) / BLAST_RADIUS;
    for (let i = 0, n = burst(BURST.fireball); i < n; i++) {
      const a = rng() * Math.PI * 2;
      const up = rng();
      const sp = (2 + rng() * 5) * r;
      fire.spawn(x, y + 0.3, z, Math.cos(a) * sp, 1.5 + up * 4 * r, Math.sin(a) * sp, 0.45 + rng() * 0.45, (1.6 + rng()) * r, (4.5 + rng() * 2.5) * r, 0xfff2b0, 0xc8380a, 1, -1.5, 3.2);
    }
    for (let i = 0, n = burst(BURST.sparks); i < n; i++) {
      const a = rng() * Math.PI * 2;
      const sp = 8 + rng() * 10;
      fire.spawn(x, y + 0.5, z, Math.cos(a) * sp, 4 + rng() * 9, Math.sin(a) * sp, 0.6 + rng() * 0.6, 0.25, 0.08, 0xffe080, 0xff5010, 1, 9.8, 0.4);
    }
    for (let i = 0, n = burst(BURST.smoke); i < n; i++) {
      const a = rng() * Math.PI * 2;
      const sp = (1 + rng() * 2.5) * r;
      smoke.spawn(x + Math.cos(a) * 0.8, y + 0.8 + rng(), z + Math.sin(a) * 0.8, Math.cos(a) * sp, 1.8 + rng() * 2, Math.sin(a) * sp, 2.2 + rng() * 1.4, 2 * r, (6 + rng() * 3) * r, 0x2a2622, 0x4a4743, 0.75, -0.3, 0.9);
    }
    for (let i = 0, n = burst(BURST.debris); i < n; i++) {
      const a = rng() * Math.PI * 2;
      const sp = 4 + rng() * 9;
      smoke.spawn(x, y + 0.6, z, Math.cos(a) * sp, 5 + rng() * 9, Math.sin(a) * sp, 1 + rng() * 0.8, 0.22 + rng() * 0.18, 0.18, 0x111111, 0x1a1a1a, 1, 14, 0.2);
    }
  }

  // ---------- 角色 / 車輛範圍效果 ----------
  const result = { actors: 0, vehicles: 0, killed: 0 };
  const hitDir = { x: 0, z: 0 };
  function hitActors(x, y, z, radius, power, source) {
    if (!combat || typeof combat.applyHit !== 'function') return;
    const list = typeof cfg.actors === 'function' ? cfg.actors() : combat.entries ? combat.entries.values() : null;
    if (!list) return;
    const swingId = source && combat.newSwingId ? combat.newSwingId() : null;
    for (const item of list) {
      const a = item && item.actor && item.actor.pos && !item.pos ? item.actor : item;
      if (!a || !a.pos) continue;
      const dx = a.pos.x - x;
      const dz = a.pos.z - z;
      const dy = a.pos.y + 1 - y;
      const d = Math.hypot(dx, dy, dz);
      if (d > radius) continue;
      const core = d <= radius * CORE_FRAC;
      let dmg = actorBlastDamage(d, radius, power, a.maxHp || 100);
      if (a.untargetable && !core) dmg *= IN_VEHICLE_SHIELD;
      const hd = Math.hypot(dx, dz);
      if (hd > 1e-3) {
        hitDir.x = dx / hd;
        hitDir.z = dz / hd;
      } else {
        const ang = rng() * Math.PI * 2;
        hitDir.x = Math.cos(ang);
        hitDir.z = Math.sin(ang);
      }
      const k = blastFalloff(d, radius);
      const J = ACTOR_IMPULSE * (0.35 + 0.65 * k);
      const attacker = source && source !== a ? source : null;
      const impulse = { x: hitDir.x * J, y: J * ACTOR_LIFT, z: hitDir.z * J };
      let r = combat.applyHit({
        attacker,
        target: a,
        damage: dmg,
        weapon: 'explosion',
        dir: hitDir,
        impulse,
        swingId: attacker ? swingId : null,
        throughVehicle: true,
      });
      // 核心必死：倒地 / 起身中的角色 applyHit 不受理（連鎖爆炸被第一爆炸倒的人）→ 直接扣血
      if (!r && core && typeof combat.damageDown === 'function') r = combat.damageDown(a, dmg, { weapon: 'explosion', attacker, impulse });
      if (!r) continue;
      result.actors++;
      if (a.hp <= 0) result.killed++;
    }
  }

  function hitVehicles(x, y, z, radius, power, source, self) {
    if (typeof cfg.vehicles !== 'function') return;
    const list = cfg.vehicles();
    if (!list) return;
    for (const v of list) {
      if (!v || v === self || !v.pos || v.burnt) continue;
      const e = entries.get(v);
      if (e && e.stage === 3) continue;
      const d = Math.hypot(v.pos.x - x, (v.pos.y || 0) + 0.7 - y, v.pos.z - z);
      const amount = vehicleBlastDamage(d, radius, power);
      if (amount <= 0) continue;
      damageVehicle(v, amount, { source });
      result.vehicles++;
    }
  }

  function explode(x, y, z, { radius = BLAST_RADIUS, power = BLAST_POWER, source = null, vehicle = null } = {}) {
    result.actors = 0;
    result.vehicles = 0;
    result.killed = 0;
    if (disposed || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return result;
    const rec = takeRecord();
    rec.active = true;
    activeRecords++;
    rec.x = x;
    rec.y = y;
    rec.z = z;
    rec.age = 0;
    rec.radius = radius;
    rec.power = power;
    rec.emberAcc = 0;
    spawnBurst(x, y, z, radius);
    flash(x, y, z, power);
    const byPlayer = !!source && source.kind === 'player';
    emit('explosion', { x, y, z, radius, power, source, byPlayer, vehicle });
    emit('explosion:shake', { x, y, z, radius, power });
    hitActors(x, y, z, radius, power, source);
    hitVehicles(x, y, z, radius, power, source, vehicle);
    if (physics && typeof physics.radialImpulse === 'function') {
      try {
        physics.radialImpulse(x, y, z, radius, power);
      } catch (err) {
        // 物理查詢失敗不影響爆炸本身
      }
    }
    return result;
  }

  // ---------- 車輛起火狀態 ----------
  const entries = new Map(); // vehicle → entry
  const list = []; // 與 entries 同步（每幀走陣列，不建迭代器）
  const charred = []; // { v, mats }：燒焦材質（車輛網格移出場景後 dispose）
  let charScanT = 0;
  const pending = []; // 本幀引信到點的車（迴圈後才爆，避免迭代中改動 list）

  const maxHealthOf = (v) => {
    const m = typeof cfg.maxHealthOf === 'function' ? cfg.maxHealthOf(v) : null;
    return Number.isFinite(m) && m > 0 ? m : DEFAULT_MAX_HEALTH;
  };
  const healthOf = (v) => {
    const h = typeof cfg.healthOf === 'function' ? cfg.healthOf(v) : null;
    return Number.isFinite(h) ? h : null;
  };
  const ratioOf = (v) => {
    const h = healthOf(v);
    if (h === null) return 0;
    return 1 - h / maxHealthOf(v);
  };

  function entryOf(v, create) {
    let e = entries.get(v);
    if (!e && create) {
      e = { v, stage: 0, fuse: 0, source: null, sourceAt: -Infinity, flameAcc: 0, smokeAcc: 0, wreckT: 0 };
      entries.set(v, e);
      list.push(e);
    }
    return e || null;
  }
  function dropEntry(e) {
    entries.delete(e.v);
    const i = list.indexOf(e);
    if (i >= 0) {
      list[i] = list[list.length - 1];
      list.pop();
    }
  }

  function hood(v, out) {
    const spec = v.spec || {};
    const yaw = v.yaw || 0;
    const ahead = (spec.length ?? 4.5) * 0.4;
    out.x = v.pos.x + Math.sin(yaw) * ahead;
    out.y = (v.pos.y || 0) + (spec.height ?? 1.45) * 0.8;
    out.z = v.pos.z + Math.cos(yaw) * ahead;
    return out;
  }
  const hp = { x: 0, y: 0, z: 0 };

  function ignite(e, overflow) {
    e.stage = 2;
    e.fuse = Math.max(FUSE_FLOOR, FUSE_MIN + rng() * (FUSE_MAX - FUSE_MIN) - Math.max(0, overflow) * FUSE_ACCEL);
    e.flameAcc = 0;
    e.smokeAcc = 0;
    const v = e.v;
    hood(v, hp);
    emit('vehicle:fire', { vehicle: v, x: hp.x, y: hp.y, z: hp.z, fuse: e.fuse });
  }

  // 受損後的狀態判斷；requested = 這次要求的傷害（耐久已歸零時實扣為 0，但仍用來加速引信）
  function onDamage(v, delta, requested) {
    if (disposed || !v || v.burnt) return; // 燒焦殘骸（含 clear / forget 後已無狀態者）不再起火
    const ratio = ratioOf(v);
    let e = entries.get(v);
    if (e && e.stage === 3) return;
    if (e && e.stage === 2) {
      e.fuse = Math.max(0, e.fuse - Math.max(0, requested) * FUSE_ACCEL);
      return;
    }
    const st = fireStage(ratio);
    if (st === 0) return;
    e = entryOf(v, true);
    if (st === 2) {
      // 超出起火門檻的部分（含已歸零後多打的量）也縮短引信
      const maxH = maxHealthOf(v);
      const after = healthOf(v) ?? 0;
      const before = after + Math.max(0, delta);
      const toFire = Math.max(0, before - maxH * (1 - FIRE_AT));
      ignite(e, Math.max(0, requested) - toFire);
    } else {
      e.stage = 1;
    }
  }

  let busyVehicle = null; // damageVehicle 同步呼叫 addDamage 期間：vehicle:damaged 由 damageVehicle 自己處理
  function damageVehicle(v, amount, { source = null } = {}) {
    if (disposed || !v || !(amount > 0)) return 0;
    if (source) setSource(v, source);
    busyVehicle = v;
    let delta = 0;
    try {
      delta = typeof cfg.addDamage === 'function' ? cfg.addDamage(v, amount) || 0 : 0;
    } finally {
      busyVehicle = null;
    }
    onDamage(v, delta, amount);
    return delta;
  }

  function setSource(v, actor) {
    if (!v || !actor || v.burnt) return;
    const e = entryOf(v, true);
    if (e.stage === 3) return;
    e.source = actor;
    e.sourceAt = simClock;
  }
  // 仍有效的來源（SOURCE_TTL 內設定過）；過期 → null
  const liveSource = (e) => (e.source && simClock - e.sourceAt <= SOURCE_TTL ? e.source : null);

  function wreck(e) {
    const v = e.v;
    e.stage = 3;
    e.wreckT = WRECK_SMOKE_SEC;
    e.smokeAcc = 0;
    v.burnt = true;
    if (typeof cfg.addDamage === 'function') {
      busyVehicle = v;
      try {
        cfg.addDamage(v, 1e9);
      } finally {
        busyVehicle = null;
      }
    }
    if (typeof v.setPowerScale === 'function') v.setPowerScale(0);
    const mats = charMesh(v.mesh);
    if (mats.length) charred.push({ v, mesh: v.mesh, mats });
    if (typeof cfg.onWreck === 'function') cfg.onWreck(v);
    const x = v.pos.x;
    const y = (v.pos.y || 0) + 0.7;
    const z = v.pos.z;
    const source = liveSource(e);
    e.source = source;
    emit('vehicle:explode', { vehicle: v, x, y, z, source, byPlayer: !!source && source.kind === 'player' });
    const big = v.spec && v.spec.mass > 5000 ? 1.35 : v.spec && v.spec.twoWheeler ? 0.7 : 1;
    explode(x, y, z, { radius: BLAST_RADIUS * big, power: BLAST_POWER * big, source, vehicle: v });
  }

  // 車輛網格已移出場景（被回收）→ 丟掉狀態
  const gone = (v) => !!(v.mesh && v.mesh.parent === null);

  function emitBurning(e, dt, camX, camZ, cull) {
    const v = e.v;
    if (!v.pos) return;
    if (cull) {
      const dx = v.pos.x - camX;
      const dz = v.pos.z - camZ;
      if (dx * dx + dz * dz > FIRE_VIS_RADIUS * FIRE_VIS_RADIUS) {
        e.flameAcc = 0;
        e.smokeAcc = 0;
        return;
      }
    }
    hood(v, hp);
    const lowK = isLow ? 0.5 : 1;
    if (e.stage === 2) {
      e.flameAcc += BURN_RATE.flame * lowK * dt;
      while (e.flameAcc >= 1) {
        e.flameAcc -= 1;
        if (!fire.spawn(hp.x + (rng() - 0.5) * 0.9, hp.y, hp.z + (rng() - 0.5) * 0.9, (rng() - 0.5) * 0.6, 2 + rng() * 1.5, (rng() - 0.5) * 0.6, 0.35 + rng() * 0.25, 0.7 + rng() * 0.4, 0.2, 0xffd060, 0xd02808, 0.95, -1, 1.5)) {
          e.flameAcc = 0;
          break;
        }
      }
    }
    e.smokeAcc += (e.stage === 2 ? BURN_RATE.smoke : BURN_RATE.wreckSmoke) * lowK * dt;
    while (e.smokeAcc >= 1) {
      e.smokeAcc -= 1;
      if (!smoke.spawn(hp.x + (rng() - 0.5) * 0.5, hp.y + 0.5, hp.z + (rng() - 0.5) * 0.5, (rng() - 0.5) * 0.5, 1.6 + rng() * 0.8, (rng() - 0.5) * 0.5, 2.2 + rng() * 0.8, 0.8, 3.4, 0x1c1a18, 0x3c3a38, 0.7, -0.1, 0.25)) {
        e.smokeAcc = 0;
        break;
      }
    }
  }

  let disposed = false;
  let pointScale = 700;
  let simClock = 0; // 模擬時間（秒）：犯行來源時效用
  function update(dt, simDt = dt, camX, camZ) {
    if (disposed) return;
    const rd = dt > 0 ? dt : 0;
    const sd = simDt > 0 ? simDt : 0;
    const cull = Number.isFinite(camX) && Number.isFinite(camZ);
    simClock += sd;
    pending.length = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const v = e.v;
      if (gone(v)) {
        dropEntry(e);
        i--;
        continue;
      }
      if (e.stage === 2) {
        // 修好（耐久回到門檻下）→ 熄火
        if (ratioOf(v) < FIRE_AT) {
          e.stage = fireStage(ratioOf(v));
          continue;
        }
        e.fuse -= sd;
        if (e.fuse <= 0) {
          pending.push(e);
          continue;
        }
        emitBurning(e, rd, camX, camZ, cull);
      } else if (e.stage === 3) {
        if (e.wreckT > 0) {
          e.wreckT -= rd;
          emitBurning(e, rd, camX, camZ, cull);
        }
      } else if (e.stage <= 1 && ratioOf(v) < SMOKE_AT && !liveSource(e)) {
        // 沒在冒煙 / 起火、來源也過期（setSource 建立或修好降回的）→ 回收
        dropEntry(e);
        i--;
      }
    }
    for (let i = 0; i < pending.length; i++) if (pending[i].stage === 2) wreck(pending[i]);
    pending.length = 0;
    // 爆炸紀錄：噴發期內持續冒餘燼
    for (const r of records) {
      if (!r.active) continue;
      r.age += rd;
      if (r.age >= EXPLOSION_LIFE) {
        r.active = false;
        activeRecords--;
        continue;
      }
      r.emberAcc += 14 * (isLow ? 0.5 : 1) * rd;
      while (r.emberAcc >= 1) {
        r.emberAcc -= 1;
        const a = rng() * Math.PI * 2;
        fire.spawn(r.x + Math.cos(a) * 0.6, r.y + 0.4, r.z + Math.sin(a) * 0.6, Math.cos(a), 2.5 + rng() * 2, Math.sin(a), 0.4 + rng() * 0.3, 1.2, 0.3, 0xffb040, 0x901800, 0.8, -1, 1.2);
      }
    }
    stepLights(rd);
    if (typeof cfg.pointScale === 'function') {
      const s = cfg.pointScale();
      if (Number.isFinite(s) && s > 0) pointScale = s;
    }
    fire.step(rd, pointScale);
    smoke.step(rd, pointScale);
    // 燒焦材質：每 2 秒掃一次，車輛網格已移出場景（回收）者 dispose
    charScanT += rd;
    if (charScanT >= 2) {
      charScanT = 0;
      for (let i = charred.length - 1; i >= 0; i--) {
        const c = charred[i];
        if (c.mesh && c.mesh.parent !== null) continue;
        for (const m of c.mats) if (m.dispose) m.dispose();
        charred[i] = charred[charred.length - 1];
        charred.pop();
      }
    }
  }

  const offDamaged = bus && bus.on ? bus.on('vehicle:damaged', (e) => {
    if (!e || !e.vehicle || e.vehicle === busyVehicle) return;
    onDamage(e.vehicle, e.delta || 0, e.delta || 0);
  }) : null;

  function clear() {
    list.length = 0;
    entries.clear();
    pending.length = 0;
    for (const r of records) r.active = false;
    activeRecords = 0;
    for (const l of lights) {
      l.t = 0;
      l.intensity = 0;
      if (l.light) l.light.intensity = 0;
    }
    fire.clear();
    smoke.clear();
  }

  return {
    explode,
    update,
    damageVehicle,
    setSource,
    // 沒有狀態紀錄的車（例：clear 之後）只依損壞比回 'ok' / 'smoke'——起火一定要經過受損事件
    stateOf(v) {
      const e = entries.get(v);
      if (e) return STAGE_NAMES[e.stage];
      if (v && v.burnt) return 'wreck';
      return fireStage(ratioOf(v)) > 0 ? 'smoke' : 'ok';
    },
    // 最近的起火車 / 冒煙殘骸（水平距離 m；沒有 → Infinity）：燃燒聲用
    nearestFire(x, z) {
      let best = Infinity;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!(e.stage === 2 || (e.stage === 3 && e.wreckT > 0)) || !e.v.pos) continue;
        const d = Math.hypot(e.v.pos.x - x, e.v.pos.z - z);
        if (d < best) best = d;
      }
      return best;
    },
    fuseOf(v) {
      const e = entries.get(v);
      return e && e.stage === 2 ? e.fuse : null;
    },
    isWreck(v) {
      return !!v && (!!v.burnt || (entries.get(v) || {}).stage === 3);
    },
    cancel(v) {
      const e = entries.get(v);
      if (!e || e.stage !== 2) return false;
      e.stage = 1;
      e.fuse = 0;
      return true;
    },
    forget(v) {
      const e = entries.get(v);
      if (e) dropEntry(e);
    },
    // 起火狀態轉手（搶車換成新 Vehicle）：to 原有的狀態以 from 的覆蓋；restore?(to) 在「不觸發起火判斷」下執行
    //   （整合層用來把耐久扣到與 from 相同，不會重新點燃 / 重抽引信 / 加速）；回傳是否搬了狀態
    transfer(from, to, restore = null) {
      if (!from || !to || from === to || disposed) return false;
      if (typeof restore === 'function') {
        busyVehicle = to;
        try {
          restore(to);
        } finally {
          busyVehicle = null;
        }
      }
      const e = entries.get(from);
      const old = entries.get(to);
      if (old && old !== e) dropEntry(old);
      if (from.burnt) to.burnt = true;
      if (!e) return false;
      entries.delete(from);
      e.v = to;
      entries.set(to, e);
      return true;
    },
    clear,
    stats() {
      let burning = 0;
      let wrecks = 0;
      for (const e of list) {
        if (e.stage === 2) burning++;
        else if (e.stage === 3) wrecks++;
      }
      let lit = 0;
      for (const l of lights) if (l.t > 0) lit++;
      return {
        explosions: activeRecords,
        maxExplosions: MAX_EXPLOSIONS,
        lights: lit,
        maxLights: MAX_LIGHTS,
        particles: { fire: fire.count, smoke: smoke.count },
        caps: { fire: fire.cap, smoke: smoke.cap },
        burning,
        wrecks,
      };
    },
    dispose() {
      if (disposed) return;
      clear();
      disposed = true;
      if (offDamaged) offDamaged();
      fire.dispose();
      smoke.dispose();
      for (const l of lights) if (l.light && scene) scene.remove(l.light);
      for (const c of charred) for (const m of c.mats) if (m.dispose) m.dispose();
      charred.length = 0;
    },
  };
}
