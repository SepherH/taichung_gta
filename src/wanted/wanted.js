// 通緝核心（Phase 7 契約 A）：犯行 → heat → 星數、active / searching / clear 狀態機、搜索圈
// 依賴注入：bus（on / once / off / emit，見 src/core/events.js）；不碰 DOM、不 import main.js
// 時間一律吃呼叫端傳入的 dt（秒，內部 clamp ≤ MAX_DT），計時以累加秒數判斷，結果與幀率無關

// 犯行種類（值 = 同名字串）
export const CRIMES = Object.freeze({
  assault: 'assault',
  assaultPolice: 'assaultPolice',
  kill: 'kill',
  killPolice: 'killPolice',
  gunfire: 'gunfire',
  carjack: 'carjack',
  vehicleHit: 'vehicleHit',
  vehicleKill: 'vehicleKill',
  policeVehicle: 'policeVehicle',
  robbery: 'robbery', // 超商搶劫（Phase 9，src/wanted/robbery.js；開始搶劫時由店員報警，witnessed=false）
  snatch: 'snatch', // P19 飛車搶包（src/snatch.js；路人報案 witnessed=false → 保底 1 星）
  snatchCombo: 'snatchCombo', // P19 連擊 ≥ 3 的搶包：保底 2 星
});

// 各犯行增加的 heat（被警力看見時全額）
export const HEAT = Object.freeze({
  assault: 0.6,
  assaultPolice: 2.0,
  kill: 1.5,
  killPolice: 3.0,
  gunfire: 0.4,
  carjack: 1.0,
  vehicleHit: 0.5,
  vehicleKill: 1.5,
  policeVehicle: 0.8,
  robbery: 2.5,
  snatch: 0.6,
  snatchCombo: 1.5,
});

// 犯行保底星數：report 後星數至少為此值（不論 witnessed）；超商搶劫保證至少 2 星；飛車搶包 1 星、連擊 ≥ 3 升 2 星
export const CRIME_MIN_STARS = Object.freeze({ robbery: 2, snatch: 1, snatchCombo: 2 });

export const STAR_HEAT = Object.freeze([0, 0.5, 3, 6, 10, 15]); // stars = 最大 n 使 heat ≥ STAR_HEAT[n]
export const EVADE_SEC = Object.freeze([0, 10, 15, 22, 30, 40]); // 依星數：脫離視線多久進入 / 完成搜尋
export const MAX_STARS = STAR_HEAT.length - 1;
export const MAX_DT = 0.1; // s：單幀 dt 上限
export const UNWITNESSED_MULT = 0.5; // 只有路人看見時 heat 倍率
export const UNWITNESSED_MIN_STARS = 1; // 只有路人看見時至少幾星
export const SEARCH_AFTER_FRAC = 0.3; // active 連續 unseen 超過 EVADE_SEC[stars] × 此值 → searching
export const CIRCLE_BASE_R = 80; // m：搜索圈半徑 = BASE + PER_STAR × stars
export const CIRCLE_PER_STAR_R = 40;
export const INSIDE_SEARCH_RATE = 0.25; // 玩家在搜索圈內時搜尋計時倍速
export const CLEAR_REASONS = Object.freeze(['evaded', 'busted', 'wasted', 'debug', 'spray']);

// heat → 星數（最大 n 使 heat ≥ STAR_HEAT[n]）
export function starsForHeat(heat, starHeat = STAR_HEAT) {
  let n = 0;
  for (let i = 1; i < starHeat.length; i++) if (heat >= starHeat[i]) n = i;
  return n;
}

export function createWanted({ bus, config = {} } = {}) {
  const cfg = {
    heat: config.heat || HEAT,
    minStars: config.minStars || CRIME_MIN_STARS,
    starHeat: config.starHeat || STAR_HEAT,
    evadeSec: config.evadeSec || EVADE_SEC,
    maxDt: config.maxDt ?? MAX_DT,
    unwitnessedMult: config.unwitnessedMult ?? UNWITNESSED_MULT,
    searchAfterFrac: config.searchAfterFrac ?? SEARCH_AFTER_FRAC,
    circleBaseR: config.circleBaseR ?? CIRCLE_BASE_R,
    circlePerStarR: config.circlePerStarR ?? CIRCLE_PER_STAR_R,
    insideSearchRate: config.insideSearchRate ?? INSIDE_SEARCH_RATE,
  };
  const maxStars = cfg.starHeat.length - 1;
  const emit = (name, payload) => {
    if (bus) bus.emit(name, payload);
  };

  let heat = 0;
  let stars = 0;
  let state = 'clear';
  let flashing = false;
  let lastKnown = null; // {x, z} | null
  let unseenTimer = 0; // active 中連續 unseen 秒數
  let searchTimer = 0; // searching 中累計的搜尋進度秒數（圈內打折）

  function setState(next) {
    if (next === state) return;
    const prev = state;
    state = next;
    flashing = next === 'searching';
    emit('wanted:state', { state, prev });
  }

  function setStarsValue(next, reason) {
    if (next === stars) return;
    const prev = stars;
    stars = next;
    emit('wanted:change', { stars, prev, heat, reason });
  }

  function circleR() {
    return cfg.circleBaseR + cfg.circlePerStarR * stars;
  }

  function clear(reason = 'debug') {
    const prevStars = stars;
    heat = 0;
    stars = 0;
    lastKnown = null;
    unseenTimer = 0;
    searchTimer = 0;
    if (prevStars !== 0) emit('wanted:change', { stars: 0, prev: prevStars, heat: 0, reason });
    setState('clear');
    flashing = false;
    emit('wanted:cleared', { reason });
  }

  // 由 clear 進入通緝：直接 active（等 update 的 seen / unseen 推進）
  function ensureActive() {
    if (stars >= 1 && state === 'clear') {
      unseenTimer = 0;
      searchTimer = 0;
      setState('active');
    }
  }

  function report(crime, { x, z, witnessed = true } = {}) {
    const base = cfg.heat[crime];
    if (typeof base !== 'number') return; // 未知犯行忽略
    const hasPos = Number.isFinite(x) && Number.isFinite(z);
    heat += witnessed ? base : base * cfg.unwitnessedMult;
    let next = Math.max(stars, Math.min(maxStars, starsForHeat(heat, cfg.starHeat)));
    if (!witnessed) next = Math.max(next, UNWITNESSED_MIN_STARS);
    // 保底星數（CRIME_MIN_STARS，不論 witnessed）：只抬星數、heat 照 HEAT 累加（星數只升不降，之後的犯行不會掉回去）
    const floor = cfg.minStars[crime];
    if (typeof floor === 'number' && floor > 0) next = Math.max(next, Math.min(maxStars, Math.floor(floor)));
    // 被看見犯行 → 位置確定；路人報案僅在還沒有位置時採用（讓搜索圈有圓心）；有保底星數的犯行（如 robbery 店員報警）報案位置可靠，一律更新
    if (hasPos && (witnessed || !lastKnown || (typeof floor === 'number' && floor > 0))) lastKnown = { x, z };
    setStarsValue(next, crime);
    ensureActive();
    // 搜索中被警力目擊犯行 → 同 update 的 seen：回 active、計時歸零
    if (witnessed && hasPos && state === 'searching') {
      unseenTimer = 0;
      searchTimer = 0;
      setState('active');
      emit('wanted:spotted', { x, z });
    }
  }

  function update(dt, { playerX, playerZ, seen = false } = {}) {
    if (stars < 1 || state === 'clear') return;
    dt = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), cfg.maxDt) : 0;
    const hasPos = Number.isFinite(playerX) && Number.isFinite(playerZ);

    if (seen) {
      if (hasPos) lastKnown = { x: playerX, z: playerZ };
      unseenTimer = 0;
      searchTimer = 0;
      if (state === 'searching') {
        setState('active');
        if (lastKnown) emit('wanted:spotted', { x: lastKnown.x, z: lastKnown.z });
      }
      return;
    }

    const evade = cfg.evadeSec[stars];
    let carry = dt; // 本幀可用於搜尋計時的秒數（active → searching 的溢出部分延續過去）
    if (state === 'active') {
      unseenTimer += dt;
      const limit = evade * cfg.searchAfterFrac;
      if (unseenTimer < limit) return;
      carry = unseenTimer - limit;
      if (!lastKnown && hasPos) lastKnown = { x: playerX, z: playerZ };
      searchTimer = 0;
      setState('searching');
    }

    // searching：圈外全速、圈內 INSIDE_SEARCH_RATE 倍速
    let rate = 1;
    if (lastKnown && hasPos) {
      const dx = playerX - lastKnown.x;
      const dz = playerZ - lastKnown.z;
      if (dx * dx + dz * dz <= circleR() ** 2) rate = cfg.insideSearchRate;
    }
    searchTimer += carry * rate;
    if (searchTimer >= evade) clear('evaded');
  }

  function setStars(n) {
    n = Math.max(0, Math.min(maxStars, Math.floor(Number(n) || 0)));
    if (n === 0) {
      clear('debug');
      return;
    }
    heat = cfg.starHeat[n];
    setStarsValue(n, 'debug');
    ensureActive();
  }

  return {
    report,
    update,
    clear,
    setStars,
    get stars() {
      return stars;
    },
    get heat() {
      return heat;
    },
    get state() {
      return state;
    },
    get flashing() {
      return flashing;
    },
    get lastKnown() {
      return lastKnown ? { x: lastKnown.x, z: lastKnown.z } : null;
    },
    get searchCircle() {
      if (state !== 'searching' || !lastKnown) return null;
      return { x: lastKnown.x, z: lastKnown.z, r: circleR() };
    },
  };
}
