#!/usr/bin/env node
// P21 整合驗證：夜市攤位小遊戲接線（main.js 原始碼字串比對；不 import three / rapier）
// 用法：node tools/test/integration-p21.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：import、建立（view / 模組 / 注入）、碰撞盒、每幀 update / updatePanel 位置、互動鏈、互斥（racing getter / 委託遮罩 / panelOpen 包裝）、
//   射氣球局中 gunfire 豁免與 raycast 不傷行人、存檔 getState / restore、cancel（startGame / quitToMenu）、統計頁、標記、__game；
//   既有鎖字面的行未被改寫；interfaces.md §1 事件 + §43；menu.js 統計頁字樣；marker-colors / hud / big-map / light-pillar 含 minigame；save.js minigames
// 注意：staging 無 node_modules；main.js / hud.js / big-map.js / light-pillar.js 依賴 three / css / JSON import，一律原始碼字串比對
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MARKER_COLORS } from '../../src/map/marker-colors.js';
import { MINIGAME_KIND } from '../../src/minigames/nightmarket.js';

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
const at = (code, s) => code.indexOf(s);

// ---------- main.js ----------
const main = read('src/main.js');
const GROUPS = [
  ['import：minigames/nightmarket.js、BEACON_COLORS', [
    "import { createNightMarket, createNightMarketView, boothColliderBoxes, BOOTHS as MINIGAME_BOOTHS } from './minigames/nightmarket.js';",
    "import { BEACON_COLORS } from './missions/light-pillar.js';",
  ]],
  ['建立：外觀（BEACON_COLORS.minigame）+ 模組（economy / wanted / weapons 注入、DOM 面板）', [
    'const nightMarketView = createNightMarketView({ THREE, scene, booths: MINIGAME_BOOTHS, heightAt, beaconColor: BEACON_COLORS.minigame });',
    'nightMarket = createNightMarket({',
    'spend: (n, reason) => economy.spend(n, reason),',
    'earn: (n, reason) => economy.add(n, reason),',
    'getStars: () => wanted.stars,',
    "isBusy: () => (minigameBusy() ? '任務進行中，不能玩夜市小遊戲' : null),",
    'equipPistol: () => weapons.select(WEAPONS.pistol.slot),',
    'getWeapon: () => weapons.current,',
    'view: nightMarketView,',
    'keyTarget: window,',
    'let nightMarket = null;',
  ]],
  ['互斥：busy 條件、racing getter 包裝、委託遮罩、panelOpen 包裝（gunShop.isOpen）', [
    'const minigameBusy = () => otherMissionBusy() || vigilante.active || rampage.active || stunts.active || firefighter.active || story.active || !!state.respawn || !!state.spraying;',
    "const racingGetMinigame = Object.getOwnPropertyDescriptor(state, 'racing').get;",
    "Object.defineProperty(state, 'racing', { get: () => racingGetMinigame() || nightMarket.active, enumerable: true, configurable: true });",
    "if (typeof nightMarket !== 'undefined' && nightMarket.active) interCands[0] = null;",
    'const gunShopIsOpen = gunShop.isOpen;',
    'gunShop.isOpen = () => gunShopIsOpen() || nightMarket.panelOpen();',
  ]],
  ['射氣球：局中手槍朝氣球牆才不算 gunfire、raycast 不回傳行人（傳入射擊事件 / 射線）', [
    "if (typeof nightMarket !== 'undefined' && nightMarket.exemptShot(e)) return;",
    'if (rayHit.actor && rayHit.actor !== player.actor && nightMarket && nightMarket.shieldShots(origin, dir)) rayHit.actor = null;',
  ]],
  ['暫停：失去滑鼠鎖定自動暫停前後 setAutoPause（typeof 守衛）', [
    "if (typeof nightMarket !== 'undefined' && nightMarket) nightMarket.setAutoPause(true);",
    "if (typeof nightMarket !== 'undefined' && nightMarket) nightMarket.setAutoPause(false);",
  ]],
  ['互動：攤位站位半徑內提示優先（壓過 priority ≤ override）', ['if (inter && (inter.priority || 0) <= c.override) return c;']],
  ['碰撞：攤位靜態方塊', ['for (const b of boothColliderBoxes(MINIGAME_BOOTHS, heightAt)) addStaticBox(RAPIER, pw.world, b);']],
  ['互動：步行鏈 minigameInteractable', ['inter = minigameInteractable(inter, free);', 'const c = nightMarket.nearest(player.pos);']],
  ['每幀：updateNightMarket / updatePanel', ['updateNightMarket(dt, phoneOpen);', 'nightMarket.updatePanel(dt);', 'if (!phoneOpen) nightMarket.update(dt, nightMarketCtx);']],
  ['標記 / 存檔 / 統計 / 除錯', [
    'pushAll(out, nightMarket.markers());',
    'minigames: nightMarket.serialize(),',
    'nightMarket.restore(save.minigames);',
    '...nightMarket.stats() }); // Phase 17：統計頁「隱藏包裹 N / 20」；P21：射氣球 / 彈珠台最佳',
    'nightMarket, nightMarketView,',
  ]],
];
for (const [name, list] of GROUPS) {
  const m = missing(main, list);
  check(`main.js ${name}`, m.length === 0, m.map(String).join(' | ').slice(0, 200));
}
// 順序
{
  const iSync = at(main, '    if (syncPanels()) return;\n    const snap = input.snapshot();');
  const iPanel = at(main, 'nightMarket.updatePanel(dt);');
  check('updatePanel 在 syncPanels 之前（面板開著世界暫停時照跑）', iPanel > 0 && iSync > iPanel && iSync - iPanel < 200);
  const iStory = at(main, "updateStory(dt, phoneOpen, input.wasPressed(STORY_SKIP_KEY));");
  const iNm = at(main, 'updateNightMarket(dt, phoneOpen);');
  check('updateNightMarket 接在 updateStory 之後', iStory > 0 && iNm > iStory && iNm - iStory < 200);
  const iNear = at(main, 'inter = free ? nearestInteractable(player.pos, true) : null;');
  const iMini = at(main, 'inter = minigameInteractable(inter, free);');
  const iStoryInter = at(main, 'inter = storyInteractable(inter, free);');
  check('互動鏈：nearestInteractable → storyInteractable → minigameInteractable（story 相鄰斷言在 integration-p20）', iNear > 0 && iStoryInter > iNear && iMini > iStoryInter);
  const iCrime = at(main, 'if (!e || !e.byPlayer || e.police) return;');
  const iEx = at(main, "if (typeof nightMarket !== 'undefined' && nightMarket.exemptShot(e)) return;");
  const iFug = at(main, 'if (vigHooks.fugitiveShot(e.ex, e.ez, e.vehicle)) return;');
  check('gunfire 豁免新起一行，在既有 police / fugitiveShot 判斷之間', iCrime > 0 && iEx > iCrime && iFug > iEx);
  const iDecl = at(main, 'let nightMarket = null;');
  const iRay = at(main, 'const raycast = (origin, dir, maxDist, opts) => {');
  check('nightMarket 宣告在 raycast 之前（建立前為 null，皆有 null 防護）', iDecl > 0 && iDecl < iRay);
  const iCreate = at(main, 'nightMarket = createNightMarket({');
  const iCancelStoryDef = at(main, 'const cancelStory = () => {');
  const iQuality = at(main, '// ---------- 畫質 / 設定 ----------');
  check('建立位置：故事任務段之後、畫質段之前（busy 依賴的模組都已建立）', iCreate > iCancelStoryDef && iCreate < iQuality);
  // cancel：startGame / quitToMenu 各一次，接在 cancelStory 之後
  const cancels = main.split('cancelNightMarket();').length - 1;
  check('cancelNightMarket() 在 startGame / quitToMenu 各呼叫一次', cancels === 2 && /cancelStory\(\);[^\n]*\n\s*cancelNightMarket\(\);/.test(main));
  // 自動暫停旗標：true → 既有 openPause 行（原文不改）→ false，三行相鄰
  {
    const lock = "    if (lost && state.started && !state.paused && !menu.isOpen() && !panelOpen()) menu.openPause();\n";
    const iOn = at(main, "nightMarket.setAutoPause(true);");
    const iLock = at(main, lock);
    const iOff = at(main, "nightMarket.setAutoPause(false);");
    check('setAutoPause(true) / 既有 pointerlock openPause 行 / setAutoPause(false) 相鄰且順序正確', iOn > 0 && iLock > iOn && iLock - iOn < 200 && iOff > iLock && iOff - iLock < lock.length + 80);
    // 攤位優先：override 判斷在 nearest 之後、既有同級取近判斷之前
    const iNearest = at(main, 'const c = nightMarket.nearest(player.pos);');
    const iOver = at(main, 'if (inter && (inter.priority || 0) <= c.override) return c;');
    const iCmp = at(main, 'if (!inter || c.priority > (inter.priority || 0)');
    check('minigameInteractable：override 優先判斷在 nearest 與既有 priority 比較之間', iNearest > 0 && iOver > iNearest && iCmp > iOver);
    // 豁免 / 遮蔽不再是無參數呼叫（舊寫法只看局中、不看武器與方向）
    check('main.js 不再有無參數 exemptShot() / shieldShots()', !main.includes('nightMarket.exemptShot()') && !main.includes('nightMarket.shieldShots()'));
  }
  const iRestoreStory = at(main, 'story.restore(save.story);');
  const iRestore = at(main, 'nightMarket.restore(save.minigames);');
  check('nightMarket.restore 接在 story.restore 之後', iRestoreStory > 0 && iRestore > iRestoreStory);
}
// 既有鎖字面的行未被合併改寫
{
  const LOCKED = [
    'const interCands = [null, null, null, null, null, null];',
    'if (state.sideJob) interCands[0] = null; // 計程車 / 救護車副任務中同樣不接委託',
    'if (state.story) interCands[0] = null; // 故事任務（P20）進行中不接委託',
    'const panelOpen = () => missions.isModalOpen() || bigMap.isOpen() || food.isOpen() || gunShop.isOpen(); // 武器店購買面板（Phase 14）',
    'const otherMissionBusy = () => !!(state.sideJob || missions.active() || missions.eventActive() || missions.jobActive() || robberies.active || state.spraying || state.racing);',
    'if (peopleNear(e.x, e.z, CRIME_GUNFIRE_RANGE, true)) reportCrime(CRIMES.gunfire, e.x, e.z);',
    'rayHit.actor = actor && !(opts && opts.excludeActor === actor) ? actor : null;',
    'for (const b of [...stallBoxes, ...valetBoxes]) addStaticBox(RAPIER, pw.world, b);',
    'const currentStats = () => ({ ...statsWithExtra(economy.stats, extraStats), hiddenPackages: packages.found, hiddenPackagesTotal: packages.total, ...nightMarket.stats() });',
  ];
  const m = missing(main, LOCKED);
  check('既有鎖字面的行原樣保留（新增條件另起一行）', m.length === 0, m.join(' | ').slice(0, 200));
  const tb = (main.match(/registerTouchButton\(/g) || []).length;
  check('main.js 未新增觸控按鈕（registerTouchButton 呼叫維持 3 處：tb-guide / tb-phone / tb-spray）', tb === 3, `n=${tb}`);
  check('main.js 未新增光源 / shadow map（P21 段內）', (() => {
    const a = at(main, '// ---------- 夜市攤位小遊戲（P21');
    const b = at(main, '// ---------- 畫質 / 設定 ----------');
    const seg = main.slice(a, b);
    return a > 0 && !/Light\(|shadowMap|Texture\(/.test(seg);
  })());
}

// ---------- interfaces.md ----------
{
  const doc = read('docs/dev/interfaces.md');
  check('interfaces.md §1 事件表含 minigame:start / minigame:end', doc.includes('| `minigame:start` |') && doc.includes('| `minigame:end` |') && at(doc, '| `minigame:end` |') < at(doc, '表外的新事件名稱必須先加進本表'));
  check('interfaces.md 新增 §43 夜市攤位小遊戲（介面 / 事件 / 接線 / 回歸）', /^## 43\. P21 夜市攤位小遊戲/m.test(doc)
    && ['### 43.1', '### 43.2', '### 43.3', '### 43.4', '### 43.5', 'createNightMarket(', 'boothColliderBoxes', 'exemptShot', 'shieldShots', 'minigames: { balloon: { best', 'node tools/test/p21-nightmarket.mjs'].every((s) => doc.includes(s)));
  check('§43 位於 §42 之後、附錄 B 之前', at(doc, '## 42. P20') < at(doc, '## 43. P21') && at(doc, '## 43. P21') < at(doc, '## 附錄 B'));
}

// ---------- 統計頁 / 地圖 / 光柱 / 存檔 ----------
{
  const menu = read('src/ui/menu.js');
  check('統計頁：「射氣球最佳」「彈珠台最佳」（讀 minigameBalloonBest / minigamePachinkoBest）', menu.includes("add('射氣球最佳'") && menu.includes("add('彈珠台最佳'") && menu.includes('s.minigameBalloonBest') && menu.includes('s.minigamePachinkoBest'));
  const colors = Object.values(MARKER_COLORS);
  check('marker-colors 含 minigame（kind 與模組一致）且色碼不與其他 kind 重複', MINIGAME_KIND === 'minigame' && /^#[0-9a-f]{6}$/i.test(MARKER_COLORS.minigame) && colors.filter((c) => c.toLowerCase() === MARKER_COLORS.minigame.toLowerCase()).length === 1);
  const hud = read('src/hud.js');
  check("hud.js 小地圖 ICON_KINDS.minigame = '玩'（不進 EDGE_KINDS）", hud.includes("ICON_KINDS.minigame = '玩';") && !/EDGE_KINDS = new Set\([^)]*'minigame'/.test(hud));
  const big = read('src/map/big-map.js');
  check('big-map 圖例 MARKER_LABELS.minigame', /\n\s*minigame: '夜市小遊戲',/.test(big));
  const lp = read('src/missions/light-pillar.js');
  const hex = (lp.match(/BEACON_COLORS\.minigame = 0x([0-9a-f]{6});/i) || [])[1];
  check('light-pillar BEACON_COLORS.minigame（新起一行）且與標記同色', !!hex && `#${hex.toLowerCase()}` === MARKER_COLORS.minigame.toLowerCase());
  const save = read('src/save.js');
  check('save.js 清洗 minigames（選填、不升版）', save.includes('const mg = minigamesRecord(m.minigames);') && save.includes('if (mg) out.minigames = mg;') && /export const SAVE_VERSION = 2;/.test(save));
}

console.log(`${failed === 0 ? 'PASS' : 'FAIL'} ${failed === 0 ? passed : failed}/${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
