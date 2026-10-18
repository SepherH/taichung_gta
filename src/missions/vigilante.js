// 警車副任務（Phase 11，§29 Vigilante）：玩家駕駛警車按互動鍵 → 逐關追捕逃犯車。純邏輯模組，不碰 DOM / three；
// createVigilante({ bus, wanted, rng, config }) → { update(dt, ctx), start(), cancel(), end(reason), active, level, dispose, … }
//   bus：emit vigilante:start / vigilante:level / vigilante:end、toast（ctx.toast 省略時）；訂閱 player:busted / player:wasted（保底結束）
//   wanted：保留給日後擴充（任務中撞擊 / 射擊逃犯車不報案由整合層以 isFugitiveActor / shotAtFugitive 擋下，本模組不呼叫 report）
//   rng：0..1（逃竄方向）；config 可覆寫下列常數（小寫駝峰同名）
// 呼叫端（main.js）每幀建 ctx = { player: { x, z }, inPolice, policeWrecked, world, earn(n), toast?(text, sec), showHint?(id, text) }：
//   inPolice = 正駕駛警車；policeWrecked = 駕駛中的警車耐久歸零；earn(n) = economy.add(n, 'vigilante')
//   world（逃犯車世界介面，見 createFugitiveWorld；測試以替身注入）：
//     spawnPoint(px, pz, rMin, rMax) → { x, z, heading } | null；spawn(pt, { level }) → handle | null
//     state(h) → { x, z, speed, health, exists, driven }；drive(h, { x, z, maxSpeed })；eject(h) → actor | null；remove(h)
// 流程：start() → 下一次 update 開第 1 關：生成 min(關數, MAX_FUGITIVES) 台逃犯車（玩家 SPAWN_MIN–SPAWN_MAX m 外的車道點），
//   時限 = TIME_BASE + TIME_PER_CAR × 台數；逃犯沿路網往背離玩家的方向逃（fleeSpeed(關數) < 警車極速）
//   制伏：耐久 ≤ SUBDUE_HEALTH（vehicle-damage 黑煙降功率門檻）或「車速 < SLOW_SPEED 持續 SLOW_SEC 且玩家 ≤ NEAR_DIST m」
//     → world.eject（逃犯下車，traffic.spawnEjectedDriver：還手或逃跑）、toast「逃犯制伏」
//   全部制伏 → 賞金 REWARD_PER_LEVEL × 關數（ctx.earn）、toast，NEXT_LEVEL_SEC 後自動下一關
// 結束：timeout（時限到）/ left（離開警車 > LEFT_SEC）/ wrecked（警車毀損）/ busted / wasted（end(kind)）/ cancel（回主選單、開新局：不 toast）
//   → toast「警車任務結束：完成 N 關、共得 NT$X」、emit vigilante:end；所有逃犯車（玩家正駕駛者除外）回收、標記清空
// 時間一律吃呼叫端傳入的 dt（秒，clamp ≤ MAX_DT）：≥ 10 fps 時結果與幀率無關（誤差 ≤ 1 幀）
import { SMOKE_DARK_AT } from '../vehicle-damage.js';
import { doorPoint, EJECT_OFFSET } from '../carjack.js';

export const MAX_FUGITIVES = 4; // 每關逃犯車上限（台數 = min(關數, 此值)）
export const SPAWN_MIN = 150; // m，逃犯車生成距離帶
export const SPAWN_MAX = 300;
export const TIME_BASE = 120; // s，每關時限 = TIME_BASE + TIME_PER_CAR × 台數
export const TIME_PER_CAR = 30;
export const FLEE_SPEED_BASE = 16; // m/s，第 1 關逃竄目標速度
export const FLEE_SPEED_STEP = 2; // m/s，每關加速
export const FLEE_SPEED_MAX = 30; // m/s，上限（警車極速 42 m/s）
export const FLEE_DIST = 250; // m，逃竄目標點：背離玩家方向此距離
export const FLEE_SPREAD = 1.2; // rad，逃竄方向隨機偏轉（±一半）
export const FLEE_REPLAN_SEC = 8; // s，定時重選逃竄目標
export const FLEE_REACH = 30; // m，接近目標點此距離即重選
export const SUBDUE_HEALTH = SMOKE_DARK_AT; // 耐久 ≤ 此值（黑灰煙降功率）→ 制伏
export const SLOW_SPEED = 1; // m/s
export const SLOW_SEC = 3; // s
export const NEAR_DIST = 15; // m，低速制伏時玩家警車須在此距離內
export const REWARD_PER_LEVEL = 500; // NT$
export const NEXT_LEVEL_SEC = 5; // s，過關後自動下一關
export const LEFT_SEC = 10; // s，離開警車超過此值 → 結束
export const SHOT_RADIUS = 4.5; // m，玩家子彈落點離逃犯車此距離內 = 射擊逃犯車（不算犯行）
export const SPAWN_RETRY_SEC = 0.5; // s，找不到生成點時的重試間隔
export const MAX_DT = 0.1; // s，單幀 dt 上限

export const HINT_ID = 'vigilante';
export const HINT_TEXT = '按 E 開始警車任務';
export const PROMPT_TEXT = '按 E 開始警車任務';
export const TOAST_SUBDUED = '逃犯制伏';
export const MARKER_KIND = 'fugitive';
export const END_REASONS = Object.freeze(['timeout', 'left', 'wrecked', 'busted', 'wasted', 'cancel']);
export const toastLevelStart = (level, n) => `警車任務 第 ${level} 關：追捕 ${n} 台逃犯車！`;
export const toastLevelClear = (level, reward) => `第 ${level} 關完成！賞金 NT$${reward}`;
export const toastEnd = (levels, earned) => `警車任務結束：完成 ${levels} 關、共得 NT$${earned}`;

export const fugitiveCount = (level, max = MAX_FUGITIVES) => Math.max(1, Math.min(Math.floor(level) || 1, max));
export const levelTime = (count, base = TIME_BASE, per = TIME_PER_CAR) => base + per * count;
export const fleeSpeed = (level, base = FLEE_SPEED_BASE, step = FLEE_SPEED_STEP, max = FLEE_SPEED_MAX) => Math.min(base + step * (Math.max(1, level) - 1), max);
export const levelReward = (level, per = REWARD_PER_LEVEL) => per * level;

// mm:ss（無條件進位到秒，負值視為 0）
export function formatClock(sec) {
  const s = Math.max(0, Math.ceil(Number(sec) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
export const barText = (level, remaining, sec) => `警車任務 第 ${level} 關｜剩 ${remaining} 台｜${formatClock(sec)}`;

export function createVigilante({ bus = null, wanted = null, rng = Math.random, config = {} } = {}) {
  void wanted;
  const cfg = {
    maxFugitives: config.maxFugitives ?? MAX_FUGITIVES,
    spawnMin: config.spawnMin ?? SPAWN_MIN,
    spawnMax: config.spawnMax ?? SPAWN_MAX,
    timeBase: config.timeBase ?? TIME_BASE,
    timePerCar: config.timePerCar ?? TIME_PER_CAR,
    fleeBase: config.fleeSpeedBase ?? FLEE_SPEED_BASE,
    fleeStep: config.fleeSpeedStep ?? FLEE_SPEED_STEP,
    fleeMax: config.fleeSpeedMax ?? FLEE_SPEED_MAX,
    fleeDist: config.fleeDist ?? FLEE_DIST,
    fleeSpread: config.fleeSpread ?? FLEE_SPREAD,
    replanSec: config.fleeReplanSec ?? FLEE_REPLAN_SEC,
    fleeReach: config.fleeReach ?? FLEE_REACH,
    subdueHealth: config.subdueHealth ?? SUBDUE_HEALTH,
    slowSpeed: config.slowSpeed ?? SLOW_SPEED,
    slowSec: config.slowSec ?? SLOW_SEC,
    nearDist: config.nearDist ?? NEAR_DIST,
    rewardPer: config.rewardPerLevel ?? REWARD_PER_LEVEL,
    nextSec: config.nextLevelSec ?? NEXT_LEVEL_SEC,
    leftSec: config.leftSec ?? LEFT_SEC,
    shotRadius: config.shotRadius ?? SHOT_RADIUS,
    retrySec: config.spawnRetrySec ?? SPAWN_RETRY_SEC,
    maxDt: config.maxDt ?? MAX_DT,
    rng: config.rng || rng || Math.random,
  };
  const rand = () => {
    const r = Number(cfg.rng());
    return Number.isFinite(r) ? Math.min(Math.max(r, 0), 0.999999) : 0;
  };
  const emit = (name, payload) => {
    if (bus && typeof bus.emit === 'function') bus.emit(name, payload);
  };

  // phase：'idle' | 'starting'（start() 後等下一次 update 開第 1 關）| 'running' | 'intermission'（過關後倒數下一關）
  let phase = 'idle';
  let level = 0;
  let levelsDone = 0;
  let earned = 0;
  let timeLeft = 0;
  let interT = 0;
  let leftT = 0;
  let retryT = 0;
  let hinted = false;
  let seq = 0;
  let world = null; // 最近一次 update 的 ctx.world（end / cancel 回收逃犯車用）
  let lastCtx = null;
  const fugitives = []; // { id, h, x, z, speed, slowT, subdued, pending, goal: { x, z }, planT }
  const actors = new Set(); // 已下車的逃犯 actor（任務中攻擊不算犯行）

  function toast(ctx, text, seconds) {
    if (ctx && typeof ctx.toast === 'function') ctx.toast(text, seconds);
    else emit('toast', { text, seconds });
  }

  const remaining = () => fugitives.reduce((n, f) => n + (f.subdued ? 0 : 1), 0);

  function clearFugitives() {
    for (const f of fugitives.splice(0)) {
      if (f.h && world && typeof world.remove === 'function') world.remove(f.h);
    }
  }

  function beginLevel(n, ctx) {
    clearFugitives(); // 上一關已制伏的車在此回收（玩家正駕駛者由 world.remove 保留）
    level = n;
    const count = fugitiveCount(n, cfg.maxFugitives);
    for (let i = 0; i < count; i++) fugitives.push({ id: `fugitive-${++seq}`, h: null, x: NaN, z: NaN, speed: 0, slowT: 0, subdued: false, pending: true, goal: { x: NaN, z: NaN }, planT: 0 });
    timeLeft = levelTime(count, cfg.timeBase, cfg.timePerCar);
    retryT = 0;
    phase = 'running';
    emit('vigilante:level', { level: n, phase: 'start', count, timeSec: timeLeft, speed: fleeSpeed(n, cfg.fleeBase, cfg.fleeStep, cfg.fleeMax) });
    toast(ctx, toastLevelStart(n, count), 3);
  }

  function spawnPending(ctx) {
    const w = ctx.world;
    if (!w || typeof w.spawnPoint !== 'function' || typeof w.spawn !== 'function') return;
    const p = ctx.player;
    for (const f of fugitives) {
      if (!f.pending) continue;
      const pt = w.spawnPoint(p.x, p.z, cfg.spawnMin, cfg.spawnMax);
      const h = pt ? w.spawn(pt, { level }) : null;
      if (!h) {
        retryT = cfg.retrySec;
        return;
      }
      f.h = h;
      f.pending = false;
      f.x = pt.x;
      f.z = pt.z;
      f.planT = 0;
    }
  }

  // 逃竄目標：背離玩家的方向 ± FLEE_SPREAD / 2，距離 FLEE_DIST（路網投影由 world.drive → findRoute 處理）
  function planFlee(f, px, pz) {
    let dx = f.x - px;
    let dz = f.z - pz;
    const L = Math.hypot(dx, dz);
    let a = L > 1e-6 ? Math.atan2(dx, dz) : rand() * Math.PI * 2;
    a += (rand() - 0.5) * cfg.fleeSpread;
    dx = Math.sin(a);
    dz = Math.cos(a);
    f.goal.x = f.x + dx * cfg.fleeDist;
    f.goal.z = f.z + dz * cfg.fleeDist;
    f.planT = cfg.replanSec;
  }

  function subdue(f, ctx) {
    f.subdued = true;
    f.slowT = 0;
    const w = ctx.world;
    const actor = w && typeof w.eject === 'function' ? w.eject(f.h) : null;
    if (actor) actors.add(actor);
    toast(ctx, TOAST_SUBDUED, 2.5);
    emit('vigilante:subdued', { id: f.id, level, x: f.x, z: f.z, remaining: remaining() });
  }

  function clearLevel(ctx) {
    const reward = levelReward(level, cfg.rewardPer);
    levelsDone = level;
    earned += reward;
    if (ctx && typeof ctx.earn === 'function') ctx.earn(reward);
    emit('vigilante:level', { level, phase: 'clear', reward, earned });
    toast(ctx, toastLevelClear(level, reward), 4);
    phase = 'intermission';
    interT = cfg.nextSec;
  }

  // 結束（reason ∈ END_REASONS）；cancel 不 toast。回傳是否真的結束了進行中的任務
  function end(reason = 'cancel', ctx = lastCtx) {
    if (phase === 'idle') return false;
    const silent = reason === 'cancel';
    clearFugitives();
    actors.clear();
    const out = { reason, levels: levelsDone, earned, level };
    phase = 'idle';
    level = 0;
    timeLeft = 0;
    interT = 0;
    leftT = 0;
    emit('vigilante:end', out);
    if (!silent) toast(ctx, toastEnd(out.levels, out.earned), 5);
    return true;
  }

  function start() {
    if (phase !== 'idle') return false;
    phase = 'starting';
    levelsDone = 0;
    earned = 0;
    leftT = 0;
    actors.clear();
    emit('vigilante:start', {});
    return true;
  }

  // 啟動條件（純函式，main.js 互動鍵仲裁用）：駕駛警車、未進行中、無其他任務（ctx.busy）；星數不限
  function canStart(ctx = {}) {
    return phase === 'idle' && !!ctx.inPolice && !ctx.busy;
  }

  function snapshot() {
    const on = phase !== 'idle';
    const rem = on ? remaining() : 0;
    const sec = phase === 'intermission' ? interT : timeLeft;
    return { active: on, phase, level, remaining: rem, timeLeft: on ? timeLeft : 0, text: phase === 'running' ? barText(level, rem, timeLeft) : phase === 'intermission' ? `警車任務 第 ${level} 關完成｜下一關 ${formatClock(sec)}` : null };
  }

  function update(dt, ctx = {}) {
    dt = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), cfg.maxDt) : 0;
    lastCtx = ctx;
    if (ctx.world) world = ctx.world;
    const p = ctx.player || {};
    const px = Number(p.x);
    const pz = Number(p.z);
    const hasPos = Number.isFinite(px) && Number.isFinite(pz);

    if (phase === 'idle') {
      // 首次坐上警車 → 提示卡（呼叫端回傳真值 = 已顯示 / 已看過，之後不再問）
      if (!hinted && ctx.inPolice && typeof ctx.showHint === 'function' && ctx.showHint(HINT_ID, HINT_TEXT)) hinted = true;
      return snapshot();
    }
    if (!hasPos) return snapshot();

    // 結束條件（每關、過關倒數中都檢查）
    if (ctx.inPolice && ctx.policeWrecked) {
      end('wrecked', ctx);
      return snapshot();
    }
    if (ctx.inPolice) leftT = 0;
    else {
      leftT += dt;
      if (leftT > cfg.leftSec) {
        end('left', ctx);
        return snapshot();
      }
    }

    if (phase === 'starting') {
      beginLevel(1, ctx);
    } else if (phase === 'intermission') {
      interT -= dt;
      if (interT <= 0) beginLevel(level + 1, ctx);
      else return snapshot();
    }

    // running
    if (retryT > 0) retryT -= dt;
    if (retryT <= 0) spawnPending(ctx);
    const w = ctx.world;
    const speed = fleeSpeed(level, cfg.fleeBase, cfg.fleeStep, cfg.fleeMax);
    const near2 = cfg.nearDist * cfg.nearDist;
    const reach2 = cfg.fleeReach * cfg.fleeReach;
    for (const f of fugitives) {
      if (f.pending || f.subdued || !f.h) continue;
      const st = w && typeof w.state === 'function' ? w.state(f.h) : null;
      if (!st || !st.exists) {
        // 車輛被外部回收（掉出世界等）：視同逃脫，不擋過關、不給制伏 toast
        f.subdued = true;
        f.h = null;
        continue;
      }
      f.x = st.x;
      f.z = st.z;
      f.speed = Math.abs(st.speed || 0);
      // 玩家搶走逃犯車（停下時上車）或打到黑煙 → 制伏
      if (st.driven || (Number.isFinite(st.health) && st.health <= cfg.subdueHealth)) {
        subdue(f, ctx);
        continue;
      }
      const near = (f.x - px) ** 2 + (f.z - pz) ** 2 <= near2;
      if (f.speed < cfg.slowSpeed && near && ctx.inPolice) {
        f.slowT += dt;
        if (f.slowT >= cfg.slowSec - 1e-9) {
          subdue(f, ctx);
          continue;
        }
      } else f.slowT = 0;
      f.planT -= dt;
      if (f.planT <= 0 || !Number.isFinite(f.goal.x) || (f.x - f.goal.x) ** 2 + (f.z - f.goal.z) ** 2 < reach2) planFlee(f, px, pz);
      if (w && typeof w.drive === 'function') w.drive(f.h, { x: f.goal.x, z: f.goal.z, maxSpeed: speed });
    }

    if (fugitives.length && fugitives.every((f) => f.subdued)) {
      clearLevel(ctx);
      return snapshot();
    }
    timeLeft = Math.max(0, timeLeft - dt);
    if (timeLeft <= 0) end('timeout', ctx);
    return snapshot();
  }

  // 小地圖 / 大地圖標記：未制伏且已生成的逃犯車（kind 'fugitive'，紅點）
  function markers(out = []) {
    for (const f of fugitives) if (!f.subdued && !f.pending && Number.isFinite(f.x)) out.push({ x: f.x, z: f.z, kind: MARKER_KIND });
    return out;
  }

  // 不算犯行判定（任務中）：攻擊對象是已下車的逃犯 / 子彈落點在未回收的逃犯車附近
  function isFugitiveActor(a) {
    return phase !== 'idle' && !!a && actors.has(a);
  }
  function shotAtFugitive(x, z) {
    if (phase === 'idle' || !Number.isFinite(x) || !Number.isFinite(z)) return false;
    const r2 = cfg.shotRadius * cfg.shotRadius;
    // 已制伏的車不豁免：制伏後不再更新 f.x / f.z（座標會過期），逃犯本人已由 isFugitiveActor 豁免
    for (const f of fugitives) if (f.h && !f.subdued && Number.isFinite(f.x) && (f.x - x) ** 2 + (f.z - z) ** 2 <= r2) return true;
    return false;
  }
  function isFugitiveHandle(h) {
    return phase !== 'idle' && !!h && fugitives.some((f) => f.h === h);
  }

  function cancel() {
    return end('cancel');
  }

  const offs = [];
  if (bus && typeof bus.on === 'function') {
    offs.push(bus.on('player:busted', () => end('busted')));
    offs.push(bus.on('player:wasted', () => end('wasted')));
  }

  function dispose() {
    cancel();
    for (const off of offs.splice(0)) if (typeof off === 'function') off();
  }

  return {
    update,
    start,
    cancel,
    end,
    canStart,
    markers,
    isFugitiveActor,
    shotAtFugitive,
    isFugitiveHandle,
    dispose,
    fugitives,
    get active() {
      return phase !== 'idle';
    },
    get phase() {
      return phase;
    },
    get level() {
      return level;
    },
    get levelsDone() {
      return levelsDone;
    },
    get earned() {
      return earned;
    },
    get timeLeft() {
      return timeLeft;
    },
  };
}

// ---------- 逃犯車世界介面（整合層用；只依賴注入的 vehicles / dmg / traffic / findRoute，不 import three / rapier）----------
// createFugitiveWorld({ vehicles, dmg, traffic, findRoute, rng, attacker, isKept, onKeep }) → ctx.world + update(dt)（每幀駕駛控制）/ brakeAll() / dispose()
//   vehicles：VehicleManager（adopt / remove / vehicles）；dmg：vehicle-damage（attach / detach / healthOf）
//   traffic：spawnSpots（生成點）/ spawnEjectedDriver（制伏時逃犯下車）；findRoute：(a, b) → { points } | null（navigation.js）
//   attacker：() → 玩家 actor（下車逃犯還手對象）
//   isKept：(v) → 真 = 回收時保留（玩家正上車 / 搶車中的車）；onKeep：(v) → 回收時保留下來的車交給整合層（一般車輛回收名單）
// 駕駛控制沿用 wanted/adapters.js 警車的路線跟隨 + 彎道減速 + 卡住倒車（常數獨立，卡住判定較警車長，讓「被警車頂住 3 s」先成立）
export const FUGITIVE_TYPES = ['sedan', 'sedan', 'taxi', 'suv'];
export const FUGITIVE_COLORS = ['#f2f2f2', '#1f1f22', '#8a8f94', '#b01e28', '#2d5fb0', '#d9d2c0', '#3f6b4a'];
export const ROUTE_REACH = 8; // m
export const REROUTE_SEC = 3; // s
export const REROUTE_MOVE = 20; // m，目標移動超過此距離即重算
export const STEER_GAIN = 1.8;
export const THROTTLE_GAIN = 0.35;
export const CORNER_ANGLE = Math.PI / 2;
export const CORNER_MIN = 0.3;
export const STUCK_SPEED = 1; // m/s
export const STUCK_SEC = 4; // s（> SLOW_SEC）
export const REVERSE_SEC = 1.5; // s
export const SPAWN_TRIES = 12;
export const SPAWN_CAR_GAP = 10; // m

const wrapAngle = (a) => {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function createFugitiveWorld({ vehicles = null, dmg = null, traffic = null, findRoute = null, rng = Math.random, attacker = () => null, isKept = () => false, onKeep = () => {} } = {}) {
  const cars = new Set();
  const spotBuf = [];
  let time = 0;
  const pick = (list) => list[Math.floor(Math.min(Math.max(Number(rng()) || 0, 0), 0.999999) * list.length)];
  const exists = (v) => !!vehicles && vehicles.vehicles.includes(v);

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

  function spawnPoint(px, pz, rMin, rMax) {
    if (!traffic || typeof traffic.spawnSpots !== 'function') return null;
    const spots = traffic.spawnSpots(px, pz, rMin, rMax, spotBuf);
    if (!spots || !spots.length) return null;
    for (let k = 0; k < SPAWN_TRIES; k++) {
      const sp = pick(spots);
      const d = Math.hypot(sp.x - px, sp.z - pz);
      if (d < rMin || d > rMax || nearVehicle(sp.x, sp.z)) continue;
      return { x: sp.x, z: sp.z, heading: sp.heading ?? 0 };
    }
    return null;
  }

  function spawn(pt) {
    if (!vehicles || !pt) return null;
    const type = pick(FUGITIVE_TYPES);
    const v = vehicles.adopt({ type, color: type === 'taxi' ? '#f5c518' : pick(FUGITIVE_COLORS), x: pt.x, z: pt.z, yaw: pt.heading ?? 0 });
    if (!v) return null;
    v.ai = true; // 不自動停放、不做遠距休眠（同警車）
    v.fugitive = true;
    if (dmg && typeof dmg.attach === 'function') dmg.attach(v);
    const car = { v, cmd: { x: pt.x, z: pt.z, maxSpeed: 0, set: false }, route: null, routeIdx: 0, routeAt: -Infinity, routeGoal: { x: NaN, z: NaN }, stuckT: 0, reverseT: 0, reverseSteer: 1, ejected: false, driverVariant: null }; // null → traffic 隨機行人外觀
    cars.add(car);
    return car;
  }

  function state(car) {
    const v = car && car.v;
    if (!v || !exists(v)) return { x: NaN, z: NaN, speed: 0, health: null, exists: false, driven: false };
    const h = dmg && typeof dmg.healthOf === 'function' ? dmg.healthOf(v) : null;
    return { x: v.pos.x, z: v.pos.z, speed: v.speed || 0, health: h, exists: true, driven: !!v.driven };
  }

  function drive(car, { x, z, maxSpeed = 0 } = {}) {
    if (!car || car.ejected) return;
    car.cmd.x = x;
    car.cmd.z = z;
    car.cmd.maxSpeed = maxSpeed;
    car.cmd.set = true;
  }

  // 制伏：停止控制、交還一般車輛（可被玩家開走），駕駛座側車門外生成逃犯（行人模型，traffic.spawnEjectedDriver：還手或逃跑）
  function eject(car) {
    if (!car || car.ejected) return null;
    car.ejected = true;
    const v = car.v;
    v.ai = false;
    if (!v.driven && typeof v.setControls === 'function') v.setControls({ throttle: 0, steer: 0, brake: 1, handbrake: true });
    if (v.driven || !traffic || typeof traffic.spawnEjectedDriver !== 'function') return null;
    const spec = v.spec || {};
    const d = doorPoint(v.pos.x, v.pos.z, v.yaw || 0, { length: spec.length || 4.5, width: spec.width || 1.85 }, spec.doorSide ?? 1);
    const p = traffic.spawnEjectedDriver({ x: d.x + d.outX * EJECT_OFFSET, z: d.z + d.outZ * EJECT_OFFSET, yaw: Math.atan2(d.outX, d.outZ), variant: car.driverVariant, attacker: attacker() });
    return p && p.actor ? p.actor : null;
  }

  // 回收：玩家正駕駛 / 正上車（isKept）的逃犯車保留給玩家（一般車輛，onKeep 交整合層回收名單），其餘移除剛體 / 網格
  function remove(car) {
    if (!car || !cars.has(car)) return;
    cars.delete(car);
    const v = car.v;
    v.ai = false;
    v.fugitive = false;
    if (!exists(v)) return;
    if (v.driven || isKept(v)) {
      onKeep(v);
      return;
    }
    if (dmg && typeof dmg.detach === 'function') dmg.detach(v);
    vehicles.remove(v);
  }

  function steerTarget(car) {
    const c = car.cmd;
    const p = car.v.pos;
    if (typeof findRoute !== 'function') return c;
    if (!car.route || time - car.routeAt >= REROUTE_SEC || Math.hypot(c.x - car.routeGoal.x, c.z - car.routeGoal.z) > REROUTE_MOVE) {
      const r = findRoute({ x: p.x, z: p.z }, { x: c.x, z: c.z });
      car.route = r && r.points && r.points.length >= 2 ? r.points : null;
      car.routeIdx = 1;
      car.routeAt = time;
      car.routeGoal.x = c.x;
      car.routeGoal.z = c.z;
    }
    const pts = car.route;
    if (!pts) return c;
    // 終點取路網投影點（倒數第二點）：逃竄目標可能在建築 / 水域內
    const last = pts.length >= 3 ? pts.length - 2 : pts.length - 1;
    while (car.routeIdx < last && Math.hypot(p.x - pts[car.routeIdx].x, p.z - pts[car.routeIdx].z) < ROUTE_REACH) car.routeIdx++;
    car.routeIdx = Math.min(car.routeIdx, last);
    return pts[car.routeIdx];
  }

  function control(car, dt) {
    const v = car.v;
    const c = car.cmd;
    if (v.body && v.body.kinematic && typeof v.body.setKinematic === 'function') v.body.setKinematic(false);
    const rb = v.body && v.body.body;
    if (rb && v.body.active !== false && typeof rb.isEnabled === 'function' && !rb.isEnabled()) rb.setEnabled(true);
    const speed = v.speed || 0;
    if (!c.set) {
      v.setControls({ throttle: 0, steer: 0, brake: 1, handbrake: Math.abs(speed) < STUCK_SPEED });
      return;
    }
    const t = steerTarget(car);
    const p = v.pos;
    const err = wrapAngle(Math.atan2(t.x - p.x, t.z - p.z) - (v.yaw || 0));
    if (car.reverseT > 0) {
      car.reverseT -= dt;
      v.setControls({ throttle: -1, steer: car.reverseSteer, brake: 0, handbrake: false });
      return;
    }
    const corner = clamp(1 - (Math.abs(err) / CORNER_ANGLE) * (1 - CORNER_MIN), CORNER_MIN, 1);
    const throttle = clamp((c.maxSpeed * corner - speed) * THROTTLE_GAIN, -1, 1);
    const steer = clamp(err * STEER_GAIN, -1, 1);
    if (throttle > 0.3 && Math.abs(speed) < STUCK_SPEED) car.stuckT += dt;
    else car.stuckT = 0;
    if (car.stuckT >= STUCK_SEC) {
      car.stuckT = 0;
      car.reverseT = REVERSE_SEC;
      car.reverseSteer = err >= 0 ? -1 : 1;
      v.setControls({ throttle: -1, steer: car.reverseSteer, brake: 0, handbrake: false });
      return;
    }
    v.setControls({ throttle, steer, brake: 0, handbrake: false });
  }

  // 每幀（物理 step 之前或之後皆可；setControls 在下一個子步生效）：未制伏、未被玩家駕駛、仍存在的逃犯車
  function update(dt) {
    dt = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), MAX_DT) : 0;
    time += dt;
    for (const car of cars) {
      if (car.ejected || car.v.driven || !exists(car.v)) continue;
      if (dt > 0) control(car, dt);
    }
  }

  // 凍結（手機 / 噴漆 / 搶劫 / BUSTED・WASTED，update 不跑）：煞停仍在逃的車，不沿用最後一次油門 / 倒車（同 adapters brakeCar）
  function brakeAll() {
    for (const car of cars) {
      if (car.ejected || car.v.driven || !exists(car.v)) continue;
      car.stuckT = 0;
      car.reverseT = 0;
      car.v.setControls({ throttle: 0, steer: 0, brake: 1, handbrake: Math.abs(car.v.speed || 0) < STUCK_SPEED });
    }
  }

  function dispose() {
    for (const car of [...cars]) remove(car);
  }

  return { spawnPoint, spawn, state, drive, eject, remove, update, brakeAll, dispose, cars };
}

// ---------- 任務條（DOM；root 由整合層給，.vig- 前綴樣式在 src/style.css）----------
export function createVigilanteBar({ root = null, doc = (root && root.ownerDocument) || globalThis.document } = {}) {
  if (!doc || typeof doc.createElement !== 'function') return { set() {}, dispose() {} };
  const el = doc.createElement('div');
  el.className = 'vig-bar';
  el.hidden = true;
  const text = doc.createElement('span');
  text.className = 'vig-text';
  el.appendChild(text);
  (root || doc.body).appendChild(el);
  let last = null;
  return {
    // text：字串顯示、null 隱藏；urgent（剩 ≤ 30 s）加 .vig-urgent
    set(t, urgent = false) {
      if (t === last && el.classList.contains('vig-urgent') === !!urgent) return;
      last = t;
      el.hidden = t == null;
      if (t != null) text.textContent = t;
      el.classList.toggle('vig-urgent', !!urgent);
    },
    dispose() {
      el.remove();
    },
    el,
  };
}
