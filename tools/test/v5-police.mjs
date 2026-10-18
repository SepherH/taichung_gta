// 無頭驗證 V5 警方升級：src/wanted/helicopter.js（直升機）、police.js（車上開槍 / 路障 / 特警）、adapters.js（命中率 / 路障 / 特警 / 車內中彈）、
// ui.js（星數 class / 警示光暈）＋ main.js / interfaces.md 靜態接線；全部純邏輯 + 替身，不需 three / rapier
// 用法：node tools/test/v5-police.mjs [-v 列出每項斷言]（任一斷言失敗 exit 1）
import { readFileSync } from 'node:fs';
import { createBus } from '../../src/core/events.js';
import { createWanted } from '../../src/wanted/wanted.js';
import {
  createPolice, speedHitFactor, MAX_CARS, MAX_OFFICERS, HIT_SPEED_FLOOR, HIT_SPEED_REF, CAR_FIRE_MIN, CAR_FIRE_MAX,
  MAX_ROADBLOCKS, ROADBLOCK_MIN, ROADBLOCK_MAX, SWAT_OFFICERS, FIRE_MIN, FIRE_MAX,
} from '../../src/wanted/police.js';
import {
  createHelicopter, heliHitChance, raySphere, HELI_STARS, GUNNER_STARS, ALT_MIN, ALT_MAX, MIN_CLEAR, BODY_R, HELI_HP, HIT_DAMAGE,
  HELI_RESPAWN, SPOT_RADIUS, DESPAWN_DIST, GUN_NEAR, GUN_RANGE,
} from '../../src/wanted/helicopter.js';
import {
  createPoliceAdapters, hitChance, sirenStarGain, sirenFreq, graphJunctions, HIT_MAX, SIREN_LOW, SIREN_HIGH, SWAT_TYPE, SWAT_COLOR,
  SWAT_VAN_HEALTH, OFFICER_HP, SWAT_TOUGHNESS, CAR_HIT_VEHICLE_DAMAGE, MAX_CONES, ROADBLOCK_CONES,
} from '../../src/wanted/adapters.js';
import { createWantedUI, ALERT_STARS } from '../../src/wanted/ui.js';
import * as HELI from '../../src/wanted/helicopter.js';

let pass = 0;
let total = 0;
const fails = [];
const VERBOSE = process.argv.includes('-v');
function ok(cond, msg) {
  total++;
  if (VERBOSE) console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (cond) pass++;
  else fails.push(msg);
}

const FRAME = 1 / 60;

function mulberry(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fakeWanted(stars = 0, state = stars ? 'active' : 'clear') {
  return { stars, state, searchCircle: null, lastKnown: null };
}

// ---------- 直升機替身 ----------
// buildings: [{ x0, z0, x1, z1, h }]，obstacleTop = 地面 0 + 建築高
function makeHeli({ stars = 4, buildings = [], seed = 1, combat = null, explode = null, wanted = null, bus = null } = {}) {
  const b = bus || createBus();
  const w = wanted || fakeWanted(stars);
  const top = (x, z) => {
    let m = 0;
    for (const k of buildings) if (x >= k.x0 && x <= k.x1 && z >= k.z0 && z <= k.z1 && k.h > m) m = k.h;
    return m;
  };
  const events = [];
  b.on('police:heli', (e) => events.push({ ...e }));
  const explodes = [];
  const heli = createHelicopter({
    bus: b,
    wanted: w,
    combat,
    heightAt: () => 0,
    obstacleTop: top,
    explode: explode || ((x, y, z, o) => explodes.push({ x, y, z, ...o })),
    getPlayerActor: () => (combat ? combat.player : null),
    rng: mulberry(seed),
  });
  const ctx = { player: { x: 0, z: 0, inVehicle: false, speed: 0 }, paused: false };
  return {
    heli, bus: b, wanted: w, events, explodes, ctx, top,
    run(sec, dt = FRAME, each = null) {
      const n = Math.round(sec / dt);
      let seenAny = false;
      for (let i = 0; i < n; i++) {
        if (each) each(i * dt);
        if (heli.update(dt, ctx)) seenAny = true;
      }
      return seenAny;
    },
  };
}

// 假 combat：記錄 applyHit
function fakeCombat() {
  const c = {
    player: { id: 'player', kind: 'player', hp: 100, pos: { x: 0, y: 0, z: 0 } },
    hits: [],
    applyHit(o) {
      c.hits.push(o);
      return { damage: o.damage, hp: (c.player.hp -= o.damage) };
    },
    newSwingId: () => 1,
  };
  return c;
}

// ── 1. 命中率曲線 ──
{
  ok(speedHitFactor(0) === 1 && speedHitFactor(HIT_SPEED_REF) === HIT_SPEED_FLOOR && speedHitFactor(HIT_SPEED_REF * 3) === HIT_SPEED_FLOOR, `speedHitFactor：0 m/s = 1、≥ ${HIT_SPEED_REF} m/s = ${HIT_SPEED_FLOOR}`);
  let mono = true;
  for (let v = 0; v < 40; v += 1) if (speedHitFactor(v + 1) > speedHitFactor(v)) mono = false;
  ok(mono && speedHitFactor(15) < 1 && speedHitFactor(15) > HIT_SPEED_FLOOR, 'speedHitFactor 隨速度單調遞減');
  ok(hitChance(FIRE_MIN) === HIT_MAX && hitChance(FIRE_MIN, 0) === HIT_MAX, '警員命中率：靜止玩家同 Phase 7（FIRE_MIN 70%）');
  ok(hitChance(FIRE_MIN, 20) < hitChance(FIRE_MIN, 0) && hitChance(FIRE_MAX, 20) < hitChance(FIRE_MAX, 0), '警員命中率：玩家速度越快越低');
  ok(Math.abs(hitChance(15, 30) - hitChance(15) * HIT_SPEED_FLOOR) < 1e-12, '警員命中率 = 距離曲線 × 速度係數');
  ok(heliHitChance(GUN_NEAR) > heliHitChance((GUN_NEAR + GUN_RANGE) / 2) && heliHitChance((GUN_NEAR + GUN_RANGE) / 2) > heliHitChance(GUN_RANGE), '直升機射手命中率隨距離下降');
  ok(heliHitChance(50, 25) < heliHitChance(50, 0) && heliHitChance(GUN_RANGE + 50) === heliHitChance(GUN_RANGE), '直升機射手命中率隨玩家速度下降、射程外夾住');
  ok(sirenStarGain(1) === 1 && sirenStarGain(5) > sirenStarGain(4) && sirenStarGain(4) > sirenStarGain(3) && sirenStarGain(3) > sirenStarGain(2) && sirenStarGain(0) === 0, '警笛增益隨星數遞增（1★ 不變）');
  ok(sirenFreq(0.31, 0, 0.3) === SIREN_HIGH && sirenFreq(0.31) === SIREN_LOW, '≥4★ 警笛節奏可加快（半週期參數）');
  ok(raySphere(0, 0, 0, 0, 1, 0, 0, 50, 0, 3) === 47 && raySphere(0, 0, 0, 1, 0, 0, 0, 50, 0, 3) === -1 && raySphere(0, 0, 0, 0, -1, 0, 0, 50, 0, 3) === -1, 'raySphere：命中距離 / 未命中 / 背向');
}

// ── 2. 星數行為表：開槍門檻（police.js 車上開槍）、路障 / 特警只在 5★ ──
function makePoliceWorld({ stars = 3, seed = 3, spawnDist = 160, roadblocks = true, swat = true } = {}) {
  const bus = createBus();
  const rng = mulberry(seed);
  const w = {
    cars: new Set(), officers: new Set(), drives: new Map(), moves: new Map(), see: true,
    carFires: [], roadblockSpawns: [], roadblockDespawns: [], swatSpawns: 0, swatOfficers: 0, rbFind: [],
  };
  const adapters = {
    findSpawnPoint(nx, nz) {
      const ang = rng() * Math.PI * 2;
      return { x: nx + Math.cos(ang) * spawnDist, z: nz + Math.sin(ang) * spawnDist, heading: 0 };
    },
    spawnCar({ x, z }) {
      const car = { pos: { x, z }, speed: 0, alive: true };
      w.cars.add(car);
      return car;
    },
    despawnCar(car) {
      w.cars.delete(car);
    },
    driveCar(car, cmd) {
      w.drives.set(car, cmd);
    },
    spawnOfficer({ x, z, swat: s }) {
      const o = { pos: { x, z, y: 0 }, alive: true, down: false, swat: !!s };
      if (s) w.swatOfficers++;
      w.officers.add(o);
      return o;
    },
    despawnOfficer(o) {
      w.officers.delete(o);
    },
    moveOfficer(o, cmd) {
      w.moves.set(o, cmd);
    },
    officerAim() {},
    canSee: () => w.see,
    carFire(car, cmd) {
      w.carFires.push({ car, ...cmd });
    },
  };
  if (roadblocks) {
    adapters.findRoadblockPoint = (px, pz, dx, dz, min, max) => {
      w.rbFind.push({ px, pz, dx, dz, min, max });
      const d = (min + max) / 2;
      return { x: px + dx * d, z: pz + dz * d, heading: Math.atan2(dx, dz) };
    };
    adapters.spawnRoadblock = ({ x, z }) => {
      const rb = { pos: { x, z }, alive: true };
      w.roadblockSpawns.push(rb);
      return rb;
    };
    adapters.despawnRoadblock = (rb) => w.roadblockDespawns.push(rb);
  }
  if (swat) {
    adapters.spawnSwat = ({ x, z }) => {
      w.swatSpawns++;
      const car = { pos: { x, z }, speed: 0, alive: true, swat: true };
      w.cars.add(car);
      return car;
    };
  }
  w.step = (dt) => {
    for (const car of w.cars) {
      const cmd = w.drives.get(car);
      if (!cmd || cmd.mode === 'stop') {
        car.speed = 0;
        continue;
      }
      const dx = cmd.x - car.pos.x;
      const dz = cmd.z - car.pos.z;
      const d = Math.hypot(dx, dz);
      const step = Math.min(d, cmd.maxSpeed * dt);
      car.speed = d > 0.01 ? cmd.maxSpeed : 0;
      if (d > 0) {
        car.pos.x += (dx / d) * step;
        car.pos.z += (dz / d) * step;
      }
    }
    for (const o of w.officers) {
      const cmd = w.moves.get(o);
      if (!cmd || o.down || !o.alive) continue;
      const dx = cmd.x - o.pos.x;
      const dz = cmd.z - o.pos.z;
      const d = Math.hypot(dx, dz);
      const step = Math.min(d, (cmd.run ? 6 : 1.5) * dt);
      if (d > 0) {
        o.pos.x += (dx / d) * step;
        o.pos.z += (dz / d) * step;
      }
    }
  };
  const wanted = fakeWanted(stars);
  const ev = { shoot: 0, carshoot: 0, roadblock: [], swat: [] };
  bus.on('police:shoot', () => ev.shoot++);
  bus.on('police:carshoot', () => ev.carshoot++);
  bus.on('police:roadblock', (e) => ev.roadblock.push({ ...e }));
  bus.on('police:swat', (e) => ev.swat.push({ ...e }));
  const police = createPolice({ bus, wanted, adapters, rng: mulberry(seed + 50) });
  const player = { x: 0, z: 0, inVehicle: true, speed: 0, down: false, dirX: NaN, dirZ: NaN };
  const sim = {
    w, wanted, police, player, ev, bus,
    run(sec, dt = FRAME, each = null) {
      const n = Math.round(sec / dt);
      for (let i = 0; i < n; i++) {
        if (each) each(dt);
        police.update(dt, { player });
        w.step(dt);
      }
    },
  };
  return sim;
}

{
  // 車上開槍門檻：玩家開車（不放警員）、警車追近
  for (const st of [1, 2]) {
    const s = makePoliceWorld({ stars: st });
    s.run(20);
    ok(s.w.carFires.length === 0 && s.ev.carshoot === 0 && s.ev.shoot === 0, `${st}★：車上 / 下車警察都不開槍（維持追捕 / 拘捕）`);
  }
  for (const st of [3, 4, 5]) {
    const s = makePoliceWorld({ stars: st });
    s.run(20);
    ok(s.w.carFires.length > 0 && s.ev.carshoot === s.w.carFires.length, `${st}★：車上警察開槍（${s.w.carFires.length} 發，emit police:carshoot）`);
    const dOk = s.w.carFires.every((f) => f.x === 0 && f.z === 0);
    ok(dOk, `${st}★：車上開槍瞄準玩家位置`);
  }
  // 距離 / 視線門檻
  {
    const s = makePoliceWorld({ stars: 3 });
    s.run(3);
    const car = [...s.w.cars][0];
    const hold = (d, sec) => {
      for (let i = 0; i < sec / FRAME; i++) {
        car.pos.x = d;
        car.pos.z = 0;
        s.police.update(FRAME, { player: s.player });
      }
    };
    s.w.carFires.length = 0;
    hold(CAR_FIRE_MAX + 5, 4);
    ok(s.w.carFires.length === 0, `> ${CAR_FIRE_MAX} m 車上不開槍`);
    s.w.see = false;
    hold(20, 4);
    ok(s.w.carFires.length === 0, 'canSee=false 車上不開槍');
    s.w.see = true;
    hold(20, 4);
    const n = s.w.carFires.length;
    ok(n >= 2 && n <= 4, `20 m 看得見 → 每 1.2–2.0 s 一發（4 s ${n} 發）`);
    hold(CAR_FIRE_MIN - 3, 3);
    ok(s.w.carFires.length === n, `< ${CAR_FIRE_MIN} m 車上不開槍`);
  }
  // 路障 / 特警只在 5★
  for (const st of [3, 4]) {
    const s = makePoliceWorld({ stars: st });
    s.run(30, FRAME, (dt) => {
      s.player.z += 20 * dt;
    });
    ok(s.w.roadblockSpawns.length === 0 && s.w.swatSpawns === 0, `${st}★：不生成路障 / 特警車`);
  }
  {
    const s = makePoliceWorld({ stars: 5 });
    let maxRb = 0;
    let maxSwat = 0;
    let maxSwatOff = 0;
    let maxRegOff = 0;
    let maxRegCars = 0;
    s.run(90, FRAME, (dt) => {
      s.player.z += 18 * dt; // 一路往 +z 開
      s.player.speed = 18;
      maxRb = Math.max(maxRb, s.police.roadblocks.length);
      maxSwat = Math.max(maxSwat, [...s.w.cars].filter((c) => c.swat).length);
      maxSwatOff = Math.max(maxSwatOff, [...s.w.officers].filter((o) => o.swat).length);
      maxRegOff = Math.max(maxRegOff, [...s.w.officers].filter((o) => !o.swat).length);
      maxRegCars = Math.max(maxRegCars, [...s.w.cars].filter((c) => !c.swat).length);
    });
    ok(s.w.roadblockSpawns.length >= 2, `5★：生成路障（${s.w.roadblockSpawns.length} 組）`);
    ok(maxRb <= MAX_ROADBLOCKS, `路障同時 ≤ ${MAX_ROADBLOCKS} 組（最多 ${maxRb}）`);
    const f = s.w.rbFind[0];
    ok(f && f.min === ROADBLOCK_MIN && f.max === ROADBLOCK_MAX && Math.abs(f.dz - 1) < 1e-6 && Math.abs(f.dx) < 1e-6, `路障找點：玩家前進方向（位移取樣 +z）${ROADBLOCK_MIN}–${ROADBLOCK_MAX} m`);
    ok(s.ev.roadblock.some((e) => e.type === 'spawn') && s.ev.roadblock.some((e) => e.type === 'despawn'), 'emit police:roadblock spawn / despawn（玩家越過後回收）');
    ok(s.w.swatSpawns >= 1 && maxSwat <= 1, `5★：特警車 ≤ 1 台（生成 ${s.w.swatSpawns} 次、同時最多 ${maxSwat}）`);
    ok(s.ev.swat.some((e) => e.type === 'spawn'), 'emit police:swat spawn');
    ok(maxSwatOff <= SWAT_OFFICERS, `特警同時 ≤ ${SWAT_OFFICERS} 名（最多 ${maxSwatOff}）`);
    ok(maxRegOff <= MAX_OFFICERS[5] && maxRegCars <= MAX_CARS[5], `特警不佔一般警力名額（一般警員 ${maxRegOff} ≤ ${MAX_OFFICERS[5]}、警車 ${maxRegCars} ≤ ${MAX_CARS[5]}）`);
  }
  // 特警下車：玩家步行停住
  {
    const s = makePoliceWorld({ stars: 5, roadblocks: false });
    s.player.inVehicle = false;
    s.run(25);
    const swatOff = [...s.w.officers].filter((o) => o.swat).length;
    ok(s.w.swatOfficers === SWAT_OFFICERS && swatOff > 0, `特警車靠近停車放 ${SWAT_OFFICERS} 名特警（spawnOfficer swat: true）`);
    ok(s.ev.swat.some((e) => e.type === 'deploy' && e.officers === SWAT_OFFICERS), 'emit police:swat deploy');
    ok(s.police.officers.filter((o) => o.swat).length === swatOff && s.police.cars.some((c) => c.swat), '特警車 / 特警列入 police.cars / officers（視線、逮捕、小地圖共用）');
    // 殉職不補
    for (const o of s.w.officers) if (o.swat) o.alive = false;
    s.run(1);
    s.police.update(FRAME, { player: s.player });
    s.run(15);
    ok(s.w.swatOfficers === SWAT_OFFICERS, '特警殉職後不再補人');
  }
  // 降星：路障 / 特警回收；cancelExtras 立即回收
  {
    const s = makePoliceWorld({ stars: 5 });
    s.run(30, FRAME, (dt) => {
      s.player.z += 18 * dt;
    });
    ok(s.police.roadblocks.length > 0 && !!s.police.swat, '5★ 30 s：場上有路障與特警車');
    s.wanted.stars = 3;
    s.w.see = false; // 離開視線
    s.run(2);
    ok(s.police.roadblocks.length === 0, '降到 3★：路障離開視線即回收');
    s.run(25);
    ok(!s.police.swat && [...s.w.cars].every((c) => !c.swat) && [...s.w.officers].every((o) => !o.swat), '降到 3★：特警車與特警回收');
    const s2 = makePoliceWorld({ stars: 5 });
    s2.run(30, FRAME, (dt) => {
      s2.player.z += 18 * dt;
    });
    const before = s2.police.roadblocks.length;
    s2.police.cancelExtras();
    ok(before > 0 && s2.police.roadblocks.length === 0 && !s2.police.swat && [...s2.w.cars].every((c) => !c.swat), 'cancelExtras：看得見也立即回收路障與特警');
    s2.police.dispose();
    ok(s2.w.cars.size === 0 && s2.w.officers.size === 0, 'dispose 清空所有警力');
  }
  // 未提供 V5 adapters：行為同 Phase 7（不呼叫、不報錯）
  {
    const s = makePoliceWorld({ stars: 5, roadblocks: false, swat: false });
    let threw = false;
    try {
      s.run(20, FRAME, (dt) => {
        s.player.z += 18 * dt;
      });
    } catch {
      threw = true;
    }
    ok(!threw && s.police.roadblocks.length === 0 && !s.police.swat, '缺 V5 adapters：路障 / 特警關閉、不報錯');
  }
}

// ── 3. 直升機：出現 / 離開 / 上限 ──
{
  const h = makeHeli({ stars: 3 });
  h.run(10);
  ok(h.heli.state === 'off' && !h.events.length, `${HELI_STARS - 1}★：不出動直升機`);
  h.wanted.stars = HELI_STARS;
  h.run(0.1);
  ok(h.heli.state === 'arrive' && h.events.some((e) => e.type === 'arrive'), `${HELI_STARS}★：直升機出動（emit police:heli arrive）`);
  h.run(25);
  ok(h.heli.state === 'orbit', `直升機飛抵玩家上空盤旋（${h.heli.state}）`);
  const p = h.heli.pos;
  ok(Math.hypot(p.x, p.z) < 45, `盤旋在玩家附近（水平 ${Math.hypot(p.x, p.z).toFixed(1)} m）`);
  let altOk = true;
  let lo = Infinity;
  let hi = -Infinity;
  h.run(30, FRAME, () => {
    const y = h.heli.pos.y;
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
    if (y < ALT_MIN || y > ALT_MAX) altOk = false;
  });
  ok(altOk, `無障礙時高度維持 ${ALT_MIN}–${ALT_MAX} m（${lo.toFixed(1)}–${hi.toFixed(1)}）`);
  // 上限：同時只有一架（單一物件），重複 update 不會再發 arrive
  const arrives = h.events.filter((e) => e.type === 'arrive').length;
  ok(arrives === 1, `同時至多 1 架（arrive ${arrives} 次）`);
  // 星數下降 → 飛離 → off
  h.wanted.stars = 2;
  h.run(0.1);
  ok(h.heli.state === 'leave' && h.events.some((e) => e.type === 'leave'), '降到 2★：直升機飛離（emit leave）');
  h.run(30);
  ok(h.heli.state === 'off' && h.events.some((e) => e.type === 'gone'), `飛離 ${DESPAWN_DIST} m 後收起（emit gone）`);
  // 飛離途中回到 4★ → 掉頭
  const h2 = makeHeli({ stars: 4 });
  h2.run(20);
  h2.wanted.stars = 1;
  h2.run(2);
  h2.wanted.stars = 4;
  h2.run(0.1);
  const evs = h2.events.map((e) => e.type);
  ok((h2.heli.state === 'arrive' || h2.heli.state === 'orbit') && evs.lastIndexOf('arrive') > evs.indexOf('leave') && evs.indexOf('leave') > 0, `飛離途中星數回升 → 掉頭回來（${h2.heli.state}）`);
}

// ── 4. 直升機避障：高樓在航線上 → 不穿模 ──
{
  // 玩家旁 60 m 一棟 150 m 高樓（盤旋圈與進場航線都會經過）
  const tower = { x0: 15, z0: -30, x1: 60, z1: 30, h: 150 };
  const ring = [[0, 0], [BODY_R, 0], [-BODY_R, 0], [0, BODY_R], [0, -BODY_R]];
  let worst = Infinity;
  let overTower = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const h = makeHeli({ stars: 4, buildings: [tower], seed });
    h.run(80, FRAME, () => {
      const p = h.heli.pos;
      if (h.heli.state === 'off') return;
      let t = 0;
      for (const [ox, oz] of ring) t = Math.max(t, h.top(p.x + ox, p.z + oz));
      worst = Math.min(worst, p.y - t);
      if (h.top(p.x, p.z) > 0) overTower++;
    });
  }
  ok(worst >= MIN_CLEAR - 1e-6, `高樓（150 m）在航線 / 盤旋圈上：機身四點淨空恆 ≥ ${MIN_CLEAR} m（最小 ${worst.toFixed(2)} m）`);
  ok(overTower > 0, `確實飛越高樓上空（${overTower} 幀）`);
  // 起飛點在高樓內：立即抬升到樓頂之上
  const h = makeHeli({ stars: 4, buildings: [{ x0: -1000, z0: -1000, x1: 1000, z1: 1000, h: 90 }] });
  h.run(0.2);
  ok(h.heli.pos.y >= 90 + MIN_CLEAR, `全區 90 m 樓群：高度在樓頂之上（${h.heli.pos.y.toFixed(1)} m）`);
}

// ── 5. 探照燈 seen（接 wanted）──
{
  // 玩家靜止：光點追上 → seen
  const h = makeHeli({ stars: 4 });
  h.run(25);
  let seenFrames = 0;
  h.run(5, FRAME, () => {});
  for (let i = 0; i < 120; i++) if (h.heli.update(FRAME, h.ctx)) seenFrames++;
  ok(seenFrames > 100, `玩家靜止：探照燈光圈照到 → seen（${seenFrames}/120 幀）`);
  const s = h.heli.spot;
  ok(Math.hypot(s.x, s.z) <= SPOT_RADIUS && s.on, `光點在玩家 ${SPOT_RADIUS} m 內`);
  // 玩家高速直線逃：光點追不上 → 不再 seen
  let late = 0;
  h.run(20, FRAME, (t) => {
    h.ctx.player.x += 40 * FRAME;
    h.ctx.player.speed = 40;
  });
  for (let i = 0; i < 60; i++) {
    h.ctx.player.x += 40 * FRAME;
    if (h.heli.update(FRAME, h.ctx)) late++;
  }
  ok(late === 0, '玩家以 40 m/s 直線逃離：光點追不上（不再 seen）');
  // 接真 wanted：直升機 seen 讓 wanted 維持 active（地面警力看不到）
  const bus = createBus();
  const wanted = createWanted({ bus });
  wanted.setStars(4);
  const h3 = makeHeli({ wanted, bus });
  h3.run(30, FRAME, () => {
    wanted.update(FRAME, { playerX: 0, playerZ: 0, seen: false });
  });
  // 之後每幀以直升機 seen 餵 wanted
  let state = wanted.state;
  for (let i = 0; i < 60 * 30; i++) {
    const seen = h3.heli.update(FRAME, h3.ctx);
    wanted.update(FRAME, { playerX: 0, playerZ: 0, seen });
    state = wanted.state;
  }
  ok(wanted.stars === 4 && state === 'active', `直升機照著玩家：30 s 內 wanted 維持 active（${state}）`);
  // 搜索中：光點掃描搜索圈而非直追玩家
  const w4 = fakeWanted(4, 'searching');
  w4.searchCircle = { x: 300, z: 0, r: 240 };
  const h4 = makeHeli({ wanted: w4 });
  h4.run(40);
  const sp = h4.heli.spot;
  ok(Math.hypot(sp.x - 300, sp.z) <= 240 * 0.6 + SPOT_RADIUS + 1 || Math.hypot(sp.x - h4.heli.pos.x, sp.z - h4.heli.pos.z) <= 66, 'searching：光點在搜索圈內掃描（不直追玩家）');
}

// ── 6. 射手只在 5★ ──
{
  const c4 = fakeCombat();
  const h4 = makeHeli({ stars: 4, combat: c4 });
  let fires4 = 0;
  h4.bus.on('weapon:fire', (e) => {
    if (e.heli) fires4++;
  });
  h4.run(40);
  ok(fires4 === 0 && c4.hits.length === 0, '4★：直升機不開槍');
  const c5 = fakeCombat();
  const h5 = makeHeli({ stars: 5, combat: c5 });
  const fires = [];
  h5.bus.on('weapon:fire', (e) => {
    if (e.heli) fires.push({ ...e });
  });
  h5.run(40);
  ok(fires.length >= 8, `5★：艙門射手開槍（${fires.length} 發）`);
  ok(fires.every((f) => f.police === true && f.byPlayer === false), '射手 weapon:fire police true / byPlayer false（不算玩家犯行）');
  ok(c5.hits.length > 0 && c5.hits.every((hh) => hh.weapon === 'pistol' && hh.throughVehicle === false), `命中走 combat.applyHit pistol（步行 throughVehicle false，${c5.hits.length} 中）`);
  // 車內：throughVehicle + damageVehicle
  const c6 = fakeCombat();
  let carDmg = 0;
  const bus6 = createBus();
  const heli6 = createHelicopter({ bus: bus6, wanted: fakeWanted(5), combat: c6, getPlayerActor: () => c6.player, damageVehicle: (n) => (carDmg += n), rng: mulberry(9) });
  const ctx6 = { player: { x: 0, z: 0, inVehicle: true, speed: 0 } };
  for (let i = 0; i < 60 * 40; i++) heli6.update(FRAME, ctx6);
  ok(c6.hits.length > 0 && c6.hits.every((hh) => hh.throughVehicle === true) && carDmg > 0, '玩家在車內：throughVehicle 並扣車耐久');
  // 命中率隨速度：同 seed 靜止 vs 高速（光點照著才開槍 → 用直接比率比較）
  ok(heliHitChance(50, 30) < heliHitChance(50, 0) * 0.5, '高速時射手命中率顯著下降');
}

// ── 7. 打下直升機：射線命中、墜落、爆炸、冷卻 ──
{
  const h = makeHeli({ stars: 4 });
  h.run(30);
  const shoot = (aimAtHeli) => {
    const p = h.heli.pos;
    const ox = 0;
    const oy = 1.4;
    const oz = 0;
    let dx = p.x - ox;
    let dy = p.y - oy;
    let dz = p.z - oz;
    if (!aimAtHeli) dx += 30;
    const l = Math.hypot(dx, dy, dz);
    h.bus.emit('weapon:fire', { weapon: 'pistol', x: ox, y: oy, z: oz, dirX: dx / l, dirY: dy / l, dirZ: dz / l, byPlayer: true, dist: 80 });
  };
  const hp0 = h.heli.hp;
  shoot(false);
  ok(h.heli.hp === hp0, '沒瞄準直升機：不扣耐久');
  h.bus.emit('weapon:fire', { weapon: 'pistol', x: 0, y: 1.4, z: 0, dirX: 0, dirY: 1, dirZ: 0, byPlayer: false, police: true, dist: 80 });
  shoot(true);
  ok(h.heli.hp === hp0 - HIT_DAMAGE.pistol, `手槍命中機身：扣 ${HIT_DAMAGE.pistol}`);
  // 射程外（e.dist 小於直升機距離 = 子彈先打到別的東西）
  {
    const p = h.heli.pos;
    const l = Math.hypot(p.x, p.y - 1.4, p.z);
    h.bus.emit('weapon:fire', { weapon: 'pistol', x: 0, y: 1.4, z: 0, dirX: p.x / l, dirY: (p.y - 1.4) / l, dirZ: p.z / l, byPlayer: true, dist: 10 });
    ok(h.heli.hp === hp0 - HIT_DAMAGE.pistol, '子彈在直升機前先命中他物（e.dist 較短）：不扣');
  }
  let n = 1;
  while (h.heli.state !== 'down' && n < 100) {
    shoot(true);
    h.heli.update(FRAME, h.ctx);
    n++;
  }
  ok(h.heli.state === 'down' && n === Math.ceil(HELI_HP / HIT_DAMAGE.pistol), `約 ${Math.ceil(HELI_HP / HIT_DAMAGE.pistol)} 發手槍打下（實際 ${n} 發）`);
  const down = h.events.find((e) => e.type === 'down');
  ok(down && down.byPlayer === true, 'emit police:heli down（byPlayer）');
  h.run(10);
  ok(h.explodes.length === 1 && h.explodes[0].byPlayer === true && h.explodes[0].y >= 0, `墜落觸地爆炸一次（explode y ${h.explodes[0] && h.explodes[0].y.toFixed(1)}）`);
  ok(h.heli.state === 'off' && h.events.some((e) => e.type === 'crash'), '墜毀後收起（emit crash）');
  h.run(HELI_RESPAWN - 15);
  ok(h.heli.state === 'off', `冷卻 ${HELI_RESPAWN} s 內不再出動`);
  h.run(10);
  ok(h.heli.state !== 'off', '冷卻結束且仍 ≥4★ → 再出動');
  // 墜落到屋頂：爆炸在樓頂
  const hr = makeHeli({ stars: 4, buildings: [{ x0: -500, z0: -500, x1: 500, z1: 500, h: 30 }] });
  hr.run(30);
  hr.heli.damage(HELI_HP);
  hr.run(10);
  ok(hr.explodes.length === 1 && hr.explodes[0].y >= 30, `墜落在屋頂上爆炸（y ${hr.explodes[0] && hr.explodes[0].y.toFixed(1)}）`);
}

// ── 8. 清除條件：被捕 / 送醫 / 噴漆 / 擺脫 → 直升機飛離 ──
{
  for (const reason of ['busted', 'wasted', 'spray', 'evaded']) {
    const bus = createBus();
    const wanted = createWanted({ bus });
    wanted.setStars(5);
    const h = makeHeli({ wanted, bus });
    h.run(30);
    const was = h.heli.state;
    wanted.clear(reason);
    h.run(0.1);
    const leaving = h.heli.state === 'leave';
    // 被捕 / 送醫：玩家傳送到遠處
    if (reason === 'busted' || reason === 'wasted') {
      h.ctx.player.x = 900;
      h.ctx.player.z = 500;
    }
    h.run(30);
    ok(was === 'orbit' && leaving && h.heli.state === 'off', `wanted.clear('${reason}')：直升機飛離並收起`);
  }
}

// ── 9. cancel / 暫停凍結 / dispose ──
{
  const h = makeHeli({ stars: 5 });
  h.run(30);
  const p0 = { ...h.heli.pos };
  h.ctx.paused = true;
  h.run(5);
  ok(h.heli.pos.x === p0.x && h.heli.pos.y === p0.y && h.heli.pos.z === p0.z, 'paused（噴漆中）：直升機凍結不動');
  h.ctx.paused = false;
  h.heli.cancel();
  ok(h.heli.state === 'off' && !h.heli.active && h.events.some((e) => e.type === 'cancel'), 'cancel：立即收起（不飛離、不爆炸）');
  ok(h.explodes.length === 0, 'cancel 不爆炸');
  h.heli.dispose();
  let threw = false;
  try {
    h.heli.update(FRAME, h.ctx);
    h.bus.emit('weapon:fire', { weapon: 'pistol', x: 0, y: 0, z: 0, dirX: 0, dirY: 1, dirZ: 0, byPlayer: true });
  } catch {
    threw = true;
  }
  ok(!threw && h.heli.state === 'off', 'dispose 後 update / 事件皆為空操作');
}

// ── 10. 幀率無關 ──
{
  const traj = (dt) => {
    const h = makeHeli({ stars: 4, seed: 11 });
    h.run(40, dt);
    return { x: h.heli.pos.x, y: h.heli.pos.y, z: h.heli.pos.z, sx: h.heli.spot.x, sz: h.heli.spot.z, state: h.heli.state };
  };
  const a = traj(1 / 30);
  const b = traj(1 / 60);
  const c = traj(1 / 144);
  const dAB = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const dBC = Math.hypot(b.x - c.x, b.y - c.y, b.z - c.z);
  ok(a.state === 'orbit' && a.state === b.state && b.state === c.state && dAB < 2 && dBC < 2, `直升機 30 / 60 / 144 Hz 40 s 後位置一致（差 ${dAB.toFixed(2)} / ${dBC.toFixed(2)} m）`);
  ok(Math.hypot(a.sx - c.sx, a.sz - c.sz) < 1.5, '探照燈光點 30 / 144 Hz 一致');
  const rb = (dt) => {
    const s = makePoliceWorld({ stars: 5, seed: 4 });
    const t = [];
    let time = 0;
    s.bus.on('police:roadblock', (e) => {
      if (e.type === 'spawn') t.push(time);
    });
    s.run(40, dt, (d) => {
      time += d;
      s.player.z += 18 * d;
    });
    return t;
  };
  const r60 = rb(1 / 60);
  const r144 = rb(1 / 144);
  ok(r60.length === r144.length && r60.length > 0 && r60.every((t, i) => Math.abs(t - r144[i]) < 0.05), `路障生成時刻 60 / 144 Hz 一致（${r60.map((t) => t.toFixed(2)).join(', ')}）`);
}

// ── 11. 每幀成本（純邏輯，node 量測）──
{
  const h = makeHeli({ stars: 5, buildings: [{ x0: 15, z0: -30, x1: 60, z1: 30, h: 150 }] });
  h.run(20);
  const s = makePoliceWorld({ stars: 5 });
  s.run(20, FRAME, (dt) => {
    s.player.z += 18 * dt;
  });
  const N = 6000;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    h.ctx.player.z += 18 * FRAME;
    h.heli.update(FRAME, h.ctx);
  }
  const t1 = process.hrtime.bigint();
  const heliMs = Number(t1 - t0) / 1e6 / N;
  ok(heliMs < 0.5, `直升機每幀 ${(heliMs * 1000).toFixed(1)} µs < 0.5 ms`);
  // police.update 5★（含路障 / 特警 / 車上開槍）總成本也在預算內
  const t2 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    s.player.z += 18 * FRAME;
    s.police.update(FRAME, { player: s.player });
  }
  const t3 = process.hrtime.bigint();
  const polMs = Number(t3 - t2) / 1e6 / N;
  ok(heliMs + polMs < 0.5, `5★ police.update + 直升機每幀 ${((heliMs + polMs) * 1000).toFixed(1)} µs < 0.5 ms`);
  // 直升機 update 不配置物件：同一 pos / spot 物件、事件 payload 重用
  const pos = h.heli.pos;
  const spot = h.heli.spot;
  h.run(1);
  ok(h.heli.pos === pos && h.heli.spot === spot, '直升機 pos / spot 物件重用');
}

// ── 12. adapters：車內中彈、車上開槍、特警、路障 ──
function makeAdapterEnv({ junctions = null } = {}) {
  const bus = createBus();
  const vm = {
    vehicles: [],
    adopt({ type, color, x, z, yaw = 0 }) {
      const v = { type, color, pos: { x, y: 0, z }, yaw, speed: 0, driven: false, ai: false, body: { kinematic: false }, controls: {}, mesh: null, setControls(c) { this.controls = { ...c }; } };
      vm.vehicles.push(v);
      return v;
    },
    remove(v) {
      const i = vm.vehicles.indexOf(v);
      if (i < 0) return false;
      vm.vehicles.splice(i, 1);
      return true;
    },
  };
  const health = new Map();
  const dmg = {
    attach(v, { maxHealth = 1000 } = {}) {
      health.set(v, maxHealth);
    },
    detach(v) {
      health.delete(v);
    },
    healthOf: (v) => (health.has(v) ? health.get(v) : null),
  };
  const combat = { hits: [], applyHit(o) { combat.hits.push(o); return { damage: o.damage }; }, newSwingId: () => 1, register() {}, unregister() {}, on: () => () => {}, isDown: () => false };
  const playerActor = { id: 'player', kind: 'player' };
  const pl = { x: 0, z: 0, actor: playerActor, inVehicle: false, speed: 0, vehicle: null };
  const carDamage = [];
  const cones = [];
  const characters = {
    createCharacter: ({ colors }) => ({ root: { position: { set() {} }, rotation: { set() {} } }, colors }),
    disposeCharacter() {},
    CharacterAnimator: class {
      update() {}
      on() {}
    },
    clips: [],
  };
  // 路網：十字路口（度數 4）在 (0, 200)，另一個在 (0, -200)（玩家後方）、(150, 150)（偏 45°）
  const graph = junctions || {
    nodeCount: 7,
    x: [0, 0, 0, 0, 150, -10, 10],
    z: [200, -200, 190, 210, 150, 200, 200],
    offsets: [0, 4, 8, 9, 10, 14, 15, 16],
  };
  const adapters = createPoliceAdapters({
    vehicles: vm, dmg, combat, bus, characters, graph, rng: mulberry(5),
    getPlayer: () => pl,
    damageVehicle: (v, n) => carDamage.push({ v, n }),
    createCone: () => {
      const o = { visible: true, position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } }, removeFromParent() {} };
      cones.push(o);
      return o;
    },
  });
  return { bus, vm, dmg, combat, pl, carDamage, cones, adapters, health };
}

{
  const e = makeAdapterEnv();
  // 車內中彈
  e.pl.inVehicle = true;
  e.pl.vehicle = { id: 'myCar' };
  const car = e.adapters.spawnCar({ x: 10, z: 0 });
  for (let i = 0; i < 40; i++) e.adapters.carFire(car, { x: 0, z: 0 });
  ok(e.combat.hits.length > 0 && e.combat.hits.every((hh) => hh.throughVehicle === true && hh.weapon === 'pistol'), `carFire：玩家在車內命中走 throughVehicle（${e.combat.hits.length}/40 中）`);
  ok(e.carDamage.length === e.combat.hits.length && e.carDamage.every((d) => d.v === e.pl.vehicle && d.n === CAR_HIT_VEHICLE_DAMAGE), `車內中彈扣玩家車耐久 ${CAR_HIT_VEHICLE_DAMAGE}`);
  // 速度降低命中：同 rng 序列比較大量樣本
  const rate = (speed) => {
    const env = makeAdapterEnv();
    env.pl.speed = speed;
    const c = env.adapters.spawnCar({ x: 15, z: 0 });
    for (let i = 0; i < 400; i++) env.adapters.carFire(c, { x: 0, z: 0 });
    return env.combat.hits.length / 400;
  };
  const r0 = rate(0);
  const r30 = rate(30);
  ok(r30 < r0 * 0.6, `玩家高速時車上開槍命中率下降（${(r0 * 100).toFixed(0)}% → ${(r30 * 100).toFixed(0)}%）`);
  // 特警
  const van = e.adapters.spawnSwat({ x: 30, z: 0, heading: 0 });
  ok(van && van.swat && van.v.type === SWAT_TYPE && van.v.color === SWAT_COLOR && e.health.get(van.v) === SWAT_VAN_HEALTH, `特警車：${SWAT_TYPE} 深色 ${SWAT_COLOR}、耐久 ${SWAT_VAN_HEALTH}（×${SWAT_TOUGHNESS}）`);
  ok(e.adapters.isPoliceVehicle(van.v), '特警車 isPoliceVehicle');
  const so = e.adapters.spawnOfficer({ x: 32, z: 0, car: van, swat: true });
  const ro = e.adapters.spawnOfficer({ x: 32, z: 2, car: van });
  ok(so && so.swat && so.actor.hp === OFFICER_HP * SWAT_TOUGHNESS && ro.actor.hp === OFFICER_HP, `特警 hp ${OFFICER_HP * SWAT_TOUGHNESS}（×${SWAT_TOUGHNESS}），一般警員不變`);
  ok(so.character.colors.shirt !== ro.character.colors.shirt, '特警制服顏色不同（深色重裝）');
}

{
  // 路口
  const j = graphJunctions({ nodeCount: 4, x: [0, 1, 2, 3], z: [0, 0, 0, 0], offsets: [0, 3, 4, 6, 9] });
  ok(j.n === 2 && j.x[0] === 0 && j.x[1] === 3, 'graphJunctions：度數 ≥ 3 的節點');
  const e = makeAdapterEnv();
  const pt = e.adapters.findRoadblockPoint(0, 0, 0, 1, ROADBLOCK_MIN, ROADBLOCK_MAX);
  ok(pt && Math.abs(pt.x) < 1e-6 && pt.z > 185 && pt.z < 200, `findRoadblockPoint：取正前方 200 m 的路口、退回玩家側（${pt && pt.z.toFixed(1)}）`);
  ok(e.adapters.findRoadblockPoint(0, 0, 0, -1, ROADBLOCK_MIN, ROADBLOCK_MAX) !== null, '反方向：取後方那個路口（前進方向判定）');
  ok(e.adapters.findRoadblockPoint(0, 0, 1, 0, ROADBLOCK_MIN, ROADBLOCK_MAX) === null, '前方 ±25° 內無路口 → null');
  const rb = e.adapters.spawnRoadblock(pt);
  ok(rb && rb.cars.length === 2 && rb.cars.every((c) => c.v.type === 'police' && e.adapters.isPoliceVehicle(c.v)), '路障：2 台警車（isPoliceVehicle）');
  const [a, b] = rb.cars;
  const sep = Math.hypot(a.v.pos.x - b.v.pos.x, a.v.pos.z - b.v.pos.z);
  ok(Math.abs(Math.abs(Math.sin(a.v.yaw - pt.heading)) - 1) < 1e-9 && Math.abs(a.v.pos.z - b.v.pos.z) < 1e-6 && sep > 4, `橫停：車身垂直來向、並排擋住車道（間距 ${sep.toFixed(1)} m）`);
  ok(rb.cones.length === ROADBLOCK_CONES.length && rb.alive, `路錐 ${ROADBLOCK_CONES.length} 個、alive`);
  ok(a.v.controls.handbrake === true && a.v.ai === false, '路障車拉手煞（一般停放車，可撞開 / 搶走）');
  e.adapters.update(FRAME, { stars: 5 });
  const rb2 = e.adapters.spawnRoadblock({ x: 500, z: 500, heading: 0 });
  const rb3 = e.adapters.spawnRoadblock({ x: 900, z: 900, heading: 0 });
  ok(rb2 && rb3 === null, '路障上限 2 組（adapters 端也擋）');
  e.adapters.despawnRoadblock(rb);
  ok(e.vm.vehicles.length === 2 && rb.cones.length === 0 && !rb.alive, '回收路障：移除警車、路錐回池');
  const rb4 = e.adapters.spawnRoadblock({ x: -500, z: 500, heading: 1 });
  ok(rb4 && e.cones.length <= MAX_CONES && e.cones.length === ROADBLOCK_CONES.length * 2, `路錐池化重用（共建立 ${e.cones.length} ≤ ${MAX_CONES}）`);
  // 搶走路障車
  rb4.cars[0].v.driven = true;
  e.adapters.update(FRAME, { stars: 5 });
  e.adapters.despawnRoadblock(rb4);
  ok(e.vm.vehicles.includes(rb4.cars[0].v) && !e.vm.vehicles.includes(rb4.cars[1].v), '被玩家開走的路障車留給玩家，其餘回收');
  const st = e.adapters.stats();
  ok(st.roadblocks === 1 && st.cones === ROADBLOCK_CONES.length, `stats：roadblocks ${st.roadblocks}、cones ${st.cones}`);
  e.adapters.dispose();
  ok(e.adapters.stats().roadblocks === 0, 'dispose 回收全部路障');
}

// ── 13. UI：星數 class、警示光暈 ──
{
  class CL {
    constructor() {
      this.set = new Set();
    }
    add(c) {
      this.set.add(c);
    }
    remove(c) {
      this.set.delete(c);
    }
    contains(c) {
      return this.set.has(c);
    }
    toggle(c, on) {
      const v = on === undefined ? !this.set.has(c) : !!on;
      if (v) this.set.add(c);
      else this.set.delete(c);
      return v;
    }
  }
  class El {
    constructor(tag) {
      this.tagName = tag;
      this.classList = new CL();
      this.children = [];
      this.parentNode = null;
      this.attrs = {};
      this.hidden = false;
      this.style = {};
      this.textContent = '';
    }
    set className(v) {
      for (const c of String(v).split(/\s+/)) if (c) this.classList.add(c);
    }
    setAttribute(k, v) {
      this.attrs[k] = v;
    }
    appendChild(c) {
      c.parentNode = this;
      this.children.push(c);
      return c;
    }
    removeChild(c) {
      this.children = this.children.filter((x) => x !== c);
      c.parentNode = null;
    }
    addEventListener() {}
  }
  const mk = (reduced = false, alert = true) => {
    const doc = { body: new El('body'), createElement: (t) => new El(t), addEventListener() {}, removeEventListener() {} };
    const root = new El('div');
    const ui = createWantedUI({ root, doc, alert, reducedMotion: () => reduced });
    return { ui, doc, root };
  };
  const { ui, doc } = mk();
  ui.setStars(3);
  const row = ui.els.row;
  ok(row.classList.contains('wanted-lv-3') && !ui.alertActive && doc.body.children.length === 0, '3★：星星列 wanted-lv-3、無警示光暈（尚未建立）');
  ui.setStars(ALERT_STARS);
  ok(row.classList.contains(`wanted-lv-${ALERT_STARS}`) && !row.classList.contains('wanted-lv-3') && ui.alertActive, `${ALERT_STARS}★：換 class、顯示紅藍警示光暈`);
  ui.setStars(5);
  ok(ui.els.alert.classList.contains('wanted-alert-max') && doc.body.children.filter((c) => c.classList.contains('wanted-alert')).length === 1, '5★：光暈加快（wanted-alert-max），元素只建一個');
  ui.setAlertEnabled(false);
  ok(!ui.alertActive, 'setAlertEnabled(false)：關閉光暈');
  ui.setAlertEnabled(true);
  ui.setStars(0);
  ok(!ui.alertActive && !row.classList.contains('wanted-lv-5'), '0★：光暈隱藏、class 移除');
  ui.setStars(5);
  ui.dispose();
  ok(doc.body.children.length === 0, 'dispose 移除光暈');
  const r = mk(true);
  r.ui.setStars(5);
  ok(!r.ui.alertActive && r.ui.els.row.classList.contains('wanted-calm'), '減少動態效果：不顯示光暈、星星不脈動（wanted-calm）');
  const css = readFileSync(new URL('../../src/wanted/wanted.css', import.meta.url), 'utf8');
  ok(['.wanted-alert', 'wanted-alert-cycle', '.wanted-stars.wanted-lv-5', '.wanted-stars.wanted-calm'].every((k) => css.includes(k)), 'wanted.css：光暈動畫、星數脈動、calm');
}

// ── 14. 靜態接線（main.js / interfaces.md / 限制）──
{
  const main = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');
  const doc = readFileSync(new URL('../../docs/dev/interfaces.md', import.meta.url), 'utf8');
  const heliSrc = readFileSync(new URL('../../src/wanted/helicopter.js', import.meta.url), 'utf8');
  ok(main.includes("import { createHelicopter, createHeliObstacleTop } from './wanted/helicopter.js';"), 'main.js import createHelicopter / createHeliObstacleTop');
  const uw = main.slice(main.indexOf('const updateWanted'), main.indexOf('// 小地圖警車點'));
  ok(uw.indexOf('police.update(dt, policeCtx)') < uw.indexOf('policeV5.update(dt, pl)') && uw.indexOf('policeV5.update(dt, pl)') < uw.indexOf('wanted.update(dt, wantedCtx)'), 'updateWanted：police.update → 直升機 → wanted.update（seen 合併）');
  ok(uw.includes('if (skip) {'), 'updateWanted skip（手機 / 暫停）時不更新直升機 = 凍結');
  ok(main.includes('heliCtx.paused = !!state.spraying || !!state.respawn;'), '噴漆中 / BUSTED / WASTED 直升機凍結');
  for (const fn of ['const startGame', 'const quitToMenu']) {
    const i = main.indexOf(fn);
    const body = main.slice(i, i + 2000);
    ok(body.indexOf('policeV5.cancel();') > body.indexOf('cancelRespawn();') && body.indexOf('cancelRespawn();') > 0, `${fn.slice(6)}：cancelRespawn 之後 policeV5.cancel()`);
  }
  ok(main.includes('heli.setQuality();') && main.includes('quality: () => tier,'), '畫質切換同步直升機（low 關探照燈陰影）');
  ok(main.includes('obstacleTop: heliObstacleTop') && main.includes('createHeliObstacleTop({ heightAt, solids: buildings.colliders })'), '直升機避障高度場接 buildings.colliders + heightAt（+ LANDMARK_SOLIDS）');
  ok(main.includes('explosions.explode(x, y, z, { radius, power, source: byPlayer ? player.actor : null })'), '墜毀爆炸接 explosions');
  ok(main.includes("damageVehicle: (v, n) => dmg.addDamage(v, n),") && main.includes('    graph,\n') && main.includes('createCone: () => createRoadCone(),'), 'policeAdapters deps：damageVehicle / graph / createCone');
  ok(main.includes('inVehicle: !!v, speed: v ? Math.abs(v.speed || 0) : 0, vehicle: v'), 'getPlayer 帶 inVehicle / speed / vehicle（車內中彈、速度命中率）');
  ok(/## 33\. V5 警方升級/.test(doc) && ['police:heli', 'police:roadblock', 'police:swat', 'helicopter.js'].every((k) => doc.includes(k)), 'interfaces.md §33：helicopter.js 與事件 police:heli / roadblock / swat');
  ok(!/from ['"]three['"]/.test(heliSrc) && !/rapier/.test(heliSrc), 'helicopter.js 不 import three / rapier（純邏輯可測）');
  ok(!/\.glb/.test(heliSrc), '直升機不新增 glb（程式產生幾何）');
}

// ── 15. V5 審查修正回歸（var/retro/v5-findings-logic.md / v5-findings-wire.md）──
// 光點掃描、遮蔽、細塔避障、地標量體高度場、玩家倒地停火、特警雙向回收、路障不 churn、孤兒特警回收、reduced motion
// 線段（a → b）是否被高度場擋住：0.25 m 取樣、兩端各留 2 m，穿入障礙的總長 ≥ HELI.OCC_STEP 才算（擦過屋角不到一個取樣間距的容許）
const lineBlocked = (top, ax, ay, az, bx, by, bz) => {
  const len = Math.hypot(bx - ax, by - ay, bz - az);
  const n = Math.max(2, Math.ceil(len / 0.25));
  let inside = 0;
  for (let k = 1; k < n; k++) {
    const t = k / n;
    if (t * len < 2 || (1 - t) * len < 2) continue;
    if (ay + (by - ay) * t < top(ax + (bx - ax) * t, az + (bz - az) * t)) inside += len / n;
  }
  return inside >= HELI.OCC_STEP;
};
{
  // 🔴 搜索中探照燈要真的掃到搜索圈設計半徑（r × SWEEP_FRAC），且光點跟得上掃描點
  const w = fakeWanted(4);
  const h = makeHeli({ wanted: w, seed: 3 });
  h.run(20);
  w.state = 'searching';
  w.searchCircle = { x: 0, z: 0, r: 240 };
  const design = 240 * HELI.SWEEP_FRAC;
  let maxR = 0;
  h.run(150, FRAME, () => {
    maxR = Math.max(maxR, Math.hypot(h.heli.spot.x, h.heli.spot.z));
  });
  ok(maxR >= design * 0.9 && maxR <= 240, `searching：光點離圓心最遠 ${maxR.toFixed(0)} m ≥ 0.9 × 設計掃描半徑 ${design.toFixed(0)} m（且不出圈）`);
  // 覆蓋率：設計掃描圓（半徑 r × SWEEP_FRAC）內 6 m 格點，150 s 內被光圈掃過的比例（修前光點只在圓心 ~48 m 內，上限約 15%）
  const w2 = fakeWanted(4);
  const h2 = makeHeli({ wanted: w2, seed: 5 });
  h2.run(20);
  w2.state = 'searching';
  w2.searchCircle = { x: 0, z: 0, r: 240 };
  h2.ctx.player.x = 5000;
  const cells = [];
  for (let gx = -design; gx <= design; gx += 6) for (let gz = -design; gz <= design; gz += 6) if (Math.hypot(gx, gz) <= design) cells.push([gx, gz, false]);
  h2.run(150, FRAME, () => {
    const sp = h2.heli.spot;
    for (const c of cells) if (!c[2] && Math.hypot(c[0] - sp.x, c[1] - sp.z) <= SPOT_RADIUS) c[2] = true;
  });
  const cover = cells.filter((c) => c[2]).length / cells.length;
  ok(cover >= 0.2, `searching：150 s 內光圈掃過設計掃描圓 ${(cover * 100).toFixed(0)}%（≥ 20%）`);
  // 掃描路徑會回到圓心（最後目擊點）：站在圓心的玩家在掃描開始後仍會再被照到
  const w3 = fakeWanted(4);
  const h3 = makeHeli({ wanted: w3, seed: 6 });
  h3.run(20);
  w3.state = 'searching';
  w3.searchCircle = { x: 0, z: 0, r: 240 };
  h3.run(10);
  ok(h3.run(40), 'searching：掃描路徑 40 s 內回到圓心（站在最後目擊點的玩家會再被照到）');
}
{
  // 🟡1 遮蔽：5★ 射手不隔樓命中、探照燈不隔樓算看見（玩家東側 8–22 m 一棟 45 m 樓）
  const B = { x0: 8, z0: -40, x1: 22, z1: 40, h: 45 };
  let shots = 0;
  let through = 0;
  let seenThrough = 0;
  let seenFrames = 0;
  for (const seed of [7, 8, 9]) {
    const c = fakeCombat();
    const h = makeHeli({ stars: 5, buildings: [B], combat: c, seed });
    h.bus.on('weapon:fire', (e) => {
      if (!e.heli) return;
      shots++;
      if (e.hit && lineBlocked(h.top, e.x, e.y, e.z, e.ex, e.ey, e.ez)) through++;
    });
    for (let i = 0; i < 60 * 180; i++) {
      const s = h.heli.update(FRAME, h.ctx);
      if (!s) continue;
      seenFrames++;
      const p = h.heli.pos;
      if (lineBlocked(h.top, p.x, p.y, p.z, 0, 1.2, 0)) seenThrough++;
    }
  }
  ok(shots > 0 && seenFrames > 0, `遮蔽情境仍有開槍 / 看見（${shots} 發、${seenFrames} 幀）`);
  ok(through === 0, `射手不隔著建築命中（隔樓命中 ${through}）`);
  ok(seenThrough === 0, `探照燈不隔著建築算看見（隔樓 seen ${seenThrough} 幀）`);
}
{
  // 🟡2 避障：2×2 m、200 m 高細塔放在航線兩側 0–5.5 m（落在舊四點取樣之間）→ 旋翼（半徑 5.5 m）不穿模
  const ROTOR = 5.5;
  const path = (buildings) => {
    const h = makeHeli({ stars: 4, buildings, seed: 21 });
    const out = [];
    h.run(30, FRAME, () => out.push({ x: h.heli.pos.x, y: h.heli.pos.y, z: h.heli.pos.z, vx: h.heli.stats ? 0 : 0 }));
    return out;
  };
  const p0 = path([]);
  // 進場航線中段（直線段）取一點，沿航線法向放塔
  const a = p0[600];
  const b = p0[630];
  const dl = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const nx = -(b.z - a.z) / dl;
  const nz = (b.x - a.x) / dl;
  let worst = Infinity;
  for (const off of [0, 1.5, 2.5, 3.5, 4.5, 5.5, -2.5, -4.5]) {
    const cx = a.x + nx * off;
    const cz = a.z + nz * off;
    const T = { x0: cx - 1, z0: cz - 1, x1: cx + 1, z1: cz + 1, h: 200 };
    for (const p of path([T])) {
      if (p.y >= T.h) continue;
      const d = Math.hypot(Math.max(T.x0 - p.x, 0, p.x - T.x1), Math.max(T.z0 - p.z, 0, p.z - T.z1));
      worst = Math.min(worst, d);
    }
  }
  ok(worst >= ROTOR, `細塔（2×2 m、200 m）在航線兩側 0–5.5 m：機身中心離塔 ≥ 旋翼半徑 ${ROTOR} m（最小 ${worst.toFixed(2)} m）`);
  const heliSrc = readFileSync(new URL('../../src/wanted/helicopter.js', import.meta.url), 'utf8');
  const header = heliSrc.slice(0, heliSrc.indexOf('import '));
  ok(!/保證不穿模/.test(header) || /寬度 ≥ \d+(\.\d+)? m[^\n]*保證不穿模|保證不穿模[^\n]*寬度 ≥ \d/.test(header), 'helicopter.js header：「不穿模」限定障礙寬度（與測試一致）');
  // 地標實際量體：LANDMARK_SOLIDS（捷運市政府站 OSM 9.1 m，模型 25 m、外延 26 m 內 17 m）
  const make = HELI.createHeliObstacleTop;
  ok(typeof make === 'function', 'helicopter.js 匯出 createHeliObstacleTop（建築 + 地標量體高度場）');
  if (typeof make === 'function') {
    const poly = [0, 0, 20, 0, 20, 20, 0, 20];
    const top = make({
      heightAt: () => 2,
      solids: [
        { id: 862750722, poly, base: 3, h: 9.1 },
        { id: 1, poly: [100, 0, 110, 0, 110, 10, 100, 10], base: 2, h: 30 },
      ],
    });
    ok(Math.abs(top(10, 10) - 28) < 1e-6, `地標輪廓內 = base + 量體頂（${top(10, 10)} = 3 + 25）`);
    ok(Math.abs(top(-20, 10) - 20) < 1e-6, `地標輪廓外 20 m（外延 26 m 層）= base + 17（${top(-20, 10)}）`);
    ok(Math.abs(top(-30, 10) - 2) < 1e-6, `地標外延範圍外 = 地面（${top(-30, 10)}）`);
    ok(Math.abs(top(105, 5) - 32) < 1e-6 && Math.abs(top(112, 5) - 2) < 1e-6, '一般建築：輪廓內 base + h、輪廓外地面');
  }
  const main = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');
  ok(main.includes('createHeliObstacleTop({') && main.includes('solids: buildings.colliders'), 'main.js：直升機高度場用 buildings.colliders（地標替換高）+ LANDMARK_SOLIDS');
}
{
  // 🟡3 玩家 down（BUSTED / WASTED / KO）：直升機射手、車上警察、下車警員全部停火
  const c = fakeCombat();
  let carDmg = 0;
  const heli = createHelicopter({ wanted: fakeWanted(5), combat: c, getPlayerActor: () => c.player, damageVehicle: (n) => (carDmg += n), rng: mulberry(3) });
  const ctx = { player: { x: 0, z: 0, inVehicle: true, speed: 0, down: true } };
  for (let i = 0; i < 60 * 60; i++) heli.update(FRAME, ctx);
  ok(c.hits.length === 0 && carDmg === 0, `玩家 down（車內）：直升機射手不命中（${c.hits.length} 中、車損 ${carDmg}）`);
  const s = makePoliceWorld({ stars: 4 });
  s.player.down = true;
  s.run(20);
  ok(s.w.carFires.length === 0 && s.ev.carshoot === 0, `玩家 down（車內）：車上警察不開槍（${s.w.carFires.length}）`);
  const s2 = makePoliceWorld({ stars: 4, spawnDist: 30 });
  s2.player.inVehicle = false;
  s2.player.down = true;
  s2.run(20, FRAME, () => {
    for (const o of s2.w.officers) {
      // 警員停在射程內（FIRE_MIN–FIRE_MAX）
      const d = Math.hypot(o.pos.x, o.pos.z) || 1;
      o.pos.x = (o.pos.x / d) * 15;
      o.pos.z = (o.pos.z / d) * 15;
    }
  });
  ok(s2.w.officers.size > 0 && s2.ev.shoot === 0, `玩家 down（步行）：下車警員不開槍（警員 ${s2.w.officers.size}、開槍 ${s2.ev.shoot}）`);
  const main = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');
  ok(main.includes('heliCtx.paused = !!state.spraying || !!state.respawn;'), 'main.js：BUSTED / WASTED（state.respawn）期間直升機凍結');
}
{
  // 🟡4 特警雙向回收：clear 後（特警車仍在視線內）重回 5★ → 取消回收、恢復追捕
  const s = makePoliceWorld({ stars: 5, spawnDist: 60 });
  s.run(0.2);
  const sw = s.police.swat;
  ok(!!sw, '5★ 派出特警車');
  s.wanted.stars = 0;
  s.wanted.state = 'clear';
  s.run(0.2);
  const recalled = s.w.drives.get(sw).mode;
  s.wanted.stars = 5;
  s.wanted.state = 'active';
  s.run(5);
  const now = s.police.swat;
  ok(recalled === 'patrol' && !!now && s.w.drives.get(now).mode !== 'patrol', `clear → 5★：特警車取消回收恢復追捕（${recalled} → ${now ? s.w.drives.get(now).mode : 'none'}）`);
}
{
  // 🟡5 路障：searching 期間不立即回收（只在 active 生成）；回 active 不重生（無 churn）
  const s = makePoliceWorld({ stars: 5 });
  s.player.dirX = 0;
  s.player.dirZ = 1;
  s.run(1);
  const n0 = s.police.roadblocks.length;
  const spawned0 = s.w.roadblockSpawns.length;
  s.wanted.state = 'searching';
  s.wanted.searchCircle = { x: 0, z: 0, r: 280 };
  s.run(5);
  ok(n0 === 1 && s.police.roadblocks.length === 1 && s.w.roadblockDespawns.length === 0, `searching 5 s：路障保留（${s.police.roadblocks.length} 組、回收 ${s.w.roadblockDespawns.length}）`);
  ok(s.w.roadblockSpawns.length === spawned0, 'searching：不生成新路障');
  s.wanted.state = 'active';
  s.wanted.searchCircle = null;
  s.run(1);
  ok(s.w.roadblockSpawns.length === spawned0 && s.w.roadblockDespawns.length === 0, `回 active：不重生（生成 ${s.w.roadblockSpawns.length}、回收 ${s.w.roadblockDespawns.length}）`);
  s.wanted.stars = 0;
  s.wanted.state = 'clear';
  s.w.see = false;
  s.run(0.2);
  ok(s.police.roadblocks.length === 0, '解除通緝：路障離開視線即回收');
}
{
  // 🟡6 cancelExtras：特警車先被毀 → 孤兒特警也立即回收
  const s = makePoliceWorld({ stars: 5, spawnDist: 10 });
  s.player.inVehicle = false;
  s.run(0.5);
  const swatOff = [...s.w.officers].filter((o) => o.swat).length;
  s.police.swat.alive = false;
  s.run(FRAME);
  s.police.cancelExtras();
  const left = s.police.officers.filter((o) => o.swat).length;
  ok(swatOff > 0 && left === 0 && [...s.w.officers].every((o) => !o.swat), `cancelExtras：孤兒特警立即回收（${swatOff} → ${left}）`);
  ok(![...s.w.cars].some((c) => c.swat), 'cancelExtras：特警車殘骸一併回收');
}
{
  // 🟡7 wanted.css：reduced motion 只關脈動，不關搜索中閃爍
  const css = readFileSync(new URL('../../src/wanted/wanted.css', import.meta.url), 'utf8');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
  const calm = rules.filter((r) => r.sel.includes('wanted-calm') && /animation:\s*none/.test(r.body));
  ok(calm.length > 0 && calm.every((r) => r.sel.includes(':not(.wanted-flashing)')), 'wanted.css：calm 的 animation: none 排除 wanted-flashing');
  const lastFlash = rules.map((r, i) => ({ ...r, i })).filter((r) => r.sel === '.wanted-stars.wanted-flashing .wanted-star.wanted-on' && /wanted-blink/.test(r.body));
  ok(lastFlash.length === 1, 'wanted.css：搜索中閃爍規則只宣告一次（無死碼）');
}

// 1019 熱修回歸：探照燈投陰影會讓材質超過 16 個貼圖單元、整城不渲染 → castShadow 一律 false
{
  const heliSrc = readFileSync(new URL('../../src/wanted/helicopter.js', import.meta.url), 'utf8');
  ok(/view\.light\.castShadow = false;/.test(heliSrc) && !/\.light\.castShadow = (?!false)/.test(heliSrc),
    '探照燈 SpotLight 不投陰影（castShadow 恆為 false，避免超過 MAX_TEXTURE_IMAGE_UNITS 致 shader 失敗）');
}

console.log(`v5-police.mjs：通過 ${pass} / ${total}`);
if (fails.length) {
  for (const f of fails) console.log(`✗ ${f}`);
  console.log(`FAIL ${pass}/${total}`);
  process.exit(1);
}
console.log(`PASS ${pass}/${total}`);
