// 角色動畫狀態機：依移動速度在 idle / walk / run 間交叉淡化，一次性動作以 trigger 播放。
// 狀態名稱與 manifest 的 clip 名稱一致；缺 clip 時依 CLIP_FALLBACK 退回最接近者並記錄在 missing。
//
// 狀態轉換表（「可打斷」＝在該狀態播放中 trigger 對方會立即切換）：
//   狀態        進入方式                        可被打斷            結束後
//   idle/walk/run  update 依速度自動切換         jump punch hit knockdown enter_car（一律可觸發）
//   jump        trigger('jump')                 hit、knockdown      回移動狀態
//   punch       trigger('punch')，移動狀態或 hit 中  hit、knockdown      回移動狀態
//   hit         trigger('hit')                  hit（重播）、punch、knockdown  回移動狀態
//   （hit 可被 punch 打斷：受擊硬直由 combat.js HIT_STUN 管，硬直結束後出拳不必等受擊動作播完）
//   knockdown   trigger('knockdown')            （不可再被打斷）    停在最後一格，直到 trigger('getup')
//   getup       trigger('getup')，僅限 knockdown 播完後   knockdown  回移動狀態
//   enter_car   trigger('enter_car')，僅限移動狀態        knockdown  進入 drive
//   drive       只能由 enter_car 播完進入        knockdown           update 的 driving 變 false → 回移動狀態
// knockdown 可打斷一切（knockdown 本身除外）；一次性動作期間鎖住移動狀態（不因速度切換）。
// idle_pose（選用，只有帶該 clip 的模型才有，例如主角 hero 單手插腰）：idle 且速度 < IDLE_POSE_SPEED 連續 IDLE_POSE_AFTER 秒後
//   循環播放；一有移動或任何 trigger 立即淡出回正常狀態機（視同移動狀態，一次性動作可直接觸發）。沒有 clip 時略過、不警告。
// hitStop(sec)：命中頓幀，期間狀態計時與 mixer 都停住（combat.js 命中時對攻守雙方呼叫）。
//
// 播放速率：walk / run 依實際水平速度 ÷ 參考速度縮放，夾在 RATE_MIN–RATE_MAX（經理裁決 0.6–1.8）；
//   walk 狀態上限放寬到 WALK_RATE_MAX（2.2），玩家步行 4.2 m/s 播 walk、跑步 8.5 m/s 與行人逃跑 4.5 m/s 播 run
//   （門檻 RUN_ABOVE 夾在兩者之間），移動速度常數不因動畫而改
// 事件：on('punchHitWindow', cb(phase, clipTime))，phase 為 'open' / 'close'，clipTime 為命中窗邊界在 clip 內的秒數
//       （事件在跨過邊界的那一幀發出，實際幀時間最多晚一個 dt；punch 被打斷時若窗仍開著會補發 close，clipTime 為打斷時刻）；
//       on('finished', cb(name))：一次性動作播完（knockdown 播完也會發，之後停住）。
// 無骨架動畫的方塊人（character.fallback）同樣跑狀態與計時，外觀改用 humanoid.js 的擺臂 / 坐姿。
//
// Phase 4（契約 §14）增補：
// - 定向受擊：trigger('hit', { side: 'front'|'back' }) → 有 hit_front / hit_back clip 用之，缺則一般 hit；
//   狀態名稱仍是 'hit'（轉換表與 combat 行為不變），實際方向記在 hitSide（'front'|'back'|null）
// - 武器 clip（WEAPON_CLIPS）：建構時解析來源並記在 weaponClip(name)；缺 clip 退回規則（WEAPON_CLIP_FALLBACK）：
//   bat_swing_* / pistol_fire → punch、*_hold / pistol_aim → 無（不疊加）、weapon_equip / pistol_reload → 無（略過）、
//   hit_front / hit_back → hit；缺者記入 missing（{ state, used }），整個程式只 console.info 一次（美術資產可能缺檔）
// - 上半身一次性動作計時：playUpper(name) → duration|false（weapon_equip / bat_swing_a / bat_swing_b / pistol_fire / pistol_reload），
//   與全身狀態並行（姿勢由 src/character-animation.js 的武器層疊上去；本檔只管計時與事件，吃同一個 hitStop）
//   事件：on('batHitWindow', cb(phase, clipTime, name))：bat_swing_* 命中窗（manifest events.<clip>.hitWindow，缺則長度 × BAT_HIT_WINDOW；
//         clip 以 punch 代替時一律用比例）；被打斷時補發 close
//         on('fire', cb(clipTime))：pistol_fire 跨過 events.pistol_fire.shotAt（缺則 0）
//         on('weaponSwap', cb(clipTime))：weapon_equip 跨過 events.weapon_equip.swapAt（缺則長度 × 0.4），整合層此時把武器換到手上
//         on('upperFinished', cb(name))：上半身一次性動作播完；on('upperCancel', cb(name))：被 hit / knockdown / 上車 / reset 打斷
//   hit / knockdown / getup / enter_car / drive 狀態中不接受 playUpper（回 false）；進入這些狀態時取消播放中的上半身動作
//
// P10（路人生活行為，src/ped-ambient.js）增補：不改上面的狀態機，另以 overlay action 疊在目前狀態之上
// - setAmbient(name|null)：循環 overlay（phone_talk / phone_text / phone_film / chat_gesture / look_around / sit_idle / jog / cower）；
//   playGesture(name) → duration|false：上半身一次性 overlay（wave / angry_shout / cheer），播完自動淡出
// - 疊加：同武器層的權重正規化——上半身 clip（AMBIENT_UPPER）權重 AMBIENT_UPPER_WEIGHT（≈ 92%，manifest 骨群組外的軌道濾掉，
//   腿仍由 idle / walk 驅動），全身 clip 權重 AMBIENT_FULL_WEIGHT（≈ 99.5%）；權重以 FADE 秒線性淡入淡出
// - jog：timeScale = 速度 ÷ 參考速度（jog clip = JOG_REF_SPEED，退回 run 時用 run 的參考速度），夾在 RATE_MIN–RATE_MAX
// - 缺 clip：依 CLIP_FALLBACK（ped-ambient.js AMBIENT_CLIP_FALLBACK 併入）退回；退回 idle 或全缺 = 不疊加（遊戲照常），
//   記在 ambientMissing（不記入 missing、不逐個 warn，整個程式只 console.info 一次）
// - hit / knockdown / getup / enter_car / drive（UPPER_BLOCKED）時 overlay 全部淡出且不接受新的；reset() 立即清掉
import * as THREE from 'three';
import { animateHumanoid, poseSitting } from '../humanoid.js';
import { getCharacterManifest, characterBoneGroups } from './model.js';
import { AMBIENT_CLIPS, AMBIENT_GESTURES, AMBIENT_UPPER, AMBIENT_CLIP_FALLBACK, JOG_REF_SPEED, resolveAmbientClip } from '../ped-ambient.js';

const FADE = 0.2; // 交叉淡化秒數

// 播放速率參考速度（1.0 倍）：walk clip 1.0667 s（30 fps 共 32 格）為一個完整步態週期（左右各一步），
// 1.4 m/s × 1.0667 s ≈ 1.49 m／週期（單步約 0.75 m，1.75 m 身高常見步幅）；
// run clip 0.6667 s（20 格）一週期，5 m/s × 0.6667 s ≈ 3.33 m／週期（單步約 1.67 m）。
// 步幅是以 clip 長度 × 參考速度推算（推算值，非量測），美術改 clip 長度時需同步調整。
const WALK_REF_SPEED = 1.4;
const RUN_REF_SPEED = 5;
const REF_SPEED = { walk: WALK_REF_SPEED, run: RUN_REF_SPEED, jog: JOG_REF_SPEED };
export const RATE_MIN = 0.6;
export const RATE_MAX = 1.8;
export const WALK_RATE_MAX = 2.2; // 只放寬 walk 狀態（其餘狀態仍 RATE_MIN–RATE_MAX）

// 移動狀態切換門檻（m/s），另加遲滯避免在門檻附近來回切：
// 玩家步行 4.2 m/s（player.js WALK_SPEED）以下播 walk；行人逃跑 4.5 m/s（traffic.js PED_RUN_SPEED）以上播 run；
// RUN_ABOVE 取 4.4，run → walk 在 4.4 − 0.15 = 4.25 m/s，仍高於步行 4.2，跑步減速到步行時能回 walk
const IDLE_BELOW = 0.2;
export const RUN_ABOVE = 4.4;
const HYSTERESIS = 0.15;

// punch 命中窗退路：manifest 沒有 events.punch.hitWindow（秒）時，改用 punch clip 長度的 35%–55%
export const PUNCH_HIT_WINDOW = [0.35, 0.55];
// 球棒命中窗退路：manifest 沒有 events.bat_swing_a/b.hitWindow（或 clip 以 punch 代替）時用 clip 長度的比例（契約 §13）
export const BAT_HIT_WINDOW = [0.3, 0.55];
// weapon_equip 換手時間點退路：沒有 events.weapon_equip.swapAt 時用 clip 長度的比例
const EQUIP_SWAP_RATIO = 0.4;

// 無 clip 也無 manifest 長度時一次性動作的計時秒數（僅方塊人退路用，非美術數值）
const FALLBACK_ONE_SHOT_SEC = 0.5;

// 站立待機姿勢：idle 且速度低於此值（m/s）連續 IDLE_POSE_AFTER 秒後播 idle_pose
export const IDLE_POSE = 'idle_pose';
export const IDLE_POSE_AFTER = 6;
export const IDLE_POSE_SPEED = 0.1;

export const LOCOMOTION = ['idle', 'walk', 'run'];
export const ONE_SHOTS = ['jump', 'punch', 'hit', 'knockdown', 'getup', 'enter_car'];
export const STATES = [...LOCOMOTION, ...ONE_SHOTS, 'drive'];

// Phase 4 新 clip（manifest clips 的 upperBodyOnly 為 true 者由武器層疊在下半身移動上；hit_front / hit_back 為全身）
export const HIT_SIDES = ['front', 'back'];
export const UPPER_POSES = ['bat_hold', 'pistol_hold', 'pistol_aim'];
export const UPPER_ONE_SHOTS = ['weapon_equip', 'bat_swing_a', 'bat_swing_b', 'pistol_fire', 'pistol_reload'];
export const WEAPON_CLIPS = ['weapon_equip', 'bat_hold', 'bat_swing_a', 'bat_swing_b', 'pistol_hold', 'pistol_aim', 'pistol_fire', 'pistol_reload', 'hit_front', 'hit_back'];
// 武器 clip 缺檔退回（空陣列 = 無替代：姿勢不疊加 / 一次性動作略過）
export const WEAPON_CLIP_FALLBACK = {
  weapon_equip: [],
  bat_hold: [],
  bat_swing_a: ['punch'],
  bat_swing_b: ['punch'],
  pistol_hold: [],
  pistol_aim: [],
  pistol_fire: ['punch'],
  pistol_reload: [],
  hit_front: ['hit'],
  hit_back: ['hit'],
};
// 這些全身狀態中不播上半身動作（武器層也在這些狀態淡出姿勢）
export const UPPER_BLOCKED = new Set(['hit', 'knockdown', 'getup', 'enter_car', 'drive']);
// 缺 clip 時無 manifest 長度的上半身一次性動作計時秒數（僅退路）
const FALLBACK_UPPER_SEC = 0.6;
let weaponInfoLogged = false; // 武器 clip 缺檔只 console.info 一次（整個程式）

// 生活行為 overlay 權重（相對目前狀態的 clip 權重 1）
export const AMBIENT_UPPER_WEIGHT = 12;
export const AMBIENT_FULL_WEIGHT = 200;
let ambientInfoLogged = false; // 生活行為 clip 缺檔只 console.info 一次（整個程式）
// overlay 用的 clip 副本快取：來源 clip → Map(鍵 → 副本)（替代 clip 另複製以免與原狀態共用 action；上半身另濾軌道）
const ambientClipCache = new WeakMap();

// 缺 clip 時依序嘗試的替代 clip（生活行為的名稱只供 overlay 解析，不是狀態機狀態）
const CLIP_FALLBACK = {
  ...AMBIENT_CLIP_FALLBACK,
  idle: [],
  walk: ['run', 'idle'],
  run: ['walk', 'idle'],
  jump: ['idle'],
  punch: ['hit', 'idle'],
  hit: ['punch', 'idle'],
  knockdown: ['hit', 'idle'],
  getup: ['idle'],
  enter_car: ['drive', 'idle'],
  drive: ['enter_car', 'idle'],
};

// 各一次性動作可從哪些狀態觸發（idle_pose 視同移動狀態）
const MOVE = new Set([...LOCOMOTION, IDLE_POSE]);
const CAN_TRIGGER = {
  jump: (s) => MOVE.has(s),
  punch: (s) => MOVE.has(s) || s === 'hit',
  hit: (s) => MOVE.has(s) || s === 'jump' || s === 'punch' || s === 'hit',
  knockdown: (s) => s !== 'knockdown',
  getup: (s, a) => s === 'knockdown' && a.done,
  enter_car: (s) => MOVE.has(s),
};

function validWindow(w) {
  return Array.isArray(w) && w.length === 2 && w.every(Number.isFinite) && w[0] >= 0 && w[1] > w[0];
}

export class CharacterAnimator {
  // character：createCharacter 的回傳值；manifestClips：manifest.clips（[{ name, duration, loop }]，可省略）
  // opts.hitWindow：命中窗 [開, 關]（秒，clip 內時間）；省略時讀已載入 manifest 的 events.punch.hitWindow（資產為單一事實來源）
  constructor(character, manifestClips = [], { hitWindow } = {}) {
    this.character = character;
    this.mixer = character.mixer;
    this.missing = []; // [{ state, used }]，used 為替代 clip 名稱或 null
    this.clipSources = new Map(); // state → 實際使用的 clip 名稱（或 null）
    this._listeners = new Map();
    this._info = new Map(); // state → { action, duration, source }
    const meta = new Map((manifestClips || []).map((c) => [c.name, c]));
    for (const st of STATES) this._setupState(st, character.clips, meta);
    this.hasIdlePose = character.clips.has(IDLE_POSE);
    if (this.hasIdlePose) this._setupState(IDLE_POSE, character.clips, meta);
    const events = getCharacterManifest()?.events || {};
    const win = hitWindow ?? events.punch?.hitWindow;
    const punchDur = this._info.get('punch').duration;
    this.hitWindow = validWindow(win)
      ? [Math.min(win[0], punchDur), Math.min(win[1], punchDur)]
      : [punchDur * PUNCH_HIT_WINDOW[0], punchDur * PUNCH_HIT_WINDOW[1]];
    this._setupWeaponClips(character.clips, meta, events);
    this._setupAmbientClips(character.clips, meta);
    this.hitSide = null; // 目前 hit 狀態的受擊方向（'front'|'back'|null）
    this._cur = null; // 目前狀態實際播放的 { action, duration, source }（定向受擊時為 hit_front / hit_back）
    this.mixerTicks = 0; // mixer 實際推進的次數（武器層程序化後座判斷本幀是否重擺過姿勢）
    // 上半身一次性動作計時（playUpper）；物件重用，播放中不配置
    this._up = { name: null, t: 0, duration: 0, win: null, open: false, markAt: -1, marked: false };

    this._state = null;
    this._t = 0; // 目前狀態已播放秒數（一次性動作的計時）
    this._done = false;
    this._windowOpen = false;
    this._speed = 0;
    this._phase = 0;
    this._idleT = 0; // idle 且幾乎靜止的累計秒數（idle_pose 用）
    this._stop = 0; // hitStop 剩餘秒數
    this._enter('idle');
  }

  // 物件池重用：停掉全部動作、回 idle（事件訂閱保留）
  reset() {
    if (this.mixer) this.mixer.stopAllAction();
    for (const o of this._ambOv) {
      o.name = null;
      o.info = null;
      o.w = 0;
      o.target = 0;
    }
    this.cancelUpper();
    this._state = null;
    this._cur = null;
    this._windowOpen = false;
    this._stop = 0;
    this._enter('idle');
  }

  // 命中頓幀：sec 秒內 update 不推進（取剩餘較長者）
  hitStop(sec) {
    this._stop = Math.max(this._stop, sec);
  }

  _setupState(st, clips, meta) {
    let source = clips.has(st) ? st : null;
    if (!source) {
      source = CLIP_FALLBACK[st].find((n) => clips.has(n)) || null;
      this.missing.push({ state: st, used: source });
      // 方塊人（整份模型未載入，model.js 已警告過一次）不再逐個 clip 警告
      if (!this.character.fallback) console.warn(`[animator] 缺 clip「${st}」，${source ? `改用「${source}」` : '無可替代，僅計時'}`);
    }
    this.clipSources.set(st, source);
    const oneShot = ONE_SHOTS.includes(st);
    let clip = source ? clips.get(source) : null;
    let action = null;
    if (clip && this.mixer) {
      // 替代 clip 另複製一份，避免與原狀態共用同一個 action（循環設定不同）
      if (source !== st) {
        clip = clip.clone();
        clip.name = `${st}<-${source}`;
      }
      action = this.mixer.clipAction(clip);
      if (oneShot) {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      } else {
        action.setLoop(THREE.LoopRepeat, Infinity);
      }
    }
    const m = meta.get(st);
    const duration = clip ? clip.duration : m ? m.duration : FALLBACK_ONE_SHOT_SEC;
    this._info.set(st, { action, duration, source });
  }

  // 武器 clip 來源解析（不建立 action：全身的 hit_front / hit_back 在此建立，上半身 clip 由武器層過濾軌道後自建）
  _setupWeaponClips(clips, meta, events) {
    this._weapon = new Map(); // name → { clip, source, duration, loop, upperBodyOnly, win, markAt }
    this._hitSide = new Map(); // 'front' / 'back' → { action, duration, source }
    const missed = [];
    for (const name of WEAPON_CLIPS) {
      let source = clips.has(name) ? name : null;
      if (!source) {
        source = WEAPON_CLIP_FALLBACK[name].find((n) => clips.has(n)) || null;
        this.missing.push({ state: name, used: source });
        missed.push(name);
      }
      const clip = source ? clips.get(source) : null;
      const m = meta.get(name);
      const duration = clip ? clip.duration : m && Number.isFinite(m.duration) ? m.duration : FALLBACK_UPPER_SEC;
      const loop = UPPER_POSES.includes(name);
      const info = { clip, source, duration, loop, upperBodyOnly: !name.startsWith('hit_'), win: null, markAt: -1 };
      const ev = events[name] || {};
      if (name === 'bat_swing_a' || name === 'bat_swing_b') {
        // manifest 命中窗只對應原 clip 的時間軸；以 punch 代替時改用比例
        info.win = source === name && validWindow(ev.hitWindow)
          ? [Math.min(ev.hitWindow[0], duration), Math.min(ev.hitWindow[1], duration)]
          : [duration * BAT_HIT_WINDOW[0], duration * BAT_HIT_WINDOW[1]];
      } else if (name === 'pistol_fire') {
        info.markAt = source === name && Number.isFinite(ev.shotAt) ? Math.min(Math.max(0, ev.shotAt), duration) : 0;
      } else if (name === 'weapon_equip') {
        info.markAt = source === name && Number.isFinite(ev.swapAt) ? Math.min(Math.max(0, ev.swapAt), duration) : duration * EQUIP_SWAP_RATIO;
      }
      this._weapon.set(name, info);
    }
    for (const side of HIT_SIDES) {
      const name = `hit_${side}`;
      const w = this._weapon.get(name);
      if (w.source !== name || !this.mixer) continue; // 缺則沿用一般 hit
      const action = this.mixer.clipAction(w.clip);
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      this._hitSide.set(side, { action, duration: w.duration, source: name });
    }
    // 方塊人（整份模型未載入）已由 model.js 警告過，不再提示
    if (missed.length && !this.character.fallback && !weaponInfoLogged) {
      weaponInfoLogged = true;
      console.info(`[animator] 角色 glb 缺武器 / 受擊 clip：${missed.join('、')}，改用替代 clip 或略過`);
    }
  }

  // 生活行為 clip 來源解析（action 第一次用到才建）
  _setupAmbientClips(clips, meta) {
    this._amb = new Map(); // name → { source, clip, action, duration, loop, upper, weight }
    this.ambientMissing = []; // [{ state, used }]
    const missed = [];
    for (const name of AMBIENT_CLIPS) {
      const source = resolveAmbientClip(name, (n) => clips.has(n));
      if (source !== name) {
        this.ambientMissing.push({ state: name, used: source });
        missed.push(name);
      }
      const clip = source && source !== 'idle' ? clips.get(source) : null; // 退回 idle = 不疊加
      const m = meta.get(name);
      const duration = clip ? clip.duration : m && Number.isFinite(m.duration) ? m.duration : FALLBACK_UPPER_SEC;
      const upper = AMBIENT_UPPER.has(name);
      const loop = !AMBIENT_GESTURES.includes(name);
      this._amb.set(name, { source, clip, action: null, duration, loop, upper, weight: upper ? AMBIENT_UPPER_WEIGHT : AMBIENT_FULL_WEIGHT });
    }
    // overlay 槽：0 = 循環（setAmbient）、1 = 淡出中的前一個循環、2 = 一次性手勢（playGesture）
    this._ambOv = [0, 1, 2].map(() => ({ name: null, info: null, w: 0, target: 0, t: 0 }));
    if (missed.length && !this.character.fallback && !ambientInfoLogged) {
      ambientInfoLogged = true;
      console.info(`[animator] 角色 glb 缺生活行為 clip：${missed.join('、')}，改用替代 clip 或不疊加`);
    }
  }

  // 生活行為 clip 解析結果：{ source, duration, loop, upper } 或 null（非生活行為 clip）
  ambientClip(name) {
    const i = this._amb.get(name);
    return i ? { source: i.source, duration: i.duration, loop: i.loop, upper: i.upper } : null;
  }

  // 目前的循環 overlay 名稱（null = 無）
  get ambient() {
    return this._ambOv[0].name;
  }

  // overlay 的 action（第一次用到才建；替代 clip / 上半身濾軌道的副本全程式快取共用）
  _ambAction(name, info) {
    if (info.action || !info.clip || !this.mixer) return info.action;
    let clip = info.clip;
    const upperBones = info.upper ? characterBoneGroups(getCharacterManifest()).upper : null;
    const key = `${name}|${upperBones ? upperBones.join(',') : ''}`;
    if (info.source !== name || upperBones) {
      let byKey = ambientClipCache.get(clip);
      if (!byKey) ambientClipCache.set(clip, (byKey = new Map()));
      let out = byKey.get(key);
      if (!out) {
        const keep = upperBones ? new Set(upperBones) : null;
        const tracks = keep ? clip.tracks.filter((t) => keep.has(THREE.PropertyBinding.parseTrackName(t.name).nodeName)) : clip.tracks;
        // 濾完沒剩任何軌道（骨名對不上）→ 用整份 clip，總比不疊好
        out = new THREE.AnimationClip(`${name}<-${info.source}`, clip.duration, (tracks.length ? tracks : clip.tracks).map((t) => t.clone()));
        byKey.set(key, out);
      }
      clip = out;
    }
    const action = this.mixer.clipAction(clip);
    if (info.loop) action.setLoop(THREE.LoopRepeat, Infinity);
    else {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    }
    info.action = action;
    return action;
  }

  // keep：接手淡出中的同一個 action（不從頭播）
  _ambPlay(o, name, info, keep = false) {
    o.name = name;
    o.info = info;
    o.t = 0;
    o.target = info.weight;
    const a = this._ambAction(name, info);
    if (!a) return;
    if (keep) {
      a.setEffectiveWeight(o.w);
      return;
    }
    a.reset();
    a.setEffectiveTimeScale(1);
    a.setEffectiveWeight(o.w);
    a.play();
  }

  // 循環 overlay：name = AMBIENT_LOOPS 之一或 null（淡出）；回傳是否接受（UPPER_BLOCKED 狀態中、未知名稱 → false）
  setAmbient(name) {
    const ov = this._ambOv[0];
    if (name === ov.name) return true;
    if (name === null) {
      this._ambFadeOut(ov);
      return true;
    }
    const info = this._amb.get(name);
    if (!info || !info.loop || UPPER_BLOCKED.has(this._state)) return false;
    const out = this._ambOv[1];
    let w = 0;
    if (out.info === info) {
      // 正在淡出的就是這個 → 從目前權重接手淡入
      w = out.w;
      out.name = null;
      out.info = null;
      out.w = 0;
    }
    this._ambFadeOut(ov);
    ov.w = w;
    this._ambPlay(ov, name, info, w > 0);
    return true;
  }

  // 把槽 0 的 overlay 移到淡出槽（原淡出槽的直接停掉）
  _ambFadeOut(ov) {
    if (!ov.name) return;
    const out = this._ambOv[1];
    if (out.info && out.info.action) out.info.action.stop();
    out.name = ov.name;
    out.info = ov.info;
    out.w = ov.w;
    out.target = 0;
    ov.name = null;
    ov.info = null;
    ov.w = 0;
    ov.target = 0;
  }

  // 上半身一次性手勢（wave / angry_shout / cheer）；回傳長度（秒）或 false（未知名稱 / UPPER_BLOCKED 狀態）
  // 缺 clip（退回 idle）時只計時、不疊加
  playGesture(name) {
    const info = this._amb.get(name);
    if (!info || info.loop || UPPER_BLOCKED.has(this._state)) return false;
    const g = this._ambOv[2];
    if (g.info && g.info.action && g.info !== info) g.info.action.stop();
    g.w = 0;
    this._ambPlay(g, name, info);
    return info.duration;
  }

  // 每次 update：權重淡入淡出、手勢播完淡出、jog 播放速率
  _ambStep(dt, speed) {
    const ov = this._ambOv;
    for (let k = 0; k < 3; k++) {
      const o = ov[k];
      if (!o.info) continue;
      o.t += dt;
      if (k === 2 && o.t >= o.info.duration - FADE) o.target = 0;
      const rate = (o.info.weight / FADE) * dt;
      o.w = o.w < o.target ? Math.min(o.target, o.w + rate) : Math.max(o.target, o.w - rate);
      const a = o.info.action;
      if (a) {
        a.setEffectiveWeight(o.w);
        if (o.name === 'jog') {
          const ref = REF_SPEED[o.info.source] || JOG_REF_SPEED;
          a.setEffectiveTimeScale(Math.min(RATE_MAX, Math.max(RATE_MIN, speed / ref)));
        }
      }
      if (o.target === 0 && o.w <= 0) {
        if (a) a.stop();
        o.name = null;
        o.info = null;
      }
    }
  }

  // 武器 clip 解析結果：{ clip（來源 AnimationClip 或 null）, source, duration, loop, upperBodyOnly } 或 null（非武器 clip）
  weaponClip(name) {
    return this._weapon.get(name) || null;
  }

  // 目前播放中的上半身一次性動作名稱（沒有 → null）
  get upper() {
    return this._up.name;
  }

  // 上半身一次性動作已播秒數
  get upperTime() {
    return this._up.t;
  }

  // 球棒命中窗目前是否開啟
  get batHitWindowOpen() {
    return this._up.open;
  }

  // 開始上半身一次性動作計時；回傳 clip 長度（秒）或 false（未知名稱 / 全身狀態不允許 / weapon_equip、pistol_reload 缺 clip 略過）
  // 播放中再次呼叫（例如連續揮棒 a → b、連射）會先以打斷處理舊的再重新開始
  playUpper(name) {
    if (!UPPER_ONE_SHOTS.includes(name) || UPPER_BLOCKED.has(this._state)) return false;
    const w = this._weapon.get(name);
    if (!w.source && (name === 'weapon_equip' || name === 'pistol_reload')) return false;
    this.cancelUpper();
    const up = this._up;
    up.name = name;
    up.t = 0;
    up.duration = w.duration;
    up.win = w.win;
    up.open = false;
    up.markAt = w.markAt;
    up.marked = false;
    return w.duration;
  }

  // 取消播放中的上半身一次性動作（命中窗開著時補發 close）；沒有播放中則不做事
  cancelUpper() {
    const up = this._up;
    if (!up.name) return;
    const name = up.name;
    up.name = null;
    if (up.open) {
      up.open = false;
      this._emit('batHitWindow', 'close', up.t, name);
    }
    this._emit('upperCancel', name);
  }

  // 上半身計時推進：命中窗 / 開槍 / 換手事件與播完
  _upperStep(dt) {
    const up = this._up;
    const t0 = up.t;
    const t1 = t0 + dt;
    up.t = t1;
    const name = up.name;
    if (up.win) {
      const [open, close] = up.win;
      if (!up.open && t0 < open && t1 >= open) {
        up.open = true;
        this._emit('batHitWindow', 'open', open, name);
      }
      if (up.open && t1 >= close) {
        up.open = false;
        this._emit('batHitWindow', 'close', close, name);
      }
    } else if (up.markAt >= 0 && !up.marked && t1 >= up.markAt) {
      up.marked = true;
      this._emit(name === 'pistol_fire' ? 'fire' : 'weaponSwap', up.markAt);
    }
    if (up.name === name && t1 >= up.duration) {
      up.name = null;
      this._emit('upperFinished', name);
    }
  }

  get state() {
    return this._state;
  }

  // punch 命中窗目前是否開啟
  get hitWindowOpen() {
    return this._windowOpen;
  }

  // 註冊事件；回傳取消註冊函式
  on(name, cb) {
    if (!this._listeners.has(name)) this._listeners.set(name, new Set());
    this._listeners.get(name).add(cb);
    return () => this._listeners.get(name).delete(cb);
  }

  _emit(name, ...args) {
    const set = this._listeners.get(name);
    if (set) for (const cb of set) cb(...args);
  }

  _enter(st, side = null) {
    if (this._state === 'punch' && this._windowOpen) {
      this._windowOpen = false;
      this._emit('punchHitWindow', 'close', this._t);
    }
    if (UPPER_BLOCKED.has(st)) {
      this.cancelUpper();
      if (this._ambOv) {
        this._ambFadeOut(this._ambOv[0]);
        this._ambOv[2].target = 0;
      }
    }
    const prev = this._cur ? this._cur.action : null;
    const cur = (side && this._hitSide.get(side)) || this._info.get(st);
    const next = cur.action;
    this._cur = cur;
    this._state = st;
    this.hitSide = st === 'hit' ? side : null;
    this._t = 0;
    this._done = false;
    this._idleT = 0;
    if (!next) return;
    next.reset();
    next.setEffectiveTimeScale(1);
    next.setEffectiveWeight(1);
    next.play();
    if (prev && prev !== next) prev.crossFadeTo(next, FADE, false);
  }

  // 依速度挑移動狀態（含遲滯）
  _locomotionFor(speed) {
    const cur = this._state;
    const idleEdge = cur === 'idle' || cur === IDLE_POSE ? IDLE_BELOW + HYSTERESIS : IDLE_BELOW;
    const runEdge = cur === 'run' ? RUN_ABOVE - HYSTERESIS : RUN_ABOVE;
    if (speed < idleEdge) return 'idle';
    return speed > runEdge ? 'run' : 'walk';
  }

  // walk / run 播放速率依實際速度 ÷ 來源 clip 的參考速度縮放（walk 狀態上限 WALK_RATE_MAX）
  _rateFor(st, speed) {
    const ref = REF_SPEED[this._info.get(st).source];
    if (!ref) return 1;
    return Math.min(st === 'walk' ? WALK_RATE_MAX : RATE_MAX, Math.max(RATE_MIN, speed / ref));
  }

  // 播放一次性動作；回傳是否被接受（依轉換表）
  // opts.side（僅 'hit'）：'front' / 'back' → 有 hit_front / hit_back clip 時播之（狀態名稱仍為 'hit'），其餘值或缺 clip → 一般 hit
  trigger(name, opts) {
    const can = CAN_TRIGGER[name];
    if (!can || !can(this._state, { done: this._done })) return false;
    const side = name === 'hit' && opts && HIT_SIDES.includes(opts.side) ? opts.side : null;
    this._enter(name, side);
    return true;
  }

  // ctx：{ speed（水平速度 m/s）, grounded, driving, animate }；animate = false 時只跑狀態與事件、不推進 mixer
  //（遠距省效能：姿勢停在上一格，命中窗 / finished 等事件照常發出）
  update(dt, { speed = 0, grounded = true, driving = false, animate = true } = {}) {
    if (this._stop > 0) {
      // 頓幀：吃掉本幀時間（超過剩餘頓幀的部分照常推進）
      const used = Math.min(this._stop, dt);
      this._stop -= used;
      dt -= used;
      if (dt <= 0) return;
    }
    this._speed = speed;
    if (this._up.name) this._upperStep(dt);
    if (this._ambOv[0].info || this._ambOv[1].info || this._ambOv[2].info) this._ambStep(dt, speed);
    const st = this._state;
    const info = this._cur;
    const t0 = this._t;
    this._t += dt;

    if (ONE_SHOTS.includes(st)) {
      if (st === 'punch') this._punchWindow(t0, this._t);
      if (!this._done && this._t >= info.duration) {
        this._done = true;
        this._emit('finished', st);
        if (st === 'enter_car') this._enter('drive');
        else if (st !== 'knockdown') this._enter(this._locomotionFor(speed));
      }
    } else if (st === 'drive') {
      if (!driving) this._enter(this._locomotionFor(speed));
    } else if (st === IDLE_POSE) {
      // 一有移動立即回移動狀態
      if (speed >= IDLE_POSE_SPEED || !grounded) this._enter(this._locomotionFor(speed));
    } else if (grounded) {
      const want = this._locomotionFor(speed);
      if (want !== st) this._enter(want);
      else if (st === 'idle' && this.hasIdlePose) {
        this._idleT = speed < IDLE_POSE_SPEED ? this._idleT + dt : 0;
        if (this._idleT >= IDLE_POSE_AFTER) this._enter(IDLE_POSE);
      }
    }

    const cur = this._cur;
    if (cur.action && !ONE_SHOTS.includes(this._state)) cur.action.setEffectiveTimeScale(this._rateFor(this._state, speed));
    if (!animate) return;
    if (this.mixer) {
      this.mixer.update(dt);
      this.mixerTicks++;
    } else this._poseFallback(dt);
  }

  // 命中窗：跨過開窗秒數發 open、跨過關窗秒數發 close（一幀跨過兩者時依序各發一次）
  _punchWindow(t0, t1) {
    const [open, close] = this.hitWindow;
    if (!this._windowOpen && t0 < open && t1 >= open) {
      this._windowOpen = true;
      this._emit('punchHitWindow', 'open', open);
    }
    if (this._windowOpen && t1 >= close) {
      this._windowOpen = false;
      this._emit('punchHitWindow', 'close', close);
    }
  }

  // 方塊人退路：移動狀態擺臂、drive 坐姿，其餘站直
  _poseFallback(dt) {
    const root = this.character.root;
    const st = this._state;
    if (st === 'walk' || st === 'run') {
      this._phase += dt * this._speed * 2.1;
      animateHumanoid(root, this._phase, Math.min(1, this._speed / WALK_REF_SPEED));
    } else if (st === 'drive') {
      poseSitting(root);
    } else {
      animateHumanoid(root, 0, 0);
    }
  }
}
