#!/usr/bin/env node
// P9 超商搶劫無頭測試：src/wanted/robbery.js（純邏輯）+ src/wanted/places.js STORES + 真 wanted.js
// 用法：node tools/test/p9-robbery.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 涵蓋：觸發距離（≤ 6 m / 步行 / 瞄準 / 準星對著店員）、aimNear 準星判定、瞄準中斷（≤ 1 s 容許、> 1 s 失敗）、離開 8 m 失敗、
//   開始即報警（witnessed=false、≥ 2 星）、失敗 toast + 至少 1 星、成功收入範圍 NT$300–800 / robbery:done payload / toast、
//   冷卻 180 s（冷卻中瞄準無反應、結束後可再搶）、店員倒地（ped:knockdown / ped:dead / clerkDown()）、wanted:cleared 無聲中止、
//   幀率無關（1/30、1/60、1/144）、dt clamp、cancel()、dispose() 取消訂閱、首次靠近提示
import { createBus } from '../../src/core/events.js';
import { createWanted } from '../../src/wanted/wanted.js';
import { STORES } from '../../src/wanted/places.js';
import {
  START_DIST,
  ABORT_DIST,
  ROB_SEC,
  AIM_GRACE_SEC,
  COOLDOWN_SEC,
  FAIL_COOLDOWN_SEC,
  LOOT_MIN,
  LOOT_MAX,
  MAX_DT,
  AIM_TOL,
  HINT_ID,
  HINT_TEXT,
  TOAST_FAIL,
  toastDone,
  aimNear,
  lootAmount,
  createRobberies,
} from '../../src/wanted/robbery.js';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// 測試用單一店：櫃檯 (0, 0)、門口 (0, 2)
const SHOP = { id: 'shop-a', name: '測試超商', x: 0, z: 2, counterX: 0, counterZ: 0, clerkYaw: 0 };
const SHOP_B = { id: 'shop-b', name: '遠方超商', x: 500, z: 2, counterX: 500, counterZ: 0, clerkYaw: 0 };

// 建一個世界：真 wanted + bus 事件紀錄；ctx 由 aim 狀態組成（aimAt 只對 target 點回真）
function make({ rng = () => 0.5, wanted: w = null, stores = [SHOP, SHOP_B], config } = {}) {
  const bus = createBus();
  const log = [];
  for (const n of ['robbery:start', 'robbery:done', 'robbery:failed', 'toast', 'wanted:change']) bus.on(n, (e) => log.push([n, e]));
  const wanted = w || createWanted({ bus });
  const r = createRobberies({ bus, wanted, police: null, stores, rng, config });
  const earned = [];
  const toasts = [];
  const hints = [];
  const env = { x: 0, z: 3, onFoot: true, aiming: true, aimOk: true, hintRet: true };
  const ctx = {
    player: { x: 0, z: 0, yaw: 0 },
    onFoot: true,
    aiming: true,
    aimAt: (x, z) => env.aimOk && Math.hypot(x - env.ax, z - env.az) < 0.01,
    earn: (n) => earned.push(n),
    toast: (text) => toasts.push(text),
    showHint: (id, text) => {
      hints.push([id, text]);
      return env.hintRet;
    },
  };
  env.ax = SHOP.counterX;
  env.az = SHOP.counterZ;
  const step = (dt) => {
    ctx.player.x = env.x;
    ctx.player.z = env.z;
    ctx.onFoot = env.onFoot;
    ctx.aiming = env.aiming;
    return r.update(dt, ctx);
  };
  // 以固定 dt 推進 sec 秒（最後一幀補餘量），回傳最後一次 update 結果
  const run = (sec, dt = 1 / 60) => {
    let t = 0;
    let out = null;
    while (t < sec - 1e-9) {
      const d = Math.min(dt, sec - t);
      out = step(d);
      t += d;
    }
    return out;
  };
  return { bus, log, wanted, r, earned, toasts, hints, env, ctx, step, run, shop: () => r.stores.find((s) => s.id === SHOP.id) };
}
const ev = (log, name) => log.filter((e) => e[0] === name).map((e) => e[1]);

// ======================= 常數 / 地點 =======================
{
  check('契約常數：6 m 觸發 / 8 m 失敗 / 6 s 進度 / 1 s 容許 / 180 s 冷卻 / NT$300–800',
    START_DIST === 6 && ABORT_DIST === 8 && ROB_SEC === 6 && AIM_GRACE_SEC === 1 && COOLDOWN_SEC === 180 && LOOT_MIN === 300 && LOOT_MAX === 800 && AIM_TOL === 1.2);
  check('提示文字', HINT_ID === 'robbery' && HINT_TEXT === '拿槍瞄準店員就能搶劫超商，但會立刻被通緝！');
  check('toast 文字', TOAST_FAIL === '店員報警了！' && toastDone(512) === '搶到 NT$512，快逃！');
  check('places.js：STORES 3–4 間', STORES.length >= 3 && STORES.length <= 4, `${STORES.length}`);
  check('STORES 欄位齊全（id / name / x / z / counterX / counterZ / clerkYaw / inferred）',
    STORES.every((s) => s.id && s.name && [s.x, s.z, s.counterX, s.counterZ, s.clerkYaw].every(Number.isFinite) && typeof s.inferred === 'boolean'));
  check('STORES id 不重複、物件凍結', new Set(STORES.map((s) => s.id)).size === STORES.length && Object.isFrozen(STORES) && STORES.every(Object.isFrozen));
  check('STORES 櫃檯點 = 門口往內 2 m（±0.15）', STORES.every((s) => Math.abs(Math.hypot(s.x - s.counterX, s.z - s.counterZ) - 2) <= 0.15),
    STORES.map((s) => Math.hypot(s.x - s.counterX, s.z - s.counterZ).toFixed(2)).join(','));
  check('STORES clerkYaw 由櫃檯朝向門口（±0.1 rad）', STORES.every((s) => {
    const want = Math.atan2(s.x - s.counterX, s.z - s.counterZ);
    return Math.abs(Math.atan2(Math.sin(want - s.clerkYaw), Math.cos(want - s.clerkYaw))) <= 0.1;
  }));
  check('STORES 至少 1 間來自 osm-city.json（inferred false 且有 osmId）', STORES.some((s) => !s.inferred && Number.isFinite(s.osmId)));
  check('STORES 推測點名稱標「推測」', STORES.filter((s) => s.inferred).every((s) => s.name.includes('推測')));
  const minGap = Math.min(...STORES.flatMap((a, i) => STORES.slice(i + 1).map((b) => Math.hypot(a.x - b.x, a.z - b.z))));
  check('STORES 彼此相距 > 2 × ABORT_DIST（同時只會在一間範圍內）', minGap > 2 * ABORT_DIST, `${minGap.toFixed(0)} m`);
}

// ======================= aimNear / lootAmount =======================
{
  const o = { x: 0, y: 1.6, z: 0 };
  const d = { x: 0, y: 0, z: 1 };
  check('aimNear：正前方 5 m 的點 → true', aimNear(o, d, 0, 1.2, 5));
  check('aimNear：橫向偏 1.1 m → true、1.3 m → false', aimNear(o, d, 1.1, 1.6, 5) && !aimNear(o, d, 1.3, 1.6, 5));
  check('aimNear：點在背後 → false', !aimNear(o, d, 0, 1.6, -5));
  check('aimNear：dir 未正規化也可', aimNear(o, { x: 0, y: 0, z: 10 }, 0.5, 1.6, 20));
  check('aimNear：dir 長度 0 / 缺參數 → false', !aimNear(o, { x: 0, y: 0, z: 0 }, 0, 1.6, 5) && !aimNear(null, d, 0, 0, 1));
  check('lootAmount：rng 0 → 300、0.999999 → 800、1 夾到 800、NaN → 300', lootAmount(() => 0) === 300 && lootAmount(() => 0.999999) === 800 && lootAmount(() => 1) === 800 && lootAmount(() => NaN) === 300);
  let lo = Infinity;
  let hi = -Infinity;
  let ints = true;
  for (let i = 0; i < 2000; i++) {
    const v = lootAmount(Math.random);
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
    if (!Number.isInteger(v)) ints = false;
  }
  check('lootAmount：隨機 2000 次皆為 300–800 整數', lo >= 300 && hi <= 800 && ints, `${lo}–${hi}`);
}

// ======================= 1. 觸發距離 / 條件 =======================
{
  const w = make();
  w.env.z = 6.5;
  check('6.5 m 瞄準店員 → 不開始', w.step(1 / 60).active === false && w.shop().state === 'ready');
  w.env.z = 6;
  const r = w.step(1 / 60);
  check('6 m 瞄準店員 → 開始搶劫（active、storeId、progress 0）', r.active && r.storeId === SHOP.id && r.progress === 0 && w.shop().state === 'robbing');
  check('開始：robbery:start 事件帶店 id 與櫃檯座標', ev(w.log, 'robbery:start').length === 1 && ev(w.log, 'robbery:start')[0].storeId === SHOP.id);
}
{
  const w = make();
  w.env.onFoot = false;
  check('駕駛中（onFoot false）瞄準 → 不開始', !w.step(1 / 60).active);
  w.env.onFoot = true;
  w.env.aiming = false;
  check('未瞄準 → 不開始', !w.step(1 / 60).active);
  w.env.aiming = true;
  w.env.aimOk = false;
  check('瞄準但準星沒對著店員 → 不開始', !w.step(1 / 60).active);
  w.env.aimOk = true;
  check('三條件皆滿足 → 開始', w.step(1 / 60).active);
  const w2 = make();
  w2.ctx.aimAt = undefined;
  w2.step = ((orig) => (dt) => {
    w2.ctx.aimAt = undefined;
    return orig(dt);
  })(w2.step);
  check('ctx.aimAt 缺 → 不開始（不拋錯）', !w2.step(1 / 60).active);
}

// ======================= 2. 報警星數 =======================
{
  const w = make();
  w.step(1 / 60);
  check('開始瞬間 wanted ≥ 2 星（robbery 保底）', w.wanted.stars >= 2 && w.wanted.state === 'active', `stars ${w.wanted.stars}`);
  const ch = ev(w.log, 'wanted:change');
  check('wanted:change reason robbery', ch.length === 1 && ch[0].reason === 'robbery');
  // spy wanted：確認 report 參數
  const calls = [];
  const spy = { stars: 0, report: (c, o) => calls.push([c, o]), setStars() {} };
  const w2 = make({ wanted: spy });
  w2.step(1 / 60);
  check("report('robbery', { x, z: 櫃檯, witnessed: false }) 只呼叫一次", calls.length === 1 && calls[0][0] === 'robbery' && calls[0][1].witnessed === false && calls[0][1].x === 0 && calls[0][1].z === 0);
  w2.run(2);
  check('搶劫中不重複報警', calls.length === 1);
}

// ======================= 3. 瞄準中斷 =======================
{
  const w = make();
  w.step(1 / 60);
  w.run(2);
  w.env.aiming = false;
  w.run(0.9);
  const mid = w.step(0);
  check('停止瞄準 0.9 s：仍在搶劫中、進度暫停', mid.active && Math.abs(mid.progress - (2 / 6)) < 0.01, `progress ${mid.progress.toFixed(3)}`);
  w.env.aiming = true;
  w.run(1);
  const back = w.step(0);
  check('恢復瞄準：進度接續累加', back.active && Math.abs(back.progress - (3 / 6)) < 0.01, `progress ${back.progress.toFixed(3)}`);
  w.env.aimOk = false; // 準星移開店員也算中斷
  const r = w.run(1.05);
  check('準星移開 > 1 s → 失敗（inactive）', !r.active && w.shop().state === 'cooldown');
  check("失敗：toast「店員報警了！」、robbery:failed reason 'aim'", w.toasts.includes(TOAST_FAIL) && ev(w.log, 'robbery:failed')[0]?.reason === 'aim');
  check('失敗：不給錢、星數仍 ≥ 1', w.earned.length === 0 && w.wanted.stars >= 1);
  check('失敗：該店進入冷卻（FAIL_COOLDOWN_SEC）', Math.abs(w.shop().cooldown - (FAIL_COOLDOWN_SEC - 0)) < 1.1);
}
{
  // 失敗時 0 星（例如中途被清星）→ 立刻補到 1 星
  const set = [];
  const spy = { stars: 0, report() {}, setStars: (n) => set.push(n) };
  const w = make({ wanted: spy });
  w.step(1 / 60);
  w.env.aiming = false;
  w.run(1.2);
  check('失敗時不足 1 星 → setStars(1)', set.length === 1 && set[0] === 1);
}
{
  // 下車 / 上車（onFoot false）視同停止瞄準
  const w = make();
  w.step(1 / 60);
  w.env.onFoot = false;
  check('搶劫中上車 > 1 s → 失敗', w.run(1.1).active === false && ev(w.log, 'robbery:failed')[0]?.reason === 'aim');
}

// ======================= 4. 離開 8 m =======================
{
  const w = make();
  w.step(1 / 60);
  w.env.z = 7.9;
  check('搶劫中退到 7.9 m（持續瞄準）→ 仍進行', w.run(1).active);
  w.env.z = 8.1;
  const r = w.step(1 / 60);
  check("離開 8 m → 立刻失敗、robbery:failed reason 'distance'、toast", !r.active && ev(w.log, 'robbery:failed')[0]?.reason === 'distance' && w.toasts.includes(TOAST_FAIL));
}

// ======================= 5. 成功收入範圍 =======================
{
  for (const [rv, want] of [[0, 300], [0.999999, 800], [0.5, 550]]) {
    const w = make({ rng: () => rv });
    w.step(1 / 60);
    const before = w.run(ROB_SEC - 0.1);
    const r = w.run(0.2);
    const done = ev(w.log, 'robbery:done');
    check(`rng ${rv}：6 s 進度滿 → earn(${want})、robbery:done { storeId, amount }`, before.active && !r.active && w.earned.length === 1 && w.earned[0] === want && done.length === 1 && done[0].storeId === SHOP.id && done[0].amount === want, `earned ${w.earned}`);
    check(`rng ${rv}：toast「搶到 NT$${want}，快逃！」`, w.toasts.includes(`搶到 NT$${want}，快逃！`));
  }
  const amounts = [];
  for (let i = 0; i < 200; i++) {
    const w = make({ rng: Math.random });
    w.step(1 / 60);
    w.run(ROB_SEC + 0.1);
    amounts.push(...w.earned);
  }
  check('隨機 200 次成功：每次 earn 一筆、皆在 NT$300–800', amounts.length === 200 && amounts.every((n) => n >= 300 && n <= 800 && Number.isInteger(n)));
  // ctx.toast 缺 → 改 emit 'toast'
  const w = make();
  w.ctx.toast = undefined;
  w.step(1 / 60);
  w.run(ROB_SEC + 0.1);
  check("ctx.toast 缺 → bus 'toast' 事件", ev(w.log, 'toast').some((e) => /^搶到 NT\$\d+，快逃！$/.test(e.text)));
}

// ======================= 6. 冷卻 =======================
{
  const w = make();
  w.step(1 / 60);
  w.run(ROB_SEC + 0.05);
  const s = w.shop();
  check('搶完：state cooldown、robbed true、available false', s.state === 'cooldown' && s.robbed && !s.available);
  const startsBefore = ev(w.log, 'robbery:start').length;
  w.run(COOLDOWN_SEC - 1, 0.1);
  check('冷卻中持續瞄準 179 s：不開始、不再報警', ev(w.log, 'robbery:start').length === startsBefore && w.shop().state === 'cooldown');
  w.run(1.2, 0.1);
  check('180 s 後回 ready（robbed / clerkDown 重置）', (w.shop().state === 'ready' || w.shop().state === 'robbing') && !w.shop().robbed);
  w.step(1 / 60);
  check('冷卻結束後可再搶', w.shop().state === 'robbing' && ev(w.log, 'robbery:start').length === startsBefore + 1);
  // 另一間店不受冷卻影響
  const w2 = make();
  w2.step(1 / 60);
  w2.run(ROB_SEC + 0.05);
  w2.env.x = 500;
  w2.env.ax = SHOP_B.counterX;
  w2.env.az = SHOP_B.counterZ;
  check('A 店冷卻中，B 店照樣可搶', w2.step(1 / 60).storeId === SHOP_B.id);
}

// ======================= 7. 店員倒地 =======================
{
  const w = make();
  w.bus.emit('ped:knockdown', { ped: { clerkOf: SHOP.id }, cause: 'punch', byPlayer: true, x: 0, z: 0 });
  const s = w.shop();
  check('ped:knockdown（clerkOf）→ 該店 clerkDown、進入冷卻 180 s', s.clerkDown && s.state === 'cooldown' && s.cooldown === COOLDOWN_SEC && !s.robbed);
  check('店員倒地後瞄準 → 不開始', !w.step(1 / 60).active && ev(w.log, 'robbery:start').length === 0);
  w.run(COOLDOWN_SEC, 0.1);
  check('冷卻結束 → clerkDown 重置、可搶', w.shop().clerkDown === false && w.step(1 / 60).active);
  w.bus.emit('ped:knockdown', { ped: { id: 'random-ped' } });
  check('無 clerkOf 的行人倒地 → 不影響', w.shop().state === 'robbing');
}
{
  const w = make();
  w.step(1 / 60);
  w.run(3);
  w.bus.emit('ped:dead', { ped: { clerkOf: SHOP.id }, cause: 'bullet', byPlayer: true, x: 0, z: 0 });
  const r = w.step(1 / 60);
  check("搶劫中店員被擊斃（ped:dead）→ 中止、不給錢、robbery:failed reason 'clerk'、不 toast 報警", !r.active && w.earned.length === 0 && ev(w.log, 'robbery:failed')[0]?.reason === 'clerk' && !w.toasts.includes(TOAST_FAIL));
  check('擊斃後冷卻照算 180 s', Math.abs(w.shop().cooldown - (COOLDOWN_SEC - 1 / 60)) < 1e-6 && w.shop().clerkDown);
  check('clerkDown(id) 重複呼叫回 false、未知 id 回 false', w.r.clerkDown(SHOP.id) === false && w.r.clerkDown('nope') === false);
  const w2 = make();
  check('clerkDown(id) 直接呼叫 → true、店進冷卻', w2.r.clerkDown(SHOP.id) === true && w2.shop().state === 'cooldown');
}

// ======================= 8. 幀率無關 =======================
{
  // 成功時刻（開始後累積 6 s）：各幀率誤差 ≤ 1 幀
  const doneAt = (dt) => {
    const w = make();
    let t = 0;
    w.step(dt);
    while (w.earned.length === 0 && t < 20) {
      w.step(dt);
      t += dt;
    }
    return t;
  };
  const ts = [1 / 30, 1 / 60, 1 / 144].map((dt) => [dt, doneAt(dt)]);
  check('成功時刻與幀率無關（1/30、1/60、1/144 皆 6 s ± 1 幀）', ts.every(([dt, t]) => Math.abs(t - ROB_SEC) <= dt + 1e-9), ts.map(([, t]) => t.toFixed(3)).join(' / '));
  // 中斷失敗時刻：停止瞄準後 > 1 s
  const failAt = (dt) => {
    const w = make();
    w.step(dt);
    w.env.aiming = false;
    let t = 0;
    while (w.shop().state === 'robbing' && t < 5) {
      w.step(dt);
      t += dt;
    }
    return t;
  };
  const fs = [1 / 30, 1 / 60, 1 / 144].map((dt) => [dt, failAt(dt)]);
  check('瞄準中斷失敗時刻與幀率無關（1 s ± 1 幀）', fs.every(([dt, t]) => t > AIM_GRACE_SEC - 1e-9 && t <= AIM_GRACE_SEC + dt + 1e-9), fs.map(([, t]) => t.toFixed(3)).join(' / '));
  // 冷卻：30 fps 與 144 fps 推進 179.9 s 後都還在冷卻、180.1 s 後都 ready
  const cdState = (dt, sec) => {
    const w = make();
    w.r.clerkDown(SHOP.id);
    w.env.aiming = false;
    w.run(sec, dt);
    return w.shop().state;
  };
  check('冷卻時長與幀率無關', cdState(1 / 30, 179.9) === 'cooldown' && cdState(1 / 144, 179.9) === 'cooldown' && cdState(1 / 30, 180.1) === 'ready' && cdState(1 / 144, 180.1) === 'ready');
  // dt clamp：單幀 5 s 只算 MAX_DT
  const w = make();
  w.step(1 / 60);
  const r = w.step(5);
  check(`dt clamp：單幀 5 s 只推進 ${MAX_DT} s`, r.active && Math.abs(r.progress - MAX_DT / ROB_SEC) < 1e-9);
  const r2 = w.step(NaN);
  check('dt NaN → 視為 0', r2.active && Math.abs(r2.progress - MAX_DT / ROB_SEC) < 1e-9);
}

// ======================= 9. cancel / wanted:cleared / dispose =======================
{
  const w = make();
  w.step(1 / 60);
  w.run(4);
  w.r.cancel();
  check('cancel()：進行中搶劫取消、不給錢、不 toast', w.earned.length === 0 && w.toasts.length === 0 && w.r.active === null);
  const r = w.step(0);
  check('cancel()：該店回 ready（同一幀 update 可重新開始）', r.active && w.shop().state === 'robbing');
  w.r.cancel();
  w.r.clerkDown(SHOP.id);
  w.r.cancel();
  check('cancel()：店員倒地保留（回主選單 / 繼續不重置）', w.r.stores.some((s) => s.clerkDown));
  w.r.cancel({ resetAll: true });
  check('cancel({ resetAll })：冷卻 / 店員倒地全部重置（開新局）', w.r.stores.every((s) => s.state === 'ready' && s.cooldown === 0 && !s.clerkDown && !s.robbed));
}
// 搶完 → 回主選單（cancel）→ 繼續：冷卻不得被重置，同店不能立刻再搶
{
  const w = make();
  w.step(1 / 60);
  w.run(8);
  const earned1 = w.earned.length;
  w.r.cancel();
  w.run(8);
  check('搶完後 cancel()：冷卻保留、不能立刻重複領錢', earned1 === 1 && w.earned.length === 1 && w.shop().cooldown > 0, `earned ${earned1} → ${w.earned.length} cd ${w.shop().cooldown}`);
}
// 已因別處犯行被通緝（未被看見）時搶超商：搜索圈圓心移到超商
{
  const bus = createBus();
  const wanted = createWanted({ bus });
  wanted.report('assault', { x: 500, z: 500, witnessed: false });
  wanted.report('robbery', { x: 0, z: 0, witnessed: false });
  const lk = wanted.lastKnown || (wanted.snapshot && wanted.snapshot().lastKnown);
  check('robbery 店員報警：位置更新到超商（覆蓋舊犯行點）', !!lk && Math.hypot(lk.x, lk.z) < 1, JSON.stringify(lk));
}
{
  const w = make();
  w.step(1 / 60);
  w.run(2);
  w.wanted.clear('busted');
  check("wanted:cleared（被捕）→ 搶劫無聲中止（reason 'cleared'、不 toast、不補星）", w.r.active === null && ev(w.log, 'robbery:failed')[0]?.reason === 'cleared' && !w.toasts.includes(TOAST_FAIL) && w.wanted.stars === 0);
  check('中止後不給錢、該店冷卻', w.earned.length === 0 && w.shop().state === 'cooldown');
}
{
  const w = make();
  w.r.dispose();
  w.bus.emit('ped:knockdown', { ped: { clerkOf: SHOP.id } });
  check('dispose()：取消 bus 訂閱（店員倒地不再影響）', w.shop().state === 'ready' && !w.shop().clerkDown);
}
{
  const w = make({ wanted: createWanted({ bus: null }) });
  check('update 回傳每次新物件', w.step(0) !== w.step(0));
  const r = createRobberies({ bus: null, wanted: null, stores: [SHOP] });
  check('bus / wanted 為 null 也可運作（不拋錯）', r.update(1 / 60, { player: { x: 0, z: 1 }, onFoot: true, aiming: true, aimAt: () => true }).active === true);
  check('stores 為原物件的複本（不改 places.js 凍結物件）', r.stores[0] !== SHOP && SHOP.state === undefined);
}

// ======================= 10. 首次靠近提示 =======================
{
  const w = make();
  w.env.aiming = false;
  w.env.z = 40;
  w.step(1 / 60);
  check('距門口 > 20 m：不出提示', w.hints.length === 0);
  w.env.z = 15;
  w.step(1 / 60);
  check("距門口 ≤ 20 m：showHint('robbery', 提示文字)", w.hints.length === 1 && w.hints[0][0] === HINT_ID && w.hints[0][1] === HINT_TEXT);
  w.step(1 / 60);
  check('showHint 回真值後不再呼叫', w.hints.length === 1);
  const w2 = make();
  w2.env.aiming = false;
  w2.env.hintRet = false;
  w2.step(1 / 60);
  w2.step(1 / 60);
  check('showHint 回假值（提示關閉 / 佇列忙）→ 之後再試', w2.hints.length === 2);
}

console.log(`${failed === 0 ? 'PASS' : 'FAIL'} ${failed === 0 ? passed : failed}/${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
