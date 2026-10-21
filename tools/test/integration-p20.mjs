#!/usr/bin/env node
// P20 整合驗證：故事任務線第一章接線（main.js 原始碼字串比對 + 抽出故事任務段以替身執行；不 import three / rapier）
// 用法：node tools/test/integration-p20.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：import、建立（story / storyTraitors / storyGangs / storyWorld / storyHud / storyBeacons / storyCars）、每幀 updateStory（updateSnatch 之後、Enter 跳過）、
//   互動（步行 / 駕駛 storyInteractable 另起一行）、互斥（state.story getter + 包裝 state.racing / vigHooks.active / end、nearestInteractable 另起一行）、
//   collectMarkers、存檔 / 讀檔、startGame / quitToMenu → cancelStory、window.__game；marker-colors / hud / big-map / light-pillar / style.css / gangs / save.js；
//   interfaces.md §42 與事件表；行為（抽段 + 替身）：互斥 getter、BUSTED 經 vigHooks.end 失敗、提示覆蓋、凍結、S 光柱只在可接時 1 根、cancel
// 注意：staging 無 node_modules；main.js 依賴 three，一律原始碼字串比對 / 抽段執行
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBus } from '../../src/core/events.js';
import { MARKER_COLORS } from '../../src/map/marker-colors.js';
import { createStory, createStoryHud, createStoryCarDepot, CONTACT, STORY_BEACON, PROMPT_NEXT, VAN_TYPE, VAN_COLOR } from '../../src/missions/story.js';
import { createFugitiveWorld } from '../../src/missions/vigilante.js';
import { createRampageWorld } from '../../src/missions/rampage.js';

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
  ['import：missions/story.js', [/import \{ createStory, createStoryHud, createStoryCarDepot, CONTACT as STORY_CONTACT, STORY_BEACON, STORY_SKIP_KEY,[^\n]*\} from '\.\/missions\/story\.js';/]],
  ['建立：story / storyTraitors / storyGangs / storyWorld / storyHud / storyBeacons / storyCars', [
    'const story = createStory({ bus, rng: Math.random, gangOf: (a) => gangs.gangOf(a) });',
    'const storyTraitors = createFugitiveWorld({',
    'const storyGangs = createRampageWorld({',
    'const storyWorld = {',
    'const storyHud = createStoryHud({ root: document.body, isTouch: touch });',
    'const storyBeacons = createBeaconPool({ scene, heightAt, ...STORY_BEACON });',
    'const storyCars = createStoryCarDepot({ vehicles, dmg, isBusy: (v) => v === state.vehicle || v === cj.vehicle });',
  ]],
  ['互斥：state.story getter + 包裝 state.racing getter', [
    "Object.defineProperty(state, 'story', { get: () => story.active, enumerable: true, configurable: true });",
    "const racingGetStory = Object.getOwnPropertyDescriptor(state, 'racing').get;",
    "Object.defineProperty(state, 'racing', { get: () => racingGetStory() || story.active, enumerable: true, configurable: true });",
  ]],
  ['互斥：vigHooks.active / end 包裝', ['vigHooks.active = () => vigActiveStory() || story.active;', 'story.end(kind);']],
  ['互斥：接任務條件含其他任務 / 警車 / 暴走 / 特技 / 消防 / 重生 / 噴漆', ['const storyBusy = () => otherMissionBusy() || vigilante.active || rampage.active || stunts.active || firefighter.active || !!state.respawn || !!state.spraying;']],
  ['互斥：nearestInteractable 故事任務中不接委託（另起一行）', ['    if (state.story) interCands[0] = null; // 故事任務（P20）進行中不接委託\n']],
  ['每幀：updateStory 接在 updateSnatch 之後、Enter 整段跳過', [/updateSnatch\(dt, phoneOpen \|\| !!state\.respawn\);[^\n]*\n\s*updateStory\(dt, phoneOpen, input\.wasPressed\(STORY_SKIP_KEY\)\);/]],
  ['互動：步行 nearestInteractable 之後另起一行 storyInteractable', [/inter = free \? nearestInteractable\(player\.pos, true\) : null;\n\s*inter = storyInteractable\(inter, free\);/]],
  ['互動：駕駛後備鏈 firefighterInteractable 之後另起一行 storyInteractable', [/if \(!inter\) inter = firefighterInteractable\(v\);[^\n]*\n\s*inter = storyInteractable\(inter, true\);/]],
  ['標記：collectMarkers 併入 storyMarkers()', [/pushAll\(out, fireMarkers\(\)\);[^\n]*\n\s*pushAll\(out, storyMarkers\(\)\);/]],
  ['存檔：story.serialize', ['story: story.serialize(),']],
  ['讀檔：snatch.restore 後 story.restore + storyCars.ensure', [/snatch\.restore\(save\.stats\);[^\n]*\n\s*story\.restore\(save\.story\);[^\n]*\n\s*storyCars\.ensure\(true, null, story\.unlocked\);/]],
  ['章節獎勵存檔：ctx.save = autosave.flush(\'story\')、入帳 reason story', ["save: () => autosave.flush('story'),", "earn: (n) => economy.add(n, 'story'),"]],
  ['window.__game：story / storyWorld / storyHud / storyCars / storyBeacons', ['story, storyWorld, storyHud, storyCars, storyBeacons,']],
  ['檔頭說明 P20', ['// 故事任務線第一章「七期夜雨」（P20，Story）']],
  ['S2 撞停後須 KO：eject 重設起身旗標、isDown 需起身後再倒地', ['let storyTraitorUp = false;', 'storyTraitorUp = false;\n', 'return down && storyTraitorUp;']],
  ['S3 擊倒只算本任務徵用者：storyWorld.isEnlisted = storyGangs.enlisted', ['isEnlisted: (a) => storyGangs.enlisted.includes(a),']],
  ['既有鎖字面的行未改寫（interCands 遮罩 / 消防互斥 / 暴走遮罩）', [
    'const interCands = [null, null, null, null, null, null];',
    '    if (state.firefighter) interCands[0] = null; // 消防車任務（P18）出勤中不接委託\n',
    '    if (state.rampage) interCands[0] = interCands[4] = interCands[5] = null;',
    "const otherMissionBusy = () => !!(state.sideJob || missions.active() || missions.eventActive() || missions.jobActive() || robberies.active || state.spraying || state.racing);",
  ]],
];
for (const [name, list] of GROUPS_STATIC) {
  const miss = missing(mainSrc, list);
  check(name, miss.length === 0, miss.map(String).join(' | '));
}
check('registerTouchButton 數量不變（3，P20 不新增觸控鈕）', (mainSrc.match(/registerTouchButton\(/g) || []).length === 3);

const fnBody = (name) => {
  const i = mainSrc.indexOf(`const ${name} = (`);
  if (i < 0) return '';
  const j = mainSrc.indexOf('\n  };\n', i);
  return mainSrc.slice(i, j);
};
for (const fn of ['startGame', 'quitToMenu']) {
  const b = fnBody(fn);
  const s = b.indexOf('cancelStunts();');
  const c = b.indexOf('cancelStory();');
  const p = b.indexOf('cancelPackages();');
  check(`${fn}：cancelStory() 一次、接在 cancelStunts() 之後、cancelPackages() 之前`, s > 0 && c > s && p > c && b.indexOf('cancelStory();', c + 1) < 0);
}
{
  const ni = fnBody('nearestInteractable');
  check('nearestInteractable：state.story 清掉委託候選（pickInteractable 之前）', ni.indexOf('if (state.story) interCands[0] = null;') > 0 && ni.indexOf('state.story') < ni.indexOf('return pickInteractable('));
  const ug = fnBody('updateGame');
  check('updateStory 在 updateGame 內、時間縮放之後', ug.indexOf('updateStory(') > ug.indexOf('dt *= stunts.timeScale;') && ug.indexOf('dt *= stunts.timeScale;') > 0);
}

const SEC_START = '// ---------- P20 故事任務線第一章「七期夜雨」';
const section = (() => {
  const i = mainSrc.indexOf(SEC_START);
  const j = mainSrc.indexOf('\n  // ---------- ', i + 1);
  return i > 0 && j > i ? mainSrc.slice(i, j) : '';
})();
check('抽出故事任務段（飛車搶包段之後、畫質段之前）', section.length > 2000 && mainSrc.indexOf('const cancelSnatch = () => {') < mainSrc.indexOf(SEC_START) && mainSrc.indexOf('// ---------- 畫質 / 設定') > mainSrc.indexOf(SEC_START));
check('故事任務段不新增光源 / 貼圖 / 陰影 / 網格', !/Light\(|Texture|castShadow|shadowMap|new THREE\.|Mesh\(/.test(section));
check('故事任務段：draw call 增量 = S 小光柱 1 根（2 mesh）', (section.match(/createBeaconPool\(/g) || []).length === 1 && (section.match(/\.acquire\(/g) || []).length === 1);
check('故事任務段未引用 postfx / neon / helicopter', !/postfx|neon|helicopter/i.test(section));

// ---------- 其他檔案（原始碼）----------
{
  check('marker-colors.js：story 色碼、全表不重複', /^#[0-9a-f]{6}$/i.test(MARKER_COLORS.story || '') && new Set(Object.values(MARKER_COLORS)).size === Object.keys(MARKER_COLORS).length);
  const hudSrc = read('src/hud.js');
  check('hud.js：ICON_KINDS.story = \'S\'（另起一行，原字面不動）', hudSrc.includes("ICON_KINDS.story = 'S';") && hudSrc.includes("const ICON_KINDS = { store: '超', 'gun-shop': '槍', safehouse: '家' };"));
  check('hud.js：story 不貼邊（EDGE_KINDS 不含）、mission-dest 仍貼邊', !/const EDGE_KINDS = new Set\(\[[^\]]*'story'/.test(hudSrc) && /const EDGE_KINDS = new Set\(\[[^\]]*'mission-dest'/.test(hudSrc));
  const bm = read('src/map/big-map.js');
  check('big-map.js：MARKER_LABELS story 圖例、mission-dest 仍是圖釘', bm.includes("story: '故事任務（阿海）'") && bm.includes("export const PIN_KINDS = new Set(['dest', 'mission-dest', 'job-dest', 'event-dest']);"));
  const lp = read('src/missions/light-pillar.js');
  check('light-pillar.js：BEACON_COLORS.story（另起一行，原字面不動）', /\nBEACON_COLORS\.story = 0x[0-9a-f]{6};/.test(lp) && /safehouse: 0x1e88e5, fire: 0x[0-9a-f]{6} \}/.test(lp));
  const css = read('src/style.css');
  check('style.css：.story-bar / .story-dialog（pointer-events none、[hidden]、urgent）', /\.story-bar \{[^}]*pointer-events: none;/.test(css) && /\.story-dialog \{[^}]*pointer-events: none;/.test(css) && css.includes('.story-dialog[hidden]') && css.includes('.story-bar.story-urgent'));
  const gs = read('src/gangs.js');
  check('gangs.js：provokeGang 公開入口（檔頭有說明）', gs.includes("provokeGang(id, cause = 'story', gain = C.attackGain) {") && gs.slice(0, 8000).includes('provokeGang(id, cause?, gain?)'));
  const save = read('src/save.js');
  check('save.js：story 選填欄位（不升版）', save.includes('function storyRecord(src)') && save.includes('if (sy) out.story = sy;') && /export const SAVE_VERSION = 2;/.test(save));
  const st = read('src/missions/story.js');
  check('story.js 不 import three / rapier', !/^import[^\n]*from '(three|@dimforge\/rapier3d-compat)'/m.test(st));
}
{
  const doc = read('docs/dev/interfaces.md');
  const sec = doc.slice(doc.indexOf('## 42. P20 故事任務線'), doc.indexOf('## 附錄 B'));
  check('interfaces.md §42 新節（介面 / 事件 / 接線 / 回歸）', sec.length > 2000 && ['### 42.1', '### 42.2', '### 42.3', '### 42.4', '### 42.5', 'createStory(', 'storyInteractable', 'state.story', 'p20-story.mjs', 'integration-p20.mjs'].every((k) => sec.includes(k)));
  const table = doc.slice(0, doc.indexOf('表外的新事件名稱必須先加進本表'));
  check('interfaces.md §1 事件表含 story:start / stage / complete / fail / chapter', ['story:start', 'story:stage', 'story:complete', 'story:fail', 'story:chapter'].every((n) => table.includes(`| \`${n}\` |`)));
}

// ---------- 行為（抽段 + 替身）----------
{
  const bus = createBus();
  const list = [];
  const vehicles = {
    vehicles: list,
    adopt({ type, color, x, z, yaw }) {
      const v = { type, color, pos: { x, y: 0, z }, yaw, speed: 0, driven: false, spec: { length: 4.9, width: 2, maxSpeed: 39 }, setControls() {}, isOverturned: () => false };
      list.push(v);
      return v;
    },
    remove(v) {
      const i = list.indexOf(v);
      if (i >= 0) list.splice(i, 1);
    },
  };
  const health = new Map();
  const dmg = {
    attach: (v) => health.set(v, 1000),
    detach: (v) => health.delete(v),
    healthOf: (v) => (health.has(v) ? health.get(v) : null),
    maxHealthOf: (v) => (health.has(v) ? 1000 : null),
  };
  const traffic = { cars: [], peds: [], spawnSpots: (px, pz, a, b, out) => { out.length = 0; out.push({ x: px + 30, z: pz, heading: 0 }); return out; }, spawnEjectedDriver: () => null, _gangWeapon() {} };
  const gangs = { gangOf: () => null, enlist: () => [], release: () => [], members: [], provokeGang: () => true };
  const combat = { isDown: () => false, stateOf: () => 'normal' };
  const player = { pos: { x: CONTACT.x, y: 0, z: CONTACT.z }, actor: { hp: 100 } };
  let racing = false;
  const state = { mode: 'walk', vehicle: null, respawn: null, spraying: false, koTimer: 0 };
  Object.defineProperty(state, 'racing', { get: () => racing, enumerable: true, configurable: true });
  const ended = [];
  const vigHooks = { fugitiveActor: () => false, fugitiveShot: () => false, end: (k) => ended.push(k), active: () => false };
  const beacons = { live: [], acquire(kind, x, z) { const b = { kind, x, z }; this.live.push(b); return b; }, release(b) { this.live.splice(this.live.indexOf(b), 1); }, update() {} };
  const toasts = [];
  const earned = [];
  let flushed = 0;
  let busy = false;
  const env = {
    createStory, createStoryHud: () => createStoryHud({ root: null, doc: null }), createStoryCarDepot, createFugitiveWorld, createRampageWorld,
    bus, gangs, vehicles, dmg, traffic, findRoute: () => null, graph: null, player, state, cj: { vehicle: null }, adopted: new Set(), combat,
    repaintCharacter() {}, STORY_VAN_TYPE: VAN_TYPE, STORY_VAN_COLOR: VAN_COLOR, touch: false,
    createBeaconPool: () => beacons, scene: null, heightAt: () => 0, STORY_BEACON, STORY_CONTACT: CONTACT,
    vigHooks, otherMissionBusy: () => busy, vigilante: { active: false }, rampage: { active: false }, stunts: { active: false }, firefighter: { active: false },
    economy: { add: (n, r) => earned.push({ n, r }) }, hud: { toast: (t) => toasts.push(t) }, autosave: { flush: () => flushed++ },
    document: { body: null }, SNATCH_PRIORITY: 5, playerPos: () => (state.mode === 'drive' && state.vehicle ? state.vehicle.pos : player.pos), wanted: { stars: 0 },
  };
  const names = Object.keys(env);
  let api = null;
  try {
    // eslint-disable-next-line no-new-func
    api = new Function(...names, `${section}\nreturn { story, storyWorld, storyInteractable, updateStory, cancelStory, storyMarkers, storyCars, storyBeacons };`)(...names.map((k) => env[k]));
  } catch (e) {
    check('抽段可執行', false, e.message);
  }
  if (api) {
    check('抽段可執行', true);
    const { story, storyInteractable, updateStory, cancelStory, storyMarkers } = api;
    updateStory(0.016, false, false);
    check('可接任務時 S 小光柱 1 根（story 色）、標記 story', beacons.live.length === 1 && beacons.live[0].kind === 'story' && storyMarkers().some((m) => m.kind === 'story'));
    const passthru = { text: '委託', act() {} };
    const i1 = storyInteractable(passthru, true);
    check('站在 S 上：提示覆蓋為接受故事任務', i1 && i1 !== passthru && /接受故事任務/.test(i1.text));
    busy = true;
    updateStory(0.016, false, false);
    check('其他任務進行中：不覆蓋提示（互斥）', storyInteractable(passthru, true) === passthru);
    busy = false;
    updateStory(0.016, false, false);
    check('步行受控（free = false）時原樣回傳', storyInteractable(passthru, false) === passthru);
    storyInteractable(null, true).act();
    check('按 E → 開場對白、state.story / state.racing 為真、vigHooks.active 為真', story.phase === 'intro' && state.story === true && state.racing === true && vigHooks.active() === true);
    check('對白中提示 = 下一句', storyInteractable(passthru, true).text === PROMPT_NEXT);
    updateStory(0.016, false, true);
    check('Enter（skipPressed）→ 跳過對白、任務開始、貨車生成（suv、dmg.attach）', story.phase === 'run' && list.length === 1 && list[0].type === VAN_TYPE && health.get(list[0]) === 1000 && list[0].storyVan);
    check('任務中 S 光柱收起', beacons.live.length === 0);
    const t0 = story.elapsed;
    updateStory(1, true, false);
    check('手機開著（skip）→ 凍結不計時', story.elapsed === t0);
    state.respawn = 'busted';
    updateStory(0.05, false, false);
    check('BUSTED 畫面中 → 凍結', story.elapsed === t0);
    vigHooks.end('busted');
    check('vigHooks.end(busted) → 故事任務失敗、原 end 仍呼叫', story.phase === 'idle' && ended.includes('busted') && state.story === false && state.racing === false);
    state.respawn = null;
    updateStory(0.016, false, false);
    check('失敗後 S 光柱回來（可重試）', beacons.live.length === 1);
    storyInteractable(null, true).act();
    updateStory(0.016, false, true);
    cancelStory();
    check('cancelStory → idle、無 toast 新增「失敗」', story.phase === 'idle' && !toasts.some((t) => t.includes('取消')));
    const sv = api.storyWorld.vanState(list[0]);
    const sv2 = api.storyWorld.vanState(list[0]);
    check('storyWorld.vanState 重用物件、回傳耐久比例', sv === sv2 && sv.exists && sv.health === 1);
    check('storyWorld.state 重用物件', api.storyWorld.state(null) === api.storyWorld.state(null) && api.storyWorld.state(null).exists === false);
    // S2 撞停 → 叛徒下車：下車摔倒（combat knockdown）不算 KO，起身後再被打倒才算
    const sw = api.storyWorld;
    const traitorActor = { id: 'traitor', hp: 100, pos: { x: 1, y: 0, z: 2 } };
    traffic.spawnEjectedDriver = () => ({ actor: traitorActor });
    const downSet = new Set([traitorActor]);
    combat.isDown = (a) => downSet.has(a);
    const h = sw.spawn({ x: 0, z: 0, heading: 0 });
    const ej = h ? sw.eject(h) : null;
    check('storyWorld.eject → 叛徒 actor（下車逃跑）', ej === traitorActor);
    check('storyWorld.isDown：下車摔倒中 → false（不自動完成）', sw.isDown(traitorActor) === false && sw.isDown(traitorActor) === false);
    downSet.delete(traitorActor);
    check('storyWorld.isDown：起身 → false', sw.isDown(traitorActor) === false);
    downSet.add(traitorActor);
    check('storyWorld.isDown：起身後被 KO → true', sw.isDown(traitorActor) === true);
    traitorActor.hp = 0;
    check('storyWorld.isDown：hp 歸零 → true', sw.isDown(traitorActor) === true);
    const ej2 = sw.eject(sw.spawn({ x: 0, z: 0, heading: 0 }));
    traitorActor.hp = 100;
    check('storyWorld.eject 再次下車 → 起身旗標重設', ej2 === traitorActor && sw.isDown(traitorActor) === false);
    combat.isDown = () => false;
    // 抽段整合：新 story 實例 + 抽段 storyWorld 跑 S2——撞停後叛徒躺著不起身 → 不完成；起身後被玩家 KO（ped:knockdown byPlayer）才完成
    {
      const bus2 = createBus();
      const st2 = createStory({ bus: bus2, rng: () => 0.5, gangOf: () => null });
      st2.restore({ chapter: 1, done: ['s1-delivery'], unlocked: false });
      const got = [];
      const ctx = { player: { x: CONTACT.x, z: CONTACT.z }, onFoot: true, vehicle: null, topSpeed: 42, wantedStars: 0, busy: false, frozen: false, world: sw, earn: (n) => got.push(n), toast() {} };
      st2.update(0.016, ctx);
      st2.interact(ctx);
      st2.skip();
      st2.update(0.6, ctx);
      const tv = list[list.length - 1];
      check('抽段 S2：叛徒車由 storyWorld 生成 → chase', st2.stage === 'chase' && !!tv && !!st2.traitor);
      ctx.player.x = tv.pos.x + 5;
      ctx.player.z = tv.pos.z;
      health.set(tv, 0);
      traitorActor.pos.x = tv.pos.x + 2; // 叛徒在車門外
      traitorActor.pos.z = tv.pos.z;
      combat.isDown = (a) => a === traitorActor; // 下車摔倒、一直躺著
      for (let k = 0; k < 40; k++) st2.update(0.05, ctx);
      check('抽段 S2：撞停後叛徒未起身 → 停在 ko、不自動完成、不入帳', st2.stage === 'ko' && st2.traitorActor === traitorActor && got.length === 0 && !st2.done.includes('s2-debt'));
      combat.isDown = () => false; // 起身逃跑
      st2.update(0.05, ctx);
      bus2.emit('ped:knockdown', { ped: traitorActor, byPlayer: false });
      st2.update(0.05, ctx);
      check('抽段 S2：叛徒起身後被非玩家打倒 → 仍未完成', st2.stage === 'ko' && got.length === 0);
      bus2.emit('ped:knockdown', { ped: traitorActor, byPlayer: true, cause: 'punch' });
      st2.update(0.05, ctx);
      check('抽段 S2：玩家 KO 叛徒 → 完成、NT$2500', st2.done.includes('s2-debt') && got[0] === 2500);
      st2.dispose();
    }
    // S3：isEnlisted 只認徵用名單
    const native = { id: 'native' };
    check('storyWorld.isEnlisted：非徵用 → false', sw.isEnlisted(native) === false);
    const recruitActor = { id: 'recruit', hp: 100, pos: { x: 25, y: 0, z: 0 } };
    traffic.peds.push({ alive: true, actor: recruitActor, brain: { state: 'wander', override: null }, citizen: { gang: null }, state: 'walk', x: 25, z: 0 });
    gangs.enlist = (picked) => picked.map((p) => p.actor);
    const nGot = sw.spawnGang('nightmarket', 0, 0, 1);
    check('storyWorld.isEnlisted：spawnGang 徵用者 → true；releaseGang 後 → false', nGot === 1 && sw.isEnlisted(recruitActor) === true && (sw.releaseGang(), sw.isEnlisted(recruitActor) === false));
  }
}

console.log(`${failed ? 'FAIL' : 'PASS'} ${failed ? failed : passed}/${passed + failed}`);
process.exit(failed ? 1 : 0);
