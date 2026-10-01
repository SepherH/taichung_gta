#!/usr/bin/env node
// 車上電台無頭驗證（src/audio/radio.js + core/actions.js 的 radioNext 分流）：假 AudioContext 記錄節點與 start / stop
// 用法：node tools/test/radio.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：上車才播 / 下車淡出停止、換台循環含關閉、台名、上車恢復上次的台、未解鎖不建節點、音量跟隨設定、
//   lookahead 排程（只排到 now + LOOKAHEAD、卡頓不補播）、停止後無殘留排程 / 節點、dispose、
//   actions：Q 在車上 → radioNext、步行時 Q 仍是 weaponCycle、ACTIONS 未新增（19 個、無重複鍵）

const { createRadio, STATIONS, LOOKAHEAD, FADE_OUT, noteToMidi } = await import('../../src/audio/radio.js');
const { createSettings } = await import('../../src/core/settings.js');
const { ACTIONS, CONTEXT_ACTIONS, createActionReader, actionForKey, actionActiveIn } = await import('../../src/core/actions.js');

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
  cancelScheduledValues(t) { this.events.push(['cancel', t]); }
}
class FakeNode {
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind;
    this.outs = [];
    this.connected = false;
    ctx.log.push(this);
  }
  connect(n) { this.outs.push(n); this.connected = true; return n; }
  disconnect() { this.outs.length = 0; this.connected = false; }
}
class FakeSource extends FakeNode {
  constructor(ctx, kind) {
    super(ctx, kind);
    this.started = null;
    this.stopped = null;
  }
  start(t = 0) { this.started = t; }
  stop(t = 0) { this.stopped = this.stopped === null ? t : Math.min(this.stopped, t); }
}
class FakeAudioContext {
  constructor() {
    this.log = [];
    this.currentTime = 0;
    this.sampleRate = 8000;
    this.state = 'running';
    this.destination = { kind: 'destination' };
  }
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
  createBufferSource() { const n = new FakeSource(this, 'buffer'); n.buffer = null; return n; }
  createBuffer(ch, len, sr) {
    const data = new Float32Array(len);
    return { length: len, sampleRate: sr, duration: len / sr, getChannelData: () => data };
  }
}
const sources = (ctx) => ctx.log.filter((n) => n instanceof FakeSource);
function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

// 模擬：音訊解鎖前 getAudio 回 null；master 為 audio 的輸出增益
function setup() {
  const ctx = new FakeAudioContext();
  const master = ctx.createGain();
  const settings = createSettings({ storage: memStorage() });
  const env = { unlocked: false };
  const radio = createRadio({
    getAudio: () => (env.unlocked ? { ctx, out: master } : null),
    getMusicVolume: () => settings.get('volumeMusic'),
  });
  // 以 60 fps 推進 sec 秒
  const run = (sec, state) => {
    const n = Math.round(sec * 60);
    for (let i = 0; i < n; i++) {
      ctx.currentTime += 1 / 60;
      radio.update(1 / 60, state);
    }
  };
  return { ctx, master, settings, env, radio, run };
}
const CAR = { inVehicle: true };
const WALK = { inVehicle: false };

// ---- 1. 台名 / 曲譜 ----
{
  const { radio } = setup();
  const s = radio.getState();
  check('台名：2–3 台、皆為繁中自創名', s.stations.length >= 2 && s.stations.length <= 3 && s.stations.every((n) => /[一-鿿]/.test(n) && /(FM|AM) \d/.test(n)), s.stations.join(' / '));
  check('台名：初始選第 1 台、未出聲', s.on && s.index === 0 && s.name === STATIONS[0].name && !s.playing);
  check('曲譜：每台標註旋律來源為自製', STATIONS.every((st) => typeof st.source === 'string' && st.source.startsWith('自製')));
  check('曲譜：音名解析（A4 = 69、C#5 = 73、Bb3 = 58）', noteToMidi('A4') === 69 && noteToMidi('C#5') === 73 && noteToMidi('Bb3') === 58);
}

// ---- 2. 未解鎖不建節點 ----
{
  const { ctx, radio, env, run } = setup();
  const base = ctx.log.length; // master
  run(1, CAR);
  check('未解鎖：在車上 update 也不建任何節點', ctx.log.length === base && radio.stats().bound === false, `節點 ${ctx.log.length - base}`);
  ctx.state = 'suspended';
  env.unlocked = true;
  run(0.5, CAR);
  check('context 未 running（suspended）：仍不建節點', ctx.log.length === base);
  ctx.state = 'running';
  run(0.5, CAR);
  check('解鎖後才開始播', ctx.log.length > base && radio.getState().playing && sources(ctx).length > 0);
}

// ---- 3. 上車才播 / 下車停 ----
{
  const { ctx, radio, env, run } = setup();
  env.unlocked = true;
  run(1, WALK);
  check('步行：不播、不建節點', !radio.getState().playing && sources(ctx).length === 0);
  run(2, CAR);
  const st = radio.stats();
  check('上車：開始播、有排程音源', radio.getState().playing && st.players === 1 && st.sources > 0, JSON.stringify(st));
  const now = ctx.currentTime;
  const late = sources(ctx).filter((s) => s.started > now + LOOKAHEAD + 0.05);
  check(`lookahead：音符只排到 now + ${LOOKAHEAD}s 內`, late.length === 0, `超前 ${late.length}`);
  run(0.1, WALK);
  check('下車：進入淡出（仍保留到淡出結束）', !radio.getState().playing && radio.stats().fading === 1);
  const cut = ctx.currentTime - 1 / 60 + FADE_OUT + 1e-6;
  const leak = sources(ctx).filter((s) => s.stopped === null || s.stopped > cut);
  check('下車：所有已排音源的 stop 時間 ≤ 淡出結束', leak.length === 0, `殘留 ${leak.length}`);
  run(FADE_OUT + 0.3, WALK);
  const s2 = radio.stats();
  check('淡出後：無 player / 無排程音源 / 無節點', s2.players === 0 && s2.sources === 0 && s2.nodes === 0, JSON.stringify(s2));
  const live = ctx.log.filter((n) => n.connected && n !== ctx.log[0] && n.outs.length > 0 && n.kind !== 'gain');
  const count = sources(ctx).length;
  run(3, WALK);
  check('淡出後：不再建立任何音源', sources(ctx).length === count);
  check('淡出後：音源 / 濾波節點全部斷開', live.length === 0, `仍連線 ${live.length}`);
  check('下車後選台保留（上車恢復）', radio.getState().on && radio.getState().index === 0);
}

// ---- 4. 換台循環含關閉、上車恢復上次的台 ----
{
  const { ctx, radio, env, run } = setup();
  env.unlocked = true;
  run(1, CAR);
  const n = STATIONS.length;
  const seq = [radio.getState().index];
  for (let i = 0; i < n + 1; i++) {
    radio.next();
    run(0.2, CAR);
    seq.push(radio.getState().index);
  }
  const expect = [...Array(n).keys(), null, 0];
  check('換台循環：第 1 台 → … → 關閉 → 第 1 台', JSON.stringify(seq) === JSON.stringify(expect), JSON.stringify(seq));
  radio.setStation(null);
  run(0.1, CAR);
  check('關閉：name =「關閉」、on = false、不出聲', radio.getState().name === '關閉' && !radio.getState().on && !radio.getState().playing);
  run(FADE_OUT + 0.3, CAR);
  check('關閉後淡出完：無殘留', radio.stats().players === 0 && radio.stats().sources === 0);
  radio.setStation(n - 1);
  run(0.5, CAR);
  check('setStation(i)：台名對應', radio.getState().name === STATIONS[n - 1].name && radio.getState().playing);
  radio.setStation(99);
  radio.setStation(-1);
  radio.setStation(1.5);
  check('setStation 非法索引忽略', radio.getState().index === n - 1);
  run(0.5, WALK);
  run(1, WALK);
  run(0.5, CAR);
  check('上車恢復上次的台', radio.getState().index === n - 1 && radio.getState().playing);
  radio.setStation(0);
  run(FADE_OUT + 0.3, CAR);
  radio.next();
  run(0.1, CAR);
  check('切台交叉淡變：舊台淡出、新台淡入同時存在', radio.stats().fading === 1 && radio.stats().players === 2);
  run(FADE_OUT + 0.3, CAR);
  check('切台後舊台清除', radio.stats().fading === 0 && radio.stats().players === 1 && radio.getState().index === 1);
  void ctx;
}

// ---- 5. 音量跟隨設定 ----
{
  const { ctx, master, settings, radio, env, run } = setup();
  settings.set('volumeMusic', 0.4);
  env.unlocked = true;
  run(0.2, CAR);
  const vol = ctx.log.find((g) => g.kind === 'gain' && g.outs.includes(master));
  check('音量：初值 = volumeMusic', !!vol && Math.abs(vol.gain.value - 0.4) < 1e-9);
  settings.set('volumeMusic', 0.1);
  run(0.1, CAR);
  check('音量：設定變更即時跟隨（setTarget）', vol.gain.target === 0.1);
  settings.set('volumeMusic', 0);
  run(0.1, CAR);
  check('音量：0 → 靜音', vol.gain.target === 0);
  check('輸出接到注入的輸出節點（非 destination）', vol.outs.includes(master) && !vol.outs.includes(ctx.destination));
  void radio;
}

// ---- 6. 卡頓不補播、暫停 ----
{
  const { ctx, radio, env, run } = setup();
  env.unlocked = true;
  run(0.5, CAR);
  const before = sources(ctx).length;
  ctx.currentTime += 5; // 分頁背景 5 s
  radio.update(5, CAR);
  const added = sources(ctx).filter((s, i) => i >= before);
  const old = added.filter((s) => s.started < ctx.currentTime);
  check('卡頓：跳到現在，不補排過去的音符', old.length === 0 && added.length < 60, `新增 ${added.length}、過去 ${old.length}`);
  run(0.1, { inVehicle: true, paused: true });
  check('暫停：淡出', !radio.getState().playing && radio.stats().fading === 1);
}

// ---- 7. dispose ----
{
  const { ctx, radio, env, run } = setup();
  env.unlocked = true;
  run(1, CAR);
  radio.dispose();
  const t = ctx.currentTime;
  const bad = sources(ctx).filter((s) => s.stopped === null || s.stopped > t + 1e-9 || s.connected);
  check('dispose：所有音源立即停止並斷開', bad.length === 0, `殘留 ${bad.length}`);
  const count = ctx.log.length;
  run(1, CAR);
  radio.next();
  check('dispose 後 update / next 為 no-op', ctx.log.length === count && radio.stats().players === 0);
}

// ---- 8. actions：Q 分流 ----
{
  const names = Object.keys(ACTIONS);
  check('actions：ACTIONS 維持 19 個、無 radio / radioNext（不影響既有表）', names.length === 19 && !names.includes('radioNext') && !names.includes('radio'));
  check('actions：CONTEXT_ACTIONS.radioNext = KeyQ、僅駕駛', CONTEXT_ACTIONS.radioNext.keys.join() === 'KeyQ' && CONTEXT_ACTIONS.radioNext.mode === 'vehicle');
  check('actions：Q 在車上 → radioNext', actionForKey('KeyQ', 'vehicle') === 'radioNext');
  check('actions：步行時 Q 仍是 weaponCycle', actionForKey('KeyQ', 'walk') === 'weaponCycle');
  check('actions：weaponCycle 只在步行有效、radioNext 只在駕駛有效', actionActiveIn('weaponCycle', 'walk') && !actionActiveIn('weaponCycle', 'vehicle') && actionActiveIn('radioNext', 'vehicle') && !actionActiveIn('radioNext', 'walk'));
  check('actions：其他鍵不受模式影響（H → horn、F → enterExit）', actionForKey('KeyH', 'walk') === 'horn' && actionForKey('KeyF', 'vehicle') === 'enterExit' && actionForKey('KeyZ', 'walk') === null);
  const pressed = new Set(['KeyQ']);
  const r = createActionReader({ down: () => false, wasPressed: (c) => pressed.has(c) });
  check('reader：按 Q 時 pressedIn(radioNext, vehicle) 真、pressedIn(radioNext, walk) 假', r.pressedIn('radioNext', 'vehicle') && !r.pressedIn('radioNext', 'walk'));
  check('reader：按 Q 時 pressedIn(weaponCycle, walk) 真、pressedIn(weaponCycle, vehicle) 假', r.pressedIn('weaponCycle', 'walk') && !r.pressedIn('weaponCycle', 'vehicle'));
  check('reader：既有 pressed(weaponCycle) 行為不變', r.pressed('weaponCycle') && r.pressed('fly') === false);
  // Q 一次按下：車上只換台、步行只換武器（模擬整合層分流）
  const radioCalls = [];
  const weaponCalls = [];
  for (const mode of ['vehicle', 'walk']) {
    if (r.pressedIn('radioNext', mode)) radioCalls.push(mode);
    if (r.pressedIn('weaponCycle', mode)) weaponCalls.push(mode);
  }
  check('分流：Q 在車上只觸發換台、步行只觸發換武器', radioCalls.join() === 'vehicle' && weaponCalls.join() === 'walk');
}

console.log(failed === 0 ? `PASS ${passed}/${passed + failed}` : `FAIL ${failed}/${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
