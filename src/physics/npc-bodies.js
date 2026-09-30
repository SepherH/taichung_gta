// NPC 物理本體：車流車輛與行人
// 平常是 kinematic（位置由 traffic.js 的車道 / 人行道邏輯每步給目標 pose），被撞才切 dynamic：
// - NPC 車：接觸衝量超過門檻 → dynamic 並施加衝量 → wrecked；N 秒後速度夠低可交還車道邏輯
// - 行人：被車撞 → dynamic 膠囊 + 衝量；settleCheck() 供 D5 倒地起身狀態機判斷何時可起身
// 遠距簡化：setActiveByDistance 停用半徑外的剛體，回到半徑內再啟用（狀態保留）
// 依賴以參數注入（RAPIER、原生 World 或 { world }、collision groups、contacts.js 的 router）；pose 的 y 為地面高度
import { GRAVITY, COM_DROP, chassisLayout, deriveVehicleSpec, boxInertia, yawQuat, yawOf, nativeWorld, membershipOf, filterOf, makeGroups } from './vehicle-body.js';

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
// 被撞飛的水平速度上限（m/s）：避免高速撞擊把人射出畫面；Phase 3 FX1 由 12 放寬到 20（約 83 km/h 撞擊才碰到），
//   原因：12 會讓 60 km/h（16.8 m/s）的水平初速被鉗住、遠低於車速，車頭追上再撞把上拋壓掉（宿主實測 60 km/h 只拋 0.32 m）
export const PED_MAX_LAUNCH_SPEED = 20;
// 被撞飛的向上速度上限（m/s，套增益之後）：水平 / 垂直分開鉗制，互不影響；
//   Phase 3 FX1 由 5.5 放寬到 7（原值讓 60 km/h 的向上 5.58 × V 一律被鉗成 5.5，V 1.0–1.5 掃描結果完全相同）
export const PED_MAX_LAUNCH_VERTICAL = 7;
// 垂直最低保留比例：鉗制後的向上速度至少保留未鉗制值的這個比例，確保上拋隨車速遞增、不會在某車速以上變成定值
export const PED_VERTICAL_KEEP = 0.6;
// 上拋分級（依撞擊相對速度 = 衝量 ÷ 行人質量，m/s）：由低到高第一個 maxSpeed 大於相對速度者，
// 基準水平速度 = 相對速度 × carry、基準向上速度 = 基準水平速度 × lift；
// 車撞（相對速度 ≥ 第一級上限）再乘接觸增益 PED_CONTACT_GAIN_H / _V，水平套上限 PED_MAX_LAUNCH_SPEED；
// 垂直套上限 PED_MAX_LAUNCH_VERTICAL，但至少保留未鉗制值 × PED_VERTICAL_KEEP。
// 車撞分級依宿主真物理（sedan 30 km/h、tools/test/physics-vehicle.mjs 7b）實測掃描定案，實測與拋體估算差異大、不可線性外推：
//   F2 carry 1 / lift 0.47 → 拋高 1.53 m、飛 13.15 m；F3b carry 0.65 / lift 0.47 → 拋高 0.07 m、飛 2.75 m
//   （水平初速低於車速，車頭追上再撞、壓掉上拋；carry 0.8 以下同 lift 時拋高急降）。
//   掃描 carry 0.66–0.88 × lift 0.47–0.74：拋高 ≥ 0.6 m 時飛距幾乎都 ≥ 8 m（車頭推送加長水平），可行區很窄；
//   取 carry 0.74 / lift 0.62 → 實測拋高 0.67 m、飛 8.45 m（兩者都在 0.6–1.0 / 5–9 內且離邊界最遠）。
// 高速級（≥ 43 km/h）Phase 3 FX1 重訂（依宿主 7c 遊戲流程 hold 數據推估，待宿主實測）：
//   宿主數據顯示有效垂直倍率（實測拋高換算的有效向上 ÷ 施加向上）隨「車速 − 行人水平初速」（追撞差速 Δv）線性下降：
//     30 km/h V1.3/H1.0 Δv 2.16 → 0.73；60 km/h H1.0 Δv 4.77 → 0.46；60 km/h H0.9 Δv 5.60 → 0.36
//     擬合 有效倍率 ≈ 0.96 − 0.107 × Δv（見 pedFlightEff）；落地前實際水平速度 ≈ 1.05 × max(車速, 施加水平)
//   高速級讓 Δv 維持在 30 km/h 已實測的區間（約 2.2 m/s）：carry 0.87 → 60 km/h 水平 14.6、Δv 2.18、有效倍率 ≈ 0.73；
//   目標拋高約 1.1 m 需有效向上 4.7 m/s → 施加 6.45 m/s → lift = 6.45 ÷ (14.6 × V 1.3) ≈ 0.34
//   → 估算 60 km/h 拋高 1.1 m、飛 16.7 m（目標 0.9–1.6 m / 12–20 m）；40 km/h（第三級）0.95 m / 10.3 m，上拋隨車速遞增
//   minVertical 4.3（m/s，套增益前的基準向上下限；× V 1.3 ≈ 5.6）：接住第三級上緣（43 km/h 向上已達上限 7），避免跨級後 45 km/h 拋高驟降
// 拳擊擊倒（< 4 m/s）維持 carry 1、lift 0.25（手感值，推測，非實測）
export const PED_LIFT_TIERS = [
  { maxSpeed: 4, carry: 1, lift: 0.25 }, // 拳擊擊倒（120 N·s ≈ 1.7 m/s）、推擠：稍微離地即可
  { maxSpeed: 6, carry: 0.74, lift: 0.35 }, // 慢速碰撞（< 22 km/h）
  { maxSpeed: 12, carry: 0.74, lift: 0.62 }, // 市區慢行～一般車速（22–43 km/h）
  { maxSpeed: Infinity, carry: 0.87, lift: 0.34, minVertical: 4.3 }, // 高速（≥ 43 km/h）：水平上限 20 m/s
];
// 車撞接觸增益（Phase 3 拆成垂直 / 水平兩個倍率，真正作用在 hit() 施加的初速上；拳擊不套）
// 背景：Phase 2 以上表定案後，宿主測試流程（VehicleBody 直接給速度、撞後立即全煞）30 km/h 拋高 0.67 m，
//   遊戲內卻只有 0.30–0.56 m（中位約 0.43 m）；遊戲流程差異：VehicleManager 建車（ccd 關、manifest 外形 / 質量）、
//   玩家以 driveControls 加速且撞後通常仍踩油門 → 車頭持續頂住行人，車殼前緣摩擦把上拋壓掉（推測）。
//   只有垂直不足、水平飛距正常，所以兩個倍率分開調。
// 宿主 7c 遊戲流程 SWEEP（30 km/h hold）：V1.2H1.1 0.67/6.38、V1.3H1.0 0.67/6.44、V1.3H1.1 0.82/7.01、V1.4H0.9 0.67/6.30、V1.4H1.0 0.82/7.01
//   → 定案 V 1.3 / H 1.0（拋高 0.67 m、飛 6.44 m，在 0.6–0.9 / 5–9 內）
export const PED_CONTACT_GAIN_V = 1.3;
export const PED_CONTACT_GAIN_H = 1.0;
// 執行期調參（只給測試掃描改；遊戲不改動）：hit() / pedLaunch() 讀這裡
export const pedContactTuning = { v: PED_CONTACT_GAIN_V, h: PED_CONTACT_GAIN_H };
// pedLaunchFlight 車撞估算模型（不影響施加的衝量；依宿主 7c hold 數據擬合，見 PED_LIFT_TIERS 註解）：
//   有效垂直倍率 = base − slope × Δv（夾在 min–1）、實際水平速度 = hGain × max(車速, 施加水平)
export const PED_FLIGHT_MODEL = { base: 0.96, slope: 0.107, min: 0.2, hGain: 1.05 };
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

// 是否為車撞分級（相對速度 ≥ 拳擊分級上限）
export function isVehicleImpulse(impulse) {
  return impulse / PED_MASS >= PED_LIFT_TIERS[0].maxSpeed;
}

// 衝量（N·s）→ 行人飛出初速 { horizontal, vertical }（m/s）；tuning = { v, h } 接觸增益（預設 pedContactTuning）
export function pedLaunch(impulse, tuning = pedContactTuning) {
  const rel = impulse / PED_MASS;
  const tier = PED_LIFT_TIERS.find((t) => rel < t.maxSpeed);
  const base = rel * tier.carry;
  if (!isVehicleImpulse(impulse)) {
    const horizontal = Math.min(base, PED_MAX_LAUNCH_SPEED);
    return { horizontal, vertical: horizontal * tier.lift };
  }
  // 水平 / 垂直分開鉗制：水平上限不影響垂直；垂直鉗制後至少保留 PED_VERTICAL_KEEP
  const rawV = Math.max(base * tier.lift, tier.minVertical || 0) * tuning.v;
  return {
    horizontal: Math.min(base * tuning.h, PED_MAX_LAUNCH_SPEED),
    vertical: Math.max(Math.min(rawV, PED_MAX_LAUNCH_VERTICAL), rawV * PED_VERTICAL_KEEP),
  };
}

// 車撞的「有效初速 ÷ 施加初速」{ v, h }（PED_FLIGHT_MODEL 擬合，車速取撞擊相對速度）；拳擊為 1
export function pedFlightEff(impulse, tuning = pedContactTuning) {
  if (!isVehicleImpulse(impulse)) return { v: 1, h: 1 };
  const rel = impulse / PED_MASS;
  const l = pedLaunch(impulse, tuning);
  const m = PED_FLIGHT_MODEL;
  const dv = Math.max(0, rel - l.horizontal);
  const v = Math.min(1, Math.max(m.min, m.base - m.slope * dv));
  return { v, h: (m.hGain * Math.max(rel, l.horizontal)) / l.horizontal };
}

// 平地拋體近似（無空氣阻力、落回原高度）：{ apex 拋高（m）, distance 落地前水平距離（m）}；供調參與測試
// eff = 有效初速 ÷ 施加初速 { v, h }：預設 pedFlightEff（車撞依追撞差速推估，拳擊為 1）
export function pedLaunchFlight(impulse, eff = null, tuning = pedContactTuning) {
  const e = eff || pedFlightEff(impulse, tuning);
  const l = pedLaunch(impulse, tuning);
  const horizontal = l.horizontal * e.h;
  const vertical = l.vertical * e.v;
  return { apex: (vertical * vertical) / (2 * GRAVITY), distance: (horizontal * 2 * vertical) / GRAVITY };
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
    const { horizontal, vertical } = pedLaunch(impulse);
    const j = PED_MASS * horizontal;
    const h = Math.hypot(dir.x, dir.z) || 1;
    this.body.applyImpulse({ x: (dir.x / h) * j, y: PED_MASS * vertical, z: (dir.z / h) * j }, true);
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
