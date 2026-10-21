#!/usr/bin/env node
// Phase 17 整合驗證：隱藏包裹接線（main.js 原始碼字串比對 + 抽出隱藏包裹段以替身執行；不 import three）
// 用法：node tools/test/integration-p17.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：import、建立（mesh + packages，注入 groundAt / view / earn / toast / weapons）、每幀 updatePackages（updateStunts 之後；徒步 / 駕駛位置）、
//   存檔 / 讀檔、safehouse:enter → resupply、startGame / quitToMenu → cancelPackages、大地圖標記 / 圖例統計、暫停選單統計、window.__game、
//   interfaces.md §39；行為（抽段 + 替身）：駕車經過自動收集、safehouse:enter 依里程碑補給、未開局不補給、cancel
// 注意：staging 無 node_modules；main.js 依賴 three / css / JSON import，一律原始碼字串比對
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBus } from '../../src/core/events.js';
import { createWeapons } from '../../src/weapons/weapons.js';
import { createPackages, createPackageMesh, PACKAGES } from '../../src/collect/packages.js';
import { createSafehouses } from '../../src/shops/safehouse.js';

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
  ['import：collect/packages.js', ["import { createPackages, createPackageMesh } from './collect/packages.js';"]],
  ['建立：packageMesh + packages（groundAt / view / earn / toast / weapons）', [
    'const packageMesh = createPackageMesh({ THREE, scene });',
    'const packages = createPackages({',
    'groundAt: heightAt,',
    'view: packageMesh,',
    'earn: (n, reason) => economy.add(n, reason),',
  ]],
  ['每幀：updatePackages(dt) 接在 updateStunts(realDt) 之後', [/updateStunts\(realDt\);\s*\n\s*updatePackages\(dt\);/]],
  ['updatePackages：駕駛 = 車身位置、徒步 = 玩家位置', ["packages.update(dt, state.mode === 'drive' && state.vehicle ? state.vehicle.pos : player.pos);"]],
  ['safehouse:enter → packages.resupply({ save: autosave.flush(\'safehouse-resupply\') })（補給後再存檔一次）', [/bus\.on\('safehouse:enter', \(\) => \{\s*\n\s*if \(state\.started\) packages\.resupply\(\{ save: \(\) => autosave\.flush\('safehouse-resupply'\) \}\);/]],
  ['存檔：packages.serialize', ['packages: packages.serialize(),']],
  ['讀檔：stunts.restore 後 packages.restore', [/stunts\.restore\(save\.stunts\);[^\n]*\n\s*packages\.restore\(save\.packages\);/]],
  ['cancel 定義', ['const cancelPackages = () => packages.cancel();']],
  ['大地圖：只在不含車輛（大地圖）時加已收集標記；圖例統計列', ['if (!withVehicles) packages.markers(out);', 'getLegendStats: () => [packages.progressText()],']],
  ['暫停選單統計：hiddenPackages / hiddenPackagesTotal', ['hiddenPackages: packages.found, hiddenPackagesTotal: packages.total']],
  ['window.__game：packages / packageMesh', ['packages, packageMesh,']],
  ['檔頭說明 Phase 17', ['// 隱藏包裹（Phase 17，Hidden Packages）']],
];
for (const [name, list] of GROUPS_STATIC) {
  const miss = missing(mainSrc, list);
  check(name, miss.length === 0, miss.map(String).join(' | '));
}

const fnBody = (name) => {
  const i = mainSrc.indexOf(`const ${name} = (`);
  if (i < 0) return '';
  const j = mainSrc.indexOf('\n  };\n', i);
  return mainSrc.slice(i, j);
};
for (const fn of ['startGame', 'quitToMenu']) {
  const b = fnBody(fn);
  const s = b.indexOf('cancelStunts();');
  const p = b.indexOf('cancelPackages();');
  const r = b.indexOf('cancelRespawn();');
  check(`${fn}：cancelPackages() 在 cancelStunts() 之後、cancelRespawn() 之前`, s > 0 && p > s && r > p);
}
{
  const ug = fnBody('updateGame');
  check('updatePackages 在 updateGame 內、時間縮放之後', ug.indexOf('updatePackages(dt);') > ug.indexOf('dt *= stunts.timeScale;') && ug.indexOf('dt *= stunts.timeScale;') > 0);
}

const section = (() => {
  const i = mainSrc.indexOf('// ---------- 隱藏包裹（Phase 17）');
  const j = mainSrc.indexOf('\n  // ---------- 車流 / 行人外部狀態', i);
  return i > 0 && j > i ? mainSrc.slice(i, j) : '';
})();
check('抽出隱藏包裹段（安全屋段之後、不在特技跳台段抽取範圍內）', section.length > 300 && mainSrc.indexOf('const cancelShops = () => {') < mainSrc.indexOf('// ---------- 隱藏包裹（Phase 17）') && mainSrc.indexOf('// ---------- 隱藏包裹（Phase 17）') < mainSrc.indexOf('// ---------- 特技跳台（Phase 16，§38）'));
check('隱藏包裹段不新增光源 / 貼圖 / 陰影', !/Light\(|Texture|castShadow|shadowMap/.test(section));

// ---------- 行為（抽段 + 替身）----------
{
  class Matrix4 {
    constructor() { this.e = new Array(16).fill(0); }
    makeRotationY() { this.e[0] = 1; return this; }
    makeScale(x) { this.e[0] = x; return this; }
    setPosition(x, y, z) { this.e[12] = x; this.e[13] = y; this.e[14] = z; return this; }
  }
  const THREE = {
    BoxGeometry: class { constructor() { this.attributes = { position: { count: 8, getY: (i) => (i < 4 ? 0.17 : -0.17) } }; } setAttribute(k, v) { this.attributes[k] = v; } dispose() {} },
    BufferAttribute: class { constructor(a, n) { this.array = a; this.itemSize = n; } },
    MeshBasicMaterial: class { constructor(o) { Object.assign(this, o); } dispose() {} },
    InstancedMesh: class { constructor(g, m, n) { this.count = n; this.mats = []; this.instanceMatrix = {}; } setMatrixAt(i, m) { this.mats[i] = m.e.slice(); } },
    Matrix4,
  };
  const added = [];
  const scene = { add: (o) => added.push(o) };
  const bus = createBus();
  const money = [];
  const economy = { add: (n, r) => money.push([n, r]) };
  const toasts = [];
  const hud = { toast: (t) => toasts.push(t) };
  const weapons = createWeapons({ bus: { emit() {} }, combat: {}, player: { actor: {} }, raycast: () => null, sweep: () => [], settings: { get: () => undefined }, isTouch: false });
  const player = { pos: { x: 0, y: 0, z: 0 } };
  const car = { pos: { x: 0, y: 0.8, z: 0 } };
  const state = { started: true, mode: 'walk', vehicle: null };
  // autosave 替身：每次 flush 記下理由與當下是否擁有衝鋒槍（= 存檔內容）；saveOk 控制成功 / 失敗
  const flushes = [];
  let saveOk = true;
  const autosave = { flush: (reason) => (flushes.push({ reason, smg: weapons.owns('smg') }), saveOk) };
  const body = `${section}\nreturn { packages, packageMesh, updatePackages, cancelPackages };`;
  let w = null;
  try {
    w = new Function('THREE', 'scene', 'bus', 'heightAt', 'economy', 'hud', 'weapons', 'state', 'player', 'autosave', 'createPackages', 'createPackageMesh', body)(
      THREE, scene, bus, () => 0, economy, hud, weapons, state, player, autosave, createPackages, createPackageMesh);
  } catch (err) {
    check('抽段可執行', false, String(err && err.message));
  }
  if (w) {
    check('抽段可執行：1 個 InstancedMesh 加入場景', added.length === 1 && w.packageMesh.mesh.count === 20);
    // 駕車經過第 1 個
    state.mode = 'drive';
    state.vehicle = car;
    car.pos.x = PACKAGES[0].x + 1.5;
    car.pos.z = PACKAGES[0].z;
    w.updatePackages(0.016);
    check('駕車經過 → 自動收集、入帳 package', w.packages.found === 1 && money.some((m) => m[0] === 100 && m[1] === 'package') && toasts.some((t) => t.includes('隱藏包裹 1 / 20')));
    // 徒步收集到 5 個
    state.mode = 'walk';
    state.vehicle = null;
    for (let k = 1; k < 5; k++) {
      player.pos.x = PACKAGES[k].x;
      player.pos.z = PACKAGES[k].z;
      w.updatePackages(0.016);
    }
    check('徒步收集到 5 個（tier 1）', w.packages.found === 5 && w.packages.tier === 1);
    const res = [];
    bus.on('package:resupply', (e) => res.push(e));
    state.started = false;
    bus.emit('safehouse:enter', { id: 'safehouse-henan', x: 0, z: 0, saved: true });
    check('未開局（主選單）收到 safehouse:enter 不補給', res.length === 0);
    state.started = true;
    bus.emit('safehouse:enter', { id: 'safehouse-henan', x: 0, z: 0, saved: true });
    check('safehouse:enter → package:resupply tier 1（手槍）', res.length === 1 && res[0].tier === 1 && res[0].items.length === 1 && res[0].items[0].weapon === 'pistol');
    check('tier 1 無實際補給 → 不再存檔', flushes.length === 0);
    // 真安全屋（save = autosave.flush('safehouse')，同 main.js）+ 抽段接線：進安全屋後最後一次存檔內含新武器
    const sh = createSafehouses({ bus, save: () => autosave.flush('safehouse'), toast: (t) => hud.toast(t) });
    w.packages.restore({ found: PACKAGES.slice(0, 10).map((p) => p.id) });
    const en = sh.enter('safehouse-henan');
    check('10 個 → 進安全屋：給衝鋒槍', en.ok && res.length === 2 && res[1].tier === 2 && weapons.owns('smg'));
    check('進安全屋後存檔內含新武器（safehouse 存檔不含 → 補給後 flush(\'safehouse-resupply\') 含衝鋒槍）', flushes.length === 2 && flushes[0].reason === 'safehouse' && !flushes[0].smg && flushes[1].reason === 'safehouse-resupply' && flushes[1].smg, JSON.stringify(flushes));
    check('存檔成功：最後 toast = 存檔提示 + 補給內容', toasts[toasts.length - 1].startsWith('已在安全屋存檔') && toasts[toasts.length - 1].includes('衝鋒槍'));
    // 存檔失敗：最後可見 toast 必含存檔失敗
    saveOk = false;
    w.packages.restore({ found: PACKAGES.slice(0, 15).map((p) => p.id) });
    const en2 = sh.enter('safehouse-henan');
    check('save 回 false：最後可見 toast 含「存檔失敗」（補給訊息不蓋掉警告）', en2.saved === false && res.length === 3 && weapons.owns('shotgun') && toasts[toasts.length - 1].includes('存檔失敗'), toasts[toasts.length - 1]);
    const n0 = flushes.length;
    w.packages.restore({ found: PACKAGES.slice(0, 5).map((p) => p.id) });
    sh.enter('safehouse-henan');
    check('save 回 false 且無實際補給：最後 toast 為安全屋的存檔失敗訊息、不多存', toasts[toasts.length - 1].includes('存檔失敗') && flushes.length === n0 + 1);
    w.packages.restore({ found: PACKAGES.slice(0, 10).map((p) => p.id) });
    w.cancelPackages();
    check('cancelPackages：收集狀態不變', w.packages.found === 10);
  }
}

// ---------- 文件 ----------
{
  const doc = read('docs/dev/interfaces.md');
  const i = doc.indexOf('## 39. Phase 17 隱藏包裹');
  const sec = i >= 0 ? doc.slice(i, doc.indexOf('\n## ', i + 5)) : '';
  check('interfaces.md 有 §39 隱藏包裹一節', sec.length > 500);
  check('§39 列出 packages.js 介面（createPackages / createPackageMesh / resupply / serialize）', ['createPackages(', 'createPackageMesh(', 'resupply()', 'serialize()', 'restore(rec)', 'cancel()'].every((s) => sec.includes(s)));
  check('§39 列出事件 package:collect / package:milestone / package:resupply', sec.includes('package:collect { id, found, total, reward }') && sec.includes('package:milestone { tier, found, unlock') && sec.includes('package:resupply { tier, items'));
  check('§39 列出接線（updatePackages / safehouse:enter / cancelPackages / save.js packages）', ['updatePackages(dt)', "bus.on('safehouse:enter')", 'cancelPackages()', 'packages: { found: [id], tier: 0..4, bonus: boolean }'].every((s) => sec.includes(s)));
}

console.log(failed === 0 ? `PASS ${passed}/${passed}` : `FAIL ${failed}/${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
