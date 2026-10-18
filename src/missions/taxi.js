// 計程車副任務（Phase 13，§35 Taxi）：駕駛計程車按互動鍵開始 → 附近路邊招手乘客（wave）→ 停到乘客旁上車 → 限時送到七期地標 → 停車付費 → 下一位。
// 純邏輯模組，不碰 three / rapier；DOM 只在 createSideJobBar（整合層給 root）。
// createTaxi({ bus, rng, config }) → { update(dt, ctx) → snapshot, start(ctx?), cancel(), end(reason), canStart(ctx), markers(out), beacons(),
//   active, phase, fares, earned, streak, fare, dest, dispose }
//   bus：emit taxi:start / taxi:pickup / taxi:paid / taxi:failed / taxi:end、toast（ctx.toast 省略時）；訂閱 player:busted / player:wasted（保底結束）
//   rng：0..1（目的地抽選）；config 可覆寫下列常數（小寫駝峰同名）
// 呼叫端（main.js）每幀建 ctx = { player: { x, z }, inTaxi, car?, speed, health, maxHealth, wrecked, world, earn(n), toast?(text, sec), routeLength?(a, b) }：
//   inTaxi = 正駕駛計程車（type 'taxi'）；car = 該車識別（省略 = 不比對）；speed = 車速 m/s；health / maxHealth = 該車耐久（dmg，未 attach 為 null → 不判損壞）；wrecked = 耐久歸零
//   載客中以「上車那台車」為準：ctx.car 與上車時不同 → 視同不在計程車上（不判到達 / 不比耐久，LEFT_SEC 後結束；換回原車繼續）
//   routeLength(a, b) → 路網距離 m | null（navigation findRoute.lengthM；null → 直線 × ROUTE_FACTOR）
//   world（乘客世界介面，見 createCurbPedWorld；測試以替身注入）：
//     spawnFare(center, rMin, rMax) → handle | null（徵用 center 周圍 rMin–rMax 的路人改為原地招手）；state(h) → { x, z, exists }
//     board(h)（上車：人消失於車內）；alight(h, at)（下車）；remove(h)（任務結束：交還路人）
// 開始：start(ctx) —— 駕駛計程車、無其他任務、未熄火 / 未翻車 → phase 'seek'；任務中再按互動鍵 = 收工（end('quit')）
// 招客：每 FARE_RETRY_SEC 試一次 world.spawnFare（玩家 FARE_MIN_DIST–FARE_MAX_DIST 內）；乘客消失 / 離玩家 > FARE_LOST_DIST → 重找
// 上車：駕駛計程車、離乘客 ≤ BOARD_RADIUS、|車速| < BOARD_MAX_SPEED → board → phase 'ride'；目的地 = DESTINATIONS 中離上車點直線
//   TRIP_MIN–TRIP_MAX 者隨機一處；限時 = 路網距離 ÷ TRIP_SPEED + TRIP_EXTRA_SEC
// 到達：駕駛計程車、離目的地 ≤ ARRIVE_RADIUS、|車速| < ARRIVE_MAX_SPEED → 付費 = 跳表（BASE_FARE + PER_KM × 公里）+ 小費（剩餘時間比例 × TIP_MAX_RATIO × 跳表）
//   + 連載加成（(跳表 + 小費) × STREAK_STEP × min(連載數 − 1, STREAK_MAX_STEPS)）；ctx.earn → 回 'seek'
// 乘客下車不付費（連載歸零、回 'seek'）：超時 timeout / 載客中車輛耐久掉超過 DAMAGE_LIMIT × 滿耐久 damaged
// 結束：left（下車 / 換開非計程車 > LEFT_SEC）/ wrecked / busted / wasted（end(kind)）/ quit（再按互動鍵收工）/ cancel（回主選單、開新局：不 toast）
//   → emit taxi:end；乘客 world.remove、標記清空
// 時間一律吃呼叫端傳入的 dt（秒，clamp ≤ MAX_DT）：≥ 10 fps 時結果與幀率無關（誤差 ≤ 1 幀）
// 效能：snapshot / 標記 / 光柱目標皆重用同一物件（不每幀配置）；任務條文字只在顯示內容（整秒）變化時重建
import { RACES } from './race.js';

export const BOARD_RADIUS = 6; // m，乘客上車距離
export const BOARD_MAX_SPEED = 2; // m/s，上車時車速上限
export const ARRIVE_RADIUS = 10; // m，到達目的地判定半徑
export const ARRIVE_MAX_SPEED = 2; // m/s
export const TRIP_SPEED = 10; // m/s，限時 = 路網距離 ÷ 此值 + TRIP_EXTRA_SEC
export const TRIP_EXTRA_SEC = 20; // s
export const BASE_FARE = 80; // NT$，起跳
export const PER_KM = 40; // NT$ / km
export const TIP_MAX_RATIO = 0.5; // 小費上限（跳表 × 此值 × 剩餘時間比例）
export const STREAK_STEP = 0.1; // 連載加成：每多連載一趟 +10%
export const STREAK_MAX_STEPS = 5; // 加成上限 5 階（+50%）
export const DAMAGE_LIMIT = 0.25; // 載客中耐久掉超過滿耐久 25% → 乘客嚇到下車
export const LEFT_SEC = 10; // s，下車超過此值 → 任務結束
export const FARE_MIN_DIST = 25; // m，招手乘客離玩家距離帶
export const FARE_MAX_DIST = 90;
export const FARE_LOST_DIST = 250; // m，離乘客超過此距離 → 放棄改找下一位
export const FARE_RETRY_SEC = 1; // s，找不到乘客時的重試間隔（錯開更新）
export const TRIP_MIN = 250; // m，目的地離上車點直線距離帶
export const TRIP_MAX = 1400;
export const ROUTE_FACTOR = 1.3; // 無路網距離時：直線 × 此值
export const MAX_DT = 0.1;
export const URGENT_SEC = 15; // s，剩此秒數內任務條轉紅
export const MARKER_FARE = 'taxi-fare';
export const MARKER_DEST = 'taxi-dest';
export const END_REASONS = Object.freeze(['left', 'wrecked', 'busted', 'wasted', 'quit', 'cancel']);
export const FAIL_REASONS = Object.freeze(['timeout', 'damaged']);
export const PROMPT_START = '按 E 開始計程車載客';
export const PROMPT_QUIT = '按 E 結束計程車載客';
export const TOAST_BUSY = '正在進行其他任務，不能載客';
export const TOAST_STALLED = '車子熄火了，不能載客';
export const TOAST_OVERTURNED = '車子翻覆了，不能載客';
export const END_TEXT = Object.freeze({ left: '離開計程車太久', wrecked: '計程車毀損', busted: '被捕', wasted: '送醫', quit: '收工' });
export const FAIL_TEXT = Object.freeze({ timeout: '超時了，乘客氣呼呼下車（不付錢）', damaged: '車撞成這樣，乘客嚇得下車（不付錢）' });

// 目的地：七期地標旁的車道點（沿用 race.js RACES 起點 / 檢查點，已由 p12-race 驗證在車道寬度內、最大連通塊；同名只取一次）
export const DESTINATIONS = Object.freeze(
  (() => {
    const out = [];
    const seen = new Set();
    for (const r of RACES) {
      for (const p of [r.start, ...r.checkpoints]) {
        if (seen.has(p.name)) continue;
        seen.add(p.name);
        out.push(Object.freeze({ name: p.name, x: p.x, z: p.z }));
      }
    }
    return out;
  })(),
);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// mm:ss（無條件進位到整秒，負值視為 0）
export function formatClock(sec) {
  const t = Math.max(0, Math.ceil((Number(sec) || 0) - 1e-9));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

// 跳表車資：起跳 + 每公里（四捨五入到元）
export const meterFare = (distM, base = BASE_FARE, perKm = PER_KM) => base + Math.round((Math.max(0, Number(distM) || 0) / 1000) * perKm);
// 限時（s）：路網距離 ÷ 速度 + 寬限
export const tripLimit = (distM, speed = TRIP_SPEED, extra = TRIP_EXTRA_SEC) => Math.max(0, Number(distM) || 0) / speed + extra;
// 小費：提早越多越高（剩餘時間 / 限時 × 上限比例 × 跳表，無條件捨去）；超時 0
export function tipFor(meter, timeLeft, limit, ratio = TIP_MAX_RATIO) {
  if (!(limit > 0) || !(timeLeft > 0)) return 0;
  return Math.floor(meter * ratio * clamp(timeLeft / limit, 0, 1));
}
// 連載加成：streak = 含本趟的連續成功趟數（第 1 趟無加成）
export function streakBonus(amount, streak, step = STREAK_STEP, maxSteps = STREAK_MAX_STEPS) {
  const k = clamp(Math.floor(streak) - 1, 0, maxSteps);
  return Math.round(amount * step * k);
}

// 目的地抽選：離 from 直線 [min, max] 者隨機一處；都不在範圍 → 取最接近範圍者（最遠的那個）
export function pickDestination(rand, from, list = DESTINATIONS, min = TRIP_MIN, max = TRIP_MAX) {
  let n = 0;
  for (const d of list) {
    const dd = Math.hypot(d.x - from.x, d.z - from.z);
    if (dd >= min && dd <= max) n++;
  }
  if (n > 0) {
    let k = Math.floor(clamp(Number(rand()) || 0, 0, 0.999999) * n);
    for (const d of list) {
      const dd = Math.hypot(d.x - from.x, d.z - from.z);
      if (dd >= min && dd <= max && k-- === 0) return d;
    }
  }
  let best = null;
  let bd = -1;
  for (const d of list) {
    const dd = Math.hypot(d.x - from.x, d.z - from.z);
    if (dd > bd) {
      bd = dd;
      best = d;
    }
  }
  return best;
}

export const toastPaid = (p) => `送達！車資 NT$${p.meter}${p.tip > 0 ? `＋小費 NT$${p.tip}` : ''}${p.bonus > 0 ? `＋連載加成 NT$${p.bonus}` : ''}｜共 NT$${p.total}`;
export const toastEnd = (reason, fares, earned) => `${reason === 'quit' ? '計程車收工' : `計程車任務結束：${END_TEXT[reason] || reason}`}｜載客 ${fares} 趟｜NT$${earned}`;

export function createTaxi({ bus = null, rng = Math.random, config = {} } = {}) {
  const cfg = {
    boardRadius: config.boardRadius ?? BOARD_RADIUS,
    boardMaxSpeed: config.boardMaxSpeed ?? BOARD_MAX_SPEED,
    arriveRadius: config.arriveRadius ?? ARRIVE_RADIUS,
    arriveMaxSpeed: config.arriveMaxSpeed ?? ARRIVE_MAX_SPEED,
    tripSpeed: config.tripSpeed ?? TRIP_SPEED,
    tripExtra: config.tripExtraSec ?? TRIP_EXTRA_SEC,
    baseFare: config.baseFare ?? BASE_FARE,
    perKm: config.perKm ?? PER_KM,
    tipRatio: config.tipMaxRatio ?? TIP_MAX_RATIO,
    streakStep: config.streakStep ?? STREAK_STEP,
    streakMax: config.streakMaxSteps ?? STREAK_MAX_STEPS,
    damageLimit: config.damageLimit ?? DAMAGE_LIMIT,
    leftSec: config.leftSec ?? LEFT_SEC,
    fareMin: config.fareMinDist ?? FARE_MIN_DIST,
    fareMax: config.fareMaxDist ?? FARE_MAX_DIST,
    fareLost: config.fareLostDist ?? FARE_LOST_DIST,
    retrySec: config.fareRetrySec ?? FARE_RETRY_SEC,
    tripMin: config.tripMin ?? TRIP_MIN,
    tripMax: config.tripMax ?? TRIP_MAX,
    routeFactor: config.routeFactor ?? ROUTE_FACTOR,
    destinations: config.destinations || DESTINATIONS,
    maxDt: config.maxDt ?? MAX_DT,
    urgentSec: config.urgentSec ?? URGENT_SEC,
    rng: config.rng || rng || Math.random,
  };
  const emit = (name, payload) => {
    if (bus && typeof bus.emit === 'function') bus.emit(name, payload);
  };

  // phase：'idle' | 'seek'（找乘客 / 開往乘客）| 'ride'（載客中）
  let phase = 'idle';
  let leftT = 0;
  let retryT = 0;
  let fares = 0;
  let earned = 0;
  let streak = 0;
  let world = null;
  let lastCtx = null;
  const fare = { h: null, x: 0, z: 0 }; // 招手中 / 車上的乘客
  const trip = { dest: null, dist: 0, limit: 0, timeLeft: 0, boardHealth: null, car: null, fromX: 0, fromZ: 0 };
  const from = { x: 0, z: 0 };
  const center = { x: 0, z: 0 };
  const snap = { active: false, phase: 'idle', fares: 0, earned: 0, streak: 0, timeLeft: 0, limit: 0, dest: null, fare: null, text: null, urgent: false };
  const shown = { phase: '', sec: -2, fares: -1, earned: -1, streak: -1, hasFare: false };
  const mk = [{ x: 0, z: 0, kind: MARKER_FARE, label: '乘客' }, { x: 0, z: 0, kind: MARKER_DEST, label: '' }];
  const beaconOut = { dest: null };

  function toast(ctx, text, seconds) {
    if (ctx && typeof ctx.toast === 'function') ctx.toast(text, seconds);
    else emit('toast', { text, seconds });
  }

  function dropFare(how) {
    if (fare.h && world) {
      if (how === 'alight' && typeof world.alight === 'function') world.alight(fare.h, { x: fare.x, z: fare.z });
      else if (typeof world.remove === 'function') world.remove(fare.h);
    }
    fare.h = null;
  }

  // 開始條件（純函式，main.js 互動鍵仲裁用）→ { ok, reason }；reason ∈ active / notTaxi / busy / stalled / overturned
  function canStart(ctx = {}) {
    if (phase !== 'idle') return { ok: false, reason: 'active' };
    if (!ctx.inTaxi) return { ok: false, reason: 'notTaxi' };
    if (ctx.busy) return { ok: false, reason: 'busy' };
    if (ctx.stalled) return { ok: false, reason: 'stalled' };
    if (ctx.overturned) return { ok: false, reason: 'overturned' };
    return { ok: true, reason: null };
  }

  // 開始：ctx 省略時不檢查條件（測試 / 除錯）
  function start(ctx = null) {
    if (phase !== 'idle') return false;
    if (ctx) {
      const c = canStart(ctx);
      if (!c.ok) {
        if (c.reason === 'busy') toast(ctx, TOAST_BUSY, 3);
        else if (c.reason === 'stalled') toast(ctx, TOAST_STALLED, 3);
        else if (c.reason === 'overturned') toast(ctx, TOAST_OVERTURNED, 3);
        return false;
      }
    }
    phase = 'seek';
    leftT = 0;
    retryT = 0;
    fares = 0;
    earned = 0;
    streak = 0;
    fare.h = null;
    trip.dest = null;
    trip.car = null;
    emit('taxi:start', {});
    if (ctx) toast(ctx, '計程車載客開始：找路邊招手的乘客（小地圖黃點）', 4);
    return true;
  }

  // 結束（reason ∈ END_REASONS）；cancel 不 toast。回傳是否真的結束了進行中的任務
  function end(reason = 'cancel', ctx = lastCtx) {
    if (phase === 'idle') return false;
    dropFare('remove');
    const out = { reason, fares, earned, streak };
    phase = 'idle';
    trip.dest = null;
    trip.car = null;
    leftT = 0;
    emit('taxi:end', out);
    if (reason !== 'cancel') toast(ctx, toastEnd(reason, fares, earned), 5);
    return true;
  }

  function board(ctx, px, pz) {
    if (world && typeof world.board === 'function') world.board(fare.h);
    from.x = px;
    from.z = pz;
    const dest = pickDestination(cfg.rng, from, cfg.destinations, cfg.tripMin, cfg.tripMax);
    let dist = null;
    if (ctx && typeof ctx.routeLength === 'function') dist = ctx.routeLength(from, dest);
    if (!(Number.isFinite(dist) && dist > 0)) dist = Math.hypot(dest.x - px, dest.z - pz) * cfg.routeFactor;
    trip.dest = dest;
    trip.dist = dist;
    trip.limit = tripLimit(dist, cfg.tripSpeed, cfg.tripExtra);
    trip.timeLeft = trip.limit;
    trip.boardHealth = Number.isFinite(ctx.health) ? ctx.health : null;
    trip.car = ctx.car ?? null;
    trip.fromX = px;
    trip.fromZ = pz;
    phase = 'ride';
    emit('taxi:pickup', { dest: dest.name, x: dest.x, z: dest.z, dist, limit: trip.limit });
    toast(ctx, `乘客上車：前往${dest.name}（限時 ${Math.ceil(trip.limit)} 秒）`, 4);
  }

  function fail(ctx, reason) {
    dropFare('alight');
    const out = { reason, dest: trip.dest ? trip.dest.name : null, streak };
    streak = 0;
    trip.dest = null;
    trip.car = null;
    phase = 'seek';
    retryT = cfg.retrySec;
    emit('taxi:failed', out);
    toast(ctx, FAIL_TEXT[reason] || reason, 4);
  }

  function pay(ctx) {
    const meter = meterFare(trip.dist, cfg.baseFare, cfg.perKm);
    const tip = tipFor(meter, trip.timeLeft, trip.limit, cfg.tipRatio);
    streak++;
    const bonus = streakBonus(meter + tip, streak, cfg.streakStep, cfg.streakMax);
    const total = meter + tip + bonus;
    fares++;
    earned += total;
    if (ctx && typeof ctx.earn === 'function') ctx.earn(total);
    const out = { dest: trip.dest.name, dist: trip.dist, meter, tip, bonus, total, streak, fares, timeLeft: trip.timeLeft };
    dropFare('alight');
    trip.dest = null;
    trip.car = null;
    phase = 'seek';
    retryT = cfg.retrySec;
    emit('taxi:paid', out);
    toast(ctx, toastPaid(out), 5);
    return out;
  }

  function refreshSnap() {
    const on = phase !== 'idle';
    snap.active = on;
    snap.phase = phase;
    snap.fares = fares;
    snap.earned = earned;
    snap.streak = streak;
    snap.timeLeft = phase === 'ride' ? trip.timeLeft : 0;
    snap.limit = phase === 'ride' ? trip.limit : 0;
    snap.dest = phase === 'ride' ? trip.dest : null;
    snap.fare = phase === 'seek' && fare.h ? fare : null;
    snap.urgent = phase === 'ride' && trip.timeLeft <= cfg.urgentSec;
    // 文字只在顯示內容變化時重建（整秒）
    const sec = phase === 'ride' ? Math.max(0, Math.ceil(trip.timeLeft - 1e-9)) : -1;
    const hasFare = !!fare.h;
    if (shown.phase !== phase || shown.sec !== sec || shown.fares !== fares || shown.earned !== earned || shown.streak !== streak || shown.hasFare !== hasFare) {
      shown.phase = phase;
      shown.sec = sec;
      shown.fares = fares;
      shown.earned = earned;
      shown.streak = streak;
      shown.hasFare = hasFare;
      if (!on) snap.text = null;
      else if (phase === 'ride') snap.text = `計程車｜前往 ${trip.dest.name}｜剩 ${formatClock(trip.timeLeft)}｜連載 ${streak}｜NT$${earned}`;
      else snap.text = `計程車｜${fare.h ? '開到招手乘客旁停車' : '尋找乘客中…'}｜已載 ${fares} 趟｜NT$${earned}`;
    }
    return snap;
  }

  function update(dt, ctx = {}) {
    dt = Number.isFinite(dt) ? clamp(dt, 0, cfg.maxDt) : 0;
    lastCtx = ctx;
    if (ctx.world) world = ctx.world;
    if (phase === 'idle') return refreshSnap();
    const p = ctx.player || {};
    const px = Number(p.x);
    const pz = Number(p.z);
    if (!Number.isFinite(px) || !Number.isFinite(pz)) return refreshSnap();

    if (ctx.wrecked) {
      end('wrecked', ctx);
      return refreshSnap();
    }
    // 載客中換開另一台計程車：視同下車（耐久比較只對上車那台車）
    const inTaxi = !!ctx.inTaxi && !(phase === 'ride' && trip.car != null && ctx.car != null && ctx.car !== trip.car);
    if (inTaxi) leftT = 0;
    else {
      leftT += dt;
      if (leftT > cfg.leftSec) {
        end('left', ctx);
        return refreshSnap();
      }
    }
    const speed = Math.abs(Number(ctx.speed) || 0);

    if (phase === 'seek') {
      if (fare.h) {
        const st = world && typeof world.state === 'function' ? world.state(fare.h) : null;
        if (!st || !st.exists) dropFare('remove'); // 被嚇跑 / 回收：交還 handle（world.remove 對失效 handle 安全）後重找
        else {
          fare.x = st.x;
          fare.z = st.z;
          const d2 = (fare.x - px) ** 2 + (fare.z - pz) ** 2;
          if (d2 > cfg.fareLost * cfg.fareLost) {
            dropFare('remove');
            retryT = 0;
          } else if (inTaxi && d2 <= cfg.boardRadius * cfg.boardRadius && speed < cfg.boardMaxSpeed) board(ctx, px, pz);
        }
      }
      if (phase === 'seek' && !fare.h) {
        retryT -= dt;
        if (retryT <= 0) {
          retryT = cfg.retrySec;
          if (inTaxi && world && typeof world.spawnFare === 'function') {
            center.x = px;
            center.z = pz;
            const h = world.spawnFare(center, cfg.fareMin, cfg.fareMax);
            if (h) {
              fare.h = h;
              const st = typeof world.state === 'function' ? world.state(h) : null;
              fare.x = st && st.exists ? st.x : px;
              fare.z = st && st.exists ? st.z : pz;
              emit('taxi:fare', { x: fare.x, z: fare.z });
            }
          }
        }
      }
      return refreshSnap();
    }

    // ride：乘客在車上（下車點 = 當下車位）
    fare.x = px;
    fare.z = pz;
    trip.timeLeft -= dt;
    const mh = Number(ctx.maxHealth);
    const hp = inTaxi ? ctx.health : null;
    if (trip.boardHealth == null && Number.isFinite(hp)) trip.boardHealth = hp;
    if (trip.boardHealth != null && Number.isFinite(hp) && mh > 0 && trip.boardHealth - hp > cfg.damageLimit * mh) {
      fail(ctx, 'damaged');
      return refreshSnap();
    }
    if (trip.timeLeft <= 0) {
      trip.timeLeft = 0;
      fail(ctx, 'timeout');
      return refreshSnap();
    }
    const d = trip.dest;
    if (inTaxi && (d.x - px) ** 2 + (d.z - pz) ** 2 <= cfg.arriveRadius * cfg.arriveRadius && speed < cfg.arriveMaxSpeed) pay(ctx);
    return refreshSnap();
  }

  // 小地圖 / 大地圖標記（重用物件）：招手乘客 'taxi-fare'；載客中目的地 'taxi-dest'
  function markers(out = []) {
    if (phase === 'seek' && fare.h) {
      mk[0].x = fare.x;
      mk[0].z = fare.z;
      out.push(mk[0]);
    } else if (phase === 'ride' && trip.dest) {
      mk[1].x = trip.dest.x;
      mk[1].z = trip.dest.z;
      mk[1].label = trip.dest.name;
      out.push(mk[1]);
    }
    return out;
  }

  // 光柱目標：載客中 → 目的地；其餘 null（同一 dest 物件直到換點，整合層比對 identity 決定重放）
  function beacons() {
    beaconOut.dest = phase === 'ride' ? trip.dest : null;
    return beaconOut;
  }

  const cancel = () => end('cancel');
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
    beacons,
    dispose,
    snapshot: refreshSnap,
    get active() {
      return phase !== 'idle';
    },
    get phase() {
      return phase;
    },
    get fares() {
      return fares;
    },
    get earned() {
      return earned;
    },
    get streak() {
      return streak;
    },
    get fare() {
      return fare.h ? fare : null;
    },
    get dest() {
      return trip.dest;
    },
    get trip() {
      return trip;
    },
  };
}

// ---------- 路邊行人世界介面（整合層用；只依賴注入的 traffic / combat，不 import three / rapier）----------
// createCurbPedWorld({ traffic, combat?, rng?, getPlayer?, spawnWalker? }) → taxi world + ems world 共用：
//   spawnFare(center, rMin, rMax) → h | null：徵用 rMin–rMax 內漫步中的骨架行人（traffic.peds：walk / wander、無 override、非幫派、combat normal），
//     brain.override 改為原地站立、面向玩家、每 WAVE_SEC 揮手（anim.playGesture('wave')）
//   spawnPatient(center, rMin, rMax) → h | null：同條件徵用 → combat.knockdownActor 倒地；update 時刷新倒地計時（不自行起身）
//   徵用期間 citizen.pinned = true（traffic 依距離 / 密度回收時跳過）；board / remove 解除
//   state(h) → { x, z, exists }（重用物件；行人被回收 / 換骨架 / 死亡（含 dying，一經判定即不再復活回任務）→ exists false）
//   board(h)：上車（traffic._recyclePed：人消失於車內）；alight(h, at)：下車（spawnWalker 有給才在 at 生成路人，否則無）
//   remove(h)：任務結束 → 解除 override / pinned（招手者繼續走路）、傷患不再壓住倒地計時（照 combat 正常起身）
//   update(dt)：錯開 PATIENT_HOLD_SEC 刷新傷患倒地計時；傷患若已被 combat 扶起（getup / normal / hit）→ 再 knockdownActor 壓回倒地
//     （整合層在手機 / 暫停 / 噴漆中也要每幀呼叫：世界照跑時 combat 仍會推進起身）；dispose()：全部 remove
export const WAVE_SEC = 2.6; // s，招手間隔
export const PATIENT_HOLD_SEC = 0.5; // s，傷患倒地計時刷新間隔（< combat GETUP_MIN_DOWN 1.5 s）
export const PATIENT_IMPULSE = 25; // 倒地水平衝量（輕推，倒在原地附近）

export function createCurbPedWorld({ traffic = null, combat = null, rng = Math.random, getPlayer = () => null, spawnWalker = null } = {}) {
  const live = new Set();
  const buf = [];
  const st = { x: NaN, z: NaN, exists: false };
  let holdAcc = 0;
  const rnd = () => clamp(Number(rng()) || 0, 0, 0.999999);
  const valid = (h) => !!h && !!h.p && h.p.alive !== false && h.p.citizen === h.c && !!h.p.actor && h.p.actor.id === h.id;
  // 死亡（dying / dead）一經判定即黏住：traffic 的 dead → revive 會把人原地扶回，不得讓傷患「復活」回任務
  const isDead = (h) => {
    if (h.dead) return true;
    if (!combat) return false;
    const e = combat.entries && typeof combat.entries.get === 'function' ? combat.entries.get(h.id) : null;
    if ((e && e.dying) || (typeof combat.stateOf === 'function' && combat.stateOf(h.p.actor) === 'dead')) h.dead = true;
    return h.dead;
  };
  const pin = (h, on) => {
    if (h.c) h.c.pinned = on;
  };

  function idle(p) {
    if (!p || p.alive === false || !p.actor || !p.brain || !p.citizen) return false;
    if (p.state !== 'walk' || p.pendingFrom || p.brain.override || p.citizen.gang || p.brain.state !== 'wander') return false;
    return !combat || typeof combat.stateOf !== 'function' || combat.stateOf(p.actor) === 'normal';
  }

  function pick(center, rMin, rMax) {
    buf.length = 0;
    if (!traffic || !traffic.peds || !center) return null;
    const a2 = rMin * rMin;
    const b2 = rMax * rMax;
    for (const p of traffic.peds) {
      if (!idle(p)) continue;
      let taken = false;
      for (const h of live) if (h.p === p) taken = true;
      if (taken) continue;
      const d2 = (p.x - center.x) ** 2 + (p.z - center.z) ** 2;
      if (d2 >= a2 && d2 <= b2) buf.push(p);
    }
    if (!buf.length) return null;
    return buf[Math.floor(rnd() * buf.length)];
  }

  function spawnFare(center, rMin, rMax) {
    const p = pick(center, rMin, rMax);
    if (!p) return null;
    const h = { kind: 'fare', p, c: p.citizen, id: p.actor.id, wave: 0, drive: null, dead: false };
    h.drive = (brain, dt, ctx, it) => {
      if (!valid(h)) return false;
      it.moveX = 0;
      it.moveZ = 0;
      it.run = false;
      const pl = getPlayer();
      if (pl && Number.isFinite(pl.x)) it.faceYaw = Math.atan2(pl.x - h.p.x, pl.z - h.p.z);
      h.wave -= dt;
      if (h.wave <= 0) {
        h.wave = WAVE_SEC;
        if (h.p.anim && typeof h.p.anim.playGesture === 'function') h.p.anim.playGesture('wave');
      }
      return true;
    };
    p.brain.override = h.drive;
    pin(h, true);
    live.add(h);
    return h;
  }

  function spawnPatient(center, rMin, rMax) {
    const p = pick(center, rMin, rMax);
    if (!p || !combat || typeof combat.knockdownActor !== 'function') return null;
    const a = rnd() * Math.PI * 2;
    const ok = combat.knockdownActor(p.actor, { cause: 'fall', impulse: { x: Math.sin(a) * PATIENT_IMPULSE, y: PATIENT_IMPULSE * 0.2, z: Math.cos(a) * PATIENT_IMPULSE } });
    if (!ok) return null;
    const h = { kind: 'patient', p, c: p.citizen, id: p.actor.id, wave: 0, drive: null, dead: false };
    pin(h, true);
    live.add(h);
    return h;
  }

  function state(h) {
    if (!h || !live.has(h) || !valid(h) || isDead(h)) {
      st.x = NaN;
      st.z = NaN;
      st.exists = false;
      return st;
    }
    st.x = h.p.x;
    st.z = h.p.z;
    st.exists = true;
    return st;
  }

  function unhook(h) {
    pin(h, false);
    if (valid(h) && h.drive && h.p.brain && h.p.brain.override === h.drive) h.p.brain.override = null;
  }

  function board(h) {
    if (!h || !live.has(h)) return;
    live.delete(h);
    unhook(h);
    if (valid(h) && traffic && typeof traffic._recyclePed === 'function') traffic._recyclePed(h.c);
  }

  function alight(h, at) {
    if (h && live.has(h)) remove(h);
    if (typeof spawnWalker === 'function' && at) spawnWalker(at);
  }

  function remove(h) {
    if (!h || !live.has(h)) return;
    live.delete(h);
    unhook(h);
  }

  // 傷患倒地：combat GETUP_MIN_DOWN 後會嘗試起身 → 錯開刷新 stateAt（同 traffic.spawnEjectedDriver 直接改 combat 狀態的做法）；
  // 已被扶起（刷新漏接 / 其他系統改了狀態）→ 立即壓回倒地（每幀檢查，起身動作不會播完）
  function update(dt) {
    holdAcc += Number.isFinite(dt) ? dt : 0;
    const refresh = holdAcc >= PATIENT_HOLD_SEC;
    if (refresh) holdAcc = 0;
    if (!combat || !combat.entries || typeof combat.now !== 'function') return;
    const t = combat.now();
    for (const h of live) {
      if (h.kind !== 'patient' || !valid(h) || isDead(h)) continue;
      const e = combat.entries.get(h.id);
      if (!e) continue;
      if (e.state === 'knockdown') {
        if (refresh) e.stateAt = t;
      } else if (e.state !== 'dead' && typeof combat.knockdownActor === 'function') {
        const a = rnd() * Math.PI * 2;
        combat.knockdownActor(h.p.actor, { cause: 'fall', impulse: { x: Math.sin(a) * PATIENT_IMPULSE * 0.2, y: PATIENT_IMPULSE * 0.2, z: Math.cos(a) * PATIENT_IMPULSE * 0.2 } });
      }
    }
  }

  function dispose() {
    for (const h of [...live]) remove(h);
  }

  return { spawnFare, spawnPatient, state, board, alight, remove, update, dispose, live };
}

// ---------- 副任務任務條（DOM；root 由整合層給，.taxi- / .ems- 前綴樣式在 src/style.css）----------
// createSideJobBar({ root, prefix: 'taxi' | 'ems' }) → { set(text | null, urgent), dispose(), el }：同警車任務條（.vig-bar）膠囊樣式；剩秒數少 → .<prefix>-urgent
export function createSideJobBar({ root = null, prefix = 'taxi', doc = (root && root.ownerDocument) || globalThis.document } = {}) {
  if (!doc || typeof doc.createElement !== 'function') return { set() {}, dispose() {} };
  const el = doc.createElement('div');
  el.className = `${prefix}-bar`;
  el.hidden = true;
  (root || doc.body).appendChild(el);
  let last = null;
  let lastUrgent = false;
  const urgentCls = `${prefix}-urgent`;
  return {
    set(t, urgent = false) {
      urgent = !!urgent && t != null;
      if (t === last && urgent === lastUrgent) return;
      last = t;
      lastUrgent = urgent;
      el.hidden = t == null;
      if (t != null) el.textContent = t;
      el.className = urgent ? `${prefix}-bar ${urgentCls}` : `${prefix}-bar`;
    },
    dispose() {
      el.remove();
    },
    el,
  };
}
