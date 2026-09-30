// 地形：全區唯一高度來源（純數學，不依賴 three、不靜態 import JSON，node 可直接測）
// 由 osm-city.json 的 T（basins 秋紅谷 / plazas 老虎城下沉廣場）、R / F（道路 / 步道）、B（建築）、P / L（綠地分區）建立。
//
// 高度場：全區基準 y = 0（reference §6.5）；有地形變化處用「規則網格 patch」：
//   patch = { id, kind, x0, z0, cell, cols, rows, heights: Float32Array(cols * rows), kinds: Uint8Array((cols - 1) * (rows - 1)) }
//   節點 (c, r) 位於 (x0 + c * cell, z0 + r * cell)，heights[r * cols + c]（以 z 為列的列優先）；邊框一圈高度恰為 0。
//   kinds 為每格（以格中心判斷）的地表代碼，KIND_NAMES / SURFACE_OF 轉成查詢種類 / 渲染材質。
//   對角線慣例：每格切成兩個三角形，對角線連接 (c + 1, r) 與 (c, r + 1)（東北角 ↔ 西南角，x 東 / z 南）；
//     格內局部座標 tx + tz ≤ 1 屬三角形 (c, r) / (c, r + 1) / (c + 1, r)，否則屬 (c + 1, r) / (c, r + 1) / (c + 1, r + 1)。
//     heightAt / querySurface 以所在三角形平面內插、法線取該三角形的面法線，與 buildPatchMesh 的網格完全一致（物理 heightfield 轉換須用同一切分）。
//   patch 是唯一高度資料：heightAt / querySurface / buildPatchMesh / 物理 heightfield 全部由它取樣，不另算。
// 甲板端點落地平台 landings、湖邊木棧板帶 lakesides（固定高度平板，其下高度場集中壓平）、北端坡道 rampPaths（鋪面帶格 kind = 'ramp'）、
// 退台白色邊線 terracePaths / terraceLines（等高線平滑折線）也在建立時一併算出，渲染端只照畫。
// 可行走覆蓋面 walkables（跨湖紅橋甲板、Z 字湖上步道、下沉廣場大階梯斜面）：
//   { id, kind: 'bridge' | 'boardwalk' | 'stairs', poly: [x, z, …], bbox, plane: [a, b, c]（y = a x + b z + c）, heightAt(x, z) }
//   querySurface 取「高度場」與「footprint 含該點且高度 ≤ yHint + WALKABLE_STEP 的 walkable」兩者最高者。
// 所有地形數字（層高、坡寬、階梯、甲板）均屬推測，只是參數預設值，出處見各常數註解。
import { pointInPolygon, closestOnPolygon, closestOnSegment, polygonBBox, polygonCentroid, SpatialGrid } from './geom.js';

// ---------- 參數 ----------
const BASIN_CELL = 1.5; // 秋紅谷網格間距（m）：1 m 時約 22 萬 × 31 萬 m 範圍 > 10 萬三角形，依任務規則改用 1.5 m
const PLAZA_CELL = 0.5; // 下沉廣場網格間距（m）
const PATCH_MARGIN = 4; // patch 外框延伸到特徵外至少多少 m（此範圍內高度恆 0，與平地無縫）
const ROAD_CLEAR = 2; // 道路範圍外再多少 m 不受下凹影響（§6.4 人行道維持路面高）
const LAKE_SHORE = 1.5; // 湖岸由 walkway 過渡到湖床的水平距離（m，推測，依 reference §6.1 / §6.3）
const LAKE_WALKWAY = 3; // 湖邊步道帶寬（m，推測，依 reference §6.2「湖邊步道：灰色木棧板」）：此帶內的格 kind = walkway（高度平坦帶見 LAKE_FLAT）
const TERRACE_STEPS = 4; // 階梯式退台層數（推測，依 reference §6.3「白色邊線的多層平台」）
const TERRACE_RISER = 2; // 退台之間短陡坡的水平寬（m，推測，依 reference §6.3）
const RAMP_LINEAR = 0.5; // ramp 邊坡混入線性比例（0 = 同草坡 smoothstep，1 = 等坡）：最大坡度降為草坡的 5/6（推測，依 reference §6.2 北端弧形坡道）
const PLAZA_WALL = 0.3; // 下沉廣場邊緣矮牆的水平過渡（m，網格 0.5 m 下會成陡坡，渲染端另加立面）
const PLAZA_STAIR_RUN = 9; // 下沉廣場大階梯水平長（m，推測：4.5 m 深 ÷ 約 26.6° 階梯坡度，依 reference §1 / §6.5）
const BRIDGE_DECK_RISE = 0.2; // 紅橋甲板高出 walkway（m）：對齊紅橋 glb 甲板頂 −5.8（經理裁決以 glb 為準；walkway −6 本身為推測）
const BOARDWALK_DECK_RISE = 0.3; // Z 字湖上步道甲板高出 walkway（m，推測，依 reference §6.2「低矮平直的步橋」）
// 甲板端點落地平台（橋台，推測）：甲板端點在岸上時，端緣內外的高度場節點壓平到甲板高度，再平滑接回原地形
const LANDING_LEN = 2; // 端緣往岸上延伸（m）
const LANDING_BACK = 1.5; // 端緣往甲板下延伸（m，= 秋紅谷一格，讓端緣附近三角形全由平台節點組成）
const LANDING_SIDE = 0.5; // 岸上部分比甲板每側再寬（m）
const LANDING_BLEND = 2; // 平台外圍平滑過渡（m）
const LANDING_DROP = 0.03; // 平台比甲板面低（m）：甲板面與地形不共面（不閃爍），高差遠小於跨步高度
const LANDING_UNDER = 0.2; // 甲板正下方的平台比甲板面低（m，= qiuhonggu.js 甲板厚，推測）：貼地的步道 / 草地不會穿出甲板
// 湖邊木棧板（§6.2「灰色木棧板」）：固定高度平板，帶狀區高度場集中壓到平板面以下
const LAKESIDE_W = 2.5; // 棧板寬（m，推測；湖邊步道帶 LAKE_WALKWAY = 3 m 內）
const LAKESIDE_LIFT = 0.04; // 棧板面高出 walkway（m，分層偏移，低於 world.js 步道 0.07）
// 帶狀區壓平：湖岸外 LAKE_FLAT 內高度恆為 walkway（邊坡在此之外才開始爬升），
// 棧板外緣所在格的節點（最遠到外緣 + 一格對角）因此都不高於 walkway，棧板面比其下地形高 LAKESIDE_LIFT
const LAKE_FLAT = LAKESIDE_W + BASIN_CELL * Math.SQRT2;
const LAKESIDE_MIN_GAP = 0.02; // 棧板面須高出其下地形最高點至少（m），不足的分段略過
const LAKESIDE_STEP = 1; // 棧板沿湖岸分段長（m）
// 北端坡道鋪面（§6.2「長條白邊弧形坡道」；走向查無 → 推測為 ramp_start 兩端直線：往上到路面、往下到湖邊棧板外緣）
const RAMP_PAVE_HW = 1.5; // 坡道半寬（m，推測：寬約 3 m）
const RAMP_MARCH = 0.25; // 由 ramp_start 往坡頂找路面高的步長（m）
const RAMP_MARCH_MAX = 80; // 往坡頂最多找（m）
const TERRACE_SMOOTH = 2; // 退台白色邊線（等高線）Chaikin 平滑次數：去掉 1.5 m 網格的折角
const BUILDING_PAD = 0.5; // 建築水平平台外擴（m）
const BUILDING_BLEND = 2; // 建築平台外圍平滑過渡（m）
const EMBED_RANGE = 1; // 谷內建築輪廓頂點高差 > 此值（m）視為嵌入邊坡的量體（平台取最小值）
const FLAT_EPS = 0.01; // 建築輪廓內高差小於此值視為已平，不處理（避免把貼齊建築的下沉廣場牆邊抹平）
const WALKABLE_STEP = 0.6; // walkable 高於 yHint 多少以內仍可站上（m，跨步高度）
const TERRACE_LINE_DROP = 0.05; // 退台白色邊線取「平台高度再低多少」的等高線（m）

// 每格地表代碼
const K_GROUND = 0;
const K_GRASS = 1;
const K_TERRACE = 2;
const K_RISER = 3;
const K_RAMP = 4;
const K_LAKEBED = 5;
const K_WALKWAY = 6;
const K_PLAZA = 7;
const K_PLAZA_WALL = 8;
const K_STAIRS = 9;
const K_RAMP_PAVE = 10; // 北端坡道鋪面帶（rampPaths 半寬內的格）
// 代碼 → querySurface 的 kind
export const KIND_NAMES = ['ground', 'grass', 'terrace', 'terrace', 'ramp', 'lakebed', 'sidewalk', 'plaza', 'plaza', 'plaza', 'ramp'];
// 代碼 → 渲染材質（ground = 人行鋪面、grass = 草地、concrete = 淺灰混凝土 / 木棧板）
// 退台間陡坡（riser）與坡道鋪面帶畫成草地：1.5 m 格的邊界沿網格成鋸齒，白色邊線 / 坡道鋪面改由 world.js 依原始幾何另畫平滑帶狀面
export const SURFACES = ['ground', 'grass', 'concrete'];
export const SURFACE_OF = ['ground', 'grass', 'grass', 'grass', 'grass', 'grass', 'concrete', 'ground', 'concrete', 'concrete', 'grass'];
// 代碼 → 細分種類（cellKindAt 用：區分退台平台 / 退台間陡坡、廣場地面 / 矮牆 / 大階梯，供車輛判斷可否行駛）
export const CELL_KIND_NAMES = ['ground', 'grass', 'terrace', 'riser', 'ramp', 'lakebed', 'walkway', 'plaza', 'plaza_wall', 'stairs', 'ramp'];

// ---------- 小工具 ----------
function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

const _seg = { x: 0, z: 0, d2: 0, t: 0 };
const _cp = {};
function segDist(x, z, s) {
  closestOnSegment(x, z, s.ax, s.az, s.bx, s.bz, _seg);
  return Math.sqrt(_seg.d2);
}
function polyDist(x, z, p) {
  return Math.sqrt(closestOnPolygon(x, z, p, _cp).d2);
}

// 兩線段最短距離（相交為 0）
function segSegDist(ax, az, bx, bz, cx, cz, dx, dz) {
  const o = (px, pz, qx, qz, rx, rz) => (qx - px) * (rz - pz) - (qz - pz) * (rx - px);
  const d1 = o(ax, az, bx, bz, cx, cz);
  const d2 = o(ax, az, bx, bz, dx, dz);
  const d3 = o(cx, cz, dx, dz, ax, az);
  const d4 = o(cx, cz, dx, dz, bx, bz);
  if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
  return Math.sqrt(Math.min(
    closestOnSegment(ax, az, cx, cz, dx, dz, _seg).d2,
    closestOnSegment(bx, bz, cx, cz, dx, dz, _seg).d2,
    closestOnSegment(cx, cz, ax, az, bx, bz, _seg).d2,
    closestOnSegment(dx, dz, ax, az, bx, bz, _seg).d2,
  ));
}

// 折線（扁平陣列）與多邊形的最短距離（在內部或相交為 0）
function polylinePolyDist(line, poly) {
  for (let i = 0; i < line.length; i += 2) if (pointInPolygon(line[i], line[i + 1], poly)) return 0;
  let best = Infinity;
  const n = poly.length / 2;
  for (let i = 0; i + 3 < line.length; i += 2) {
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      best = Math.min(best, segSegDist(line[i], line[i + 1], line[i + 2], line[i + 3], poly[k * 2], poly[k * 2 + 1], poly[j * 2], poly[j * 2 + 1]));
    }
  }
  return best;
}

function bboxOverlap(a, b) {
  return a.x0 <= b.x1 && a.x1 >= b.x0 && a.z0 <= b.z1 && a.z1 >= b.z0;
}

// ---------- 邊坡剖面 ----------
// 回傳下降比例 f（0 = 路面高、1 = walkway 高）；d = 到邊界距離、w = 有效水平寬
const _prof = { f: 0, riser: false };
function profile(kind, d, w) {
  _prof.riser = false;
  if (w <= 1e-6 || d >= w) {
    _prof.f = 1;
    return _prof;
  }
  const t = d / w;
  if (kind === 'terrace') {
    // 階梯式退台：寬度平分為 TERRACE_STEPS 段，每段 = 平台 + 段尾短陡坡（段 0 平台與路面同高）
    const seg = w / TERRACE_STEPS;
    const R = Math.min(TERRACE_RISER, seg / 2);
    const k = Math.min(TERRACE_STEPS - 1, Math.floor(d / seg));
    const local = d - k * seg;
    _prof.f = (k + smoothstep(seg - R, seg, local)) / TERRACE_STEPS;
    _prof.riser = local > seg - R;
  } else if (kind === 'ramp') {
    _prof.f = RAMP_LINEAR * t + (1 - RAMP_LINEAR) * smoothstep(0, 1, t);
  } else {
    // grass_slope（資料若出現 flat 也以草坡處理，避免未定義的垂直落差）
    _prof.f = smoothstep(0, 1, t);
  }
  return _prof;
}

// ---------- 秋紅谷 ----------
// 下凹元素：外框各邊（距邊界 0 → 路面高）與「不下凹區」（exclude 多邊形、與谷地重疊的道路範圍 + ROAD_CLEAR）
function prepareBasin(b, roadSegs, stats) {
  const poly = b.p;
  const lv = b.levels;
  const edges = b.edges.map((e) => ({
    type: 'edge',
    ax: poly[e.a * 2], az: poly[e.a * 2 + 1], bx: poly[e.b * 2], bz: poly[e.b * 2 + 1],
    kind: e.kind, width: e.width, clear: 0,
  }));
  // 不下凹元素沿用最近外框邊的型態與寬度（停車場西南緣 = 東側 terrace，§6.4）
  const nearestEdge = (x, z) => {
    let best = edges[0];
    let bd = Infinity;
    for (const e of edges) {
      const d = segDist(x, z, e);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  };
  const elems = [...edges];
  for (const ex of b.exclude || []) {
    const c = polygonCentroid(ex);
    const ne = nearestEdge(c.x, c.z);
    elems.push({ type: 'poly', poly: ex, kind: ne.kind, width: ne.width });
  }
  const overlapped = new Set();
  for (const s of roadSegs) {
    const lim = s.road.hw + ROAD_CLEAR;
    if (polylinePolyDist([s.ax, s.az, s.bx, s.bz], poly) >= lim) continue;
    overlapped.add(s.road);
    const ne = nearestEdge((s.ax + s.bx) / 2, (s.az + s.bz) / 2);
    elems.push({ type: 'seg', ax: s.ax, az: s.az, bx: s.bx, bz: s.bz, clear: lim, kind: ne.kind, width: ne.width });
  }
  for (const r of overlapped) stats.roadOverlaps.push({ id: r.id, name: r.name, area: b.n || String(b.i) });
  return { src: b, poly, bbox: polygonBBox(poly), lake: b.lake || null, lv, elems };
}

// 秋紅谷某點的高度與地表代碼；寫進 out = { h, k }
// out.cut = true 表示該點在谷外或不下凹區內（fillPatch 用來找出被道路隔開、不與谷底相連的區塊）
function evalBasin(B, x, z, out) {
  out.h = 0;
  out.k = K_GROUND;
  out.cut = true;
  if (!pointInPolygon(x, z, B.poly)) return out;
  const { walkway, lakebed } = B.lv;
  let dLake = Infinity;
  if (B.lake) {
    dLake = polyDist(x, z, B.lake);
    if (pointInPolygon(x, z, B.lake)) {
      out.h = walkway + (lakebed - walkway) * smoothstep(0, LAKE_SHORE, dLake);
      out.k = K_LAKEBED;
      out.cut = false;
      return out;
    }
  }
  // 有效坡寬 = min(該邊 width, 到湖岸平坦帶 LAKE_FLAT 的距離)：坡在湖邊步道 / 棧板帶前一定降到 walkway（東側退台下接湖岸，§6.2）
  out.cut = false;
  const toWalk = Math.max(0, dLake - LAKE_FLAT);
  let bestF = 1;
  let bestKind = null;
  let bestRiser = false;
  for (const e of B.elems) {
    let d;
    if (e.type === 'edge') d = segDist(x, z, e);
    else if (e.type === 'seg') d = segDist(x, z, e) - e.clear;
    else d = pointInPolygon(x, z, e.poly) ? 0 : polyDist(x, z, e.poly);
    if (d <= 0 && e.type !== 'edge') {
      out.cut = true; // 道路 / 不下凹區：維持 0
      return out;
    }
    const pr = profile(e.kind, Math.max(0, d), Math.min(e.width, Math.max(0, d) + toWalk));
    if (pr.f < bestF) {
      bestF = pr.f;
      bestKind = e.kind;
      bestRiser = pr.riser;
    }
  }
  out.h = walkway * bestF;
  if (bestF >= 1 - 1e-9) out.k = dLake <= LAKE_WALKWAY ? K_WALKWAY : K_GRASS;
  else if (bestKind === 'terrace') out.k = bestRiser ? K_RISER : K_TERRACE;
  else if (bestKind === 'ramp') out.k = K_RAMP;
  else out.k = K_GRASS;
  return out;
}

// ---------- 下沉廣場 ----------
function preparePlaza(pl, roadSegs, stats) {
  const poly = pl.p;
  const n = poly.length / 2;
  const stairs = new Set(pl.stairs || []);
  const edges = [];
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    edges.push({ ax: poly[k * 2], az: poly[k * 2 + 1], bx: poly[j * 2], bz: poly[j * 2 + 1], stairs: stairs.has(k) });
  }
  const clears = [];
  const overlapped = new Set();
  for (const s of roadSegs) {
    const lim = s.road.hw + ROAD_CLEAR;
    if (polylinePolyDist([s.ax, s.az, s.bx, s.bz], poly) >= lim) continue;
    overlapped.add(s.road);
    clears.push({ ax: s.ax, az: s.az, bx: s.bx, bz: s.bz, clear: lim });
  }
  for (const r of overlapped) stats.roadOverlaps.push({ id: r.id, name: r.name, area: pl.n || 'plaza' });
  return { src: pl, poly, bbox: polygonBBox(poly), depth: pl.depth, edges, clears };
}

function evalPlaza(Q, x, z, out) {
  out.h = 0;
  out.k = K_GROUND;
  if (!pointInPolygon(x, z, Q.poly)) return out;
  for (const c of Q.clears) if (segDist(x, z, c) < c.clear) return out;
  let bestF = 1;
  let bestStairs = false;
  for (const e of Q.edges) {
    const d = segDist(x, z, e);
    const f = e.stairs ? Math.min(1, d / PLAZA_STAIR_RUN) : smoothstep(0, PLAZA_WALL, d);
    if (f < bestF) {
      bestF = f;
      bestStairs = e.stairs;
    }
  }
  out.h = Q.depth * bestF;
  out.k = bestF >= 1 - 1e-9 ? K_PLAZA : bestStairs ? K_STAIRS : K_PLAZA_WALL;
  return out;
}

// ---------- patch ----------
function makePatch(id, kind, bbox, cell) {
  const x0 = Math.floor((bbox.x0 - PATCH_MARGIN) / cell) * cell;
  const z0 = Math.floor((bbox.z0 - PATCH_MARGIN) / cell) * cell;
  const cols = Math.ceil((bbox.x1 + PATCH_MARGIN - x0) / cell) + 1;
  const rows = Math.ceil((bbox.z1 + PATCH_MARGIN - z0) / cell) + 1;
  return {
    id, kind, x0, z0, cell, cols, rows,
    x1: x0 + (cols - 1) * cell,
    z1: z0 + (rows - 1) * cell,
    heights: new Float32Array(cols * rows),
    kinds: new Uint8Array((cols - 1) * (rows - 1)),
  };
}

function fillPatch(patch, evalFn) {
  const { x0, z0, cell, cols, rows, heights, kinds } = patch;
  const o = { h: 0, k: 0, cut: false };
  const cut = new Uint8Array(cols * rows);
  let anyCut = false;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      o.cut = false;
      heights[r * cols + c] = evalFn(x0 + c * cell, z0 + r * cell, o).h;
      if (o.cut) {
        cut[r * cols + c] = 1;
        anyCut = true;
      }
    }
  }
  const zeroed = anyCut ? dropIsolated(patch, cut) : null;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const i = r * cols + c;
      const iso = zeroed && (zeroed[i] || zeroed[i + 1] || zeroed[i + cols] || zeroed[i + cols + 1]);
      kinds[r * (cols - 1) + c] = iso ? K_GROUND : evalFn(x0 + (c + 0.5) * cell, z0 + (r + 0.5) * cell, o).k;
    }
  }
}

// 由最低點（谷底）沿 4 鄰接 flood fill，不跨越 cut 節點；到不了的下凹節點歸 0
// （例：停車場車道與谷地外框之間的窄帶被道路排除帶隔開，不應各自下凹成小坑）；回傳被歸 0 的節點標記
function dropIsolated(patch, cut) {
  const { cols, rows, heights } = patch;
  const n = cols * rows;
  let lo = 0;
  for (let i = 0; i < n; i++) if (!cut[i] && heights[i] < lo) lo = heights[i];
  const seen = new Uint8Array(n);
  const stack = [];
  for (let i = 0; i < n; i++) {
    if (!cut[i] && heights[i] === lo && lo < 0) {
      seen[i] = 1;
      stack.push(i);
    }
  }
  while (stack.length) {
    const i = stack.pop();
    const c = i % cols;
    const nb = [c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1, i >= cols ? i - cols : -1, i < n - cols ? i + cols : -1];
    for (const j of nb) {
      if (j < 0 || seen[j] || cut[j]) continue;
      seen[j] = 1;
      stack.push(j);
    }
  }
  const zeroed = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (cut[i] || seen[i] || heights[i] === 0) continue;
    heights[i] = 0;
    zeroed[i] = 1;
  }
  return zeroed;
}

// patch 內三角形內插（與 buildPatchMesh 同一對角線切分，見檔頭「對角線慣例」）；點在 patch 外回傳 NaN
function samplePatch(p, x, z) {
  const fx = (x - p.x0) / p.cell;
  const fz = (z - p.z0) / p.cell;
  if (!(fx >= 0 && fz >= 0 && fx <= p.cols - 1 && fz <= p.rows - 1)) return NaN;
  const c = Math.min(Math.floor(fx), p.cols - 2);
  const r = Math.min(Math.floor(fz), p.rows - 2);
  const tx = fx - c;
  const tz = fz - r;
  const i = r * p.cols + c;
  const h = p.heights;
  if (tx + tz <= 1) return h[i] + (h[i + 1] - h[i]) * tx + (h[i + p.cols] - h[i]) * tz;
  const h11 = h[i + p.cols + 1];
  return h11 + (h[i + p.cols] - h11) * (1 - tx) + (h[i + 1] - h11) * (1 - tz);
}

// 所在三角形的面法線（與 samplePatch 同一切分）；寫進 out = { x, y, z }，點在 patch 外回傳 false
function patchFaceNormal(p, x, z, out) {
  const fx = (x - p.x0) / p.cell;
  const fz = (z - p.z0) / p.cell;
  if (!(fx >= 0 && fz >= 0 && fx <= p.cols - 1 && fz <= p.rows - 1)) return false;
  const c = Math.min(Math.floor(fx), p.cols - 2);
  const r = Math.min(Math.floor(fz), p.rows - 2);
  const i = r * p.cols + c;
  const h = p.heights;
  let gx;
  let gz;
  if (fx - c + (fz - r) <= 1) {
    gx = (h[i + 1] - h[i]) / p.cell;
    gz = (h[i + p.cols] - h[i]) / p.cell;
  } else {
    gx = (h[i + p.cols + 1] - h[i + p.cols]) / p.cell;
    gz = (h[i + p.cols + 1] - h[i + 1]) / p.cell;
  }
  const len = Math.hypot(gx, 1, gz);
  out.x = -gx / len || 0;
  out.y = 1 / len;
  out.z = -gz / len || 0;
  return true;
}

// 建築水平平台（集中套用）：輪廓（外擴 BUILDING_PAD）內壓成單一高度，外圍 BUILDING_BLEND 內平滑過渡
// 平台高度 = 輪廓頂點原高度的最大值（避免建築一角浮空）；
// 例外：輪廓重心在谷地內、且頂點高差 > EMBED_RANGE 者視為嵌入邊坡的量體（如 §6.2 心之谷永續教育園區），取最小值讓底部落在低處。
// 輪廓內已平（高差 < FLAT_EPS）者只記錄高度、不改高度場。
function flattenBuildings(patch, buildings, basins, bases, stats) {
  const rect = { x0: patch.x0, z0: patch.z0, x1: patch.x1, z1: patch.z1 };
  const { x0, z0, cell, cols, heights } = patch;
  for (const b of buildings) {
    if (!bboxOverlap(b.bbox, rect)) continue;
    let vmax = -Infinity;
    let vmin = Infinity;
    for (let i = 0; i < b.poly.length; i += 2) {
      const h = samplePatch(patch, b.poly[i], b.poly[i + 1]);
      const v = Number.isNaN(h) ? 0 : h;
      vmax = Math.max(vmax, v);
      vmin = Math.min(vmin, v);
    }
    const c = polygonCentroid(b.poly);
    const embedded = vmax - vmin > EMBED_RANGE && basins.some((B) => pointInPolygon(c.x, c.z, B.poly));
    const base = embedded ? vmin : vmax;
    const R = BUILDING_PAD + BUILDING_BLEND;
    const c0 = Math.max(0, Math.floor((b.bbox.x0 - R - x0) / cell));
    const c1 = Math.min(cols - 1, Math.ceil((b.bbox.x1 + R - x0) / cell));
    const r0 = Math.max(0, Math.floor((b.bbox.z0 - R - z0) / cell));
    const r1 = Math.min(patch.rows - 1, Math.ceil((b.bbox.z1 + R - z0) / cell));
    let inside = 0;
    let dev = 0;
    for (let r = r0; r <= r1; r++) {
      for (let cc = c0; cc <= c1; cc++) {
        if (!pointInPolygon(x0 + cc * cell, z0 + r * cell, b.poly)) continue;
        inside++;
        dev = Math.max(dev, Math.abs(heights[r * cols + cc] - base));
      }
    }
    if (base !== 0) bases.set(b.id, base);
    if (embedded) stats.embedded.push({ id: b.id, name: b.name, base });
    if (dev < FLAT_EPS && (inside > 0 || Math.abs(base) < FLAT_EPS)) continue;
    stats.flattened.push(b.id);
    for (let r = r0; r <= r1; r++) {
      for (let cc = c0; cc <= c1; cc++) {
        const x = x0 + cc * cell;
        const z = z0 + r * cell;
        const d = pointInPolygon(x, z, b.poly) ? 0 : polyDist(x, z, b.poly);
        if (d >= R) continue;
        const i = r * cols + cc;
        heights[i] = d <= BUILDING_PAD ? base : base + (heights[i] - base) * smoothstep(0, BUILDING_BLEND, d - BUILDING_PAD);
      }
    }
  }
}

// 邊框一圈強制為 0（正常情況本來就是 0，修正數記在 stats.borderFixes 供測試確認）
function sealBorder(patch, stats) {
  const { cols, rows, heights } = patch;
  const fix = (i) => {
    if (heights[i] !== 0) {
      heights[i] = 0;
      stats.borderFixes++;
    }
  };
  for (let c = 0; c < cols; c++) {
    fix(c);
    fix((rows - 1) * cols + c);
  }
  for (let r = 0; r < rows; r++) {
    fix(r * cols);
    fix(r * cols + cols - 1);
  }
}

// 退台白色邊線：退台格內，各平台高度再低 TERRACE_LINE_DROP 的等高線（marching squares），y 取等高線高度；
// 逐格線段串成折線後以 Chaikin 平滑 TERRACE_SMOOTH 次（去掉網格折角），平滑後的折線寫進 paths（[[x, y, z, …]]），
// 其相鄰點線段寫進 out（每段 6 個數，同 terraceLines 格式）
function terraceContours(patch, walkway, out, paths) {
  const raw = [];
  marchTerrace(patch, walkway, raw);
  for (const line of chainSegments(raw)) {
    const sm = chaikin(line, TERRACE_SMOOTH);
    paths.push(sm);
    for (let i = 0; i + 5 < sm.length; i += 3) out.push(sm[i], sm[i + 1], sm[i + 2], sm[i + 3], sm[i + 4], sm[i + 5]);
  }
}

// 線段（每段 6 個數 ax, ay, az, bx, by, bz）依共用端點串成折線 [[x, y, z, …]]（端點以 1 mm 量化比對；封閉者首尾同點）
function chainSegments(segs) {
  const key = (x, y, z) => `${Math.round(x * 1000)},${Math.round(z * 1000)},${y}`;
  const n = segs.length / 6;
  const ends = new Map();
  const add = (k, s) => {
    if (!ends.has(k)) ends.set(k, []);
    ends.get(k).push(s);
  };
  for (let s = 0; s < n; s++) {
    add(key(segs[s * 6], segs[s * 6 + 1], segs[s * 6 + 2]), s);
    add(key(segs[s * 6 + 3], segs[s * 6 + 4], segs[s * 6 + 5]), s);
  }
  const used = new Uint8Array(n);
  const pt = (s, e) => [segs[s * 6 + e * 3], segs[s * 6 + e * 3 + 1], segs[s * 6 + e * 3 + 2]];
  // 從端點 p（屬於線段 s 的 e 端）沿未用過的線段一路走下去，回傳經過的點
  const walk = (s, e) => {
    const out = [];
    for (;;) {
      used[s] = 1;
      const q = pt(s, 1 - e);
      out.push(...q);
      const next = (ends.get(key(...q)) || []).find((t) => !used[t]);
      if (next === undefined) return out;
      e = key(...pt(next, 0)) === key(...q) ? 0 : 1;
      s = next;
    }
  };
  const deg = (s, e) => ends.get(key(...pt(s, e))).length;
  const lines = [];
  // 先從只連一段的端點（開放折線的起點）出發，其餘為封閉環
  const order = [...Array(n).keys()].sort((a, b) => Math.min(deg(a, 0), deg(a, 1)) - Math.min(deg(b, 0), deg(b, 1)));
  for (const s of order) {
    if (used[s]) continue;
    const e = deg(s, 0) === 1 ? 0 : deg(s, 1) === 1 ? 1 : 0;
    lines.push([...pt(s, e), ...walk(s, e)]);
  }
  return lines;
}

// Chaikin 角切平滑（[x, y, z, …]，y 不變）：開放折線保留兩端點，封閉環（首尾同點）整圈平滑
function chaikin(line, iterations) {
  let p = line;
  for (let it = 0; it < iterations; it++) {
    const n = p.length / 3;
    if (n < 3) return p;
    const closed = Math.hypot(p[0] - p[(n - 1) * 3], p[2] - p[(n - 1) * 3 + 2]) < 1e-6;
    const q = closed ? [] : [p[0], p[1], p[2]];
    for (let i = 0; i + 1 < n; i++) {
      const a = i * 3;
      const b = a + 3;
      q.push(0.75 * p[a] + 0.25 * p[b], p[a + 1], 0.75 * p[a + 2] + 0.25 * p[b + 2]);
      q.push(0.25 * p[a] + 0.75 * p[b], p[b + 1], 0.25 * p[a + 2] + 0.75 * p[b + 2]);
    }
    if (closed) q.push(q[0], q[1], q[2]);
    else q.push(p[(n - 1) * 3], p[(n - 1) * 3 + 1], p[(n - 1) * 3 + 2]);
    p = q;
  }
  return p;
}

function marchTerrace(patch, walkway, out) {
  const { x0, z0, cell, cols, rows, heights, kinds } = patch;
  const levels = [];
  for (let k = 0; k < TERRACE_STEPS; k++) levels.push((walkway * k) / TERRACE_STEPS - TERRACE_LINE_DROP);
  const pts = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const kc = kinds[r * (cols - 1) + c];
      if (kc !== K_TERRACE && kc !== K_RISER) continue;
      const i = r * cols + c;
      // 角點順序：左上、右上、右下、左下（沿格邊一圈）
      const hs = [heights[i], heights[i + 1], heights[i + cols + 1], heights[i + cols]];
      const xs = [c, c + 1, c + 1, c];
      const zs = [r, r, r + 1, r + 1];
      for (const L of levels) {
        pts.length = 0;
        for (let e = 0; e < 4; e++) {
          const a = hs[e];
          const b = hs[(e + 1) % 4];
          if ((a > L) === (b > L)) continue;
          const t = (L - a) / (b - a);
          const ea = (e + 1) % 4;
          pts.push(x0 + (xs[e] + (xs[ea] - xs[e]) * t) * cell, z0 + (zs[e] + (zs[ea] - zs[e]) * t) * cell);
        }
        for (let q = 0; q + 3 < pts.length; q += 4) out.push(pts[q], L, pts[q + 1], pts[q + 2], L, pts[q + 3]);
      }
    }
  }
}

// ---------- walkables ----------
// 折線每段做成一個矩形（兩端各延伸半寬，轉折處互相重疊不留縫）
function segmentWalkables(prefix, kind, line, hw, y) {
  const list = [];
  for (let i = 0; i + 3 < line.length; i += 2) {
    const ax = line[i];
    const az = line[i + 1];
    const bx = line[i + 2];
    const bz = line[i + 3];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1e-6) continue;
    const ux = ((bx - ax) / L) * hw;
    const uz = ((bz - az) / L) * hw;
    const poly = [
      ax - ux - uz, az - uz + ux,
      bx + ux - uz, bz + uz + ux,
      bx + ux + uz, bz + uz - ux,
      ax - ux + uz, az - uz - ux,
    ];
    list.push(makeWalkable(`${prefix}#${i / 2}`, kind, poly, [0, 0, y]));
  }
  return list;
}

// 甲板端點（折線兩端）：端緣中心 (x, z) = 端點沿外向 u 延伸半寬、外向單位向量 (ux, uz)、半寬、甲板高
function deckEnds(line, hw, y) {
  const n = line.length / 2;
  const end = (i, j) => {
    const L = Math.hypot(line[i * 2] - line[j * 2], line[i * 2 + 1] - line[j * 2 + 1]) || 1;
    const ux = (line[i * 2] - line[j * 2]) / L;
    const uz = (line[i * 2 + 1] - line[j * 2 + 1]) / L;
    return { x: line[i * 2] + ux * hw, z: line[i * 2 + 1] + uz * hw, ux, uz, hw, y };
  };
  return n < 2 ? [] : [end(0, 1), end(n - 1, n - 2)];
}

// 甲板端點落地平台（集中套用在高度場）：端緣在岸上（或離岸 LANDING_LEN 內）者，
// 端緣外 LANDING_LEN、內 LANDING_BACK、寬 hw + LANDING_SIDE 的矩形內節點壓成甲板高 − LANDING_DROP（甲板正下方 − LANDING_UNDER），
// 外圍 LANDING_BLEND 平滑過渡；湖內節點只處理甲板正下方（|橫向| ≤ hw、端緣內側），不在甲板兩側墊高湖床。平台寫進 landings [{ poly（含過渡帶的外框）, y, end }]
function applyLandings(patch, ends, lake, landings) {
  const { x0, z0, cell, cols, rows, heights } = patch;
  for (const e of ends) {
    if (lake && pointInPolygon(e.x, e.z, lake) && polyDist(e.x, e.z, lake) > LANDING_LEN) continue; // 端點在湖中（如 Z 字步道湖心端）
    const target = e.y - LANDING_DROP;
    const side = e.hw + LANDING_SIDE;
    const R = LANDING_LEN + LANDING_BLEND + side;
    const c0 = Math.max(0, Math.floor((e.x - R - x0) / cell));
    const c1 = Math.min(cols - 1, Math.ceil((e.x + R - x0) / cell));
    const r0 = Math.max(0, Math.floor((e.z - R - z0) / cell));
    const r1 = Math.min(rows - 1, Math.ceil((e.z + R - z0) / cell));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const x = x0 + c * cell;
        const z = z0 + r * cell;
        const s = (x - e.x) * e.ux + (z - e.z) * e.uz; // 沿外向（> 0 = 端緣外的岸上）
        const l = Math.abs(-(x - e.x) * e.uz + (z - e.z) * e.ux);
        const i = r * cols + c;
        const under = s <= 0 && s >= -LANDING_BACK && l <= e.hw; // 甲板正下方
        if (under) {
          heights[i] = e.y - LANDING_UNDER;
          continue;
        }
        if (lake && pointInPolygon(x, z, lake)) continue;
        const ds = s > LANDING_LEN ? s - LANDING_LEN : s < -LANDING_BACK ? -LANDING_BACK - s : 0;
        const dl = Math.max(0, l - side);
        const d = Math.hypot(ds, dl);
        if (d >= LANDING_BLEND) continue;
        heights[i] = target + (heights[i] - target) * smoothstep(0, LANDING_BLEND, d);
      }
    }
    const P = (s, l) => [e.x + e.ux * s - e.uz * l, e.z + e.uz * s + e.ux * l];
    const so = LANDING_LEN + LANDING_BLEND;
    const si = -LANDING_BACK - LANDING_BLEND;
    const lo = side + LANDING_BLEND;
    landings.push({ poly: [...P(si, -lo), ...P(so, -lo), ...P(so, lo), ...P(si, lo)], y: target, end: e });
  }
}

// 多邊形（扁平陣列）各頂點往外偏移 off（外 = 邊中點沿法線測試不在多邊形內的一側；斜接，夾限 3 倍）；回傳 [{ x, z }]
function offsetPolygon(poly, off) {
  const n = poly.length / 2;
  const P = (i) => ({ x: poly[((i + n) % n) * 2], z: poly[((i + n) % n) * 2 + 1] });
  const normals = [];
  for (let i = 0; i < n; i++) {
    const a = P(i);
    const b = P(i + 1);
    const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    let nx = -(b.z - a.z) / L;
    let nz = (b.x - a.x) / L;
    if (pointInPolygon((a.x + b.x) / 2 + nx * 0.05, (a.z + b.z) / 2 + nz * 0.05, poly)) {
      nx = -nx;
      nz = -nz;
    }
    normals.push({ nx, nz });
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = normals[(i - 1 + n) % n];
    const b = normals[i];
    const k = Math.min(3, 1 / Math.max(1e-3, 1 + a.nx * b.nx + a.nz * b.nz));
    const v = P(i);
    out.push({ x: v.x + (a.nx + b.nx) * off * k, z: v.z + (a.nz + b.nz) * off * k });
  }
  return out;
}

// patch 高度場在凸多邊形（扁平陣列）內的最大值（精確）：三角形內為平面，最大值必在
// 「多邊形頂點、多邊形內的網格節點、多邊形邊與格線 / 對角線的交點」之一
function patchMaxOver(p, poly) {
  const n = poly.length / 2;
  let best = -Infinity;
  const at = (x, z) => {
    const h = samplePatch(p, x, z);
    best = Math.max(best, Number.isNaN(h) ? 0 : h);
  };
  for (let i = 0; i < n; i++) {
    const ax = poly[i * 2];
    const az = poly[i * 2 + 1];
    const bx = poly[((i + 1) % n) * 2];
    const bz = poly[((i + 1) % n) * 2 + 1];
    at(ax, az);
    const fa = [(ax - p.x0) / p.cell, (az - p.z0) / p.cell];
    const fb = [(bx - p.x0) / p.cell, (bz - p.z0) / p.cell];
    // 直格線（fx = 整數）、橫格線（fz = 整數）、對角線（fx + fz = 整數）
    const cross = (va, vb) => {
      for (let k = Math.ceil(Math.min(va, vb)); k <= Math.floor(Math.max(va, vb)); k++) {
        if (Math.abs(vb - va) < 1e-12) continue;
        const t = (k - va) / (vb - va);
        at(ax + (bx - ax) * t, az + (bz - az) * t);
      }
    };
    cross(fa[0], fb[0]);
    cross(fa[1], fb[1]);
    cross(fa[0] + fa[1], fb[0] + fb[1]);
  }
  const bb = polygonBBox(poly);
  const c0 = Math.max(0, Math.ceil((bb.x0 - p.x0) / p.cell));
  const c1 = Math.min(p.cols - 1, Math.floor((bb.x1 - p.x0) / p.cell));
  const r0 = Math.max(0, Math.ceil((bb.z0 - p.z0) / p.cell));
  const r1 = Math.min(p.rows - 1, Math.floor((bb.z1 - p.z0) / p.cell));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const x = p.x0 + c * p.cell;
      const z = p.z0 + r * p.cell;
      if (pointInPolygon(x, z, poly)) best = Math.max(best, p.heights[r * p.cols + c]);
    }
  }
  return best;
}

// 湖邊木棧板分段：沿湖岸每段 ≤ LAKESIDE_STEP 一塊四邊形（內緣 = 湖岸、外緣 = 湖岸外 LAKESIDE_W），
// 其下地形最高點 + LAKESIDE_MIN_GAP 超過棧板面 y 者略過；回傳 [{ quad: [x, z × 4], edge: [ax, az, bx, bz]（湖岸線段） }]
function lakesidePieces(patch, lake, y) {
  const inner = offsetPolygon(lake, 0);
  const outer = offsetPolygon(lake, LAKESIDE_W);
  const n = inner.length;
  const pieces = [];
  let skipped = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const L = Math.hypot(inner[j].x - inner[i].x, inner[j].z - inner[i].z);
    const m = Math.max(1, Math.ceil(L / LAKESIDE_STEP));
    const lerp = (a, b, t) => [a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t];
    for (let k = 0; k < m; k++) {
      const a0 = lerp(inner[i], inner[j], k / m);
      const a1 = lerp(inner[i], inner[j], (k + 1) / m);
      const b1 = lerp(outer[i], outer[j], (k + 1) / m);
      const b0 = lerp(outer[i], outer[j], k / m);
      const quad = [...a0, ...a1, ...b1, ...b0];
      if (patchMaxOver(patch, quad) + LAKESIDE_MIN_GAP > y) {
        skipped++;
        continue;
      }
      pieces.push({ quad, edge: [...a0, ...a1] });
    }
  }
  return { pieces, skipped };
}

// 北端坡道中心線：ramp_start 往「最近湖岸點」的反方向找到路面高（坡頂），往湖岸方向到棧板外緣（坡底）；回傳 [{ x, z }]
function rampPath(patch, B, start) {
  if (!B.lake) return null;
  const cp = closestOnPolygon(start[0], start[1], B.lake, {});
  const d = Math.sqrt(cp.d2);
  if (d <= LAKESIDE_W) return null;
  const ux = (cp.x - start[0]) / d;
  const uz = (cp.z - start[1]) / d;
  let s = 0;
  while (s < RAMP_MARCH_MAX) {
    const h = samplePatch(patch, start[0] - ux * s, start[1] - uz * s);
    if (Number.isNaN(h) || h >= -0.01) break;
    s += RAMP_MARCH;
  }
  return [
    { x: start[0] - ux * s, z: start[1] - uz * s },
    { x: start[0], z: start[1] },
    { x: cp.x - ux * LAKESIDE_W, z: cp.z - uz * LAKESIDE_W },
  ];
}

// 坡道鋪面帶的格（格中心離中心線 ≤ 半寬、在谷內且已下凹）標為 K_RAMP_PAVE
function markRamp(patch, pts, hw) {
  const { x0, z0, cell, cols, rows, kinds } = patch;
  let n = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const x = x0 + (c + 0.5) * cell;
      const z = z0 + (r + 0.5) * cell;
      const k = r * (cols - 1) + c;
      if (kinds[k] === K_GROUND || kinds[k] === K_LAKEBED) continue;
      let near = false;
      for (let i = 0; i + 1 < pts.length && !near; i++) near = closestOnSegment(x, z, pts[i].x, pts[i].z, pts[i + 1].x, pts[i + 1].z, _seg).d2 <= hw * hw;
      if (!near) continue;
      kinds[k] = K_RAMP_PAVE;
      n++;
    }
  }
  return n;
}

function makeWalkable(id, kind, poly, plane) {
  const [a, b, c] = plane;
  return { id, kind, poly, bbox: polygonBBox(poly), plane, heightAt: (x, z) => a * x + b * z + c };
}

// ---------- 貼地細分（純函式；surface 需有 heightAt(x, z)，可選 normalAt(x, z, out)） ----------
// out = { pos: [], nor: [], uv?: [] }：追加非索引三角形（每 3 個頂點一組，法線朝上）
const _n = { x: 0, y: 1, z: 0 };
function emitVertex(surface, out, x, z, yOff) {
  out.pos.push(x, surface.heightAt(x, z) + yOff, z);
  if (surface.normalAt) {
    surface.normalAt(x, z, _n);
    out.nor.push(_n.x, _n.y, _n.z);
  } else out.nor.push(0, 1, 0);
}

function emitTri(surface, out, yOff, x1, z1, x2, z2, x3, z3, uv) {
  const cr = (x2 - x1) * (z3 - z1) - (z2 - z1) * (x3 - x1);
  if (Math.abs(cr) < 1e-10) return;
  let order = [0, 1, 2];
  if (cr > 0) order = [0, 2, 1]; // (x, z) 平面逆時針時交換，讓法線朝上（與 world.js FlatWriter 相同慣例）
  const X = [x1, x2, x3];
  const Z = [z1, z2, z3];
  for (const k of order) {
    emitVertex(surface, out, X[k], Z[k], yOff);
    if (uv) out.uv.push(uv[k * 2], uv[k * 2 + 1]);
  }
}

// 三角形均勻細分到每邊 ≤ maxSeg 後逐頂點取高度；uv = [u1, v1, u2, v2, u3, v3]（可省略）
export function drapeTriangle(surface, x1, z1, x2, z2, x3, z3, yOff, out, maxSeg = 1, uv = null) {
  const L = Math.max(Math.hypot(x2 - x1, z2 - z1), Math.hypot(x3 - x2, z3 - z2), Math.hypot(x1 - x3, z1 - z3));
  const n = Math.max(1, Math.ceil(L / maxSeg - 1e-9));
  const P = (i, j) => [x1 + ((x2 - x1) * i + (x3 - x1) * j) / n, z1 + ((z2 - z1) * i + (z3 - z1) * j) / n];
  const U = uv ? (i, j) => [uv[0] + ((uv[2] - uv[0]) * i + (uv[4] - uv[0]) * j) / n, uv[1] + ((uv[3] - uv[1]) * i + (uv[5] - uv[1]) * j) / n] : null;
  const tri = (a, b, c) => {
    const pa = P(...a);
    const pb = P(...b);
    const pc = P(...c);
    emitTri(surface, out, yOff, pa[0], pa[1], pb[0], pb[1], pc[0], pc[1], U ? [...U(...a), ...U(...b), ...U(...c)] : null);
  };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n - j; i++) {
      tri([i, j], [i + 1, j], [i, j + 1]);
      if (i + j < n - 1) tri([i + 1, j], [i + 1, j + 1], [i, j + 1]);
    }
  }
  return out;
}

// 帶狀路面貼地：每段沿線與橫向都細分到 ≤ maxSeg；端點與轉折處補同心圓盤（與 world.js 平面 ribbon 同形）
// pts = [{ x, z }]，hw = 半寬
export function drapeRibbon(surface, pts, hw, yOff, out, maxSeg = 1) {
  const nW = Math.max(1, Math.ceil((2 * hw) / maxSeg - 1e-9));
  for (let s = 0; s < pts.length - 1; s++) {
    const a = pts[s];
    const b = pts[s + 1];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L < 1e-4) continue;
    const ux = (b.x - a.x) / L;
    const uz = (b.z - a.z) / L;
    const nx = -uz;
    const nz = ux;
    const nL = Math.max(1, Math.ceil(L / maxSeg - 1e-9));
    const P = (i, j) => {
      const along = (L * i) / nL;
      const across = -hw + (2 * hw * j) / nW;
      return [a.x + ux * along + nx * across, a.z + uz * along + nz * across];
    };
    for (let i = 0; i < nL; i++) {
      for (let j = 0; j < nW; j++) {
        const p00 = P(i, j);
        const p10 = P(i + 1, j);
        const p01 = P(i, j + 1);
        const p11 = P(i + 1, j + 1);
        emitTri(surface, out, yOff, p00[0], p00[1], p10[0], p10[1], p11[0], p11[1]);
        emitTri(surface, out, yOff, p00[0], p00[1], p11[0], p11[1], p01[0], p01[1]);
      }
    }
  }
  const rings = Math.max(1, Math.ceil(hw / maxSeg - 1e-9));
  const segs = Math.max(12, Math.ceil((2 * Math.PI * hw) / maxSeg - 1e-9));
  for (let i = 0; i < pts.length; i++) {
    if (i > 0 && i < pts.length - 1) {
      const d1x = pts[i].x - pts[i - 1].x;
      const d1z = pts[i].z - pts[i - 1].z;
      const d2x = pts[i + 1].x - pts[i].x;
      const d2z = pts[i + 1].z - pts[i].z;
      const cos = (d1x * d2x + d1z * d2z) / ((Math.hypot(d1x, d1z) * Math.hypot(d2x, d2z)) || 1);
      if (cos > 0.9997) continue; // 幾乎直線，不需要補
    }
    const cx = pts[i].x;
    const cz = pts[i].z;
    const R = (k, m) => {
      const r = (hw * k) / rings;
      const ang = (m / segs) * Math.PI * 2;
      return [cx + Math.cos(ang) * r, cz + Math.sin(ang) * r];
    };
    for (let m = 0; m < segs; m++) {
      const q1 = R(1, m);
      const q2 = R(1, m + 1);
      emitTri(surface, out, yOff, cx, cz, q1[0], q1[1], q2[0], q2[1]);
      for (let k = 1; k < rings; k++) {
        const a0 = R(k, m);
        const a1 = R(k, m + 1);
        const b0 = R(k + 1, m);
        const b1 = R(k + 1, m + 1);
        emitTri(surface, out, yOff, a0[0], a0[1], b0[0], b0[1], b1[0], b1[1]);
        emitTri(surface, out, yOff, a0[0], a0[1], b1[0], b1[1], a1[0], a1[1]);
      }
    }
  }
  return out;
}

// patch 轉渲染網格（純數學）：頂點 = 高度場節點；法線 = 節點中央差分；索引依 SURFACES 分組
// 回傳 { positions, normals, uvs, indices, groups: [{ surface, start, count }] }（uv = (x, -z) / uvScale）
export function buildPatchMesh(patch, { uvScale = 4 } = {}) {
  const { x0, z0, cell, cols, rows, heights, kinds } = patch;
  const n = cols * rows;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const uvs = new Float32Array(n * 2);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const x = x0 + c * cell;
      const z = z0 + r * cell;
      positions[i * 3] = x;
      positions[i * 3 + 1] = heights[i];
      positions[i * 3 + 2] = z;
      const cl = Math.max(0, c - 1);
      const cr = Math.min(cols - 1, c + 1);
      const ru = Math.max(0, r - 1);
      const rd = Math.min(rows - 1, r + 1);
      const gx = (heights[r * cols + cr] - heights[r * cols + cl]) / ((cr - cl) * cell);
      const gz = (heights[rd * cols + c] - heights[ru * cols + c]) / ((rd - ru) * cell);
      const len = Math.hypot(gx, 1, gz);
      normals[i * 3] = -gx / len;
      normals[i * 3 + 1] = 1 / len;
      normals[i * 3 + 2] = -gz / len;
      uvs[i * 2] = x / uvScale;
      uvs[i * 2 + 1] = -z / uvScale;
    }
  }
  const lists = SURFACES.map(() => []);
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const i00 = r * cols + c;
      const i10 = i00 + 1;
      const i01 = i00 + cols;
      const i11 = i01 + 1;
      // (x 東, z 南) 下 (i00, i01, i10) 法線朝上
      lists[SURFACES.indexOf(SURFACE_OF[kinds[r * (cols - 1) + c]])].push(i00, i01, i10, i10, i01, i11);
    }
  }
  const indices = new Uint32Array(lists.reduce((s, l) => s + l.length, 0));
  const groups = [];
  let start = 0;
  lists.forEach((l, k) => {
    indices.set(l, start);
    if (l.length) groups.push({ surface: SURFACES[k], start, count: l.length });
    start += l.length;
  });
  return { positions, normals, uvs, indices, groups };
}

// ---------- 建立地形 ----------
export function createTerrain(osmData) {
  const T = osmData.T || {};
  const stats = { roadOverlaps: [], embedded: [], flattened: [], borderFixes: 0, patches: [], triangles: 0, basinVolume: 0 };
  const mkRoad = (r, foot) => ({ id: r.i, name: r.n || '', hw: r.w / 2, foot, bridge: !!r.br, p: r.p });
  const roads = (osmData.R || []).filter((r) => !r.u).map((r) => mkRoad(r, false));
  const foots = (osmData.F || []).filter((r) => !r.u).map((r) => mkRoad(r, true));
  const segsOf = (list) => {
    const out = [];
    for (const r of list) {
      for (let i = 0; i + 3 < r.p.length; i += 2) out.push({ road: r, ax: r.p[i], az: r.p[i + 1], bx: r.p[i + 2], bz: r.p[i + 3] });
    }
    return out;
  };
  const roadSegs = segsOf(roads);

  const basins = (T.basins || []).map((b) => prepareBasin(b, roadSegs, stats));
  const plazas = (T.plazas || []).map((pl) => preparePlaza(pl, roadSegs, stats));

  const patches = [];
  for (const B of basins) {
    const p = makePatch(`basin:${B.src.i}`, 'basin', B.bbox, BASIN_CELL);
    fillPatch(p, (x, z, o) => evalBasin(B, x, z, o));
    p.feature = B;
    patches.push(p);
  }
  plazas.forEach((Q, k) => {
    const p = makePatch(`plaza:${Q.src.i ?? k}`, 'plaza', Q.bbox, PLAZA_CELL);
    fillPatch(p, (x, z, o) => evalPlaza(Q, x, z, o));
    p.feature = Q;
    patches.push(p);
  });

  // walkables：紅橋一律採 OSM 跨湖步道 lake_bridge_osm，缺漏時才用推算的 red_bridge；Z 字湖上步道為推算
  // 甲板端點（deckEnds）供落地平台壓平高度場
  const walkables = [];
  const endsOf = new Map(); // basin → 甲板端點
  for (const B of basins) {
    const feats = B.src.features || [];
    const ends = [];
    const osmBridge = feats.find((f) => f.k === 'lake_bridge_osm');
    const bridge = osmBridge || feats.find((f) => f.k === 'red_bridge');
    if (bridge) {
      const fw = osmBridge ? foots.find((f) => f.id === osmBridge.i) : null;
      const hw = fw ? fw.hw : 1.25;
      const deck = B.lv.walkway + BRIDGE_DECK_RISE;
      walkables.push(...segmentWalkables(`bridge:${bridge.i ?? bridge.k}`, 'bridge', bridge.p, hw, deck));
      ends.push(...deckEnds(bridge.p, hw, deck));
    }
    for (const f of feats) {
      if (f.k !== 'zigzag_walk') continue;
      const deck = B.lv.walkway + BOARDWALK_DECK_RISE;
      walkables.push(...segmentWalkables(`zigzag:${B.src.i}`, 'boardwalk', f.p, 1.25, deck));
      ends.push(...deckEnds(f.p, 1.25, deck));
    }
    endsOf.set(B, ends);
  }

  // 甲板端點落地平台 → 建築水平平台 → 邊框歸 0（全部集中改高度場；湖邊棧板帶的壓平在 evalBasin 的 LAKE_FLAT）
  const landings = [];
  for (const p of patches) if (p.kind === 'basin') applyLandings(p, endsOf.get(p.feature), p.feature.lake, landings);
  const buildings = (osmData.B || []).map((b) => ({ id: b.i, name: b.n || '', poly: b.p, bbox: polygonBBox(b.p) }));
  const buildingIds = new Set(buildings.map((b) => b.id));
  const bases = new Map();
  for (const p of patches) flattenBuildings(p, buildings, basins, bases, stats);
  for (const p of patches) sealBorder(p, stats);
  stats.landings = landings.length;

  // 退台白色邊線（平滑折線 terracePaths 與其線段 terraceLines）
  const terraceLines = [];
  const terracePaths = [];
  for (const p of patches) if (p.kind === 'basin') terraceContours(p, p.feature.lv.walkway, terraceLines, terracePaths);

  // 湖邊木棧板（固定高度平板）與北端坡道鋪面
  const lakesides = [];
  const rampPaths = [];
  stats.lakesideSkipped = 0;
  stats.rampCells = 0;
  for (const p of patches) {
    if (p.kind !== 'basin') continue;
    const B = p.feature;
    if (B.lake) {
      const y = B.lv.walkway + LAKESIDE_LIFT;
      const { pieces, skipped } = lakesidePieces(p, B.lake, y);
      lakesides.push({ id: `lakeside:${B.src.i}`, y, width: LAKESIDE_W, pieces });
      stats.lakesideSkipped += skipped;
    }
    const start = (B.src.features || []).find((f) => f.k === 'ramp_start');
    const pts = start ? rampPath(p, B, start.p) : null;
    if (!pts) continue;
    rampPaths.push({ id: `ramp:${B.src.i}`, pts, hw: RAMP_PAVE_HW });
    stats.rampCells += markRamp(p, pts, RAMP_PAVE_HW);
  }

  // 湖面（水平面 y = levels.water，不是高度場）
  const lakes = basins.filter((B) => B.lake).map((B) => ({ id: B.src.li, basinId: B.src.i, poly: B.lake, bbox: polygonBBox(B.lake), y: B.lv.water }));
  for (const Q of plazas) {
    for (const e of Q.edges) {
      if (!e.stairs) continue;
      const L = Math.hypot(e.bx - e.ax, e.bz - e.az);
      // 內法線：取邊的法向量，指向面積重心那一側
      let nx = -(e.bz - e.az) / L;
      let nz = (e.bx - e.ax) / L;
      const c = polygonCentroid(Q.poly);
      if ((c.x - e.ax) * nx + (c.z - e.az) * nz < 0) {
        nx = -nx;
        nz = -nz;
      }
      const run = PLAZA_STAIR_RUN;
      const poly = [e.ax, e.az, e.bx, e.bz, e.bx + nx * run, e.bz + nz * run, e.ax + nx * run, e.az + nz * run];
      const g = Q.depth / run; // y = g · (到階梯邊的距離)
      walkables.push(makeWalkable(`stairs:${Q.src.n || 'plaza'}`, 'stairs', poly, [g * nx, g * nz, -g * (nx * e.ax + nz * e.az)]));
    }
  }

  // 統計
  for (const p of patches) {
    const tris = (p.cols - 1) * (p.rows - 1) * 2;
    stats.triangles += tris;
    stats.patches.push({ id: p.id, kind: p.kind, cell: p.cell, cols: p.cols, rows: p.rows, width: p.x1 - p.x0, depth: p.z1 - p.z0, triangles: tris });
    if (p.kind !== 'basin') continue;
    let v = 0;
    for (let r = 0; r < p.rows - 1; r++) {
      for (let c = 0; c < p.cols - 1; c++) {
        const i = r * p.cols + c;
        const avg = (p.heights[i] + p.heights[i + 1] + p.heights[i + p.cols] + p.heights[i + p.cols + 1]) / 4;
        if (avg < 0) v -= avg * p.cell * p.cell;
      }
    }
    stats.basinVolume += v;
  }

  // 查詢用空間索引：道路 / 步道線段、綠地 / 廣場分區
  const segGrid = new SpatialGrid(25);
  for (const s of [...roadSegs, ...segsOf(foots)]) {
    const hw = s.road.hw;
    segGrid.insert(s, Math.min(s.ax, s.bx) - hw, Math.min(s.az, s.bz) - hw, Math.max(s.ax, s.bx) + hw, Math.max(s.az, s.bz) + hw);
  }
  const areaGrid = new SpatialGrid(50);
  const areas = [
    ...(osmData.P || []).map((p) => ({ poly: p.p, kind: 'grass' })),
    ...(osmData.L || []).filter((l) => l.k !== 'parking').map((l) => ({ poly: l.p, kind: l.k === 'pedestrian' || l.k === 'plaza' ? 'plaza' : 'grass' })),
  ];
  for (const a of areas) {
    a.bbox = polygonBBox(a.poly);
    areaGrid.insert(a, a.bbox.x0, a.bbox.z0, a.bbox.x1, a.bbox.z1);
  }
  const _q = [];
  const _sp = { x: 0, z: 0, d2: 0, t: 0 };
  const coveredAreaIds = new Set(basins.map((B) => B.src.i));

  function patchAt(x, z) {
    for (const p of patches) if (x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1) return p;
    return null;
  }

  function heightAt(x, z) {
    for (const p of patches) {
      if (x < p.x0 || x > p.x1 || z < p.z0 || z > p.z1) continue;
      return samplePatch(p, x, z);
    }
    return 0;
  }

  // 高度場法線：所在三角形的面法線（與 heightAt / 渲染網格同一平面；格線與對角線上屬於哪一側見 samplePatch）
  function normalAt(x, z, out = {}) {
    const p = patchAt(x, z);
    if (!p || !patchFaceNormal(p, x, z, out)) {
      out.x = 0;
      out.y = 1;
      out.z = 0;
    }
    return out;
  }

  function lakeAt(x, z) {
    for (const l of lakes) {
      if (x < l.bbox.x0 || x > l.bbox.x1 || z < l.bbox.z0 || z > l.bbox.z1) continue;
      if (pointInPolygon(x, z, l.poly)) return l;
    }
    return null;
  }

  function walkableAt(x, z, maxY) {
    let best = null;
    let by = -Infinity;
    for (const w of walkables) {
      if (x < w.bbox.x0 || x > w.bbox.x1 || z < w.bbox.z0 || z > w.bbox.z1) continue;
      if (!pointInPolygon(x, z, w.poly)) continue;
      const y = w.heightAt(x, z);
      if (y <= maxY && y > by) {
        by = y;
        best = w;
      }
    }
    return best;
  }

  const _nrm = {};
  // 地表查詢：{ y, nx, ny, nz, kind, walkable（站上的 walkable 或 null）, waterY（在湖面範圍內為水面高，否則 null） }
  function querySurface(x, z, yHint = Infinity, out = {}) {
    const p = patchAt(x, z);
    let y = p ? samplePatch(p, x, z) : 0;
    const w = walkableAt(x, z, yHint + WALKABLE_STEP);
    const lake = lakeAt(x, z);
    out.walkable = null;
    out.waterY = lake ? lake.y : null;
    if (w && w.heightAt(x, z) > y) {
      y = w.heightAt(x, z);
      const len = Math.hypot(w.plane[0], 1, w.plane[1]);
      out.y = y;
      out.nx = -w.plane[0] / len || 0;
      out.ny = 1 / len;
      out.nz = -w.plane[1] / len || 0;
      out.kind = w.kind === 'stairs' ? 'plaza' : 'sidewalk';
      out.walkable = w;
      return out;
    }
    normalAt(x, z, _nrm);
    out.y = y;
    out.nx = _nrm.x;
    out.ny = _nrm.y;
    out.nz = _nrm.z;
    out.kind = classify(x, z, p, lake, yHint);
    return out;
  }

  function classify(x, z, p, lake, yHint) {
    if (lake) return yHint > lake.y ? 'water' : 'lakebed';
    const list = segGrid.query(x - 16, z - 16, x + 16, z + 16, _q);
    let foot = false;
    for (const s of list) {
      closestOnSegment(x, z, s.ax, s.az, s.bx, s.bz, _sp);
      if (_sp.d2 >= s.road.hw * s.road.hw) continue;
      if (!s.road.foot) return 'road';
      foot = true;
    }
    if (foot) return 'sidewalk';
    if (p) {
      const c = Math.min(p.cols - 2, Math.floor((x - p.x0) / p.cell));
      const r = Math.min(p.rows - 2, Math.floor((z - p.z0) / p.cell));
      const k = p.kinds[r * (p.cols - 1) + c];
      if (k !== K_GROUND) return KIND_NAMES[k];
    }
    for (const a of areaGrid.query(x, z, x, z, _q)) {
      if (x < a.bbox.x0 || x > a.bbox.x1 || z < a.bbox.z0 || z > a.bbox.z1) continue;
      if (pointInPolygon(x, z, a.poly)) return a.kind;
    }
    return 'ground';
  }

  // 多邊形（扁平陣列）底下（外擴一格半）的高度場節點是否全為 0：是則平面繪製即與高度場一致
  function isFlatUnder(poly) {
    const bb = polygonBBox(poly);
    for (const p of patches) {
      const pad = p.cell * 1.5;
      if (bb.x1 + pad < p.x0 || bb.x0 - pad > p.x1 || bb.z1 + pad < p.z0 || bb.z0 - pad > p.z1) continue;
      const c0 = Math.max(0, Math.floor((bb.x0 - pad - p.x0) / p.cell));
      const c1 = Math.min(p.cols - 1, Math.ceil((bb.x1 + pad - p.x0) / p.cell));
      const r0 = Math.max(0, Math.floor((bb.z0 - pad - p.z0) / p.cell));
      const r1 = Math.min(p.rows - 1, Math.ceil((bb.z1 + pad - p.z0) / p.cell));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          if (p.heights[r * p.cols + c] === 0) continue;
          const x = p.x0 + c * p.cell;
          const z = p.z0 + r * p.cell;
          if (pointInPolygon(x, z, poly) || closestOnPolygon(x, z, poly, _cp).d2 < pad * pad) return false;
        }
      }
    }
    return true;
  }

  // 折線帶（半寬 hw，含端點圓盤）底下是否全平
  function isFlatAlong(pts, hw) {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const ux = ((b.x - a.x) / L) * hw;
      const uz = ((b.z - a.z) / L) * hw;
      const poly = [a.x - ux - uz, a.z - uz + ux, b.x + ux - uz, b.z + uz + ux, b.x + ux + uz, b.z + uz - ux, a.x - ux + uz, a.z - uz - ux];
      if (!isFlatUnder(poly)) return false;
    }
    if (pts.length === 1) return isFlatUnder([pts[0].x - hw, pts[0].z - hw, pts[0].x + hw, pts[0].z - hw, pts[0].x + hw, pts[0].z + hw, pts[0].x - hw, pts[0].z + hw]);
    return true;
  }

  function buildingBase(id) {
    return bases.get(id) ?? 0;
  }

  // 地標 glb 以 OSM 建築 id 對應（manifest id）：有輪廓者同 buildingBase；沒有輪廓時以錨點 (x, z) 取高度場
  function landmarkBase(osmId, x, z) {
    if (buildingIds.has(Number(osmId))) return buildingBase(Number(osmId));
    return Number.isFinite(x) && Number.isFinite(z) ? heightAt(x, z) : 0;
  }

  function waterLevel(waterId) {
    const l = lakes.find((k) => k.id === waterId);
    return l ? l.y : null;
  }

  // 「最上層可行走面」：湖上橋 / 步道甲板優先（步道貼地時用）
  const _topOut = {};
  const topSurface = {
    heightAt: (x, z) => querySurface(x, z, Infinity, _topOut).y,
    normalAt: (x, z, out) => {
      querySurface(x, z, Infinity, _topOut);
      out.x = _topOut.nx;
      out.y = _topOut.ny;
      out.z = _topOut.nz;
      return out;
    },
  };

  // 高度場格的細分種類（CELL_KIND_NAMES）；patch 外回傳 'ground'
  function cellKindAt(x, z) {
    const p = patchAt(x, z);
    if (!p) return 'ground';
    const c = Math.min(p.cols - 2, Math.floor((x - p.x0) / p.cell));
    const r = Math.min(p.rows - 2, Math.floor((z - p.z0) / p.cell));
    return CELL_KIND_NAMES[p.kinds[r * (p.cols - 1) + c]];
  }

  // 追加可行走覆蓋面（程序化細節的可站立平台，如下沉廣場木平台）；同 id 已存在則不重複加入，回傳該 walkable
  function addWalkable(id, kind, poly, plane) {
    const old = walkables.find((w) => w.id === id);
    if (old) return old;
    const w = makeWalkable(id, kind, poly, plane);
    walkables.push(w);
    return w;
  }

  // 凸多邊形（扁平陣列）底下高度場的最大值（精確，見 patchMaxOver）；不在任何 patch 內為 0
  function maxHeightOver(poly) {
    const bb = polygonBBox(poly);
    const p = patches.find((q) => bb.x0 >= q.x0 && bb.x1 <= q.x1 && bb.z0 >= q.z0 && bb.z1 <= q.z1);
    return p ? patchMaxOver(p, poly) : 0;
  }

  return {
    patches, walkables, terraceLines, terracePaths, lakes, lakesides, rampPaths, landings, stats, coveredAreaIds, topSurface,
    heightAt, normalAt, querySurface, patchAt, isFlatUnder, isFlatAlong, buildingBase, landmarkBase, waterLevel,
    cellKindAt, addWalkable, maxHeightOver,
  };
}

// ---------- 唯一實例 ----------
let instance = null;

export function initTerrain(osmData) {
  instance = createTerrain(osmData);
  return instance;
}

export function getTerrain() {
  return instance;
}

function need() {
  if (!instance) throw new Error('[terrain] 尚未初始化：請先 initTerrain(osmData)（citymodel.js 載入時會自動呼叫）');
  return instance;
}

export function heightAt(x, z) {
  return need().heightAt(x, z);
}

export function querySurface(x, z, yHint = Infinity, out = {}) {
  return need().querySurface(x, z, yHint, out);
}
