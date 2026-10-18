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

// 超商（Phase 9，src/wanted/robbery.js 超商搶劫）：x / z = 門口人行道點（小光柱 / 地圖標記），counterX / counterZ = 店員櫃檯點，
// clerkYaw = 店員面向（櫃檯 → 門口，前方 = (sin yaw, cos yaw)）
// 來源（src/data/osm-city.json，2026-10 查）：B / L / P / R / F 內 name 含「7-ELEVEN」「7-11」「統一超商」「全家」「FamilyMart」「萊爾富」
//   「OK」「超商」「便利」者只有 B「全家便利商店」1 筆（id 491492673）；另有「台灣楓康超市」「全聯福利中心」2 筆為超市（非超商）不採用
// - 全家：輪廓東緣（−393.9, 103）–（−389.8, 91.6）面向黎明路二段（secondary，寬 16 m；東緣到路緣約 6.2 m），
//   門口 = 東緣中點往外 3.4 m 的人行道點（距路緣約 2.8 m）；櫃檯 = 門口往建物內 2 m（離外牆 1.4 m，仍在建物碰撞體外，店員才看得到 / 打得到）
// - 不足 3 間 → 其餘 3 間為七期主要路口的推測位置：路口 35 m 內取「離路緣 2.4–3.0 m、離 OSM 建物 ≥ 4.5 m、不在水域」的人行道點中最近路口者，
//   櫃檯 = 往遠離道路方向 2 m（離路緣 ≥ 4.2 m）；三點 15 m 內皆無建物（含填充建築），不需等 osm-city.json 重建
export const STORES = Object.freeze([
  Object.freeze({
    id: 'store-familymart-liming',
    name: '全家便利商店（黎明路二段）',
    osmId: 491492673,
    x: -388.7,
    z: 98.5,
    counterX: -390.5,
    counterZ: 97.8,
    clerkYaw: 1.226,
    inferred: false,
  }),
  Object.freeze({
    id: 'store-huizhong-shizhengbei1',
    name: '惠中市政北一路口超商（推測）',
    osmId: null,
    osmRoadId: 666398456, // 市政北一路（tertiary，寬 12 m），惠中路一段口西南側
    x: 490.0,
    z: 586.0,
    counterX: 491.1,
    counterZ: 584.3,
    clerkYaw: -0.558,
    inferred: true,
  }),
  Object.freeze({
    id: 'store-henan-shizhengbei1',
    name: '河南市政北一路口超商（推測）',
    osmId: null,
    osmRoadId: 1049620878, // 河南路三段（tertiary，寬 12 m），市政北一路口西南側
    x: -74.0,
    z: 252.0,
    counterX: -75.7,
    counterZ: 251.0,
    clerkYaw: 1.039,
    inferred: true,
  }),
  Object.freeze({
    id: 'store-huizhong-shizhengbei7',
    name: '市政府惠中路口超商（推測）',
    osmId: null,
    osmRoadId: 638723039, // 惠中路一段（tertiary，寬 9.6 m），市政北七路口南側、近臺中市政府
    x: 746.0,
    z: 165.0,
    counterX: 744.3,
    counterZ: 164.0,
    clerkYaw: 1.027,
    inferred: true,
  }),
]);
