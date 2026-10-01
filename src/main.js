// 臺中GTA 進入點（Phase 3 整合）：建立場景、分步載入、選單流程、存檔經濟、主迴圈（世界依真實 OSM 資料生成）
// 地形一律取 terrain（唯一高度場）：querySurface 注入給 player / vehicle / traffic / camera；秋紅谷與下沉廣場細節網格由 qiuhonggu.js 產生
// 物理（Rapier，src/physics/**）：世界碰撞體取真實 terrain（heightfield / walkable / 湖面）與 buildings.js 的建築 colliders；
// 主迴圈 = 每幀讀輸入快照（input.snapshot）→ PhysicsWorld.step(dt)（固定 1/60 s 子步：子步前號誌相位 / 角色 move / 車輛 preStep / 車流 kinematic pose，
// 子步後 contacts router.drain / 耐久去重時鐘與停放 / wrecked / 倒地狀態）→ 號誌燈色 → combat.update → 以插值結果同步網格 → 車輛耐久 / 煙 → 鏡頭 / HUD → 渲染
//   每幀排程與物理一幀的順序在 core/loop.js；模擬計時（號誌、對抗時鐘、KO、回收）吃物理實際推進的秒數（docs/dev/interfaces.md「時間步契約」）
// 核心樞紐（docs/dev/interfaces.md）：bus（core/events 單例）串起選單 / 經濟 / 耐久 / 搶車 / 喇叭；settings（core/settings 單例）驅動
//   靈敏度、反轉 Y、畫質（人車數即時 traffic.setBudget，DPR / 陰影 / 視距即時重套）、介面大小、FPS 顯示、新手提示
// 選單流程：載入完成 → 開始畫面（背景環繞鏡頭）→ game:start（繼續 = 還原存檔）→ 遊戲；Esc / P / 觸控暫停鈕 / pointer lock 被解除 → 暫停選單
//   （世界停止更新、照常渲染、input.enabled = false）；「繼續」在同一手勢內 requestPointerLock；回主選單 = 存檔後回開始畫面
// 按鍵一律讀 core/actions 的 action：左鍵 / 觸控攻擊 = 攻擊、F 上下車 / 搶車 / 扶起、H 喇叭、V 鏡頭段、C 回頭看、M 地圖、Esc / P 暫停、N 快轉
// 上車：enter_car 動作播完（animator 自動進 drive）才真正進駕駛，期間鎖輸入；搶車（carjack.js）期間 state.mode = 'carjack' 同樣鎖輸入
// Phase 4 接線（docs/dev/interfaces.md §10–§19、附錄 B）：
//   武器 createWeapons（raycast / sweep = PhysicsWorld.castRay / intersections + contacts router 的 collider → 行人 actor）、
//   模型掛 hero weapon_socket、player.weaponLayer 姿勢 / 動作 / 後座、肩後鏡頭（瞄準中滾輪不縮放）、槍聲 → 行人 hear、彈藥拾取、武器 HUD；
//   combat 'hit' → combat:hit → 血跡 blood.onHit、ped:knockdown → blood.onKnockdown（bat / bullet 擊倒也掉錢）；
//   程序音效 createAudio（手勢 unlock、每幀 update）；委託 missions / 導航 nav / 大地圖 bigMap（M）/ 打卡 checkins / 小吃圖鑑 food（G 或選單）；
//   interactable 仲裁（任務 3 > 打卡 2 > 小吃 1 > 彈藥 0，同級取近）→ 互動提示、E 執行；
//   全螢幕面板（接單 / 結算、大地圖、圖鑑）開啟時世界與輸入暫停，大地圖 / 圖鑑開啟時不渲染 3D；存檔 v2（weapons / missions / collect）
import * as THREE from 'three';
import './style.css';
import osm from './data/osm-city.json';
import { TRIVIA } from './data/city.js';
import { LoadingScreen } from './loading.js';
import { Input } from './input.js';
import { registerTouchButton } from './touch.js';
import { PhysicsOccluder } from './collision.js';
import { buildWorld, describeLocation } from './world.js';
import { buildQiuhonggu } from './qiuhonggu.js';
import { buildBuildings } from './buildings.js';
import { loadLandmarkModels, projectLatLon } from './landmarks/index.js';
import { computeSpawn, computeParkedVehicles, tigerCity } from './places.js';
import { ATTRIBUTION, buildingAt, getTerrain, heightAt, inBounds, inWater, nearestNamedRoad, surfaceFootways, surfaceRoads } from './citymodel.js';
import { loadCharacterModels, getCharacterManifest } from './characters/index.js';
import { loadVehicleModels } from './vehicle-model.js';
import { CombatSystem, pedKnockdownPayload } from './combat.js';
import { Player, PLAYER_RADIUS } from './player.js';
import { VehicleManager, VEHICLE_TYPES, driveControls } from './vehicle.js';
import { Traffic } from './traffic.js';
import { createTrafficLights } from './traffic-lights.js';
import { createCarjack } from './carjack.js';
import { DAMAGE_EXP, DAMAGE_MIN_SPEED, createVehicleDamage, impactDamage } from './vehicle-damage.js';
import { CameraRig } from './camera.js';
import { HUD } from './hud.js';
import { DayNight } from './daynight.js';
import { nextFrame } from './utils.js';
import { applyRendererQuality, createAdaptiveResolution, isTouch, pixelRatioFor, qualityTier, setGameActive, setQualitySetting } from './mobile.js';
import { bus } from './core/events.js';
import { settings } from './core/settings.js';
import { KEYMAP_HELP, TOUCH_HELP } from './core/actions.js';
import { qualityBudget } from './core/quality.js';
import { createAutosave, createSaveStore, defaultSave, SAVE_VERSION } from './save.js';
import { createEconomy, LOOT_MIN, LOOT_MAX } from './economy.js';
import { createMenu } from './ui/menu.js';
import { createMapView } from './ui/map-view.js';
import { initPhysics, PhysicsWorld } from './physics/world.js';
import { buildWorldColliders, osmWithBuildings } from './physics/colliders.js';
import { GROUPS, queryGroups, WORLD as G_WORLD, VEHICLE as G_VEHICLE, NPC_CAR as G_NPC_CAR, PEDESTRIAN as G_PED, DEBRIS as G_DEBRIS } from './physics/groups.js';
import { CharacterBody } from './physics/character.js';
import { createContactRouter } from './physics/contacts.js';
import { ACTIVE_RADIUS } from './physics/npc-bodies.js';
import { createWorldStep, createFrameLoop } from './core/loop.js';
import { createWeapons, gunshotListeners, loadWeaponModels, createAmmoPickups, WEAPONS } from './weapons/index.js';
import { makeBatSegment } from './weapons/models.js';
import { createWeaponHud } from './weapons/hud.js';
import { attachWeapon, detachWeapon } from './character-animation.js';
import { createBloodFx } from './blood-fx.js';
import { createAudio } from './audio/index.js';
import { IMPACT_MIN as MISSION_IMPACT_MIN, createMissions } from './missions/index.js';
import { buildRoadGraph, createNavigator } from './navigation.js';
import { createBigMap } from './map/big-map.js';
import { createCheckins } from './collect/checkins.js';
import { createFoodGuide } from './collect/food-guide.js';
import { landmarkPoints } from './core/landmark-points.js';

const ENTER_DIST = 2.6; // 上車 / 扶起距離（m，距車身圓）
const CARJACK_SCAN = 6; // 搶車候選的搜尋半徑（m，traffic.carjackCandidates；實際門檻由 carjack.canStart 判斷車門距離）
const PLAYER_KO_SEC = 3; // 玩家 hp 歸零倒地後多久起身（原地 3 m 內空位優先，player.recoverAfterKnockout）
const AUTOSAVE_SEC = 15; // 自動存檔間隔（s）
const MAX_STEP_DIST = 30; // 單幀位移超過此值（傳送 / 重生）不計入里程（m）
const ROAD_NAME_SEC = 0.5; // 駕駛時路名查詢間隔（s）
const CLEANUP_SEC = 2; // 搶來 / 報廢車輛的回收檢查間隔（s）
const ADOPTED_FAR = 200; // 搶來的車（玩家已離開）超過此距離就回收（m）
const WRECK_FAR = 150; // 熄火報廢的車超過此距離就回收（m）
const FPS_SAMPLE_SEC = 0.5; // FPS 顯示更新間隔（s）
const PERF_FRAMES = 120; // __game.perf() 統計的最近幀數
const CRASH_SHAKE_SPEED = 25; // 撞擊相對速度（m/s）達此值時鏡頭震動 trauma = 1
const HINT_ATTACK_SEC = 8; // 步行幾秒後出現「攻擊」提示卡
const HINT_PAUSE_SEC = 30; // 遊玩幾秒後出現「暫停選單」提示卡
const FOG_NEAR_RATIO = 0.25; // 畫質視距縮短時霧的起點（相對霧終點）
const SAVE_POS_SHRINK = 0.85; // 存檔位置重疊查詢用的膠囊半徑比例：存下的位置本來就站得住，留一點誤差避免貼牆點被誤判
const AIM_CANDIDATE_RANGE = 40; // 觸控瞄準輔助的候選行人半徑（m，契約 §13）
const JUNCTION_SCAN_SEC = 0.5; // 音效「最近路口距離」的查詢間隔（s）
const SKID_REF = 8; // 側滑速度（m/s）達此值時 skid01 = 1（附錄 B 音效）
const BASE_URL = import.meta.env.BASE_URL ?? './';

// ---------- 純函式（tools/test/integration-p3.mjs 會擷取本區塊在 node 驗證；不可引用模組內其他識別字）----------
// @integration-p3:pure-begin
// HUD 底部常駐按鍵提示：由 KEYMAP_HELP / TOUCH_HELP（help）依模式取子集，不寫死按鍵文字
const CONTROLS_HINT = {
  walk: [['步行', 'attack'], ['步行', 'enterExit'], ['步行', 'sprint'], ['通用', 'map'], ['通用', 'pause']],
  drive: [['駕駛', 'horn'], ['駕駛', 'lookBack'], ['駕駛', 'enterExit'], ['通用', 'camera'], ['通用', 'pause']],
};
function helpItem(help, action, group = null) {
  for (const g of help) {
    if (group && g.group !== group) continue;
    for (const it of g.items) if (it.action === action) return it;
  }
  return null;
}
function controlsHintItems(help, mode) {
  const out = [];
  for (const [group, action] of CONTROLS_HINT[mode] || []) {
    const it = helpItem(help, action, group);
    if (it) out.push({ keys: it.keys, desc: it.desc });
  }
  return out;
}
// 新手提示卡文字（id → 說明表的動作）；找不到說明列回 null（不顯示）
const HINT_ACTIONS = { move: ['步行', 'move'], attack: ['步行', 'attack'], enter: ['步行', 'enterExit'], pause: ['通用', 'pause'] };
function hintText(help, id) {
  const a = HINT_ACTIONS[id];
  const it = a && helpItem(help, a[1], a[0]);
  return it ? `${it.keys}：${it.desc}` : null;
}
// 存檔位置是否可用：有限數、在地圖範圍內、不在實體建築碰撞體內、不在水中
//   deps = { solidAt?, buildingAt, inWater, inBounds }：solidAt(x, z) 為真 = 角色膠囊放在該點會與建築碰撞體重疊（物理查詢）；
//   沒給 solidAt 時退回 buildingAt(x, z, 0)（點在輪廓內才算）。騎樓 / 遮簷下這類貼著外牆、玩家走得到的點不可判為建築內
function validSavedPosition(p, deps) {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return false;
  if (deps.inBounds && !deps.inBounds(p.x, p.z, 5)) return false;
  if (deps.solidAt ? deps.solidAt(p.x, p.z) : deps.buildingAt(p.x, p.z, 0)) return false;
  if (deps.inWater(p.x, p.z, 0.5)) return false;
  return true;
}
// 最近 n 筆數值的平均與 p95（ms）
function perfStats(buf, n) {
  if (!n) return { avg: 0, p95: 0 };
  const a = Array.from(buf.slice(0, n)).sort((x, y) => x - y);
  let sum = 0;
  for (const v of a) sum += v;
  return { avg: sum / n, p95: a[Math.min(n - 1, Math.floor(n * 0.95))] };
}
// interactable 仲裁（契約 §17）：priority 高者優先（任務 3 > 打卡 2 > 小吃 1 > 彈藥 0），同級取 dist 近者；null 項略過；都沒有回 null
function pickInteractable(list) {
  let best = null;
  let bp = -Infinity;
  let bd = Infinity;
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (!it) continue;
    const p = Number.isFinite(it.priority) ? it.priority : 0;
    const d = Number.isFinite(it.dist) ? it.dist : Infinity;
    if (p > bp || (p === bp && d < bd)) {
      best = it;
      bp = p;
      bd = d;
    }
  }
  return best;
}
// 存檔統計 = 經濟統計 + 整合層自行累加的欄位（missionsDone / missionsFailed / shotsFired 為本局累計值；
//   pedsKnockedOut 另加 bat / bullet 擊倒數，economy 只算 punch）
function statsWithExtra(stats, extra) {
  return {
    ...stats,
    missionsDone: extra.missionsDone,
    missionsFailed: extra.missionsFailed,
    shotsFired: extra.shotsFired,
    pedsKnockedOut: (stats.pedsKnockedOut || 0) + extra.pedsKnockedOut,
  };
}
// 把 +Y 轉到 (dx, dy, dz) 方向的單位四元數（Rapier 膠囊沿本地 Y）；零向量 → 單位四元數；寫入 out（不配置）
function capsuleRotation(dx, dy, dz, out) {
  const l = Math.hypot(dx, dy, dz);
  if (l < 1e-9) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    out.w = 1;
    return out;
  }
  const ux = dx / l;
  const uy = dy / l;
  const uz = dz / l;
  if (uy < -1 + 1e-9) {
    out.x = 1;
    out.y = 0;
    out.z = 0;
    out.w = 0;
    return out;
  }
  // q = (Y × u, 1 + Y·u) 正規化；Y × u = (uz, 0, −ux)
  const w = 1 + uy;
  const n = Math.hypot(uz, ux, w);
  out.x = uz / n;
  out.y = 0;
  out.z = -ux / n;
  out.w = w / n;
  return out;
}
// @integration-p3:pure-end

// 耐久扣值 → 等效撞擊速度（impactDamage 的反函數，以 static 係數估；撞行人係數 0.2 會得到較低速度，偏保守）
// vehicle:damaged 的 delta 是去重後「多出的部分」，反推值只會偏低，交給委託的合併視窗取最大值
function impactSpeedFromDamage(vehicle, delta) {
  const k = impactDamage(vehicle, DAMAGE_MIN_SPEED + 1, 'static'); // = K × 質量係數（relSpeed − 4 = 1）
  if (!(k > 0) || !(delta > 0)) return 0;
  return DAMAGE_MIN_SPEED + Math.pow(delta / k, 1 / DAMAGE_EXP);
}

// 老虎城玻璃等材質的反射環境：scene.environment 已有就沿用；否則以 PMREM 從簡單天空漸層場景產生一張
//   只給材質 envMap 用，不設成 scene.environment（避免改變全場景光照）；產生後 dispose generator 與暫時場景
function landmarkEnvMap(renderer, scene) {
  if (scene.environment) return scene.environment;
  const sky = new THREE.Scene();
  const geo = new THREE.SphereGeometry(10, 32, 16);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const zenith = new THREE.Color(0x6f9fd8);
  const horizon = new THREE.Color(0xdfe8f0);
  const ground = new THREE.Color(0x55524c);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const h = pos.getY(i) / 10; // -1（正下方）～ 1（天頂）
    if (h >= 0) c.copy(horizon).lerp(zenith, Math.pow(h, 0.6));
    else c.copy(horizon).lerp(ground, Math.min(1, -h * 3));
    c.toArray(colors, i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide });
  sky.add(new THREE.Mesh(geo, mat));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromScene(sky, 0.04).texture;
  pmrem.dispose();
  geo.dispose();
  mat.dispose();
  return envMap;
}

// JSON 讀取（地標 / 委託 / 小吃 manifest 共用）：404、非 JSON（dev server 回退成 index.html）、網路錯誤 → null，不丟例外
async function fetchJson(url) {
  try {
    const res = await fetch(/^(\w+:|\/)/.test(url) ? url : BASE_URL + url, { cache: 'no-cache' });
    if (!res.ok) return null;
    const text = await res.text();
    if (/^\s*</.test(text)) return null;
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

const loading = new LoadingScreen(TRIVIA);

async function init() {
  const total = 14;
  let step = 0;
  const progress = async (text) => {
    step++;
    loading.setProgress(step / total, text);
    await nextFrame();
  };

  // 畫質：設定值（auto / 各級）→ tier → 預算（人車數、分層半徑、視距、陰影、DPR 上限）
  setQualitySetting(settings.get('quality'));
  let tier = qualityTier();
  let budget = qualityBudget(tier);
  const touch = isTouch();

  await progress('建立渲染器…');
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  document.getElementById('app').appendChild(renderer.domElement);
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.3, budget.viewDist);
  const dayNight = new DayNight(scene, defaultSave().world.hour);
  const fogBase = scene.fog ? { near: scene.fog.near, far: scene.fog.far } : null;
  // 視距：鏡頭 far = budget.viewDist；霧終點不超過視距，遠處不會被 far 平面硬切
  const applyViewDist = (dist) => {
    camera.far = dist;
    camera.updateProjectionMatrix();
    if (!fogBase || !scene.fog) return;
    scene.fog.far = Math.min(fogBase.far, dist * 0.95);
    scene.fog.near = Math.min(fogBase.near, scene.fog.far * FOG_NEAR_RATIO);
  };
  applyViewDist(budget.viewDist);
  // 效能分級：需在光源建立後呼叫，低品質時才能調降 / 關閉陰影貼圖
  applyRendererQuality(renderer, 1, scene, tier);
  let adapt = createAdaptiveResolution(renderer, tier);
  let adaptive = tier === 'low'; // 自適應解析度只在低品質（手機）啟用
  const terrain = getTerrain();

  await progress('依 OSM 鋪設道路、公園與水域…');
  const world = buildWorld(scene, { anisotropy });
  const qiuhonggu = buildQiuhonggu(terrain, { footways: surfaceFootways });
  scene.add(qiuhonggu.group);

  await progress('載入地標模型…');
  const envMap = landmarkEnvMap(renderer, scene);
  const landmarks = await loadLandmarkModels((done, n, name) => {
    loading.setProgress((step + done / n) / total, `載入地標模型 ${done}/${n}：${name}`);
  }, { envMap });
  // 地標點（任務 / 打卡 / 大地圖共用，契約 §17）：manifest 缺檔 → []
  const landmarkPts = landmarkPoints((await fetchJson('models/manifest.json')) ?? [], projectLatLon);

  await progress('載入角色與車輛模型…');
  await Promise.all([loadCharacterModels(), loadVehicleModels()]);

  await progress('依 OSM 輪廓擠出七期建築…');
  const buildings = buildBuildings(scene, { anisotropy, landmarks });

  await progress('計算出生點…');
  const spawn = computeSpawn();

  await progress('初始化物理引擎…');
  const RAPIER = await initPhysics();
  const pw = new PhysicsWorld(RAPIER);
  // 必須在 buildQiuhonggu / buildBuildings 之後：木平台等 addWalkable 追加的可行走面才會一併建成碰撞體
  const colliderStats = buildWorldColliders(RAPIER, pw.world, { osm: osmWithBuildings(osm, buildings.colliders), terrain });
  const router = createContactRouter(RAPIER, pw);
  pw.onAfterStep((dt) => router.drain(dt));
  const physics = { RAPIER, pw, router, groups: GROUPS };
  pw.stepOnce(); // 更新 broad phase，第一幀之前的查詢（下車點、鏡頭掃掠）就看得到世界碰撞體

  // ---------- 遊戲狀態 ----------
  const state = {
    started: false, // 遊戲進行中（false = 開始畫面的背景環繞）
    paused: false, // 暫停選單開啟中：世界停止更新、照常渲染
    mode: 'walk', // 'walk' | 'entering'（上車動作中）| 'carjack'（搶車中）| 'drive'
    vehicle: null,
    placeId: null,
    koTimer: 0, // 玩家被打倒後的起身倒數（秒）
    pendingFall: null, // 物理子步內機車倒地（vehicles.onFall），step 結束後才處理下車
    walkTime: 0, // 本局步行累計秒數（新手提示用）
    playTime: 0, // 本局遊玩秒數（新手提示用）
  };
  const focus = new THREE.Vector3();

  await progress('停放車輛與號誌…');
  const parked = computeParkedVehicles(spawn);
  const vehicles = new VehicleManager(scene, parked, terrain, physics, { bus, roads: surfaceRoads }); // 掉出世界時重置到最近道路
  // 熄火黑煙夜間提亮：dayNight.night（0–1）
  const dmg = createVehicleDamage({ bus, THREE, scene, isNight: () => dayNight.night });
  for (const v of vehicles.vehicles) dmg.attach(v);
  pw.onAfterStep((h) => dmg.step(h)); // 去重時鐘 = 模擬時間；在 router.drain 之後（同一子步的撞擊看到的是推進前的時刻）
  const adopted = new Set(); // 搶車 adopt 出來的車（玩家離開後遠了就回收）
  const lights = createTrafficLights();
  lights.buildMeshes(scene, { heightAt });
  pw.onBeforeStep((h) => lights.step(h)); // 相位 = 模擬時間；須在 new Traffic 之前登記（同一子步車流讀到本子步時刻）

  // 對抗計時用遊戲時鐘（暫停 / 切背景時不前進）；玩家駕駛的車撞人 → 駕駛 = 玩家（byPlayer）
  let gameTime = 0;
  const combat = new CombatSystem({
    now: () => gameTime,
    vehicleDriver: (ref) => (state.mode === 'drive' && ref && state.vehicle && ref.body === state.vehicle.body ? player.actor : null),
  });

  await progress('放出行人與車流…');
  const traffic = new Traffic(scene, { center: spawn, terrain, physics, combat, budget, lights, bus });

  await progress('準備角色與鏡頭…');
  const player = new Player(scene, spawn);
  // 膠囊依主角身高（manifest height）換算，半徑維持 PLAYER_RADIUS
  const character = new CharacterBody(RAPIER, pw, { x: spawn.x, y: spawn.y, z: spawn.z, radius: PLAYER_RADIUS, halfHeight: player.capsuleHalfHeight });
  player.attachPhysics(character);
  player.attachCombat(combat);
  player.placeAt(spawn.x, spawn.z, spawn.yaw, terrain);
  const input = new Input(renderer.domElement);
  input.setSensitivity({ mouse: settings.get('lookSensMouse'), touch: settings.get('lookSensTouch') });
  input.setInvertY(settings.get('invertY'));
  const occluder = new PhysicsOccluder(pw, colliderStats);
  const rig = new CameraRig(camera, occluder, terrain);
  rig.yaw = spawn.yaw;
  rig.playerHeight = player.height; // 步行目標點依主角身高

  await progress('繪製小地圖…');
  const hud = new HUD();
  const help = touch ? TOUCH_HELP : KEYMAP_HELP;

  await progress('準備武器、委託與導航…');
  // ---------- 武器（W1）：raycast / sweep = PhysicsWorld 查詢 + contacts router 的 collider → actor 對照 ----------
  const QF_NO_SENSOR = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
  const shotGroups = queryGroups(G_WORLD | G_VEHICLE | G_NPC_CAR | G_PED | G_DEBRIS); // 子彈：世界 / 車 / 行人（不含玩家膠囊與感測區）
  const pedGroups = queryGroups(G_PED); // 球棒掃掠：只看行人
  const entityOfCollider = (c) => (c ? router.entityOf(c.handle) : null);
  const actorOfCollider = (c) => {
    const ent = entityOfCollider(c);
    return ent && ent.kind === 'pedestrian' && ent.owner && ent.owner.actor ? ent.owner.actor : null;
  };
  // 射線：槍口射線排除玩家自己的膠囊；回傳物件重用（weapons / aim.js 讀完即用，不長期持有）
  const rayHit = { point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, actor: null, surface: 'world' };
  const rayQuery = { flags: QF_NO_SENSOR, groups: shotGroups, excludeCollider: undefined };
  const raycast = (origin, dir, maxDist, opts) => {
    const self = opts && opts.excludeActor === player.actor;
    rayQuery.excludeCollider = self && character.enabled ? character.collider : undefined;
    let h = null;
    try {
      h = pw.castRay(origin, dir, maxDist, rayQuery);
    } catch (err) {
      h = null;
    }
    if (!h) return null;
    const ent = entityOfCollider(h.collider);
    const actor = actorOfCollider(h.collider);
    rayHit.point.x = h.x;
    rayHit.point.y = h.y;
    rayHit.point.z = h.z;
    rayHit.normal.x = h.nx;
    rayHit.normal.y = h.ny;
    rayHit.normal.z = h.nz;
    rayHit.actor = actor && !(opts && opts.excludeActor === actor) ? actor : null;
    rayHit.surface = ent && (ent.kind === 'vehicle' || ent.kind === 'npcCar') ? 'vehicle' : 'world';
    return rayHit;
  };
  // 膠囊掃掠：from–to 為軸（半長 = |to − from| / 2、半徑 r），與行人剛體重疊者 → actor 陣列（重用）
  const sweepShape = new RAPIER.Capsule(0.1, 0.1);
  const sweepPos = { x: 0, y: 0, z: 0 };
  const sweepRot = { x: 0, y: 0, z: 0, w: 1 };
  const sweepOut = [];
  const sweepQuery = { flags: QF_NO_SENSOR, groups: pedGroups };
  let sweepExclude = null;
  const sweepHit = (c) => {
    const a = actorOfCollider(c);
    if (a && a !== sweepExclude && sweepOut.indexOf(a) < 0) sweepOut.push(a);
    return true;
  };
  const sweep = (from, to, radius, opts) => {
    sweepOut.length = 0;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    sweepShape.halfHeight = Math.max(1e-3, Math.hypot(dx, dy, dz) / 2);
    sweepShape.radius = Math.max(1e-3, radius);
    sweepPos.x = (from.x + to.x) / 2;
    sweepPos.y = (from.y + to.y) / 2;
    sweepPos.z = (from.z + to.z) / 2;
    capsuleRotation(dx, dy, dz, sweepRot);
    sweepExclude = (opts && opts.excludeActor) || null;
    try {
      pw.intersections(sweepPos, sweepRot, sweepShape, sweepHit, sweepQuery);
    } catch (err) {
      sweepOut.length = 0;
    }
    return sweepOut;
  };
  const recoilSetting = () => {
    const v = settings.get('recoil');
    return Number.isFinite(v) ? v : 1;
  };
  let weaponModels = null; // loadWeaponModels 完成後 { bat, pistol }
  let batSegment = null; // 球棒模型掛上後的實際棒身世界座標（makeBatSegment）；沒有時 weapons 用程序揮擊弧
  const weapons = createWeapons({
    bus,
    combat,
    player,
    settings,
    now: () => gameTime,
    isTouch: touch,
    manifest: getCharacterManifest(),
    raycast,
    sweep,
    // 動畫注入：player.weaponLayer.play；開槍另疊 settings.recoil 強度的加法後座
    playAnim: (name) => {
      if (name === 'pistol_fire') player.weaponLayer.addRecoil(recoilSetting());
      if (name !== 'weapon_equip') return player.weaponLayer.play(name);
      equipStarting = true; // 重播 weapon_equip 會先 cancel 上一段：這個 cancel 不算換手
      const dur = player.weaponLayer.play(name);
      equipStarting = false;
      if (!(dur > 0)) finishWeaponSwap(); // 換裝動作沒播（缺 clip / 全身狀態擋下）→ 立即換模型
      return dur;
    },
    getBatSegment: (grip, tip) => (batSegment ? batSegment(grip, tip) : false),
  });
  // 武器模型掛到主角 weapon_socket（缺則右手骨）；空手拿下；駕駛中隱藏
  let swapPending = false; // weapon:equip 已發、模型還沒換（等 weapon_equip 的換手點）
  let equipStarting = false;
  const applyWeaponModel = () => {
    swapPending = false;
    if (!weaponModels) return;
    const id = weapons.current;
    const m = id === 'bat' ? weaponModels.bat : id === 'pistol' ? weaponModels.pistol : null;
    if (!m) {
      detachWeapon(player.character);
      return;
    }
    if (player.character.weapon !== m.object) {
      attachWeapon(player.character, m.object, { gripOffset: m.grip.toArray(), rotation: m.socketQuaternion.toArray() });
    }
    m.object.visible = state.mode !== 'drive';
  };
  loadWeaponModels()
    .then((m) => {
      weaponModels = m;
      batSegment = makeBatSegment(m.bat);
      applyWeaponModel();
    })
    .catch(() => {});
  // 換裝時機：select 發 weapon:equip（state 'equipping'）後播 weapon_equip，到換手點（layer 'swap'）才換模型；
  // 讀檔 restore 發 weapon:equip 時 state 已是 'idle' → 立即換。模型一律依 weapons.current，快速連按最後必停在目前武器
  const finishWeaponSwap = () => {
    if (swapPending) applyWeaponModel();
  };
  bus.on('weapon:equip', () => {
    swapPending = true;
    if (weapons.state !== 'equipping') applyWeaponModel();
  });
  player.weaponLayer.on('swap', finishWeaponSwap);
  // 保底：換手點前動作播完或被打斷（受擊 / 上車 / 開槍）→ 立即換
  const equipEnded = (name) => {
    if (name === 'weapon_equip' && !equipStarting) finishWeaponSwap();
  };
  player.weaponLayer.on('finished', equipEnded);
  player.weaponLayer.on('cancel', equipEnded);
  // 持武器姿勢：球棒 bat_hold、手槍 pistol_hold / 瞄準 pistol_aim（clip 缺 → 退回 hold / 不疊加）
  let weaponPose = null;
  const updateWeaponPose = (aiming) => {
    const id = weapons.current;
    const want = id === 'bat' ? 'bat_hold' : id === 'pistol' ? (aiming ? 'pistol_aim' : 'pistol_hold') : 'none';
    if (want === weaponPose) return;
    weaponPose = want;
    if (!player.weaponLayer.setPose(want)) player.weaponLayer.setPose(want === 'pistol_aim' ? 'pistol_hold' : 'none');
  };
  // 瞄準資料（每幀重用）：鏡頭中心射線、槍口世界座標（模型掛上時）、觸控吸附候選（40 m 內骨架行人）
  const aim = { origin: camera.position, dir: new THREE.Vector3(0, 0, 1), aiming: false, muzzle: null, candidates: null };
  const muzzleW = new THREE.Vector3();
  const aimCandidates = [];
  const muzzleWorld = () => {
    const m = weaponModels && weaponModels.pistol;
    if (!m || !m.muzzle || !m.object.parent || !m.object.visible) return null;
    m.object.updateWorldMatrix(true, false);
    return muzzleW.copy(m.muzzle).applyMatrix4(m.object.matrixWorld);
  };
  const fillAim = (aimHeld) => {
    const pistol = weapons.current === 'pistol';
    camera.getWorldDirection(aim.dir);
    aim.aiming = !!aimHeld && pistol;
    aim.muzzle = pistol ? muzzleWorld() : null;
    aim.candidates = null;
    if (!touch || !pistol) return aim;
    aimCandidates.length = 0;
    const r2 = AIM_CANDIDATE_RANGE * AIM_CANDIDATE_RANGE;
    for (const p of traffic.peds) {
      const a = p.actor;
      if (!a) continue;
      const dx = a.pos.x - player.pos.x;
      const dz = a.pos.z - player.pos.z;
      if (dx * dx + dz * dz <= r2) aimCandidates.push(a);
    }
    aim.candidates = aimCandidates;
    return aim;
  };
  // 步行中的武器輸入：1 / 2 / 3 直選、Q 循環、R 裝填；攻擊（空手 / 球棒按一下、手槍按住連發）取代 player.punch()
  const handleWeaponInput = (snap) => {
    fillAim(snap.down.aim);
    if (snap.pressed.slot1) weapons.select(0);
    else if (snap.pressed.slot2) weapons.select(1);
    else if (snap.pressed.slot3) weapons.select(2);
    if (snap.pressed.weaponCycle) weapons.cycle();
    if (snap.pressed.reload) weapons.reload();
    const fire = weapons.current === 'pistol' ? snap.down.attack : snap.pressed.attack;
    if (fire) weapons.attack(aim);
  };
  const whud = createWeaponHud({ root: document.body, touchRoot: document.getElementById('touch-ui'), weapons, input, isTouch: touch });
  const whudState = { driving: false, aimBlend: 0 };
  gunshotListeners(bus, () => traffic.brains.values()); // weapon:fire → 30 m 內行人 hear({ type: 'gunshot' })
  // 無限備彈後不放置彈藥盒（場景 / 小地圖皆無）；系統與串接保留供日後其他拾取物使用
  const pickups = createAmmoPickups({ scene, bus, points: [], heightAt, canPickup: () => weapons.ammo().reserve < WEAPONS.pistol.reserveMax });
  bus.on('pickup:ammo', (e) => {
    const n = weapons.addAmmo(e && e.amount);
    if (n > 0) hud.toast(`撿到手槍子彈 ×${n}`, 2);
  });

  // ---------- 流血（W3）：只做地面血跡與血滴；settings.showBlood 由模組自行訂閱 ----------
  const blood = createBloodFx({ scene, settings, heightAt });
  combat.on('hit', (e) => bus.emit('combat:hit', e)); // payload 已含契約 §10 全欄位
  bus.on('combat:hit', (e) => blood.onHit(e));
  bus.on('ped:knockdown', (e) => blood.onKnockdown(e));

  // ---------- 音效（W2）：首次（與之後每次）使用者手勢 unlock；每幀 update 見 updateAudio ----------
  const audio = createAudio({ bus, settings });
  const unlockAudio = () => audio.unlock();
  for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, unlockAudio, { capture: true, passive: true });

  // ---------- 委託 / 導航 / 大地圖 / 打卡 / 小吃圖鑑（W4–W6）----------
  const missions = createMissions({
    bus,
    scene,
    root: document.body,
    landmarks: landmarkPts,
    addMoney: (n, reason) => economy.add(n, reason),
    fetchJson,
    now: () => gameTime,
    rng: Math.random,
    heightAt,
  });
  const graph = buildRoadGraph(surfaceRoads);
  const nav = createNavigator({ bus, graph, scene, heightAt });
  const checkins = createCheckins({ bus, landmarks: landmarkPts, addMoney: (n, reason) => economy.add(n, reason), root: document.body });
  const food = createFoodGuide({ bus, scene, root: document.body, fetchJson, addMoney: (n, reason) => economy.add(n, reason) });
  // 小地圖 / 大地圖標記：各模組 markers() 合併（陣列重用；小地圖另加路邊可開的車）
  const hudMarkers = [];
  const mapMarkers = [];
  const pushAll = (out, list) => {
    if (list) for (let i = 0; i < list.length; i++) out.push(list[i]);
  };
  const collectMarkers = (out, withVehicles) => {
    out.length = 0;
    pushAll(out, missions.markers());
    pushAll(out, nav.markers());
    pushAll(out, checkins.markers());
    pushAll(out, food.markers());
    pushAll(out, pickups.markers());
    if (withVehicles) for (const c of vehicles.vehicles) if (!c.driven) out.push(c.pos);
    return out;
  };
  const mapPlayer = { x: 0, z: 0, yaw: 0 };
  const bigMap = createBigMap({
    root: document.body,
    bus,
    landmarks: landmarkPts,
    getPlayer: () => {
      mapPlayer.x = focus.x;
      mapPlayer.z = focus.z;
      mapPlayer.yaw = state.mode === 'drive' && state.vehicle ? state.vehicle.yaw : player.yaw;
      return mapPlayer;
    },
    getMarkers: () => collectMarkers(mapMarkers, false),
    getRoute: () => nav.route(),
    onPick: (x, z) => {
      nav.setDestination(x, z, '地圖標記', 'map', focus);
      bigMap.draw();
    },
  });
  // interactable 仲裁的候選（重用）；小吃 / 彈藥只在步行時問
  const interCands = [null, null, null, null];
  const nearestInteractable = (pos, walking) => {
    interCands[0] = missions.nearest(pos);
    interCands[1] = checkins.nearest(pos);
    interCands[2] = walking ? food.nearest(pos) : null;
    interCands[3] = walking ? pickups.nearest(pos) : null;
    return pickInteractable(interCands);
  };
  // 互動提示：hud.setInteractPrompt（I4b 新增）存在時與上車提示分開；否則共用 setPrompt（上車 / 扶起提示優先）
  const setPrompts = (vehicleText, inter) => {
    const text = inter ? inter.text : null;
    if (hud.setInteractPrompt) {
      hud.setPrompt(vehicleText);
      hud.setInteractPrompt(text);
    } else hud.setPrompt(vehicleText || text);
  };
  // 全螢幕面板：接單 / 結算（missions）、大地圖、圖鑑；開啟中世界與輸入暫停
  const panelOpen = () => missions.isModalOpen() || bigMap.isOpen() || food.isOpen();
  const hide3D = () => bigMap.isOpen() || food.isOpen(); // 大地圖 / 圖鑑蓋滿畫面：不渲染 3D
  const openGuide = () => {
    if (!state.started) return;
    food.open();
    if (menu.isOpen()) menu.close(); // 從暫停選單開：先開圖鑑再關選單（resumeGame 見到面板開著就不鎖滑鼠）
  };
  bus.on('ui:openGuide', () => openGuide());
  // 觸控圖鑑鈕：touch.js 預設註冊為隱藏佔位；此處（input 建立 = initTouch 之後）以同 id 帶 onTap 重新註冊後顯示
  registerTouchButton({ id: 'tb-guide', label: '圖鑑', slot: 'tl3', showWhen: 'walk', onTap: () => openGuide() });

  // ---------- 存檔與經濟 ----------
  let storage;
  try {
    storage = window.localStorage; // 停用儲存時存取本身就會丟例外 → 交給 save.js 退回記憶體
  } catch (err) {
    storage = undefined;
  }
  const store = createSaveStore({ storage });
  const initialLoad = store.load(); // 只為了取得狀態提示（繼續時會重新讀）
  let economy = createEconomy({ bus, initial: initialLoad.data });
  // 整合層自行累加的統計（economy 不訂閱這些事件）：startGame 時由存檔初始化
  const extraStats = { missionsDone: 0, missionsFailed: 0, shotsFired: 0, pedsKnockedOut: 0 };
  const resetExtraStats = (stats) => {
    extraStats.missionsDone = (stats && stats.missionsDone) || 0;
    extraStats.missionsFailed = (stats && stats.missionsFailed) || 0;
    extraStats.shotsFired = (stats && stats.shotsFired) || 0;
    extraStats.pedsKnockedOut = 0; // 只記本局 bat / bullet 擊倒（存檔值已在 economy 的 pedsKnockedOut 內）
  };
  resetExtraStats(initialLoad.data && initialLoad.data.stats);
  bus.on('mission:complete', () => {
    extraStats.missionsDone++;
  });
  bus.on('mission:fail', () => {
    extraStats.missionsFailed++;
  });
  bus.on('weapon:fire', (e) => {
    if (e && e.byPlayer) extraStats.shotsFired++;
  });
  // economy 的 loot 只認 punch：球棒 / 槍擊打倒路人比照拳擊掉 NT$10–40（reason 'loot'）並記 pedsKnockedOut
  bus.on('ped:knockdown', (e) => {
    if (!e || !e.byPlayer || (e.cause !== 'bat' && e.cause !== 'bullet')) return;
    extraStats.pedsKnockedOut++;
    economy.add(LOOT_MIN + Math.floor(Math.random() * (LOOT_MAX - LOOT_MIN + 1)), 'loot');
  });
  const currentStats = () => statsWithExtra(economy.stats, extraStats);
  // 存檔 schema v2（契約 §18）：weapons / missions / collect
  const autosave = createAutosave({
    store,
    intervalSec: AUTOSAVE_SEC,
    getState: () => {
      const p = state.mode === 'drive' && state.vehicle ? state.vehicle.pos : player.pos;
      const snap = economy.snapshot();
      return {
        version: SAVE_VERSION,
        money: snap.money,
        stats: statsWithExtra(snap.stats, extraStats),
        player: { x: p.x, z: p.z, yaw: player.yaw },
        world: { hour: dayNight.hour },
        weapons: weapons.serialize(),
        missions: missions.serialize(),
        collect: { checkins: checkins.serialize(), foods: food.serialize() },
      };
    },
  });
  let saveNotice = {
    recovered: '主存檔讀取失敗，已從備份還原',
    'corrupt-reset': '存檔損毀，已重設為新遊戲',
    incompatible: '存檔版本較新，無法讀取；開始新遊戲才會覆寫',
  }[initialLoad.status];

  // ---------- 上下車 ----------
  // 開始上車：面向車輛播 enter_car（動作被拒，例如正在出拳 / 受擊，就不上車）
  const beginEnter = (v) => {
    if (!player.anim.trigger('enter_car')) return false;
    player.yaw = Math.atan2(v.pos.x - player.pos.x, v.pos.z - player.pos.z);
    state.mode = 'entering';
    state.vehicle = v;
    player.locked = true;
    hud.setPrompt(null);
    return true;
  };

  // enter_car 播完（animator 已進 drive）：真正進入駕駛；機車看得到騎士，汽車把角色藏起來（坐在座位點）
  const enterVehicle = (v, carjack = false) => {
    state.mode = 'drive';
    state.vehicle = v;
    vehicles.drive(v, true);
    player.enterVehicle();
    player.locked = false;
    player.actor.untargetable = true;
    player.mesh.visible = !!v.spec.twoWheeler;
    // 搶車時角色停在 punch 之後的移動狀態：補播 enter_car，播完 animator 自動進 drive 坐姿
    if (player.anim.state !== 'drive') player.anim.trigger('enter_car');
    player.sitOn(v);
    hud.setPrompt(null);
    hud.setInteractPrompt?.(null);
    whud.setDriving(true);
    applyWeaponModel(); // 駕駛中隱藏武器模型
    bus.emit('vehicle:enter', { vehicle: v, carjack });
  };

  // 上車動作被打斷（受擊 / 倒地）：回步行
  const cancelEnter = () => {
    state.mode = 'walk';
    state.vehicle = null;
    player.locked = false;
  };

  // 下車：駕駛座側附近找無碰撞的站立點；找不到就留在車上並提示。force（機車倒地 / 回主選單）：找不到空位就站在車身位置
  const q = {};
  const exitVehicle = (force = false) => {
    const v = state.vehicle;
    if (!v) return false;
    if (!player.exitVehicle(v)) {
      if (!force) {
        hud.toast('車旁沒有空位，無法下車', 2);
        return false;
      }
      const y = terrain.querySurface(v.pos.x, v.pos.z, v.pos.y + 1, q).y;
      player.body.setEnabled(true);
      player.body.teleport(v.pos.x, y, v.pos.z);
      player.pos.set(v.pos.x, y, v.pos.z);
      player.syncMesh();
    }
    vehicles.drive(v, false);
    state.vehicle = null;
    state.mode = 'walk';
    player.actor.untargetable = false;
    player.mesh.visible = true;
    whud.setDriving(false);
    applyWeaponModel();
    bus.emit('vehicle:exit', { vehicle: v });
    return true;
  };

  // 玩家直接倒地（機車倒地摔下）：combat.knockdownActor（契約 §13；不發 knockdown 事件、hp 不變、播倒地動畫），
  // 之後由 combat.update 的 settleCheck → getup 流程起身
  const knockDownPlayer = () => {
    combat.knockdownActor(player.actor, { cause: 'fall' });
  };
  vehicles.onFall = (v) => {
    if (state.mode === 'drive' && state.vehicle === v) state.pendingFall = v;
  };
  const handleFall = () => {
    const v = state.pendingFall;
    state.pendingFall = null;
    if (!v || state.vehicle !== v || state.mode !== 'drive') return;
    exitVehicle(true);
    knockDownPlayer();
    hud.toast('機車倒地，你摔下車了', 2.5);
  };

  // ---------- 搶車 ----------
  const cj = createCarjack({ bus });
  const carjackAdapters = {
    releaseCar: (car) => traffic.releaseCar(car),
    adopt: (pose) => {
      const v = vehicles.adopt(pose);
      dmg.attach(v);
      adopted.add(v);
      return v;
    },
    spawnEjectedDriver: (o) => traffic.spawnEjectedDriver({ ...o, attacker: player.actor }),
    playPlayerAnim: (name) => player.anim.trigger(name),
    facePlayer: (yaw) => {
      player.yaw = yaw;
    },
    isPlayerDisabled: () => state.koTimer > 0 || combat.isDown(player.actor),
    onEnter: (v) => enterVehicle(v, true),
  };
  const beginCarjack = (candidate) => {
    if (!cj.begin({ candidate, adapters: carjackAdapters })) return false;
    // begin 內可能已在同一呼叫中結束（releaseCar 失敗）；進行中才鎖輸入
    if (cj.active) {
      state.mode = 'carjack';
      player.locked = true;
    }
    hud.setPrompt(null);
    return true;
  };
  const updateCarjack = (dt) => {
    const r = cj.update(dt);
    if (r === 'running') return;
    // done：onEnter 已切到 drive；cancelled（被打倒等）：回步行，已 adopt 的車留在原地當路邊車
    if (state.mode === 'carjack') {
      state.mode = 'walk';
      player.locked = false;
    }
  };

  // ---------- 對抗 / KO ----------
  // 行人倒地 → 契約事件 ped:knockdown（經濟：打倒掉錢、撞人統計）；玩家 hp 歸零 → player:ko（醫藥費）
  combat.on('knockdown', (e) => {
    const p = pedKnockdownPayload(e);
    if (p) bus.emit('ped:knockdown', p);
    if (e.target !== player.actor || player.actor.hp > 0) return;
    state.koTimer = PLAYER_KO_SEC;
    bus.emit('player:ko', {});
    missions.onPlayerKo();
    hud.toast('你被打倒了（醫藥費自動扣款）', PLAYER_KO_SEC);
  });
  const updateKnockout = (dt) => {
    if (state.koTimer <= 0) return;
    state.koTimer -= pw.simTimeFor(dt); // 模擬計時：本幀物理將推進的秒數（物理 step 前呼叫，累加器尚未變）
    if (state.koTimer > 0) return;
    player.recoverAfterKnockout(terrain);
    combat.revive(player.actor);
  };

  // ---------- 車輛耐久：contacts router → onImpact（以 body.owner 找 Vehicle，未 attach 的車流車由 dmg 忽略）----------
  const byPlayer = (v) => state.mode === 'drive' && state.vehicle === v;
  // 易碎貨物：玩家駕駛車輛的每次碰撞（≥ IMPACT_MIN = 4 m/s）都通知委託；不依賴 vehicle:crash（只在 ≥ 8 m/s 發出）
  // 兩個來源：contacts 的 relSpeed（先於耐久計算，不受 dmg 去重 / 未 attach 影響）與 vehicle:damaged 的 delta（反推等效速度）；
  // 同一次碰撞兩路都回報時，missions 以 IMPACT_MERGE_SEC 視窗只取最大值，不會重複累積
  const impactArg = { relSpeed: 0 };
  const reportImpact = (relSpeed) => {
    if (!(relSpeed >= MISSION_IMPACT_MIN)) return;
    impactArg.relSpeed = relSpeed;
    missions.onVehicleImpact(impactArg);
  };
  const impact = (entity, relSpeed, kind) => {
    const v = entity && entity.owner;
    if (!v) return;
    const mine = byPlayer(v);
    if (mine) reportImpact(relSpeed);
    dmg.onImpact(v, { relSpeed, kind, byPlayer: mine });
  };
  bus.on('vehicle:damaged', ({ vehicle, delta }) => {
    if (!byPlayer(vehicle) || !(delta > 0)) return;
    reportImpact(impactSpeedFromDamage(vehicle, delta));
  });
  router.onVehicleHitWorld(({ vehicle, relSpeed }) => impact(vehicle, relSpeed, 'static'));
  router.onVehicleHitVehicle(({ a, b, relSpeed }) => {
    impact(a, relSpeed, 'vehicle');
    impact(b, relSpeed, 'vehicle');
  });
  router.onVehicleHitPedestrian(({ vehicle, relSpeed }) => impact(vehicle, relSpeed, 'ped'));
  bus.on('vehicle:crash', ({ relSpeed }) => rig.shake(Math.min(1, relSpeed / CRASH_SHAKE_SPEED)));
  bus.on('vehicle:disabled', ({ vehicle }) => {
    if (byPlayer(vehicle)) hud.toast('車子熄火了', 2.5);
  });
  bus.on('vehicle:recovered', ({ driven }) => {
    if (driven) hud.toast('車輛已重置到道路上', 2.5);
  });

  // 回收：玩家已離開的搶來車（遠了）與熄火報廢車（遠了）
  let cleanupT = 0;
  const cleanupVehicles = (simDt, center) => {
    cleanupT += simDt;
    if (cleanupT < CLEANUP_SEC) return;
    cleanupT = 0;
    for (const v of vehicles.vehicles.slice()) {
      if (v.driven || v === state.vehicle || v === cj.vehicle) continue;
      const d = Math.hypot(v.pos.x - center.x, v.pos.z - center.z);
      const wreck = dmg.healthOf(v) === 0;
      if ((adopted.has(v) && d > ADOPTED_FAR) || (wreck && d > WRECK_FAR)) {
        dmg.detach(v);
        adopted.delete(v);
        vehicles.remove(v);
      }
    }
  };

  // ---------- 車流 / 行人外部狀態 ----------
  // 行人大腦：玩家是否在車內、移動中的玩家車（高速逼近會閃避）、玩家 Actor（被拖出的司機還手對象）
  const threat = { x: 0, z: 0, vx: 0, vz: 0 };
  const threats = [];
  const updateTrafficContext = () => {
    threats.length = 0;
    const v = state.mode === 'drive' ? state.vehicle : null;
    if (v) {
      const lv = v.body.body.linvel();
      threat.x = v.pos.x;
      threat.z = v.pos.z;
      threat.vx = lv.x;
      threat.vz = lv.z;
      threats.push(threat);
    }
    traffic.setContext({ playerInVehicle: !!v, vehicles: threats, player: player.actor, lockTarget: null });
  };

  // 車流停車判斷用：玩家（或玩家的車）與路邊車輛
  const blockers = [];
  const collectBlockers = () => {
    blockers.length = 0;
    if (state.started) blockers.push(state.mode === 'drive' ? state.vehicle.pos : player.pos);
    for (const v of vehicles.vehicles) blockers.push(v.pos);
    return blockers;
  };

  // 行人補生成的視野：鏡頭位置、水平朝向、水平視角半角（上一幀的鏡頭）
  const viewDir = new THREE.Vector3();
  const updateTrafficView = () => {
    camera.getWorldDirection(viewDir);
    const h = Math.hypot(viewDir.x, viewDir.z) || 1;
    const halfH = Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.aspect);
    traffic.setView(camera.position.x, camera.position.z, viewDir.x / h, viewDir.z / h, halfH);
  };

  // 物理一幀（順序見 core/loop.js createWorldStep）：step（內含固定子步；號誌相位 / 耐久去重時鐘在子步內推進）→ 號誌燈色 → 對抗 → 插值同步 → 耐久 / 煙 → 車輛遠距簡化（ACTIVE_RADIUS）
  const worldStep = createWorldStep({
    pw, lights, camera, combat, player, vehicles, traffic, dmg,
    activeRadius: ACTIVE_RADIUS,
    isDriving: () => state.mode === 'drive',
    prepareTraffic: () => {
      traffic.setBlockers(collectBlockers());
      updateTrafficContext();
      updateTrafficView();
    },
    advanceClock: (simDt) => {
      gameTime += simDt;
    },
    cleanup: cleanupVehicles,
  });
  const stepWorld = worldStep.step;

  // ---------- 畫質 / 設定 ----------
  const markMaterialsDirty = () => {
    scene.traverse((o) => {
      if (!o.material) return;
      for (const m of [].concat(o.material)) m.needsUpdate = true;
    });
  };
  // 畫質變更即時生效：人車數（traffic.setBudget，逐步增減）、DPR、陰影開關 / 貼圖邊長、視距、自適應解析度
  const applyQuality = () => {
    tier = qualityTier();
    budget = qualityBudget(tier);
    traffic.setBudget(budget);
    const wantShadow = budget.shadowMap > 0;
    if (wantShadow !== renderer.shadowMap.enabled) {
      renderer.shadowMap.enabled = wantShadow; // 關閉由 applyRendererQuality 處理；重新開啟要自己來
      markMaterialsDirty(); // 陰影開關改變 shader，材質需重新編譯
    }
    applyRendererQuality(renderer, 1, scene, tier);
    adapt = createAdaptiveResolution(renderer, tier);
    adaptive = tier === 'low';
    applyViewDist(budget.viewDist);
  };
  const applyUiScale = (k) => {
    const root = document.documentElement.style;
    root.setProperty('--tg-ui-scale', String(k));
    root.setProperty('--ui-scale', String(k));
    hud.setUiScale?.(k);
  };
  let showFps = settings.get('showFps');
  applyUiScale(settings.get('uiScale'));
  hud.setHintsEnabled?.(settings.get('showHints'));
  hud.setFps?.(null);
  settings.subscribe((key, value) => {
    if (key === 'lookSensMouse') input.setSensitivity({ mouse: value });
    else if (key === 'lookSensTouch') input.setSensitivity({ touch: value });
    else if (key === 'invertY') input.setInvertY(value);
    else if (key === 'quality') {
      setQualitySetting(value);
      applyQuality();
    } else if (key === 'uiScale') applyUiScale(value);
    else if (key === 'showFps') {
      showFps = !!value;
      if (!showFps) hud.setFps?.(null);
    } else if (key === 'showHints') hud.setHintsEnabled?.(!!value);
  });

  const onResize = () => {
    // rig 自行管理 camera.fov，這裡只改 aspect
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    // 保留自適應解析度目前的 renderScale（旋轉螢幕時 dpr 可能改變）
    renderer.setPixelRatio(pixelRatioFor(tier, window.devicePixelRatio, adapt.controller.scale));
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);

  // ---------- HUD 輔助 ----------
  let controlsMode = null;
  const updateControlsHint = (mode) => {
    if (mode === controlsMode) return;
    controlsMode = mode;
    hud.setControlsHint?.(controlsHintItems(help, mode));
  };
  // 每張提示卡本局只送一次（「只出現一次」的跨局記錄由 hud 內部的 localStorage 負責）
  const hintsSent = new Set();
  const showHint = (id) => {
    if (hintsSent.has(id) || !settings.get('showHints')) return;
    hintsSent.add(id);
    const text = hintText(help, id);
    if (text) hud.showHint?.(id, text);
  };
  let lastHp = null;
  const updateHealth = () => {
    const a = player.actor;
    if (a.hp === lastHp) return;
    lastHp = a.hp;
    hud.setHealth?.(a.hp, a.maxHp);
  };
  bus.on('player:money', ({ money, delta }) => hud.setMoney?.(money, delta));
  bus.on('toast', ({ text, seconds } = {}) => {
    if (text) hud.toast(text, seconds);
  });

  // 里程：步行 / 駕駛各自累計（單幀位移過大 = 傳送，不計）
  const lastPos = new THREE.Vector3();
  const trackDistance = (dt, driving, p) => {
    const d = Math.hypot(p.x - lastPos.x, p.z - lastPos.z);
    lastPos.copy(p);
    if (d < MAX_STEP_DIST) economy.addDistance(driving ? 'drive' : 'walk', d);
    economy.addPlayTime(dt);
  };

  let roadName = '';
  let roadT = ROAD_NAME_SEC;
  const updateRoadName = (dt, driving) => {
    if (!driving) {
      roadName = '';
      roadT = ROAD_NAME_SEC;
      return;
    }
    roadT += dt;
    if (roadT < ROAD_NAME_SEC) return;
    roadT = 0;
    const r = nearestNamedRoad(focus.x, focus.z, 30);
    roadName = r ? r.road.name : '';
  };

  // ---------- Phase 4 每幀輔助 ----------
  const missionCtx = { x: 0, z: 0, driving: false };
  let lastThrottle = 0;
  // 面板開 / 關的切換：開啟 → 停輸入、放開滑鼠鎖定（不觸發暫停選單）、駕駛中踩煞車；關閉 → 恢復輸入
  let panelWas = false;
  const syncPanels = () => {
    const open = state.started && !state.paused && panelOpen();
    if (open === panelWas) return open;
    panelWas = open;
    if (open) {
      input.enabled = false;
      releaseLock();
      hud.setPrompt(null);
      hud.setInteractPrompt?.(null);
      if (state.mode === 'drive' && state.vehicle) state.vehicle.setControls(driveControls({ x: 0, y: 0 }, true));
    } else if (state.started && !state.paused) {
      input.enabled = true;
      loop.resetClock();
    }
    return open;
  };
  // 大地圖 / 圖鑑開啟中的鍵盤：Esc 或同一顆開啟鍵（M / G）關閉（接單卡 / 結算面板的 E / Esc 由 missions UI 自己處理）
  const onPanelKey = (e) => {
    if (!state.started || state.paused || e.repeat) return;
    let closed = false;
    if (bigMap.isOpen() && (e.code === 'Escape' || e.code === 'KeyM')) {
      bigMap.close();
      closed = true;
    } else if (food.isOpen() && (e.code === 'Escape' || e.code === 'KeyG')) {
      food.close();
      closed = true;
    }
    if (!closed) return;
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener('keydown', onPanelKey, true);

  // 音效每幀狀態（重用）：聆聽點 = 鏡頭；rpm01 = |速度| / 最高速、skid01 = 側滑速度 / SKID_REF、nearJunction = 最近號誌路口距離
  const audioState = {
    x: 0, z: 0, yaw: 0, driving: false, speedKmh: 0, rpm01: 0, throttle: 0, skid01: 0, twoWheeler: false,
    walkSpeed: 0, grounded: true, nearJunction: null, paused: false,
  };
  let junctionT = JUNCTION_SCAN_SEC;
  let junctionDist = null;
  const nearestJunction = (dt, x, z) => {
    junctionT += dt;
    if (junctionT < JUNCTION_SCAN_SEC) return junctionDist;
    junctionT = 0;
    let best = Infinity;
    for (const sig of lights.signals) {
      const d = Math.hypot(sig.x - x, sig.z - z);
      if (d < best) best = d;
    }
    junctionDist = Number.isFinite(best) ? best : null;
    return junctionDist;
  };
  const updateAudio = (dt) => {
    const st = audioState;
    const driving = state.started && state.mode === 'drive' && !!state.vehicle;
    const v = driving ? state.vehicle : null;
    st.x = camera.position.x;
    st.z = camera.position.z;
    st.yaw = rig.yaw;
    st.paused = !state.started || state.paused || panelWas;
    st.driving = driving;
    st.speedKmh = v ? v.speedKmh() : 0;
    st.rpm01 = v ? Math.min(1, Math.abs(v.speed) / (v.spec.maxSpeed || 1)) : 0;
    st.throttle = v ? lastThrottle : 0;
    st.twoWheeler = !!(v && v.spec.twoWheeler);
    st.skid01 = 0;
    if (v && v.body && v.body.body) {
      const lv = v.body.body.linvel();
      const lateral = -lv.x * Math.cos(v.yaw) + lv.z * Math.sin(v.yaw); // 右方 = (−cos yaw, sin yaw)
      st.skid01 = Math.min(1, Math.abs(lateral) / SKID_REF);
    }
    st.walkSpeed = state.started && state.mode === 'walk' ? player.speed : 0;
    st.grounded = player.onGround;
    st.nearJunction = state.started ? nearestJunction(dt, focus.x, focus.z) : null;
    audio.update(dt, st);
  };

  // ---------- 更新 ----------
  // 順序：輸入快照 → 選單 / 快轉 → 角色意圖 / 車輛控制 → 物理 step → 上下車 / 搶車 → 鏡頭 / HUD
  const updateGame = (dt) => {
    // 全螢幕面板開啟中：世界與輸入暫停（面板自行處理 E / Esc；大地圖 / 圖鑑的 Esc 見 onPanelKey）
    if (syncPanels()) return;
    const snap = input.snapshot();
    if (snap.pressed.pause) {
      // 選單開啟會同步 emit game:pause { paused: true } → 本幀起世界停止更新
      menu.openPause();
      return;
    }
    if (snap.pressed.map) {
      // M：開大地圖（取代暫停選單的地圖頁；選單內地圖頁保留）
      bigMap.open();
      syncPanels();
      return;
    }
    if (input.wasPressed('KeyG')) {
      openGuide();
      syncPanels();
      return;
    }
    if (snap.pressed.timeSkip) {
      const fast = dayNight.toggleFast();
      hud.toast(fast ? '時間快轉中（再按一次恢復）' : '時間恢復正常', 2.5);
    }

    lastThrottle = 0;
    if (state.mode === 'drive') {
      const v = state.vehicle;
      v.setControls(driveControls(snap.move, snap.down.jump));
      lastThrottle = snap.move.y;
      if (input.actions.down('horn')) v.honk(); // 按住連續響（honk 自帶冷卻）
      aim.aiming = false;
    } else {
      // heavy 委託：步行速度 × missions.speedScale()（駕駛為 1）
      player.speedScale = missions.speedScale();
      player.update(dt, input, rig.yaw);
      // 攻擊 / 切換 / 裝填：weapons（空手時內部呼叫 player.punch()）
      if (state.mode === 'walk') handleWeaponInput(snap);
      else aim.aiming = false;
    }

    updateKnockout(dt);
    stepWorld(dt, state.mode === 'drive' ? state.vehicle.pos : player.pos);
    if (state.pendingFall) handleFall();
    weapons.update(dt, aim);
    updateWeaponPose(aim.aiming);

    let vehiclePrompt = null;
    let inter = null;
    if (state.mode === 'walk') {
      // F 優先序：翻覆車旁 = 扶起 > 可搶車流車 = 搶車 > 路邊車 = 上車
      const free = !player.controlLocked;
      const over = free ? vehicles.findOverturned(player.pos, ENTER_DIST) : null;
      const jack = free && !over ? cj.canStart(player.pos, traffic.carjackCandidates(player.pos.x, player.pos.z, CARJACK_SCAN)) : null;
      const near = free && !over && !jack ? vehicles.findNearby(player.pos, ENTER_DIST) : null;
      if (over) vehiclePrompt = `按 F 扶起${over.spec.label}`;
      else if (jack) vehiclePrompt = `按 F 搶車（${(VEHICLE_TYPES[jack.type] || {}).label || '車'}）`;
      else if (near) vehiclePrompt = `按 F 上車（${near.spec.label}）`;
      if (jack || near) showHint('enter');
      pickups.update(dt, player.pos); // 拾取物（目前無放置點，保留串接）
      inter = free ? nearestInteractable(player.pos, true) : null;
      setPrompts(vehiclePrompt, inter);
      if (snap.pressed.enterExit) {
        if (over) {
          over.upright();
          hud.toast(`已扶起${over.spec.label}`, 2);
        } else if (jack) beginCarjack(jack);
        else if (near) beginEnter(near);
      } else if (snap.pressed.interact && inter && typeof inter.act === 'function') inter.act();
      state.walkTime += dt;
      if (state.walkTime >= HINT_ATTACK_SEC) showHint('attack');
    } else if (state.mode === 'entering') {
      setPrompts(null, null);
      if (player.anim.state === 'drive') enterVehicle(state.vehicle);
      else if (player.anim.state !== 'enter_car') cancelEnter();
    } else if (state.mode === 'carjack') {
      setPrompts(null, null);
      updateCarjack(dt);
    } else {
      const v = state.vehicle;
      player.sitOn(v, dt);
      // 翻覆（汽車翻覆 / 機車倒地持續 1.5 s）→ F 扶起；耐久歸零熄火 → F 下車
      const flipped = v.isOverturned();
      if (flipped) vehiclePrompt = '翻車了！按 F 扶起';
      else if (dmg.healthOf(v) === 0) vehiclePrompt = '車子熄火了，按 F 下車';
      // 駕駛中也可接委託 / 打卡（E）；小吃與彈藥只在步行
      inter = nearestInteractable(v.pos, false);
      setPrompts(vehiclePrompt, inter);
      if (snap.pressed.enterExit) {
        if (flipped) v.upright();
        else exitVehicle();
      } else if (snap.pressed.interact && inter && typeof inter.act === 'function') inter.act();
    }

    const driving = state.mode === 'drive';
    const v = driving ? state.vehicle : null;
    focus.copy(driving ? v.pos : player.pos);
    trackDistance(dt, driving, focus);
    autosave.tick(dt);
    state.playTime += dt;
    if (state.playTime >= HINT_PAUSE_SEC) showHint('pause');
    dayNight.update(dt, focus);
    missionCtx.x = focus.x;
    missionCtx.z = focus.z;
    missionCtx.driving = driving;
    missions.update(dt, missionCtx);
    nav.update(dt, focus);
    food.update(dt, player.pos, camera);
    blood.update(dt, camera);
    // 後座：weapons 本幀累積的鏡頭 pitch / yaw 增量 → rig（衰減回原位）；瞄準中滾輪不縮放鏡頭距離
    const kick = weapons.recoilKick();
    if (kick.pitch || kick.yaw) rig.addRecoil(kick.pitch, kick.yaw);
    const aiming = !driving && aim.aiming;
    if (aiming) input.wheel = 0;
    rig.update(dt, input, focus, {
      driving,
      vehicleYaw: driving ? v.yaw : 0,
      speed: driving ? v.speed : 0,
      distScale: driving ? v.spec.camScale : 1,
      twoWheeler: driving && !!v.spec.twoWheeler,
      cycleView: snap.pressed.camera,
      lookBack: driving && snap.down.lookBack,
      clearRadius: driving ? Math.hypot(v.spec.length, v.spec.width) / 2 : 0,
      clearHeight: driving ? v.spec.height + 0.3 : 0,
      aim: aiming,
    });

    const loc = describeLocation(focus.x, focus.z);
    const placeId = loc.building ? loc.building.id : null;
    if (placeId !== state.placeId) {
      state.placeId = placeId;
      if (loc.building) hud.toast(`📍 ${loc.building.name}`, 4);
    }
    updateRoadName(dt, driving);
    updateControlsHint(driving ? 'drive' : 'walk');
    updateHealth();
    hud.update(dt, {
      x: focus.x,
      z: focus.z,
      yaw: driving ? v.yaw : player.yaw,
      driving,
      speedKmh: driving ? v.speedKmh() : 0,
      vehicleLabel: driving ? v.spec.label : '',
      roadName,
      money: economy.money,
      hp: player.actor.hp,
      hpMax: player.actor.maxHp,
      location: loc.text,
      time: dayNight.timeString(),
      fast: dayNight.fast,
      markers: collectMarkers(hudMarkers, true),
      route: nav.route(),
    });
    whudState.driving = driving;
    whudState.aimBlend = rig.aimBlend;
    whud.update(dt, whudState);
  };

  // 開始畫面：鏡頭緩慢環繞老虎城當作背景（世界照常更新）
  const tiger = tigerCity();
  const orbitCenter = new THREE.Vector3(tiger ? tiger.center.x : 0, 10, tiger ? tiger.center.z : 0);
  let orbitT = 0;
  let orbitY = 70;
  const updateAttract = (dt) => {
    orbitT += dt * 0.05;
    const ox = orbitCenter.x + Math.cos(orbitT) * 150;
    const oz = orbitCenter.z + Math.sin(orbitT) * 150;
    // 經過高樓時把鏡頭抬高，避免穿進建築
    const tall = buildingAt(ox, oz, 25);
    const wantY = Math.max(70, tall ? terrain.buildingBase(tall.id) + tall.height + 15 : 70);
    orbitY += (wantY - orbitY) * Math.min(1, dt * 1.5);
    camera.position.set(ox, orbitY, oz);
    camera.lookAt(orbitCenter);
    dayNight.update(dt, orbitCenter);
    stepWorld(dt, orbitCenter);
  };

  // ---------- 效能統計（FPS、__game.perf）----------
  // 各項各自一個環形緩衝（stepFrames 只在最後一幀渲染，render 的樣本數可能較少）
  const ring = () => ({ buf: new Float64Array(PERF_FRAMES), i: 0, n: 0 });
  const perfBuf = { render: ring(), physics: ring(), update: ring() };
  const pushSample = (r, v) => {
    r.buf[r.i] = v;
    r.i = (r.i + 1) % PERF_FRAMES;
    r.n = Math.min(PERF_FRAMES, r.n + 1);
  };
  const recordPerf = (renderMs, physicsMs, updateMs) => {
    if (renderMs !== null) pushSample(perfBuf.render, renderMs);
    pushSample(perfBuf.physics, physicsMs);
    pushSample(perfBuf.update, updateMs);
  };
  const fpsState = { acc: 0, frames: 0, fps: 0 };
  const updateFps = (dt) => {
    fpsState.acc += dt;
    fpsState.frames++;
    if (fpsState.acc < FPS_SAMPLE_SEC) return;
    fpsState.fps = fpsState.frames / fpsState.acc;
    fpsState.acc = 0;
    fpsState.frames = 0;
    if (showFps) hud.setFps?.(Math.round(fpsState.fps));
  };
  let drawCalls = 0;
  // 大地圖 / 圖鑑蓋滿畫面時不渲染 3D（契約 §19；畫布保留最後一幀）
  const render = () => {
    if (hide3D()) return;
    renderer.render(scene, camera);
    drawCalls = renderer.info.render.calls;
  };

  // 每幀排程（core/loop.js）：世界更新 → 音效 → 渲染 → 效能統計 → 輸入收尾
  const loop = createFrameLoop({
    world: worldStep,
    isPaused: () => state.paused,
    isStarted: () => state.started,
    updateGame,
    updateAttract,
    updateAudio,
    render,
    recordPerf,
    updateFps,
    endFrame: () => input.endFrame(),
    adaptTick: (dt) => {
      if (adaptive) adapt.tick(dt);
    },
  });

  // ---------- 選單流程 ----------
  const mapView = createMapView({ getPlayer: () => ({ x: focus.x, z: focus.z, yaw: state.mode === 'drive' && state.vehicle ? state.vehicle.yaw : player.yaw }) });
  const menu = createMenu({
    root: document.body,
    settings,
    bus,
    keymapHelp: KEYMAP_HELP,
    touchHelp: TOUCH_HELP,
    isTouch: touch,
    attribution: ATTRIBUTION,
    getStats: () => currentStats(),
    getMoney: () => economy.money,
    hasSave: () => store.hasSave(),
    mapView,
    onOpenGuide: () => openGuide(), // I4b：暫停選單「圖鑑」按鈕
  });

  // 桌機滑鼠鎖定：只能在使用者手勢（開始 / 繼續的 click / keydown）內要求
  const lockTarget = renderer.domElement;
  let hadLock = false;
  const requestLock = () => {
    if (touch || panelOpen() || document.pointerLockElement === lockTarget || !lockTarget.requestPointerLock) return;
    try {
      const p = lockTarget.requestPointerLock();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (err) {
      // 忽略：冷卻中 / 不支援時之後點畫面仍可鎖定
    }
  };
  const releaseLock = () => {
    hadLock = false;
    if (document.pointerLockElement && document.exitPointerLock) document.exitPointerLock();
  };
  // 遊戲中滑鼠鎖定被解除（Esc 被瀏覽器吃掉、切視窗）→ 開暫停選單
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement === lockTarget) {
      hadLock = true;
      return;
    }
    const lost = hadLock;
    hadLock = false;
    if (lost && state.started && !state.paused && !menu.isOpen() && !panelOpen()) menu.openPause();
  });

  // mobile.js 的「開始遊戲」手勢（全螢幕 → 螢幕不變暗、body.playing）掛在 #start-btn 的 click 上：
  // 開始畫面按鈕的 click 內同步轉發一次（程式觸發的 click 仍在同一使用者手勢內）
  const mobileStart = () => {
    const btn = document.getElementById('start-btn');
    if (btn) btn.click();
  };

  // 存檔位置的建築判定：主角膠囊（略縮）放在該點地面上，與建築碰撞體（colliderStats.handles.building）重疊才算在建築內；
  // 物理查詢失敗時退回「點在輪廓內」
  const buildingHandles = new Set((colliderStats.handles && colliderStats.handles.building || []).map((c) => c.handle));
  const saveProbe = new RAPIER.Capsule(player.capsuleHalfHeight, PLAYER_RADIUS * SAVE_POS_SHRINK);
  const saveProbeRot = { x: 0, y: 0, z: 0, w: 1 };
  const solidAt = (x, z) => {
    try {
      const y = terrain.querySurface(x, z, Infinity).y + player.capsuleHalfHeight + PLAYER_RADIUS + 0.05;
      let hit = false;
      pw.intersections({ x, y, z }, saveProbeRot, saveProbe, () => {
        hit = true;
        return false;
      }, { predicate: (c) => buildingHandles.has(c.handle) });
      return hit;
    } catch (err) {
      console.warn('[save] 存檔位置物理查詢失敗，改用建築輪廓判定', err);
      return !!buildingAt(x, z, 0);
    }
  };

  // 開新局 / 繼續：重設玩家（離開車輛、hp 回滿）並放到存檔位置（無效、在建築碰撞體內或水中 → 出生點）
  const placePlayer = (save) => {
    if (cj.active) cj.cancel();
    if (state.mode === 'drive') exitVehicle(true);
    state.mode = 'walk';
    state.vehicle = null;
    state.koTimer = 0;
    state.pendingFall = null;
    player.locked = false;
    player.actor.untargetable = false;
    player.mesh.visible = true;
    const p = save.player;
    const ok = validSavedPosition(p, { solidAt, buildingAt, inWater, inBounds });
    const x = ok ? p.x : spawn.x;
    const z = ok ? p.z : spawn.z;
    const yaw = ok && Number.isFinite(p.yaw) ? p.yaw : spawn.yaw;
    player.placeAt(x, z, yaw, terrain);
    if (combat.isDown(player.actor)) combat.revive(player.actor);
    player.actor.hp = player.actor.maxHp;
    rig.yaw = yaw;
    lastPos.copy(player.pos);
    focus.copy(player.pos);
  };

  // 存檔狀態提示（備份還原 / 損毀重設 / 版本較新）：開始畫面一出現就顯示在標題下（沿用選單副標題樣式，暫停時選單 CSS 會隱藏），開始遊戲後移除
  let startNoticeEl = null;
  const showStartNotice = (text) => {
    const brand = menu.el && menu.el.querySelector ? menu.el.querySelector('.tg-menu-brand') : null;
    if (!text || !brand) return;
    if (!startNoticeEl) {
      startNoticeEl = document.createElement('div');
      startNoticeEl.className = 'tg-menu-sub tg-save-notice';
      startNoticeEl.setAttribute('role', 'status');
      brand.appendChild(startNoticeEl);
    }
    startNoticeEl.textContent = `⚠ ${text}`;
  };
  const clearStartNotice = () => {
    if (startNoticeEl) startNoticeEl.remove();
    startNoticeEl = null;
  };

  // 關掉所有全螢幕面板（新局 / 回主選單）
  const closePanels = () => {
    if (bigMap.isOpen()) bigMap.close();
    if (food.isOpen()) food.close();
    if (missions.isModalOpen()) missions.ui.closePanel();
    panelWas = false;
  };

  const startGame = (continued) => {
    clearStartNotice();
    const { data } = store.load();
    // 版本較新的存檔（incompatible）只有玩家選「開始新遊戲」才清掉
    if (!continued && store.blocked) store.clear();
    const save = continued ? data : defaultSave();
    economy.dispose();
    economy = createEconomy({ bus, initial: save });
    resetExtraStats(save.stats);
    closePanels();
    placePlayer(save);
    // 存檔 v2 各模組還原（新局 = defaultSave 的預設值）；進行中的委託由 missions.restore 作廢
    weapons.restore(save.weapons);
    missions.restore(save.missions);
    checkins.restore(save.collect);
    food.restore(save.collect);
    nav.clear('map');
    blood.clear();
    dayNight.hour = save.world.hour;
    state.started = true;
    state.paused = false;
    state.walkTime = 0;
    state.playTime = 0;
    state.placeId = null;
    controlsMode = null;
    lastHp = null;
    input.enabled = true;
    hud.setVisible(true);
    whud.setVisible(true);
    whud.setDriving(false);
    hud.setMoney?.(economy.money, 0);
    mobileStart();
    setGameActive(true);
    requestLock();
    loop.resetClock();
    if (!continued) autosave.flush('newGame'); // 讓「繼續」立刻反映新局
    // 存檔狀態提示（備份還原 / 損毀重設 / 版本較新）優先於歡迎詞，只提示一次
    if (saveNotice) hud.toast(saveNotice, 5);
    else hud.toast(continued ? '歡迎回來！' : '歡迎來到臺中七期！你站在老虎城外、河南路三段這一側，附近路邊有車可以開。', 6);
    saveNotice = null;
    showHint('move');
  };

  const pauseGame = () => {
    if (!state.started || state.paused) return;
    state.paused = true;
    input.enabled = false;
    if (state.mode === 'drive' && state.vehicle) state.vehicle.setControls(driveControls({ x: 0, y: 0 }, true));
    autosave.flush('pause');
    setGameActive(false);
    releaseLock();
  };

  // 「繼續」的 click / keydown 內同步呼叫（menu 在同一手勢內 emit game:pause { paused: false }）
  const resumeGame = () => {
    if (!state.started || !state.paused) return;
    state.paused = false;
    input.enabled = true;
    setGameActive(true);
    requestLock();
    loop.resetClock();
  };

  const quitToMenu = () => {
    if (state.started) autosave.flush('quitToMenu');
    if (cj.active) cj.cancel();
    if (state.mode === 'drive') exitVehicle(true);
    state.mode = 'walk';
    player.locked = false;
    state.started = false;
    state.paused = false;
    input.enabled = false;
    closePanels();
    hud.setVisible(false);
    whud.setVisible(false);
    hud.setPrompt(null);
    hud.setInteractPrompt?.(null);
    setGameActive(false);
    releaseLock();
  };

  bus.on('game:start', ({ continued } = {}) => startGame(!!continued));
  bus.on('game:pause', ({ paused } = {}) => (paused ? pauseGame() : resumeGame()));
  bus.on('game:quitToMenu', () => quitToMenu());

  // 切背景：物理暫停（累加器歸零、插值對齊）並立即存檔；回前景時從目前時間重新計時
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      pw.pause();
      if (state.started) autosave.flush('hidden');
    } else {
      pw.resume();
      loop.resetClock();
    }
  });
  window.addEventListener('pagehide', () => {
    if (state.started) autosave.flush('pagehide');
  });

  loop.frame();
  // 載入完成：loading 只負責進度，之後交給選單的開始畫面
  loading.ready();
  input.enabled = false;
  hud.setVisible(false);
  whud.setVisible(false);
  menu.showStart({ canContinue: store.hasSave() });
  showStartNotice(saveNotice);

  // 除錯用（僅 dev，正式 build 由 Vite 以 import.meta.env.DEV = false 整段移除）：主控台 / 外部腳本用 window.__game 檢視狀態、直接設輸入；
  // rAF 不跑時（背景分頁）可 stepFrames(n, dt) 手動推幀（含渲染一次）再截圖
  if (import.meta.env.DEV) {
    // 背景分頁時物理是暫停的：手動推幀也要推進物理，所以暫時解除暫停、推完再恢復原狀
    const withPhysics = (fn) => {
      const paused = pw.paused;
      if (paused) pw.resume();
      try {
        fn();
      } finally {
        if (paused) pw.pause();
      }
    };
    const devUpdateGame = (dt) => withPhysics(() => updateGame(dt));
    const perf = () => ({
      frames: perfBuf.update.n,
      fps: fpsState.fps,
      render: perfStats(perfBuf.render.buf, perfBuf.render.n),
      physics: perfStats(perfBuf.physics.buf, perfBuf.physics.n),
      update: perfStats(perfBuf.update.buf, perfBuf.update.n), // 更新（不含物理步）
      peds: { total: traffic.citizens.length, skeleton: traffic.peds.length, impostor: traffic.impostors ? traffic.impostors.count : 0 },
      cars: traffic.cars.length,
      drawCalls,
      tier,
    });
    window.__game = {
      scene, camera, renderer, player, vehicles, traffic, combat, dayNight, state, input, hud, rig, terrain, qiuhonggu,
      beginEnter, enterVehicle, exitVehicle, world, buildings, spawn, parked, updateGame: devUpdateGame, updateAttract, render,
      physics: { RAPIER, world: pw, router, colliders: colliderStats, character, occluder },
      bus, settings, saveStore: store, autosave, menu, mapView, lights, damage: dmg, carjack: cj,
      // Phase 4：武器 / 音效 / 流血 / 委託 / 導航 / 大地圖 / 打卡 / 小吃（audio.stats()、blood.stats() 看音源數與血跡數）
      weapons, audio, blood, missions, nav, bigMap, checkins, food, pickups, whud,
      // 補手槍備彈（回實際加入數，上限 120）
      giveAmmo(n = 36) {
        return weapons.addAmmo(n);
      },
      // 最近的骨架行人 → { id, dist, hp, state }（沒有回 null）
      nearestPed() {
        let best = null;
        let bestD = Infinity;
        for (const p of traffic.peds) {
          const a = p.actor;
          if (!a) continue;
          const d = Math.hypot(a.pos.x - player.pos.x, a.pos.z - player.pos.z);
          if (d < bestD) {
            bestD = d;
            best = a;
          }
        }
        return best ? { id: best.id, dist: bestD, hp: best.hp, state: combat.stateOf(best) } : null;
      },
      // 傳送玩家到 (x, z)（駕駛中先下車；不計里程）
      teleport(x, z) {
        if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
        if (state.mode === 'drive') exitVehicle(true);
        player.placeAt(x, z, player.yaw, terrain);
        lastPos.copy(player.pos);
        focus.copy(player.pos);
        return true;
      },
      // 直接接單（測試用）：slug 必須是目前開放的委託；有 UI 時自動按「接下」；回傳是否已進行中
      startMission(slug) {
        const m = missions.catalog().find((c) => c.slug === slug);
        if (!m || missions.active() || missions.offers().indexOf(slug) < 0) return false;
        const it = missions.nearest(m.from);
        if (!it || it.id !== `mission:${slug}`) return false;
        it.act();
        const els = missions.ui.els;
        const btn = els && els.panel && els.panel.querySelector ? els.panel.querySelector('.ms-btn-primary') : null;
        if (btn && missions.ui.mode() === 'offer') btn.click();
        return !!missions.active();
      },
      get adapt() {
        return adapt;
      },
      get economy() {
        return economy;
      },
      get quality() {
        return { tier, budget: { ...budget }, setting: settings.get('quality') };
      },
      // 畫質即時切換（'auto' | 'low' | 'mid' | 'high' | 'ultra'）；回傳生效的 tier
      setQuality(id) {
        settings.set('quality', id);
        return tier;
      },
      // 手動推 n 幀（每幀 dt 秒，暫停中世界不動），推完渲染一次；回傳 perf()
      stepFrames(n = 1, dt = 1 / 60) {
        withPhysics(() => loop.runFrames(n, dt));
        return perf();
      },
      perf,
    };
  }
}

init().catch((err) => {
  console.error(err);
  loading.error(`載入失敗：${err && err.message ? err.message : err}（請確認瀏覽器支援 WebGL）`);
});
