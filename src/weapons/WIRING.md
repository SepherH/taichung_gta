# W1 武器：整合接線說明（main.js / player.js / hud.js / touch.js / ui / style.css / index.html）

## main.js

1. import：`createWeapons, gunshotListeners, loadWeaponModels, createAmmoPickups, DEFAULT_AMMO_POINTS` 由 `./weapons/index.js`；`createWeaponHud` 由 `./weapons/hud.js`（會自帶 import weapons.css）。
2. combat 建好、player.attachCombat 之後：
   ```
   const weapons = createWeapons({ bus, combat, player, settings, now: () => gameTime, isTouch,
     manifest: getCharacterManifest(), raycast, sweep /* , playAnim: weaponLayer.play（W3 完成後）, getBatSegment */ });
   ```
   - `raycast(o, d, max, { excludeActor })`：`pw.castRay(o, d, max, { excludeCollider: 玩家膠囊 })` → `{ point, normal, actor: 剛體→actor 對照（行人 / 玩家）或 null, surface: 車身剛體 ? 'vehicle' : 'world' }`
   - `sweep(from, to, r, { excludeActor })`：以 from–to 做膠囊（Capsule 半長 = |to−from|/2、半徑 r，中點 + 朝向）`pw.castShape(..., vel 0, maxToi 0)` 或 `intersectionsWithShape`，收集碰到的行人剛體 → actor 陣列
3. 每幀（步行、未暫停）：
   - `aim = { origin: camera.position, dir: camera 前方單位向量, aiming: snap.down.aim && weapons.current === 'pistol', muzzle?（W3 槍口世界座標）, candidates: 40 m 內骨架行人 actor（只觸控需要） }`（物件重用）
   - `snap.pressed.slot1/2/3` → `weapons.select(0/1/2)`；`snap.pressed.weaponCycle` → `weapons.cycle()`；`snap.pressed.reload` → `weapons.reload()`
   - 攻擊：空手 / 球棒用 `snap.pressed.attack`，手槍用 `snap.down.attack`（半自動連發）→ `weapons.attack(aim)`（取代原本 `player.punch()`；空手時 weapons 內部會呼叫 player.punch()）
   - `weapons.update(dt, aim)`（在 combat.update 之前或之後皆可；同一個 gameTime）
   - `const k = weapons.recoilKick(); if (k.pitch || k.yaw) rig.addRecoil(k.pitch, k.yaw);`
   - `rig.update(dt, input, focus, { …既有, aim: weapons.aiming })`；滾輪：`weapons.aiming` 時不縮放
   - 駕駛中不呼叫 attack / select（可照常 update）
4. 事件：
   - `combat.on('hit', e => bus.emit('combat:hit', e))`（payload 已含契約 §10 所有欄位）
   - 既有 `combat.on('knockdown')` → `pedKnockdownPayload(e)` 已帶 `weapon`，cause 會是 'punch'|'bat'|'bullet'|'vehicle'
   - 槍聲：`gunshotListeners(bus, () => traffic 的 brain 迭代器)`（weapon:fire → 30 m 內 `brain.hear({ type: 'gunshot', x, z })`）
   - 彈藥：`bus.on('pickup:ammo', e => weapons.addAmmo(e.amount))`
5. 彈藥拾取：`const pickups = createAmmoPickups({ scene, bus, points: DEFAULT_AMMO_POINTS, heightAt, canPickup: () => weapons.ammo().reserve < 120 })`；每幀 `pickups.update(dt, player.pos)`；互動清單加入 `pickups.nearest(player.pos)`（priority 0，自動拾取為主）；小地圖 markers 併入 `pickups.markers()`（kind 'ammo'）
6. 武器模型：`loadWeaponModels().then(m => …)`；W3 `attachWeapon(character, m.bat.object, { gripOffset: m.bat.grip })`，依 `weapon:equip` 切換顯示；棒頭 / 槍口世界座標 = `object.localToWorld(tip/muzzle.clone())`（可據此實作 getBatSegment / aim.muzzle）
7. 存檔：`save.weapons = weapons.serialize()`；讀檔 `weapons.restore(data.weapons)`
8. 取代直接改 entries：`knockDownPlayer` → `combat.knockdownActor(player.actor)`；traffic.spawnEjectedDriver 同理（`{ impulse }` 可交給 combat 推剛體）

## hud.js / touch.js / index.html / style.css

- `const whud = createWeaponHud({ root: document.body（或 #hud）, touchRoot: document.getElementById('touch-ui'), weapons, input, isTouch })`（touchRoot 需在 initTouch 之後取得）
- 每幀 `whud.update(dt, { driving: state.mode === 'drive', aimBlend: rig.aimBlend })`；上下車 `whud.setDriving(bool)`；HUD 隱藏時 `whud.setVisible(false)`
- 觸控：tb-weapon / tb-reload / tb-aim 由 hud 自建（class `wp-tbtn`），不必 registerTouchButton；tb-aim 走 `input.touchPress('Mouse2', true)`，需 actions.js 的 aim 綁 Mouse2 並在 snapshot.down 暴露 aim
- 位置若與既有按鈕重疊：在 style.css 設 `--wp-btn-right` / `--wp-btn-bottom` / `--wp-hud-top` / `--wp-hud-right` 即可，不必改 weapons.css；全部元素在右側或中央，不擋左下 `#attribution`
- tb-interact（送 KeyE）不在本單元，請整合層以 registerTouchButton 建立

## 設定鍵（§11，settings.js 由他單元加）

- `recoil`（缺 = 1.0）、`aimAssist`（缺 = true）由 weapons 以 `settings.get` 即時讀取，不需訂閱
