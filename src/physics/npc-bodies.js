// NPC 物理本體：車流車輛與行人
// 平常是 kinematic（位置由 traffic.js 的車道 / 人行道邏輯每步給目標 pose），被撞才切 dynamic：
// - NPC 車：接觸衝量超過門檻 → dynamic 並施加衝量 → wrecked；N 秒後速度夠低可交還車道邏輯
// - 行人：被車撞 → dynamic 膠囊 + 衝量；settleCheck() 供 D5 倒地起身狀態機判斷何時可起身
// 遠距簡化：setActiveByDistance 停用半徑外的剛體，回到半徑內再啟用（狀態保留）
// 依賴以參數注入（RAPIER、原生 World 或 { world }、collision groups、contacts.js 的 router）；pose 的 y 為地面高度
import { COM_DROP, chassisLayout, deriveVehicleSpec, boxInertia, yawQuat, yawOf, nativeWorld, membershipOf, filterOf, makeGroups } from './vehicle-body.js';

// NPC 車被撞成 wrecked 的接觸衝量門檻（N·s）：約 1400 kg 車輛瞬間 3 m/s 的速度變化，輕碰、推擠不會觸發
export const NPC_WRECK_IMPULSE = 4000;
// wrecked 至少維持的秒數，之後速度低於門檻才可交還車道邏輯
export const NPC_WRECK_MIN_SEC = 4;
export const NPC_RECOVER_SPEED = 0.5;
// NPC 車沒有輪子，dynamic 時以整個車殼著地：底部略離地（代表輪胎）、摩擦高讓殘骸很快停下
const NPC_CAR_CLEARANCE = 0.1;
const NPC_WRECK_FRICTION = 0.9;
const NPC_RESTITUTION = 0.1;
// 衝量施加比例：kinematic 期間 NPC 是無限質量，玩家車已吃下全部反作用；NPC 被推的份量取同量
const NPC_IMPULSE_TRANSFER = 1;

// 行人膠囊（任務契約：半徑 0.3、半高 0.6 → 站高 1.8 m）
export const PED_RADIUS = 0.3;
export const PED_HALF_HEIGHT = 0.6;
// 行人質量（推測：成人平均量級）
export const PED_MASS = 70;
const PED_FRICTION = 0.8;
// 被撞後起身判定：速度低於此值持續指定秒數
export const PED_SETTLE_SPEED = 0.3;
export const PED_SETTLE_SEC = 0.5;
// 被撞飛的速度上限（m/s）與上拋比例：避免高速撞擊把人射出畫面，同時讓人離地翻滾而非貼地滑
const PED_MAX_LAUNCH_SPEED = 12;
const PED_LIFT_RATIO = 0.25;
// 站立檢查時膠囊離地的餘隙與向下找地面的距離
const PED_STAND_EPS = 0.02;
const PED_GROUND_PROBE = 3;
// 行人剛體旋轉模式：yawOnly = 只允許繞 Y 軸轉（不倒，倒地交給動畫）；free = 允許翻滾（由 D5 決定採用哪種）
export const PED_ROTATION_MODES = ['yawOnly', 'free'];

// 遠距簡化：回到半徑內才啟用、超出半徑 + 緩衝才停用，避免在邊界來回切換
export const ACTIVE_RADIUS = 250;
const ACTIVE_HYSTERESIS = 15;

const ZERO = { x: 0, y: 0, z: 0 };
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

function speedOf(body) {
  const v = body.linvel();
  return Math.hypot(v.x, v.y, v.z);
}

// ---- NPC 車 ----

class NpcCarBody {
  constructor(RAPIER, world, spec, pose, { groups = null, router = null } = {}) {
    this.RAPIER = RAPIER;
    this.world = nativeWorld(world);
    this.kind = 'npcCar';
    this.spec = deriveVehicleSpec(spec);
    this.layout = chassisLayout(this.spec, NPC_CAR_CLEARANCE);
    this.router = router;
    this.wrecked = false;
    this.wreckTime = 0;
    this.active = true;
    this.laneVel = { x: 0, y: 0, z: 0 };
    this._last = null;
    this._pending = null;

    const { half, centerY } = this.layout;
    const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(pose.x, pose.y + centerY, pose.z)
      .setRotation(yawQuat(pose.yaw || 0))
      .setAdditionalMassProperties(this.spec.mass, { x: 0, y: -COM_DROP, z: 0 }, boxInertia(this.spec.mass, half), IDENTITY);
    this.body = this.world.createRigidBody(bodyDesc);
    const colDesc = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
      .setDensity(0)
      .setFriction(NPC_WRECK_FRICTION)
      .setRestitution(NPC_RESTITUTION)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS);
    if (groups) colDesc.setCollisionGroups(groups.NPC_CAR).setSolverGroups(groups.NPC_CAR);
    this.collider = this.world.createCollider(colDesc, this.body);
    if (router) router.register(this.collider, this);
  }

  get isWrecked() {
    return this.wrecked;
  }

  // 車道邏輯每步給的目標 pose；dt 用來估算車道速度（被撞切 dynamic 時沿用，不會突然停住）
  setTargetPose(x, y, z, yaw, dt = 0) {
    if (this.wrecked) return;
    const cy = y + this.layout.centerY;
    if (!this.active) {
      this._pending = { x, y: cy, z, yaw };
      return;
    }
    if (this._last && dt > 0) {
      this.laneVel.x = (x - this._last.x) / dt;
      this.laneVel.y = (cy - this._last.y) / dt;
      this.laneVel.z = (z - this._last.z) / dt;
    }
    this._last = { x, y: cy, z };
    this.body.setNextKinematicTranslation({ x, y: cy, z });
    this.body.setNextKinematicRotation(yawQuat(yaw));
  }

  // 撞擊：{ impulse（N·s）, dir（受力方向單位向量）}；超過門檻才 wreck，回傳是否在這次變成 wrecked
  hit({ impulse, dir }) {
    if (this.wrecked || !this.active || impulse < NPC_WRECK_IMPULSE) return false;
    this.wrecked = true;
    this.wreckTime = 0;
    this.body.setBodyType(this.RAPIER.RigidBodyType.Dynamic, true);
    this.body.setLinvel(this.laneVel, true);
    const k = impulse * NPC_IMPULSE_TRANSFER;
    this.body.applyImpulse({ x: dir.x * k, y: dir.y * k, z: dir.z * k }, true);
    return true;
  }

  update(dt) {
    if (this.wrecked) this.wreckTime += dt;
  }

  get canRecover() {
    return this.wrecked && this.wreckTime >= NPC_WRECK_MIN_SEC && speedOf(this.body) < NPC_RECOVER_SPEED;
  }

  // 交還車道邏輯：轉正（只留 yaw）、切回 kinematic；traffic 應以 getPose() 重新對位車道
  recover() {
    if (!this.canRecover) return false;
    const yaw = yawOf(this.body.rotation());
    this.body.setLinvel(ZERO, true);
    this.body.setAngvel(ZERO, true);
    this.body.setRotation(yawQuat(yaw), true);
    this.body.setBodyType(this.RAPIER.RigidBodyType.KinematicPositionBased, true);
    this.wrecked = false;
    this._last = null;
    return true;
  }

  getPose() {
    const t = this.body.translation();
    return { x: t.x, y: t.y - this.layout.centerY, z: t.z, yaw: yawOf(this.body.rotation()) };
  }

  // 停用中剛體不動，位置以車道邏輯最新給的 pose 為準（否則 setActiveByDistance 用舊位置判距，車開回玩家身邊仍是穿透的幽靈車）
  getPosition() {
    return !this.active && this._pending ? this._pending : this.body.translation();
  }

  setActive(on) {
    if (this.active === !!on) return;
    this.active = !!on;
    this.body.setEnabled(this.active);
    if (this.active && this._pending) {
      const p = this._pending;
      this.body.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
      this.body.setRotation(yawQuat(p.yaw), true);
      this._pending = null;
      this._last = null;
    }
  }

  dispose() {
    if (this.router) this.router.unregister(this.collider);
    this.world.removeRigidBody(this.body);
    this.body = null;
    this.collider = null;
  }
}

export function createNpcCar(RAPIER, world, spec, pose, options) {
  return new NpcCarBody(RAPIER, world, spec, pose, options);
}

// ---- 行人 ----

// kinematic 期間的 solver groups：保留碰撞偵測（撞人事件照發），但不跟車輛做實體碰撞，
// 否則 kinematic 的無限質量會讓車子像撞到電線桿一樣瞬間停下
function ghostSolverGroups(groups) {
  const veh = membershipOf(groups.VEHICLE) | membershipOf(groups.NPC_CAR);
  return makeGroups(membershipOf(groups.PEDESTRIAN), filterOf(groups.PEDESTRIAN) & ~veh);
}

class PedestrianBody {
  constructor(RAPIER, world, pose, { groups = null, router = null, rotationMode = 'yawOnly' } = {}) {
    if (!PED_ROTATION_MODES.includes(rotationMode)) throw new Error(`未知的 rotationMode：${rotationMode}`);
    this.RAPIER = RAPIER;
    this.world = nativeWorld(world);
    this.kind = 'pedestrian';
    this.mass = PED_MASS;
    this.groups = groups;
    this.router = router;
    this.rotationMode = rotationMode;
    this.down = false;
    this.active = true;
    this._still = 0;
    this._pending = null;
    this.centerY = PED_HALF_HEIGHT + PED_RADIUS;
    this.standShape = new RAPIER.Capsule(PED_HALF_HEIGHT, PED_RADIUS);

    const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(pose.x, pose.y + this.centerY, pose.z)
      .setRotation(yawQuat(pose.yaw || 0));
    this.body = this.world.createRigidBody(bodyDesc);
    const colDesc = RAPIER.ColliderDesc.capsule(PED_HALF_HEIGHT, PED_RADIUS)
      .setMass(PED_MASS)
      .setFriction(PED_FRICTION)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS | RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS);
    if (groups) colDesc.setCollisionGroups(groups.PEDESTRIAN).setSolverGroups(ghostSolverGroups(groups));
    this.collider = this.world.createCollider(colDesc, this.body);
    if (router) router.register(this.collider, this);
  }

  // kinematic 且不與車輛實體碰撞（contacts.js 以碰撞開始事件估算撞擊衝量）
  get isGhost() {
    return !this.down && !!this.groups;
  }

  get isDown() {
    return this.down;
  }

  setPose(x, y, z, yaw) {
    if (this.down) return;
    const cy = y + this.centerY;
    if (!this.active) {
      this._pending = { x, y: cy, z, yaw };
      return;
    }
    this.body.setNextKinematicTranslation({ x, y: cy, z });
    this.body.setNextKinematicRotation(yawQuat(yaw));
  }

  // 被撞：{ impulse（N·s）, dir（推動方向單位向量）}；第一次撞擊切 dynamic，回傳是否在這次倒下
  hit({ impulse, dir }) {
    if (!this.active) return false;
    const first = !this.down;
    if (first) {
      this.down = true;
      this._still = 0;
      this.body.setBodyType(this.RAPIER.RigidBodyType.Dynamic, true);
      const yawOnly = this.rotationMode === 'yawOnly';
      this.body.setEnabledRotations(!yawOnly, true, !yawOnly, true);
      if (this.groups) this.collider.setSolverGroups(this.groups.PEDESTRIAN);
      this.body.setLinvel(ZERO, true);
    }
    const j = Math.min(impulse, PED_MASS * PED_MAX_LAUNCH_SPEED);
    const h = Math.hypot(dir.x, dir.z) || 1;
    this.body.applyImpulse({ x: (dir.x / h) * j, y: j * PED_LIFT_RATIO, z: (dir.z / h) * j }, true);
    return first;
  }

  // 每個物理步呼叫一次（dt = 物理步長）；settled：速度 < 0.3 m/s 持續 0.5 s；clearToStand：原地站立膠囊無碰撞
  settleCheck(dt = this.world.timestep) {
    if (!this.down) return { settled: true, clearToStand: true };
    if (speedOf(this.body) < PED_SETTLE_SPEED) this._still += dt;
    else this._still = 0;
    const settled = this._still >= PED_SETTLE_SEC;
    return { settled, clearToStand: settled && this._standPose() !== null };
  }

  // 站立膠囊位置（原地、底部貼地）；有東西擋住回傳 null
  _standPose() {
    const RAPIER = this.RAPIER;
    const t = this.body.translation();
    const flags = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
    const ray = new RAPIER.Ray({ x: t.x, y: t.y, z: t.z }, { x: 0, y: -1, z: 0 });
    const ground = this.world.castRay(ray, PED_GROUND_PROBE, true, flags, undefined, this.collider, this.body);
    const groundY = ground ? t.y - ground.timeOfImpact : t.y - PED_RADIUS;
    const pos = { x: t.x, y: groundY + this.centerY + PED_STAND_EPS, z: t.z };
    const blocker = this.world.intersectionWithShape(pos, IDENTITY, this.standShape, flags, undefined, this.collider, this.body);
    return blocker ? null : { x: pos.x, y: groundY, z: pos.z };
  }

  // 起身（D5 在 settled && clearToStand 後呼叫）：回到站立膠囊、切回 kinematic；回傳站立 pose
  recover(yaw = yawOf(this.body.rotation())) {
    const stand = this._standPose();
    if (!stand) return null;
    this.body.setLinvel(ZERO, true);
    this.body.setAngvel(ZERO, true);
    this.body.setEnabledRotations(true, true, true, true);
    this.body.setTranslation({ x: stand.x, y: stand.y + this.centerY, z: stand.z }, true);
    this.body.setRotation(yawQuat(yaw), true);
    this.body.setBodyType(this.RAPIER.RigidBodyType.KinematicPositionBased, true);
    if (this.groups) this.collider.setSolverGroups(ghostSolverGroups(this.groups));
    this.down = false;
    this._still = 0;
    return { ...stand, yaw };
  }

  // 同 NpcCarBody.getPosition：停用中以最新 pose 判距
  getPosition() {
    return !this.active && this._pending ? this._pending : this.body.translation();
  }

  setActive(on) {
    if (this.active === !!on) return;
    this.active = !!on;
    this.body.setEnabled(this.active);
    if (this.active && this._pending) {
      const p = this._pending;
      this.body.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
      this.body.setRotation(yawQuat(p.yaw), true);
      this._pending = null;
    }
  }

  dispose() {
    if (this.router) this.router.unregister(this.collider);
    this.world.removeRigidBody(this.body);
    this.body = null;
    this.collider = null;
  }
}

export function createPedestrianBody(RAPIER, world, pose, options) {
  return new PedestrianBody(RAPIER, world, pose, options);
}

// ---- 遠距簡化 ----

// entities：任何有 getPosition()、setActive(bool)、active 的物件（NPC 車、行人、VehicleBody）
// 回傳本次切換的數量；停用只是 setEnabled(false)，剛體 handle 與狀態（位置、wrecked、倒地）都保留
export function setActiveByDistance(entities, cx, cz, radius = ACTIVE_RADIUS) {
  let activated = 0;
  let deactivated = 0;
  const off2 = (radius + ACTIVE_HYSTERESIS) ** 2;
  const on2 = radius * radius;
  for (const e of entities) {
    const p = e.getPosition();
    const d2 = (p.x - cx) ** 2 + (p.z - cz) ** 2;
    if (e.active && d2 > off2) {
      e.setActive(false);
      deactivated++;
    } else if (!e.active && d2 < on2) {
      e.setActive(true);
      activated++;
    }
  }
  return { activated, deactivated };
}

// 預設反應：車撞 NPC 車 → hit（超過門檻才 wreck）；車撞行人 → 行人 hit。D5 可改用自己的訂閱
export function attachNpcReactions(router) {
  const offA = router.onVehicleHitVehicle(({ a, b, impulse, dir }) => {
    if (b.kind === 'npcCar') b.hit({ impulse, dir });
    if (a.kind === 'npcCar') a.hit({ impulse, dir: { x: -dir.x, y: -dir.y, z: -dir.z } });
  });
  const offP = router.onVehicleHitPedestrian(({ ped, impulse, dir }) => ped.hit({ impulse, dir }));
  return () => {
    offA();
    offP();
  };
}
