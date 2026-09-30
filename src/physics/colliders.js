// 世界靜態碰撞體：地形 heightfield、平地 cuboid、建築凸柱、walkable trimesh、湖面阻擋柱、邊界隱形牆
// 全部是無父剛體的固定 collider，屬 WORLD 組（groups.js）。純數學 + 注入的 RAPIER，不 import three。
// 地形資料依 D1a terrain.js 介面契約以參數注入（不 import terrain.js）：
//   patches[{ id, kind, x0, z0, cell, cols, rows, heights }]、walkables[{ id, kind, poly, heightAt }]、buildingBase(id)
import { GROUPS } from './groups.js';
import { cleanPolygon, convexDecompose, triangulate, subtractConvex, offsetConvex, signedAreaFlat, splitConvexBySpan } from './decompose.js';

const GROUND_THICKNESS = 2; // 平地 cuboid 厚度（頂面 y = 0）
// 平地 cuboid 邊長上限（m）：矩形差集的矩形可達約 1930 × 1450 m，宿主實測角色站在這種巨型 cuboid 上腳底低於地面 0.105 m、
// 朝牆跑在離牆 1.45 m 處無水平阻擋卻停住（研判為 f32 形狀掃掠 / GJK 對巨大凸體的精度問題，與建築細長凸塊同型；工作區無 rapier 未能直接驗證）；
// 切成 ≤ 64 m 的方塊後每塊支撐點都在角色附近
const GROUND_TILE = 64;
const BUILDING_SINK = 0.6; // 建築凸柱底部埋入平台以下的深度（避免與地面之間漏縫）
const WALL_HEIGHT = 50; // 邊界隱形牆高度
const WALL_THICKNESS = 2;
const WALL_SINK = 2; // 隱形牆往地面下延伸（與平地 cuboid 重疊，無縫）
const WALK_MAX_EDGE = 2; // walkable trimesh 三角形最長邊（m），細分後頂點高度逐點取 heightAt
const WALK_MAX_DEPTH = 6; // 細分遞迴上限
const LAKE_WALL_ABOVE = 1.2; // 湖面阻擋柱頂 = 步道高度 + 1.2 m
const LAKE_WALL_BELOW = 1; // 湖面阻擋柱底 = 湖床 − 1 m
const CHANNEL_MARGIN = 0.1; // walkable 橫越湖面的通道每側外擴 0.1 m（通道寬 = walkable 寬 + 0.2）
const MIN_PIECE_AREA = 0.05; // 差集後小於此面積的碎塊不建 collider（m²）
// 建築凸柱外框邊長上限（m）：細長凸塊（例：建築 148849083 一塊長約 122 m、頂角約 4.5° 的斜向長條）
// 在宿主實測中讓角色離牆 1.46 m 就停住、且沒有沿斜牆滑動（研判為形狀掃掠 GJK 對細長凸體的精度問題，工作區無 rapier 未能直接驗證）；
// 切短後每塊尺寸有上限，同時縮小 broad phase 外框
const MAX_PIECE_SPAN = 20;

// ---------- patch → Rapier heightfield（索引慣例集中在此，terrain 慣例若不同只改這裡）----------
// terrain 契約：heights[row * cols + col] 為點 (x0 + col·cell, z0 + row·cell) 的高度；cols / rows 是「點數」
// Rapier（parry3d）heightfield 慣例（依 dist/geometry/shape.d.ts + parry 原始碼）：
//   - ColliderDesc.heightfield(nrows, ncols, heights, scale) 的 nrows / ncols 是「格數」（subdivisions），
//     heights 長度 = (nrows + 1) × (ncols + 1)，以「行優先（column-major）」存放：heights[j * (nrows + 1) + i]
//   - 列 i 沿局部 z、行 j 沿局部 x；局部座標 x ∈ [−scale.x/2, +scale.x/2]、z ∈ [−scale.z/2, +scale.z/2]（原點置中）
//   - 點 (i, j) 的局部位置 = (−scale.x/2 + j·scale.x/ncols, heights × scale.y, −scale.z/2 + i·scale.z/nrows)
// 轉換：nrows = rows − 1、ncols = cols − 1、scale = ((cols−1)·cell, 1, (rows−1)·cell)、
//   collider 平移到 patch 中心 (x0 + scale.x/2, 0, z0 + scale.z/2)、heights 由 row-major 轉置為 column-major
// 回傳 { desc, nrows, ncols, heights, scale, center }（後五項供測試 / 除錯核對）
export function patchToHeightfield(RAPIER, patch) {
  const { x0, z0, cell, cols, rows } = patch;
  const nrows = rows - 1;
  const ncols = cols - 1;
  const heights = new Float32Array(rows * cols);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) heights[col * rows + row] = patch.heights[row * cols + col];
  }
  const scale = { x: ncols * cell, y: 1, z: nrows * cell };
  const center = { x: x0 + scale.x / 2, y: 0, z: z0 + scale.z / 2 };
  const flags = RAPIER.HeightFieldFlags ? RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES : undefined;
  const desc = RAPIER.ColliderDesc.heightfield(nrows, ncols, heights, scale, flags).setTranslation(center.x, center.y, center.z);
  return { desc, nrows, ncols, heights, scale, center };
}

// patch 的 XZ 外框矩形
export function patchRect(patch) {
  return { x0: patch.x0, z0: patch.z0, x1: patch.x0 + (patch.cols - 1) * patch.cell, z1: patch.z0 + (patch.rows - 1) * patch.cell };
}

// ---------- 矩形差集：bounds 扣掉所有 patch 矩形 → 互不重疊、無縫的軸對齊矩形 ----------
// 演算法（座標壓縮 + 掃描合併）：
//   1. 收集 bounds 與每個（夾在 bounds 內的）patch 矩形的所有 x、z 邊界，排序去重 → 非均勻格線
//   2. 每個格子以中心點判斷是否落在任一 patch 內（格線包含所有 patch 邊，格子不會跨 patch 邊界）
//   3. 逐列（z）把連續的空格合併成水平區段 [i0, i1)；下一列若有完全相同的區段就往下延伸，否則該矩形結案
// 每個空格恰屬於一個輸出矩形 → 不重疊、不留縫；矩形數通常遠少於格子數
export function rectDifference(bounds, holes) {
  const clip = [];
  for (const h of holes) {
    const r = { x0: Math.max(h.x0, bounds.x0), z0: Math.max(h.z0, bounds.z0), x1: Math.min(h.x1, bounds.x1), z1: Math.min(h.z1, bounds.z1) };
    if (r.x1 > r.x0 && r.z1 > r.z0) clip.push(r);
  }
  const uniq = (a) => [...new Set(a)].sort((p, q) => p - q);
  const xs = uniq([bounds.x0, bounds.x1, ...clip.flatMap((r) => [r.x0, r.x1])]);
  const zs = uniq([bounds.z0, bounds.z1, ...clip.flatMap((r) => [r.z0, r.z1])]);
  const nx = xs.length - 1;
  const out = [];
  let open = new Map(); // key "i0,i1" → 延伸中的矩形
  for (let j = 0; j < zs.length - 1; j++) {
    const cz = (zs[j] + zs[j + 1]) / 2;
    const spans = [];
    let i = 0;
    while (i < nx) {
      const free = (k) => {
        const cx = (xs[k] + xs[k + 1]) / 2;
        return !clip.some((r) => cx > r.x0 && cx < r.x1 && cz > r.z0 && cz < r.z1);
      };
      if (!free(i)) {
        i++;
        continue;
      }
      let e = i + 1;
      while (e < nx && free(e)) e++;
      spans.push([i, e]);
      i = e;
    }
    const next = new Map();
    for (const [i0, i1] of spans) {
      const key = i0 + ',' + i1;
      const r = open.get(key);
      if (r) {
        r.z1 = zs[j + 1];
        next.set(key, r);
        open.delete(key);
      } else next.set(key, { x0: xs[i0], x1: xs[i1], z0: zs[j], z1: zs[j + 1] });
    }
    for (const r of open.values()) out.push(r);
    open = next;
  }
  for (const r of open.values()) out.push(r);
  return out;
}

// 矩形均分成邊長 ≤ GROUND_TILE 的格（各軸等分，拼回原矩形無縫不重疊）
export function groundTiles(r) {
  const nx = Math.max(1, Math.ceil((r.x1 - r.x0) / GROUND_TILE - 1e-9));
  const nz = Math.max(1, Math.ceil((r.z1 - r.z0) / GROUND_TILE - 1e-9));
  const out = [];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      out.push({
        x0: i === 0 ? r.x0 : r.x0 + ((r.x1 - r.x0) * i) / nx,
        x1: i === nx - 1 ? r.x1 : r.x0 + ((r.x1 - r.x0) * (i + 1)) / nx,
        z0: j === 0 ? r.z0 : r.z0 + ((r.z1 - r.z0) * j) / nz,
        z1: j === nz - 1 ? r.z1 : r.z0 + ((r.z1 - r.z0) * (j + 1)) / nz,
      });
    }
  }
  return out;
}

// ---------- 擠出凸多邊形 → convexHull collider（以凸塊重心為原點，避免大座標浮點誤差）----------
function extrudeConvex(RAPIER, poly, bottom, top) {
  const n = poly.length >> 1;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    cx += poly[i * 2];
    cz += poly[i * 2 + 1];
  }
  cx /= n;
  cz /= n;
  const pts = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const x = poly[i * 2] - cx;
    const z = poly[i * 2 + 1] - cz;
    pts.set([x, bottom, z, x, top, z], i * 6);
  }
  const desc = RAPIER.ColliderDesc.convexHull(pts);
  if (!desc) return null;
  return desc.setTranslation(cx, 0, cz);
}

// ---------- walkable 多邊形 → 細分 trimesh（頂點高度 = walkable.heightAt）----------
export function walkableMesh(walkable) {
  const p = cleanPolygon(walkable.poly);
  if (!p) return null;
  const verts = [];
  const index = new Map();
  const vid = (x, z) => {
    const key = x.toFixed(4) + ',' + z.toFixed(4);
    let id = index.get(key);
    if (id === undefined) {
      id = verts.length / 3;
      index.set(key, id);
      verts.push(x, walkable.heightAt(x, z), z);
    }
    return id;
  };
  const tris = [];
  const split = (a, b, c, depth) => {
    const e = Math.max(Math.hypot(a[0] - b[0], a[1] - b[1]), Math.hypot(b[0] - c[0], b[1] - c[1]), Math.hypot(c[0] - a[0], c[1] - a[1]));
    if (e <= WALK_MAX_EDGE || depth >= WALK_MAX_DEPTH) {
      // (x, z) 正向三角形的 3D 法線朝下 → 反轉繞序使法線朝上（+Y）
      tris.push(vid(a[0], a[1]), vid(c[0], c[1]), vid(b[0], b[1]));
      return;
    }
    const ab = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const bc = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2];
    const ca = [(c[0] + a[0]) / 2, (c[1] + a[1]) / 2];
    split(a, ab, ca, depth + 1);
    split(ab, b, bc, depth + 1);
    split(ca, bc, c, depth + 1);
    split(ab, bc, ca, depth + 1);
  };
  const P = (i) => [p[i * 2], p[i * 2 + 1]];
  for (const [a, b, c] of triangulate(p)) split(P(a), P(b), P(c), 0);
  return { vertices: new Float32Array(verts), indices: new Uint32Array(tris) };
}

// ---------- 湖面阻擋柱 ----------
// 作法：
//   1. 湖面多邊形凸分解成凸塊
//   2. 每個與湖面外框重疊的 walkable（紅橋、Z 字步道）先凸分解，每塊外擴 CHANNEL_MARGIN（通道寬 = walkable 寬 + 0.2）
//   3. 對每個湖面凸塊做「凸 − 凸」差集（subtractConvex：沿通道凸塊每條邊切一刀，外側各自成凸塊），
//      依序扣掉所有通道凸塊 → 剩下的凸塊互不重疊且皆凸
//   4. 剩餘凸塊擠出：底 = 湖床 − 1、頂 = 步道 + 1.2（擋住走下水，但角色可走在通道上方的 walkable）
// 回傳凸塊陣列（扁平 [x, z, …]，有號面積為正）
export function lakeBlockPieces(lakePoly, walkables) {
  let pieces = convexDecompose(lakePoly);
  const bb = bbox(lakePoly);
  for (const w of walkables) {
    const wb = bbox(w.poly);
    if (wb.x1 < bb.x0 || wb.x0 > bb.x1 || wb.z1 < bb.z0 || wb.z0 > bb.z1) continue;
    for (const c of convexDecompose(w.poly)) {
      const ch = offsetConvex(c, CHANNEL_MARGIN);
      pieces = pieces.flatMap((P) => subtractConvex(P, ch));
    }
  }
  return pieces.filter((P) => signedAreaFlat(P) >= MIN_PIECE_AREA);
}

function bbox(p) {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    x0 = Math.min(x0, p[i]);
    x1 = Math.max(x1, p[i]);
    z0 = Math.min(z0, p[i + 1]);
    z1 = Math.max(z1, p[i + 1]);
  }
  return { x0, z0, x1, z1 };
}

// 建築輪廓 → 物理凸塊：凸分解後再把過長的凸塊切短（見 MAX_PIECE_SPAN）
export function buildingPieces(poly) {
  return convexDecompose(poly).flatMap((P) => splitConvexBySpan(P, MAX_PIECE_SPAN));
}

// buildings.js 的 colliders（[{ id, poly, base, h }]，地標依 manifest 高度）→ buildWorldColliders 的 osm.B 格式，
// 其餘欄位（bounds、T 湖面）沿用 osm；讓物理建築高度與渲染網格一致
export function osmWithBuildings(osm, colliders) {
  return { ...osm, B: colliders.map((c) => ({ i: c.id, p: c.poly, h: c.h })) };
}

// 湖面資料：優先用參數覆寫 lake = { poly, walkway, bottom }；否則讀 osm-city.json 的 T.basins[0]
// levels（walkway −6 / lakebed −9）在資料中標 est = 1，為推測值
function resolveLake(osm, lake) {
  if (lake === null) return null;
  if (lake) return lake;
  const basin = osm && osm.T && osm.T.basins && osm.T.basins[0];
  if (!basin || !basin.lake || !basin.levels) return null;
  return { poly: basin.lake, walkway: basin.levels.walkway, bottom: basin.levels.lakebed - LAKE_WALL_BELOW };
}

// ---------- 主函式 ----------
// opts：{ osm, terrain, groups = GROUPS.WORLD, lake }
//   lake：undefined = 讀 osm 湖面；null = 不建湖面阻擋；物件 = 覆寫（測試用 mock 湖）
// 回傳統計 { colliders, buildingPieces, heightfields, groundBoxes, walkables, lakePieces, walls, skipped, ms, handles }
//   handles：各類 collider 陣列（heightfield / ground / building / walkable / lake / wall），供除錯與測試辨識命中對象
export function buildWorldColliders(RAPIER, world, { osm, terrain, groups = GROUPS.WORLD, lake } = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const handles = { heightfield: [], ground: [], building: [], walkable: [], lake: [], wall: [] };
  const buildingOf = new Map(); // collider handle → 建築 id
  let skipped = 0;
  const add = (desc, kind) => {
    if (!desc) {
      skipped++;
      return null;
    }
    desc.setCollisionGroups(groups).setSolverGroups(groups);
    const c = world.createCollider(desc);
    handles[kind].push(c);
    return c;
  };

  const b = osm.bounds;
  const bounds = { x0: b.x0, z0: b.z0, x1: b.x1, z1: b.z1 };
  const patches = (terrain && terrain.patches) || [];

  // 地形 patch
  for (const patch of patches) add(patchToHeightfield(RAPIER, patch).desc, 'heightfield');

  // 平地（矩形差集再切成 ≤ GROUND_TILE 的方塊）
  for (const r of rectDifference(bounds, patches.map(patchRect)).flatMap(groundTiles)) {
    const hx = (r.x1 - r.x0) / 2;
    const hz = (r.z1 - r.z0) / 2;
    add(RAPIER.ColliderDesc.cuboid(hx, GROUND_THICKNESS / 2, hz).setTranslation(r.x0 + hx, -GROUND_THICKNESS / 2, r.z0 + hz), 'ground');
  }

  // 建築
  const baseOf = terrain && terrain.buildingBase ? (id) => terrain.buildingBase(id) || 0 : () => 0;
  for (const bd of osm.B) {
    const base = baseOf(bd.i);
    for (const piece of buildingPieces(bd.p)) {
      const c = add(extrudeConvex(RAPIER, piece, base - BUILDING_SINK, base + bd.h), 'building');
      if (c) buildingOf.set(c.handle, bd.i);
    }
  }

  // walkables
  const walkables = (terrain && terrain.walkables) || [];
  for (const w of walkables) {
    const m = walkableMesh(w);
    add(m && m.indices.length ? RAPIER.ColliderDesc.trimesh(m.vertices, m.indices) : null, 'walkable');
  }

  // 湖面阻擋
  const lk = resolveLake(osm, lake);
  if (lk) {
    for (const piece of lakeBlockPieces(lk.poly, walkables)) add(extrudeConvex(RAPIER, piece, lk.bottom, lk.walkway + LAKE_WALL_ABOVE), 'lake');
  }

  // 邊界隱形牆（牆內面貼齊 bounds）
  const W = bounds.x1 - bounds.x0;
  const D = bounds.z1 - bounds.z0;
  const hy = (WALL_HEIGHT + WALL_SINK) / 2;
  const cy = WALL_HEIGHT - hy;
  const t = WALL_THICKNESS / 2;
  const cxm = (bounds.x0 + bounds.x1) / 2;
  const czm = (bounds.z0 + bounds.z1) / 2;
  add(RAPIER.ColliderDesc.cuboid(W / 2 + WALL_THICKNESS, hy, t).setTranslation(cxm, cy, bounds.z0 - t), 'wall');
  add(RAPIER.ColliderDesc.cuboid(W / 2 + WALL_THICKNESS, hy, t).setTranslation(cxm, cy, bounds.z1 + t), 'wall');
  add(RAPIER.ColliderDesc.cuboid(t, hy, D / 2).setTranslation(bounds.x0 - t, cy, czm), 'wall');
  add(RAPIER.ColliderDesc.cuboid(t, hy, D / 2).setTranslation(bounds.x1 + t, cy, czm), 'wall');

  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const count = (k) => handles[k].length;
  return {
    colliders: Object.values(handles).reduce((s, a) => s + a.length, 0),
    buildingPieces: count('building'),
    heightfields: count('heightfield'),
    groundBoxes: count('ground'),
    walkables: count('walkable'),
    lakePieces: count('lake'),
    walls: count('wall'),
    skipped,
    ms: t1 - t0,
    handles,
    buildingOf,
  };
}
