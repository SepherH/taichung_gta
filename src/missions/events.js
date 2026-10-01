// 區內在地事件（時段限定）：沿送貨委託框架（missions/index.js）的「起點互動 → 送達結算」流程，另加遊戲內時刻條件
// 純邏輯模組、不 import three / DOM / daynight：遊戲時刻由注入的 getGameHour() 或 update ctx.gameHour 取得；
//   路線長度由注入的 routeLength(from, to)（整合層包 navigation.js findRoute(graph, from, to).lengthM）取得，
//   未注入或查不到路線 → 直線距離 × ROUTE_FALLBACK_K 估算
// 內建事件「夜市外送」NIGHT_MARKET_DELIVERY：18:00–24:00 在取餐點出現互動 → 按 E 取餐 → 隨機一個既有地標（destinations）為送達點
//   → 依路線長度給時限 eventTimeLimit → 時限內抵達（radius + ARRIVE_PAD）結算 eventReward（距離與剩餘秒數皆單調遞增）→ addMoney(n, 'event')
//   逾時失敗（reason 'timeout'）不扣錢；完成後冷卻 cooldownSec（以注入 now() 秒計），冷卻結束且仍在時段內再開放；repeatable false 者完成一次即不再出現
//   時段外取餐點不出現（已取餐者可繼續送完，不因跨出時段作廢）；跨午夜時段 { start: 22, end: 2 } 亦可
// 取餐點：OSM 資料（src/data/osm-city.json）範圍是七期，沒有任何夜市；逢甲夜市投影約 (868, -1612) 在地圖界外（z0 = -632），
//   改用最接近的既有商圈「新光三越 / 大遠百商圈」：新光三越輪廓（OSM way 148849083，CROWD_MALL_IDS）西側惠來路二段的道路中心點（離線算一次寫死）
//
// 對外 API（createTimedEvents 回傳；missions/index.js createMissions 已代為建立並合併，整合層通常只碰 createMissions）：
//   update(dt, ctx)：ctx 同委託 { x, z, driving }，可另帶 gameHour（0–24，優先於 getGameHour()）
//   nearest(pos) → interactable { id: 'event:<id>', text, dist, priority, act() } 或 null（只在步行 / 駕駛靠近開放中的取餐點時）
//   markers() → [{ x, z, kind: 'event-start'|'event-dest', label }]（陣列與物件重用）
//   objective() → { text, timerSec, distM, rewardNow } 或 null；active() → { id, stage: 'deliver', from, to, routeM, limitSec, elapsedSec, timerSec } 或 null
//   offers() → 開放中的事件 id 陣列、isOpen(id)、defs()；hour() → 目前採用的遊戲時刻（無來源時 null，此時事件全部不開放）
//   abandon()（失敗 reason 'abandon'，不扣錢）、serialize() → { completed: { id: n }, cooldowns: { id: 剩餘秒 } }、restore(data)、dispose()
// 事件（bus）：event:available { id, title, x, z } / event:closed { id } / event:start { id, title, to, routeM, limitSec }
//   / event:complete { id, reward, timeSec, leftSec, routeM } / event:fail { id, reason }
//   / nav:destination、nav:clear（source 'event'）/ ui:sound
//   不發 mission:*：委託統計由 missions/index.js trackMissionStats 另訂閱 event:complete / event:fail 計入 missionsDone / missionsFailed
//   （abandon 亦為 event:fail，比照委託放棄計入 missionsFailed；restore / dispose 作廢進行中外送不發 fail、不計）

export const EVENT_PRIORITY = 3; // 與委託同級（interactable 仲裁 §17）
export const EVENT_ARRIVE_PAD = 8;
export const ROUTE_FALLBACK_K = 1.3; // 無路網時：直線 × 1.3 估算道路距離
export const LIMIT_SPEED = 5; // 時限基準速度（m/s；步行跑步 7 m/s、駕駛更快）
export const LIMIT_SLACK_SEC = 30;
export const REWARD_BASE = 100;
export const REWARD_PER_M = 0.3;
export const REWARD_PER_SEC = 2;
export const EVENT_MAX_REWARD = 5000;

export const NIGHT_MARKET_DELIVERY = {
  id: 'night-market-delivery',
  title: '夜市時段限定外送',
  window: { start: 18, end: 24 }, // 遊戲內時刻區間 [start, end)；end < start 表跨午夜
  pickup: { slug: 'shinkong-topcity-district', name: '新光三越．大遠百商圈', x: 556.3, z: -107.9, radius: 12 },
  cooldownSec: 180,
  failCooldownSec: 0,
  repeatable: true,
  minDestM: 150, // 送達點離取餐點至少這麼遠（直線）
  foods: ['大腸包小腸', '炭烤玉米', '鹽酥雞', '青蛙下蛋', '地瓜球', '臭豆腐'],
};

export const DEFAULT_EVENTS = [NIGHT_MARKET_DELIVERY];

// 時刻是否落在 [start, end)；end < start 跨午夜；start === end 視為全天
export function inHourWindow(hour, start, end) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return false;
  const hh = ((h % 24) + 24) % 24;
  const s = ((Number(start) % 24) + 24) % 24;
  const e = Number(end) === 24 ? 24 : ((Number(end) % 24) + 24) % 24;
  if (s === e) return true;
  if (s < e) return hh >= s && hh < e;
  return hh >= s || hh < e;
}

export function eventTimeLimit(routeM) {
  const d = Math.max(0, Number(routeM) || 0);
  return Math.ceil(d / LIMIT_SPEED + LIMIT_SLACK_SEC);
}

// 獎勵：基本 + 距離 + 剩餘秒數（皆非負、單調遞增），整數、上限 EVENT_MAX_REWARD
export function eventReward(routeM, leftSec) {
  const d = Math.max(0, Number(routeM) || 0);
  const left = Math.max(0, Number(leftSec) || 0);
  return Math.min(EVENT_MAX_REWARD, Math.round(REWARD_BASE + d * REWARD_PER_M + left * REWARD_PER_SEC));
}

const defaultNow = () => (globalThis.performance && performance.now ? performance.now() : Date.now()) / 1000;
const validPoint = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.z);

export function createTimedEvents({
  defs = DEFAULT_EVENTS,
  getGameHour = null,
  destinations = [],
  routeLength = null,
  addMoney = () => {},
  bus = null,
  now = defaultNow,
  rng = Math.random,
} = {}) {
  const emit = (name, payload) => {
    if (bus && typeof bus.emit === 'function') bus.emit(name, payload);
  };
  const list = (Array.isArray(defs) ? defs : []).filter((d) => d && d.id && validPoint(d.pickup) && d.window);
  const byId = new Map(list.map((d) => [d.id, d]));
  const dests = (Array.isArray(destinations) ? destinations : []).filter(validPoint);

  const completed = Object.create(null);
  const cooldownUntil = Object.create(null);
  const open = new Set(); // 開放中的事件 id
  const inters = new Map(); // id → interactable（重用）
  let run = null; // { def, to, routeM, limit, elapsed, arrive, food, text }
  let hourNow = null;
  let hasPos = false;
  let px = 0;
  let pz = 0;
  let disposed = false;

  const markerPool = [];
  for (let i = 0; i < list.length + 1; i++) markerPool.push({ x: 0, z: 0, kind: 'event-start', label: '' });
  const markerList = [];
  const objectiveOut = { text: '', timerSec: 0, distM: null, rewardNow: 0 };
  const activeOut = { id: '', stage: 'deliver', from: null, to: null, routeM: 0, limitSec: 0, elapsedSec: 0, timerSec: 0 };

  const pickupRadius = (d) => (Number.isFinite(d.pickup.radius) ? d.pickup.radius : 12);
  const isCooling = (id) => cooldownUntil[id] !== undefined && cooldownUntil[id] > now();
  const exhausted = (d) => d.repeatable === false && completed[d.id] > 0;

  function readHour(ctx) {
    if (ctx && Number.isFinite(ctx.gameHour)) return ctx.gameHour;
    if (typeof getGameHour === 'function') {
      const h = Number(getGameHour());
      if (Number.isFinite(h)) return h;
    }
    return null;
  }

  function candidates(d) {
    const minD = Number.isFinite(d.minDestM) ? d.minDestM : 0;
    return dests.filter((l) => Math.hypot(l.x - d.pickup.x, l.z - d.pickup.z) >= minD);
  }

  function shouldOpen(d) {
    return !run && hourNow !== null && inHourWindow(hourNow, d.window.start, d.window.end) && !isCooling(d.id) && !exhausted(d) && candidates(d).length > 0;
  }

  function syncOpen() {
    for (const d of list) {
      const want = shouldOpen(d);
      if (want && !open.has(d.id)) {
        open.add(d.id);
        emit('event:available', { id: d.id, title: d.title, x: d.pickup.x, z: d.pickup.z });
      } else if (!want && open.has(d.id)) {
        open.delete(d.id);
        emit('event:closed', { id: d.id });
      }
    }
  }

  function measure(from, to) {
    if (typeof routeLength === 'function') {
      try {
        const r = routeLength(from, to);
        const len = r && typeof r === 'object' ? r.lengthM : r;
        if (Number.isFinite(len) && len > 0) return len;
      } catch {
        /* 路網查詢失敗 → 直線估算 */
      }
    }
    return Math.hypot(to.x - from.x, to.z - from.z) * ROUTE_FALLBACK_K;
  }

  const pick = (arr) => arr[Math.floor(Math.min(0.999999, Math.max(0, Number(rng()) || 0)) * arr.length)];

  function start(d) {
    if (disposed || run || !open.has(d.id)) return false;
    const pool = candidates(d);
    if (!pool.length) return false;
    const to = pick(pool);
    const routeM = measure(d.pickup, to);
    const food = Array.isArray(d.foods) && d.foods.length ? pick(d.foods) : '餐點';
    const limit = eventTimeLimit(routeM);
    const toName = to.name || to.slug || '目的地';
    run = {
      def: d,
      to,
      routeM,
      limit,
      elapsed: 0,
      arrive: (Number.isFinite(to.radius) ? to.radius : 25) + EVENT_ARRIVE_PAD,
      food,
      text: `外送「${food}」到${toName}`,
    };
    open.delete(d.id);
    emit('event:closed', { id: d.id });
    emit('ui:sound', { kind: 'confirm' });
    emit('event:start', { id: d.id, title: d.title, food, to: to.slug || to.id || toName, toName, x: to.x, z: to.z, routeM: Math.round(routeM), limitSec: limit });
    emit('nav:destination', { x: to.x, z: to.z, label: toName, source: 'event' });
    return true;
  }

  function endRun() {
    run = null;
    emit('nav:clear', { source: 'event' });
  }

  function complete() {
    const d = run.def;
    const left = Math.max(0, run.limit - run.elapsed);
    const reward = eventReward(run.routeM, left);
    const out = { id: d.id, reward, timeSec: Math.round(run.elapsed * 10) / 10, leftSec: Math.round(left * 10) / 10, routeM: Math.round(run.routeM) };
    endRun();
    completed[d.id] = (completed[d.id] || 0) + 1;
    if (d.cooldownSec > 0) cooldownUntil[d.id] = now() + d.cooldownSec;
    if (reward > 0) addMoney(reward, 'event');
    emit('event:complete', out);
    emit('ui:sound', { kind: 'reward' });
    syncOpen();
    return out;
  }

  function fail(reason) {
    if (!run) return;
    const d = run.def;
    endRun();
    if (d.failCooldownSec > 0) cooldownUntil[d.id] = now() + d.failCooldownSec;
    emit('event:fail', { id: d.id, reason });
    emit('ui:sound', { kind: 'fail' });
    syncOpen();
  }

  for (const d of list) {
    const inter = { id: `event:${d.id}`, text: `按 E 取餐：${d.title}（${d.pickup.name}）`, dist: 0, priority: EVENT_PRIORITY, act: () => start(d) };
    inters.set(d.id, inter);
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
    if (run) {
      run.elapsed += step;
      if (run.elapsed >= run.limit) fail('timeout');
      else if (hasPos && Math.hypot(run.to.x - px, run.to.z - pz) <= run.arrive) complete();
    }
    syncOpen();
  }

  function nearest(pos) {
    if (disposed || run || !validPoint(pos)) return null;
    let best = null;
    let bestD = Infinity;
    for (const d of list) {
      if (!open.has(d.id)) continue;
      const dist = Math.hypot(d.pickup.x - pos.x, d.pickup.z - pos.z);
      if (dist <= pickupRadius(d) && dist < bestD) {
        bestD = dist;
        best = inters.get(d.id);
      }
    }
    if (best) best.dist = bestD;
    return best;
  }

  function markers() {
    markerList.length = 0;
    if (run) {
      const mk = markerPool[0];
      mk.x = run.to.x;
      mk.z = run.to.z;
      mk.kind = 'event-dest';
      mk.label = run.to.name || '外送目的地';
      markerList.push(mk);
      return markerList;
    }
    let i = 0;
    for (const d of list) {
      if (!open.has(d.id)) continue;
      const mk = markerPool[i++];
      mk.x = d.pickup.x;
      mk.z = d.pickup.z;
      mk.kind = 'event-start';
      mk.label = d.title;
      markerList.push(mk);
    }
    return markerList;
  }

  function objective() {
    if (!run) return null;
    const left = Math.max(0, run.limit - run.elapsed);
    objectiveOut.text = run.text;
    objectiveOut.timerSec = left;
    objectiveOut.distM = hasPos ? Math.hypot(run.to.x - px, run.to.z - pz) : null;
    objectiveOut.rewardNow = eventReward(run.routeM, left);
    return objectiveOut;
  }

  function active() {
    if (!run) return null;
    activeOut.id = run.def.id;
    activeOut.from = run.def.pickup;
    activeOut.to = run.to;
    activeOut.routeM = run.routeM;
    activeOut.limitSec = run.limit;
    activeOut.elapsedSec = run.elapsed;
    activeOut.timerSec = Math.max(0, run.limit - run.elapsed);
    return activeOut;
  }

  function serialize() {
    const t = now();
    const cd = {};
    for (const k of Object.keys(cooldownUntil)) {
      const left = cooldownUntil[k] - t;
      if (left > 0) cd[k] = Math.ceil(left);
    }
    return { completed: { ...completed }, cooldowns: cd };
  }

  // 進行中的外送一律作廢（不發 event:fail）
  function restore(data) {
    if (disposed) return;
    for (const o of [completed, cooldownUntil]) for (const k of Object.keys(o)) delete o[k];
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
    if (run) endRun();
    syncOpen();
  }

  function dispose() {
    if (disposed) return;
    if (run) endRun();
    disposed = true;
    open.clear();
  }

  return {
    update,
    nearest,
    markers,
    objective,
    active,
    abandon: () => fail('abandon'),
    serialize,
    restore,
    dispose,
    offers: () => [...open],
    isOpen: (id) => open.has(id),
    hour: () => hourNow,
    defs: () => list,
  };
}
