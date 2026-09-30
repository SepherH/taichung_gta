// 建築：依 OSM 輪廓多邊形擠出（側牆 + 頂面三角化），依材質分桶合併成少數幾個幾何以壓低 draw call。
// 外牆為中性的程序窗格貼圖（依建築類型分桶、幾組低彩度顏色），夜晚以 emissiveMap 讓部分窗戶亮起。
// 不為任何建築杜撰特色造型；具名建築只在屋頂上方加一塊中性的名稱牌。
// 地標實景外觀由 src/landmarks/ 依 manifest 載入的 glb 提供：footprint 為 true 的 id 不走通用擠出與名稱牌，碰撞仍用 OSM 輪廓。
import * as THREE from 'three';
import { buildings } from './citymodel.js';
import { triangulate } from './geom.js';
import { makeCanvas, mulberry32, buildTextAtlas, fitText } from './utils.js';
import { registerNight } from './daynight.js';

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

// 窗格貼圖：一張 = 8 開間 × 8 層；左上角留一塊純牆色給頂面與無窗牆面取樣
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

// 合併幾何寫入器（非索引三角形）
class MeshWriter {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.col = [];
  }

  vert(x, y, z, nx, ny, nz, u, v, c) {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, v);
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
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }
}

// 擠出一棟建築：側牆（每條邊一個面，UV 以公尺計讓窗格連續）+ 頂面（耳切三角化）
// 輪廓為北方朝上逆時針 → (x, z) 平面外法線 = (-ez, ex)，三角形 (a, b, b頂) 朝外
function extrude(writer, b, bucket, wallColor, roofColor, uOff, vOff) {
  const p = b.poly;
  const n = p.length / 2;
  const h = b.height;
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
    let u0;
    let u1;
    let v0;
    let v1;
    if (windows) {
      // 開間對齊：每面牆從整數開間起算，避免窗戶被牆角切半
      u0 = uOff + Math.round(run / bucket.bay) / 8;
      u1 = u0 + L / texU;
      v0 = vOff;
      v1 = vOff + h / texV;
    } else {
      u0 = u1 = SOLID_UV[0];
      v0 = v1 = SOLID_UV[1];
    }
    run += L;
    writer.vert(ax, 0, az, nx, 0, nz, u0, v0, wallColor);
    writer.vert(bx, 0, bz, nx, 0, nz, u1, v0, wallColor);
    writer.vert(bx, h, bz, nx, 0, nz, u1, v1, wallColor);
    writer.vert(ax, 0, az, nx, 0, nz, u0, v0, wallColor);
    writer.vert(bx, h, bz, nx, 0, nz, u1, v1, wallColor);
    writer.vert(ax, h, az, nx, 0, nz, u0, v1, wallColor);
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
    for (const q of [i0, i1, i2]) writer.vert(p[q * 2], h, p[q * 2 + 1], 0, 1, 0, SOLID_UV[0], SOLID_UV[1], roofColor);
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

// 名稱牌位置：沿最長邊（主立面）內縮，立在屋頂上
function platePlacement(b) {
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
  const inset = Math.min(2, width * 0.1);
  return {
    cx: ax + tx * bestL * 0.5 - nx * inset,
    cz: az + tz * bestL * 0.5 - nz * inset,
    tx, tz, nx, nz, width, height: width / PLATE_ASPECT,
  };
}

function buildPlates(scene, list, anisotropy) {
  const group = new THREE.Group();
  group.name = 'name-plates';
  const atlas = buildTextAtlas(list.map((b) => b.name), PLATE_W, PLATE_H, drawPlate, { anisotropy });
  const perAtlas = atlas.textures.map(() => ({ pos: [], uv: [] }));
  list.forEach((b, k) => {
    const cell = atlas.cells[k];
    const out = perAtlas[cell.atlas];
    const pl = platePlacement(b);
    const y0 = b.height + 0.6;
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

// landmarks：src/landmarks/index.js 的 loadLandmarkModels() 結果（Map<wayId, { entry, object }>）
// 回傳 { meshes, colliders: [{ poly, h, name }], plates, overridden: [id], landmarkObjects }
export function buildBuildings(scene, { anisotropy = 4, landmarks = new Map() } = {}) {
  const writers = {};
  for (const key of Object.keys(BUCKETS)) writers[key] = new MeshWriter();
  const colliders = [];
  const overridden = [];
  const plateList = [];
  const wall = new THREE.Color();
  const roof = new THREE.Color();

  for (const b of buildings) {
    const lm = landmarks.get(b.id);
    if (lm && lm.entry.footprint === true) {
      const h = Number.isFinite(lm.entry.height) && lm.entry.height > 0 ? lm.entry.height : b.height;
      colliders.push({ poly: b.poly, h, name: b.name || lm.entry.name || b.type });
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
    extrude(writers[key], b, bucket, wall, roof, uOff, vOff);
    colliders.push({ poly: b.poly, h: b.height, name: b.name || b.type });
    if (b.name) plateList.push(b);
  }

  const meshes = [];
  let seed = 777;
  for (const [key, bucket] of Object.entries(BUCKETS)) {
    const w = writers[key];
    if (w.empty) continue;
    let material;
    if (bucket.windows) {
      const tex = makeWindowTextures(bucket.windows, anisotropy, seed++);
      material = new THREE.MeshStandardMaterial({
        vertexColors: true,
        map: tex.map,
        emissiveMap: tex.emissiveMap,
        emissive: 0xffffff,
        emissiveIntensity: 0,
        roughness: 0.78,
        metalness: 0.05,
      });
      registerNight(material, 1.3);
    } else {
      material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.02 });
    }
    const mesh = new THREE.Mesh(w.toGeometry(), material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `buildings-${key}`;
    scene.add(mesh);
    meshes.push(mesh);
  }

  // 地標模型（footprint 為 false 的模型與通用擠出並存）
  const landmarkObjects = [];
  for (const { object } of landmarks.values()) {
    scene.add(object);
    landmarkObjects.push(object);
  }

  const plates = buildPlates(scene, plateList, anisotropy);
  return { meshes, colliders, plates, overridden, landmarkObjects };
}
