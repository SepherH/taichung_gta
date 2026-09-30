// 瞄準純函式（不 import three）：觸控弱吸附 pickAimAssist、手槍射線解算 resolveShot、後座 recoilKick
// 向量一律用 { x, y, z } 純物件；out 參數由呼叫端重用（每幀 / 每發不配置新物件）
// 座標：X 東、Z 南、Y 上；yaw 前方 = (sin yaw, cos yaw)
import { AIM_ASSIST_ANGLE, AIM_ASSIST_RANGE, AIM_POINT_HEIGHT } from './defs.js';

const _tp = { x: 0, y: 0, z: 0 };
const _rd = { x: 0, y: 0, z: 0 };

// 觸控弱吸附：在 candidates（actor[]）中找與射線夾角 ≤ maxAngle、距離 ≤ maxDist、isVisible(actor, point) 為真、夾角最小者
// 找到 → 把「origin → 該行人胸口」單位方向寫入 out 並回傳 actor（只修正這一發的方向，不鎖定、不轉鏡頭）；
// 找不到 → out = dir（正規化）並回傳 null
// opts：{ maxAngle, maxDist, height（瞄準點離腳底高度）, isVisible, skip(actor) → true 略過 }
export function pickAimAssist(origin, dir, candidates, out, opts = {}) {
  const maxAngle = opts.maxAngle ?? AIM_ASSIST_ANGLE;
  const maxDist = opts.maxDist ?? AIM_ASSIST_RANGE;
  const h = opts.height ?? AIM_POINT_HEIGHT;
  const dl = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const fx = dir.x / dl;
  const fy = dir.y / dl;
  const fz = dir.z / dl;
  out.x = fx;
  out.y = fy;
  out.z = fz;
  if (!candidates || !candidates.length) return null;
  const cosMax = Math.cos(maxAngle);
  let best = null;
  let bestCos = cosMax;
  let bx = 0;
  let by = 0;
  let bz = 0;
  for (let i = 0; i < candidates.length; i++) {
    const a = candidates[i];
    if (!a || !a.pos || a.untargetable) continue;
    if (opts.skip && opts.skip(a)) continue;
    const dx = a.pos.x - origin.x;
    const dy = a.pos.y + h - origin.y;
    const dz = a.pos.z - origin.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-6 || d > maxDist) continue;
    const c = (dx * fx + dy * fy + dz * fz) / d;
    if (c < bestCos) continue;
    if (opts.isVisible) {
      _tp.x = a.pos.x;
      _tp.y = a.pos.y + h;
      _tp.z = a.pos.z;
      if (!opts.isVisible(a, _tp)) continue;
    }
    best = a;
    bestCos = c;
    bx = dx / d;
    by = dy / d;
    bz = dz / d;
  }
  if (best) {
    out.x = bx;
    out.y = by;
    out.z = bz;
  }
  return best;
}

// 手槍射線解算（契約 §13）：
//   1) 鏡頭射線（origin, dir）取瞄點；起點先推進到槍口在射線上的投影（鏡頭與角色之間的東西不算），長度 = 射程
//   2) 槍口 → 瞄點再射一次確認遮擋；確認射線多延伸 SHOT_THROUGH（穿過目標身體），只有「瞄點之前」的命中才算遮擋，
//      瞄點本身或之後的命中（遠距擦邊、視差）一律採鏡頭命中，不會因槍口射線剛好擦過目標而判為未命中
//   3) 射程一律由槍口起算：落點離槍口 > range + SHOT_RANGE_TOL → 未命中（hit false、不扣血）
//   4) 鏡頭射線沒打到東西時瞄點 = 射程盡頭；槍口射線在射程內打到東西就是落點，否則未命中（落點 = 射程末端）
// raycast(origin, dir, maxDist, { excludeActor }) → { point, normal, actor|null, surface } | null
//   注入的 raycast 可回傳重用物件（main.js 即是）：鏡頭命中的欄位先抄進區域變數再做第二次查詢
// out：{ hit, point:{x,y,z}, normal:{x,y,z}, actor, surface, dir:{x,y,z}（槍口 → 落點單位方向）, dist }，回傳 out
export const SHOT_THROUGH = 0.6; // 確認射線越過瞄點的長度（m）：> 行人膠囊直徑
export const SHOT_OCCLUDE_GAP = 0.1; // 槍口射線命中點比瞄點近這麼多（m）以上才算遮擋
export const SHOT_RANGE_TOL = 0.25; // 射程容差（m）：鏡頭 / 槍口視差造成的些微超出

function missShot(out, muzzle, mx, my, mz, range) {
  out.hit = false;
  out.actor = null;
  out.surface = null;
  out.point.x = muzzle.x + mx * range;
  out.point.y = muzzle.y + my * range;
  out.point.z = muzzle.z + mz * range;
  out.normal.x = -mx;
  out.normal.y = -my;
  out.normal.z = -mz;
  out.dist = range;
  return out;
}

export function resolveShot(raycast, origin, dir, muzzle, range, excludeActor, out, rayOpts = null) {
  const dl = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const fx = dir.x / dl;
  const fy = dir.y / dl;
  const fz = dir.z / dl;
  const opt = rayOpts || { excludeActor };
  opt.excludeActor = excludeActor;
  const skip = Math.max(0, (muzzle.x - origin.x) * fx + (muzzle.y - origin.y) * fy + (muzzle.z - origin.z) * fz);
  const o = out.point; // 暫借 out.point 當射線起點
  o.x = origin.x + fx * skip;
  o.y = origin.y + fy * skip;
  o.z = origin.z + fz * skip;
  _rd.x = fx;
  _rd.y = fy;
  _rd.z = fz;
  const camHit = raycast(o, _rd, range, opt);
  let ax;
  let ay;
  let az;
  // 鏡頭命中抄成區域變數（raycast 回傳物件可能被下一次查詢覆寫）
  let cam = false;
  let camNx = 0;
  let camNy = 0;
  let camNz = 0;
  let camHasN = false;
  let camActor = null;
  let camSurface = null;
  if (camHit) {
    cam = true;
    ax = camHit.point.x;
    ay = camHit.point.y;
    az = camHit.point.z;
    camHasN = !!camHit.normal;
    if (camHasN) {
      camNx = camHit.normal.x;
      camNy = camHit.normal.y;
      camNz = camHit.normal.z;
    }
    camActor = camHit.actor || null;
    camSurface = camHit.surface || null;
  } else {
    ax = o.x + fx * range;
    ay = o.y + fy * range;
    az = o.z + fz * range;
  }
  let mx = ax - muzzle.x;
  let my = ay - muzzle.y;
  let mz = az - muzzle.z;
  const md = Math.hypot(mx, my, mz);
  if (md < 1e-6) {
    mx = fx;
    my = fy;
    mz = fz;
  } else {
    mx /= md;
    my /= md;
    mz /= md;
  }
  out.dir.x = mx;
  out.dir.y = my;
  out.dir.z = mz;
  // 瞄點超出射程（鏡頭命中點離槍口太遠）→ 未命中
  if (cam && md > range + SHOT_RANGE_TOL) return missShot(out, muzzle, mx, my, mz, range);
  const reach = Math.min(md, range);
  const conf = md > 1e-6 ? raycast(muzzle, out.dir, cam ? reach + SHOT_THROUGH : reach, opt) : null;
  let cd = Infinity;
  if (conf) cd = Math.hypot(conf.point.x - muzzle.x, conf.point.y - muzzle.y, conf.point.z - muzzle.z);
  // 採用順序：瞄點前的遮擋 > 鏡頭命中 > 槍口射線在射程內的命中 > 未命中
  const occluded = conf && (!cam || cd < md - SHOT_OCCLUDE_GAP);
  if (occluded) {
    if (cd > range + SHOT_RANGE_TOL) return missShot(out, muzzle, mx, my, mz, range);
    out.hit = true;
    out.actor = conf.actor || null;
    out.surface = conf.surface || (conf.actor ? 'actor' : 'world');
    out.point.x = conf.point.x;
    out.point.y = conf.point.y;
    out.point.z = conf.point.z;
    const n = conf.normal;
    out.normal.x = n ? n.x : -mx;
    out.normal.y = n ? n.y : -my;
    out.normal.z = n ? n.z : -mz;
    out.dist = cd;
    return out;
  }
  if (!cam) return missShot(out, muzzle, mx, my, mz, range);
  out.hit = true;
  out.actor = camActor;
  out.surface = camSurface || (camActor ? 'actor' : 'world');
  out.point.x = ax;
  out.point.y = ay;
  out.point.z = az;
  out.normal.x = camHasN ? camNx : -mx;
  out.normal.y = camHasN ? camNy : -my;
  out.normal.z = camHasN ? camNz : -mz;
  out.dist = md;
  return out;
}

// 後座（純函式）：每發鏡頭 pitch / yaw 增量 × scale（settings.recoil 0.2–1.0）；rnd 為 0..1 亂數
// 連射第 n 發（shotIndex 0 起）pitch 略增（最多 1.5 倍），yaw 左右隨機；回傳 out { pitch, yaw }
export function recoilKick(def, shotIndex, rnd, scale, out) {
  const k = Number.isFinite(scale) ? Math.min(1, Math.max(0, scale)) : 1;
  const ramp = 1 + Math.min(0.5, Math.max(0, shotIndex) * 0.1);
  out.pitch = def.recoilPitch * ramp * k;
  out.yaw = def.recoilYaw * (rnd * 2 - 1) * k;
  return out;
}
