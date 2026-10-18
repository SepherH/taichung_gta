// 警力世界轉接層（Phase 7 契約 B 的 adapters 實作）：把 police.js 的抽象指令接到既有車輛 / 尋路 / 對抗 / 角色 / 物理 / 音效
// 用法（整合層 main.js）：
//   const adapters = createPoliceAdapters({ vehicles, dmg, traffic, findRoute: (a, b) => findRoute(graph, a, b), combat,
//     characters: { createCharacter, disposeCharacter, CharacterAnimator, clips: getCharacterManifest()?.clips },
//     physics: { RAPIER, pw, router, groups: GROUPS }, scene, heightAt, blocked: (x, z) => !!buildingAt(x, z) || inWater(x, z),
//     audio, settings, bus, getPlayer: () => ({ x, z, actor: player.actor }), isNight: () => dayNight.night, surfaceOffset: SURFACE_OFFSET });
//   const police = createPolice({ bus, wanted, adapters });
//   每幀：police.update(dt, …) 之後 adapters.update(dt, { stars: wanted.stars, listener: focus, paused })（車輛控制 / 警示燈 / 警笛 / 警員移動與動畫）
// deps（最小集合；標「選用」者省略時該功能退化而不報錯）：
//   vehicles    VehicleManager：adopt({ type, x, z, yaw }) / remove(v) / vehicles（警車走既有可駕駛車輛路徑 → 玩家可上車搶走）
//   dmg         選用，vehicle-damage：attach(v) / detach(v) / healthOf(v)（耐久 0 = 警車 alive false）
//   traffic     Traffic：spawnSpots(cx, cz, rMin, rMax) → 車流路網上的生成點 [{ x, z, heading }]；cars（選用，避開車流車生成）
//   findRoute   選用，(from, to) → { points } | null（navigation.js findRoute 綁好 graph）；省略 → 一律直追
//   combat      CombatSystem：register / unregister / isDown / applyHit / newSwingId / on('knockdown' | 'dead')
//   characters  { createCharacter, disposeCharacter, CharacterAnimator, clips }（src/characters）
//   physics     選用，{ RAPIER, pw（PhysicsWorld：castRay / onAfterStep）, router, groups }：視線射線、警員膠囊剛體（可被車撞倒）
//   scene / heightAt(x, z) / blocked(x, z)（選用，警員不可進入的點：建築 / 水域）/ surfaceOffset（選用，網格離地偏移）
//   audio       選用，createAudio 的回傳（getOutput → { ctx, out }）；settings 選用（volumeSfx）
//   bus         選用，emit 'weapon:fire'（警員開槍：音效 / 行人聽到槍聲；byPlayer false、police true）；聽 'ped:dead' 判警員死亡
//   getPlayer   () → { x, z, actor }（警員開槍命中的對象）；isNight 選用 () → boolean；footprints 選用（無物理時的建築遮擋）；rng 選用
// 行為：
// - 警車 = vehicles.adopt('police')（動態剛體、v.ai = true：不自動停放、不做遠距休眠），每幀依指令以 setControls 駕駛：
//   patrol 沿 findRoute 路線（車道路網）；pursue 沿路線、距目標 ≤ DIRECT_DIST 改直追；ram 直追全油門；stop 煞停；
//   油門 > 0 而車速 < STUCK_SPEED 持續 STUCK_SEC → 倒車 REVERSE_SEC（反打方向）脫困
// - 警示燈：每台車複製 lightbar_red / lightbar_blue 材質，每 LIGHTBAR_PERIOD 秒紅藍交替提高 emissiveIntensity（夜間 LIGHTBAR_NIGHT）；
//   玩家上車（v.driven）→ 視為被搶：alive false、交還一般車輛（v.ai = false）、不再控制，但警示燈照閃到車輛被移除為止
// - 警笛：≥1 星時最近 SIREN_VOICES 台未被搶的警車各一組 WebAudio 振盪器，SIREN_LOW / SIREN_HIGH Hz 每 SIREN_HALF 秒交替，
//   增益 = SIREN_GAIN × volumeSfx × sirenGain(距離)，接 audio.getOutput().out（master，已含主音量）
// - 警員 = createCharacter('pedestrian') 執行期換深藍制服色 + CharacterAnimator + combat Actor（faction 'police'，可被打倒 / 擊斃）
//   + 行人膠囊剛體（kinematic，倒地切 dynamic）；down = combat.isDown；被子彈 / 車撞到 hp 歸零 → alive false
// - 開槍：命中率依距離 HIT_MAX（≤ FIRE_MIN）線性降到 HIT_MIN（≥ FIRE_MAX），命中走 combat.applyHit（weapon 'pistol'，傷害 SHOT_DAMAGE）
// - canSee：物理世界射線（只查 WORLD 固定體，起訖眼高 EYE_HEIGHT）；無物理時以 footprints 線段相交；都沒有 → true
// - findSpawnPoint：traffic.spawnSpots 的環帶點隨機抽 ≤ SPAWN_TRIES 次，取 canSee(玩家 → 點) 為 false 者；全部看得見時退回最遠的候選
// V5 警方升級（deps 增補皆選用：damageVehicle(v, n) 玩家車中彈扣耐久、graph 車道路網（buildRoadGraph，取度數 ≥ 3 的節點當路口）、
//   createCone() → Object3D（路障路錐網格；省略 = 路障只有警車））：
// - 命中率 hitChance(d, speed) = 距離曲線 × speedHitFactor(玩家速度)；getPlayer 回傳 inVehicle / speed / vehicle 時，車內中彈走 throughVehicle
//   並 damageVehicle(vehicle, CAR_HIT_VEHICLE_DAMAGE)
// - carFire(car, { x, z })：車上警察開槍（槍口 = 車頂、命中率 × CAR_HIT_MULT、傷害 CAR_SHOT_DAMAGE），同樣 emit weapon:fire（police true、car）
// - spawnSwat({ x, z, heading })：特警廂型車 = vehicles.adopt(SWAT_TYPE, 深色 SWAT_COLOR)、耐久 × SWAT_TOUGHNESS；
//   spawnOfficer({ swat: true })：黑色重裝制服、hp × SWAT_TOUGHNESS、每發 SWAT_SHOT_DAMAGE
// - findRoadblockPoint(px, pz, dirX, dirZ, min, max)：路網路口（無 graph 時退回 traffic.spawnSpots）中位於玩家前進方向 ±ROADBLOCK_HALF_ANGLE、
//   距離 min–max 者取最接近中段且最正前方的一個，退回玩家側 ROADBLOCK_SETBACK m；兩台車位不得在建築 / 水域內或貼著其他車
// - spawnRoadblock({ x, z, heading })：2 台橫停警車（vehicles.adopt 停放車，v.ai false → 靜止後 kinematic、可被撞開 / 搶走）+ 路錐（池化，≤ MAX_CONES）；
//   despawnRoadblock(rb)：移除未被搶的車、路錐回池；路障車警示燈照閃、isPoliceVehicle 為真
// - 警笛強度隨星數：增益 × sirenStarGain(stars)；≥ SIREN_FAST_STARS 星改 SIREN_HALF_FAST 急促節奏
import { createPedestrianBody } from '../physics/npc-bodies.js';
import { queryGroups, WORLD } from '../physics/groups.js';
import { FIRE_MIN, FIRE_MAX, speedHitFactor } from './police.js';

export const DT_MAX = 0.1; // s，dt clamp
export const POLICE_TYPE = 'police'; // VEHICLE_TYPES / 車輛 manifest id

// 駕駛
export const DIRECT_DIST = 40; // m，pursue 距目標此距離內改直追
export const ROUTE_REACH = 8; // m，路線點抵達半徑（換下一點）
export const REROUTE_SEC = 2; // s，pursue 定時重算路線
export const PATROL_REROUTE_SEC = 10; // s，patrol 定時重算（偏離路線時拉回）
export const REROUTE_MOVE = 20; // m，目標移動超過此距離即重算
export const STEER_GAIN = 1.8; // 方向誤差（rad）→ steer 倍率
export const THROTTLE_GAIN = 0.35; // 速度差（m/s）→ 油門倍率
export const CORNER_ANGLE = Math.PI / 2; // 方向誤差達此值時降到最低彎道速度
export const CORNER_MIN = 0.3; // 最低彎道速度比例
export const STUCK_SPEED = 1; // m/s
export const STUCK_SEC = 3; // s，卡住多久開始倒車
export const REVERSE_SEC = 1.5; // s，倒車脫困時間
export const STOP_HANDBRAKE_SPEED = 1; // m/s，stop 模式低於此車速拉手煞車

// 警示燈
export const LIGHTBAR_MATERIALS = ['lightbar_red', 'lightbar_blue'];
export const LIGHTBAR_PERIOD = 0.25; // s，紅藍交替週期（半週期）
export const LIGHTBAR_DAY = 2.5; // 亮燈 emissiveIntensity（白天）
export const LIGHTBAR_NIGHT = 6; // 亮燈 emissiveIntensity（夜間）
export const LIGHTBAR_DIM = 0.1; // 暗燈 emissiveIntensity

// 警笛
export const SIREN_LOW = 650; // Hz
export const SIREN_HIGH = 900; // Hz
export const SIREN_HALF = 0.5; // s，每個音持續秒數
export const SIREN_GAIN = 0.22; // 最近距離時的增益（× volumeSfx）
export const SIREN_REF = 15; // m，此距離內不衰減
export const SIREN_RANGE = 250; // m，超過不播
export const SIREN_FADE = 40; // m，SIREN_RANGE 前此距離內淡出
export const SIREN_VOICES = 3; // 同時發聲的警車數上限（取最近者）
export const SIREN_CUTOFF = 2400; // Hz，低通濾波（鋸齒波去刺耳）
export const SIREN_SMOOTH = 0.05; // s，增益平滑時間常數
export const SIREN_STAR_GAIN = [0, 1, 1.1, 1.2, 1.35, 1.5]; // 依星數的增益倍率（V5：越高星越響）
export const SIREN_FAST_STARS = 4; // 幾星起改急促節奏
export const SIREN_HALF_FAST = 0.3; // s

// 視線 / 生成
export const EYE_HEIGHT = 1.6; // m
export const SPAWN_TRIES = 12;
export const SPAWN_CAR_GAP = 10; // m，生成點與既有車輛（警車 / 車流車）的最小距離
export const FOOTPRINT_CELL = 50; // m，footprints 空間格

// 警員
export const OFFICER_VARIANT = 'pedestrian';
export const UNIFORM_COLORS = { shirt: '#1C2B4F', pants: '#141B2E' }; // 深藍制服（執行期換色，不改模型檔）
export const OFFICER_HP = 100;
export const WALK_SPEED = 1.6; // m/s
export const RUN_SPEED = 4.5; // m/s（同行人逃跑速度，播 run）
export const ARRIVE_EPS = 0.15; // m，移動目標小於此距離視為已到
export const TURN_RATE = 10; // 1/s，轉身平滑
export const AIM_HOLD = 0.3; // s，officerAim 之後維持面向目標的時間
export const SHOT_DAMAGE = 15;
export const HIT_MAX = 0.7; // 命中率（距離 ≤ FIRE_MIN）
export const HIT_MIN = 0.3; // 命中率（距離 ≥ FIRE_MAX）
export const MUZZLE_HEIGHT = 1.4; // m
export const CHEST_HEIGHT = 1.2; // m，瞄準點高度
export const MISS_SPREAD = 1.5; // m，未命中時落點的水平偏移

// V5：車上開槍 / 車內中彈 / 特警 / 路障
export const CAR_SHOT_DAMAGE = 12; // 車上警察每發傷害
export const CAR_HIT_MULT = 0.8; // 車上開槍命中率倍率（移動中射擊）
export const CAR_MUZZLE_HEIGHT = 1.3; // m
export const CAR_HIT_VEHICLE_DAMAGE = 20; // 玩家在車內中彈時扣車耐久（vehicle-damage 滿 1000）
export const SWAT_TYPE = 'suv';
export const SWAT_COLOR = '#16181d';
export const SWAT_TOUGHNESS = 2; // 特警車耐久 / 特警 hp 倍率
export const SWAT_VAN_HEALTH = 1000 * SWAT_TOUGHNESS;
export const SWAT_COLORS = { shirt: '#121418', pants: '#0b0c0f' };
export const SWAT_SHOT_DAMAGE = 18;
export const ROADBLOCK_HALF_ANGLE = Math.PI / 7; // rad，前進方向 ±25.7°
export const ROADBLOCK_SETBACK = 6; // m，從路口中心往玩家側退
export const ROADBLOCK_CAR_GAP = 2.7; // m，兩台車中心離路障中心的橫向距離
export const ROADBLOCK_CLEAR = 4; // m，車位與既有車輛的最小距離
export const ROADBLOCK_CONES = [
  [-6.2, 1.5],
  [6.2, 1.5],
  [-4.6, 3.2],
  [4.6, 3.2],
]; // 路錐（橫向, 往玩家側）m
export const MAX_ROADBLOCK_SETS = 2;
export const MAX_CONES = ROADBLOCK_CONES.length * MAX_ROADBLOCK_SETS;

const TAU = Math.PI * 2;

function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------- 純函式（測試用匯出）----------

// 警示燈相位：0 = 紅亮、1 = 藍亮
export function lightbarPhase(t) {
  return Math.floor(t / LIGHTBAR_PERIOD + 1e-9) % 2;
}

// 警笛頻率：offset 讓多台車不同步
export function sirenFreq(t, offset = 0, half = SIREN_HALF) {
  return Math.floor((t + offset) / half + 1e-9) % 2 === 0 ? SIREN_LOW : SIREN_HIGH;
}

// 警笛距離衰減 0..1：SIREN_REF 內 1，之後 ∝ 1/d，SIREN_RANGE 前 SIREN_FADE 內淡到 0
export function sirenGain(d) {
  if (!(d >= 0)) return 0;
  if (d >= SIREN_RANGE) return 0;
  const fall = d <= SIREN_REF ? 1 : SIREN_REF / d;
  return fall * Math.min(1, (SIREN_RANGE - d) / SIREN_FADE);
}

// 開槍命中率：FIRE_MIN 內 HIT_MAX，FIRE_MAX 外 HIT_MIN，中間線性；× speedHitFactor(玩家速度 m/s)
export function hitChance(d, speed = 0) {
  const k = clamp((d - FIRE_MIN) / (FIRE_MAX - FIRE_MIN), 0, 1);
  return (HIT_MAX + (HIT_MIN - HIT_MAX) * k) * speedHitFactor(speed);
}

// 警笛增益的星數倍率（0 星 0）
export function sirenStarGain(stars) {
  const n = Math.max(0, Math.min(SIREN_STAR_GAIN.length - 1, Math.floor(Number(stars) || 0)));
  return SIREN_STAR_GAIN[n];
}

// 車道路網的路口（度數 ≥ 3 的節點）→ { x: Float64Array, z: Float64Array, n }
export function graphJunctions(graph) {
  if (!graph || !graph.offsets || !graph.x || !graph.z) return { x: new Float64Array(0), z: new Float64Array(0), n: 0 };
  const idx = [];
  for (let i = 0; i < graph.nodeCount; i++) if (graph.offsets[i + 1] - graph.offsets[i] >= 3) idx.push(i);
  const x = new Float64Array(idx.length);
  const z = new Float64Array(idx.length);
  idx.forEach((i, k) => {
    x[k] = graph.x[i];
    z[k] = graph.z[i];
  });
  return { x, z, n: idx.length };
}

// 線段 ab 與線段 cd 是否相交（含端點接觸）
export function segmentsIntersect(ax, az, bx, bz, cx, cz, dx, dz) {
  const d1 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d2 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  const d3 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d4 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const on = (px, pz, qx, qz, rx, rz) => Math.min(px, qx) <= rx && rx <= Math.max(px, qx) && Math.min(pz, qz) <= rz && rz <= Math.max(pz, qz);
  if (d1 === 0 && on(cx, cz, dx, dz, ax, az)) return true;
  if (d2 === 0 && on(cx, cz, dx, dz, bx, bz)) return true;
  if (d3 === 0 && on(ax, az, bx, bz, cx, cz)) return true;
  if (d4 === 0 && on(ax, az, bx, bz, dx, dz)) return true;
  return false;
}

// 建築 footprint 索引：polys = [[{x,z}…] | { pts: [{x,z}…] }]；blocked(ax, az, bx, bz) → 線段是否穿過任一多邊形邊
export function createFootprintIndex(polys, cell = FOOTPRINT_CELL) {
  const list = [];
  const grid = new Map();
  const key = (i, j) => `${i},${j}`;
  for (const p of polys || []) {
    const pts = Array.isArray(p) ? p : p && (p.pts || p.points || p.footprint);
    if (!Array.isArray(pts) || pts.length < 3) continue;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const q of pts) {
      x0 = Math.min(x0, q.x);
      z0 = Math.min(z0, q.z);
      x1 = Math.max(x1, q.x);
      z1 = Math.max(z1, q.z);
    }
    const rec = { pts, x0, z0, x1, z1, mark: 0 };
    list.push(rec);
    for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++) {
      for (let j = Math.floor(z0 / cell); j <= Math.floor(z1 / cell); j++) {
        const k = key(i, j);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(rec);
      }
    }
  }
  let run = 0;
  function blocked(ax, az, bx, bz) {
    run++;
    const minX = Math.min(ax, bx), maxX = Math.max(ax, bx), minZ = Math.min(az, bz), maxZ = Math.max(az, bz);
    for (let i = Math.floor(minX / cell); i <= Math.floor(maxX / cell); i++) {
      for (let j = Math.floor(minZ / cell); j <= Math.floor(maxZ / cell); j++) {
        const recs = grid.get(key(i, j));
        if (!recs) continue;
        for (const r of recs) {
          if (r.mark === run) continue;
          r.mark = run;
          if (r.x1 < minX || r.x0 > maxX || r.z1 < minZ || r.z0 > maxZ) continue;
          const pts = r.pts;
          for (let n = 0; n < pts.length; n++) {
            const p = pts[n];
            const q = pts[(n + 1) % pts.length];
            if (segmentsIntersect(ax, az, bx, bz, p.x, p.z, q.x, q.z)) return true;
          }
        }
      }
    }
    return false;
  }
  return { blocked, count: list.length };
}

// ---------- 轉接層 ----------

export function createPoliceAdapters(deps = {}) {
  const {
    vehicles = null,
    dmg = null,
    traffic = null,
    findRoute = null,
    combat = null,
    characters = null,
    physics = null,
    scene = null,
    heightAt = () => 0,
    blocked = null,
    surfaceOffset = 0,
    audio = null,
    settings = null,
    bus = null,
    getPlayer = () => null,
    isNight = () => false,
    footprints = null,
    rng = Math.random,
    damageVehicle = null,
    graph = null,
    createCone = null,
  } = deps;
  const pw = physics && physics.pw ? physics.pw : null;
  const rayGroups = queryGroups(WORLD);
  const fpIndex = footprints ? createFootprintIndex(footprints) : null;

  const cars = new Set(); // 受控警車（未被搶、未回收）
  const stolen = new Set(); // 被玩家搶走的警車：只更新警示燈，車輛被移除後清掉
  const byVehicle = new Map(); // Vehicle → car
  const officers = new Set();
  const voices = []; // 警笛音源 { osc, filter, gain, car }
  let voiceCtx = null;
  let time = 0;
  let seq = 0;
  let disposed = false;
  const spotBuf = [];
  const offs = [];
  const roadblocks = new Set(); // spawnRoadblock 回傳的路障
  const blockCars = new Set(); // 路障警車（未被搶、未回收）：只煞停 + 警示燈
  const conePool = []; // { obj, used }
  let junctions = null; // graphJunctions(graph)，第一次找路障點時建立

  const dist = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
  const groundY = (x, z) => {
    const y = heightAt(x, z);
    return Number.isFinite(y) ? y : 0;
  };

  // ---------- 視線 ----------
  function canSee(fromX, fromZ, toX, toZ) {
    const d = dist(fromX, fromZ, toX, toZ);
    if (d < 1e-3) return true;
    if (pw && typeof pw.castRay === 'function') {
      // 眼高到眼高（地面起伏時沿坡度，避免緩坡把水平射線打進地面）；只查 WORLD 固定體（地形 / 建築），車與人不擋
      const ay = groundY(fromX, fromZ) + EYE_HEIGHT;
      const by = groundY(toX, toZ) + EYE_HEIGHT;
      const len = Math.hypot(toX - fromX, by - ay, toZ - fromZ);
      const dir = { x: (toX - fromX) / len, y: (by - ay) / len, z: (toZ - fromZ) / len };
      const hit = pw.castRay({ x: fromX, y: ay, z: fromZ }, dir, len, { groups: rayGroups });
      return !hit || hit.toi >= len - 0.25;
    }
    if (fpIndex) return !fpIndex.blocked(fromX, fromZ, toX, toZ);
    return true;
  }

  // ---------- 生成點 ----------
  function nearVehicle(x, z) {
    const g2 = SPAWN_CAR_GAP * SPAWN_CAR_GAP;
    if (vehicles) for (const v of vehicles.vehicles) if ((v.pos.x - x) ** 2 + (v.pos.z - z) ** 2 < g2) return true;
    if (traffic && traffic.cars) {
      for (const c of traffic.cars) {
        const p = c.v ? c.v.pos : c.pos;
        if (p && (p.x - x) ** 2 + (p.z - z) ** 2 < g2) return true;
      }
    }
    return false;
  }

  function findSpawnPoint(nearX, nearZ, minDist, maxDist) {
    if (!traffic || typeof traffic.spawnSpots !== 'function') return null;
    const spots = traffic.spawnSpots(nearX, nearZ, minDist, maxDist, spotBuf);
    if (!spots || !spots.length) return null;
    let fallback = null;
    let fallbackD = -1;
    for (let k = 0; k < SPAWN_TRIES; k++) {
      const sp = spots[Math.floor(rng() * spots.length) % spots.length];
      const d = dist(sp.x, sp.z, nearX, nearZ);
      if (d < minDist || d > maxDist || nearVehicle(sp.x, sp.z)) continue;
      if (!canSee(nearX, nearZ, sp.x, sp.z)) return { x: sp.x, z: sp.z, heading: sp.heading ?? 0 };
      if (d > fallbackD) {
        fallbackD = d;
        fallback = sp;
      }
    }
    return fallback ? { x: fallback.x, z: fallback.z, heading: fallback.heading ?? 0 } : null;
  }

  // ---------- 警車 ----------

  // 每台車複製警示燈材質（glb 複本共用模板材質，直接改會讓所有警車同步）
  function takeLightbar(v) {
    const out = { red: [], blue: [], owned: [] };
    const cloned = new Map();
    if (!v.mesh || typeof v.mesh.traverse !== 'function') return out;
    const own = (m) => {
      if (!m || !LIGHTBAR_MATERIALS.includes(m.name)) return m;
      let c = cloned.get(m);
      if (!c) {
        c = typeof m.clone === 'function' ? m.clone() : m;
        cloned.set(m, c);
        out.owned.push(c);
        (m.name === LIGHTBAR_MATERIALS[0] ? out.red : out.blue).push(c);
      }
      return c;
    };
    v.mesh.traverse((o) => {
      if (!o.material) return;
      o.material = Array.isArray(o.material) ? o.material.map(own) : own(o.material);
    });
    return out;
  }

  function spawnCar({ x, z, heading = 0 } = {}) {
    return makeCar({ x, z, heading, type: POLICE_TYPE });
  }

  // 特警廂型車：深色休旅車、耐久 × SWAT_TOUGHNESS；駕駛 / 警笛同一般警車
  function spawnSwat({ x, z, heading = 0 } = {}) {
    const car = makeCar({ x, z, heading, type: SWAT_TYPE, color: SWAT_COLOR, maxHealth: SWAT_VAN_HEALTH });
    if (car) car.swat = true;
    return car;
  }

  function makeCar({ x, z, heading = 0, type, color, maxHealth }) {
    if (disposed || !vehicles) return null;
    const v = vehicles.adopt(color ? { type, color, x, z, yaw: heading } : { type, x, z, yaw: heading });
    if (!v) return null;
    v.ai = true;
    if (dmg && typeof dmg.attach === 'function') {
      if (maxHealth) dmg.attach(v, { maxHealth });
      else dmg.attach(v);
    }
    const car = {
      id: `police-car-${++seq}`,
      police: true,
      swat: false,
      v,
      cmd: { x, z, mode: 'patrol', maxSpeed: 0, set: false },
      route: null,
      routeIdx: 0,
      routeAt: -Infinity,
      routeGoal: { x: NaN, z: NaN },
      stuckT: 0,
      reverseT: 0,
      reverseSteer: 1,
      lightbar: takeLightbar(v),
      sirenOffset: rng() * SIREN_HALF * 2,
      stolen: false,
      removed: false,
      get pos() {
        return v.pos;
      },
      get speed() {
        return Math.abs(v.speed || 0);
      },
      get alive() {
        return carAlive(car);
      },
    };
    cars.add(car);
    byVehicle.set(v, car);
    setLightbar(car, lightbarPhase(time), isNight());
    return car;
  }

  function vehicleExists(v) {
    return !!vehicles && vehicles.vehicles.includes(v);
  }

  function carAlive(car) {
    if (car.removed || car.stolen || !vehicleExists(car.v)) return false;
    const h = dmg && typeof dmg.healthOf === 'function' ? dmg.healthOf(car.v) : null;
    return !(Number.isFinite(h) && h <= 0);
  }

  function releaseLightbar(car) {
    for (const m of car.lightbar.owned) if (typeof m.dispose === 'function') m.dispose();
    car.lightbar.owned.length = 0;
  }

  function despawnCar(car) {
    if (!car || car.removed) return;
    car.removed = true;
    cars.delete(car);
    releaseVoice(car);
    if (car.stolen) return; // 玩家搶走的車：留給玩家（一般車輛），警示燈由 stolen 清單繼續閃
    byVehicle.delete(car.v);
    if (vehicleExists(car.v)) {
      if (dmg && typeof dmg.detach === 'function') dmg.detach(car.v);
      vehicles.remove(car.v);
    }
    releaseLightbar(car);
  }

  function driveCar(car, { x, z, mode = 'patrol', maxSpeed = 0 } = {}) {
    if (!car || car.removed || car.stolen) return;
    const c = car.cmd;
    c.x = x;
    c.z = z;
    c.mode = mode;
    c.maxSpeed = maxSpeed;
    c.set = true;
  }

  // 依路線 / 直追算出本幀要開向的點
  function steerTarget(car) {
    const c = car.cmd;
    const p = car.v.pos;
    const d = dist(p.x, p.z, c.x, c.z);
    if (c.mode === 'ram' || (c.mode === 'pursue' && d <= DIRECT_DIST) || typeof findRoute !== 'function') {
      car.route = null;
      return c;
    }
    const period = c.mode === 'pursue' ? REROUTE_SEC : PATROL_REROUTE_SEC;
    if (!car.route || time - car.routeAt >= period || dist(c.x, c.z, car.routeGoal.x, car.routeGoal.z) > REROUTE_MOVE) {
      const r = findRoute({ x: p.x, z: p.z }, { x: c.x, z: c.z });
      car.route = r && r.points && r.points.length >= 2 ? r.points : null;
      car.routeIdx = 1;
      car.routeAt = time;
      car.routeGoal.x = c.x;
      car.routeGoal.z = c.z;
    }
    const pts = car.route;
    if (!pts) return c;
    // patrol 終點取路網投影點 E（倒數第二點）：原始目標是 ringPoint 任意點，可能在建築 / 水域內
    const last = c.mode === 'patrol' && pts.length >= 3 ? pts.length - 2 : pts.length - 1;
    while (car.routeIdx < last && dist(p.x, p.z, pts[car.routeIdx].x, pts[car.routeIdx].z) < ROUTE_REACH) car.routeIdx++;
    car.routeIdx = Math.min(car.routeIdx, last);
    // 到 E 即視為抵達：controlCar 煞停、police.js 換下一個巡邏點
    car.patrolArrived = c.mode === 'patrol' && dist(p.x, p.z, pts[last].x, pts[last].z) < ROUTE_REACH;
    return pts[car.routeIdx];
  }

  function brakeCar(car) {
    car.stuckT = 0;
    car.reverseT = 0;
    car.v.setControls({ throttle: 0, steer: 0, brake: 1, handbrake: Math.abs(car.v.speed || 0) < STOP_HANDBRAKE_SPEED });
  }

  function controlCar(car, dt) {
    const v = car.v;
    const c = car.cmd;
    if (v.body && v.body.kinematic && typeof v.body.setKinematic === 'function') v.body.setKinematic(false); // 掉出世界重置後會被停放
    // adopt 出來的剛體在第一個物理步後會變成 disabled（VehicleBody.active 仍為 true、未經 setEnabled），油門有值但車原地不動 → 重新啟用
    const rb = v.body && v.body.body;
    if (rb && v.body.active !== false && typeof rb.isEnabled === 'function' && !rb.isEnabled()) rb.setEnabled(true);
    const speed = v.speed || 0;
    if (!c.set || c.mode === 'stop') {
      car.stuckT = 0;
      car.reverseT = 0;
      v.setControls({ throttle: 0, steer: 0, brake: 1, handbrake: Math.abs(speed) < STOP_HANDBRAKE_SPEED });
      return;
    }
    car.patrolArrived = false;
    const t = steerTarget(car);
    if (car.patrolArrived) {
      car.stuckT = 0;
      car.reverseT = 0;
      v.setControls({ throttle: 0, steer: 0, brake: 1, handbrake: Math.abs(speed) < STOP_HANDBRAKE_SPEED });
      return;
    }
    const p = v.pos;
    const err = wrapAngle(Math.atan2(t.x - p.x, t.z - p.z) - v.yaw); // > 0 = 目標在左（yaw 增加 = 左轉，steer +1 = 左）
    if (car.reverseT > 0) {
      car.reverseT -= dt;
      v.setControls({ throttle: -1, steer: car.reverseSteer, brake: 0, handbrake: false });
      return;
    }
    let throttle;
    if (c.mode === 'ram') throttle = 1;
    else {
      const corner = clamp(1 - (Math.abs(err) / CORNER_ANGLE) * (1 - CORNER_MIN), CORNER_MIN, 1);
      throttle = clamp((c.maxSpeed * corner - speed) * THROTTLE_GAIN, -1, 1);
    }
    const steer = clamp(err * STEER_GAIN, -1, 1);
    if (throttle > 0.3 && Math.abs(speed) < STUCK_SPEED) car.stuckT += dt;
    else car.stuckT = 0;
    if (car.stuckT >= STUCK_SEC) {
      // 倒車脫困：反打方向（倒車時車頭往反方向擺，讓車頭轉向目標）
      car.stuckT = 0;
      car.reverseT = REVERSE_SEC;
      car.reverseSteer = err >= 0 ? -1 : 1;
      v.setControls({ throttle: -1, steer: car.reverseSteer, brake: 0, handbrake: false });
      return;
    }
    v.setControls({ throttle, steer, brake: 0, handbrake: false });
  }

  function setLightbar(car, phase, night) {
    const hi = night ? LIGHTBAR_NIGHT : LIGHTBAR_DAY;
    for (const m of car.lightbar.red) m.emissiveIntensity = phase === 0 ? hi : LIGHTBAR_DIM;
    for (const m of car.lightbar.blue) m.emissiveIntensity = phase === 1 ? hi : LIGHTBAR_DIM;
  }

  // ---------- 警笛 ----------
  function sfxVolume() {
    try {
      const v = settings && typeof settings.get === 'function' ? settings.get('volumeSfx') : undefined;
      return Number.isFinite(v) ? v : 0.9;
    } catch {
      return 0.9;
    }
  }

  function stopVoices() {
    for (const vo of voices.splice(0)) {
      try {
        vo.osc.stop();
      } catch {
        // 已停止
      }
      vo.osc.disconnect();
      vo.filter.disconnect();
      vo.gain.disconnect();
    }
    voiceCtx = null;
  }

  function releaseVoice(car) {
    for (const vo of voices) if (vo.car === car) vo.car = null;
  }

  function makeVoice(ctx, out) {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = SIREN_LOW;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = SIREN_CUTOFF;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(out);
    osc.start();
    return { osc, filter, gain, car: null };
  }

  function updateSirens(stars, listener, paused) {
    const o = audio && typeof audio.getOutput === 'function' ? audio.getOutput() : null;
    if (!o || !o.ctx || !o.out) {
      if (voices.length) stopVoices();
      return;
    }
    if (voiceCtx !== o.ctx) {
      stopVoices();
      voiceCtx = o.ctx;
    }
    const ctx = o.ctx;
    const now = ctx.currentTime || 0;
    // 候選：≥1 星、未暫停、未被搶的警車，取最近 SIREN_VOICES 台
    const want = [];
    if (stars >= 1 && !paused && listener) {
      for (const car of cars) {
        if (!carAlive(car)) continue;
        const d = dist(car.v.pos.x, car.v.pos.z, listener.x, listener.z);
        if (d < SIREN_RANGE) want.push({ car, d });
      }
      want.sort((a, b) => a.d - b.d);
      want.length = Math.min(want.length, SIREN_VOICES);
    }
    const chosen = new Map(want.map((w) => [w.car, w.d]));
    for (const vo of voices) if (vo.car && !chosen.has(vo.car)) vo.car = null;
    for (const { car } of want) {
      if (voices.some((vo) => vo.car === car)) continue;
      let vo = voices.find((x) => !x.car);
      if (!vo && voices.length < SIREN_VOICES) {
        vo = makeVoice(ctx, o.out);
        voices.push(vo);
      }
      if (vo) vo.car = car;
    }
    const vol = SIREN_GAIN * sfxVolume() * sirenStarGain(stars);
    const half = stars >= SIREN_FAST_STARS ? SIREN_HALF_FAST : SIREN_HALF;
    for (const vo of voices) {
      const g = vo.car ? vol * sirenGain(chosen.get(vo.car)) : 0;
      vo.gain.gain.setTargetAtTime(g, now, SIREN_SMOOTH);
      if (vo.car) vo.osc.frequency.setValueAtTime(sirenFreq(time, vo.car.sirenOffset, half), now);
    }
  }

  // ---------- 警員 ----------
  function markKilled(actor) {
    const o = actor && actor.officer;
    if (o && officers.has(o)) o.killed = true;
  }

  if (combat && typeof combat.on === 'function') {
    // 子彈 / 車撞把 hp 打到 0 = 擊斃（拳 / 棒打到 0 只倒地，recoverOnKo）
    offs.push(
      combat.on('knockdown', (e) => {
        if (e && e.target && e.target.officer && e.target.hp <= 0 && e.cause !== 'punch' && e.cause !== 'bat') markKilled(e.target);
      }),
    );
    offs.push(combat.on('dead', (e) => markKilled(e && e.target)));
  }
  if (bus && typeof bus.on === 'function') offs.push(bus.on('ped:dead', (e) => markKilled(e && e.ped)));
  if (pw && typeof pw.onAfterStep === 'function') {
    // 倒地剛體的落穩判定須逐物理子步累計（同 traffic _afterStep）
    offs.push(
      pw.onAfterStep((h) => {
        for (const o of officers) if (o.body && o.body.down) o.settle = o.body.settleCheck(h);
      }),
    );
  }

  function spawnOfficer({ x, z, car = null, swat = false } = {}) {
    // CharacterAnimator 必要：combat.register 會直接呼叫 actor.anim.on
    if (disposed || !characters || typeof characters.createCharacter !== 'function' || typeof characters.CharacterAnimator !== 'function') return null;
    const character = characters.createCharacter({ variant: OFFICER_VARIANT, colors: swat ? SWAT_COLORS : UNIFORM_COLORS });
    if (!character) return null;
    const mesh = character.root;
    if (mesh.rotation) mesh.rotation.order = 'YXZ';
    const anim = new characters.CharacterAnimator(character, characters.clips || []);
    const pl = getPlayer();
    const yaw = pl ? Math.atan2(pl.x - x, pl.z - z) : 0;
    const y = groundY(x, z);
    const o = {
      id: `police-officer-${++seq}`,
      police: true,
      swat: !!swat,
      pos: { x, y, z },
      yaw,
      car,
      character,
      mesh,
      anim,
      body: null,
      actor: null,
      target: { x, z, run: false },
      aimYaw: null,
      aimUntil: -Infinity,
      moveSpeed: 0,
      settle: { settled: false, clearToStand: false },
      shots: 0,
      hits: 0,
      killed: false,
      removed: false,
      down: false,
      get alive() {
        return !o.killed && !o.removed;
      },
    };
    if (physics && physics.RAPIER && pw) {
      o.body = createPedestrianBody(physics.RAPIER, pw, { x, y, z, yaw }, { groups: physics.groups || null, router: physics.router || null });
      o.body.owner = o; // traffic 的 onVehicleHitPedestrian 以 ped.owner.actor 轉給 combat（車撞倒地 / 致死）
    }
    o.actor = {
      id: o.id,
      kind: 'pedestrian',
      faction: 'police',
      pos: o.pos,
      yaw,
      hp: swat ? OFFICER_HP * SWAT_TOUGHNESS : OFFICER_HP,
      maxHp: swat ? OFFICER_HP * SWAT_TOUGHNESS : OFFICER_HP,
      anim,
      recoverOnKo: true,
      officer: o,
      body: {
        knockdown: (impulse) => {
          if (!o.body) return;
          const j = Math.hypot(impulse.x, impulse.y, impulse.z);
          const h = Math.hypot(impulse.x, impulse.z);
          const dir = h > 1e-6 ? { x: impulse.x / h, y: 0, z: impulse.z / h } : { x: -Math.sin(o.yaw), y: 0, z: -Math.cos(o.yaw) };
          o.yaw = Math.atan2(-dir.x, -dir.z); // 面向衝量來向（倒地動作往後躺）
          o.body.hit({ impulse: j, dir });
          o.settle = { settled: false, clearToStand: false };
        },
        settleCheck: () => (o.body ? o.settle : { settled: true, clearToStand: true }),
        standUp: () => {
          if (!o.body) return;
          const stand = o.body.recover(o.yaw);
          if (stand) {
            o.pos.x = stand.x;
            o.pos.y = stand.y;
            o.pos.z = stand.z;
          }
        },
      },
    };
    if (combat && typeof combat.register === 'function') combat.register(o.actor);
    if (scene) scene.add(mesh); // register 成功後才加入場景（例外時不殘留網格）
    officers.add(o);
    placeOfficerMesh(o);
    return o;
  }

  function despawnOfficer(o) {
    if (!o || o.removed) return;
    o.removed = true;
    officers.delete(o);
    if (combat && typeof combat.unregister === 'function') combat.unregister(o.actor);
    if (o.body) {
      o.body.dispose();
      o.body = null;
    }
    if (characters && typeof characters.disposeCharacter === 'function') characters.disposeCharacter(o.character);
    else if (o.mesh && typeof o.mesh.removeFromParent === 'function') o.mesh.removeFromParent();
  }

  function moveOfficer(o, { x, z, run = false } = {}) {
    if (!o || o.removed) return;
    o.target.x = x;
    o.target.z = z;
    o.target.run = !!run;
  }

  function officerAim(o, { x, z, firing = false } = {}) {
    if (!o || o.removed || o.down) return;
    o.aimYaw = Math.atan2(x - o.pos.x, z - o.pos.z);
    o.aimUntil = time + AIM_HOLD;
    if (firing) fire(o, x, z);
  }

  function fire(o, tx, tz) {
    const hit = shoot(o.pos.x, o.pos.y + MUZZLE_HEIGHT, o.pos.z, tx, tz, { attacker: o.actor, shooter: o, damage: o.swat ? SWAT_SHOT_DAMAGE : SHOT_DAMAGE, mult: 1 });
    o.shots++;
    if (hit) o.hits++;
    if (o.anim && typeof o.anim.playUpper === 'function') o.anim.playUpper('pistol_fire');
  }

  // 車上警察開槍（police.js 決定時機）：槍口在車頂，命中率 × CAR_HIT_MULT
  function carFire(car, { x, z } = {}) {
    if (!car || car.removed || car.stolen || !carAlive(car)) return;
    const p = car.v.pos;
    const hit = shoot(p.x, (p.y || 0) + CAR_MUZZLE_HEIGHT, p.z, x, z, { attacker: null, shooter: car, damage: CAR_SHOT_DAMAGE, mult: CAR_HIT_MULT });
    car.shots = (car.shots || 0) + 1;
    if (hit) car.hits = (car.hits || 0) + 1;
  }

  // 共用射擊：命中率 hitChance(水平距離, 玩家速度) × mult；玩家在車內走 throughVehicle 並扣車耐久；回傳是否實際命中
  function shoot(mx, my, mz, tx, tz, { attacker, shooter, damage, mult }) {
    const pl = getPlayer();
    const d = dist(mx, mz, tx, tz);
    const hit = rng() < hitChance(d, pl && pl.speed) * mult;
    let applied = null;
    const dx = tx - mx;
    const dz = tz - mz;
    const h = Math.hypot(dx, dz) || 1;
    const inCar = !!(pl && pl.inVehicle);
    if (hit && pl && pl.actor && combat && typeof combat.applyHit === 'function') {
      applied = combat.applyHit({
        attacker,
        target: pl.actor,
        damage,
        weapon: 'pistol',
        dir: { x: dx / h, z: dz / h },
        swingId: typeof combat.newSwingId === 'function' ? combat.newSwingId() : null,
        throughVehicle: inCar,
      });
      if (applied && inCar && pl.vehicle && typeof damageVehicle === 'function') damageVehicle(pl.vehicle, CAR_HIT_VEHICLE_DAMAGE);
    }
    if (!bus) return !!applied;
    // 落點：命中 = 目標胸口；未命中 = 目標旁 MISS_SPREAD 內偏移
    const side = (rng() * 2 - 1) * MISS_SPREAD;
    const ex = hit ? tx : tx + (-dz / h) * side;
    const ez = hit ? tz : tz + (dx / h) * side;
    const ey = groundY(tx, tz) + CHEST_HEIGHT;
    const len = Math.hypot(ex - mx, ey - my, ez - mz) || 1;
    bus.emit('weapon:fire', {
      weapon: 'pistol', x: mx, y: my, z: mz,
      dirX: (ex - mx) / len, dirY: (ey - my) / len, dirZ: (ez - mz) / len,
      byPlayer: false, police: true, shooter, hit: !!applied, miss: !hit, ex, ey, ez, dist: len,
    });
    return !!applied;
  }

  // ---------- 路障 ----------
  function vehicleNear(x, z, gap) {
    const g2 = gap * gap;
    if (vehicles) for (const v of vehicles.vehicles) if ((v.pos.x - x) ** 2 + (v.pos.z - z) ** 2 < g2) return true;
    if (traffic && traffic.cars) {
      for (const c of traffic.cars) {
        const p = c.v ? c.v.pos : c.pos;
        if (p && (p.x - x) ** 2 + (p.z - z) ** 2 < g2) return true;
      }
    }
    return false;
  }

  // 路障中心 (x, z)、玩家來向 heading（yaw：forward = (sin, cos)）→ 車位是否可用
  function roadblockFits(x, z, heading) {
    const px = Math.cos(heading);
    const pz = -Math.sin(heading);
    for (const s of [-1, 0, 1]) {
      const cx = x + px * ROADBLOCK_CAR_GAP * s;
      const cz = z + pz * ROADBLOCK_CAR_GAP * s;
      if (blocked && blocked(cx, cz)) return false;
      if (s !== 0 && vehicleNear(cx, cz, ROADBLOCK_CLEAR)) return false;
    }
    return true;
  }

  function findRoadblockPoint(px, pz, dirX, dirZ, minDist, maxDist) {
    if (disposed) return null;
    const dl = Math.hypot(dirX, dirZ);
    if (!(dl > 1e-6)) return null;
    const fx = dirX / dl;
    const fz = dirZ / dl;
    const cosMin = Math.cos(ROADBLOCK_HALF_ANGLE);
    const mid = (minDist + maxDist) / 2;
    let best = null;
    let bestScore = -Infinity;
    const consider = (x, z) => {
      const vx = x - px;
      const vz = z - pz;
      const d = Math.hypot(vx, vz);
      if (d < minDist || d > maxDist) return;
      const c = (vx * fx + vz * fz) / d;
      if (c < cosMin) return;
      const score = c - (Math.abs(d - mid) / maxDist) * 0.5;
      if (score <= bestScore) return;
      // 從路口中心往玩家側退 ROADBLOCK_SETBACK（擋在來向的路段上）
      const bx = x - (vx / d) * ROADBLOCK_SETBACK;
      const bz = z - (vz / d) * ROADBLOCK_SETBACK;
      const heading = Math.atan2(vx, vz);
      if (!roadblockFits(bx, bz, heading)) return;
      bestScore = score;
      best = { x: bx, z: bz, heading };
    };
    if (graph && !junctions) junctions = graphJunctions(graph);
    if (junctions && junctions.n) {
      for (let i = 0; i < junctions.n; i++) consider(junctions.x[i], junctions.z[i]);
    } else if (traffic && typeof traffic.spawnSpots === 'function') {
      for (const sp of traffic.spawnSpots(px, pz, minDist, maxDist, spotBuf) || []) consider(sp.x, sp.z);
    }
    return best;
  }

  function takeCone() {
    let c = conePool.find((k) => !k.used);
    if (!c) {
      if (conePool.length >= MAX_CONES || typeof createCone !== 'function') return null;
      const obj = createCone();
      if (!obj) return null;
      if (scene) scene.add(obj);
      c = { obj, used: false };
      conePool.push(c);
    }
    c.used = true;
    c.obj.visible = true;
    return c;
  }

  function spawnRoadblock({ x, z, heading = 0 } = {}) {
    if (disposed || !vehicles || roadblocks.size >= MAX_ROADBLOCK_SETS) return null;
    const px = Math.cos(heading);
    const pz = -Math.sin(heading);
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const rb = { id: `police-roadblock-${++seq}`, roadblock: true, pos: { x, z }, heading, cars: [], cones: [], removed: false };
    for (const s of [-1, 1]) {
      const cx = x + px * ROADBLOCK_CAR_GAP * s;
      const cz = z + pz * ROADBLOCK_CAR_GAP * s;
      // 橫停：車身長軸垂直來向，兩台車頭相反
      const v = vehicles.adopt({ type: POLICE_TYPE, x: cx, z: cz, yaw: heading + (s * Math.PI) / 2 });
      if (!v) continue;
      v.ai = false; // 一般停放車：靜止後 kinematic，可被撞開 / 搶走
      if (dmg && typeof dmg.attach === 'function') dmg.attach(v);
      const car = {
        id: `police-block-car-${++seq}`, police: true, roadblock: true, v, lightbar: takeLightbar(v), stolen: false, removed: false, dead: false,
        get pos() {
          return v.pos;
        },
        get alive() {
          return carAlive(car);
        },
      };
      v.setControls({ throttle: 0, steer: 0, brake: 1, handbrake: true });
      byVehicle.set(v, car);
      blockCars.add(car);
      rb.cars.push(car);
      setLightbar(car, lightbarPhase(time), isNight());
    }
    if (!rb.cars.length) return null;
    for (const [lat, back] of ROADBLOCK_CONES) {
      const c = takeCone();
      if (!c) break;
      const cx = x + px * lat - fx * back;
      const cz = z + pz * lat - fz * back;
      if (c.obj.position) c.obj.position.set(cx, groundY(cx, cz) + surfaceOffset, cz);
      rb.cones.push(c);
    }
    Object.defineProperty(rb, 'alive', { get: () => !rb.removed && rb.cars.some((c) => carAlive(c)) });
    roadblocks.add(rb);
    return rb;
  }

  function despawnRoadblock(rb) {
    if (!rb || rb.removed) return;
    rb.removed = true;
    roadblocks.delete(rb);
    for (const car of rb.cars) {
      blockCars.delete(car);
      if (car.removed) continue;
      car.removed = true;
      if (car.stolen) continue; // 被搶的留給玩家，警示燈由 stolen 清單繼續閃
      byVehicle.delete(car.v);
      if (vehicleExists(car.v)) {
        if (dmg && typeof dmg.detach === 'function') dmg.detach(car.v);
        vehicles.remove(car.v);
      }
      releaseLightbar(car);
    }
    for (const c of rb.cones) {
      c.used = false;
      c.obj.visible = false;
    }
    rb.cones.length = 0;
  }

  function placeOfficerMesh(o) {
    const m = o.mesh;
    if (!m || !m.position) return;
    m.position.set(o.pos.x, o.pos.y + surfaceOffset, o.pos.z);
    m.rotation.set(0, o.yaw, 0);
  }

  function updateOfficer(o, dt) {
    const state = combat && typeof combat.stateOf === 'function' ? combat.stateOf(o.actor) : 'normal';
    o.down = o.killed || (combat && typeof combat.isDown === 'function' ? combat.isDown(o.actor) : false);
    o.moveSpeed = 0;
    if (o.body && o.body.down) {
      // 倒地：位置跟剛體（角色原點 = 膠囊底部）
      const t = o.body.body.translation();
      o.pos.x = t.x;
      o.pos.y = t.y - o.body.centerY;
      o.pos.z = t.z;
    } else if (!o.down && state !== 'hit') {
      const p = o.pos;
      const tg = o.target;
      const dx = tg.x - p.x;
      const dz = tg.z - p.z;
      const d = Math.hypot(dx, dz);
      let faceYaw = time < o.aimUntil && o.aimYaw !== null ? o.aimYaw : null;
      if (d > ARRIVE_EPS) {
        const step = Math.min(d, (tg.run ? RUN_SPEED : WALK_SPEED) * dt);
        let nx = p.x + (dx / d) * step;
        let nz = p.z + (dz / d) * step;
        if (blocked && blocked(nx, nz)) {
          // 沿牆滑動：只走 x 或只走 z
          if (!blocked(nx, p.z)) nz = p.z;
          else if (!blocked(p.x, nz)) nx = p.x;
          else {
            nx = p.x;
            nz = p.z;
          }
        }
        const moved = Math.hypot(nx - p.x, nz - p.z);
        o.moveSpeed = dt > 0 ? moved / dt : 0;
        if (moved > 1e-6 && faceYaw === null) faceYaw = Math.atan2(nx - p.x, nz - p.z);
        p.x = nx;
        p.z = nz;
      }
      p.y = groundY(p.x, p.z);
      if (faceYaw !== null) o.yaw += wrapAngle(faceYaw - o.yaw) * Math.min(1, TURN_RATE * dt);
      if (o.body) o.body.setPose(p.x, p.y, p.z, o.yaw);
    }
    o.actor.yaw = o.yaw;
    if (o.anim) o.anim.update(dt, { speed: o.moveSpeed });
    placeOfficerMesh(o);
  }

  // ---------- 每幀 ----------
  function update(dt, { stars = 0, listener = null, paused = false } = {}) {
    if (disposed) return;
    dt = Math.max(0, Math.min(DT_MAX, Number(dt) || 0));
    time += dt;
    const phase = lightbarPhase(time);
    const night = !!isNight();
    for (const car of [...cars]) {
      if (!car.stolen && car.v.driven) {
        // 玩家上車 = 搶走：交還一般車輛（可停放 / 遠距休眠），police 下一幀看到 alive false 後移出名單
        car.stolen = true;
        car.v.ai = false;
        stolen.add(car);
        releaseVoice(car);
      }
      setLightbar(car, phase, night);
      if (car.stolen) continue;
      if (carAlive(car)) {
        if (paused) brakeCar(car); // 暫停 / 手機開啟（police 不下指令）：凍結控制，不續倒車 / 全油門
        else controlCar(car, dt);
      } else if (!car.dead && vehicleExists(car.v)) {
        // 耐久歸 0：煞停一次並交還一般車輛（可停放 / 休眠），殘骸不再沿用最後一次油門
        car.dead = true;
        car.v.ai = false;
        car.v.setControls({ throttle: 0, steer: 0, brake: 1, handbrake: true });
      }
    }
    for (const car of blockCars) {
      if (!car.stolen && car.v.driven) {
        car.stolen = true;
        stolen.add(car);
        continue;
      }
      if (car.stolen) continue;
      setLightbar(car, phase, night);
    }
    for (const car of [...stolen]) {
      if (!vehicleExists(car.v)) {
        stolen.delete(car);
        byVehicle.delete(car.v);
        releaseLightbar(car);
        continue;
      }
      setLightbar(car, phase, night);
    }
    updateSirens(stars, listener || getPlayer(), paused);
    for (const o of officers) updateOfficer(o, dt);
  }

  function isPoliceVehicle(v) {
    return byVehicle.has(v);
  }

  function dispose() {
    if (disposed) return;
    for (const rb of [...roadblocks]) despawnRoadblock(rb);
    for (const c of conePool.splice(0)) if (c.obj.removeFromParent) c.obj.removeFromParent();
    for (const o of [...officers]) despawnOfficer(o);
    for (const car of [...cars]) despawnCar(car);
    stolen.clear();
    stopVoices();
    for (const off of offs.splice(0)) if (typeof off === 'function') off();
    disposed = true;
  }

  function stats() {
    return {
      cars: cars.size, stolen: stolen.size, officers: officers.size, sirens: voices.filter((v) => v.car).length,
      roadblocks: roadblocks.size, blockCars: blockCars.size, cones: conePool.filter((c) => c.used).length,
    };
  }

  return {
    // 契約 B adapters
    findSpawnPoint,
    spawnCar,
    despawnCar,
    driveCar,
    spawnOfficer,
    despawnOfficer,
    moveOfficer,
    officerAim,
    canSee,
    // V5
    carFire,
    spawnSwat,
    findRoadblockPoint,
    spawnRoadblock,
    despawnRoadblock,
    // 整合層
    update,
    isPoliceVehicle,
    stats,
    dispose,
  };
}
