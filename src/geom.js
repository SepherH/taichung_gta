// 平面幾何小工具（純 JS，不依賴 three）：多邊形 / 折線以扁平陣列 [x0, z0, x1, z1, …] 表示
// 座標系：x 向東、z 向南。OSM 輪廓已統一為「北方朝上看」的逆時針，
// 換到 (x, z) 平面計算時有號面積為負。

// (x, z) 平面的有號面積（標準鞋帶公式）
export function signedArea(p) {
  let a = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
  }
  return a / 2;
}

export function polygonArea(p) {
  return Math.abs(signedArea(p));
}

// 面積重心
export function polygonCentroid(p) {
  const n = p.length / 2;
  let a = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x1 = p[i * 2];
    const z1 = p[i * 2 + 1];
    const x2 = p[j * 2];
    const z2 = p[j * 2 + 1];
    const f = x1 * z2 - x2 * z1;
    a += f;
    cx += (x1 + x2) * f;
    cz += (z1 + z2) * f;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0;
    let sz = 0;
    for (let i = 0; i < n; i++) {
      sx += p[i * 2];
      sz += p[i * 2 + 1];
    }
    return { x: sx / n, z: sz / n };
  }
  return { x: cx / (3 * a), z: cz / (3 * a) };
}

export function polygonBBox(p) {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    if (p[i] < x0) x0 = p[i];
    if (p[i] > x1) x1 = p[i];
    if (p[i + 1] < z0) z0 = p[i + 1];
    if (p[i + 1] > z1) z1 = p[i + 1];
  }
  return { x0, z0, x1, z1 };
}

// 射線法：點是否在多邊形內
export function pointInPolygon(x, z, p) {
  let inside = false;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2];
    const zi = p[i * 2 + 1];
    const xj = p[j * 2];
    const zj = p[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// 點到線段的最近點；回傳寫進 out = { x, z, d2, t }
export function closestOnSegment(px, pz, ax, az, bx, bz, out) {
  const dx = bx - ax;
  const dz = bz - az;
  const L2 = dx * dx + dz * dz;
  let t = L2 > 1e-12 ? ((px - ax) * dx + (pz - az) * dz) / L2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + dx * t;
  const cz = az + dz * t;
  out.x = cx;
  out.z = cz;
  out.t = t;
  out.d2 = (px - cx) * (px - cx) + (pz - cz) * (pz - cz);
  return out;
}

// 點到多邊形邊界的最近點；回傳 { x, z, d2, edge }
const _seg = { x: 0, z: 0, d2: 0, t: 0 };
export function closestOnPolygon(px, pz, p, out = {}) {
  const n = p.length / 2;
  out.d2 = Infinity;
  out.edge = -1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    closestOnSegment(px, pz, p[i * 2], p[i * 2 + 1], p[j * 2], p[j * 2 + 1], _seg);
    if (_seg.d2 < out.d2) {
      out.d2 = _seg.d2;
      out.x = _seg.x;
      out.z = _seg.z;
      out.edge = i;
    }
  }
  return out;
}

// 點到多邊形的距離（在內部回傳 0）
export function distanceToPolygon(x, z, p) {
  if (pointInPolygon(x, z, p)) return 0;
  return Math.sqrt(closestOnPolygon(x, z, p).d2);
}

// 耳切法三角化（簡單多邊形，無洞），回傳頂點索引陣列（每 3 個一組）。
// 輸出三角形在 (x, z) 平面上與輸入同方向；遇到自交等退化情況時剩餘部分改用扇形補齊，保證不漏面。
export function triangulate(p) {
  const n = p.length / 2;
  if (n < 3) return [];
  const idx = [];
  for (let i = 0; i < n; i++) idx.push(i);
  const orient = signedArea(p) >= 0 ? 1 : -1;
  const X = (i) => p[i * 2];
  const Z = (i) => p[i * 2 + 1];
  const cross = (a, b, c) => (X(b) - X(a)) * (Z(c) - Z(a)) - (Z(b) - Z(a)) * (X(c) - X(a));
  const inTri = (a, b, c, q) => {
    const c1 = cross(a, b, q) * orient;
    const c2 = cross(b, c, q) * orient;
    const c3 = cross(c, a, q) * orient;
    return c1 >= -1e-9 && c2 >= -1e-9 && c3 >= -1e-9;
  };
  const tris = [];
  let guard = 0;
  while (idx.length > 3 && guard < n * n) {
    guard++;
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const a = idx[(k + idx.length - 1) % idx.length];
      const b = idx[k];
      const c = idx[(k + 1) % idx.length];
      const cr = cross(a, b, c) * orient;
      if (cr <= 1e-9) continue; // 凹角或共線
      let ear = true;
      for (const q of idx) {
        if (q === a || q === b || q === c) continue;
        if (inTri(a, b, c, q)) {
          ear = false;
          break;
        }
      }
      if (!ear) continue;
      tris.push(a, b, c);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // 先移除共線點再試；還是不行就扇形補齊
      let removed = false;
      for (let k = 0; k < idx.length; k++) {
        const a = idx[(k + idx.length - 1) % idx.length];
        const b = idx[k];
        const c = idx[(k + 1) % idx.length];
        if (Math.abs(cross(a, b, c)) <= 1e-9) {
          idx.splice(k, 1);
          removed = true;
          break;
        }
      }
      if (!removed) {
        for (let k = 1; k < idx.length - 1; k++) tris.push(idx[0], idx[k], idx[k + 1]);
        return tris;
      }
    }
  }
  if (idx.length === 3) tris.push(idx[0], idx[1], idx[2]);
  return tris;
}

// 折線（扁平陣列）轉 [{x, z}] 並計算累積長度
export function polylineInfo(flat) {
  const pts = [];
  for (let i = 0; i < flat.length; i += 2) pts.push({ x: flat[i], z: flat[i + 1] });
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  return { pts, cum, length: cum[cum.length - 1] };
}

// 在折線上依距離 s 取點；回傳 out = { x, z, dx, dz, seg }（dx/dz 為前進方向單位向量）
export function samplePolyline(info, s, out) {
  const { pts, cum, length } = info;
  if (s <= 0) s = 0;
  if (s >= length) s = length;
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const a = pts[lo];
  const b = pts[Math.min(lo + 1, pts.length - 1)];
  const L = cum[Math.min(lo + 1, cum.length - 1)] - cum[lo];
  const t = L > 1e-9 ? (s - cum[lo]) / L : 0;
  out.x = a.x + (b.x - a.x) * t;
  out.z = a.z + (b.z - a.z) * t;
  out.dx = L > 1e-9 ? (b.x - a.x) / L : 1;
  out.dz = L > 1e-9 ? (b.z - a.z) / L : 0;
  out.seg = lo;
  return out;
}

// 通用空間網格：以軸對齊範圍登記物件，查詢時不重複
export class SpatialGrid {
  constructor(cellSize = 25) {
    this.cellSize = cellSize;
    this.map = new Map();
    this.stamp = 0;
    this.tag = Symbol('grid'); // 每個網格各自的去重標記，同一物件可登記在多個網格
  }

  _key(ix, iz) {
    return (ix + 32768) * 65536 + (iz + 32768);
  }

  insert(item, x0, z0, x1, z1) {
    const cs = this.cellSize;
    item[this.tag] = 0;
    for (let ix = Math.floor(x0 / cs); ix <= Math.floor(x1 / cs); ix++) {
      for (let iz = Math.floor(z0 / cs); iz <= Math.floor(z1 / cs); iz++) {
        const k = this._key(ix, iz);
        let list = this.map.get(k);
        if (!list) {
          list = [];
          this.map.set(k, list);
        }
        list.push(item);
      }
    }
  }

  query(x0, z0, x1, z1, out = []) {
    out.length = 0;
    const s = ++this.stamp;
    const cs = this.cellSize;
    for (let ix = Math.floor(x0 / cs); ix <= Math.floor(x1 / cs); ix++) {
      for (let iz = Math.floor(z0 / cs); iz <= Math.floor(z1 / cs); iz++) {
        const list = this.map.get(this._key(ix, iz));
        if (!list) continue;
        for (const it of list) {
          if (it[this.tag] === s) continue;
          it[this.tag] = s;
          out.push(it);
        }
      }
    }
    return out;
  }
}
