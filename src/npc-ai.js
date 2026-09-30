// 行人反應大腦（純邏輯，不 import three / rapier）：每個行人一個 NpcBrain，輸出移動意圖由呼叫端（traffic.js）套用
// 狀態：wander（交還 traffic.js 既有的人行道漫步）/ flee（遠離威脅點跑開）/ fight（對攻擊者還手）/
//   dodge（車輛高速逼近時側跳閃開，之後轉 flee）/ down（倒地中，由 CombatSystem 控制）
// 刺激：被打（onAttacked）、目擊 8 m 內有人被打或被撞（onWitness）、車輛高速逼近（update 時由 ctx.vehicles 偵測）
// 性格：braveness 0..1 依 id 以固定種子（mulberry32）產生；braveness 高於門檻才還手（一般約 25%，壯碩體型較高）
// 不使用 Math.random：隨機一律來自自帶的 mulberry32
//
// update(dt, ctx) → { moveX, moveZ, run, faceYaw, wantPunch, jump, mode }
//   moveX / moveZ：單位方向（0 表示不移動；mode === 'wander' 時兩者為 0，呼叫端照舊走 _updatePed）
//   faceYaw：要面向的 yaw（null = 不覆寫）；jump：閃避起跳當幀為 true；mode：目前狀態
//   wantPunch：本幀已向 combat 請求出拳且被接受（ctx.combat 存在時由大腦直接呼叫 requestPunch，呼叫端不必再呼叫）
// ctx：{ combat?, playerInVehicle?, vehicles?: [{ x, z, vx, vz }] }

export const FIGHT_CHANCE = 0.25; // 一般行人還手比例：多數人被打會逃
export const FIGHT_CHANCE_HEAVY = 0.45; // 壯碩體型（pedestrian_heavy）還手比例較高
export const FLEE_MIN_TIME = 6; // 逃跑持續時間下限（秒）
export const FLEE_MAX_TIME = 10; // 逃跑持續時間上限（秒）：每次逃跑在此區間抽一個值，人群不會同時停下
export const FLEE_SAFE_DIST = 30; // 離威脅點超過此距離（m）就安心回到漫步
export const FIGHT_REACH = 1; // 還手時靠近到此距離（m）才出拳（combat 命中半徑 1.1 m，留一點餘裕）
export const FIGHT_RUN_DIST = 3; // 追擊距離大於此（m）用跑的，貼近後改走以免衝過頭
export const FIGHT_PUNCH_MIN = 0.9; // 還手出拳間隔下限（秒）
export const FIGHT_PUNCH_MAX = 1.4; // 還手出拳間隔上限（秒）：比玩家冷卻慢，玩家打得贏一般路人
export const FIGHT_FIRST_PUNCH = 0.35; // 剛決定還手到第一拳的反應時間（秒）
export const FIGHT_GIVEUP_DIST = 12; // 攻擊者跑離超過此距離（m）就放棄追擊
export const FIGHT_GIVEUP_TIME = 10; // 還手最長持續時間（秒）
export const WITNESS_RADIUS = 8; // 目擊半徑（m）：看到有人被打 / 被撞就逃
export const VEHICLE_THREAT_SPEED = 8; // 車速高於此（m/s，約 29 km/h）才會被嚇到
export const VEHICLE_THREAT_DIST = 3; // 車輛進入此距離（m）內且正在逼近 → 閃避
export const DODGE_TIME = 0.45; // 側跳閃避持續時間（秒），之後轉逃跑

// mulberry32：固定種子的 32-bit 亂數產生器（與 utils.js 同演算法，本檔自帶以免依賴）
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// id（字串或數字）→ 32-bit 種子（FNV-1a）
export function seedFromId(id, base = 0) {
  const s = String(id);
  let h = (0x811c9dc5 ^ base) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function dist2d(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export class NpcBrain {
  // actor：Actor 契約物件（至少要 id、pos）；heavy：壯碩體型；seed：全域種子（例如 CITY_SEED）
  constructor({ actor, heavy = false, seed = 0 }) {
    this.actor = actor;
    this.heavy = heavy;
    this.rng = mulberry32(seedFromId(actor.id, seed));
    this.braveness = this.rng();
    this.state = 'wander';
    this.t = 0; // 目前狀態已持續時間
    this.fleeFrom = null; // 逃離的威脅：{ x, z } 固定點或 { actor }（跟著移動）
    this.fleeDur = 0;
    this.target = null; // fight 的對象 actor
    this.punchT = 0;
    this.dodgeDir = null;
    this.pending = []; // 下一次 update 處理的刺激
    this.intent = { moveX: 0, moveZ: 0, run: false, faceYaw: null, wantPunch: false, jump: false, mode: 'wander' };
  }

  get fights() {
    return this.braveness >= 1 - (this.heavy ? FIGHT_CHANCE_HEAVY : FIGHT_CHANCE);
  }

  // 被打（attacker 為 actor）或被車撞（vehicle 為 { x, z }）
  onAttacked({ attacker = null, vehicle = null } = {}) {
    this.pending.push({ type: 'attacked', attacker, vehicle });
  }

  // 目擊事件：pos 為事發點，threat 為肇事者 actor（可為 null）
  onWitness(pos, threat = null) {
    if (dist2d(pos, this.actor.pos) > WITNESS_RADIUS) return;
    this.pending.push({ type: 'witness', pos: { x: pos.x, z: pos.z }, threat });
  }

  _enter(state) {
    this.state = state;
    this.t = 0;
  }

  // from 缺省（來源不明）時以自身位置為威脅點，沿目前朝向跑開
  _startFlee(from) {
    this.fleeFrom = from || { x: this.actor.pos.x, z: this.actor.pos.z };
    this.fleeDur = FLEE_MIN_TIME + this.rng() * (FLEE_MAX_TIME - FLEE_MIN_TIME);
    this.target = null;
    this._enter('flee');
  }

  _startFight(attacker) {
    if (this.state === 'fight' && this.target === attacker) return;
    this.target = attacker;
    this.punchT = FIGHT_FIRST_PUNCH;
    this._enter('fight');
  }

  _threatPos() {
    const f = this.fleeFrom;
    return f && f.actor ? f.actor.pos : f;
  }

  _canFight(attacker, ctx) {
    if (!attacker || !this.fights) return false;
    return !(attacker.kind === 'player' && ctx.playerInVehicle);
  }

  _handleStimuli(ctx) {
    for (const s of this.pending) {
      if (this.state === 'down') {
        // 倒地中只記下威脅，起身後逃離
        this.fleeFrom = s.attacker ? { actor: s.attacker } : s.vehicle || s.pos || null;
        continue;
      }
      if (s.type === 'attacked') {
        if (s.attacker && this._canFight(s.attacker, ctx)) this._startFight(s.attacker);
        else if (!(this.state === 'fight' && s.attacker === this.target)) this._startFlee(s.attacker ? { actor: s.attacker } : s.vehicle);
      } else if (this.state === 'wander' || this.state === 'flee') {
        // 目擊：正在打架的不分心；漫步 / 逃跑中則（重新）逃離事發點
        this._startFlee(s.threat ? { actor: s.threat } : s.pos);
      }
    }
    this.pending.length = 0;
  }

  // 高速逼近的車輛：回傳閃避方向（垂直車速、往行人所在的那一側）或 null
  _vehicleThreat(ctx) {
    if (!ctx.vehicles) return null;
    const p = this.actor.pos;
    for (const v of ctx.vehicles) {
      const sp = Math.hypot(v.vx, v.vz);
      if (sp <= VEHICLE_THREAT_SPEED) continue;
      const dx = p.x - v.x;
      const dz = p.z - v.z;
      if (Math.hypot(dx, dz) > VEHICLE_THREAT_DIST) continue;
      if (dx * v.vx + dz * v.vz <= 0) continue; // 車正在遠離
      const nx = -v.vz / sp;
      const nz = v.vx / sp;
      const side = dx * nx + dz * nz >= 0 ? 1 : -1;
      return { x: nx * side, z: nz * side, from: { x: v.x, z: v.z } };
    }
    return null;
  }

  update(dt, ctx = {}) {
    const it = this.intent;
    it.moveX = 0;
    it.moveZ = 0;
    it.run = false;
    it.faceYaw = null;
    it.wantPunch = false;
    it.jump = false;
    const actor = this.actor;
    const combat = ctx.combat;

    // 倒地：交給 combat；起身完成後逃離最後的威脅
    if (combat && combat.isDown(actor)) {
      if (this.state !== 'down') this._enter('down');
      this._handleStimuli(ctx);
      it.mode = 'down';
      return it;
    }
    if (this.state === 'down') {
      if (this.fleeFrom) this._startFlee(this.fleeFrom);
      else this._enter('wander');
    }

    this._handleStimuli(ctx);
    if (this.state !== 'dodge') {
      const threat = this._vehicleThreat(ctx);
      if (threat) {
        this.dodgeDir = threat;
        this._enter('dodge');
        it.jump = true;
      }
    }
    this.t += dt;
    const p = actor.pos;

    if (this.state === 'dodge') {
      it.moveX = this.dodgeDir.x;
      it.moveZ = this.dodgeDir.z;
      it.run = true;
      if (this.t >= DODGE_TIME) this._startFlee(this.dodgeDir.from);
    } else if (this.state === 'fight') {
      this._fight(dt, ctx, it);
    }
    if (this.state === 'flee') {
      const from = this._threatPos();
      let dx = p.x - from.x;
      let dz = p.z - from.z;
      const d = Math.hypot(dx, dz);
      if (d > FLEE_SAFE_DIST || this.t >= this.fleeDur) {
        this.fleeFrom = null;
        this._enter('wander');
      } else {
        if (d < 1e-6) {
          dx = Math.sin(actor.yaw || 0);
          dz = Math.cos(actor.yaw || 0);
        } else {
          dx /= d;
          dz /= d;
        }
        it.moveX = dx;
        it.moveZ = dz;
        it.run = true;
        it.faceYaw = Math.atan2(dx, dz);
      }
    }
    it.mode = this.state;
    return it;
  }

  _fight(dt, ctx, it) {
    const target = this.target;
    const combat = ctx.combat;
    // 攻擊者上車：不還手，改逃跑
    if (target.kind === 'player' && ctx.playerInVehicle) {
      this._startFlee({ actor: target });
      return;
    }
    const p = this.actor.pos;
    const dx = target.pos.x - p.x;
    const dz = target.pos.z - p.z;
    const d = Math.hypot(dx, dz);
    const targetDown = combat && combat.isDown(target);
    if (d > FIGHT_GIVEUP_DIST || this.t >= FIGHT_GIVEUP_TIME || targetDown) {
      this.target = null;
      this._enter('wander');
      return;
    }
    if (d > 1e-6) it.faceYaw = Math.atan2(dx, dz);
    if (d > FIGHT_REACH) {
      it.moveX = dx / d;
      it.moveZ = dz / d;
      it.run = d > FIGHT_RUN_DIST;
    }
    this.punchT -= dt;
    if (d <= FIGHT_REACH && this.punchT <= 0) {
      // combat 拒絕（硬直 / 冷卻中）時保持 punchT ≤ 0，下一幀再試
      const ok = combat ? combat.requestPunch(this.actor) : true;
      if (ok) {
        it.wantPunch = true;
        this.punchT = FIGHT_PUNCH_MIN + this.rng() * (FIGHT_PUNCH_MAX - FIGHT_PUNCH_MIN);
      }
    }
  }
}

// 把 CombatSystem 事件轉成各行人大腦的刺激：受害者 onAttacked、事發點 8 m 內的其他行人 onWitness
// brains：Map（actor.id → NpcBrain）；回傳取消訂閱函式
export function wireCombatToBrains(combat, brains) {
  const broadcast = (victim, threat) => {
    for (const b of brains.values()) {
      if (b.actor === victim || b.actor === threat) continue;
      b.onWitness(victim.pos, threat);
    }
  };
  const offHit = combat.on('hit', ({ attacker, target }) => {
    const b = brains.get(target.id);
    if (b) b.onAttacked({ attacker });
    broadcast(target, attacker);
  });
  const offDown = combat.on('knockdown', ({ target, cause, vehicle }) => {
    if (cause !== 'vehicle') return; // 拳擊擊倒已在 'hit' 事件處理
    const b = brains.get(target.id);
    const from = vehicle && vehicle.pos ? { x: vehicle.pos.x, z: vehicle.pos.z } : { x: target.pos.x, z: target.pos.z };
    if (b) b.onAttacked({ vehicle: from });
    broadcast(target, null);
  });
  return () => {
    offHit();
    offDown();
  };
}
