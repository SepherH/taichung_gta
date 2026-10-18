// 街頭競速（Phase 12，§34 Street Race）：七期地標串成的 3 條賽道，玩家駕車進起點光柱按互動鍵 → 3–2–1 倒數 → 與 2–3 台 NPC 對手車競速。
// 純邏輯模組，不碰 three / rapier；DOM 只在 createRaceHud（整合層給 root）。
// createRaces({ bus, rng, config }) → { update(dt, ctx), start(raceId, ctx?), cancel(), end(reason), canStart, nearestStart, markers, beacons,
//   serialize, restore, bestOf, active, phase, locked, dispose, … }
//   bus：emit race:start / race:checkpoint / race:finish / race:abort、toast（ctx.toast 省略時）；訂閱 player:busted / player:wasted（保底退賽）
//   rng：0..1（對手車速度個體差 ±RIVAL_JITTER）；config 可覆寫下列常數（小寫駝峰同名）
// 呼叫端（main.js）每幀建 ctx = { player: { x, z }, inCar, wrecked, world, earn(n), toast?(text, sec) }：
//   inCar = 正駕駛任一車輛；wrecked = 開賽用車（或比賽中換開的車）耐久歸零；earn(n) = economy.add(n, 'race')
//   world（對手車世界介面，見 createRivalWorld；測試以替身注入）：
//     spawn(pt, { index, raceId }) → handle | null（pt = { x, z, heading }；位置被佔 / 在建築內回 null）
//     state(h) → { x, z, speed, health, exists, driven }；drive(h, { x, z, maxSpeed })；hold(h)（煞停鎖定）；remove(h)
// 開賽：start(raceId, { inCar, player, stars, busy, speed, stalled, overturned }) —— 駕車、在起點 START_RADIUS 內、無其他任務、0 星（有星數 toast TOAST_WANTED 不開賽）、
//   車速 < START_MAX_SPEED（否則 toast TOAST_MOVING）、未熄火 / 未翻車（toast TOAST_STALLED / TOAST_OVERTURNED）
//   → 倒數 COUNTDOWN_SEC（玩家車由整合層依 locked 煞停、對手車 world.hold）；倒數期間在起點後方並排格位（gridSlots）生成對手車
// 比賽：檢查點依序判定（本幀與上幀位置連線離檢查點 ≤ CP_RADIUS 即通過，幀率無關）；漏點不算（只認下一點）
//   對手車沿 world.drive → findRoute 路網開往自己的下一個檢查點，目標速度 = 難度基準 × 個體差 × 橡皮筋（落後快、領先慢，≤ ±RUBBER_MAX）
//   名次：已完賽者依完賽時間（完賽後車況不影響）；未完賽者先比已過檢查點數、同檢查點比離下一點距離；未完賽就車消失 / 毀損 / 被搶的對手車視為退出（排最後、煞停）
// 完賽（玩家過最後一點）：toast 名次與時間、獎金 REWARDS[名次 − 1]（ctx.earn）、刷新最佳成績（serialize → 存檔 races.best）、emit race:finish
// 退賽：left（下車 > LEFT_SEC）/ wrecked / busted / wasted（end(kind)）/ cancel（回主選單、開新局：不 toast）→ emit race:abort；對手車回收、標記清空
// 時間一律吃呼叫端傳入的 dt（秒，clamp ≤ MAX_DT）：≥ 10 fps 時結果與幀率無關（誤差 ≤ 1 幀）

export const START_RADIUS = 8; // m，起點光柱觸發半徑（駕車進入此範圍才可按互動鍵開賽）
export const CP_RADIUS = 12; // m，檢查點通過半徑
export const COUNTDOWN_SEC = 3; // s，3–2–1
export const GO_SEC = 1; // s，倒數後「GO!」顯示時間
export const LEFT_SEC = 10; // s，下車超過此值 → 退賽
export const RUBBER_MAX = 0.1; // 橡皮筋幅度上限（±10%）
export const RUBBER_GAP = 150; // m，與玩家進度差達此距離時橡皮筋飽和
export const RIVAL_JITTER = 0.04; // 對手車個體速度差（±，與橡皮筋相乘後仍 ≤ 難度基準 × 1.15）
export const DIFFICULTY_SPEED = Object.freeze({ 1: 19, 2: 22, 3: 25 }); // m/s，對手車直線目標速度（轎車極速 42）
export const REWARDS = Object.freeze([1000, 400, 150]); // NT$，第 1–3 名
export const LANE_GAP = 3.5; // m，並排格位橫向間距
export const ROW_GAP = 8; // m，格位前後排距
// 並排格位（相對起點、賽道起跑方向）：[橫向（右 +）, 前後（前 +）]；被佔用的格位跳過、往後排遞補
export const GRID_SLOTS = Object.freeze([[-LANE_GAP, 0], [LANE_GAP, 0], [0, -ROW_GAP], [-LANE_GAP, -ROW_GAP], [LANE_GAP, -ROW_GAP], [0, -2 * ROW_GAP]]);
export const MAX_DT = 0.1; // s，單幀 dt 上限
export const START_MAX_SPEED = 3; // m/s，開賽時車速上限（高速穿過起點光柱不得搶跑）

export const MARKER_START = 'race-start'; // 小地圖旗幟（hud.js FLAG_KINDS）
export const MARKER_CP = 'race-cp'; // 下一個檢查點（小地圖超出半徑時貼邊）
export const END_REASONS = Object.freeze(['left', 'wrecked', 'busted', 'wasted', 'cancel']);
export const TOAST_WANTED = '被通緝中不能開賽，先甩掉警察吧！';
export const TOAST_BUSY = '正在進行其他任務，不能開賽';
export const TOAST_MOVING = '先停車再開賽';
export const TOAST_STALLED = '車子熄火了，不能開賽';
export const TOAST_OVERTURNED = '車子翻覆了，不能開賽';
export const ABORT_TEXT = Object.freeze({ left: '離開車輛太久', wrecked: '車輛毀損', busted: '被捕', wasted: '送醫' });
export const promptText = (race) => `按 E 開始街頭競速：${race.name}`;
export const toastAbort = (reason) => `退賽：${ABORT_TEXT[reason] || reason}`;
export const rewardFor = (rank, table = REWARDS) => (rank >= 1 && rank <= table.length ? table[rank - 1] : 0);

// 賽道：起點 / 檢查點 = 七期地標旁的車道點（src/data/osm-city.json R 層折線頂點 = navigation.js buildRoadGraph 節點，最大連通塊、非橋梁）
//   地標取 OSM B 層具名建築 / L 層公園（id 見 src 欄）；起點取該地標旁 ≥ 12 m 寬車道的直線段（heading = 起跑方向，atan2(dx, dz)）
//   tools/test/p12-race.mjs 逐點驗證：落在車道寬度內、在最大連通塊、相鄰點路網可達、離所屬地標 ≤ 130 m
export const RACES = Object.freeze([
  {
    id: 'qiqi-classic',
    name: '七期經典賽',
    difficulty: 1,
    rivals: 2,
    start: { name: '老虎城', x: 86.0, z: 16.8, heading: 2.61, src: 'B 150999799 老虎城購物中心｜R 617310344 河南路三段' },
    checkpoints: [
      { name: '新光三越', x: 585.4, z: -154.4, src: 'B 148849083｜R 364269699 臺灣大道三段 × 惠來路二段' },
      { name: '大遠百', x: 610.9, z: 93.8, src: 'B 224955652 Top City台中大遠百｜R 107444015 市政北七路' },
      { name: '臺中市政府', x: 905.5, z: 374.2, src: 'B 222413435 臺灣大道市政大樓｜R 260107776 府會園道' },
      { name: '國家歌劇院', x: 376.3, z: 181.5, src: 'B 222636759 臺中國家歌劇院｜R 376346424 惠來路二段 × 市政北五路' },
      { name: '秋紅谷', x: 1.0, z: -268.6, src: 'L 224961782 秋紅谷廣場｜R 107444010 市政北七路' },
    ],
  },
  {
    id: 'civic-loop',
    name: '市政環線賽',
    difficulty: 2,
    rivals: 3,
    start: { name: '夏綠地公園', x: 709.9, z: 269.0, heading: 2.59, src: 'L 222636760 夏綠地公園｜R 376346413 惠中路一段' },
    checkpoints: [
      { name: '臺中市政府', x: 905.5, z: 374.2, src: 'B 222413435 臺灣大道市政大樓｜R 260107776 府會園道' },
      { name: '捷運市政府站', x: 1094.2, z: 363.8, src: 'B 862750722 捷運市政府站（OSM 輪廓跨文心路，取站體北側路段）｜R 598568066 文心路二段' },
      { name: '都市發展局', x: 979.7, z: 559.4, src: 'B 232362811 臺中市政府都市發展局｜R 598568066 文心路二段 × 大隆路' },
      { name: '惠中公園', x: 917.4, z: -120.1, src: 'L 259202681 惠中公園｜R 87657282 惠中路' },
      { name: '新光三越', x: 585.4, z: -154.4, src: 'B 148849083｜R 364269699 臺灣大道三段 × 惠來路二段' },
      { name: '國家歌劇院', x: 376.3, z: 181.5, src: 'B 222636759 臺中國家歌劇院｜R 376346424 惠來路二段 × 市政北五路' },
    ],
  },
  {
    id: 'qiuhonggu-sprint',
    name: '秋紅谷飆速賽',
    difficulty: 3,
    rivals: 3,
    start: { name: '秋紅谷', x: -36.1, z: -235.7, heading: -0.533, src: 'L 224961782 秋紅谷廣場｜R 376346435 朝富路' },
    checkpoints: [
      { name: '林酒店', x: -105.3, z: -115.8, src: 'B 456488572 林酒店｜R 630367535 朝富路' },
      { name: '惠泰公園', x: -329.8, z: -65.4, src: 'L 491492674 惠泰公園｜R 515970256 黎明路二段 × 市政北二路' },
      { name: '小來公園', x: -65.3, z: 254.1, src: 'L 218675685 小來公園｜R 1049620878 河南路三段 × 市政北一路' },
      { name: '第六分局', x: 65.0, z: 539.8, src: 'B 260107782 臺中市政府警察局第六分局｜R 1044403394 市政路' },
      { name: '國家歌劇院', x: 376.3, z: 181.5, src: 'B 222636759 臺中國家歌劇院｜R 376346424 惠來路二段 × 市政北五路' },
      { name: '寶輝秋紅谷', x: 177.0, z: -157.4, src: 'B 853807906 寶輝秋紅谷｜R 1312476776 河南路三段 × 市政北七路' },
      { name: '老虎城', x: 99.9, z: -26.4, src: 'B 150999799 老虎城購物中心｜R 1049620878 河南路三段' },
    ],
  },
]);

export const raceById = (id, list = RACES) => list.find((r) => r.id === id) || null;

// mm:ss.s（十分位無條件捨去，負值視為 0）
export function formatRaceTime(sec) {
  const t = Math.floor(Math.max(0, Number(sec) || 0) * 10 + 1e-6);
  const m = Math.floor(t / 600);
  const s = Math.floor((t % 600) / 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${t % 10}`;
}
export const barText = (rank, total, cp, cpTotal, sec) => `名次 ${rank}/${total}｜檢查點 ${cp}/${cpTotal}｜${formatRaceTime(sec)}`;
export const toastFinish = (rank, sec, reward, newBest) => `完賽！第 ${rank} 名｜${formatRaceTime(sec)}${reward > 0 ? `｜獎金 NT$${reward}` : ''}${newBest ? '｜新紀錄！' : ''}`;

// 起跑格位世界座標：heading = atan2(dx, dz)（前方 = (sin h, cos h)、右方 = (−cos h, sin h)）
export function gridSlots(start, slots = GRID_SLOTS) {
  const h = start.heading || 0;
  const fx = Math.sin(h);
  const fz = Math.cos(h);
  const rx = -Math.cos(h);
  const rz = Math.sin(h);
  return slots.map(([l, f]) => ({ x: start.x + rx * l + fx * f, z: start.z + rz * l + fz * f, heading: h }));
}

const wrapAngle = (a) => {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// 畫面箭頭旋轉角（rad，CSS rotate 順時針為正；0 = 正前方朝上）：yaw 同車輛 / 角色（前方 (sin yaw, cos yaw)，目標在左 → 逆時針）
export function arrowAngle(px, pz, yaw, tx, tz) {
  return -wrapAngle(Math.atan2(tx - px, tz - pz) - (yaw || 0));
}

// 線段 (ax, az)→(bx, bz) 到點 (px, pz) 的距離平方（檢查點掃掠判定）
export function segDist2(ax, az, bx, bz, px, pz) {
  const dx = bx - ax;
  const dz = bz - az;
  const L2 = dx * dx + dz * dz;
  const t = L2 > 1e-12 ? clamp(((px - ax) * dx + (pz - az) * dz) / L2, 0, 1) : 0;
  return (ax + dx * t - px) ** 2 + (az + dz * t - pz) ** 2;
}

// 橡皮筋倍率：gap = 玩家進度 − 對手進度（m；正 = 對手落後 → 加速）
export function rubberBand(gap, max = RUBBER_MAX, full = RUBBER_GAP) {
  if (!Number.isFinite(gap) || full <= 0) return 1;
  return 1 + clamp(gap / full, -1, 1) * max;
}

// 檢查點累計直線距離：cum[i] = 起點 → 第 i 個檢查點（含）的折線長
export function courseCum(race) {
  const cum = [];
  let x = race.start.x;
  let z = race.start.z;
  let s = 0;
  for (const c of race.checkpoints) {
    s += Math.hypot(c.x - x, c.z - z);
    cum.push(s);
    x = c.x;
    z = c.z;
  }
  return cum;
}

// 進度（m）：已過 k 點 → cum[k] − 離第 k 點（0 起算）的直線距離；完賽 = 總長
export function progressOf(cum, race, k, x, z) {
  if (k >= race.checkpoints.length) return cum[cum.length - 1];
  const c = race.checkpoints[k];
  return cum[k] - Math.hypot(c.x - x, c.z - z);
}

// 存檔 races.best 清洗：只收已知賽道 id → 正有限秒數
export function cleanBest(src, list = RACES) {
  const out = {};
  if (!src || typeof src !== 'object' || Array.isArray(src)) return out;
  for (const r of list) {
    const v = src[r.id];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[r.id] = v;
  }
  return out;
}

export function createRaces({ bus = null, rng = Math.random, config = {} } = {}) {
  const cfg = {
    races: config.races || RACES,
    startRadius: config.startRadius ?? START_RADIUS,
    cpRadius: config.cpRadius ?? CP_RADIUS,
    countdown: config.countdownSec ?? COUNTDOWN_SEC,
    goSec: config.goSec ?? GO_SEC,
    leftSec: config.leftSec ?? LEFT_SEC,
    rubberMax: config.rubberMax ?? RUBBER_MAX,
    rubberGap: config.rubberGap ?? RUBBER_GAP,
    jitter: config.rivalJitter ?? RIVAL_JITTER,
    speeds: config.difficultySpeed || DIFFICULTY_SPEED,
    rewards: config.rewards || REWARDS,
    slots: config.gridSlots || GRID_SLOTS,
    maxDt: config.maxDt ?? MAX_DT,
    rng: config.rng || rng || Math.random,
  };
  const rand = () => {
    const r = Number(cfg.rng());
    return Number.isFinite(r) ? clamp(r, 0, 0.999999) : 0;
  };
  const emit = (name, payload) => {
    if (bus && typeof bus.emit === 'function') bus.emit(name, payload);
  };

  // phase：'idle' | 'countdown' | 'running'
  let phase = 'idle';
  let race = null;
  let cum = [];
  let countdown = 0;
  let goT = 0;
  let elapsed = 0;
  let leftT = 0;
  let finishSeq = 0;
  let world = null; // 最近一次 update 的 ctx.world（退賽回收對手車用）
  let lastCtx = null;
  let nextSlot = 0;
  let slotPts = [];
  const best = {};
  const player = { cp: 0, x: NaN, z: NaN, finished: false, finishT: 0 };
  const rivals = []; // { id, h, pending, out, cp, x, z, finished, finishSeq, finishT, mul }

  function toast(ctx, text, seconds) {
    if (ctx && typeof ctx.toast === 'function') ctx.toast(text, seconds);
    else emit('toast', { text, seconds });
  }

  function clearRivals() {
    for (const r of rivals.splice(0)) if (r.h && world && typeof world.remove === 'function') world.remove(r.h);
  }

  function reset() {
    phase = 'idle';
    race = null;
    cum = [];
    countdown = 0;
    goT = 0;
    elapsed = 0;
    leftT = 0;
    player.cp = 0;
    player.finished = false;
    player.finishT = 0;
  }

  const playerProgress = () => progressOf(cum, race, player.cp, player.x, player.z);
  const rivalProgress = (r) => (r.out ? -Infinity : progressOf(cum, race, r.cp, r.x, r.z));

  // 玩家名次（1 起算）：完賽者依完賽時間；未完賽先比檢查點數再比距離；退出的對手車排最後
  function rank() {
    if (!race) return 0;
    let n = 1;
    const pp = Number.isFinite(player.x) ? playerProgress() : -Infinity;
    for (const r of rivals) {
      if (r.pending) continue;
      // 已完賽者依完賽時間排名（完賽後車被撞毀 / 搶走仍保留名次）；玩家未完賽 → 一律在前
      if (r.finished) {
        if (!player.finished || r.finishT < player.finishT) n++;
        continue;
      }
      if (r.out || player.finished) continue;
      // 先比已過檢查點數，同檢查點才比離下一點距離（路網繞行不讓未過點的對手排前面）
      if (r.cp > player.cp || (r.cp === player.cp && rivalProgress(r) > pp)) n++;
    }
    return n;
  }
  const racerCount = () => 1 + rivals.reduce((n, r) => n + (r.pending ? 0 : 1), 0);

  function nearestStart(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    let best2 = cfg.startRadius * cfg.startRadius;
    let out = null;
    for (const r of cfg.races) {
      const d2 = (r.start.x - x) ** 2 + (r.start.z - z) ** 2;
      if (d2 <= best2) {
        best2 = d2;
        out = r;
      }
    }
    return out;
  }

  // 開賽條件（純函式，main.js 互動鍵仲裁用）→ { ok, reason }；reason ∈ active / unknown / notDriving / far / busy / wanted / stalled / overturned / moving
  function canStart(raceId, ctx = {}) {
    if (phase !== 'idle') return { ok: false, reason: 'active' };
    const r = raceById(raceId, cfg.races);
    if (!r) return { ok: false, reason: 'unknown' };
    if (!ctx.inCar) return { ok: false, reason: 'notDriving' };
    const p = ctx.player || {};
    if (!(Number.isFinite(p.x) && Number.isFinite(p.z)) || (p.x - r.start.x) ** 2 + (p.z - r.start.z) ** 2 > cfg.startRadius * cfg.startRadius) return { ok: false, reason: 'far' };
    if (ctx.busy) return { ok: false, reason: 'busy' };
    if ((Number(ctx.stars) || 0) > 0) return { ok: false, reason: 'wanted' };
    if (ctx.stalled) return { ok: false, reason: 'stalled' };
    if (ctx.overturned) return { ok: false, reason: 'overturned' };
    if (Math.abs(Number(ctx.speed) || 0) >= START_MAX_SPEED) return { ok: false, reason: 'moving' };
    return { ok: true, reason: null };
  }

  // 開賽：ctx 省略時不檢查條件（測試 / 除錯）；有星數 / 其他任務中 / 熄火 / 翻車 / 未停車 → toast 並回 false
  function start(raceId, ctx = null) {
    if (phase !== 'idle') return false;
    const r = raceById(raceId, cfg.races);
    if (!r) return false;
    if (ctx) {
      const c = canStart(raceId, ctx);
      if (!c.ok) {
        if (c.reason === 'wanted') toast(ctx, TOAST_WANTED, 3);
        else if (c.reason === 'busy') toast(ctx, TOAST_BUSY, 3);
        else if (c.reason === 'stalled') toast(ctx, TOAST_STALLED, 3);
        else if (c.reason === 'overturned') toast(ctx, TOAST_OVERTURNED, 3);
        else if (c.reason === 'moving') toast(ctx, TOAST_MOVING, 3);
        return false;
      }
    }
    race = r;
    cum = courseCum(r);
    phase = 'countdown';
    countdown = cfg.countdown;
    goT = 0;
    elapsed = 0;
    leftT = 0;
    player.cp = 0;
    player.finished = false;
    const p = (ctx && ctx.player) || r.start;
    player.x = Number.isFinite(p.x) ? p.x : r.start.x;
    player.z = Number.isFinite(p.z) ? p.z : r.start.z;
    slotPts = gridSlots(r.start, cfg.slots);
    nextSlot = 0;
    finishSeq = 0;
    const n = clamp(Math.floor(r.rivals) || 0, 0, slotPts.length);
    for (let i = 0; i < n; i++) rivals.push({ id: `rival-${i + 1}`, h: null, pending: true, out: false, cp: 0, x: NaN, z: NaN, finished: false, finishSeq: 0, finishT: 0, mul: 1 + (rand() * 2 - 1) * cfg.jitter });
    emit('race:start', { id: r.id, name: r.name, rivals: n, checkpoints: r.checkpoints.length, countdown: countdown });
    return true;
  }

  // 倒數期間生成對手車：依序試格位，被佔 / 不可放（world.spawn 回 null）就換下一格；格位用完的對手車放棄（開賽時剔除）
  function spawnPending(ctx) {
    const w = ctx.world;
    if (!w || typeof w.spawn !== 'function') return;
    for (const r of rivals) {
      if (!r.pending) continue;
      while (nextSlot < slotPts.length) {
        const pt = slotPts[nextSlot++];
        const h = w.spawn(pt, { index: rivals.indexOf(r), raceId: race.id });
        if (h) {
          r.h = h;
          r.pending = false;
          r.x = pt.x;
          r.z = pt.z;
          break;
        }
      }
    }
  }

  // 結束（reason ∈ END_REASONS）；cancel 不 toast。回傳是否真的結束了進行中的比賽
  function end(reason = 'cancel', ctx = lastCtx) {
    if (phase === 'idle') return false;
    const out = { id: race.id, reason, time: elapsed, cp: player.cp };
    clearRivals();
    reset();
    emit('race:abort', out);
    if (reason !== 'cancel') toast(ctx, toastAbort(reason), 4);
    return true;
  }

  function finish(ctx) {
    const t = elapsed;
    const n = rank(); // 先算名次（已完賽的對手車排前面）再標記玩家完賽
    player.finished = true;
    player.finishT = t;
    const total = racerCount();
    const reward = rewardFor(n, cfg.rewards);
    if (reward > 0 && ctx && typeof ctx.earn === 'function') ctx.earn(reward);
    const prev = best[race.id];
    const newBest = !(prev > 0) || t < prev;
    if (newBest) best[race.id] = t;
    const out = { id: race.id, name: race.name, rank: n, total, time: t, reward, best: best[race.id], newBest };
    clearRivals();
    reset();
    emit('race:finish', out);
    toast(ctx, toastFinish(n, t, reward, newBest), 6);
    return out;
  }

  function snapshot() {
    const on = phase !== 'idle';
    const K = race ? race.checkpoints.length : 0;
    const next = on && player.cp < K ? race.checkpoints[player.cp] : null;
    const n = on ? rank() : 0;
    const m = on ? racerCount() : 0;
    const count = phase === 'countdown' ? Math.max(1, Math.ceil(countdown - 1e-9)) : null;
    return {
      active: on,
      phase,
      raceId: race ? race.id : null,
      name: race ? race.name : null,
      rank: n,
      total: m,
      cp: player.cp,
      cpTotal: K,
      time: elapsed,
      locked: phase === 'countdown',
      countdown: count,
      go: phase === 'running' && goT > 0,
      next,
      text: on ? barText(n, m, player.cp, K, elapsed) : null,
    };
  }

  function update(dt, ctx = {}) {
    dt = Number.isFinite(dt) ? clamp(dt, 0, cfg.maxDt) : 0;
    lastCtx = ctx;
    if (ctx.world) world = ctx.world;
    if (phase === 'idle') return snapshot();
    const p = ctx.player || {};
    const px = Number(p.x);
    const pz = Number(p.z);
    if (!Number.isFinite(px) || !Number.isFinite(pz)) return snapshot();

    // 退賽條件（倒數中也檢查）
    if (ctx.wrecked) {
      end('wrecked', ctx);
      return snapshot();
    }
    if (ctx.inCar) leftT = 0;
    else {
      leftT += dt;
      if (leftT > cfg.leftSec) {
        end('left', ctx);
        return snapshot();
      }
    }

    const w = ctx.world;
    if (phase === 'countdown') {
      spawnPending(ctx);
      for (const r of rivals) if (r.h && w && typeof w.hold === 'function') w.hold(r.h);
      player.x = px;
      player.z = pz;
      countdown -= dt;
      if (countdown > 1e-9) return snapshot();
      // GO：沒生成成功的對手車剔除；倒數多扣的時間記入比賽時間（幀率無關）
      for (let i = rivals.length - 1; i >= 0; i--) if (rivals[i].pending) rivals.splice(i, 1);
      phase = 'running';
      elapsed = 0;
      goT = cfg.goSec;
      dt = Math.max(0, -countdown);
      countdown = 0;
    }

    // running
    elapsed += dt;
    if (goT > 0) goT = Math.max(0, goT - dt);
    const r2 = cfg.cpRadius * cfg.cpRadius;
    const K = race.checkpoints.length;
    // 玩家：只認下一個檢查點（漏點不算）；本幀位移掃掠判定
    const c = race.checkpoints[player.cp];
    const passed = c && segDist2(player.x, player.z, px, pz, c.x, c.z) <= r2;
    player.x = px;
    player.z = pz;
    if (passed) {
      player.cp++;
      emit('race:checkpoint', { id: race.id, index: player.cp, total: K, time: elapsed, rank: rank(), name: c.name });
      if (player.cp >= K) {
        finish(ctx);
        return snapshot();
      }
    }

    // 對手車
    const pp = playerProgress();
    const base = cfg.speeds[race.difficulty] ?? cfg.speeds[1] ?? DIFFICULTY_SPEED[1];
    for (const r of rivals) {
      if (r.out || !r.h) continue;
      // 完賽判定優先於退出判定：已完賽者停在終點，之後被撞毀 / 搶走不影響名次
      if (r.finished) {
        if (w && typeof w.hold === 'function') w.hold(r.h);
        continue;
      }
      const st = w && typeof w.state === 'function' ? w.state(r.h) : null;
      if (!st || !st.exists || st.driven || (Number.isFinite(st.health) && st.health <= 0)) {
        // 被回收 / 被玩家搶走 / 毀損：退出比賽並煞停（棄置的車不再自行行駛；車留在原地由 world.remove 收尾）
        r.out = true;
        if (w && typeof w.hold === 'function') w.hold(r.h);
        continue;
      }
      const ox = r.x;
      const oz = r.z;
      r.x = st.x;
      r.z = st.z;
      const rc = race.checkpoints[r.cp];
      if (segDist2(ox, oz, r.x, r.z, rc.x, rc.z) <= r2) {
        r.cp++;
        if (r.cp >= K) {
          r.finished = true;
          r.finishSeq = ++finishSeq;
          r.finishT = elapsed;
          if (w && typeof w.hold === 'function') w.hold(r.h);
          continue;
        }
      }
      const tgt = race.checkpoints[r.cp];
      const speed = base * r.mul * rubberBand(pp - rivalProgress(r), cfg.rubberMax, cfg.rubberGap);
      if (w && typeof w.drive === 'function') w.drive(r.h, { x: tgt.x, z: tgt.z, maxSpeed: speed });
    }
    return snapshot();
  }

  // 小地圖 / 大地圖標記：未開賽 → 各賽道起點旗幟；比賽中 → 下一個檢查點（貼邊）
  function markers(out = []) {
    if (phase === 'idle') {
      for (const r of cfg.races) out.push({ x: r.start.x, z: r.start.z, kind: MARKER_START, label: r.name });
    } else if (race && player.cp < race.checkpoints.length) {
      const c = race.checkpoints[player.cp];
      out.push({ x: c.x, z: c.z, kind: MARKER_CP, label: c.name });
    }
    return out;
  }

  // 光柱目標：未開賽 → 起點（橘）；比賽中 → 下一個檢查點（大光柱圈，last = 終點）
  function beacons() {
    if (phase === 'idle') return { starts: cfg.races.map((r) => r.start), checkpoint: null, last: false };
    const c = race && player.cp < race.checkpoints.length ? race.checkpoints[player.cp] : null;
    return { starts: [], checkpoint: c, last: !!race && player.cp === race.checkpoints.length - 1 };
  }

  // 存檔：{ best: { raceId: 秒 } }；沒有紀錄回 null（存檔省略此欄）
  function serialize() {
    const b = cleanBest(best, cfg.races);
    return Object.keys(b).length ? { best: b } : null;
  }
  function restore(data) {
    for (const k of Object.keys(best)) delete best[k];
    Object.assign(best, cleanBest(data && data.best, cfg.races));
  }
  const bestOf = (id) => (best[id] > 0 ? best[id] : null);

  // 對手車 handle 判定（整合層除錯 / 小地圖用）
  function isRivalHandle(h) {
    return phase !== 'idle' && !!h && rivals.some((r) => r.h === h);
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
    nearestStart,
    markers,
    beacons,
    serialize,
    restore,
    bestOf,
    rank,
    isRivalHandle,
    dispose,
    rivals,
    races: cfg.races,
    get active() {
      return phase !== 'idle';
    },
    get phase() {
      return phase;
    },
    get locked() {
      return phase === 'countdown';
    },
    get race() {
      return race;
    },
    get elapsed() {
      return elapsed;
    },
    get checkpoint() {
      return player.cp;
    },
  };
}

// ---------- 對手車世界介面（整合層用；只依賴注入的 vehicles / dmg / traffic / findRoute，不 import three / rapier）----------
// createRivalWorld({ vehicles, dmg, traffic, findRoute, rng, isFree, isKept, onKeep }) → ctx.world + update(dt)（每幀駕駛控制）/ brakeAll() / dispose()
//   vehicles：VehicleManager（adopt / remove / vehicles）；對手車 = adopt 的一般動態剛體車（會被撞、會撞一般車，位置只由物理推進，生成後不再改寫座標）
//   dmg：vehicle-damage（attach / detach / healthOf）；traffic：cars（生成時避開車流車）；findRoute：(a, b) → { points } | null（navigation.js）
//   isFree：(x, z) → 真 = 可放車（整合層以 buildingAt 排除建築內）；isKept / onKeep：回收時保留玩家正駕駛 / 上車中的車（同 vigilante）
// 駕駛控制同 vigilante createFugitiveWorld：路線跟隨 + 彎道減速 + 卡住倒車；hold = 煞停鎖定（倒數 / 完賽）
export const RIVAL_TYPES = ['sedan', 'sedan', 'suv'];
export const RIVAL_COLORS = ['#e53935', '#1e88e5', '#fdd835', '#43a047', '#8e24aa', '#212121'];
export const ROUTE_REACH = 8; // m
export const REROUTE_SEC = 3; // s
export const REROUTE_MOVE = 20; // m，目標移動超過此距離即重算（換下一個檢查點）
export const STEER_GAIN = 1.8;
export const THROTTLE_GAIN = 0.35;
export const CORNER_ANGLE = Math.PI / 2;
export const CORNER_MIN = 0.3;
export const STUCK_SPEED = 1; // m/s
export const STUCK_SEC = 2.5; // s
export const REVERSE_SEC = 1.5; // s
export const SPAWN_CLEAR_LAT = 2.8; // m，格位與既有車輛的橫向淨空（格位座標系）
export const SPAWN_CLEAR_LON = 5.5; // m，前後淨空

export function createRivalWorld({ vehicles = null, dmg = null, traffic = null, findRoute = null, rng = Math.random, isFree = () => true, isKept = () => false, onKeep = () => {} } = {}) {
  const cars = new Set();
  let time = 0;
  let seq = 0;
  const pick = (list) => list[Math.floor(clamp(Number(rng()) || 0, 0, 0.999999) * list.length)];
  const exists = (v) => !!vehicles && vehicles.vehicles.includes(v);

  // 格位是否被既有車輛佔用（格位座標系的矩形淨空）
  function occupied(pt) {
    const h = pt.heading || 0;
    const fx = Math.sin(h);
    const fz = Math.cos(h);
    const hit = (p) => {
      if (!p) return false;
      const dx = p.x - pt.x;
      const dz = p.z - pt.z;
      const lon = dx * fx + dz * fz;
      const lat = dx * -fz + dz * fx;
      return Math.abs(lat) < SPAWN_CLEAR_LAT && Math.abs(lon) < SPAWN_CLEAR_LON;
    };
    if (vehicles) for (const v of vehicles.vehicles) if (hit(v.pos)) return true;
    if (traffic && traffic.cars) for (const c of traffic.cars) if (hit(c.v ? c.v.pos : c.pos)) return true;
    return false;
  }

  function spawn(pt) {
    if (!vehicles || !pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.z)) return null;
    if (!isFree(pt.x, pt.z) || occupied(pt)) return null;
    const type = pick(RIVAL_TYPES);
    const v = vehicles.adopt({ type, color: RIVAL_COLORS[seq++ % RIVAL_COLORS.length], x: pt.x, z: pt.z, yaw: pt.heading ?? 0 });
    if (!v) return null;
    v.ai = true; // 不自動停放、不做遠距休眠（同警車 / 逃犯車）
    v.racer = true;
    if (dmg && typeof dmg.attach === 'function') dmg.attach(v);
    const car = { v, cmd: { x: pt.x, z: pt.z, maxSpeed: 0, set: false }, route: null, routeIdx: 0, routeAt: -Infinity, routeGoal: { x: NaN, z: NaN }, stuckT: 0, reverseT: 0, reverseSteer: 1 };
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
    if (!car) return;
    car.cmd.x = x;
    car.cmd.z = z;
    car.cmd.maxSpeed = maxSpeed;
    car.cmd.set = true;
  }

  function hold(car) {
    if (!car) return;
    car.cmd.set = false;
    car.stuckT = 0;
    car.reverseT = 0;
  }

  function remove(car) {
    if (!car || !cars.has(car)) return;
    cars.delete(car);
    const v = car.v;
    v.ai = false;
    v.racer = false;
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
    const last = pts.length - 1; // 檢查點本身就是路網節點：終點直接取目標
    while (car.routeIdx < last && Math.hypot(p.x - pts[car.routeIdx].x, p.z - pts[car.routeIdx].z) < ROUTE_REACH) car.routeIdx++;
    car.routeIdx = Math.min(car.routeIdx, last);
    return pts[car.routeIdx];
  }

  function brake(v) {
    v.setControls({ throttle: 0, steer: 0, brake: 1, handbrake: Math.abs(v.speed || 0) < STUCK_SPEED });
  }

  function control(car, dt) {
    const v = car.v;
    const c = car.cmd;
    if (v.body && v.body.kinematic && typeof v.body.setKinematic === 'function') v.body.setKinematic(false);
    const rb = v.body && v.body.body;
    if (rb && v.body.active !== false && typeof rb.isEnabled === 'function' && !rb.isEnabled()) rb.setEnabled(true);
    const speed = v.speed || 0;
    if (!c.set) {
      brake(v);
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

  // 每幀：未被玩家駕駛、仍存在的對手車（setControls 在下一個物理子步生效）
  function update(dt) {
    dt = Number.isFinite(dt) ? clamp(dt, 0, MAX_DT) : 0;
    time += dt;
    for (const car of cars) {
      if (car.v.driven || !exists(car.v)) continue;
      if (dt > 0) control(car, dt);
    }
  }

  // 凍結（手機 / 噴漆 / 搶劫 / BUSTED・WASTED，update 不跑）：煞停，不沿用最後一次油門 / 倒車
  function brakeAll() {
    for (const car of cars) {
      if (car.v.driven || !exists(car.v)) continue;
      car.stuckT = 0;
      car.reverseT = 0;
      brake(car.v);
    }
  }

  function dispose() {
    for (const car of [...cars]) remove(car);
  }

  return { spawn, state, drive, hold, remove, update, brakeAll, dispose, cars };
}

// ---------- 競速 HUD（DOM；root 由整合層給，.race- 前綴樣式在 src/style.css）----------
// set(snap, arrowRad)：snap = createRaces().update 回傳值（null / 未開賽 → 全部隱藏）；arrowRad = arrowAngle（下一點方向，順時針 rad）
export function createRaceHud({ root = null, doc = (root && root.ownerDocument) || globalThis.document } = {}) {
  if (!doc || typeof doc.createElement !== 'function') return { set() {}, dispose() {} };
  const mk = (cls, text = '') => {
    const el = doc.createElement('div');
    el.className = cls;
    el.hidden = true;
    if (text) el.textContent = text;
    (root || doc.body).appendChild(el);
    return el;
  };
  const bar = mk('race-bar');
  const count = mk('race-count');
  const arrow = mk('race-arrow', '▲');
  let lastText = null;
  let lastCount = null;
  let lastDeg = NaN;
  return {
    set(snap, arrowRad = 0) {
      const on = !!(snap && snap.active);
      const text = on ? snap.text : null;
      if (text !== lastText) {
        lastText = text;
        bar.hidden = text == null;
        if (text != null) bar.textContent = text;
      }
      const c = on ? (snap.countdown != null ? String(snap.countdown) : snap.go ? 'GO!' : null) : null;
      if (c !== lastCount) {
        lastCount = c;
        count.hidden = c == null;
        if (c != null) count.textContent = c;
      }
      const showArrow = on && snap.phase === 'running' && !!snap.next;
      arrow.hidden = !showArrow;
      if (showArrow) {
        const deg = Math.round(((arrowRad || 0) * 180) / Math.PI);
        if (deg !== lastDeg && arrow.style) {
          lastDeg = deg;
          arrow.style.transform = `translateX(-50%) rotate(${deg}deg)`;
        }
      }
    },
    dispose() {
      bar.remove();
      count.remove();
      arrow.remove();
    },
    bar,
    count,
    arrow,
  };
}
