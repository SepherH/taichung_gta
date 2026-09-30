// 碰撞事件路由：把 Rapier 的 collider handle 對應到遊戲實體，drain 後發出高階事件給 D5 對抗邏輯
//   onVehicleHitPedestrian({ vehicle, ped, impulse, relSpeed, dir })
//   onVehicleHitVehicle({ a, b, impulse, relSpeed, dir })   a 優先放玩家車（kind 'vehicle'），dir 為 b 的受力方向
//   onVehicleHitWorld({ vehicle, impulse, relSpeed, dir })   dir 為車輛受力方向（遠離牆面）
// 實體以 kind 分類：'vehicle'（VehicleBody）、'npcCar'、'pedestrian'、'world'；沒註冊的 collider 一律視為世界（建築、地形）
// 衝量 = contact force 事件的 totalForceMagnitude × 物理步長（碰撞體需開 ActiveEvents.CONTACT_FORCE_EVENTS）；
// kinematic 行人不與車輛做實體碰撞（見 npc-bodies.js），改以碰撞開始事件 × 行人質量 × 相對速度估算
// 同一對 collider 持續接觸時只發一次，分開超過 REARM_SEC 後才會再發
// 撞牆的 relSpeed 取「撞擊前」的速度：drain 結束時記下每台 'vehicle' 的線速度（最近 PREV_STEPS 步），
//   事件當下的速度已被牆擋停（解算後），直接用會讓同速重撞的扣值差十幾倍；
//   relSpeed = 歷史速度對接觸法向（maxForceDirection）分量的最大絕對值；拿不到法向時用 |v_prev − v_now| 的最大值（impactSpeed）

import { nativeWorld } from './vehicle-body.js';

// 高階事件的衝量門檻（N·s）
export const HIT_THRESHOLDS = {
  world: 800, // 約 1400 kg 車輛 0.6 m/s 的速度變化：擦牆滑行不算、明顯撞擊才算
  vehicle: 800,
  pedestrian: 60, // 約 70 kg 行人 1 m/s：車子慢慢頂到人也算
};
// kinematic 行人以碰撞開始事件判定時，相對速度低於此值不算撞擊（例如行人走進停著的車）
export const PED_HIT_MIN_REL_SPEED = 1.5;
// 同一對 collider 再次發事件前需要的無事件間隔（秒）
export const REARM_SEC = 0.75;
// 撞擊前速度的取樣步數（1/60 s 一步 ≈ 67 ms）：力事件可能在接觸第 2、3 步才超過門檻，只取前一步會拿到已減速的值
export const PREV_STEPS = 4;

const isVehicle = (e) => !!e && (e.kind === 'vehicle' || e.kind === 'npcCar');
const isWorld = (e) => !e || e.kind === 'world';

function normalize(v) {
  const l = Math.hypot(v.x, v.y, v.z);
  return l > 1e-9 ? { x: v.x / l, y: v.y / l, z: v.z / l } : { x: 0, y: 0, z: 0 };
}

// 撞擊速度（m/s）：history = 撞擊前的線速度（新 → 舊），vNow = 事件當下速度，n = 接觸法向（可為 null / 零向量）
// 有法向：max |v_prev · n|；沒有法向：max |v_prev − v_now|；沒有歷史：退回 |v_now|（舊行為）
export function impactSpeed(history, vNow, n = null) {
  const now = vNow || { x: 0, y: 0, z: 0 };
  if (!history || history.length === 0) return Math.hypot(now.x, now.y, now.z);
  const nl = n ? Math.hypot(n.x, n.y, n.z) : 0;
  let best = 0;
  for (const v of history) {
    const s = nl > 1e-6
      ? Math.abs((v.x * n.x + v.y * n.y + v.z * n.z) / nl)
      : Math.hypot(v.x - now.x, v.y - now.y, v.z - now.z);
    if (s > best) best = s;
  }
  return best;
}

// world：原生 World 或 { world, eventQueue }；eventQueue 省略時取 world.eventQueue
export function createContactRouter(RAPIER, world, eventQueue = world && world.eventQueue, { thresholds = HIT_THRESHOLDS } = {}) {
  const w = nativeWorld(world);
  const entities = new Map(); // collider handle → 實體
  const lastSeen = new Map(); // pair key → 最後一次超過門檻的時間
  const history = new Map(); // 'vehicle' collider handle → 最近 PREV_STEPS 步 drain 結束時的線速度（新 → 舊）
  const listeners = { ped: new Set(), vehicle: new Set(), world: new Set() };
  let now = 0;

  const subscribe = (set) => (fn) => {
    set.add(fn);
    return () => set.delete(fn);
  };
  const emit = (set, payload) => {
    for (const fn of set) fn(payload);
  };

  const bodyOf = (handle) => {
    const c = w.getCollider(handle);
    return c ? c.parent() : null;
  };
  const velOf = (body) => (body ? body.linvel() : { x: 0, y: 0, z: 0 });
  const posOf = (body) => (body ? body.translation() : { x: 0, y: 0, z: 0 });

  // 每對只在「重新接觸」時發一次；持續接觸會一直更新時間戳而不重發
  function fresh(h1, h2) {
    const key = h1 < h2 ? `${h1}:${h2}` : `${h2}:${h1}`;
    const prev = lastSeen.get(key);
    lastSeen.set(key, now);
    return prev === undefined || now - prev > REARM_SEC;
  }

  function relative(hA, hB) {
    const bA = bodyOf(hA);
    const bB = bodyOf(hB);
    const vA = velOf(bA);
    const vB = velOf(bB);
    const rel = { x: vA.x - vB.x, y: vA.y - vB.y, z: vA.z - vB.z };
    const pA = posOf(bA);
    const pB = posOf(bB);
    return { rel, relSpeed: Math.hypot(rel.x, rel.y, rel.z), aToB: { x: pB.x - pA.x, y: pB.y - pA.y, z: pB.z - pA.z } };
  }

  // 依實體種類整理成 (主體 handle, 對方 handle)；不需要路由的組合回傳 null
  function classify(h1, h2) {
    const e1 = entities.get(h1);
    const e2 = entities.get(h2);
    if (isVehicle(e1) && e2 && e2.kind === 'pedestrian') return { type: 'ped', hA: h1, hB: h2, a: e1, b: e2 };
    if (isVehicle(e2) && e1 && e1.kind === 'pedestrian') return { type: 'ped', hA: h2, hB: h1, a: e2, b: e1 };
    if (isVehicle(e1) && isVehicle(e2)) {
      const swap = e2.kind === 'vehicle' && e1.kind !== 'vehicle';
      return swap ? { type: 'vehicle', hA: h2, hB: h1, a: e2, b: e1 } : { type: 'vehicle', hA: h1, hB: h2, a: e1, b: e2 };
    }
    if (isVehicle(e1) && isWorld(e2)) return { type: 'world', hA: h1, hB: h2, a: e1, b: null };
    if (isVehicle(e2) && isWorld(e1)) return { type: 'world', hA: h2, hB: h1, a: e2, b: null };
    return null;
  }

  function onForce(h1, h2, impulse, forceDir) {
    const p = classify(h1, h2);
    if (!p || impulse < thresholds[p.type]) return;
    if (!fresh(h1, h2)) return;
    const { rel, relSpeed, aToB } = relative(p.hA, p.hB);
    if (p.type === 'ped') {
      emit(listeners.ped, { vehicle: p.a, ped: p.b, impulse, relSpeed, dir: normalize(rel) });
      return;
    }
    // 力方向的正負號依 collider 順序而定，統一定向：車對車 = 由 a 推向 b；撞牆 = 車輛受力（與撞入速度相反）
    // 撞牆：事件當下車可能已停住（rel ≈ 0 定不出方向），改以撞擊前一步的速度定向
    const hist = p.type === 'world' ? history.get(p.hA) : null;
    const vPrev = hist && hist.length ? hist[0] : rel;
    const ref = p.type === 'vehicle' ? aToB : { x: -vPrev.x, y: -vPrev.y, z: -vPrev.z };
    const s = forceDir.x * ref.x + forceDir.y * ref.y + forceDir.z * ref.z < 0 ? -1 : 1;
    const dir = { x: forceDir.x * s, y: forceDir.y * s, z: forceDir.z * s };
    if (p.type === 'vehicle') emit(listeners.vehicle, { a: p.a, b: p.b, impulse, relSpeed, dir });
    else emit(listeners.world, { vehicle: p.a, impulse, relSpeed: impactSpeed(hist, rel, forceDir), dir });
  }

  function onCollisionStart(h1, h2) {
    const p = classify(h1, h2);
    if (!p || p.type !== 'ped' || !p.b.isGhost) return;
    const { rel, relSpeed } = relative(p.hA, p.hB);
    if (relSpeed < PED_HIT_MIN_REL_SPEED) return;
    const mass = p.b.mass ?? bodyOf(p.hB).mass();
    const impulse = mass * relSpeed;
    if (impulse < thresholds.ped || !fresh(h1, h2)) return;
    emit(listeners.ped, { vehicle: p.a, ped: p.b, impulse, relSpeed, dir: normalize(rel) });
  }

  return {
    register(collider, entity) {
      entities.set(collider.handle, entity);
    },
    unregister(collider) {
      entities.delete(collider.handle);
      history.delete(collider.handle);
    },
    entityOf(handle) {
      return entities.get(handle) ?? null;
    },
    onVehicleHitPedestrian: subscribe(listeners.ped),
    onVehicleHitVehicle: subscribe(listeners.vehicle),
    onVehicleHitWorld: subscribe(listeners.world),
    // 每個物理步（world.step 之後、下一步之前）呼叫一次：EventQueue 若為 autoDrain，下一步開始前會被清空
    drain(dt = w.timestep) {
      now += dt;
      eventQueue.drainContactForceEvents((e) => {
        onForce(e.collider1(), e.collider2(), e.totalForceMagnitude() * dt, e.maxForceDirection());
      });
      eventQueue.drainCollisionEvents((h1, h2, started) => {
        if (started) onCollisionStart(h1, h2);
      });
      // 清掉太久沒出現的配對，避免 Map 無限成長
      for (const [key, t] of lastSeen) if (now - t > REARM_SEC * 4) lastSeen.delete(key);
      // 記下本步結束的速度 = 下一步的「撞擊前速度」
      for (const [handle, e] of entities) {
        if (e.kind !== 'vehicle') continue;
        const body = bodyOf(handle);
        if (!body) continue;
        const v = body.linvel();
        let list = history.get(handle);
        if (!list) history.set(handle, (list = []));
        list.unshift({ x: v.x, y: v.y, z: v.z });
        if (list.length > PREV_STEPS) list.length = PREV_STEPS;
      }
    },
  };
}
