// 建築：依 OSM 輪廓多邊形擠出（側牆 + 頂面三角化），依材質分桶合併成少數幾個幾何以壓低 draw call。
// 外牆為中性的程序窗格貼圖（依建築類型分桶、幾組低彩度顏色），夜晚以 emissiveMap 讓部分窗戶亮起。
// 不為任何建築杜撰特色造型；具名建築只在屋頂上方加一塊中性的名稱牌。
// 地標實景外觀由 src/landmarks/ 依 manifest 載入的 glb 提供：footprint 為 true 的 id 不走通用擠出與名稱牌，碰撞仍用 OSM 輪廓。
// 底部高度一律取 terrain.buildingBase(id)（唯一高度場的建築平台）；牆面再往下延伸 WALL_SKIRT 埋進地面，屋頂 / 名稱牌相對底部計算。
// 外牆依建築類型與固定亂數分成帷幕玻璃（glass_blue / glass_dark）、石材（stone_cream / stone_granite，住宅與低層）、混凝土（施工中 / 頂蓋），
//   每組一個 draw call；屋頂合併成一組混凝土。先用 canvas 窗格貼圖，再由 street.js applyTile 換成 public/art/tiles/ 可平鋪貼圖（失敗保留 canvas）：
//   玻璃 = 一開間 × 一層一張、窗光 emissiveMap 保留 canvas；石材 = uv1（公尺）平鋪，canvas 窗格改在 shader 疊乘成白天窗洞、emissiveMap 照舊。
// 末尾接上 facade.js 的樓宇細節（女兒牆、退台、騎樓、雨棚、陽台）；有屋頂退台者主體降 tierH，總高維持 OSM 高度（colliders 不變）。
// 紅橋 glb 載入成功時移除 qiuhonggu.js 的程序化紅橋網格（main.js 先建 qiuhonggu、後載地標，只能在這裡銜接）。
import * as THREE from 'three';
import { buildings, getTerrain, surfaceRoads } from './citymodel.js';
import { triangulate } from './geom.js';
import { makeCanvas, mulberry32, buildTextAtlas, fitText } from './utils.js';
import { registerNight } from './daynight.js';
import { buildFacadeDetails } from './facade.js';
import { applyTile } from './street.js';
import { RED_BRIDGE_LANDMARK_ID, dropProceduralRedBridge } from './qiuhonggu.js';

const FACADE_SEED = 20260930; // 樓宇細節固定種子
const LOW_RISE_H = 18; // 低層（約 5 層以下，推測門檻）：商業 / 一般建築改用石材外牆
const GLASS_BLUE_P = 0.6; // 帷幕玻璃中藍灰玻璃的比例（推測；reference §5 七期商辦藍灰 / 深色玻璃並存）
const STONE_CREAM_P = 0.6; // 石材中米色石材的比例（推測；reference §4「米色石材豪宅」為主）
const ROOF_TILE = 'concrete';

// 材質分桶：floor 為每層高（與 tools/build-city.mjs 的高度規則一致）、bay 為開間寬
const BUCKETS = {
  residential: {
    floor: 3.3, bay: 3.4, windows: 'residential',
    colors: ['#d9d4ca', '#cfc8bc', '#c4bfb6', '#e2ded6', '#b9b5ae', '#cbc6bf'],
  },
  office: {
    floor: 3.3, bay: 3.6, windows: 'office',
    colors: ['#a9b0b6', '#9ea6ad', '#b7bcc0', '#8f989f', '#c2c5c7'],
  },
  commercial: {
    floor: 4.5, bay: 4.2, windows: 'commercial',
    colors: ['#c9c6c0', '#bdbab4', '#d3d0ca', '#aeb0b1', '#b8b3aa'],
  },
  generic: {
    floor: 3.3, bay: 3.6, windows: 'generic',
    colors: ['#cdc8bf', '#bfbab2', '#b3b0aa', '#d6d2cb', '#c2beb8'],
  },
  plain: {
    floor: 3.3, bay: 4, windows: null,
    colors: ['#a7a59f', '#9b9993', '#b1aea7'],
  },
};

// 外牆材質組：tile = 可平鋪貼圖、windows = canvas 窗格樣式（夜間窗光；石材白天窗洞）、glass = 玻璃（貼圖以開間 / 層為單位）
const SKINS = {
  glass_blue: { tile: 'glass_blue', windows: 'office', glass: true },
  glass_dark: { tile: 'glass_dark', windows: 'office', glass: true },
  stone_cream: { tile: 'stone_cream', windows: 'residential', glass: false },
  stone_granite: { tile: 'stone_granite', windows: 'residential', glass: false },
  concrete: { tile: 'concrete', windows: null, glass: false },
};

// 依類型分桶 + 高度 + 固定亂數選外牆：辦公 = 玻璃；住宅 = 石材；商業 / 一般 = 低層石材、其餘玻璃；施工中 / 頂蓋 = 混凝土
function skinOf(key, height, rng) {
  if (key === 'plain') return 'concrete';
  const glass = key === 'office' || (key !== 'residential' && height >= LOW_RISE_H);
  if (glass) return rng() < GLASS_BLUE_P ? 'glass_blue' : 'glass_dark';
  return rng() < STONE_CREAM_P ? 'stone_cream' : 'stone_granite';
}

function bucketOf(type) {
  switch (type) {
    case 'apartments':
    case 'residential':
    case 'house':
    case 'hotel':
    case 'dormitory':
      return 'residential';
    case 'office':
    case 'government':
      return 'office';
    case 'retail':
    case 'commercial':
    case 'public':
    case 'supermarket':
      return 'commercial';
    case 'construction':
    case 'roof':
      return 'plain';
    default:
      return 'generic';
  }
}

// 窗格貼圖：一張 = 8 開間 × 8 層；左上角留一塊純牆色給無窗牆面取樣
function makeWindowTextures(style, anisotropy, seed) {
  const S = 256;
  const cell = S / 8;
  const wall = makeCanvas(S, S);
  const wctx = wall.getContext('2d');
  wctx.fillStyle = '#ffffff';
  wctx.fillRect(0, 0, S, S);
  const lit = makeCanvas(S, S);
  const lctx = lit.getContext('2d');
  lctx.fillStyle = '#000000';
  lctx.fillRect(0, 0, S, S);
  const rng = mulberry32(seed);
  const warm = ['#ffd9a0', '#ffe8c0', '#fff2d8', '#ffc98a'];
  // 各類型的窗洞比例（相對一格）：[左右留白, 上留白, 下留白]
  const inset = {
    residential: [7, 7, 9],
    office: [3, 6, 6],
    commercial: [4, 9, 7],
    generic: [6, 7, 8],
  }[style];
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      // 保留 (0, 7) 這一格（畫布左下角 = UV 原點附近）為純牆
      if (i === 0 && j === 7) continue;
      const x = i * cell + inset[0];
      const y = j * cell + inset[1];
      const w = cell - inset[0] * 2;
      const h = cell - inset[1] - inset[2];
      wctx.fillStyle = '#5f6b77';
      wctx.fillRect(x, y, w, h);
      wctx.fillStyle = '#7b8792';
      wctx.fillRect(x, y, w, 2);
      if (rng() < 0.4) {
        lctx.fillStyle = warm[Math.floor(rng() * warm.length)];
        lctx.fillRect(x, y, w, h);
      }
    }
  }
  const toTex = (c) => {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = anisotropy;
    return t;
  };
  return { map: toTex(wall), emissiveMap: toTex(lit) };
}

// 純牆色取樣點（貼圖保留的純牆格）
const SOLID_UV = [0.06, 0.06];
// 牆面往底部以下延伸的裙邊（m）：坡地邊緣的平台過渡帶不露縫
export const WALL_SKIRT = 0.6;
const SKIRT_SAMPLE = 0.5; // 沿邊取地面高度的間距（m）
const SKIRT_EMBED = 0.1; // 邊下地面比 base − WALL_SKIRT 還低時，牆底再埋入此深度（m）

// 每條邊的牆底高度：min(base − WALL_SKIRT, 沿邊（每 SKIRT_SAMPLE）地面最低點 − SKIRT_EMBED)
// 例：老虎城輪廓與下沉廣場共邊，該邊牆面直接落到廣場底（B1 立面），其他邊維持 0.6 m 裙邊
export function wallBottoms(poly, base, heightAt) {
  const n = poly.length / 2;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = poly[i * 2];
    const az = poly[i * 2 + 1];
    const bx = poly[j * 2];
    const bz = poly[j * 2 + 1];
    const m = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / SKIRT_SAMPLE));
    let lo = Infinity;
    for (let k = 0; k <= m; k++) lo = Math.min(lo, heightAt(ax + ((bx - ax) * k) / m, az + ((bz - az) * k) / m));
    out[i] = Math.min(base - WALL_SKIRT, lo - SKIRT_EMBED);
  }
  return out;
}

// 合併幾何寫入器（非索引三角形）
// uv = 窗格貼圖座標（一單位 = 8 開間 × 8 層）；uv1 = 公尺（石材 / 混凝土平鋪用）
class MeshWriter {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.uv1 = [];
    this.col = [];
  }

  vert(x, y, z, nx, ny, nz, u, v, c, u1 = 0, v1 = 0) {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, v);
    this.uv1.push(u1, v1);
    this.col.push(c.r, c.g, c.b);
  }

  get empty() {
    return this.pos.length === 0;
  }

  toGeometry() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    geo.setAttribute('uv1', new THREE.Float32BufferAttribute(this.uv1, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }
}

// 擠出一棟建築：側牆（每條邊一個面，UV 以公尺計讓窗格連續）→ writer；頂面（耳切三角化）→ roofWriter
// 輪廓為北方朝上逆時針 → (x, z) 平面外法線 = (-ez, ex)，三角形 (a, b, b頂) 朝外
// base = 底部高度；牆底 = wallBottoms（至少埋 WALL_SKIRT），屋頂 = base + h（主體高；窗格 v 仍由 base 起算，裙邊在地面下不影響開窗）
// uv1 = (沿周長公尺, 高度公尺)，頂面 uv = (x, −z) 公尺
function extrude(writer, roofWriter, b, h, base, bottoms, bucket, wallColor, roofColor, uOff, vOff) {
  const p = b.poly;
  const n = p.length / 2;
  const yt = base + h;
  const texU = bucket.bay * 8;
  const texV = bucket.floor * 8;
  const windows = !!bucket.windows;
  let run = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = p[i * 2];
    const az = p[i * 2 + 1];
    const bx = p[j * 2];
    const bz = p[j * 2 + 1];
    const ex = bx - ax;
    const ez = bz - az;
    const L = Math.hypot(ex, ez);
    if (L < 1e-3) continue;
    const nx = -ez / L;
    const nz = ex / L;
    const yb = bottoms[i];
    let u0;
    let u1;
    let v0;
    let v1;
    if (windows) {
      // 開間對齊：每面牆從整數開間起算，避免窗戶被牆角切半
      u0 = uOff + Math.round(run / bucket.bay) / 8;
      u1 = u0 + L / texU;
      v0 = vOff - (base - yb) / texV;
      v1 = vOff + h / texV;
    } else {
      u0 = u1 = SOLID_UV[0];
      v0 = v1 = SOLID_UV[1];
    }
    const m0 = run;
    const m1 = run + L;
    run += L;
    writer.vert(ax, yb, az, nx, 0, nz, u0, v0, wallColor, m0, yb);
    writer.vert(bx, yb, bz, nx, 0, nz, u1, v0, wallColor, m1, yb);
    writer.vert(bx, yt, bz, nx, 0, nz, u1, v1, wallColor, m1, yt);
    writer.vert(ax, yb, az, nx, 0, nz, u0, v0, wallColor, m0, yb);
    writer.vert(bx, yt, bz, nx, 0, nz, u1, v1, wallColor, m1, yt);
    writer.vert(ax, yt, az, nx, 0, nz, u0, v1, wallColor, m0, yt);
  }
  const tris = triangulate(p);
  for (let k = 0; k < tris.length; k += 3) {
    let i0 = tris[k];
    let i1 = tris[k + 1];
    let i2 = tris[k + 2];
    // 確保頂面朝上（(x, z) 平面上為順時針）
    const cr = (p[i1 * 2] - p[i0 * 2]) * (p[i2 * 2 + 1] - p[i0 * 2 + 1]) - (p[i1 * 2 + 1] - p[i0 * 2 + 1]) * (p[i2 * 2] - p[i0 * 2]);
    if (cr > 0) {
      const t = i1;
      i1 = i2;
      i2 = t;
    }
    for (const q of [i0, i1, i2]) roofWriter.vert(p[q * 2], yt, p[q * 2 + 1], 0, 1, 0, p[q * 2], -p[q * 2 + 1], roofColor);
  }
}

// ---------- 名稱牌（所有具名建築共用字卡圖集） ----------
const PLATE_W = 512;
const PLATE_H = 112;
const PLATE_ASPECT = PLATE_W / PLATE_H;

function drawPlate(ctx, x, y, w, h, text) {
  ctx.fillStyle = '#2d3136';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#c9ccd0';
  ctx.lineWidth = 4;
  ctx.strokeRect(x + 4, y + 4, w - 8, h - 8);
  fitText(ctx, text, x + w / 2, y + h / 2, w * 0.88, 64);
  ctx.fillStyle = '#f2f2f2';
  ctx.fillText(text, x + w / 2, y + h / 2 + 2);
}

// 名稱牌位置：沿最長邊（主立面）內縮，立在屋頂上；maxInset = 內縮上限（有屋頂退台時須留在退台量體外側）
function platePlacement(b, maxInset = Infinity) {
  const p = b.poly;
  const n = p.length / 2;
  let best = 0;
  let bestL = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const L = Math.hypot(p[j * 2] - p[i * 2], p[j * 2 + 1] - p[i * 2 + 1]);
    if (L > bestL) {
      bestL = L;
      best = i;
    }
  }
  const j = (best + 1) % n;
  const ax = p[best * 2];
  const az = p[best * 2 + 1];
  const tx = (p[j * 2] - ax) / bestL;
  const tz = (p[j * 2 + 1] - az) / bestL;
  const nx = -tz; // 外法線
  const nz = tx;
  const width = Math.max(5, Math.min(36, bestL * 0.6));
  const inset = Math.min(2, width * 0.1, maxInset);
  return {
    cx: ax + tx * bestL * 0.5 - nx * inset,
    cz: az + tz * bestL * 0.5 - nz * inset,
    tx, tz, nx, nz, width, height: width / PLATE_ASPECT,
  };
}

// list：[{ b, base, h（主體高）, maxInset }]
function buildPlates(scene, list, anisotropy) {
  const group = new THREE.Group();
  group.name = 'name-plates';
  const atlas = buildTextAtlas(list.map((e) => e.b.name), PLATE_W, PLATE_H, drawPlate, { anisotropy });
  const perAtlas = atlas.textures.map(() => ({ pos: [], uv: [] }));
  list.forEach(({ b, base, h, maxInset }, k) => {
    const cell = atlas.cells[k];
    const out = perAtlas[cell.atlas];
    const pl = platePlacement(b, maxInset);
    const y0 = base + h + 0.6;
    const y1 = y0 + pl.height;
    const hw = pl.width / 2;
    // 正面朝外（文字沿輪廓方向由左到右），背面朝內；兩面各自對應 UV，都不鏡像
    for (const side of [1, -1]) {
      const ox = pl.cx + pl.nx * 0.08 * side;
      const oz = pl.cz + pl.nz * 0.08 * side;
      const rx = pl.tx * side;
      const rz = pl.tz * side;
      const lbx = ox - rx * hw;
      const lbz = oz - rz * hw;
      const rbx = ox + rx * hw;
      const rbz = oz + rz * hw;
      out.pos.push(lbx, y0, lbz, rbx, y0, rbz, rbx, y1, rbz);
      out.pos.push(lbx, y0, lbz, rbx, y1, rbz, lbx, y1, lbz);
      out.uv.push(cell.u0, cell.v0, cell.u1, cell.v0, cell.u1, cell.v1, cell.u0, cell.v0, cell.u1, cell.v1, cell.u0, cell.v1);
    }
  });
  const meshes = perAtlas.map((d, a) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(d.pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(d.uv, 2));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: atlas.textures[a], toneMapped: false }));
    group.add(mesh);
    return mesh;
  });
  scene.add(group);
  return { group, count: list.length, meshes };
}

// 石材外牆：可平鋪貼圖成為 map 後，原 canvas 窗格貼圖改在 fragment shader 疊乘（沿用 emissiveMap 的 UV），白天仍看得到窗洞
const WINDOW_MULTIPLY = '#include <map_fragment>\n\tdiffuseColor.rgb *= texture2D( windowMap, vEmissiveMapUv ).rgb;';
function stoneWithWindows(material, tex, windowTex) {
  material.userData.windowMap = windowTex;
  material.onBeforeCompile = (shader) => {
    if (!shader.fragmentShader.includes('#include <map_fragment>')) return;
    shader.uniforms.windowMap = { value: windowTex };
    shader.fragmentShader = `uniform sampler2D windowMap;\n${shader.fragmentShader.replace('#include <map_fragment>', WINDOW_MULTIPLY)}`;
  };
  material.customProgramCacheKey = () => 'buildings-stone-windows';
  return true; // canvas 窗格貼圖改當 windowMap，不釋放
}

// 外牆材質：canvas 窗格（map + 夜間窗光 emissiveMap）→ 可平鋪貼圖；混凝土無窗
function wallMaterial(skin, anisotropy, seed) {
  if (!skin.windows) {
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.02 });
    applyTile(material, skin.tile, { uvUnit: 1, channel: 1, anisotropy });
    return material;
  }
  const tex = makeWindowTextures(skin.windows, anisotropy, seed);
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: tex.map,
    emissiveMap: tex.emissiveMap,
    emissive: 0xffffff,
    emissiveIntensity: 0,
    roughness: skin.glass ? 0.35 : 0.78,
    metalness: skin.glass ? 0.2 : 0.05,
  });
  registerNight(material, 1.3);
  if (skin.glass) {
    // 窗格 UV 一單位 = 8 開間 × 8 層 → 重複 8 × 8 = 一開間 × 一層一張（ASSETS.md：一張 = 一層樓）；窗光 emissiveMap 照舊用 canvas
    applyTile(material, skin.tile, { repeat: [8, 8], anisotropy });
  } else {
    applyTile(material, skin.tile, { uvUnit: 1, channel: 1, anisotropy, onApply: stoneWithWindows });
  }
  return material;
}

// landmarks：src/landmarks/index.js 的 loadLandmarkModels() 結果（Map<id, { entry, object }>；OSM 建築為數字 id）
// 回傳 { meshes, colliders: [{ id, poly, base, h, name }], plates, overridden: [id], landmarkObjects, facade }
// colliders：base = 底部高度（terrain.buildingBase）、h = 自底部起算的 OSM 高度（牆頂 / 退台頂 = base + h）
export function buildBuildings(scene, { anisotropy = 4, landmarks = new Map() } = {}) {
  const terrain = getTerrain();
  const replaced = new Map([...landmarks].filter(([, lm]) => lm.entry.footprint === true));
  // 樓宇細節先算：退台建築的主體高度（bodies）決定下方擠出高度
  const facade = buildFacadeDetails(buildings, {
    terrain, seed: FACADE_SEED, anisotropy, landmarks: replaced, roads: surfaceRoads,
  });
  const writers = {};
  for (const key of Object.keys(SKINS)) writers[key] = new MeshWriter();
  const roofWriter = new MeshWriter();
  const colliders = [];
  const overridden = [];
  const plateList = [];
  const wall = new THREE.Color();
  const roof = new THREE.Color();

  for (const b of buildings) {
    const base = terrain.buildingBase(b.id);
    const lm = replaced.get(b.id);
    if (lm) {
      const h = Number.isFinite(lm.entry.height) && lm.entry.height > 0 ? lm.entry.height : b.height;
      colliders.push({ id: b.id, poly: b.poly, base, h, name: b.name || lm.entry.name || b.type });
      overridden.push(b.id);
      continue;
    }
    const key = bucketOf(b.type);
    const bucket = BUCKETS[key];
    const rng = mulberry32(b.id);
    wall.set(bucket.colors[Math.floor(rng() * bucket.colors.length) % bucket.colors.length]);
    roof.copy(wall).multiplyScalar(0.78);
    const uOff = Math.floor(rng() * 8) / 8;
    const vOff = Math.floor(rng() * 8) / 8;
    const body = facade.bodies.get(b.id);
    const h = body ? body.height : b.height;
    extrude(writers[skinOf(key, b.height, rng)], roofWriter, b, h, base, wallBottoms(b.poly, base, terrain.heightAt), bucket, wall, roof, uOff, vOff);
    colliders.push({ id: b.id, poly: b.poly, base, h: b.height, name: b.name || b.type });
    if (b.name) plateList.push({ b, base, h, maxInset: body ? Math.max(0.3, body.inset - 0.3) : Infinity });
  }

  const meshes = [];
  let seed = 777;
  for (const [key, skin] of Object.entries(SKINS)) {
    const w = writers[key];
    if (w.empty) continue;
    const mesh = new THREE.Mesh(w.toGeometry(), wallMaterial(skin, anisotropy, seed++));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `buildings-${key}`;
    scene.add(mesh);
    meshes.push(mesh);
  }
  if (!roofWriter.empty) {
    // 屋頂：頂點色（牆色 × 0.78）→ 混凝土貼圖（uv = 公尺）
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.02 });
    applyTile(material, ROOF_TILE, { uvUnit: 1, anisotropy });
    const mesh = new THREE.Mesh(roofWriter.toGeometry(), material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'buildings-roofs';
    scene.add(mesh);
    meshes.push(mesh);
  }

  // 地標模型（footprint 為 false 的模型與通用擠出並存）
  const landmarkObjects = [];
  for (const { object } of landmarks.values()) {
    scene.add(object);
    landmarkObjects.push(object);
  }
  // 紅橋 glb 已載入：程序化紅橋甲板 / 側板 / 柱墩讓位（walkables 碰撞資料不動）
  const qiuhonggu = scene.getObjectByName('qiuhonggu');
  if (landmarks.has(RED_BRIDGE_LANDMARK_ID) && qiuhonggu) dropProceduralRedBridge(qiuhonggu);

  scene.add(facade.group);
  const plates = buildPlates(scene, plateList, anisotropy);
  return { meshes, colliders, plates, overridden, landmarkObjects, facade };
}
