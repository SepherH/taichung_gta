// 道具模型：依 public/models/props/manifest.json（美術線交付）載入道具 glb（目前：夜市攤車）；缺檔時回傳空表，呼叫端不擺或退回其他表現。
//
// manifest 格式：{ convention, props: [ { id, name, file（相對 manifest 目錄）, width, depth, height,
//   counter [x, y, z]（取餐點，glTF 座標，可省略）, triangles, bytes, notes } ] }
// glb 契約：原點 = 地面、外接盒中心正下方，+Y 上、正面（顧客面）朝 +Z、公尺；節點 body（本體）+ sign（招牌）；
//   材質 bulb 帶 emission、招牌材質帶微弱 emission（夜間發光由呼叫端以 propEmissiveMaterials 登記 daynight）
// 畫質：各級都載入同一個 glb（攤車 2314 tris / 116 KB，在 low 預算內），不做材質降級；
//   castShadow / receiveShadow 一律開，low 由 applyRendererQuality 關掉 renderer.shadowMap（與車輛相同）
// 本檔頂層不 import three（GLTFLoader 於載入時動態 import）：propPlacement / placeProp / propWorldPoint / parsePropManifest / propColliderBox 可在 node 無頭測試
const BASE_URL = import.meta.env?.BASE_URL ?? './';
export const DEFAULT_PROP_MANIFEST = `${BASE_URL}models/props/manifest.json`;

// 夜間發光的材質名稱（另外 emissive 非黑者亦算，見 propEmissiveMaterials）
export const PROP_EMISSIVE_MATERIALS = ['bulb', 'sign'];
const REQUIRED_NODES = ['body', 'sign'];
const REQUIRED = ['width', 'depth', 'height'];

const templates = new Map(); // id → { entry, scene, materials: Set<Material> }
const entries = new Map(); // id → manifest 條目（manifest 解析成功即登記，不論 glb 是否載入成功）
const loads = new Map(); // manifest URL → Promise<Map>

async function fetchJson(fetchImpl, url) {
  try {
    const res = await fetchImpl(url, { cache: 'no-cache' });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function validEntry(e) {
  return (
    e && typeof e.id === 'string' && e.id && typeof e.file === 'string' && e.file &&
    REQUIRED.every((k) => Number.isFinite(e[k]) && e[k] > 0) &&
    (e.counter === undefined || (Array.isArray(e.counter) && e.counter.length === 3 && e.counter.every(Number.isFinite)))
  );
}

// manifest JSON → 合格條目陣列（不合格的略過並警告；格式不對回 []）
export function parsePropManifest(data) {
  const list = data && Array.isArray(data.props) ? data.props : [];
  return list.filter((e) => {
    if (validEntry(e)) return true;
    console.warn('[prop-model] manifest 項目欄位不完整，略過：', e && (e.id || e.file));
    return false;
  });
}

// 載入全部道具模型（同一個 manifest URL 重複呼叫共用同一次載入）；回傳 Map<id, entry>（只含 glb 載入成功者；無 manifest → 空 Map，不報錯）
// opts.fetch：可替換 fetch（無頭測試用）
export function loadPropModels(manifestUrl = DEFAULT_PROP_MANIFEST, opts = {}) {
  if (!loads.has(manifestUrl)) loads.set(manifestUrl, doLoad(manifestUrl, opts.fetch || globalThis.fetch.bind(globalThis)));
  return loads.get(manifestUrl);
}

async function doLoad(manifestUrl, fetchImpl) {
  const out = new Map();
  const list = parsePropManifest(await fetchJson(fetchImpl, manifestUrl));
  if (!list.length) return out;
  for (const e of list) entries.set(e.id, e);
  let loader;
  try {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    loader = new GLTFLoader();
  } catch (err) {
    console.warn('[prop-model] GLTFLoader 無法載入，略過道具模型：', err && err.message ? err.message : err);
    return out;
  }
  const dir = manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1);
  await Promise.all(
    list.map(async (e) => {
      try {
        const res = await fetchImpl(`${dir}${e.file}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const gltf = await loader.parseAsync(await res.arrayBuffer(), dir);
        const missing = REQUIRED_NODES.filter((n) => !gltf.scene.getObjectByName(n));
        if (missing.length) throw new Error(`缺節點 ${missing.join(' / ')}`);
        const materials = new Set();
        gltf.scene.traverse((o) => {
          if (o.isMesh) for (const m of [].concat(o.material)) if (m) materials.add(m);
        });
        templates.set(e.id, { entry: e, scene: gltf.scene, materials });
        out.set(e.id, e);
      } catch (err) {
        console.warn(`[prop-model] ${e.id}（${e.file}）載入失敗，略過：`, err && err.message ? err.message : err);
      }
    }),
  );
  return out;
}

// manifest 條目（未知 id → null）；glb 載入失敗時仍可查尺寸 / counter
export function propInfo(id) {
  return entries.get(id) || null;
}

// 碰撞盒（docs/dev/interfaces.md §23.1，攤車本地座標、公尺）：半尺寸 halfW（本地 X）/ halfD（本地 Z）/ halfH，
//   off* = 盒中心相對 glb 原點（底面中心）的偏移；攤車半寬 1.11 = 2.1 / 2 + 遮雨棚每側外伸 0.06（盒寬與棚同寬 2.22）
export const PROP_COLLIDERS = {
  night_market_stall: { halfW: 1.11, halfD: 0.78, halfH: 1.52, offX: 0, offY: 1.52, offZ: 0 },
};

// placement（placeProp / propPlacement 回傳 { x, y, z, yaw }）→ physics/colliders.js addStaticBox 參數 { x, y, z, yaw, width, depth, height }
//   （y = 盒底面；offX / offZ 依 yaw 轉到世界）；未登記於 PROP_COLLIDERS → 退回 manifest 外接盒（中心在原點正上方）；兩者皆無 → null
export function propColliderBox(id, placement) {
  const p = placement || {};
  const x = Number(p.x) || 0;
  const y = Number(p.y) || 0;
  const z = Number(p.z) || 0;
  const yaw = Number(p.yaw) || 0;
  const c = PROP_COLLIDERS[id];
  if (c) {
    const [dx, , dz] = rotateLocal(c.offX, c.offZ, yaw);
    return { x: x + dx, y: y + c.offY - c.halfH, z: z + dz, yaw, width: c.halfW * 2, depth: c.halfD * 2, height: c.halfH * 2 };
  }
  const e = propInfo(id);
  return e ? { x, y, z, yaw, width: e.width, depth: e.depth, height: e.height } : null;
}

// 已載入模型的共用材質（所有複本共用）
export function propTemplateMaterials(id) {
  const tpl = templates.get(id);
  return tpl ? [...tpl.materials] : [];
}

function isEmissive(m) {
  if (!m) return false;
  if (PROP_EMISSIVE_MATERIALS.includes(m.name)) return true;
  const e = m.emissive;
  return !!(m.emissiveMap || (e && (e.r > 0 || e.g > 0 || e.b > 0)));
}

// 需登記夜間發光的共用材質（名稱在 PROP_EMISSIVE_MATERIALS，或 emissive 非黑 / 有 emissiveMap）；
// 呼叫端比照 vehicle.js registerModelNight：registerNight(m, m.emissiveIntensity || 1)，以 WeakSet 防重複登記
export function propEmissiveMaterials(id) {
  return propTemplateMaterials(id).filter(isEmissive);
}

// 建立道具模型；回傳 THREE.Object3D（共用幾何與材質）或 null（未載入 / 未知 id）
export function createPropModel(id) {
  const tpl = templates.get(id);
  if (!tpl) return null;
  const root = tpl.scene.clone();
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
  });
  root.userData.glb = true;
  root.userData.propId = id;
  root.name = `prop-${id}`;
  return root;
}

// ---------- 擺放（純數學，不需 three） ----------
// 讓本地 +Z 朝向 (faceX, faceZ)：繞 Y 轉 yaw 後本地 (0, 0, 1) → 世界 (sin yaw, 0, cos yaw)
// opts：{ x, z, y = 0, faceX, faceZ } 或直接給 yaw；anchor = 本地 [ax, ay, az]（例 propInfo(id).counter）→ 改為讓 anchor 的水平位置落在 (x, z)
// 回傳 { x, y, z, yaw }（根節點位置與 rotation.y）；面向點與擺放點重合時 yaw 退回 opts.yaw ?? 0
export function propPlacement({ x, z, y = 0, faceX, faceZ, yaw, anchor } = {}) {
  let a = Number.isFinite(yaw) ? yaw : 0;
  if (Number.isFinite(faceX) && Number.isFinite(faceZ)) {
    const dx = faceX - x;
    const dz = faceZ - z;
    if (dx * dx + dz * dz > 1e-12) a = Math.atan2(dx, dz);
  }
  let px = x;
  let pz = z;
  if (anchor) {
    const [ox, , oz] = rotateLocal(anchor[0], anchor[2], a);
    px -= ox;
    pz -= oz;
  }
  return { x: px, y, z: pz, yaw: a };
}

// 本地水平 (lx, lz) 繞 Y 轉 yaw → 世界偏移 [dx, 0, dz]（與 THREE rotation.y 同向）
function rotateLocal(lx, lz, yaw) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [lx * c + lz * s, 0, -lx * s + lz * c];
}

// 擺放結果下，本地點 [lx, ly, lz]（glTF 座標，例 counter）的世界座標 { x, y, z }
export function propWorldPoint(local, placement) {
  const [dx, , dz] = rotateLocal(local[0], local[2], placement.yaw);
  return { x: placement.x + dx, y: placement.y + local[1], z: placement.z + dz };
}

// 套用到物件（obj.position / obj.rotation.y）；回傳 propPlacement 結果
export function placeProp(obj, opts) {
  const p = propPlacement(opts);
  obj.position.set(p.x, p.y, p.z);
  obj.rotation.y = p.yaw;
  return p;
}
