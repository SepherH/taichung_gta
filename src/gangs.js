// 幫派地盤（V2「罪惡之都」，純邏輯：不 import three / rapier，node 可直接測）
// 三個虛構幫派（GANGS，名稱 / 配色皆虛構，不對應真實幫派或族群）各有一塊地盤多邊形（扁平 [x0, z0, x1, z1, …]，世界座標 X 東、Z 南），
//   取自七期既有地標：夜市角頭 = 新光三越．大遠百商圈（夜市外送取餐點 NIGHT_MARKET_DELIVERY.pickup 一帶；OSM 範圍內沒有逢甲 / 大墩夜市）、
//   秋紅谷飆車族 = 秋紅谷廣場（OSM park）周邊、七期西裝幫 = 臺灣大道市政大樓 / 市議會 / 捷運市政府站的市府商辦區；互不重疊、全在地圖界內
//
// createGangs({ bus, rng, config }) → { update(dt, ctx), territoryAt(x, z), hostility(id?), cancel(), dispose(), pedHooks, zones, members, gangs, stats() }
//   bus：core/events 匯流排（訂閱 combat:hit / ped:knockdown / ped:dead / player:busted / player:wasted；發 gang:enter / gang:leave / gang:hostile / gang:driveby / gang:war、weapon:fire）
//   rng：() → [0, 1)（預設 Math.random）；config：覆寫 DEFAULTS 內任一數值（測試用）
//   pedHooks（交給 new Traffic(…, { gangs: gangs.pedHooks })）：
//     onSpawn(c) → 額外同夥人數：市民生成點在地盤內時以 leaderChance 機率成為幫派成員（c.gang、c.look 換幫派配色），回傳 crew 大小 − 1（1–3），
//       Traffic 以同一條路線、同方向同步速在其身後補生成同夥並呼叫 onCrew(c2, leader)——同夥沿人行道成群閒晃；長期成員比例 ≈ memberShare（25–35%）
//     onAttach(p) / onDetach(p)：骨架掛上 / 回池時登記 / 移除成員（成員大腦 brain.override = 幫派 AI）
//   update(dt, ctx)：每幀（遊戲中）；ctx = {
//     frozen（暫停 / 手機 / BUSTED・WASTED / 噴漆：成員停手原地面向、幫派車煞停，計時不前進）,
//     combat（CombatSystem）, cars（createGangCars 的回傳，可省略 = 不開車掃射）, damageVehicle(n)（玩家車扣耐久，可省略）,
//     player: { x, z, actor, inVehicle, aiming, aimDirX, aimDirZ, disabled（倒地 / KO 中） } }
//   territoryAt(x, z) → GANGS 的一筆或 null；hostility(id) → 0–100（省略 id = 三者最大值）
//   cancel()：敵意歸零、成員收手、幫派車回收、計時重置（回主選單 / 開新局）；死亡 / 被捕由 bus 的 player:wasted / player:busted 自動 cancel；
//   dispose()：cancel + 取消訂閱
// 敵意（每幫派 0–100）：
//   ① 玩家步行在某幫地盤內、離該幫成員 LINGER_DIST（6 m）內累計 LINGER_SEC（3 s）→ +lingerGain
//   ② 步行持槍瞄準（ctx.player.aiming）且某成員在準星 AIM_HALF_ANGLE、AIM_RANGE 內 → 該幫 +aimGain（每幫 aimCooldown 秒一次）
//   ③ 攻擊任何成員（combat:hit / ped:knockdown / ped:dead 且 byPlayer）→ 該幫 +attackGain
//   ≥ hostileAt：該幫 ENGAGE_RADIUS 內成員圍攻（近戰衝上來出拳 / 揮棒；持槍者保持 gunMin–gunMax 距離射擊），emit gang:hostile；
//   ≥ drivebyAt：派一台幫派車追玩家，靠近 drivebyRange 內乘客開槍（emit gang:driveby）；結束後冷卻 drivebyCooldown 秒
//   衰減：地盤內最後一次挑釁 decayDelay 秒後每秒 −decayIn；離開該幫地盤每秒 −decayOut；< calmBelow 收手、幫派車離開
// V3 街頭事件：skirmish(sideA, sideB, { a, b, sec, weapon }) → 成員 actor[]（指定骨架行人換成兩幫持槍成員互射 sec 秒，同互毆流程）；warring(actors?) → 互毆中人數
// P15 暴走：enlist(peds, id, { weapon?, gain? }) → 成員 actor[]（指定骨架行人換成 id 幫成員、該幫敵意 + gain → 圍攻玩家）；gangOf(actor) → 幫派 id | null
// 幫派互毆：每 warCheck 秒以 warChance 機率，找一組「入侵的敵對幫派成員（rival crew）」與在地成員（warRadius 內）互毆 warSec 秒
// 開槍：命中率依距離 hitNear → hitFar；命中走 combat.applyHit（weapon 'pistol'）；玩家在車內時以 throughVehicle 扣血並 ctx.damageVehicle 扣車耐久；
//   每發 emit weapon:fire（byPlayer false、gang: id）讓行人聽到槍聲 / 音效（通緝不計：整合層只認 byPlayer）
// 錯開更新：玩家地盤 / 逗留 / 瞄準 / 圍攻名單每 scanSec 秒掃一次（以累積 dt 計，幀率無關）；成員動作由各自大腦（traffic LOD 降頻）推進；
//   成員清單是陣列（swap-remove），update 不配置新物件（只有事件 payload 才配置）
//
// createGangCars(deps) → 幫派車世界轉接（三者 adapter，不 import three）：{ spawn(def, px, pz), drive(car, x, z, hold), brake(car), brakeAll(), alive(car),
//   despawn(car), update(dt, px, pz), muzzle(car, out), cancel(), count() }
//   deps：vehicles（VehicleManager：adopt / remove / vehicles）、dmg（選用，vehicle-damage attach / detach / healthOf）、
//     traffic（spawnSpots(cx, cz, rMin, rMax)、cars（選用，生成點避車））、findRoute（選用）、characters（選用，{ createCharacter, disposeCharacter, CharacterAnimator, clips }：
//     駕駛與乘客穿幫派配色，掛在車身網格下坐在前座）、seatHips（選用，vehicle-model SEAT_HIPS_HEIGHT）、rng、
//     canSee（選用，(fromX, fromZ, toX, toZ) → boolean：生成點只取玩家看不到的）、isKept / onKeep（選用，同 vigilante 逃犯車：玩家正上車的車保留、交整合層回收名單）
//   生成：spawnSpots 環帶點抽 ≤ GANG_CAR_SPAWN_TRIES 次，跳過 GANG_CAR_SPAWN_GAP 內有車、玩家看得到的點；全不合格回 null（呼叫端 drivebyRetry 後重試）
//   車輛 = 一般車型（sedan / suv）換幫派車色；despawn 時玩家在 LEAVE_NEAR 內 → 先開走（遠離玩家）到 LEAVE_FAR 外或 LEAVE_MAX 秒後才回收
//   被搶走（v.driven / isKept）→ v.ai = false、onKeep(v)（玩家的車）；熄火 → v.ai = false、車體留在世界（整合層照一般報廢車回收），兩者都不移除
//   近距離（GANG_CAR_NEAR 內）改追玩家側邊 GANG_CAR_SIDE m 的點並依接近速度煞車（並行，不正面衝撞）；hold > 0（玩家步行）時 hold m 內煞停
import { pointInPolygon, polygonBBox, polygonArea, polygonCentroid } from './geom.js';

// ---------- 幫派定義（虛構） ----------
// outfit：src/characters materialSlots（skin / shirt / pants / hair / shoes）換色，不新增模型；shirts 多色時每人抽一色（花襯衫紅黑相間）
export const GANGS = [
  {
    id: 'nightmarket',
    name: '夜市角頭',
    area: '新光三越．大遠百商圈',
    color: '#e53935',
    carColor: '#6d0f16',
    carType: 'sedan',
    outfit: { shirts: ['#c62828', '#1b1b1b', '#b71c1c'], pants: '#151515', shoes: '#0d0d0d' },
    territory: [430, -250, 600, -285, 765, -205, 785, -40, 740, 75, 560, 85, 445, 10, 420, -120],
  },
  {
    id: 'qiuhonggu',
    name: '秋紅谷飆車族',
    area: '秋紅谷廣場周邊',
    color: '#76ff03',
    carColor: '#2e7d12',
    carType: 'sedan',
    outfit: { shirts: ['#76ff03', '#64dd17'], pants: '#1d2430', shoes: '#f5f5f5' },
    territory: [-70, -470, 120, -525, 305, -470, 345, -320, 300, -160, 150, -115, -25, -165, -85, -320],
  },
  {
    id: 'suits',
    name: '七期西裝幫',
    area: '市政府商辦區',
    color: '#90a4ae',
    carColor: '#111114',
    carType: 'suv',
    outfit: { shirts: ['#17171c'], pants: '#0e0e12', shoes: '#050505', hair: '#101010' },
    territory: [700, 170, 900, 140, 1150, 180, 1230, 300, 1185, 560, 1000, 665, 800, 700, 660, 690, 640, 520, 670, 300],
  },
];
for (const g of GANGS) g.bbox = polygonBBox(g.territory);

// 小地圖 / 大地圖用的地盤色塊（靜態，hud.js / big-map.js 直接畫）
export const GANG_ZONES = GANGS.map((g) => ({ id: g.id, name: g.name, label: `${g.name}地盤`, color: g.color, poly: g.territory, bbox: g.bbox }));

// ---------- 數值（手感設定，推測值；config 可覆寫） ----------
export const DEFAULTS = {
  memberShare: 0.3, // 地盤內生成的市民中幫派成員的長期比例（規格 25–35%）
  crewMin: 2, // 一群 2–4 人
  crewMax: 4,
  rivalChance: 0.1, // 地盤內生成的一群是「入侵的敵對幫派」的機率（互毆來源）
  gunShare: 0.3, // 成員持手槍比例
  batShare: 0.35, // 持球棒比例（其餘空手）
  scanSec: 0.25, // 地盤 / 逗留 / 瞄準 / 圍攻名單掃描間隔（秒）
  lingerDist: 6, // 規格：6 m 內
  lingerSec: 3, // 規格：停留 3 s
  lingerGain: 60,
  aimRange: 30, // 瞄準判定距離（m）
  aimHalfAngle: (10 * Math.PI) / 180, // 準星 ±10°
  aimGain: 70,
  aimCooldown: 1.5,
  attackGain: 100,
  hostileAt: 50,
  drivebyAt: 85,
  calmBelow: 25,
  maxHostility: 100,
  decayDelay: 10, // 地盤內最後一次挑釁後多久開始衰減（秒）
  decayIn: 2, // 地盤內每秒衰減
  decayOut: 6, // 離開地盤每秒衰減
  engageRadius: 45, // 敵意時此半徑內成員圍攻
  maxEngaged: 8, // 同時圍攻玩家的成員上限
  fistReach: 1.0, // 同 npc-ai FIGHT_REACH（combat 命中半徑 1.4 m）
  batReach: 1.4,
  runDist: 2.5, // 近戰追擊距離大於此改用跑的
  fistMin: 0.8, // 出拳間隔（秒）
  fistMax: 1.25,
  batMin: 1.1, // 揮棒間隔
  batMax: 1.6,
  batHitDelay: 0.3, // 揮棒到判定的延遲（約 bat 命中窗開啟）
  batDamage: 25, // NPC 球棒傷害（玩家 35；倒地門檻沿用 combat KNOCKDOWN_RULES.bat）
  gunMin: 6, // 持槍者保持距離下限（m）：太近就後退
  gunMax: 15, // 上限：太遠就靠近
  gunRange: 24, // 射程（m）
  fireMin: 1.0, // 開槍間隔（秒）
  fireMax: 1.8,
  shotDamage: 10, // 每發傷害（警員 15）
  hitNear: 0.6, // 命中率（≤ 5 m）
  hitFar: 0.2, // 命中率（≥ gunRange）
  drivebyRange: 20, // 幫派車乘客開槍距離（m）
  drivebyShotGap: 0.35, // 連發間隔
  drivebyBurst: 5, // 一輪幾發
  drivebyPause: 2.5, // 兩輪之間（秒）
  drivebyFirst: 1.0, // 進入射程到第一發
  drivebyDamage: 8, // 每發傷害（玩家）
  drivebyCarDamage: 25, // 每發命中扣玩家車耐久（vehicle-damage 1000 滿）
  drivebyLife: 45, // 幫派車最長存在秒數
  drivebyGiveUp: 220, // 離玩家超過此距離（m）放棄
  drivebyCooldown: 40, // 一台結束後到下一台的冷卻（秒）
  drivebyRetry: 3, // 生成失敗重試間隔
  drivebyZone: 150, // 玩家離該幫地盤外框此距離內才派車
  warCheck: 20, // 幫派互毆檢查間隔（秒）
  warChance: 0.35,
  warRadius: 25,
  warSec: 12,
};

const TAU = Math.PI * 2;

// 二維長度（Math.hypot 在 V8 不內聯、每次回傳裝箱的浮點數；每幀路徑改用 sqrt）
function len2(x, z) {
  return Math.sqrt(x * x + z * z);
}

// ---------- 地盤幾何（純函式） ----------
export function territoryAt(x, z) {
  for (let i = 0; i < GANGS.length; i++) {
    const g = GANGS[i];
    const b = g.bbox;
    if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
    if (pointInPolygon(x, z, g.territory)) return g;
  }
  return null;
}

// 點到地盤外框（bbox）的距離（m；在框內 = 0）
function bboxDist(b, x, z) {
  const dx = x < b.x0 ? b.x0 - x : x > b.x1 ? x - b.x1 : 0;
  const dz = z < b.z0 ? b.z0 - z : z > b.z1 ? z - b.z1 : 0;
  return len2(dx, dz);
}

function segIntersect(ax, az, bx, bz, cx, cz, dx, dz) {
  const d1 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d2 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  const d3 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d4 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

// 兩多邊形是否重疊（邊相交或一方頂點在另一方內）；測試用
export function polygonsOverlap(a, b) {
  for (let i = 0; i < a.length; i += 2) if (pointInPolygon(a[i], a[i + 1], b)) return true;
  for (let i = 0; i < b.length; i += 2) if (pointInPolygon(b[i], b[i + 1], a)) return true;
  const na = a.length / 2;
  const nb = b.length / 2;
  for (let i = 0; i < na; i++) {
    const i2 = ((i + 1) % na) * 2;
    for (let j = 0; j < nb; j++) {
      const j2 = ((j + 1) % nb) * 2;
      if (segIntersect(a[i * 2], a[i * 2 + 1], a[i2], a[i2 + 1], b[j * 2], b[j * 2 + 1], b[j2], b[j2 + 1])) return true;
    }
  }
  return false;
}

// 多邊形是否簡單（不自交）且面積 > 0；測試用
export function polygonValid(p) {
  if (!Array.isArray(p) || p.length < 6 || p.length % 2 || !p.every(Number.isFinite)) return false;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const i2 = ((i + 1) % n) * 2;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // 相鄰邊
      const j2 = ((j + 1) % n) * 2;
      if (segIntersect(p[i * 2], p[i * 2 + 1], p[i2], p[i2 + 1], p[j * 2], p[j * 2 + 1], p[j2], p[j2 + 1])) return false;
    }
  }
  return polygonArea(p) > 0;
}

export function territoryCenter(g) {
  return polygonCentroid(g.territory);
}

// 由目標成員比例與平均 crew 大小反推「單一生成點成為帶頭者」的機率：share = q·m / (1 + q·(m − 1))
export function leaderChance(share, crewMin, crewMax) {
  const m = (crewMin + crewMax) / 2;
  return share / (m - share * (m - 1));
}

// 開槍命中率：≤ 5 m = hitNear，≥ range = hitFar，之間線性
export function shotHitChance(d, C = DEFAULTS) {
  const k = Math.min(1, Math.max(0, (d - 5) / Math.max(1e-6, C.gunRange - 5)));
  return C.hitNear + (C.hitFar - C.hitNear) * k;
}

// 揮棒命中扇形：目標在攻擊者面向 ±SWING_HALF_ANGLE 內（actor.yaw 未定義時不檢查）
const SWING_HALF_ANGLE = Math.PI / 3;
const SWING_COS = Math.cos(SWING_HALF_ANGLE);
function inSwingCone(a, dx, dz, d) {
  if (!Number.isFinite(a.yaw) || d < 1e-6) return true;
  return (dx * Math.sin(a.yaw) + dz * Math.cos(a.yaw)) / d >= SWING_COS;
}

// ---------- 同夥生成（Traffic._spawnPed 用，純函式） ----------
export const CREW_MIN_GAP = 0.8; // m，同夥與既有行人的最小間距（膠囊剛體不重疊）

// 第 k 名同夥沿路線的 s：排在帶頭者身後 gap·k；超出路線 [s0, s1] 改排到前方 gap·k；前後都超出 → NaN（不生成）
//   不 clamp 到端點：clamp 會讓多名同夥疊在同一點（同 s、同方向同步速，永遠重疊）
export function crewSlotS(leaderS, dir, k, s0, s1, gap) {
  let s = leaderS - dir * gap * k;
  if (s < s0 || s > s1) s = leaderS + dir * gap * k;
  return s < s0 || s > s1 ? NaN : s;
}

// 可補的同夥數：不超過市民總數上限（cap − 目前人數）與剩餘替身 slot
export function crewRoom(crew, cap, count, free) {
  return Math.max(0, Math.min(crew | 0, cap - count, free));
}

function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

// ---------- 幫派邏輯 ----------
export function createGangs({ bus = null, rng = Math.random, config = {} } = {}) {
  const C = { ...DEFAULTS, ...config };
  const LEADER = leaderChance(C.memberShare, C.crewMin, C.crewMax);
  const AIM_COS = Math.cos(C.aimHalfAngle);
  const states = GANGS.map((def) => ({
    def,
    hostility: 0,
    hostile: false,
    calmT: 0, // 距最後一次挑釁的秒數
    lingerT: 0,
    aimCd: 0,
    car: null,
    carCd: 0,
    carLife: 0,
    fireT: 0,
    burst: 0,
    engaged: 0, // 本次掃描時圍攻玩家的成員數
  }));
  const stateOf = new Map(states.map((s) => [s.def.id, s]));
  const list = []; // 已掛骨架的成員（swap-remove）
  const byId = new Map(); // actor.id → 成員
  const cur = { player: null, combat: null, cars: null, damageVehicle: null };
  const tmpDir = { x: 0, z: 0 };
  const st = { crewSeq: 0, scanAcc: 0, warAcc: 0, territory: null, frozen: false, time: 0, shots: 0, hits: 0 };
  const offs = [];

  const emit = (name, payload) => {
    if (bus && bus.emit) bus.emit(name, payload);
  };
  const playerActor = () => (cur.player && cur.player.actor) || null;

  // ---------- 市民 → 成員（Traffic 生成掛鉤） ----------
  function pickWeapon() {
    const r = rng();
    if (r < C.gunShare) return 'pistol';
    if (r < C.gunShare + C.batShare) return 'bat';
    return 'fist';
  }

  function makeMember(c, def, crew, rival) {
    const o = def.outfit;
    const shirt = o.shirts[Math.floor(rng() * o.shirts.length) % o.shirts.length];
    c.gang = { id: def.id, def, crew, rival, weapon: pickWeapon() };
    c.look = { ...(c.look || {}), shirt, pants: o.pants, shoes: o.shoes };
    if (o.hair) c.look.hair = o.hair;
  }

  const pedHooks = {
    // 市民生成（c.x / c.z 已在路線上）：地盤內以 LEADER 機率成為帶頭者；回傳要在其身後補生成的同夥數
    onSpawn(c) {
      if (!c || c.gang) return 0;
      const t = territoryAt(c.x, c.z);
      if (!t || rng() >= LEADER) return 0;
      let def = t;
      if (rng() < C.rivalChance) {
        const others = GANGS.filter((g) => g !== t);
        def = others[Math.floor(rng() * others.length) % others.length];
      }
      makeMember(c, def, ++st.crewSeq, def !== t);
      return C.crewMin - 1 + Math.floor(rng() * (C.crewMax - C.crewMin + 1));
    },
    onCrew(c, leader) {
      if (!c || !leader || !leader.gang) return;
      makeMember(c, leader.gang.def, leader.gang.crew, leader.gang.rival);
    },
    // 骨架掛上：登記成員、接管大腦（brain.override）
    onAttach(p) {
      const c = p && p.citizen;
      if (!c || !c.gang || !p.actor || byId.has(p.actor.id)) return;
      const m = {
        id: p.actor.id,
        gang: c.gang,
        state: stateOf.get(c.gang.id),
        weapon: c.gang.weapon,
        role: c.gang.weapon === 'pistol' ? 'gun' : 'melee',
        crew: c.gang.crew,
        rival: c.gang.rival,
        actor: p.actor,
        brain: p.brain,
        ped: p,
        engaged: false,
        target: null,
        war: false,
        warT: 0,
        attackT: 0,
        swingT: -1,
        fireT: 0,
        idx: list.length,
        drive: null,
      };
      m.drive = (brain, dt, ctx, it) => driveMember(m, brain, dt, ctx, it);
      if (p.brain) p.brain.override = m.drive;
      list.push(m);
      byId.set(m.id, m);
    },
    onDetach(p) {
      const m = p && p.actor ? byId.get(p.actor.id) : null;
      if (!m || m.ped !== p) return;
      removeMember(m);
    },
  };

  function removeMember(m) {
    if (m.brain && m.brain.override === m.drive) m.brain.override = null;
    for (let i = 0; i < list.length; i++) if (list[i].target === m.actor) disengage(list[i]); // 互毆對象回池：骨架 actor 之後會換人用
    byId.delete(m.id);
    const last = list.pop();
    if (last !== m) {
      list[m.idx] = last;
      last.idx = m.idx;
    }
  }

  // ---------- 敵意 ----------
  function engage(m, target, war = false) {
    if (!target) return;
    m.engaged = true;
    m.target = target;
    m.war = war;
    m.warT = war ? C.warSec : 0;
    m.attackT = m.role === 'gun' ? 0.4 + rng() * 0.6 : 0.3 + rng() * 0.4;
    m.fireT = m.attackT;
    m.swingT = -1;
  }

  function disengage(m) {
    m.engaged = false;
    m.target = null;
    m.war = false;
    m.swingT = -1;
  }

  // 該幫在玩家附近的成員加入圍攻（上限 maxEngaged）
  function engageNear(g) {
    const pa = playerActor();
    if (!pa) return;
    let n = 0;
    for (let i = 0; i < list.length; i++) if (list[i].state === g && list[i].engaged && list[i].target === pa) n++;
    const r2 = C.engageRadius * C.engageRadius;
    for (let i = 0; i < list.length && n < C.maxEngaged; i++) {
      const m = list[i];
      if (m.state !== g || (m.engaged && m.target === pa)) continue;
      const dx = m.actor.pos.x - pa.pos.x;
      const dz = m.actor.pos.z - pa.pos.z;
      if (dx * dx + dz * dz > r2) continue;
      engage(m, pa);
      n++;
    }
    g.engaged = n;
  }

  function provoke(g, cause, gain) {
    if (!g || st.frozen) return;
    g.hostility = Math.min(C.maxHostility, g.hostility + gain);
    g.calmT = 0;
    if (!g.hostile && g.hostility >= C.hostileAt) {
      g.hostile = true;
      emit('gang:hostile', { gang: g.def.id, name: g.def.name, hostile: true, level: g.hostility, cause });
    }
    if (g.hostile) engageNear(g);
  }

  function calmDown(g) {
    g.hostile = false;
    const pa = playerActor();
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.state === g && m.engaged && !m.war && (!pa || m.target === pa)) disengage(m);
    }
    g.engaged = 0;
    emit('gang:hostile', { gang: g.def.id, name: g.def.name, hostile: false, level: g.hostility, cause: 'calm' });
  }

  // 玩家攻擊成員（含車撞 / 擊斃）：該幫敵意 + attackGain，被打的成員直接反擊
  function onPlayerAttack(target, attacker) {
    const m = target ? byId.get(target.id) : null;
    if (!m || m.actor !== target) return;
    provoke(m.state, 'attack', C.attackGain);
    if (attacker && !(m.engaged && m.target === attacker)) engage(m, attacker);
  }
  if (bus && bus.on) {
    const sub = (name, fn) => {
      const off = bus.on(name, fn);
      if (typeof off === 'function') offs.push(off);
    };
    sub('combat:hit', (e) => {
      if (e && e.byPlayer && e.target) onPlayerAttack(e.target, e.attacker);
    });
    sub('ped:knockdown', (e) => {
      if (e && e.byPlayer && e.ped) onPlayerAttack(e.ped, playerActor());
    });
    sub('ped:dead', (e) => {
      if (e && e.byPlayer && e.ped) onPlayerAttack(e.ped, e.attacker || playerActor());
    });
    // 死亡 / 被捕（main.js finishRespawn 發）：敵意歸零（BUSTED・WASTED 畫面期間整合層已 frozen）
    sub('player:busted', () => cancel());
    sub('player:wasted', () => cancel());
  }

  // ---------- 開槍（成員步行 / 幫派車乘客共用） ----------
  function shoot(fx, fy, fz, shooter, target, gangId, damage) {
    const combat = cur.combat;
    const tp = target.pos;
    const dx = tp.x - fx;
    const dz = tp.z - fz;
    const d = Math.hypot(dx, dz) || 1;
    tmpDir.x = dx / d;
    tmpDir.z = dz / d;
    const hit = rng() < shotHitChance(d, C);
    let applied = null;
    const pa = playerActor();
    const inCar = target === pa && !!(cur.player && cur.player.inVehicle);
    if (hit && combat && typeof combat.applyHit === 'function') {
      applied = combat.applyHit({
        attacker: shooter,
        target,
        damage,
        weapon: 'pistol',
        dir: tmpDir,
        swingId: typeof combat.newSwingId === 'function' ? combat.newSwingId() : null,
        throughVehicle: inCar,
      });
      if (applied && inCar && cur.damageVehicle) cur.damageVehicle(C.drivebyCarDamage);
    }
    st.shots++;
    if (applied) st.hits++;
    const side = hit ? 0 : (rng() * 2 - 1) * 1.5;
    const ex = tp.x - tmpDir.z * side;
    const ez = tp.z + tmpDir.x * side;
    const ey = (tp.y || 0) + 1.2;
    const len = Math.hypot(ex - fx, ey - fy, ez - fz) || 1;
    emit('weapon:fire', {
      weapon: 'pistol', x: fx, y: fy, z: fz,
      dirX: (ex - fx) / len, dirY: (ey - fy) / len, dirZ: (ez - fz) / len,
      byPlayer: false, police: false, gang: gangId, shooter, hit: !!applied, miss: !hit, ex, ey, ez, dist: len,
    });
    return !!applied;
  }

  // ---------- 成員 AI（掛在 NpcBrain.override，由大腦 update 呼叫；回 true = 本幀意圖由幫派決定） ----------
  function driveMember(m, brain, dt, ctx, it) {
    if (!m.engaged) return false;
    const tgt = m.target;
    if (!tgt || !tgt.pos) {
      disengage(m);
      return false;
    }
    const combat = (ctx && ctx.combat) || cur.combat;
    const a = m.actor;
    const p = a.pos;
    const dx = tgt.pos.x - p.x;
    const dz = tgt.pos.z - p.z;
    const d = len2(dx, dz);
    if (d > 1e-6) it.faceYaw = Math.atan2(dx, dz);
    it.mode = 'gang';
    if (st.frozen) return true; // 凍結：原地面向目標
    if (m.war) {
      m.warT -= dt;
      if (m.warT <= 0 || d > C.warRadius * 2 || (tgt.hp !== undefined && tgt.hp <= 0)) {
        disengage(m);
        return false;
      }
    }
    if (combat && combat.isDown && combat.isDown(tgt)) return true; // 目標倒地：圍著看
    const pa = playerActor();
    const inCar = tgt === pa && !!(cur.player && cur.player.inVehicle);
    if (m.role === 'gun') {
      if (d > C.gunMax) {
        it.moveX = dx / d;
        it.moveZ = dz / d;
        it.run = true;
      } else if (d < C.gunMin && d > 1e-6) {
        it.moveX = -dx / d;
        it.moveZ = -dz / d;
      }
      m.fireT -= dt;
      if (m.fireT <= 0 && d <= C.gunRange) {
        m.fireT = C.fireMin + rng() * (C.fireMax - C.fireMin);
        if (a.anim && a.anim.playUpper) a.anim.playUpper('pistol_fire');
        shoot(p.x, (p.y || 0) + 1.4, p.z, a, tgt, m.gang.id, C.shotDamage);
      }
      return true;
    }
    // 近戰：目標在車內打不到 → 追到車旁站著
    const reach = m.weapon === 'bat' ? C.batReach : C.fistReach;
    if (inCar) {
      if (d > 4 && d > 1e-6) {
        it.moveX = dx / d;
        it.moveZ = dz / d;
        it.run = true;
      }
      return true;
    }
    if (d > reach && d > 1e-6) {
      it.moveX = dx / d;
      it.moveZ = dz / d;
      it.run = d > C.runDist;
    }
    m.attackT -= dt;
    // 前搖中被打進硬直（combat 狀態非 normal）或倒地（大腦剛從 down 回來、狀態還不是 gang）→ 中斷本次揮棒，起身後重新起手
    const ready = !(combat && combat.stateOf) || combat.stateOf(a) === 'normal';
    if (m.swingT >= 0 && (!ready || (brain && brain.state !== 'gang'))) m.swingT = -1;
    if (m.swingT >= 0) {
      m.swingT -= dt;
      if (m.swingT < 0 && d <= reach + 0.4 && inSwingCone(a, dx, dz, d) && combat && combat.applyHit) {
        tmpDir.x = d > 1e-6 ? dx / d : 0;
        tmpDir.z = d > 1e-6 ? dz / d : 1;
        combat.applyHit({ attacker: a, target: tgt, damage: C.batDamage, weapon: 'bat', dir: tmpDir, swingId: combat.newSwingId ? combat.newSwingId() : null });
      }
    }
    if (d <= reach && m.attackT <= 0 && ready) {
      if (m.weapon === 'bat') {
        if (a.anim && a.anim.playUpper) a.anim.playUpper(rng() < 0.5 ? 'bat_swing_a' : 'bat_swing_b');
        m.swingT = C.batHitDelay;
        m.attackT = C.batMin + rng() * (C.batMax - C.batMin);
      } else if (!combat || combat.requestPunch(a)) {
        it.wantPunch = true;
        m.attackT = C.fistMin + rng() * (C.fistMax - C.fistMin);
      }
    }
    return true;
  }

  // ---------- 掃描（scanSec 一次）：地盤進出、逗留、瞄準、圍攻名單 ----------
  function scan(step) {
    const pl = cur.player;
    if (!pl) return;
    const t = territoryAt(pl.x, pl.z);
    if (t !== st.territory) {
      const prev = st.territory;
      st.territory = t;
      if (prev) emit('gang:leave', { gang: prev.id, name: prev.name });
      if (t) emit('gang:enter', { gang: t.id, name: t.name, area: t.area });
    }
    const onFoot = !pl.inVehicle && !pl.disabled;
    // ① 逗留：地盤內、步行、該幫成員 lingerDist 內
    const ld2 = C.lingerDist * C.lingerDist;
    for (let gi = 0; gi < states.length; gi++) {
      const g = states[gi];
      let near = false;
      if (onFoot && t === g.def) {
        for (let i = 0; i < list.length && !near; i++) {
          const m = list[i];
          if (m.state !== g) continue;
          const dx = m.actor.pos.x - pl.x;
          const dz = m.actor.pos.z - pl.z;
          near = dx * dx + dz * dz <= ld2;
        }
      }
      if (!near) {
        g.lingerT = 0;
        continue;
      }
      g.lingerT += step;
      if (g.lingerT >= C.lingerSec - 1e-9) {
        g.lingerT = 0;
        provoke(g, 'linger', C.lingerGain);
      }
    }
    // ② 瞄準：準星 ±aimHalfAngle、aimRange 內的成員
    if (onFoot && pl.aiming) {
      const al = len2(pl.aimDirX || 0, pl.aimDirZ || 0);
      if (al > 1e-6) {
        const ax = pl.aimDirX / al;
        const az = pl.aimDirZ / al;
        for (let i = 0; i < list.length; i++) {
          const m = list[i];
          const g = m.state;
          if (g.aimCd > 0) continue;
          const dx = m.actor.pos.x - pl.x;
          const dz = m.actor.pos.z - pl.z;
          const d = len2(dx, dz);
          if (d > C.aimRange || d < 1e-6 || (dx * ax + dz * az) / d < AIM_COS) continue;
          g.aimCd = C.aimCooldown;
          provoke(g, 'aim', C.aimGain);
        }
      }
    }
    // ③ 圍攻名單：敵意中補人（新掛上骨架的成員）
    for (let gi = 0; gi < states.length; gi++) if (states[gi].hostile) engageNear(states[gi]);
  }

  // ---------- 幫派互毆（低頻） ----------
  function tryWar() {
    if (rng() >= C.warChance) return false;
    const r2 = C.warRadius * C.warRadius;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.rival || a.engaged) continue;
      for (let j = 0; j < list.length; j++) {
        const b = list[j];
        if (b.rival || b.engaged || b.gang.id === a.gang.id) continue;
        const dx = a.actor.pos.x - b.actor.pos.x;
        const dz = a.actor.pos.z - b.actor.pos.z;
        if (dx * dx + dz * dz > r2) continue;
        // 兩群各自的人互找對手（同 crew 的人輪流配對）
        const sideA = [];
        const sideB = [];
        for (const m of list) {
          if (m.engaged) continue;
          if (m.crew === a.crew) sideA.push(m);
          else if (m.crew === b.crew) sideB.push(m);
        }
        for (let k = 0; k < sideA.length; k++) engage(sideA[k], sideB[k % sideB.length].actor, true);
        for (let k = 0; k < sideB.length; k++) engage(sideB[k], sideA[k % sideA.length].actor, true);
        emit('gang:war', { a: a.gang.id, b: b.gang.id, x: (a.actor.pos.x + b.actor.pos.x) / 2, z: (a.actor.pos.z + b.actor.pos.z) / 2 });
        return true;
      }
    }
    return false;
  }

  // ---------- V3 街頭事件槍戰（street-events.js）：指定兩組骨架行人換成兩幫持槍成員，沿用互毆 engage(war) 互射 sec 秒 ----------
  // sideA / sideB：traffic 骨架行人（p.citizen / p.actor / p.brain）；已是成員、大腦已被接管者略過。回傳登記的成員 actor 陣列（任一邊 0 人 → 已登記者照常互毆不了、回 []）
  // 換色只改 c.look（makeMember），骨架重新上色 / 掛槍由呼叫端處理（traffic 只在掛骨架時上色）
  function recruit(peds, def, crew, weapon, out) {
    for (const p of peds) {
      const c = p && p.citizen;
      if (!c || !p.actor || c.gang || byId.has(p.actor.id) || (p.brain && p.brain.override)) continue;
      makeMember(c, def, crew, false);
      if (weapon) c.gang.weapon = weapon; // 省略 = makeMember 依 gunShare / batShare 抽的武器（P15 暴走 enlist）
      pedHooks.onAttach(p);
      const m = byId.get(p.actor.id);
      if (m) out.push(m);
    }
    return out;
  }
  function skirmish(sideA, sideB, { a, b, sec = C.warSec, weapon = 'pistol' } = {}) {
    const ga = GANGS.find((g) => g.id === a);
    const gb = GANGS.find((g) => g.id === b);
    if (!ga || !gb || ga === gb) return [];
    const ma = recruit(sideA || [], ga, ++st.crewSeq, weapon, []);
    const mb = recruit(sideB || [], gb, ++st.crewSeq, weapon, []);
    if (!ma.length || !mb.length) return [...ma, ...mb].map((m) => m.actor);
    for (let k = 0; k < ma.length; k++) engage(ma[k], mb[k % mb.length].actor, true);
    for (let k = 0; k < mb.length; k++) engage(mb[k], ma[k % ma.length].actor, true);
    const all = [...ma, ...mb];
    for (const m of all) m.warT = sec;
    const p0 = ma[0].actor.pos;
    const p1 = mb[0].actor.pos;
    emit('gang:war', { a: ga.id, b: gb.id, x: (p0.x + p1.x) / 2, z: (p0.z + p1.z) / 2, street: true });
    return all.map((m) => m.actor);
  }
  // ---------- P15 暴走（missions/rampage.js）：指定骨架行人換成某幫成員並挑起該幫敵意（圍攻玩家） ----------
  // peds 同 skirmish（已是成員 / 大腦被接管者略過）；weapon 省略 = 依 gunShare / batShare 抽；gain = 敵意增量（預設 hostileAt：立即敵對）
  // 回傳登記的成員 actor 陣列；換色 / 掛槍由呼叫端 repaint
  function enlist(peds, id, { weapon = null, gain = C.hostileAt } = {}) {
    const def = GANGS.find((g) => g.id === id);
    if (!def) return [];
    const ms = recruit(peds || [], def, ++st.crewSeq, weapon, []);
    if (ms.length && gain > 0) provoke(stateOf.get(id), 'rampage', gain);
    return ms.map((m) => m.actor);
  }
  // actor 目前是哪一幫的成員（以登記當時的 actor.id 比對；骨架回池換人 → null）
  function gangOf(actor) {
    const m = actor ? byId.get(actor.id) : null;
    return m && m.actor === actor ? m.gang.id : null;
  }

  // 槍戰中（互毆中）的成員數：actors 省略 = 全部
  function warring(actors = null) {
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.engaged && m.war && (!actors || actors.includes(m.actor))) n++;
    }
    return n;
  }

  // ---------- 開車掃射 ----------
  function endCar(g, reason) {
    const cars = cur.cars;
    if (cars && g.car) cars.despawn(g.car);
    g.car = null;
    g.carCd = C.drivebyCooldown;
    g.burst = 0;
    emit('gang:driveby', { gang: g.def.id, name: g.def.name, phase: 'end', reason });
  }

  function updateCar(g, dt) {
    const cars = cur.cars;
    const pl = cur.player;
    if (g.carCd > 0) g.carCd -= dt;
    if (!cars || !pl) return;
    if (!g.car) {
      if (g.hostility < C.drivebyAt || g.carCd > 0 || pl.disabled || bboxDist(g.def.bbox, pl.x, pl.z) > C.drivebyZone) return;
      g.car = cars.spawn(g.def, pl.x, pl.z);
      if (!g.car) {
        g.carCd = C.drivebyRetry;
        return;
      }
      g.carLife = 0;
      g.burst = 0;
      g.fireT = C.drivebyFirst;
      emit('gang:driveby', { gang: g.def.id, name: g.def.name, phase: 'start' });
      return;
    }
    g.carLife += dt;
    const cp = g.car.pos;
    const d = len2(cp.x - pl.x, cp.z - pl.z);
    if (!cars.alive(g.car)) return endCar(g, 'wrecked');
    if (g.carLife >= C.drivebyLife) return endCar(g, 'timeout');
    if (g.hostility < C.calmBelow) return endCar(g, 'calm');
    if (d > C.drivebyGiveUp) return endCar(g, 'lost');
    // 玩家倒地 / KO：煞停不衝撞；步行：GANG_CAR_HOLD 內煞停（乘客照樣開槍）；車內：並行追擊
    if (pl.disabled) cars.brake(g.car);
    else cars.drive(g.car, pl.x, pl.z, pl.inVehicle ? 0 : GANG_CAR_HOLD);
    const pa = playerActor();
    if (d > C.drivebyRange || pl.disabled || !pa) {
      if (g.fireT < C.drivebyFirst * 0.5) g.fireT = C.drivebyFirst * 0.5;
      return;
    }
    g.fireT -= dt;
    if (g.fireT > 0) return;
    g.burst++;
    g.fireT = g.burst >= C.drivebyBurst ? C.drivebyPause : C.drivebyShotGap;
    if (g.burst >= C.drivebyBurst) g.burst = 0;
    const mz = cars.muzzle ? cars.muzzle(g.car) : null;
    shoot(mz ? mz.x : cp.x, mz ? mz.y : (cp.y || 0) + 1.3, mz ? mz.z : cp.z, null, pa, g.def.id, C.drivebyDamage);
  }

  // ---------- 每幀 ----------
  function update(dt, ctx = {}) {
    cur.combat = ctx.combat || cur.combat;
    cur.cars = ctx.cars !== undefined ? ctx.cars : cur.cars;
    cur.damageVehicle = ctx.damageVehicle || null;
    if (ctx.player) cur.player = ctx.player;
    if (ctx.frozen) {
      st.frozen = true;
      // 全部幫派車（含已結束、正在開走的）煞停；開走計時 leaveT 不前進（cars.update 不跑）
      if (cur.cars && cur.cars.brakeAll) cur.cars.brakeAll();
      else if (cur.cars) {
        for (let gi = 0; gi < states.length; gi++) if (states[gi].car) cur.cars.brake(states[gi].car);
      }
      return;
    }
    st.frozen = false;
    if (!(dt > 0)) return;
    st.time += dt;
    st.scanAcc += dt;
    if (st.scanAcc >= C.scanSec) {
      const step = st.scanAcc;
      st.scanAcc = 0;
      scan(step);
    }
    const pl = cur.player;
    const here = pl ? territoryAt(pl.x, pl.z) : null; // 衰減用（bbox 先篩，3 次多邊形測試）；進出事件仍由掃描發
    for (let gi = 0; gi < states.length; gi++) {
      const g = states[gi];
      if (g.aimCd > 0) g.aimCd -= dt;
      g.calmT += dt;
      const inside = here === g.def;
      const rate = inside ? (g.calmT >= C.decayDelay ? C.decayIn : 0) : C.decayOut;
      if (rate > 0 && g.hostility > 0) g.hostility = Math.max(0, g.hostility - rate * dt);
      if (g.hostile && g.hostility < C.calmBelow) calmDown(g);
      updateCar(g, dt);
    }
    if (cur.cars && pl) cur.cars.update(dt, pl.x, pl.z);
    st.warAcc += dt;
    if (st.warAcc >= C.warCheck) {
      st.warAcc = 0;
      tryWar();
    }
  }

  // 敵意歸零、收手、幫派車回收（回主選單 / 開新局 / 死亡 / 被捕）
  function cancel() {
    for (const g of states) {
      if (g.car && cur.cars) cur.cars.despawn(g.car, true);
      g.car = null;
      g.carCd = 0;
      g.carLife = 0;
      g.burst = 0;
      g.hostility = 0;
      g.hostile = false;
      g.calmT = 0;
      g.lingerT = 0;
      g.aimCd = 0;
      g.engaged = 0;
    }
    for (let i = 0; i < list.length; i++) disengage(list[i]);
    if (cur.cars && cur.cars.cancel) cur.cars.cancel();
    st.scanAcc = 0;
    st.warAcc = 0;
    st.territory = null;
    st.frozen = false;
  }

  function dispose() {
    cancel();
    for (const off of offs) off();
    offs.length = 0;
    while (list.length) removeMember(list[list.length - 1]);
  }

  function hostility(id) {
    if (id !== undefined) {
      const g = stateOf.get(id);
      return g ? g.hostility : 0;
    }
    let max = 0;
    for (let gi = 0; gi < states.length; gi++) if (states[gi].hostility > max) max = states[gi].hostility;
    return max;
  }

  return {
    update,
    territoryAt,
    hostility,
    cancel,
    dispose,
    pedHooks,
    zones: GANG_ZONES,
    gangs: GANGS,
    members: list,
    config: C,
    skirmish,
    warring,
    enlist,
    gangOf,
    isHostile: (id) => !!(stateOf.get(id) && stateOf.get(id).hostile),
    car: (id) => (stateOf.get(id) ? stateOf.get(id).car : null),
    get territory() {
      return st.territory;
    },
    stats: () => ({ members: list.length, engaged: list.filter((m) => m.engaged).length, shots: st.shots, hits: st.hits, crews: st.crewSeq }),
  };
}

// ---------- 幫派車世界轉接（main.js 注入既有車輛 / 角色系統；不 import three） ----------
export const GANG_CAR_SPEED = 16; // m/s，追擊巡航（約 58 km/h）
export const GANG_CAR_DIRECT = 45; // m，此距離內直追（不走路網）
export const GANG_CAR_REROUTE = 2; // s
export const GANG_CAR_SPAWN_MIN = 70; // m，生成環帶（視野外由 traffic.spawnSpots 選車道點）
export const GANG_CAR_SPAWN_MAX = 140;
export const LEAVE_NEAR = 60; // m，回收時玩家在此距離內 → 先開走
export const LEAVE_FAR = 90;
export const LEAVE_MAX = 20; // s
export const GANG_CAR_SPAWN_TRIES = 12;
export const GANG_CAR_SPAWN_GAP = 10; // m，生成點與既有車輛（VehicleManager / 車流）的最小距離（同逃犯車 / 警車）
export const GANG_CAR_NEAR = 25; // m，此距離內放慢、改追玩家側邊點並行
export const GANG_CAR_SIDE = 5; // m，並行時與玩家的橫向間距
export const GANG_CAR_BRAKE = 8; // m，此距離內依接近速度煞車
export const GANG_CAR_HOLD = 10; // m，玩家步行時停在此距離外（不衝撞行人）
const STEER_GAIN = 1.8;
const THROTTLE_GAIN = 0.35;
const STUCK_SEC = 3;
const RIDER_ANIM = { speed: 0, driving: true }; // 乘客動畫 update 參數（重用）
const REVERSE_SEC = 1.5;

export function createGangCars(deps = {}) {
  const { vehicles = null, dmg = null, traffic = null, findRoute = null, characters = null, seatHips = 0.3, rng = Math.random, canSee = null } = deps;
  const isKept = typeof deps.isKept === 'function' ? deps.isKept : () => false;
  const onKeep = typeof deps.onKeep === 'function' ? deps.onKeep : () => {};
  const cars = [];
  const spotBuf = [];
  const muz = { x: 0, y: 0, z: 0 };
  const lastPlayer = { x: 0, z: 0, set: false };
  let time = 0;

  function makeRider(def, seat, side) {
    if (!characters || !characters.createCharacter) return null;
    const o = def.outfit;
    const ch = characters.createCharacter({ variant: 'pedestrian', colors: { shirt: o.shirts[0], pants: o.pants, shoes: o.shoes, ...(o.hair ? { hair: o.hair } : {}) } });
    const anim = characters.CharacterAnimator ? new characters.CharacterAnimator(ch, characters.clips || []) : null;
    if (anim) anim.trigger('enter_car');
    ch.root.position.set(seat.x * side, seat.y - seatHips, seat.z);
    return { ch, anim };
  }

  function nearVehicle(x, z) {
    const g2 = GANG_CAR_SPAWN_GAP * GANG_CAR_SPAWN_GAP;
    for (const v of vehicles.vehicles) if (v.pos && (v.pos.x - x) ** 2 + (v.pos.z - z) ** 2 < g2) return true;
    if (traffic.cars) {
      for (const c of traffic.cars) {
        const p = c.v ? c.v.pos : c.pos;
        if (p && (p.x - x) ** 2 + (p.z - z) ** 2 < g2) return true;
      }
    }
    return false;
  }

  // 環帶點隨機抽：跳過有車（剛體互相穿插）與玩家看得到（憑空出現）的點；全部不合格回 null
  function spawnPoint(px, pz) {
    const spots = traffic.spawnSpots(px, pz, GANG_CAR_SPAWN_MIN, GANG_CAR_SPAWN_MAX, spotBuf);
    if (!spots || !spots.length) return null;
    for (let k = 0; k < GANG_CAR_SPAWN_TRIES; k++) {
      const sp = spots[Math.floor(rng() * spots.length) % spots.length];
      if (nearVehicle(sp.x, sp.z)) continue;
      if (typeof canSee === 'function' && canSee(px, pz, sp.x, sp.z)) continue;
      return sp;
    }
    return null;
  }

  function spawn(def, px, pz) {
    if (!vehicles || !traffic || typeof traffic.spawnSpots !== 'function') return null;
    const sp = spawnPoint(px, pz);
    if (!sp) return null;
    const v = vehicles.adopt({ type: def.carType || 'sedan', color: def.carColor, x: sp.x, z: sp.z, yaw: sp.heading ?? 0 });
    if (!v) return null;
    v.ai = true;
    if (dmg && dmg.attach) dmg.attach(v);
    const seat = (v.spec && v.spec.seat) || { x: 0.37, y: 0.55, z: -0.2 };
    const riders = [];
    for (const side of [1, -1]) {
      const r = makeRider(def, seat, side);
      if (!r) continue;
      if (v.mesh && v.mesh.add) v.mesh.add(r.ch.root);
      riders.push(r);
    }
    const car = {
      v,
      def,
      riders,
      route: null,
      routeIdx: 0,
      routeAt: -Infinity,
      stuckT: 0,
      reverseT: 0,
      reverseSteer: 1,
      leaving: false,
      leaveT: 0,
      removed: false,
      chasing: false,
      hold: 0,
      goalX: px,
      goalZ: pz,
      goal: { x: 0, z: 0 },
      ctl: { throttle: 0, steer: 0, brake: 0, handbrake: false },
      get pos() {
        return v.pos;
      },
    };
    cars.push(car);
    return car;
  }

  function exists(v) {
    return !!vehicles && vehicles.vehicles.includes(v);
  }

  function wrecked(v) {
    const h = dmg && dmg.healthOf ? dmg.healthOf(v) : null;
    return Number.isFinite(h) && h <= 0;
  }

  function alive(car) {
    if (!car || car.removed || !exists(car.v) || car.v.driven || isKept(car.v)) return false;
    return !wrecked(car.v);
  }

  // 回收：乘客消失、停止控制；被搶走（driven / isKept）→ 交還一般車輛並 onKeep（整合層回收名單）；
  //   熄火 → 交還一般車輛、殘骸留在原地（整合層照一般報廢車遠了才回收，不會在玩家眼前消失）；其餘移除剛體 / 網格
  function remove(car) {
    if (car.removed) return;
    car.removed = true;
    for (const r of car.riders) {
      r.ch.root.removeFromParent && r.ch.root.removeFromParent();
      if (characters && characters.disposeCharacter) characters.disposeCharacter(r.ch);
    }
    car.riders.length = 0;
    const i = cars.indexOf(car);
    if (i >= 0) cars.splice(i, 1);
    const v = car.v;
    if (!exists(v)) return;
    v.ai = false;
    if (v.driven || isKept(v)) {
      onKeep(v);
      return;
    }
    if (wrecked(v)) return;
    if (dmg && dmg.detach) dmg.detach(v);
    vehicles.remove(v);
  }

  function brake(car) {
    if (!car || car.removed || !exists(car.v) || car.v.driven) return;
    car.chasing = false;
    const ctl = car.ctl;
    ctl.throttle = 0;
    ctl.steer = 0;
    ctl.brake = 1;
    ctl.handbrake = Math.abs(car.v.speed || 0) < 1;
    car.v.setControls(ctl);
  }

  function control(car, tx, tz, maxSpeed, dt) {
    const v = car.v;
    if (v.body && v.body.kinematic && v.body.setKinematic) v.body.setKinematic(false);
    const rb = v.body && v.body.body;
    if (rb && v.body.active !== false && typeof rb.isEnabled === 'function' && !rb.isEnabled()) rb.setEnabled(true);
    const p = v.pos;
    const ctl = car.ctl;
    let t = car.goal;
    t.x = tx;
    t.z = tz;
    const d = len2(tx - p.x, tz - p.z);
    if (!car.leaving && d > GANG_CAR_DIRECT && typeof findRoute === 'function') {
      if (!car.route || time - car.routeAt >= GANG_CAR_REROUTE) {
        const r = findRoute({ x: p.x, z: p.z }, { x: tx, z: tz });
        car.route = r && r.points && r.points.length >= 2 ? r.points : null;
        car.routeIdx = 1;
        car.routeAt = time;
      }
      const pts = car.route;
      if (pts) {
        while (car.routeIdx < pts.length - 1 && len2(p.x - pts[car.routeIdx].x, p.z - pts[car.routeIdx].z) < 8) car.routeIdx++;
        t = pts[car.routeIdx];
      }
    }
    const speed = v.speed || 0;
    const err = wrapAngle(Math.atan2(t.x - p.x, t.z - p.z) - v.yaw);
    if (car.reverseT > 0) {
      car.reverseT -= dt;
      ctl.throttle = -1;
      ctl.steer = car.reverseSteer;
      ctl.brake = 0;
      ctl.handbrake = false;
      v.setControls(ctl);
      return;
    }
    const corner = Math.max(0.3, 1 - (Math.abs(err) / (Math.PI / 2)) * 0.7);
    const throttle = Math.max(-1, Math.min(1, (maxSpeed * corner - speed) * THROTTLE_GAIN));
    const steer = Math.max(-1, Math.min(1, err * STEER_GAIN));
    if (throttle > 0.3 && Math.abs(speed) < 1) car.stuckT += dt;
    else car.stuckT = 0;
    if (car.stuckT >= STUCK_SEC) {
      car.stuckT = 0;
      car.reverseT = REVERSE_SEC;
      car.reverseSteer = err >= 0 ? -1 : 1;
    }
    ctl.throttle = throttle;
    ctl.steer = steer;
    ctl.brake = 0;
    ctl.handbrake = false;
    v.setControls(ctl);
  }

  return {
    spawn,
    alive,
    // hold > 0：與 (x, z) 保持 hold m 以上（玩家步行時不衝撞）
    drive(car, x, z, hold = 0) {
      if (!car || car.removed || car.leaving || !alive(car)) return;
      car.goalX = x;
      car.goalZ = z;
      car.hold = hold > 0 ? hold : 0;
      car.chasing = true;
    },
    brake,
    // 名單內全部（含 leaving）煞停（frozen 用）
    brakeAll() {
      for (let i = 0; i < cars.length; i++) brake(cars[i]);
    },
    // now = true：立即回收；否則玩家在 LEAVE_NEAR 內先開走（被搶 / 熄火的車一律不移除車體，見 remove）
    despawn(car, now = false) {
      if (!car || car.removed) return;
      if (now || !alive(car) || !lastPlayer.set || len2(car.v.pos.x - lastPlayer.x, car.v.pos.z - lastPlayer.z) > LEAVE_NEAR) {
        remove(car);
        return;
      }
      car.leaving = true;
      car.leaveT = 0;
      car.chasing = false;
    },
    muzzle(car) {
      const v = car.v;
      const s = (v.spec && v.spec.seat) || { x: 0.37, z: -0.2 };
      // 乘客側（本地 −X = 右側）車窗外一點
      const yaw = v.yaw || 0;
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      const lx = -(s.x + 0.5);
      muz.x = v.pos.x + fz * lx + fx * s.z;
      muz.z = v.pos.z - fx * lx + fz * s.z;
      muz.y = (v.pos.y || 0) + 1.3;
      return muz;
    },
    update(dt, px, pz) {
      time += dt;
      lastPlayer.x = px;
      lastPlayer.z = pz;
      lastPlayer.set = true;
      for (let i = cars.length - 1; i >= 0; i--) {
        const car = cars[i];
        if (!alive(car)) {
          // 被搶走 / 熄火：乘客下車消失；車留在世界（被搶 = 玩家的車、耐久照算；熄火 = 殘骸由整合層照一般報廢車回收），見 remove
          remove(car);
          continue;
        }
        for (let k = 0; k < car.riders.length; k++) if (car.riders[k].anim) car.riders[k].anim.update(dt, RIDER_ANIM);
        const p = car.v.pos;
        const d = len2(p.x - px, p.z - pz);
        if (car.leaving) {
          car.leaveT += dt;
          if (d > LEAVE_FAR || car.leaveT >= LEAVE_MAX) {
            remove(car);
            continue;
          }
          // 遠離玩家
          const k = d > 1e-6 ? 1 / d : 0;
          control(car, p.x + (p.x - px) * k * 50, p.z + (p.z - pz) * k * 50, GANG_CAR_SPEED, dt);
        } else if (car.chasing) {
          if (car.hold > 0 && d < car.hold) {
            brake(car);
            car.chasing = true;
            continue;
          }
          if (d >= GANG_CAR_NEAR) {
            control(car, car.goalX, car.goalZ, GANG_CAR_SPEED, dt);
            continue;
          }
          // 近距離：放慢、改追玩家側邊點（車目前在哪一側就留在哪一側），與玩家並行（乘客才打得到），不正面衝撞
          const want = Math.max(6, GANG_CAR_SPEED * (d / GANG_CAR_NEAR));
          const yaw = car.v.yaw || 0;
          const fx = Math.sin(yaw);
          const fz = Math.cos(yaw);
          const rx = p.x - car.goalX;
          const rz = p.z - car.goalZ;
          const side = rx * fz - rz * fx >= 0 ? 1 : -1; // 車在玩家的哪一側（以車頭法向）
          control(car, car.goalX + fz * side * GANG_CAR_SIDE, car.goalZ - fx * side * GANG_CAR_SIDE, want, dt);
          // 依接近速度煞車：朝玩家的速度分量越大、距離越近煞越重
          const closing = d > 1e-6 ? ((car.v.speed || 0) * ((car.goalX - p.x) * fx + (car.goalZ - p.z) * fz)) / d : 0;
          if (d < GANG_CAR_BRAKE && closing > 0 && car.reverseT <= 0) {
            const ctl = car.ctl;
            ctl.throttle = 0;
            ctl.brake = Math.min(1, (closing / 4) * (1 - d / GANG_CAR_BRAKE) + 0.3);
            car.v.setControls(ctl);
          }
        }
      }
    },
    cancel() {
      for (let i = cars.length - 1; i >= 0; i--) remove(cars[i]);
    },
    count: () => cars.length,
    list: cars,
  };
}
