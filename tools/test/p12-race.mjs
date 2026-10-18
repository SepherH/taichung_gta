#!/usr/bin/env node
// P12 街頭競速無頭測試：src/missions/race.js（純邏輯 + createRivalWorld / createRaceHud 替身）+ 真 events.js / save.js + osm-city.json 路網
// 用法：node tools/test/p12-race.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 涵蓋：賽道定義（3 條、各 5–7 點）與檢查點 / 起點 / 起跑格位皆在車道上（osm-city.json R 層寬度內、非橋、最大連通塊、相鄰點路網可達、近所屬地標）、
//   開賽條件（駕車 / 起點範圍 / 其他任務 / 有星數 toast）、倒數鎖定（3–2–1、對手車 hold、計時不走）、檢查點判定（12 m、掃掠、漏點不算）、
//   名次計算（進度 / 完賽順序 / 退出）、獎金 1000 / 400 / 150 / 0、最佳成績（serialize / restore / save.js races 欄位與舊存檔相容）、
//   結束條件（left > 10 s / wrecked / busted / wasted / cancel 不 toast）+ 對手車回收、互斥（進行中不可再開、busy）、橡皮筋 ≤ 10%、
//   幀率無關（1/30、1/60、1/144）、dt clamp、標記 / 光柱目標、對手車世界（adopt 動態剛體、生成避讓、不改寫座標、hold / remove / isKept）、HUD
// 注意：staging 無 node_modules；navigation.js 依賴 three，路網連通性以同規則（1 m 吸附、共點合併）在本檔重建
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBus } from '../../src/core/events.js';
import { validateSave, defaultSave, createSaveStore } from '../../src/save.js';
import {
  RACES,
  START_RADIUS,
  CP_RADIUS,
  COUNTDOWN_SEC,
  LEFT_SEC,
  RUBBER_MAX,
  RIVAL_JITTER,
  DIFFICULTY_SPEED,
  REWARDS,
  GRID_SLOTS,
  MARKER_START,
  MARKER_CP,
  TOAST_WANTED,
  TOAST_MOVING,
  TOAST_STALLED,
  TOAST_OVERTURNED,
  START_MAX_SPEED,
  END_REASONS,
  raceById,
  formatRaceTime,
  barText,
  gridSlots,
  arrowAngle,
  rubberBand,
  rewardFor,
  cleanBest,
  courseCum,
  createRaces,
  createRivalWorld,
  createRaceHud,
} from '../../src/missions/race.js';

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

// ---------- 路網（osm-city.json R 層，同 citymodel surfaceRoads / navigation buildRoadGraph 規則）----------
const osm = JSON.parse(read('src/data/osm-city.json'));
const roads = osm.R.filter((r) => !r.u).map((r) => {
  const pts = [];
  for (let i = 0; i < r.p.length; i += 2) pts.push({ x: r.p[i], z: r.p[i + 1] });
  return { id: r.i, name: r.n || '', type: r.t, hw: r.w / 2, bridge: !!r.br || (r.ly || 0) !== 0, pts };
});
const segD = (ax, az, bx, bz, px, pz) => {
  const dx = bx - ax;
  const dz = bz - az;
  const L2 = dx * dx + dz * dz;
  const t = L2 > 1e-12 ? Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / L2)) : 0;
  return Math.hypot(ax + dx * t - px, az + dz * t - pz);
};
// 點離最近地面車道的「超出路緣距離」（≤ 0 = 在車道寬度內）與該車道
function roadAt(x, z) {
  let best = { over: Infinity, road: null };
  for (const r of roads) {
    for (let i = 0; i < r.pts.length - 1; i++) {
      const over = segD(r.pts[i].x, r.pts[i].z, r.pts[i + 1].x, r.pts[i + 1].z, x, z) - r.hw;
      if (over < best.over) best = { over, road: r };
    }
  }
  return best;
}
// 建圖：1 m 吸附共點；最大連通塊
const nodes = [];
const cells = new Map();
const key = (ix, iz) => `${ix},${iz}`;
function nodeAt(x, z) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  let best = -1;
  let bd = 1;
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const n of cells.get(key(ix + dx, iz + dz)) || []) {
    const d = (nodes[n].x - x) ** 2 + (nodes[n].z - z) ** 2;
    if (d <= bd) {
      bd = d;
      best = n;
    }
  }
  if (best >= 0) return best;
  nodes.push({ x, z, adj: new Set(), roads: new Set() });
  const k = key(ix, iz);
  if (!cells.has(k)) cells.set(k, []);
  cells.get(k).push(nodes.length - 1);
  return nodes.length - 1;
}
for (const r of roads) {
  let prev = nodeAt(r.pts[0].x, r.pts[0].z);
  nodes[prev].roads.add(r);
  for (let i = 1; i < r.pts.length; i++) {
    const cur = nodeAt(r.pts[i].x, r.pts[i].z);
    nodes[cur].roads.add(r);
    if (cur !== prev) {
      nodes[cur].adj.add(prev);
      nodes[prev].adj.add(cur);
    }
    prev = cur;
  }
}
const comp = new Int32Array(nodes.length).fill(-1);
let mainComp = -1;
let mainSize = 0;
for (let s = 0, c = 0; s < nodes.length; s++) {
  if (comp[s] >= 0) continue;
  const q = [s];
  comp[s] = c;
  for (let i = 0; i < q.length; i++) for (const v of nodes[q[i]].adj) if (comp[v] < 0) {
    comp[v] = c;
    q.push(v);
  }
  if (q.length > mainSize) {
    mainSize = q.length;
    mainComp = c;
  }
  c++;
}
// 點投影到最近的主連通塊邊（同 navigation projectToGraph mainOnly）→ 距離
function mainEdgeDist(x, z) {
  let best = Infinity;
  for (let a = 0; a < nodes.length; a++) {
    if (comp[a] !== mainComp) continue;
    for (const b of nodes[a].adj) if (b > a) best = Math.min(best, segD(nodes[a].x, nodes[a].z, nodes[b].x, nodes[b].z, x, z));
  }
  return best;
}
// 地標：B 建築 / L 公園輪廓（src 欄位的 id）→ 點到輪廓的距離（在內 = 0）
const polyOf = (id) => {
  const b = osm.B.find((e) => e.i === id) || osm.L.find((e) => e.i === id);
  if (!b) return null;
  const p = typeof b.p === 'string' ? JSON.parse(b.p) : b.p;
  const pts = [];
  for (let i = 0; i < p.length; i += 2) pts.push({ x: p[i], z: p[i + 1] });
  return pts;
};
function inPoly(x, z, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}
function polyDist(x, z, pts) {
  if (inPoly(x, z, pts)) return 0;
  let d = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    d = Math.min(d, segD(a.x, a.z, b.x, b.z, x, z));
  }
  return d;
}
const buildingPolys = osm.B.map((b) => {
  const pts = [];
  for (let i = 0; i < b.p.length; i += 2) pts.push({ x: b.p[i], z: b.p[i + 1] });
  return pts;
});
const inBuilding = (x, z) => buildingPolys.some((pts) => inPoly(x, z, pts));

// ---------- 賽道定義 ----------
check('RACES：3 條、id 不重複、各有名稱 / 難度 / 2–3 台對手', RACES.length === 3 && new Set(RACES.map((r) => r.id)).size === 3 && RACES.every((r) => r.name && [1, 2, 3].includes(r.difficulty) && r.rivals >= 2 && r.rivals <= 3));
check('RACES：各 5–7 個檢查點（不含起點）', RACES.every((r) => r.checkpoints.length >= 5 && r.checkpoints.length <= 7), RACES.map((r) => r.checkpoints.length).join('/'));
check('RACES：難度各異（1 / 2 / 3）、地圖界內', new Set(RACES.map((r) => r.difficulty)).size === 3 && RACES.every((r) => [r.start, ...r.checkpoints].every((p) => p.x > osm.bounds.x0 && p.x < osm.bounds.x1 && p.z > osm.bounds.z0 && p.z < osm.bounds.z1)));
for (const r of RACES) {
  const pts = [r.start, ...r.checkpoints];
  const bad = [];
  for (const p of pts) {
    const ra = roadAt(p.x, p.z);
    if (!(ra.over <= 0)) bad.push(`${p.name} 超出路緣 ${ra.over.toFixed(1)} m`);
    else if (ra.road.bridge) bad.push(`${p.name} 在橋上`);
    const me = mainEdgeDist(p.x, p.z);
    if (!(me <= 0.5)) bad.push(`${p.name} 離主路網 ${me.toFixed(1)} m`);
    if (inBuilding(p.x, p.z)) bad.push(`${p.name} 在建築內`);
  }
  check(`${r.name}：起點與 ${r.checkpoints.length} 個檢查點皆在可行駛車道上（寬度內、非橋、最大連通塊、非建築內）`, bad.length === 0, bad.join('；'));
  // 相鄰點路網可達：同在最大連通塊即 A* 可達（findRoute 只投影到最大塊）；另要求點的投影距離 ≤ 0.5 m（已在上面）
  const far = [];
  for (const p of pts) {
    const m = /^[BL] (\d+)/.exec(p.src || '');
    const poly = m ? polyOf(Number(m[1])) : null;
    const d = poly ? polyDist(p.x, p.z, poly) : Infinity;
    if (!(d <= 130)) far.push(`${p.name} ${Number.isFinite(d) ? d.toFixed(0) + ' m' : '找不到地標 ' + (p.src || '')}`);
  }
  check(`${r.name}：每點註明來源地標（OSM B / L id）且離地標輪廓 ≤ 130 m`, far.length === 0, far.join('；'));
  const legs = courseCum(r);
  check(`${r.name}：相鄰檢查點間距 ≥ 2 × ${CP_RADIUS} m（不會一次通過兩點）`, pts.every((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z) >= 2 * CP_RADIUS) && legs[legs.length - 1] > 800, `全長 ${legs[legs.length - 1].toFixed(0)} m`);
  const slots = gridSlots(r.start).slice(0, r.rivals + 2);
  const slotBad = slots.map((s, i) => [i, roadAt(s.x, s.z).over, inBuilding(s.x, s.z)]).filter(([, o, b]) => !(o <= 0.5) || b);
  check(`${r.name}：起跑格位（前 ${slots.length} 格）在車道上、不在建築內`, slotBad.length === 0, slotBad.map(([i, o]) => `#${i} ${o.toFixed(1)}`).join(' '));
}
{
  const s = gridSlots({ x: 0, z: 0, heading: 0 }, [[3.5, 0], [0, -8]]);
  check('gridSlots：heading 0（朝 +z）右方 = −x、後方 = −z', near(s[0].x, -3.5) && near(s[0].z, 0) && near(s[1].x, 0) && near(s[1].z, -8));
  check('GRID_SLOTS：前兩格並排（橫向 ±3.5、同排）', GRID_SLOTS[0][1] === 0 && GRID_SLOTS[1][1] === 0 && GRID_SLOTS[0][0] === -GRID_SLOTS[1][0]);
}

// ---------- 純函式 ----------
check('formatRaceTime：mm:ss.s（十分位捨去）', formatRaceTime(83.47) === '01:23.4' && formatRaceTime(0) === '00:00.0' && formatRaceTime(-3) === '00:00.0' && formatRaceTime(600.06) === '10:00.0' && formatRaceTime(59.99) === '00:59.9');
check('barText：「名次 n/m｜檢查點 k/K｜mm:ss.s」', barText(2, 4, 3, 6, 75.25) === '名次 2/4｜檢查點 3/6｜01:15.2');
check('arrowAngle：正前方 0、目標在左（朝 +z 時的 +x）→ 逆時針 −90°、在右 → +90°', near(arrowAngle(0, 0, 0, 0, 10), 0) && near(arrowAngle(0, 0, 0, 10, 0), -Math.PI / 2) && near(arrowAngle(0, 0, 0, -10, 0), Math.PI / 2));
check('rubberBand：落後加速、領先減速，幅度 ≤ 10%', near(rubberBand(1e6), 1 + RUBBER_MAX) && near(rubberBand(-1e6), 1 - RUBBER_MAX) && near(rubberBand(0), 1) && rubberBand(75) > 1 && rubberBand(75) < 1.1 && RUBBER_MAX <= 0.1);
check('rewardFor：第 1 / 2 / 3 名 NT$1000 / 400 / 150，其餘 0', rewardFor(1) === 1000 && rewardFor(2) === 400 && rewardFor(3) === 150 && rewardFor(4) === 0 && rewardFor(0) === 0 && REWARDS.join() === '1000,400,150');
check('cleanBest：只收已知賽道 id 的正有限秒數', JSON.stringify(cleanBest({ 'qiqi-classic': 90.5, 'civic-loop': -1, x: 5, 'qiuhonggu-sprint': 'a' })) === '{"qiqi-classic":90.5}' && JSON.stringify(cleanBest(null)) === '{}');
check('raceById', raceById('civic-loop') === RACES[1] && raceById('nope') === null);

// ---------- 替身世界：對手車 = { x, z, speed, health, exists, driven, cmd, held }；step(dt) 依 drive 指令直線前進 ----------
function fakeWorld({ blocked = () => false } = {}) {
  const w = {
    cars: [],
    removed: [],
    holds: 0,
    drives: [],
    spawn(pt, opt) {
      if (blocked(pt)) return null;
      const h = { x: pt.x, z: pt.z, speed: 0, health: 1000, exists: true, driven: false, cmd: null, held: false, opt };
      w.cars.push(h);
      return h;
    },
    state: (h) => ({ x: h.x, z: h.z, speed: h.speed, health: h.health, exists: h.exists, driven: h.driven }),
    drive(h, cmd) {
      h.cmd = { ...cmd };
      h.held = false;
      w.drives.push(cmd.maxSpeed);
    },
    hold(h) {
      h.cmd = null;
      h.held = true;
      w.holds++;
    },
    remove(h) {
      w.removed.push(h);
      h.exists = false;
    },
    step(dt) {
      for (const h of w.cars) {
        if (!h.exists || !h.cmd) continue;
        const dx = h.cmd.x - h.x;
        const dz = h.cmd.z - h.z;
        const L = Math.hypot(dx, dz);
        const s = Math.min(L, h.cmd.maxSpeed * dt);
        if (L > 1e-9) {
          h.x += (dx / L) * s;
          h.z += (dz / L) * s;
        }
      }
    },
  };
  return w;
}
function setup(opts = {}) {
  const bus = createBus();
  const log = [];
  for (const n of ['race:start', 'race:checkpoint', 'race:finish', 'race:abort']) bus.on(n, (e) => log.push([n, e]));
  const races = createRaces({ bus, rng: () => 0.5, config: opts.config || {} });
  const world = fakeWorld(opts);
  const toasts = [];
  const money = [];
  const race = raceById(opts.raceId || 'qiqi-classic');
  const ctx = { player: { x: race.start.x, z: race.start.z }, inCar: true, wrecked: false, world, earn: (n) => money.push(n), toast: (t) => toasts.push(t) };
  return { bus, log, races, world, toasts, money, race, ctx };
}
const startCtx = (s, extra = {}) => ({ inCar: true, player: { ...s.ctx.player }, stars: 0, busy: false, toast: s.ctx.toast, ...extra });
const tick = (s, sec, dt = 1 / 60) => {
  let last;
  for (let t = 0; t < sec - 1e-9; t += dt) {
    last = s.races.update(dt, s.ctx);
    s.world.step(dt);
  }
  return last;
};
// 玩家沿直線移到 (x, z)（每幀 speed m/s）
function drivePlayerTo(s, x, z, speed = 30, dt = 1 / 60) {
  let last;
  for (let k = 0; k < 100000; k++) {
    const p = s.ctx.player;
    const dx = x - p.x;
    const dz = z - p.z;
    const L = Math.hypot(dx, dz);
    if (L < 1e-6) break;
    const st = Math.min(L, speed * dt);
    p.x += (dx / L) * st;
    p.z += (dz / L) * st;
    last = s.races.update(dt, s.ctx);
    s.world.step(dt);
    if (!s.races.active) break;
  }
  return last;
}

// ---------- 開賽條件 ----------
{
  const s = setup();
  const id = s.race.id;
  check('nearestStart：起點 START_RADIUS 內才命中', s.races.nearestStart(s.race.start.x + START_RADIUS - 0.5, s.race.start.z) === s.race && s.races.nearestStart(s.race.start.x + START_RADIUS + 1, s.race.start.z) === null);
  check('canStart：步行不可（notDriving）', s.races.canStart(id, startCtx(s, { inCar: false })).reason === 'notDriving');
  check('canStart：離起點太遠不可（far）', s.races.canStart(id, startCtx(s, { player: { x: s.race.start.x + 30, z: s.race.start.z } })).reason === 'far');
  check('canStart：其他任務中不可（busy）', s.races.canStart(id, startCtx(s, { busy: true })).reason === 'busy');
  check('canStart：未知賽道（unknown）', s.races.canStart('nope', startCtx(s)).reason === 'unknown');
  const ok = s.races.start(id, startCtx(s, { stars: 2 }));
  check('有星數：不開賽、toast 提示', !ok && !s.races.active && s.toasts.includes(TOAST_WANTED) && !s.log.length);
  check('busy：start 回 false、不開賽', !s.races.start(id, startCtx(s, { busy: true })) && !s.races.active);
  check('0 星、駕車、在起點、無其他任務 → 開賽、emit race:start', s.races.start(id, startCtx(s)) && s.races.active && s.log.some((e) => e[0] === 'race:start' && e[1].id === id && e[1].rivals === 2 && e[1].checkpoints === 5));
  check('進行中：不可再開（active）、他條賽道也不行', s.races.canStart(id, startCtx(s)).reason === 'active' && !s.races.start('civic-loop'));
}

// ---------- 倒數鎖定 ----------
{
  const s = setup();
  s.races.start(s.race.id, startCtx(s));
  const r0 = s.races.update(1 / 60, s.ctx);
  check(`倒數：locked、顯示 3、生成 ${s.race.rivals} 台對手車於起跑格位`, r0.locked && r0.countdown === 3 && s.world.cars.length === s.race.rivals && near(s.world.cars[0].x, gridSlots(s.race.start)[0].x) && near(s.world.cars[1].z, gridSlots(s.race.start)[1].z));
  const counts = new Set();
  let held = true;
  let timeStill = true;
  for (let t = 1 / 60; t < COUNTDOWN_SEC - 0.05; t += 1 / 60) {
    const r = s.races.update(1 / 60, s.ctx);
    s.world.step(1 / 60);
    counts.add(r.countdown);
    held = held && s.world.cars.every((c) => c.held && !c.cmd) && r.locked;
    timeStill = timeStill && r.time === 0;
  }
  check('倒數期間：3–2–1、對手車 hold（不給油門）、計時不走', [...counts].sort().join() === '1,2,3' && held && timeStill && s.world.drives.length === 0);
  check('倒數期間：對手車沒有移動', s.world.cars.every((c, i) => near(c.x, gridSlots(s.race.start)[i].x) && near(c.z, gridSlots(s.race.start)[i].z)));
  const r1 = tick(s, 0.2);
  check('倒數結束：解除鎖定、GO!、對手車開往第 1 個檢查點', !r1.locked && r1.phase === 'running' && r1.go && s.world.cars.every((c) => c.cmd && near(c.cmd.x, s.race.checkpoints[0].x) && near(c.cmd.z, s.race.checkpoints[0].z)));
  check('對手車目標速度 = 難度基準 × 個體差 × 橡皮筋（≤ ±10% / ±4%）', s.world.drives.every((v) => v <= DIFFICULTY_SPEED[1] * (1 + RUBBER_MAX) * (1 + RIVAL_JITTER) + 1e-9 && v >= DIFFICULTY_SPEED[1] * (1 - RUBBER_MAX) * (1 - RIVAL_JITTER) - 1e-9));
  const r2 = tick(s, 1);
  check('GO! 顯示 1 s 後收起', !r2.go);
}
{
  // 格位被佔：跳下一格；格位全滿 → 對手車放棄（m 隨之減少）
  const s = setup({ blocked: (pt) => pt === undefined });
  const slots = gridSlots(s.race.start);
  const s2 = setup({ blocked: (pt) => near(pt.x, slots[0].x) && near(pt.z, slots[0].z) });
  s2.races.start(s2.race.id);
  s2.races.update(1 / 60, s2.ctx);
  check('格位 #0 被佔：對手車改放 #1 / #2', s2.world.cars.length === 2 && near(s2.world.cars[0].x, slots[1].x) && near(s2.world.cars[1].x, slots[2].x));
  const s3 = setup({ blocked: () => true });
  s3.races.start(s3.race.id);
  const r = tick(s3, COUNTDOWN_SEC + 0.1);
  check('格位全被佔：無對手車也照常開賽（名次 1/1）', r.phase === 'running' && r.total === 1 && r.rank === 1);
  void s;
}

// ---------- 檢查點判定 / 漏點 / 掃掠 ----------
{
  const s = setup();
  s.races.start(s.race.id, startCtx(s));
  tick(s, COUNTDOWN_SEC + 0.05);
  const [c1, c2] = s.race.checkpoints;
  // 先直接開到第 2 點（漏掉第 1 點）
  s.ctx.player.x = c2.x;
  s.ctx.player.z = c2.z + 40;
  s.races.update(1 / 60, s.ctx); // 瞬間位移（測試用）：掃掠線段不經過 c1
  drivePlayerTo(s, c2.x, c2.z);
  check('漏點：直接通過第 2 點不算（檢查點仍 0）', s.races.checkpoint === 0);
  // 擦身 13 m 不算
  s.ctx.player.x = c1.x + 13;
  s.ctx.player.z = c1.z - 60;
  s.races.update(1 / 60, s.ctx);
  drivePlayerTo(s, c1.x + 13, c1.z + 60);
  check(`離第 1 點 13 m 掠過不算（半徑 ${CP_RADIUS} m）`, s.races.checkpoint === 0);
  s.ctx.player.x = c1.x + 11;
  s.ctx.player.z = c1.z - 60;
  s.races.update(1 / 60, s.ctx);
  const r = drivePlayerTo(s, c1.x + 11, c1.z + 60);
  check('離第 1 點 11 m 通過 → 檢查點 1、emit race:checkpoint', s.races.checkpoint === 1 && r.cp === 1 && s.log.some((e) => e[0] === 'race:checkpoint' && e[1].index === 1 && e[1].total === s.race.checkpoints.length));
  // 掃掠：單幀 0.1 s 以 90 m/s 穿越第 2 點（前後兩幀都在 12 m 外）
  s.ctx.player.x = c2.x - 5;
  s.ctx.player.z = c2.z - 20;
  s.races.update(0.1, s.ctx);
  s.ctx.player.x = c2.x - 5;
  s.ctx.player.z = c2.z + 20;
  s.races.update(0.1, s.ctx);
  check('掃掠判定：單幀跨過檢查點（前後幀皆在 12 m 外）仍算通過', s.races.checkpoint === 2);
  const mk = s.races.markers([]);
  const b = s.races.beacons();
  check("比賽中：小地圖只標下一點 kind 'race-cp'、光柱目標 = 下一點", mk.length === 1 && mk[0].kind === MARKER_CP && near(mk[0].x, s.race.checkpoints[2].x) && b.checkpoint === s.race.checkpoints[2] && b.starts.length === 0);
}
{
  const s = setup();
  const mk = s.races.markers([]);
  const b = s.races.beacons();
  check("未開賽：小地圖 3 面起點旗幟 kind 'race-start'、光柱 = 3 個起點", mk.length === 3 && mk.every((m) => m.kind === MARKER_START) && b.starts.length === 3 && b.checkpoint === null);
}

// ---------- 名次 / 完賽 / 獎金 ----------
function raceTo(s, { rivalAhead = 0, rivalFinish = 0 } = {}) {
  s.races.start(s.race.id, startCtx(s));
  tick(s, COUNTDOWN_SEC + 0.05);
  // 對手車手動擺位：前 rivalFinish 台直接完賽、再 rivalAhead 台放在玩家前面（進度較多）
  const K = s.race.checkpoints.length;
  s.world.cars.forEach((c, i) => {
    c.cmd = null;
    if (i < rivalFinish) {
      for (let k = 0; k < K; k++) {
        const cp = s.race.checkpoints[k];
        c.x = cp.x;
        c.z = cp.z;
        s.races.update(1 / 60, s.ctx);
      }
    }
  });
  s.world.step = () => {}; // 之後對手車不動
  return K;
}
{
  const s = setup();
  s.races.start(s.race.id, startCtx(s));
  tick(s, COUNTDOWN_SEC + 0.05);
  const [a, b] = s.world.cars;
  s.world.step = () => {};
  const c1 = s.race.checkpoints[0];
  a.x = c1.x + 200; // 離第 1 點較遠（落後）
  a.z = c1.z;
  b.x = c1.x + 50;
  b.z = c1.z;
  s.ctx.player.x = c1.x + 100;
  s.ctx.player.z = c1.z;
  let r = s.races.update(1 / 60, s.ctx);
  check('名次：依進度（離下一點距離）→ 玩家 2/3', r.rank === 2 && r.total === 3, `${r.rank}/${r.total}`);
  b.health = 0;
  r = s.races.update(1 / 60, s.ctx);
  check('對手車毀損 → 退出比賽（排最後）→ 玩家 1/3', r.rank === 1 && r.total === 3);
  check('HUD 文字含名次 / 檢查點 / 計時', /^名次 1\/3｜檢查點 0\/5｜\d\d:\d\d\.\d$/.test(r.text), r.text);
}
for (const [label, rf, want] of [['第 1 名', 0, 1], ['第 2 名', 1, 2], ['第 3 名', 2, 3]]) {
  const s = setup();
  const K = raceTo(s, { rivalFinish: rf });
  for (let k = 0; k < K; k++) {
    const cp = s.race.checkpoints[k];
    drivePlayerTo(s, cp.x, cp.z, 60);
  }
  const fin = s.log.find((e) => e[0] === 'race:finish');
  const reward = rewardFor(want);
  check(`完賽 ${label}：race:finish rank ${want}、獎金 NT$${reward}（ctx.earn）、toast 名次與時間`, !s.races.active && fin && fin[1].rank === want && s.money.join() === String(reward) && s.toasts.some((t) => t.startsWith(`完賽！第 ${want} 名｜`) && t.includes(`NT$${reward}`)), fin && JSON.stringify(fin[1]));
  if (want === 1) check('完賽：對手車回收、標記回到起點旗幟', s.world.removed.length === 2 && s.races.markers([]).every((m) => m.kind === MARKER_START));
}
{
  // 4 人賽（3 台對手）第 4 名：無獎金
  const s = setup({ raceId: 'civic-loop' });
  const K = raceTo(s, { rivalFinish: 3 });
  for (let k = 0; k < K; k++) drivePlayerTo(s, s.race.checkpoints[k].x, s.race.checkpoints[k].z, 60);
  const fin = s.log.find((e) => e[0] === 'race:finish');
  check('第 4 名（3 台對手全先完賽）：無獎金、不 earn', fin && fin[1].rank === 4 && fin[1].total === 4 && fin[1].reward === 0 && s.money.length === 0);
}

// ---------- P12 審查修正回歸（cr-p12-logic）----------
for (const kind of ['wrecked', 'driven']) {
  // 🔴 已完賽的對手車停在終點後被撞毀 / 被搶走：不得判退出、名次與獎金不變（第 2 名 NT$400）
  const s = setup();
  const K = raceTo(s, { rivalFinish: 1 });
  const a = s.world.cars[0];
  const before = s.races.update(1 / 60, s.ctx).rank;
  if (kind === 'wrecked') a.health = 0;
  else a.driven = true;
  const r = s.races.update(1 / 60, s.ctx);
  check(`回歸：已完賽對手車${kind === 'wrecked' ? '被撞毀' : '被搶走'} → 不判退出、名次不變`, !s.races.rivals[0].out && s.races.rivals[0].finished && r.rank === before, `rank ${before} → ${r.rank}`);
  for (let k = 0; k < K; k++) drivePlayerTo(s, s.race.checkpoints[k].x, s.race.checkpoints[k].z, 60);
  const fin = s.log.find((e) => e[0] === 'race:finish');
  check(`回歸：已完賽對手車${kind === 'wrecked' ? '被撞毀' : '被搶走'} → 玩家完賽第 2 名、獎金 NT$400`, fin && fin[1].rank === 2 && s.money.join() === '400', fin && JSON.stringify(fin[1]));
}
for (const kind of ['driven', 'wrecked']) {
  // 🟡 未完賽的對手車退出（被搶走 / 毀損）→ world.hold：棄置的車不再自行行駛
  const s = running();
  tick(s, 0.5);
  const a = s.world.cars[0];
  const drove = !!a.cmd;
  if (kind === 'wrecked') a.health = 0;
  else a.driven = true;
  s.races.update(1 / 60, s.ctx);
  check(`回歸：對手車${kind === 'wrecked' ? '毀損' : '被搶走'}退出 → world.hold（不再給油門）`, drove && s.races.rivals[0].out && a.held && a.cmd === null);
  if (kind === 'driven') {
    a.driven = false; // 玩家下車棄置
    s.world.drives.length = 0;
    tick(s, 1);
    check('回歸：被棄置的退出對手車之後不再 drive', a.cmd === null && s.world.cars.slice(1).every((c) => c.cmd) && s.world.drives.length > 0);
  }
}
{
  // 🟡 名次先比已過檢查點數：玩家過第 1 點後沿路網繞離第 2 點 120 m；對手離第 1 點 13 m 未過點 → 玩家仍第 1
  const s = running();
  s.world.step = () => {};
  const [c1, c2] = s.race.checkpoints;
  s.ctx.player.x = c1.x;
  s.ctx.player.z = c1.z;
  s.races.update(1 / 60, s.ctx);
  const dx = c2.x - c1.x;
  const dz = c2.z - c1.z;
  const L = Math.hypot(dx, dz);
  s.ctx.player.x = c1.x - (dx / L) * 20 + (-dz / L) * 120; // 背離第 2 點、橫向 120 m
  s.ctx.player.z = c1.z - (dz / L) * 20 + (dx / L) * 120;
  const [a, b] = s.world.cars;
  a.x = c1.x - (dx / L) * 13;
  a.z = c1.z - (dz / L) * 13;
  b.x = c1.x + 5000;
  b.z = c1.z;
  const r = s.races.update(1 / 60, s.ctx);
  check('回歸：名次先比已過檢查點數（玩家 cp 1 繞路 vs 對手 cp 0 離點 13 m）→ 玩家 1/3', s.races.checkpoint === 1 && s.races.rivals[0].cp === 0 && r.rank === 1 && r.total === 3, `cp ${s.races.checkpoint}/${s.races.rivals[0].cp} rank ${r.rank}/${r.total}`);
}
{
  // 🟡 開賽車況：未停車（≥ START_MAX_SPEED）/ 熄火 / 翻車 → toast 不開賽；低速可開賽
  for (const [label, extra, reason, text] of [
    ['車速 25 m/s', { speed: 25 }, 'moving', TOAST_MOVING],
    ['倒車 −5 m/s', { speed: -5 }, 'moving', TOAST_MOVING],
    ['熄火', { stalled: true }, 'stalled', TOAST_STALLED],
    ['翻車', { overturned: true }, 'overturned', TOAST_OVERTURNED],
  ]) {
    const s = setup();
    const c = s.races.canStart(s.race.id, startCtx(s, extra));
    const ok = s.races.start(s.race.id, startCtx(s, extra));
    check(`回歸：開賽條件 ${label} → ${reason}、toast「${text}」、不開賽`, c.reason === reason && !ok && !s.races.active && s.toasts.includes(text) && s.log.length === 0);
  }
  const s = setup();
  check(`回歸：車速 < ${START_MAX_SPEED} m/s（2.5）可開賽`, START_MAX_SPEED === 3 && s.races.start(s.race.id, startCtx(s, { speed: 2.5 })) && s.races.active);
}

// ---------- 最佳成績 / 存檔相容 ----------
{
  const s = setup();
  check('無紀錄：serialize() 回 null（存檔省略）', s.races.serialize() === null && s.races.bestOf(s.race.id) === null);
  let K = raceTo(s);
  for (let k = 0; k < K; k++) drivePlayerTo(s, s.race.checkpoints[k].x, s.race.checkpoints[k].z, 40);
  const t1 = s.races.bestOf(s.race.id);
  check('首次完賽 → 新紀錄（toast 標示）', t1 > 0 && s.toasts.some((t) => t.includes('新紀錄')));
  // 較慢一次：紀錄不變
  s.toasts.length = 0;
  s.world.step = fakeWorld().step;
  K = raceTo(s);
  for (let k = 0; k < K; k++) drivePlayerTo(s, s.race.checkpoints[k].x, s.race.checkpoints[k].z, 20);
  check('較慢完賽：最佳成績不變、不標新紀錄', s.races.bestOf(s.race.id) === t1 && !s.toasts.some((t) => t.includes('新紀錄')));
  const ser = s.races.serialize();
  check('serialize：{ best: { raceId: 秒 } }', ser && near(ser.best[s.race.id], t1) && Object.keys(ser.best).length === 1);
  const s2 = setup();
  s2.races.restore(ser);
  check('restore：還原最佳成績；restore(undefined)（舊存檔）清空', near(s2.races.bestOf(s.race.id), t1) && (s2.races.restore(undefined), s2.races.bestOf(s.race.id) === null));
  // save.js
  const old = validateSave({ version: 2, money: 900, missions: { completed: { a: 1 } } });
  check('save.js：舊存檔（無 races）→ 讀入成功、無 races 欄位、其他欄位照舊', old && old.money === 900 && !('races' in old) && old.missions.completed.a === 1);
  check('save.js：defaultSave 不含 races（新局存檔形狀不變）', !('races' in defaultSave()));
  const withR = validateSave({ ...defaultSave(), races: ser });
  check('save.js：races.best 保留', withR && near(withR.races.best[s.race.id], t1));
  const v1 = validateSave({ version: 1, money: 10, races: { best: { 'qiqi-classic': 80 } } });
  check('save.js：v1 存檔遷移後 races 照收', v1 && v1.races && v1.races.best['qiqi-classic'] === 80);
  const bad1 = validateSave({ ...defaultSave(), races: 'x' });
  const bad2 = validateSave({ ...defaultSave(), races: { best: { a: -1, b: 'q', c: 0, '': 5 } } });
  const bad3 = validateSave({ ...defaultSave(), races: { best: [1, 2] } });
  check('save.js：races 格式錯誤整欄丟棄、非法值丟棄、清洗後空 → 省略', bad1 && !('races' in bad1) && bad2 && !('races' in bad2) && bad3 && !('races' in bad3));
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const store = createSaveStore({ storage });
  store.save({ ...defaultSave(), races: ser });
  const loaded = store.load();
  check('save.js：createSaveStore 存 / 讀 races 往返', loaded.status === 'ok' && near(loaded.data.races.best[s.race.id], t1));
  const s3 = setup();
  s3.races.restore(loaded.data.races);
  check('讀檔 → races.restore → bestOf 一致', near(s3.races.bestOf(s.race.id), t1));
}

// ---------- 結束條件 ----------
function running(opts) {
  const s = setup(opts);
  s.races.start(s.race.id, startCtx(s));
  tick(s, COUNTDOWN_SEC + 0.05);
  return s;
}
const aborted = (s, reason) => s.log.some((e) => e[0] === 'race:abort' && e[1].reason === reason);
{
  const s = running();
  s.ctx.inCar = false;
  tick(s, LEFT_SEC - 0.2);
  const still = s.races.active;
  s.ctx.inCar = true;
  tick(s, 0.1);
  s.ctx.inCar = false;
  tick(s, LEFT_SEC - 0.2);
  const still2 = s.races.active;
  tick(s, 0.4);
  check(`下車 ≤ ${LEFT_SEC} s 不退賽（回車上歸零）、> ${LEFT_SEC} s 退賽 left + toast + 對手車回收`, still && still2 && !s.races.active && aborted(s, 'left') && s.toasts.includes('退賽：離開車輛太久') && s.world.removed.length === 2);
}
{
  const s = running();
  s.ctx.wrecked = true;
  s.races.update(1 / 60, s.ctx);
  check('車毀（wrecked）→ 退賽', !s.races.active && aborted(s, 'wrecked') && s.toasts.includes('退賽：車輛毀損'));
  const s2 = setup();
  s2.races.start(s2.race.id, startCtx(s2));
  s2.races.update(1 / 60, s2.ctx);
  s2.ctx.wrecked = true;
  s2.races.update(1 / 60, s2.ctx);
  check('倒數中車毀也退賽、對手車回收', !s2.races.active && aborted(s2, 'wrecked') && s2.world.removed.length === 2);
}
for (const kind of ['busted', 'wasted']) {
  const s = running();
  s.bus.emit(`player:${kind}`, {});
  check(`player:${kind}（bus 保底）→ 退賽 ${kind}`, !s.races.active && aborted(s, kind));
  const s2 = running();
  s2.races.end(kind);
  check(`end('${kind}')（beginRespawn → vigHooks.end）→ 退賽、toast`, !s2.races.active && aborted(s2, kind) && s2.toasts.length === 1);
}
{
  const s = running();
  check('cancel()：回 true、退賽 cancel、不 toast、對手車回收', s.races.cancel() && !s.races.active && aborted(s, 'cancel') && s.toasts.length === 0 && s.world.removed.length === 2);
  check('cancel()：未開賽時回 false、不發事件', !s.races.cancel() && s.log.filter((e) => e[0] === 'race:abort').length === 1);
  check('END_REASONS 列舉', END_REASONS.join() === 'left,wrecked,busted,wasted,cancel');
  const s2 = running();
  s2.races.dispose();
  s2.bus.emit('player:busted', {});
  check('dispose：退賽並取消訂閱', !s2.races.active && s2.log.filter((e) => e[0] === 'race:abort').length === 1);
  const s3 = running();
  const before = s3.races.elapsed;
  s3.races.update(5, s3.ctx);
  check('dt clamp：單幀 5 s 只算 0.1 s', near(s3.races.elapsed - before, 0.1, 1e-9));
  const s4 = running();
  s4.world.cars[0].driven = true;
  const r = s4.races.update(1 / 60, s4.ctx);
  check('對手車被玩家搶走（driven）→ 該車退出比賽', s4.races.rivals[0].out && r.total === 3);
}

// ---------- 幀率無關 ----------
// 玩家位置 = 沿「起點 → 各檢查點」折線、以固定車速行駛的連續函式（GO 起算），與幀率無關；對手車由替身世界依 drive 指令推進
function simulate(dt) {
  const s = setup();
  s.races.start(s.race.id, startCtx(s));
  const path = [s.race.start, ...s.race.checkpoints];
  const speed = 22;
  const times = [];
  s.bus.on('race:checkpoint', (e) => times.push(e.time));
  const at = (d) => {
    for (let i = 1; i < path.length; i++) {
      const L = Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
      if (d <= L) return { x: path[i - 1].x + ((path[i].x - path[i - 1].x) * d) / L, z: path[i - 1].z + ((path[i].z - path[i - 1].z) * d) / L };
      d -= L;
    }
    return path[path.length - 1];
  };
  let simT = 0;
  for (let n = 0; simT < 400 && s.races.active; n++) {
    simT = (n + 1) * dt;
    const p = at(speed * Math.max(0, simT - COUNTDOWN_SEC));
    s.ctx.player.x = p.x;
    s.ctx.player.z = p.z;
    s.races.update(dt, s.ctx);
    s.world.step(dt);
  }
  const fin = s.log.find((e) => e[0] === 'race:finish');
  return { fin: fin && fin[1], times };
}
{
  const runs = [1 / 30, 1 / 60, 1 / 144].map(simulate);
  const ok = runs.every((r) => r.fin);
  const t = runs.map((r) => (r.fin ? r.fin.time : NaN));
  check('幀率無關：1/30、1/60、1/144 皆完賽、完賽時間差 ≤ 1 幀（1/30 s）', ok && Math.max(...t) - Math.min(...t) <= 1 / 30 + 1e-6, t.map((x) => x.toFixed(3)).join(' / '));
  check('幀率無關：名次相同、各檢查點時間差 ≤ 1 幀', ok && new Set(runs.map((r) => r.fin.rank)).size === 1 && runs[0].times.every((x, i) => runs.every((r) => Math.abs(r.times[i] - x) <= 1 / 30 + 1e-6)), runs.map((r) => r.fin && r.fin.rank).join('/'));
}

// ---------- 對手車世界（createRivalWorld）----------
{
  const adopted = [];
  const removed = [];
  const health = new Map();
  const vehicles = {
    vehicles: [],
    adopt(o) {
      const pos = Object.freeze({ x: o.x, z: o.z }); // 凍結：世界介面若改寫座標（瞬移）會在 strict mode 丟例外
      const v = { ...o, pos, yaw: o.yaw, speed: 0, driven: false, ctl: null, setControls(c) { this.ctl = c; } };
      this.vehicles.push(v);
      adopted.push(o);
      return v;
    },
    remove(v) {
      removed.push(v);
      const i = this.vehicles.indexOf(v);
      if (i >= 0) this.vehicles.splice(i, 1);
    },
  };
  const player = { type: 'sedan', pos: { x: 0, z: 0 }, driven: true };
  vehicles.vehicles.push(player);
  const dmg = { attach: (v) => health.set(v, 1000), detach: (v) => health.delete(v), healthOf: (v) => (health.has(v) ? health.get(v) : null) };
  const routes = [];
  let kept = null;
  const keptList = [];
  const w = createRivalWorld({
    vehicles,
    dmg,
    traffic: { cars: [{ pos: { x: 100, z: 0 } }] },
    findRoute: (a, b) => {
      routes.push([a, b]);
      return { points: [a, { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }, b] };
    },
    rng: () => 0,
    isFree: (x) => x !== 50,
    isKept: (v) => v === kept,
    onKeep: (v) => keptList.push(v),
  });
  check('spawn：佔用中（玩家車 / 車流車同格）回 null', w.spawn({ x: 1, z: 2, heading: 0 }) === null && w.spawn({ x: 100, z: 3, heading: 0 }) === null);
  check('spawn：isFree 假（建築內）回 null', w.spawn({ x: 50, z: 50, heading: 0 }) === null);
  const a = w.spawn({ x: 3.5, z: 0, heading: 0 }); // 玩家車旁並排 3.5 m：可
  const b = w.spawn({ x: 0, z: -8, heading: 0 });
  check('spawn：並排 3.5 m / 後排 8 m 可放；vehicles.adopt 一般車型（動態剛體）、v.ai / v.racer、dmg.attach', a && b && adopted.length === 2 && adopted.every((o) => ['sedan', 'suv'].includes(o.type)) && a.v.ai && a.v.racer && health.size === 2);
  let threw = null;
  try {
    w.hold(a);
    w.update(1 / 60);
    const held = a.v.ctl && a.v.ctl.brake === 1 && a.v.ctl.throttle === 0;
    w.drive(a, { x: 0, z: 200, maxSpeed: 20 });
    w.update(1 / 60);
    const go = a.v.ctl && a.v.ctl.throttle > 0;
    check('hold → 煞停；drive → 給油門、沿 findRoute 路線', held && go && routes.length === 1);
    w.drive(a, { x: 300, z: 300, maxSpeed: 20 });
    w.update(1 / 60);
    check('換下一個檢查點（目標移動 > 20 m）→ 重算路線', routes.length === 2);
    a.v.speed = 0;
    for (let i = 0; i < 200; i++) w.update(1 / 60);
    check('卡住（全油門低速 2.5 s）→ 倒車脫困', a.v.ctl.throttle === -1);
    w.brakeAll();
    check('brakeAll：凍結時煞停', a.v.ctl.brake === 1 && a.v.ctl.throttle === 0);
  } catch (e) {
    threw = e;
  }
  check('對手車世界不改寫車輛座標（無瞬移；位置只由物理推進）', threw === null, threw && threw.message);
  const st = w.state(a);
  check('state：座標 / 耐久 / exists', st.exists && st.x === 3.5 && st.health === 1000 && !st.driven);
  kept = b.v;
  w.remove(b);
  w.remove(a);
  check('remove：一般 → vehicles.remove + detach；isKept（玩家上車中）→ 保留、onKeep', removed.includes(a.v) && !health.has(a.v) && !removed.includes(b.v) && keptList.includes(b.v) && !b.v.racer);
  check('remove 後 state.exists = false', !w.state(a).exists);
  const w2 = createRivalWorld({ vehicles, dmg });
  const c = w2.spawn({ x: 500, z: 500, heading: 0 });
  w2.dispose();
  check('dispose：回收全部對手車', removed.includes(c.v) && w2.cars.size === 0);
}

// ---------- HUD ----------
function fakeDoc() {
  const mkEl = (tag) => {
    const el = { tag, className: '', hidden: false, textContent: '', style: {}, children: [], appendChild(c) { el.children.push(c); return c; }, remove() { el.removed = true; } };
    return el;
  };
  const body = mkEl('body');
  const doc = { body, createElement: mkEl };
  body.ownerDocument = doc;
  return doc;
}
{
  const doc = fakeDoc();
  const hud = createRaceHud({ root: doc.body, doc });
  check('createRaceHud：.race-bar / .race-count / .race-arrow，初始隱藏', ['race-bar', 'race-count', 'race-arrow'].every((c) => doc.body.children.some((e) => e.className === c && e.hidden)));
  const s = setup();
  s.races.start(s.race.id, startCtx(s));
  hud.set(s.races.update(1 / 60, s.ctx), 0);
  check('倒數：大字「3」、任務條顯示、箭頭隱藏', hud.count.textContent === '3' && !hud.count.hidden && !hud.bar.hidden && hud.arrow.hidden);
  const r = tick(s, COUNTDOWN_SEC);
  hud.set(r, Math.PI / 2);
  check('GO!：大字 GO!、箭頭顯示並旋轉 90°', hud.count.textContent === 'GO!' && !hud.arrow.hidden && hud.arrow.style.transform.includes('rotate(90deg)'));
  hud.set(tick(s, 1.5), 0);
  check('比賽中：倒數收起、任務條「名次 n/m｜檢查點 k/K｜mm:ss.s」', hud.count.hidden && /^名次 \d\/3｜檢查點 0\/5｜00:0\d\.\d$/.test(hud.bar.textContent), hud.bar.textContent);
  hud.set(null);
  check('set(null)：全部隱藏', hud.bar.hidden && hud.count.hidden && hud.arrow.hidden);
  check('無 document：退化為 no-op', typeof createRaceHud({ doc: null }).set === 'function');
}

// ---------- 原始碼：純邏輯、不豁免犯行 ----------
{
  const src = read('src/missions/race.js');
  check('race.js：不 import three / rapier / hud / main', !/^import .*(three|rapier)/m.test(src) && !/^import .*(hud|main)\.js/m.test(src));
  check('race.js：比賽中犯行照常（不呼叫 report、無犯行豁免介面）', !/\breport\(|CRIMES|isFugitiveActor|isEventActor|shotAt|fugitiveActor/.test(src));
}

console.log(`${failed === 0 ? 'PASS' : 'FAIL'} ${failed === 0 ? passed : failed}/${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
