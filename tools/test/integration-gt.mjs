#!/usr/bin/env node
// 垃圾車事件 / 夜市攤車 / 互動提示 整合（G2）驗證
// 用法：node tools/test/integration-gt.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：
//   靜態（main.js + core/loop.js + audio/index.js 合併原始碼）：createMissions 注入 routeFor、missions.truckState、
//     createVehicleModel('garbage_truck') 純視覺車體（不進 VehicleManager / traffic）+ registerNight、garbageTruckDist、LOOPS.garbage_truck（music 群組）、
//     loadPropModels（啟動 Promise.all）、night_market_stall + placeProp + propEmissiveMaterials、event-truck 標記、missions.update 吃 simDt（§20）、
//     setPrompts 不再先 setPrompt 再 setInteractPrompt(null)；traffic.js CAR_TYPES 不含 garbage_truck；色表 / 圖例 / 小地圖貼邊含 event-truck
//   行為（node 可執行、不 import three / rapier）：main.js 的 garbageTruckRoute / stallPlacement 原始碼抽出後以假路網 / 真 citymodel 執行；
//     garbage-truck.js 接 routeFor 後出現在玩家附近、simDt = 0（暫停）不推進；audio 垃圾車 loop 依距離開關（遲滯）、暫停靜音不排程；
//     操作說明（桌機 / 觸控）含垃圾車列；大地圖 / 小地圖色表含 event-truck
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
const loopSrc = read('src/core/loop.js');
const audioSrc = read('src/audio/index.js');
const code = `${mainSrc}\n${loopSrc}\n${audioSrc}`;
const missing = (list) => list.filter((s) => !(s instanceof RegExp ? s.test(code) : code.includes(s)));
const GROUPS = [
  ['垃圾車路線：createMissions 注入 routeFor（graph 閉包、findRoute / projectToGraph）', [
    'routeFor: (p, rng) => garbageTruckRoute(graph, p || focus, rng)', 'function garbageTruckRoute(graph, p, rng)', 'findRoute(graph, near, far)',
    /import \{[^}]*\bprojectToGraph\b[^}]*\} from '\.\/navigation\.js';/]],
  ['垃圾車車體：createVehicleModel(\'garbage_truck\') 純視覺、每幀依 truckState 擺位 / 隱藏、beacon registerNight', [
    "createVehicleModel('garbage_truck')", 'missions.truckState()', 'truckMesh.visible = false', 'truckMesh.rotation.y = tk.heading',
    "vehicleTemplateMaterials('garbage_truck')", 'EMISSIVE_MATERIALS.includes(m.name)', 'registerNight(m, m.emissiveIntensity || 1)', 'scene.add(truckMesh)']],
  ['時間步（§20）：missions.update / 車體同步吃 worldStep.simDt', ['missions.update(worldStep.simDt, missionCtx)', 'syncGarbageTruck(worldStep.simDt)']],
  ['音效：garbageTruckDist（無車 Infinity）→ LOOPS.garbage_truck（music 群組、< 220 m、ctrl.set、暫停 0）', [
    'garbageTruckDist: Infinity', 'st.garbageTruckDist = tk && Number.isFinite(tk.distM) ? tk.distM : Infinity', 'LOOPS.garbage_truck',
    "startLoop('garbage_truck', music)", 'export const TRUCK_ON = 220', 'loops.garbage_truck.ctrl.set(state, now)', 'loopGain(loops.garbage_truck, paused ? 0 : 1, now)']],
  ['夜市攤車：Promise.all 加 loadPropModels、night_market_stall + placeProp + 夜間發光', [
    'await Promise.all([loadCharacterModels(), loadVehicleModels(), loadPropModels()]);', "createPropModel('night_market_stall')",
    'placeProp(stall,', "propEmissiveMaterials('night_market_stall')", 'scene.add(stall)', 'NIGHT_MARKET_DELIVERY.pickup']],
  ['標記：event-truck（小地圖 / 大地圖）', ['event-truck']],
  ['事件提示：垃圾車 available / closed 不沿用夜市外送文字', ["e.kind === 'truck'", "e.id === 'garbage-truck'"]],
  ['觸控文字：createMissions 注入 isTouch（目標列 / 字幕「點「互動」鈕」，missions 內不讀 DOM / navigator）', [
    /createMissions\(\{[^}]*\bisTouch: touch\b[^}]*\}\);/]],
];
for (const [name, list] of GROUPS) {
  const miss = missing(list);
  check(`main/loop/audio 接線：${name}`, !miss.length, miss.map(String).join(' | '));
}
{
  // 'garbage_truck' 在 main.js 只出現在純視覺車體（createVehicleModel / vehicleTemplateMaterials），不交給 VehicleManager / Traffic / parked
  const uses = [...mainSrc.matchAll(/'garbage_truck'/g)].map((m) => mainSrc.slice(Math.max(0, m.index - 30), m.index));
  check('垃圾車不進 VehicleManager / traffic（main.js 只有視覺車體用到 garbage_truck）', uses.length >= 2 && uses.every((s) => /createVehicleModel\($|vehicleTemplateMaterials\($/.test(s)), uses.join(' | '));
  const traffic = read('src/traffic.js');
  const m = traffic.match(/const CAR_TYPES = \[([^\]]*)\]/);
  check('traffic.js CAR_TYPES 不含 garbage_truck（不進車流）', !!m && !m[1].includes('garbage_truck'), m ? m[1] : '找不到 CAR_TYPES');
  // 攤車 / 垃圾車不因畫質略過（各畫質都擺）：建立處不受 tier / budget 條件包住
  const stallAt = mainSrc.indexOf("const stall = createPropModel('night_market_stall');");
  const stallCtx = mainSrc.slice(mainSrc.lastIndexOf('await Promise.all', stallAt), mainSrc.indexOf('\n  }\n', stallAt));
  check('夜市攤車不依畫質略過（Promise.all 之後直接建立，無 tier / budget 條件）', stallAt > 0 && stallCtx.length < 900 && !/tier|budget|quality/.test(stallCtx));
}
{
  // 提示 bug：setPrompts 不再無條件 setPrompt(車輛) 後 setInteractPrompt(null)（後者蓋掉「按 F 上車」）
  const i = mainSrc.indexOf('const setPrompts = (vehicleText, inter) => {');
  const body = mainSrc.slice(i, mainSrc.indexOf('\n  };', i));
  check('setPrompts：兩者都有 → hud.setPrompts；只有互動 → setInteractPrompt；其餘 → setPrompt', i > 0 && body.includes('if (vehicleText && text)') && body.includes('hud.setPrompts(vehicleText, text)') && body.includes('hud.setInteractPrompt(text)') && body.includes('hud.setPrompt(vehicleText || text)'));
  check('setPrompts：不再「setPrompt(vehicleText); setInteractPrompt(text);」連續呼叫', !/hud\.setPrompt\(vehicleText\);\s*hud\.setInteractPrompt\(text\);/.test(body));
  const hudSrc = read('src/hud.js');
  check('hud.js：setPrompts(vehicleText, interactText) 並列兩則、tb-interact 依互動提示', hudSrc.includes('setPrompts(vehicleText, interactText) {') && hudSrc.includes('const on = this.touch && !!this._rawInteract;'));
  check('hud.js：event-truck 超出小地圖半徑時貼邊', /const EDGE_KINDS = new Set\(\[[^\]]*'event-truck'/.test(hudSrc));
}

// ---------- 行為：main.js 的純函式（原始碼抽出、注入假依賴） ----------
const extractFn = (name) => {
  const i = mainSrc.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`main.js 找不到 function ${name}`);
  return mainSrc.slice(i, mainSrc.indexOf('\n}\n', i) + 2);
};
const constDecls = [...mainSrc.matchAll(/^const (TRUCK_\w+|STALL_\w+) = [\d.]+;/gm)].map((m) => m[0]).join('\n');
const makeHelpers = (deps) => new Function(
  'projectToGraph', 'findRoute', 'surfaceRoads', 'onRoadSurface', 'buildingAt',
  `${constDecls}\n${extractFn('garbageTruckRoute')}\n${extractFn('nearestRoadPoint')}\n${extractFn('stallPlacement')}\nreturn { garbageTruckRoute, nearestRoadPoint, stallPlacement, TRUCK_NEAR_MIN, TRUCK_NEAR_MAX, TRUCK_ROUTE_TRIES, STALL_CURB_GAP };`,
)(deps.projectToGraph, deps.findRoute, deps.surfaceRoads, deps.onRoadSurface, deps.buildingAt);
const lcg = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

// 假路網：東西向道路每 100 m 一條（z = 100k），投影 = 吸到最近一條；findRoute = 起點 → 沿 x 走 → 終點（曼哈頓）
const fakeGraph = { edgeCount: 1 };
let routeCalls = 0;
const fake = {
  projectToGraph: (g, x, z, out) => {
    if (!g) return null;
    out.x = x;
    out.z = Math.round(z / 100) * 100;
    out.dist = Math.abs(out.z - z);
    return out;
  },
  findRoute: (g, a, b) => {
    routeCalls++;
    const pts = [{ x: a.x, z: a.z }, { x: b.x, z: a.z }, { x: b.x, z: b.z }];
    return { points: pts, lengthM: Math.abs(b.x - a.x) + Math.abs(b.z - a.z) };
  },
  surfaceRoads: [],
  onRoadSurface: () => null,
  buildingAt: () => null,
};
{
  const H = makeHelpers(fake);
  const rng = lcg(7);
  const player = { x: 20, z: 30 };
  let okBand = true;
  let okLen = true;
  for (let i = 0; i < 40; i++) {
    const pts = H.garbageTruckRoute(fakeGraph, player, rng);
    if (!pts) {
      okBand = false;
      continue;
    }
    const d0 = Math.hypot(pts[0].x - player.x, pts[0].z - player.z);
    if (d0 < H.TRUCK_NEAR_MIN * 0.5 || d0 > H.TRUCK_NEAR_MAX * 1.5) okBand = false;
    let len = 0;
    for (let k = 1; k < pts.length; k++) len += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z);
    if (len < 100) okLen = false;
  }
  check('garbageTruckRoute：起點為玩家附近 150–300 m（投影後 75–450 m）的道路點', okBand);
  check('garbageTruckRoute：路線往更遠處延伸（長度 ≥ 100 m）', okLen);
  check('garbageTruckRoute：graph / 玩家位置缺 → null', H.garbageTruckRoute(null, player, rng) === null && H.garbageTruckRoute(fakeGraph, null, rng) === null);
  const H2 = makeHelpers({ ...fake, findRoute: (...a) => (fake.findRoute(...a), null) });
  routeCalls = 0;
  check('garbageTruckRoute：查不到路線 → 換方向重試 TRUCK_ROUTE_TRIES 次後回 null', H2.garbageTruckRoute(fakeGraph, player, rng) === null && routeCalls === H2.TRUCK_ROUTE_TRIES, `呼叫 ${routeCalls} 次`);

  // 接上 garbage-truck.js：同 main.js 的 routeFor 閉包（p 為 null 時用 focus）
  const { createGarbageTruck, ENGAGE_M } = await import('../../src/missions/garbage-truck.js');
  const focus = { x: 20, z: 30 };
  let t = 0;
  const events = [];
  const truck = createGarbageTruck({
    getGameHour: () => 16.5,
    routeFor: (p, r) => H.garbageTruckRoute(fakeGraph, p || focus, r),
    now: () => t,
    rng: lcg(3),
    bus: { emit: (n, p) => events.push([n, p]) },
  });
  const ctx = { x: focus.x, z: focus.z, driving: false };
  truck.update(1 / 60, ctx);
  t += 1 / 60;
  const s0 = truck.truck();
  const d0 = s0 ? Math.hypot(s0.x - focus.x, s0.z - focus.z) : NaN;
  check('垃圾車接 routeFor：16:30 出現在玩家附近（event:available、距離 > ENGAGE_M 且 < 450 m）', !!s0 && events.some((e) => e[0] === 'event:available' && e[1].kind === 'truck') && d0 > ENGAGE_M && d0 < 450, `距離 ${d0.toFixed(1)} m`);
  const x0 = s0.x;
  const z0 = s0.z;
  for (let i = 0; i < 30; i++) truck.update(0, ctx); // 暫停 / 面板開啟：simDt = 0
  check('§20：simDt = 0（暫停 / 本幀無子步）垃圾車不推進', truck.truck().x === x0 && truck.truck().z === z0);
  for (let i = 0; i < 60; i++) {
    truck.update(1 / 60, ctx);
    t += 1 / 60;
  }
  const moved = Math.hypot(truck.truck().x - x0, truck.truck().z - z0);
  check('simDt 推進 1 s → 垃圾車沿路線行駛約 speed m', moved > 3 && moved < 8, `${moved.toFixed(2)} m`);
  check('truckState 帶 heading / distM（擺車體 / 音量用）', Number.isFinite(truck.truck().heading) && Number.isFinite(truck.truck().distM));
  truck.dispose();
}

// ---------- 行為：夜市攤車擺位（真 citymodel 路網 + 取餐點） ----------
{
  const city = await import('../../src/citymodel.js');
  const { NIGHT_MARKET_DELIVERY } = await import('../../src/missions/events.js');
  const { placeProp, propWorldPoint, propPlacement } = await import('../../src/prop-model.js');
  const H = makeHelpers({ ...fake, surfaceRoads: city.surfaceRoads, onRoadSurface: city.onRoadSurface, buildingAt: city.buildingAt });
  const pk = NIGHT_MARKET_DELIVERY.pickup;
  const depth = 1.56; // public/models/props/manifest.json night_market_stall.depth
  const spot = H.stallPlacement(pk, depth);
  const road = H.nearestRoadPoint(pk.x, pk.z);
  const off = Math.hypot(spot.x - road.x, spot.z - road.z);
  check('攤車：在取餐點最近道路的路緣外（距中心線 = 半寬 + 間隙 + 半個攤車深）', !!road && Math.abs(off - (road.hw + H.STALL_CURB_GAP + depth / 2)) < 1e-6, `${off.toFixed(2)} m / hw ${road && road.hw}`);
  check('攤車：不在車道上、不在建築內', !city.onRoadSurface(spot.x, spot.z, 0.3, false) && !city.buildingAt(spot.x, spot.z, 0.5));
  check('攤車：離取餐點 < 取餐半徑（玩家在攤車旁即可按 E 取餐）', Math.hypot(spot.x - pk.x, spot.z - pk.z) < pk.radius, Math.hypot(spot.x - pk.x, spot.z - pk.z).toFixed(2));
  const obj = { position: { set(x, y, z) { Object.assign(this, { x, y, z }); } }, rotation: { y: NaN } };
  const pl = placeProp(obj, { ...spot, y: 12.5 });
  const front = propWorldPoint([0, 0, 1], pl);
  check('攤車：placeProp 套用位置 / y（地面高）、正面 +Z 朝向道路點', obj.position.x === spot.x && obj.position.z === spot.z && obj.position.y === 12.5 && Number.isFinite(obj.rotation.y) && Math.hypot(front.x - road.x, front.z - road.z) < Math.hypot(spot.x - road.x, spot.z - road.z) - 0.99);
  check('攤車：propPlacement 與 placeProp 同結果', JSON.stringify(propPlacement({ ...spot, y: 12.5 })) === JSON.stringify(pl));
}

// ---------- 行為：音效（假 AudioContext） ----------
class FakeParam {
  constructor(v = 0) {
    this.value = v;
    this.target = null;
  }
  setValueAtTime() {}
  linearRampToValueAtTime() {}
  exponentialRampToValueAtTime() {}
  setTargetAtTime(v) { this.target = v; }
  cancelScheduledValues() {}
}
class FakeNode {
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind;
    this.outs = [];
    ctx.log.push(this);
  }
  connect(n) { this.outs.push(n); return n; }
  disconnect() { this.outs.length = 0; }
}
class FakeSource extends FakeNode {
  start(tm = 0) { this.started = tm; }
  stop(tm = 0) { this.stopped = tm; }
}
class FakeAudioContext {
  constructor() {
    this.log = [];
    this.currentTime = 0;
    this.sampleRate = 8000;
    this.state = 'suspended';
    this.destination = { kind: 'destination' };
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
  createGain() { const n = new FakeNode(this, 'gain'); n.gain = new FakeParam(1); return n; }
  createBiquadFilter() { const n = new FakeNode(this, 'biquad'); n.frequency = new FakeParam(350); n.Q = new FakeParam(1); n.gain = new FakeParam(0); return n; }
  createOscillator() { const n = new FakeSource(this, 'osc'); n.frequency = new FakeParam(440); n.detune = new FakeParam(0); return n; }
  createBufferSource() { const n = new FakeSource(this, 'buffer'); n.playbackRate = new FakeParam(1); return n; }
  createStereoPanner() { const n = new FakeNode(this, 'panner'); n.pan = new FakeParam(0); return n; }
  createBuffer(ch, len, sr) {
    const data = new Float32Array(len);
    return { length: len, sampleRate: sr, duration: len / sr, numberOfChannels: ch, getChannelData: () => data };
  }
}
{
  const { createAudio, TRUCK_ON, LOOP_NAMES } = await import('../../src/audio/index.js');
  const { createBus } = await import('../../src/core/events.js');
  const { createSettings } = await import('../../src/core/settings.js');
  const settings = createSettings({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  const audio = createAudio({ bus: createBus(), settings, AudioContextCtor: FakeAudioContext });
  audio.unlock();
  await Promise.resolve();
  const ctx = audio.getOutput().ctx;
  check('LOOPS.garbage_truck 在 LOOP_NAMES、開啟門檻 220 m', LOOP_NAMES.includes('garbage_truck') && TRUCK_ON === 220);
  const st = { x: 0, z: 0, yaw: 0, driving: false, rpm01: 0, throttle: 0, skid01: 0, walkSpeed: 0, grounded: true, nearJunction: null, paused: false, rain: 0, garbageTruckDist: Infinity };
  audio.update(1 / 60, st);
  check('無垃圾車（garbageTruckDist = Infinity）→ 不開', !audio.stats().garbageTruck && audio.stats().loops === 0);
  st.garbageTruckDist = 250;
  audio.update(1 / 60, st);
  check('距離 250 m（≥ 220）→ 不開', !audio.stats().garbageTruck);
  st.garbageTruckDist = 150;
  const nBefore = ctx.log.length;
  audio.update(1 / 60, st);
  const oscs = () => ctx.log.filter((n) => n.kind === 'osc').length;
  check('距離 150 m → 開 LOOPS.garbage_truck（持續音源 +1）並排程音符', audio.stats().garbageTruck && audio.stats().loops === 1 && oscs() > 0);
  const musicGroup = audio.getOutput().out && ctx.log.find((n) => n.kind === 'gain' && n !== audio.getOutput().out && n.outs.includes(audio.getOutput().out) && ctx.log.indexOf(n) < nBefore && n.gain.value === settings.get('volumeMusic'));
  const outer = ctx.log.slice(nBefore).filter((n) => n.kind === 'gain' && musicGroup && n.outs.includes(musicGroup));
  check('垃圾車 loop 接 music 群組（音樂音量）', !!musicGroup && outer.length === 1, `${outer.length}`);
  st.garbageTruckDist = 225;
  audio.update(1 / 60, st);
  check('遲滯：225 m（220–235 之間）維持開啟', audio.stats().garbageTruck);
  st.paused = true;
  const o0 = oscs();
  for (let i = 0; i < 10; i++) {
    ctx.currentTime += 0.5;
    audio.update(1 / 60, st);
  }
  check('暫停：外層增益 → 0、不再排程音符', outer[0] && outer[0].gain.target === 0 && oscs() === o0);
  st.paused = false;
  ctx.currentTime += 0.1;
  audio.update(1 / 60, st);
  check('恢復：外層增益回 1、繼續排程', outer[0].gain.target === 1 && oscs() > o0);
  st.garbageTruckDist = 400;
  audio.update(1 / 60, st);
  check('距離 400 m → 關閉', !audio.stats().garbageTruck && audio.stats().loops === 0);
  st.garbageTruckDist = 100;
  audio.update(1 / 60, st);
  st.garbageTruckDist = Infinity;
  audio.update(1 / 60, st);
  check('垃圾車消失（Infinity）→ 關閉', !audio.stats().garbageTruck);
  audio.dispose();
}

// ---------- 行為：標記色 / 圖例、操作說明 ----------
{
  const { MARKER_COLORS } = await import('../../src/map/marker-colors.js');
  check('marker-colors：event-truck 有色碼且與其他 kind 不重複', /^#[0-9a-f]{6}$/i.test(MARKER_COLORS['event-truck'] || '') && new Set(Object.values(MARKER_COLORS)).size === Object.keys(MARKER_COLORS).length);
  const bigSrc = read('src/map/big-map.js');
  check('big-map：MARKER_LABELS 有 event-truck 圖例（圖例依 MARKER_COLORS 逐 kind 產生）', /'event-truck':\s*'垃圾車'/.test(bigSrc) && bigSrc.includes('for (const kind of Object.keys(MARKER_COLORS)) addLegend('));
  const { KEYMAP_HELP, TOUCH_HELP } = await import('../../src/core/actions.js');
  const rows = (help) => help.flatMap((g) => g.items);
  const kTruck = rows(KEYMAP_HELP).find((i) => i.desc.includes('倒垃圾') && i.action === null);
  const tTruck = rows(TOUCH_HELP).find((i) => i.desc.includes('倒垃圾') && i.action === null);
  check('操作說明（桌機）：垃圾車列（傍晚、追上車尾按 E）', !!kTruck && /16–18/.test(kTruck.desc) && kTruck.desc.includes('車尾') && kTruck.desc.includes('按 E'));
  check('操作說明（觸控）：垃圾車列（追上車尾點「互動」鈕）', !!tTruck && /16–18/.test(tTruck.desc) && tTruck.desc.includes('車尾') && tTruck.desc.includes('「互動」鈕'));
  check('操作說明：E 互動列含外送取餐與倒垃圾（步行 / 駕駛）', rows(KEYMAP_HELP).filter((i) => i.keys === 'E').length === 2 && rows(KEYMAP_HELP).filter((i) => i.keys === 'E').every((i) => i.action === 'interact' && i.desc.includes('外送取餐') && i.desc.includes('倒垃圾')));
}

console.log(`${failed ? 'FAIL' : 'PASS'} ${failed ? failed : passed}/${passed + failed}`);
process.exit(failed ? 1 : 0);
