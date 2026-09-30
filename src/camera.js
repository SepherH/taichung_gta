// 第三人稱鏡頭：滑鼠拖曳 / pointer lock 轉視角、滾輪縮放、開車時自動回到車尾、避免穿進建築與地形
// 建築遮擋由 collision.sweep(目標, 鏡頭, 半徑) 取得可到達比例（遊戲本體 = PhysicsOccluder 的 Rapier 球體掃掠，見 collision.js）
// 地形取 terrain（唯一高度場）：鏡頭不低於所在點地面（湖面範圍取水面）+ CAM_GROUND_CLEAR；
// 目標 → 鏡頭連線每 GROUND_STEP 取樣地面，連線低於「地面 + CAM_GROUND_CLEAR」就在交點把鏡頭沿視線拉近
//
// 俯仰：pitch > 0 = 鏡頭在上往下看（俯角），pitch < 0 = 鏡頭在角色下方往上看（仰角）；步行與駕駛共用
// 仰視時鏡頭目標點依仰角抬高（最多 LOOK_UP_RAISE），讓鏡頭貼地時仍保有距離、看得到高樓頂樓；
// 抬高量先從頭部往上掃掠一次，騎樓 / 雨棚下不會把目標點抬進天花板
// 輸入 dx / dy 的單位 = 中檔靈敏度下的滑鼠 px（靈敏度倍率與觸控換算由 input.js 處理）
// 步行目標點高度 = 玩家身高（playerHeight，main.js 由 player.height 設定；未設定用角色 manifest 預設身高）− EYE_BELOW_TOP
//
// 距離三段（opts.cycleView = 本幀按 V 循環）：步行 WALK_DISTS（滾輪另可連續微調 WALK_DIST_MIN–MAX，V 會重設到該段）；
//   駕駛 CAR_DISTS / 兩輪 BIKE_DISTS 乘 distScale 相對參考車（轎車 / 機車 camScale）的比例，隨速度再拉遠（最多 SPEED_DIST_MAX）
// 步行越肩：鏡頭與注視點同時往右移 SHOULDER_OFFSET，側向掃掠貼牆時隨可用空間縮小
// FOV：步行 WALK_FOV；駕駛依車速 DRIVE_FOV_MIN → DRIVE_FOV_MAX（0 → FOV_SPEED_KMH 線性、平滑）
// 駕駛自動回正：RECENTER_IDLE 秒無轉視角輸入且前進車速 > RECENTER_MIN_KMH，yaw 以 RECENTER_RATE 轉回車尾（倒車不回正）；
//   opts.lookBack（按住 C）時看車後方，放開立即回原本 yaw
// 碰撞震動：rig.shake(trauma)（0–1 累加），振幅 ∝ trauma²，trauma 指數衰減（SHAKE_TAU；約 0.6 s 後振幅 < 2%）
import * as THREE from 'three';
import { clamp, angleDelta } from './utils.js';
import { LOOK_RAD_PER_UNIT } from './input.js';
import { DEFAULT_HEIGHT } from './characters/model.js';

const DEG = Math.PI / 180;
export const PITCH_MIN = -80 * DEG; // 最大仰角 80°（鏡頭在角色下方往上看）
export const PITCH_MAX = 72 * DEG; // 最大俯角 72°（看腳邊）
const PITCH_PER_UNIT = LOOK_RAD_PER_UNIT; // 垂直與水平同比例
const CAM_GROUND_CLEAR = 0.4; // 鏡頭離地最小高度（m；規格下限 0.3）
const GROUND_STEP = 1; // 連線取地面樣本的間距（m）
const CAM_RADIUS = 0.35; // 鏡頭碰撞半徑（m）
const MIN_FRAC = 0.05; // 鏡頭距離最少保留的比例（與 sweep 下限一致）
const EYE_BELOW_TOP = 0.25; // 步行時目標點在頭頂下方多少（m）：1.75 m 身高 → 離腳底 1.5 m
const DRIVE_EYE = 1.7; // 駕駛時目標點離車身原點高度（m）
const LOOK_UP_RAISE = 3.5; // 仰角到 PITCH_MIN 時目標點額外抬高（m），中間依仰角線性
const RAISE_EASE = 4; // 抬高量回升的平滑速率（1/s；下降立即）
const DIST_EASE = 4; // 鏡頭距離拉遠的平滑速率（1/s；拉近立即）
const NOMINAL_EASE = 5; // 名目距離（V 段位 / 速度拉遠 / 步行駕駛切換）雙向平滑速率（1/s）
const KMH = 3.6; // m/s → km/h

export const WALK_DISTS = [2.7, 4.1, 6.0]; // 步行三段距離（m）
export const CAR_DISTS = [5.2, 6.4, 8.9]; // 汽車三段距離（m，轎車基準）
export const BIKE_DISTS = [4.3, 5.0, 6.0]; // 機車三段距離（m）
export const DEFAULT_VIEW = 1; // 預設段位（中段）
export const WALK_DIST_MIN = 2.5; // 步行滾輪微調下限（m）
export const WALK_DIST_MAX = 12; // 步行滾輪微調上限（m）
export const CAR_REF_SCALE = 1.35; // 汽車組距離的參考 camScale（轎車；distScale 除以此值再乘）
export const BIKE_REF_SCALE = 1.0; // 機車組距離的參考 camScale（機車）
export const SHOULDER_OFFSET = 0.3; // 步行越肩右偏（m）
const SHOULDER_EASE = 6; // 越肩偏移的平滑速率（1/s；步行貼牆縮小立即）
const SPEED_DIST_PER_KMH = 0.5 / 66; // 速度拉遠：66 km/h ≈ +0.5 m，線性
const SPEED_DIST_MAX = 1.0; // 速度拉遠上限（m）
export const WALK_FOV = 60;
export const DRIVE_FOV_MIN = 62; // 駕駛靜止 FOV
export const DRIVE_FOV_MAX = 66; // 駕駛 FOV_SPEED_KMH 以上 FOV
const FOV_SPEED_KMH = 100;
const FOV_EASE = 3; // FOV 平滑速率（1/s）
export const RECENTER_IDLE = 2; // 駕駛無轉視角輸入多久後開始回正（s）
const RECENTER_MIN_KMH = 5; // 前進車速超過才回正（km/h）
const RECENTER_RATE = 90 * DEG; // 回正角速度（rad/s）
const RECENTER_RAMP = 0.3; // 回正速率由 0 漸增到滿速的時間（s），避免起步頓一下
export const SHAKE_TAU = 0.3; // trauma 衰減時間常數（s）：0.6 s 後 trauma ≈ 0.14、振幅 trauma² ≈ 0.02
const SHAKE_POS = 0.25; // trauma = 1 時的最大位移（m）
const SHAKE_ROT = 3 * DEG; // trauma = 1 時的最大旋轉（rad）

// 步行目標點離腳底高度（m）
export function walkEyeHeight(playerHeight = DEFAULT_HEIGHT) {
  return playerHeight - EYE_BELOW_TOP;
}

export class CameraRig {
  // collision：需有 sweep(from, to, radius)；terrain：需有 querySurface（本檔只取高度場高度與水面，不站上 walkable）
  constructor(camera, collision, terrain) {
    this.camera = camera;
    this.collision = collision;
    this.terrain = terrain;
    this.playerHeight = DEFAULT_HEIGHT; // 步行目標點依此換算（walkEyeHeight）
    this._q = {};
    this.yaw = 0; // 鏡頭看的水平方向：前方 = (sin, cos)；玩家移動方向依此（lookBack 不改它）
    this.viewYaw = 0; // 本幀實際使用的水平方向（lookBack 時 = 車尾反向）
    this.pitch = 0.32;
    this.walkView = DEFAULT_VIEW; // 步行段位（WALK_DISTS 索引）
    this.driveView = DEFAULT_VIEW; // 駕駛段位（CAR_DISTS / BIKE_DISTS 索引）
    this.dist = WALK_DISTS[DEFAULT_VIEW]; // 步行距離（滾輪連續微調；V 重設到段位值）
    this.time = 0;
    this.lastManual = -10;
    this.nominal = null; // 平滑後的名目距離（首幀直接取目標值）
    this.curDist = null; // 實際距離（含遮擋縮短；首幀直接取目標值）
    this.curRaise = 0;
    this.curShoulder = SHOULDER_OFFSET;
    this.fov = camera.fov;
    this.trauma = 0;
    this._head = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._side = new THREE.Vector3();
  }

  // 碰撞震動：trauma 0–1（累加後上限 1），整合在撞車（vehicle:crash）時呼叫
  shake(trauma) {
    if (!(trauma > 0)) return;
    this.trauma = Math.min(1, this.trauma + trauma);
  }

  // 目前名目距離（未含遮擋縮短）；opts 同 update
  targetDistance(opts = {}) {
    if (!opts.driving) return this.dist;
    const set = opts.twoWheeler ? BIKE_DISTS : CAR_DISTS;
    const ref = opts.twoWheeler ? BIKE_REF_SCALE : CAR_REF_SCALE;
    const kmh = Math.abs(opts.speed || 0) * KMH;
    return set[this.driveView] * ((opts.distScale || ref) / ref) + Math.min(SPEED_DIST_MAX, kmh * SPEED_DIST_PER_KMH);
  }

  // focus：跟隨目標位置；opts：{ driving, vehicleYaw, speed（m/s，負 = 倒車）, distScale（車種 camScale）, twoWheeler,
  //   cycleView（本幀按 V）, lookBack（按住 C，駕駛時看車後方）, clearRadius, clearHeight（駕駛時車身水平半徑 / 車頂上方高度）}
  update(dt, input, focus, opts = {}) {
    this.time += dt;
    const driving = !!opts.driving;
    const speed = opts.speed || 0;
    const m = input.consumeMouse();
    if (m.dx !== 0 || m.dy !== 0) this.lastManual = this.time;
    this.yaw -= m.dx * LOOK_RAD_PER_UNIT;
    this.pitch = clamp(this.pitch + m.dy * PITCH_PER_UNIT, PITCH_MIN, PITCH_MAX);
    if (driving) {
      if (opts.cycleView) this.driveView = (this.driveView + 1) % CAR_DISTS.length;
    } else {
      if (opts.cycleView) {
        this.walkView = (this.walkView + 1) % WALK_DISTS.length;
        this.dist = WALK_DISTS[this.walkView];
      }
      if (m.wheel !== 0) this.dist = clamp(this.dist * (1 + m.wheel * 0.001), WALK_DIST_MIN, WALK_DIST_MAX);
    }

    // 開車時：RECENTER_IDLE 秒沒轉視角且前進中，鏡頭以固定角速度轉回車尾（起步 RECENTER_RAMP 秒內漸增）
    const idle = this.time - this.lastManual - RECENTER_IDLE;
    if (driving && idle > 0 && speed * KMH > RECENTER_MIN_KMH) {
      const d = angleDelta(this.yaw, opts.vehicleYaw || 0);
      const step = RECENTER_RATE * Math.min(1, idle / RECENTER_RAMP) * dt;
      this.yaw += Math.abs(d) <= step ? d : Math.sign(d) * step;
    }
    const lookBack = driving && !!opts.lookBack;
    const yaw = (this.viewYaw = lookBack ? (opts.vehicleYaw || 0) + Math.PI : this.yaw);

    // FOV：步行固定、駕駛隨車速線性，平滑逼近
    const fovWant = driving
      ? DRIVE_FOV_MIN + (DRIVE_FOV_MAX - DRIVE_FOV_MIN) * clamp((Math.abs(speed) * KMH) / FOV_SPEED_KMH, 0, 1)
      : WALK_FOV;
    this.fov += (fovWant - this.fov) * Math.min(1, FOV_EASE * dt);
    if (Math.abs(this.camera.fov - this.fov) > 1e-4) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }

    // 目標點：頭部高度；步行越肩右移（側向掃掠，貼牆時縮小）；仰視時再往上抬（受頭頂遮擋限制）
    const head = this._head.set(focus.x, focus.y + (driving ? DRIVE_EYE : walkEyeHeight(this.playerHeight)), focus.z);
    const t = this._target.copy(head);
    const side = this._side.set(-Math.cos(yaw), 0, Math.sin(yaw)); // 鏡頭右方
    let shoulder = 0;
    if (!driving) {
      t.addScaledVector(side, SHOULDER_OFFSET);
      shoulder = SHOULDER_OFFSET * this.collision.sweep(head, t, CAM_RADIUS);
    }
    // 貼牆縮小立即；上下車（0 ↔ 0.3）與離牆回復平滑
    if (!driving && shoulder < this.curShoulder) this.curShoulder = shoulder;
    else this.curShoulder += (shoulder - this.curShoulder) * Math.min(1, SHOULDER_EASE * dt);
    t.copy(head).addScaledVector(side, this.curShoulder);
    const base = this._p.copy(t);
    let raise = 0;
    if (this.pitch < 0) {
      raise = LOOK_UP_RAISE * (this.pitch / PITCH_MIN);
      t.y += raise;
      raise *= this.collision.sweep(base, t, CAM_RADIUS);
    }
    if (raise < this.curRaise) this.curRaise = raise;
    else this.curRaise += (raise - this.curRaise) * Math.min(1, RAISE_EASE * dt);
    t.y = head.y + this.curRaise;

    // 名目距離：段位 / 速度 / 步行駕駛切換都雙向平滑
    const dWant = this.targetDistance(opts);
    if (this.nominal === null) this.nominal = dWant;
    else this.nominal += (dWant - this.nominal) * Math.min(1, NOMINAL_EASE * dt);
    const d = this.nominal;
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const desired = this._desired.set(
      t.x - Math.sin(yaw) * cp * d,
      t.y + sp * d,
      t.z - Math.cos(yaw) * cp * d,
    );

    // 鏡頭碰撞：從目標往鏡頭掃掠，遇到建築就拉近
    let frac = this.collision.sweep(t, desired, CAM_RADIUS);
    // 地形遮擋：同一條連線每 GROUND_STEP 取樣，找出低於「地面 + CAM_GROUND_CLEAR」的交點（兩樣本間線性內插）
    const gSteps = Math.max(1, Math.ceil(d / GROUND_STEP));
    let hPrev = t.y - this.groundAt(t.x, t.z) - CAM_GROUND_CLEAR;
    for (let i = 1; i <= gSteps; i++) {
      const f = i / gSteps;
      this._p.lerpVectors(t, desired, f);
      const h = this._p.y - this.groundAt(this._p.x, this._p.z) - CAM_GROUND_CLEAR;
      if (h < 0) {
        const cross = hPrev > 0 ? (i - 1 + hPrev / (hPrev - h)) / gSteps : (i - 1) / gSteps;
        frac = Math.min(frac, Math.max(MIN_FRAC, cross));
        break;
      }
      if (f >= frac) break;
      hPrev = h;
    }
    // 拉近要立即，拉遠要平滑
    const want = d * frac;
    if (this.curDist === null || want < this.curDist) this.curDist = want;
    else this.curDist += (want - this.curDist) * Math.min(1, DIST_EASE * dt);
    const k = d > 0 ? this.curDist / d : 1;
    this._p.lerpVectors(t, desired, k);
    // 最後保險：鏡頭所在點離地不足就抬高
    const minY = this.groundAt(this._p.x, this._p.z) + CAM_GROUND_CLEAR;
    if (this._p.y < minY) this._p.y = minY;
    // 駕駛大仰角：地面截斷會把鏡頭拉到車身水平範圍內（實測 −80° 時距車中心 0.8 m、離地 0.5 m = 車殼內，畫面全黑），抬到車頂上方
    if (opts.clearRadius && Math.hypot(this._p.x - focus.x, this._p.z - focus.z) < opts.clearRadius) {
      this._p.y = Math.max(this._p.y, focus.y + opts.clearHeight);
    }

    this.camera.position.copy(this._p);
    this.camera.lookAt(t);

    // 碰撞震動：位移與旋轉以不同頻率的正弦疊加（可重現），振幅 trauma²
    if (this.trauma > 0) {
      const a = this.trauma * this.trauma;
      const w = this.time;
      this.camera.position.x += SHAKE_POS * a * Math.sin(w * 37.1);
      this.camera.position.y += SHAKE_POS * a * Math.sin(w * 41.3 + 1.7);
      this.camera.position.z += SHAKE_POS * a * Math.sin(w * 33.7 + 3.1);
      this.camera.rotateZ(SHAKE_ROT * a * Math.sin(w * 29.3 + 0.5));
      this.camera.rotateX(SHAKE_ROT * 0.5 * a * Math.sin(w * 31.9 + 2.3));
      this.trauma *= Math.exp(-dt / SHAKE_TAU);
      if (this.trauma < 1e-3) this.trauma = 0;
    }
  }

  // 鏡頭用地面：高度場高度（yHint −∞ 不站上甲板），湖面範圍內取水面與湖床較高者
  groundAt(x, z) {
    const q = this.terrain.querySurface(x, z, -Infinity, this._q);
    return q.waterY !== null ? Math.max(q.y, q.waterY) : q.y;
  }
}
