// 搶車（C3）：對車流車按 F → 拉門（punch 動作）→ 司機被拖出倒地 → 玩家上車，全程約 1.1 秒
// 用法：const cj = createCarjack({ bus })；步行時 cj.canStart(player.pos, traffic.carjackCandidates(x, z, r)) 有結果且按 F → cj.begin(ctx)，
//   之後每幀 cj.update(dt) 直到回傳 'done' / 'cancelled'
// 時間線：t0 emit vehicle:carjackStart、玩家面向車門、playPlayerAnim('punch')、releaseCar → adopt（速度歸零）；
//   t eject（預設 0.6 s）spawnEjectedDriver（車門外 1.2 m，倒地）；t pull（預設 1.1 s）onEnter(vehicle) + emit vehicle:carjacked
// 過程中 isPlayerDisabled() 為真 → cancelled：已 adopt 的車留在原地當路邊車；司機若還沒拖出，照樣在車門外生成（不會憑空消失）
// 座標：本地前方 +Z、左方 +X；前進方向 = (sin(yaw), cos(yaw))、左方 = (cos(yaw), −sin(yaw))；臺灣駕駛座在左（doorSide +1）

export const CARJACK_DOOR_DIST = 3.0; // m，玩家到駕駛座車門的最大距離
export const CARJACK_MAX_SPEED = 6; // m/s
export const EJECT_OFFSET = 1.2; // m，司機倒在車門外的距離
// 候選缺 car.spec 時依車型推估外形（同 vehicle.js VEHICLE_TYPES）
const FALLBACK_SIZE = {
  sedan: { length: 4.5, width: 1.85 },
  taxi: { length: 4.5, width: 1.85 },
  suv: { length: 4.9, width: 2.0 },
  scooter: { length: 1.9, width: 0.7, twoWheeler: true },
  bus: { length: 12.2, width: 2.5 },
};
const DOOR_FORWARD = 0.1; // 車門中心在車身中點前方 length × 此比例（駕駛座略偏前）

function sizeOf(c) {
  const spec = (c.car && c.car.spec) || {};
  const fb = FALLBACK_SIZE[c.type] || FALLBACK_SIZE.sedan;
  return {
    length: spec.length ?? fb.length,
    width: spec.width ?? fb.width,
    twoWheeler: !!(spec.twoWheeler ?? fb.twoWheeler),
  };
}

// 駕駛座車門的世界座標與向外方向；side：+1 = 左
export function doorPoint(x, z, yaw, { length, width }, side = 1) {
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  const lx = Math.cos(yaw) * side;
  const lz = -Math.sin(yaw) * side;
  const half = width / 2;
  return {
    x: x + lx * half + fx * length * DOOR_FORWARD,
    z: z + lz * half + fz * length * DOOR_FORWARD,
    outX: lx,
    outZ: lz,
  };
}

export function createCarjack({ bus, durations = {} } = {}) {
  const pull = durations.pull ?? 1.1;
  const eject = Math.min(durations.eject ?? 0.6, pull);
  const emit = (name, payload) => {
    if (bus && bus.emit) bus.emit(name, payload);
  };

  let status = 'idle';
  let job = null; // { t, candidate, adapters, released, vehicle, ejected }
  let endedThisFrame = false;

  // 司機倒在車門外 EJECT_OFFSET m，面向外側（被拖出的方向）
  function spawnDriver() {
    const j = job;
    if (j.ejected || !j.released) return;
    j.ejected = true;
    const r = j.released;
    const size = sizeOf(j.candidate);
    const d = doorPoint(r.x, r.z, r.yaw, size, j.side);
    const x = d.x + d.outX * EJECT_OFFSET;
    const z = d.z + d.outZ * EJECT_OFFSET;
    const variant = r.driverVariant ?? j.candidate.driverVariant;
    if (j.adapters.spawnEjectedDriver) j.adapters.spawnEjectedDriver({ x, z, yaw: Math.atan2(d.outX, d.outZ), variant });
  }

  function finish(next) {
    if (next === 'cancelled') spawnDriver();
    status = next;
    endedThisFrame = true;
    job = null;
  }

  return {
    // 候選（traffic.carjackCandidates）中找可搶的一台：車速 ≤ 6 m/s、玩家在駕駛座側且距車門 ≤ 3 m；取車門最近者
    canStart(playerPos, candidates) {
      if (!playerPos || !candidates || status === 'running') return null;
      let best = null;
      let bestD = CARJACK_DOOR_DIST;
      for (const c of candidates) {
        if (!c || Math.abs(c.speed || 0) > CARJACK_MAX_SPEED) continue;
        const size = sizeOf(c);
        const side = c.doorSide ?? 1;
        // 汽車只能從駕駛座側搶（玩家必須在車身中線的左側）；機車兩側都能拉人
        if (!size.twoWheeler) {
          const lat = (playerPos.x - c.x) * Math.cos(c.yaw) * side - (playerPos.z - c.z) * Math.sin(c.yaw) * side;
          if (lat <= 0) continue;
        }
        const d = doorPoint(c.x, c.z, c.yaw, size, side);
        const dist = Math.hypot(playerPos.x - d.x, playerPos.z - d.z);
        if (dist <= bestD) {
          bestD = dist;
          best = c;
        }
      }
      return best;
    },

    // 開始搶車；玩家動作被拒（出拳中 / 受擊）或已在搶車中 → false，什麼都不做
    begin(ctx) {
      if (status === 'running' || !ctx || !ctx.candidate || !ctx.adapters) return false;
      const { candidate: c, adapters: a } = ctx;
      const side = c.doorSide ?? 1;
      const d = doorPoint(c.x, c.z, c.yaw, sizeOf(c), side);
      if (a.playPlayerAnim && a.playPlayerAnim('punch') === false) return false;
      if (a.facePlayer) a.facePlayer(Math.atan2(-d.outX, -d.outZ));
      job = { t: 0, candidate: c, adapters: a, side, released: null, vehicle: null, ejected: false };
      status = 'running';
      endedThisFrame = false;
      emit('vehicle:carjackStart', { car: c.car });
      const released = a.releaseCar(c.car);
      if (!released) {
        finish('cancelled');
        return true;
      }
      job.released = released;
      // 車立即停：速度歸零
      job.vehicle = a.adopt({ type: released.type, color: released.color, x: released.x, y: released.y, z: released.z, yaw: released.yaw, vx: 0, vz: 0 });
      if (!job.vehicle) finish('cancelled');
      return true;
    },

    update(dt) {
      if (status !== 'running') {
        // 結束的那一幀回報 'done' / 'cancelled'，之後回到 'idle'
        if (endedThisFrame) {
          endedThisFrame = false;
          return status;
        }
        status = 'idle';
        return status;
      }
      const j = job;
      if (j.adapters.isPlayerDisabled && j.adapters.isPlayerDisabled()) {
        finish('cancelled');
        endedThisFrame = false;
        return status;
      }
      j.t += dt;
      if (j.t >= eject) spawnDriver();
      if (j.t >= pull) {
        const vehicle = j.vehicle;
        if (j.adapters.onEnter) j.adapters.onEnter(vehicle);
        emit('vehicle:carjacked', { vehicle });
        finish('done');
        endedThisFrame = false;
      }
      return status;
    },

    // 外部中止（例如切回主選單）：同 cancelled 分支
    cancel() {
      if (status !== 'running') return;
      finish('cancelled');
    },

    get active() {
      return status === 'running';
    },

    // 目前的搶車車輛（adopt 後的 Vehicle；未進行中為 null）
    get vehicle() {
      return job ? job.vehicle : null;
    },
  };
}
