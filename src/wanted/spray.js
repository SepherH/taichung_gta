// 噴漆廠（Phase 8 契約，§27）：玩家駕車進店換色洗通緝。純邏輯模組，不碰 DOM / three；
// 依賴注入：bus（emit toast / spray:done；訂閱 wanted:cleared 以中止進行中的噴漆）、wanted（state / stars / clear）、
//   shops（src/wanted/places.js 的 SPRAY_SHOPS）、config（可覆寫常數 / 注入 rng）；police 參數保留給日後擴充（目前未使用）
// 呼叫端（main.js）每幀建 ctx = { player: { x, z }, vehicle, money, spend(n) → 實扣金額, refund?(n), seen? }：
//   vehicle = 玩家駕駛中的車（duck type：{ x, z, speed, isPolice, color, repaint(color), repair(), ref? }）或 null（非駕駛中）
//     ref = 實體車識別（呼叫端重用同一個 duck 物件時提供；省略時以 vehicle 物件本身識別），換車 / 下車即中止噴漆
//   money = 目前餘額（開始時只檢查 ≥ fee，不扣款）；spend(n) 在噴漆「完成時」才呼叫，須真的扣款並回傳實扣金額
//     （建議原子操作：不足就不扣、回 0）；實扣 < fee 視為失敗：已扣的部分以 refund(paid) 退回（有提供時）
//   spend 不是函式 → 不開始噴漆（console.warn 一次）；seen = 本幀是否被警力看見（wanted.state === 'active' 亦同）
// update(dt, ctx) 回傳 { active: boolean, shopId, progress }：active 為 true 的期間呼叫端負責鎖輸入、拉手煞、
//   用 progress（0→1，2 秒內）畫面淡出淡入（本檔不碰 DOM）；中止時 progress 跳到後半段對應的同一不透明度，淡入收回
// 時間一律吃呼叫端傳入的 dt（秒，clamp ≤ MAX_DT）：≥ 10 fps 時結果與幀率無關

export const TRIGGER_RADIUS = 6; // m，進店判定半徑
export const SPEED_LIMIT = 2; // m/s，車速需低於此值才算「停妥」
export const ENTER_HOLD_SEC = 1.5; // s，停妥連續時間達此值才開始噴漆
export const SPRAY_DURATION_SEC = 2; // s，噴漆過程（整合層鎖輸入 + 淡出淡入）
export const COOLDOWN_SEC = 30; // s，每間店冷卻
export const BASE_FEE = 50; // 0 星費用（換色 + 修車）
export const STAR_FEE_BASE = 100; // 有星費用基底
export const STAR_FEE_PER_STAR = 50; // 每星加成
export const MAX_DT = 0.1; // s，單幀 dt 上限

// 噴漆色盤（8 色，集中於此；換色時排除目前車色）
export const PAINT_COLORS = Object.freeze([
  '#f2f2ee', // 珍珠白
  '#1b1b1b', // 曜石黑
  '#c62828', // 烈焰紅
  '#1565c0', // 海洋藍
  '#2e7d32', // 森林綠
  '#f9a825', // 琥珀黃
  '#6a1b9a', // 皇家紫
  '#9e9e9e', // 金屬灰
]);

export const TOAST_SEEN = '警察盯著你，現在進廠會被發現！';
export const TOAST_POLICE_CAR = '警車沒辦法改色';
export const toastNoMoney = (fee) => `錢不夠，噴漆要 NT$${fee}`;
export const TOAST_DONE_STARS = '換色完成！警方失去你的蹤跡';
export const TOAST_DONE_CLEAN = '煥然一新！';
export const TOAST_ABORT = '噴漆中斷';

// heat/stars → 費用（0 星 50；有星 100 + 50 × 星數）
export function sprayFee(stars) {
  const s = Math.max(0, Math.floor(Number(stars) || 0));
  return s === 0 ? BASE_FEE : STAR_FEE_BASE + STAR_FEE_PER_STAR * s;
}

// 車色正規化成 '#rrggbb'（小寫）：number（0xc62828）/ THREE.Color 型物件（getHexString / getHex / r,g,b 0–1）/
//   字串（'#C62828'、'#c28'、'c62828'、'0xc62828'）；無法辨識回 ''（視為色盤外色）
export function normalizeColor(c) {
  const hex6 = (n) => '#' + (Math.floor(n) & 0xffffff).toString(16).padStart(6, '0');
  if (typeof c === 'number') return Number.isFinite(c) && c >= 0 ? hex6(c) : '';
  if (typeof c === 'string') {
    let t = c.trim().toLowerCase();
    if (t.startsWith('0x')) t = t.slice(2);
    else if (t.startsWith('#')) t = t.slice(1);
    if (/^[0-9a-f]{3}$/.test(t)) t = t.replace(/./g, (d) => d + d);
    return /^[0-9a-f]{6}$/.test(t) ? '#' + t : '';
  }
  if (c && typeof c === 'object') {
    try {
      if (typeof c.getHexString === 'function') return normalizeColor('#' + c.getHexString());
      if (typeof c.getHex === 'function') return normalizeColor(c.getHex());
    } catch {
      return '';
    }
    if ([c.r, c.g, c.b].every((x) => Number.isFinite(x))) {
      const to8 = (x) => Math.round(Math.min(Math.max(x, 0), 1) * 255);
      return hex6((to8(c.r) << 16) | (to8(c.g) << 8) | to8(c.b));
    }
  }
  return '';
}

// 從色盤挑一個與 current 不同的隨機色（current 省略 / 無法辨識 / 色盤外色時視為全部可選；比較前一律正規化成 #rrggbb）
export function pickPaintColor(current, rng = Math.random, palette = PAINT_COLORS) {
  const cur = normalizeColor(current);
  const pool = cur ? palette.filter((c) => normalizeColor(c) !== cur) : palette;
  const list = pool.length ? pool : palette;
  let r = Number(rng());
  if (!Number.isFinite(r)) r = 0;
  r = Math.min(Math.max(r, 0), 0.999999);
  return list[Math.floor(r * list.length)];
}

export function createSprayShops({ bus, wanted, shops = [], config = {} } = {}) {
  const cfg = {
    radius: config.radius ?? TRIGGER_RADIUS,
    speedLimit: config.speedLimit ?? SPEED_LIMIT,
    holdSec: config.holdSec ?? ENTER_HOLD_SEC,
    duration: config.duration ?? SPRAY_DURATION_SEC,
    cooldown: config.cooldown ?? COOLDOWN_SEC,
    maxDt: config.maxDt ?? MAX_DT,
    palette: config.palette || PAINT_COLORS,
    rng: config.rng || Math.random,
  };
  const r2 = cfg.radius * cfg.radius;

  const emit = (name, payload) => {
    if (bus) bus.emit(name, payload);
  };
  const toast = (text, seconds) => emit('toast', { text, seconds });

  // 每間店的即時狀態（shops 為外部傳入的靜態描述，複製欄位並附加計時器，不改原物件）
  const list = shops.map((s) => ({
    ...s,
    cooldown: 0, // s，剩餘冷卻
    hold: 0, // s，停妥連續時間
    rejected: null, // 本次進店已 toast 過的拒絕原因（'police' / 'seen' / 'money'；離開範圍才重置，避免每幀灌 toast）
    needExit: false, // 完成 / 中止 / 扣款失敗後須先離開範圍才可再次觸發
    spraying: false,
    aborting: false, // 已中止、正在淡入收回（結束時不扣錢、不換色、不清星）
    sprayT: 0,
    fee: 0,
    starsBefore: 0,
    vehicleRef: null, // 開始時的 duck 物件（完成時呼叫其 repaint / repair）
    vehicleKey: null, // 實體車識別（vehicle.ref ?? vehicle），換車 / 下車即中止
  }));

  let activeShop = null;
  let warnedNoSpend = false;

  // 噴漆結束（完成 / 中止 / 取消）共用的狀態重置；cooldown 只在成功完成時設定
  function resetShop(s) {
    s.spraying = false;
    s.aborting = false;
    s.sprayT = 0;
    s.vehicleRef = null;
    s.vehicleKey = null;
    s.hold = 0;
    s.rejected = null;
    if (activeShop === s) activeShop = null;
  }

  // 中止：progress 跳到後半段同一不透明度（fade = 2·(1−p)），之後照常推進到 duration 收回黑幕
  function abortSpray(s) {
    if (!s.spraying || s.aborting) return;
    const p = Math.min(1, s.sprayT / cfg.duration);
    const fade = p < 0.5 ? p * 2 : (1 - p) * 2;
    s.aborting = true;
    s.sprayT = Math.max(s.sprayT, cfg.duration * (1 - fade / 2));
    s.needExit = true;
    toast(TOAST_ABORT);
  }

  function finishSpray(s, ctx) {
    try {
      if (s.aborting) return; // 中止的噴漆：淡入收回完畢即結束，不扣錢、不換色、不清星
      const fee = s.fee;
      let paid = 0;
      if (typeof ctx.spend === 'function') paid = Number(ctx.spend(fee)) || 0;
      if (!(paid >= fee)) {
        // 部分扣款 / 扣款失敗：退回已扣的部分（呼叫端 spend 為原子操作時 paid 為 0），不換色不清星
        if (paid > 0 && typeof ctx.refund === 'function') ctx.refund(paid);
        toast(toastNoMoney(fee));
        s.rejected = 'money';
        return;
      }
      const v = s.vehicleRef;
      const color = pickPaintColor(v && v.color, cfg.rng, cfg.palette);
      if (v) {
        // 已扣款：換色 / 修車拋錯不得跳過清星與 spray:done（錯誤改非同步拋出，仍會出現在 console）
        try {
          if (typeof v.repaint === 'function') v.repaint(color);
          if (typeof v.repair === 'function') v.repair();
        } catch (err) {
          queueMicrotask(() => {
            throw err;
          });
        }
      }
      wanted.clear('spray');
      emit('spray:done', { shopId: s.id, fee: paid, color, starsBefore: s.starsBefore });
      toast(s.starsBefore > 0 ? TOAST_DONE_STARS : TOAST_DONE_CLEAN);
      s.cooldown = cfg.cooldown;
    } finally {
      // repaint / repair / clear 拋錯也一定重置，避免 spraying 卡住、每幀重拋
      const rejected = s.rejected;
      resetShop(s);
      s.rejected = rejected;
      s.needExit = true;
    }
  }

  function startSpray(s, vehicle, fee) {
    s.spraying = true;
    s.aborting = false;
    s.sprayT = 0;
    s.fee = fee;
    s.starsBefore = wanted.stars;
    s.vehicleRef = vehicle;
    s.vehicleKey = vehicle.ref ?? vehicle;
    s.hold = 0;
    activeShop = s;
  }

  // 被捕 / 送醫 / 其他原因清通緝：進行中的噴漆中止；'spray'（本模組）與 'evaded'（噴漆中自然擺脫）不中止
  const offCleared =
    bus && typeof bus.on === 'function'
      ? bus.on('wanted:cleared', (p) => {
          if (activeShop && (!p || (p.reason !== 'spray' && p.reason !== 'evaded'))) abortSpray(activeShop);
        })
      : null;

  // 拒絕 toast：同一原因在離開範圍前只發一次（原因改變時再發）
  const reject = (s, reason, text) => {
    if (s.rejected !== reason) {
      toast(text);
      s.rejected = reason;
    }
    s.hold = 0;
  };

  // dt：秒（clamp ≤ maxDt）；ctx 見檔頭
  // 回傳 { active, shopId, progress }：active 時呼叫端鎖輸入並依 progress（0→1）淡出淡入
  function update(dt, ctx = {}) {
    dt = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), cfg.maxDt) : 0;
    const player = ctx.player || {};
    const vehicle = ctx.vehicle || null;
    const px = Number(player.x);
    const pz = Number(player.z);
    const hasPos = Number.isFinite(px) && Number.isFinite(pz);
    const seen = !!ctx.seen || wanted.state === 'active';

    for (const s of list) {
      if (s.cooldown > 0) s.cooldown = Math.max(0, s.cooldown - dt);

      if (s.spraying) {
        // 中止條件：被看見（wanted 轉 active）、玩家已不在開始時那台車（下車 / 換車 / 車輛棄置）
        if (!s.aborting && (wanted.state === 'active' || !vehicle || (vehicle.ref ?? vehicle) !== s.vehicleKey)) abortSpray(s);
        s.sprayT += dt;
        if (s.sprayT >= cfg.duration) finishSpray(s, ctx);
        continue;
      }
      if (activeShop) continue; // 另一間店正在噴漆（理論上同時只有一間會進入此分支）

      const inRange = hasPos && (px - s.x) ** 2 + (pz - s.z) ** 2 <= r2;
      if (!inRange) {
        s.hold = 0;
        s.rejected = null;
        s.needExit = false;
        continue;
      }
      if (s.needExit) {
        s.hold = 0;
        continue;
      }
      if (!vehicle) {
        s.hold = 0;
        continue;
      }
      if (vehicle.isPolice) {
        reject(s, 'police', TOAST_POLICE_CAR);
        continue;
      }
      if (seen) {
        reject(s, 'seen', TOAST_SEEN);
        continue;
      }
      if (Math.abs(Number(vehicle.speed) || 0) >= cfg.speedLimit) {
        s.hold = 0;
        continue;
      }
      if (s.cooldown > 0) {
        s.hold = 0;
        continue;
      }
      s.hold += dt;
      if (s.hold < cfg.holdSec) continue;

      if (typeof ctx.spend !== 'function') {
        if (!warnedNoSpend) {
          console.warn('[spray] ctx.spend 不是函式：無法扣款，不開始噴漆');
          warnedNoSpend = true;
        }
        s.hold = 0;
        continue;
      }
      const fee = sprayFee(wanted.stars);
      const money = Number(ctx.money) || 0;
      if (money < fee) {
        reject(s, 'money', toastNoMoney(fee));
        continue;
      }
      startSpray(s, vehicle, fee); // 開始時只檢查餘額，完成時才扣款
    }

    // 每次回傳新物件（不重用：呼叫端可安全保留上一幀結果）
    if (!activeShop) return { active: false, shopId: null, progress: 0 };
    return { active: true, shopId: activeShop.id, progress: Math.min(1, activeShop.sprayT / cfg.duration) };
  }

  // 立即取消進行中的噴漆（回主選單 / 開新局）：不扣錢、不換色、不清星、不 toast；也清掉各店的停妥計時
  function cancel() {
    for (const s of list) {
      resetShop(s);
      s.needExit = false;
    }
    activeShop = null;
  }

  function dispose() {
    cancel();
    if (offCleared) offCleared();
  }

  return { update, cancel, shops: list, dispose };
}
