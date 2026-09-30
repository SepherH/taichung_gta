// 車輛物理本體：Rapier 動態剛體（cuboid 底盤）+ DynamicRayCastVehicleController 射線懸吊
// 本地座標與 vehicle.js 相同：前方 +Z、上方 +Y、左方 +X（面向 +Z 時東方在左手邊）；
// yaw 定義與玩家相同：前進方向 = (sin(yaw), cos(yaw))，steer +1 = 左轉（與 vehicle.js 的 left 相同）
// 依賴全部以參數注入：RAPIER 模組、原生 RAPIER.World（或帶 .world 的包裝物件）、collision groups；
// 本檔不 import rapier / three，純數學部分（規格推導、手感曲線、四元數）可在 node 無頭測試
//
// 手感設計：保留 vehicle.js 的街機數值（maxSpeed / accel / brake / turnRate），
// 由本檔換算成引擎力、煞車衝量、轉向角上限，讓物理車的偏航率與既有手感相近

export const GRAVITY = 9.81;

// 車重（kg）——VEHICLE_TYPES 沒有車重欄位，以下為推測值（一般轎車 / 休旅車整備重量量級；機車含騎士）
const VEHICLE_MASS = { sedan: 1400, taxi: 1450, suv: 1900, scooter: 190 };
// 未列車型時以外框體積推估（推測：約每立方公尺 110 kg）
const FALLBACK_DENSITY = 110;
// 既有網格的車輪半徑（vehicle.js 的 carWheelGeo / scooterWheelGeo）
const WHEEL_RADIUS_CAR = 0.34;
const WHEEL_RADIUS_TWO_WHEELER = 0.26;
// 規格缺值時的比例（任務契約）
const WHEELBASE_RATIO = 0.6;
const TRACK_RATIO = 0.85;

// 質心下移量：底盤 cuboid 以中心為剛體原點，另以 setAdditionalMassProperties 把質心放在原點下方，
// 等效於把重物（引擎、電池、底盤）壓低，大幅降低彎道翻覆力矩；
// 選擇 setAdditionalMassProperties 而非偏移 collider：偏移 collider 會讓碰撞外形跟著下移，車身外框就對不上網格
export const COM_DROP = 0.35;

// 懸吊 / 輪胎參數表（DynamicRayCastVehicleController 的彈簧與阻尼都會乘上車重，所以這裡是「每單位質量」的值）
export const SUSPENSION = {
  car: {
    restLength: 0.3, // 彈簧自然長：配合 0.34 m 輪胎與 0.22 m 離地，靜止時車身高度貼近既有網格
    maxTravel: 0.2, // 上下行程：吸收路緣、坡道轉折，又不至於讓車身晃出網格太多
    stiffness: 25, // 4 輪合計約 1.6 Hz 的車身起伏（一般房車偏硬），靜態下沉約 g/(4k) ≈ 0.1 m
    compression: 1.8, // 壓縮阻尼：約 0.35 臨界阻尼，過坎時車身先吃下衝擊、不彈跳
    relaxation: 2.8, // 回彈阻尼：約 0.55 臨界阻尼，高於壓縮，避免過坎後車身上下晃
    frictionSlip: 1.3, // 輪胎抓地上限（約等於摩擦係數）；實際值另受防翻門檻限制（見 frictionSlipFor）
    sideFrictionStiffness: 1.0, // 側向抓地倍率：1 = 每步幾乎消除側滑，街機式「指哪走哪」
    clearance: 0.22, // 底盤 cuboid 離地高度（靜止時）
  },
  twoWheeler: {
    restLength: 0.22, // 機車行程短、車身低
    maxTravel: 0.15,
    stiffness: 80, // 2 輪合計約 2 Hz，靜態下沉約 g/(2k) ≈ 0.06 m，騎起來較緊實
    compression: 5.0, // 約 0.4 臨界阻尼
    relaxation: 7.5, // 約 0.6 臨界阻尼
    frictionSlip: 1.1, // 機車抓地較低，重煞時前後輪會先滑而不是讓車身翻過去
    sideFrictionStiffness: 1.0,
    clearance: 0.18,
  },
};
// 單輪最大懸吊力（倍數 × 車重 × g）：避免預設 6000 N 上限讓重車（休旅車）撐不住
const MAX_SUSPENSION_FORCE_G = 3;
// 防翻門檻：側向抓地 ≤ 餘裕 × (半輪距 / 質心高)，確保穩態彎道中內側輪不會先離地
const ROLLOVER_MARGIN = 0.8;

// 駕駛手感
export const HANDLING = {
  launchScale: 0.55, // 起步加速度 = 既有 accel × 此值：既有街機 0→50 km/h 約 1.9 s，物理版目標 3–5 s
  torqueExponent: 4, // 扭力曲線 1 − (v/vmax)^n：n 越大低中速越有力、接近極速才急遽衰減
  reverseScale: 0.6, // 倒車加速度比例（同 vehicle.js 的 0.6）
  coastDecel: 3.0, // 放開油門的滾動阻力 + 引擎煞車（同 vehicle.js 的 0.8 + 2.2 m/s²），靜止時兼作駐車
  overspeedDecel: 4, // 超過極速（下坡）時的限速煞車
  reverseBrakeSpeed: 0.5, // 反向輸入時，速度高於此值先煞車、低於才換檔
  maxWheelAngle: 0.6, // 前輪最大轉角（rad，約 34°）
  steerRate: 4, // 方向盤轉入速度（每秒，正規化值；同 vehicle.js）
  steerReturnRate: 6, // 方向盤回正速度
  handbrakeRearFriction: 0.35, // 手煞車：後輪抓地倍率，後輪先滑出產生甩尾
  handbrakeRearSide: 0.5, // 手煞車：後輪側向抓地倍率
  handbrakeDecel: 6, // 手煞車鎖後輪的減速度
};

// 防傾（回正力矩）PD：以車身繞前進軸的傾角與角速度施加反向力矩衝量
// 汽車：輔助懸吊抗側傾（弱），保險避免極端操作翻車；機車：兩輪沿中線排列本身沒有側向支撐，必須靠它站立
// 取捨：鎖 roll（setEnabledRotations）鎖的是世界軸，會連帶鎖住上下坡的 pitch 且朝向改變後失效；
// 回正力矩只作用在車身前進軸，坡道、跳台照常，被撞時也保留一點物理反應
export const ROLL_ASSIST = {
  car: { omega: 6, zeta: 0.8 },
  twoWheeler: { omega: 16, zeta: 1.0 },
};
// 翻車自救：抬高量（m）
const FLIP_LIFT = 1;
// 底盤碰撞材質
const CHASSIS_FRICTION = 0.5;
const CHASSIS_RESTITUTION = 0.1;
// 接觸力事件門檻（N）：低於此值不送事件（實際高階事件門檻由 contacts.js 以衝量判斷）
export const CHASSIS_FORCE_EVENT_THRESHOLD = 20000;

// ---- 純數學工具（四元數與 collision groups） ----

export function rotateVec(q, v, out = { x: 0, y: 0, z: 0 }) {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  out.x = v.x + q.w * tx + (q.y * tz - q.z * ty);
  out.y = v.y + q.w * ty + (q.z * tx - q.x * tz);
  out.z = v.z + q.w * tz + (q.x * ty - q.y * tx);
  return out;
}

export function yawQuat(yaw) {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

const AXIS_X = { x: 1, y: 0, z: 0 };
const AXIS_Y = { x: 0, y: 1, z: 0 };
const AXIS_Z = { x: 0, y: 0, z: 1 };

export function yawOf(q) {
  const f = rotateVec(q, AXIS_Z);
  return Math.atan2(f.x, f.z);
}

// 繞車身前進軸的傾角（rad，右側抬起為正）
export function rollOf(q) {
  const r = rotateVec(q, AXIS_X);
  const u = rotateVec(q, AXIS_Y);
  return Math.atan2(r.y, u.y);
}

export function upOf(q) {
  return rotateVec(q, AXIS_Y);
}

export const membershipOf = (g) => (g >>> 16) & 0xffff;
export const filterOf = (g) => g & 0xffff;
export const makeGroups = (membership, filter) => ((membership << 16) | filter) >>> 0;

// 車輪射線：身分是 VEHICLE，只打地面 / 車 / 碎片，不打行人與感測器（撞人由底盤碰撞處理）
export function wheelRayGroups(groups) {
  if (!groups) return undefined;
  const hit = membershipOf(groups.WORLD) | membershipOf(groups.VEHICLE) | membershipOf(groups.NPC_CAR) | membershipOf(groups.DEBRIS);
  return makeGroups(membershipOf(groups.VEHICLE), hit);
}

// 將任一 world 參數（原生 World 或 { world }）轉成原生 World
export function nativeWorld(world) {
  return world && world.world ? world.world : world;
}

// ---- 規格與手感推導 ----

// base：{ type, length, width, height, maxSpeed, maxReverse, accel, brake, turnRate, twoWheeler, ... }
// （VEHICLE_TYPES[type] 加上 type；A2 manifest 之後會提供 wheelbase / track / wheelRadius / mass 同名欄位）
export function deriveVehicleSpec(base) {
  const twoWheeler = !!base.twoWheeler;
  const mass = base.mass ?? VEHICLE_MASS[base.type] ?? base.length * base.width * base.height * FALLBACK_DENSITY;
  return {
    ...base,
    twoWheeler,
    wheelbase: base.wheelbase ?? base.length * WHEELBASE_RATIO,
    track: base.track ?? base.width * TRACK_RATIO,
    wheelRadius: base.wheelRadius ?? (twoWheeler ? WHEEL_RADIUS_TWO_WHEELER : WHEEL_RADIUS_CAR),
    mass,
  };
}

export function suspensionFor(spec) {
  return spec.twoWheeler ? SUSPENSION.twoWheeler : SUSPENSION.car;
}

// 底盤幾何：cuboid 從離地 clearance 到車高；剛體原點 = cuboid 中心
// 硬點（懸吊上端）高度 = 輪半徑 + 自然長 − 靜態下沉，使靜止時輪底剛好貼地
export function chassisLayout(spec, clearance = suspensionFor(spec).clearance) {
  const s = suspensionFor(spec);
  const n = spec.twoWheeler ? 2 : 4;
  const sag = GRAVITY / (n * s.stiffness);
  const centerY = (clearance + spec.height) / 2;
  const half = { x: spec.width / 2, y: (spec.height - clearance) / 2, z: spec.length / 2 };
  const hardY = spec.wheelRadius + s.restLength - sag - centerY;
  const hz = spec.wheelbase / 2;
  const hx = spec.track / 2;
  // 輪序：汽車 0 左前、1 右前、2 左後、3 右後；機車 0 前、1 後
  const wheels = spec.twoWheeler
    ? [{ x: 0, y: hardY, z: hz, front: true }, { x: 0, y: hardY, z: -hz, front: false }]
    : [
        { x: hx, y: hardY, z: hz, front: true },
        { x: -hx, y: hardY, z: hz, front: true },
        { x: hx, y: hardY, z: -hz, front: false },
        { x: -hx, y: hardY, z: -hz, front: false },
      ];
  return { centerY, half, sag, wheels, comHeight: centerY - COM_DROP };
}

// 箱體主慣量（對稱軸即本地軸）；質心下移只改質心位置，慣量沿用箱體近似
export function boxInertia(mass, half) {
  const w = 2 * half.x;
  const h = 2 * half.y;
  const l = 2 * half.z;
  return { x: (mass / 12) * (h * h + l * l), y: (mass / 12) * (w * w + l * l), z: (mass / 12) * (w * w + h * h) };
}

// 側向抓地上限：表列值與防翻門檻取小（機車靠回正力矩站立，不受此限）
export function frictionSlipFor(spec, layout) {
  const s = suspensionFor(spec);
  if (spec.twoWheeler) return s.frictionSlip;
  return Math.min(s.frictionSlip, (ROLLOVER_MARGIN * (spec.track / 2)) / layout.comHeight);
}

// 引擎加速度（m/s²，前進方向），v 為沿車頭的速度；到極速歸零
export function engineAccel(spec, v) {
  const u = Math.max(0, v) / spec.maxSpeed;
  if (u >= 1) return 0;
  return spec.accel * HANDLING.launchScale * (1 - Math.pow(u, HANDLING.torqueExponent));
}

export function reverseAccel(spec, v) {
  const u = Math.max(0, -v) / spec.maxReverse;
  if (u >= 1) return 0;
  return spec.accel * HANDLING.launchScale * HANDLING.reverseScale * (1 - u);
}

// 依速度遞減的前輪轉角上限：反推 vehicle.js 的偏航率公式
// 既有：yawRate = turnRate × clamp(v/4, 0, 1) / (1 + v/18)；自行車模型：yawRate = v·tan(δ) / 軸距
export function steerLimit(spec, v) {
  const av = Math.max(Math.abs(v), 0.5);
  const speedFactor = Math.min(1, av / 4) / (1 + av / 18);
  const yawRate = spec.turnRate * speedFactor;
  return Math.min(HANDLING.maxWheelAngle, Math.atan((yawRate * spec.wheelbase) / av));
}

// 把控制輸入換算成每輪的引擎力（N）與煞車衝量上限（N·s）；v = 沿車頭速度，dt = 物理步長
// Rapier（同 Bullet）在引擎力非 0 時會忽略該輪煞車，所以兩者互斥
export function driveCommand(spec, controls, v, dt) {
  const n = spec.twoWheeler ? 2 : 4;
  const m = spec.mass;
  const { throttle, brake } = controls;
  let accel = 0;
  let decel = 0;
  if (brake > 0) decel = spec.brake * brake;
  else if (throttle > 0) {
    if (v < -HANDLING.reverseBrakeSpeed) decel = spec.brake * throttle;
    else accel = engineAccel(spec, v) * throttle;
  } else if (throttle < 0) {
    if (v > HANDLING.reverseBrakeSpeed) decel = spec.brake * -throttle;
    else accel = -reverseAccel(spec, v) * -throttle;
  } else decel = HANDLING.coastDecel;
  if (v > spec.maxSpeed) {
    accel = 0;
    decel = Math.max(decel, HANDLING.overspeedDecel);
  }
  return {
    engineForce: (m * accel) / n,
    brakeImpulse: accel !== 0 ? 0 : (m * decel * dt) / n,
  };
}

// ---- 車輛本體 ----

export class VehicleBody {
  // spec：deriveVehicleSpec 的輸入或輸出皆可；pose y 為輪底所在的地面高度
  constructor(RAPIER, world, spec, { x = 0, y = 0, z = 0, yaw = 0, groups = null, ccd = false } = {}) {
    this.RAPIER = RAPIER;
    this.world = nativeWorld(world);
    this.spec = deriveVehicleSpec(spec);
    this.kind = 'vehicle';
    this.groups = groups;
    this.layout = chassisLayout(this.spec);
    this.susp = suspensionFor(this.spec);
    this.frictionSlip = frictionSlipFor(this.spec, this.layout);
    this.inertia = boxInertia(this.spec.mass, this.layout.half);
    this.rayGroups = wheelRayGroups(groups);
    this.controls = { throttle: 0, steer: 0, brake: 0, handbrake: false };
    this.steer = 0;
    this.kinematic = false;
    this.active = true;
    this._handbrakeApplied = false;

    const { half, centerY } = this.layout;
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y + centerY, z)
      .setRotation(yawQuat(yaw))
      .setCcdEnabled(!!ccd)
      .setAdditionalMassProperties(this.spec.mass, { x: 0, y: -COM_DROP, z: 0 }, this.inertia, { x: 0, y: 0, z: 0, w: 1 });
    this.body = this.world.createRigidBody(bodyDesc);
    // density 0：質量完全由上面的 additional mass properties 決定（含下移的質心）
    const colDesc = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
      .setDensity(0)
      .setFriction(CHASSIS_FRICTION)
      .setRestitution(CHASSIS_RESTITUTION)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(CHASSIS_FORCE_EVENT_THRESHOLD);
    if (groups) colDesc.setCollisionGroups(groups.VEHICLE).setSolverGroups(groups.VEHICLE);
    this.collider = this.world.createCollider(colDesc, this.body);

    const vc = this.world.createVehicleController(this.body);
    // 綁定的 setter 名稱就叫 setIndexForwardAxis（indexForwardAxis 只有 getter）；本地前方 +Z
    vc.setIndexForwardAxis = 2;
    vc.indexUpAxis = 1;
    // 懸吊方向朝下；輪軸 −X：前進方向 = 接地法線 × 輪軸 = (+Y) × (−X) = +Z，正引擎力即前進
    const dir = { x: 0, y: -1, z: 0 };
    const axle = { x: -1, y: 0, z: 0 };
    const maxForce = this.spec.mass * GRAVITY * MAX_SUSPENSION_FORCE_G;
    this.layout.wheels.forEach((w, i) => {
      vc.addWheel({ x: w.x, y: w.y, z: w.z }, dir, axle, this.susp.restLength, this.spec.wheelRadius);
      vc.setWheelSuspensionStiffness(i, this.susp.stiffness);
      vc.setWheelSuspensionCompression(i, this.susp.compression);
      vc.setWheelSuspensionRelaxation(i, this.susp.relaxation);
      vc.setWheelMaxSuspensionTravel(i, this.susp.maxTravel);
      vc.setWheelMaxSuspensionForce(i, maxForce);
      vc.setWheelFrictionSlip(i, this.frictionSlip);
      vc.setWheelSideFrictionStiffness(i, this.susp.sideFrictionStiffness);
    });
    this.controller = vc;
  }

  // throttle −1..1（負值 = 倒車 / 反向煞車）、steer −1..1（+1 = 左）、brake 0..1、handbrake bool
  setControls({ throttle = 0, steer = 0, brake = 0, handbrake = false } = {}) {
    const c = this.controls;
    c.throttle = Math.max(-1, Math.min(1, throttle));
    c.steer = Math.max(-1, Math.min(1, steer));
    c.brake = Math.max(0, Math.min(1, brake));
    c.handbrake = !!handbrake;
  }

  // 沿車頭方向的速度（m/s，帶號）
  forwardSpeed() {
    const f = rotateVec(this.body.rotation(), AXIS_Z);
    const lv = this.body.linvel();
    return lv.x * f.x + lv.y * f.y + lv.z * f.z;
  }

  // 每個物理步在 world.step 前呼叫
  preStep(dt) {
    if (this.kinematic || !this.active) return;
    const spec = this.spec;
    const vc = this.controller;
    const c = this.controls;
    const v = this.forwardSpeed();

    // 方向盤平滑（同 vehicle.js：轉入 4/s、回正 6/s）
    const rate = c.steer === 0 ? HANDLING.steerReturnRate : HANDLING.steerRate;
    this.steer += Math.max(-rate * dt, Math.min(rate * dt, c.steer - this.steer));
    const angle = this.steer * steerLimit(spec, v);

    const cmd = driveCommand(spec, c, v, dt);
    const hb = c.handbrake;
    const rearBrake = (spec.mass * HANDLING.handbrakeDecel * dt) / (spec.twoWheeler ? 1 : 2);
    this.layout.wheels.forEach((w, i) => {
      vc.setWheelSteering(i, w.front ? angle : 0);
      if (hb && !w.front) {
        vc.setWheelEngineForce(i, 0);
        vc.setWheelBrake(i, Math.max(rearBrake, cmd.brakeImpulse));
      } else {
        vc.setWheelEngineForce(i, cmd.engineForce);
        vc.setWheelBrake(i, cmd.brakeImpulse);
      }
    });
    if (hb !== this._handbrakeApplied) {
      this._handbrakeApplied = hb;
      this.layout.wheels.forEach((w, i) => {
        if (w.front) return;
        vc.setWheelFrictionSlip(i, this.frictionSlip * (hb ? HANDLING.handbrakeRearFriction : 1));
        vc.setWheelSideFrictionStiffness(i, this.susp.sideFrictionStiffness * (hb ? HANDLING.handbrakeRearSide : 1));
      });
    }

    this._applyRollAssist(dt);
    vc.updateVehicle(dt, this.RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, this.rayGroups);
  }

  _applyRollAssist(dt) {
    const pd = this.spec.twoWheeler ? ROLL_ASSIST.twoWheeler : ROLL_ASSIST.car;
    const q = this.body.rotation();
    const f = rotateVec(q, AXIS_Z);
    const w = this.body.angvel();
    const rollRate = w.x * f.x + w.y * f.y + w.z * f.z;
    const roll = rollOf(q);
    const tau = -this.inertia.z * (pd.omega * pd.omega * roll + 2 * pd.zeta * pd.omega * rollRate) * dt;
    this.body.applyTorqueImpulse({ x: f.x * tau, y: f.y * tau, z: f.z * tau }, true);
  }

  // 給渲染：剛體位置為底盤中心（網格原點在輪底 → 網格 y = 本值 y − layout.centerY，沿車身 up 方向）
  getState() {
    const t = this.body.translation();
    const q = this.body.rotation();
    const vc = this.controller;
    const down = rotateVec(q, { x: 0, y: -1, z: 0 });
    const wheels = [];
    for (let i = 0; i < this.layout.wheels.length; i++) {
      const hp = vc.wheelHardPoint(i);
      const len = vc.wheelSuspensionLength(i) ?? this.susp.restLength;
      wheels.push({
        x: hp.x + down.x * len,
        y: hp.y + down.y * len,
        z: hp.z + down.z * len,
        rotation: vc.wheelRotation(i) ?? 0,
        steer: vc.wheelSteering(i) ?? 0,
        inContact: vc.wheelIsInContact(i),
        suspensionLength: len,
      });
    }
    return {
      x: t.x, y: t.y, z: t.z,
      qx: q.x, qy: q.y, qz: q.z, qw: q.w,
      speed: this.kinematic ? 0 : vc.currentVehicleSpeed(),
      wheels,
    };
  }

  getPosition() {
    return this.body.translation();
  }

  // 停放 / 遠距：切成 kinematic（原地不動、仍擋得住別人），回來再切 dynamic
  setKinematic(on) {
    const RAPIER = this.RAPIER;
    this.kinematic = !!on;
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setBodyType(on ? RAPIER.RigidBodyType.KinematicPositionBased : RAPIER.RigidBodyType.Dynamic, true);
  }

  // 遠距簡化：停用剛體（不參與模擬、不佔碰撞），位置 / 速度保留在剛體上
  setActive(on) {
    this.active = !!on;
    this.body.setEnabled(this.active);
  }

  // 翻車自救：抬高 1 m、只保留 yaw 轉正、速度歸零
  flip() {
    const t = this.body.translation();
    const yaw = yawOf(this.body.rotation());
    this.body.setTranslation({ x: t.x, y: t.y + FLIP_LIFT, z: t.z }, true);
    this.body.setRotation(yawQuat(yaw), true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steer = 0;
  }

  dispose() {
    this.world.removeVehicleController(this.controller);
    this.world.removeRigidBody(this.body);
    this.controller = null;
    this.body = null;
    this.collider = null;
  }
}
