#!/usr/bin/env node
// P19 飛車搶包整合驗證：main.js / hud.js / economy.js / save.js / menu.js / wanted.js / gangs.js 原始碼字串比對
//   + interfaces.md 新節；不 import three / rapier（容器無 node_modules）
// 用法：node tools/test/integration-p19.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：import、建立 snatch（adapters 三路後果）、每幀 updateSnatch 接在 updateFirefighter 之後、
//   互動優先序（駕駛分支第一順位、SNATCH_PRIORITY、按 E → snatch.act()）、HUD 連擊、save / restore、cancel、
//   window.__game.snatch、economy 訂閱、save.js 統計欄位、統計頁「搶包 N 次 / NT$X」、wanted 犯行、gangs.provokeActor、
//   interfaces.md §41、既有字串未動
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SNATCH_PROMPT, CRIME_SNATCH, CRIME_SNATCH_COMBO } from '../../src/snatch.js';
import { createSnatch, hasBag, bagAmount } from '../../src/snatch.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(`${ROOT}${p}`, 'utf8');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const missing = (code, list) => list.filter((s) => !(s instanceof RegExp ? s.test(code) : code.includes(s)));
function group(label, code, list) {
  const miss = missing(code, list);
  check(label, miss.length === 0, miss.map(String).join(' | '));
}

const mainSrc = read('src/main.js');
const hudSrc = read('src/hud.js');
const econSrc = read('src/economy.js');
const saveSrc = read('src/save.js');
const menuSrc = read('src/ui/menu.js');
const wantedSrc = read('src/wanted/wanted.js');
const gangsSrc = read('src/gangs.js');
const cssSrc = read('src/style.css');
const docSrc = read('docs/dev/interfaces.md');

// ---------- main.js 接線 ----------
group('import：snatch.js', mainSrc, ["import { createSnatch, SNATCH_PROMPT } from './snatch.js';"]);

group('建立 snatch（bus + 三路後果 adapters）', mainSrc, [
  /const snatch = createSnatch\(\{\s*\n\s*bus,\s*\n\s*adapters: \{/,
  'if (ped && ped.brain && ped.brain.onThreatened) ped.brain.onThreatened({ pos: player.pos });',
  'reportCrime: (crime, opts) => wanted.report(crime, opts),',
  "provokeGang: (ped) => gangs.provokeActor(ped && ped.actor, 'snatch'),",
]);

group('ctx：每幀重用同一物件（不每幀配置）', mainSrc, [
  'const snatchCtx = { riding: false, type: null, speed: 0, overturned: false, x: 0, z: 0, peds: null, frozen: false };',
  'snatchCtx.type = v ? v.type : null;',
  'snatchCtx.speed = v ? v.speed : 0;',
  'snatchCtx.overturned = !!v && v.isOverturned();',
  'snatchCtx.peds = traffic.peds;',
  'snatch.update(dt, snatchCtx);',
]);

group('每幀 updateSnatch 接在 updateFirefighter 之後', mainSrc, [
  /updateFirefighter\(dt, phoneOpen, state\.mode === 'drive' && \(snap\.down\.attack \|\| input\.down\(FIRE_SPRAY_KEY\)\)\);\s*\n\s*updateSnatch\(dt, phoneOpen \|\| !!state\.respawn\);/,
]);

group('HUD 連擊：每幀 setSnatchCombo', mainSrc, ['hud.setSnatchCombo(snatch.combo, snatch.mult);']);

group('互動優先序：駕駛分支第一順位、按 E → snatch.act()', mainSrc, [
  'const SNATCH_PRIORITY = 5;',
  'const snatchInteractable = () => (snatch.target ? { text: SNATCH_PROMPT, priority: SNATCH_PRIORITY, dist: 0, act: () => snatch.act() } : null);',
  /inter = snatchInteractable\(\);[^\n]*\n\s*if \(!inter\) inter = raceInteractable\(v\);/,
  /\} else if \(snap\.pressed\.interact && inter && typeof inter\.act === 'function'\) inter\.act\(\);/,
]);

group('save / restore：統計走 economy、startGame → snatch.restore(save.stats)', mainSrc, [
  /firefighter\.restore\(save\.firefighter\);[^\n]*\n\s*snatch\.restore\(save\.stats\);/,
]);

group('cancel：開新局 / 回主選單各一次，排在 cancelFirefighter 之前', mainSrc, [
  'const cancelSnatch = () => {',
  'snatch.cancel();',
  'hud.setSnatchCombo(0, 1);',
]);
check('cancelSnatch() 在 startGame / quitToMenu 各呼叫一次',
  (mainSrc.match(/\n\s*cancelSnatch\(\);/g) || []).length === 2,
  String((mainSrc.match(/\n\s*cancelSnatch\(\);/g) || []).length));
check('cancelSnatch 排在 cancelFirefighter 之前',
  (mainSrc.match(/cancelSnatch\(\);[^\n]*\n\s*cancelFirefighter\(\);/g) || []).length === 2);

// ---------- 機車倒地 = 摔車（handleFall 同幀 exitVehicle，updateSnatch 看不到翻覆） ----------
group('handleFall：機車倒地在 exitVehicle(true) 之前呼叫 snatch.crash()', mainSrc, [
  /const handleFall = \(\) => \{[^}]*\n\s*if \(v\.type === 'scooter'\) snatch\.crash\(\);\n\s*exitVehicle\(true\);/,
]);
{
  // 抽出 handleFall 原始碼，以替身 state / exitVehicle 與真 createSnatch 依 main.js 每幀順序執行
  const m = mainSrc.match(/const handleFall = \(\) => \{\n[\s\S]*?\n {2}\};/);
  check('抽得 handleFall 段落', !!m);
  if (m) {
    const drops = [];
    const snatch = createSnatch({ bus: { emit: (n, e) => { if (n === 'snatch:drop') drops.push(e); } } });
    let id = 1;
    while (!hasBag(id)) id++;
    const scooter = { type: 'scooter', speed: 15, pos: { x: 0, z: 0 }, isOverturned: () => false };
    const state = { mode: 'drive', vehicle: scooter, pendingFall: null };
    const ctx = { riding: true, type: 'scooter', speed: 15, overturned: false, x: 0, z: 0, peds: [{ actor: { id, pos: { x: 1, z: 0 } }, citizen: { id } }], frozen: false };
    snatch.update(1 / 60, ctx);
    snatch.act();
    const exitVehicle = () => { state.mode = 'walk'; state.vehicle = null; return true; };
    const handleFall = new Function('state', 'snatch', 'exitVehicle', 'knockDownPlayer', 'hud', `${m[0]}\nreturn handleFall;`)(
      state, snatch, exitVehicle, () => {}, { toast() {} });
    state.pendingFall = scooter;
    handleFall();
    Object.assign(ctx, { riding: false, type: null, speed: 0, peds: [] });
    for (let i = 0; i < 200; i++) snatch.update(1 / 60, ctx);
    check('抽段行為：搶包後機車倒地 → snatch:drop 掉一半、連擊重置',
      drops.length === 1 && drops[0].amount === Math.floor(bagAmount(id) / 2) && snatch.combo === 0 && state.mode === 'walk',
      `drops=${JSON.stringify(drops)} combo=${snatch.combo}`);
  }
}

group('除錯：window.__game.snatch', mainSrc, [/\/\/ P19：飛車搶包[^\n]*\n\s*snatch,/]);

// ---------- 既有字串未動（不放寬既有行為） ----------
group('既有字串未動', mainSrc, [
  'const jack = free && !over ? cj.canStart(player.pos, traffic.carjackCandidates(player.pos.x, player.pos.z, CARJACK_SCAN)) : null;',
  'if (!inter) inter = vigilanteInteractable(v) || nearestInteractable(v.pos, false);',
  'if (!inter) inter = sideJobInteractable(v);',
  'if (!inter) inter = firefighterInteractable(v);',
  'packages.restore(save.packages);',
]);

// ---------- 周邊模組 ----------
group('hud.js：setSnatchCombo + 建構', hudSrc, [
  'this._buildSnatchCombo();',
  '_buildSnatchCombo() {',
  'setSnatchCombo(combo, mult = 1) {',
  "el.className = 'snatch-combo';",
  '`搶包連擊 ${n}（×${Number.isInteger(m) ? m : m.toFixed(1)}）`',
]);
group('style.css：.snatch-combo 樣式', cssSrc, ['.snatch-combo {', '.snatch-combo[hidden] {']);
{
  // 桌機：膠囊底 ≥ .rob-bar 頂（底 152 + 高 48，皆乘 --hud-scale、底部中心縮放）→ 不重疊
  const px = (sel) => {
    const blk = cssSrc.match(new RegExp(`\\n${sel.replace('.', '\\.')} \\{([^}]*)\\}`));
    const b = blk && blk[1].match(/bottom: calc\((\d+)px \* var\(--hud-scale, 1\) \+ env\(safe-area-inset-bottom\)\);/);
    return { bottom: b ? Number(b[1]) : NaN, scaled: !!blk && blk[1].includes('scale(var(--hud-scale, 1))') && blk[1].includes('transform-origin: bottom center;') };
  };
  const rob = px('.rob-bar');
  const sc = px('.snatch-combo');
  check('.snatch-combo 在 .rob-bar 上方不重疊（同比例縮放）', rob.scaled && sc.scaled && sc.bottom >= rob.bottom + 48,
    `rob ${rob.bottom}+48 / snatch ${sc.bottom}`);
  check('.snatch-combo 不用未定義的 --hud-safe-bottom / --tg-font',
    !/--hud-safe-bottom|--tg-font/.test(cssSrc.slice(cssSrc.indexOf('.snatch-combo {'))));
}

group('economy.js：訂閱 snatch:success / snatch:drop', econSrc, [
  "bus.on('snatch:success'",
  "add(e && e.amount, 'snatch')",
  'stats.snatches++;',
  'stats.snatchMoney += amt;',
  /bus\.on\('snatch:drop', \(e\) => \{ charge\(e && e\.amount, 'snatchDrop'\); \}\)/,
]);

group('save.js：統計欄位（舊存檔缺欄位視 0）', saveSrc, [
  "'snatches', 'snatchMoney'];",
  'snatches: 0,',
  'snatchMoney: 0,',
]);

group('menu.js 統計頁：「搶包 N 次 / NT$X」', menuSrc, [
  "add('搶包',",
  '次 / ${formatMoney(Number.isFinite(s.snatchMoney) ? s.snatchMoney : 0)}',
]);
check('統計頁字樣含「搶包」與「次 /」', menuSrc.includes('搶包') && menuSrc.includes('} 次 / '));

group('wanted.js：snatch / snatchCombo 犯行與保底星數', wantedSrc, [
  `  ${CRIME_SNATCH}: '${CRIME_SNATCH}',`,
  `  ${CRIME_SNATCH_COMBO}: '${CRIME_SNATCH_COMBO}',`,
  'snatch: 0.6,',
  'snatchCombo: 1.5,',
  'export const CRIME_MIN_STARS = Object.freeze({ robbery: 2, snatch: 1, snatchCombo: 2 });',
]);

group('gangs.js：公開 provokeActor', gangsSrc, [
  'provokeActor(actor, cause = \'snatch\') {',
  'provoke(m.state, cause, C.attackGain);',
]);

// ---------- interfaces.md ----------
group('interfaces.md §41', docSrc, [
  '## 41. P19 機車飛車搶包 Scooter Snatch',
  '### 41.1 規則',
  '### 41.2 介面',
  '### 41.3 事件（bus）',
  '### 41.4 接線（main.js）',
  '### 41.5 回歸',
  '`snatch:success { pedId, amount, combo, mult }`',
  '`snatch:fail { pedId }`',
  '`snatch:drop { amount }`',
  SNATCH_PROMPT,
  'node tools/test/p19-snatch.mjs',
  'node tools/test/integration-p19.mjs',
]);
check('interfaces.md §41 排在附錄 B 之前',
  docSrc.indexOf('## 41. P19') > 0 && docSrc.indexOf('## 41. P19') < docSrc.indexOf('## 附錄 B'));

// ---------- 限制：不得修改的檔案不得出現 P19 痕跡 ----------
const LOCKED = ['src/postfx.js', 'src/neon.js', 'src/wanted/helicopter.js'];
check('不得修改的檔案沒有 snatch 相關改動',
  LOCKED.every((f) => !read(f).toLowerCase().includes('snatch')), LOCKED.join(' '));

console.log(`${failed ? 'FAIL' : 'PASS'} ${passed}/${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
