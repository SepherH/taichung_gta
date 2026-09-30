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
    this.yaw = 0; // 鏡頭看的水平方向：前方 = (sin, cos)
    this.pitch = 0.32;
    this.dist = 7;
    this.time = 0;
    this.lastManual = -10;
    this.curDist = 7;
    this.curRaise = 0;
    this._head = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._p = new THREE.Vector3();
  }

  // focus：跟隨目標位置；opts：{ driving, vehicleYaw, speed, distScale, clearRadius, clearHeight（駕駛時車身水平半徑 / 車頂上方高度）}
  update(dt, input, focus, opts = {}) {
    this.time += dt;
    const m = input.consumeMouse();
    if (m.dx !== 0 || m.dy !== 0) this.lastManual = this.time;
    this.yaw -= m.dx * LOOK_RAD_PER_UNIT;
    this.pitch = clamp(this.pitch + m.dy * PITCH_PER_UNIT, PITCH_MIN, PITCH_MAX);
    if (m.wheel !== 0) this.dist = clamp(this.dist * (1 + m.wheel * 0.001), 3, 30);

    // 開車時：一段時間沒動滑鼠，鏡頭自動轉回車尾
    if (opts.driving && this.time - this.lastManual > 1.2 && Math.abs(opts.speed || 0) > 1) {
      this.yaw += angleDelta(this.yaw, opts.vehicleYaw) * Math.min(1, 2.5 * dt);
    }

    // 目標點：頭部高度，仰視時再往上抬（受頭頂遮擋限制）
    const head = this._head.set(focus.x, focus.y + (opts.driving ? DRIVE_EYE : walkEyeHeight(this.playerHeight)), focus.z);
    const t = this._target.copy(head);
    let raise = 0;
    if (this.pitch < 0) {
      raise = LOOK_UP_RAISE * (this.pitch / PITCH_MIN);
      t.y += raise;
      raise *= this.collision.sweep(head, t, CAM_RADIUS);
    }
    if (raise < this.curRaise) this.curRaise = raise;
    else this.curRaise += (raise - this.curRaise) * Math.min(1, RAISE_EASE * dt);
    t.y = head.y + this.curRaise;

    const d = this.dist * (opts.distScale || 1);
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const desired = this._desired.set(
      t.x - Math.sin(this.yaw) * cp * d,
      t.y + sp * d,
      t.z - Math.cos(this.yaw) * cp * d,
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
    if (want < this.curDist) this.curDist = want;
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
  }

  // 鏡頭用地面：高度場高度（yHint −∞ 不站上甲板），湖面範圍內取水面與湖床較高者
  groundAt(x, z) {
    const q = this.terrain.querySurface(x, z, -Infinity, this._q);
    return q.waterY !== null ? Math.max(q.y, q.waterY) : q.y;
  }
}
