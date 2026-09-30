// 行人反應大腦（純邏輯，不 import three / rapier）：每個行人一個 NpcBrain，輸出移動意圖由呼叫端（traffic.js）套用
// 狀態：wander（交還 traffic.js 既有的人行道漫步）/ flee（遠離威脅點跑開）/ fight（對攻擊者還手）/
//   watch（目擊者圍觀：原地面向事發點，時間到走回漫步）/ dodge（車輛高速逼近時側跳閃開，之後轉 flee）/ down（倒地中，由 CombatSystem 控制）
//   Phase 3 新增：sidestep（喇叭：在車道上 → 往人行道側跳開）/ look（喇叭：人行道上短暫看向車）/ glare（喇叭：少數人停下瞪人）
// 刺激：被打（onAttacked）、目擊 8 m 內有人被打或被撞（onWitness：多數逃跑、WATCH_CHANCE 的人圍觀）、車輛高速逼近（update 時由 ctx.vehicles 偵測）、
//   喇叭 / 槍聲（hear）、恐慌擴散（onPanic：有人被打倒 / 被撞時，逃跑的目擊者把恐慌傳給 PANIC_RADIUS 內的人，每人一次、每傳一層衰減一層）
// Phase 4（契約 §13）：hear({ type: 'gunshot', x, z }) → GUNSHOT_RADIUS 內行人逃跑（不還手，打架 / 圍觀中的也放下逃跑）；
//   被槍擊（onAttacked 的 weapon === 'pistol'）一律逃跑（倒地者起身後逃），不還手；被棒擊照一般被打（還手比例不變）
// 群組（createBrainGroup，由 wireCombatToBrains 建立並掛到各 brain.group）：還手人數上限（同一對象最多 MAX_FIGHTERS 人）與恐慌擴散的鄰居查詢
// 性格：braveness 0..1 依 id 以固定種子（mulberry32）產生；braveness 高於門檻才還手（一般約 25%，壯碩體型較高）
// 不使用 Math.random：隨機一律來自自帶的 mulberry32
//
// update(dt, ctx) → { moveX, moveZ, run, faceYaw, wantPunch, jump, mode }
//   moveX / moveZ：單位方向（0 表示不移動；mode === 'wander' 時兩者為 0，呼叫端照舊走 _updatePed）
//   faceYaw：要面向的 yaw（null = 不覆寫）；jump：閃避起跳當幀為 true；mode：目前狀態
//   wantPunch：本幀已向 combat 請求出拳且被接受（ctx.combat 存在時由大腦直接呼叫 requestPunch，呼叫端不必再呼叫）
// ctx：{ combat?, playerInVehicle?, vehicles?: [{ x, z, vx, vz }], roadSide? }
//   roadSide(x, z, out) → boolean（選配轉接器）：(x, z) 在車道上時回 true 並把「往最近人行道」的水平單位向量寫進 out.x / out.z；
//   沒提供時以喇叭方向估算（離喇叭軸線 HORN_LANE_HALF 內視為在車道上，往垂直軸線、自己所在的那一側跳開）
// 任意 dt：mid / far 由呼叫端以累積 dt 降頻呼叫；所有計時以秒累加，短狀態（閃避 / 側跳）至少輸出一次移動意圖才結束
// 不在每幀配置新物件：意圖、閃避方向、喇叭、側跳方向都用建構時配置的暫存物件；只有刺激事件（被打 / 目擊 / 恐慌）才配置

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
export const WITNESS_RADIUS = 8; // 目擊半徑（m）：看到有人被打 / 被撞就逃（少數圍觀）
export const WATCH_CHANCE = 0.2; // 目擊者圍觀比例：其餘逃跑
export const WATCH_MIN_TIME = 3; // 圍觀持續時間下限（秒）
export const WATCH_MAX_TIME = 5; // 圍觀持續時間上限（秒）：時間到就離開（回漫步）
export const WATCH_FLEE_DIST = 2.5; // 圍觀中肇事者逼近到此距離（m）內 → 改逃跑
export const VEHICLE_THREAT_SPEED = 8; // 車速高於此（m/s，約 29 km/h）才會被嚇到
export const VEHICLE_THREAT_DIST = 3; // 車輛進入此距離（m）內且正在逼近 → 閃避
export const DODGE_TIME = 0.45; // 側跳閃避持續時間（秒），之後轉逃跑
// 喇叭（Phase 3）
export const HORN_RANGE = 15; // 喇叭前方此距離（m）內的行人才有反應
export const HORN_HALF_ANGLE = (40 * Math.PI) / 180; // 喇叭方向 ±40° 扇形
export const HORN_LANE_HALF = 1.8; // 沒有 roadSide 轉接器時：離喇叭軸線此距離（m）內視為擋在車道上
export const HORN_SIDESTEP_MIN = 0.45; // 車道上側跳至少持續（秒）
export const HORN_SIDESTEP_MAX = 1.5; // 側跳最長持續（秒）：有 roadSide 時離開車道即結束，沒有時以此為準
export const HORN_LOOK_MIN = 0.5; // 人行道上看向車的時間下限（秒）
export const HORN_LOOK_MAX = 1; // 看向車的時間上限（秒），之後繼續漫步
export const HORN_GLARE_CHANCE = 0.1; // 人行道上被按喇叭時停下瞪人的比例（每次喇叭各自抽）
export const HORN_GLARE_MIN = 2; // 瞪人時間下限（秒）
export const HORN_GLARE_MAX = 3.5; // 瞪人時間上限（秒）
// 恐慌擴散（Phase 3）
export const PANIC_RADIUS = 5; // 逃跑者把恐慌傳給此半徑（m）內的人
export const PANIC_HOPS = 2; // 目擊者之後再傳幾層（每傳一層衰減一層，傳到 0 就不再往外傳）
export const PANIC_DELAY_MIN = 0.2; // 開始逃跑到把恐慌傳出去的反應時間下限（秒）：人群一圈一圈散開
export const PANIC_DELAY_MAX = 0.5; // 反應時間上限（秒）
// 還手者成群（Phase 3）
export const MAX_FIGHTERS = 2; // 同一對象（通常是玩家）已有此數量的還手者時，下一個被打的人改逃跑
export const DISPERSE_MIN = 2; // 還手對象 hp 歸零倒地後，還手者散去的時間下限（秒）
export const DISPERSE_MAX = 4; // 散去時間上限（秒）
// 槍聲（Phase 4）
export const GUNSHOT_RADIUS = 30; // 槍聲此半徑（m）內的行人逃跑

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

const COS_HORN = Math.cos(HORN_HALF_ANGLE);
const CALM = new Set(['wander', 'look', 'glare', 'sidestep']); // 視同漫步：對目擊 / 恐慌照常反應

// 行人群組：brains（actor.id → NpcBrain 的 Map）供恐慌擴散查鄰居；fighters：還手對象 actor → Set（還手中的 brain）
export function createBrainGroup(brains = new Map()) {
  return { brains, fighters: new Map(), incidentSeq: 0 };
}

// 還手對象目前的還手人數：順手剔除已不在還手、或已被呼叫端移出 brains（行人回收）的 brain，計數不會外漏
export function fighterCount(group, target) {
  const set = group && group.fighters.get(target);
  if (!set) return 0;
  for (const b of set) {
    if (b.state !== 'fight' || b.target !== target || group.brains.get(b.actor.id) !== b) set.delete(b);
  }
  if (!set.size) group.fighters.delete(target);
  return set.size;
}

export class NpcBrain {
  // actor：Actor 契約物件（至少要 id、pos）；heavy：壯碩體型；seed：全域種子（例如 CITY_SEED）
  // group：createBrainGroup()（缺省時由 wireCombatToBrains 掛上）；roadSide：同 ctx.roadSide（ctx 優先）
  constructor({ actor, heavy = false, seed = 0, group = null, roadSide = null }) {
    this.actor = actor;
    this.heavy = heavy;
    this.group = group;
    this.roadSide = roadSide;
    this.rng = mulberry32(seedFromId(actor.id, seed));
    this.braveness = this.rng();
    this.watches = this.rng() < WATCH_CHANCE; // 目擊時圍觀（固定種子，同一人每次反應一致）
    this.state = 'wander';
    this.t = 0; // 目前狀態已持續時間
    this.fleeFrom = null; // 逃離的威脅：{ x, z } 固定點或 { actor }（跟著移動）
    this.fleeDur = 0;
    this.target = null; // fight 的對象 actor
    this.punchT = 0;
    this.dodgeDir = null;
    this.watchAt = null; // 圍觀的事發點 { x, z } 與肇事者
    this.watchThreat = null;
    this.watchDur = 0;
    this.pending = []; // 下一次 update 處理的刺激
    this.dodge = { x: 0, z: 0, from: { x: 0, z: 0 } }; // 閃避方向與肇事車位置（暫存重用）
    this.horn = { x: 0, z: 0, dirX: 0, dirZ: 0 }; // 最近一次聽到的喇叭（暫存重用）
    this.hornPending = false;
    this.shot = { x: 0, z: 0 }; // 最近一次聽到的槍聲位置（暫存重用，也當逃離點）
    this.shotPending = false;
    this.side = { x: 0, z: 0 }; // 側跳方向（往人行道）
    this.faceAt = { x: 0, z: 0 }; // look / glare 面向的點（喇叭來源）
    this.stateDur = 0; // sidestep / look / glare 的持續時間
    this.selfPt = { x: 0, z: 0 }; // 威脅來源不明時的威脅點
    this.fightOn = null; // 已計入 group.fighters 的還手對象
    this.disperseT = 0; // > 0：還手對象 hp 歸零，倒數散去
    this.panicSeen = 0; // 已收過的恐慌事件編號（每人每事件只反應 / 轉傳一次）
    this.relay = null; // 待轉傳的恐慌資訊
    this.relayT = 0;    this.intent = { moveX: 0, moveZ: 0, run: false, faceYaw: null, wantPunch: false, jump: false, mode: 'wander' };
  }

  get fights() {
    return this.braveness >= 1 - (this.heavy ? FIGHT_CHANCE_HEAVY : FIGHT_CHANCE);
  }

  // 被打（attacker 為 actor）或被車撞（vehicle 為 { x, z }）；weapon：'fist' | 'bat' | 'pistol'（pistol = 被槍擊，一律逃跑）
  onAttacked({ attacker = null, vehicle = null, weapon = null } = {}) {
    this.pending.push({ type: 'attacked', attacker, vehicle, weapon });
  }

  // 目擊事件：pos 為事發點，threat 為肇事者 actor 或 { pos }（可為 null）；
  // panic：有人被打倒 / 被撞時由 wireCombatToBrains 帶入的恐慌事件（hops 0），逃跑的目擊者會再往外傳
  onWitness(pos, threat = null, panic = null) {
    if (dist2d(pos, this.actor.pos) > WITNESS_RADIUS) return;
    this.pending.push({ type: 'witness', pos: { x: pos.x, z: pos.z }, threat, panic });
  }

  // 聲音刺激：{ type: 'horn', x, z, dirX, dirZ }，喇叭前方 HORN_RANGE、±40° 內才記下；
  //   { type: 'gunshot', x, z }：GUNSHOT_RADIUS 內才記下；都在下一次 update 處理
  hear(evt) {
    if (evt && evt.type === 'gunshot') return this._hearGunshot(evt);
    if (!evt || evt.type !== 'horn') return false;
    const p = this.actor.pos;
    const dx = p.x - evt.x;
    const dz = p.z - evt.z;
    const d = Math.hypot(dx, dz);
    if (d > HORN_RANGE) return false;
    let fx = evt.dirX || 0;
    let fz = evt.dirZ || 0;
    const fl = Math.hypot(fx, fz);
    if (fl < 1e-6) return false;
    fx /= fl;
    fz /= fl;
    if (d > 1e-6 && (dx * fx + dz * fz) / d < COS_HORN) return false;
    const h = this.horn;
    h.x = evt.x;
    h.z = evt.z;
    h.dirX = fx;
    h.dirZ = fz;
    this.hornPending = true;
    return true;
  }

  _hearGunshot(evt) {
    const p = this.actor.pos;
    if (!(Math.hypot(p.x - evt.x, p.z - evt.z) <= GUNSHOT_RADIUS)) return false;
    this.shot.x = evt.x;
    this.shot.z = evt.z;
    this.shotPending = true;
    return true;
  }

  // 槍聲：倒地中只記下逃離點；其餘狀態（含打架 / 圍觀）一律放下手邊的事逃離槍聲位置
  _onGunshot() {
    this.shotPending = false;
    if (this.state === 'down') {
      if (!this.fleeFrom) this.fleeFrom = this.shot;
      return;
    }
    this._startFlee(this.shot);
  }

  // 恐慌擴散：info = { id, threat, pos, hops }（hops = 已傳幾層）；同一事件每人只收一次
  onPanic(info) {
    if (!info || this.panicSeen === info.id) return false;
    this.panicSeen = info.id;
    this.pending.push({ type: 'panic', info });
    return true;
  }

  _enter(state) {
    if (this.fightOn && state !== 'fight') this._uncountFight();
    this.state = state;
    this.t = 0;
  }

  _uncountFight() {
    const g = this.group;
    const set = g && g.fighters.get(this.fightOn);
    if (set) {
      set.delete(this);
      if (!set.size) g.fighters.delete(this.fightOn);
    }
    this.fightOn = null;
  }

  // from 缺省（來源不明）時以自身位置為威脅點，沿目前朝向跑開
  _startFlee(from) {
    if (!from) {
      this.selfPt.x = this.actor.pos.x;
      this.selfPt.z = this.actor.pos.z;
    }
    this.fleeFrom = from || this.selfPt;
    this.fleeDur = FLEE_MIN_TIME + this.rng() * (FLEE_MAX_TIME - FLEE_MIN_TIME);
    this.target = null;
    this._enter('flee');
  }

  _startWatch(pos, threat) {
    this.watchAt = { x: pos.x, z: pos.z };
    this.watchThreat = threat;
    this.watchDur = WATCH_MIN_TIME + this.rng() * (WATCH_MAX_TIME - WATCH_MIN_TIME);
    this._enter('watch');
  }

  _startFight(attacker) {
    if (this.state === 'fight' && this.target === attacker) return;
    if (this.fightOn) this._uncountFight(); // 換對象
    this._enter('fight');
    this.target = attacker;
    this.punchT = FIGHT_FIRST_PUNCH;
    this.disperseT = 0;
    const g = this.group;
    if (g) {
      let set = g.fighters.get(attacker);
      if (!set) g.fighters.set(attacker, (set = new Set()));
      set.add(this);
      this.fightOn = attacker;
    }
  }

  // 由 update 已設定的 it 暫存計算：面向 (x, z)
  _faceTo(it, x, z) {
    const p = this.actor.pos;
    const dx = x - p.x;
    const dz = z - p.z;
    if (Math.hypot(dx, dz) > 1e-6) it.faceYaw = Math.atan2(dx, dz);
  }

  _threatPos() {
    const f = this.fleeFrom;
    return f && f.actor ? f.actor.pos : f;
  }

  _canFight(attacker, ctx) {
    if (!attacker || !this.fights) return false;
    if (attacker.kind === 'player' && ctx.playerInVehicle) return false;
    if (this.state === 'fight' && this.target === attacker) return true;
    // 已有 MAX_FIGHTERS 人圍著同一對象還手 → 改逃跑（避免圍毆玩家無解）；對象已倒地也不再加入
    if (fighterCount(this.group, attacker) >= MAX_FIGHTERS) return false;
    return !(ctx.combat && ctx.combat.isDown(attacker));
  }

  _calm() {
    return CALM.has(this.state);
  }

  // 目擊 / 恐慌後開始逃跑：記下待轉傳的恐慌（hops 未達 PANIC_HOPS 才往外傳）
  _armRelay(info) {
    if (!info || !this.group || info.hops >= PANIC_HOPS || this.state !== 'flee') return;
    this.relay = info;
    this.relayT = PANIC_DELAY_MIN + this.rng() * (PANIC_DELAY_MAX - PANIC_DELAY_MIN);
  }

  // 把恐慌傳給 PANIC_RADIUS 內的其他行人（下一層資訊每事件每層只配置一次）
  _relayPanic() {
    const info = this.relay;
    this.relay = null;
    const g = this.group;
    if (!g || this.state !== 'flee') return;
    const next = info.next || (info.next = { id: info.id, threat: info.threat, pos: info.pos, hops: info.hops + 1, next: null });
    const p = this.actor.pos;
    const r2 = PANIC_RADIUS * PANIC_RADIUS;
    for (const b of g.brains.values()) {
      if (b === this || b.panicSeen === info.id || b.actor === info.threat) continue;
      const q = b.actor.pos;
      const dx = q.x - p.x;
      const dz = q.z - p.z;
      if (dx * dx + dz * dz <= r2) b.onPanic(next);
    }
  }

  // 喇叭：只有漫步中的人反應；車道上 → 往人行道側跳開，人行道上 → 看一下（少數停下瞪人）
  _onHorn(ctx, it) {
    const h = this.horn;
    this.hornPending = false;
    if (this.state !== 'wander') return;
    const p = this.actor.pos;
    const roadSide = ctx.roadSide || this.roadSide;
    let onRoad;
    if (roadSide) {
      onRoad = !!roadSide(p.x, p.z, this.side);
    } else {
      // 估算：與喇叭軸線的帶號橫向距離（軸線右側為正）
      const lat = (p.x - h.x) * h.dirZ - (p.z - h.z) * h.dirX;
      onRoad = Math.abs(lat) < HORN_LANE_HALF;
      const sgn = lat > 1e-6 ? 1 : lat < -1e-6 ? -1 : this.rng() < 0.5 ? 1 : -1;
      this.side.x = h.dirZ * sgn;
      this.side.z = -h.dirX * sgn;
    }
    this.faceAt.x = h.x;
    this.faceAt.z = h.z;
    if (onRoad) {
      this._enter('sidestep');
      this.stateDur = roadSide ? HORN_SIDESTEP_MAX : HORN_SIDESTEP_MIN + 0.5 * (HORN_SIDESTEP_MAX - HORN_SIDESTEP_MIN);
      it.jump = true;
    } else if (this.rng() < HORN_GLARE_CHANCE) {
      this._enter('glare');
      this.stateDur = HORN_GLARE_MIN + this.rng() * (HORN_GLARE_MAX - HORN_GLARE_MIN);
    } else {
      this._enter('look');
      this.stateDur = HORN_LOOK_MIN + this.rng() * (HORN_LOOK_MAX - HORN_LOOK_MIN);
    }
  }

  _handleStimuli(ctx) {
    if (!this.pending.length) return;
    for (const s of this.pending) {
      if (s.type === 'panic') {
        const info = s.info;
        if (this.state === 'down') {
          if (!this.fleeFrom) this.fleeFrom = info.threat && info.threat.pos ? { actor: info.threat } : info.pos;
          continue;
        }
        // 恐慌：打架 / 圍觀中的不理會（圍觀者已自己看過現場）；漫步 / 逃跑中 → 避開肇事者方向逃跑，並視層數繼續往外傳
        if (this._calm() || this.state === 'flee') {
          this._startFlee(info.threat && info.threat.pos ? { actor: info.threat } : info.pos);
          this._armRelay(info);
        }
        continue;
      }
      if (this.state === 'down') {
        // 倒地中只記下威脅，起身後逃離
        this.fleeFrom = s.attacker ? { actor: s.attacker } : s.vehicle || (s.threat && s.threat.pos ? { actor: s.threat } : s.pos) || null;
        continue;
      }
      if (s.type === 'attacked') {
        if (s.weapon === 'pistol') this._startFlee(s.attacker ? { actor: s.attacker } : null);
        else if (s.attacker && this._canFight(s.attacker, ctx)) this._startFight(s.attacker);
        else if (!(this.state === 'fight' && s.attacker === this.target)) this._startFlee(s.attacker ? { actor: s.attacker } : s.vehicle);
      } else if (this._calm() && this.watches) {
        this._startWatch(s.pos, s.threat);
      } else if (this._calm() || this.state === 'flee') {
        // 目擊：正在打架 / 圍觀的不分心；漫步 / 逃跑中則（重新）逃離事發點（肇事者在場就避開肇事者）
        this._startFlee(s.threat && s.threat.pos ? { actor: s.threat } : s.pos);
        if (s.panic && this.panicSeen !== s.panic.id) {
          this.panicSeen = s.panic.id;
          this._armRelay(s.panic);
        }
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
      const o = this.dodge;
      o.x = nx * side;
      o.z = nz * side;
      o.from.x = v.x;
      o.from.z = v.z;
      return o;
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
      if (this.shotPending) this._onGunshot();
      it.mode = 'down';
      return it;
    }
    if (this.state === 'down') {
      if (this.fleeFrom) this._startFlee(this.fleeFrom);
      else this._enter('wander');
    }

    this._handleStimuli(ctx);
    if (this.shotPending) this._onGunshot();
    if (this.hornPending) this._onHorn(ctx, it);
    if (this.state !== 'dodge') {
      const threat = this._vehicleThreat(ctx);
      if (threat) {
        this.dodgeDir = threat;
        this._enter('dodge');
        it.jump = true;
      }
    }
    if (this.relay) {
      this.relayT -= dt;
      if (this.relayT <= 0) this._relayPanic();
    }
    const p = actor.pos;

    // 計時在狀態處理之後才累加：任意 dt（降頻呼叫）下，剛進入的短狀態至少輸出一次移動意圖
    if (this.state === 'dodge') {
      if (this.t >= DODGE_TIME) this._startFlee(this.dodgeDir.from);
      else {
        it.moveX = this.dodgeDir.x;
        it.moveZ = this.dodgeDir.z;
        it.run = true;
      }
    } else if (this.state === 'sidestep') {
      this._sidestep(ctx, it);
    } else if (this.state === 'look' || this.state === 'glare') {
      if (this.t >= this.stateDur) this._enter('wander');
      else this._faceTo(it, this.faceAt.x, this.faceAt.z);
    } else if (this.state === 'fight') {
      this._fight(dt, ctx, it);
    } else if (this.state === 'watch') {
      this._watch(it);
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
    this.t += dt;
    it.mode = this.state;
    return it;
  }

  // 喇叭側跳：往人行道方向跑開；有 roadSide 時至少 HORN_SIDESTEP_MIN 秒、離開車道即回漫步，否則固定時間
  _sidestep(ctx, it) {
    const p = this.actor.pos;
    const roadSide = ctx.roadSide || this.roadSide;
    if (this.t >= this.stateDur || (roadSide && this.t >= HORN_SIDESTEP_MIN && !roadSide(p.x, p.z, this.side))) {
      this._enter('wander');
      return;
    }
    const sx = this.side.x;
    const sz = this.side.z;
    const l = Math.hypot(sx, sz);
    if (l < 1e-6) {
      this._enter('wander');
      return;
    }
    it.moveX = sx / l;
    it.moveZ = sz / l;
    it.run = true;
    it.faceYaw = Math.atan2(sx, sz);
  }

  // 圍觀：原地面向事發點；時間到回漫步，肇事者逼近就改逃跑
  _watch(it) {
    const p = this.actor.pos;
    const th = this.watchThreat;
    if (th && th.pos && dist2d(th.pos, p) < WATCH_FLEE_DIST) {
      this._startFlee({ actor: th });
      return;
    }
    if (this.t >= this.watchDur) {
      this.watchAt = null;
      this.watchThreat = null;
      this._enter('wander');
      return;
    }
    const dx = this.watchAt.x - p.x;
    const dz = this.watchAt.z - p.z;
    if (Math.hypot(dx, dz) > 1e-6) it.faceYaw = Math.atan2(dx, dz);
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
    // 對象（通常是玩家）被打到 hp 歸零倒地：不再出拳，面向對象站著，DISPERSE_MIN–MAX 秒內散去
    if (this.disperseT > 0 || (targetDown && target.hp <= 0)) {
      if (this.disperseT <= 0) this.disperseT = DISPERSE_MIN + this.rng() * (DISPERSE_MAX - DISPERSE_MIN);
      this.disperseT -= dt;
      if (this.disperseT <= 0) {
        this.disperseT = 0;
        this.target = null;
        this._enter('wander');
        return;
      }
      if (d > 1e-6) it.faceYaw = Math.atan2(dx, dz);
      return;
    }
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

// 把 CombatSystem 事件轉成各行人大腦的刺激：受害者 onAttacked、事發點 8 m 內的其他行人 onWitness；
// 有行人被打倒（'knockdown' cause 'punch'）或被撞（cause 'vehicle'）時目擊帶恐慌事件，逃跑的目擊者再往 PANIC_RADIUS 內擴散
// brains：Map（actor.id → NpcBrain）；group：共用群組（缺省自建，會掛到尚未有群組的 brain.group）；回傳取消訂閱函式
export function wireCombatToBrains(combat, brains, group = createBrainGroup(brains)) {
  const broadcast = (victim, threat, panic) => {
    for (const b of brains.values()) {
      if (!b.group) b.group = group;
      if (b.actor === victim || b.actor === threat) continue;
      b.onWitness(victim.pos, threat, panic);
    }
  };
  const panicOf = (victim, threat) => ({ id: ++group.incidentSeq, threat, pos: { x: victim.pos.x, z: victim.pos.z }, hops: 0, next: null });
  const offHit = combat.on('hit', ({ attacker, target, weapon }) => {
    const b = brains.get(target.id);
    if (b) {
      if (!b.group) b.group = group;
      b.onAttacked({ attacker, weapon });
    }
    broadcast(target, attacker, null);
  });
  const offDown = combat.on('knockdown', ({ target, cause, vehicle, attacker }) => {
    if (target.kind === 'player') return; // 玩家倒地：還手者由 NpcBrain._fight 自行散去
    if (cause !== 'vehicle') {
      // 拳擊 / 棒擊 / 槍擊擊倒：受擊已在 'hit' 事件處理，這裡只補上帶恐慌的目擊
      broadcast(target, attacker || null, panicOf(target, attacker || null));
      return;
    }
    const b = brains.get(target.id);
    const from = vehicle && vehicle.pos ? { x: vehicle.pos.x, z: vehicle.pos.z } : { x: target.pos.x, z: target.pos.z };
    if (b) {
      if (!b.group) b.group = group;
      b.onAttacked({ vehicle: from });
    }
    // 肇事者：駕駛（combat 已解析）或車輛本身（有 pos 就讓逃跑者避開車的方向）
    const threat = attacker || (vehicle && vehicle.pos ? vehicle : null);
    broadcast(target, threat, panicOf(target, threat));
  });
  return () => {
    offHit();
    offDown();
  };
}
