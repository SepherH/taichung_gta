// 第三人稱鏡頭：滑鼠拖曳 / pointer lock 轉視角、滾輪縮放、開車時自動回到車尾、避免穿進建築與地形
// 建築遮擋由 collision.sweep(目標, 鏡頭, 半徑) 取得可到達比例（遊戲本體 = PhysicsOccluder 的 Rapier 球體掃掠，見 collision.js）
// 地形取 terrain（唯一高度場）：鏡頭不低於所在點地面（湖面範圍取水面）+ CAM_GROUND_CLEAR；
// 目標 → 鏡頭連線每 GROUND_STEP 取樣地面，被邊坡擋住就把鏡頭拉近（秋紅谷坡下往外看時不鑽進邊坡）
import * as THREE from 'three';
import { clamp, angleDelta } from './utils.js';

const CAM_GROUND_CLEAR = 0.4; // 鏡頭離地最小高度（m）
const GROUND_STEP = 1; // 連線取地面樣本的間距（m）
const RAY_GROUND_CLEAR = 0.2; // 連線上的點低於「地面 + 此值」視為被地形擋住（m）
const CAM_RADIUS = 0.35; // 鏡頭碰撞半徑（m）

export class CameraRig {
  // collision：需有 sweep(from, to, radius)；terrain：需有 querySurface（本檔只取高度場高度與水面，不站上 walkable）
  constructor(camera, collision, terrain) {
    this.camera = camera;
    this.collision = collision;
    this.terrain = terrain;
    this._q = {};
    this.yaw = 0; // 鏡頭看的水平方向：前方 = (sin, cos)
    this.pitch = 0.32;
    this.dist = 7;
    this.time = 0;
    this.lastManual = -10;
    this.curDist = 7;
    this._target = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._p = new THREE.Vector3();
  }

  // focus：跟隨目標位置；opts：{ driving, vehicleYaw, speed, distScale }
  update(dt, input, focus, opts = {}) {
    this.time += dt;
    const m = input.consumeMouse();
    if (m.dx !== 0 || m.dy !== 0) this.lastManual = this.time;
    this.yaw -= m.dx * 0.0045;
    this.pitch = clamp(this.pitch + m.dy * 0.0035, -0.12, 1.25);
    if (m.wheel !== 0) this.dist = clamp(this.dist * (1 + m.wheel * 0.001), 3, 30);

    // 開車時：一段時間沒動滑鼠，鏡頭自動轉回車尾
    if (opts.driving && this.time - this.lastManual > 1.2 && Math.abs(opts.speed || 0) > 1) {
      this.yaw += angleDelta(this.yaw, opts.vehicleYaw) * Math.min(1, 2.5 * dt);
    }

    const t = this._target.set(focus.x, focus.y + (opts.driving ? 1.7 : 1.5), focus.z);
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
    // 地形遮擋：同一條連線每 GROUND_STEP 取樣地面
    const gSteps = Math.max(1, Math.ceil(d / GROUND_STEP));
    for (let i = 1; i <= gSteps; i++) {
      const f = i / gSteps;
      if (f >= frac) break;
      this._p.lerpVectors(t, desired, f);
      if (this._p.y < this.groundAt(this._p.x, this._p.z) + RAY_GROUND_CLEAR) {
        frac = Math.max(0.05, (i - 1) / gSteps);
        break;
      }
    }
    // 拉近要立即，拉遠要平滑
    const want = d * frac;
    if (want < this.curDist) this.curDist = want;
    else this.curDist += (want - this.curDist) * Math.min(1, 4 * dt);
    const k = d > 0 ? this.curDist / d : 1;
    this._p.lerpVectors(t, desired, k);
    const minY = this.groundAt(this._p.x, this._p.z) + CAM_GROUND_CLEAR;
    if (this._p.y < minY) this._p.y = minY;

    this.camera.position.copy(this._p);
    this.camera.lookAt(t);
  }

  // 鏡頭用地面：高度場高度（yHint −∞ 不站上甲板），湖面範圍內取水面與湖床較高者
  groundAt(x, z) {
    const q = this.terrain.querySurface(x, z, -Infinity, this._q);
    return q.waterY !== null ? Math.max(q.y, q.waterY) : q.y;
  }
}
