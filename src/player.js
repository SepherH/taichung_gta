// 第三人稱步行角色：WASD / 觸控搖桿移動（相對鏡頭方向）、Shift（或搖桿推到底）跑、Space 跳
// 兩種移動模式：
// - 物理模式（attachPhysics 後，遊戲本體）：Rapier 膠囊 CharacterBody（src/physics/character.js）；
//   update() 只讀輸入、記下移動意圖，實際 move 掛在 PhysicsWorld.onBeforeStep（每個物理子步一次），
//   step 之後 syncPhysics() 以插值結果更新 pos / 網格；上車 setEnabled(false)、下車 findFreeSpot 找空位
// - 無物理模式（tools/test/placement.mjs 的高度場擺放檢查）：地面取 terrain.querySurface(x, z, 目前腳底 y)，
//   坡度 > MAX_WALK_SLOPE 的上坡擋住水平移動（先整步、再分 x / z 兩軸滑動）；湖面（querySurface.waterY，非 walkable）不可進入
// 外觀：骨架角色（src/characters）+ CharacterAnimator，每幀以物理實際水平速度 update；
//   模型 = manifest 中 role 為 player 的主角（hero，保留原材質）；沒有 / 載入失敗退回 pedestrian（PLAYER_COLORS 換色）；
//   glb 未載入時 createCharacter 退回 humanoid.js 方塊人（fallback），動畫呼叫照常（狀態 / 計時仍跑，外觀改擺臂）
// 身高（this.height）取 manifest 該 variant 的 height（缺省 1.75 m）：膠囊 halfHeight（capsuleHalfHeight）、
//   鏡頭目標點（main.js 設給 CameraRig.playerHeight）、駕駛座位對位（seatDrop）都由它換算
// 對抗：this.actor 為 combat.js 的 Actor 包裝（attachCombat 註冊）；受擊 / 倒地 / 起身期間鎖移動，
//   受擊擊退改成 CharacterBody 的水平速度（由角色控制器掃掠，不會穿牆）、受擊時轉身面向攻擊者；倒地不做剛體飛出，原地播倒地動畫
// 出拳輔助瞄準：combat.assistTarget（前方 ±90°、2.5 m 內最近行人）→ ASSIST_TURN_SEC 內轉向面對，
//   目標在命中半徑外時再向前小衝步（LUNGE_*，同樣走 CharacterBody 速度），讓 2.5 m 內的目標打得到
// Phase 4：
// - 武器動畫層 this.weaponLayer（character-animation.js createWeaponLayer）：上半身持武器姿勢 / 揮棒 / 開槍 / 裝填疊在移動之上；
//   每次 this.anim.update 之後緊接 weaponLayer.update(同一 dt)（步行物理 / 無物理 / 駕駛坐姿三條路徑都一樣）
// - this.speedScale（預設 1）：步行速度倍率（heavy 委託 0.6，由整合層每幀設定）；走 / 衝刺頂速都乘上，駕駛不受影響
import * as THREE from 'three';
import { createCharacter, getCharacterManifest, CharacterAnimator, playerVariant, variantHeight, DEFAULT_VARIANT, characterBoneGroups } from './characters/index.js';
import { createWeaponLayer } from './character-animation.js';
import { ASSIST_TURN_SEC, HIT_RADIUS } from './combat.js';
import { SEAT_HIPS_HEIGHT } from './vehicle-model.js';
import { pushOutOfCircles } from './collision.js';
import { angleDelta } from './utils.js';
import { SURFACE_OFFSET } from './data/city.js';
import { surfaceRoads, surfaceFootways } from './citymodel.js';
import { closestOnSegment } from './geom.js';
import { WALK_SPEED, RUN_SPEED, JUMP_SPEED, GRAVITY, stepVelocity, speedForDistance, jumpStep, jumpLand, createJumpState } from './physics/character.js';

// 手感常數（走 / 衝刺速度、加減速、跳躍、coyote / 緩衝）單一來源在 src/physics/character.js，無物理模式同樣沿用
export const PLAYER_RADIUS = 0.35;
const MAX_WALK_SLOPE = 45; // 可走上的最大坡度（°）
const MIN_WALK_NY = Math.cos((MAX_WALK_SLOPE * Math.PI) / 180);
const MAX_RISE_PER_M = Math.tan((MAX_WALK_SLOPE * Math.PI) / 180);
const STEP_UP = 0.35; // 可直接跨上的不連續高差（m）：湖上甲板高出步道 0.3 m（terrain.js DECK_RISE，推測）
const SNAP_DROP = 0.5; // 下坡落差小於此值直接貼地，超過才進入落下狀態（m）
const TURN_RATE = 12; // 朝向追上移動方向的速率（1/s；60 Hz 每幀追上剩餘角度的 TURN_RATE / 60 = 20%）
// 與幀率無關的追向（渲染 dt 下以指數衰減累乘，60 / 120 / 144 Hz 同一段時間轉過的角度相同）：每次追上 1 − exp(−TURN_DECAY · dt)；
// TURN_DECAY 取 60 Hz 時與舊公式 min(1, TURN_RATE · dt) 相同（60 Hz 手感不變）
export const TURN_DECAY = -60 * Math.log(1 - TURN_RATE / 60);
export function turnBlend(dt, decay = TURN_DECAY) {
  return dt > 0 ? 1 - Math.exp(-decay * dt) : 0;
}
const EXIT_SIDE_GAP = 0.8; // 下車點：車身側面再往外多少（m）
const EXIT_SEARCH_RADIUS = 3; // 下車點附近找空位的半徑（m）
const RESPAWN_SEARCH_RADIUS = 6; // 退回步道重生時，步道點附近找空位的半徑（m）
// 被打倒後的起身點（依序）：原地 KO_LOCAL_RADIUS 內空位 → KO_EDGE_RADIUS 內最近道路邊（人行道側）→ 最近 OSM 步道
const KO_LOCAL_RADIUS = 3; // 原地起身的搜尋半徑（m）
const KO_EDGE_RADIUS = 30; // 最近道路邊的搜尋半徑（m）
const KO_EDGE_GAP = 1; // 道路邊起身點：車道邊線再往外多少（m，落在人行道上）
// 擊退位移 → CharacterBody 初速：鎖移動時目標速度 0，stepVelocity 以 DECEL 線性減速，
// 位移 ≈ v0² / (2·DECEL)，v0 = speedForDistance(位移)（含固定步長修正；不再是線性增益，改成直接設定速度）
// 出拳小衝步：輔助瞄準目標距離 > LUNGE_FROM 時往目標衝到 LUNGE_STOP 處，最多 LUNGE_MAX（m）
const LUNGE_STOP = HIT_RADIUS - 0.4;
const LUNGE_FROM = HIT_RADIUS - 0.25;
const LUNGE_MAX = 1.2;
const PLAYER_COLORS = { shirt: '#2e7d4f', pants: '#2b2f3a', skin: '#f1c9a5', hair: '#1b1b1b' }; // 退回行人模型時的服色
const PLAYER_HP = 100;

// @deprecated 攻擊鍵改由整合層決定（input 的 Mouse0 / 觸控攻擊鈕送 Mouse0，再呼叫 player.punch()）；保留匯出僅供舊碼相容
// 滑鼠左鍵出拳：在 dom 上監聽 mousedown，回傳 consume()（本幀之前是否按過左鍵，讀完清除）
// 不論 pointer lock 是否已鎖定都算出拳——未鎖定時同一下點擊另由 input.js 要求鎖定（requestPointerLock 是非同步的，
// 舊版在這裡檢查「已鎖定」才出拳，未鎖定時的第一下永遠只做鎖定）
export function mousePunchListener(dom, input) {
  let pressed = false;
  dom.addEventListener('mousedown', (e) => {
    if (input.enabled && e.button === 0) pressed = true;
  });
  return () => {
    const p = pressed;
    pressed = false;
    return p;
  };
}

// 身高 → 膠囊圓柱段半高：總高 2 × (halfHeight + radius) = 身高
export function capsuleHalfHeight(height, radius = PLAYER_RADIUS) {
  return Math.max(0.05, height / 2 - radius);
}

// 移動意圖：鏡頭前方 (sin, cos)、右方 = 前 × 上；axis = input.moveAxis()（x 右正、y 前正、長度 ≤ 1）
export function moveIntent(axis, camYaw, out = { x: 0, z: 0 }) {
  const fx = Math.sin(camYaw);
  const fz = Math.cos(camYaw);
  out.x = fx * axis.y - fz * axis.x;
  out.z = fz * axis.y + fx * axis.x;
  return out;
}

const _seg = { x: 0, z: 0, d2: 0, t: 0 };

// maxDist 內最近的地面道路邊（車道邊線外 KO_EDGE_GAP，朝 (x, z) 那一側）；沒有回傳 null
export function nearestRoadEdge(x, z, maxDist) {
  let best = null;
  let bestD = maxDist;
  for (const r of surfaceRoads) {
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i];
      const c = r.pts[i + 1];
      closestOnSegment(x, z, a.x, a.z, c.x, c.z, _seg);
      const d = Math.sqrt(_seg.d2);
      if (d - r.hw - KO_EDGE_GAP > bestD) continue;
      // 朝查詢點那一側的法線；查詢點剛好在中心線上時取線段左法線
      let nx = x - _seg.x;
      let nz = z - _seg.z;
      if (d < 1e-6) {
        const len = Math.hypot(c.x - a.x, c.z - a.z) || 1;
        nx = -(c.z - a.z) / len;
        nz = (c.x - a.x) / len;
      } else {
        nx /= d;
        nz /= d;
      }
      const off = r.hw + KO_EDGE_GAP;
      const ex = _seg.x + nx * off;
      const ez = _seg.z + nz * off;
      const de = Math.hypot(ex - x, ez - z);
      if (de <= bestD) {
        bestD = de;
        best = { x: ex, z: ez };
      }
    }
  }
  return best;
}

// 最近的地面 OSM 步道點；沒有步道資料回傳 null
export function nearestFootway(x, z) {
  let best = null;
  for (const r of surfaceFootways) {
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i];
      const c = r.pts[i + 1];
      closestOnSegment(x, z, a.x, a.z, c.x, c.z, _seg);
      if (!best || _seg.d2 < best.d2) best = { x: _seg.x, z: _seg.z, d2: _seg.d2 };
    }
  }
  return best;
}

export class Player {
  constructor(scene, spawn) {
    const variant = playerVariant();
    this.character = createCharacter({ variant, colors: variant === DEFAULT_VARIANT ? PLAYER_COLORS : {} });
    this.height = variantHeight(variant);
    this.capsuleHalfHeight = capsuleHalfHeight(this.height);
    // 駕駛坐姿：manifest 的 Hips 高是行人身高下的值，較高的角色按身高比例放低原點（骨架等比放大，推測）
    this.seatDrop = SEAT_HIPS_HEIGHT * (this.height / variantHeight(DEFAULT_VARIANT) - 1);
    this._seatOff = new THREE.Vector3();
    this.mesh = this.character.root;
    this.mesh.rotation.order = 'YXZ'; // 方塊人倒地時先 yaw 再往後躺
    scene.add(this.mesh);
    const manifest = getCharacterManifest();
    this.anim = new CharacterAnimator(this.character, manifest ? manifest.clips : []);
    // 武器上半身層（缺 clip / 方塊人時只跑計時，姿勢不疊加）
    this.weaponLayer = createWeaponLayer(this.anim, { boneGroups: characterBoneGroups(manifest) });
    this.speedScale = 1; // 步行速度倍率（heavy 委託 0.6）；非有限數或 ≤ 0 當 1
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
    this._jumpSt = createJumpState(); // 無物理模式的 coyote / 跳躍緩衝狀態（物理模式由 CharacterBody 自己管）
    this.locked = false; // 上車動畫等外部鎖定：不讀移動輸入
    this.combat = null;
    this._assist = null; // 輔助瞄準中：{ target（Actor）, t（已轉秒數）}
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
    combat.on('hit', ({ attacker, target, knockback }) => {
      if (target !== this.actor) return;
      this._assist = null;
      if (attacker) this.yaw = Math.atan2(attacker.pos.x - this.pos.x, attacker.pos.z - this.pos.z);
      if (!this.body || !knockback) return;
      // 受擊鎖移動：直接改成擊退速度（原本的移動速度不再疊加），減速到停的位移 = |knockback|
      const d = Math.hypot(knockback.x, knockback.z);
      const v = d > 1e-9 ? speedForDistance(d) / d : 0;
      this.body.vx = knockback.x * v;
      this.body.vz = knockback.z * v;
      this.body.cancelJump();
    });
  }

  // 受擊硬直 / 倒地 / 起身 / 外部鎖定期間不能移動
  get controlLocked() {
    if (this.locked) return true;
    const st = this.combat ? this.combat.stateOf(this.actor) : null;
    return st === 'hit' || st === 'knockdown' || st === 'getup' || st === 'dead';
  }

  // 攻擊鍵：交給 combat（冷卻 / 硬直 / 動畫狀態由 combat 判斷）；回傳是否出拳
  // 出拳成功後找輔助瞄準目標：syncPhysics 內轉向，距離在命中半徑外就小衝步
  punch() {
    if (!this.combat || this.controlLocked || (this.body && !this.body.enabled)) return false;
    if (!this.combat.requestPunch(this.actor)) return false;
    const target = this.combat.assistTarget(this.actor);
    this._assist = target ? { target, t: 0 } : null;
    if (target && this.body) {
      const dx = target.pos.x - this.pos.x;
      const dz = target.pos.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > LUNGE_FROM) {
        // 小衝步：朝目標方向的速度設為「以 DECEL 減速到停正好走完衝步距離」（放開移動時）；垂直分量保留
        const lunge = speedForDistance(Math.min(LUNGE_MAX, d - LUNGE_STOP));
        const ux = dx / d;
        const uz = dz / d;
        const along = this.body.vx * ux + this.body.vz * uz;
        if (along < lunge) {
          this.body.vx += ux * (lunge - along);
          this.body.vz += uz * (lunge - along);
        }
      }
    }
    return true;
  }

  // 輔助瞄準轉向：剩餘時間內等比例轉完，ASSIST_TURN_SEC 時必定正對目標；出拳結束即解除
  _turnToAssist(dt) {
    const as = this._assist;
    const remain = ASSIST_TURN_SEC - as.t;
    as.t += dt;
    const tp = as.target.pos;
    const want = Math.atan2(tp.x - this.pos.x, tp.z - this.pos.z);
    this.yaw += angleDelta(this.yaw, want) * (remain <= dt ? 1 : dt / remain);
    if (this.anim.state !== 'punch') this._assist = null;
  }

  // 切到物理模式：body = CharacterBody；move 掛在物理子步前（每子步一次，跳躍按鍵在第一個子步交給 body）
  // coyote time / 跳躍緩衝在 CharacterBody 內處理；真的起跳那一步才經 jumpGate 觸發 jump 動畫（動畫不接受就不跳）
  attachPhysics(body) {
    this.body = body;
    body.jumpGate = () => !this.controlLocked && this.anim.trigger('jump');
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
    const target = wl > 0 ? (running ? RUN_SPEED : WALK_SPEED) * this._speedK() : 0;

    // 加速 / 減速 / 轉向（與 CharacterBody 相同）
    stepVelocity(this, dt, wx, wz, target);

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
    if (jumpStep(this._jumpSt, dt, input.wasPressed('Space'), this.onGround, () => this.anim.trigger('jump'))) {
      this.vy = JUMP_SPEED;
      this.onGround = false;
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
    jumpLand(this._jumpSt, dt, this.onGround, this.vy);

    this.anim.update(dt, { speed: this.speed, grounded: this.onGround });
    this.weaponLayer.update(dt);
    this.syncMesh();
  }

  // 步行速度倍率（speedScale 限 0–1；非法值當 1）
  _speedK() {
    const k = this.speedScale;
    return Number.isFinite(k) && k > 0 ? Math.min(1, k) : 1;
  }

  _readIntent(input, camYaw) {
    const it = this._intent;
    if (this.controlLocked) {
      it.moveX = 0;
      it.moveZ = 0;
      it.run = false;
      this._jumpQueued = false;
      this.body.cancelJump();
      return;
    }
    // 速度倍率縮放意圖長度：CharacterBody 的目標速度 = 走 / 衝刺頂速 × 意圖長度
    const d = moveIntent(input.moveAxis(), camYaw);
    const k = this._speedK();
    it.moveX = d.x * k;
    it.moveZ = d.z * k;
    // 觸控搖桿推過 STICK_RUN 時 input 會寫入 ShiftLeft（input.js），所以「搖桿推到底」也在這裡
    it.run = input.down('ShiftLeft') || input.down('ShiftRight');
    // 跳：只記「按了」；能否起跳（著地 / coyote / 緩衝、動畫是否接受）由 CharacterBody.move 決定
    if (input.wasPressed('Space')) this._jumpQueued = true;
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
    if (this._assist) this._turnToAssist(dt);
    else if (Math.hypot(it.moveX, it.moveZ) > 1e-3) {
      this.yaw += angleDelta(this.yaw, Math.atan2(it.moveX, it.moveZ)) * turnBlend(dt);
    }
    this.anim.update(dt, { speed: r.speed, grounded: this.onGround });
    this.weaponLayer.update(dt);
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

  // 被打倒後起身（hp 歸零、倒地計時結束）：原地 3 m 內有空位就原地起身；沒有才找 30 m 內最近道路邊，
  // 再沒有才退回最近 OSM 步道。回傳起身點來源 'local' | 'edge' | 'footway'，都找不到回傳 null（留在原地）；物理模式專用
  recoverAfterKnockout(terrain) {
    const b = this.body;
    if (!b || !b.enabled) return null;
    const { x, y, z } = this.pos;
    let source = 'local';
    let spot = b.findFreeSpot(x, y, z, KO_LOCAL_RADIUS);
    if (!spot) {
      const edge = nearestRoadEdge(x, z, KO_EDGE_RADIUS);
      if (edge) spot = b.findFreeSpot(edge.x, terrain.querySurface(edge.x, edge.z, y, this._q).y, edge.z, KO_LOCAL_RADIUS);
      source = 'edge';
    }
    if (!spot) {
      const foot = nearestFootway(x, z);
      if (foot) spot = b.findFreeSpot(foot.x, terrain.querySurface(foot.x, foot.z, Infinity, this._q).y, foot.z, RESPAWN_SEARCH_RADIUS);
      source = 'footway';
    }
    if (!spot) return null;
    b.teleport(spot.x, spot.y, spot.z);
    this.pos.set(spot.x, spot.y, spot.z);
    this.vx = 0;
    this.vz = 0;
    this.vy = 0;
    this.syncMesh();
    return source;
  }

  syncMesh() {
    this.mesh.position.copy(this.pos);
    this.mesh.position.y += SURFACE_OFFSET;
    // 方塊人沒有倒地動作：倒地狀態整個往後躺平
    const lying = this.character.fallback && this.anim.state === 'knockdown';
    this.mesh.rotation.set(lying ? -Math.PI / 2 : 0, this.yaw, 0);
  }

  // 駕駛中：角色原點放在座位點（manifest seat − Hips 高，較高的角色再沿車身下方 seatDrop），姿態跟著車身；動畫停在 drive
  sitOn(vehicle, dt = 0) {
    vehicle.seatWorld(this.mesh.position);
    if (this.seatDrop !== 0) this.mesh.position.add(this._seatOff.set(0, -this.seatDrop, 0).applyQuaternion(vehicle.mesh.quaternion));
    this.mesh.quaternion.copy(vehicle.mesh.quaternion);
    this.pos.copy(this.mesh.position);
    this.yaw = vehicle.yaw;
    this.anim.update(dt, { speed: 0, driving: true });
    this.weaponLayer.update(dt);
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
