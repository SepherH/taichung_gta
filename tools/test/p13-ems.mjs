#!/usr/bin/env node
// P13 救護車副任務無頭測試：src/missions/ems.js（純邏輯 + createAmbulanceDepot 替身）+ taxi.js createCurbPedWorld（spawnPatient）+ 真 events.js + osm-city.json
// 用法：node tools/test/p13-ems.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 涵蓋：常數 / 純函式（patientsFor / levelReward / levelLimit / chainLength / ambulanceSpot 在河南路三段車道內）、開始條件、傷患生成時序（0.5 s 錯開、湊齊 / 4 s）、
//   撿取時序（停車 3 s、離開 / 車速過快 / 下車歸零、最近一名）、送醫完成（12 m 停車）、賞金 300 × 關數、回血、關數遞增（傷患 1 → 2 → 3）、
//   結束條件（timeout / lost / left / wrecked / busted / wasted / quit / complete / cancel 不 toast）+ 傷患回收、互斥（busy）、幀率無關、dt clamp、
//   標記 / 光柱重用、傷患世界（knockdownActor 倒地、刷新倒地計時、board 回收、remove 放手起身）、救護車停放（生成 / 沿用 / 毀損補車 / 換網格重裝飾）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBus } from '../../src/core/events.js';
import { HOSPITAL } from '../../src/wanted/places.js';
import {
  PICK_RADIUS,
  PICK_SEC,
  PICK_MAX_SPEED,
  HOSPITAL_RADIUS,
  LEVEL_REWARD,
  LEFT_SEC,
  SPAWN_RETRY_SEC,
  SPAWN_WAIT_SEC,
  MARKER_PATIENT,
  MARKER_HOSPITAL,
  AMBULANCE_TYPE,
  AMBULANCE_COLOR,
  AMB_CHECK_SEC,
  AMB_RESPAWN_DIST,
  AMB_HOME_DIST,
  TOAST_BUSY,
  patientsFor,
  levelReward,
  levelLimit,
  chainLength,
  ambulanceSpot,
  createEms,
  createAmbulanceDepot,
} from '../../src/missions/ems.js';
import { createCurbPedWorld, PATIENT_HOLD_SEC } from '../../src/missions/taxi.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------- 常數 / 純函式 ----------
check('規格常數：停車 3 s、賞金 300 × 關數、下車 10 s', PICK_SEC === 3 && LEVEL_REWARD === 300 && LEFT_SEC === 10);
check('patientsFor：第 1 / 2 / 3 / 7 關 = 1 / 2 / 3 / 3 名（1–3 名、隨關數增加）', patientsFor(1) === 1 && patientsFor(2) === 2 && patientsFor(3) === 3 && patientsFor(7) === 3 && patientsFor(0) === 1);
check('levelReward：300 / 600 / 3600', levelReward(1) === 300 && levelReward(2) === 600 && levelReward(12) === 3600);
check('levelLimit：30 + 10 × n + 路程 ÷ 10', near(levelLimit(2, 500), 30 + 20 + 50));
{
  const h = { x: 100, z: 0 };
  const L = chainLength({ x: 0, z: 0 }, [{ x: 50, z: 0 }, { x: 10, z: 0 }], h, 1);
  check('chainLength：貪婪最近鏈（0 → 10 → 50 → 醫院 100）= 100 m（× factor）', near(L, 100) && near(chainLength({ x: 0, z: 0 }, [{ x: 50, z: 0 }], h, 1.4), 140));
}
{
  const s = ambulanceSpot();
  const osm = JSON.parse(readFileSync(`${ROOT}src/data/osm-city.json`, 'utf8'));
  let best = { over: Infinity };
  for (const r of osm.R) {
    if (r.u || r.br || (r.ly || 0) !== 0) continue;
    for (let i = 0; i + 3 < r.p.length; i += 2) {
      const ax = r.p[i];
      const az = r.p[i + 1];
      const dx = r.p[i + 2] - ax;
      const dz = r.p[i + 3] - az;
      const L2 = dx * dx + dz * dz;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((s.x - ax) * dx + (s.z - az) * dz) / L2)) : 0;
      const d = Math.hypot(ax + dx * t - s.x, az + dz * t - s.z);
      if (d - r.w / 2 < best.over) best = { over: d - r.w / 2, name: r.n, h: Math.atan2(dx, dz) };
    }
  }
  const dyaw = Math.abs(Math.sin(s.yaw - best.h)); // 平行（同向或反向）→ 0
  check(`救護車停放點：在 ${best.name} 車道內（離路緣 ≥ 1.5 m）、車頭沿道路`, best.name === '河南路三段' && best.over <= -1.5 && dyaw < 0.05, `over ${best.over.toFixed(2)} dyaw ${dyaw.toFixed(3)}`);
  check(`停放點離醫院門口（WASTED 重生點）≥ 8 m、≤ ${HOSPITAL_RADIUS} m（停好就在送醫判定內）`, Math.hypot(s.x - HOSPITAL.x, s.z - HOSPITAL.z) >= 8 && Math.hypot(s.x - HOSPITAL.x, s.z - HOSPITAL.z) <= HOSPITAL_RADIUS);
}

// ---------- 替身世界 ----------
function fakeWorld() {
  const w = {
    pts: [{ x: 40, z: 0 }, { x: 0, z: 40 }, { x: -40, z: 0 }, { x: 0, z: -40 }, { x: 60, z: 60 }],
    i: 0,
    avail: Infinity, // 可徵用名額（模擬附近路人不足）
    made: [],
    calls: { spawn: 0, board: 0, remove: 0 },
    spawnPatient(center, rMin, rMax) {
      w.calls.spawn++;
      w.band = [rMin, rMax];
      if (w.avail <= 0) return null;
      w.avail--;
      const p = w.pts[w.i++ % w.pts.length];
      const h = { x: center.x + p.x, z: center.z + p.z, exists: true, boarded: false, removed: false };
      w.made.push(h);
      return h;
    },
    state(h) {
      return { x: h.x, z: h.z, exists: h.exists && !h.removed && !h.boarded };
    },
    board(h) {
      w.calls.board++;
      h.boarded = true;
    },
    remove(h) {
      w.calls.remove++;
      h.removed = true;
    },
  };
  return w;
}
function makeEms(config = {}) {
  const bus = createBus();
  const log = [];
  for (const n of ['ems:start', 'ems:patients', 'ems:pickup', 'ems:level', 'ems:end']) bus.on(n, (e) => log.push([n, e]));
  const toasts = [];
  const money = { total: 0, list: [] };
  let heals = 0;
  const world = fakeWorld();
  const ems = createEms({ bus, config });
  const ctx = {
    player: { x: HOSPITAL.x, z: HOSPITAL.z + 200 },
    inAmbulance: true,
    speed: 0,
    wrecked: false,
    world,
    earn: (n) => {
      money.total += n;
      money.list.push(n);
    },
    heal: () => heals++,
    toast: (t) => toasts.push(t),
  };
  return { bus, log, toasts, money, world, ems, ctx, heals: () => heals };
}
const run = (t, sec, dt = 1 / 30) => {
  let last = null;
  for (let s = 0; s < sec - 1e-9; s += dt) last = t.ems.update(dt, t.ctx);
  return last;
};
const goto = (t, x, z) => {
  t.ctx.player.x = x;
  t.ctx.player.z = z;
};
// 撿完本關所有傷患（每名停 PICK_SEC + 一點）
function collectAll(t, dt = 1 / 30) {
  for (let i = 0; i < t.ems.patients; i++) {
    const s = t.ems.slots[i];
    if (s.picked) continue;
    goto(t, s.x + 2, s.z);
    run(t, PICK_SEC + 0.1, dt);
  }
}
const deliver = (t) => {
  goto(t, HOSPITAL.x + 3, HOSPITAL.z);
  t.ems.update(1 / 30, t.ctx);
};
function started(config) {
  const t = makeEms(config);
  t.ems.start(t.ctx);
  run(t, 0.05);
  return t;
}

// ---------- 開始條件 ----------
{
  const t = makeEms();
  check('canStart：不在救護車 → notAmbulance；busy / 熄火 / 翻車', t.ems.canStart({}).reason === 'notAmbulance' && t.ems.canStart({ inAmbulance: true, busy: true }).reason === 'busy' && t.ems.canStart({ inAmbulance: true, stalled: true }).reason === 'stalled' && t.ems.canStart({ inAmbulance: true, overturned: true }).reason === 'overturned');
  check('start(busy) → toast、不開始', !t.ems.start({ inAmbulance: true, busy: true, toast: t.ctx.toast }) && t.toasts.includes(TOAST_BUSY) && !t.ems.active);
  check('start(救護車) → 第 1 關、phase spawn、emit ems:start', t.ems.start(t.ctx) && t.ems.level === 1 && t.ems.phase === 'spawn' && t.log.some((e) => e[0] === 'ems:start'));
  check('進行中不可再開始', !t.ems.start(t.ctx) && t.ems.canStart({ inAmbulance: true }).reason === 'active');
}

// ---------- 傷患生成時序 ----------
{
  const t = makeEms();
  t.ems.start(t.ctx);
  t.ems.update(1 / 30, t.ctx);
  check('第 1 關：第一幀生成 1 名（需要 1 名）→ 立即開始計時 collect', t.ems.patients === 1 && t.ems.phase === 'collect' && t.world.calls.spawn === 1 && t.world.band[0] === 30 && t.world.band[1] === 110);
  const ev = t.log.find((e) => e[0] === 'ems:patients');
  const s0 = t.ems.slots[0];
  const exp = levelLimit(1, chainLength(t.ctx.player, [s0], HOSPITAL, 1.4));
  check('ems:patients：限時 = 30 + 10 × 1 + 估計路程 ÷ 10', ev && near(ev[1].limit, exp) && near(t.ems.limit, exp), `${ev && ev[1].limit} vs ${exp}`);
  const mk = t.ems.markers([]);
  check(`小地圖：未上車傷患 '${MARKER_PATIENT}'；尚無醫院光柱`, mk.length === 1 && mk[0].kind === MARKER_PATIENT && mk[0].x === s0.x && t.ems.beacons().dest === null);
}
{
  const t = makeEms({ maxPatients: 3 });
  t.ems.start(t.ctx);
  // 直接跳到第 3 關測 3 名生成時序：用 config 無法跳關 → 連過兩關
  for (let lv = 1; lv <= 2; lv++) {
    run(t, 2);
    collectAll(t);
    deliver(t);
  }
  check('連過 2 關 → 第 3 關', t.ems.level === 3 && t.ems.phase === 'spawn');
  const c0 = t.world.calls.spawn;
  t.ems.update(1 / 30, t.ctx);
  check('第 3 關：每次只補 1 名（錯開）', t.world.calls.spawn === c0 + 1 && t.ems.patients === 1 && t.ems.phase === 'spawn');
  run(t, SPAWN_RETRY_SEC - 0.1);
  check(`${SPAWN_RETRY_SEC} s 內不再補`, t.ems.patients === 1);
  run(t, 0.2);
  check('0.5 s 後補第 2 名', t.ems.patients === 2);
  run(t, 0.5);
  check('湊齊 3 名 → collect', t.ems.patients === 3 && t.ems.phase === 'collect');
}
{
  const t = makeEms();
  t.world.avail = 0;
  t.ems.start(t.ctx);
  run(t, 10);
  check('附近沒有可徵用的路人：維持 spawn、計時不走、任務條「傷患通報中」', t.ems.phase === 'spawn' && t.ems.timeLeft === 0 && /傷患通報中/.test(t.ems.snapshot().text));
  t.world.avail = 1;
  run(t, 0.6);
  check('之後有人 → 生成並開始', t.ems.phase === 'collect' && t.ems.patients === 1);
}
{
  // 第 2 關需要 2 名但只徵得 1 名：等 SPAWN_WAIT_SEC 後以 1 名開始
  const t = started();
  collectAll(t);
  deliver(t);
  t.world.avail = 1;
  run(t, SPAWN_WAIT_SEC - 0.2);
  check('第 2 關只徵得 1 名：4 s 內繼續等', t.ems.level === 2 && t.ems.phase === 'spawn' && t.ems.patients === 1);
  run(t, 0.4);
  check('等滿 4 s → 以 1 名開始', t.ems.phase === 'collect' && t.ems.patients === 1);
}

// ---------- 撿取時序 ----------
{
  const t = started();
  const s = t.ems.slots[0];
  goto(t, s.x + PICK_RADIUS + 0.5, s.z);
  run(t, 5);
  check('離傷患 6.5 m 停 5 s：不上車', !s.picked && t.ems.picked === 0);
  goto(t, s.x + PICK_RADIUS - 0.5, s.z);
  run(t, PICK_SEC - 0.2);
  check('5.5 m 停 2.8 s：還沒上車、任務條顯示抬上車進度', !s.picked && /抬上車 2\.\d\/3 s/.test(t.ems.snapshot().text), t.ems.snapshot().text);
  t.ctx.speed = PICK_MAX_SPEED + 0.5;
  t.ems.update(1 / 30, t.ctx);
  check('車速 2.5 m/s → 計時歸零', s.hold === 0);
  t.ctx.speed = 0;
  run(t, 2);
  t.ctx.inAmbulance = false;
  t.ems.update(1 / 30, t.ctx);
  check('下車 → 計時歸零', s.hold === 0 && !s.picked);
  t.ctx.inAmbulance = true;
  run(t, 2);
  goto(t, s.x + 20, s.z);
  t.ems.update(1 / 30, t.ctx);
  check('開走 → 計時歸零', s.hold === 0);
  goto(t, s.x + 2, s.z);
  run(t, PICK_SEC + 0.05);
  const pk = t.log.find((e) => e[0] === 'ems:pickup');
  check('停滿 3 s → 抬上車（world.board）、emit ems:pickup、全數上車 → deliver', s.picked && t.world.calls.board === 1 && pk && pk[1].picked === 1 && t.ems.phase === 'deliver');
  const mk = t.ems.markers([]);
  check(`送醫中：小地圖只剩醫院 '${MARKER_HOSPITAL}'、光柱 = HOSPITAL`, mk.length === 1 && mk[0].kind === MARKER_HOSPITAL && mk[0].x === HOSPITAL.x && t.ems.beacons().dest === HOSPITAL);
  check('送醫中任務條', /^救護車｜第 1 關｜送往醫院！｜剩 \d\d:\d\d$/.test(t.ems.snapshot().text), t.ems.snapshot().text);
}
{
  // 兩名傷患相鄰：只累計最近一名
  const t = started();
  collectAll(t);
  deliver(t);
  run(t, 1);
  check('第 2 關：2 名傷患', t.ems.level === 2 && t.ems.patients === 2);
  const [a, b] = t.ems.slots;
  b.x = a.x + 3; // 替身把第 2 名搬到第 1 名旁（state 讀 world 的座標）
  t.world.made[t.world.made.length - 1].x = a.x + 3;
  t.world.made[t.world.made.length - 1].z = a.z;
  goto(t, a.x + 0.5, a.z);
  run(t, 1);
  check('兩名都在 6 m 內：只累計最近一名', a.hold > 0.9 && b.hold === 0);
  run(t, PICK_SEC);
  check('第 1 名上車後換累計第 2 名', a.picked && !b.picked && b.hold > 0);
  run(t, PICK_SEC);
  check('第 2 名上車 → deliver', b.picked && t.ems.phase === 'deliver' && t.log.filter((e) => e[0] === 'ems:pickup').length === 3);
}

// ---------- 送醫完成 / 賞金 / 回血 / 關數 ----------
{
  const t = started();
  collectAll(t);
  goto(t, HOSPITAL.x + HOSPITAL_RADIUS + 1, HOSPITAL.z);
  t.ems.update(1 / 30, t.ctx);
  check('醫院 13 m 外：未完成', t.ems.phase === 'deliver');
  goto(t, HOSPITAL.x + HOSPITAL_RADIUS - 1, HOSPITAL.z);
  t.ctx.speed = 6;
  t.ems.update(1 / 30, t.ctx);
  check('11 m 但車速 6 m/s：未完成（要停車）', t.ems.phase === 'deliver');
  t.ctx.speed = 0;
  t.ems.update(1 / 30, t.ctx);
  const lv = t.log.find((e) => e[0] === 'ems:level');
  check('停車送達：賞金 NT$300（第 1 關）、ctx.heal() 回血、emit ems:level', lv && lv[1].level === 1 && lv[1].reward === 300 && t.money.total === 300 && t.heals() === 1);
  check('第 2 關開始：level 2、phase spawn、toast 含賞金與回血', t.ems.level === 2 && t.ems.phase === 'spawn' && t.toasts.some((s) => s === '第 1 關完成！賞金 NT$300｜生命值回滿'));
  run(t, 1);
  collectAll(t);
  deliver(t);
  check('第 2 關完成：賞金 NT$600、累計 900、回血 2 次、第 3 關', t.money.list.join() === '300,600' && t.ems.earned === 900 && t.heals() === 2 && t.ems.level === 3);
  run(t, 1.5);
  check('第 3 關：3 名傷患', t.ems.patients === 3);
}
{
  const t = started({ maxLevel: 2 });
  collectAll(t);
  deliver(t);
  run(t, 1);
  collectAll(t);
  deliver(t);
  const e = t.log.find((x) => x[0] === 'ems:end');
  check('通過 MAX_LEVEL（config 2）→ 結束 complete、toast「全部關卡完成」、賞金 300 + 600', !t.ems.active && e && e[1].reason === 'complete' && e[1].cleared === 2 && t.money.total === 900 && t.toasts.some((s) => s.includes('全部關卡完成')));
}

// ---------- 結束條件 ----------
{
  const t = started();
  const lim = t.ems.limit;
  const s = run(t, lim - 14);
  check('剩 ≤ 15 s：任務條 urgent', s.urgent === true);
  run(t, 14.2);
  const e = t.log.find((x) => x[0] === 'ems:end');
  check('超時 → 結束 timeout、未上車傷患 world.remove、toast', !t.ems.active && e && e[1].reason === 'timeout' && t.world.made[0].removed && t.toasts.some((x) => x.startsWith('救護車任務結束：超時了')));
}
{
  const t = started();
  collectAll(t);
  run(t, t.ems.limit + 1);
  check('送醫途中超時 → timeout（已上車者不再 remove）', !t.ems.active && t.log.some((x) => x[0] === 'ems:end' && x[1].reason === 'timeout') && t.world.calls.remove === 0);
}
{
  const t = started();
  t.world.made[0].exists = false;
  t.ems.update(1 / 30, t.ctx);
  check('傷患死亡 / 消失 → 結束 lost「傷患不治」', !t.ems.active && t.log.some((x) => x[0] === 'ems:end' && x[1].reason === 'lost') && t.toasts.some((x) => x.includes('傷患不治')));
}
{
  const t = started();
  t.ctx.inAmbulance = false;
  run(t, LEFT_SEC - 0.2);
  check('下車 9.8 s：仍在', t.ems.active);
  run(t, 0.4);
  check('下車 > 10 s → left', !t.ems.active && t.log.some((x) => x[0] === 'ems:end' && x[1].reason === 'left'));
}
{
  const t = started();
  t.ctx.wrecked = true;
  t.ems.update(1 / 30, t.ctx);
  check('救護車毀損 → wrecked', !t.ems.active && t.log.some((x) => x[0] === 'ems:end' && x[1].reason === 'wrecked'));
}
for (const kind of ['busted', 'wasted']) {
  const t = started();
  t.bus.emit(`player:${kind}`, {});
  check(`player:${kind} → ${kind}、傷患回收`, !t.ems.active && t.log.some((x) => x[0] === 'ems:end' && x[1].reason === kind) && t.world.made[0].removed);
}
{
  const t = started();
  collectAll(t);
  deliver(t);
  t.ems.end('quit', t.ctx);
  check('收工 quit：toast 統計', t.toasts.some((s) => s === '救護車收工｜完成 1 關｜NT$300'));
}
{
  const t = started();
  const n = t.toasts.length;
  t.ems.cancel();
  const e = t.log.find((x) => x[0] === 'ems:end');
  check('cancel()：無聲、emit ems:end cancel、傷患回收、標記清空', !t.ems.active && e && e[1].reason === 'cancel' && t.toasts.length === n && t.world.made[0].removed && t.ems.markers([]).length === 0 && t.ems.beacons().dest === null);
  check('cancel 後再開始從第 1 關、賞金歸零', t.ems.start(t.ctx) && t.ems.level === 1 && t.ems.earned === 0);
  t.ems.dispose();
  t.ems.start(t.ctx);
  t.bus.emit('player:wasted', {});
  check('dispose 後取消訂閱', t.ems.active);
}

// ---------- 幀率無關 / dt clamp / 不每幀配置 ----------
{
  const res = [];
  for (const dt of [1 / 30, 1 / 60, 1 / 144]) {
    const t = started();
    const s = t.ems.slots[0];
    goto(t, s.x + 2, s.z);
    let n = 0;
    while (!s.picked && n < 1e5) {
      t.ems.update(dt, t.ctx);
      n++;
    }
    res.push(n * dt);
  }
  check('幀率無關：停車 3 s 抬上車的時刻誤差 ≤ 1 幀（1/30、1/60、1/144）', res.every((x) => Math.abs(x - PICK_SEC) <= 1 / 30 + 1e-6), res.map((x) => x.toFixed(3)).join(','));
  const res2 = [];
  for (const dt of [1 / 30, 1 / 60, 1 / 144]) {
    const t = started();
    const lim = t.ems.limit;
    let n = 0;
    while (t.ems.active && n < 1e6) {
      t.ems.update(dt, t.ctx);
      n++;
    }
    res2.push(Math.abs(n * dt - lim));
  }
  check('幀率無關：超時時刻誤差 ≤ 1 幀', res2.every((x) => x <= 1 / 30 + 1e-6), res2.map((x) => x.toFixed(4)).join(','));
  const t = started();
  const b = t.ems.timeLeft;
  t.ems.update(3, t.ctx);
  check('dt clamp：單幀 3 s 只算 0.1 s', near(b - t.ems.timeLeft, 0.1, 1e-9));
  while (Math.ceil(t.ems.timeLeft - 1 / 60 - 1e-9) !== Math.ceil(t.ems.timeLeft - 2 / 60 - 1e-9)) t.ems.update(1 / 60, t.ctx); // 避開整秒邊界
  const a1 = t.ems.update(1 / 60, t.ctx);
  const txt = a1.text;
  const a2 = t.ems.update(1 / 60, t.ctx);
  check('snapshot 同一物件、同一秒內任務條字串不重建', a1 === a2 && a2.text === txt);
  const m1 = t.ems.markers([])[0];
  check('標記物件重用、beacons() 同一物件', m1 === t.ems.markers([])[0] && t.ems.beacons() === t.ems.beacons());
}

// ---------- 傷患世界（createCurbPedWorld.spawnPatient，替身 traffic / combat）----------
{
  let now = 0;
  const entries = new Map();
  const knocked = [];
  const combat = {
    entries,
    now: () => now,
    stateOf: (a) => (entries.get(a.id) || { state: 'normal' }).state,
    knockdownActor(actor, opts) {
      const e = entries.get(actor.id);
      if (!e || e.state === 'knockdown') return false;
      e.state = 'knockdown';
      e.stateAt = now;
      knocked.push([actor.id, opts]);
      return true;
    },
  };
  const peds = [];
  const recycled = [];
  const mk = (id, x, z) => {
    const p = { alive: true, actor: { id }, citizen: { id: `c${id}` }, x, z, state: 'walk', brain: { override: null, state: 'wander' }, anim: {} };
    entries.set(id, { state: 'normal', stateAt: 0, dying: false });
    peds.push(p);
    return p;
  };
  const traffic = { peds, _recyclePed: (c) => recycled.push(c) };
  const w = createCurbPedWorld({ traffic, combat, rng: () => 0 });
  const p = mk(1, 50, 0);
  const h = w.spawnPatient({ x: 0, z: 0 }, 30, 110);
  check('spawnPatient：徵用路人 → combat.knockdownActor 倒地（帶輕微衝量）', h && h.p === p && knocked.length === 1 && knocked[0][1].impulse && entries.get(1).state === 'knockdown');
  check('倒地者不再是候選（不重複徵用）', w.spawnPatient({ x: 0, z: 0 }, 30, 110) === null);
  now = 1.4;
  w.update(PATIENT_HOLD_SEC);
  check(`update 每 ${PATIENT_HOLD_SEC} s 刷新倒地計時（combat 不會讓傷患自行起身）`, entries.get(1).stateAt === 1.4);
  now = 1.6;
  w.update(PATIENT_HOLD_SEC / 2);
  check('錯開：未滿 0.5 s 不刷新', entries.get(1).stateAt === 1.4);
  w.update(PATIENT_HOLD_SEC / 2);
  check('滿 0.5 s 刷新', entries.get(1).stateAt === 1.6);
  check('state：位置 / exists', w.state(h).exists && w.state(h).x === 50);
  entries.get(1).state = 'dead';
  check('傷患死亡（combat dead）→ exists false', !w.state(h).exists);
  entries.get(1).state = 'knockdown';
  const p2 = mk(2, 0, 60);
  const h2 = w.spawnPatient({ x: 0, z: 0 }, 30, 110);
  w.board(h2);
  check('board：traffic._recyclePed（抬上車消失）', recycled.includes(p2.citizen) && !w.state(h2).exists);
  w.remove(h);
  now = 5;
  w.update(1);
  check('remove：不再刷新倒地計時（照 combat 正常起身）', entries.get(1).stateAt === 1.6);
}
{
  // ems × curbPedWorld 整合
  let now = 0;
  const entries = new Map();
  const combat = { entries, now: () => now, stateOf: (a) => entries.get(a.id).state, knockdownActor(a) { entries.get(a.id).state = 'knockdown'; return true; } };
  const peds = [];
  const recycled = [];
  for (let i = 0; i < 3; i++) {
    peds.push({ alive: true, actor: { id: i }, citizen: { id: i }, x: 40 + i * 30, z: 0, state: 'walk', brain: { override: null, state: 'wander' } });
    entries.set(i, { state: 'normal', stateAt: 0 });
  }
  const w = createCurbPedWorld({ traffic: { peds, _recyclePed: (c) => recycled.push(c) }, combat, rng: () => 0 });
  const t = makeEms();
  t.ctx.world = w;
  t.ctx.player.x = 0;
  t.ctx.player.z = 0;
  t.ems.start(t.ctx);
  t.ems.update(1 / 30, t.ctx);
  const s = t.ems.slots[0];
  goto(t, s.x + 2, s.z);
  run(t, PICK_SEC + 0.1);
  check('ems × curbPedWorld：倒地路人 → 停 3 s 抬上車（回收）→ deliver', t.ems.phase === 'deliver' && recycled.length === 1);
}

// ---------- 救護車停放（createAmbulanceDepot）----------
{
  const health = new Map();
  const decorated = [];
  const vehicles = {
    vehicles: [],
    adopt(o) {
      const v = { ...o, pos: { x: o.x, z: o.z }, mesh: { id: Math.random() }, driven: false };
      this.vehicles.push(v);
      return v;
    },
    remove(v) {
      this.vehicles.splice(this.vehicles.indexOf(v), 1);
    },
  };
  const dmg = { attach: (v) => health.set(v, 1000), healthOf: (v) => (health.has(v) ? health.get(v) : null) };
  const spot = ambulanceSpot();
  const dep = createAmbulanceDepot({ vehicles, dmg, spot, decorate: (v) => decorated.push(v) });
  check('開局前：沒有救護車', dep.vehicle === null);
  const v = dep.ensure(true);
  check(`ensure(true)：在停放點 adopt ${AMBULANCE_TYPE} 白車（既有車型換色）、v.ambulance、dmg.attach、decorate`, v && v.type === AMBULANCE_TYPE && v.color === AMBULANCE_COLOR && v.ambulance && health.get(v) === 1000 && decorated[0] === v && near(v.x, spot.x) && near(v.yaw, spot.yaw));
  check('isAmbulance：救護車真、一般車假', dep.isAmbulance(v) && !dep.isAmbulance({ type: 'suv' }) && !dep.isAmbulance(null));
  check('ensure(true) 再呼叫：沿用（不重複生成）', dep.ensure(true) === v && vehicles.vehicles.length === 1);
  v.mesh = { id: 'repainted' };
  dep.update(AMB_CHECK_SEC, spot);
  check('噴漆換色重建網格 → 下次檢查重新 decorate', decorated.length === 2 && decorated[1] === v);
  health.set(v, 0);
  v.driven = true;
  dep.update(AMB_CHECK_SEC, { x: spot.x + 500, z: spot.z });
  check('毀損但玩家仍在車上：不補車', vehicles.vehicles.length === 1 && dep.vehicle === v);
  v.driven = false;
  dep.update(AMB_CHECK_SEC, { x: spot.x + 10, z: spot.z });
  check(`毀損棄置、玩家在 ${AMB_RESPAWN_DIST} m 內：殘骸交一般回收（ambulance 旗標清除）、暫不補車`, !v.ambulance && dep.vehicle === null && vehicles.vehicles.length === 1);
  dep.update(AMB_CHECK_SEC - 0.1, { x: spot.x + 500, z: spot.z });
  check(`錯開：${AMB_CHECK_SEC} s 才檢查一次`, dep.vehicle === null);
  dep.update(0.2, { x: spot.x + 500, z: spot.z });
  const v2 = dep.vehicle;
  check('玩家遠離後補一台新救護車', v2 && v2 !== v && v2.ambulance && vehicles.vehicles.length === 2);
  vehicles.remove(v2);
  dep.update(AMB_CHECK_SEC, { x: spot.x + 500, z: spot.z });
  check('救護車被回收（不在 vehicles）→ 補車', dep.vehicle && dep.vehicle !== v2);
}

// ---------- 回歸（cr-p13 審查修正）----------
function fakeCombat() {
  let now = 0;
  const entries = new Map();
  const knocked = [];
  const combat = {
    entries,
    now: () => now,
    stateOf: (a) => (entries.get(a.id) || { state: 'normal' }).state,
    knockdownActor(actor, opts) {
      const e = entries.get(actor.id);
      if (!e || e.state === 'knockdown' || e.state === 'dead') return false;
      e.state = 'knockdown';
      e.stateAt = now;
      knocked.push([actor.id, opts]);
      return true;
    },
  };
  const peds = [];
  const mk = (id, x, z) => {
    const p = { alive: true, actor: { id }, citizen: { id: `c${id}` }, x, z, state: 'walk', brain: { override: null, state: 'wander' }, anim: {} };
    entries.set(id, { state: 'normal', stateAt: 0, dying: false });
    peds.push(p);
    return p;
  };
  return { combat, entries, knocked, peds, mk, setNow: (t) => (now = t) };
}
{
  // 🟡2：傷患被 combat 扶起 → 壓回倒地；dying 即不治（traffic dead → revive 也不復活回任務）；🟡1：徵用期間 pinned
  const f = fakeCombat();
  const recycled = [];
  const w = createCurbPedWorld({ traffic: { peds: f.peds, _recyclePed: (c) => recycled.push(c) }, combat: f.combat, rng: () => 0 });
  const p = f.mk(1, 50, 0);
  const h = w.spawnPatient({ x: 0, z: 0 }, 30, 110);
  check('spawnPatient → citizen.pinned = true（traffic 依距離 / 密度回收跳過）', h && p.citizen.pinned === true);
  f.entries.get(1).state = 'getup';
  w.update(1 / 30);
  check('傷患被扶起（getup）→ 下一幀即壓回倒地（不等 0.5 s 刷新）', f.entries.get(1).state === 'knockdown' && f.knocked.length === 2 && f.knocked[1][1].impulse && w.state(h).exists);
  f.entries.get(1).state = 'normal';
  w.update(1 / 30);
  check('已站起（normal）→ 壓回倒地', f.entries.get(1).state === 'knockdown' && f.knocked.length === 3);
  f.entries.get(1).dying = true;
  check('傷患 dying（hp 歸零、DEAD_HOLD 中）→ exists false（不治）', !w.state(h).exists);
  f.entries.get(1).dying = false; // traffic：dead → combat.revive（原地扶回）
  f.entries.get(1).state = 'knockdown';
  f.entries.get(1).stateAt = -99;
  f.setNow(10);
  w.update(1);
  check('revive 後仍判不治、不再刷新倒地計時 / 壓回', !w.state(h).exists && f.entries.get(1).stateAt === -99 && f.knocked.length === 3);
  w.remove(h);
  check('remove → pinned 解除', p.citizen.pinned === false);
  const p2 = f.mk(2, 0, 60);
  const c2 = p2.citizen;
  const h2 = w.spawnPatient({ x: 0, z: 0 }, 30, 110);
  w.board(h2);
  check('board → pinned 解除後才回收', h2 && c2.pinned === false && recycled.includes(c2));
}
{
  // 🟡2 × ems：傷患被撞到 dying → 任務結束 lost（整合下可達）
  const f = fakeCombat();
  f.mk(1, 40, 0);
  const w = createCurbPedWorld({ traffic: { peds: f.peds, _recyclePed() {} }, combat: f.combat, rng: () => 0 });
  const t = makeEms();
  t.ctx.world = w;
  goto(t, 0, 0);
  t.ems.start(t.ctx);
  t.ems.update(1 / 30, t.ctx);
  check('ems × curbPedWorld：傷患倒地、collect', t.ems.phase === 'collect');
  f.entries.get(1).dying = true;
  t.ems.update(1 / 30, t.ctx);
  check('傷患 dying → 救護車任務結束 lost（傷患不治）、live 交還', !t.ems.active && t.log.some((e) => e[0] === 'ems:end' && e[1].reason === 'lost') && w.live.size === 0);
}
{
  // 🟡6：救護車棄置遠處 → 收回並在停放點補車（醫院永遠有救護車）
  const health = new Map();
  const vehicles = {
    vehicles: [],
    adopt(o) {
      const v = { ...o, pos: { x: o.x, z: o.z }, mesh: { id: Math.random() }, driven: false };
      this.vehicles.push(v);
      return v;
    },
    remove(v) {
      this.vehicles.splice(this.vehicles.indexOf(v), 1);
    },
  };
  const dmg = { attach: (v) => health.set(v, 1000), detach: (v) => health.delete(v), healthOf: (v) => (health.has(v) ? health.get(v) : null) };
  const spot = ambulanceSpot();
  let busy = null;
  const dep = createAmbulanceDepot({ vehicles, dmg, spot, isBusy: (v) => v === busy });
  const v = dep.ensure(true);
  v.pos.x = spot.x + AMB_HOME_DIST - 5;
  check(`停放點 ${AMB_HOME_DIST} m 內小幅移動：沿用`, dep.ensure(true) === v);
  v.pos.x = spot.x + 3000;
  const farAll = { x: spot.x + 1500, z: spot.z };
  dep.update(AMB_CHECK_SEC, { x: v.pos.x + 10, z: v.pos.z });
  check('棄置遠處、玩家就在棄車旁（看得到）：不收回', dep.vehicle === v && vehicles.vehicles.length === 1);
  busy = v;
  dep.update(AMB_CHECK_SEC, farAll);
  check('isBusy（任務中 / 正上車）：不收回', dep.vehicle === v);
  busy = null;
  v.driven = true;
  dep.update(AMB_CHECK_SEC, farAll);
  check('有人駕駛：不收回', dep.vehicle === v);
  v.driven = false;
  dep.update(AMB_CHECK_SEC, { x: spot.x + 10, z: spot.z });
  check(`玩家在停放點 ${AMB_RESPAWN_DIST} m 內：不收回（看不到補車瞬間才換）`, dep.vehicle === v);
  dep.update(AMB_CHECK_SEC, farAll);
  const v2 = dep.vehicle;
  check('玩家離棄車與停放點都遠 → 收回棄車（dmg.detach + vehicles.remove）、停放點補一台', v2 && v2 !== v && !vehicles.vehicles.includes(v) && !health.has(v) && vehicles.vehicles.length === 1 && near(v2.pos.x, spot.x));
  v2.pos.x = spot.x - 3000;
  const v3 = dep.ensure(true);
  check('開局 ensure(true)：遠處的救護車直接收回、停放點重新生成', v3 && v3 !== v2 && vehicles.vehicles.length === 1 && near(v3.pos.x, spot.x));
}

console.log(`${failed === 0 ? 'PASS' : 'FAIL'} ${failed === 0 ? passed : failed}/${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
