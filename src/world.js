// 世界：地面鋪面、地形 patch（秋紅谷 / 老虎城下沉廣場）、公園草地、水面、OSM 道路路面 / 步道、標線、路名地面字、行道樹、路燈、公園樹木
// 全部依 src/data/osm-city.json（真實 OSM 資料）生成；高度一律取自 src/terrain.js（唯一高度場）：
// 平地照舊畫在各圖層高度，落在高度場非平坦處的面改為細分貼地（terrain.js 的 drapeTriangle / drapeRibbon）
// 末尾接上 street.js 的街道細節（路緣 / 人行道分區 / 路口鋪面 / 街具），其群組直接加入場景（與 world 群組並列）。
// 地面鋪面 / 柏油 / 草地 / 秋紅谷退台混凝土先用 canvas 貼圖，再由 street.js applyTile 換成 public/art/tiles/ 可平鋪貼圖（失敗保留 canvas）。
// 紅橋甲板：world 步道 ribbon 在源頭略過甲板上的三角形（甲板由紅橋 glb 或 qiuhonggu.js 程序網格呈現）。
import * as THREE from 'three';
import {
  BOUNDS, MAJOR_TYPES, surfaceRoads, surfaceFootways, parks, water, nodeRoads, nodeKey, nodeDegree, junctions, buildings,
  buildingAt, onRoadSurface, inWater, inBounds, junctionClearance, nearestNamedRoad, nearestNamedBuilding, namedRoadsAt,
} from './citymodel.js';
import { triangulate, pointInPolygon, polygonArea } from './geom.js';
import { getTerrain, heightAt as terrainHeightAt, buildPatchMesh, drapeTriangle, drapeRibbon, SURFACES } from './terrain.js';
import { makeCanvas, mulberry32, buildTextAtlas, fitText } from './utils.js';
import { registerNight } from './daynight.js';
import { buildStreetDetails, applyTile, dropVertexColors } from './street.js';

// 各圖層高度（拉開間距避免 z-fighting）
const Y_PARK = 0.03;
const Y_WATER = 0.05;
const Y_FOOT = 0.07;
const Y_ROAD = 0.1;
const Y_MARK = 0.13;
const Y_LABEL = 0.15;
const Y_TERRACE_LINE = 0.05; // 秋紅谷退台白色邊線（高出地形）
const TERRACE_LINE_W = 0.25; // 退台白色邊線寬（m，推測，依 reference §6.3「白色邊線的多層平台」）
const MITER_MAX = 3; // 貼地細帶轉折處斜接最長為半寬幾倍
const Y_RAMP = 0.06; // 北端坡道淺灰鋪面（高出地形；與步道同一圖層，略低於步道 0.07，交會處步道在上）
const RAMP_EDGE_W = 0.25; // 坡道白色邊線寬（m，推測，依 reference §6.2「長條白邊弧形坡道」）
const Y_RAMP_EDGE = 0.1; // 坡道白色邊線（高出坡道鋪面）
const GROUND_UV = 4; // 地面人行鋪面貼圖一張的邊長（m），地形 patch 的鋪面部分沿用同一尺度
const GRASS_UV = 8; // 草地貼圖一張的邊長（m）
const ROAD_UV = 8; // 車道柏油 UV 一單位（m）
const TREE_OFFSET = 0.85; // 行道樹距路緣（m）：對齊 street.js 設施帶樹穴中心（路緣石 0.15 + 設施帶 1.4 / 2）
const TREE_ROAD_PAD = 0.6; // 行道樹離任何路面至少（m）：樹穴在路緣 0.15–1.55 m 的設施帶內
const STREET_SEED = 20260930; // 街道細節固定種子

// 除了高度差，再用 polygonOffset 分層：遠處深度精度不足時地面圖層也不會互相閃爍
function layer(k) {
  return { polygonOffset: true, polygonOffsetFactor: -k, polygonOffsetUnits: -k * 2 };
}

// ---------- 地形高度 ----------
// 轉呼叫 terrain.js 的唯一高度場（保留原 export 名稱，main.js 等不必改）
export function heightAt(x, z) {
  return terrainHeightAt(x, z);
}

// ---------- 位置描述（HUD 用） ----------
// 靠近具名建築（輪廓 10m 內）→ 顯示建築名；否則顯示所在 / 最近的道路名
export function describeLocation(x, z) {
  const nb = nearestNamedBuilding(x, z, 10);
  if (nb) return { text: nb.building.name, building: nb.building };
  const here = namedRoadsAt(x, z, 1);
  if (here.length >= 2) return { text: `${here[0]} / ${here[1]} 路口`, building: null };
  if (here.length === 1) return { text: here[0], building: null };
  const near = nearestNamedRoad(x, z, 240);
  if (near) return { text: `近 ${near.road.name}`, building: null };
  return { text: '七期', building: null };
}

// ---------- 貼圖 ----------
function repeatTex(canvas, anisotropy) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = anisotropy;
  return tex;
}

// 人行鋪面地磚（一張 = 4m × 4m，每格 1m）
function makePavingTexture(anisotropy) {
  const canvas = makeCanvas(128, 128);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#b7b1a6';
  ctx.fillRect(0, 0, 128, 128);
  const rng = mulberry32(31);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const g = 172 + Math.floor(rng() * 14);
      ctx.fillStyle = `rgb(${g},${g - 5},${g - 13})`;
      ctx.fillRect(i * 32 + 1, j * 32 + 1, 30, 30);
    }
  }
  return repeatTex(canvas, anisotropy);
}

// 柏油雜點（一張 = 8m）
function makeAsphaltTexture(anisotropy) {
  const canvas = makeCanvas(128, 128);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 128, 128);
  const rng = mulberry32(13);
  for (let i = 0; i < 900; i++) {
    const g = 215 + Math.floor(rng() * 40);
    ctx.fillStyle = `rgb(${g},${g},${g})`;
    ctx.fillRect(rng() * 128, rng() * 128, 2, 2);
  }
  return repeatTex(canvas, anisotropy);
}

function makeGrassTexture(anisotropy) {
  const canvas = makeCanvas(256, 256);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#6f8f55';
  ctx.fillRect(0, 0, 256, 256);
  const rng = mulberry32(99);
  for (let i = 0; i < 2500; i++) {
    ctx.fillStyle = rng() < 0.5 ? '#668650' : '#789a5d';
    ctx.fillRect(rng() * 256, rng() * 256, 3, 3);
  }
  return repeatTex(canvas, anisotropy);
}

// 可平鋪貼圖載入成功後改由貼圖給色（原本的純色 / 灰階底色改白）
function whiten(material) {
  material.color.set(0xffffff);
  return false;
}

// ---------- 地面幾何寫入器（所有三角形保證朝上） ----------
// 底下高度場全為 0 的面畫成水平面（y = 圖層高度）；否則交給 terrain.js 細分貼地（y = 地形高 + 圖層高度）
class FlatWriter {
  constructor(uvScale = 8) {
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.col = [];
    this.uvScale = uvScale;
    this.color = null;
    this.terrain = getTerrain();
  }

  // 執行一次貼地細分，補上新頂點的 UV（依世界座標）與頂點色
  _drape(fn, hasUV = false) {
    const start = this.pos.length / 3;
    fn();
    const k = 1 / this.uvScale;
    for (let i = start; i < this.pos.length / 3; i++) {
      if (!hasUV) this.uv.push(this.pos[i * 3] * k, -this.pos[i * 3 + 2] * k);
      if (this.color) this.col.push(this.color.r, this.color.g, this.color.b);
    }
  }

  // 水平三角形；在 (x, z) 平面為逆時針時交換頂點，讓法線朝上
  tri(x1, z1, x2, z2, x3, z3, y) {
    if (!this.terrain.isFlatUnder([x1, z1, x2, z2, x3, z3])) {
      this._drape(() => drapeTriangle(this.terrain, x1, z1, x2, z2, x3, z3, y, this));
      return;
    }
    const cr = (x2 - x1) * (z3 - z1) - (z2 - z1) * (x3 - x1);
    if (Math.abs(cr) < 1e-10) return;
    if (cr > 0) {
      const tx = x2;
      const tz = z2;
      x2 = x3;
      z2 = z3;
      x3 = tx;
      z3 = tz;
    }
    const k = 1 / this.uvScale;
    this.pos.push(x1, y, z1, x2, y, z2, x3, y, z3);
    this.nor.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
    this.uv.push(x1 * k, -z1 * k, x2 * k, -z2 * k, x3 * k, -z3 * k);
    if (this.color) for (let i = 0; i < 3; i++) this.col.push(this.color.r, this.color.g, this.color.b);
  }

  // 帶 UV 的水平三角形（文字貼圖用；頂點與 UV 一起交換，不會鏡像）
  triUV(a, b, c, y) {
    if (!this.terrain.isFlatUnder([a[0], a[1], b[0], b[1], c[0], c[1]])) {
      this._drape(() => drapeTriangle(this.terrain, a[0], a[1], b[0], b[1], c[0], c[1], y, this, 1, [a[2], a[3], b[2], b[3], c[2], c[3]]), true);
      return;
    }
    const cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (cr > 0) {
      const t = b;
      b = c;
      c = t;
    }
    for (const q of [a, b, c]) {
      this.pos.push(q[0], y, q[1]);
      this.nor.push(0, 1, 0);
      this.uv.push(q[2], q[3]);
    }
  }

  quad(ax, az, bx, bz, cx, cz, dx, dz, y) {
    this.tri(ax, az, bx, bz, cx, cz, y);
    this.tri(ax, az, cx, cz, dx, dz, y);
  }

  disc(x, z, r, y, seg = 14) {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      this.tri(x, z, x + Math.cos(a0) * r, z + Math.sin(a0) * r, x + Math.cos(a1) * r, z + Math.sin(a1) * r, y);
    }
  }

  polygon(p, y) {
    const t = triangulate(p);
    for (let k = 0; k < t.length; k += 3) {
      this.tri(p[t[k] * 2], p[t[k] * 2 + 1], p[t[k + 1] * 2], p[t[k + 1] * 2 + 1], p[t[k + 2] * 2], p[t[k + 2] * 2 + 1], y);
    }
  }

  // 帶狀路面：每段一個矩形；端點與轉折處補圓盤，路口與彎道不留破洞
  // 底下有地形起伏時整條改用 drapeRibbon（沿線 / 橫向細分到 ≤ 1 m）；surface 預設為高度場（湖上橋改傳 topSurface）
  ribbon(pts, hw, y, surface = this.terrain) {
    if (!this.terrain.isFlatAlong(pts, hw)) {
      this._drape(() => drapeRibbon(surface, pts, hw, y, this));
      return;
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L < 1e-4) continue;
      const nx = (-(b.z - a.z) / L) * hw;
      const nz = ((b.x - a.x) / L) * hw;
      this.quad(a.x + nx, a.z + nz, b.x + nx, b.z + nz, b.x - nx, b.z - nz, a.x - nx, a.z - nz, y);
    }
    for (let i = 0; i < pts.length; i++) {
      if (i > 0 && i < pts.length - 1) {
        const a = pts[i - 1];
        const b = pts[i];
        const c = pts[i + 1];
        const d1x = b.x - a.x;
        const d1z = b.z - a.z;
        const d2x = c.x - b.x;
        const d2z = c.z - b.z;
        const cos = (d1x * d2x + d1z * d2z) / ((Math.hypot(d1x, d1z) * Math.hypot(d2x, d2z)) || 1);
        if (cos > 0.9997) continue; // 幾乎直線，不需要補
      }
      this.disc(pts[i].x, pts[i].z, hw, y, hw > 5 ? 18 : 12);
    }
  }

  toGeometry() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.col.length) geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.computeBoundingSphere();
    return geo;
  }
}

function flatMesh(writer, material, receiveShadow = true) {
  const mesh = new THREE.Mesh(writer.toGeometry(), material);
  mesh.receiveShadow = receiveShadow;
  return mesh;
}

// ---------- 標線 ----------
// 道路上的路口位置（沿線距離 s 與淨空半徑），標線在這些範圍內中斷
function junctionStops(road) {
  const stops = [];
  road.pts.forEach((p, idx) => {
    const list = nodeRoads.get(nodeKey(p.x, p.z));
    if (!list || nodeDegree(list) < 3) return;
    let hw = 0;
    for (const e of list) if (e.road !== road) hw = Math.max(hw, e.road.hw);
    if (hw > 0) stops.push({ s: road.cum[idx], r: hw + 2 });
  });
  return stops;
}

// [0, L] 扣掉路口範圍後的區間
function allowedIntervals(road) {
  let iv = [[1, road.length - 1]];
  for (const j of junctionStops(road)) {
    const next = [];
    for (const [a, b] of iv) {
      if (j.s + j.r <= a || j.s - j.r >= b) next.push([a, b]);
      else {
        if (j.s - j.r > a) next.push([a, j.s - j.r]);
        if (j.s + j.r < b) next.push([j.s + j.r, b]);
      }
    }
    iv = next;
  }
  return iv.filter(([a, b]) => b - a > 1);
}

// 沿折線 [s0, s1] 畫一條側向偏移 off、寬 w 的線
function lineAlong(writer, road, s0, s1, off, w, y) {
  const { pts, cum } = road;
  for (let i = 0; i < pts.length - 1; i++) {
    const a0 = cum[i];
    const a1 = cum[i + 1];
    if (a1 <= s0 || a0 >= s1) continue;
    const L = a1 - a0;
    if (L < 1e-4) continue;
    const ux = (pts[i + 1].x - pts[i].x) / L;
    const uz = (pts[i + 1].z - pts[i].z) / L;
    const rx = -uz; // 右方（x 東、z 南）
    const rz = ux;
    const t0 = Math.max(s0, a0) - a0;
    const t1 = Math.min(s1, a1) - a0;
    const cx0 = pts[i].x + ux * t0 + rx * off;
    const cz0 = pts[i].z + uz * t0 + rz * off;
    const cx1 = pts[i].x + ux * t1 + rx * off;
    const cz1 = pts[i].z + uz * t1 + rz * off;
    const hx = rx * (w / 2);
    const hz = rz * (w / 2);
    writer.quad(cx0 + hx, cz0 + hz, cx1 + hx, cz1 + hz, cx1 - hx, cz1 - hz, cx0 - hx, cz0 - hz, y);
  }
}

function dashedAlong(writer, road, s0, s1, off, w, y, dash = 3, gap = 6) {
  const period = dash + gap;
  for (let s = Math.floor(s0 / period) * period; s < s1; s += period) {
    const a = Math.max(s, s0);
    const b = Math.min(s + dash, s1);
    if (b - a > 0.3) lineAlong(writer, road, a, b, off, w, y);
  }
}

function addMarkings(yellow, white, road) {
  const hw = road.hw;
  const intervals = allowedIntervals(road);
  if (!intervals.length) return;
  const edge = hw - 0.45;
  for (const [a, b] of intervals) {
    if (road.oneway) {
      // 單行道：白色車道虛線 + 兩側白色邊線
      const n = Math.max(1, road.lanes || Math.floor(road.width / 3.2));
      const lw = road.width / n;
      for (let k = 1; k < n; k++) dashedAlong(white, road, a, b, -hw + lw * k, 0.15, Y_MARK);
      if (road.width >= 6) {
        lineAlong(white, road, a, b, edge, 0.15, Y_MARK);
        lineAlong(white, road, a, b, -edge, 0.15, Y_MARK);
      }
    } else {
      // 雙向道：雙黃中線 + 各方向車道虛線 + 邊線
      lineAlong(yellow, road, a, b, 0.2, 0.15, Y_MARK);
      lineAlong(yellow, road, a, b, -0.2, 0.15, Y_MARK);
      const perSide = Math.max(1, Math.floor((road.lanes || Math.floor(road.width / 3.2)) / 2));
      const lw = hw / perSide;
      for (let k = 1; k < perSide; k++) {
        dashedAlong(white, road, a, b, lw * k, 0.15, Y_MARK);
        dashedAlong(white, road, a, b, -lw * k, 0.15, Y_MARK);
      }
      if (road.width >= 8) {
        lineAlong(white, road, a, b, edge, 0.15, Y_MARK);
        lineAlong(white, road, a, b, -edge, 0.15, Y_MARK);
      }
    }
  }
}

// ---------- 路名地面字 ----------
const LABEL_W = 512;
const LABEL_H = 128;
const LABEL_SPACING = 110; // 同名道路兩個地面字的最小間距

function drawLabel(ctx, x, y, w, h, text) {
  ctx.clearRect(x, y, w, h);
  fitText(ctx, text, x + w / 2, y + h / 2, w * 0.92, Math.floor(h * 0.62));
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(30,30,34,0.55)';
  ctx.strokeText(text, x + w / 2, y + h / 2);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillText(text, x + w / 2, y + h / 2);
}

function placeRoadLabels() {
  const placed = new Map(); // name -> [{x, z}]
  const labels = [];
  const tmp = { x: 0, z: 0, dx: 0, dz: 0 };
  const roadsByLen = surfaceRoads.filter((r) => r.name && r.type !== 'service' && r.length >= 30).sort((a, b) => b.length - a.length);
  for (const r of roadsByLen) {
    const n = Math.max(1, Math.floor(r.length / LABEL_SPACING));
    for (let k = 0; k < n; k++) {
      const s = (r.length * (k + 0.5)) / n;
      sampleAt(r, s, tmp);
      if (!inBounds(tmp.x, tmp.z, 5)) continue;
      if (junctionClearance(tmp.x, tmp.z) < 6) continue;
      const list = placed.get(r.name) || [];
      if (list.some((p) => Math.hypot(p.x - tmp.x, p.z - tmp.z) < LABEL_SPACING * 0.8)) continue;
      list.push({ x: tmp.x, z: tmp.z });
      placed.set(r.name, list);
      // 文字一律由西往東（純南北向時由北往南）閱讀，北方朝上看不會倒過來
      let dx = tmp.dx;
      let dz = tmp.dz;
      if (dx < -1e-3 || (Math.abs(dx) <= 1e-3 && dz < 0)) {
        dx = -dx;
        dz = -dz;
      }
      const h = Math.min(3.2, r.width * 0.42);
      // 雙向道把字放在中線一側（行進方向右側），避開雙黃線
      const off = r.oneway ? 0 : Math.min(r.hw * 0.5, h * 0.5 + 0.8);
      labels.push({ name: r.name, x: tmp.x - tmp.dz * off, z: tmp.z + tmp.dx * off, dx, dz, h, len: h * (LABEL_W / LABEL_H) });
    }
  }
  return labels;
}

function sampleAt(road, s, out) {
  const { pts, cum } = road;
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] < s) i++;
  const L = cum[i + 1] - cum[i] || 1;
  const t = Math.min(1, Math.max(0, (s - cum[i]) / L));
  out.x = pts[i].x + (pts[i + 1].x - pts[i].x) * t;
  out.z = pts[i].z + (pts[i + 1].z - pts[i].z) * t;
  out.dx = (pts[i + 1].x - pts[i].x) / L;
  out.dz = (pts[i + 1].z - pts[i].z) / L;
  return out;
}

function buildRoadLabels(group, anisotropy) {
  const labels = placeRoadLabels();
  const names = [...new Set(labels.map((l) => l.name))];
  const atlas = buildTextAtlas(names, LABEL_W, LABEL_H, drawLabel, { anisotropy });
  const writers = atlas.textures.map(() => new FlatWriter());
  for (const l of labels) {
    const cell = atlas.cells[names.indexOf(l.name)];
    const w = writers[cell.atlas];
    // 文字左→右沿 (dx, dz)，文字上方朝 (dz, -dx)（北方朝上看為左手邊）
    const ux = l.dz;
    const uz = -l.dx;
    const hl = l.len / 2;
    const hh = l.h / 2;
    const bl = [l.x - l.dx * hl - ux * hh, l.z - l.dz * hl - uz * hh, cell.u0, cell.v0];
    const br = [l.x + l.dx * hl - ux * hh, l.z + l.dz * hl - uz * hh, cell.u1, cell.v0];
    const tr = [l.x + l.dx * hl + ux * hh, l.z + l.dz * hl + uz * hh, cell.u1, cell.v1];
    const tl = [l.x - l.dx * hl + ux * hh, l.z - l.dz * hl + uz * hh, cell.u0, cell.v1];
    w.triUV(bl, br, tr, Y_LABEL);
    w.triUV(bl, tr, tl, Y_LABEL);
  }
  writers.forEach((w, a) => {
    const mat = new THREE.MeshStandardMaterial({
      map: atlas.textures[a],
      transparent: true,
      depthWrite: false,
      roughness: 0.9,
      ...layer(6),
    });
    group.add(flatMesh(w, mat, false));
  });
  return labels.length;
}

// ---------- 行道樹、路燈、公園樹木 ----------
// 簡單的點間距檢查（避免兩條平行道路把樹種在同一點）
class PointSet {
  constructor(minDist) {
    this.min = minDist;
    this.map = new Map();
  }

  _k(ix, iz) {
    return ix * 100003 + iz;
  }

  tryAdd(x, z) {
    const cs = this.min;
    const ix = Math.floor(x / cs);
    const iz = Math.floor(z / cs);
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        const list = this.map.get(this._k(ix + a, iz + b));
        if (list && list.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < cs * cs)) return false;
      }
    }
    const k = this._k(ix, iz);
    if (!this.map.has(k)) this.map.set(k, []);
    this.map.get(k).push({ x, z });
    return true;
  }
}

function placeStreetFurniture(rng) {
  const trees = [];
  const lamps = [];
  const treeSet = new PointSet(5);
  const lampSet = new PointSet(12);
  const tmp = { x: 0, z: 0, dx: 0, dz: 0 };
  for (const r of surfaceRoads) {
    if (!MAJOR_TYPES.has(r.type)) continue;
    for (const side of [1, -1]) {
      for (let s = 6; s < r.length - 3; s += 12) {
        sampleAt(r, s, tmp);
        const rx = -tmp.dz * side;
        const rz = tmp.dx * side;
        const off = r.hw + TREE_OFFSET;
        const x = tmp.x + rx * off;
        const z = tmp.z + rz * off;
        if (!inBounds(x, z, 2)) continue;
        if (buildingAt(x, z, 1.8)) continue;
        if (onRoadSurface(x, z, TREE_ROAD_PAD, true)) continue;
        if (inWater(x, z, 1)) continue;
        if (!treeSet.tryAdd(x, z)) continue;
        trees.push({ x, z, scale: 0.8 + rng() * 0.45, hue: rng() });
      }
      for (let s = 15; s < r.length - 3; s += 30) {
        sampleAt(r, s, tmp);
        const rx = -tmp.dz * side;
        const rz = tmp.dx * side;
        const off = r.hw + 0.8;
        const x = tmp.x + rx * off;
        const z = tmp.z + rz * off;
        if (!inBounds(x, z, 2)) continue;
        if (buildingAt(x, z, 1.2)) continue;
        if (onRoadSurface(x, z, 0.4, false)) continue;
        if (inWater(x, z, 0.5)) continue;
        if (!lampSet.tryAdd(x, z)) continue;
        // 燈頭朝道路中心伸出，燈頭末端也不能伸進建築
        const hx = x - rx * 1.0;
        const hz = z - rz * 1.0;
        if (buildingAt(hx, hz, 0.3)) continue;
        lamps.push({ x, z, dirX: -rx, dirZ: -rz });
      }
    }
  }
  return { trees, lamps };
}

function placeParkTrees(rng, trees) {
  const set = new PointSet(6);
  for (const t of trees) set.tryAdd(t.x, t.z);
  for (const p of parks) {
    const step = polygonArea(p.poly) > 20000 ? 11 : 9;
    for (let x = p.bbox.x0 + step / 2; x < p.bbox.x1; x += step) {
      for (let z = p.bbox.z0 + step / 2; z < p.bbox.z1; z += step) {
        const jx = x + (rng() - 0.5) * step * 0.7;
        const jz = z + (rng() - 0.5) * step * 0.7;
        if (rng() < 0.35) continue;
        if (!pointInPolygon(jx, jz, p.poly)) continue;
        if (!inBounds(jx, jz, 2)) continue;
        if (buildingAt(jx, jz, 2)) continue;
        if (onRoadSurface(jx, jz, 1.2, true)) continue;
        if (inWater(jx, jz, 2)) continue;
        if (!set.tryAdd(jx, jz)) continue;
        trees.push({ x: jx, z: jz, scale: 0.9 + rng() * 0.5, hue: rng() });
      }
    }
  }
}

// ---------- 地形 ----------
// 矩形 [x0, z0, x1, z1] 扣掉各 patch 範圍後的矩形清單（依 patch 邊界切成 x 條帶，邊界與 patch 外框完全重合、無裂縫）
function subtractRects(x0, z0, x1, z1, patches) {
  const xs = [x0, x1];
  for (const p of patches) xs.push(p.x0, p.x1);
  const cuts = [...new Set(xs.filter((x) => x >= x0 && x <= x1))].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i];
    const b = cuts[i + 1];
    const holes = patches.filter((p) => p.x0 < b && p.x1 > a).map((p) => [p.z0, p.z1]).sort((u, v) => u[0] - v[0]);
    let z = z0;
    for (const [h0, h1] of holes) {
      if (h0 > z) out.push([a, z, b, h0]);
      z = Math.max(z, h1);
    }
    if (z < z1) out.push([a, z, b, z1]);
  }
  return out;
}

// 所有 patch 合併成一個 BufferGeometry，依 SURFACES 分組（每種材質一個 draw call）
function buildTerrainMesh(patches, mats) {
  const meshes = patches.map((p) => buildPatchMesh(p, { uvScale: GROUND_UV }));
  const nv = meshes.reduce((s, m) => s + m.positions.length / 3, 0);
  const positions = new Float32Array(nv * 3);
  const normals = new Float32Array(nv * 3);
  const uvs = new Float32Array(nv * 2);
  const bySurface = SURFACES.map(() => []);
  let base = 0;
  for (const m of meshes) {
    positions.set(m.positions, base * 3);
    normals.set(m.normals, base * 3);
    uvs.set(m.uvs, base * 2);
    for (const g of m.groups) {
      const list = bySurface[SURFACES.indexOf(g.surface)];
      for (let i = g.start; i < g.start + g.count; i++) list.push(m.indices[i] + base);
    }
    base += m.positions.length / 3;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  const index = [];
  const materials = [];
  for (let k = 0; k < SURFACES.length; k++) {
    if (!bySurface[k].length) continue;
    geo.addGroup(index.length, bySurface[k].length, materials.length);
    materials.push(mats[SURFACES[k]]);
    for (const i of bySurface[k]) index.push(i);
  }
  geo.setIndex(new THREE.Uint32BufferAttribute(index, 1));
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, materials);
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  return mesh;
}

// 水平水面（不貼地：直接寫入三角形，避免被當成地面圖層細分）
function writeWaterPlane(w, poly, y) {
  const t = triangulate(poly);
  const k = 1 / w.uvScale;
  for (let i = 0; i < t.length; i += 3) {
    let a = t[i];
    let b = t[i + 1];
    const c = t[i + 2];
    const cr = (poly[b * 2] - poly[a * 2]) * (poly[c * 2 + 1] - poly[a * 2 + 1]) - (poly[b * 2 + 1] - poly[a * 2 + 1]) * (poly[c * 2] - poly[a * 2]);
    if (cr > 0) [a, b] = [b, a];
    for (const v of [a, b, c]) {
      w.pos.push(poly[v * 2], y, poly[v * 2 + 1]);
      w.nor.push(0, 1, 0);
      w.uv.push(poly[v * 2] * k, -poly[v * 2 + 1] * k);
    }
  }
}

// 平滑折線（[{ x, z }]）畫成寬 2·hw 的貼地細帶：轉折處取兩段法線平均的斜接點（夾限 MITER_MAX 倍），相鄰段不留縫也不重疊成鋸齒
function addStrip(writer, pts, hw, y) {
  const n = pts.length;
  if (n < 2) return;
  const segN = [];
  for (let i = 0; i + 1 < n; i++) {
    const L = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z) || 1;
    segN.push({ x: -(pts[i + 1].z - pts[i].z) / L, z: (pts[i + 1].x - pts[i].x) / L });
  }
  const off = pts.map((p, i) => {
    const a = segN[Math.max(0, i - 1)];
    const b = segN[Math.min(n - 2, i)];
    const k = Math.min(MITER_MAX, 1 / Math.max(1e-3, (1 + a.x * b.x + a.z * b.z) / 2)) / 2;
    return { x: (a.x + b.x) * k * hw, z: (a.z + b.z) * k * hw };
  });
  for (let i = 0; i + 1 < n; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const oa = off[i];
    const ob = off[i + 1];
    writer.quad(a.x + oa.x, a.z + oa.z, b.x + ob.x, b.z + ob.z, b.x - ob.x, b.z - ob.z, a.x - oa.x, a.z - oa.z, y);
  }
}

// 秋紅谷退台白色邊線：terrain.terracePaths（等高線平滑折線 [x, y, z, …]）畫成貼地細帶
function addTerraceLines(writer, paths) {
  for (const p of paths) {
    const pts = [];
    for (let i = 0; i < p.length; i += 3) pts.push({ x: p[i], z: p[i + 2] });
    addStrip(writer, pts, TERRACE_LINE_W / 2, Y_TERRACE_LINE);
  }
}

// 北端坡道兩側白色邊線：中心線往兩側偏移（半寬 − 邊線半寬），貼地細帶
function addRampEdges(writer, ramp) {
  const e = ramp.hw - RAMP_EDGE_W / 2;
  const pts = ramp.pts;
  for (const s of [1, -1]) {
    const side = pts.map((p, i) => {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      return { x: p.x - (s * e * (b.z - a.z)) / L, z: p.z + (s * e * (b.x - a.x)) / L };
    });
    addStrip(writer, side, RAMP_EDGE_W / 2, Y_RAMP_EDGE);
  }
}

// ---------- 紅橋甲板 ----------
// 甲板上方的疊層判定（與 qiuhonggu.js stripDeckOverlays 相同條件）：在紅橋 / Z 字步道 walkable 範圍內、高出甲板 0–0.1 m
function deckOverlayTest(terrain) {
  const decks = terrain.walkables.filter((w) => w.kind === 'bridge' || w.kind === 'boardwalk');
  return (x, y, z) => {
    for (const w of decks) {
      const b = w.bbox;
      if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1 || !pointInPolygon(x, z, w.poly)) continue;
      const dy = y - w.heightAt(x, z);
      if (dy > 0 && dy < 0.1) return true;
    }
    return false;
  };
}

// 把 writer 自第 start 個頂點起新增的三角形中「三頂點都在甲板上」者刪掉；回傳刪除數
function dropDeckTriangles(w, start, onDeck) {
  const P = w.pos;
  const keep = [];
  let drop = 0;
  for (let v = start; v < P.length / 3; v += 3) {
    let all = true;
    for (let k = 0; k < 3 && all; k++) all = onDeck(P[(v + k) * 3], P[(v + k) * 3 + 1], P[(v + k) * 3 + 2]);
    if (all) drop++;
    else keep.push(v);
  }
  if (!drop) return 0;
  const cut = (arr, size) => {
    const tail = [];
    for (const v of keep) for (let i = v * size; i < (v + 3) * size; i++) tail.push(arr[i]);
    arr.length = start * size;
    arr.push(...tail);
  };
  cut(w.pos, 3);
  cut(w.nor, 3);
  cut(w.uv, 2);
  if (w.col.length) cut(w.col, 3);
  return drop;
}

// ---------- 建構世界 ----------
export function buildWorld(scene, { anisotropy = 4 } = {}) {
  const group = new THREE.Group();
  group.name = 'world';
  scene.add(group);

  const terrain = getTerrain();
  const groundMat = new THREE.MeshStandardMaterial({ map: makePavingTexture(anisotropy), roughness: 0.95 });
  const grassTex = makeGrassTexture(anisotropy);
  applyTile(groundMat, 'sidewalk_gray', { uvUnit: GROUND_UV, anisotropy });

  // 地面：人行鋪面色（世界邊界外再延伸一段，避免看到天空底）；y = 0 的大平面在各地形 patch 範圍挖空
  {
    const E = 900;
    const w = new FlatWriter(GROUND_UV);
    for (const [x0, z0, x1, z1] of subtractRects(BOUNDS.minX - E, BOUNDS.minZ - E, BOUNDS.maxX + E, BOUNDS.maxZ + E, terrain.patches)) {
      w.quad(x0, z0, x1, z0, x1, z1, x0, z1, 0);
    }
    group.add(flatMesh(w, groundMat));
  }

  // 地形 patch：高度場網格本身（鋪面 / 草地 / 淺灰混凝土三組材質，全部 patch 合併成一個幾何）
  const terrainStats = { patchTriangles: 0 };
  {
    const grassPatchTex = grassTex.clone();
    grassPatchTex.repeat.set(GROUND_UV / GRASS_UV, GROUND_UV / GRASS_UV);
    const mats = {
      ground: groundMat,
      grass: new THREE.MeshStandardMaterial({ map: grassPatchTex, roughness: 1 }),
      concrete: new THREE.MeshStandardMaterial({ color: 0xc4c2bb, roughness: 0.9 }),
    };
    // patch UV 一單位 = GROUND_UV；秋紅谷退台混凝土由純色改為 concrete 貼圖（貼圖本身給色）
    applyTile(mats.grass, 'grass', { uvUnit: GROUND_UV, anisotropy });
    applyTile(mats.concrete, 'concrete', { uvUnit: GROUND_UV, anisotropy, onApply: whiten });
    const mesh = buildTerrainMesh(terrain.patches, mats);
    terrainStats.patchTriangles = mesh.geometry.index.count / 3;
    group.add(mesh);
  }

  // 公園草地（被地形 patch 直接著色的綠地，如秋紅谷，不另畫）
  {
    const w = new FlatWriter(GRASS_UV);
    for (const p of parks) if (!terrain.coveredAreaIds.has(p.id)) w.polygon(p.poly, Y_PARK);
    const mat = new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1, ...layer(1) });
    applyTile(mat, 'grass', { uvUnit: GRASS_UV, anisotropy });
    if (w.pos.length) group.add(flatMesh(w, mat));
  }

  // 水面：谷地內的湖為水平面 y = levels.water；其他水域照舊
  {
    const w = new FlatWriter(8);
    for (const p of water) {
      const y = terrain.waterLevel(p.id);
      if (y === null) w.polygon(p.poly, Y_WATER);
      else writeWaterPlane(w, p.poly, y);
    }
    const mat = new THREE.MeshStandardMaterial({ color: 0x3f6f8a, roughness: 0.15, metalness: 0.3, ...layer(2) });
    if (w.pos.length) group.add(flatMesh(w, mat));
  }

  // 步道（淺色窄帶）；橋上步道貼 topSurface，落在紅橋 / Z 字步道甲板上的三角形在源頭略過
  {
    const w = new FlatWriter(4);
    const onDeck = deckOverlayTest(terrain);
    let skipped = 0;
    for (const r of surfaceFootways) {
      const start = w.pos.length / 3;
      w.ribbon(r.pts, r.hw, Y_FOOT, r.bridge ? terrain.topSurface : terrain);
      if (r.bridge) skipped += dropDeckTriangles(w, start, onDeck);
    }
    // 北端坡道鋪面（terrain.rampPaths；高度場格 kind = 'ramp'，網格仍畫草地，鋪面由此平滑帶狀面呈現，與步道同一淺灰材質）
    for (const rp of terrain.rampPaths) w.ribbon(rp.pts, rp.hw, Y_RAMP);
    group.userData.deckOverlaySkipped = skipped;
    const mat = new THREE.MeshStandardMaterial({ color: 0xd9d3c5, roughness: 0.95, ...layer(3) });
    if (w.pos.length) group.add(flatMesh(w, mat));
  }

  // 車道路面（依類型給不同深淺的柏油色，全部合併成一個幾何）
  {
    const w = new FlatWriter(ROAD_UV);
    const colors = {
      trunk: new THREE.Color(0x3a3b3f),
      primary: new THREE.Color(0x3b3c40),
      secondary: new THREE.Color(0x3f4044),
      tertiary: new THREE.Color(0x434448),
      service: new THREE.Color(0x55565a),
      other: new THREE.Color(0x48494d),
    };
    // 窄路先畫、寬路後畫；同高度重疊處顏色相同
    const sorted = surfaceRoads.slice().sort((a, b) => a.width - b.width);
    for (const r of sorted) {
      w.color = colors[r.type] || colors.other;
      w.ribbon(r.pts, r.hw, Y_ROAD);
    }
    const mat = new THREE.MeshStandardMaterial({ map: makeAsphaltTexture(anisotropy), vertexColors: true, roughness: 0.92, ...layer(4) });
    // asphalt 貼圖自帶柏油深灰：關掉依類型的頂點色，與 street.js 路口鋪面（同一貼圖、同一 UV 尺度）一致不露接縫
    applyTile(mat, 'asphalt', { uvUnit: ROAD_UV, anisotropy, onApply: dropVertexColors });
    group.add(flatMesh(w, mat));
  }

  // 標線（主要道路：中線 / 車道線 / 邊線；路口範圍內中斷）
  {
    const yellow = new FlatWriter();
    const white = new FlatWriter();
    for (const r of surfaceRoads) if (MAJOR_TYPES.has(r.type)) addMarkings(yellow, white, r);
    addTerraceLines(white, terrain.terracePaths);
    for (const rp of terrain.rampPaths) addRampEdges(white, rp);
    const ym = new THREE.MeshStandardMaterial({ color: 0xe8c020, roughness: 0.8, ...layer(5) });
    const wm = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.8, ...layer(5) });
    if (yellow.pos.length) group.add(flatMesh(yellow, ym));
    if (white.pos.length) group.add(flatMesh(white, wm));
  }

  const labelCount = buildRoadLabels(group, anisotropy);

  // 行道樹、路燈、公園樹木（InstancedMesh）
  const rng = mulberry32(4242);
  const { trees, lamps } = placeStreetFurniture(rng);
  const streetTrees = trees.length;
  placeParkTrees(rng, trees);
  const treeResult = buildTrees(trees);
  group.add(treeResult.trunks, treeResult.crowns);
  const lampResult = buildLamps(lamps);
  group.add(lampResult.poles, lampResult.heads);

  // 街道細節（D3 street.js）：與 world 群組並列加入場景（world 群組只含地面圖層與街樹路燈）
  const street = buildStreetDetails({
    roads: surfaceRoads, footways: surfaceFootways, junctions, buildings, terrain, seed: STREET_SEED, anisotropy,
    basins: terrain.patches.filter((p) => p.kind === 'basin').map((p) => p.feature.src.p), // = osm.T.basins[].p
  });
  scene.add(street.group);

  return {
    group,
    street,
    stats: { labels: labelCount, streetTrees, parkTrees: trees.length - streetTrees, lamps: lamps.length, ...terrainStats },
    trees,
    lamps,
  };
}

function buildTrees(trees) {
  const trunkGeo = new THREE.CylinderGeometry(0.14, 0.2, 2.6, 5);
  trunkGeo.translate(0, 1.3, 0);
  const crownGeo = new THREE.IcosahedronGeometry(1.7, 0);
  crownGeo.translate(0, 3.7, 0);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a32, roughness: 1 });
  const crownMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true });
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, Math.max(1, trees.length));
  const crowns = new THREE.InstancedMesh(crownGeo, crownMat, Math.max(1, trees.length));
  trunks.count = trees.length;
  crowns.count = trees.length;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const c = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);
  const greens = [new THREE.Color(0x3f7a38), new THREE.Color(0x4f8a3c), new THREE.Color(0x356b3a)];
  trees.forEach((t, i) => {
    p.set(t.x, heightAt(t.x, t.z), t.z);
    q.setFromAxisAngle(up, t.hue * Math.PI * 2);
    s.set(t.scale, t.scale, t.scale);
    m.compose(p, q, s);
    trunks.setMatrixAt(i, m);
    crowns.setMatrixAt(i, m);
    c.copy(greens[Math.floor(t.hue * greens.length) % greens.length]);
    crowns.setColorAt(i, c);
  });
  trunks.instanceMatrix.needsUpdate = true;
  crowns.instanceMatrix.needsUpdate = true;
  if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
  trunks.castShadow = true;
  crowns.castShadow = true;
  return { trunks, crowns };
}

function buildLamps(lamps) {
  const poleGeo = new THREE.CylinderGeometry(0.08, 0.12, 7, 6);
  poleGeo.translate(0, 3.5, 0);
  const headGeo = new THREE.BoxGeometry(0.45, 0.22, 2.2);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x5a5f66, roughness: 0.6, metalness: 0.4 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0x3a3d42, emissive: 0xffe2a8, emissiveIntensity: 0, roughness: 0.5 });
  registerNight(headMat, 2.5);
  const poles = new THREE.InstancedMesh(poleGeo, poleMat, Math.max(1, lamps.length));
  const heads = new THREE.InstancedMesh(headGeo, headMat, Math.max(1, lamps.length));
  poles.count = lamps.length;
  heads.count = lamps.length;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const p = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  lamps.forEach((l, i) => {
    const base = heightAt(l.x, l.z);
    q.identity();
    p.set(l.x, base, l.z);
    m.compose(p, q, one);
    poles.setMatrixAt(i, m);
    // 燈頭長邊（本地 +Z）朝道路中心
    q.setFromAxisAngle(up, Math.atan2(l.dirX, l.dirZ));
    p.set(l.x + l.dirX * 1.0, base + 7, l.z + l.dirZ * 1.0);
    m.compose(p, q, one);
    heads.setMatrixAt(i, m);
  });
  poles.instanceMatrix.needsUpdate = true;
  heads.instanceMatrix.needsUpdate = true;
  poles.castShadow = true;
  return { poles, heads };
}
