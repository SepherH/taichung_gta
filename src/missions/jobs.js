// 打工委託（契約 §23.4，category 'job'）：可重複、有冷卻、計入委託統計；純邏輯（不 import three / DOM / daynight / navigation），由 missions/index.js createMissions 建立並合併
// 題材虛構：攤位 / 客人 / 泊車亭皆為遊戲內虛構店家，不影射真實品牌
// 接單點以「道具鍵名」描述（propKey / fallbackPropKey；fallback null = 程式幾何）：實際擺放與載入由整合層（main.js）做，本模組只吃 jobSpots 座標
//
// (a) 夜市攤位跑單 NIGHT_MARKET_RUN：遊戲時刻 18–24（window）、攤主側 jobSpots.stallBack 2.5 m 內按 E 接單（與外送取餐點 radius 12 重疊時打工優先）
//   → 以 jobSpots.sidewalkNear(stall.x, stall.z, rng, 40, 160) 隨機 2–3 位客人（彼此 ≥ 20 m；不足 2 位 → 不接單）
//   → 每位客人 3 m 內按 E 送達（順序不限）；只限步行：ctx.driving 連續 > 3 s → fail 'vehicle'
//   時限 = Σ 路段直線 × 1.3 / 3.5 m/s + 20 s（路段 = 攤位起最近鄰排序的直線距離）；報酬 = Σ 每位 (80 + 0.25 × 路段 m) + 全送完剩餘秒 × 1（完成才入帳）
//   失敗 'timeout'|'vehicle'|'ko'|'abandon'（不扣錢、已送部分不計酬）；冷卻 150 s、失敗 60 s；出了時段仍可跑完本趟
// (b) 代客泊車 VALET_PARKING：不限時段；任一泊車亭 jobSpots.valet[i] 的 (standX, standZ) 2.5 m 內按 E → spawnValetCar({ x: carX, z: carZ, yaw: carYaw })
//   指定車辨識 = 回傳的 vehicle 物件參照（ctx.vehicle === car）；未上車 stage 'car'（標記 job-car）、上車後 stage 'park'（標記 job-dest = 車格）
//   停妥：車中心到車格中心 ≤ 1.2 m、|angleDelta(car.yaw, slotYaw)| ≤ 15°、|car.speed| ≤ 0.5 m/s、玩家正駕駛該車——同時成立連續 1.0 s（模擬時間）
//   失敗：車毀（bus 'vehicle:disabled' 且 vehicle === car，或 healthOf(car) === 0）→ 'destroyed'；逾時（時限 = 路線長 / 8 m/s + 45 s）→ 'timeout'；
//     玩家不在該車上且與車距離 > 40 m 連續 5 s → 'lost'；'ko' / 'abandon' 同委託
//   報酬 = 300 × (1 − 損壞比 × 0.7) + 剩餘秒 × 2；損壞比 = 1 − healthOf(car) / 接單時 healthOf(car)（未注入 / 讀不到 → 0）；結束（成功或失敗）一律 releaseValetCar(car)
//   冷卻 120 s、失敗 60 s
// 時間：時限 / 停妥維持 / 駕駛寬限 / 離車計時一律累加 update(simDt)（§20）；冷卻用注入 now()（= gameTime，模擬時間）；門檻比較帶 1e-6 容差（子步累加的浮點誤差不改變判定幀）
//
// 對外 API（createJobs 回傳）：
//   update(simDt, ctx)：ctx = { x, z, driving, vehicle: 駕駛中的 Vehicle | null, gameHour? }
//   nearest(pos) → interactable { id: 'job:<id>' | 'job:<id>:deliver', text, dist, priority: 3, act() } 或 null
//   markers() → [{ x, z, kind: 'job-start'|'job-dest'|'job-car', label }]（陣列 / 物件重用）；markersVersion() → 標記集合變動計數（光柱同步用）
//   objective() → { text, timerSec, distM, rewardNow } 或 null；active() → { id, kind: 'run'|'valet', stage, to, limitSec, elapsedSec, timerSec, delivered, total } 或 null
//   listings(pos, out = []) → 附加 [{ id, title, category: 'job', reward（預估）, distanceM, navigable, x, z, active }] 到 out（物件重用）並回傳 out
//   isEngaged()、isOpen(id)、onPlayerKo()、onVehicleDisabled(vehicle)、abandon()、serialize() → { completed: { id: n }, cooldowns: { id: 剩餘秒 } }、restore(data)、dispose()
// 事件（bus）：job:available { id, title, x, z } / job:start { id, title, limitSec } / job:stage { id, stage, text, x, z }
//   / job:complete { id, reward, timeSec, leftSec } / job:fail { id, reason } / nav:destination、nav:clear（source 'job'）/ ui:sound；訂閱 vehicle:disabled（bus.on 存在時）

export const JOB_PRIORITY = 3; // 與委託 / 事件同級（§17 interactable 仲裁）
export const EPS = 1e-6;

export const NIGHT_MARKET_RUN = {
  id: 'night-market-run',
  category: 'job',
  title: '夜市攤位跑單',
  window: { start: 18, end: 24 },
  cooldownSec: 150,
  failCooldownSec: 60,
  propKey: 'night_market_stall_oyster', // 接單攤位道具（另一攤 'night_market_stall_tea'）；缺 → fallbackPropKey
  altPropKeys: ['night_market_stall_tea'],
  fallbackPropKey: 'night_market_stall',
  stallName: '阿嬤蚵仔煎＆珍奶攤', // 虛構攤名
  startRadius: 2.5,
  deliverRadius: 3,
  customersMin: 2,
  customersMax: 3,
  customerMinM: 40,
  customerMaxM: 160,
  customerGapM: 20,
  customerTries: 8, // 每位客人最多向 sidewalkNear 要幾次點
  legK: 1.3,
  walkSpeed: 3.5,
  slackSec: 20,
  perCustomer: 80,
  perM: 0.25,
  perLeftSec: 1,
  vehicleGraceSec: 3,
  estimateReward: 263, // 列表預估：2.5 位 × (80 + 0.25 × 100 m)
  foods: ['蚵仔煎', '珍珠奶茶', '大腸麵線', '鹽酥雞', '烤玉米'],
};

export const VALET_PARKING = {
  id: 'valet-parking',
  category: 'job',
  title: '代客泊車',
  window: null, // 不限時段
  cooldownSec: 120,
  failCooldownSec: 60,
  propKey: 'valet_stand',
  fallbackPropKey: null, // null = 程式幾何
  standName: '星光飯店泊車亭', // 虛構
  startRadius: 2.5,
  parkDistM: 1.2,
  parkAngleDeg: 15,
  parkSpeed: 0.5,
  parkHoldSec: 1.0,
  routeK: 1.3, // 無 routeLength 時直線 × 1.3
  limitSpeed: 8,
  slackSec: 45,
  lostM: 40,
  lostSec: 5,
  baseReward: 300,
  damageCut: 0.7,
  perLeftSec: 2,
  estimateReward: 340,
};

export const JOB_DEFS = [NIGHT_MARKET_RUN, VALET_PARKING];

const defaultNow = () => (globalThis.performance && performance.now ? performance.now() : Date.now()) / 1000;
const validPoint = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.z);
const angleWrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// 時刻是否落在 [start, end)；end < start 跨午夜；同 events.js inHourWindow（為保持本檔不依賴他檔，另寫一份）
export function jobInWindow(hour, w) {
  if (!w) return true;
  const h = Number(hour);
  if (!Number.isFinite(h)) return false;
  const hh = ((h % 24) + 24) % 24;
  const s = ((Number(w.start) % 24) + 24) % 24;
  const e = Number(w.end) === 24 ? 24 : ((Number(w.end) % 24) + 24) % 24;
  if (s === e) return true;
  return s < e ? hh >= s && hh < e : hh >= s || hh < e;
}

// 兩角差（度，−180–180）
export function angleDeltaDeg(a, b) {
  return (angleWrap(a - b) * 180) / Math.PI;
}

export function runTimeLimit(legsM, def = NIGHT_MARKET_RUN) {
  let sum = 0;
  for (const l of legsM) sum += Math.max(0, Number(l) || 0);
  return Math.ceil((sum * def.legK) / def.walkSpeed + def.slackSec);
}

export function runReward(legsM, leftSec, allDone = true, def = NIGHT_MARKET_RUN) {
  let r = 0;
  for (const l of legsM) r += def.perCustomer + def.perM * Math.max(0, Number(l) || 0);
  if (allDone) r += Math.max(0, Number(leftSec) || 0) * def.perLeftSec;
  return Math.round(r);
}

export function valetTimeLimit(routeM, def = VALET_PARKING) {
  return Math.ceil(Math.max(0, Number(routeM) || 0) / def.limitSpeed + def.slackSec);
}

export function valetReward(damageRatio, leftSec, def = VALET_PARKING) {
  const dmg = clamp01(Number(damageRatio) || 0);
  return Math.max(0, Math.round(def.baseReward * (1 - dmg * def.damageCut) + Math.max(0, Number(leftSec) || 0) * def.perLeftSec));
}

// 停妥判定（不含維持秒數）：car = { x, z, yaw, speed }、slot = { slotX, slotZ, slotYaw }
export function isParked(car, slot, inCar, def = VALET_PARKING) {
  if (!inCar || !car || !slot) return false;
  const d = Math.hypot(car.x - slot.slotX, car.z - slot.slotZ);
  if (d > def.parkDistM + EPS) return false;
  if (Math.abs(angleDeltaDeg(car.yaw, slot.slotYaw)) > def.parkAngleDeg + EPS) return false;
  return Math.abs(Number(car.speed) || 0) <= def.parkSpeed + EPS;
}

export function createJobs({
  bus = null,
  now = defaultNow,
  rng = Math.random,
  addMoney = () => {},
  getGameHour = null,
  spots = null,
  spawnValetCar = null,
  releaseValetCar = null,
  healthOf = null,
  routeLength = null,
  isBusy = () => false,
  defs = JOB_DEFS,
  isTouch = false,
  interactLabel = isTouch ? '點「互動」鈕' : '按 E',
} = {}) {
  const emit = (name, payload) => {
    if (bus && typeof bus.emit === 'function') bus.emit(name, payload);
  };
  const list = Array.isArray(defs) ? defs : [];
  const runDef = list.find((d) => d && d.id === NIGHT_MARKET_RUN.id) || null;
  const valetDef = list.find((d) => d && d.id === VALET_PARKING.id) || null;
  const sp = spots && typeof spots === 'object' ? spots : {};
  const stallBack = validPoint(sp.stallBack) ? sp.stallBack : null;
  const stall = validPoint(sp.stall) ? sp.stall : stallBack;
  const stands = (Array.isArray(sp.valet) ? sp.valet : []).filter(
    (v) => v && [v.standX, v.standZ, v.carX, v.carZ, v.slotX, v.slotZ].every(Number.isFinite),
  );
  // 缺任一注入 → 該打工不作用
  const runOk = !!(runDef && stallBack && stall && typeof sp.sidewalkNear === 'function');
  const valetOk = !!(valetDef && stands.length && typeof spawnValetCar === 'function' && typeof releaseValetCar === 'function');
  const byId = new Map();
  if (runOk) byId.set(runDef.id, runDef);
  if (valetOk) byId.set(valetDef.id, valetDef);

  const completed = Object.create(null);
  const cooldownUntil = Object.create(null);
  const open = new Set();
  let run = null; // 夜市：{ def, kind: 'run', customers:[{x,z,leg,done}], legs, limit, elapsed, drivingT, delivered }；泊車：{ def, kind: 'valet', stand, car, h0, routeM, limit, elapsed, stage, holdT, lostT }
  let hourNow = null;
  let hasPos = false;
  let px = 0;
  let pz = 0;
  let disposed = false;
  let version = 0;

  const carPos = { x: 0, z: 0, yaw: 0, speed: 0 };
  const markerPool = [];
  for (let i = 0; i < 1 + stands.length + 4; i++) markerPool.push({ x: 0, z: 0, kind: 'job-start', label: '' });
  const markerList = [];
  const objectiveOut = { text: '', timerSec: 0, distM: null, rewardNow: 0 };
  const activeOut = { id: '', kind: 'run', stage: '', to: null, limitSec: 0, elapsedSec: 0, timerSec: 0, delivered: 0, total: 0 };
  const activeTo = { x: 0, z: 0 };
  const listPool = [];
  const inters = {
    run: runOk ? { id: `job:${runDef.id}`, text: `按 E 接打工：${runDef.title}（${runDef.stallName}）`, dist: 0, priority: JOB_PRIORITY, act: () => startRun() } : null,
    valet: valetOk ? { id: `job:${valetDef.id}`, text: `按 E 接打工：${valetDef.title}（${valetDef.standName}）`, dist: 0, priority: JOB_PRIORITY, act: () => startValet(nearStand) } : null,
    deliver: runOk ? { id: `job:${runDef.id}:deliver`, text: '按 E 送餐給客人', dist: 0, priority: JOB_PRIORITY, act: () => deliver(nearCustomer) } : null,
  };
  let nearStand = null;
  let nearCustomer = null;

  const isCooling = (id) => cooldownUntil[id] !== undefined && cooldownUntil[id] > now();

  function readHour(ctx) {
    if (ctx && Number.isFinite(ctx.gameHour)) return ctx.gameHour;
    if (typeof getGameHour === 'function') {
      const h = Number(getGameHour());
      if (Number.isFinite(h)) return h;
    }
    return null;
  }

  function busy() {
    try {
      return typeof isBusy === 'function' && !!isBusy();
    } catch {
      return false;
    }
  }

  function shouldOpen(d) {
    if (run || isCooling(d.id) || busy()) return false;
    if (d.window) return hourNow !== null && jobInWindow(hourNow, d.window);
    return true;
  }

  function syncOpen() {
    for (const d of byId.values()) {
      const want = shouldOpen(d);
      if (want && !open.has(d.id)) {
        open.add(d.id);
        version++;
        const p = d === runDef ? stallBack : { x: stands[0].standX, z: stands[0].standZ };
        emit('job:available', { id: d.id, title: d.title, x: p.x, z: p.z });
      } else if (!want && open.has(d.id)) {
        open.delete(d.id);
        version++;
      }
    }
  }

  function readCar() {
    const c = run && run.car;
    if (!c) return null;
    const p = validPoint(c.pos) ? c.pos : c;
    carPos.x = p.x;
    carPos.z = p.z;
    carPos.yaw = Number(c.yaw) || 0;
    carPos.speed = Number(c.speed) || 0;
    return validPoint(carPos) ? carPos : null;
  }

  function health(car) {
    if (typeof healthOf !== 'function') return null;
    try {
      const h = Number(healthOf(car));
      return Number.isFinite(h) ? h : null;
    } catch {
      return null;
    }
  }

  function measure(a, b, k) {
    if (typeof routeLength === 'function') {
      try {
        const r = routeLength(a, b);
        const len = r && typeof r === 'object' ? r.lengthM : r;
        if (Number.isFinite(len) && len > 0) return len;
      } catch {
        /* 路網查詢失敗 → 直線估算 */
      }
    }
    return Math.hypot(b.x - a.x, b.z - a.z) * k;
  }

  const rand = () => Math.min(0.999999, Math.max(0, Number(rng()) || 0));

  // ---------- 夜市跑單 ----------
  function pickCustomers(d) {
    const want = d.customersMin + Math.floor(rand() * (d.customersMax - d.customersMin + 1));
    const pts = [];
    for (let i = 0; i < want; i++) {
      for (let t = 0; t < d.customerTries; t++) {
        let p = null;
        try {
          p = sp.sidewalkNear(stall.x, stall.z, rng, d.customerMinM, d.customerMaxM);
        } catch {
          p = null;
        }
        if (!validPoint(p)) continue;
        if (pts.every((q) => Math.hypot(q.x - p.x, q.z - p.z) >= d.customerGapM)) {
          pts.push({ x: p.x, z: p.z });
          break;
        }
      }
    }
    if (pts.length < d.customersMin) return null;
    // 攤位起最近鄰排序 → 路段
    const out = [];
    let cx = stallBack.x;
    let cz = stallBack.z;
    while (pts.length) {
      let bi = 0;
      let bd = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const dd = Math.hypot(pts[i].x - cx, pts[i].z - cz);
        if (dd < bd) {
          bd = dd;
          bi = i;
        }
      }
      const p = pts.splice(bi, 1)[0];
      out.push({ x: p.x, z: p.z, leg: bd, done: false, food: d.foods[Math.floor(rand() * d.foods.length)] || '餐點' });
      cx = p.x;
      cz = p.z;
    }
    return out;
  }

  function nextCustomer() {
    let best = null;
    let bd = Infinity;
    for (const c of run.customers) {
      if (c.done) continue;
      const dd = hasPos ? Math.hypot(c.x - px, c.z - pz) : 0;
      if (dd < bd) {
        bd = dd;
        best = c;
      }
    }
    return best;
  }

  function startRun() {
    const d = runDef;
    if (disposed || run || !open.has(d.id)) return false;
    const customers = pickCustomers(d);
    if (!customers) return false;
    const legs = customers.map((c) => c.leg);
    run = { def: d, kind: 'run', customers, legs, limit: runTimeLimit(legs, d), elapsed: 0, drivingT: 0, delivered: 0 };
    open.clear();
    version++;
    emit('ui:sound', { kind: 'confirm' });
    emit('job:start', { id: d.id, title: d.title, limitSec: run.limit, customers: customers.length });
    stageNext();
    return true;
  }

  function stageNext() {
    const c = nextCustomer();
    if (!c) return;
    const text = `把「${c.food}」送給客人（${run.delivered}/${run.customers.length}）`;
    emit('job:stage', { id: run.def.id, stage: 'deliver', text, x: c.x, z: c.z });
    emit('nav:destination', { x: c.x, z: c.z, label: '跑單客人', source: 'job' });
  }

  function deliver(c) {
    if (disposed || !run || run.kind !== 'run' || !c || c.done) return false;
    c.done = true;
    run.delivered++;
    version++;
    emit('ui:sound', { kind: 'confirm' });
    if (run.delivered >= run.customers.length) complete();
    else stageNext();
    return true;
  }

  // ---------- 代客泊車 ----------
  function startValet(stand) {
    const d = valetDef;
    if (disposed || run || !stand || !open.has(d.id)) return false;
    let car = null;
    try {
      car = spawnValetCar({ x: stand.carX, z: stand.carZ, yaw: Number(stand.carYaw) || 0 });
    } catch {
      car = null;
    }
    if (!car) return false;
    const routeM = measure({ x: stand.carX, z: stand.carZ }, { x: stand.slotX, z: stand.slotZ }, d.routeK);
    run = { def: d, kind: 'valet', stand, car, h0: health(car), routeM, limit: valetTimeLimit(routeM, d), elapsed: 0, stage: 'car', holdT: 0, lostT: 0 };
    open.clear();
    version++;
    emit('ui:sound', { kind: 'confirm' });
    emit('job:start', { id: d.id, title: d.title, limitSec: run.limit, routeM: Math.round(routeM) });
    setValetStage('car', true);
    return true;
  }

  function setValetStage(stage, force) {
    if (!force && run.stage === stage) return;
    run.stage = stage;
    version++;
    const s = run.stand;
    const c = readCar();
    if (stage === 'car') {
      const x = c ? c.x : s.carX;
      const z = c ? c.z : s.carZ;
      emit('job:stage', { id: run.def.id, stage: 'car', text: '走到指定車輛並上車', x, z });
    } else {
      emit('job:stage', { id: run.def.id, stage: 'park', text: '把車停進指定車格', x: s.slotX, z: s.slotZ });
      emit('nav:destination', { x: s.slotX, z: s.slotZ, label: '泊車車格', source: 'job' });
    }
  }

  function damageRatio() {
    if (!run || run.kind !== 'valet' || !(run.h0 > 0)) return 0;
    const h = health(run.car);
    return h === null ? 0 : clamp01(1 - h / run.h0);
  }

  function rewardNow() {
    if (!run) return 0;
    const left = Math.max(0, run.limit - run.elapsed);
    if (run.kind === 'run') return runReward(run.legs, left, true, run.def);
    return valetReward(damageRatio(), left, run.def);
  }

  // ---------- 結束 ----------
  function endRun() {
    const r = run;
    run = null;
    version++;
    if (r && r.kind === 'valet' && r.car) {
      try {
        releaseValetCar(r.car);
      } catch {
        /* 整合層回收失敗不影響結算 */
      }
    }
    emit('nav:clear', { source: 'job' });
    return r;
  }

  function complete() {
    const r = run;
    const d = r.def;
    const left = Math.max(0, r.limit - r.elapsed);
    const reward = r.kind === 'run' ? runReward(r.legs, left, true, d) : valetReward(damageRatio(), left, d);
    const out = { id: d.id, reward, timeSec: Math.round(r.elapsed * 10) / 10, leftSec: Math.round(left * 10) / 10 };
    if (r.kind === 'valet') out.damagePct = Math.round(damageRatio() * 100);
    endRun();
    completed[d.id] = (completed[d.id] || 0) + 1;
    if (d.cooldownSec > 0) cooldownUntil[d.id] = now() + d.cooldownSec;
    if (reward > 0) addMoney(reward, 'job');
    emit('job:complete', out);
    emit('ui:sound', { kind: 'reward' });
    syncOpen();
    return out;
  }

  function fail(reason) {
    if (!run) return;
    const d = run.def;
    endRun();
    if (d.failCooldownSec > 0) cooldownUntil[d.id] = now() + d.failCooldownSec;
    emit('job:fail', { id: d.id, reason });
    emit('ui:sound', { kind: 'fail' });
    syncOpen();
  }

  function onVehicleDisabled(vehicle) {
    if (run && run.kind === 'valet' && vehicle && vehicle === run.car) fail('destroyed');
  }
  const offDisabled = bus && typeof bus.on === 'function' ? bus.on('vehicle:disabled', (e) => onVehicleDisabled(e && e.vehicle)) : null;

  // ---------- 每幀 ----------
  function update(dt, ctx) {
    if (disposed) return;
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.5) : 0;
    let vehicle = null;
    let driving = false;
    if (ctx) {
      const p = Number.isFinite(ctx.x) ? ctx : ctx.pos || ctx.position || null;
      if (validPoint(p)) {
        px = p.x;
        pz = p.z;
        hasPos = true;
      }
      vehicle = ctx.vehicle || null;
      driving = !!ctx.driving;
    }
    hourNow = readHour(ctx);
    if (run) {
      run.elapsed += step;
      if (run.kind === 'run') {
        run.drivingT = driving ? run.drivingT + step : 0;
        if (run.elapsed >= run.limit - EPS) fail('timeout');
        else if (run.drivingT > run.def.vehicleGraceSec + EPS) fail('vehicle');
      } else updateValet(step, vehicle);
    }
    syncOpen();
  }

  function updateValet(step, vehicle) {
    const d = run.def;
    if (health(run.car) === 0) {
      fail('destroyed');
      return;
    }
    if (run.elapsed >= run.limit - EPS) {
      fail('timeout');
      return;
    }
    const inCar = vehicle !== null && vehicle === run.car;
    setValetStage(inCar ? 'park' : 'car', false);
    const c = readCar();
    if (!c) return;
    if (!inCar && hasPos && Math.hypot(c.x - px, c.z - pz) > d.lostM) {
      run.lostT += step;
      if (run.lostT >= d.lostSec - EPS) {
        fail('lost');
        return;
      }
    } else run.lostT = 0;
    if (isParked(c, run.stand, inCar, d)) {
      run.holdT += step;
      if (run.holdT >= d.parkHoldSec - EPS) complete();
    } else run.holdT = 0;
  }

  function nearest(pos) {
    if (disposed || !validPoint(pos)) return null;
    if (run) {
      if (run.kind !== 'run') return null;
      let best = null;
      let bd = Infinity;
      for (const c of run.customers) {
        if (c.done) continue;
        const dd = Math.hypot(c.x - pos.x, c.z - pos.z);
        if (dd <= run.def.deliverRadius && dd < bd) {
          bd = dd;
          best = c;
        }
      }
      if (!best) return null;
      nearCustomer = best;
      inters.deliver.dist = bd;
      return inters.deliver;
    }
    let best = null;
    let bd = Infinity;
    if (runOk && open.has(runDef.id)) {
      const dd = Math.hypot(stallBack.x - pos.x, stallBack.z - pos.z);
      if (dd <= runDef.startRadius && dd < bd) {
        bd = dd;
        best = inters.run;
      }
    }
    if (valetOk && open.has(valetDef.id)) {
      for (const s of stands) {
        const dd = Math.hypot(s.standX - pos.x, s.standZ - pos.z);
        if (dd <= valetDef.startRadius && dd < bd) {
          bd = dd;
          best = inters.valet;
          nearStand = s;
        }
      }
    }
    if (best) best.dist = bd;
    return best;
  }

  function pushMarker(i, x, z, kind, label) {
    const mk = markerPool[i];
    mk.x = x;
    mk.z = z;
    mk.kind = kind;
    mk.label = label;
    markerList.push(mk);
    return i + 1;
  }

  function markers() {
    markerList.length = 0;
    let i = 0;
    if (run && run.kind === 'run') {
      for (const c of run.customers) if (!c.done) i = pushMarker(i, c.x, c.z, 'job-dest', '跑單客人');
      return markerList;
    }
    if (run) {
      const c = readCar();
      if (run.stage === 'park') pushMarker(i, run.stand.slotX, run.stand.slotZ, 'job-dest', '泊車車格');
      else if (c) pushMarker(i, c.x, c.z, 'job-car', '指定車輛');
      return markerList;
    }
    if (runOk && open.has(runDef.id)) i = pushMarker(i, stallBack.x, stallBack.z, 'job-start', runDef.title);
    if (valetOk && open.has(valetDef.id)) for (const s of stands) i = pushMarker(i, s.standX, s.standZ, 'job-start', valetDef.title);
    return markerList;
  }

  function target() {
    if (!run) return null;
    if (run.kind === 'run') return nextCustomer();
    if (run.stage === 'park') {
      activeTo.x = run.stand.slotX;
      activeTo.z = run.stand.slotZ;
      return activeTo;
    }
    return readCar();
  }

  function objective() {
    if (!run) return null;
    const t = target();
    objectiveOut.timerSec = Math.max(0, run.limit - run.elapsed);
    objectiveOut.distM = t && hasPos ? Math.hypot(t.x - px, t.z - pz) : null;
    objectiveOut.rewardNow = rewardNow();
    if (run.kind === 'run') objectiveOut.text = `夜市跑單：送餐給客人（${run.delivered}/${run.customers.length}，別開車）`;
    else objectiveOut.text = run.stage === 'park' ? '代客泊車：停進車格並停穩 1 秒' : `代客泊車：走到指定車輛上車`;
    return objectiveOut;
  }

  function active() {
    if (!run) return null;
    const t = target();
    activeOut.id = run.def.id;
    activeOut.kind = run.kind;
    activeOut.stage = run.kind === 'run' ? 'deliver' : run.stage;
    activeOut.to = t;
    activeOut.limitSec = run.limit;
    activeOut.elapsedSec = run.elapsed;
    activeOut.timerSec = Math.max(0, run.limit - run.elapsed);
    activeOut.delivered = run.kind === 'run' ? run.delivered : 0;
    activeOut.total = run.kind === 'run' ? run.customers.length : 1;
    return activeOut;
  }

  function listItem(n) {
    let it = listPool[n];
    if (!it) listPool[n] = it = { id: '', title: '', category: 'job', reward: 0, distanceM: null, navigable: false, x: 0, z: 0, active: false };
    return it;
  }

  // 手機任務 App（§23.3）：開放中或進行中的打工；navigable = 有座標且沒有其他進行中工作
  function listings(pos, out = []) {
    let n = 0;
    const othersBusy = !run && busy();
    const fill = (d, x, z, isActive, reward) => {
      const it = listItem(n++);
      it.id = d.id;
      it.title = d.title;
      it.category = 'job';
      it.reward = reward;
      it.x = x;
      it.z = z;
      it.distanceM = validPoint(pos) ? Math.round(Math.hypot(x - pos.x, z - pos.z)) : null;
      it.active = isActive;
      it.navigable = Number.isFinite(x) && Number.isFinite(z) && (isActive || (!run && !othersBusy));
      out.push(it);
    };
    if (run) {
      const t = target();
      if (t) fill(run.def, t.x, t.z, true, rewardNow());
      return out;
    }
    if (runOk && open.has(runDef.id)) fill(runDef, stallBack.x, stallBack.z, false, runDef.estimateReward);
    if (valetOk && open.has(valetDef.id)) {
      let s = stands[0];
      if (validPoint(pos)) {
        let bd = Infinity;
        for (const c of stands) {
          const dd = Math.hypot(c.standX - pos.x, c.standZ - pos.z);
          if (dd < bd) {
            bd = dd;
            s = c;
          }
        }
      }
      fill(valetDef, s.standX, s.standZ, false, valetDef.estimateReward);
    }
    return out;
  }

  function serialize() {
    const t = now();
    const cd = {};
    for (const k of Object.keys(cooldownUntil)) {
      const left = cooldownUntil[k] - t;
      if (left > EPS) cd[k] = Math.ceil(left - EPS);
    }
    return { completed: { ...completed }, cooldowns: cd };
  }

  // 進行中的打工一律作廢（不發 job:fail；泊車車輛照常 releaseValetCar）；未知 id 忽略；冷卻夾到 max(cooldownSec, failCooldownSec)
  function restore(data) {
    if (disposed) return;
    for (const o of [completed, cooldownUntil]) for (const k of Object.keys(o)) delete o[k];
    if (run) endRun();
    const src = data && typeof data === 'object' ? data : {};
    const t = now();
    const each = (obj, fn) => {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
      for (const k of Object.keys(obj)) {
        const v = Number(obj[k]);
        if (byId.has(k) && Number.isFinite(v) && v > 0) fn(k, v, byId.get(k));
      }
    };
    each(src.completed, (k, v) => (completed[k] = Math.floor(v)));
    each(src.cooldowns, (k, v, d) => (cooldownUntil[k] = t + Math.min(Math.max(d.cooldownSec || 0, d.failCooldownSec || 0), v)));
    open.clear();
    version++;
    syncOpen();
  }

  function dispose() {
    if (disposed) return;
    if (run) endRun();
    disposed = true;
    open.clear();
    if (typeof offDisabled === 'function') offDisabled();
  }

  return {
    update,
    nearest,
    markers,
    markersVersion: () => version,
    objective,
    active,
    listings,
    isEngaged: () => !!run,
    isOpen: (id) => open.has(id),
    onPlayerKo: () => fail('ko'),
    onVehicleDisabled,
    abandon: () => fail('abandon'),
    serialize,
    restore,
    dispose,
    hour: () => hourNow,
    car: () => (run && run.kind === 'valet' ? run.car : null),
    enabled: () => [...byId.keys()],
    defs: () => list,
  };
}
