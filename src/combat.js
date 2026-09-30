// 對抗邏輯（純邏輯，不 import three / rapier）：出拳、命中窗扇形查詢、受擊 / 倒地 / 起身 / 死亡狀態
// 依顧問結論：拳擊用命中窗查詢、每拳對每個目標只計傷一次；被車撞 → body.knockdown(衝量) + 倒地動畫 →
//   落穩且確認有空間後起身（首版不做全 ragdoll、不做死亡特效）
//
// Actor 介面契約（整合單元把玩家 / 行人包成此形狀）：
//   { id, kind: 'player'|'pedestrian', pos: {x,y,z}, yaw, hp, maxHp,
//     anim: { trigger(name), state, on(evt, cb) },            // D5a CharacterAnimator；發 'punchHitWindow'（'open' / 'close'）
//     body: { knockdown(impulse), settleCheck() → { settled, clearToStand }, standUp() },  // D2c2 行人剛體
//     faction: 'player'|'civilian',
//     untargetable?: bool,                                     // true 時不受拳擊（例：玩家在車內），車撞仍照算
//     recoverOnKo?: bool }                                     // true：被拳擊打到 hp 歸零只倒地、照常起身（起身時 hp 回滿），不進 dead
// anim 可選 hitStop(sec)：命中瞬間攻守雙方頓幀 HIT_STOP 秒（受擊回饋）
// 起身：standUp + trigger('getup') 後以動畫的 'finished'（name = 'getup'）回 normal；GETUP_TIMEOUT 只是逾時保險
// 座標：X 東、Z 南、Y 上；yaw 前方 = (sin yaw, cos yaw)（同 player.js）
//
// 狀態（stateOf）：normal / hit（受擊硬直）/ knockdown（倒地）/ getup（起身中）/ dead（已發 dead 事件，等呼叫端回收）
// 計時一律用注入的 now()（秒），update(dt) 的 dt 只作介面相容，方便暫停時由 now 決定是否前進
// 事件：on('hit' | 'knockdown' | 'getup' | 'dead', cb)，回傳取消訂閱函式

export const PUNCH_DAMAGE = 20; // 每拳傷害：滿血 100 需 5 拳，但 4 秒內連中 3 拳就先倒地
export const PUNCH_COOLDOWN = 0.55; // 出拳冷卻（秒）：約等於一拳動畫長度，連按不會變機關槍
export const HIT_RADIUS = 1.4; // 命中扇形半徑（m，中心對中心）：手臂長 + 身體寬 + 一點容錯（F3b 用戶回報打不到，由 1.1 放寬）
export const HIT_HALF_ANGLE = Math.PI / 3; // 命中扇形半角 60°：不必精準面向，但背後打不到
export const HIT_MAX_DY = 1.2; // 垂直差上限（m）：樓梯上下一階可打，跨樓層不行
// 輔助瞄準：出拳瞬間 ASSIST_RADIUS 內、前方 ±ASSIST_HALF_ANGLE 內最近的行人，攻擊者在 ASSIST_TURN_SEC 內轉向面對
export const ASSIST_RADIUS = 2.5;
export const ASSIST_HALF_ANGLE = Math.PI / 2; // 「前方 90° 內」= 與面向夾角 ≤ 90°（前半圓）
export const ASSIST_TURN_SEC = 0.15; // 轉身時間上限（秒）：早於命中窗開啟（manifest hitWindow 0.167 s）
export const HIT_STOP = 0.05; // 命中頓幀（秒）：攻守雙方動畫停住一瞬間
export const COMBO_HITS = 3; // 連續受擊幾次倒地
export const COMBO_WINDOW = 4; // 連擊計數時間窗（秒）：4 秒內被打 3 下就倒，讓圍毆有結果
export const HIT_STUN = 0.45; // 受擊硬直（秒）：這段期間不能出拳，被打的一方會稍微吃虧
export const KNOCKBACK_DIST = 0.6; // 受擊水平擊退位移（m，規格 0.4–0.8）：看得出被打退，又不會一拳就打出命中半徑
export const PUNCH_KNOCKDOWN_IMPULSE = 120; // 拳擊擊倒的水平衝量（N·s，推測：以 70 kg 行人約 1.7 m/s 推倒）
export const PUNCH_KNOCKDOWN_LIFT = 0.25; // 拳擊擊倒衝量的上抬比例：稍微離地，倒地比較自然
export const VEHICLE_KNOCKDOWN_SPEED = 3; // 車撞相對速度門檻（m/s）：低於此只是擦碰不倒地（約 11 km/h）
// 車撞傷害分級（依 relSpeed，m/s）：由低到高第一個 maxSpeed 大於 relSpeed 者；數值為手感設定（推測，非實測）
export const VEHICLE_DAMAGE_TIERS = [
  { maxSpeed: 6, damage: 15 }, // 慢速碰撞（< 22 km/h）：倒地但輕傷
  { maxSpeed: 10, damage: 35 }, // 市區慢行（< 36 km/h）
  { maxSpeed: 15, damage: 60 }, // 一般市區車速（< 54 km/h）
  { maxSpeed: Infinity, damage: 100 }, // 高速：直接致命
];
export const VEHICLE_HIT_DEBOUNCE = 0.5; // 同一台車對同一人的碰撞事件去重（秒）：接觸會連續多幀回報
export const GETUP_MIN_DOWN = 1.5; // 倒地至少多久才可起身（秒）：讓倒地動畫與剛體有時間落穩
// 起身逾時保險（秒）：正常由動畫 'finished' 事件回 normal（getup clip 1.5 s，角色 manifest）；
// 動畫沒發事件（例如 anim 被別的 trigger 打斷）時最多等這麼久就強制回 normal
export const GETUP_TIMEOUT = 3;
export const DEAD_HOLD = 10; // hp 歸零後維持倒地多久發 'dead'（秒），由呼叫端回收

// 這些動畫狀態下不能出拳（hit 不在內：受擊硬直以 combat 狀態 'hit'（HIT_STUN）為準，硬直結束即可出拳打斷受擊動作）
const NO_PUNCH_ANIM = new Set(['knockdown', 'getup', 'enter_car', 'drive']);
const COS_HALF = Math.cos(HIT_HALF_ANGLE);
const COS_ASSIST = Math.cos(ASSIST_HALF_ANGLE);

// 命中扇形判斷（純函式，供測試與除錯）：target 是否在 attacker 前方扇形內
export function inPunchCone(attacker, target) {
  const dx = target.pos.x - attacker.pos.x;
  const dz = target.pos.z - attacker.pos.z;
  if (Math.abs(target.pos.y - attacker.pos.y) >= HIT_MAX_DY) return false;
  const d = Math.hypot(dx, dz);
  if (d > HIT_RADIUS) return false;
  if (d < 1e-6) return true; // 完全重疊視為命中
  return (dx * Math.sin(attacker.yaw) + dz * Math.cos(attacker.yaw)) / d >= COS_HALF;
}

// 依相對速度取車撞傷害
export function vehicleDamage(relSpeed) {
  for (const t of VEHICLE_DAMAGE_TIERS) if (relSpeed < t.maxSpeed) return t.damage;
  return VEHICLE_DAMAGE_TIERS[VEHICLE_DAMAGE_TIERS.length - 1].damage;
}

// 輔助瞄準候選判斷（純函式）：target 是否在 attacker 的輔助瞄準範圍內；回傳水平距離，不在範圍內回傳 null
export function assistRange(attacker, target) {
  const dx = target.pos.x - attacker.pos.x;
  const dz = target.pos.z - attacker.pos.z;
  if (Math.abs(target.pos.y - attacker.pos.y) >= HIT_MAX_DY) return null;
  const d = Math.hypot(dx, dz);
  if (d > ASSIST_RADIUS) return null;
  if (d < 1e-6) return 0;
  return (dx * Math.sin(attacker.yaw) + dz * Math.cos(attacker.yaw)) / d >= COS_ASSIST - 1e-9 ? d : null;
}

// anim 的 punchHitWindow 參數容許 'open' / 'close' 字串或 { phase } / { type } 物件
function windowPhase(arg) {
  if (typeof arg === 'string') return arg;
  if (arg && typeof arg === 'object') return arg.phase || arg.type || (arg.open ? 'open' : 'close');
  return null;
}

export class CombatSystem {
  constructor({ now = () => performance.now() / 1000 } = {}) {
    this.now = now;
    this.entries = new Map(); // actor.id → entry
    this.listeners = { hit: [], knockdown: [], getup: [], dead: [] };
    this.punchSeq = 0;
  }

  on(evt, cb) {
    const list = this.listeners[evt];
    if (!list) throw new Error(`CombatSystem 不支援事件 ${evt}`);
    list.push(cb);
    return () => {
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    };
  }

  _emit(evt, payload) {
    for (const cb of this.listeners[evt].slice()) cb(payload);
  }

  register(actor) {
    if (this.entries.has(actor.id)) return;
    const e = {
      actor,
      state: 'normal',
      stateAt: 0, // 進入目前狀態的時間
      cooldownUntil: -Infinity,
      punchId: 0, // 目前這一拳的編號（0 = 還沒出過拳）
      windowOpen: false,
      windowUsed: false, // 目前這一拳的命中窗已開過（動畫重複開窗時換新編號）
      hitIds: new Set(), // 目前這一拳已命中的目標 id（以 punchId 去重）
      hitTimes: [], // 連擊計數用的受擊時間
      dying: false, // hp 歸零：倒地後不起身，DEAD_HOLD 後發 dead
      vehicleHits: new Map(), // vehicle → 上次碰撞時間（去重）
      unsubs: [],
    };
    const offWin = actor.anim.on('punchHitWindow', (arg) => this._onWindow(e, windowPhase(arg)));
    const offDone = actor.anim.on('finished', (name) => {
      if (name === 'getup' && e.state === 'getup') e.state = 'normal';
    });
    e.unsubs = [offWin, offDone].filter((f) => typeof f === 'function');
    this.entries.set(actor.id, e);
  }

  unregister(actor) {
    const e = this.entries.get(actor.id);
    if (!e) return;
    for (const off of e.unsubs) off();
    this.entries.delete(actor.id);
  }

  stateOf(actor) {
    const e = this.entries.get(actor.id);
    return e ? e.state : null;
  }

  // 倒地相關（knockdown / getup / dead）期間 NPC 大腦交給 combat 控制
  isDown(actor) {
    const s = this.stateOf(actor);
    return s === 'knockdown' || s === 'getup' || s === 'dead';
  }

  // 復活 / 重生（hp 歸零或已 dead 的角色）：hp 回滿、取消死亡計時，維持倒地並視為已倒滿 GETUP_MIN_DOWN，
  // 下一次 update 走一般的 settleCheck → standUp → getup 流程（呼叫端可先把角色移到重生點）
  revive(actor) {
    const e = this.entries.get(actor.id);
    if (!e) return false;
    const t = this.now();
    actor.hp = actor.maxHp;
    e.dying = false;
    e.hitTimes.length = 0;
    if (e.state === 'knockdown' || e.state === 'dead') {
      e.state = 'knockdown';
      e.stateAt = t - GETUP_MIN_DOWN;
    }
    return true;
  }

  // 輔助瞄準目標：attacker 前方 ±90°、ASSIST_RADIUS 內最近、可受擊的行人（無則 null）
  assistTarget(attacker) {
    let best = null;
    let bestD = Infinity;
    for (const e of this.entries.values()) {
      const a = e.actor;
      if (a === attacker || a.kind !== 'pedestrian' || a.untargetable) continue;
      if (e.state !== 'normal' && e.state !== 'hit') continue;
      const d = assistRange(attacker, a);
      if (d !== null && d < bestD) {
        bestD = d;
        best = a;
      }
    }
    return best;
  }

  requestPunch(attacker) {
    const e = this.entries.get(attacker.id);
    if (!e || e.state !== 'normal') return false;
    if (NO_PUNCH_ANIM.has(attacker.anim.state)) return false;
    const t = this.now();
    if (t < e.cooldownUntil) return false;
    // 動畫拒絕（例如跳躍中）就不算出拳：不吃冷卻、不開新的一拳
    if (attacker.anim.trigger('punch') === false) return false;
    e.cooldownUntil = t + PUNCH_COOLDOWN;
    e.punchId = ++this.punchSeq;
    e.hitIds.clear();
    e.windowOpen = false;
    e.windowUsed = false;
    return true;
  }

  _onWindow(e, phase) {
    if (phase === 'open') {
      // 動畫自行出拳（未經 requestPunch）時也給一個新編號，確保去重單位是「一拳」
      if (e.punchId === 0 || e.windowUsed) {
        e.punchId = ++this.punchSeq;
        e.hitIds.clear();
      }
      e.windowOpen = e.state === 'normal';
      e.windowUsed = true;
    } else if (phase === 'close') {
      e.windowOpen = false;
    }
  }

  onVehicleHit({ ped, impulse, relSpeed, vehicle = null }) {
    const e = ped && this.entries.get(ped.id);
    if (!e || e.state === 'dead' || !(relSpeed > VEHICLE_KNOCKDOWN_SPEED)) return false;
    const t = this.now();
    if (vehicle) {
      const last = e.vehicleHits.get(vehicle);
      if (last !== undefined && t - last < VEHICLE_HIT_DEBOUNCE) return false;
      e.vehicleHits.set(vehicle, t);
    }
    const damage = vehicleDamage(relSpeed);
    this._damage(e, damage, t, 'vehicle');
    if (e.state === 'knockdown') {
      // 已倒地又被撞：不重播倒地動畫，只扣血並重新計算落穩時間
      e.stateAt = t;
    } else {
      this._knockdown(e, impulse, t, { cause: 'vehicle', vehicle, relSpeed, damage });
    }
    return true;
  }

  // cause：'punch' | 'vehicle'；recoverOnKo 的角色被拳擊打到 hp 歸零不進 dying（倒地後照常起身）
  _damage(e, damage, t, cause) {
    const a = e.actor;
    a.hp = Math.max(0, a.hp - damage);
    if (a.hp <= 0 && !e.dying && !(a.recoverOnKo && cause === 'punch')) {
      e.dying = true;
      e.dyingAt = t;
    }
  }

  _knockdown(e, impulse, t, info) {
    e.state = 'knockdown';
    e.stateAt = t;
    e.windowOpen = false;
    e.hitTimes.length = 0;
    e.actor.body.knockdown(impulse);
    e.actor.anim.trigger('knockdown');
    this._emit('knockdown', { target: e.actor, impulse, ...info });
  }

  _applyPunch(att, e, t) {
    const a = att.actor;
    const target = e.actor;
    this._damage(e, PUNCH_DAMAGE, t, 'punch');
    const hitTimes = e.hitTimes;
    hitTimes.push(t);
    while (hitTimes.length && t - hitTimes[0] > COMBO_WINDOW) hitTimes.shift();
    let dx = target.pos.x - a.pos.x;
    let dz = target.pos.z - a.pos.z;
    let d = Math.hypot(dx, dz);
    if (d < 1e-6) {
      dx = Math.sin(a.yaw);
      dz = Math.cos(a.yaw);
      d = 1;
    }
    dx /= d;
    dz /= d;
    this._emit('hit', {
      attacker: a,
      target,
      damage: PUNCH_DAMAGE,
      hp: target.hp,
      punchId: att.punchId,
      knockback: { x: dx * KNOCKBACK_DIST, y: 0, z: dz * KNOCKBACK_DIST },
    });
    if (a.anim.hitStop) a.anim.hitStop(HIT_STOP);
    if (target.anim.hitStop) target.anim.hitStop(HIT_STOP);
    if (e.dying || target.hp <= 0 || hitTimes.length >= COMBO_HITS) {
      const imp = PUNCH_KNOCKDOWN_IMPULSE;
      this._knockdown(e, { x: dx * imp, y: imp * PUNCH_KNOCKDOWN_LIFT, z: dz * imp }, t, { cause: 'punch', attacker: a, damage: PUNCH_DAMAGE });
    } else {
      e.state = 'hit';
      e.stateAt = t;
      e.windowOpen = false; // 被打斷的拳不再計傷
      target.anim.trigger('hit');
    }
  }

  update(_dt) {
    const t = this.now();
    // 1) 命中窗查詢：開窗期間每幀查扇形，同一拳對同一目標只計一次
    for (const att of this.entries.values()) {
      if (!att.windowOpen) continue;
      for (const e of this.entries.values()) {
        if (e === att || att.hitIds.has(e.actor.id)) continue;
        if (e.state !== 'normal' && e.state !== 'hit') continue; // 倒地 / 起身中不再受擊
        if (e.actor.untargetable) continue;
        if (!inPunchCone(att.actor, e.actor)) continue;
        att.hitIds.add(e.actor.id);
        this._applyPunch(att, e, t);
        if (!att.windowOpen) break; // 攻擊者本身在這一輪被打斷
      }
    }
    // 2) 狀態計時
    for (const e of this.entries.values()) {
      const a = e.actor;
      if (e.state === 'hit') {
        if (t - e.stateAt >= HIT_STUN) e.state = 'normal';
      } else if (e.state === 'knockdown') {
        if (e.dying) {
          if (t - e.dyingAt >= DEAD_HOLD) {
            e.state = 'dead';
            e.stateAt = t;
            this._emit('dead', { target: a });
          }
        } else if (t - e.stateAt >= GETUP_MIN_DOWN) {
          const s = a.body.settleCheck();
          // 倒地動作還沒播完時 animator 會拒絕 getup（回 false）→ 下一幀再試，身體與動畫同步起身
          if (s && s.settled && s.clearToStand && a.anim.trigger('getup') !== false) {
            if (a.hp <= 0) a.hp = a.maxHp; // recoverOnKo：hp 歸零倒地後起身回滿
            a.body.standUp();
            e.state = 'getup';
            e.stateAt = t;
            this._emit('getup', { target: a });
          }
        }
      } else if (e.state === 'getup') {
        if (t - e.stateAt >= GETUP_TIMEOUT) e.state = 'normal';
      }
    }
  }
}
