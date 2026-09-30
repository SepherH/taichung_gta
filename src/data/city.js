// 臺中七期城市資料（M1 prototype）
// 座標系：X 向東、Z 向南（北方為 -Z），單位公尺，Y 向上。
// 做法對齊參考作：風格化、距離壓縮、軸對齊棋盤街廓；臺灣大道視為東西向（X 軸）。
// 所有配置皆為憑記憶的示意，待校正項目列在 ROADMAP.md「待校正」段。

// 遊戲世界範圍（出界由隱形牆擋住）
export const BOUNDS = { minX: -450, maxX: 450, minZ: -350, maxZ: 350 };

// 人行道寬度（道路兩側各一條）
export const SIDEWALK = 5;

// 城市亂數種子（固定，確保每次載入的建築配置一致）
export const CITY_SEED = 20260930;

// 東西向道路（由北到南）
// width：路寬（不含人行道）；lanes：單向車道數；median：中央分隔島寬度
export const ROADS_EW = [
  { id: 'taiwan', name: '臺灣大道三段', z: -300, width: 50, lanes: 4, median: 6 },
  { id: 'n7', name: '市政北七路', z: -200, width: 24, lanes: 2 },
  { id: 'n6', name: '市政北六路', z: -110, width: 22, lanes: 2 },
  { id: 'n5', name: '市政北五路', z: -30, width: 22, lanes: 2 },
  { id: 'n3', name: '市政北三路', z: 60, width: 22, lanes: 2 },
  { id: 'n2', name: '市政北二路', z: 160, width: 24, lanes: 2 },
  { id: 'shizheng', name: '市政路', z: 280, width: 28, lanes: 2 },
];

// 南北向道路（由西到東）
// from / to：道路的 Z 起訖（省略代表貫穿全圖）。
// 惠中路只畫到市政北三路、惠民路從市政北三路往南，
// 這樣市政府（惠中～文心）與歌劇院（惠來～惠民）的街廓才不會被道路切開。
export const ROADS_NS = [
  { id: 'chaofu', name: '朝富路', x: -380, width: 24, lanes: 2 },
  { id: 'henan', name: '河南路三段', x: -230, width: 30, lanes: 2 },
  { id: 'huilai', name: '惠來路二段', x: -60, width: 24, lanes: 2 },
  { id: 'huizhong', name: '惠中路一段', x: 90, width: 24, lanes: 2, from: -350, to: 60 },
  { id: 'huimin', name: '惠民路', x: 220, width: 20, lanes: 1, from: 60, to: 350 },
  { id: 'wenxin', name: '文心路二段', x: 360, width: 40, lanes: 3, median: 4 },
];

// 秋紅谷下凹地形參數（world.js 的 heightAt 使用）
export const QIUHONG_BOWL = {
  x0: -360, x1: -252, z0: -268, z1: -219,
  depth: 5, // 谷底深度
  slope: 10, // 斜坡水平寬度
  pondX: -306, pondZ: -243, pondRX: 24, pondRZ: 11,
  pondDepth: 1.2, // 水池比谷底再深多少
  waterY: -5.5, // 水面高度
};

// 地標
// zone：地標保留的街廓範圍（不放程序建築，進入時顯示地標名）
// footprint：主體碰撞範圍；plaza：鋪面廣場範圍
export const LANDMARKS = [
  {
    id: 'tiger',
    name: 'Tiger City 老虎城',
    shortName: '老虎城',
    zone: { x0: -230, x1: -60, z0: -200, z1: -110 },
    footprint: { x0: -200, x1: -86, z0: -172, z1: -128 },
    plaza: { x0: -210, x1: -77, z0: -183, z1: -126 },
    height: 24,
    mapColor: '#f28c1a',
    info: '老虎城（Tiger City）是七期的大型購物中心，也是本作的出生點。',
  },
  {
    id: 'qiuhong',
    name: '秋紅谷景觀生態公園',
    shortName: '秋紅谷',
    zone: { x0: -380, x1: -230, z0: -300, z1: -200 },
    footprint: null, // 可走進去，沒有主體碰撞
    plaza: null,
    height: 0,
    mapColor: '#4f9a5a',
    info: '秋紅谷是一座下凹式的景觀公園，中央有人工湖，可以走下去逛逛。',
  },
  {
    id: 'skm',
    name: '新光三越',
    shortName: '新光三越',
    zone: { x0: -60, x1: 15, z0: -300, z1: -200 },
    footprint: { x0: -40, x1: 10, z0: -266, z1: -222 },
    plaza: { x0: -43, x1: 73, z0: -270, z1: -217 },
    height: 72,
    mapColor: '#d84a5a',
    info: '新光三越臺中中港店位在臺灣大道旁，是七期百貨商圈的代表之一。',
  },
  {
    id: 'ftc',
    name: '大遠百',
    shortName: '大遠百',
    zone: { x0: 15, x1: 90, z0: -300, z1: -200 },
    footprint: { x0: 22, x1: 70, z0: -266, z1: -222 },
    plaza: null, // 與新光三越共用廣場
    height: 64,
    mapColor: '#3a6fd8',
    info: '大遠百與新光三越比鄰，兩棟百貨一起構成臺灣大道上的逛街熱點。',
  },
  {
    id: 'cityhall',
    name: '臺中市政府',
    shortName: '市政府',
    zone: { x0: 90, x1: 360, z0: -300, z1: -200 },
    footprint: null, // 雙棟另外定義
    buildings: [
      { x0: 110, x1: 180, z0: -262, z1: -226 },
      { x0: 265, x1: 332, z0: -262, z1: -226 },
    ],
    plaza: { x0: 107, x1: 335, z0: -270, z1: -217 },
    height: 48,
    mapColor: '#9aa3ad',
    info: '臺中市政府的臺灣大道市政大樓位在七期（本作簡化為雙棟加中央廣場）。',
  },
  {
    id: 'opera',
    name: '臺中國家歌劇院',
    shortName: '歌劇院',
    zone: { x0: -60, x1: 220, z0: 60, z1: 160 },
    footprint: { x0: 5, x1: 155, z0: 88, z1: 136 },
    plaza: { x0: -43, x1: 205, z0: 76, z1: 143 },
    height: 28,
    mapColor: '#e8e4dc',
    info: '臺中國家歌劇院由日本建築師伊東豊雄設計，2016 年開幕，以曲牆結構聞名。',
  },
];

// 玩家出生點：老虎城北側門口，面向南方（看得到老虎城立面）
// yaw 定義：前進方向為 (sin(yaw), cos(yaw))，yaw=0 朝南、π 朝北、π/2 朝東
export const SPAWN = { x: -143, z: -181, yaw: Math.PI }; // 背對老虎城、面向街道與路邊車輛

// 路邊停放的車輛（路邊停車格位置 = 道路中心 ± (半路寬 - 1.3)）
export const PARKED_VEHICLES = [
  { type: 'sedan', color: '#f2f2f2', x: -182, z: -188.7, yaw: Math.PI / 2 },
  { type: 'taxi', color: '#f5c518', x: -166, z: -188.7, yaw: Math.PI / 2 },
  { type: 'suv', color: '#22252a', x: -150, z: -188.7, yaw: Math.PI / 2 },
  { type: 'scooter', color: '#2e8bd8', x: -128, z: -188.4, yaw: Math.PI / 2 },
  { type: 'sedan', color: '#c0262d', x: -216.3, z: -150, yaw: Math.PI },
  { type: 'sedan', color: '#2d5fb0', x: -71.3, z: -150, yaw: 0 },
  { type: 'scooter', color: '#d83a2e', x: -138, z: -119.7, yaw: -Math.PI / 2 },
  { type: 'suv', color: '#8a8f94', x: -40, z: -210.7, yaw: -Math.PI / 2 },
];

// 行駛車流迴圈：roads = [北側東西路, 南側東西路, 西側南北路, 東側南北路]
// clockwise：順時針（北方朝上看），靠右行駛
export const TRAFFIC_LOOPS = [
  { roads: ['taiwan', 'n5', 'henan', 'wenxin'], clockwise: true, cars: 2, speed: 12 },
  { roads: ['n7', 'shizheng', 'chaofu', 'huilai'], clockwise: false, cars: 2, speed: 10 },
  { roads: ['n3', 'shizheng', 'huilai', 'wenxin'], clockwise: true, cars: 2, speed: 11 },
  { roads: ['taiwan', 'n2', 'chaofu', 'wenxin'], clockwise: false, cars: 2, speed: 13 },
];

export const PEDESTRIAN_COUNT = 15;

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
