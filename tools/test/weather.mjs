#!/usr/bin/env node
// 天氣 / 環境參數 / 雨聲無頭驗證（p5-s1）：不 import three（注入假 THREE / scene / camera / AudioContext）
// 用法：node tools/test/weather.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：三態切換、過場插值單調且收斂、instant 切換、過場中途改向不跳變、自動切換、simDt 暫停凍結、
//   low 檔粒子降級、粒子跟隨相機、環境合成（霧天霧距短、雨天光暗、視距夾霧）、getState 欄位、雨聲音量隨 rain

const { createWeather, RAIN_COUNT, rainParticleCount, smooth01 } = await import('../../src/weather.js');
const { createEnvironment, fogRange } = await import('../../src/environment.js');
const { LOOPS, rainLevel } = await import('../../src/audio/voices.js');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// 可重現的亂數
function lcg(seed = 7) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// ---- 假 THREE ----
class FakeAttr {
  constructor(array, itemSize) {
    this.array = array;
    this.itemSize = itemSize;
    this.needsUpdate = false;
    this.usage = null;
  }
  setUsage(u) {
    this.usage = u;
  }
}
class FakeGeo {
  constructor() {
    this.attributes = {};
    this.drawRange = { start: 0, count: Infinity };
    this.disposed = false;
  }
  setAttribute(n, a) {
    this.attributes[n] = a;
  }
  setDrawRange(s, c) {
    this.drawRange.start = s;
    this.drawRange.count = c;
  }
  dispose() {
    this.disposed = true;
  }
}
class FakeMat {
  constructor(o) {
    Object.assign(this, o);
    this.disposed = false;
  }
  dispose() {
    this.disposed = true;
  }
}
class FakeLines {
  constructor(g, m) {
    this.geometry = g;
    this.material = m;
    this.visible = true;
  }
}
const FakeTHREE = { BufferGeometry: FakeGeo, BufferAttribute: FakeAttr, LineBasicMaterial: FakeMat, LineSegments: FakeLines, DynamicDrawUsage: 35048 };
function fakeScene() {
  return {
    children: [],
    add(o) {
      this.children.push(o);
    },
    remove(o) {
      const i = this.children.indexOf(o);
      if (i >= 0) this.children.splice(i, 1);
    },
  };
}
const fakeCamera = (x = 0, y = 2, z = 0) => ({ position: { x, y, z } });

const run = (w, sec, step = 1 / 60) => {
  for (let s = 0; s < sec - 1e-9; s += step) w.update(step, step);
};

// ---- 1. getState 欄位、初始 ----
{
  const w = createWeather({ auto: false });
  const st = w.getState();
  const keys = ['kind', 'target', 't', 'rain', 'fog', 'icon'];
  check('getState 欄位齊全（kind / target / t / rain / fog / icon）', keys.every((k) => k in st), Object.keys(st).join(','));
  check('初始晴天：kind = target = clear、t = 1、rain = fog = 0、icon sun',
    st.kind === 'clear' && st.target === 'clear' && st.t === 1 && st.rain === 0 && st.fog === 0 && st.icon === 'sun');
  check('未知天氣 setWeather 回傳 false 且不變', w.setWeather('snow') === false && w.getState().target === 'clear');
}

// ---- 2. 三態切換 + 過場單調收斂 ----
{
  const w = createWeather({ auto: false, rng: lcg(1) });
  let ok = true;
  let detail = '';
  // 依序 clear → rain → fog → clear → fog → clear，每段檢查 rain / fog 單調、t 單調、收斂到目標
  const order = ['rain', 'fog', 'clear', 'fog', 'clear'];
  for (const k of order) {
    const before = { ...w.getState() };
    w.setWeather(k, { duration: 10 });
    const s0 = w.getState();
    if (s0.target !== k || s0.t !== 0 || s0.kind !== before.kind) {
      ok = false;
      detail = `start ${k}: ${JSON.stringify(s0)}`;
    }
    const prof = { clear: [0, 0], rain: [1, 0.3], fog: [0, 1] }[k];
    const dirR = Math.sign(prof[0] - s0.rain);
    const dirF = Math.sign(prof[1] - s0.fog);
    let prev = { ...s0 };
    let steps = 0;
    while (w.getState().t < 1 && steps < 2000) {
      w.update(1 / 60, 1 / 60);
      const s = w.getState();
      steps++;
      if (s.t < prev.t - 1e-12) ok = false;
      if ((s.rain - prev.rain) * dirR < -1e-9 || (dirR === 0 && Math.abs(s.rain - prev.rain) > 1e-9)) {
        ok = false;
        detail = `rain 非單調 ${k} ${prev.rain}→${s.rain}`;
      }
      if ((s.fog - prev.fog) * dirF < -1e-9 || (dirF === 0 && Math.abs(s.fog - prev.fog) > 1e-9)) {
        ok = false;
        detail = `fog 非單調 ${k} ${prev.fog}→${s.fog}`;
      }
      prev = { ...s };
    }
    const s = w.getState();
    if (!(s.kind === k && s.target === k && s.t === 1 && Math.abs(s.rain - prof[0]) < 1e-9 && Math.abs(s.fog - prof[1]) < 1e-9)) {
      ok = false;
      detail = `收斂 ${k}: ${JSON.stringify(s)}`;
    }
    if (Math.abs(steps - 600) > 2) {
      ok = false;
      detail = `過場步數 ${steps}（期望 600 = 10 s × 60）`;
    }
  }
  check('三態切換：過場中 t / rain / fog 單調、10 s 後收斂到目標值且 kind = target', ok, detail);

  // 預設過場長度 8–15 s
  const lens = [];
  for (let i = 0; i < 20; i++) {
    const v = createWeather({ auto: false, rng: lcg(100 + i) });
    v.setWeather('rain');
    let n = 0;
    while (v.getState().t < 1 && n < 3000) {
      v.update(0.05, 0.05);
      n++;
    }
    lens.push(n * 0.05);
  }
  check('預設過場長度落在 8–15 s', lens.every((s) => s >= 8 - 0.051 && s <= 15 + 0.051), `${Math.min(...lens).toFixed(2)}–${Math.max(...lens).toFixed(2)} s`);
  check('smoothstep 端點與單調', smooth01(0) === 0 && smooth01(1) === 1 && smooth01(0.25) < smooth01(0.5) && smooth01(-1) === 0 && smooth01(2) === 1);
}

// ---- 3. icon 過半切換、instant ----
{
  const w = createWeather({ auto: false });
  w.setWeather('fog', { duration: 10 });
  run(w, 4);
  const early = w.getState().icon;
  run(w, 2);
  const late = w.getState().icon;
  check('icon：過場前半維持起點（sun）、過半換成目標（fog）', early === 'sun' && late === 'fog', `${early}/${late}`);

  w.setWeather('rain', { instant: true });
  const s = w.getState();
  check('instant：立即 kind = target = rain、t = 1、rain = 1、icon rain', s.kind === 'rain' && s.target === 'rain' && s.t === 1 && s.rain === 1 && s.icon === 'rain');
  w.setWeather('clear', { instant: true });
  check('instant 回晴：rain = fog = 0', w.getState().rain === 0 && w.getState().fog === 0 && w.getState().icon === 'sun');
}

// ---- 4. 過場中途改向不跳變；重複設定同目標不重啟 ----
{
  const w = createWeather({ auto: false });
  w.setWeather('rain', { duration: 10 });
  run(w, 5);
  const mid = { ...w.getState() };
  w.setWeather('fog', { duration: 10 });
  const after = w.getState();
  check('過場中途改向：rain / fog 不跳變、t 歸 0', Math.abs(after.rain - mid.rain) < 1e-9 && Math.abs(after.fog - mid.fog) < 1e-9 && after.t === 0 && after.target === 'fog');
  run(w, 3);
  const t1 = w.getState().t;
  w.setWeather('fog');
  check('重複 setWeather 同目標不重啟過場', w.getState().t === t1);
  run(w, 8);
  check('改向後收斂到 fog', w.getState().kind === 'fog' && w.getState().fog === 1 && w.getState().rain === 0);
}

// ---- 5. 模擬時間：simDt = 0（暫停）凍結；simDt 缺省退回 dt ----
{
  const w = createWeather({ auto: false });
  w.setWeather('rain', { duration: 10 });
  for (let i = 0; i < 120; i++) w.update(1 / 60, 0);
  check('simDt = 0（暫停）時過場不推進', w.getState().t === 0);
  for (let i = 0; i < 60; i++) w.update(1 / 60);
  check('simDt 未提供時退回渲染 dt', Math.abs(w.getState().t - 0.1) < 1e-6, `t ${w.getState().t}`);
  // 卡頓：dt 0.1 但 simDt 0.083（丟棄餘量）→ 依 simDt
  const v = createWeather({ auto: false });
  v.setWeather('fog', { duration: 10 });
  v.update(0.1, 0.0833);
  check('狀態機吃 simDt 而非 dt（卡頓幀）', Math.abs(v.getState().t - 0.00833) < 1e-6);
}

// ---- 6. 自動切換 ----
{
  const w = createWeather({ rng: lcg(42) });
  const seen = new Set([w.getState().kind]);
  let changes = 0;
  let last = w.getState().target;
  for (let i = 0; i < 3 * 3600 * 4; i++) {
    w.update(0.25, 0.25);
    const tg = w.getState().target;
    if (tg !== last) {
      changes++;
      last = tg;
      seen.add(tg);
    }
  }
  check('auto：3 小時內多次隨機切換且三態都出現', changes >= 10 && seen.size === 3, `${changes} 次 ${[...seen].join('/')}`);
  const m = createWeather({ auto: false });
  for (let i = 0; i < 3600 * 4; i++) m.update(0.25, 0.25);
  check('auto: false 不自行切換', m.getState().target === 'clear');
}

// ---- 7. 粒子：畫質分級、跟隨相機、雨勢決定畫出數 ----
{
  check('雨絲數：low 遠低於 high（≤ 1/5）且 low < mid < high < ultra',
    RAIN_COUNT.low * 5 <= RAIN_COUNT.high && RAIN_COUNT.low < RAIN_COUNT.mid && RAIN_COUNT.mid < RAIN_COUNT.high && RAIN_COUNT.high < RAIN_COUNT.ultra);
  check('rainParticleCount 接受 tier id / budget 物件、未知當 high',
    rainParticleCount('low') === RAIN_COUNT.low && rainParticleCount({ id: 'mid' }) === RAIN_COUNT.mid && rainParticleCount('xx') === RAIN_COUNT.high);

  const scene = fakeScene();
  const cam = fakeCamera(100, 2, -50);
  const w = createWeather({ scene, camera: cam, THREE: FakeTHREE, quality: 'high', auto: false, rng: lcg(3) });
  const mesh = scene.children[0];
  check('high：建立 LineSegments（frustumCulled 關）、晴天隱藏、畫出 0',
    scene.children.length === 1 && mesh instanceof FakeLines && mesh.frustumCulled === false && w.stats().particles === RAIN_COUNT.high && !mesh.visible);
  w.setWeather('rain', { instant: true });
  w.update(1 / 60, 1 / 60);
  check('雨天：可見、畫出數 = 配置數、drawRange = 2 × 數量',
    mesh.visible && w.stats().drawn === RAIN_COUNT.high && mesh.geometry.drawRange.count === RAIN_COUNT.high * 2);

  // 相機移動 300 m 後粒子仍在相機附近
  cam.position.x += 300;
  cam.position.z += 200;
  for (let i = 0; i < 30; i++) w.update(1 / 60, 1 / 60);
  const pos = mesh.geometry.attributes.position.array;
  let maxD = 0;
  let maxDy = 0;
  for (let i = 0; i < RAIN_COUNT.high; i++) {
    maxD = Math.max(maxD, Math.abs(pos[i * 6] - cam.position.x), Math.abs(pos[i * 6 + 2] - cam.position.z));
    maxDy = Math.max(maxDy, Math.abs(pos[i * 6 + 1] - cam.position.y));
  }
  check('粒子跟隨相機：相機移動 360 m 後雨絲仍在 ±40 m 盒內', maxD <= 40.5 && maxDy <= 15, `水平 ${maxD.toFixed(1)} 垂直 ${maxDy.toFixed(1)}`);

  w.setQuality('low');
  const low = scene.children[0];
  check('setQuality(low)：舊網格移除並釋放、改建 low 數量', scene.children.length === 1 && low !== mesh && mesh.geometry.disposed && w.stats().particles === RAIN_COUNT.low);
  w.update(1 / 60, 1 / 60);
  check('low 檔畫出數 = low 配置數', w.stats().drawn === RAIN_COUNT.low);

  w.setWeather('rain', { instant: true });
  w.setWeather('clear', { duration: 10 });
  run(w, 5);
  const half = w.stats().drawn;
  check('雨勢減弱時畫出數隨 rain 下降', half > 0 && half < RAIN_COUNT.low, `${half}`);

  w.dispose();
  check('dispose：移除網格、釋放 geometry / material', scene.children.length === 0 && low.geometry.disposed && low.material.disposed);

  const nothree = createWeather({ scene: fakeScene(), camera: fakeCamera(), auto: false });
  nothree.setWeather('rain', { instant: true });
  nothree.update(1 / 60, 1 / 60);
  check('未注入 THREE：不建粒子、狀態機照跑', nothree.stats().particles === 0 && nothree.getState().rain === 1);

  const lowStart = createWeather({ scene: fakeScene(), camera: fakeCamera(), THREE: FakeTHREE, quality: { id: 'low', viewDist: 420 }, auto: false });
  check('quality 傳 budget 物件（low）', lowStart.stats().particles === RAIN_COUNT.low);
}

// ---- 8. 環境參數合成 ----
{
  const color = (r, g, b) => ({ r, g, b });
  const dayBase = {
    base: {
      hour: 12, elev: 1, day: 1, night: 0, sky: color(0.27, 0.57, 0.89), sunColor: color(1, 0.96, 0.9), sunIntensity: 2.6,
      hemiIntensity: 1.1, hemiSky: color(0.62, 0.79, 1), hemiGround: color(0.1, 0.14, 0.07),
    },
  };
  const sample = (kind, viewDist = 900) => {
    const w = createWeather({ auto: false });
    w.setWeather(kind, { instant: true });
    const env = createEnvironment({ viewDist, apply: false });
    env.update(1 / 60, { dayNight: dayBase, weather: w });
    return JSON.parse(JSON.stringify(env.getParams()));
  };
  const clear = sample('clear');
  const rain = sample('rain');
  const fog = sample('fog');
  check('晴天霧距 = 基準（180 / 720）、天空色 = 日夜基準', clear.fog.near === 180 && clear.fog.far === 720 && Math.abs(clear.sky.b - 0.89) < 1e-9);
  check('霧天霧距遠短於晴天（far ≤ 1/4）', fog.fog.far <= clear.fog.far / 4 && fog.fog.near < clear.fog.near, `far ${fog.fog.far.toFixed(0)} near ${fog.fog.near.toFixed(1)}`);
  check('雨天霧距短於晴天、長於霧天', rain.fog.far < clear.fog.far && rain.fog.far > fog.fog.far);
  check('雨天主光 / 環境光較晴天暗', rain.sun.intensity < clear.sun.intensity * 0.6 && rain.hemi.intensity < clear.hemi.intensity, `sun ${rain.sun.intensity.toFixed(2)} hemi ${rain.hemi.intensity.toFixed(2)}`);
  const sat = (c) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
  check('雨天天空偏灰（飽和度下降）', sat(rain.sky) < sat(clear.sky) * 0.5);
  check('霧色 = 天空色（遠處融入背景）', ['r', 'g', 'b'].every((k) => fog.fog.color[k] === fog.sky[k]));
  const lowClear = sample('clear', 420);
  const r = fogRange(420);
  check('視距夾霧：low 視距 420 → far = 399、near = far × 0.25（同 main applyViewDist）', lowClear.fog.far === r.far && Math.abs(r.far - 399) < 1e-9 && Math.abs(lowClear.fog.near - 399 * 0.25) < 1e-9);
  check('參數物件可直接當 weather（缺欄位當晴）', (() => {
    const env = createEnvironment({ apply: false });
    env.update(0, { dayNight: dayBase, weather: { rain: 0.5 } });
    return env.getParams().weather.rain === 0.5 && env.getParams().fog.far === 720;
  })());

  // 過場中環境參數單調（晴 → 霧，霧距單調縮短）
  {
    const w = createWeather({ auto: false });
    const env = createEnvironment({ apply: false });
    w.setWeather('fog', { duration: 10 });
    let prev = Infinity;
    let mono = true;
    for (let i = 0; i < 700; i++) {
      w.update(1 / 60, 1 / 60);
      env.update(1 / 60, { dayNight: dayBase, weather: w });
      const f = env.getParams().fog.far;
      if (f > prev + 1e-9) mono = false;
      prev = f;
    }
    check('晴 → 霧過場：霧終點單調縮短並收斂', mono && Math.abs(prev - fog.fog.far) < 1e-9);
  }

  // 套用到場景 + attach / detach
  {
    const mkColor = () => ({ r: 0, g: 0, b: 0, setRGB(r, g, b) { this.r = r; this.g = g; this.b = b; return this; } });
    const scene = { background: mkColor(), fog: { color: mkColor(), near: 1, far: 2 } };
    const dn = {
      ...dayBase, env: null, hemi: { intensity: 0, color: mkColor(), groundColor: mkColor() }, sun: { intensity: 0, color: mkColor() },
      attachEnvironment(e) { this.env = e || null; },
    };
    const env = createEnvironment({ scene, dayNight: dn, viewDist: 650 });
    check('createEnvironment({ dayNight })：自動 attach（DayNight 改走 environment 路徑）', dn.env === env);
    const w = createWeather({ auto: false });
    w.setWeather('rain', { instant: true });
    env.update(1 / 60, { weather: w });
    const p = env.getParams();
    check('apply：scene.fog / background / hemi / sun 寫入合成值',
      scene.fog.far === p.fog.far && scene.fog.near === p.fog.near && scene.background.b === p.sky.b && scene.fog.color.r === p.fog.color.r
      && dn.sun.intensity === p.sun.intensity && dn.hemi.intensity === p.hemi.intensity && dn.hemi.groundColor.g === p.hemi.groundColor.g);
    env.setViewDist(420);
    env.update(0, { weather: w });
    check('setViewDist 生效（霧終點 ≤ 視距）', scene.fog.far <= 420 * 0.95 * 0.5 + 1e-9);
    env.dispose();
    check('dispose / detach：DayNight 回舊路徑', dn.env === null);
  }
}

// ---- 9. 雨聲 voice（假 AudioContext） ----
{
  class Param {
    constructor(v = 0) {
      this.value = v;
      this.target = null;
    }
    setTargetAtTime(v) {
      this.target = v;
    }
  }
  class Node {
    constructor(kind) {
      this.kind = kind;
      this.outs = [];
      this.gain = new Param(1);
      this.frequency = new Param(0);
      this.Q = new Param(0);
      this.started = false;
    }
    connect(n) {
      this.outs.push(n);
      return n;
    }
    start() {
      this.started = true;
    }
    stop() {}
  }
  const ctx = {
    currentTime: 0,
    createGain: () => new Node('gain'),
    createBiquadFilter: () => new Node('filter'),
    createBufferSource: () => new Node('src'),
  };
  const v = { ctx, out: null, sources: [] };
  const nb = { white: { duration: 1 }, pink: { duration: 2 } };
  const ctrl = LOOPS.rain(v, nb);
  check('LOOPS.rain：回傳 { gain, set }、噪聲源已啟動並登記在 v.sources', !!ctrl.gain && typeof ctrl.set === 'function' && v.sources.length === 2 && v.sources.every((s) => s.started));
  const levels = [];
  for (const r of [0, 0.1, 0.3, 0.6, 1]) {
    ctrl.set({ rain: r }, 0);
    levels.push(ctrl.level.gain.target ?? ctrl.level.gain.value);
  }
  check('雨聲音量隨 rain 單調遞增、rain 0 時靜音', levels[0] === 0 && levels.every((l, i) => i === 0 || l > levels[i - 1]), levels.map((l) => l.toFixed(3)).join(' '));
  check('rainLevel：0 → 0、1 → 0.5、非數字當 0', rainLevel(0) === 0 && Math.abs(rainLevel(1) - 0.5) < 1e-9 && rainLevel(NaN) === 0);

  // 天氣 → 雨聲：過場中音量跟著 rain 走
  const w = createWeather({ auto: false });
  w.setWeather('rain', { duration: 10 });
  const tr = [];
  for (let i = 0; i < 4; i++) {
    run(w, 3);
    tr.push(rainLevel(w.getState().rain));
  }
  check('晴 → 雨過場：雨聲音量逐步增加', tr.every((l, i) => i === 0 || l > tr[i - 1]) && tr[0] > 0, tr.map((l) => l.toFixed(3)).join(' '));
}

// ---- 10. 效能：update 不配置大量物件（粗略：1000 次平均時間） ----
{
  const scene = fakeScene();
  const w = createWeather({ scene, camera: fakeCamera(), THREE: FakeTHREE, quality: 'ultra', auto: false });
  const env = createEnvironment({ apply: false });
  w.setWeather('rain', { instant: true });
  const t0 = performance.now();
  for (let i = 0; i < 1000; i++) {
    w.update(1 / 60, 1 / 60);
    env.update(1 / 60, { weather: w });
  }
  const ms = (performance.now() - t0) / 1000;
  check(`效能：ultra 雨天 weather + environment update 平均 < 0.5 ms（${ms.toFixed(3)} ms）`, ms < 0.5);
}

const total = passed + failed;
console.log(failed ? `FAIL ${failed}/${total}` : `PASS ${passed}/${total}`);
process.exit(failed ? 1 : 0);
