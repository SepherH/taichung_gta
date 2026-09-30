// 無頭驗證 src/combat.js 與 src/npc-ai.js：mock actor / anim / body，手動推進時間
// 用法：node tools/test/combat.mjs [-v 列出每項斷言]（任一斷言失敗 exit 1）
import { CombatSystem, PUNCH_DAMAGE, GETUP_MIN_DOWN, GETUP_TIMEOUT, DEAD_HOLD, HIT_RADIUS, HIT_HALF_ANGLE, HIT_MAX_DY, KNOCKBACK_DIST, ASSIST_RADIUS, HIT_STOP, pedKnockdownPayload, hitSide } from '../../src/combat.js';
import {
  NpcBrain, wireCombatToBrains, createBrainGroup, fighterCount, FIGHT_PUNCH_MIN, FIGHT_PUNCH_MAX, WATCH_MIN_TIME, WATCH_MAX_TIME,
  GUNSHOT_RADIUS, HORN_SIDESTEP_MIN, HORN_SIDESTEP_MAX, HORN_LOOK_MIN, HORN_LOOK_MAX, HORN_GLARE_MIN, HORN_GLARE_MAX, PANIC_HOPS, MAX_FIGHTERS, DISPERSE_MIN, DISPERSE_MAX, FLEE_MIN_TIME, FLEE_MAX_TIME,
} from '../../src/npc-ai.js';

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

let clock = 0;
const now = () => clock;
const FRAME = 1 / 60;

function mockActor(id, x, z, yaw = 0, { kind = 'pedestrian', y = 0 } = {}) {
  const handlers = {};
  const anim = {
    state: 'idle',
    triggers: [],
    stops: [],
    trigger(name) {
      this.triggers.push(name); // state 由測試手動設定（例如 drive），模擬動畫播完已回 idle
      return this.reject !== name; // reject：模擬動畫拒絕某個一次性動作（例如跳躍中不能出拳）
    },
    hitStop(sec) {
      this.stops.push(sec);
    },
    on(evt, cb) {
      (handlers[evt] ||= []).push(cb);
      return () => handlers[evt].splice(handlers[evt].indexOf(cb), 1);
    },
    emit(evt, arg) {
      for (const cb of handlers[evt] || []) cb(arg);
    },
    count(name) {
      return this.triggers.filter((t) => t === name).length;
    },
  };
  const body = {
    impulses: [],
    standUps: 0,
    settle: { settled: false, clearToStand: false },
    knockdown(imp) {
      this.impulses.push(imp);
    },
    settleCheck() {
      return this.settle;
    },
    standUp() {
      this.standUps++;
    },
  };
  return { id, kind, pos: { x, y, z }, yaw, hp: 100, maxHp: 100, anim, body, faction: kind === 'player' ? 'player' : 'civilian' };
}

function step(sys, seconds, each) {
  const n = Math.round(seconds / FRAME);
  for (let i = 0; i < n; i++) {
    clock += FRAME;
    if (each) each();
    sys.update(FRAME);
  }
}

// 完整一拳：requestPunch → 開窗 → 窗內 frames 幀 → 關窗
function punch(sys, att, windowSec = 0.15) {
  const accepted = sys.requestPunch(att);
  if (!accepted) return false;
  step(sys, 0.1);
  att.anim.emit('punchHitWindow', 'open');
  step(sys, windowSec);
  att.anim.emit('punchHitWindow', 'close');
  return true;
}

// ---------- 1. 命中窗 / 去重 / 扇形 ----------
{
  clock = 0;
  const sys = new CombatSystem({ now });
  const a = mockActor('p', 0, 0, 0, { kind: 'player' }); // 面向 +Z
  const b = mockActor('b', 0, 0.8);
  sys.register(a);
  sys.register(b);
  let hits = 0;
  sys.on('hit', () => hits++);
  punch(sys, a, 0.2); // 窗內 12 幀都重疊
  ok(b.hp === 100 - PUNCH_DAMAGE, `命中窗內多幀只扣一次血（hp=${b.hp}）`);
  ok(hits === 1, `hit 事件一次（${hits}）`);
  ok(b.anim.count('hit') === 1, '受擊方 anim.trigger(hit) 一次');

  // 命中窗外：出拳但尚未開窗 / 關窗後
  clock += 2;
  sys.update(0);
  const hp0 = b.hp;
  sys.requestPunch(a);
  step(sys, 0.5); // 沒有開窗
  ok(b.hp === hp0, '命中窗外（未開窗）不計傷');
  a.anim.emit('punchHitWindow', 'open');
  a.anim.emit('punchHitWindow', 'close');
  step(sys, 0.2);
  ok(b.hp === hp0, '命中窗關閉後不計傷');

  // 扇形外
  const cases = [
    ['背後', 0, -0.8, 0],
    ['太遠 1.5 m', 0, 1.5, 0],
    ['高度差 1.2 m', 0, 0.8, 1.2],
    ['側面 65°', Math.sin((65 * Math.PI) / 180) * 0.8, Math.cos((65 * Math.PI) / 180) * 0.8, 0],
  ];
  for (const [name, x, z, y] of cases) {
    clock += 5;
    sys.update(0);
    b.pos.x = x;
    b.pos.z = z;
    b.pos.y = y;
    const h = b.hp;
    punch(sys, a);
    ok(b.hp === h, `扇形外（${name}）不命中`);
  }
  // 扇形內 30° 命中、擊退向量水平且朝外
  clock += 5;
  sys.update(0);
  b.pos.x = Math.sin(Math.PI / 6) * 0.9;
  b.pos.z = Math.cos(Math.PI / 6) * 0.9;
  b.pos.y = 0.3;
  let kb = null;
  sys.on('hit', (e) => (kb = e.knockback));
  const h = b.hp;
  punch(sys, a);
  ok(b.hp === h - PUNCH_DAMAGE, '扇形內 30°、高度差 0.3 m 命中');
  ok(kb && kb.y === 0 && kb.x > 0 && kb.z > 0 && Math.hypot(kb.x, kb.z) < 1, '擊退向量為小的水平外推');
  ok(Math.abs(Math.hypot(kb.x, kb.z) - KNOCKBACK_DIST) < 1e-9 && KNOCKBACK_DIST >= 0.4 && KNOCKBACK_DIST <= 0.8, `擊退位移 ${KNOCKBACK_DIST} m（規格 0.4–0.8）`);
  ok(a.anim.stops.at(-1) === HIT_STOP && b.anim.stops.at(-1) === HIT_STOP && HIT_STOP === 0.05, '命中時攻守雙方 hitStop 0.05 s');
  ok(HIT_RADIUS === 1.4 && Math.abs(HIT_HALF_ANGLE - Math.PI / 3) < 1e-12 && HIT_MAX_DY === 1.2, '命中扇形 1.4 m / 半角 60° / 垂直差 < 1.2 m');
  // 扇形邊緣內：1.3 m 正前方、55° 側面、高度差 1.1 m 都命中
  for (const [name, x, z, y] of [
    ['1.3 m 正前方', 0, 1.3, 0],
    ['側面 55°', Math.sin((55 * Math.PI) / 180) * 1.2, Math.cos((55 * Math.PI) / 180) * 1.2, 0],
    ['高度差 1.1 m', 0, 1, 1.1],
  ]) {
    clock += 5;
    sys.update(0);
    Object.assign(b.pos, { x, y, z });
    const h0 = b.hp;
    punch(sys, a);
    ok(b.hp === h0 - PUNCH_DAMAGE, `扇形內（${name}）命中`);
  }
  // 動畫拒絕出拳（例如跳躍中）：requestPunch 回 false、不吃冷卻
  clock += 5;
  sys.update(0);
  a.anim.reject = 'punch';
  const rejected = sys.requestPunch(a) === false;
  a.anim.reject = null;
  ok(rejected && sys.requestPunch(a) === true, '動畫拒絕 punch → requestPunch false，且不進冷卻');
}

// ---------- 1b. 輔助瞄準 ----------
{
  clock = 0;
  const sys = new CombatSystem({ now });
  const a = mockActor('p', 0, 0, 0, { kind: 'player' });
  const near = mockActor('near', 1.6, 1.2); // 2.0 m、右前 53°
  const far = mockActor('far', 0, 2.4); // 2.4 m 正前方
  const behind = mockActor('behind', 0, -1); // 背後
  const side = mockActor('side', -2, 0.05); // 左側 88.6°（前半圓內）
  const out = mockActor('out', 0, ASSIST_RADIUS + 0.1);
  for (const x of [a, near, far, behind, side, out]) sys.register(x);
  ok(sys.assistTarget(a) === near, '輔助瞄準：前方 2.5 m 內最近的行人');
  near.untargetable = true;
  const t2 = sys.assistTarget(a);
  side.pos.x = -3;
  const t3 = sys.assistTarget(a);
  ok(t2 === side && t3 === far, `背後不選、前半圓（±90°）內取最近（${t2 && t2.id} → ${t3 && t3.id}）`);
  far.pos.z = 5;
  side.pos.x = -5;
  ok(sys.assistTarget(a) === null, '2.5 m 內沒有行人 → null');
}

// ---------- 1c. recoverOnKo：拳擊打到 hp 歸零 → 倒地後照常起身、hp 回滿、不發 dead ----------
{
  clock = 0;
  const sys = new CombatSystem({ now });
  const a = mockActor('p', 0, 0, 0, { kind: 'player' });
  const b = mockActor('b', 0, 0.8);
  b.recoverOnKo = true;
  b.hp = PUNCH_DAMAGE;
  sys.register(a);
  sys.register(b);
  let dead = 0;
  sys.on('dead', () => dead++);
  punch(sys, a);
  const kd = sys.stateOf(b) === 'knockdown' && b.hp === 0;
  b.body.settle = { settled: true, clearToStand: true };
  step(sys, GETUP_MIN_DOWN + 0.1);
  const up = sys.stateOf(b) === 'getup';
  step(sys, DEAD_HOLD);
  ok(kd && up && b.hp === b.maxHp && dead === 0, `hp 歸零 → knockdown → ${GETUP_MIN_DOWN}s 後起身、hp ${b.hp}、dead ${dead}`);
}

// ---------- 2. 連擊倒地 ----------
{
  clock = 0;
  const sys = new CombatSystem({ now });
  const a = mockActor('p', 0, 0, 0, { kind: 'player' });
  const b = mockActor('b', 0, 0.8);
  sys.register(a);
  sys.register(b);
  let kds = 0;
  sys.on('knockdown', () => kds++);
  punch(sys, a);
  clock += 0.6;
  punch(sys, a);
  ok(sys.stateOf(b) === 'hit' && kds === 0, '兩拳尚未倒地');
  clock += 0.6;
  punch(sys, a);
  ok(kds === 1 && sys.stateOf(b) === 'knockdown', `4 秒內 3 拳 → knockdown（${kds}）`);
  ok(b.body.impulses.length === 1 && b.anim.count('knockdown') === 1, 'body.knockdown 與 anim knockdown 各一次');
  const hpDown = b.hp;
  clock += 0.6;
  punch(sys, a);
  clock += 0.6;
  punch(sys, a);
  ok(kds === 1 && b.anim.count('knockdown') === 1 && b.body.impulses.length === 1, 'knockdown 中再被打不重複 knockdown');
  ok(b.hp === hpDown, '倒地中不再被拳擊計傷');

  // 超過 4 秒的間隔不累積
  const c = mockActor('c', 0, 0.8);
  sys.unregister(b);
  sys.register(c);
  kds = 0;
  for (let i = 0; i < 3; i++) {
    clock += 2.5;
    punch(sys, a);
  }
  ok(kds === 0 && c.hp === 100 - 3 * PUNCH_DAMAGE, '3 拳間隔各 2.5 s（跨 4 s）不倒地');
  // 受擊硬直中不能出拳
  const d = mockActor('d', 0, 0.5, Math.PI);
  sys.register(d);
  clock += 5;
  sys.update(0);
  punch(sys, a);
  ok(sys.stateOf(d) === 'hit' && sys.requestPunch(d) === false, '受擊硬直中 requestPunch 回傳 false');
  a.anim.state = 'drive';
  clock += 5;
  ok(sys.requestPunch(a) === false, '駕駛中不能出拳');
  a.anim.state = 'idle';
  ok(sys.requestPunch(a) === true && sys.requestPunch(a) === false, '冷卻中不能連續出拳');
}

// ---------- 3. 倒地起身 ----------
{
  clock = 0;
  const sys = new CombatSystem({ now });
  const b = mockActor('b', 0, 0);
  sys.register(b);
  let getups = 0;
  sys.on('getup', () => getups++);
  sys.onVehicleHit({ ped: b, impulse: { x: 300, y: 50, z: 0 }, relSpeed: 4 });
  b.body.settle = { settled: true, clearToStand: false };
  step(sys, 3);
  ok(b.body.standUps === 0 && getups === 0, 'settled 但 !clearToStand → 不起身');
  b.body.settle = { settled: false, clearToStand: true };
  step(sys, 1);
  ok(b.body.standUps === 0, '!settled → 不起身');

  const c = mockActor('c', 0, 5);
  sys.register(c);
  sys.onVehicleHit({ ped: c, impulse: { x: 300, y: 50, z: 0 }, relSpeed: 4 });
  c.body.settle = { settled: true, clearToStand: true };
  step(sys, GETUP_MIN_DOWN - 0.1);
  ok(c.body.standUps === 0, '兩者皆真但倒地 < 1.5 s → 不起身');
  step(sys, 0.2);
  ok(c.body.standUps === 1 && c.anim.count('getup') === 1, `≥ 1.5 s → standUp（${c.body.standUps}）+ getup（${c.anim.count('getup')}）`);
  step(sys, 1);
  ok(sys.stateOf(c) === 'getup', `getup 動畫未發 finished → 仍在 getup（${sys.stateOf(c)}）`);
  c.anim.emit('finished', 'getup');
  ok(c.body.standUps === 1 && c.anim.count('getup') === 1, 'standUp / getup 各只一次');
  ok(sys.stateOf(c) === 'normal', `getup 動畫 finished → 回 normal（${sys.stateOf(c)}）`);

  // 動畫沒發 finished：GETUP_TIMEOUT 逾時保險
  const d = mockActor('d', 0, 8);
  sys.register(d);
  sys.onVehicleHit({ ped: d, impulse: { x: 300, y: 50, z: 0 }, relSpeed: 4 });
  d.body.settle = { settled: true, clearToStand: true };
  step(sys, GETUP_MIN_DOWN + 0.1);
  step(sys, GETUP_TIMEOUT - 0.2);
  const beforeTimeout = sys.stateOf(d);
  step(sys, 0.3);
  ok(beforeTimeout === 'getup' && sys.stateOf(d) === 'normal', `無 finished 時 ${GETUP_TIMEOUT}s 逾時回 normal（${beforeTimeout} → ${sys.stateOf(d)}）`);

  // revive：hp 歸零倒地 → 復活 → 下一次 update 即起身、hp 回滿
  const r = mockActor('r', 0, 11);
  sys.register(r);
  r.hp = 10;
  sys.onVehicleHit({ ped: r, impulse: { x: 300, y: 50, z: 0 }, relSpeed: 20 });
  r.body.settle = { settled: true, clearToStand: true };
  step(sys, 0.2);
  const downAt0 = r.hp === 0 && sys.stateOf(r) === 'knockdown';
  sys.revive(r);
  step(sys, FRAME);
  ok(downAt0 && r.hp === r.maxHp && sys.stateOf(r) === 'getup' && r.body.standUps === 1, `revive → hp ${r.hp}、${sys.stateOf(r)}`);
}

// ---------- 4. 車撞 ----------
{
  clock = 0;
  const sys = new CombatSystem({ now });
  const b = mockActor('b', 0, 0);
  sys.register(b);
  const veh = { pos: { x: 0, z: -2 } };
  let kd = null;
  sys.on('knockdown', (e) => (kd = e));
  const r2 = sys.onVehicleHit({ vehicle: veh, ped: b, impulse: { x: 0, y: 0, z: 100 }, relSpeed: 2 });
  ok(r2 === false && sys.stateOf(b) === 'normal' && b.body.impulses.length === 0 && b.hp === 100, 'relSpeed 2 → 不倒、不扣血');
  const imp = { x: 0, y: 200, z: 900 };
  const r8 = sys.onVehicleHit({ vehicle: veh, ped: b, impulse: imp, relSpeed: 8 });
  ok(r8 && sys.stateOf(b) === 'knockdown' && b.anim.count('knockdown') === 1, 'relSpeed 8 → knockdown');
  ok(b.body.impulses.length === 1 && b.body.impulses[0] === imp, 'body.knockdown 收到衝量');
  ok(kd && kd.cause === 'vehicle' && b.hp < 100 && b.hp > 0, `依速度分級扣血（hp=${b.hp}）`);
  sys.onVehicleHit({ vehicle: veh, ped: b, impulse: imp, relSpeed: 8 });
  ok(b.body.impulses.length === 1, '同車 0.5 s 內重複碰撞事件去重');

  // 高速致命：維持倒地 10 秒後發 dead，不起身
  const c = mockActor('c', 10, 0);
  sys.register(c);
  let dead = 0;
  sys.on('dead', () => dead++);
  sys.onVehicleHit({ vehicle: veh, ped: c, impulse: imp, relSpeed: 20 });
  c.body.settle = { settled: true, clearToStand: true };
  step(sys, DEAD_HOLD - 0.5);
  ok(c.hp === 0 && dead === 0 && c.body.standUps === 0, 'hp 歸零：10 秒內不起身、未發 dead');
  step(sys, 1);
  ok(dead === 1 && sys.stateOf(c) === 'dead', `hp 歸零 10 s 後發 dead（${dead}）`);
  step(sys, 2);
  ok(dead === 1, 'dead 只發一次');
}

// ---------- 5. NPC ----------
{
  // 100 個 NPC 還手比例
  let fighters = 0;
  for (let i = 0; i < 100; i++) if (new NpcBrain({ actor: mockActor(`ped-${i}`, 0, 0) }).fights) fighters++;
  ok(fighters >= 20 && fighters <= 30, `固定種子 100 個 NPC 還手比例 ${fighters}%（20–30%）`);
  let heavyF = 0;
  for (let i = 0; i < 100; i++) if (new NpcBrain({ actor: mockActor(`ped-${i}`, 0, 0), heavy: true }).fights) heavyF++;
  ok(heavyF > fighters, `heavy 體型還手比例較高（${heavyF}%）`);
  const again = new NpcBrain({ actor: mockActor('ped-7', 0, 0) }).braveness === new NpcBrain({ actor: mockActor('ped-7', 0, 0) }).braveness;
  ok(again, '同 id 的 braveness 固定');

  const brave = [];
  const timid = [];
  for (let i = 0; brave.length < 1 || timid.length < 1; i++) {
    const b = new NpcBrain({ actor: mockActor(`ped-${i}`, 0, 0) });
    (b.fights ? brave : timid).push(b);
  }

  // 被打者依 braveness 進入 fight / flee（整合 CombatSystem 事件）
  clock = 0;
  const sys = new CombatSystem({ now });
  const player = mockActor('player', 0, 0, 0, { kind: 'player' });
  const fighter = brave[0];
  fighter.actor.pos = { x: 0, y: 0, z: 0.8 };
  fighter.actor.yaw = Math.PI;
  const runner = timid[0];
  runner.actor.pos = { x: 0.3, y: 0, z: 0.7 };
  const witness = new NpcBrain({ actor: mockActor('witness', 5, 3) });
  const farAway = new NpcBrain({ actor: mockActor('far', 20, 0) });
  const brains = new Map([fighter, runner, witness, farAway].map((b) => [b.actor.id, b]));
  for (const b of brains.values()) sys.register(b.actor);
  sys.register(player);
  wireCombatToBrains(sys, brains);
  punch(sys, player);
  const ctx = { combat: sys, playerInVehicle: false };
  for (const b of brains.values()) b.update(FRAME, ctx);
  ok(fighter.state === 'fight' && fighter.target === player, `勇敢者（braveness ${fighter.braveness.toFixed(2)}）被打 → fight`);
  ok(runner.state === 'flee', `膽小者（braveness ${runner.braveness.toFixed(2)}）被打 → flee`);
  ok(witness.state === (witness.watches ? 'watch' : 'flee'), `8 m 內目擊 → ${witness.watches ? '圍觀' : 'flee'}`);
  ok(farAway.state === 'wander', '8 m 外沒看到 → wander');

  // fight：靠近到 1 m、面向、間隔 0.9–1.4 s 出拳（combat 實際接受）
  fighter.actor.pos = { x: 0, y: 0, z: 4 };
  const punchTimes = [];
  let minDistAtPunch = Infinity;
  let maxDistAtPunch = 0;
  let wrongFace = false;
  for (let i = 0; i < 60 * 6; i++) {
    clock += FRAME;
    sys.update(FRAME);
    const it = fighter.update(FRAME, ctx);
    const p = fighter.actor.pos;
    const sp = it.run ? 3 : 1.5;
    p.x += it.moveX * sp * FRAME;
    p.z += it.moveZ * sp * FRAME;
    if (it.faceYaw !== null) fighter.actor.yaw = it.faceYaw;
    const d = Math.hypot(p.x - player.pos.x, p.z - player.pos.z);
    if (it.wantPunch) {
      punchTimes.push(clock);
      minDistAtPunch = Math.min(minDistAtPunch, d);
      maxDistAtPunch = Math.max(maxDistAtPunch, d);
      if (Math.abs(Math.atan2(player.pos.x - p.x, player.pos.z - p.z) - fighter.actor.yaw) > 1e-6) wrongFace = true;
    }
  }
  const gaps = punchTimes.slice(1).map((t, i) => t - punchTimes[i]);
  ok(punchTimes.length >= 3 && gaps.length >= 2, `fight 6 秒內出拳 ${punchTimes.length} 次`);
  ok(maxDistAtPunch <= 1 + 1e-9, `出拳時距離 ≤ 1 m（最大 ${maxDistAtPunch.toFixed(3)} m）`);
  ok(!wrongFace, '出拳時面向攻擊者');
  const gmin = Math.min(...gaps);
  const gmax = Math.max(...gaps);
  ok(gmin >= FIGHT_PUNCH_MIN - FRAME && gmax <= FIGHT_PUNCH_MAX + FRAME, `出拳間隔 ${gmin.toFixed(3)}–${gmax.toFixed(3)} s（0.9–1.4）`);
  ok(fighter.state === 'fight', '仍在 fight');
  // 攻擊者跑遠 > 12 m → 放棄回 wander
  player.pos.z = fighter.actor.pos.z + 13;
  fighter.update(FRAME, ctx);
  ok(fighter.state === 'wander', '追擊距離 > 12 m → wander');

  // 逃離 30 m 後回 wander
  const f = runner;
  let t = 0;
  let sawSafe = false;
  while (f.state === 'flee' && t < 20) {
    const it = f.update(FRAME, ctx);
    f.actor.pos.x += it.moveX * 6 * FRAME;
    f.actor.pos.z += it.moveZ * 6 * FRAME;
    t += FRAME;
    if (f.state === 'flee' && !it.run) sawSafe = true;
  }
  const fd = Math.hypot(f.actor.pos.x - player.pos.x, f.actor.pos.z - player.pos.z);
  ok(f.state === 'wander' && !sawSafe, `flee 以跑步逃離，回 wander 時距離 ${fd.toFixed(1)} m、經過 ${t.toFixed(2)} s`);
  ok(fd > 30 - 0.2 || (t >= 6 && t <= 10 + FRAME), '回 wander 條件：> 30 m 或 6–10 s');
  // 慢速逃離：時間到（6–10 s）回 wander
  const slow = new NpcBrain({ actor: mockActor('slow', 0, 0) });
  slow.onWitness({ x: 1, z: 0 });
  let ts = 0;
  do {
    slow.update(FRAME, {});
    ts += FRAME;
  } while (slow.state === 'flee' && ts < 20);
  ok(ts >= 6 - FRAME && ts <= 10 + FRAME, `原地逃跑 ${ts.toFixed(2)} s 後回 wander（6–10 s）`);

  // 玩家在車內時不進 fight
  const b2 = new NpcBrain({ actor: fighter.actor });
  b2.onAttacked({ attacker: player });
  b2.update(FRAME, { playerInVehicle: true });
  ok(b2.state === 'flee', '玩家在車內：勇敢者被打也只逃跑');
  player.pos.z = 0;
  fighter.actor.pos = { x: 0, y: 0, z: 2 };
  const b3 = new NpcBrain({ actor: fighter.actor });
  b3.onAttacked({ attacker: player });
  b3.update(FRAME, { playerInVehicle: false });
  ok(b3.state === 'fight', '玩家步行時勇敢者被打 → fight');
  b3.update(FRAME, { playerInVehicle: true });
  ok(b3.state === 'flee', 'fight 中玩家上車 → 改逃跑');

  // 車輛高速逼近 3 m 內 → 閃避跳開再逃跑；慢速不理
  const dd = new NpcBrain({ actor: mockActor('dodger', 0, 0) });
  let it = dd.update(FRAME, { vehicles: [{ x: 0, z: -2.5, vx: 0, vz: 5 }] });
  ok(dd.state === 'wander', '車速 5 m/s 逼近 → 不理會');
  it = dd.update(FRAME, { vehicles: [{ x: 0.2, z: -2.5, vx: 0, vz: 12 }] });
  ok(dd.state === 'dodge' && it.jump && Math.abs(it.moveZ) < 1e-9 && it.moveX < 0, '車速 12 m/s 逼近 3 m 內 → 往側面跳開');
  for (let i = 0; i < 40; i++) dd.update(FRAME, {});
  ok(dd.state === 'flee', '閃避後轉 flee');
  const dz = new NpcBrain({ actor: mockActor('dz', 0, 0) });
  dz.update(FRAME, { vehicles: [{ x: 0, z: 2.5, vx: 0, vz: 12 }] });
  ok(dz.state === 'wander', '車輛正在遠離 → 不閃避');

  // 倒地交給 combat：down 狀態、起身後逃離
  clock = 0;
  const sys2 = new CombatSystem({ now });
  const v = new NpcBrain({ actor: mockActor('victim', 0, 0) });
  sys2.register(v.actor);
  wireCombatToBrains(sys2, new Map([[v.actor.id, v]]));
  sys2.onVehicleHit({ vehicle: { pos: { x: 0, z: -1 } }, ped: v.actor, impulse: { x: 0, y: 0, z: 1 }, relSpeed: 6 });
  let iv = v.update(FRAME, { combat: sys2 });
  ok(iv.mode === 'down' && iv.moveX === 0 && iv.moveZ === 0, '倒地中 mode=down、不移動');
  v.actor.body.settle = { settled: true, clearToStand: true };
  step(sys2, GETUP_MIN_DOWN + 0.1);
  v.actor.anim.emit('finished', 'getup');
  iv = v.update(FRAME, { combat: sys2 });
  ok(iv.mode === 'flee', '起身完成後逃離肇事車輛');
}

// ---------- 6. 目擊者：多數逃跑、少數圍觀後離開；混合體型還手比例 ----------
{
  let watchers = 0;
  let fled = 0;
  let mixedFight = 0;
  let watchOk = true;
  let watchDetail = '';
  for (let i = 0; i < 300; i++) {
    const b = new NpcBrain({ actor: mockActor(`ped-${i}`, 3, 0), heavy: i % 3 === 2 });
    if (b.fights) mixedFight++;
    b.onWitness({ x: 0, z: 0 }, mockActor('attacker', 0, 0, 0, { kind: 'player' }));
    let it = b.update(FRAME, {});
    if (b.state === 'flee') fled++;
    if (b.state !== 'watch') continue;
    watchers++;
    const faceOk = it.moveX === 0 && it.moveZ === 0 && Math.abs(it.faceYaw - Math.atan2(-3, 0)) < 1e-9;
    let t = FRAME;
    while (b.state === 'watch' && t < 20) {
      it = b.update(FRAME, {});
      t += FRAME;
    }
    if (!faceOk || b.state !== 'wander' || t < WATCH_MIN_TIME - FRAME || t > WATCH_MAX_TIME + 2 * FRAME) {
      watchOk = false;
      watchDetail = `${b.state} ${t.toFixed(2)} s face=${faceOk}`;
    }
  }
  ok(watchers >= 30 && watchers <= 90 && fled === 300 - watchers, `300 個目擊者：逃跑 ${fled}、圍觀 ${watchers}（10–30%）`);
  ok(watchOk && watchers > 0, `圍觀者原地面向事發點、${WATCH_MIN_TIME}–${WATCH_MAX_TIME} s 後回漫步 ${watchDetail}`);
  ok(mixedFight >= 60 && mixedFight <= 120, `混合體型（1/3 壯碩）還手比例 ${((mixedFight / 300) * 100).toFixed(1)}%（20–40%）`);
  // 圍觀中肇事者逼近 → 改逃跑
  const w = new NpcBrain({ actor: mockActor('ped-watch', 3, 0) });
  const th = mockActor('attacker', 0, 0, 0, { kind: 'player' });
  w.watches = true;
  w.onWitness({ x: 0, z: 0 }, th);
  w.update(FRAME, {});
  const was = w.state;
  th.pos.x = 1.5;
  w.update(FRAME, {});
  ok(was === 'watch' && w.state === 'flee', `圍觀中肇事者逼近 → 逃跑（${was} → ${w.state}）`);
}

// ---------- 7. 喇叭（Phase 3）：前方 15 m、±40°；車道上側跳、人行道上看一下、少數瞪人 ----------
{
  const horn = { type: 'horn', x: 0, z: 0, dirX: 0, dirZ: 2 }; // 車在原點、朝 +Z 按喇叭（dir 不必是單位向量）
  // 扇形判斷
  const at = (x, z) => new NpcBrain({ actor: mockActor(`h-${x}-${z}`, x, z) });
  const inside = [at(0, 10), at(Math.tan((35 * Math.PI) / 180) * 10, 10), at(0, 14.9)].map((b) => b.hear(horn));
  const outside = [at(Math.tan((45 * Math.PI) / 180) * 10, 10), at(0, 15.5), at(0, -5), at(20, 0)].map((b) => b.hear(horn));
  ok(inside.every(Boolean) && !outside.some(Boolean), `喇叭扇形：前方 10 m / 35° / 14.9 m 收到，45° / 15.5 m / 背後 / 側面收不到（${inside}｜${outside}）`);

  // 車道上（無 roadSide：離軸線 < 1.8 m）→ 往垂直方向、自己所在的一側跳開，時間到回 wander
  const r = at(0.5, 8);
  r.hear(horn);
  let it = r.update(FRAME, {});
  const jumped = it.jump && r.state === 'sidestep' && it.moveX > 0.99 && Math.abs(it.moveZ) < 1e-9 && it.run;
  let ts = FRAME;
  while (r.state === 'sidestep' && ts < 5) {
    r.update(FRAME, {});
    ts += FRAME;
  }
  ok(jumped && r.state === 'wander' && ts >= HORN_SIDESTEP_MIN && ts <= HORN_SIDESTEP_MAX + FRAME, `車道上 → sidestep 起跳、往軸線右側（+X）跑開、${ts.toFixed(2)} s 後回 wander`);
  const l = at(-0.4, 6);
  l.hear(horn);
  it = l.update(FRAME, {});
  ok(l.state === 'sidestep' && it.moveX < -0.99, '軸線左側的人往左（-X）跳開');

  // roadSide 轉接器：x < 3 視為車道、人行道在 +X；離開車道（且滿 0.45 s）即結束
  const roadSide = (x, z, out) => {
    if (x >= 3) return false;
    out.x = 1;
    out.z = 0;
    return true;
  };
  const rs = new NpcBrain({ actor: mockActor('h-rs', -1, 9), roadSide });
  rs.hear(horn);
  let tr = 0;
  let movedOk = true;
  do {
    it = rs.update(FRAME, {});
    if (rs.state === 'sidestep') {
      if (!(it.moveX > 0.99)) movedOk = false;
      rs.actor.pos.x += it.moveX * 4 * FRAME;
    }
    tr += FRAME;
  } while (rs.state === 'sidestep' && tr < 5);
  ok(movedOk && rs.state === 'wander' && rs.actor.pos.x >= 3 && tr >= HORN_SIDESTEP_MIN && tr < HORN_SIDESTEP_MAX, `roadSide：軸線左側的人仍依轉接器往人行道（+X）跳開、上人行道即回 wander（${tr.toFixed(2)} s、x=${rs.actor.pos.x.toFixed(2)}）`);
  const onWalk = new NpcBrain({ actor: mockActor('h-walk', 0, 9), roadSide: () => false });
  onWalk.hear(horn);
  onWalk.update(FRAME, {});
  ok(onWalk.state === 'look' || onWalk.state === 'glare', `roadSide 回 false（人行道）→ 不跳（${onWalk.state}）`);
  // ctx.roadSide 優先於建構參數
  const ctxRs = new NpcBrain({ actor: mockActor('h-ctx', 0, 9), roadSide: () => false });
  ctxRs.hear(horn);
  ctxRs.update(FRAME, { roadSide });
  ok(ctxRs.state === 'sidestep', 'ctx.roadSide 優先於建構時的 roadSide');

  // 人行道上（離軸線 3 m）：多數看 0.5–1 s（原地面向車）後回漫步，約 10% 停下瞪人
  let looks = 0;
  let glares = 0;
  let lookOk = true;
  let glareOk = true;
  let detail = '';
  for (let i = 0; i < 400; i++) {
    const b = new NpcBrain({ actor: mockActor(`ped-h${i}`, 3, 8) });
    b.hear(horn);
    it = b.update(FRAME, {});
    const st = b.state;
    const face = it.moveX === 0 && it.moveZ === 0 && Math.abs(it.faceYaw - Math.atan2(-3, -8)) < 1e-9;
    let t = FRAME;
    while (b.state === st && t < 10) {
      b.update(FRAME, {});
      t += FRAME;
    }
    if (st === 'look') {
      looks++;
      if (!face || b.state !== 'wander' || t < HORN_LOOK_MIN - FRAME || t > HORN_LOOK_MAX + 2 * FRAME) (lookOk = false), (detail = `look ${t.toFixed(2)} face=${face}`);
    } else if (st === 'glare') {
      glares++;
      if (!face || b.state !== 'wander' || t < HORN_GLARE_MIN - FRAME || t > HORN_GLARE_MAX + 2 * FRAME) (glareOk = false), (detail = `glare ${t.toFixed(2)} face=${face}`);
    } else (lookOk = false), (detail = `非 look / glare：${st}`);
  }
  ok(lookOk && looks > 0, `人行道上：看向車 ${HORN_LOOK_MIN}–${HORN_LOOK_MAX} s（原地面向喇叭來源）後回 wander ${detail}`);
  ok(glareOk && glares >= 20 && glares <= 64, `400 人中停下瞪人 ${glares} 人（${((glares / 400) * 100).toFixed(1)}%，規格 10%）、${HORN_GLARE_MIN}–${HORN_GLARE_MAX} s 後離開`);
  // 非漫步中不理喇叭；喇叭後被打照常反應
  const busy = new NpcBrain({ actor: mockActor('h-busy', 0.2, 8) });
  busy.onWitness({ x: 0, z: 5 });
  busy.update(FRAME, {});
  busy.hear(horn);
  busy.update(FRAME, {});
  ok(busy.state === 'flee', `逃跑中聽到喇叭不改變（${busy.state}）`);
  const lk = new NpcBrain({ actor: mockActor('h-lk', 3, 8) });
  lk.hear(horn);
  lk.update(FRAME, {});
  lk.onWitness({ x: 3, z: 6 });
  lk.update(FRAME, {});
  ok(lk.state === 'flee' || lk.state === 'watch', `看車中目擊事件照常反應（${lk.state}）`);
}

// ---------- 8. 恐慌擴散：目擊逃跑者傳給 5 m 內的人，每人一次、每層衰減 ----------
{
  clock = 0;
  const sys = new CombatSystem({ now });
  const player = mockActor('player', 0, -1, 0, { kind: 'player' });
  sys.register(player);
  const mk = (id, x, z) => {
    const b = new NpcBrain({ actor: mockActor(id, x, z) });
    b.watches = false;
    b.braveness = 0; // 固定為膽小，避免受害者還手
    return b;
  };
  // 受害者在原點；目擊者 6 m（層 0）→ 10 m（層 1）→ 14 m（層 2）→ 18 m（不再傳到）；另一名 3 m 內的圍觀者不轉傳
  const victim = mk('victim', 0, 0);
  const chain = [mk('c0', 6, 0), mk('c1', 10, 0), mk('c2', 14, 0), mk('c3', 18, 0)];
  const watcher = mk('w', -4, 3);
  watcher.watches = true;
  const nearWatcher = mk('nw', -7, 6); // 離受害者 9.2 m（目擊不到）、只在圍觀者 5 m 內：圍觀者不轉傳 → 保持漫步
  const all = [victim, ...chain, watcher, nearWatcher];
  const brains = new Map(all.map((b) => [b.actor.id, b]));
  for (const b of all) sys.register(b.actor);
  const group = createBrainGroup(brains);
  wireCombatToBrains(sys, brains, group);
  const accepts = new Map();
  for (const b of all) {
    const orig = b.onPanic.bind(b);
    b.onPanic = (info) => {
      const r = orig(info);
      if (r) accepts.set(b, (accepts.get(b) || 0) + 1);
      return r;
    };
  }
  let kd = null;
  sys.on('knockdown', (e) => (kd = e));
  sys.onVehicleHit({ ped: victim.actor, impulse: { x: 0, y: 50, z: 300 }, relSpeed: 7, vehicle: { pos: { x: 0, z: -3 } } });
  const firstState = {};
  const DT3 = 0.05; // 降頻呼叫：任意 dt 仍正確擴散
  for (let t = 0; t < 3; t += DT3) {
    clock += DT3;
    sys.update(DT3);
    for (const b of all) {
      b.update(DT3, { combat: sys });
      if (b.state !== 'wander' && !(b.actor.id in firstState)) firstState[b.actor.id] = { state: b.state, t };
    }
  }
  const st = (b) => (firstState[b.actor.id] || { state: 'wander' }).state;
  ok(kd && kd.cause === 'vehicle' && st(chain[0]) === 'flee', `被撞 → 8 m 內目擊者逃跑（${st(chain[0])}）`);
  ok(st(chain[1]) === 'flee' && st(chain[2]) === 'flee', `恐慌經逃跑者往外傳 ${PANIC_HOPS} 層（10 m：${st(chain[1])}、14 m：${st(chain[2])}）`);
  ok(st(chain[3]) === 'wander', `超過 ${PANIC_HOPS} 層不再傳（18 m：${st(chain[3])}）`);
  const t1 = firstState.c1 && firstState.c1.t;
  const t2 = firstState.c2 && firstState.c2.t;
  ok(t1 > 0 && t2 > t1, `一圈一圈散開：層 1 於 ${t1 && t1.toFixed(2)} s、層 2 於 ${t2 && t2.toFixed(2)} s 開始逃`);
  ok(st(watcher) === 'watch' && st(nearWatcher) === 'wander', `圍觀者不轉傳恐慌（圍觀者 ${st(watcher)}、旁人 ${st(nearWatcher)}）`);
  ok([...accepts.values()].every((n) => n === 1), `每人最多收一次恐慌（${[...accepts.entries()].map(([b, n]) => `${b.actor.id}:${n}`).join(' ')}）`);

  // 拳擊打倒 → 逃跑者避開肇事者（玩家）方向：被傳到的人即使在玩家身後也往遠離玩家處跑
  clock = 0;
  const sys2 = new CombatSystem({ now });
  const pl = mockActor('player', 0, 0, 0, { kind: 'player' });
  const v2 = mk('v2', 0, 0.8);
  const w2 = mk('w2', 0, 6); // 目擊者：在受害者前方
  const r2 = mk('r2', 0, 2.5); // 被傳到的人：在目擊者與玩家之間，逃跑方向必須遠離玩家（+Z），不是遠離目擊者（-Z）
  r2.actor.pos.z = 9.5; // 先放在 8 m 外，只能經由恐慌收到
  const b2 = [v2, w2, r2];
  const brains2 = new Map(b2.map((b) => [b.actor.id, b]));
  sys2.register(pl);
  for (const b of b2) sys2.register(b.actor);
  wireCombatToBrains(sys2, brains2);
  let kd2 = null;
  sys2.on('knockdown', (e) => (kd2 = e));
  for (let i = 0; i < 3; i++) {
    clock += 0.6;
    punch(sys2, pl);
  }
  let away = true;
  let fled = false;
  for (let i = 0; i < 90; i++) {
    clock += FRAME;
    sys2.update(FRAME);
    for (const b of b2) {
      const it = b.update(FRAME, { combat: sys2 });
      if (b === r2 && b.state === 'flee') {
        fled = true;
        const dx = b.actor.pos.x - pl.pos.x;
        const dz = b.actor.pos.z - pl.pos.z;
        if (it.moveX * dx + it.moveZ * dz <= 0) away = false;
      }
    }
  }
  ok(kd2 && kd2.cause === 'punch' && fled && away, `拳擊打倒 → 恐慌傳到 9.5 m 的人、逃跑方向遠離肇事者（fled=${fled} away=${away}）`);
}

// ---------- 9. 還手者成群上限、玩家 hp 0 後散去 ----------
{
  const player = mockActor('player', 0, 0, 0, { kind: 'player' });
  const group = createBrainGroup();
  const brave = [];
  for (let i = 0; brave.length < 6; i++) {
    const b = new NpcBrain({ actor: mockActor(`ped-${i}`, Math.sin(i) * 1.5, Math.cos(i) * 1.5), group });
    if (b.fights) brave.push(b);
  }
  for (const b of brave) group.brains.set(b.actor.id, b);
  const ctx = { playerInVehicle: false };
  for (const b of brave.slice(0, 4)) {
    b.onAttacked({ attacker: player });
    b.update(FRAME, ctx);
  }
  const states = brave.slice(0, 4).map((b) => b.state);
  ok(states.join() === 'fight,fight,flee,flee' && fighterCount(group, player) === MAX_FIGHTERS, `已有 ${MAX_FIGHTERS} 名還手者時第 3、4 人改逃跑（${states}、計數 ${fighterCount(group, player)}）`);
  // 已在還手的人再被打：維持還手、不重複計數
  brave[0].onAttacked({ attacker: player });
  brave[0].update(FRAME, ctx);
  ok(brave[0].state === 'fight' && fighterCount(group, player) === 2, '還手者再被打：仍 fight、計數不變');
  // 一名還手者放棄（玩家跑遠）→ 名額空出，下一個勇敢者可還手
  const keep = brave[1].actor.pos;
  brave[1].actor.pos = { x: 50, y: 0, z: 0 };
  brave[1].update(FRAME, ctx);
  brave[1].actor.pos = keep;
  brave[4].onAttacked({ attacker: player });
  brave[4].update(FRAME, ctx);
  ok(brave[1].state === 'wander' && brave[4].state === 'fight' && fighterCount(group, player) === 2, `還手者離開後名額釋出（${brave[1].state} / ${brave[4].state}、計數 ${fighterCount(group, player)}）`);
  // 還手中的行人被呼叫端回收（移出 brains）→ 計數自動剔除，不會永久佔名額
  const tmp = new NpcBrain({ actor: mockActor('ped-recycled', 0, 1), group });
  tmp.braveness = 1;
  group.brains.set(tmp.actor.id, tmp);
  group.brains.delete(brave[4].actor.id);
  const cnt1 = fighterCount(group, player);
  tmp.onAttacked({ attacker: player });
  tmp.update(FRAME, ctx);
  group.brains.set(brave[4].actor.id, brave[4]);
  ok(cnt1 === 1 && tmp.state === 'fight', `還手者被回收後計數剔除（${cnt1}）、名額給下一人（${tmp.state}）`);
  tmp._enter('wander');
  group.brains.delete(tmp.actor.id);

  // 玩家 hp 0 倒地 → 還手者停手、2–4 s 內散去
  player.hp = 0;
  const combat = { isDown: (a) => a === player, requestPunch: () => true };
  const fighters = [brave[0], brave[4]];
  const doneAt = new Map();
  let punched = false;
  for (let t = 0; t < 6; t += FRAME) {
    for (const b of fighters) {
      const it = b.update(FRAME, { combat, playerInVehicle: false });
      if (it.wantPunch || it.moveX !== 0 || it.moveZ !== 0) punched = true;
      if (b.state !== 'fight' && !doneAt.has(b)) doneAt.set(b, t);
    }
  }
  const times = fighters.map((b) => doneAt.get(b));
  ok(times.every((t) => t !== undefined && t >= DISPERSE_MIN - FRAME && t <= DISPERSE_MAX + FRAME) && !punched, `玩家 hp 0：還手者不再出拳 / 追擊，${times.map((t) => (t === undefined ? '—' : t.toFixed(2))).join(' / ')} s 後散去（${DISPERSE_MIN}–${DISPERSE_MAX} s）`);
  ok(fighters.every((b) => b.state === 'wander') && fighterCount(group, player) === 0, '散去後回 wander、還手計數歸零');
  // 玩家仍倒地（hp 0）時被打的勇敢者不加入還手
  const late = brave[5];
  late.onAttacked({ attacker: player });
  late.update(FRAME, { combat, playerInVehicle: false });
  ok(late.state === 'flee', `玩家倒地中新被打的勇敢者改逃跑（${late.state}）`);
  player.hp = 100;
}

// ---------- 10. knockdown payload（cause / attacker / byPlayer / x z）與 ped:knockdown 轉換 ----------
{
  clock = 0;
  const player = mockActor('player', 0, 0, 0, { kind: 'player' });
  const driverCar = { pos: { x: 3, z: 3 } };
  const sys = new CombatSystem({ now, vehicleDriver: (v) => (v === driverCar ? player : null) });
  const a = mockActor('pa', 0, 0.8);
  const b = mockActor('pb', 5, 5);
  const c = mockActor('pc', 9, 9);
  const d = mockActor('pd', 12, 12);
  for (const x of [player, a, b, c, d]) sys.register(x);
  const kds = [];
  sys.on('knockdown', (e) => kds.push(e));
  for (let i = 0; i < 3; i++) {
    clock += 0.6;
    punch(sys, player);
  }
  sys.onVehicleHit({ ped: b, impulse: { x: 0, y: 0, z: 1 }, relSpeed: 7, vehicle: driverCar });
  sys.onVehicleHit({ ped: c, impulse: { x: 0, y: 0, z: 1 }, relSpeed: 7, vehicle: { pos: { x: 0, z: 0 } } });
  sys.onVehicleHit({ ped: d, impulse: { x: 0, y: 0, z: 1 }, relSpeed: 7, vehicle: { pos: { x: 0, z: 0 } }, driver: player });
  const [kp, kv, kn, kdrv] = kds;
  ok(kds.length === 4 && kp.cause === 'punch' && kp.attacker === player && kp.byPlayer === true && kp.x === a.pos.x && kp.z === a.pos.z, `拳擊 knockdown：cause punch、attacker 玩家、byPlayer、x/z（${kp && kp.cause}）`);
  ok(kv.cause === 'vehicle' && kv.attacker === player && kv.byPlayer === true && kv.x === 5 && kv.z === 5, '車撞 knockdown：vehicleDriver 解析出玩家駕駛 → byPlayer true');
  ok(kn.cause === 'vehicle' && kn.attacker === null && kn.byPlayer === false, '車流車撞人（無駕駛 actor）→ attacker null、byPlayer false');
  ok(kdrv.attacker === player && kdrv.byPlayer === true, 'onVehicleHit 的 driver 參數優先');
  const pk = pedKnockdownPayload(kv);
  ok(pk && pk.ped === b && pk.cause === 'vehicle' && pk.byPlayer === true && pk.x === 5 && pk.z === 5 && pk.weapon === 'vehicle' && Object.keys(pk).sort().join() === 'byPlayer,cause,ped,weapon,x,z', `pedKnockdownPayload → 契約 ped:knockdown { ${pk && Object.keys(pk).join(', ')} }`);
  ok(pedKnockdownPayload({ target: player, cause: 'punch' }) === null, '玩家倒地不轉成 ped:knockdown');
}

// ---------- 11. 任意 dt 與效能：120 名行人每幀 think 成本、暫存重用 ----------
{
  // 大 dt（降頻呼叫）：閃避至少輸出一次側跳意圖；逃跑時長仍以秒計
  const dd = new NpcBrain({ actor: mockActor('dt-dodge', 0, 0) });
  const it = dd.update(0.5, { vehicles: [{ x: 0.2, z: -2.5, vx: 0, vz: 12 }] });
  const dodgeOk = dd.state === 'dodge' && it.jump && it.moveX < 0;
  const scratch = dd.dodgeDir === dd.dodge;
  dd.update(0.5, {});
  ok(dodgeOk && dd.state === 'flee' && scratch, `dt 0.5 s：閃避當次仍輸出側跳、下次轉 flee、閃避方向重用暫存（${dd.state}）`);
  const hs = new NpcBrain({ actor: mockActor('dt-horn', 0.3, 8) });
  hs.hear({ type: 'horn', x: 0, z: 0, dirX: 0, dirZ: 1 });
  const ih = hs.update(1, {});
  ok(hs.state === 'sidestep' && ih.moveX > 0.99 && ih.jump, 'dt 1 s：喇叭側跳當次仍輸出移動意圖');
  for (const dt of [0.1, 0.25]) {
    const f = new NpcBrain({ actor: mockActor(`dt-flee-${dt}`, 0, 0) });
    f.watches = false;
    f.onWitness({ x: 1, z: 0 });
    let t = 0;
    do {
      f.update(dt, {});
      t += dt;
    } while (f.state === 'flee' && t < 30);
    ok(t >= FLEE_MIN_TIME - 1e-9 && t <= FLEE_MAX_TIME + dt + 1e-9, `dt ${dt} s 呼叫：逃跑 ${t.toFixed(2)} s 後回 wander（${FLEE_MIN_TIME}–${FLEE_MAX_TIME} s + 一個 dt）`);
  }

  // 效能：120 人（1/4 逃跑中、若干還手 / 圍觀），每幀全部 think + 2 台高速車 + 偶發喇叭 / 事件
  clock = 0;
  const sys = new CombatSystem({ now });
  const player = mockActor('player', 0, 0, 0, { kind: 'player' });
  sys.register(player);
  const brains = new Map();
  for (let i = 0; i < 120; i++) {
    const b = new NpcBrain({ actor: mockActor(`perf-${i}`, ((i % 12) - 6) * 3, (Math.floor(i / 12) - 5) * 3), heavy: i % 3 === 2 });
    brains.set(b.actor.id, b);
    sys.register(b.actor);
  }
  wireCombatToBrains(sys, brains);
  const list = [...brains.values()];
  list.forEach((b, i) => {
    if (i % 4 === 0) b.onAttacked({ attacker: player });
  });
  const vehicles = [
    { x: -20, z: 0, vx: 12, vz: 0 },
    { x: 0, z: -20, vx: 0, vz: 10 },
  ];
  const ctx = { combat: sys, playerInVehicle: false, vehicles };
  const intents = list.map((b) => b.intent);
  const FR = 1200;
  let ms = 0;
  let maxMs = 0;
  for (let f = 0; f < FR; f++) {
    clock += FRAME;
    for (const v of vehicles) {
      v.x += v.vx * FRAME;
      v.z += v.vz * FRAME;
      if (v.x > 20) v.x = -20;
      if (v.z > 20) v.z = -20;
    }
    if (f % 120 === 0) for (const b of list) b.hear({ type: 'horn', x: vehicles[0].x, z: vehicles[0].z, dirX: 1, dirZ: 0 });
    if (f === 300) sys.onVehicleHit({ ped: list[60].actor, impulse: { x: 0, y: 0, z: 1 }, relSpeed: 7, vehicle: { pos: { x: 0, z: 0 } } });
    const t0 = performance.now();
    for (const b of list) {
      const i = b.update(FRAME, ctx);
      const p = b.actor.pos;
      p.x += i.moveX * (i.run ? 4 : 1.4) * FRAME;
      p.z += i.moveZ * (i.run ? 4 : 1.4) * FRAME;
    }
    const dtMs = performance.now() - t0;
    if (f >= 60) {
      ms += dtMs;
      maxMs = Math.max(maxMs, dtMs);
    }
    sys.update(FRAME);
  }
  const avg = ms / (FR - 60);
  const modes = {};
  for (const b of list) modes[b.state] = (modes[b.state] || 0) + 1;
  console.log(`INFO  效能（node）：120 名行人每幀全部 think，平均 ${avg.toFixed(4)} ms、最大 ${maxMs.toFixed(3)} ms；結束時狀態 ${JSON.stringify(modes)}`);
  ok(avg < 0.5, `120 名行人 think 每幀平均 ${avg.toFixed(4)} ms（< 0.5 ms）`);
  ok(list.every((b, i) => b.intent === intents[i]), '意圖物件每幀重用（不重新配置）');
}

// ---------- 12. Phase 4：applyHit（bat / bullet 去重、側向、擊倒門檻、倒地中不受擊）、拳擊 hit 新欄位、knockdownActor ----------
{
  clock = 0;
  const sys = new CombatSystem({ now });
  const a = mockActor('p', 0, 0, 0, { kind: 'player' });
  const f = mockActor('f', 0, 1, Math.PI); // 迎面
  const k = mockActor('k', 0, 2, 0); // 背對攻擊者
  for (const x of [a, f, k]) sys.register(x);
  const hits = [];
  const kds = [];
  sys.on('hit', (e) => hits.push(e));
  sys.on('knockdown', (e) => kds.push(e));
  // 拳擊路徑的 hit 事件補欄位
  punch(sys, a);
  const ph = hits[0];
  ok(ph && ph.weapon === 'fist' && ph.side === 'front' && ph.byPlayer === true && ph.knockdown === false && Number.isFinite(ph.x) && Number.isFinite(ph.y) && Number.isFinite(ph.z) && ph.dirZ === 1,
    "拳擊 'hit' 補 weapon fist / side / x,y,z / dir / byPlayer / knockdown");
  // 棒擊去重：同 swingId 對同一人只傷一次，換 swingId 再傷
  clock += 1;
  sys.update(0);
  const s1 = sys.newSwingId();
  const r1 = sys.applyHit({ attacker: a, target: k, damage: 35, weapon: 'bat', dir: { x: 0, z: 1 }, swingId: s1 });
  const r2 = sys.applyHit({ attacker: a, target: k, damage: 35, weapon: 'bat', dir: { x: 0, z: 1 }, swingId: s1 });
  ok(r1 && r2 === null && k.hp === 65 && r1.side === 'back', `棒擊同一揮只傷一次、背後 side back（hp=${k.hp}）`);
  ok(k.anim.count('hit') === 1, "背後受擊 anim.trigger('hit', { side })");
  clock += 0.6;
  sys.update(0);
  const r3 = sys.applyHit({ attacker: a, target: k, damage: 35, weapon: 'bat', dir: { x: 0, z: 1 }, swingId: sys.newSwingId() });
  ok(r3 && r3.knockdown && kds.at(-1).cause === 'bat' && kds.at(-1).weapon === 'bat' && sys.stateOf(k) === 'knockdown', '棒擊 4 s 內第 2 下 → 擊倒 cause bat');
  ok(sys.applyHit({ attacker: a, target: k, damage: 35, weapon: 'bat', dir: { x: 0, z: 1 }, swingId: sys.newSwingId() }) === null && k.hp === 30, '倒地中不再受擊');
  // 子彈：同一發去重、1.5 s 內 2 發擊倒；間隔 1.6 s 不倒
  clock += 5;
  sys.update(0);
  const g = mockActor('g', 0, 5, Math.PI);
  g.hp = g.maxHp = 300;
  sys.register(g);
  const sid = sys.newSwingId();
  sys.applyHit({ attacker: a, target: g, damage: 40, weapon: 'pistol', dir: { x: 0, z: 1 }, swingId: sid });
  ok(sys.applyHit({ attacker: a, target: g, damage: 40, weapon: 'pistol', dir: { x: 0, z: 1 }, swingId: sid }) === null && g.hp === 260, '子彈同一發只計一次');
  clock += 1.6;
  sys.update(0);
  const r4 = sys.applyHit({ attacker: a, target: g, damage: 40, weapon: 'pistol', dir: { x: 0, z: 1 }, swingId: sys.newSwingId() });
  ok(r4 && !r4.knockdown, '子彈 2 發間隔 1.6 s → 不倒');
  clock += 1.0;
  sys.update(0);
  const r5 = sys.applyHit({ attacker: a, target: g, damage: 40, weapon: 'pistol', dir: { x: 0, z: 1 }, swingId: sys.newSwingId() });
  ok(r5 && r5.knockdown && kds.at(-1).cause === 'bullet', '子彈 1.5 s 內第 2 發 → 擊倒 cause bullet');
  const pk = pedKnockdownPayload(kds.at(-1));
  ok(pk.cause === 'bullet' && pk.weapon === 'pistol', 'ped:knockdown cause bullet / weapon pistol');
  // hp 歸零：單發擊倒
  const z = mockActor('z', 0, 3);
  z.hp = 10;
  sys.register(z);
  ok(sys.applyHit({ attacker: a, target: z, damage: 40, weapon: 'pistol', dir: { x: 0, z: 1 } }).knockdown && z.hp === 0, 'hp 歸零 → 單發擊倒');
  ok(hitSide(0, 0, 1) === 'back' && hitSide(Math.PI, 0, 1) === 'front', 'hitSide：面向 · 攻擊方向 > 0 = back');
  // knockdownActor：取代直接改 entries
  const d = mockActor('d', 9, 9);
  sys.register(d);
  const n = kds.length;
  ok(sys.knockdownActor(d) && sys.stateOf(d) === 'knockdown' && kds.length === n && d.anim.count('knockdown') === 1 && sys.knockdownActor(d) === false, 'knockdownActor：倒地、不發事件、重複呼叫 false');
}

// ---------- 13. Phase 4：槍聲 30 m 內逃跑、被槍擊不還手 ----------
{
  clock = 0;
  const sys = new CombatSystem({ now });
  const p = mockActor('p', 0, 0, 0, { kind: 'player' });
  sys.register(p);
  const near = new NpcBrain({ actor: mockActor('gn', 20, 0) });
  const out = new NpcBrain({ actor: mockActor('go', GUNSHOT_RADIUS + 1, 0) });
  near.hear({ type: 'gunshot', x: 0, z: 0 });
  out.hear({ type: 'gunshot', x: 0, z: 0 });
  near.update(FRAME, { combat: sys });
  out.update(FRAME, { combat: sys });
  ok(near.state === 'flee' && out.state === 'wander', `槍聲 ${GUNSHOT_RADIUS} m 內逃跑、外不理`);
  let brave = null;
  for (let i = 0; i < 300 && !brave; i++) {
    const b = new NpcBrain({ actor: mockActor(`gb${i}`, 0, 1, Math.PI) });
    if (b.fights) brave = b;
  }
  sys.register(brave.actor);
  wireCombatToBrains(sys, new Map([[brave.actor.id, brave]]));
  sys.applyHit({ attacker: p, target: brave.actor, damage: 10, weapon: 'pistol', dir: { x: 0, z: 1 } });
  brave.update(FRAME, { combat: sys });
  ok(brave.state === 'flee', '會還手的人被槍擊 → 逃跑（不還手）');
  const brave2 = new NpcBrain({ actor: brave.actor });
  wireCombatToBrains(sys, new Map([[brave.actor.id, brave2]]));
  clock += 1;
  sys.update(0);
  sys.applyHit({ attacker: p, target: brave.actor, damage: 10, weapon: 'bat', dir: { x: 0, z: 1 } });
  brave2.update(FRAME, { combat: sys });
  ok(brave2.state === 'fight', '同一人被棒擊 → 照一般被打（還手）');
}

console.log(`combat.mjs：通過 ${pass} / ${total}`);
for (const m of fails) console.log(`  ✗ ${m}`);
console.log(fails.length ? `FAIL ${fails.length}/${total}` : `PASS ${pass}/${total}`);
if (fails.length) process.exit(1);
