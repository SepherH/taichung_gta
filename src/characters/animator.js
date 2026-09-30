// 角色動畫狀態機：依移動速度在 idle / walk / run 間交叉淡化，一次性動作以 trigger 播放。
// 狀態名稱與 manifest 的 clip 名稱一致；缺 clip 時依 CLIP_FALLBACK 退回最接近者並記錄在 missing。
//
// 狀態轉換表（「可打斷」＝在該狀態播放中 trigger 對方會立即切換）：
//   狀態        進入方式                        可被打斷            結束後
//   idle/walk/run  update 依速度自動切換         jump punch hit knockdown enter_car（一律可觸發）
//   jump        trigger('jump')                 hit、knockdown      回移動狀態
//   punch       trigger('punch')                hit、knockdown      回移動狀態
//   hit         trigger('hit')                  hit（重播）、knockdown  回移動狀態
//   knockdown   trigger('knockdown')            （不可再被打斷）    停在最後一格，直到 trigger('getup')
//   getup       trigger('getup')，僅限 knockdown 播完後   knockdown  回移動狀態
//   enter_car   trigger('enter_car')，僅限移動狀態        knockdown  進入 drive
//   drive       只能由 enter_car 播完進入        knockdown           update 的 driving 變 false → 回移動狀態
// knockdown 可打斷一切（knockdown 本身除外）；一次性動作期間鎖住移動狀態（不因速度切換）。
//
// 播放速率：walk / run 依實際水平速度 ÷ 參考速度縮放，夾在 RATE_MIN–RATE_MAX（經理裁決 0.6–1.8）；
//   walk 需超過上限時改用 run clip（RUN_ABOVE = WALK_REF_SPEED × RATE_MAX），移動速度常數不因動畫而改
// 事件：on('punchHitWindow', cb(phase, clipTime))，phase 為 'open' / 'close'，clipTime 為命中窗邊界在 clip 內的秒數
//       （事件在跨過邊界的那一幀發出，實際幀時間最多晚一個 dt；punch 被打斷時若窗仍開著會補發 close，clipTime 為打斷時刻）；
//       on('finished', cb(name))：一次性動作播完（knockdown 播完也會發，之後停住）。
// 無骨架動畫的方塊人（character.fallback）同樣跑狀態與計時，外觀改用 humanoid.js 的擺臂 / 坐姿。
import * as THREE from 'three';
import { animateHumanoid, poseSitting } from '../humanoid.js';
import { getCharacterManifest } from './model.js';

const FADE = 0.2; // 交叉淡化秒數

// 播放速率參考速度（1.0 倍）：walk clip 1.0667 s（30 fps 共 32 格）為一個完整步態週期（左右各一步），
// 1.4 m/s × 1.0667 s ≈ 1.49 m／週期（單步約 0.75 m，1.75 m 身高常見步幅）；
// run clip 0.6667 s（20 格）一週期，5 m/s × 0.6667 s ≈ 3.33 m／週期（單步約 1.67 m）。
// 步幅是以 clip 長度 × 參考速度推算（推算值，非量測），美術改 clip 長度時需同步調整。
const WALK_REF_SPEED = 1.4;
const RUN_REF_SPEED = 5;
const REF_SPEED = { walk: WALK_REF_SPEED, run: RUN_REF_SPEED };
export const RATE_MIN = 0.6;
export const RATE_MAX = 1.8;

// 移動狀態切換門檻（m/s）：walk 播放速率到上限就改 run（1.4 × 1.8 = 2.52 m/s），另加遲滯避免在門檻附近來回切
const IDLE_BELOW = 0.2;
const RUN_ABOVE = WALK_REF_SPEED * RATE_MAX;
const HYSTERESIS = 0.15;

// punch 命中窗退路：manifest 沒有 events.punch.hitWindow（秒）時，改用 punch clip 長度的 35%–55%
export const PUNCH_HIT_WINDOW = [0.35, 0.55];

// 無 clip 也無 manifest 長度時一次性動作的計時秒數（僅方塊人退路用，非美術數值）
const FALLBACK_ONE_SHOT_SEC = 0.5;

export const LOCOMOTION = ['idle', 'walk', 'run'];
export const ONE_SHOTS = ['jump', 'punch', 'hit', 'knockdown', 'getup', 'enter_car'];
export const STATES = [...LOCOMOTION, ...ONE_SHOTS, 'drive'];

// 缺 clip 時依序嘗試的替代 clip
const CLIP_FALLBACK = {
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

// 各一次性動作可從哪些狀態觸發
const MOVE = new Set(LOCOMOTION);
const CAN_TRIGGER = {
  jump: (s) => MOVE.has(s),
  punch: (s) => MOVE.has(s),
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
    const win = hitWindow ?? getCharacterManifest()?.events?.punch?.hitWindow;
    const punchDur = this._info.get('punch').duration;
    this.hitWindow = validWindow(win)
      ? [Math.min(win[0], punchDur), Math.min(win[1], punchDur)]
      : [punchDur * PUNCH_HIT_WINDOW[0], punchDur * PUNCH_HIT_WINDOW[1]];

    this._state = null;
    this._t = 0; // 目前狀態已播放秒數（一次性動作的計時）
    this._done = false;
    this._windowOpen = false;
    this._speed = 0;
    this._phase = 0;
    this._enter('idle');
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

  _enter(st) {
    if (this._state === 'punch' && this._windowOpen) {
      this._windowOpen = false;
      this._emit('punchHitWindow', 'close', this._t);
    }
    const prev = this._state ? this._info.get(this._state).action : null;
    const next = this._info.get(st).action;
    this._state = st;
    this._t = 0;
    this._done = false;
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
    const idleEdge = cur === 'idle' ? IDLE_BELOW + HYSTERESIS : IDLE_BELOW;
    const runEdge = cur === 'run' ? RUN_ABOVE - HYSTERESIS : RUN_ABOVE;
    if (speed < idleEdge) return 'idle';
    return speed > runEdge ? 'run' : 'walk';
  }

  // walk / run 播放速率依實際速度 ÷ 來源 clip 的參考速度縮放
  _rateFor(st, speed) {
    const ref = REF_SPEED[this._info.get(st).source];
    if (!ref) return 1;
    return Math.min(RATE_MAX, Math.max(RATE_MIN, speed / ref));
  }

  // 播放一次性動作；回傳是否被接受（依轉換表）
  trigger(name) {
    const can = CAN_TRIGGER[name];
    if (!can || !can(this._state, { done: this._done })) return false;
    this._enter(name);
    return true;
  }

  // ctx：{ speed（水平速度 m/s）, grounded, driving, animate }；animate = false 時只跑狀態與事件、不推進 mixer
  //（遠距省效能：姿勢停在上一格，命中窗 / finished 等事件照常發出）
  update(dt, { speed = 0, grounded = true, driving = false, animate = true } = {}) {
    this._speed = speed;
    const st = this._state;
    const info = this._info.get(st);
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
    } else if (grounded) {
      const want = this._locomotionFor(speed);
      if (want !== st) this._enter(want);
    }

    const cur = this._info.get(this._state);
    if (cur.action && !ONE_SHOTS.includes(this._state)) cur.action.setEffectiveTimeScale(this._rateFor(this._state, speed));
    if (!animate) return;
    if (this.mixer) this.mixer.update(dt);
    else this._poseFallback(dt);
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
