// 時段事件「垃圾車來了」GARBAGE_TRUCK_EVENT（純邏輯：不 import three / DOM / daynight / navigation；由 missions/index.js createMissions 掛上）
// 規則：遊戲時刻 16:00–18:00（傍晚收垃圾時段，與夜市外送 18–24 錯開）且無進行中的委託 / 外送 → 垃圾車出現在注入的道路折線起點，
//   以 speed m/s 沿折線行駛、每 stopEveryM 公尺停靠 stopSec 秒收垃圾，走到折線終點折返（ping-pong），沿行進方向右側偏 laneOffsetM
//   出現即 event:available；玩家首次進入 ENGAGE_M 內 → event:start（開始追車，計入統計的起點）；
//   自出現起 limitSec 內走到車尾投入口 DUMP_RADIUS 內（步行或駕駛）按 E → event:complete，獎勵 garbageReward(剩餘秒) 入帳 reason 'garbage'（HUD 跳字「清運」，不沿用外送的 'event'），冷卻 cooldownSec
//   逾時：已追車 → event:fail { reason: 'timeout' }；未追車（玩家根本沒靠近）→ 只 event:closed、不計失敗；兩者皆冷卻 failCooldownSec、不扣錢
//   追車後與車距離 > LOST_M 持續 LOST_SEC 秒 → event:fail { reason: 'lost' }（冷卻 failCooldownSec）；abandon() → fail 'abandon'
//   未追車時若委託 / 外送開始（busy）→ 垃圾車收走（event:closed，冷卻 failCooldownSec）；已追車則照常進行
//   出現後跨出時段不作廢（跑完本趟）；時段外不出現；冷卻中不出現；沒有路線來源（routeFor 未注入或回傳不足 2 點 / 短於 MIN_ROUTE_M）→ 不出現
// 座標約定（與 vehicle.js / three.js 相同）：heading = yaw，前方 = (sin h, cos h)；本地 (lx, lz) → 世界 (lx cos h + lz sin h, −lx sin h + lz cos h)，
//   本地 +X = 車身左側；車尾投入口 = 本地 (0, *, REAR_Z = −3.43)（美術交付，glTF −Z 面）
//
// 對外 API（createGarbageTruck 回傳；createMissions 代為建立並合併進 nearest / markers / serialize，另以 missions.truck 曝露）：
//   update(dt, ctx)：ctx 同委託 { x, z, driving, gameHour? }；busy 由建構參數 isBusy() 判斷
//   truck() → { x, z, heading, speed, stopped, rearX, rearZ, distM, phase: 'open'|'chase', beacon: true } 或 null（無車）——物件重用，
//     整合層（G2）每幀：truck 非 null → 以 manifest garbage_truck 模型（createVehicleModel('garbage_truck')）擺 mesh.position.set(x, 地面高, z)、
//     mesh.rotation.y = heading、visible = true；null → 隱藏 / 移除（車體純視覺、不建剛體）；distM = 玩家到車體距離（旋律音量用）
//   nearest(pos) → interactable { id: 'event:garbage-truck', text, dist, priority: EVENT_PRIORITY, act() } 或 null
//   markers() → [{ x, z, kind: 'event-truck', label: '垃圾車' }]（陣列 / 物件重用）
//   objective() → { text, timerSec, distM, rewardNow } 或 null（追車中才有；text 的操作詞取建構參數 interactLabel，預設「按 E」，觸控由 createMissions 注入「點「互動」鈕」）
//   active() → { id, kind: 'truck', stage: 'chase', from: null, to: { x, z }（車尾投入口，隨車移動）, routeM: null, limitSec, elapsedSec, timerSec } 或 null（欄位比照夜市外送 active()）
//   isOpen()、hour()、abandon()、serialize() → { completed: { 'garbage-truck': n }, cooldowns: { 'garbage-truck': 剩餘秒 } }、restore(data)、dispose()
// 事件（bus）：event:available { id, title, x, z, kind: 'truck' } / event:closed { id } / event:start { id, title, limitSec, leftSec, kind: 'truck' }
//   / event:complete { id, reward, timeSec, leftSec } / event:fail { id, reason } / ui:sound（不發 nav:*：目標會移動，靠標記追）
// routeFor(player, rng) → [{x,z}, …] 或 { points }：整合層包 navigation.js findRoute(graph, a, b).points（a / b 為玩家附近 150–300 m 的道路點與更遠的道路點）
// 警示燈（Phase 6，§23.5）：truck().beaconT = 本趟出現以來的模擬秒數（只隨 update(simDt) 推進，暫停 / 無子步不動）；
//   truck().beaconLevel = beaconLevel(beaconT, ctx.night)（ctx.night 0–1 由整合層傳 dayNight.night，未傳 = 0 白天）；
//   整合層把材質名含 beacon 者交給 applyBeacon(materials, level)（不再 registerNight，否則 daynight 每幀覆寫 emissiveIntensity）

import { EVENT_PRIORITY, inHourWindow } from './events.js';

export const REAR_Z = -3.43; // 車尾投入口中心（glTF 本地 z，美術交付 [0, 1.33, -3.43]）
export const DUMP_RADIUS = 5; // 投入口判定半徑（m，水平；駕駛中車頭也能伸到）
export const ENGAGE_M = 60; // 玩家進入此距離 → 開始追車（event:start）
export const LOST_M = 250; // 追車後拉開超過此距離……
export const LOST_SEC = 10; // ……持續此秒數 → 失敗 'lost'
export const MIN_ROUTE_M = 60;
export const ROUTE_RETRY_SEC = 2; // 取不到路線時隔幾秒再試（避免每幀尋路）
export const TURN_RATE = 2.5; // 車頭轉向平滑（rad/s）
export const GARBAGE_REWARD_BASE = 250;
export const GARBAGE_REWARD_PER_SEC = 1;

export const GARBAGE_TRUCK_EVENT = {
  id: 'garbage-truck',
  title: '垃圾車來了',
  window: { start: 16, end: 18 },
  limitSec: 180,
  cooldownSec: 240,
  failCooldownSec: 120,
  speed: 5.5, // m/s（約 20 km/h；玩家跑步 7 m/s 追得上）
  stopEveryM: 120,
  stopSec: 8,
  laneOffsetM: 1.8,
};

// 獎勵：基本 + 剩餘秒數（整數、單調遞增）
export function garbageReward(leftSec) {
  const left = Math.max(0, Number(leftSec) || 0);
  return Math.round(GARBAGE_REWARD_BASE + left * GARBAGE_REWARD_PER_SEC);
}

// 車體位置 + heading → 車尾投入口世界座標（水平）
export function truckRearPoint(x, z, heading, out = { x: 0, z: 0 }) {
  out.x = x + REAR_Z * Math.sin(heading);
  out.z = z + REAR_Z * Math.cos(heading);
  return out;
}

// 警示燈亮度（emissiveIntensity 倍率）：純函式。t = 模擬秒數、night = 0–1（boolean 亦可）；
//   旋轉燈脈衝 BEACON_HZ（0 → 1 的 smooth 方波，亮段佔 ~半週期），白天上限 BEACON_DAY、夜間 BEACON_NIGHT（night 線性內插）
export const BEACON_HZ = 1.5;
export const BEACON_DAY = 0.15;
export const BEACON_NIGHT = 2;
export const BEACON_COLOR = 0xffa020; // glb beacon 材質 emissive 為黑時補上的琥珀色
export function beaconLevel(t, night) {
  const n = night === true ? 1 : Math.min(1, Math.max(0, Number(night) || 0));
  const tt = Number.isFinite(t) ? t : 0;
  const pulse = 0.5 + 0.5 * Math.cos(2 * Math.PI * BEACON_HZ * tt); // t = 0 時最亮
  const k = pulse * pulse * (3 - 2 * pulse); // smoothstep：亮暗段拉開
  return (BEACON_DAY + (BEACON_NIGHT - BEACON_DAY) * n) * k;
}

// 把亮度套到材質（鴨子型別，不 import three）：名稱含 beacon 者 emissiveIntensity = level；emissive 為黑（glb 沒帶 emission）時補 BEACON_COLOR
//   回傳套用的材質數
export function applyBeacon(materials, level) {
  let n = 0;
  const v = Number.isFinite(level) && level > 0 ? level : 0;
  for (const m of materials || []) {
    if (!m || typeof m.name !== 'string' || !m.name.includes('beacon')) continue;
    const e = m.emissive;
    if (e && typeof e.setHex === 'function' && !(e.r > 0 || e.g > 0 || e.b > 0)) e.setHex(BEACON_COLOR);
    m.emissiveIntensity = v;
    n++;
  }
  return n;
}

const angleWrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const validPoint = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.z);
const defaultNow = () => (globalThis.performance && performance.now ? performance.now() : Date.now()) / 1000;

// 折線行駛器：沿 points 以 dt × speed 推進（ping-pong），每 stopEveryM 停 stopSec；輸出 { x, z, heading, stopped }
export function createRouteFollower(points, { speed = 5, stopEveryM = 0, stopSec = 0, laneOffsetM = 0 } = {}) {
  const pts = (Array.isArray(points) ? points : []).filter(validPoint).map((p) => ({ x: p.x, z: p.z }));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  const length = cum[cum.length - 1] || 0;
  let s = 0; // 折線上的弧長
  let dir = 1; // 1 去程、−1 回程
  let seg = 0;
  let sinceStop = 0;
  let stopLeft = 0;
  let heading = 0;
  let headingInit = false;
  const out = { x: 0, z: 0, heading: 0, stopped: false, s: 0, length, dir: 1 };

  function segHeading() {
    const a = pts[seg];
    const b = pts[seg + 1];
    const h = Math.atan2(b.x - a.x, b.z - a.z);
    return dir > 0 ? h : angleWrap(h + Math.PI);
  }

  function place(dt) {
    while (seg < pts.length - 2 && s > cum[seg + 1]) seg++;
    while (seg > 0 && s < cum[seg]) seg--;
    const a = pts[seg];
    const b = pts[seg + 1];
    const L = cum[seg + 1] - cum[seg] || 1;
    const t = Math.min(1, Math.max(0, (s - cum[seg]) / L));
    const target = segHeading();
    if (!headingInit) {
      heading = target;
      headingInit = true;
    } else {
      const d = angleWrap(target - heading);
      const maxD = TURN_RATE * dt;
      heading = angleWrap(heading + (Math.abs(d) <= maxD ? d : Math.sign(d) * maxD));
    }
    // 右側偏移（本地 −X → 世界 (−cos h, sin h)），以路段方向計
    const cx = a.x + (b.x - a.x) * t;
    const cz = a.z + (b.z - a.z) * t;
    out.x = cx - laneOffsetM * Math.cos(target);
    out.z = cz + laneOffsetM * Math.sin(target);
    out.heading = heading;
    out.stopped = stopLeft > 0;
    out.s = s;
    out.dir = dir;
  }

  function step(dt) {
    if (length <= 0) return out;
    const t = Number.isFinite(dt) && dt > 0 ? dt : 0;
    // 停靠開始 / 結束落在本步中間時，剩餘時間接著用（行駛 ↔ 停靠），結果與步長無關（多子步幀 = 逐子步）
    let rem = t;
    for (let guard = 0; rem > 1e-12 && guard < 64; guard++) {
      if (stopLeft > 0) {
        const u = Math.min(stopLeft, rem);
        stopLeft -= u;
        rem -= u;
        if (stopLeft < 1e-12) stopLeft = 0;
        continue;
      }
      if (!(speed > 0)) break;
      let d = speed * rem;
      if (stopEveryM > 0 && sinceStop + d >= stopEveryM) {
        d = stopEveryM - sinceStop;
        rem = Math.max(0, rem - d / speed);
        sinceStop = 0;
        stopLeft = stopSec;
      } else {
        sinceStop += d;
        rem = 0;
      }
      s += dir * d;
      if (s >= length) {
        s = length - (s - length);
        dir = -1;
      } else if (s <= 0) {
        s = -s;
        dir = 1;
      }
      s = Math.min(length, Math.max(0, s));
    }
    place(t);
    return out;
  }

  if (pts.length >= 2) place(0);
  return { step, state: () => out, length, points: pts };
}

export function createGarbageTruck({
  def = GARBAGE_TRUCK_EVENT,
  getGameHour = null,
  routeFor = null,
  isBusy = () => false,
  addMoney = () => {},
  bus = null,
  now = defaultNow,
  rng = Math.random,
  interactLabel = '按 E',
} = {}) {
  const emit = (name, payload) => {
    if (bus && typeof bus.emit === 'function') bus.emit(name, payload);
  };
  const id = def.id;
  let completed = 0;
  let cooldownUntil = 0;
  let run = null; // { follower, elapsed, engaged, lostT, beaconT }
  let hourNow = null;
  let hasPos = false;
  let px = 0;
  let pz = 0;
  let retryT = 0;
  let disposed = false;
  let night = 0;

  const rear = { x: 0, z: 0 };
  const truckOut = { x: 0, z: 0, heading: 0, speed: 0, stopped: false, rearX: 0, rearZ: 0, distM: null, phase: 'open', beacon: true, beaconT: 0, beaconLevel: 0 };
  const marker = { x: 0, z: 0, kind: 'event-truck', label: '垃圾車' };
  const markerList = [];
  const objectiveOut = { text: `追上垃圾車，到車尾${interactLabel} 倒垃圾`, timerSec: 0, distM: null, rewardNow: 0 };
  const activeOut = { id, kind: 'truck', stage: 'chase', from: null, to: rear, routeM: null, limitSec: def.limitSec, elapsedSec: 0, timerSec: 0 };
  const inter = { id: `event:${id}`, text: '按 E 倒垃圾', dist: 0, priority: EVENT_PRIORITY, act: () => dump() };

  const isCooling = () => cooldownUntil > now();
  const leftSec = () => (run ? Math.max(0, def.limitSec - run.elapsed) : 0);

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

  function getRoute() {
    if (typeof routeFor !== 'function') return null;
    try {
      const r = routeFor(hasPos ? { x: px, z: pz } : null, rng);
      const pts = Array.isArray(r) ? r : r && Array.isArray(r.points) ? r.points : null;
      if (!pts) return null;
      const f = createRouteFollower(pts, def);
      return f.points.length >= 2 && f.length >= MIN_ROUTE_M ? f : null;
    } catch {
      return null;
    }
  }

  function syncTruck() {
    const st = run.follower.state();
    truckRearPoint(st.x, st.z, st.heading, rear);
    truckOut.x = st.x;
    truckOut.z = st.z;
    truckOut.heading = st.heading;
    truckOut.stopped = st.stopped;
    truckOut.speed = st.stopped ? 0 : def.speed;
    truckOut.rearX = rear.x;
    truckOut.rearZ = rear.z;
    truckOut.distM = hasPos ? Math.hypot(st.x - px, st.z - pz) : null;
    truckOut.phase = run.engaged ? 'chase' : 'open';
    truckOut.beaconT = run.beaconT;
    truckOut.beaconLevel = beaconLevel(run.beaconT, night);
  }

  function tryOpen(step) {
    if (run || disposed || hourNow === null || !inHourWindow(hourNow, def.window.start, def.window.end) || isCooling() || busy()) return;
    retryT -= step;
    if (retryT > 0) return;
    const follower = getRoute();
    if (!follower) {
      retryT = ROUTE_RETRY_SEC;
      return;
    }
    retryT = 0;
    run = { follower, elapsed: 0, engaged: false, lostT: 0, beaconT: 0 };
    syncTruck();
    emit('event:available', { id, title: def.title, x: truckOut.x, z: truckOut.z, kind: 'truck' });
  }

  function engage() {
    if (!run || run.engaged) return;
    run.engaged = true;
    truckOut.phase = 'chase';
    emit('ui:sound', { kind: 'confirm' });
    emit('event:start', { id, title: def.title, limitSec: def.limitSec, leftSec: Math.ceil(leftSec()), kind: 'truck' });
  }

  function close() {
    run = null;
    if (def.failCooldownSec > 0) cooldownUntil = now() + def.failCooldownSec;
    emit('event:closed', { id });
  }

  function fail(reason) {
    if (!run) return;
    if (!run.engaged) {
      close();
      return;
    }
    run = null;
    if (def.failCooldownSec > 0) cooldownUntil = now() + def.failCooldownSec;
    emit('event:fail', { id, reason });
    emit('ui:sound', { kind: 'fail' });
  }

  function dump() {
    if (disposed || !run) return false;
    if (!run.engaged) engage();
    const left = leftSec();
    const reward = garbageReward(left);
    const out = { id, reward, timeSec: Math.round(run.elapsed * 10) / 10, leftSec: Math.round(left * 10) / 10 };
    run = null;
    completed++;
    if (def.cooldownSec > 0) cooldownUntil = now() + def.cooldownSec;
    if (reward > 0) addMoney(reward, 'garbage');
    emit('event:complete', out);
    emit('ui:sound', { kind: 'reward' });
    return out;
  }

  function update(dt, ctx) {
    if (disposed) return;
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.5) : 0;
    if (ctx) {
      const p = Number.isFinite(ctx.x) ? ctx : ctx.pos || ctx.position || null;
      if (validPoint(p)) {
        px = p.x;
        pz = p.z;
        hasPos = true;
      }
    }
    hourNow = readHour(ctx);
    if (ctx && ctx.night !== undefined) night = ctx.night === true ? 1 : Math.min(1, Math.max(0, Number(ctx.night) || 0));
    // 本幀無子步（simDt = 0，§20）：只刷新玩家距離，不開放 / 追車 / 判定——狀態轉換只發生在模擬時間有推進的幀，>60 Hz 與 60 Hz 落在同一子步
    if (step <= 0) {
      if (run) syncTruck();
      return;
    }
    if (!run) {
      // 開放視為發生在本幀模擬區間的起點：同一幀接著推進 step（多子步幀與逐子步推進的 elapsed / 車位一致）
      tryOpen(step);
      if (!run) return;
    }
    if (!run.engaged && busy()) {
      close();
      return;
    }
    run.elapsed += step;
    run.beaconT += step;
    run.follower.step(step);
    syncTruck();
    if (run.elapsed >= def.limitSec) {
      fail('timeout');
      return;
    }
    const d = truckOut.distM;
    if (d !== null && !run.engaged && d <= ENGAGE_M) engage();
    if (run.engaged && d !== null) {
      run.lostT = d > LOST_M ? run.lostT + step : 0;
      if (run.lostT >= LOST_SEC) fail('lost');
    }
  }

  function nearest(pos) {
    if (disposed || !run || !validPoint(pos)) return null;
    const dist = Math.hypot(rear.x - pos.x, rear.z - pos.z);
    if (dist > DUMP_RADIUS) return null;
    inter.dist = dist;
    return inter;
  }

  function markers() {
    markerList.length = 0;
    if (run) {
      marker.x = truckOut.x;
      marker.z = truckOut.z;
      markerList.push(marker);
    }
    return markerList;
  }

  function objective() {
    if (!run || !run.engaged) return null;
    const left = leftSec();
    objectiveOut.timerSec = left;
    objectiveOut.distM = hasPos ? Math.hypot(rear.x - px, rear.z - pz) : null;
    objectiveOut.rewardNow = garbageReward(left);
    return objectiveOut;
  }

  function active() {
    if (!run || !run.engaged) return null;
    activeOut.elapsedSec = run.elapsed;
    activeOut.timerSec = leftSec();
    return activeOut;
  }

  function serialize() {
    const out = { completed: {}, cooldowns: {} };
    if (completed > 0) out.completed[id] = completed;
    const left = cooldownUntil - now();
    if (left > 1e-6) out.cooldowns[id] = Math.ceil(left - 1e-6); // 去掉浮點誤差（240.0000001 不進位成 241）
    return out;
  }

  // 進行中的垃圾車一律收走（不發 event:fail / closed）；未知 id 忽略；冷卻夾到 max(cooldownSec, failCooldownSec)
  function restore(data) {
    if (disposed) return;
    completed = 0;
    cooldownUntil = 0;
    run = null;
    retryT = 0;
    const src = data && typeof data === 'object' ? data : {};
    const c = src.completed && typeof src.completed === 'object' ? Number(src.completed[id]) : NaN;
    if (Number.isFinite(c) && c > 0) completed = Math.floor(c);
    const cd = src.cooldowns && typeof src.cooldowns === 'object' ? Number(src.cooldowns[id]) : NaN;
    if (Number.isFinite(cd) && cd > 0) cooldownUntil = now() + Math.min(Math.max(def.cooldownSec || 0, def.failCooldownSec || 0), cd);
  }

  function dispose() {
    run = null;
    disposed = true;
  }

  return {
    update,
    truck: () => (run ? truckOut : null),
    nearest,
    markers,
    objective,
    active,
    isOpen: () => !!run,
    isEngaged: () => !!(run && run.engaged),
    hour: () => hourNow,
    completedCount: () => completed,
    abandon: () => fail('abandon'),
    serialize,
    restore,
    dispose,
    def: () => def,
  };
}
