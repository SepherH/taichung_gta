#!/usr/bin/env node
// P18 整合驗證：消防車任務接線（main.js 原始碼字串比對 + 抽出消防車段以替身執行；不 import three / rapier）
// 用法：node tools/test/integration-p18.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：import、建立（firefighter / fireWorld / fireTrucks / fireBar / 門口光柱 / 水柱 / setFireproof）、每幀 updateFirefighter（updatePackages 之後、
//   射擊鍵 = 水砲）、互動鍵後備鏈、互斥（state.racing 包裝 / vigHooks / fireBusy 含暴走與特技跳台）、collectMarkers、存檔 / 讀檔、startGame / quitToMenu → cancel、
//   window.__game；VEHICLE_TYPES.fire_truck + 程式幾何後備、traffic 極低比例、carjack 外形、save.js / hud / marker-colors / big-map / light-pillar / style.css；
//   interfaces.md §40 與事件表；行為（抽段 + 替身）：非消防車無提示、出勤、互斥、噴水熄火過關入帳、BUSTED（vigHooks.end）、防火只套玩家車、cancel；
//   審查修正：水砲觸控 tb-spray / 手把 X / 鍵盤備援 KeyX、cancelFirefighter 先於 clearExplosions、nearestInteractable 互斥含 firefighter、凍結時 hold 延後引信
// 注意：staging 無 node_modules；main.js / vehicle.js / traffic.js 依賴 three，一律原始碼字串比對
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBus } from '../../src/core/events.js';
import { createExplosions } from '../../src/explosions.js';
import { MARKER_COLORS } from '../../src/map/marker-colors.js';
import {
  createFirefighter,
  createFireWorld,
  createFireTruckDepot,
  createWaterCannonMesh,
  nozzleOf,
  isFireTruck,
  FIRE_STATION,
  FIRE_TRUCK_SPOT,
  FIRE_STATION_BEACON,
  PROMPT_START as FIRE_PROMPT_START,
  PROMPT_QUIT as FIRE_PROMPT_QUIT,
  SPRAY_KEY as FIRE_SPRAY_KEY,
  DOUSED_DAMAGE,
  MAX_LEVEL,
} from '../../src/missions/firefighter.js';

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
const GROUPS_STATIC = [
  ['import：missions/firefighter.js', [/import \{ createFirefighter, createFireWorld, createFireTruckDepot, createWaterCannonMesh, nozzleOf, isFireTruck,[^\n]*\} from '\.\/missions\/firefighter\.js';/]],
  ['建立：firefighter / fireWorld（onKeep → adopted）/ fireTrucks / fireBar / 門口光柱 / 水柱', [
    'const firefighter = createFirefighter({ bus, rng: Math.random });',
    'const fireWorld = createFireWorld({ vehicles, dmg, explosions, traffic, rng: Math.random, onKeep: (v) => adopted.add(v) });',
    'const fireTrucks = createFireTruckDepot({',
    "const fireBar = createSideJobBar({ root: document.body, prefix: 'fire' });",
    'const fireStationBeacons = createBeaconPool({ scene, heightAt, ...FIRE_STATION_BEACON });',
    "fireStationBeacons.acquire('fire', FIRE_STATION.x, FIRE_STATION.z, FIRE_STATION);",
    'const waterCannon = createWaterCannonMesh({ THREE, scene });',
  ]],
  ['永久防火：explosions.setFireproof 只套玩家正駕駛的車', ["explosions.setFireproof((v) => firefighter.fireproof && state.mode === 'drive' && v === state.vehicle);"]],
  ['互斥：state.firefighter getter + 包裝 state.racing getter', [
    "Object.defineProperty(state, 'firefighter', { get: () => firefighter.active, enumerable: true, configurable: true });",
    "const racingGetFire = Object.getOwnPropertyDescriptor(state, 'racing').get;",
    "Object.defineProperty(state, 'racing', { get: () => racingGetFire() || firefighter.active, enumerable: true, configurable: true });",
  ]],
  ['互斥：vigHooks.active / end 包裝', ['vigHooks.active = () => vigActiveFire() || firefighter.active;', 'firefighter.end(kind);']],
  ['互斥：出勤條件含其他任務 / 警車 / 暴走 / 特技跳台 / 重生 / 噴漆', ['const fireBusy = () => otherMissionBusy() || vigilante.active || rampage.active || stunts.active || !!state.respawn || !!state.spraying;']],
  ['每幀：updateFirefighter 接在 updatePackages(dt) 之後、射擊鍵 / 備援鍵 = 水砲', [/updatePackages\(dt\);\s*\n\s*updateFirefighter\(dt, phoneOpen, state\.mode === 'drive' && \(snap\.down\.attack \|\| input\.down\(FIRE_SPRAY_KEY\)\)\);/]],
  ['水砲輸入：import SPRAY_KEY、setTouchButtonVisible、觸控 tb-spray（hold、非 attack slot、駕駛、預設隱藏）、手把 getSprayMode', [
    /import \{ createFirefighter,[^\n]*SPRAY_KEY as FIRE_SPRAY_KEY \} from '\.\/missions\/firefighter\.js';/,
    "import { registerTouchButton, setTouchButtonVisible } from './touch.js';",
    "registerTouchButton({ id: 'tb-spray', label: '噴水', code: FIRE_SPRAY_KEY, mode: 'hold', slot: 'top1', showWhen: 'drive', hidden: true });",
    "setTouchButtonVisible('tb-spray', on);",
    "setTouchButtonVisible('tb-horn', !on);",
    "getSprayMode: () => state.mode === 'drive' && isFireTruck(state.vehicle) });",
  ]],
  ['凍結（手機 / 噴漆 / 重生）：firefighter.hold(dt) 延後起火車引信', [/if \(frozen\) \{\s*\n\s*firefighter\.hold\(dt\);[^\n]*\n\s*return;\s*\n\s*\}/]],
  ['互斥：nearestInteractable 出勤中不接委託', ['if (state.firefighter) interCands[0] = null;']],
  ['互動：駕駛中後備鏈 sideJobInteractable → firefighterInteractable', [/if \(!inter\) inter = sideJobInteractable\(v\);\s*\n\s*if \(!inter\) inter = firefighterInteractable\(v\);/]],
  ['標記：collectMarkers 併入 fireMarkers()', ['pushAll(out, fireMarkers());']],
  ['存檔：firefighter.serialize', ['firefighter: firefighter.serialize(),']],
  ['讀檔：packages.restore 後 firefighter.restore', [/packages\.restore\(save\.packages\);[^\n]*\n\s*firefighter\.restore\(save\.firefighter\);/]],
  ['開局：ambulances.ensure 後 fireTrucks.ensure(true)', [/ambulances\.ensure\(true\);[^\n]*\n\s*fireTrucks\.ensure\(true\);/]],
  ['第 12 關獎勵存檔：ctx.save = autosave.flush(\'firefighter\')', ["save: () => autosave.flush('firefighter'),"]],
  ['入帳 reason firefighter', ["earn: (n) => economy.add(n, 'firefighter'),"]],
  ['window.__game：firefighter / fireWorld / fireTrucks / waterCannon', ['firefighter, fireWorld, fireTrucks, waterCannon, fireStationBeacons,']],
  ['檔頭說明 P18', ['// 消防車任務（P18，Firefighter）']],
];
for (const [name, list] of GROUPS_STATIC) {
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
  const g = b.indexOf('gangs.cancel();');
  const f = b.indexOf('cancelFirefighter();');
  const c = b.indexOf('clearExplosions();');
  const p = b.indexOf('cancelPackages();');
  const r = b.indexOf('cancelRespawn();');
  check(`${fn}：cancelFirefighter() 先於 clearExplosions()（各出現一次）、cancelRespawn() 仍在 cancelPackages() 之後`,
    g > 0 && f > g && c > f && b.indexOf('cancelFirefighter();', f + 1) < 0 && b.indexOf('clearExplosions();', c + 1) < 0 && p > c && r > p);
}
{
  const ni = fnBody('nearestInteractable');
  check('nearestInteractable：firefighter 與 sideJob 同樣清掉委託候選', /if \(state\.firefighter\) interCands\[0\] = null;/.test(ni) && /if \(state\.sideJob\) interCands\[0\] = null;/.test(ni) && ni.indexOf('state.firefighter') < ni.indexOf('return pickInteractable('));
}
{
  const gp = read('src/gamepad.js');
  check('gamepad.js：駕駛 X 在 getSprayMode() 時改送 KeyX（水砲）、否則喇叭；RT 駕駛仍為油門', /if \(i === PAD\.X\) return drive \? \(typeof opts\.getSprayMode === 'function' && opts\.getSprayMode\(\) \? SPRAY_CODE : 'KeyH'\) : 'KeyR';/.test(gp) && gp.includes("const SPRAY_CODE = 'KeyX';") && FIRE_SPRAY_KEY === 'KeyX' && gp.includes("if (i === PAD.RT) return drive ? null : 'Mouse0';"));
  check('style.css：#tb-spray 樣式', read('src/style.css').includes('.tbtn#tb-spray {'));
}
{
  const ug = fnBody('updateGame');
  check('updateFirefighter 在 updateGame 內、時間縮放之後', ug.indexOf('updateFirefighter(') > ug.indexOf('dt *= stunts.timeScale;') && ug.indexOf('dt *= stunts.timeScale;') > 0);
}

const SEC_START = '// ---------- 消防車任務（P18，Firefighter）';
const section = (() => {
  const i = mainSrc.indexOf(SEC_START);
  const j = mainSrc.indexOf('\n  // ---------- 畫質 / 設定', i);
  return i > 0 && j > i ? mainSrc.slice(i, j) : '';
})();
check('抽出消防車段（特技跳台段之後、畫質段之前）', section.length > 1000 && mainSrc.indexOf('const cancelStunts = () => {') < mainSrc.indexOf(SEC_START));
check('消防車段不新增光源 / 貼圖 / 陰影', !/Light\(|Texture|castShadow|shadowMap/.test(section));
check('消防車段：draw call 增量 = 門口光柱 1 根（2 mesh）+ 水柱 1 個 InstancedMesh', (section.match(/createBeaconPool\(/g) || []).length === 1 && (section.match(/\.acquire\(/g) || []).length === 1 && (section.match(/createWaterCannonMesh\(/g) || []).length === 1);

// ---------- 其他檔案（原始碼）----------
{
  const veh = read('src/vehicle.js');
  check('VEHICLE_TYPES 含 fire_truck（label 消防車）', /\n  fire_truck: \{ label: '消防車', length: [\d.]+, width: [\d.]+, height: [\d.]+,[^\n]*mass: \d+/.test(veh));
  check('vehicle.js：fire_truck 座位 + 程式幾何後備（駕駛艙 / 銀色裝備箱 / 車頂水砲）', /FALLBACK_SEAT = \{[\s\S]*fire_truck: \{ x:/.test(veh) && veh.includes("if (type === 'fire_truck') {") && veh.includes('fireCannonBaseGeo') && veh.includes("cachedStandardMaterial('#c8ccd0'"));
  const fireBranch = veh.slice(veh.indexOf("if (type === 'fire_truck') {"), veh.indexOf('} else {', veh.indexOf("if (type === 'fire_truck') {")));
  check('vehicle.js 消防車後備幾何不新增貼圖 / 光源', fireBranch.length > 200 && !/Texture|Light\(|makeTextTexture/.test(fireBranch));
  const tr = read('src/traffic.js');
  check('traffic.js：獨立種子極低比例消防車、上限 1', /export const FIRE_TRUCK_CHANCE = 0\.0\d+;/.test(tr) && tr.includes('export const FIRE_TRUCK_MAX = 1;') && tr.includes('this.fireRng = mulberry32(CITY_SEED + 7);') && tr.includes("this._countType('fire_truck') < FIRE_TRUCK_MAX"));
  check('carjack.js：FALLBACK_SIZE.fire_truck', /fire_truck: \{ length: 7\.6, width: 2\.5 \}/.test(read('src/carjack.js')));
  const hudSrc = read('src/hud.js');
  check('hud.js：fire 超出小地圖半徑時貼邊（EDGE_KINDS）', /const EDGE_KINDS = new Set\(\[[^\]]*'ems-hospital', 'fire'\]\)/.test(hudSrc));
  check('marker-colors.js：fire 色碼、全表不重複', /^#[0-9a-f]{6}$/i.test(MARKER_COLORS.fire || '') && new Set(Object.values(MARKER_COLORS)).size === Object.keys(MARKER_COLORS).length);
  check('big-map.js：MARKER_LABELS fire 圖例', read('src/map/big-map.js').includes("fire: '起火車'"));
  check('light-pillar.js：BEACON_COLORS.fire', /safehouse: 0x1e88e5, fire: 0x[0-9a-f]{6} \}/.test(read('src/missions/light-pillar.js')));
  const css = read('src/style.css');
  check('style.css：.fire-bar（pointer-events none、[hidden]、urgent）', /\.fire-bar \{[^}]*pointer-events: none;/.test(css) && css.includes('.fire-bar[hidden]') && css.includes('.fire-bar.fire-urgent'));
  const ex = read('src/explosions.js');
  check('explosions.js：setFuse / extinguish / setFireproof 已列入檔頭', ['setFuse(vehicle, sec)', 'extinguish(vehicle)', 'setFireproof(fn | null)'].every((k) => ex.slice(0, 6000).includes(k)));
  const save = read('src/save.js');
  check('save.js：firefighter 選填欄位（不升版）', save.includes('function firefighterRecord(src)') && save.includes('if (ff) out.firefighter = ff;') && /export const SAVE_VERSION = 2;/.test(save));
}
{
  // 禁改檔案的保護：P18 段不得觸及 postfx / neon / helicopter（只檢 main.js 段落文字）
  check('消防車段未引用 postfx / neon / helicopter', !/postfx|neon|helicopter/i.test(section));
}

// ---------- 行為（抽段 + 替身）----------
{
  const bus = createBus();
  const health = new Map();
  const list = [];
  const vehicles = {
    vehicles: list,
    adopt({ type, color, x, z, yaw }) {
      const v = {
        type, color, pos: { x, y: 0, z }, yaw, speed: 0, fallen: false, driven: false,
        spec: type === 'fire_truck' ? { length: 7.6, width: 2.5, height: 3 } : { length: 4.5, width: 1.85, height: 1.45 },
        isOverturned: () => false, mesh: null,
      };
      list.push(v);
      return v;
    },
    remove(v) {
      const i = list.indexOf(v);
      if (i >= 0) list.splice(i, 1);
    },
  };
  const dmg = {
    attach: (v) => health.set(v, 1000),
    detach: (v) => health.delete(v),
    healthOf: (v) => (health.has(v) ? health.get(v) : null),
    maxHealthOf: (v) => (health.has(v) ? 1000 : null),
    addDamage: (v, n) => {
      if (!health.has(v)) return 0;
      const b = health.get(v);
      health.set(v, Math.max(0, b - n));
      return b - health.get(v);
    },
    repair: (v) => {
      if (health.has(v)) health.set(v, 1000);
    },
  };
  const explosions = createExplosions({ bus, config: { healthOf: dmg.healthOf, maxHealthOf: dmg.maxHealthOf, addDamage: dmg.addDamage, vehicles: () => list, rng: () => 0.5 } });
  const traffic = {
    cars: [],
    spawnSpots: (px, pz, rMin, rMax, out) => {
      out.length = 0;
      for (let a = 0; a < 6.28; a += 0.25) out.push({ x: px + Math.cos(a) * (rMin + 20), z: pz + Math.sin(a) * (rMin + 20), heading: a });
      return out;
    },
    spawnEjectedDriver: (o) => ({ ...o, pendingAttacker: {} }),
  };
  const adopted = new Set();
  const state = { started: true, mode: 'walk', vehicle: null, respawn: null, spraying: false };
  let racingBase = false;
  Object.defineProperty(state, 'racing', { get: () => racingBase, enumerable: true, configurable: true });
  const player = { pos: { x: FIRE_TRUCK_SPOT.x, y: 0, z: FIRE_TRUCK_SPOT.z } };
  const playerPos = () => (state.mode === 'drive' && state.vehicle ? state.vehicle.pos : player.pos);
  const cj = { vehicle: null };
  const bars = [];
  const createSideJobBar = ({ prefix }) => {
    const b = { prefix, text: null, set(t) { b.text = t; } };
    bars.push(b);
    return b;
  };
  const beacons = [];
  const createBeaconPool = (o) => ({ opts: o, acquire: (kind, x, z) => beacons.push({ kind, x, z }), update() {} });
  const vigEnds = [];
  const vigHooks = { active: () => false, end: (k) => vigEnds.push(k) };
  let others = false;
  const otherMissionBusy = () => others || state.racing;
  const vigilante = { active: false };
  const rampage = { active: false };
  const stunts = { active: false };
  const money = [];
  const economy = { add: (n, r) => money.push([n, r]) };
  const toasts = [];
  const hud = { toast: (t) => toasts.push(t) };
  const flushes = [];
  const autosave = { flush: (r) => (flushes.push(r), true) };
  const findRoute = () => null;
  const SIDEJOB_PRIORITY = 4;
  const touchBtns = new Map();
  const touchVis = new Map();
  const registerTouchButton = (d) => touchBtns.set(d.id, d);
  const setTouchButtonVisible = (id, on) => touchVis.set(id, on);
  const body = `${section}\nreturn { firefighter, fireWorld, fireTrucks, fireBar, waterCannon, firefighterInteractable, updateFirefighter, cancelFirefighter, fireMarkers, fireBusy };`;
  const names = ['createFirefighter', 'createFireWorld', 'createFireTruckDepot', 'createWaterCannonMesh', 'nozzleOf', 'isFireTruck', 'FIRE_STATION', 'FIRE_TRUCK_SPOT', 'FIRE_STATION_BEACON', 'FIRE_PROMPT_START', 'FIRE_PROMPT_QUIT',
    'bus', 'vehicles', 'dmg', 'explosions', 'traffic', 'adopted', 'state', 'cj', 'createSideJobBar', 'document', 'createBeaconPool', 'scene', 'heightAt', 'THREE', 'vigHooks', 'otherMissionBusy', 'vigilante', 'rampage', 'stunts',
    'economy', 'hud', 'findRoute', 'graph', 'autosave', 'SIDEJOB_PRIORITY', 'playerPos', 'registerTouchButton', 'setTouchButtonVisible', 'FIRE_SPRAY_KEY'];
  const vals = [createFirefighter, createFireWorld, createFireTruckDepot, createWaterCannonMesh, nozzleOf, isFireTruck, FIRE_STATION, FIRE_TRUCK_SPOT, FIRE_STATION_BEACON, FIRE_PROMPT_START, FIRE_PROMPT_QUIT,
    bus, vehicles, dmg, explosions, traffic, adopted, state, cj, createSideJobBar, { body: {} }, createBeaconPool, { add() {} }, () => 0, null, vigHooks, otherMissionBusy, vigilante, rampage, stunts,
    economy, hud, findRoute, {}, autosave, SIDEJOB_PRIORITY, playerPos, registerTouchButton, setTouchButtonVisible, FIRE_SPRAY_KEY];
  let w = null;
  try {
    w = new Function(...names, body)(...vals);
  } catch (err) {
    check('抽段可執行', false, String(err && err.stack));
  }
  if (w) {
    check('抽段可執行：任務條 prefix fire、門口光柱 1 根（kind fire、消防隊門口）', bars.length === 1 && bars[0].prefix === 'fire' && beacons.length === 1 && beacons[0].kind === 'fire' && beacons[0].x === FIRE_STATION.x);
    const truck = w.fireTrucks.ensure(true);
    check('fireTrucks.ensure(true)：消防隊前庭生成消防車', truck && truck.type === 'fire_truck' && list.includes(truck));
    const sedan = vehicles.adopt({ type: 'sedan', color: '#fff', x: 0, z: 0, yaw: 0 });
    check('非消防車：無互動提示', w.firefighterInteractable(sedan) === null);
    state.mode = 'drive';
    state.vehicle = truck;
    others = true;
    check('其他任務中：消防車不顯示開始提示', w.firefighterInteractable(truck) === null);
    others = false;
    rampage.active = true;
    check('暴走中：不出勤（互斥）', w.firefighterInteractable(truck) === null && w.fireBusy());
    rampage.active = false;
    stunts.active = true;
    check('特技跳台進行中：不出勤（互斥）', w.firefighterInteractable(truck) === null);
    stunts.active = false;
    const inter = w.firefighterInteractable(truck);
    check('駕駛消防車：開始提示', inter && inter.text === FIRE_PROMPT_START);
    inter.act();
    check('互動鍵 → 出勤', w.firefighter.active && w.firefighter.level === 1);
    check('出勤中：state.firefighter / state.racing（包裝）為真 → otherMissionBusy', state.firefighter === true && state.racing === true && otherMissionBusy());
    check('出勤中：vigHooks.active 為真（委託 / 噴漆擋）', vigHooks.active() === true);
    check('出勤中：提示改為收工', w.firefighterInteractable(truck).text === FIRE_PROMPT_QUIT);
    check('未出勤：tb-spray 已註冊（KeyX、hold、駕駛）但不顯示', touchBtns.get('tb-spray')?.code === 'KeyX' && touchBtns.get('tb-spray').mode === 'hold' && touchBtns.get('tb-spray').hidden === true && !touchVis.get('tb-spray'));
    w.updateFirefighter(0.05, false, false);
    check('出勤中駕駛消防車：顯示 tb-spray、隱藏喇叭', touchVis.get('tb-spray') === true && touchVis.get('tb-horn') === false);
    const slot = w.firefighter.slots[0];
    check('每幀：生成起火車（explosions 起火）、小地圖標記 fire、任務條文字', w.firefighter.phase === 'fight' && explosions.stateOf(slot.h.v) === 'fire' && w.fireMarkers().length === 1 && w.fireMarkers()[0].kind === 'fire' && /消防車｜第 1 關/.test(bars[0].text || ''));
    // 開到起火車西側 8 m、朝東，按住射擊鍵
    truck.pos.x = slot.x - 8 - 3.8;
    truck.pos.z = slot.z;
    truck.yaw = Math.PI / 2;
    const fuseBefore = explosions.fuseOf(slot.h.v);
    const leftBefore = w.firefighter.timeLeft;
    w.updateFirefighter(0.05, true, true);
    check('手機開著（skip）：不推進、不噴水', slot.hp === 100 && w.waterCannon.mesh === null);
    check('手機開著（skip）：任務計時不動、起火車引信延後 dt（hold）', w.firefighter.timeLeft === leftBefore && Math.abs(explosions.fuseOf(slot.h.v) - fuseBefore - 0.05) < 1e-9);
    for (let i = 0; i < 80 && w.firefighter.level === 1; i++) w.updateFirefighter(0.05, false, true);
    check('噴水 → 熄滅 → 過關入帳（firefighter, 450）', w.firefighter.level === 2 && money.some((m) => m[0] === 450 && m[1] === 'firefighter'));
    check('熄滅的起火車：熄火、修到安全耐久、交還 adopted（不留 doused / fireTarget）', adopted.size === 1 && [...adopted].every((v) => explosions.stateOf(v) !== 'fire' && !v.doused && !v.fireTarget && dmg.healthOf(v) === 1000 * (1 - DOUSED_DAMAGE)));
    // 防火只套玩家正駕駛的車
    w.firefighter.restore({ fireproof: true, best: MAX_LEVEL });
    const other = vehicles.adopt({ type: 'sedan', color: '#fff', x: 500, z: 500, yaw: 0 });
    dmg.attach(other);
    explosions.damageVehicle(other, 900);
    explosions.damageVehicle(truck, 900);
    check('已解鎖防火：玩家正駕駛的車 90% 不起火、其他車照常', explosions.stateOf(truck) !== 'fire' && explosions.stateOf(other) === 'fire');
    w.updateFirefighter(0.05, false, false);
    vigHooks.end('busted');
    check('BUSTED（vigHooks.end）→ 任務結束、任務條收起、原掛鉤照呼叫', !w.firefighter.active && bars[0].text === null && vigEnds.includes('busted'));
    inter.act();
    w.updateFirefighter(0.05, false, false);
    check('再出勤（第 1 關）', w.firefighter.active && w.firefighter.level === 1);
    const burning = w.firefighter.slots[0].h.v;
    // quitToMenu / startGame 順序：cancelFirefighter() → clearExplosions()
    w.cancelFirefighter();
    explosions.clear();
    check('cancelFirefighter：無聲結束、任務條收起、起火車熄火交還', !w.firefighter.active && bars[0].text === null && w.fireWorld.cars.size === 0 && [...adopted].every((v) => explosions.stateOf(v) !== 'fire'));
    check('cancelFirefighter：水砲鈕收起、喇叭還原', touchVis.get('tb-spray') === false && touchVis.get('tb-horn') === true);
    explosions.damageVehicle(burning, 1);
    check('cancel → clear 後交還的起火車：修到安全耐久、輕撞不重燃、無 doused', adopted.has(burning) && !burning.doused && explosions.stateOf(burning) !== 'fire' && dmg.healthOf(burning) === 1000 * (1 - DOUSED_DAMAGE) - 1);
  }
}

// ---------- 文件 ----------
{
  const doc = read('docs/dev/interfaces.md');
  const i = doc.indexOf('## 40. P18 消防車任務 Firefighter');
  const sec = i >= 0 ? doc.slice(i, doc.indexOf('\n## ', i + 5)) : '';
  check('interfaces.md 有 §40 消防車任務一節', sec.length > 1500);
  check('§40 列出介面（createFirefighter / createFireWorld / createFireTruckDepot / createWaterCannonMesh / explosions setter）', ['createFirefighter(', 'createFireWorld(', 'createFireTruckDepot(', 'createWaterCannonMesh(', 'setFuse(v, sec)', 'extinguish(v)', 'setFireproof(fn|null)'].every((s) => sec.includes(s)));
  check('§40 列出接線（updateFirefighter / firefighterInteractable / cancelFirefighter / save.js firefighter）', ['updateFirefighter(', 'firefighterInteractable(v)', 'cancelFirefighter()', 'firefighter: { fireproof: boolean, best: 1..12 }'].every((s) => sec.includes(s)));
  check('§40 列出限制（貼圖 / 光源 / draw call）', sec.includes('未新增 shadow map / 貼圖單元 / 光源') && sec.includes('draw call'));
  const ev = ['firefighter:start', 'firefighter:extinguish', 'firefighter:level', 'firefighter:complete', 'firefighter:fail'];
  check('interfaces.md 事件表含 firefighter:*', ev.every((e) => doc.includes(`| \`${e}\` |`)));
}

console.log(failed === 0 ? `PASS ${passed}/${passed}` : `FAIL ${failed}/${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
