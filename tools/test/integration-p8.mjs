#!/usr/bin/env node
// Phase 8 整合（p8-integ）驗證：噴漆廠接線靜態檢查（main.js 原始碼字串比對；不 import three / rapier）
// 用法：node tools/test/integration-p8.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：import（spray.js / places.js SPRAY_SHOPS / light-pillar.js）、建立 sprayShops / sprayBeacons、
//   每幀 updateSprayShops 接在 updateWanted 之後、input.enabled 鎖 / 解鎖、與 BUSTED/WASTED 互斥（state.spraying / state.respawn）、
//   小地圖 / 大地圖標記與圖例、light-pillar BEACON_COLORS.spray、window.__game.sprayShops、interfaces.md §27
// p8-rf-fix：resume / syncPanels 看 state.spraying、quitToMenu / startGame 先 cancelSpray、噴漆中每幀手煞、
//   #spray-fade 低於暫停選單、vehicle-damage 不持有 mesh、spray.js cancel()
// 注意：staging 無 node_modules；本檔只 import 不依賴 three / JSON import attributes 的純邏輯模組
// （spray.js / places.js / wanted.js / marker-colors.js）。big-map.js（import './map.css'）、
// light-pillar.js（import three）、hud.js（經 citymodel.js import osm-city.json）、vehicle.js（import three）
// 一律用原始碼字串比對（同 integration-p7.mjs 既有作法），不 import。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSprayShops, sprayFee } from '../../src/wanted/spray.js';
import { SPRAY_SHOPS } from '../../src/wanted/places.js';
import { MARKER_COLORS } from '../../src/map/marker-colors.js';
import { CLEAR_REASONS } from '../../src/wanted/wanted.js';

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
  ['import：spray.js / places.js SPRAY_SHOPS / light-pillar.js', [
    "import { createSprayShops } from './wanted/spray.js';",
    "import { createBeaconPool } from './missions/light-pillar.js';",
    /import\s*\{\s*respawnPlace,\s*SPRAY_SHOPS\s*\}\s*from\s*'\.\/wanted\/places\.js';/,
  ]],
  ['建立 sprayShops / sprayBeacons / sprayMarkers', [
    'createSprayShops({ bus, wanted, police, shops: SPRAY_SHOPS })',
    "createBeaconPool({ scene, heightAt })",
    "sprayBeacons.acquire('spray', s.x, s.z, s)",
    "kind: 'spray-shop'",
  ]],
  ['小地圖 / 大地圖標記併入 collectMarkers', ['pushAll(out, sprayMarkers)']],
  ['每幀順序：updateSprayShops 接在 updateWanted 之後', [/updateWanted\(dt, phoneOpen\);\s*\n\s*if \(!phoneOpen\) updateSprayShops\(dt\);/]],
  ['ctx：vehicle duck type（isPolice / color / repaint / repair / ref；closure 只建一次經 sprayTarget）', [
    'sprayVehicle.isPolice = policeAdapters.isPoliceVehicle(v)',
    'repaint: (color) => sprayTarget && sprayTarget.repaint(color)',
    'repair: () => sprayTarget && dmg.repair(sprayTarget)',
    'sprayVehicle.ref = v;',
    'sprayTarget = v;',
    'sprayCtx.seen = wanted.stars > 0 && lastPoliceSeen',
  ]],
  ['噴漆中每幀強制手煞（覆寫 driveControls 處）', [
    'const braked = phoneOpen || !!state.spraying;',
    'v.setControls(braked ? driveControls({ x: 0, y: 0 }, true) : driveControls(snap.move, snap.down.jump));',
  ]],
  ['cancelSpray：sprayShops.cancel + 重設 state.spraying + 黑幕歸零', [
    /const cancelSpray = \(\) => \{\s*sprayShops\.cancel\(\);\s*state\.spraying = null;[\s\S]*?hud\.setSprayFade\(0\);\s*\};/,
  ]],
  ['seen 沿用 updateWanted 本幀 police.update（不重算）', ['lastPoliceSeen = seen']],
  ['輸入鎖定 / 解鎖與淡出', [
    'state.spraying = r.shopId',
    'input.enabled = false',
    'hud.setSprayFade(0)',
    'hud.setSprayFade(r.progress < 0.5 ? r.progress * 2 : (1 - r.progress) * 2)',
  ]],
  ['與 BUSTED / WASTED 互斥', [
    'if (state.respawn || state.spraying) return', // beginRespawn
    '!state.respawn', // updateSprayShops 的 vehicle 判斷 / 解鎖條件含 respawn
  ]],
  ['除錯物件：window.__game.sprayShops', ['sprayShops,']],
  ['economy.spend 包一層回傳實扣金額', ["economy.spend(n, 'spray') ? n : 0"]],
];

for (const [name, list] of GROUPS) {
  const bad = missing(mainSrc, list);
  check(`main.js 接線：${name}`, bad.length === 0, bad.map((b) => (b instanceof RegExp ? b.source : b)).join(' | '));
}

// ---------- p8-rf-fix：噴漆中不開放輸入、回主選單 / 開新局取消噴漆（函式本體抽段比對）----------
const fnBody = (name) => (mainSrc.match(new RegExp(`const ${name} = \\([^)]*\\) => \\{([\\s\\S]*?)\\n {2}\\};`)) || [])[1] || '';
{
  const resume = fnBody('resumeGame');
  check('resumeGame：還原輸入同時看 state.spraying', /if \(!state\.respawn && !state\.spraying\) input\.enabled = true;/.test(resume), resume ? '' : '抽不到 resumeGame');
  const sync = fnBody('syncPanels');
  check('syncPanels：還原輸入同時看 state.spraying', sync.includes('input.enabled = !state.respawn && !state.spraying;'));
  check('main.js：沒有只看 state.respawn 就解鎖的殘留', !/if \(!state\.respawn\) input\.enabled = true;/.test(mainSrc) && !/input\.enabled = !state\.respawn;/.test(mainSrc));
  for (const name of ['quitToMenu', 'startGame']) {
    const body = fnBody(name);
    const iS = body.indexOf('cancelSpray();');
    const iR = body.indexOf('cancelRespawn();');
    check(`${name}：呼叫 cancelSpray()（在 cancelRespawn 之前）`, iS >= 0 && iR > iS, `cancelSpray@${iS} cancelRespawn@${iR}`);
  }
}

// ---------- hud.js：淡出 div / spray-shop 標記繪製沿用既有 _drawMarkers ----------
const hudSrc = read('src/hud.js');
check('hud.js：setSprayFade / 全螢幕 div', hudSrc.includes('setSprayFade(frac)') && hudSrc.includes("el.id = 'spray-fade'"));
{
  // 暫停選單（menu.css .tg- z-index 70–79）須蓋在黑幕之上；黑幕仍高於 HUD 上限 60
  const z = Number((hudSrc.match(/el\.id = 'spray-fade';[\s\S]*?z-index:(\d+)/) || [])[1]);
  const menuZ = Math.min(...[...read('src/ui/menu.css').matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1])));
  check('hud.js：#spray-fade z-index 介於 HUD 上限 60 與暫停選單之間', z > 60 && z < menuZ, `fade ${z} menu ${menuZ}`);
}

// ---------- vehicle.js：repaint ----------
const vehicleSrc = read('src/vehicle.js');
check('vehicle.js：Vehicle.prototype.repaint(color)', vehicleSrc.includes('repaint(color) {'));
// vehicle-damage.js 不持有 v.mesh（只讀 v.pos / v.spec），repaint 換網格不需重新 attach
check('vehicle-damage.js：不引用 vehicle.mesh（repaint 換網格無需重新綁定）', !/\.mesh\b/.test(read('src/vehicle-damage.js')));
// spray.js：cancel() API
{
  const s = createSprayShops({ bus: null, wanted: { stars: 0, state: 'clear', clear() {} }, shops: SPRAY_SHOPS });
  check('spray.js：createSprayShops 回傳 cancel()', typeof s.cancel === 'function');
}

// ---------- 標記顏色 / 圖例 / 光柱色（big-map.js / light-pillar.js 依賴 css / three，原始碼字串比對）----------
check("marker-colors.js：MARKER_COLORS['spray-shop']", MARKER_COLORS['spray-shop'] === '#e040fb');
const bigMapSrc = read('src/map/big-map.js');
check("big-map.js：MARKER_LABELS['spray-shop'] = '噴漆廠'", bigMapSrc.includes("'spray-shop': '噴漆廠'"));
const pillarSrc = read('src/missions/light-pillar.js');
check('light-pillar.js：BEACON_COLORS.spray = 洋紅 0xe040fb', pillarSrc.includes('spray: 0xe040fb'));

// ---------- wanted.js：CLEAR_REASONS 含 spray ----------
check("wanted.js：CLEAR_REASONS 含 'spray'", CLEAR_REASONS.includes('spray'));

// ---------- places.js：SPRAY_SHOPS 2–3 處、皆標 inferred（osm-city.json 無對應商家）----------
check('places.js：SPRAY_SHOPS 2–3 處', SPRAY_SHOPS.length >= 2 && SPRAY_SHOPS.length <= 3);
check('places.js：SPRAY_SHOPS 每筆有 id / name / x / z / yaw', SPRAY_SHOPS.every((s) => s.id && s.name && Number.isFinite(s.x) && Number.isFinite(s.z) && Number.isFinite(s.yaw)));
check('places.js：皆標 inferred（推測位置）', SPRAY_SHOPS.every((s) => s.inferred === true));

// ---------- spray.js 行為：createSprayShops 的 shops 回傳含計時器欄位 ----------
{
  const s = createSprayShops({ bus: null, wanted: { stars: 0, state: 'clear', clear() {} }, police: null, shops: SPRAY_SHOPS });
  check('createSprayShops({ shops: SPRAY_SHOPS })：shops 長度相同、含 cooldown 欄位', s.shops.length === SPRAY_SHOPS.length && s.shops.every((x) => 'cooldown' in x));
  check('sprayFee(0) / sprayFee(3) 契約值', sprayFee(0) === 50 && sprayFee(3) === 250);
}

// ---------- interfaces.md：§27 ----------
const docs = read('docs/dev/interfaces.md');
check('interfaces.md：§27 Phase 8 噴漆廠', docs.includes('## 27. Phase 8 噴漆廠'));
check("interfaces.md：spray:done 事件與 wanted clear reason 'spray'", docs.includes("spray:done") && docs.includes("CLEAR_REASONS") && docs.includes("'spray'"));

console.log(`PASS ${passed}/${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
