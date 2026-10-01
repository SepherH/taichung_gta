#!/usr/bin/env node
// 程序合成音效無頭驗證（契約 §15）：假 AudioContext 記錄建立的節點與 start / stop 呼叫
// 用法：node tools/test/audio.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：無 AudioContext 時 no-op、未解鎖不播、事件 → 對應音效、音源上限 12（持續音源算在內、停最舊一次性）、
//   音量設定傳到 GainNode（subscribe 即時）、遠距不播 / 衰減 / 聲像、腳步步頻、paused 靜音、持續音源開關、
//   dispose 後不再響應、建構失敗 no-op、weapon:impact 跳彈聲（world / vehicle、3D、上限）；效能：update() 1000 次平均 < 0.05 ms
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

// 本模組不碰 DOM；document 最小替身只為與其他測試一致
globalThis.document = { createElement: () => ({ style: {} }) };

const { createAudio, MAX_VOICES, MAX_DIST, SOUND_NAMES, distanceGain, panFor } = await import('../../src/audio/index.js');
const { createBus } = await import('../../src/core/events.js');
const { createSettings } = await import('../../src/core/settings.js');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ---- 假 AudioContext ----
class FakeParam {
  constructor(v = 0) {
    this.value = v;
    this.events = [];
    this.target = null;
  }
  setValueAtTime(v, t) { this.events.push(['set', v, t]); }
  linearRampToValueAtTime(v, t) { this.events.push(['lin', v, t]); }
  exponentialRampToValueAtTime(v, t) { this.events.push(['exp', v, t]); }
  setTargetAtTime(v, t, c) { this.target = v; this.events.push(['target', v, t, c]); }
  peak() {
    let m = 0;
    for (const e of this.events) if (e[0] === 'lin' && e[1] > m) m = e[1];
    return m;
  }
}
class FakeNode {
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind;
    this.outs = [];
    ctx.log.push(this);
  }
  connect(n) { this.outs.push(n); return n; }
  disconnect() { this.outs.length = 0; }
}
class FakeSource extends FakeNode {
  constructor(ctx, kind) {
    super(ctx, kind);
    this.started = null;
    this.stopped = null;
  }
  start(t = 0) { this.started = t; this.ctx.starts++; }
  stop(t = 0) { this.stopped = t; this.ctx.stops++; }
}
let lastCtx = null;
let ctxCount = 0;
class FakeAudioContext {
  constructor() {
    this.log = [];
    this.starts = 0;
    this.stops = 0;
    this.currentTime = 0;
    this.sampleRate = 8000;
    this.state = 'suspended';
    this.resumed = 0;
    this.closed = false;
    this.destination = { kind: 'destination' };
    lastCtx = this;
    ctxCount++;
  }
  resume() { this.resumed++; this.state = 'running'; return Promise.resolve(); }
  close() { this.closed = true; this.state = 'closed'; return Promise.resolve(); }
  createGain() { const n = new FakeNode(this, 'gain'); n.gain = new FakeParam(1); return n; }
  createBiquadFilter() {
    const n = new FakeNode(this, 'biquad');
    n.type = 'lowpass';
    n.frequency = new FakeParam(350);
    n.Q = new FakeParam(1);
    return n;
  }
  createOscillator() {
    const n = new FakeSource(this, 'osc');
    n.type = 'sine';
    n.frequency = new FakeParam(440);
    return n;
  }
  createBufferSource() { const n = new FakeSource(this, 'buffer'); n.buffer = null; n.loop = false; return n; }
  createStereoPanner() { const n = new FakeNode(this, 'panner'); n.pan = new FakeParam(0); return n; }
  createBuffer(ch, len, sr) {
    const data = new Float32Array(len);
    return { length: len, sampleRate: sr, duration: len / sr, getChannelData: () => data };
  }
}
class NoPannerContext extends FakeAudioContext {}
NoPannerContext.prototype.createStereoPanner = undefined;

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
function setup(Ctor = FakeAudioContext) {
  const bus = createBus();
  const settings = createSettings({ storage: memStorage() });
  const audio = createAudio({ bus, settings, AudioContextCtor: Ctor });
  return { bus, settings, audio };
}
const walkState = (o = {}) => ({
  x: 0, z: 0, yaw: 0, driving: false, speedKmh: 0, rpm01: 0, throttle: 0, skid01: 0,
  walkSpeed: 0, grounded: true, nearJunction: null, paused: false, ...o,
});
// 以 play 的 opts 無法從外部取得音效名，改用 stats().last / plays 判斷
const lastName = (a) => a.stats().last;
const plays = (a) => a.stats().plays;
// 找群組增益：master → destination；sfx / music → master
function groups(ctx) {
  const gains = ctx.log.filter((n) => n.kind === 'gain');
  const master = gains.find((g) => g.outs.includes(ctx.destination));
  const kids = gains.filter((g) => g.outs.includes(master));
  return { master, sfx: kids[0], music: kids[1] };
}

// ---- 1. 無 AudioContext（node）→ no-op ----
{
  let ons = 0;
  const fakeBus = { on: () => { ons++; return () => {}; } };
  let threw = null;
  let a = null;
  try {
    a = createAudio({ bus: fakeBus, settings: createSettings({ storage: memStorage() }), AudioContextCtor: undefined });
    a.update(1 / 60, walkState({ walkSpeed: 5 }));
    a.play('gunshot');
    a.unlock();
    a.dispose();
  } catch (err) {
    threw = err;
  }
  check('無 AudioContext：整個模組 no-op、不丟例外、不訂閱事件', !threw && ons === 0 && a.unlock() === false && a.play('gunshot') === false
    && a.stats().voices === 0 && a.stats().maxVoices === 12 && a.stats().unlocked === false, threw ? String(threw) : `on ×${ons}`);
}

// ---- 2. 建構失敗 → no-op ----
{
  const info = console.info;
  let infos = 0;
  console.info = () => { infos++; };
  class Throwing { constructor() { throw new Error('blocked'); } }
  const { bus, audio } = setup(Throwing);
  let threw = null;
  try {
    audio.unlock();
    bus.emit('weapon:fire', { x: 0, z: 0 });
    audio.update(1 / 60, walkState());
  } catch (err) {
    threw = err;
  }
  console.info = info;
  check('AudioContext 建構丟例外：unlock 回 false、之後 no-op、只 console.info 一次', !threw && audio.unlock() === false && infos === 1 && audio.stats().unlocked === false);
}

// ---- 3. 未解鎖不播 ----
{
  ctxCount = 0;
  const { bus, audio } = setup();
  bus.emit('weapon:fire', { x: 0, z: 0 });
  bus.emit('ui:sound', { kind: 'click' });
  const r = audio.play('gunshot');
  audio.update(1 / 60, walkState({ driving: true, rpm01: 0.5 }));
  check('未解鎖：play 靜默略過、不建 AudioContext、無持續音源', r === false && ctxCount === 0 && audio.stats().voices === 0);
  audio.unlock();
  check('unlock：建立 AudioContext 並 resume、stats.unlocked', ctxCount === 1 && lastCtx.resumed === 1 && audio.stats().unlocked === true);
  const noise = lastCtx.log.filter((n) => n.kind === 'buffer');
  audio.unlock();
  check('重複 unlock 不重建 context / 噪聲 buffer', ctxCount === 1 && lastCtx.log.filter((n) => n.kind === 'buffer').length === noise.length);
  audio.dispose();
}

// ---- 4. 事件 → 對應音效 ----
{
  const { bus, audio } = setup();
  audio.unlock();
  audio.update(1 / 60, walkState());
  const cases = [
    ['weapon:fire', { weapon: 'pistol', x: 1, y: 1, z: 1, dirX: 0, dirY: 0, dirZ: 1, byPlayer: true, hit: false }, 'gunshot'],
    ['weapon:dryFire', { weapon: 'pistol' }, 'dryfire'],
    ['weapon:reload', { weapon: 'pistol', phase: 'start', mag: 0, reserve: 36 }, 'reload'],
    ['weapon:reload', { weapon: 'pistol', phase: 'end', mag: 12, reserve: 24 }, 'reload'],
    ['weapon:swing', { weapon: 'bat', x: 0, y: 1, z: 0, byPlayer: true }, 'bat_swing'],
    ['weapon:swing', { weapon: 'fist', x: 0, y: 1, z: 0, byPlayer: true }, 'bat_swing'],
    ['combat:hit', { weapon: 'bat', x: 2, y: 1, z: 0 }, 'bat_hit'],
    ['combat:hit', { weapon: 'fist', x: 2, y: 1, z: 0 }, 'punch'],
    ['combat:hit', { weapon: 'pistol', x: 2, y: 1, z: 0 }, 'punch'],
    ['vehicle:horn', { x: 5, z: 5, dirX: 0, dirZ: 1 }, 'horn'],
    ['vehicle:crash', { relSpeed: 12 }, 'crash'],
    ['mission:complete', { id: 'a', reward: 500 }, 'ui_reward'],
    ['mission:fail', { id: 'a', reason: 'timeout' }, 'ui_fail'],
    ['collect:checkin', { landmarkId: 1, slug: 'x', name: 'x', reward: 200 }, 'ui_reward'],
    ['collect:food', { id: 'f', name: 'f', total: 10, found: 1 }, 'ui_reward'],
  ];
  for (const k of ['click', 'confirm', 'cancel', 'reward', 'fail', 'open', 'close']) cases.push(['ui:sound', { kind: k }, 'ui_' + k]);
  const bad = [];
  for (const [ev, payload, want] of cases) {
    lastCtx.currentTime += 2; // 讓前一個播完
    const n0 = plays(audio);
    const s0 = lastCtx.starts;
    bus.emit(ev, payload);
    if (plays(audio) !== n0 + 1 || lastName(audio) !== want || lastCtx.starts <= s0) bad.push(`${ev}→${lastName(audio)}`);
  }
  check(`事件 → 對應音效（${cases.length} 種，每個都有 start 音源節點）`, bad.length === 0, bad.join(', '));
  const n0 = plays(audio);
  bus.emit('ui:sound', { kind: 'bogus' });
  bus.emit('ui:sound', null);
  bus.emit('weapon:fire', undefined);
  check('未知 ui kind 略過、payload 缺漏不丟例外', plays(audio) === n0 + 1);
  check(`SOUND_NAMES 含全部 §15 一次性音效（${SOUND_NAMES.length}）`,
    ['gunshot', 'dryfire', 'reload', 'bat_hit', 'bat_swing', 'punch', 'footstep', 'crash', 'horn'].every((n) => SOUND_NAMES.includes(n))
    && SOUND_NAMES.filter((n) => n.startsWith('ui_')).length === 7);
  // 碰撞力道 → 音量
  const peakOf = (fn) => {
    lastCtx.currentTime += 2;
    const i0 = lastCtx.log.length;
    fn();
    let m = 0;
    for (const n of lastCtx.log.slice(i0)) if (n.kind === 'gain') m = Math.max(m, n.gain.peak());
    return m;
  };
  const soft = peakOf(() => bus.emit('vehicle:crash', { relSpeed: 8 }));
  const hard = peakOf(() => bus.emit('vehicle:crash', { relSpeed: 30 }));
  check('碰撞音量依 relSpeed（8 m/s < 30 m/s）', soft > 0 && hard > soft * 2, `${soft.toFixed(2)} / ${hard.toFixed(2)}`);
  const walk = peakOf(() => audio.play('footstep', { run: false }));
  const run = peakOf(() => audio.play('footstep', { run: true }));
  check('腳步：跑步比走路響', run > walk, `${walk.toFixed(2)} / ${run.toFixed(2)}`);
  // 喇叭 = 兩個方波
  lastCtx.currentTime += 2;
  const i0 = lastCtx.log.length;
  bus.emit('vehicle:horn', { x: 0, z: 0 });
  const sq = lastCtx.log.slice(i0).filter((n) => n.kind === 'osc' && n.type === 'square');
  check('喇叭：兩個方波和弦', sq.length === 2 && sq[0].frequency.value !== sq[1].frequency.value);
  audio.dispose();
}

// ---- 5. 音源上限 12 ----
{
  const { audio } = setup();
  audio.unlock();
  audio.update(1 / 60, walkState({ driving: true, rpm01: 0.3, skid01: 0.8, nearJunction: 20 }));
  const loopsOn = audio.stats().voices;
  const ctx = lastCtx;
  const firstSources = [];
  const i0 = ctx.log.length;
  audio.play('gunshot');
  for (const n of ctx.log.slice(i0)) if (n.kind === 'osc' || n.kind === 'buffer') firstSources.push(n);
  let maxSeen = 0;
  for (let i = 0; i < 30; i++) {
    audio.play(i % 2 ? 'gunshot' : 'crash');
    maxSeen = Math.max(maxSeen, audio.stats().voices);
  }
  const loopNodes = ctx.log.slice(0, i0).filter((n) => n.kind === 'osc' || (n.kind === 'buffer' && n.loop));
  check(`持續音源（引擎 / 輪胎 / 聲景）算在音源池內（${loopsOn} 個）`, loopsOn === 3);
  check(`同時音源 ≤ ${MAX_VOICES}（連發 31 個一次性音效，最大 ${maxSeen}）`, maxSeen === MAX_VOICES && MAX_VOICES === 12);
  check('超過上限停掉最舊的一次性音源（第一發的音源節點被 stop）', firstSources.length > 0 && firstSources.every((n) => n.stopped !== null && n.stopped < ctx.currentTime + 0.1));
  check('持續音源不被一次性音效擠掉', loopNodes.every((n) => n.stopped === null) && audio.stats().loops === 3, `loops ${audio.stats().loops}`);
  ctx.currentTime += 3;
  audio.update(1 / 60, walkState({ driving: true, rpm01: 0.3, skid01: 0.8, nearJunction: 20 }));
  check('播完的一次性音源自動回收', audio.stats().voices === 3);
  audio.dispose();
}

// ---- 6. 音量設定傳到 GainNode ----
{
  const { audio, settings } = setup();
  settings.set('volumeMaster', 0.5);
  audio.unlock();
  const g = groups(lastCtx);
  check('解鎖時套用目前音量（master 0.5 / music 0.6 / sfx 0.9）', g.master && g.master.gain.value === 0.5 && g.sfx.gain.value === 0.9 && g.music.gain.value === 0.6);
  settings.set('volumeSfx', 0.3);
  settings.set('volumeMusic', 0.1);
  settings.set('volumeMaster', 1);
  check('settings.subscribe 即時生效（sfx 0.3 / music 0.1 / master 1）', g.sfx.gain.value === 0.3 && g.music.gain.value === 0.1 && g.master.gain.value === 1);
  // 一次性 → sfx 群組；聲景 → music 群組；引擎 → sfx
  audio.update(1 / 60, walkState({ driving: true, nearJunction: 10 }));
  const loopsOut = lastCtx.log.filter((n) => n.kind === 'gain' && (n.outs.includes(g.music)));
  check('路口聲景走 music 群組（master × music）', loopsOut.length === 1);
  const i0 = lastCtx.log.length;
  audio.play('ui_click');
  const out = lastCtx.log.slice(i0).find((n) => n.kind === 'gain' && n.outs.includes(g.sfx));
  check('一次性音效走 sfx 群組（master × sfx）', !!out);
  audio.dispose();
}

// ---- 7. 3D：遠距不播、衰減、聲像 ----
{
  const { audio } = setup();
  audio.unlock();
  audio.update(1 / 60, walkState({ x: 100, z: 100, yaw: 0 }));
  const far = audio.play('gunshot', { x: 100, z: 100 + MAX_DIST + 1 });
  check(`> ${MAX_DIST} m 不播`, far === false && audio.stats().voices === 0);
  const i0 = lastCtx.log.length;
  const near = audio.play('gunshot', { x: 80, z: 100 }); // 左右：yaw 0 前方 +z，右方 −x
  const nodes = lastCtx.log.slice(i0);
  const pan = nodes.find((n) => n.kind === 'panner');
  const outG = nodes.find((n) => n.kind === 'gain' && n.outs.includes(pan));
  check('20 m 外播放：衰減 < 1、在右方 → pan > 0', near === true && pan && pan.pan.value > 0.5 && outG && outG.gain.value < 0.7 && outG.gain.value > 0.1,
    pan ? `pan ${pan.pan.value.toFixed(2)} gain ${outG.gain.value.toFixed(2)}` : '無 panner');
  check('panFor：左方 < 0、正前方 0；distanceGain 單調遞減', panFor(1, 0, 0) < 0 && Math.abs(panFor(0, 5, 0)) < 1e-9 && panFor(-5 * Math.cos(1), 5 * Math.sin(1), 1) > 0.8
    && distanceGain(0) === 1 && distanceGain(10) > distanceGain(30) && distanceGain(30) > distanceGain(59) && distanceGain(61) === 0);
  audio.dispose();
  // 無 StereoPanner 也能播
  const s2 = setup(NoPannerContext);
  s2.audio.unlock();
  s2.audio.update(1 / 60, walkState());
  check('瀏覽器缺 StereoPannerNode 時照播（不聲像）', s2.audio.play('gunshot', { x: 10, z: 0 }) === true);
  s2.audio.dispose();
}

// ---- 8. 腳步步頻 / paused 靜音 / 持續音源開關 ----
{
  const { audio } = setup();
  audio.unlock();
  const ctx = lastCtx;
  const countSteps = (st, sec) => {
    let n = 0;
    for (let i = 0; i < sec * 60; i++) {
      const p0 = plays(audio);
      ctx.currentTime += 1 / 60;
      audio.update(1 / 60, st);
      if (plays(audio) > p0 && lastName(audio) === 'footstep') n++;
    }
    return n;
  };
  const w = countSteps(walkState({ walkSpeed: 1.4 }), 10);
  const r = countSteps(walkState({ walkSpeed: 6 }), 10);
  check('腳步依 walkSpeed：走 1.4 m/s 約 1.6–2.4 步/s、跑 6 m/s 約 2.6–3.8 步/s', w >= 16 && w <= 24 && r >= 26 && r <= 38, `走 ${w} / 跑 ${r}（10 s）`);
  const air = countSteps(walkState({ walkSpeed: 6, grounded: false }), 2);
  const drv = countSteps(walkState({ walkSpeed: 6, driving: true }), 2);
  const pz = countSteps(walkState({ walkSpeed: 6, paused: true }), 2);
  check('騰空 / 駕駛 / paused 不發腳步聲', air === 0 && drv === 0 && pz === 0, `${air}/${drv}/${pz}`);

  // 持續音源
  const engineGain = () => {
    const saw = ctx.log.filter((n) => n.kind === 'osc' && n.type === 'sawtooth').pop();
    // saw → lowpass → gain
    return saw.outs[0].outs[0];
  };
  audio.update(1 / 60, walkState({ driving: true, rpm01: 0.2, throttle: 0.2 }));
  const saw = ctx.log.filter((n) => n.kind === 'osc' && n.type === 'sawtooth').pop();
  const fLow = saw.frequency.target;
  audio.update(1 / 60, walkState({ driving: true, rpm01: 0.9, throttle: 1 }));
  const fHigh = saw.frequency.target;
  const gOn = engineGain().gain.target;
  audio.update(1 / 60, walkState({ driving: true, rpm01: 0.9, throttle: 1, paused: true }));
  const gPaused = engineGain().gain.target;
  check('引擎：rpm01 → 頻率上升；paused 時增益目標 0', fHigh > fLow && gOn > 0 && gPaused === 0, `${fLow.toFixed(0)}→${fHigh.toFixed(0)} Hz`);
  audio.update(1 / 60, walkState({ driving: false }));
  check('下車後引擎停止（stop 排程、釋放音源池）', saw.stopped !== null && audio.stats().loops === 0);
  audio.update(1 / 60, walkState({ driving: true, rpm01: 0.5, twoWheeler: true }));
  const bikeSaw = ctx.log.filter((n) => n.kind === 'osc' && n.type === 'sawtooth').pop();
  audio.update(1 / 60, walkState({ driving: false }));
  audio.update(1 / 60, walkState({ driving: true, rpm01: 0.5 }));
  const carSaw = ctx.log.filter((n) => n.kind === 'osc' && n.type === 'sawtooth').pop();
  check('機車引擎音高高於汽車（同 rpm01）', bikeSaw !== carSaw && bikeSaw.frequency.target > carSaw.frequency.target * 1.3,
    `${bikeSaw.frequency.target.toFixed(0)} / ${carSaw.frequency.target.toFixed(0)} Hz`);
  // 輪胎
  audio.update(1 / 60, walkState({ driving: true, skid01: 0.8 }));
  const tireOn = audio.stats().loops === 2;
  for (let i = 0; i < 40; i++) audio.update(1 / 60, walkState({ driving: true, skid01: 0 }));
  check('輪胎：skid01 > 門檻開、回落 0.4 s 後關', tireOn && audio.stats().loops === 1);
  // 聲景：遲滯
  audio.update(1 / 60, walkState({ nearJunction: 50 }));
  const ambOn = audio.stats().loops;
  audio.update(1 / 60, walkState({ nearJunction: 65 }));
  const ambHold = audio.stats().loops;
  audio.update(1 / 60, walkState({ nearJunction: 30, paused: true }));
  const ambG = ctx.log.filter((n) => n.kind === 'gain' && n.outs.includes(groups(ctx).music)).pop().gain.target;
  audio.update(1 / 60, walkState({ nearJunction: null }));
  check('路口聲景：< 60 m 開、60–70 m 維持、null 關；paused 增益 0', ambOn === 1 && ambHold === 1 && ambG === 0 && audio.stats().loops === 0);
  audio.dispose();
}

// ---- 9. dispose ----
{
  const { bus, audio, settings } = setup();
  audio.unlock();
  const ctx = lastCtx;
  audio.update(1 / 60, walkState({ driving: true }));
  const g = groups(ctx);
  audio.dispose();
  const s0 = ctx.starts;
  const n0 = ctx.log.length;
  bus.emit('weapon:fire', { x: 0, z: 0 });
  bus.emit('ui:sound', { kind: 'click' });
  audio.update(1 / 60, walkState({ walkSpeed: 5, driving: true }));
  settings.set('volumeSfx', 0.2);
  check('dispose 後不再響應事件 / update / 設定，context 關閉', ctx.starts === s0 && ctx.log.length === n0 && g.sfx.gain.value === 0.9 && ctx.closed && audio.play('gunshot') === false && audio.unlock() === false);
}

// ---- 9b. weapon:impact 跳彈 / 擊中聲 ----
{
  const { bus, settings, audio } = setup();
  audio.unlock();
  audio.update(1 / 60, walkState());
  const ctx = lastCtx;
  const g = groups(ctx);
  const emitImpact = (surface, x = 3, z = 4) => {
    ctx.currentTime += 2;
    const i0 = ctx.log.length;
    const n0 = plays(audio);
    bus.emit('weapon:impact', { x, y: 1, z, nx: 0, ny: 1, nz: 0, surface });
    return { nodes: ctx.log.slice(i0), added: plays(audio) - n0 };
  };
  const w = emitImpact('world');
  const v = emitImpact('vehicle');
  check('weapon:impact（world / vehicle）→ ricochet，plays 各 +1、有 start 音源', w.added === 1 && v.added === 1 && lastName(audio) === 'ricochet'
    && w.nodes.some((n) => n.started !== undefined && n.started !== null) && v.nodes.some((n) => n.started !== undefined && n.started !== null)
    && SOUND_NAMES.includes('ricochet'));
  const wOsc = w.nodes.filter((n) => n.kind === 'osc');
  const vOsc = v.nodes.filter((n) => n.kind === 'osc');
  const glides = (n) => n.frequency.events.some((e) => e[0] === 'exp' && e[1] < n.frequency.events[0][1]);
  check('world = 石面「啾」（下滑音）、vehicle = 金屬「鏘」（兩個非諧和三角波、不滑音）',
    wOsc.length === 1 && glides(wOsc[0]) && vOsc.length === 2 && vOsc.every((n) => n.type === 'triangle' && !glides(n))
    && Math.abs(vOsc[1].frequency.events[0][1] / vOsc[0].frequency.events[0][1] - 1.5) > 0.02);
  const out = v.nodes.find((n) => n.kind === 'gain' && (n.outs.includes(g.sfx) || n.outs.some((o) => o.kind === 'panner' && o.outs.includes(g.sfx))));
  const pan = v.nodes.find((n) => n.kind === 'panner');
  check('擊中聲走 sfx 群組、3D 衰減 + 聲像（5 m 外左前方 → pan < 0）', !!out && out.gain.value > 0 && out.gain.value < 1 && !!pan && pan.pan.value < 0,
    out ? `gain ${out.gain.value.toFixed(2)} pan ${pan ? pan.pan.value.toFixed(2) : '-'}` : '找不到輸出增益');
  const far = emitImpact('world', 0, MAX_DIST + 5);
  check(`擊中點 > ${MAX_DIST} m 不播`, far.added === 0 && far.nodes.length === 0);
  const odd = emitImpact(undefined);
  check('surface 缺漏 → 當 world 播、不丟例外', odd.added === 1 && odd.nodes.filter((n) => n.kind === 'osc').length === 1);
  // 爆量：同一瞬間 40 發擊中（加上持續音源）不超過音源上限
  audio.update(1 / 60, walkState({ driving: true, rpm01: 0.3, nearJunction: 20 }));
  ctx.currentTime += 2;
  let maxSeen = 0;
  const n0 = plays(audio);
  for (let i = 0; i < 40; i++) {
    bus.emit('weapon:impact', { x: i % 5, y: 0, z: 2, nx: 0, ny: 1, nz: 0, surface: i % 2 ? 'vehicle' : 'world' });
    maxSeen = Math.max(maxSeen, audio.stats().voices);
  }
  check(`連續 40 發擊中：音源 ≤ ${MAX_VOICES}（最大 ${maxSeen}）、持續音源保留`, maxSeen === MAX_VOICES && audio.stats().loops === 2 && plays(audio) - n0 === 40);
  settings.set('volumeSfx', 0);
  check('sfx 音量 0 → 擊中聲經 sfx 群組靜音', g.sfx.gain.value === 0);
  audio.dispose();
}

// ---- 10. 效能：update() 每幀耗時 ----
{
  const { audio } = setup();
  audio.unlock();
  const ctx = lastCtx;
  const drive = walkState({ driving: true, rpm01: 0.4, throttle: 0.6, skid01: 0.3, nearJunction: 25 });
  const walk = walkState({ walkSpeed: 1.4 });
  for (let i = 0; i < 200; i++) audio.update(1 / 60, i % 2 ? drive : walk); // 暖機
  audio.update(1 / 60, drive);
  let t0 = performance.now();
  for (let i = 0; i < 1000; i++) {
    ctx.currentTime += 1 / 60;
    drive.rpm01 = 0.3 + 0.4 * Math.sin(i * 0.05);
    drive.throttle = 0.5 + 0.5 * Math.sin(i * 0.03);
    drive.skid01 = 0.2 + 0.2 * Math.sin(i * 0.07);
    audio.update(1 / 60, drive);
  }
  const dDrive = (performance.now() - t0) / 1000;
  t0 = performance.now();
  for (let i = 0; i < 1000; i++) {
    ctx.currentTime += 1 / 60;
    audio.update(1 / 60, walk);
  }
  const dWalk = (performance.now() - t0) / 1000;
  check('update() 1000 次平均 < 0.05 ms（駕駛 + 三個持續音源 / 步行含腳步觸發）', dDrive < 0.05 && dWalk < 0.05, `駕駛 ${dDrive.toFixed(4)} ms、步行 ${dWalk.toFixed(4)} ms`);
  audio.dispose();
}

console.log(`\naudio.mjs：${passed} 通過 / ${failed} 失敗`);
console.log(failed ? `FAIL ${failed}/${passed + failed}` : `PASS ${passed}/${passed}`);
process.exit(failed ? 1 : 0);
