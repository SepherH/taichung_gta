// 警用直升機（V5 罪惡之都警方升級）：4★ 起一架直升機在玩家上空盤旋追蹤，探照燈光圈照到玩家 = 被看見，5★ 艙門射手開槍，可被打下墜毀爆炸
// 用法（整合層 main.js）：
//   const heli = createHelicopter({ THREE, scene, bus, wanted, combat, heightAt, obstacleTop, explode, damageVehicle, getPlayerActor, isNight, quality });
//   每幀（updateWanted 內 police.update 之後）：const heliSeen = heli.update(dt, { player: { x, z, inVehicle, speed, down }, paused });
//   wanted.update(dt, { seen: seen || heliSeen })；開新局 / 回主選單 heli.cancel()；畫質切換 heli.setQuality(tier)
// 邏輯為純 JS（不 import three）：THREE / scene 省略時只跑邏輯（node 測試）；deps 皆選用
//   heightAt(x, z)      地面高（m）；省略 = 0
//   obstacleTop(x, z)   該點最高障礙頂（地面 + 建築高，m）；省略 = heightAt。避障只靠這個高度場
//   combat              CombatSystem：applyHit（射手開槍；玩家在車內走 throughVehicle）
//   getPlayerActor()    玩家 combat actor；damageVehicle(n) 選用（車內中彈扣玩家車耐久）
//   explode(x, y, z, { byPlayer })  墜毀爆炸（整合層接 explosions.explode）
//   isNight() → 0..1 或 boolean；quality() → tier（'low' 關探照燈陰影）
//   bus                 emit police:heli / weapon:fire；聽 weapon:fire（玩家開槍 → 射線打機身）；解除通緝靠每幀讀 wanted 轉 leave（飛離）
//   createHeliObstacleTop({ heightAt, solids }) 建 obstacleTop：solids = buildings.colliders（{ id, poly, base, h }，地標已換成模型高）
//     + LANDMARK_SOLIDS（src/ui/menu-tour.js，地標 glb 量得的分層量體，含伸出 OSM 輪廓外的部分）
// 狀態：off → arrive（從 SPAWN_DIST 外飛來）→ orbit（繞玩家 ORBIT_R 盤旋）→ leave（星數 < HELI_STARS 或解除通緝，飛離 DESPAWN_DIST 後 off）
//   被打下（hp 0）→ down（自旋墜落）→ 觸地 / 屋頂 explode → off，HELI_RESPAWN 秒內不再出動（同時至多 1 架）
// 高度：目標 = 地面 + ALT_BASE ± ALT_SWAY（40–60 m 帶內緩慢起伏）；避障 = 取「目前位置機身圓盤（BODY_R 內 FOOT_STEP 格點 + 外緣環）+ 前方 LOOKAHEAD 秒」
//   的 obstacleTop 最大值 + CLEARANCE，兩者取高；若下一步（每 FOOT_STEP 一段）機身外緣環的障礙頂 + MIN_CLEAR 高於目前高度 → 本幀不水平前進、只以 CLIMB_FAST 爬升
//   （對水平寬度 ≥ 2 m 的障礙保證不穿模：旋翼半徑內不會有低於機身的障礙；v5-police 以 2×2 m 細塔驗證。更細的障礙可能落在取樣點之間）
// 探照燈：地面光點以 SPOT_SPEED 追向玩家（快車可甩開），與機身水平距離 ≤ SPOT_REACH；玩家在光點 SPOT_RADIUS 內且機身到玩家的線段未被 obstacleTop 擋住 → seen
//   搜索中：光點沿搜索圈內半徑 r × SWEEP_FRAC 的玫瑰線掃描（花瓣由圓心掃到邊緣再回圓心；掃描點速度 ≤ 光點速度 × SWEEP_SPEED_K，光點跟得上），
//   盤旋中心跟著掃描點（光點不被 SPOT_REACH 夾住）
// 射手（5★）：被看見（同上，含遮蔽）、玩家未倒地（player.down）、3D 距離 ≤ GUN_RANGE 時每 GUN_INTERVAL_MIN–MAX 秒一發，命中率 = 距離曲線 × speedHitFactor(玩家車速)
// 每幀路徑不配置物件；探照燈 SpotLight 常駐場景（intensity 0 = 關，不改燈數避免 shader 重編），low 檔不投影

import { speedHitFactor } from './police.js';
import { LANDMARK_SOLIDS } from '../ui/menu-tour.js';
import { SpatialGrid, closestOnPolygon, pointInPolygon, polygonBBox } from '../geom.js';

export const HELI_STARS = 4; // 幾星起出動
export const GUNNER_STARS = 5; // 幾星起艙門射手開槍
export const DT_MAX = 0.1;

export const SPAWN_DIST = 320; // m，出動時離玩家的水平距離
export const DESPAWN_DIST = 380; // m，飛離到此距離即收起
export const ORBIT_R = 28; // m，盤旋半徑
export const ORBIT_W = 0.22; // rad/s，盤旋角速度
export const ORBIT_ENTER = 70; // m，arrive → orbit 的水平距離
export const HELI_SPEED = 32; // m/s，巡航最高水平速度
export const HELI_ACCEL = 14; // m/s²，水平加減速上限
export const ALT_BASE = 50; // m，離地目標高度中心
export const ALT_SWAY = 6; // m，高度起伏振幅（44–56）
export const ALT_MIN = 40; // m，規格帶下緣（無障礙時）
export const ALT_MAX = 60; // m
export const CLEARANCE = 12; // m，避障時高於障礙頂的目標餘裕
export const MIN_CLEAR = 4; // m，絕對最小淨空（低於即停止水平前進並急升）
export const LOOKAHEAD = 2.5; // s，前方障礙取樣時間
export const BODY_R = 6; // m，機身 + 旋翼半徑（圓盤取樣）
export const FOOT_STEP = 1.4; // m，機身圓盤取樣間距（格點 / 外緣環 / 前進分段）
export const EDGE_PAD = 0.3; // m，外緣環比 BODY_R 外擴（多邊形取樣的弦不內縮到 BODY_R 內）
export const OCC_STEP = 1.5; // m，遮蔽線段取樣間距
export const OCC_END = 2; // m，遮蔽線段兩端不取樣的長度（機身本身 / 玩家腳邊）
export const MUZZLE_DROP = 1; // m，艙門槍口 / 探照燈在機身中心下方
export const CLIMB = 9; // m/s，一般爬升 / 下降速度
export const CLIMB_FAST = 22; // m/s，避障急升
export const DESCEND = 6; // m/s

export const SPOT_SPEED = 16; // m/s，光點追玩家速度（4★）
export const SPOT_SPEED_5 = 21; // m/s（5★）
export const SPOT_RADIUS = 7; // m，光圈半徑（玩家在內 = seen）
export const SPOT_REACH = 65; // m，光點離機身的水平距離上限
export const SWEEP_FRAC = 0.6; // 掃描半徑 = 搜索圈半徑 × 此值
export const SWEEP_PETAL = 2.62; // 玫瑰線 r = R·sin(k·θ) 的 k（非整數：花瓣逐圈錯開、久了蓋滿整圈；每片花瓣都經過圓心）
export const SWEEP_SPEED_K = 0.85; // 掃描點最高速度 = 光點速度 × 此值（光點跟得上）

export const HELI_HP = 500; // 耐久（手槍每發 HIT_DAMAGE.pistol → 約 15 發）
export const HIT_DAMAGE = { pistol: 34 }; // 每發對機身傷害（未列武器用 HIT_DAMAGE_DEFAULT）
export const HIT_DAMAGE_DEFAULT = 25;
export const HIT_RADIUS = 3.2; // m，機身命中球半徑
export const HIT_TAIL_R = 1.4; // m，尾桁命中球半徑（機身後方 TAIL_OFFSET）
export const TAIL_OFFSET = 4.6; // m
export const SHOT_TOL = 0.5; // m，射線命中距離容差（e.dist 之內才算打到直升機）
export const SHOT_RANGE = 120; // m，e.dist 缺值時的射程上限

export const GUN_RANGE = 95; // m，射手 3D 射程
export const GUN_INTERVAL_MIN = 1.0; // s
export const GUN_INTERVAL_MAX = 1.6;
export const GUN_DAMAGE = 12;
export const GUN_CAR_DAMAGE = 20; // 車內中彈扣玩家車耐久
export const GUN_HIT_NEAR = 0.55; // 命中率（3D 距離 ≤ GUN_NEAR）
export const GUN_HIT_FAR = 0.25; // 命中率（3D 距離 ≥ GUN_RANGE）
export const GUN_NEAR = 45; // m
export const GUN_SPREAD = 2.5; // m，未命中落點偏移

export const FALL_G = 9.8; // m/s²
export const FALL_SPIN = 3.5; // rad/s，墜落自旋
export const FALL_DRAG = 0.6; // 1/s，墜落水平速度衰減
export const HELI_RESPAWN = 60; // s，被打下後多久才可能再出動
export const CRASH_RADIUS = 10; // m，墜毀爆炸半徑（整合層用）
export const CRASH_POWER = 170;

export const ROTOR_W = 28; // rad/s，主旋翼轉速（視覺）
export const TAIL_ROTOR_W = 60;
export const LIGHT_PERIOD = 0.3; // s，機腹紅藍燈交替

const TAU = Math.PI * 2;
// 前方粗取樣（預先爬升用）：中心 + 外緣八方位
const RING = [];
for (let k = 0; k < 8; k++) RING.push([Math.cos((k * TAU) / 8) * BODY_R, Math.sin((k * TAU) / 8) * BODY_R]);
// 機身圓盤：BODY_R 內 FOOT_STEP 格點（含中心）+ 外緣環（半徑 BODY_R + EDGE_PAD，內切圓仍 ≥ BODY_R；相鄰點距 ≤ FOOT_STEP）
const EDGE = [];
const DISC = [];
{
  const er = BODY_R + EDGE_PAD;
  const n = Math.ceil((TAU * er) / FOOT_STEP);
  for (let k = 0; k < n; k++) EDGE.push([Math.cos((k * TAU) / n) * er, Math.sin((k * TAU) / n) * er]);
  const m = Math.floor(BODY_R / FOOT_STEP);
  for (let i = -m; i <= m; i++) {
    for (let j = -m; j <= m; j++) if (Math.hypot(i, j) * FOOT_STEP < BODY_R - 0.3) DISC.push([i * FOOT_STEP, j * FOOT_STEP]);
  }
  DISC.push(...EDGE);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// 射手命中率：GUN_NEAR 內 GUN_HIT_NEAR，GUN_RANGE 外 GUN_HIT_FAR（區間外夾住），再乘玩家速度係數
export function heliHitChance(d3, speed = 0) {
  const k = clamp((d3 - GUN_NEAR) / (GUN_RANGE - GUN_NEAR), 0, 1);
  return (GUN_HIT_NEAR + (GUN_HIT_FAR - GUN_HIT_NEAR) * k) * speedHitFactor(speed);
}

// 射線（單位方向）與球的最近交點距離；無交點回 -1
export function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const lx = cx - ox;
  const ly = cy - oy;
  const lz = cz - oz;
  const tc = lx * dx + ly * dy + lz * dz;
  const d2 = lx * lx + ly * ly + lz * lz - tc * tc;
  if (d2 > r * r) return -1;
  const th = Math.sqrt(r * r - d2);
  const t0 = tc - th;
  if (t0 >= 0) return t0;
  const t1 = tc + th;
  return t1 >= 0 ? 0 : -1;
}

// 高度帶內的目標離地高度（時間 t 的緩慢起伏）
export function cruiseAlt(t) {
  return ALT_BASE + ALT_SWAY * Math.sin(t * 0.31);
}

// 直升機避障高度場：地面與 solids（{ id, poly, base, h }；整合層傳 buildings.colliders）取高；
//   id 在 landmarkSolids（預設 LANDMARK_SOLIDS）者改用分層量體：輪廓外 pad 內頂高 = base + 該層高（取各層最高）
export function createHeliObstacleTop({ heightAt = () => 0, solids = [], landmarkSolids = LANDMARK_SOLIDS } = {}) {
  const grid = new SpatialGrid(25);
  for (const c of solids) {
    if (!c || !Array.isArray(c.poly) || c.poly.length < 6) continue;
    const bbox = polygonBBox(c.poly);
    const base = Number.isFinite(c.base) ? c.base : 0;
    const tiers = landmarkSolids && landmarkSolids[c.id];
    const list = tiers ? tiers.map(([pad, h]) => ({ pad, h })) : [{ pad: 0, h: c.h > 0 ? c.h : 0 }];
    for (const t of list) {
      const e = { poly: c.poly, bbox, pad: t.pad, top: base + t.h };
      grid.insert(e, bbox.x0 - t.pad, bbox.z0 - t.pad, bbox.x1 + t.pad, bbox.z1 + t.pad);
    }
  }
  const out = [];
  const cp = {};
  return (x, z) => {
    const g = heightAt(x, z);
    let m = Number.isFinite(g) ? g : 0;
    grid.query(x, z, x, z, out);
    for (const e of out) {
      if (e.top <= m) continue;
      const b = e.bbox;
      const p = e.pad;
      if (x < b.x0 - p || x > b.x1 + p || z < b.z0 - p || z > b.z1 + p) continue;
      if (pointInPolygon(x, z, e.poly) || (p > 0 && closestOnPolygon(x, z, e.poly, cp).d2 <= p * p)) m = e.top;
    }
    return m;
  };
}

export function createHelicopter(deps = {}) {
  const {
    THREE = null,
    scene = null,
    bus = null,
    wanted = null,
    combat = null,
    heightAt = () => 0,
    obstacleTop = null,
    explode = null,
    damageVehicle = null,
    getPlayerActor = () => null,
    isNight = () => 0,
    quality = () => 'high',
    rng = Math.random,
  } = deps;
  const ground = (x, z) => {
    const y = heightAt(x, z);
    return Number.isFinite(y) ? y : 0;
  };
  const topAt = (x, z) => {
    const y = obstacleTop ? obstacleTop(x, z) : ground(x, z);
    return Number.isFinite(y) ? y : ground(x, z);
  };

  const h = {
    state: 'off', // off | arrive | orbit | leave | down
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    hp: HELI_HP,
    spot: { x: 0, z: 0, y: 0, on: false },
    orbitAng: 0,
    fireTimer: 0,
    downByPlayer: false,
  };
  const player = { x: 0, z: 0, inVehicle: false, speed: 0, down: false };
  const sweep = { x: 0, z: 0, ph: 0 }; // 搜索中掃描點（玫瑰線相位自行累加）
  let time = 0;
  let cooldown = 0;
  let seen = false;
  let disposed = false;
  let shots = 0;
  let hits = 0;
  const offs = [];
  const evt = { type: '', x: 0, y: 0, z: 0, byPlayer: false, stars: 0 };
  const fireEvt = {
    weapon: 'pistol', x: 0, y: 0, z: 0, dirX: 0, dirY: 0, dirZ: 0, byPlayer: false, police: true, heli: true,
    shooter: null, hit: false, miss: false, ex: 0, ey: 0, ez: 0, dist: 0,
  };
  const hitDir = { x: 0, z: 0 };
  const heliActor = { id: 'police-heli', kind: 'vehicle', faction: 'police', pos: h.pos, heli: true };
  fireEvt.shooter = heliActor;

  const stars = () => Math.floor((wanted && wanted.stars) || 0);
  const wantedOn = () => stars() >= HELI_STARS && (!wanted || wanted.state !== 'clear');
  const emit = (type) => {
    if (!bus) return;
    evt.type = type;
    evt.x = h.pos.x;
    evt.y = h.pos.y;
    evt.z = h.pos.z;
    evt.byPlayer = h.downByPlayer;
    evt.stars = stars();
    bus.emit('police:heli', evt);
  };

  // ---------- 視覺（THREE 注入時；建立一次、常駐場景）----------
  const view = THREE && scene ? buildView(THREE, scene) : null;
  applyQuality();

  function applyQuality() {
    if (!view) return;
    const low = quality() === 'low';
    // 探照燈一律不投陰影：多一張 spot shadow map 會讓部分材質超過 MAX_TEXTURE_IMAGE_UNITS（16）而 shader 編譯失敗，
    // 整個城市建築不渲染（1019 通道實測）。光圈照明仍在，只是沒有陰影
    view.light.castShadow = false;
    view.light.shadow.mapSize.set(low ? 256 : 512, low ? 256 : 512);
  }

  // ---------- 避障 ----------
  // 取樣點組（相對偏移）+ 中心的障礙頂最大值
  function sampleTop(x, z, pts) {
    let m = topAt(x, z);
    for (let i = 0; i < pts.length; i++) {
      const t = topAt(x + pts[i][0], z + pts[i][1]);
      if (t > m) m = t;
    }
    return m;
  }
  // 機身圓盤（格點 + 外緣環）
  const footprintTop = (x, z) => sampleTop(x, z, DISC);

  // 線段 (ax, ay, az) → (bx, by, bz) 是否被 obstacleTop 擋住（每 OCC_STEP 取樣，兩端 OCC_END 內不算）
  function blocked(ax, ay, az, bx, by, bz) {
    const len = Math.hypot(bx - ax, by - ay, bz - az);
    const n = Math.ceil(len / OCC_STEP);
    for (let k = 1; k < n; k++) {
      const t = k / n;
      if (t * len < OCC_END || (1 - t) * len < OCC_END) continue;
      if (ay + (by - ay) * t < topAt(ax + (bx - ax) * t, az + (bz - az) * t)) return true;
    }
    return false;
  }
  // 槍口（機腹）到玩家胸口的視線
  const playerY = () => ground(player.x, player.z) + 1.2;
  const lineToPlayer = () => !blocked(h.pos.x, h.pos.y - MUZZLE_DROP, h.pos.z, player.x, playerY(), player.z);

  function spawn() {
    const ang = rng() * TAU;
    h.pos.x = player.x + Math.cos(ang) * SPAWN_DIST;
    h.pos.z = player.z + Math.sin(ang) * SPAWN_DIST;
    h.pos.y = Math.max(ground(h.pos.x, h.pos.z) + cruiseAlt(time), footprintTop(h.pos.x, h.pos.z) + CLEARANCE);
    h.vel.x = 0;
    h.vel.y = 0;
    h.vel.z = 0;
    h.yaw = Math.atan2(player.x - h.pos.x, player.z - h.pos.z);
    h.hp = HELI_HP;
    h.orbitAng = Math.atan2(h.pos.z - player.z, h.pos.x - player.x);
    h.fireTimer = GUN_INTERVAL_MAX;
    h.downByPlayer = false;
    h.spot.x = player.x + (h.pos.x - player.x) * 0.8;
    h.spot.z = player.z + (h.pos.z - player.z) * 0.8;
    h.state = 'arrive';
    emit('arrive');
  }

  function off(reason) {
    h.state = 'off';
    h.spot.on = false;
    seen = false;
    if (reason) emit(reason);
  }

  // 水平往 (tx, tz) 飛（速度上限 maxV、加速度上限 HELI_ACCEL），並處理高度 / 避障
  function fly(dt, tx, tz, maxV, altY) {
    const p = h.pos;
    const dx = tx - p.x;
    const dz = tz - p.z;
    const d = Math.hypot(dx, dz);
    // 期望速度：距離內減速到點（v = sqrt(2 a d)），方向朝目標
    const want = Math.min(maxV, Math.sqrt(2 * HELI_ACCEL * d));
    const wx = d > 1e-6 ? (dx / d) * want : 0;
    const wz = d > 1e-6 ? (dz / d) * want : 0;
    const ex = wx - h.vel.x;
    const ez = wz - h.vel.z;
    const el = Math.hypot(ex, ez);
    const dv = HELI_ACCEL * dt;
    if (el <= dv) {
      h.vel.x = wx;
      h.vel.z = wz;
    } else {
      h.vel.x += (ex / el) * dv;
      h.vel.z += (ez / el) * dv;
    }
    // 避障：目前 / 前方的障礙頂
    const aheadX = p.x + h.vel.x * LOOKAHEAD;
    const aheadZ = p.z + h.vel.z * LOOKAHEAD;
    const here = footprintTop(p.x, p.z);
    const ahead = Math.max(sampleTop(aheadX, aheadZ, RING), sampleTop((p.x + aheadX) / 2, (p.z + aheadZ) / 2, RING));
    const minY = Math.max(here, ahead) + CLEARANCE;
    const targetY = Math.max(altY, minY);
    const nx = p.x + h.vel.x * dt;
    const nz = p.z + h.vel.z * dt;
    // 下一步：沿位移每 FOOT_STEP 一段檢查外緣環（圓盤內部已由 here 涵蓋；低幀率大步長也不跳過細障礙）
    const segs = Math.max(1, Math.ceil(Math.hypot(nx - p.x, nz - p.z) / FOOT_STEP));
    let nextTop = -Infinity;
    for (let k = 1; k <= segs; k++) {
      const t = sampleTop(p.x + ((nx - p.x) * k) / segs, p.z + ((nz - p.z) * k) / segs, EDGE);
      if (t > nextTop) nextTop = t;
    }
    if (p.y < here + MIN_CLEAR || nextTop + MIN_CLEAR > p.y) {
      // 淨空不足：本幀不水平前進，急升（已低於障礙頂 + MIN_CLEAR 時直接抬到該高度）
      h.vel.x = 0;
      h.vel.z = 0;
      h.vel.y = CLIMB_FAST;
      p.y = Math.max(p.y + CLIMB_FAST * dt, here + MIN_CLEAR);
      return;
    }
    p.x = nx;
    p.z = nz;
    const dy = targetY - p.y;
    const rate = dy > 0 ? (p.y < minY ? CLIMB_FAST : CLIMB) : DESCEND;
    const step = clamp(dy, -rate * dt, rate * dt);
    h.vel.y = dt > 0 ? step / dt : 0;
    p.y += step;
    if (Math.hypot(h.vel.x, h.vel.z) > 0.5) {
      const fy = Math.atan2(h.vel.x, h.vel.z);
      let dyaw = (fy - h.yaw) % TAU;
      if (dyaw > Math.PI) dyaw -= TAU;
      if (dyaw < -Math.PI) dyaw += TAU;
      h.yaw += dyaw * Math.min(1, 2.5 * dt);
    }
  }

  const spotSpeed = () => (stars() >= GUNNER_STARS ? SPOT_SPEED_5 : SPOT_SPEED);

  // 搜索中掃描點：玫瑰線 ρ = R·sin(k·θ)（R = r × SWEEP_FRAC、k = SWEEP_PETAL）；速度 ≤ R·k·θ'，θ' 取使其 = 光點速度 × SWEEP_SPEED_K
  function updateSweep(dt, circle) {
    const R = Math.max(1, circle.r * SWEEP_FRAC);
    sweep.ph += ((spotSpeed() * SWEEP_SPEED_K) / (R * SWEEP_PETAL)) * dt;
    const rho = R * Math.sin(SWEEP_PETAL * sweep.ph);
    sweep.x = circle.x + Math.cos(sweep.ph) * rho;
    sweep.z = circle.z + Math.sin(sweep.ph) * rho;
  }

  // 探照燈光點：以 SPOT_SPEED 追向 (tx, tz)（active = 玩家；searching = 搜索圈內掃描點），離機身水平 ≤ SPOT_REACH；
  //   回傳是否照到玩家（光圈內且機腹到玩家的視線未被建築擋住）
  function updateSpot(dt, tx, tz) {
    const s = h.spot;
    const sp = spotSpeed();
    const dx = tx - s.x;
    const dz = tz - s.z;
    const d = Math.hypot(dx, dz);
    const step = Math.min(d, sp * dt);
    if (d > 1e-6) {
      s.x += (dx / d) * step;
      s.z += (dz / d) * step;
    }
    const rx = s.x - h.pos.x;
    const rz = s.z - h.pos.z;
    const r = Math.hypot(rx, rz);
    if (r > SPOT_REACH) {
      s.x = h.pos.x + (rx / r) * SPOT_REACH;
      s.z = h.pos.z + (rz / r) * SPOT_REACH;
    }
    s.y = topAt(s.x, s.z);
    s.on = true;
    return Math.hypot(player.x - s.x, player.z - s.z) <= SPOT_RADIUS && lineToPlayer();
  }

  function gunner(dt) {
    h.fireTimer -= dt;
    if (stars() < GUNNER_STARS || !seen || player.down) {
      if (h.fireTimer < 0) h.fireTimer = 0;
      return;
    }
    if (h.fireTimer > 0) return;
    h.fireTimer += GUN_INTERVAL_MIN + rng() * (GUN_INTERVAL_MAX - GUN_INTERVAL_MIN);
    if (h.fireTimer < 0) h.fireTimer = GUN_INTERVAL_MIN;
    const py = playerY();
    const dx = player.x - h.pos.x;
    const dy = py - (h.pos.y - MUZZLE_DROP);
    const dz = player.z - h.pos.z;
    const d3 = Math.hypot(dx, dy, dz) || 1;
    if (d3 > GUN_RANGE) return;
    const hit = rng() < heliHitChance(d3, player.speed);
    const actor = getPlayerActor();
    let applied = null;
    const hd = Math.hypot(dx, dz) || 1;
    hitDir.x = dx / hd;
    hitDir.z = dz / hd;
    if (hit && actor && combat && typeof combat.applyHit === 'function') {
      applied = combat.applyHit({
        attacker: null,
        target: actor,
        damage: GUN_DAMAGE,
        weapon: 'pistol',
        dir: hitDir,
        swingId: null,
        throughVehicle: player.inVehicle,
      });
      if (applied && player.inVehicle && damageVehicle) damageVehicle(GUN_CAR_DAMAGE);
    }
    shots++;
    if (applied) hits++;
    if (!bus) return;
    const side = hit ? 0 : (rng() * 2 - 1) * GUN_SPREAD;
    const ex = player.x - hitDir.z * side;
    const ez = player.z + hitDir.x * side;
    const len = Math.hypot(ex - h.pos.x, py - (h.pos.y - MUZZLE_DROP), ez - h.pos.z) || 1;
    fireEvt.x = h.pos.x;
    fireEvt.y = h.pos.y - MUZZLE_DROP;
    fireEvt.z = h.pos.z;
    fireEvt.dirX = (ex - h.pos.x) / len;
    fireEvt.dirY = (py - fireEvt.y) / len;
    fireEvt.dirZ = (ez - h.pos.z) / len;
    fireEvt.hit = !!applied;
    fireEvt.miss = !hit;
    fireEvt.ex = ex;
    fireEvt.ey = py;
    fireEvt.ez = ez;
    fireEvt.dist = len;
    bus.emit('weapon:fire', fireEvt);
    emit('fire');
  }

  function fall(dt) {
    const p = h.pos;
    const k = Math.exp(-FALL_DRAG * dt);
    h.vel.x *= k;
    h.vel.z *= k;
    h.vel.y -= FALL_G * dt;
    p.x += h.vel.x * dt;
    p.z += h.vel.z * dt;
    p.y += h.vel.y * dt;
    h.yaw += FALL_SPIN * dt;
    const top = topAt(p.x, p.z);
    if (p.y <= top + 1) {
      p.y = top + 1;
      if (explode) explode(p.x, p.y, p.z, { byPlayer: h.downByPlayer, radius: CRASH_RADIUS, power: CRASH_POWER });
      cooldown = HELI_RESPAWN;
      off('crash');
    }
  }

  // 受擊（射線命中或整合層直接呼叫）；回傳是否打下
  function damage(amount, { byPlayer = true } = {}) {
    if (disposed || h.state === 'off' || h.state === 'down' || !(amount > 0)) return false;
    h.hp = Math.max(0, h.hp - amount);
    if (h.hp > 0) return false;
    h.state = 'down';
    h.downByPlayer = !!byPlayer;
    h.spot.on = false;
    seen = false;
    emit('down');
    return true;
  }

  // 射線（單位方向）打機身 / 尾桁：回傳命中距離或 -1
  function rayHit(ox, oy, oz, dx, dy, dz, maxDist = SHOT_RANGE) {
    if (h.state === 'off') return -1;
    let t = raySphere(ox, oy, oz, dx, dy, dz, h.pos.x, h.pos.y, h.pos.z, HIT_RADIUS);
    const tx = h.pos.x - Math.sin(h.yaw) * TAIL_OFFSET;
    const tz = h.pos.z - Math.cos(h.yaw) * TAIL_OFFSET;
    const t2 = raySphere(ox, oy, oz, dx, dy, dz, tx, h.pos.y + 0.4, tz, HIT_TAIL_R);
    if (t < 0 || (t2 >= 0 && t2 < t)) t = t2;
    return t >= 0 && t <= maxDist ? t : -1;
  }

  if (bus && typeof bus.on === 'function') {
    offs.push(
      bus.on('weapon:fire', (e) => {
        if (!e || !e.byPlayer || e.police || h.state === 'off' || h.state === 'down') return;
        const len = Math.hypot(e.dirX, e.dirY, e.dirZ);
        if (!(len > 1e-6)) return;
        const max = (Number.isFinite(e.dist) ? e.dist : SHOT_RANGE) + SHOT_TOL;
        if (rayHit(e.x, e.y, e.z, e.dirX / len, e.dirY / len, e.dirZ / len, max) < 0) return;
        damage(HIT_DAMAGE[e.weapon] ?? HIT_DAMAGE_DEFAULT, { byPlayer: true });
      }),
    );
  }

  function update(dt, ctx = {}) {
    if (disposed) return false;
    dt = Math.max(0, Math.min(DT_MAX, Number(dt) || 0));
    if (ctx.paused) dt = 0;
    const pl = ctx.player;
    if (pl) {
      player.x = pl.x ?? 0;
      player.z = pl.z ?? 0;
      player.inVehicle = !!pl.inVehicle;
      player.speed = Math.abs(pl.speed || 0);
      player.down = !!pl.down;
    }
    time += dt;
    cooldown = Math.max(0, cooldown - dt);
    seen = false;
    const want = wantedOn();
    switch (h.state) {
      case 'off':
        if (want && cooldown <= 0 && dt > 0) spawn();
        break;
      case 'arrive':
      case 'orbit': {
        if (!want) {
          h.state = 'leave';
          h.spot.on = false;
          emit('leave');
          break;
        }
        // 光點目標：active 追玩家；searching 沿搜索圈內掃描路徑（不知道玩家在哪，掃過才算照到），盤旋中心跟著掃描點（光點不被 SPOT_REACH 夾住）
        const circle = wanted && wanted.state === 'searching' ? wanted.searchCircle : null;
        if (circle) updateSweep(dt, circle);
        else sweep.ph = 0;
        const cx = circle ? sweep.x : player.x;
        const cz = circle ? sweep.z : player.z;
        h.orbitAng += ORBIT_W * dt;
        const tx = cx + Math.cos(h.orbitAng) * ORBIT_R;
        const tz = cz + Math.sin(h.orbitAng) * ORBIT_R;
        fly(dt, tx, tz, HELI_SPEED, ground(h.pos.x, h.pos.z) + cruiseAlt(time));
        if (h.state === 'arrive' && Math.hypot(h.pos.x - cx, h.pos.z - cz) <= ORBIT_ENTER) {
          h.state = 'orbit';
          emit('orbit');
        }
        seen = updateSpot(dt, cx, cz);
        gunner(dt);
        break;
      }
      case 'leave': {
        if (want && cooldown <= 0) {
          h.state = 'arrive';
          emit('arrive');
          break;
        }
        const dx = h.pos.x - player.x;
        const dz = h.pos.z - player.z;
        const d = Math.hypot(dx, dz) || 1;
        fly(dt, h.pos.x + (dx / d) * 200, h.pos.z + (dz / d) * 200, HELI_SPEED, ground(h.pos.x, h.pos.z) + ALT_MAX);
        if (Math.hypot(h.pos.x - player.x, h.pos.z - player.z) >= DESPAWN_DIST) off('gone');
        break;
      }
      case 'down':
        fall(dt);
        break;
      default:
        break;
    }
    if (view) syncView(dt);
    return seen;
  }

  // 立即收起（開新局 / 回主選單）：不爆炸、不發事件以外的副作用
  function cancel() {
    if (h.state !== 'off') off('cancel');
    cooldown = 0;
    h.hp = HELI_HP;
    if (view) syncView(0);
  }

  function dispose() {
    if (disposed) return;
    cancel();
    disposed = true;
    for (const o of offs.splice(0)) if (typeof o === 'function') o();
    if (view) view.dispose();
  }

  // ---------- 視覺同步 ----------
  function syncView(dt) {
    const v = view;
    const active = h.state !== 'off';
    v.group.visible = active;
    if (!active) {
      v.light.intensity = 0;
      v.light.shadow.autoUpdate = false;
      v.disc.visible = false;
      v.beam.visible = false;
      return;
    }
    v.group.position.set(h.pos.x, h.pos.y, h.pos.z);
    // 前進方向前傾、墜落時翻滾
    const sp = Math.hypot(h.vel.x, h.vel.z);
    v.group.rotation.set(h.state === 'down' ? 0.5 : Math.min(0.22, sp * 0.008), h.yaw, h.state === 'down' ? 0.35 : 0);
    v.rotor.rotation.y += ROTOR_W * dt * (h.state === 'down' ? 0.4 : 1);
    v.tailRotor.rotation.x += TAIL_ROTOR_W * dt;
    const phase = Math.floor(time / LIGHT_PERIOD) % 2;
    v.redMat.emissiveIntensity = phase === 0 ? 4 : 0.2;
    v.blueMat.emissiveIntensity = phase === 1 ? 4 : 0.2;
    const s = h.spot;
    const on = s.on && h.state !== 'down';
    const night = Number(isNight()) || 0;
    v.light.intensity = on ? 40 + 260 * night : 0;
    v.light.shadow.autoUpdate = on && v.light.castShadow;
    v.light.position.set(h.pos.x, h.pos.y - 1.2, h.pos.z);
    v.target.position.set(s.x, s.y, s.z);
    v.target.updateMatrixWorld();
    v.disc.visible = on;
    v.beam.visible = on;
    if (!on) return;
    v.disc.position.set(s.x, s.y + 0.12, s.z);
    v.discMat.opacity = 0.12 + 0.33 * night;
    // 光柱：圓錐頂點在機腹、底面在光點
    const bx = s.x - h.pos.x;
    const by = s.y - (h.pos.y - 1.2);
    const bz = s.z - h.pos.z;
    const len = Math.hypot(bx, by, bz) || 1;
    v.beam.position.set(h.pos.x + bx / 2, h.pos.y - 1.2 + by / 2, h.pos.z + bz / 2);
    v.beam.scale.set(1, 1, len);
    v.beam.lookAt(s.x, s.y, s.z);
    v.beamMat.opacity = 0.03 + 0.1 * night;
  }

  return {
    update,
    damage,
    rayHit,
    cancel,
    dispose,
    setQuality: applyQuality,
    get state() {
      return h.state;
    },
    get active() {
      return h.state !== 'off';
    },
    get pos() {
      return h.pos;
    },
    get hp() {
      return h.hp;
    },
    get spot() {
      return h.spot;
    },
    get seen() {
      return seen;
    },
    get cooldown() {
      return cooldown;
    },
    stats() {
      return { state: h.state, hp: h.hp, shots, hits, y: h.pos.y };
    },
    view,
  };
}

// 低模直升機：機身 + 機鼻玻璃 + 尾桁 + 尾翼 + 起落橇 + 主旋翼 / 尾旋翼 + 機腹紅藍燈；探照燈 SpotLight + 地面光圈 + 光柱
function buildView(THREE, scene) {
  const group = new THREE.Group();
  group.name = 'police-heli';
  group.rotation.order = 'YXZ'; // 先 yaw 再前傾 / 翻滾
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1b2f5a, roughness: 0.5, metalness: 0.3 });
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xe8ecf2, roughness: 0.6 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x0b1420, roughness: 0.1, metalness: 0.6 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x202226, roughness: 0.7 });
  const redMat = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff2020, emissiveIntensity: 0.2 });
  const blueMat = new THREE.MeshStandardMaterial({ color: 0x000a40, emissive: 0x2050ff, emissiveIntensity: 0.2 });
  const geos = [];
  const mats = [bodyMat, whiteMat, glassMat, darkMat, redMat, blueMat];
  const box = (w, hh, d, mat, x, y, z, parent = group) => {
    const g = new THREE.BoxGeometry(w, hh, d);
    geos.push(g);
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  };
  box(2.2, 1.9, 4.2, bodyMat, 0, 0, 0); // 機身（+z 為機頭）
  box(2.24, 0.5, 4.0, whiteMat, 0, -0.55, 0); // 白色腰線
  box(1.9, 1.2, 1.3, glassMat, 0, 0.15, 2.5); // 機鼻玻璃
  box(0.45, 0.45, 5.2, bodyMat, 0, 0.35, -4.6); // 尾桁
  box(0.14, 1.5, 0.9, bodyMat, 0, 1.0, -7.0); // 尾翼
  box(1.8, 0.1, 0.5, bodyMat, 0, 0.45, -6.6); // 水平尾翼
  box(0.12, 0.12, 4.4, darkMat, 1.05, -1.35, 0.2); // 起落橇
  box(0.12, 0.12, 4.4, darkMat, -1.05, -1.35, 0.2);
  box(0.8, 0.5, 0.8, darkMat, 0, 1.2, 0); // 旋翼軸
  box(0.35, 0.2, 0.35, redMat, -0.6, -1.0, 1.2); // 機腹紅藍燈
  box(0.35, 0.2, 0.35, blueMat, 0.6, -1.0, 1.2);
  const rotor = new THREE.Group();
  rotor.position.set(0, 1.55, 0);
  group.add(rotor);
  box(0.35, 0.06, 11, darkMat, 0, 0, 0, rotor);
  box(11, 0.06, 0.35, darkMat, 0, 0, 0, rotor);
  const tailRotor = new THREE.Group();
  tailRotor.position.set(0.3, 1.0, -7.0);
  group.add(tailRotor);
  box(0.05, 1.8, 0.18, darkMat, 0, 0, 0, tailRotor);
  box(0.05, 0.18, 1.8, darkMat, 0, 0, 0, tailRotor);
  group.visible = false;
  scene.add(group);

  // 探照燈：常駐場景（intensity 0 = 關）
  const light = new THREE.SpotLight(0xfff4d6, 0, 160, Math.atan(SPOT_RADIUS / 45), 0.45, 1.2);
  light.shadow.autoUpdate = false;
  light.shadow.camera.near = 5;
  light.shadow.camera.far = 160;
  const target = new THREE.Object3D();
  light.target = target;
  scene.add(light);
  scene.add(target);
  const discGeo = new THREE.CircleGeometry(SPOT_RADIUS, 28);
  discGeo.rotateX(-Math.PI / 2);
  const discMat = new THREE.MeshBasicMaterial({
    color: 0xfff1c8, transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const disc = new THREE.Mesh(discGeo, discMat);
  disc.visible = false;
  disc.renderOrder = 3;
  scene.add(disc);
  // 光柱：開口圓錐（長 1，rotateX 後沿 +z 軸、頂點半徑 0.3 在 −z 端；lookAt 讓 +z 指向光點、scale.z = 長度），底面半徑 SPOT_RADIUS
  const beamGeo = new THREE.CylinderGeometry(SPOT_RADIUS, 0.3, 1, 20, 1, true);
  beamGeo.rotateX(Math.PI / 2);
  const beamMat = new THREE.MeshBasicMaterial({ color: 0xfff1c8, transparent: true, opacity: 0.08, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.visible = false;
  beam.renderOrder = 4;
  scene.add(beam);
  geos.push(discGeo, beamGeo);
  mats.push(discMat, beamMat);

  return {
    group, rotor, tailRotor, light, target, disc, discMat, beam, beamMat, redMat, blueMat,
    dispose() {
      for (const o of [group, light, target, disc, beam]) if (o.parent) o.parent.remove(o);
      if (light.shadow && light.shadow.map && light.shadow.map.dispose) light.shadow.map.dispose();
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
    },
  };
}
