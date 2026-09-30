// 無頭驗證：角色 glb 契約、換色材質共用、動畫狀態機、主角 hero（role player 退路 / idle_pose / 身高換算）、
// 車輛載入器（缺檔退路 + 真實 manifest / glb；工作區缺車輛 glb 時該項 SKIP）
// 用法：node tools/test/characters.mjs（任何一項失敗 → exit 1）
import { register } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { loadCharacterModels, createCharacter, disposeCharacter, CharacterAnimator, RATE_MAX, playerVariant, variantHeight, repaintCharacter } from '../../src/characters/index.js';
import { WALK_RATE_MAX, RUN_ABOVE, IDLE_POSE, IDLE_POSE_AFTER } from '../../src/characters/animator.js';
import { CombatSystem, GETUP_MIN_DOWN } from '../../src/combat.js';

// player.js → citymodel.js 會 import osm-city.json：以 loader hook 讓 node 讀 JSON（player / camera 於主角段落才動態 import）
const JSON_HOOK = `
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function load(url, context, next) {
  if (url.endsWith('.json')) {
    return { format: 'module', shortCircuit: true, source: 'export default ' + readFileSync(fileURLToPath(url), 'utf8') + ';' };
  }
  return next(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(JSON_HOOK)}`, import.meta.url);
import { loadVehicleModels, createVehicleModel } from '../../src/vehicle-model.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLIC = path.join(ROOT, 'public');
const DT = 1 / 60;
// hero.glb 內嵌貼圖（face / pants）：GLTFLoader.loadImageSource 同步讀 self.URL，node 沒有 self → 整個 parse 失敗、
// 主角被判「未載入」。補 self 後貼圖改由 loader 的 catch 降級成無貼圖（node 無 Image 解碼），幾何 / 骨架 / clip 照常。
globalThis.self ??= globalThis;

let failures = 0;
let passes = 0;
function check(name, ok, detail = '') {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

// 以 fs 模擬 fetch：URL 相對 public/（Vite base './'）
function fsFetch(url) {
  const file = path.join(PUBLIC, url.replace(/^\.\//, ''));
  if (!fs.existsSync(file)) return Promise.resolve({ ok: false, status: 404, headers: { get: () => 'text/html' } });
  const buf = fs.readFileSync(file);
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: () => (file.endsWith('.json') ? 'application/json' : 'model/gltf-binary') },
    json: async () => JSON.parse(buf.toString('utf8')),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  });
}

// 靜音預期中的警告，另計次數
const warnings = [];
const origWarn = console.warn;
console.warn = (...a) => warnings.push(a.join(' '));

const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'models/characters/manifest.json'), 'utf8'));

// ---- 1. glb 契約 ----
{
  const buf = fs.readFileSync(path.join(PUBLIC, 'models/characters/pedestrian.glb'));
  const gltf = await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  const bones = [];
  const mats = new Set();
  gltf.scene.traverse((o) => {
    if (o.isBone) bones.push(o.name);
    if (o.isMesh) for (const m of [].concat(o.material)) mats.add(m.name);
  });
  check('骨頭數 = manifest.skeleton', bones.length === manifest.skeleton.length, `${bones.length} / ${manifest.skeleton.length}`);
  check('骨名全部對得上', manifest.skeleton.every((n) => bones.includes(n)));
  const names = gltf.animations.map((c) => c.name).sort();
  const want = manifest.clips.map((c) => c.name).sort();
  check('clip 數 = manifest', names.length === want.length, `${names.length} / ${want.length}`);
  check('clip 名稱一致', JSON.stringify(names) === JSON.stringify(want), names.join(','));
  let maxDiff = 0;
  for (const c of manifest.clips) {
    const clip = gltf.animations.find((a) => a.name === c.name);
    maxDiff = Math.max(maxDiff, clip ? Math.abs(clip.duration - c.duration) : Infinity);
  }
  check('clip 長度與 manifest 差 < 0.05 s', maxDiff < 0.05, `最大差 ${maxDiff.toFixed(4)} s`);
  const missingSlots = manifest.materialSlots.filter((s) => !mats.has(s));
  check('材質槽都找得到', missingSlots.length === 0, `材質 ${[...mats].join(',')}`);
  gltf.scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const h = box.max.y - box.min.y;
  check('模型高度 ≈ 1.75 ±0.1', Math.abs(h - 1.75) <= 0.1, `${h.toFixed(3)} m`);
  check('原點在腳底 min y ≈ 0 ±0.05', Math.abs(box.min.y) <= 0.05, `min y ${box.min.y.toFixed(3)}`);
}

// ---- 2. 載入器與換色 ----
const loaded = await loadCharacterModels('./models/characters/manifest.json', { fetch: fsFetch });
check(`loadCharacterModels 載入 manifest 全部 ${manifest.variants.length} 個變體`, loaded.variants.length === manifest.variants.length && !loaded.fallback, loaded.variants.join(','));
const colorsA = { skin: '#d6a27c', shirt: '#ff0000', pants: '#222222', hair: '#111111', shoes: '#eeeeee' };
const colorsB = { ...colorsA, shirt: '#0000ff' };
const matsOf = (ch) => {
  const m = new Map();
  ch.root.traverse((o) => {
    if (o.isMesh) for (const x of [].concat(o.material)) m.set(x.name, x);
  });
  return m;
};
{
  const a1 = createCharacter({ variant: 'pedestrian', colors: colorsA });
  const a2 = createCharacter({ variant: 'pedestrian', colors: colorsA });
  const b = createCharacter({ variant: 'pedestrian', colors: colorsB });
  const ma1 = matsOf(a1);
  const ma2 = matsOf(a2);
  const mb = matsOf(b);
  check('非 fallback、有 mixer 與 19 骨', !a1.fallback && a1.mixer && a1.bones.size === 19, `bones ${a1.bones.size}`);
  check('不同 shirt 色 → shirt 材質不共用', ma1.get('shirt') !== mb.get('shirt'));
  check('同色 → 全部材質共用', [...ma1.keys()].every((k) => ma1.get(k) === ma2.get(k)));
  check('不同 shirt 色但同 pants 色 → pants 共用', ma1.get('pants') === mb.get('pants'));
  check('shirt 顏色已換', ma1.get('shirt').color.getHexString() === 'ff0000', ma1.get('shirt').color.getHexString());
  let geoShared = true;
  let shadowOk = true;
  const geoA = [];
  a1.root.traverse((o) => o.isMesh && geoA.push(o.geometry));
  let i = 0;
  a2.root.traverse((o) => {
    if (!o.isMesh) return;
    if (o.geometry !== geoA[i++]) geoShared = false;
    if (!o.castShadow || o.receiveShadow) shadowOk = false;
  });
  check('同 variant 共用幾何', geoShared && i === geoA.length, `${i} 個 mesh`);
  check('castShadow 開、receiveShadow 關', shadowOk);
  const fb = createCharacter({ variant: 'no_such_variant' });
  check('缺變體 → 退回方塊人 fallback: true', fb.fallback === true && fb.root.isObject3D && fb.mixer === null);
  disposeCharacter(a2);
  check('disposeCharacter 清掉 mixer', a2.mixer === null);
}

// ---- 3. 狀態機（真實 clips + AnimationMixer）----
function run(anim, sec, ctx) {
  const n = Math.round(sec / DT);
  for (let i = 0; i < n; i++) anim.update(DT, ctx);
}
{
  const ch = createCharacter({ variant: 'pedestrian' });
  const anim = new CharacterAnimator(ch, manifest.clips);
  check('全部 clip 齊全（無替代）', anim.missing.length === 0, `missing ${anim.missing.length}`);
  run(anim, 0.5, { speed: 0 });
  check('速度 0 → idle', anim.state === 'idle', anim.state);
  run(anim, 0.5, { speed: 1.4 });
  const walkRate = anim._info.get('walk').action.getEffectiveTimeScale();
  check('速度 1.4 → walk、速率 1.0', anim.state === 'walk' && Math.abs(walkRate - 1) < 1e-6, `${anim.state} × ${walkRate.toFixed(3)}`);
  run(anim, 0.5, { speed: 5 });
  const runRate = anim._info.get('run').action.getEffectiveTimeScale();
  check('速度 5 → run、速率 1.0', anim.state === 'run' && Math.abs(runRate - 1) < 1e-6, `${anim.state} × ${runRate.toFixed(3)}`);
  run(anim, 0.3, { speed: 7.5 });
  check('速度 7.5 → run 速率 1.5', Math.abs(anim._info.get('run').action.getEffectiveTimeScale() - 1.5) < 1e-6);
  // 玩家步行 4.2 m/s 播 walk（walk 速率上限放寬到 2.2）、跑步 8.5 m/s 與行人逃跑 4.5 m/s 播 run
  run(anim, 0.5, { speed: 8.5 });
  const run85 = anim._info.get('run').action.getEffectiveTimeScale();
  check('速度 8.5（玩家跑步）→ run、速率 1.7', anim.state === 'run' && Math.abs(run85 - 1.7) < 1e-6, `${anim.state} × ${run85.toFixed(3)}`);
  run(anim, 0.5, { speed: 4.2 });
  const walk42 = anim._info.get('walk').action.getEffectiveTimeScale();
  check(`跑步減速到 4.2（玩家步行）→ 回 walk、速率夾到 ${WALK_RATE_MAX}`, anim.state === 'walk' && Math.abs(walk42 - WALK_RATE_MAX) < 1e-6, `${anim.state} × ${walk42.toFixed(3)}`);
  run(anim, 0.5, { speed: 3 });
  const walk3 = anim._info.get('walk').action.getEffectiveTimeScale();
  check('速度 3 → walk、速率 3/1.4（未達 2.2 不夾）', anim.state === 'walk' && Math.abs(walk3 - 3 / 1.4) < 1e-6, `${anim.state} × ${walk3.toFixed(3)}`);
  run(anim, 0.5, { speed: 4.5 });
  check(`速度 4.5（行人逃跑）→ run（門檻 ${RUN_ABOVE}）`, anim.state === 'run', anim.state);
  const idleW = anim._info.get('idle').action;
  check('交叉淡化後 idle 權重歸 0', idleW.getEffectiveWeight() === 0 || !idleW.isRunning());

  // punch 命中窗
  run(anim, 0.5, { speed: 0 });
  const events = [];
  let t = 0;
  anim.on('punchHitWindow', (p, clipTime) => events.push([p, t, clipTime]));
  const finished = [];
  anim.on('finished', (n) => finished.push(n));
  check('trigger punch 被接受', anim.trigger('punch') && anim.state === 'punch');
  const punchDur = ch.clips.get('punch').duration;
  const win = manifest.events.punch.hitWindow; // 命中窗以美術 manifest 為準（秒）
  check('命中窗取自 manifest events.punch.hitWindow', anim.hitWindow[0] === win[0] && anim.hitWindow[1] === win[1], `${anim.hitWindow.join('–')} s`);
  while (anim.state === 'punch' && t < 2) {
    t += DT; // 事件在本幀 update 內發出，時間點記為本幀結束時刻
    anim.update(DT, { speed: 2 }); // 一次性動作期間速度不影響狀態（2 m/s < walk 上限 1.4 × 1.8，結束後應回 walk）
  }
  const opens = events.filter((e) => e[0] === 'open');
  const closes = events.filter((e) => e[0] === 'close');
  check('hitWindow open / close 各恰好一次', opens.length === 1 && closes.length === 1, `open ${opens.length} close ${closes.length}`);
  // 邏輯時間點（clipTime）須恰在 manifest 命中窗邊界；實際發出的幀時間不早於邊界、最多晚一幀
  const tol = DT;
  for (const [label, ev, edge] of [['open', opens[0], win[0]], ['close', closes[0], win[1]]]) {
    const logical = ev ? ev[2] : NaN;
    const frame = ev ? ev[1] : NaN;
    const inWin = logical >= win[0] - 1e-9 && logical <= win[1] + 1e-9 && Math.abs(logical - edge) < 1e-9;
    check(`${label} 時間點在 hitWindow ${win[0]}–${win[1]} s`, inWin && frame >= edge - 1e-9 && frame <= edge + tol, `邏輯 ${logical.toFixed(3)} s、幀 ${frame.toFixed(3)} s`);
  }
  check('punch 結束發 finished 並回移動狀態', finished.includes('punch') && anim.state === 'walk', anim.state);

  // punch 中被 hit 打斷
  run(anim, 0.3, { speed: 0 });
  events.length = 0;
  anim.trigger('punch');
  run(anim, punchDur * 0.45, { speed: 0 }); // 命中窗開著時被打
  const openedBefore = anim.hitWindowOpen;
  const hitOk = anim.trigger('hit');
  check('punch 中 trigger hit 打斷成功', hitOk && anim.state === 'hit', anim.state);
  check('被打斷時補發 close', openedBefore && events.map((e) => e[0]).join() === 'open,close' && !anim.hitWindowOpen);
  check('hit 中不能 jump / enter_car', anim.trigger('jump') === false && anim.trigger('enter_car') === false && anim.state === 'hit');
  run(anim, 1, { speed: 0 });
  check('hit 結束回 idle', anim.state === 'idle', anim.state);
  // hit 可被 punch 打斷（受擊硬直由 combat HIT_STUN 管，硬直結束後出拳不必等受擊動作播完）
  anim.trigger('hit');
  run(anim, 0.2, { speed: 0 });
  check('hit 中 trigger punch 打斷 → punch', anim.trigger('punch') && anim.state === 'punch', anim.state);
  run(anim, 1, { speed: 0 });

  // knockdown 停住、getup 後回 idle
  anim.trigger('knockdown');
  check('knockdown 播放中 getup 不接受', anim.trigger('getup') === false);
  run(anim, 3, { speed: 4 });
  const kd = anim._info.get('knockdown').action;
  check('knockdown 播完停住', anim.state === 'knockdown' && kd.paused && Math.abs(kd.time - kd.getClip().duration) < 1e-6, `time ${kd.time.toFixed(3)}`);
  check('knockdown 中不能 hit / punch', anim.trigger('hit') === false && anim.trigger('punch') === false);
  check('trigger getup 接受', anim.trigger('getup') && anim.state === 'getup');
  run(anim, 2, { speed: 0 });
  check('getup 後回 idle', anim.state === 'idle', anim.state);

  // enter_car → drive → 下車
  check('idle 不能直接進 drive（無 trigger drive）', anim.trigger('drive') === false);
  anim.trigger('enter_car');
  run(anim, 2, { speed: 0, driving: true });
  check('enter_car 播完進 drive', anim.state === 'drive', anim.state);
  run(anim, 0.5, { speed: 0, driving: true });
  check('driving 期間停在 drive', anim.state === 'drive');
  anim.trigger('knockdown');
  check('knockdown 可打斷 drive', anim.state === 'knockdown');
  run(anim, 2, {});
  anim.trigger('getup');
  run(anim, 2, {});
  check('getup 後再回 idle', anim.state === 'idle', anim.state);
}

// ---- 倒地一律播動畫（Phase 3 C2）：真 animator + CombatSystem，拳擊 / 車撞皆 knockdown → getup，不走全身布娃娃 ----
{
  let clock = 0;
  const combat = new CombatSystem({ now: () => clock });
  const body = () => ({ impulses: 0, standUps: 0, knockdown() { this.impulses++; }, settleCheck: () => ({ settled: true, clearToStand: true }), standUp() { this.standUps++; } });
  const player = { id: 'kd-player', kind: 'player', pos: { x: 0, y: 0, z: 0 }, yaw: 0, hp: 100, maxHp: 100, faction: 'player', anim: { state: 'idle', trigger: () => true, on: () => () => {} }, body: body() };
  combat.register(player);
  const kds = [];
  combat.on('knockdown', (e) => kds.push(e));
  const results = [];
  for (const variant of ['pedestrian', 'pedestrian_f', 'pedestrian_heavy']) {
    for (const cause of ['punch', 'vehicle']) {
      const ch = createCharacter({ variant });
      const anim = new CharacterAnimator(ch, manifest.clips);
      const actor = { id: `kd-${variant}-${cause}`, kind: 'pedestrian', pos: { x: 0, y: 0, z: 0.8 }, yaw: Math.PI, hp: 100, maxHp: 100, faction: 'civilian', anim, body: body() };
      combat.register(actor);
      run(anim, 0.3, { speed: 1.4 }); // 走路中被打倒
      if (cause === 'vehicle') combat.onVehicleHit({ ped: actor, impulse: { x: 0, y: 50, z: 300 }, relSpeed: 7, vehicle: { pos: { x: 0, z: -2 } } });
      else {
        actor.hp = 20; // 一拳歸零 → knockdown（行人 dying；此處只驗動畫，倒地後即 revive）
        combat._applyPunch(combat.entries.get(player.id), combat.entries.get(actor.id), clock);
      }
      const kdAnim = anim.state === 'knockdown';
      if (actor.hp <= 0) combat.revive(actor);
      let upAt = null;
      let sawGetup = false;
      for (let i = 0; i < 60 * 6 && combat.stateOf(actor) !== 'normal'; i++) {
        clock += DT;
        anim.update(DT, { speed: 0 });
        combat.update(DT);
        if (anim.state === 'getup') sawGetup = true;
        if (upAt === null && combat.stateOf(actor) === 'getup') upAt = clock;
      }
      run(anim, 0.3, { speed: 0 });
      results.push({ variant, cause, ok: kdAnim && sawGetup && actor.body.impulses === 1 && actor.body.standUps === 1 && combat.stateOf(actor) === 'normal' && anim.state === 'idle' });
      combat.unregister(actor);
      disposeCharacter(ch);
    }
  }
  const bad = results.filter((r) => !r.ok).map((r) => `${r.variant}/${r.cause}`);
  check('三種體型 × 拳擊 / 車撞：knockdown 動畫 → getup 動畫 → 回 idle（剛體只受一次衝量、standUp 一次）', bad.length === 0, bad.join(',') || `${results.length} 組`);
  const causes = kds.map((e) => e.cause).join();
  check(`knockdown 事件 cause 依序為 punch / vehicle、拳擊帶 attacker（GETUP_MIN_DOWN ${GETUP_MIN_DOWN}s）`, causes === 'punch,vehicle,punch,vehicle,punch,vehicle' && kds.filter((e) => e.cause === 'punch').every((e) => e.attacker === player && e.byPlayer), causes);
}

// ---- 缺 clip 退回 ----
{
  const ch = createCharacter({ variant: 'pedestrian_f' });
  ch.clips.delete('run');
  ch.clips.delete('jump');
  ch.clips.delete('knockdown');
  const w0 = warnings.length;
  const anim = new CharacterAnimator(ch, manifest.clips);
  const used = Object.fromEntries(anim.missing.map((m) => [m.state, m.used]));
  check('缺 clip 記錄 3 筆', anim.missing.length === 3 && warnings.length - w0 === 3, JSON.stringify(used));
  check('run→walk、jump→idle、knockdown→hit', used.run === 'walk' && used.jump === 'idle' && used.knockdown === 'hit');
  run(anim, 0.5, { speed: 5 });
  const rate = anim._info.get('run').action.getEffectiveTimeScale();
  check(`run 用 walk clip 時以 walk 參考速度縮放（5/1.4 夾到 ${RATE_MAX}）`, anim.state === 'run' && Math.abs(rate - RATE_MAX) < 1e-6, rate.toFixed(3));
  check('替代 clip 各自獨立 action', anim._info.get('run').action !== anim._info.get('walk').action);
  anim.trigger('jump');
  run(anim, 2.5, { speed: 0 });
  check('替代的 jump 播一次後回 idle', anim.state === 'idle', anim.state);
  // 方塊人退路：無 mixer 仍能跑狀態與計時
  const fb = createCharacter({ variant: 'no_such_variant' });
  const fa = new CharacterAnimator(fb, manifest.clips);
  let opened = 0;
  fa.on('punchHitWindow', (p) => p === 'open' && opened++);
  run(fa, 0.2, { speed: 1.4 });
  const s1 = fa.state;
  fa.trigger('punch');
  run(fa, 1, { speed: 0 });
  check('方塊人退路：walk / punch 命中窗 / 回 idle', s1 === 'walk' && opened === 1 && fa.state === 'idle', `${s1} open ${opened} ${fa.state}`);
}

// ---- 3b. 主角 hero：manifest role player / 退路 / idle_pose / 身高換算 ----
{
  const { Player, capsuleHalfHeight, PLAYER_RADIUS } = await import('../../src/player.js');
  const { CameraRig } = await import('../../src/camera.js');
  const { SEAT_HIPS_HEIGHT } = await import('../../src/vehicle-model.js');
  const scene = new THREE.Scene();
  const spawn = { x: 0, z: 0, yaw: 0 };
  const capsuleTotal = (p) => 2 * (p.capsuleHalfHeight + PLAYER_RADIUS);
  // 鏡頭目標點：平地、無遮擋，預設俯角（無仰視抬高）時 target.y = 腳底 + 步行目標高度
  const eyeOf = (height) => {
    const rig = new CameraRig(new THREE.PerspectiveCamera(), { sweep: () => 1 }, { querySurface: (x, z, y, out) => Object.assign(out, { y: 0, waterY: null }) });
    rig.playerHeight = height;
    rig.update(DT, { consumeMouse: () => ({ dx: 0, dy: 0, wheel: 0 }) }, new THREE.Vector3(0, 0, 0), {});
    return rig._target.y;
  };
  // (a) 真實 manifest（目前沒有 role player）→ 玩家退回 pedestrian，只警告一次
  const hasHero = manifest.variants.some((v) => v.role === 'player');
  const w0 = warnings.length;
  const pv = playerVariant();
  playerVariant();
  const p0 = new Player(scene, spawn);
  const heroWarn = warnings.slice(w0).filter((w) => w.includes('玩家改用')).length;
  if (!hasHero) {
    check('manifest 無 hero → 玩家退回 pedestrian（console.warn 一次）', pv === 'pedestrian' && p0.character.variant === 'pedestrian' && !p0.character.fallback && heroWarn === 1, `${pv}、警告 ${heroWarn} 次`);
    check('無 height 欄位的身高 = 1.75；膠囊總高 ≈ 身高', p0.height === 1.75 && Math.abs(capsuleTotal(p0) - 1.75) < 1e-9 && p0.seatDrop === 0, `${p0.height} m / 膠囊 ${capsuleTotal(p0).toFixed(3)} m`);
  } else {
    console.log('SKIP  manifest 已有 role player：退回 pedestrian 的情境改由下方「hero 檔案缺失」涵蓋');
  }
  // (b) mock manifest：加一筆 hero（role player、height 1.86；檔案 = 真 hero.glb，沒有就借 pedestrian.glb）
  const realHero = fs.existsSync(path.join(PUBLIC, 'models/characters/hero.glb'));
  const mockManifest = (heroFile) => ({
    ...manifest,
    variants: [...manifest.variants.filter((v) => v.role !== 'player'), { id: 'hero', name: '主角', file: heroFile, height: 1.86, role: 'player' }],
  });
  const mockFetch = (heroFile, heroSrc) => (url) => {
    if (url.endsWith('manifest.json')) {
      const body = mockManifest(heroFile);
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body });
    }
    return fsFetch(url.endsWith(heroFile) && heroSrc ? url.replace(heroFile, heroSrc) : url);
  };
  const heroSrc = realHero ? 'hero.glb' : 'pedestrian.glb';
  await loadCharacterModels('./models/characters/manifest.json', { fetch: mockFetch('hero.glb', heroSrc), reload: true });
  const ph = new Player(scene, spawn);
  const heroMatsKept = (() => {
    let ok = true;
    ph.character.root.traverse((o) => {
      if (o.isMesh && o.material !== o.userData.srcMaterial) ok = false;
    });
    return ok;
  })();
  check('mock manifest 有 hero（role player）→ 玩家載入 hero、保留模型原材質（不換色）', playerVariant() === 'hero' && ph.character.variant === 'hero' && !ph.character.fallback && heroMatsKept);
  check('hero height 1.86 → 膠囊總高 ≈ 1.86（半徑 0.35）', ph.height === 1.86 && Math.abs(capsuleTotal(ph) - 1.86) < 1e-9 && PLAYER_RADIUS === 0.35 && Math.abs(capsuleHalfHeight(1.86) - 0.58) < 1e-9, `halfHeight ${ph.capsuleHalfHeight.toFixed(3)}`);
  const eye75 = eyeOf(1.75);
  const eye86 = eyeOf(ph.height);
  check('鏡頭目標點：1.86 比 1.75 高 0.11 m', Math.abs(eye86 - eye75 - 0.11) < 1e-9 && Math.abs(eye75 - 1.5) < 1e-9, `${eye75.toFixed(3)} → ${eye86.toFixed(3)} m`);
  check('駕駛座位：原點依身高比例多降 seatDrop', Math.abs(ph.seatDrop - SEAT_HIPS_HEIGHT * (1.86 / 1.75 - 1)) < 1e-12 && ph.seatDrop > 0, `${(ph.seatDrop * 100).toFixed(2)} cm`);
  // idle_pose：hero 帶 idle_pose 時 6 秒靜止後循環播放，一移動立即回移動狀態；行人不會拿到主角專屬 clip
  const hc = createCharacter({ variant: 'hero' });
  if (!hc.clips.has(IDLE_POSE)) {
    const pose = hc.clips.get('idle').clone();
    pose.name = IDLE_POSE;
    hc.clips.set(IDLE_POSE, pose);
  }
  const ha = new CharacterAnimator(hc, manifest.clips);
  run(ha, IDLE_POSE_AFTER - 0.2, { speed: 0 });
  const before = ha.state;
  run(ha, 0.4, { speed: 0.05 });
  const posed = ha.state;
  const poseLoop = ha._info.get(IDLE_POSE).action.loop === THREE.LoopRepeat;
  ha.update(DT, { speed: 1.2 });
  const moved = ha.state;
  run(ha, 1, { speed: 0 });
  run(ha, IDLE_POSE_AFTER + 0.1, { speed: 0 });
  const punchOk = ha.state === IDLE_POSE && ha.trigger('punch') && ha.state === 'punch';
  check(`hero 有 idle_pose：靜止 ${IDLE_POSE_AFTER} s 後播 idle_pose（循環）、移動立即退出、可直接出拳`, before === 'idle' && posed === IDLE_POSE && poseLoop && moved === 'walk' && punchOk, `${before} → ${posed} → ${moved}`);
  const pa = new CharacterAnimator(createCharacter({ variant: 'pedestrian' }), manifest.clips);
  run(pa, IDLE_POSE_AFTER + 1, { speed: 0 });
  check('沒有 idle_pose clip 的角色：靜止再久也停在 idle（略過）', !pa.hasIdlePose && pa.state === 'idle');
  if (realHero) {
    const heroClips = [...createCharacter({ variant: 'hero' }).clips.keys()];
    const ownIdle = hc.clips.get(IDLE_POSE);
    check('真 hero.glb：載入、clip 數 = 11（10 + idle_pose）', heroClips.length === 11 && heroClips.includes(IDLE_POSE) && !!ownIdle, heroClips.join(','));
    check('主角專屬 idle_pose 不外借給行人', !createCharacter({ variant: 'pedestrian' }).clips.has(IDLE_POSE));
  } else {
    console.log('SKIP  真 hero.glb 載入 / clip 數（工作區沒有 public/models/characters/hero.glb）');
  }
  // (c) hero 檔案缺失 → 退回 pedestrian、行人照常載入、只警告一次
  const w1 = warnings.length;
  const r = await loadCharacterModels('./models/characters/manifest.json', { fetch: mockFetch('no_such_hero.glb', null), reload: true });
  const pm = new Player(scene, spawn);
  playerVariant();
  const missWarn = warnings.slice(w1).filter((w) => w.includes('hero')).length;
  check('hero 檔案缺失 → 玩家退回 pedestrian、身高 1.75、行人 3 變體照常（warn 一次）', pm.character.variant === 'pedestrian' && !pm.character.fallback && pm.height === 1.75 && r.variants.length === 3 && missWarn === 1, `警告 ${missWarn} 次`);
  // 物件池換色：重用骨架換 shirt 色、材質仍走快取
  const rp = createCharacter({ variant: 'pedestrian', colors: { shirt: '#ff0000' } });
  repaintCharacter(rp, { shirt: '#00ff00' });
  const rs = matsOf(rp).get('shirt');
  const same = matsOf(createCharacter({ variant: 'pedestrian', colors: { shirt: '#00ff00' } })).get('shirt');
  check('repaintCharacter：重用骨架換色、同色共用快取材質', rs.color.getHexString() === '00ff00' && rs === same);
  check('variantHeight：未知 variant → 1.75', variantHeight('no_such') === 1.75);
  // 還原真實 manifest
  await loadCharacterModels('./models/characters/manifest.json', { fetch: fsFetch, reload: true });
}

// ---- 4. 車輛載入器：缺檔退路（先跑，模板尚未載入）→ 真實 manifest ----
{
  let threw = false;
  let table = null;
  let model;
  try {
    table = await loadVehicleModels('./models/vehicles/no_such_manifest.json', { fetch: fsFetch });
    model = createVehicleModel('sedan', '#ff0000');
  } catch {
    threw = true;
  }
  check('vehicle manifest 不存在 → 空表', !threw && table instanceof Map && table.size === 0, `size ${table && table.size}`);
  check('createVehicleModel 回 null 且不丟例外', !threw && model === null);
  const real = await loadVehicleModels('./models/vehicles/manifest.json', { fetch: fsFetch });
  const vmFile = path.join(PUBLIC, 'models/vehicles/manifest.json');
  const vm = fs.existsSync(vmFile) ? JSON.parse(fs.readFileSync(vmFile, 'utf8')) : { vehicles: [] };
  // 工作區（外包環境）沒有車輛 glb（甚至沒有 vehicles/manifest.json）：此項 SKIP 不計入（宿主有 glb 時照常檢查）
  if (vm.vehicles.length && vm.vehicles.every((e) => fs.existsSync(path.join(PUBLIC, 'models/vehicles', e.file)))) {
    check('真實 vehicle manifest → 全部車型載入', real.size === vm.vehicles.length, `${[...real.keys()].join(',')}`);
  } else {
    console.log('SKIP  真實 vehicle manifest → 全部車型載入（工作區缺 public/models/vehicles/*.glb）');
  }
}

console.warn = origWarn;
console.log(`\n通過 ${passes}、失敗 ${failures}；預期中的警告 ${warnings.length} 則`);
process.exit(failures ? 1 : 0);
