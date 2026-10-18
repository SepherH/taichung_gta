#!/usr/bin/env node
// P13 計程車副任務無頭測試：src/missions/taxi.js（純邏輯 + createCurbPedWorld / createSideJobBar 替身）+ 真 events.js
// 用法：node tools/test/p13-taxi.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 涵蓋：常數 / 目的地（七期地標車道點、去重）、開始條件（計程車 / busy / 熄火 / 翻車 / 進行中）、招客（重試間隔、距離帶、乘客消失 / 太遠重找）、
//   上車判定（6 m / 2 m/s / 必須在計程車上）、限時（路網距離 ÷ 10 + 20、routeLength 缺時直線 × 1.3）、計費（80 + 40/km）、小費（提早比例）、
//   連載加成（+10% / 趟、上限 5 階、失敗歸零）、乘客下車（超時 / 耐久掉 > 25%）不付費、結束條件（left > 10 s / wrecked / busted / wasted / quit / cancel 不 toast）、
//   收工回收乘客、幀率無關（1/30、1/60、1/144）、dt clamp、標記 / 光柱重用物件（不每幀配置）、路邊行人世界（徵用條件、招手、上車回收、remove 交還）、HUD
import { createBus } from '../../src/core/events.js';
import {
  BOARD_RADIUS,
  BOARD_MAX_SPEED,
  ARRIVE_RADIUS,
  TRIP_SPEED,
  TRIP_EXTRA_SEC,
  BASE_FARE,
  PER_KM,
  TIP_MAX_RATIO,
  STREAK_STEP,
  STREAK_MAX_STEPS,
  DAMAGE_LIMIT,
  LEFT_SEC,
  FARE_RETRY_SEC,
  FARE_LOST_DIST,
  ROUTE_FACTOR,
  MARKER_FARE,
  MARKER_DEST,
  DESTINATIONS,
  TOAST_BUSY,
  TOAST_STALLED,
  TOAST_OVERTURNED,
  WAVE_SEC,
  meterFare,
  tripLimit,
  tipFor,
  streakBonus,
  pickDestination,
  formatClock,
  createTaxi,
  createCurbPedWorld,
  createSideJobBar,
} from '../../src/missions/taxi.js';
import { RACES } from '../../src/missions/race.js';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------- 常數 / 純函式 ----------
check('規格常數：上車 6 m / < 2 m/s、限時 ÷10 m/s + 20 s、計費 80 + 40/km、下車 10 s', BOARD_RADIUS === 6 && BOARD_MAX_SPEED === 2 && TRIP_SPEED === 10 && TRIP_EXTRA_SEC === 20 && BASE_FARE === 80 && PER_KM === 40 && LEFT_SEC === 10);
{
  const names = new Set(DESTINATIONS.map((d) => d.name));
  const racePts = RACES.flatMap((r) => [r.start, ...r.checkpoints]);
  check(`目的地：${DESTINATIONS.length} 處七期地標、名稱不重複、座標取自 RACES 已驗證車道點`, DESTINATIONS.length >= 10 && names.size === DESTINATIONS.length && DESTINATIONS.every((d) => racePts.some((p) => p.name === d.name && p.x === d.x && p.z === d.z)));
  check('目的地含新光三越 / 國家歌劇院 / 臺中市政府 / 秋紅谷', ['新光三越', '國家歌劇院', '臺中市政府', '秋紅谷'].every((n) => names.has(n)));
}
check('meterFare：0 m = 80、1 km = 120、2.5 km = 180、1.26 km 四捨五入 = 130', meterFare(0) === 80 && meterFare(1000) === 120 && meterFare(2500) === 180 && meterFare(1260) === 130);
check('tripLimit：1000 m → 120 s、0 m → 20 s', near(tripLimit(1000), 120) && near(tripLimit(0), 20));
check('tipFor：剩一半時間 → 跳表 × 0.5 × 0.5；超時 / 剩 0 → 0；剩全部 → 上限', tipFor(120, 60, 120) === 30 && tipFor(120, 0, 120) === 0 && tipFor(120, -5, 120) === 0 && tipFor(120, 120, 120) === Math.floor(120 * TIP_MAX_RATIO));
check('streakBonus：第 1 趟 0、第 2 趟 +10%、第 3 趟 +20%、第 9 趟封頂 +50%', streakBonus(200, 1) === 0 && streakBonus(200, 2) === 20 && streakBonus(200, 3) === 40 && streakBonus(200, 9) === 200 * STREAK_STEP * STREAK_MAX_STEPS);
{
  const from = { x: 86, z: 16.8 };
  const all = new Set();
  for (let i = 0; i < 40; i++) {
    const d = pickDestination(() => i / 40, from);
    all.add(d.name);
    if (Math.hypot(d.x - from.x, d.z - from.z) < 250 || Math.hypot(d.x - from.x, d.z - from.z) > 1400) all.add('BAD');
  }
  check('pickDestination：只抽 250–1400 m 範圍內、rng 不同可抽到多處', !all.has('BAD') && all.size >= 3, [...all].join(','));
  const far = pickDestination(() => 0, { x: 0, z: 0 }, [{ name: 'a', x: 10, z: 0 }, { name: 'b', x: 50, z: 0 }]);
  check('pickDestination：全部不在範圍 → 取最遠者', far.name === 'b');
}
check('formatClock：61.2 s → 01:02、0 → 00:00、負值 → 00:00', formatClock(61.2) === '01:02' && formatClock(0) === '00:00' && formatClock(-3) === '00:00');

// ---------- 替身世界 ----------
function fakeWorld() {
  const fares = [];
  const w = {
    fares,
    calls: { spawn: 0, board: 0, alight: 0, remove: 0 },
    next: { x: 40, z: 0 }, // 下一位乘客位置（null = 找不到）
    spawnFare(center, rMin, rMax) {
      w.calls.spawn++;
      w.lastBand = [rMin, rMax];
      if (!w.next) return null;
      const h = { x: w.next.x, z: w.next.z, exists: true, boarded: false, removed: false };
      fares.push(h);
      return h;
    },
    state(h) {
      return { x: h.x, z: h.z, exists: h.exists && !h.removed };
    },
    board(h) {
      w.calls.board++;
      h.boarded = true;
    },
    alight(h) {
      w.calls.alight++;
      h.removed = true;
    },
    remove(h) {
      w.calls.remove++;
      h.removed = true;
    },
  };
  return w;
}
function makeTaxi(opts = {}) {
  const bus = createBus();
  const log = [];
  for (const n of ['taxi:start', 'taxi:fare', 'taxi:pickup', 'taxi:paid', 'taxi:failed', 'taxi:end']) bus.on(n, (e) => log.push([n, e]));
  const toasts = [];
  const money = { total: 0, n: 0 };
  const world = fakeWorld();
  const route = opts.route === undefined ? 1000 : opts.route;
  const dest = opts.dest || { name: '測試地標', x: 600, z: 0 };
  const taxi = createTaxi({ bus, rng: () => 0, config: { destinations: [dest], ...(opts.config || {}) } });
  const ctx = {
    player: { x: 0, z: 0 },
    inTaxi: true,
    speed: 0,
    health: 1000,
    maxHealth: 1000,
    wrecked: false,
    world,
    earn: (n) => {
      money.total += n;
      money.n++;
    },
    toast: (t) => toasts.push(t),
    routeLength: route == null ? undefined : () => route,
  };
  return { bus, log, toasts, money, world, taxi, ctx, dest };
}
const run = (t, sec, dt = 1 / 30) => {
  let last = null;
  for (let s = 0; s < sec - 1e-9; s += dt) last = t.taxi.update(dt, t.ctx);
  return last;
};
const goto = (t, x, z) => {
  t.ctx.player.x = x;
  t.ctx.player.z = z;
};
// 開始 → 招客 → 開到乘客旁上車
function boarded(opts) {
  const t = makeTaxi(opts);
  t.taxi.start(t.ctx);
  t.taxi.update(1 / 30, t.ctx);
  goto(t, 40, 3);
  t.taxi.update(1 / 30, t.ctx);
  return t;
}

// ---------- 開始條件 ----------
{
  const t = makeTaxi();
  check('canStart：不在計程車上 → notTaxi', t.taxi.canStart({ inTaxi: false }).reason === 'notTaxi');
  check('canStart：其他任務中 → busy；熄火 → stalled；翻車 → overturned', t.taxi.canStart({ inTaxi: true, busy: true }).reason === 'busy' && t.taxi.canStart({ inTaxi: true, stalled: true }).reason === 'stalled' && t.taxi.canStart({ inTaxi: true, overturned: true }).reason === 'overturned');
  check('start(busy) → toast、不開始', !t.taxi.start({ inTaxi: true, busy: true, toast: t.ctx.toast }) && t.toasts.includes(TOAST_BUSY) && !t.taxi.active);
  check('start(熄火 / 翻車) → toast、不開始', !t.taxi.start({ inTaxi: true, stalled: true, toast: t.ctx.toast }) && !t.taxi.start({ inTaxi: true, overturned: true, toast: t.ctx.toast }) && t.toasts.includes(TOAST_STALLED) && t.toasts.includes(TOAST_OVERTURNED) && !t.taxi.active);
  check('start(計程車) → phase seek、emit taxi:start', t.taxi.start(t.ctx) && t.taxi.phase === 'seek' && t.log.some((e) => e[0] === 'taxi:start'));
  check('進行中：canStart → active、start 回 false', t.taxi.canStart({ inTaxi: true }).reason === 'active' && !t.taxi.start(t.ctx));
}

// ---------- 招客 ----------
{
  const t = makeTaxi();
  t.world.next = null;
  t.taxi.start(t.ctx);
  t.taxi.update(1 / 30, t.ctx);
  check('第一幀即嘗試招客（距離帶 25–90 m）', t.world.calls.spawn === 1 && t.world.lastBand[0] === 25 && t.world.lastBand[1] === 90);
  run(t, 0.9);
  check(`找不到乘客：每 ${FARE_RETRY_SEC} s 才重試（錯開，不每幀查）`, t.world.calls.spawn === 1);
  run(t, 0.2);
  check('1 s 後重試', t.world.calls.spawn === 2);
  t.ctx.inTaxi = false;
  run(t, 2);
  check('不在計程車上：不招客', t.world.calls.spawn === 2);
  t.ctx.inTaxi = true;
  t.world.next = { x: 40, z: 0 };
  const snap = run(t, 1.1);
  const mk = t.taxi.markers([]);
  check(`招到乘客：emit taxi:fare、小地圖 '${MARKER_FARE}'、任務條提示停車`, t.log.some((e) => e[0] === 'taxi:fare') && mk.length === 1 && mk[0].kind === MARKER_FARE && mk[0].x === 40 && /開到招手乘客旁停車/.test(snap.text), snap.text);
  const h = t.world.fares[t.world.fares.length - 1];
  h.exists = false;
  t.taxi.update(1 / 30, t.ctx);
  check('乘客消失（被嚇跑 / 回收）→ 放掉、重找', t.taxi.fare === null || t.taxi.fare.h !== h);
  run(t, 1.2);
  const h2 = t.world.fares[t.world.fares.length - 1];
  check('重找到新乘客', h2 !== h && t.taxi.fare && t.taxi.fare.h === h2);
  goto(t, 40 + FARE_LOST_DIST + 5, 0);
  t.taxi.update(1 / 30, t.ctx);
  check(`離乘客 > ${FARE_LOST_DIST} m → world.remove 交還、重找`, h2.removed && t.world.calls.remove >= 1);
}

// ---------- 上車判定 ----------
{
  const t = makeTaxi();
  t.taxi.start(t.ctx);
  t.taxi.update(1 / 30, t.ctx);
  goto(t, 40 - BOARD_RADIUS - 0.5, 0);
  t.taxi.update(1 / 30, t.ctx);
  check('離乘客 6.5 m：不上車', t.taxi.phase === 'seek');
  goto(t, 40 - BOARD_RADIUS + 0.5, 0);
  t.ctx.speed = 2.5;
  t.taxi.update(1 / 30, t.ctx);
  check('5.5 m 但車速 2.5 m/s：不上車', t.taxi.phase === 'seek');
  t.ctx.speed = -2.5;
  t.taxi.update(1 / 30, t.ctx);
  check('倒車 2.5 m/s（取絕對值）：不上車', t.taxi.phase === 'seek');
  t.ctx.speed = 1.5;
  t.ctx.inTaxi = false;
  t.taxi.update(1 / 30, t.ctx);
  check('步行走到乘客旁：不上車', t.taxi.phase === 'seek');
  t.ctx.inTaxi = true;
  t.taxi.update(1 / 30, t.ctx);
  const pk = t.log.find((e) => e[0] === 'taxi:pickup');
  check('5.5 m、1.5 m/s、計程車上 → 上車（world.board）、phase ride、emit taxi:pickup', t.taxi.phase === 'ride' && t.world.calls.board === 1 && t.world.fares[0].boarded && !!pk);
  check('限時 = 路網距離 1000 m ÷ 10 + 20 = 120 s', pk && near(pk[1].limit, 120) && near(t.taxi.trip.limit, 120) && pk[1].dest === t.dest.name);
  const mk = t.taxi.markers([]);
  check(`載客中：小地圖只剩目的地 '${MARKER_DEST}'、光柱 = 目的地`, mk.length === 1 && mk[0].kind === MARKER_DEST && mk[0].x === t.dest.x && t.taxi.beacons().dest === t.dest);
  check('上車 toast 含目的地與限時', t.toasts.some((s) => s.includes(t.dest.name) && s.includes('120')));
}
{
  const t = boarded({ route: null });
  const straight = Math.hypot(t.dest.x - 40, t.dest.z - 3);
  check('無 routeLength：距離 = 直線 × 1.3', near(t.taxi.trip.dist, straight * ROUTE_FACTOR, 1e-6));
}

// ---------- 計費 / 小費 / 連載 ----------
{
  const t = boarded();
  run(t, 30);
  goto(t, t.dest.x - ARRIVE_RADIUS - 1, 0);
  t.taxi.update(1 / 30, t.ctx);
  check('離目的地 11 m：未到', t.taxi.phase === 'ride');
  goto(t, t.dest.x - ARRIVE_RADIUS + 1, 0);
  t.ctx.speed = 5;
  t.taxi.update(1 / 30, t.ctx);
  check('9 m 但車速 5 m/s：未到（要停車）', t.taxi.phase === 'ride');
  t.ctx.speed = 0;
  const left = t.taxi.trip.timeLeft - 1 / 30;
  t.taxi.update(1 / 30, t.ctx);
  const paid = t.log.find((e) => e[0] === 'taxi:paid');
  const meter = 80 + 40;
  const tip = Math.floor(meter * 0.5 * (left / 120));
  check(`停車送達：跳表 NT$${meter}（1 km）+ 小費（提早 ${left.toFixed(1)} s）、第 1 趟無加成`, paid && paid[1].meter === meter && paid[1].tip === tip && tip > 0 && paid[1].bonus === 0 && paid[1].total === meter + tip, JSON.stringify(paid && paid[1]));
  check('ctx.earn 一次入帳 total、下車（world.alight）、回 seek', t.money.total === meter + tip && t.money.n === 1 && t.world.calls.alight === 1 && t.taxi.phase === 'seek' && t.taxi.fares === 1 && t.taxi.earned === meter + tip);
  check('付費 toast 含車資 / 小費', t.toasts.some((s) => s.startsWith('送達！車資 NT$120') && s.includes('小費')));
  // 第 2 趟：連載加成 +10%
  t.world.next = { x: t.dest.x, z: 30 };
  run(t, 1.1);
  goto(t, t.dest.x, 27);
  t.taxi.update(1 / 30, t.ctx);
  check('第 2 位乘客上車', t.taxi.phase === 'ride');
  goto(t, t.dest.x, 0);
  const left2 = t.taxi.trip.timeLeft - 1 / 30;
  t.taxi.update(1 / 30, t.ctx);
  const paid2 = t.log.filter((e) => e[0] === 'taxi:paid')[1];
  const tip2 = Math.floor(meter * 0.5 * (left2 / 120));
  check('第 2 趟連載：加成 = round((跳表 + 小費) × 10%)、streak 2', paid2 && paid2[1].streak === 2 && paid2[1].bonus === Math.round((meter + tip2) * 0.1) && paid2[1].total === meter + tip2 + paid2[1].bonus && t.taxi.streak === 2, JSON.stringify(paid2 && paid2[1]));
}
{
  // 剛好在最後一刻送達：無小費
  const t = boarded();
  run(t, 120 - 0.5);
  goto(t, t.dest.x, 0);
  t.taxi.update(1 / 30, t.ctx);
  const paid = t.log.find((e) => e[0] === 'taxi:paid');
  check('剩 0.5 s 送達：小費 = floor(120 × 0.5 × 0.5/120) = 0', paid && paid[1].tip === 0 && paid[1].total === 120);
}

// ---------- 乘客下車不付費 ----------
{
  const t = boarded();
  const s1 = run(t, 120 - 14);
  check('剩 ≤ 15 s：任務條 urgent', s1.urgent === true && s1.timeLeft <= 15);
  run(t, 14.2);
  const f = t.log.find((e) => e[0] === 'taxi:failed');
  check('超時：乘客下車（alight）不付費、emit taxi:failed timeout、回 seek、任務繼續', f && f[1].reason === 'timeout' && t.money.total === 0 && t.world.calls.alight === 1 && t.taxi.phase === 'seek' && t.taxi.active);
  check('超時 toast', t.toasts.some((s) => s.startsWith('超時了')));
}
{
  const t = boarded();
  t.ctx.health = 1000 - DAMAGE_LIMIT * 1000 + 1;
  t.taxi.update(1 / 30, t.ctx);
  check('載客中耐久掉 249（< 25%）：乘客留在車上', t.taxi.phase === 'ride');
  t.ctx.health = 1000 - DAMAGE_LIMIT * 1000 - 1;
  t.taxi.update(1 / 30, t.ctx);
  const f = t.log.find((e) => e[0] === 'taxi:failed');
  check('耐久掉 251（> 25%）：乘客嚇到下車、不付費、damaged', f && f[1].reason === 'damaged' && t.money.total === 0 && t.taxi.phase === 'seek');
}
{
  // 失敗讓連載歸零：成功 1 趟 → 超時 → 成功 1 趟（無加成）
  const t = boarded();
  goto(t, t.dest.x, 0);
  t.taxi.update(1 / 30, t.ctx);
  t.world.next = { x: t.dest.x, z: 30 };
  run(t, 1.1);
  goto(t, t.dest.x, 27);
  t.taxi.update(1 / 30, t.ctx);
  run(t, 200);
  check('第 2 趟超時 → 連載歸零', t.taxi.streak === 0 && t.log.some((e) => e[0] === 'taxi:failed'));
  run(t, 1.1);
  goto(t, t.dest.x, 27);
  t.taxi.update(1 / 30, t.ctx);
  goto(t, t.dest.x, 0);
  t.taxi.update(1 / 30, t.ctx);
  const paid = t.log.filter((e) => e[0] === 'taxi:paid');
  check('失敗後再成功：streak 1、無加成', paid.length === 2 && paid[1][1].streak === 1 && paid[1][1].bonus === 0);
}
{
  // 未 attach 的車（health null）：不判損壞；上車時無讀數、之後才有 → 以第一個讀數為基準
  const t = makeTaxi();
  t.ctx.health = null;
  t.taxi.start(t.ctx);
  t.taxi.update(1 / 30, t.ctx);
  goto(t, 40, 3);
  t.taxi.update(1 / 30, t.ctx);
  run(t, 1);
  t.ctx.health = 500;
  t.taxi.update(1 / 30, t.ctx);
  check('耐久讀數 null → 不判損壞；第一個讀數 500 為基準', t.taxi.phase === 'ride' && t.taxi.trip.boardHealth === 500);
}

// ---------- 結束條件 ----------
{
  const t = boarded();
  t.ctx.inTaxi = false;
  run(t, LEFT_SEC - 0.2);
  check('下車 9.8 s：任務仍在', t.taxi.active);
  t.ctx.inTaxi = true;
  t.taxi.update(1 / 30, t.ctx);
  t.ctx.inTaxi = false;
  run(t, LEFT_SEC - 0.2);
  check('回車上後計時歸零：再下車 9.8 s 仍在', t.taxi.active);
  run(t, 0.4);
  const e = t.log.find((x) => x[0] === 'taxi:end');
  check('下車 > 10 s → 結束 left、乘客 world.remove、toast、標記清空', !t.taxi.active && e && e[1].reason === 'left' && t.world.fares[0].removed && t.toasts.some((s) => s.startsWith('計程車任務結束：離開計程車太久')) && t.taxi.markers([]).length === 0 && t.taxi.beacons().dest === null);
}
{
  const t = boarded();
  t.ctx.wrecked = true;
  t.taxi.update(1 / 30, t.ctx);
  check('車毀 → 結束 wrecked', !t.taxi.active && t.log.some((x) => x[0] === 'taxi:end' && x[1].reason === 'wrecked'));
}
for (const kind of ['busted', 'wasted']) {
  const t = boarded();
  t.bus.emit(`player:${kind}`, {});
  check(`player:${kind} → 結束 ${kind}（訂閱保底）、乘客回收`, !t.taxi.active && t.log.some((x) => x[0] === 'taxi:end' && x[1].reason === kind) && t.world.fares[0].removed);
  check(`end('${kind}') 重複呼叫回 false（已結束）`, t.taxi.end(kind) === false);
}
{
  const t = boarded();
  goto(t, t.dest.x, 0);
  t.taxi.update(1 / 30, t.ctx);
  const earned = t.taxi.earned;
  t.taxi.end('quit', t.ctx);
  const e = t.log.find((x) => x[0] === 'taxi:end');
  check('收工 quit：toast 統計（趟數 / 金額）、emit taxi:end', e && e[1].reason === 'quit' && e[1].fares === 1 && e[1].earned === earned && t.toasts.some((s) => s === `計程車收工｜載客 1 趟｜NT$${earned}`));
}
{
  const t = boarded();
  const nToast = t.toasts.length;
  t.taxi.cancel();
  const e = t.log.find((x) => x[0] === 'taxi:end');
  check('cancel()：無聲（不 toast）、仍 emit taxi:end cancel、乘客回收', !t.taxi.active && e && e[1].reason === 'cancel' && t.toasts.length === nToast && t.world.fares[0].removed);
  const s = t.taxi.update(1 / 30, t.ctx);
  check('cancel 後 snapshot：inactive、text null', !s.active && s.text === null);
  t.taxi.dispose();
  t.taxi.start(t.ctx);
  t.bus.emit('player:busted', {});
  check('dispose 後取消訂閱 player:busted', t.taxi.active);
}

// ---------- 幀率無關 / dt clamp ----------
{
  const res = [];
  for (const dt of [1 / 30, 1 / 60, 1 / 144]) {
    const t = boarded();
    const t0 = t.taxi.trip.timeLeft;
    run(t, 40, dt);
    goto(t, t.dest.x, 0);
    t.taxi.update(dt, t.ctx);
    const paid = t.log.find((e) => e[0] === 'taxi:paid');
    res.push({ dt, left: t0 - 40, tip: paid ? paid[1].tip : -1, total: paid ? paid[1].total : -1 });
  }
  check('幀率無關：1/30、1/60、1/144 跑 40 s 後送達 → 小費 / 總額相同', res.every((r) => r.tip === res[0].tip && r.total === res[0].total && r.tip > 0), JSON.stringify(res));
  const res2 = [];
  for (const dt of [1 / 30, 1 / 60, 1 / 144]) {
    const t = boarded();
    let n = 0;
    while (t.taxi.phase === 'ride' && n < 1e6) {
      t.taxi.update(dt, t.ctx);
      n++;
    }
    res2.push(n * dt);
  }
  check('幀率無關：超時時刻誤差 ≤ 1 幀', res2.every((s) => Math.abs(s - 120) <= 1 / 30 + 1e-6), res2.map((s) => s.toFixed(3)).join(','));
  const t = boarded();
  const before = t.taxi.trip.timeLeft;
  t.taxi.update(5, t.ctx);
  check('dt clamp：單幀 5 s 只算 0.1 s', near(before - t.taxi.trip.timeLeft, 0.1, 1e-9));
  t.taxi.update(NaN, t.ctx);
  check('dt NaN → 0', near(before - t.taxi.trip.timeLeft, 0.1, 1e-9));
}

// ---------- 不每幀配置：snapshot / 標記 / 光柱重用 ----------
{
  const t = boarded();
  const a = t.taxi.update(1 / 60, t.ctx);
  const ta = a.text;
  const b = t.taxi.update(1 / 60, t.ctx);
  const m1 = t.taxi.markers([])[0];
  const m2 = t.taxi.markers([])[0];
  check('snapshot 同一物件、同一秒內任務條字串不重建（===）', a === b && b.text === ta);
  check('標記物件重用、beacons() 同一物件', m1 === m2 && t.taxi.beacons() === t.taxi.beacons());
  run(t, 1.01, 1 / 60);
  check('跨整秒才重建任務條文字', t.taxi.snapshot().text !== ta && /^計程車｜前往 測試地標｜剩 01:5\d｜連載 0｜NT\$0$/.test(t.taxi.snapshot().text), t.taxi.snapshot().text);
}

// ---------- 路邊行人世界（替身 traffic / combat）----------
function fakeTraffic() {
  const peds = [];
  const recycled = [];
  const mkPed = (id, x, z, extra = {}) => {
    const citizen = { id: `c${id}`, gang: null };
    const p = { alive: true, actor: { id }, citizen, x, z, state: 'walk', pendingFrom: null, brain: { override: null, state: 'wander' }, anim: { gestures: [], playGesture(n) { this.gestures.push(n); return 1; } }, ...extra };
    peds.push(p);
    return p;
  };
  return {
    peds,
    recycled,
    mkPed,
    _recyclePed(c) {
      recycled.push(c);
      const i = peds.findIndex((p) => p.citizen === c);
      if (i >= 0) peds.splice(i, 1);
    },
  };
}
{
  const tr = fakeTraffic();
  const combatState = new Map();
  const combat = { stateOf: (a) => combatState.get(a.id) || 'normal' };
  const pl = { x: 0, z: 0 };
  const w = createCurbPedWorld({ traffic: tr, combat, rng: () => 0, getPlayer: () => pl });
  tr.mkPed(1, 10, 0); // 太近
  tr.mkPed(2, 200, 0); // 太遠
  tr.mkPed(3, 50, 0, { state: 'flee' }); // 非 walk
  const g = tr.mkPed(4, 55, 0);
  g.citizen.gang = 'g1'; // 幫派
  const o = tr.mkPed(5, 60, 0);
  o.brain.override = () => true; // 已被其他系統徵用
  const k = tr.mkPed(6, 62, 0);
  combatState.set(6, 'hit'); // combat 非 normal
  check('spawnFare：距離帶外 / 非漫步 / 幫派 / 已徵用 / 受擊中 → 不徵用（null）', w.spawnFare(pl, 25, 90) === null);
  const ok = tr.mkPed(7, 40, 30);
  const h = w.spawnFare(pl, 25, 90);
  check('spawnFare：徵用漫步路人、掛 brain.override', h && h.p === ok && ok.brain.override === h.drive);
  check('同一路人不重複徵用', w.spawnFare(pl, 25, 90) === null);
  const it = { moveX: 1, moveZ: 1, run: true, faceYaw: null };
  const r1 = ok.brain.override(ok.brain, 1 / 30, {}, it);
  check('override：原地站立（move 0）、面向玩家、立即揮手 wave', r1 === true && it.moveX === 0 && it.moveZ === 0 && !it.run && near(it.faceYaw, Math.atan2(-40, -30)) && ok.anim.gestures.length === 1 && ok.anim.gestures[0] === 'wave');
  for (let i = 0; i < Math.round(WAVE_SEC * 30) + 1; i++) ok.brain.override(ok.brain, 1 / 30, {}, it);
  check(`每 ${WAVE_SEC} s 再揮手一次`, ok.anim.gestures.length === 2);
  const st = w.state(h);
  check('state：位置 / exists；state 物件重用', st.exists && st.x === 40 && st.z === 30 && w.state(h) === st);
  w.board(h);
  check('board：解除 override、traffic._recyclePed（人消失於車內）、之後 state exists false', ok.brain.override === null && tr.recycled.includes(ok.citizen) && !w.state(h).exists);
  const q = tr.mkPed(8, 0, 50);
  const h2 = w.spawnFare(pl, 25, 90);
  w.remove(h2);
  check('remove：解除 override（路人繼續走）、不回收', q.brain.override === null && !tr.recycled.includes(q.citizen) && !w.state(h2).exists);
  q.state = 'flee'; // 交還後的路人改做別的事（不再是候選）
  const z = tr.mkPed(9, 0, -50);
  const h3 = w.spawnFare(pl, 25, 90);
  z.citizen = { id: 'other' }; // 骨架回池換人
  check('骨架換人（citizen 不同）→ state exists false、override 自行放手', !w.state(h3).exists && z.brain.override(z.brain, 1 / 30, {}, {}) === false);
  w.dispose();
  check('dispose：全部交還', w.live.size === 0);
  const spawned = [];
  const w2 = createCurbPedWorld({ traffic: tr, combat, spawnWalker: (at) => spawned.push(at) });
  tr.mkPed(10, 30, 0);
  const h4 = w2.spawnFare(pl, 25, 90);
  w2.alight(h4, { x: 1, z: 2 });
  check('alight：有 spawnWalker 才在下車點生成路人', spawned.length === 1 && spawned[0].x === 1);
}
{
  // 整合：taxi + curbPedWorld 真實路徑（招手 → 上車回收）
  const tr = fakeTraffic();
  const pl = { x: 0, z: 0 };
  const w = createCurbPedWorld({ traffic: tr, combat: null, getPlayer: () => pl });
  const p = tr.mkPed(1, 30, 0);
  const t = makeTaxi();
  t.ctx.world = w;
  t.taxi.start(t.ctx);
  t.taxi.update(1 / 30, t.ctx);
  check('taxi × curbPedWorld：招到路人乘客', !!t.taxi.fare && p.brain.override);
  goto(t, 27, 0);
  t.taxi.update(1 / 30, t.ctx);
  check('taxi × curbPedWorld：上車 → 路人回收（消失於車內）', t.taxi.phase === 'ride' && tr.recycled.includes(p.citizen));
}

// ---------- HUD ----------
{
  const mkEl = () => {
    const el = { className: '', hidden: false, textContent: '', children: [], appendChild(c) { el.children.push(c); return c; }, remove() { el.removed = true; } };
    return el;
  };
  const body = mkEl();
  const doc = { body, createElement: mkEl };
  body.ownerDocument = doc;
  const bar = createSideJobBar({ root: body, prefix: 'taxi' });
  check('createSideJobBar：.taxi-bar 掛在 root、初始隱藏', body.children.length === 1 && bar.el.className === 'taxi-bar' && bar.el.hidden);
  bar.set('計程車｜尋找乘客中…');
  check('set(text)：顯示文字', !bar.el.hidden && bar.el.textContent === '計程車｜尋找乘客中…');
  bar.set('x', true);
  check('urgent → .taxi-urgent', bar.el.className === 'taxi-bar taxi-urgent');
  bar.set(null);
  check('set(null)：隱藏、移除 urgent', bar.el.hidden && bar.el.className === 'taxi-bar');
  bar.dispose();
  check('dispose：移除元素', bar.el.removed === true);
  const none = createSideJobBar({ doc: {} });
  none.set('x');
  check('無 document：no-op', typeof none.set === 'function');
}

// ---------- 回歸（cr-p13 審查修正）----------
{
  // 🟡3：乘客失效（traffic 回收 / 骨架換人）→ world.remove 交還 handle，curbPeds.live 不累積
  const tr = fakeTraffic();
  const w = createCurbPedWorld({ traffic: tr, combat: null, getPlayer: () => ({ x: 0, z: 0 }) });
  const t = makeTaxi();
  t.ctx.world = w;
  t.taxi.start(t.ctx);
  for (let i = 0; i < 3; i++) {
    const p = tr.mkPed(100 + i, 40, 0);
    run(t, FARE_RETRY_SEC + 0.05);
    p.alive = false; // 骨架被釋放（回池）
    p.citizen = null;
    tr.peds.splice(tr.peds.indexOf(p), 1);
    t.taxi.update(1 / 30, t.ctx);
  }
  check('乘客失效 3 次：每次 world.remove 交還、live 不洩漏（0）', w.live.size === 0 && t.taxi.fare === null && t.taxi.phase === 'seek', `live ${w.live.size}`);
}
{
  // 🟡1：徵用中的乘客 citizen.pinned（traffic 依距離 / 密度回收跳過），remove / board 解除
  const tr = fakeTraffic();
  const w = createCurbPedWorld({ traffic: tr, combat: null });
  const p = tr.mkPed(1, 40, 0);
  const h = w.spawnFare({ x: 0, z: 0 }, 25, 90);
  check('spawnFare → citizen.pinned = true', h && p.citizen.pinned === true);
  w.remove(h);
  check('remove → pinned 解除', p.citizen.pinned === false);
  p.state = 'flee'; // 交還後改做別的事（不再是候選）
  const p2 = tr.mkPed(2, 0, 40);
  const c2 = p2.citizen;
  const h2 = w.spawnFare({ x: 0, z: 0 }, 25, 90);
  w.board(h2);
  check('board → pinned 解除後才回收', h2 && c2.pinned === false && tr.recycled.includes(c2));
  const p3 = tr.mkPed(3, -40, 0);
  w.spawnFare({ x: 0, z: 0 }, 25, 90);
  w.dispose();
  check('dispose → pinned 全部解除、live 清空', p3.citizen.pinned === false && w.live.size === 0);
}
{
  // 🟡4：載客中以上車那台車為準（ctx.car）
  const A = { id: 'A' };
  const B = { id: 'B' };
  const t = makeTaxi();
  t.ctx.car = A;
  t.taxi.start(t.ctx);
  t.taxi.update(1 / 30, t.ctx);
  goto(t, 40, 3);
  t.taxi.update(1 / 30, t.ctx);
  check('上車：trip.car 記錄上車那台車', t.taxi.phase === 'ride' && t.taxi.trip.car === A);
  t.ctx.car = B;
  t.ctx.health = 700; // 另一台已受損 30% 的計程車
  run(t, 2);
  check('換開另一台受損計程車：不誤判 damaged、仍載客', t.taxi.phase === 'ride' && !t.log.some((e) => e[0] === 'taxi:failed'));
  goto(t, t.dest.x, t.dest.z);
  run(t, 0.1);
  check('換車開到目的地：不付費（視同乘客不在這台車上）', t.taxi.phase === 'ride' && t.money.total === 0);
  t.ctx.car = A;
  t.ctx.health = 1000;
  run(t, 0.1);
  check('換回上車那台 → 正常付費', t.money.total > 0 && t.taxi.phase === 'seek' && t.taxi.trip.car === null);
}
{
  const A = { id: 'A' };
  const t = makeTaxi();
  t.ctx.car = A;
  t.taxi.start(t.ctx);
  t.taxi.update(1 / 30, t.ctx);
  goto(t, 40, 3);
  t.taxi.update(1 / 30, t.ctx);
  t.ctx.car = { id: 'B' };
  run(t, LEFT_SEC + 0.2);
  check(`換車超過 ${LEFT_SEC} s → 結束 left（同下車）`, !t.taxi.active && t.log.some((e) => e[0] === 'taxi:end' && e[1].reason === 'left'));
  const t2 = makeTaxi();
  t2.taxi.start(t2.ctx);
  t2.taxi.update(1 / 30, t2.ctx);
  goto(t2, 40, 3);
  t2.taxi.update(1 / 30, t2.ctx);
  t2.ctx.health = 700;
  run(t2, 0.1);
  check('未給 ctx.car（不比對）：耐久照舊判 damaged（相容）', t2.log.some((e) => e[0] === 'taxi:failed' && e[1].reason === 'damaged'));
}

console.log(`${failed === 0 ? 'PASS' : 'FAIL'} ${failed === 0 ? passed : failed}/${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
