// 碰撞系統：建築以 OSM 輪廓多邊形表示，用空間網格加速查詢。
// 角色與車輛以「圓」近似，與多邊形做推出；出界由世界邊界夾住（隱形牆）。
import { BOUNDS } from './citymodel.js';
import { SpatialGrid, pointInPolygon, closestOnPolygon, polygonBBox } from './geom.js';
import { clamp } from './utils.js';

export class CollisionWorld {
  constructor(cellSize = 25) {
    this.grid = new SpatialGrid(cellSize);
    this.polys = [];
    this._tmp = [];
    this._cp = {};
  }

  // poly：扁平輪廓 [x0, z0, …]；h：高度（站得比它高就不擋）
  addPolygon(poly, h = 1000, name = '') {
    const bbox = polygonBBox(poly);
    const p = { poly, h, name, bbox };
    this.polys.push(p);
    this.grid.insert(p, bbox.x0, bbox.z0, bbox.x1, bbox.z1);
    return p;
  }

  // 將圓（x, z, 半徑 r）推出所有多邊形，回傳 { x, z, hit, nx, nz }
  // nx/nz 為最後一次推出的方向（用於車輛撞牆判斷）
  resolveCircle(x, z, r, y = 0) {
    let hit = false;
    let nx = 0;
    let nz = 0;
    const cp = this._cp;
    for (let iter = 0; iter < 4; iter++) {
      let moved = false;
      const list = this.grid.query(x - r, z - r, x + r, z + r, this._tmp);
      for (const b of list) {
        if (y > b.h) continue; // 站在比牆還高的位置就不擋
        const bb = b.bbox;
        if (x < bb.x0 - r || x > bb.x1 + r || z < bb.z0 - r || z > bb.z1 + r) continue;
        const inside = pointInPolygon(x, z, b.poly);
        closestOnPolygon(x, z, b.poly, cp);
        if (!inside && cp.d2 >= r * r) continue;
        const d = Math.sqrt(cp.d2);
        let ux;
        let uz;
        if (d > 1e-6) {
          ux = (x - cp.x) / d;
          uz = (z - cp.z) / d;
          if (inside) {
            ux = -ux;
            uz = -uz;
          }
        } else {
          // 剛好在邊上：用該邊的外法線（輪廓為北方朝上逆時針 → (x, z) 平面的外法線 = (-dz, dx)）
          const n = b.poly.length / 2;
          const i = cp.edge;
          const j = (i + 1) % n;
          const ex = b.poly[j * 2] - b.poly[i * 2];
          const ez = b.poly[j * 2 + 1] - b.poly[i * 2 + 1];
          const el = Math.hypot(ex, ez) || 1;
          ux = -ez / el;
          uz = ex / el;
        }
        x = cp.x + ux * r;
        z = cp.z + uz * r;
        nx = ux;
        nz = uz;
        hit = true;
        moved = true;
      }
      if (!moved) break;
    }
    // 隱形牆：夾在世界範圍內
    const cx = clamp(x, BOUNDS.minX + r, BOUNDS.maxX - r);
    const cz = clamp(z, BOUNDS.minZ + r, BOUNDS.maxZ - r);
    if (cx !== x || cz !== z) {
      nx = Math.sign(cx - x);
      nz = Math.sign(cz - z);
      x = cx;
      z = cz;
      hit = true;
    }
    return { x, z, hit, nx, nz };
  }

  // 點是否在任何建築內部（或距外牆 pad 以內）；鏡頭碰撞與下車位置用
  pointBlocked(x, y, z, pad = 0.3) {
    const list = this.grid.query(x - pad, z - pad, x + pad, z + pad, this._tmp);
    for (const b of list) {
      if (y > b.h + pad) continue;
      const bb = b.bbox;
      if (x < bb.x0 - pad || x > bb.x1 + pad || z < bb.z0 - pad || z > bb.z1 + pad) continue;
      if (pointInPolygon(x, z, b.poly)) return true;
      if (closestOnPolygon(x, z, b.poly, this._cp).d2 < pad * pad) return true;
    }
    return false;
  }
}

// 圓與一組圓（車輛等動態物體）之間的推出，只移動第一個圓
// circles: [{ x, z, r }]
export function pushOutOfCircles(x, z, r, circles) {
  let hit = false;
  let nx = 0;
  let nz = 0;
  for (const c of circles) {
    const dx = x - c.x;
    const dz = z - c.z;
    const rr = r + c.r;
    const d2 = dx * dx + dz * dz;
    if (d2 >= rr * rr) continue;
    const d = Math.sqrt(d2) || 0.0001;
    const push = rr - d;
    const ux = d2 > 1e-8 ? dx / d : 1;
    const uz = d2 > 1e-8 ? dz / d : 0;
    x += ux * push;
    z += uz * push;
    nx = ux;
    nz = uz;
    hit = true;
  }
  return { x, z, hit, nx, nz };
}
