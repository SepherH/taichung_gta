// 臺中GTA prototype M1 進入點：建立場景、分步載入、主迴圈
import * as THREE from 'three';
import './style.css';
import { TRIVIA, SPAWN, PARKED_VEHICLES, LANDMARKS } from './data/city.js';
import { LoadingScreen } from './loading.js';
import { Input } from './input.js';
import { CollisionWorld } from './collision.js';
import { buildWorld, heightAt, describeLocation } from './world.js';
import { buildBuildings } from './buildings.js';
import { buildLandmarks } from './landmarks.js';
import { Player } from './player.js';
import { VehicleManager, exitPosition } from './vehicle.js';
import { Traffic } from './traffic.js';
import { CameraRig } from './camera.js';
import { HUD } from './hud.js';
import { DayNight } from './daynight.js';
import { nextFrame } from './utils.js';

const loading = new LoadingScreen(TRIVIA);

async function init() {
  const total = 9;
  let step = 0;
  const progress = async (text) => {
    step++;
    loading.setProgress(step / total, text);
    await nextFrame();
  };

  await progress('建立渲染器…');
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
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

  await progress('鋪設道路與人行道…');
  const world = buildWorld(scene, { anisotropy });

  await progress('生成七期大樓…');
  const buildings = buildBuildings(scene, world.cells, { anisotropy });

  await progress('建造地標：老虎城、秋紅谷、歌劇院…');
  const landmarks = buildLandmarks(scene);

  await progress('建立碰撞資料…');
  const collision = new CollisionWorld(25);
  for (const b of buildings.boxes) collision.addBox(b);
  for (const b of landmarks.boxes) collision.addBox(b);

  await progress('停放車輛…');
  const vehicles = new VehicleManager(scene, PARKED_VEHICLES, heightAt);

  await progress('放出行人與車流…');
  const traffic = new Traffic(scene, world.cells, heightAt);

  await progress('準備角色與鏡頭…');
  const player = new Player(scene, SPAWN);
  player.placeAt(SPAWN.x, SPAWN.z, SPAWN.yaw, heightAt);
  const input = new Input(renderer.domElement);
  const rig = new CameraRig(camera, collision, heightAt);
  rig.yaw = SPAWN.yaw;

  await progress('繪製小地圖…');
  const hud = new HUD({ footprints: buildings.footprints });

  // ---------- 遊戲狀態 ----------
  const state = {
    started: false,
    mode: 'walk', // 'walk' | 'drive'
    vehicle: null,
    landmarkId: null,
  };
  const focus = new THREE.Vector3();

  const enterVehicle = (v) => {
    state.mode = 'drive';
    state.vehicle = v;
    v.driven = true;
    player.mesh.visible = !!v.spec.twoWheeler;
    hud.setPrompt(null);
  };

  const exitVehicle = () => {
    const v = state.vehicle;
    if (!v) return;
    const p = exitPosition(v, collision);
    v.driven = false;
    state.vehicle = null;
    state.mode = 'walk';
    player.mesh.visible = true;
    player.placeAt(p.x, p.z, v.yaw, heightAt);
  };

  // 動態障礙物（車輛的碰撞圓）
  const obstacles = [];
  const collectObstacles = (except) => {
    obstacles.length = 0;
    vehicles.circlesExcept(except, obstacles);
    traffic.circles(obstacles);
    return obstacles;
  };
  const blockers = [];

  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);

  // ---------- 更新 ----------
  const updateGame = (dt) => {
    if (input.wasPressed('KeyH')) hud.toggleHelp();
    if (input.wasPressed('KeyN')) {
      const fast = dayNight.toggleFast();
      hud.toast(fast ? '時間快轉中（再按 N 恢復）' : '時間恢復正常', 2.5);
    }

    if (state.mode === 'walk') {
      player.update(dt, input, rig.yaw, collision, heightAt, collectObstacles(null));
      const near = vehicles.findNearby(player.pos, 2.6);
      hud.setPrompt(near ? `按 F 上車（${near.spec.label}）` : null);
      if (near && input.wasPressed('KeyF')) enterVehicle(near);
    } else {
      const v = state.vehicle;
      const ctrl = {
        throttle: input.down('KeyW') || input.down('ArrowUp'),
        reverse: input.down('KeyS') || input.down('ArrowDown'),
        left: input.down('KeyA') || input.down('ArrowLeft'),
        right: input.down('KeyD') || input.down('ArrowRight'),
        handbrake: input.down('Space'),
      };
      v.update(dt, ctrl, collision, heightAt, collectObstacles(v));
      if (v.spec.twoWheeler) player.sitOn(v);
      else player.pos.copy(v.pos);
      if (input.wasPressed('KeyF')) exitVehicle();
    }

    vehicles.updateIdle(dt, collision, heightAt, (v) => collectObstacles(v));

    // 車流：玩家（或玩家的車）與路邊車輛都會讓車流停下
    blockers.length = 0;
    blockers.push(state.vehicle ? state.vehicle.pos : player.pos);
    for (const v of vehicles.vehicles) blockers.push(v.pos);
    traffic.update(dt, blockers);

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
    const lmId = loc.landmark ? loc.landmark.id : null;
    if (lmId !== state.landmarkId) {
      state.landmarkId = lmId;
      if (loc.landmark) hud.toast(`📍 ${loc.landmark.name}｜${loc.landmark.info}`, 7);
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
  const tiger = LANDMARKS.find((l) => l.id === 'tiger');
  const orbitCenter = new THREE.Vector3((tiger.zone.x0 + tiger.zone.x1) / 2, 10, (tiger.zone.z0 + tiger.zone.z1) / 2);
  let orbitT = 0;
  const updateAttract = (dt) => {
    orbitT += dt * 0.05;
    camera.position.set(orbitCenter.x + Math.cos(orbitT) * 150, 70, orbitCenter.z + Math.sin(orbitT) * 150);
    camera.lookAt(orbitCenter);
    dayNight.update(dt, orbitCenter);
    traffic.update(dt, blockers);
  };

  let lastTime = performance.now();
  const frame = () => {
    requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    if (state.started) updateGame(dt);
    else updateAttract(dt);
    renderer.render(scene, camera);
    input.endFrame();
  };
  frame();

  loading.ready(() => {
    state.started = true;
    input.enabled = true;
    hud.setVisible(true);
    hud.toast('歡迎來到臺中七期！你站在老虎城門口，旁邊路邊有車可以開。', 6);
  });

  // 除錯用（僅 dev）：在主控台可以用 window.__game 檢視狀態、直接設輸入
  if (import.meta.env.DEV) {
    window.__game = { scene, camera, renderer, player, vehicles, traffic, collision, dayNight, state, input, hud, rig, enterVehicle, exitVehicle };
  }
}

init().catch((err) => {
  console.error(err);
  loading.error(`載入失敗：${err && err.message ? err.message : err}（請確認瀏覽器支援 WebGL）`);
});
