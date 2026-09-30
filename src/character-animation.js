// 角色武器動畫層（契約 §14）：上半身遮罩姿勢 / 一次性動作、加法後座、武器插槽掛載。玩家與骨架行人共用（同一副骨架）。
//
// createWeaponLayer(animator, { boneGroups }) → { setPose, play, addRecoil, update, on, reset, dispose, pose, upper }
//   - 上半身 clip（bat_hold / pistol_hold / pistol_aim / weapon_equip / bat_swing_* / pistol_reload）以 boneGroups.upper 過濾軌道：
//     建立 clip 副本、只留 upper 骨的 track（依來源 clip + 骨群組快取，所有角色共用同一份過濾結果），
//     在 animator 的 mixer 上建獨立 AnimationAction，疊在下半身移動（idle / walk / run 全身 clip）之上
//   - 疊加方式：three 的 PropertyMixer 對同一骨頭做「權重正規化平均」，上半身 action 權重取 UPPER_WEIGHT（≈ 92% 蓋過移動的擺臂），
//     下半身骨不在過濾後的 clip 內 → 仍完全由移動 clip 驅動；權重以 FADE_SEC（0.12 s）線性淡入淡出（layer.update 內手動推進，不另配置）
//   - 一次性動作計時與事件（命中窗 'batHitWindow'、'fire'、'weaponSwap'）由 animator.playUpper 負責；本層只負責姿勢權重
//   - 後座：pistol_fire 以 AnimationUtils.makeClipAdditive 轉成加法 clip（additive action，權重 = addRecoil 的 k）；
//     缺 pistol_fire（animator 以 punch 代替或完全沒有）→ 程序化脊椎 / 右臂旋轉脈衝（在 mixer 推進之後疊到骨頭 quaternion 上）
//   - animator 在 hit / knockdown / getup / enter_car / drive（UPPER_BLOCKED）時姿勢淡出，恢復後淡回
//   - 缺 clip：*_hold / pistol_aim 缺 → setPose 回 false（不疊加）；weapon_equip / pistol_reload 缺 → play 回 false（略過）；
//     bat_swing_* 缺 → 以 punch 的上半身代替（命中窗依比例）；方塊人（無 mixer）只跑計時與事件
//   每幀呼叫順序：animator.update(dt, …) → layer.update(dt)（同一個 dt；LOD 降頻時兩者一起降頻）
//
// attachWeapon(character, object3d, { gripOffset, rotation, socket }) → { parent, mode: 'socket'|'hand'|'humanoid'|'root' }
//   掛到 weapon_socket 骨（manifest weaponSocket，字串或 { bone }），缺則 RightHand（套上量自 glb 的插槽相對位姿）、
//   方塊人掛右臂、都沒有掛 root；握點對齊插槽原點：position = −(rotation · gripOffset)、quaternion = rotation（weapons manifest socketRotation）
// detachWeapon(character, object3d?)：拿下（省略 object3d = 拿下 attachWeapon 掛上的那一把）
import * as THREE from 'three';
import { UPPER_POSES, UPPER_ONE_SHOTS, UPPER_BLOCKED } from './characters/animator.js';
import { characterBoneGroups, weaponSocketBone, WEAPON_SOCKET_PARENT } from './characters/model.js';

export const FADE_SEC = 0.12; // 上半身姿勢 / 動作淡入淡出秒數
export const UPPER_WEIGHT = 12; // 上半身 action 相對移動 clip 的權重（12 / 13 ≈ 92%）
export const POSES = ['none', ...UPPER_POSES];
// 程序化後座脈衝：RECOIL_RISE 秒升到峰值、之後以 RECOIL_DECAY 時間常數衰減，RECOIL_SEC 後歸零
export const RECOIL_RISE = 0.04;
export const RECOIL_DECAY = 0.06;
export const RECOIL_SEC = 0.3;
// 峰值旋轉（弧度，骨頭本地 X 軸；k = 1 時）：負值 = 往上抬 / 往後仰（依 glb 綁定姿勢推定，待宿主目視確認方向）
export const RECOIL_BONES = [
  ['Spine', -0.05],
  ['Chest', -0.05],
  ['RightUpperArm', -0.22],
  ['RightLowerArm', -0.18],
];
// 插槽骨缺時的替代位姿：weapon_socket 在 RightHand 下的本地位姿（量自 pedestrian.glb / hero.glb，兩者差 < 1 cm）
const HAND_SOCKET_POS = [0.018, 0.076, -0.0008];
const HAND_SOCKET_QUAT = [0.9995, -0.0219, -0.0219, 0.0005];
// 方塊人（humanoid.js）右臂群組內的手部位置（arm 盒 0.6 m 往下、hand 在 −0.65）
const HUMANOID_HAND_POS = [0, -0.65, 0];
const ROOT_HAND_POS = [-0.3, 0.9, 0.25]; // 連右臂都沒有時掛 root 的大約右手位置

// 過濾快取：來源 clip → Map(骨群組鍵 → 只留 upper 骨軌道的副本)；加法 clip 另存（鍵加前綴）
const filterCache = new WeakMap();

// 軌道名稱 'Bone.quaternion' → 'Bone'（GLTFLoader 產生的名稱；另支援 PropertyBinding 完整語法）
function trackNode(name) {
  return THREE.PropertyBinding.parseTrackName(name).nodeName;
}

// 上半身過濾後的 clip 副本（同一 clip + 同一骨群組只過濾一次）；key 省略時由 upper 陣列產生
export function upperBodyClip(clip, upper, key = upper.join(',')) {
  let byKey = filterCache.get(clip);
  if (!byKey) {
    byKey = new Map();
    filterCache.set(clip, byKey);
  }
  let out = byKey.get(key);
  if (!out) {
    const keep = new Set(upper);
    const tracks = clip.tracks.filter((t) => keep.has(trackNode(t.name))).map((t) => t.clone());
    out = new THREE.AnimationClip(`${clip.name}@upper`, clip.duration, tracks);
    byKey.set(key, out);
  }
  return out;
}

// 上半身過濾後再轉成加法 clip（參考格 = 第 0 格），同樣快取
export function additiveUpperClip(clip, upper, key = upper.join(',')) {
  const akey = `additive|${key}`;
  const byKey = filterCache.get(clip);
  const hit = byKey && byKey.get(akey);
  if (hit) return hit;
  const base = upperBodyClip(clip, upper, key).clone();
  base.name = `${clip.name}@upper+add`;
  THREE.AnimationUtils.makeClipAdditive(base);
  filterCache.get(clip).set(akey, base);
  return base;
}

export function createWeaponLayer(animator, { boneGroups } = {}) {
  const groups = boneGroups && Array.isArray(boneGroups.upper) && boneGroups.upper.length ? boneGroups : characterBoneGroups();
  const upper = groups.upper;
  const key = upper.join(',');
  const mixer = animator.mixer;
  const bones = animator.character.bones || new Map();

  // 每個上半身 clip 一個槽：{ action|null, w（0–1 淡化進度）, target }
  const slots = new Map();
  for (const name of [...UPPER_POSES, ...UPPER_ONE_SHOTS]) {
    if (name === 'pistol_fire') continue; // 開槍只走加法後座
    const info = animator.weaponClip(name);
    let action = null;
    if (mixer && info && info.clip) {
      action = mixer.clipAction(upperBodyClip(info.clip, upper, key));
      if (info.loop) action.setLoop(THREE.LoopRepeat, Infinity);
      else {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      action.setEffectiveWeight(0);
    }
    slots.set(name, { name, action, w: 0, target: 0, playing: false });
  }
  const slotList = [...slots.values()]; // 每幀以索引走訪（不建立 Map 迭代器）

  // 後座：有真 pistol_fire → 加法 action；否則程序化脈衝
  const fireInfo = animator.weaponClip('pistol_fire');
  let recoilAction = null;
  if (mixer && fireInfo && fireInfo.source === 'pistol_fire') {
    recoilAction = mixer.clipAction(additiveUpperClip(fireInfo.clip, upper, key));
    recoilAction.blendMode = THREE.AdditiveAnimationBlendMode;
    recoilAction.setLoop(THREE.LoopOnce, 1);
    recoilAction.clampWhenFinished = false;
  }
  const recoilBones = [];
  for (const [name, amp] of RECOIL_BONES) {
    const b = bones.get(name);
    if (b) recoilBones.push({ bone: b, amp });
  }
  const recoil = { t: RECOIL_SEC, k: 0, lastTick: -1 };
  const tmpQ = new THREE.Quaternion();
  const AXIS_X = new THREE.Vector3(1, 0, 0);

  let pose = 'none';
  let shot = null; // 目前本層播放中的上半身一次性動作（與 animator.upper 同步）
  let recoilScale = 1;

  function setPose(name) {
    if (!POSES.includes(name)) return false;
    if (name === 'none') {
      pose = 'none';
      return true;
    }
    if (!slots.get(name).action) return false; // clip 缺（或方塊人無 mixer）：不疊加
    pose = name;
    return true;
  }

  function play(name) {
    const dur = animator.playUpper(name);
    if (dur === false) return false;
    if (name === 'pistol_fire') {
      kickRecoil(recoilScale);
      return dur;
    }
    shot = name;
    const s = slots.get(name);
    if (s.action) {
      s.action.reset();
      s.action.setEffectiveWeight(s.w * UPPER_WEIGHT);
      s.action.play();
      s.playing = true;
    }
    return dur;
  }

  function kickRecoil(k) {
    if (recoilAction) {
      recoilAction.reset();
      recoilAction.setEffectiveWeight(k);
      recoilAction.play();
    }
    recoil.t = 0;
    recoil.k = k;
  }

  // 後座（k = settings.recoil 等強度係數，0.2–1.0；可 > 1）：之後的 play('pistol_fire') 也沿用此強度
  function addRecoil(k = 1) {
    const kk = Number.isFinite(k) ? Math.max(0, k) : 1;
    recoilScale = kk;
    kickRecoil(kk);
  }

  function stepWeight(s, dt) {
    const stepW = dt / FADE_SEC;
    if (s.w < s.target) s.w = Math.min(s.target, s.w + stepW);
    else if (s.w > s.target) s.w = Math.max(s.target, s.w - stepW);
    if (!s.action) return;
    if (s.w > 0 || s.target > 0) {
      // 循環姿勢淡入時才開始播；一次性動作由 play() 重播（播完 clamp 停在最後一格，淡出前不重播）
      if (!s.playing) {
        s.action.reset();
        s.action.play();
        s.playing = true;
      }
      s.action.setEffectiveWeight(s.w * UPPER_WEIGHT);
    } else if (s.playing) {
      s.action.stop();
      s.playing = false;
    }
  }

  function update(dt) {
    const blocked = UPPER_BLOCKED.has(animator.state);
    if (shot && animator.upper !== shot) shot = null; // 播完或被打斷：淡出
    for (let i = 0; i < slotList.length; i++) {
      const s = slotList[i];
      s.target = blocked ? 0 : shot ? (s.name === shot ? 1 : 0) : s.name === pose ? 1 : 0;
      stepWeight(s, dt);
    }
    // 程序化後座：只在 mixer 本幀重擺過骨頭時疊加（mixer 沒推進時骨頭保留上次結果，重複疊會累積）
    if (recoil.t < RECOIL_SEC) {
      recoil.t += dt;
      if (!recoilAction && recoilBones.length && animator.mixerTicks !== recoil.lastTick) {
        recoil.lastTick = animator.mixerTicks;
        const t = recoil.t;
        const env = t < RECOIL_RISE ? t / RECOIL_RISE : t < RECOIL_SEC ? Math.exp(-(t - RECOIL_RISE) / RECOIL_DECAY) : 0;
        const e = env * recoil.k;
        if (e > 1e-4) {
          for (let i = 0; i < recoilBones.length; i++) {
            tmpQ.setFromAxisAngle(AXIS_X, recoilBones[i].amp * e);
            recoilBones[i].bone.quaternion.multiply(tmpQ);
          }
        }
      }
    }
  }

  // 程序化後座目前的包絡值（0–k；測試 / 除錯用）
  function recoilLevel() {
    const t = recoil.t;
    if (t >= RECOIL_SEC) return 0;
    return (t < RECOIL_RISE ? t / RECOIL_RISE : Math.exp(-(t - RECOIL_RISE) / RECOIL_DECAY)) * recoil.k;
  }

  // 事件：'hitWindow'（= animator 'batHitWindow'：phase, clipTime, name）、'fire'、'swap'（weapon_equip 換手點）、'finished'、'cancel'
  const EVENT_MAP = { hitWindow: 'batHitWindow', fire: 'fire', swap: 'weaponSwap', finished: 'upperFinished', cancel: 'upperCancel' };
  function on(name, cb) {
    return animator.on(EVENT_MAP[name] || name, cb);
  }

  // 物件池重用（traffic 還骨架時 animator.reset() 已停掉全部 action）：姿勢歸零
  function reset() {
    pose = 'none';
    shot = null;
    recoil.t = RECOIL_SEC;
    for (const s of slots.values()) {
      s.w = 0;
      s.target = 0;
      s.playing = false;
      if (s.action) s.action.stop();
    }
    if (recoilAction) recoilAction.stop();
  }

  function dispose() {
    reset();
    if (!mixer) return;
    for (const s of slots.values()) if (s.action) mixer.uncacheAction(s.action.getClip());
    if (recoilAction) mixer.uncacheAction(recoilAction.getClip());
  }

  return {
    setPose,
    play,
    addRecoil,
    update,
    on,
    reset,
    dispose,
    recoilLevel,
    get pose() {
      return pose;
    },
    get upper() {
      return shot;
    },
    // 除錯 / 測試：各槽 { action, w }；proceduralRecoil = 缺 pistol_fire 走程序化脈衝
    slots,
    proceduralRecoil: !recoilAction,
    upperBones: upper,
  };
}

const tmpGrip = new THREE.Vector3();
const tmpRot = new THREE.Quaternion();
const tmpHand = new THREE.Quaternion();

function quatFrom(arr, out) {
  if (Array.isArray(arr) && arr.length === 4 && arr.every(Number.isFinite)) out.set(arr[0], arr[1], arr[2], arr[3]).normalize();
  else out.identity();
  return out;
}

// 掛武器：握點（gripOffset，武器本地座標）對齊插槽原點、武器 quaternion = rotation（[x, y, z, w]，weapons manifest socketRotation）
export function attachWeapon(character, object3d, { gripOffset = [0, 0, 0], rotation = null, socket = weaponSocketBone() } = {}) {
  if (character.weapon && character.weapon !== object3d) detachWeapon(character);
  const bones = character.bones || new Map();
  let parent = bones.get(socket);
  let mode = 'socket';
  quatFrom(rotation, tmpRot);
  if (Array.isArray(gripOffset) && gripOffset.length === 3) tmpGrip.set(gripOffset[0], gripOffset[1], gripOffset[2]);
  else tmpGrip.set(0, 0, 0);
  tmpGrip.applyQuaternion(tmpRot).negate();
  if (!parent && bones.get(WEAPON_SOCKET_PARENT)) {
    // 沒有插槽骨：掛右手骨並補上插槽相對右手的位姿
    parent = bones.get(WEAPON_SOCKET_PARENT);
    mode = 'hand';
    quatFrom(HAND_SOCKET_QUAT, tmpHand);
    tmpGrip.applyQuaternion(tmpHand).add(new THREE.Vector3().fromArray(HAND_SOCKET_POS));
    tmpRot.premultiply(tmpHand);
  } else if (!parent) {
    const armR = character.root.userData && character.root.userData.parts && character.root.userData.parts.armR;
    parent = armR || character.root;
    mode = armR ? 'humanoid' : 'root';
    tmpGrip.add(new THREE.Vector3().fromArray(armR ? HUMANOID_HAND_POS : ROOT_HAND_POS));
  }
  object3d.position.copy(tmpGrip);
  object3d.quaternion.copy(tmpRot);
  parent.add(object3d);
  character.weapon = object3d;
  return { parent, mode };
}

export function detachWeapon(character, object3d = character.weapon) {
  if (!object3d) return false;
  object3d.removeFromParent();
  if (character.weapon === object3d) character.weapon = null;
  return true;
}

// weapons manifest（{ weapons: [ { id, gripOffset, socketRotation, … } ] } 或 { bat: {…} }）的一筆 → attachWeapon 的 opts
export function weaponMount(entry) {
  return { gripOffset: entry && entry.gripOffset, rotation: entry && entry.socketRotation };
}
