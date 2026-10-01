// 資料驅動送貨委託（契約 §16）：日常打工 = 從真實地標接貨、送到另一個地標
// createMissions({ bus, scene, root, landmarks, addMoney, fetchJson, now, rng, isTouch, interactLabel }) → 契約 §16 的 API（另加 speedScale / isModalOpen / abandon）
// 流程：同時開放 3 個起點光柱 → 靠近按 E（interactable priority 3）→ 接單卡 → 目的地光柱 + nav:destination
//   → 抵達目的地（地標 radius + 8 m 內，步行或駕駛）結算 → 結算面板；失敗（timeout / destroyed / ko / abandon）→ 失敗面板 + 重試
// 條件：timed 倒數、超時失敗（只有 conditions 含 timed 者會因超時失敗）；非 timed 委託的 timeLimitSec 只作提早完成加成基準，
//   目標列顯示固定的「建議 m:ss」、objective / active 的 timerSec = null、suggestSec = 建議時間；fragile 損壞度（車撞 relSpeed ≥ 4 m/s 起算、≥ 15 m/s 一次 40%；被擊倒 50%；100% 失敗），
//   報酬 × (1 − 損壞度 × 0.7)；heavy 步行 speedScale() = 0.6（駕駛 1）；有時限者提早完成加成 = 剩餘時間比例 × 30% × 基本報酬
// 完成後該委託冷卻 120 s（以注入 now() 秒計）；可用委託 < 3 時開放全部可用者
// 事件：mission:available / start / stage / complete / fail、nav:destination / nav:clear（source 'mission'）、ui:sound
// 每幀路徑（update / nearest / markers / objective）重用暫存物件，不配置新物件
// 時段限定事件（events.js，例：夜市外送）：建構時可注入 getGameHour()（或每幀 update ctx 帶 gameHour）、routeLength(from, to)、events（定義陣列；false 關閉）
//   nearest()：取餐點與委託起點重疊時取較近者；沒有任何遊戲時刻來源時事件完全不作用，既有委託行為不變；委託進行中不開放事件、事件進行中不開放委託（起點光柱 / 標記一併隱藏）
//   事件取餐點 / 送達點用同一個光柱池（start / dest 色）；markers() 附加 kind 'event-start' / 'event-dest'；
//   目標列在無委託時顯示事件倒數；eventObjective() / eventActive() / events 供 HUD / 除錯；serialize() 只在事件有狀態時多帶 events 欄位
// 委託統計（存檔 stats.missionsDone / missionsFailed）：trackMissionStats(bus, stats) 依 MISSION_STAT_EVENTS 累加——
//   委託 mission:complete / mission:fail 與事件 event:complete / event:fail 各計一次（兩邊互不轉發，不重複計數）；
//   放棄比照委託：abandon 走 fail（reason 'abandon'）→ 計入 missionsFailed；讀檔作廢進行中的委託 / 事件不發 fail、不計
// 垃圾車事件（garbage-truck.js，規則見該檔頭）：建構時注入 routeFor(player, rng) → 道路折線才會出現（未注入 → 完全不作用，既有行為不變）；
//   garbageTruck（定義物件；false 關閉）；委託 / 外送進行中不出現（未追車時遇到即收走），追車中（truck.isEngaged()）不開放委託 / 外送互動、
//   隱藏委託起點光柱；nearest() 車尾投入口優先；markers() 附加 kind 'event-truck'；目標列在無委託 / 外送時顯示追車倒數；
//   bus 事件與外送共用 event:*（id 'garbage-truck'），統計同樣經 trackMissionStats；serialize() 的 events 欄位合併兩者（id 不重複）
//   eventObjective() / eventActive()：外送進行中回外送，否則追車中回垃圾車（truck.objective() / truck.active()），都沒有 → null
//   整合層：missions.truckState() → { x, z, heading, … } 或 null（每幀擺垃圾車模型）、missions.truck（完整 API）
import './missions.css';
import { loadCatalog, CARGO_BASE } from './catalog.js';
import { createBeaconPool } from './light-pillar.js';
import { createMissionUi, formatClock, CONDITION_LABELS } from './ui.js';
import { createTimedEvents, DEFAULT_EVENTS } from './events.js';
import { createGarbageTruck, GARBAGE_TRUCK_EVENT } from './garbage-truck.js';

export const OPEN_SLOTS = 3;
export const COOLDOWN_SEC = 120;
export const ARRIVE_PAD = 8; // 目的地判定：地標 radius + 8 m
export const START_PAD = 8; // 起點互動：地標 radius + 8 m
export const PRIORITY = 3;
export const HEAVY_SPEED_SCALE = 0.6;
export const IMPACT_MIN = 4; // m/s 起算
export const IMPACT_MAX = 15; // m/s 以上一次 40%
export const IMPACT_MAX_PCT = 40;
export const KO_DAMAGE_PCT = 50;
export const DAMAGE_REWARD_CUT = 0.7;
export const EARLY_BONUS = 0.3;
export const IMPACT_MERGE_SEC = 0.3; // 同一次碰撞的連續接觸回報：視窗內只計超出先前最大值的部分
// bus 事件 → 委託統計欄位（時段事件與委託同列計數）
export const MISSION_STAT_EVENTS = {
  'mission:complete': 'missionsDone',
  'mission:fail': 'missionsFailed',
  'event:complete': 'missionsDone',
  'event:fail': 'missionsFailed',
};

// 訂閱 MISSION_STAT_EVENTS，每次 +1 寫進 stats（整合層的 extraStats）；回傳取消訂閱函式
export function trackMissionStats(bus, stats) {
  const offs = [];
  if (!bus || typeof bus.on !== 'function' || !stats) return () => {};
  for (const name of Object.keys(MISSION_STAT_EVENTS)) {
    const key = MISSION_STAT_EVENTS[name];
    const off = bus.on(name, () => {
      stats[key] = (Number(stats[key]) || 0) + 1;
    });
    if (typeof off === 'function') offs.push(off);
  }
  return () => {
    for (const off of offs.splice(0)) off();
  };
}

const FAIL_TEXT = {
  timeout: '時間到了……委託人已經放棄等待。',
  destroyed: '貨物損壞到認不出來了，委託人只想靜靜。',
  ko: '你被擊倒，貨物在混亂中不見了。',
  abandon: '你放棄了這趟委託。',
};

// 衝擊 → 損壞百分比
export function impactDamagePct(relSpeed) {
  const v = Number(relSpeed);
  if (!Number.isFinite(v) || v < IMPACT_MIN) return 0;
  if (v >= IMPACT_MAX) return IMPACT_MAX_PCT;
  return ((v - IMPACT_MIN) / (IMPACT_MAX - IMPACT_MIN)) * IMPACT_MAX_PCT;
}

// 報酬結算：回 { base, bonus, reward }（整數）
export function settleReward(reward, damagePct, timeLimitSec, timeSec) {
  const dmg = Math.min(1, Math.max(0, damagePct / 100));
  const base = Math.max(0, Math.round(reward * (1 - dmg * DAMAGE_REWARD_CUT)));
  let bonus = 0;
  if (timeLimitSec > 0) bonus = Math.max(0, Math.round(reward * Math.max(0, (timeLimitSec - timeSec) / timeLimitSec) * EARLY_BONUS));
  return { base, bonus, reward: base + bonus };
}

// 未給時限的 timed 委託：依直線距離估一個寬鬆時限
export function defaultTimeLimit(distM) {
  return Math.ceil(distM / 6 + 40);
}

const defaultNow = () => (globalThis.performance && performance.now ? performance.now() : Date.now()) / 1000;

export function createMissions({
  bus = null,
  scene = null,
  root = null,
  landmarks = [],
  addMoney = () => {},
  fetchJson = null,
  now = defaultNow,
  rng = Math.random,
  doc = globalThis.document,
  keyTarget = null,
  heightAt = null,
  cargoBase = CARGO_BASE,
  manifestUrl,
  info = console.info,
  getGameHour = null,
  routeLength = null,
  events = DEFAULT_EVENTS,
  routeFor = null,
  garbageTruck = GARBAGE_TRUCK_EVENT,
  // 目標列 / 字幕的操作詞（互動提示本身由 hud.js 轉觸控文字，不經此處）：整合層依 mobile.js isTouch() 注入，不在 missions 內讀 DOM / navigator
  isTouch = false,
  interactLabel = isTouch ? '點「互動」鈕' : '按 E',
} = {}) {
  const emit = (name, payload) => {
    if (bus && typeof bus.emit === 'function') bus.emit(name, payload);
  };
  const beacons = createBeaconPool({ scene, heightAt });
  const ui = createMissionUi({ root, doc, keyTarget, cargoBase, onAction });
  const headless = !ui.els; // 無 DOM：act() 直接接單
  // 事件的 bus 事件照常轉發，另在這裡補字幕
  const timedBus = { emit: (name, payload) => {
    onTimedEvent(name, payload);
    emit(name, payload);
  } };
  const timed = events === false ? null : createTimedEvents({ defs: Array.isArray(events) ? events : DEFAULT_EVENTS, getGameHour, destinations: landmarks, routeLength, addMoney, bus: timedBus, now, rng });
  const evBeacons = new Map(); // 'start:<id>' / 'dest:<id>' → beacon
  let evWasActive = false;
  const evActive = () => !!(timed && timed.active());
  const truckBus = { emit: (name, payload) => {
    onTruckEvent(name, payload);
    emit(name, payload);
  } };
  const truck = garbageTruck === false || typeof routeFor !== 'function' ? null : createGarbageTruck({
    def: garbageTruck && typeof garbageTruck === 'object' ? garbageTruck : GARBAGE_TRUCK_EVENT,
    getGameHour, routeFor, isBusy: () => !!run || evActive(), addMoney, bus: truckBus, now, rng, interactLabel,
  });
  const truckEngaged = () => !!(truck && truck.isEngaged());

  let catalog = [];
  const bySlug = new Map();
  let source = 'none';
  let isReady = false;
  let disposed = false;
  let pendingRestore = null;

  const completed = Object.create(null);
  const best = Object.create(null);
  const cooldownUntil = Object.create(null);

  const offers = []; // { m, beacon, inter }
  let pinned = null; // 失敗後「重試」釘住的委託 slug
  let pending = null; // 接單卡中的委託
  let run = null; // 進行中：{ m, elapsed, limit, damage(0–100), beacon, windowT, windowPct, arrive }
  let lastFailed = null; // 失敗面板對應的委託（按「重試」用）
  let refreshT = 0;
  // 目標列快取：整數秒 / 公尺 / 百分比沒變就不重組字串
  let objKeyT = -1;
  let objKeyD = -1;
  let objKeyG = -1;
  let objTimer = '';
  let objDist = '';
  let objDmg = '';
  let hasCtx = false;
  let driving = false;
  let px = 0;
  let pz = 0;

  // 每幀回傳用的暫存
  const markerPool = [];
  for (let i = 0; i < OPEN_SLOTS + 2; i++) markerPool.push({ x: 0, z: 0, kind: 'mission-start', label: '' });
  const markerList = [];
  const objectiveOut = { text: '', timerSec: null, suggestSec: null, distM: null, damagePct: null };
  const activeOut = { id: '', slug: '', title: '', stage: 'deliver', from: null, to: null, elapsedSec: 0, timerSec: null, suggestSec: null, damagePct: null, conditions: null, tags: null };

  const has = (m, c) => m.conditions.includes(c);
  const triggerRadius = (l, pad) => (Number.isFinite(l.triggerRadius) ? l.triggerRadius : (Number.isFinite(l.radius) ? l.radius : 25) + pad);
  const distTo = (l) => Math.hypot(l.x - px, l.z - pz);
  const isCooling = (slug) => cooldownUntil[slug] !== undefined && cooldownUntil[slug] > now();

  // ---------- 起點輪替 ----------
  function openOffer(m) {
    const off = {
      m,
      beacon: beacons.acquire('start', m.from.x, m.from.z, m.slug),
      inter: { id: `mission:${m.slug}`, text: `按 E 接委託：${m.title}`, dist: 0, priority: PRIORITY, act: () => openCard(off) },
    };
    off.beacon.group.visible = !run && !evActive() && !truckEngaged();
    offers.push(off);
    emit('mission:available', { id: m.slug, title: m.title, x: m.from.x, z: m.from.z });
    return off;
  }

  function closeOffer(i) {
    const off = offers[i];
    beacons.release(off.beacon);
    offers.splice(i, 1);
  }

  const available = (m) => !isCooling(m.slug) && !(run && run.m === m);
  const offered = (m) => {
    for (let i = 0; i < offers.length; i++) if (offers[i].m === m) return true;
    return false;
  };

  // 不配置物件的快速檢查：是否需要重排
  function needsRefresh() {
    let avail = 0;
    for (let i = 0; i < catalog.length; i++) if (available(catalog[i])) avail++;
    for (let i = 0; i < offers.length; i++) if (!available(offers[i].m)) return true;
    if (pinned && bySlug.has(pinned) && !offered(bySlug.get(pinned)) && available(bySlug.get(pinned))) return true;
    return offers.length < Math.min(OPEN_SLOTS, avail);
  }

  function refreshOffers() {
    for (let i = offers.length - 1; i >= 0; i--) if (!available(offers[i].m)) closeOffer(i);
    // 釘住的（重試）優先保留
    const pin = pinned ? bySlug.get(pinned) : null;
    if (pin && available(pin) && !offered(pin)) {
      if (offers.length >= OPEN_SLOTS) closeOffer(offers.length - 1);
      openOffer(pin);
    }
    if (offers.length >= OPEN_SLOTS) return;
    const pool = catalog.filter((m) => available(m) && !offered(m));
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.min(0.999999, Math.max(0, Number(rng()) || 0)) * (i + 1));
      const t = pool[i];
      pool[i] = pool[j];
      pool[j] = t;
    }
    // 先挑起點地標不重複的，再補其餘
    const usedFrom = new Set(offers.map((o) => o.m.from.slug));
    for (const m of pool) {
      if (offers.length >= OPEN_SLOTS) break;
      if (usedFrom.has(m.from.slug)) continue;
      usedFrom.add(m.from.slug);
      openOffer(m);
    }
    for (const m of pool) {
      if (offers.length >= OPEN_SLOTS) break;
      if (!offered(m)) openOffer(m);
    }
  }

  function setStartBeaconsVisible(v) {
    for (let i = 0; i < offers.length; i++) offers[i].beacon.group.visible = v;
  }

  // ---------- 接單 ----------
  function limitOf(m) {
    if (m.timeLimitSec > 0) return m.timeLimitSec;
    if (has(m, 'timed')) return defaultTimeLimit(Math.hypot(m.to.x - m.from.x, m.to.z - m.from.z));
    return 0;
  }

  function openCard(off) {
    if (disposed || run || ui.isOpen() || offers.indexOf(off) < 0) return;
    pending = off.m;
    if (headless) {
      accept();
      return;
    }
    const limit = limitOf(off.m);
    const timed = has(off.m, 'timed');
    ui.showOffer(off.m, { timeLimitSec: timed ? limit : 0, suggestSec: timed ? 0 : limit, fromName: off.m.from.name, toName: off.m.to.name });
    emit('ui:sound', { kind: 'open' });
  }

  function conditionHint(m) {
    const parts = [];
    if (has(m, 'fragile')) parts.push('易碎：別撞車、別被打倒');
    if (has(m, 'heavy')) parts.push('超重：走路會變慢，開車比較輕鬆');
    if (has(m, 'timed')) parts.push('限時：注意倒數');
    else if (m.timeLimitSec > 0) parts.push(`建議 ${formatClock(m.timeLimitSec)} 內送達，提早到有加成`);
    return parts.join('；');
  }

  function accept() {
    const m = pending;
    pending = null;
    ui.closePanel();
    if (!m || run) return;
    if (pinned === m.slug) pinned = null;
    const limit = limitOf(m);
    const timed = has(m, 'timed');
    run = {
      m,
      elapsed: 0,
      limit,
      timed,
      countdown: timed && limit > 0,
      suggestText: !timed && limit > 0 ? `建議 ${formatClock(limit)}` : '',
      damage: 0,
      windowT: -1,
      windowPct: 0,
      arrive: triggerRadius(m.to, ARRIVE_PAD),
      text: `送「${m.name}」到${m.to.name}`,
      beacon: beacons.acquire('dest', m.to.x, m.to.z, m.slug),
    };
    objKeyT = -1; // 換委託：目標列計時 / 建議時間重算
    setStartBeaconsVisible(false);
    emit('ui:sound', { kind: 'confirm' });
    emit('mission:start', {
      id: m.slug,
      title: m.title,
      cargo: { name: m.name, file: m.file, client: m.client, conditions: m.conditions.slice(), tags: (m.tags || m.conditions).slice(), reward: m.reward, timeLimitSec: timed ? limit : 0, suggestSec: timed ? 0 : limit, from: m.from.slug, to: m.to.slug },
    });
    const text = `把「${m.name}」送到${m.to.name}`;
    emit('mission:stage', { id: m.slug, stage: 'deliver', text, x: m.to.x, z: m.to.z });
    emit('nav:destination', { x: m.to.x, z: m.to.z, label: m.to.name, source: 'mission' });
    const hint = conditionHint(m);
    ui.subtitle(hint ? `${text}。${hint}` : `${text}。`);
  }

  function endRun() {
    if (!run) return;
    beacons.release(run.beacon);
    run = null;
    setStartBeaconsVisible(true);
    ui.setObjective(null);
    emit('nav:clear', { source: 'mission' });
  }

  function complete() {
    const m = run.m;
    const timeSec = Math.round(run.elapsed * 10) / 10;
    const damagePct = has(m, 'fragile') ? Math.round(run.damage) : 0;
    const r = settleReward(m.reward, damagePct, run.limit, run.elapsed);
    endRun();
    completed[m.slug] = (completed[m.slug] || 0) + 1;
    if (!(best[m.slug] > 0) || timeSec < best[m.slug]) best[m.slug] = timeSec;
    cooldownUntil[m.slug] = now() + COOLDOWN_SEC;
    if (r.reward > 0) addMoney(r.reward, 'mission');
    emit('mission:complete', { id: m.slug, reward: r.reward, timeSec, damagePct, bonus: r.bonus });
    emit('ui:sound', { kind: 'reward' });
    refreshOffers();
    ui.showResult({ title: m.title, name: m.name, slug: m.slug, file: m.file, conditions: m.conditions, timeSec, damagePct, base: r.base, bonus: r.bonus, reward: r.reward, best: best[m.slug] });
    ui.subtitle(`送達${m.to.name}！入帳 NT$${r.reward}`);
  }

  function fail(reason) {
    if (!run) return;
    const m = run.m;
    endRun();
    emit('mission:fail', { id: m.slug, reason });
    emit('ui:sound', { kind: 'fail' });
    ui.showFail({ title: m.title, name: m.name, slug: m.slug, file: m.file, conditions: m.conditions, reasonText: FAIL_TEXT[reason] || '委託失敗。' });
    lastFailed = m.slug;
  }

  function navToNearestStart() {
    let bestOff = null;
    let bestD = Infinity;
    for (const off of offers) {
      const d = distTo(off.m.from);
      if (d < bestD) {
        bestD = d;
        bestOff = off;
      }
    }
    if (bestOff) emit('nav:destination', { x: bestOff.m.from.x, z: bestOff.m.from.z, label: bestOff.m.from.name, source: 'mission' });
  }

  function retry() {
    const slug = lastFailed;
    lastFailed = null;
    const m = slug ? bySlug.get(slug) : null;
    if (!m) return;
    pinned = slug;
    refreshOffers();
    emit('mission:stage', { id: m.slug, stage: 'pickup', text: `回到${m.from.name}重新接單`, x: m.from.x, z: m.from.z });
    emit('nav:destination', { x: m.from.x, z: m.from.z, label: m.from.name, source: 'mission' });
    ui.subtitle(`回到${m.from.name}重新接「${m.title}」`);
  }

  function onAction(action) {
    if (disposed) return;
    const mode = ui.mode();
    if (action === 'accept' && mode === 'offer') accept();
    else if (action === 'decline' && mode === 'offer') {
      if (pending && pending.slug === pinned) pinned = null;
      pending = null;
      ui.closePanel();
      emit('ui:sound', { kind: 'cancel' });
    } else if (action === 'again' && mode === 'result') {
      ui.closePanel();
      emit('ui:sound', { kind: 'click' });
      navToNearestStart();
    } else if (action === 'retry' && mode === 'fail') {
      ui.closePanel();
      emit('ui:sound', { kind: 'confirm' });
      retry();
    } else if ((action === 'continue' || action === 'close') && (mode === 'result' || mode === 'fail')) {
      if (mode === 'fail') lastFailed = null;
      ui.closePanel();
      emit('ui:sound', { kind: 'close' });
    }
  }

  // ---------- 條件 ----------
  function addDamage(pct) {
    if (!run || pct <= 0) return;
    run.damage = Math.min(100, run.damage + pct);
    if (run.damage >= 100) fail('destroyed');
  }

  function onVehicleImpact(e) {
    if (!run || !has(run.m, 'fragile')) return;
    const pct = impactDamagePct(e && e.relSpeed);
    if (pct <= 0) return;
    if (run.windowT >= 0 && run.elapsed - run.windowT < IMPACT_MERGE_SEC) {
      if (pct <= run.windowPct) return;
      const extra = pct - run.windowPct;
      run.windowPct = pct;
      addDamage(extra);
      return;
    }
    run.windowT = run.elapsed;
    run.windowPct = pct;
    addDamage(pct);
  }

  function onPlayerKo() {
    if (!run) return;
    if (has(run.m, 'fragile')) addDamage(KO_DAMAGE_PCT);
    else fail('ko');
  }

  // ---------- 每幀 ----------
  function update(dt, ctx) {
    if (disposed) return;
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.5) : 0;
    if (ctx) {
      const p = Number.isFinite(ctx.x) ? ctx : ctx.pos || ctx.position || null;
      if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) {
        px = p.x;
        pz = p.z;
        hasCtx = true;
      }
      driving = !!ctx.driving;
    }
    beacons.update(step);
    ui.update(step);
    if (!isReady) return;
    if (timed) {
      timed.update(run ? 0 : step, ctx);
      syncEventBeacons();
    }
    if (truck) {
      truck.update(step, ctx);
      syncTruckBeacons();
    }
    refreshT += step;
    if (refreshT >= 1) {
      refreshT = 0;
      if (needsRefresh()) refreshOffers();
    }
    if (!run) {
      const pm = pinned && hasCtx ? bySlug.get(pinned) : null;
      if (pm) {
        const dk = Math.round(distTo(pm.from));
        if (dk !== objKeyD) {
          objKeyD = dk;
          objDist = `${dk} m`;
        }
        ui.setObjective(pm.retryText || (pm.retryText = `回到${pm.from.name}重接委託`), '', objDist, '');
      } else if (evActive()) eventObjectiveRow();
      else if (truckEngaged()) eventObjectiveRow(truck.objective());
      else ui.setObjective(null);
      return;
    }
    run.elapsed += step;
    if (run.countdown && run.elapsed >= run.limit) {
      fail('timeout');
      return;
    }
    const d = hasCtx ? distTo(run.m.to) : Infinity;
    if (hasCtx && d <= run.arrive) {
      complete();
      return;
    }
    const m = run.m;
    const left = run.countdown ? run.limit - run.elapsed : 0;
    const tk = run.countdown ? Math.ceil(left) : -2;
    if (tk !== objKeyT) {
      objKeyT = tk;
      objTimer = run.countdown ? formatClock(left) : run.suggestText;
    }
    const dk = hasCtx ? Math.round(d) : -2;
    if (dk !== objKeyD) {
      objKeyD = dk;
      objDist = hasCtx ? `${dk} m` : '';
    }
    const gk = has(m, 'fragile') ? Math.round(run.damage) : -2;
    if (gk !== objKeyG) {
      objKeyG = gk;
      objDmg = gk >= 0 ? `損壞 ${gk}%` : '';
    }
    ui.setObjective(run.text, objTimer, objDist, objDmg, run.countdown && left < 15);
  }

  function nearest(pos) {
    if (disposed || !isReady || run || ui.isOpen() || !pos) return null;
    const x = pos.x;
    const z = pos.z;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    // 垃圾車投入口：追車中只認它；未追車時靠近車尾也可直接倒（同為 priority 3，投入口優先）
    const tk = truck ? truck.nearest(pos) : null;
    if (tk || truckEngaged()) return tk;
    if (evActive()) return null;
    let bestOff = null;
    let bestD = Infinity;
    for (let i = 0; i < offers.length; i++) {
      const l = offers[i].m.from;
      const d = Math.hypot(l.x - x, l.z - z);
      if (d <= triggerRadius(l, START_PAD) && d < bestD) {
        bestD = d;
        bestOff = offers[i];
      }
    }
    // 事件取餐點與委託起點重疊時取較近者（同為 priority 3）
    const ev = timed ? timed.nearest(pos) : null;
    if (!bestOff || (ev && ev.dist < bestD)) return ev;
    bestOff.inter.dist = bestD;
    return bestOff.inter;
  }

  function markers() {
    markerList.length = 0;
    if (run) {
      const mk = markerPool[0];
      mk.x = run.m.to.x;
      mk.z = run.m.to.z;
      mk.kind = 'mission-dest';
      mk.label = run.m.to.name;
      markerList.push(mk);
      return markerList;
    }
    if (evActive()) return pushEventMarkers();
    if (truckEngaged()) return pushTruckMarkers();
    for (let i = 0; i < offers.length && i < markerPool.length; i++) {
      const mk = markerPool[i];
      const m = offers[i].m;
      mk.x = m.from.x;
      mk.z = m.from.z;
      mk.kind = 'mission-start';
      mk.label = m.title;
      markerList.push(mk);
    }
    if (timed) pushEventMarkers();
    return truck ? pushTruckMarkers() : markerList;
  }

  function pushTruckMarkers() {
    const list = truck.markers();
    for (let i = 0; i < list.length; i++) markerList.push(list[i]);
    return markerList;
  }

  function pushEventMarkers() {
    const list = timed.markers();
    for (let i = 0; i < list.length; i++) markerList.push(list[i]);
    return markerList;
  }

  function objective() {
    if (!run) return null;
    const m = run.m;
    objectiveOut.text = run.text;
    objectiveOut.timerSec = run.countdown ? Math.max(0, run.limit - run.elapsed) : null;
    objectiveOut.suggestSec = !run.countdown && run.limit > 0 ? run.limit : null;
    objectiveOut.distM = hasCtx ? distTo(m.to) : null;
    objectiveOut.damagePct = has(m, 'fragile') ? run.damage : null;
    return objectiveOut;
  }

  function active() {
    if (!run) return null;
    const m = run.m;
    activeOut.id = m.slug;
    activeOut.slug = m.slug;
    activeOut.title = m.title;
    activeOut.stage = 'deliver';
    activeOut.from = m.from;
    activeOut.to = m.to;
    activeOut.elapsedSec = run.elapsed;
    activeOut.timerSec = run.countdown ? Math.max(0, run.limit - run.elapsed) : null;
    activeOut.suggestSec = !run.countdown && run.limit > 0 ? run.limit : null;
    activeOut.damagePct = has(m, 'fragile') ? run.damage : null;
    activeOut.conditions = m.conditions;
    activeOut.tags = m.tags || m.conditions;
    return activeOut;
  }

  function speedScale() {
    return run && has(run.m, 'heavy') && !driving ? HEAVY_SPEED_SCALE : 1;
  }

  function abandon() {
    if (!run && evActive()) timed.abandon();
    else if (!run && truckEngaged()) truck.abandon();
    else fail('abandon');
  }

  // ---------- 時段限定事件 ----------
  function onTimedEvent(name, p) {
    if (name === 'event:start') {
      objKeyT = -1;
      objKeyD = -1;
      ui.subtitle(`取餐完成！${formatClock(p.limitSec)} 內把餐點送到${p.toName}（路程約 ${p.routeM} m）`);
    } else if (name === 'event:complete') ui.subtitle(`外送送達！入帳 NT$${p.reward}`);
    else if (name === 'event:fail') ui.subtitle(p.reason === 'timeout' ? '外送逾時，客人取消了訂單（不扣錢）。' : '外送取消了（不扣錢）。');
  }

  const TRUCK_FAIL_TEXT = {
    timeout: '垃圾車收完這一區開走了……（不扣錢）',
    lost: '跟丟垃圾車了（不扣錢）。',
    abandon: '你放棄追垃圾車了（不扣錢）。',
  };

  function onTruckEvent(name, p) {
    if (name === 'event:available') ui.subtitle(`🎵 垃圾車來了！追上它，到車尾${interactLabel} 倒垃圾`);
    else if (name === 'event:start') {
      objKeyT = -1;
      objKeyD = -1;
      ui.subtitle(`追上垃圾車！${formatClock(p.leftSec)} 內到車尾投入口${interactLabel} 倒垃圾`);
    } else if (name === 'event:complete') ui.subtitle(`垃圾倒好了！入帳 NT$${p.reward}`);
    else if (name === 'event:fail') ui.subtitle(TRUCK_FAIL_TEXT[p.reason] || '垃圾車開走了（不扣錢）。');
  }

  // 追車狀態切換時一併切換委託起點 / 外送取餐點光柱
  let truckWasEngaged = false;
  function syncTruckBeacons() {
    const on = truckEngaged();
    if (on === truckWasEngaged) return;
    truckWasEngaged = on;
    if (!run && !evActive()) setStartBeaconsVisible(!on);
    for (const [key, b] of evBeacons) if (key.startsWith('start:')) b.group.visible = !on && !run;
  }

  function evBeacon(key, kind, x, z, owner) {
    let b = evBeacons.get(key);
    if (!b) {
      b = beacons.acquire(kind, x, z, owner);
      evBeacons.set(key, b);
    }
    return b;
  }

  // 事件光柱：開放中的取餐點（委託進行中隱藏）、進行中的送達點；事件進行狀態切換時一併切換委託起點光柱
  function syncEventBeacons() {
    const act = timed.active();
    for (const [key, b] of evBeacons) {
      const id = key.slice(key.indexOf(':') + 1);
      const keep = key.startsWith('dest:') ? act && act.id === id : !act && timed.isOpen(id);
      if (!keep) {
        beacons.release(b);
        evBeacons.delete(key);
      }
    }
    if (act) evBeacon(`dest:${act.id}`, 'dest', act.to.x, act.to.z, act.id);
    else {
      const defs = timed.defs();
      for (let i = 0; i < defs.length; i++) {
        const d = defs[i];
        if (timed.isOpen(d.id)) evBeacon(`start:${d.id}`, 'start', d.pickup.x, d.pickup.z, d.id).group.visible = !run && !truckEngaged();
      }
    }
    const on = !!act;
    if (on !== evWasActive) {
      evWasActive = on;
      if (!run) setStartBeaconsVisible(!on);
    }
  }

  function eventObjectiveRow(src) {
    const o = src || timed.objective();
    const tk = Math.ceil(o.timerSec);
    if (tk !== objKeyT) {
      objKeyT = tk;
      objTimer = formatClock(o.timerSec);
    }
    const dk = o.distM === null ? -2 : Math.round(o.distM);
    if (dk !== objKeyD) {
      objKeyD = dk;
      objDist = dk >= 0 ? `${dk} m` : '';
    }
    ui.setObjective(o.text, objTimer, objDist, '', o.timerSec < 15);
  }

  // ---------- 存檔（§18 missions）----------
  function serialize() {
    const t = now();
    const cd = {};
    for (const k of Object.keys(cooldownUntil)) {
      const left = cooldownUntil[k] - t;
      if (left > 0) cd[k] = Math.ceil(left);
    }
    const out = { completed: { ...completed }, best: { ...best }, cooldowns: cd, active: run ? { slug: run.m.slug, stage: 'deliver' } : null };
    if (timed) {
      const ev = timed.serialize();
      if (Object.keys(ev.completed).length || Object.keys(ev.cooldowns).length) out.events = ev;
    }
    if (truck) {
      const tv = truck.serialize();
      if (Object.keys(tv.completed).length || Object.keys(tv.cooldowns).length) {
        const ev = out.events || (out.events = { completed: {}, cooldowns: {} });
        Object.assign(ev.completed, tv.completed);
        Object.assign(ev.cooldowns, tv.cooldowns);
      }
    }
    return out;
  }

  function applyRestore(data) {
    for (const o of [completed, best, cooldownUntil]) for (const k of Object.keys(o)) delete o[k];
    const src = data && typeof data === 'object' ? data : {};
    const pick = (obj, fn) => {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
      for (const k of Object.keys(obj)) {
        const v = Number(obj[k]);
        if (!bySlug.has(k) || !Number.isFinite(v) || v < 0) continue;
        fn(k, v);
      }
    };
    pick(src.completed, (k, v) => {
      if (v >= 1) completed[k] = Math.floor(v);
    });
    pick(src.best, (k, v) => {
      if (v > 0) best[k] = v;
    });
    const t = now();
    pick(src.cooldowns, (k, v) => {
      if (v > 0) cooldownUntil[k] = t + Math.min(COOLDOWN_SEC, v);
    });
    // 進行中的委託一律作廢（不發 mission:fail），回到可接狀態
    pending = null;
    pinned = null;
    lastFailed = null;
    ui.closePanel();
    if (run) endRun();
    if (timed) {
      timed.restore(src.events);
      syncEventBeacons();
    }
    if (truck) {
      truck.restore(src.events);
      syncTruckBeacons();
    }
    refreshOffers();
  }

  function restore(data) {
    if (disposed) return;
    if (!isReady) {
      pendingRestore = data;
      return;
    }
    applyRestore(data);
  }

  function dispose() {
    if (disposed) return;
    if (run) endRun();
    if (timed) timed.dispose();
    if (truck) truck.dispose();
    evBeacons.clear();
    disposed = true;
    offers.length = 0;
    beacons.dispose();
    ui.dispose();
  }

  const ready = loadCatalog({ fetchJson, landmarks, url: manifestUrl, info }).then((res) => {
    catalog = res.list;
    source = res.source;
    for (const m of catalog) bySlug.set(m.slug, m);
    isReady = true;
    if (disposed) return { source, count: catalog.length };
    if (pendingRestore !== null) {
      const d = pendingRestore;
      pendingRestore = null;
      applyRestore(d);
    } else refreshOffers();
    return { source, count: catalog.length };
  });

  return {
    ready,
    update,
    nearest,
    markers,
    objective,
    onVehicleImpact,
    onPlayerKo,
    active,
    serialize,
    restore,
    dispose,
    speedScale,
    isModalOpen: () => ui.isOpen(),
    abandon,
    eventObjective: () => (timed && timed.objective()) || (truck && truck.objective()) || null,
    eventActive: () => (timed && timed.active()) || (truck && truck.active()) || null,
    events: timed,
    truck,
    truckState: () => (truck ? truck.truck() : null),
    // 除錯 / 測試
    catalog: () => catalog,
    source: () => source,
    offers: () => offers.map((o) => o.m.slug),
    ui,
    beacons,
    conditionLabels: CONDITION_LABELS,
  };
}
