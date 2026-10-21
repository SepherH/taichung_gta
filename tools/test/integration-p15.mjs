#!/usr/bin/env node
// Phase 15 整合驗證：暴走任務接線（main.js 原始碼字串比對 + 抽出暴走段以替身執行；不 import three / rapier）
// 用法：node tools/test/integration-p15.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：import、建立 rampage / rampageWorld / rampageHud / 骷髏標記、互斥（state.rampage getter、state.racing 包裝、vigHooks.active / end 包裝、
//   委託 / 武器店 / 安全屋遮罩）、collectMarkers、每幀 updateRampage 接在 updateShops 之後、存檔（rampage / 暫發武器不入檔）、
//   startGame / quitToMenu → cancelRampage（cancelRespawn 之前）、rampage.restore、window.__game、既有字串未動、全檔唯一 weapons.restore；
//   行為（抽段 + 替身）：步行走進開始 / 駕車不觸發 / 凍結、busy 不開始、state.racing / vigHooks.active 併入、BUSTED 結束恢復武器、cancel；
//   抽段 + 真 gangs：結束（BUSTED / cancelRampage）後徵用成員交還（rampageWorld.release → gangs.release → repaint 回原色、卸武器）
// 注意：staging 無 node_modules；main.js 依賴 three / css / JSON import，一律原始碼字串比對
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBus } from '../../src/core/events.js';
import { createWeapons } from '../../src/weapons/weapons.js';
import { createRampage, createRampageWorld, createRampageHud, createSkullMarkers, rampageById } from '../../src/missions/rampage.js';
import { createGangs } from '../../src/gangs.js';

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
  ['import：missions/rampage.js', ["import { createRampage, createRampageWorld, createRampageHud, createSkullMarkers } from './missions/rampage.js';"]],
  ['建立 rampage（weapons / gangs.gangOf / 不算玩家正駕駛的車）', [
    'const rampage = createRampage({ bus, weapons, gangOf: (a) => gangs.gangOf(a), isTargetVehicle: (v) => !!v && v !== state.vehicle });',
  ]],
  ['建立 rampageWorld（traffic / gangs / combat / repaint 掛色）/ HUD / 骷髏標記', [
    /const rampageWorld = createRampageWorld\(\{\s*\n\s*traffic, gangs, combat,\s*\n\s*repaint: \(p\) => \{/,
    'const rampageHud = createRampageHud({ root: document.body });',
    'const rampageSkulls = createSkullMarkers({ THREE, scene, heightAt });',
  ]],
  ['互斥：state.rampage getter、state.racing getter 包裝', [
    "Object.defineProperty(state, 'rampage', { get: () => rampage.active, enumerable: true, configurable: true });",
    "const racingGet = Object.getOwnPropertyDescriptor(state, 'racing').get;",
    "Object.defineProperty(state, 'racing', { get: () => racingGet() || rampage.active, enumerable: true, configurable: true });",
  ]],
  ['互斥：vigHooks.active / vigHooks.end 包裝', [
    'const vigActiveRampage = vigHooks.active;',
    'vigHooks.active = () => vigActiveRampage() || rampage.active;',
    'const vigEndRampage = vigHooks.end;',
    /vigHooks\.end = \(kind\) => \{\s*\n\s*vigEndRampage\(kind\);\s*\n\s*rampage\.end\(kind\);\s*\n\s*rampageHud\.set\(null\);/,
  ]],
  ['互斥：暴走中不接委託 / 不進武器店 / 安全屋', [/interCands\[5\] = walking \? safehouses\.nearest\(pos\) : null;\s*\n\s*if \(state\.rampage\) interCands\[0\] = interCands\[4\] = interCands\[5\] = null;/]],
  ['開始條件：其他任務 / 警車任務 / BUSTED・WASTED / 噴漆', ['const rampageBusy = () => otherMissionBusy() || vigilante.active || !!state.respawn || !!state.spraying;', 'rampageCtx.busy = !rampage.active && rampageBusy();']],
  ['ctx：步行判定 / 凍結 / 入帳 reason rampage', [
    "rampageCtx.onFoot = state.mode === 'walk' && !(state.koTimer > 0) && !combat.isDown(player.actor);",
    'rampageCtx.frozen = skip || !!state.respawn || !!state.spraying;',
    "earn: (n) => economy.add(n, 'rampage'),",
    'rampageHud.set(rampage.update(dt, rampageCtx));',
  ]],
  ['標記：collectMarkers 併入 rampageMarkers', ['pushAll(out, rampageMarkers());', 'return rampage.markers(rampageMk);']],
  ['每幀：updateRampage 接在 updateShops 之後', [/updateStreetEvents\(dt, phoneOpen\);\s*\n\s*updateShops\(dt\);\s*\n\s*updateRampage\(dt, phoneOpen\);/]],
  ['存檔：rampage.serialize、進行中存開始前武器', ['rampage: rampage.serialize(),', 'weapons: rampage.savedWeapons() || weapons.serialize(),']],
  ['開局：races.restore 後 rampage.restore', [/races\.restore\(save\.races\);[^\n]*\n\s*rampage\.restore\(save\.rampage\);/]],
  ['window.__game：rampage / rampageWorld / rampageHud', ['rampage, rampageWorld, rampageHud,']],
  ['檔頭說明 Phase 15', ['// 暴走任務（Phase 15，§37 Rampage）']],
];
for (const [name, list] of GROUPS) {
  const miss = missing(mainSrc, list);
  check(name, miss.length === 0, miss.map(String).join(' | '));
}

const fnBody = (name) => {
  const i = mainSrc.indexOf(`const ${name} = (`);
  if (i < 0) return '';
  const j = mainSrc.indexOf('\n  };\n', i);
  return mainSrc.slice(i, j);
};
for (const fn of ['startGame', 'quitToMenu']) {
  const b = fnBody(fn);
  const s = b.indexOf('cancelShops();');
  const a = b.indexOf('cancelRampage();');
  const r = b.indexOf('cancelRespawn();');
  check(`${fn}：cancelRampage() 在 cancelShops() 之後、cancelRespawn() 之前`, s > 0 && a > s && r > a);
}
check('cancelRampage 定義：rampage.cancel + HUD 收起', /const cancelRampage = \(\) => \{\s*\n\s*rampage\.cancel\(\);\s*\n\s*rampageHud\.set\(null\);/.test(mainSrc));
check('既有字串未動：otherMissionBusy / 競速 racing getter / 副任務 sideJob getter',
  mainSrc.includes('const otherMissionBusy = () => !!(state.sideJob || missions.active() || missions.eventActive() || missions.jobActive() || robberies.active || state.spraying || state.racing);') &&
  mainSrc.includes("Object.defineProperty(state, 'racing', { get: () => races.active, enumerable: true, configurable: true });") &&
  mainSrc.includes("Object.defineProperty(state, 'sideJob', { get: () => taxi.active || ems.active, enumerable: true, configurable: true });"));
check('racing 包裝在競速段之後（先定義才能取 descriptor）', mainSrc.indexOf("Object.defineProperty(state, 'racing', { get: () => races.active") < mainSrc.indexOf('const racingGet = '));
check('全檔仍只有一處 weapons.restore（暫發 / 恢復在 rampage.js 內）', (mainSrc.match(/weapons\.restore\(/g) || []).length === 1);
const section = (() => {
  const i = mainSrc.indexOf('// ---------- 暴走任務（Phase 15，§37）');
  const j = mainSrc.indexOf('\n  // 車流停車判斷用', i);
  return i > 0 && j > i ? mainSrc.slice(i, j) : '';
})();
check('抽出暴走段', section.length > 500);
check('暴走段不新增光源 / 貼圖 / 陰影', !/Light\(|Texture|castShadow|shadowMap/.test(section));

// ---------- 行為（抽段 + 替身）----------
{
  const body = `${section}\nreturn { rampage, rampageWorld, updateRampage, cancelRampage, rampageMarkers };`;
  const bus = createBus();
  const playerActor = { id: 'player', kind: 'player', pos: { x: 0, y: 0, z: 0 } };
  const weapons = createWeapons({ bus, player: { actor: playerActor } });
  weapons.restore({ slot: 2, ammo: { pistol: { mag: 5, reserve: 36 } } });
  const state = { mode: 'walk', vehicle: null, koTimer: 0, respawn: null, spraying: null };
  let racesActive = false;
  Object.defineProperty(state, 'racing', { get: () => racesActive, enumerable: true, configurable: true });
  const busy = { on: false };
  const otherMissionBusy = () => busy.on || !!state.racing;
  const endCalls = [];
  const vigHooks = { active: () => false, end: (k) => endCalls.push(k) };
  const toasts = [];
  const money = [];
  const ppos = { x: 0, z: 0 };
  const fakeGeo = class { dispose() {} };
  const fakeObj = class {
    constructor() {
      this.position = { set() {}, y: 0 };
      this.rotation = { x: 0, y: 0 };
      this.userData = {};
    }
    add() {}
  };
  const THREE = { Group: fakeObj, Mesh: fakeObj, MeshStandardMaterial: class { dispose() {} }, MeshBasicMaterial: class { dispose() {} }, IcosahedronGeometry: fakeGeo, BoxGeometry: fakeGeo, ConeGeometry: fakeGeo };
  const deps = {
    bus, weapons, state, vigHooks, otherMissionBusy, THREE,
    gangs: { gangOf: () => null, members: [], enlist: () => [] },
    traffic: { peds: [], _gangWeapon() {} },
    combat: { isDown: () => false, stateOf: () => 'normal' },
    repaintCharacter() {},
    document: { body: null },
    scene: { add() {} },
    heightAt: () => 0,
    vigilante: { active: false },
    economy: { add: (n, r) => money.push([n, r]) },
    hud: { toast: (t) => toasts.push(t) },
    playerPos: () => ppos,
    player: { actor: playerActor },
    createRampage, createRampageWorld, createRampageHud, createSkullMarkers,
  };
  let w = null;
  try {
    w = new Function(...Object.keys(deps), body)(...Object.values(deps));
  } catch (e) {
    check('抽段可執行', false, e.message);
  }
  if (w) {
    const def = rampageById('rampage-suits');
    const walk = (x, z) => {
      ppos.x = x;
      ppos.z = z;
      w.updateRampage(1 / 60, false);
    };
    walk(def.x + 40, def.z);
    state.mode = 'drive';
    walk(def.x, def.z);
    check('行為：駕車經過骷髏不觸發', !w.rampage.active);
    state.mode = 'walk';
    busy.on = true;
    walk(def.x + 40, def.z);
    walk(def.x, def.z);
    check('行為：其他任務進行中 → toast、不開始', !w.rampage.active && toasts.some((t) => t.includes('其他任務')));
    busy.on = false;
    walk(def.x + 40, def.z);
    ppos.x = def.x;
    w.updateRampage(1 / 60, true);
    check('行為：手機開著（skip）不觸發', !w.rampage.active);
    walk(def.x, def.z);
    check('行為：步行走進骷髏 → 開始、暫發衝鋒槍', w.rampage.active && state.rampage === true && weapons.current === 'smg');
    check('互斥：state.racing（otherMissionBusy 讀取）併入暴走', state.racing === true && otherMissionBusy() === true);
    check('互斥：vigHooks.active 併入暴走（委託類 / 噴漆不開始）', vigHooks.active() === true);
    check('行為：進行中小地圖不列暴走點', w.rampageMarkers().length === 0);
    vigHooks.end('busted');
    check('BUSTED：vigHooks.end → 既有鏈照叫、暴走失敗、武器恢復手槍彈匣 5', endCalls.includes('busted') && !w.rampage.active && weapons.current === 'pistol' && weapons.ammo('pistol').mag === 5 && !weapons.owns('smg'));
    check('結束後 state.racing / vigHooks.active 回復', state.racing === false && vigHooks.active() === false);
    walk(def.x + 40, def.z);
    walk(def.x, def.z);
    check('失敗後可再挑戰', w.rampage.active);
    w.cancelRampage();
    check('cancelRampage：無聲結束、武器恢復', !w.rampage.active && weapons.current === 'pistol' && !weapons.owns('smg'));
    check('小地圖列出 4 個暴走點（kind rampage）', w.rampageMarkers().length === 4 && w.rampageMarkers().every((m) => m.kind === 'rampage'));
  }
}

// ---------- 行為（抽段 + 真 gangs）：結束後徵用成員交還 ----------
check('repaint 依 citizen.gang 掛 / 卸武器（release 後回原色、卸武器）', /repaintCharacter\(p\.character, p\.citizen\.look\);\s*\n\s*p\.look = p\.citizen\.look;\s*\n\s*traffic\._gangWeapon\(p, p\.citizen\.gang \? p\.citizen\.gang\.weapon : null\);/.test(section));
check('rampageCtx.world = rampageWorld（rampage.js 結束時呼叫 world.release）', /world: rampageWorld,/.test(section));
{
  const body = `${section}\nreturn { rampage, rampageWorld, updateRampage, cancelRampage };`;
  const bus = createBus();
  const playerActor = { id: 'player', kind: 'player', pos: { x: 0, y: 0, z: 0 } };
  const weapons = createWeapons({ bus, player: { actor: playerActor } });
  const def = rampageById('rampage-suits');
  playerActor.pos.x = def.x;
  playerActor.pos.z = def.z;
  const gangs = createGangs({ bus, rng: () => 0.5 });
  gangs.update(0.016, { player: { x: def.x, z: def.z, actor: playerActor, inVehicle: false } });
  let seq = 0;
  const peds = [15, 20, 25, 30, 35].map((d) => ({
    x: def.x + d, z: def.z, alive: true, state: 'walk', character: {},
    actor: { id: `i${++seq}`, kind: 'ped', pos: { x: def.x + d, y: 0, z: def.z }, hp: 100 },
    brain: { state: 'wander', override: null }, citizen: { look: { shirt: 'orig' } },
  }));
  const painted = [];
  const armed = new Map();
  const state = { mode: 'walk', vehicle: null, koTimer: 0, respawn: null, spraying: null };
  Object.defineProperty(state, 'racing', { get: () => false, enumerable: true, configurable: true });
  const fakeGeo = class { dispose() {} };
  const fakeObj = class {
    constructor() {
      this.position = { set() {}, y: 0 };
      this.rotation = { x: 0, y: 0 };
      this.userData = {};
    }
    add() {}
  };
  const ppos = { x: def.x + 40, z: def.z };
  const deps = {
    bus, weapons, state, vigHooks: { active: () => false, end() {} }, otherMissionBusy: () => false,
    THREE: { Group: fakeObj, Mesh: fakeObj, MeshStandardMaterial: class { dispose() {} }, MeshBasicMaterial: class { dispose() {} }, IcosahedronGeometry: fakeGeo, BoxGeometry: fakeGeo, ConeGeometry: fakeGeo },
    gangs,
    traffic: { peds, _gangWeapon: (p, k) => armed.set(p, k) },
    combat: { isDown: () => false, stateOf: () => 'normal' },
    repaintCharacter: (ch, look) => painted.push(look && look.shirt),
    document: { body: null }, scene: { add() {} }, heightAt: () => 0, vigilante: { active: false },
    economy: { add() {} }, hud: { toast() {} }, playerPos: () => ppos, player: { actor: playerActor },
    createRampage, createRampageWorld, createRampageHud, createSkullMarkers,
  };
  let w = null;
  try {
    w = new Function(...Object.keys(deps), body)(...Object.values(deps));
  } catch (e) {
    check('抽段可執行（真 gangs）', false, e.message);
  }
  if (w) {
    const begin = () => {
      ppos.x = def.x + 40;
      w.updateRampage(1 / 60, false);
      ppos.x = def.x;
      w.updateRampage(1 / 60, false); // 開始
      w.updateRampage(1 / 60, false); // 第一次補敵人
    };
    const released = () => gangs.members.length === 0 && gangs.stats().engaged === 0 && peds.every((p) => !p.citizen.gang && p.citizen.look.shirt === 'orig' && !p.brain.override);
    begin();
    const n0 = gangs.members.length;
    const took = peds.filter((p) => p.citizen.gang);
    const armedDuring = took.filter((p) => armed.has(p)).length;
    check('真 gangs：開始後徵用附近行人成西裝幫並圍攻', w.rampage.active && n0 > 0 && gangs.stats().engaged > 0 && armedDuring === n0 && w.rampageWorld.enlisted.length === n0, `n0 ${n0}`);
    w.rampage.end('busted');
    check('BUSTED 結束：徵用成員交還 gangs（members / engaged 歸零、外觀還原、大腦交還）', !w.rampage.active && released());
    check('BUSTED 結束：存活者 repaint 回原色、卸武器', took.every((p) => armed.get(p) === null) && painted.slice(-n0).every((s) => s === 'orig'));
    begin();
    const n1 = gangs.members.length;
    w.cancelRampage();
    check('cancelRampage（回主選單 / 開新局）：徵用成員交還、不累積', n1 > 0 && !w.rampage.active && released() && w.rampageWorld.enlisted.length === 0);
    const np = painted.length;
    w.cancelRampage();
    check('重複 cancel：不重複釋放（無額外 repaint）', painted.length === np && gangs.members.length === 0);
  }
  gangs.dispose();
}

console.log(failed ? `FAIL ${failed}/${passed + failed}` : `PASS ${passed}/${passed + failed}`);
process.exit(failed ? 1 : 0);
