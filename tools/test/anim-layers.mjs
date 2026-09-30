#!/usr/bin/env node
// 動畫層無頭驗證（契約 §14，W3）：真角色 glb（GLTFLoader.parse ArrayBuffer）+ animator 武器 clip / 定向受擊 + src/character-animation.js
// 用法：node tools/test/anim-layers.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：上半身過濾（只含 boneGroups.upper 骨、快取共用、下半身仍由移動 clip 驅動）、權重淡入 0.12 s、
//   球棒命中窗（manifest events / 比例退路）、fire / weaponSwap 事件、被打斷補發 close、全身狀態封鎖、
//   定向受擊（hit_front / hit_back / 缺則 hit）、加法後座（真 pistol_fire）與程序化後座（缺 pistol_fire）、
//   缺 clip 退回（hold 不疊加 / equip 略過 / swing → punch）、插槽 fallback（weapon_socket → RightHand → 方塊人右臂）、
//   真武器 glb 掛載、manifest 缺檔（方塊人）只跑計時、行人同骨架可用、既有 punch 命中窗不受影響
import { register } from 'node:module';

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

// hero.glb 內嵌貼圖：GLTFLoader 讀 self.URL；node 沒有 self → 補上後貼圖降級、幾何 / 骨架 / clip 照常（同 characters.mjs）
globalThis.self ??= globalThis;

const fs = await import('node:fs');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');
const THREE = await import('three');
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
const { loadCharacterModels, createCharacter, CharacterAnimator, getCharacterManifest, characterBoneGroups, weaponSocketBone, DEFAULT_BONE_GROUPS, BAT_HIT_WINDOW } = await import('../../src/characters/index.js');
const { createWeaponLayer, upperBodyClip, attachWeapon, detachWeapon, weaponMount, FADE_SEC, UPPER_WEIGHT } = await import('../../src/character-animation.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLIC = path.join(ROOT, 'public');
const DT = 1 / 60;

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

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

// 預期中的警告 / 資訊（GLTFLoader 貼圖降級、缺 clip）靜音並計次
const warns = [];
const infos = [];
const origWarn = console.warn;
const origInfo = console.info;
console.warn = (...a) => warns.push(a.join(' '));
console.info = (...a) => infos.push(a.join(' '));

const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'models/characters/manifest.json'), 'utf8'));
const loaded = await loadCharacterModels('./models/characters/manifest.json', { fetch: fsFetch });
check('真 manifest + glb 載入（非 fallback）', !loaded.fallback && loaded.variants.length === manifest.variants.length, loaded.variants.join(','));

const run = (anim, layer, sec, ctx = {}) => {
  const n = Math.round(sec / DT);
  for (let i = 0; i < n; i++) {
    anim.update(DT, ctx);
    if (layer) layer.update(DT);
  }
};
const trackNodes = (clip) => clip.tracks.map((t) => THREE.PropertyBinding.parseTrackName(t.name).nodeName);

// ---- 1. 骨群組 / 插槽名稱（manifest 物件形式與字串形式都接受）----
{
  const g = characterBoneGroups();
  check('boneGroups 讀自 manifest（upper 13 骨含 weapon_socket）', g.upper.length === manifest.boneGroups.upper.length && g.upper.includes('weapon_socket'), `${g.upper.length} 骨`);
  check('boneGroups 缺 → 預設 upper（Spine…Hand）', characterBoneGroups({}) === DEFAULT_BONE_GROUPS && DEFAULT_BONE_GROUPS.upper.includes('Spine') && !DEFAULT_BONE_GROUPS.upper.includes('Hips'));
  check('weaponSocket 物件 / 字串 / 缺 都解析', weaponSocketBone() === 'weapon_socket' && weaponSocketBone({ weaponSocket: 'my_socket' }) === 'my_socket' && weaponSocketBone({}) === 'weapon_socket');
}

// ---- 2. animator：武器 clip 齊全、定向受擊 ----
{
  const ch = createCharacter({ variant: 'hero' });
  const anim = new CharacterAnimator(ch, manifest.clips);
  check('hero：10 個新 clip 全部找得到（missing 0）', anim.missing.length === 0 && ['bat_swing_a', 'pistol_fire', 'hit_back'].every((n) => anim.weaponClip(n).source === n), `missing ${anim.missing.length}`);
  run(anim, null, 0.3, { speed: 0 });
  anim.trigger('hit', { side: 'back' });
  const backClip = anim._cur.action && anim._cur.action.getClip().name;
  check("trigger('hit', { side: 'back' }) → 狀態 hit、播 hit_back", anim.state === 'hit' && anim.hitSide === 'back' && backClip === 'hit_back', `${anim.state} / ${backClip}`);
  run(anim, null, 0.1, { speed: 0 });
  anim.trigger('hit', { side: 'front' });
  const frontClip = anim._cur.action.getClip().name;
  check('hit 中再被打（front）→ 重播 hit_front', anim.state === 'hit' && anim.hitSide === 'front' && frontClip === 'hit_front', frontClip);
  run(anim, null, 1, { speed: 0 });
  check('定向受擊播完回 idle', anim.state === 'idle', anim.state);
  anim.trigger('hit');
  check("trigger('hit') 無 side → 一般 hit clip", anim.state === 'hit' && anim.hitSide === null && anim._cur.action.getClip().name === 'hit');
  run(anim, null, 1, { speed: 0 });
  anim.trigger('hit', { side: 'sideways' });
  check('side 非法值 → 一般 hit', anim._cur.action.getClip().name === 'hit' && anim.hitSide === null);
  run(anim, null, 1, { speed: 0 });

  // 缺 hit_back / 武器 clip → 退回規則
  const c2 = createCharacter({ variant: 'pedestrian' });
  for (const n of ['hit_back', 'bat_swing_a', 'pistol_fire', 'bat_hold', 'weapon_equip', 'pistol_reload']) c2.clips.delete(n);
  const i0 = infos.length;
  const a2 = new CharacterAnimator(c2, manifest.clips);
  const used = Object.fromEntries(a2.missing.map((m) => [m.state, m.used]));
  check('缺 6 個新 clip → missing 6 筆、退回規則（swing / fire → punch、hold / equip / reload → 無、hit_back → hit）',
    a2.missing.length === 6 && used.hit_back === 'hit' && used.bat_swing_a === 'punch' && used.pistol_fire === 'punch' && used.bat_hold === null && used.weapon_equip === null && used.pistol_reload === null,
    JSON.stringify(used));
  const c3 = createCharacter({ variant: 'pedestrian' });
  c3.clips.delete('hit_front');
  new CharacterAnimator(c3, manifest.clips);
  check('缺武器 clip 只 console.info 一次（不 warn）', infos.length - i0 === 1 && !warns.some((w) => w.includes('bat_swing')), `info ${infos.length - i0}`);
  a2.trigger('hit', { side: 'back' });
  check('缺 hit_back → 播一般 hit', a2.state === 'hit' && a2._cur.action.getClip().name === 'hit');
  a2.trigger('hit', { side: 'front' });
  check('hit_front 仍在 → 播 hit_front', a2._cur.action.getClip().name === 'hit_front');
}

// ---- 3. 上半身過濾、快取、疊加權重 ----
const upperSet = new Set(manifest.boneGroups.upper);
{
  const ch = createCharacter({ variant: 'hero' });
  const anim = new CharacterAnimator(ch, manifest.clips);
  const layer = createWeaponLayer(anim, { boneGroups: manifest.boneGroups });
  const clipOf = (n) => layer.slots.get(n).action.getClip();
  const names = ['bat_hold', 'pistol_hold', 'pistol_aim', 'weapon_equip', 'bat_swing_a', 'bat_swing_b', 'pistol_reload'];
  const bad = names.filter((n) => !trackNodes(clipOf(n)).every((b) => upperSet.has(b)));
  const nodesHold = new Set(trackNodes(clipOf('bat_hold')));
  check('過濾後 7 個上半身 clip 的 track 只含 upper 骨', bad.length === 0 && nodesHold.size === upperSet.size && !nodesHold.has('Hips') && !nodesHold.has('LeftFoot'), bad.join(',') || `${nodesHold.size} 骨 / ${clipOf('bat_hold').tracks.length} tracks`);
  const src = ch.clips.get('bat_hold');
  check('過濾建立副本（原 clip 軌道數不變）', src.tracks.length > clipOf('bat_hold').tracks.length && src.tracks.some((t) => t.name.startsWith('Hips.')));
  const again = upperBodyClip(src, manifest.boneGroups.upper);
  const ch2 = createCharacter({ variant: 'hero' });
  const layer2 = createWeaponLayer(new CharacterAnimator(ch2, manifest.clips), { boneGroups: manifest.boneGroups });
  check('快取：同一 clip 只過濾一次（兩個角色共用同一份過濾 clip）', again === clipOf('bat_hold') && layer2.slots.get('bat_hold').action.getClip() === clipOf('bat_hold'));

  // 走路 + bat_hold：權重 0.12 s 淡入；下半身骨與純走路相同、上半身被姿勢蓋過
  const ref = createCharacter({ variant: 'hero' });
  const refAnim = new CharacterAnimator(ref, manifest.clips);
  run(anim, layer, 0.5, { speed: 1.4 });
  run(refAnim, null, 0.5, { speed: 1.4 });
  check('setPose(bat_hold) 回 true', layer.setPose('bat_hold') === true && layer.pose === 'bat_hold');
  const holdA = layer.slots.get('bat_hold').action;
  anim.update(DT, { speed: 1.4 });
  layer.update(FADE_SEC / 2);
  refAnim.update(DT, { speed: 1.4 });
  const half = holdA.getEffectiveWeight() / UPPER_WEIGHT;
  run(anim, layer, 0.3, { speed: 1.4 });
  run(refAnim, null, 0.3, { speed: 1.4 });
  const full = holdA.getEffectiveWeight() / UPPER_WEIGHT;
  check(`姿勢權重 ${FADE_SEC} s 線性淡入（半程 ≈ 0.5、之後 = 1）`, Math.abs(half - 0.5) < 0.02 && full === 1 && holdA.isRunning(), `${half.toFixed(3)} → ${full}`);
  check('疊加中狀態機仍是 walk', anim.state === 'walk', anim.state);
  const qd = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.quaternion.dot(b.quaternion))));
  const legDiff = Math.max(...['LeftUpperLeg', 'RightLowerLeg', 'Hips'].map((n) => qd(ch.bones.get(n), ref.bones.get(n))));
  const armDiff = qd(ch.bones.get('RightUpperArm'), ref.bones.get('RightUpperArm'));
  check('下半身骨 = 純走路（< 0.001 rad）、右上臂被姿勢改變（> 0.05 rad）', legDiff < 1e-3 && armDiff > 0.05, `腿 ${legDiff.toExponential(2)}、臂 ${armDiff.toFixed(3)} rad`);

  // 揮棒：命中窗讀 manifest events、姿勢淡出、播完淡回
  const ev = [];
  let clock = 0;
  layer.on('hitWindow', (phase, clipTime, name) => ev.push([phase, clipTime, name, clock]));
  const fin = [];
  layer.on('finished', (n) => fin.push(n));
  const dur = layer.play('bat_swing_a');
  const swing = layer.slots.get('bat_swing_a');
  let holdMin = 1;
  for (let i = 0; i < 60 && (layer.upper || i < 5); i++) {
    clock += DT;
    anim.update(DT, { speed: 1.4 });
    layer.update(DT);
    holdMin = Math.min(holdMin, layer.slots.get('bat_hold').w);
  }
  const win = manifest.events.bat_swing_a.hitWindow;
  check('play(bat_swing_a) 回 clip 長度', Math.abs(dur - ch.clips.get('bat_swing_a').duration) < 1e-9, `${dur}`);
  check(`batHitWindow open / close 各一次、邏輯時間 = manifest ${win.join('–')} s`, ev.length === 2 && ev[0][0] === 'open' && ev[0][1] === win[0] && ev[1][0] === 'close' && ev[1][1] === win[1] && ev[0][2] === 'bat_swing_a', JSON.stringify(ev.map((e) => [e[0], e[1]])));
  check('事件幀不早於邊界、最多晚一幀', ev.length === 2 && ev[0][3] >= win[0] - 1e-9 && ev[0][3] <= win[0] + DT + 1e-9 && ev[1][3] <= win[1] + DT + 1e-9);
  check('揮棒中 bat_hold 淡出到 0、播完 finished 並淡回', holdMin === 0 && fin.includes('bat_swing_a') && layer.slots.get('bat_hold').w > 0 && !layer.upper);
  run(anim, layer, 0.3, { speed: 1.4 });
  check('揮棒 action 播完淡出後停止', swing.w === 0 && !swing.action.isRunning() && layer.slots.get('bat_hold').w === 1);

  // 揮棒被受擊打斷 → 補發 close；hit 中姿勢淡出、不接受 play
  ev.length = 0;
  const cancels = [];
  layer.on('cancel', (n) => cancels.push(n));
  layer.play('bat_swing_b');
  run(anim, layer, 0.3, { speed: 0 });
  const openB = anim.batHitWindowOpen;
  anim.trigger('hit', { side: 'front' });
  check('揮棒命中窗開著時被打 → 補發 close、upperCancel', openB && ev.map((e) => e[0]).join() === 'open,close' && cancels.includes('bat_swing_b') && !anim.batHitWindowOpen);
  check('hit 中 play 回 false', layer.play('bat_swing_a') === false && anim.playUpper('pistol_fire') === false);
  run(anim, layer, 0.2, { speed: 0 });
  check('hit 中上半身姿勢淡出（權重 0）', [...layer.slots.values()].every((s) => s.w === 0));
  run(anim, layer, 0.6, { speed: 0 });
  check('hit 結束 → bat_hold 淡回', anim.state === 'idle' && layer.slots.get('bat_hold').w === 1);

  // 換槍：weapon_equip 的 swap 事件、pistol_aim 姿勢
  const swaps = [];
  layer.on('swap', (t) => swaps.push(t));
  const eqDur = layer.play('weapon_equip');
  run(anim, layer, 0.6, { speed: 0 });
  check(`weapon_equip：回長度、swap 事件在 events.weapon_equip.swapAt（${manifest.events.weapon_equip.swapAt} s）`, eqDur > 0 && swaps.length === 1 && swaps[0] === manifest.events.weapon_equip.swapAt, JSON.stringify(swaps));
  check('setPose(pistol_aim) / none', layer.setPose('pistol_aim') && layer.pose === 'pistol_aim' && layer.setPose('none') && layer.pose === 'none' && layer.setPose('pistol_aim'));
  run(anim, layer, 0.3, { speed: 0 });

  // 開槍：fire 事件 + 加法後座（真 pistol_fire）
  const fires = [];
  layer.on('fire', (t) => fires.push(t));
  check('有 pistol_fire → 加法後座 action（非程序化）', !layer.proceduralRecoil);
  layer.addRecoil(0.5);
  const fdur = layer.play('pistol_fire');
  run(anim, layer, 0.1, { speed: 0 });
  const rec = [...ch.mixer._actions].find((a) => a.getClip().name.endsWith('@upper+add'));
  check('pistol_fire：fire 事件一次（shotAt）、加法 action 權重 = addRecoil k', fdur > 0 && fires.length === 1 && fires[0] === manifest.events.pistol_fire.shotAt && rec && rec.blendMode === THREE.AdditiveAnimationBlendMode && Math.abs(rec.getEffectiveWeight() - 0.5) < 1e-9, `fire ${fires.length}、w ${rec && rec.getEffectiveWeight()}`);
  const addTracks = rec ? trackNodes(rec.getClip()) : [];
  check('加法後座 clip 也只含 upper 骨', addTracks.length > 0 && addTracks.every((b) => upperSet.has(b)));
  check('開槍不打斷 pistol_aim 姿勢', layer.slots.get('pistol_aim').w === 1 && layer.pose === 'pistol_aim');

  // 全身封鎖：knockdown 中姿勢淡出、reset 歸零
  anim.trigger('knockdown');
  run(anim, layer, 0.3, { speed: 0 });
  check('knockdown 中姿勢權重 0、play 回 false', layer.slots.get('pistol_aim').w === 0 && layer.play('pistol_reload') === false);
  anim.reset();
  layer.reset();
  check('reset：姿勢 none、全部權重 0', layer.pose === 'none' && [...layer.slots.values()].every((s) => s.w === 0 && !s.action.isRunning()));
  // 既有 punch 命中窗不受武器層影響
  const pe = [];
  anim.on('punchHitWindow', (p) => pe.push(p));
  anim.trigger('punch');
  run(anim, layer, 0.8, { speed: 0 });
  check('punch 命中窗照常（open / close 各一次），不發 batHitWindow', pe.join() === 'open,close');
}

// ---- 4. 缺 clip：hold 不疊加、equip / reload 略過、swing → punch（比例命中窗）、缺 pistol_fire → 程序化後座 ----
{
  const ch = createCharacter({ variant: 'pedestrian_f' });
  for (const n of ['bat_hold', 'weapon_equip', 'pistol_reload', 'bat_swing_a', 'pistol_fire']) ch.clips.delete(n);
  const anim = new CharacterAnimator(ch, manifest.clips);
  const layer = createWeaponLayer(anim);
  check('缺 bat_hold → setPose 回 false（不疊加）', layer.setPose('bat_hold') === false && layer.pose === 'none');
  check('缺 weapon_equip / pistol_reload → play 回 false（略過）', layer.play('weapon_equip') === false && layer.play('pistol_reload') === false);
  const ev = [];
  layer.on('hitWindow', (p, t) => ev.push([p, t]));
  const dur = layer.play('bat_swing_a');
  const punchDur = ch.clips.get('punch').duration;
  const swingClip = layer.slots.get('bat_swing_a').action.getClip();
  run(anim, layer, 0.8, { speed: 0 });
  const expect = [punchDur * BAT_HIT_WINDOW[0], punchDur * BAT_HIT_WINDOW[1]];
  check('缺 bat_swing_a → 以 punch 的上半身代替（只含 upper 骨）', dur === punchDur && swingClip.name === 'punch@upper' && trackNodes(swingClip).every((b) => upperSet.has(b)));
  check(`代替 clip 命中窗 = 長度 × [${BAT_HIT_WINDOW.join(', ')}]`, ev.length === 2 && Math.abs(ev[0][1] - expect[0]) < 1e-9 && Math.abs(ev[1][1] - expect[1]) < 1e-9, JSON.stringify(ev));
  check('bat_swing_b 仍用 manifest 命中窗', anim.weaponClip('bat_swing_b').win[0] === manifest.events.bat_swing_b.hitWindow[0]);
  check('缺 pistol_fire → 程序化後座', layer.proceduralRecoil === true);
  // 程序化後座：與不開槍的對照組比較右上臂
  const ref = createCharacter({ variant: 'pedestrian_f' });
  const refAnim = new CharacterAnimator(ref, manifest.clips);
  run(anim, layer, 0.5, { speed: 0 });
  run(refAnim, null, 1.3, { speed: 0 });
  const fires = [];
  layer.on('fire', (t) => fires.push(t));
  layer.addRecoil(1);
  run(anim, layer, 0.05, { speed: 0 });
  run(refAnim, null, 0.05, { speed: 0 });
  const qd = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.quaternion.dot(b.quaternion))));
  const peak = qd(ch.bones.get('RightUpperArm'), ref.bones.get('RightUpperArm'));
  // animate = false（遠距不推進 mixer）時不重複疊加
  const before = ch.bones.get('RightUpperArm').quaternion.clone();
  anim.update(DT, { speed: 0, animate: false });
  layer.update(DT);
  const frozen = before.equals(ch.bones.get('RightUpperArm').quaternion);
  run(anim, layer, 0.4, { speed: 0 });
  run(refAnim, null, 0.4 + DT, { speed: 0 });
  const after = qd(ch.bones.get('RightUpperArm'), ref.bones.get('RightUpperArm'));
  check('程序化後座：峰值右上臂偏轉 > 0.1 rad、0.4 s 後歸位（< 0.005）、mixer 未推進時不累加', peak > 0.1 && after < 5e-3 && frozen, `峰 ${peak.toFixed(3)}、後 ${after.toExponential(2)}`);
  const fdur = layer.play('pistol_fire');
  run(anim, layer, 0.1, { speed: 0 });
  check('缺 pistol_fire：play 仍回長度（punch 計時）、fire 在 0 s', fdur === punchDur && fires.length === 1 && fires[0] === 0, JSON.stringify(fires));
}

// ---- 5. 插槽掛載：weapon_socket → RightHand → 方塊人右臂 → root；真武器 glb ----
{
  const wm = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'models/weapons/manifest.json'), 'utf8'));
  const entry = (id) => (Array.isArray(wm.weapons) ? wm.weapons.find((w) => w.id === id) : wm[id]);
  const loadGlb = async (file) => {
    const buf = fs.readFileSync(path.join(PUBLIC, 'models/weapons', file));
    return (await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '')).scene;
  };
  const hero = createCharacter({ variant: 'hero' });
  const pistol = await loadGlb(entry('pistol').file);
  const r1 = attachWeapon(hero, pistol, weaponMount(entry('pistol')));
  const q = entry('pistol').socketRotation;
  hero.root.updateMatrixWorld(true);
  const wp = new THREE.Vector3();
  const sp = new THREE.Vector3();
  pistol.getWorldPosition(wp);
  hero.bones.get('weapon_socket').getWorldPosition(sp);
  check('真 pistol.glb → 掛 weapon_socket、quaternion = socketRotation、握點對齊插槽原點', r1.mode === 'socket' && pistol.parent === hero.bones.get('weapon_socket') && Math.abs(pistol.quaternion.x - q[0]) < 1e-4 && Math.abs(pistol.quaternion.w - q[3]) < 1e-4 && wp.distanceTo(sp) < 1e-6, `${r1.mode}`);
  const bat = await loadGlb(entry('bat').file);
  attachWeapon(hero, bat, weaponMount(entry('bat')));
  check('掛新武器自動拿下舊的（真 bat.glb）', !pistol.parent && bat.parent === hero.bones.get('weapon_socket') && hero.weapon === bat);
  check('detachWeapon', detachWeapon(hero) && !bat.parent && hero.weapon === null && detachWeapon(hero) === false);
  // gripOffset 非零：握點（武器本地）落在插槽原點
  const probe = new THREE.Object3D();
  attachWeapon(hero, probe, { gripOffset: [0, 0, 0.1], rotation: [0.70711, 0, 0, 0.70711] });
  hero.root.updateMatrixWorld(true);
  const grip = probe.localToWorld(new THREE.Vector3(0, 0, 0.1));
  check('gripOffset [0,0,0.1] → 握點世界位置 = 插槽原點', grip.distanceTo(sp) < 1e-6, `${grip.distanceTo(sp).toExponential(2)} m`);
  // 行人同骨架
  const ped = createCharacter({ variant: 'pedestrian_heavy' });
  const pw = new THREE.Object3D();
  check('行人（pedestrian_heavy）同樣掛 weapon_socket', attachWeapon(ped, pw).mode === 'socket' && pw.parent.name === 'weapon_socket');
  // 缺插槽骨 → RightHand + 插槽相對位姿（與真插槽差 < 1 cm）
  const ped2 = createCharacter({ variant: 'pedestrian' });
  ped2.root.updateMatrixWorld(true);
  const realSock = ped2.bones.get('weapon_socket').getWorldPosition(new THREE.Vector3());
  ped2.bones.delete('weapon_socket');
  const w2 = new THREE.Object3D();
  const r2 = attachWeapon(ped2, w2);
  ped2.root.updateMatrixWorld(true);
  const d2 = w2.getWorldPosition(new THREE.Vector3()).distanceTo(realSock);
  check('缺 weapon_socket → 掛 RightHand、位置與原插槽差 < 1 cm', r2.mode === 'hand' && w2.parent.name === 'RightHand' && d2 < 0.01, `${(d2 * 100).toFixed(2)} cm`);
  // manifest 指定別的插槽名稱（字串形式）但骨不存在 → RightHand
  const ped3 = createCharacter({ variant: 'pedestrian' });
  check('socket 名稱不存在 → RightHand', attachWeapon(ped3, new THREE.Object3D(), { socket: 'no_such' }).mode === 'hand');
  // 方塊人
  const fb = createCharacter({ variant: 'no_such_variant' });
  const w3 = new THREE.Object3D();
  const r3 = attachWeapon(fb, w3);
  check('方塊人 → 掛右臂群組', r3.mode === 'humanoid' && w3.parent === fb.root.userData.parts.armR);
  const bare = { root: new THREE.Group(), bones: new Map() };
  check('連右臂都沒有 → 掛 root', attachWeapon(bare, new THREE.Object3D()).mode === 'root');
}

// ---- 6. manifest 缺檔 → 方塊人：武器層只跑計時與事件 ----
{
  const w0 = warns.length;
  const r = await loadCharacterModels('./models/characters/no_such_manifest.json', { fetch: fsFetch, reload: true });
  check('manifest 缺 → fallback（不丟例外）', r.fallback === true && getCharacterManifest() === null);
  const fb = createCharacter({ variant: 'pedestrian' });
  const anim = new CharacterAnimator(fb, manifest.clips);
  const layer = createWeaponLayer(anim);
  check('方塊人：missing 含 10 個新 clip、預設骨群組', anim.missing.filter((m) => m.state.includes('_')).length >= 10 && layer.upperBones === DEFAULT_BONE_GROUPS.upper);
  check('方塊人：setPose 回 false、weapon_equip 略過', layer.setPose('pistol_hold') === false && layer.play('weapon_equip') === false);
  const ev = [];
  layer.on('hitWindow', (p) => ev.push(p));
  const dur = layer.play('bat_swing_b');
  run(anim, layer, 1, { speed: 0 });
  check('方塊人：bat_swing_b 以 manifest 長度計時、命中窗照發', dur === 0.6 && ev.join() === 'open,close', `${dur} ${ev.join()}`);
  let threw = false;
  try {
    layer.addRecoil(1);
    run(anim, layer, 0.3, { speed: 0 });
  } catch {
    threw = true;
  }
  check('方塊人：addRecoil 不丟例外', !threw);
  check('manifest 缺檔不 console.error、警告只來自 model.js', warns.length - w0 <= 1, `${warns.length - w0} 則`);
  await loadCharacterModels('./models/characters/manifest.json', { fetch: fsFetch, reload: true });
}

// ---- 7. 效能：layer.update（7 槽 + 後座）× 行人 40 人 ----
{
  const layers = [];
  for (let i = 0; i < 40; i++) {
    const ch = createCharacter({ variant: 'pedestrian' });
    const anim = new CharacterAnimator(ch, manifest.clips);
    const layer = createWeaponLayer(anim);
    layer.setPose(i % 2 ? 'bat_hold' : 'pistol_aim');
    layers.push([anim, layer]);
  }
  for (let k = 0; k < 30; k++) for (const [a, l] of layers) { a.update(DT, { speed: 1.4 }); l.update(DT); }
  const N = 200;
  const t0 = performance.now();
  for (let k = 0; k < N; k++) for (const [, l] of layers) l.update(DT);
  const ms = (performance.now() - t0) / N;
  check('layer.update × 40 人 < 0.2 ms / 幀（不含 mixer）', ms < 0.2, `${ms.toFixed(4)} ms`);
}

console.warn = origWarn;
console.info = origInfo;
console.log(`\n通過 ${passed}、失敗 ${failed}；靜音的警告 ${warns.length}、資訊 ${infos.length} 則`);
console.log(failed ? `FAIL ${failed}/${passed + failed}` : `PASS ${passed}/${passed}`);
process.exit(failed ? 1 : 0);
