#!/usr/bin/env node
// P19 飛車搶包無頭驗證：純邏輯（不 import three / rapier，容器無 node_modules 也能跑）
// 用法：node tools/test/p19-snatch.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：車速 / 距離門檻、僅機車、包包機率穩定與分布、金額範圍與穩定、同一行人只能被搶一次、
//   連擊倍率與 30 s 逾時重置、摔車掉錢（翻覆 / 速度瞬降）、通緝加星規則（真 wanted）、幫派敵意（真 gangs）、
//   統計與存檔相容（真 economy / save：缺欄位視 0）、掃描間隔、cancel
import { createBus } from '../../src/core/events.js';
import {
  createSnatch, hashId, hasBag, bagAmount, comboMult,
  SNATCH_SPEED_MIN, SNATCH_RADIUS, SNATCH_MIN, SNATCH_MAX, COMBO_WINDOW, COMBO_MULTS,
  CRASH_SPEED_DROP, SCAN_INTERVAL, SNATCH_PROMPT, CRIME_SNATCH, CRIME_SNATCH_COMBO,
} from '../../src/snatch.js';
import { createEconomy } from '../../src/economy.js';
import { validateSave, defaultSave } from '../../src/save.js';
import { createWanted } from '../../src/wanted/wanted.js';
import { createGangs } from '../../src/gangs.js';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// 行人替身：{ actor: { id, pos }, citizen, brain }（同 traffic.peds 的最小形狀）
function makePed(id, x = 0, z = 0, citizen = {}) {
  const ped = {
    actor: { id, pos: { x, y: 0, z } },
    citizen,
    brain: { fled: 0, onThreatened() { ped.brain.fled++; } },
  };
  return ped;
}
const ctxOf = (over = {}) => ({ riding: true, type: 'scooter', speed: 10, overturned: false, x: 0, z: 0, peds: [], frozen: false, ...over });
// 找一個身上有 / 沒有包包的行人 id
function findId(want) {
  for (let i = 1; i < 10000; i++) if (hasBag(i) === want) return i;
  throw new Error('找不到合適的行人 id');
}

// ---------- 純函式：雜湊穩定、機率、金額、倍率 ----------
{
  check('hashId 穩定且與 salt 有關', hashId(7, 'bag') === hashId(7, 'bag') && hashId(7, 'bag') !== hashId(7, 'amount'));
  let stable = true;
  for (let i = 0; i < 500; i++) if (hasBag(i) !== hasBag(i) || bagAmount(i) !== bagAmount(i)) stable = false;
  check('同一行人 id 的包包 / 金額每次相同（純邏輯，不耗 rng）', stable);

  let bags = 0;
  for (let i = 0; i < 4000; i++) if (hasBag(i)) bags++;
  const rate = bags / 4000;
  check('包包機率約 60%', rate > 0.55 && rate < 0.65, `實測 ${(rate * 100).toFixed(1)}%`);

  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < 4000; i++) {
    const a = bagAmount(i);
    lo = Math.min(lo, a);
    hi = Math.max(hi, a);
  }
  check(`金額落在 NT$${SNATCH_MIN}–${SNATCH_MAX}（含兩端）`, lo >= SNATCH_MIN && hi <= SNATCH_MAX && lo === SNATCH_MIN && hi === SNATCH_MAX, `${lo}–${hi}`);

  check('連擊倍率 1 / 1.5 / 2 / 3，上限 3',
    comboMult(1) === 1 && comboMult(2) === 1.5 && comboMult(3) === 2 && comboMult(4) === 3 && comboMult(99) === 3,
    COMBO_MULTS.join(' / '));
}

// ---------- 門檻：車速、距離、僅機車 ----------
{
  const id = findId(true);
  const near = () => [makePed(id, SNATCH_RADIUS - 0.1, 0)];
  const far = () => [makePed(id, SNATCH_RADIUS + 0.1, 0)];

  const s1 = createSnatch({});
  s1.update(0.1, ctxOf({ speed: SNATCH_SPEED_MIN - 0.1, peds: near() }));
  check(`車速 < ${SNATCH_SPEED_MIN} m/s 不給搶`, s1.target === null && s1.prompt === null);

  const s2 = createSnatch({});
  s2.update(0.1, ctxOf({ speed: SNATCH_SPEED_MIN, peds: near() }));
  check(`車速 ≥ ${SNATCH_SPEED_MIN} m/s 且 ${SNATCH_RADIUS} m 內鎖定行人`, s2.target !== null && s2.prompt === SNATCH_PROMPT);

  const s3 = createSnatch({});
  s3.update(0.1, ctxOf({ peds: far() }));
  check(`超過 ${SNATCH_RADIUS} m 不鎖定`, s3.target === null);

  const s4 = createSnatch({});
  s4.update(0.1, ctxOf({ type: 'sedan', peds: near() }));
  check('汽車不能搶包（僅機車）', s4.target === null && s4.act() === null);

  const s5 = createSnatch({});
  s5.update(0.1, ctxOf({ riding: false, peds: near() }));
  check('步行不能搶包', s5.target === null);

  const s6 = createSnatch({});
  s6.update(0.1, ctxOf({ overturned: true, peds: near() }));
  check('機車倒地中不能搶包', s6.target === null);

  // 倒車（speed 為負）同樣以絕對值判斷
  const s7 = createSnatch({});
  s7.update(0.1, ctxOf({ speed: -10, peds: near() }));
  check('車速取絕對值（倒車也算）', s7.target !== null);
}

// ---------- 成功 / 失敗、逃跑、只能被搶一次 ----------
{
  const bus = createBus();
  const evs = [];
  bus.on('snatch:success', (e) => evs.push(['success', e]));
  bus.on('snatch:fail', (e) => evs.push(['fail', e]));
  const id = findId(true);
  const ped = makePed(id, 1, 0);
  // flee 轉接同 main.js：ped.brain.onThreatened({ pos })
  const s = createSnatch({ bus, adapters: { flee: (p) => p.brain.onThreatened({ pos: { x: 0, z: 0 } }) } });
  s.update(0.1, ctxOf({ peds: [ped] }));
  const r = s.act();
  check('有包 → success 事件（pedId / amount / combo / mult）',
    r === 'success' && evs.length === 1 && evs[0][0] === 'success'
    && evs[0][1].pedId === id && evs[0][1].combo === 1 && evs[0][1].mult === 1
    && evs[0][1].amount === bagAmount(id));
  check('被搶的行人尖叫逃跑（brain.onThreatened）', ped.brain.fled === 1);
  check('永久標記已被搶（citizen.snatched）', ped.citizen.snatched === true);
  s.update(0.1, ctxOf({ peds: [ped] }));
  check('同一行人只能被搶一次', s.target === null && s.act() === null);

  const noBagId = findId(false);
  const ped2 = makePed(noBagId, 1, 0);
  const s2 = createSnatch({ bus });
  s2.update(0.1, ctxOf({ peds: [ped2] }));
  const r2 = s2.act();
  check('沒包 → fail 事件、不給錢、不計連擊', r2 === 'fail' && evs[evs.length - 1][0] === 'fail' && s2.combo === 0);
  s2.update(0.1, ctxOf({ peds: [ped2] }));
  check('沒包的行人也標記已被搶（不能重複試）', s2.target === null);
}

// ---------- 連擊倍率與 30 s 逾時重置 ----------
{
  const bus = createBus();
  const got = [];
  bus.on('snatch:success', (e) => got.push(e));
  const s = createSnatch({ bus });
  const ids = [];
  for (let i = 1; ids.length < 5; i++) if (hasBag(i)) ids.push(i);
  for (const id of ids) {
    s.update(0.1, ctxOf({ peds: [makePed(id, 1, 0)] }));
    s.act();
  }
  check('連擊倍率依序 1 / 1.5 / 2 / 3 / 3（上限 3）',
    got.map((e) => e.mult).join(',') === '1,1.5,2,3,3', got.map((e) => e.mult).join(','));
  check('入帳金額 = 基礎金額 × 倍率（四捨五入）',
    got.every((e, i) => e.amount === Math.round(bagAmount(ids[i]) * e.mult)));
  check('HUD 取用的 combo / mult', s.combo === 5 && s.mult === 3);

  // 逾時：連擊計時在凍結中照樣推進（以模擬秒數為準）
  for (let t = 0; t < COMBO_WINDOW; t += 0.5) s.update(0.5, ctxOf({ frozen: true }));
  check(`${COMBO_WINDOW} s 內沒有再成功 → 連擊重置`, s.combo === 0 && s.mult === 1);

  const s2 = createSnatch({});
  const two = [];
  for (let i = 1; two.length < 2; i++) if (hasBag(i)) two.push(i);
  s2.update(0.1, ctxOf({ peds: [makePed(two[0], 1, 0)] }));
  s2.act();
  for (let t = 0; t < COMBO_WINDOW - 1; t += 0.5) s2.update(0.5, ctxOf({ frozen: true }));
  s2.update(0.1, ctxOf({ peds: [makePed(two[1], 1, 0)] }));
  s2.act();
  check('逾時前再次成功 → 連擊續接（×1.5）且計時重新起算', s2.combo === 2 && s2.mult === 1.5);
}

// ---------- 摔車掉錢 ----------
{
  const run = (crashCtx) => {
    const bus = createBus();
    const drops = [];
    bus.on('snatch:drop', (e) => drops.push(e));
    const s = createSnatch({ bus });
    const id = findId(true);
    s.update(0.1, ctxOf({ peds: [makePed(id, 1, 0)] }));
    s.act();
    const amount = bagAmount(id);
    s.update(0.1, ctxOf(crashCtx));
    return { drops, amount, s };
  };

  const a = run({ speed: 10 - CRASH_SPEED_DROP - 0.5 });
  check(`車速瞬降 > ${CRASH_SPEED_DROP} m/s → 掉最近一次搶得金額的一半`,
    a.drops.length === 1 && a.drops[0].amount === Math.floor(a.amount / 2), JSON.stringify(a.drops[0] || null));
  check('摔車後連擊重置', a.s.combo === 0);

  const b = run({ overturned: true });
  check('車輛翻覆 → 同樣掉錢並重置連擊', b.drops.length === 1 && b.drops[0].amount === Math.floor(b.amount / 2) && b.s.combo === 0);

  // 翻覆持續中不重複掉錢（只在 false → true 的那一幀）
  b.s.update(0.1, ctxOf({ overturned: true }));
  check('翻覆持續中不重複掉錢', b.drops.length === 1);

  const c = run({ speed: 10 - CRASH_SPEED_DROP + 0.5 });
  check(`車速瞬降 ≤ ${CRASH_SPEED_DROP} m/s 不算摔車`, c.drops.length === 0 && c.s.combo === 1);

  // 還沒搶到錢就摔車 → 不發事件
  const bus = createBus();
  const drops = [];
  bus.on('snatch:drop', (e) => drops.push(e));
  const s = createSnatch({ bus });
  s.update(0.1, ctxOf({ speed: 12 }));
  s.update(0.1, ctxOf({ speed: 0 }));
  check('沒搶過錢 → 摔車不發 snatch:drop', drops.length === 0);
}

// ---------- 連擊逾時後摔車不再掉錢（lastAmount 隨 resetCombo 歸零） ----------
{
  const bus = createBus();
  const drops = [];
  bus.on('snatch:drop', (e) => drops.push(e));
  const s = createSnatch({ bus });
  s.update(0.1, ctxOf({ peds: [makePed(findId(true), 1, 0)] }));
  s.act();
  for (let t = 0; t < 20 * 60; t += 0.5) s.update(0.5, ctxOf({ riding: false, type: null, speed: 0 })); // 下車逛 20 分鐘
  check('連擊逾時 → combo 歸零', s.combo === 0);
  s.update(0.1, ctxOf({ speed: 10 }));
  s.update(0.1, ctxOf({ overturned: true }));
  check('連擊逾時後再翻覆 → 不發 snatch:drop', drops.length === 0, JSON.stringify(drops));
  s.crash();
  check('連擊逾時後 crash() → 不發 snatch:drop', drops.length === 0);
}

// ---------- 公開 crash()：機車倒地當幀即下車（main.js handleFall 順序） ----------
{
  const bus = createBus();
  const drops = [];
  bus.on('snatch:drop', (e) => drops.push(e));
  const s = createSnatch({ bus });
  const id = findId(true);
  const ctx = ctxOf({ speed: 15, peds: [makePed(id, 1, 0)] });
  s.update(1 / 60, ctx);
  check('搶包成功（連擊 1）', s.act() === 'success' && s.combo === 1);
  // handleFall：先 snatch.crash() 再 exitVehicle(true)，之後 updateSnatch 看到的是步行
  s.crash();
  Object.assign(ctx, { riding: false, type: null, speed: 0, peds: [] });
  for (let i = 0; i < 200; i++) s.update(1 / 60, ctx);
  check('倒地下車 → 掉一半並重置連擊', drops.length === 1 && drops[0].amount === Math.floor(bagAmount(id) / 2) && s.combo === 0,
    JSON.stringify(drops));
  s.crash();
  check('同一筆不重複掉（再 crash() 不發事件）', drops.length === 1);
}

// ---------- 通緝加星規則（真 wanted） ----------
{
  const bus = createBus();
  const wanted = createWanted({ bus });
  const crimes = [];
  const s2 = createSnatch({ bus, adapters: { reportCrime: (c, o) => { crimes.push(c); wanted.report(c, o); } } });

  const ids = [];
  for (let i = 1; ids.length < 3; i++) if (hasBag(i)) ids.push(i);
  s2.update(0.1, ctxOf({ peds: [makePed(ids[0], 1, 0)] }));
  s2.act();
  check('第 1 次搶包 → 1 星', wanted.stars === 1, `stars=${wanted.stars}`);
  s2.update(0.1, ctxOf({ peds: [makePed(ids[1], 1, 0)] }));
  s2.act();
  check('連擊 2 仍為 1 星', wanted.stars === 1);
  s2.update(0.1, ctxOf({ peds: [makePed(ids[2], 1, 0)] }));
  s2.act();
  check('連擊 ≥ 3 → 2 星', wanted.stars === 2, `stars=${wanted.stars}`);
  check('犯行代號 snatch / snatch / snatchCombo',
    crimes.join(',') === `${CRIME_SNATCH},${CRIME_SNATCH},${CRIME_SNATCH_COMBO}`, crimes.join(','));

  // 沒包（fail）不報案
  const before = crimes.length;
  const noBag = findId(false);
  s2.update(0.1, ctxOf({ peds: [makePed(noBag, 1, 0)] }));
  s2.act();
  check('沒搶到（沒包）不加熱度', crimes.length === before);
}

// ---------- 幫派敵意（真 gangs） ----------
{
  const bus = createBus();
  const gangs = createGangs({ bus, rng: () => 0.5 });
  const gangId = gangs.gangs[0].id;
  const id = findId(true);
  const ped = makePed(id, 1, 0, { look: { shirt: '#fff', pants: '#000', skin: '#eee' } });
  const enlisted = gangs.enlist([ped], gangId, { gain: 0 });
  check('替身行人可登記為幫派成員（enlist）', enlisted.length === 1 && !!ped.citizen.gang);

  const before = gangs.hostility(gangId);
  const s = createSnatch({ bus, adapters: { provokeGang: (p) => gangs.provokeActor(p && p.actor, 'snatch') } });
  s.update(0.1, ctxOf({ peds: [ped] }));
  s.act();
  check('搶到幫派成員 → 該幫敵意上升（沿用 provoke 慣例）',
    gangs.hostility(gangId) > before, `${before} → ${gangs.hostility(gangId)}`);

  // 非幫派行人不碰 gangs
  let called = 0;
  const s2 = createSnatch({ adapters: { provokeGang: () => { called++; } } });
  const plain = makePed(findId(true) + 1000, 1, 0);
  s2.update(0.1, ctxOf({ peds: [plain] }));
  s2.act();
  check('一般市民不觸發幫派敵意', called === 0);
}

// ---------- 統計與存檔相容（真 economy / save） ----------
{
  const bus = createBus();
  const economy = createEconomy({ bus });
  const money0 = economy.money;
  const s = createSnatch({ bus });
  const ids = [];
  for (let i = 1; ids.length < 2; i++) if (hasBag(i)) ids.push(i);
  let expect = 0;
  for (const id of ids) {
    s.update(0.1, ctxOf({ peds: [makePed(id, 1, 0)] }));
    s.act();
  }
  expect = Math.round(bagAmount(ids[0]) * 1) + Math.round(bagAmount(ids[1]) * 1.5);
  check('economy 統計：搶包次數與金額', economy.stats.snatches === 2 && economy.stats.snatchMoney === expect,
    `${economy.stats.snatches} 次 / ${economy.stats.snatchMoney}（預期 ${expect}）`);
  check('搶包金額實際入帳', economy.money === money0 + expect);

  // 摔車掉錢：扣款（餘額不足扣到 0）
  const moneyBefore = economy.money;
  bus.emit('snatch:drop', { amount: 40 });
  check('snatch:drop → economy 扣款', economy.money === moneyBefore - 40);

  check('存檔 snapshot 帶出搶包統計', economy.snapshot().stats.snatches === 2);

  const clean = validateSave({ version: 2, money: 100, stats: { playTimeSec: 1 } });
  check('舊存檔缺 snatches / snatchMoney → 視為 0', clean.stats.snatches === 0 && clean.stats.snatchMoney === 0);
  check('defaultSave 含搶包統計欄位', defaultSave().stats.snatches === 0 && defaultSave().stats.snatchMoney === 0);
  const kept = validateSave({ version: 2, money: 100, stats: { snatches: 7, snatchMoney: 1234 } });
  check('存檔的搶包統計可讀回', kept.stats.snatches === 7 && kept.stats.snatchMoney === 1234);
  const bad = validateSave({ version: 2, money: 100, stats: { snatches: -5, snatchMoney: 'x' } });
  check('非法統計值 → 0', bad.stats.snatches === 0 && bad.stats.snatchMoney === 0);

  const s2 = createSnatch({});
  s2.restore({ snatches: 7, snatchMoney: 1234 });
  check('snatch.restore 同步顯示用累計值', s2.total === 7 && s2.totalMoney === 1234);
  s2.restore(undefined);
  check('snatch.restore 缺欄位視 0', s2.total === 0 && s2.totalMoney === 0);
}

// ---------- 掃描間隔（不每幀全量掃） ----------
{
  const id = findId(true);
  const ped = makePed(id, 1, 0);
  let scans = 0;
  const peds = new Proxy([ped], {
    get(t, k) {
      if (k === 'length') scans++;
      return Reflect.get(t, k);
    },
  });
  const s = createSnatch({});
  const ctx = ctxOf({ peds });
  s.update(0.05, ctx); // 第 1 幀必掃（還沒有目標）
  const after1 = scans;
  for (let i = 0; i < 3; i++) s.update(0.05, ctx); // 0.15 s：不足 SCAN_INTERVAL，且已有目標
  check(`已鎖定目標時每幀不重掃（間隔 ${SCAN_INTERVAL} s）`, scans === after1, `掃描次數 ${scans}`);
  s.update(0.05, ctx); // 累計 0.2 s → 重掃
  check('超過掃描間隔才重掃', scans > after1);
}

// ---------- 無目標時同樣只依掃描間隔（不每幀全量掃） ----------
{
  let scans = 0;
  const peds = new Proxy([makePed(findId(true), 50, 0)], {
    get(t, k) {
      if (k === '0') scans++; // 每次掃描讀一次 peds[0]（length 每次掃描讀兩次，不適合計數）
      return Reflect.get(t, k);
    },
  });
  const s = createSnatch({});
  const ctx = ctxOf({ peds });
  for (let i = 0; i < 60; i++) s.update(1 / 60, ctx); // 1 s、範圍內沒有行人
  check(`無目標 1 s 內掃描次數 ≤ 6（間隔 ${SCAN_INTERVAL} s）`, s.target === null && scans >= 1 && scans <= 6, `掃描次數 ${scans}`);
}

// ---------- cancel ----------
{
  const s = createSnatch({});
  const id = findId(true);
  const ped = makePed(id, 1, 0);
  s.update(0.1, ctxOf({ peds: [ped] }));
  s.act();
  check('cancel 前有連擊與統計', s.combo === 1 && s.total === 1);
  s.cancel();
  check('cancel → 連擊 / 目標 / 累計歸零', s.combo === 0 && s.target === null && s.total === 0 && s.totalMoney === 0 && s.prompt === null);
  const fresh = makePed(id, 1, 0); // 開新局後世界重建：同 id 的行人可以再被搶
  s.update(0.1, ctxOf({ peds: [fresh] }));
  check('cancel 清掉已被搶名單', s.target !== null && s.act() === 'success');
  s.update(0.1, null);
  check('ctx 為 null 不丟例外', s.target === null);
}

// ---------- cancel 清 citizen.snatched（Traffic 全程只建一次，同一位市民物件跨局沿用） ----------
{
  const s = createSnatch({});
  const ped = makePed(findId(true), 1, 0);
  s.update(0.1, ctxOf({ peds: [ped] }));
  s.act();
  check('搶過 → citizen.snatched 標記', ped.citizen.snatched === true);
  s.cancel();
  check('cancel → citizen.snatched 清除', !ped.citizen.snatched);
  s.update(0.1, ctxOf({ peds: [ped] }));
  check('cancel 後同一位市民（同物件）可再被鎖定並搶', s.target === ped && s.act() === 'success');
}

console.log(`${failed ? 'FAIL' : 'PASS'} ${passed}/${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
