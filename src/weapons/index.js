// 武器模組匯出彙整（不含 hud.js：它會 import CSS，由整合層在瀏覽器端另外 import './weapons/hud.js'）
export * from './defs.js';
export { pickAimAssist, resolveShot, recoilKick } from './aim.js';
export { createWeapons, batTiming, batArc, gunshotListeners } from './weapons.js';
export { loadWeaponModels, normalizeWeaponManifest, placeholderBat, placeholderPistol, DEFAULT_WEAPON_BASE } from './models.js';
export { createAmmoPickups, DEFAULT_AMMO_POINTS, PICKUP_RADIUS } from './pickups.js';
export { classifyPress, isLongPress, wheelSlotFromVector, wheelCellOffset, ammoText, LONG_PRESS_MS } from './wheel.js';
