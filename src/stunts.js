// 特技跳台（Phase 16，§38 Unique Stunt Jumps，GTA 經典）：全城 5 處程式產生的坡道（坡面黃黑警示條紋 = 頂點色，不新增貼圖），
//   駕車以 ≥ LAUNCH_SPEED 從坡道起飛、落在指定落地區（矩形 / 圓）且未翻車 → 成功；起飛瞬間慢動作（timeScale SLOWMO_SCALE）+ 側邊追蹤電影鏡頭，
//   落地結算滯空 / 距離 / 高度 / 空中旋轉（翻滾加分），HUD 結算面板 PANEL_SEC 秒；首次成功賞金、全 5 處完成額外獎勵；完成狀態存檔。
// 純邏輯模組，不 import three / rapier：3D 網格在 createRampMesh（THREE 由參數注入）、碰撞在 addRampColliders（RAPIER 由參數注入）、DOM 只在 createStuntHud。
//
// createStunts({ bus, groundAt, list, config }) → { update(dt, sample, ctx) → out, timeScale, cam, markers(out), cancel(), serialize(), restore(rec),
//   isDone(id), doneCount, allDone, active, phase, current, dispose() }
//   groundAt(x, z) → 地面高度（main：heightAt；省略 = 0）——最高高度 / 電影鏡頭離地用
//   dt = 渲染幀實際秒數（未乘 timeScale；clamp ≤ MAX_DT）：慢動作時長 / 鏡頭淡入淡出 / 面板計時都吃此值（與幀率、與 timeScale 無關）；
//     滯空時間等模擬量吃 dt × 本幀開始時的 timeScale（= 呼叫端本幀套用到世界更新的倍率）
//   sample（呼叫端每幀填同一物件）：{ active（駕駛中且車體為動態剛體）, vehicle（車輛身分，換車即中止）, x, y, z（插值後的車身原點）,
//     vx, vy, vz（剛體線速度）, qx, qy, qz, qw（車身姿態）, grounded（任一輪接地）}
//   ctx = { busy, earn(n, reason), toast?(text, sec) }：busy = 任務 / 競速 / 警車任務 / 副任務 / 暴走 / 搶劫 / 噴漆 / 被捕・死亡重生畫面進行中（不含通緝星數）
// 狀態：idle → 在坡面上（接地且位於坡道範圍）記下 lastRamp → 離地且已到坡頂附近 → 起飛候選（記下離地瞬間的位置 / 速度）
//   → 連續離地 LAUNCH_CONFIRM 秒確認起飛：速度 ≥ LAUNCH_SPEED、沿坡道方向、非 busy → 'air'（emit stunt:launch、慢動作、電影鏡頭）；
//     速度不足 / busy → 不觸發（busy = 互斥選擇「完全不觸發」：不慢動作、不計成功、不給錢；同 GTA SA 任務中跳台不計）
//     起飛後（'air' / 'settle'）busy 轉 true（空中被捕 / 死亡 / 任務開始）→ 立即無聲中止（同下車：cancel、不結算不給錢、timeScale 1、鏡頭立即歸還）
//   'air'：累計滯空（模擬秒）、最高高度、旋轉（四元數逐幀夾角總和）、翻滾（車頂方向逐幀夾角總和）；連續接地 LAND_CONFIRM 秒 → 著地（落點 = 起飛後第一個接地幀，
//     之後彈跳離地再接地不覆寫落點 / 滯空時間；翻車 / 落地區判定以此點為準，同 GTA 以第一次觸地為準）
//     → 慢動作結束、'settle'；滯空中速度 < CRASH_SPEED 持續 CRASH_SEC（側躺 / 卡住）或滯空超過 AIR_MAX → 失敗 crash
//   'settle'：SETTLE_SEC 秒內車頂朝上分量 < UPRIGHT_MIN → 翻車失敗 crash；否則落點在落地區內 → 成功，不在 → 失敗 miss
//   任何階段下車 / 換車 / 車體轉 kinematic / busy → 無聲中止（stunt:land success false、reason 'cancel'，不 toast）
// 慢動作：起飛確認當幀起 timeScale = SLOWMO_SCALE，持續到著地（第一個接地幀；彈跳也結束）或 SLOWMO_MAX 秒（實際時間）先到者；其餘時間 1
// 電影鏡頭：cam.weight 0→1（CAM_IN 秒）跟拍到結束（著地後再 CAM_HOLD 秒，或起飛後 CAM_MAX 秒），再 1→0（CAM_OUT 秒）平滑交回跟車鏡頭；
//   cam = { weight（已 smoothstep）, px, py, pz（鏡頭位置）, tx, ty, tz（注視點）}：坡道側邊 CAM_SIDE m、略後 CAM_BACK m、高 CAM_UP m 追蹤車身
// 評分 scoreJump（純函式）：airTime × 100 + distance × 10 + height × 25 + rotation° × 0.5 + 翻滾（tumble ≥ TUMBLE_MIN 時 tumble° × 1.5）+ 整圈翻滾 × FLIP_BONUS
// 獎勵：每處首次成功 REWARD（NT$500，earn(n, 'stunt')）；5 處全部完成的那次另給 ALL_BONUS（NT$5000，只給一次）；重複成功只顯示分數
// 每幀路徑不配置物件（out / cam / 標記重用；面板字串只在結算時組一次）；事件 payload 只在事件發生時配置
export const LAUNCH_SPEED = 22; // m/s，起飛速度門檻（約 79 km/h）
export const SLOWMO_SCALE = 0.35; // 慢動作 timeScale
export const SLOWMO_MAX = 2.5; // s（實際時間），慢動作最長
export const MAX_DT = 0.1; // s，單幀 dt 上限
export const LAUNCH_CONFIRM = 0.05; // s（模擬），連續離地多久才算起飛（濾掉坡面顛簸）
export const LAND_CONFIRM = 0.1; // s（模擬），連續接地多久才算著地（濾掉著地彈跳）
export const SETTLE_SEC = 0.6; // s（模擬），著地後檢查翻車的時間
export const UPRIGHT_MIN = 0.5; // 車頂朝上分量（up.y）下限：低於 = 翻車
export const AIR_MAX = 8; // s（模擬），滯空上限（卡在奇怪地方）
export const CRASH_SPEED = 3; // m/s，滯空中低於此速度持續 CRASH_SEC → 視為摔車（四輪朝天 / 側躺不會「接地」）
export const CRASH_SEC = 0.5;
export const RAMP_ARM_SEC = 0.5; // s（模擬），離開坡面後多久內離地仍算從坡道起飛
export const LIP_MARGIN = 1.5; // m，坡頂前多少就算到頂（輪子在坡頂前一點離地）
export const LIP_OVER = 4; // m，坡頂後多少內離地仍算起飛
export const SIDE_MARGIN = 1.5; // m，坡道兩側外擴
export const DIR_MIN = 0.7; // 起飛速度方向與坡道方向的水平夾角餘弦下限
export const PANEL_SEC = 3; // s，結算面板顯示時間
export const REWARD = 500; // NT$，每處首次成功
export const ALL_BONUS = 5000; // NT$，全部完成額外獎勵
export const FLIP_BONUS = 500; // 分，每整圈翻滾
export const TUMBLE_MIN = 45; // °，翻滾加分門檻
export const CAM_IN = 0.25; // s，電影鏡頭淡入
export const CAM_OUT = 0.8; // s，交回跟車鏡頭
export const CAM_HOLD = 0.5; // s，著地後電影鏡頭再停留
export const CAM_MAX = 3.5; // s，起飛後電影鏡頭最長
export const CAM_SIDE = 12; // m
export const CAM_BACK = 4; // m
export const CAM_UP = 3; // m
export const CAM_GROUND_CLEAR = 1.5; // m，電影鏡頭離地下限
export const RAMP_LEN = 10; // m，坡道水平長度（坡腳 → 坡頂）
export const RAMP_WIDTH = 7; // m
export const RAMP_HEIGHT = 2.6; // m，坡頂高（坡度約 14.6°）
export const RAMP_SINK = 0.5; // m，碰撞 / 網格底面埋入地面（地形起伏不露縫）
export const STRIPES = 8; // 坡面黃黑條紋數（沿坡道方向交替）
export const MARKER_KIND = 'stunt'; // 小地圖 / 大地圖：未完成
export const MARKER_KIND_DONE = 'stunt-done'; // 已完成（淡化）
export const FAIL_REASONS = Object.freeze(['miss', 'crash', 'cancel']);
export const FAIL_TEXT = Object.freeze({ miss: '沒落在落地區', crash: '翻車了' });
export const toastFail = (reason) => `特技跳躍失敗：${FAIL_TEXT[reason] || reason}`;
export const toastReward = (n) => `首次完成特技跳躍！賞金 NT$${n}`;
export const toastAllDone = (n) => `全部特技跳台完成！額外獎勵 NT$${n}`;

// 跳台：x / z = 坡腳中心、yawDeg = 起飛方向（前進方向 = (sin, cos)，同車輛 yaw）；坡道前方 ≥ 80 m 助跑（多半是道路）、坡道本體不壓車流道路；
//   land = 落地區（相對坡頂沿起飛方向）：rect { from, to（m）, halfWidth } 或 circle { at（m）, r }
//   tools/test/p16-stunts.mjs 逐處驗證：助跑 80 m 可行駛（無建築 / 水面、在地圖內、坡度平緩、多半在道路上）、坡道 / 落地區無建築、在地圖內
export const STUNTS_RAW = [
  {
    id: 'stunt-qiuhonggu',
    name: '秋紅谷南緣飛躍',
    x: 170,
    z: -456,
    yawDeg: 0,
    src: '臺灣大道三段往北助跑，飛越秋紅谷南側草坡',
    land: { shape: 'rect', from: 12, to: 80, halfWidth: 9 },
  },
  {
    id: 'stunt-qhg-parking',
    name: '秋紅谷停車場飛躍',
    x: 278,
    z: -366,
    yawDeg: 315,
    src: '河南路二段 / 臺灣大道三段往西北助跑，落入秋紅谷東北角平面停車場',
    land: { shape: 'circle', at: 40, r: 25 },
  },
  {
    id: 'stunt-shinkong',
    name: '新光三越停車場口飛躍',
    x: 596,
    z: 12,
    yawDeg: 150,
    src: '市政北七路 / 新光三越停車場入口往東南助跑',
    land: { shape: 'rect', from: 12, to: 80, halfWidth: 9 },
  },
  {
    id: 'stunt-taiwan-blvd',
    name: '臺灣大道飛躍',
    x: 968,
    z: 96,
    yawDeg: 15,
    src: '臺灣大道三段寬直路段往北助跑，衝出路旁空地',
    land: { shape: 'rect', from: 12, to: 80, halfWidth: 9 },
  },
  {
    id: 'stunt-henan',
    name: '河南路飛躍',
    x: -119,
    z: 324,
    yawDeg: 165,
    src: '河南路三段（12 m 寬）寬直路段往南助跑，衝出路旁空地',
    land: { shape: 'rect', from: 12, to: 80, halfWidth: 9 },
  },
];

const DEG = Math.PI / 180;

// 坡道座標系：f = 起飛方向、l = 左方（同車輛本地 +X）；坡頂中心 lip；落地區換成世界座標 zone
export function rampFrame(def) {
  const a = def.yawDeg * DEG;
  const fx = Math.sin(a);
  const fz = Math.cos(a);
  return { fx, fz, lx: fz, lz: -fx, lipX: def.x + fx * RAMP_LEN, lipZ: def.z + fz * RAMP_LEN };
}
export function landZone(def) {
  const f = rampFrame(def);
  const L = def.land || {};
  if (L.shape === 'circle') return { shape: 'circle', x: f.lipX + f.fx * L.at, z: f.lipZ + f.fz * L.at, r: L.r };
  const mid = (L.from + L.to) / 2;
  return { shape: 'rect', x: f.lipX + f.fx * mid, z: f.lipZ + f.fz * mid, fx: f.fx, fz: f.fz, halfLen: (L.to - L.from) / 2, halfWidth: L.halfWidth };
}
export function inZone(zone, x, z) {
  if (!zone) return false;
  const dx = x - zone.x;
  const dz = z - zone.z;
  if (zone.shape === 'circle') return dx * dx + dz * dz <= zone.r * zone.r;
  const along = dx * zone.fx + dz * zone.fz;
  const side = dx * zone.fz - dz * zone.fx;
  return Math.abs(along) <= zone.halfLen && Math.abs(side) <= zone.halfWidth;
}
// 點在坡道座標系的 (s 沿起飛方向距坡腳, l 往左)
export function rampLocal(def, frame, x, z) {
  const dx = x - def.x;
  const dz = z - def.z;
  return { s: dx * frame.fx + dz * frame.fz, l: dx * frame.lx + dz * frame.lz };
}

export const STUNTS = Object.freeze(STUNTS_RAW.map((d) => Object.freeze({ ...d, frame: Object.freeze(rampFrame(d)), zone: Object.freeze(landZone(d)) })));
export const stuntById = (id, list = STUNTS) => list.find((s) => s.id === id) || null;

// 評分（純函式）：r = { airTime（s）, distance（m）, height（m）, rotation（°）, tumble（°）} → { score, flips, parts }
export function scoreJump(r) {
  const air = Math.round((r.airTime || 0) * 100);
  const dist = Math.round((r.distance || 0) * 10);
  const height = Math.round((r.height || 0) * 25);
  const rot = Math.round((r.rotation || 0) * 0.5);
  const tumble = (r.tumble || 0) >= TUMBLE_MIN ? Math.round(r.tumble * 1.5) : 0;
  const flips = Math.floor(((r.tumble || 0) + 45) / 360);
  const flip = flips * FLIP_BONUS;
  return { score: air + dist + height + rot + tumble + flip, flips, parts: { air, dist, height, rot, tumble, flip } };
}

// 結算面板文字（成功時組一次）
export function panelText(def, r, sc, reward, bonus) {
  const lines = [
    `滯空 ${r.airTime.toFixed(2)} 秒`,
    `距離 ${r.distance.toFixed(1)} m`,
    `最高 ${r.height.toFixed(1)} m`,
    `旋轉 ${Math.round(r.rotation)}°${sc.flips > 0 ? `（翻滾 ${sc.flips} 圈）` : ''}`,
    `分數 ${sc.score}`,
  ];
  if (reward > 0) lines.push(`首次完成賞金 NT$${reward}`);
  if (bonus > 0) lines.push(`全部完成獎勵 NT$${bonus}`);
  return { title: `特技跳躍成功！${def.name}`, lines };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (t) => t * t * (3 - 2 * t);
// 四元數夾角（rad）與車頂方向 / 前方
const quatAngle = (ax, ay, az, aw, bx, by, bz, bw) => 2 * Math.acos(Math.min(1, Math.abs(ax * bx + ay * by + az * bz + aw * bw)));
const upYOf = (q) => 1 - 2 * (q.qx * q.qx + q.qz * q.qz);
function upOf(q, out) {
  out.x = 2 * (q.qx * q.qy - q.qw * q.qz);
  out.y = 1 - 2 * (q.qx * q.qx + q.qz * q.qz);
  out.z = 2 * (q.qy * q.qz + q.qw * q.qx);
  return out;
}

export function createStunts({ bus = null, groundAt = null, list = STUNTS, config = {} } = {}) {
  const C = {
    launchSpeed: LAUNCH_SPEED,
    slowmoScale: SLOWMO_SCALE,
    slowmoMax: SLOWMO_MAX,
    maxDt: MAX_DT,
    launchConfirm: LAUNCH_CONFIRM,
    landConfirm: LAND_CONFIRM,
    settleSec: SETTLE_SEC,
    uprightMin: UPRIGHT_MIN,
    airMax: AIR_MAX,
    crashSpeed: CRASH_SPEED,
    crashSec: CRASH_SEC,
    panelSec: PANEL_SEC,
    reward: REWARD,
    allBonus: ALL_BONUS,
    ...config,
  };
  const ground = (x, z) => (typeof groundAt === 'function' ? groundAt(x, z) || 0 : 0);
  const done = new Set();
  const mk = list.map((d) => ({ x: d.x + d.frame.fx * RAMP_LEN * 0.5, z: d.z + d.frame.fz * RAMP_LEN * 0.5, kind: MARKER_KIND, id: d.id }));
  const cam = { weight: 0, px: 0, py: 0, pz: 0, tx: 0, ty: 0, tz: 0 };
  const out = { phase: 'idle', id: null, timeScale: 1, cam, panel: null, panelRemain: 0, result: null };
  const up = { x: 0, y: 1, z: 0 };
  // 進行中的一跳（重用同一物件）
  const J = {
    def: null, vehicle: null, idx: -1,
    // 起飛候選 / 確認
    candT: -1, lx: 0, ly: 0, lz: 0, speed: 0, dirOk: false, rideH: 0, cqx: 0, cqy: 0, cqz: 0, cqw: 1, cux: 0, cuy: 1, cuz: 0,
    // 滯空量
    airTime: 0, maxAbove: 0, rotation: 0, tumble: 0, pqx: 0, pqy: 0, pqz: 0, pqw: 1, pux: 0, puy: 1, puz: 0, slowT: 0, camT: 0, crashT: 0,
    // 著地
    groundT: 0, touched: false, tx: 0, tz: 0, touchAir: 0, settleT: 0, holdT: 0,
  };
  let phase = 'idle'; // idle | air | settle
  let timeScale = 1;
  let lastRamp = -1; // 最近一次接地所在坡道
  let sinceRamp = Infinity; // 離開該坡面的模擬秒數
  let camOn = false;
  let camW = 0;
  let side = 1;
  let camDef = null; // 電影鏡頭所屬坡道（著地後淡出期間仍沿用）
  let panelT = 0;

  const emit = (name, payload) => {
    if (bus && typeof bus.emit === 'function') bus.emit(name, payload);
  };
  const toast = (ctx, text, sec) => {
    if (ctx && typeof ctx.toast === 'function') ctx.toast(text, sec);
    else emit('toast', { text, seconds: sec });
  };

  function resetJump() {
    J.def = null;
    J.vehicle = null;
    J.idx = -1;
    J.candT = -1;
    J.airTime = 0;
    J.maxAbove = 0;
    J.rotation = 0;
    J.tumble = 0;
    J.slowT = 0;
    J.crashT = 0;
    J.groundT = 0;
    J.touched = false;
    J.settleT = 0;
    J.holdT = 0;
    phase = 'idle';
    timeScale = 1;
  }

  // 坡道範圍判定：(s, l) 在坡腳前 1 m 到坡頂 + over、左右含 SIDE_MARGIN
  function onRamp(d, x, z, sMin, sMax) {
    const f = d.frame;
    const dx = x - d.x;
    const dz = z - d.z;
    const s = dx * f.fx + dz * f.fz;
    const l = dx * f.lx + dz * f.lz;
    return s >= sMin && s <= sMax && Math.abs(l) <= RAMP_WIDTH / 2 + SIDE_MARGIN;
  }

  function finishResult(success, reason, ctx) {
    const def = J.def;
    const dist = Math.hypot(J.tx - J.lx, J.tz - J.lz);
    const r = {
      airTime: J.touchAir,
      distance: dist,
      height: Math.max(0, J.maxAbove - J.rideH),
      rotation: J.rotation / DEG,
      tumble: J.tumble / DEG,
    };
    const sc = scoreJump(r);
    const base = { id: def.id, success, reason, x: J.tx, z: J.tz, ...r, flips: sc.flips, score: sc.score };
    out.result = base;
    emit('stunt:land', base);
    if (!success) {
      if (reason !== 'cancel') toast(ctx, toastFail(reason), 2.5);
      return;
    }
    const first = !done.has(def.id);
    done.add(def.id);
    const reward = first ? C.reward : 0;
    const all = first && list.every((d) => done.has(d.id));
    const bonus = all ? C.allBonus : 0;
    if (reward > 0 && ctx && typeof ctx.earn === 'function') ctx.earn(reward, 'stunt');
    if (bonus > 0 && ctx && typeof ctx.earn === 'function') ctx.earn(bonus, 'stunt');
    if (reward > 0) toast(ctx, toastReward(reward), 3);
    if (bonus > 0) toast(ctx, toastAllDone(bonus), 5);
    out.panel = panelText(def, r, sc, reward, bonus);
    panelT = C.panelSec;
    emit('stunt:complete', { id: def.id, first, reward, all, bonus, score: sc.score, ...r, flips: sc.flips });
  }

  // 中止（下車 / 換車 / cancel）：無聲
  function abort(ctx) {
    if (phase === 'idle') return;
    J.touchAir = J.airTime;
    J.tx = J.lx;
    J.tz = J.lz;
    finishResult(false, 'cancel', ctx);
    camOn = false;
    resetJump();
  }

  function sampleCam(sample) {
    const def = camDef;
    if (!def || !sample) return;
    const f = def.frame;
    const px = sample.x + f.lx * CAM_SIDE * side - f.fx * CAM_BACK;
    const pz = sample.z + f.lz * CAM_SIDE * side - f.fz * CAM_BACK;
    cam.px = px;
    cam.pz = pz;
    cam.py = Math.max(sample.y + CAM_UP, ground(px, pz) + CAM_GROUND_CLEAR);
    cam.tx = sample.x;
    cam.ty = sample.y + 0.8;
    cam.tz = sample.z;
  }

  function update(dt, sample, ctx = {}) {
    const step = Math.min(C.maxDt, Math.max(0, Number(dt) || 0));
    const sim = step * timeScale; // 本幀世界實際推進的模擬秒數（呼叫端以同一 timeScale 縮放）
    const s = sample;
    const driving = !!(s && s.active);

    if (phase !== 'idle' && (!driving || s.vehicle !== J.vehicle || (ctx && ctx.busy))) {
      const busy = !!(ctx && ctx.busy);
      abort(ctx);
      if (busy) {
        // 空中被捕 / 死亡 / 任務開始：鏡頭立即歸還（不淡出），不留殘留狀態
        camDef = null;
        camW = 0;
        cam.weight = 0;
        lastRamp = -1;
        sinceRamp = Infinity;
      }
    }

    if (phase === 'idle') {
      if (!driving) {
        lastRamp = -1;
        sinceRamp = Infinity;
        J.candT = -1;
      } else if (s.grounded) {
        J.candT = -1;
        let on = -1;
        for (let i = 0; i < list.length; i++) {
          if (onRamp(list[i], s.x, s.z, -1, RAMP_LEN + 0.5)) {
            on = i;
            break;
          }
        }
        if (on >= 0) {
          lastRamp = on;
          sinceRamp = 0;
          J.vehicle = s.vehicle;
        } else sinceRamp += sim;
      } else {
        sinceRamp += sim;
        const d = lastRamp >= 0 ? list[lastRamp] : null;
        if (J.candT < 0) {
          // 離地瞬間：在坡頂附近、剛離開坡面 → 起飛候選（記下離地位置 / 速度 / 車身離坡頂高度）
          if (d && sinceRamp <= RAMP_ARM_SEC && J.vehicle === s.vehicle && onRamp(d, s.x, s.z, RAMP_LEN - LIP_MARGIN, RAMP_LEN + LIP_OVER)) {
            J.candT = 0;
            J.idx = lastRamp;
            J.lx = s.x;
            J.ly = s.y;
            J.lz = s.z;
            const hs = Math.hypot(s.vx, s.vz);
            J.speed = Math.hypot(s.vx, s.vy, s.vz);
            J.dirOk = hs > 1e-6 && (s.vx * d.frame.fx + s.vz * d.frame.fz) / hs >= DIR_MIN;
            J.rideH = s.y - (ground(d.x, d.z) + RAMP_HEIGHT);
            J.cqx = s.qx;
            J.cqy = s.qy;
            J.cqz = s.qz;
            J.cqw = s.qw;
            upOf(s, up);
            J.cux = up.x;
            J.cuy = up.y;
            J.cuz = up.z;
          }
        } else {
          J.candT += sim;
          if (J.candT >= C.launchConfirm - 1e-9) {
            const def = list[J.idx];
            const airborne = J.candT;
            J.candT = -1;
            lastRamp = -1;
            if (J.speed >= C.launchSpeed && J.dirOk && !ctx.busy) launch(def, s, airborne);
          }
        }
      }
    } else if (phase === 'air') {
      J.airTime += sim;
      J.slowT += step;
      if (J.slowT >= C.slowmoMax - 1e-9) timeScale = 1;
      const above = s.y - ground(s.x, s.z);
      if (above > J.maxAbove) J.maxAbove = above;
      J.rotation += quatAngle(J.pqx, J.pqy, J.pqz, J.pqw, s.qx, s.qy, s.qz, s.qw);
      upOf(s, up);
      J.tumble += Math.acos(Math.max(-1, Math.min(1, up.x * J.pux + up.y * J.puy + up.z * J.puz)));
      J.pqx = s.qx;
      J.pqy = s.qy;
      J.pqz = s.qz;
      J.pqw = s.qw;
      J.pux = up.x;
      J.puy = up.y;
      J.puz = up.z;
      if (s.grounded) {
        if (!J.touched) {
          // 落點鎖定在第一個接地幀：之後彈跳（groundT 歸零再接地）不覆寫
          J.touched = true;
          J.tx = s.x;
          J.tz = s.z;
          J.touchAir = J.airTime;
          timeScale = 1; // 慢動作持續到著地（第一個接地幀）
        }
        J.groundT += sim;
        if (J.groundT >= C.landConfirm - 1e-9) {
          phase = 'settle';
          J.settleT = 0;
          J.holdT = 0;
        }
      } else J.groundT = 0; // 彈跳：只重設著地確認計時，落點維持第一個接地幀
      if (phase === 'air') {
        J.crashT = Math.hypot(s.vx, s.vy, s.vz) < C.crashSpeed ? J.crashT + sim : 0;
        if (J.crashT >= C.crashSec || J.airTime >= C.airMax) {
          if (!J.touched) {
            J.tx = s.x;
            J.tz = s.z;
            J.touchAir = J.airTime;
          }
          finishResult(false, 'crash', ctx);
          resetJump();
        }
      }
    } else if (phase === 'settle') {
      J.settleT += sim;
      J.holdT += step;
      if (upYOf(s) < C.uprightMin) {
        finishResult(false, 'crash', ctx);
        resetJump();
      } else if (J.settleT >= C.settleSec - 1e-9) {
        const ok = inZone(J.def.zone, J.tx, J.tz);
        finishResult(ok, ok ? null : 'miss', ctx);
        resetJump();
      }
    }

    // 電影鏡頭：起飛後開、著地後 CAM_HOLD 或起飛後 CAM_MAX 關；權重以實際時間平滑
    if (camOn) {
      J.camT += step;
      const holdOver = phase === 'idle' || (phase === 'settle' && J.holdT >= CAM_HOLD);
      if (holdOver || J.camT >= CAM_MAX) camOn = false;
    }
    camW = clamp01(camW + (camOn ? step / CAM_IN : -step / CAM_OUT));
    cam.weight = smooth(camW);
    if (camW > 0 && driving) sampleCam(s);
    else if (camW > 0 && !driving) {
      camW = 0;
      cam.weight = 0;
    }

    if (panelT > 0) {
      panelT = Math.max(0, panelT - step);
      if (panelT === 0) out.panel = null;
    }
    out.phase = phase;
    out.id = J.def ? J.def.id : null;
    out.timeScale = timeScale;
    out.panelRemain = panelT;
    return out;
  }

  function launch(def, s, airborne) {
    J.def = def;
    J.vehicle = s.vehicle;
    J.airTime = airborne; // 確認期間已在空中
    J.maxAbove = Math.max(0, J.ly - ground(J.lx, J.lz));
    // 確認期間（離地 → 確認）的旋轉也算進來
    upOf(s, up);
    J.rotation = quatAngle(J.cqx, J.cqy, J.cqz, J.cqw, s.qx, s.qy, s.qz, s.qw);
    J.tumble = Math.acos(Math.max(-1, Math.min(1, up.x * J.cux + up.y * J.cuy + up.z * J.cuz)));
    J.pqx = s.qx;
    J.pqy = s.qy;
    J.pqz = s.qz;
    J.pqw = s.qw;
    J.pux = up.x;
    J.puy = up.y;
    J.puz = up.z;
    J.slowT = 0;
    J.camT = 0;
    J.crashT = 0;
    J.groundT = 0;
    J.touched = false;
    phase = 'air';
    timeScale = C.slowmoScale;
    camOn = true;
    camDef = def;
    side = list.indexOf(def) % 2 === 0 ? 1 : -1; // 左右交替，避免每處都同一側
    out.result = null;
    emit('stunt:launch', { id: def.id, name: def.name, speed: J.speed, x: J.lx, y: J.ly, z: J.lz });
  }

  // 回主選單 / 開新局：無聲中止、鏡頭與時間立即復原、面板收起
  function cancel() {
    abort(null);
    resetJump();
    lastRamp = -1;
    sinceRamp = Infinity;
    camOn = false;
    camDef = null;
    camW = 0;
    cam.weight = 0;
    panelT = 0;
    out.panel = null;
    out.phase = 'idle';
    out.id = null;
    out.timeScale = 1;
    out.panelRemain = 0;
  }

  // 全部 5 處都列出：未完成 kind 'stunt'、已完成 'stunt-done'（小地圖 / 大地圖淡化）
  function markers(buf = []) {
    for (let i = 0; i < list.length; i++) {
      mk[i].kind = done.has(list[i].id) ? MARKER_KIND_DONE : MARKER_KIND;
      buf.push(mk[i]);
    }
    return buf;
  }

  function serialize() {
    const ids = list.filter((d) => done.has(d.id)).map((d) => d.id);
    return ids.length ? { done: ids } : null;
  }

  // 舊存檔沒有此欄 / 格式錯誤 → 全部未完成；未知 id 略過
  function restore(rec) {
    cancel();
    done.clear();
    const ids = rec && Array.isArray(rec.done) ? rec.done : [];
    for (const id of ids) if (stuntById(id, list)) done.add(id);
  }

  return {
    update,
    cancel,
    markers,
    serialize,
    restore,
    dispose: cancel,
    list,
    config: C,
    cam,
    isDone: (id) => done.has(id),
    get timeScale() {
      return timeScale;
    },
    get phase() {
      return phase;
    },
    get active() {
      return phase !== 'idle';
    },
    get current() {
      return J.def;
    },
    get doneCount() {
      return done.size;
    },
    get allDone() {
      return list.every((d) => done.has(d.id));
    },
  };
}

// ---------- 坡道幾何（純資料，node 可測）----------
// 每處坡道 = 楔形：坡腳（s = 0，地面）→ 坡頂（s = RAMP_LEN，地面 + RAMP_HEIGHT），底面埋入地面 RAMP_SINK；
//   y0 = 坡腳地面高度、底面 = 坡道範圍內最低地面 − RAMP_SINK
// rampHull(def, groundAt) → Float32Array(8 × 3)：[坡腳左底, 坡腳右底, 坡頂左底, 坡頂右底, 坡腳左面, 坡腳右面, 坡頂左頂, 坡頂右頂]
export function rampHull(def, groundAt = null) {
  const g = (x, z) => (typeof groundAt === 'function' ? groundAt(x, z) || 0 : 0);
  const f = def.frame || rampFrame(def);
  const hw = RAMP_WIDTH / 2;
  const y0 = g(def.x, def.z);
  let yb = y0;
  for (const s of [0, RAMP_LEN / 2, RAMP_LEN]) for (const l of [-hw, 0, hw]) yb = Math.min(yb, g(def.x + f.fx * s + f.lx * l, def.z + f.fz * s + f.lz * l));
  yb -= RAMP_SINK;
  const out = new Float32Array(24);
  let k = 0;
  const put = (s, l, y) => {
    out[k++] = def.x + f.fx * s + f.lx * l;
    out[k++] = y;
    out[k++] = def.z + f.fz * s + f.lz * l;
  };
  put(0, hw, yb);
  put(0, -hw, yb);
  put(RAMP_LEN, hw, yb);
  put(RAMP_LEN, -hw, yb);
  put(0, hw, y0 + 0.02);
  put(0, -hw, y0 + 0.02);
  put(RAMP_LEN, hw, y0 + RAMP_HEIGHT);
  put(RAMP_LEN, -hw, y0 + RAMP_HEIGHT);
  return out;
}

const YELLOW = [1.0, 0.78, 0.05];
const BLACK = [0.06, 0.06, 0.06];
const SIDE_GREY = [0.32, 0.32, 0.34];
// buildRampGeometry(list, groundAt) → { positions, normals, colors, indices }：全部坡道合成一份（單一 draw call）
//   坡面切 STRIPES 段黃黑交替（各段獨立頂點，色塊邊緣銳利）；兩側面 / 背面灰色；底面不畫（埋在地下）
export function buildRampGeometry(list = STUNTS, groundAt = null) {
  const pos = [];
  const nrm = [];
  const col = [];
  const idx = [];
  const quad = (a, b, c, d, color) => {
    // a b c d 逆時針（從外側看）；法線 = (b − a) × (d − a)
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const n = Math.hypot(nx, ny, nz) || 1;
    nx /= n;
    ny /= n;
    nz /= n;
    const base = pos.length / 3;
    for (const p of [a, b, c, d]) {
      pos.push(p[0], p[1], p[2]);
      nrm.push(nx, ny, nz);
      col.push(color[0], color[1], color[2]);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  for (const def of list) {
    const h = rampHull(def, groundAt);
    const P = (i) => [h[i * 3], h[i * 3 + 1], h[i * 3 + 2]];
    const [b0l, b0r, b1l, b1r, t0l, t0r, t1l, t1r] = [0, 1, 2, 3, 4, 5, 6, 7].map(P);
    const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    // 坡面條紋：右 → 左、坡腳 → 坡頂（從上方看逆時針，法線朝上）
    for (let i = 0; i < STRIPES; i++) {
      const t0 = i / STRIPES;
      const t1 = (i + 1) / STRIPES;
      quad(lerp(t0r, t1r, t0), lerp(t0r, t1r, t1), lerp(t0l, t1l, t1), lerp(t0l, t1l, t0), i % 2 === 0 ? YELLOW : BLACK);
    }
    quad(b1l, b0l, t0l, t1l, SIDE_GREY); // 左側面（法線朝左）
    quad(b0r, b1r, t1r, t0r, SIDE_GREY); // 右側面
    quad(b1r, b1l, t1l, t1r, BLACK); // 背面（坡頂後的垂直面，法線朝起飛方向）：黑色
    quad(b0l, b0r, t0r, t0l, YELLOW); // 坡腳前緣（埋地幾公分高，法線朝助跑方向）
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(nrm), colors: new Float32Array(col), indices: new Uint32Array(idx) };
}

// 3D 網格：全部坡道一個 Mesh（1 draw call）、MeshStandardMaterial vertexColors（無貼圖）、不投影不受影（不增加陰影 pass draw call）
export function createRampMesh({ THREE, scene = null, groundAt = null, list = STUNTS } = {}) {
  const g = buildRampGeometry(list, groundAt);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(g.colors, 3));
  geo.setIndex(new THREE.BufferAttribute(g.indices, 1));
  geo.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'stunt-ramps';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false; // 5 處散在全城，單一包圍球幾乎涵蓋全圖，剔除無意義
  if (scene) scene.add(mesh);
  function dispose() {
    if (mesh.parent) mesh.parent.remove(mesh);
    geo.dispose();
    mat.dispose();
  }
  return { mesh, dispose };
}

// 物理碰撞：每處一個靜態凸包（同 colliders.addStaticBox：直接掛在世界的固定 collider，WORLD 組）
//   RAPIER.ColliderDesc.convexHull(rampHull) → setCollisionGroups / setSolverGroups(groups) → world.createCollider；凸包失敗（null）略過
export function addRampColliders(RAPIER, world, { list = STUNTS, groundAt = null, groups } = {}) {
  const out = [];
  for (const def of list) {
    const desc = RAPIER.ColliderDesc.convexHull(rampHull(def, groundAt));
    if (!desc) continue;
    if (groups !== undefined) desc.setCollisionGroups(groups).setSolverGroups(groups);
    out.push(world.createCollider(desc));
  }
  return out;
}

// ---------- HUD 結算面板（.stunt-panel 樣式在 src/style.css）----------
// createStuntHud({ root, doc }) → { set(out | null), el, dispose() }；只在 out.panel 物件改變時寫 DOM（面板物件結算時才換新）
export function createStuntHud({ root = null, doc = globalThis.document } = {}) {
  if (!doc || !root) return { set() {}, el: null, dispose() {} };
  const el = doc.createElement('div');
  el.className = 'stunt-panel';
  el.setAttribute('role', 'status');
  el.hidden = true;
  const title = doc.createElement('div');
  title.className = 'stunt-title';
  const body = doc.createElement('div');
  body.className = 'stunt-lines';
  el.appendChild(title);
  el.appendChild(body);
  root.appendChild(el);
  let shown = null;
  function set(o) {
    const p = o && o.panel ? o.panel : null;
    if (p === shown) return;
    shown = p;
    el.hidden = !p;
    if (!p) return;
    title.textContent = p.title;
    body.textContent = p.lines.join('\n');
  }
  function dispose() {
    el.remove();
  }
  return { set, el, dispose };
}
