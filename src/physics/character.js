// 角色膠囊：Rapier KinematicCharacterController（取代 player.js 的貼地高度 + 2D 圓形推出）
// 腳底 y 語意與 player.pos.y 相同：膠囊中心 = 腳底 + halfHeight + radius + OFFSET
// （OFFSET 是控制器與障礙物保持的間隙，膠囊實際懸在地面上方 OFFSET，扣回後腳底 ≈ 地面）
// move() 必須每個物理子步呼叫一次、且在 world.step() 之前（掛 physicsWorld.onBeforeStep）：
// 控制器以 collider 目前位置計算，位移用 setNextKinematicTranslation 交給下一次 step 套用
import { GROUPS, WORLD, VEHICLE, NPC_CAR, PEDESTRIAN, DEBRIS, queryGroups } from './groups.js';

// 手感常數：抄自 src/player.js（WALK_SPEED / RUN_SPEED / ACCEL / JUMP_SPEED / GRAVITY / PLAYER_RADIUS）
export const WALK_SPEED = 4.2;
export const RUN_SPEED = 8.5;
export const ACCEL = 24;
export const JUMP_SPEED = 6.5;
export const GRAVITY = 22; // 角色自己的重力（m/s²），比世界 9.81 重，沿用既有跳躍手感
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
    this.pos = { x, y: y + this.lift, z }; // 膠囊中心（下一步的目標位置）
    this.result = { x, y, z, grounded: false, groundNormal: { x: 0, y: 1, z: 0 }, speed: 0, vy: 0 };
    this._collision = null;
  }

  // moveX / moveZ：世界座標的移動方向（長度 0..1，類比搖桿量；呼叫端先依鏡頭旋轉）
  // jump：本步要起跳（邊緣觸發由呼叫端處理）；run：跑步
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
    const target = mag > 0 ? (run ? RUN_SPEED : WALK_SPEED) * mag : 0;
    // 平滑加減速（與 player.js 相同公式）
    const k = Math.min(1, (ACCEL * dt) / Math.max(target, WALK_SPEED));
    this.vx += (wx * target - this.vx) * k;
    this.vz += (wz * target - this.vz) * k;

    if (this.grounded && jump) this.vy = JUMP_SPEED;
    else if (this.grounded && this.vy <= 0) this.vy = GROUND_STICK_VY;
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
