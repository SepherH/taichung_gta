// 世界：地面、秋紅谷地形、道路、人行道、路口、斑馬線、路名地面字、行道樹、路燈
import * as THREE from 'three';
import { BOUNDS, SIDEWALK, ROADS_EW, ROADS_NS, LANDMARKS, QIUHONG_BOWL } from './data/city.js';
import { makeCanvas, makeTextTexture, mulberry32, smoothstep, pointInRect } from './utils.js';
import { registerNight } from './daynight.js';

// 各圖層高度（拉開間距避免 z-fighting）
const Y_SIDEWALK = 0.06;
const Y_ROAD = 0.1;
const Y_INTERSECTION = 0.14;
const Y_MARK = 0.18;
const Y_LABEL = 0.2;

// ---------- 道路資料正規化 ----------
// axis：'x' 表示道路沿 X 延伸（東西向），'z' 表示沿 Z 延伸（南北向）
// c：道路中心線座標（東西向為 z，南北向為 x）；hw：半路寬
export const ROADS = [];
for (const r of ROADS_EW) {
  ROADS.push({ ...r, axis: 'x', c: r.z, hw: r.width / 2, from: r.from ?? BOUNDS.minX, to: r.to ?? BOUNDS.maxX, median: r.median || 0 });
}
for (const r of ROADS_NS) {
  ROADS.push({ ...r, axis: 'z', c: r.x, hw: r.width / 2, from: r.from ?? BOUNDS.minZ, to: r.to ?? BOUNDS.maxZ, median: r.median || 0 });
}
export const EW_ROADS = ROADS.filter((r) => r.axis === 'x').sort((a, b) => a.c - b.c);
export const NS_ROADS = ROADS.filter((r) => r.axis === 'z').sort((a, b) => a.c - b.c);

export function roadById(id) {
  return ROADS.find((r) => r.id === id) || null;
}

// 道路在沿線座標 t 處是否存在
export function roadPresentAt(road, t) {
  return t >= road.from - 0.01 && t <= road.to + 0.01;
}

// 道路是否完整覆蓋沿線區間 [a, b]
function roadCovers(road, a, b) {
  return road.from <= a + 0.01 && road.to >= b - 0.01;
}

// ---------- 地形高度 ----------
// 除了秋紅谷的下凹地形外，地面高度都是 0
export function heightAt(x, z) {
  const b = QIUHONG_BOWL;
  if (x <= b.x0 || x >= b.x1 || z <= b.z0 || z >= b.z1) return 0;
  const d = Math.min(x - b.x0, b.x1 - x, z - b.z0, b.z1 - z);
  let h = -b.depth * smoothstep(0, b.slope, d);
  const px = (x - b.pondX) / b.pondRX;
  const pz = (z - b.pondZ) / b.pondRZ;
  const e = px * px + pz * pz;
  if (e < 1) h -= b.pondDepth * smoothstep(1, 0.5, e);
  return h;
}

// ---------- 街廓 ----------
// 以所有道路中心線切出格子；lot 為可蓋建築的範圍，ring 為人行道中線（行人巡迴用）
export function computeCells() {
  const xs = [{ c: BOUNDS.minX, road: null }, ...NS_ROADS.map((r) => ({ c: r.c, road: r })), { c: BOUNDS.maxX, road: null }];
  const zs = [{ c: BOUNDS.minZ, road: null }, ...EW_ROADS.map((r) => ({ c: r.c, road: r })), { c: BOUNDS.maxZ, road: null }];
  const cells = [];
  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = 0; j < zs.length - 1; j++) {
      const W = xs[i];
      const E = xs[i + 1];
      const N = zs[j];
      const S = zs[j + 1];
      const x0 = W.c;
      const x1 = E.c;
      const z0 = N.c;
      const z1 = S.c;
      // 邊線的內縮量：地圖邊緣 3m；道路存在時 = 半路寬 + 人行道 + 3m；道路不存在（綠帶）8m
      const present = (line, a, b) => !!line.road && roadCovers(line.road, a, b);
      const margin = (line, a, b) => (!line.road ? 3 : present(line, a, b) ? line.road.hw + SIDEWALK + 3 : 8);
      const ringOff = (line, a, b) => (present(line, a, b) ? line.road.hw + SIDEWALK / 2 : 6);
      const allPresent = present(W, z0, z1) && present(E, z0, z1) && present(N, x0, x1) && present(S, x0, x1);
      cells.push({
        x0, x1, z0, z1,
        lot: {
          x0: x0 + margin(W, z0, z1),
          x1: x1 - margin(E, z0, z1),
          z0: z0 + margin(N, x0, x1),
          z1: z1 - margin(S, x0, x1),
        },
        ring: {
          x0: x0 + ringOff(W, z0, z1),
          x1: x1 - ringOff(E, z0, z1),
          z0: z0 + ringOff(N, x0, x1),
          z1: z1 - ringOff(S, x0, x1),
        },
        interior: allPresent,
      });
    }
  }
  return cells;
}

// ---------- 位置描述（HUD 用） ----------
export function landmarkAt(x, z) {
  for (const lm of LANDMARKS) {
    if (pointInRect(x, z, lm.zone)) {
      // 地標街廓內但仍在道路 / 人行道上時，以道路為準
      if (roadsAt(x, z).length === 0) return lm;
    }
  }
  return null;
}

function roadsAt(x, z) {
  const out = [];
  for (const r of ROADS) {
    const along = r.axis === 'x' ? x : z;
    const perp = r.axis === 'x' ? z : x;
    if (roadPresentAt(r, along) && Math.abs(perp - r.c) <= r.hw + SIDEWALK) out.push(r);
  }
  return out;
}

export function describeLocation(x, z) {
  const lm = landmarkAt(x, z);
  if (lm) return { text: lm.name, landmark: lm };
  const on = roadsAt(x, z);
  if (on.length >= 2) return { text: `${on[0].name} / ${on[1].name} 路口`, landmark: null };
  if (on.length === 1) return { text: on[0].name, landmark: null };
  // 不在路上：找最近的東西向與南北向道路
  let bestEW = null;
  let bestNS = null;
  let dEW = Infinity;
  let dNS = Infinity;
  for (const r of EW_ROADS) {
    const d = Math.abs(z - r.c);
    if (roadPresentAt(r, x) && d < dEW) { dEW = d; bestEW = r; }
  }
  for (const r of NS_ROADS) {
    const d = Math.abs(x - r.c);
    if (roadPresentAt(r, z) && d < dNS) { dNS = d; bestNS = r; }
  }
  const parts = [];
  if (bestEW) parts.push(bestEW.name);
  if (bestNS) parts.push(bestNS.name);
  return { text: parts.length ? `近 ${parts.join(' · ')}` : '七期', landmark: null };
}

// ---------- 貼圖 ----------
// 道路貼圖：沿路方向 256px = 12m（重複），橫向 512px = 全路寬
function makeRoadTexture(road, anisotropy) {
  const W = 256;
  const H = 512;
  const canvas = makeCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#3b3c40';
  ctx.fillRect(0, 0, W, H);
  // 柏油雜點
  const rng = mulberry32(road.c * 7 + 13);
  for (let i = 0; i < 1400; i++) {
    const g = 50 + Math.floor(rng() * 30);
    ctx.fillStyle = `rgb(${g},${g},${g + 4})`;
    ctx.fillRect(rng() * W, rng() * H, 2, 2);
  }
  const pxPerM = H / road.width;
  // 橫向偏移（-hw..hw）轉為畫布 y
  const yOf = (off) => H / 2 + off * pxPerM;
  const lineW = Math.max(2, 0.15 * pxPerM);
  const medianHalf = road.median / 2;
  if (road.median) {
    // 中央分隔島（綠色植栽帶 + 淺色緣石）
    ctx.fillStyle = '#c9c6bd';
    ctx.fillRect(0, yOf(-medianHalf), W, medianHalf * 2 * pxPerM);
    ctx.fillStyle = '#4f7a3f';
    ctx.fillRect(0, yOf(-medianHalf + 0.3), W, (medianHalf - 0.3) * 2 * pxPerM);
  } else {
    // 雙黃線
    ctx.fillStyle = '#e8c020';
    ctx.fillRect(0, yOf(-0.25) - lineW / 2, W, lineW);
    ctx.fillRect(0, yOf(0.25) - lineW / 2, W, lineW);
  }
  // 路邊停車帶的白色邊線（距路緣 2.5m）
  const edge = road.hw - 2.5;
  ctx.fillStyle = '#e8e8e8';
  ctx.fillRect(0, yOf(-edge) - lineW / 2, W, lineW);
  ctx.fillRect(0, yOf(edge) - lineW / 2, W, lineW);
  // 車道虛線（每 12m 畫 4m）
  const laneW = (edge - medianHalf) / road.lanes;
  for (let k = 1; k < road.lanes; k++) {
    const off = medianHalf + laneW * k;
    for (const s of [-1, 1]) {
      ctx.fillRect(0, yOf(s * off) - lineW / 2, W * (4 / 12), lineW);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = anisotropy;
  return tex;
}

// 人行道地磚貼圖（一格 = 2m × 2m）
function makeSidewalkTexture(anisotropy) {
  const canvas = makeCanvas(128, 128);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#b9b3a8';
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = '#a59e92';
  for (let i = 0; i < 4; i++) {
    ctx.fillRect(i * 32, 0, 2, 128);
    ctx.fillRect(0, i * 32, 128, 2);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = anisotropy;
  return tex;
}

// 草地貼圖
function makeGrassTexture(anisotropy) {
  const canvas = makeCanvas(256, 256);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#6f8f55';
  ctx.fillRect(0, 0, 256, 256);
  const rng = mulberry32(99);
  for (let i = 0; i < 2500; i++) {
    const g = rng();
    ctx.fillStyle = g < 0.5 ? '#668650' : '#789a5d';
    ctx.fillRect(rng() * 256, rng() * 256, 3, 3);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = anisotropy;
  return tex;
}

// 將平面幾何 UV 放大（配合 RepeatWrapping）
function scaleUV(geo, su, sv) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  }
  uv.needsUpdate = true;
}

// 建立水平矩形平面（x0..x1, z0..z1）
function flatRect(x0, z0, x1, z1, y, material, uvScale = null) {
  const w = x1 - x0;
  const d = z1 - z0;
  const geo = new THREE.PlaneGeometry(w, d);
  geo.rotateX(-Math.PI / 2);
  if (uvScale) scaleUV(geo, w / uvScale, d / uvScale);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
  mesh.receiveShadow = true;
  return mesh;
}

// 沿道路方向的長條平面：along 起訖、垂直方向中心 perpC、寬度 width
function roadStrip(road, from, to, perpC, width, y, material) {
  const len = to - from;
  const mid = (from + to) / 2;
  const geo = new THREE.PlaneGeometry(len, width);
  geo.rotateX(-Math.PI / 2);
  if (road.axis === 'z') geo.rotateY(Math.PI / 2);
  const mesh = new THREE.Mesh(geo, material);
  if (road.axis === 'x') mesh.position.set(mid, y, perpC);
  else mesh.position.set(perpC, y, mid);
  mesh.receiveShadow = true;
  return { mesh, geo, len };
}

// 沿線座標 t 是否靠近與其交叉的道路（路口）
function nearCrossing(road, t, pad) {
  const others = road.axis === 'x' ? NS_ROADS : EW_ROADS;
  for (const q of others) {
    if (!roadPresentAt(q, road.c)) continue;
    if (Math.abs(t - q.c) < q.hw + pad) return true;
  }
  return false;
}

// ---------- 建構世界 ----------
export function buildWorld(scene, { anisotropy = 4 } = {}) {
  const group = new THREE.Group();
  group.name = 'world';
  scene.add(group);

  // 地面：秋紅谷範圍挖空，另外用可變形網格做下凹地形
  const grassTex = makeGrassTexture(anisotropy);
  const grassMat = new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1 });
  const b = QIUHONG_BOWL;
  const E = 1600;
  group.add(flatRect(-E, -E, E, b.z0, 0, grassMat, 8));
  group.add(flatRect(-E, b.z1, E, E, 0, grassMat, 8));
  group.add(flatRect(-E, b.z0, b.x0, b.z1, 0, grassMat, 8));
  group.add(flatRect(b.x1, b.z0, E, b.z1, 0, grassMat, 8));

  // 秋紅谷下凹地形
  {
    const w = b.x1 - b.x0;
    const d = b.z1 - b.z0;
    const segW = Math.ceil(w / 1.5);
    const segD = Math.ceil(d / 1.5);
    const geo = new THREE.PlaneGeometry(w, d, segW, segD);
    geo.rotateX(-Math.PI / 2);
    const cx = (b.x0 + b.x1) / 2;
    const cz = (b.z0 + b.z1) / 2;
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + cx;
      const z = pos.getZ(i) + cz;
      pos.setY(i, heightAt(x, z));
    }
    pos.needsUpdate = true;
    scaleUV(geo, w / 8, d / 8);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, grassMat);
    mesh.position.set(cx, 0, cz);
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // 道路
  const sidewalkTex = makeSidewalkTexture(anisotropy);
  const sidewalkMat = new THREE.MeshStandardMaterial({ map: sidewalkTex, roughness: 0.95 });
  const asphaltMat = new THREE.MeshStandardMaterial({ color: 0x3b3c40, roughness: 0.95 });
  for (const r of ROADS) {
    const tex = makeRoadTexture(r, anisotropy);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 });
    const { mesh, len } = roadStrip(r, r.from, r.to, r.c, r.width, Y_ROAD, mat);
    tex.repeat.set(len / 12, 1);
    group.add(mesh);
    // 兩側人行道
    for (const s of [-1, 1]) {
      const sw = roadStrip(r, r.from, r.to, r.c + s * (r.hw + SIDEWALK / 2), SIDEWALK, Y_SIDEWALK, sidewalkMat);
      scaleUV(sw.geo, sw.len / 2, SIDEWALK / 2);
      group.add(sw.mesh);
    }
  }

  // 路口（純柏油方塊蓋住標線）與斑馬線
  const stripes = [];
  for (const e of EW_ROADS) {
    for (const n of NS_ROADS) {
      if (!roadPresentAt(e, n.c) || !roadPresentAt(n, e.c)) continue;
      group.add(flatRect(n.c - n.hw, e.c - e.hw, n.c + n.hw, e.c + e.hw, Y_INTERSECTION, asphaltMat));
      // 南北向道路上的斑馬線（北、南兩側）
      const nsArms = [];
      if (n.from < e.c - 1) nsArms.push(-1);
      if (n.to > e.c + 1) nsArms.push(1);
      for (const s of nsArms) {
        const zc = e.c + s * (e.hw + 2);
        for (let x = n.c - n.hw + 1; x <= n.c + n.hw - 1; x += 1.2) {
          if (n.median && Math.abs(x - n.c) < n.median / 2) continue;
          stripes.push({ x, z: zc, sx: 0.6, sz: 3 });
        }
      }
      // 東西向道路上的斑馬線（西、東兩側）
      const ewArms = [];
      if (e.from < n.c - 1) ewArms.push(-1);
      if (e.to > n.c + 1) ewArms.push(1);
      for (const s of ewArms) {
        const xc = n.c + s * (n.hw + 2);
        for (let z = e.c - e.hw + 1; z <= e.c + e.hw - 1; z += 1.2) {
          if (e.median && Math.abs(z - e.c) < e.median / 2) continue;
          stripes.push({ x: xc, z, sx: 3, sz: 0.6 });
        }
      }
    }
  }
  {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.8 });
    const inst = new THREE.InstancedMesh(geo, mat, stripes.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    stripes.forEach((st, i) => {
      p.set(st.x, Y_MARK, st.z);
      s.set(st.sx, 1, st.sz);
      m.compose(p, q, s);
      inst.setMatrixAt(i, m);
    });
    inst.instanceMatrix.needsUpdate = true;
    inst.receiveShadow = true;
    group.add(inst);
  }

  // 路名地面字（每段街廓中間一個）
  for (const r of ROADS) {
    const tex = makeTextTexture(r.name, { width: 512, height: 128, color: 'rgba(255,255,255,0.9)' });
    tex.anisotropy = anisotropy;
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      roughness: 0.9,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    const others = (r.axis === 'x' ? NS_ROADS : EW_ROADS).filter((q) => roadPresentAt(q, r.c)).map((q) => q.c);
    const stops = [r.from, ...others.filter((c) => c > r.from && c < r.to), r.to].sort((a, b2) => a - b2);
    const labelOff = r.median ? r.median / 2 + (r.hw - r.median / 2) / 2 : r.hw * 0.45;
    for (let i = 0; i < stops.length - 1; i++) {
      if (stops[i + 1] - stops[i] < 45) continue;
      const t = (stops[i] + stops[i + 1]) / 2;
      const geo = new THREE.PlaneGeometry(14, 3.5);
      geo.rotateX(-Math.PI / 2);
      if (r.axis === 'z') geo.rotateY(Math.PI / 2);
      const mesh = new THREE.Mesh(geo, mat);
      if (r.axis === 'x') mesh.position.set(t, Y_LABEL, r.c + labelOff);
      else mesh.position.set(r.c + labelOff, Y_LABEL, t);
      group.add(mesh);
    }
  }

  // 行道樹與路燈（InstancedMesh）
  const trees = [];
  const lamps = [];
  const rng = mulberry32(4242);
  for (const r of ROADS) {
    for (const s of [-1, 1]) {
      for (let t = r.from + 7; t < r.to - 3; t += 14) {
        if (nearCrossing(r, t, SIDEWALK + 2)) continue;
        const off = r.c + s * (r.hw + 1.6);
        const x = r.axis === 'x' ? t : off;
        const z = r.axis === 'x' ? off : t;
        trees.push({ x, z, scale: 0.8 + rng() * 0.45, hue: rng() });
      }
      for (let t = r.from + 14; t < r.to - 3; t += 28) {
        if (nearCrossing(r, t, SIDEWALK + 2)) continue;
        const off = r.c + s * (r.hw + 0.5);
        const x = r.axis === 'x' ? t : off;
        const z = r.axis === 'x' ? off : t;
        // 燈頭朝道路中心伸出
        const hx = r.axis === 'x' ? x : x - s * 1.0;
        const hz = r.axis === 'x' ? z - s * 1.0 : z;
        lamps.push({ x, z, hx, hz, alongX: r.axis === 'x' });
      }
    }
  }
  // 秋紅谷內也種一些樹
  for (let i = 0; i < 28; i++) {
    const x = b.x0 + 4 + rng() * (b.x1 - b.x0 - 8);
    const z = b.z0 + 4 + rng() * (b.z1 - b.z0 - 8);
    const px = (x - b.pondX) / b.pondRX;
    const pz = (z - b.pondZ) / b.pondRZ;
    if (px * px + pz * pz < 1.4) continue;
    trees.push({ x, z, scale: 0.9 + rng() * 0.5, hue: rng(), y: heightAt(x, z) });
  }

  const treeResult = buildTrees(trees);
  group.add(treeResult.trunks, treeResult.crowns);
  const lampResult = buildLamps(lamps);
  group.add(lampResult.poles, lampResult.heads);

  return { group, cells: computeCells() };
}

function buildTrees(trees) {
  const trunkGeo = new THREE.CylinderGeometry(0.14, 0.2, 2.6, 5);
  trunkGeo.translate(0, 1.3, 0);
  const crownGeo = new THREE.IcosahedronGeometry(1.7, 0);
  crownGeo.translate(0, 3.7, 0);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a32, roughness: 1 });
  const crownMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true });
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);
  const crowns = new THREE.InstancedMesh(crownGeo, crownMat, trees.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const c = new THREE.Color();
  const greens = [new THREE.Color(0x3f7a38), new THREE.Color(0x4f8a3c), new THREE.Color(0x356b3a)];
  trees.forEach((t, i) => {
    p.set(t.x, t.y || 0, t.z);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.hue * Math.PI * 2);
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
  const poles = new THREE.InstancedMesh(poleGeo, poleMat, lamps.length);
  const heads = new THREE.InstancedMesh(headGeo, headMat, lamps.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const qTurn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  const p = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  lamps.forEach((l, i) => {
    p.set(l.x, 0, l.z);
    m.compose(p, q, one);
    poles.setMatrixAt(i, m);
    // 燈頭長邊沿 Z；東西向道路的燈頭要朝 Z 伸出（預設即可），南北向道路要轉 90 度
    p.set((l.x + l.hx) / 2, 7, (l.z + l.hz) / 2);
    m.compose(p, l.alongX ? q : qTurn, one);
    heads.setMatrixAt(i, m);
  });
  poles.instanceMatrix.needsUpdate = true;
  heads.instanceMatrix.needsUpdate = true;
  poles.castShadow = true;
  return { poles, heads };
}
