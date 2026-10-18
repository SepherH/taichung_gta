// V3 街頭隨機犯罪事件（罪惡之都）：玩家不出手，街上也會出事。純邏輯排程 + 世界轉接分開，本檔不 import three / rapier（node 可直接測）
//
// createStreetEvents({ bus, rng, config }) → { update(dt, ctx), active, cancel(), dispose(), isEventActor(a), shotAtEvent(x, z, vehicle), vehicleHitByPlayer(v), markers(out), events, stats() }
//   bus：emit street:start { id, kind, x, z } / street:resolve { id, kind, outcome, reward, x, z }、toast（ctx.toast 省略時）；
//     訂閱 combat:hit / ped:knockdown / ped:dead（byPlayer 且對象是事件歹徒 → 記為玩家出手）、weapon:impact（byPlayer 打到事件車 → 記為玩家出手）
//   rng：() → [0, 1)；config：覆寫 DEFAULTS 內任一數值（測試用）
//   update(dt, ctx)：每幀；ctx = { player: { x, z }, view?: { dx, dz }（鏡頭水平朝向單位向量；省略 = 不檢查視野）, hour（遊戲時刻 0–24）,
//     busy（暫停 / 手機 / 噴漆 / 搶劫 / 警車任務 / 競速 中：不生成新事件，既有事件照常收尾）, world（見下）, earn(n), toast?(text, sec), zoneAt?(x, z) → 幫派地盤 | null }
//   cancel()：所有進行中事件無聲收尾（world.release(h, 'cancel')）、排程重置（回主選單 / 開新局）；dispose() = cancel + 取消訂閱
//   isEventActor(a)：事件歹徒（搶匪 / 下車罪犯 / 酒駕司機 / 槍戰成員；結束後 ACTOR_GRACE 秒內仍算）→ 玩家對其動手不算犯行；
//     以登記當時的 a.id 比對（traffic 骨架回池後同一 actor 物件換給別的市民只改 id → 新身分不沿用豁免）
//   shotAtEvent(x, z, vehicle)：子彈打中的車（weapon:fire.vehicle）就是進行中的罪犯車 / 酒駕車本身（handle.vehicle）且落點在 SHOT_RADIUS 內 → 不算 gunfire；
//     只看落點不看命中車會連罪犯車旁的警察 / 路人也一併豁免
//   vehicleHitByPlayer(v)：玩家駕駛的車撞到事件車（整合層 contacts router 呼叫）→ 記為玩家出手
//   markers(out)：事件開始 / 提示後 BLINK_SEC 秒內，小地圖黃點（kind 'street-event'）每 BLINK_PERIOD 秒閃爍一次
// 排程：冷卻 COOLDOWN_MIN–MAX 秒（事件開始時起算）後，每 CHECK_SEC 秒以 spawnChance(hour, 玩家在幫派地盤內) 擲骰；
//   夜間（NIGHT_FROM–NIGHT_TO）× NIGHT_MULT、地盤內 × ZONE_MULT；同時進行 ≤ MAX_ACTIVE；busy 時不擲骰（冷卻照走）
//   種類權重 kindWeights（夜間搶劫 / 酒駕較多；槍戰只在 SPAWN_MIN–SPAWN_MAX 環帶內有地盤邊界點時、地盤內加倍）
//   生成點：玩家 SPAWN_MIN–SPAWN_MAX m（行人事件上限 PED_SPAWN_MAX = 骨架行人半徑內）、與鏡頭朝向夾角 EDGE_MIN–EDGE_MAX（視野邊緣，不在正前方也不在正後方）；
//     world 吸附到路網 / 人行道後再驗一次，不合格就 release 換下一個候選
// 事件（每件 TIMEOUT_MIN–MAX 秒超時；結束一律 world.release 回收參與者與車輛）：
//   robbery 搶劫路人：歹徒跑向路人 → 推倒（combat 擊倒，ped-ambient / npc-ai 目擊者照既有反應）、受害者喊叫 → 歹徒逃跑；
//     玩家打倒歹徒（bus 記到玩家出手）→ 受害者道謝、賞金 ROB_REWARD_MIN–MAX（被別人撞倒不算，玩家在旁也不算）；歹徒離玩家 > PED_ESCAPE_DIST 或被回收 → 逃脫
//   chase 警匪追車：罪犯車沿路網逃竄（背離玩家 / 警車），1–2 台警車（既有 police adapters）追逐、近距離 ram；
//     耐久 ≤ SUBDUE_HEALTH、或低速 SLOW_SEC 秒 → 玩家出手過（撞擊 / 射擊事件車）= 玩家撞停（賞金 CHASE_REWARD_MIN–MAX）、否則 = 警方逮捕；玩家開走罪犯車也算制伏；
//     只是玩家剛好在旁邊不算（賞金只給真的出手的玩家）
//   gang 幫派槍戰：地盤邊界兩幫成員互射 GANG_FIGHT_MIN–MAX 秒（gangs.skirmish，沿用互毆 / 開槍流程；流彈由 world 判定可傷路人與玩家）
//   drunk 酒駕亂衝：一台車蛇行（wobble）、車速忽快忽慢、不理號誌；自己撞到熄火 / 卡住 = crashed，玩家出手後停下 / 開走 = subdued（賞金 DRUNK_REWARD_MIN–MAX）
// world（ctx.world；整合層用 createStreetWorld，測試以替身注入）：
//   spawn(kind, x, z, ev) → handle | null（handle.x / z = 實際位置；handle.actors = 歹徒 actor 陣列；handle.vehicle = 事件車（追車 / 酒駕）；
//     ev.a / ev.b = 槍戰兩幫 id、ev.sec = 槍戰秒數）
//   poll(h, out) → out（{ x, z, gone, reach, down, speed, health, driven, fighting }）
//   act(h, verb, ev) → 'approach' | 'grab' | 'flee' | 'subdued'（搶劫）、'drive'（ev.gx / gz / speed / wobble；追車時警車同步追）、'eject' → actor | null
//   release(h, outcome)：回收（車輛離開視線後移除、熄火殘骸交一般回收；行人離開視線後回收）
// 錯開更新：事件邏輯每 POLL_SEC 秒（以累積 dt 計，兩個 slot 相位錯開半格）輪詢一次 world；排程每 CHECK_SEC 秒一次；
//   slot / 輸出 / 標記物件建構時配置，每幀路徑不配置（只有事件開始 / 結束的 payload 與 handle 才配置）
import { GANGS, territoryAt as gangTerritoryAt } from './gangs.js';
import { SMOKE_DARK_AT } from './vehicle-damage.js';
import { doorPoint, EJECT_OFFSET } from './carjack.js';

export const KINDS = Object.freeze(['robbery', 'chase', 'gang', 'drunk']);
export const OUTCOMES = Object.freeze(['subdued', 'escaped', 'arrested', 'crashed', 'over', 'timeout', 'cancel']);
export const MARKER_KIND = 'street-event';

export const DEFAULTS = {
  maxActive: 2, // 同時進行上限
  cooldownMin: 45, // s，事件開始後到下一件可生成
  cooldownMax: 90,
  checkSec: 5, // s，冷卻結束後的擲骰間隔
  baseChance: 0.12, // 每次擲骰的基礎機率（白天、地盤外）
  nightMult: 2, // 夜間倍率
  zoneMult: 1.6, // 玩家在幫派地盤內倍率
  nightFrom: 20, // 夜間時段（含）
  nightTo: 5, // 夜間時段（不含）
  retrySec: 2, // s，生成失敗後重試
  kindMul: [1, 1, 1, 1], // 種類權重倍率（KINDS 順序；調整 / 測試用，0 = 停用該種）
  spawnMin: 60, // m，生成環帶
  spawnMax: 200,
  pedSpawnMax: 100, // m，行人事件（搶劫 / 槍戰）上限：骨架行人只存在於 pedFar（70–130 m）內
  edgeMin: (60 * Math.PI) / 180, // 與鏡頭朝向夾角下限：須 > 水平半視角（vfov 60°：16:9 = 45.7°、21:9 = 53.4°），生成點在畫面外
  edgeMax: (100 * Math.PI) / 180, // 上限（不在正後方）
  spotTries: 6,
  timeoutMin: 60, // s，事件超時
  timeoutMax: 120,
  hintDist: 80, // m，此距離內 HUD 提示
  blinkSec: 6, // s，小地圖黃點閃爍時間
  blinkPeriod: 0.25, // s，亮 / 暗半週期
  pollSec: 0.1, // s，事件邏輯輪詢間隔
  actorGrace: 20, // s，事件結束後歹徒仍不算犯行對象的時間
  // 搶劫
  approachMax: 15, // s，歹徒接近受害者最長時間（超過 = 事件作罷）
  pedEscapeDist: 120, // m，歹徒離玩家此距離 → 逃脫
  robRewardMin: 100,
  robRewardMax: 200,
  // 追車 / 酒駕
  carEscapeDist: 260, // m，車離玩家此距離 → 逃脫
  subdueHealth: SMOKE_DARK_AT, // 耐久 ≤ 此值（黑煙降功率）→ 撞停
  slowSpeed: 1, // m/s
  slowSec: 7, // s，須 > 事件車卡住倒車 STUCK_SEC + REVERSE_SEC（5.5 s）：先讓車自己倒車脫困，脫困不了才算停
  slowGrace: 5, // s，事件開始後此時間內不判低速（起步）
  chaseSpeed: 22, // m/s，罪犯車逃竄速度（警車 PURSUE 24–26）
  fleeDist: 250, // m，逃竄目標距離
  fleeSpread: 1.2, // rad
  replanSec: 8, // s
  fleeReach: 30, // m
  chaseRewardMin: 300,
  chaseRewardMax: 500,
  drunkSpeedMin: 5, // m/s，酒駕車速忽快忽慢（正弦 + 抖動）
  drunkSpeedMax: 20,
  drunkSpeedPeriod: 7, // s
  drunkWobble: 0.55, // 方向盤蛇行幅度（steer 加量，±1 滿舵）
  drunkWobblePeriod: 2.6, // s
  drunkSlowSec: 8, // s，低速多久視為撞停（同 slowSec，> STUCK_SEC + REVERSE_SEC）
  drunkRewardMin: 100,
  drunkRewardMax: 200,
  // 槍戰
  gangFightMin: 10, // s
  gangFightMax: 20,
  shotRadius: 4.5, // m
  maxDt: 0.1, // s
};

export const HINTS = Object.freeze({
  robbery: '附近有人被搶！',
  chase: '附近有警匪追車！',
  gang: '附近爆發幫派槍戰！',
  drunk: '小心！附近有酒駕亂衝！',
});
export const toastReward = (kind, reward) =>
  kind === 'robbery' ? `受害者：謝謝你！賞金 NT$${reward}` : kind === 'chase' ? `協助警方攔下罪犯車！賞金 NT$${reward}` : `攔下酒駕！賞金 NT$${reward}`;
export const TOAST_ESCAPED = Object.freeze({ robbery: '搶匪逃走了…', chase: '罪犯車逃脫了', drunk: '酒駕車開走了' });
export const TOAST_ARRESTED = '警方攔下了罪犯車';

const TAU = Math.PI * 2;

// ---------- 純函式 ----------
export function isNight(hour, C = DEFAULTS) {
  const h = ((Number(hour) % 24) + 24) % 24;
  return C.nightFrom > C.nightTo ? h >= C.nightFrom || h < C.nightTo : h >= C.nightFrom && h < C.nightTo;
}
export function rateMultiplier(hour, inZone, C = DEFAULTS) {
  return (isNight(hour, C) ? C.nightMult : 1) * (inZone ? C.zoneMult : 1);
}
export function spawnChance(hour, inZone, C = DEFAULTS) {
  return Math.min(1, C.baseChance * rateMultiplier(hour, inZone, C));
}
// 種類權重（KINDS 順序寫進 out）
export function kindWeights(hour, inZone, hasBorder, out = [0, 0, 0, 0], C = DEFAULTS) {
  const night = isNight(hour, C);
  out[0] = night ? 1.5 : 1; // robbery
  out[1] = 1; // chase
  out[2] = hasBorder ? (inZone ? 3 : 1.5) : 0; // gang
  out[3] = night ? 1.8 : 0.6; // drunk
  return out;
}
export function pickWeighted(weights, r) {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) sum += Math.max(0, weights[i]);
  if (!(sum > 0)) return -1;
  let t = r * sum;
  for (let i = 0; i < weights.length; i++) {
    const w = Math.max(0, weights[i]);
    if (t < w) return i;
    t -= w;
  }
  for (let i = weights.length - 1; i >= 0; i--) if (weights[i] > 0) return i;
  return -1;
}
// (x, z) 是否在玩家 rMin–rMax 環帶內、與鏡頭朝向 (dx, dz) 夾角 edgeMin–edgeMax（view 省略 = 只看距離）
export function edgeOk(px, pz, view, x, z, rMin, rMax, C = DEFAULTS) {
  const ox = x - px;
  const oz = z - pz;
  const d2 = ox * ox + oz * oz;
  if (!(d2 >= rMin * rMin && d2 <= rMax * rMax)) return false;
  if (!view || !Number.isFinite(view.dx) || !Number.isFinite(view.dz)) return true;
  const vl = Math.sqrt(view.dx * view.dx + view.dz * view.dz);
  if (vl < 1e-6) return true;
  const c = (ox * view.dx + oz * view.dz) / (Math.sqrt(d2) * vl);
  return c <= Math.cos(C.edgeMin) + 1e-9 && c >= Math.cos(C.edgeMax) - 1e-9;
}
// 視野邊緣候選點（r1：左右、r2：夾角、r3：距離）
export function edgeCandidate(px, pz, view, rMin, rMax, r1, r2, r3, out, C = DEFAULTS) {
  let base = r1 * TAU;
  let off = 0;
  if (view && Number.isFinite(view.dx) && Number.isFinite(view.dz) && (view.dx !== 0 || view.dz !== 0)) {
    base = Math.atan2(view.dx, view.dz);
    off = (r1 < 0.5 ? -1 : 1) * (C.edgeMin + r2 * (C.edgeMax - C.edgeMin));
  }
  const a = base + off;
  const d = rMin + r3 * (rMax - rMin);
  out.x = px + Math.sin(a) * d;
  out.z = pz + Math.cos(a) * d;
  return out;
}
export const rewardRoll = (min, max, r) => min + Math.min(max - min, Math.floor(r * (max - min + 1)));

// 地盤邊界取樣點（模組載入時算一次）：每段邊每 BORDER_STEP m 一點，往外推 BORDER_OUT m；rival = 地盤重心最近的另一幫
export const BORDER_STEP = 20;
export const BORDER_OUT = 6;
function centroid(poly) {
  let x = 0;
  let z = 0;
  const n = poly.length / 2;
  for (let i = 0; i < poly.length; i += 2) {
    x += poly[i];
    z += poly[i + 1];
  }
  return { x: x / n, z: z / n };
}
export const BORDER_POINTS = (() => {
  const out = [];
  const cs = GANGS.map((g) => centroid(g.territory));
  GANGS.forEach((g, gi) => {
    let rival = null;
    let best = Infinity;
    GANGS.forEach((o, oi) => {
      if (oi === gi) return;
      const d = Math.hypot(cs[oi].x - cs[gi].x, cs[oi].z - cs[gi].z);
      if (d < best) {
        best = d;
        rival = o.id;
      }
    });
    const p = g.territory;
    const n = p.length / 2;
    const c = cs[gi];
    for (let i = 0; i < n; i++) {
      const ax = p[i * 2];
      const az = p[i * 2 + 1];
      const bx = p[((i + 1) % n) * 2];
      const bz = p[((i + 1) % n) * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az);
      for (let s = BORDER_STEP / 2; s < L; s += BORDER_STEP) {
        const x = ax + ((bx - ax) * s) / L;
        const z = az + ((bz - az) * s) / L;
        const ox = x - c.x;
        const oz = z - c.z;
        const ol = Math.hypot(ox, oz) || 1;
        out.push({ x: x + (ox / ol) * BORDER_OUT, z: z + (oz / ol) * BORDER_OUT, gang: g.id, rival });
      }
    }
  });
  return out;
})();
// 環帶 / 視野邊緣內的地盤邊界點（start = 起始索引，0..1）；沒有回 null
export function borderSpot(px, pz, view, rMin, rMax, start, C = DEFAULTS) {
  const n = BORDER_POINTS.length;
  const i0 = Math.floor(Math.min(Math.max(start, 0), 0.999999) * n);
  for (let k = 0; k < n; k++) {
    const b = BORDER_POINTS[(i0 + k) % n];
    if (edgeOk(px, pz, view, b.x, b.z, rMin, rMax, C)) return b;
  }
  return null;
}
// 流彈：從 (fx, fz) 沿單位方向 (dx, dz) 射程 range，目標 (tx, tz) 離射線 ≤ radius → 回沿線距離，否則 −1
export function strayHit(fx, fz, dx, dz, range, tx, tz, radius) {
  const ox = tx - fx;
  const oz = tz - fz;
  const t = ox * dx + oz * dz;
  if (t <= 0.5 || t > range) return -1;
  const lx = ox - dx * t;
  const lz = oz - dz * t;
  return lx * lx + lz * lz <= radius * radius ? t : -1;
}

// ---------- 排程 + 事件邏輯 ----------
export function createStreetEvents({ bus = null, rng = Math.random, config = {} } = {}) {
  const C = { ...DEFAULTS, ...config };
  const rand = () => {
    const r = Number(rng());
    return Number.isFinite(r) ? Math.min(Math.max(r, 0), 0.999999) : 0;
  };
  const emit = (name, payload) => {
    if (bus && typeof bus.emit === 'function') bus.emit(name, payload);
  };
  const outTemplate = () => ({ x: NaN, z: NaN, gone: false, reach: false, down: false, speed: 0, health: null, driven: false, fighting: 0 });
  const slots = [];
  for (let i = 0; i < C.maxActive; i++) {
    slots.push({
      slot: i,
      id: null,
      kind: null,
      phase: null,
      h: null,
      t: 0,
      timeout: 0,
      pollAcc: (i * C.pollSec) / Math.max(1, C.maxActive), // 相位錯開
      x: NaN,
      z: NaN,
      hinted: false,
      blinkT: Infinity,
      byPlayer: false,
      slowT: 0,
      planT: 0,
      step: 0, // 本次輪詢累積秒數（欄位傳遞：避免把浮點數當參數傳給未內聯函式而裝箱）
      d2: 0, // 本次輪詢時與玩家距離平方
      gx: NaN,
      gz: NaN,
      ev: { a: null, b: null, sec: 0, gx: NaN, gz: NaN, speed: 0, wobble: 0, fromX: NaN, fromZ: NaN },
      out: outTemplate(),
      marker: { x: 0, z: 0, kind: MARKER_KIND },
    });
  }
  const weights = [0, 0, 0, 0];
  const cand = { x: 0, z: 0 };
  const actors = new Map(); // actor → { ev: slot, id }（進行中；id = 登記時的 actor.id）
  const grace = new Map(); // actor → { until, id }（已結束）
  const st = { time: 0, cooldown: 0, checkT: 0, seq: 0, started: 0, resolved: 0, rewards: 0, world: null, ctx: null, px: 0, pz: 0 };
  st.cooldown = C.cooldownMin + rand() * (C.cooldownMax - C.cooldownMin); // 開局後第一件也要等一輪冷卻

  function toast(text, sec) {
    const ctx = st.ctx;
    if (ctx && typeof ctx.toast === 'function') ctx.toast(text, sec);
    else emit('toast', { text, seconds: sec });
  }
  const activeCount = () => {
    let n = 0;
    for (let i = 0; i < slots.length; i++) if (slots[i].kind) n++;
    return n;
  };

  // ---------- 生成 ----------
  function trySpawn(ctx, inZone) {
    const px = st.px;
    const pz = st.pz;
    const world = ctx.world;
    if (!world || typeof world.spawn !== 'function') return false;
    let ev = null;
    for (let i = 0; i < slots.length; i++) {
      if (!slots[i].kind) {
        ev = slots[i];
        break;
      }
    }
    if (!ev) return false;
    const view = ctx.view || null;
    const border = borderSpot(px, pz, view, C.spawnMin, Math.min(C.spawnMax, C.pedSpawnMax), rand(), C);
    kindWeights(ctx.hour, inZone, !!border, weights, C);
    for (let i = 0; i < weights.length; i++) weights[i] *= C.kindMul[i] ?? 1;
    const ki = pickWeighted(weights, rand());
    if (ki < 0) return false;
    const kind = KINDS[ki];
    const ped = kind === 'robbery' || kind === 'gang';
    const rMax = ped ? Math.min(C.spawnMax, C.pedSpawnMax) : C.spawnMax;
    ev.ev.a = null;
    ev.ev.b = null;
    ev.ev.sec = 0;
    for (let k = 0; k < C.spotTries; k++) {
      let x;
      let z;
      if (kind === 'gang') {
        const b = k === 0 ? border : borderSpot(px, pz, view, C.spawnMin, rMax, rand(), C);
        if (!b) return false;
        x = b.x;
        z = b.z;
        ev.ev.a = b.gang;
        ev.ev.b = b.rival;
        ev.ev.sec = C.gangFightMin + rand() * (C.gangFightMax - C.gangFightMin);
      } else {
        edgeCandidate(px, pz, view, C.spawnMin, rMax, rand(), rand(), rand(), cand, C);
        x = cand.x;
        z = cand.z;
      }
      const h = world.spawn(kind, x, z, ev.ev);
      if (!h) continue;
      if (!edgeOk(px, pz, view, h.x, h.z, C.spawnMin, rMax + 15, C)) {
        // 吸附到路網 / 人行道後跑出環帶或進了畫面正中：作罷換下一個候選（+15 m 容許吸附誤差）
        if (typeof world.release === 'function') world.release(h, 'cancel');
        continue;
      }
      begin(ev, kind, h);
      return true;
    }
    return false;
  }

  function begin(ev, kind, h) {
    ev.id = `street-${++st.seq}`;
    ev.kind = kind;
    ev.h = h;
    ev.t = 0;
    ev.timeout = C.timeoutMin + rand() * (C.timeoutMax - C.timeoutMin);
    ev.x = h.x;
    ev.z = h.z;
    ev.hinted = false;
    ev.blinkT = 0;
    ev.byPlayer = false;
    ev.slowT = 0;
    ev.planT = 0;
    ev.gx = NaN;
    ev.gz = NaN;
    ev.phase = kind === 'robbery' ? 'approach' : kind === 'gang' ? 'fight' : 'drive';
    const o = ev.out;
    o.x = h.x;
    o.z = h.z;
    o.gone = false;
    o.reach = false;
    o.down = false;
    o.speed = 0;
    o.health = null;
    o.driven = false;
    o.fighting = 0;
    if (h.actors) for (const a of h.actors) addActor(a, ev);
    st.cooldown = C.cooldownMin + rand() * (C.cooldownMax - C.cooldownMin);
    st.started++;
    emit('street:start', { id: ev.id, kind, x: h.x, z: h.z });
    hint(ev);
  }

  // 身分 = actor 物件 + 登記當時的 a.id：traffic 骨架回池重用時沿用同一 actor 物件、只改 a.id（換成新市民）
  function addActor(a, ev) {
    if (!a) return;
    actors.set(a, { ev, id: a.id });
    grace.delete(a);
  }
  const sameActor = (a, rec) => !!rec && rec.id === a.id;

  function hint(ev) {
    if (ev.hinted) return;
    const dx = ev.x - st.px;
    const dz = ev.z - st.pz;
    if (dx * dx + dz * dz > C.hintDist * C.hintDist) return;
    ev.hinted = true;
    ev.blinkT = 0;
    toast(HINTS[ev.kind], 3);
  }

  // ---------- 結束 ----------
  function resolve(ev, outcome, reward = 0) {
    const world = st.world;
    const kind = ev.kind;
    if (world && typeof world.release === 'function' && ev.h) world.release(ev.h, outcome);
    for (const [a, rec] of actors) {
      if (rec.ev !== ev) continue;
      actors.delete(a);
      grace.set(a, { until: st.time + C.actorGrace, id: rec.id });
    }
    if (reward > 0) {
      st.rewards += reward;
      const ctx = st.ctx;
      if (ctx && typeof ctx.earn === 'function') ctx.earn(reward);
      toast(toastReward(kind, reward), 4);
    } else if (outcome !== 'cancel' && ev.hinted) {
      if (outcome === 'escaped' && TOAST_ESCAPED[kind]) toast(TOAST_ESCAPED[kind], 2.5);
      else if (outcome === 'arrested') toast(TOAST_ARRESTED, 2.5);
    }
    st.resolved++;
    emit('street:resolve', { id: ev.id, kind, outcome, reward, x: ev.x, z: ev.z });
    ev.kind = null;
    ev.phase = null;
    ev.h = null;
    ev.blinkT = Infinity;
  }

  // ---------- 事件邏輯（每 pollSec） ----------
  function planFlee(ev) {
    let dx = ev.x - st.px;
    let dz = ev.z - st.pz;
    const L = Math.sqrt(dx * dx + dz * dz);
    let a = L > 1e-6 ? Math.atan2(dx, dz) : rand() * TAU;
    a += (rand() - 0.5) * C.fleeSpread;
    dx = Math.sin(a);
    dz = Math.cos(a);
    ev.gx = ev.x + dx * C.fleeDist;
    ev.gz = ev.z + dz * C.fleeDist;
    ev.planT = C.replanSec;
  }

  function stepRobbery(ev, world) {
    const o = ev.out;
    const h = ev.h;
    const d2 = ev.d2;
    if (o.gone) return resolve(ev, 'escaped');
    if (o.down) {
      if (ev.byPlayer) {
        world.act(h, 'subdued', ev.ev);
        return resolve(ev, 'subdued', rewardRoll(C.robRewardMin, C.robRewardMax, rand()));
      }
      return; // 被別人 / 車撞倒（玩家沒出手，在旁邊也不算）：等他起身繼續逃
    }
    if (ev.phase === 'approach') {
      if (o.reach) {
        world.act(h, 'grab', ev.ev);
        ev.phase = 'flee';
        ev.ev.fromX = st.px;
        ev.ev.fromZ = st.pz;
        world.act(h, 'flee', ev.ev);
        return;
      }
      if (ev.t > C.approachMax) return resolve(ev, 'timeout');
      world.act(h, 'approach', ev.ev);
      return;
    }
    if (d2 > C.pedEscapeDist * C.pedEscapeDist) return resolve(ev, 'escaped');
    ev.ev.fromX = st.px;
    ev.ev.fromZ = st.pz;
    world.act(h, 'flee', ev.ev);
  }

  function stepCar(ev, world) {
    const o = ev.out;
    const h = ev.h;
    const d2 = ev.d2;
    if (o.gone) return resolve(ev, 'escaped');
    const chase = ev.kind === 'chase';
    const rewardMin = chase ? C.chaseRewardMin : C.drunkRewardMin;
    const rewardMax = chase ? C.chaseRewardMax : C.drunkRewardMax;
    let stopped = o.driven || (Number.isFinite(o.health) && o.health <= C.subdueHealth);
    if (!stopped && ev.t >= C.slowGrace && Math.abs(o.speed) < C.slowSpeed) {
      ev.slowT += ev.step;
      if (ev.slowT >= (chase ? C.slowSec : C.drunkSlowSec) - 1e-9) stopped = true;
    } else if (!stopped) ev.slowT = 0;
    if (stopped) {
      if (!o.driven) addActor(world.act(h, 'eject', ev.ev), ev);
      // 賞金只給真的出手的玩家：開走事件車，或撞擊 / 射擊過事件車（byPlayer）；自己撞牆 / 卡住 / 被警車撞停 = crashed / arrested
      if (o.driven || ev.byPlayer) return resolve(ev, 'subdued', rewardRoll(rewardMin, rewardMax, rand()));
      return resolve(ev, chase ? 'arrested' : 'crashed');
    }
    if (d2 > C.carEscapeDist * C.carEscapeDist) return resolve(ev, 'escaped');
    ev.planT -= ev.step;
    const reach2 = C.fleeReach * C.fleeReach;
    if (ev.planT <= 0 || !Number.isFinite(ev.gx) || (ev.x - ev.gx) ** 2 + (ev.z - ev.gz) ** 2 < reach2) planFlee(ev);
    const e = ev.ev;
    e.gx = ev.gx;
    e.gz = ev.gz;
    if (chase) {
      e.speed = C.chaseSpeed;
      e.wobble = 0;
    } else {
      // 酒駕：車速正弦 + 小抖動、方向盤蛇行（以事件時間為相位，幀率無關）
      const s = 0.5 + 0.5 * Math.sin((ev.t / C.drunkSpeedPeriod) * TAU);
      e.speed = C.drunkSpeedMin + (C.drunkSpeedMax - C.drunkSpeedMin) * Math.min(1, Math.max(0, s + (rand() - 0.5) * 0.3));
      e.wobble = C.drunkWobble * Math.sin((ev.t / C.drunkWobblePeriod) * TAU) + (rand() - 0.5) * 0.2;
    }
    world.act(h, 'drive', e);
  }

  function stepGang(ev) {
    const o = ev.out;
    if (o.gone || (ev.t > 2 && o.fighting <= 0)) return resolve(ev, 'over');
  }

  function stepEvent(ev, world) {
    const o = world.poll(ev.h, ev.out);
    if (Number.isFinite(o.x) && Number.isFinite(o.z)) {
      ev.x = o.x;
      ev.z = o.z;
    }
    if (ev.t >= ev.timeout) return resolve(ev, 'timeout');
    const dx = ev.x - st.px;
    const dz = ev.z - st.pz;
    ev.d2 = dx * dx + dz * dz;
    if (ev.kind === 'robbery') stepRobbery(ev, world);
    else if (ev.kind === 'gang') stepGang(ev);
    else stepCar(ev, world);
  }

  function update(dt, ctx = {}) {
    dt = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), C.maxDt) : 0;
    st.ctx = ctx;
    if (ctx.world) st.world = ctx.world;
    const p = ctx.player;
    const px = p ? Number(p.x) : NaN;
    const pz = p ? Number(p.z) : NaN;
    if (!Number.isFinite(px) || !Number.isFinite(pz)) return;
    st.px = px;
    st.pz = pz;
    st.time += dt;
    const world = st.world;
    // 進行中事件
    for (let i = 0; i < slots.length; i++) {
      const ev = slots[i];
      if (!ev.kind) continue;
      ev.t += dt;
      ev.blinkT += dt;
      ev.pollAcc += dt;
      if (!ev.hinted) hint(ev);
      if (ev.pollAcc < C.pollSec || !world) continue;
      ev.step = ev.pollAcc;
      ev.pollAcc = 0;
      stepEvent(ev, world);
    }
    // 排程
    if (st.cooldown > 0) st.cooldown -= dt;
    st.checkT -= dt;
    if (st.checkT > 0) return;
    st.checkT = Math.max(0, st.checkT + C.checkSec); // 保留餘數：擲骰時刻不隨幀率漂移
    if (grace.size) for (const [a, g] of grace) if (g.until <= st.time) grace.delete(a); // 每 checkSec 清一次（非每幀）
    if (ctx.busy || st.cooldown > 0 || activeCount() >= C.maxActive) return;
    const zoneAt = typeof ctx.zoneAt === 'function' ? ctx.zoneAt : gangTerritoryAt;
    const inZone = !!zoneAt(px, pz);
    if (rand() >= spawnChance(ctx.hour, inZone, C)) return;
    if (!trySpawn(ctx, inZone)) st.checkT += C.retrySec - C.checkSec;
  }

  // ---------- 查詢 ----------
  function isEventActor(a) {
    if (!a) return false;
    const rec = actors.get(a);
    if (rec) return sameActor(a, rec);
    const g = grace.get(a);
    return sameActor(a, g) && g.until > st.time;
  }
  // 進行中的追車 / 酒駕事件車本身（handle.vehicle）
  function carEventOf(v) {
    if (!v) return null;
    for (let i = 0; i < slots.length; i++) {
      const ev = slots[i];
      if ((ev.kind === 'chase' || ev.kind === 'drunk') && ev.h && ev.h.vehicle === v) return ev;
    }
    return null;
  }
  function shotAtEvent(x, z, vehicle = null) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    const ev = carEventOf(vehicle);
    return !!ev && (ev.x - x) ** 2 + (ev.z - z) ** 2 <= C.shotRadius * C.shotRadius;
  }
  function vehicleHitByPlayer(v) {
    const ev = carEventOf(v);
    if (ev) ev.byPlayer = true;
    return !!ev;
  }
  function markers(out = []) {
    for (let i = 0; i < slots.length; i++) {
      const ev = slots[i];
      if (!ev.kind || ev.blinkT >= C.blinkSec) continue;
      if (Math.floor(ev.blinkT / C.blinkPeriod) % 2 === 1) continue;
      ev.marker.x = ev.x;
      ev.marker.z = ev.z;
      out.push(ev.marker);
    }
    return out;
  }

  // 回主選單 / 開新局：無聲收尾、排程重置
  function cancel() {
    let n = 0;
    for (let i = 0; i < slots.length; i++) {
      if (!slots[i].kind) continue;
      resolve(slots[i], 'cancel');
      n++;
    }
    actors.clear();
    grace.clear();
    st.cooldown = C.cooldownMin + rand() * (C.cooldownMax - C.cooldownMin);
    st.checkT = 0;
    return n;
  }

  // bus：玩家打倒 / 打傷事件歹徒、射中事件車 → 記為玩家出手
  const offs = [];
  const onPlayerHit = (target) => {
    const rec = target ? actors.get(target) : null;
    if (sameActor(target, rec)) rec.ev.byPlayer = true;
  };
  if (bus && typeof bus.on === 'function') {
    const sub = (name, fn) => {
      const off = bus.on(name, fn);
      if (typeof off === 'function') offs.push(off);
    };
    sub('combat:hit', (e) => e && e.byPlayer && onPlayerHit(e.target));
    sub('ped:knockdown', (e) => e && e.byPlayer && onPlayerHit(e.ped));
    sub('ped:dead', (e) => e && e.byPlayer && onPlayerHit(e.ped));
    sub('weapon:impact', (e) => e && e.byPlayer && e.vehicle && vehicleHitByPlayer(e.vehicle));
  }

  function dispose() {
    cancel();
    for (const off of offs.splice(0)) off();
  }

  return {
    update,
    cancel,
    dispose,
    isEventActor,
    shotAtEvent,
    vehicleHitByPlayer,
    markers,
    events: slots,
    config: C,
    get active() {
      return activeCount();
    },
    get cooldown() {
      return st.cooldown;
    },
    stats: () => ({ started: st.started, resolved: st.resolved, rewards: st.rewards, active: activeCount(), actors: actors.size }),
  };
}

// ---------- 世界轉接（整合層用；只依賴注入的 traffic / combat / vehicles / dmg / police / gangs，不 import three / rapier）----------
// createStreetWorld({ traffic, combat, vehicles, dmg?, findRoute?, police（wanted/adapters.js）, gangs?, repaint?(p), canSee?(ax, az, bx, bz),
//   getPlayer() → { x, z, actor, inVehicle }, bus?, rng?, isKept?(v), onKeep?(v) }) → ctx.world + update(dt, frozen) / reset() / dispose() / stats()
//   canSee 省略 = 一律視為看得到（保守：不移除離場車、也不生成事件車）
//   行人事件：徵用 SPOT_PED_RADIUS 內漫步中的骨架行人（traffic.peds：brain wander、無 override、非幫派、combat normal），以 brain.override 控制
//     搶劫 = 歹徒跑向受害者 → combat.knockdownActor(受害者, emit) → 受害者起身後原地面向歹徒喊叫（台詞泡泡 traffic.ambient.bubbles）→ 制伏後面向玩家道謝；
//       歹徒逃跑方向背離玩家，卡牆（0.5 s 沒前進）轉 90°
//     槍戰 = gangs.skirmish（成員換色 repaint(p)：骨架重新上色 + 右手掛槍），流彈：skirmish 成員的未命中子彈（weapon:fire miss）沿射線 STRAY_RANGE 內
//       第一個 STRAY_RADIUS 內的路人 / 玩家 combat.applyHit（玩家在車內 throughVehicle）
//   車輛事件：罪犯車 / 酒駕車 = vehicles.adopt + dmg.attach（v.ai = true），每幀路線跟隨 + 彎道減速 + 卡住倒車（同 vigilante createFugitiveWorld）+ 酒駕 wobble；
//     事件車 / 警車的生成點只取玩家看不到的車道點（canSee(玩家 → 點) false，同 adapters findSpawnPoint），不在眼前憑空出現；
//     追車警車 = police.spawnCar / driveCar（'pursue'，25 m 內 'ram'）/ despawnCar，控制由既有 adapters.update 負責（不經 police.js，不追玩家）
//   回收：行人 → 解除 override，> PED_RECYCLE_DIST 且離開視線（traffic._hidden）才 traffic._recyclePed；遠但看得到 → 不強制回收、交還 traffic 一般 LOD
//     （traffic 自己的回收同樣要求視野外）；PED_PENDING_MAX 後同樣交還
//     車輛 → 玩家正駕駛 / 正上車（isKept）/ 下車棄置 / 熄火殘骸交 onKeep（一般回收名單），仍在逃者繼續開走、> CAR_LEAVE_FAR 且看不到才移除（CAR_LEAVE_MAX 上限交 onKeep）；
//     收隊警車同樣只在 > CAR_LEAVE_FAR 且看不到時 despawnCar；超過 CAR_LEAVE_MAX × 2 仍看得到 → 停止巡邏、煞停（同事件車交 onKeep 拉手煞），之後一樣等看不到才移除
//   reset()：回主選單 / 開新局（createStreetEvents.cancel 之後）——已結束仍在離場的事件車 / 收隊警車立即移除、待回收行人交還 traffic（清 override）；dispose = reset + 取消訂閱
export const SPOT_PED_RADIUS = 30; // m，徵用行人的搜尋半徑
export const STUCK_SEC = 4; // s，事件車油門 > 0.3 而車速 < STUCK_SPEED 持續此時間 → 倒車
export const REVERSE_SEC = 1.5; // s
export const ROB_PAIR_MIN = 4; // m，歹徒與受害者距離帶
export const ROB_PAIR_MAX = 22;
export const ROB_REACH = 1.3; // m
export const ROB_IMPULSE = 70; // 推倒衝量
export const ROB_LINES = ['搶劫啊！', '救命！包包被搶了！', '抓住他！'];
export const THANK_LINE = '謝謝你！';
export const SHOUT_SEC = 2.5;
export const THANK_SEC = 4;
export const GANG_MIN = 4; // 槍戰最少人數（兩邊各 ≥ 2）
export const GANG_MAX = 6;
export const STRAY_RANGE = 40; // m
export const STRAY_RADIUS = 0.45; // m
export const STRAY_DAMAGE = 10;
export const PED_RECYCLE_DIST = 110; // m
export const PED_PENDING_MAX = 90; // s，回收等待上限（之後交還 traffic 一般管理）
export const CAR_SNAP = 30; // m，車輛事件吸附到車道點的搜尋半徑
export const CAR_GAP = 10; // m，生成點與既有車輛最小距離
export const POLICE_BEHIND_MIN = 15; // m，警車生成在罪犯車後方此距離帶
export const POLICE_BEHIND_MAX = 45;
export const POLICE_SPEED = 26; // m/s
export const POLICE_RAM_DIST = 25; // m
export const CAR_LEAVE_FAR = 150; // m，離開中的車超過此距離且看不到 → 移除
export const CAR_LEAVE_MAX = 45; // s，離開時間上限（之後交一般回收名單）
export const EVENT_CAR_TYPES = ['sedan', 'sedan', 'taxi', 'suv'];
export const EVENT_CAR_COLORS = ['#f2f2f2', '#1f1f22', '#8a8f94', '#b01e28', '#2d5fb0', '#d9d2c0'];
const ROUTE_REACH = 8;
const REROUTE_SEC = 3;
const REROUTE_MOVE = 20;
const STEER_GAIN = 1.8;
const THROTTLE_GAIN = 0.35;
const CORNER_ANGLE = Math.PI / 2;
const CORNER_MIN = 0.3;
const STUCK_SPEED = 1;
const MAX_DT = 0.1;

const wrapAngle = (a) => {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function createStreetWorld(deps = {}) {
  const {
    traffic = null,
    combat = null,
    vehicles = null,
    dmg = null,
    findRoute = null,
    police = null,
    gangs = null,
    repaint = null,
    canSee = () => true,
    getPlayer = () => null,
    bus = null,
    rng = Math.random,
    isKept = () => false,
    onKeep = () => {},
  } = deps;
  const rnd = () => Math.min(Math.max(Number(rng()) || 0, 0), 0.999999);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const cars = new Set(); // 受控事件車（罪犯 / 酒駕）
  const leaving = new Set(); // 結束後離開中的事件車 { rec, t }
  const leavingPolice = new Set(); // { car, t }
  const pendingPeds = []; // 待回收行人 ref
  const strayShooters = new Map(); // 槍戰成員 actor → 登記時的 actor.id（骨架回池換人後不再算槍手）
  const spotBuf = [];
  const pedBuf = [];
  const tmpDir = { x: 0, z: 0 };
  const pursueCmd = { x: 0, z: 0, mode: 'pursue', maxSpeed: POLICE_SPEED }; // driveCar 只抄值（adapters），重用不配置
  const patrolCmd = { x: 0, z: 0, mode: 'patrol', maxSpeed: 12 };
  const stopCmd = { x: 0, z: 0, mode: 'stop', maxSpeed: 0 };
  const ctl = { throttle: 0, steer: 0, brake: 0, handbrake: false }; // setControls 只抄值（VehicleBody），重用不配置
  const setCtl = (v, throttle, steer, brake, handbrake) => {
    ctl.throttle = throttle;
    ctl.steer = steer;
    ctl.brake = brake;
    ctl.handbrake = handbrake;
    v.setControls(ctl);
  };
  let time = 0;
  let pendAcc = 0;
  const stats = { spawned: 0, released: 0, recycledPeds: 0, removedCars: 0, strayHits: 0 };

  const exists = (v) => !!vehicles && vehicles.vehicles.includes(v);
  const bubbles = () => (traffic && traffic.ambient && traffic.ambient.bubbles) || null;

  // ---------- 行人 ----------
  const refOf = (p) => ({ p, c: p.citizen, id: p.actor.id });
  const valid = (r) => !!r && !!r.p && r.p.alive && r.p.citizen === r.c && !!r.p.actor && r.p.actor.id === r.id;
  function idle(p) {
    if (!p || !p.alive || !p.actor || !p.brain || !p.citizen) return false;
    if (p.state !== 'walk' || p.pendingFrom || p.brain.override || p.citizen.gang || p.brain.state !== 'wander') return false;
    return !combat || combat.stateOf(p.actor) === 'normal';
  }
  function idlePeds(x, z, r, out) {
    out.length = 0;
    if (!traffic || !traffic.peds) return out;
    const r2 = r * r;
    for (const p of traffic.peds) if (idle(p) && (p.x - x) ** 2 + (p.z - z) ** 2 <= r2) out.push(p);
    return out;
  }
  // 交還 traffic：還掛著本事件的 override（道謝中的受害者）就清掉
  function unhook(r) {
    if (valid(r) && r.drive && r.p.brain && r.p.brain.override === r.drive) r.p.brain.override = null;
  }
  function releasePed(r) {
    if (!valid(r)) return;
    const p = r.p;
    if (p.brain && r.drive && p.brain.override === r.drive) p.brain.override = null;
    const b = bubbles();
    if (b && b.release) b.release(p);
    pendingPeds.push(r);
  }
  function recyclePeds(dt) {
    pendAcc += dt;
    if (pendAcc < 0.5) return;
    const step = pendAcc;
    pendAcc = 0;
    const pl = getPlayer();
    for (let i = pendingPeds.length - 1; i >= 0; i--) {
      const r = pendingPeds[i];
      r.wait = (r.wait || 0) + step;
      let done = !valid(r) || r.wait > PED_PENDING_MAX;
      if (!done) {
        const p = r.p;
        const far = !!pl && (p.x - pl.x) ** 2 + (p.z - pl.z) ** 2 > PED_RECYCLE_DIST * PED_RECYCLE_DIST;
        if (far) {
          // 遠且看不到才回收（不在玩家眼前消失）；遠但看得到 → 交還 traffic 一般 LOD（其回收同樣要求視野外）
          const hidden = traffic && typeof traffic._hidden === 'function' ? traffic._hidden(p.x, p.z) : false;
          if (hidden && traffic && typeof traffic._recyclePed === 'function') {
            traffic._recyclePed(p.citizen);
            stats.recycledPeds++;
          } else unhook(r);
          done = true;
        }
      } else unhook(r);
      if (done) {
        pendingPeds[i] = pendingPeds[pendingPeds.length - 1];
        pendingPeds.pop();
      }
    }
  }

  function spawnRobbery(x, z) {
    const list = idlePeds(x, z, SPOT_PED_RADIUS, pedBuf);
    if (list.length < 2) return null;
    let robber = null;
    let victim = null;
    let best = Infinity;
    for (const v of list) {
      const d = (v.x - x) ** 2 + (v.z - z) ** 2;
      if (d >= best) continue;
      for (const r of list) {
        if (r === v) continue;
        const dd = Math.hypot(r.x - v.x, r.z - v.z);
        if (dd < ROB_PAIR_MIN || dd > ROB_PAIR_MAX) continue;
        best = d;
        victim = v;
        robber = r;
        break;
      }
    }
    if (!victim) return null;
    const h = { kind: 'robbery', x: victim.x, z: victim.z, robber: refOf(robber), victim: refOf(victim), actors: [robber.actor], mode: 'approach', fleeX: 0, fleeZ: 1, lastX: robber.x, lastZ: robber.z, stuckT: 0, fleeInit: false, shoutT: 0, thankT: 0, faceX: 0, faceZ: 0 };
    const rb = h.robber;
    rb.drive = (brain, dt, ctx, it) => {
      if (!valid(rb)) return false;
      const a = rb.p.actor;
      let dx;
      let dz;
      if (h.mode === 'approach') {
        if (!valid(h.victim)) return false;
        dx = h.victim.p.x - a.pos.x;
        dz = h.victim.p.z - a.pos.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < 1e-6) return true;
        dx /= d;
        dz /= d;
        it.run = d > 2;
      } else if (h.mode === 'flee') {
        dx = h.fleeX;
        dz = h.fleeZ;
        it.run = true;
      } else return false;
      it.moveX = dx;
      it.moveZ = dz;
      it.faceYaw = null;
      return true;
    };
    robber.brain.override = rb.drive;
    stats.spawned++;
    return h;
  }

  function victimDrive(h) {
    const vr = h.victim;
    vr.drive = (brain, dt, ctx, it) => {
      if (!valid(vr)) return false;
      const p = vr.p;
      const b = bubbles();
      let tx;
      let tz;
      if (h.mode === 'thank') {
        const pl = getPlayer();
        h.thankT -= dt;
        if (!pl || h.thankT <= 0) return false;
        tx = pl.x;
        tz = pl.z;
      } else {
        if (!valid(h.robber)) return false;
        tx = h.robber.p.x;
        tz = h.robber.p.z;
        h.shoutT -= dt;
        if (h.shoutT <= 0) {
          h.shoutT = SHOUT_SEC;
          if (b && b.show) b.show(pick(ROB_LINES), p);
          if (p.anim && p.anim.playGesture) p.anim.playGesture('angry_shout');
        }
      }
      it.moveX = 0;
      it.moveZ = 0;
      it.run = false;
      it.faceYaw = Math.atan2(tx - p.x, tz - p.z);
      return true;
    };
  }

  function spawnGang(x, z, ev) {
    if (!gangs || typeof gangs.skirmish !== 'function') return null;
    const list = idlePeds(x, z, SPOT_PED_RADIUS, pedBuf);
    if (list.length < GANG_MIN) return null;
    // 近者優先；兩邊以「相對於事發點的方位」分邊（同側成群）
    list.sort((p, q) => (p.x - x) ** 2 + (p.z - z) ** 2 - ((q.x - x) ** 2 + (q.z - z) ** 2));
    const n = Math.min(GANG_MAX, list.length);
    const picked = list.slice(0, n);
    let ax = 0;
    let az = 0;
    for (const p of picked) {
      ax += p.x - x;
      az += p.z - z;
    }
    const L = Math.hypot(ax, az);
    const sx = L > 1e-6 ? -az / L : 1;
    const sz = L > 1e-6 ? ax / L : 0;
    picked.sort((p, q) => (p.x - x) * sx + (p.z - z) * sz - ((q.x - x) * sx + (q.z - z) * sz));
    const half = Math.floor(n / 2);
    const sideA = picked.slice(0, half);
    const sideB = picked.slice(half);
    const refs = picked.map(refOf);
    const actorsList = gangs.skirmish(sideA, sideB, { a: ev.a, b: ev.b, sec: ev.sec, weapon: 'pistol' });
    if (!actorsList.length) return null;
    for (const p of picked) if (p.citizen && p.citizen.gang && typeof repaint === 'function') repaint(p);
    const h = { kind: 'gang', x, z, peds: refs, actors: actorsList };
    for (const a of actorsList) strayShooters.set(a, a.id);
    stats.spawned++;
    return h;
  }

  const isShooter = (a) => strayShooters.has(a) && strayShooters.get(a) === a.id;
  // 流彈：槍戰成員未命中的子彈沿射線打到路人 / 玩家
  function onFire(e) {
    if (!e || !e.miss || !e.shooter || !combat || !isShooter(e.shooter)) return;
    const dl = Math.hypot(e.dirX || 0, e.dirZ || 0);
    if (dl < 1e-6) return;
    const dx = e.dirX / dl;
    const dz = e.dirZ / dl;
    let best = null;
    let bestT = Infinity;
    const pl = getPlayer();
    if (pl && pl.actor) {
      const t = strayHit(e.x, e.z, dx, dz, STRAY_RANGE, pl.x, pl.z, STRAY_RADIUS * (pl.inVehicle ? 2.5 : 1));
      if (t >= 0) {
        best = pl.actor;
        bestT = t;
      }
    }
    if (traffic && traffic.peds) {
      for (const p of traffic.peds) {
        const a = p.actor;
        if (!p.alive || !a || a === e.shooter || isShooter(a)) continue;
        const t = strayHit(e.x, e.z, dx, dz, STRAY_RANGE, p.x, p.z, STRAY_RADIUS);
        if (t >= 0 && t < bestT) {
          best = a;
          bestT = t;
        }
      }
    }
    if (!best) return;
    tmpDir.x = dx;
    tmpDir.z = dz;
    const inCar = !!(pl && best === pl.actor && pl.inVehicle);
    const r = combat.applyHit({ attacker: e.shooter, target: best, damage: STRAY_DAMAGE, weapon: 'pistol', dir: tmpDir, swingId: typeof combat.newSwingId === 'function' ? combat.newSwingId() : null, throughVehicle: inCar });
    if (r) stats.strayHits++;
  }
  const offFire = bus && typeof bus.on === 'function' ? bus.on('weapon:fire', onFire) : null;

  // ---------- 車輛 ----------
  function nearVehicle(x, z) {
    const g2 = CAR_GAP * CAR_GAP;
    if (vehicles) for (const v of vehicles.vehicles) if ((v.pos.x - x) ** 2 + (v.pos.z - z) ** 2 < g2) return true;
    if (traffic && traffic.cars) {
      for (const c of traffic.cars) {
        const p = c.v ? c.v.pos : c.pos;
        if (p && (p.x - x) ** 2 + (p.z - z) ** 2 < g2) return true;
      }
    }
    return false;
  }
  // 車道點：離 (x, z) 最近、不貼既有車輛、玩家看不到（canSee(玩家 → 點) false，同 adapters findSpawnPoint）——事件車 / 警車不在眼前憑空出現
  function carSpot(x, z, rMin, rMax) {
    if (!traffic || typeof traffic.spawnSpots !== 'function') return null;
    const spots = traffic.spawnSpots(x, z, rMin, rMax, spotBuf);
    const pl = getPlayer();
    let best = null;
    let bestD = Infinity;
    for (const sp of spots) {
      const d = (sp.x - x) ** 2 + (sp.z - z) ** 2;
      if (d < bestD && !nearVehicle(sp.x, sp.z) && !(pl && canSee(pl.x, pl.z, sp.x, sp.z))) {
        best = sp;
        bestD = d;
      }
    }
    return best;
  }
  function adoptCar(sp, kind) {
    if (!vehicles || !sp) return null;
    const type = pick(EVENT_CAR_TYPES);
    const v = vehicles.adopt({ type, color: type === 'taxi' ? '#f5c518' : pick(EVENT_CAR_COLORS), x: sp.x, z: sp.z, yaw: sp.heading ?? 0 });
    if (!v) return null;
    v.ai = true;
    v.streetEvent = kind;
    if (dmg && typeof dmg.attach === 'function') dmg.attach(v);
    const rec = { v, kind, cmd: { x: sp.x, z: sp.z, maxSpeed: 0, wobble: 0, set: false }, route: null, routeIdx: 0, routeAt: -Infinity, routeGoal: { x: NaN, z: NaN }, stuckT: 0, reverseT: 0, reverseSteer: 1, ejected: false };
    cars.add(rec);
    return rec;
  }
  function spawnCarEvent(kind, x, z) {
    const sp = carSpot(x, z, 0, CAR_SNAP);
    const rec = adoptCar(sp, kind);
    if (!rec) return null;
    const h = { kind, x: sp.x, z: sp.z, car: rec, vehicle: rec.v, police: [], actors: [] };
    if (kind === 'chase' && police && typeof police.spawnCar === 'function') {
      const n = rnd() < 0.5 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const ps = carSpot(sp.x, sp.z, POLICE_BEHIND_MIN, POLICE_BEHIND_MAX);
        const pc = ps ? police.spawnCar({ x: ps.x, z: ps.z, heading: ps.heading ?? 0 }) : null;
        if (pc) h.police.push(pc);
      }
      if (!h.police.length) {
        removeCar(rec);
        return null;
      }
    }
    stats.spawned++;
    return h;
  }
  function removeCar(rec) {
    cars.delete(rec);
    const v = rec.v;
    v.ai = false;
    v.streetEvent = null;
    if (!exists(v)) return;
    if (dmg && typeof dmg.detach === 'function') dmg.detach(v);
    vehicles.remove(v);
    stats.removedCars++;
  }
  // 交一般回收名單（玩家的車 / 棄置 / 殘骸）
  function keepCar(rec) {
    cars.delete(rec);
    const v = rec.v;
    v.ai = false;
    v.streetEvent = null;
    if (!exists(v)) return;
    if (!v.driven && typeof v.setControls === 'function') setCtl(v, 0, 0, 1, true);
    onKeep(v);
  }
  const healthOf = (v) => (dmg && typeof dmg.healthOf === 'function' ? dmg.healthOf(v) : null);

  function steerTarget(rec) {
    const c = rec.cmd;
    const p = rec.v.pos;
    if (typeof findRoute !== 'function') return c;
    if (!rec.route || time - rec.routeAt >= REROUTE_SEC || Math.hypot(c.x - rec.routeGoal.x, c.z - rec.routeGoal.z) > REROUTE_MOVE) {
      const r = findRoute({ x: p.x, z: p.z }, { x: c.x, z: c.z });
      rec.route = r && r.points && r.points.length >= 2 ? r.points : null;
      rec.routeIdx = 1;
      rec.routeAt = time;
      rec.routeGoal.x = c.x;
      rec.routeGoal.z = c.z;
    }
    const pts = rec.route;
    if (!pts) return c;
    const last = pts.length >= 3 ? pts.length - 2 : pts.length - 1;
    while (rec.routeIdx < last && Math.hypot(p.x - pts[rec.routeIdx].x, p.z - pts[rec.routeIdx].z) < ROUTE_REACH) rec.routeIdx++;
    rec.routeIdx = Math.min(rec.routeIdx, last);
    return pts[rec.routeIdx];
  }
  function control(rec, dt) {
    const v = rec.v;
    const c = rec.cmd;
    if (v.body && v.body.kinematic && typeof v.body.setKinematic === 'function') v.body.setKinematic(false);
    const rb = v.body && v.body.body;
    if (rb && v.body.active !== false && typeof rb.isEnabled === 'function' && !rb.isEnabled()) rb.setEnabled(true);
    const speed = v.speed || 0;
    if (!c.set) {
      setCtl(v, 0, 0, 1, Math.abs(speed) < STUCK_SPEED);
      return;
    }
    const t = steerTarget(rec);
    const p = v.pos;
    const err = wrapAngle(Math.atan2(t.x - p.x, t.z - p.z) - (v.yaw || 0));
    if (rec.reverseT > 0) {
      rec.reverseT -= dt;
      setCtl(v, -1, rec.reverseSteer, 0, false);
      return;
    }
    const corner = clamp(1 - (Math.abs(err) / CORNER_ANGLE) * (1 - CORNER_MIN), CORNER_MIN, 1);
    const throttle = clamp((c.maxSpeed * corner - speed) * THROTTLE_GAIN, -1, 1);
    const steer = clamp(err * STEER_GAIN + c.wobble, -1, 1);
    if (throttle > 0.3 && Math.abs(speed) < STUCK_SPEED) rec.stuckT += dt;
    else rec.stuckT = 0;
    if (rec.stuckT >= STUCK_SEC) {
      rec.stuckT = 0;
      rec.reverseT = REVERSE_SEC;
      rec.reverseSteer = err >= 0 ? -1 : 1;
      setCtl(v, -1, rec.reverseSteer, 0, false);
      return;
    }
    setCtl(v, throttle, steer, 0, false);
  }
  function eject(rec) {
    if (!rec || rec.ejected) return null;
    rec.ejected = true;
    const v = rec.v;
    v.ai = false;
    if (!exists(v)) return null;
    if (!v.driven && typeof v.setControls === 'function') setCtl(v, 0, 0, 1, true);
    if (v.driven || !traffic || typeof traffic.spawnEjectedDriver !== 'function') return null;
    const spec = v.spec || {};
    const d = doorPoint(v.pos.x, v.pos.z, v.yaw || 0, { length: spec.length || 4.5, width: spec.width || 1.85 }, spec.doorSide ?? 1);
    const pl = getPlayer();
    const p = traffic.spawnEjectedDriver({ x: d.x + d.outX * EJECT_OFFSET, z: d.z + d.outZ * EJECT_OFFSET, yaw: Math.atan2(d.outX, d.outZ), attacker: pl ? pl.actor : null });
    return p && p.actor ? p.actor : null;
  }

  // ---------- ctx.world 介面 ----------
  function spawn(kind, x, z, ev) {
    if (kind === 'robbery') return spawnRobbery(x, z);
    if (kind === 'gang') return spawnGang(x, z, ev);
    if (kind === 'chase' || kind === 'drunk') return spawnCarEvent(kind, x, z);
    return null;
  }

  function poll(h, out) {
    out.gone = false;
    out.reach = false;
    out.down = false;
    out.driven = false;
    if (h.kind === 'robbery') {
      const r = h.robber;
      if (!valid(r)) {
        out.gone = true;
        return out;
      }
      out.x = r.p.x;
      out.z = r.p.z;
      out.down = !!combat && (combat.isDown(r.p.actor) || combat.stateOf(r.p.actor) === 'dead');
      if (h.mode === 'approach' && valid(h.victim)) out.reach = Math.hypot(h.victim.p.x - r.p.x, h.victim.p.z - r.p.z) <= ROB_REACH;
      return out;
    }
    if (h.kind === 'gang') {
      out.fighting = gangs && typeof gangs.warring === 'function' ? gangs.warring(h.actors) : 0;
      return out;
    }
    const v = h.car.v;
    if (!exists(v)) {
      out.gone = true;
      return out;
    }
    out.x = v.pos.x;
    out.z = v.pos.z;
    out.speed = v.speed || 0;
    out.health = healthOf(v);
    out.driven = !!v.driven || isKept(v);
    return out;
  }

  function act(h, verb, ev) {
    if (h.kind === 'robbery') {
      const r = h.robber;
      if (verb === 'approach') {
        h.mode = 'approach';
      } else if (verb === 'grab') {
        const vr = h.victim;
        if (valid(vr) && valid(r) && combat) {
          const dx = vr.p.x - r.p.x;
          const dz = vr.p.z - r.p.z;
          const d = Math.hypot(dx, dz) || 1;
          combat.knockdownActor(vr.p.actor, { cause: 'punch', impulse: { x: (dx / d) * ROB_IMPULSE, y: ROB_IMPULSE * 0.2, z: (dz / d) * ROB_IMPULSE }, attacker: r.p.actor, emit: true });
          victimDrive(h);
          vr.p.brain.override = vr.drive;
          h.shoutT = 0;
        }
        h.mode = 'flee';
        h.stuckT = time; // 卡牆判定的上次取樣時間（world 時鐘）
        h.lastX = valid(r) ? r.p.x : 0;
        h.lastZ = valid(r) ? r.p.z : 0;
      } else if (verb === 'flee') {
        if (!valid(r)) return null;
        // 背離玩家（ev.fromX / fromZ）；0.5 s 沒前進 0.3 m → 轉 90° 繞開牆
        if (time - h.stuckT >= 0.5) {
          const moved = Math.hypot(r.p.x - h.lastX, r.p.z - h.lastZ);
          h.stuckT = time;
          h.lastX = r.p.x;
          h.lastZ = r.p.z;
          if (moved < 0.3) {
            const s = rnd() < 0.5 ? 1 : -1;
            const fx = h.fleeX;
            h.fleeX = -h.fleeZ * s;
            h.fleeZ = fx * s;
            return null;
          }
        }
        if (h.fleeInit) return null;
        const dx = r.p.x - ev.fromX;
        const dz = r.p.z - ev.fromZ;
        const d = Math.hypot(dx, dz);
        h.fleeX = d > 1e-6 ? dx / d : 0;
        h.fleeZ = d > 1e-6 ? dz / d : 1;
        h.fleeInit = true;
      } else if (verb === 'subdued') {
        h.mode = 'thank';
        h.thankT = THANK_SEC;
        if (valid(r) && r.p.brain && r.p.brain.override === r.drive) r.p.brain.override = null;
        const vr = h.victim;
        if (valid(vr)) {
          if (!vr.drive) victimDrive(h);
          vr.p.brain.override = vr.drive;
          const b = bubbles();
          if (b && b.show) b.show(THANK_LINE, vr.p);
          if (vr.p.anim && vr.p.anim.playGesture) vr.p.anim.playGesture('wave');
        }
      }
      return null;
    }
    if (h.kind === 'chase' || h.kind === 'drunk') {
      const rec = h.car;
      if (verb === 'eject') return eject(rec);
      if (verb !== 'drive' || rec.ejected) return null;
      const c = rec.cmd;
      c.x = ev.gx;
      c.z = ev.gz;
      c.maxSpeed = ev.speed;
      c.wobble = ev.wobble || 0;
      c.set = true;
      if (police && typeof police.driveCar === 'function') {
        const v = rec.v;
        for (const pc of h.police) {
          const p = pc.v ? pc.v.pos : pc.pos;
          const d = p ? Math.hypot(p.x - v.pos.x, p.z - v.pos.z) : Infinity;
          pursueCmd.x = v.pos.x;
          pursueCmd.z = v.pos.z;
          pursueCmd.mode = d <= POLICE_RAM_DIST ? 'ram' : 'pursue';
          police.driveCar(pc, pursueCmd);
        }
      }
    }
    return null;
  }

  function release(h, outcome) {
    stats.released++;
    if (h.kind === 'robbery') {
      if (h.mode !== 'thank') h.mode = 'done';
      releasePed(h.robber);
      // 道謝中的受害者：override 自己在 THANK_SEC 後交還，回收排在後面
      if (h.mode === 'thank' && valid(h.victim)) pendingPeds.push(h.victim);
      else releasePed(h.victim);
      return;
    }
    if (h.kind === 'gang') {
      for (const a of h.actors) strayShooters.delete(a);
      for (const r of h.peds) releasePed(r);
      return;
    }
    const rec = h.car;
    const v = rec.v;
    const wrecked = Number.isFinite(healthOf(v)) && healthOf(v) <= 0;
    if (!exists(v)) cars.delete(rec);
    else if (outcome === 'cancel') {
      if (v.driven || isKept(v)) keepCar(rec);
      else removeCar(rec);
    } else if (rec.ejected || wrecked || v.driven || isKept(v)) keepCar(rec);
    else {
      // 仍在開：繼續往遠處開，離開視線後移除
      leaving.add({ rec, t: 0 });
    }
    for (const pc of h.police) {
      if (outcome === 'cancel') police.despawnCar(pc);
      else leavingPolice.add({ car: pc, t: 0, parked: false, poll: Infinity }); // poll：距上次下巡邏指令秒數（Infinity = 下一幀立即下）
    }
    h.police.length = 0;
  }

  function update(dt, frozen = false) {
    dt = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), MAX_DT) : 0;
    time += dt;
    for (const rec of cars) {
      const v = rec.v;
      if (rec.ejected || v.driven || !exists(v)) continue;
      if (frozen) {
        rec.stuckT = 0;
        rec.reverseT = 0;
        setCtl(v, 0, 0, 1, Math.abs(v.speed || 0) < STUCK_SPEED);
      } else if (dt > 0) control(rec, dt);
    }
    if (frozen) return;
    const pl = getPlayer();
    if (leaving.size) {
      for (const l of leaving) {
        const v = l.rec.v;
        l.t += dt;
        if (!exists(v)) {
          leaving.delete(l);
          cars.delete(l.rec);
          continue;
        }
        if (v.driven || isKept(v) || l.t > CAR_LEAVE_MAX) {
          leaving.delete(l);
          keepCar(l.rec);
          continue;
        }
        const d = pl ? Math.hypot(v.pos.x - pl.x, v.pos.z - pl.z) : Infinity;
        if (d > CAR_LEAVE_FAR && (!pl || !canSee(pl.x, pl.z, v.pos.x, v.pos.z))) {
          leaving.delete(l);
          removeCar(l.rec);
        }
      }
    }
    if (leavingPolice.size && police) {
      for (const l of leavingPolice) {
        const car = l.car;
        l.t += dt;
        const p = car.v ? car.v.pos : car.pos;
        if (!p || car.removed || car.stolen) {
          leavingPolice.delete(l);
          if (!car.removed && !car.stolen) police.despawnCar(car);
          continue;
        }
        const d = pl ? Math.hypot(p.x - pl.x, p.z - pl.z) : Infinity;
        // 同事件車：> CAR_LEAVE_FAR 且看不到才移除（不在玩家眼前消失）
        if (d > CAR_LEAVE_FAR && (!pl || !canSee(pl.x, pl.z, p.x, p.z))) {
          leavingPolice.delete(l);
          police.despawnCar(car);
          continue;
        }
        if (typeof police.driveCar !== 'function') continue;
        if (l.t > CAR_LEAVE_MAX * 2) {
          // 超時仍看得到：停止巡邏、煞停一次（同事件車交 onKeep 拉手煞），之後照樣等離開視線才移除
          if (!l.parked) {
            l.parked = true;
            stopCmd.x = p.x;
            stopCmd.z = p.z;
            police.driveCar(car, stopCmd);
          }
          continue;
        }
        l.poll += dt;
        if (pl && l.poll >= 0.5) {
          // 收隊：往背離玩家的遠處巡邏開走（每 0.5 s 更新一次目標；adapters 依最後指令持續駕駛）
          l.poll = 0;
          const dx = p.x - pl.x;
          const dz = p.z - pl.z;
          const L = Math.hypot(dx, dz) || 1;
          patrolCmd.x = p.x + (dx / L) * 300;
          patrolCmd.z = p.z + (dz / L) * 300;
          police.driveCar(car, patrolCmd);
        }
      }
    }
    if (pendingPeds.length) recyclePeds(dt);
  }

  // 回主選單 / 開新局（createStreetEvents.cancel 之後）：已結束仍在離場的事件車 / 收隊警車立即收掉（玩家正開 / 正上車的交 onKeep）、
  // 待回收行人清 override 交還 traffic——零殘留（否則離場車沿最後一次油門 / 方向盤在巡覽畫面衝）
  function reset() {
    for (const rec of [...cars]) {
      const v = rec.v;
      if (exists(v) && (v.driven || isKept(v))) keepCar(rec);
      else removeCar(rec);
    }
    leaving.clear();
    if (police) for (const l of leavingPolice) police.despawnCar(l.car);
    leavingPolice.clear();
    for (const r of pendingPeds) unhook(r);
    pendingPeds.length = 0;
    strayShooters.clear();
    pendAcc = 0;
  }
  function dispose() {
    reset();
    if (typeof offFire === 'function') offFire();
  }

  return {
    spawn,
    poll,
    act,
    release,
    update,
    reset,
    dispose,
    cars,
    isEventVehicle: (v) => !!v && !!v.streetEvent,
    stats: () => ({ ...stats, cars: cars.size, leaving: leaving.size, leavingPolice: leavingPolice.size, pendingPeds: pendingPeds.length }),
  };
}
