// 角色膠囊：Rapier KinematicCharacterController（取代 player.js 的貼地高度 + 2D 圓形推出）
// 腳底 y 語意與 player.pos.y 相同：膠囊中心 = 腳底 + halfHeight + radius + OFFSET
// （OFFSET 是控制器與障礙物保持的間隙，膠囊實際懸在地面上方 OFFSET，扣回後腳底 ≈ 地面）
// move() 必須每個物理子步呼叫一次、且在 world.step() 之前（掛 physicsWorld.onBeforeStep）：
// 控制器以 collider 目前位置計算，位移用 setNextKinematicTranslation 交給下一次 step 套用
import { GROUPS, WORLD, VEHICLE, NPC_CAR, PEDESTRIAN, DEBRIS, queryGroups } from './groups.js';

// 手感常數（player.js 由此 import，單一來源）：
// - 走 4.2 m/s、衝刺 7.0 m/s；靜止 → 走速 WALK_SPEED / ACCEL = 0.5 s，走速 → 衝刺頂速再 (RUN − WALK) / SPRINT_ACCEL = 1.0 s（合計 1.5 s）
// - 放開搖桿 / 鍵：以 DECEL 線性減速，衝刺頂速 7.0 / 24 ≈ 0.29 s、走速 ≈ 0.18 s 停下（加速與減速分開）
// - 轉向：速度方向以 TURN_VEL_RATE 旋轉、速率保留（衝刺中轉彎不掉速）；與目前方向夾角 > REVERSE_ANGLE 時先煞車再掉頭
export const WALK_SPEED = 4.2;
export const RUN_SPEED = 7.0;
export const ACCEL = 8.4; // 0 → 走速的加速度（m/s²）
export const SPRINT_ACCEL = 2.8; // 走速 → 衝刺頂速的加速度（m/s²）
export const DECEL = 24; // 放開 / 超速 / 掉頭煞車的減速度（m/s²）
export const TURN_VEL_RATE = 10; // 速度方向旋轉速率（rad/s，90° 約 0.16 s）
export const REVERSE_ANGLE = (120 * Math.PI) / 180; // 超過此夾角視為掉頭：先煞車
export const TURN_SNAP_SPEED = 0.5; // 低於此速率直接改成期望方向（m/s）
export const GRAVITY = 22; // 角色自己的重力（m/s²），比世界 9.81 重，沿用既有跳躍手感
// 跳高 0.94 m：以固定物理步長 PHYSICS_STEP 的離散積分（起跳步先位移、之後每步先扣重力再位移）求初速，
// 實際頂點 ≈ v²/(2g) + v·dt/2 = JUMP_HEIGHT（連續公式 v²/(2g) 約 0.89 m，差的是離散步長的半步位移）
export const JUMP_HEIGHT = 0.94;
export const PHYSICS_STEP = 1 / 60; // 與 PhysicsWorld 預設 step 相同
export const JUMP_SPEED = -(GRAVITY * PHYSICS_STEP) / 2 + Math.sqrt(((GRAVITY * PHYSICS_STEP) / 2) ** 2 + 2 * GRAVITY * JUMP_HEIGHT);
export const COYOTE_TIME = 0.12; // 離開地面後仍可起跳的秒數
export const JUMP_BUFFER = 0.15; // 落地前按跳的緩衝秒數（落地時自動起跳）
export const RADIUS = 0.35; // player.js PLAYER_RADIUS
export const HALF_HEIGHT = 0.55; // 膠囊圓柱段半高：總高 = 2 × (0.55 + 0.35) = 1.8 m

// 控制器參數（本單元規格）
export const OFFSET = 0.02;
export const AUTOSTEP_MAX_HEIGHT = 0.35;
export const AUTOSTEP_MIN_WIDTH = 0.2;
export const MAX_SLOPE_CLIMB = (45 * Math.PI) / 180;
export const MIN_SLOPE_SLIDE = (50 * Math.PI) / 180;
export const SNAP_TO_GROUND = 0.5;

const GROUND_STICK_VY = -1; // 落地時保持的小向下速度（m/s），讓 grounded 判定與 snap 穩定
const FREE_SPOT_RING = 0.6; // findFreeSpot 環狀取樣間距（m）
const FREE_SPOT_ANGLES = 12;
const FREE_SPOT_PROBE_UP = 2; // 從期望高度上方 2 m 往下找地面
const FREE_SPOT_PROBE_DOWN = 6;
const FREE_SPOT_LIFT = 0.05; // 重疊檢查時膠囊再抬高 0.05 m，避免與地面接觸被判為重疊
const OBSTACLE_MASK = WORLD | VEHICLE | NPC_CAR | PEDESTRIAN | DEBRIS; // 下車點不可重疊的組

// 擊退 / 衝步位移 → 初速：鎖移動（目標速度 0）時以 DECEL 線性減速；move() 每步先減速再位移，
// 固定步長 dt 下位移 ≈ v0² / (2·DECEL) − v0·dt / 2，解出 v0 = a·dt/2 + √((a·dt/2)² + 2·a·位移)（a = DECEL）
export function speedForDistance(dist) {
  if (!(dist > 0)) return 0;
  const h = (DECEL * PHYSICS_STEP) / 2;
  return h + Math.sqrt(h * h + 2 * DECEL * dist);
}

// 水平速度一步（v = { vx, vz } 就地修改）：wishX / wishZ 為單位方向（無輸入給 0, 0），target 為目標速率（m/s）
export function stepVelocity(v, dt, wishX, wishZ, target) {
  let s = Math.hypot(v.vx, v.vz);
  if (!(target > 0) || (wishX === 0 && wishZ === 0)) {
    // 放開：線性減速到 0
    const ns = Math.max(0, s - DECEL * dt);
    const k = s > 1e-9 ? ns / s : 0;
    v.vx *= k;
    v.vz *= k;
    return v;
  }
  let dx = wishX;
  let dz = wishZ;
  if (s >= TURN_SNAP_SPEED) {
    const cx = v.vx / s;
    const cz = v.vz / s;
    const ang = Math.atan2(cx * wishZ - cz * wishX, cx * wishX + cz * wishZ); // 目前 → 期望的有號夾角
    if (Math.abs(ang) > REVERSE_ANGLE) {
      // 掉頭：保持原方向煞車，降到 TURN_SNAP_SPEED 以下才轉向
      s = Math.max(0, s - DECEL * dt);
      v.vx = cx * s;
      v.vz = cz * s;
      return v;
    }
    const rot = Math.sign(ang) * Math.min(Math.abs(ang), TURN_VEL_RATE * dt);
    const c = Math.cos(rot);
    const sn = Math.sin(rot);
    // (x, z) 平面旋轉 rot：cross(d, d') = sin(rot)，與 ang 同號即朝期望方向轉
    dx = cx * c - cz * sn;
    dz = cx * sn + cz * c;
  }
  // 速率：低於走速用 ACCEL、走速以上用 SPRINT_ACCEL（跨過走速的那一步分段計算）；超過目標以 DECEL 降回
  if (s < target) {
    let t = dt;
    if (s < WALK_SPEED) {
      const need = (Math.min(target, WALK_SPEED) - s) / ACCEL;
      if (need >= t) {
        s += ACCEL * t;
        t = 0;
      } else {
        s = Math.min(target, WALK_SPEED);
        t -= need;
      }
    }
    if (t > 0 && s < target) s = Math.min(target, s + SPRINT_ACCEL * t);
  } else {
    s = Math.max(target, s - DECEL * dt);
  }
  v.vx = dx * s;
  v.vz = dz * s;
  return v;
}

// 跳躍輔助（coyote time + 輸入緩衝）：每個移動步呼叫一次
// st = { buf（剩餘緩衝秒）, air（離地秒數）, ready（落地後尚未起跳）}；pressed = 本步按了跳；grounded = 上一步結束時是否著地
// gate（可省略）：真的要起跳時呼叫，回傳 false 則不跳（緩衝保留到逾時）；回傳本步是否起跳
export function jumpStep(st, dt, pressed, grounded, gate = null) {
  if (pressed) st.buf = JUMP_BUFFER;
  let jumped = false;
  if (st.buf > 0 && st.ready && (grounded || st.air <= COYOTE_TIME) && (!gate || gate())) {
    jumped = true;
    st.buf = 0;
    st.ready = false;
  }
  if (!jumped) st.buf = Math.max(0, st.buf - dt);
  return jumped;
}

// 移動步結束時更新離地計時（著地且非上升中 → 可再次起跳）
export function jumpLand(st, dt, grounded, vy) {
  if (grounded) {
    st.air = 0;
    if (vy <= 0) st.ready = true;
  } else {
    st.air += dt;
  }
}

export function createJumpState() {
  return { buf: 0, air: Infinity, ready: true }; // air = Infinity：尚未著地前不給 coyote
}

export class CharacterBody {
  constructor(RAPIER, physicsWorld, { radius = RADIUS, halfHeight = HALF_HEIGHT, groups = GROUPS.PLAYER, x = 0, y = 0, z = 0 } = {}) {
    this.RAPIER = RAPIER;
    this.pw = physicsWorld;
    this.radius = radius;
    this.halfHeight = halfHeight;
    this.groups = groups;
    this.lift = halfHeight + radius + OFFSET; // 腳底 → 膠囊中心
    const w = physicsWorld.world;
    this.body = physicsWorld.createBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, y + this.lift, z), false);
    this.shape = new RAPIER.Capsule(halfHeight, radius);
    this.collider = w.createCollider(RAPIER.ColliderDesc.capsule(halfHeight, radius).setCollisionGroups(groups).setSolverGroups(groups), this.body);
    const c = w.createCharacterController(OFFSET);
    c.setUp({ x: 0, y: 1, z: 0 });
    c.enableAutostep(AUTOSTEP_MAX_HEIGHT, AUTOSTEP_MIN_WIDTH, false);
    c.setMaxSlopeClimbAngle(MAX_SLOPE_CLIMB);
    c.setMinSlopeSlideAngle(MIN_SLOPE_SLIDE);
    c.enableSnapToGround(SNAP_TO_GROUND);
    c.setApplyImpulsesToDynamicBodies(true);
    c.setSlideEnabled(true);
    this.controller = c;
    this.handle = physicsWorld.register(this.body);
    this.vx = 0;
    this.vy = 0;
    this.vz = 0;
    this.grounded = false;
    this.enabled = true;
    this.jumpState = createJumpState();
    this.jumpGate = null; // 起跳前的許可（呼叫端注入，例如 player 的「動畫接受 jump」）；null = 一律允許
    this.jumps = 0; // 累計起跳次數（呼叫端比對前後值得知本幀是否起跳）
    this.pos = { x, y: y + this.lift, z }; // 膠囊中心（下一步的目標位置）
    this.result = { x, y, z, grounded: false, groundNormal: { x: 0, y: 1, z: 0 }, speed: 0, vy: 0 };
    this._collision = null;
  }

  // moveX / moveZ：世界座標的移動方向（長度 0..1，類比搖桿量；呼叫端先依鏡頭旋轉）
  // jump：本步按了跳（邊緣觸發由呼叫端處理；coyote time 與輸入緩衝在此處理）；run：衝刺
  move(dt, { moveX = 0, moveZ = 0, jump = false, run = false } = {}) {
    const r = this.result;
    if (!this.enabled) return r;
    let mag = Math.hypot(moveX, moveZ);
    let wx = 0;
    let wz = 0;
    if (mag > 1e-6) {
      wx = moveX / mag;
      wz = moveZ / mag;
      mag = Math.min(1, mag);
    }
    const target = mag > 1e-6 ? (run ? RUN_SPEED : WALK_SPEED) * mag : 0;
    // 加速 / 減速 / 轉向（與 player.js 無物理模式共用 stepVelocity）
    stepVelocity(this, dt, wx, wz, target);

    if (jumpStep(this.jumpState, dt, jump, this.grounded, this.jumpGate)) {
      this.vy = JUMP_SPEED;
      this.jumps++;
    } else if (this.grounded && this.vy <= 0) this.vy = GROUND_STICK_VY;
    else this.vy -= GRAVITY * dt;

    const desired = { x: this.vx * dt, y: this.vy * dt, z: this.vz * dt };
    const c = this.controller;
    c.computeColliderMovement(this.collider, desired, this.RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, this.groups);
    const mv = c.computedMovement();
    const grounded = c.computedGrounded();

    // 地面法線：本步碰撞中最朝上的那個
    let nx = 0;
    let ny = 1;
    let nz = 0;
    let best = -Infinity;
    const n = c.numComputedCollisions();
    for (let i = 0; i < n; i++) {
      const col = c.computedCollision(i, this._collision || undefined);
      if (!col) continue;
      this._collision = col;
      if (col.normal1.y > best) {
        best = col.normal1.y;
        nx = col.normal1.x;
        ny = col.normal1.y;
        nz = col.normal1.z;
      }
    }
    if (!grounded || best <= 0) {
      nx = 0;
      ny = 1;
      nz = 0;
    }
    // 撞到天花板：上升速度歸零
    if (this.vy > 0 && mv.y < desired.y - 1e-4) this.vy = 0;
    this.grounded = grounded;
    if (grounded && this.vy < 0) this.vy = 0;
    jumpLand(this.jumpState, dt, grounded, this.vy);

    const t = this.body.translation();
    this.pos.x = t.x + mv.x;
    this.pos.y = t.y + mv.y;
    this.pos.z = t.z + mv.z;
    this.body.setNextKinematicTranslation(this.pos);

    r.x = this.pos.x;
    r.y = this.pos.y - this.lift;
    r.z = this.pos.z;
    r.grounded = grounded;
    r.groundNormal.x = nx;
    r.groundNormal.y = ny;
    r.groundNormal.z = nz;
    r.speed = dt > 0 ? Math.hypot(mv.x, mv.z) / dt : 0;
    r.vy = this.vy;
    return r;
  }

  // 上車時停用（剛體與膠囊一併停用，不再擋車也不被查詢命中）
  setEnabled(on) {
    this.enabled = on;
    this.body.setEnabled(on);
    this.vx = 0;
    this.vy = 0;
    this.vz = 0;
    this.grounded = false;
    this.jumpState = createJumpState();
  }

  // 清掉跳躍緩衝（受擊 / 倒地等鎖移動時呼叫，避免解鎖後自動起跳）
  cancelJump() {
    this.jumpState.buf = 0;
  }

  // 瞬移（y = 腳底）；插值狀態同步重設
  teleport(x, y, z) {
    this.pos.x = x;
    this.pos.y = y + this.lift;
    this.pos.z = z;
    this.body.setTranslation(this.pos, true);
    this.body.setNextKinematicTranslation(this.pos);
    this.pw.world.propagateModifiedBodyPositionsToColliders();
    this.vx = 0;
    this.vy = 0;
    this.vz = 0;
    this.grounded = false;
    this.jumpState = createJumpState();
    this.handle.reset();
    const r = this.result;
    r.x = x;
    r.y = y;
    r.z = z;
    r.grounded = false;
  }

  // 找 (x, z) 附近 radius 內無碰撞的站立點（下車用）：
  // 由近到遠環狀取樣 → 每點往下 castRay 找地面（只找 WORLD）→ 在地面上放膠囊做 intersection 檢查
  // 回傳 { x, y(腳底), z } 或 null
  findFreeSpot(x, y, z, radius = 3) {
    const pw = this.pw;
    const groundQ = queryGroups(WORLD);
    const obstacleQ = queryGroups(OBSTACLE_MASK);
    const rot = { x: 0, y: 0, z: 0, w: 1 };
    const down = { x: 0, y: -1, z: 0 };
    const tryAt = (px, pz) => {
      const hit = pw.castRay({ x: px, y: y + FREE_SPOT_PROBE_UP, z: pz }, down, FREE_SPOT_PROBE_UP + FREE_SPOT_PROBE_DOWN, {
        groups: groundQ,
        flags: this.RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
        excludeCollider: this.collider,
      });
      if (!hit || hit.ny < Math.cos(MAX_SLOPE_CLIMB)) return null;
      const center = { x: px, y: hit.y + this.lift + FREE_SPOT_LIFT, z: pz };
      const n = pw.intersections(center, rot, this.shape, () => false, {
        groups: obstacleQ,
        flags: this.RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
        excludeCollider: this.collider,
      });
      return n === 0 ? { x: px, y: hit.y, z: pz } : null;
    };
    const first = tryAt(x, z);
    if (first) return first;
    for (let d = FREE_SPOT_RING; d <= radius + 1e-6; d += FREE_SPOT_RING) {
      const m = Math.max(FREE_SPOT_ANGLES, Math.round((2 * Math.PI * d) / FREE_SPOT_RING));
      for (let i = 0; i < m; i++) {
        const a = (i / m) * Math.PI * 2;
        const s = tryAt(x + Math.cos(a) * d, z + Math.sin(a) * d);
        if (s) return s;
      }
    }
    return null;
  }

  dispose() {
    this.pw.unregister(this.handle);
    this.pw.world.removeCharacterController(this.controller);
    this.pw.world.removeRigidBody(this.body);
  }
}
