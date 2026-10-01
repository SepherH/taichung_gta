// 程序合成音效（契約 §15）：WebAudio 噪聲 buffer + 振盪器 + 濾波 + 包絡，不下載任何音檔
// createAudio({ bus, settings, AudioContextCtor }) → { unlock(), update(dt, state), play(name, opts), stats(), dispose() }
// - AudioContext 延到 unlock()（首次使用者手勢）才建立並 resume；未解鎖前 play 靜默略過；無 AudioContext（node）時整個模組 no-op
// - 音量：master × sfx（一次性音效、引擎、輪胎）、master × music（路口聲景）；settings.subscribe 即時生效
// - 音源池 ≤ MAX_VOICES（持續音源算在內）；滿了停掉最舊的一次性音源
// - weapon:impact → ricochet（world 石面「啾」/ vehicle 金屬「鏘」，配方在本檔 IMPACT_RECIPES）
// - 一次性音效帶 opts.x / z 時以上一幀 update 的 state.x / z / yaw 為聆聽點：距離衰減（> MAX_DIST 不播）+ 左右聲像
// - 每幀 update 不配置物件（只有腳步觸發時建立 WebAudio 節點，這是 WebAudio 一次性節點的本質）

import { makeNoiseBuffers, noiseHit, toneHit } from './synth.js';
import { RECIPES, LOOPS, UI_KINDS, clamp01 } from './voices.js';

// ±k 的隨機音高變化（同 voices.js）
const vary = (k) => 1 + (Math.random() * 2 - 1) * k;

// 子彈擊中非角色（weapon:impact）：o.surface 'vehicle' → 金屬「鏘」，其餘（'world'）→ 石面「啾」
const IMPACT_RECIPES = {
  ricochet(v, t, o, nb) {
    const p = vary(0.08);
    if (o && o.surface === 'vehicle') {
      // 金屬：窄帶通噪聲敲擊 + 兩個非諧和三角波共鳴
      noiseHit(v, t, { buf: nb.white, type: 'bandpass', freq: 3200 * p, Q: 8, gain: 0.55, a: 0.001, d: 0.05 });
      toneHit(v, t, { type: 'triangle', freq: 1850 * p, gain: 0.3, a: 0.001, d: 0.22 });
      toneHit(v, t, { type: 'triangle', freq: 2730 * p, gain: 0.18, a: 0.001, d: 0.16 });
      return 0.25;
    }
    // 石面：高通碎裂噪聲 + 由高往低滑的跳彈「啾」
    noiseHit(v, t, { buf: nb.white, type: 'highpass', freq: 2400 * p, gain: 0.5, a: 0.001, d: 0.04 });
    toneHit(v, t + 0.01, { type: 'sine', freq: 3400 * p, freqEnd: 1300 * p, gain: 0.16, a: 0.004, d: 0.14 });
    return 0.17;
  },
};
const ALL_RECIPES = Object.assign({}, RECIPES, IMPACT_RECIPES);

export const MAX_VOICES = 12;
export const MAX_DIST = 60; // m，超過不播
export const SOUND_NAMES = Object.keys(ALL_RECIPES);
const IMPACT_VOLUME = 0.7; // 擊中聲比槍聲輕
export const LOOP_NAMES = Object.keys(LOOPS);

const JUNCTION_ON = 60; // m：路口聲景開始
const JUNCTION_OFF = 70; // m：遲滯，超過才停
const RUN_SPEED = 3.5; // m/s：以上算跑步（腳步較響）

// 距離 → 音量倍率（近處 1，60 m 前 12 m 內淡到 0）
export function distanceGain(d) {
  if (!(d >= 0)) return 1;
  if (d > MAX_DIST) return 0;
  return Math.min(1, (MAX_DIST - d) / 12) / (1 + 0.08 * d);
}

// 聲像 −1（左）~ 1（右）：yaw 慣例同 camera.js，前方 (sin yaw, cos yaw)、右方 (−cos yaw, sin yaw)
export function panFor(dx, dz, yaw) {
  const d = Math.hypot(dx, dz);
  if (d < 1e-3) return 0;
  const p = ((dx * -Math.cos(yaw) + dz * Math.sin(yaw)) / d) * Math.min(1, d / 2) * 0.9;
  return p < -1 ? -1 : p > 1 ? 1 : p;
}

function settingOr(settings, key, dflt) {
  try {
    const v = settings && typeof settings.get === 'function' ? settings.get(key) : undefined;
    return Number.isFinite(v) ? v : dflt;
  } catch (err) {
    return dflt;
  }
}

function noopAudio() {
  return {
    unlock: () => false,
    update() {},
    play: () => false,
    stats: () => ({ voices: 0, maxVoices: MAX_VOICES, unlocked: false }),
    dispose() {},
  };
}

export function createAudio({ bus, settings, AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext } = {}) {
  if (typeof AudioContextCtor !== 'function') return noopAudio();

  const vol = {
    volumeMaster: settingOr(settings, 'volumeMaster', 0.8),
    volumeMusic: settingOr(settings, 'volumeMusic', 0.6),
    volumeSfx: settingOr(settings, 'volumeSfx', 0.9),
  };
  let ctx = null;
  let nb = null; // 噪聲 buffer
  let master = null;
  let sfx = null;
  let music = null;
  let unlocked = false;
  let disposed = false;
  let broken = false; // 建立 AudioContext 失敗 → 之後都當 no-op

  const voices = []; // { ctx, out, sources, end, loop, panner }
  const loops = { engine: null, tire: null, ambience: null }; // { v, ctrl, last }
  // 聆聽點（上一幀 state）
  let hasListener = false;
  let lx = 0;
  let lz = 0;
  let lyaw = 0;
  // 腳步
  let stepAcc = 0;
  const stepOpts = { run: false };
  let tireHold = 0;
  // 除錯 / 測試
  let playCount = 0;
  let lastPlayed = null;

  function applyVolumes() {
    if (!master) return;
    master.gain.value = vol.volumeMaster;
    sfx.gain.value = vol.volumeSfx;
    music.gain.value = vol.volumeMusic;
  }

  const unsubSettings = settings && typeof settings.subscribe === 'function'
    ? settings.subscribe((key, value) => {
      if (Object.prototype.hasOwnProperty.call(vol, key) && Number.isFinite(value)) {
        vol[key] = value;
        applyVolumes();
      }
    })
    : null;

  function running() {
    return !!ctx && unlocked && !disposed && (ctx.state === undefined || ctx.state === 'running');
  }

  function stopVoice(v, now) {
    try {
      v.out.gain.setTargetAtTime(0, now, 0.01);
    } catch (err) {
      // 忽略
    }
    for (let i = 0; i < v.sources.length; i++) {
      try {
        v.sources[i].stop(now + 0.05);
      } catch (err) {
        // 已停止
      }
    }
  }

  function disconnect(v) {
    try {
      v.out.disconnect();
      if (v.panner) v.panner.disconnect();
    } catch (err) {
      // 忽略
    }
  }

  function removeVoice(v) {
    const i = voices.indexOf(v);
    if (i >= 0) voices.splice(i, 1);
  }

  // 移除已播完的一次性音源（原地壓縮，不配置）
  function reap(now) {
    let w = 0;
    for (let i = 0; i < voices.length; i++) {
      const v = voices[i];
      if (!v.loop && v.end <= now) {
        disconnect(v);
        continue;
      }
      voices[w++] = v;
    }
    voices.length = w;
  }

  // 音源池滿時停掉最舊的一次性音源；回傳是否有空位
  function makeRoom(now) {
    while (voices.length >= MAX_VOICES) {
      let idx = -1;
      for (let i = 0; i < voices.length; i++) {
        if (!voices[i].loop) {
          idx = i;
          break; // voices 依建立順序排列，第一個一次性音源即最舊
        }
      }
      if (idx < 0) return false;
      const v = voices[idx];
      voices.splice(idx, 1);
      stopVoice(v, now);
      disconnect(v);
    }
    return true;
  }

  function play(name, opts) {
    if (!running() || broken) return false;
    const recipe = ALL_RECIPES[name];
    if (!recipe) return false;
    const o = opts || {};
    let g = Number.isFinite(o.volume) ? Math.max(0, o.volume) : 1;
    let pan = 0;
    if (hasListener && Number.isFinite(o.x) && Number.isFinite(o.z)) {
      const dx = o.x - lx;
      const dz = o.z - lz;
      const d = Math.hypot(dx, dz);
      if (d > MAX_DIST) return false;
      g *= distanceGain(d);
      pan = panFor(dx, dz, lyaw);
    }
    if (g <= 0) return false;
    const now = ctx.currentTime;
    reap(now);
    if (!makeRoom(now)) return false;
    try {
      const out = ctx.createGain();
      out.gain.value = g;
      let panner = null;
      if (pan !== 0 && typeof ctx.createStereoPanner === 'function') {
        panner = ctx.createStereoPanner();
        panner.pan.value = pan;
        out.connect(panner);
        panner.connect(sfx);
      } else {
        out.connect(sfx);
      }
      const v = { ctx, out, sources: [], end: 0, loop: false, panner, name };
      const t = now + 0.005;
      const dur = recipe(v, t, o, nb);
      v.end = t + dur + 0.05;
      voices.push(v);
      playCount++;
      lastPlayed = name;
      return true;
    } catch (err) {
      return false; // 合成失敗不影響遊戲
    }
  }

  function startLoop(name, group) {
    const now = ctx.currentTime;
    reap(now);
    if (!makeRoom(now)) return null;
    try {
      const v = { ctx, out: null, sources: [], end: Infinity, loop: true, panner: null, name };
      const ctrl = LOOPS[name](v, nb);
      v.out = ctrl.gain;
      ctrl.gain.connect(group);
      voices.push(v);
      return { v, ctrl, last: 0 };
    } catch (err) {
      return null;
    }
  }

  function stopLoop(name) {
    const L = loops[name];
    if (!L) return;
    loops[name] = null;
    const now = ctx.currentTime;
    try {
      L.ctrl.gain.gain.setTargetAtTime(0, now, 0.06);
    } catch (err) {
      // 忽略
    }
    for (let i = 0; i < L.v.sources.length; i++) {
      try {
        L.v.sources[i].stop(now + 0.4);
      } catch (err) {
        // 已停止
      }
    }
    removeVoice(L.v);
  }

  function loopGain(L, target, now) {
    if (Math.abs(target - L.last) > 0.004) {
      L.last = target;
      L.ctrl.gain.gain.setTargetAtTime(target, now, 0.08);
    }
  }

  function update(dt, state) {
    if (disposed || !state) return;
    if (Number.isFinite(state.x) && Number.isFinite(state.z)) {
      lx = state.x;
      lz = state.z;
      lyaw = Number.isFinite(state.yaw) ? state.yaw : 0;
      hasListener = true;
    }
    if (!running() || broken) return;
    const now = ctx.currentTime;
    reap(now);
    const paused = !!state.paused;
    const driving = !!state.driving;

    // 引擎（駕駛中持續）
    if (driving && !loops.engine) loops.engine = startLoop('engine', sfx);
    else if (!driving && loops.engine) stopLoop('engine');
    if (loops.engine) {
      loops.engine.ctrl.set(state, now);
      const th = clamp01(Math.abs(state.throttle || 0));
      loopGain(loops.engine, paused ? 0 : 0.12 + 0.16 * th + 0.08 * clamp01(state.rpm01), now);
    }

    // 輪胎（skid01 超過門檻才開，低於門檻 0.4 s 後關）
    const skid = clamp01(state.skid01);
    if (driving && skid > 0.12) {
      tireHold = 0.4;
      if (!loops.tire) loops.tire = startLoop('tire', sfx);
    } else if (loops.tire) {
      tireHold -= dt > 0 ? dt : 0;
      if (!driving || tireHold <= 0) stopLoop('tire');
    }
    if (loops.tire) {
      loops.tire.ctrl.set(state, now);
      loopGain(loops.tire, paused ? 0 : 0.45 * skid, now);
    }

    // 路口聲景（music 群組，低音量；距離遲滯）
    const nj = state.nearJunction;
    const hasNj = nj !== null && nj !== undefined && Number.isFinite(nj);
    if (hasNj && nj < JUNCTION_ON && !loops.ambience) loops.ambience = startLoop('ambience', music);
    else if (loops.ambience && (!hasNj || nj > JUNCTION_OFF)) stopLoop('ambience');
    if (loops.ambience) {
      const k = hasNj ? Math.max(0.03, 1 - nj / JUNCTION_OFF) : 0;
      loopGain(loops.ambience, paused ? 0 : 0.2 * k, now);
    }

    // 腳步：依 walkSpeed 累積步距（跑步步距較長、較響）
    const ws = Number.isFinite(state.walkSpeed) ? state.walkSpeed : 0;
    if (!paused && !driving && state.grounded !== false && ws > 0.4 && dt > 0) {
      const stride = 0.55 + ws * 0.22;
      stepAcc += ws * dt;
      if (stepAcc >= stride) {
        stepAcc -= stride;
        if (stepAcc > stride) stepAcc = 0; // 卡頓的大 dt 不連發
        stepOpts.run = ws > RUN_SPEED;
        play('footstep', stepOpts);
      }
    } else {
      stepAcc = 0.4; // 停下後再起步，第一步很快出現
    }
  }

  function unlock() {
    if (disposed || broken) return false;
    if (!ctx) {
      try {
        ctx = new AudioContextCtor();
        master = ctx.createGain();
        sfx = ctx.createGain();
        music = ctx.createGain();
        sfx.connect(master);
        music.connect(master);
        master.connect(ctx.destination);
        applyVolumes();
        nb = makeNoiseBuffers(ctx);
        // iOS：在手勢內播一個無聲 buffer 才會真正解鎖
        const b = ctx.createBufferSource();
        b.buffer = ctx.createBuffer(1, 1, ctx.sampleRate || 44100);
        b.connect(ctx.destination);
        b.start(0);
      } catch (err) {
        broken = true;
        ctx = null;
        console.info('[audio] 無法建立 AudioContext，音效停用');
        return false;
      }
    }
    if (ctx.state !== 'running' && typeof ctx.resume === 'function') {
      try {
        const p = ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (err) {
        // 忽略；下次手勢再試
      }
    }
    unlocked = true;
    return true;
  }

  // 事件訂閱（§15）
  const offs = [];
  const on = (name, fn) => {
    if (bus && typeof bus.on === 'function') offs.push(bus.on(name, (e) => fn(e || {})));
  };
  on('weapon:fire', (e) => play('gunshot', { x: e.x, z: e.z }));
  on('weapon:dryFire', () => play('dryfire'));
  on('weapon:reload', (e) => play('reload', { phase: e.phase }));
  on('weapon:impact', (e) => play('ricochet', { x: e.x, z: e.z, surface: e.surface, volume: IMPACT_VOLUME }));
  on('weapon:swing', (e) => play('bat_swing', { x: e.x, z: e.z, weapon: e.weapon }));
  on('combat:hit', (e) => {
    const name = e.weapon === 'bat' ? 'bat_hit' : 'punch';
    play(name, { x: e.x, z: e.z, volume: e.weapon === 'pistol' ? 0.5 : 1 });
  });
  on('vehicle:horn', (e) => play('horn', { x: e.x, z: e.z }));
  on('vehicle:crash', (e) => {
    const rel = Number.isFinite(e.relSpeed) ? e.relSpeed : 8;
    play('crash', { k: Math.min(1, Math.max(0.25, (rel - 4) / 20)) });
  });
  on('mission:complete', () => play('ui_reward'));
  on('mission:fail', () => play('ui_fail'));
  on('collect:checkin', () => play('ui_reward'));
  on('collect:food', () => play('ui_reward'));
  on('ui:sound', (e) => {
    if (UI_KINDS.includes(e.kind)) play('ui_' + e.kind);
  });

  function dispose() {
    if (disposed) return;
    for (const off of offs) {
      try {
        off();
      } catch (err) {
        // 忽略
      }
    }
    offs.length = 0;
    if (unsubSettings) unsubSettings();
    if (ctx) {
      const now = ctx.currentTime;
      for (const v of voices) {
        stopVoice(v, now);
        disconnect(v);
      }
      voices.length = 0;
      loops.engine = loops.tire = loops.ambience = null;
      try {
        const p = ctx.close && ctx.close();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (err) {
        // 忽略
      }
    }
    disposed = true;
  }

  return {
    unlock,
    update,
    play,
    // 契約欄位 voices / maxVoices / unlocked；另附除錯用 loops（持續音源數）、plays（累計一次性）、last（最後一個音效名）
    stats: () => ({
      voices: voices.length,
      maxVoices: MAX_VOICES,
      unlocked: running(),
      loops: (loops.engine ? 1 : 0) + (loops.tire ? 1 : 0) + (loops.ambience ? 1 : 0),
      plays: playCount,
      last: lastPlayed,
    }),
    dispose,
  };
}
