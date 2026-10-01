#!/usr/bin/env node
// Phase 4 整合（I4a）無頭檢查：main.js 建構需要 WebGL / Rapier / DOM，node 無法直接跑，改為
//   1. import 圖完整：main.js 的每個相對 import 都存在、具名匯出都找得到（CSS 以 hook 略過）
//   2. 附錄 B 接線靜態檢查：武器 / 流血 / 音效 / 委託 / 導航 / 大地圖 / 打卡 / 圖鑑 / 存檔 v2 / 面板暫停 / 效能 / __game 新欄位
//   3. main.js 純函式區塊（@integration-p3:pure-begin / end）：interactable 仲裁、統計合併、膠囊朝向四元數
//   4. 模組組合（node 可跑的部分）：weapons + combat + blood + audio（假 AudioContext）走一次
//      「持棒移動 → 揮擊 → 行人受擊擊倒 → combat:hit / ped:knockdown / 音效播放 / 血跡生成」；手槍開槍 → 槍聲 → 行人 hear、統計累加
//   5. 缺檔路徑：武器模型 / 委託 / 小吃 manifest / 地標 manifest 全缺 → 安靜退回（無 console.error、不丟例外）
//   6. 存檔 v2 往返（同 main.js getState 形狀）
// 用法：node tools/test/integration-p4.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 真物理（Rapier castRay / intersections 的 raycast / sweep 轉接）與瀏覽器端面板 / 渲染暫停：需宿主以 __game 實測
import { register } from 'node:module';

const HOOK = `
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function load(url, context, next) {
  if (url.endsWith('.json')) {
    return { format: 'module', shortCircuit: true, source: 'export default ' + readFileSync(fileURLToPath(url), 'utf8') + ';' };
  }
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default {};' };
  return next(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(HOOK)}`, import.meta.url);

// document 最小替身（只為了讓各模組能 import；組合測試前會移除，讓 DOM UI 走 no-op 路徑）
const ctx2d = new Proxy({}, {
  get: (_, k) => (k === 'measureText' ? () => ({ width: 100 }) : () => {}),
  set: () => true,
});
const docStub = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d, style: {} }),
  getElementById: () => null,
  addEventListener: () => {},
};
globalThis.document = docStub;

const fs = await import('node:fs');
const path = await import('node:path');
const { fileURLToPath, pathToFileURL } = await import('node:url');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'src');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const isFn = (f) => typeof f === 'function';

const mainSrc = read('src/main.js');
const code = mainSrc.replace(/\/\/[^\n]*/g, ''); // 去掉註解再比對
// p5-c1 起每幀排程（tick / runFrames / 暫停分支）在 src/core/loop.js，main.js 以 createFrameLoop 注入 updateGame / updateAttract / updateAudio / render
const loopCode = read('src/core/loop.js').replace(/\/\/[^\n]*/g, '');
const frameLoopSrc = (code.match(/createFrameLoop\(\{([\s\S]*?)\n {2}\}\);/) || [])[1] || '';
const loopFn = (name) => (loopCode.match(new RegExp(`const ${name} = \\((?:dt|n, dt)\\) => \\{([\\s\\S]*?)\\n {2}\\};`)) || [])[1] || '';

// ======================= 1. import 圖完整 =======================
{
  const imports = [...mainSrc.matchAll(/^import\s+(?:([\s\S]*?)\s+from\s+)?'([^']+)';/gm)].map((m) => ({ spec: m[1] || '', from: m[2] }));
  const rel = imports.filter((i) => i.from.startsWith('.') && !i.from.endsWith('.css'));
  const problems = [];
  for (const imp of rel) {
    const file = path.join(SRC, imp.from);
    if (!fs.existsSync(file)) {
      problems.push(`${imp.from} 不存在`);
      continue;
    }
    if (imp.from.endsWith('.json')) continue;
    let mod;
    try {
      mod = await import(pathToFileURL(file).href);
    } catch (err) {
      problems.push(`${imp.from} 載入失敗：${err.message}`);
      continue;
    }
    const named = (imp.spec.match(/\{([\s\S]*)\}/) || [])[1];
    if (!named) continue;
    for (const part of named.split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name && !(name in mod)) problems.push(`${imp.from} 缺匯出 ${name}`);
    }
  }
  check(`main.js import 圖完整（${rel.length} 個相對模組、具名匯出都存在）`, problems.length === 0, problems.join('；'));
  const need = ['./weapons/index.js', './weapons/hud.js', './weapons/models.js', './character-animation.js', './blood-fx.js', './audio/index.js',
    './missions/index.js', './navigation.js', './map/big-map.js', './collect/checkins.js', './collect/food-guide.js', './core/landmark-points.js'];
  const lack = need.filter((f) => !rel.some((i) => i.from === f));
  check('main.js import Phase 4 全部模組（武器 / 動畫層 / 流血 / 音效 / 委託 / 導航 / 大地圖 / 打卡 / 圖鑑 / 地標點）', lack.length === 0, lack.join(','));
  check('main.js 不引入新套件（第三方只有 three / @dimforge）', imports.filter((i) => !i.from.startsWith('.')).every((i) => i.from === 'three' || i.from.startsWith('@dimforge/')),
    imports.filter((i) => !i.from.startsWith('.')).map((i) => i.from).join(','));
}

// ======================= 1b. 廣告阻擋字樣（FX3-1）=======================
// 檔名或 import 路徑命中阻擋清單 → 請求被外掛攔下、整個模組圖不執行（console 無錯誤、卡在「準備中…」）
{
  const BLOCK_WORDS = ['beacon', 'ads', 'advert', 'banner', 'track', 'analytics', 'pixel', 'sponsor', 'popup', 'telemetry', 'adserver', 'adsense', 'doubleclick', 'affiliate'];
  const blockedIn = (p) => BLOCK_WORDS.filter((w) => p.toLowerCase().includes(w)); // 子字串比對（阻擋規則多為子字串 / 路徑片段）
  const files = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(f);
      else if (ent.name.endsWith('.js')) files.push(f);
    }
  };
  walk(SRC);
  const badNames = files.map((f) => path.relative(SRC, f)).filter((r) => blockedIn(r).length);
  check(`src/**/*.js 檔名（含目錄）不含廣告阻擋字樣（${files.length} 檔）`, badNames.length === 0, badNames.join(','));
  const badImports = [];
  let nImports = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)) {
      nImports++;
      if (blockedIn(m[1]).length) badImports.push(`${path.relative(SRC, f)} → ${m[1]}`);
    }
  }
  check(`src/**/*.js 的 import 路徑不含廣告阻擋字樣（${nImports} 條）`, nImports > 0 && badImports.length === 0, badImports.join('；'));
  check('src/missions/beacon.js 已刪除、改為 light-pillar.js（createBeaconPool 匯出保留）',
    !fs.existsSync(path.join(SRC, 'missions/beacon.js')) && fs.existsSync(path.join(SRC, 'missions/light-pillar.js'))
    && /import \{ createBeaconPool \} from '\.\/light-pillar\.js';/.test(read('src/missions/index.js')));
  check('阻擋字樣檢查器自身：beacon.js / ads/x.js / tracker.js / pixel.js 會被抓到，light-pillar.js / mobile.js / traffic.js 不會',
    blockedIn('missions/beacon.js').length && blockedIn('ads/x.js').length && blockedIn('tracker.js').length && blockedIn('pixel.js').length
    && !blockedIn('missions/light-pillar.js').length && !blockedIn('mobile.js').length && !blockedIn('traffic.js').length && !blockedIn('traffic-lights.js').length);
}

// ======================= 2. 附錄 B 接線靜態檢查 =======================
{
  const missionsIdxSrc = read('src/missions/index.js');
  const has = (list) => list.filter((s) => !(s instanceof RegExp ? s.test(code) : code.includes(s)));
  const groups = [
    ['武器：createWeapons（raycast / sweep / playAnim / getBatSegment / now = gameTime / manifest）', [
      /createWeapons\(\{[\s\S]*?raycast,[\s\S]*?sweep,[\s\S]*?playAnim:[\s\S]*?getBatSegment:[\s\S]*?\}\);/, 'now: () => gameTime', 'manifest: getCharacterManifest()']],
    ['武器：raycast = pw.castRay + 排除玩家膠囊 + collider → actor（router.entityOf）+ surface vehicle / world', [
      'pw.castRay(', 'character.collider', 'router.entityOf(', "ent.kind === 'pedestrian'", "'vehicle' : 'world'"]],
    ['武器：sweep = 膠囊（半長 = |to − from| / 2）intersections 行人組', ['new RAPIER.Capsule(', 'pw.intersections(sweepPos, sweepRot, sweepShape', 'queryGroups(G_PED)', 'Math.hypot(dx, dy, dz) / 2']],
    ['武器：模型掛 weapon_socket（attachWeapon + socketQuaternion）、空手拿下、駕駛隱藏', ['loadWeaponModels()', 'attachWeapon(player.character', 'socketQuaternion.toArray()', 'detachWeapon(player.character)', "m.object.visible = state.mode !== 'drive'", 'makeBatSegment(']],
    ['武器：持武器姿勢 / 動畫注入 / 後座', ['player.weaponLayer.setPose(', 'player.weaponLayer.play(name)', 'player.weaponLayer.addRecoil(', 'weapons.recoilKick()', 'rig.addRecoil(kick.pitch, kick.yaw)']],
    ['武器：輸入 slot1/2/3 → select、weaponCycle → cycle、reload → reload、攻擊（手槍 down / 其餘 pressed）', [
      'snap.pressed.slot1', 'weapons.select(0)', 'weapons.select(2)', 'snap.pressed.weaponCycle', 'weapons.cycle()', 'snap.pressed.reload', 'weapons.reload()', "weapons.current === 'pistol' ? snap.down.attack : snap.pressed.attack", 'weapons.attack(aim)']],
    ['武器：步行才處理武器輸入、每幀 weapons.update(dt, aim)、肩後鏡頭 aim、瞄準中滾輪不縮放', [
      "if (state.mode === 'walk') handleWeaponInput(snap)", 'weapons.update(dt, aim)', 'aim: aiming', 'if (aiming) input.wheel = 0', 'snap.down.aim']],
    ['武器：槍聲 → 行人 hear、彈藥拾取（update / pickup:ammo → addAmmo / 上限 120）、武器 HUD（駕駛隱藏）', [
      'gunshotListeners(bus, () => traffic.brains.values())', 'createAmmoPickups({', 'pickups.update(dt, player.pos)', "bus.on('pickup:ammo'", 'weapons.addAmmo(', 'WEAPONS.pistol.reserveMax',
      "createWeaponHud({ root: document.body, touchRoot: document.getElementById('touch-ui')", 'whud.update(dt, whudState)', 'whud.setDriving(true)', 'whud.setDriving(false)', 'whud.setVisible(']],
    ['戰鬥：combat hit → combat:hit → blood.onHit；ped:knockdown → blood.onKnockdown；bat / bullet 擊倒掉錢', [
      "combat.on('hit', (e) => bus.emit('combat:hit', e))", "bus.on('combat:hit', (e) => blood.onHit(e))", "bus.on('ped:knockdown', (e) => blood.onKnockdown(e))", "e.cause !== 'bat' && e.cause !== 'bullet'", "'loot')", 'pedKnockdownPayload(e)']],
    ['戰鬥：機車摔落改用 combat.knockdownActor（不再直接改 entries）', ['combat.knockdownActor(player.actor', /^(?![\s\S]*combat\.entries)/]],
    ['音效：createAudio、pointerdown / keydown / touchend unlock、每幀 update（rpm01 / skid01 / twoWheeler / nearJunction / walkSpeed / grounded / paused）', [
      'createAudio({ bus, settings })', "['pointerdown', 'keydown', 'touchend']", 'audio.unlock()', 'audio.update(dt, st)', 'st.rpm01', 'st.skid01', 'st.twoWheeler', 'st.nearJunction', 'st.walkSpeed', 'st.grounded', 'st.paused',
      /createFrameLoop\(\{[\s\S]*?\bupdateAudio,[\s\S]*?\}\);/]], // 每幀呼叫在 core/loop.js tick（見下方「暫停時世界停止更新」）
    ['委託：createMissions（landmarks / addMoney / fetchJson / now / heightAt）、update ctx（simDt）、speedScale → player、onPlayerKo、onVehicleImpact', [
      /createMissions\(\{[\s\S]*?landmarks: landmarkPts,[\s\S]*?addMoney:[\s\S]*?fetchJson,[\s\S]*?now: \(\) => gameTime,[\s\S]*?heightAt,[\s\S]*?\}\);/, 'missions.update(worldStep.simDt, missionCtx)', 'player.speedScale = missions.speedScale()', 'missions.onPlayerKo()', 'missions.onVehicleImpact(impactArg)']],
    ['導航 / 大地圖：buildRoadGraph(surfaceRoads)、createNavigator、nav.update、hud route、M → bigMap.open、onPick → setDestination', [
      'buildRoadGraph(surfaceRoads)', 'createNavigator({ bus, graph, scene, heightAt })', 'nav.update(dt, focus)', 'route: nav.route()', 'bigMap.open()', "nav.setDestination(x, z, '地圖標記', 'map', focus)", 'getRoute: () => nav.route()', 'landmarks: landmarkPts']],
    ['打卡 / 圖鑑：createCheckins / createFoodGuide、food.update、ui:openGuide 與 KeyG 兩個入口、createMenu onOpenGuide', [
      'createCheckins({ bus, landmarks: landmarkPts', 'createFoodGuide({ bus, scene, root: document.body, fetchJson', 'food.update(dt, player.pos, camera)', "bus.on('ui:openGuide'", "input.wasPressed('KeyG')", 'onOpenGuide: () => openGuide()']],
    ['地標點：landmarkPoints(manifest ?? [], projectLatLon)', ["landmarkPoints((await fetchJson('models/manifest.json')) ?? [], projectLatLon)"]],
    ['interactable 仲裁（missions / checkins / food / pickups）→ 提示（setInteractPrompt?. 退回 setPrompt）、E → act()', [
      'missions.nearest(pos)', 'checkins.nearest(pos)', 'food.nearest(pos)', 'pickups.nearest(pos)', 'pickInteractable(interCands)', 'hud.setInteractPrompt', 'snap.pressed.interact && inter', 'inter.act()']],
    ['小地圖 / 大地圖標記合併（missions / nav / checkins / food / pickups）', ['missions.markers()', 'nav.markers()', 'checkins.markers()', 'food.markers()', 'pickups.markers()', 'markers: collectMarkers(hudMarkers, true)']],
    ['面板：開啟時停輸入 / 放開滑鼠鎖定 / 世界暫停；大地圖 / 圖鑑不渲染 3D；Esc 關閉；滑鼠鎖定遺失不誤開暫停選單', [
      'if (syncPanels()) return;', 'input.enabled = false;', 'missions.isModalOpen()', 'if (hide3D()) return;', "e.code === 'Escape'", "window.addEventListener('keydown', onPanelKey, true)", '!menu.isOpen() && !panelOpen()', 'touch || panelOpen()']],
    ['存檔 v2：version SAVE_VERSION、weapons / missions / collect、restore、統計 missionsDone / missionsFailed / shotsFired', [
      'version: SAVE_VERSION', 'weapons: weapons.serialize()', 'missions: missions.serialize()', 'collect: { checkins: checkins.serialize(), foods: food.serialize() }',
      'weapons.restore(save.weapons)', 'missions.restore(save.missions)', 'checkins.restore(save.collect)', 'food.restore(save.collect)',
      'trackMissionStats(', 'extraStats.shotsFired++', 'getStats: () => currentStats()',
      // 完成 / 失敗計數由 missions/index.js 的 MISSION_STAT_EVENTS 訂閱（缺少時塞入必不命中的標籤，讓 lack 列出）
      ...["'mission:complete'", "'mission:fail'"].filter((s) => !missionsIdxSrc.includes(s)).map((s) => `missions/index.js 缺 ${s}`)]],
    ['__game 新欄位（weapons / audio / blood / missions / nav / bigMap / checkins / food / giveAmmo / nearestPed / teleport / startMission）', [
      'weapons, audio, blood, missions, nav, bigMap, checkins, food', 'giveAmmo(', 'nearestPed()', 'teleport(x, z)', 'startMission(slug)', '{ id: best.id, dist: bestD, hp: best.hp, state: combat.stateOf(best) }']],
  ];
  for (const [name, list] of groups) {
    const lack = has(list);
    check(`main.js 接線：${name}`, lack.length === 0, lack.map(String).join(' | '));
  }
  check('彈藥盒不放置：main.js createAmmoPickups points 為空、不引用 DEFAULT_AMMO_POINTS',
    /createAmmoPickups\(\{[^}]*points: \[\]/.test(mainSrc) && !mainSrc.includes('DEFAULT_AMMO_POINTS'));
  // 規矩
  check('main.js：武器模型換裝時機（weapon:equip 先掛起 → layer swap 換手點換；equip 動作沒播 / 播完 / 打斷即換；讀檔 state 非 equipping 立即換）',
    ["player.weaponLayer.on('swap', finishWeaponSwap)", "player.weaponLayer.on('finished', equipEnded)", "player.weaponLayer.on('cancel', equipEnded)",
      "if (weapons.state !== 'equipping') applyWeaponModel()", 'if (!(dur > 0)) finishWeaponSwap()', "name === 'weapon_equip' && !equipStarting"].every((x) => code.includes(x))
    && !code.includes("bus.on('weapon:equip', () => applyWeaponModel())"));
  check('main.js：不用 alert / confirm', !/\balert\(|\bconfirm\(/.test(code));
  // FX3-5：觸控圖鑑鈕（touch.js 預設隱藏佔位，整合層以同 id 帶 onTap 重新註冊）
  check('main.js：觸控圖鑑鈕 registerTouchButton({ id: tb-guide, label 圖鑑, slot tl3, showWhen walk, onTap → openGuide })、自 ./touch.js import、在 Input（initTouch）與 openGuide 之後',
    /^import \{[^}]*\bregisterTouchButton\b[^}]*\} from '\.\/touch\.js';/m.test(mainSrc)
    && code.includes("registerTouchButton({ id: 'tb-guide', label: '圖鑑', slot: 'tl3', showWhen: 'walk', onTap: () => openGuide() });")
    && code.indexOf('new Input(') >= 0 && code.indexOf('new Input(') < code.indexOf("registerTouchButton({ id: 'tb-guide'")
    && code.indexOf('const openGuide = ') < code.indexOf("registerTouchButton({ id: 'tb-guide'"));
  // FX3-4：__game.stepFrames 手動推幀也呼叫音效 update（同 tick）
  {
    // stepFrames → loop.runFrames（core/loop.js）：每幀 updateWorld（暫停即略過）後緊接 d.updateAudio(dt)
    const sf = (code.match(/stepFrames\(n = 1, dt = 1 \/ 60\) \{([\s\S]*?)\n {6}\},/) || [])[1] || '';
    const rf = loopFn('runFrames');
    check('main.js + core/loop.js：__game.stepFrames 每幀呼叫 updateAudio(dt)（暫停中也呼叫，同 tick）',
      /loop\.runFrames\(n, dt\)/.test(sf) && /for \(let i = 0; i < n; i\+\+\) \{[\s\S]*?updateWorld\(dt\);\s*d\.updateAudio\(dt\);/.test(rf));
  }
  // FX3-2：易碎貨物 = 玩家駕駛車輛的每次碰撞（≥ 4 m/s）；不經 vehicle:crash（只在 ≥ 8 m/s 發出）
  check('main.js：易碎碰撞接線（contacts relSpeed 先於耐久計算回報、vehicle:damaged delta 反推、門檻 IMPACT_MIN、不經 vehicle:crash）',
    /import \{[^}]*IMPACT_MIN as MISSION_IMPACT_MIN[^}]*\} from '\.\/missions\/index\.js';/.test(mainSrc)
    && /if \(mine\) reportImpact\(relSpeed\);\s*dmg\.onImpact\(/.test(code)
    && /bus\.on\('vehicle:damaged', \(\{ vehicle, delta \}\) => \{[\s\S]*?byPlayer\(vehicle\)[\s\S]*?reportImpact\(impactSpeedFromDamage\(vehicle, delta\)\)/.test(code)
    && !/bus\.on\('vehicle:crash'[^\n]*onVehicleImpact/.test(code));
  check('main.js + core/loop.js：暫停時世界停止更新但照常渲染（tick 結構保留）、音效暫停中也 update',
    /^\s*if \(d\.isPaused\(\)\) return;\s*if \(d\.isStarted\(\)\) d\.updateGame\(dt\);\s*else d\.updateAttract\(dt\);\s*$/.test(loopFn('updateWorld'))
    && /updateWorld\(dt\);\s*d\.updateAudio\(dt\);[\s\S]*d\.render\(\);/.test(loopFn('tick'))
    && ['isPaused: () => state.paused', 'isStarted: () => state.started', 'updateGame,', 'updateAttract,', 'updateAudio,', 'render,'].every((x) => frameLoopSrc.includes(x))
    && /\bloop\.frame\(\);/.test(code));
  // 每幀路徑不配置新物件：Phase 4 每幀函式內不出現物件 / 陣列字面值或 new（事件 payload 除外）
  const bodyOf = (name) => (code.match(new RegExp(`const ${name} = \\([^)]*\\) => \\{([\\s\\S]*?)\\n {2}\\};`)) || [])[1] || null;
  const perFrame = ['fillAim', 'handleWeaponInput', 'updateWeaponPose', 'collectMarkers', 'nearestInteractable', 'setPrompts', 'updateAudio', 'nearestJunction', 'raycast', 'sweep', 'muzzleWorld'];
  const alloc = [];
  for (const n of perFrame) {
    const b = bodyOf(n);
    if (b === null) alloc.push(`${n}（找不到）`);
    else if (/new [A-Z]|=\s*\{\s*[a-z]|=\s*\[|\.map\(|\.filter\(|\.slice\(/.test(b)) alloc.push(n);
  }
  check('Phase 4 每幀路徑（瞄準 / 武器輸入 / 標記合併 / 仲裁 / 音效狀態 / raycast / sweep）不配置新物件', alloc.length === 0, alloc.join(','));
  check('main.js：小地圖標記不再每幀 filter / map 配置新陣列', !/markers: vehicles\.vehicles\.filter/.test(code));
}

// ======================= 3. main.js 純函式 =======================
const pure = (() => {
  const m = mainSrc.match(/\/\/ @integration-p3:pure-begin\n([\s\S]*?)\/\/ @integration-p3:pure-end/);
  if (!m) return null;
  try {
    return new Function(`${m[1]}\nreturn { pickInteractable, statsWithExtra, capsuleRotation };`)();
  } catch (err) {
    console.log(`INFO  純函式區塊求值失敗：${err.message}`);
    return null;
  }
})();
check('main.js 純函式區塊含 pickInteractable / statsWithExtra / capsuleRotation 且可獨立求值', !!pure);
if (pure) {
  const it = (id, priority, dist) => ({ id, priority, dist, text: id, act() {} });
  const mission = it('m', 3, 20);
  const check2 = it('c', 2, 1);
  const food = it('f', 1, 0.5);
  const ammo = it('a', 0, 0.1);
  check('仲裁：任務 3 > 打卡 2 > 小吃 1 > 彈藥 0（不看距離）', pure.pickInteractable([mission, check2, food, ammo]) === mission && pure.pickInteractable([null, check2, food, ammo]) === check2
    && pure.pickInteractable([null, null, food, ammo]) === food && pure.pickInteractable([null, null, null, ammo]) === ammo);
  const nearA = it('a1', 2, 3);
  const nearB = it('a2', 2, 1.5);
  check('仲裁：同 priority 取近者；全空回 null；priority / dist 非數當 0 / ∞', pure.pickInteractable([nearA, nearB]) === nearB && pure.pickInteractable([null, null]) === null
    && pure.pickInteractable([{ id: 'x' }, it('y', 0, 5)]).id === 'y');
  const s = pure.statsWithExtra({ pedsKnockedOut: 4, kos: 1, missionsDone: 1 }, { missionsDone: 3, missionsFailed: 2, shotsFired: 17, pedsKnockedOut: 2 });
  check('統計合併：missionsDone / missionsFailed / shotsFired 取整合層值、pedsKnockedOut 加上 bat / bullet 擊倒、其他保留', s.missionsDone === 3 && s.missionsFailed === 2 && s.shotsFired === 17 && s.pedsKnockedOut === 6 && s.kos === 1);
  // 四元數把 +Y 轉到 u
  const rot = (q, v) => {
    const { x, y, z, w } = q;
    const ix = w * v.x + y * v.z - z * v.y;
    const iy = w * v.y + z * v.x - x * v.z;
    const iz = w * v.z + x * v.y - y * v.x;
    const iw = -x * v.x - y * v.y - z * v.z;
    return { x: ix * w + iw * -x + iy * -z - iz * -y, y: iy * w + iw * -y + iz * -x - ix * -z, z: iz * w + iw * -z + ix * -y - iy * -x };
  };
  const dirs = [[1, 0, 0], [0, 0, 1], [0.3, 0.8, -0.5], [0, -1, 0], [0, 1, 0], [-2, -0.1, 0.4]];
  let worst = 0;
  const q = { x: 0, y: 0, z: 0, w: 1 };
  for (const [dx, dy, dz] of dirs) {
    pure.capsuleRotation(dx, dy, dz, q);
    const l = Math.hypot(dx, dy, dz);
    const r = rot(q, { x: 0, y: 1, z: 0 });
    worst = Math.max(worst, Math.hypot(r.x - dx / l, r.y - dy / l, r.z - dz / l), Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1));
  }
  pure.capsuleRotation(0, 0, 0, q);
  check('capsuleRotation：+Y 轉到任意方向（含 ±Y）誤差 < 1e-9、單位長；零向量 → 單位四元數', worst < 1e-9 && q.w === 1 && q.x === 0, `誤差 ${worst.toExponential(2)}`);
}

// ======================= 4. 模組組合：weapons + combat + blood + audio =======================
delete globalThis.document; // 各模組 DOM UI 走 no-op（node 無 document）
const THREE = await import('three');
const { createBus } = await import('../../src/core/events.js');
const { createSettings } = await import('../../src/core/settings.js');
const { CombatSystem, pedKnockdownPayload } = await import('../../src/combat.js');
const W = await import('../../src/weapons/index.js');
const { createBloodFx } = await import('../../src/blood-fx.js');
const { createAudio } = await import('../../src/audio/index.js');
const { createMissions } = await import('../../src/missions/index.js');
const { createCheckins } = await import('../../src/collect/checkins.js');
const { createFoodGuide } = await import('../../src/collect/food-guide.js');
const { landmarkPoints } = await import('../../src/core/landmark-points.js');
const { projectLatLon } = await import('../../src/landmarks/index.js');
const save = await import('../../src/save.js');
const economyMod = await import('../../src/economy.js');

const errors = [];
const infos = [];
const origError = console.error;
const origInfo = console.info;
console.error = (...a) => errors.push(a.join(' '));
console.info = (...a) => infos.push(a.join(' '));

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
// 假 AudioContext（只記錄 start；介面同 tools/test/audio.mjs）
class FakeParam {
  constructor(v = 0) { this.value = v; }
  setValueAtTime() {}
  linearRampToValueAtTime() {}
  exponentialRampToValueAtTime() {}
  setTargetAtTime() {}
  cancelScheduledValues() {}
}
class FakeNode {
  constructor(ctx) { this.ctx = ctx; }
  connect(n) { return n; }
  disconnect() {}
}
class FakeSource extends FakeNode {
  start() { this.ctx.starts++; }
  stop() {}
}
class FakeAudioContext {
  constructor() {
    this.starts = 0;
    this.currentTime = 0;
    this.sampleRate = 8000;
    this.state = 'suspended';
    this.destination = {};
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
  createGain() { const n = new FakeNode(this); n.gain = new FakeParam(1); return n; }
  createBiquadFilter() { const n = new FakeNode(this); n.frequency = new FakeParam(350); n.Q = new FakeParam(1); return n; }
  createOscillator() { const n = new FakeSource(this); n.frequency = new FakeParam(440); return n; }
  createBufferSource() { const n = new FakeSource(this); n.buffer = null; return n; }
  createStereoPanner() { const n = new FakeNode(this); n.pan = new FakeParam(0); return n; }
  createBuffer(ch, len, sr) { const d = new Float32Array(len); return { length: len, sampleRate: sr, duration: len / sr, getChannelData: () => d }; }
}

// 角色替身（combat Actor 契約）
function makeActor(id, kind, x, z, yaw) {
  const a = {
    id, kind, pos: { x, y: 0, z }, yaw, hp: 100, maxHp: 100, faction: kind === 'player' ? 'player' : 'civilian', untargetable: false,
    recoverOnKo: kind !== 'player',
    anim: { state: 'idle', trigger(name) { this.state = name; return true; }, on() { return () => {}; } },
    body: { knockdown() {}, settleCheck: () => ({ settled: true, clearToStand: true }), standUp() {} },
  };
  return a;
}

{
  let t = 0;
  const bus = createBus();
  const settings = createSettings({ storage: memStorage() });
  const combat = new CombatSystem({ now: () => t });
  const hero = makeActor('player', 'player', 0, 0, 0);
  const ped = makeActor('ped1', 'pedestrian', 0, 3, Math.PI); // 面向玩家
  combat.register(hero);
  combat.register(ped);
  // 同 main.js 的轉發
  combat.on('hit', (e) => bus.emit('combat:hit', e));
  combat.on('knockdown', (e) => {
    const p = pedKnockdownPayload(e);
    if (p) bus.emit('ped:knockdown', p);
  });
  const scene = new THREE.Scene();
  const blood = createBloodFx({ scene, settings, heightAt: () => 0, loadTexture: (url, ok, fail) => fail() });
  bus.on('combat:hit', (e) => blood.onHit(e));
  bus.on('ped:knockdown', (e) => blood.onKnockdown(e));
  const audio = createAudio({ bus, settings, AudioContextCtor: FakeAudioContext });
  audio.unlock();
  const hits = [];
  const kds = [];
  const swings = [];
  bus.on('combat:hit', (e) => hits.push(e));
  bus.on('ped:knockdown', (e) => kds.push(e));
  bus.on('weapon:swing', (e) => swings.push(e));
  // sweep 替身：膠囊（線段 + 半徑）與行人軸線（腳底 0–1.8 m）最近距離 < 半徑 + 0.3 m
  const segDist = (a, b, p) => {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const abz = b.z - a.z;
    const l2 = abx * abx + aby * aby + abz * abz || 1;
    let k = ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / l2;
    k = Math.max(0, Math.min(1, k));
    return Math.hypot(a.x + abx * k - p.x, a.y + aby * k - p.y, a.z + abz * k - p.z);
  };
  const sweepOut = [];
  let sweeps = 0;
  const sweep = (from, to, r, { excludeActor } = {}) => {
    sweeps++;
    sweepOut.length = 0;
    for (const a of [hero, ped]) {
      if (a === excludeActor) continue;
      const chest = { x: a.pos.x, y: Math.min(Math.max((from.y + to.y) / 2, 0), 1.8), z: a.pos.z };
      if (segDist(from, to, chest) < r + 0.3) sweepOut.push(a);
    }
    return sweepOut;
  };
  const player = { actor: hero, controlLocked: false, punch: () => combat.requestPunch(hero) };
  const weapons = W.createWeapons({ bus, combat, player, settings, now: () => t, isTouch: false, raycast: () => null, sweep });
  const step = (sec, dt = 1 / 60) => {
    for (let i = 0; i < Math.round(sec / dt); i++) {
      t += dt;
      weapons.update(dt, null);
      combat.update(dt);
      blood.update(dt, null);
      audio.update(dt, { x: 0, z: 0, yaw: 0, driving: false, walkSpeed: 0, grounded: true, nearJunction: null, paused: false });
    }
  };
  const ok = weapons.select(1);
  step(0.4);
  // 持棒移動：往行人走近到 1.2 m
  for (let i = 0; i < 30; i++) {
    hero.pos.z += 1.8 / 30;
    step(1 / 60);
  }
  const plays0 = audio.stats().plays || 0;
  const a1 = weapons.attack(null);
  step(1.0);
  const a2 = weapons.attack(null);
  step(1.2);
  check('組合：持棒（select 1）移動後揮兩下都出手、有掃掠', ok && weapons.current === 'bat' && a1 && a2 && sweeps > 0 && swings.filter((s) => s.weapon === 'bat').length === 2, `swings ${swings.length} sweeps ${sweeps}`);
  const batHits = hits.filter((e) => e.weapon === 'bat' && e.target === ped);
  const FIELDS = ['attacker', 'target', 'weapon', 'damage', 'hp', 'x', 'y', 'z', 'dirX', 'dirZ', 'side', 'byPlayer', 'knockdown'];
  check('組合：combat:hit（球棒）2 次、§10 欄位齊全、byPlayer、傷害 35、第二下擊倒', batHits.length === 2 && batHits.every((e) => FIELDS.every((k) => k in e)) && batHits.every((e) => e.byPlayer && e.damage === W.WEAPONS.bat.damage)
    && batHits[0].knockdown === false && batHits[1].knockdown === true, batHits.map((e) => `${e.damage}/${e.hp}/${e.knockdown}`).join(' '));
  const kd = kds.find((e) => e.ped === ped);
  check('組合：ped:knockdown cause = bat、weapon = bat、byPlayer、帶 x / z', !!kd && kd.cause === 'bat' && kd.weapon === 'bat' && kd.byPlayer === true && Number.isFinite(kd.x) && Number.isFinite(kd.z), kd ? `${kd.cause}/${kd.weapon}` : '無');
  const bs = blood.stats();
  check('組合：血跡生成（倒地 ≥ 1 片貼片、有血滴或已落地）且不超上限 16 / 32', bs.decals >= 1 && bs.decals <= 16 && bs.drops <= 32, `decals ${bs.decals} drops ${bs.drops}`);
  const as = audio.stats();
  check('組合：音效播放（揮棒 + 擊中）、音源 ≤ 12', (as.plays || 0) - plays0 >= 3 && as.voices <= 12 && as.unlocked === true, `plays +${(as.plays || 0) - plays0} voices ${as.voices}`);
  // 關閉血液 → 清空且不再生成
  settings.set('showBlood', false);
  blood.onHit(batHits[0]);
  check('組合：settings.showBlood = false → 血跡清空、不再生成', blood.stats().decals === 0 && blood.stats().drops === 0);
  settings.set('showBlood', true);

  // 手槍：開槍 → weapon:fire → gunshotListeners → 30 m 內行人 hear；統計 shotsFired（同 main.js 以 byPlayer 累加）
  const heard = [];
  const brains = [
    { actor: { pos: { x: 10, z: 0 } }, hear: (e) => heard.push(['near', e.type]) },
    { actor: { pos: { x: 80, z: 0 } }, hear: (e) => heard.push(['far', e.type]) },
  ];
  W.gunshotListeners(bus, () => brains);
  let shots = 0;
  bus.on('weapon:fire', (e) => {
    if (e && e.byPlayer) shots++;
  });
  step(2);
  weapons.select(2);
  step(0.4);
  const aim = { origin: { x: 0, y: 1.6, z: -2 }, dir: { x: 0, y: 0, z: 1 }, aiming: true };
  const f1 = weapons.attack(aim);
  step(0.3);
  const f2 = weapons.attack(aim);
  step(0.3);
  check('組合：手槍兩發 → weapon:fire 2 次（byPlayer）、彈匣 12 → 10', f1 && f2 && shots === 2 && weapons.ammo().mag === 10, `shots ${shots} mag ${weapons.ammo().mag}`);
  check('組合：槍聲只讓 30 m 內行人 hear({ type: gunshot })', heard.length === 2 && heard.every(([w, ty]) => w === 'near' && ty === 'gunshot'), JSON.stringify(heard));
  const kp = weapons.recoilKick().pitch; // 回傳物件重用：先取值
  check('組合：開槍後 recoilKick 有 pitch 增量（讀後歸零）', kp !== 0 && weapons.recoilKick().pitch === 0, `pitch ${kp.toFixed(4)}`);
  // 彈藥拾取 → addAmmo（同 main.js 的 pickup:ammo 接線）
  const pickups = W.createAmmoPickups({ bus, points: [{ x: 0, z: 0 }], canPickup: () => weapons.ammo().reserve < W.WEAPONS.pistol.reserveMax });
  bus.on('pickup:ammo', (e) => weapons.addAmmo(e.amount));
  let pickedUp = 0;
  bus.on('pickup:ammo', () => pickedUp++);
  pickups.update(1 / 60, { x: 0.5, y: 0, z: 0 });
  check('組合：無限備彈（∞）→ 彈藥盒不拾取、不提示（canPickup 同 main.js 為 false）', weapons.ammo().reserve === Infinity && pickedUp === 0 && pickups.nearest({ x: 0.5, z: 0 }) === null && weapons.addAmmo(12) === 0);
  // 無限備彈：連射超過原總量（12 + 36）仍可射，期間自動換彈
  let fired = 0;
  for (let i = 0; i < 600 && fired < 60; i++) {
    if (weapons.attack(aim)) fired++;
    step(0.25);
  }
  const reloads = [];
  bus.on('weapon:reload', (e) => reloads.push(e));
  for (let i = 0; i < 40 && weapons.ammo().mag > 0; i++) {
    weapons.attack(aim);
    step(0.25);
  }
  const needReload = weapons.ammo().mag === 0 && weapons.state === 'reloading' && weapons.attack(aim) === false;
  step(1.5);
  check('組合：無限備彈連射 60 發（> 48）仍可射；彈匣打完需換彈、換彈後 12', fired === 60 && needReload && weapons.ammo().mag === 12 && reloads.at(-1).phase === 'end', `fired ${fired} mag ${weapons.ammo().mag}`);
  // 存檔 v2：weapons.serialize 往返
  const ws = weapons.serialize();
  const w2 = W.createWeapons({ bus: createBus(), combat, player, settings, now: () => t });
  w2.restore(ws);
  check('組合：weapons.serialize → restore 往返（槽位 / 彈匣 / 備彈）', w2.slot === 2 && w2.ammo().mag === ws.ammo.pistol.mag && w2.ammo().reserve === Infinity && Number.isInteger(ws.ammo.pistol.reserve));
  const wjs = JSON.stringify(save.validateSave({ ...save.defaultSave(), weapons: ws }));
  const w3 = W.createWeapons({ bus: createBus(), combat, player, settings, now: () => t });
  w3.restore(save.validateSave(JSON.parse(wjs)).weapons);
  check('組合：無限備彈存檔往返（validateSave → JSON → restore）仍 ∞、JSON 無 null / Infinity', !/Infinity/.test(wjs) && !/null/.test(JSON.stringify(JSON.parse(wjs).weapons)) && w3.ammo().reserve === Infinity && w3.ammo().mag === ws.ammo.pistol.mag);
  audio.dispose();
}

// ======================= 5. 缺檔路徑（美術資產全缺）=======================
{
  const nullJson = async () => null;
  const htmlJson = async () => '<!doctype html>';
  let threw = null;
  let models = null;
  let missions = null;
  let food = null;
  let checkins = null;
  const e0 = errors.length;
  try {
    models = await W.loadWeaponModels('models/weapons/', { fetchJson: nullJson, loadGltf: async () => null });
    const lmEmpty = landmarkPoints([], projectLatLon);
    const lmBad = landmarkPoints(null, projectLatLon);
    check('缺檔：地標 manifest 缺 → landmarkPoints 回 []', Array.isArray(lmEmpty) && lmEmpty.length === 0 && Array.isArray(lmBad) && lmBad.length === 0);
    const manifest = JSON.parse(read('public/models/manifest.json'));
    const lms = landmarkPoints(manifest, projectLatLon);
    let now = 0;
    missions = createMissions({ bus: createBus(), landmarks: lms, fetchJson: htmlJson, now: () => now, rng: () => 0.3 });
    await missions.ready;
    missions.update(1 / 60, { x: 0, z: 0, driving: false });
    checkins = createCheckins({ bus: createBus(), landmarks: [] });
    food = createFoodGuide({ bus: createBus(), fetchJson: nullJson });
    await food.ready;
    check('缺檔：委託 manifest 回退成 index.html → 內建委託（≥ 1）、開放起點、speedScale 1', missions.source() === 'builtin' && missions.catalog().length >= 1 && missions.offers().length >= 1 && missions.speedScale() === 1,
      `${missions.source()} ${missions.catalog().length}`);
    check('缺檔：打卡無地標 → nearest null、progress 0 / 0', checkins.nearest({ x: 0, z: 0 }) === null && checkins.progress().total === 0);
    check('缺檔：小吃 manifest 缺 → 內建小吃、markers 有收集點', food.source() === 'builtin' && food.markers().length > 0, `${food.source()} ${food.markers().length}`);
    // startMission 同款流程（無 UI → act() 直接接單）→ heavy 委託的 speedScale / 存檔
    const off = missions.catalog().find((m) => missions.offers().includes(m.slug));
    const it = off ? missions.nearest(off.from) : null;
    if (it) it.act();
    const act = missions.active();
    const ser = missions.serialize();
    check('委託：以起點地標 nearest → act() 接單（__game.startMission 同款）→ active、serialize.active', !!act && ser.active && ser.active.slug === off.slug, off ? off.slug : '無可接委託');
  } catch (err) {
    threw = err;
  }
  check('缺檔：武器模型全缺 → 佔位幾何（placeholder）且有 grip / tip / muzzle / socketQuaternion', !!models && models.bat.placeholder && models.pistol.placeholder && !!models.bat.grip && !!models.bat.tip && !!models.pistol.muzzle && !!models.bat.socketQuaternion);
  check('缺檔：全部安靜退回（不丟例外、無 console.error、有 console.info）', threw === null && errors.length === e0 && infos.length > 0, threw ? String(threw && threw.stack) : errors.slice(e0).join(' | '));
  if (missions) missions.dispose();
  if (food) food.dispose();
}

// ======================= 5b. 易碎委託 × 碰撞接線（FX3-2，main.js 片段實際求值）=======================
{
  const { createVehicleDamage, impactDamage, DAMAGE_MIN_SPEED, DAMAGE_EXP } = await import('../../src/vehicle-damage.js');
  const { IMPACT_MIN, impactDamagePct } = await import('../../src/missions/index.js');
  const fnSrc = (mainSrc.match(/\nfunction impactSpeedFromDamage\([\s\S]*?\n\}\n/) || [])[0];
  const wireSrc = (mainSrc.match(/\n {2}const impactArg = \{ relSpeed: 0 \};[\s\S]*?\n {2}bus\.on\('vehicle:damaged'[\s\S]*?\n {2}\}\);\n/) || [])[0];
  check('main.js：找得到 impactSpeedFromDamage 與碰撞 → 委託接線片段', !!fnSrc && !!wireSrc);
  if (fnSrc && wireSrc) {
    const build = new Function('impactDamage', 'DAMAGE_MIN_SPEED', 'DAMAGE_EXP', 'MISSION_IMPACT_MIN', 'bus', 'dmg', 'missions', 'byPlayer',
      `${fnSrc}\n${wireSrc}\nreturn { impact, impactSpeedFromDamage };`);
    // 反推：impactDamage(v, s) → impactSpeedFromDamage(v, delta) ≈ s
    const car = { spec: { mass: 1400 } };
    const moto = { spec: { mass: 180, twoWheeler: true } };
    const probe = build(impactDamage, DAMAGE_MIN_SPEED, DAMAGE_EXP, IMPACT_MIN, { on() {} }, null, null, () => false);
    let worst = 0;
    for (const v of [car, moto, { spec: { mass: 2400 } }]) {
      for (const sp of [4.5, 6, 7.9, 12, 20]) worst = Math.max(worst, Math.abs(probe.impactSpeedFromDamage(v, impactDamage(v, sp, 'static')) - sp));
    }
    check('impactSpeedFromDamage 為 impactDamage 的反函數（轎車 / 機車 / 重車，4.5–20 m/s 誤差 < 1e-9）', worst < 1e-9 && probe.impactSpeedFromDamage(car, 0) === 0, `誤差 ${worst.toExponential(2)}`);

    const bus = createBus();
    let now = 0;
    const ms = createMissions({ bus, fetchJson: async () => null, now: () => now, rng: () => 0.3,
      landmarks: landmarkPoints(JSON.parse(read('public/models/manifest.json')), projectLatLon) });
    await ms.ready;
    ms.update(1 / 60, { x: 0, z: 0, driving: false });
    const frag = ms.catalog().find((m) => (m.conditions || []).includes('fragile') && ms.offers().includes(m.slug));
    const it = frag ? ms.nearest(frag.from) : null;
    if (it) it.act();
    check('組合：易碎委託接單（act）', !!ms.active() && ms.active().damagePct === 0, frag ? frag.slug : '無開放中的易碎委託');
    const dmgBus = createBus();
    const dmg = createVehicleDamage({ bus: dmgBus, THREE, scene: new THREE.Scene() });
    const mine = { spec: { mass: 1400 }, name: 'player-car' };
    const other = { spec: { mass: 1400 }, name: 'npc' };
    dmg.attach(mine);
    dmg.attach(other);
    const crashes = [];
    dmgBus.on('vehicle:crash', (e) => crashes.push(e));
    const W2 = build(impactDamage, DAMAGE_MIN_SPEED, DAMAGE_EXP, IMPACT_MIN, dmgBus, dmg, ms, (v) => v === mine);
    const tickM = (sec) => {
      for (let i = 0; i < Math.round(sec * 60); i++) {
        now += 1 / 60;
        dmg.update && dmg.update(1 / 60, null);
        ms.update(1 / 60, { x: 0, z: 0, driving: true });
      }
    };
    const pct = () => (ms.active() ? ms.active().damagePct : -1);
    W2.impact({ owner: mine }, 3, 'static');
    tickM(0.5);
    const p0 = pct();
    W2.impact({ owner: other }, 7, 'vehicle');
    tickM(0.5);
    const p1 = pct();
    W2.impact({ owner: mine }, 6, 'static'); // 4–8 m/s：不發 vehicle:crash 也要算
    tickM(0.5);
    const p2 = pct();
    const expect6 = impactDamagePct(6);
    check('組合：玩家駕駛車碰撞 6 m/s（< vehicle:crash 門檻 8）→ 易碎損壞 + impactDamagePct(6)；3 m/s 與別台車不算',
      p0 === 0 && p1 === 0 && Math.abs(p2 - expect6) < 1e-6 && crashes.length === 0, `${p0} / ${p1} / ${p2.toFixed(2)}（預期 ${expect6.toFixed(2)}）crash ${crashes.length}`);
    // 同一次碰撞 contacts + vehicle:damaged 兩路回報不重複累積（合併視窗取最大值）
    W2.impact({ owner: mine }, 10, 'static');
    const p3 = pct();
    check('組合：同一次碰撞 contacts（10 m/s）+ vehicle:damaged（反推同速）只計一次', Math.abs(p3 - (p2 + impactDamagePct(10))) < 1e-6 && crashes.length === 1,
      `${p2.toFixed(2)} → ${p3.toFixed(2)}（預期 +${impactDamagePct(10).toFixed(2)}）`);
    tickM(0.5);
    // 只有耐久事件（例如其他來源的撞擊路徑）也會通知委託
    dmgBus.emit('vehicle:damaged', { vehicle: mine, health: 500, delta: impactDamage(mine, 7, 'static') });
    const p4 = pct();
    check('組合：只收到玩家車的 vehicle:damaged（delta）→ 反推 7 m/s 計入損壞', Math.abs(p4 - (p3 + impactDamagePct(7))) < 1e-6, `${p3.toFixed(2)} → ${p4.toFixed(2)}`);
    ms.dispose();
  }
}

// ======================= 6. 存檔 v2 往返（main.js getState 形狀）=======================
{
  const bus = createBus();
  const storage = memStorage();
  const store = save.createSaveStore({ storage });
  const economy = economyMod.createEconomy({ bus, initial: store.load().data, rng: () => 0.5 });
  const extra = { missionsDone: 2, missionsFailed: 1, shotsFired: 9, pedsKnockedOut: 1 };
  const statsWithExtra = pure ? pure.statsWithExtra : (s) => s;
  const getState = () => {
    const snap = economy.snapshot();
    return {
      version: save.SAVE_VERSION,
      money: snap.money,
      stats: statsWithExtra(snap.stats, extra),
      player: { x: 1, z: 2, yaw: 0.5 },
      world: { hour: 9 },
      weapons: { slot: 2, ammo: { pistol: { mag: 7, reserve: 50 } } },
      missions: { completed: { 'bubble-tea': 2 }, best: { 'bubble-tea': 88.5 }, cooldowns: {}, active: null },
      collect: { checkins: ['taichung-opera-house'], foods: ['sun-cake'] },
    };
  };
  const autosave = save.createAutosave({ store, getState, intervalSec: 15 });
  autosave.flush('test');
  const { data, status } = store.load();
  check('存檔 v2 往返：version 2、weapons / missions / collect / 新統計保留', status === 'ok' && data.version === 2 && data.weapons.slot === 2 && data.weapons.ammo.pistol.mag === 7
    && data.missions.completed['bubble-tea'] === 2 && data.collect.checkins[0] === 'taichung-opera-house' && data.collect.foods[0] === 'sun-cake'
    && data.stats.missionsDone === 2 && data.stats.missionsFailed === 1 && data.stats.shotsFired === 9 && data.stats.pedsKnockedOut === 1, status);
  const e2 = economyMod.createEconomy({ bus: createBus(), initial: data });
  check('存檔 v2 讀回：economy 初值保留新統計欄位（整合層再以 resetExtraStats 接手）', e2.stats.missionsDone === 2 && e2.stats.shotsFired === 9);
}

console.error = origError;
console.info = origInfo;
const total = passed + failed;
console.log(failed ? `FAIL ${failed}/${total}` : `PASS ${passed}/${total}`);
process.exit(failed ? 1 : 0);
