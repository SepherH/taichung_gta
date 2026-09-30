// 小吃收集點（契約 §17）：七期街區人行道上的 12 個固定點（遊戲世界 x / z，公尺；x 東、z 南）
// 挑法（離線一次，結果寫死成常數）：places.js pedestrianRoutes() 的人行道生成點中，界內 80 m、避開地標 radius + 20 m，
//   把地圖切 4 × 3 格取最靠近格心者，彼此 ≥ 80 m（實際最近約 350 m）；y 為 querySurface 地面高度
// 驗證：tools/test/collect.mjs 檢查全部 pedWalkable、在 BOUNDS 內、彼此 ≥ 80 m、food id 不重複
// food 對應 public/art/food/manifest.json 的 slug（內建清單 food-guide.js BUILTIN_FOODS 用同一組 id）；road 只是註記用的鄰近路名
export const FOOD_SPOTS = [
  { id: 'spot-01', x: -287.3, y: 0, z: -328.1, food: 'fried-noodles-chili', road: '朝馬三街' },
  { id: 'spot-02', x: 229.4, y: 0, z: -263.5, food: 'da-mian-geng', road: '河南路三段' },
  { id: 'spot-03', x: 578, y: 0, z: -302.6, food: 'sun-cake', road: '上石路' },
  { id: 'spot-04', x: 1030.3, y: 0, z: -320.2, food: 'bubble-tea', road: '惠中路' },
  { id: 'spot-05', x: -290.6, y: 0, z: 144.5, food: 'fengren-ice', road: '龍門路' },
  { id: 'spot-06', x: 160.7, y: 0, z: 155.4, food: 'mitou-ice', road: '惠民路' },
  { id: 'spot-07', x: 585.2, y: 0, z: 143.9, food: 'mayi-soup', road: '惠中二街' },
  { id: 'spot-08', x: 1039.8, y: 0, z: 138.2, food: 'chicken-feet-jelly', road: '臺灣大道三段' },
  { id: 'spot-09', x: -294.5, y: 0, z: 668.6, food: 'yizhong-chicken-cutlet', road: '市政南一路' },
  { id: 'spot-10', x: 147.8, y: 0, z: 615.4, food: 'rou-yuan', road: '市政路' },
  { id: 'spot-11', x: 576.2, y: 0, z: 639.3, food: 'mung-bean-cake', road: '市政北一路' },
  { id: 'spot-12', x: 1034, y: 0, z: 612.4, food: 'salty-sponge-cake', road: '大祥街' },
];

export const FOOD_SPOT_MIN_GAP = 80; // 收集點彼此最小距離（m）
