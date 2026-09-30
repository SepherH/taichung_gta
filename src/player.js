// 第三人稱步行角色：WASD / 觸控搖桿移動（相對鏡頭方向）、Shift（或搖桿推到底）跑、Space 跳
// 兩種移動模式：
// - 物理模式（attachPhysics 後，遊戲本體）：Rapier 膠囊 CharacterBody（src/physics/character.js）；
//   update() 只讀輸入、記下移動意圖，實際 move 掛在 PhysicsWorld.onBeforeStep（每個物理子步一次），
//   step 之後 syncPhysics() 以插值結果更新 pos / 網格；上車 setEnabled(false)、下車 findFreeSpot 找空位
// - 無物理模式（tools/test/placement.mjs 的高度場擺放檢查）：地面取 terrain.querySurface(x, z, 目前腳底 y)，
//   坡度 > MAX_WALK_SLOPE 的上坡擋住水平移動（先整步、再分 x / z 兩軸滑動）；湖面（querySurface.waterY，非 walkable）不可進入
// 外觀：骨架角色（src/characters，variant pedestrian）+ CharacterAnimator，每幀以物理實際水平速度 update；
//   glb 未載入時 createCharacter 退回 humanoid.js 方塊人（fallback），動畫呼叫照常（狀態 / 計時仍跑，外觀改擺臂）
// 對抗：this.actor 為 combat.js 的 Actor 包裝（attachCombat 註冊）；受擊 / 倒地 / 起身期間鎖移動，
//   受擊擊退改成 CharacterBody 的水平速度（由角色控制器掃掠，不會穿牆）；倒地不做剛體飛出，原地播倒地動畫
import * as THREE from 'three';
import { createCharacter, getCharacterManifest, CharacterAnimator } from './characters/index.js';
import { pushOutOfCircles } from './collision.js';
import { angleDelta } from './utils.js';
import { SURFACE_OFFSET } from './data/city.js';

const WALK_SPEED = 4.2;
const RUN_SPEED = 8.5;
const ACCEL = 24;
const JUMP_SPEED = 6.5;
const GRAVITY = 22;
export const PLAYER_RADIUS = 0.35;
const MAX_WALK_SLOPE = 45; // 可走上的最大坡度（°）
const MIN_WALK_NY = Math.cos((MAX_WALK_SLOPE * Math.PI) / 180);
const MAX_RISE_PER_M = Math.tan((MAX_WALK_SLOPE * Math.PI) / 180);
const STEP_UP = 0.35; // 可直接跨上的不連續高差（m）：湖上甲板高出步道 0.3 m（terrain.js DECK_RISE，推測）
const SNAP_DROP = 0.5; // 下坡落差小於此值直接貼地，超過才進入落下狀態（m）
const TURN_RATE = 12; // 朝向追上移動方向的速率（1/s）
const EXIT_SIDE_GAP = 0.8; // 下車點：車身側面再往外多少（m）
const EXIT_SEARCH_RADIUS = 3; // 下車點附近找空位的半徑（m）
const RESPAWN_SEARCH_RADIUS = 6; // 重生點附近找空位的半徑（m）
// 擊退位移 → CharacterBody 初速：move() 的平滑每步保留 (1 − k)、k = ACCEL·dt / WALK_SPEED（鎖移動時目標速度 0），
// 位移總和 = v0 · dt / k = v0 · WALK_SPEED / ACCEL，所以 v0 = 位移 × ACCEL / WALK_SPEED
const KNOCKBACK_GAIN = ACCEL / WALK_SPEED;
const PLAYER_COLORS = { shirt: '#2e7d4f', pants: '#2b2f3a', skin: '#f1c9a5', hair: '#1b1b1b' };
const PLAYER_HP = 100;

// 移動意圖：鏡頭前方 (sin, cos)、右方 = 前 × 上；axis = input.moveAxis()（x 右正、y 前正、長度 ≤ 1）
export function moveIntent(axis, camYaw, out = { x: 0, z: 0 }) {
  const fx = Math.sin(camYaw);
  const fz = Math.cos(camYaw);
  out.x = fx * axis.y - fz * axis.x;
  out.z = fz * axis.y + fx * axis.x;
  return out;
}

export class Player {
  constructor(scene, spawn) {
    this.character = createCharacter({ variant: 'pedestrian', colors: PLAYER_COLORS });
    this.mesh = this.character.root;
    this.mesh.rotation.order = 'YXZ'; // 方塊人倒地時先 yaw 再往後躺
    scene.add(this.mesh);
    const manifest = getCharacterManifest();
    this.anim = new CharacterAnimator(this.character, manifest ? manifest.clips : []);
    this.pos = new THREE.Vector3(spawn.x, 0, spawn.z);
    this.yaw = spawn.yaw;
    this.vx = 0;
    this.vz = 0;
    this.vy = 0;
    this.onGround = true;
    this.speed = 0;
    this.ground = 0; // 目前腳下的地面高度（querySurface.y）
    this._q = {};
    this.body = null; // 物理模式的 CharacterBody
    this._intent = { moveX: 0, moveZ: 0, jump: false, run: false };
    this._jumpQueued = false;
    this.locked = false; // 上車動畫等外部鎖定：不讀移動輸入
    this.combat = null;
    const player = this;
    // combat.js Actor 包裝：pos 直接用 this.pos（腳底）、yaw 即時讀取
    this.actor = {
      id: 'player',
      kind: 'player',
      pos: this.pos,
      get yaw() {
        return player.yaw;
      },
      hp: PLAYER_HP,
      maxHp: PLAYER_HP,
      anim: this.anim,
      faction: 'player',
      untargetable: false,
      body: {
        // 原地倒下：面向衝量反方向（倒地動作往後躺 = 順著衝量倒），移動由 combat.isDown 鎖住
        knockdown(impulse) {
          if (impulse && Math.hypot(impulse.x, impulse.z) > 1e-6) player.yaw = Math.atan2(-impulse.x, -impulse.z);
          if (player.body) {
            player.body.vx = 0;
            player.body.vz = 0;
          }
        },
        settleCheck: () => ({ settled: !this.body || this.body.grounded || this.onGround, clearToStand: true }),
        standUp() {},
      },
    };
  }

  // 註冊進 CombatSystem：受擊擊退套到 CharacterBody（下一個物理子步由角色控制器掃掠）
  attachCombat(combat) {
    this.combat = combat;
    combat.register(this.actor);
    combat.on('hit', ({ target, knockback }) => {
      if (target !== this.actor || !this.body || !knockback) return;
      this.body.vx += knockback.x * KNOCKBACK_GAIN;
      this.body.vz += knockback.z * KNOCKBACK_GAIN;
    });
  }

  // 受擊硬直 / 倒地 / 起身 / 外部鎖定期間不能移動
  get controlLocked() {
    if (this.locked) return true;
    const st = this.combat ? this.combat.stateOf(this.actor) : null;
    return st === 'hit' || st === 'knockdown' || st === 'getup' || st === 'dead';
  }

  // 攻擊鍵：交給 combat（冷卻 / 硬直 / 動畫狀態由 combat 判斷）；回傳是否出拳
  punch() {
    if (!this.combat || this.controlLocked || (this.body && !this.body.enabled)) return false;
    return this.combat.requestPunch(this.actor);
  }

  // 切到物理模式：body = CharacterBody；move 掛在物理子步前（每子步一次，跳躍在第一個子步消化）
  attachPhysics(body) {
    this.body = body;
    body.pw.onBeforeStep((dt) => {
      if (!body.enabled) return;
      const it = this._intent;
      it.jump = this._jumpQueued;
      this._jumpQueued = false;
      body.move(dt, it);
    });
  }

  // 水平移到 (x, z) 是否允許：湖面不可進；腳下地面比目前高太多（坡 > MAX_WALK_SLOPE 或跨不上的落差）擋住
  _canMove(terrain, x, z) {
    const dx = x - this.pos.x;
    const dz = z - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-9) return true;
    const q = terrain.querySurface(x, z, this.pos.y, this._q);
    if (q.waterY !== null && !q.walkable) return false;
    const rise = q.y - (this.onGround ? this.ground : this.pos.y);
    if (rise <= 1e-6) return true;
    if (!this.onGround) return rise <= STEP_UP;
    if (q.ny < MIN_WALK_NY && q.nx * dx + q.nz * dz < 0) return false;
    return rise <= d * MAX_RISE_PER_M + STEP_UP;
  }

  // camYaw：鏡頭水平朝向（前方 = (sin, cos)）
  // obstacles：動態圓形障礙物（車輛）；terrain：唯一高度場（需有 querySurface）
  // 物理模式只用 dt / input / camYaw；collision / terrain / obstacles 供無物理模式
  update(dt, input, camYaw, collision, terrain, obstacles) {
    if (this.body) {
      this._readIntent(input, camYaw);
      return;
    }
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
    // 地形：整步不行就沿 x / z 單軸滑動（貼著陡坡 / 湖岸走），都不行就停在原地
    if (!this._canMove(terrain, x, z)) {
      if (this._canMove(terrain, x, this.pos.z)) {
        z = this.pos.z;
        this.vz = 0;
      } else if (this._canMove(terrain, this.pos.x, z)) {
        x = this.pos.x;
        this.vx = 0;
      } else {
        x = this.pos.x;
        z = this.pos.z;
        this.vx = 0;
        this.vz = 0;
      }
    }
    this.pos.x = x;
    this.pos.z = z;

    this.speed = Math.hypot(this.vx, this.vz);
    if (wl > 0) {
      const want = Math.atan2(wx, wz);
      this.yaw += angleDelta(this.yaw, want) * Math.min(1, 12 * dt);
    }

    // 跳躍與重力
    const ground = terrain.querySurface(this.pos.x, this.pos.z, this.pos.y, this._q).y;
    this.ground = ground;
    if (this.onGround && input.wasPressed('Space')) {
      this.vy = JUMP_SPEED;
      this.onGround = false;
      this.anim.trigger('jump');
    }
    if (this.onGround && this.vy <= 0 && this.pos.y - ground < SNAP_DROP) {
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

    this.anim.update(dt, { speed: this.speed, grounded: this.onGround });
    this.syncMesh();
  }

  _readIntent(input, camYaw) {
    const it = this._intent;
    if (this.controlLocked) {
      it.moveX = 0;
      it.moveZ = 0;
      it.run = false;
      this._jumpQueued = false;
      return;
    }
    const d = moveIntent(input.moveAxis(), camYaw);
    it.moveX = d.x;
    it.moveZ = d.z;
    // 觸控搖桿推過 STICK_RUN 時 input 會寫入 ShiftLeft（input.js），所以「搖桿推到底」也在這裡
    it.run = input.down('ShiftLeft') || input.down('ShiftRight');
    if (input.wasPressed('Space') && this.body.grounded && this.anim.trigger('jump')) this._jumpQueued = true;
  }

  // 物理 step 之後呼叫：pos = 插值後的腳底位置；朝向追上移動方向；動畫以實際水平速度更新
  syncPhysics(dt) {
    const b = this.body;
    if (!b.enabled) return;
    const o = b.handle.interpolate(b.pw.alpha);
    this.pos.set(o.x, o.y - b.lift, o.z);
    const r = b.result;
    this.onGround = r.grounded;
    this.ground = this.pos.y;
    this.vx = b.vx;
    this.vz = b.vz;
    this.vy = b.vy;
    this.speed = Math.hypot(b.vx, b.vz);
    const it = this._intent;
    if (Math.hypot(it.moveX, it.moveZ) > 1e-3) {
      this.yaw += angleDelta(this.yaw, Math.atan2(it.moveX, it.moveZ)) * Math.min(1, TURN_RATE * dt);
    }
    this.anim.update(dt, { speed: r.speed, grounded: this.onGround });
    this.syncMesh();
  }

  // 上車：膠囊停用（不再擋車、不被查詢命中）
  enterVehicle() {
    if (!this.body) return;
    this.body.setEnabled(false);
    this._jumpQueued = false;
  }

  // 下車：從車門側（spec.doorSide：+1 左 / −1 右，公車門在右）車身外找空位，找不到回傳 false（不下車）；物理模式專用
  exitVehicle(vehicle) {
    const b = this.body;
    const fx = Math.sin(vehicle.yaw);
    const fz = Math.cos(vehicle.yaw);
    const side = (vehicle.spec.width / 2 + EXIT_SIDE_GAP) * (vehicle.spec.doorSide || 1);
    // 左方 = (cos, −sin)（前進方向 (sin, cos) 逆時針轉 90°，與 vehicle.js 本地 +X 相同）
    const spot = b.findFreeSpot(vehicle.pos.x + fz * side, vehicle.pos.y, vehicle.pos.z - fx * side, EXIT_SEARCH_RADIUS);
    if (!spot) return false;
    b.setEnabled(true);
    b.teleport(spot.x, spot.y, spot.z);
    this.pos.set(spot.x, spot.y, spot.z);
    this.yaw = vehicle.yaw;
    this.vx = 0;
    this.vz = 0;
    this.vy = 0;
    this.syncMesh();
    return true;
  }

  // 重生（hp 歸零後）：在 (x, z) 附近找空位瞬移，找不到就留在原地；物理模式專用
  respawnAt(x, y, z) {
    const b = this.body;
    const spot = b && b.enabled ? b.findFreeSpot(x, y, z, RESPAWN_SEARCH_RADIUS) : null;
    if (!spot) return false;
    b.teleport(spot.x, spot.y, spot.z);
    this.pos.set(spot.x, spot.y, spot.z);
    this.vx = 0;
    this.vz = 0;
    this.vy = 0;
    this.syncMesh();
    return true;
  }

  syncMesh() {
    this.mesh.position.copy(this.pos);
    this.mesh.position.y += SURFACE_OFFSET;
    // 方塊人沒有倒地動作：倒地狀態整個往後躺平
    const lying = this.character.fallback && this.anim.state === 'knockdown';
    this.mesh.rotation.set(lying ? -Math.PI / 2 : 0, this.yaw, 0);
  }

  // 駕駛中：角色原點放在座位點（manifest seat − Hips 高），姿態跟著車身；動畫停在 drive
  sitOn(vehicle, dt = 0) {
    vehicle.seatWorld(this.mesh.position);
    this.mesh.quaternion.copy(vehicle.mesh.quaternion);
    this.pos.copy(this.mesh.position);
    this.yaw = vehicle.yaw;
    this.anim.update(dt, { speed: 0, driving: true });
  }

  placeAt(x, z, yaw, terrain) {
    this.ground = terrain.querySurface(x, z, Infinity, this._q).y;
    this.pos.set(x, this.ground, z);
    this.yaw = yaw;
    this.vx = 0;
    this.vz = 0;
    this.vy = 0;
    this.onGround = true;
    if (this.body) this.body.teleport(x, this.ground, z);
    this.syncMesh();
  }
}
