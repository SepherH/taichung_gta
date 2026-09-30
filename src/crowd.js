// 群眾分層模擬（C2）：把 traffic.js 的行人密度 / 降頻策略抽成可測的純模組，並提供遠景替身（InstancedMesh 簡化人形）
// - crowdPlan(budget)：依畫質預算（core/quality.js qualityBudget 物件：peds / pedNear / pedFar）算出分層參數
//   near 內：完整骨架、mixer 每幀、AI 每幀、物理只在 near + PHYSICS_PAD 內啟用
//   near–far：骨架、mixer 每 3 幀（視野外 0 = 凍結姿勢）、AI 每 3 幀
//   far 外：替身（骨架回池、mixer 停）、AI 每 6 幀
//   骨架池上限 = far 半徑內預期人數（目標人數在 radius 內均勻分布的估計）× POOL_MARGIN，其餘人用替身
// - createCrowdLod(plan).classify：分級含遲滯（外移要超過邊界 + hysteresis 才降級、內移一過邊界就升級，
//   所以 near 半徑內的人一定是 near）；倒地 / 還手 / 逃跑 / 被玩家鎖定者由呼叫端傳 forceNear
// - createStagger().shouldTick：隔幀更新的錯開相位（每個 index 每 every 幀剛好一次、連號 index 均勻分散）
// - createCrowdImpostors：軀幹 / 腿 / 頭三個 InstancedMesh（3 draw calls、instanceColor 上色），原點在腳底、身高同骨架模型
// - swapPolicy：骨架 ↔ 替身切換的純函式，保證任一幀兩者恰好顯示其一
// 不 import traffic.js；THREE / scene 由呼叫端注入（node 無頭測試可用真 three 或假物件）
//
// 接線說明（traffic.js，下一單元照做）：
// 0. 建構：new Traffic(scene, { …, plan })，plan = crowdPlan(qualityBudget(tier))；this.lod = createCrowdLod(plan)、
//    this.stagger = createStagger()、this.impostors = createCrowdImpostors(THREE, scene, { max: plan.target + 補生成餘量 })；
//    CROWD_RADIUS / CROWD_RECYCLE / CROWD_SPAWN_MIN / PED_NEAR / poolMax 改讀 plan.radius / recycle / spawnMin / near / poolMax
//    （PED_TARGET[crowd] 改 plan.target；CROWD_POOL_FACTOR 刪除）。
// 1. 資料拆兩層：「市民」citizen = { slot（固定槽號 = 替身 slot 兼 stagger index）、route / s / dir / speed / off、x y z yaw、
//    colors、variant、level、rep、ped }；ped = Phase 2 的骨架行人（character + animator + actor + brain + body），只在 rep 為
//    'skeleton' 時掛在 citizen.ped。combat 在 register 時訂閱 actor.anim，所以骨架不在 actor 間互換——骨架行人整組回池 / 取出。
// 2. _spawnPed(spot)：先建 citizen；level = classify(null, d, …)；swapPolicy(null, level, canAcquire) → acquire 則走原
//    _spawnPed 流程（pool.pop 或 _createPed，未達 poolMax），把 citizen 的路線 / 服色抄進 ped；否則只 impostors.set(slot, …)。
// 3. _recyclePed(p)：拆成 releaseSkeleton(citizen)（原 _recyclePed：combat.unregister、brains.delete、body.dispose、mesh 隱藏、回池，
//    並把 ped 的路線狀態 / 位置抄回 citizen）與 recycleCitizen（出 plan.recycle 或密度過多時：先 releaseSkeleton 再 impostors.hide）。
// 4. sync 每幀（_manageCrowd 之後）逐 citizen：forceNear = ped 且（state 為 down / getup / react，或 combat.stateOf 非 normal，
//    或為玩家鎖定目標）；inView 用視錐點積即可（不要每幀跑 _hidden 的建築 LOS）；level = lod.classify(level, d, inView, forceNear)；
//    s = swapPolicy(rep, level, canAcquire)；s.acquire → 取骨架、anim.reset()、anim.update(0) 擺好姿勢、mesh.visible = true、
//    impostors.hide(slot)；s.release → releaseSkeleton、impostors.set(slot, …)；池空時可 releaseSkeleton 一個最遠的 mid、
//    視野外、walk 中者給 near 的人。mixer：stagger.shouldTick(slot, frame, lod.mixerEvery(level, inView)) 取代 PED_FAR_MIXER_EVERY
//    （animAcc 照舊累積，凍結後恢復時 dt 建議上限 0.5 s）；替身每幀 set 位置（依 variantHeight 給 look.height），迴圈後 commit() 一次。
// 5. _thinkPeds：every = lod.aiEvery(level)，stagger.shouldTick(slot, frame, every) 取代 PED_FAR_AI_EVERY；替身市民沒有大腦，
//    同一間隔以累積 dt 呼叫 _walkPed（路線邏輯），物理子步 _step 只跑有骨架者。
// 6. 物理：Traffic 新增 pedBodies(out)（只列骨架行人的 body，倒地 / 起身中者不列＝保持啟用）、bodies() 只留車；
//    main.js 改為 setActiveByDistance(traffic.pedBodies(), cx, cz, plan.physicsRadius)，車輛照舊用 ACTIVE_RADIUS。
import { MODEL_YAW_OFFSET, DEFAULT_HEIGHT } from './characters/index.js';

export const LEVELS = ['near', 'mid', 'far'];
export const CROWD_HYSTERESIS = 5; // 分級邊界的遲滯寬度（m）
export const PHYSICS_PAD = 10; // 物理啟用半徑 = near + 此值（m）
export const CROWD_BAND = 20; // 維持目標人數的半徑 = far + 此值（m）：far 外這一圈是替身
export const CROWD_RECYCLE_PAD = 40; // 回收半徑 = radius + 此值（m）
export const CROWD_SPAWN_BAND = 40; // 補生成環帶寬度（m）：radius − 此值 到 radius
export const POOL_MARGIN = 1.3; // 骨架池上限 = far 內預期人數 × 此值
const MIXER_EVERY = { near: 1, nearHidden: 1, mid: 3, midHidden: 0 };
const AI_EVERY = { near: 1, mid: 3, far: 6 };
// 預算缺欄位時的預設（= 契約 §3 high 列）
const DEFAULT_BUDGET = { peds: 90, pedNear: 50, pedFar: 110 };

const num = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d);

// budget：{ peds, pedNear, pedFar, crowdRadius? }（crowdRadius 省略時 = pedFar + CROWD_BAND）
export function crowdPlan(budget = {}) {
  const target = Math.round(num(budget.peds, DEFAULT_BUDGET.peds));
  const near = num(budget.pedNear, DEFAULT_BUDGET.pedNear);
  const far = Math.max(near, num(budget.pedFar, DEFAULT_BUDGET.pedFar));
  const radius = Math.max(far, num(budget.crowdRadius, far + CROWD_BAND));
  // far 內預期人數：目標人數在 radius 內均勻分布 → target × (far / radius)²
  const expectedSkeleton = radius > 0 ? target * (far / radius) ** 2 : target;
  const poolMax = Math.min(target, Math.ceil(expectedSkeleton * POOL_MARGIN - 1e-9));
  return {
    target,
    poolMax,
    near,
    far,
    hysteresis: CROWD_HYSTERESIS,
    mixerEvery: { ...MIXER_EVERY },
    aiEvery: { ...AI_EVERY },
    physicsRadius: near + PHYSICS_PAD,
    radius,
    recycle: radius + CROWD_RECYCLE_PAD,
    spawnMin: Math.max(near + PHYSICS_PAD, radius - CROWD_SPAWN_BAND),
    expectedSkeleton,
  };
}

// 分級器：classify(prevLevel, dist, inView, forceNear) → 'near' | 'mid' | 'far'
// prevLevel 為 null / undefined（剛生成）時不套遲滯；inView 目前不影響分級（視野內外同一遲滯，避免視野外者在邊界反覆
// 取還骨架），只由 mixerEvery(level, inView) 決定動畫間隔——參數保留供日後依視野調整
export function createCrowdLod(plan) {
  const near = plan.near;
  const far = plan.far;
  const h = plan.hysteresis;
  const nearOut = near + h;
  const farOut = far + h;
  const me = plan.mixerEvery;
  const ae = plan.aiEvery;
  return {
    classify(prevLevel, dist, inView, forceNear) {
      if (forceNear) return 'near';
      if (prevLevel === 'near') {
        if (dist <= nearOut) return 'near';
        return dist > farOut ? 'far' : 'mid';
      }
      if (prevLevel === 'mid') {
        if (dist < near) return 'near';
        return dist > farOut ? 'far' : 'mid';
      }
      if (prevLevel === 'far') {
        if (dist >= far) return 'far';
        return dist < near ? 'near' : 'mid';
      }
      return dist < near ? 'near' : dist < far ? 'mid' : 'far';
    },
    // 該級的 mixer 更新間隔（幀；0 = 不更新）
    mixerEvery(level, inView) {
      if (level === 'near') return inView ? me.near : me.nearHidden;
      if (level === 'mid') return inView ? me.mid : me.midHidden;
      return 0;
    },
    // 該級的 AI（大腦 / 替身走路邏輯）更新間隔（幀）
    aiEvery(level) {
      return level === 'near' ? ae.near : level === 'mid' ? ae.mid : ae.far;
    },
  };
}

// 錯開更新：index（行人的固定槽號，如生成序號）在 frame 是否該更新；every ≤ 0 → 永不（凍結）、1 → 每幀
// 相位 = index mod every：連號 index 平均分到 every 個相位，同一幀更新的人數最多差 1
export function createStagger() {
  return {
    shouldTick(index, frame, every) {
      if (every <= 1) return every === 1;
      return (frame + index) % every === 0;
    },
  };
}

// 骨架 ↔ 替身切換（純函式）：rep = 目前表現 'skeleton' | 'impostor' | null（剛生成）；level = classify 結果；
// canAcquire = 骨架池還拿得到骨架（池中有、或未達 poolMax 可新建）
// 回傳 { rep, acquire, release, skeletonVisible, impostorVisible }：
//   acquire 當幀呼叫端要「取骨架 → anim.reset() → anim.update 一次擺好姿勢 → 設 visible」，同幀 impostors.hide(i)
//   release 當幀呼叫端要「骨架 mesh.visible = false 並回池 → impostors.set(i, …)」，commit 在同幀渲染前
//   拿不到骨架時維持替身（下一幀再試），任何情況 skeletonVisible 與 impostorVisible 恰好一個為 true
export function swapPolicy(rep, level, canAcquire) {
  const wantSkeleton = level !== 'far';
  if (wantSkeleton) {
    if (rep === 'skeleton') return SWAP_KEEP_SKELETON;
    return canAcquire ? SWAP_ACQUIRE : SWAP_KEEP_IMPOSTOR;
  }
  if (rep === 'skeleton') return SWAP_RELEASE;
  return SWAP_KEEP_IMPOSTOR;
}
const swapResult = (rep, acquire, release) => Object.freeze({ rep, acquire, release, skeletonVisible: rep === 'skeleton', impostorVisible: rep === 'impostor' });
const SWAP_KEEP_SKELETON = swapResult('skeleton', false, false);
const SWAP_ACQUIRE = swapResult('skeleton', true, false);
const SWAP_KEEP_IMPOSTOR = swapResult('impostor', false, false);
const SWAP_RELEASE = swapResult('impostor', false, true);

// 替身人形比例（相對身高）：腿 0–0.47、軀幹 0.47–0.83、頭 0.87–1；寬 > 厚，朝向錯 90° 看得出來
const LEG = { w: 0.2, h: 0.47, d: 0.11, y: 0 };
const TORSO = { w: 0.25, h: 0.36, d: 0.13, y: 0.47 };
const HEAD = { w: 0.1, h: 0.13, d: 0.11, y: 0.87 };
const DEFAULT_LOOK = { shirt: '#8d99ae', pants: '#2b2f3a', skin: '#e0ac85' };

// InstancedMesh 簡化人形：slot i（0 ≤ i < max）以 set 放置 / 上色、hide 隱藏；每幀改完呼叫 commit 一次
// set 的 look：{ shirt, pants, skin, height? }（顏色為 CSS 色字串或 0xRRGGBB；height 省略用建構時的 height）
export function createCrowdImpostors(THREE, scene, { max, height = DEFAULT_HEIGHT } = {}) {
  const cap = Math.max(0, Math.floor(max || 0));
  const parts = [LEG, TORSO, HEAD].map((p, k) => {
    const geo = new THREE.BoxGeometry(p.w, p.h, p.d);
    geo.translate(0, p.y + p.h / 2, 0); // 單位身高、原點在腳底
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, cap));
    mesh.name = ['crowdImpostorLegs', 'crowdImpostorTorso', 'crowdImpostorHead'][k];
    mesh.count = 0;
    mesh.frustumCulled = false; // 實例散布全場，基底幾何的包圍球不準
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    if (mesh.instanceMatrix.setUsage) mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(mesh);
    return mesh;
  });
  const colorKey = ['pants', 'shirt', 'skin'];
  const shown = new Uint8Array(cap);
  const colors = new Array(cap * 3).fill(null); // 每個 slot 三部位上次的顏色（沒變就不重寫）
  const m4 = new THREE.Matrix4();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const col = new THREE.Color();
  let visible = 0;
  let high = 0; // 已用過的最大 slot + 1（= InstancedMesh.count）
  let matrixDirty = false;
  let colorDirty = false;
  let disposed = false;

  const api = {
    get count() {
      return visible;
    },
    get max() {
      return cap;
    },
    meshes: parts,
    // 放置 slot i：腳底 (x, y, z)、遊戲 yaw（前進方向 = (sin yaw, cos yaw)）；回傳是否成功
    set(i, x, y, z, yaw, look = DEFAULT_LOOK) {
      if (disposed || !(i >= 0 && i < cap)) return false;
      const hgt = Number.isFinite(look.height) && look.height > 0 ? look.height : height;
      pos.set(x, y, z);
      quat.setFromAxisAngle(up, yaw + MODEL_YAW_OFFSET);
      scl.set(hgt, hgt, hgt);
      m4.compose(pos, quat, scl);
      for (let k = 0; k < 3; k++) {
        parts[k].setMatrixAt(i, m4);
        const c = look[colorKey[k]] ?? DEFAULT_LOOK[colorKey[k]];
        if (colors[i * 3 + k] !== c) {
          colors[i * 3 + k] = c;
          parts[k].setColorAt(i, col.set(c));
          colorDirty = true;
        }
      }
      if (!shown[i]) {
        shown[i] = 1;
        visible++;
        if (i >= high) high = i + 1;
      }
      matrixDirty = true;
      return true;
    },
    // 隱藏 slot i（縮成 0）；回傳是否原本顯示中
    hide(i) {
      if (disposed || !(i >= 0 && i < cap) || !shown[i]) return false;
      shown[i] = 0;
      visible--;
      for (const m of parts) m.setMatrixAt(i, zero);
      while (high > 0 && !shown[high - 1]) high--;
      matrixDirty = true;
      return true;
    },
    isShown(i) {
      return !!shown[i];
    },
    // 每幀改完呼叫一次：更新繪製數量、標記 GPU 緩衝需上傳（沒改就不上傳）
    commit() {
      if (disposed) return;
      for (const m of parts) {
        m.count = high;
        m.visible = high > 0;
        if (matrixDirty) m.instanceMatrix.needsUpdate = true;
        if (colorDirty && m.instanceColor) m.instanceColor.needsUpdate = true;
      }
      matrixDirty = false;
      colorDirty = false;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const m of parts) {
        scene.remove(m);
        m.geometry.dispose();
        m.material.dispose();
        if (m.dispose) m.dispose();
      }
      visible = 0;
      high = 0;
    },
  };
  return api;
}
