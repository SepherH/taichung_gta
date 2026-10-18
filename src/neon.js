// 霓虹招牌 + 濕亮路面（v1-neon「罪惡之都」夜色）
// 本檔不 import three（THREE 由呼叫端注入），擺放 / 幾何 / 閃爍 / 濕亮參數皆為純邏輯，node 可測。
//
// 對外 API：
//   placeNeonSigns(buildings, { roads, terrain, bodies, skip, seed }) → signs[]（純函式，固定種子可重現）
//     sign = { kind: 'shop'|'blade'|'roof'|'side', id, corners（前面四角 [x,y,z]×4，逆時針自外側看）, nx, nz, cell, mode, phase, tris }
//   buildNeonGeometry(signs, cells) → { pos, nor, uv, neon, vertices, triangles }（Float32Array，非索引三角形）
//   buildNeon(scene, { THREE, registerNight, buildings, roads, terrain, bodies, skip, seed, anisotropy, makeCanvas }) →
//     { mesh, signs, stats, material, dispose }：單一 Mesh（1 draw call）+ 一張共用中文店名貼圖集；夜間亮度走 registerNight
//   registerWetSurface(material)：登記路面材質（world.js 車道、street.js 路口鋪面），夜間 / 下雨時降粗糙度 + 霓虹色 envMap
//   updateNeon(dt, { night, rain, tier })：environment.update 每幀呼叫；只改 uniform 與材質純量，不配置物件、不重建幾何
//   setNeonTier(id)：畫質 id（'low' 關閃爍與濕亮）；environment 也會從 weather.getTier() 帶入
//   neonGain(mode, phase, u, t)：與 shader 相同的閃爍公式（測試用）
import { signedArea, pointInPolygon } from './geom.js';

// 同 utils.js mulberry32（utils.js 依賴 three，本檔保持無 three 可測）
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 參數表 ----------
export const NEON_COLORS = ['#ff2e88', '#b14dff', '#00e5ff', '#ff8a00', '#ffe14d'];
// 不過度露骨的店名（臺灣街頭常見霓虹）
export const NEON_NAMES = ['卡拉OK', '當舖', '檳榔', '舞廳', '旅社', '24H', '按摩', '撞球', '電子遊藝', '酒吧', '小吃部', '汽車旅館', '理容', '彩券', '網咖', '夾娃娃'];
export const NEON_NIGHT_MAX = 2.2; // registerNight 上限（emissiveIntensity = max × night）
export const ANIM_P = 0.15; // 閃爍 / 呼吸 / 跑馬燈比例（10–20%）
export const MAX_SIGNS = 2000;
export const MODE = { steady: 0, flicker: 1, pulse: 2, chase: 3 };

const SKIP_TYPES = new Set(['construction', 'roof', 'bridge']);
const LOW_TYPES = new Set(['house', 'commercial', 'retail', 'yes', 'apartments', 'residential']);
const MIN_AREA = 15;
const TOWER_H = 30;
const SIDE_MIN_H = 24;
const SHOP_P = 0.4; // 填充透天厝：臨路店面帶上方橫招牌
const BLADE_P = 0.16; // 直立招牌（垂直於牆、雙面）
const ROOF_P = 0.3; // 大樓頂招牌（無名稱牌者）
const SIDE_P = 0.2; // 大樓側面直條招牌
const ROAD_PROBE = [1.5, 4, 8, 12]; // 沿外法線探測道路（m）
const ROAD_PAD = 0.3; // 招牌任一點離路面至少
const SHOPFRONT_H = 3.2; // 與 facade.js 首層店面帶一致
const WALL_OFF = 0.1; // 貼牆招牌離牆（店面帶在 0.03 m）
const BLADE_IN = 0.15;
const BLADE_OUT = 0.95;
const BLADE_Y = 3.5;
const BLADE_H = 2.6;
const ROOF_INSET = 0.6;
const ROOF_LIFT = 1.3; // 女兒牆最高 1.1 m
const SIDE_W = 2;
const SIDE_H = 8;

// 濕亮路面（mid 以上）
export const WET = { night: 0.85, rain: 1, roughness: 0.3, metalness: 0.35, env: 1.1, dayEnv: 0.35 };
const WET_TIERS = new Set(['mid', 'high', 'ultra']);

// ---------- 貼圖集（1024²：上半 4 × 8 橫向格 256 × 64；下半 16 × 2 直向格 64 × 256） ----------
export const ATLAS_SIZE = 1024;
export const H_CELLS = 32;
export const V_CELLS = 32;

export function atlasCells(S = ATLAS_SIZE) {
  const cells = [];
  const hw = S / 4;
  const hh = S / 16;
  for (let k = 0; k < H_CELLS; k++) cells.push({ x: (k % 4) * hw, y: Math.floor(k / 4) * hh, w: hw, h: hh, vertical: false });
  const vw = S / 16;
  const vh = S / 4;
  for (let k = 0; k < V_CELLS; k++) cells.push({ x: (k % 16) * vw, y: S / 2 + Math.floor(k / 16) * vh, w: vw, h: vh, vertical: true });
  // canvas y 向下、貼圖 flipY → v = 1 − y / S；內縮半像素避免混到鄰格
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    c.index = i;
    c.name = NEON_NAMES[(i * 5 + (c.vertical ? 3 : 0)) % NEON_NAMES.length];
    c.color = NEON_COLORS[(i + Math.floor(i / NEON_NAMES.length)) % NEON_COLORS.length];
    c.u0 = (c.x + 0.5) / S;
    c.u1 = (c.x + c.w - 0.5) / S;
    c.v0 = 1 - (c.y + c.h - 0.5) / S;
    c.v1 = 1 - (c.y + 0.5) / S;
  }
  // 背面：橫向格 0 左上角的暗底
  cells.back = { u: 2 / S, v: 1 - 2 / S };
  return cells;
}

export function drawNeonAtlas(ctx, cells, S = ATLAS_SIZE) {
  ctx.fillStyle = '#0b0612';
  ctx.fillRect(0, 0, S, S);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const c of cells) {
    ctx.fillStyle = '#140a1c';
    ctx.fillRect(c.x + 3, c.y + 3, c.w - 6, c.h - 6);
    ctx.shadowColor = c.color;
    ctx.shadowBlur = 10;
    ctx.strokeStyle = c.color;
    ctx.lineWidth = 3;
    ctx.strokeRect(c.x + 6, c.y + 6, c.w - 12, c.h - 12);
    ctx.fillStyle = c.color;
    const chars = Array.from(c.name);
    if (c.vertical) {
      const step = Math.min((c.h - 24) / chars.length, c.w * 0.75);
      ctx.font = `bold ${Math.floor(step * 0.9)}px sans-serif`;
      const y0 = c.y + c.h / 2 - (step * (chars.length - 1)) / 2;
      chars.forEach((ch, i) => ctx.fillText(ch, c.x + c.w / 2, y0 + i * step));
    } else {
      const size = Math.min(c.h * 0.62, ((c.w - 28) / chars.length) * 1.1);
      ctx.font = `bold ${Math.floor(size)}px sans-serif`;
      ctx.fillText(c.name, c.x + c.w / 2, c.y + c.h / 2 + 1);
    }
    ctx.shadowBlur = 0;
  }
}

// 濕路 envMap：等距長方投影漸層（上暗紫、地平線霓虹色帶、下深藍），只給材質 envMap 用
export function drawWetEnv(ctx, w = 256, h = 128) {
  const bands = [['#0a0618', 0], ['#1c0f3a', 0.3], ['#3a1650', 0.42], ['#0f1430', 0.55], ['#05060f', 0.7]];
  for (let i = 0; i < bands.length; i++) {
    const y0 = Math.floor(bands[i][1] * h);
    const y1 = i + 1 < bands.length ? Math.floor(bands[i + 1][1] * h) : h;
    ctx.fillStyle = bands[i][0];
    ctx.fillRect(0, y0, w, y1 - y0);
  }
  const rng = mulberry32(0x0e0e0e);
  for (let i = 0; i < 28; i++) {
    ctx.fillStyle = NEON_COLORS[i % NEON_COLORS.length];
    const bw = 3 + Math.floor(rng() * 10);
    const bh = 2 + Math.floor(rng() * 8);
    ctx.fillRect(Math.floor(rng() * (w - bw)), Math.floor(h * (0.4 + rng() * 0.12)), bw, bh);
  }
}

// ---------- 道路索引（線段格網；點到路面距離） ----------
class RoadGrid {
  constructor(roads, cell = 25) {
    this.cell = cell;
    this.map = new Map();
    for (const r of roads) {
      const pts = r.pts;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const seg = { ax: a.x, az: a.z, bx: b.x, bz: b.z, hw: r.hw };
        const pad = r.hw + 2;
        const x0 = Math.floor((Math.min(a.x, b.x) - pad) / cell);
        const x1 = Math.floor((Math.max(a.x, b.x) + pad) / cell);
        const z0 = Math.floor((Math.min(a.z, b.z) - pad) / cell);
        const z1 = Math.floor((Math.max(a.z, b.z) + pad) / cell);
        for (let gx = x0; gx <= x1; gx++) {
          for (let gz = z0; gz <= z1; gz++) {
            const k = `${gx},${gz}`;
            if (!this.map.has(k)) this.map.set(k, []);
            this.map.get(k).push(seg);
          }
        }
      }
    }
  }

  // 點落在任一路面（半寬 + pad）內
  onRoad(x, z, pad = 0) {
    const list = this.map.get(`${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`);
    if (!list) return false;
    for (const s of list) {
      const ex = s.bx - s.ax;
      const ez = s.bz - s.az;
      const L2 = ex * ex + ez * ez;
      let t = L2 > 0 ? ((x - s.ax) * ex + (z - s.az) * ez) / L2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = s.ax + ex * t - x;
      const dz = s.az + ez * t - z;
      const r = s.hw + pad;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }
}

// service = true：含 service 道路（招牌淨空用）；false：同 facade 臨路判定（不含 service）
export function makeRoadGrid(roads, { service = false } = {}) {
  return new RoadGrid((roads || []).filter((r) => !r.under && !r.foot && (service || r.type !== 'service')));
}

// 輪廓邊（外法線依繞向校正）
function edgesOf(p) {
  const n = p.length / 2;
  const sgn = signedArea(p) >= 0 ? 1 : -1;
  const out = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = p[i * 2];
    const az = p[i * 2 + 1];
    const bx = p[j * 2];
    const bz = p[j * 2 + 1];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1e-3) continue;
    const tx = (bx - ax) / L;
    const tz = (bz - az) / L;
    let nx = -tz * sgn;
    let nz = tx * sgn;
    // 再以點測校正（自交 / 退化輪廓保險）
    const mx = (ax + bx) / 2;
    const mz = (az + bz) / 2;
    if (pointInPolygon(mx + nx * 0.2, mz + nz * 0.2, p)) {
      nx = -nx;
      nz = -nz;
    }
    out.push({ ax, az, bx, bz, L, tx, tz, nx, nz, mx, mz });
  }
  return out;
}

function polyArea(p) {
  return Math.abs(signedArea(p));
}

function facesRoad(e, grid) {
  for (const d of ROAD_PROBE) if (grid.onRoad(e.mx + e.nx * d, e.mz + e.nz * d)) return true;
  return false;
}

// 平貼牆面的招牌（中心沿邊 s、離牆 off、寬 w、y0–y1）；前面朝外
// 「右」取 (nz, −nx)：自外側面向牆時的右手方向（不依輪廓繞向），文字不鏡像、三角形逆時針朝外
function flatSign(e, s, off, w, y0, y1) {
  const cx = e.ax + e.tx * s + e.nx * off;
  const cz = e.az + e.tz * s + e.nz * off;
  const hw = w / 2;
  const lx = cx - e.nz * hw;
  const lz = cz + e.nx * hw;
  const rx = cx + e.nz * hw;
  const rz = cz - e.nx * hw;
  return [[lx, y0, lz], [rx, y0, rz], [rx, y1, rz], [lx, y1, lz]];
}

function cornersClear(corners, grid) {
  for (const c of corners) if (grid.onRoad(c[0], c[2], ROAD_PAD)) return false;
  return true;
}

function pickAnim(rng) {
  if (rng() >= ANIM_P) return [MODE.steady, rng()];
  return [1 + (Math.floor(rng() * 3) % 3), rng()];
}

function pickCell(rng, vertical) {
  const k = Math.floor(rng() * 32) % 32;
  return vertical ? H_CELLS + k : k;
}

// buildings：citymodel.buildings；bodies：facade.bodies（退台主體高）；skip：Set<id>（地標 glb 取代者）
export function placeNeonSigns(buildings, { roads = [], terrain = null, bodies = new Map(), skip = new Set(), seed = 1 } = {}) {
  const facingGrid = makeRoadGrid(roads);
  const roadGrid = makeRoadGrid(roads, { service: true });
  const baseOf = terrain && typeof terrain.buildingBase === 'function' ? (id) => terrain.buildingBase(id) : () => 0;
  const signs = [];
  for (const b of buildings) {
    if (signs.length >= MAX_SIGNS) break;
    if (skip.has(b.id) || SKIP_TYPES.has(b.type)) continue;
    const p = b.poly;
    const fullH = Number.isFinite(b.height) ? b.height : b.h;
    if (!p || p.length < 6 || !(fullH > 0) || polyArea(p) < MIN_AREA) continue;
    const rng = mulberry32((Math.imul(seed >>> 0, 2654435761) ^ b.id) >>> 0);
    const body = bodies.get(b.id);
    const h = body ? body.height : fullH;
    const base = baseOf(b.id);
    const top = base + h;
    const E = edgesOf(p);
    const facing = E.filter((e) => facesRoad(e, facingGrid)).sort((a, c) => c.L - a.L);
    const tower = fullH >= TOWER_H;
    const push = (s) => {
      if (signs.length < MAX_SIGNS) signs.push(s);
    };

    // 填充透天厝：店面帶上方橫招牌
    if (b.inferred && b.type === 'house' && !tower && facing.length && rng() < SHOP_P) {
      const e = facing[0];
      if (e.L >= 3.5) {
        const w = Math.min(Math.max(e.L * 0.75, 1.6), 4.4);
        const sh = Math.min(Math.max(w / 4, 0.6), 1.1);
        const y0 = base + Math.min(SHOPFRONT_H, h * 0.4) + 0.1;
        const corners = flatSign(e, e.L / 2, WALL_OFF, w, y0, y0 + sh);
        if (y0 + sh <= top - 0.2 && cornersClear(corners, roadGrid)) {
          const [mode, phase] = pickAnim(rng);
          push({ kind: 'shop', id: b.id, corners, nx: e.nx, nz: e.nz, cell: pickCell(rng, false), mode, phase, tris: 2, wall: e });
        }
      }
    }

    // 中低層：直立招牌（垂直牆面、雙面）
    if (!tower && LOW_TYPES.has(b.type) && facing.length && rng() < BLADE_P) {
      const e = facing[Math.floor(rng() * facing.length) % facing.length];
      if (e.L >= 4) {
        const s = rng() < 0.5 ? 0.5 : e.L - 0.5;
        const px = e.ax + e.tx * s;
        const pz = e.az + e.tz * s;
        const y0 = base + BLADE_Y;
        const y1 = Math.min(y0 + BLADE_H, top - 0.3);
        if (y1 - y0 >= 1.6) {
          const ix = px + e.nx * BLADE_IN;
          const iz = pz + e.nz * BLADE_IN;
          const ox = px + e.nx * BLADE_OUT;
          const oz = pz + e.nz * BLADE_OUT;
          const corners = [[ix, y0, iz], [ox, y0, oz], [ox, y1, oz], [ix, y1, iz]];
          if (cornersClear(corners, roadGrid)) {
            const [mode, phase] = pickAnim(rng);
            // 前面法線 (−nz, nx)：面向此面時「右」= 牆外法線（內緣 → 外緣由左到右）；另一面由幾何鏡射產生
            push({ kind: 'blade', id: b.id, corners, nx: -e.nz, nz: e.nx, cell: pickCell(rng, true), mode, phase, tris: 4, wall: e });
          }
        }
      }
    }

    // 大樓頂：無名稱牌者沿臨路最長邊（否則最長邊）立招牌，前面朝外、背面暗底
    if (tower && !b.name && rng() < ROOF_P) {
      const e = facing[0] || E.slice().sort((a, c) => c.L - a.L)[0];
      if (e && e.L >= 8) {
        const w = Math.min(Math.max(e.L * 0.5, 6), 18);
        const y0 = top + ROOF_LIFT;
        const corners = flatSign(e, e.L / 2, -ROOF_INSET, w, y0, y0 + w / 4);
        const cx = (corners[0][0] + corners[1][0]) / 2;
        const cz = (corners[0][2] + corners[1][2]) / 2;
        if (pointInPolygon(cx, cz, p) && cornersClear(corners, roadGrid)) {
          const [mode, phase] = pickAnim(rng);
          push({ kind: 'roof', id: b.id, corners, nx: e.nx, nz: e.nz, cell: pickCell(rng, false), mode, phase, tris: 4, wall: e });
        }
      }
    }

    // 大樓側面：臨路邊近牆角的直條招牌
    if (fullH >= SIDE_MIN_H && facing.length && rng() < SIDE_P) {
      const e = facing[facing.length - 1];
      if (e.L >= 6) {
        const y1 = top - 3;
        const y0 = Math.max(y1 - SIDE_H, base + 6);
        const corners = flatSign(e, rng() < 0.5 ? 1.2 + SIDE_W / 2 : e.L - 1.2 - SIDE_W / 2, WALL_OFF, SIDE_W, y0, y1);
        if (y1 - y0 >= 4 && cornersClear(corners, roadGrid)) {
          const [mode, phase] = pickAnim(rng);
          push({ kind: 'side', id: b.id, corners, nx: e.nx, nz: e.nz, cell: pickCell(rng, true), mode, phase, tris: 2, wall: e });
        }
      }
    }
  }
  return signs;
}

// ---------- 幾何（非索引；屬性 neon = (mode, phase, 招牌內水平座標 0–1)） ----------
export function buildNeonGeometry(signs, cells = atlasCells()) {
  let tris = 0;
  for (const s of signs) tris += s.tris;
  const nv = tris * 3;
  const pos = new Float32Array(nv * 3);
  const nor = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  const neon = new Float32Array(nv * 3);
  let v = 0;
  const vert = (c, nx, nz, u, vv, s, lu) => {
    pos[v * 3] = c[0];
    pos[v * 3 + 1] = c[1];
    pos[v * 3 + 2] = c[2];
    nor[v * 3] = nx;
    nor[v * 3 + 1] = 0;
    nor[v * 3 + 2] = nz;
    uv[v * 2] = u;
    uv[v * 2 + 1] = vv;
    neon[v * 3] = s.mode;
    neon[v * 3 + 1] = s.phase;
    neon[v * 3 + 2] = lu;
    v++;
  };
  // 四角 q（左下、右下、右上、左上）→ 兩三角形；uvs 同序
  const quad = (q, nx, nz, uvs, s, lus) => {
    for (const i of [0, 1, 2, 0, 2, 3]) vert(q[i], nx, nz, uvs[i][0], uvs[i][1], s, lus[i]);
  };
  const back = cells.back;
  for (const s of signs) {
    const c = cells[s.cell];
    const [a, b, cc, d] = s.corners;
    const front = [[c.u0, c.v0], [c.u1, c.v0], [c.u1, c.v1], [c.u0, c.v1]];
    if (s.kind === 'blade') {
      // 雙面都正讀：正面 (a,b,c,d)，反面 (b,a,d,c)，各自 u 由左到右
      quad([a, b, cc, d], s.nx, s.nz, front, s, [0, 1, 1, 0]);
      quad([b, a, d, cc], -s.nx, -s.nz, front, s, [0, 1, 1, 0]);
    } else {
      quad([a, b, cc, d], s.nx, s.nz, front, s, [0, 1, 1, 0]);
      if (s.tris === 4) {
        const bk = [back.u, back.v];
        quad([b, a, d, cc], -s.nx, -s.nz, [bk, bk, bk, bk], { mode: 0, phase: 0 }, [0, 0, 0, 0]);
      }
    }
  }
  return { pos, nor, uv, neon, vertices: nv, triangles: tris };
}

// ---------- 閃爍公式（shader 同式；JS 版供測試） ----------
const fract = (x) => x - Math.floor(x);
export function neonGain(mode, phase, u, t) {
  if (mode > 2.5) return 0.35 + 0.65 * (fract(u * 5 - t * 1.2 + phase) >= 0.5 ? 1 : 0);
  if (mode > 1.5) return 0.55 + 0.45 * Math.sin(t * 2.2 + phase * 6.2831853);
  if (mode > 0.5) {
    const k = Math.floor(t * 9 + phase * 97);
    return fract(Math.sin(k * 12.9898 + phase * 78.233) * 43758.5453) < 0.18 ? 0.15 : 1;
  }
  return 1;
}

const VERT_DECL = 'attribute vec3 neon;\nvarying vec3 vNeon;\n';
const FRAG_DECL = 'uniform float uNeonTime;\nuniform float uNeonAnim;\nvarying vec3 vNeon;\n';
const FRAG_GAIN = `#include <emissivemap_fragment>
	float neonG = 1.0;
	if ( uNeonAnim > 0.5 ) {
		float nm = vNeon.x;
		float np = vNeon.y;
		if ( nm > 2.5 ) neonG = 0.35 + 0.65 * step( 0.5, fract( vNeon.z * 5.0 - uNeonTime * 1.2 + np ) );
		else if ( nm > 1.5 ) neonG = 0.55 + 0.45 * sin( uNeonTime * 2.2 + np * 6.2831853 );
		else if ( nm > 0.5 ) neonG = fract( sin( floor( uNeonTime * 9.0 + np * 97.0 ) * 12.9898 + np * 78.233 ) * 43758.5453 ) < 0.18 ? 0.15 : 1.0;
	}
	totalEmissiveRadiance *= neonG;`;

// ---------- 執行期狀態（模組單例；每幀不配置） ----------
const state = { time: 0, tier: 'high', anim: true, wetOn: true, wet: 0, envMap: null };
const controllers = []; // { uniforms }
const wetSurfaces = []; // { material, roughness, metalness, envMapIntensity, hasEnv }

export function neonState() {
  return state;
}

export function registerWetSurface(material) {
  if (!material) return material;
  const entry = {
    material,
    roughness: Number.isFinite(material.roughness) ? material.roughness : 1,
    metalness: Number.isFinite(material.metalness) ? material.metalness : 0,
    envMapIntensity: Number.isFinite(material.envMapIntensity) ? material.envMapIntensity : 1,
    hasEnv: false,
  };
  wetSurfaces.push(entry);
  syncWetEnv(entry);
  return material;
}

export function wetSurfaceCount() {
  return wetSurfaces.length;
}

// envMap 只在 tier 切換 / 登記時改（換 shader 需重新編譯，非每幀）
function syncWetEnv(e) {
  const want = state.wetOn && !!state.envMap;
  const target = want ? state.envMap : null;
  if (want === e.hasEnv && e.material.envMap === target) return; // 貼圖 / 開關都沒變才略過
  e.hasEnv = want;
  e.material.envMap = target;
  if (!want) {
    e.material.roughness = e.roughness;
    e.material.metalness = e.metalness;
    e.material.envMapIntensity = e.envMapIntensity;
  }
  e.material.needsUpdate = true;
}

export function setWetEnvMap(tex) {
  state.envMap = tex || null;
  for (const e of wetSurfaces) syncWetEnv(e);
}

export function setNeonTier(id) {
  const tier = typeof id === 'string' ? id : id && id.id;
  if (!tier || tier === state.tier) return;
  state.tier = tier;
  state.anim = tier !== 'low';
  state.wetOn = WET_TIERS.has(tier);
  for (const e of wetSurfaces) syncWetEnv(e);
  if (!state.wetOn) state.wet = 0;
}

// 濕度目標值：夜間 × 0.85、下雨 × 1，取大者；low tier 為 0
export function wetness(night, rain) {
  if (!state.wetOn) return 0;
  const w = Math.max((night || 0) * WET.night, (rain || 0) * WET.rain);
  return w < 0 ? 0 : w > 1 ? 1 : w;
}

export function updateNeon(dt, { night = 0, rain = 0, tier = null } = {}) {
  if (tier) setNeonTier(tier);
  if (state.anim && Number.isFinite(dt) && dt > 0) state.time = (state.time + dt) % 3600;
  for (let i = 0; i < controllers.length; i++) {
    const u = controllers[i].uniforms;
    u.uNeonTime.value = state.time;
    u.uNeonAnim.value = state.anim ? 1 : 0;
  }
  const w = wetness(night, rain);
  state.wet = w;
  const envK = w * (WET.dayEnv + (WET.env - WET.dayEnv) * (night || 0));
  for (let i = 0; i < wetSurfaces.length; i++) {
    const e = wetSurfaces[i];
    if (!e.hasEnv) continue;
    const m = e.material;
    m.roughness = e.roughness + (WET.roughness - e.roughness) * w;
    m.metalness = e.metalness + (WET.metalness - e.metalness) * w;
    m.envMapIntensity = envK;
  }
}

// 測試用：清空單例
export function resetNeon() {
  controllers.length = 0;
  wetSurfaces.length = 0;
  state.time = 0;
  state.tier = 'high';
  state.anim = true;
  state.wetOn = true;
  state.wet = 0;
  state.envMap = null;
}

function defaultCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// ---------- three 組裝 ----------
export function buildNeon(scene, {
  THREE, registerNight = null, unregisterNight = null, buildings = [], roads = [], terrain = null, bodies = new Map(), skip = new Set(),
  seed = 20261018, anisotropy = 4, makeCanvas = defaultCanvas,
} = {}) {
  const signs = placeNeonSigns(buildings, { roads, terrain, bodies, skip, seed });
  const cells = atlasCells();
  const g = buildNeonGeometry(signs, cells);
  const stats = { signs: signs.length, triangles: g.triangles, drawCalls: 0, animated: signs.filter((s) => s.mode !== MODE.steady).length, kinds: {} };
  for (const s of signs) stats.kinds[s.kind] = (stats.kinds[s.kind] || 0) + 1;

  const canvas = makeCanvas(ATLAS_SIZE, ATLAS_SIZE);
  drawNeonAtlas(canvas.getContext('2d'), cells);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;

  const envCanvas = makeCanvas(256, 128);
  drawWetEnv(envCanvas.getContext('2d'));
  const envTex = new THREE.CanvasTexture(envCanvas);
  envTex.colorSpace = THREE.SRGBColorSpace;
  envTex.mapping = THREE.EquirectangularReflectionMapping;
  setWetEnvMap(envTex);

  const uniforms = { uNeonTime: { value: state.time }, uNeonAnim: { value: state.anim ? 1 : 0 } };
  const material = new THREE.MeshStandardMaterial({
    color: 0x3a3440, map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.55, metalness: 0.1,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = VERT_DECL + shader.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvNeon = neon;');
    shader.fragmentShader = FRAG_DECL + shader.fragmentShader.replace('#include <emissivemap_fragment>', FRAG_GAIN);
  };
  material.customProgramCacheKey = () => 'neon-signs';
  if (registerNight) registerNight(material, NEON_NIGHT_MAX);
  const ctrl = { uniforms };
  controllers.push(ctrl);

  let mesh = null;
  if (signs.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(g.pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(g.nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(g.uv, 2));
    geo.setAttribute('neon', new THREE.BufferAttribute(g.neon, 3));
    geo.computeBoundingSphere();
    mesh = new THREE.Mesh(geo, material);
    mesh.name = 'neon-signs';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    if (scene) scene.add(mesh);
    stats.drawCalls = 1;
  }

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    const i = controllers.indexOf(ctrl);
    if (i >= 0) controllers.splice(i, 1);
    if (mesh) {
      if (mesh.parent) mesh.parent.remove(mesh);
      mesh.geometry.dispose();
    }
    if (unregisterNight) unregisterNight(material);
    material.onBeforeCompile = () => {}; // 還原掛勾：不再注入 shader / uniform
    material.dispose();
    tex.dispose();
    if (state.envMap === envTex) setWetEnvMap(null); // 濕路材質先脫離 envMap 再釋放
    envTex.dispose(); // PMREM 產物由 renderer 掛在此貼圖的 dispose 事件上一併釋放
  }
  return { mesh, signs, stats, material, uniforms, dispose };
}
