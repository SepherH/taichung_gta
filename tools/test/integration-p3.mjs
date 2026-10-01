#!/usr/bin/env node
// Phase 3 整合（IA）無頭檢查：main.js 用到的所有模組匯出存在且簽名符合契約（docs/dev/interfaces.md）、
// HUD 按鍵提示 / 新手提示卡（由 KEYMAP_HELP / TOUCH_HELP 產生）不含已移除的鍵（O、R 翻車、E 揮拳、H 說明）、
// index.html 的 #attribution 仍在、main.js / loading.js 的接線靜態檢查、package.json test:all 含 Phase 3 測試、
// 以及 main.js 純函式區塊（@integration-p3:pure-begin / end）與存檔 / 經濟 / bus 的往返
// 用法：node tools/test/integration-p3.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// HUD 新 API（IB 單元實作：setMoney / setHealth / showHint / setHintsEnabled / resetHints / setControlsHint / setFps / setUiScale）
// 在 hud.js 尚未合併時只印 INFO 不計分（main.js 以 ?. 呼叫）；加 --strict-hud 則列入斷言
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

// document 最小替身（程序化貼圖用 2D canvas；選單 / HUD 只 import 不建構）
const ctx2d = new Proxy({}, {
  get: (_, k) => (k === 'measureText' ? () => ({ width: 100 }) : () => {}),
  set: () => true,
});
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d, style: {} }),
  getElementById: () => null,
  addEventListener: () => {},
};

const fs = await import('node:fs');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const STRICT_HUD = process.argv.includes('--strict-hud');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const isFn = (f) => typeof f === 'function';
// 物件 / 原型上的方法全部存在；回傳缺少的名稱
const missing = (obj, names) => names.filter((n) => !obj || !isFn(obj[n]));
const hasGetter = (proto, name) => {
  for (let p = proto; p; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, name);
    if (d) return isFn(d.get);
  }
  return false;
};

// ======================= 1. 模組匯出與簽名 =======================
const events = await import('../../src/core/events.js');
const settingsMod = await import('../../src/core/settings.js');
const actions = await import('../../src/core/actions.js');
const quality = await import('../../src/core/quality.js');
const save = await import('../../src/save.js');
const economyMod = await import('../../src/economy.js');
const menuMod = await import('../../src/ui/menu.js');
const mapViewMod = await import('../../src/ui/map-view.js');
const lightsMod = await import('../../src/traffic-lights.js');
const carjackMod = await import('../../src/carjack.js');
const damageMod = await import('../../src/vehicle-damage.js');
const combatMod = await import('../../src/combat.js');
const trafficMod = await import('../../src/traffic.js');
const vehicleMod = await import('../../src/vehicle.js');
const cameraMod = await import('../../src/camera.js');
const playerMod = await import('../../src/player.js');
const mobile = await import('../../src/mobile.js');
const inputMod = await import('../../src/input.js');
const hudMod = await import('../../src/hud.js');
const city = await import('../../src/citymodel.js');
const places = await import('../../src/places.js');
const npcBodies = await import('../../src/physics/npc-bodies.js');
const contacts = await import('../../src/physics/contacts.js');
const loadingMod = await import('../../src/loading.js');

{
  const b = events.createBus();
  check('events：createBus / bus 單例（on → off、once、off、emit）', isFn(events.createBus) && missing(events.bus, ['on', 'once', 'off', 'emit']).length === 0 && isFn(b.on('x', () => {})));
  const s = settingsMod.createSettings({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
  check('settings：createSettings / settings 單例（get / getAll / set / reset / subscribe）', missing(s, ['get', 'getAll', 'set', 'reset', 'subscribe']).length === 0 && missing(settingsMod.settings, ['get', 'set', 'subscribe']).length === 0);
  const keys = ['quality', 'lookSensMouse', 'lookSensTouch', 'invertY', 'showFps', 'showHints', 'uiScale'];
  check('settings：main.js 用到的鍵都在 schema', keys.every((k) => k in settingsMod.SETTINGS_SCHEMA), keys.filter((k) => !(k in settingsMod.SETTINGS_SCHEMA)).join(','));
  check('settings：set 非法畫質回 false、合法回 true', s.set('quality', 'max') === false && s.set('quality', 'ultra') === true && s.get('quality') === 'ultra');
  check('actions：KEYMAP_HELP / TOUCH_HELP / createActionReader', Array.isArray(actions.KEYMAP_HELP) && Array.isArray(actions.TOUCH_HELP) && isFn(actions.createActionReader));
  check('quality：qualityBudget 含 peds / cars / pedNear / pedFar / viewDist / shadowMap / motorbikeShare', quality.QUALITY_IDS.every((id) => ['peds', 'cars', 'pedNear', 'pedFar', 'viewDist', 'shadowMap', 'dprCap', 'motorbikeShare'].every((k) => Number.isFinite(quality.qualityBudget(id)[k]))));
  check('quality：peds low 40 / mid 80 / high 140 / ultra 200、cars 18 / 30 / 45 / 60', quality.QUALITY_IDS.map((id) => `${quality.qualityBudget(id).peds}:${quality.qualityBudget(id).cars}`).join(' ') === '40:18 80:30 140:45 200:60');
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const store = save.createSaveStore({ storage });
  check('save：createSaveStore（load / save / clear / hasSave / blocked）', missing(store, ['load', 'save', 'clear', 'hasSave']).length === 0 && 'blocked' in store);
  const as = save.createAutosave({ store, getState: () => save.defaultSave() });
  check('save：createAutosave（tick / flush）、defaultSave', missing(as, ['tick', 'flush']).length === 0 && isFn(save.defaultSave) && save.defaultSave().world.hour === 16.5);
  const eco = economyMod.createEconomy({ bus: events.createBus(), initial: save.defaultSave() });
  check('economy：createEconomy（add / spend / addDistance / addPlayTime / snapshot / dispose、money / stats）', missing(eco, ['add', 'spend', 'addDistance', 'addPlayTime', 'snapshot', 'dispose']).length === 0 && eco.money === 500 && typeof eco.stats === 'object');
  check('ui：createMenu / createMapView 為函式', isFn(menuMod.createMenu) && isFn(mapViewMod.createMapView));
  const lights = lightsMod.createTrafficLights();
  check('traffic-lights：createTrafficLights（buildMeshes / update / updateVisuals / nextStop / carMayProceed）', missing(lights, ['buildMeshes', 'update', 'updateVisuals', 'nextStop', 'carMayProceed']).length === 0);
  const cj = carjackMod.createCarjack({ bus: events.createBus() });
  check('carjack：createCarjack（canStart / begin / update / cancel、active / vehicle）', missing(cj, ['canStart', 'begin', 'update', 'cancel']).length === 0 && cj.active === false && cj.vehicle === null);
  const dmg = damageMod.createVehicleDamage({ bus: events.createBus() });
  check('vehicle-damage：createVehicleDamage（attach / detach / onImpact / update / healthOf / repair）', missing(dmg, ['attach', 'detach', 'onImpact', 'update', 'healthOf', 'repair']).length === 0);
  check('combat：CombatSystem（on / update / revive / isDown / stateOf、entries Map）+ pedKnockdownPayload', isFn(combatMod.CombatSystem) && missing(combatMod.CombatSystem.prototype, ['on', 'update', 'revive', 'isDown', 'stateOf', 'register']).length === 0 && new combatMod.CombatSystem().entries instanceof Map);
  const kd = combatMod.pedKnockdownPayload({ target: { kind: 'ped' }, cause: 'punch', byPlayer: true, x: 1, z: 2 });
  check('combat：pedKnockdownPayload → { ped, cause, byPlayer, x, z }，玩家本身回 null', kd && kd.cause === 'punch' && kd.byPlayer === true && kd.x === 1 && combatMod.pedKnockdownPayload({ target: { kind: 'player' } }) === null);
  const TP = trafficMod.Traffic.prototype;
  const tMissing = missing(TP, ['setBudget', 'attachBus', 'carjackCandidates', 'releaseCar', 'spawnEjectedDriver', 'setContext', 'setView', 'setBlockers', 'sync', 'bodies', 'pedBodies']);
  check('traffic：Traffic 方法（setBudget / attachBus / carjackCandidates / releaseCar / spawnEjectedDriver / …）+ physicsRadius getter', tMissing.length === 0 && hasGetter(TP, 'physicsRadius'), tMissing.join(','));
  const VM = vehicleMod.VehicleManager.prototype;
  const vmMissing = missing(VM, ['adopt', 'remove', 'findNearby', 'findOverturned', 'drive', 'sync', 'bodies']);
  const vMissing = missing(vehicleMod.Vehicle.prototype, ['honk', 'isOverturned', 'upright', 'setPowerScale', 'setControls', 'speedKmh', 'seatWorld']);
  check('vehicle：VehicleManager（adopt / remove / findOverturned …）、Vehicle（honk / isOverturned / upright / setPowerScale …）', vmMissing.length === 0 && vMissing.length === 0 && isFn(vehicleMod.driveControls), [...vmMissing, ...vMissing].join(','));
  check('vehicle：VehicleManager 第 5 參數 { bus }（建構子至少 4 個必要參數）、VEHICLE_TYPES 有中文 label', vehicleMod.VehicleManager.length >= 4 && Object.values(vehicleMod.VEHICLE_TYPES).every((t) => typeof t.label === 'string' && t.label.length > 0));
  check('camera：CameraRig（update / shake）', missing(cameraMod.CameraRig.prototype, ['update', 'shake']).length === 0);
  check('player：Player（update / punch / enterVehicle / exitVehicle / recoverAfterKnockout / sitOn / placeAt / syncMesh）、PLAYER_RADIUS', missing(playerMod.Player.prototype, ['update', 'punch', 'enterVehicle', 'exitVehicle', 'recoverAfterKnockout', 'sitOn', 'placeAt', 'syncMesh', 'syncPhysics']).length === 0 && Number.isFinite(playerMod.PLAYER_RADIUS));
  const mMissing = missing(mobile, ['isTouch', 'setQualitySetting', 'qualityTier', 'setGameActive', 'applyRendererQuality', 'createAdaptiveResolution', 'pixelRatioFor']);
  check('mobile：isTouch / setQualitySetting / qualityTier / setGameActive / applyRendererQuality / createAdaptiveResolution / pixelRatioFor', mMissing.length === 0, mMissing.join(','));
  mobile.setQualitySetting('mid');
  const tierMid = mobile.qualityTier();
  mobile.setQualitySetting('auto');
  check('mobile：setQualitySetting(mid) → qualityTier() = mid', tierMid === 'mid');
  const iMissing = missing(inputMod.Input.prototype, ['snapshot', 'setSensitivity', 'setInvertY', 'moveAxis', 'consumeMouse', 'endFrame', 'down', 'wasPressed']);
  check('input：Input（snapshot / setSensitivity / setInvertY / …）+ enabled setter', iMissing.length === 0 && isFn(Object.getOwnPropertyDescriptor(inputMod.Input.prototype, 'enabled').set), iMissing.join(','));
  const HP = hudMod.HUD.prototype;
  check('hud：既有 update / toast / setPrompt / setVisible', missing(HP, ['update', 'toast', 'setPrompt', 'setVisible']).length === 0);
  const hudNew = ['setMoney', 'setHealth', 'showHint', 'setHintsEnabled', 'resetHints', 'setControlsHint', 'setFps', 'setUiScale'];
  const hudLack = missing(HP, hudNew);
  if (STRICT_HUD) check('hud：IB 新 API 全部存在', hudLack.length === 0, hudLack.join(','));
  else console.log(`INFO  hud：IB 新 API ${hudNew.length - hudLack.length}/${hudNew.length} 存在${hudLack.length ? `（尚缺 ${hudLack.join(', ')}；main.js 以 ?. 呼叫，合併 IB 後加 --strict-hud 驗證）` : ''}`);
  const cMissing = missing(city, ['buildingAt', 'inWater', 'inBounds', 'nearestNamedRoad', 'heightAt', 'getTerrain']);
  check('citymodel：buildingAt / inWater / inBounds / nearestNamedRoad / heightAt / getTerrain、ATTRIBUTION 含 OpenStreetMap / ODbL', cMissing.length === 0 && /OpenStreetMap/.test(city.ATTRIBUTION) && /ODbL/.test(city.ATTRIBUTION), cMissing.join(','));
  check('places / npc-bodies / contacts：computeSpawn、setActiveByDistance + ACTIVE_RADIUS、createContactRouter', isFn(places.computeSpawn) && isFn(npcBodies.setActiveByDistance) && Number.isFinite(npcBodies.ACTIVE_RADIUS) && isFn(contacts.createContactRouter));
  check('loading：LoadingScreen（setProgress / ready / error），ready 不再接受開始回呼', missing(loadingMod.LoadingScreen.prototype, ['setProgress', 'ready', 'error']).length === 0 && loadingMod.LoadingScreen.prototype.ready.length === 0);
}

// ======================= 2. main.js 純函式：HUD 提示不含已移除的鍵 =======================
const mainSrc = read('src/main.js');
const pure = (() => {
  const m = mainSrc.match(/\/\/ @integration-p3:pure-begin\n([\s\S]*?)\/\/ @integration-p3:pure-end/);
  if (!m) return null;
  try {
    return new Function(`${m[1]}\nreturn { CONTROLS_HINT, HINT_ACTIONS, helpItem, controlsHintItems, hintText, validSavedPosition, perfStats };`)();
  } catch (err) {
    console.log(`INFO  純函式區塊求值失敗：${err.message}`);
    return null;
  }
})();
check('main.js 純函式區塊可擷取並求值（不依賴 import）', !!pure);

// 已移除的鍵：O（靈敏度）、R 翻車、E 揮拳、H 說明；keys 以非英數字切成按鍵記號
// Phase 4（契約 §12）：R 改為「裝填」、E 改為「互動」屬新綁定，只要說明不是翻車 / 揮拳就不算舊鍵
const tokens = (keys) => String(keys).split(/[^A-Za-z0-9]+/).filter(Boolean);
function removedKeyIssues(items) {
  const bad = [];
  for (const it of items) {
    const t = tokens(it.keys);
    const text = `${it.keys} ${it.desc}`;
    if (t.includes('O')) bad.push(`O：${text}`);
    if ((t.includes('R') && !/裝填/.test(it.desc)) || /翻車|翻正/.test(it.desc)) bad.push(`R 翻車：${text}`);
    if ((t.includes('E') && !/互動/.test(it.desc)) || /揮拳/.test(it.desc) && !/攻擊/.test(it.desc)) bad.push(`E 揮拳：${text}`);
    if (/說明/.test(it.desc) || (t.includes('H') && !/喇叭/.test(it.desc))) bad.push(`H 說明：${text}`);
  }
  return bad;
}
const flat = (help) => help.flatMap((g) => g.items);
{
  const { KEYMAP_HELP, TOUCH_HELP, ACTIONS } = actions;
  check('KEYMAP_HELP / TOUCH_HELP 全表不含已移除的鍵（O、R 翻車、E 揮拳、H 說明）', removedKeyIssues(flat(KEYMAP_HELP)).length === 0 && removedKeyIssues(flat(TOUCH_HELP)).length === 0, [...removedKeyIssues(flat(KEYMAP_HELP)), ...removedKeyIssues(flat(TOUCH_HELP))].join(' | '));
  if (pure) {
    const all = [];
    for (const help of [KEYMAP_HELP, TOUCH_HELP]) for (const mode of ['walk', 'drive']) all.push(...pure.controlsHintItems(help, mode));
    check('HUD 底部按鍵提示（桌機 / 觸控 × 步行 / 駕駛）不含已移除的鍵', all.length > 0 && removedKeyIssues(all).length === 0, removedKeyIssues(all).join(' | '));
    const desk = pure.controlsHintItems(KEYMAP_HELP, 'walk');
    check('桌機步行提示含攻擊（滑鼠左鍵）、F 上車、Esc / P 暫停', desk.some((i) => /左鍵/.test(i.keys) && /攻擊/.test(i.desc)) && desk.some((i) => tokens(i.keys).includes('F')) && desk.some((i) => /Esc/.test(i.keys)), desk.map((i) => i.keys).join('、'));
    const drive = pure.controlsHintItems(KEYMAP_HELP, 'drive');
    check('桌機駕駛提示含 H 喇叭、C 回頭看、F 下車 / 扶起', drive.some((i) => tokens(i.keys).includes('H') && /喇叭/.test(i.desc)) && drive.some((i) => tokens(i.keys).includes('C')) && drive.some((i) => /扶起/.test(i.desc)), drive.map((i) => `${i.keys} ${i.desc}`).join('、'));
    const touchWalk = pure.controlsHintItems(TOUCH_HELP, 'walk');
    check('觸控步行提示以按鈕用語（不出現 F / Esc 鍵名）', touchWalk.length >= 3 && touchWalk.every((i) => !tokens(i.keys).includes('F') && !/Esc/.test(i.keys)), touchWalk.map((i) => i.keys).join('、'));
    const usedActions = Object.values(pure.CONTROLS_HINT).flat().map(([, a]) => a).concat(Object.values(pure.HINT_ACTIONS).map(([, a]) => a));
    check('提示用到的動作都在 ACTIONS 且非預留', usedActions.every((a) => ACTIONS[a] && !ACTIONS[a].reserved), usedActions.filter((a) => !ACTIONS[a] || ACTIONS[a].reserved).join(','));
    const hints = [];
    for (const help of [KEYMAP_HELP, TOUCH_HELP]) for (const id of Object.keys(pure.HINT_ACTIONS)) hints.push(pure.hintText(help, id));
    check('新手提示卡文字（移動 / 攻擊 / 上車 / 暫停）都找得到說明列且不含已移除的鍵', hints.every((t) => typeof t === 'string' && t.length > 0) && hints.every((t) => !/揮拳/.test(t) || /攻擊/.test(t)) && hints.every((t) => !tokens(t).includes('O') && !tokens(t).includes('R') && !tokens(t).includes('E')), hints.join(' | '));
    const deps = { buildingAt: city.buildingAt, inWater: city.inWater, inBounds: city.inBounds };
    const spawn = places.computeSpawn();
    // 在多邊形外框（polygonBBox：{ x0, z0, x1, z1 }，poly 為扁平 [x, z, …]）內格點取樣，找第一個符合 pred 的點
    const sampleIn = (list, pred) => {
      for (const f of list.slice(0, 50)) {
        const bb = f.bbox || (() => {
          const xs = f.poly.filter((_, i) => i % 2 === 0);
          const zs = f.poly.filter((_, i) => i % 2 === 1);
          return { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
        })();
        for (let i = 0; i < 400; i++) {
          const x = bb.x0 + ((i % 20) + 0.5) * (bb.x1 - bb.x0) / 20;
          const z = bb.z0 + (Math.floor(i / 20) + 0.5) * (bb.z1 - bb.z0) / 20;
          if (pred(x, z)) return { x, z };
        }
      }
      return null;
    };
    const inside = sampleIn(city.buildings, (x, z) => city.inBounds(x, z, 5) && city.buildingAt(x, z, 0) && !city.inWater(x, z, 1));
    const wet = sampleIn(city.water, (x, z) => city.inBounds(x, z, 5) && city.inWater(x, z, 0) && !city.buildingAt(x, z, 1));
    check('存檔位置驗證：出生點可用；null / NaN / 建築內 / 水中 / 地圖外 → 改用出生點',
      pure.validSavedPosition(spawn, deps) && !pure.validSavedPosition({ x: null, z: 0 }, deps) && !pure.validSavedPosition({ x: NaN, z: 1 }, deps) &&
        !!inside && !pure.validSavedPosition(inside, deps) && !!wet && !pure.validSavedPosition(wet, deps) &&
        !pure.validSavedPosition({ x: 1e7, z: 1e7 }, deps),
      `建築內樣本 ${inside ? `(${inside.x.toFixed(1)}, ${inside.z.toFixed(1)})` : '無'}、水中樣本 ${wet ? `(${wet.x.toFixed(1)}, ${wet.z.toFixed(1)})` : '無'}`);
    // 騎樓 / 遮簷下（老虎城外牆 0.3–0.5 m 內）：舊判定 buildingAt(x, z, 0.5) 會丟回出生點；新判定以碰撞體（solidAt）或輪廓內為準
    const arcade = { x: 39.2, z: 23.1, yaw: 0 };
    const solidAt = (x, z) => !!city.buildingAt(x, z, playerMod.PLAYER_RADIUS * 0.85); // 替身：膠囊（略縮）與建築輪廓相交
    check('存檔位置：老虎城騎樓 (39.2, 23.1) 不再判為建築內（無 solidAt 退回輪廓內判定、solidAt 替身皆有效）',
      !!city.buildingAt(arcade.x, arcade.z, 0.5) && pure.validSavedPosition(arcade, deps) && pure.validSavedPosition(arcade, { ...deps, solidAt }),
      `舊判定 buildingAt(pad 0.5) = ${city.buildingAt(arcade.x, arcade.z, 0.5) ? city.buildingAt(arcade.x, arcade.z, 0.5).name : '無'}`);
    check('存檔位置：solidAt 為真 → 無效；solidAt 為假仍保留水中 / 地圖外判定',
      !pure.validSavedPosition(spawn, { ...deps, solidAt: () => true }) && !!wet && !pure.validSavedPosition(wet, { ...deps, solidAt: () => false }) &&
        !pure.validSavedPosition({ x: 1e7, z: 1e7 }, { ...deps, solidAt: () => false }) && !pure.validSavedPosition(inside, { ...deps, solidAt }));
    // 外牆外 0.4 m 的取樣點（前 300 棟建築每邊中點往外推；排除另一棟建築 0.3 m 內、水中、地圖外）：舊判定 vs 新判定的有效比例
    const oldValid = (q) => city.inBounds(q.x, q.z, 5) && !city.buildingAt(q.x, q.z, 0.5) && !city.inWater(q.x, q.z, 0.5);
    let edgeN = 0;
    let edgeOld = 0;
    let edgeNew = 0;
    for (const b of city.buildings.slice(0, 300)) {
      const poly = b.poly;
      const n = poly.length / 2;
      for (let i = 0; i < n; i++) {
        const x0 = poly[i * 2];
        const z0 = poly[i * 2 + 1];
        const x1 = poly[((i + 1) % n) * 2];
        const z1 = poly[((i + 1) % n) * 2 + 1];
        const len = Math.hypot(x1 - x0, z1 - z0);
        if (len < 2) continue;
        for (const sgn of [1, -1]) {
          const q = { x: (x0 + x1) / 2 + (sgn * (z1 - z0) / len) * 0.4, z: (z0 + z1) / 2 - (sgn * (x1 - x0) / len) * 0.4 };
          if (city.buildingAt(q.x, q.z, 0) || !city.inBounds(q.x, q.z, 5) || city.inWater(q.x, q.z, 0.5)) continue;
          const others = city.buildingAt(q.x, q.z, 0.3);
          if (others) continue;
          edgeN++;
          if (oldValid(q)) edgeOld++;
          if (pure.validSavedPosition(q, { ...deps, solidAt })) edgeNew++;
        }
      }
    }
    check('存檔位置：外牆外 0.4 m 取樣點全部判有效（舊判定全數丟回出生點）', edgeN > 100 && edgeNew === edgeN && edgeOld === 0,
      `${edgeN} 點：舊有效 ${edgeOld}、新有效 ${edgeNew}`);
    const ps = pure.perfStats(Float64Array.from([1, 2, 3, 4, 100]), 5);
    check('perfStats：平均與 p95', Math.abs(ps.avg - 22) < 1e-9 && ps.p95 === 100 && pure.perfStats(new Float64Array(4), 0).avg === 0);
  }
}

// ======================= 3. 存檔 / 經濟 / bus 往返（同 main.js 的 getState 形狀）=======================
{
  const bus = events.createBus();
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const store = save.createSaveStore({ storage });
  const first = store.load();
  let economy = economyMod.createEconomy({ bus, initial: first.data, rng: () => 0.5 });
  const moneyEvents = [];
  bus.on('player:money', (e) => moneyEvents.push(e));
  const pos = { x: 12.5, z: -40.25, yaw: 1.2 };
  const hour = 20.75;
  const autosave = save.createAutosave({ store, intervalSec: 15, getState: () => ({ version: 1, ...economy.snapshot(), player: pos, world: { hour } }) });
  bus.emit('ped:knockdown', combatMod.pedKnockdownPayload({ target: { kind: 'ped' }, cause: 'punch', byPlayer: true, x: 0, z: 0 }));
  bus.emit('player:ko', {});
  economy.addDistance('walk', 30);
  economy.addPlayTime(10);
  const money = economy.money;
  check('經濟：打倒路人掉錢 + KO 醫藥費都 emit player:money', moneyEvents.length === 2 && moneyEvents[0].reason === 'loot' && moneyEvents[1].reason === 'hospital' && money === 500 + 25 - 100, `money ${money}`);
  check('自動存檔：tick 未滿 15 s 不存、滿 15 s 存一次', autosave.tick(14) === false && !store.hasSave() && autosave.tick(1.5) === true && store.hasSave());
  const { data, status } = store.load();
  check('存檔往返：金錢 / 統計 / 位置 / 時間還原', status === 'ok' && data.money === money && data.stats.pedsKnockedOut === 1 && data.stats.kos === 1 && data.player.x === pos.x && data.player.z === pos.z && data.world.hour === hour);
  economy.dispose();
  economy = economyMod.createEconomy({ bus, initial: data });
  const before = moneyEvents.length;
  bus.emit('player:ko', {});
  check('回主選單 / 新局：dispose 後舊經濟不再訂閱（只有新經濟扣款一次）', moneyEvents.length === before + 1 && economy.money === money - 100);
  storage.setItem('tcgta.save', JSON.stringify({ version: 99, money: 1 }));
  storage.removeItem('tcgta.save.bak');
  const newer = save.createSaveStore({ storage });
  const r = newer.load();
  check('版本較新的存檔：incompatible、不能繼續、blocked 時不覆寫；clear 後可存', r.status === 'incompatible' && !newer.hasSave() && newer.blocked && newer.save(save.defaultSave()) === false && (newer.clear(), newer.save(save.defaultSave())) === true);
}

// ======================= 4. 靜態接線檢查 =======================
{
  const html = read('index.html');
  const attrIds = html.match(/id="attribution"/g) || [];
  check('index.html：#attribution 恰好一處且含 OpenStreetMap / ODbL', attrIds.length === 1 && /OpenStreetMap/.test(html) && /ODbL/.test(html));
  const code = mainSrc.replace(/\/\/[^\n]*/g, ''); // 去掉註解再比對
  const gone = ['tb-flip', 'tb-punch', 'toggleHelp', 'mousePunchListener', "'KeyE'", "'KeyR'", "'KeyO'", 'overturnedTime'].filter((s) => code.includes(s));
  check('main.js：已移除 tb-flip / tb-punch / toggleHelp / mousePunchListener / E / R / O 鍵 / overturnedTime', gone.length === 0, gone.join(','));
  // Phase 4（FX3 / I4b）：registerTouchButton 只用來以 onTap 重新註冊 tb-guide（圖鑑鈕），不得再註冊已移除的鈕
  const tbIds = [...code.matchAll(/registerTouchButton\(\s*\{\s*id:\s*'([^']+)'/g)].map((m) => m[1]);
  const tbCalls = (code.match(/registerTouchButton\(/g) || []).length;
  check('main.js：registerTouchButton 恰註冊 tb-guide 與 tb-phone（calls=2；不得註冊 tb-flip / tb-punch）', tbCalls === 2 && tbIds.length === tbCalls && [...tbIds].sort().join(',') === 'tb-guide,tb-phone' && !tbIds.some((id) => id === 'tb-flip' || id === 'tb-punch'), tbIds.join(',') + ' calls=' + tbCalls);
  check('main.js：每幀讀 input.snapshot()，攻擊 / 上下車 / 暫停 / 地圖 / 鏡頭段 / 回頭看 / 快轉走 action', /input\.snapshot\(\)/.test(code) && ['pressed.attack', 'pressed.enterExit', 'pressed.pause', 'pressed.map', 'pressed.camera', 'down.lookBack', 'pressed.timeSkip'].every((s) => code.includes(s)));
  check('main.js：不覆寫 camera.fov（rig 自行管理）', !/camera\.fov\s*=[^=]/.test(code));
  const need = ["bus.on('game:start'", "bus.on('game:pause'", "bus.on('game:quitToMenu'", 'createSaveStore', 'createAutosave', 'createEconomy', 'createMenu', 'createMapView', 'createTrafficLights', 'createCarjack', 'createVehicleDamage', 'traffic.setBudget', 'pedKnockdownPayload', "'player:ko'", 'setGameActive', 'requestPointerLock', 'pointerlockchange', 'visibilitychange', 'pagehide', '--tg-ui-scale', '--ui-scale', 'onVehicleHitWorld', 'onVehicleHitVehicle', 'onVehicleHitPedestrian', 'rig.shake', 'honk()', 'upright()', 'findOverturned', 'carjackCandidates', 'lights.update(', 'lights.updateVisuals(', 'dmg.update('];
  // p5-c1 起每幀排程與物理一幀在 src/core/loop.js（main.js 以 createWorldStep / createFrameLoop 注入依賴）：接線字串比對 main.js + loop.js 合併內容，
  // 另驗 main.js 確實把 lights / dmg 交給 createWorldStep 並在遊戲中 / 開始畫面呼叫 stepWorld；號誌相位 / 耐久去重時鐘在子步推進（p5-d1）
  const loopCode = read('src/core/loop.js').replace(/\/\/[^\n]*/g, '');
  const wired = code + '\n' + loopCode;
  const lack = need.filter((s) => !wired.includes(s));
  check('main.js + core/loop.js：選單 / 存檔 / 經濟 / 號誌 / 搶車 / 耐久 / 手機 / 滑鼠鎖定接線都在', lack.length === 0, lack.join(','));
  const stepSrc = (loopCode.match(/const step = \(dt, center\) => \{([\s\S]*?)\n {2}\};/) || [])[1] || '';
  check('物理一幀接線：loop.js step 內 pw.step → lights.update / updateVisuals → dmg.update；main.js createWorldStep 注入 lights / dmg、updateGame / updateAttract 呼叫 stepWorld',
    /pw\.step\(dt\);[\s\S]*lights\.update\(\);\s*lights\.updateVisuals\(camera\.position\.x, camera\.position\.z\);[\s\S]*dmg\.update\(dt, center\.x, center\.z, 0\);/.test(stepSrc)
    && /createWorldStep\(\{[^}]*\blights,[^}]*\bdmg,/.test(code) && /const stepWorld = worldStep\.step;/.test(code) && (code.match(/stepWorld\(dt, /g) || []).length >= 2);
  check('子步接線：pw.onBeforeStep → lights.step（在 new Traffic 之前）、pw.onAfterStep → dmg.step（在 router.drain 之後）',
    code.indexOf('pw.onBeforeStep((h) => lights.step(h));') > 0 && code.indexOf('pw.onBeforeStep((h) => lights.step(h));') < code.indexOf('new Traffic(')
    && code.indexOf('pw.onAfterStep((dt) => router.drain(dt));') > 0 && code.indexOf('pw.onAfterStep((dt) => router.drain(dt));') < code.indexOf('pw.onAfterStep((h) => dmg.step(h));'));
  check('main.js：dev 掛鉤 __game 含 bus / settings / economy / saveStore / menu / lights / damage / carjack / quality / setQuality / stepFrames / perf', /import\.meta\.env\.DEV/.test(code) && ['bus,', 'settings,', 'get economy()', 'saveStore:', 'menu,', 'lights,', 'damage:', 'carjack:', 'get quality()', 'setQuality(', 'stepFrames(', 'perf,'].every((s) => code.includes(s)));
  // 暫停時世界停止更新：tick 在 core/loop.js（createFrameLoop）——updateWorld 暫停即 return（updateGame / updateAttract 都在其下），
  // tick 呼叫 updateWorld 後照常 render；main.js 注入 isPaused = state.paused / isStarted = state.started / updateGame / updateAttract / render 並啟動 loop.frame()
  const worldSrc = (loopCode.match(/const updateWorld = \(dt\) => \{([\s\S]*?)\n {2}\};/) || [])[1] || '';
  const tickSrc = (loopCode.match(/const tick = \(dt\) => \{([\s\S]*?)\n {2}\};/) || [])[1] || '';
  const frameLoopSrc = (code.match(/createFrameLoop\(\{([\s\S]*?)\n {2}\}\);/) || [])[1] || '';
  check('main.js + core/loop.js：暫停時世界停止更新但照常渲染',
    /^\s*if \(d\.isPaused\(\)\) return;\s*if \(d\.isStarted\(\)\) d\.updateGame\(dt\);\s*else d\.updateAttract\(dt\);\s*$/.test(worldSrc)
    && /updateWorld\(dt\);[\s\S]*d\.render\(\);/.test(tickSrc)
    && ['world: worldStep', 'isPaused: () => state.paused', 'isStarted: () => state.started', 'updateGame,', 'updateAttract,', 'render,'].every((x) => frameLoopSrc.includes(x))
    && /\bloop\.frame\(\);/.test(code));
  const resumeSrc = (code.match(/const resumeGame = \(\) => \{([\s\S]*?)\n {2}\};/) || [])[1] || '';
  check('main.js：「繼續」（game:pause paused:false）同步 requestPointerLock', /requestLock\(\)/.test(resumeSrc) && /input\.enabled = true/.test(resumeSrc));
  const placeSrc = (code.match(/const placePlayer = \(save\) => \{([\s\S]*?)\n {2}\};/) || [])[1] || '';
  check('main.js：存檔位置以物理重疊查詢建築碰撞體（solidAt → pw.intersections、只認 handles.building）', /validSavedPosition\(p, \{ solidAt,/.test(placeSrc) && /pw\.intersections\(/.test(code) && /handles\.building/.test(code));
  const startIdx = code.indexOf('menu.showStart({ canContinue: store.hasSave() });');
  check('main.js：開始畫面出現就顯示存檔狀態提示（showStartNotice(saveNotice) 緊接 menu.showStart）、開始遊戲時移除',
    startIdx > 0 && /^\s*showStartNotice\(saveNotice\);/.test(code.slice(startIdx + 50)) && /const startGame = \(continued\) => \{\s*clearStartNotice\(\);/.test(code));
  check('main.js：車輛耐久注入 isNight（dayNight.night）供熄火黑煙夜間提亮', /createVehicleDamage\(\{[^}]*isNight: \(\) => dayNight\.night/.test(code));
  check('main.js：VehicleManager 傳 roads: surfaceRoads（掉出世界重置到道路）、訂閱 vehicle:recovered（driven 時 toast）',
    /new VehicleManager\([^)]*\{[^}]*roads: surfaceRoads[^}]*\}\)/.test(code) && /import \{[^}]*\bsurfaceRoads\b[^}]*\} from '\.\/citymodel\.js'/.test(code)
    && /bus\.on\('vehicle:recovered', \(\{[^}]*driven[^}]*\}\) => \{\s*if \(driven\) hud\.toast\('車輛已重置到道路上'/.test(code));
  const envSrc = (code.match(/function landmarkEnvMap\(renderer, scene\) \{([\s\S]*?)\n\}/) || [])[1] || '';
  check('main.js：loadLandmarkModels 傳 { envMap }（沿用 scene.environment 或 PMREM 產生、dispose generator、不設 scene.environment）',
    /loadLandmarkModels\([\s\S]*?\}, \{ envMap \}\);/.test(code) && /if \(scene\.environment\) return scene\.environment;/.test(envSrc)
    && /new THREE\.PMREMGenerator\(renderer\)/.test(envSrc) && /pmrem\.dispose\(\);/.test(envSrc) && !/scene\.environment\s*=[^=]/.test(code));
  const loadingSrc = read('src/loading.js').replace(/\/\/[^\n]*/g, '');
  check('loading.js：只負責進度（不再綁 #start-btn 點擊開始）', !/start-btn/.test(loadingSrc) && !/addEventListener\('click'/.test(loadingSrc));
  const pkg = JSON.parse(read('package.json'));
  const all = pkg.scripts['test:all'] || '';
  const tests = ['core', 'menu', 'save', 'traffic-lights', 'crowd-lod', 'carjack', 'player-feel', 'traffic-flow', 'integration-p3'];
  const scripts = Object.entries(pkg.scripts);
  // test:all = node tools/test/run-all.mjs：逐支執行 tools/test/*.mjs（只排除自身、任一失敗 exit 1）；
  // 各 Phase 3 測試仍有 node tools/test/<名>.mjs 的 script（= 位於 tools/test、會被 run-all 收進來）
  const runAll = read('tools/test/run-all.mjs').replace(/\/\/[^\n]*/g, '');
  const runAllOk = all === 'node tools/test/run-all.mjs'
    && /readdirSync\(testDir\)\s*\.filter\(\(f\) => f\.endsWith\('\.mjs'\) && f !== self\)/.test(runAll) && /const self = 'run-all\.mjs';/.test(runAll)
    && /spawnSync\(process\.execPath, \[join\(testDir, f\)\]/.test(runAll) && /process\.exit\(failed\.length > 0 \? 1 : 0\)/.test(runAll);
  const lackTests = tests.filter((t) => !scripts.some(([k, v]) => k !== 'test:all' && v === `node tools/test/${t}.mjs`));
  check('package.json：test:all（run-all.mjs 逐支跑 tools/test/*.mjs）涵蓋 Phase 3 測試（core / menu / save / traffic-lights / crowd-lod / carjack / player-feel / traffic-flow / integration-p3）',
    runAllOk && lackTests.length === 0, (runAllOk ? '' : `test:all=${all}；`) + lackTests.join(','));
}

const total = passed + failed;
console.log(failed ? `FAIL ${failed}/${total}` : `PASS ${passed}/${total}`);
process.exit(failed ? 1 : 0);
