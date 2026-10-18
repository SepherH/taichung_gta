// 通緝流程的重生點（Phase 7）：被捕 → 警察局門口、送醫 → 醫院門口
// 座標 = 世界座標（X 東、Z 南，m；同 osm-city.json 投影），yaw = 玩家出現時面向（前方 = (sin yaw, cos yaw)）
// 來源（src/data/osm-city.json，2026-10 查）：
// - 警察局：B 層「臺中市政府警察局第六分局」（id 260107782，輪廓首點約 x 118.4, z 507.7；七期範圍內最近的警察機關）
//   門口取輪廓西南角（98.4, 510.2）最近的道路（無名 residential，寬 8 m，最近點約 x 88.2, z 503.7）
//   往建物方向退到路緣外 2 m 的人行道點，面向道路
// - 醫院：osm-city.json 內 name 含「醫院」「診所」者 0 筆 → 推測位置：河南路三段（七期主要道路）老虎城南側路段的
//   人行道空地（路緣外 2.5 m、距最近建物輪廓約 50 m、不在水域），面向道路；之後若 OSM 補上醫院再改
// 同時列出其他警察機關供日後擴充（目前只用最近七期者）：黎明派出所（id 224651807）、刑事警察大隊（id 1013262950）

export const POLICE_STATION = Object.freeze({
  id: 'police-6th-precinct',
  name: '臺中市政府警察局第六分局',
  osmId: 260107782,
  x: 93.3,
  z: 506.9,
  yaw: -2.142,
  inferred: false,
});

export const HOSPITAL = Object.freeze({
  id: 'hospital-inferred',
  name: '醫院（推測位置）',
  osmId: null,
  x: 106.9,
  z: -55.1,
  yaw: 1.04,
  inferred: true, // osm-city.json 無醫院 / 診所資料：七期河南路三段旁空地（推測位置）
});

// 被捕 / 送醫 → 重生點
export function respawnPlace(kind) {
  return kind === 'wasted' ? HOSPITAL : POLICE_STATION;
}

// 噴漆廠（Phase 8，src/wanted/spray.js）：osm-city.json 的 B（建物）/ L（地標）/ P（點位）內 name 含
// 「汽車」「保養」「修車」「車業」「輪胎」「美容」者只有「汽車旅館」2 筆（非修車業），故三處皆為推測位置：
// 取七期 / 市政府周邊的大路（道路寬 w，見 R 陣列），路緣外 2 m（市政路 / 文心路二段加 0.4 m 緩衝至 2.4 m）退到
// 人行道、面向道路的點；yaw：前方 = (sin yaw, cos yaw)
export const SPRAY_SHOPS = Object.freeze([
  Object.freeze({
    id: 'spray-shizheng',
    name: '七期汽車美容（推測）',
    osmRoadId: 1044403394, // 市政路（tertiary，寬 12 m），近臺中市政府警察局第六分局
    x: 102.8,
    z: 553.0,
    yaw: -0.537,
    inferred: true,
  }),
  Object.freeze({
    id: 'spray-wenxin',
    name: '市政府文心路汽車美容（推測）',
    osmRoadId: 362714504, // 文心路二段（secondary，寬 9.6 m），近臺中市政府都市發展局 / 環保局 / 刑事警察大隊
    x: 973.4,
    z: 514.4,
    yaw: 1.059,
    inferred: true,
  }),
  Object.freeze({
    id: 'spray-huilai',
    name: '七期惠來路汽車美容（推測）',
    osmRoadId: 916105182, // 惠來路二段（residential，寬 12.8 m），近新光三越（七期商圈）
    x: 549.8,
    z: -81.7,
    yaw: -2.130,
    inferred: true,
  }),
]);
