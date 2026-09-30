// 物理碰撞群組（collision / solver groups）契約：D2c1 / D2c2 / D5 共用，數值改動需同步所有單元
// Rapier InteractionGroups 為 32 位元：高 16 位 = membership（我屬於哪些組），低 16 位 = filter（我要跟哪些組互動）
// 兩個 collider a、b 互動條件（見 dist/geometry/interaction_groups.d.ts）：
//   ((a >> 16) & b) != 0 && ((b >> 16) & a) != 0
// 本檔只放純數值與位元運算（不 import rapier），node 可直接測試。

export const WORLD = 1 << 0; //      0x0001 地形 heightfield、平地 cuboid、建築凸柱、walkable、湖面阻擋、邊界牆（全部固定體）
export const PLAYER = 1 << 1; //     0x0002 玩家步行膠囊（KinematicCharacterController）
export const VEHICLE = 1 << 2; //    0x0004 玩家駕駛 / 可上車的車輛動態剛體
export const NPC_CAR = 1 << 3; //    0x0008 車流 NPC 車輛
export const PEDESTRIAN = 1 << 4; // 0x0010 行人 NPC（膠囊；被撞時切動態剛體仍屬此組）
export const SENSOR = 1 << 5; //     0x0020 感測區（上車範圍、拳擊命中窗、觸發區），collider 須 setSensor(true)，只產生 intersection
export const DEBRIS = 1 << 6; //     0x0040 小型可撞飛物件（街具碎片等）

export const ALL = 0xffff;

// 互相碰撞矩陣（對稱；true = 兩組會互動）
//              WORLD PLAYER VEHICLE NPC_CAR PEDESTRIAN SENSOR DEBRIS
// WORLD          -     ✔      ✔       ✔        ✔         ✘      ✔
// PLAYER         ✔     ✘      ✔       ✔        ✔         ✔      ✘
// VEHICLE        ✔     ✔      ✔       ✔        ✔         ✔      ✔
// NPC_CAR        ✔     ✔      ✔       ✔        ✔         ✔      ✔
// PEDESTRIAN     ✔     ✔      ✔       ✔        ✔         ✔      ✘
// SENSOR         ✘     ✔      ✔       ✔        ✔         ✘      ✘
// DEBRIS         ✔     ✘      ✔       ✔        ✘         ✘      ✔
// 說明：
// - WORLD 彼此都是固定體，Rapier 本來就不算固定體對固定體，矩陣上標 -（filter 不含 WORLD）
// - PEDESTRIAN ↔ VEHICLE / NPC_CAR 要碰（被撞倒）；PEDESTRIAN ↔ PEDESTRIAN 要碰（人群互相擋）
// - PLAYER 只有一個，不必與自己互動；DEBRIS 不擋角色（避免碎片卡腳），只跟世界、車、碎片互撞
// - SENSOR 不與世界 / 感測區 / 碎片互動，只偵測角色與車輛；collider 必須 setSensor(true) 才是純 intersection
const MATRIX = [
  [WORLD, PLAYER | VEHICLE | NPC_CAR | PEDESTRIAN | DEBRIS],
  [PLAYER, WORLD | VEHICLE | NPC_CAR | PEDESTRIAN | SENSOR],
  [VEHICLE, WORLD | PLAYER | VEHICLE | NPC_CAR | PEDESTRIAN | SENSOR | DEBRIS],
  [NPC_CAR, WORLD | PLAYER | VEHICLE | NPC_CAR | PEDESTRIAN | SENSOR | DEBRIS],
  [PEDESTRIAN, WORLD | PLAYER | VEHICLE | NPC_CAR | PEDESTRIAN | SENSOR],
  [SENSOR, PLAYER | VEHICLE | NPC_CAR | PEDESTRIAN],
  [DEBRIS, WORLD | VEHICLE | NPC_CAR | DEBRIS],
];

// 各組的 filter（低 16 位）
export const FILTER = Object.freeze(Object.fromEntries(MATRIX.map(([g, f]) => [g, f])));

// 組合 membership / filter → Rapier InteractionGroups（無號 32 位元數值）
export function interactionGroups(membership, filter) {
  return (((membership & ALL) << 16) | (filter & ALL)) >>> 0;
}

// 取出 membership / filter
export function membershipOf(groups) {
  return (groups >>> 16) & ALL;
}
export function filterOf(groups) {
  return groups & ALL;
}

// 某組 collider 預設要設定的 InteractionGroups（collision 與 solver 共用）
export function groupsFor(group) {
  const f = FILTER[group];
  if (f === undefined) throw new Error(`未知的碰撞群組 ${group}`);
  return interactionGroups(group, f);
}

// 常用預設值（直接給 ColliderDesc.setCollisionGroups / setSolverGroups）
export const GROUPS = Object.freeze({
  WORLD: groupsFor(WORLD),
  PLAYER: groupsFor(PLAYER),
  VEHICLE: groupsFor(VEHICLE),
  NPC_CAR: groupsFor(NPC_CAR),
  PEDESTRIAN: groupsFor(PEDESTRIAN),
  SENSOR: groupsFor(SENSOR),
  DEBRIS: groupsFor(DEBRIS),
});

// 查詢（castRay / castShape / intersections）用：只命中 mask 內的組
// 查詢方 membership 設為 ALL，確保對方 filter 只要非 0 都會通過
export function queryGroups(mask) {
  return interactionGroups(ALL, mask);
}

// 兩個 InteractionGroups 是否互動（與 Rapier 規則相同，供測試 / 除錯）
export function canInteract(a, b) {
  return (membershipOf(a) & filterOf(b)) !== 0 && (membershipOf(b) & filterOf(a)) !== 0;
}
