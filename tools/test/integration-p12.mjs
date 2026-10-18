#!/usr/bin/env node
// Phase 12 整合驗證：街頭競速接線（main.js 原始碼字串比對 + 抽出競速段以替身執行；不 import three / rapier）
// 用法：node tools/test/integration-p12.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：import / 常數、建立 races / rivalWorld / raceHud / 光柱池、collectMarkers 併入旗幟、updateRace 緊接 updateVigilante、
//   倒數鎖定玩家車、駕駛中互動鍵 raceInteractable 優先、互斥（state.racing 併入 otherMissionBusy / 搶劫守門、vigHooks.active / end 包裝）、
//   存檔 races.serialize / restore、quitToMenu / startGame → cancelRace、window.__game；
//   行為（抽段 + 替身）：起點外 / 步行無互動、有星數 toast 不開賽、其他任務 / 警車任務中不可開賽、開賽 → 倒數 → 對手車生成、凍結條件、
//   vigHooks.active / end 併入、HUD、下車 10 s 退賽、cancel 回收、光柱切換；hud.js / marker-colors / big-map / light-pillar / style.css / interfaces.md §34
// 注意：staging 無 node_modules；main.js / hud.js / big-map.js 依賴 three / css / JSON import，一律原始碼字串比對
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBus } from '../../src/core/events.js';
import { createRaces, createRivalWorld, createRaceHud, arrowAngle, promptText, RACES, COUNTDOWN_SEC, LEFT_SEC, TOAST_WANTED, TOAST_MOVING, TOAST_STALLED, TOAST_OVERTURNED, CP_RADIUS } from '../../src/missions/race.js';
import { MARKER_COLORS } from '../../src/map/marker-colors.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(`${ROOT}${p}`, 'utf8');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ---------- 靜態（main.js 原始碼）----------
const mainSrc = read('src/main.js');
const missing = (code, list) => list.filter((s) => !(s instanceof RegExp ? s.test(code) : code.includes(s)));
const GROUPS = [
  ['import：missions/race.js', ["import { createRaces, createRivalWorld, createRaceHud, arrowAngle as raceArrowAngle, promptText as racePromptText, CP_RADIUS as RACE_CP_RADIUS } from './missions/race.js';"]],
  ['常數集中檔頭', [/^const RACE_PRIORITY = \d+;/m, /^const RACE_CP_BEACON = \{ height: \d+, radius: RACE_CP_RADIUS, sink: \d+ \};/m, /^const RACE_SPAWN_PAD = [\d.]+;/m]],
  ['建立 races / rivalWorld / raceHud / 光柱池', [
    'const races = createRaces({ bus, rng: Math.random });',
    'vehicles, dmg, traffic, findRoute: (a, b) => findRoute(graph, a, b), rng: Math.random,',
    'isFree: (x, z) => !buildingAt(x, z, RACE_SPAWN_PAD),',
    'const raceHud = createRaceHud({ root: document.body });',
    'const raceStartBeacons = createBeaconPool({ scene, heightAt });',
    'const raceCpBeacons = createBeaconPool({ scene, heightAt, ...RACE_CP_BEACON });',
  ]],
  ['互斥：state.racing getter 併入警車任務 otherMissionBusy 與搶劫守門', [
    "Object.defineProperty(state, 'racing', { get: () => races.active, enumerable: true, configurable: true });",
    'robberies.active || state.spraying || state.racing);',
    'if (state.racing) robCtx.onFoot = false;',
  ]],
  ['互斥：vigHooks.active（委託類 extraBusy / 噴漆）與 vigHooks.end（BUSTED / WASTED）併入競速', [
    'const vigActiveHook = vigHooks.active;',
    'vigHooks.active = () => vigActiveHook() || races.active;',
    'const vigEndHook = vigHooks.end;',
    /vigHooks\.end = \(kind\) => \{\s*\n\s*vigEndHook\(kind\);\s*\n\s*races\.end\(kind\);/,
  ]],
  ['開賽條件：星數 / 其他任務 / 警車任務', ['const raceBusy = () => otherMissionBusy() || vigilante.active;', 'stars: wanted.stars, busy: raceBusy()']],
  ['小地圖 / 大地圖：collectMarkers 併入 raceMarkers', ['pushAll(out, raceMarkers());', 'return races.markers(raceMk);']],
  ['每幀：updateRace 緊接 updateVigilante、在 updateGangs 之前', [/updateVigilante\(dt, phoneOpen\);\s*\n\s*updateRace\(dt, phoneOpen\);\s*\n\s*updateGangs\(dt, phoneOpen\);/]],
  ['凍結條件：手機 / BUSTED・WASTED / 噴漆 / 搶劫 / 警車任務中（對手車煞停）', [/if \(skip \|\| !!state\.respawn \|\| !!state\.spraying \|\| !!robberies\.active \|\| vigilante\.active\) \{\s*\n\s*rivalWorld\.brakeAll\(\);/]],
  ['ctx：earn = economy.add(race)、車毀 = dmg.healthOf 0、方向箭頭', [
    "earn: (n) => economy.add(n, 'race')",
    'raceCtx.wrecked = !!raceCar && dmg.healthOf(raceCar) === 0;',
    'rivalWorld.update(dt);',
    'raceHud.set(r, r.next ? raceArrowAngle(p.x, p.z, yaw, r.next.x, r.next.z) : 0);',
  ]],
  ['倒數鎖定：races.locked → 玩家車全煞 + 手煞（煞停並維持位置）', [
    /^const RACE_LOCK_CONTROLS = Object\.freeze\(\{ throttle: 0, steer: 0, brake: 1, handbrake: true \}\);/m,
    /if \(races\.locked\) \{\s*\n(\s*\/\/.*\n)?\s*v\.setControls\(RACE_LOCK_CONTROLS\);/,
  ]],
  ['互斥：競速進行中 nearestInteractable 遮掉委託（比照警車任務）', ['interCands[0] = vigilante.active || races.active ? null : missions.nearest(pos);']],
  ['互動鍵：駕駛中 raceInteractable 優先（其後警車任務 / 委託照舊）', ['inter = raceInteractable(v);', 'if (!inter) inter = vigilanteInteractable(v) || nearestInteractable(v.pos, false);']],
  ['存檔：races.serialize / races.restore', ['races: races.serialize(),', 'races.restore(save.races);']],
  ['除錯物件：window.__game.races', ['races, rivalWorld, raceHud,']],
];
for (const [name, list] of GROUPS) {
  const bad = missing(mainSrc, list);
  check(`main.js 接線：${name}`, bad.length === 0, bad.map((b) => (b instanceof RegExp ? b.source : b)).join(' | '));
}
{
  const fnBody = (name) => (mainSrc.match(new RegExp(`const ${name} = \\([^)]*\\) => \\{([\\s\\S]*?)\\n {2}\\};`)) || [])[1] || '';
  for (const name of ['quitToMenu', 'startGame']) {
    const body = fnBody(name);
    const iV = body.indexOf('cancelVigilante();');
    const iR = body.indexOf('cancelRace();');
    const iRe = body.indexOf('cancelRespawn();');
    check(`${name}：cancelRace() 緊接 cancelVigilante()、在 cancelRespawn 之前`, iV >= 0 && iR > iV && iRe > iR, `vig@${iV} race@${iR} respawn@${iRe}`);
  }
  const sg = fnBody('startGame');
  check('startGame：races.restore 在 missions.restore 之後', sg.indexOf('races.restore(save.races);') > sg.indexOf('missions.restore(save.missions);') && sg.indexOf('missions.restore(save.missions);') > 0);
  const iDecl = mainSrc.indexOf('const races = createRaces(');
  check('宣告順序：vigilante < races（包裝 vigHooks 時已有警車任務掛鉤）< 幫派段 / 街頭事件段', mainSrc.indexOf('const vigilante = createVigilante(') < iDecl && iDecl < mainSrc.indexOf('// ---------- V2 幫派地盤') && iDecl < mainSrc.indexOf('const vigActorHook = vigHooks.fugitiveActor;'));
  // 比賽中犯行照常：犯行守門只認 vigHooks.fugitiveActor / fugitiveShot（未併入競速）
  check('比賽中犯行照常：fugitiveActor / fugitiveShot 掛鉤未併入競速', !/vigHooks\.fugitive(Actor|Shot) = [^\n]*races/.test(mainSrc));
  // 其他整合測試抽段不得引用 races（p7 對抗段、p9 搶劫段只能讀 state.racing、p11 警車任務段只能讀 state.racing）
  const sliceOf = (a, b) => mainSrc.slice(mainSrc.indexOf(a), mainSrc.indexOf(b));
  const segs = [
    ['integration-p7', sliceOf('  // ---------- 對抗 / KO ----------', '  // ---------- 車輛耐久：')],
    ['integration-p9', sliceOf('  // ---------- 超商搶劫（Phase 9', '  // ---------- 車流 / 行人外部狀態 ----------')],
    ['integration-p11', sliceOf('  // ---------- 警車任務（Phase 11', '  // ---------- 超商搶劫（Phase 9')],
  ];
  for (const [n, seg] of segs) check(`${n} 抽段不直接引用 races / raceHud（只經 state.racing）`, seg.length > 1000 && !/\braces\.|\braceHud\b|\brivalWorld\b/.test(seg));
}

// ---------- 行為：抽出 main.js 競速段，以替身執行 ----------
const SLICE_START = '  // ---------- 街頭競速（Phase 12';
const SLICE_END = '  // ---------- V2 幫派地盤';
const slice = mainSrc.slice(mainSrc.indexOf(SLICE_START), mainSrc.indexOf(SLICE_END));
const consts = ['RACE_PRIORITY', 'RACE_CP_BEACON', 'RACE_SPAWN_PAD'].map((n) => (mainSrc.match(new RegExp(`^const ${n} = .*$`, 'm')) || [''])[0]).join('\n');
check('取出 main.js 競速段與常數', slice.length > 2000 && consts.split('\n').every(Boolean));

function fakeDoc() {
  const mkEl = (tag) => {
    const el = { tag, className: '', hidden: false, textContent: '', style: {}, children: [], appendChild(c) { el.children.push(c); return c; }, remove() { el.removed = true; } };
    return el;
  };
  const body = mkEl('body');
  const doc = { body, createElement: mkEl };
  body.ownerDocument = doc;
  return doc;
}
function fakeBeaconPool(opts) {
  const live = [];
  return { opts, live, updates: 0, acquire(kind, x, z, owner) { const b = { kind, x, z, owner }; live.push(b); return b; }, releaseAll() { live.length = 0; }, update() { this.updates++; } };
}

function makeWorld() {
  const bus = createBus();
  const log = [];
  for (const n of ['race:start', 'race:checkpoint', 'race:finish', 'race:abort']) bus.on(n, (e) => log.push([n, e]));
  const doc = fakeDoc();
  const health = new Map();
  const race = RACES[0];
  const playerCar = { type: 'sedan', pos: { x: race.start.x, z: race.start.z }, yaw: race.start.heading, driven: true, speed: 0, fallen: false, overturned: false, isOverturned() { return this.overturned; } };
  const vehicles = {
    vehicles: [playerCar],
    adopt(o) {
      const v = { ...o, pos: { x: o.x, z: o.z }, speed: 0, driven: false, ctl: null, setControls(c) { this.ctl = c; } };
      this.vehicles.push(v);
      return v;
    },
    remove(v) {
      const i = this.vehicles.indexOf(v);
      if (i >= 0) this.vehicles.splice(i, 1);
    },
  };
  health.set(playerCar, 1000);
  const dmg = { attach: (v) => health.set(v, 1000), detach: (v) => health.delete(v), healthOf: (v) => (health.has(v) ? health.get(v) : null) };
  const pools = [];
  const toasts = [];
  const money = { total: 0, reasons: [] };
  const vig = { active: false };
  const deps = {
    bus,
    createRaces,
    createRivalWorld,
    createRaceHud,
    RACE_CP_RADIUS: CP_RADIUS,
    raceArrowAngle: arrowAngle,
    racePromptText: promptText,
    vehicles,
    dmg,
    traffic: { cars: [] },
    findRoute: (g, a, b) => ({ points: [a, b] }),
    graph: {},
    buildingAt: () => null,
    state: { mode: 'drive', vehicle: playerCar, respawn: null, spraying: null },
    cj: { vehicle: null },
    adopted: new Set(),
    document: doc,
    createBeaconPool: (o) => {
      const p = fakeBeaconPool(o);
      pools.push(p);
      return p;
    },
    scene: {},
    heightAt: () => 0,
    vigHooks: { fugitiveActor: () => false, fugitiveShot: () => false, end: (k) => log.push(['vig:end', k]), active: () => vig.active },
    economy: { add: (n, reason) => { money.total += n; money.reasons.push(reason); } },
    hud: { toast: (t) => toasts.push(t) },
    otherMissionBusy: () => false,
    vigilante: vig,
    playerPos: () => playerCar.pos,
    wanted: { stars: 0 },
    robberies: { active: null },
    player: { yaw: 0, pos: playerCar.pos },
  };
  const names = Object.keys(deps);
  const body = `${consts}\n${slice}\nreturn { races, rivalWorld, raceHud, raceInteractable, updateRace, cancelRace, raceMarkers, startRace };`;
  const api = new Function(...names, body)(...names.map((n) => deps[n]));
  return { ...api, deps, log, doc, vehicles, health, toasts, money, playerCar, pools, race, vig };
}
const run = (w, sec, dt = 1 / 30, skip = false) => {
  for (let t = 0; t < sec - 1e-9; t += dt) w.updateRace(dt, skip);
};

{
  const w = makeWorld();
  const [startPool, cpPool] = w.pools;
  check('光柱池：起點預設 220 m 柱、檢查點大光柱圈半徑 = 通過半徑 12 m', startPool && cpPool && !startPool.opts.radius && cpPool.opts.radius === CP_RADIUS);
  w.updateRace(1 / 30, false);
  check('未開賽：3 根橘色起點光柱（kind race）、無檢查點柱', startPool.live.length === 3 && startPool.live.every((b) => b.kind === 'race') && cpPool.live.length === 0);
  check("未開賽：小地圖 3 面旗幟 'race-start'", w.raceMarkers().length === 3 && w.raceMarkers().every((m) => m.kind === 'race-start'));
  const inter = w.raceInteractable(w.playerCar);
  check(`起點光柱內駕車：互動提示「${promptText(w.race)}」、priority 高於警車任務 4`, inter && inter.text === promptText(w.race) && inter.priority > 4);
  w.playerCar.pos.x += 30;
  check('起點外：無競速互動', w.raceInteractable(w.playerCar) === null);
  w.playerCar.pos.x -= 30;
  check('步行（v = null）：無競速互動', w.raceInteractable(null) === null);
  w.vig.active = true;
  check('警車任務中：不可開賽（回 null）', w.raceInteractable(w.playerCar) === null);
  w.vig.active = false;
  w.deps.wanted.stars = 2;
  inter.act();
  check('有星數：按下 → toast 提示、不開賽', !w.races.active && w.toasts.includes(TOAST_WANTED));
  w.deps.wanted.stars = 0;
  // 回歸（cr-p12-wire）：未停車 / 熄火 / 翻車 → 按下 toast、不開賽
  w.playerCar.speed = 25;
  inter.act();
  check('回歸：車速 25 m/s 按下 → toast「先停車再開賽」、不開賽', !w.races.active && w.toasts.includes(TOAST_MOVING));
  w.playerCar.speed = 0;
  w.health.set(w.playerCar, 0);
  inter.act();
  check('回歸：熄火（healthOf 0）按下 → toast、不開賽（不會下一幀立刻車毀退賽）', !w.races.active && w.toasts.includes(TOAST_STALLED) && !w.log.some((e) => e[0] === 'race:start'));
  w.health.set(w.playerCar, 1000);
  w.playerCar.overturned = true;
  inter.act();
  check('回歸：翻車按下 → toast、不開賽', !w.races.active && w.toasts.includes(TOAST_OVERTURNED));
  w.playerCar.overturned = false;
  w.playerCar.fallen = true;
  inter.act();
  check('回歸：機車倒地按下 → 不開賽', !w.races.active);
  w.playerCar.fallen = false;
  w.playerCar.speed = 2;
  // vigHooks.active 併入前：false
  check('vigHooks.active 已包裝：未開賽 false', w.deps.vigHooks.active() === false);
  w.raceInteractable(w.playerCar).act();
  check('0 星：act() → 開賽、emit race:start、state.racing 真', w.races.active && w.log.some((e) => e[0] === 'race:start') && w.deps.state.racing === true);
  check('vigHooks.active 併入競速：比賽中真（委託類 / 噴漆不開始）', w.deps.vigHooks.active() === true);
  check('比賽中：不再提供開賽互動', w.raceInteractable(w.playerCar) === null);
  w.updateRace(1 / 30, false);
  const bar = w.doc.body.children.find((c) => c.className === 'race-bar');
  const count = w.doc.body.children.find((c) => c.className === 'race-count');
  check(`倒數：生成 ${w.race.rivals} 台對手車（adopt + dmg.attach）、races.locked、大字 3`, w.vehicles.vehicles.length === 1 + w.race.rivals && w.vehicles.vehicles.slice(1).every((v) => v.racer && w.health.has(v)) && w.races.locked && count.textContent === '3' && !count.hidden);
  check('倒數：起點光柱收起、第 1 檢查點大光柱圈', startPool.live.length === 0 && cpPool.live.length === 1 && cpPool.live[0].x === w.race.checkpoints[0].x);
  const rival = w.vehicles.vehicles[1];
  w.updateRace(1 / 30, false);
  check('倒數：對手車煞停鎖定', rival.ctl && rival.ctl.brake === 1 && rival.ctl.throttle === 0);
  run(w, COUNTDOWN_SEC);
  check('GO：解除鎖定、對手車給油門、任務條「名次 n/m｜檢查點 0/5｜…」', !w.races.locked && rival.ctl.throttle > 0 && /^名次 \d\/3｜檢查點 0\/5｜\d\d:\d\d\.\d$/.test(bar.textContent) && !bar.hidden, bar.textContent);
  const t0 = w.races.elapsed;
  run(w, 1, 1 / 30, true);
  const frozen = [rival.ctl.brake === 1 && rival.ctl.throttle === 0];
  for (const [k, v] of [['respawn', 'busted'], ['spraying', 'spray-1']]) {
    w.deps.state[k] = v;
    rival.ctl = null;
    run(w, 1);
    frozen.push(rival.ctl && rival.ctl.brake === 1);
    w.deps.state[k] = null;
  }
  w.deps.robberies.active = 'store-1';
  rival.ctl = null;
  run(w, 1);
  frozen.push(rival.ctl && rival.ctl.brake === 1);
  w.deps.robberies.active = null;
  w.vig.active = true;
  rival.ctl = null;
  run(w, 1);
  frozen.push(rival.ctl && rival.ctl.brake === 1);
  w.vig.active = false;
  check('手機 / BUSTED・WASTED / 噴漆 / 搶劫 / 警車任務中：計時不走、對手車煞停', w.races.elapsed === t0 && frozen.every(Boolean), frozen.join());
  run(w, 0.5);
  check('恢復後計時', w.races.elapsed > t0);
  // 下車 > 10 s → 退賽
  w.deps.state.mode = 'walk';
  w.deps.state.vehicle = null;
  run(w, LEFT_SEC + 0.2);
  check('下車 > 10 s → 退賽 toast、對手車回收、HUD 收起、起點光柱回來、state.racing 假', !w.races.active && w.toasts.includes('退賽：離開車輛太久') && w.vehicles.vehicles.length === 1 && bar.hidden && startPool.live.length === 3 && cpPool.live.length === 0 && w.deps.state.racing === false && w.log.some((e) => e[0] === 'race:abort' && e[1].reason === 'left'));
}
{
  const w = makeWorld();
  w.raceInteractable(w.playerCar).act();
  run(w, COUNTDOWN_SEC + 0.2);
  w.health.set(w.playerCar, 0);
  w.updateRace(1 / 30, false);
  check('開賽用車耐久歸零（dmg.healthOf 0）→ 退賽 wrecked', !w.races.active && w.log.some((e) => e[0] === 'race:abort' && e[1].reason === 'wrecked'));
}
{
  const w = makeWorld();
  w.raceInteractable(w.playerCar).act();
  w.updateRace(1 / 30, false);
  const bar = w.doc.body.children.find((c) => c.className === 'race-bar');
  w.deps.state.respawn = 'busted';
  w.deps.vigHooks.end('busted');
  run(w, 1);
  check('BUSTED：vigHooks.end（包裝）→ 原警車任務掛鉤照呼叫 + 退賽 busted、HUD 收起', w.log.some((e) => e[0] === 'vig:end' && e[1] === 'busted') && !w.races.active && bar.hidden && w.log.some((e) => e[0] === 'race:abort' && e[1].reason === 'busted'));
}
{
  const w = makeWorld();
  w.raceInteractable(w.playerCar).act();
  w.updateRace(1 / 30, false);
  w.cancelRace();
  const bar = w.doc.body.children.find((c) => c.className === 'race-bar');
  check('cancelRace()：無聲退賽、對手車回收、HUD 收起', !w.races.active && w.vehicles.vehicles.length === 1 && bar.hidden && !w.toasts.some((t) => t.startsWith('退賽')));
}
{
  // 完賽：沿檢查點把玩家車逐點移過去 → 獎金入帳 reason 'race'
  const w = makeWorld();
  w.raceInteractable(w.playerCar).act();
  run(w, COUNTDOWN_SEC + 0.2);
  for (const v of w.vehicles.vehicles.slice(1)) v.pos = { x: 1e4, z: 1e4 }; // 對手車遠在天邊（進度落後）
  for (const c of w.race.checkpoints) {
    w.playerCar.pos.x = c.x;
    w.playerCar.pos.z = c.z;
    w.updateRace(1 / 30, false);
  }
  check("完賽第 1 名：economy.add(1000, 'race')、toast、最佳成績可存檔", !w.races.active && w.money.total === 1000 && w.money.reasons.join() === 'race' && w.toasts.some((t) => t.startsWith('完賽！第 1 名')) && w.races.serialize() && w.races.serialize().best[w.race.id] > 0);
}

// ---------- hud.js / marker-colors / big-map / light-pillar / style.css ----------
const hudSrc = read('src/hud.js');
check("hud.js：入帳跳字 race「競速」", /MONEY_REASON_LABEL = \{[^}]*race: '競速 '/.test(hudSrc));
check("hud.js：race-cp 超出小地圖半徑時貼邊（EDGE_KINDS）", /const EDGE_KINDS = new Set\(\[[^\]]*'race-cp'/.test(hudSrc));
check("hud.js：race-start 畫旗幟圖示（FLAG_KINDS）", /const FLAG_KINDS = new Set\(\['race-start'\]\);/.test(hudSrc) && hudSrc.includes('if (FLAG_KINDS.has(m.kind)) {'));
check("marker-colors.js：race-start 橘 #fb8c00、race-cp 有色碼、與其他 kind 不重複", MARKER_COLORS['race-start'] === '#fb8c00' && /^#[0-9a-f]{6}$/i.test(MARKER_COLORS['race-cp'] || '') && new Set(Object.values(MARKER_COLORS)).size === Object.keys(MARKER_COLORS).length);
const bigSrc = read('src/map/big-map.js');
check("big-map.js：MARKER_LABELS race-start / race-cp 圖例", bigSrc.includes("'race-start': '競速起點'") && bigSrc.includes("'race-cp': '競速檢查點'"));
check('light-pillar.js：BEACON_COLORS.race = 橘 0xfb8c00', read('src/missions/light-pillar.js').includes('race: 0xfb8c00'));
const styleSrc = read('src/style.css');
check('style.css：.race-bar / .race-count / .race-arrow、[hidden]、pointer-events none', ['.race-bar {', '.race-count {', '.race-arrow {', '.race-bar[hidden]'].every((k) => styleSrc.includes(k)) && /\.race-bar \{[^}]*pointer-events: none;/.test(styleSrc));
const saveSrc = read('src/save.js');
check('save.js：races 選填欄位（不升版、validateSave 清洗）', saveSrc.includes('function raceRecords(') && saveSrc.includes('if (rc) out.races = rc;') && /export const SAVE_VERSION = 2;/.test(saveSrc));

// ---------- interfaces.md：§34 + 事件表 ----------
const docs = read('docs/dev/interfaces.md');
check('interfaces.md：§34 Phase 12 街頭競速', docs.includes('## 34. Phase 12 街頭競速 Street Race'));
check('interfaces.md：事件表含 race:start / race:checkpoint / race:finish / race:abort', ['| `race:start` |', '| `race:checkpoint` |', '| `race:finish` |', '| `race:abort` |'].every((k) => docs.includes(k)));

console.log(`${failed === 0 ? 'PASS' : 'FAIL'} ${failed === 0 ? passed : failed}/${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
