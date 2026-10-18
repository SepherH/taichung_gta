#!/usr/bin/env node
// P8 噴漆廠無頭測試：src/wanted/spray.js（純邏輯，不碰 DOM / three）
// 用法：node tools/test/p8-spray.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 涵蓋：觸發條件（範圍 / 車速 / 連續 1.5 s）、拒絕條件（警察看見 / 警車 / 錢不夠）各自的 toast 與「離開範圍前只一次」、
//   費用換算、冷卻、wanted.clear('spray') 呼叫序列、spray:done payload、換色與目前色不同、幀率無關（dt 切法不影響結果）
// p8-rf-fix：完成才扣款（重複扣款 / 部分扣款退回 / 無 spend）、需離開範圍、中途被看見 / 被捕 / 下車中止、
//   非字串車色（number / THREE.Color 型）、repaint 拋錯後狀態重置、cancel()、錢不夠 toast 只一次
import { createBus } from '../../src/core/events.js';
import {
  createSprayShops,
  sprayFee,
  pickPaintColor,
  PAINT_COLORS,
  TRIGGER_RADIUS,
  SPEED_LIMIT,
  ENTER_HOLD_SEC,
  SPRAY_DURATION_SEC,
  COOLDOWN_SEC,
  BASE_FEE,
  STAR_FEE_BASE,
  STAR_FEE_PER_STAR,
  TOAST_SEEN,
  TOAST_POLICE_CAR,
  toastNoMoney,
  TOAST_DONE_STARS,
  TOAST_DONE_CLEAN,
  TOAST_ABORT,
} from '../../src/wanted/spray.js';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ---------- 測試用假物件 ----------
const SHOP = { id: 'shop-a', name: '測試噴漆廠', x: 100, z: 200, yaw: 0, inferred: true };

function makeWanted(stars = 0) {
  const clearCalls = [];
  return {
    stars,
    state: 'clear',
    clear(reason) {
      clearCalls.push(reason);
      this.stars = 0;
      this.state = 'clear';
    },
    _clearCalls: clearCalls,
  };
}

function makeVehicle({ x = 100, z = 200, speed = 0, isPolice = false, color = '#f2f2ee' } = {}) {
  const repaintCalls = [];
  let repairCalls = 0;
  const v = {
    x,
    z,
    speed,
    isPolice,
    color,
    repaint(c) {
      repaintCalls.push(c);
      v.color = c;
    },
    repair() {
      repairCalls++;
    },
    get repairCalls() {
      return repairCalls;
    },
    repaintCalls,
  };
  return v;
}

function makeCtx(overrides = {}) {
  let money = overrides.money ?? 1000;
  const spendCalls = [];
  const ctx = {
    player: overrides.player || { x: 100, z: 200 },
    vehicle: overrides.vehicle ?? null,
    get money() {
      return money;
    },
    set money(v) {
      money = v;
    },
    spend(n) {
      spendCalls.push(n);
      if (money < n) return 0;
      money -= n;
      return n;
    },
    seen: overrides.seen ?? false,
  };
  ctx._spendCalls = spendCalls;
  return ctx;
}

function make(shops = [SHOP], wantedStars = 0) {
  const bus = createBus();
  const toasts = [];
  bus.on('toast', (p) => toasts.push(p));
  const doneEvents = [];
  bus.on('spray:done', (p) => doneEvents.push(p));
  const wanted = makeWanted(wantedStars);
  const s = createSprayShops({ bus, wanted, police: null, shops });
  return { s, bus, toasts, doneEvents, wanted };
}

// 以固定 dt 推進 sec 秒（最後一幀補餘量），每幀 cb 可改 ctx；回傳最後一次 update 的結果
function run(s, ctx, sec, dt) {
  let t = 0;
  let last = null;
  while (t < sec - 1e-12) {
    const step = Math.min(dt, sec - t);
    last = s.update(step, ctx);
    t += step;
  }
  return last;
}

// ======================= 常數 =======================
{
  check('TRIGGER_RADIUS = 6', TRIGGER_RADIUS === 6);
  check('SPEED_LIMIT = 2', SPEED_LIMIT === 2);
  check('ENTER_HOLD_SEC = 1.5', ENTER_HOLD_SEC === 1.5);
  check('SPRAY_DURATION_SEC = 2', SPRAY_DURATION_SEC === 2);
  check('COOLDOWN_SEC = 30', COOLDOWN_SEC === 30);
  check('PAINT_COLORS：8 色', PAINT_COLORS.length === 8);
  check('sprayFee(0) = 50', sprayFee(0) === BASE_FEE && BASE_FEE === 50);
  check('sprayFee(1) = 150', sprayFee(1) === STAR_FEE_BASE + STAR_FEE_PER_STAR * 1 && sprayFee(1) === 150);
  check('sprayFee(5) = 350', sprayFee(5) === 350);
  check('pickPaintColor 排除目前色', Array.from({ length: 50 }, (_, i) => pickPaintColor('#f2f2ee', () => i / 50)).every((c) => c !== '#f2f2ee'));
  check('pickPaintColor：目前色不在色盤時仍回色盤內的色', PAINT_COLORS.includes(pickPaintColor('#zzzzzz', () => 0.5)));
}

// ======================= 1. 觸發條件 =======================
{
  const { s, wanted } = make();
  const vehicle = makeVehicle();
  const ctx = makeCtx({ vehicle });
  // 未滿 1.5 s：不觸發
  let r = run(s, ctx, 1.4, 1 / 60);
  check('未滿 1.5 s：不觸發', !r.active);
  // 滿 1.5 s：觸發，之後 2 s 內 active
  r = run(s, ctx, 0.2, 1 / 60); // 累計 1.6 s
  check('滿 1.5 s：開始噴漆', r.active && r.shopId === SHOP.id);
  r = run(s, ctx, 1.9, 1 / 60); // 累計噴漆 1.9 s（< 2 s）
  check('噴漆中：仍 active，progress < 1', r.active && r.progress < 1 && r.progress > 0);
  r = run(s, ctx, 0.2, 1 / 60); // 噴漆滿 2 s
  check('噴漆滿 2 s：結束（active = false）', !r.active);
  check('結束：wanted.clear(\'spray\') 被呼叫', wanted._clearCalls.includes('spray'));
  check('結束：車色與原色不同', vehicle.color !== '#f2f2ee');
  check('結束：repair 被呼叫一次', vehicle.repairCalls === 1);
}

// 範圍外不觸發
{
  const { s } = make();
  const vehicle = makeVehicle();
  const ctx = makeCtx({ vehicle, player: { x: 100 + TRIGGER_RADIUS + 1, z: 200 } });
  const r = run(s, ctx, 2, 1 / 60);
  check('範圍外（> 6 m）：不觸發', !r.active);
}

// 車速過快不觸發（持續高速不累積 hold）
{
  const { s } = make();
  const vehicle = makeVehicle({ speed: 5 });
  const ctx = makeCtx({ vehicle });
  const r = run(s, ctx, 3, 1 / 60);
  check('車速 ≥ 2 m/s：不觸發', !r.active);
}

// 中途離開範圍：hold 歸零，需重新累計
{
  const { s } = make();
  const vehicle = makeVehicle();
  const ctx = makeCtx({ vehicle });
  run(s, ctx, 1.0, 1 / 60); // 累計 1.0 s（未滿）
  ctx.player = { x: 9999, z: 9999 }; // 離開範圍
  run(s, ctx, 0.1, 1 / 60);
  ctx.player = { x: 100, z: 200 }; // 回到範圍，重新算
  const r = run(s, ctx, 1.4, 1 / 60); // 只有 1.4 s，未滿 1.5 s
  check('中途離開範圍：hold 歸零，需重新累計滿 1.5 s', !r.active);
}

// ======================= 2. 拒絕條件 =======================
// 警車：拒絕且不觸發，離開範圍前只 toast 一次
{
  const { s, toasts } = make();
  const vehicle = makeVehicle({ isPolice: true });
  const ctx = makeCtx({ vehicle });
  const r = run(s, ctx, 3, 1 / 60);
  check('警車：不觸發', !r.active);
  const policeToasts = toasts.filter((t) => t.text === TOAST_POLICE_CAR);
  check('警車：只 toast 一次（離開範圍前）', policeToasts.length === 1);
}

// 被警力看見（ctx.seen）：拒絕，離開範圍前只 toast 一次
{
  const { s, toasts } = make();
  const vehicle = makeVehicle();
  const ctx = makeCtx({ vehicle, seen: true });
  const r = run(s, ctx, 3, 1 / 60);
  check('被警力看見（seen）：不觸發', !r.active);
  const seenToasts = toasts.filter((t) => t.text === TOAST_SEEN);
  check('被看見：只 toast 一次（離開範圍前）', seenToasts.length === 1);
}

// wanted.state === 'active' 等同被看見
{
  const { s, toasts, wanted } = make();
  wanted.state = 'active';
  const vehicle = makeVehicle();
  const ctx = makeCtx({ vehicle });
  const r = run(s, ctx, 3, 1 / 60);
  check("wanted.state === 'active'：視為被看見，不觸發", !r.active);
  check('對應 toast 有發出', toasts.some((t) => t.text === TOAST_SEEN));
}

// 離開範圍後重新進入：可以再 toast 一次
{
  const { s, toasts } = make();
  const vehicle = makeVehicle({ isPolice: true });
  const ctx = makeCtx({ vehicle });
  run(s, ctx, 1, 1 / 60);
  ctx.player = { x: 9999, z: 9999 };
  run(s, ctx, 0.1, 1 / 60);
  ctx.player = { x: 100, z: 200 };
  run(s, ctx, 1, 1 / 60);
  const policeToasts = toasts.filter((t) => t.text === TOAST_POLICE_CAR);
  check('離開再進入：再次 toast', policeToasts.length === 2);
}

// 錢不夠：拒絕、toast 含金額、不扣款
{
  const stars = 2;
  const { s, toasts } = make([SHOP], stars);
  const fee = sprayFee(stars);
  const vehicle = makeVehicle();
  const ctx = makeCtx({ vehicle, money: fee - 1 });
  run(s, ctx, 1.6, 1 / 60);
  check(`錢不夠：toast 含費用 NT$${fee}`, toasts.some((t) => t.text === toastNoMoney(fee)));
  check('錢不夠：未扣款', ctx._spendCalls.length === 0);
}

// ======================= 3. 費用 / spray:done payload =======================
{
  const stars = 3;
  const { s, doneEvents, wanted } = make([SHOP], stars);
  const fee = sprayFee(stars);
  const vehicle = makeVehicle();
  const ctx = makeCtx({ vehicle, money: fee });
  run(s, ctx, 1.6, 1 / 60); // 觸發
  run(s, ctx, 2.0, 1 / 60); // 跑完 2 s
  check('exactly 扣款一次 = fee', ctx._spendCalls.length === 1 && ctx._spendCalls[0] === fee);
  check('money 扣到 0', ctx.money === 0);
  const ev = doneEvents[0];
  check(
    'spray:done payload 正確',
    !!ev && ev.shopId === SHOP.id && ev.fee === fee && ev.starsBefore === stars && PAINT_COLORS.includes(ev.color),
    JSON.stringify(ev)
  );
  check('wanted.clear 在 spray:done 之後／之內已把 stars 歸 0', wanted.stars === 0);
}

// 0 星 toast 文案
{
  const { s, toasts } = make([SHOP], 0);
  const vehicle = makeVehicle();
  const ctx = makeCtx({ vehicle, money: 1000 });
  run(s, ctx, 1.6, 1 / 60);
  run(s, ctx, 2.0, 1 / 60);
  check('0 星完成 toast：煥然一新！', toasts.some((t) => t.text === TOAST_DONE_CLEAN));
  check('0 星不會顯示有星文案', !toasts.some((t) => t.text === TOAST_DONE_STARS));
}
// 有星 toast 文案
{
  const { s, toasts } = make([SHOP], 2);
  const vehicle = makeVehicle();
  const ctx = makeCtx({ vehicle, money: 1000 });
  run(s, ctx, 1.6, 1 / 60);
  run(s, ctx, 2.0, 1 / 60);
  check('有星完成 toast：警方失去你的蹤跡', toasts.some((t) => t.text === TOAST_DONE_STARS));
}

// ======================= 4. 冷卻 + 需離開範圍 =======================
{
  const { s } = make([SHOP], 0);
  const vehicle = makeVehicle();
  const ctx = makeCtx({ vehicle, money: 1000 });
  run(s, ctx, 1.6, 1 / 60);
  run(s, ctx, 2.0, 1 / 60); // 完成一次
  const r1 = run(s, ctx, 1.6, 1 / 60); // 冷卻中：不會再觸發
  check('完成後立刻重試：冷卻中不觸發', !r1.active);
  const r2 = run(s, ctx, COOLDOWN_SEC + 0.1, 1 / 60); // 冷卻已過，但沒離開範圍
  check('冷卻過後仍停在店內：未離開範圍不觸發（needExit）', !r2.active && ctx._spendCalls.length === 1);
  ctx.player = { x: 9999, z: 9999 };
  run(s, ctx, 0.1, 1 / 60);
  ctx.player = { x: 100, z: 200 };
  const r3 = run(s, ctx, 1.6, 1 / 60);
  check('冷卻過後離開再進入：可再次觸發', r3.active);
}
// 冷卻內離開再進入：仍不觸發（冷卻保留 30 s）
{
  const { s } = make([SHOP], 0);
  const ctx = makeCtx({ vehicle: makeVehicle(), money: 1000 });
  run(s, ctx, 3.6, 1 / 60); // 完成一次
  ctx.player = { x: 9999, z: 9999 };
  run(s, ctx, 0.1, 1 / 60);
  ctx.player = { x: 100, z: 200 };
  const r = run(s, ctx, 3, 1 / 60);
  check('冷卻內離開再進入：不觸發', !r.active && ctx._spendCalls.length === 1);
}

// ======================= 4b. 扣款時機（p8-rf-fix）=======================
// 重複扣款：停在店內 70 s 只扣一次、只完成一次
{
  const { s, doneEvents } = make([SHOP], 0);
  const ctx = makeCtx({ vehicle: makeVehicle(), money: 1000 });
  run(s, ctx, 70, 1 / 60);
  check('停在店內 70 s：只扣款 1 次、完成 1 次', ctx._spendCalls.length === 1 && doneEvents.length === 1 && ctx.money === 950,
    `spend ${ctx._spendCalls.length} done ${doneEvents.length} money ${ctx.money}`);
}
// 噴完才扣：開始時不扣款
{
  const { s } = make([SHOP], 0);
  const ctx = makeCtx({ vehicle: makeVehicle(), money: 1000 });
  const r = run(s, ctx, 1.6, 1 / 60);
  check('開始噴漆時尚未扣款', r.active && ctx._spendCalls.length === 0, `spend ${ctx._spendCalls.length}`);
  run(s, ctx, 2.0, 1 / 60);
  check('噴完才扣款一次', ctx._spendCalls.length === 1 && ctx.money === 950);
}
// 部分扣款：spend 只扣 1 → 失敗，refund(1) 退回、不換色不清星、toast 錢不夠
{
  const stars = 2;
  const { s, doneEvents, toasts, wanted } = make([SHOP], stars);
  wanted.state = 'searching';
  const fee = sprayFee(stars);
  const vehicle = makeVehicle();
  const ctx = makeCtx({ vehicle, money: 1000 });
  const refunds = [];
  ctx.spend = (n) => {
    ctx._spendCalls.push(n);
    ctx.money -= 1;
    return 1;
  };
  ctx.refund = (n) => {
    refunds.push(n);
    ctx.money += n;
  };
  run(s, ctx, 3.6, 1 / 60);
  check('部分扣款：不完成（無 spray:done）', doneEvents.length === 0, `done ${JSON.stringify(doneEvents)}`);
  check('部分扣款：已扣部分 refund 退回、餘額不變', refunds.length === 1 && refunds[0] === 1 && ctx.money === 1000, `refunds ${refunds} money ${ctx.money}`);
  check('部分扣款：不換色、不清星', vehicle.repaintCalls.length === 0 && wanted.stars === stars && wanted._clearCalls.length === 0);
  check('部分扣款：toast 錢不夠', toasts.some((t) => t.text === toastNoMoney(fee)));
}
// 完成時餘額已不足（原子 spend 回 0）：失敗，不換色不清星
{
  const { s, doneEvents, wanted } = make([SHOP], 1);
  const vehicle = makeVehicle();
  const ctx = makeCtx({ vehicle, money: 1000 });
  run(s, ctx, 1.6, 1 / 60);
  ctx.money = 10; // 噴漆中把錢花掉
  run(s, ctx, 2.0, 1 / 60);
  check('完成時錢不夠：不完成、不換色、不清星', doneEvents.length === 0 && vehicle.repaintCalls.length === 0 && wanted.stars === 1);
}
// spray:done.fee 記實扣值
{
  const { s, doneEvents } = make([SHOP], 0);
  const ctx = makeCtx({ vehicle: makeVehicle(), money: 1000 });
  ctx.spend = (n) => n + 0; // 實扣 = n
  run(s, ctx, 3.6, 1 / 60);
  check('spray:done.fee = 實扣值', doneEvents.length === 1 && doneEvents[0].fee === BASE_FEE);
}
// 無 spend：不開始噴漆、console.warn 一次
{
  const { s, doneEvents, wanted } = make([SHOP], 2);
  const vehicle = makeVehicle();
  const ctx = makeCtx({ vehicle, money: 1000 });
  ctx.spend = undefined;
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  let anyActive = false;
  try {
    for (let i = 0; i < 600; i++) if (s.update(1 / 60, ctx).active) anyActive = true;
  } finally {
    console.warn = origWarn;
  }
  check('無 spend：不開始噴漆、不完成、不清星', !anyActive && doneEvents.length === 0 && wanted.stars === 2 && vehicle.repaintCalls.length === 0,
    `active ${anyActive} done ${doneEvents.length}`);
  check('無 spend：console.warn 只一次', warns.length === 1, `warns ${warns.length}`);
}
// 錢不夠：停在店內 10 s 只 toast 一次
{
  const { s, toasts } = make([SHOP], 0);
  const ctx = makeCtx({ vehicle: makeVehicle(), money: 10 });
  run(s, ctx, 10, 1 / 60);
  check('錢不夠：停 10 s 只 toast 一次', toasts.filter((t) => t.text === toastNoMoney(BASE_FEE)).length === 1);
}

// ======================= 4c. 噴漆中止（p8-rf-fix）=======================
const fadeOf = (r) => (r.active ? (r.progress < 0.5 ? r.progress * 2 : (1 - r.progress) * 2) : 0);
// 中途被看見（searching → active）
{
  const { s, doneEvents, toasts, wanted } = make([SHOP], 2);
  wanted.state = 'searching';
  const vehicle = makeVehicle();
  const ctx = makeCtx({ vehicle, money: 1000 });
  run(s, ctx, 1.6, 1 / 60);
  const before = run(s, ctx, 0.5, 1 / 60); // 噴漆中途
  wanted.state = 'active';
  const after = s.update(0, ctx);
  check('中途被看見：淡入收回（不透明度連續、之後遞減）', after.active && Math.abs(fadeOf(after) - fadeOf(before)) < 0.05 && after.progress >= 0.5,
    `before ${fadeOf(before).toFixed(2)} after ${fadeOf(after).toFixed(2)}`);
  const end = run(s, ctx, 2.0, 1 / 60);
  check('中途被看見：中止（不扣錢 / 不換色 / 不清星）', !end.active && doneEvents.length === 0 && ctx._spendCalls.length === 0 &&
    vehicle.repaintCalls.length === 0 && wanted.stars === 2 && !wanted._clearCalls.includes('spray'),
    `done ${doneEvents.length} spend ${ctx._spendCalls.length} clear ${wanted._clearCalls}`);
  check('中途被看見：toast 噴漆中斷', toasts.some((t) => t.text === TOAST_ABORT));
}
// 中途被捕（wanted:cleared reason = busted）
{
  const { s, bus, doneEvents, wanted } = make([SHOP], 2);
  const vehicle = makeVehicle();
  const ctx = makeCtx({ vehicle, money: 1000 });
  run(s, ctx, 1.6, 1 / 60);
  run(s, ctx, 0.5, 1 / 60);
  wanted.clear('busted');
  bus.emit('wanted:cleared', { reason: 'busted' });
  run(s, ctx, 2.0, 1 / 60);
  check("中途被捕：不再 clear('spray')、不換色、不扣錢", JSON.stringify(wanted._clearCalls) === '["busted"]' && doneEvents.length === 0 &&
    vehicle.repaintCalls.length === 0 && ctx._spendCalls.length === 0, `clear ${JSON.stringify(wanted._clearCalls)}`);
}
// 噴漆中自然擺脫（wanted:cleared reason = evaded）：不中止，照常完成
{
  const { s, bus, doneEvents } = make([SHOP], 1);
  const vehicle = makeVehicle();
  const ctx = makeCtx({ vehicle, money: 1000 });
  run(s, ctx, 1.6, 1 / 60);
  run(s, ctx, 0.5, 1 / 60);
  bus.emit('wanted:cleared', { reason: 'evaded' });
  run(s, ctx, 2.0, 1 / 60);
  check('中途自然擺脫（evaded）：不中止、照常換色扣款', doneEvents.length === 1 && vehicle.repaintCalls.length === 1 && ctx._spendCalls.length === 1,
    `done ${doneEvents.length} repaint ${vehicle.repaintCalls.length} spend ${ctx._spendCalls.length}`);
}
// 中途下車 / 換車（ctx.vehicle = null 或 ref 不同）
{
  const { s, doneEvents } = make([SHOP], 0);
  const vehicle = makeVehicle();
  const ctx = makeCtx({ vehicle, money: 1000 });
  run(s, ctx, 1.6, 1 / 60);
  run(s, ctx, 0.5, 1 / 60);
  ctx.vehicle = null;
  run(s, ctx, 2.0, 1 / 60);
  check('中途下車：中止、不換色、不扣錢', doneEvents.length === 0 && vehicle.repaintCalls.length === 0 && ctx._spendCalls.length === 0);
}
{
  const { s, doneEvents } = make([SHOP], 0);
  const carA = {};
  const duck = makeVehicle(); // 呼叫端重用同一個 duck 物件，以 ref 區分實體車
  duck.ref = carA;
  const ctx = makeCtx({ vehicle: duck, money: 1000 });
  run(s, ctx, 1.6, 1 / 60);
  run(s, ctx, 0.5, 1 / 60);
  duck.ref = {}; // 換了一台車
  run(s, ctx, 2.0, 1 / 60);
  check('中途換車（duck 重用、ref 不同）：中止', doneEvents.length === 0 && duck.repaintCalls.length === 0);
}
// cancel()：立即取消，不扣錢、不換色、不 toast
{
  const { s, doneEvents, toasts } = make([SHOP], 0);
  const vehicle = makeVehicle();
  const ctx = makeCtx({ vehicle, money: 1000 });
  run(s, ctx, 2.1, 1 / 60);
  const nToast = toasts.length;
  if (typeof s.cancel === 'function') s.cancel();
  const r = s.update(1 / 60, { player: { x: 9999, z: 9999 }, vehicle: null, money: 0, spend: () => 0 });
  run(s, ctx, 3, 1 / 60);
  check('cancel()：立即結束、不扣錢 / 不換色 / 不 toast', !r.active && doneEvents.length === 0 && vehicle.repaintCalls.length === 0 &&
    ctx._spendCalls.length === 0 && toasts.length === nToast);
}
// dispose()：取消訂閱 wanted:cleared
{
  const { s, bus } = make([SHOP], 0);
  s.dispose();
  let threw = false;
  try {
    bus.emit('wanted:cleared', { reason: 'busted' });
  } catch {
    threw = true;
  }
  check('dispose() 後 emit wanted:cleared 不出錯', !threw);
}

// ======================= 4d. 非字串車色 / repaint 拋錯（p8-rf-fix）=======================
{
  const threeLike = { r: 0xc6 / 255, g: 0x28 / 255, b: 0x28 / 255, getHexString: () => 'c62828', getHex: () => 0xc62828, isColor: true };
  const all = (cur) => Array.from({ length: 50 }, (_, i) => pickPaintColor(cur, () => i / 50));
  let ok = true;
  let detail = '';
  for (const [name, cur] of [['number 0xc62828', 0xc62828], ['THREE.Color 型', threeLike], ['大寫字串', '#C62828'], ['0x 字串', '0xc62828']]) {
    try {
      if (all(cur).some((c) => c === '#c62828')) {
        ok = false;
        detail += `${name} 未排除；`;
      }
    } catch (e) {
      ok = false;
      detail += `${name} 拋 ${e.message}；`;
    }
  }
  check('pickPaintColor：number / THREE.Color 型 / 大寫字串皆正規化後排除目前色', ok, detail);
}
{
  const { s, doneEvents } = make([SHOP], 0);
  const vehicle = makeVehicle({ color: 0xc62828 });
  const ctx = makeCtx({ vehicle, money: 1000 });
  let err = null;
  try {
    run(s, ctx, 3.6, 1 / 60);
  } catch (e) {
    err = e;
  }
  check('車色為 number：正常完成、換成不同色', !err && doneEvents.length === 1 && doneEvents[0].color !== '#c62828', err ? err.message : '');
}
{
  const { s, doneEvents } = make([SHOP], 0);
  const vehicle = makeVehicle();
  vehicle.repaint = () => {
    throw new Error('repaint boom');
  };
  const ctx = makeCtx({ vehicle, money: 1000 });
  const asyncErrs = [];
  const onRej = (e) => asyncErrs.push(e);
  process.on('uncaughtException', onRej);
  let throws = 0;
  let last = null;
  for (let i = 0; i < 300; i++) {
    try {
      last = s.update(1 / 60, ctx);
    } catch {
      throws++;
    }
  }
  await new Promise((r) => setTimeout(r, 0));
  process.off('uncaughtException', onRej);
  check('repaint 拋錯：不同步拋出、已付費仍完成（spray:done 一次）、錯誤改非同步拋出、spraying 重置',
    throws === 0 && doneEvents.length === 1 && asyncErrs.length === 1 && last && !last.active && !s.shops[0].spraying,
    `throws ${throws} done ${doneEvents.length} async ${asyncErrs.length} spraying ${s.shops[0].spraying}`);
}

// ======================= 5. 幀率無關 =======================
{
  const resultFor = (dt) => {
    const { s } = make([SHOP], 0);
    const vehicle = makeVehicle();
    const ctx = makeCtx({ vehicle, money: 1000 });
    run(s, ctx, 1.6, dt);
    return run(s, ctx, 2.0, dt).active;
  };
  check('幀率無關：1/60 與 1/144 皆於同一段時間內完成噴漆', resultFor(1 / 60) === false && resultFor(1 / 144) === false);
}

// ======================= 6. 無 vehicle（非駕駛中）不觸發 =======================
{
  const { s } = make();
  const ctx = makeCtx({ vehicle: null });
  const r = run(s, ctx, 3, 1 / 60);
  check('非駕駛中（vehicle = null）：不觸發', !r.active);
}

console.log(`PASS ${passed}/${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
