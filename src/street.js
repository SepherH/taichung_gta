// 街道細節產生器（去方塊感）：疊加在 world.js 的平面路面 ribbon 與標線之上，
//   路緣石立面、人行道分區（車道側設施帶 + 樹穴格、步行帶）、路口連續柏油鋪面、
//   斑馬線 / 停止線 / 機車停等區、少量實例化街具（號誌桿、機車停車格、垃圾桶、消防栓）。
// 只新增物件、不取代原本路面；所有高度一律取自注入的 terrain.heightAt（不寫死 0），
// 秋紅谷盆地 / 湖內（basins 多邊形或地形下凹處）不放人行道與街具。
// 公車站牌：osm-city.json 沒有 highway=bus_stop 資料（reference §4 的 4 個站牌座標未轉進資料檔），依規格不做。
// 全部在建立期產生、無每幀運算；同類物件合併成單一幾何或 InstancedMesh，draw call 數固定、不隨路網大小增加。
// 鋪面貼圖：先用 canvas 貼圖建立，再非同步換成 public/art/tiles/ 的可平鋪貼圖（applyTile；本檔同時供 world / buildings 共用），
//   載入失敗時保留 canvas 貼圖、不報錯。步行帶 = sidewalk_gray、設施帶 = sidewalk_redbrick（reference §4「灰色大方磚鋪面，局部紅磚色帶」）、路口鋪面 = asphalt。
import * as THREE from 'three';
import { SpatialGrid, closestOnSegment, closestOnPolygon, pointInPolygon, polygonBBox, samplePolyline } from './geom.js';
import { makeCanvas, mulberry32 } from './utils.js';

// 測試 / 除錯用開關（false 時回傳空群組）
export const ENABLE_STREET = true;

// 會畫中線的主要道路（與 citymodel.js 的 MAJOR_TYPES 一致；citymodel 內含 JSON import，這裡不直接引用）
const MAJOR = new Set(['primary', 'secondary', 'tertiary']);
// 有人行道的道路類型（service 為停車場 / 社區通道，不做人行道）
const SIDEWALK_TYPES = new Set(['primary', 'secondary', 'tertiary', 'residential']);

// 圖層高度（相對地形高度）；與 world.js 對齊：車道 ribbon 0.1、world 標線 0.13
const Y_ROAD = 0.1;
const Y_JUNCTION = 0.115; // 路口連續鋪面：略高於 ribbon
const Y_MARK = 0.14; // 本檔標線：高於路口鋪面與 world 標線
const CURB_H = 0.1; // 路緣石立面高（規格 ≤ 0.1 m，純視覺）
const Y_WALK = Y_ROAD + CURB_H; // 人行道面
const Y_WALK_MARK = Y_WALK + 0.012; // 人行道上的樹穴格 / 機車格線

// 人行道橫斷面（由車道邊緣往外）：路緣石頂 → 設施帶 → 步行帶
const CURB_W = 0.15;
const STRIP_W = 1.4; // 設施帶寬（規格 1.2–1.5 m）
// 步行帶寬：reference §4 人行道寬「估 5–8 m」（推測），主要道路總寬約 5.2 m；巷道較窄（推測）
const WALK_W_MAJOR = 3.6;
const WALK_W_MINOR = 2.2;
const CHUNK = 3; // 人行道沿線檢查步長（m）
const SIDEWALK_UV = 4; // 人行道 UV 一單位（m）：與 world.js 地面鋪面同尺度，可平鋪貼圖共用同一貼圖物件
const SLAB_CELL = 0.5; // canvas 方磚格邊長（m）
const JUNCTION_UV = 8; // 路口鋪面 UV 一單位（m）：與 world.js 車道柏油同尺度
const ZONE_PAD = CURB_W + STRIP_W; // 其他道路的路面 + 設施帶範圍內不鋪本路人行道（避免轉角重疊閃爍）

// 路口標線配置（沿道路離開路口的距離，起點 = 鋪面邊界 dArm）
const ZEBRA_START = 0.5;
const ZEBRA_LEN = 3; // 斑馬線縱深
const ZEBRA_BAR = 0.45; // 條紋寬
const ZEBRA_GAP = 0.45;
const BOX_START = 4; // 機車停等區（斑馬線之後、停止線之前）
const BOX_LEN = 3;
const STOP_W = 0.4; // 停止線寬
const LINE_W = 0.15; // 框線寬
const ARM_ROOM = 9; // 路口臂至少要有這麼長才畫標線（避免短臂疊到下一個路口）

// 街具間距 / 密度（低密度；機車格、垃圾桶、消防栓的樣式與密度均為推測，reference §4 查無）
const TREE_STEP = 12; // 樹穴與 world.js 行道樹同一沿線節奏（s = 6 + 12k）
const TREE_PHASE = 6;
const PIT_SIZE = 1.2;
const BAY_STEP = 24; // 機車格候選節奏（s = 12 + 24k，錯開樹穴與路燈）
const BAY_PHASE = 12;
const BAY_LEN = 4; // 一組 4 格 × 1 m
const BAY_PROB = 0.22;
const HYDRANT_STEP = 90;
const HYDRANT_PHASE = 51;
const HYDRANT_PROB = 0.6;
const BIN_STEP = 70;
const BIN_PHASE = 40;
const BIN_PROB = 0.4;
const LAMP_STEP = 30; // world.js 路燈沿線節奏（s = 15 + 30k，立於 hw + 0.8）；只用來避讓
const LAMP_PHASE = 15;
const OCCUPY_R = 1.5; // 街具彼此最小間距
const POLE_SPACING = 6; // 號誌桿最小間距
const BASIN_DROP = -0.3; // 地形比路面低這麼多即視為下凹區（盆地 / 下沉廣場），不放街具

const COLORS = {
  curb: new THREE.Color(0xc9c7c1),
  strip: new THREE.Color(0x77706a), // 設施帶深色鋪面
  walk: new THREE.Color(0xc6c0b4), // 步行帶淺灰大方磚（reference §4）
  asphalt: new THREE.Color(0x404145),
  white: new THREE.Color(0xffffff),
};

// 與 world.js 相同的 polygonOffset 分層法
function layer(k) {
  return { polygonOffset: true, polygonOffsetFactor: -k, polygonOffsetUnits: -k * 2 };
}

// ---------- 合併幾何寫入器（facade.js 共用） ----------
// 非索引三角形；quad / tri 依期望法線自動調整繞序，呼叫端不必在意頂點順序
export class DetailWriter {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.col = [];
  }

  get empty() {
    return this.pos.length === 0;
  }

  vert(q, n, c, u, v) {
    this.pos.push(q[0], q[1], q[2]);
    this.nor.push(n[0], n[1], n[2]);
    this.uv.push(u, v);
    this.col.push(c.r, c.g, c.b);
  }

  // q* = [x, y, z]；uv = [u0, v0, u1, v1, …] 或 null（全 0）
  tri(q0, q1, q2, n, c, uv = null) {
    const ax = q1[0] - q0[0];
    const ay = q1[1] - q0[1];
    const az = q1[2] - q0[2];
    const bx = q2[0] - q0[0];
    const by = q2[1] - q0[1];
    const bz = q2[2] - q0[2];
    const d = (ay * bz - az * by) * n[0] + (az * bx - ax * bz) * n[1] + (ax * by - ay * bx) * n[2];
    if (d === 0) return;
    const u = uv || [0, 0, 0, 0, 0, 0];
    if (d > 0) {
      this.vert(q0, n, c, u[0], u[1]);
      this.vert(q1, n, c, u[2], u[3]);
      this.vert(q2, n, c, u[4], u[5]);
    } else {
      this.vert(q0, n, c, u[0], u[1]);
      this.vert(q2, n, c, u[4], u[5]);
      this.vert(q1, n, c, u[2], u[3]);
    }
  }

  quad(q0, q1, q2, q3, n, c, uv = null) {
    const u = uv || [0, 0, 0, 0, 0, 0, 0, 0];
    this.tri(q0, q1, q2, n, c, [u[0], u[1], u[2], u[3], u[4], u[5]]);
    this.tri(q0, q2, q3, n, c, [u[0], u[1], u[4], u[5], u[6], u[7]]);
  }

  toGeometry() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }
}

// 群組內 mesh 數 / 三角形數 / 頂點數（InstancedMesh 以實例數計）
export function geometryStats(group) {
  let meshes = 0;
  let triangles = 0;
  let vertices = 0;
  group.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    const g = o.geometry;
    const v = g.attributes.position.count;
    const t = g.index ? g.index.count / 3 : v / 3;
    const k = o.isInstancedMesh ? o.count : 1;
    triangles += t * k;
    vertices += v * k;
  });
  return { meshes, triangles, vertices };
}

// ---------- 空間查詢（只依注入資料，不依賴 citymodel） ----------
// 道路線段索引：路面判定與最近道路
export class RoadIndex {
  constructor(roads) {
    this.grid = new SpatialGrid(25);
    this.maxHw = 0;
    for (const r of roads) {
      this.maxHw = Math.max(this.maxHw, r.hw);
      for (let i = 0; i < r.pts.length - 1; i++) {
        const a = r.pts[i];
        const b = r.pts[i + 1];
        const seg = { road: r, ax: a.x, az: a.z, bx: b.x, bz: b.z };
        this.grid.insert(seg, Math.min(a.x, b.x) - r.hw, Math.min(a.z, b.z) - r.hw, Math.max(a.x, b.x) + r.hw, Math.max(a.z, b.z) + r.hw);
      }
    }
    this._q = [];
    this._p = { x: 0, z: 0, d2: 0, t: 0 };
  }

  // 點是否落在（except 以外）任何路面 + pad 內
  onSurface(x, z, pad = 0, except = null) {
    const R = this.maxHw + pad;
    for (const s of this.grid.query(x - R, z - R, x + R, z + R, this._q)) {
      if (s.road === except) continue;
      const lim = s.road.hw + pad;
      closestOnSegment(x, z, s.ax, s.az, s.bx, s.bz, this._p);
      if (this._p.d2 < lim * lim) return s.road;
    }
    return null;
  }

  // 最近的路面（以距路緣計，路面上為 0）；回傳 { road, dist, x, z }（x, z 為中心線最近點）或 null
  nearest(x, z, maxDist, out = {}) {
    const R = this.maxHw + maxDist;
    let best = null;
    let bestD = maxDist;
    for (const s of this.grid.query(x - R, z - R, x + R, z + R, this._q)) {
      closestOnSegment(x, z, s.ax, s.az, s.bx, s.bz, this._p);
      const d = Math.max(0, Math.sqrt(this._p.d2) - s.road.hw);
      if (d < bestD) {
        bestD = d;
        best = s.road;
        out.x = this._p.x;
        out.z = this._p.z;
      }
    }
    if (!best) return null;
    out.road = best;
    out.dist = bestD;
    return out;
  }
}

// 建築輪廓索引
export class BuildingIndex {
  constructor(buildings) {
    this.grid = new SpatialGrid(25);
    for (const b of buildings) {
      const bb = polygonBBox(b.poly);
      this.grid.insert({ b, bb }, bb.x0, bb.z0, bb.x1, bb.z1);
    }
    this._q = [];
    this._c = {};
  }

  // 點（外擴 pad）落在哪棟建築內；except 為忽略的建築
  at(x, z, pad = 0, except = null) {
    for (const it of this.grid.query(x - pad, z - pad, x + pad, z + pad, this._q)) {
      const { b, bb } = it;
      if (b === except) continue;
      if (x < bb.x0 - pad || x > bb.x1 + pad || z < bb.z0 - pad || z > bb.z1 + pad) continue;
      if (pointInPolygon(x, z, b.poly)) return b;
      if (pad > 0 && closestOnPolygon(x, z, b.poly, this._c).d2 < pad * pad) return b;
    }
    return null;
  }
}

// 下凹區判定：basins 多邊形內，或地形明顯低於路面（盆地邊坡、下沉廣場）
function makeBlocked(terrain, basins) {
  const list = basins.map((p) => ({ p, bb: polygonBBox(p) }));
  return (x, z) => {
    if (terrain.heightAt(x, z) < BASIN_DROP) return true;
    for (const { p, bb } of list) {
      if (x >= bb.x0 && x <= bb.x1 && z >= bb.z0 && z <= bb.z1 && pointInPolygon(x, z, p)) return true;
    }
    return false;
  };
}

// 街具佔位（點間距檢查）
class Occupancy {
  constructor(r) {
    this.r = r;
    this.grid = new Map();
  }

  _k(ix, iz) {
    return ix * 100003 + iz;
  }

  free(x, z, r = this.r) {
    const ix = Math.floor(x / this.r);
    const iz = Math.floor(z / this.r);
    const n = Math.ceil(r / this.r);
    for (let a = -n; a <= n; a++) {
      for (let b = -n; b <= n; b++) {
        const list = this.grid.get(this._k(ix + a, iz + b));
        if (list && list.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < r * r)) return false;
      }
    }
    return true;
  }

  add(x, z) {
    const k = this._k(Math.floor(x / this.r), Math.floor(z / this.r));
    if (!this.grid.has(k)) this.grid.set(k, []);
    this.grid.get(k).push({ x, z });
  }
}

// ---------- 可平鋪貼圖（public/art/tiles/，尺度依 docs/art/ASSETS.md「可平鋪貼圖」） ----------
// 建議重複尺度：一張貼圖 = [寬, 高] 公尺（帷幕玻璃一張 = 一層樓）
export const TILE_SIZES = {
  asphalt: [4, 4],
  sidewalk_gray: [2.4, 2.4],
  sidewalk_redbrick: [1.6, 1.6],
  grass: [3, 3],
  concrete: [3, 3],
  stone_cream: [2.4, 2.4],
  stone_granite: [1.8, 1.8],
  glass_blue: [3, 3.6],
  glass_dark: [3, 3.6],
};
// 路徑相對 Vite base（'./'）；Node 無頭測試沒有 import.meta.env 時同樣取 './'
const TILE_DIR = `${(import.meta.env && import.meta.env.BASE_URL) || './'}art/tiles/`;
const tileBases = new Map(); // 名稱 → Promise<Texture | null>（每張圖只載一次，各用途 clone 共用同一 Source）
const tileUses = new Map(); // 名稱 + 重複 + UV 通道 + anisotropy → 已設定的 clone（設定相同的用途共用同一貼圖物件）
const tileJobs = [];

function tileUse(base, name, rx, ry, channel, anisotropy) {
  const key = `${name}|${rx}|${ry}|${channel}|${anisotropy}`;
  if (!tileUses.has(key)) {
    const tex = base.clone();
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = anisotropy;
    tex.channel = channel;
    tex.repeat.set(rx, ry);
    tex.userData.tile = name;
    tex.needsUpdate = true;
    tileUses.set(key, tex);
  }
  return tileUses.get(key);
}

function loadTileBase(name) {
  if (!tileBases.has(name)) {
    tileBases.set(name, new Promise((resolve) => {
      try {
        new THREE.TextureLoader().load(`${TILE_DIR}${name}.jpg`, resolve, undefined, () => resolve(null));
      } catch {
        resolve(null); // 無 DOM 影像支援（例：無頭測試的最小 document）→ 視同載入失敗
      }
    }));
  }
  return tileBases.get(name);
}

// 材質改用可平鋪貼圖：載入成功 → material.map 換成該貼圖（RepeatWrapping、sRGB、anisotropy 沿用參數，
//   repeat = UV 一單位的公尺數 ÷ 建議尺度），再呼叫 onApply(material, tex, old)；onApply 回傳 true 表示舊貼圖另有用途、不釋放。
// 載入失敗 → 什麼都不改（保留既有 canvas 貼圖）、不報錯。uvUnit：幾何 UV 一單位 = 幾公尺（數字或 [u, v]）；channel：UV 通道（0 = uv、1 = uv1）
// repeat：直接指定貼圖重複（例：帷幕玻璃一張 = 一開間 × 一層，UV 已按開間 / 層數正規化），省略時由 uvUnit 換算
export function applyTile(material, name, { uvUnit = 1, repeat = null, anisotropy = 4, channel = 0, onApply = null } = {}) {
  const [su, sv] = TILE_SIZES[name];
  const [uu, vv] = Array.isArray(uvUnit) ? uvUnit : [uvUnit, uvUnit];
  const job = loadTileBase(name).then((base) => {
    if (!base) return;
    const [rx, ry] = repeat || [uu / su, vv / sv];
    const tex = tileUse(base, name, rx, ry, channel, anisotropy);
    const old = material.map;
    material.map = tex;
    const keep = onApply ? onApply(material, tex, old) : false;
    material.needsUpdate = true;
    if (old && !keep) old.dispose();
  }).catch(() => {}); // 套用失敗同樣保留 canvas 貼圖，不報錯
  tileJobs.push(job);
  return job;
}

// 目前所有 applyTile 載入（成功或失敗）都結束（無頭測試等待用）
export function tilesSettled() {
  return Promise.all(tileJobs);
}

// 貼圖換成可平鋪貼圖後改由貼圖本身給色：關掉頂點色（canvas 貼圖是灰階、靠頂點色著色）
export function dropVertexColors(material) {
  material.vertexColors = false;
  return false;
}

// ---------- canvas 貼圖（可平鋪貼圖載入前 / 失敗時使用） ----------
function canvasTex(canvas, anisotropy) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = anisotropy;
  return tex;
}

// 人行道方磚（灰階，一張 = SIDEWALK_UV × SIDEWALK_UV m、每格 0.5 m；顏色由頂點色決定）
function makeSlabTexture(anisotropy, rng) {
  const S = 128;
  const n = SIDEWALK_UV / SLAB_CELL;
  const cell = S / n;
  const canvas = makeCanvas(S, S);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#9a9a9a';
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const g = 222 + Math.floor(rng() * 30);
      ctx.fillStyle = `rgb(${g},${g},${g})`;
      ctx.fillRect(i * cell + 1, j * cell + 1, cell - 2, cell - 2);
    }
  }
  return canvasTex(canvas, anisotropy);
}

// 樹穴格柵（鑄鐵格柵 + 中央樹孔）
function makeGrateTexture(anisotropy) {
  const S = 64;
  const canvas = makeCanvas(S, S);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#3b3631';
  ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = '#56595c';
  for (let k = 4; k < S; k += 6) {
    ctx.fillRect(k, 2, 2, S - 4);
    ctx.fillRect(2, k, S - 4, 2);
  }
  ctx.strokeStyle = '#8d8a84';
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, S - 3, S - 3);
  ctx.fillStyle = '#4a3b2c';
  ctx.fillRect(S / 2 - 9, S / 2 - 9, 18, 18);
  return canvasTex(canvas, anisotropy);
}

// ---------- 沿線工具 ----------
const _smp = { x: 0, z: 0, dx: 1, dz: 0, seg: 0 };

// 道路在 s 處、side 側（+1 = 前進方向右側）距中心線 l 的點；回傳 [x, z]
function lateral(road, s, side, l) {
  samplePolyline(road, s, _smp);
  return [_smp.x - _smp.dz * side * l, _smp.z + _smp.dx * side * l];
}

// 每條道路上的路口位置（沿線距離 s 與鋪面半徑 r = 其他道路最大半寬 + 1）
function junctionStopsByRoad(junctions) {
  const map = new Map();
  for (const j of junctions) {
    for (const r of j.roads) {
      let hw = 0;
      for (const o of j.roads) if (o !== r) hw = Math.max(hw, o.hw);
      if (hw <= 0) continue;
      r.pts.forEach((p, idx) => {
        if (Math.abs(p.x - j.x) > 0.05 || Math.abs(p.z - j.z) > 0.05) return;
        if (!map.has(r)) map.set(r, []);
        map.get(r).push({ s: r.cum[idx], r: hw + 1 });
      });
    }
  }
  return map;
}

function nearStop(stops, s, pad = 0) {
  if (!stops) return false;
  for (const st of stops) if (Math.abs(s - st.s) < st.r + pad) return true;
  return false;
}

// ---------- 人行道 ----------
function walkWidth(road) {
  return MAJOR.has(road.type) ? WALK_W_MAJOR : WALK_W_MINOR;
}

// 單一檢查段的狀態：0 = 不鋪、1 = 只有路緣 + 設施帶、2 = 完整（含步行帶）
function chunkState(road, side, s, ctx) {
  if (nearStop(ctx.stops.get(road), s)) return 0;
  const lStrip = road.hw + CURB_W + STRIP_W;
  for (const l of [road.hw + 0.3, lStrip]) {
    const [x, z] = lateral(road, s, side, l);
    if (ctx.blocked(x, z) || ctx.roadIdx.onSurface(x, z, ZONE_PAD, road) || ctx.bldIdx.at(x, z, 0.2)) return 0;
  }
  const [x, z] = lateral(road, s, side, lStrip + walkWidth(road));
  if (ctx.blocked(x, z) || ctx.roadIdx.onSurface(x, z, ZONE_PAD, road) || ctx.bldIdx.at(x, z, 0.3)) return 1;
  return 2;
}

// 在 [sa, sb] 範圍鋪一段人行道（逐折線段切開，跟著彎道）
function emitSidewalkRun(road, side, sa, sb, state, ctx) {
  const { pts, cum, hw } = road;
  const H = ctx.terrain.heightAt;
  const ls = [hw, hw + CURB_W, hw + CURB_W + STRIP_W, hw + CURB_W + STRIP_W + walkWidth(road)];
  const outer = state === 2 ? ls[3] : ls[2];
  // 路緣石頂 + 步行帶 → walk（灰磚）；設施帶 → strip（紅磚色帶）
  const bands = [
    [ls[0], ls[1], COLORS.curb, ctx.walk],
    [ls[1], ls[2], COLORS.strip, ctx.strip],
  ];
  if (state === 2) bands.push([ls[2], ls[3], COLORS.walk, ctx.walk]);
  const up = [0, 1, 0];
  const pt = (x, z, dy) => [x, H(x, z) + dy, z];
  const uv = (qs) => qs.flatMap((q) => [q[0] / SIDEWALK_UV, -q[2] / SIDEWALK_UV]);
  for (let i = 0; i < pts.length - 1; i++) {
    const a0 = cum[i];
    const a1 = cum[i + 1];
    if (a1 <= sa || a0 >= sb || a1 - a0 < 1e-4) continue;
    const L = a1 - a0;
    const ux = (pts[i + 1].x - pts[i].x) / L;
    const uz = (pts[i + 1].z - pts[i].z) / L;
    const rx = -uz * side;
    const rz = ux * side;
    const t0 = Math.max(sa, a0) - a0;
    const t1 = Math.min(sb, a1) - a0;
    const ax = pts[i].x + ux * t0;
    const az = pts[i].z + uz * t0;
    const bx = pts[i].x + ux * t1;
    const bz = pts[i].z + uz * t1;
    for (const [l0, l1, c, w] of bands) {
      const q = [pt(ax + rx * l0, az + rz * l0, Y_WALK), pt(bx + rx * l0, bz + rz * l0, Y_WALK), pt(bx + rx * l1, bz + rz * l1, Y_WALK), pt(ax + rx * l1, az + rz * l1, Y_WALK)];
      w.quad(q[0], q[1], q[2], q[3], up, c, uv(q));
    }
    // 路緣石立面（朝車道）與外緣落差面（朝建築側）
    const curb = [pt(ax + rx * hw, az + rz * hw, Y_ROAD - 0.02), pt(bx + rx * hw, bz + rz * hw, Y_ROAD - 0.02), pt(bx + rx * hw, bz + rz * hw, Y_WALK), pt(ax + rx * hw, az + rz * hw, Y_WALK)];
    ctx.curb.quad(curb[0], curb[1], curb[2], curb[3], [-rx, 0, -rz], COLORS.curb);
    const oc = state === 2 ? COLORS.walk : COLORS.strip;
    const ed = [pt(ax + rx * outer, az + rz * outer, 0), pt(bx + rx * outer, bz + rz * outer, 0), pt(bx + rx * outer, bz + rz * outer, Y_WALK), pt(ax + rx * outer, az + rz * outer, Y_WALK)];
    ctx.curb.quad(ed[0], ed[1], ed[2], ed[3], [rx, 0, rz], oc);
  }
  // 兩端收邊面
  for (const [s, sign] of [[sa, -1], [sb, 1]]) {
    const [ix, iz] = lateral(road, s, side, hw);
    const [ox, oz] = lateral(road, s, side, outer);
    const q = [pt(ix, iz, Y_ROAD - 0.02), pt(ox, oz, 0), pt(ox, oz, Y_WALK), pt(ix, iz, Y_WALK)];
    ctx.curb.quad(q[0], q[1], q[2], q[3], [_smp.dx * sign, 0, _smp.dz * sign], COLORS.curb);
  }
}

// 每條路兩側：計算檢查段狀態 → 合併成連續段輸出；回傳 Map<road, { 1: states, -1: states }>
function buildSidewalks(roads, ctx) {
  const states = new Map();
  let length = 0;
  for (const road of roads) {
    if (!SIDEWALK_TYPES.has(road.type) || road.bridge || road.length < CHUNK) continue;
    const perSide = {};
    for (const side of [1, -1]) {
      const n = Math.ceil(road.length / CHUNK);
      const st = new Uint8Array(n);
      for (let k = 0; k < n; k++) st[k] = chunkState(road, side, Math.min(road.length, (k + 0.5) * CHUNK), ctx);
      let k = 0;
      while (k < n) {
        if (!st[k]) {
          k++;
          continue;
        }
        let e = k;
        while (e + 1 < n && st[e + 1] === st[k]) e++;
        const sa = k * CHUNK;
        const sb = Math.min(road.length, (e + 1) * CHUNK);
        emitSidewalkRun(road, side, sa, sb, st[k], ctx);
        length += sb - sa;
        k = e + 1;
      }
      perSide[side] = st;
    }
    states.set(road, perSide);
  }
  return { states, length };
}

// 沿線 [s - half, s + half] 都有人行道（至少設施帶）
function paved(states, road, side, s, half = 0) {
  const st = states.get(road)?.[side];
  if (!st) return false;
  for (const q of [s - half, s, s + half]) {
    if (q < 0 || q > road.length) return false;
    if (!st[Math.min(st.length - 1, Math.floor(q / CHUNK))]) return false;
  }
  return true;
}

// ---------- 路口 ----------
// 路口各臂：{ road, dir（+1 沿折線前進 / -1 反向）, s（路口在該路的沿線距離）, d（鋪面邊界距離） }
function junctionArms(j) {
  const arms = [];
  for (const r of j.roads) {
    let other = 0;
    for (const o of j.roads) if (o !== r) other = Math.max(other, o.hw);
    r.pts.forEach((p, idx) => {
      if (Math.abs(p.x - j.x) > 0.05 || Math.abs(p.z - j.z) > 0.05) return;
      if (idx > 0) arms.push({ road: r, dir: -1, s: r.cum[idx], d: other + 1 });
      if (idx < r.pts.length - 1) arms.push({ road: r, dir: 1, s: r.cum[idx], d: other + 1 });
    });
  }
  return arms;
}

// 臂上離路口 t 處的框架：中心點與「臂方向右側」單位向量
const _frame = { x: 0, z: 0, ux: 1, uz: 0, rx: 0, rz: 1 };
function armFrame(arm, t) {
  samplePolyline(arm.road, arm.s + arm.dir * t, _frame);
  _frame.ux = _frame.dx * arm.dir;
  _frame.uz = _frame.dz * arm.dir;
  _frame.rx = -_frame.uz;
  _frame.rz = _frame.ux;
  return _frame;
}

function armPoint(arm, t, l) {
  const f = armFrame(arm, t);
  return [f.x + f.rx * l, f.z + f.rz * l];
}

// 臂的可用長度（到道路端點或下一個路口）
function armRoom(arm, stops) {
  let room = arm.dir > 0 ? arm.road.length - arm.s : arm.s;
  for (const st of stops.get(arm.road) || []) {
    const t = (st.s - arm.s) * arm.dir;
    if (t > 1e-3) room = Math.min(room, t - st.r);
  }
  return room;
}

// 路口連續鋪面：各臂在鋪面邊界的左右路緣點依角度排序，由路口中心扇形三角化成單一多邊形
function emitJunctionPatch(j, arms, ctx) {
  const ring = [];
  for (const arm of arms) {
    const room = armRoom(arm, ctx.stops) + arm.d;
    const t = Math.max(0.5, Math.min(arm.d, room));
    const hw = arm.road.hw;
    for (const l of [hw, -hw]) {
      const [x, z] = armPoint(arm, t, l);
      ring.push({ x, z, a: Math.atan2(z - j.z, x - j.x) });
    }
  }
  if (ring.length < 4) return false;
  ring.sort((p, q) => p.a - q.a);
  const H = ctx.terrain.heightAt;
  const c = [j.x, H(j.x, j.z) + Y_JUNCTION, j.z];
  const up = [0, 1, 0];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    const pa = [p.x, H(p.x, p.z) + Y_JUNCTION, p.z];
    const qa = [q.x, H(q.x, q.z) + Y_JUNCTION, q.z];
    const k = 1 / JUNCTION_UV;
    ctx.asphalt.tri(c, pa, qa, up, COLORS.asphalt, [c[0] * k, -c[2] * k, pa[0] * k, -pa[2] * k, qa[0] * k, -qa[2] * k]);
  }
  return true;
}

// 標線矩形：臂上 [t0, t1] × 側向 [l0, l1]
function markRect(arm, t0, t1, l0, l1, ctx) {
  const H = ctx.terrain.heightAt;
  const q = [armPoint(arm, t0, l0), armPoint(arm, t1, l0), armPoint(arm, t1, l1), armPoint(arm, t0, l1)].map(([x, z]) => [x, H(x, z) + Y_MARK, z]);
  ctx.marks.quad(q[0], q[1], q[2], q[3], [0, 1, 0], COLORS.curb);
}

// 一個路口臂的標線：斑馬線 → 機車停等區 → 停止線（右側通行，進入路口的車道在臂方向左側）
function emitArmMarkings(arm, ctx, stats) {
  const r = arm.road;
  const hw = r.hw;
  const d = arm.d;
  const zc = armPoint(arm, d + ZEBRA_START + ZEBRA_LEN / 2, 0);
  if (ctx.blocked(zc[0], zc[1])) return;
  for (let l = -hw + 0.6; l + ZEBRA_BAR <= hw - 0.6 + 1e-6; l += ZEBRA_BAR + ZEBRA_GAP) {
    markRect(arm, d + ZEBRA_START, d + ZEBRA_START + ZEBRA_LEN, l, l + ZEBRA_BAR, ctx);
  }
  stats.crosswalks++;
  // 單行道且車流離開路口：沒有停止線
  if (r.oneway && arm.dir > 0) return;
  const lo = -(hw - 0.3);
  const hi = r.oneway ? hw - 0.3 : -0.3;
  const withBox = hi - lo >= 4.5;
  let stopAt = d + BOX_START;
  if (withBox) {
    const a = d + BOX_START;
    const b = a + BOX_LEN;
    markRect(arm, a, a + LINE_W, lo, hi, ctx);
    markRect(arm, b - LINE_W, b, lo, hi, ctx);
    markRect(arm, a, b, lo, lo + LINE_W, ctx);
    markRect(arm, a, b, hi - LINE_W, hi, ctx);
    stats.scooterBoxes++;
    stopAt = b + 0.3;
  }
  markRect(arm, stopAt, stopAt + STOP_W, lo, hi, ctx);
  stats.stopLines++;
}

// 主要路口（號誌化）：含主要道路，且至少兩條寬 ≥ 8 m 的道路交會（號誌位置 / 型式為推測）
function isSignalJunction(j) {
  if (!j.roads.some((r) => MAJOR.has(r.type))) return false;
  return j.roads.filter((r) => r.type !== 'service' && r.width >= 8).length >= 2;
}

// ---------- 街具幾何（本地原點 = 地形高度，底部墊高到人行道面） ----------
// 多個基本幾何各自上色後合併成一個（非索引；工作區 three 只有 build/，不依賴 addons）
function mergeTinted(parts) {
  const pos = [];
  const nor = [];
  const col = [];
  const c = new THREE.Color();
  for (const [geo, hex] of parts) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    c.set(hex);
    pos.push(...g.attributes.position.array);
    nor.push(...g.attributes.normal.array);
    for (let i = 0; i < g.attributes.position.count; i++) col.push(c.r, c.g, c.b);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

// 號誌桿：立桿 + 橫臂（本地 +X）+ 橫式號誌燈箱（顏色為推測）
function signalPoleGeometry() {
  const pole = new THREE.CylinderGeometry(0.11, 0.14, 6.2, 8);
  pole.translate(0, Y_WALK + 3.1, 0);
  const arm = new THREE.BoxGeometry(3.6, 0.12, 0.12);
  arm.translate(1.8, Y_WALK + 5.8, 0);
  const head = new THREE.BoxGeometry(1.1, 0.36, 0.3);
  head.translate(3.1, Y_WALK + 5.5, 0);
  const ped = new THREE.BoxGeometry(0.3, 0.6, 0.3);
  ped.translate(0, Y_WALK + 2.8, 0.2);
  return mergeTinted([[pole, 0x7a7f86], [arm, 0x7a7f86], [head, 0x26282b], [ped, 0x26282b]]);
}

// 機車停車格：一組 4 格白框（本地 X 沿路、Z 橫跨設施帶）
function scooterBayGeometry() {
  const w = new DetailWriter();
  const c = COLORS.white;
  const hl = BAY_LEN / 2;
  const hd = (STRIP_W - 0.2) / 2;
  const y = Y_WALK_MARK;
  const rect = (x0, x1, z0, z1) => w.quad([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], [0, 1, 0], c);
  rect(-hl, hl, -hd, -hd + 0.08);
  rect(-hl, hl, hd - 0.08, hd);
  for (let k = 0; k <= 4; k++) {
    const x = -hl + (BAY_LEN * k) / 4;
    rect(x - 0.04, x + 0.04, -hd, hd);
  }
  return w.toGeometry();
}

function hydrantGeometry() {
  const body = new THREE.CylinderGeometry(0.14, 0.16, 0.65, 8);
  body.translate(0, Y_WALK + 0.325, 0);
  const cap = new THREE.SphereGeometry(0.15, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2);
  cap.translate(0, Y_WALK + 0.65, 0);
  const nozzle = new THREE.CylinderGeometry(0.06, 0.06, 0.42, 6);
  nozzle.rotateZ(Math.PI / 2);
  nozzle.translate(0, Y_WALK + 0.45, 0);
  return mergeTinted([[body, 0xb3261e], [cap, 0xb3261e], [nozzle, 0xd7b12a]]);
}

function binGeometry() {
  const body = new THREE.CylinderGeometry(0.26, 0.23, 0.85, 10);
  body.translate(0, Y_WALK + 0.425, 0);
  const lid = new THREE.CylinderGeometry(0.28, 0.28, 0.08, 10);
  lid.translate(0, Y_WALK + 0.89, 0);
  return mergeTinted([[body, 0x4f5b54], [lid, 0x3a403c]]);
}

// 實例化：位置 y 一律 = terrain.heightAt；rot 為繞 Y 角度（本地 +X 對齊 (cos, -sin)）
function instanced(geo, material, list, terrain, name) {
  const mesh = new THREE.InstancedMesh(geo, material, Math.max(1, list.length));
  mesh.count = list.length;
  mesh.name = name;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const up = new THREE.Vector3(0, 1, 0);
  list.forEach((it, i) => {
    p.set(it.x, terrain.heightAt(it.x, it.z), it.z);
    q.setFromAxisAngle(up, it.rot);
    m.compose(p, q, one);
    mesh.setMatrixAt(i, m);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// 沿線方向角（本地 +X 對齊道路前進方向）
function rotAlong(road, s) {
  samplePolyline(road, s, _smp);
  return Math.atan2(-_smp.dz, _smp.dx);
}

// ---------- 街具擺放 ----------
function placeFurniture(roads, junctionArmsList, states, ctx, rng) {
  const occ = new Occupancy(OCCUPY_R);
  const pits = [];
  const bays = [];
  const hydrants = [];
  const bins = [];
  const poles = [];
  const stripMid = (r) => r.hw + CURB_W + STRIP_W / 2;

  // 先登記樹穴與 world.js 路燈位置（街具避讓）
  for (const road of roads) {
    if (!MAJOR.has(road.type)) continue;
    for (const side of [1, -1]) {
      for (let s = TREE_PHASE; s < road.length - 3; s += TREE_STEP) {
        if (!paved(states, road, side, s, PIT_SIZE / 2)) continue;
        const [x, z] = lateral(road, s, side, stripMid(road));
        occ.add(x, z);
        pits.push({ road, s, side, x, z });
      }
      for (let s = LAMP_PHASE; s < road.length - 3; s += LAMP_STEP) {
        const [x, z] = lateral(road, s, side, road.hw + 0.8);
        occ.add(x, z);
      }
    }
  }

  // 主要路口四角號誌桿：每臂右側路角（斑馬線旁）一支，橫臂伸向該臂車道
  const poleOcc = new Occupancy(POLE_SPACING);
  for (const { j, arms } of junctionArmsList) {
    if (!isSignalJunction(j)) continue;
    for (const arm of arms) {
      const side = arm.dir;
      for (const dt of [0.3, 3, 6]) {
        const t = arm.d + dt;
        const s = arm.s + arm.dir * t;
        if (!paved(states, arm.road, side, s)) continue;
        const [x, z] = armPoint(arm, t, arm.road.hw + CURB_W + STRIP_W / 2);
        if (!poleOcc.free(x, z) || !occ.free(x, z) || ctx.blocked(x, z)) continue;
        const f = armFrame(arm, t);
        poles.push({ x, z, rot: Math.atan2(f.rz, -f.rx) });
        poleOcc.add(x, z);
        occ.add(x, z);
        break;
      }
    }
  }

  // 沿線低密度街具：機車停車格（主要道路 + 巷道）、消防栓 / 垃圾桶（主要道路）
  for (const road of roads) {
    if (!states.has(road)) continue;
    for (const side of [1, -1]) {
      for (let s = BAY_PHASE; s < road.length - BAY_LEN; s += BAY_STEP) {
        if (rng() >= BAY_PROB || !paved(states, road, side, s, BAY_LEN / 2 + 0.3)) continue;
        const ends = [-BAY_LEN / 2, 0, BAY_LEN / 2].map((o) => lateral(road, s + o, side, stripMid(road)));
        if (!ends.every(([x, z]) => occ.free(x, z) && !ctx.blocked(x, z))) continue;
        for (const [x, z] of ends) occ.add(x, z);
        bays.push({ x: ends[1][0], z: ends[1][1], rot: rotAlong(road, s) });
      }
      if (!MAJOR.has(road.type)) continue;
      for (const [list, phase, step, prob, l] of [
        [hydrants, HYDRANT_PHASE, HYDRANT_STEP, HYDRANT_PROB, road.hw + CURB_W + 0.4],
        [bins, BIN_PHASE, BIN_STEP, BIN_PROB, stripMid(road)],
      ]) {
        for (let s = phase; s < road.length - 3; s += step) {
          if (rng() >= prob || !paved(states, road, side, s)) continue;
          const [x, z] = lateral(road, s, side, l);
          if (!occ.free(x, z) || ctx.blocked(x, z)) continue;
          occ.add(x, z);
          list.push({ x, z, rot: rotAlong(road, s) });
        }
      }
    }
  }
  return { pits, bays, hydrants, bins, poles };
}

// ---------- 對外入口 ----------
// roads / footways / junctions / buildings：citymodel 的 surfaceRoads、surfaceFootways、junctions、buildings
// terrain：{ heightAt(x, z), buildingBase(id), querySurface(...) }（本檔只用 heightAt）
// basins：盆地外框多邊形（扁平陣列）清單，例 osm.T.basins.map((b) => b.p)；框內不放人行道與街具
// 回傳 { group, stats }
export function buildStreetDetails({
  roads, footways = [], junctions = [], buildings = [], terrain, seed = 1, anisotropy = 4, basins = [], enabled = ENABLE_STREET,
} = {}) {
  const group = new THREE.Group();
  group.name = 'street-details';
  const stats = {
    enabled, sidewalkLength: 0, junctionPatches: 0, crosswalks: 0, stopLines: 0, scooterBoxes: 0,
    treePits: 0, signalPoles: 0, scooterBays: 0, hydrants: 0, bins: 0, busStops: 0,
  };
  if (!enabled) return { group, stats: { ...stats, ...geometryStats(group) } };

  const rng = mulberry32(seed >>> 0);
  const surface = roads.filter((r) => !r.under);
  const ctx = {
    terrain,
    roadIdx: new RoadIndex([...surface, ...footways.filter((f) => !f.under)]),
    bldIdx: new BuildingIndex(buildings),
    blocked: makeBlocked(terrain, basins),
    stops: junctionStopsByRoad(junctions),
    walk: new DetailWriter(),
    strip: new DetailWriter(),
    curb: new DetailWriter(),
    asphalt: new DetailWriter(),
    marks: new DetailWriter(),
    pits: new DetailWriter(),
  };

  const { states, length } = buildSidewalks(surface, ctx);
  stats.sidewalkLength = Math.round(length);

  const armsList = [];
  for (const j of junctions) {
    if (ctx.blocked(j.x, j.z)) continue;
    const arms = junctionArms(j);
    armsList.push({ j, arms });
    if (emitJunctionPatch(j, arms, ctx)) stats.junctionPatches++;
    if (!j.roads.some((r) => MAJOR.has(r.type))) continue;
    for (const arm of arms) {
      if (arm.road.type === 'service' || arm.road.width < 6) continue;
      if (armRoom(arm, ctx.stops) < arm.d + ARM_ROOM) continue;
      emitArmMarkings(arm, ctx, stats);
    }
  }

  const f = placeFurniture(surface, armsList, states, ctx, rng);
  // 樹穴格柵（平面，貼在設施帶上）
  const H = terrain.heightAt;
  for (const p of f.pits) {
    const h = PIT_SIZE / 2;
    const mid = p.road.hw + CURB_W + STRIP_W / 2;
    const q = [[-h, -h], [h, -h], [h, h], [-h, h]].map(([ds, dl]) => {
      const [x, z] = lateral(p.road, p.s + ds, p.side, mid + dl);
      return [x, H(x, z) + Y_WALK_MARK, z];
    });
    ctx.pits.quad(q[0], q[1], q[2], q[3], [0, 1, 0], COLORS.white, [0, 0, 1, 0, 1, 1, 0, 1]);
  }

  // 材質（全部共用，同類合併成一個 mesh）
  const slabTex = makeSlabTexture(anisotropy, rng);
  const walkMat = new THREE.MeshStandardMaterial({ map: slabTex, vertexColors: true, roughness: 0.95 });
  const stripMat = new THREE.MeshStandardMaterial({ map: slabTex, vertexColors: true, roughness: 0.95 });
  const curbMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
  const asphaltMat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.92, ...layer(4.5) });
  // 可平鋪貼圖；slabTex 兩個材質共用，由最後換掉的那個釋放
  let slabUsers = 2;
  const releaseSlab = (m, t, old) => {
    dropVertexColors(m);
    return old === slabTex && --slabUsers > 0;
  };
  applyTile(walkMat, 'sidewalk_gray', { uvUnit: SIDEWALK_UV, anisotropy, onApply: releaseSlab });
  applyTile(stripMat, 'sidewalk_redbrick', { uvUnit: SIDEWALK_UV, anisotropy, onApply: releaseSlab });
  applyTile(asphaltMat, 'asphalt', { uvUnit: JUNCTION_UV, anisotropy, onApply: dropVertexColors });
  const markMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.8, ...layer(7) });
  const pitMat = new THREE.MeshStandardMaterial({ map: makeGrateTexture(anisotropy), roughness: 0.85, metalness: 0.2, ...layer(1) });
  const furnMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.3 });
  const bayMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, ...layer(1) });

  const add = (writer, material, name, shadow = true) => {
    if (writer.empty) return;
    const mesh = new THREE.Mesh(writer.toGeometry(), material);
    mesh.name = name;
    mesh.receiveShadow = shadow;
    group.add(mesh);
  };
  add(ctx.walk, walkMat, 'street-sidewalk');
  add(ctx.strip, stripMat, 'street-sidewalk-strip');
  add(ctx.curb, curbMat, 'street-curb');
  add(ctx.asphalt, asphaltMat, 'street-junction');
  add(ctx.marks, markMat, 'street-markings');
  add(ctx.pits, pitMat, 'street-tree-pits');
  group.add(instanced(signalPoleGeometry(), furnMat, f.poles, terrain, 'street-signal-poles'));
  const bayMesh = instanced(scooterBayGeometry(), bayMat, f.bays, terrain, 'street-scooter-bays');
  bayMesh.castShadow = false;
  group.add(bayMesh);
  group.add(instanced(hydrantGeometry(), furnMat, f.hydrants, terrain, 'street-hydrants'));
  group.add(instanced(binGeometry(), furnMat, f.bins, terrain, 'street-bins'));

  stats.treePits = f.pits.length;
  stats.signalPoles = f.poles.length;
  stats.scooterBays = f.bays.length;
  stats.hydrants = f.hydrants.length;
  stats.bins = f.bins.length;
  return { group, stats: { ...stats, ...geometryStats(group) } };
}
