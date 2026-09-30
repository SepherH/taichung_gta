// 車輛耐久與冒煙（C3）：碰撞扣耐久 → 門檻冒白煙 / 黑灰煙降功率 / 歸零熄火（不爆炸、不起火）
// 用法：const dmg = createVehicleDamage({ bus, THREE, scene, isNight })；dmg.attach(vehicle) 後由整合把 contacts router 的撞擊餵給 onImpact，
//   每幀 dmg.update(dt, camX, camZ) 推進去重時鐘與煙霧粒子
// 傷害：relSpeed < 4 m/s 不扣；以上 = K × (relSpeed − 4)^1.6 × 質量係數 × 對象係數（撞行人 ×0.2）× 機車 ×0.7
//   K 讓 1400 kg 轎車 30 km/h 撞牆約 61、60 km/h 約 340（目標區間 60–90 / 250–350）
// 事件（注入的 bus）：vehicle:damaged { vehicle, health, delta }、vehicle:crash { vehicle, relSpeed }（玩家駕駛且 ≥ 8 m/s，撞行人不算）、
//   vehicle:disabled { vehicle }
// 煙：全域共用 Sprite 池（≤ MAX_PARTICLES 顆，canvas 柔邊圓貼圖），從引擎蓋（車頭方向 length × 0.4、高 height × 0.8）冒出，
//   只替離相機 SMOKE_RADIUS 內的車產生新粒子；池滿時不再產生（不搶舊粒子）
// 熄火濃煙為深灰（SMOKE_STAGE 3），夜間在深色建築前會看不見：注入 isNight()（回傳 boolean 或 0–1 夜間程度，例 DayNight.night）時，
//   新粒子顏色依夜間程度往 SMOKE_NIGHT_COLOR 提亮；沒注入就用固定深灰

export const DAMAGE_MIN_SPEED = 4; // m/s，低於此不扣
export const DAMAGE_EXP = 1.6;
export const DAMAGE_K = 5.85;
export const DAMAGE_REF_MASS = 1400; // kg，質量係數 = 1 的參考車重（轎車）
export const MASS_FACTOR_RANGE = [0.8, 1.3];
export const KIND_FACTOR = { static: 1, vehicle: 1, ped: 0.2 };
export const TWO_WHEELER_FACTOR = 0.7;
export const DEDUP_SEC = 0.3; // 同一車此時間內的多次撞擊只算最大的一次
export const CRASH_SPEED = 8; // m/s，玩家駕駛達此相對速度才算車禍
export const SMOKE_WHITE_AT = 600; // 耐久 ≤ 此值冒白煙
export const SMOKE_DARK_AT = 300; // 耐久 ≤ 此值黑灰煙 + 降功率
export const DAMAGED_POWER = 0.6;
export const MAX_PARTICLES = 200;
export const SMOKE_RADIUS = 120; // m
export const SMOKE_NIGHT_COLOR = 0x5a5a5a; // 夜間（isNight() = 1）熄火濃煙的顏色；介於之間線性內插

// 各階段煙霧參數：每秒顆數、顏色、起始不透明度、壽命（秒）、上升速度（m/s）、起始 / 結束大小（m）
export const SMOKE_STAGE = {
  1: { rate: 5, color: 0xdedede, opacity: 0.35, life: 1.6, rise: 1.1, size0: 0.35, size1: 1.4 },
  2: { rate: 10, color: 0x55555a, opacity: 0.5, life: 2.2, rise: 1.3, size0: 0.45, size1: 2.0 },
  3: { rate: 16, color: 0x3a3a3a, opacity: 0.65, life: 2.8, rise: 1.5, size0: 0.55, size1: 2.6 },
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// 兩個 0xRRGGBB 逐通道線性內插
function mixHex(a, b, k) {
  let out = 0;
  for (const sh of [16, 8, 0]) {
    const ca = (a >> sh) & 0xff;
    const cb = (b >> sh) & 0xff;
    out |= Math.round(ca + (cb - ca) * k) << sh;
  }
  return out;
}

// 粒子顏色：只有熄火濃煙（stage 3）依夜間程度提亮；night 為 0–1
export function smokeColor(stage, night = 0) {
  const st = SMOKE_STAGE[stage];
  if (!st) return 0xffffff;
  if (stage !== 3) return st.color;
  return mixHex(st.color, SMOKE_NIGHT_COLOR, clamp(Number(night) || 0, 0, 1));
}

// 車重：Vehicle.spec.mass（manifest）→ VehicleBody.spec.mass → 參考車重
function massOf(vehicle) {
  const m = (vehicle.spec && vehicle.spec.mass) ?? (vehicle.body && vehicle.body.spec && vehicle.body.spec.mass);
  return Number.isFinite(m) && m > 0 ? m : DAMAGE_REF_MASS;
}

// 單次撞擊的扣值（不含去重）；機車不套質量係數（車重小但不該更耐撞），改乘固定係數
export function impactDamage(vehicle, relSpeed, kind = 'static') {
  if (!(relSpeed > DAMAGE_MIN_SPEED)) return 0;
  const two = !!(vehicle.spec && vehicle.spec.twoWheeler);
  const massK = two ? TWO_WHEELER_FACTOR : clamp(Math.sqrt(massOf(vehicle) / DAMAGE_REF_MASS), MASS_FACTOR_RANGE[0], MASS_FACTOR_RANGE[1]);
  const kindK = KIND_FACTOR[kind] ?? 1;
  return DAMAGE_K * Math.pow(relSpeed - DAMAGE_MIN_SPEED, DAMAGE_EXP) * massK * kindK;
}

// 耐久 → 煙霧階段：0 無、1 白煙、2 黑灰煙、3 熄火濃黑煙
function stageOf(health) {
  if (health <= 0) return 3;
  if (health <= SMOKE_DARK_AT) return 2;
  if (health <= SMOKE_WHITE_AT) return 1;
  return 0;
}

// 柔邊圓貼圖（徑向漸層）；無 document（node 無頭）時回傳 null，Sprite 以純色方塊顯示
function makeSmokeTexture(THREE) {
  if (typeof document === 'undefined' || !document.createElement) return null;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext && c.getContext('2d');
  if (!g) return null;
  const grad = g.createRadialGradient ? g.createRadialGradient(32, 32, 0, 32, 32, 32) : null;
  if (grad && grad.addColorStop) {
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
  }
  if (g.fillRect) g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export function createVehicleDamage({ bus, THREE, scene, isNight = null } = {}) {
  const entries = new Map(); // vehicle → 狀態
  const emit = (name, payload) => {
    if (bus && bus.emit) bus.emit(name, payload);
  };
  let now = 0;
  // 夜間程度 0–1（isNight 例外或未注入 → 0）
  const nightLevel = () => {
    if (typeof isNight !== 'function') return 0;
    try {
      const v = isNight();
      return v === true ? 1 : clamp(Number(v) || 0, 0, 1);
    } catch (err) {
      return 0;
    }
  };

  // ---------- 粒子池 ----------
  const texture = THREE ? makeSmokeTexture(THREE) : null;
  const pool = []; // { sprite, alive, age, life, vx, vy, vz, size0, size1, opacity }
  let aliveCount = 0;

  function acquire() {
    for (const p of pool) if (!p.alive) return p;
    if (pool.length >= MAX_PARTICLES || !THREE) return null;
    const mat = new THREE.SpriteMaterial({ map: texture, color: 0xffffff, transparent: true, depthWrite: false, opacity: 0 });
    const sprite = new THREE.Sprite(mat);
    sprite.visible = false;
    sprite.renderOrder = 5;
    if (scene) scene.add(sprite);
    const p = { sprite, alive: false, age: 0, life: 1, vx: 0, vy: 0, vz: 0, size0: 1, size1: 1, opacity: 1 };
    pool.push(p);
    return p;
  }

  function spawnParticle(x, y, z, st, color) {
    const p = acquire();
    if (!p) return false;
    p.alive = true;
    aliveCount++;
    p.age = 0;
    p.life = st.life * (0.8 + Math.random() * 0.4);
    p.vx = (Math.random() - 0.5) * 0.5;
    p.vz = (Math.random() - 0.5) * 0.5;
    p.vy = st.rise * (0.8 + Math.random() * 0.4);
    p.size0 = st.size0;
    p.size1 = st.size1;
    p.opacity = st.opacity;
    const s = p.sprite;
    s.position.set(x + (Math.random() - 0.5) * 0.3, y, z + (Math.random() - 0.5) * 0.3);
    s.material.color.setHex(color);
    s.material.opacity = st.opacity;
    s.material.rotation = Math.random() * Math.PI * 2;
    s.scale.setScalar(st.size0);
    s.visible = true;
    return true;
  }

  function stepParticles(dt) {
    for (const p of pool) {
      if (!p.alive) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.alive = false;
        aliveCount--;
        p.sprite.visible = false;
        continue;
      }
      const k = p.age / p.life;
      const s = p.sprite;
      s.position.x += p.vx * dt;
      s.position.y += p.vy * dt;
      s.position.z += p.vz * dt;
      s.scale.setScalar(p.size0 + (p.size1 - p.size0) * k);
      s.material.opacity = p.opacity * (1 - k) * Math.min(1, k * 6); // 淡入再淡出
    }
  }

  // ---------- 耐久 ----------
  function setStage(vehicle, e, stage) {
    if (stage === e.stage) return;
    e.stage = stage;
    if (stage === 2 && !e.powerCut) {
      e.powerCut = true;
      if (vehicle.setPowerScale) vehicle.setPowerScale(DAMAGED_POWER);
    }
    if (stage === 3 && !e.disabled) {
      e.disabled = true;
      e.powerCut = true;
      if (vehicle.setPowerScale) vehicle.setPowerScale(0);
      emit('vehicle:disabled', { vehicle });
    }
  }

  return {
    attach(vehicle, { maxHealth = 1000 } = {}) {
      if (!vehicle) return;
      if (entries.has(vehicle)) return;
      entries.set(vehicle, { health: maxHealth, maxHealth, stage: 0, powerCut: false, disabled: false, lastAt: -Infinity, lastDmg: 0, emitAcc: 0 });
    },

    detach(vehicle) {
      entries.delete(vehicle);
    },

    // 回傳本次實際扣掉的耐久（去重 / 未 attach / 已熄火 → 0）
    onImpact(vehicle, { relSpeed = 0, kind = 'static', byPlayer = false } = {}) {
      const e = entries.get(vehicle);
      if (!e) return 0;
      const raw = impactDamage(vehicle, relSpeed, kind);
      if (raw <= 0) return 0;
      // 去重：窗內只補上「比窗內最大一次多出的部分」，連續接觸事件不會重複扣
      const inWindow = now - e.lastAt < DEDUP_SEC;
      const extra = inWindow ? raw - e.lastDmg : raw;
      if (extra <= 0) return 0;
      if (!inWindow) e.lastAt = now;
      e.lastDmg = raw;
      if (byPlayer && relSpeed >= CRASH_SPEED && kind !== 'ped' && !inWindow) emit('vehicle:crash', { vehicle, relSpeed });
      if (e.health <= 0) return 0;
      const before = e.health;
      e.health = Math.max(0, e.health - extra);
      const delta = before - e.health;
      emit('vehicle:damaged', { vehicle, health: e.health, delta });
      setStage(vehicle, e, stageOf(e.health));
      return delta;
    },

    // 修復：耐久回滿、功率恢復、停止冒煙
    repair(vehicle) {
      const e = entries.get(vehicle);
      if (!e) return;
      e.health = e.maxHealth;
      e.stage = 0;
      e.powerCut = false;
      e.disabled = false;
      e.lastAt = -Infinity;
      e.lastDmg = 0;
      e.emitAcc = 0;
      if (vehicle.setPowerScale) vehicle.setPowerScale(1);
    },

    healthOf(vehicle) {
      const e = entries.get(vehicle);
      return e ? e.health : null;
    },

    update(dt, camX = 0, camZ = 0) {
      now += dt;
      const r2 = SMOKE_RADIUS * SMOKE_RADIUS;
      for (const [v, e] of entries) {
        if (e.stage === 0 || !v.pos) continue;
        const dx = v.pos.x - camX;
        const dz = v.pos.z - camZ;
        if (dx * dx + dz * dz > r2) {
          e.emitAcc = 0;
          continue;
        }
        const st = SMOKE_STAGE[e.stage];
        e.emitAcc += st.rate * dt;
        if (e.emitAcc < 1) continue;
        const color = smokeColor(e.stage, e.stage === 3 ? nightLevel() : 0);
        const spec = v.spec || {};
        const fx = Math.sin(v.yaw || 0);
        const fz = Math.cos(v.yaw || 0);
        const ahead = (spec.length ?? 4.5) * 0.4;
        const hx = v.pos.x + fx * ahead;
        const hz = v.pos.z + fz * ahead;
        const hy = (v.pos.y || 0) + (spec.height ?? 1.45) * 0.8;
        while (e.emitAcc >= 1) {
          e.emitAcc -= 1;
          if (!spawnParticle(hx, hy, hz, st, color)) {
            e.emitAcc = 0;
            break;
          }
        }
      }
      stepParticles(dt);
    },

    // 測試 / 除錯用：粒子池大小與存活數
    get particleStats() {
      return { pool: pool.length, alive: aliveCount, max: MAX_PARTICLES };
    },

    dispose() {
      for (const p of pool) {
        if (scene) scene.remove(p.sprite);
        p.sprite.material.dispose();
      }
      pool.length = 0;
      aliveCount = 0;
      if (texture) texture.dispose();
      entries.clear();
    },
  };
}
