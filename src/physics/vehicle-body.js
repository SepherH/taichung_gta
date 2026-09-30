// 車輛物理本體：Rapier 動態剛體（cuboid 底盤）+ DynamicRayCastVehicleController 射線懸吊
// 本地座標與 vehicle.js 相同：前方 +Z、上方 +Y、左方 +X（面向 +Z 時東方在左手邊）；
// yaw 定義與玩家相同：前進方向 = (sin(yaw), cos(yaw))，steer +1 = 左轉（與 vehicle.js 的 left 相同）
// 依賴全部以參數注入：RAPIER 模組、原生 RAPIER.World（或帶 .world 的包裝物件）、collision groups；
// 本檔不 import rapier / three，純數學部分（規格推導、手感曲線、四元數）可在 node 無頭測試
//
// 手感設計：保留 vehicle.js 的街機數值（maxSpeed / accel / brake / turnRate / maxLatAccel），
// 由本檔換算成引擎力、煞車衝量、轉向角上限，讓物理車的偏航率與既有手感相近；
// 高速時轉向角另受側向加速度上限（maxLatAccel）限制，極速下滿舵仍在抓地範圍內（可控、不打滑）
// 另含：機車倒地（fallen）判定、車身懸吊 / 機車傾斜的視覺角度（只給網格用，不影響剛體）、損壞降功率（powerScale）

export const GRAVITY = 9.81;

// 車重（kg）：對齊參考作（docs/ref/taipei-gta-feature-map.md §2-4 規格表）；VEHICLE_TYPES 的 mass 欄位優先，本表為缺欄時的後備
const VEHICLE_MASS = { sedan: 1300, taxi: 1350, suv: 1750, scooter: 125, bus: 11000 };
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
  // 手煞車甩尾的偏航率上限（rad/s）：後輪抓地降到 0.35 倍後車尾甩出過猛（70 km/h 手煞 + 滿舵 2 s 轉約 230°），
  // 超過此值的部分以繞車身上軸的反向力矩衝量阻尼掉；1.2 rad/s ≈ 69°/s，目標 70 km/h 手煞 + 滿舵 2 s 轉 90–150°（手感值）
  handbrakeMaxYawRate: 1.2,
  handbrakeYawDamping: 30, // 超出上限部分的衰減速率（1/s）：每步消去 min(1, 30·dt) 的超出量
  // 高速轉向：偏航率上限 = maxLatAccel / v（穩態側向加速度 = v × 偏航率）；規格缺欄時的預設（m/s²）。
  // 汽車 11 ≈ 1.1 g，低於輪胎抓地（frictionSlip 1.3 → 約 12.7 m/s²），極速滿舵不會推頭打滑；
  // 機車 6.5 → 視覺傾斜 atan(6.5 / g) ≈ 33.5°，略低於倒地門檻（FALL.latAccel），正常騎乘滿舵不會倒
  latAccelCar: 11,
  latAccelTwoWheeler: 6.5,
  // 損壞降功率：powerScale k（0–1）時引擎加速度 × k、有效極速 × (minTopScale + (1 − minTopScale) × k)；k = 0 熄火（放油門滑行）
  minTopScale: 0.5,
};

// 機車倒地（fallen）判定（手感值，推測）：
// - 手煞車 + 車速 ≥ handbrakeSpeed + 方向盤 |steer| ≥ handbrakeSteer（高速急轉甩尾）→ 立即倒地
// - 或穩態側向加速度 |v × 偏航率| ≥ latAccel 持續 latSec 秒（例：被撞得打轉、下坡過彎過猛）
// 倒地後：引擎歸零、輪子以 slideDecel 磨地煞車、不能轉向；持續 OVERTURN_PROMPT_SEC 後 isOverturned 為真（提示按 F 扶起）
// 倒地滑行（實測修正：76 km/h 手煞倒地後車身已甩尾轉向，輪煞只沿車頭方向作用，壓不住側滑 / 倒退滑行，曾以 −17 km/h 滑出 33 m）：
//   另在世界座標直接對水平速度減速 dv/dt = −(slideGroundDecel + slideDamping × v)（不分車頭方向、減到 0 為止、不會反向），
//   偏航 / 翻滾角速度以 slideAngularDamping 指數衰減，底盤摩擦改為 slideFriction；
//   76 km/h（21.1 m/s）倒地 → 約 0.92 s 停、滑行約 6.9 m（任務上限 1.5 s / 10 m）；扶起（flip）時還原
export const FALL = {
  handbrakeSpeed: 11, // m/s（約 40 km/h）
  handbrakeSteer: 0.5,
  latAccel: 8.8, // m/s²：等效傾角 atan(8.8 / g) ≈ 42°，高於視覺傾斜上限 35°
  latSec: 0.12,
  slideDecel: 5, // 倒地輪煞減速度（m/s²，換算成每輪煞車衝量）
  slideGroundDecel: 8, // 倒地車身磨地的定值減速度（m/s²，世界座標水平速度）
  slideDamping: 2, // 倒地滑行的速度比例阻尼（1/s）：高速時減速更猛
  slideAngularDamping: 4, // 倒地角速度衰減（1/s）：甩尾打轉很快停住
  slideFriction: 1.2, // 倒地期間底盤 collider 摩擦（一般 CHASSIS_FRICTION 0.5）
  slideStopSpeed: 0.05, // 水平速度低於此值直接歸零
};

// 倒地滑行一步：水平速度大小 s → max(0, s − (a + k·s)·dt)；回傳新的大小（純數學，測試用）
export function slideSpeedStep(s, dt) {
  const next = s - (FALL.slideGroundDecel + FALL.slideDamping * s) * dt;
  return next > FALL.slideStopSpeed ? next : 0;
}

// 視覺傾斜（只影響網格）：加減速 pitch、過彎 roll、機車 lean；彈簧阻尼追目標角，產生一點懸吊回彈
// 角度慣例（網格 Euler 'YXZ'）：pitchVis 繞本地 X（+X = 左）正值 = 車頭朝下；rollVis 繞本地 Z（前）正值 = 車頂倒向右（−X）
export const VISUAL_TILT = {
  pitchPerAccel: 0.004, // rad / (m/s²)：煞車 18 m/s² → 約 4°（上限 pitchMax）
  rollPerAccel: 0.0045, // rad / (m/s²)：汽車彎中 11 m/s² → 約 2.8°（車身向彎外側傾）
  pitchMax: (3.5 * Math.PI) / 180,
  rollMax: (4 * Math.PI) / 180,
  leanMax: (35 * Math.PI) / 180, // 機車最大傾角（任務：約 35°）
  fallenRoll: (80 * Math.PI) / 180, // 機車倒地後網格側躺角度
  fallenRate: 5, // 倒下 / 扶起時網格角速度（rad/s）
  omega: 10, // 彈簧自然頻率（rad/s）
  zeta: 0.55, // 阻尼比 < 1：放開油門 / 放開方向盤時有一點回彈
  accelSmoothing: 12, // 加速度量測的低通速率（1/s），濾掉接觸瞬間的尖峰
};

// 防傾（回正力矩）PD：以車身繞前進軸的傾角與角速度施加反向力矩衝量
// 汽車：輔助懸吊抗側傾（弱），保險避免極端操作翻車；機車：兩輪沿中線排列本身沒有側向支撐，必須靠它站立
// 取捨：鎖 roll（setEnabledRotations）鎖的是世界軸，會連帶鎖住上下坡的 pitch 且朝向改變後失效；
// 回正力矩只作用在車身前進軸，坡道、跳台照常，被撞時也保留一點物理反應
// 汽車只在「至少一輪接地且 |roll| < ROLL_ASSIST_MAX_ROLL」時輔助：翻覆（四輪離地 / 側躺 / 倒扣）不自己翻回來，
// 狀態持續 OVERTURN_PROMPT_SEC 後 isOverturned 為真（整合者顯示「按 F 扶起」）；機車一律防傾（站立必需）
export const ROLL_ASSIST = {
  car: { omega: 6, zeta: 0.8 },
  twoWheeler: { omega: 16, zeta: 1.0 },
};
export const ROLL_ASSIST_MAX_ROLL = (60 * Math.PI) / 180;
export const OVERTURN_PROMPT_SEC = 1.5;
// 翻車自救（upright）：抬高量（m）；機車只需離地少許
const FLIP_LIFT = 1;
const FLIP_LIFT_TWO_WHEELER = 0.3;
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

// 側向加速度上限（m/s²）：規格欄位 maxLatAccel 優先
export function latAccelMax(spec) {
  return spec.maxLatAccel ?? (spec.twoWheeler ? HANDLING.latAccelTwoWheeler : HANDLING.latAccelCar);
}

// 目標偏航率（rad/s）：既有街機曲線 turnRate × clamp(v/4, 0, 1) / (1 + v/18)，
// 非手煞車時再受 maxLatAccel / v 限制（高速轉向遞減）；手煞車不設限，保留甩尾
export function targetYawRate(spec, v, handbrake = false) {
  const av = Math.max(Math.abs(v), 0.5);
  const legacy = (spec.turnRate * Math.min(1, av / 4)) / (1 + av / 18);
  return handbrake ? legacy : Math.min(legacy, latAccelMax(spec) / av);
}

// 依速度遞減的前輪轉角上限：自行車模型 yawRate = v·tan(δ) / 軸距 反推 δ
export function steerLimit(spec, v, handbrake = false) {
  const av = Math.max(Math.abs(v), 0.5);
  return Math.min(HANDLING.maxWheelAngle, Math.atan((targetYawRate(spec, v, handbrake) * spec.wheelbase) / av));
}

// 損壞降功率後的有效極速
export function effectiveTopSpeed(spec, power = 1) {
  const k = Math.max(0, Math.min(1, power));
  return spec.maxSpeed * (HANDLING.minTopScale + (1 - HANDLING.minTopScale) * k);
}

// 把控制輸入換算成每輪的引擎力（N）與煞車衝量上限（N·s）；v = 沿車頭速度，dt = 物理步長
// power：setPowerScale 的倍率（0 = 熄火：踩油門等同放油門滑行）
// Rapier（同 Bullet）在引擎力非 0 時會忽略該輪煞車，所以兩者互斥
export function driveCommand(spec, controls, v, dt, power = 1) {
  const n = spec.twoWheeler ? 2 : 4;
  const m = spec.mass;
  const { throttle, brake } = controls;
  const k = Math.max(0, Math.min(1, power));
  const top = k < 1 ? { ...spec, maxSpeed: effectiveTopSpeed(spec, k) } : spec;
  let accel = 0;
  let decel = 0;
  if (brake > 0) decel = spec.brake * brake;
  else if (throttle > 0) {
    if (v < -HANDLING.reverseBrakeSpeed) decel = spec.brake * throttle;
    else accel = engineAccel(top, v) * throttle * k;
  } else if (throttle < 0) {
    if (v > HANDLING.reverseBrakeSpeed) decel = spec.brake * -throttle;
    else accel = -reverseAccel(spec, v) * -throttle * k;
  }
  if (accel === 0 && decel === 0 && (throttle === 0 || k === 0)) decel = HANDLING.coastDecel;
  if (v > top.maxSpeed) {
    accel = 0;
    decel = Math.max(decel, HANDLING.overspeedDecel);
  }
  return {
    engineForce: (m * accel) / n,
    brakeImpulse: accel !== 0 ? 0 : (m * decel * dt) / n,
  };
}

// ---- 視覺傾斜（純數學；只給網格用，不影響剛體） ----

const clampAbs = (x, m) => Math.max(-m, Math.min(m, x));

// 機車傾角（rad，正 = 向左傾）：atan(側向加速度 / g)，上限 VISUAL_TILT.leanMax；aLat 左轉為正
export function leanAngle(aLat) {
  return clampAbs(Math.atan(aLat / GRAVITY), VISUAL_TILT.leanMax);
}

// 目標視覺角 { pitch, roll }（慣例見 VISUAL_TILT）：aLong = 縱向加速度（前進為正）、aLat = 側向加速度（左轉為正，= v × 偏航率）
// 汽車：加速車頭抬、煞車點頭、過彎車身向彎外側傾；機車：向彎內 lean（與汽車 roll 共用同一個 roll 通道），pitch 減半
// spec.tiltScale（缺省 1）放大高車身車型的晃動（休旅車 / 公車懸吊較軟）
export function visualTiltTarget(spec, aLong, aLat) {
  const T = VISUAL_TILT;
  const s = spec.tiltScale ?? 1;
  const pitch = clampAbs(-T.pitchPerAccel * aLong * s * (spec.twoWheeler ? 0.5 : 1), T.pitchMax * s);
  const roll = spec.twoWheeler ? -leanAngle(aLat) : clampAbs(T.rollPerAccel * aLat * s, T.rollMax * s);
  return { pitch, roll };
}

// 彈簧阻尼追目標角（半隱式 Euler）；st = { pitch, roll, pitchVel, rollVel }，就地更新並回傳
export function stepTilt(st, target, dt) {
  const w = VISUAL_TILT.omega;
  const z = VISUAL_TILT.zeta;
  st.pitchVel += (w * w * (target.pitch - st.pitch) - 2 * z * w * st.pitchVel) * dt;
  st.rollVel += (w * w * (target.roll - st.roll) - 2 * z * w * st.rollVel) * dt;
  st.pitch += st.pitchVel * dt;
  st.roll += st.rollVel * dt;
  return st;
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
    this.overturnedTime = 0; // 翻覆（四輪離地或 |roll| ≥ 60°）持續秒數；超過 OVERTURN_PROMPT_SEC 時 isOverturned() 為真
    this.powerScale = 1; // 損壞降功率（setPowerScale）
    this.fallen = false; // 機車倒地
    this.fallenTime = 0; // 倒地持續秒數
    this.onFall = null; // 倒地瞬間回呼 onFall(vehicleBody)；vehicle.js 轉成 vehicle.onFall
    this._fallSide = 1; // 倒向：+1 左、−1 右
    this._latTime = 0; // 側向加速度超過倒地門檻的持續秒數
    this._prevV = null;
    this.accLong = 0; // 低通後的縱向加速度（m/s²）
    this.accLat = 0; // 低通後的側向加速度（m/s²，左轉為正）
    this.visual = { pitch: 0, roll: 0, pitchVel: 0, rollVel: 0 }; // 網格視覺傾斜（rad）

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

  // 繞車身上軸的偏航率（rad/s，左轉為正）
  yawRate() {
    const u = rotateVec(this.body.rotation(), AXIS_Y);
    const w = this.body.angvel();
    return w.x * u.x + w.y * u.y + w.z * u.z;
  }

  // 損壞降功率：k 0–1（0 = 熄火無動力）
  setPowerScale(k) {
    this.powerScale = Number.isFinite(k) ? Math.max(0, Math.min(1, k)) : 1;
  }

  // 汽車翻覆 / 機車倒地持續 ≥ OVERTURN_PROMPT_SEC
  isOverturned() {
    const due = OVERTURN_PROMPT_SEC - 1e-9;
    return this.overturnedTime >= due || (this.fallen && this.fallenTime >= due);
  }

  // 每個物理步在 world.step 前呼叫
  preStep(dt) {
    if (this.kinematic || !this.active) return;
    const spec = this.spec;
    const vc = this.controller;
    const c = this.controls;
    const v = this.forwardSpeed();
    const yawRate = this.yawRate();
    this._measure(v, yawRate, dt);
    if (spec.twoWheeler) this._checkFall(v, yawRate, dt);
    const fallen = this.fallen;
    const hb = c.handbrake && !fallen;

    // 方向盤平滑（同 vehicle.js：轉入 4/s、回正 6/s）；倒地後方向盤回正
    const steerIn = fallen ? 0 : c.steer;
    const rate = steerIn === 0 ? HANDLING.steerReturnRate : HANDLING.steerRate;
    this.steer += Math.max(-rate * dt, Math.min(rate * dt, steerIn - this.steer));
    const angle = this.steer * steerLimit(spec, v, hb);

    // 倒地：無動力、車身磨地減速
    const cmd = fallen
      ? { engineForce: 0, brakeImpulse: (spec.mass * FALL.slideDecel * dt) / (spec.twoWheeler ? 2 : 4) }
      : driveCommand(spec, c, v, dt, this.powerScale);
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
    if (hb) this._dampHandbrakeYaw(dt);
    if (fallen) this._slideBrake(dt);
    this._updateVisual(dt);
    vc.updateVehicle(dt, this.RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, this.rayGroups);
  }

  // 量測縱向 / 側向加速度（低通），供視覺傾斜
  _measure(v, yawRate, dt) {
    const aLong = this._prevV === null ? 0 : (v - this._prevV) / dt;
    this._prevV = v;
    const k = Math.min(1, VISUAL_TILT.accelSmoothing * dt);
    this.accLong += (aLong - this.accLong) * k;
    this.accLat += (v * yawRate - this.accLat) * k;
  }

  // 機車倒地判定（見 FALL）
  _checkFall(v, yawRate, dt) {
    if (this.fallen) {
      this.fallenTime += dt;
      return;
    }
    const aLat = v * yawRate;
    this._latTime = Math.abs(aLat) >= FALL.latAccel ? this._latTime + dt : 0;
    const hbTurn = this.controls.handbrake && Math.abs(v) >= FALL.handbrakeSpeed && Math.abs(this.steer) >= FALL.handbrakeSteer;
    if (hbTurn || this._latTime >= FALL.latSec - 1e-9) this._fall(Math.sign(aLat) || Math.sign(this.steer) || 1);
  }

  // 倒地：side +1 = 向左倒（左彎內側）、−1 = 向右
  _fall(side) {
    this.fallen = true;
    this.fallenTime = 0;
    this._fallSide = side;
    this._latTime = 0;
    if (this.collider) this.collider.setFriction(FALL.slideFriction);
    if (this.onFall) this.onFall(this);
  }

  // 倒地滑行：世界座標水平速度直接減速（見 FALL），垂直速度留給重力；角速度指數衰減
  _slideBrake(dt) {
    const lv = this.body.linvel();
    const s = Math.hypot(lv.x, lv.z);
    const k = s > 1e-9 ? slideSpeedStep(s, dt) / s : 0;
    this.body.setLinvel({ x: lv.x * k, y: lv.y, z: lv.z * k }, true);
    const w = this.body.angvel();
    const d = Math.max(0, 1 - FALL.slideAngularDamping * dt);
    this.body.setAngvel({ x: w.x * d, y: w.y * d, z: w.z * d }, true);
  }

  // 視覺傾斜：一般狀態彈簧追 visualTiltTarget；倒地時 roll 以固定角速度倒向側躺角
  _updateVisual(dt) {
    const st = this.visual;
    if (this.fallen) {
      const target = -this._fallSide * VISUAL_TILT.fallenRoll;
      const step = VISUAL_TILT.fallenRate * dt;
      st.roll += Math.max(-step, Math.min(step, target - st.roll));
      st.pitch -= st.pitch * Math.min(1, 8 * dt);
      st.rollVel = 0;
      st.pitchVel = 0;
      return;
    }
    stepTilt(st, visualTiltTarget(this.spec, this.accLong, this.accLat), dt);
    if (this.spec.twoWheeler) st.roll = clampAbs(st.roll, VISUAL_TILT.leanMax);
  }

  // 視覺與量測狀態歸零（扶起、切 kinematic 時）
  _resetMotionState() {
    this._prevV = null;
    this.accLong = 0;
    this.accLat = 0;
    this._latTime = 0;
    const st = this.visual;
    st.pitch = 0;
    st.roll = 0;
    st.pitchVel = 0;
    st.rollVel = 0;
  }

  // 回正力矩（PD）；汽車翻覆時不輔助並累計 overturnedTime（接地輪取上一次 updateVehicle 的結果）
  _applyRollAssist(dt) {
    const two = this.spec.twoWheeler;
    const pd = two ? ROLL_ASSIST.twoWheeler : ROLL_ASSIST.car;
    const q = this.body.rotation();
    const roll = rollOf(q);
    let grounded = false;
    for (let i = 0; i < this.layout.wheels.length && !grounded; i++) grounded = !!this.controller.wheelIsInContact(i);
    const overturned = !grounded || Math.abs(roll) >= ROLL_ASSIST_MAX_ROLL;
    this.overturnedTime = overturned ? this.overturnedTime + dt : 0;
    if (overturned && !two) return;
    const f = rotateVec(q, AXIS_Z);
    const w = this.body.angvel();
    const rollRate = w.x * f.x + w.y * f.y + w.z * f.z;
    const tau = -this.inertia.z * (pd.omega * pd.omega * roll + 2 * pd.zeta * pd.omega * rollRate) * dt;
    this.body.applyTorqueImpulse({ x: f.x * tau, y: f.y * tau, z: f.z * tau }, true);
  }

  // 手煞車期間：繞車身上軸的偏航率超過 handbrakeMaxYawRate 的部分以反向力矩衝量衰減
  _dampHandbrakeYaw(dt) {
    const u = rotateVec(this.body.rotation(), AXIS_Y);
    const yawRate = this.yawRate();
    const excess = Math.abs(yawRate) - HANDLING.handbrakeMaxYawRate;
    if (excess <= 0) return;
    const tau = -Math.sign(yawRate) * this.inertia.y * excess * Math.min(1, HANDLING.handbrakeYawDamping * dt);
    this.body.applyTorqueImpulse({ x: u.x * tau, y: u.y * tau, z: u.z * tau }, true);
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
    this._prevV = null;
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setBodyType(on ? RAPIER.RigidBodyType.KinematicPositionBased : RAPIER.RigidBodyType.Dynamic, true);
  }

  // 遠距簡化：停用剛體（不參與模擬、不佔碰撞），位置 / 速度保留在剛體上
  setActive(on) {
    this.active = !!on;
    this.body.setEnabled(this.active);
  }

  // 翻車自救 / 扶起機車：抬高（汽車 1 m、機車 0.3 m）、只保留 yaw 轉正、速度歸零、清除倒地狀態
  flip() {
    const t = this.body.translation();
    const yaw = yawOf(this.body.rotation());
    const lift = this.spec.twoWheeler ? FLIP_LIFT_TWO_WHEELER : FLIP_LIFT;
    this.body.setTranslation({ x: t.x, y: t.y + lift, z: t.z }, true);
    this.body.setRotation(yawQuat(yaw), true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steer = 0;
    this.overturnedTime = 0;
    if (this.fallen && this.collider) this.collider.setFriction(CHASSIS_FRICTION);
    this.fallen = false;
    this.fallenTime = 0;
    this._resetMotionState();
  }

  // 重置到指定位置（掉出世界的回收）：pose y 為輪底地面高度；直立、速度歸零、清除倒地 / 翻覆
  resetTo({ x, y, z, yaw = yawOf(this.body.rotation()) }) {
    if (this.kinematic) {
      this.body.setNextKinematicTranslation({ x, y: y + this.layout.centerY, z });
      this.body.setNextKinematicRotation(yawQuat(yaw));
    }
    this.body.setTranslation({ x, y: y + this.layout.centerY, z }, true);
    this.body.setRotation(yawQuat(yaw), true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steer = 0;
    this.overturnedTime = 0;
    if (this.fallen && this.collider) this.collider.setFriction(CHASSIS_FRICTION);
    this.fallen = false;
    this.fallenTime = 0;
    this._resetMotionState();
  }

  // 契約名稱（flip 保留為別名）
  upright() {
    this.flip();
  }

  dispose() {
    this.world.removeVehicleController(this.controller);
    this.world.removeRigidBody(this.body);
    this.controller = null;
    this.body = null;
    this.collider = null;
  }
}
