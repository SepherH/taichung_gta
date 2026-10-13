#!/usr/bin/env node
// P7 通緝核心無頭測試：src/wanted/wanted.js（契約 A）
// 用法：node tools/test/p7-wanted.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 涵蓋：犯行 heat → 星數、路人目擊 0.5 倍且至少 1 星、星數只升不降、狀態機（active → searching → evaded、spotted、圈內 0.25 倍速）、
//   searchCircle、clear 各 reason 的事件序列、幀率無關（1/60 vs 1/144）、dt clamp、setStars / 0 星 update
import { createBus } from '../../src/core/events.js';
import {
  CRIMES,
  HEAT,
  STAR_HEAT,
  EVADE_SEC,
  MAX_DT,
  SEARCH_AFTER_FRAC,
  CIRCLE_BASE_R,
  CIRCLE_PER_STAR_R,
  INSIDE_SEARCH_RATE,
  createWanted,
  starsForHeat,
} from '../../src/wanted/wanted.js';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// 建一個帶事件紀錄的 wanted
const EVENTS = ['wanted:change', 'wanted:state', 'wanted:spotted', 'wanted:cleared'];
function make(config) {
  const bus = createBus();
  const log = [];
  for (const name of EVENTS) bus.on(name, (p) => log.push({ name, ...p }));
  const w = createWanted({ bus, config });
  return { w, log, bus };
}

// 以固定 dt 推進 sec 秒（最後一幀補餘量），每幀呼叫 cb 取 update 參數；回傳累計時間
function run(w, sec, dt, ctx) {
  let t = 0;
  while (t < sec - 1e-12) {
    const step = Math.min(dt, sec - t);
    w.update(step, typeof ctx === 'function' ? ctx(t) : ctx);
    t += step;
  }
  return t;
}

// ======================= 常數 =======================
{
  const keys = Object.keys(CRIMES);
  check('CRIMES：9 種且值 = 同名字串', keys.length === 9 && keys.every((k) => CRIMES[k] === k));
  check('HEAT：與 CRIMES 同鍵', keys.every((k) => typeof HEAT[k] === 'number') && Object.keys(HEAT).length === 9);
  check('STAR_HEAT / EVADE_SEC 契約值', STAR_HEAT.join() === '0,0.5,3,6,10,15' && EVADE_SEC.join() === '0,10,15,22,30,40');
  check('starsForHeat 邊界', starsForHeat(0.49) === 0 && starsForHeat(0.5) === 1 && starsForHeat(2.99) === 1 && starsForHeat(3) === 2 && starsForHeat(15) === 5 && starsForHeat(999) === 5);
}

// ======================= 1. 犯行 heat 與星數 =======================
{
  // 各犯行單次（被看見）
  const expect = { assault: 1, assaultPolice: 1, kill: 1, killPolice: 2, gunfire: 0, carjack: 1, vehicleHit: 1, vehicleKill: 1, policeVehicle: 1 };
  const bad = [];
  for (const c of Object.keys(CRIMES)) {
    const { w } = make();
    w.report(c, { x: 1, z: 2, witnessed: true });
    if (!near(w.heat, HEAT[c]) || w.stars !== expect[c]) bad.push(`${c}: heat ${w.heat} stars ${w.stars}`);
  }
  check('各犯行（witnessed）heat = HEAT[crime]、星數依 STAR_HEAT 換算', bad.length === 0, bad.join('; '));

  // 累加：killPolice ×2 = 6 → 3 星；再 + kill ×3 = 10.5 → 4 星；再 ×3 killPolice = 19.5 → 5 星（上限）
  const { w, log } = make();
  w.report(CRIMES.killPolice, { x: 0, z: 0, witnessed: true });
  w.report(CRIMES.killPolice, { x: 0, z: 0, witnessed: true });
  check('累加 heat 6 → 3 星', near(w.heat, 6) && w.stars === 3);
  for (let i = 0; i < 3; i++) w.report(CRIMES.kill, { x: 0, z: 0, witnessed: true });
  check('累加 heat 10.5 → 4 星', near(w.heat, 10.5) && w.stars === 4);
  for (let i = 0; i < 3; i++) w.report(CRIMES.killPolice, { x: 0, z: 0, witnessed: true });
  check('星數上限 5', w.stars === 5 && near(w.heat, 19.5));
  const ch = log.filter((e) => e.name === 'wanted:change');
  check(
    'wanted:change 只在星數變化時發、payload 完整',
    ch.length === 4 && ch.map((e) => `${e.prev}>${e.stars}`).join() === '0>2,2>3,3>4,4>5' && ch.every((e) => typeof e.heat === 'number' && typeof e.reason === 'string') && ch[0].reason === 'killPolice',
    ch.map((e) => `${e.prev}>${e.stars}:${e.reason}`).join()
  );
  const st = log.filter((e) => e.name === 'wanted:state');
  check('首次上星 → wanted:state clear → active', st.length === 1 && st[0].prev === 'clear' && st[0].state === 'active' && w.state === 'active');
}
{
  // witnessed=false：0.5 倍、至少 1 星
  const { w } = make();
  w.report(CRIMES.gunfire, { x: 5, z: 6, witnessed: false });
  check('witnessed=false：heat × 0.5 且至少 1 星', near(w.heat, HEAT.gunfire * 0.5) && w.stars === 1, `heat ${w.heat} stars ${w.stars}`);
  const { w: w2 } = make();
  w2.report(CRIMES.killPolice, { x: 0, z: 0, witnessed: false });
  w2.report(CRIMES.killPolice, { x: 0, z: 0, witnessed: false });
  check('witnessed=false：killPolice ×2 → heat 3 → 2 星', near(w2.heat, 3) && w2.stars === 2);
  // lastKnown：被看見才更新；路人報案只在尚無位置時採用
  const { w: w3 } = make();
  w3.report(CRIMES.assault, { x: 10, z: 20, witnessed: true });
  w3.report(CRIMES.assault, { x: 99, z: 99, witnessed: false });
  check('lastKnown：被看見犯行時更新、路人報案不覆蓋', w3.lastKnown.x === 10 && w3.lastKnown.z === 20);
  w3.report(CRIMES.assault, { x: 30, z: 40, witnessed: true });
  check('lastKnown：再次被看見 → 更新', w3.lastKnown.x === 30 && w3.lastKnown.z === 40);
}
{
  // 只升不降：gunfire 被看見（0 星）不會把已有星數降下；heat 只增
  const { w } = make();
  w.setStars(3);
  w.report(CRIMES.gunfire, { x: 0, z: 0, witnessed: true });
  check('星數只升不降（3 星 + gunfire 仍 3 星）', w.stars === 3 && near(w.heat, 6.4));
  const { w: w2 } = make();
  w2.report(CRIMES.gunfire, { x: 0, z: 0, witnessed: false }); // 1 星（heat 0.2）
  w2.report(CRIMES.gunfire, { x: 0, z: 0, witnessed: true }); // heat 0.6，換算 1 星
  check('路人保底 1 星後再有犯行不掉星', w2.stars === 1);
  // 長時間 seen 的 update 不降星
  run(w, 60, 1 / 60, { playerX: 0, playerZ: 0, seen: true });
  check('update 不會降星（seen 60 s）', w.stars === 3 && w.state === 'active');
  w.report('jaywalk', { x: 0, z: 0 });
  check('未知犯行忽略', w.stars === 3 && near(w.heat, 6.4));
}

// ======================= 2. 狀態機 =======================
{
  const { w, log } = make();
  w.report(CRIMES.kill, { x: 0, z: 0, witnessed: true }); // 1 星：EVADE 10 s，3 s 後 searching
  const far = { playerX: 1000, playerZ: 0, seen: false };
  const lim = EVADE_SEC[1] * SEARCH_AFTER_FRAC;
  run(w, lim - 0.05, 1 / 60, far);
  check('active：unseen 未滿 EVADE×0.3 仍 active、不閃', w.state === 'active' && !w.flashing && w.searchCircle === null);
  run(w, 0.1, 1 / 60, far);
  check('active：unseen 超過 EVADE×0.3 → searching、flashing', w.state === 'searching' && w.flashing);
  check('searching：wanted:state active → searching', log.some((e) => e.name === 'wanted:state' && e.prev === 'active' && e.state === 'searching'));

  // searching 中 seen → 回 active + wanted:spotted
  log.length = 0;
  w.update(1 / 60, { playerX: 7, playerZ: 8, seen: true });
  check('searching 中 seen → active、不閃', w.state === 'active' && !w.flashing);
  const sp = log.find((e) => e.name === 'wanted:spotted');
  check('wanted:spotted { x, z } = 被看見位置', sp && sp.x === 7 && sp.z === 8);
  check('seen → lastKnown 更新為玩家位置', w.lastKnown.x === 7 && w.lastKnown.z === 8);
  check('事件順序：state 先於 spotted', log.map((e) => e.name).join() === 'wanted:state,wanted:spotted');

  // seen 重置 unseenTimer：再來 2.9 s unseen + seen + 2.9 s unseen 仍 active
  run(w, 2.9, 1 / 60, far);
  w.update(1 / 60, { playerX: 0, playerZ: 0, seen: true });
  run(w, 2.9, 1 / 60, far);
  check('seen 使 unseenTimer 歸零', w.state === 'active');

  // 圈外：searching 後 EVADE_SEC 秒 → evaded
  run(w, 0.2, 1 / 60, far);
  check('再進 searching', w.state === 'searching');
  log.length = 0;
  run(w, EVADE_SEC[1] - 0.3, 1 / 60, far);
  check('圈外：searching 未滿 EVADE_SEC 仍通緝', w.state === 'searching' && w.stars === 1);
  run(w, 0.3, 1 / 60, far);
  check('圈外：searching 累計 EVADE_SEC → evaded（clear）', w.state === 'clear' && w.stars === 0 && w.heat === 0 && w.lastKnown === null);
  check('evaded 事件含 cleared reason evaded', log.some((e) => e.name === 'wanted:cleared' && e.reason === 'evaded'));
}
{
  // 圈內 0.25 倍速：2 星 EVADE 15 s；圈外需 15 s、圈內需 60 s
  const { w } = make();
  w.setStars(2);
  w.update(1 / 60, { playerX: 0, playerZ: 0, seen: true }); // lastKnown = (0,0)
  const inside = { playerX: 10, playerZ: 0, seen: false };
  run(w, EVADE_SEC[2] * SEARCH_AFTER_FRAC + 0.05, 1 / 60, inside);
  check('圈內也會進 searching', w.state === 'searching');
  run(w, EVADE_SEC[2] * 1.5, 1 / 60, inside);
  check('圈內：經過 1.5 × EVADE_SEC 仍未脫逃（0.25 倍速）', w.state === 'searching');
  run(w, EVADE_SEC[2] / INSIDE_SEARCH_RATE - EVADE_SEC[2] * 1.5 + 0.1, 1 / 60, inside);
  check('圈內：EVADE_SEC / 0.25 秒後脫逃', w.state === 'clear');
}

// ======================= 3. searchCircle 與 clear =======================
{
  const radii = [];
  for (let n = 1; n <= 5; n++) {
    const { w } = make();
    w.setStars(n);
    w.update(0.01, { playerX: 3, playerZ: -4, seen: true });
    run(w, EVADE_SEC[n] * SEARCH_AFTER_FRAC + 0.05, 1 / 60, { playerX: 2000, playerZ: 0, seen: false });
    const c = w.searchCircle;
    radii.push(c ? c.r : null);
    if (!c || c.x !== 3 || c.z !== -4) radii.push('bad-center');
  }
  check(
    'searchCircle：r = 80 + 40×stars、圓心 = lastKnown',
    radii.join() === [1, 2, 3, 4, 5].map((n) => CIRCLE_BASE_R + CIRCLE_PER_STAR_R * n).join(),
    radii.join()
  );
  const { w } = make();
  check('searchCircle：clear 時為 null', w.searchCircle === null);
  w.setStars(2);
  check('searchCircle：active 時為 null', w.searchCircle === null);
}
{
  for (const reason of ['evaded', 'busted', 'wasted', 'debug']) {
    const { w, log } = make();
    w.report(CRIMES.killPolice, { x: 1, z: 1, witnessed: true });
    log.length = 0;
    w.clear(reason);
    const seq = log.map((e) => e.name).join();
    const ch = log[0];
    const st = log[1];
    check(
      `clear('${reason}')：change → state → cleared`,
      seq === 'wanted:change,wanted:state,wanted:cleared' &&
        ch.stars === 0 && ch.prev === 2 && ch.heat === 0 && ch.reason === reason &&
        st.state === 'clear' && st.prev === 'active' && log[2].reason === reason &&
        w.stars === 0 && w.heat === 0 && w.state === 'clear' && !w.flashing && w.lastKnown === null,
      seq
    );
  }
  // searching 中 clear：state.prev = searching、flashing 關閉
  const { w, log } = make();
  w.setStars(1);
  run(w, 4, 1 / 60, { playerX: 0, playerZ: 0, seen: false });
  log.length = 0;
  w.clear('busted');
  check('searching 中 clear：state prev = searching、flashing 關', log[1].prev === 'searching' && !w.flashing);
  // 0 星時 clear：只發 cleared
  const { w: w2, log: l2 } = make();
  w2.clear('debug');
  check('0 星 clear：只發 wanted:cleared', l2.map((e) => e.name).join() === 'wanted:cleared');
  // clear 後可再被通緝
  w.report(CRIMES.carjack, { x: 0, z: 0, witnessed: true });
  check('clear 後再犯 → 重新 1 星 active', w.stars === 1 && w.state === 'active' && near(w.heat, 1));
}

// ======================= 4. 幀率無關 =======================
{
  // 劇本：3 星，0–2 s 被看見，之後一路逃（圈內 6 s 再出圈）；記錄進 searching 與脫逃完成時間
  function scenario(dt) {
    const { w } = make();
    w.setStars(3);
    let t = 0;
    let tSearch = null;
    let tClear = null;
    while (t < 120 && tClear === null) {
      const seen = t < 2;
      const playerX = t < 2 ? 0 : t < 2 + EVADE_SEC[3] * SEARCH_AFTER_FRAC + 6 ? 50 : 500;
      w.update(dt, { playerX, playerZ: 0, seen });
      t += dt;
      if (tSearch === null && w.state === 'searching') tSearch = t;
      if (w.state === 'clear') tClear = t;
    }
    return { tSearch, tClear };
  }
  const a = scenario(1 / 60);
  const b = scenario(1 / 144);
  const errS = Math.abs(a.tSearch - b.tSearch) / a.tSearch;
  const errC = Math.abs(a.tClear - b.tClear) / a.tClear;
  check('幀率無關：進 searching 時間 60 vs 144 Hz 誤差 < 5%', errS < 0.05, `${a.tSearch.toFixed(4)} vs ${b.tSearch.toFixed(4)}`);
  check('幀率無關：脫逃完成時間 60 vs 144 Hz 誤差 < 5%', a.tClear !== null && b.tClear !== null && errC < 0.05, `${a.tClear?.toFixed(4)} vs ${b.tClear?.toFixed(4)}`);
  // 理論值：2 + 6.6（→ searching）+ 圈內 6 s×0.25 = 1.5 進度 + 圈外剩 20.5 s ≈ 2 + 6.6 + 6 + 20.5 = 35.1
  check('幀率無關：脫逃時間接近理論值 35.1 s', Math.abs(a.tClear - 35.1) < 0.05 && Math.abs(b.tClear - 35.1) < 0.05, `${a.tClear.toFixed(3)} / ${b.tClear.toFixed(3)}`);
}
{
  // dt = 0.5 被 clamp 到 MAX_DT：1 星 active，3 s 門檻；一幀 0.5 只算 0.1，不跳狀態
  const { w, log } = make();
  w.setStars(1);
  log.length = 0;
  w.update(0.5, { playerX: 1000, playerZ: 0, seen: false });
  check('dt=0.5：被 clamp，一幀不跳狀態', w.state === 'active' && log.length === 0);
  // 29 幀 × 0.5（≈ 2.9 s 有效）仍 active；第 30、31 幀後才 searching
  for (let i = 0; i < 28; i++) w.update(0.5, { playerX: 1000, playerZ: 0, seen: false });
  check('dt=0.5 ×29 幀 = 有效 2.9 s → 仍 active', w.state === 'active');
  w.update(0.5, { playerX: 1000, playerZ: 0, seen: false });
  w.update(0.5, { playerX: 1000, playerZ: 0, seen: false });
  check('dt=0.5 ×31 幀 = 有效 3.1 s → searching', w.state === 'searching');
  // searching 下一幀 0.5 不會直接脫逃
  const before = w.stars;
  w.update(0.5, { playerX: 1000, playerZ: 0, seen: false });
  check('dt=0.5 searching：一幀不脫逃', w.state === 'searching' && w.stars === before);
  check('MAX_DT = 0.1', MAX_DT === 0.1);
}

// ======================= 5. setStars / 0 星 update =======================
{
  const { w, log } = make();
  let threw = null;
  try {
    w.update(1 / 60, { playerX: 0, playerZ: 0, seen: true });
    w.update(1 / 60, { playerX: 0, playerZ: 0, seen: false });
    w.update(0.5);
    w.update(NaN, {});
    w.update();
  } catch (err) {
    threw = err;
  }
  check('0 星 update：不丟例外、不發事件、維持 clear', !threw && log.length === 0 && w.state === 'clear' && w.stars === 0 && w.lastKnown === null);

  w.setStars(4);
  check('setStars(4)：heat = STAR_HEAT[4]、active', w.stars === 4 && w.heat === STAR_HEAT[4] && w.state === 'active');
  const ch = log.find((e) => e.name === 'wanted:change');
  check('setStars：wanted:change reason debug', ch && ch.reason === 'debug' && ch.prev === 0 && ch.stars === 4);
  w.setStars(2);
  check('setStars(2)：除錯可降星', w.stars === 2 && w.heat === STAR_HEAT[2]);
  w.setStars(9);
  check('setStars(9)：夾到 5', w.stars === 5 && w.heat === STAR_HEAT[5]);
  log.length = 0;
  w.setStars(0);
  check('setStars(0)：等同 clear(debug)', w.stars === 0 && w.state === 'clear' && log.some((e) => e.name === 'wanted:cleared' && e.reason === 'debug'));
  // 無 bus 也能運作
  const w2 = createWanted();
  let threw2 = null;
  try {
    w2.report(CRIMES.kill, { x: 0, z: 0, witnessed: true });
    run(w2, 50, 1 / 30, { playerX: 900, playerZ: 0, seen: false });
  } catch (err) {
    threw2 = err;
  }
  check('無 bus：可運作且能脫逃', !threw2 && w2.state === 'clear');
  // 搜尋中無 lastKnown（setStars 後從未被看見）→ 以進入搜尋時玩家位置當圓心
  const { w: w3 } = make();
  w3.setStars(1);
  run(w3, 3.1, 1 / 60, { playerX: 12, playerZ: 34, seen: false });
  const c = w3.searchCircle;
  check('無 lastKnown 進 searching：圓心 = 當下玩家位置', c && c.x === 12 && c.z === 34 && c.r === 120);
}

// ======================= 審查 🟡 wanted.js:124：searching 中被警力目擊犯行 → 回 active、計時歸零 =======================
{
  const { w, log } = make();
  w.report(CRIMES.kill, { x: 0, z: 0, witnessed: true });
  run(w, 10, 1 / 60, { playerX: 0, playerZ: 0, seen: false });
  check('前置：unseen 進 searching', w.state === 'searching');
  log.length = 0;
  w.report(CRIMES.kill, { x: 500, z: 0, witnessed: true });
  check('searching 中 witnessed 犯行 → active、lastKnown = 犯行位置、emit wanted:spotted',
    w.state === 'active' && w.lastKnown.x === 500 && log.some((e) => e.name === 'wanted:spotted' && e.x === 500));
  let clearAt = 0;
  const { w: w2 } = make();
  w2.report(CRIMES.kill, { x: 0, z: 0, witnessed: true });
  run(w2, 10, 1 / 60, { playerX: 0, playerZ: 0, seen: false });
  w2.report(CRIMES.kill, { x: 500, z: 0, witnessed: true });
  while (w2.state !== 'clear' && clearAt < 120) {
    w2.update(1 / 60, { playerX: 900, playerZ: 0, seen: false });
    clearAt += 1 / 60;
  }
  // 2 星：active 4.5 s + searching 15 s（圈外全速）
  check('searching 中 witnessed 犯行後須重新走完 active → searching 才脫逃', clearAt >= EVADE_SEC[2] * (1 + SEARCH_AFTER_FRAC) - 0.05, `clear after ${clearAt.toFixed(1)}s`);
  // 路人報案（witnessed=false）不改變 searching
  const { w: w3 } = make();
  w3.report(CRIMES.kill, { x: 0, z: 0, witnessed: true });
  run(w3, 10, 1 / 60, { playerX: 0, playerZ: 0, seen: false });
  w3.report(CRIMES.assault, { x: 500, z: 0, witnessed: false });
  check('searching 中路人報案 → 仍 searching', w3.state === 'searching');
}

console.log(failed === 0 ? `PASS ${passed}/${passed + failed}` : `FAIL ${failed}/${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
