// 超商搶劫（Phase 9 契約，§28）：玩家步行持槍瞄準店員 → 進度條 6 秒 → 搶到現金、立刻被通緝。純邏輯模組，不碰 DOM / three；
// 依賴注入：bus（emit toast / robbery:start / robbery:done / robbery:failed；訂閱 ped:knockdown / ped:dead 判店員倒地、
//   wanted:cleared 以中止進行中的搶劫）、wanted（report / setStars / stars）、stores（src/wanted/places.js 的 STORES）、
//   rng（0..1，搶得金額）、config（可覆寫下列常數）；police 參數保留給日後擴充（目前未使用）
// 呼叫端（main.js）每幀建 ctx = { player: { x, z, yaw }, onFoot, aiming, aimAt(x, z) → boolean, earn(n), toast?(text, sec), showHint?(id, text) }：
//   onFoot = 步行中（非駕駛 / 上車 / 搶車）；aiming = 正以槍械瞄準（weapons 的瞄準狀態）；aimAt = 準星是否對著該點附近 AIM_TOL m（見 aimNear）
//   earn(n) = 入帳（economy.add）；toast 省略時改 emit 'toast'；showHint 省略時不出提示（回傳真值 = 已顯示，之後不再呼叫）
// update(dt, ctx) 回傳 { active, storeId, progress }（每次新物件）：active 期間呼叫端顯示進度條「搶劫中…」（progress 0→1）
// 店員倒地：bus 'ped:knockdown' / 'ped:dead' 的 ped.clerkOf === store.id（整合層生成店員 actor 時設定），或直接呼叫 clerkDown(storeId)
// 每間店 state：'ready'（可搶）→ 'robbing'（搶劫中）→ 'cooldown'（搶完 / 失敗 / 店員倒地，COOLDOWN_SEC 後回 'ready'）
//   available = state === 'ready'（呼叫端據此顯示小光柱 / 店員；robbed = 冷卻中且是搶完的那種，店員消失）
// 時間一律吃呼叫端傳入的 dt（秒，clamp ≤ MAX_DT）：≥ 10 fps 時結果與幀率無關（誤差 ≤ 1 幀）

export const START_DIST = 6; // m，玩家距店員 ≤ 此值且瞄準店員 → 開始搶劫
export const ABORT_DIST = 8; // m，搶劫中離店員超過此值 → 失敗
export const ROB_SEC = 6; // s，持續瞄準多久進度滿
export const AIM_GRACE_SEC = 1; // s，搶劫中停止瞄準超過此值 → 失敗（期間進度暫停）
export const COOLDOWN_SEC = 180; // s，每間店搶完 / 店員倒地後的冷卻
export const FAIL_COOLDOWN_SEC = 180; // s，搶劫失敗（店員已報警）後的冷卻
export const LOOT_MIN = 300; // NT$，搶得金額下限
export const LOOT_MAX = 800; // NT$，搶得金額上限（含）
export const FAIL_MIN_STARS = 1; // 失敗時至少幾星（開始時已報警 ≥ 2 星；這裡只防中途被清星）
export const HINT_DIST = 20; // m，首次靠近可搶的超商（距門口）時出提示卡
export const AIM_TOL = 1.2; // m，aimNear 預設容差：準星射線離目標點的垂直距離
export const AIM_HEIGHT = 1.2; // m，瞄準點離地高度（店員胸口）
export const MAX_DT = 0.1; // s，單幀 dt 上限

export const HINT_ID = 'robbery';
export const HINT_TEXT = '拿槍瞄準店員就能搶劫超商，但會立刻被通緝！';
export const PROGRESS_LABEL = '搶劫中…';
export const TOAST_FAIL = '店員報警了！';
export const toastDone = (n) => `搶到 NT$${n}，快逃！`;
export const FAIL_REASONS = Object.freeze(['aim', 'distance', 'clerk', 'cleared']);

// 搶得金額：LOOT_MIN–LOOT_MAX 均勻整數（rng 非有限數視為 0）
export function lootAmount(rng = Math.random, min = LOOT_MIN, max = LOOT_MAX) {
  let r = Number(rng());
  if (!Number.isFinite(r)) r = 0;
  r = Math.min(Math.max(r, 0), 0.999999);
  return min + Math.floor(r * (max - min + 1));
}

// 準星判定（純函式）：射線 origin + t·dir（t > 0）到點 (px, py, pz) 的垂直距離 ≤ tol；點在背後一律 false
export function aimNear(origin, dir, px, py, pz, tol = AIM_TOL) {
  if (!origin || !dir) return false;
  const dl = Math.hypot(dir.x, dir.y, dir.z);
  if (!(dl > 1e-9)) return false;
  const fx = dir.x / dl;
  const fy = dir.y / dl;
  const fz = dir.z / dl;
  const vx = px - origin.x;
  const vy = py - origin.y;
  const vz = pz - origin.z;
  const t = vx * fx + vy * fy + vz * fz;
  if (!(t > 0)) return false;
  const d2 = vx * vx + vy * vy + vz * vz - t * t;
  return d2 <= tol * tol;
}

export function createRobberies({ bus, wanted, police = null, stores = [], rng = Math.random, config = {} } = {}) {
  void police;
  const cfg = {
    startDist: config.startDist ?? START_DIST,
    abortDist: config.abortDist ?? ABORT_DIST,
    robSec: config.robSec ?? ROB_SEC,
    aimGrace: config.aimGrace ?? AIM_GRACE_SEC,
    cooldown: config.cooldown ?? COOLDOWN_SEC,
    failCooldown: config.failCooldown ?? FAIL_COOLDOWN_SEC,
    lootMin: config.lootMin ?? LOOT_MIN,
    lootMax: config.lootMax ?? LOOT_MAX,
    hintDist: config.hintDist ?? HINT_DIST,
    maxDt: config.maxDt ?? MAX_DT,
    rng: config.rng || rng || Math.random,
  };
  const start2 = cfg.startDist * cfg.startDist;
  const abort2 = cfg.abortDist * cfg.abortDist;
  const hint2 = cfg.hintDist * cfg.hintDist;

  const emit = (name, payload) => {
    if (bus) bus.emit(name, payload);
  };

  // 每間店的即時狀態（stores 為外部傳入的靜態描述，複製欄位並附加計時器，不改原物件）
  // 櫃檯點缺省時以門口代替
  const list = stores.map((s) => ({
    ...s,
    counterX: Number.isFinite(s.counterX) ? s.counterX : s.x,
    counterZ: Number.isFinite(s.counterZ) ? s.counterZ : s.z,
    state: 'ready',
    cooldown: 0, // s，剩餘冷卻
    robT: 0, // s，已累積的瞄準秒數
    aimLost: 0, // s，搶劫中連續未瞄準秒數
    clerkDown: false, // 本輪店員已被打倒 / 擊斃（冷卻結束才重置）
    robbed: false, // 本輪是搶完進入的冷卻（店員消失）
    get available() {
      return this.state === 'ready';
    },
  }));
  const byId = new Map(list.map((s) => [s.id, s]));

  let active = null;
  let hinted = false;

  function toast(ctx, text, seconds) {
    if (ctx && typeof ctx.toast === 'function') ctx.toast(text, seconds);
    else emit('toast', { text, seconds });
  }

  function enterCooldown(s, sec) {
    s.state = 'cooldown';
    s.cooldown = sec;
    s.robT = 0;
    s.aimLost = 0;
    if (active === s) active = null;
  }

  function resetStore(s) {
    s.state = 'ready';
    s.cooldown = 0;
    s.robT = 0;
    s.aimLost = 0;
    s.clerkDown = false;
    s.robbed = false;
  }

  function begin(s) {
    s.state = 'robbing';
    s.robT = 0;
    s.aimLost = 0;
    active = s;
    // 店員報警（不是警力目擊）：robbery 保底 2 星
    if (wanted && typeof wanted.report === 'function') wanted.report('robbery', { x: s.counterX, z: s.counterZ, witnessed: false });
    emit('robbery:start', { storeId: s.id, x: s.counterX, z: s.counterZ });
  }

  function fail(s, reason, ctx) {
    enterCooldown(s, cfg.failCooldown);
    s.robbed = false;
    if (reason !== 'clerk' && reason !== 'cleared') {
      toast(ctx, TOAST_FAIL);
      if (wanted && typeof wanted.setStars === 'function' && !(wanted.stars >= FAIL_MIN_STARS)) wanted.setStars(FAIL_MIN_STARS);
    }
    emit('robbery:failed', { storeId: s.id, reason });
  }

  function succeed(s, ctx) {
    const amount = lootAmount(cfg.rng, cfg.lootMin, cfg.lootMax);
    enterCooldown(s, cfg.cooldown);
    s.robbed = true;
    if (ctx && typeof ctx.earn === 'function') ctx.earn(amount);
    emit('robbery:done', { storeId: s.id, amount });
    toast(ctx, toastDone(amount));
  }

  // 店員倒地 / 擊斃：本輪不能搶（進行中的搶劫中止、不給錢），冷卻照算（從倒地當下起算 COOLDOWN_SEC）
  function clerkDown(storeId) {
    const s = byId.get(storeId);
    if (!s || s.clerkDown) return false;
    s.clerkDown = true;
    if (s.state === 'robbing') fail(s, 'clerk', null);
    if (s.state === 'ready') enterCooldown(s, cfg.cooldown);
    else if (!s.robbed) s.cooldown = Math.max(s.cooldown, cfg.cooldown); // 失敗冷卻中被打倒：從倒地當下重算
    return true;
  }

  const offs = [];
  if (bus && typeof bus.on === 'function') {
    const onDown = (e) => {
      const id = e && e.ped && e.ped.clerkOf;
      if (id) clerkDown(id);
    };
    offs.push(bus.on('ped:knockdown', onDown));
    offs.push(bus.on('ped:dead', onDown));
    // 被捕 / 送醫 / 回主選單清星：進行中的搶劫無聲中止（不 toast、不補星）；'evaded' 不會在搶劫中發生（開始即 ≥ 2 星且被看見前不會擺脫）
    offs.push(
      bus.on('wanted:cleared', () => {
        if (active) fail(active, 'cleared', null);
      }),
    );
  }

  const d2 = (ax, az, bx, bz) => (ax - bx) ** 2 + (az - bz) ** 2;

  // dt：秒（clamp ≤ maxDt）；ctx 見檔頭
  function update(dt, ctx = {}) {
    dt = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), cfg.maxDt) : 0;
    const player = ctx.player || {};
    const px = Number(player.x);
    const pz = Number(player.z);
    const hasPos = Number.isFinite(px) && Number.isFinite(pz);
    const onFoot = !!ctx.onFoot;
    const aiming = onFoot && !!ctx.aiming && typeof ctx.aimAt === 'function';
    const aimAt = (s) => aiming && !!ctx.aimAt(s.counterX, s.counterZ);

    for (const s of list) {
      if (s.state !== 'cooldown') continue;
      s.cooldown = Math.max(0, s.cooldown - dt);
      if (s.cooldown <= 0) resetStore(s);
    }

    if (active) {
      const s = active;
      const far = !hasPos || d2(px, pz, s.counterX, s.counterZ) > abort2;
      if (far) fail(s, 'distance', ctx);
      else if (aimAt(s)) {
        s.aimLost = 0;
        s.robT += dt;
        if (s.robT >= cfg.robSec) succeed(s, ctx);
      } else {
        s.aimLost += dt;
        if (s.aimLost > cfg.aimGrace) fail(s, 'aim', ctx);
      }
    } else if (hasPos && onFoot) {
      // 首次靠近可搶的超商 → 提示卡（呼叫端回傳真值 = 已顯示 / 已看過，之後不再問）
      if (!hinted && typeof ctx.showHint === 'function') {
        for (const s of list) {
          if (s.state === 'ready' && d2(px, pz, s.x, s.z) <= hint2) {
            if (ctx.showHint(HINT_ID, HINT_TEXT)) hinted = true;
            break;
          }
        }
      }
      if (aiming) {
        // 同時多間在範圍內時取最近者（實務上店與店相距數百公尺）
        let best = null;
        let bestD = Infinity;
        for (const s of list) {
          if (s.state !== 'ready') continue;
          const dd = d2(px, pz, s.counterX, s.counterZ);
          if (dd <= start2 && dd < bestD && aimAt(s)) {
            best = s;
            bestD = dd;
          }
        }
        if (best) begin(best);
      }
    }

    if (!active) return { active: false, storeId: null, progress: 0 };
    return { active: true, storeId: active.id, progress: Math.min(1, active.robT / cfg.robSec) };
  }

  // 回主選單 / 讀檔繼續：進行中的搶劫無聲取消（不給錢、不 toast、不補星），該店回 ready；其餘各店冷卻 / 店員倒地保留，
  // 避免「搶完 → 回主選單 → 繼續」繞過冷卻重複領錢。開新局傳 { resetAll: true } 才全部重置為可搶
  function cancel({ resetAll = false } = {}) {
    if (active) resetStore(active);
    active = null;
    if (resetAll) for (const s of list) resetStore(s);
  }

  function dispose() {
    cancel({ resetAll: true });
    for (const off of offs.splice(0)) if (typeof off === 'function') off();
  }

  return {
    update,
    cancel,
    clerkDown,
    dispose,
    stores: list,
    get active() {
      return active ? active.id : null;
    },
  };
}
