#!/usr/bin/env node
// P11 警車任務無頭測試：src/missions/vigilante.js（純邏輯 + createFugitiveWorld 替身）+ 真 wanted.js / events.js
// 用法：node tools/test/p11-vigilante.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 涵蓋：啟動條件（警車 / 無其他任務 / 任意星數 / 首次提示）、逃犯數 min(關數, 4) 與時限 120 + 30 × 台數、生成距離帶、逃竄速度上限、
//   制伏判定（耐久門檻 / 低速 3 s 且 15 m 內 / 遠處低速不算 / 玩家開走）、賞金 500 × 關數 + toast、5 s 後下一關、
//   結束條件（timeout / left > 10 s / wrecked / busted / wasted / cancel 不 toast）+ 逃犯車回收、不算犯行（isFugitiveActor / shotAtFugitive + 真 wanted）、
//   幀率無關（1/30、1/60、1/144）、dt clamp、標記、任務條文字、createFugitiveWorld（spawnPoint / spawn / drive / eject / remove）
import { createBus } from '../../src/core/events.js';
import { createWanted, CRIMES } from '../../src/wanted/wanted.js';
import { SMOKE_DARK_AT } from '../../src/vehicle-damage.js';
import { readFileSync } from 'node:fs';
import {
  MAX_FUGITIVES,
  SPAWN_MIN,
  SPAWN_MAX,
  TIME_BASE,
  TIME_PER_CAR,
  FLEE_SPEED_MAX,
  SUBDUE_HEALTH,
  SLOW_SEC,
  NEAR_DIST,
  REWARD_PER_LEVEL,
  NEXT_LEVEL_SEC,
  LEFT_SEC,
  SHOT_RADIUS,
  HINT_ID,
  HINT_TEXT,
  TOAST_SUBDUED,
  END_REASONS,
  fugitiveCount,
  levelTime,
  fleeSpeed,
  levelReward,
  formatClock,
  barText,
  toastEnd,
  createVigilante,
  createFugitiveWorld,
} from '../../src/missions/vigilante.js';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// 替身世界：逃犯車 = { x, z, speed, health, exists, driven, cmd }；spawnPoint 在玩家 +z 方向 200 m 的固定點（可設 null 模擬找不到）
function fakeWorld() {
  const w = {
    cars: [],
    removed: [],
    ejected: [],
    spawnArgs: [],
    noSpot: false,
    spawnPoint(px, pz, rMin, rMax) {
      w.spawnArgs.push([rMin, rMax]);
      if (w.noSpot) return null;
      const k = w.cars.length;
      return { x: px + 30 * k, z: pz + (rMin + rMax) / 2, heading: 0 };
    },
    spawn(pt) {
      const h = { x: pt.x, z: pt.z, speed: 10, health: 1000, exists: true, driven: false, cmd: null, actor: { id: `fug-${w.cars.length}` } };
      w.cars.push(h);
      return h;
    },
    state: (h) => ({ x: h.x, z: h.z, speed: h.speed, health: h.health, exists: h.exists, driven: h.driven }),
    drive: (h, cmd) => {
      h.cmd = { ...cmd };
    },
    eject: (h) => {
      w.ejected.push(h);
      return h.actor;
    },
    remove: (h) => {
      w.removed.push(h);
      h.exists = false;
    },
  };
  return w;
}

function make({ config, rng = () => 0.5 } = {}) {
  const bus = createBus();
  const log = [];
  for (const n of ['vigilante:start', 'vigilante:level', 'vigilante:end', 'vigilante:subdued', 'wanted:change']) bus.on(n, (e) => log.push([n, e]));
  const wanted = createWanted({ bus });
  const vig = createVigilante({ bus, wanted, rng, config });
  const world = fakeWorld();
  const earned = [];
  const toasts = [];
  const hints = [];
  const ctx = {
    player: { x: 0, z: 0 },
    inPolice: true,
    policeWrecked: false,
    busy: false,
    world,
    earn: (n) => earned.push(n),
    toast: (t) => toasts.push(t),
    showHint: (id, text) => {
      hints.push([id, text]);
      return true;
    },
  };
  const step = (dt) => vig.update(dt, ctx);
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
  // 把該關所有未制伏的車打到耐久門檻
  const wreckAll = () => {
    for (const f of vig.fugitives) if (f.h && !f.subdued) f.h.health = SUBDUE_HEALTH;
  };
  return { bus, log, wanted, vig, world, earned, toasts, hints, ctx, step, run, wreckAll };
}

// ---------- 純函式 ----------
check('fugitiveCount：min(關數, 4)', [1, 2, 3, 4, 5, 9].map((l) => fugitiveCount(l)).join() === '1,2,3,4,4,4' && MAX_FUGITIVES === 4);
check('levelTime：120 + 30 × 台數', levelTime(1) === 150 && levelTime(4) === 240 && TIME_BASE === 120 && TIME_PER_CAR === 30);
check('levelReward：500 × 關數', levelReward(1) === 500 && levelReward(3) === 1500 && REWARD_PER_LEVEL === 500);
{
  const sp = [1, 2, 3, 5, 10, 50].map((l) => fleeSpeed(l));
  // vehicle.js 依賴 three（staging 無 node_modules）：從原始碼讀警車極速
  const maxPolice = Number((readFileSync(new URL('../../src/vehicle.js', import.meta.url), 'utf8').match(/^\s*police: \{[^}]*maxSpeed: ([\d.]+)/m) || [])[1]);
  check('fleeSpeed：隨關數遞增（不遞減）、上限 < 警車極速', sp.every((v, i) => i === 0 || v >= sp[i - 1]) && sp[1] > sp[0] && sp.at(-1) === FLEE_SPEED_MAX && FLEE_SPEED_MAX < maxPolice, `${sp.join()} / police ${maxPolice}`);
}
check('formatClock：mm:ss（無條件進位）', formatClock(150) === '02:30' && formatClock(59.2) === '01:00' && formatClock(0) === '00:00' && formatClock(-3) === '00:00');
check('barText：「警車任務 第 N 關｜剩 M 台｜mm:ss」', barText(2, 1, 61) === '警車任務 第 2 關｜剩 1 台｜01:01');
check('SUBDUE_HEALTH 沿用 vehicle-damage SMOKE_DARK_AT', SUBDUE_HEALTH === SMOKE_DARK_AT);
check('toastEnd 文案', toastEnd(2, 1500) === '警車任務結束：完成 2 關、共得 NT$1500');

// ---------- 啟動條件 / 提示 ----------
{
  const w = make();
  check('canStart：警車內、無其他任務 → true', w.vig.canStart({ inPolice: true, busy: false }));
  check('canStart：非警車 → false', !w.vig.canStart({ inPolice: false, busy: false }));
  check('canStart：其他任務進行中 → false', !w.vig.canStart({ inPolice: true, busy: true }));
  w.ctx.inPolice = false;
  w.step(1 / 60);
  check('未坐上警車：不出提示', w.hints.length === 0);
  w.ctx.inPolice = true;
  w.step(1 / 60);
  w.step(1 / 60);
  check(`首次坐上警車：showHint('${HINT_ID}', '${HINT_TEXT}') 只一次`, w.hints.length === 1 && w.hints[0][0] === HINT_ID && HINT_TEXT === '按 E 開始警車任務');
  check('未 start：不生成逃犯、不 active', !w.vig.active && w.world.cars.length === 0);
  w.wanted.setStars(3);
  check('任意星數皆可開始（3 星）', w.vig.canStart({ inPolice: true, busy: false }) && w.vig.start());
  check('start：emit vigilante:start、active', w.vig.active && w.log.some((e) => e[0] === 'vigilante:start'));
  check('進行中再 start → false', !w.vig.start() && !w.vig.canStart({ inPolice: true, busy: false }));
  const r = w.step(1 / 60);
  check('第 1 關：1 台逃犯、時限 150 s、emit vigilante:level start', w.world.cars.length === 1 && r.level === 1 && r.remaining === 1 && near(r.timeLeft, 150 - 1 / 60, 1e-9) && w.log.some((e) => e[0] === 'vigilante:level' && e[1].phase === 'start' && e[1].count === 1 && e[1].timeSec === 150));
  check(`生成距離帶 ${SPAWN_MIN}–${SPAWN_MAX} m`, w.world.spawnArgs.every(([a, b]) => a === SPAWN_MIN && b === SPAWN_MAX));
  const h = w.world.cars[0];
  check('逃犯車收到駕駛指令：maxSpeed = fleeSpeed(1)、目標點背離玩家', h.cmd && h.cmd.maxSpeed === fleeSpeed(1) && h.cmd.z > h.z);
  check('任務條文字', r.text === barText(1, 1, r.timeLeft) && r.text.startsWith('警車任務 第 1 關｜剩 1 台｜02:'));
  const mk = w.vig.markers([]);
  check("標記：未制伏逃犯車 kind 'fugitive'", mk.length === 1 && mk[0].kind === 'fugitive' && mk[0].x === h.x);
}

// ---------- 制伏 / 賞金 / 下一關 ----------
{
  const w = make();
  w.vig.start();
  w.step(1 / 60);
  const h = w.world.cars[0];
  h.health = SUBDUE_HEALTH + 1;
  w.step(1 / 60);
  check('耐久高於門檻：未制伏', w.vig.fugitives[0].subdued === false);
  h.health = SUBDUE_HEALTH;
  const r = w.step(1 / 60);
  check('耐久 ≤ 門檻 → 制伏：eject、toast「逃犯制伏」、vigilante:subdued', w.vig.fugitives[0].subdued && w.world.ejected[0] === h && w.toasts.includes(TOAST_SUBDUED) && w.log.some((e) => e[0] === 'vigilante:subdued'));
  check('全部制伏 → 賞金 NT$500（earn）、vigilante:level clear', w.earned.join() === '500' && w.log.some((e) => e[0] === 'vigilante:level' && e[1].phase === 'clear' && e[1].reward === 500) && w.toasts.some((t) => t.includes('NT$500')));
  check('過關倒數：phase intermission、任務條顯示下一關', r.phase === 'intermission' && /下一關 00:05/.test(r.text));
  check('制伏後不再列入標記', w.vig.markers([]).length === 0);
  w.run(NEXT_LEVEL_SEC - 0.1);
  check('5 s 前：仍在倒數', w.vig.phase === 'intermission' && w.vig.level === 1);
  w.run(0.2);
  check('5 s 後自動第 2 關：2 台、時限 180 s、上一關車回收', w.vig.level === 2 && w.vig.phase === 'running' && w.vig.fugitives.length === 2 && w.world.removed.includes(h) && near(w.vig.timeLeft, 180, 0.2));
  check('第 2 關逃竄速度提高', w.world.cars[1].cmd.maxSpeed === fleeSpeed(2) && fleeSpeed(2) > fleeSpeed(1));
  w.wreckAll();
  w.step(1 / 60);
  check('第 2 關賞金 NT$1000、累計 1500', w.earned.join() === '500,1000' && w.vig.earned === 1500 && w.vig.levelsDone === 2);
  w.run(NEXT_LEVEL_SEC + 0.1);
  w.wreckAll();
  w.step(1 / 60);
  w.run(NEXT_LEVEL_SEC + 0.1);
  w.wreckAll();
  w.step(1 / 60);
  w.run(NEXT_LEVEL_SEC + 0.1);
  check('第 5 關：逃犯 4 台（上限）、時限 240 s', w.vig.level === 5 && w.vig.fugitives.length === 4 && near(w.vig.timeLeft, 240, 0.2));
}
{
  // 低速制伏：車速 < 1 m/s 持續 3 s 且玩家 ≤ 15 m
  const w = make();
  w.vig.start();
  w.step(1 / 60);
  const h = w.world.cars[0];
  h.speed = 0.5;
  h.x = 0;
  h.z = NEAR_DIST + 5; // 遠
  w.run(SLOW_SEC + 1);
  check('低速但玩家 > 15 m：不制伏', !w.vig.fugitives[0].subdued);
  h.z = NEAR_DIST - 1;
  w.run(SLOW_SEC - 0.2);
  check('低速 + 15 m 內未滿 3 s：不制伏', !w.vig.fugitives[0].subdued);
  h.speed = 3;
  w.step(1 / 60);
  h.speed = 0.5;
  w.run(SLOW_SEC - 0.2);
  check('中途加速 → 計時歸零', !w.vig.fugitives[0].subdued);
  w.run(0.3);
  check('低速 + 15 m 內滿 3 s → 制伏', w.vig.fugitives[0].subdued && w.earned.join() === '500');
}
{
  // 玩家開走逃犯車 → 制伏
  const w = make();
  w.vig.start();
  w.step(1 / 60);
  w.world.cars[0].driven = true;
  w.step(1 / 60);
  check('玩家開走逃犯車 → 制伏', w.vig.fugitives[0].subdued);
}
{
  // 找不到生成點：時限照走、之後補生成
  const w = make();
  w.world.noSpot = true;
  w.vig.start();
  w.run(1);
  check('找不到生成點：不生成、剩 1 台（pending）', w.world.cars.length === 0 && w.vig.update(0, w.ctx).remaining === 1);
  w.world.noSpot = false;
  w.run(1);
  check('生成點恢復 → 補生成', w.world.cars.length === 1);
}

// ---------- 結束條件 ----------
function endCase(name, setup, reason, { toast = true } = {}) {
  const w = make();
  w.vig.start();
  w.step(1 / 60);
  w.wreckAll();
  w.step(1 / 60); // 完成第 1 關（NT$500）
  w.run(NEXT_LEVEL_SEC + 0.1); // 第 2 關開始
  const cars = w.vig.fugitives.map((f) => f.h);
  setup(w);
  const ev = w.log.filter((e) => e[0] === 'vigilante:end');
  const ok = !w.vig.active && ev.length === 1 && ev[0][1].reason === reason && ev[0][1].levels === 1 && ev[0][1].earned === 500;
  const recycled = cars.every((h) => w.world.removed.includes(h)) && w.vig.markers([]).length === 0;
  const toasted = w.toasts.includes('警車任務結束：完成 1 關、共得 NT$500');
  check(`結束（${name}）：reason ${reason}、完成 1 關 / NT$500、逃犯車與標記回收、${toast ? '' : '不 '}toast`, ok && recycled && toasted === toast, JSON.stringify(ev.map((e) => e[1])));
  return w;
}
endCase('時限到', (w) => w.run(levelTime(2) + 0.5, 1 / 30), 'timeout');
{
  const w = endCase('離開警車 > 10 s', (w) => {
    w.ctx.inPolice = false;
    w.run(LEFT_SEC - 0.5);
    w.ctx.inPolice = true; // 中途回車：重新計時
    w.step(1 / 60);
    w.ctx.inPolice = false;
    w.run(LEFT_SEC - 0.5);
    if (!w.vig.active) throw new Error('提早結束');
    w.run(0.6);
  }, 'left');
  void w;
}
endCase('警車毀損', (w) => {
  w.ctx.policeWrecked = true;
  w.step(1 / 60);
}, 'wrecked');
endCase('BUSTED（end）', (w) => w.vig.end('busted'), 'busted');
endCase('WASTED（bus player:wasted 保底）', (w) => w.bus.emit('player:wasted', { fee: 100 }), 'wasted');
endCase('回主選單 cancel', (w) => w.vig.cancel(), 'cancel', { toast: false });
check('END_REASONS 列舉', END_REASONS.join() === 'timeout,left,wrecked,busted,wasted,cancel');
{
  const w = make();
  check('未進行中 cancel / end → false、不 emit', w.vig.cancel() === false && w.vig.end('busted') === false && !w.log.some((e) => e[0] === 'vigilante:end'));
  w.vig.start();
  w.step(1 / 60);
  w.vig.cancel();
  check('cancel 後可再開始（從第 1 關、賞金歸零）', w.vig.start() && (w.step(1 / 60), w.vig.level === 1 && w.vig.earned === 0));
  w.vig.dispose();
  w.vig.start();
  const before = w.log.filter((e) => e[0] === 'vigilante:end').length;
  w.bus.emit('player:busted', {});
  check('dispose 取消 bus 訂閱（player:busted 不再結束）', w.log.filter((e) => e[0] === 'vigilante:end').length === before && w.vig.active);
}

// ---------- 不算犯行 ----------
{
  const w = make();
  w.vig.start();
  w.step(1 / 60);
  const h = w.world.cars[0];
  // 整合層的報案守門（同 main.js：isFugitiveActor / shotAtFugitive 為真就不 report）
  const reportIf = (exempt, crime, x, z) => {
    if (!exempt) w.wanted.report(crime, { x, z, witnessed: true });
  };
  check('任務中：射擊逃犯車（落點 ≤ 4.5 m）不算 gunfire', w.vig.shotAtFugitive(h.x + SHOT_RADIUS - 0.5, h.z) && (reportIf(w.vig.shotAtFugitive(h.x + 1, h.z), CRIMES.gunfire, h.x, h.z), w.wanted.heat === 0));
  check('任務中：射擊別處（落點 > 4.5 m）照常算', !w.vig.shotAtFugitive(h.x + SHOT_RADIUS + 1, h.z) && (reportIf(w.vig.shotAtFugitive(h.x + 20, h.z), CRIMES.gunfire, 0, 0), w.wanted.heat > 0));
  w.wanted.clear('debug');
  h.health = 0;
  w.step(1 / 60);
  const actor = h.actor;
  check('下車逃犯 actor：isFugitiveActor 真 → 攻擊 / 撞倒不報案', w.vig.isFugitiveActor(actor) && (reportIf(w.vig.isFugitiveActor(actor), CRIMES.assault, 0, 0), reportIf(w.vig.isFugitiveActor(actor), CRIMES.vehicleHit, 0, 0), w.wanted.stars === 0));
  check('一般市民 actor：照常報案', !w.vig.isFugitiveActor({ id: 'citizen' }) && (reportIf(w.vig.isFugitiveActor({ id: 'citizen' }), CRIMES.vehicleHit, 0, 0), w.wanted.stars > 0));
  w.vig.cancel();
  check('任務結束後豁免失效', !w.vig.isFugitiveActor(actor) && !w.vig.shotAtFugitive(h.x, h.z));
  check('vigilante.js 不呼叫 wanted.report', !w.log.some((e) => e[0] === 'wanted:change' && e[1].reason === 'vigilante'));
}
{
  // 已制伏的車不豁免：制伏後不再更新座標，車被開走 / 推走後舊位置不得豁免、新位置照算
  const w = make();
  w.vig.start();
  w.step(1 / 60);
  const h = w.world.cars[0];
  const ox = h.x;
  const oz = h.z;
  h.health = 0;
  w.step(1 / 60);
  const subdued = w.vig.fugitives[0] ? w.vig.fugitives[0].subdued : false;
  h.x += 200;
  w.step(1 / 60);
  check('已制伏的逃犯車：舊位置 / 現位置開槍都不豁免（逃犯本人仍由 isFugitiveActor 豁免）', subdued && w.vig.active && !w.vig.shotAtFugitive(ox, oz) && !w.vig.shotAtFugitive(h.x, h.z) && w.vig.isFugitiveActor(h.actor));
}

// ---------- 幀率無關 / dt clamp ----------
{
  const outcome = (dt) => {
    const w = make();
    w.vig.start();
    w.step(dt);
    const h = w.world.cars[0];
    h.speed = 0.2;
    h.x = 0;
    h.z = 5;
    let t = 0;
    let subAt = null;
    while (t < 10) {
      w.step(dt);
      t += dt;
      if (subAt === null && w.vig.fugitives[0].subdued) subAt = t;
    }
    // 過關後的倒數 → 下一關開始時刻
    let lvl2At = null;
    while (t < 20 && lvl2At === null) {
      w.step(dt);
      t += dt;
      if (w.vig.level === 2) lvl2At = t;
    }
    return { subAt, lvl2At };
  };
  const rs = [1 / 30, 1 / 60, 1 / 144].map(outcome);
  const ok = rs.every((r) => r.subAt !== null && r.lvl2At !== null && Math.abs(r.subAt - rs[0].subAt) <= 1 / 30 + 1e-6 && Math.abs(r.lvl2At - rs[0].lvl2At) <= 2 / 30 + 1e-6);
  check('幀率無關：低速制伏時刻 / 下一關時刻（30 / 60 / 144 fps 誤差 ≤ 1 幀）', ok && near(rs[1].subAt, SLOW_SEC, 0.05), JSON.stringify(rs));
  const tl = (dt) => {
    const w = make();
    w.vig.start();
    w.step(dt);
    for (let t = 0; t < 30 - 1e-9; t += dt) w.step(dt);
    return w.vig.timeLeft;
  };
  const a = tl(1 / 30);
  const b = tl(1 / 144);
  check('幀率無關：倒數 30 s 後剩餘時間一致', Math.abs(a - b) <= 1 / 30 + 1e-6 && near(a, 120, 0.1), `${a} / ${b}`);
  const w = make();
  w.vig.start();
  w.step(1 / 60);
  const t0 = w.vig.timeLeft;
  w.step(5); // 卡頓：clamp 0.1 s
  check('dt clamp ≤ 0.1 s', near(t0 - w.vig.timeLeft, 0.1, 1e-9));
  w.step(NaN);
  w.step(-1);
  check('dt 非有限 / 負 → 0', near(t0 - w.vig.timeLeft, 0.1, 1e-9));
}

// ---------- createFugitiveWorld（替身 vehicles / dmg / traffic / findRoute）----------
{
  const mkV = (o) => {
    const v = { ...o, pos: { x: o.x, z: o.z }, yaw: o.yaw, speed: 0, driven: false, ai: false, spec: { length: 4.5, width: 1.85, doorSide: 1 }, controls: [], setControls(c) { this.controls.push(c); } };
    return v;
  };
  const vehicles = {
    vehicles: [],
    adopt(o) {
      const v = mkV(o);
      this.vehicles.push(v);
      return v;
    },
    remove(v) {
      const i = this.vehicles.indexOf(v);
      if (i >= 0) this.vehicles.splice(i, 1);
      return i >= 0;
    },
  };
  const health = new Map();
  const dmg = { attach: (v) => health.set(v, 1000), detach: (v) => health.delete(v), healthOf: (v) => (health.has(v) ? health.get(v) : null) };
  const ejected = [];
  const traffic = {
    cars: [],
    spawnSpots: (cx, cz, rMin, rMax, out = []) => {
      out.length = 0;
      out.push({ x: cx + 50, z: cz }, { x: cx + 200, z: cz, heading: 1.2 }, { x: cx + 400, z: cz });
      return out;
    },
    spawnEjectedDriver: (o) => {
      ejected.push(o);
      return { actor: { id: 'ejected' } };
    },
  };
  const routes = [];
  const findRoute = (a, b) => {
    routes.push([a, b]);
    return { points: [a, { x: a.x, z: a.z + 50 }, { x: b.x, z: b.z }, b] };
  };
  const playerActor = { id: 'player' };
  const fw = createFugitiveWorld({ vehicles, dmg, traffic, findRoute, rng: () => 0.4, attacker: () => playerActor });
  const pt = fw.spawnPoint(0, 0, SPAWN_MIN, SPAWN_MAX);
  check('world.spawnPoint：只取距離帶內的車道點（200 m、帶 heading）', pt && pt.x === 200 && pt.heading === 1.2);
  check('world.spawnPoint：無車道點 → null', createFugitiveWorld({ vehicles, dmg, traffic: { spawnSpots: (a, b, c, d, out) => out }, findRoute }).spawnPoint(0, 0, 150, 300) === null);
  const h = fw.spawn(pt);
  const v = h.v;
  check('world.spawn：vehicles.adopt 一般車型（非警車 / 機車 / 公車）、v.ai、dmg.attach', ['sedan', 'taxi', 'suv'].includes(v.type) && v.ai && v.fugitive && dmg.healthOf(v) === 1000 && vehicles.vehicles.includes(v));
  const st = fw.state(h);
  check('world.state：位置 / 耐久 / exists', st.exists && st.x === 200 && st.health === 1000 && !st.driven);
  fw.update(1 / 60);
  check('未下指令：煞停', v.controls.at(-1).brake === 1);
  fw.drive(h, { x: 200, z: 300, maxSpeed: 20 });
  fw.update(1 / 60);
  const c = v.controls.at(-1);
  check('drive：沿 findRoute 路線、油門 > 0', routes.length === 1 && c.throttle > 0 && c.brake === 0);
  // 卡住：油門 > 0.3、車速 < 1 持續 4 s → 倒車（長於制伏低速 3 s）
  for (let t = 0; t < 3.5; t += 1 / 60) fw.update(1 / 60);
  check('卡住 3.5 s：尚未倒車（> SLOW_SEC 才倒車，讓被頂住先成立制伏）', v.controls.at(-1).throttle > 0);
  for (let t = 0; t < 0.6; t += 1 / 60) fw.update(1 / 60);
  check('卡住 4 s：倒車脫困', v.controls.at(-1).throttle === -1);
  const actor = fw.eject(h);
  check('world.eject：spawnEjectedDriver（車門外、attacker = 玩家）、停止控制、交還一般車', actor && actor.id === 'ejected' && ejected.length === 1 && ejected[0].attacker === playerActor && Math.hypot(ejected[0].x - 200, ejected[0].z - 0) < 4 && !v.ai && v.controls.at(-1).handbrake === true);
  const n = v.controls.length;
  fw.update(1 / 60);
  check('eject 後不再控制', v.controls.length === n && fw.eject(h) === null);
  fw.remove(h);
  check('world.remove：移除車輛 + dmg.detach', !vehicles.vehicles.includes(v) && dmg.healthOf(v) === null && !fw.state(h).exists);
  const h2 = fw.spawn(pt);
  h2.v.driven = true;
  fw.remove(h2);
  check('world.remove：玩家正駕駛的逃犯車保留', vehicles.vehicles.includes(h2.v) && !h2.v.ai);
  // isKept（玩家正上車：driven 仍 false）→ 保留、不 detach；保留的車（含正駕駛者）交 onKeep
  {
    let entering = null;
    const kept = [];
    const fk = createFugitiveWorld({ vehicles, dmg, traffic, findRoute, rng: () => 0.4, isKept: (x) => x === entering, onKeep: (x) => kept.push(x) });
    const he = fk.spawn({ x: 900, z: 900, heading: 0 });
    entering = he.v;
    fk.remove(he);
    const hd = fk.spawn({ x: 950, z: 900, heading: 0 });
    hd.v.driven = true;
    fk.remove(hd);
    const hr = fk.spawn({ x: 999, z: 900, heading: 0 });
    fk.remove(hr);
    check('world.remove：isKept（上車中）保留且不 detach、onKeep 收到保留的車（上車中 / 正駕駛），一般車照常移除', vehicles.vehicles.includes(he.v) && dmg.healthOf(he.v) === 1000 && !he.v.fugitive && kept.length === 2 && kept[0] === he.v && kept[1] === hd.v && !vehicles.vehicles.includes(hr.v));
    // brakeAll：凍結時煞停仍在逃的車並清掉倒車狀態；已制伏 / 玩家駕駛的車不碰
    const hb = fk.spawn({ x: 1100, z: 900, heading: 0 });
    fk.drive(hb, { x: 1100, z: 1200, maxSpeed: 20 });
    fk.update(1 / 60);
    const before = hb.v.controls.at(-1);
    hb.reverseT = 1;
    const nd = hd.v.controls.length;
    const ok = typeof fk.brakeAll === 'function' && (fk.brakeAll(), true);
    const after = hb.v.controls.at(-1);
    check('world.brakeAll：在逃的車煞停（油門 0、brake 1）、清倒車；玩家駕駛的車不碰', ok && before.throttle > 0 && after.throttle === 0 && after.brake === 1 && hb.reverseT === 0 && hd.v.controls.length === nd);
    for (const v of [he.v, hd.v, hb.v]) vehicles.remove(v);
  }
  // 與 createVigilante 串接：整關跑一次
  const bus = createBus();
  const vig = createVigilante({ bus, rng: () => 0.5 });
  const ctx = { player: { x: 0, z: 0 }, inPolice: true, world: fw, earn: () => {}, toast: () => {} };
  vehicles.vehicles.length = 0; // 清掉前面保留的玩家車，避免 spawnPoint 的車距檢查
  vig.start();
  vig.update(1 / 60, ctx);
  const f = vig.fugitives[0];
  check('串接：vigilante 透過 world 生成並下駕駛指令', f.h && fw.cars.has(f.h) && f.h.cmd.set && f.h.cmd.maxSpeed === fleeSpeed(1));
  const fh = f.h;
  vig.cancel();
  check('串接：cancel → world.remove', fh && !fw.cars.has(fh) && !vehicles.vehicles.includes(fh.v));
}

console.log(`${failed === 0 ? 'PASS' : 'FAIL'} ${failed === 0 ? passed : failed}/${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
