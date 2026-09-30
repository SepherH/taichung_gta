// 輸入動作表（契約 §4）：動作名稱 → 按鍵代碼（KeyboardEvent.code，滑鼠左 / 右鍵記為 'Mouse0' / 'Mouse2'）
// 桌機與觸控的操作說明（KEYMAP_HELP / TOUCH_HELP）由本檔單一來源產生：選單「操作說明」頁與 HUD 提示都讀這裡
// reserved：預留動作（尚無功能，說明表不列）；hold：按住有意義（否則只看「本幀剛按下」）
// 三個與舊版衝突的鍵：H 說明 → 喇叭（說明移到暫停選單）、R 翻車 → 預留裝填（翻車改 F 扶起）、E 揮拳 → 互動（攻擊改左鍵）

export const ACTIONS = {
  move: { keys: ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'], label: '移動 / 轉向油門', hold: true },
  sprint: { keys: ['ShiftLeft', 'ShiftRight'], label: '衝刺', hold: true },
  jump: { keys: ['Space'], label: '跳 / 手煞車', hold: true },
  attack: { keys: ['Mouse0'], label: '攻擊', hold: false },
  aim: { keys: ['Mouse2'], label: '瞄準', hold: true, reserved: true },
  interact: { keys: ['KeyE'], label: '互動', hold: false, reserved: true },
  enterExit: { keys: ['KeyF'], label: '上下車 / 搶車 / 扶起', hold: false },
  horn: { keys: ['KeyH'], label: '喇叭', hold: true },
  camera: { keys: ['KeyV'], label: '切換鏡頭距離', hold: false },
  lookBack: { keys: ['KeyC'], label: '回頭看', hold: true },
  radio: { keys: ['KeyQ'], label: '電台', hold: false, reserved: true },
  phone: { keys: ['KeyT'], label: '手機', hold: false, reserved: true },
  map: { keys: ['KeyM'], label: '地圖', hold: false },
  pause: { keys: ['Escape', 'KeyP'], label: '暫停', hold: false },
  timeSkip: { keys: ['KeyN'], label: '時間快轉', hold: false },
  reload: { keys: ['KeyR'], label: '裝填', hold: false, reserved: true },
};

// 桌機操作說明
export const KEYMAP_HELP = [
  {
    group: '步行',
    items: [
      { keys: 'W A S D / 方向鍵', action: 'move', desc: '移動' },
      { keys: 'Shift', action: 'sprint', desc: '衝刺（按住）' },
      { keys: '空白鍵', action: 'jump', desc: '跳' },
      { keys: '滑鼠左鍵', action: 'attack', desc: '攻擊（揮拳）' },
      { keys: 'F', action: 'enterExit', desc: '上車 / 搶車' },
      { keys: '滑鼠移動', action: null, desc: '轉動視角（點畫面鎖定滑鼠，Esc 解除）' },
      { keys: '滾輪', action: null, desc: '拉近 / 拉遠鏡頭' },
    ],
  },
  {
    group: '駕駛',
    items: [
      { keys: 'W / S', action: 'move', desc: '油門 / 煞車倒車' },
      { keys: 'A / D', action: 'move', desc: '轉向' },
      { keys: '空白鍵', action: 'jump', desc: '手煞車' },
      { keys: 'H', action: 'horn', desc: '喇叭' },
      { keys: 'C', action: 'lookBack', desc: '回頭看（按住）' },
      { keys: 'F', action: 'enterExit', desc: '下車 / 扶起翻覆車' },
    ],
  },
  {
    group: '通用',
    items: [
      { keys: 'V', action: 'camera', desc: '切換鏡頭距離（三段）' },
      { keys: 'M', action: 'map', desc: '開啟地圖' },
      { keys: 'Esc / P', action: 'pause', desc: '暫停選單（暫停中按 P 繼續）' },
      { keys: 'N', action: 'timeSkip', desc: '時間快轉' },
    ],
  },
];

// 觸控操作說明（與 touch.js 的按鈕配置一致）
export const TOUCH_HELP = [
  {
    group: '步行',
    items: [
      { keys: '左半邊搖桿', action: 'move', desc: '移動（推到底 = 衝刺）' },
      { keys: '「跑」鈕', action: 'sprint', desc: '衝刺（按住）' },
      { keys: '「跳」鈕', action: 'jump', desc: '跳' },
      { keys: '紅色「攻擊」鈕', action: 'attack', desc: '攻擊（揮拳）' },
      { keys: '「上車」鈕', action: 'enterExit', desc: '上車 / 搶車' },
      { keys: '右半邊拖曳', action: null, desc: '轉動視角；雙指捏合縮放' },
    ],
  },
  {
    group: '駕駛',
    items: [
      { keys: '左半邊搖桿', action: 'move', desc: '轉向' },
      { keys: '右側踏板', action: 'move', desc: '左煞車 / 右油門（手指越往下越深）' },
      { keys: '「手煞」鈕', action: 'jump', desc: '手煞車' },
      { keys: '「喇叭」鈕', action: 'horn', desc: '喇叭' },
      { keys: '「下車」鈕', action: 'enterExit', desc: '下車 / 扶起翻覆車' },
    ],
  },
  {
    group: '通用',
    items: [
      { keys: '左上「暫停」', action: 'pause', desc: '暫停選單' },
      { keys: '左上「地圖」', action: 'map', desc: '開啟地圖' },
    ],
  },
];

// 以 input.down(code) / input.wasPressed(code) 讀動作；未知動作回 false
export function createActionReader(input) {
  const any = (action, fn) => {
    const a = ACTIONS[action];
    if (!a) return false;
    for (const code of a.keys) if (fn(code)) return true;
    return false;
  };
  return {
    down: (action) => any(action, (c) => input.down(c)),
    pressed: (action) => any(action, (c) => input.wasPressed(c)),
  };
}
