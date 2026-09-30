// 凹多邊形凸分解（建築凸柱、湖面阻擋柱、walkable 三角化共用）：純數學，不依賴 three / rapier
// 流程：清理輸入（重複點、共線點、極小面積）→ 耳切三角化 → Hertel–Mehlhorn 合併相鄰三角形成凸多邊形
// Hertel–Mehlhorn 保證凸塊數 ≤ 最佳解的 4 倍；不使用整體凸包（凸包會把騎樓 / 中庭等凹口封死）
// 多邊形一律為扁平陣列 [x0, z0, x1, z1, …]；輸出統一轉為 (x, z) 平面有號面積為正的方向
// （OSM 輪廓「北方朝上看逆時針」在 (x, z) 平面有號面積為負，見 geom.js，這裡會自動反轉）

const DUP_EPS = 1e-4; // 兩點距離小於此值視為重複點（m）
const COLLINEAR_EPS = 1e-6; // 三點構成的有號面積 ×2 小於此值（相對邊長平方）視為共線
const MIN_AREA = 1e-3; // 面積小於此值的多邊形 / 凸塊丟棄（m²）
const CONVEX_EPS = 1e-9; // 合併後凸性判定的容許誤差

function cross(ax, az, bx, bz, cx, cz) {
  return (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
}

export function signedAreaFlat(p) {
  let a = 0;
  const n = p.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
  }
  return a / 2;
}

// 清理：去除重複點（含首尾相同）、共線點；回傳有號面積為正的扁平陣列（退化時回傳 null）
export function cleanPolygon(flat) {
  let pts = [];
  for (let i = 0; i + 1 < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
  let changed = true;
  while (changed && pts.length >= 3) {
    changed = false;
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = out.length ? out[out.length - 1] : pts[pts.length - 1];
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) < DUP_EPS) {
        changed = true;
        continue;
      }
      out.push(p);
    }
    pts = out;
    if (pts.length < 3) break;
    const keep = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = keep.length ? keep[keep.length - 1] : pts[(i - 1 + n) % n];
      const b = pts[i];
      const c = pts[(i + 1) % n];
      const len2 = Math.max((c[0] - a[0]) ** 2 + (c[1] - a[1]) ** 2, 1e-12);
      if (Math.abs(cross(a[0], a[1], b[0], b[1], c[0], c[1])) <= COLLINEAR_EPS * len2) {
        changed = true;
        continue;
      }
      keep.push(b);
    }
    pts = keep;
  }
  if (pts.length < 3) return null;
  const res = [];
  for (const p of pts) res.push(p[0], p[1]);
  const a = signedAreaFlat(res);
  if (Math.abs(a) < MIN_AREA) return null;
  if (a < 0) return reverseFlat(res);
  return res;
}

function reverseFlat(p) {
  const out = [];
  for (let i = p.length - 2; i >= 0; i -= 2) out.push(p[i], p[i + 1]);
  return out;
}

function pointInTri(px, pz, ax, az, bx, bz, cx, cz) {
  // 含邊界（≥ 0）：讓與耳尖重合的凹點也擋住該耳，避免產生重疊三角形
  return cross(ax, az, bx, bz, px, pz) >= 0 && cross(bx, bz, cx, cz, px, pz) >= 0 && cross(cx, cz, ax, az, px, pz) >= 0;
}

// 耳切三角化（輸入須已 cleanPolygon：有號面積為正、無重複 / 共線點）
// 回傳三角形頂點索引陣列 [[a, b, c], …]（索引指向輸入的第幾個點），每個三角形同為正向
export function triangulate(p) {
  const n = p.length >> 1;
  const idx = [];
  for (let i = 0; i < n; i++) idx.push(i);
  const tris = [];
  const X = (i) => p[i * 2];
  const Z = (i) => p[i * 2 + 1];
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    const m = idx.length;
    let clipped = false;
    for (let k = 0; k < m; k++) {
      const a = idx[(k - 1 + m) % m];
      const b = idx[k];
      const c = idx[(k + 1) % m];
      if (cross(X(a), Z(a), X(b), Z(b), X(c), Z(c)) <= 0) continue; // 凹角或退化，不是耳
      let blocked = false;
      for (let t = 0; t < m; t++) {
        const q = idx[t];
        if (q === a || q === b || q === c) continue;
        // 只有凹點可能落在耳內；與耳的頂點座標相同者（自接觸）也算擋住
        if (pointInTri(X(q), Z(q), X(a), Z(a), X(b), Z(b), X(c), Z(c))) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      tris.push([a, b, c]);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // 退化輸入（自交 / 數值誤差）找不到耳：切掉面積最大的凸角頂點，保證終止
      let best = -1;
      let bestA = -Infinity;
      for (let k = 0; k < m; k++) {
        const a = idx[(k - 1 + m) % m];
        const b = idx[k];
        const c = idx[(k + 1) % m];
        const ar = cross(X(a), Z(a), X(b), Z(b), X(c), Z(c));
        if (ar > bestA) {
          bestA = ar;
          best = k;
        }
      }
      const a = idx[(best - 1 + m) % m];
      const b = idx[best];
      const c = idx[(best + 1) % m];
      if (bestA > 0) tris.push([a, b, c]);
      idx.splice(best, 1);
    }
  }
  if (idx.length === 3 && cross(X(idx[0]), Z(idx[0]), X(idx[1]), Z(idx[1]), X(idx[2]), Z(idx[2])) > 0) tris.push(idx.slice());
  return tris;
}

// 索引多邊形在頂點 i 處是否凸（容許共線）
function convexAt(p, poly, i) {
  const m = poly.length;
  const a = poly[(i - 1 + m) % m];
  const b = poly[i];
  const c = poly[(i + 1) % m];
  return cross(p[a * 2], p[a * 2 + 1], p[b * 2], p[b * 2 + 1], p[c * 2], p[c * 2 + 1]) >= -CONVEX_EPS;
}

// Hertel–Mehlhorn：逐一檢查「內部對角線」（兩個凸塊共用、方向相反的邊），
// 移除後合併出的多邊形若在該對角線兩端點仍為凸角（其他頂點本來就凸）就合併，直到沒有可移除的對角線
function hertelMehlhorn(p, tris) {
  const polys = tris.map((t) => t.slice());
  let merged = true;
  while (merged) {
    merged = false;
    // 邊 (u → v) → 所屬凸塊
    const edgeOwner = new Map();
    for (let pi = 0; pi < polys.length; pi++) {
      const poly = polys[pi];
      if (!poly) continue;
      for (let i = 0; i < poly.length; i++) edgeOwner.set(poly[i] + ',' + poly[(i + 1) % poly.length], pi);
    }
    for (let pi = 0; pi < polys.length && !merged; pi++) {
      const P = polys[pi];
      if (!P) continue;
      for (let i = 0; i < P.length; i++) {
        const u = P[i];
        const v = P[(i + 1) % P.length];
        const qi = edgeOwner.get(v + ',' + u);
        if (qi === undefined || qi === pi || !polys[qi]) continue;
        const Q = polys[qi];
        // 合併：P 從 v 繞到 u，再接 Q 從 u 之後繞到 v 之前
        const out = [];
        const pv = (i + 1) % P.length;
        for (let k = 0; k < P.length; k++) out.push(P[(pv + k) % P.length]); // v … u
        const qu = Q.indexOf(u);
        for (let k = 1; k < Q.length - 1; k++) out.push(Q[(qu + k) % Q.length]); // u 之後 … v 之前
        const iu = P.length - 1; // out 內 u 的位置
        if (!convexAt(p, out, 0) || !convexAt(p, out, iu)) continue;
        polys[pi] = out;
        polys[qi] = null;
        merged = true;
        break;
      }
    }
  }
  return polys.filter(Boolean);
}

// 凸分解主函式：flatPoly = 扁平輪廓（任意方向）→ 凸多邊形扁平陣列的陣列（有號面積為正、無共線點）
export function convexDecompose(flatPoly) {
  const p = cleanPolygon(flatPoly);
  if (!p) return [];
  const tris = triangulate(p);
  const polys = hertelMehlhorn(p, tris);
  const out = [];
  for (const poly of polys) {
    const flat = [];
    for (const i of poly) flat.push(p[i * 2], p[i * 2 + 1]);
    const c = cleanPolygon(flat); // 合併後對角線端點可能共線 → 移除
    if (c) out.push(c);
  }
  return out;
}

// 凸多邊形判定：每個頂點外積同號（正向且嚴格凸）
export function isConvex(flat) {
  const n = flat.length >> 1;
  if (n < 3) return false;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n;
    const c = (i + 1) % n;
    const cr = cross(flat[a * 2], flat[a * 2 + 1], flat[i * 2], flat[i * 2 + 1], flat[c * 2], flat[c * 2 + 1]);
    const s = Math.sign(cr);
    if (s === 0) return false;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

// Sutherland–Hodgman：以直線 (ax, az)→(bx, bz) 裁切凸多邊形，keepLeft = 保留左側（cross ≥ 0）或右側
export function clipConvexByLine(flat, ax, az, bx, bz, keepLeft) {
  const n = flat.length >> 1;
  const out = [];
  const side = (x, z) => {
    const c = cross(ax, az, bx, bz, x, z);
    return keepLeft ? c : -c;
  };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const px = flat[i * 2];
    const pz = flat[i * 2 + 1];
    const qx = flat[j * 2];
    const qz = flat[j * 2 + 1];
    const sp = side(px, pz);
    const sq = side(qx, qz);
    if (sp >= 0) out.push(px, pz);
    if ((sp >= 0) !== (sq >= 0)) {
      const t = sp / (sp - sq);
      out.push(px + (qx - px) * t, pz + (qz - pz) * t);
    }
  }
  return out;
}

// 凸多邊形差集 P − C（C 亦為凸、正向）：依序沿 C 的每條邊切，
// 第 k 塊 = P ∩（邊 k 外側）∩（邊 0..k−1 內側）；各塊互不重疊且皆凸，C 內部整塊移除
export function subtractConvex(P, C) {
  const out = [];
  let rest = P;
  const n = C.length >> 1;
  for (let k = 0; k < n && rest.length >= 6; k++) {
    const j = (k + 1) % n;
    const ax = C[k * 2];
    const az = C[k * 2 + 1];
    const bx = C[j * 2];
    const bz = C[j * 2 + 1];
    const outside = cleanPolygon(clipConvexByLine(rest, ax, az, bx, bz, false));
    if (outside) out.push(outside);
    rest = clipConvexByLine(rest, ax, az, bx, bz, true);
  }
  return out;
}

// 凸多邊形（正向）每條邊往外平移 d 後重新求交點（外擴 d 公尺）
export function offsetConvex(flat, d) {
  const n = flat.length >> 1;
  const lines = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = flat[j * 2] - flat[i * 2];
    const ez = flat[j * 2 + 1] - flat[i * 2 + 1];
    const el = Math.hypot(ex, ez) || 1;
    // 正向多邊形的外法線 = (ez, −ex) / |e|
    const nx = ez / el;
    const nz = -ex / el;
    lines.push({ x: flat[i * 2] + nx * d, z: flat[i * 2 + 1] + nz * d, dx: ex, dz: ez });
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const L0 = lines[(i - 1 + n) % n];
    const L1 = lines[i];
    const den = L0.dx * L1.dz - L0.dz * L1.dx;
    if (Math.abs(den) < 1e-12) {
      out.push(L1.x, L1.z);
      continue;
    }
    const t = ((L1.x - L0.x) * L1.dz - (L1.z - L0.z) * L1.dx) / den;
    out.push(L0.x + L0.dx * t, L0.z + L0.dz * t);
  }
  return out;
}

// 長條凸塊切短：外框任一邊長 > maxSpan 就沿較長軸在中線切成兩塊（Sutherland–Hodgman 各取一側），遞迴到外框 ≤ maxSpan
// 切出的塊仍凸、互不重疊、聯集不變；太小的碎塊（cleanPolygon 判為退化）丟棄
export function splitConvexBySpan(flat, maxSpan) {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < flat.length; i += 2) {
    x0 = Math.min(x0, flat[i]);
    x1 = Math.max(x1, flat[i]);
    z0 = Math.min(z0, flat[i + 1]);
    z1 = Math.max(z1, flat[i + 1]);
  }
  const w = x1 - x0;
  const d = z1 - z0;
  if (Math.max(w, d) <= maxSpan) return [flat];
  // 切線：沿 x 切為 x = m（(m, 0)→(m, 1) 左側 = x ≤ m）；沿 z 切為 z = m（(1, m)→(0, m) 左側 = z ≤ m）
  const m = w >= d ? (x0 + x1) / 2 : (z0 + z1) / 2;
  const [ax, az, bx, bz] = w >= d ? [m, 0, m, 1] : [1, m, 0, m];
  const out = [];
  for (const keep of [true, false]) {
    const half = cleanPolygon(clipConvexByLine(flat, ax, az, bx, bz, keep));
    if (half) out.push(...splitConvexBySpan(half, maxSpan));
  }
  return out;
}
