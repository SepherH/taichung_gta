#!/usr/bin/env node
// Phase 11 整合驗證：警車任務接線（main.js 原始碼字串比對 + 抽出警車任務段以替身執行；不 import three / rapier）
// 用法：node tools/test/integration-p11.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：import / 常數、建立 vigilante / fugitiveWorld / vigBar、collectMarkers 併入紅點、updateVigilante 緊接 updateRobberies、
//   駕駛中互動鍵優先給 vigilanteInteractable、任務中 nearestInteractable 不列委託、犯行守門（isFugitiveActor / shotAtFugitive）、
//   beginRespawn → vigilante.end(kind)、quitToMenu / startGame → cancelVigilante（在 cancelRobbery 之前）、window.__game；
//   行為（抽段 + 替身）：警車才有互動、其他任務中不可開始、開始 → 生成逃犯車、凍結條件、任務條文字、離開警車 10 s 結束、cancel 回收；
//   hud.js / marker-colors / big-map / style.css .vig- / interfaces.md §29 與事件表
// 注意：staging 無 node_modules；main.js / hud.js / big-map.js 依賴 three / css / JSON import，一律原始碼字串比對
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBus } from '../../src/core/events.js';
import { createWanted } from '../../src/wanted/wanted.js';
import { createVigilante, createFugitiveWorld, createVigilanteBar, PROMPT_TEXT, LEFT_SEC } from '../../src/missions/vigilante.js';
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
  ['import：missions/vigilante.js', ["import { createVigilante, createFugitiveWorld, createVigilanteBar, PROMPT_TEXT as VIG_PROMPT } from './missions/vigilante.js';"]],
  ['常數集中檔頭', [/^const VIG_URGENT_SEC = \d+;/m, /^const VIG_PRIORITY = \d+;/m]],
  ['建立 vigilante / fugitiveWorld / vigBar', [
    'createVigilante({ bus, wanted, rng: Math.random })',
    'vehicles, dmg, traffic, findRoute: (a, b) => findRoute(graph, a, b), rng: Math.random, attacker: () => player.actor,',
    'isKept: (v) => v === state.vehicle || v === cj.vehicle,',
    'onKeep: (v) => adopted.add(v),',
    'createVigilanteBar({ root: document.body })',
  ]],
  ['警車判定 / 其他任務互斥', [
    "const isPoliceCar = (v) => !!v && (v.type === 'police' || policeAdapters.isPoliceVehicle(v));",
    'missions.active() || missions.eventActive() || missions.jobActive() || robberies.active || state.spraying',
  ]],
  ['反向互斥：警車任務中不可開始搶劫 / 噴漆 / 委託・外送・垃圾車・打工', [
    'combat.isDown(player.actor) || vigilante.active)',
    "if (state.mode === 'drive' && state.vehicle && !state.respawn && !vigHooks.active()) {",
    'extraBusy: () => vigHooks.active(),',
    'vigHooks.active = () => vigilante.active;',
  ]],
  ['小地圖 / 大地圖紅點併入 collectMarkers（逃犯車不再畫藍色車輛點）', ['pushAll(out, fugitiveMarkers());', 'return vigilante.markers(vigMarkers);', 'if (!c.driven && !c.fugitive) out.push(c.pos);']],
  ['每幀：updateVigilante 緊接 updateRobberies', [/updateRobberies\(dt, phoneOpen\);\s*\n\s*updateVigilante\(dt, phoneOpen\);/]],
  ['凍結條件：手機 / BUSTED・WASTED / 噴漆 / 搶劫中（逃犯車煞停）', [/if \(skip \|\| !!state\.respawn \|\| !!state\.spraying \|\| !!robberies\.active\) \{\s*\n\s*fugitiveWorld\.brakeAll\(\);\s*\n\s*return;/]],
  ['ctx：earn = economy.add(vigilante)、提示走 wantedUI.showHint、警車毀損 = dmg.healthOf 0', [
    "earn: (n) => economy.add(n, 'vigilante')",
    "showHint: (id, text) => !!settings.get('showHints') && wantedUI.showHint(id, text)",
    'vigCtx.policeWrecked = vigCtx.inPolice && dmg.healthOf(v) === 0;',
    'fugitiveWorld.update(dt);',
  ]],
  ['互動鍵：駕駛中 vigilanteInteractable 優先', ['inter = vigilanteInteractable(v) || nearestInteractable(v.pos, false);']],
  ['互斥：任務中 nearestInteractable 不列委託', ['interCands[0] = vigilante.active ? null : missions.nearest(pos);']],
  ['掛鉤 vigHooks（通緝段宣告預設無作用、警車任務段覆寫）', [
    'const vigHooks = { fugitiveActor: () => false, fugitiveShot: () => false, end: () => {}, active: () => false };',
    'vigHooks.fugitiveActor = (a) => vigilante.isFugitiveActor(a);',
    'vigHooks.fugitiveShot = (x, z) => vigilante.shotAtFugitive(x, z);',
    /vigHooks\.end = \(kind\) => \{\s*\n\s*vigilante\.end\(kind\);\s*\n\s*vigBar\.set\(null\);/,
  ]],
  ['犯行守門（攻擊下車逃犯 / 射擊逃犯車不算）', [
    'if (vigHooks.fugitiveActor(e.target)) return;',
    'if (!e || !e.byPlayer || vigHooks.fugitiveActor(e.ped)) return;',
    "e.cause === 'vehicle' && !vigHooks.fugitiveActor(e.ped)",
    'if (vigHooks.fugitiveShot(e.ex, e.ez, e.vehicle)) return;',
  ]],
  ['BUSTED / WASTED：beginRespawn → vigHooks.end(kind)', [/missions\.failActive\(kind\);\s*\n\s*vigHooks\.end\(kind\);/]],
  ['除錯物件：window.__game.vigilante', ['vigilante, fugitiveWorld, vigBar,']],
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
    const iR = body.search(/cancelRobbery\((!continued)?\);/);
    const iRe = body.indexOf('cancelRespawn();');
    check(`${name}：cancelVigilante() 在 cancelRobbery / cancelRespawn 之前`, iV >= 0 && iR > iV && iRe > iR, `vig@${iV} rob@${iR} respawn@${iRe}`);
  }
  const ug = mainSrc.slice(mainSrc.indexOf('const updateGame = (dt) =>'), mainSrc.indexOf('// 開始畫面 / 回到主選單'));
  const iStep = ug.indexOf('stepWorld(dt,');
  const iVig = ug.indexOf('updateVigilante(dt, phoneOpen);');
  const iPanel = ug.indexOf('if (syncPanels()) return;');
  check('updateGame：updateVigilante 在 syncPanels 早退與 stepWorld 之後', iPanel >= 0 && iStep > iPanel && iVig > iStep, `panel@${iPanel} step@${iStep} vig@${iVig}`);
  // 宣告順序：vigHooks 在通緝段（先於犯行監聽 / beginRespawn）；vigilante 在 policeAdapters / dmg 之後、超商段之前
  const iHooks = mainSrc.indexOf('const vigHooks = ');
  const iDecl = mainSrc.indexOf('const vigilante = createVigilante(');
  check('宣告順序：vigHooks < 犯行回報 / beginRespawn；policeAdapters < vigilante < 超商段', iHooks > 0 && iHooks < mainSrc.indexOf('const reportCrime = ') && iHooks < mainSrc.indexOf('const beginRespawn = ') && mainSrc.indexOf('const policeAdapters = createPoliceAdapters(') < iDecl && iDecl < mainSrc.indexOf('const robberies = createRobberies('));
  // integration-p7 抽「對抗 / KO」到「車輛耐久」段執行：該段只能引用段內宣告的 vigHooks，不得直接引用 vigilante
  const p7 = mainSrc.slice(mainSrc.indexOf('  // ---------- 對抗 / KO ----------'), mainSrc.indexOf('  // ---------- 車輛耐久：'));
  check('integration-p7 抽段不含 vigilante 直接引用（只經 vigHooks）', p7.includes('const vigHooks = ') && !/\bvigilante\./.test(p7));
}

// ---------- 行為：抽出 main.js 警車任務段，以替身執行 ----------
const SLICE_START = '  // ---------- 警車任務（Phase 11';
const SLICE_END = '  // ---------- 超商搶劫（Phase 9';
const slice = mainSrc.slice(mainSrc.indexOf(SLICE_START), mainSrc.indexOf(SLICE_END));
const consts = ['VIG_URGENT_SEC', 'VIG_PRIORITY'].map((n) => (mainSrc.match(new RegExp(`^const ${n} = .*$`, 'm')) || [''])[0]).join('\n');
check('取出 main.js 警車任務段與常數', slice.length > 1500 && consts.split('\n').every(Boolean));

function fakeDoc() {
  const mkEl = (tag) => {
    const el = {
      tag,
      className: '',
      hidden: false,
      textContent: '',
      children: [],
      classList: {
        set: new Set(),
        contains(c) { return this.set.has(c); },
        toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); },
      },
      appendChild(c) { el.children.push(c); return c; },
      remove() { el.removed = true; },
    };
    return el;
  };
  const body = mkEl('body');
  const doc = { body, createElement: mkEl };
  body.ownerDocument = doc;
  return doc;
}

function makeWorld() {
  const bus = createBus();
  const log = [];
  for (const n of ['vigilante:start', 'vigilante:level', 'vigilante:end']) bus.on(n, (e) => log.push([n, e]));
  const wanted = createWanted({ bus });
  const doc = fakeDoc();
  const health = new Map();
  const vehicles = {
    vehicles: [],
    adopt(o) {
      const v = { ...o, pos: { x: o.x, z: o.z }, speed: 0, driven: false, spec: { length: 4.5, width: 1.85 }, ctl: null, setControls(c) { this.ctl = c; } };
      this.vehicles.push(v);
      return v;
    },
    remove(v) {
      const i = this.vehicles.indexOf(v);
      if (i >= 0) this.vehicles.splice(i, 1);
    },
  };
  const dmg = { attach: (v) => health.set(v, 1000), detach: (v) => health.delete(v), healthOf: (v) => (health.has(v) ? health.get(v) : null) };
  const traffic = {
    cars: [],
    spawnSpots: (cx, cz, a, b, out = []) => {
      out.length = 0;
      out.push({ x: cx + 220, z: cz, heading: 0 });
      return out;
    },
    spawnEjectedDriver: () => ({ actor: { id: 'fug' } }),
  };
  const policeCar = { type: 'police', pos: { x: 0, z: 0 }, yaw: 0 };
  const sedan = { type: 'sedan', pos: { x: 0, z: 0 }, yaw: 0 };
  const toasts = [];
  const money = { total: 0, reasons: [] };
  const deps = {
    bus,
    wanted,
    vigHooks: { fugitiveActor: () => false, fugitiveShot: () => false, end: () => {}, active: () => false },
    createVigilante,
    createFugitiveWorld,
    createVigilanteBar,
    VIG_PROMPT: PROMPT_TEXT,
    vehicles,
    dmg,
    traffic,
    findRoute: (g, a, b) => ({ points: [a, b] }),
    graph: {},
    player: { actor: { id: 'player' } },
    document: doc,
    policeAdapters: { isPoliceVehicle: () => false },
    missions: { active: () => null, eventActive: () => null, jobActive: () => null },
    robberies: { active: null },
    state: { mode: 'drive', vehicle: policeCar, respawn: null, spraying: null },
    cj: { vehicle: null },
    adopted: new Set(),
    playerPos: () => ({ x: 0, z: 0 }),
    economy: { add: (n, reason) => { money.total += n; money.reasons.push(reason); } },
    hud: { toast: (t) => toasts.push(t) },
    settings: { get: () => true },
    wantedUI: { showHint: () => true },
  };
  const names = Object.keys(deps);
  const body = `${consts}\n${slice}\nreturn { vigilante, fugitiveWorld, vigBar, vigilanteInteractable, updateVigilante, cancelVigilante, fugitiveMarkers, isPoliceCar, otherMissionBusy };`;
  const api = new Function(...names, body)(...names.map((n) => deps[n]));
  return { ...api, deps, log, wanted, doc, vehicles, health, toasts, money, policeCar, sedan };
}
const run = (w, sec, dt = 1 / 30, skip = false) => {
  for (let t = 0; t < sec - 1e-9; t += dt) w.updateVigilante(dt, skip);
};

{
  const w = makeWorld();
  check('isPoliceCar：police 車型 / policeAdapters 管理的車', w.isPoliceCar(w.policeCar) && !w.isPoliceCar(w.sedan) && !w.isPoliceCar(null));
  check('駕駛一般車：無警車任務互動', w.vigilanteInteractable(w.sedan) === null);
  const inter = w.vigilanteInteractable(w.policeCar);
  check(`駕駛警車：互動提示「${PROMPT_TEXT}」、priority 高於委託 3`, inter && inter.text === '按 E 開始警車任務' && inter.priority > 3);
  w.deps.missions.active = () => ({ id: 'm1' });
  check('委託進行中：不可開始（回 null，E 照常仲裁）', w.vigilanteInteractable(w.policeCar) === null);
  w.deps.missions.active = () => null;
  w.deps.robberies.active = 'store-1';
  check('搶劫中：不可開始', w.vigilanteInteractable(w.policeCar) === null);
  w.deps.robberies.active = null;
  w.wanted.setStars(2);
  inter.act();
  check('有星數也能開始：act() → vigilante:start', w.vigilante.active && w.log.some((e) => e[0] === 'vigilante:start'));
  check('進行中：不再提供互動', w.vigilanteInteractable(w.policeCar) === null);
  w.updateVigilante(1 / 30, false);
  const bar = w.doc.body.children.find((c) => c.className === 'vig-bar');
  check('第 1 關：生成 1 台逃犯車（adopt 一般車型 + dmg.attach）', w.vehicles.vehicles.length === 1 && w.vehicles.vehicles[0].fugitive && w.health.size === 1);
  check('任務條 .vig-bar 顯示「警車任務 第 1 關｜剩 1 台｜02:30」', bar && !bar.hidden && bar.children[0].textContent === '警車任務 第 1 關｜剩 1 台｜02:30', bar && bar.children[0].textContent);
  const car = w.vehicles.vehicles[0];
  check('vigHooks 已接上：子彈落點在逃犯車旁 → fugitiveShot 真、遠處假', w.deps.vigHooks.fugitiveShot(car.pos.x + 1, car.pos.z) && !w.deps.vigHooks.fugitiveShot(car.pos.x + 50, car.pos.z));
  const mk = w.fugitiveMarkers();
  check("標記：kind 'fugitive' 紅點", mk.length === 1 && mk[0].kind === 'fugitive' && w.fugitiveMarkers().length === 1);
  w.updateVigilante(1 / 30, false); // 逃犯車已拿到駕駛指令（全油門逃竄）
  const fleeing = !!(car.ctl && car.ctl.throttle > 0);
  const braked = () => !!(car.ctl && car.ctl.brake === 1 && car.ctl.throttle === 0);
  const t0 = w.vigilante.timeLeft;
  run(w, 2, 1 / 30, true);
  check('手機開著（skip）：不推進、逃犯車煞停（不沿用最後一次油門）', w.vigilante.timeLeft === t0 && fleeing && braked(), JSON.stringify(car.ctl));
  const frozenBrake = [];
  w.deps.state.respawn = 'busted';
  car.ctl = null;
  run(w, 2);
  frozenBrake.push(braked());
  w.deps.state.respawn = null;
  w.deps.state.spraying = 'spray-1';
  car.ctl = null;
  run(w, 2);
  frozenBrake.push(braked());
  w.deps.state.spraying = null;
  w.deps.robberies.active = 'store-1';
  car.ctl = null;
  run(w, 2);
  frozenBrake.push(braked());
  w.deps.robberies.active = null;
  check('BUSTED・WASTED / 噴漆 / 搶劫中：不推進、逃犯車煞停', w.vigilante.timeLeft === t0 && frozenBrake.every(Boolean), frozenBrake.join());
  run(w, 1);
  check('恢復後倒數', w.vigilante.timeLeft < t0);
  // 打到黑煙 → 制伏 → 賞金
  w.health.set(w.vehicles.vehicles[0], 200);
  w.updateVigilante(1 / 30, false);
  check("制伏 → economy.add(500, 'vigilante')、toast「逃犯制伏」", w.money.total === 500 && w.money.reasons.join() === 'vigilante' && w.toasts.includes('逃犯制伏'));
  // 離開警車 > 10 s → 結束、回收
  w.deps.state.mode = 'walk';
  w.deps.state.vehicle = null;
  run(w, LEFT_SEC + 0.2);
  check('離開警車 > 10 s → 結束 toast、逃犯車回收、任務條收起', !w.vigilante.active && w.toasts.includes('警車任務結束：完成 1 關、共得 NT$500') && w.vehicles.vehicles.length === 0 && bar.hidden && w.log.some((e) => e[0] === 'vigilante:end' && e[1].reason === 'left'));
}
{
  const w = makeWorld();
  w.vigilanteInteractable(w.policeCar).act();
  w.updateVigilante(1 / 30, false);
  w.health.set(w.policeCar, 0);
  w.updateVigilante(1 / 30, false);
  check('警車毀損（dmg.healthOf 0）→ 結束 wrecked', !w.vigilante.active && w.log.some((e) => e[0] === 'vigilante:end' && e[1].reason === 'wrecked'));
}
{
  const w = makeWorld();
  w.vigilanteInteractable(w.policeCar).act();
  w.updateVigilante(1 / 30, false);
  w.cancelVigilante();
  const bar = w.doc.body.children.find((c) => c.className === 'vig-bar');
  check('cancelVigilante()：無聲結束、逃犯車回收、任務條收起', !w.vigilante.active && w.vehicles.vehicles.length === 0 && bar.hidden && !w.toasts.some((t) => t.startsWith('警車任務結束')));
}
{
  // BUSTED / WASTED：beginRespawn 先設 state.respawn 再 vigHooks.end(kind) → 任務條立即收起（updateVigilante 在 respawn 期間早退）
  const w = makeWorld();
  w.vigilanteInteractable(w.policeCar).act();
  w.updateVigilante(1 / 30, false);
  const bar = w.doc.body.children.find((c) => c.className === 'vig-bar');
  const shown = bar && !bar.hidden;
  w.deps.state.respawn = 'busted';
  w.deps.vigHooks.end('busted');
  run(w, 1);
  check('BUSTED：vigHooks.end → 任務結束、任務條收起（respawn 期間不殘留）', shown && !w.vigilante.active && bar.hidden);
}
{
  // 玩家開走的逃犯車：任務結束保留給玩家，併入 adopted（一般車輛回收）
  const w = makeWorld();
  w.vigilanteInteractable(w.policeCar).act();
  w.updateVigilante(1 / 30, false);
  const car = w.vehicles.vehicles[0];
  w.deps.state.vehicle = car;
  car.driven = true;
  w.updateVigilante(1 / 30, false);
  w.cancelVigilante();
  check('開走的逃犯車：任務結束保留、併入 adopted（cleanupVehicles 遠離後回收）', w.vehicles.vehicles.includes(car) && w.deps.adopted.has(car) && !car.fugitive);
}
{
  // 玩家正上車（mode entering、state.vehicle = 逃犯車、driven 仍 false）：結束時不得移除（否則下一幀 drive → body null 拋錯）
  const w = makeWorld();
  w.vigilanteInteractable(w.policeCar).act();
  w.updateVigilante(1 / 30, false);
  const car = w.vehicles.vehicles[0];
  w.health.set(car, 200);
  w.updateVigilante(1 / 30, false); // 制伏
  w.deps.state.mode = 'entering';
  w.deps.state.vehicle = car;
  w.cancelVigilante();
  check('上車中的逃犯車：結束時保留（不 remove / 不 detach）、併入 adopted', w.vehicles.vehicles.includes(car) && w.health.has(car) && w.deps.adopted.has(car));
  const w2 = makeWorld();
  w2.vigilanteInteractable(w2.policeCar).act();
  w2.updateVigilante(1 / 30, false);
  const car2 = w2.vehicles.vehicles[0];
  w2.deps.cj.vehicle = car2;
  w2.cancelVigilante();
  check('搶車中（cj.vehicle）的逃犯車：結束時保留、併入 adopted', w2.vehicles.vehicles.includes(car2) && w2.deps.adopted.has(car2));
}
{
  // createVigilanteBar：urgent class
  const doc = fakeDoc();
  const b = createVigilanteBar({ root: doc.body, doc });
  b.set('x', true);
  check('createVigilanteBar：.vig-urgent 切換、null 隱藏', b.el.classList.contains('vig-urgent') && !b.el.hidden && (b.set(null), b.el.hidden));
  check('createVigilanteBar：無 document 時退化為 no-op', typeof createVigilanteBar({ doc: null }).set === 'function');
}

// ---------- hud.js / style.css / 標記 ----------
const hudSrc = read('src/hud.js');
check("hud.js：入帳跳字 vigilante「警車任務」", /MONEY_REASON_LABEL = \{[^}]*vigilante: '警車任務 '/.test(hudSrc));
check("hud.js：fugitive 超出小地圖半徑時貼邊（EDGE_KINDS）", /const EDGE_KINDS = new Set\(\[[^\]]*'fugitive'/.test(hudSrc));
check("marker-colors.js：MARKER_COLORS.fugitive 紅色、與其他 kind 不重複", /^#ff[0-9a-f]{4}$/i.test(MARKER_COLORS.fugitive || '') && new Set(Object.values(MARKER_COLORS)).size === Object.keys(MARKER_COLORS).length);
const bigSrc = read('src/map/big-map.js');
check("big-map.js：MARKER_LABELS.fugitive = '逃犯車'（kind 順序同 MARKER_COLORS）", bigSrc.includes("fugitive: '逃犯車'") && bigSrc.indexOf("fugitive: '逃犯車'") < bigSrc.indexOf("store: '超商'") && Object.keys(MARKER_COLORS).indexOf('fugitive') < Object.keys(MARKER_COLORS).indexOf('store'));
const styleSrc = read('src/style.css');
check('style.css：.vig-bar / [hidden] / .vig-urgent、pointer-events none', ['.vig-bar {', '.vig-bar[hidden]', '.vig-bar.vig-urgent'].every((k) => styleSrc.includes(k)) && /\.vig-bar \{[^}]*pointer-events: none;/.test(styleSrc));
check('wanted.css / missions.css：未混入 .vig- 選擇器', !read('src/wanted/wanted.css').includes('.vig-') && !read('src/missions/missions.css').includes('.vig-'));
const vigSrc = read('src/missions/vigilante.js');
check('vigilante.js：不 import three / rapier / DOM 全域', !/^import .*(three|rapier)/m.test(vigSrc) && !/^import .*(hud|main)\.js/m.test(vigSrc));

// ---------- interfaces.md：§29 + 事件表 ----------
const docs = read('docs/dev/interfaces.md');
check('interfaces.md：§29 Phase 11 警車任務', docs.includes('## 29. Phase 11 警車任務 Vigilante'));
check('interfaces.md：事件表含 vigilante:start / vigilante:level / vigilante:end', ['| `vigilante:start` |', '| `vigilante:level` |', '| `vigilante:end` |'].every((k) => docs.includes(k)));

console.log(`${failed === 0 ? 'PASS' : 'FAIL'} ${failed === 0 ? passed : failed}/${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
