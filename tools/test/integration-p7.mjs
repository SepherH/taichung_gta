#!/usr/bin/env node
// Phase 7 整合（p7-integ）驗證：通緝 / 警力 / 被捕 / 送醫的接線
// 用法：node tools/test/integration-p7.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：
//   靜態（main.js 原始碼）：import（wanted.css / createWanted / createPolice / createPoliceAdapters / createWantedUI / places）、adapters deps、
//     每幀順序 adapters.update → police.update → wanted.update、updateGame 內位置（面板 / 暫停之後、stepWorld 之後）、HUD 欄位、除錯物件、
//     原 PLAYER_KO_SEC 原地起身移除；hud.js 搜索圈 / 警車點；missions failActive；places.js 座標；interfaces.md §26 與事件表；combat-integration want 表含 police
//   行為（node 可執行、不 import three / rapier）：把 main.js「對抗 / KO」到「車輛耐久」之間的原始碼整段取出，注入假世界執行——
//     犯行事件 → 星數（路人報案 / 警力目擊 / 無人不報 / 警員開槍過濾）、bust → 扣款（不足扣到 0）/ 任務失敗 / 傳送警察局 / hp 回滿 / 清星 / player:busted、
//     hp 歸零 → player:ko（economy 扣醫藥費一次）→ 2 s 後 wasted → 任務失敗 / 傳送醫院 / 清星 / player:wasted、暫停（skip）時 police / wanted 不推進
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBus } from '../../src/core/events.js';
import { createWanted, CRIMES } from '../../src/wanted/wanted.js';
import { createPolice } from '../../src/wanted/police.js';
import { createWantedUI } from '../../src/wanted/ui.js';
import { respawnPlace, POLICE_STATION, HOSPITAL } from '../../src/wanted/places.js';
import { createEconomy, HOSPITAL_FEE } from '../../src/economy.js';
import { pedKnockdownPayload } from '../../src/combat.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(`${ROOT}${p}`, 'utf8');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ---------- 靜態接線 ----------
const mainSrc = read('src/main.js');
const missing = (code, list) => list.filter((s) => !(s instanceof RegExp ? s.test(code) : code.includes(s)));
const GROUPS = [
  ['import：wanted.css / wanted / police / adapters / ui / places', [
    "import './wanted/wanted.css';", "import { createWanted, CRIMES } from './wanted/wanted.js';", "import { createPolice } from './wanted/police.js';",
    "import { createPoliceAdapters } from './wanted/adapters.js';", "import { createWantedUI } from './wanted/ui.js';", "import { respawnPlace } from './wanted/places.js';"]],
  ['adapters deps（檔頭列的最小集合）', [
    'createPoliceAdapters({', 'findRoute: (a, b) => findRoute(graph, a, b)', 'characters: { createCharacter, disposeCharacter, CharacterAnimator, clips:',
    'blocked: (x, z) => !!buildingAt(x, z) || inWater(x, z)', 'surfaceOffset: SURFACE_OFFSET', 'isNight: () =>', 'getPlayer: () =>']],
  ['建立 police / wantedUI', ['createPolice({ bus, wanted, adapters: policeAdapters })', 'createWantedUI({ root: document.body, canvas: renderer.domElement, hints: hud })']],
  ['HUD：星星列、首次通緝提示、小地圖欄位', [
    "bus.on('wanted:change'", "bus.on('wanted:state'", 'wantedUI.setStars(wanted.stars, { flashing: wanted.flashing })',
    "wantedUI.showHint('wanted', WANTED_HINT_TEXT)", '離開警察視線並躲出小地圖的搜索圈就能擺脫', 'searchCircle: wanted.searchCircle', 'policeCars: collectPoliceDots()']],
  ['被捕 / 送醫', [
    "bus.on('police:bust'", "wantedUI.showBusted({ fine })", 'wantedUI.showWasted({ fee: koFee })', "economy.spend(fine, 'busted')",
    'missions.failActive(kind)', 'wanted.clear(kind)', "bus.emit('player:busted'", "bus.emit('player:wasted'", 'const BUSTED_FINE = 150;', 'const WASTED_DELAY_SEC = 2;']],
  ['除錯物件：window.__game 加 wanted / police', ['wanted, police, policeAdapters, wantedUI,']],
  ['警笛：暫停時靜音', ['if (st.paused) policeAdapters.update(0, adapterIdle);']],
];
for (const [name, list] of GROUPS) {
  const miss = missing(mainSrc, list);
  check(`main.js 接線：${name}`, !miss.length, miss.map(String).join(' | '));
}
{
  const fn = mainSrc.slice(mainSrc.indexOf('const updateWanted'), mainSrc.indexOf('// 小地圖警車點'));
  const ia = fn.indexOf('policeAdapters.update(dt, adapterCtx)');
  const ip = fn.indexOf('police.update(dt, policeCtx)');
  const iw = fn.indexOf('wanted.update(dt, wantedCtx)');
  check('每幀順序：policeAdapters.update → police.update → wanted.update(seen)', ia > 0 && ip > ia && iw > ip && fn.includes('wantedCtx.seen = seen'));
  const ug = mainSrc.slice(mainSrc.indexOf('const updateGame = (dt) =>'), mainSrc.indexOf('// 開始畫面 / 回到主選單'));
  const iPanel = ug.indexOf('if (syncPanels()) return;');
  const iStep = ug.indexOf('stepWorld(dt,');
  const iW = ug.indexOf('updateWanted(dt, phoneOpen);');
  check('updateGame：面板開啟 return 之後、stepWorld 之後呼叫 updateWanted（手機開著 skip）', iPanel > 0 && iStep > iPanel && iW > iStep);
  check('原 PLAYER_KO_SEC 原地起身移除、整合層不再呼叫 missions.onPlayerKo、player:ko 照發',
    !mainSrc.includes('PLAYER_KO_SEC') && !mainSrc.includes('player.recoverAfterKnockout(terrain);\n    combat.revive') && !/missions\.onPlayerKo\(\)/.test(mainSrc) && mainSrc.includes("bus.emit('player:ko', {});"));
  // resumeGame 寫成 if (!state.respawn) input.enabled = true;（integration-p3 以字面 input.enabled = true 驗「繼續」接線），語意同 input.enabled = !state.respawn
  const resumeSrc = (mainSrc.match(/const resumeGame = \(\) => \{([\s\S]*?)\n {2}\};/) || [])[1] || '';
  const respawnGuard = /input\.enabled = !state\.respawn|if \(!state\.respawn\) input\.enabled = true;/g;
  check('暫停 / 面板 / 手機時輸入不提早解鎖（resume / syncPanels / phone canResume 看 state.respawn）',
    (mainSrc.match(respawnGuard) || []).length === 2 && new RegExp(respawnGuard.source).test(resumeSrc)
    && mainSrc.includes('&& !state.respawn,') && mainSrc.includes('canOpen: () => !state.respawn && canOpenPhone('));
}
{
  const hudSrc = read('src/hud.js');
  check('hud.js：drawSearchCircle 搜索圈 + 警車紅藍點', ["import { drawSearchCircle } from './wanted/ui.js';", 'drawSearchCircle(ctx, {', '_drawPoliceCars(ctx, state.policeCars', 'POLICE_DOT_COLORS'].every((s) => hudSrc.includes(s)));
  const ms = read('src/missions/index.js');
  check('missions：failActive 匯出、FAIL_TEXT 含 busted / wasted', ms.includes('function failActive(reason)') && ms.includes('    failActive,') && /busted: '/.test(ms) && /wasted: '/.test(ms));
  // failActive 真的讓進行中的委託失敗：有 run 時走 fail(reason)（endRun → emit mission:fail { reason }），否則依序交給打工 / 外送 / 垃圾車
  const fa = (ms.match(/function failActive\(reason\) \{([\s\S]*?)\n {2}\}/) || [])[1] || '';
  const fl = (ms.match(/function fail\(reason\) \{([\s\S]*?)\n {2}\}/) || [])[1] || '';
  check('missions：failActive 進行中委託 → fail(reason) → endRun、emit mission:fail { reason }；打工 / 外送 / 垃圾車各自 fail(reason)',
    /if \(run\) fail\(reason\);/.test(fa) && ['jobs.fail(reason)', 'timed.fail(reason)', 'truck.fail(reason)', 'return true;'].every((s) => fa.includes(s))
    && /endRun\(\);[\s\S]*emit\('mission:fail', \{ id: m\.slug, reason \}\)/.test(fl));
  check('missions 子模組匯出 fail(reason)', ['src/missions/events.js', 'src/missions/garbage-truck.js', 'src/missions/jobs.js'].every((p) => read(p).includes('fail: (reason) => fail(reason)')));
  const doc = read('docs/dev/interfaces.md');
  const evs = ['wanted:change', 'wanted:state', 'wanted:spotted', 'wanted:cleared', 'police:bust', 'police:shoot', 'player:busted', 'player:wasted'];
  const table = doc.slice(0, doc.indexOf('## 2. 設定'));
  check('interfaces.md：§26 Phase 7、事件表 8 個事件、mission:fail 含 busted / wasted',
    doc.includes('## 26. Phase 7') && evs.every((e) => table.includes(`| \`${e}\``)) && /`mission:fail` \| `\{ id, reason: [^`]*'busted'\\\|'wasted' \}`/.test(doc), evs.filter((e) => !table.includes(`| \`${e}\``)).join(','));
  const ci = read('tools/test/combat-integration.mjs');
  check('combat-integration：vehicle-model want 表含 police（manifest 7 種車）', ci.includes('garbage_truck: 4, police: 4 }'));
  const osm = JSON.parse(read('src/data/osm-city.json'));
  const stn = osm.B.find((b) => b.i === 260107782);
  const d = stn ? Math.min(...Array.from({ length: stn.p.length / 2 }, (_, i) => Math.hypot(stn.p[2 * i] - POLICE_STATION.x, stn.p[2 * i + 1] - POLICE_STATION.z))) : Infinity;
  check('places.js：警察局 = 第六分局（id 260107782）門口 15 m 內；醫院標推測位置', stn && stn.n.includes('第六分局') && d < 15 && HOSPITAL.inferred === true && respawnPlace('busted') === POLICE_STATION && respawnPlace('wasted') === HOSPITAL, `d ${d.toFixed(1)}`);
}

// ---------- 行為：main.js 通緝段原始碼 + 假世界 ----------
const SLICE_START = '  // ---------- 對抗 / KO ----------';
const SLICE_END = '  // ---------- 車輛耐久：';
const slice = mainSrc.slice(mainSrc.indexOf(SLICE_START), mainSrc.indexOf(SLICE_END));
const CONST_NAMES = ['WASTED_DELAY_SEC', 'BUSTED_FINE', 'WASTED_FEE', 'CRIME_GUNFIRE_RANGE', 'CRIME_REPORT_RANGE', 'POLICE_RAM_MIN_SPEED', 'POLICE_RAM_COOLDOWN', 'WANTED_HINT_TEXT'];
const consts = CONST_NAMES.map((n) => (mainSrc.match(new RegExp(`^const ${n} = .*$`, 'm')) || [''])[0]).join('\n');
check('取出 main.js 通緝段與常數', slice.length > 1000 && consts.split('\n').every(Boolean));

const vec = (x = 0, z = 0) => ({ x, y: 0, z, copy(p) { this.x = p.x; this.z = p.z; return this; } });

// 假 adapters：警車一律生成在 findSpawnPoint 要求的玩家附近 10 m（可目擊）；spawnEnabled false 時不生成
function fakeAdapters(env) {
  const calls = { update: [], drive: 0 };
  const policeVeh = new Set();
  return {
    calls,
    policeVeh,
    findSpawnPoint: (x, z) => (env.spawnEnabled ? { x: x + 10, z, heading: 0 } : null),
    spawnCar: ({ x, z }) => {
      const v = { pos: { x, z }, speed: 0 };
      policeVeh.add(v);
      return { police: true, v, pos: v.pos, speed: 0, alive: true };
    },
    despawnCar: () => {},
    driveCar: () => {
      calls.drive++;
    },
    spawnOfficer: () => null,
    despawnOfficer: () => {},
    moveOfficer: () => {},
    officerAim: () => {},
    canSee: () => true,
    update: (dt, ctx) => calls.update.push({ dt, paused: !!(ctx && ctx.paused) }),
    isPoliceVehicle: (v) => policeVeh.has(v),
  };
}

function makeWorld({ money = 500, spawnPolice = false, ui = null } = {}) {
  const bus = createBus();
  const env = { spawnEnabled: spawnPolice };
  const log = [];
  for (const n of ['wanted:change', 'wanted:state', 'wanted:cleared', 'player:busted', 'player:wasted', 'player:ko', 'player:money']) bus.on(n, (e) => log.push([n, e]));
  const combatL = { knockdown: [] };
  const playerActor = { id: 'player', kind: 'player', hp: 100, maxHp: 100, untargetable: false, down: false };
  const player = {
    pos: vec(0, 0),
    actor: playerActor,
    locked: false,
    yaw: 0,
    mesh: { visible: true },
    placeAt(x, z, yaw) {
      this.pos.x = x;
      this.pos.z = z;
      this.yaw = yaw;
    },
    recoverAfterKnockout: () => null,
  };
  const deps = {
    combat: {
      on: (n, fn) => (combatL[n] || (combatL[n] = [])).push(fn),
      isDown: (a) => !!a.down,
      revive: (a) => {
        a.hp = a.maxHp;
        a.down = false;
      },
    },
    pedKnockdownPayload,
    bus,
    player,
    state: { started: true, paused: false, mode: 'walk', vehicle: null, koTimer: 0, respawn: null, pendingFall: null },
    pw: { simTimeFor: (dt) => dt },
    createWanted,
    CRIMES,
    createPolice,
    createPoliceAdapters: () => fakeAdapters(env),
    createWantedUI: ui ? () => ui : createWantedUI,
    respawnPlace,
    HOSPITAL_FEE,
    vehicles: null, dmg: null, traffic: { citizens: [] }, findRoute: () => null, graph: null,
    getCharacterManifest: () => null, createCharacter: null, disposeCharacter: null, CharacterAnimator: null,
    physics: null, scene: null, heightAt: () => 0, buildingAt: () => null, inWater: () => false, audio: null,
    settings: { get: () => true }, dayNight: { night: 0 }, SURFACE_OFFSET: 0,
    hud: { setPrompt() {}, setInteractPrompt() {}, root: null },
    document: { body: null },
    renderer: { domElement: { style: {} } },
    gameTime: 0,
    camera: { position: vec() },
    input: { enabled: true },
    driveControls: () => ({}),
    economy: createEconomy({ bus, initial: { money } }),
    missions: { failed: [], failActive(r) { this.failed.push(r); return true; } },
    cj: { active: false, cancelled: 0, cancel() { this.cancelled++; this.active = false; } },
    cancelEnter() { deps.state.mode = 'walk'; deps.state.vehicle = null; deps.player.locked = false; },
    exitVehicle: () => true,
    terrain: {},
    rig: { yaw: 0 },
    lastPos: vec(),
    focus: vec(),
    panelOpen: () => false,
    phone: { isOpen: () => false },
  };
  const names = Object.keys(deps);
  const body = `${consts}\n${slice}\nreturn { updateKnockout, updateWanted, beginRespawn, cancelRespawn, reportCrime, onPlayerRam, collectPoliceDots, wanted, police, policeAdapters, wantedUI };`;
  const api = new Function(...names, body)(...names.map((n) => deps[n]));
  return { ...api, deps, bus, log, env, combatL, player };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const stars = (w) => w.wanted.stars;

// 1. 犯行 → 星數：無警力時 35 m 內有行人 → 路人報案（witnessed=false，至少 1 星）；沒有人 → 不報
{
  const w = makeWorld();
  const ped = { id: 'p1', kind: 'pedestrian', faction: 'civilian', pos: { x: 3, z: 0 } };
  w.bus.emit('combat:hit', { attacker: w.player.actor, target: ped, byPlayer: true, weapon: 'fist', x: 3, z: 0 });
  check('assault：無警力、35 m 內無行人 → 不報（0 星）', stars(w) === 0 && w.wanted.heat === 0);
  w.deps.traffic.citizens.push({ x: 20, z: 0 });
  w.bus.emit('combat:hit', { attacker: w.player.actor, target: ped, byPlayer: true, weapon: 'fist', x: 3, z: 0 });
  const ch = w.log.find(([n]) => n === 'wanted:change');
  check('assault：35 m 內有行人 → witnessed=false（heat × 0.5）、1 星、wanted:change reason assault', stars(w) === 1 && Math.abs(w.wanted.heat - 0.3) < 1e-9 && ch && ch[1].reason === 'assault' && ch[1].prev === 0, `heat ${w.wanted.heat}`);
  w.bus.emit('combat:hit', { attacker: ped, target: w.player.actor, byPlayer: false, weapon: 'fist', x: 0, z: 0 });
  check('非玩家所為的 combat:hit 不報', Math.abs(w.wanted.heat - 0.3) < 1e-9);
  check('wanted:state → active', w.wanted.state === 'active' && w.log.some(([n, e]) => n === 'wanted:state' && e.state === 'active'));
}

// 2. 警力目擊 → 全額；警員目標 → assaultPolice / killPolice；開槍過濾；車撞；搶警車；撞警車
{
  const w = makeWorld({ spawnPolice: true });
  w.updateWanted(0.016, false); // 0 星：補 1 台巡邏車（假 adapters 生成在玩家旁 10 m）
  check('police.update 補車、witness(玩家位置) = true', w.police.cars.length === 1 && w.police.witness(0, 0) === true);
  check('小地圖警車點 = police.cars 的 pos', w.collectPoliceDots().length === 1 && w.collectPoliceDots()[0] === w.police.cars[0].pos);
  const officer = { id: 'o1', kind: 'pedestrian', faction: 'police', officer: {}, pos: { x: 2, z: 0 } };
  w.bus.emit('combat:hit', { attacker: w.player.actor, target: officer, byPlayer: true, weapon: 'fist', x: 2, z: 0 });
  check('打警員（警力目擊）→ assaultPolice 全額 heat 2.0', Math.abs(w.wanted.heat - 2.0) < 1e-9 && stars(w) === 1, `heat ${w.wanted.heat}`);
  w.bus.emit('ped:dead', { ped: officer, cause: 'bullet', byPlayer: true, x: 2, z: 0 });
  check('擊斃警員 → killPolice（heat +3 → 2 星）', Math.abs(w.wanted.heat - 5.0) < 1e-9 && stars(w) === 2, `heat ${w.wanted.heat}`);
  const h0 = w.wanted.heat;
  w.bus.emit('weapon:fire', { weapon: 'pistol', x: 0, z: 0, byPlayer: false, police: true });
  check('警員開槍（police true / byPlayer false）不算 gunfire', w.wanted.heat === h0);
  w.bus.emit('weapon:fire', { weapon: 'pistol', x: 0, z: 0, byPlayer: true });
  check('玩家開槍、40 m 內無行人 / 警員 → 不算', w.wanted.heat === h0);
  w.deps.traffic.citizens.push({ x: 39, z: 0 });
  w.bus.emit('weapon:fire', { weapon: 'pistol', x: 0, z: 0, byPlayer: true });
  check('玩家開槍、40 m 內有行人 → gunfire +0.4', Math.abs(w.wanted.heat - (h0 + 0.4)) < 1e-9);
  const h1 = w.wanted.heat;
  w.bus.emit('ped:knockdown', { ped: {}, cause: 'vehicle', byPlayer: true, x: 1, z: 0 });
  w.bus.emit('ped:knockdown', { ped: {}, cause: 'punch', byPlayer: true, x: 1, z: 0 });
  check('ped:knockdown cause vehicle byPlayer → vehicleHit（punch 倒地不另報）', Math.abs(w.wanted.heat - (h1 + 0.5)) < 1e-9);
  w.bus.emit('ped:dead', { ped: { faction: 'civilian' }, cause: 'vehicle', byPlayer: true, x: 1, z: 0 });
  check('車撞致死 → vehicleKill +1.5', Math.abs(w.wanted.heat - (h1 + 2.0)) < 1e-9);
  const pv = w.police.cars[0].v;
  const h2 = w.wanted.heat;
  w.bus.emit('vehicle:carjacked', { vehicle: pv });
  check('搶警車：carjack + policeVehicle', Math.abs(w.wanted.heat - (h2 + 1.0 + 0.8)) < 1e-9);
  w.bus.emit('vehicle:enter', { vehicle: pv, carjack: false });
  check('同一台警車不重複報 policeVehicle', Math.abs(w.wanted.heat - (h2 + 1.8)) < 1e-9);
  const w2 = makeWorld({ spawnPolice: true });
  w2.updateWanted(0.016, false);
  const cop = w2.police.cars[0].v;
  const mine = { pos: { x: 0, z: 0 }, speed: 12 };
  w2.onPlayerRam(mine, cop, 8);
  w2.onPlayerRam(mine, cop, 8);
  check('玩家車撞警車 → policeVehicle（冷卻內只算一次）', Math.abs(w2.wanted.heat - 0.8) < 1e-9, `heat ${w2.wanted.heat}`);
  const w3 = makeWorld({ spawnPolice: true });
  w3.updateWanted(0.016, false);
  const cop3 = w3.police.cars[0].v;
  cop3.speed = 20;
  w3.onPlayerRam({ pos: { x: 0, z: 0 }, speed: 2 }, cop3, 18);
  w3.onPlayerRam({ pos: { x: 0, z: 0 }, speed: 12 }, { pos: {}, speed: 0 }, 18);
  check('警車撞玩家（警車較快）/ 撞一般車 → 不算', w3.wanted.heat === 0);
}

// 3. 被捕：扣 150 / 任務失敗 / 鎖輸入 → 畫面結束：傳送警察局、hp 回滿、清星、player:busted、解鎖
{
  const w = makeWorld({ money: 500 });
  w.wanted.setStars(2);
  w.player.pos.x = 300;
  w.player.pos.z = 200;
  w.player.actor.hp = 40;
  w.bus.emit('police:bust', { x: 300, z: 200, officer: {} });
  check('bust：state.respawn busted、輸入鎖定、玩家不受攻擊', w.deps.state.respawn === 'busted' && w.deps.input.enabled === false && w.player.locked && w.player.actor.untargetable);
  check('bust：扣 150（reason busted）、進行中任務以 busted 失敗', w.deps.economy.money === 350 && w.log.some(([n, e]) => n === 'player:money' && e.delta === -150 && e.reason === 'busted') && w.deps.missions.failed.join() === 'busted');
  w.bus.emit('police:bust', { x: 300, z: 200, officer: {} });
  check('bust 進行中再收到 police:bust 不重複扣款', w.deps.economy.money === 350);
  await flush();
  const ev = w.log.find(([n]) => n === 'player:busted');
  check('bust 結束：傳送到警察局門口、hp 回滿', w.player.pos.x === POLICE_STATION.x && w.player.pos.z === POLICE_STATION.z && w.player.actor.hp === 100 && w.deps.focus.x === POLICE_STATION.x);
  check('bust 結束：wanted.clear(busted)、player:busted { fine 150, x, z = 被捕地點 }、解鎖',
    stars(w) === 0 && w.wanted.state === 'clear' && w.log.some(([n, e]) => n === 'wanted:cleared' && e.reason === 'busted') &&
    ev && ev[1].fine === 150 && ev[1].x === 300 && ev[1].z === 200 && w.deps.state.respawn === null && w.deps.input.enabled && !w.player.locked && !w.player.actor.untargetable);
  const poor = makeWorld({ money: 100 });
  poor.wanted.setStars(1);
  poor.bus.emit('police:bust', { x: 0, z: 0 });
  await flush();
  check('bust：餘額不足扣到 0', poor.deps.economy.money === 0);
}

// 4. 送醫：hp 歸零 → player:ko（economy 扣 100 一次）→ 倒地 2 s → wasted → 任務失敗 / 傳送醫院 / 清星 / player:wasted
{
  const w = makeWorld({ money: 500 });
  w.wanted.setStars(3);
  w.player.pos.x = -50;
  w.player.pos.z = 40;
  w.player.actor.hp = 0;
  w.player.actor.down = true;
  for (const fn of w.combatL.knockdown) fn({ target: w.player.actor, cause: 'bullet' });
  check('hp 歸零：player:ko 照發、economy 扣醫藥費 100、倒數 2 s', w.log.some(([n]) => n === 'player:ko') && w.deps.economy.money === 400 && w.deps.state.koTimer === 2);
  w.updateKnockout(1);
  check('倒地 1 s：尚未進 wasted', w.deps.state.respawn === null && w.deps.missions.failed.length === 0);
  w.updateKnockout(1.05);
  check('倒地 2 s：進 wasted、任務以 wasted 失敗、輸入鎖定', w.deps.state.respawn === 'wasted' && w.deps.missions.failed.join() === 'wasted' && !w.deps.input.enabled);
  await flush();
  const ev = w.log.find(([n]) => n === 'player:wasted');
  check('wasted 結束：傳送醫院、hp 回滿、起身（revive）', w.player.pos.x === HOSPITAL.x && w.player.pos.z === HOSPITAL.z && w.player.actor.hp === 100 && !w.player.actor.down);
  check('wasted 結束：清星 wasted、player:wasted { fee 100, x, z }、不重複扣款',
    stars(w) === 0 && w.log.some(([n, e]) => n === 'wanted:cleared' && e.reason === 'wasted') && ev && ev[1].fee === HOSPITAL_FEE && ev[1].x === -50 && ev[1].z === 40 &&
    w.deps.economy.money === 400 && w.log.filter(([n, e]) => n === 'player:money' && e.delta < 0).length === 1);
}

// 5. 暫停 / 手機（skip）：police / wanted 不推進，adapters 只以 dt 0 paused 靜音
{
  const w = makeWorld();
  w.wanted.setStars(1);
  const before = w.police.cars.length;
  for (let i = 0; i < 200; i++) w.updateWanted(0.1, true);
  const ad = w.policeAdapters.calls.update;
  check('skip 20 s：wanted 仍 active（evade 計時不走）', w.wanted.state === 'active' && stars(w) === 1);
  check('skip：adapters.update 一律 dt 0 + paused、police 未下指令', ad.length === 200 && ad.every((c) => c.dt === 0 && c.paused) && w.policeAdapters.calls.drive === 0 && w.police.cars.length === before);
  for (let i = 0; i < 40; i++) w.updateWanted(0.1, false);
  check('恢復更新：無警力看見 → 進 searching（搜索圈出現）', w.wanted.state === 'searching' && !!w.wanted.searchCircle && w.policeAdapters.calls.update.at(-1).dt === 0.1);
  w.cancelRespawn();
  check('cancelRespawn（新局 / 回主選單）清星', stars(w) === 0 && w.wanted.state === 'clear');
}

// 6. 審查 🟡 修正
{
  // main.js:1239 peopleNear：citizens 掛骨架後即時位置在 c.ped（c.x / c.z 停在替身最後位置）
  const w = makeWorld();
  w.deps.traffic.citizens.push({ x: 999, z: 0, ped: { x: 20, z: 0 } });
  w.bus.emit('combat:hit', { attacker: w.player.actor, target: { id: 'p', faction: 'civilian' }, byPlayer: true, weapon: 'fist', x: 3, z: 0 });
  check('peopleNear：掛骨架的市民以 c.ped.x / z 判距離 → 路人報案', stars(w) === 1);
  // 罰鍰 / 醫藥費：顯示與 payload 皆為實扣值
  const poor = makeWorld({ money: 40 });
  poor.wanted.setStars(1);
  poor.bus.emit('police:bust', { x: 0, z: 0 });
  await flush();
  const pb = poor.log.find(([n]) => n === 'player:busted');
  check('餘額 40 被捕：實扣 40、player:busted.fine = 40', poor.deps.economy.money === 0 && pb && pb[1].fine === 40, pb && JSON.stringify(pb[1]));
  const sick = makeWorld({ money: 30 });
  sick.player.actor.hp = 0;
  sick.player.actor.down = true;
  for (const fn of sick.combatL.knockdown) fn({ target: sick.player.actor, cause: 'bullet' });
  sick.updateKnockout(2.1);
  await flush();
  const pw2 = sick.log.find(([n]) => n === 'player:wasted');
  check('餘額 30 送醫：player:wasted.fee = 實扣 30', sick.deps.economy.money === 0 && pw2 && pw2[1].fee === 30, pw2 && JSON.stringify(pw2[1]));
  // overlay resolve reason：preempted / disposed 不重生；done / skipped 才重生
  for (const reason of ['preempted', 'disposed', 'skipped']) {
    const fake = { setStars() {}, showHint: () => false, showBusted: () => Promise.resolve({ reason }), showWasted: () => Promise.resolve({ reason }) };
    const r = makeWorld({ ui: fake });
    r.wanted.setStars(1);
    r.player.pos.x = 300;
    r.bus.emit('police:bust', { x: 300, z: 0 });
    await flush();
    const moved = r.player.pos.x === POLICE_STATION.x && r.log.some(([n]) => n === 'player:busted');
    check(`overlay reason ${reason} → ${reason === 'skipped' ? '重生' : '不傳送、不發 player:busted'}`, reason === 'skipped' ? moved : !moved && r.player.pos.x === 300);
  }
  // beginRespawn 取消進行中的搶車 / 上車動畫
  const e1 = makeWorld();
  e1.deps.cj.active = true;
  e1.deps.state.mode = 'carjack';
  e1.wanted.setStars(1);
  e1.bus.emit('police:bust', { x: 0, z: 0 });
  check('被捕時取消進行中搶車（cj.cancel、回步行、仍鎖定）', e1.deps.cj.cancelled === 1 && e1.deps.state.mode === 'walk' && e1.player.locked);
  const e2 = makeWorld();
  e2.deps.state.mode = 'entering';
  e2.deps.state.vehicle = {};
  e2.wanted.setStars(1);
  e2.bus.emit('police:bust', { x: 0, z: 0 });
  check('被捕時取消上車動畫（回步行、vehicle null、仍鎖定）', e2.deps.state.mode === 'walk' && e2.deps.state.vehicle === null && e2.player.locked);
  check('carjack isPlayerDisabled 含 state.respawn', mainSrc.includes('isPlayerDisabled: () => state.koTimer > 0 || !!state.respawn || combat.isDown(player.actor)'));
}

const total = passed + failed;
console.log(failed ? `FAIL ${failed}/${total}` : `PASS ${passed}/${total}`);
process.exit(failed ? 1 : 0);
