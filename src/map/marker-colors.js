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
  'job-start': '#9b7bff', // 打工接單點（missions/jobs.js：夜市攤位 / 泊車亭）
  'job-dest': '#d6c8ff', // 打工目的地（跑單客人 / 泊車車格；大地圖畫圖釘）
  'job-car': '#f4f4f4', // 代客泊車指定車（會移動，小地圖超出半徑時貼邊由 hud.js EDGE_KINDS）
  'spray-shop': '#e040fb', // 噴漆廠（Phase 8，src/wanted/places.js SPRAY_SHOPS；小地圖沿用既有畫法，不貼邊，同光柱洋紅色）
  fugitive: '#ff1744', // 逃犯車（Phase 11 警車任務，src/missions/vigilante.js markers()；會移動，小地圖超出半徑時貼邊由 hud.js EDGE_KINDS）
  store: '#43a047', // 超商（Phase 9，src/wanted/places.js STORES；小地圖畫綠底「超」字圖示（hud.js ICON_KINDS），不貼邊，同小光柱綠色）
  'street-event': '#ffee58', // V3 街頭事件（src/street-events.js markers()；事件開始 / 提示後短暫閃爍的黃點，小地圖超出半徑時貼邊由 hud.js EDGE_KINDS）
  'race-start': '#fb8c00', // 街頭競速起點（Phase 12，src/missions/race.js markers()；小地圖畫橘色旗幟圖示（hud.js FLAG_KINDS），不貼邊，同起點光柱橘色）
  'race-cp': '#ffca28', // 街頭競速下一個檢查點（比賽中只有一個；小地圖超出半徑時貼邊由 hud.js EDGE_KINDS）
};
// 無 kind 的標記（可駕駛車輛）與未知 kind 的後備色
export const CAR_MARKER_COLOR = '#4fc3ff';
