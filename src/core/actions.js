// 輸入動作表（契約 §4 / §12）：動作名稱 → 按鍵代碼（KeyboardEvent.code，滑鼠左 / 右鍵記為 'Mouse0' / 'Mouse2'）
// 桌機與觸控的操作說明（KEYMAP_HELP / TOUCH_HELP）由本檔單一來源產生：選單「操作說明」頁與 HUD 提示都讀這裡
// reserved：預留動作（尚無功能，說明表不列）；hold：按住有意義（否則只看「本幀剛按下」）
// 三個與舊版衝突的鍵：H 說明 → 喇叭（說明移到暫停選單）、R 翻車 → 裝填（翻車改 F 扶起）、E 揮拳 → 互動（攻擊改左鍵）
// Phase 4（§12）：aim / interact / reload 取消預留；Q 由電台改為武器循環（radio 移除）；1 / 2 / 3 直選武器
// Phase 6（§23.3）：phone（T）取消預留，列入說明表；實際開手機由整合層接 ui/phone.js
// Phase 5：情境動作 CONTEXT_ACTIONS——與 ACTIONS 共用按鍵、只在特定模式有效（Q：步行 = weaponCycle、駕駛 = radioNext）
//   不放進 ACTIONS（ACTIONS 維持「同一 code 只綁一個 action」）；以 reader.pressedIn(action, mode) / actionForKey(code, mode) 分流

export const ACTIONS = {
  move: { keys: ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'], label: '移動 / 轉向油門', hold: true },
  sprint: { keys: ['ShiftLeft', 'ShiftRight'], label: '衝刺', hold: true },
  jump: { keys: ['Space'], label: '跳 / 手煞車', hold: true },
  attack: { keys: ['Mouse0'], label: '攻擊（依武器）', hold: true }, // 手槍按住半自動連發
  aim: { keys: ['Mouse2'], label: '肩後瞄準', hold: true },
  interact: { keys: ['KeyE'], label: '互動', hold: false },
  enterExit: { keys: ['KeyF'], label: '上下車 / 搶車 / 扶起', hold: false },
  horn: { keys: ['KeyH'], label: '喇叭', hold: true },
  camera: { keys: ['KeyV'], label: '切換鏡頭距離', hold: false },
  lookBack: { keys: ['KeyC'], label: '回頭看', hold: true },
  weaponCycle: { keys: ['KeyQ'], label: '循環切換武器', hold: false },
  slot1: { keys: ['Digit1'], label: '空手', hold: false },
  slot2: { keys: ['Digit2'], label: '球棒', hold: false },
  slot3: { keys: ['Digit3'], label: '手槍', hold: false },
  phone: { keys: ['KeyT'], label: '手機', hold: false },
  map: { keys: ['KeyM'], label: '大地圖', hold: false },
  pause: { keys: ['Escape', 'KeyP'], label: '暫停', hold: false },
  timeSkip: { keys: ['KeyN'], label: '時間快轉', hold: false },
  reload: { keys: ['KeyR'], label: '裝填', hold: false },
};

// 動作有效的模式（'walk' | 'vehicle'）；未列 = 兩種模式都有效。整合層 main.js 既有分流：weaponCycle / slot / reload 只在 mode === 'walk' 處理
export const ACTION_MODES = {
  weaponCycle: 'walk',
  slot1: 'walk',
  slot2: 'walk',
  slot3: 'walk',
  reload: 'walk',
};

// 情境動作：keys 可與 ACTIONS 重疊，但 mode 必須與該鍵在 ACTIONS 的動作互斥
// radioNext：駕駛中換台（下一台 → … → 關閉 → 第一台）；觸控由整合單元做按鈕，送 action 名 'radioNext'（或虛擬鍵 KeyQ）
export const CONTEXT_ACTIONS = {
  radioNext: { keys: ['KeyQ'], label: '電台：下一台 / 關閉', hold: false, mode: 'vehicle' },
};

const defOf = (action) => ACTIONS[action] || CONTEXT_ACTIONS[action] || null;
const modeOf = (action) => (CONTEXT_ACTIONS[action] ? CONTEXT_ACTIONS[action].mode : ACTION_MODES[action] || null);

// 動作在該模式是否有效（未知動作 false）
export function actionActiveIn(action, mode) {
  if (!defOf(action)) return false;
  const m = modeOf(action);
  return m === null || m === mode;
}

// 某鍵在該模式下對應的動作名（ACTIONS 優先，其次 CONTEXT_ACTIONS）；無 → null
export function actionForKey(code, mode) {
  for (const table of [ACTIONS, CONTEXT_ACTIONS]) {
    for (const name of Object.keys(table)) {
      if (table[name].keys.includes(code) && actionActiveIn(name, mode)) return name;
    }
  }
  return null;
}

// 桌機操作說明
export const KEYMAP_HELP = [
  {
    group: '步行',
    items: [
      { keys: 'W A S D / 方向鍵', action: 'move', desc: '移動' },
      { keys: 'Shift', action: 'sprint', desc: '衝刺（按住）' },
      { keys: '空白鍵', action: 'jump', desc: '跳' },
      { keys: '滑鼠左鍵', action: 'attack', desc: '攻擊（依武器；手槍可按住連發）' },
      { keys: '滑鼠右鍵', action: 'aim', desc: '肩後瞄準（持手槍，按住）' },
      { keys: 'Q', action: 'weaponCycle', desc: '循環切換武器' },
      { keys: '1', action: 'slot1', desc: '切換：空手' },
      { keys: '2', action: 'slot2', desc: '切換：球棒' },
      { keys: '3', action: 'slot3', desc: '切換：手槍' },
      { keys: 'R', action: 'reload', desc: '裝填' },
      { keys: 'E', action: 'interact', desc: '互動（接委託 / 打卡 / 外送取餐 / 倒垃圾 / 收集小吃 / 撿彈藥）' },
      { keys: 'F', action: 'enterExit', desc: '上車 / 搶車' },
      { keys: '滑鼠移動', action: null, desc: '轉動視角（點畫面鎖定滑鼠，Esc 解除）' },
      { keys: '滾輪', action: null, desc: '拉近 / 拉遠鏡頭微調（按 V 回到段位；瞄準中不縮放）' },
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
      { keys: 'Q', action: null, desc: '換電台（只在車上；循環含關閉）' }, // radioNext 屬 CONTEXT_ACTIONS（說明列 action 只收 ACTIONS 鍵）
      { keys: 'E', action: 'interact', desc: '互動（接委託 / 打卡 / 外送取餐 / 倒垃圾）' },
      { keys: 'F', action: 'enterExit', desc: '下車 / 扶起翻覆車' },
    ],
  },
  {
    group: '通用',
    items: [
      { keys: 'V', action: 'camera', desc: '切換鏡頭距離（近 / 中 / 遠；步行與駕駛各自記憶）' },
      { keys: 'T', action: 'phone', desc: '開 / 關手機（任務 / 地圖 / 設定）' },
      { keys: 'M', action: 'map', desc: '開 / 關大地圖' },
      { keys: 'Esc / P', action: 'pause', desc: '暫停選單（暫停中按 P 繼續）' },
      { keys: 'N', action: 'timeSkip', desc: '時間快轉' },
      // 時段事件說明（無對應鍵位）：垃圾車 missions/garbage-truck.js（16–18 時）；夜市外送見上方 E 互動
      { keys: '傍晚垃圾車', action: null, desc: '16–18 時出現（小地圖紅點、聽《給愛麗絲》），3 分鐘內追上車尾按 E 倒垃圾（步行 / 駕駛皆可）' },
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
      { keys: '紅色「攻擊」鈕', action: 'attack', desc: '攻擊（依武器；手槍可按住連發）' },
      { keys: '「武器」鈕', action: 'weaponCycle', desc: '點擊循環切換武器；長按開輪盤，滑到格子放開直選' },
      { keys: '「瞄準」鈕', action: 'aim', desc: '肩後瞄準（持手槍時顯示，按住）' },
      { keys: '「裝填」鈕', action: 'reload', desc: '裝填（持手槍時顯示）' },
      { keys: '「互動」鈕', action: 'interact', desc: '互動（有提示時顯示）' },
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
      { keys: '「電台」鈕', action: null, desc: '換台（車上顯示）' }, // hud.js tb-radio（送虛擬 KeyQ = radioNext）
      { keys: '「下車」鈕', action: 'enterExit', desc: '下車 / 扶起翻覆車' },
    ],
  },
  {
    group: '通用',
    items: [
      { keys: '左上「暫停」', action: 'pause', desc: '暫停選單' },
      { keys: '左上「地圖」', action: 'map', desc: '開 / 關大地圖' },
      { keys: '左上「手機」', action: 'phone', desc: '開手機（任務 / 地圖 / 設定；手機內「返回」關閉）' }, // touch.js tb-phone（slot tl4，main.js onTap 開手機）
      { keys: '「視角」鈕', action: 'camera', desc: '切換鏡頭距離（近 / 中 / 遠）' }, // touch.js tb-view（虛擬 KeyV；橫向右上、直向步行左上小鈕列下方、直向駕駛右半電台鈕下方）
      { keys: '左上「圖鑑」', action: null, desc: '開 / 關小吃圖鑑（步行時顯示）' }, // tb-guide 無對應鍵位（onTap 開圖鑑）
      { keys: '傍晚垃圾車', action: null, desc: '16–18 時出現（小地圖紅點），3 分鐘內追上車尾點「互動」鈕倒垃圾（步行 / 駕駛皆可）' },
    ],
  },
];

// 以 input.down(code) / input.wasPressed(code) 讀動作；未知動作回 false
// down / pressed 不看模式（相容既有用法）；downIn / pressedIn 另檢查 actionActiveIn(action, mode)
export function createActionReader(input) {
  const any = (action, fn) => {
    const a = defOf(action);
    if (!a) return false;
    for (const code of a.keys) if (fn(code)) return true;
    return false;
  };
  return {
    down: (action) => any(action, (c) => input.down(c)),
    pressed: (action) => any(action, (c) => input.wasPressed(c)),
    downIn: (action, mode) => actionActiveIn(action, mode) && any(action, (c) => input.down(c)),
    pressedIn: (action, mode) => actionActiveIn(action, mode) && any(action, (c) => input.wasPressed(c)),
  };
}
