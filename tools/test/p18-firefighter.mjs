#!/usr/bin/env node
// P18 消防車任務無頭測試：src/missions/firefighter.js（純邏輯 + 替身世界）+ 真 explosions.js（無 THREE）+ save.js + events.js + osm-city.json
// 用法：node tools/test/p18-firefighter.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 涵蓋：常數 / 純函式（firesFor / levelReward / levelLimit / chainLength / waterHit / fireFuse / waterArc）、關卡生成數量與距離（150–400 m、彼此 ≥ 30 m）、
//   限時計算（路網 + 每輛 25 s）與引信延長、水砲傷害與熄滅（douse / extinguish 事件 / 射程外不減）、過關賞金 300 + 關數 × 150、
//   失敗條件（時間到 / 起火車爆炸 / 離車 20 s / 車毀 / busted）、第 12 關獎勵只發一次並存檔、serialize / restore 與 save.js 舊存檔相容、
//   互斥（busy 不出勤）、cancel（無聲、起火車回收）、snapshot 重用；explosions.js setFuse / extinguish / setFireproof（真模組）、
//   createFireWorld（真 explosions + 替身 vehicles / dmg / traffic：點燃、引信、乘客逃跑、douse、remove）、createFireTruckDepot、消防隊座標（osm-city.json）；
//   審查修正：熄滅 / 交還後非無敵車（可受損 / 起火 / 爆炸）、未熄滅車交還不留 doused、clear 先於 remove 仍安全、hold（凍結時引信同步延後）、
//   spawn 逾時 nofire、spawnSpots 快取
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBus } from '../../src/core/events.js';
import { createExplosions, FIRE_AT, SMOKE_AT, FIREPROOF_FIRE_AT, FIREPROOF_FUSE_MULT, FUSE_MAX } from '../../src/explosions.js';
import { validateSave, defaultSave } from '../../src/save.js';
import {
  MAX_LEVEL,
  MAX_FIRES,
  SPAWN_MIN,
  SPAWN_MAX,
  FIRE_GAP,
  PER_FIRE_SEC,
  TRUCK_SPEED,
  FIRE_HP,
  DOUSE_RATE,
  WATER_RANGE,
  FUSE_GRACE,
  LEFT_SEC,
  MARKER_KIND,
  TOAST_BUSY,
  FIRE_STATION,
  FIRE_TRUCK_SPOT,
  FIRE_TRUCK_TYPE,
  TRUCK_CHECK_SEC,
  TRUCK_RESPAWN_DIST,
  SPAWN_TIMEOUT_SEC,
  SPRAY_KEY,
  DOUSED_DAMAGE,
  SPOT_CACHE_MOVE,
  FAIL_REASONS,
  firesFor,
  levelReward,
  levelLimit,
  fireFuse,
  chainLength,
  waterHit,
  waterArc,
  nozzleOf,
  isFireTruck,
  createFirefighter,
  createFireWorld,
  createFireTruckDepot,
  createWaterCannonMesh,
} from '../../src/missions/firefighter.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(`${ROOT}${p}`, 'utf8');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------- 常數 / 純函式 ----------
check('firesFor：1 + floor(關 / 3)、上限 4', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((l) => firesFor(l)).join() === '1,1,2,2,2,3,3,3,4,4,4,4' && MAX_FIRES === 4);
check('levelReward：300 + 關數 × 150', levelReward(1) === 450 && levelReward(5) === 1050 && levelReward(12) === 2100);
check('levelLimit：路網 m ÷ 10 m/s + 每輛 25 s', near(levelLimit(1, 300), 300 / TRUCK_SPEED + 25) && near(levelLimit(3, 0), 75) && PER_FIRE_SEC === 25);
check('fireFuse：限時 + 20 s', fireFuse(60) === 60 + FUSE_GRACE && FUSE_GRACE === 20);
check('常數：射程 15 m、離車 20 s、關卡 12、距離帶 150–400 m', WATER_RANGE === 15 && LEFT_SEC === 20 && MAX_LEVEL === 12 && SPAWN_MIN === 150 && SPAWN_MAX === 400);
{
  const pts = [{ x: 200, z: 0 }, { x: 100, z: 0 }];
  check('chainLength：無 routeLength → 直線貪婪鏈 × 1.4', near(chainLength({ x: 0, z: 0 }, pts), 200 * 1.4));
  check('chainLength：routeLength 路網距離（各段）', near(chainLength({ x: 0, z: 0 }, pts, (a, b) => Math.hypot(b.x - a.x, b.z - a.z) * 1.2), 240));
  check('chainLength：routeLength 失敗（null）退直線 × 1.4', near(chainLength({ x: 0, z: 0 }, pts, () => null), 280));
  check('chainLength：不修改 pts', pts[0].x === 200 && pts[1].x === 100);
}
{
  const nz = { x: 0, z: 0, dx: 0, dz: 1 };
  check('waterHit：正前方 10 m 命中', waterHit(nz, 0, 10));
  check('waterHit：射程 15 m + 車身半徑內命中、外不中', waterHit(nz, 0, 17) && !waterHit(nz, 0, 17.6));
  check('waterHit：背後 / 側面遠處不中', !waterHit(nz, 0, -5) && !waterHit(nz, 6, 5));
  check('waterHit：側偏在水柱寬度 + 車身內命中', waterHit(nz, 3, 8));
  const v = { pos: { x: 10, y: 1, z: 20 }, yaw: Math.PI / 2, spec: { length: 7.6, height: 3 } };
  const o = nozzleOf(v);
  check('nozzleOf：車頭前緣中點、朝向 = (sin yaw, cos yaw)', near(o.x, 13.8) && near(o.z, 20) && near(o.dx, 1) && near(o.dz, 0, 1e-9) && near(o.y, 4.1));
  const a0 = waterArc(0, { x: 0, y: 4, z: 0, dx: 0, dz: 1 });
  const a1 = waterArc(1, { x: 0, y: 4, z: 0, dx: 0, dz: 1 });
  check('waterArc：起點在出口、終點在射程 15 m 且下墜', near(a0.y, 4) && near(a0.z, 0) && near(a1.z, 15) && a1.y < 4);
  check('isFireTruck：type fire_truck', isFireTruck({ type: 'fire_truck' }) && !isFireTruck({ type: 'sedan' }) && !isFireTruck(null) && FIRE_TRUCK_TYPE === 'fire_truck');
}

// ---------- 替身世界 ----------
// 圓周生成點：每次依序給下一個角度、半徑 r；state 由測試直接改
function fakeWorld({ r = 250, step = 0.9 } = {}) {
  let k = 0;
  const w = {
    cars: [],
    fuses: [],
    doused: [],
    removed: [],
    spawnPoint(px, pz, rMin, rMax) {
      w.lastBand = [rMin, rMax];
      const a = k++ * step;
      return { x: px + Math.cos(a) * r, z: pz + Math.sin(a) * r, heading: 0 };
    },
    spawn(pt, opts) {
      const h = { x: pt.x, z: pt.z, exists: true, burning: true, exploded: false, occupants: opts.occupants, fuse: opts.fuse };
      w.cars.push(h);
      return h;
    },
    state: (h) => h,
    fuseOf: (h) => (h.burning ? h.fuse : null),
    setFuse(h, sec) {
      h.fuse = sec;
      w.fuses.push(sec);
    },
    douse(h) {
      h.burning = false;
      w.doused.push(h);
    },
    remove(h) {
      w.removed.push(h);
    },
  };
  return w;
}
function rig(opts = {}) {
  const bus = createBus();
  const events = [];
  for (const n of ['firefighter:start', 'firefighter:fires', 'firefighter:extinguish', 'firefighter:level', 'firefighter:complete', 'firefighter:fail']) bus.on(n, (e) => events.push([n, e]));
  const world = fakeWorld(opts);
  let rv = 0;
  const ff = createFirefighter({ bus, rng: () => (rv = (rv + 0.37) % 1) });
  const toasts = [];
  const money = [];
  const saves = [];
  const ctx = {
    player: { x: 0, z: 0 },
    inTruck: true,
    wrecked: false,
    spraying: false,
    nozzle: { x: 0, z: 0, dx: 1, dz: 0 },
    world,
    earn: (n) => money.push(n),
    toast: (t) => toasts.push(t),
    save: () => saves.push(1),
    routeLength: opts.route || null,
  };
  return { bus, events, world, ff, ctx, toasts, money, saves };
}
const run = (R, sec, dt = 0.05) => {
  let s = null;
  for (let t = 0; t < sec - 1e-9; t += dt) s = R.ff.update(dt, R.ctx);
  return s;
};
// 把噴口放到第 i 輛起火車旁、朝向它，噴到熄滅
function douseAll(R, dt = 0.05) {
  for (const s of R.ff.slots.slice(0, R.ff.fires)) {
    if (s.out) continue;
    R.ctx.nozzle.x = s.x - 8;
    R.ctx.nozzle.z = s.z;
    R.ctx.nozzle.dx = 1;
    R.ctx.nozzle.dz = 0;
    R.ctx.spraying = true;
    for (let t = 0; t < 10 && !s.out && R.ff.phase === 'fight'; t += dt) R.ff.update(dt, R.ctx);
  }
  R.ctx.spraying = false;
}
const startFight = (R) => {
  R.ff.start(R.ctx);
  run(R, 5);
};

// ---------- 開始 / 互斥 ----------
{
  const R = rig();
  check('canStart：非消防車 → notTruck', R.ff.canStart({ inTruck: false }).reason === 'notTruck');
  check('互斥：busy（其他任務 / 暴走 / 跳台）→ 不出勤 + toast', !R.ff.start({ ...R.ctx, busy: true }) && !R.ff.active && R.toasts.includes(TOAST_BUSY));
  check('canStart：熄火 / 翻覆不出勤', R.ff.canStart({ inTruck: true, stalled: true }).reason === 'stalled' && R.ff.canStart({ inTruck: true, overturned: true }).reason === 'overturned');
  check('start：消防車內 → active、第 1 關、emit start', R.ff.start(R.ctx) && R.ff.active && R.ff.level === 1 && R.events.some(([n, e]) => n === 'firefighter:start' && e.level === 1));
  check('start：進行中不可重複開始', !R.ff.start(R.ctx));
}

// ---------- 關卡生成數量與距離 ----------
{
  const R = rig();
  R.ff.start(R.ctx);
  R.ff.update(0.05, R.ctx);
  check('生成：第 1 關 1 輛、距離帶 150–400 m 傳給 world', R.ff.fires === 1 && R.world.lastBand[0] === 150 && R.world.lastBand[1] === 400);
  check('生成即開始計時（湊齊）→ phase fight、emit fires', R.ff.phase === 'fight' && R.events.some(([n, e]) => n === 'firefighter:fires' && e.fires === 1));
  const d = Math.hypot(R.world.cars[0].x, R.world.cars[0].z);
  check('起火車在玩家 150–400 m 內', d >= 150 && d <= 400, `${d.toFixed(1)}`);
  check('驚慌乘客 0..2 名', R.world.cars.every((c) => c.occupants >= 0 && c.occupants <= 2));
  // 一路過到第 9 關：數量依 firesFor
  const counts = [];
  for (let l = 1; l <= 9; l++) {
    run(R, 3);
    counts.push(R.ff.fires);
    douseAll(R);
  }
  check('各關起火車數 = firesFor（1..9 關）', counts.join() === '1,1,2,2,2,3,3,3,4', counts.join());
  run(R, 3);
  const cur = R.ff.slots.slice(0, R.ff.fires);
  let minGap = Infinity;
  for (let i = 0; i < cur.length; i++) for (let j = i + 1; j < cur.length; j++) minGap = Math.min(minGap, Math.hypot(cur[i].x - cur[j].x, cur[i].z - cur[j].z));
  check('同關起火車彼此 ≥ FIRE_GAP 30 m', minGap >= FIRE_GAP, `${minGap.toFixed(1)}`);
}
{
  // 生成點太近（同一點）→ 放棄，湊不齊時 4 s 後以 1 輛開始
  const R = rig({ step: 0 });
  R.ff.start(R.ctx);
  for (let i = 0; i < 2; i++) run(R, 3), douseAll(R); // 1、2 關（各 1 輛）
  run(R, 0.6);
  check('第 3 關要 2 輛；生成點與既有起火車太近 → 不生成', R.ff.phase === 'spawn' && R.ff.fires === 1);
  run(R, 4);
  check('湊不齊 → SPAWN_WAIT 後已有 1 輛即開始', R.ff.phase === 'fight' && R.ff.fires === 1);
}

// ---------- 限時計算 + 引信延長 ----------
{
  const R = rig({ route: (a, b) => Math.hypot(b.x - a.x, b.z - a.z) * 1.25 });
  startFight(R);
  const h = R.world.cars[0];
  const expect = (Math.hypot(h.x, h.z) * 1.25) / TRUCK_SPEED + PER_FIRE_SEC;
  check('限時 = 路網距離 ÷ 10 m/s + 25 s × 輛數', near(R.ff.limit, expect, 1e-6), `${R.ff.limit.toFixed(2)} vs ${expect.toFixed(2)}`);
  check('引信延長：setFuse(限時 + 20 s)', near(h.fuse, expect + FUSE_GRACE, 1e-6));
  const t0 = R.ff.timeLeft;
  run(R, 1);
  check('計時吃 dt（1 s）', near(t0 - R.ff.timeLeft, 1, 1e-6));
  const big = R.ff.timeLeft;
  R.ff.update(5, R.ctx);
  check('dt clamp ≤ 0.1 s', near(big - R.ff.timeLeft, 0.1, 1e-9));
}

// ---------- 水砲傷害與熄滅 ----------
{
  const R = rig();
  startFight(R);
  const s = R.ff.slots[0];
  const h0 = s.h;
  R.ctx.nozzle.x = s.x - 30; // 射程外
  R.ctx.nozzle.z = s.z;
  R.ctx.spraying = true;
  run(R, 1);
  check('射程外：火勢不減', s.hp === FIRE_HP && !s.out);
  R.ctx.nozzle.x = s.x - 8;
  R.ctx.spraying = false;
  run(R, 1);
  check('沒按射擊鍵：火勢不減', s.hp === FIRE_HP);
  R.ctx.spraying = true;
  R.ctx.inTruck = false;
  run(R, 0.5);
  check('不在消防車內：水砲無效', s.hp === FIRE_HP);
  R.ctx.inTruck = true;
  const snap = run(R, 1);
  check('命中 1 s：火勢減 DOUSE_RATE', near(s.hp, FIRE_HP - DOUSE_RATE, 1e-6) && snap.hitting && snap.hp === Math.ceil(((FIRE_HP - DOUSE_RATE) / FIRE_HP) * 100));
  check('任務條顯示火勢 %', /火勢 \d+%/.test(snap.text || ''), snap.text);
  run(R, 2);
  check('火勢歸零 → 熄滅（world.douse）、emit extinguish', R.world.doused.includes(h0) && !h0.burning && R.events.some(([n]) => n === 'firefighter:extinguish'));
}

// ---------- 過關賞金 ----------
{
  const R = rig();
  startFight(R);
  douseAll(R);
  check('全部熄滅 → 過關賞金 450（300 + 1 × 150）、emit level', R.money[0] === 450 && R.events.some(([n, e]) => n === 'firefighter:level' && e.level === 1 && e.reward === 450));
  check('過關 → 下一關、熄滅的車 world.remove', R.ff.level === 2 && R.ff.active && R.world.removed.length === 1);
  run(R, 3);
  douseAll(R);
  check('第 2 關賞金 600、earned 累計', R.money[1] === 600 && R.ff.earned === 1050 && R.ff.cleared === 2);
}

// ---------- 失敗條件 ----------
{
  const R = rig();
  startFight(R);
  R.ff.update(0.05, R.ctx);
  run(R, R.ff.timeLeft + 0.2);
  check('時間到 → fail timeout、toast、起火車回收', !R.ff.active && R.events.some(([n, e]) => n === 'firefighter:fail' && e.reason === 'timeout') && R.toasts.some((t) => t.includes('時間到')) && R.world.removed.length === 1);
}
{
  const R = rig();
  startFight(R);
  R.world.cars[0].exploded = true;
  R.ff.update(0.05, R.ctx);
  check('起火車爆炸 → fail exploded', !R.ff.active && R.events.some(([n, e]) => n === 'firefighter:fail' && e.reason === 'exploded'));
}
{
  const R = rig();
  startFight(R);
  R.world.cars[0].exists = false;
  R.ff.update(0.05, R.ctx);
  check('起火車消失 → fail exploded', !R.ff.active && R.events.some(([n, e]) => e.reason === 'exploded'));
}
{
  const R = rig();
  startFight(R);
  R.ctx.inTruck = false;
  run(R, 19.9);
  check('離開消防車 19.9 s → 仍進行', R.ff.active);
  R.ctx.inTruck = true;
  run(R, 0.1);
  R.ctx.inTruck = false;
  run(R, 19.9);
  check('回車上 → 離車計時歸零', R.ff.active);
  run(R, 0.3);
  check('離開消防車 > 20 s → fail left', !R.ff.active && R.events.some(([n, e]) => e.reason === 'left'));
}
{
  const R = rig();
  startFight(R);
  R.ctx.wrecked = true;
  R.ff.update(0.05, R.ctx);
  check('消防車毀損 → fail wrecked', !R.ff.active && R.events.some(([n, e]) => e.reason === 'wrecked'));
  const R2 = rig();
  startFight(R2);
  R2.bus.emit('player:busted', {});
  check('player:busted → fail busted', !R2.ff.active && R2.events.some(([n, e]) => e.reason === 'busted'));
  const R3 = rig();
  startFight(R3);
  R3.ff.end('quit', R3.ctx);
  check('收工（quit）→ fail quit + 收工 toast', !R3.ff.active && R3.toasts.some((t) => t.startsWith('消防車收工')));
}

{
  // spawn 階段一直沒有生成點（地圖邊緣 / 山區）→ SPAWN_TIMEOUT_SEC 後 nofire 收工、不扣錢
  const R = rig();
  let calls = 0;
  R.world.spawnPoint = () => (calls++, null);
  R.ff.start(R.ctx);
  run(R, SPAWN_TIMEOUT_SEC - 0.5);
  const midCalls = calls;
  check('spawn 0 輛未逾時：仍在火警通報中', R.ff.active && R.ff.phase === 'spawn');
  run(R, 1);
  check('spawn 逾時 0 輛 → fail nofire、toast「附近沒有火警」、不扣錢', !R.ff.active && R.events.some(([n, e]) => n === 'firefighter:fail' && e.reason === 'nofire') && R.toasts.some((t) => t.includes('附近沒有火警')) && R.money.length === 0 && FAIL_REASONS.includes('nofire') && SPAWN_TIMEOUT_SEC === 15);
  const endCalls = calls;
  run(R, 60);
  check('nofire 後不再查生成點（不無限重試）', endCalls > midCalls && calls === endCalls, `${midCalls}→${endCalls}→${calls}`);
}
{
  // hold：凍結時未熄滅車的引信延後 dt；熄滅者不動；spawn 階段無作用
  const R = rig();
  R.ff.start(R.ctx);
  R.ff.hold(0.05);
  const nFuse = R.world.fuses.length;
  check('hold：spawn 階段 / 尚無起火車不改引信', nFuse === 0);
  run(R, 5);
  const h = R.world.cars[0];
  const f0 = h.fuse;
  for (let i = 0; i < 100; i++) R.ff.hold(0.05);
  check('hold：fight 階段未熄滅車引信 + dt（凍結 5 s → +5 s）、任務計時不動', near(h.fuse, f0 + 5, 1e-6) && R.ff.active && R.ff.phase === 'fight');
  R.ff.hold(5);
  check('hold：單幀 dt 上限 MAX_DT', near(h.fuse, f0 + 5.1, 1e-6));
}
check('水砲備援鍵 SPRAY_KEY = KeyX', SPRAY_KEY === 'KeyX');

// ---------- cancel ----------
{
  const R = rig();
  startFight(R);
  const nToast = R.toasts.length;
  R.ff.cancel();
  check('cancel：結束、無 toast、起火車回收、emit fail cancel', !R.ff.active && R.toasts.length === nToast && R.world.removed.length === 1 && R.events.some(([n, e]) => e.reason === 'cancel'));
  check('cancel：idle 再 cancel 無作用', R.ff.cancel() === false);
  const snap = R.ff.update(0.05, R.ctx);
  check('cancel 後 snapshot 收起（text null、無標記）', !snap.active && snap.text === null && R.ff.markers([]).length === 0);
}

// ---------- 標記 / snapshot 重用 ----------
{
  const R = rig();
  startFight(R);
  const a = R.ff.markers([]);
  const b = R.ff.markers([]);
  check('標記 kind fire、重用物件', a.length === 1 && a[0].kind === MARKER_KIND && a[0] === b[0] && MARKER_KIND === 'fire');
  const s1 = R.ff.update(0.05, R.ctx);
  const s2 = R.ff.update(0.05, R.ctx);
  check('snapshot 重用同一物件', s1 === s2 && /第 1 關｜起火車 剩 1\/1/.test(s1.text));
  R.ff.update(0.01, R.ctx);
  const t = s2.text;
  R.ff.update(0.01, R.ctx);
  check('任務條文字只在秒數變化時重建', s2.text === t);
}

// ---------- 第 12 關：獎勵只發一次並存檔 ----------
function clearAll(R) {
  R.ff.start(R.ctx);
  for (let l = 1; l <= MAX_LEVEL; l++) {
    run(R, 3);
    douseAll(R);
  }
}
{
  const R = rig();
  let perks = 0;
  R.ctx.onFireproof = () => perks++;
  clearAll(R);
  const comp = R.events.filter(([n]) => n === 'firefighter:complete');
  check('第 12 關完成 → complete（first）、任務結束', !R.ff.active && comp.length === 1 && comp[0][1].first === true && comp[0][1].fireproof === true && R.ff.cleared === 12);
  check('防火獎勵：onFireproof 1 次、存檔 1 次', perks === 1 && R.saves.length === 1 && R.ff.fireproof);
  check('12 關賞金總和 = Σ(300 + 150L)', R.money.length === 12 && R.money.reduce((a, b) => a + b, 0) === 12 * 300 + 150 * 78);
  check('complete 不發 fail', !R.events.some(([n]) => n === 'firefighter:fail'));
  clearAll(R);
  const comp2 = R.events.filter(([n]) => n === 'firefighter:complete');
  check('再次全破：不重發獎勵（first false、不再存檔 / onFireproof）', comp2.length === 2 && comp2[1][1].first === false && perks === 1 && R.saves.length === 1);
  const rec = R.ff.serialize();
  check('serialize → { fireproof: true, best: 12 }', rec && rec.fireproof === true && rec.best === 12);
  // 存檔往返
  const v = validateSave(JSON.parse(JSON.stringify({ ...defaultSave(), firefighter: rec })));
  check('save.js validateSave 保留 firefighter', v && v.firefighter && v.firefighter.fireproof === true && v.firefighter.best === 12);
  const R2 = rig();
  R2.ff.restore(v.firefighter);
  let perks2 = 0;
  R2.ctx.onFireproof = () => perks2++;
  check('restore 往返：已解鎖', R2.ff.fireproof && R2.ff.best === 12);
  clearAll(R2);
  check('讀檔後全破：不重發獎勵', perks2 === 0 && R2.saves.length === 0);
}
{
  const old = validateSave({ version: 2, money: 500 });
  check('舊存檔（無 firefighter）：validateSave 省略、defaultSave 不含', old && !('firefighter' in old) && !('firefighter' in defaultSave()));
  const R = rig();
  R.ff.restore(old.firefighter);
  check('restore(undefined) → 未解鎖、serialize null', !R.ff.fireproof && R.ff.best === 0 && R.ff.serialize() === null);
  check('save.js：格式錯誤整欄丟棄', ['oops', 5, null, [], { fireproof: 'yes', best: 0 }].every((f) => !('firefighter' in validateSave({ version: 2, firefighter: f }))));
  const p = validateSave({ version: 2, firefighter: { fireproof: false, best: 99 } });
  check('save.js：best clamp 到 12、fireproof 非 true → false', p.firefighter && p.firefighter.best === 12 && p.firefighter.fireproof === false);
  const q = validateSave({ version: 2, firefighter: { fireproof: true, best: 3.5 } });
  check('save.js：fireproof true → best 12', q.firefighter && q.firefighter.fireproof === true && q.firefighter.best === 12);
  R.ff.restore({ fireproof: 'true', best: 4 });
  check('restore：fireproof 非 true 不解鎖、best 保留', !R.ff.fireproof && R.ff.best === 4);
  const R5 = rig();
  R5.ff.start(R5.ctx);
  run(R5, 3);
  douseAll(R5);
  R5.ff.cancel();
  check('中途結束：serialize 只記最高完成關數', JSON.stringify(R5.ff.serialize()) === '{"fireproof":false,"best":1}');
}

// ---------- explosions.js（真模組，無 THREE）----------
function blastRig() {
  const health = new Map();
  const bus = createBus();
  const fired = [];
  const exploded = [];
  bus.on('vehicle:fire', (e) => fired.push(e));
  bus.on('vehicle:explode', (e) => exploded.push(e));
  const vehicles = [];
  const ex = createExplosions({
    bus,
    config: {
      healthOf: (v) => (health.has(v) ? health.get(v) : null),
      maxHealthOf: (v) => (health.has(v) ? 1000 : null),
      addDamage: (v, n) => {
        if (!health.has(v)) return 0;
        const b = health.get(v);
        const a = Math.max(0, b - n);
        health.set(v, a);
        return b - a;
      },
      vehicles: () => vehicles,
      rng: () => 0.5,
    },
  });
  const mk = (x = 0) => {
    const v = { pos: { x, y: 0, z: 0 }, yaw: 0, spec: { length: 4.5, height: 1.45 }, mesh: null };
    health.set(v, 1000);
    vehicles.push(v);
    return v;
  };
  return { ex, health, fired, exploded, mk, vehicles };
}
{
  const B = blastRig();
  const v = B.mk();
  B.ex.damageVehicle(v, 860);
  check('explosions：扣過 FIRE_AT → 起火', B.ex.stateOf(v) === 'fire' && B.fired.length === 1 && FIRE_AT === 0.85);
  check('setFuse：起火中改剩餘引信', B.ex.setFuse(v, 90) && near(B.ex.fuseOf(v), 90));
  check('setFuse：非起火車 / 非正數 → false', !B.ex.setFuse({}, 10) && !B.ex.setFuse(v, 0));
  for (let i = 0; i < 80; i++) B.ex.update(1, 1);
  check('延長引信：80 s 後仍未爆炸', B.ex.stateOf(v) === 'fire' && B.exploded.length === 0);
  v.fireTarget = true; // 任務起火車（createFireWorld.spawn 設定）
  check('extinguish：熄火、標記 doused', B.ex.extinguish(v) && v.doused === true && B.ex.stateOf(v) !== 'fire' && B.ex.fuseOf(v) === null);
  for (let i = 0; i < 30; i++) B.ex.update(1, 1);
  check('熄滅後不爆炸', B.exploded.length === 0 && !B.ex.isWreck(v));
  B.ex.damageVehicle(v, 100);
  check('熄滅後再受損不會重新起火（仍為任務起火車 fireTarget 期間）', B.ex.stateOf(v) !== 'fire' && B.fired.length === 1);
  check('extinguish：非起火車 → false', !B.ex.extinguish(v));
  v.fireTarget = false; // 交還一般車輛（doused 殘留也不再擋）
  B.ex.damageVehicle(v, 10);
  check('doused 只在 fireTarget 期間有效：交還後再受損照一般規則起火', B.ex.stateOf(v) === 'fire' && B.fired.length === 2);
}
{
  const B = blastRig();
  const mine = B.mk();
  const other = B.mk(50);
  B.ex.setFireproof((x) => x === mine);
  B.ex.damageVehicle(mine, 900); // 90%：一般車起火，防火車不起火
  B.ex.damageVehicle(other, 900);
  check('setFireproof：防火車在 90% 不起火、一般車起火', B.ex.stateOf(mine) === 'smoke' && B.ex.stateOf(other) === 'fire' && FIREPROOF_FIRE_AT > FIRE_AT);
  B.ex.damageVehicle(mine, 80); // 98% ≥ FIREPROOF_FIRE_AT
  check('setFireproof：超過 FIREPROOF_FIRE_AT 才起火、引信 × 2', B.ex.stateOf(mine) === 'fire' && B.ex.fuseOf(mine) > FUSE_MAX && FIREPROOF_FUSE_MULT === 2, `${B.ex.fuseOf(mine)}`);
  B.ex.setFireproof(null);
  const c = B.mk(100);
  B.ex.damageVehicle(c, 900);
  check('setFireproof(null)：關閉', B.ex.stateOf(c) === 'fire' && !B.ex.fireproofActive);
}

// ---------- createFireWorld（真 explosions + 替身 vehicles / dmg / traffic）----------
function worldRig() {
  const B = blastRig();
  const list = [];
  const vehicles = {
    vehicles: list,
    adopt({ type, color, x, z, yaw }) {
      const v = { type, color, pos: { x, y: 0, z }, yaw, spec: { length: 4.5, width: 1.85, height: 1.45 }, mesh: null };
      list.push(v);
      return v;
    },
    remove(v) {
      const i = list.indexOf(v);
      if (i >= 0) list.splice(i, 1);
    },
  };
  const dmg = {
    attach: (v) => B.health.set(v, 1000),
    detach: (v) => B.health.delete(v),
    healthOf: (v) => (B.health.has(v) ? B.health.get(v) : null),
    maxHealthOf: (v) => (B.health.has(v) ? 1000 : null),
    repair: (v) => {
      if (B.health.has(v)) B.health.set(v, 1000);
    },
    addDamage: (v, n) => {
      if (!B.health.has(v)) return 0;
      const b = B.health.get(v);
      B.health.set(v, Math.max(0, b - n));
      return b - B.health.get(v);
    },
  };
  const peds = [];
  let spotCalls = 0;
  const traffic = {
    cars: [],
    spawnSpots: (px, pz, rMin, rMax, out) => {
      spotCalls++;
      out.length = 0;
      for (let a = 0; a < 6.28; a += 0.3) out.push({ x: px + Math.cos(a) * (rMin + 10), z: pz + Math.sin(a) * (rMin + 10), heading: a });
      return out;
    },
    spawnEjectedDriver: (o) => {
      const p = { ...o, pendingAttacker: { kind: 'player' }, pendingFrom: { x: 0, z: 0 } };
      peds.push(p);
      return p;
    },
  };
  const kept = [];
  const w = createFireWorld({ vehicles, dmg, explosions: B.ex, traffic, rng: () => 0.3, onKeep: (v) => kept.push(v) });
  return { B, w, list, peds, kept, health: B.health, spotCalls: () => spotCalls };
}
{
  const W = worldRig();
  const pt = W.w.spawnPoint(0, 0, 150, 400);
  check('fireWorld.spawnPoint：距離帶內車道點', pt && Math.hypot(pt.x, pt.z) >= 150 && Math.hypot(pt.x, pt.z) <= 400);
  const h = W.w.spawn(pt, { occupants: 2, fuse: 600 });
  const st = W.w.state(h);
  check('fireWorld.spawn：adopt + 點燃（explosions fire）+ 暫定引信', h && W.list.length === 1 && st.exists && st.burning && !st.exploded && near(W.B.ex.fuseOf(h.v), 600));
  check('驚慌乘客 2 名：車門外生成、不指定攻擊者（逃跑）', W.peds.length === 2 && W.peds.every((p) => p.pendingAttacker === null) && h.occupants === 2);
  W.w.setFuse(h, 75);
  check('fireWorld.setFuse → explosions 引信', near(W.B.ex.fuseOf(h.v), 75));
  W.w.douse(h);
  const st2 = W.w.state(h);
  const safeH = 1000 * (1 - DOUSED_DAMAGE);
  check('fireWorld.douse：熄滅、修到安全耐久（損壞比 < SMOKE_AT）、不 detach', !st2.burning && !st2.exploded && W.health.get(h.v) === safeH && DOUSED_DAMAGE < SMOKE_AT && h.v.doused && h.v.fireTarget);
  check('任務中熄滅後再受損：照扣耐久、不重新起火', W.B.ex.damageVehicle(h.v, 500) === 500 && W.B.ex.stateOf(h.v) !== 'fire');
  W.w.remove(h);
  check('熄滅的車交還：清 doused / fireTarget、onKeep', !h.v.doused && !h.v.fireTarget && W.kept.includes(h.v));
  const nExp = W.B.exploded.length;
  W.B.ex.damageVehicle(h.v, 10);
  check('交還後非無敵車：再受損 → 起火', W.B.ex.stateOf(h.v) === 'fire');
  for (let i = 0; i < 40; i++) W.B.ex.update(0.5, 0.5);
  check('交還後非無敵車：引信到點 → 爆炸 / 報廢（耐久 0）', W.B.exploded.length === nExp + 1 && W.B.ex.isWreck(h.v) && W.health.get(h.v) === 0);
  const h2 = W.w.spawn({ x: 300, z: 0, heading: 0 }, { occupants: 0, fuse: 2 });
  for (let i = 0; i < 30; i++) W.B.ex.update(0.1, 0.1);
  check('引信到點 → 爆炸 → state.exploded', W.w.state(h2).exploded);
  const h3 = W.w.spawn({ x: -300, z: 0, heading: 0 }, { occupants: 0, fuse: 600 });
  W.w.remove(h3);
  check('remove：仍在燒 → 熄火（不在任務外爆炸）、交還 onKeep', W.B.ex.stateOf(h3.v) !== 'fire' && W.kept.includes(h3.v) && !h3.v.fireTarget);
  check('remove 未熄滅車：不留 doused、修到安全耐久（輕撞不重燃）', !h3.v.doused && W.health.get(h3.v) === safeH && (W.B.ex.damageVehicle(h3.v, 1), W.B.ex.stateOf(h3.v) !== 'fire'));
  const nExp3 = W.B.exploded.length;
  W.B.ex.damageVehicle(h3.v, 500);
  for (let i = 0; i < 40; i++) W.B.ex.update(0.5, 0.5);
  check('remove 未熄滅車：之後重創照一般規則起火 / 爆炸', W.B.exploded.length === nExp3 + 1 && W.B.ex.isWreck(h3.v));
  // explosions.clear 先於 remove（舊順序）也安全：低耐久起火車照樣熄火修復後交還
  const h4 = W.w.spawn({ x: 0, z: 300, heading: 0 }, { occupants: 0, fuse: 600 });
  W.B.ex.clear();
  W.w.remove(h4);
  W.B.ex.damageVehicle(h4.v, 1);
  check('clear 後 remove：修到安全耐久、輕撞不重燃', W.health.get(h4.v) === safeH - 1 && W.B.ex.stateOf(h4.v) !== 'fire' && !h4.v.doused);
  W.w.dispose();
  check('dispose：全部交還', W.w.cars.size === 0 && W.kept.length === 4);
}
{
  // spawnSpots 快取：同位置 / 同距離帶重用，玩家移動 > SPOT_CACHE_MOVE 才重取
  const W = worldRig();
  for (let i = 0; i < 20; i++) W.w.spawnPoint(0, 0, 150, 400);
  const c1 = W.spotCalls();
  W.w.spawnPoint(SPOT_CACHE_MOVE - 1, 0, 150, 400);
  const c2 = W.spotCalls();
  W.w.spawnPoint(SPOT_CACHE_MOVE + 30, 0, 150, 400);
  check('spawnSpots 快取：同位置 20 次只取樣 1 次、移動超過門檻才重取', c1 === 1 && c2 === 1 && W.spotCalls() === 2 && W.w.spotQueries === 2);
}
{
  // 手機開啟（任務凍結）：hold 讓引信與任務計時同一時鐘——凍結 25 s 不會在 HUD 仍有剩餘時間時爆炸
  const W = worldRig();
  const bus = createBus();
  const fails = [];
  bus.on('firefighter:fail', (e) => fails.push(e.reason));
  const ff = createFirefighter({ bus, rng: () => 0.9 });
  const ctx = { player: { x: 0, z: 0 }, inTruck: true, spraying: false, nozzle: { x: 0, z: 0, dx: 1, dz: 0 }, world: W.w, earn: () => {}, toast: () => {} };
  ff.start(ctx);
  ff.update(0.05, ctx);
  const s = ff.slots[0];
  const left0 = ff.timeLeft;
  const fuse0 = W.B.ex.fuseOf(s.h.v);
  for (let i = 0; i < 500; i++) {
    W.B.ex.update(0.05, 0.05); // explosions 照 simDt 走
    ff.hold(0.05); // updateFirefighter frozen 分支
  }
  check('凍結 25 s：任務計時不動、引信未減（hold 同步延後）', near(ff.timeLeft, left0) && near(W.B.ex.fuseOf(s.h.v), fuse0, 1e-6) && W.B.exploded.length === 0);
  let firstEnd = null;
  for (let i = 0; i < 4000 && ff.active; i++) {
    W.B.ex.update(0.05, 0.05);
    ff.update(0.05, ctx);
    if (!ff.active) firstEnd = fails[0];
  }
  check('凍結 25 s 後：HUD 剩餘時間耗盡前不爆炸（以 timeout 結束而非 exploded）', firstEnd === 'timeout' && W.B.exploded.length === 0);
}
{
  // 任務 + 真起火車世界：滅火流程
  const W = worldRig();
  const bus = createBus();
  const ff = createFirefighter({ bus, rng: () => 0.9 });
  const ctx = { player: { x: 0, z: 0 }, inTruck: true, spraying: false, nozzle: { x: 0, z: 0, dx: 1, dz: 0 }, world: W.w, earn: () => {}, toast: () => {} };
  ff.start(ctx);
  ff.update(0.05, ctx);
  const s = ff.slots[0];
  check('整合：真世界生成 1 輛起火車、引信 = 限時 + 20', ff.phase === 'fight' && near(W.B.ex.fuseOf(s.h.v), ff.limit + FUSE_GRACE, 1e-6));
  ctx.nozzle.x = s.x - 6;
  ctx.nozzle.z = s.z;
  ctx.spraying = true;
  for (let i = 0; i < 80; i++) ff.update(0.05, ctx);
  check('整合：噴水 4 s → 熄滅、過關、explosions 不再起火', ff.level === 2 && W.B.ex.stateOf(s.h ? s.h.v : W.kept[0]) !== 'fire' && W.kept.length === 1);
}

// ---------- 消防隊停放 ----------
{
  const list = [];
  const vehicles = {
    vehicles: list,
    adopt: (o) => {
      const v = { ...o, pos: { x: o.x, y: 0, z: o.z } };
      list.push(v);
      return v;
    },
    remove: (v) => list.splice(list.indexOf(v), 1),
  };
  const hp = new Map();
  const dmg = { attach: (v) => hp.set(v, 1000), detach: (v) => hp.delete(v), healthOf: (v) => hp.get(v) ?? null };
  const dep = createFireTruckDepot({ vehicles, dmg });
  const v = dep.ensure(true);
  check('depot：開局生成 fire_truck（紅色）於停放點 + dmg.attach', v && v.type === 'fire_truck' && v.x === FIRE_TRUCK_SPOT.x && hp.has(v) && dep.isFireTruck(v) && dep.vehicle === v);
  check('depot：完好在原地 → 沿用', dep.ensure(false, { x: 0, z: 0 }) === v && list.length === 1);
  v.pos.x += 200;
  dep.update(TRUCK_CHECK_SEC, { x: FIRE_TRUCK_SPOT.x, z: FIRE_TRUCK_SPOT.z });
  check('depot：棄置遠處但玩家在停放點附近 → 不收回', list.includes(v));
  dep.update(TRUCK_CHECK_SEC, { x: FIRE_TRUCK_SPOT.x + 500, z: FIRE_TRUCK_SPOT.z + 500 });
  check('depot：玩家看不到 → 收回並補新車', !list.includes(v) && list.length === 1 && dep.vehicle && dep.vehicle !== v);
  const v2 = dep.vehicle;
  hp.set(v2, 0);
  dep.update(TRUCK_CHECK_SEC, { x: FIRE_TRUCK_SPOT.x + TRUCK_RESPAWN_DIST + 10, z: FIRE_TRUCK_SPOT.z });
  check('depot：毀損 → 殘骸交一般回收、補一台', dep.vehicle && dep.vehicle !== v2 && !v2.fireStation);
}

// ---------- 水柱網格（替身 THREE）：1 個 InstancedMesh、不每幀配置 ----------
{
  let instanced = 0;
  let created = 0;
  class V3 {
    constructor() {
      created++;
    }
    set() {
      return this;
    }
  }
  const T = {
    ConeGeometry: class {
      rotateX() {
        return this;
      }
      dispose() {}
    },
    MeshBasicMaterial: class {
      dispose() {}
    },
    InstancedMesh: class {
      constructor(g, m, n) {
        instanced++;
        this.count = n;
        this.instanceMatrix = { needsUpdate: false };
        this.set = 0;
      }
      setMatrixAt() {
        this.set++;
      }
    },
    Matrix4: class {
      compose() {
        return this;
      }
    },
    Vector3: V3,
    Quaternion: class {
      setFromEuler() {
        return this;
      }
    },
    Euler: class {
      set() {
        return this;
      }
    },
    DoubleSide: 2,
  };
  const added = [];
  const wc = createWaterCannonMesh({ THREE: T, scene: { add: (o) => added.push(o) } });
  const c0 = created;
  const nz = { x: 0, y: 3, z: 0, dx: 0, dz: 1 };
  for (let i = 0; i < 10; i++) wc.update(0.016, true, nz);
  check('水柱：1 個 InstancedMesh（1 draw call）加入場景', instanced === 1 && added.length === 1 && added[0] === wc.mesh);
  check('水柱：噴水時 visible、每幀更新實例矩陣、不新建物件', wc.mesh.visible === true && wc.mesh.set === 10 * wc.mesh.count && created === c0);
  wc.update(0.016, false, nz);
  check('水柱：停止噴水 → visible false', wc.mesh.visible === false);
  check('水柱：無 THREE → 空殼', createWaterCannonMesh({}).mesh === null);
}

// ---------- 消防隊座標（osm-city.json）----------
{
  const osm = JSON.parse(read('src/data/osm-city.json'));
  const inside = (x, z, p) => {
    let c = false;
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      const xi = p[i];
      const zi = p[i + 1];
      const xj = p[j];
      const zj = p[j + 1];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
    }
    return c;
  };
  const st = osm.B.find((b) => b.i === FIRE_STATION.osmId);
  check('消防隊：osm-city.json 有 fire_station 建物（消防局黎明分隊）', st && st.t === 'fire_station' && st.n === FIRE_STATION.name);
  const b = osm.bounds;
  const pts = [FIRE_STATION, FIRE_TRUCK_SPOT];
  // 消防車四角（長 7.6 / 寬 2.5）
  const fx = Math.sin(FIRE_TRUCK_SPOT.yaw);
  const fz = Math.cos(FIRE_TRUCK_SPOT.yaw);
  for (const [a, c] of [[3.8, 1.25], [3.8, -1.25], [-3.8, 1.25], [-3.8, -1.25]]) pts.push({ x: FIRE_TRUCK_SPOT.x + fx * a + fz * c, z: FIRE_TRUCK_SPOT.z + fz * a - fx * c });
  check('消防隊門口 / 消防車四角：在地圖內、不在建築 / 水域內', pts.every((p) => p.x > b.x0 + 20 && p.x < b.x1 - 20 && p.z > b.z0 + 20 && p.z < b.z1 - 20 && !osm.B.some((o) => inside(p.x, p.z, o.p)) && !osm.W.some((w) => inside(p.x, p.z, w.p))));
  // 離最近車流道路（青海路二段）距離：消防車中心在路緣外、≤ 15 m
  let best = Infinity;
  for (const r of osm.R) {
    for (let i = 0; i + 3 < r.p.length; i += 2) {
      const ax = r.p[i];
      const az = r.p[i + 1];
      const dx = r.p[i + 2] - ax;
      const dz = r.p[i + 3] - az;
      const t = Math.max(0, Math.min(1, ((FIRE_TRUCK_SPOT.x - ax) * dx + (FIRE_TRUCK_SPOT.z - az) * dz) / (dx * dx + dz * dz)));
      const d = Math.hypot(ax + t * dx - FIRE_TRUCK_SPOT.x, az + t * dz - FIRE_TRUCK_SPOT.z) - (r.w || 6) / 2;
      if (d < best) best = d;
    }
  }
  check('消防車停在路緣外前庭（離路緣 2–12 m）', best > 2 && best < 12, best.toFixed(1));
  const toRoad = Math.atan2(-fx, -fz);
  void toRoad;
}

// ---------- 原始碼限制 ----------
{
  const src = read('src/missions/firefighter.js');
  check('firefighter.js 不 import three / rapier', !/^import[^\n]*(three|rapier)/m.test(src));
  const ex = read('src/explosions.js');
  check('explosions.js 仍不 import three', !/from ['"]three['"]/.test(ex));
}

console.log(failed ? `FAIL ${failed}/${passed + failed}` : `PASS ${passed}/${passed + failed}`);
process.exit(failed ? 1 : 0);
