// 物理世界：Rapier World 包裝 + 固定時間步累加器 + 渲染插值 + 查詢 / 事件包裝
// - 物理固定以 step（預設 1/60 s）前進；渲染幀以 alpha = 累加器餘量 / step 在前後兩步 transform 間插值
// - 單幀子步數上限 maxSubSteps，超過即丟棄餘量（避免卡頓後的「死亡螺旋」）
// - 事件佇列：每次 step() 開頭清空上一幀未取走的事件，同一幀所有子步的事件都保留到下一次 step()
// - 休眠：Rapier 剛體預設 canSleep = true；createBody() 也明確開啟
// 本檔不靜態 import rapier：initPhysics() 以動態 import 載入（瀏覽器由 Vite 分包），
// 其餘部分只用建構時注入的 RAPIER 物件，因此 node 無 rapier 時也能以 mock 測試累加器 / 插值 / 事件路由

export const DEFAULT_STEP = 1 / 60;
export const DEFAULT_MAX_SUBSTEPS = 5;
export const DEFAULT_GRAVITY = -9.81;

export async function initPhysics() {
  const mod = await import('@dimforge/rapier3d-compat');
  const RAPIER = mod.default || mod;
  await RAPIER.init();
  return RAPIER;
}

// 固定步累加器（純邏輯）；時間步契約見 docs/dev/interfaces.md「時間步契約」：
// 模擬狀態只在 onStep 子步內以 step 推進；渲染幀要知道「本幀實際推進的模擬秒數」用 advance 回傳的 simDt，
// 在 advance 之前（同一幀、累加器未變）要用則呼叫 preview(frameDt)，兩者相同
export class FixedStepper {
  constructor(step = DEFAULT_STEP, maxSubSteps = DEFAULT_MAX_SUBSTEPS) {
    this.step = step;
    this.maxSubSteps = maxSubSteps;
    this.acc = 0;
    this.dropped = 0; // 累計丟棄的時間（s），除錯用
  }

  // 前進 frameDt，每個子步呼叫 onStep(step)；回傳 { steps, alpha, simDt = steps × step }
  advance(frameDt, onStep) {
    if (!(frameDt > 0)) return { steps: 0, alpha: this.acc / this.step, simDt: 0 };
    this.acc += frameDt;
    let steps = 0;
    // 1e-9：吸收浮點誤差（例：0.1 / (1/60) 應為 6 步整）
    while (this.acc + 1e-9 >= this.step && steps < this.maxSubSteps) {
      onStep(this.step);
      this.acc -= this.step;
      steps++;
    }
    if (this.acc + 1e-9 >= this.step) {
      // 已達子步上限：丟棄全部餘量，下一幀從零開始
      this.dropped += this.acc;
      this.acc = 0;
    }
    if (this.acc < 0) this.acc = 0;
    return { steps, alpha: Math.min(this.acc / this.step, 1 - 1e-6), simDt: steps * this.step };
  }

  // advance(frameDt) 會跑幾個子步（不改狀態；與 advance 同一套判斷）
  preview(frameDt) {
    if (!(frameDt > 0)) return 0;
    let acc = this.acc + frameDt;
    let steps = 0;
    while (acc + 1e-9 >= this.step && steps < this.maxSubSteps) {
      acc -= this.step;
      steps++;
    }
    return steps;
  }

  reset() {
    this.acc = 0;
  }
}

// 受控物件的前後兩步 transform（純邏輯；body 只需 translation() / rotation()）
export class InterpolatedBody {
  constructor(body, onSync = null) {
    this.body = body;
    this.onSync = onSync;
    this.prev = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
    this.curr = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
    this.out = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
    this.reset();
  }

  _read(dst) {
    const t = this.body.translation();
    const r = this.body.rotation();
    dst.x = t.x;
    dst.y = t.y;
    dst.z = t.z;
    dst.qx = r.x;
    dst.qy = r.y;
    dst.qz = r.z;
    dst.qw = r.w;
  }

  // 每個物理子步後呼叫：curr → prev，讀新 curr
  capture() {
    Object.assign(this.prev, this.curr);
    this._read(this.curr);
  }

  // 瞬移後呼叫：前後兩步都設為目前位置，避免插值拖影
  reset() {
    this._read(this.curr);
    Object.assign(this.prev, this.curr);
  }

  // 位置線性插值、旋轉 nlerp（走最短弧）；結果寫入 out
  interpolate(alpha, out = this.out) {
    const a = this.prev;
    const b = this.curr;
    out.x = a.x + (b.x - a.x) * alpha;
    out.y = a.y + (b.y - a.y) * alpha;
    out.z = a.z + (b.z - a.z) * alpha;
    const dot = a.qx * b.qx + a.qy * b.qy + a.qz * b.qz + a.qw * b.qw;
    const s = dot < 0 ? -1 : 1;
    let qx = a.qx + (b.qx * s - a.qx) * alpha;
    let qy = a.qy + (b.qy * s - a.qy) * alpha;
    let qz = a.qz + (b.qz * s - a.qz) * alpha;
    let qw = a.qw + (b.qw * s - a.qw) * alpha;
    const l = Math.hypot(qx, qy, qz, qw) || 1;
    out.qx = qx / l;
    out.qy = qy / l;
    out.qz = qz / l;
    out.qw = qw / l;
    return out;
  }
}

export class PhysicsWorld {
  constructor(RAPIER, { gravity = DEFAULT_GRAVITY, step = DEFAULT_STEP, maxSubSteps = DEFAULT_MAX_SUBSTEPS } = {}) {
    this.RAPIER = RAPIER;
    this.world = new RAPIER.World({ x: 0, y: gravity, z: 0 });
    this.world.timestep = step;
    // autoDrain = false：由本類別在每幀開頭 clear()，讓同一幀多個子步的事件都能被 drain
    this.eventQueue = new RAPIER.EventQueue(false);
    this.stepper = new FixedStepper(step, maxSubSteps);
    this.handles = new Set();
    this.beforeStep = new Set();
    this.afterStep = new Set();
    this.paused = false;
    this.alpha = 0;
    this.stepCount = 0;
  }

  // 建立剛體（預設開啟休眠；由程式每步驅動的 kinematic 角色傳 false）
  createBody(desc, canSleep = true) {
    desc.setCanSleep(canSleep);
    return this.world.createRigidBody(desc);
  }

  // 登記受控物件：每個子步後保存 transform；step() 結束時以插值結果呼叫 onSync(out, handle)
  register(body, onSync = null) {
    const h = new InterpolatedBody(body, onSync);
    this.handles.add(h);
    return h;
  }

  unregister(handle) {
    this.handles.delete(handle);
  }

  // 每個子步前 / 後的回呼（角色 move、車輛控制器更新放 beforeStep）；回傳取消函式
  onBeforeStep(cb) {
    this.beforeStep.add(cb);
    return () => this.beforeStep.delete(cb);
  }

  onAfterStep(cb) {
    this.afterStep.add(cb);
    return () => this.afterStep.delete(cb);
  }

  // 單一物理子步（測試 / 無插值場合直接呼叫）
  stepOnce(dt = this.stepper.step) {
    for (const cb of this.beforeStep) cb(dt);
    this.world.step(this.eventQueue);
    this.stepCount++;
    for (const h of this.handles) h.capture();
    for (const cb of this.afterStep) cb(dt);
  }

  // step(frameDt) 將推進的模擬秒數（暫停中 0）：物理 step 之前就要推進的模擬計時（號誌、KO 倒數）用這個值，不用 frameDt
  simTimeFor(frameDt) {
    return this.paused ? 0 : this.stepper.preview(frameDt) * this.stepper.step;
  }

  // 每個渲染幀呼叫一次；回傳 { steps, alpha, simDt }
  step(frameDt) {
    if (this.paused) return { steps: 0, alpha: this.alpha, simDt: 0 };
    this.eventQueue.clear();
    const res = this.stepper.advance(frameDt, (dt) => this.stepOnce(dt));
    this.alpha = res.alpha;
    for (const h of this.handles) {
      if (h.onSync) h.onSync(h.interpolate(res.alpha), h);
    }
    return res;
  }

  // 切背景（visibilitychange）時暫停：累加器歸零，插值狀態對齊目前位置
  pause() {
    this.paused = true;
    this.stepper.reset();
    this.alpha = 0;
    for (const h of this.handles) h.reset();
  }

  resume() {
    this.paused = false;
    this.stepper.reset();
    this.alpha = 0;
  }

  // ---------- 查詢包裝 ----------
  // opts：{ solid = true, groups, flags, excludeCollider, excludeBody, predicate }
  // 回傳 { collider, toi, x, y, z, nx, ny, nz } 或 null
  castRay(origin, dir, maxToi, opts = {}) {
    const R = this.RAPIER;
    const ray = new R.Ray(origin, dir);
    const hit = this.world.castRayAndGetNormal(
      ray,
      maxToi,
      opts.solid !== false,
      opts.flags,
      opts.groups,
      opts.excludeCollider,
      opts.excludeBody,
      opts.predicate,
    );
    if (!hit) return null;
    const t = hit.timeOfImpact;
    return {
      collider: hit.collider,
      toi: t,
      x: origin.x + dir.x * t,
      y: origin.y + dir.y * t,
      z: origin.z + dir.z * t,
      nx: hit.normal.x,
      ny: hit.normal.y,
      nz: hit.normal.z,
    };
  }

  // 形狀掃掠：pos / rot 起始姿態，vel 掃掠方向（× maxToi = 最遠距離）；回傳 ColliderShapeCastHit 或 null
  castShape(pos, rot, vel, shape, maxToi, opts = {}) {
    return this.world.castShape(
      pos,
      rot,
      vel,
      shape,
      opts.targetDistance ?? 0,
      maxToi,
      opts.stopAtPenetration !== false,
      opts.flags,
      opts.groups,
      opts.excludeCollider,
      opts.excludeBody,
      opts.predicate,
    );
  }

  // 與形狀重疊的所有 collider；cb(collider) 回傳 false 可提前結束；回傳重疊數
  intersections(pos, rot, shape, cb = null, opts = {}) {
    let n = 0;
    this.world.intersectionsWithShape(
      pos,
      rot,
      shape,
      (c) => {
        n++;
        return cb ? cb(c) !== false : true;
      },
      opts.flags,
      opts.groups,
      opts.excludeCollider,
      opts.excludeBody,
      opts.predicate,
    );
    return n;
  }

  // ---------- 事件（D2c2 車輛撞擊 / D5 對抗用）----------
  // cb(collider1, collider2, started, handle1, handle2)；collider 已被移除時為 null
  drainContacts(cb) {
    this.eventQueue.drainCollisionEvents((h1, h2, started) => {
      cb(this._colliderOrNull(h1), this._colliderOrNull(h2), started, h1, h2);
    });
  }

  // cb({ collider1, collider2, handle1, handle2, totalForceMagnitude, maxForceMagnitude, maxForceDirection })
  // event 物件僅在回呼期間有效（Rapier Temp 物件），需要保留請複製數值
  drainContactForces(cb) {
    this.eventQueue.drainContactForceEvents((e) => {
      const h1 = e.collider1();
      const h2 = e.collider2();
      cb({
        collider1: this._colliderOrNull(h1),
        collider2: this._colliderOrNull(h2),
        handle1: h1,
        handle2: h2,
        totalForceMagnitude: e.totalForceMagnitude(),
        maxForceMagnitude: e.maxForceMagnitude(),
        maxForceDirection: e.maxForceDirection(),
      });
    });
  }

  _colliderOrNull(handle) {
    return this.world.getCollider(handle) || null;
  }

  dispose() {
    this.handles.clear();
    this.beforeStep.clear();
    this.afterStep.clear();
    this.eventQueue.free();
    this.world.free();
    this.eventQueue = null;
    this.world = null;
  }
}
