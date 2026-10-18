// 選單巡覽看點定義（純資料，不 import 任何模組）：src/ui/menu-tour.js tourStops 與 tools/build-city.mjs 填充避讓共用
//   key、顯示名、比對具名建築名稱的規則（同名取面積最大者）；source = 'basin'（osm-city.json T.basins，名稱比對 re）/ 'stall'（夜市攤車，main.js stallRow 原攤車格）另由專屬資料推導
export const STOP_DEFS = [
  { key: 'tiger', name: 'Tiger City（老虎城）', re: /^老虎城/ },
  { key: 'shinkong', name: '新光三越', re: /^新光三越$/ },
  { key: 'stall', name: '夜市攤車', source: 'stall' },
  { key: 'opera', name: '臺中國家歌劇院', re: /歌劇院/ },
  { key: 'cityhall', name: '臺中市政府', re: /^臺中市政府臺灣大道市政大樓$/ },
  { key: 'mrt', name: '捷運市政府站', re: /^捷運市政府站$/ },
  { key: 'qiuhonggu', name: '秋紅谷', source: 'basin', re: /秋紅谷/ },
];
