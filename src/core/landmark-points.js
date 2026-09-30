// 地標點（契約 §17）：public/models/manifest.json 的地標清單 → 任務 / 打卡 / 大地圖共用的世界座標點
// 純函式、不 import three：投影函式由呼叫端注入（整合層可傳 landmarks/index.js 的 projectLatLon）；
//   未注入時用 projectLatLonPure（與 projectLatLon 同一公式，原點與係數取 src/data/osm-city.json 的 o）
// 輸出：[{ id, slug, name, x, z, radius }]；slug = file 去 .glb；radius = 25 m，footprint 為 false 者 15 m
// 不合法的筆（缺 file / 非 .glb / 錨點非有限數 / 投影結果非有限數）略過；slug 重複時保留第一筆
import osm from '../data/osm-city.json';

export const LANDMARK_RADIUS = 25;
export const LANDMARK_RADIUS_SMALL = 15; // footprint false（無 OSM 輪廓的小型物件）

// 與 landmarks/index.js 的 projectLatLon 相同：x 東、z 南（公尺）
export function projectLatLonPure(lat, lon) {
  return { x: (lon - osm.o.lon) * osm.o.kx, z: -(lat - osm.o.lat) * osm.o.kz };
}

const GLB_RE = /\.glb$/i;

// file 檔名 → slug；非 .glb 或含路徑 → null
export function landmarkSlug(file) {
  if (typeof file !== 'string' || file.includes('/') || !GLB_RE.test(file)) return null;
  const slug = file.replace(GLB_RE, '');
  return slug || null;
}

export function landmarkPoints(manifestList, project = projectLatLonPure) {
  const out = [];
  if (!Array.isArray(manifestList)) return out;
  const proj = typeof project === 'function' ? project : projectLatLonPure;
  const seen = new Set();
  for (const e of manifestList) {
    if (!e || typeof e !== 'object') continue;
    const slug = landmarkSlug(e.file);
    if (!slug || seen.has(slug)) continue;
    if (!Number.isFinite(e.anchorLat) || !Number.isFinite(e.anchorLon)) continue;
    const p = proj(e.anchorLat, e.anchorLon);
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
    seen.add(slug);
    out.push({
      id: e.id !== undefined && e.id !== null && e.id !== '' ? e.id : slug,
      slug,
      name: typeof e.name === 'string' && e.name ? e.name : slug,
      x: p.x,
      z: p.z,
      radius: e.footprint === false ? LANDMARK_RADIUS_SMALL : LANDMARK_RADIUS,
    });
  }
  return out;
}
