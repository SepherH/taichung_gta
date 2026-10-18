// 武器定義（契約 §13）：五槽（0 空手 / 1 球棒 / 2 手槍 / 3 衝鋒槍 / 4 散彈槍）的數值常數，weapons.js / hud.js / 測試共用
// 數值為手感設定（推測值，非實測）；拳擊數值沿用 combat.js（PUNCH_DAMAGE / PUNCH_COOLDOWN）
// Phase 14：衝鋒槍 smg / 散彈槍 shotgun 需在武器店（src/shops/gun-shop.js）購買才可選（PURCHASABLE）；
//   直選鍵 Digit4 / Digit5 不進 core/actions.js 的 ACTIONS（ACTIONS 定稿 19 個），由整合層以 SLOT_KEYS 直接讀鍵
import { PUNCH_DAMAGE, PUNCH_COOLDOWN } from '../combat.js';

export const SLOT_IDS = ['fist', 'bat', 'pistol', 'smg', 'shotgun']; // 槽位 → 武器 id
export const SLOT_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5']; // 槽位直選鍵（1–3 同 ACTIONS slot1–3）
export const GUN_IDS = ['pistol', 'smg', 'shotgun']; // 槍械（彈匣 / 裝填 / 準星）
export const PURCHASABLE = ['smg', 'shotgun']; // 需購買才擁有（空手 / 球棒 / 手槍為初始武器）
export const isGun = (id) => id === 'pistol' || id === 'smg' || id === 'shotgun';

export const EQUIP_SEC = 0.3; // 切換武器的收 / 拿時間（秒），期間不能攻擊
export const SWITCH_AT = 0.8; // 攻擊動作進行到此比例以後（收尾）才可切換武器

export const WEAPONS = {
  fist: {
    id: 'fist',
    slot: 0,
    label: '空手',
    damage: PUNCH_DAMAGE,
    cooldown: PUNCH_COOLDOWN,
  },
  bat: {
    id: 'bat',
    slot: 1,
    label: '球棒',
    damage: 35,
    cooldown: 0.75, // 揮擊冷卻（秒）
    clips: ['bat_swing_a', 'bat_swing_b'], // 揮擊交替 a / b
    hitWindow: [0.3, 0.55], // manifest 缺 events.<clip>.hitWindow 時：clip 長度的比例
    clipSec: 0.7, // manifest 缺 clip 長度時的揮擊長度（秒）
    length: 0.85, // 棒長（m），佔位幾何同長
    radius: 0.09, // 掃掠膠囊半徑（m）：棒身半徑 + 容錯
    gripHeight: 1.15, // 程序揮擊弧：握把高度（m，腳底往上）
    gripForward: 0.3, // 握把在身體前方（m）
    arcFrom: 75, // 揮擊弧起點：面向右側幾度（a 由右往左、b 由左往右）
    arcTo: -75,
  },
  pistol: {
    id: 'pistol',
    slot: 2,
    label: '手槍',
    damage: 40,
    magSize: 12,
    startReserve: 36,
    reserveMax: 120,
    infiniteAmmo: true, // 備彈無限（彈匣與換彈照舊）；ammo().reserve 回 Infinity，存檔仍只存數字 reserve
    fireInterval: 0.22, // 最短射擊間隔（秒，半自動按住連發）
    reloadSec: 1.4,
    range: 80, // 射程（m）
    vehicleDamage: 34, // V4：每發打到車的耐久傷害（滿耐久 1000：25 發起火，再 4–6 s 或續射數發爆炸）
    recoilPitch: -0.035, // 每發後座：鏡頭 pitch 增量（rad，負 = 往上抬），再乘 settings.recoil
    recoilYaw: 0.012, // 每發水平後座最大值（rad，左右隨機）
    muzzleHeight: 1.35, // 整合層沒給 aim.muzzle 時：槍口高度（m，腳底往上）
    muzzleForward: 0.45, // 槍口在身體前方（m）
    muzzleRight: 0.2, // 槍口在身體右側（m）
  },
  // 衝鋒槍：全自動（按住連發約 10 發 / 秒）、單發傷害低於手槍、散佈隨連射擴大（停火後收斂）
  smg: {
    id: 'smg',
    slot: 3,
    label: '衝鋒槍',
    damage: 16, // 單發傷害（手槍 40）
    magSize: 30,
    startReserve: 90, // 購買時附贈備彈
    reserveMax: 300,
    auto: true, // 全自動：按住攻擊鍵連發
    fireInterval: 0.1, // 約 10 發 / 秒
    reloadSec: 1.8,
    range: 60,
    vehicleDamage: 18, // 每發車輛耐久傷害（手槍 34；10 發 / 秒 → 每秒約 180，滿耐久 1000 約 5–6 秒起火）
    spreadBase: 0.6, // 首發散佈半角（度）
    spreadPerShot: 0.45, // 每發增加（度）
    spreadMax: 5, // 上限（度）
    spreadRecover: 10, // 停火後每秒收斂（度 / 秒）
    spreadRecoverDelay: 0.2, // 最後一發後多久才開始收斂（秒；> fireInterval，連射中不收斂）
    aimSpreadScale: 0.6, // 肩後瞄準時散佈倍率
    recoilPitch: -0.014,
    recoilYaw: 0.01,
    knockdownHits: 4, // 1.5 s 內同武器 4 發倒地（combat.js KNOCKDOWN_RULES.smg）
    muzzleHeight: 1.32,
    muzzleForward: 0.55,
    muzzleRight: 0.18,
    twoHanded: true, // 雙手持握：無雙手 clip，以 pistol_aim 姿勢近似（offhand 點位見 manifest offHandOffset）
    price: 2500, // 武器店售價（NT$）
    ammoPack: 60, // 武器店一盒彈藥發數
    ammoPrice: 300,
    pickupAmount: 30, // 地上彈藥盒一次
  },
  // 散彈槍：泵動單發（約 1 發 / 秒）、每發 8 顆彈丸錐形散佈；近距離多顆命中可一槍擊倒，遠距離逐顆衰減
  shotgun: {
    id: 'shotgun',
    slot: 4,
    label: '散彈槍',
    pellets: 8,
    pelletDamage: 14, // 每顆彈丸（近距離 8 顆全中 = 112）
    damage: 112, // 參考值：pellets × pelletDamage
    coneDeg: 5, // 錐形散佈半角（度）
    falloffStart: 8, // 此距離（m）內全傷害
    falloffEnd: 30, // 此距離起只剩 falloffMin
    falloffMin: 0.2,
    knockdownRange: 8, // 此距離內同一目標中 ≥ knockdownPellets 顆 → 一槍擊倒
    knockdownPellets: 4,
    comboDamage: 42, // 單發對同一目標合併傷害 ≥ 此值（約 3 顆全傷害）才累積擊倒連擊；遠距擦傷不累積
    magSize: 6,
    startReserve: 18,
    reserveMax: 60,
    fireInterval: 1.0, // 泵動：約 1 發 / 秒（按住也只會每秒一發）
    pump: true,
    reloadSec: 2.6,
    range: 40,
    vehicleDamage: 16, // 每顆彈丸車輛耐久傷害（近距離 8 顆全中 = 128，高於手槍 34；與打人同樣 × pelletFalloff 距離衰減）
    recoilPitch: -0.07,
    recoilYaw: 0.02,
    muzzleHeight: 1.32,
    muzzleForward: 0.85,
    muzzleRight: 0.16,
    twoHanded: true,
    price: 3500,
    ammoPack: 12,
    ammoPrice: 400,
    pickupAmount: 6,
  },
};

// 散彈槍單顆彈丸距離衰減倍率：≤ falloffStart = 1，線性降到 falloffEnd = falloffMin，更遠維持 falloffMin
export function pelletFalloff(dist, def = WEAPONS.shotgun) {
  if (!(dist > def.falloffStart)) return 1;
  if (dist >= def.falloffEnd) return def.falloffMin;
  const k = (dist - def.falloffStart) / (def.falloffEnd - def.falloffStart);
  return 1 - (1 - def.falloffMin) * k;
}

// 觸控瞄準輔助（弱吸附）：與射線夾角 ≤ 6°、≤ 40 m、視線無遮擋的行人
export const AIM_ASSIST_ANGLE = (6 * Math.PI) / 180;
export const AIM_ASSIST_RANGE = 40;
export const AIM_POINT_HEIGHT = 1.2; // 吸附瞄準的身體高度（m，腳底往上，約胸口）

export const DRY_FIRE_INTERVAL = 0.4; // 空槍聲最短間隔（秒）：按住攻擊鍵時不會連續狂響
export const GUNSHOT_HEAR_RADIUS = 30; // 槍聲驚嚇半徑（m，同 npc-ai GUNSHOT_RADIUS；整合層據此挑 brain.hear 的對象）
