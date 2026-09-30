// 車流與行人：車流沿 OSM 的 primary / secondary / tertiary 折線靠右行駛（臺灣右側通行），
// 到端點就換到相連道路，沒有可接的路或出界就掉頭；公車少量（MAX_BUSES）只走主幹道（BUS_ROAD_TYPES）；行人沿道路邊緣來回走。
// 不做避障（只有「前方有東西就停」的簡單判斷）
// 高度一律取 terrain.querySurface：車輛依四輪貼地並做 pitch / roll（同 vehicle.js），行人在坡上身體保持直立
// 物理（src/physics/npc-bodies.js）：車道 / 人行道邏輯在每個物理子步前算出 pose，交給 kinematic 剛體（setTargetPose / setPose）；
// - NPC 車被強撞（contacts.js onVehicleHitVehicle 超過門檻）→ wrecked 動態剛體，期間跳過車道邏輯；
//   可恢復時 recover() 並以目前位置投影回道路重新對位（橫向偏移由車道邏輯平滑拉回車道）
// 行人 = 骨架角色（src/characters，三種 variant 依固定種子）+ CharacterAnimator + combat.js Actor + npc-ai.js NpcBrain：
// - ped.state：walk（來回走）/ return（走回人行道點）/ react（套用大腦的 flee / fight / dodge 意圖）/ down（倒地，剛體 dynamic）/ getup（起身動畫中）
// - 大腦 mode 為 wander 時走原本的人行道邏輯；否則套用 moveX / moveZ / run / faceYaw，回 wander 時投影回最近的人行道路段再繼續
// - 被打（combat 'hit'）：擊退位移以 2D 建築 / 水域檢查滑動（不穿牆）；knockdown → 剛體切 dynamic（npc-bodies hit）+ 倒地動畫
// - 被車撞（onVehicleHitPedestrian）→ combat.onVehicleHit；每個物理子步 settleCheck，combat 判定可起身時 standUp（剛體 recover）+ getup
// - 未注入 combat 時自建一個 CombatSystem 並在 sync 內推進（無頭測試 / 單獨使用）；遊戲本體由 main.js 注入共用的 combat 並自行 update
// 網格每幀依插值後的剛體姿態擺放；停用中（setActiveByDistance 半徑外）的剛體不動，網格改用車道 / 人行道 pose；
// 距鏡頭焦點 > PED_ANIM_RADIUS 的行人暫停 mixer（狀態機與事件照跑）
import { TRAFFIC_CAR_COUNT, PEDESTRIAN_COUNT, CITY_SEED, SURFACE_OFFSET } from './data/city.js';
import { surfaceRoads, TRAFFIC_TYPES, nodeRoads, nodeKey, inBounds, buildingAt, inWater } from './citymodel.js';
import { samplePolyline, closestOnSegment } from './geom.js';
import { Vehicle, meshOrigin } from './vehicle.js';
import { createCharacter, getCharacterManifest, CharacterAnimator } from './characters/index.js';
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
const PED_ROAD_TYPES = new Set(['primary', 'secondary', 'tertiary', 'residential', 'unclassified']);
const PED_VARIANTS = ['pedestrian', 'pedestrian_f', 'pedestrian_heavy']; // 角色 manifest 的三種 variant
const PED_HEAVY = 'pedestrian_heavy'; // 壯碩體型：大腦還手比例較高
const PED_HP = 100;
const PED_RUN_SPEED = 4.5; // 逃跑 / 追擊跑速（m/s，推測：一般成人慢跑到快跑之間）
const PED_TURN_RATE = 10; // react 狀態轉向速率（1/s）：還手時要很快對準目標
const PED_ANIM_RADIUS = 120; // 距焦點超過此距離（m）暫停 mixer 更新
const PED_KNOCKBACK_DECAY = 12; // 擊退速度的指數衰減率（1/s）：位移總和 = 初速 / 衰減率，約 0.25 s 內推完
const PED_BLOCK_PAD = PED_RADIUS; // 行人自由移動（react / 擊退）時與建築 / 水域保持的距離（m）
const PED_BOUNDS_MARGIN = 3;
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

function allowedDirs(road) {
  if (road.oneway === 1) return [1];
  if (road.oneway === -1) return [-1];
  return [1, -1];
}

export class Traffic {
  // terrain：唯一高度場（需有 querySurface）；physics = { RAPIER, pw（PhysicsWorld）, router（contacts.js）, groups }
  // combat：共用的 CombatSystem（省略 → 自建並在 sync 內 update）
  constructor(scene, { center = { x: 0, z: 0 }, terrain, physics, combat = null }) {
    const { RAPIER, pw, router, groups } = physics;
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
    this.pedRoutes = []; // 通過 _pedPathClear 的 { road, off }：回 wander 時找最近的人行道路段
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

    // 行人：出生點附近道路的路緣外側，沿道路來回走
    const pedRoads = surfaceRoads.filter((r) => {
      if (!PED_ROAD_TYPES.has(r.type) || r.length < 30) return false;
      return r.pts.some((p) => Math.hypot(p.x - center.x, p.z - center.z) < 320);
    });
    guard = 0;
    const variantRng = mulberry32(CITY_SEED + 11); // 另開種子：不改動既有行人路線 / 配色的抽樣序列
    const manifest = getCharacterManifest();
    const clips = manifest ? manifest.clips : [];
    const cleared = new Map(); // `${road.id}|${off}` → 是否通過路徑檢查
    while (this.peds.length < PEDESTRIAN_COUNT && pedRoads.length && guard++ < 400) {
      const road = pedRoads[Math.floor(rng() * pedRoads.length)];
      const side = rng() < 0.5 ? 1 : -1;
      const off = side * (road.hw + 1.3);
      const key = `${pedRoads.indexOf(road)}|${side}`;
      if (!cleared.has(key)) {
        const ok = this._pedPathClear(road, off);
        cleared.set(key, ok);
        if (ok) this.pedRoutes.push({ road, off });
      }
      if (!cleared.get(key)) continue;
      const colors = {
        shirt: randPick(rng, SHIRTS),
        pants: randPick(rng, PANTS),
        skin: randPick(rng, SKINS),
        hair: randPick(rng, HAIRS),
      };
      const variant = randPick(variantRng, PED_VARIANTS);
      const character = createCharacter({ variant, colors });
      const mesh = character.root;
      mesh.rotation.order = 'YXZ'; // 方塊人倒地時先 yaw 再往後躺
      scene.add(mesh);
      const ped = { mesh, character, road, off, s: rng() * road.length, dir: rng() < 0.5 ? 1 : -1, speed: 1.1 + rng() * 0.5, yaw: 0, y: Infinity, x: 0, z: 0, state: 'walk' };
      rng(); // 保留原本擺臂相位的抽樣，後續行人的抽樣序列不變
      this._walkPed(ped, 0, true);
      ped.body = createPedestrianBody(RAPIER, pw, { x: ped.x, y: ped.y, z: ped.z, yaw: ped.yaw }, { groups, router });
      ped.body.owner = ped;
      ped.interp = pw.register(ped.body.body);
      this._initPedCombat(ped, variant, clips, this.peds.length);
      this.peds.push(ped);
    }

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
    this.combat.on('hit', ({ target, knockback }) => {
      const p = target.ped;
      if (!p || !knockback || !this.peds.includes(p)) return;
      p.kbx += knockback.x * PED_KNOCKBACK_DECAY;
      p.kbz += knockback.z * PED_KNOCKBACK_DECAY;
    });
    // 行人 hp 歸零：DEAD_HOLD 後 combat 發 dead → 首版直接復活（hp 回滿、原地起身）
    this.combat.on('dead', ({ target }) => {
      if (target.ped && this.peds.includes(target.ped)) this.combat.revive(target);
    });
  }

  // 行人的 Actor 包裝（combat.js 契約）+ 動畫狀態機 + 反應大腦
  _initPedCombat(ped, variant, clips, index) {
    ped.anim = new CharacterAnimator(ped.character, clips);
    ped.kbx = 0;
    ped.kbz = 0;
    ped.settle = { settled: false, clearToStand: false };
    ped.intent = { moveX: 0, moveZ: 0, run: false, faceYaw: null };
    ped.lastX = ped.x;
    ped.lastZ = ped.z;
    ped.actor = {
      id: `ped-${index}`,
      kind: 'pedestrian',
      pos: { x: ped.x, y: ped.y, z: ped.z },
      yaw: ped.yaw,
      hp: PED_HP,
      maxHp: PED_HP,
      anim: ped.anim,
      faction: 'civilian',
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
    this.combat.register(ped.actor);
    this.brains.set(ped.actor.id, new NpcBrain({ actor: ped.actor, heavy: variant === PED_HEAVY, seed: CITY_SEED }));
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

  // 行人路徑每 4m 檢查一次：不能穿過建築、水域或出界
  _pedPathClear(road, off) {
    const tmp = this._tmp;
    for (let s = 0; s <= road.length; s += 4) {
      samplePolyline(road, s, tmp);
      const x = tmp.x - tmp.dz * off;
      const z = tmp.z + tmp.dx * off;
      if (!inBounds(x, z, 3) || buildingAt(x, z, 0.5) || inWater(x, z, 0.5)) return false;
    }
    return true;
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

  // 沿人行道來回走：更新 p.x / p.y / p.z / p.yaw
  _walkPed(p, dt, snap = false) {
    p.s += p.dir * p.speed * dt;
    if (p.s > p.road.length) {
      p.s = p.road.length;
      p.dir = -1;
    } else if (p.s < 0) {
      p.s = 0;
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

  // 自由移動（react 意圖 / 擊退）的阻擋：建築、水域、世界邊界（2D 檢查，與 _pedPathClear 同一套資料）
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
    const face = it.faceYaw ?? (moving ? Math.atan2(it.moveX, it.moveZ) : null);
    if (face !== null) p.yaw += angleDelta(p.yaw, face) * Math.min(1, PED_TURN_RATE * dt);
  }

  // 回 wander：投影回最近的人行道路段（已通過路徑檢查的路線），以 return 走過去再繼續來回走
  _startReturn(p) {
    const t = this._ret || (this._ret = { x: 0, z: 0 });
    let best = null;
    for (const r of this.pedRoutes) {
      const pr = projectOnRoad(r.road, p.x, p.z);
      const probe = { road: r.road, off: r.off, s: Math.max(0, Math.min(r.road.length, pr.s)), dir: p.dir };
      this._pathPoint(probe, t);
      const d = Math.hypot(t.x - p.x, t.z - p.z);
      if (!best || d < best.d) best = { d, ...probe };
    }
    if (best) {
      p.road = best.road;
      p.off = best.off;
      p.s = best.s;
    } else {
      p.s = Math.max(0, Math.min(p.road.length, projectOnRoad(p.road, p.x, p.z).s));
    }
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
  _thinkPeds(dt) {
    const ctx = this.context;
    for (const p of this.peds) {
      const brain = this.brains.get(p.actor.id);
      const it = brain.update(dt, ctx);
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

  // 每幀（物理 step 之後）：自建的 combat 推進 → 大腦決策 → 網格依插值姿態擺放、輪子 / 角色動畫
  // center：鏡頭焦點（遠距暫停 mixer），省略時用出生點
  sync(dt, center = this.center) {
    const alpha = this.pw.alpha;
    this.clock += dt;
    if (this.ownsCombat) this.combat.update(dt);
    this._thinkPeds(dt);
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

    const r2 = PED_ANIM_RADIUS * PED_ANIM_RADIUS;
    for (const p of this.peds) {
      const b = p.body;
      // 動畫速度 = 本幀實際水平位移 / dt（倒地時剛體帶著走，速度不影響一次性動作）
      const speed = dt > 0 ? Math.hypot(p.x - p.lastX, p.z - p.lastZ) / dt : 0;
      p.lastX = p.x;
      p.lastZ = p.z;
      const near = (p.x - center.x) ** 2 + (p.z - center.z) ** 2 <= r2;
      p.anim.update(dt, { speed, animate: near });
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
