// 秋紅谷與老虎城下沉廣場的程序化細節網格：跨湖紅橋、白色 Z 字湖上步道、湖邊木棧板與紅色矮側板、
// 東側退台白色邊緣與踏階、坡道 / 步道兩側灰色金屬欄杆、下沉廣場矮牆立面 / 大階梯踏階 / 中央木平台。
// 資料全部來自 osm-city.json 的 T（經 terrain.patches[].feature.src 取得）與 terrain.walkables / 高度場，不寫死座標；
// 高度一律取 terrain（heightAt / walkable 平面），不另算。碰撞仍用高度場與 walkables（本檔只追加木平台 walkable）。
// 效能：依材質合併成 3 個幾何（木作 / 金屬 / 石材，頂點色區分顏色）→ 3 draw call。
// 紅橋：有 glb（manifest qiuhonggu_red_bridge）時由 glb 呈現外觀——建構時 redBridgeModel = true 直接不產生，
//   或事後 dropProceduralRedBridge 移除（紅橋三角形寫在各幾何最前段）；walkables 碰撞資料一律不動。
// 尺寸、顏色凡標「推測」者只是參數預設值（依 docs/ref/tiger-city-reference.md 註明之節次），不是確定事實。
import * as THREE from 'three';
import { pointInPolygon, closestOnPolygon, closestOnSegment, polygonCentroid } from './geom.js';

// 紅橋 glb 的 manifest id（landmarks/index.js 載入成功時，程序化紅橋讓位）
export const RED_BRIDGE_LANDMARK_ID = 'qiuhonggu_red_bridge';

// ---------- 參數 ----------
// 紅橋 / Z 字步道（§6.2「低矮平直的步橋」「甲板灰色木板、朱紅色鋼板欄杆 / 側板、細柱墩」「白色曲折湖上步道」）
const DECK_THICK = 0.2; // 甲板厚（m，推測）
const DECK_INSET = 0.02; // 甲板邊緣比 walkable 範圍內縮（m）：頂點不落在 walkable 邊界上
const RAIL_H = 1.1; // 側板 / 欄杆高（m，任務規格；實際高度查無，推測）
const PIER_SPACING = 6; // 柱墩間距（m，任務規格；實際間距查無，推測）
const PIER_SIZE = 0.2; // 柱墩斷面邊長（m，推測「細柱墩」）
const PIER_INSET = 0.3; // 柱墩距甲板邊緣（m，推測）
const PIER_EMBED = 0.3; // 柱墩插入湖床深度（m）
const ZIG_POST_SPACING = 2; // Z 字步道欄杆立柱間距（m，推測）
const POST_SIZE = 0.06; // 欄杆立柱斷面（m，推測「細欄杆」）
const RAIL_BAND = 0.05; // 扶手 / 中欄帶高（m，推測）
// 湖邊步道（§6.2「灰色木棧板，靠湖側紅色矮側板」）
// 棧板寬、高度與分段由 terrain.js lakesides 決定（高度場唯一來源）
const LOW_PANEL_H = 0.4; // 紅色矮側板高（m，推測）
const LOW_PANEL_INSET = 0.05; // 矮側板距湖岸（m）
// 坡道 / 步道欄杆（§6.2「坡道與步道是灰色金屬欄杆」；§6.4 坡頂沿人行道查無 → 不畫）
const GUARD_H = 1.1; // 欄杆高（m，推測）
const GUARD_SPACING = 2.5; // 立柱間距（m，推測）
const GUARD_OFFSET = 0.15; // 欄杆在步道邊緣外（m，推測）
const GUARD_MIN_DEPTH = -0.05; // 高度場低於此值（谷內）才設欄杆
const LAKE_SIDE_BAND = 6; // 步道中心距湖岸此距離內時，靠湖側不設灰色欄杆（改由紅色矮側板收邊）
// 東側退台（§6.3「白色邊線的多層平台」）
const CURB_W = 0.25; // 平台邊緣白色收邊寬（m，與 world.js 退台白線同寬，推測）
const CURB_UP = 0.08; // 收邊頂高出邊線高度（m，推測）
const CURB_DOWN = 0.12; // 收邊側面往下延伸（m）
const TERRACE_STAIR_AT = [0.25, 0.5, 0.75]; // 踏階沿 terrace_line 的位置比例（推測：§6.2 只確認有多層平台，踏階位置查無）
const TERRACE_STAIR_W = 2.4; // 踏階寬（m，推測）
const TERRACE_STAIR_RISE = 0.15; // 踏階級高（m，推測，同下沉廣場）
const MARCH_STEP = 0.1; // 踏階剖面沿線取樣（m）
const MARCH_MAX = 60; // 踏階剖面最長（m）
// 老虎城下沉廣場（§1「寬大階梯下到 B1、木平台」；§6.5 深度推測 4–5 m）
const PLAZA_WALL = 0.3; // = terrain.js PLAZA_WALL：高度場剖面在距邊界此距離降到廣場底
// 矮牆立面距廣場邊界 = PLAZA_WALL + 網格 cell·√2：三角網格把牆邊陡坡攤到約一格對角線內，立面放在其外側才不會被網格坡面擋住（壓頂板蓋住其間）
// 大階梯級高（m，任務規格，推測）。級深不另設：= stairs walkable 水平長 ÷ 級數（terrain.js 斜面 9 m ÷ 30 級 = 0.30 m），
// 讓踏面與碰撞斜面一致；任務規格的級深 0.35 m 需把 terrain.js PLAZA_STAIR_RUN 改為 10.5 m 才能對齊
const STAIR_RISE = 0.15;
const PLATFORM_SCALE = 0.35; // 木平台 = 廣場地面區（扣大階梯）以重心縮放此比例（推測：§1 只確認有木平台，尺寸查無）
const PLATFORM_H = 0.3; // 木平台高（m，推測；≤ 玩家可跨上高差 0.35 m）
const PLATFORM_MARGIN = 1; // 木平台離牆 / 階梯至少（m）

// 顏色（頂點色）
const C = {
  deck: new THREE.Color('#8d8a84'), // 灰色木板（§6.2）
  vermilion: new THREE.Color('#c8331f'), // 朱紅色鋼板（§6.2，色值推測）
  zigzag: new THREE.Color('#e9e9e4'), // 白色湖上步道（§6.2）
  lakeside: new THREE.Color('#7f7b74'), // 湖邊灰色木棧板（§6.2，色值推測）
  lowPanel: new THREE.Color('#b8321f'), // 紅色矮側板（§6.2，色值推測）
  guard: new THREE.Color('#8a8f94'), // 灰色金屬欄杆（§6.2，色值推測）
  pier: new THREE.Color('#6d6d6a'), // 柱墩（色值推測）
  stone: new THREE.Color('#c9c6bf'), // 淺灰石材（任務規格，色值推測）
  stair: new THREE.Color('#bdb9b0'), // 階梯踏面（色值推測）
  curb: new THREE.Color('#ececea'), // 退台白色收邊（§6.3）
  platform: new THREE.Color('#9a6b43'), // 木平台（§1，色值推測）
};

// ---------- 幾何寫入器（非索引三角形 + 頂點色） ----------
class Writer {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.col = [];
  }

  get triangles() {
    return this.pos.length / 9;
  }

  // 凸多邊形（[[x, y, z], …]）扇形三角化；hint = 期望法線方向（決定繞序）
  face(pts, hint, color) {
    if (pts.length < 3) return;
    const [a, b, c] = pts;
    let nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    let ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    let nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-10) return;
    nx /= len;
    ny /= len;
    nz /= len;
    const flip = nx * hint[0] + ny * hint[1] + nz * hint[2] < 0;
    if (flip) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    for (let i = 1; i + 1 < pts.length; i++) {
      const tri = flip ? [pts[0], pts[i + 1], pts[i]] : [pts[0], pts[i], pts[i + 1]];
      for (const p of tri) {
        this.pos.push(p[0], p[1], p[2]);
        this.nor.push(nx, ny, nz);
        this.col.push(color.r, color.g, color.b);
      }
    }
  }

  // 直立四邊形：(ax, az) → (bx, bz)，兩端各自的底 / 頂高度；法線朝 (hx, hz)
  wall(ax, az, bx, bz, ya0, ya1, yb0, yb1, hx, hz, color) {
    this.face([[ax, ya0, az], [bx, yb0, bz], [bx, yb1, bz], [ax, ya1, az]], [hx, 0, hz], color);
  }

  // 直立方柱（斷面 s × s，軸對齊）
  post(x, z, y0, y1, s, color) {
    const h = s / 2;
    this.wall(x - h, z + h, x + h, z + h, y0, y1, y0, y1, 0, 1, color);
    this.wall(x + h, z - h, x - h, z - h, y0, y1, y0, y1, 0, -1, color);
    this.wall(x + h, z + h, x + h, z - h, y0, y1, y0, y1, 1, 0, color);
    this.wall(x - h, z - h, x - h, z + h, y0, y1, y0, y1, -1, 0, color);
  }

  toGeometry() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.computeBoundingSphere();
    return geo;
  }
}

// ---------- 小工具 ----------
const _cp = {};

// walkables 依 id 前綴（# 之前）分組，還原每組的中心折線與半寬（terrain.js segmentWalkables 的逆運算）
// 回傳 [{ id, kind, hw, pts: [{ x, z }], segs: [walkable] }]
function walkableChains(walkables, kinds) {
  const groups = new Map();
  for (const w of walkables) {
    if (!kinds.has(w.kind)) continue;
    const key = w.id.split('#')[0];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(w);
  }
  const chains = [];
  for (const [id, list] of groups) {
    list.sort((a, b) => Number(a.id.split('#')[1]) - Number(b.id.split('#')[1]));
    const pts = [];
    let hw = 0;
    for (const w of list) {
      const p = w.poly;
      hw = Math.hypot(p[0] - p[6], p[1] - p[7]) / 2;
      const L = Math.hypot(p[2] - p[0], p[3] - p[1]);
      const ux = ((p[2] - p[0]) / L) * hw;
      const uz = ((p[3] - p[1]) / L) * hw;
      const a = { x: (p[0] + p[6]) / 2 + ux, z: (p[1] + p[7]) / 2 + uz };
      const b = { x: (p[2] + p[4]) / 2 - ux, z: (p[3] + p[5]) / 2 - uz };
      if (!pts.length) pts.push(a);
      pts.push(b);
    }
    chains.push({ id, kind: list[0].kind, hw, pts, segs: list });
  }
  return chains;
}

// 折線各段的單位方向與左法線 n = (−uz, ux)
function segFrames(pts) {
  const out = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const L = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z) || 1;
    const ux = (pts[i + 1].x - pts[i].x) / L;
    const uz = (pts[i + 1].z - pts[i].z) / L;
    out.push({ ux, uz, nx: -uz, nz: ux, L });
  }
  return out;
}

// 折線一側（s = +1 左 / −1 右）偏移 off 的邊線：兩端延伸 ext；轉折處外側斜切（兩點）、內側取斜接交點
function sideLine(pts, fr, s, off, ext) {
  const line = [];
  const f0 = fr[0];
  line.push({ x: pts[0].x - f0.ux * ext + s * f0.nx * off, z: pts[0].z - f0.uz * ext + s * f0.nz * off });
  for (let i = 1; i < pts.length - 1; i++) {
    const a = fr[i - 1];
    const b = fr[i];
    const J = pts[i];
    const cr = a.ux * b.uz - a.uz * b.ux;
    if (s * cr > 0) {
      const k = off / (1 + a.nx * b.nx + a.nz * b.nz);
      line.push({ x: J.x + s * (a.nx + b.nx) * k, z: J.z + s * (a.nz + b.nz) * k });
    } else {
      line.push({ x: J.x + s * a.nx * off, z: J.z + s * a.nz * off });
      line.push({ x: J.x + s * b.nx * off, z: J.z + s * b.nz * off });
    }
  }
  const fl = fr[fr.length - 1];
  const pl = pts[pts.length - 1];
  line.push({ x: pl.x + fl.ux * ext + s * fl.nx * off, z: pl.z + fl.uz * ext + s * fl.nz * off });
  return line;
}

function inAnyWalkable(walkables, x, z, pad) {
  for (const w of walkables) {
    const b = w.bbox;
    if (x < b.x0 - pad || x > b.x1 + pad || z < b.z0 - pad || z > b.z1 + pad) continue;
    if (pointInPolygon(x, z, w.poly)) return true;
    if (pad > 0 && closestOnPolygon(x, z, w.poly, _cp).d2 < pad * pad) return true;
  }
  return false;
}

// 直線 p + t·u 與凸多邊形（[{ x, z }]，任一方向）交集的 t 範圍；無交集回傳 null
function clipLineConvex(px, pz, ux, uz, poly) {
  let t0 = -Infinity;
  let t1 = Infinity;
  const n = poly.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    area += a.x * b.z - b.x * a.z;
  }
  const sgn = area >= 0 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    // 內側：sgn · cross(b − a, q − a) ≥ 0
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const c0 = sgn * (ex * (pz - a.z) - ez * (px - a.x));
    const c1 = sgn * (ex * uz - ez * ux);
    if (Math.abs(c1) < 1e-12) {
      if (c0 < -1e-9) return null; // 與邊平行：在邊線上（如階梯頂線）視為在內
      continue;
    }
    const t = -c0 / c1;
    if (c1 > 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
  }
  return t0 < t1 ? [t0, t1] : null;
}

// ---------- 紅橋 / Z 字步道 ----------
// 甲板（walkable 平面高，walkable 範圍內縮 DECK_INSET）+ 兩端封板到地面 + 側板或欄杆 + 柱墩
function buildDeckChain(chain, terrain, W, style, deckTop) {
  const { pts, hw, segs } = chain;
  const fr = segFrames(pts);
  const y = segs[0].heightAt(pts[0].x, pts[0].z); // 湖上甲板為水平面（terrain.js segmentWalkables plane = [0, 0, deck]）
  const yb = y - DECK_THICK;
  const deckColor = style === 'bridge' ? C.deck : C.zigzag;
  const e = hw - DECK_INSET;
  // 甲板：每段矩形（端點段延伸到 walkable 端緣）+ 轉折處外側楔形
  for (let i = 0; i < fr.length; i++) {
    const f = fr[i];
    const a = pts[i];
    const b = pts[i + 1];
    const ea = i === 0 ? e : 0;
    const eb = i === fr.length - 1 ? e : 0;
    const q = [
      [a.x - f.ux * ea + f.nx * e, y, a.z - f.uz * ea + f.nz * e],
      [b.x + f.ux * eb + f.nx * e, y, b.z + f.uz * eb + f.nz * e],
      [b.x + f.ux * eb - f.nx * e, y, b.z + f.uz * eb - f.nz * e],
      [a.x - f.ux * ea - f.nx * e, y, a.z - f.uz * ea - f.nz * e],
    ];
    W.wood.face(q, [0, 1, 0], deckColor);
    for (const v of q) deckTop.push(v);
    if (i > 0) {
      const g = fr[i - 1];
      const s = g.ux * f.uz - g.uz * f.ux > 0 ? -1 : 1; // 外側
      const tri = [[a.x, y, a.z], [a.x + s * g.nx * e, y, a.z + s * g.nz * e], [a.x + s * f.nx * e, y, a.z + s * f.nz * e]];
      W.wood.face(tri, [0, 1, 0], deckColor);
      for (const v of tri) deckTop.push(v);
    }
  }
  // 兩端封板：甲板頂到端緣地面（與湖岸步道銜接不露縫）
  for (const [p, f, dir] of [[pts[0], fr[0], -1], [pts[pts.length - 1], fr[fr.length - 1], 1]]) {
    const cx = p.x + f.ux * e * dir;
    const cz = p.z + f.uz * e * dir;
    const l = { x: cx + f.nx * e, z: cz + f.nz * e };
    const r = { x: cx - f.nx * e, z: cz - f.nz * e };
    const gl = Math.min(yb, terrain.heightAt(l.x, l.z) - 0.05);
    const gr = Math.min(yb, terrain.heightAt(r.x, r.z) - 0.05);
    W.wood.wall(l.x, l.z, r.x, r.z, gl, y, gr, y, f.ux * dir, f.uz * dir, deckColor);
  }
  // 側邊：紅橋 = 朱紅色鋼板側板（甲板底到 RAIL_H，雙面）；Z 字步道 = 白色細欄杆（立柱 + 扶手 + 中欄）
  for (const s of [1, -1]) {
    const line = sideLine(pts, fr, s, hw, hw);
    if (style === 'bridge') {
      for (let i = 0; i + 1 < line.length; i++) {
        const a = line[i];
        const b = line[i + 1];
        W.metal.wall(a.x, a.z, b.x, b.z, yb, y + RAIL_H, yb, y + RAIL_H, -(b.z - a.z), b.x - a.x, C.vermilion);
      }
    } else {
      const inner = sideLine(pts, fr, s, hw - POST_SIZE, hw - POST_SIZE);
      railAlong(W.metal, inner, () => y, ZIG_POST_SPACING, RAIL_H, C.zigzag);
    }
  }
  // 柱墩：沿中心線每 PIER_SPACING，兩側各一，由湖床（插入 PIER_EMBED）到甲板底
  const total = fr.reduce((sum, g) => sum + g.L, 0);
  let piers = 0;
  for (let sPos = PIER_SPACING / 2; sPos < total; sPos += PIER_SPACING) {
    const c = pointAlong(pts, fr, sPos);
    for (const s of [1, -1]) {
      const x = c.x + s * c.nx * (hw - PIER_INSET);
      const z = c.z + s * c.nz * (hw - PIER_INSET);
      const g = terrain.heightAt(x, z);
      if (yb - g < PIER_EMBED) continue;
      W.stone.post(x, z, g - PIER_EMBED, yb, PIER_SIZE, C.pier);
      piers++;
    }
  }
  return piers;
}

// 折線上弧長 s 處的點與該段左法線
function pointAlong(pts, fr, s) {
  let acc = 0;
  for (let i = 0; i < fr.length; i++) {
    if (s <= acc + fr[i].L || i === fr.length - 1) {
      const t = Math.min(fr[i].L, s - acc);
      return { x: pts[i].x + fr[i].ux * t, z: pts[i].z + fr[i].uz * t, nx: fr[i].nx, nz: fr[i].nz };
    }
    acc += fr[i].L;
  }
  return { x: pts[0].x, z: pts[0].z, nx: fr[0].nx, nz: fr[0].nz };
}

// 沿邊線（[{ x, z }]）畫欄杆：每 spacing 一根立柱、轉折點也有立柱；扶手（頂）與中欄為雙面直立帶
// groundY(x, z) = 立柱底高度
function railAlong(w, line, groundY, spacing, height, color) {
  const posts = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i];
    const b = line[i + 1];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.round(L / spacing));
    for (let k = 0; k < n; k++) posts.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
  }
  posts.push(line[line.length - 1]);
  for (const p of posts) p.y = groundY(p.x, p.z);
  railPosts(w, [posts], height, color);
}

// posts：多段立柱序列 [[{ x, y, z }]]；每段相鄰立柱之間畫扶手與中欄
function railPosts(w, runs, height, color) {
  for (const run of runs) {
    for (let i = 0; i < run.length; i++) {
      const p = run[i];
      w.post(p.x, p.z, p.y - 0.05, p.y + height, POST_SIZE, color);
      if (i === 0) continue;
      const a = run[i - 1];
      const hx = -(p.z - a.z);
      const hz = p.x - a.x;
      for (const top of [height, height * 0.5]) {
        w.wall(a.x, a.z, p.x, p.z, a.y + top - RAIL_BAND, a.y + top, p.y + top - RAIL_BAND, p.y + top, hx, hz, color);
      }
    }
  }
}

// ---------- 湖邊木棧板 + 紅色矮側板 ----------
// 棧板：terrain.lakesides 的固定高度平板（高度場已在 terrain.js 壓到棧板面以下；其下地形過高的分段已略過），
// 每塊 = 頂面 + 外緣封邊（往下到地面）；矮側板：各塊湖岸邊往外 LOW_PANEL_INSET，底 = 棧板面、高 LOW_PANEL_H；紅橋 / Z 字步道 walkable 範圍留開口
function buildLakeside(lakeside, terrain, W, deckWalkables) {
  const y = lakeside.y;
  for (const pc of lakeside.pieces) {
    const Q = pc.quad; // 內緣 a0、a1（湖岸）→ 外緣 b1、b0
    W.wood.face([[Q[0], y, Q[1]], [Q[2], y, Q[3]], [Q[4], y, Q[5]], [Q[6], y, Q[7]]], [0, 1, 0], C.lakeside);
    const g1 = terrain.heightAt(Q[4], Q[5]) - 0.05;
    const g0 = terrain.heightAt(Q[6], Q[7]) - 0.05;
    W.wood.wall(Q[4], Q[5], Q[6], Q[7], g1, y, g0, y, Q[4] - Q[2], Q[5] - Q[3], C.lakeside);
    const [ax, az, bx, bz] = pc.edge;
    const L = Math.hypot(bx - ax, bz - az) || 1;
    // 往外（棧板側）的單位向量：由湖岸邊指向外緣
    const ox = (Q[6] - Q[0]) / (Math.hypot(Q[6] - Q[0], Q[7] - Q[1]) || 1);
    const oz = (Q[7] - Q[1]) / (Math.hypot(Q[6] - Q[0], Q[7] - Q[1]) || 1);
    const pa = { x: ax + ox * LOW_PANEL_INSET, z: az + oz * LOW_PANEL_INSET };
    const pb = { x: bx + ox * LOW_PANEL_INSET, z: bz + oz * LOW_PANEL_INSET };
    if (L < 1e-6 || inAnyWalkable(deckWalkables, pa.x, pa.z, 0.2) || inAnyWalkable(deckWalkables, pb.x, pb.z, 0.2)) continue;
    W.metal.wall(pa.x, pa.z, pb.x, pb.z, y, y + LOW_PANEL_H, y, y + LOW_PANEL_H, -ox, -oz, C.lowPanel);
  }
}

// ---------- 東側退台：白色收邊 + 踏階 ----------
function buildTerrace(basin, terrain, W) {
  // 收邊：terrain.terraceLines（平台高度再低一點的等高線，已平滑）每段做成細長條（頂 + 兩側面）；
  // 平滑後的線不一定恰在等高線上，頂 / 底取「等高線高度與兩側地面」的最高 / 最低再加減，不會埋進坡面
  const segs = terrain.terraceLines;
  const hw = CURB_W / 2;
  for (let i = 0; i + 5 < segs.length; i += 6) {
    const ax = segs[i];
    const ay = segs[i + 1];
    const az = segs[i + 2];
    const bx = segs[i + 3];
    const by = segs[i + 4];
    const bz = segs[i + 5];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1e-3) continue;
    const nx = (-(bz - az) / L) * hw;
    const nz = ((bx - ax) / L) * hw;
    const span = (x, y, z) => {
      const h1 = terrain.heightAt(x + nx, z + nz);
      const h2 = terrain.heightAt(x - nx, z - nz);
      return [Math.min(y, h1, h2) - CURB_DOWN, Math.max(y, h1, h2) + CURB_UP];
    };
    const [a0, a1] = span(ax, ay, az);
    const [b0, b1] = span(bx, by, bz);
    W.stone.face([[ax + nx, a1, az + nz], [bx + nx, b1, bz + nz], [bx - nx, b1, bz - nz], [ax - nx, a1, az - nz]], [0, 1, 0], C.curb);
    W.stone.wall(ax + nx, az + nz, bx + nx, bz + nz, a0, a1, b0, b1, nx, nz, C.curb);
    W.stone.wall(ax - nx, az - nz, bx - nx, bz - nz, a0, a1, b0, b1, -nx, -nz, C.curb);
  }
  // 踏階：terrace_line 上各點往湖（最近湖岸方向）拉一道剖面，上端到路面高、下端到 walkway；
  // 剖面高度以 TERRACE_STAIR_RISE 量化（無條件進位，踏面不低於地面），平台段即為平鋪步道
  const line = (basin.features || []).find((f) => f.k === 'terrace_line');
  if (!line || !basin.lake) return 0;
  const walkway = basin.levels.walkway;
  let flights = 0;
  for (const t of TERRACE_STAIR_AT) {
    const px = line.p[0] + (line.p[2] - line.p[0]) * t;
    const pz = line.p[1] + (line.p[3] - line.p[1]) * t;
    closestOnPolygon(px, pz, basin.lake, _cp);
    const d = Math.hypot(_cp.x - px, _cp.z - pz);
    if (d < 1) continue;
    const ux = (_cp.x - px) / d;
    const uz = (_cp.z - pz) / d;
    // 往上找到路面高（或 MARCH_MAX）為起點
    let s0 = 0;
    while (s0 > -MARCH_MAX && terrain.heightAt(px + ux * s0, pz + uz * s0) < -0.01) s0 -= MARCH_STEP;
    const prof = [];
    for (let s = s0; s < s0 + 2 * MARCH_MAX; s += MARCH_STEP) {
      const x = px + ux * s;
      const z = pz + uz * s;
      if (pointInPolygon(x, z, basin.lake)) break;
      const h = terrain.heightAt(x, z);
      prof.push({ s, h, q: Math.ceil(h / TERRACE_STAIR_RISE - 1e-6) * TERRACE_STAIR_RISE });
      if (h <= walkway + 0.01) break;
    }
    if (prof.length < 2) continue;
    stairFlight(W.stone, terrain, px, pz, ux, uz, prof, TERRACE_STAIR_W / 2);
    flights++;
  }
  return flights;
}

// 依量化剖面畫一道踏階：同一量化高度的連續段 = 一個踏面，高度改變處 = 踢面（朝下坡方向），兩側側面到地面
function stairFlight(w, terrain, px, pz, ux, uz, prof, hw) {
  const nx = -uz * hw;
  const nz = ux * hw;
  const P = (s) => ({ x: px + ux * s, z: pz + uz * s });
  let start = 0;
  for (let i = 1; i <= prof.length; i++) {
    if (i < prof.length && Math.abs(prof[i].q - prof[start].q) < 1e-6) continue;
    const s0 = prof[start].s;
    const s1 = i < prof.length ? prof[i].s : prof[prof.length - 1].s;
    const y = prof[start].q;
    const a = P(s0);
    const b = P(s1);
    w.face([[a.x + nx, y, a.z + nz], [b.x + nx, y, b.z + nz], [b.x - nx, y, b.z - nz], [a.x - nx, y, a.z - nz]], [0, 1, 0], C.stair);
    for (const sd of [1, -1]) {
      const ga = terrain.heightAt(a.x + nx * sd, a.z + nz * sd) - 0.05;
      const gb = terrain.heightAt(b.x + nx * sd, b.z + nz * sd) - 0.05;
      w.wall(a.x + nx * sd, a.z + nz * sd, b.x + nx * sd, b.z + nz * sd, Math.min(ga, y), y, Math.min(gb, y), y, nx * sd, nz * sd, C.stair);
    }
    if (i < prof.length) {
      const yn = prof[i].q;
      w.wall(b.x + nx, b.z + nz, b.x - nx, b.z - nz, Math.min(y, yn), Math.max(y, yn), Math.min(y, yn), Math.max(y, yn), ux * Math.sign(y - yn), uz * Math.sign(y - yn), C.stair);
    }
    start = i;
  }
}

// ---------- 坡道 / 步道兩側灰色金屬欄杆 ----------
function buildGuards(basin, terrain, W, footways, deckWalkables) {
  const inBasin = footways.filter((f) => !f.bridge && f.pts.some((p) => pointInPolygon(p.x, p.z, basin.p)));
  const segs = [];
  for (const f of inBasin) for (let i = 0; i + 1 < f.pts.length; i++) segs.push({ a: f.pts[i], b: f.pts[i + 1], hw: f.hw, f });
  const seg = { x: 0, z: 0, d2: 0, t: 0 };
  // 點是否在其他步道（寬 + 欄杆偏移 + 0.3 m）上：路口不擋路
  const onOtherPath = (x, z, self) => {
    for (const s of segs) {
      if (s.f === self) continue;
      const r = s.hw + GUARD_OFFSET + 0.3;
      if (closestOnSegment(x, z, s.a.x, s.a.z, s.b.x, s.b.z, seg).d2 < r * r) return true;
    }
    return false;
  };
  const lakeDist = (x, z) => (basin.lake ? Math.sqrt(closestOnPolygon(x, z, basin.lake, _cp).d2) : Infinity);
  let posts = 0;
  for (const f of inBasin) {
    const fr = segFrames(f.pts);
    const total = fr.reduce((sum, g) => sum + g.L, 0);
    const n = Math.max(1, Math.round(total / GUARD_SPACING));
    for (const sd of [1, -1]) {
      const runs = [];
      let run = [];
      for (let k = 0; k <= n; k++) {
        const c = pointAlong(f.pts, fr, (total * k) / n);
        const off = f.hw + GUARD_OFFSET;
        const x = c.x + sd * c.nx * off;
        const z = c.z + sd * c.nz * off;
        const y = terrain.heightAt(x, z);
        const dc = lakeDist(c.x, c.z);
        const lakeSide = dc < LAKE_SIDE_BAND && lakeDist(x, z) < dc;
        const ok = y < GUARD_MIN_DEPTH && pointInPolygon(x, z, basin.p) && !lakeSide &&
          !(basin.lake && pointInPolygon(x, z, basin.lake)) && !onOtherPath(x, z, f) && !inAnyWalkable(deckWalkables, x, z, 0.3);
        if (ok) run.push({ x, y, z });
        else {
          if (run.length > 1) runs.push(run);
          run = [];
        }
      }
      if (run.length > 1) runs.push(run);
      railPosts(W.metal, runs, GUARD_H, C.guard);
      for (const r of runs) posts += r.length;
    }
  }
  return posts;
}

// ---------- 老虎城下沉廣場 ----------
function buildPlaza(plaza, cell, terrain, W, stats) {
  const wallFace = PLAZA_WALL + cell * Math.SQRT2;
  const poly = plaza.p;
  const n = poly.length / 2;
  const depth = plaza.depth;
  const stairsSet = new Set(plaza.stairs || []);
  const V = (i) => ({ x: poly[((i + n) % n) * 2], z: poly[((i + n) % n) * 2 + 1] });
  // 各邊內法線（指向面積重心一側，同 terrain.js 階梯 walkable）
  const c = polygonCentroid(poly);
  const edges = [];
  for (let k = 0; k < n; k++) {
    const a = V(k);
    const b = V(k + 1);
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    let nx = -(b.z - a.z) / L;
    let nz = (b.x - a.x) / L;
    if ((c.x - a.x) * nx + (c.z - a.z) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    edges.push({ a, b, L, ux: (b.x - a.x) / L, uz: (b.z - a.z) / L, nx, nz, stairs: stairsSet.has(k), off: stairsSet.has(k) ? 0 : wallFace });
  }
  // 立面內縮多邊形（非階梯邊內縮 wallFace）：相鄰偏移線交點
  const inset = offsetLines(edges);
  // 矮牆立面（淺灰石材）：內縮線上，廣場底到路面高，朝廣場內；牆頂壓頂板覆蓋邊界到立面之間
  edges.forEach((e, k) => {
    if (e.stairs) return;
    const p = inset[k];
    const q = inset[(k + 1) % n];
    W.stone.wall(p.x, p.z, q.x, q.z, depth - 0.05, 0.02, depth - 0.05, 0.02, e.nx, e.nz, C.stone);
    W.stone.face([[e.a.x, 0.02, e.a.z], [e.b.x, 0.02, e.b.z], [q.x, 0.02, q.z], [p.x, 0.02, p.z]], [0, 1, 0], C.stone);
  });
  // 大階梯：由 stairs walkable 取斜面（水平長、方向、平面）；級數 = 深度 ÷ STAIR_RISE，級深 = 水平長 ÷ 級數
  const stairWalk = terrain.walkables.filter((w) => w.kind === 'stairs' && w.id === `stairs:${plaza.n || 'plaza'}`);
  let steps = 0;
  let stairRun = 0;
  for (const w of stairWalk) {
    const p = w.poly;
    const ax = p[0];
    const az = p[1];
    const ex = p[2] - ax;
    const ez = p[3] - az;
    const eL = Math.hypot(ex, ez);
    const run = Math.hypot(p[4] - p[2], p[5] - p[3]);
    const dx = (p[4] - p[2]) / run;
    const dz = (p[5] - p[3]) / run;
    const count = Math.max(1, Math.round(Math.abs(depth) / STAIR_RISE));
    const tread = run / count;
    stairRun = tread;
    const ux = ex / eL;
    const uz = ez / eL;
    let prevY = w.heightAt(ax, az);
    for (let k = 0; k < count; k++) {
      const d0 = k * tread;
      const d1 = (k + 1) * tread;
      const y = w.heightAt(ax + dx * (d0 + tread / 2), az + dz * (d0 + tread / 2)); // 斜面通過踏面中點
      const r0 = clipLineConvex(ax + dx * d0, az + dz * d0, ux, uz, inset);
      const r1 = clipLineConvex(ax + dx * d1, az + dz * d1, ux, uz, inset);
      if (!r0 || !r1) continue;
      const at = (d, t) => [ax + dx * d + ux * t, az + dz * d + uz * t];
      const [p00x, p00z] = at(d0, r0[0]);
      const [p01x, p01z] = at(d0, r0[1]);
      const [p10x, p10z] = at(d1, r1[0]);
      const [p11x, p11z] = at(d1, r1[1]);
      W.stone.face([[p00x, y, p00z], [p01x, y, p01z], [p11x, y, p11z], [p10x, y, p10z]], [0, 1, 0], C.stair);
      W.stone.wall(p00x, p00z, p01x, p01z, y, prevY, y, prevY, dx, dz, C.stair);
      prevY = y;
      steps++;
    }
  }
  // 木平台：廣場地面區（扣掉大階梯）重心縮放 PLATFORM_SCALE；離牆 / 階梯不足 PLATFORM_MARGIN 就再縮
  const floor = [];
  for (let k = 0; k < n; k++) {
    const e = edges[k];
    // 地面區：階梯邊改內縮一個階梯水平長
    floor.push({ ...e, off: e.stairs ? stairRunTotal(stairWalk) : e.off });
  }
  const floorPoly = offsetLines(floor);
  const fc = centroidOf(floorPoly);
  let scale = PLATFORM_SCALE;
  let plat = null;
  for (let tries = 0; tries < 8 && !plat; tries++, scale *= 0.8) {
    const cand = floorPoly.map((p) => ({ x: fc.x + (p.x - fc.x) * scale, z: fc.z + (p.z - fc.z) * scale }));
    const ok = cand.every((p) => floor.every((e) => (p.x - e.a.x) * e.nx + (p.z - e.a.z) * e.nz >= e.off + PLATFORM_MARGIN));
    if (ok) plat = cand;
  }
  if (plat) {
    const top = depth + PLATFORM_H;
    terrain.addWalkable(`platform:${plaza.n || 'plaza'}`, 'deck', plat.flatMap((p) => [p.x, p.z]), [0, 0, top]);
    W.wood.face(plat.map((p) => [p.x, top, p.z]), [0, 1, 0], C.platform);
    for (let k = 0; k < plat.length; k++) {
      const a = plat[k];
      const b = plat[(k + 1) % plat.length];
      const mx = (a.x + b.x) / 2 - fc.x;
      const mz = (a.z + b.z) / 2 - fc.z;
      W.wood.wall(a.x, a.z, b.x, b.z, depth - 0.05, top, depth - 0.05, top, mx, mz, C.platform);
    }
  }
  stats.plazaSteps = steps;
  stats.plazaTread = stairRun;
  stats.platform = plat ? plat.map((p) => [p.x, p.z]) : null;
}

function stairRunTotal(stairWalk) {
  if (!stairWalk.length) return 0;
  const p = stairWalk[0].poly;
  return Math.hypot(p[4] - p[2], p[5] - p[3]);
}

// 各邊沿內法線偏移 e.off 後，相鄰兩線交點（多邊形頂點 k 的偏移點 = 邊 k − 1 與邊 k 的交點）；回傳對應邊 k 起點的陣列
function offsetLines(edges) {
  const n = edges.length;
  const out = [];
  for (let k = 0; k < n; k++) {
    const e1 = edges[(k - 1 + n) % n];
    const e2 = edges[k];
    const p1 = { x: e1.a.x + e1.nx * e1.off, z: e1.a.z + e1.nz * e1.off };
    const p2 = { x: e2.a.x + e2.nx * e2.off, z: e2.a.z + e2.nz * e2.off };
    const den = e1.ux * e2.uz - e1.uz * e2.ux;
    if (Math.abs(den) < 1e-9) {
      out.push(p2);
      continue;
    }
    const t = ((p2.x - p1.x) * e2.uz - (p2.z - p1.z) * e2.ux) / den;
    out.push({ x: p1.x + e1.ux * t, z: p1.z + e1.uz * t });
  }
  return out;
}

function centroidOf(pts) {
  return polygonCentroid(pts.flatMap((p) => [p.x, p.z]));
}

// ---------- 建構 ----------
// terrain：唯一高度場實例；footways：citymodel.surfaceFootways（{ pts, hw, bridge }，坡道 / 步道欄杆用）
// redBridgeModel：紅橋改由 glb 呈現時為 true（不產生程序化紅橋甲板 / 側板 / 柱墩）
// 回傳 { group, meshes, stats, deckTop（紅橋甲板頂面頂點 [[x, y, z]]，供測試對照 walkables） }
export function buildQiuhonggu(terrain, { footways = [], redBridgeModel = false } = {}) {
  const W = { wood: new Writer(), metal: new Writer(), stone: new Writer() };
  const stats = { bridges: 0, boardwalks: 0, piers: 0, terraceFlights: 0, guardPosts: 0, plazaSteps: 0, plazaTread: 0, platform: null };
  const deckTop = [];
  const deckWalkables = terrain.walkables.filter((w) => w.kind === 'bridge' || w.kind === 'boardwalk');

  // 紅橋先寫（各幾何最前段），記下頂點數供 dropProceduralRedBridge 截掉；Z 字步道隨後
  const chains = walkableChains(terrain.walkables, new Set(['bridge', 'boardwalk']));
  if (!redBridgeModel) {
    for (const chain of chains.filter((c) => c.kind === 'bridge')) {
      stats.piers += buildDeckChain(chain, terrain, W, 'bridge', deckTop);
      stats.bridges++;
    }
  }
  const bridgeVerts = Object.fromEntries(Object.entries(W).map(([k, w]) => [k, w.pos.length / 3]));
  for (const chain of chains.filter((c) => c.kind !== 'bridge')) {
    stats.piers += buildDeckChain(chain, terrain, W, 'zigzag', []);
    stats.boardwalks++;
  }
  for (const p of terrain.patches) {
    const src = p.feature && p.feature.src;
    if (!src) continue;
    if (p.kind === 'basin') {
      for (const ls of terrain.lakesides.filter((l) => l.id === `lakeside:${src.i}`)) buildLakeside(ls, terrain, W, deckWalkables);
      stats.terraceFlights += buildTerrace(src, terrain, W);
      stats.guardPosts += buildGuards(src, terrain, W, footways, deckWalkables);
    } else if (p.kind === 'plaza') {
      buildPlaza(src, p.cell, terrain, W, stats);
    }
  }

  const group = new THREE.Group();
  group.name = 'qiuhonggu';
  group.userData.redBridge = redBridgeModel ? 'glb' : 'procedural';
  const mats = {
    wood: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 }),
    metal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.35, side: THREE.DoubleSide }),
    stone: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 }),
  };
  const meshes = [];
  let triangles = 0;
  for (const key of Object.keys(W)) {
    const w = W[key];
    if (!w.pos.length) continue;
    const mesh = new THREE.Mesh(w.toGeometry(), mats[key]);
    mesh.name = `qiuhonggu-${key}`;
    mesh.geometry.userData.redBridgeVerts = bridgeVerts[key];
    mesh.castShadow = key !== 'wood';
    mesh.receiveShadow = true;
    group.add(mesh);
    meshes.push(mesh);
    triangles += w.triangles;
  }
  stats.drawCalls = meshes.length;
  stats.triangles = triangles;
  return { group, meshes, stats, deckTop };
}

// 紅橋 glb 載入後移除程序化紅橋（甲板 / 側板 / 柱墩）：截掉各幾何最前段的紅橋頂點；重複呼叫無作用。回傳移除的三角形數
export function dropProceduralRedBridge(group) {
  if (group.userData.redBridge === 'glb') return 0;
  let removed = 0;
  for (const mesh of [...group.children]) {
    const g = mesh.geometry;
    const n = g && g.userData.redBridgeVerts;
    if (!n) continue;
    const count = g.attributes.position.count;
    for (const name of Object.keys(g.attributes)) {
      const attr = g.attributes[name];
      g.setAttribute(name, new THREE.BufferAttribute(attr.array.slice(n * attr.itemSize), attr.itemSize, attr.normalized));
    }
    g.userData.redBridgeVerts = 0;
    g.computeBoundingSphere();
    removed += n / 3;
    if (n === count) group.remove(mesh);
  }
  group.userData.redBridge = 'glb';
  return removed;
}

// 相容介面（main.js 仍會呼叫；待刪）：紅橋 / Z 字步道甲板上的 world 步道 ribbon 已在 world.js 源頭略過，這裡不再改動幾何。
// 回傳 world.js 源頭略過的三角形數（root.userData.deckOverlaySkipped；只回報一次，之後 0），維持「移除數 / 再跑 0」的語意
export function stripDeckOverlays(root) {
  const n = root.userData.deckOverlaySkipped || 0;
  root.userData.deckOverlaySkipped = 0;
  return n;
}
