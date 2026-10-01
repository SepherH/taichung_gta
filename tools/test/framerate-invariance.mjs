#!/usr/bin/env node
// 幀率不變性回歸（p5-c1 時間步契約，docs/dev/interfaces.md §20）：同一段行人模擬在 60 / 120 / 144 Hz 渲染幀率下推進相同的模擬時間，
//   結果在容差內一致——位置（沿路線 s、x、z）、送進 animator 的速度、walk ↔ idle 切換次數、大腦收到的累積秒數
// 用法：node tools/test/framerate-invariance.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 不依賴 three / rapier：直接用 src/traffic-peds.js（行人更新）+ src/physics/world.js FixedStepper（固定 1/60 子步）；
//   每幀的接線照 Traffic：子步內 _simAcc += step、stepPeds / afterStepPeds；sync 取走 simDt → frame++ → thinkPeds(simDt) → animatePed(dt)
//   stagger / lod 間隔照 src/crowd.js（createStagger、AI_EVERY、MIXER_EVERY；該檔間接 import three，這裡複製語意）；
//   animator 以 IDLE_BELOW 0.2 m/s 的 walk / idle 判斷替身（同 characters/animator.js）
// 敏感度檢查：以「修前」接線重跑同一組斷言，必須抓得到不一致——
//   pre-c1  = sync 把渲染幀 dt 交給 thinkPeds（mid 級 / 替身走路與大腦計時吃渲染時間）
//   pre-fix1 = 動畫速度 = 當幀位移 ÷ 渲染幀 dt（上一輪路人腳抖的根因）
// p5-d1 追加四組（各附修前接線的敏感度檢查）：
//   耐久去重時鐘（src/vehicle-damage.js step / update simDt）、號誌相位（src/traffic-lights.js step；import three，缺 three 時 SKIP 並註明）、
//   玩家追向（src/player.js turnBlend；該檔 import three，以原始碼擷取 TURN_RATE / TURN_DECAY / turnBlend 求值）、
//   行人 LOD fine ↔ 非 fine 轉換幀的時間記帳（src/traffic-peds.js thinkPeds）
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

const { FixedStepper, DEFAULT_STEP } = await import('../../src/physics/world.js');
const { polylineInfo } = await import('../../src/geom.js');
const P = await import('../../src/traffic-peds.js');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const STEP = DEFAULT_STEP;
const RATES = [60, 120, 144];
const SIM_STEPS = 363; // 6.05 s 模擬時間（刻意不是 1/120、1/144 的整數倍幀邊界）
const HITCH_AT = 2; // 卡頓情境：渲染時間 2 s 處插入一幀 MAX_FRAME_DT（0.1 s > 5 子步上限，丟棄餘量）
const HITCH_DT = 0.1;
const IDLE_BELOW = 0.2; // characters/animator.js
const POS_TOL = 1e-6; // m
const TIME_TOL = 1e-9; // s
const SPEED_TOL = 0.01; // 動畫速度相對誤差
const WARMUP = 0.5; // s：之前的動畫取樣不計（第一次取樣前 animSpeed = 0）

// ---------- 依賴物件（Traffic 的同形替身）----------
const AI_EVERY = { near: 1, mid: 3, far: 6 };
const MIXER_EVERY = { near: 1, nearHidden: 1, mid: 3, midHidden: 0 };
const stagger = {
  shouldTick(index, frame, every) {
    if (every <= 1) return every === 1;
    return (frame + index) % every === 0;
  },
};
const lod = {
  aiEvery: (level) => AI_EVERY[level],
  mixerEvery(level, inView) {
    if (level === 'near') return inView ? MIXER_EVERY.near : MIXER_EVERY.nearHidden;
    if (level === 'mid') return inView ? MIXER_EVERY.mid : MIXER_EVERY.midHidden;
    return 0;
  },
};

// 之字形人行道（折返點 s0 / s1 落在中段，涵蓋掉頭）；off = 0：有橫向偏移時轉角處的偏移點會跳（幾何，與幀率無關）
const road = polylineInfo([0, 0, 20, 0, 20, 15, 45, 15, 45, -10, 80, -10]);

function makeEnv() {
  return {
    terrain: { querySurface: (x, z) => ({ y: 0.01 * x - 0.02 * z }) },
    combat: { stateOf: () => 'idle', isDown: () => false },
    context: {},
    peds: [],
    citizens: [],
    stagger,
    lod,
    frame: 0,
    _q: {},
    _tmp: { x: 0, z: 0, dx: 0, dz: 1, seg: 0 },
    _ret: null,
    _simAcc: 0,
    _nearestRoute: () => null,
  };
}

function makeBrain() {
  const it = { moveX: 0, moveZ: 0, run: false, faceYaw: null, jump: false, mode: 'wander' };
  return {
    time: 0, // 收到的累積秒數總和（應 = 模擬時間）
    calls: 0,
    update(dt) {
      this.time += dt;
      this.calls++;
      return it;
    },
    onAttacked() {},
  };
}

// animator 替身：walk / idle 由速度門檻決定；記錄每次取樣的速度與狀態切換
function makeAnim(rec) {
  return {
    state: 'idle',
    switches: 0,
    update(dt, { speed }) {
      const next = speed < IDLE_BELOW ? 'idle' : 'walk';
      if (next !== this.state) {
        this.switches++;
        this.state = next;
      }
      rec.push(speed);
    },
    trigger() {},
  };
}

function makePed(env, i, level, active) {
  const samples = [];
  const p = {
    slot: i,
    road,
    off: 0,
    s0: 6 + i * 0.7,
    s1: 70 - i * 0.9,
    s: 10 + i * 4.3,
    dir: i % 2 ? -1 : 1,
    speed: 1.1 + (i % 5) * 0.1,
    x: 0,
    y: Infinity,
    z: 0,
    yaw: 0,
    state: 'walk',
    kbx: 0,
    kbz: 0,
    intent: { moveX: 0, moveZ: 0, run: false, faceYaw: null },
    actor: { pos: { x: 0, y: 0, z: 0 }, yaw: 0 },
    body: { active, setPose() {}, settleCheck: () => false, getPosition: () => ({ x: p.x, y: p.y, z: p.z }), centerY: 0.9 },
    brain: makeBrain(),
    anim: null,
    samples,
    citizen: { level, inView: true },
    aiAcc: 0,
    animAcc: 0,
    walkAcc: 0,
    // 初始就照 thinkPeds 的判斷（LOD 轉換幀的時間記帳另見下方「行人 LOD 轉換」）
    fine: level === 'near' || active,
    moveD: 0,
    moveT: 0,
    animSpeed: 0,
  };
  p.anim = makeAnim(samples);
  P.walkPed(env, p, 0, true);
  return p;
}

function makeCitizen(env, i) {
  const c = { slot: 40 + i, road, off: 0, s0: 4, s1: 75, s: 5 + i * 6.1, dir: 1, speed: 1.2 + i * 0.05, x: 0, y: Infinity, z: 0, yaw: 0, rep: 'impostor', walkAcc: 0, moved: false };
  P.walkPed(env, c, 0, true);
  return c;
}

// 修前接線：動畫速度 = 當幀位移 ÷ 渲染幀 dt（fix1 之前的 traffic.js sync）
function animateLegacy(env, p, dt) {
  const c = p.citizen;
  p.animAcc += dt;
  const d = Math.hypot(p.x - (p._lx ?? p.x), p.z - (p._lz ?? p.z));
  p._acc = (p._acc || 0) + dt;
  p._dist = (p._dist || 0) + d;
  p._lx = p.x;
  p._lz = p.z;
  if (!env.stagger.shouldTick(p.slot, env.frame, env.lod.mixerEvery(c.level, c.inView))) return;
  p.animSpeed = p._dist / p._acc;
  p._dist = 0;
  p._acc = 0;
  p.anim.update(p.animAcc, { speed: p.animSpeed });
  p.animAcc = 0;
}

// 跑一段：rate Hz、推進到 SIM_STEPS 個子步為止；mode：'fixed'（目前）| 'pre-c1' | 'pre-fix1'
function run(rate, { mode = 'fixed', hitch = false } = {}) {
  const env = makeEnv();
  for (let i = 0; i < 6; i++) env.peds.push(makePed(env, i, 'near', true)); // near：子步內走
  for (let i = 6; i < 12; i++) env.peds.push(makePed(env, i, 'mid', false)); // mid：降頻累積走
  for (let i = 0; i < 6; i++) env.citizens.push(makeCitizen(env, i)); // 替身
  // 一名 return 中的行人（起身後走回人行道，子步內走）
  const ret = env.peds[0];
  ret.x += 3;
  ret.z += 2;
  ret.state = 'return';
  ret.noSpeedCheck = true; // 走回路線中速度 = 位移，抵達那步會截短

  const stepper = new FixedStepper(STEP, 5);
  const onStep = (h) => {
    env._simAcc += h; // Traffic._step
    P.stepPeds(env, h);
    P.afterStepPeds(env, h);
  };
  const dt = 1 / rate;
  let steps = 0;
  let wall = 0;
  let hitched = !hitch;
  while (steps < SIM_STEPS) {
    let frameDt = dt;
    if (!hitched && wall >= HITCH_AT) {
      frameDt = HITCH_DT;
      hitched = true;
    }
    // 卡頓幀不得越過目標子步數（各幀率都在同一模擬時刻停）
    stepper.advance(frameDt, (h) => {
      if (steps >= SIM_STEPS) return;
      steps++;
      onStep(h);
    });
    wall += frameDt;
    // Traffic.sync 的行人部分
    const simDt = env._simAcc;
    env._simAcc = 0;
    env.frame++;
    P.thinkPeds(env, mode === 'pre-c1' ? frameDt : simDt);
    for (const p of env.peds) {
      if (wall < WARMUP) p.samples.length = 0;
      if (mode === 'pre-fix1') animateLegacy(env, p, frameDt);
      else P.animatePed(env, p, frameDt);
    }
  }
  // 比較前把尚未套用的累積秒數走完（mid / 替身在 AI 間隔才走）：等同「同一模擬時刻的位置」
  for (const p of env.peds) if (!p.fine && p.walkAcc > 0) P.walkPed(env, p, p.walkAcc);
  for (const c of env.citizens) if (c.walkAcc > 0) P.walkPed(env, c, c.walkAcc);
  return { env, steps, simTime: steps * STEP, dropped: stepper.dropped };
}

function compare(label, opts) {
  const runs = RATES.map((hz) => ({ hz, ...run(hz, opts) }));
  const base = runs[0];
  let maxPos = 0;
  let maxBrain = 0;
  let maxSpeedErr = 0;
  let badSamples = 0;
  let totalSamples = 0;
  const switches = [];
  for (const R of runs) {
    let sw = 0;
    const all = [...R.env.peds, ...R.env.citizens];
    const ref = [...base.env.peds, ...base.env.citizens];
    for (let i = 0; i < all.length; i++) {
      const a = all[i];
      const b = ref[i];
      const dp = Math.max(Math.abs(a.s - b.s), Math.abs(a.x - b.x), Math.abs(a.z - b.z));
      maxPos = Math.max(maxPos, dp);
    }
    for (const p of R.env.peds) {
      // 大腦收到的秒數 + 尚未交出的 aiAcc = 模擬時間
      maxBrain = Math.max(maxBrain, Math.abs(p.brain.time + p.aiAcc - R.simTime));
      sw += p.anim.switches;
      if (p.state !== 'walk' || p.noSpeedCheck) continue;
      for (const v of p.samples) {
        totalSamples++;
        const e = Math.abs(v - p.speed) / p.speed;
        if (e > SPEED_TOL) badSamples++;
        maxSpeedErr = Math.max(maxSpeedErr, e);
      }
    }
    switches.push(sw);
  }
  const res = {
    label,
    simSame: runs.every((r) => r.steps === SIM_STEPS),
    maxPos,
    maxBrain,
    maxSpeedErr,
    badSamples,
    totalSamples,
    switches,
  };
  console.log(
    `  [${label}] 子步 ${runs.map((r) => r.steps).join('/')}、位置最大差 ${maxPos.toExponential(2)} m、大腦秒數最大差 ${maxBrain.toExponential(2)} s、` +
      `動畫速度最大相對誤差 ${(maxSpeedErr * 100).toFixed(2)}%（超標 ${badSamples}/${totalSamples}）、walk↔idle 切換 ${switches.join('/')}（${RATES.join('/')} Hz）`,
  );
  return res;
}

// walk / idle 切換次數：near / mid 各一次（第一次取樣 idle → walk）是正常的，各幀率要相同且不再來回切
const PEDS = 12;
function assertAll(res, prefix) {
  check(`${prefix}：各幀率推進相同模擬時間（${SIM_STEPS} 子步）`, res.simSame);
  check(`${prefix}：位置（s / x / z）跨幀率一致（≤ ${POS_TOL} m）`, res.maxPos <= POS_TOL, `${res.maxPos.toExponential(2)} m`);
  check(`${prefix}：大腦累積秒數 = 模擬時間（≤ ${TIME_TOL} s）`, res.maxBrain <= TIME_TOL, `${res.maxBrain.toExponential(2)} s`);
  check(`${prefix}：漫步中動畫速度 = 路線步速（相對誤差 ≤ ${SPEED_TOL * 100}%）`, res.badSamples === 0 && res.totalSamples > 0, `${res.badSamples}/${res.totalSamples} 超標，最大 ${(res.maxSpeedErr * 100).toFixed(2)}%`);
  check(`${prefix}：walk↔idle 切換次數跨幀率相同且不來回切（≤ ${PEDS}）`, res.switches.every((n) => n === res.switches[0] && n <= PEDS), res.switches.join('/'));
}
const failedOf = (res) =>
  [
    !res.simSame,
    res.maxPos > POS_TOL,
    res.maxBrain > TIME_TOL,
    !(res.badSamples === 0 && res.totalSamples > 0),
    !res.switches.every((n) => n === res.switches[0] && n <= PEDS),
  ].filter(Boolean).length;

console.log('== 目前接線（thinkPeds 吃 simDt、動畫速度 = moveD / moveT）');
assertAll(compare('fixed', {}), '穩定幀率');
assertAll(compare('fixed+hitch', { hitch: true }), '含 0.1 s 卡頓幀');

console.log('== 敏感度：以修前接線重跑同組斷言（預期違反，只統計違反數）');
const preC1 = compare('pre-c1', { mode: 'pre-c1' });
const preC1h = compare('pre-c1+hitch', { mode: 'pre-c1', hitch: true });
const preFix1 = compare('pre-fix1', { mode: 'pre-fix1' });
const nC1 = failedOf(preC1);
const nC1h = failedOf(preC1h);
const nFix1 = failedOf(preFix1);
console.log(`  修前違反斷言數：pre-c1 ${nC1}/5、pre-c1+hitch ${nC1h}/5、pre-fix1 ${nFix1}/5`);
check('敏感度：pre-c1（thinkPeds 吃渲染 dt）至少違反 1 條', nC1 > 0, `${nC1}/5`);
check('敏感度：pre-c1 + 卡頓至少違反 1 條', nC1h > 0, `${nC1h}/5`);
check('敏感度：pre-fix1（位移 ÷ 渲染 dt）至少違反 1 條', nFix1 > 0, `${nFix1}/5`);

// FixedStepper.preview / PhysicsWorld.simTimeFor 與 advance 一致（物理 step 前的模擬計時靠它）
{
  const st = new FixedStepper(STEP, 5);
  let ok = true;
  const seq = [1 / 144, 1 / 144, 1 / 120, 1 / 60, 0.1, 0.03, 1 / 144, 0, -1, 0.2, 1 / 60];
  for (const d of seq) {
    const want = st.preview(d);
    const r = st.advance(d, () => {});
    if (want !== r.steps || Math.abs(r.simDt - r.steps * STEP) > 1e-12) ok = false;
  }
  check('FixedStepper.preview(dt) = advance(dt).steps、simDt = steps × step', ok);
}

// ======================= p5-d1：其餘模擬計時的幀率不變性 =======================
// 共通：rate Hz 推進到 nSteps 個子步為止；hitches = 在這些渲染時刻各插入一幀 HITCH_DT（同上，卡頓幀不越過目標子步數）
// onStep(h, k)：第 k 個子步（1 起算）；onFrame(frameDt, simDt, steps)：該幀子步之後；beforeFrame(frameDt, steps, stepper)：子步之前
function drive(rate, nSteps, { hitches = [], onStep, onFrame = () => {}, beforeFrame = () => {} }) {
  const stepper = new FixedStepper(STEP, 5);
  const dt = 1 / rate;
  const pending = hitches.slice();
  let steps = 0;
  let wall = 0;
  while (steps < nSteps) {
    let frameDt = dt;
    if (pending.length && wall >= pending[0]) {
      frameDt = HITCH_DT;
      pending.shift();
    }
    beforeFrame(frameDt, steps, stepper);
    const s0 = steps;
    stepper.advance(frameDt, (h) => {
      if (steps >= nSteps) return;
      steps++;
      onStep(h, steps);
    });
    wall += frameDt;
    onFrame(frameDt, (steps - s0) * STEP, steps);
  }
  return steps;
}
const sameSeq = (a, b, tol) => a.length === b.length && a.every((v, i) => (typeof v === 'number' ? Math.abs(v - b[i]) <= tol : v === b[i]));
const SCEN = [
  { label: '穩定幀率', hitches: [] },
  { label: '含連續 2 幀 0.1 s 卡頓', hitches: [1.02, 1.02] }, // 落在撞擊 A（子步 60）與 B（77）之間
];
// 各情境 × 各幀率跑 fn → 序列；與 60 Hz 穩定幀率的序列比
// 例外（例：修前沒有 step API）視為不一致，不中斷其餘斷言
function crossRate(fn, tol) {
  const tryRun = (hz, hitches) => {
    try {
      return fn(hz, hitches);
    } catch (err) {
      return [`例外：${err && err.message}`];
    }
  };
  const ref = tryRun(60, []);
  let worst = typeof ref[0] === 'string' && ref[0].startsWith('例外') ? ref[0] : '';
  let ok = ref.length > 0 && !worst;
  for (const sc of SCEN) {
    for (const hz of RATES) {
      const seq = tryRun(hz, sc.hitches);
      if (!sameSeq(seq, ref, tol)) {
        ok = false;
        worst ||= `${sc.label} ${hz} Hz`;
      }
    }
  }
  return { ok, worst, ref };
}

// ---------- 1. 耐久去重時鐘（src/vehicle-damage.js）----------
// 撞擊排在固定子步（contacts router.drain 在 onAfterStep）；A → 17 子步（0.283 s < DEDUP_SEC 0.3）後 B 應去重，
// 卡頓幀落在 A、B 之間：渲染時間多走 ≥ 0.05 s，吃渲染 dt 的時鐘會把 B 當成窗外
{
  const D = await import('../../src/vehicle-damage.js');
  const IMPACTS = new Map([
    [60, 10],
    [77, 12], // A + 17 子步：窗內，只補差額
    [140, 11],
    [159, 12], // + 19 子步（0.317 s）：窗外，全額
    [200, 9],
    [210, 9.5],
  ]);
  const N = 240;
  const runDmg = (legacy) => (hz, hitches) => {
    const dmg = D.createVehicleDamage({});
    const v = { spec: { mass: 1400 } };
    dmg.attach(v);
    const seq = [];
    drive(hz, N, {
      hitches,
      onStep: (h, k) => {
        if (IMPACTS.has(k)) seq.push(dmg.onImpact(v, { relSpeed: IMPACTS.get(k) }));
        if (!legacy) dmg.step(h); // main.js：pw.onAfterStep（router.drain 之後）
      },
      onFrame: (frameDt) => (legacy ? dmg.update(frameDt, 0, 0) : dmg.update(frameDt, 0, 0, 0)), // 修前：每幀以渲染 dt 推進
    });
    seq.push(dmg.healthOf(v));
    return seq;
  };
  const fixed = crossRate(runDmg(false), 1e-9);
  const legacy = crossRate(runDmg(true), 1e-9);
  console.log(`  [耐久] 60 Hz 每次撞擊扣值 / 最終耐久 ${fixed.ref.map((x) => (typeof x === 'number' ? x.toFixed(2) : x)).join(' / ')}${legacy.ok ? '' : `；修前不一致：${legacy.worst}`}`);
  check('耐久：去重時鐘 = 模擬時間，60 / 120 / 144 Hz（含卡頓幀）每次扣值與最終耐久一致', fixed.ok, fixed.worst);
  check('耐久：窗內（17 子步）只補差額、窗外（19 子步）全額', fixed.ref[1] > 0 && fixed.ref[1] < fixed.ref[0] && Math.abs(fixed.ref[3] - D.impactDamage({ spec: { mass: 1400 } }, 12)) < 1e-9);
  check('敏感度：修前（dmg.update(渲染 dt) 推進去重時鐘）跨幀率 / 卡頓不一致', !legacy.ok, legacy.worst);
}

// ---------- 2. 號誌相位（src/traffic-lights.js）----------
// 車流在子步內讀號誌：每個子步看到的號誌時間應 = 該子步的模擬時刻（k × step），各路口燈色序列跨幀率一致
{
  let L = null;
  try {
    L = await import('../../src/traffic-lights.js');
  } catch (err) {
    if (!/three/.test(String(err && err.message))) throw err;
    console.log('SKIP  號誌相位幀率一致性：src/traffic-lights.js 依賴 three（本環境無 node_modules），未執行');
  }
  if (L) {
    const N = 363;
    const runLights = (legacy) => (hz, hitches) => {
      const lights = L.createTrafficLights();
      const sigs = lights.signals.slice(0, 24);
      const seq = [];
      const sample = (k) => {
        seq.push(lights.time - k * STEP);
        for (const sg of sigs) {
          const st = lights.approachState(sg, sg.x + 10, sg.z);
          seq.push(st.color, st.remaining);
        }
      };
      drive(hz, N, {
        hitches,
        // 修前：物理 step 前 lights.update(simDt) 整幀推進一次（simDt 取 preview）
        beforeFrame: (frameDt, steps, stepper) => {
          if (legacy) lights.update(Math.min(stepper.preview(frameDt), N - steps) * STEP);
        },
        onStep: (h, k) => {
          if (!legacy) lights.step(h); // main.js：pw.onBeforeStep（先於車流 _step）
          sample(k); // 子步內讀（車流 _signalLimit）
        },
        onFrame: () => {
          if (!legacy) lights.update();
        },
      });
      return seq;
    };
    const fixed = crossRate(runLights(false), 1e-9);
    const legacy = crossRate(runLights(true), 1e-9);
    const timeOk = fixed.ref.filter((x, i) => i % 49 === 0).every((x) => Math.abs(x) < 1e-9);
    check('號誌：子步內看到的號誌時間 = 子步模擬時刻、燈色 / 剩餘秒數 60 / 120 / 144 Hz（含卡頓幀）一致', fixed.ok && timeOk, fixed.worst);
    check('敏感度：修前（每幀 lights.update(simDt) 一次）卡頓幀內子步看到幀末時刻', !legacy.ok, legacy.worst);
  }
}

// ---------- 3. 玩家追向（src/player.js）----------
// 以渲染 dt 每幀追向（syncPhysics）；目標在 0 / 0.5 / 1.25 s 改變（三個幀率共同的幀邊界），比各取樣時刻的 yaw
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../src/player.js', import.meta.url), 'utf8');
  const grab = (re) => (src.match(re) || [])[0] || '';
  const body = [grab(/^const TURN_RATE = [^\n]*/m), grab(/^export const TURN_DECAY = [^\n]*/m).replace(/^export /, ''), grab(/^export function turnBlend\([\s\S]*?\n\}/m).replace(/^export /, '')].join('\n');
  let turnBlend = null;
  try {
    turnBlend = new Function(`${body}\nreturn turnBlend;`)();
  } catch (err) {
    turnBlend = null;
  }
  const legacyBlend = (dt) => Math.min(1, 12 * dt); // 修前：min(1, TURN_RATE · dt)
  const angleD = (from, to) => {
    let d = (to - from) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  };
  const TARGETS = [
    [0, 2.6],
    [0.5, -1.2],
    [1.25, 0.4],
  ];
  const SAMPLES = [0.25, 0.5, 1, 1.25, 1.5, 2];
  const runYaw = (blend, hz) => {
    let yaw = 0;
    const out = [];
    const n = Math.round(2 * hz);
    let si = 0;
    for (let f = 1; f <= n; f++) {
      const t0 = (f - 1) / hz;
      const want = TARGETS.filter(([t]) => t <= t0 + 1e-9).at(-1)[1];
      yaw += angleD(yaw, want) * blend(1 / hz);
      if (si < SAMPLES.length && Math.abs(f - SAMPLES[si] * hz) < 1e-6) {
        out.push(yaw);
        si++;
      }
    }
    return out;
  };
  const cmp = (blend) => {
    const ref = runYaw(blend, 60);
    let max = 0;
    for (const hz of RATES) {
      const seq = runYaw(blend, hz);
      if (seq.length !== ref.length) return Infinity;
      for (let i = 0; i < seq.length; i++) max = Math.max(max, Math.abs(seq[i] - ref[i]));
    }
    return max;
  };
  const YAW_TOL = 1e-9;
  const errFixed = turnBlend ? cmp(turnBlend) : Infinity;
  const errLegacy = cmp(legacyBlend);
  const same60 = turnBlend ? Math.max(...runYaw(turnBlend, 60).map((y, i) => Math.abs(y - runYaw(legacyBlend, 60)[i]))) : Infinity;
  console.log(`  [追向] yaw 跨幀率最大差：目前 ${errFixed.toExponential(2)} rad、修前 ${errLegacy.toExponential(2)} rad；60 Hz 與修前差 ${same60.toExponential(2)} rad`);
  check(`玩家追向：60 / 120 / 144 Hz 各取樣時刻 yaw 一致（≤ ${YAW_TOL} rad；player.js 依賴 three，以原始碼擷取 turnBlend 求值）`, errFixed <= YAW_TOL, turnBlend ? `${errFixed.toExponential(2)} rad` : '擷取不到 turnBlend');
  check('玩家追向：60 Hz 結果與修前相同（手感不變，≤ 1e-12 rad）', same60 <= 1e-12, `${same60.toExponential(2)} rad`);
  check('敏感度：修前 min(1, TURN_RATE · dt) 跨幀率不一致', errLegacy > YAW_TOL, `${errLegacy.toExponential(2)} rad`);
}

// ---------- 4. 行人 LOD fine ↔ 非 fine 轉換（src/traffic-peds.js thinkPeds）----------
// 直線長人行道（不折返）：各行人 near ↔ mid 依模擬子步數切換（同 Traffic：sync 先 _updateLod 再 thinkPeds），
// 走過的距離必須 = 步速 × 模擬時間（轉換幀不重算、不遺失），且跨幀率一致
{
  const straight = polylineInfo([0, 0, 0, 2000]);
  const N = 363;
  // 修前的 fine 記帳（p5-c1 版 thinkPeds 的走路部分；大腦 / 狀態轉換與本測試無關，wander 恆不變）
  function thinkLegacy(env, simDt) {
    for (const p of env.peds) {
      p.aiAcc += simDt;
      p.fine = p.citizen.level === 'near' || p.body.active || p.state !== 'walk';
      if (p.fine) p.walkAcc = 0;
      else p.walkAcc += simDt;
      if (!env.stagger.shouldTick(p.slot, env.frame, env.lod.aiEvery(p.citizen.level))) continue;
      p.brain.update(p.aiAcc, env.context);
      p.aiAcc = 0;
      if (!p.fine && p.state === 'walk' && p.walkAcc > 0) {
        p.moveD += P.walkPed(env, p, p.walkAcc);
        p.moveT += p.walkAcc;
        p.walkAcc = 0;
        P.syncActor(p);
      }
    }
  }
  const levelAt = (i, steps) => (Math.floor((steps + i * 7) / (23 + i * 4)) % 2 === 0 ? 'near' : 'mid');
  const runLod = (legacy) => (hz, hitches) => {
    const env = makeEnv();
    const s0 = [];
    for (let i = 0; i < 8; i++) {
      const p = makePed(env, i, levelAt(i, 0), false);
      Object.assign(p, { road: straight, s0: 0, s1: 2000, s: 5 + i * 3, dir: 1 });
      P.walkPed(env, p, 0, true);
      s0.push(p.s);
      env.peds.push(p);
    }
    let simAcc = 0;
    drive(hz, N, {
      hitches,
      onStep: (h) => {
        simAcc += h;
        P.stepPeds(env, h);
        P.afterStepPeds(env, h);
      },
      onFrame: (frameDt, _sim, steps) => {
        const simDt = simAcc;
        simAcc = 0;
        env.frame++;
        env.peds.forEach((p, i) => (p.citizen.level = levelAt(i, steps))); // _updateLod
        if (legacy) thinkLegacy(env, simDt);
        else P.thinkPeds(env, simDt);
      },
    });
    for (const p of env.peds) if (!p.fine && p.walkAcc > 0) P.walkPed(env, p, p.walkAcc);
    return env.peds.map((p, i) => p.s - s0[i] - p.speed * N * STEP);
  };
  const fixed = crossRate(runLod(false), POS_TOL);
  const legacy = crossRate(runLod(true), POS_TOL);
  const maxErr = Math.max(...fixed.ref.map(Math.abs));
  const legErr = Math.max(...runLod(true)(60, []).map(Math.abs));
  console.log(`  [LOD 轉換] 走過距離 − 步速 × 模擬時間：目前最大 ${maxErr.toExponential(2)} m、修前 60 Hz ${legErr.toExponential(2)} m`);
  check(`行人 LOD 轉換：走過距離 = 步速 × 模擬時間（≤ ${POS_TOL} m，轉換幀不重算不遺失）`, maxErr <= POS_TOL, `${maxErr.toExponential(2)} m`);
  check('行人 LOD 轉換：60 / 120 / 144 Hz（含卡頓幀）位置一致', fixed.ok, fixed.worst);
  check('敏感度：修前 fine 記帳（轉換幀重算 / 歸零 walkAcc）違反', !legacy.ok || legErr > POS_TOL, `${legErr.toExponential(2)} m${legacy.ok ? '' : `、${legacy.worst}`}`);
}

const total = passed + failed;
console.log(failed ? `FAIL ${failed}/${total}` : `PASS ${passed}/${total}`);
process.exit(failed ? 1 : 0);
