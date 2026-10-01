// 打工委託的場景接線（I6c，docs/dev/interfaces.md §23.4 / §24）：夜市攤位排列、代客泊車亭座標與碰撞盒、道具鍵名退回、客人路邊點
// 純資料 + 純函式：頂層不 import three（只用 prop-model.js 的擺放數學），tools/test/p6-i6c.mjs 在 node 直接測；擺模型 / 建碰撞體由 main.js 做
// 道具一律以 manifest 鍵名（public/models/props/manifest.json 的 id）指定；鍵名缺模型 → 退回 fallback 鍵（攤車變體 → 原攤車）或程式幾何（泊車亭）
import { propPlacement, propWorldPoint, propColliderBox } from './prop-model.js';

// ---------- 道具鍵名退回 ----------
// has(key) → 該鍵模型是否已載入；key 有 → key；否則 fallback 有 → fallback；都沒有 → null（呼叫端走既有做法：攤車不擺 / 泊車亭程式幾何）
export function resolvePropKey(key, has, fallback = null) {
  if (key && has(key)) return key;
  if (fallback && fallback !== key && has(fallback)) return fallback;
  return null;
}

// ---------- 夜市攤位（原攤車 + 兩款變體混擺，沿路緣一字排開）----------
export const STALL_BASE_KEY = 'night_market_stall';
export const STALL_RUN_KEY = 'night_market_stall_oyster'; // 夜市跑單的接單攤（jobs.js NIGHT_MARKET_RUN.propKey）
// slot = 沿攤車本地 X（與路緣平行）的格位；0 = stallPlacement 原位（夜市外送取餐點旁，位置不變）
export const STALL_ROW = [
  { key: 'night_market_stall', slot: 0 },
  { key: 'night_market_stall_oyster', slot: 1 },
  { key: 'night_market_stall_tea', slot: -1 },
];
export const STALL_ROW_PITCH = 2.72; // 相鄰攤位中心距（m）= 碰撞盒寬 2.22（§23.1，含遮雨棚）+ 走道 0.5
export const STALL_BACK_LOCAL = [0, 0, -(0.78 + 0.6)]; // 攤主側接單點（§23.4 stallBack，攤車本地 −Z）
export const TAKEOUT_BAG_KEY = 'takeout_bag';
// 接單攤檯面上擺的外帶袋（攤車本地座標；檯面高 0.88，袋底貼檯面；counter 取餐點 [0, 0.95, 0.7] 前緣內側）
export const TAKEOUT_BAG_LOCAL = [
  [-0.5, 0.88, 0.5],
  [-0.22, 0.88, 0.52],
];

// base = stallPlacement 回傳的擺位 opts（{ x, z, faceX, faceZ }）；heightAt(x, z) 取各格地面高；has(key) 見 resolvePropKey
// 回傳 [{ key（要求的鍵）, model（實際用的鍵或 null = 不擺）, pl（{ x, y, z, yaw }，model 為 null 時仍給座標）, box（propColliderBox 或 null）}]
// 各格同一 yaw（正面朝道路）；碰撞盒一律 propColliderBox('night_market_stall', pl)（變體車架與原攤車相同）
export function stallRow(base, heightAt, has, row = STALL_ROW, pitch = STALL_ROW_PITCH) {
  const p0 = propPlacement({ ...base, y: 0 });
  const out = [];
  for (const { key, slot } of row) {
    const w = propWorldPoint([slot * pitch, 0, 0], p0);
    const pl = { x: w.x, y: heightAt(w.x, w.z), z: w.z, yaw: p0.yaw };
    const model = resolvePropKey(key, has, STALL_BASE_KEY);
    out.push({ key, model, pl, box: model ? propColliderBox(STALL_BASE_KEY, pl) : null });
  }
  return out;
}

// 夜市跑單接單攤：STALL_RUN_KEY 那一格（缺 → slot 0）；jobSpots.stall = pl、stallBack = propWorldPoint(STALL_BACK_LOCAL, pl)
export function runStallSpot(row) {
  const s = row.find((r) => r.key === STALL_RUN_KEY) || row.find((r) => r.key === STALL_BASE_KEY) || row[0];
  return s ? { stall: s.pl, stallBack: propWorldPoint(STALL_BACK_LOCAL, s.pl), entry: s } : null;
}

// ---------- 代客泊車亭（valet_stand：亭 1.3 × 1.1 m + 顧客面右手邊 +X 側立牌；外接盒 2.52 × 1.54 × 2.87）----------
export const VALET_STAND_KEY = 'valet_stand';
export const VALET_COUNTER = [-0.43, 1.05, 1.07]; // manifest counter（接單點，檯面前方顧客站位）；propInfo 缺時用此值
// 碰撞只取亭身（本地座標；外接盒 X −1.26…+1.26，亭靠 −X 端、寬 1.3 → 中心 X −0.61、右緣 +0.04；立牌在 +X 端，亭與立牌間空隙不擋）
// 深 1.1 靠後（外接盒 Z −0.77…+0.77，前方 0.44 m 為窗外檯面 / 屋簷）→ 中心 Z −0.22；高取牆 2.25 + 屋頂 0.25
export const VALET_BOOTH = { halfW: 0.65, halfD: 0.55, halfH: 1.25, offX: -0.61, offY: 1.25, offZ: -0.22 };

// 泊車亭碰撞盒（交給 physics/colliders.js addStaticBox）：只有亭身一個盒，不含立牌與兩者間的空隙
export function valetStandBoxes(pl, c = VALET_BOOTH) {
  const w = propWorldPoint([c.offX, 0, c.offZ], pl);
  return [{ x: w.x, y: pl.y + c.offY - c.halfH, z: w.z, yaw: pl.yaw, width: c.halfW * 2, depth: c.halfD * 2, height: c.halfH * 2 }];
}

// 泊車亭位置（地圖選點，見 docs/dev/interfaces.md §24.2）：
//   tiger-city：河南路三段西側車道（老虎城側、單行往北）路緣外，離出生點約 40 m；亭正面朝道路點 (44.11, 68.31)；
//     客人車停在亭前方 5 m 的路邊（順向、貼路緣），車格 = 朝富路東側（林酒店側、南向車道）路邊，直線約 218 m
export const VALET_SITES = [
  {
    id: 'tiger-city',
    stand: { x: 37.24, z: 64.27, faceX: 44.11, faceZ: 68.31 },
    car: { x: 37.5, z: 70.22, yaw: -0.53 },
    slot: { x: -111.57, z: -95.97, yaw: 2.61 },
  },
];

// sites → jobSpots.valet（§23.4：[{ id, standX, standZ, carX, carZ, carYaw, slotX, slotZ, slotYaw }]）+ 各亭擺位 pl
//   standX / standZ = 接單點（counter 的世界座標）；heightAt 取亭底高；counter 缺 → VALET_COUNTER
export function valetSpots(sites, heightAt, counter = VALET_COUNTER) {
  return sites.map((s) => {
    const pl = propPlacement({ ...s.stand, y: heightAt(s.stand.x, s.stand.z) });
    const c = propWorldPoint(counter || VALET_COUNTER, pl);
    return {
      id: s.id, standX: c.x, standZ: c.z, carX: s.car.x, carZ: s.car.z, carYaw: s.car.yaw, slotX: s.slot.x, slotZ: s.slot.z, slotYaw: s.slot.yaw, pl,
    };
  });
}

// 泊車亭程式幾何（valet_stand 缺模型時）：THREE 由呼叫端注入；亭身 / 屋頂 / 立牌三塊，尺寸對齊 VALET_BOOTH 與 manifest 外接盒
export function buildValetStandFallback(THREE) {
  const g = new THREE.Group();
  g.name = 'prop-valet_stand-fallback';
  const add = (w, h, d, color, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, roughness: 0.7 }));
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };
  const b = VALET_BOOTH;
  add(b.halfW * 2, 2.25, b.halfD * 2, '#e8e4da', b.offX, 1.125, b.offZ); // 亭身
  add(b.halfW * 2 + 0.1, 0.25, b.halfD * 2 + 0.44, '#2b4a7a', b.offX + 0.05, 2.375, b.offZ + 0.22); // 屋頂（往前 / 立牌側伸成屋簷，不超出外接盒）
  add(0.08, 1.2, 0.08, '#555555', 1.0, 0.6, 0.3); // 立牌桿
  add(0.5, 0.7, 0.05, '#1f6fd1', 1.0, 1.45, 0.3); // 立牌面
  return g;
}

// ---------- 夜市跑單客人點：jobSpots.sidewalkNear(x, z, rng, minM, maxM) → { x, z } | null ----------
// 隨機方向 / 距離取樣 → 最近的地面車道中心線點 → 往取樣點那側推到路緣外 curbGap（人行道）；
// 合格 = 與 (x, z) 距離在 [minM, maxM]、不在車道上、不在建築內、在地圖範圍內；tries 次都不合格 → null（jobs.js 會再要）
export const SIDEWALK_CURB_GAP = 1.5;
export function createSidewalkNear({ nearestRoadPoint, onRoadSurface, buildingAt, inBounds = null, curbGap = SIDEWALK_CURB_GAP, tries = 6 }) {
  return function sidewalkNear(x, z, rng = Math.random, minM = 40, maxM = 160) {
    for (let t = 0; t < tries; t++) {
      const a = rng() * Math.PI * 2;
      const r = minM + rng() * (maxM - minM);
      const sx = x + Math.sin(a) * r;
      const sz = z + Math.cos(a) * r;
      const road = nearestRoadPoint(sx, sz);
      if (!road) continue;
      const len = Math.hypot(road.dx, road.dz) || 1;
      const nx = -road.dz / len;
      const nz = road.dx / len;
      const side = (sx - road.x) * nx + (sz - road.z) * nz < 0 ? -1 : 1;
      const off = road.hw + curbGap;
      const px = road.x + nx * off * side;
      const pz = road.z + nz * off * side;
      const d = Math.hypot(px - x, pz - z);
      if (d < minM || d > maxM) continue;
      if (onRoadSurface(px, pz, 0.3, false) || buildingAt(px, pz, 0.5)) continue;
      if (inBounds && !inBounds(px, pz, 5)) continue;
      return { x: px, z: pz };
    }
    return null;
  };
}
