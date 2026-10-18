#!/usr/bin/env node
// Phase 9 整合驗證：超商搶劫接線（main.js 原始碼字串比對 + 抽出超商段以替身執行；不 import three / rapier）
// 用法：node tools/test/integration-p9.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：import（robbery.js / places.js STORES / npc-bodies createPedestrianBody）、常數集中檔頭、建立 robberies / 小光柱池 / 標記、
//   每幀 updateRobberies 接在 updateSprayShops 之後、quitToMenu / startGame 先 cancelRobbery（在 cancelSpray / cancelRespawn 之前）、
//   aiming / aimAt 取 fillAim 的 aim、earn = economy.add、提示走 wantedUI.showHint（HUD 注入）、window.__game.robberies；
//   行為（抽段 + 替身）：店員依距離生成 / 回收、光柱只在可搶時、瞄準 → 搶劫 → 入帳、BUSTED / 噴漆 / 手機中凍結、店員倒地、cancelRobbery
//   hud.js setRobberyProgress / 小地圖 store 圖示、style.css .rob-、marker-colors / big-map / light-pillar、interfaces.md §28 與事件表
// 注意：staging 無 node_modules；hud.js / big-map.js / light-pillar.js / main.js 依賴 three / css / JSON import，一律原始碼字串比對
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBus } from '../../src/core/events.js';
import { createWanted } from '../../src/wanted/wanted.js';
import { STORES } from '../../src/wanted/places.js';
import { createRobberies, aimNear, AIM_HEIGHT, PROGRESS_LABEL, ROB_SEC, COOLDOWN_SEC } from '../../src/wanted/robbery.js';
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
  ['import：robbery.js / places.js STORES / createPedestrianBody', [
    "import { STORES } from './wanted/places.js';",
    "import { createRobberies, aimNear, AIM_HEIGHT, PROGRESS_LABEL } from './wanted/robbery.js';",
    /import \{ ACTIVE_RADIUS, createPedestrianBody \} from '\.\/physics\/npc-bodies\.js';/,
  ]],
  ['常數集中檔頭（店員生成 / 回收距離、制服色、小光柱尺寸）', [
    /^const CLERK_SPAWN_DIST = \d+;/m,
    /^const CLERK_DESPAWN_DIST = \d+;/m,
    /^const CLERK_COLORS = \{ shirt: '#[0-9A-Fa-f]{6}', pants: '#[0-9A-Fa-f]{6}' \};/m,
    /^const CLERK_HP = \d+;/m,
    /^const STORE_BEACON = \{ height: [\d.]+, radius: [\d.]+, sink: [\d.]+ \};/m,
  ]],
  ['建立 robberies / 小光柱池 / 標記', [
    'createRobberies({ bus, wanted, police, stores: STORES, rng: Math.random })',
    "STORES.map((s) => ({ x: s.x, z: s.z, kind: 'store' }))",
    'createBeaconPool({ scene, heightAt, ...STORE_BEACON })',
    "storeBeacons.acquire('store', s.x, s.z, s)",
    'storeBeacons.release(b)',
  ]],
  ['小地圖 / 大地圖標記併入 collectMarkers', ['pushAll(out, robberyMarkers)']],
  ['每幀：updateRobberies 緊接 updateSprayShops（手機開著傳 skip）', [/if \(!phoneOpen\) updateSprayShops\(dt\);\s*\n\s*updateRobberies\(dt, phoneOpen\);/]],
  ['凍結條件：手機 / BUSTED・WASTED / 噴漆中', ['const frozen = skip || !!state.respawn || !!state.spraying;']],
  ['ctx：aiming / aimAt 取 fillAim 的 aim、earn = economy.add、步行判定', [
    "robCtx.onFoot = state.mode === 'walk' && !(state.koTimer > 0 || state.respawn || combat.isDown(player.actor) || vigilante.active);",
    'robCtx.aiming = robCtx.onFoot && aim.aiming;',
    'aimAt: (x, z) => aimNear(aim.origin, aim.dir, x, heightAt(x, z) + AIM_HEIGHT, z)',
    "earn: (n) => economy.add(n, 'robbery')",
    "showHint: (id, text) => !!settings.get('showHints') && wantedUI.showHint(id, text)",
  ]],
  ['店員：pedestrian 角色換色 + combat actor（clerkOf）+ 行人剛體', [
    "createCharacter({ variant: 'pedestrian', colors: CLERK_COLORS })",
    'clerkOf: s.id',
    'createPedestrianBody(RAPIER, pw, { x, y: c.pos.y, z, yaw }, { groups: GROUPS, router })',
    'c.body.owner = c;',
    'combat.register(c.actor);',
    'combat.unregister(c.actor);',
    'disposeCharacter(c.character);',
  ]],
  ['進度條：hud.setRobberyProgress', ['hud.setRobberyProgress(r.progress, PROGRESS_LABEL)', 'hud.setRobberyProgress(null)']],
  ['除錯物件：window.__game.robberies', ['robberies, clerks,']],
];
for (const [name, list] of GROUPS) {
  const bad = missing(mainSrc, list);
  check(`main.js 接線：${name}`, bad.length === 0, bad.map((b) => (b instanceof RegExp ? b.source : b)).join(' | '));
}
{
  const ug = mainSrc.slice(mainSrc.indexOf('const updateGame = (dt) =>'), mainSrc.indexOf('// 開始畫面 / 回到主選單'));
  const iAim = ug.indexOf("if (state.mode === 'walk') handleWeaponInput(snap);");
  const iRob = ug.indexOf('updateRobberies(dt, phoneOpen);');
  const iPanel = ug.indexOf('if (syncPanels()) return;');
  check('updateGame：updateRobberies 在 syncPanels 早退與 handleWeaponInput（fillAim）之後', iPanel >= 0 && iAim > iPanel && iRob > iAim, `panel@${iPanel} aim@${iAim} rob@${iRob}`);
  const fnBody = (name) => (mainSrc.match(new RegExp(`const ${name} = \\([^)]*\\) => \\{([\\s\\S]*?)\\n {2}\\};`)) || [])[1] || '';
  for (const name of ['quitToMenu', 'startGame']) {
    const body = fnBody(name);
    const iC = body.search(/cancelRobbery\((!continued)?\);/);
    const iS = body.indexOf('cancelSpray();');
    const iR = body.indexOf('cancelRespawn();');
    check(`${name}：cancelRobbery() 在 cancelSpray / cancelRespawn 之前`, iC >= 0 && iS > iC && iR > iS, `rob@${iC} spray@${iS} respawn@${iR}`);
  }
}

// ---------- 行為：抽出 main.js 超商段，以替身執行 ----------
const SLICE_START = '  // ---------- 超商搶劫（Phase 9';
const SLICE_END = '  // ---------- 車流 / 行人外部狀態 ----------';
const slice = mainSrc.slice(mainSrc.indexOf(SLICE_START), mainSrc.indexOf(SLICE_END));
const CONST_NAMES = ['CLERK_SPAWN_DIST', 'CLERK_DESPAWN_DIST', 'CLERK_COLORS', 'CLERK_HP', 'STORE_BEACON'];
const consts = CONST_NAMES.map((n) => (mainSrc.match(new RegExp(`^const ${n} = .*$`, 'm')) || [''])[0]).join('\n');
check('取出 main.js 超商段與常數', slice.length > 2000 && consts.split('\n').every(Boolean));

const vec3 = () => ({ x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } });
function makeWorld() {
  const bus = createBus();
  const log = [];
  for (const n of ['robbery:start', 'robbery:done', 'robbery:failed']) bus.on(n, (e) => log.push([n, e]));
  const wanted = createWanted({ bus });
  const scene = { added: [], add(m) { this.added.push(m); } };
  const beacons = { live: [], acquired: 0, released: 0, opts: null };
  const createBeaconPool = (opts) => {
    beacons.opts = opts;
    return {
      acquire: (kind, x, z, owner) => {
        const b = { kind, x, z, owner };
        beacons.live.push(b);
        beacons.acquired++;
        return b;
      },
      release: (b) => {
        beacons.live.splice(beacons.live.indexOf(b), 1);
        beacons.released++;
      },
      update() {},
    };
  };
  const combat = {
    entries: new Map(),
    register(a) { this.entries.set(a.id, { a, state: 'normal' }); },
    unregister(a) { this.entries.delete(a.id); },
    stateOf(a) { return this.entries.get(a.id)?.state ?? null; },
    isDown(a) { const s = this.stateOf(a); return s === 'knockdown' || s === 'getup' || s === 'dead'; },
  };
  const disposed = [];
  const bodies = [];
  const toasts = [];
  const bars = [];
  const money = { total: 0, reasons: [] };
  const aim = { origin: { x: 0, y: 1.6, z: 0 }, dir: { x: 0, y: 0, z: 1 }, aiming: false };
  const shop = STORES[0];
  const p = { x: shop.x, z: shop.z };
  const deps = {
    bus,
    wanted,
    police: null,
    STORES,
    createRobberies,
    createBeaconPool,
    scene,
    heightAt: () => 0,
    pw: { onAfterStep() {} },
    SURFACE_OFFSET: 0,
    createCharacter: ({ variant, colors }) => ({ variant, colors, root: { position: vec3(), rotation: { order: '', set() {} } } }),
    CharacterAnimator: function CharacterAnimator() { this.update = () => {}; },
    getCharacterManifest: () => ({ clips: [] }),
    createPedestrianBody: () => {
      const b = { down: false, disposed: false, poses: 0, setPose() { b.poses++; }, dispose() { b.disposed = true; }, hit() { b.down = true; }, recover: () => null, centerY: 0.9, body: { translation: () => ({ x: 0, y: 0.9, z: 0 }) } };
      bodies.push(b);
      return b;
    },
    RAPIER: {},
    GROUPS: {},
    router: {},
    combat,
    disposeCharacter: (c) => disposed.push(c),
    state: { started: true, mode: 'walk', respawn: null, spraying: null },
    aimNear,
    aim,
    AIM_HEIGHT,
    economy: { add: (n, reason) => { money.total += n; money.reasons.push(reason); } },
    hud: { toast: (t) => toasts.push(t), setRobberyProgress: (f, label) => bars.push([f, label]) },
    settings: { get: () => true },
    wantedUI: { showHint: () => true },
    PROGRESS_LABEL,
    playerPos: () => p,
    player: { yaw: 0, actor: { id: 'player' } },
    vigilante: { active: false },
  };
  const names = Object.keys(deps);
  const body = `${consts}\n${slice}\nreturn { robberies, clerks, updateRobberies, cancelRobbery, storeBeaconOf };`;
  const api = new Function(...names, body)(...names.map((n) => deps[n]));
  // 讓準星對準某店店員胸口：玩家站 (px, pz)，鏡頭 1.6 m 高、朝店員方向
  const aimAtStore = (s, px, pz) => {
    p.x = px;
    p.z = pz;
    aim.origin = { x: px, y: 1.6, z: pz };
    const dx = s.counterX - px;
    const dy = AIM_HEIGHT - 1.6;
    const dz = s.counterZ - pz;
    const L = Math.hypot(dx, dy, dz) || 1;
    aim.dir = { x: dx / L, y: dy / L, z: dz / L };
    aim.aiming = true;
  };
  return { ...api, deps, bus, log, wanted, scene, beacons, combat, disposed, bodies, toasts, bars, money, aim, p, aimAtStore };
}
const run = (w, sec, dt = 1 / 30, skip = false) => {
  for (let t = 0; t < sec - 1e-9; t += dt) w.updateRobberies(dt, skip);
};

{
  const w = makeWorld();
  check('小光柱池：以 STORE_BEACON 尺寸建立', w.beacons.opts && w.beacons.opts.height < 20 && w.beacons.opts.radius < 2);
  const s = STORES[0];
  w.p.x = s.x;
  w.p.z = s.z + 200; // 先在店員生成距離外
  w.updateRobberies(1 / 30, false);
  check('首幀：每間可搶的店各 1 根綠色小光柱（kind store）', w.beacons.live.length === STORES.length && w.beacons.live.every((b) => b.kind === 'store'));
  check('玩家距櫃檯 > 生成距離：不生成店員', w.clerks.size === 0);
  w.p.z = s.z;
  w.updateRobberies(1 / 30, false);
  const c = w.clerks.get(s.id);
  check('靠近：該店生成店員（綠制服 pedestrian、actor clerkOf / faction clerk、已 register）', !!c && c.character.variant === 'pedestrian' && c.character.colors.shirt && c.actor.clerkOf === s.id && c.actor.faction === 'clerk' && w.combat.entries.has(c.actor.id));
  check('店員站在櫃檯點、面向門口', c.pos.x === s.counterX && c.pos.z === s.counterZ && c.yaw === s.clerkYaw);
  check('其他店（遠處）不生成店員', w.clerks.size === 1);

  // 瞄準 → 搶劫 → 進度條 → 入帳
  w.aimAtStore(s, s.x, s.z);
  w.updateRobberies(1 / 30, false);
  check('步行持槍瞄準店員 → 開始搶劫、≥ 2 星', w.robberies.active === s.id && w.wanted.stars >= 2);
  check(`進度條顯示「${PROGRESS_LABEL}」`, w.bars.length > 0 && w.bars.at(-1)[1] === PROGRESS_LABEL && w.bars.at(-1)[0] >= 0);
  run(w, ROB_SEC + 0.1);
  check("搶完：economy.add(300–800, 'robbery')、robbery:done、toast", w.money.total >= 300 && w.money.total <= 800 && w.money.reasons.join() === 'robbery' && w.log.some((e) => e[0] === 'robbery:done') && w.toasts.some((t) => t.startsWith('搶到 NT$')));
  check('搶完：進度條收起（setRobberyProgress(null)）', w.bars.at(-1)[0] === null);
  check('搶完：店員消失（回收、unregister、剛體 dispose）、該店光柱收起', !w.clerks.has(s.id) && w.disposed.length === 1 && w.bodies[0].disposed && !w.storeBeaconOf.has(s.id) && w.beacons.live.length === STORES.length - 1);
  run(w, 5);
  check('冷卻中（持續瞄準）：不重新生成店員、不再開始', !w.clerks.has(s.id) && w.robberies.active === null);
  w.aim.aiming = false;
  run(w, COOLDOWN_SEC, 0.1);
  check('冷卻結束：光柱與店員恢復', w.storeBeaconOf.has(s.id) && w.clerks.has(s.id));
  w.aim.aiming = true;
  w.updateRobberies(1 / 30, false);
  w.updateRobberies(1 / 30, false); // 光柱依上一幀狀態同步（晚 1 幀收起）
  check('再次瞄準 → 搶劫中光柱收起、店員保留', w.robberies.active === s.id && !w.storeBeaconOf.has(s.id) && w.clerks.has(s.id));
}
{
  // 互斥（P11）：警車任務進行中下車瞄準店員 → 不開始搶劫；任務結束後照常
  const w = makeWorld();
  const s = STORES[0];
  w.deps.vigilante.active = true;
  w.aimAtStore(s, s.x, s.z);
  run(w, 1);
  const blocked = w.robberies.active === null && w.wanted.stars === 0;
  w.deps.vigilante.active = false;
  w.updateRobberies(1 / 30, false);
  check('警車任務進行中：瞄準店員不開始搶劫；結束後照常開始', blocked && w.robberies.active === s.id);
}
{
  // 凍結：手機（skip）/ BUSTED・WASTED / 噴漆中 → 不推進、進度條收起
  const w = makeWorld();
  const s = STORES[0];
  w.aimAtStore(s, s.x, s.z);
  w.updateRobberies(1 / 30, false);
  run(w, 2);
  const prog = () => w.robberies.stores.find((x) => x.id === s.id).robT;
  const before = prog();
  run(w, 3, 1 / 30, true);
  check('手機開著（skip）：進度不推進、進度條收起', prog() === before && w.bars.at(-1)[0] === null);
  w.deps.state.respawn = 'busted';
  run(w, 3);
  check('BUSTED / WASTED 畫面中：不推進', prog() === before && w.robberies.active === s.id);
  w.deps.state.respawn = null;
  w.deps.state.spraying = 'spray-x';
  run(w, 3);
  check('噴漆中：不推進', prog() === before);
  w.deps.state.spraying = null;
  w.updateRobberies(1 / 30, false);
  check('恢復後接續推進', prog() > before);
  // 駕駛中：aiming 不成立 → 1 s 後失敗
  w.deps.state.mode = 'drive';
  run(w, 1.2);
  check('上車（state.mode drive）→ 視同停止瞄準、1 s 後失敗', w.robberies.active === null && w.log.some((e) => e[0] === 'robbery:failed' && e[1].reason === 'aim') && w.toasts.includes('店員報警了！'));
}
{
  // 店員倒地 → 該店冷卻、店員保留（倒地）到冷卻結束後回收重生
  const w = makeWorld();
  const s = STORES[0];
  w.p.x = s.x;
  w.p.z = s.z;
  w.updateRobberies(1 / 30, false);
  const c = w.clerks.get(s.id);
  w.combat.entries.get(c.actor.id).state = 'knockdown';
  c.body.down = true;
  w.bus.emit('ped:knockdown', { ped: c.actor, cause: 'punch', byPlayer: true, x: s.counterX, z: s.counterZ });
  w.updateRobberies(1 / 30, false);
  const st = w.robberies.stores.find((x) => x.id === s.id);
  check('店員被打倒：該店 clerkDown、冷卻、光柱收起、倒地的店員留在原地', st.clerkDown && st.state === 'cooldown' && !w.storeBeaconOf.has(s.id) && w.clerks.get(s.id) === c);
  w.aimAtStore(s, s.x, s.z);
  run(w, 1);
  check('店員倒地後瞄準：不開始搶劫', w.robberies.active === null && !w.log.some((e) => e[0] === 'robbery:start'));
  w.combat.entries.get(c.actor.id).state = 'dead';
  w.updateRobberies(1 / 30, false);
  check('店員判定死亡（combat dead）→ 回收', !w.clerks.has(s.id) && w.disposed.length === 1);
  run(w, COOLDOWN_SEC, 0.1);
  const c2 = w.clerks.get(s.id);
  check('冷卻結束：生成新的店員（新 actor）', !!c2 && c2 !== c && c2.actor.id !== c.actor.id);
}
{
  // cancelRobbery：進行中取消、店員回收、進度條收起
  const w = makeWorld();
  const s = STORES[0];
  w.aimAtStore(s, s.x, s.z);
  w.updateRobberies(1 / 30, false);
  run(w, 2);
  w.cancelRobbery();
  check('cancelRobbery()：搶劫取消、不給錢、店員全部回收、進度條收起', w.robberies.active === null && w.money.total === 0 && w.clerks.size === 0 && w.bars.at(-1)[0] === null);
  w.wanted.clear('debug');
  check('cancelRobbery 之後 cancelRespawn 的 wanted.clear 不再發 robbery:failed', !w.log.some((e) => e[0] === 'robbery:failed'));
}

// ---------- hud.js / style.css ----------
const hudSrc = read('src/hud.js');
check('hud.js：setRobberyProgress(frac, label) + .rob-bar / .rob-label / .rob-track / .rob-fill', hudSrc.includes('setRobberyProgress(frac, label = ROB_LABEL)') && ["'rob-bar'", "'rob-label'", "'rob-track'", "'rob-fill'"].every((k) => hudSrc.includes(k)));
check("hud.js：ROB_LABEL = '搶劫中…'（與 robbery.js PROGRESS_LABEL 同字）", hudSrc.includes("export const ROB_LABEL = '搶劫中…';") && PROGRESS_LABEL === '搶劫中…');
check("hud.js：小地圖 kind 'store' 畫圖示（ICON_KINDS）", /const ICON_KINDS = \{ store: '超' \};/.test(hudSrc) && hudSrc.includes('ctx.fillText(glyph, cx, cz + 0.5);'));
check("hud.js：入帳跳字 robbery「搶劫」", /MONEY_REASON_LABEL = \{[^}]*robbery: '搶劫 '/.test(hudSrc));
const styleSrc = read('src/style.css');
check('style.css：.rob-bar / .rob-fill 樣式、[hidden] 隱藏、pointer-events none', ['.rob-bar {', '.rob-bar[hidden]', '.rob-fill {', '.rob-track {'].every((k) => styleSrc.includes(k)) && /\.rob-bar \{[^}]*pointer-events: none;/.test(styleSrc));
check('wanted.css：未混入 .rob- 選擇器（wanted.css 限 .wanted- 前綴）', !read('src/wanted/wanted.css').includes('.rob-'));

// ---------- 標記顏色 / 圖例 / 光柱色 ----------
check("marker-colors.js：MARKER_COLORS.store = '#43a047'", MARKER_COLORS.store === '#43a047');
check("big-map.js：MARKER_LABELS.store = '超商'", read('src/map/big-map.js').includes("store: '超商'"));
const pillarSrc = read('src/missions/light-pillar.js');
check('light-pillar.js：BEACON_COLORS.store = 綠 0x43a047、createBeaconPool 接受 height / radius / sink', pillarSrc.includes('store: 0x43a047') && pillarSrc.includes('height = BEACON_HEIGHT, radius = BEACON_RADIUS, sink = BEACON_SINK'));

// ---------- interfaces.md：§28 + 事件表 ----------
const docs = read('docs/dev/interfaces.md');
check('interfaces.md：§28 Phase 9 超商搶劫', docs.includes('## 28. Phase 9 超商搶劫'));
check('interfaces.md：事件表含 robbery:done / robbery:start / robbery:failed', ['| `robbery:done` |', '| `robbery:start` |', '| `robbery:failed` |'].every((k) => docs.includes(k)));
check("interfaces.md：CRIMES 含 robbery（HEAT 2.5、保底 2 星）", /robbery[^\n]*2\.5/.test(docs) && docs.includes('CRIME_MIN_STARS'));

console.log(`${failed === 0 ? "PASS" : "FAIL"} ${failed === 0 ? passed : failed}/${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
