// 觸控武器鈕 / 三格輪盤的純邏輯（不碰 DOM，供 hud.js 與無頭測試共用）
// 武器鈕（tb-weapon）：點擊 = 循環切換；按住 ≥ LONG_PRESS_MS 開三格輪盤，手指滑到格子上放開 = 直選該槽
// 輪盤：三格排在武器鈕左上方的扇形（鈕在畫面右側，格子往畫面內側展開）：
//   槽 0 空手 = 左（180°）、槽 1 球棒 = 左上（135°）、槽 2 手槍 = 上（90°）；角度以螢幕座標（x 右、y 下）換成數學角（y 上）
//   離鈕心 < WHEEL_DEAD px 或偏離最近格中心 > WHEEL_HALF_SPAN 視為不選（放開 = 取消）

export const LONG_PRESS_MS = 350;
export const TAP_MOVE_PX = 12; // 點擊判定：按下到放開移動不超過此距離（px）
export const WHEEL_DEAD = 28; // 輪盤中心死區（px）
export const WHEEL_RADIUS = 86; // 格子中心離鈕心距離（px，CSS 擺放用）
export const WHEEL_ANGLES = [180, 135, 90]; // 各槽格子中心角（度，數學角：0 = 右、90 = 上）
export const WHEEL_HALF_SPAN = 45; // 每格接受的角度半寬（度）；兩端格往外多收同樣寬度

// 按壓分類：按住時間 ms、位移 px → 'long'（開輪盤）| 'tap'（循環）| 'none'（短按但滑走了 = 取消）
export function classifyPress(ms, movedPx = 0) {
  if (ms >= LONG_PRESS_MS) return 'long';
  return movedPx <= TAP_MOVE_PX ? 'tap' : 'none';
}

// 是否該開輪盤：按住中經過時間 ≥ LONG_PRESS_MS（不論有沒有移動）
export function isLongPress(ms) {
  return ms >= LONG_PRESS_MS;
}

function angDiff(a, b) {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return Math.abs(d);
}

// 螢幕位移（dx 右正、dy 下正，相對武器鈕中心）→ 槽位 0 / 1 / 2，不選回 -1
export function wheelSlotFromVector(dx, dy, dead = WHEEL_DEAD) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < dead) return -1;
  const ang = (Math.atan2(-dy, dx) * 180) / Math.PI;
  let best = -1;
  let bestD = WHEEL_HALF_SPAN + 1e-9;
  for (let i = 0; i < WHEEL_ANGLES.length; i++) {
    const d = angDiff(ang, WHEEL_ANGLES[i]);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

// 格子中心相對鈕心的螢幕位移（px；y 下正），CSS 擺放用；回傳 out { x, y }
export function wheelCellOffset(slot, out = { x: 0, y: 0 }, radius = WHEEL_RADIUS) {
  const a = (WHEEL_ANGLES[slot] * Math.PI) / 180;
  out.x = Math.cos(a) * radius;
  out.y = -Math.sin(a) * radius;
  return out;
}

// 彈藥文字：手槍「12 / 36」，其餘空字串
export function ammoText(weapon, mag, reserve) {
  return weapon === 'pistol' ? `${mag} / ${reserve}` : '';
}
