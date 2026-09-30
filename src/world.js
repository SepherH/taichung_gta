// 世界：地面鋪面、公園草地、水面、OSM 道路路面 / 步道、標線、路名地面字、行道樹、路燈、公園樹木
// 全部依 src/data/osm-city.json（真實 OSM 資料）生成；地面高度一律為 0（秋紅谷先以平面公園處理）
import * as THREE from 'three';
import {
  BOUNDS, MAJOR_TYPES, surfaceRoads, surfaceFootways, parks, water, nodeRoads, nodeKey, nodeDegree,
  buildingAt, onRoadSurface, inWater, inBounds, junctionClearance, nearestNamedRoad, nearestNamedBuilding, namedRoadsAt,
} from './citymodel.js';
import { triangulate, pointInPolygon, polygonArea } from './geom.js';
import { makeCanvas, mulberry32, buildTextAtlas, fitText } from './utils.js';
import { registerNight } from './daynight.js';

// 各圖層高度（拉開間距避免 z-fighting）
const Y_PARK = 0.03;
const Y_WATER = 0.05;
const Y_FOOT = 0.07;
const Y_ROAD = 0.1;
const Y_MARK = 0.13;
const Y_LABEL = 0.15;

// 除了高度差，再用 polygonOffset 分層：遠處深度精度不足時地面圖層也不會互相閃爍
function layer(k) {
  return { polygonOffset: true, polygonOffsetFactor: -k, polygonOffsetUnits: -k * 2 };
}

// ---------- 地形高度 ----------
// 目前整個街區都是平地（秋紅谷下凹地形不強求，先以平面公園處理）
export function heightAt() {
  return 0;
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

// ---------- 平面幾何寫入器（所有三角形保證朝上） ----------
class FlatWriter {
  constructor(uvScale = 8) {
    this.pos = [];
    this.uv = [];
    this.col = [];
    this.uvScale = uvScale;
    this.color = null;
  }

  // 水平三角形；在 (x, z) 平面為逆時針時交換頂點，讓法線朝上
  tri(x1, z1, x2, z2, x3, z3, y) {
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
    this.uv.push(x1 * k, -z1 * k, x2 * k, -z2 * k, x3 * k, -z3 * k);
    if (this.color) for (let i = 0; i < 3; i++) this.col.push(this.color.r, this.color.g, this.color.b);
  }

  // 帶 UV 的水平三角形（文字貼圖用；頂點與 UV 一起交換，不會鏡像）
  triUV(a, b, c, y) {
    const cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (cr > 0) {
      const t = b;
      b = c;
      c = t;
    }
    for (const q of [a, b, c]) {
      this.pos.push(q[0], y, q[1]);
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
  ribbon(pts, hw, y) {
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
    const n = this.pos.length / 3;
    const nor = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) nor[i * 3 + 1] = 1;
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
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
        const off = r.hw + 2.0;
        const x = tmp.x + rx * off;
        const z = tmp.z + rz * off;
        if (!inBounds(x, z, 2)) continue;
        if (buildingAt(x, z, 1.8)) continue;
        if (onRoadSurface(x, z, 0.8, true)) continue;
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

// ---------- 建構世界 ----------
export function buildWorld(scene, { anisotropy = 4 } = {}) {
  const group = new THREE.Group();
  group.name = 'world';
  scene.add(group);

  // 地面：人行鋪面色（世界邊界外再延伸一段，避免看到天空底）
  {
    const E = 900;
    const x0 = BOUNDS.minX - E;
    const x1 = BOUNDS.maxX + E;
    const z0 = BOUNDS.minZ - E;
    const z1 = BOUNDS.maxZ + E;
    const w = new FlatWriter(4);
    w.quad(x0, z0, x1, z0, x1, z1, x0, z1, 0);
    const mat = new THREE.MeshStandardMaterial({ map: makePavingTexture(anisotropy), roughness: 0.95 });
    group.add(flatMesh(w, mat));
  }

  // 公園草地
  {
    const w = new FlatWriter(8);
    for (const p of parks) w.polygon(p.poly, Y_PARK);
    const mat = new THREE.MeshStandardMaterial({ map: makeGrassTexture(anisotropy), roughness: 1, ...layer(1) });
    if (w.pos.length) group.add(flatMesh(w, mat));
  }

  // 水面
  {
    const w = new FlatWriter(8);
    for (const p of water) w.polygon(p.poly, Y_WATER);
    const mat = new THREE.MeshStandardMaterial({ color: 0x3f6f8a, roughness: 0.15, metalness: 0.3, ...layer(2) });
    if (w.pos.length) group.add(flatMesh(w, mat));
  }

  // 步道（淺色窄帶）
  {
    const w = new FlatWriter(4);
    for (const r of surfaceFootways) w.ribbon(r.pts, r.hw, Y_FOOT);
    const mat = new THREE.MeshStandardMaterial({ color: 0xd9d3c5, roughness: 0.95, ...layer(3) });
    if (w.pos.length) group.add(flatMesh(w, mat));
  }

  // 車道路面（依類型給不同深淺的柏油色，全部合併成一個幾何）
  {
    const w = new FlatWriter(8);
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
    group.add(flatMesh(w, mat));
  }

  // 標線（主要道路：中線 / 車道線 / 邊線；路口範圍內中斷）
  {
    const yellow = new FlatWriter();
    const white = new FlatWriter();
    for (const r of surfaceRoads) if (MAJOR_TYPES.has(r.type)) addMarkings(yellow, white, r);
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

  return {
    group,
    stats: { labels: labelCount, streetTrees, parkTrees: trees.length - streetTrees, lamps: lamps.length },
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
    p.set(t.x, 0, t.z);
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
    q.identity();
    p.set(l.x, 0, l.z);
    m.compose(p, q, one);
    poles.setMatrixAt(i, m);
    // 燈頭長邊（本地 +Z）朝道路中心
    q.setFromAxisAngle(up, Math.atan2(l.dirX, l.dirZ));
    p.set(l.x + l.dirX * 1.0, 7, l.z + l.dirZ * 1.0);
    m.compose(p, q, one);
    heads.setMatrixAt(i, m);
  });
  poles.instanceMatrix.needsUpdate = true;
  heads.instanceMatrix.needsUpdate = true;
  poles.castShadow = true;
  return { poles, heads };
}
