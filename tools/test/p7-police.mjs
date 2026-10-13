// 無頭驗證 src/wanted/police.js：假 adapters（車與警員以直線速度移動）＋假 wanted（手動設 stars / state）
// 用法：node tools/test/p7-police.mjs [-v 列出每項斷言]（任一斷言失敗 exit 1）
import { createBus } from '../../src/core/events.js';
import {
  createPolice, MAX_CARS, MAX_OFFICERS, PATROL_MIN, PATROL_MAX, RECYCLE_DIST, SPAWN_MIN, SPAWN_MAX, SEE_ACTIVE, SEE_SEARCH,
  WITNESS_DIST, FIRE_MIN, FIRE_MAX, FIRE_INTERVAL_MIN, FIRE_INTERVAL_MAX, BUST_DIST, BUST_TIME, BUST_CAR_DIST, BUST_CAR_TIME, RECALL_SEC,
  DEPLOY_DIST, RAM_DIST,
} from '../../src/wanted/police.js';

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
const OFFICER_RUN = 6; // m/s

// 可重現的 rng
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

// 假世界：車開向 driveCar 目標（speed = maxSpeed，stop 立即停），警員以 OFFICER_RUN 直線跑
function makeWorld({ seed = 1, spawnDist = null } = {}) {
  const rng = mulberry(seed);
  const w = {
    cars: new Set(),
    officers: new Set(),
    spawnCalls: [],
    drives: new Map(), // car → 最後一次 driveCar 參數
    moves: new Map(),
    aims: [],
    despawnedCars: [],
    despawnedOfficers: [],
    see: true,
    playerX: 0,
    playerZ: 0,
  };
  w.adapters = {
    findSpawnPoint(nx, nz, min, max) {
      w.spawnCalls.push({ nx, nz, min, max });
      const r = spawnDist ?? min + rng() * (max - min);
      const ang = rng() * Math.PI * 2;
      return { x: nx + Math.cos(ang) * r, z: nz + Math.sin(ang) * r, heading: 0 };
    },
    spawnCar({ x, z, heading }) {
      const car = { pos: { x, z }, speed: 0, alive: true, heading, spawnD: Math.hypot(x - w.playerX, z - w.playerZ) };
      w.cars.add(car);
      return car;
    },
    despawnCar(car) {
      w.cars.delete(car);
      w.despawnedCars.push(car);
    },
    driveCar(car, cmd) {
      w.drives.set(car, cmd);
    },
    spawnOfficer({ x, z, car }) {
      const o = { pos: { x, z, y: 0 }, alive: true, down: false, car };
      w.officers.add(o);
      return o;
    },
    despawnOfficer(o) {
      w.officers.delete(o);
      w.despawnedOfficers.push(o);
    },
    moveOfficer(o, cmd) {
      w.moves.set(o, cmd);
    },
    officerAim(o, cmd) {
      w.aims.push({ o, ...cmd });
    },
    canSee() {
      return w.see;
    },
  };
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
      const step = Math.min(d, (cmd.run ? OFFICER_RUN : 1.5) * dt);
      if (d > 0) {
        o.pos.x += (dx / d) * step;
        o.pos.z += (dz / d) * step;
      }
    }
  };
  return w;
}

function makeWanted(stars = 0, state = stars ? 'active' : 'clear') {
  return { stars, state, searchCircle: null, lastKnown: null };
}

function setup({ stars = 0, seed = 1, spawnDist = null } = {}) {
  const bus = createBus();
  const world = makeWorld({ seed, spawnDist });
  const wanted = makeWanted(stars);
  const events = { bust: [], shoot: [] };
  bus.on('police:bust', (p) => events.bust.push({ ...p, t: sim.t }));
  bus.on('police:shoot', (p) => events.shoot.push({ ...p, t: sim.t }));
  const police = createPolice({ bus, wanted, adapters: world.adapters, rng: mulberry(seed + 100) });
  const player = { x: 0, z: 0, inVehicle: false, speed: 0, down: false };
  const sim = {
    bus, world, wanted, events, police, player, t: 0, lastSeen: false,
    run(sec, dt = FRAME, stopIf = null) {
      const n = Math.round(sec / dt);
      for (let i = 0; i < n; i++) {
        world.playerX = player.x;
        world.playerZ = player.z;
        sim.lastSeen = police.update(dt, { player }).seen;
        world.step(dt);
        sim.t += dt;
        if (stopIf && stopIf()) return true;
      }
      return false;
    },
  };
  return sim;
}

const d2 = (p, x, z) => Math.hypot(p.x - x, p.z - z);

// ── 1. 0 星巡邏車、回收重生、升星補車 ──
{
  const s = setup({ stars: 0 });
  s.run(3);
  ok(s.police.cars.length === 1 && s.world.cars.size === 1, '0 星只有 1 台巡邏車');
  ok(s.world.spawnCalls[0].min === PATROL_MIN && s.world.spawnCalls[0].max === PATROL_MAX, `0 星巡邏車從 ${PATROL_MIN}–${PATROL_MAX} m 生`);
  ok([...s.world.drives.values()].every((c) => c.mode === 'patrol'), '0 星巡邏車 mode = patrol');
  ok(s.police.officers.length === 0, '0 星沒有警員');
  const first = s.police.cars[0];
  s.player.x = first.pos.x + RECYCLE_DIST + 50; // 玩家瞬移遠離
  s.run(0.1);
  ok(s.world.despawnedCars.includes(first), `離玩家 > ${RECYCLE_DIST} m 回收`);
  ok(s.police.cars.length === 1 && s.police.cars[0] !== first, '回收後重生 1 台');
  ok(d2(s.police.cars[0].pos, s.player.x, s.player.z) <= PATROL_MAX + 1e-6, '重生的巡邏車在新玩家位置附近');

  for (let st = 1; st <= 5; st++) {
    const t = setup({ stars: 0, seed: 10 + st });
    t.run(1);
    t.world.spawnCalls.length = 0;
    t.wanted.stars = st;
    t.wanted.state = 'active';
    t.run(1);
    const calls = t.world.spawnCalls;
    ok(t.police.cars.length === MAX_CARS[st], `${st} 星補車到 MAX_CARS = ${MAX_CARS[st]}（實際 ${t.police.cars.length}）`);
    ok(calls.length === MAX_CARS[st] - 1 && calls.every((c) => c.min === SPAWN_MIN && c.max === SPAWN_MAX), `${st} 星補車都向 findSpawnPoint 要 ${SPAWN_MIN}–${SPAWN_MAX} m`);
    const fresh = t.police.cars.slice(1);
    ok(fresh.every((c) => c.spawnD >= SPAWN_MIN - 1e-6 && c.spawnD <= SPAWN_MAX + 1e-6), `${st} 星新車生成距離在 ${SPAWN_MIN}–${SPAWN_MAX} m`);
    ok(fresh.every((c) => t.world.drives.get(c).mode === 'pursue'), `${st} 星新車 pursue`);
  }
  // findSpawnPoint 失敗不丟例外、不生
  const fw = makeWorld();
  const fp = createPolice({ wanted: makeWanted(2), adapters: { ...fw.adapters, findSpawnPoint: () => null } });
  let threw = false;
  try {
    for (let i = 0; i < 60; i++) fp.update(FRAME, { player: { x: 0, z: 0 } });
  } catch {
    threw = true;
  }
  ok(!threw && fp.cars.length === 0 && fw.cars.size === 0, 'findSpawnPoint 回 null：不丟例外、不生車');
  // searching：開向搜索圈內點；≥3 星車上 25 m 內 ram
  const g = setup({ stars: 3 });
  g.run(0.2);
  g.wanted.state = 'searching';
  g.wanted.searchCircle = { x: 500, z: 0, r: 200 };
  g.run(0.1);
  ok([...g.police.cars].every((c) => {
    const cmd = g.world.drives.get(c);
    return cmd.mode === 'pursue' && Math.hypot(cmd.x - 500, cmd.z) <= 200 + 1e-6;
  }), 'searching：pursue 搜索圈內隨機點');
  g.wanted.state = 'active';
  g.wanted.searchCircle = null;
  g.player.inVehicle = true;
  g.player.speed = 15;
  const car0 = g.police.cars[0];
  car0.pos.x = RAM_DIST - 5;
  car0.pos.z = 0;
  g.run(FRAME);
  ok(g.world.drives.get(car0).mode === 'ram', `≥3 星玩家在車上、${RAM_DIST} m 內 → ram`);
}

// ── 2. seen 判定 ──
{
  const s = setup({ stars: 1, spawnDist: SPAWN_MIN });
  s.run(FRAME);
  const car = s.police.cars[0];
  const put = (d) => {
    car.pos.x = d;
    car.pos.z = 0;
    s.world.drives.clear();
  };
  const seenAt = (d) => {
    put(d);
    return s.police.update(0, { player: s.player }).seen;
  };
  s.wanted.state = 'active';
  ok(seenAt(SEE_ACTIVE - 1) === true, `active：${SEE_ACTIVE - 1} m 看得見`);
  ok(seenAt(SEE_ACTIVE + 1) === false, `active：${SEE_ACTIVE + 1} m 看不見`);
  s.wanted.state = 'searching';
  s.wanted.searchCircle = { x: 0, z: 0, r: 120 };
  ok(seenAt(SEE_SEARCH - 1) === true, `searching：${SEE_SEARCH - 1} m 看得見`);
  ok(seenAt(SEE_SEARCH + 5) === false, `searching：${SEE_SEARCH + 5} m 看不見`);
  s.world.see = false;
  ok(seenAt(10) === false, 'canSee=false（建築遮擋）→ 不算看見');
  s.world.see = true;
  s.wanted.state = 'active';
  const p2 = createPolice({ wanted: s.wanted, adapters: { ...s.world.adapters, findSpawnPoint: () => null } });
  ok(p2.update(FRAME, { player: s.player }).seen === false, '沒有警力 → seen=false');
}
{
  // 警員也能看見；倒地警員不算
  const s = setup({ stars: 1, spawnDist: SPAWN_MIN });
  s.run(15, FRAME, () => s.police.officers.length > 0);
  for (const car of s.police.cars) {
    car.pos.x = SEE_ACTIVE + 50;
    car.pos.z = 0;
  }
  for (const o of s.police.officers) {
    o.pos.x = 30;
    o.pos.z = 0;
  }
  ok(s.police.update(0, { player: s.player }).seen === true, '警員 30 m 看得見');
  for (const o of s.police.officers) o.down = true;
  ok(s.police.update(0, { player: s.player }).seen === false, '倒地警員不算看見');
}

// ── 3. 放警員、開槍 ──
{
  for (const st of [1, 2]) {
    const s = setup({ stars: st, spawnDist: SPAWN_MIN });
    s.run(30);
    ok(s.police.officers.length > 0 && s.police.officers.length <= MAX_OFFICERS[st], `${st} 星：警車靠近減速後放警員（${s.police.officers.length} ≤ ${MAX_OFFICERS[st]}）`);
    ok(s.events.shoot.length === 0 && s.world.aims.every((a) => !a.firing), `${st} 星：不開槍`);
  }
  for (const st of [3, 5]) {
    const s = setup({ stars: st, spawnDist: SPAWN_MIN, seed: 7 });
    s.run(15, FRAME, () => s.police.officers.length > 0);
    ok(s.police.officers.length > 0, `${st} 星：有警員下車`);
    let maxOff = 0;
    // 把警員放到 20 m 處（開槍時警員會停下，不會跑近逮捕）
    for (const o of s.police.officers) {
      o.pos.x = 20;
      o.pos.z = 0;
    }
    s.events.shoot.length = 0;
    s.run(12, FRAME, () => {
      maxOff = Math.max(maxOff, s.police.officers.length);
      return false;
    });
    ok(maxOff <= MAX_OFFICERS[st], `${st} 星：警員數 ${maxOff} ≤ MAX_OFFICERS ${MAX_OFFICERS[st]}`);
    const shots = s.events.shoot;
    ok(shots.length > 0, `${st} 星：8–30 m 開槍並 emit police:shoot（${shots.length} 發）`);
    const sh = shots[0];
    ok(sh && 'officer' in sh && 'x' in sh && 'y' in sh && 'z' in sh && sh.targetX === 0 && sh.targetZ === 0, 'police:shoot payload 欄位齊全');
    const byOff = new Map();
    for (const e of shots) {
      if (!byOff.has(e.officer)) byOff.set(e.officer, []);
      byOff.get(e.officer).push(e.t);
    }
    const gaps = [];
    for (const ts of byOff.values()) for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
    ok(gaps.length > 3 && gaps.every((g) => g >= FIRE_INTERVAL_MIN - FRAME - 1e-9 && g <= FIRE_INTERVAL_MAX + FRAME + 1e-9),
      `${st} 星：每名警員射擊間隔在 ${FIRE_INTERVAL_MIN}–${FIRE_INTERVAL_MAX} s（${gaps.length} 筆，${Math.min(...gaps).toFixed(2)}–${Math.max(...gaps).toFixed(2)}）`);
    ok(new Set(gaps.map((g) => g.toFixed(2))).size > 1, `${st} 星：射擊間隔有隨機變化`);
  }
  // 距離門檻：< 8 m 或 > 30 m 不開槍；canSee=false 不開槍
  {
    const s = setup({ stars: 4, spawnDist: SPAWN_MIN, seed: 3 });
    s.run(15, FRAME, () => s.police.officers.length > 0);
    const pin = (d) => {
      for (const o of s.police.officers) {
        o.pos.x = d;
        o.pos.z = 0;
      }
      s.world.moves.clear();
    };
    s.events.shoot.length = 0;
    // 每幀把警員釘回去，只觀察開槍判定
    const hold = (d, sec) => {
      for (let i = 0; i < sec / FRAME; i++) {
        pin(d);
        s.police.update(FRAME, { player: s.player });
      }
    };
    hold(FIRE_MAX + 5, 3);
    ok(s.events.shoot.length === 0, `> ${FIRE_MAX} m 不開槍`);
    hold(FIRE_MIN - 3, 3);
    ok(s.events.shoot.length === 0, `< ${FIRE_MIN} m 不開槍`);
    s.world.see = false;
    hold(15, 3);
    ok(s.events.shoot.length === 0, 'canSee=false 不開槍');
    s.world.see = true;
    hold(15, 3);
    ok(s.events.shoot.length > 0, '回到 15 m 且看得見 → 開槍');
  }
  // 玩家在車上且車速快：不放警員（車不會停）；步行時 DEPLOY_DIST 內才放
  {
    const s = setup({ stars: 2, spawnDist: SPAWN_MIN });
    s.run(3);
    const near = s.police.cars.map((c) => d2(c.pos, 0, 0));
    ok(s.police.officers.length === 0 && near.every((d) => d > DEPLOY_DIST), `車距 > ${DEPLOY_DIST} m 前不放警員`);
  }
}

// ── 4. 逮捕 ──
function bustRig({ stars = 1, dt = FRAME, inVehicle = false, dist = 1.0 } = {}) {
  const s = setup({ stars, spawnDist: SPAWN_MIN });
  s.player.inVehicle = inVehicle;
  s.run(15, FRAME, () => s.police.officers.length > 0);
  // 只留一名警員在指定距離
  const [o, ...rest] = s.police.officers;
  for (const r of rest) r.down = true;
  o.pos.x = dist;
  o.pos.z = 0;
  s.world.step = () => {}; // 凍結世界，只看判定
  s.events.bust.length = 0;
  return { s, o, dt };
}
{
  // 步行：1.5 s 成立、只一次
  const { s, o } = bustRig({ dist: BUST_DIST - 0.1 });
  const t0 = s.t;
  s.run(BUST_TIME - 0.1);
  ok(s.events.bust.length === 0 && s.police.bustProgress > 0.8 && s.police.bustProgress < 1, `步行 ${BUST_TIME - 0.1} s 尚未成立（progress ${s.police.bustProgress.toFixed(2)}）`);
  s.run(0.2);
  ok(s.events.bust.length === 1, '步行 1.6 m 內連續 1.5 s → police:bust');
  const bt = s.events.bust[0].t - t0;
  ok(Math.abs(bt - BUST_TIME) < 0.05, `成立時間 ${bt.toFixed(3)} s ≈ ${BUST_TIME}`);
  ok(s.events.bust[0].officer === o && 'x' in s.events.bust[0] && 'z' in s.events.bust[0], 'police:bust payload {x,z,officer}');
  s.run(5);
  ok(s.events.bust.length === 1, 'police:bust 只發一次');
  s.bus.emit('wanted:cleared', { reason: 'busted' });
  ok(s.police.bustProgress === 0, 'wanted:cleared 後 bustProgress 歸零');
}
{
  // 超出距離不算；中斷衰減
  const { s, o } = bustRig({ dist: BUST_DIST + 0.2 });
  s.run(3);
  ok(s.events.bust.length === 0 && s.police.bustProgress === 0, `${BUST_DIST + 0.2} m 不逮捕`);
  o.pos.x = 1;
  s.run(1.0);
  const p1 = s.police.bustProgress;
  o.pos.x = 5; // 中斷
  s.run(0.3);
  const p2 = s.police.bustProgress;
  ok(Math.abs(p1 - p2 - 0.3) < 0.02, `中斷時每秒衰減 1（${p1.toFixed(2)} → ${p2.toFixed(2)}）`);
  s.run(1);
  ok(s.police.bustProgress === 0, '衰減到 0 為止');
  // 玩家倒地不逮捕
  o.pos.x = 1;
  s.player.down = true;
  s.run(3);
  ok(s.events.bust.length === 0, '玩家倒地不逮捕');
  s.player.down = false;
  // 倒地警員不計
  o.down = true;
  s.run(3);
  ok(s.events.bust.length === 0 && s.police.bustProgress === 0, '倒地警員不計入逮捕');
  o.down = false;
  // 0 星不逮捕
  s.wanted.stars = 0;
  s.wanted.state = 'clear';
  s.run(0.5);
  ok(s.events.bust.length === 0, '0 星不逮捕');
}
{
  // 車上：低速 2.5 m 內 2.5 s 成立；車速 ≥ 1 不成立
  const { s } = bustRig({ inVehicle: true, dist: BUST_CAR_DIST - 0.2 });
  s.player.speed = 3;
  s.run(4);
  ok(s.events.bust.length === 0, '車上車速 3 m/s 不逮捕');
  s.player.speed = 0.5;
  const t0 = s.t;
  s.run(BUST_CAR_TIME - 0.2);
  ok(s.events.bust.length === 0, `車上 ${BUST_CAR_TIME - 0.2} s 尚未成立`);
  s.run(0.4);
  ok(s.events.bust.length === 1, `車上低速、${BUST_CAR_DIST} m 內連續 ${BUST_CAR_TIME} s → police:bust`);
  const bt = s.events.bust[0] && s.events.bust[0].t - t0;
  ok(Math.abs(bt - BUST_CAR_TIME) < 0.05, `車上成立時間 ${bt?.toFixed(3)} s ≈ ${BUST_CAR_TIME}`);
}

// ── 5. witness、解除後回收 ──
{
  const s = setup({ stars: 0, spawnDist: PATROL_MIN });
  s.run(FRAME);
  const car = s.police.cars[0];
  car.pos.x = 100;
  car.pos.z = 0;
  ok(s.police.witness(100 - WITNESS_DIST + 1, 0) === true, `witness：${WITNESS_DIST - 1} m 內看得見 → true`);
  ok(s.police.witness(100 - WITNESS_DIST - 1, 0) === false, `witness：${WITNESS_DIST + 1} m → false`);
  s.world.see = false;
  ok(s.police.witness(90, 0) === false, 'witness：canSee=false → false');
}
for (const see of [true, false]) {
  const s = setup({ stars: 4, spawnDist: SPAWN_MIN, seed: 21 });
  s.run(20, FRAME, () => s.police.officers.length >= 2);
  ok(s.police.cars.length === MAX_CARS[4] && s.police.officers.length >= 2, `4 星：${s.police.cars.length} 車 / ${s.police.officers.length} 警員`);
  // 讓所有車都在玩家附近（視線內距離）
  for (const c of s.police.cars) c.pos.x = Math.min(Math.max(c.pos.x, -60), 60);
  s.wanted.stars = 0;
  s.wanted.state = 'clear';
  s.bus.emit('wanted:cleared', { reason: 'evaded' });
  s.world.see = see;
  if (see) {
    // 凍結車輛位置（假世界的車會開向 120 m 外的巡邏點，跑出 DESPAWN_VIEW_DIST 就合法回收了）
    const step = s.world.step;
    s.world.step = (dt) => {
      const saved = s.police.cars.map((c) => ({ c, x: c.pos.x, z: c.pos.z }));
      step(dt);
      for (const { c, x, z } of saved) {
        c.pos.x = x;
        c.pos.z = z;
      }
    };
  }
  const t0 = s.t;
  const despawnTimes = [];
  const before = s.world.despawnedCars.length;
  let doneAt = null;
  s.run(RECALL_SEC + 2, FRAME, () => {
    if (s.world.despawnedCars.length > before + despawnTimes.length) despawnTimes.push(s.t - t0);
    if (doneAt === null && s.police.cars.length === MAX_CARS[0] && s.police.officers.length === 0) doneAt = s.t - t0;
    return false;
  });
  if (!see) {
    ok(doneAt !== null && doneAt <= RECALL_SEC, `cleared 後 ${doneAt?.toFixed(1)} s 回到 0 星配置（≤ ${RECALL_SEC} s，canSee=false）`);
    ok(despawnTimes.length >= 2 && despawnTimes[despawnTimes.length - 1] - despawnTimes[0] > 5, `回收逐步進行（第一台 ${despawnTimes[0]?.toFixed(1)} s、最後 ${despawnTimes.at(-1)?.toFixed(1)} s）`);
    ok([...s.world.drives.entries()].filter(([c]) => s.police.cars.includes(c)).every(([, c]) => c.mode === 'patrol'), '解除後剩下的警車 patrol');
  } else {
    ok(s.police.cars.length > MAX_CARS[0], `canSee=true：仍在視線內的車不 despawn（剩 ${s.police.cars.length} 台）`);
    s.world.see = false;
    s.run(1);
    ok(s.police.cars.length === MAX_CARS[0] && s.police.officers.length === 0, '離開視線（canSee=false）後回收到 0 星配置');
  }
}

// ── 6. 幀率無關、dispose ──
function bustTime(dt, inVehicle) {
  const s = setup({ stars: 2, spawnDist: SPAWN_MIN });
  s.player.inVehicle = inVehicle;
  s.player.speed = 0;
  s.run(15, FRAME, () => s.police.officers.length > 0);
  const [o, ...rest] = s.police.officers;
  for (const r of rest) r.down = true;
  o.pos.x = 1;
  o.pos.z = 0;
  s.world.step = () => {};
  const t0 = s.t;
  s.run(10, dt, () => s.events.bust.length > 0);
  return s.t - t0;
}
{
  for (const inV of [false, true]) {
    const a = bustTime(1 / 60, inV);
    const b = bustTime(1 / 144, inV);
    ok(Math.abs(a - b) / a < 0.05, `${inV ? '車上' : '步行'}逮捕成立時間 60 Hz ${a.toFixed(3)} s vs 144 Hz ${b.toFixed(3)} s 誤差 < 5%`);
  }
  // 大 dt 被 clamp：一次 dt=5 不會直接逮捕
  const { s } = bustRig({ dist: 1 });
  s.police.update(5, { player: s.player });
  ok(s.events.bust.length === 0 && s.police.bustProgress <= 0.1 / BUST_TIME + 1e-9, 'dt 內部 clamp ≤ 0.1');
  // 追捕整體行為幀率無關：警員跑到玩家身邊的逮捕時間
  const chase = (dt) => {
    const t = setup({ stars: 1, spawnDist: SPAWN_MIN, seed: 5 });
    t.run(60, dt, () => t.events.bust.length > 0);
    return t.t;
  };
  const c60 = chase(1 / 60);
  const c144 = chase(1 / 144);
  ok(c60 < 60 && Math.abs(c60 - c144) / c60 < 0.05, `追捕到逮捕總時間 60 Hz ${c60.toFixed(2)} s vs 144 Hz ${c144.toFixed(2)} s 誤差 < 5%`);

  const d = setup({ stars: 3, spawnDist: SPAWN_MIN });
  d.run(15, FRAME, () => d.police.officers.length > 0);
  d.police.dispose();
  ok(d.world.cars.size === 0 && d.world.officers.size === 0, 'dispose 釋放所有警車與警員');
  let threw = false;
  try {
    d.run(1);
    d.police.witness(0, 0);
    d.bus.emit('wanted:cleared', { reason: 'debug' });
    d.police.dispose();
  } catch {
    threw = true;
  }
  ok(!threw, 'dispose 後 update / witness / 重複 dispose 不丟例外');
  ok(d.police.cars.length === 0 && d.police.officers.length === 0, 'dispose 後 cars / officers 為空');
}

// ── 其他：死亡警力移出名單 ──
{
  const s = setup({ stars: 2, spawnDist: SPAWN_MIN });
  s.run(15, FRAME, () => s.police.officers.length > 0);
  const o = s.police.officers[0];
  o.alive = false;
  s.run(FRAME);
  ok(!s.police.officers.includes(o), '死亡警員移出 officers');
  ok(s.world.officers.has(o), '死亡警員在玩家視線內不 despawn');
  s.world.see = false;
  s.run(FRAME);
  ok(!s.world.officers.has(o), '死亡警員離開視線後 despawn');
}

// ── 其他：孤兒警員（車被毀）回收、名額釋放（審查 🔴 police.js:151）──
// 情境：1 星，警員下車後警車被毀，玩家開車到 200 m 外停住；60 秒內孤兒警員須 despawn，之後第二台車到玩家旁能放人
{
  const s = setup({ stars: 1, spawnDist: SPAWN_MIN });
  s.run(30, FRAME, () => s.police.officers.length === MAX_OFFICERS[1]);
  const orphans = [...s.police.officers];
  ok(orphans.length === MAX_OFFICERS[1], '孤兒情境：第一台車放滿 1 星警員名額');
  const firstCar = s.police.cars.find((c) => orphans.some((o) => o.car === c));
  firstCar.alive = false; // 警車被毀
  s.player.x = 200;
  s.player.inVehicle = true;
  s.player.speed = 0;
  s.run(60, FRAME, () => orphans.every((o) => !s.world.officers.has(o)));
  ok(orphans.every((o) => !s.police.officers.includes(o) && s.world.despawnedOfficers.includes(o)), `孤兒警員 60 秒內 despawn（剩 ${orphans.filter((o) => s.world.officers.has(o)).length}）`);
  s.player.inVehicle = false;
  const deployed = s.run(60, FRAME, () => s.police.officers.some((o) => !orphans.includes(o) && d2(o.pos, s.player.x, s.player.z) <= DEPLOY_DIST + 5));
  ok(deployed, '孤兒回收後：第二台車到玩家旁能放人');
  s.run(10);
  ok(s.events.bust.length >= 1, '孤兒回收後：新警員能完成逮捕');
}

// ── 其他：adapters 回報 patrolArrived（停在路網投影點）→ 換下一個巡邏點（審查 🟡 adapters.js:417 的 police 端）──
{
  const s = setup({ stars: 0 });
  s.run(FRAME);
  const car = s.police.cars[0];
  const before = { ...s.world.drives.get(car) };
  car.patrolArrived = true;
  s.run(FRAME);
  car.patrolArrived = false;
  const after = s.world.drives.get(car);
  ok(after.mode === 'patrol' && (after.x !== before.x || after.z !== before.z), 'patrolArrived → 換下一個巡邏點');
}

console.log(`p7-police.mjs：通過 ${pass} / ${total}`);
for (const m of fails) console.log(`  ✗ ${m}`);
console.log(fails.length ? `FAIL ${fails.length}/${total}` : `PASS ${pass}/${total}`);
if (fails.length) process.exit(1);
