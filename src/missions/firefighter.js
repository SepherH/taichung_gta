// 消防車副任務（P18，GTA 經典 Firefighter）：坐進消防車（車內、未進行其他任務）按互動鍵出勤 → 每關玩家 150–400 m 內 N 輛車起火
//   → 開到旁邊用車頂水砲（射擊鍵）把火勢澆到 0 → 全部熄滅過關（賞金 NT$(300 + 關數 × 150)）→ 下一關；第 12 關完成 = 全破，
//   永久獎勵「防火」（玩家駕駛的車起火門檻提高 / 引信延長：explosions.setFireproof）並存檔（只發一次）。
// 純邏輯模組，不 import three / rapier（THREE 由 createWaterCannonMesh 參數注入）；node 無頭測試以替身注入 world / bus。
//
// createFirefighter({ bus, rng, config }) → { update(dt, ctx) → snapshot, hold(dt), start(ctx?), cancel(), end(reason, ctx?), canStart(ctx), markers(out),
//   beacons(), serialize() → { fireproof, best }|null, restore(rec), dispose(), active, phase, level, fires, remaining, timeLeft, limit,
//   earned, cleared, fireproof, best, slots }
//   bus：emit firefighter:start / level / extinguish / complete / fail、toast（ctx.toast 省略時）；訂閱 player:busted / player:wasted（保底結束）
// 呼叫端（main.js）每幀建 ctx = { player: { x, z }, inTruck, wrecked, spraying, nozzle: { x, z, dx, dz }, world, earn(n), toast?(text, sec),
//   routeLength?(a, b) → m|null, onFireproof?(), save?() }：
//   inTruck = 正駕駛消防車；wrecked = 出勤那台消防車耐久歸零；spraying = 消防車內按住射擊鍵；nozzle = 水砲出口（車頭）與水平朝向（單位向量）
//   world（起火車世界介面，見 createFireWorld；測試以替身注入）：
//     spawnPoint(px, pz, rMin, rMax) → { x, z, heading }|null；spawn(pt, { occupants, fuse }) → h|null（點燃 + 引信 fuse s + 0–2 名驚慌乘客下車逃跑）
//     state(h) → { x, z, exists, burning, exploded }；setFuse(h, sec)；fuseOf?(h) → 剩餘引信 s | null；douse(h)（熄滅：取消引信、火關閉、修到安全耐久）；remove(h)
// 關卡：level 1..MAX_LEVEL；起火車數 firesFor(level) = min(MAX_FIRES, 1 + floor(level / 3))；phase 'spawn'（每 SPAWN_RETRY_SEC 補 1 輛，
//   彼此 ≥ FIRE_GAP m；湊齊或 SPAWN_WAIT_SEC 後已有 ≥ 1 輛即開始；SPAWN_TIMEOUT_SEC 仍 0 輛 → 失敗 nofire「附近沒有火警」）→ 'fight'（限時 = levelLimit(n, 估計路網路程)；各車引信改為 限時 + FUSE_GRACE）
// 水砲：ctx.spraying 且 inTruck → 每輛未熄滅車 waterHit(nozzle, 車) 命中時火勢 hp 每秒減 DOUSE_RATE；hp ≤ 0 → world.douse、emit extinguish
// 失敗：timeout（時間到）/ exploded（起火車爆炸或消失）/ left（離開消防車 > LEFT_SEC）/ wrecked / busted / wasted / quit（再按互動鍵收工）/ nofire（spawn 逾時）
//   → emit firefighter:fail、toast；cancel（回主選單 / 開新局）→ 無聲（emit fail reason 'cancel'、不 toast）；起火車一律 world.remove
// 時間吃呼叫端 dt（clamp ≤ MAX_DT），幀率無關；呼叫端凍結任務（不呼叫 update）時改呼叫 hold(dt) 延後起火車引信（與 explosions simDt 同一時鐘）；snapshot / 標記重用物件，任務條文字只在顯示內容變化時重建；每幀路徑不配置物件
import { FIRE_AT, SMOKE_AT } from '../explosions.js';
import { doorPoint, EJECT_OFFSET } from '../carjack.js';

export const MAX_LEVEL = 12;
export const MAX_FIRES = 4;
export const SPAWN_MIN = 150; // m，起火車生成距離帶（玩家直線距離）
export const SPAWN_MAX = 400;
export const FIRE_GAP = 30; // m，同關起火車彼此最小距離（> 爆炸半徑 × 3，避免連鎖）
export const PER_FIRE_SEC = 25; // s，每輛起火車加給的限時
export const TRUCK_SPEED = 10; // m/s，估計路網路程換算行車時間
export const ROUTE_FACTOR = 1.4; // 無路網（routeLength 缺 / 失敗）時直線 → 路網路程
export const FIRE_HP = 100; // 每輛起火車「火勢」
export const DOUSE_RATE = 34; // 火勢 / s（水柱命中時；約 3 s 熄滅一輛）
export const WATER_RANGE = 15; // m，水砲射程（車頭起算）
export const WATER_BASE = 0.5; // m，水柱出口半寬
export const WATER_SPREAD = 0.12; // 水柱每公尺加寬（半寬）
export const TARGET_RADIUS = 2.4; // m，起火車命中半徑
export const FUSE_GRACE = 20; // s，起火車引信 = 本關限時 + 此值（玩家有足夠時間；被撞 / 槍擊仍照 explosions FUSE_ACCEL 縮短）
export const SPAWN_FUSE = 600; // s，生成到開始計時之間的暫定引信
export const MAX_OCCUPANTS = 2; // 每輛起火車驚慌乘客 0..此值
export const SPAWN_RETRY_SEC = 0.5;
export const SPAWN_WAIT_SEC = 4;
export const SPAWN_TIMEOUT_SEC = 15; // s，spawn 階段仍 0 輛 → 失敗 'nofire'（附近沒有車道取樣點，例：地圖邊緣 / 山區；不扣錢）
export const LEFT_SEC = 20;
export const MAX_DT = 0.1;
export const URGENT_SEC = 15;
export const REWARD_BASE = 300;
export const REWARD_PER_LEVEL = 150;
export const MARKER_KIND = 'fire';
export const SPRAY_KEY = 'KeyX'; // 水砲備援鍵（鍵盤；觸控 tb-spray / 手把 X 駕駛消防車時送此虛擬鍵）；主鍵仍為射擊鍵 Mouse0
export const FAIL_REASONS = Object.freeze(['timeout', 'exploded', 'left', 'wrecked', 'busted', 'wasted', 'quit', 'nofire', 'cancel']);
export const PROMPT_START = '按 E 開始消防車任務';
export const PROMPT_QUIT = '按 E 結束消防車任務';
export const TOAST_BUSY = '正在進行其他任務，不能出勤';
export const TOAST_STALLED = '消防車熄火了，不能出勤';
export const TOAST_OVERTURNED = '消防車翻覆了，不能出勤';
export const TOAST_FIREPROOF = '🚒 消防車任務全破！永久獎勵：你駕駛的車輛防火（不易起火、引信加長）';
export const FAIL_TEXT = Object.freeze({
  timeout: '時間到',
  exploded: '起火車爆炸了',
  left: '離開消防車太久',
  wrecked: '消防車毀損',
  busted: '被捕',
  wasted: '送醫',
  quit: '收工',
  nofire: '附近沒有火警',
});

// 消防隊（osm-city.json B 層「消防局黎明分隊」fire_station，id 324898390；七期東北、青海路二段旁）：
//   門口 = 建物北緣與青海路二段（secondary，寬 6.4 m）之間的前庭（建物前 3 m）；消防車停在前庭中央、車頭朝青海路（距路中心 9 m）
//   座標以 osm 輪廓與路段投影推得（建物 / 水域外檢查見 tools/test/p18-firefighter.mjs）
export const FIRE_STATION = Object.freeze({ id: 'fire-station-liming', name: '消防局黎明分隊', osmId: 324898390, x: 1159.2, z: -353.5, yaw: -0.518 });
export const FIRE_TRUCK_SPOT = Object.freeze({ x: 1150.8, z: -352.0, yaw: -0.518 });
export const FIRE_STATION_BEACON = { height: 7, radius: 0.7, sink: 1 }; // 門口小光柱（同超商 / 武器店尺寸；顏色 BEACON_COLORS.fire）
export const FIRE_TRUCK_TYPE = 'fire_truck';
export const FIRE_TRUCK_COLOR = '#c8102e';
export const TRUCK_CHECK_SEC = 5; // s，停放消防車存在檢查間隔
export const TRUCK_RESPAWN_DIST = 60; // m，玩家離停放點超過此距離才補車
export const TRUCK_HOME_DIST = 30; // m，消防車離停放點超過此距離且無人使用 → 視為棄置，收回並在停放點補車

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const firesFor = (level, max = MAX_FIRES) => clamp(1 + Math.floor((Math.floor(level) || 1) / 3), 1, max);
export const levelReward = (level, base = REWARD_BASE, per = REWARD_PER_LEVEL) => base + per * Math.max(1, Math.floor(level) || 1);
export const levelLimit = (n, pathM, per = PER_FIRE_SEC, speed = TRUCK_SPEED) => Math.max(0, Number(pathM) || 0) / speed + n * per;
export const fireFuse = (limit, grace = FUSE_GRACE) => Math.max(0, Number(limit) || 0) + grace;
export const isFireTruck = (v) => !!v && v.type === FIRE_TRUCK_TYPE;

// 估計路程：from → 最近未訪起火車 → …（貪婪鏈；每段 routeLength(a, b)（路網 m），缺 / 失敗則直線 × factor）；pts 不會被修改
export function chainLength(from, pts, routeLength = null, factor = ROUTE_FACTOR) {
  let cur = from;
  let s = 0;
  let mask = 0;
  for (let k = 0; k < pts.length; k++) {
    let bi = -1;
    let bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      if (mask & (1 << i)) continue;
      const d = Math.hypot(pts[i].x - cur.x, pts[i].z - cur.z);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    mask |= 1 << bi;
    const r = typeof routeLength === 'function' ? Number(routeLength(cur, pts[bi])) : NaN;
    s += Number.isFinite(r) && r >= bd ? r : bd * factor;
    cur = pts[bi];
  }
  return s;
}

// 水柱命中：nozzle = { x, z, dx, dz }（出口與水平單位朝向）；目標中心 (tx, tz) 沿水柱的投影在 [−radius, range + radius] 內，
//   且離水柱軸線 ≤ 出口半寬 + 加寬 × 距離 + radius
export function waterHit(nozzle, tx, tz, range = WATER_RANGE, radius = TARGET_RADIUS, base = WATER_BASE, spread = WATER_SPREAD) {
  if (!nozzle) return false;
  const ox = tx - nozzle.x;
  const oz = tz - nozzle.z;
  const along = ox * nozzle.dx + oz * nozzle.dz;
  if (!(along >= -radius && along <= range + radius)) return false;
  const perp = Math.abs(ox * nozzle.dz - oz * nozzle.dx);
  return perp <= base + spread * clamp(along, 0, range) + radius;
}

// 水砲出口：車頭前緣中點（yaw：前方 (sin, cos)）；out 重用
export function nozzleOf(v, out = { x: 0, y: 0, z: 0, dx: 0, dz: 1 }) {
  const yaw = (v && v.yaw) || 0;
  const spec = (v && v.spec) || {};
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  const half = (spec.length ?? 7.6) / 2;
  const p = (v && v.pos) || { x: 0, y: 0, z: 0 };
  out.x = p.x + fx * half;
  out.z = p.z + fz * half;
  out.y = (p.y || 0) + (spec.height ?? 3) + 0.1;
  out.dx = fx;
  out.dz = fz;
  return out;
}

export const toastLevel = (level, reward, next) => `第 ${level} 關完成！賞金 NT$${reward}｜下一關 ${next} 輛起火車`;
export const toastFail = (reason, cleared, earned) => `${reason === 'quit' ? '消防車收工' : reason === 'nofire' ? `${FAIL_TEXT.nofire}，消防車收工` : `消防車任務失敗：${FAIL_TEXT[reason] || reason}`}｜完成 ${cleared} 關｜NT$${earned}`;

export function createFirefighter({ bus = null, rng = Math.random, config = {} } = {}) {
  const cfg = {
    maxLevel: config.maxLevel ?? MAX_LEVEL,
    maxFires: config.maxFires ?? MAX_FIRES,
    spawnMin: config.spawnMin ?? SPAWN_MIN,
    spawnMax: config.spawnMax ?? SPAWN_MAX,
    fireGap: config.fireGap ?? FIRE_GAP,
    perFire: config.perFireSec ?? PER_FIRE_SEC,
    speed: config.truckSpeed ?? TRUCK_SPEED,
    routeFactor: config.routeFactor ?? ROUTE_FACTOR,
    fireHp: config.fireHp ?? FIRE_HP,
    douseRate: config.douseRate ?? DOUSE_RATE,
    range: config.waterRange ?? WATER_RANGE,
    radius: config.targetRadius ?? TARGET_RADIUS,
    grace: config.fuseGrace ?? FUSE_GRACE,
    spawnFuse: config.spawnFuse ?? SPAWN_FUSE,
    maxOccupants: config.maxOccupants ?? MAX_OCCUPANTS,
    retrySec: config.spawnRetrySec ?? SPAWN_RETRY_SEC,
    waitSec: config.spawnWaitSec ?? SPAWN_WAIT_SEC,
    spawnTimeout: config.spawnTimeoutSec ?? SPAWN_TIMEOUT_SEC,
    leftSec: config.leftSec ?? LEFT_SEC,
    maxDt: config.maxDt ?? MAX_DT,
    urgentSec: config.urgentSec ?? URGENT_SEC,
  };
  const emit = (name, payload) => {
    if (bus && typeof bus.emit === 'function') bus.emit(name, payload);
  };
  const rand = () => clamp(Number(rng()) || 0, 0, 0.999999);

  // phase：'idle' | 'spawn' | 'fight'
  let phase = 'idle';
  let level = 0;
  let cleared = 0;
  let earned = 0;
  let need = 0;
  let spawnT = 0;
  let retryT = 0;
  let timeLeft = 0;
  let limit = 0;
  let leftT = 0;
  let world = null;
  let lastCtx = null;
  let fireproof = false; // 永久獎勵（存檔）
  let best = 0; // 最高完成關數（存檔）
  // 起火車槽（固定 MAX_FIRES 個，重用）：{ h, x, z, hp, out, mk }
  const slots = [];
  for (let i = 0; i < Math.max(1, cfg.maxFires); i++) slots.push({ h: null, x: 0, z: 0, hp: 0, out: false, mk: { x: 0, z: 0, kind: MARKER_KIND, label: '起火車' } });
  let count = 0;
  const center = { x: 0, z: 0 };
  const beaconOut = { dest: null };
  const snap = { active: false, phase: 'idle', level: 0, fires: 0, remaining: 0, timeLeft: 0, limit: 0, hp: 0, spraying: false, hitting: false, earned: 0, text: null, urgent: false };
  const shown = { phase: '', level: -1, remaining: -1, count: -1, sec: -2, hp: -2 };
  let hitting = false;
  let targetHp = -1; // 本幀被水柱命中車的最低火勢 %（無 = −1）

  function toast(ctx, text, seconds) {
    if (ctx && typeof ctx.toast === 'function') ctx.toast(text, seconds);
    else emit('toast', { text, seconds });
  }

  const remainingCount = () => {
    let n = 0;
    for (let i = 0; i < count; i++) if (!slots[i].out) n++;
    return n;
  };

  function clearFires() {
    for (let i = 0; i < count; i++) {
      const s = slots[i];
      if (s.h && world && typeof world.remove === 'function') world.remove(s.h);
      s.h = null;
      s.out = false;
      s.hp = 0;
    }
    count = 0;
  }

  function canStart(ctx = {}) {
    if (phase !== 'idle') return { ok: false, reason: 'active' };
    if (!ctx.inTruck) return { ok: false, reason: 'notTruck' };
    if (ctx.busy) return { ok: false, reason: 'busy' };
    if (ctx.stalled) return { ok: false, reason: 'stalled' };
    if (ctx.overturned) return { ok: false, reason: 'overturned' };
    return { ok: true, reason: null };
  }

  function beginLevel(n) {
    level = n;
    need = firesFor(level, cfg.maxFires);
    count = 0;
    spawnT = 0;
    retryT = 0;
    timeLeft = 0;
    limit = 0;
    phase = 'spawn';
  }

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
      if (ctx.world) world = ctx.world;
    }
    cleared = 0;
    earned = 0;
    leftT = 0;
    beginLevel(1);
    emit('firefighter:start', { level });
    if (ctx) toast(ctx, '消防車出勤：開到起火車旁，按住射擊鍵用水砲滅火（射程 15 m）', 4);
    return true;
  }

  // 結束：reason 'complete' 由 completeLevel 處理事件；其餘一律 emit firefighter:fail
  function end(reason = 'cancel', ctx = lastCtx) {
    if (phase === 'idle') return false;
    clearFires();
    const out = { reason, level, cleared, earned };
    phase = 'idle';
    leftT = 0;
    hitting = false;
    if (reason !== 'complete') emit('firefighter:fail', out);
    if (reason !== 'cancel' && reason !== 'complete') toast(ctx, toastFail(reason, cleared, earned), 5);
    return true;
  }

  function startClock(px, pz, ctx) {
    const pts = slots.slice(0, count); // 每關一次（非每幀）
    center.x = px;
    center.z = pz;
    limit = levelLimit(count, chainLength(center, pts, ctx && ctx.routeLength, cfg.routeFactor), cfg.perFire, cfg.speed);
    timeLeft = limit;
    const fuse = fireFuse(limit, cfg.grace);
    if (world && typeof world.setFuse === 'function') for (let i = 0; i < count; i++) world.setFuse(slots[i].h, fuse);
    phase = 'fight';
    emit('firefighter:fires', { level, fires: count, limit });
  }

  function grantFireproof(ctx) {
    if (fireproof) return false;
    fireproof = true;
    if (ctx && typeof ctx.onFireproof === 'function') ctx.onFireproof();
    if (ctx && typeof ctx.save === 'function') ctx.save();
    return true;
  }

  function completeLevel(ctx) {
    const reward = levelReward(level, REWARD_BASE, REWARD_PER_LEVEL);
    earned += reward;
    cleared = level;
    if (level > best) best = level;
    if (ctx && typeof ctx.earn === 'function') ctx.earn(reward);
    emit('firefighter:level', { level, reward, fires: count, timeLeft, earned });
    clearFires(); // 熄滅的車交 world.remove（交還一般車輛回收）
    if (level >= cfg.maxLevel) {
      const first = grantFireproof(ctx);
      emit('firefighter:complete', { levels: level, earned, fireproof, first });
      toast(ctx, first ? TOAST_FIREPROOF : `消防車任務全破！共得 NT$${earned}`, 6);
      end('complete', ctx);
      return;
    }
    toast(ctx, toastLevel(level, reward, firesFor(level + 1, cfg.maxFires)), 4);
    beginLevel(level + 1);
  }

  const fmt = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  function refreshSnap() {
    const on = phase !== 'idle';
    const rem = on ? remainingCount() : 0;
    snap.active = on;
    snap.phase = phase;
    snap.level = on ? level : 0;
    snap.fires = on ? count : 0;
    snap.remaining = rem;
    snap.timeLeft = timeLeft;
    snap.limit = limit;
    snap.hitting = on && hitting;
    snap.hp = on && hitting ? targetHp : -1;
    snap.earned = earned;
    snap.urgent = phase === 'fight' && timeLeft <= cfg.urgentSec;
    const sec = phase === 'fight' ? Math.max(0, Math.ceil(timeLeft - 1e-9)) : -1;
    const hp = snap.hp;
    if (shown.phase !== phase || shown.level !== level || shown.remaining !== rem || shown.count !== count || shown.sec !== sec || shown.hp !== hp) {
      shown.phase = phase;
      shown.level = level;
      shown.remaining = rem;
      shown.count = count;
      shown.sec = sec;
      shown.hp = hp;
      if (!on) snap.text = null;
      else if (phase === 'spawn') snap.text = `消防車｜第 ${level} 關｜火警通報中…`;
      else snap.text = `消防車｜第 ${level} 關｜起火車 剩 ${rem}/${count}${hp >= 0 ? `｜火勢 ${hp}%` : ''}｜剩 ${fmt(sec)}`;
    }
    return snap;
  }

  function farFromFires(x, z) {
    const g2 = cfg.fireGap * cfg.fireGap;
    for (let i = 0; i < count; i++) if ((slots[i].x - x) ** 2 + (slots[i].z - z) ** 2 < g2) return false;
    return true;
  }

  function update(dt, ctx = {}) {
    dt = Number.isFinite(dt) ? clamp(dt, 0, cfg.maxDt) : 0;
    lastCtx = ctx;
    if (ctx.world) world = ctx.world;
    hitting = false;
    targetHp = -1;
    if (phase === 'idle') return refreshSnap();
    const p = ctx.player || {};
    const px = Number(p.x);
    const pz = Number(p.z);
    if (!Number.isFinite(px) || !Number.isFinite(pz)) return refreshSnap();
    if (ctx.wrecked) {
      end('wrecked', ctx);
      return refreshSnap();
    }
    if (ctx.inTruck) leftT = 0;
    else {
      leftT += dt;
      if (leftT > cfg.leftSec) {
        end('left', ctx);
        return refreshSnap();
      }
    }

    if (phase === 'spawn') {
      spawnT += dt;
      retryT -= dt;
      if (retryT <= 0 && count < need) {
        retryT = cfg.retrySec;
        // 每次最多補 1 輛（錯開）；離已生成者 < FIRE_GAP 的點放棄、下次再試
        const pt = world && typeof world.spawnPoint === 'function' ? world.spawnPoint(px, pz, cfg.spawnMin, cfg.spawnMax) : null;
        if (pt && farFromFires(pt.x, pt.z)) {
          const occupants = Math.floor(rand() * (cfg.maxOccupants + 1));
          const h = typeof world.spawn === 'function' ? world.spawn(pt, { occupants, fuse: cfg.spawnFuse, level }) : null;
          if (h) {
            const s = slots[count++];
            s.h = h;
            s.x = pt.x;
            s.z = pt.z;
            s.hp = cfg.fireHp;
            s.out = false;
          }
        }
      }
      if (count >= need || (count > 0 && spawnT >= cfg.waitSec)) startClock(px, pz, ctx);
      else if (count === 0 && spawnT >= cfg.spawnTimeout) end('nofire', ctx); // 附近沒有火警：收工（不扣錢、已得賞金保留）
      return refreshSnap();
    }

    // fight：先查爆炸 / 消失，再算水砲，最後過關 / 超時
    for (let i = 0; i < count; i++) {
      const s = slots[i];
      if (s.out) continue;
      const st = world && typeof world.state === 'function' ? world.state(s.h) : null;
      if (!st || !st.exists || st.exploded) {
        end('exploded', ctx);
        return refreshSnap();
      }
      s.x = st.x;
      s.z = st.z;
      if (!st.burning) {
        // 被別的方式熄掉（例：噴漆廠修好）→ 視同熄滅
        s.out = true;
        s.hp = 0;
        emit('firefighter:extinguish', { level, index: i, remaining: remainingCount(), x: s.x, z: s.z });
      }
    }
    const spray = !!(ctx.inTruck && ctx.spraying && ctx.nozzle);
    if (spray) {
      for (let i = 0; i < count; i++) {
        const s = slots[i];
        if (s.out || !waterHit(ctx.nozzle, s.x, s.z, cfg.range, cfg.radius)) continue;
        hitting = true;
        s.hp -= cfg.douseRate * dt;
        if (s.hp <= 1e-9) {
          s.hp = 0;
          s.out = true;
          if (world && typeof world.douse === 'function') world.douse(s.h);
          emit('firefighter:extinguish', { level, index: i, remaining: remainingCount(), x: s.x, z: s.z });
        } else {
          const pct = Math.ceil((s.hp / cfg.fireHp) * 100);
          if (targetHp < 0 || pct < targetHp) targetHp = pct;
        }
      }
    }
    if (remainingCount() === 0) {
      completeLevel(ctx);
      return refreshSnap();
    }
    timeLeft -= dt;
    if (timeLeft <= 0) {
      timeLeft = 0;
      end('timeout', ctx);
      return refreshSnap();
    }
    return refreshSnap();
  }

  // 任務計時凍結（呼叫端不推進 update：手機 / 噴漆 / 重生中）時每幀呼叫：未熄滅起火車的引信同步延後 dt
  //   （explosions 照 simDt 燒引信）→ 任務計時與引信同一時鐘，不會在 HUD 仍有剩餘時間時爆炸
  function hold(dt) {
    dt = Number.isFinite(dt) ? clamp(dt, 0, cfg.maxDt) : 0;
    if (phase !== 'fight' || !(dt > 0) || !world || typeof world.setFuse !== 'function' || typeof world.fuseOf !== 'function') return;
    for (let i = 0; i < count; i++) {
      const s = slots[i];
      if (s.out) continue;
      const f = world.fuseOf(s.h);
      if (f > 0) world.setFuse(s.h, f + dt);
    }
  }

  // 標記（重用物件）：未熄滅的起火車 kind 'fire'（會移動：被撞 / 推走；小地圖超出半徑時貼邊）
  function markers(out = []) {
    if (phase === 'idle') return out;
    for (let i = 0; i < count; i++) {
      const s = slots[i];
      if (s.out) continue;
      s.mk.x = s.x;
      s.mk.z = s.z;
      out.push(s.mk);
    }
    return out;
  }

  function beacons() {
    beaconOut.dest = null; // 起火車本身有火焰 / 黑煙，不另放光柱（draw call 預算）
    return beaconOut;
  }

  function serialize() {
    if (!fireproof && !(best > 0)) return null;
    return { fireproof, best };
  }

  // 讀檔：舊存檔沒有此欄 / 格式錯誤 → 未解鎖、0 關
  function restore(rec) {
    const ok = rec && typeof rec === 'object' && !Array.isArray(rec);
    fireproof = !!(ok && rec.fireproof === true);
    const b = ok ? Number(rec.best) : 0;
    best = Number.isInteger(b) && b > 0 ? Math.min(cfg.maxLevel, b) : 0;
    if (fireproof && best < cfg.maxLevel) best = cfg.maxLevel; // 防火只在全破時取得
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
    hold,
    start,
    cancel,
    end,
    canStart,
    markers,
    beacons,
    serialize,
    restore,
    dispose,
    snapshot: refreshSnap,
    slots,
    get active() {
      return phase !== 'idle';
    },
    get phase() {
      return phase;
    },
    get level() {
      return level;
    },
    get fires() {
      return count;
    },
    get remaining() {
      return remainingCount();
    },
    get timeLeft() {
      return timeLeft;
    },
    get limit() {
      return limit;
    },
    get earned() {
      return earned;
    },
    get cleared() {
      return cleared;
    },
    get fireproof() {
      return fireproof;
    },
    get best() {
      return best;
    },
  };
}

// ---------- 起火車世界介面（整合層用；只依賴注入的 vehicles / dmg / explosions / traffic，不 import three）----------
// createFireWorld({ vehicles, dmg, explosions, traffic, rng, isKept, onKeep }) → { spawnPoint, spawn, state, setFuse, fuseOf, douse, remove, dispose, cars, spotQueries }
//   spawnPoint：traffic.spawnSpots 車道取樣點（距離帶內、離其他車 ≥ SPAWN_CAR_GAP；取樣結果快取，玩家移動 > SPOT_CACHE_MOVE 或距離帶變了才重取）
//   spawn：vehicles.adopt 一般車 + dmg.attach → explosions.damageVehicle 扣到起火門檻（FIRE_AT）之上點燃 → explosions.setFuse(fuse)；
//     occupants 名驚慌乘客 = traffic.spawnEjectedDriver（車門外倒地）且不指定攻擊者（pendingAttacker = null → 起身後逃離車子）
//   douse：explosions.extinguish（取消引信、火焰 / 黑煙停；v.doused 只在 v.fireTarget 期間擋重燃）+ dmg.repair 後扣到損壞比 DOUSED_DAMAGE
//     （< SMOKE_AT：白煙、不起火）；不 detach——之後照常受損 / 報廢
//   remove：清 v.fireTarget / v.doused（交還後回到一般車規則：受損照常起火 / 爆炸）；未熄滅的車（仍在燒，或 explosions.clear 已清掉狀態的低耐久車）
//     走同一條 douse 路徑熄火並修到安全耐久（不在任務外爆炸、不永久防燃）；一律 onKeep(v) 交還整合層一般車輛回收（遠了才消失）
//   fuseOf(h)：explosions.fuseOf 轉呼叫（任務凍結時延後引信用）
export const FIRE_CAR_TYPES = ['sedan', 'sedan', 'suv', 'taxi'];
export const FIRE_CAR_COLORS = ['#f2f2f2', '#1f1f22', '#8a8f94', '#b01e28', '#2d5fb0', '#d9d2c0', '#3f6b4a'];
export const SPAWN_TRIES = 12;
export const SPAWN_CAR_GAP = 10; // m
export const DOUSED_DAMAGE = 0.5; // 熄滅後的損壞比（< SMOKE_AT：白煙、不起火；交還後再受損照一般規則）
export const SPOT_CACHE_MOVE = 25; // m，spawnSpots 車道取樣快取：玩家離上次取樣中心 ≤ 此值且距離帶相同 → 重用（車道點為靜態）

export function createFireWorld({ vehicles = null, dmg = null, explosions = null, traffic = null, rng = Math.random, onKeep = () => {} } = {}) {
  const cars = new Set();
  let spots = [];
  const spotAt = { x: NaN, z: NaN, rMin: NaN, rMax: NaN, n: 0 };
  const st = { x: NaN, z: NaN, exists: false, burning: false, exploded: false };
  const pick = (list) => list[Math.floor(clamp(Number(rng()) || 0, 0, 0.999999) * list.length)];
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
    if (!(Math.hypot(px - spotAt.x, pz - spotAt.z) <= SPOT_CACHE_MOVE) || spotAt.rMin !== rMin || spotAt.rMax !== rMax) {
      spots = traffic.spawnSpots(px, pz, rMin, rMax, spots) || spots;
      spotAt.x = px;
      spotAt.z = pz;
      spotAt.rMin = rMin;
      spotAt.rMax = rMax;
      spotAt.n++;
    }
    if (!spots.length) return null;
    for (let k = 0; k < SPAWN_TRIES; k++) {
      const sp = pick(spots);
      const d = Math.hypot(sp.x - px, sp.z - pz);
      if (d < rMin || d > rMax || nearVehicle(sp.x, sp.z)) continue;
      return { x: sp.x, z: sp.z, heading: sp.heading ?? 0 };
    }
    return null;
  }

  function spawn(pt, { occupants = 0, fuse = SPAWN_FUSE } = {}) {
    if (!vehicles || !pt || typeof vehicles.adopt !== 'function') return null;
    const type = pick(FIRE_CAR_TYPES);
    const v = vehicles.adopt({ type, color: type === 'taxi' ? '#f5c518' : pick(FIRE_CAR_COLORS), x: pt.x, z: pt.z, yaw: pt.heading ?? 0 });
    if (!v) return null;
    v.fireTarget = true;
    if (dmg && typeof dmg.attach === 'function') dmg.attach(v);
    const maxH = dmg && typeof dmg.maxHealthOf === 'function' ? dmg.maxHealthOf(v) || 1000 : 1000;
    if (explosions && typeof explosions.damageVehicle === 'function') explosions.damageVehicle(v, Math.ceil(maxH * FIRE_AT) + 10);
    if (explosions && typeof explosions.setFuse === 'function') explosions.setFuse(v, fuse);
    const car = { v, occupants: 0 };
    const n = Math.max(0, Math.floor(occupants) || 0);
    if (n > 0 && traffic && typeof traffic.spawnEjectedDriver === 'function') {
      const spec = v.spec || {};
      for (let i = 0; i < n; i++) {
        // 第 1 名駕駛座側、第 2 名副駕側
        const d = doorPoint(v.pos.x, v.pos.z, v.yaw || 0, { length: spec.length || 4.5, width: spec.width || 1.85 }, i === 0 ? spec.doorSide ?? 1 : -(spec.doorSide ?? 1));
        const p = traffic.spawnEjectedDriver({ x: d.x + d.outX * EJECT_OFFSET, z: d.z + d.outZ * EJECT_OFFSET, yaw: Math.atan2(d.outX, d.outZ) });
        if (p) {
          p.pendingAttacker = null; // 不還手：起身後逃離車門（traffic-peds：pendingFrom → brain.onAttacked({ vehicle })）
          car.occupants++;
        }
      }
    }
    cars.add(car);
    return car;
  }

  function state(car) {
    const v = car && car.v;
    if (!v || !exists(v)) {
      st.x = NaN;
      st.z = NaN;
      st.exists = false;
      st.burning = false;
      st.exploded = !!(v && v.burnt);
      return st;
    }
    const s = explosions && typeof explosions.stateOf === 'function' ? explosions.stateOf(v) : 'fire';
    st.x = v.pos.x;
    st.z = v.pos.z;
    st.exists = true;
    st.exploded = s === 'wreck' || !!v.burnt;
    st.burning = s === 'fire';
    return st;
  }

  function setFuse(car, sec) {
    if (car && car.v && explosions && typeof explosions.setFuse === 'function') explosions.setFuse(car.v, sec);
  }

  // 熄火 + 修到安全耐久（損壞比 DOUSED_DAMAGE）；不 detach
  function settle(car) {
    const v = car.v;
    if (explosions && typeof explosions.extinguish === 'function') explosions.extinguish(v);
    if (dmg && typeof dmg.repair === 'function') {
      dmg.repair(v);
      const maxH = typeof dmg.maxHealthOf === 'function' ? dmg.maxHealthOf(v) || 0 : 0;
      if (maxH > 0 && typeof dmg.addDamage === 'function') dmg.addDamage(v, Math.floor(maxH * Math.min(DOUSED_DAMAGE, SMOKE_AT - 0.05)));
    }
    car.settled = true;
  }

  function douse(car) {
    if (!car || !car.v || !cars.has(car)) return;
    settle(car);
    car.v.doused = true; // fireTarget 期間擋重燃（explosions onDamage）；remove 時清掉
  }

  function remove(car) {
    if (!car || !cars.has(car)) return;
    const v = car.v;
    if (exists(v) && !v.burnt && !(explosions && typeof explosions.isWreck === 'function' && explosions.isWreck(v)) && !car.settled) settle(car);
    cars.delete(car);
    v.fireTarget = false;
    v.doused = false;
    if (!exists(v)) return;
    onKeep(v);
  }

  function fuseOf(car) {
    return car && car.v && explosions && typeof explosions.fuseOf === 'function' ? explosions.fuseOf(car.v) : null;
  }

  function dispose() {
    for (const car of [...cars]) remove(car);
  }

  return {
    spawnPoint, spawn, state, setFuse, fuseOf, douse, remove, dispose, cars,
    get spotQueries() {
      return spotAt.n;
    },
  };
}

// ---------- 消防隊停放管理（整合層用；只依賴注入的 vehicles / dmg）----------
// createFireTruckDepot({ vehicles, dmg?, spot, isBusy?(v) }) → { update(dt, player), ensure(force, player?), isFireTruck(v), vehicle, spot, dispose() }
//   規則同 ems.js createAmbulanceDepot：遊戲中沒有停放消防車 → 在 spot adopt 一台（FIRE_TRUCK_TYPE + FIRE_TRUCK_COLOR，v.fireStation = true）；
//   毀損且無人駕駛 → 交一般回收，玩家離 spot > TRUCK_RESPAWN_DIST 時補車；完好但棄置在離 spot > TRUCK_HOME_DIST 處、無人駕駛且 !isBusy
//   → 玩家看不到時（或 force）收回並在 spot 補一台
export function createFireTruckDepot({ vehicles = null, dmg = null, spot = FIRE_TRUCK_SPOT, isBusy = () => false } = {}) {
  let car = null;
  let t = TRUCK_CHECK_SEC;
  const exists = (v) => !!v && !!vehicles && vehicles.vehicles.includes(v);

  function spawn() {
    if (!vehicles || typeof vehicles.adopt !== 'function') return null;
    const v = vehicles.adopt({ type: FIRE_TRUCK_TYPE, color: FIRE_TRUCK_COLOR, x: spot.x, z: spot.z, yaw: spot.yaw });
    if (!v) return null;
    v.fireStation = true;
    if (dmg && typeof dmg.attach === 'function') dmg.attach(v);
    car = v;
    return v;
  }

  function ensure(force = false, player = null) {
    if (exists(car)) {
      const wreck = dmg && typeof dmg.healthOf === 'function' && dmg.healthOf(car) === 0;
      if (car.driven || isBusy(car)) return car;
      const away = !!car.pos && Math.hypot(car.pos.x - spot.x, car.pos.z - spot.z) > TRUCK_HOME_DIST;
      if (!wreck && !away) return car;
      if (wreck) {
        car.fireStation = false; // 殘骸交一般回收
        car = null;
      } else {
        const unseen = !player || (Math.hypot(player.x - car.pos.x, player.z - car.pos.z) > TRUCK_RESPAWN_DIST && Math.hypot(player.x - spot.x, player.z - spot.z) > TRUCK_RESPAWN_DIST);
        if (!force && !unseen) return car;
        if (dmg && typeof dmg.detach === 'function') dmg.detach(car);
        if (typeof vehicles.remove === 'function') vehicles.remove(car);
        car = null;
      }
    }
    const far = !player || Math.hypot(player.x - spot.x, player.z - spot.z) > TRUCK_RESPAWN_DIST;
    if (force || far) return spawn();
    return null;
  }

  function update(dt, player) {
    t += Number.isFinite(dt) ? dt : 0;
    if (t < TRUCK_CHECK_SEC) return;
    t = 0;
    ensure(false, player);
  }

  return {
    update,
    ensure,
    isFireTruck,
    spot,
    dispose() {
      car = null;
    },
    get vehicle() {
      return exists(car) ? car : null;
    },
  };
}

// ---------- 水砲水柱（THREE 注入；1 個 InstancedMesh = 1 draw call，無貼圖 / 光源 / 陰影；每幀路徑不配置物件）----------
// createWaterCannonMesh({ THREE, scene, count = WATER_SEGMENTS }) → { update(dt, on, nozzle), mesh, dispose() }
//   nozzle = { x, y, z, dx, dz }（nozzleOf）；on 時 count 段白色錐體沿拋物線流向射程 WATER_RANGE，段落循環前進、越遠越寬越淡（以縮放表現）；
//   off 時 mesh.visible = false（不送 draw call）
export const WATER_SEGMENTS = 16;
export const WATER_FLOW = 1.6; // 每秒段落前進的射程比例
export const WATER_LIFT = 0.18; // 拋物線初始仰角斜率
export const WATER_DROP = 0.022; // 拋物線下墜係數（1/m）

// 第 k 段（相位 u ∈ [0, 1)）在水柱上的位置：s = u × range；y = 出口高 + s × lift − s² × drop（純函式，測試用）
export function waterArc(u, nozzle, range = WATER_RANGE, out = { x: 0, y: 0, z: 0, s: 0 }) {
  const s = clamp(u, 0, 1) * range;
  out.s = s;
  out.x = nozzle.x + nozzle.dx * s;
  out.z = nozzle.z + nozzle.dz * s;
  out.y = (nozzle.y || 0) + s * WATER_LIFT - s * s * WATER_DROP;
  return out;
}

export function createWaterCannonMesh({ THREE = null, scene = null, count = WATER_SEGMENTS } = {}) {
  if (!THREE || !THREE.InstancedMesh) return { update() {}, mesh: null, dispose() {} };
  const geo = new THREE.ConeGeometry(0.32, 1.4, 8, 1, true);
  geo.rotateX(Math.PI / 2); // 錐軸轉到 +Z（沿水柱前進方向）
  const mat = new THREE.MeshBasicMaterial({ color: 0xeaf6ff, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide });
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.name = 'water-cannon';
  mesh.frustumCulled = false; // 實例散在 15 m 內，包圍球以原點計算會誤剔除
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.visible = false;
  if (scene) scene.add(mesh);
  const m4 = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const arc = { x: 0, y: 0, z: 0, s: 0 };
  let phase = 0;

  function update(dt, on, nozzle) {
    if (!on || !nozzle) {
      mesh.visible = false;
      return;
    }
    mesh.visible = true;
    phase = (phase + (dt > 0 ? dt : 0) * WATER_FLOW) % 1;
    const yaw = Math.atan2(nozzle.dx, nozzle.dz);
    for (let i = 0; i < count; i++) {
      const u = (phase + i / count) % 1;
      waterArc(u, nozzle, WATER_RANGE, arc);
      const slope = WATER_LIFT - 2 * WATER_DROP * arc.s; // dy/ds：錐體沿拋物線切線俯仰
      euler.set(-Math.atan(slope), yaw, 0);
      quat.setFromEuler(euler);
      pos.set(arc.x, arc.y, arc.z);
      const w = 0.6 + (arc.s / WATER_RANGE) * 2.6; // 越遠越寬
      scl.set(w, w, 1 + u * 0.8);
      m4.compose(pos, quat, scl);
      mesh.setMatrixAt(i, m4);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  function dispose() {
    if (mesh.parent) mesh.parent.remove(mesh);
    geo.dispose();
    mat.dispose();
  }

  return { update, mesh, dispose };
}
