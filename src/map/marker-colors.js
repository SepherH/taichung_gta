// 事件 / 任務標記色碼的唯一來源：小地圖（src/hud.js）與大地圖（src/map/big-map.js）共用（契約 §17 kind）
// 值以大地圖為準；大地圖的圖例文字（MARKER_LABELS）與本表同一份 kind 清單
export const MARKER_COLORS = {
  'mission-start': '#ffd23f',
  'mission-dest': '#ff8c1a',
  dest: '#2fe0e0',
  checkin: '#b36bff',
  food: '#ff7ab8',
  ammo: '#9aa0a6',
  'event-start': '#8dff3a',
  'event-dest': '#2ee86a',
  'event-truck': '#ff4f6d', // 垃圾車事件（missions/garbage-truck.js markers()；目標會移動，小地圖超出半徑時貼邊）
};
// 無 kind 的標記（可駕駛車輛）與未知 kind 的後備色
export const CAR_MARKER_COLOR = '#4fc3ff';
