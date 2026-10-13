// 無頭驗證 src/wanted/adapters.js：最小假依賴（假 VehicleManager / 車輛運動、假角色、真 CombatSystem、假 AudioContext、假 traffic 生成點）
// 用法：node tools/test/p7-adapters.mjs [-v 列出每項斷言]（任一斷言失敗 exit 1）
import { createBus } from '../../src/core/events.js';
import { CombatSystem } from '../../src/combat.js';
import { createPolice } from '../../src/wanted/police.js';
import {
  createPoliceAdapters, POLICE_TYPE, LIGHTBAR_PERIOD, LIGHTBAR_DAY, LIGHTBAR_NIGHT, LIGHTBAR_DIM, SIREN_LOW, SIREN_HIGH, SIREN_HALF,
  SIREN_RANGE, SPAWN_TRIES, STUCK_SEC, REVERSE_SEC, DIRECT_DIST, SHOT_DAMAGE, HIT_MAX, HIT_MIN, UNIFORM_COLORS,
  hitChance, sirenGain, sirenFreq, lightbarPhase, segmentsIntersect, createFootprintIndex,
} from '../../src/wanted/adapters.js';
import { FIRE_MIN, FIRE_MAX } from '../../src/wanted/police.js';

let pass = 0;
let total = 0;
const fails = [];
const VERBOSE = process.argv.includes('-v');
function ok(cond, msg) {
  total++;
  if (VERBOSE) console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (cond) pass++;
  else fails.push(msg);
}

function mulberry(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 假依賴 ----------

function fakeMat(name) {
  return { name, emissiveIntensity: 1, disposed: false, clone() { return fakeMat(this.name); }, dispose() { this.disposed = true; } };
}
const TEMPLATE = { red: fakeMat('lightbar_red'), blue: fakeMat('lightbar_blue'), paint: fakeMat('paint') };

function fakeObj() {
  return {
    parent: null,
    position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    rotation: { order: 'XYZ', x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    removeFromParent() { if (this.parent) this.parent.remove(this); },
  };
}
function fakeScene() {
  return { children: [], add(o) { o.parent = this; this.children.push(o); }, remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); o.parent = null; } };
}

// 假車：controls → 簡化運動（油門 8 m/s²、轉向 1.5 rad/s，blockedAt 判定時不動）
function makeVehicles({ blockedAt = null } = {}) {
  const vm = {
    vehicles: [],
    removed: 0,
    adopt({ type, x, z, yaw = 0 }) {
      const meshes = [{ material: TEMPLATE.paint }, { material: [TEMPLATE.red, TEMPLATE.paint] }, { material: TEMPLATE.blue }];
      const v = {
        type, pos: { x, y: 0, z }, yaw, speed: 0, driven: false, ai: false,
        body: { kinematic: false },
        controls: { throttle: 0, steer: 0, brake: 0, handbrake: false },
        mesh: { traverse(cb) { meshes.forEach(cb); }, meshes },
        setControls(c) { this.controls = { ...c }; },
      };
      vm.vehicles.push(v);
      return v;
    },
    remove(v) {
      const i = vm.vehicles.indexOf(v);
      if (i < 0) return false;
      vm.vehicles.splice(i, 1);
      vm.removed++;
      return true;
    },
    step(dt) {
      for (const v of vm.vehicles) {
        if (v.driven) continue;
        const c = v.controls;
        if (c.brake > 0 || c.handbrake) v.speed = Math.sign(v.speed) * Math.max(0, Math.abs(v.speed) - 18 * dt);
        else v.speed = Math.max(-8, Math.min(42, v.speed + c.throttle * 8 * dt));
        v.yaw += c.steer * 1.5 * dt * Math.sign(v.speed) * Math.min(1, Math.abs(v.speed) / 3);
        const nx = v.pos.x + Math.sin(v.yaw) * v.speed * dt;
        const nz = v.pos.z + Math.cos(v.yaw) * v.speed * dt;
        if (blockedAt && blockedAt(nx, nz) && v.speed > 0) {
          v.speed = 0;
          continue;
        }
        v.pos.x = nx;
        v.pos.z = nz;
      }
    },
  };
  return vm;
}

function makeCharacters() {
  const ch = { created: [], disposed: 0 };
  class Anim {
    constructor() { this.listeners = new Map(); this.triggers = []; this.speed = 0; this.upper = []; }
    on(n, cb) { this.listeners.set(n, cb); return () => this.listeners.delete(n); }
    trigger(n) { this.triggers.push(n); return true; }
    update(dt, { speed = 0 } = {}) { this.speed = speed; }
    playUpper(n) { this.upper.push(n); return 0.3; }
  }
  return Object.assign(ch, {
    createCharacter({ variant, colors }) {
      const c = { root: fakeObj(), variant, colors };
      ch.created.push(c);
      return c;
    },
    disposeCharacter(c) { ch.disposed++; c.root.removeFromParent(); },
    CharacterAnimator: Anim,
    clips: [],
  });
}

// 車流路網生成點：沿 x 軸與 z 軸兩條直路每 10 m 一點
function makeTraffic() {
  const spots = [];
  for (let s = -600; s <= 600; s += 10) {
    spots.push({ x: s, z: 0, heading: Math.PI / 2 });
    spots.push({ x: 0, z: s, heading: 0 });
  }
  return {
    cars: [],
    calls: 0,
    spawnSpots(cx, cz, rMin, rMax, out = []) {
      this.calls++;
      out.length = 0;
      for (const p of spots) {
        const d = Math.hypot(p.x - cx, p.z - cz);
        if (d >= rMin && d <= rMax) out.push(p);
      }
      return out;
    },
  };
}

// 假 AudioContext：記錄頻率 / 增益
function makeAudio() {
  const ctx = {
    currentTime: 0,
    oscs: [],
    createOscillator() {
      const o = { type: '', started: false, stopped: false, frequency: { value: 0, setValueAtTime(v) { this.value = v; } }, connect() {}, disconnect() {}, start() { this.started = true; }, stop() { this.stopped = true; } };
      ctx.oscs.push(o);
      return o;
    },
    createBiquadFilter() { return { type: '', frequency: { value: 0 }, connect() {}, disconnect() {} }; },
    createGain() { return { gain: { value: 0, setTargetAtTime(v) { this.value = v; } }, connect() {}, disconnect() {} }; },
  };
  const master = { connect() {} };
  return { ctx, audio: { getOutput: () => ({ ctx, out: master }) } };
}

function makeEnv(opts = {}) {
  const bus = createBus();
  let clock = 0;
  const combat = new CombatSystem({ now: () => clock, bus });
  const scene = fakeScene();
  const vehicles = makeVehicles(opts);
  const characters = makeCharacters();
  const traffic = makeTraffic();
  const player = { x: 0, z: 0, actor: null };
  const dmgLog = { attach: 0, detach: 0, health: new Map() };
  const dmg = {
    attach(v) { dmgLog.attach++; dmgLog.health.set(v, 1); },
    detach(v) { dmgLog.detach++; dmgLog.health.delete(v); },
    healthOf(v) { return dmgLog.health.has(v) ? dmgLog.health.get(v) : null; },
  };
  const routeCalls = [];
  const findRoute = (a, b) => {
    routeCalls.push({ a, b });
    // L 形路線：先沿 x 再沿 z
    return { points: [{ x: a.x, z: a.z }, { x: b.x, z: a.z }, { x: b.x, z: b.z }] };
  };
  let night = false;
  const { ctx, audio } = makeAudio();
  const adapters = createPoliceAdapters({
    vehicles, dmg, traffic, findRoute, combat, characters, scene, bus, audio,
    settings: { get: (k) => (k === 'volumeSfx' ? 1 : undefined) },
    heightAt: () => 0,
    getPlayer: () => player,
    isNight: () => night,
    footprints: opts.footprints ?? null,
    rng: mulberry(opts.seed ?? 7),
    ...(opts.deps || {}),
  });
  const env = {
    bus, combat, scene, vehicles, characters, traffic, player, dmg, dmgLog, routeCalls, ctx, adapters,
    setNight(n) { night = n; },
    tick(dt, upd = {}) {
      clock += dt;
      ctx.currentTime += dt;
      vehicles.step(dt);
      combat.update(dt);
      adapters.update(dt, upd);
    },
  };
  return env;
}

// 一個玩家 Actor（真 combat）
function addPlayerActor(env) {
  const anim = { on: () => () => {}, trigger: () => true };
  const actor = { id: 'player', kind: 'player', faction: 'player', pos: { x: env.player.x, y: 0, z: env.player.z }, yaw: 0, hp: 100, maxHp: 100, anim, body: { knockdown() {}, settleCheck: () => ({ settled: true, clearToStand: true }), standUp() {} } };
  env.combat.register(actor);
  env.player.actor = actor;
  return actor;
}

const KEYS = ['findSpawnPoint', 'spawnCar', 'despawnCar', 'driveCar', 'spawnOfficer', 'despawnOfficer', 'moveOfficer', 'officerAim', 'canSee'];

// ── 1. 介面完整 ──
{
  const env = makeEnv();
  for (const k of KEYS) ok(typeof env.adapters[k] === 'function', `adapters.${k} 為函式`);
  ok(typeof env.adapters.update === 'function' && typeof env.adapters.dispose === 'function', 'adapters.update / dispose 為函式');
  const bare = createPoliceAdapters();
  let threw = false;
  try {
    ok(bare.spawnCar({ x: 0, z: 0 }) === null, '無依賴 spawnCar 回 null');
    ok(bare.spawnOfficer({ x: 0, z: 0 }) === null, '無依賴 spawnOfficer 回 null');
    ok(bare.findSpawnPoint(0, 0, 10, 20) === null, '無依賴 findSpawnPoint 回 null');
    ok(bare.canSee(0, 0, 10, 10) === true, '無物理 / footprints 時 canSee = true');
    bare.update(1 / 60);
    bare.dispose();
  } catch (e) {
    threw = e;
  }
  ok(!threw, `無依賴時不丟例外${threw ? '：' + threw.message : ''}`);
}

// ── 2. 警車 spawn / despawn 不殘留 ──
{
  const env = makeEnv();
  const car = env.adapters.spawnCar({ x: 10, z: 20, heading: 1 });
  ok(car && car.pos.x === 10 && car.pos.z === 20 && car.alive === true && car.speed === 0, 'spawnCar 回傳 car（pos / speed / alive）');
  const v = env.vehicles.vehicles[0];
  ok(v && v.type === POLICE_TYPE && v.ai === true && v.yaw === 1, '警車走 vehicles.adopt（type police、ai、heading）');
  ok(env.dmgLog.attach === 1, '警車登記耐久（dmg.attach）');
  ok(env.adapters.isPoliceVehicle(v), 'isPoliceVehicle(v) = true');
  env.adapters.despawnCar(car);
  env.adapters.despawnCar(car);
  ok(env.vehicles.vehicles.length === 0 && env.vehicles.removed === 1, 'despawnCar 移除車輛（重複呼叫只移除一次）');
  ok(env.dmgLog.detach === 1 && env.adapters.stats().cars === 0, 'despawnCar 解除耐久、內部名單清空');
  ok(!env.adapters.isPoliceVehicle(v) && car.alive === false, 'despawn 後 alive false、不再是警車');
  // 耐久歸零 → alive false；整合層先移除車輛 → alive false 且 despawn 不重複移除
  const c2 = env.adapters.spawnCar({ x: 0, z: 0 });
  env.dmgLog.health.set(c2.v, 0);
  ok(c2.alive === false, '耐久 0 → alive false');
  const c3 = env.adapters.spawnCar({ x: 50, z: 0 });
  env.vehicles.remove(c3.v);
  ok(c3.alive === false, '車輛被整合層移除 → alive false');
  const removed = env.vehicles.removed;
  env.adapters.despawnCar(c3);
  ok(env.vehicles.removed === removed, '已被移除的車 despawn 不重複 remove');
}

// ── 3. 警員 spawn / despawn 不殘留、制服、倒地 / 擊斃 ──
{
  const env = makeEnv();
  env.player.x = 5;
  env.player.z = 0;
  const o = env.adapters.spawnOfficer({ x: 0, z: 0, car: null });
  ok(o && o.pos.x === 0 && o.alive === true && o.down === false, 'spawnOfficer 回傳 officer（pos / alive / down）');
  const ch = env.characters.created[0];
  ok(ch.variant === 'pedestrian' && ch.colors.shirt === UNIFORM_COLORS.shirt && ch.colors.pants === UNIFORM_COLORS.pants, '警員用 pedestrian 變體、執行期深藍制服色');
  ok(env.scene.children.length === 1 && env.combat.entries.has(o.actor.id), '警員加入場景與 combat');
  ok(o.actor.faction === 'police' && o.actor.hp === 100, 'Actor faction police、hp 100');
  // 被手槍打 2 發 → 倒地（down），hp 未歸零 → 仍 alive
  env.combat.applyHit({ target: o.actor, damage: 20, weapon: 'pistol' });
  env.combat.applyHit({ target: o.actor, damage: 20, weapon: 'pistol' });
  env.tick(1 / 60);
  ok(o.down === true && o.alive === true, '被打倒 → officer.down = true、alive 仍 true');
  const o2 = env.adapters.spawnOfficer({ x: 3, z: 0 });
  env.combat.applyHit({ target: o2.actor, damage: 200, weapon: 'pistol' });
  env.tick(1 / 60);
  ok(o2.down === true && o2.alive === false, '被擊斃（子彈 hp 歸零）→ down 且 alive false');
  // 拳擊打到 0 只倒地（recoverOnKo）
  const o3 = env.adapters.spawnOfficer({ x: 6, z: 0 });
  env.combat.applyHit({ target: o3.actor, damage: 200, weapon: 'fist' });
  env.tick(1 / 60);
  ok(o3.down === true && o3.alive === true, '拳擊 KO 只倒地（alive 仍 true）');
  for (const x of [o, o2, o3]) env.adapters.despawnOfficer(x);
  env.adapters.despawnOfficer(o);
  ok(env.scene.children.length === 0 && env.combat.entries.size === 0, 'despawnOfficer 移出場景與 combat（重複呼叫安全）');
  ok(env.characters.disposed === 3 && env.adapters.stats().officers === 0, 'despawnOfficer 釋放角色、名單清空');
}

// ── 4. 警員移動 / 動畫 ──
{
  const env = makeEnv();
  const o = env.adapters.spawnOfficer({ x: 0, z: 0 });
  env.adapters.moveOfficer(o, { x: 10, z: 0, run: true });
  for (let i = 0; i < 60; i++) env.tick(1 / 60);
  ok(Math.abs(o.pos.x - 4.5) < 0.05 && o.anim.speed > 4, `run：1 秒跑約 4.5 m（${o.pos.x.toFixed(2)}），動畫速度跑步`);
  env.adapters.moveOfficer(o, { x: o.pos.x, z: o.pos.z, run: false });
  env.tick(1 / 60);
  ok(o.anim.speed === 0, '目標 = 自身位置 → 停（動畫速度 0）');
  ok(Math.abs(o.mesh.position.x - o.pos.x) < 1e-9 && Math.abs(o.yaw - Math.PI / 2) < 0.05, '網格跟位置、面向移動方向');
  // 撞牆滑動
  const env2 = makeEnv({ deps: { blocked: (x, z) => x > 2 } });
  const p = env2.adapters.spawnOfficer({ x: 0, z: 0 });
  env2.adapters.moveOfficer(p, { x: 10, z: 10, run: true });
  for (let i = 0; i < 120; i++) env2.tick(1 / 60);
  ok(p.pos.x <= 2 + 1e-9 && p.pos.z > 2, `blocked 時沿牆滑動（x ${p.pos.x.toFixed(2)}、z ${p.pos.z.toFixed(2)}）`);
}

// ── 5. canSee 遮擋 ──
{
  const square = (cx, cz, h) => [{ x: cx - h, z: cz - h }, { x: cx + h, z: cz - h }, { x: cx + h, z: cz + h }, { x: cx - h, z: cz + h }];
  const env = makeEnv({ footprints: [square(50, 0, 10), { pts: square(200, 200, 5) }] });
  const a = env.adapters;
  ok(a.canSee(0, 0, 100, 0) === false, 'footprint：穿過建築 → 看不見');
  ok(a.canSee(0, 20, 100, 20) === true, 'footprint：建築旁經過 → 看得見');
  ok(a.canSee(100, 0, 0, 0) === false, 'footprint：反方向同樣遮擋');
  ok(a.canSee(190, 200, 210, 200) === false && a.canSee(190, 190, 190, 210) === true, 'footprint：{ pts } 格式也能用');
  ok(segmentsIntersect(0, 0, 10, 10, 0, 10, 10, 0) && !segmentsIntersect(0, 0, 1, 1, 2, 2, 3, 5), 'segmentsIntersect 基本判斷');
  ok(createFootprintIndex([square(0, 0, 1), [{ x: 0, z: 0 }]]).count === 1, 'footprint 索引略過不合法多邊形');
  // 物理射線路徑：假 pw.castRay（x = 50 處有牆）
  const rays = [];
  const pw = {
    castRay(o, d, max, opt) {
      rays.push({ o, d, max, opt });
      if (d.x === 0) return null;
      const t = (50 - o.x) / d.x;
      return t > 0 && t < max ? { toi: t } : null;
    },
  };
  const env2 = makeEnv({ deps: { physics: { pw }, heightAt: () => 2 } });
  ok(env2.adapters.canSee(0, 0, 100, 0) === false && env2.adapters.canSee(0, 0, 40, 0) === true, '物理射線：牆後看不見、牆前看得見');
  ok(Math.abs(rays[0].o.y - 3.6) < 1e-9 && Math.abs(rays[0].d.y) < 1e-9 && rays[0].opt.groups !== undefined, '射線眼高 1.6 m、水平、只查 WORLD 群組');
}

// ── 6. findSpawnPoint 距離區間 / 視線外 / 嘗試次數 ──
{
  const square = (cx, cz, h) => [{ x: cx - h, z: cz - h }, { x: cx + h, z: cz - h }, { x: cx + h, z: cz + h }, { x: cx - h, z: cz + h }];
  // 玩家在 (0,0)：+x / −x / +z 方向 30–40 m 有牆擋住，只有 −z 方向看得見（12 次抽樣全落在看得見處的機率 ≈ 6e-8）
  const env = makeEnv({ footprints: [square(35, 0, 5), square(-35, 0, 5), square(0, 35, 5)], seed: 3 });
  let inRange = true;
  let hidden = true;
  let n = 0;
  for (let i = 0; i < 40; i++) {
    const p = env.adapters.findSpawnPoint(0, 0, 160, 260);
    if (!p) continue;
    n++;
    const d = Math.hypot(p.x, p.z);
    if (d < 160 || d > 260) inRange = false;
    if (env.adapters.canSee(0, 0, p.x, p.z)) hidden = false;
    if (!Number.isFinite(p.heading)) inRange = false;
  }
  ok(n > 0 && inRange, `findSpawnPoint 落在 160–260 m 且有 heading（${n}/40 次找到）`);
  ok(hidden, 'findSpawnPoint 回傳點皆在玩家視線外');
  // 嘗試次數：以計數 rng 確認每次 ≤ SPAWN_TRIES 次抽樣
  let draws = 0;
  const base = mulberry(9);
  const env2 = makeEnv({ deps: { rng: () => (draws++, base()) } });
  draws = 0;
  const p2 = env2.adapters.findSpawnPoint(0, 0, 120, 250);
  ok(draws <= SPAWN_TRIES, `每次 findSpawnPoint 抽樣 ≤ ${SPAWN_TRIES} 次（${draws}）`);
  ok(p2 && Math.hypot(p2.x, p2.z) >= 120 && Math.hypot(p2.x, p2.z) <= 250, '全部看得見時退回區間內候選（視線外優先）');
  ok(env2.adapters.findSpawnPoint(0, 0, 5000, 6000) === null, '區間內沒有路網點 → null');
  // 不生在既有車輛上
  const env3 = makeEnv({ seed: 5 });
  env3.traffic.spawnSpots = (cx, cz, a, b, out = []) => {
    out.length = 0;
    out.push({ x: 200, z: 0, heading: 0 });
    return out;
  };
  env3.adapters.spawnCar({ x: 202, z: 0 });
  ok(env3.adapters.findSpawnPoint(0, 0, 150, 250) === null, '生成點旁已有車輛 → 不使用');
}

// ── 7. 警示燈紅藍交替 ──
{
  const env = makeEnv();
  const c1 = env.adapters.spawnCar({ x: 0, z: 0 });
  const c2 = env.adapters.spawnCar({ x: 30, z: 0 });
  const red = c1.lightbar.red[0];
  const blue = c1.lightbar.blue[0];
  ok(red !== TEMPLATE.red && blue !== TEMPLATE.blue && c2.lightbar.red[0] !== red, '每台警車複製獨立的警示燈材質');
  ok(c1.v.mesh.meshes[1].material[0] === red && c1.v.mesh.meshes[1].material[1] === TEMPLATE.paint, '材質陣列只換警示燈、其他材質共用');
  const seq = [];
  for (let i = 0; i < 60; i++) {
    env.tick(1 / 60);
    seq.push(red.emissiveIntensity > blue.emissiveIntensity ? 'R' : 'B');
  }
  // 0.25 s 一換：每 15 幀切換
  const flips = seq.filter((s, i) => i > 0 && s !== seq[i - 1]).length;
  ok(flips === 3 || flips === 4, `1 秒內紅藍交替 ${flips} 次（週期 ${LIGHTBAR_PERIOD} s）`);
  ok(lightbarPhase(0.1) === 0 && lightbarPhase(0.3) === 1 && lightbarPhase(0.6) === 0, 'lightbarPhase 0.25 s 交替');
  ok(Math.max(red.emissiveIntensity, blue.emissiveIntensity) === LIGHTBAR_DAY && Math.min(red.emissiveIntensity, blue.emissiveIntensity) === LIGHTBAR_DIM, '白天亮 / 暗強度');
  env.setNight(true);
  env.tick(1 / 60);
  ok(Math.max(red.emissiveIntensity, blue.emissiveIntensity) === LIGHTBAR_NIGHT, '夜間更亮');
  ok(TEMPLATE.red.emissiveIntensity === 1 && TEMPLATE.blue.emissiveIntensity === 1, '模板材質未被改動');
  // 玩家搶車：alive false、交還一般車輛、警示燈仍閃
  c1.v.driven = true;
  env.tick(1 / 60);
  ok(c1.alive === false && c1.v.ai === false && env.adapters.isPoliceVehicle(c1.v), '玩家上車 → alive false、v.ai false（仍可辨識為警車）');
  env.adapters.despawnCar(c1);
  ok(env.vehicles.vehicles.includes(c1.v), '被搶的警車 despawn 不移除玩家的車');
  const before = red.emissiveIntensity;
  for (let i = 0; i < 16; i++) env.tick(1 / 60);
  ok(red.emissiveIntensity !== before, '被搶後警示燈仍閃');
  const ctl = { ...c1.v.controls };
  for (let i = 0; i < 10; i++) env.tick(1 / 60);
  ok(JSON.stringify(c1.v.controls) === JSON.stringify(ctl), '被搶後不再下駕駛指令');
  env.vehicles.remove(c1.v);
  env.tick(1 / 60);
  ok(env.adapters.stats().stolen === 0 && red.disposed, '被搶的車移除後清掉警示燈材質');
}

// ── 8. driveCar：pursue / ram / stop / 卡住倒車 ──
{
  const env = makeEnv();
  const car = env.adapters.spawnCar({ x: 0, z: 0, heading: 0 });
  // pursue 遠距離走路線（findRoute），近距離直追
  env.adapters.driveCar(car, { x: 200, z: 150, mode: 'pursue', maxSpeed: 20 });
  env.tick(1 / 60);
  ok(env.routeCalls.length === 1, '距目標 > 40 m 的 pursue 以 findRoute 找路');
  let reached = false;
  for (let i = 0; i < 60 * 40 && !reached; i++) {
    env.adapters.driveCar(car, { x: 200, z: 150, mode: 'pursue', maxSpeed: 20 });
    env.tick(1 / 60);
    if (Math.hypot(car.pos.x - 200, car.pos.z - 150) < 10) reached = true;
  }
  ok(reached, 'pursue 沿路線開到目標 10 m 內');
  const calls = env.routeCalls.length;
  env.adapters.driveCar(car, { x: car.pos.x + 30, z: car.pos.z, mode: 'pursue', maxSpeed: 20 });
  for (let i = 0; i < 30; i++) env.tick(1 / 60);
  ok(env.routeCalls.length === calls, `距目標 ≤ ${DIRECT_DIST} m 改直追（不再找路）`);
  // stop：煞車
  env.adapters.driveCar(car, { x: car.pos.x, z: car.pos.z, mode: 'stop', maxSpeed: 0 });
  for (let i = 0; i < 120; i++) env.tick(1 / 60);
  ok(car.v.controls.brake === 1 && car.v.controls.throttle === 0 && car.speed < 0.1, 'stop：煞停');
  // ram：全油門直追
  env.adapters.driveCar(car, { x: car.pos.x - 100, z: car.pos.z + 100, mode: 'ram', maxSpeed: 28 });
  env.tick(1 / 60);
  ok(car.v.controls.throttle === 1, 'ram：全油門');
  // 轉向符號：目標在左（yaw 0 時 +x 為左）→ steer > 0
  const env2 = makeEnv();
  const c = env2.adapters.spawnCar({ x: 0, z: 0, heading: 0 });
  env2.adapters.driveCar(c, { x: 20, z: 5, mode: 'pursue', maxSpeed: 10 });
  env2.tick(1 / 60);
  ok(c.v.controls.steer > 0, '目標在 +x（左）→ steer 為正（左轉）');
}

// 卡住 3 秒倒車：不同幀率結果一致
function stuckRun(fps) {
  const env = makeEnv({ blockedAt: (x, z) => z > 3 });
  const car = env.adapters.spawnCar({ x: 0, z: 0, heading: 0 });
  let reverseAt = null;
  let reverseEnd = null;
  const dt = 1 / fps;
  for (let i = 0; i < fps * 8; i++) {
    env.adapters.driveCar(car, { x: 0, z: 200, mode: 'pursue', maxSpeed: 20 });
    env.tick(dt);
    const t = (i + 1) * dt;
    if (reverseAt === null && car.v.controls.throttle < 0) reverseAt = t;
    if (reverseAt !== null && reverseEnd === null && car.v.controls.throttle > 0) reverseEnd = t;
  }
  return { reverseAt, reverseEnd };
}
{
  const a = stuckRun(60);
  const b = stuckRun(144);
  ok(a.reverseAt !== null && a.reverseAt >= STUCK_SEC && a.reverseAt < STUCK_SEC + 1, `卡住約 ${STUCK_SEC} 秒後倒車（60 Hz：${a.reverseAt?.toFixed(2)} s）`);
  ok(a.reverseEnd !== null && Math.abs(a.reverseEnd - a.reverseAt - REVERSE_SEC) < 0.1, `倒車約 ${REVERSE_SEC} 秒後恢復前進`);
  ok(b.reverseAt !== null && Math.abs(a.reverseAt - b.reverseAt) / a.reverseAt < 0.05, `60 / 144 Hz 倒車時刻誤差 < 5%（${a.reverseAt?.toFixed(3)} / ${b.reverseAt?.toFixed(3)}）`);
}

// ── 9. 警笛 ──
{
  ok(sirenFreq(0) === SIREN_LOW && sirenFreq(SIREN_HALF + 0.01) === SIREN_HIGH && sirenFreq(SIREN_HALF * 2 + 0.01) === SIREN_LOW, 'sirenFreq 650 / 900 Hz 交替');
  ok(sirenGain(5) === 1 && sirenGain(50) < sirenGain(20) && sirenGain(SIREN_RANGE) === 0 && sirenGain(SIREN_RANGE - 1) > 0 === true, 'sirenGain 距離衰減、超出範圍為 0');
  const env = makeEnv();
  const car = env.adapters.spawnCar({ x: 20, z: 0 });
  env.tick(1 / 60, { stars: 0, listener: { x: 0, z: 0 } });
  ok(env.ctx.oscs.length === 0, '0 星不播警笛');
  env.tick(1 / 60, { stars: 1, listener: { x: 0, z: 0 } });
  ok(env.ctx.oscs.length === 1 && env.ctx.oscs[0].started && env.adapters.stats().sirens === 1, '≥1 星：警車開始播警笛（WebAudio 振盪器）');
  const freqs = new Set();
  for (let i = 0; i < 90; i++) {
    env.tick(1 / 60, { stars: 1, listener: { x: 0, z: 0 } });
    freqs.add(env.ctx.oscs[0].frequency.value);
  }
  ok(freqs.has(SIREN_LOW) && freqs.has(SIREN_HIGH) && freqs.size === 2, '警笛在 650 / 900 Hz 間交替');
  ok(env.ctx.oscs[0].type === 'sawtooth', '振盪器鋸齒波（程序合成、不用音檔）');
  for (let i = 0; i < 3; i++) env.adapters.spawnCar({ x: 40 + i * 20, z: 0 });
  env.tick(1 / 60, { stars: 2, listener: { x: 0, z: 0 } });
  ok(env.ctx.oscs.length === 3, '同時發聲上限 3 台（取最近）');
  env.tick(1 / 60, { stars: 2, listener: { x: 0, z: 0 }, paused: true });
  ok(env.adapters.stats().sirens === 0, '暫停時警笛靜音');
  env.adapters.dispose();
  ok(env.ctx.oscs.every((o) => o.stopped), 'dispose 停止所有警笛振盪器');
  // 被搶的車不鳴笛
  const env2 = makeEnv();
  const c2 = env2.adapters.spawnCar({ x: 10, z: 0 });
  c2.v.driven = true;
  env2.tick(1 / 60, { stars: 3, listener: { x: 0, z: 0 } });
  ok(env2.adapters.stats().sirens === 0, '被搶的警車不鳴笛');
}

// ── 10. 開槍：命中率 30–70%、每發 15 傷害 ──
{
  ok(hitChance(FIRE_MIN) === HIT_MAX && hitChance(FIRE_MAX) === HIT_MIN && hitChance(2) === HIT_MAX && hitChance(60) === HIT_MIN, '命中率 FIRE_MIN 70%、FIRE_MAX 30%（區間外夾住）');
  ok(Math.abs(hitChance((FIRE_MIN + FIRE_MAX) / 2) - 0.5) < 1e-9, '命中率中間距離 50%');
  const rate = (d) => {
    const env = makeEnv({ seed: 11 });
    env.player.x = d;
    const o = env.adapters.spawnOfficer({ x: 0, z: 0 });
    let hits = 0;
    let shots = 0;
    env.bus.on('weapon:fire', (e) => {
      shots++;
      if (!e.miss) hits++;
    });
    for (let i = 0; i < 2000; i++) env.adapters.officerAim(o, { x: d, z: 0, firing: true });
    return hits / shots;
  };
  const r8 = rate(8);
  const r30 = rate(30);
  ok(Math.abs(r8 - 0.7) < 0.04 && Math.abs(r30 - 0.3) < 0.04, `實測命中率 8 m ${(r8 * 100).toFixed(1)}%、30 m ${(r30 * 100).toFixed(1)}%`);
  const env = makeEnv({ seed: 2 });
  env.player.x = 8;
  const actor = addPlayerActor(env);
  const o = env.adapters.spawnOfficer({ x: 0, z: 0 });
  const fires = [];
  env.bus.on('weapon:fire', (e) => fires.push(e));
  let n = 0;
  while (actor.hp === 100 && n < 50) {
    env.adapters.officerAim(o, { x: 8, z: 0, firing: true });
    n++;
  }
  ok(actor.hp === 100 - SHOT_DAMAGE, `命中玩家扣 ${SHOT_DAMAGE}（hp ${actor.hp}）`);
  const f = fires[fires.length - 1];
  ok(f && f.byPlayer === false && f.police === true && f.shooter === o && f.weapon === 'pistol', 'weapon:fire 帶 byPlayer false / police true（音效、行人聽槍聲）');
  ok(o.anim.upper.includes('pistol_fire'), '開槍播上半身 pistol_fire');
  const yaw0 = o.yaw;
  for (let i = 0; i < 30; i++) {
    env.adapters.officerAim(o, { x: 0, z: 8, firing: false });
    env.tick(1 / 60);
  }
  ok(Math.abs(yaw0 - Math.PI / 2) < 1e-6 && Math.abs(o.yaw) < 0.05, `瞄準時轉向目標（${yaw0.toFixed(2)} → ${o.yaw.toFixed(3)} rad）`);
  // 倒地警員不開槍
  env.combat.applyHit({ target: o.actor, damage: 20, weapon: 'pistol' });
  env.combat.applyHit({ target: o.actor, damage: 20, weapon: 'pistol' });
  env.tick(1 / 60);
  const nf = fires.length;
  env.adapters.officerAim(o, { x: 8, z: 0, firing: true });
  ok(fires.length === nf, '倒地警員不開槍');
}

// ── 11. 與 police.js 整合：跑完 dispose 不殘留 ──
{
  const env = makeEnv({ seed: 4 });
  addPlayerActor(env);
  let stars = 0;
  let state = 'clear';
  const wanted = { get stars() { return stars; }, get state() { return state; }, searchCircle: null };
  const police = createPolice({ bus: env.bus, wanted, adapters: env.adapters, rng: mulberry(1) });
  let threw = null;
  try {
    for (let i = 0; i < 60 * 3; i++) {
      police.update(1 / 60, { player: { x: 0, z: 0, inVehicle: false, speed: 0, down: false } });
      env.tick(1 / 60, { stars, listener: { x: 0, z: 0 } });
    }
    ok(police.cars.length === 1 && env.vehicles.vehicles.length === 1, '0 星：1 台巡邏警車（adapters 生成）');
    stars = 3;
    state = 'active';
    for (let i = 0; i < 60 * 40; i++) {
      police.update(1 / 60, { player: { x: 0, z: 0, inVehicle: false, speed: 0, down: false } });
      env.tick(1 / 60, { stars, listener: { x: 0, z: 0 } });
    }
    ok(police.cars.length === 4, `3 星：補到 4 台警車（${police.cars.length}）`);
    ok(police.officers.length > 0, `警車抵達後放警員下車（${police.officers.length} 名）`);
  } catch (e) {
    threw = e;
  }
  ok(!threw, `整合跑動無例外${threw ? '：' + threw.stack : ''}`);
  police.dispose();
  env.adapters.update(1 / 60);
  ok(env.vehicles.vehicles.length === 0, 'police.dispose 後無殘留警車');
  ok(env.scene.children.length === 0 && env.combat.entries.size === 1, 'police.dispose 後無殘留警員（場景 / combat 只剩玩家）');
  env.adapters.dispose();
  ok(env.adapters.stats().cars === 0 && env.adapters.stats().officers === 0, 'adapters.dispose 後名單清空');
}

// ── 12. 審查 🟡 修正 ──
// adapters.js:791 警車耐久歸 0 → 不再全油門：一次煞停、v.ai = false（交還一般停放 / 休眠）
{
  const env = makeEnv();
  const car = env.adapters.spawnCar({ x: 0, z: 0, heading: 0 });
  for (let i = 0; i < 30; i++) {
    env.adapters.driveCar(car, { x: 0, z: 30, mode: 'ram', maxSpeed: 28 });
    env.tick(1 / 60);
  }
  ok(car.v.controls.throttle === 1, '殘骸前置：ram 全油門');
  env.dmgLog.health.set(car.v, 0);
  for (let i = 0; i < 60; i++) env.tick(1 / 60);
  ok(car.alive === false && car.v.controls.throttle === 0 && car.v.controls.brake === 1 && car.v.ai === false, `耐久 0 的殘骸：油門 0、煞車、ai false（throttle ${car.v.controls.throttle}）`);
}
// adapters.js:587 缺 CharacterAnimator → spawnOfficer 回 null、不丟例外、網格不殘留場景
{
  const env = makeEnv();
  const chars = makeCharacters();
  delete chars.CharacterAnimator;
  const ad = createPoliceAdapters({ combat: env.combat, characters: chars, scene: env.scene, getPlayer: () => env.player, heightAt: () => 0 });
  let threw = null;
  let o;
  try {
    o = ad.spawnOfficer({ x: 0, z: 0 });
  } catch (e) {
    threw = e;
  }
  ok(!threw && o === null && env.scene.children.length === 0 && ad.stats().officers === 0, `缺 CharacterAnimator：spawnOfficer 回 null、不丟例外、場景無殘留${threw ? '：' + threw.message : ''}`);
}
// adapters.js:417 patrol 停在路網投影點 E（不開進原始目標）、標記 patrolArrived
{
  const E = { x: 100, z: 0 };
  const env = makeEnv({ deps: { findRoute: (a, b) => ({ points: [{ x: a.x, z: a.z }, { x: E.x, z: E.z }, { x: b.x, z: b.z }] }) } });
  const car = env.adapters.spawnCar({ x: 0, z: 0, heading: Math.PI / 2 });
  for (let i = 0; i < 60 * 30; i++) {
    env.adapters.driveCar(car, { x: 100, z: 60, mode: 'patrol', maxSpeed: 10 });
    env.tick(1 / 60);
  }
  ok(Math.hypot(car.pos.x - 100, car.pos.z - 60) > 30 && Math.hypot(car.pos.x - E.x, car.pos.z - E.z) < 15 && car.patrolArrived === true,
    `patrol 停在路網投影點（距 E ${Math.hypot(car.pos.x - E.x, car.pos.z - E.z).toFixed(1)} m、距原始目標 ${Math.hypot(car.pos.x - 100, car.pos.z - 60).toFixed(1)} m）`);
}
// main.js 手機開啟（update dt 0 + paused）→ 警車一律煞停，不續倒車 / 全油門
{
  const env = makeEnv({ blockedAt: (x, z) => z > 3 });
  const car = env.adapters.spawnCar({ x: 0, z: 0, heading: 0 });
  for (let i = 0; i < 60 * 4 && !(car.v.controls.throttle < 0); i++) {
    env.adapters.driveCar(car, { x: 0, z: 200, mode: 'pursue', maxSpeed: 20 });
    env.tick(1 / 60);
  }
  ok(car.v.controls.throttle < 0, '暫停前置：警車倒車脫困中');
  env.adapters.update(0, { paused: true });
  ok(car.v.controls.throttle === 0 && car.v.controls.brake === 1, `paused：倒車中的警車煞停（throttle ${car.v.controls.throttle}）`);
  env.adapters.driveCar(car, { x: 0, z: 200, mode: 'ram', maxSpeed: 28 });
  env.adapters.update(0, { paused: true });
  ok(car.v.controls.throttle === 0 && car.v.controls.brake === 1, 'paused：ram 指令也不給油');
}
// vehicle.js:712 findNearby：AI 警車車速 > 3 m/s 不可上車（src/vehicle.js 依賴 three，取出方法原始碼以假 this 執行）
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../src/vehicle.js', import.meta.url), 'utf8');
  const m = src.match(/\n {2}findNearby\(pos, maxDist = 2\.6\) \{([\s\S]*?)\n {2}\}\n/);
  const consts = (src.match(/^const AI_BOARD_MAX_SPEED = .*$/m) || [''])[0];
  const findNearby = m ? new Function('pos', 'maxDist = 2.6', `${consts}\n${m[1]}`) : null;
  const mk = (speed, ai) => ({ speed, ai, driven: false, fallen: false, isOverturned: () => false, circles: () => [{ x: 1, z: 0, r: 0.5 }] });
  const pick = (v) => (findNearby ? findNearby.call({ vehicles: [v] }, { x: 0, z: 0 }) : undefined);
  const fast = mk(10, true);
  const slow = mk(2, true);
  const parked = mk(10, false);
  ok(findNearby && pick(fast) === null && pick(slow) === slow && pick(parked) === parked, 'findNearby：AI 警車 10 m/s 不可上車、2 m/s 可；非 AI 車不受限');
}

console.log(`p7-adapters.mjs：通過 ${pass} / ${total}`);
for (const m of fails) console.log(`  ✗ ${m}`);
console.log(fails.length ? `FAIL ${fails.length}/${total}` : `PASS ${pass}/${total}`);
if (fails.length) process.exit(1);
