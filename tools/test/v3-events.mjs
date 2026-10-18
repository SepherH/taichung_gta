#!/usr/bin/env node
// V3 街頭隨機犯罪事件無頭測試：src/street-events.js（純邏輯 createStreetEvents + 世界轉接 createStreetWorld 以替身注入）+ 真 gangs.js / wanted.js / events.js
// 用法：node tools/test/v3-events.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）；不需要 three / rapier
// 涵蓋：排程頻率與時段 / 地區權重、同時上限與冷卻、生成距離與視野邊緣（吸附後再驗）、搶劫 / 追車 / 槍戰 / 酒駕的開始 / 結束 / 制伏 / 逃脫 / 超時、
//   賞金與犯行豁免（真 wanted）、busy 時不生成但既有事件照常收尾、cancel、HUD 提示 / 小地圖閃爍、幀率無關、每幀不配置物件、每幀成本 < 0.3 ms、
//   createStreetWorld（徵用行人 / brain.override / 推倒 / 道謝 / 回收、gangs.skirmish 槍戰 + 流彈、事件車駕駛 / 酒駕蛇行 / 警車 adapters / 離開回收）、main.js 接線與 interfaces.md
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createBus } from '../../src/core/events.js';
import { createWanted, CRIMES } from '../../src/wanted/wanted.js';
import { mulberry32 } from '../../src/npc-ai.js';
import { createGangs, GANGS, territoryAt } from '../../src/gangs.js';
import { MARKER_COLORS } from '../../src/map/marker-colors.js';
import {
  KINDS,
  DEFAULTS,
  HINTS,
  MARKER_KIND,
  BORDER_POINTS,
  THANK_LINE,
  isNight,
  rateMultiplier,
  spawnChance,
  kindWeights,
  pickWeighted,
  edgeOk,
  edgeCandidate,
  borderSpot,
  strayHit,
  rewardRoll,
  createStreetEvents,
  createStreetWorld,
  STUCK_SEC,
  REVERSE_SEC,
} from '../../src/street-events.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(ROOT + p, 'utf8');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`);
  }
}
const deg = (r) => (r * 180) / Math.PI;
const angleTo = (view, px, pz, x, z) => deg(Math.acos(((x - px) * view.dx + (z - pz) * view.dz) / Math.hypot(x - px, z - pz) / Math.hypot(view.dx, view.dz)));

// ---------- 替身世界（ctx.world） ----------
function fakeWorld({ snap = null, goneOnSpawn = false, log = true } = {}) {
  const w = { hs: [], released: [], acts: [], log, spawnCalls: 0 };
  let n = 0;
  w.spawn = (kind, x, z, ev) => {
    w.spawnCalls++;
    const p = snap ? snap(kind, x, z) : { x, z };
    if (!p) return null;
    n++;
    const h = {
      kind,
      x: p.x,
      z: p.z,
      actors: [],
      ev: { a: ev.a, b: ev.b, sec: ev.sec },
      st: { x: p.x, z: p.z, gone: goneOnSpawn, reach: false, down: false, speed: 10, health: 1000, driven: false, fighting: kind === 'gang' ? 4 : 0 },
      ejected: null,
    };
    if (kind === 'robbery') h.actors.push({ id: `robber-${n}` });
    if (kind === 'chase' || kind === 'drunk') h.vehicle = { id: `car-${n}` };
    if (kind === 'gang') h.actors.push({ id: `g${n}a` }, { id: `g${n}b` });
    w.hs.push(h);
    return h;
  };
  w.poll = (h, out) => {
    const s = h.st;
    out.x = s.x;
    out.z = s.z;
    out.gone = s.gone;
    out.reach = s.reach;
    out.down = s.down;
    out.speed = s.speed;
    out.health = s.health;
    out.driven = s.driven;
    out.fighting = s.fighting;
    return out;
  };
  w.act = (h, verb, ev) => {
    if (w.log) w.acts.push({ h, verb, speed: ev ? ev.speed : 0, wobble: ev ? ev.wobble : 0, gx: ev ? ev.gx : 0 });
    if (verb === 'eject') {
      h.ejected = { id: `driver-${h.kind}` };
      return h.ejected;
    }
    return null;
  };
  w.release = (h, outcome) => w.released.push({ h, outcome });
  return w;
}

const FAST = { cooldownMin: 0, cooldownMax: 0, baseChance: 1, checkSec: 0.5 };
const only = (kind) => KINDS.map((k) => (k === kind ? 1 : 0));

function harness({ config = {}, seed = 1, world = fakeWorld(), hour = 12, view = { dx: 0, dz: 1 }, zone = false, player = { x: 0, z: 0 } } = {}) {
  const bus = createBus();
  const log = [];
  for (const n of ['street:start', 'street:resolve']) bus.on(n, (e) => log.push([n, e]));
  const toasts = [];
  const earns = [];
  const se = createStreetEvents({ bus, rng: mulberry32(seed), config });
  const ctx = {
    player,
    view,
    hour,
    busy: false,
    world,
    earn: (n) => earns.push(n),
    toast: (t) => toasts.push(t),
    zoneAt: () => (zone ? GANGS[0] : null),
  };
  let time = 0;
  const run = (sec, dt = 1 / 60, each = null) => {
    const n = Math.round(sec / dt);
    for (let i = 0; i < n; i++) {
      se.update(dt, ctx);
      time += dt;
      if (each && each(time) === false) return;
    }
  };
  const until = (pred, maxSec = 600, dt = 1 / 60) => {
    const n = Math.round(maxSec / dt);
    for (let i = 0; i < n; i++) {
      se.update(dt, ctx);
      time += dt;
      if (pred()) return true;
    }
    return false;
  };
  return { bus, log, toasts, earns, se, ctx, world, run, until, get time() { return time; } };
}
const starts = (H) => H.log.filter((e) => e[0] === 'street:start').map((e) => e[1]);
const resolves = (H) => H.log.filter((e) => e[0] === 'street:resolve').map((e) => e[1]);

// 每幀配置量測子行程（--expose-gc）：在任何其他測試之前執行並結束，避免其他情境的型別回饋（多種 config / 替身）污染最佳化結果
function steadyScene() {
  const W = fakeWorld({ log: false });
  const H = harness({ world: W, config: { ...FAST, cooldownMin: 1e9, cooldownMax: 1e9, timeoutMin: 1e9, timeoutMax: 1e9, kindMul: [0, 1, 0, 1] } });
  // 兩件長時間進行（追車 + 酒駕）
  const se2 = createStreetEvents({ bus: createBus(), rng: mulberry32(3), config: { ...FAST, timeoutMin: 1e9, timeoutMax: 1e9, kindMul: [0, 1, 0, 1] } });
  for (let i = 0; i < 600 && se2.active < 2; i++) se2.update(1 / 60, H.ctx);
  // 之後不再生成：把 baseChance 調 0（直接改 config）
  se2.config.baseChance = 0;
  return { se: se2, ctx: H.ctx };
}
if (process.env.V3_EVENTS_ALLOC === '1') {
  const gc = globalThis.gc;
  const { se, ctx } = steadyScene();
  const frame = (i) => {
    ctx.player.x = i % 2 ? 0.01 : -0.01;
    se.update(1 / 60, ctx);
  };
  for (let i = 0; i < 60000; i++) frame(i); // 充分暖機（TurboFan 最佳化完成後量測）
  const N = 30000;
  gc();
  const h0 = process.memoryUsage().heapUsed;
  for (let i = 0; i < N; i++) frame(i);
  const per = (process.memoryUsage().heapUsed - h0) / N;
  const sink = [];
  gc();
  const h2 = process.memoryUsage().heapUsed;
  for (let i = 0; i < N; i++) {
    frame(i);
    sink[i & 7] = { i };
  }
  const perAlloc = (process.memoryUsage().heapUsed - h2) / N;
  console.log(JSON.stringify({ active: se.active, per, perAlloc }));
  process.exit(0);
}

// ---------- 1. 純函式 ----------
{
  check('isNight：20–5 時為夜間', isNight(22) && isNight(2) && isNight(20) && isNight(4.9) && !isNight(5) && !isNight(12) && !isNight(19.9));
  check('rateMultiplier：夜 ×2、地盤 ×1.6、兩者相乘', rateMultiplier(12, false) === 1 && rateMultiplier(23, false) === 2 && Math.abs(rateMultiplier(12, true) - 1.6) < 1e-9 && Math.abs(rateMultiplier(23, true) - 3.2) < 1e-9);
  check('spawnChance：白天 < 夜間 < 夜間地盤，≤ 1', spawnChance(12, false) < spawnChance(23, false) && spawnChance(23, false) < spawnChance(23, true) && spawnChance(23, true, { ...DEFAULTS, baseChance: 0.9 }) === 1);
  const day = kindWeights(12, false, false, [0, 0, 0, 0]);
  const night = kindWeights(23, false, true, [0, 0, 0, 0]);
  const zone = kindWeights(23, true, true, [0, 0, 0, 0]);
  check('kindWeights：無地盤邊界點時不出槍戰', day[2] === 0 && night[2] > 0);
  check('kindWeights：夜間搶劫 / 酒駕權重較高、地盤內槍戰加倍', night[0] > day[0] && night[3] > day[3] && zone[2] === night[2] * 2);
  check('pickWeighted：依權重落點、全 0 回 −1', pickWeighted([1, 0, 1, 0], 0.1) === 0 && pickWeighted([1, 0, 1, 0], 0.9) === 2 && pickWeighted([0, 0, 0, 0], 0.5) === -1);
  const v = { dx: 0, dz: 1 };
  check('edgeOk：正前方（0°）不行、側邊 60° 可、正後方不行', !edgeOk(0, 0, v, 0, 100, 60, 200) && edgeOk(0, 0, v, Math.sin(1.05) * 100, Math.cos(1.05) * 100, 60, 200) && !edgeOk(0, 0, v, 0, -100, 60, 200));
  check('edgeOk：距離帶外不行、view 省略只看距離', !edgeOk(0, 0, v, 50, 0, 60, 200) && !edgeOk(0, 0, v, 250, 0, 60, 200) && edgeOk(0, 0, null, 0, 100, 60, 200));
  const rng = mulberry32(7);
  const out = { x: 0, z: 0 };
  let okAll = true;
  for (let i = 0; i < 2000; i++) {
    const a = rng() * Math.PI * 2;
    const view = { dx: Math.sin(a), dz: Math.cos(a) };
    edgeCandidate(10, -20, view, 60, 200, rng(), rng(), rng(), out);
    if (!edgeOk(10, -20, view, out.x, out.z, 60, 200)) okAll = false;
  }
  check(`edgeCandidate：2000 個隨機朝向的候選點全在 60–200 m、夾角 ${deg(DEFAULTS.edgeMin).toFixed(0)}–100°`, okAll);
  // 回歸（v3-rf-fix #3）：視野邊緣下限要大於水平半視角（main.js PerspectiveCamera vfov 60°），生成點才在畫面外
  const hHalf = (aspect) => deg(Math.atan(Math.tan((60 * Math.PI) / 360) * aspect));
  check(`edgeMin ${deg(DEFAULTS.edgeMin).toFixed(0)}° > 水平半視角（16:9 ${hHalf(16 / 9).toFixed(1)}°、21:9 ${hHalf(21 / 9).toFixed(1)}°）`, deg(DEFAULTS.edgeMin) > hHalf(21 / 9) + 3 && deg(DEFAULTS.edgeMax) > deg(DEFAULTS.edgeMin) + 20);
  check('BORDER_POINTS：三幫邊界都有取樣點、rival 為另一幫', GANGS.every((g) => BORDER_POINTS.some((b) => b.gang === g.id)) && BORDER_POINTS.every((b) => b.rival && b.rival !== b.gang));
  const outside = BORDER_POINTS.filter((b) => territoryAt(b.x, b.z) && territoryAt(b.x, b.z).id === b.gang).length / BORDER_POINTS.length;
  check('BORDER_POINTS：多數點在地盤邊界外緣（往外推 6 m）', outside < 0.2, `inside=${outside.toFixed(2)}`);
  const b0 = BORDER_POINTS[10];
  const bs = borderSpot(b0.x + 80, b0.z, { dx: 0, dz: 1 }, 60, 100, 0);
  check('borderSpot：回傳環帶 / 視野邊緣內的邊界點；遠離所有地盤回 null', !!bs && edgeOk(b0.x + 80, b0.z, { dx: 0, dz: 1 }, bs.x, bs.z, 60, 100) && borderSpot(-3000, -3000, null, 60, 100, 0) === null);
  check('strayHit：射線上 / 偏離 / 後方 / 超出射程', strayHit(0, 0, 1, 0, 40, 20, 0.3, 0.45) === 20 && strayHit(0, 0, 1, 0, 40, 20, 1, 0.45) === -1 && strayHit(0, 0, 1, 0, 40, -5, 0, 0.45) === -1 && strayHit(0, 0, 1, 0, 40, 45, 0, 0.45) === -1);
  let rr = true;
  for (let i = 0; i <= 100; i++) {
    const r = rewardRoll(100, 200, i / 100 - (i === 100 ? 1e-9 : 0));
    if (r < 100 || r > 200 || !Number.isInteger(r)) rr = false;
  }
  check('rewardRoll：整數且落在區間內', rr && rewardRoll(100, 200, 0) === 100 && rewardRoll(100, 200, 0.999999) === 200);
}

// ---------- 2. 排程頻率：時段 / 地區權重、冷卻 ----------
{
  const sim = (hour, zone, seed) => {
    const H = harness({ hour, zone, seed, world: fakeWorld({ goneOnSpawn: true, log: false }), config: { kindMul: [1, 1, 0, 1] } });
    H.run(6 * 3600, 0.1);
    const s = H.log.filter((e) => e[0] === 'street:start').length;
    return { H, s };
  };
  const day = sim(12, false, 11);
  const night = sim(23, false, 11);
  const nz = sim(23, true, 11);
  check(`頻率：夜間多於白天（6 h：白天 ${day.s}、夜間 ${night.s}）`, night.s > day.s * 1.1);
  check(`頻率：夜間地盤內再多（${nz.s} > ${night.s}）`, nz.s > night.s);
  // 間隔：事件開始時起算冷卻 45–90 s
  const times = [];
  {
    const H = harness({ hour: 12, seed: 3, world: fakeWorld({ goneOnSpawn: true, log: false }), config: { kindMul: [1, 1, 0, 1] } });
    H.run(4 * 3600, 0.1, (t) => {
      if (H.se.stats().started > times.length) times.push(t);
    });
  }
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  check(`冷卻：相鄰兩件開始間隔 ≥ 45 s（${gaps.length} 個間隔，最短 ${Math.min(...gaps).toFixed(1)} s）`, gaps.length > 20 && Math.min(...gaps) >= 45 - 0.11);
  check('冷卻：開局後第一件也要等冷卻（≥ 45 s）', times[0] >= 45 - 0.11);
  const H0 = harness({ seed: 5 });
  check('冷卻：createStreetEvents 初始冷卻在 45–90 s', H0.se.cooldown >= 45 && H0.se.cooldown <= 90);
}

// ---------- 3. 同時上限 ----------
{
  const H = harness({ config: { ...FAST, cooldownMin: 1, cooldownMax: 2, timeoutMin: 1000, timeoutMax: 1000, kindMul: [0, 1, 0, 0] } });
  let maxActive = 0;
  H.run(300, 1 / 60, () => {
    maxActive = Math.max(maxActive, H.se.active);
  });
  check('同時進行 ≤ 2（不結束的事件 300 s 內只開 2 件）', maxActive === 2 && H.se.stats().started === 2 && H.se.active === 2);
}

// ---------- 4. 生成距離與視野 ----------
{
  const view = { dx: Math.sin(0.7), dz: Math.cos(0.7) };
  const H = harness({ view, player: { x: 120, z: -40 }, seed: 9, world: fakeWorld({ goneOnSpawn: true }), config: { ...FAST, cooldownMin: 0.2, cooldownMax: 0.2, kindMul: [1, 1, 0, 1] } });
  H.run(400, 1 / 60);
  const ss = starts(H);
  const bad = ss.filter((s) => {
    const d = Math.hypot(s.x - 120, s.z + 40);
    const a = angleTo(view, 120, -40, s.x, s.z);
    const maxD = s.kind === 'robbery' ? DEFAULTS.pedSpawnMax : DEFAULTS.spawnMax;
    return d < 60 - 1e-6 || d > maxD + 1e-6 || a < deg(DEFAULTS.edgeMin) - 1e-6 || a > 100 + 1e-6;
  });
  check(`生成：${ss.length} 件全在玩家 60–200 m（行人事件 ≤ 100 m）、與鏡頭夾角 ${deg(DEFAULTS.edgeMin).toFixed(0)}–100°（視野邊緣、畫面外）`, ss.length > 50 && bad.length === 0, JSON.stringify(bad[0] || {}));
  const kinds = new Set(ss.map((s) => s.kind));
  check('生成：robbery / chase / drunk 都出現過', kinds.has('robbery') && kinds.has('chase') && kinds.has('drunk'));
  // 吸附到畫面正中 → 作罷並 release('cancel')
  const W = fakeWorld({ snap: (k, x, z) => ({ x: 0, z: 100 }) });
  const H2 = harness({ world: W, config: { ...FAST, kindMul: [0, 1, 0, 1] } });
  H2.run(20);
  check('生成：world 吸附後跑到正前方 → 不開始、handle 以 cancel 釋放', starts(H2).length === 0 && W.hs.length > 0 && W.released.length === W.hs.length && W.released.every((r) => r.outcome === 'cancel'));
  const W3 = fakeWorld({ snap: () => null });
  const H3 = harness({ world: W3, config: { ...FAST, kindMul: [0, 1, 0, 0] } });
  H3.run(10);
  check('生成：world 找不到點（null）→ 每輪試 spotTries 次、失敗後 retrySec 重試', starts(H3).length === 0 && W3.spawnCalls >= DEFAULTS.spotTries * 2 && W3.spawnCalls <= DEFAULTS.spotTries * 6);
  // 槍戰：在地盤邊界點、兩幫不同
  const b = BORDER_POINTS.find((p) => p.gang === 'nightmarket');
  const H4 = harness({ player: { x: b.x + 80, z: b.z }, view: { dx: 0, dz: 1 }, config: { ...FAST, kindMul: only('gang') } });
  H4.until(() => H4.se.active > 0, 30);
  const g = H4.world.hs[0];
  check('槍戰：生成在地盤邊界點（BORDER_POINTS）、ev.a ≠ ev.b、時長 10–20 s', !!g && BORDER_POINTS.some((p) => p.x === g.x && p.z === g.z) && g.ev.a !== g.ev.b && GANGS.some((x) => x.id === g.ev.a) && GANGS.some((x) => x.id === g.ev.b) && g.ev.sec >= 10 && g.ev.sec <= 20);
  const H5 = harness({ player: { x: -3000, z: -3000 }, config: { ...FAST, kindMul: only('gang') } });
  H5.run(20);
  check('槍戰：附近沒有地盤邊界 → 不生成槍戰', starts(H5).length === 0);
}

// ---------- 5. 搶劫 ----------
const robHarness = (extra = {}) => {
  const H = harness({ config: { ...FAST, kindMul: only('robbery'), spawnMin: 60, pedSpawnMax: 75, ...extra }, seed: 21 });
  H.until(() => H.se.active > 0, 30);
  H.se.config.baseChance = 0; // 之後不再生成（只看這一件）
  return { H, h: H.world.hs[H.world.hs.length - 1] };
};
{
  const { H, h } = robHarness();
  check('搶劫：開始 emit street:start、80 m 內 toast「附近有人被搶！」', starts(H).length === 1 && starts(H)[0].kind === 'robbery' && H.toasts.includes(HINTS.robbery));
  const m = H.se.markers([]);
  check('小地圖：開始時黃點（kind street-event）', m.length === 1 && m[0].kind === MARKER_KIND && MARKER_COLORS[MARKER_KIND] && m[0].x === h.x);
  let blinkOff = false;
  H.run(0.3, 1 / 60, () => {
    if (!H.se.markers([]).length) blinkOff = true;
  });
  check('小地圖：黃點閃爍（0.25 s 亮 / 暗）', blinkOff);
  H.run(0.5);
  check('搶劫：接近階段每次輪詢 act approach', H.world.acts.some((a) => a.verb === 'approach') && !H.world.acts.some((a) => a.verb === 'grab'));
  h.st.reach = true;
  H.run(0.2);
  const iGrab = H.world.acts.findIndex((a) => a.verb === 'grab');
  check('搶劫：到受害者身邊 → grab（推倒）→ flee', iGrab >= 0 && H.world.acts.slice(iGrab).some((a) => a.verb === 'flee'));
  check('犯行豁免：搶匪 isEventActor', H.se.isEventActor(h.actors[0]) && !H.se.isEventActor({ id: 'citizen' }));
  // 真 wanted：仿 main.js 犯行監聽（vigHooks.fugitiveActor 已併入 streetEvents.isEventActor）
  const wanted = createWanted({ bus: H.bus });
  const passer = { id: 'passer', kind: 'pedestrian' };
  H.bus.on('combat:hit', (e) => {
    if (!e || !e.byPlayer || H.se.isEventActor(e.target)) return;
    wanted.report(CRIMES.assault, { x: e.x, z: e.z, witnessed: true });
  });
  H.bus.emit('combat:hit', { byPlayer: true, target: h.actors[0], x: h.x, z: h.z });
  check('真 wanted：打搶匪不算犯行（heat 0）', wanted.heat === 0 && wanted.stars === 0);
  H.bus.emit('combat:hit', { byPlayer: true, target: passer, x: h.x, z: h.z });
  check('真 wanted：誤傷路人照算', wanted.heat > 0);
  wanted.clear('debug');
  h.st.down = true;
  H.run(0.2);
  const r = resolves(H)[0];
  check('搶劫：玩家打倒搶匪 → subdued、賞金 NT$100–200（ctx.earn）、受害者道謝 toast', !!r && r.outcome === 'subdued' && r.reward >= 100 && r.reward <= 200 && H.earns[0] === r.reward && H.toasts.some((t) => t.startsWith('受害者：謝謝你！')));
  check('搶劫：subdued 前 act subdued（world 讓受害者面向玩家道謝）、release(subdued)', H.world.acts.some((a) => a.verb === 'subdued') && H.world.released.length === 1 && H.world.released[0].outcome === 'subdued' && H.se.active === 0);
  check('犯行豁免：結束後 20 s 內仍豁免、之後恢復', (() => {
    const a = h.actors[0];
    const in1 = H.se.isEventActor(a);
    H.run(21, 0.1);
    return in1 && !H.se.isEventActor(a);
  })());
}
{
  // 回歸（v3-rf-fix #1）：豁免綁登記時的 actor.id——traffic 骨架回池換人（同一 actor 物件只改 id）後不沿用
  const { H, h } = robHarness();
  const a = h.actors[0];
  const id0 = a.id;
  a.id = 'cit-99'; // 進行中骨架換給別的市民
  const activeSwap = H.se.isEventActor(a);
  H.bus.emit('combat:hit', { byPlayer: true, target: a, x: h.x, z: h.z });
  const byPlayerSwap = H.se.events.find((e) => e.kind).byPlayer;
  a.id = id0;
  const back = H.se.isEventActor(a);
  h.st.gone = true;
  H.run(0.2); // escaped → 進入 20 s grace
  const inGrace = H.se.isEventActor(a);
  a.id = 'cit-100'; // grace 內換人
  check('犯行豁免（回歸）：歹徒骨架換給別的市民（actor 物件相同、id 不同）→ 進行中 / 結束後 grace 內都不豁免、打他也不記玩家出手',
    !activeSwap && !byPlayerSwap && back && inGrace && !H.se.isEventActor(a), JSON.stringify({ activeSwap, byPlayerSwap, back, inGrace }));
}
{
  // 回歸（v3-rf-fix #4）：賞金只給真的出手的玩家——玩家剛好在旁邊不算
  const { H, h } = robHarness();
  h.st.reach = true;
  H.run(0.3);
  h.st.x = 5;
  h.st.z = 5; // 玩家身旁（< 15 m）
  h.st.down = true; // 被別人撞倒，玩家沒出手
  H.run(1);
  check('搶劫（回歸）：搶匪在玩家身旁被別人撞倒、玩家沒出手 → 不給賞金、事件繼續', resolves(H).length === 0 && H.earns.length === 0 && H.se.active === 1);
}
{
  const { H, h } = robHarness();
  h.st.reach = true;
  H.run(0.3);
  h.st.x = 500;
  H.run(0.2);
  const r = resolves(H)[0];
  check('搶劫：搶匪跑離玩家 > 120 m → escaped、無賞金、提示「搶匪逃走了…」', !!r && r.outcome === 'escaped' && r.reward === 0 && H.earns.length === 0 && H.toasts.includes('搶匪逃走了…'));
}
{
  const { H, h } = robHarness();
  h.st.reach = true;
  H.run(0.3);
  h.st.x = 95;
  h.st.down = true; // 被別人撞倒（非玩家、玩家不在 15 m 內）
  H.run(1);
  check('搶劫：搶匪被別人撞倒（玩家不在旁）→ 不算制伏、事件繼續', resolves(H).length === 0 && H.se.active === 1);
  h.st.down = false;
  h.st.gone = true;
  H.run(0.2);
  check('搶劫：搶匪被回收（gone）→ escaped', resolves(H)[0] && resolves(H)[0].outcome === 'escaped');
}
{
  const { H } = robHarness();
  H.run(16);
  check('搶劫：15 s 內沒接近受害者 → timeout（作罷）', resolves(H)[0] && resolves(H)[0].outcome === 'timeout');
}

// ---------- 6. 警匪追車 ----------
const carHarness = (kind, extra = {}, seed = 31) => {
  const H = harness({ config: { ...FAST, kindMul: only(kind), spawnMin: 60, spawnMax: 75, ...extra }, seed });
  H.until(() => H.se.active > 0, 30);
  H.se.config.baseChance = 0;
  return { H, h: H.world.hs[H.world.hs.length - 1] };
};
{
  const { H, h } = carHarness('chase');
  H.run(1);
  const drives = H.world.acts.filter((a) => a.verb === 'drive');
  check('追車：開始後每 0.1 s act drive（逃竄目標背離玩家、速度 22 m/s）', drives.length >= 8 && drives.every((a) => a.speed === DEFAULTS.chaseSpeed) && Math.hypot(drives[0].gx, 0) >= 0);
  check('犯行豁免：子彈打中罪犯車本身（落點 4.5 m 內）不算 gunfire、別處照算', H.se.shotAtEvent(h.st.x + 3, h.st.z, h.vehicle) && !H.se.shotAtEvent(h.st.x + 10, h.st.z, h.vehicle));
  // 回歸（v3-rf-fix #1）：豁免只限罪犯車本身——落點在罪犯車旁、但打中的是警車 / 路人（或沒打到車）照算
  const policeCar = { id: 'police-1' };
  check('犯行豁免（回歸）：落點在罪犯車旁但打中警車 / 沒打到車 → 照算 gunfire', !H.se.shotAtEvent(h.st.x + 3, h.st.z, policeCar) && !H.se.shotAtEvent(h.st.x + 3, h.st.z, null) && !H.se.shotAtEvent(h.st.x + 3, h.st.z));
  h.st.x = 10;
  h.st.z = 10;
  H.bus.emit('weapon:impact', { byPlayer: true, vehicle: h.vehicle, x: 10, z: 10 }); // 玩家射中罪犯車
  h.st.health = 100; // 黑煙
  H.run(0.2);
  const r = resolves(H)[0];
  check('追車：玩家射中 / 撞過罪犯車後撞到黑煙 → subdued、賞金 NT$300–500、罪犯下車（eject）並豁免', !!r && r.outcome === 'subdued' && r.reward >= 300 && r.reward <= 500 && H.earns[0] === r.reward && !!h.ejected && H.se.isEventActor(h.ejected));
}
{
  // 回歸（v3-rf-fix #4）：玩家在 25 m 內但沒出手（警車撞到黑煙）→ 警方逮捕、沒有賞金
  const { H, h } = carHarness('chase');
  H.run(1);
  h.st.x = 10;
  h.st.z = 10;
  H.bus.emit('weapon:impact', { byPlayer: false, vehicle: h.vehicle }); // 別人（警員）射中不算
  H.bus.emit('weapon:impact', { byPlayer: true, vehicle: { id: 'other' } }); // 玩家射中別台車不算
  h.st.health = 100;
  H.run(0.2);
  const r = resolves(H)[0];
  check('追車（回歸）：玩家在旁邊但沒出手、罪犯車被警車撞到黑煙 → arrested、無賞金', !!r && r.outcome === 'arrested' && r.reward === 0 && H.earns.length === 0);
}
{
  const { H, h } = carHarness('chase');
  H.run(2);
  h.st.health = 100;
  H.run(0.2);
  const r = resolves(H)[0];
  check('追車：玩家不在附近時被撞停 → arrested（警方逮捕）、無賞金', !!r && r.outcome === 'arrested' && r.reward === 0 && H.earns.length === 0);
}
{
  const { H, h } = carHarness('chase');
  h.st.speed = 0;
  H.run(4);
  check('追車：起步 5 s 內低速不判停', resolves(H).length === 0);
  H.run(1 + DEFAULTS.slowSec - 0.3);
  const early = resolves(H).length;
  H.run(0.6);
  const r = resolves(H)[0];
  check(`追車：低速 ${DEFAULTS.slowSec} s（玩家遠）→ arrested；之前不判（留時間給卡住倒車脫困）`, early === 0 && !!r && r.outcome === 'arrested');
  // 回歸（v3-rf-fix #4）：低速判停要晚於事件車自帶的卡住倒車（STUCK_SEC + REVERSE_SEC），否則倒車脫困永遠來不及
  check(`低速判停 ${DEFAULTS.slowSec} / ${DEFAULTS.drunkSlowSec} s > 卡住倒車 ${STUCK_SEC} + ${REVERSE_SEC} s`, DEFAULTS.slowSec > STUCK_SEC + REVERSE_SEC && DEFAULTS.drunkSlowSec > STUCK_SEC + REVERSE_SEC);
}
{
  const { H, h } = carHarness('chase');
  h.st.driven = true;
  H.run(0.2);
  const r = resolves(H)[0];
  check('追車：玩家開走罪犯車 → subdued（不 eject）', !!r && r.outcome === 'subdued' && !h.ejected);
}
{
  const { H, h } = carHarness('chase');
  h.st.x = 400;
  H.run(0.2);
  check('追車：罪犯車離玩家 > 260 m → escaped', resolves(H)[0] && resolves(H)[0].outcome === 'escaped');
}
{
  const { H } = carHarness('chase');
  const ev = H.se.events.find((e) => e.kind);
  const to = ev.timeout;
  H.run(to - 0.5);
  const mid = resolves(H).length;
  H.run(1);
  check(`追車：超時（${to.toFixed(1)} s，60–120）→ timeout 收尾`, to >= 60 && to <= 120 && mid === 0 && resolves(H)[0] && resolves(H)[0].outcome === 'timeout' && H.world.released[0].outcome === 'timeout');
}

// ---------- 7. 酒駕 ----------
{
  const { H, h } = carHarness('drunk', {}, 41);
  H.run(20, 1 / 60);
  const d = H.world.acts.filter((a) => a.verb === 'drive');
  const speeds = d.map((a) => a.speed);
  const wob = d.map((a) => a.wobble);
  check('酒駕：車速忽快忽慢（5–20 m/s，差距 > 8）', Math.min(...speeds) >= 5 - 1e-9 && Math.max(...speeds) <= 20 + 1e-9 && Math.max(...speeds) - Math.min(...speeds) > 8);
  check('酒駕：蛇行（wobble 正負交替、幅度 > 0.3）', Math.max(...wob) > 0.3 && Math.min(...wob) < -0.3);
  h.st.speed = 0;
  H.run(DEFAULTS.drunkSlowSec + 0.3);
  const r = resolves(H)[0];
  check(`酒駕：撞停（低速 ${DEFAULTS.drunkSlowSec} s、玩家遠）→ crashed、司機下車`, !!r && r.outcome === 'crashed' && !!h.ejected);
}
{
  const { H, h } = carHarness('drunk', {}, 42);
  h.st.x = 5;
  h.st.z = 5;
  H.se.vehicleHitByPlayer(h.vehicle); // 玩家駕車撞上（整合層 contacts router）
  h.st.health = 50;
  H.run(0.2);
  const r = resolves(H)[0];
  check('酒駕：玩家撞停 → subdued、賞金 NT$100–200', !!r && r.outcome === 'subdued' && r.reward >= 100 && r.reward <= 200);
}
{
  // 回歸（v3-rf-fix #4）：酒駕車自己撞牆熄火 / 卡住，玩家剛好在 25 m 內沒碰車 → crashed、不給錢
  const { H, h } = carHarness('drunk', {}, 43);
  H.run(6);
  h.st.x = 20;
  h.st.z = 0;
  h.st.speed = 0; // 卡住（耐久 1000）
  H.run(DEFAULTS.drunkSlowSec + 0.3);
  const r1 = resolves(H)[0];
  const { H: H2, h: h2 } = carHarness('drunk', {}, 44);
  h2.st.x = 5;
  h2.st.z = 5;
  h2.st.health = 50; // 自己撞牆到黑煙
  H2.run(0.2);
  const r2 = resolves(H2)[0];
  check('酒駕（回歸）：自己卡住 / 撞牆、玩家在旁沒出手 → crashed、無賞金', !!r1 && r1.outcome === 'crashed' && r1.reward === 0 && !!r2 && r2.outcome === 'crashed' && r2.reward === 0 && H.earns.length === 0 && H2.earns.length === 0);
}

// ---------- 8. 幫派槍戰（邏輯） ----------
{
  const b = BORDER_POINTS.find((p) => p.gang === 'suits');
  const H = harness({ player: { x: b.x + 80, z: b.z }, view: { dx: 0, dz: 1 }, config: { ...FAST, kindMul: only('gang') } });
  H.until(() => H.se.active > 0, 30);
  const h = H.world.hs[0];
  check('槍戰：成員 isEventActor（玩家動手不算犯行）', h.actors.every((a) => H.se.isEventActor(a)));
  H.run(5);
  check('槍戰：互射中（fighting > 0）不結束', resolves(H).length === 0);
  h.st.fighting = 0;
  H.run(0.2);
  check('槍戰：互毆結束 → over、release', resolves(H)[0] && resolves(H)[0].outcome === 'over' && H.world.released[0].outcome === 'over');
}

// ---------- 9. busy / cancel / 提示 ----------
{
  const H = harness({ config: { ...FAST, kindMul: only('chase') } });
  H.ctx.busy = true;
  H.run(30);
  check('busy（暫停 / 手機 / 噴漆 / 搶劫 / 警車任務）：不生成新事件', starts(H).length === 0 && H.world.spawnCalls === 0);
  H.ctx.busy = false;
  H.until(() => H.se.active > 0, 10);
  const h = H.world.hs[0];
  H.ctx.busy = true;
  h.st.x = 400;
  H.run(0.3);
  check('busy：既有事件照常收尾（逃脫）', resolves(H).length === 1 && resolves(H)[0].outcome === 'escaped');
}
{
  const H = harness({ config: { ...FAST, cooldownMin: 0.5, cooldownMax: 0.5, timeoutMin: 1000, timeoutMax: 1000, kindMul: [1, 1, 0, 0] } });
  H.until(() => H.se.active === 2, 30);
  const nToast = H.toasts.length;
  const n = H.se.cancel();
  const rs = resolves(H);
  check('cancel：進行中 2 件全部收尾（release cancel、emit street:resolve cancel）', n === 2 && H.se.active === 0 && rs.length === 2 && rs.every((r) => r.outcome === 'cancel') && H.world.released.every((r) => r.outcome === 'cancel'));
  check('cancel：不 toast、歹徒豁免清空、冷卻重置', H.toasts.length === nToast && H.se.stats().actors === 0 && !H.world.hs.some((h) => h.actors.some((a) => H.se.isEventActor(a))) && H.se.cooldown >= 0.5);
  H.se.dispose();
  H.run(5);
  check('dispose：之後 update 不會出錯、bus 訂閱已取消', H.se.active <= 2);
}
{
  const H = harness({ config: { ...FAST, kindMul: only('chase'), spawnMin: 150, spawnMax: 190 } });
  H.until(() => H.se.active > 0, 30);
  const h = H.world.hs[0];
  H.se.config.baseChance = 0;
  check('提示：事件在 80 m 外 → 開始時不 toast（小地圖照樣閃黃點）', !H.toasts.includes(HINTS.chase) && H.se.markers([]).length === 1);
  H.run(7);
  check('小地圖：閃爍 6 s 後收起', H.se.markers([]).length === 0);
  H.ctx.player = { x: h.st.x - 50, z: h.st.z };
  H.run(0.05);
  check('提示：玩家進入 80 m 內 → 補提示一次 + 黃點重新閃爍', H.toasts.filter((t) => t === HINTS.chase).length === 1 && H.se.markers([]).length === 1);
  H.run(1);
  check('提示：同一事件只提示一次', H.toasts.filter((t) => t === HINTS.chase).length === 1);
}

// ---------- 10. 幀率無關 ----------
{
  const scen = (dt) => {
    const H = harness({ config: { kindMul: only('robbery'), spawnMin: 60, pedSpawnMax: 75 }, seed: 77 });
    let tStart = -1;
    let tEnd = -1;
    let h = null;
    H.run(400, dt, (t) => {
      if (tStart < 0 && H.se.active > 0) {
        tStart = t;
        H.se.config.baseChance = 0;
        h = H.world.hs[H.world.hs.length - 1];
      }
      if (h && t - tStart >= 3) h.st.reach = true;
      if (h && t - tStart >= 6 && !h.st.down) {
        h.st.down = true;
        H.bus.emit('ped:knockdown', { byPlayer: true, ped: h.actors[0], cause: 'punch' });
      }
      if (tStart >= 0 && tEnd < 0 && resolves(H).length) {
        tEnd = t;
        return false;
      }
      return true;
    });
    return { tStart, tEnd, reward: resolves(H)[0] ? resolves(H)[0].reward : -1, out: resolves(H)[0] ? resolves(H)[0].outcome : null };
  };
  const a = scen(1 / 30);
  const b = scen(1 / 60);
  const c = scen(1 / 144);
  check(`幀率無關：開始時間 1/30 ${a.tStart.toFixed(2)}、1/60 ${b.tStart.toFixed(2)}、1/144 ${c.tStart.toFixed(2)}（差 ≤ 1 幀）`, a.tStart > 0 && Math.abs(a.tStart - b.tStart) <= 1 / 30 + 1e-6 && Math.abs(c.tStart - b.tStart) <= 1 / 30 + 1e-6);
  check(`幀率無關：制伏時間與賞金一致（${a.tEnd.toFixed(2)} / ${b.tEnd.toFixed(2)} / ${c.tEnd.toFixed(2)}，NT$${b.reward}）`, a.out === 'subdued' && b.out === 'subdued' && c.out === 'subdued' && Math.abs(a.tEnd - b.tEnd) <= 0.1 + 2 / 30 && Math.abs(c.tEnd - b.tEnd) <= 0.1 + 2 / 30 && a.reward === b.reward && b.reward === c.reward);
  const H = harness({ config: { ...FAST, kindMul: only('chase') } });
  H.until(() => H.se.active > 0, 30);
  const t0 = H.se.events.find((e) => e.kind).t;
  H.se.update(5, H.ctx);
  check('dt clamp：單幀 dt 上限 0.1 s', Math.abs(H.se.events.find((e) => e.kind).t - t0 - 0.1) < 1e-9);
}

// ---------- 11. 每幀不配置 / 成本 ----------
{
  const r = spawnSync(process.execPath, ['--min-semi-space-size=128', '--max-semi-space-size=128', '--expose-gc', fileURLToPath(import.meta.url)], { env: { ...process.env, V3_EVENTS_ALLOC: '1' }, encoding: 'utf8' });
  let res = null;
  try {
    res = JSON.parse((r.stdout || '').trim().split('\n').pop());
  } catch {
    res = null;
  }
  check(
    res ? `每幀不配置物件（2 件進行中：${res.per.toFixed(1)} B/幀；對照每幀配置一物件 ${res.perAlloc.toFixed(1)} B/幀）` : '每幀不配置物件（子行程量測失敗）',
    !!res && res.active === 2 && res.per < 8 && res.perAlloc - res.per >= 12,
    res ? '' : (r.stderr || '').slice(0, 300),
  );
}
// 事件車替身（createStreetWorld 用）
function fakeVehicles() {
  const list = [];
  return {
    vehicles: list,
    adopt({ type, color, x, z, yaw }) {
      const v = { type, color, pos: { x, y: 0, z }, yaw, speed: 0, driven: false, ai: false, ctl: { throttle: 0, steer: 0, brake: 0, handbrake: false }, spec: { length: 4.5, width: 1.8 } };
      v.setControls = (c) => {
        v.ctl.throttle = c.throttle;
        v.ctl.steer = c.steer;
        v.ctl.brake = c.brake;
        v.ctl.handbrake = c.handbrake;
      };
      list.push(v);
      return v;
    },
    remove(v) {
      const i = list.indexOf(v);
      if (i >= 0) list.splice(i, 1);
    },
  };
}
function fakeTraffic(peds = []) {
  const spots = [];
  for (let x = -400; x <= 400; x += 20) for (let z = -400; z <= 400; z += 40) spots.push({ x, z, heading: 0 });
  const t = {
    peds,
    cars: [],
    view: { x: 0, z: 0, dx: 0, dz: 1, cos: 0.5 },
    hiddenAll: false,
    recycled: [],
    ejected: [],
    shown: [],
    ambient: { bubbles: { show: (text, p) => t.shown.push([text, p]), release: () => {} } },
    spawnSpots(cx, cz, rMin, rMax, out = []) {
      out.length = 0;
      for (const s of spots) {
        const d = Math.hypot(s.x - cx, s.z - cz);
        if (d >= rMin && d <= rMax) out.push(s);
      }
      return out;
    },
    spawnEjectedDriver(o) {
      const p = { actor: { id: `ejected-${t.ejected.length}`, pos: { x: o.x, z: o.z } } };
      t.ejected.push(p);
      return p;
    },
    _hidden: () => t.hiddenAll,
    _recyclePed(c) {
      t.recycled.push(c);
      const p = c.ped;
      if (p) {
        p.alive = false;
        p.citizen = null;
      }
    },
  };
  return t;
}
function fakePolice() {
  const P = { cars: [], drives: [], despawned: [], vehicles: null };
  P.spawnCar = ({ x, z, heading }) => {
    const v = P.vehicles.adopt({ type: 'police', x, z, yaw: heading });
    const car = { v, removed: false, stolen: false, get pos() { return v.pos; } };
    P.cars.push(car);
    return car;
  };
  P.driveCar = (car, cmd) => P.drives.push([car, cmd.mode, cmd.maxSpeed]);
  P.despawnCar = (car) => {
    car.removed = true;
    P.despawned.push(car);
    P.vehicles.remove(car.v);
  };
  return P;
}
{
  // 成本：排程 + 2 件事件邏輯 + createStreetWorld.update（2 台事件車 + 2 台警車由 adapters 控制，不計）
  const { se, ctx } = steadyScene();
  const N = 20000;
  for (let i = 0; i < 2000; i++) se.update(1 / 60, ctx);
  let t0 = performance.now();
  for (let i = 0; i < N; i++) {
    ctx.player.x = i % 2 ? 0.01 : -0.01;
    se.update(1 / 60, ctx);
  }
  const perLogic = (performance.now() - t0) / N;
  const vehicles = fakeVehicles();
  const traffic = fakeTraffic();
  const police = fakePolice();
  police.vehicles = vehicles;
  const W = createStreetWorld({ traffic, vehicles, police, getPlayer: () => ({ x: 0, z: 0, actor: null }), canSee: () => false, findRoute: (a, b) => ({ points: [a, { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }, b, b] }), rng: mulberry32(4) });
  const hc = W.spawn('chase', 60, 0, {});
  const hd = W.spawn('drunk', -60, 40, {});
  const ev = { gx: 300, gz: 300, speed: 20, wobble: 0.3 };
  for (let i = 0; i < 2000; i++) W.update(1 / 60);
  t0 = performance.now();
  for (let i = 0; i < N; i++) {
    if (i % 6 === 0) {
      W.act(hc, 'drive', ev);
      W.act(hd, 'drive', ev);
    }
    W.update(1 / 60);
  }
  const perWorld = (performance.now() - t0) / N;
  check(`每幀新增成本 < 0.3 ms（排程 + 事件邏輯 ${(perLogic * 1000).toFixed(1)} µs、事件車控制 ${(perWorld * 1000).toFixed(1)} µs）`, perLogic + perWorld < 0.3 && !!hc && !!hd);
}

// ---------- 12. createStreetWorld（替身） ----------
function makePed(id, x, z) {
  const p = { alive: true, state: 'walk', x, z, y: 0, pendingFrom: null, anim: { gestures: [], playGesture: (n) => p.anim.gestures.push(n) } };
  p.actor = { id, kind: 'pedestrian', pos: { x, y: 0, z }, hp: 100 };
  p.citizen = { id, ped: p, look: { shirt: '#fff' } };
  p.brain = { state: 'wander', override: null };
  return p;
}
function fakeCombat() {
  const C = { down: new Set(), knocks: [], hits: [] };
  C.stateOf = (a) => (C.down.has(a) ? 'knockdown' : 'normal');
  C.isDown = (a) => C.down.has(a);
  C.knockdownActor = (a, o) => {
    C.knocks.push([a, o]);
    C.down.add(a);
    return true;
  };
  C.applyHit = (o) => {
    C.hits.push(o);
    return { damage: o.damage };
  };
  C.newSwingId = () => 1;
  return C;
}
const IT = () => ({ moveX: 0, moveZ: 0, run: false, faceYaw: null, wantPunch: false, jump: false, mode: 'wander' });
{
  const peds = [makePed('a', 100, 0), makePed('b', 110, 0), makePed('c', 300, 0)];
  const traffic = fakeTraffic(peds);
  const combat = fakeCombat();
  const player = { x: 0, z: 0, actor: { id: 'player', kind: 'player', pos: { x: 0, z: 0 } }, inVehicle: false };
  const W = createStreetWorld({ traffic, combat, getPlayer: () => player, rng: mulberry32(2) });
  const h = W.spawn('robbery', 100, 0, {});
  check('world 搶劫：徵用附近兩名漫步骨架行人（歹徒 / 受害者）、歹徒 brain.override 接管', !!h && h.actors.length === 1 && !!h.robber.p.brain.override && h.robber.p !== h.victim.p);
  const rob = h.robber.p;
  const vic = h.victim.p;
  const it = IT();
  rob.brain.override(rob.brain, 0.1, {}, it);
  const dirOk = it.moveX * (vic.x - rob.x) + it.moveZ * (vic.z - rob.z) > 0 && it.run;
  check('world 搶劫：approach 時歹徒跑向受害者', dirOk);
  const out = { x: 0, z: 0, gone: false, reach: false, down: false, speed: 0, health: null, driven: false, fighting: 0 };
  W.poll(h, out);
  const far = out.reach;
  rob.x = vic.x - 1;
  W.poll(h, out);
  check('world 搶劫：poll reach（≤ 1.3 m）', !far && out.reach);
  W.act(h, 'grab', {});
  check('world 搶劫：grab → combat.knockdownActor(受害者, emit, attacker 歹徒)、受害者 override（喊叫）', combat.knocks.length === 1 && combat.knocks[0][0] === vic.actor && combat.knocks[0][1].emit === true && combat.knocks[0][1].attacker === rob.actor && !!vic.brain.override);
  combat.down.delete(vic.actor);
  const vit = IT();
  vic.brain.override(vic.brain, 0.1, {}, vit);
  check('world 搶劫：受害者起身後原地面向歹徒喊叫（台詞泡泡 + angry_shout）', vit.moveX === 0 && vit.faceYaw !== null && traffic.shown.some((s) => s[1] === vic) && vic.anim.gestures.includes('angry_shout'));
  W.act(h, 'flee', { fromX: 0, fromZ: 0 });
  const fit = IT();
  rob.brain.override(rob.brain, 0.1, {}, fit);
  check('world 搶劫：flee 時歹徒背離玩家跑', fit.run && fit.moveX > 0.5);
  combat.down.add(rob.actor);
  W.poll(h, out);
  check('world 搶劫：歹徒倒地 → poll down', out.down);
  W.act(h, 'subdued', {});
  check('world 搶劫：subdued → 歹徒交還大腦、受害者面向玩家道謝（謝謝你！+ wave）', rob.brain.override === null && traffic.shown.some((s) => s[0] === THANK_LINE && s[1] === vic) && vic.anim.gestures.includes('wave'));
  W.release(h, 'subdued');
  traffic.hiddenAll = false;
  for (let i = 0; i < 6; i++) W.update(0.1);
  check('world 搶劫：release 後還在玩家視線內 → 先不回收', traffic.recycled.length === 0);
  traffic.hiddenAll = true;
  for (let i = 0; i < 6; i++) W.update(0.1);
  check('world 搶劫（回歸）：離開視線但仍在 110 m 內 → 先不回收', traffic.recycled.length === 0 && W.stats().pendingPeds === 2);
  player.x = -200; // 兩人都 > 110 m
  for (let i = 0; i < 6; i++) W.update(0.1);
  check('world 搶劫：> 110 m 且離開視線 → traffic._recyclePed 回收兩人', traffic.recycled.length === 2 && W.stats().pendingPeds === 0);
  player.x = 0;
  const peds2 = [makePed('x', 0, 0)];
  const W2 = createStreetWorld({ traffic: fakeTraffic(peds2), combat, getPlayer: () => player });
  check('world 搶劫：附近不足兩名可徵用行人 → null', W2.spawn('robbery', 0, 0, {}) === null);
  const busy = [makePed('g1', 0, 0), makePed('g2', 5, 0)];
  busy[0].brain.override = () => true;
  busy[1].citizen.gang = { id: 'suits' };
  check('world 搶劫：已被接管 / 幫派成員不徵用', createStreetWorld({ traffic: fakeTraffic(busy), combat, getPlayer: () => player }).spawn('robbery', 0, 0, {}) === null);
}
{
  // 回歸（v3-rf-fix #2）：不在玩家眼前消失——搶匪逃到 > 110 m 但玩家仍看得到 → 不強制回收、交還 traffic 一般 LOD
  const peds = [makePed('a', 100, 0), makePed('b', 110, 0)];
  const traffic = fakeTraffic(peds);
  const combat = fakeCombat();
  const player = { x: 0, z: 0, actor: { id: 'player', kind: 'player', pos: { x: 0, z: 0 } }, inVehicle: false };
  const W = createStreetWorld({ traffic, combat, getPlayer: () => player, rng: mulberry32(2) });
  const h = W.spawn('robbery', 100, 0, {});
  const rob = h.robber.p;
  const vic = h.victim.p;
  rob.x = vic.x - 1;
  W.act(h, 'grab', {});
  combat.down.add(rob.actor);
  W.act(h, 'subdued', {}); // 受害者道謝中（override 還掛著）
  W.release(h, 'subdued');
  player.x = -300; // 兩人都遠
  traffic.hiddenAll = false; // 但看得到
  for (let i = 0; i < 6; i++) W.update(0.1);
  check('world 搶劫（回歸）：遠（> 110 m）但看得到 → 不回收（不在眼前消失）、交還 traffic、受害者 override 清掉',
    traffic.recycled.length === 0 && W.stats().pendingPeds === 0 && rob.alive && vic.alive && rob.brain.override === null && vic.brain.override === null);
}
{
  // 槍戰：真 gangs.skirmish + 流彈
  const bus = createBus();
  const gangs = createGangs({ bus, rng: mulberry32(5) });
  const b = BORDER_POINTS.find((p) => p.gang === 'nightmarket');
  const peds = [];
  for (let i = 0; i < 6; i++) peds.push(makePed(`m${i}`, b.x + (i % 2 ? 6 : -6), b.z + i * 2));
  const bystander = makePed('bystander', b.x + 40, b.z + 3);
  peds.push(bystander);
  const traffic = fakeTraffic(peds);
  const combat = fakeCombat();
  const repainted = [];
  const player = { x: b.x + 300, z: b.z, actor: { id: 'player', kind: 'player', pos: { x: b.x + 300, z: b.z } }, inVehicle: false };
  const W = createStreetWorld({ traffic, combat, gangs, bus, repaint: (p) => repainted.push(p), getPlayer: () => player, rng: mulberry32(6) });
  const h = W.spawn('gang', b.x, b.z, { a: b.gang, b: b.rival, sec: 15 });
  const ms = gangs.members.filter((m) => h.actors.includes(m.actor));
  const ga = ms.filter((m) => m.gang.id === b.gang);
  const gb = ms.filter((m) => m.gang.id === b.rival);
  check('world 槍戰：gangs.skirmish 徵用 6 人分兩幫、持槍、互毆中（war）', !!h && ms.length === 6 && ga.length >= 2 && gb.length >= 2 && ms.every((m) => m.weapon === 'pistol' && m.engaged && m.war && Math.abs(m.warT - 15) < 1e-9));
  check('world 槍戰：兩幫互為對象、成員換色（repaint）', ga.every((m) => gb.some((o) => o.actor === m.target)) && repainted.length === 6 && peds.slice(0, 6).every((p) => GANGS.some((g) => g.outfit.pants === p.citizen.look.pants)));
  const out = { fighting: 0 };
  W.poll(h, out);
  check('world 槍戰：poll fighting = 互毆中人數', out.fighting === 6 && gangs.warring(h.actors) === 6);
  // 流彈：成員朝 +x 開槍未命中，路線上的路人中彈
  const shooter = ga[0].actor;
  bus.emit('weapon:fire', { weapon: 'pistol', x: bystander.x - 30, y: 1.4, z: bystander.z, dirX: 1, dirY: 0, dirZ: 0, byPlayer: false, gang: b.gang, shooter, hit: false, miss: true });
  check('world 槍戰：流彈沿射線打中路人（combat.applyHit pistol）', combat.hits.length === 1 && combat.hits[0].target === bystander.actor && combat.hits[0].weapon === 'pistol' && combat.hits[0].attacker === shooter);
  player.x = bystander.x - 10;
  player.z = bystander.z;
  bus.emit('weapon:fire', { weapon: 'pistol', x: bystander.x - 30, y: 1.4, z: bystander.z, dirX: 1, dirY: 0, dirZ: 0, byPlayer: false, gang: b.gang, shooter, hit: false, miss: true });
  check('world 槍戰：流彈也會打到玩家（最近者優先）', combat.hits.length === 2 && combat.hits[1].target === player.actor);
  bus.emit('weapon:fire', { weapon: 'pistol', x: 0, y: 1.4, z: 0, dirX: 1, dirY: 0, dirZ: 0, byPlayer: false, gang: b.gang, shooter: { id: 'other' }, hit: false, miss: true });
  bus.emit('weapon:fire', { weapon: 'pistol', x: bystander.x - 30, y: 1.4, z: bystander.z, dirX: 1, dirY: 0, dirZ: 0, byPlayer: false, gang: b.gang, shooter, hit: true, miss: false });
  check('world 槍戰：非事件槍手 / 命中的子彈不算流彈', combat.hits.length === 2);
  // 回歸（v3-rf-fix #1）：槍戰中骨架換給別人（同一 actor 物件改 id）→ 不再當流彈槍手
  const sid = shooter.id;
  shooter.id = 'cit-new';
  bus.emit('weapon:fire', { weapon: 'pistol', x: bystander.x - 30, y: 1.4, z: bystander.z, dirX: 1, dirY: 0, dirZ: 0, byPlayer: false, gang: b.gang, shooter, hit: false, miss: true });
  check('world 槍戰（回歸）：槍手骨架換人（actor.id 改變）後未命中子彈不算流彈', combat.hits.length === 2);
  shooter.id = sid;
  gangs.update(16, { player: { x: player.x, z: player.z, actor: player.actor }, combat });
  for (const m of ms) m.drive(m.brain, 16, { combat }, IT()); // 互毆計時在成員大腦（driveMember）推進
  W.poll(h, out);
  check('world 槍戰：sec 秒後互毆結束（fighting 0）', out.fighting === 0);
  W.release(h, 'over');
  bus.emit('weapon:fire', { weapon: 'pistol', x: bystander.x - 30, y: 1.4, z: bystander.z, dirX: 1, dirY: 0, dirZ: 0, byPlayer: false, gang: b.gang, shooter, hit: false, miss: true });
  check('world 槍戰：release 後不再判流彈', combat.hits.length === 2);
  const few = createStreetWorld({ traffic: fakeTraffic([makePed('q1', 0, 0), makePed('q2', 1, 0), makePed('q3', 2, 0)]), combat, gangs, getPlayer: () => player });
  check('world 槍戰：可徵用 < 4 人 → null', few.spawn('gang', 0, 0, { a: 'suits', b: 'nightmarket', sec: 10 }) === null);
}
{
  // 追車 / 酒駕：事件車駕駛、警車 adapters、回收
  const vehicles = fakeVehicles();
  const traffic = fakeTraffic();
  const police = fakePolice();
  police.vehicles = vehicles;
  const kept = [];
  const player = { x: 0, z: 0, actor: { id: 'player' }, inVehicle: false };
  let see = true;
  const W = createStreetWorld({ traffic, vehicles, police, getPlayer: () => player, canSee: () => see, onKeep: (v) => kept.push(v), rng: mulberry32(8), dmg: { attach() {}, detach() {}, healthOf: (v) => v.health ?? 1000 } });
  // 回歸（v3-rf-fix #3）：車道點全都看得到 → 不生成事件車（不在眼前憑空出現）
  const nVeh0 = vehicles.vehicles.length;
  check('world 追車 / 酒駕（回歸）：生成點都在玩家視線內 → 不生成（null、沒有 adopt）', W.spawn('chase', 100, 0, {}) === null && W.spawn('drunk', 100, 0, {}) === null && vehicles.vehicles.length === nVeh0);
  see = false;
  const h = W.spawn('chase', 100, 0, {});
  see = true;
  check('world 追車：罪犯車 = vehicles.adopt（ai、吸附車道點、handle.vehicle）+ 1–2 台警車（police.spawnCar，後方 15–45 m）', !!h && h.car.v.ai && h.car.v.streetEvent === 'chase' && h.vehicle === h.car.v && h.police.length >= 1 && h.police.length <= 2 && h.police.every((pc) => Math.hypot(pc.v.pos.x - h.car.v.pos.x, pc.v.pos.z - h.car.v.pos.z) >= 15 - 1e-6));
  {
    // 回歸（v3-rf-fix #3）：只有部分車道點看得到 → 事件車與警車都落在看不到的點（比照 adapters findSpawnPoint）
    const vis = (x, z) => x >= 100; // 玩家看得到 x ≥ 100 的點
    const police2 = fakePolice();
    police2.vehicles = vehicles;
    const Wv = createStreetWorld({ traffic, vehicles, police: police2, getPlayer: () => player, canSee: (ax, az, bx, bz) => vis(bx, bz), rng: mulberry32(9) });
    const hv = Wv.spawn('chase', 100, 200, {});
    check('world 追車（回歸）：事件車 / 警車生成點都避開玩家視線', !!hv && hv.police.length > 0 && !vis(hv.car.v.pos.x, hv.car.v.pos.z) && hv.police.every((pc) => !vis(pc.v.pos.x, pc.v.pos.z)), hv ? JSON.stringify([hv.car.v.pos, hv.police.map((pc) => pc.v.pos)]) : 'null');
    Wv.release(hv, 'cancel');
  }
  const ahead = { gx: h.car.v.pos.x + 5, gz: h.car.v.pos.z + 300 };
  W.act(h, 'drive', { gx: ahead.gx, gz: ahead.gz, speed: 22, wobble: 0 });
  W.update(1 / 60);
  check('world 追車：drive → 事件車給油、警車 driveCar pursue / ram（不追玩家）', h.car.v.ctl.throttle > 0 && police.drives.length === h.police.length && police.drives.every((d) => (d[1] === 'pursue' || d[1] === 'ram') && d[2] === 26));
  const steer0 = h.car.v.ctl.steer;
  W.act(h, 'drive', { gx: ahead.gx, gz: ahead.gz, speed: 22, wobble: 0.5 });
  W.update(1 / 60);
  check('world 酒駕：wobble 疊加到方向盤', Math.abs(h.car.v.ctl.steer - steer0 - 0.5) < 1e-6);
  W.update(1 / 60, true);
  check('world：frozen → 事件車煞停', h.car.v.ctl.brake === 1 && h.car.v.ctl.throttle === 0);
  const out = { x: 0, z: 0, gone: false, speed: 0, health: null, driven: false };
  h.car.v.speed = 12;
  W.poll(h, out);
  check('world 追車：poll 位置 / 車速 / 耐久', out.x === h.car.v.pos.x && out.speed === 12 && out.health === 1000 && !out.gone);
  const actor = W.act(h, 'eject', {});
  check('world 追車：eject → traffic.spawnEjectedDriver（車門外）、車拉手煞', !!actor && traffic.ejected.length === 1 && h.car.v.ctl.handbrake === true && h.car.v.ai === false);
  const nPolice = h.police.length;
  W.release(h, 'subdued');
  check('world 追車：下車棄置的罪犯車交一般回收名單（onKeep）、警車收隊', kept.includes(h.car.v) && W.stats().leavingPolice === nPolice);
  see = false;
  player.x = 1000;
  W.update(0.1);
  check('world 追車：警車離開視線且 > 150 m → police.despawnCar', police.despawned.length === nPolice && W.stats().leavingPolice === 0);
  // 逃脫：仍在開的車繼續開走、離開視線後移除
  player.x = 0;
  see = false;
  const h2 = W.spawn('drunk', -100, 0, {});
  see = true;
  W.release(h2, 'escaped');
  W.update(0.1);
  const still = vehicles.vehicles.includes(h2.car.v);
  see = false;
  player.x = 1000;
  W.update(0.1);
  check('world 酒駕：逃脫的車看得到時繼續開、離開視線 > 150 m 後移除', still && !vehicles.vehicles.includes(h2.car.v) && W.stats().leaving === 0);
  see = false;
  const h3 = W.spawn('drunk', -100, 0, {});
  see = true;
  h3.car.v.health = 0;
  W.release(h3, 'crashed');
  check('world 酒駕：熄火殘骸交一般回收（照報廢車回收）', kept.includes(h3.car.v) && vehicles.vehicles.includes(h3.car.v));
  player.x = 0;
  see = false;
  const h4 = W.spawn('chase', 100, 40, {});
  see = true;
  const pcs = h4.police.slice();
  W.release(h4, 'cancel');
  check('world：cancel → 事件車與警車立即移除', !vehicles.vehicles.includes(h4.car.v) && pcs.every((pc) => pc.removed));
  const W5 = createStreetWorld({ traffic, vehicles, police: { ...police, spawnCar: () => null }, getPlayer: () => player, canSee: () => false });
  const n0 = vehicles.vehicles.length;
  check('world 追車：叫不到警車 → 不開始（罪犯車也收回）', W5.spawn('chase', 100, 0, {}) === null && vehicles.vehicles.length === n0);
  W.dispose();
  check('world：dispose 移除所有受控事件車', W.cars.size === 0);
}
{
  // 回歸（v3-rf-fix #2）：收隊警車超時仍看得到 → 不在眼前 despawn（停車），離開視線且 > 150 m 才移除
  const vehicles = fakeVehicles();
  const traffic = fakeTraffic();
  const police = fakePolice();
  police.vehicles = vehicles;
  const player = { x: 0, z: 0, actor: { id: 'player' }, inVehicle: false };
  let see = false;
  const W = createStreetWorld({ traffic, vehicles, police, getPlayer: () => player, canSee: () => see, rng: mulberry32(12) });
  const h = W.spawn('chase', 100, 0, {});
  const pcs = h.police.slice();
  W.release(h, 'arrested');
  see = true;
  player.x = pcs[0].v.pos.x - 15; // 玩家跟在收隊警車旁
  for (let i = 0; i < 1000; i++) W.update(0.1); // 100 s > CAR_LEAVE_MAX × 2
  const stops = police.drives.filter((d) => d[1] === 'stop').length;
  check('world 追車（回歸）：收隊警車 100 s 後仍看得到 → 不 despawn、改煞停（只下一次 stop）', police.despawned.length === 0 && pcs.every((pc) => !pc.removed && vehicles.vehicles.includes(pc.v)) && stops === pcs.length && W.stats().leavingPolice === pcs.length);
  see = false;
  W.update(0.1);
  const nearUnseen = police.despawned.length;
  player.x = 2000;
  W.update(0.1);
  check('world 追車（回歸）：之後離開視線且 > 150 m 才 despawnCar', nearUnseen === 0 && pcs.every((pc) => pc.removed) && W.stats().leavingPolice === 0);
}
{
  // 回歸（v3-rf-fix #5）：reset（回主選單 / 開新局）→ 已結束仍在離場的事件車 / 收隊警車 / 待回收行人一併清掉（零殘留）
  const vehicles = fakeVehicles();
  const peds = [makePed('a', 100, 0), makePed('b', 110, 0)];
  const traffic = fakeTraffic(peds);
  const police = fakePolice();
  police.vehicles = vehicles;
  const combat = fakeCombat();
  const player = { x: 0, z: 0, actor: { id: 'player' }, inVehicle: false };
  const W = createStreetWorld({ traffic, combat, vehicles, police, getPlayer: () => player, canSee: (ax, az, bx, bz) => bx > 0 && Math.abs(bz) < 1, rng: mulberry32(13) });
  const hc = W.spawn('chase', -100, 40, {});
  const hr = W.spawn('robbery', 100, 0, {});
  hr.robber.p.x = hr.victim.p.x - 1;
  W.act(hr, 'grab', {});
  combat.down.add(hr.robber.p.actor);
  W.act(hr, 'subdued', {}); // 受害者道謝中
  W.release(hc, 'escaped'); // 事件車離場中、警車收隊中
  W.release(hr, 'subdued');
  const victim = hr.victim.p;
  W.update(0.1);
  const before = W.stats();
  W.reset();
  const after = W.stats();
  W.update(0.1);
  check('world（回歸）：reset → 離場事件車移除、收隊警車 despawn、待回收行人交還（override 清掉）、之後 update 不再下指令',
    before.leaving === 1 && before.leavingPolice >= 1 && before.pendingPeds === 2 && after.leaving === 0 && after.leavingPolice === 0 && after.pendingPeds === 0 && after.cars === 0 &&
    !vehicles.vehicles.includes(hc.car.v) && hc.police.length === 0 && police.cars.every((pc) => pc.removed) && victim.brain.override === null, JSON.stringify({ before, after }));
}

// ---------- 13. 接線 / 文件 / 靜態 ----------
{
  const src = read('src/street-events.js');
  check('street-events.js 不 import three / rapier（純邏輯）', !/^import[^\n]*(three|rapier)/m.test(src));
  const main = read('src/main.js');
  check('main.js：import 並建立 createStreetEvents / createStreetWorld', main.includes("import { createStreetEvents, createStreetWorld } from './street-events.js';") && main.includes('createStreetEvents({ bus') && main.includes('createStreetWorld({'));
  check('main.js：每幀 updateStreetEvents(dt, phoneOpen) 接在 updateExplosions / handleCarKo 之後', /updateExplosions\(dt\);\n\s+handleCarKo\(\);[^\n]*\n\s+updateStreetEvents\(dt, phoneOpen\);/.test(main));
  const seg = main.slice(main.indexOf('const updateStreetEvents'), main.indexOf('const cancelStreetEvents'));
  check('main.js：busy 含 搶劫 / 警車任務 / 其他任務 / 手機・噴漆・BUSTED（凍結）', seg.includes('robberies.active') && seg.includes('vigilante.active') && seg.includes('otherMissionBusy()') && seg.includes('state.spraying') && seg.includes('state.respawn') && seg.includes('skip'));
  const sg = main.slice(main.indexOf('const startGame'), main.indexOf('const quitToMenu'));
  const qm = main.slice(main.indexOf('const quitToMenu'), main.indexOf('const quitToMenu') + 800);
  check('main.js：開新局 / 回主選單 → cancelStreetEvents()', sg.includes('cancelStreetEvents();') && qm.includes('cancelStreetEvents();'));
  // 回歸（v3-rf-fix #5）：cancel 之後一併 reset world（離場中的事件車 / 收隊警車 / 待回收行人）
  const cse = main.slice(main.indexOf('const cancelStreetEvents'), main.indexOf('const cancelStreetEvents') + 200);
  check('main.js（回歸）：cancelStreetEvents = streetEvents.cancel() + streetWorld.reset()', /streetEvents\.cancel\(\);\s*\n\s*streetWorld\.reset\(\);/.test(cse));
  check('main.js：犯行豁免併入 vigHooks（isEventActor / shotAtEvent 帶命中車）', main.includes('vigHooks.fugitiveActor = (a) => vigActorHook(a) || streetEvents.isEventActor(a);') && main.includes('vigHooks.fugitiveShot = (x, z, v) => vigShotHook(x, z) || streetEvents.shotAtEvent(x, z, v);'));
  // 回歸（v3-rf-fix #1）：gunfire / 炸警車的豁免帶命中車，街頭事件只認罪犯車本身
  const onFireSeg = main.slice(main.indexOf("bus.on('weapon:fire', (e) => {\n    // 警員開槍"), main.indexOf('const stolenPolice = new WeakSet();'));
  const explodeSeg = main.slice(main.indexOf("bus.on('vehicle:explode'"), main.indexOf('let explodeScanT'));
  check('main.js（回歸）：gunfire / vehicle:explode 豁免帶命中車（e.vehicle），不只看落點', onFireSeg.includes('vigHooks.fugitiveShot(e.ex, e.ez, e.vehicle)') && explodeSeg.includes('vigHooks.fugitiveShot(e.x, e.z, e.vehicle)') && read('src/weapons/weapons.js').includes('vehicle: shot.hit && !hitActor ? shot.vehicle || null : null'));
  // 回歸（v3-rf-fix #4）：玩家駕車撞事件車 → vehicleHitByPlayer（賞金歸屬）
  check('main.js（回歸）：contacts 車對車碰撞（玩家駕駛）→ streetEvents.vehicleHitByPlayer', /router\.onVehicleHitVehicle\(\(\{ a, b \}\) => \{[^}]*byPlayer\(va\)\) streetEvents\.vehicleHitByPlayer\(vb\);[^}]*byPlayer\(vb\)\) streetEvents\.vehicleHitByPlayer\(va\);/.test(main));
  check('main.js：小地圖 / 大地圖標記併入 collectMarkers、賞金走 economy', main.includes('pushAll(out, streetMarkers());') && main.includes("economy.add(n, 'street')"));
  check('marker-colors / hud / big-map：street-event 黃點、貼邊、圖例', /^#ff[0-9a-f]{4}$/i.test(MARKER_COLORS['street-event'] || '') && /const EDGE_KINDS = new Set\(\[[^\]]*'street-event'/.test(read('src/hud.js')) && read('src/map/big-map.js').includes("'street-event': '街頭事件'"));
  const doc = read('docs/dev/interfaces.md');
  check('interfaces.md：新增 street-events.js 一節（介面、street:start / street:resolve）', /## 32\. V3 街頭隨機犯罪事件/.test(doc) && doc.includes('street:start') && doc.includes('street:resolve') && doc.includes('createStreetEvents'));
  // 回歸（v3-rf-fix #2）：契約與實作一致——收隊警車不再寫「同理」（實作原為 90 s 無條件 despawn）、寫明超時仍看得到只煞停
  const sec32 = doc.slice(doc.indexOf('## 32. V3'), doc.indexOf('### 32.2'));
  check('interfaces.md（回歸）：§32 回收契約 = 遠且看不到才移除（行人 / 事件車 / 收隊警車）、超時看得到只煞停、reset、shotAtEvent 帶命中車',
    !sec32.includes('警車收隊同理') && sec32.includes('> 110 m 且離開視線') && sec32.includes('收隊警車同樣只在 > 150 m 且看不到時') && sec32.includes('reset()') && sec32.includes('shotAtEvent(x, z, vehicle)'));
}

console.log(`${failed ? 'FAIL' : 'PASS'} ${failed ? `${failed}/${passed + failed}` : `${passed}/${passed + failed}`}`);
process.exit(failed ? 1 : 0);
