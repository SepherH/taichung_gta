#!/usr/bin/env node
// A2 角色手感無頭驗證：node tools/test/player-feel.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 不需要 Rapier：以 mock RAPIER / PhysicsWorld 建真的 CharacterBody（src/physics/character.js），
//   mock 角色控制器 = 無障礙物、腳底不低於地面函式 groundAt(x, z)（含 snap-to-ground），move() 內的加減速 / 跳躍邏輯照常執行
// 項目：走速 / 衝刺加速時間與頂速、放開停止時間、轉向（保速轉彎、掉頭先煞車）、類比搖桿、跳高（數值與解析）、
//   coyote time、跳躍輸入緩衝、不可二段跳、jumpGate；Player 層：擊退位移、鎖移動清緩衝、跳躍動畫觸發、小衝步位移；
//   與 animator 走 / 跑門檻與播放速率相容；mousePunchListener 仍匯出；Phase 4：speedScale（heavy 委託步行速度倍率）、weaponLayer 每幀更新
import { register } from 'node:module';

const JSON_HOOK = `
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function load(url, context, next) {
  if (url.endsWith('.json')) {
    return { format: 'module', shortCircuit: true, source: 'export default ' + readFileSync(fileURLToPath(url), 'utf8') + ';' };
  }
  return next(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(JSON_HOOK)}`, import.meta.url);

// 2D canvas 最小替身（方塊人退路 / 其他模組建立 canvas 時用）
const ctx2d = new Proxy({}, {
  get: (_, k) => (k === 'measureText' ? () => ({ width: 100 }) : () => {}),
  set: () => true,
});
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d, style: {} }),
};

const THREE = await import('three');
const CH = await import('../../src/physics/character.js');
const { Player, mousePunchListener } = await import('../../src/player.js');
const { RUN_ABOVE, RATE_MAX, WALK_RATE_MAX } = await import('../../src/characters/animator.js');

const DT = CH.PHYSICS_STEP;

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : String(v));

// ---------- mock RAPIER / PhysicsWorld ----------
let groundAt = () => 0;
const SNAP = CH.SNAP_TO_GROUND;

function mockBody(t) {
  const cur = { ...t };
  let next = null;
  return {
    translation: () => ({ ...cur }),
    setTranslation(p) {
      Object.assign(cur, p);
    },
    setNextKinematicTranslation(p) {
      next = { ...p };
    },
    setEnabled() {},
    _apply() {
      if (next) Object.assign(cur, next);
      next = null;
    },
    _cur: cur,
  };
}

const RAPIER = {
  RigidBodyDesc: { kinematicPositionBased: () => ({ t: { x: 0, y: 0, z: 0 }, setTranslation(x, y, z) { this.t = { x, y, z }; return this; } }) },
  ColliderDesc: { capsule: () => ({ setCollisionGroups() { return this; }, setSolverGroups() { return this; } }) },
  Capsule: class {},
  QueryFilterFlags: { EXCLUDE_SENSORS: 8 },
};

function mockController(lift) {
  let mv = { x: 0, y: 0, z: 0 };
  let grounded = false;
  let wasGrounded = false;
  return {
    setUp() {},
    enableAutostep() {},
    setMaxSlopeClimbAngle() {},
    setMinSlopeSlideAngle() {},
    enableSnapToGround() {},
    setApplyImpulsesToDynamicBodies() {},
    setSlideEnabled() {},
    computeColliderMovement(collider, d) {
      const t = collider.body.translation();
      const nx = t.x + d.x;
      const nz = t.z + d.z;
      const rest = groundAt(nx, nz) + lift; // 著地時膠囊中心高度
      let ny = t.y + d.y;
      // snap-to-ground：上一步著地、本步不往上、離地 < SNAP → 貼地（同 Rapier enableSnapToGround 的效果）
      if (wasGrounded && d.y <= 0 && ny - rest < SNAP) ny = rest;
      grounded = ny <= rest + 1e-6;
      if (ny < rest) ny = rest;
      wasGrounded = grounded;
      mv = { x: nx - t.x, y: ny - t.y, z: nz - t.z };
    },
    computedMovement: () => mv,
    computedGrounded: () => grounded,
    numComputedCollisions: () => 0,
    computedCollision: () => null,
  };
}

function mockPW() {
  const bodies = [];
  const before = [];
  const pw = {
    alpha: 0,
    world: {
      createCollider: (desc, body) => ({ body }),
      createCharacterController: () => pw._ctrl,
      propagateModifiedBodyPositionsToColliders() {},
      removeCharacterController() {},
      removeRigidBody() {},
    },
    createBody(desc) {
      const b = mockBody(desc.t);
      bodies.push(b);
      return b;
    },
    register(body) {
      return {
        interpolate: () => body._cur,
        reset() {},
      };
    },
    unregister() {},
    onBeforeStep(fn) {
      before.push(fn);
    },
    // 一個物理子步：onBeforeStep → 套用 kinematic 目標位置
    stepOnce() {
      for (const fn of before) fn(DT);
      for (const b of bodies) b._apply();
    },
  };
  return pw;
}

function makeBody(opts = {}) {
  const pw = mockPW();
  const lift = (opts.halfHeight ?? CH.HALF_HEIGHT) + (opts.radius ?? CH.RADIUS) + CH.OFFSET;
  pw._ctrl = mockController(lift);
  const ch = new CH.CharacterBody(RAPIER, pw, { x: 0, y: 0, z: 0, ...opts });
  return { ch, pw };
}

// 以 CharacterBody.move 直接模擬 n 步；input(i, r) 回傳本步意圖；每步後 world 套用位置
function sim(ch, pw, seconds, input, each = null) {
  const n = Math.round(seconds / DT);
  let r = ch.result;
  for (let i = 0; i < n; i++) {
    r = ch.move(DT, typeof input === 'function' ? input(i, r) : input);
    pw.stepOnce();
    if (each && each(i, r) === true) return { r, i };
  }
  return { r, i: n };
}
const hspeed = (ch) => Math.hypot(ch.vx, ch.vz);
const settle = (ch, pw) => sim(ch, pw, 0.3, {});

// 由靜止起步，回傳速率首次 ≥ frac × 目標的秒數
function timeTo(input, target, frac = 0.999) {
  const { ch, pw } = makeBody();
  settle(ch, pw);
  let t = -1;
  sim(ch, pw, 4, input, (i) => {
    if (hspeed(ch) >= target * frac) {
      t = (i + 1) * DT;
      return true;
    }
    return false;
  });
  return t;
}

// ---------- 1. 加速 / 頂速 / 停止 ----------
{
  const tWalk = timeTo({ moveX: 0, moveZ: 1 }, CH.WALK_SPEED);
  check('走速：靜止 → 4.2 m/s 約 0.5 s（±0.05）', Math.abs(tWalk - 0.5) <= 0.05, `${f3(tWalk)} s`);
  const tRun = timeTo({ moveX: 0, moveZ: 1, run: true }, CH.RUN_SPEED);
  check('衝刺：靜止 → 7.0 m/s 約 1.5 s（±0.1）', Math.abs(tRun - 1.5) <= 0.1, `${f3(tRun)} s`);

  const { ch, pw } = makeBody();
  settle(ch, pw);
  let maxS = 0;
  sim(ch, pw, 3, { moveX: 0, moveZ: 1, run: true }, () => {
    maxS = Math.max(maxS, hspeed(ch));
  });
  check('衝刺頂速 = 7.0（不超速）', Math.abs(hspeed(ch) - 7) < 1e-9 && maxS <= 7 + 1e-9, `${f3(hspeed(ch))} / 最大 ${f3(maxS)}`);
  let tStop = -1;
  const z0 = ch.pos.z;
  sim(ch, pw, 1, {}, (i) => {
    if (hspeed(ch) < 1e-6) {
      tStop = (i + 1) * DT;
      return true;
    }
    return false;
  });
  check('衝刺放開：約 0.3 s 內停（0.25–0.32 s）', tStop >= 0.25 && tStop <= 0.32, `${f3(tStop)} s、滑行 ${f3(ch.pos.z - z0)} m`);

  const w = makeBody();
  settle(w.ch, w.pw);
  sim(w.ch, w.pw, 1.5, { moveX: 0, moveZ: 1 });
  const walkTop = hspeed(w.ch);
  let tWStop = -1;
  sim(w.ch, w.pw, 1, {}, (i) => {
    if (hspeed(w.ch) < 1e-6) {
      tWStop = (i + 1) * DT;
      return true;
    }
    return false;
  });
  check('走速頂速 = 4.2；放開 ≤ 0.3 s 停', Math.abs(walkTop - 4.2) < 1e-9 && tWStop > 0 && tWStop <= 0.3, `頂速 ${f3(walkTop)}、停 ${f3(tWStop)} s`);

  // 衝刺放開 Shift（仍按方向）：降回走速
  const s = makeBody();
  settle(s.ch, s.pw);
  sim(s.ch, s.pw, 2, { moveX: 0, moveZ: 1, run: true });
  sim(s.ch, s.pw, 0.3, { moveX: 0, moveZ: 1 });
  check('衝刺中放開 Shift → 0.3 s 內降回走速 4.2', Math.abs(hspeed(s.ch) - 4.2) < 1e-9, f3(hspeed(s.ch)));

  const a = makeBody();
  settle(a.ch, a.pw);
  sim(a.ch, a.pw, 2, { moveX: 0, moveZ: 0.5 });
  check('類比搖桿推一半 → 2.1 m/s', Math.abs(hspeed(a.ch) - 2.1) < 1e-9, f3(hspeed(a.ch)));
}

// ---------- 2. 轉向 ----------
{
  const { ch, pw } = makeBody();
  settle(ch, pw);
  sim(ch, pw, 2, { moveX: 0, moveZ: 1, run: true });
  let t90 = -1;
  let minS = Infinity;
  sim(ch, pw, 1, { moveX: 1, moveZ: 0, run: true }, (i) => {
    minS = Math.min(minS, hspeed(ch));
    const ang = Math.abs(Math.atan2(ch.vz, ch.vx));
    if (ang < (2 * Math.PI) / 180) {
      t90 = (i + 1) * DT;
      return true;
    }
    return false;
  });
  check('衝刺中 90° 轉向：0.2 s 內轉到新方向（±2°）、速率保持 ≥ 6.9', t90 > 0 && t90 <= 0.2 && minS >= 6.9, `${f3(t90)} s、最低 ${f3(minS)} m/s`);

  let tRev = -1;
  let minAlong = Infinity;
  sim(ch, pw, 2, { moveX: -1, moveZ: 0, run: true }, (i) => {
    minAlong = Math.min(minAlong, ch.vx);
    if (ch.vx <= -CH.WALK_SPEED * 0.999) {
      tRev = (i + 1) * DT;
      return true;
    }
    return false;
  });
  // 掉頭：先以 DECEL 煞車（7 / 24 ≈ 0.29 s）再起步到走速（0.5 s）
  check('衝刺中掉頭：先煞車再反向，約 0.8 s 內反向到走速（不走大弧線）', tRev > 0 && tRev <= 0.85 && Math.abs(ch.vz) < 1e-6, `${f3(tRev)} s、橫向 ${f3(ch.vz)}`);
}

// ---------- 3. 跳躍 ----------
{
  const hAnalytic = CH.JUMP_SPEED ** 2 / (2 * CH.GRAVITY) + (CH.JUMP_SPEED * DT) / 2;
  const { ch, pw } = makeBody();
  settle(ch, pw);
  let top = 0;
  let tAir = -1;
  let k = 0;
  sim(ch, pw, 1.5, () => ({ jump: k++ === 0 }), (i, r) => {
    top = Math.max(top, r.y);
    if (i > 0 && r.grounded && tAir < 0) tAir = (i + 1) * DT;
  });
  check('跳高：數值頂點 0.94 ±0.01 m、與解析式 v²/2g + v·dt/2 相差 < 0.01', Math.abs(top - 0.94) < 0.01 && Math.abs(top - hAnalytic) < 0.01, `數值 ${f3(top)}、解析 ${f3(hAnalytic)}、初速 ${f3(CH.JUMP_SPEED)} m/s、滯空 ${f3(tAir)} s`);
  check('跳躍：重力沿用 22 m/s²', CH.GRAVITY === 22);

  // 空中再按跳不會二段跳
  const b = makeBody();
  settle(b.ch, b.pw);
  let n = 0;
  let jumps0 = b.ch.jumps;
  sim(b.ch, b.pw, 1, () => ({ jump: n++ === 0 || n === 10 || n === 20 }));
  check('空中再按跳不會二段跳（起跳次數 1）', b.ch.jumps - jumps0 === 1, `起跳 ${b.ch.jumps - jumps0} 次`);

  // coyote：走下 5 m 落差的平台邊，離地後 t 秒按跳
  const coyote = (delay) => {
    groundAt = (x, z) => (z > 1 ? -5 : 0);
    const c = makeBody();
    settle(c.ch, c.pw);
    // 以走速前進，找離地那一步
    let leave = -1;
    let press = -1;
    let vyAfter = null;
    const j0 = c.ch.jumps;
    sim(c.ch, c.pw, 2, (i) => {
      const jump = leave >= 0 && press < 0 && (i - leave) * DT >= delay - 1e-9;
      if (jump) press = i;
      return { moveX: 0, moveZ: 1, jump };
    }, (i, r) => {
      if (leave < 0 && !r.grounded) leave = i + 1;
      if (press === i) vyAfter = c.ch.vy;
    });
    groundAt = () => 0;
    return { jumped: c.ch.jumps > j0, vyAfter };
  };
  const c1 = coyote(0.1);
  const c2 = coyote(0.2);
  check('coyote：離地 0.10 s 按跳仍起跳、0.20 s 不起跳（窗口 0.12 s）', c1.jumped && c1.vyAfter > 5 && !c2.jumped, `0.10 s → ${c1.jumped}（vy ${f3(c1.vyAfter)}），0.20 s → ${c2.jumped}`);

  // 輸入緩衝：從 2 m 高落下，落地前 lead 秒按跳
  const buffer = (lead) => {
    const d = makeBody();
    d.ch.teleport(0, 2, 0);
    // 先量落地步
    let land = -1;
    const probe = makeBody();
    probe.ch.teleport(0, 2, 0);
    sim(probe.ch, probe.pw, 2, {}, (i, r) => {
      if (r.grounded) {
        land = i;
        return true;
      }
      return false;
    });
    const pressAt = land - Math.round(lead / DT);
    const j0 = d.ch.jumps;
    let jumpStep = -1;
    sim(d.ch, d.pw, 2, (i) => ({ jump: i === pressAt }), (i) => {
      if (jumpStep < 0 && d.ch.jumps > j0) jumpStep = i;
    });
    return { jumped: d.ch.jumps > j0, after: jumpStep - land };
  };
  const b1 = buffer(0.13);
  const b2 = buffer(0.2);
  check('跳躍緩衝：落地前 0.13 s 按跳 → 落地下一步自動起跳；0.20 s 前按不起跳', b1.jumped && b1.after === 1 && !b2.jumped, `0.13 s → ${b1.jumped}（落地後 ${b1.after} 步），0.20 s → ${b2.jumped}`);

  // jumpGate：拒絕時不跳、緩衝保留，窗口內放行就跳
  const g = makeBody();
  settle(g.ch, g.pw);
  let allow = false;
  g.ch.jumpGate = () => allow;
  const j0 = g.ch.jumps;
  sim(g.ch, g.pw, 0.05, (i) => ({ jump: i === 0 }));
  const blocked = g.ch.jumps === j0;
  allow = true;
  sim(g.ch, g.pw, 0.05, {});
  check('jumpGate：拒絕時不跳、緩衝內放行即起跳', blocked && g.ch.jumps === j0 + 1);
  g.ch.jumpGate = null;
  sim(g.ch, g.pw, 1.5, {});
  sim(g.ch, g.pw, 0.02, (i) => ({ jump: i === 0 }));
  g.ch.cancelJump();
  const beforeC = g.ch.jumps;
  // 已起跳（上一行），再按一次後 cancel：確認 cancelJump 清掉緩衝
  sim(g.ch, g.pw, 1.5, {});
  const after1 = g.ch.jumps;
  sim(g.ch, g.pw, 0.01, () => ({ jump: true }));
  const jumpedAgain = g.ch.jumps > after1;
  check('cancelJump 後不殘留自動起跳；著地後可再跳', beforeC === after1 && jumpedAgain);
}

// ---------- 4. Player 層（假 combat + mock CharacterBody）----------
function makePlayer() {
  const scene = new THREE.Scene();
  const player = new Player(scene, { x: 0, z: 0, yaw: 0 });
  const { ch, pw } = makeBody({ radius: 0.35, halfHeight: player.capsuleHalfHeight });
  player.attachPhysics(ch);
  const hitFns = [];
  const combat = {
    state: null,
    register() {},
    on(name, fn) {
      if (name === 'hit') hitFns.push(fn);
    },
    stateOf() {
      return this.state;
    },
    requestPunch: () => true,
    assistTarget: () => null,
  };
  player.attachCombat(combat);
  const input = {
    keys: new Set(),
    pressed: new Set(),
    axis: { x: 0, y: 0 },
    down(c) {
      return this.keys.has(c);
    },
    wasPressed(c) {
      return this.pressed.has(c);
    },
    moveAxis() {
      return this.axis;
    },
  };
  const frame = (n = 1) => {
    for (let i = 0; i < n; i++) {
      player.update(DT, input, 0);
      pw.stepOnce();
      player.syncPhysics(DT);
      input.pressed.clear();
    }
  };
  return { player, ch, pw, combat, hitFns, input, frame };
}

{
  const P = makePlayer();
  P.frame(20);
  // 擊退：knockback 向量長度 = 位移（combat KNOCKBACK_DIST），鎖移動下以 DECEL 滑到停
  const x0 = P.ch.pos.x;
  P.combat.state = 'hit';
  for (const fn of P.hitFns) fn({ attacker: { pos: { x: -5, z: 0 } }, target: P.player.actor, knockback: { x: 1.0, y: 0, z: 0 } });
  P.frame(60);
  const moved = P.ch.pos.x - x0;
  check('擊退位移：knockback 1.0 m → 實際滑行 1.0 ±0.05 m（鎖移動）', Math.abs(moved - 1) < 0.05, `${f3(moved)} m、初速 ${f3(CH.speedForDistance(1))} m/s`);

  // 鎖移動時按跳：不起跳，解鎖後也不自動起跳
  const j0 = P.ch.jumps;
  P.input.pressed.add('Space');
  P.frame(1);
  P.combat.state = null;
  P.frame(15);
  check('鎖移動（受擊）時按跳不起跳、解鎖後不殘留', P.ch.jumps === j0);

  // 正常按跳：真的起跳那一步才觸發 jump 動畫
  P.frame(30);
  P.input.pressed.add('Space');
  P.frame(1);
  const st = P.player.anim.state;
  P.frame(3);
  check('按跳 → 起跳且 jump 動畫觸發一次', P.ch.jumps === j0 + 1 && st === 'jump' && P.ch.vy > 0, `${st} vy=${f3(P.ch.vy)}`);
  P.frame(90);

  // 小衝步：目標 2.3 m 遠（> LUNGE_FROM），放開移動 → 衝步位移 = min(LUNGE_MAX, d − LUNGE_STOP)
  const Q = makePlayer();
  Q.frame(20);
  const target = { pos: { x: 0, z: 2.3 } };
  Q.combat.assistTarget = () => target;
  const z0 = Q.ch.pos.z;
  Q.player.punch();
  Q.frame(60);
  const lunge = Q.ch.pos.z - z0;
  check('出拳小衝步：往 2.3 m 外目標衝 ≈ 1.2 m（LUNGE_MAX，±0.05）', Math.abs(lunge - 1.2) < 0.05, `${f3(lunge)} m`);
}

// ---------- 4b. Phase 4：speedScale（heavy 委託）與武器動畫層 ----------
{
  // 放開跑鍵走直線 3 s → 穩態速度 = 走速 × speedScale
  const steady = (scale, run = false) => {
    const R = makePlayer();
    R.player.speedScale = scale;
    R.input.axis = { x: 0, y: 1 };
    if (run) R.input.keys.add('ShiftLeft');
    R.frame(180);
    return Math.hypot(R.ch.vx, R.ch.vz);
  };
  const v1 = steady(1);
  const v06 = steady(0.6);
  const r06 = steady(0.6, true);
  check('speedScale 0.6：走速 4.2 → 2.52 m/s（±0.05）', Math.abs(v1 - CH.WALK_SPEED) < 0.05 && Math.abs(v06 - CH.WALK_SPEED * 0.6) < 0.05, `${f3(v1)} / ${f3(v06)}`);
  check('speedScale 0.6：衝刺 7.0 → 4.2 m/s（±0.05）', Math.abs(r06 - CH.RUN_SPEED * 0.6) < 0.05, f3(r06));
  const vBad = steady(Number.NaN);
  check('speedScale 非法值（NaN）當 1', Math.abs(vBad - CH.WALK_SPEED) < 0.05, f3(vBad));

  const W = makePlayer();
  const L = W.player.weaponLayer;
  check('Player.weaponLayer 存在（setPose / play / addRecoil / update / on）', !!L && ['setPose', 'play', 'addRecoil', 'update', 'on'].every((k) => typeof L[k] === 'function'));
  let threw = null;
  try {
    L.setPose('pistol_hold');
    L.addRecoil(0.5);
    W.frame(10);
    L.setPose('none');
    W.frame(5);
  } catch (err) {
    threw = err;
  }
  check('武器層隨 syncPhysics 每幀更新不丟例外（缺 clip 時安靜退回）', threw === null, threw ? String(threw) : '');
}

// ---------- 5. 動畫相容 / 匯出 ----------
{
  const HYST = 0.15; // animator.js HYSTERESIS
  check('animator 門檻：走 4.2 < RUN_ABOVE − 遲滯、衝刺 7.0 > RUN_ABOVE', CH.WALK_SPEED < RUN_ABOVE - HYST && CH.RUN_SPEED > RUN_ABOVE, `RUN_ABOVE ${RUN_ABOVE}`);
  const runRate = CH.RUN_SPEED / 5; // run clip 參考速度 5 m/s
  check('衝刺 7.0 → run 播放速率 1.4 ≤ RATE_MAX（步幅與速度一致、無滑步）', runRate <= RATE_MAX, `${f3(runRate)} / 上限 ${RATE_MAX}`);
  const walkRate = Math.min(WALK_RATE_MAX, CH.WALK_SPEED / 1.4);
  console.log(`      參考：走 4.2 m/s 播 walk 速率 ${f3(walkRate)}（上限 ${WALK_RATE_MAX}），步態僅對應 ${f3(1.4 * walkRate)} m/s，滑步比 ${f3(CH.WALK_SPEED / (1.4 * walkRate))}`);
  check('mousePunchListener 仍匯出（deprecated）', typeof mousePunchListener === 'function');
}

const total = passed + failed;
console.log(failed ? `FAIL ${failed}/${total}` : `PASS ${passed}/${total}`);
process.exit(failed ? 1 : 0);
