// 警力大腦（Phase 7 契約 B）：依通緝星數管理警車 / 警員的生成、追捕、視線、開槍與逮捕
// 用法：const police = createPolice({ bus, wanted, adapters, rng })；主迴圈每幀
//   const { seen } = police.update(dt, { player: { x, z, inVehicle, speed, down } }); wanted.update(dt, { playerX, playerZ, seen })
// 只透過 adapters 操作世界（不 import traffic / vehicle / navigation / combat）；星數一律讀注入的 wanted（stars / state / searchCircle）
// - 0 星：維持 MAX_CARS[0] 台巡邏車在玩家 PATROL_MIN–PATROL_MAX 環狀內 patrol；離玩家 > RECYCLE_DIST 回收、下一幀重生
// - ≥1 星：補車到 MAX_CARS[stars]（每幀至多補 1 台，findSpawnPoint 失敗冷卻 SPAWN_RETRY 秒）；active 開向玩家、searching 開向搜索圈內隨機點；
//   ≥RAM_STARS 星且玩家在車上、距 ≤ RAM_DIST → ram；玩家步行且距 ≤ DEPLOY_DIST → stop（停車放人）
// - 警車距玩家 ≤ DEPLOY_DIST 且車速 < DEPLOY_SPEED → 放 OFFICERS_PER_CAR 名警員（總數 ≤ MAX_OFFICERS[stars]）；有未倒地警員在外時車停著等
// - 警員：active 時跑向玩家；≥FIRE_STARS 星、距 FIRE_MIN–FIRE_MAX 且看得見 → 停下瞄準，間隔 FIRE_INTERVAL_MIN–MAX 秒開槍（emit police:shoot）；
//   非 active / 玩家開車跑遠（> REBOARD_DIST）/ 步行跑太遠（> CHASE_GIVEUP）→ 跑回自己的車，BOARD_DIST 內上車（despawn）
// - 逮捕：步行未倒地、未倒地警員 ≤ BUST_DIST → bustProgress 以 1/BUST_TIME 每秒累加；車上車速 < BUST_CAR_SPEED、警員 ≤ BUST_CAR_DIST → 1/BUST_CAR_TIME；
//   條件中斷每秒衰減 BUST_DECAY；滿 1 emit police:bust（直到 wanted:cleared 或回 0 星前只發一次）
// - 減星 / wanted:cleared：超出 MAX_CARS / MAX_OFFICERS 的警力標記回收，回收時刻在 RECALL_SEC 內依遠近錯開，
//   到時且「離開玩家視線」（距 > DESPAWN_VIEW_DIST 或 canSee=false）才 despawn；回收中的車一律 patrol
// - 死亡（!alive）的車 / 警員立刻從 cars / officers 移除，殘骸同樣等離開玩家視線才 despawn
// V5 警方升級（adapters 未提供對應函式時該功能關閉，行為同 Phase 7）：
// - 車上開槍：≥FIRE_STARS 星、active、追捕中（沒有警員在外等）的警車距玩家 CAR_FIRE_MIN–CAR_FIRE_MAX 且看得見 →
//   每 CAR_FIRE_INTERVAL_MIN–MAX 秒 adapters.carFire(car, { x, z })，emit police:carshoot（police:shoot 仍只代表下車警員）
// - 命中率速度係數 speedHitFactor(玩家速度)：adapters / helicopter 共用（玩家越快越難打中）
// - 路障（≥ROADBLOCK_STARS 星、active）：每 ROADBLOCK_INTERVAL 秒至多 1 組、同時 ≤ MAX_ROADBLOCKS 組；
//   adapters.findRoadblockPoint(px, pz, dirX, dirZ, ROADBLOCK_MIN, ROADBLOCK_MAX) → 玩家前進方向的路口 → adapters.spawnRoadblock；
//   玩家已通過（在其後方 > ROADBLOCK_PASSED）/ 距離 > ROADBLOCK_RECYCLE / 星數不足 / 解除通緝 → 離開玩家視線即 despawnRoadblock；emit police:roadblock
//   （searching 只停止生成、既有路障保留——回 active 不重生）
// - 特警（≥SWAT_STARS 星）：至多 1 台 adapters.spawnSwat（不佔 MAX_CARS），比照警車追捕，靠近停車放 SWAT_OFFICERS 名特警
//   （spawnOfficer({ swat: true })，不佔 MAX_OFFICERS）；星數不足 / 解除 → 全員回收（同一般回收規則）；回收中重回 SWAT_STARS → 取消回收（孤兒除外）；emit police:swat
// - 玩家倒地（player.down：KO / BUSTED / WASTED 畫面）：車上警察與下車警員都不開槍
// - cancelExtras()：開新局 / 回主選單時立即回收路障與特警（含特警車被毀後的孤兒特警、特警車殘骸；不等離開視線）

export const MAX_CARS = [1, 2, 3, 4, 5, 6]; // 依星數；0 星 = 1 台巡邏車
export const MAX_OFFICERS = [0, 2, 4, 6, 8, 10];
export const DT_MAX = 0.1; // s，dt clamp

export const PATROL_MIN = 120; // m，0 星巡邏車環帶內徑
export const PATROL_MAX = 250; // m，0 星巡邏車環帶外徑
export const RECYCLE_DIST = 350; // m，超過即回收重生
export const SPAWN_MIN = 160; // m，≥1 星補車距離下限
export const SPAWN_MAX = 260; // m，≥1 星補車距離上限
export const SPAWN_RETRY = 1; // s，findSpawnPoint / spawnCar 失敗後的冷卻
export const WAYPOINT_ARRIVE = 15; // m，巡邏 / 搜索目標點抵達半徑（換下一點）

export const PATROL_SPEED = 10; // m/s
export const PURSUE_SPEED = 24; // m/s
export const SEARCH_SPEED = 14; // m/s
export const RAM_SPEED = 28; // m/s
export const RAM_STARS = 3; // 幾星起改 ram
export const RAM_DIST = 25; // m

export const SEE_ACTIVE = 70; // m，active（及 clear）時的視線距離
export const SEE_SEARCH = 45; // m，searching 時的視線距離
export const WITNESS_DIST = 45; // m，witness() 距離
export const DESPAWN_VIEW_DIST = 120; // m，回收時「仍在玩家視線內」的距離上限（超過或 canSee=false 才可 despawn）

export const DEPLOY_DIST = 20; // m，放警員的距離
export const DEPLOY_SPEED = 3; // m/s，放警員的車速上限
export const OFFICERS_PER_CAR = 2;
export const DEPLOY_OFFSET = 1.6; // m，警員下車點在車身側邊的距離
export const OFFICER_STOP_DIST = 1.0; // m，跑到玩家這麼近就停（逮捕距離內）
export const REBOARD_DIST = 40; // m，玩家開車跑出此距離 → 警員回車
export const CHASE_GIVEUP = 80; // m，玩家步行跑出此距離 → 警員回車
export const BOARD_DIST = 2; // m，警員到車旁這麼近即上車

export const FIRE_STARS = 3; // 幾星起開槍
export const FIRE_MIN = 8; // m
export const FIRE_MAX = 30; // m
export const FIRE_INTERVAL_MIN = 0.9; // s
export const FIRE_INTERVAL_MAX = 1.5; // s
export const MUZZLE_HEIGHT = 1.4; // m，police:shoot 的 y（officer.pos.y + 此值）

export const BUST_DIST = 1.6; // m，步行逮捕距離
export const BUST_TIME = 1.5; // s
export const BUST_CAR_DIST = 2.5; // m，車上逮捕距離
export const BUST_CAR_TIME = 2.5; // s
export const BUST_CAR_SPEED = 1; // m/s，車上逮捕的車速上限
export const BUST_DECAY = 1; // bustProgress 每秒衰減量

export const RECALL_SEC = 20; // s，減星 / 解除後逐步回收到目標配置的時限

// V5：車上開槍、命中率速度係數
export const CAR_FIRE_MIN = 6; // m
export const CAR_FIRE_MAX = 35; // m
export const CAR_FIRE_INTERVAL_MIN = 1.2; // s
export const CAR_FIRE_INTERVAL_MAX = 2.0; // s
export const HIT_SPEED_REF = 30; // m/s，玩家速度達此值時命中率降到 HIT_SPEED_FLOOR 倍
export const HIT_SPEED_FLOOR = 0.35;

// V5：路障 / 特警
export const ROADBLOCK_STARS = 5;
export const MAX_ROADBLOCKS = 2; // 同時組數上限
export const ROADBLOCK_MIN = 150; // m，玩家前方生成距離
export const ROADBLOCK_MAX = 250; // m
export const ROADBLOCK_INTERVAL = 12; // s，兩組路障生成的最短間隔
export const ROADBLOCK_RETRY = 3; // s，找不到路口時的冷卻
export const ROADBLOCK_PASSED = 60; // m，玩家已越過路障此距離 → 可回收
export const ROADBLOCK_RECYCLE = 400; // m，太遠即回收
export const HEADING_SAMPLE = 4; // m，玩家位移超過此值才更新前進方向
export const SWAT_STARS = 5;
export const MAX_SWAT = 1; // 特警車上限
export const SWAT_OFFICERS = 4;
export const SWAT_RETRY = 6; // s，特警車生成失敗的冷卻
export const SWAT_RESPAWN = 30; // s，特警車被毀 / 回收後多久才再派
export const SWAT_DEPLOY_OFFSETS = [
  [1, 0.8],
  [-1, 0.8],
  [1, -0.8],
  [-1, -0.8],
]; // 特警下車點（側向 × DEPLOY_OFFSET, 縱向 × 2 m）

// 玩家速度 → 命中率係數：0 m/s = 1，線性降到 HIT_SPEED_REF 時 HIT_SPEED_FLOOR（之後夾住）
export function speedHitFactor(speed) {
  const s = Math.abs(Number(speed) || 0);
  return Math.max(HIT_SPEED_FLOOR, 1 - ((1 - HIT_SPEED_FLOOR) * s) / HIT_SPEED_REF);
}

const MAX_STARS = MAX_CARS.length - 1;
const NOOP = () => {};

function dist(ax, az, bx, bz) {
  return Math.hypot(ax - bx, az - bz);
}

export function createPolice({ bus, wanted, adapters = {}, rng = Math.random, config = {} } = {}) {
  const a = {
    findSpawnPoint: () => null,
    spawnCar: () => null,
    despawnCar: NOOP,
    driveCar: NOOP,
    spawnOfficer: () => null,
    despawnOfficer: NOOP,
    moveOfficer: NOOP,
    officerAim: NOOP,
    canSee: () => true,
    carFire: NOOP,
    findRoadblockPoint: () => null,
    spawnRoadblock: () => null,
    despawnRoadblock: NOOP,
    spawnSwat: null,
    ...adapters,
  };
  const recallSec = config.recallSec ?? RECALL_SEC;

  const cars = []; // 對外：car 物件（adapter 回傳）
  const officers = []; // 對外：officer 物件
  const carRec = new Map(); // car → { car, recallAt, waypoint, officers: Set<officerRec> }
  const offRec = new Map(); // officer → { officer, car: carRec|null, fireTimer, recallAt, orphan }
  const wrecks = []; // { obj, kind: 'car'|'officer' } 已死亡、等離開視線再 despawn
  let time = 0;
  let spawnCooldown = 0;
  let bustProgress = 0;
  let busted = false;
  let disposed = false;
  const player = { x: 0, z: 0, inVehicle: false, speed: 0, down: false };
  const roadblocks = []; // { obj, recall }（obj = adapters.spawnRoadblock 回傳，含 pos）
  let roadblockCooldown = 0;
  let swat = null; // 特警車 carRec（rec.swat = true）
  let swatCooldown = 0;
  const heading = { x: 0, z: 0, ok: false, ax: 0, az: 0, anchored: false }; // 玩家前進方向（位移取樣）
  const emitEvt = (name, payload) => {
    if (bus) bus.emit(name, payload);
  };

  const unsub = [];
  if (bus) {
    unsub.push(
      bus.on('wanted:cleared', () => {
        busted = false;
        bustProgress = 0;
      }),
    );
  }

  const interval = () => FIRE_INTERVAL_MIN + rng() * (FIRE_INTERVAL_MAX - FIRE_INTERVAL_MIN);
  const curStars = () => Math.max(0, Math.min(MAX_STARS, Math.floor((wanted && wanted.stars) || 0)));
  const curState = () => (wanted && wanted.state) || 'clear';
  const usable = (o) => o && o.alive !== false && !o.down;

  // 玩家是否還看得到該位置（決定能否 despawn）
  function inPlayerView(pos) {
    if (dist(pos.x, pos.z, player.x, player.z) > DESPAWN_VIEW_DIST) return false;
    return !!a.canSee(player.x, player.z, pos.x, pos.z);
  }

  // 環帶內隨機點（巡邏 / 搜索目標）
  function ringPoint(cx, cz, rMin, rMax) {
    const ang = rng() * Math.PI * 2;
    const r = rMin + Math.sqrt(rng()) * (rMax - rMin);
    return { x: cx + Math.cos(ang) * r, z: cz + Math.sin(ang) * r };
  }

  function removeCar(rec, despawn) {
    if (rec === swat) {
      swat = null;
      swatCooldown = SWAT_RESPAWN;
      emitEvt('police:swat', { type: 'despawn', x: rec.car.pos.x, z: rec.car.pos.z });
    }
    const i = cars.indexOf(rec.car);
    if (i >= 0) cars.splice(i, 1);
    carRec.delete(rec.car);
    for (const o of rec.officers) {
      o.car = null; // 留在外面的警員變孤兒，之後自行回收
      o.orphan = true; // 孤兒不可被 planRecall 叫回（否則永不 despawn、佔住名額）
    }
    rec.officers.clear();
    if (despawn) a.despawnCar(rec.car);
  }

  function removeOfficer(rec, despawn) {
    const i = officers.indexOf(rec.officer);
    if (i >= 0) officers.splice(i, 1);
    offRec.delete(rec.officer);
    if (rec.car) rec.car.officers.delete(rec);
    if (despawn) a.despawnOfficer(rec.officer);
  }

  // 依遠近（遠的先）為超出目標數的成員排定回收時刻，或在星數回升時取消回收
  function planRecall(recs, target, posOf) {
    const keep = recs.filter((r) => r.recallAt === null);
    const recalled = recs.filter((r) => r.recallAt !== null && !r.orphan); // 孤兒沒車可回，回收不可取消
    if (keep.length < target) {
      // 星數回升：先把回收中的叫回來
      for (const r of recalled.slice(0, target - keep.length)) r.recallAt = null;
      return;
    }
    if (keep.length === target) return;
    const extra = keep
      .map((r) => ({ r, d: dist(posOf(r).x, posOf(r).z, player.x, player.z) }))
      .sort((p, q) => q.d - p.d)
      .slice(0, keep.length - target);
    const n = extra.length;
    extra.forEach(({ r }, k) => {
      r.recallAt = time + (recallSec * (k + 1)) / (n + 1);
    });
  }

  function trySpawnCar(stars) {
    if (spawnCooldown > 0) return;
    const [rMin, rMax] = stars === 0 ? [PATROL_MIN, PATROL_MAX] : [SPAWN_MIN, SPAWN_MAX];
    const sp = a.findSpawnPoint(player.x, player.z, rMin, rMax);
    const car = sp ? a.spawnCar({ x: sp.x, z: sp.z, heading: sp.heading ?? 0 }) : null;
    if (!car) {
      spawnCooldown = SPAWN_RETRY;
      return;
    }
    cars.push(car);
    carRec.set(car, { car, recallAt: null, waypoint: null, officers: new Set(), fireTimer: carInterval(), swat: false });
  }

  const carInterval = () => CAR_FIRE_INTERVAL_MIN + rng() * (CAR_FIRE_INTERVAL_MAX - CAR_FIRE_INTERVAL_MIN);
  const regularOfficers = () => {
    let n = 0;
    for (const r of offRec.values()) if (!r.swat) n++;
    return n;
  };

  // 特警車：不佔 MAX_CARS；生成點同一般警車環帶
  function trySpawnSwat() {
    if (swatCooldown > 0 || typeof a.spawnSwat !== 'function') return;
    const sp = a.findSpawnPoint(player.x, player.z, SPAWN_MIN, SPAWN_MAX);
    const car = sp ? a.spawnSwat({ x: sp.x, z: sp.z, heading: sp.heading ?? 0 }) : null;
    if (!car) {
      swatCooldown = SWAT_RETRY;
      return;
    }
    cars.push(car);
    swat = { car, recallAt: null, waypoint: null, officers: new Set(), fireTimer: carInterval(), swat: true, lost: 0 };
    carRec.set(car, swat);
    emitEvt('police:swat', { type: 'spawn', x: car.pos.x, z: car.pos.z });
  }

  function deploySwat(rec) {
    const c = rec.car.pos;
    const dx = player.x - c.x;
    const dz = player.z - c.z;
    const len = Math.hypot(dx, dz) || 1;
    const sx = -dz / len;
    const sz = dx / len;
    const n = SWAT_OFFICERS - rec.lost; // 殉職的不補
    for (let k = 0; k < n && k < SWAT_DEPLOY_OFFSETS.length; k++) {
      const [side, fwd] = SWAT_DEPLOY_OFFSETS[k];
      const x = c.x + sx * side * DEPLOY_OFFSET + (dx / len) * fwd * 2;
      const z = c.z + sz * side * DEPLOY_OFFSET + (dz / len) * fwd * 2;
      const o = a.spawnOfficer({ x, z, car: rec.car, swat: true });
      if (!o) break;
      const r = { officer: o, car: rec, fireTimer: interval(), recallAt: null, orphan: false, swat: true };
      officers.push(o);
      offRec.set(o, r);
      rec.officers.add(r);
    }
    emitEvt('police:swat', { type: 'deploy', x: c.x, z: c.z, officers: rec.officers.size });
  }

  // 玩家前進方向：位移超過 HEADING_SAMPLE 才更新（與幀率無關）；player.dirX / dirZ（車頭方向）優先
  function updateHeading(pl) {
    if (pl && Number.isFinite(pl.dirX) && Number.isFinite(pl.dirZ) && Math.hypot(pl.dirX, pl.dirZ) > 1e-6) {
      const l = Math.hypot(pl.dirX, pl.dirZ);
      heading.x = pl.dirX / l;
      heading.z = pl.dirZ / l;
      heading.ok = true;
    }
    if (!heading.anchored) {
      heading.ax = player.x;
      heading.az = player.z;
      heading.anchored = true;
      return;
    }
    const dx = player.x - heading.ax;
    const dz = player.z - heading.az;
    const d = Math.hypot(dx, dz);
    if (d < HEADING_SAMPLE) return;
    if (!(pl && Number.isFinite(pl.dirX))) {
      heading.x = dx / d;
      heading.z = dz / d;
      heading.ok = true;
    }
    heading.ax = player.x;
    heading.az = player.z;
  }

  function removeRoadblock(i) {
    const rb = roadblocks[i];
    roadblocks.splice(i, 1);
    a.despawnRoadblock(rb.obj);
    emitEvt('police:roadblock', { type: 'despawn', x: rb.obj.pos.x, z: rb.obj.pos.z });
  }

  function updateRoadblocks(stars, state) {
    const want = stars >= ROADBLOCK_STARS && state === 'active';
    for (let i = roadblocks.length - 1; i >= 0; i--) {
      const rb = roadblocks[i];
      const p = rb.obj.pos;
      const d = dist(p.x, p.z, player.x, player.z);
      const behind = heading.ok && (p.x - player.x) * heading.x + (p.z - player.z) * heading.z < -ROADBLOCK_PASSED;
      if (stars < ROADBLOCK_STARS || state === 'clear' || behind || rb.obj.alive === false) rb.recall = true;
      if (d > ROADBLOCK_RECYCLE || (rb.recall && !inPlayerView(p))) removeRoadblock(i);
    }
    if (!want || roadblockCooldown > 0 || !heading.ok) return;
    if (roadblocks.length >= MAX_ROADBLOCKS) return;
    const pt = a.findRoadblockPoint(player.x, player.z, heading.x, heading.z, ROADBLOCK_MIN, ROADBLOCK_MAX);
    const obj = pt ? a.spawnRoadblock({ x: pt.x, z: pt.z, heading: pt.heading ?? Math.atan2(heading.x, heading.z) }) : null;
    if (!obj) {
      roadblockCooldown = ROADBLOCK_RETRY;
      return;
    }
    roadblocks.push({ obj, recall: false });
    roadblockCooldown = ROADBLOCK_INTERVAL;
    emitEvt('police:roadblock', { type: 'spawn', x: obj.pos.x, z: obj.pos.z, count: roadblocks.length });
  }

  function deployOfficers(rec, cap) {
    const c = rec.car.pos;
    // 下車點：車身兩側（垂直於車 → 玩家方向）
    const dx = player.x - c.x;
    const dz = player.z - c.z;
    const len = Math.hypot(dx, dz) || 1;
    const sx = -dz / len;
    const sz = dx / len;
    for (let k = 0; k < OFFICERS_PER_CAR && regularOfficers() < cap; k++) {
      const side = k % 2 === 0 ? 1 : -1;
      const o = a.spawnOfficer({ x: c.x + sx * side * DEPLOY_OFFSET, z: c.z + sz * side * DEPLOY_OFFSET, car: rec.car });
      if (!o) break;
      const r = { officer: o, car: rec, fireTimer: interval(), recallAt: null, orphan: false };
      officers.push(o);
      offRec.set(o, r);
      rec.officers.add(r);
    }
  }

  function driveCars(dt, stars, state) {
    const circle = state === 'searching' && wanted ? wanted.searchCircle : null;
    for (const car of cars) {
      const rec = carRec.get(car);
      const c = car.pos;
      const d = dist(c.x, c.z, player.x, player.z);
      // 有未倒地的警員在外 → 停車等
      let waiting = false;
      for (const o of rec.officers) if (usable(o.officer)) waiting = true;
      if (waiting) {
        a.driveCar(car, { x: c.x, z: c.z, mode: 'stop', maxSpeed: 0 });
        continue;
      }
      if (rec.recallAt !== null || stars === 0 || (state !== 'active' && !circle)) {
        // 巡邏：在玩家周圍環帶內換點閒晃
        const w = rec.waypoint;
        // car.patrolArrived：adapters 已停在路網投影點（目標點本身可能開不到）
        if (!w || w.kind !== 'patrol' || car.patrolArrived || dist(c.x, c.z, w.x, w.z) < WAYPOINT_ARRIVE) {
          rec.waypoint = { kind: 'patrol', ...ringPoint(player.x, player.z, PATROL_MIN, PATROL_MAX) };
        }
        a.driveCar(car, { x: rec.waypoint.x, z: rec.waypoint.z, mode: 'patrol', maxSpeed: PATROL_SPEED });
        continue;
      }
      if (circle) {
        // 搜索：圈內隨機點；圈換了（圓心 / 半徑）或到點就換
        const w = rec.waypoint;
        const stale = !w || w.kind !== 'search' || w.cx !== circle.x || w.cz !== circle.z || w.r !== circle.r;
        if (stale || dist(c.x, c.z, w.x, w.z) < WAYPOINT_ARRIVE) {
          rec.waypoint = { kind: 'search', cx: circle.x, cz: circle.z, r: circle.r, ...ringPoint(circle.x, circle.z, 0, circle.r) };
        }
        a.driveCar(car, { x: rec.waypoint.x, z: rec.waypoint.z, mode: 'pursue', maxSpeed: SEARCH_SPEED });
        continue;
      }
      rec.waypoint = null;
      carFire(rec, dt, stars, d);
      if (player.inVehicle && stars >= RAM_STARS && d <= RAM_DIST) {
        a.driveCar(car, { x: player.x, z: player.z, mode: 'ram', maxSpeed: RAM_SPEED });
      } else if (!player.inVehicle && d <= DEPLOY_DIST) {
        a.driveCar(car, { x: c.x, z: c.z, mode: 'stop', maxSpeed: 0 });
      } else {
        a.driveCar(car, { x: player.x, z: player.z, mode: 'pursue', maxSpeed: PURSUE_SPEED });
      }
      if (rec.swat) {
        if (rec.officers.size === 0 && rec.lost < SWAT_OFFICERS && d <= DEPLOY_DIST && (car.speed ?? 0) < DEPLOY_SPEED) deploySwat(rec);
      } else if (d <= DEPLOY_DIST && (car.speed ?? 0) < DEPLOY_SPEED && rec.officers.size === 0 && regularOfficers() < MAX_OFFICERS[stars]) {
        deployOfficers(rec, MAX_OFFICERS[stars]);
      }
    }
  }

  // 車上警察開槍（追捕中、沒有警員在外）：距離 / 視線門檻同步行警員概念，射擊由 adapters.carFire 執行
  function carFire(rec, dt, stars, d) {
    rec.fireTimer -= dt;
    const able = stars >= FIRE_STARS && !player.down && d >= CAR_FIRE_MIN && d <= CAR_FIRE_MAX;
    if (!able || !a.canSee(rec.car.pos.x, rec.car.pos.z, player.x, player.z)) {
      if (rec.fireTimer < 0) rec.fireTimer = 0;
      return;
    }
    if (rec.fireTimer > 0) return;
    rec.fireTimer += carInterval();
    if (rec.fireTimer < 0) rec.fireTimer = carInterval();
    a.carFire(rec.car, { x: player.x, z: player.z });
    emitEvt('police:carshoot', { car: rec.car, x: rec.car.pos.x, z: rec.car.pos.z, targetX: player.x, targetZ: player.z });
  }

  function driveOfficers(dt, stars, state) {
    for (const o of officers.slice()) {
      const rec = offRec.get(o);
      if (!rec) continue;
      rec.fireTimer -= dt;
      if (o.down) continue; // 倒地：不下指令，等整合層讓他起身
      const p = o.pos;
      const d = dist(p.x, p.z, player.x, player.z);
      const giveUp = player.inVehicle ? d > REBOARD_DIST : d > CHASE_GIVEUP;
      if (rec.recallAt !== null || stars === 0 || state !== 'active' || giveUp) {
        rec.fireTimer = Math.max(rec.fireTimer, 0);
        if (rec.car) {
          const c = rec.car.car.pos;
          if (dist(p.x, p.z, c.x, c.z) <= BOARD_DIST) removeOfficer(rec, true); // 上車
          else a.moveOfficer(o, { x: c.x, z: c.z, run: true });
        } else {
          a.moveOfficer(o, { x: p.x, z: p.z, run: false });
          if (rec.recallAt === null) rec.recallAt = time; // 沒車可回：離開視線就回收
        }
        continue;
      }
      if (stars >= FIRE_STARS && !player.down && d >= FIRE_MIN && d <= FIRE_MAX && a.canSee(p.x, p.z, player.x, player.z)) {
        a.moveOfficer(o, { x: p.x, z: p.z, run: false });
        const firing = rec.fireTimer <= 0;
        a.officerAim(o, { x: player.x, z: player.z, firing });
        if (firing) {
          rec.fireTimer += interval();
          if (rec.fireTimer < 0) rec.fireTimer = interval();
          if (bus) {
            bus.emit('police:shoot', { officer: o, x: p.x, y: (p.y ?? 0) + MUZZLE_HEIGHT, z: p.z, targetX: player.x, targetZ: player.z });
          }
        }
        continue;
      }
      rec.fireTimer = Math.max(rec.fireTimer, 0);
      if (d <= OFFICER_STOP_DIST) a.moveOfficer(o, { x: p.x, z: p.z, run: false });
      else a.moveOfficer(o, { x: player.x, z: player.z, run: true });
    }
  }

  function computeSeen(state) {
    const range = state === 'searching' ? SEE_SEARCH : SEE_ACTIVE;
    for (const o of officers) {
      if (!usable(o)) continue;
      if (dist(o.pos.x, o.pos.z, player.x, player.z) <= range && a.canSee(o.pos.x, o.pos.z, player.x, player.z)) return true;
    }
    for (const c of cars) {
      if (dist(c.pos.x, c.pos.z, player.x, player.z) <= range && a.canSee(c.pos.x, c.pos.z, player.x, player.z)) return true;
    }
    return false;
  }

  function updateBust(dt, stars) {
    if (stars === 0) busted = false;
    if (busted) return;
    let rate = 0;
    let who = null;
    if (stars >= 1 && !player.down) {
      const onFoot = !player.inVehicle;
      const reach = onFoot ? BUST_DIST : BUST_CAR_DIST;
      if (onFoot || (player.speed ?? 0) < BUST_CAR_SPEED) {
        for (const o of officers) {
          if (usable(o) && dist(o.pos.x, o.pos.z, player.x, player.z) <= reach) {
            who = o;
            break;
          }
        }
      }
      if (who) rate = 1 / (onFoot ? BUST_TIME : BUST_CAR_TIME);
    }
    if (!who) {
      bustProgress = Math.max(0, bustProgress - dt * BUST_DECAY);
      return;
    }
    bustProgress = Math.min(1, bustProgress + dt * rate);
    if (bustProgress >= 1 - 1e-9) {
      bustProgress = 1;
      busted = true;
      if (bus) bus.emit('police:bust', { x: player.x, z: player.z, officer: who });
    }
  }

  function update(dt, { player: pl } = {}) {
    if (disposed) return { seen: false };
    dt = Math.max(0, Math.min(DT_MAX, Number(dt) || 0));
    time += dt;
    spawnCooldown = Math.max(0, spawnCooldown - dt);
    roadblockCooldown = Math.max(0, roadblockCooldown - dt);
    swatCooldown = Math.max(0, swatCooldown - dt);
    if (pl) {
      player.x = pl.x ?? 0;
      player.z = pl.z ?? 0;
      player.inVehicle = !!pl.inVehicle;
      player.speed = pl.speed ?? 0;
      player.down = !!pl.down;
      updateHeading(pl);
    }
    const stars = curStars();
    const state = curState();

    // 1. 死亡的車 / 警員移出名單成為殘骸；殘骸離開視線才 despawn
    for (const car of cars.slice()) {
      if (car.alive === false) {
        removeCar(carRec.get(car), false);
        wrecks.push({ obj: car, kind: 'car' });
      }
    }
    for (const o of officers.slice()) {
      if (o.alive === false) {
        const r = offRec.get(o);
        if (r.swat && r.car) r.car.lost++;
        removeOfficer(r, false);
        wrecks.push({ obj: o, kind: 'officer' });
      }
    }
    for (let i = wrecks.length - 1; i >= 0; i--) {
      const w = wrecks[i];
      if (inPlayerView(w.obj.pos)) continue;
      wrecks.splice(i, 1);
      if (w.kind === 'car') a.despawnCar(w.obj);
      else a.despawnOfficer(w.obj);
    }

    // 2. 依星數排定回收，到時且離開視線才 despawn（特警不佔名額，另依 SWAT_STARS 回收）
    planRecall([...carRec.values()].filter((r) => !r.swat), MAX_CARS[stars], (r) => r.car.pos);
    planRecall([...offRec.values()].filter((r) => !r.swat), MAX_OFFICERS[stars], (r) => r.officer.pos);
    if (stars < SWAT_STARS) {
      for (const r of carRec.values()) if (r.swat && r.recallAt === null) r.recallAt = time;
      for (const r of offRec.values()) if (r.swat && r.recallAt === null) r.recallAt = time;
    } else {
      // 回到 SWAT_STARS：取消回收（比照 planRecall 叫回；孤兒特警沒車可回，回收不取消）
      for (const r of carRec.values()) if (r.swat) r.recallAt = null;
      for (const r of offRec.values()) if (r.swat && !r.orphan) r.recallAt = null;
    }
    for (const rec of [...offRec.values()]) {
      if (rec.recallAt !== null && time >= rec.recallAt && !inPlayerView(rec.officer.pos)) removeOfficer(rec, true);
    }
    for (const rec of [...carRec.values()]) {
      const c = rec.car.pos;
      if (dist(c.x, c.z, player.x, player.z) > RECYCLE_DIST) removeCar(rec, true); // 太遠：回收（未回收的會在下面重生）
      else if (rec.recallAt !== null && time >= rec.recallAt && !inPlayerView(c)) removeCar(rec, true);
    }

    // 3. 補車（每幀至多 1 台）
    let active = 0;
    for (const rec of carRec.values()) if (rec.recallAt === null && !rec.swat) active++;
    if (active < MAX_CARS[stars]) trySpawnCar(stars);
    if (stars >= SWAT_STARS && state === 'active' && !swat) trySpawnSwat();

    // 4. 駕駛、警員、視線、逮捕、路障
    driveCars(dt, stars, state);
    driveOfficers(dt, stars, state);
    const seen = computeSeen(state);
    updateBust(dt, stars);
    updateRoadblocks(stars, state);
    return { seen };
  }

  function witness(x, z) {
    if (disposed) return false;
    for (const o of officers) {
      if (usable(o) && dist(o.pos.x, o.pos.z, x, z) <= WITNESS_DIST && a.canSee(o.pos.x, o.pos.z, x, z)) return true;
    }
    for (const c of cars) {
      if (dist(c.pos.x, c.pos.z, x, z) <= WITNESS_DIST && a.canSee(c.pos.x, c.pos.z, x, z)) return true;
    }
    return false;
  }

  // 開新局 / 回主選單：路障與特警立即回收（不等離開視線）
  function cancelExtras() {
    while (roadblocks.length) removeRoadblock(roadblocks.length - 1);
    if (swat) {
      for (const r of [...swat.officers]) removeOfficer(r, true);
      removeCar(swat, true);
    }
    for (const r of [...offRec.values()]) if (r.swat) removeOfficer(r, true); // 特警車先被毀留下的孤兒特警
    for (let i = wrecks.length - 1; i >= 0; i--) {
      const w = wrecks[i];
      if (!w.obj.swat) continue; // 特警車殘骸 / 殉職特警
      wrecks.splice(i, 1);
      if (w.kind === 'car') a.despawnCar(w.obj);
      else a.despawnOfficer(w.obj);
    }
    roadblockCooldown = 0;
    swatCooldown = 0;
    heading.ok = false;
    heading.anchored = false;
  }

  // 釋放全部警力與訂閱；之後 update / witness 皆為空操作
  function dispose() {
    if (disposed) return;
    cancelExtras();
    disposed = true;
    for (const u of unsub) u();
    for (const rec of [...offRec.values()]) removeOfficer(rec, true);
    for (const rec of [...carRec.values()]) removeCar(rec, true);
    for (const w of wrecks.splice(0)) {
      if (w.kind === 'car') a.despawnCar(w.obj);
      else a.despawnOfficer(w.obj);
    }
    bustProgress = 0;
  }

  return {
    update,
    witness,
    dispose,
    cancelExtras,
    get roadblocks() {
      return roadblocks;
    },
    get swat() {
      return swat ? swat.car : null;
    },
    get heading() {
      return heading.ok ? { x: heading.x, z: heading.z } : null;
    },
    get cars() {
      return cars;
    },
    get officers() {
      return officers;
    },
    get bustProgress() {
      return bustProgress;
    },
  };
}
