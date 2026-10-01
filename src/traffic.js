// 車流與行人：車流沿 OSM 的 primary / secondary / tertiary 折線靠右行駛（臺灣右側通行），
// 到端點就換到相連道路，沒有可接的路或出界就掉頭；公車少量（MAX_BUSES）只走主幹道（BUS_ROAD_TYPES）；行人沿道路邊緣來回走。
// 不做避障（只有「前方有東西就停」的簡單判斷）
// 高度一律取 terrain.querySurface：車輛依四輪貼地並做 pitch / roll（同 vehicle.js），行人在坡上身體保持直立
// 物理（src/physics/npc-bodies.js）：車道 / 人行道邏輯在每個物理子步前算出 pose，交給 kinematic 剛體（setTargetPose / setPose）；
// - NPC 車被強撞（contacts.js onVehicleHitVehicle 超過門檻）→ wrecked 動態剛體，期間跳過車道邏輯；
//   可恢復時 recover() 並以目前位置投影回道路重新對位（橫向偏移由車道邏輯平滑拉回車道）
// 分級預算（Phase 3）：建構參數 budget = core/quality.js 的 qualityBudget 物件（cars / peds / pedNear / pedFar / motorbikeShare）；
//   舊的 crowd: 'high' | 'low' 字串對應 data/city.js TRAFFIC_BUDGET_FALLBACK 兩列；setBudget(budget) 即時生效，
//   多的逐步回收、少的逐步補（每次管理 CROWD_MAX_PER_TICK 人、CAR_MAX_PER_TICK 台，骨架取還每幀 SWAP_PER_FRAME 個）
// 車流密度（_manageCars，每 CROWD_TICK 秒）：總台數 = budget.cars（公車 ≤ MAX_BUSES、機車 ≈ motorbikeShare）；
//   CAR_RECYCLE 外且視野外的車回收，不足時在 CAR_SPAWN_MIN–CAR_SPAWN_RADIUS 的視野外車道補車；缺的車種優先補
// 號誌（lights = createTrafficLights() 的回傳，省略則不管號誌）：_signalLimit 以沿路前瞻（本路段 + 已預選的下一路段）找停止線，
//   紅燈 / 煞得住的黃燈 → 目標速度 ≤ √(2·SIGNAL_DECEL·(車頭到停止線 − SIGNAL_STOP_GAP))，與跟車取 min；
//   停住後轉綠有 GO_REACT_MIN–GO_REACT_MAX 秒隨機反應時間；相鄰 < SIGNAL_PAIR_GAP 的兩道停止線（雙向分隔道路），
//   第一道放行時才看第二道：第二道紅燈、且會在第一道綠燈結束前轉綠 → 停在第一道前等兩道一起過；時相對不上就照走，
//   改在第二道前等（避免兩路口時相固定錯開時永遠卡在第一道）
//   行人不看號誌：places.js 的行人路線全部排除車道路面（pedWalkable），本來就不穿越車道
// 行人 = 市民（citizen，輕量資料：路線 / 位置 / 服色 / 槽號）+ 需要時才掛上的骨架行人（ped：src/characters 骨架 + CharacterAnimator +
//   combat.js Actor + npc-ai.js NpcBrain + 剛體），分層依 src/crowd.js（crowdPlan / createCrowdLod / createStagger / swapPolicy / 替身）：
// - near（< pedNear）：骨架、mixer 每幀、大腦每幀、每個物理子步走路；物理剛體只在 plan.physicsRadius 內啟用（sync 內自行 setActiveByDistance）
// - mid（pedNear–pedFar）：骨架、mixer 每 3 幀（視野外凍結）、大腦 / 走路每 3 幀（累積 dt）
// - far（> pedFar）：InstancedMesh 替身（骨架回池、無剛體、無大腦），走路每 6 幀
// - 倒地 / 起身 / 還手 / 逃跑 / 走回路線 / 被玩家鎖定者強制 near；骨架池上限 plan.poolMax（池滿時 near 的人可借走最遠 mid 的骨架）
// - 密度管理（_manageCrowd）：以 sync 的 center 為中心、plan.radius 內維持 plan.target 人；plan.recycle 外回收；
//   不足時在 plan.spawnMin–plan.radius 環帶、視野外（setView：視錐外或被建築擋住）的生成點（places.js pedestrianRoutes）補生成
// - ped.state：walk（沿路線區段來回走）/ return（走回路線點）/ react（套用大腦的 flee / fight / watch / dodge 意圖）/ down（倒地，剛體 dynamic）/ getup（起身動畫中）
// - 大腦 mode 為 wander 時走原本的人行道邏輯；否則套用 moveX / moveZ / run / faceYaw，回 wander 時投影回最近的人行道路段再繼續
// - 被打（combat 'hit'）：轉身面向攻擊者、擊退位移以 2D 建築 / 水域檢查滑動（不穿牆）；knockdown → 剛體切 dynamic（npc-bodies hit）+ 倒地動畫；
//   拳擊打到 hp 歸零（actor.recoverOnKo）也只是倒地，1.5 s 起落穩後起身、hp 回滿
// - 被車撞（onVehicleHitPedestrian）→ combat.onVehicleHit；每個物理子步 settleCheck，combat 判定可起身時 standUp（剛體 recover）+ getup
// - 未注入 combat 時自建一個 CombatSystem 並在 sync 內推進（無頭測試 / 單獨使用）；遊戲本體由 main.js 注入共用的 combat 並自行 update
// 轉接器（契約 §5）：carjackCandidates / releaseCar / spawnEjectedDriver；喇叭：attachBus(bus) 訂閱 vehicle:horn →
//   前方 HORN_PED_RANGE 內行人 brain.hear、前方同車道車流車 HORN_REACT_MAX 秒內加速離開（不減速讓道以外不做反應）
// 網格每幀依插值後的剛體姿態擺放；停用中（setActiveByDistance 半徑外）的剛體不動，網格改用車道 / 人行道 pose
//
// 接線說明（整合單元 main.js；不改也能跑：crowd 字串 / 無號誌 / 無喇叭的舊行為）：
// 1. 建構：const lights = createTrafficLights(); lights.buildMeshes(scene)；
//    new Traffic(scene, { center: spawn, terrain, physics, combat, budget: qualityBudget(tier), lights, bus })（crowd 參數可刪）
// 2. 畫質設定變更：traffic.setBudget(qualityBudget(newTier))（逐步生效，不必重建）
// 3. 號誌相位在固定子步推進：pw.onBeforeStep((h) => lights.step(h)) 須在 new Traffic 之前登記（同一子步車流讀到本子步時刻）；
//    車損去重時鐘同理 pw.onAfterStep((h) => dmg.step(h))。每幀只刷新：物理 step 後 lights.update()（燈色 / 倒數）、
//    lights.updateVisuals(焦點 x, z)、dmg.update(dt, …)（煙霧粒子）——見 core/loop.js createWorldStep；
//    物理 step 前 traffic.setView(...)、setBlockers(...) 照舊；
//    setContext({ playerInVehicle, vehicles, player: player.actor, lockTarget: 玩家鎖定中的行人 Actor 或 null })
// 4. 物理 step 後：traffic.sync(dt, center) 照舊（行人剛體已在 sync 內依 traffic.physicsRadius 啟用 / 休眠）；
//    setActiveByDistance(traffic.bodies(vehicles.bodies(entities)), …, ACTIVE_RADIUS) 照舊——bodies() 現在只列車流車
//    （要自己管行人：traffic.pedBodies() + traffic.physicsRadius；車：traffic.carBodies()）
// 5. 搶車：carjack.js 的 adapters = { releaseCar: (car) => traffic.releaseCar(car), spawnEjectedDriver: (o) => traffic.spawnEjectedDriver(o), … }，
//    候選 traffic.carjackCandidates(player.pos.x, player.pos.z, r)；releaseCar 的 color 對公車為 null（manifest 預設塗裝）
// 6. 喇叭：建構給 bus 或 traffic.attachBus(bus)（回傳取消函式）；vehicle.honk() emit 的 vehicle:horn 即生效
// 7. 行人數 HUD / 除錯：traffic.citizens.length（全部）、traffic.peds.length（骨架）、traffic.impostors.count（替身）
import * as THREE from 'three';
import { TRAFFIC_BUDGET_FALLBACK, CITY_SEED, SURFACE_OFFSET } from './data/city.js';
import { surfaceRoads, TRAFFIC_TYPES, nodeRoads, nodeKey, inBounds, buildingAt } from './citymodel.js';
import { samplePolyline, closestOnSegment, SpatialGrid } from './geom.js';
import { Vehicle, meshOrigin } from './vehicle.js';
import { pedestrianRoutes } from './places.js';
import { createCharacter, disposeCharacter, repaintCharacter, getCharacterManifest, variantHeight, CharacterAnimator } from './characters/index.js';
import { CombatSystem } from './combat.js';
import { NpcBrain, wireCombatToBrains } from './npc-ai.js';
import { mulberry32, angleDelta, randPick } from './utils.js';
import { createNpcCar, createPedestrianBody, setActiveByDistance, PED_RADIUS } from './physics/npc-bodies.js';
import { PED_KNOCKBACK_DECAY, pathPoint, walkPed, returnPed, pedBlocked, pedMove, reactPed, startReturn, syncActor, updatePed, stepPeds, afterStepPeds, thinkPeds, animatePed } from './traffic-peds.js';
import { yawOf } from './physics/vehicle-body.js';
import { crowdPlan, createCrowdLod, createStagger, swapPolicy, createCrowdImpostors } from './crowd.js';

const CAR_COLORS = ['#f2f2f2', '#1f1f22', '#8a8f94', '#b01e28', '#2d5fb0', '#d9d2c0', '#3f6b4a'];
const SHIRTS = ['#d84a4a', '#3a6fd8', '#f2c14e', '#ffffff', '#6a4c93', '#2a9d8f', '#e76f51', '#8d99ae'];
const PANTS = ['#2b2f3a', '#1d3557', '#5c4d3c', '#3d3d3d', '#6b705c'];
const SKINS = ['#f1c9a5', '#e0ac85', '#c68b5f'];
const HAIRS = ['#1b1b1b', '#3b2a20', '#5a4a3a', '#9a9a9a'];

const CRUISE = { primary: 13, secondary: 11, tertiary: 9 };
const REALIGN_MAX_DIST = 30; // wrecked 恢復時離原道路超過此距離（m）就改找最近的車流道路
const PED_VARIANTS = ['pedestrian', 'pedestrian_f', 'pedestrian_heavy']; // 角色 manifest 的三種 variant
const PED_HEAVY = 'pedestrian_heavy'; // 壯碩體型：大腦還手比例較高
const PED_HP = 100;
// 密度管理（距離以 sync 的 center 計；半徑 / 人數 / 骨架池讀 crowdPlan）
const CROWD_SLACK = 0.1; // radius 內超過目標此比例才回收多出來的人（視野外、near 外、漫步中者）
// 市民總數（骨架 + 替身，含 radius 外、尚未到回收半徑者）上限 = floor(目標 × 此值)：實測 1.25 時 low 檔總數 46–50 > budget.peds 40，
// 改 1.05（low 42 / mid 84 / high 147 / ultra 210）；補生成滿額時先回收 radius 外的最遠者（_spawnRing），拖出的司機為臨時例外，下次管理回收
const CROWD_TOTAL_FACTOR = 1.05;
const CROWD_TICK = 0.1; // 管理頻率（s）
const CROWD_MAX_PER_TICK = 4; // 每次最多補 / 回收幾人（開場補滿不受限）
const CROWD_RECYCLE_PER_TICK = 8; // 超出回收半徑者每次最多回收幾人（畫質降級 / 傳送後分攤到多次）
const CROWD_SPAWN_TRIES = 24; // 每補一人最多抽幾個生成點（開場 ×4）；抽不到就換下一人再試（每次管理共 CROWD_MAX_PER_TICK 人份）
const CROWD_MIN_GAP = 2; // 生成點與現有行人的最小距離（m）
// 前方加權：生成點方向與鏡頭朝向夾角 θ，權重 × (1 + CROWD_AHEAD_BIAS · max(0, cos θ))——前方被建築擋住 / 視野側前方的點
// 優先（玩家往前走時留在半徑內較久；補在背後的人幾秒就離開半徑，移動中人數補不回來）
const CROWD_AHEAD_BIAS = 3;
// 內圈密度：plan 只在 radius（pedFar + 20）內維持總人數，補生成環帶又在外圈（radius − 40 起），玩家移動時 80 m 內會被走空
// （crowd.mjs 實測 high 檔 80 m 內最低掉到 29 人）；另外在 CROWD_INNER 內維持 target × (CROWD_INNER / radius)² × CROWD_INNER_BOOST 人，
// 缺人時在 innerMin–CROWD_INNER 的視野外補（innerMin = min(physicsRadius, CROWD_INNER_MIN_CAP)），總數超出由既有「過多」回收最遠者平衡
const CROWD_INNER = 80;
const CROWD_INNER_BOOST = 1.15;
const CROWD_INNER_MIN_CAP = 60;
const IMPOSTOR_SPARE = 8; // 替身 slot 在市民上限外的餘量（被拖出的司機等臨時加人）
const SWAP_PER_FRAME = 6; // 每幀最多取 / 還幾個骨架（near 級不受限）：畫質切換或高速移動時分攤到多幀
const CREATE_PER_FRAME = 2; // 每幀最多新建幾個骨架（複製 glb 較貴；near 級不受限）
const VIEW_MARGIN = 0.2; // 視錐半角外加的邊距（rad）：畫面邊緣剛好出現的人也算看得到
const LOS_STEP = 5; // 視線被建築遮擋的取樣間距（m）
const RETURN_SEARCH = 40; // 回 wander 時找路線的搜尋半徑（m）
const MAX_BUSES = 2; // 公車數量上限（計入 budget.cars）
// 公車行駛的主幹道：OSM primary（臺灣大道）與 secondary（文心路、黎明路等市區幹道；出生點附近沒有 primary）
const BUS_ROAD_TYPES = new Set(['primary', 'secondary']);
const BUS_MIN_LENGTH = 60; // 出生路段最短長度（m）：12.5 m 車身要有空間
const CAR_TYPES = ['sedan', 'sedan', 'taxi', 'suv']; // 一般車（機車 / 公車另計）
const MOTORBIKE = 'scooter';
// 前車距離判斷（m）：以 4.5 m 車長為基準的前方 14 m，長車（公車）依車長差加長
const FOLLOW_REACH = 14;
const FOLLOW_BASE_LEN = 4.5;
// 車流密度（距離以 sync 的 center 計）
const CAR_SPAWN_RADIUS = 450; // 補車（與開場）的最大距離（m）
const CAR_SPAWN_MIN = 80; // 平常補車的最小距離（m）：不在眼前憑空出現
const CAR_RECYCLE = 600; // 超出且視野外就回收、改補到附近（m）
const CAR_MIN_GAP = 25; // 生成點與其他車的最小距離（m，公車 40）
const CAR_BUS_GAP = 40;
const CAR_SPOT_STEP = 20; // 車道生成點取樣間距（m）
const CAR_MAX_PER_TICK = 2; // 每次管理最多回收 + 補幾台
const CAR_SPAWN_TRIES = 16;
// 號誌
const SIGNAL_LOOK = 80; // 前瞻距離（m）
const SIGNAL_DECEL = 3; // 停止線前的舒適減速度（m/s²）
const SIGNAL_STOP_GAP = 0.5; // 車頭停在停止線前的距離（m）
const SIGNAL_PAIR_GAP = 20; // 兩道停止線距離小於此（m）視為同一組（第一道放行時才看第二道）
const GO_REACT_MIN = 0.3; // 綠燈起步反應時間（s）
const GO_REACT_MAX = 0.8;
const GO_HOLD_SPEED = 1; // 紅燈停等中（車速低於此，m/s）轉綠才有起步反應時間
// 喇叭
const HORN_PED_RANGE = 15; // 前方行人（m；±40° 由 brain.hear 自己判斷）
const HORN_CAR_RANGE = 30; // 前方同車道車流車（m）
const HORN_CAR_LAT = 2.1; // 同車道判定：橫向距離（m）
const HORN_CAR_HEADING = 0.7; // 同車道判定：車頭方向與喇叭方向夾角 cos 下限
const HORN_REACT_MAX = 0.5; // 前車在此秒數內開始反應
const HORN_BOOST_SEC = 2.5; // 前車加速離開持續秒數
const HORN_BOOST = 1.3; // 加速期間巡航速度倍率
// 搶車
const CARJACK_MAX_SPEED = 6; // 車速高於此（m/s）不列入搶車候選
const EJECT_IMPULSE = 90; // 被拖出的司機倒地衝量（N·s，往車門外）
const EJECT_LIFT = 0.2;

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

// 車流生成點：車流道路每 CAR_SPOT_STEP 取樣（路段 15–85% 範圍、界內），全域只建一次
const CAR_SPOT_CELL = 50;
let carSpotCache = null;
function carSpots() {
  if (carSpotCache) return carSpotCache;
  const grid = new SpatialGrid(CAR_SPOT_CELL);
  const tmp = { x: 0, z: 0, dx: 0, dz: 1, seg: 0 };
  for (const road of trafficRoads) {
    const s0 = road.length * 0.15;
    const s1 = road.length * 0.85;
    const n = Math.max(1, Math.floor((s1 - s0) / CAR_SPOT_STEP));
    for (let k = 0; k < n; k++) {
      const s = n === 1 ? road.length / 2 : s0 + ((k + 0.5) * (s1 - s0)) / n;
      samplePolyline(road, s, tmp);
      if (!inBounds(tmp.x, tmp.z, 20)) continue;
      const sp = { road, s, x: tmp.x, z: tmp.z, bus: BUS_ROAD_TYPES.has(road.type) && road.length >= BUS_MIN_LENGTH };
      grid.insert(sp, sp.x, sp.z, sp.x, sp.z);
    }
  }
  carSpotCache = grid;
  return grid;
}

function allowedDirs(road) {
  if (road.oneway === 1) return [1];
  if (road.oneway === -1) return [-1];
  return [1, -1];
}

// 市民總數上限（骨架 + 替身）
export function crowdCap(target) {
  return Math.floor(target * CROWD_TOTAL_FACTOR + 1e-9);
}

// 預算物件正規化：budget（qualityBudget 物件）優先，缺欄位由舊 crowd 字串對應的相容列補
function resolveBudget(budget, crowd) {
  const base = TRAFFIC_BUDGET_FALLBACK[crowd] || TRAFFIC_BUDGET_FALLBACK.high;
  const b = budget && typeof budget === 'object' ? budget : {};
  const pick = (k) => (Number.isFinite(b[k]) && b[k] >= 0 ? b[k] : base[k]);
  return {
    id: b.id || base.id,
    peds: Math.round(pick('peds')),
    cars: Math.round(pick('cars')),
    pedNear: pick('pedNear'),
    pedFar: pick('pedFar'),
    motorbikeShare: Math.min(1, pick('motorbikeShare')),
  };
}

export class Traffic {
  // terrain：唯一高度場（需有 querySurface）；physics = { RAPIER, pw（PhysicsWorld）, router（contacts.js）, groups }
  // combat：共用的 CombatSystem（省略 → 自建並在 sync 內 update）
  // budget：core/quality.js qualityBudget(tier) 物件（cars / peds / pedNear / pedFar / motorbikeShare）；
  // crowd：舊參數 'high' | 'low'（budget 省略時對應 TRAFFIC_BUDGET_FALLBACK 兩列）
  // lights：createTrafficLights() 的回傳（省略 → 不管號誌）；bus：事件匯流排（省略 → 之後可 attachBus）
  constructor(scene, { center = { x: 0, z: 0 }, terrain, physics, combat = null, crowd = 'high', budget = null, lights = null, bus = null }) {
    const { pw, router } = physics;
    this.pw = pw;
    this.terrain = terrain;
    this.center = center;
    this.scene = scene;
    this.physics = physics;
    this.lights = lights;
    this.blockers = [];
    this._q = {};
    this.rng = mulberry32(CITY_SEED + 1); // 車流抽樣 / 換路
    this.busRng = mulberry32(CITY_SEED + 3); // 公車生成（另開種子）
    this.sigRng = mulberry32(CITY_SEED + 5); // 起步反應時間 / 喇叭反應
    this.cars = [];
    this.citizens = []; // 全部市民（骨架 + 替身）
    this.peds = []; // 目前掛著骨架的行人（Phase 2 相容：每人有 mesh / body / actor / anim / brain）
    this.stats = { uTurns: 0, switches: 0, carsSpawned: 0, carsRemoved: 0, carsReleased: 0, goReact: [], hornPeds: 0, hornCars: 0 };
    this._tmp = { x: 0, z: 0, dx: 0, dz: 1, seg: 0 };
    this.clock = 0;
    this.ownsCombat = !combat;
    this.combat = combat || new CombatSystem({ now: () => this.clock });
    this.brains = new Map(); // actor.id → NpcBrain
    this.context = { combat: this.combat, playerInVehicle: false, vehicles: [], player: null, lockTarget: null };
    this._vehRefs = new WeakMap(); // 撞人的車輛實體 → { body, pos }（combat 去重 key 與 npc-ai 事發點）
    this._busOff = null;

    // 行人：路線 / 生成點（places.js，固定種子、全域只算一次）+ 物件池
    this.pedPool = []; // 已回池、待重用的骨架行人（骨架 / animator 保留，網格隱藏）
    this.pedRng = mulberry32(CITY_SEED + 11); // 行人 variant / 服色 / 路線方向與步速
    this.view = null; // setView：鏡頭位置與水平朝向（null = 全部視為視野外）
    this.frame = 0;
    this._crowdT = 0;
    this._simAcc = 0; // 本幀物理子步已推進的模擬秒數（_step 累加、sync 取走）
    this._spawnSeq = 0;
    this._spotQ = [];
    this._carQ = [];
    this._cand = [];
    this._candW = [];
    this._stopBuf = [{ stop: null, d: 0, toNode: 0 }, { stop: null, d: 0, toNode: 0 }, { stop: null, d: 0, toNode: 0 }];
    this._bodyBuf = [];
    this.freeSlots = [];
    this.impostors = null;
    this.stagger = createStagger();
    this._lodCenter = center;
    this._swaps = 0;
    this._creates = 0;
    this._swapLimit = Infinity; // 開場補滿不受每幀取還 / 新建數量限制
    this._createLimit = Infinity;
    const manifest = getCharacterManifest();
    this._clips = manifest ? manifest.clips : [];
    Object.assign(this.stats, { pedCreated: 0, pedDisposed: 0, spawned: 0, recycled: 0, stolen: 0 });
    this.spotGrid = pedSpots().grid;
    this.carSpotGrid = carSpots();
    this._applyBudget(resolveBudget(budget, crowd));

    // 車流：公車先出（出生點附近主幹道），其餘依缺的車種補到 budget.cars（開場不看視野）
    for (let guard = 0; this.cars.length < this.carTarget && guard < 500; guard++) this._spawnTrafficCar(center, true);
    this._manageCrowd(center, true);
    this._updateLod(center);
    this._swapLimit = SWAP_PER_FRAME;
    this._createLimit = CREATE_PER_FRAME;

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
    if (bus) this.attachBus(bus);
  }

  // ---------- 分級預算 ----------

  // 畫質設定即時生效：人數 / 車數 / 分層半徑立刻換成新值，實際增減由之後的管理週期逐步完成
  setBudget(budget) {
    this._applyBudget(resolveBudget(budget, this.budget ? this.budget.id : 'high'));
  }

  _applyBudget(b) {
    this.budget = b;
    this.plan = crowdPlan({ peds: b.peds, pedNear: b.pedNear, pedFar: b.pedFar });
    this.lod = createCrowdLod(this.plan);
    this.carTarget = b.cars;
    this.crowdTarget = this.plan.target; // Phase 2 相容欄位
    this.poolMax = this.plan.poolMax;
    // 內圈（CROWD_INNER，玩家看得到的主要範圍）另外維持 innerTarget 人：生成點在 innerMin–CROWD_INNER、視野外
    const p = this.plan;
    this.innerTarget = Math.min(p.target, Math.ceil(p.target * (CROWD_INNER / p.radius) ** 2 * CROWD_INNER_BOOST));
    this.innerMin = Math.min(CROWD_INNER_MIN_CAP, p.physicsRadius);
    this._ensureImpostors(Math.ceil(this.plan.target * CROWD_TOTAL_FACTOR) + IMPOSTOR_SPARE);
  }

  // 物理啟用半徑（行人）：整合層若要自己呼叫 setActiveByDistance(traffic.pedBodies(), …) 用這個值
  get physicsRadius() {
    return this.plan.physicsRadius;
  }

  // 替身 slot 容量不足時重建 InstancedMesh（只增不減），把顯示中的替身重放一次
  _ensureImpostors(cap) {
    const old = this.impostors;
    if (old && old.max >= cap) return;
    const from = old ? old.max : 0;
    if (old) old.dispose();
    this.impostors = createCrowdImpostors(THREE, this.scene, { max: cap });
    for (let i = cap - 1; i >= from; i--) this.freeSlots.push(i);
    for (const c of this.citizens) if (c.rep === 'impostor') this._showImpostor(c);
    this.impostors.commit();
  }

  // ---------- 行人：市民 / 骨架 ----------

  // 新建一個骨架行人（骨架 + animator + Actor 包裝，尚未掛到市民）；只在物件池不夠時呼叫
  _createPed(variant) {
    const character = createCharacter({ variant });
    const mesh = character.root;
    mesh.rotation.order = 'YXZ'; // 方塊人倒地時先 yaw 再往後躺
    mesh.visible = false;
    this.scene.add(mesh);
    const ped = { mesh, character, variant, road: null, off: 0, s: 0, s0: 0, s1: 0, dir: 1, speed: 1.3, yaw: 0, y: Infinity, x: 0, z: 0, state: 'walk', alive: false, body: null, interp: null, citizen: null, look: null, brain: null };
    this._initPedCombat(ped, variant, this._clips);
    this.stats.pedCreated++;
    this._creates++;
    return ped;
  }

  // 在生成點 spot 放出一個市民；分級為 near / mid 且拿得到骨架就掛骨架，否則顯示替身；回傳市民或 null（替身 slot 用完）
  _spawnPed(spot) {
    const slot = this.freeSlots.pop();
    if (slot === undefined) return null;
    const rng = this.pedRng;
    const route = spot.route;
    const variant = randPick(rng, PED_VARIANTS);
    const c = {
      id: `ped-${this._spawnSeq++}`,
      slot,
      route,
      road: route.road,
      off: route.off,
      s0: route.s0,
      s1: route.s1,
      s: spot.s,
      dir: rng() < 0.5 ? 1 : -1,
      speed: 1.1 + rng() * 0.5,
      x: 0,
      y: Infinity,
      z: 0,
      yaw: 0,
      variant,
      look: null,
      level: null,
      rep: null,
      ped: null,
      inView: false,
      walkAcc: 0,
      moved: true,
      dist: 0,
      d2: 0, // 本次管理週期內不會被當成回收對象
    };
    c.look = { shirt: randPick(rng, SHIRTS), pants: randPick(rng, PANTS), skin: randPick(rng, SKINS), hair: randPick(rng, HAIRS), height: variantHeight(variant) };
    this._walkPed(c, 0, true);
    this.citizens.push(c);
    const lc = this._lodCenter;
    c.level = this.lod.classify(null, Math.hypot(c.x - lc.x, c.z - lc.z), true, false);
    const s = swapPolicy(null, c.level, this._canAcquire());
    if (!(s.acquire && this._acquireSkeleton(c))) {
      c.rep = 'impostor';
      this._showImpostor(c);
    }
    this.stats.spawned++;
    return c;
  }

  _canAcquire() {
    return this.peds.length < this.poolMax;
  }

  // 市民掛上骨架：池中同 variant 優先 → 骨架總數未達 poolMax 才新建 → 否則借池中任一個（市民改用該 variant）；
  // force（near 級 / 被拖出的司機）不受每幀數量與 poolMax 限制；exact：一定用市民的 variant（池中沒有就新建）
  _acquireSkeleton(c, force = false, exact = false) {
    const pool = this.pedPool;
    let p = null;
    for (let i = pool.length - 1; i >= 0; i--) {
      if (pool[i].variant !== c.variant) continue;
      p = pool[i];
      pool[i] = pool[pool.length - 1];
      pool.pop();
      break;
    }
    if (!p && this.peds.length + pool.length < this.poolMax && (force || this._creates < this._createLimit)) p = this._createPed(c.variant);
    if (!p && exact) p = this._createPed(c.variant);
    if (!p && pool.length) p = pool.pop();
    if (!p && force) p = this._createPed(c.variant);
    if (!p) return false;
    if (p.variant !== c.variant) {
      c.variant = p.variant;
      c.look.height = variantHeight(p.variant);
    }
    p.citizen = c;
    c.ped = p;
    c.rep = 'skeleton';
    for (const k of ROUTE_KEYS) p[k] = c[k];
    p.state = 'walk';
    p.kbx = 0;
    p.kbz = 0;
    p.settle = { settled: false, clearToStand: false };
    p.intent.moveX = 0;
    p.intent.moveZ = 0;
    p.intent.faceYaw = null;
    p.pendingAttacker = null;
    p.pendingFrom = null;
    if (p.look !== c.look) {
      repaintCharacter(p.character, c.look);
      p.look = c.look;
    }
    const { RAPIER, pw, router, groups } = this.physics;
    p.body = createPedestrianBody(RAPIER, pw, { x: p.x, y: p.y, z: p.z, yaw: p.yaw }, { groups, router });
    p.body.owner = p;
    p.interp = pw.register(p.body.body);
    const a = p.actor;
    a.id = c.id;
    p.slot = c.slot; // 降頻更新的錯開相位
    a.hp = a.maxHp;
    this._syncActor(p);
    p.anim.reset();
    p.anim.update(0, { speed: 0 });
    p.aiAcc = 0;
    p.animAcc = 0;
    p.walkAcc = 0;
    p.fine = true;
    p.moveD = 0;
    p.moveT = 0;
    p.animSpeed = 0;
    this.combat.register(a);
    const brain = new NpcBrain({ actor: a, heavy: p.variant === PED_HEAVY, seed: CITY_SEED });
    this.brains.set(a.id, brain);
    p.brain = brain;
    p.alive = true;
    p.mesh.visible = true;
    this.peds.push(p);
    this.impostors.hide(c.slot);
    this._swaps++;
    return true;
  }

  // 市民放掉骨架：路線狀態 / 位置抄回市民；退出 combat / 大腦、移除剛體、隱藏網格、回池；showImpostor 時同幀顯示替身
  _releaseSkeleton(c, showImpostor = true) {
    const p = c.ped;
    for (const k of ROUTE_KEYS) c[k] = p[k];
    this.combat.unregister(p.actor);
    this.brains.delete(p.actor.id);
    this.pw.unregister(p.interp);
    p.body.dispose();
    p.body = null;
    p.interp = null;
    p.brain = null;
    p.alive = false;
    p.citizen = null;
    p.mesh.visible = false;
    const i = this.peds.indexOf(p);
    this.peds[i] = this.peds[this.peds.length - 1];
    this.peds.pop();
    this.pedPool.push(p);
    c.ped = null;
    c.walkAcc = 0;
    if (showImpostor) {
      c.rep = 'impostor';
      this._showImpostor(c);
    } else c.rep = null;
    this._swaps++;
  }

  // 回收市民（出回收半徑 / 密度過多）：放掉骨架、隱藏替身、釋放 slot
  _recyclePed(c) {
    if (c.ped) this._releaseSkeleton(c, false);
    this.impostors.hide(c.slot);
    this.freeSlots.push(c.slot);
    const i = this.citizens.indexOf(c);
    this.citizens[i] = this.citizens[this.citizens.length - 1];
    this.citizens.pop();
    this.stats.recycled++;
  }

  _showImpostor(c) {
    this.impostors.set(c.slot, c.x, c.y + SURFACE_OFFSET, c.z, c.yaw, c.look);
    c.moved = false;
  }

  // 強制 near：倒地 / 起身 / 還手 / 逃跑 / 走回路線、combat 非 normal、被玩家鎖定
  _forceNear(p) {
    if (p.state !== 'walk') return true;
    if (this.combat.stateOf(p.actor) !== 'normal') return true;
    return !!this.context.lockTarget && this.context.lockTarget === p.actor;
  }

  // 視錐點積（不做建築 LOS，每幀用）；未設定 view 時視為看得到（mixer 不凍結）
  _inView(x, z) {
    const v = this.view;
    if (!v) return true;
    const dx = x - v.x;
    const dz = z - v.z;
    const d = Math.hypot(dx, dz);
    return d < 1e-6 || (dx * v.dx + dz * v.dz) / d >= v.cos;
  }

  // 每幀：逐市民分級（含遲滯）→ 骨架 / 替身切換；池滿時 near 的人借走最遠 mid、視野外、漫步中者的骨架；
  // 骨架數超過 poolMax（setBudget 降級）時逐步放掉最遠的非強制者
  _updateLod(center) {
    this._lodCenter = center;
    this._swaps = 0;
    this._creates = 0;
    const lod = this.lod;
    for (const c of this.citizens) {
      const p = c.ped;
      const o = p || c;
      const d = Math.hypot(o.x - center.x, o.z - center.z);
      c.inView = this._inView(o.x, o.z);
      const level = lod.classify(c.level, d, c.inView, p ? this._forceNear(p) : false);
      c.level = level;
      c.dist = d;
      if (level !== 'near' && this._swaps >= this._swapLimit) continue;
      const s = swapPolicy(c.rep, level, this._canAcquire());
      if (s.acquire) {
        this._acquireSkeleton(c, level === 'near');
      } else if (s.release) {
        this._releaseSkeleton(c);
      } else if (level === 'near' && c.rep !== 'skeleton') {
        const victim = this._stealVictim();
        if (victim) {
          this._releaseSkeleton(victim);
          this.stats.stolen++;
        }
        this._acquireSkeleton(c, true);
      }
    }
    for (let k = 0; this.peds.length > this.poolMax && this._swaps < this._swapLimit && k < SWAP_PER_FRAME; k++) {
      const victim = this._stealVictim(false);
      if (!victim) break;
      this._releaseSkeleton(victim);
    }
  }

  // 可被借走骨架的市民：mid 級、漫步中、非強制近處（hiddenOnly：限視野外）中最遠者
  _stealVictim(hiddenOnly = true) {
    let best = null;
    for (const p of this.peds) {
      const c = p.citizen;
      if (c.level !== 'mid' || (hiddenOnly && c.inView) || this._forceNear(p)) continue;
      if (!best || c.dist > best.dist) best = c;
    }
    return best;
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

  // 可回收（非開場）：視野外、漫步中、沒有在打鬥 / 倒地（替身市民一律漫步中）
  _canRecycle(c) {
    const p = c.ped;
    if (p && (p.state !== 'walk' || this.combat.stateOf(p.actor) !== 'normal')) return false;
    const o = p || c;
    return this._hidden(o.x, o.z);
  }

  // 密度管理：超出 plan.recycle 回收 → radius 內過多（或總數超過上限）時回收視野外的遠者 → 不足時在環帶視野外補生成
  // initial：開場補滿（生成點取 radius 內任何位置、不看視野、不限每次數量）
  _manageCrowd(center, initial = false) {
    const plan = this.plan;
    const cx = center.x;
    const cz = center.z;
    this._lodCenter = center;
    const r2 = plan.radius * plan.radius;
    const far2 = plan.recycle * plan.recycle;
    let count = 0;
    let recycled = 0;
    const farLimit = initial ? Infinity : CROWD_RECYCLE_PER_TICK;
    for (let i = this.citizens.length - 1; i >= 0; i--) {
      const c = this.citizens[i];
      const o = c.ped || c;
      const d2 = (o.x - cx) ** 2 + (o.z - cz) ** 2;
      c.d2 = d2;
      if (d2 > far2 && recycled < farLimit) {
        this._recyclePed(c);
        recycled++;
      } else if (d2 <= r2) count++;
    }
    const target = plan.target;
    const cap = crowdCap(target);
    const limit = initial ? Infinity : CROWD_MAX_PER_TICK;
    const in2 = CROWD_INNER * CROWD_INNER;
    let inner = 0;
    for (const c of this.citizens) if (c.d2 <= in2) inner++;
    // 過多：回收 near 外、視野外、漫步中的最遠者（radius 外尚未到回收半徑的人先走）
    if (count > target * (1 + CROWD_SLACK) || this.citizens.length > cap) {
      const near2 = plan.near * plan.near;
      const extra = this.citizens.filter((c) => c.d2 > near2 && this._canRecycle(c)).sort((a, b) => b.d2 - a.d2);
      let k = 0;
      for (; k < extra.length && k < limit && (count > target || this.citizens.length > cap); k++) {
        if (extra[k].d2 <= r2) count--;
        this._recyclePed(extra[k]);
      }
      // 總數仍超過上限（畫質降級後視野內的人回收不掉）：再回收視野內 pedFar 外的替身（最遠優先，遠景小人消失不明顯）
      if (this.citizens.length > cap && k < limit) {
        const far2 = plan.far * plan.far;
        const seen = this.citizens.filter((c) => c.rep === 'impostor' && c.d2 > far2).sort((a, b) => b.d2 - a.d2);
        for (let j = 0; j < seen.length && k < limit && this.citizens.length > cap; j++, k++) this._recyclePed(seen[j]);
      }
      return;
    }
    // 開場：radius 內任意位置補滿 target；平常：先補內圈（innerMin–CROWD_INNER），再補外圈（spawnMin–radius）
    if (initial) {
      this._spawnRing(cx, cz, 0, plan.radius, target - count, true);
      return;
    }
    const innerNeed = Math.min(this.innerTarget - inner, limit);
    const done = innerNeed > 0 ? this._spawnRing(cx, cz, this.innerMin, CROWD_INNER, innerNeed, false) : 0;
    const need = Math.min(target - count - done, limit - done);
    if (need > 0) this._spawnRing(cx, cz, plan.spawnMin, plan.radius, need, false);
  }

  // 在 rMin–rMax 環帶（平常只挑視野外）依權重補 need 人；回傳實際生成數
  _spawnRing(cx, cz, rMin, rMax, need, initial) {
    const plan = this.plan;
    const cap = crowdCap(plan.target);
    const vic2 = Math.min(rMax, plan.radius) ** 2;
    const rMin2 = rMin * rMin;
    const rMax2 = rMax * rMax;
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
      if (d2 < rMin2 || d2 > rMax2) continue;
      const ahead = v ? Math.max(0, ((sp.x - cx) * v.dx + (sp.z - cz) * v.dz) / Math.sqrt(d2)) : 0;
      total += sp.w * (1 + CROWD_AHEAD_BIAS * ahead);
      cand.push(sp);
      cw.push(total);
    }
    const rng = this.pedRng;
    const gap2 = CROWD_MIN_GAP * CROWD_MIN_GAP;
    let made = 0;
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
        if (this.citizens.some((c) => {
          const o = c.ped || c;
          return (o.x - sp.x) ** 2 + (o.z - sp.z) ** 2 < gap2;
        })) continue;
        spot = sp;
      }
      if (!spot) continue;
      // 市民總數已滿：回收一個本環帶外（補內圈時 = CROWD_INNER 外、補外圈時 = radius 外）、視野外、漫步中的最遠者來用
      if (this.citizens.length >= cap || !this.freeSlots.length) {
        let victim = null;
        for (const c of this.citizens) if (c.d2 > vic2 && (!victim || c.d2 > victim.d2) && this._canRecycle(c)) victim = c;
        if (!victim) break;
        this._recyclePed(victim);
      }
      if (this._spawnPed(spot)) made++;
    }
    return made;
  }

  // 管理週期：骨架池多出來的（setBudget 降級後）逐步釋放
  _trimPool() {
    for (let k = 0; k < CROWD_MAX_PER_TICK && this.pedPool.length && this.peds.length + this.pedPool.length > this.poolMax; k++) {
      disposeCharacter(this.pedPool.pop().character);
      this.stats.pedDisposed++;
    }
  }

  // 行人的 Actor 包裝（combat.js 契約）+ 動畫狀態機；id / combat 註冊 / 大腦在每次掛到市民時（_acquireSkeleton）才給
  _initPedCombat(ped, variant, clips) {
    ped.anim = new CharacterAnimator(ped.character, clips);
    ped.kbx = 0;
    ped.kbz = 0;
    ped.settle = { settled: false, clearToStand: false };
    ped.intent = { moveX: 0, moveZ: 0, run: false, faceYaw: null };
    ped.moveD = 0; // 自上次動畫取樣以來走過的水平路徑長（m；漫步取沿路線的距離，掉頭不抵銷）
    ped.moveT = 0; // 同期間位置實際推進過的模擬秒數（物理子步 / 累積走路）
    ped.animSpeed = 0; // 上次取樣的水平速度（沒有推進的幀沿用）
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
          if (!ped.body.active) ped.body.setActive(true);
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
    syncActor(p);
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
  // player：玩家 Actor（被拖出的司機還手對象，可省略）；lockTarget：玩家鎖定中的行人 Actor（強制近處，可省略）
  setContext({ playerInVehicle = false, vehicles = [], player = this.context.player, lockTarget = null } = {}) {
    this.context.playerInVehicle = playerInVehicle;
    this.context.vehicles = vehicles;
    this.context.player = player;
    this.context.lockTarget = lockTarget;
  }

  // ---------- 車流 ----------

  // 建一台車流車（tmp 已是 road 上 s 處的取樣點）；color = null → manifest 預設塗裝（公車）
  _spawnCar(scene, { RAPIER, pw, router, groups }, type, color, road, dir, s, factor) {
    const tmp = this._tmp;
    samplePolyline(road, s, tmp);
    const v = new Vehicle(scene, type, color, tmp.x, tmp.z, Math.atan2(tmp.dx * dir, tmp.dz * dir));
    v.ai = true;
    const car = {
      v,
      type,
      color,
      spec: v.spec,
      driverVariant: randPick(this.rng, PED_VARIANTS),
      road,
      dir,
      s,
      lat: dir * laneOffset(road),
      speed: 0,
      cruise: 1,
      factor,
      bus: type === 'bus',
      bike: type === MOTORBIKE,
      next: null, // 預選的下一路段（號誌前瞻用；_advanceNode 沿用）
      sigHold: false, // 上一步被號誌擋住
      goDelay: 0, // 轉綠後的起步反應倒數（s）
      hornDelay: -1, // 被按喇叭：開始反應的倒數（s，< 0 = 無）
      hornBoost: 0, // 加速離開的剩餘秒數
    };
    this._setCruise(car);
    car.speed = car.cruise;
    this._place(car, 0, true);
    car.body = createNpcCar(RAPIER, pw, { type, ...v.spec }, { x: v.pos.x, y: v.pos.y, z: v.pos.z, yaw: v.yaw }, { groups, router });
    car.interp = pw.register(car.body.body);
    this.cars.push(car);
    this.stats.carsSpawned++;
    return car;
  }

  // 自車流移除（剛體與網格釋放）
  _removeCar(car) {
    const i = this.cars.indexOf(car);
    if (i < 0) return false;
    this.cars.splice(i, 1);
    this.pw.unregister(car.interp);
    car.body.dispose();
    car.v.mesh.removeFromParent();
    car.interp = null;
    this.stats.carsRemoved++;
    return true;
  }

  // 各車種目標台數：公車 ≤ MAX_BUSES、機車 = round(總數 × motorbikeShare)，其餘為一般車
  _carQuota() {
    const T = this.carTarget;
    const bus = Math.min(MAX_BUSES, T);
    const bike = Math.min(T - bus, Math.round(T * this.budget.motorbikeShare));
    let nBus = 0;
    let nBike = 0;
    for (const c of this.cars) {
      if (c.bus) nBus++;
      else if (c.bike) nBike++;
    }
    return { bus, bike, car: T - bus - bike, nBus, nBike, nCar: this.cars.length - nBus - nBike };
  }

  // 補一台缺的車種（公車找不到主幹道生成點時這一輪改補機車 / 一般車，公車下一輪再試）
  _spawnTrafficCar(center, initial = false) {
    const q = this._carQuota();
    const kind = q.nBus < q.bus ? 'bus' : q.nBike < q.bike ? MOTORBIKE : 'car';
    const car = this._spawnKind(center, initial, kind);
    if (car || kind !== 'bus') return car;
    return this._spawnKind(center, initial, q.nBike < q.bike ? MOTORBIKE : 'car');
  }

  // center 附近車道生成點放一台 kind（'bus' | 'scooter' | 'car'）：開場 0–CAR_SPAWN_RADIUS 不看視野；平常 CAR_SPAWN_MIN 外、視野外
  _spawnKind(center, initial, kind) {
    const R = CAR_SPAWN_RADIUS;
    const list = this.carSpotGrid.query(center.x - R, center.z - R, center.x + R, center.z + R, this._carQ);
    const min2 = initial ? 0 : CAR_SPAWN_MIN * CAR_SPAWN_MIN;
    const rng = kind === 'bus' ? this.busRng : this.rng;
    for (let k = 0; k < CAR_SPAWN_TRIES && list.length; k++) {
      const sp = list[Math.floor(rng() * list.length)];
      if (kind === 'bus' && !sp.bus) continue;
      const d2 = (sp.x - center.x) ** 2 + (sp.z - center.z) ** 2;
      if (d2 < min2 || d2 > R * R) continue;
      const gap = kind === 'bus' ? CAR_BUS_GAP : CAR_MIN_GAP;
      if (this.cars.some((c) => (c.v.pos.x - sp.x) ** 2 + (c.v.pos.z - sp.z) ** 2 < gap * gap)) continue;
      if (!initial && !this._hidden(sp.x, sp.z)) continue;
      const dir = randPick(rng, allowedDirs(sp.road));
      const type = kind === 'car' ? randPick(rng, CAR_TYPES) : kind;
      const color = type === 'bus' ? null : type === 'taxi' ? '#f5c518' : randPick(rng, CAR_COLORS);
      return this._spawnCar(this.scene, this.physics, type, color, sp.road, dir, sp.s, 0.9 + rng() * 0.2);
    }
    return null;
  }

  // 車流密度管理：遠離且視野外者回收 → 超量時回收超額車種中最遠、視野外者 → 不足時補缺的車種
  _manageCars(center) {
    let ops = 0;
    const far2 = CAR_RECYCLE * CAR_RECYCLE;
    for (const car of this.cars) {
      if (ops >= CAR_MAX_PER_TICK) break;
      if (car.body.isWrecked) continue;
      const d2 = (car.v.pos.x - center.x) ** 2 + (car.v.pos.z - center.z) ** 2;
      if (d2 > far2 && this._hidden(car.v.pos.x, car.v.pos.z)) {
        this._removeCar(car);
        ops++;
        break;
      }
    }
    while (ops < CAR_MAX_PER_TICK && this.cars.length > this.carTarget) {
      const q = this._carQuota();
      const over = q.nBus > q.bus ? (c) => c.bus : q.nBike > q.bike ? (c) => c.bike : (c) => !c.bus && !c.bike;
      let victim = null;
      let best = -1;
      for (const pass of [over, () => true]) {
        for (const car of this.cars) {
          if (!pass(car) || car.body.isWrecked) continue;
          const d2 = (car.v.pos.x - center.x) ** 2 + (car.v.pos.z - center.z) ** 2;
          if (d2 > best && this._hidden(car.v.pos.x, car.v.pos.z)) {
            best = d2;
            victim = car;
          }
        }
        if (victim) break;
      }
      if (!victim) break;
      this._removeCar(victim);
      ops++;
    }
    while (ops < CAR_MAX_PER_TICK && this.cars.length < this.carTarget) {
      ops++;
      if (!this._spawnTrafficCar(center, false)) break;
    }
  }

  _setCruise(car) {
    car.cruise = (CRUISE[car.road.type] || 9) * car.factor;
  }

  // 下一路段（到端點時要接的路）：第一次問到時抽選並記住，_advanceNode 沿用同一個選擇；null = 沒有可接的路（掉頭）
  _nextOption(car) {
    const n = car.next;
    if (n && n.from === car.road && n.dir === car.dir) return n.o;
    const endIdx = car.dir > 0 ? car.road.pts.length - 1 : 0;
    const p = car.road.pts[endIdx];
    const opts = optionsAt(p.x, p.z, car.road);
    // 公車只走主幹道，沒有可接的主幹道就掉頭
    const pool = car.bus ? opts.filter((o) => BUS_ROAD_TYPES.has(o.road.type)) : opts;
    const o = pool.length ? pool[Math.floor(this.rng() * pool.length)] : null;
    car.next = { from: car.road, dir: car.dir, o };
    return o;
  }

  // 到達端點：換到相連道路；沒有可接的路就掉頭
  _advanceNode(car) {
    const o = this._nextOption(car);
    car.next = null;
    if (o) {
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
    car.next = null;
    this.stats.uTurns++;
  }

  // 前方停止線（本路段 + 預選的下一路段，SIGNAL_LOOK 內，依路口遠近排序）：寫入 this._stopBuf，回傳筆數；
  // 每筆 d = 車頭到停止線的沿路距離（< 0 = 已越過、還沒過路口中心）
  _stopsAhead(car) {
    const buf = this._stopBuf;
    const half = car.v.spec.length / 2;
    let n = this._collectStops(car.road, car.dir, car.s, 0, 0, half, 0);
    const remain = car.dir > 0 ? car.road.length - car.s : car.s;
    if (n < buf.length && remain < SIGNAL_LOOK) {
      const o = this._nextOption(car);
      // 下一路段起點的路口已由本路段的停止點處理，只看路口中心在起點之後的
      if (o) n = this._collectStops(o.road, o.dir, o.s, remain, 0.5, half, n);
    }
    return n;
  }

  // 把 road 上行進方向 dir、位於 s 前方的停止點依路口遠近插入 this._stopBuf（重用物件，滿了丟最遠的）；base = 到 road 上 s 的沿路距離
  _collectStops(road, dir, s, base, minToNode, half, n) {
    const buf = this._stopBuf;
    const cap = buf.length;
    for (const st of this.lights.roadStops(road)) {
      if (st.dir !== dir) continue;
      const toNode = base + dir * (st.nodeS - s);
      if (toNode < base + minToNode || toNode > SIGNAL_LOOK + st.signal.stopDist) continue;
      let i = n;
      while (i > 0 && buf[i - 1].toNode > toNode) i--;
      if (i >= cap) continue;
      const end = n < cap ? n : cap - 1;
      const e = buf[end];
      for (let k = end; k > i; k--) buf[k] = buf[k - 1];
      buf[i] = e;
      e.stop = st;
      e.d = base + dir * (st.stopS - s) - half;
      e.toNode = toNode;
      if (n < cap) n++;
    }
    return n;
  }

  // 號誌限速：紅燈 / 煞得住的黃燈 → 停止線前停車；相鄰兩道停止線第一道放行時才看第二道；停等轉綠有起步反應時間
  _signalLimit(car, dt) {
    const L = this.lights;
    const v = car.v;
    const n = this._stopsAhead(car);
    const buf = this._stopBuf;
    let i = 0;
    while (i < n && buf[i].d < 0) i++; // 已越過的停止線：清空路口
    let go = true;
    let first = null;
    if (i < n) {
      first = buf[i];
      go = L.carMayProceed(first.stop.signal, v.pos.x, v.pos.z, first.d, car.speed);
      const second = i + 1 < n ? buf[i + 1] : null;
      if (go && second && second.stop.signal !== first.stop.signal && second.d - first.d < SIGNAL_PAIR_GAP) {
        // 第二道綠燈剩餘不夠開過去、且在第一道綠燈結束前就會轉綠 → 停在第一道前等兩道一起過；
        // 兩路口時相對不上（第二道轉綠前第一道就沒綠燈了）→ 照走，改在第二道停止線前（分隔島內）等，不會永遠卡在第一道
        const st2 = L.approachState(second.stop.signal, v.pos.x, v.pos.z);
        const need = car.speed > 3 ? second.d / car.speed + 0.5 : GO_REACT_MAX + Math.sqrt(second.d / 2) + 0.5;
        if (!(st2.color === 'green' && st2.remaining >= need) && st2.color === 'red') {
          const st1 = L.approachState(first.stop.signal, v.pos.x, v.pos.z);
          if (st1.color === 'green' && st2.remaining + need <= st1.remaining) go = false;
        }
      }
    }
    if (!go) {
      car.sigHold = true;
      car.goDelay = 0;
      return Math.sqrt(2 * SIGNAL_DECEL * Math.max(0, first.d - SIGNAL_STOP_GAP));
    }
    if (car.sigHold) {
      car.sigHold = false;
      if (car.speed < GO_HOLD_SPEED) {
        car.goDelay = GO_REACT_MIN + this.sigRng() * (GO_REACT_MAX - GO_REACT_MIN);
        const gr = this.stats.goReact;
        if (gr.length < 500) gr.push(car.goDelay);
      }
    }
    if (car.goDelay > 0) {
      car.goDelay -= dt;
      return 0;
    }
    return Infinity;
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

  // ---------- 行人移動（實作在 traffic-peds.js；以下方法只是外部 / 本類別零星呼叫用的薄包裝）----------
  // 子步路徑不經過這些方法：_step → stepPeds → updatePed → walkPed → syncActor、_afterStep → afterStepPeds → syncActor、
  //   sync → thinkPeds（降頻走路 walkPed / syncActor）皆在 traffic-peds.js 模組內直接呼叫，wrap _updatePed / _walkPed / _syncActor 攔不到
  // 測試要攔子步行為：wrap Traffic 實例的 _step / _afterStep / _thinkPeds，或 mock traffic-peds.js 的匯出函式

  _pathPoint(p, out) {
    return pathPoint(this, p, out);
  }

  _walkPed(p, dt, snap = false) {
    return walkPed(this, p, dt, snap);
  }

  _returnPed(p, dt) {
    returnPed(this, p, dt);
  }

  _pedBlocked(x, z) {
    return pedBlocked(x, z);
  }

  _pedMove(p, dx, dz) {
    return pedMove(p, dx, dz);
  }

  _reactPed(p, dt) {
    reactPed(this, p, dt);
  }

  // 最近的行人路線區段（RETURN_SEARCH 內生成點所屬；找不到就擴大搜尋）：回傳 { route, s, d } 或 null
  _nearestRoute(x, z, extra = null) {
    const t = this._ret || (this._ret = { x: 0, z: 0 });
    let best = null;
    for (const R of [RETURN_SEARCH, RETURN_SEARCH * 4]) {
      const seen = new Set(extra ? [extra] : []);
      for (const sp of this.spotGrid.query(x - R, z - R, x + R, z + R, this._spotQ)) seen.add(sp.route);
      for (const r of seen) {
        const pr = projectOnRoad(r.road, x, z);
        const probe = { road: r.road, off: r.off, s: Math.max(r.s0, Math.min(r.s1, pr.s)), dir: 1 };
        this._pathPoint(probe, t);
        const d = Math.hypot(t.x - x, t.z - z);
        if (!best || d < best.d) best = { d, route: r, s: probe.s };
      }
      if (best) break;
    }
    return best;
  }

  _startReturn(p) {
    startReturn(this, p);
  }

  _updatePed(p, dt) {
    return updatePed(this, p, dt);
  }

  // simDt：本幀物理實際推進的模擬秒數（sync 由 _step 累加的 _simAcc 取得）
  _thinkPeds(simDt) {
    thinkPeds(this, simDt);
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
    car.next = null;
    car.sigHold = false;
    car.goDelay = 0;
    this._setCruise(car);
    car.v.yaw = pose.yaw;
    car.v.pos.y = pose.y;
  }

  // 物理子步前：車道 / 人行道邏輯 → kinematic 目標 pose（wrecked / 倒地者、mid 級漫步中的骨架跳過）
  _step(dt) {
    this._simAcc += dt; // 本幀已推進的模擬秒數（sync 取走後歸零）
    for (const car of this.cars) {
      if (car.body.isWrecked) continue;
      this._driveCar(car, dt, this.blockers);
      const v = car.v;
      car.body.setTargetPose(v.pos.x, v.pos.y, v.pos.z, v.yaw, dt);
    }
    stepPeds(this, dt);
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
    afterStepPeds(this, dt);
  }

  // 車道邏輯（每個物理子步一次）：前方有東西就停、號誌停車、沿道路前進、到端點換路或掉頭、出界掉頭
  // blockers：[{ x, z }] 會讓車流停下來的東西（玩家、玩家的車、路邊的車）
  _driveCar(car, dt, blockers) {
    const v = car.v;
    const fx = Math.sin(v.yaw);
    const fz = Math.cos(v.yaw);
    // 被按喇叭：反應倒數結束後加速離開一段時間（仍受跟車 / 號誌限制）
    if (car.hornDelay >= 0) {
      car.hornDelay -= dt;
      if (car.hornDelay < 0) car.hornBoost = HORN_BOOST_SEC;
    } else if (car.hornBoost > 0) car.hornBoost -= dt;
    let target = car.cruise * (car.hornBoost > 0 ? HORN_BOOST : 1);
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
    if (this.lights) target = Math.min(target, this._signalLimit(car, dt));
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

  // ---------- 轉接器（契約 §5）----------

  // 搶車候選：(x, z) 的 maxDist 內、車速 ≤ CARJACK_MAX_SPEED、非殘骸的車流車，依距離排序
  carjackCandidates(x, z, maxDist) {
    const list = [];
    for (const car of this.cars) {
      if (car.body.isWrecked || Math.abs(car.speed) > CARJACK_MAX_SPEED) continue;
      const v = car.v;
      const d = Math.hypot(v.pos.x - x, v.pos.z - z);
      if (d > maxDist) continue;
      list.push({ d, c: { car, x: v.pos.x, z: v.pos.z, yaw: v.yaw, type: car.type, color: car.color, speed: car.speed, driverVariant: car.driverVariant } });
    }
    list.sort((a, b) => a.d - b.d);
    return list.map((e) => e.c);
  }

  // 把車自車流移除（剛體與網格釋放），回傳交給 vehicles.adopt 的位姿；之後由 _manageCars 在視野外補車
  releaseCar(car) {
    if (!car || this.cars.indexOf(car) < 0) return null;
    const v = car.v;
    const out = {
      type: car.type,
      color: car.color,
      x: v.pos.x,
      y: v.pos.y,
      z: v.pos.z,
      yaw: v.yaw,
      vx: Math.sin(v.yaw) * car.speed,
      vz: Math.cos(v.yaw) * car.speed,
      driverVariant: car.driverVariant,
    };
    this._removeCar(car);
    this.stats.carsReleased++;
    return out;
  }

  // 被拖出的司機：在 (x, z) 生成一名骨架行人（強制近處、不受骨架池上限），先倒地（往 yaw 方向＝車門外），
  // 起身後大腦依性格對 attacker（省略 → setContext 的 player）還手或逃離車子；之後走回最近的人行道
  spawnEjectedDriver({ x, z, yaw = 0, variant = null, attacker = null } = {}) {
    if (!this.freeSlots.length) {
      // 替身 slot 用完：回收最遠的可回收市民
      let victim = null;
      for (const c of this.citizens) if ((!victim || c.dist > victim.dist) && this._canRecycle(c)) victim = c;
      if (victim) this._recyclePed(victim);
      else this._ensureImpostors(this.impostors.max + IMPOSTOR_SPARE);
    }
    const near = this._nearestRoute(x, z);
    if (!near) return null;
    const rng = this.pedRng;
    const v = PED_VARIANTS.includes(variant) ? variant : randPick(rng, PED_VARIANTS);
    const r = near.route;
    const c = {
      id: `ped-${this._spawnSeq++}`,
      slot: this.freeSlots.pop(),
      route: r,
      road: r.road,
      off: r.off,
      s0: r.s0,
      s1: r.s1,
      s: near.s,
      dir: rng() < 0.5 ? 1 : -1,
      speed: 1.1 + rng() * 0.5,
      x,
      y: this.terrain.querySurface(x, z, Infinity, this._q).y,
      z,
      yaw,
      variant: v,
      look: { shirt: randPick(rng, SHIRTS), pants: randPick(rng, PANTS), skin: randPick(rng, SKINS), hair: randPick(rng, HAIRS), height: variantHeight(v) },
      level: 'near',
      rep: null,
      ped: null,
      inView: true,
      walkAcc: 0,
      moved: false,
      d2: 0,
      dist: 0,
    };
    this.citizens.push(c);
    this._acquireSkeleton(c, true, true);
    const p = c.ped;
    // 倒地：combat 沒有公開的「直接倒地」API，這裡把 combat 狀態設成 knockdown（不發 knockdown 事件，不算玩家擊倒）
    const ce = this.combat.entries && this.combat.entries.get(p.actor.id);
    if (ce) {
      ce.state = 'knockdown';
      ce.stateAt = this.combat.now();
      ce.windowOpen = false;
      ce.hitTimes.length = 0;
    }
    const sx = Math.sin(yaw);
    const sz = Math.cos(yaw);
    p.actor.body.knockdown({ x: sx * EJECT_IMPULSE, y: EJECT_IMPULSE * EJECT_LIFT, z: sz * EJECT_IMPULSE });
    p.anim.trigger('knockdown');
    p.pendingAttacker = attacker || this.context.player || null;
    p.pendingFrom = { x: x - sx * 1.5, z: z - sz * 1.5 }; // 車門位置：沒有攻擊者時逃離這裡
    this.stats.spawned++;
    return p;
  }

  // 喇叭：訂閱 bus 的 vehicle:horn；回傳取消訂閱函式
  attachBus(bus) {
    this.detachBus();
    const fn = (evt) => this.onHorn(evt);
    const off = bus.on('vehicle:horn', fn);
    this._busOff = typeof off === 'function' ? off : () => bus.off && bus.off('vehicle:horn', fn);
    return this._busOff;
  }

  detachBus() {
    if (this._busOff) this._busOff();
    this._busOff = null;
  }

  // vehicle:horn { vehicle, x, z, dirX, dirZ }：前方 HORN_PED_RANGE 內行人 brain.hear；前方同車道的車流車加速離開
  // 回傳 { peds, cars }（反應的人數 / 台數）
  onHorn(evt) {
    if (!evt) return { peds: 0, cars: 0 };
    const { x, z } = evt;
    let dirX = evt.dirX;
    let dirZ = evt.dirZ;
    const l = Math.hypot(dirX, dirZ);
    if (!(l > 1e-6)) {
      const yaw = evt.vehicle ? evt.vehicle.yaw || 0 : 0;
      dirX = Math.sin(yaw);
      dirZ = Math.cos(yaw);
    } else {
      dirX /= l;
      dirZ /= l;
    }
    const hear = { type: 'horn', x, z, dirX, dirZ };
    let peds = 0;
    for (const p of this.peds) {
      if (!p.alive) continue;
      const dx = p.x - x;
      const dz = p.z - z;
      if (dx * dx + dz * dz > HORN_PED_RANGE * HORN_PED_RANGE || dx * dirX + dz * dirZ < 0) continue;
      if (p.brain && p.brain.hear) {
        p.brain.hear(hear);
        peds++;
      }
    }
    let cars = 0;
    for (const car of this.cars) {
      if (car.body.isWrecked) continue;
      const v = car.v;
      const dx = v.pos.x - x;
      const dz = v.pos.z - z;
      const along = dx * dirX + dz * dirZ;
      if (along <= 0 || along > HORN_CAR_RANGE || Math.abs(dx * dirZ - dz * dirX) > HORN_CAR_LAT) continue;
      if (Math.sin(v.yaw) * dirX + Math.cos(v.yaw) * dirZ < HORN_CAR_HEADING) continue;
      if (car.hornDelay < 0 && car.hornBoost <= 0) car.hornDelay = this.sigRng() * HORN_REACT_MAX;
      cars++;
    }
    this.stats.hornPeds += peds;
    this.stats.hornCars += cars;
    return { peds, cars };
  }

  // ---------- 每幀 ----------

  // 每幀（物理 step 之後）：自建的 combat 推進 → 密度管理 → 分層 → 大腦決策 → 網格依插值姿態擺放、輪子 / 角色動畫 / 替身
  // → 行人剛體依 plan.physicsRadius 啟用 / 休眠；center：玩家 / 鏡頭焦點（密度管理與分層的中心），省略時用出生點
  // 時間步契約：dt = 渲染幀時間，只用於插值 / 輪子與角色動畫；模擬狀態（自建 combat 時鐘、密度管理計時、大腦、降頻走路）
  // 用 simDt = 本幀物理子步實際推進的秒數（_step 累加），60Hz 每幀 1 子步時兩者相同
  sync(dt, center = this.center) {
    const alpha = this.pw.alpha;
    const simDt = this._simAcc;
    this._simAcc = 0;
    this.clock += simDt;
    this.frame++;
    if (this.ownsCombat) this.combat.update(simDt);
    this._crowdT += simDt;
    if (this._crowdT >= CROWD_TICK) {
      this._crowdT = 0;
      this._manageCrowd(center);
      this._manageCars(center);
      this._trimPool();
    }
    this._updateLod(center);
    this._thinkPeds(simDt);
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

    for (const p of this.peds) {
      const b = p.body;
      // 動畫：渲染 dt 推 mixer、速度 = moveD / moveT（實際推進的模擬秒數），見 traffic-peds.js animatePed
      animatePed(this, p, dt);
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
    for (const c of this.citizens) if (c.rep === 'impostor' && c.moved) this._showImpostor(c);
    this.impostors.commit();
    // 行人物理分層：plan.physicsRadius 內啟用、外面休眠（倒地 / 起身中者不列，保持啟用）
    setActiveByDistance(this.pedBodies(this._bodyBuf), center.x, center.z, this.plan.physicsRadius);
  }

  // 遠距簡化用（setActiveByDistance，ACTIVE_RADIUS）：只列車流車；行人剛體由 sync 依 plan.physicsRadius 自行處理
  bodies(out = []) {
    return this.carBodies(out);
  }

  carBodies(out = []) {
    for (const car of this.cars) out.push(car.body);
    return out;
  }

  // 可依距離休眠的行人剛體（骨架行人；倒地 / 起身中者不列）
  pedBodies(out = []) {
    out.length = 0;
    for (const p of this.peds) if (p.state !== 'down' && p.state !== 'getup') out.push(p.body);
    return out;
  }
}

// 市民 ↔ 骨架行人之間互抄的路線 / 位置欄位
const ROUTE_KEYS = ['route', 'road', 'off', 's0', 's1', 's', 'dir', 'speed', 'x', 'y', 'z', 'yaw'];
