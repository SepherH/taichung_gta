// 無頭驗證 src/combat.js 與 src/npc-ai.js：mock actor / anim / body，手動推進時間
// 用法：node tools/test/combat.mjs [-v 列出每項斷言]（任一斷言失敗 exit 1）
import { CombatSystem, PUNCH_DAMAGE, GETUP_MIN_DOWN, GETUP_TIMEOUT, DEAD_HOLD } from '../../src/combat.js';
import { NpcBrain, wireCombatToBrains, FIGHT_PUNCH_MIN, FIGHT_PUNCH_MAX } from '../../src/npc-ai.js';

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
    trigger(name) {
      this.triggers.push(name); // state 由測試手動設定（例如 drive），模擬動畫播完已回 idle
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
    ['太遠', 0, 1.3, 0],
    ['高度差', 0, 0.8, 1.2],
    ['側面 60°', Math.sin(Math.PI / 3) * 0.8, Math.cos(Math.PI / 3) * 0.8, 0],
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
  ok(witness.state === 'flee', '8 m 內目擊 → flee');
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

console.log(`combat.mjs：通過 ${pass} / ${total}`);
if (fails.length) {
  for (const m of fails) console.log(`  ✗ ${m}`);
  process.exit(1);
}
