// 程序生成建築：七期豪宅塔樓 / 商辦 / 低樓層，全部合併成一個幾何（單一 draw call）
// 窗戶用重複的 CanvasTexture；夜晚以 emissiveMap 讓部分窗戶亮起
import * as THREE from 'three';
import { LANDMARKS, CITY_SEED } from './data/city.js';
import { makeCanvas, mulberry32, randRange, randPick, rectsOverlap } from './utils.js';
import { registerNight } from './daynight.js';

// 一張窗戶貼圖 = 8 開間 × 8 層
const BAY = 3.5;
const FLOOR = 3.3;
const TEX_U = BAY * 8;
const TEX_V = FLOOR * 8;

const PALETTE = {
  luxury: ['#e8e2d6', '#d9d4cb', '#c9c2b5', '#f0ece4', '#b8b2a8', '#a9adb2', '#d6cbb8'],
  office: ['#8fa7bd', '#7d93a8', '#a8bccb', '#6f8599', '#9fb3c0'],
  low: ['#d8cfc0', '#c4b8a5', '#b9b0a3', '#e0d8ca'],
  crown: ['#6c6f75', '#55585e', '#7d7a72'],
};

function makeWindowTextures(anisotropy) {
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
  const rng = mulberry32(777);
  const warm = ['#ffd9a0', '#ffe8c0', '#fff2d8', '#ffc98a'];
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      const x = i * cell + 6;
      const y = j * cell + 6;
      const w = cell - 12;
      const h = cell - 13;
      wctx.fillStyle = '#5f6d7c';
      wctx.fillRect(x, y, w, h);
      wctx.fillStyle = '#7d8b99';
      wctx.fillRect(x, y, w, 3);
      if (rng() < 0.42) {
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

// 合併幾何的寫入器
class BoxWriter {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.col = [];
    this.idx = [];
    this.count = 0;
  }

  quad(p0, p1, p2, p3, n, uvs, color) {
    const base = this.count;
    for (const p of [p0, p1, p2, p3]) this.pos.push(p[0], p[1], p[2]);
    for (let i = 0; i < 4; i++) {
      this.nor.push(n[0], n[1], n[2]);
      this.col.push(color.r, color.g, color.b);
    }
    for (const t of uvs) this.uv.push(t[0], t[1]);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    this.count += 4;
  }

  // 軸對齊方塊（不含底面）；windows=false 時整面取貼圖角落的純牆色
  box(x0, z0, x1, z1, y0, y1, color, windows, uOff = 0, vOff = 0) {
    const H = y1 - y0;
    const faceUV = (L) => {
      if (!windows) return [[0.005, 0.005], [0.005, 0.005], [0.005, 0.005], [0.005, 0.005]];
      const u0 = uOff;
      const u1 = uOff + L / TEX_U;
      const v0 = vOff;
      const v1 = vOff + H / TEX_V;
      return [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
    };
    const dx = x1 - x0;
    const dz = z1 - z0;
    // +X
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], faceUV(dz), color);
    // -X
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], faceUV(dz), color);
    // +Z
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], faceUV(dx), color);
    // -Z
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], faceUV(dx), color);
    // 頂面
    const roofUV = [[0.005, 0.005], [0.005, 0.005], [0.005, 0.005], [0.005, 0.005]];
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], roofUV, color);
  }

  toGeometry() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.setIndex(this.idx);
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }
}

// cells：world.computeCells() 的結果
// 回傳 { mesh, boxes（碰撞用）, footprints（小地圖用） }
export function buildBuildings(scene, cells, { anisotropy = 4 } = {}) {
  const rng = mulberry32(CITY_SEED);
  const writer = new BoxWriter();
  const boxes = [];
  const footprints = [];
  const color = new THREE.Color();
  const crownColor = new THREE.Color();

  const zones = LANDMARKS.map((lm) => lm.zone);

  const place = (sub) => {
    const sw = sub.x1 - sub.x0;
    const sd = sub.z1 - sub.z0;
    const gap = 4;
    const r = rng();
    let type;
    let fw;
    let fd;
    let h;
    if (r < 0.5 && sw > 22 && sd > 22) {
      type = 'luxury';
      fw = Math.min(sw - gap * 2, randRange(rng, 20, 34));
      fd = Math.min(sd - gap * 2, randRange(rng, 20, 32));
      h = Math.round(randRange(rng, 16, 38)) * FLOOR;
    } else if (r < 0.82 && sw > 18 && sd > 18) {
      type = 'office';
      fw = Math.min(sw - gap * 2, randRange(rng, 24, 44));
      fd = Math.min(sd - gap * 2, randRange(rng, 18, 34));
      h = Math.round(randRange(rng, 9, 24)) * FLOOR;
    } else {
      type = 'low';
      fw = sw - 3 * 2;
      fd = sd - 3 * 2;
      h = Math.round(randRange(rng, 3, 6)) * FLOOR;
    }
    if (fw < 8 || fd < 8) return;
    const cx = (sub.x0 + sub.x1) / 2 + (sw - fw - gap * 2) * (rng() - 0.5) * 0.8;
    const cz = (sub.z0 + sub.z1) / 2 + (sd - fd - gap * 2) * (rng() - 0.5) * 0.8;
    const x0 = cx - fw / 2;
    const x1 = cx + fw / 2;
    const z0 = cz - fd / 2;
    const z1 = cz + fd / 2;
    color.set(randPick(rng, PALETTE[type]));
    const uOff = Math.floor(rng() * 8) / 8;
    const vOff = Math.floor(rng() * 8) / 8;
    writer.box(x0, z0, x1, z1, 0, h, color, true, uOff, vOff);
    // 塔樓頂部機房
    if (type !== 'low') {
      crownColor.set(randPick(rng, PALETTE.crown));
      const k = randRange(rng, 0.45, 0.7);
      const hw = (fw * k) / 2;
      const hd = (fd * k) / 2;
      writer.box(cx - hw, cz - hd, cx + hw, cz + hd, h, h + randRange(rng, 3, 6), crownColor, false);
    }
    boxes.push({ x0, x1, z0, z1, h, name: type });
    footprints.push({ x0, x1, z0, z1, h, type });
  };

  for (const cell of cells) {
    const L = cell.lot;
    const w = L.x1 - L.x0;
    const d = L.z1 - L.z0;
    if (w < 12 || d < 12) continue;
    if (zones.some((z) => rectsOverlap(z, L))) continue;
    const nx = Math.max(1, Math.round(w / 45));
    const nz = Math.max(1, Math.round(d / 50));
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        place({
          x0: L.x0 + (w * i) / nx,
          x1: L.x0 + (w * (i + 1)) / nx,
          z0: L.z0 + (d * j) / nz,
          z1: L.z0 + (d * (j + 1)) / nz,
        });
      }
    }
  }

  const tex = makeWindowTextures(anisotropy);
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: tex.map,
    emissiveMap: tex.emissiveMap,
    emissive: 0xffffff,
    emissiveIntensity: 0,
    roughness: 0.75,
    metalness: 0.05,
  });
  registerNight(material, 1.3);
  const mesh = new THREE.Mesh(writer.toGeometry(), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'buildings';
  scene.add(mesh);
  return { mesh, boxes, footprints };
}
