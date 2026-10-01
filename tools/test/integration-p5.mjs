#!/usr/bin/env node
// Phase 5 整合（i5）驗證：天氣 / 環境、車上電台、時段事件（夜市外送）的接線
// 用法：node tools/test/integration-p5.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：
//   靜態（main.js + core/loop.js 合併原始碼）：createWeather / createEnvironment / createRadio / getGameHour / routeLength /
//     pressedIn('radioNext' / env.setViewDist / weather.setQuality / 雨聲 st.rain / simDt 順序 / HUD 欄位 / 存檔欄位；hud.js / menu.js / audio 原始碼關鍵點
//   行為（node 可執行、不 import three / rapier）：save.js validateSave 接受合法 missions.events、格式錯誤整欄丟棄且不影響其他欄位、
//     存讀來回；audio getOutput() 解鎖前 null、解鎖後 { ctx, out: master }；雨聲 loop 依 state.rain 開關、暫停靜音；
//     radio 接 audio.getOutput() 時輸出接 master；loop.js worldStep.simDt（step 後 = simDt、resetPerf 歸零）；
//     missions 的 events.serialize → validateSave → events.restore 來回
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

globalThis.document = { createElement: () => ({ style: {} }) };

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
const code = `${mainSrc}\n${loopSrc}`;
const missing = (list) => list.filter((s) => !(s instanceof RegExp ? s.test(code) : code.includes(s)));
const GROUPS = [
  ['import：weather / environment / radio / findRoute', [
    "import { createWeather, WEATHER_KINDS } from './weather.js';", "import { createEnvironment } from './environment.js';",
    "import { createRadio } from './audio/radio.js';", /import \{[^}]*\bfindRoute\b[^}]*\} from '\.\/navigation\.js';/]],
  ['環境：createEnvironment attach dayNight、視距走 env.setViewDist、applyViewDist 不再直接寫 scene.fog', [
    'createEnvironment({ scene, dayNight, viewDist: budget.viewDist', 'env.setViewDist(dist)', 'applyViewDist(budget.viewDist)']],
  ['天氣：createWeather 注入 THREE / camera / 畫質、畫質切換 weather.setQuality', [
    'createWeather({ scene, camera, quality: budget, THREE,', 'weather.setQuality(budget)']],
  ['時鐘（§20）：weather.update(dt, simDt)、env.update、worldStep.simDt（遊戲中與開始畫面）', [
    'weather.update(dt, simDt)', 'env.update(dt, { dayNight, weather })', 'updateEnvironment(dt, worldStep.simDt)',
    'get simDt()', 'lastSimDt = simDt', 'lastSimDt = 0']],
  ['天氣設定：settings weather + bus weather:setting → setAuto / setWeather', [
    "settings.get('weather')", "key === 'weather'", "bus.on('weather:setting'", 'weather.setAuto(', 'weather.setWeather(pref, { instant: true })']],
  ['雨聲：音效 state.rain = weather.getState().rain', ['rain: 0,', 'st.rain = weather.getState().rain', 'audio.update(dt, st)']],
  ['電台：createRadio 接 audio.getOutput、音樂音量、每幀 update 帶 inVehicle / paused', [
    'createRadio({ getAudio: () => audio.getOutput(), getMusicVolume: () => settings.get(\'volumeMusic\') })',
    'radioCtx.inVehicle = driving', 'radioCtx.paused = st.paused', 'radio.update(dt, radioCtx)']],
  ['電台鍵位：駕駛分支 pressedIn(\'radioNext\', \'vehicle\') → radio.next()', ["input.actions.pressedIn('radioNext', 'vehicle')", 'radio.next()']],
  ['時段事件：createMissions 注入 getGameHour / routeLength（findRoute(graph, a, b)?.lengthM）', [
    'getGameHour: () => dayNight.hour', 'routeLength: (a, b) => findRoute(graph, a, b)?.lengthM']],
  ['事件提示 / 入帳 reason / 大地圖標記色', [
    "bus.on('event:available'", "bus.on('event:closed'", 'hud.setMoney?.(money, delta, reason)', 'BIG_MAP_COLORS[k] = EVENT_MAP_COLORS[k]', "'event-start'", "'event-dest'"]],
  ['HUD 新欄位：weatherIcon / radio', ['weatherIcon: weather.getState().icon', 'radio: radio.getState()']],
  ['存檔：missions.serialize（含 events）、restore', ['missions: missions.serialize()', 'missions.restore(save.missions)']],
];
for (const [name, list] of GROUPS) {
  const miss = missing(list);
  check(`main/loop 接線：${name}`, !miss.length, miss.map(String).join(' | '));
}
// 順序：遊戲中 dayNight.update → updateEnvironment（weather → env）；步行分支不讀 radioNext
{
  const iDn = mainSrc.indexOf('dayNight.update(dt, focus);');
  const iEnv = mainSrc.indexOf('updateEnvironment(dt, worldStep.simDt);', iDn);
  const iStep = mainSrc.indexOf('stepWorld(dt, state.mode === \'drive\'');
  check('順序：stepWorld → dayNight.update → updateEnvironment（weather.update 拿得到本幀 simDt）', iStep > 0 && iDn > iStep && iEnv > iDn && iEnv - iDn < 80);
  const fn = mainSrc.slice(mainSrc.indexOf('const updateEnvironment'), mainSrc.indexOf('};', mainSrc.indexOf('const updateEnvironment')));
  check('updateEnvironment 內 weather.update 在 env.update 之前', fn.indexOf('weather.update') >= 0 && fn.indexOf('weather.update') < fn.indexOf('env.update'));
  const attract = mainSrc.slice(mainSrc.indexOf('const updateAttract'), mainSrc.indexOf('// ---------- 效能統計'));
  check('開始畫面：dayNight.update → stepWorld → updateEnvironment', /dayNight\.update[\s\S]*stepWorld[\s\S]*updateEnvironment\(dt, worldStep\.simDt\)/.test(attract));
  const driveBranch = mainSrc.slice(mainSrc.indexOf("if (state.mode === 'drive') {\n      const v = state.vehicle;"), mainSrc.indexOf('updateKnockout(dt);'));
  check('radioNext 只在駕駛分支、weaponCycle 仍在步行（handleWeaponInput）', driveBranch.includes("pressedIn('radioNext', 'vehicle')") && driveBranch.split('} else {')[1].includes('handleWeaponInput') && !driveBranch.split('} else {')[1].includes('radioNext'));
  check('applyViewDist 不再直接改 scene.fog（attach 後由 environment 套用）', !/scene\.fog\.(near|far)\s*=/.test(mainSrc));
}
// hud.js / menu.js / audio 原始碼關鍵點
{
  const hudSrc = read('src/hud.js');
  check('hud.js：天氣圖示（sun / rain / fog）、台名、tb-radio（KeyQ、drive、top2）、事件標記色', [
    'WEATHER_ICONS', '_updateWeather(state.weatherIcon)', '_updateRadio(dt, state.radio', "registerTouchButton({ id: RADIO_BTN_ID, label: '電台', code: 'KeyQ', mode: 'tap', slot: 'top2', showWhen: 'drive' })",
    "'event-start':", "'event-dest':", "'event-start', 'event-dest'"].every((s) => hudSrc.includes(s)));
  const touchSrc = read('src/touch.js');
  const defaults = touchSrc.slice(touchSrc.indexOf('const DEFAULT_BUTTONS'), touchSrc.indexOf('];', touchSrc.indexOf('const DEFAULT_BUTTONS')));
  const drives = [...defaults.matchAll(/slot: '(\w+)', showWhen: '(drive|always)'/g)].map((m) => m[1]);
  check('觸控換台鈕 top2 不與既有駕駛 / 共用按鈕撞位', !drives.includes('top2'), drives.join(','));
  const menuSrc = read('src/ui/menu.js');
  check('menu.js：天氣列（自動 / 晴 / 雨 / 霧）走 settings、不支援時 fallback + weather:setting', [
    "key: 'weather'", "['auto', '自動']", "['clear', '晴']", "['rain', '雨']", "['fog', '霧']", "weather: 'weather:setting'", 'settings.set(key, value)'].every((s) => menuSrc.includes(s)));
  const audioSrc = read('src/audio/index.js');
  check('audio/index.js：loops.rain、startLoop(\'rain\', sfx)、ctrl.set(state, now)、paused → 0、getOutput', [
    "startLoop('rain', sfx)", 'loops.rain.ctrl.set(state, now)', 'loopGain(loops.rain, paused ? 0 : 1, now)', 'getOutput:'].every((s) => audioSrc.includes(s)));
  const doc = read('docs/dev/interfaces.md');
  check('interfaces.md：§21 Phase 5 整合節、§18 missions.events', doc.includes('## 21. Phase 5 整合') && doc.includes('missions.events?: { completed:') && doc.includes('weather.update(dt, worldStep.simDt)'));
}

// ---------- save.js：missions.events ----------
const { validateSave, defaultSave, createSaveStore } = await import('../../src/save.js');
{
  const base = () => {
    const d = defaultSave();
    d.missions.completed = { 'milk-tea': 2 };
    d.missions.cooldowns = { 'milk-tea': 30 };
    return d;
  };
  const good = base();
  good.missions.events = { completed: { 'night-market-delivery': 3 }, cooldowns: { 'night-market-delivery': 120.5 } };
  const v = validateSave(good);
  check('合法 missions.events 保留', v && v.missions.events && v.missions.events.completed['night-market-delivery'] === 3 && v.missions.events.cooldowns['night-market-delivery'] === 120.5, JSON.stringify(v && v.missions.events));
  check('合法 events 不影響其他 missions 欄位', v.missions.completed['milk-tea'] === 2 && v.missions.cooldowns['milk-tea'] === 30 && v.missions.active === null);
  const noEv = validateSave(base());
  check('無 events → 不帶 events 欄位（同 defaultSave 形狀）', noEv && !('events' in noEv.missions) && !('events' in defaultSave().missions));
  const bads = [
    ['events 為字串', 'oops'],
    ['events 為陣列', [1, 2]],
    ['events 為 null', null],
    ['completed 為陣列', { completed: ['x'], cooldowns: {} }],
    ['cooldowns 為數字', { completed: { a: 1 }, cooldowns: 5 }],
    ['兩表皆空', { completed: {}, cooldowns: {} }],
    ['全部非法值', { completed: { a: -1, b: 'x', c: 0 }, cooldowns: { a: 0, b: NaN } }],
  ];
  for (const [name, ev] of bads) {
    const s = base();
    s.missions.events = ev;
    const out = validateSave(s);
    check(`格式錯誤（${name}）→ 丟棄 events、其他欄位不受影響`, out && !('events' in out.missions) && out.missions.completed['milk-tea'] === 2 && out.missions.cooldowns['milk-tea'] === 30 && out.money === 500);
  }
  const mixed = base();
  mixed.missions.events = { completed: { ok: 2.7, neg: -3, zero: 0, __proto__x: 1 }, cooldowns: { ok: 9, zero: 0, inf: Infinity }, extra: 'drop' };
  const mo = validateSave(mixed);
  check('表內非法鍵個別丟棄、取整、未知子欄位丟棄', mo.missions.events && mo.missions.events.completed.ok === 2 && !('neg' in mo.missions.events.completed) && !('zero' in mo.missions.events.completed) && mo.missions.events.cooldowns.ok === 9 && !('zero' in mo.missions.events.cooldowns) && !('inf' in mo.missions.events.cooldowns) && !('extra' in mo.missions.events), JSON.stringify(mo.missions.events));
  const onlyCd = base();
  onlyCd.missions.events = { cooldowns: { 'night-market-delivery': 60 } };
  const oc = validateSave(onlyCd);
  check('只有 cooldowns（completed 省略）也接受', oc.missions.events && oc.missions.events.cooldowns['night-market-delivery'] === 60 && Object.keys(oc.missions.events.completed).length === 0);
  // 存讀來回（記憶體 storage）
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, val) => mem.set(k, String(val)), removeItem: (k) => mem.delete(k) };
  const store = createSaveStore({ storage, now: () => 1 });
  check('store.save 含 events 成功', store.save(good) === true);
  const ld = store.load();
  check('store.load 讀回 events', ld.status === 'ok' && ld.data.missions.events && ld.data.missions.events.completed['night-market-delivery'] === 3);
  // 壞 events 的原文存檔：讀檔仍 ok（不當成損毀）、events 被丟棄
  mem.set('tcgta.save', JSON.stringify({ ...base(), missions: { ...base().missions, events: [1] } }));
  const ld2 = store.load();
  check('壞 events 的存檔讀檔 status ok、只丟該欄', ld2.status === 'ok' && !('events' in ld2.data.missions) && ld2.data.missions.completed['milk-tea'] === 2);
}

// ---------- missions/events.js serialize → validateSave → restore 來回 ----------
{
  const { createTimedEvents, NIGHT_MARKET_DELIVERY } = await import('../../src/missions/events.js');
  let t = 0;
  const dests = [{ slug: 'opera', name: '歌劇院', x: NIGHT_MARKET_DELIVERY.pickup.x + 400, z: NIGHT_MARKET_DELIVERY.pickup.z, radius: 20 }];
  let routeCalls = 0;
  const ev = createTimedEvents({ getGameHour: () => 19, destinations: dests, routeLength: (a, b) => { routeCalls++; return { lengthM: Math.hypot(b.x - a.x, b.z - a.z) * 1.1 }; }, now: () => t, rng: () => 0 });
  const p = NIGHT_MARKET_DELIVERY.pickup;
  ev.update(0.1, { x: p.x, z: p.z, driving: false });
  const inter = ev.nearest({ x: p.x, z: p.z });
  check('19:00 取餐點開放（getGameHour 注入）', !!inter && ev.offers().includes(NIGHT_MARKET_DELIVERY.id));
  inter.act();
  const act = ev.active();
  check('routeLength 注入被使用（路線長 = 直線 × 1.1）', routeCalls > 0 && act && Math.abs(act.routeM - 440) < 1e-6, act && String(act.routeM));
  ev.update(1, { x: dests[0].x, z: dests[0].z, driving: true });
  const ser = ev.serialize();
  const s = defaultSave();
  s.missions.events = ser;
  const v = validateSave(s);
  check('events.serialize 的輸出通過 validateSave', v.missions.events && v.missions.events.completed[NIGHT_MARKET_DELIVERY.id] === 1 && v.missions.events.cooldowns[NIGHT_MARKET_DELIVERY.id] > 0, JSON.stringify(ser));
  const ev2 = createTimedEvents({ getGameHour: () => 19, destinations: dests, now: () => t, rng: () => 0 });
  ev2.restore(v.missions.events);
  ev2.update(0.1, { x: p.x, z: p.z, driving: false });
  check('restore 後冷卻中：取餐點不開放', !ev2.offers().includes(NIGHT_MARKET_DELIVERY.id) && ev2.serialize().completed[NIGHT_MARKET_DELIVERY.id] === 1);
}

// ---------- audio：getOutput / 雨聲 / 電台接 master ----------
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
  constructor(ctx, kind) {
    super(ctx, kind);
    this.started = null;
    this.stopped = null;
  }
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
  const { createAudio, RAIN_ON } = await import('../../src/audio/index.js');
  const { createRadio } = await import('../../src/audio/radio.js');
  const { createBus } = await import('../../src/core/events.js');
  const { createSettings } = await import('../../src/core/settings.js');
  const settings = createSettings({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  const audio = createAudio({ bus: createBus(), settings, AudioContextCtor: FakeAudioContext });
  check('audio.getOutput()：解鎖前 null', audio.getOutput() === null);
  const noop = createAudio({ bus: createBus(), settings, AudioContextCtor: null });
  check('audio.getOutput()：無 AudioContext（node no-op）→ null', typeof noop.getOutput === 'function' && noop.getOutput() === null);
  audio.unlock();
  await Promise.resolve();
  const o = audio.getOutput();
  const ctx = o && o.ctx;
  check('audio.getOutput()：解鎖後 { ctx, out: master }（master 接 destination）', !!o && ctx instanceof FakeAudioContext && o.out && o.out.kind === 'gain' && o.out.outs.includes(ctx.destination));
  check('audio.getOutput()：回傳物件重用（每幀不配置）', audio.getOutput() === o);

  const st = { x: 0, z: 0, yaw: 0, driving: false, speedKmh: 0, rpm01: 0, throttle: 0, skid01: 0, twoWheeler: false, walkSpeed: 0, grounded: true, nearJunction: null, paused: false, rain: 0 };
  audio.update(1 / 60, st);
  const loops0 = audio.stats().loops;
  st.rain = RAIN_ON / 2;
  audio.update(1 / 60, st);
  check('雨聲：rain ≤ 0.01 不開', audio.stats().loops === loops0 && loops0 === 0);
  st.rain = 0.6;
  audio.update(1 / 60, st);
  check('雨聲：rain > 0.01 開 LOOPS.rain（持續音源 +1）', audio.stats().loops === 1);
  st.paused = true;
  audio.update(1 / 60, st);
  const rainGains = ctx.log.filter((n) => n.kind === 'gain' && n.gain.target === 0);
  check('雨聲：暫停時外層增益 → 0', rainGains.length > 0);
  st.paused = false;
  st.rain = 0;
  audio.update(1 / 60, st);
  check('雨聲：rain 回 0 → 關閉', audio.stats().loops === 0);

  // 電台：getAudio = audio.getOutput；輸出接 master（不是 music 群組）
  const before = ctx.log.length;
  const radio = createRadio({ getAudio: () => audio.getOutput(), getMusicVolume: () => settings.get('volumeMusic') });
  radio.update(1 / 60, { inVehicle: true, paused: false });
  ctx.currentTime = 0.1;
  radio.update(1 / 60, { inVehicle: true, paused: false });
  const created = ctx.log.slice(before);
  const toMaster = created.filter((n) => n.outs.includes(o.out));
  check('電台：解鎖後駕駛中播放，輸出節點接 audio master', radio.getState().playing === true && toMaster.length > 0, `nodes ${created.length}, toMaster ${toMaster.length}`);
  const musicGroup = ctx.log.slice(0, before).filter((n) => n.kind === 'gain' && n !== o.out && n.outs.includes(o.out));
  check('電台：沒有接到 sfx / music 群組（避免音樂音量乘兩次）', !created.some((n) => musicGroup.some((g) => n.outs.includes(g))));
  radio.next();
  check('電台：next() 換到第 2 台', radio.getState().index === 1);
  const locked = createRadio({ getAudio: () => null, getMusicVolume: () => 0.6 });
  locked.update(1 / 60, { inVehicle: true, paused: false });
  check('電台：getAudio 回 null（未解鎖）→ 不出聲', locked.getState().playing === false);
  radio.dispose();
  audio.dispose();
}

// ---------- loop.js：worldStep.simDt ----------
{
  globalThis.performance = globalThis.performance || { now: () => Date.now() };
  const { createWorldStep } = await import('../../src/core/loop.js');
  const noop = () => {};
  const fake = {
    pw: { simTimeFor: (dt) => Math.floor(dt * 60 + 1e-9) / 60, step: noop },
    lights: { update: noop, updateVisuals: noop },
    camera: { position: { x: 0, z: 0 } },
    combat: { update: noop },
    player: { syncPhysics: noop },
    vehicles: { sync: noop, bodies: (a) => a },
    traffic: { sync: noop, bodies: (a) => a },
    dmg: { update: noop },
    isDriving: () => false,
    prepareTraffic: noop,
    advanceClock: noop,
    cleanup: noop,
    activeRadius: 100,
  };
  const ws = createWorldStep(fake);
  check('worldStep.simDt：未 step = 0', ws.simDt === 0);
  ws.step(1 / 30, { x: 0, z: 0 });
  check('worldStep.simDt：step 後 = 本幀 simDt（1/30 s → 2 子步）', Math.abs(ws.simDt - 2 / 60) < 1e-9, String(ws.simDt));
  ws.resetPerf();
  check('worldStep.simDt：resetPerf（每幀開頭）歸零 → 暫停 / 面板開啟時天氣不推進', ws.simDt === 0);
}

console.log(`${failed ? 'FAIL' : 'PASS'} ${failed ? failed : passed}/${passed + failed}`);
process.exit(failed ? 1 : 0);
