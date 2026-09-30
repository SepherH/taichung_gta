// 車流與行人：車流沿 OSM 的 primary / secondary / tertiary 折線靠右行駛（臺灣右側通行），
// 到端點就換到相連道路，沒有可接的路或出界就掉頭；公車少量（MAX_BUSES）只走主幹道（BUS_ROAD_TYPES）；行人沿道路邊緣來回走。
// 不做避障（只有「前方有東西就停」的簡單判斷）
// 高度一律取 terrain.querySurface：車輛依四輪貼地並做 pitch / roll（同 vehicle.js），行人在坡上身體保持直立
// 物理（src/physics/npc-bodies.js）：車道 / 人行道邏輯在每個物理子步前算出 pose，交給 kinematic 剛體（setTargetPose / setPose）；
// - NPC 車被強撞（contacts.js onVehicleHitVehicle 超過門檻）→ wrecked 動態剛體，期間跳過車道邏輯；
//   可恢復時 recover() 並以目前位置投影回道路重新對位（橫向偏移由車道邏輯平滑拉回車道）
// 行人 = 骨架角色（src/characters，三種 variant 依固定種子、服色依固定種子隨機）+ CharacterAnimator + combat.js Actor + npc-ai.js NpcBrain：
// - 密度管理（_manageCrowd，每 CROWD_TICK 秒）：以 sync 的 center（玩家 / 鏡頭焦點）為中心，半徑 CROWD_RADIUS 內維持目標人數
//   （PED_TARGET[crowd]：high 50 / low 30）；超出 CROWD_RECYCLE 回收；不足時在 CROWD_SPAWN_MIN–CROWD_RADIUS 環帶、視野外（setView：
//   視錐外或被建築擋住）的生成點（places.js pedestrianRoutes：人行道 / 步道 / 廣場 / 秋紅谷 / 百貨門口，依權重）補生成
// - 物件池：回收的行人留著骨架 / animator（隱藏），下次生成換色重用；骨架總數上限 = 目標 × CROWD_POOL_FACTOR；
//   剛體只給活著的行人（生成時建、回收時移除），所以 CROWD_RECYCLE 外沒有行人剛體
// - 降頻：距中心 > PED_NEAR 的行人 mixer 每 PED_FAR_MIXER_EVERY 幀、大腦每 PED_FAR_AI_EVERY 幀更新一次（累積 dt，錯開幀）
// - ped.state：walk（沿路線區段來回走）/ return（走回路線點）/ react（套用大腦的 flee / fight / watch / dodge 意圖）/ down（倒地，剛體 dynamic）/ getup（起身動畫中）
// - 大腦 mode 為 wander 時走原本的人行道邏輯；否則套用 moveX / moveZ / run / faceYaw，回 wander 時投影回最近的人行道路段再繼續
// - 被打（combat 'hit'）：轉身面向攻擊者、擊退位移以 2D 建築 / 水域檢查滑動（不穿牆）；knockdown → 剛體切 dynamic（npc-bodies hit）+ 倒地動畫；
//   拳擊打到 hp 歸零（actor.recoverOnKo）也只是倒地，1.5 s 起落穩後起身、hp 回滿
// - 被車撞（onVehicleHitPedestrian）→ combat.onVehicleHit；每個物理子步 settleCheck，combat 判定可起身時 standUp（剛體 recover）+ getup
// - 未注入 combat 時自建一個 CombatSystem 並在 sync 內推進（無頭測試 / 單獨使用）；遊戲本體由 main.js 注入共用的 combat 並自行 update
// 網格每幀依插值後的剛體姿態擺放；停用中（setActiveByDistance 半徑外）的剛體不動，網格改用車道 / 人行道 pose
import { TRAFFIC_CAR_COUNT, PED_TARGET, CITY_SEED, SURFACE_OFFSET } from './data/city.js';
import { surfaceRoads, TRAFFIC_TYPES, nodeRoads, nodeKey, inBounds, buildingAt, inWater } from './citymodel.js';
import { samplePolyline, closestOnSegment, SpatialGrid } from './geom.js';
import { Vehicle, meshOrigin } from './vehicle.js';
import { pedestrianRoutes } from './places.js';
import { createCharacter, repaintCharacter, getCharacterManifest, CharacterAnimator } from './characters/index.js';
import { CombatSystem } from './combat.js';
import { NpcBrain, wireCombatToBrains } from './npc-ai.js';
import { mulberry32, angleDelta, randPick } from './utils.js';
import { createNpcCar, createPedestrianBody, PED_RADIUS } from './physics/npc-bodies.js';
import { yawOf } from './physics/vehicle-body.js';

const CAR_COLORS = ['#f2f2f2', '#1f1f22', '#8a8f94', '#b01e28', '#2d5fb0', '#d9d2c0', '#3f6b4a'];
const SHIRTS = ['#d84a4a', '#3a6fd8', '#f2c14e', '#ffffff', '#6a4c93', '#2a9d8f', '#e76f51', '#8d99ae'];
const PANTS = ['#2b2f3a', '#1d3557', '#5c4d3c', '#3d3d3d', '#6b705c'];
const SKINS = ['#f1c9a5', '#e0ac85', '#c68b5f'];
const HAIRS = ['#1b1b1b', '#3b2a20', '#5a4a3a', '#9a9a9a'];

const CRUISE = { primary: 13, secondary: 11, tertiary: 9 };
const REALIGN_MAX_DIST = 30; // wrecked 恢復時離原道路超過此距離（m）就改找最近的車流道路
const PED_ARRIVE = 0.05; // 起身後走回人行道：距人行道點小於此值（m）視為回到路線
const PED_VARIANTS = ['pedestrian', 'pedestrian_f', 'pedestrian_heavy']; // 角色 manifest 的三種 variant
const PED_HEAVY = 'pedestrian_heavy'; // 壯碩體型：大腦還手比例較高
const PED_HP = 100;
const PED_RUN_SPEED = 4.5; // 逃跑 / 追擊跑速（m/s，推測：一般成人慢跑到快跑之間）
const PED_TURN_RATE = 10; // react 狀態轉向速率（1/s）：還手時要很快對準目標
// 密度管理（距離以 sync 的 center 計）
const CROWD_RADIUS = 80; // 維持目標人數的半徑（m）
const CROWD_RECYCLE = 120; // 超出即回收（m）
// 補生成環帶（m）：規格 60–100 m 視野外；實作只取 60 m–CROWD_RADIUS 那一段——補在 80 m 外不計入人數，
// 移動中（80–100 m 的視野外點比 60–80 m 多）會一直補到外圈、80 m 內人數補不回來（crowd.mjs 實測掉到 38 人）
const CROWD_SPAWN_MIN = 60;
const CROWD_POOL_FACTOR = 1.5; // 骨架（物件池）總數上限 = 目標人數 × 此值
const CROWD_SLACK = 0.1; // 80 m 內超過目標此比例才回收多出來的人（視野外、60 m 外、漫步中者）
const CROWD_TICK = 0.1; // 管理頻率（s）
const CROWD_MAX_PER_TICK = 4; // 每次最多補 / 回收幾人（開場補滿不受限）
const CROWD_SPAWN_TRIES = 24; // 每補一人最多抽幾個生成點（開場 ×4）；抽不到就換下一人再試（每次管理共 CROWD_MAX_PER_TICK 人份）
const CROWD_MIN_GAP = 2; // 生成點與現有行人的最小距離（m）
// 前方加權：生成點方向與鏡頭朝向夾角 θ，權重 × (1 + CROWD_AHEAD_BIAS · max(0, cos θ))——前方被建築擋住 / 視野側前方的點
// 優先（玩家往前走時留在 80 m 內較久；補在背後的人幾秒就離開半徑，移動中人數補不回來）
const CROWD_AHEAD_BIAS = 3;
const VIEW_MARGIN = 0.2; // 視錐半角外加的邊距（rad）：畫面邊緣剛好出現的人也算看得到
const LOS_STEP = 5; // 視線被建築遮擋的取樣間距（m）
// 降頻：距中心 > PED_NEAR 的行人 mixer / 大腦隔幀更新
const PED_NEAR = 60;
const PED_FAR_MIXER_EVERY = 3;
const PED_FAR_AI_EVERY = 5;
const PED_KNOCKBACK_DECAY = 12; // 擊退速度的指數衰減率（1/s）：位移總和 = 初速 / 衰減率，約 0.25 s 內推完
const PED_BLOCK_PAD = PED_RADIUS; // 行人自由移動（react / 擊退）時與建築 / 水域保持的距離（m）
const PED_BOUNDS_MARGIN = 3;
const RETURN_SEARCH = 40; // 回 wander 時找路線的搜尋半徑（m）
const MAX_BUSES = 2; // 公車數量（上限 2，計入 TRAFFIC_CAR_COUNT）
// 公車行駛的主幹道：OSM primary（臺灣大道）與 secondary（文心路、黎明路等市區幹道；出生點附近沒有 primary）
const BUS_ROAD_TYPES = new Set(['primary', 'secondary']);
const BUS_MIN_LENGTH = 60; // 出生路段最短長度（m）：12.5 m 車身要有空間
// 前車距離判斷（m）：以 4.5 m 車長為基準的前方 14 m，長車（公車）依車長差加長
const FOLLOW_REACH = 14;
const FOLLOW_BASE_LEN = 4.5;

// 車道偏移（相對道路中心線、行進方向右側）
// 刻意偏向內側，讓出路緣給路邊停車（places.js 的停車位置距路緣約 0.35m）
function laneOffset(road) {
  if (road.oneway) return Math.max(0, Math.min(road.hw * 0.35, road.hw - 3.8));
  return Math.min(road.hw * 0.4, 3.2);
}

const trafficRoads = surfaceRoads.filter((r) => TRAFFIC_TYPES.has(r.type) && r.length > 2);
const trafficSet = new Set(trafficRoads);

// 節點上可以接續的行駛選項：[{ road, dir, s }]
function optionsAt(x, z, fromRoad) {
  const list = nodeRoads.get(nodeKey(x, z)) || [];
  const out = [];
  for (const e of list) {
    const r = e.road;
    if (r === fromRoad || !trafficSet.has(r)) continue;
    const last = r.pts.length - 1;
    if (e.idx < last && r.oneway !== -1) out.push({ road: r, dir: 1, s: r.cum[e.idx] });
    if (e.idx > 0 && r.oneway !== 1) out.push({ road: r, dir: -1, s: r.cum[e.idx] });
  }
  return out;
}

// 點 (x, z) 投影到道路折線：回傳 { s（沿線距離）, d2（距離平方）, lat（道路前進方向右側的帶號偏移，同 laneOffset）}
export function projectOnRoad(road, x, z) {
  const seg = { x: 0, z: 0, d2: 0, t: 0 };
  let best = null;
  for (let i = 0; i < road.pts.length - 1; i++) {
    const a = road.pts[i];
    const b = road.pts[i + 1];
    closestOnSegment(x, z, a.x, a.z, b.x, b.z, seg);
    if (best && seg.d2 >= best.d2) continue;
    const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const dx = (b.x - a.x) / L;
    const dz = (b.z - a.z) / L;
    // 右側單位向量 = (−dz, dx)（與 _place 的 x = cx − dz·lat、z = cz + dx·lat 相同）
    best = { s: road.cum[i] + seg.t * L, d2: seg.d2, lat: (x - seg.x) * -dz + (z - seg.z) * dx, dx, dz };
  }
  return best;
}

// 行人路線與生成點的空間網格（全域只建一次）
const SPOT_CELL = 25;
let spotCache = null;
function pedSpots() {
  if (spotCache) return spotCache;
  const grid = new SpatialGrid(SPOT_CELL);
  for (const sp of pedestrianRoutes().spots) grid.insert(sp, sp.x, sp.z, sp.x, sp.z);
  spotCache = { grid };
  return spotCache;
}

function allowedDirs(road) {
  if (road.oneway === 1) return [1];
  if (road.oneway === -1) return [-1];
  return [1, -1];
}

export class Traffic {
  // terrain：唯一高度場（需有 querySurface）；physics = { RAPIER, pw（PhysicsWorld）, router（contacts.js）, groups }
  // combat：共用的 CombatSystem（省略 → 自建並在 sync 內 update）
  // crowd：效能分級 'high' | 'low'（mobile.js qualityTier），決定行人目標人數
  constructor(scene, { center = { x: 0, z: 0 }, terrain, physics, combat = null, crowd = 'high' }) {
    const { pw, router } = physics;
    this.pw = pw;
    this.terrain = terrain;
    this.center = center;
    this.blockers = [];
    this._q = {};
    const rng = mulberry32(CITY_SEED + 1);
    this.rng = rng;
    this.cars = [];
    this.peds = [];
    this.stats = { uTurns: 0, switches: 0 };
    const tmp = { x: 0, z: 0, dx: 0, dz: 1, seg: 0 };
    this._tmp = tmp;
    this.clock = 0;
    this.ownsCombat = !combat;
    this.combat = combat || new CombatSystem({ now: () => this.clock });
    this.brains = new Map(); // actor.id → NpcBrain
    this.context = { combat: this.combat, playerInVehicle: false, vehicles: [] };
    this._vehRefs = new WeakMap(); // 撞人的車輛實體 → { body, pos }（combat 去重 key 與 npc-ai 事發點）

    // 車流：從出生點附近的主要道路上挑起點（依長度加權）
    const near = trafficRoads.filter((r) => r.pts.some((p) => Math.hypot(p.x - center.x, p.z - center.z) < 450));
    const pool = near.length ? near : trafficRoads;
    const total = pool.reduce((s, r) => s + r.length, 0);
    // 公車先出（另開種子，不改動一般車流的抽樣序列）：出生點附近的主幹道
    const busRng = mulberry32(CITY_SEED + 3);
    const busPool = pool.filter((r) => BUS_ROAD_TYPES.has(r.type) && r.length >= BUS_MIN_LENGTH);
    for (let k = 0, tries = 0; k < Math.min(MAX_BUSES, TRAFFIC_CAR_COUNT) && busPool.length && tries++ < 50; ) {
      const road = busPool[Math.floor(busRng() * busPool.length)];
      const s = road.length * (0.15 + busRng() * 0.7);
      samplePolyline(road, s, tmp);
      if (!inBounds(tmp.x, tmp.z, 20)) continue;
      if (this.cars.some((c) => Math.hypot(c.v.pos.x - tmp.x, c.v.pos.z - tmp.z) < 40)) continue;
      const dir = randPick(busRng, allowedDirs(road));
      this._spawnCar(scene, physics, 'bus', null, road, dir, s, 0.9 + busRng() * 0.2);
      k++;
    }
    let guard = 0;
    while (this.cars.length < TRAFFIC_CAR_COUNT && pool.length && guard++ < 500) {
      let pick = rng() * total;
      let road = pool[0];
      for (const r of pool) {
        pick -= r.length;
        if (pick <= 0) {
          road = r;
          break;
        }
      }
      const s = road.length * (0.15 + rng() * 0.7);
      samplePolyline(road, s, tmp);
      if (!inBounds(tmp.x, tmp.z, 20)) continue;
      if (this.cars.some((c) => Math.hypot(c.v.pos.x - tmp.x, c.v.pos.z - tmp.z) < 25)) continue;
      const dir = randPick(rng, allowedDirs(road));
      const type = randPick(rng, ['sedan', 'sedan', 'taxi', 'suv']);
      const color = type === 'taxi' ? '#f5c518' : randPick(rng, CAR_COLORS);
      this._spawnCar(scene, physics, type, color, road, dir, s, 0.9 + rng() * 0.2);
    }

    // 行人：路線 / 生成點（places.js，固定種子、全域只算一次）+ 物件池；開場在 center 附近補滿目標人數
    this.scene = scene;
    this.physics = physics;
    this.crowdTarget = PED_TARGET[crowd] ?? PED_TARGET.high;
    this.poolMax = Math.ceil(this.crowdTarget * CROWD_POOL_FACTOR);
    this.pedPool = []; // 已回收、待重用的行人（骨架 / animator 保留，網格隱藏）
    this.pedRng = mulberry32(CITY_SEED + 11); // 行人 variant / 服色 / 路線方向與步速
    this.view = null; // setView：鏡頭位置與水平朝向（null = 全部視為視野外）
    this.frame = 0;
    this._crowdT = 0;
    this._spawnSeq = 0;
    this._spotQ = [];
    this._cand = [];
    this._candW = [];
    const manifest = getCharacterManifest();
    this._clips = manifest ? manifest.clips : [];
    Object.assign(this.stats, { pedCreated: 0, spawned: 0, recycled: 0 });
    this.spotGrid = pedSpots().grid;
    this._manageCrowd(center, true);

    pw.onBeforeStep((dt) => this._step(dt));
    pw.onAfterStep((dt) => this._afterStep(dt));
    router.onVehicleHitVehicle(({ a, b, impulse, dir }) => {
      if (b.kind === 'npcCar') b.hit({ impulse, dir });
      if (a.kind === 'npcCar') a.hit({ impulse, dir: { x: -dir.x, y: -dir.y, z: -dir.z } });
    });
    // 車撞行人 → combat（門檻、傷害分級、去重、倒地 / 起身都由 combat 決定）；衝量改成向量交給 Actor.body.knockdown
    router.onVehicleHitPedestrian(({ vehicle, ped, impulse, relSpeed, dir }) => {
      const actor = ped.owner && ped.owner.actor;
      if (!actor) return;
      this.combat.onVehicleHit({ ped: actor, relSpeed, vehicle: this._vehicleRef(vehicle), impulse: { x: dir.x * impulse, y: dir.y * impulse, z: dir.z * impulse } });
    });
    wireCombatToBrains(this.combat, this.brains);
    // 被打：轉身面向攻擊者（受擊動作看得出是被誰打）+ 擊退
    this.combat.on('hit', ({ attacker, target, knockback }) => {
      const p = target.ped;
      if (!p || !p.alive) return;
      if (attacker) p.yaw = Math.atan2(attacker.pos.x - p.x, attacker.pos.z - p.z);
      if (!knockback) return;
      p.kbx += knockback.x * PED_KNOCKBACK_DECAY;
      p.kbz += knockback.z * PED_KNOCKBACK_DECAY;
    });
    // 行人被車撞到 hp 歸零：DEAD_HOLD 後 combat 發 dead → 首版直接復活（hp 回滿、原地起身）
    this.combat.on('dead', ({ target }) => {
      if (target.ped && target.ped.alive) this.combat.revive(target);
    });
  }

  // 新建一個行人（骨架 + animator + Actor 包裝，尚未生成）；只在物件池不夠時呼叫
  _createPed() {
    const variant = randPick(this.pedRng, PED_VARIANTS);
    const character = createCharacter({ variant });
    const mesh = character.root;
    mesh.rotation.order = 'YXZ'; // 方塊人倒地時先 yaw 再往後躺
    mesh.visible = false;
    this.scene.add(mesh);
    const ped = { mesh, character, variant, road: null, off: 0, s: 0, s0: 0, s1: 0, dir: 1, speed: 1.3, yaw: 0, y: Infinity, x: 0, z: 0, state: 'walk', alive: false, body: null, interp: null };
    this._initPedCombat(ped, variant, this._clips);
    this.stats.pedCreated++;
    return ped;
  }

  // 在生成點 spot 放出一個行人（物件池優先；池空且未達上限才新建）；回傳 ped 或 null
  _spawnPed(spot) {
    let p = this.pedPool.pop();
    if (!p && this.peds.length < this.poolMax) p = this._createPed();
    if (!p) return null;
    const rng = this.pedRng;
    const route = spot.route;
    p.route = route;
    p.road = route.road;
    p.off = route.off;
    p.s0 = route.s0;
    p.s1 = route.s1;
    p.s = spot.s;
    p.dir = rng() < 0.5 ? 1 : -1;
    p.speed = 1.1 + rng() * 0.5;
    p.y = Infinity;
    p.state = 'walk';
    p.kbx = 0;
    p.kbz = 0;
    p.settle = { settled: false, clearToStand: false };
    p.intent.moveX = 0;
    p.intent.moveZ = 0;
    p.intent.faceYaw = null;
    repaintCharacter(p.character, { shirt: randPick(rng, SHIRTS), pants: randPick(rng, PANTS), skin: randPick(rng, SKINS), hair: randPick(rng, HAIRS) });
    this._walkPed(p, 0, true);
    const { RAPIER, pw, router, groups } = this.physics;
    p.body = createPedestrianBody(RAPIER, pw, { x: p.x, y: p.y, z: p.z, yaw: p.yaw }, { groups, router });
    p.body.owner = p;
    p.interp = pw.register(p.body.body);
    const a = p.actor;
    a.id = `ped-${this._spawnSeq}`;
    p.slot = this._spawnSeq++; // 降頻更新的錯開相位
    a.hp = a.maxHp;
    this._syncActor(p);
    p.anim.reset();
    p.aiAcc = 0;
    p.animAcc = 0;
    p.d2 = 0; // 本次管理週期內不會被當成回收對象（重用的行人帶著上一輩子的遠距離）
    p.lastX = p.x;
    p.lastZ = p.z;
    this.combat.register(a);
    this.brains.set(a.id, new NpcBrain({ actor: a, heavy: p.variant === PED_HEAVY, seed: CITY_SEED }));
    p.alive = true;
    p.mesh.visible = true;
    this.peds.push(p);
    this.stats.spawned++;
    return p;
  }

  // 回收：退出 combat / 大腦、移除剛體、隱藏網格，放回物件池
  _recyclePed(p) {
    this.combat.unregister(p.actor);
    this.brains.delete(p.actor.id);
    this.pw.unregister(p.interp);
    p.body.dispose();
    p.body = null;
    p.interp = null;
    p.alive = false;
    p.mesh.visible = false;
    const i = this.peds.indexOf(p);
    this.peds[i] = this.peds[this.peds.length - 1];
    this.peds.pop();
    this.pedPool.push(p);
    this.stats.recycled++;
  }

  // 每幀：鏡頭位置 (x, z)、水平朝向單位向量 (dx, dz)、水平視角半角 halfAngle（rad）；補生成只挑視野外的點
  setView(x, z, dx, dz, halfAngle) {
    const v = this.view || (this.view = {});
    v.x = x;
    v.z = z;
    v.dx = dx;
    v.dz = dz;
    v.cos = Math.cos(Math.min(Math.PI, halfAngle + VIEW_MARGIN));
  }

  // (x, z) 是否在視野外：視錐外，或鏡頭到該點的連線被建築擋住（2D 取樣）；未設定 view 時一律視為視野外
  _hidden(x, z) {
    const v = this.view;
    if (!v) return true;
    const dx = x - v.x;
    const dz = z - v.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-6) return false;
    if ((dx * v.dx + dz * v.dz) / d < v.cos) return true;
    for (let t = LOS_STEP; t < d - LOS_STEP * 0.5; t += LOS_STEP) {
      if (buildingAt(v.x + (dx * t) / d, v.z + (dz * t) / d)) return true;
    }
    return false;
  }

  // 可回收（非開場）：視野外、漫步中、沒有在打鬥 / 倒地
  _canRecycle(p) {
    return p.state === 'walk' && this.combat.stateOf(p.actor) === 'normal' && this._hidden(p.x, p.z);
  }

  // 密度管理：超出 CROWD_RECYCLE 回收 → 80 m 內過多時回收視野外的遠者 → 不足時在環帶視野外補生成
  // initial：開場補滿（生成點取 CROWD_RADIUS 內任何位置、不看視野、不限每次數量）
  _manageCrowd(center, initial = false) {
    const cx = center.x;
    const cz = center.z;
    const r2 = CROWD_RADIUS * CROWD_RADIUS;
    const far2 = CROWD_RECYCLE * CROWD_RECYCLE;
    let count = 0;
    for (let i = this.peds.length - 1; i >= 0; i--) {
      const p = this.peds[i];
      const d2 = (p.x - cx) ** 2 + (p.z - cz) ** 2;
      p.d2 = d2;
      if (d2 > far2) this._recyclePed(p);
      else if (d2 <= r2) count++;
    }
    const target = this.crowdTarget;
    const limit = initial ? Infinity : CROWD_MAX_PER_TICK;
    const min2 = CROWD_SPAWN_MIN * CROWD_SPAWN_MIN;
    // 過多：回收 60–80 m、視野外、漫步中的最遠者
    if (count > target * (1 + CROWD_SLACK)) {
      const extra = this.peds.filter((p) => p.d2 > min2 && p.d2 <= r2 && this._canRecycle(p)).sort((a, b) => b.d2 - a.d2);
      for (let k = 0; k < extra.length && k < limit && count > target; k++, count--) this._recyclePed(extra[k]);
      return;
    }
    let need = Math.min(target - count, limit);
    if (need <= 0) return;
    // 候選生成點（加權）：開場 0–80 m；平常 60–80 m
    const rMin2 = initial ? 0 : min2;
    const rMax = CROWD_RADIUS;
    const tries = initial ? CROWD_SPAWN_TRIES * 4 : CROWD_SPAWN_TRIES;
    const list = this.spotGrid.query(cx - rMax, cz - rMax, cx + rMax, cz + rMax, this._spotQ);
    const cand = this._cand;
    const cw = this._candW;
    cand.length = 0;
    cw.length = 0;
    let total = 0;
    const v = initial ? null : this.view;
    for (const sp of list) {
      const d2 = (sp.x - cx) ** 2 + (sp.z - cz) ** 2;
      if (d2 < rMin2 || d2 > r2) continue;
      const ahead = v ? Math.max(0, ((sp.x - cx) * v.dx + (sp.z - cz) * v.dz) / Math.sqrt(d2)) : 0;
      total += sp.w * (1 + CROWD_AHEAD_BIAS * ahead);
      cand.push(sp);
      cw.push(total);
    }
    const rng = this.pedRng;
    for (; need > 0 && cand.length; need--) {
      let spot = null;
      for (let k = 0; k < tries && !spot; k++) {
        const pick = rng() * total;
        let lo = 0;
        let hi = cw.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (cw[mid] < pick) lo = mid + 1;
          else hi = mid;
        }
        const sp = cand[lo];
        if (!initial && !this._hidden(sp.x, sp.z)) continue;
        if (this.peds.some((p) => (p.x - sp.x) ** 2 + (p.z - sp.z) ** 2 < CROWD_MIN_GAP * CROWD_MIN_GAP)) continue;
        spot = sp;
      }
      if (!spot) continue;
      // 物件池用完：回收一個 80 m 外、視野外、漫步中的最遠者來用
      if (!this.pedPool.length && this.peds.length >= this.poolMax) {
        let victim = null;
        for (const p of this.peds) if (p.d2 > r2 && (!victim || p.d2 > victim.d2) && this._canRecycle(p)) victim = p;
        if (!victim) break;
        this._recyclePed(victim);
      }
      this._spawnPed(spot);
    }
  }

  // 行人的 Actor 包裝（combat.js 契約）+ 動畫狀態機；id / combat 註冊 / 大腦在每次生成時（_spawnPed）才給
  _initPedCombat(ped, variant, clips) {
    ped.anim = new CharacterAnimator(ped.character, clips);
    ped.kbx = 0;
    ped.kbz = 0;
    ped.settle = { settled: false, clearToStand: false };
    ped.intent = { moveX: 0, moveZ: 0, run: false, faceYaw: null };
    ped.lastX = ped.x;
    ped.lastZ = ped.z;
    ped.actor = {
      id: null,
      kind: 'pedestrian',
      pos: { x: ped.x, y: ped.y, z: ped.z },
      yaw: ped.yaw,
      hp: PED_HP,
      maxHp: PED_HP,
      anim: ped.anim,
      faction: 'civilian',
      recoverOnKo: true, // 被拳擊打到 hp 歸零只倒地、起身回滿（不做死亡）
      ped,
      body: {
        // 倒地：面向衝量來向（倒地動作往後躺 = 順著衝量倒）、剛體切 dynamic 施加衝量
        knockdown: (impulse) => {
          const j = Math.hypot(impulse.x, impulse.y, impulse.z);
          const h = Math.hypot(impulse.x, impulse.z);
          const dir = h > 1e-6 ? { x: impulse.x / h, y: 0, z: impulse.z / h } : { x: -Math.sin(ped.yaw), y: 0, z: -Math.cos(ped.yaw) };
          ped.yaw = Math.atan2(-dir.x, -dir.z);
          ped.body.hit({ impulse: j, dir });
          ped.state = 'down';
          ped.kbx = 0;
          ped.kbz = 0;
          ped.settle = { settled: false, clearToStand: false };
        },
        // 每個物理子步已在 _afterStep 更新（npc-bodies 的 settleCheck 需逐步累計靜止時間）
        settleCheck: () => ped.settle,
        standUp: () => {
          const stand = ped.body.recover(ped.yaw);
          if (stand) {
            ped.x = stand.x;
            ped.y = stand.y;
            ped.z = stand.z;
          }
          ped.state = 'getup';
          this._syncActor(ped);
        },
      },
    };
  }

  _syncActor(p) {
    const a = p.actor;
    a.pos.x = p.x;
    a.pos.y = p.y;
    a.pos.z = p.z;
    a.yaw = p.yaw;
  }

  // 車輛實體（VehicleBody / NPC 車）→ 固定的參考物件：combat 以它去重、npc-ai 讀 pos 當事發點
  _vehicleRef(vehicle) {
    let ref = this._vehRefs.get(vehicle);
    if (!ref) {
      ref = { body: vehicle, pos: { x: 0, y: 0, z: 0 } };
      this._vehRefs.set(vehicle, ref);
    }
    const t = vehicle.getPosition();
    ref.pos.x = t.x;
    ref.pos.y = t.y;
    ref.pos.z = t.z;
    return ref;
  }

  // 每幀（物理 step 之前）：大腦用的外部狀態；vehicles 為會嚇到行人的移動中車輛 [{ x, z, vx, vz }]（玩家的車）
  setContext({ playerInVehicle = false, vehicles = [] } = {}) {
    this.context.playerInVehicle = playerInVehicle;
    this.context.vehicles = vehicles;
  }

  // 建一台車流車（tmp 已是 road 上 s 處的取樣點）；color = null → manifest 預設塗裝（公車）
  _spawnCar(scene, { RAPIER, pw, router, groups }, type, color, road, dir, s, factor) {
    const tmp = this._tmp;
    const v = new Vehicle(scene, type, color, tmp.x, tmp.z, Math.atan2(tmp.dx * dir, tmp.dz * dir));
    v.ai = true;
    const car = { v, road, dir, s, lat: dir * laneOffset(road), speed: 0, cruise: 1, factor, bus: type === 'bus' };
    this._setCruise(car);
    car.speed = car.cruise;
    this._place(car, 0, true);
    car.body = createNpcCar(RAPIER, pw, { type, ...v.spec }, { x: v.pos.x, y: v.pos.y, z: v.pos.z, yaw: v.yaw }, { groups, router });
    car.interp = pw.register(car.body.body);
    this.cars.push(car);
    return car;
  }

  _setCruise(car) {
    car.cruise = (CRUISE[car.road.type] || 9) * car.factor;
  }

  // 到達端點：換到相連道路；沒有可接的路就掉頭
  _advanceNode(car) {
    const endIdx = car.dir > 0 ? car.road.pts.length - 1 : 0;
    const p = car.road.pts[endIdx];
    const opts = optionsAt(p.x, p.z, car.road);
    // 公車只走主幹道，沒有可接的主幹道就掉頭
    const pool = car.bus ? opts.filter((o) => BUS_ROAD_TYPES.has(o.road.type)) : opts;
    if (pool.length) {
      const o = pool[Math.floor(this.rng() * pool.length)];
      car.road = o.road;
      car.dir = o.dir;
      car.s = o.s;
      car.lat = o.dir * laneOffset(o.road);
      this._setCruise(car);
      this.stats.switches++;
    } else {
      this._uTurn(car);
    }
  }

  _uTurn(car) {
    car.dir = -car.dir;
    car.s = Math.max(0, Math.min(car.road.length, car.s));
    this.stats.uTurns++;
  }

  _place(car, dt, snap = false) {
    const tmp = this._tmp;
    samplePolyline(car.road, car.s, tmp);
    // lat 為道路本身「前進方向右側」的偏移；掉頭時平滑移到對向車道
    const target = car.dir * laneOffset(car.road);
    if (snap) car.lat = target;
    else car.lat += Math.max(-4 * dt, Math.min(4 * dt, target - car.lat));
    const x = tmp.x - tmp.dz * car.lat;
    const z = tmp.z + tmp.dx * car.lat;
    const v = car.v;
    v.pos.x = x;
    v.pos.z = z;
    if (snap) v.pos.y = this.terrain.querySurface(x, z, Infinity, this._q).y;
    const want = Math.atan2(tmp.dx * car.dir, tmp.dz * car.dir);
    if (snap) v.yaw = want;
    else v.yaw += angleDelta(v.yaw, want) * Math.min(1, 6 * dt);
    v.settle(this.terrain, dt, snap);
  }

  // 人行道上 s 處的點（寫入 out.x / out.z），回傳前進方向 yaw
  _pathPoint(p, out) {
    const tmp = this._tmp;
    samplePolyline(p.road, p.s, tmp);
    out.x = tmp.x - tmp.dz * p.off;
    out.z = tmp.z + tmp.dx * p.off;
    return Math.atan2(tmp.dx * p.dir, tmp.dz * p.dir);
  }

  // 沿路線可行走區段 [s0, s1] 來回走：更新 p.x / p.y / p.z / p.yaw
  _walkPed(p, dt, snap = false) {
    p.s += p.dir * p.speed * dt;
    if (p.s > p.s1) {
      p.s = p.s1;
      p.dir = -1;
    } else if (p.s < p.s0) {
      p.s = p.s0;
      p.dir = 1;
    }
    const want = this._pathPoint(p, p);
    // yHint = 上一步腳底高（初始 Infinity 取最上層可行走面）；只轉 yaw，坡上保持直立
    p.y = this.terrain.querySurface(p.x, p.z, p.y, this._q).y;
    if (snap) p.yaw = want;
    else p.yaw += angleDelta(p.yaw, want) * Math.min(1, 8 * dt);
  }

  // 起身後走回人行道上最近的點（s 固定），到達後恢復來回走
  _returnPed(p, dt) {
    const t = this._ret || (this._ret = { x: 0, z: 0 });
    this._pathPoint(p, t);
    const dx = t.x - p.x;
    const dz = t.z - p.z;
    const d = Math.hypot(dx, dz);
    const stepLen = Math.min(d, p.speed * dt);
    if (d > 1e-6) {
      p.x += (dx / d) * stepLen;
      p.z += (dz / d) * stepLen;
      p.yaw += angleDelta(p.yaw, Math.atan2(dx, dz)) * Math.min(1, 8 * dt);
    }
    p.y = this.terrain.querySurface(p.x, p.z, p.y, this._q).y;
    if (d - stepLen < PED_ARRIVE) p.state = 'walk';
  }

  // 自由移動（react 意圖 / 擊退）的阻擋：建築、水域、世界邊界（2D 檢查，與 places.js 路線檢查同一套資料）
  _pedBlocked(x, z) {
    return !inBounds(x, z, PED_BOUNDS_MARGIN) || !!buildingAt(x, z, PED_BLOCK_PAD) || !!inWater(x, z, PED_BLOCK_PAD);
  }

  // 位移 (dx, dz)：整步被擋就沿 x / z 單軸滑動（貼著牆走），都不行就停住；回傳是否有移動
  _pedMove(p, dx, dz) {
    if (Math.abs(dx) + Math.abs(dz) < 1e-9) return false;
    if (!this._pedBlocked(p.x + dx, p.z + dz)) {
      p.x += dx;
      p.z += dz;
    } else if (Math.abs(dx) > 1e-9 && !this._pedBlocked(p.x + dx, p.z)) {
      p.x += dx;
    } else if (Math.abs(dz) > 1e-9 && !this._pedBlocked(p.x, p.z + dz)) {
      p.z += dz;
    } else return false;
    return true;
  }

  // react：套用大腦意圖（受擊硬直中不移動）；faceYaw 優先，否則面向移動方向
  _reactPed(p, dt) {
    const it = p.intent;
    const stunned = this.combat.stateOf(p.actor) === 'hit';
    const sp = stunned ? 0 : it.run ? PED_RUN_SPEED : p.speed;
    const moving = sp > 0 && Math.hypot(it.moveX, it.moveZ) > 1e-6;
    if (moving) this._pedMove(p, it.moveX * sp * dt, it.moveZ * sp * dt);
    // 受擊硬直中維持面向攻擊者（'hit' 事件已轉身），硬直結束才照意圖轉向
    const face = stunned ? null : it.faceYaw ?? (moving ? Math.atan2(it.moveX, it.moveZ) : null);
    if (face !== null) p.yaw += angleDelta(p.yaw, face) * Math.min(1, PED_TURN_RATE * dt);
  }

  // 回 wander：投影回附近（RETURN_SEARCH 內生成點所屬）最近的路線區段，以 return 走過去再繼續來回走；附近沒有就回原路線
  _startReturn(p) {
    const t = this._ret || (this._ret = { x: 0, z: 0 });
    const R = RETURN_SEARCH;
    const seen = new Set([p.route]);
    for (const sp of this.spotGrid.query(p.x - R, p.z - R, p.x + R, p.z + R, this._spotQ)) seen.add(sp.route);
    let best = null;
    for (const r of seen) {
      const pr = projectOnRoad(r.road, p.x, p.z);
      const probe = { road: r.road, off: r.off, s: Math.max(r.s0, Math.min(r.s1, pr.s)), dir: p.dir };
      this._pathPoint(probe, t);
      const d = Math.hypot(t.x - p.x, t.z - p.z);
      if (!best || d < best.d) best = { d, route: r, s: probe.s };
    }
    const r = best.route;
    p.route = r;
    p.road = r.road;
    p.off = r.off;
    p.s0 = r.s0;
    p.s1 = r.s1;
    p.s = best.s;
    p.state = 'return';
  }

  // 每個物理子步：依 ped.state 更新位置（wander = 原人行道邏輯、react = 大腦意圖），再疊加擊退
  _updatePed(p, dt) {
    if (p.state === 'return') this._returnPed(p, dt);
    else if (p.state === 'walk') this._walkPed(p, dt);
    else if (p.state === 'react') this._reactPed(p, dt);
    if (p.kbx !== 0 || p.kbz !== 0) {
      if (!this._pedMove(p, p.kbx * dt, p.kbz * dt)) {
        p.kbx = 0;
        p.kbz = 0;
      }
      const k = Math.exp(-PED_KNOCKBACK_DECAY * dt);
      p.kbx *= k;
      p.kbz *= k;
      if (Math.hypot(p.kbx, p.kbz) < 0.05) {
        p.kbx = 0;
        p.kbz = 0;
      }
    }
    if (p.state === 'react' || p.state === 'getup' || p.kbx !== 0) p.y = this.terrain.querySurface(p.x, p.z, p.y, this._q).y;
    this._syncActor(p);
  }

  // 每幀：大腦決策 → ped.state 轉換（wander ↔ react、getup 結束）；意圖留給下一幀的物理子步套用
  // 距 center 超過 PED_NEAR 的行人每 PED_FAR_AI_EVERY 幀才想一次（累積 dt）
  _thinkPeds(dt, center) {
    const ctx = this.context;
    const near2 = PED_NEAR * PED_NEAR;
    for (const p of this.peds) {
      p.aiAcc += dt;
      const far = (p.x - center.x) ** 2 + (p.z - center.z) ** 2 > near2;
      if (far && (this.frame + p.slot) % PED_FAR_AI_EVERY !== 0) continue;
      const brain = this.brains.get(p.actor.id);
      const it = brain.update(p.aiAcc, ctx);
      p.aiAcc = 0;
      p.intent.moveX = it.moveX;
      p.intent.moveZ = it.moveZ;
      p.intent.run = it.run;
      p.intent.faceYaw = it.faceYaw;
      if (it.jump) p.anim.trigger('jump');
      if (p.state === 'down') continue;
      if (p.state === 'getup') {
        if (this.combat.isDown(p.actor)) continue;
        if (it.mode === 'wander') this._startReturn(p);
        else p.state = 'react';
      } else if (it.mode === 'wander') {
        if (p.state === 'react') this._startReturn(p);
      } else if (it.mode !== 'down') {
        p.state = 'react';
      }
    }
  }

  // wrecked 恢復：以目前位置投影回道路（太遠就找最近的車流道路），行進方向取與車頭較一致的一側；
  // 橫向偏移保留目前值，由 _place 以 4 m/s 平滑拉回車道
  _realign(car) {
    const pose = car.body.getPose();
    let road = car.road;
    let pr = projectOnRoad(road, pose.x, pose.z);
    if (pr.d2 > REALIGN_MAX_DIST * REALIGN_MAX_DIST) {
      for (const r of trafficRoads) {
        if (car.bus && !BUS_ROAD_TYPES.has(r.type)) continue;
        const q = projectOnRoad(r, pose.x, pose.z);
        if (q.d2 < pr.d2) {
          pr = q;
          road = r;
        }
      }
    }
    const fwd = Math.sin(pose.yaw) * pr.dx + Math.cos(pose.yaw) * pr.dz;
    const dirs = allowedDirs(road);
    car.road = road;
    car.dir = dirs.length === 1 ? dirs[0] : fwd >= 0 ? 1 : -1;
    car.s = pr.s;
    car.lat = Math.max(-road.hw, Math.min(road.hw, pr.lat));
    car.speed = 0;
    car.leaving = false;
    this._setCruise(car);
    car.v.yaw = pose.yaw;
    car.v.pos.y = pose.y;
  }

  // 物理子步前：車道 / 人行道邏輯 → kinematic 目標 pose（wrecked / 倒地者跳過）
  _step(dt) {
    for (const car of this.cars) {
      if (car.body.isWrecked) continue;
      this._driveCar(car, dt, this.blockers);
      const v = car.v;
      car.body.setTargetPose(v.pos.x, v.pos.y, v.pos.z, v.yaw, dt);
    }
    for (const p of this.peds) {
      if (p.state === 'down') continue;
      this._updatePed(p, dt);
      p.body.setPose(p.x, p.y, p.z, p.yaw);
    }
  }

  // 物理子步後：wrecked 計時與恢復、倒地行人的落穩檢查（起身由 combat 決定）
  _afterStep(dt) {
    for (const car of this.cars) {
      const b = car.body;
      if (!b.isWrecked) continue;
      b.update(dt);
      const pose = b.getPose();
      car.v.pos.set(pose.x, pose.y, pose.z);
      if (b.canRecover && b.recover()) this._realign(car);
    }
    for (const p of this.peds) {
      if (p.state !== 'down') continue;
      p.settle = p.body.settleCheck(dt);
      const t = p.body.getPosition();
      p.x = t.x;
      p.y = t.y - p.body.centerY;
      p.z = t.z;
      this._syncActor(p);
    }
  }

  // 車道邏輯（每個物理子步一次）：前方有東西就停、沿道路前進、到端點換路或掉頭、出界掉頭
  // blockers：[{ x, z }] 會讓車流停下來的東西（玩家、玩家的車、路邊的車）
  _driveCar(car, dt, blockers) {
    const v = car.v;
    const fx = Math.sin(v.yaw);
    const fz = Math.cos(v.yaw);
    let target = car.cruise;
    // 前方 14m、左右 2.1m 內有東西就停（約兩車半寬之和，貼路緣停放的車不會擋住車道）
    const reach = FOLLOW_REACH + (v.spec.length - FOLLOW_BASE_LEN) / 2;
    const check = (x, z, extra = 0) => {
      const dx = x - v.pos.x;
      const dz = z - v.pos.z;
      const along = dx * fx + dz * fz;
      const lat = Math.abs(dx * fz - dz * fx);
      if (along > 0.5 && along < reach + extra && lat < 2.1) target = 0;
    };
    for (const b of blockers) check(b.x, b.z);
    for (const other of this.cars) {
      if (other !== car) check(other.v.pos.x, other.v.pos.z, (other.v.spec.length - FOLLOW_BASE_LEN) / 2);
    }
    const accel = target < car.speed ? 12 : 4;
    if (car.speed < target) car.speed = Math.min(target, car.speed + accel * dt);
    else car.speed = Math.max(target, car.speed - accel * dt);

    car.s += car.dir * car.speed * dt;
    // 到端點：換路或掉頭（最多處理兩次，避免極短路段卡住）
    for (let k = 0; k < 2; k++) {
      if (car.dir > 0 && car.s >= car.road.length) {
        const over = car.s - car.road.length;
        car.s = car.road.length;
        this._advanceNode(car);
        car.s += car.dir * over;
      } else if (car.dir < 0 && car.s <= 0) {
        const over = -car.s;
        car.s = 0;
        this._advanceNode(car);
        car.s += car.dir * over;
      } else break;
    }
    car.s = Math.max(0, Math.min(car.road.length, car.s));
    this._place(car, dt);
    // 開到世界邊界附近就掉頭
    if (!inBounds(v.pos.x, v.pos.z, 8) && !car.leaving) {
      car.leaving = true;
      this._uTurn(car);
    } else if (inBounds(v.pos.x, v.pos.z, 12)) {
      car.leaving = false;
    }
    v.speed = car.speed;
  }

  // 每幀（物理 step 之前）：更新會讓車流停下來的位置
  setBlockers(blockers) {
    this.blockers = blockers;
  }

  // 每幀（物理 step 之後）：自建的 combat 推進 → 密度管理 → 大腦決策 → 網格依插值姿態擺放、輪子 / 角色動畫
  // center：玩家 / 鏡頭焦點（密度管理與降頻的中心），省略時用出生點
  sync(dt, center = this.center) {
    const alpha = this.pw.alpha;
    this.clock += dt;
    this.frame++;
    if (this.ownsCombat) this.combat.update(dt);
    this._crowdT += dt;
    if (this._crowdT >= CROWD_TICK) {
      this._crowdT = 0;
      this._manageCrowd(center);
    }
    this._thinkPeds(dt, center);
    for (const car of this.cars) {
      const v = car.v;
      const b = car.body;
      if (b.isWrecked) {
        // 殘骸：整個剛體姿態（含翻滾）
        const o = car.interp.interpolate(alpha);
        const m = meshOrigin(o, { x: o.qx, y: o.qy, z: o.qz, w: o.qw }, b.layout.centerY);
        v.mesh.position.set(m.x, m.y + SURFACE_OFFSET, m.z);
        v.mesh.quaternion.set(o.qx, o.qy, o.qz, o.qw);
        continue;
      }
      v.animate(dt);
      if (!b.active) {
        v.syncMesh();
        continue;
      }
      // 車道行駛：位置 / yaw 取插值剛體，pitch / roll 取車道貼地（kinematic 剛體只帶 yaw）
      const o = car.interp.interpolate(alpha);
      v.mesh.position.set(o.x, o.y - b.layout.centerY + SURFACE_OFFSET, o.z);
      v.mesh.rotation.set(-v.pitch, yawOf({ x: o.qx, y: o.qy, z: o.qz, w: o.qw }), v.roll + v.lean);
    }

    const near2 = PED_NEAR * PED_NEAR;
    for (const p of this.peds) {
      const b = p.body;
      // 動畫：近處每幀、遠處每 PED_FAR_MIXER_EVERY 幀以累積 dt 更新；速度 = 上次更新以來的水平位移 / 累積時間
      p.animAcc += dt;
      const far = (p.x - center.x) ** 2 + (p.z - center.z) ** 2 > near2;
      if (!far || (this.frame + p.slot) % PED_FAR_MIXER_EVERY === 0) {
        const speed = p.animAcc > 0 ? Math.hypot(p.x - p.lastX, p.z - p.lastZ) / p.animAcc : 0;
        p.lastX = p.x;
        p.lastZ = p.z;
        p.anim.update(p.animAcc, { speed });
        p.animAcc = 0;
      }
      if (!b.active) {
        p.mesh.position.set(p.x, p.y + SURFACE_OFFSET, p.z);
        p.mesh.rotation.set(0, p.yaw, 0);
        continue;
      }
      const o = p.interp.interpolate(alpha);
      if (p.state === 'down') {
        // 倒地：角色原點放在膠囊底部、面向倒地時的 yaw，由倒地動作躺下；方塊人沒有倒地動作，整個往後躺平
        if (p.character.fallback) {
          p.mesh.position.set(o.x, o.y - PED_RADIUS + SURFACE_OFFSET, o.z);
          p.mesh.rotation.set(-Math.PI / 2, p.yaw, 0);
        } else {
          p.mesh.position.set(o.x, o.y - b.centerY + SURFACE_OFFSET, o.z);
          p.mesh.rotation.set(0, p.yaw, 0);
        }
        continue;
      }
      p.mesh.position.set(o.x, o.y - b.centerY + SURFACE_OFFSET, o.z);
      p.mesh.rotation.set(0, yawOf({ x: o.qx, y: o.qy, z: o.qz, w: o.qw }), 0);
    }
  }

  // 遠距簡化用（setActiveByDistance）
  bodies(out = []) {
    for (const car of this.cars) out.push(car.body);
    for (const p of this.peds) out.push(p.body);
    return out;
  }
}
