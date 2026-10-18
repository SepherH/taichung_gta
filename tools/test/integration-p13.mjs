#!/usr/bin/env node
// Phase 13 整合驗證：計程車 / 救護車副任務接線（main.js 原始碼字串比對 + 抽出副任務段以替身執行；不 import three / rapier）
// 用法：node tools/test/integration-p13.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：import / 常數、建立 taxi / ems / curbPeds / 任務條 / 光柱池 / 救護車停放、collectMarkers 併入、updateSideJobs 接在 updateGangs 之後、
//   互動鍵順序（raceInteractable → sideJobInteractable → vigilanteInteractable）、互斥（state.sideJob 併入 otherMissionBusy / 搶劫守門 / 委託遮罩、
//   vigHooks.active / end 包裝）、quitToMenu / startGame → cancelSideJobs、startGame → ambulances.ensure、window.__game；救護車外觀不加光源 / 貼圖 / 投影；
//   行為（抽段 + 替身）：非計程車無互動、開始 / 收工、互斥（其他任務 / 警車任務）、招客上車、目的地光柱、入帳 reason、救護車生成 + 裝飾 + 頂燈閃爍、
//   送醫回血、BUSTED（vigHooks.end）、下車 10 s、車毀、手機凍結、cancel；hud.js / marker-colors / big-map / light-pillar / style.css / interfaces.md §35
// 注意：staging 無 node_modules；main.js / hud.js / big-map.js 依賴 three / css / JSON import，一律原始碼字串比對
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBus } from '../../src/core/events.js';
import { createTaxi, createCurbPedWorld, createSideJobBar, PROMPT_START as TAXI_PROMPT_START, PROMPT_QUIT as TAXI_PROMPT_QUIT, LEFT_SEC } from '../../src/missions/taxi.js';
import { createEms, createAmbulanceDepot, ambulanceSpot, PROMPT_START as EMS_PROMPT_START, PROMPT_QUIT as EMS_PROMPT_QUIT, PICK_SEC } from '../../src/missions/ems.js';
import { HOSPITAL } from '../../src/wanted/places.js';
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
  ['import：missions/taxi.js / ems.js', [
    "import { createTaxi, createCurbPedWorld, createSideJobBar, PROMPT_START as TAXI_PROMPT_START, PROMPT_QUIT as TAXI_PROMPT_QUIT } from './missions/taxi.js';",
    "import { createEms, createAmbulanceDepot, ambulanceSpot, PROMPT_START as EMS_PROMPT_START, PROMPT_QUIT as EMS_PROMPT_QUIT } from './missions/ems.js';",
  ]],
  ['常數集中檔頭', [/^const SIDEJOB_PRIORITY = \d+;/m, /^const SIDEJOB_BEACON = \{ height: \d+, radius: \d+, sink: \d+ \};/m, /^const AMB_FLASH_SEC = [\d.]+;/m]],
  ['建立 taxi / ems / curbPeds / 任務條 / 光柱池 / 救護車停放', [
    'const taxi = createTaxi({ bus, rng: Math.random });',
    'const ems = createEms({ bus, rng: Math.random });',
    'const curbPeds = createCurbPedWorld({ traffic, combat, rng: Math.random, getPlayer: () => playerPos() });',
    "const taxiBar = createSideJobBar({ root: document.body, prefix: 'taxi' });",
    "const emsBar = createSideJobBar({ root: document.body, prefix: 'ems' });",
    'const sideJobBeacons = createBeaconPool({ scene, heightAt, ...SIDEJOB_BEACON });',
    'vehicles, dmg, spot: ambulanceSpot(), decorate: decorateAmbulance,',
  ]],
  ['互斥：state.sideJob getter 併入 otherMissionBusy（不動既有字串順序）/ 搶劫守門 / 委託遮罩', [
    "Object.defineProperty(state, 'sideJob', { get: () => taxi.active || ems.active, enumerable: true, configurable: true });",
    'const otherMissionBusy = () => !!(state.sideJob || missions.active() || missions.eventActive() || missions.jobActive() || robberies.active || state.spraying || state.racing);',
    'if (state.sideJob) robCtx.onFoot = false;',
    'if (state.sideJob) interCands[0] = null;',
  ]],
  ['互斥：vigHooks.active / vigHooks.end 包裝', [
    'const vigActiveSide = vigHooks.active;',
    'vigHooks.active = () => vigActiveSide() || taxi.active || ems.active;',
    'const vigEndSide = vigHooks.end;',
    /vigHooks\.end = \(kind\) => \{\s*\n\s*vigEndSide\(kind\);\s*\n\s*taxi\.end\(kind\);\s*\n\s*ems\.end\(kind\);/,
  ]],
  ['開始條件：busy = otherMissionBusy || vigilante.active', ['const sideBusy = () => otherMissionBusy() || vigilante.active;']],
  ['小地圖 / 大地圖：collectMarkers 併入 sideJobMarkers', [/pushAll\(out, raceMarkers\(\)\);\s*\n\s*pushAll\(out, sideJobMarkers\(\)\);/]],
  ['每幀：updateSideJobs 接在 updateGangs 之後', [/updateGangs\(dt, phoneOpen\);\s*\n\s*updateSideJobs\(dt, phoneOpen\);/]],
  ['互動鍵：raceInteractable → vigilanteInteractable / nearestInteractable（委託 / 打卡）→ sideJobInteractable 後備', [
    /inter = raceInteractable\(v\);[^\n]*\n\s*if \(!inter\) inter = vigilanteInteractable\(v\) \|\| nearestInteractable\(v\.pos, false\);\n(\s*\/\/[^\n]*\n)*\s*if \(!inter\) inter = sideJobInteractable\(v\);/,
  ]],
  ['ctx：earn reason taxi / ems、heal = 玩家 hp 回滿、routeLength = findRoute.lengthM', [
    "earn: (n) => economy.add(n, 'taxi'),",
    "earn: (n) => economy.add(n, 'ems'),",
    'player.actor.hp = player.actor.maxHp;',
    'const r = findRoute(graph, a, b);',
    'return r ? r.lengthM : null;',
  ]],
  ['開局：startGame → ambulances.ensure(true)（placePlayer 之後）', [/placePlayer\(save\);\s*\n\s*ambulances\.ensure\(true\);/]],
  ['除錯物件：window.__game.taxi / ems / curbPeds / ambulances', ['taxi, ems, curbPeds, ambulances,']],
];
for (const [name, list] of GROUPS) {
  const bad = missing(mainSrc, list);
  check(`main.js 接線：${name}`, bad.length === 0, bad.map((b) => (b instanceof RegExp ? b.source : b)).join(' | '));
}
{
  const fnBody = (name) => (mainSrc.match(new RegExp(`const ${name} = \\([^)]*\\) => \\{([\\s\\S]*?)\\n {2}\\};`)) || [])[1] || '';
  for (const name of ['quitToMenu', 'startGame']) {
    const body = fnBody(name);
    const iR = body.indexOf('cancelRace();');
    const iS = body.indexOf('cancelSideJobs();');
    const iRe = body.indexOf('cancelRespawn();');
    check(`${name}：cancelSideJobs() 緊接 cancelRace()、在 cancelRespawn 之前`, iR >= 0 && iS > iR && iRe > iS, `race@${iR} side@${iS} respawn@${iRe}`);
  }
  const iSide = mainSrc.indexOf('  // ---------- 計程車 / 救護車副任務（Phase 13');
  const iRace = mainSrc.indexOf('  // ---------- 街頭競速（Phase 12');
  check('宣告順序：vigilante < 副任務段 < 競速段（競速再包裝 vigHooks，鏈完整）', mainSrc.indexOf('const vigilante = createVigilante(') < iSide && iSide < iRace && iSide > 0);
  // 其他整合測試抽段不得引用副任務（p7 對抗段、p9 搶劫段、p11 警車任務段、p12 競速段只能讀 state.sideJob）
  const sliceOf = (a, b) => mainSrc.slice(mainSrc.indexOf(a), mainSrc.indexOf(b));
  const segs = [
    ['integration-p7', sliceOf('  // ---------- 對抗 / KO ----------', '  // ---------- 車輛耐久：')],
    ['integration-p9', sliceOf('  // ---------- 超商搶劫（Phase 9', '  // ---------- 車流 / 行人外部狀態 ----------')],
    ['integration-p11', sliceOf('  // ---------- 警車任務（Phase 11', '  // ---------- 超商搶劫（Phase 9')],
    ['integration-p12', sliceOf('  // ---------- 街頭競速（Phase 12', '  // ---------- V2 幫派地盤')],
  ];
  for (const [n, seg] of segs) check(`${n} 抽段不直接引用 taxi / ems / curbPeds / ambulances（只經 state.sideJob）`, seg.length > 1000 && !/\btaxi\.|\bems\.|\bcurbPeds\b|\bambulances\b|\btaxiBar\b|\bemsBar\b/.test(seg));
}

// ---------- 行為：抽出 main.js 副任務段，以替身執行 ----------
const SLICE_START = '  // ---------- 計程車 / 救護車副任務（Phase 13';
const SLICE_END = '  // ---------- 街頭競速（Phase 12';
const slice = mainSrc.slice(mainSrc.indexOf(SLICE_START), mainSrc.indexOf(SLICE_END));
const consts = ['SIDEJOB_PRIORITY', 'SIDEJOB_BEACON', 'AMB_FLASH_SEC'].map((n) => (mainSrc.match(new RegExp(`^const ${n} = .*$`, 'm')) || [''])[0]).join('\n');
check('取出 main.js 副任務段與常數', slice.length > 3000 && consts.split('\n').every(Boolean));
check('救護車外觀：無光源（*Light）、無貼圖（map:）、不開投影（castShadow = true）、頂燈只改 emissiveIntensity', !/Light\(/.test(slice) && !/\bmap:/.test(slice) && !/castShadow\s*=\s*true/.test(slice) && /emissiveIntensity = st === 1/.test(slice));

const THREE = {
  BoxGeometry: class {},
  MeshStandardMaterial: class {
    constructor(o) {
      Object.assign(this, o);
    }
  },
  Group: class {
    constructor() {
      this.children = [];
      this.name = '';
      this.scale = { set(x, y, z) { Object.assign(this, { x, y, z }); } };
    }
    add(c) {
      this.children.push(c);
    }
  },
  Mesh: class {
    constructor(g, m) {
      this.geometry = g;
      this.material = m;
      this.scale = { set() {} };
      this.position = { set(x, y, z) { Object.assign(this, { x, y, z }); } };
    }
  },
};
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
const fakeMesh = () => ({
  scale: { x: 1, y: 1, z: 1 },
  children: [],
  add(c) {
    this.children.push(c);
  },
  getObjectByName(n) {
    return this.children.find((c) => c.name === n) || null;
  },
});

function makeWorld() {
  const bus = createBus();
  const log = [];
  for (const n of ['taxi:start', 'taxi:pickup', 'taxi:paid', 'taxi:end', 'ems:start', 'ems:level', 'ems:end']) bus.on(n, (e) => log.push([n, e]));
  const doc = fakeDoc();
  const health = new Map();
  const mkCar = (type, x, z) => ({ type, pos: { x, z }, yaw: 0, driven: false, speed: 0, fallen: false, overturned: false, mesh: fakeMesh(), spec: { length: 4.9, width: 2, height: 1.8 }, isOverturned() { return this.overturned; } });
  const taxiCar = mkCar('taxi', 0, 0);
  const sedan = mkCar('sedan', 5, 0);
  const vehicles = {
    vehicles: [taxiCar, sedan],
    adopt(o) {
      const v = { ...mkCar(o.type, o.x, o.z), color: o.color, yaw: o.yaw };
      this.vehicles.push(v);
      return v;
    },
    remove(v) {
      const i = this.vehicles.indexOf(v);
      if (i >= 0) this.vehicles.splice(i, 1);
    },
  };
  for (const v of vehicles.vehicles) health.set(v, 1000);
  const dmg = { attach: (v) => health.set(v, 1000), detach: (v) => health.delete(v), healthOf: (v) => (health.has(v) ? health.get(v) : null), maxHealthOf: (v) => (health.has(v) ? 1000 : null) };
  // 路人 / combat 替身
  let now = 0;
  const entries = new Map();
  const peds = [];
  const recycled = [];
  const mkPed = (id, x, z) => {
    const p = { alive: true, actor: { id }, citizen: { id }, x, z, state: 'walk', pendingFrom: null, brain: { override: null, state: 'wander' }, anim: { n: 0, playGesture() { this.n++; } } };
    entries.set(id, { state: 'normal', stateAt: 0, dying: false });
    peds.push(p);
    return p;
  };
  const combat = {
    entries,
    now: () => now,
    stateOf: (a) => (entries.get(a.id) || { state: 'normal' }).state,
    knockdownActor(a) {
      const e = entries.get(a.id);
      e.state = 'knockdown';
      e.stateAt = now;
      return true;
    },
  };
  // combat.update 替身：倒地滿 GETUP_MIN_DOWN（1.5 s）且未 dying → 起身（世界照跑時每幀推進）
  const combatTick = () => {
    for (const e of entries.values()) if (e.state === 'knockdown' && !e.dying && now - e.stateAt >= 1.5) e.state = 'normal';
  };
  const traffic = {
    peds,
    _recyclePed(c) {
      recycled.push(c);
      const i = peds.findIndex((p) => p.citizen === c);
      if (i >= 0) peds.splice(i, 1);
    },
  };
  const pools = [];
  const toasts = [];
  const money = { total: 0, reasons: [] };
  const vig = { active: false };
  const busy = { on: false };
  const playerActor = { hp: 40, maxHp: 100 };
  const deps = {
    bus,
    THREE,
    createTaxi,
    createEms,
    createCurbPedWorld,
    createSideJobBar,
    createAmbulanceDepot,
    ambulanceSpot,
    TAXI_PROMPT_START,
    TAXI_PROMPT_QUIT,
    EMS_PROMPT_START,
    EMS_PROMPT_QUIT,
    traffic,
    combat,
    vehicles,
    dmg,
    findRoute: (g, a, b) => ({ points: [a, b], lengthM: 1000 }),
    graph: {},
    state: { mode: 'drive', vehicle: taxiCar, respawn: null, spraying: null },
    cj: { vehicle: null },
    document: doc,
    createBeaconPool: (o) => {
      const live = [];
      const p = { opts: o, live, updates: 0, acquire(kind, x, z, owner) { const b = { kind, x, z, owner }; live.push(b); return b; }, releaseAll() { live.length = 0; }, update() { this.updates++; } };
      pools.push(p);
      return p;
    },
    scene: {},
    heightAt: () => 0,
    vigHooks: { fugitiveActor: () => false, fugitiveShot: () => false, end: (k) => log.push(['vig:end', k]), active: () => vig.active },
    economy: { add: (n, reason) => { money.total += n; money.reasons.push(reason); } },
    hud: { toast: (t) => toasts.push(t) },
    otherMissionBusy: () => busy.on || !!deps.state.sideJob,
    vigilante: vig,
    playerPos: () => (deps.state.mode === 'drive' && deps.state.vehicle ? deps.state.vehicle.pos : walkPos),
    player: { actor: playerActor },
  };
  const walkPos = { x: 0, z: 0 };
  const names = Object.keys(deps);
  const body = `${consts}\n${slice}\nreturn { taxi, ems, curbPeds, ambulances, taxiBar, emsBar, sideJobInteractable, updateSideJobs, cancelSideJobs, sideJobMarkers, ambLightMats };`;
  const api = new Function(...names, body)(...names.map((n) => deps[n]));
  const setTime = (t) => (now = t);
  return { ...api, deps, log, doc, vehicles, health, toasts, money, taxiCar, sedan, pools, vig, busy, mkPed, recycled, playerActor, walkPos, entries, setTime, combatTick, now: () => now };
}
const run = (w, sec, dt = 1 / 30, skip = false) => {
  for (let t = 0; t < sec - 1e-9; t += dt) w.updateSideJobs(dt, skip);
};
const drive = (w, v) => {
  w.deps.state.mode = 'drive';
  w.deps.state.vehicle = v;
};
const walk = (w) => {
  w.deps.state.mode = 'walk';
  w.deps.state.vehicle = null;
};

{
  const w = makeWorld();
  const [beacons] = w.pools;
  check('光柱池：SIDEJOB_BEACON 選項', beacons && beacons.opts.radius > 0 && beacons.opts.height > 0);
  drive(w, w.sedan);
  check('駕駛一般轎車：無副任務互動', w.sideJobInteractable(w.sedan) === null);
  check('步行（v = null）：無副任務互動', w.sideJobInteractable(null) === null);
  drive(w, w.taxiCar);
  const inter = w.sideJobInteractable(w.taxiCar);
  check(`駕駛計程車：互動提示「${TAXI_PROMPT_START}」`, inter && inter.text === TAXI_PROMPT_START && inter.priority > 0);
  w.busy.on = true;
  check('其他任務進行中：不提供開始', w.sideJobInteractable(w.taxiCar) === null);
  w.busy.on = false;
  w.vig.active = true;
  check('警車任務中：不提供開始', w.sideJobInteractable(w.taxiCar) === null);
  w.vig.active = false;
  w.deps.state.respawn = 'busted';
  check('BUSTED / WASTED 中：無互動', w.sideJobInteractable(w.taxiCar) === null);
  w.deps.state.respawn = null;
  check('vigHooks.active 已包裝：未開始 false', w.deps.vigHooks.active() === false);
  inter.act();
  check('按下 → 計程車開始、state.sideJob 真、vigHooks.active 真（委託類 / 噴漆不開始）', w.taxi.active && w.deps.state.sideJob === true && w.deps.vigHooks.active() === true && w.log.some((e) => e[0] === 'taxi:start'));
  check(`進行中：提示改為「${TAXI_PROMPT_QUIT}」`, w.sideJobInteractable(w.taxiCar).text === TAXI_PROMPT_QUIT);
  // 招客：附近 40 m 一位路人
  const ped = w.mkPed(1, 40, 0);
  run(w, 0.1);
  const bar = w.doc.body.children.find((c) => c.className.startsWith('taxi-bar'));
  check('招客：路人改招手（brain.override）、小地圖 taxi-fare、任務條顯示', !!ped.brain.override && w.sideJobMarkers().some((m) => m.kind === 'taxi-fare') && bar && !bar.hidden && bar.textContent.startsWith('計程車｜'), bar && bar.textContent);
  w.taxiCar.pos.x = 36;
  run(w, 0.1);
  check('停到乘客旁 → 上車（路人回收）、目的地光柱 kind taxi、小地圖 taxi-dest', w.taxi.phase === 'ride' && w.recycled.includes(ped.citizen) && beacons.live.length === 1 && beacons.live[0].kind === 'taxi' && w.sideJobMarkers().some((m) => m.kind === 'taxi-dest'));
  check('限時用 routeLength（findRoute.lengthM 1000 m → 120 s）', Math.abs(w.taxi.trip.limit - 120) < 1e-6);
  const d = w.taxi.dest;
  w.taxiCar.pos.x = d.x;
  w.taxiCar.pos.z = d.z;
  run(w, 0.1);
  check("送達 → economy.add(…, 'taxi')、光柱收起", w.money.total > 0 && w.money.reasons.join() === 'taxi' && beacons.live.length === 0 && w.log.some((e) => e[0] === 'taxi:paid'));
  // 手機凍結：計時不走
  w.mkPed(2, d.x + 40, d.z);
  run(w, 1.2);
  w.taxiCar.pos.x = d.x + 37;
  run(w, 0.1);
  const t0 = w.taxi.trip.timeLeft;
  run(w, 2, 1 / 30, true);
  w.deps.state.spraying = 'spray-1';
  run(w, 1);
  w.deps.state.spraying = null;
  check('手機 / 噴漆中：不推進（計時停）', w.taxi.phase === 'ride' && w.taxi.trip.timeLeft === t0);
  w.sideJobInteractable(w.taxiCar).act();
  check('任務中再按 → 收工 quit toast、state.sideJob 假', !w.taxi.active && w.deps.state.sideJob === false && w.toasts.some((t) => t.startsWith('計程車收工')));
  run(w, 0.1);
  check('收工後任務條收起', bar.hidden);
}
{
  const w = makeWorld();
  drive(w, w.taxiCar);
  w.sideJobInteractable(w.taxiCar).act();
  walk(w);
  run(w, LEFT_SEC + 0.2);
  check('下車 > 10 s → 結束 left', !w.taxi.active && w.log.some((e) => e[0] === 'taxi:end' && e[1].reason === 'left'));
}
{
  const w = makeWorld();
  drive(w, w.taxiCar);
  w.sideJobInteractable(w.taxiCar).act();
  run(w, 0.1);
  w.health.set(w.taxiCar, 0);
  run(w, 0.1);
  check('計程車耐久歸零 → 結束 wrecked', !w.taxi.active && w.log.some((e) => e[0] === 'taxi:end' && e[1].reason === 'wrecked'));
}
{
  const w = makeWorld();
  drive(w, w.taxiCar);
  w.health.set(w.taxiCar, 0);
  w.sideJobInteractable(w.taxiCar).act();
  check('熄火的計程車：按下 toast、不開始', !w.taxi.active && w.toasts.some((t) => t.includes('熄火')));
}
{
  // 救護車：開局生成 + 裝飾 + 出勤 + 頂燈 + 撿傷患 + 送醫回血
  const w = makeWorld();
  const amb = w.ambulances.ensure(true);
  const spot = ambulanceSpot();
  const decor = amb && amb.mesh.getObjectByName('ems-decor');
  check('ambulances.ensure(true)：醫院旁 suv 白車、v.ambulance、dmg.attach', amb && amb.type === 'suv' && amb.ambulance && w.health.get(amb) === 1000 && Math.abs(amb.pos.x - spot.x) < 1e-6);
  check('救護車外觀：ems-decor 群組 = 2 條紅條 + 2 顆頂燈（emissive 材質）', decor && decor.children.length === 4 && decor.children.slice(2).every((m) => m.material.emissive > 0));
  w.ambulances.ensure(true);
  check('重複 ensure：不重複裝飾 / 生成', amb.mesh.children.filter((c) => c.name === 'ems-decor').length === 1 && w.vehicles.vehicles.filter((v) => v.ambulance).length === 1);
  drive(w, amb);
  const inter = w.sideJobInteractable(amb);
  check(`駕駛救護車：互動提示「${EMS_PROMPT_START}」`, inter && inter.text === EMS_PROMPT_START);
  w.taxi.start(); // 計程車任務中（除錯直接開始）
  check('計程車任務中：救護車不提供開始（互斥）', w.sideJobInteractable(amb) === null);
  w.taxi.cancel();
  w.sideJobInteractable(amb).act();
  check('出勤 → ems.active、state.sideJob 真', w.ems.active && w.deps.state.sideJob === true && w.log.some((e) => e[0] === 'ems:start'));
  const p = w.mkPed(5, amb.pos.x + 40, amb.pos.z);
  const [red, blue] = w.ambLightMats;
  const seen = new Set();
  for (let i = 0; i < 30; i++) {
    w.updateSideJobs(1 / 30, false);
    seen.add(`${red.emissiveIntensity}/${blue.emissiveIntensity}`);
  }
  check('救護車任務中：頂燈紅藍交替（emissiveIntensity 兩種狀態）', seen.size === 2 && [...seen].every((s) => s.split('/').some((x) => Number(x) > 1)), [...seen].join(' '));
  check('傷患：路人 knockdown 倒地、小地圖 ems-patient', w.entries.get(5).state === 'knockdown' && w.sideJobMarkers().some((m) => m.kind === 'ems-patient'));
  amb.pos.x = p.x - 3;
  run(w, PICK_SEC + 0.1);
  check('停車 3 s → 傷患上車、醫院光柱 kind ems', w.ems.phase === 'deliver' && w.recycled.includes(p.citizen) && w.pools[0].live.length === 1 && w.pools[0].live[0].kind === 'ems');
  amb.pos.x = HOSPITAL.x;
  amb.pos.z = HOSPITAL.z;
  w.playerActor.hp = 25;
  run(w, 0.1);
  check("送醫：economy.add(300, 'ems')、玩家 hp 回滿、第 2 關", w.money.total === 300 && w.money.reasons.join() === 'ems' && w.playerActor.hp === 100 && w.ems.level === 2);
  w.deps.vigHooks.end('busted');
  const bar = w.doc.body.children.find((c) => c.className.startsWith('ems-bar'));
  check('BUSTED：vigHooks.end（包裝）→ 原掛鉤照呼叫 + 救護車任務結束 busted、任務條收起', w.log.some((e) => e[0] === 'vig:end' && e[1] === 'busted') && !w.ems.active && bar.hidden && w.log.some((e) => e[0] === 'ems:end' && e[1].reason === 'busted'));
  run(w, 1);
  check('結束後頂燈轉暗', red.emissiveIntensity < 1 && blue.emissiveIntensity < 1);
}
{
  const w = makeWorld();
  drive(w, w.taxiCar);
  w.sideJobInteractable(w.taxiCar).act();
  run(w, 0.1);
  const n = w.toasts.length;
  w.cancelSideJobs();
  const bar = w.doc.body.children.find((c) => c.className.startsWith('taxi-bar'));
  check('cancelSideJobs()：無聲結束、任務條收起、光柱收起', !w.taxi.active && !w.ems.active && w.toasts.length === n && bar.hidden && w.pools[0].live.length === 0);
}

// ---------- 回歸（cr-p13 審查修正）----------
{
  // 🔴：手機開著（世界照跑、combat 推進起身）時傷患倒地計時照刷，不得自行站起
  const w = makeWorld();
  const amb = w.ambulances.ensure(true);
  drive(w, amb);
  w.sideJobInteractable(amb).act();
  w.mkPed(5, amb.pos.x + 40, amb.pos.z);
  const step = (sec, skip) => {
    for (let s = 0; s < sec - 1e-9; s += 1 / 30) {
      w.setTime(w.now() + 1 / 30);
      w.combatTick();
      w.updateSideJobs(1 / 30, skip);
    }
  };
  step(0.5, false);
  check('救護車任務：傷患倒地、collect', w.entries.get(5).state === 'knockdown' && w.ems.phase === 'collect');
  step(3, true);
  check('手機開著 3 s（combat 照跑）：傷患仍倒地', w.entries.get(5).state === 'knockdown' && w.ems.phase === 'collect', w.entries.get(5).state);
  w.deps.state.spraying = 'spray-1';
  step(3, false);
  w.deps.state.spraying = null;
  check('噴漆中 3 s：傷患仍倒地', w.entries.get(5).state === 'knockdown');
  step(3, false);
  check('關手機後 3 s：傷患仍倒地、任務照常', w.entries.get(5).state === 'knockdown' && w.ems.active);
  // 頂燈：cancelSideJobs 立即轉暗（選單 / BUSTED 畫面不跑 updateSideJobs）
  const [red, blue] = w.ambLightMats;
  let lit = false;
  for (let i = 0; i < 20 && !lit; i++) {
    step(1 / 30, false);
    lit = red.emissiveIntensity > 1 || blue.emissiveIntensity > 1;
  }
  w.cancelSideJobs();
  check('cancelSideJobs：頂燈立即轉暗、傷患交還（live 0）', lit && red.emissiveIntensity < 1 && blue.emissiveIntensity < 1 && w.curbPeds.live.size === 0);
}
{
  // 🟡3：乘客被 traffic 回收 → curbPeds.live 交還；cancelSideJobs → curbPeds.dispose()
  const w = makeWorld();
  drive(w, w.taxiCar);
  w.sideJobInteractable(w.taxiCar).act();
  const p = w.mkPed(1, 40, 0);
  run(w, 0.1);
  check('招手乘客：citizen.pinned（traffic 不依距離回收）', !!w.taxi.fare && p.citizen.pinned === true);
  p.alive = false; // traffic 回收（骨架回池）
  run(w, 0.1);
  check('乘客失效 → world.remove 交還（live 0）', w.taxi.fare === null && w.curbPeds.live.size === 0, `live ${w.curbPeds.live.size}`);
  const q = w.mkPed(2, 0, 60);
  w.curbPeds.spawnFare({ x: 0, z: 0 }, 25, 90); // 殘留 handle（任務外徵用）
  w.cancelSideJobs();
  check('cancelSideJobs → curbPeds.dispose：live 清空、override / pinned 解除', w.curbPeds.live.size === 0 && q.brain.override === null && q.citizen.pinned === false);
}
{
  // 🟡4：載客中換開另一台計程車 → 以上車那台車為準
  const w = makeWorld();
  drive(w, w.taxiCar);
  w.sideJobInteractable(w.taxiCar).act();
  w.mkPed(1, 40, 0);
  run(w, 0.1);
  w.taxiCar.pos.x = 36;
  run(w, 0.1);
  check('上車 → ride', w.taxi.phase === 'ride');
  const taxiB = w.vehicles.adopt({ type: 'taxi', x: 36, z: 3 });
  w.health.set(taxiB, 700); // 已受損 30%
  drive(w, taxiB);
  run(w, 1);
  check('換開受損的另一台計程車：不誤判 damaged、乘客仍在上車那台', w.taxi.phase === 'ride' && !w.toasts.some((t) => t.includes('車撞成這樣')));
  const d = w.taxi.dest || { x: 9999, z: 9999 }; // 修前已被判 damaged（dest null）→ 下列斷言照常 FAIL 而非拋例外
  taxiB.pos.x = d.x;
  taxiB.pos.z = d.z;
  run(w, 0.1);
  check('開換的車到目的地：不付費', w.taxi.phase === 'ride' && w.money.total === 0);
  drive(w, w.taxiCar);
  w.taxiCar.pos.x = d.x;
  w.taxiCar.pos.z = d.z;
  run(w, 0.1);
  check('換回上車那台到目的地 → 付費', w.money.total > 0 && w.taxi.phase === 'seek');
}
{
  // 🟡6：救護車開走棄置遠處 → 開局 / 遊戲中收回並在醫院補車；任務中（emsCar）不收回
  const w = makeWorld();
  const spot = ambulanceSpot();
  const amb = w.ambulances.ensure(true);
  drive(w, amb);
  w.sideJobInteractable(amb).act();
  amb.pos.x = spot.x + 3000;
  walk(w);
  w.walkPos.x = spot.x + 1500;
  w.walkPos.z = spot.z;
  run(w, 5.2);
  check('任務中下車走遠（emsCar）：救護車不被收回', w.ems.active && w.ambulances.vehicle === amb);
  w.ems.end('quit');
  run(w, 5.2);
  const v2 = w.ambulances.vehicle;
  check('任務結束、玩家遠離 → 棄車收回、醫院補車', v2 && v2 !== amb && !w.vehicles.vehicles.includes(amb) && Math.hypot(v2.pos.x - spot.x, v2.pos.z - spot.z) < 1 && w.vehicles.vehicles.filter((v) => v.ambulance).length === 1);
  v2.pos.x = spot.x - 3000;
  w.walkPos.x = v2.pos.x + 5;
  const v3 = w.ambulances.ensure(true);
  check('開局 ensure(true)：遠處的救護車收回、停放點重新生成（不沿用）', v3 && v3 !== v2 && Math.hypot(v3.pos.x - spot.x, v3.pos.z - spot.z) < 1 && w.vehicles.vehicles.filter((v) => v.ambulance).length === 1);
}
{
  // 🟡1：traffic.js 依距離 / 密度回收跳過 citizen.pinned（最小改動，原始碼斷言；traffic 需 three 無頭跑不動）
  const tSrc = read('src/traffic.js');
  check('traffic.js：_manageCrowd 回收半徑外跳過 pinned', /if \(d2 > far2 && recycled < farLimit && !c\.pinned\) \{/.test(tSrc));
  check('traffic.js：_canRecycle 對 pinned 回 false（密度 / 補生成 / 被拖出司機的回收）', /_canRecycle\(c\) \{\s*\n\s*if \(c\.pinned\) return false;/.test(tSrc));
}

// ---------- hud.js / marker-colors / big-map / light-pillar / style.css ----------
const hudSrc = read('src/hud.js');
check('hud.js：入帳跳字 taxi「計程車」/ ems「救護車」', /MONEY_REASON_LABEL = \{[^}]*taxi: '計程車 ', ems: '救護車 '/.test(hudSrc));
check('hud.js：taxi-fare / taxi-dest / ems-patient / ems-hospital 超出小地圖半徑時貼邊（EDGE_KINDS）', /const EDGE_KINDS = new Set\(\[[^\]]*'taxi-fare', 'taxi-dest', 'ems-patient', 'ems-hospital'/.test(hudSrc));
const kinds = ['taxi-fare', 'taxi-dest', 'ems-patient', 'ems-hospital'];
check('marker-colors.js：四種新 kind 有色碼、全表色碼不重複', kinds.every((k) => /^#[0-9a-f]{6}$/i.test(MARKER_COLORS[k] || '')) && new Set(Object.values(MARKER_COLORS)).size === Object.keys(MARKER_COLORS).length);
const bigSrc = read('src/map/big-map.js');
check('big-map.js：MARKER_LABELS 圖例', ["'taxi-fare': '計程車乘客'", "'taxi-dest': '計程車目的地'", "'ems-patient': '傷患'", "'ems-hospital': '醫院'"].every((k) => bigSrc.includes(k)));
check('light-pillar.js：BEACON_COLORS.taxi / ems', /taxi: 0xf5c518, ems: 0xe53935/.test(read('src/missions/light-pillar.js')));
const styleSrc = read('src/style.css');
check('style.css：.taxi-bar / .ems-bar（pointer-events none、[hidden]、urgent）', ['.taxi-bar,\n.ems-bar {', '.taxi-bar[hidden]', '.ems-bar[hidden]', '.taxi-bar.taxi-urgent', '.ems-bar.ems-urgent'].every((k) => styleSrc.includes(k)) && /\.taxi-bar,\n\.ems-bar \{[^}]*pointer-events: none;/.test(styleSrc));
check('missions：taxi.js / ems.js 不 import three / rapier（純邏輯）', ['src/missions/taxi.js', 'src/missions/ems.js'].every((f) => !/^import [^\n]*(three|rapier)/m.test(read(f))));

// ---------- interfaces.md：§35 + 事件表 ----------
const docs = read('docs/dev/interfaces.md');
check('interfaces.md：§35 Phase 13 計程車 / 救護車副任務', docs.includes('## 35. Phase 13 計程車 / 救護車副任務 Taxi / EMS'));
check('interfaces.md：事件表含 taxi:* / ems:*', ['taxi:start', 'taxi:fare', 'taxi:pickup', 'taxi:paid', 'taxi:failed', 'taxi:end', 'ems:start', 'ems:patients', 'ems:pickup', 'ems:level', 'ems:end'].every((k) => docs.includes(`| \`${k}\` |`)));

console.log(`${failed === 0 ? 'PASS' : 'FAIL'} ${failed === 0 ? passed : failed}/${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
