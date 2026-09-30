// 臺中GTA prototype M1 進入點：建立場景、分步載入、主迴圈（世界依真實 OSM 資料生成）
// 地形一律取 terrain（唯一高度場）：querySurface 注入給 player / vehicle / traffic / camera；秋紅谷與下沉廣場細節網格由 qiuhonggu.js 產生
// 物理（Rapier，src/physics/**）：世界碰撞體取真實 terrain（heightfield / walkable / 湖面）與 buildings.js 的建築 colliders；
// 主迴圈 = 每幀讀輸入 → PhysicsWorld.step(dt)（固定 1/60 s 子步：子步前角色 move / 車輛 preStep / 車流 kinematic pose，
// 子步後 contacts router.drain 與停放 / wrecked / 倒地狀態）→ combat.update（命中窗 / 倒地 / 起身）→ 以插值結果同步網格 → 鏡頭 / HUD → 渲染
// 角色 / 車輛外觀：載入 public/models/characters 與 vehicles 的 manifest + glb（失敗時各自退回方塊人 / 程序化車）
// 對抗（combat.js）：玩家 Actor 在 player.js、行人 Actor + NpcBrain 在 traffic.js；攻擊鍵 KeyE / pointer lock 中滑鼠左鍵 / 觸控「揮拳」
// 上車：enter_car 動作播完（animator 自動進 drive）才真正進駕駛，期間鎖輸入；下車直接站起（首版）
import * as THREE from 'three';
import './style.css';
import osm from './data/osm-city.json';
import { TRIVIA } from './data/city.js';
import { LoadingScreen } from './loading.js';
import { Input } from './input.js';
import { PhysicsOccluder } from './collision.js';
import { buildWorld, describeLocation } from './world.js';
import { buildQiuhonggu } from './qiuhonggu.js';
import { buildBuildings } from './buildings.js';
import { loadLandmarkModels } from './landmarks/index.js';
import { computeSpawn, computeParkedVehicles, tigerCity } from './places.js';
import { buildingAt, getTerrain, surfaceFootways } from './citymodel.js';
import { closestOnSegment } from './geom.js';
import { loadCharacterModels } from './characters/index.js';
import { loadVehicleModels } from './vehicle-model.js';
import { CombatSystem } from './combat.js';
import { Player } from './player.js';
import { VehicleManager, driveControls } from './vehicle.js';
import { Traffic } from './traffic.js';
import { CameraRig } from './camera.js';
import { HUD } from './hud.js';
import { DayNight } from './daynight.js';
import { nextFrame } from './utils.js';
import { applyRendererQuality, createAdaptiveResolution, pixelRatioFor, qualityTier } from './mobile.js';
import { registerTouchButton } from './touch.js';
import { initPhysics, PhysicsWorld } from './physics/world.js';
import { buildWorldColliders, osmWithBuildings } from './physics/colliders.js';
import { GROUPS } from './physics/groups.js';
import { CharacterBody } from './physics/character.js';
import { createContactRouter } from './physics/contacts.js';
import { setActiveByDistance, ACTIVE_RADIUS } from './physics/npc-bodies.js';
import { upOf } from './physics/vehicle-body.js';

const MAX_FRAME_DT = 0.1; // 單幀時間上限（s）；物理另有子步上限（world.js DEFAULT_MAX_SUBSTEPS）
const FLIP_KEY = 'KeyR'; // 翻車自救（未被既有按鍵占用）
const UPSIDE_DOWN_Y = 0.3; // 車身 up.y 低於此值視為翻車，提示按 R
const ENTER_DIST = 2.6; // 上車距離（m，距車身圓）
const ATTACK_KEY = 'KeyE'; // 揮拳（未被既有按鍵占用）；pointer lock 中滑鼠左鍵同義
const PLAYER_KO_SEC = 3; // 玩家 hp 歸零倒地後多久在最近人行道起身（首版不做死亡懲罰）

// 觸控：駕駛時右上第二顆小鈕 = 翻正（top1 已是喇叭）；步行 sec3 = 揮拳（駕駛模式不顯示）
registerTouchButton({ id: 'tb-flip', label: '翻正', code: FLIP_KEY, mode: 'tap', slot: 'top2', showWhen: 'drive' });
registerTouchButton({ id: 'tb-punch', label: '揮拳', code: ATTACK_KEY, mode: 'tap', slot: 'sec3', showWhen: 'walk' });

// 最近的地面步道點（玩家被打倒後的起身點）；沒有步道資料回傳 null
function nearestFootway(x, z) {
  const seg = { x: 0, z: 0, d2: 0, t: 0 };
  let best = null;
  for (const r of surfaceFootways) {
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i];
      const b = r.pts[i + 1];
      closestOnSegment(x, z, a.x, a.z, b.x, b.z, seg);
      if (!best || seg.d2 < best.d2) best = { x: seg.x, z: seg.z, d2: seg.d2 };
    }
  }
  return best;
}

const loading = new LoadingScreen(TRIVIA);

async function init() {
  const total = 12;
  let step = 0;
  const progress = async (text) => {
    step++;
    loading.setProgress(step / total, text);
    await nextFrame();
  };

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
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.3, 2000);
  const dayNight = new DayNight(scene, 16.5);
  // 效能分級（桌機 high = 原本的 min(dpr, 2)）；需在光源建立後呼叫，低品質時才能調降陰影貼圖
  applyRendererQuality(renderer, 1, scene);
  const adapt = createAdaptiveResolution(renderer);
  const terrain = getTerrain();

  await progress('依 OSM 鋪設道路、公園與水域…');
  const world = buildWorld(scene, { anisotropy });
  const qiuhonggu = buildQiuhonggu(terrain, { footways: surfaceFootways });
  scene.add(qiuhonggu.group);

  await progress('載入地標模型…');
  const landmarks = await loadLandmarkModels((done, n, name) => {
    loading.setProgress((step + done / n) / total, `載入地標模型 ${done}/${n}：${name}`);
  });

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

  await progress('停放車輛…');
  const parked = computeParkedVehicles(spawn);
  const vehicles = new VehicleManager(scene, parked, terrain, physics);

  // 對抗計時用遊戲時鐘（切背景暫停時不前進）
  let gameTime = 0;
  const combat = new CombatSystem({ now: () => gameTime });

  await progress('放出行人與車流…');
  const traffic = new Traffic(scene, { center: spawn, terrain, physics, combat });

  await progress('準備角色與鏡頭…');
  const player = new Player(scene, spawn);
  const character = new CharacterBody(RAPIER, pw, { x: spawn.x, y: spawn.y, z: spawn.z });
  player.attachPhysics(character);
  player.attachCombat(combat);
  player.placeAt(spawn.x, spawn.z, spawn.yaw, terrain);
  const input = new Input(renderer.domElement);
  // 滑鼠左鍵揮拳：只在 pointer lock 中（未鎖定時的第一下點擊是鎖定滑鼠，input.js 處理）
  let mousePunch = false;
  renderer.domElement.addEventListener('mousedown', (e) => {
    if (input.enabled && e.button === 0 && document.pointerLockElement === renderer.domElement) mousePunch = true;
  });
  const occluder = new PhysicsOccluder(pw, colliderStats);
  const rig = new CameraRig(camera, occluder, terrain);
  rig.yaw = spawn.yaw;

  await progress('繪製小地圖…');
  const hud = new HUD();

  // ---------- 遊戲狀態 ----------
  const state = {
    started: false,
    mode: 'walk', // 'walk' | 'entering'（上車動作中，輸入鎖定）| 'drive'
    vehicle: null,
    placeId: null,
    koTimer: 0, // 玩家被打倒後的起身倒數（秒）
  };
  const focus = new THREE.Vector3();

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
  const enterVehicle = (v) => {
    state.mode = 'drive';
    state.vehicle = v;
    vehicles.drive(v, true);
    player.enterVehicle();
    player.locked = false;
    player.actor.untargetable = true;
    player.mesh.visible = !!v.spec.twoWheeler;
    player.sitOn(v);
    hud.setPrompt(null);
  };

  // 上車動作被打斷（受擊 / 倒地）：回步行
  const cancelEnter = () => {
    state.mode = 'walk';
    state.vehicle = null;
    player.locked = false;
  };

  // 下車：駕駛座側附近找無碰撞的站立點；找不到就留在車上並提示
  const exitVehicle = () => {
    const v = state.vehicle;
    if (!v) return false;
    if (!player.exitVehicle(v)) {
      hud.toast('車旁沒有空位，無法下車', 2);
      return false;
    }
    vehicles.drive(v, false);
    state.vehicle = null;
    state.mode = 'walk';
    player.actor.untargetable = false;
    player.mesh.visible = true;
    return true;
  };

  // 玩家 hp 歸零：播倒地，PLAYER_KO_SEC 後在最近人行道起身、hp 回滿
  combat.on('knockdown', ({ target }) => {
    if (target !== player.actor || player.actor.hp > 0) return;
    state.koTimer = PLAYER_KO_SEC;
    hud.toast('你被打倒了', PLAYER_KO_SEC);
  });
  const updateKnockout = (dt) => {
    if (state.koTimer <= 0) return;
    state.koTimer -= dt;
    if (state.koTimer > 0) return;
    const spot = nearestFootway(player.pos.x, player.pos.z);
    if (spot) player.respawnAt(spot.x, player.pos.y, spot.z);
    combat.revive(player.actor);
  };

  // 行人大腦的外部狀態：玩家是否在車內、移動中的玩家車（高速逼近會閃避）
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
    traffic.setContext({ playerInVehicle: !!v, vehicles: threats });
  };

  // 車流停車判斷用：玩家（或玩家的車）與路邊車輛
  const blockers = [];
  const collectBlockers = () => {
    blockers.length = 0;
    if (state.started) blockers.push(state.mode === 'drive' ? state.vehicle.pos : player.pos);
    for (const v of vehicles.vehicles) blockers.push(v.pos);
    return blockers;
  };

  // 物理一幀：step（內含固定子步）→ 插值同步 → 遠距簡化（半徑 ACTIVE_RADIUS）
  const entities = [];
  const stepWorld = (dt, center) => {
    traffic.setBlockers(collectBlockers());
    updateTrafficContext();
    pw.step(dt);
    gameTime += dt;
    combat.update(dt);
    if (state.mode !== 'drive') player.syncPhysics(dt);
    vehicles.sync();
    traffic.sync(dt, center);
    entities.length = 0;
    setActiveByDistance(traffic.bodies(vehicles.bodies(entities)), center.x, center.z, ACTIVE_RADIUS);
  };

  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    // 保留自適應解析度目前的 renderScale（旋轉螢幕時 dpr 可能改變）
    renderer.setPixelRatio(pixelRatioFor(qualityTier(), window.devicePixelRatio, adapt.controller.scale));
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);

  // ---------- 更新 ----------
  // 順序：輸入 → 角色意圖 / 車輛控制 → 物理 step → 同步網格 → 上下車 → 鏡頭 / HUD
  const updateGame = (dt) => {
    if (input.wasPressed('KeyH')) hud.toggleHelp();
    if (input.wasPressed('KeyN')) {
      const fast = dayNight.toggleFast();
      hud.toast(fast ? '時間快轉中（再按 N 恢復）' : '時間恢復正常', 2.5);
    }

    const punchPressed = input.wasPressed(ATTACK_KEY) || mousePunch;
    mousePunch = false;
    if (state.mode === 'drive') {
      const v = state.vehicle;
      v.setControls(driveControls(input.moveAxis(), input.down('Space')));
      if (input.wasPressed(FLIP_KEY)) v.flip();
    } else {
      player.update(dt, input, rig.yaw);
      if (state.mode === 'walk' && punchPressed) player.punch();
    }

    updateKnockout(dt);
    stepWorld(dt, state.mode === 'drive' ? state.vehicle.pos : player.pos);

    if (state.mode === 'walk') {
      const near = player.controlLocked ? null : vehicles.findNearby(player.pos, ENTER_DIST);
      hud.setPrompt(near ? `按 F 上車（${near.spec.label}）` : null);
      if (near && input.wasPressed('KeyF')) beginEnter(near);
    } else if (state.mode === 'entering') {
      if (player.anim.state === 'drive') enterVehicle(state.vehicle);
      else if (player.anim.state !== 'enter_car') cancelEnter();
    } else {
      const v = state.vehicle;
      player.sitOn(v, dt);
      const flipped = upOf(v.body.body.rotation()).y < UPSIDE_DOWN_Y;
      hud.setPrompt(flipped ? '翻車了！按 R 翻正' : null);
      if (input.wasPressed('KeyF')) exitVehicle();
    }

    const driving = state.mode === 'drive';
    const target = driving ? state.vehicle.pos : player.pos;
    focus.copy(target);
    dayNight.update(dt, focus);
    rig.update(dt, input, focus, {
      driving,
      vehicleYaw: driving ? state.vehicle.yaw : 0,
      speed: driving ? state.vehicle.speed : 0,
      distScale: driving ? state.vehicle.spec.camScale : 1,
    });

    const loc = describeLocation(focus.x, focus.z);
    const placeId = loc.building ? loc.building.id : null;
    if (placeId !== state.placeId) {
      state.placeId = placeId;
      if (loc.building) hud.toast(`📍 ${loc.building.name}`, 4);
    }
    hud.update(dt, {
      x: focus.x,
      z: focus.z,
      yaw: driving ? state.vehicle.yaw : player.yaw,
      driving,
      speedKmh: driving ? state.vehicle.speedKmh() : 0,
      location: loc.text,
      time: dayNight.timeString(),
      fast: dayNight.fast,
      markers: vehicles.vehicles.filter((v) => !v.driven).map((v) => v.pos),
    });
  };

  // 開始前：鏡頭緩慢環繞老虎城當作背景
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

  const render = () => renderer.render(scene, camera);
  // 自適應解析度只在低品質（手機）啟用；桌機不自動降解析度
  const adaptive = qualityTier() === 'low';
  let lastTime = performance.now();
  const frame = () => {
    requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, MAX_FRAME_DT);
    lastTime = now;
    if (adaptive) adapt.tick(dt);
    if (state.started) updateGame(dt);
    else updateAttract(dt);
    render();
    input.endFrame();
  };
  frame();

  // 切背景：物理暫停（累加器歸零、插值對齊），回前景時從目前時間重新計時
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') pw.pause();
    else {
      pw.resume();
      lastTime = performance.now();
    }
  });

  loading.ready(() => {
    state.started = true;
    input.enabled = true;
    hud.setVisible(true);
    hud.toast('歡迎來到臺中七期！你站在老虎城外、河南路三段這一側，附近路邊有車可以開。', 6);
  });

  // 除錯用（僅 dev，正式 build 由 Vite 以 import.meta.env.DEV = false 整段移除）：主控台 / 外部腳本用 window.__game 檢視狀態、直接設輸入；
  // rAF 不跑時（背景分頁）可手動 updateGame(dt) 推幀、render() 出圖再截圖
  if (import.meta.env.DEV) {
    // 背景分頁時物理是暫停的：手動推幀也要推進物理，所以暫時解除暫停、推完再恢復原狀
    const devUpdateGame = (dt) => {
      const paused = pw.paused;
      if (paused) pw.resume();
      updateGame(dt);
      if (paused) pw.pause();
    };
    window.__game = {
      scene, camera, renderer, player, vehicles, traffic, combat, dayNight, state, input, hud, rig, terrain, qiuhonggu, adapt,
      beginEnter, enterVehicle, exitVehicle, world, buildings, spawn, parked, updateGame: devUpdateGame, updateAttract, render,
      physics: { RAPIER, world: pw, router, colliders: colliderStats, character, occluder },
    };
  }
}

init().catch((err) => {
  console.error(err);
  loading.error(`載入失敗：${err && err.message ? err.message : err}（請確認瀏覽器支援 WebGL）`);
});
