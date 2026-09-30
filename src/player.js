// 第三人稱步行角色：WASD 移動（相對鏡頭方向）、Shift 跑、Space 跳
import * as THREE from 'three';
import { createHumanoid, animateHumanoid, poseSitting } from './humanoid.js';
import { pushOutOfCircles } from './collision.js';
import { angleDelta } from './utils.js';
import { SURFACE_OFFSET } from './data/city.js';

const WALK_SPEED = 4.2;
const RUN_SPEED = 8.5;
const ACCEL = 24;
const JUMP_SPEED = 6.5;
const GRAVITY = 22;
export const PLAYER_RADIUS = 0.35;

export class Player {
  constructor(scene, spawn) {
    this.mesh = createHumanoid({ shirt: '#2e7d4f', pants: '#2b2f3a', skin: '#f1c9a5', hair: '#1b1b1b' });
    scene.add(this.mesh);
    this.pos = new THREE.Vector3(spawn.x, 0, spawn.z);
    this.yaw = spawn.yaw;
    this.vx = 0;
    this.vz = 0;
    this.vy = 0;
    this.onGround = true;
    this.phase = 0;
    this.speed = 0;
  }

  // camYaw：鏡頭水平朝向（前方 = (sin, cos)）
  // obstacles：動態圓形障礙物（車輛）
  update(dt, input, camYaw, collision, heightAt, obstacles) {
    let ix = 0;
    let iz = 0;
    if (input.down('KeyW') || input.down('ArrowUp')) iz += 1;
    if (input.down('KeyS') || input.down('ArrowDown')) iz -= 1;
    if (input.down('KeyD') || input.down('ArrowRight')) ix += 1;
    if (input.down('KeyA') || input.down('ArrowLeft')) ix -= 1;

    // 鏡頭前方與右方（右 = 前 × 上）
    const fx = Math.sin(camYaw);
    const fz = Math.cos(camYaw);
    const rx = -fz;
    const rz = fx;
    let wx = fx * iz + rx * ix;
    let wz = fz * iz + rz * ix;
    const wl = Math.hypot(wx, wz);
    if (wl > 0) {
      wx /= wl;
      wz /= wl;
    }
    const running = input.down('ShiftLeft') || input.down('ShiftRight');
    const target = wl > 0 ? (running ? RUN_SPEED : WALK_SPEED) : 0;

    // 平滑加減速
    const k = Math.min(1, ACCEL * dt / Math.max(target, WALK_SPEED));
    this.vx += (wx * target - this.vx) * k;
    this.vz += (wz * target - this.vz) * k;

    let x = this.pos.x + this.vx * dt;
    let z = this.pos.z + this.vz * dt;
    const res = collision.resolveCircle(x, z, PLAYER_RADIUS, this.pos.y);
    x = res.x;
    z = res.z;
    if (obstacles && obstacles.length) {
      const r2 = pushOutOfCircles(x, z, PLAYER_RADIUS, obstacles);
      x = r2.x;
      z = r2.z;
    }
    this.pos.x = x;
    this.pos.z = z;

    this.speed = Math.hypot(this.vx, this.vz);
    if (wl > 0) {
      const want = Math.atan2(wx, wz);
      this.yaw += angleDelta(this.yaw, want) * Math.min(1, 12 * dt);
    }

    // 跳躍與重力
    const ground = heightAt(this.pos.x, this.pos.z);
    if (this.onGround && input.wasPressed('Space')) {
      this.vy = JUMP_SPEED;
      this.onGround = false;
    }
    if (this.onGround && this.vy <= 0 && this.pos.y - ground < 0.6) {
      // 貼地（下坡時不會一直飄起來）
      this.pos.y = ground;
      this.vy = 0;
    } else {
      this.vy -= GRAVITY * dt;
      this.pos.y += this.vy * dt;
      if (this.pos.y <= ground) {
        this.pos.y = ground;
        this.vy = 0;
        this.onGround = true;
      } else {
        this.onGround = false;
      }
    }

    // 走路擺動
    if (this.onGround) {
      this.phase += dt * (this.speed * 2.1);
      animateHumanoid(this.mesh, this.phase, Math.min(1, this.speed / WALK_SPEED));
    } else {
      animateHumanoid(this.mesh, 1.2, 0.5);
    }
    this.syncMesh();
  }

  syncMesh() {
    this.mesh.position.copy(this.pos);
    this.mesh.position.y += SURFACE_OFFSET;
    this.mesh.rotation.y = this.yaw;
  }

  // 騎機車時坐在座墊上
  sitOn(vehicle) {
    const fx = Math.sin(vehicle.yaw);
    const fz = Math.cos(vehicle.yaw);
    this.pos.set(vehicle.pos.x - fx * 0.2, vehicle.pos.y - 0.08, vehicle.pos.z - fz * 0.2);
    this.yaw = vehicle.yaw;
    poseSitting(this.mesh);
    this.syncMesh();
  }

  placeAt(x, z, yaw, heightAt) {
    this.pos.set(x, heightAt(x, z), z);
    this.yaw = yaw;
    this.vx = 0;
    this.vz = 0;
    this.vy = 0;
    this.onGround = true;
    animateHumanoid(this.mesh, 0, 0);
    this.syncMesh();
  }
}
