// 臺中七期城市設定（M1：真實 OSM 街區）
// 道路、建築輪廓、公園與水域全部來自 src/data/osm-city.json（由 tools/build-city.mjs 從 OSM 轉出，
// 地圖資料 © OpenStreetMap contributors，ODbL）。本檔只放遊戲參數與小知識，不放任何杜撰的地圖資料。
// 座標系：X 向東、Z 向南（北方為 -Z），Y 向上，單位公尺，1:1 真實比例；原點為老虎城輪廓中心。

// 城市亂數種子（固定，確保每次載入的配置一致）
export const CITY_SEED = 20260930;

// 老虎城購物中心的 OSM way id（出生點與停車位置以它為中心）
export const TIGER_CITY_ID = 150999799;

// 出生點所在的那一側道路（老虎城面向河南路三段）
export const SPAWN_ROAD_NAME = '河南路三段';

// 路邊停放的車輛（依序擺在老虎城周邊 150m 內的路邊，第一台最靠近出生點）
export const PARKED_TYPES = [
  { type: 'sedan', color: '#f2f2f2' },
  { type: 'scooter', color: '#2e8bd8' },
  { type: 'taxi', color: '#f5c518' },
  { type: 'suv', color: '#22252a' },
  { type: 'sedan', color: '#c0262d' },
  { type: 'sedan', color: '#2d5fb0' },
  { type: 'suv', color: '#8a8f94' },
];
export const PARKED_RADIUS = 150;

// 車流 / 行人預算的相容表：Traffic 未注入 budget（core/quality.js qualityBudget 物件）時，舊的 crowd 字串 'high' | 'low'
// 對應這兩列（同主控裁決後的畫質表 high / low 列；正式數值以 core/quality.js 為準，本表只給舊呼叫端與無頭測試）
// cars：車流總台數（含公車 ≤ 2、機車約 motorbikeShare）；peds：行人目標人數；pedNear / pedFar：完整骨架 / 替身分界半徑（m）
export const TRAFFIC_BUDGET_FALLBACK = {
  low: { id: 'low', peds: 40, cars: 18, pedNear: 30, pedFar: 70, motorbikeShare: 0.4 },
  high: { id: 'high', peds: 140, cars: 45, pedNear: 50, pedFar: 110, motorbikeShare: 0.4 },
};
// 行人生成加權的百貨門口（OSM way id）：新光三越、老虎城購物中心、Top City 台中大遠百
export const CROWD_MALL_IDS = [148849083, 150999799, 224955652];

// 地面物件（角色、車輛）的顯示高度偏移：道路面在 y≈0.1，避免腳陷進路面
export const SURFACE_OFFSET = 0.1;

// 臺中小知識（載入畫面隨機顯示；只收錄確定正確的常識）
export const TRIVIA = [
  '臺中國家歌劇院由日本建築師伊東豊雄設計，2016 年開幕。',
  '秋紅谷景觀生態公園是一座下凹式公園，中央有一座人工湖。',
  '臺灣大道由原本的中正路與中港路整併改名而來，是貫穿臺中市區的主要幹道。',
  '2010 年 12 月 25 日，臺中縣與臺中市合併升格為直轄市。',
  '太陽餅是臺中最有名的伴手禮之一，傳統內餡是麥芽糖。',
  '臺中公園的湖心亭建於 1908 年，是為了縱貫鐵路全線通車典禮而興建。',
  '臺中捷運綠線於 2021 年正式通車，有一大段沿著文心路行駛。',
  '宮原眼科原本是日治時期的眼科診所，現在是知名的甜點店。',
  '逢甲夜市緊鄰逢甲大學，是臺灣規模最大的夜市之一。',
  '「七期」指的是臺中市第七期市地重劃區，以高樓住宅與百貨商圈聞名。',
  '大甲媽祖遶境進香為期九天八夜，是臺灣規模最大的宗教活動之一。',
  '臺中是珍珠奶茶的發源地之一。',
];
