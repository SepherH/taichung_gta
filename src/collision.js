// 碰撞系統：所有建築 / 地標都是軸對齊矩形（AABB），用網格加速查詢。
// 角色與車輛以「圓」近似，與矩形做推出；出界由邊界夾住（隱形牆）。
import { BOUNDS } from './data/city.js';
import { clamp } from './utils.js';

export class CollisionWorld {
  constructor(cellSize = 25) {
    this.cellSize = cellSize;
    this.grid = new Map();
    this.boxes = [];
    this.stamp = 0;
  }

  _key(ix, iz) {
    return ix * 100000 + iz;
  }

  // box: { x0, x1, z0, z1, h, name }
  addBox(box) {
    const b = { h: 1000, name: '', ...box, _stamp: 0 };
    this.boxes.push(b);
    const cs = this.cellSize;
    const ix0 = Math.floor(b.x0 / cs);
    const ix1 = Math.floor(b.x1 / cs);
    const iz0 = Math.floor(b.z0 / cs);
    const iz1 = Math.floor(b.z1 / cs);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const k = this._key(ix, iz);
        let list = this.grid.get(k);
        if (!list) {
          list = [];
          this.grid.set(k, list);
        }
        list.push(b);
      }
    }
    return b;
  }

  // 查詢與矩形範圍相交的格子內所有 box（不重複）
  query(x0, z0, x1, z1, out = []) {
    out.length = 0;
    this.stamp++;
    const cs = this.cellSize;
    const ix0 = Math.floor(x0 / cs);
    const ix1 = Math.floor(x1 / cs);
    const iz0 = Math.floor(z0 / cs);
    const iz1 = Math.floor(z1 / cs);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const list = this.grid.get(this._key(ix, iz));
        if (!list) continue;
        for (const b of list) {
          if (b._stamp === this.stamp) continue;
          b._stamp = this.stamp;
          out.push(b);
        }
      }
    }
    return out;
  }

  // 將圓（x, z, 半徑 r）推出所有矩形，回傳 { x, z, hit, nx, nz }
  // nx/nz 為最後一次推出的方向（用於車輛撞牆判斷）
  resolveCircle(x, z, r, y = 0) {
    let hit = false;
    let nx = 0;
    let nz = 0;
    const tmp = this._tmp || (this._tmp = []);
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      const list = this.query(x - r, z - r, x + r, z + r, tmp);
      for (const b of list) {
        if (y > b.h) continue; // 站在比牆還高的位置（例如跳上矮物）就不擋
        const cx = clamp(x, b.x0, b.x1);
        const cz = clamp(z, b.z0, b.z1);
        let dx = x - cx;
        let dz = z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2);
          const push = r - d;
          dx /= d;
          dz /= d;
          x += dx * push;
          z += dz * push;
          nx = dx;
          nz = dz;
        } else {
          // 圓心在矩形內：沿最短方向推出
          const left = x - b.x0;
          const right = b.x1 - x;
          const top = z - b.z0;
          const bottom = b.z1 - z;
          const m = Math.min(left, right, top, bottom);
          if (m === left) { x = b.x0 - r; nx = -1; nz = 0; }
          else if (m === right) { x = b.x1 + r; nx = 1; nz = 0; }
          else if (m === top) { z = b.z0 - r; nx = 0; nz = -1; }
          else { z = b.z1 + r; nx = 0; nz = 1; }
        }
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

  // 點是否在任何建築內部（鏡頭碰撞用）
  pointBlocked(x, y, z, pad = 0.3) {
    const tmp = this._tmp2 || (this._tmp2 = []);
    const list = this.query(x - pad, z - pad, x + pad, z + pad, tmp);
    for (const b of list) {
      if (y > b.h + pad) continue;
      if (x > b.x0 - pad && x < b.x1 + pad && z > b.z0 - pad && z < b.z1 + pad) return true;
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
