// 武器定義（契約 §13）：三槽（0 空手 / 1 球棒 / 2 手槍）的數值常數，weapons.js / hud.js / 測試共用
// 數值為手感設定（推測值，非實測）；拳擊數值沿用 combat.js（PUNCH_DAMAGE / PUNCH_COOLDOWN）
import { PUNCH_DAMAGE, PUNCH_COOLDOWN } from '../combat.js';

export const SLOT_IDS = ['fist', 'bat', 'pistol']; // 槽位 → 武器 id

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
    fireInterval: 0.22, // 最短射擊間隔（秒，半自動按住連發）
    reloadSec: 1.4,
    range: 80, // 射程（m）
    recoilPitch: -0.035, // 每發後座：鏡頭 pitch 增量（rad，負 = 往上抬），再乘 settings.recoil
    recoilYaw: 0.012, // 每發水平後座最大值（rad，左右隨機）
    muzzleHeight: 1.35, // 整合層沒給 aim.muzzle 時：槍口高度（m，腳底往上）
    muzzleForward: 0.45, // 槍口在身體前方（m）
    muzzleRight: 0.2, // 槍口在身體右側（m）
  },
};

// 觸控瞄準輔助（弱吸附）：與射線夾角 ≤ 6°、≤ 40 m、視線無遮擋的行人
export const AIM_ASSIST_ANGLE = (6 * Math.PI) / 180;
export const AIM_ASSIST_RANGE = 40;
export const AIM_POINT_HEIGHT = 1.2; // 吸附瞄準的身體高度（m，腳底往上，約胸口）

export const DRY_FIRE_INTERVAL = 0.4; // 空槍聲最短間隔（秒）：按住攻擊鍵時不會連續狂響
export const GUNSHOT_HEAR_RADIUS = 30; // 槍聲驚嚇半徑（m，同 npc-ai GUNSHOT_RADIUS；整合層據此挑 brain.hear 的對象）
