// 每幀排程（自 main.js 拆出）：rAF → 幀時間（上限 MAX_FRAME_DT）→ tick（世界更新 → 音效 → 渲染 → 效能統計 → 輸入收尾），
// 以及世界更新內「物理一幀」的固定順序（號誌 → PhysicsWorld.step 固定子步 → 對抗 → 插值同步 → 耐久 / 煙 → 遠距簡化 → 回收）
// 時間步契約（docs/dev/interfaces.md「時間步契約」）：dt = 渲染幀時間；simDt = 本幀物理實際推進的模擬秒數
//   （pw.simTimeFor(dt) = 子步數 × 1/60；60Hz 每幀 1 子步時 simDt = dt）。模擬計時（對抗時鐘、回收計時）吃 simDt，
//   插值 / 動畫 / 相機 / UI 吃 dt；號誌相位時間與耐久去重時鐘在固定子步內推進（main.js：pw.onBeforeStep → lights.step、
//   pw.onAfterStep → dmg.step），這裡每幀只刷新燈色 / 倒數與煙霧粒子
// 介面：依賴一律以物件傳入，本檔不持有遊戲狀態；main.js 的 updateGame / updateAttract 仍在 main.js，只在這裡排順序
import { setActiveByDistance } from '../physics/npc-bodies.js';

export const MAX_FRAME_DT = 0.1; // 單幀時間上限（s）；物理另有子步上限（world.js DEFAULT_MAX_SUBSTEPS）

// 物理一幀：stepWorld(dt, center) = 車流外部狀態 → pw.step（子步）→ 號誌燈色 / 倒數 → 對抗 → 插值同步 → 耐久煙霧 → 遠距簡化 → 回收；行人剛體由 traffic.sync 依分層計畫的 physicsRadius 自行啟用 / 休眠
// d = { pw, lights, camera, combat, player, vehicles, traffic, dmg, isDriving(), prepareTraffic(), advanceClock(simDt),
//       cleanup(simDt, center), activeRadius }
export function createWorldStep(d) {
  const { pw, lights, camera, combat, player, vehicles, traffic, dmg } = d;
  const entities = [];
  let physMs = 0;
  const step = (dt, center) => {
    const simDt = pw.simTimeFor(dt);
    d.prepareTraffic(); // setBlockers / setContext / setView
    const t0 = performance.now();
    pw.step(dt);
    physMs += performance.now() - t0;
    lights.update(); // 相位時間已在子步推進（lights.step）；依本幀結束的模擬時刻刷新燈色
    lights.updateVisuals(camera.position.x, camera.position.z);
    d.advanceClock(simDt);
    combat.update(simDt);
    if (!d.isDriving()) player.syncPhysics(dt);
    vehicles.sync();
    traffic.sync(dt, center);
    dmg.update(dt, center.x, center.z, 0); // 去重時鐘已在子步推進（dmg.step），這裡只推煙霧粒子（渲染 dt）
    entities.length = 0;
    setActiveByDistance(traffic.bodies(vehicles.bodies(entities)), center.x, center.z, d.activeRadius);
    d.cleanup(simDt, center);
  };
  return {
    step,
    get physMs() {
      return physMs;
    },
    resetPerf() {
      physMs = 0;
    },
  };
}

// 每幀 tick 與 rAF 驅動
// d = { world（createWorldStep 回傳）, isPaused(), isStarted(), updateGame(dt), updateAttract(dt), updateAudio(dt), render(),
//       recordPerf(renderMs | null, physMs, updateMs), updateFps(dt), endFrame(), adaptTick(dt)（自適應解析度）, raf? }
export function createFrameLoop(d) {
  const world = d.world;
  const raf = d.raf || ((cb) => requestAnimationFrame(cb));
  const updateWorld = (dt) => {
    if (d.isPaused()) return;
    if (d.isStarted()) d.updateGame(dt);
    else d.updateAttract(dt);
  };
  // 一幀：暫停時世界（物理、時間、AI、號誌）都不更新，但照常渲染
  const tick = (dt) => {
    d.adaptTick(dt);
    world.resetPerf();
    const t0 = performance.now();
    updateWorld(dt);
    d.updateAudio(dt); // 暫停中也呼叫（paused: true → 持續音源靜音）
    const t1 = performance.now();
    d.render();
    d.recordPerf(performance.now() - t1, world.physMs, t1 - t0 - world.physMs);
    d.updateFps(dt);
    d.endFrame();
  };
  let lastTime = performance.now();
  const frame = () => {
    raf(frame);
    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, MAX_FRAME_DT);
    lastTime = now;
    tick(dt);
  };
  // 手動推 n 幀（dev stepFrames）：同 tick 的順序，只在最後一幀渲染，不計 FPS / 自適應解析度
  const runFrames = (n, dt) => {
    for (let i = 0; i < n; i++) {
      world.resetPerf();
      const t0 = performance.now();
      updateWorld(dt);
      d.updateAudio(dt); // 同 tick：暫停中也呼叫
      const t1 = performance.now();
      const last = i === n - 1;
      if (last) d.render();
      d.recordPerf(last ? performance.now() - t1 : null, world.physMs, t1 - t0 - world.physMs);
      d.endFrame();
    }
  };
  return {
    tick,
    frame,
    runFrames,
    // 從現在重新計時（開始 / 繼續 / 關面板 / 回前景）：下一幀 dt 不含暫停期間
    resetClock() {
      lastTime = performance.now();
    },
  };
}
