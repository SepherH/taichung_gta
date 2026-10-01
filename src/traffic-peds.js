// 行人更新（自 traffic.js 拆出）：人行道來回走 / 走回路線 / react 意圖 / 擊退、每個物理子步的推進、每幀大腦決策與降頻走路、動畫速度取樣
// 依賴物件 t = Traffic 實例（或測試用的同形物件）：terrain、combat、context、peds、citizens、stagger、lod、frame、_q、_tmp、_ret、
//   _nearestRoute(x, z, extra)（回 wander 時找路線，僅 startReturn 用）
// 時間步契約（docs/dev/interfaces.md「時間步契約」）：
// - 位置 / 擊退 / 大腦計時一律只用模擬秒數推進：stepPeds / afterStepPeds 在固定子步內（dt = 1/60），
//   thinkPeds 的 simDt = 本幀物理實際推進的秒數（Traffic 在子步內累加），不是渲染幀 dt
// - 動畫速度 = moveD（走過的距離）/ moveT（實際推進的模擬秒數），不以渲染幀時間除位移
// 本檔不 import three（utils.js 會）：node 無頭測試（tools/test/framerate-invariance.mjs）可直接載入
import { samplePolyline } from './geom.js';
import { inBounds, buildingAt, inWater } from './citymodel.js';
import { PED_RADIUS } from './physics/npc-bodies.js';

export const PED_ARRIVE = 0.05; // 起身後走回人行道：距人行道點小於此值（m）視為回到路線
export const PED_RUN_SPEED = 4.5; // 逃跑 / 追擊跑速（m/s，推測：一般成人慢跑到快跑之間）
export const PED_TURN_RATE = 10; // react 狀態轉向速率（1/s）：還手時要很快對準目標
export const PED_KNOCKBACK_DECAY = 12; // 擊退速度的指數衰減率（1/s）：位移總和 = 初速 / 衰減率，約 0.25 s 內推完
export const ANIM_RESUME_MAX = 0.5; // 凍結 / 降頻的 mixer 恢復時，單次推進的 dt 上限（s）
const PED_BLOCK_PAD = PED_RADIUS; // 行人自由移動（react / 擊退）時與建築 / 水域保持的距離（m）
const PED_BOUNDS_MARGIN = 3;

// 同 utils.js angleDelta（該檔 import three，這裡複製一份讓本模組在 node 可載入）
function angleDelta(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// 人行道上 s 處的點（寫入 out.x / out.z），回傳前進方向 yaw
export function pathPoint(t, p, out) {
  const tmp = t._tmp;
  samplePolyline(p.road, p.s, tmp);
  out.x = tmp.x - tmp.dz * p.off;
  out.z = tmp.z + tmp.dx * p.off;
  return Math.atan2(tmp.dx * p.dir, tmp.dz * p.dir);
}

// 沿路線可行走區段 [s0, s1] 來回走：更新 p.x / p.y / p.z / p.yaw（骨架行人與替身市民共用）；回傳本次沿路線走的距離（m）
// 走過端點的部分折返（不丟掉那段時間，掉頭時步速不掉）
export function walkPed(t, p, dt, snap = false) {
  const d = p.speed * dt;
  p.s += p.dir * d;
  if (p.s > p.s1) {
    p.s = Math.max(p.s0, 2 * p.s1 - p.s);
    p.dir = -1;
  } else if (p.s < p.s0) {
    p.s = Math.min(p.s1, 2 * p.s0 - p.s);
    p.dir = 1;
  }
  const want = pathPoint(t, p, p);
  // yHint = 上一步腳底高（初始 Infinity 取最上層可行走面）；只轉 yaw，坡上保持直立
  p.y = t.terrain.querySurface(p.x, p.z, p.y, t._q).y;
  if (snap) p.yaw = want;
  else p.yaw += angleDelta(p.yaw, want) * Math.min(1, 8 * dt);
  return d;
}

// 起身後走回人行道上最近的點（s 固定），到達後恢復來回走
export function returnPed(t, p, dt) {
  const r = t._ret || (t._ret = { x: 0, z: 0 });
  pathPoint(t, p, r);
  const dx = r.x - p.x;
  const dz = r.z - p.z;
  const d = Math.hypot(dx, dz);
  const stepLen = Math.min(d, p.speed * dt);
  if (d > 1e-6) {
    p.x += (dx / d) * stepLen;
    p.z += (dz / d) * stepLen;
    p.yaw += angleDelta(p.yaw, Math.atan2(dx, dz)) * Math.min(1, 8 * dt);
  }
  p.y = t.terrain.querySurface(p.x, p.z, p.y, t._q).y;
  if (d - stepLen < PED_ARRIVE) p.state = 'walk';
}

// 自由移動（react 意圖 / 擊退）的阻擋：建築、水域、世界邊界（2D 檢查，與 places.js 路線檢查同一套資料）
export function pedBlocked(x, z) {
  return !inBounds(x, z, PED_BOUNDS_MARGIN) || !!buildingAt(x, z, PED_BLOCK_PAD) || !!inWater(x, z, PED_BLOCK_PAD);
}

// 位移 (dx, dz)：整步被擋就沿 x / z 單軸滑動（貼著牆走），都不行就停住；回傳是否有移動
export function pedMove(p, dx, dz) {
  if (Math.abs(dx) + Math.abs(dz) < 1e-9) return false;
  if (!pedBlocked(p.x + dx, p.z + dz)) {
    p.x += dx;
    p.z += dz;
  } else if (Math.abs(dx) > 1e-9 && !pedBlocked(p.x + dx, p.z)) {
    p.x += dx;
  } else if (Math.abs(dz) > 1e-9 && !pedBlocked(p.x, p.z + dz)) {
    p.z += dz;
  } else return false;
  return true;
}

// react：套用大腦意圖（受擊硬直中不移動）；faceYaw 優先，否則面向移動方向
export function reactPed(t, p, dt) {
  const it = p.intent;
  const stunned = t.combat.stateOf(p.actor) === 'hit';
  const sp = stunned ? 0 : it.run ? PED_RUN_SPEED : p.speed;
  const moving = sp > 0 && Math.hypot(it.moveX, it.moveZ) > 1e-6;
  if (moving) pedMove(p, it.moveX * sp * dt, it.moveZ * sp * dt);
  // 受擊硬直中維持面向攻擊者（'hit' 事件已轉身），硬直結束才照意圖轉向
  const face = stunned ? null : it.faceYaw ?? (moving ? Math.atan2(it.moveX, it.moveZ) : null);
  if (face !== null) p.yaw += angleDelta(p.yaw, face) * Math.min(1, PED_TURN_RATE * dt);
}

// 回 wander：投影回附近最近的路線區段，以 return 走過去再繼續來回走；附近沒有就回原路線
export function startReturn(t, p) {
  const best = t._nearestRoute(p.x, p.z, p.route);
  const r = best.route;
  p.route = r;
  p.road = r.road;
  p.off = r.off;
  p.s0 = r.s0;
  p.s1 = r.s1;
  p.s = best.s;
  p.state = 'return';
}

export function syncActor(p) {
  const a = p.actor;
  a.pos.x = p.x;
  a.pos.y = p.y;
  a.pos.z = p.z;
  a.yaw = p.yaw;
}

// 每個物理子步：依 ped.state 更新位置（wander = 原人行道邏輯、react = 大腦意圖），再疊加擊退；
// 回傳本子步走過的水平距離（m，動畫速度用：漫步取沿路線距離，其餘取位移）
export function updatePed(t, p, dt) {
  const x0 = p.x;
  const z0 = p.z;
  let walked = 0;
  if (p.state === 'return') returnPed(t, p, dt);
  else if (p.state === 'walk') walked = walkPed(t, p, dt);
  else if (p.state === 'react') reactPed(t, p, dt);
  if (p.kbx !== 0 || p.kbz !== 0) {
    if (!pedMove(p, p.kbx * dt, p.kbz * dt)) {
      p.kbx = 0;
      p.kbz = 0;
    }
    const k = Math.exp(-PED_KNOCKBACK_DECAY * dt);
    p.kbx *= k;
    p.kbz *= k;
    if (Math.hypot(p.kbx, p.kbz) < 0.05) {
      p.kbx = 0;
      p.kbz = 0;
    }
  }
  if (p.state === 'react' || p.state === 'getup' || p.kbx !== 0) p.y = t.terrain.querySurface(p.x, p.z, p.y, t._q).y;
  syncActor(p);
  return Math.max(walked, Math.hypot(p.x - x0, p.z - z0));
}

// 物理子步前（Traffic._step 的行人部分）：倒地者、mid 級漫步中的骨架跳過
export function stepPeds(t, dt) {
  for (const p of t.peds) {
    if (p.state === 'down' || !p.fine) continue;
    p.moveD += updatePed(t, p, dt);
    p.moveT += dt;
    p.body.setPose(p.x, p.y, p.z, p.yaw);
  }
}

// 物理子步後（Traffic._afterStep 的行人部分）：倒地行人的落穩檢查（起身由 combat 決定），位置取剛體
export function afterStepPeds(t, dt) {
  for (const p of t.peds) {
    if (p.state !== 'down') continue;
    p.settle = p.body.settleCheck(dt);
    const b = p.body.getPosition();
    p.moveD += Math.hypot(b.x - p.x, b.z - p.z);
    p.moveT += dt;
    p.x = b.x;
    p.y = b.y - p.body.centerY;
    p.z = b.z;
    syncActor(p);
  }
}

// 降頻走路：把累積的模擬秒數 walkAcc 一次走完（沿路線），計入動畫速度取樣
function walkOut(t, p) {
  p.moveD += walkPed(t, p, p.walkAcc);
  p.moveT += p.walkAcc;
  p.walkAcc = 0;
  syncActor(p);
  p.body.setPose(p.x, p.y, p.z, p.yaw);
}

// 每幀：大腦決策 → ped.state 轉換（wander ↔ react、getup 結束）；意圖留給下一幀的物理子步套用
// 大腦間隔 = lod.aiEvery(level)（stagger 錯開、累積模擬秒數）；mid 級、剛體停用中、漫步中的骨架不跑物理子步，改在此以累積秒數走路；
// 替身市民沒有大腦，同一間隔以累積秒數走路線
// simDt = 本幀物理實際推進的模擬秒數（60Hz 每幀 1 子步時 = 1/60；高更新率時有的幀為 0；子步上限丟棄的時間不算）
// fine 的時間記帳：本幀的子步是依「上一幀」的 p.fine 決定推不推此人，所以 simDt 只在上一幀非 fine 時記入 walkAcc
//   （fine → 非 fine 那幀子步已走過，不重算）；非 fine → fine 那幀先把 walkAcc 走完再交給子步（不遺失）；
//   降頻走路在狀態轉換前走完（漫步 → react 不丟轉換前的時間），轉換後不再漫步就立刻改 fine（下一幀子步推進）
export function thinkPeds(t, simDt) {
  const ctx = t.context;
  const st = t.stagger;
  const lod = t.lod;
  const frame = t.frame;
  for (const p of t.peds) {
    const level = p.citizen.level;
    p.aiAcc += simDt;
    if (!p.fine) p.walkAcc += simDt;
    p.fine = level === 'near' || p.body.active || p.state !== 'walk';
    if (p.fine && p.walkAcc > 0) {
      // 非漫步（倒地 / react 等）= 已離開路線，累積的路線秒數捨棄
      if (p.state === 'walk') walkOut(t, p);
      p.walkAcc = 0;
    }
    if (!st.shouldTick(p.slot, frame, lod.aiEvery(level))) continue;
    const brain = p.brain;
    // 被拖出的司機：起身後才把「被攻擊」交給大腦（倒地中大腦只會記成逃跑）→ 依性格還手或逃跑
    if (p.pendingFrom && !t.combat.isDown(p.actor)) {
      const who = p.pendingAttacker;
      brain.onAttacked(who ? { attacker: who } : { vehicle: p.pendingFrom });
      p.pendingAttacker = null;
      p.pendingFrom = null;
    }
    const it = brain.update(p.aiAcc, ctx);
    p.aiAcc = 0;
    p.intent.moveX = it.moveX;
    p.intent.moveZ = it.moveZ;
    p.intent.run = it.run;
    p.intent.faceYaw = it.faceYaw;
    if (it.jump) p.anim.trigger('jump');
    if (!p.fine && p.walkAcc > 0) walkOut(t, p); // 非 fine 必為漫步中（fine 判斷之後狀態未變）
    if (p.state === 'down') continue;
    if (p.state === 'getup') {
      if (t.combat.isDown(p.actor)) continue;
      if (it.mode === 'wander') startReturn(t, p);
      else p.state = 'react';
    } else if (it.mode === 'wander') {
      if (p.state === 'react') startReturn(t, p);
    } else if (it.mode !== 'down') {
      p.state = 'react';
    }
    if (p.state !== 'walk') p.fine = true;
  }
  const farEvery = lod.aiEvery('far');
  for (const c of t.citizens) {
    if (c.rep !== 'impostor') continue;
    c.walkAcc += simDt;
    if (!st.shouldTick(c.slot, frame, farEvery)) continue;
    walkPed(t, c, c.walkAcc);
    c.walkAcc = 0;
    c.moved = true;
  }
}

// 每幀動畫（渲染時間）：間隔 = lod.mixerEvery（near 每幀、mid 每 3 幀、mid 視野外凍結），累積渲染 dt（恢復時上限 ANIM_RESUME_MAX）；
// 速度 = 上次取樣以來走過的距離 moveD / 位置實際推進的模擬秒數 moveT（位置只在 1/60 子步或 AI 間隔推進，
// 不能除以渲染幀時間：高於 60Hz 時約半數幀沒有子步，會得到 0 / 加倍的速度而在 walk ↔ idle 間來回切）；
// 本次沒有推進（moveT 0）就沿用上次速度
export function animatePed(t, p, dt) {
  const c = p.citizen;
  p.animAcc += dt;
  if (!t.stagger.shouldTick(p.slot, t.frame, t.lod.mixerEvery(c.level, c.inView))) return;
  if (p.moveT > 0) {
    p.animSpeed = p.moveD / p.moveT;
    p.moveD = 0;
    p.moveT = 0;
  }
  p.anim.update(Math.min(p.animAcc, ANIM_RESUME_MAX), { speed: p.animSpeed });
  p.animAcc = 0;
}
