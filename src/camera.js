// 第三人稱鏡頭：滑鼠拖曳 / pointer lock 轉視角、滾輪縮放、開車時自動回到車尾、避免穿進建築
import * as THREE from 'three';
import { clamp, angleDelta } from './utils.js';

export class CameraRig {
  constructor(camera, collision, heightAt) {
    this.camera = camera;
    this.collision = collision;
    this.heightAt = heightAt;
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

    // 鏡頭碰撞：從目標往鏡頭逐步檢查，遇到建築就拉近
    const steps = 24;
    let frac = 1;
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      this._p.lerpVectors(t, desired, f);
      if (this.collision.pointBlocked(this._p.x, this._p.y, this._p.z, 0.35)) {
        frac = Math.max(0.05, (i - 1) / steps);
        break;
      }
    }
    // 拉近要立即，拉遠要平滑
    const want = d * frac;
    if (want < this.curDist) this.curDist = want;
    else this.curDist += (want - this.curDist) * Math.min(1, 4 * dt);
    const k = d > 0 ? this.curDist / d : 1;
    this._p.lerpVectors(t, desired, k);
    const minY = this.heightAt(this._p.x, this._p.z) + 0.4;
    if (this._p.y < minY) this._p.y = minY;

    this.camera.position.copy(this._p);
    this.camera.lookAt(t);
  }
}
