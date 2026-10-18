#!/usr/bin/env node
// Phase 14 整合驗證：衝鋒槍 / 散彈槍、武器店、安全屋的 main.js 接線（原始碼字串比對 + 抽出互動仲裁段以替身執行；不 import three / rapier）
// 用法：node tools/test/integration-p14.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：import、建立 gunShop / safehouses（光柱池、經濟、通緝、存檔注入）、互動鍵仲裁（步行限定、委託優先、同級取近、駕駛不問）、
//   panelOpen / closePanels、每幀 updateShops（updateStreetEvents 之後）、開新局 / 回主選單 cancelShops（cancelRespawn 之前）、
//   collectMarkers、存檔 safehouse 欄、placePlayer 安全屋出生、武器直選 4 / 5、槍械連發、手把上一把、模型 / 姿勢、彈藥盒不放置、
//   WASTED / BUSTED 不動武器（保留）、window.__game、actions 說明、interfaces.md §36
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(`${ROOT}${p}`, 'utf8');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const mainSrc = read('src/main.js');
const missing = (code, list) => list.filter((s) => !(s instanceof RegExp ? s.test(code) : code.includes(s)));
const GROUPS = [
  ['import：shops / 武器常數', [
    "import { createGunShop, GUN_SHOP_BEACON } from './shops/gun-shop.js';",
    "import { createSafehouses, SAFEHOUSE_BEACON } from './shops/safehouse.js';",
    /import \{ createWeapons, gunshotListeners, loadWeaponModels, createAmmoPickups, WEAPONS, SLOT_KEYS, isGun \} from '\.\/weapons\/index\.js';/,
  ]],
  ['建立 gunShop（經濟 / 通緝 / 光柱 / 面板）', [
    'const gunShop = createGunShop({',
    'getMoney: () => economy.money,',
    'spend: (n, reason) => economy.spend(n, reason),',
    'getStars: () => wanted.stars,',
    'beacons: createBeaconPool({ scene, heightAt, ...GUN_SHOP_BEACON }),',
    'keyTarget: window,',
  ]],
  ['建立 safehouses（存檔 / 回血 / 清星 / 搶劫中不可進）', [
    'const safehouses = createSafehouses({',
    'beacons: createBeaconPool({ scene, heightAt, ...SAFEHOUSE_BEACON }),',
    "save: () => autosave.flush('safehouse'),",
    'player.actor.hp = player.actor.maxHp;',
    "clearWanted: () => wanted.clear('safehouse'),",
    "busy: () => (robberies.active ? '搶劫進行中，不能進安全屋' : null),",
  ]],
  ['互動仲裁：步行才問武器店 / 安全屋', [
    'const interCands = [null, null, null, null, null, null];',
    'interCands[4] = walking ? gunShop.nearest(pos) : null;',
    'interCands[5] = walking ? safehouses.nearest(pos) : null;',
  ]],
  ['面板：panelOpen 併入、closePanels 關閉', [
    'const panelOpen = () => missions.isModalOpen() || bigMap.isOpen() || food.isOpen() || gunShop.isOpen();',
    'if (gunShop.isOpen()) gunShop.close();',
  ]],
  ['標記：collectMarkers 併入', ['pushAll(out, gunShop.markers());', 'pushAll(out, safehouses.markers());']],
  ['每幀：updateShops 接在 updateStreetEvents 之後', [/updateStreetEvents\(dt, phoneOpen\);\s*\n\s*updateShops\(dt\);/, 'const updateShops = (dt) => {']],
  ['存檔：getState 帶 safehouse', ['safehouse: safehouses.serialize(),']],
  ['開局：safehouses.restore 後 placePlayer；placePlayer 以安全屋出生', [
    /safehouses\.restore\(save\.safehouse\);[^\n]*\n\s*placePlayer\(save\);/,
    'const home = safehouses.spawnPoint(save.safehouse || null);',
  ]],
  ['武器輸入：直選 4 / 5（SLOT_KEYS）、槍械按住連發', [
    'else if (input.wasPressed(SLOT_KEYS[3])) weapons.select(3);',
    'else if (input.wasPressed(SLOT_KEYS[4])) weapons.select(4);',
    'const fire = isGun(weapons.current) ? snap.down.attack : snap.pressed.attack;',
  ]],
  ['手把：十字鍵 ← 上一把（跳過未購買）', ['getPrevSlot: () => weapons.prevSlot()']],
  ['模型 / 姿勢 / 槍口：長槍', [
    "const m = id === 'fist' ? null : weaponModels[id] || null;",
    "isGun(id) ? 'pistol_aim' : 'none'",
    'const m = weaponModels && isGun(weapons.current) ? weaponModels[weapons.current] : null;',
    'const pistol = isGun(weapons.current);',
  ]],
  // 用戶決定：彈藥盒不放置——長槍彈藥只在武器店購買或取得武器時附贈，不恢復地圖彈藥盒（points 為空、不引用 DEFAULT_AMMO_POINTS / LONG_AMMO_POINTS）
  ['彈藥盒不放置（長槍彈藥只在武器店 / 取得附贈）、pickup:ammo 帶 weapon', [
    /createAmmoPickups\(\{[^}]*points: \[\]/,
    /^(?![\s\S]*(?:DEFAULT_AMMO_POINTS|LONG_AMMO_POINTS))/,
    'const n = weapons.addAmmo(e && e.amount, w);',
  ]],
  ['window.__game：gunShop / safehouses / giveWeapon', [/gunShop,\s*\n\s*safehouses,\s*\n\s*giveWeapon\(id = 'smg'\)/]],
];
for (const [name, list] of GROUPS) {
  const miss = missing(mainSrc, list);
  check(`main.js 接線：${name}`, miss.length === 0, miss.map(String).join(' | '));
}

// 開新局 / 回主選單：cancelShops 在 cancelRespawn 之前
const fnBody = (name) => {
  const i = mainSrc.indexOf(`const ${name} = (`);
  if (i < 0) return '';
  const j = mainSrc.indexOf('\n  };\n', i);
  return mainSrc.slice(i, j);
};
for (const fn of ['startGame', 'quitToMenu']) {
  const b = fnBody(fn);
  const a = b.indexOf('cancelShops();');
  const r = b.indexOf('cancelRespawn();');
  check(`${fn}：cancelShops() 在 cancelRespawn() 之前`, a > 0 && r > a);
}
check('cancelShops 定義：關武器店面板', /const cancelShops = \(\) => \{\s*\n\s*gunShop\.cancel\(\);/.test(mainSrc));

// WASTED / BUSTED：既有規則不動武器 → 保留
{
  const bodies = ['beginRespawn', 'finishRespawn', 'cancelRespawn'].map(fnBody).join('\n');
  check('WASTED / BUSTED：beginRespawn / finishRespawn 不改武器（保留武器與彈藥）', bodies.length > 200 && !/weapons\.(restore|give|dispose|addAmmo|select)\(/.test(bodies));
  check('WASTED：既有規則下 weapons 只在開局 restore（全檔唯一一處 weapons.restore）', (mainSrc.match(/weapons\.restore\(/g) || []).length === 1 && fnBody('startGame').includes('weapons.restore(save.weapons);'));
}

// 互動仲裁（抽段 + 替身）：pickInteractable + nearestInteractable
{
  const pi = mainSrc.slice(mainSrc.indexOf('function pickInteractable(list) {'), mainSrc.indexOf('\n}\n', mainSrc.indexOf('function pickInteractable(list) {')) + 2);
  const ni0 = mainSrc.indexOf('const interCands = [');
  const ni1 = mainSrc.indexOf('return pickInteractable(interCands);\n  };', ni0) + 'return pickInteractable(interCands);\n  };'.length;
  const nearestSrc = mainSrc.slice(ni0, ni1);
  const factory = new Function('env', `const { vigilante, races, missions, state, checkins, food, pickups, gunShop, safehouses } = env;\n${pi}\n${nearestSrc}\nreturn nearestInteractable;`);
  const mk = (over = {}) => {
    const it = (id, priority, dist) => ({ id, priority, dist, act: () => true, text: id });
    const env = {
      vigilante: { active: false },
      races: { active: false },
      state: { sideJob: false },
      missions: { nearest: () => null },
      checkins: { nearest: () => null },
      food: { nearest: () => null },
      pickups: { nearest: () => null },
      gunShop: { nearest: () => it('gunshop:a', 2, 1.0) },
      safehouses: { nearest: () => it('safehouse:a', 2, 2.0) },
      ...over,
    };
    return { near: factory(env), it };
  };
  const a = mk();
  check('仲裁：步行時武器店 / 安全屋同級取近', a.near({ x: 0, z: 0 }, true).id === 'gunshop:a');
  check('仲裁：駕駛中不問武器店 / 安全屋', a.near({ x: 0, z: 0 }, false) === null);
  const b = mk({ missions: { nearest: () => ({ id: 'mission:x', priority: 3, dist: 2.4, act: () => true }) } });
  check('仲裁：委託（priority 3）優先於武器店', b.near({ x: 0, z: 0 }, true).id === 'mission:x');
  const c = mk({ pickups: { nearest: () => ({ id: 'ammo-0', priority: 0, dist: 0.1, act: () => true }) } });
  check('仲裁：武器店優先於彈藥盒（priority 0）', c.near({ x: 0, z: 0 }, true).id === 'gunshop:a');
}

// 其他檔
{
  const actions = read('src/core/actions.js');
  check('actions.js：KEYMAP_HELP 列 4 / 5（action null，ACTIONS 仍 19 個）、互動說明含武器店 / 安全屋', actions.includes("{ keys: '4', action: null, desc: '切換：衝鋒槍（需在武器店購買）' }") && actions.includes("{ keys: '5', action: null, desc: '切換：散彈槍（需在武器店購買）' }") && actions.includes('武器店 / 安全屋') && !/slot4:|slot5:/.test(actions));
  const lp = read('src/missions/light-pillar.js');
  check('light-pillar.js：BEACON_COLORS gunshop 紅 / safehouse 藍', /gunshop: 0xe53935, safehouse: 0x1e88e5/.test(lp));
  const shopSection = mainSrc.slice(mainSrc.indexOf('// ---------- 武器店 / 安全屋（Phase 14'), mainSrc.indexOf('// ---------- 車流 / 行人外部狀態'));
  check('main.js 武器店 / 安全屋段：不新增光源 / 陰影 / 貼圖', shopSection.length > 300 && !/castShadow|shadowMap|Light\(|Texture|map:/.test(shopSection));
  check('shops：不 import three / rapier', ['src/shops/gun-shop.js', 'src/shops/safehouse.js'].every((f) => !/^import [^\n]*(three|rapier)/m.test(read(f))));
  const npc = read('src/npc-ai.js');
  check('npc-ai.js：被衝鋒槍 / 散彈槍打到同手槍逃跑', npc.includes("s.weapon === 'pistol' || s.weapon === 'smg' || s.weapon === 'shotgun'"));
}

// interfaces.md
{
  const docs = read('docs/dev/interfaces.md');
  check('interfaces.md：§36 Phase 14（武器參數 / 武器店 / 安全屋 / 存檔 / 接線）', docs.includes('## 36. Phase 14 衝鋒槍 / 散彈槍、武器店與安全屋') && ['### 36.1 新武器參數', '### 36.3 武器店', '### 36.4 安全屋', '### 36.5 存檔', '### 36.6 接線'].every((k) => docs.includes(k)));
  check('interfaces.md：事件表含 weapon:acquire / shop:* / safehouse:*', ['weapon:acquire', 'shop:refused', 'shop:purchase', 'safehouse:enter', 'safehouse:refused'].every((k) => docs.includes(`| \`${k}\` |`)) && docs.includes('| `shop:open` / `shop:close` |'));
  check('interfaces.md：註明 WASTED 保留武器、雙手 clip 以 pistol_aim 近似', docs.includes('武器、擁有權與彈藥全部保留') && docs.includes('pistol_aim'));
  // P14 審查修正：契約對齊（smg 射速與幀率無關、散彈打車衰減 / 擦傷不累積連擊、彈藥按比例計價、單一觸發）
  check('interfaces.md §36：smg 射速與幀率無關（nextFireAt 結轉）、散彈打車 × pelletFalloff、comboDamage / applyHit combo',
    docs.includes('與幀率無關') && docs.includes('nextFireAt') && docs.includes('與打人同樣 × `pelletFalloff(dist)`') && docs.includes('`comboDamage` 42') && docs.includes('`combo`（預設 true'));
  check('interfaces.md §36.3：彈藥將滿按比例計價（ammoQuote）、Space / Enter 單一觸發與防連點', docs.includes('`ammoQuote(item, reserve)`') && docs.includes('keyup 的 Space / Enter 攔下') && docs.includes('`CLICK_GUARD_MS`'));
  const ws = read('src/weapons/weapons.js');
  check('weapons.js：afterShot 以 nextFireAt 結轉射擊間隔（select / restore 重設）', /setState\('attacking', base, D\.fireInterval\)/.test(ws) && (ws.match(/nextFireAt = -Infinity;/g) || []).length >= 3);
}

console.log(`${failed === 0 ? 'PASS' : 'FAIL'} ${failed === 0 ? passed : failed}/${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
