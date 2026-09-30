// 無頭驗證：角色 glb 契約、換色材質共用、動畫狀態機、車輛載入器（缺檔退路 + 真實 manifest / glb）
// 用法：node tools/test/characters.mjs（任何一項失敗 → exit 1）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { loadCharacterModels, createCharacter, disposeCharacter, CharacterAnimator, RATE_MAX } from '../../src/characters/index.js';
import { loadVehicleModels, createVehicleModel } from '../../src/vehicle-model.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLIC = path.join(ROOT, 'public');
const DT = 1 / 60;

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
check('loadCharacterModels 載入 3 個變體', loaded.variants.length === 3 && !loaded.fallback, loaded.variants.join(','));
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
  check('hit 中不能 punch', anim.trigger('punch') === false);
  run(anim, 1, { speed: 0 });
  check('hit 結束回 idle', anim.state === 'idle', anim.state);

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
  const vm = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'models/vehicles/manifest.json'), 'utf8'));
  check('真實 vehicle manifest → 全部車型載入', real.size === vm.vehicles.length, `${[...real.keys()].join(',')}`);
}

console.warn = origWarn;
console.log(`\n通過 ${passes}、失敗 ${failures}；預期中的警告 ${warnings.length} 則`);
process.exit(failures ? 1 : 0);
