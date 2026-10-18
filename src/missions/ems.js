// 救護車副任務（Phase 13，§35 EMS / Paramedic）：駕駛救護車按互動鍵開始 → 附近出現 1–3 名倒地傷患 → 逐一停車 3 s 抬上車 → 限時送醫院（HOSPITAL）
//   → 賞金 NT$(300 × 關數) + 回滿玩家生命值 → 下一關（傷患數隨關數增加）。
// 純邏輯模組，不碰 three / rapier；任務條用 taxi.js createSideJobBar({ prefix: 'ems' })，傷患世界用 taxi.js createCurbPedWorld（spawnPatient）。
// createEms({ bus, rng, config }) → { update(dt, ctx) → snapshot, start(ctx?), cancel(), end(reason), canStart(ctx), markers(out), beacons(),
//   active, phase, level, patients, picked, timeLeft, earned, dispose }
//   bus：emit ems:start / ems:pickup / ems:level / ems:end、toast（ctx.toast 省略時）；訂閱 player:busted / player:wasted（保底結束）
// 呼叫端（main.js）每幀建 ctx = { player: { x, z }, inAmbulance, speed, wrecked, world, earn(n), heal(), toast?(text, sec) }：
//   inAmbulance = 正駕駛救護車（v.ambulance）；wrecked = 救護車耐久歸零；heal() = 玩家生命值回滿（GTA 經典獎勵）
//   world：spawnPatient(center, rMin, rMax) → h | null；state(h) → { x, z, exists }；board(h)（抬上車：人消失於車內）；remove(h)
// 關卡：level 起 1；傷患數 patientsFor(level) = min(MAX_PATIENTS, level)（1 → 2 → 3）；phase 'spawn'（每 SPAWN_RETRY_SEC 補生成，
//   湊齊或 SPAWN_WAIT_SEC 後已有 ≥ 1 名即開始）→ 'collect'（限時開始；限時 = levelLimit(n, 估計路程)）→ 全部上車 → 'deliver'（目的地 HOSPITAL）
// 撿取：駕駛救護車、離某名未上車傷患 ≤ PICK_RADIUS、|車速| < PICK_MAX_SPEED 連續 PICK_SEC 秒 → board（中途離開 / 車速過快 → 計時歸零）
// 送醫：駕駛救護車、離 HOSPITAL ≤ HOSPITAL_RADIUS、|車速| < PICK_MAX_SPEED → ctx.earn(LEVEL_REWARD × 關數)、ctx.heal()、emit ems:level → 下一關
//   通過 MAX_LEVEL 關 → end('complete')（全破）
// 結束：timeout（超時）/ lost（傷患死亡 / 消失）/ left（下車 > LEFT_SEC）/ wrecked / busted / wasted / quit（再按互動鍵收工）/ complete / cancel（不 toast）
//   → emit ems:end；未上車傷患 world.remove（照常起身）、標記清空
// 時間吃呼叫端 dt（clamp ≤ MAX_DT），幀率無關；snapshot / 標記重用物件，任務條文字只在顯示內容變化時重建
import { HOSPITAL } from '../wanted/places.js';

export const PICK_RADIUS = 6; // m，停在傷患旁的距離
export const PICK_MAX_SPEED = 2; // m/s
export const PICK_SEC = 3; // s，每名傷患停車抬上車所需時間
export const HOSPITAL_RADIUS = 12; // m，送達醫院判定半徑
export const MAX_PATIENTS = 3;
export const MAX_LEVEL = 12; // 通過此關數 = 全破
export const LEVEL_REWARD = 300; // NT$ × 關數
export const LEVEL_BASE_SEC = 30; // s，每關限時 = 基本 + 每名傷患 PER_PATIENT_SEC + 估計路程 ÷ EMS_SPEED
export const PER_PATIENT_SEC = 10; // s（含停車 3 s）
export const EMS_SPEED = 10; // m/s
export const ROUTE_FACTOR = 1.4; // 直線路程 → 估計路網路程
export const PATIENT_MIN_DIST = 30; // m，傷患離玩家距離帶（取自玩家附近已生成的路人）
export const PATIENT_MAX_DIST = 110;
export const SPAWN_RETRY_SEC = 0.5; // s（錯開更新）
export const SPAWN_WAIT_SEC = 4; // s，湊不齊時最多等這麼久（已有 ≥ 1 名就開始）
export const LEFT_SEC = 10;
export const MAX_DT = 0.1;
export const URGENT_SEC = 15;
export const MARKER_PATIENT = 'ems-patient';
export const MARKER_HOSPITAL = 'ems-hospital';
export const END_REASONS = Object.freeze(['timeout', 'lost', 'left', 'wrecked', 'busted', 'wasted', 'quit', 'complete', 'cancel']);
export const PROMPT_START = '按 E 開始救護車任務';
export const PROMPT_QUIT = '按 E 結束救護車任務';
export const TOAST_BUSY = '正在進行其他任務，不能出勤';
export const TOAST_STALLED = '救護車熄火了，不能出勤';
export const TOAST_OVERTURNED = '救護車翻覆了，不能出勤';
export const END_TEXT = Object.freeze({
  timeout: '超時了',
  lost: '傷患不治',
  left: '離開救護車太久',
  wrecked: '救護車毀損',
  busted: '被捕',
  wasted: '送醫',
  quit: '收工',
  complete: '全部關卡完成！',
});
// 救護車停放點：醫院門口（places.js HOSPITAL，人行道點、面向道路）往道路方向 AMB_FORWARD m、沿路緣側移 AMB_SIDE m（不擋 WASTED 重生點），車頭沿道路
export const AMB_FORWARD = 4.5;
export const AMB_SIDE = 9;
export const AMBULANCE_TYPE = 'suv'; // 既有車型換色（不新增 glb）
export const AMBULANCE_COLOR = '#f4f4f2'; // 白底；紅條 / 頂燈由整合層加 emissive 方塊（不加光源 / 貼圖）
export const AMB_CHECK_SEC = 5; // s，救護車存在檢查間隔
export const AMB_RESPAWN_DIST = 60; // m，玩家離停放點超過此距離（看不到生成瞬間）才補車
export const AMB_HOME_DIST = 30; // m，救護車離停放點超過此距離且無人使用 → 視為被開走棄置，收回並在停放點補車

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const patientsFor = (level, max = MAX_PATIENTS) => clamp(Math.floor(level) || 1, 1, max);
export const levelReward = (level, per = LEVEL_REWARD) => per * Math.max(1, Math.floor(level) || 1);
export const levelLimit = (n, pathM, base = LEVEL_BASE_SEC, per = PER_PATIENT_SEC, speed = EMS_SPEED) => base + n * per + Math.max(0, Number(pathM) || 0) / speed;

// 估計路程：from → 最近未訪傷患 → … → 醫院（直線貪婪鏈 × ROUTE_FACTOR）；pts 不會被修改
export function chainLength(from, pts, dest = HOSPITAL, factor = ROUTE_FACTOR) {
  let x = from.x;
  let z = from.z;
  let s = 0;
  let mask = 0;
  for (let k = 0; k < pts.length; k++) {
    let bi = -1;
    let bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      if (mask & (1 << i)) continue;
      const d = Math.hypot(pts[i].x - x, pts[i].z - z);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    mask |= 1 << bi;
    s += bd;
    x = pts[bi].x;
    z = pts[bi].z;
  }
  s += Math.hypot(dest.x - x, dest.z - z);
  return s * factor;
}

// 救護車停放點（世界座標；yaw 同車輛：前方 (sin yaw, cos yaw)）
export function ambulanceSpot(h = HOSPITAL, forward = AMB_FORWARD, side = AMB_SIDE) {
  const fx = Math.sin(h.yaw);
  const fz = Math.cos(h.yaw);
  const rx = -fz;
  const rz = fx;
  return { x: h.x + fx * forward + rx * side, z: h.z + fz * forward + rz * side, yaw: h.yaw + Math.PI / 2 };
}

export const toastLevel = (level, reward) => `第 ${level} 關完成！賞金 NT$${reward}｜生命值回滿`;
export const toastEnd = (reason, level, earned) => `${reason === 'quit' ? '救護車收工' : `救護車任務結束：${END_TEXT[reason] || reason}`}｜完成 ${level} 關｜NT$${earned}`;

export function createEms({ bus = null, rng = Math.random, config = {} } = {}) {
  const cfg = {
    pickRadius: config.pickRadius ?? PICK_RADIUS,
    pickMaxSpeed: config.pickMaxSpeed ?? PICK_MAX_SPEED,
    pickSec: config.pickSec ?? PICK_SEC,
    hospital: config.hospital || HOSPITAL,
    hospitalRadius: config.hospitalRadius ?? HOSPITAL_RADIUS,
    maxPatients: config.maxPatients ?? MAX_PATIENTS,
    maxLevel: config.maxLevel ?? MAX_LEVEL,
    reward: config.levelReward ?? LEVEL_REWARD,
    baseSec: config.levelBaseSec ?? LEVEL_BASE_SEC,
    perPatient: config.perPatientSec ?? PER_PATIENT_SEC,
    speed: config.emsSpeed ?? EMS_SPEED,
    routeFactor: config.routeFactor ?? ROUTE_FACTOR,
    minDist: config.patientMinDist ?? PATIENT_MIN_DIST,
    maxDist: config.patientMaxDist ?? PATIENT_MAX_DIST,
    retrySec: config.spawnRetrySec ?? SPAWN_RETRY_SEC,
    waitSec: config.spawnWaitSec ?? SPAWN_WAIT_SEC,
    leftSec: config.leftSec ?? LEFT_SEC,
    maxDt: config.maxDt ?? MAX_DT,
    urgentSec: config.urgentSec ?? URGENT_SEC,
  };
  void rng; // 傷患位置取自 world（rng 由 world 使用）；保留參數與其他任務一致
  const emit = (name, payload) => {
    if (bus && typeof bus.emit === 'function') bus.emit(name, payload);
  };

  // phase：'idle' | 'spawn' | 'collect' | 'deliver'
  let phase = 'idle';
  let level = 0;
  let cleared = 0;
  let earned = 0;
  let need = 0;
  let spawnT = 0;
  let retryT = 0;
  let timeLeft = 0;
  let limit = 0;
  let leftT = 0;
  let world = null;
  let lastCtx = null;
  // 傷患槽（固定 MAX_PATIENTS 個，重用）：{ h, x, z, picked, hold }
  const slots = [];
  for (let i = 0; i < Math.max(1, cfg.maxPatients); i++) slots.push({ h: null, x: 0, z: 0, picked: false, hold: 0, mk: { x: 0, z: 0, kind: MARKER_PATIENT, label: '傷患' } });
  let count = 0; // 本關已生成的傷患數（slots[0..count)）
  const center = { x: 0, z: 0 };
  const hospMk = { x: cfg.hospital.x, z: cfg.hospital.z, kind: MARKER_HOSPITAL, label: cfg.hospital.name || '醫院' };
  const beaconOut = { dest: null };
  const snap = { active: false, phase: 'idle', level: 0, patients: 0, picked: 0, timeLeft: 0, limit: 0, hold: 0, earned: 0, text: null, urgent: false };
  const shown = { phase: '', level: -1, picked: -1, count: -1, sec: -2, hold: -1 };

  function toast(ctx, text, seconds) {
    if (ctx && typeof ctx.toast === 'function') ctx.toast(text, seconds);
    else emit('toast', { text, seconds });
  }

  const pickedCount = () => {
    let n = 0;
    for (let i = 0; i < count; i++) if (slots[i].picked) n++;
    return n;
  };

  function clearPatients() {
    for (let i = 0; i < count; i++) {
      const s = slots[i];
      if (s.h && !s.picked && world && typeof world.remove === 'function') world.remove(s.h);
      s.h = null;
      s.picked = false;
      s.hold = 0;
    }
    count = 0;
  }

  function canStart(ctx = {}) {
    if (phase !== 'idle') return { ok: false, reason: 'active' };
    if (!ctx.inAmbulance) return { ok: false, reason: 'notAmbulance' };
    if (ctx.busy) return { ok: false, reason: 'busy' };
    if (ctx.stalled) return { ok: false, reason: 'stalled' };
    if (ctx.overturned) return { ok: false, reason: 'overturned' };
    return { ok: true, reason: null };
  }

  function beginLevel(n) {
    level = n;
    need = patientsFor(level, cfg.maxPatients);
    count = 0;
    spawnT = 0;
    retryT = 0;
    timeLeft = 0;
    limit = 0;
    phase = 'spawn';
  }

  function start(ctx = null) {
    if (phase !== 'idle') return false;
    if (ctx) {
      const c = canStart(ctx);
      if (!c.ok) {
        if (c.reason === 'busy') toast(ctx, TOAST_BUSY, 3);
        else if (c.reason === 'stalled') toast(ctx, TOAST_STALLED, 3);
        else if (c.reason === 'overturned') toast(ctx, TOAST_OVERTURNED, 3);
        return false;
      }
    }
    cleared = 0;
    earned = 0;
    leftT = 0;
    beginLevel(1);
    emit('ems:start', { level });
    if (ctx) toast(ctx, '救護車出勤：停到倒地傷患旁 3 秒抬上車，再送醫院', 4);
    return true;
  }

  function end(reason = 'cancel', ctx = lastCtx) {
    if (phase === 'idle') return false;
    clearPatients();
    const out = { reason, level, cleared, earned };
    phase = 'idle';
    leftT = 0;
    emit('ems:end', out);
    if (reason !== 'cancel') toast(ctx, toastEnd(reason, cleared, earned), 5);
    return true;
  }

  function startClock(px, pz) {
    const pts = slots.slice(0, count); // 每關一次（非每幀）
    center.x = px;
    center.z = pz;
    limit = levelLimit(count, chainLength(center, pts, cfg.hospital, cfg.routeFactor), cfg.baseSec, cfg.perPatient, cfg.speed);
    timeLeft = limit;
    phase = 'collect';
  }

  function completeLevel(ctx) {
    const reward = levelReward(level, cfg.reward);
    earned += reward;
    cleared = level;
    if (ctx && typeof ctx.earn === 'function') ctx.earn(reward);
    if (ctx && typeof ctx.heal === 'function') ctx.heal();
    emit('ems:level', { level, reward, patients: count, timeLeft, earned });
    for (let i = 0; i < count; i++) slots[i].h = null; // 已上車者交 world.board 處理過
    count = 0;
    if (level >= cfg.maxLevel) {
      end('complete', ctx);
      return;
    }
    toast(ctx, toastLevel(level, reward), 4);
    beginLevel(level + 1);
  }

  function refreshSnap() {
    const on = phase !== 'idle';
    const picked = on ? pickedCount() : 0;
    let hold = 0;
    for (let i = 0; i < count; i++) if (!slots[i].picked && slots[i].hold > hold) hold = slots[i].hold;
    snap.active = on;
    snap.phase = phase;
    snap.level = on ? level : 0;
    snap.patients = on ? count : 0;
    snap.picked = picked;
    snap.timeLeft = timeLeft;
    snap.limit = limit;
    snap.hold = hold;
    snap.earned = earned;
    snap.urgent = (phase === 'collect' || phase === 'deliver') && timeLeft <= cfg.urgentSec;
    const sec = phase === 'collect' || phase === 'deliver' ? Math.max(0, Math.ceil(timeLeft - 1e-9)) : -1;
    const holdS = hold > 0 ? Math.min(cfg.pickSec, Math.floor(hold * 10) / 10) : -1;
    if (shown.phase !== phase || shown.level !== level || shown.picked !== picked || shown.count !== count || shown.sec !== sec || shown.hold !== holdS) {
      shown.phase = phase;
      shown.level = level;
      shown.picked = picked;
      shown.count = count;
      shown.sec = sec;
      shown.hold = holdS;
      if (!on) snap.text = null;
      else if (phase === 'spawn') snap.text = `救護車｜第 ${level} 關｜傷患通報中…`;
      else if (phase === 'collect') snap.text = `救護車｜第 ${level} 關｜傷患 ${picked}/${count}${holdS >= 0 ? `｜抬上車 ${holdS.toFixed(1)}/${cfg.pickSec} s` : ''}｜剩 ${fmt(sec)}`;
      else snap.text = `救護車｜第 ${level} 關｜送往醫院！｜剩 ${fmt(sec)}`;
    }
    return snap;
  }
  const fmt = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;

  function update(dt, ctx = {}) {
    dt = Number.isFinite(dt) ? clamp(dt, 0, cfg.maxDt) : 0;
    lastCtx = ctx;
    if (ctx.world) world = ctx.world;
    if (phase === 'idle') return refreshSnap();
    const p = ctx.player || {};
    const px = Number(p.x);
    const pz = Number(p.z);
    if (!Number.isFinite(px) || !Number.isFinite(pz)) return refreshSnap();
    if (ctx.wrecked) {
      end('wrecked', ctx);
      return refreshSnap();
    }
    if (ctx.inAmbulance) leftT = 0;
    else {
      leftT += dt;
      if (leftT > cfg.leftSec) {
        end('left', ctx);
        return refreshSnap();
      }
    }
    const speed = Math.abs(Number(ctx.speed) || 0);

    if (phase === 'spawn') {
      spawnT += dt;
      retryT -= dt;
      if (retryT <= 0 && count < need) {
        retryT = cfg.retrySec;
        center.x = px;
        center.z = pz;
        // 每次最多補 1 名（錯開）；world 回 null = 附近沒有可徵用的路人，下次再試
        const h = world && typeof world.spawnPatient === 'function' ? world.spawnPatient(center, cfg.minDist, cfg.maxDist) : null;
        if (h) {
          const s = slots[count++];
          const st = typeof world.state === 'function' ? world.state(h) : null;
          s.h = h;
          s.x = st && st.exists ? st.x : px;
          s.z = st && st.exists ? st.z : pz;
          s.picked = false;
          s.hold = 0;
        }
      }
      if (count >= need || (count > 0 && spawnT >= cfg.waitSec)) {
        startClock(px, pz);
        emit('ems:patients', { level, patients: count, limit });
      }
      return refreshSnap();
    }

    timeLeft -= dt;
    if (phase === 'collect') {
      // 傷患狀態（被撞死 / 消失 → 不治）
      for (let i = 0; i < count; i++) {
        const s = slots[i];
        if (s.picked) continue;
        const st = world && typeof world.state === 'function' ? world.state(s.h) : null;
        if (!st || !st.exists) {
          end('lost', ctx);
          return refreshSnap();
        }
        s.x = st.x;
        s.z = st.z;
      }
      // 撿取：最近一名未上車傷患；其他傷患計時歸零
      let bi = -1;
      let bd = cfg.pickRadius * cfg.pickRadius;
      for (let i = 0; i < count; i++) {
        const s = slots[i];
        if (s.picked) continue;
        const d2 = (s.x - px) ** 2 + (s.z - pz) ** 2;
        if (d2 <= bd) {
          bd = d2;
          bi = i;
        }
      }
      const ok = ctx.inAmbulance && speed < cfg.pickMaxSpeed && bi >= 0;
      for (let i = 0; i < count; i++) {
        const s = slots[i];
        if (s.picked) continue;
        if (ok && i === bi) s.hold += dt;
        else s.hold = 0;
      }
      if (ok) {
        const s = slots[bi];
        if (s.hold >= cfg.pickSec - 1e-9) {
          s.picked = true;
          s.hold = 0;
          if (world && typeof world.board === 'function') world.board(s.h);
          const n = pickedCount();
          emit('ems:pickup', { level, picked: n, patients: count });
          if (n >= count) {
            phase = 'deliver';
            toast(ctx, '傷患都上車了，快送醫院！', 3);
          }
        }
      }
    }
    if (timeLeft <= 0) {
      timeLeft = 0;
      end('timeout', ctx);
      return refreshSnap();
    }
    if (phase === 'deliver') {
      const h = cfg.hospital;
      if (ctx.inAmbulance && speed < cfg.pickMaxSpeed && (h.x - px) ** 2 + (h.z - pz) ** 2 <= cfg.hospitalRadius * cfg.hospitalRadius) completeLevel(ctx);
    }
    return refreshSnap();
  }

  // 標記（重用物件）：收集中 → 未上車傷患 'ems-patient'；送醫中 → 醫院 'ems-hospital'
  function markers(out = []) {
    if (phase === 'collect' || phase === 'spawn') {
      for (let i = 0; i < count; i++) {
        const s = slots[i];
        if (s.picked) continue;
        s.mk.x = s.x;
        s.mk.z = s.z;
        out.push(s.mk);
      }
    } else if (phase === 'deliver') out.push(hospMk);
    return out;
  }

  function beacons() {
    beaconOut.dest = phase === 'deliver' ? cfg.hospital : null;
    return beaconOut;
  }

  const cancel = () => end('cancel');
  const offs = [];
  if (bus && typeof bus.on === 'function') {
    offs.push(bus.on('player:busted', () => end('busted')));
    offs.push(bus.on('player:wasted', () => end('wasted')));
  }
  function dispose() {
    cancel();
    for (const off of offs.splice(0)) if (typeof off === 'function') off();
  }

  return {
    update,
    start,
    cancel,
    end,
    canStart,
    markers,
    beacons,
    dispose,
    snapshot: refreshSnap,
    slots,
    get active() {
      return phase !== 'idle';
    },
    get phase() {
      return phase;
    },
    get level() {
      return level;
    },
    get patients() {
      return count;
    },
    get picked() {
      return pickedCount();
    },
    get timeLeft() {
      return timeLeft;
    },
    get limit() {
      return limit;
    },
    get earned() {
      return earned;
    },
    get cleared() {
      return cleared;
    },
  };
}

// ---------- 救護車停放管理（整合層用；只依賴注入的 vehicles / dmg，不 import three）----------
// createAmbulanceDepot({ vehicles, dmg?, spot, decorate?(v), isBusy?(v) }) → { update(dt, player), ensure(force), isAmbulance(v), vehicle, dispose() }
//   遊戲中尚無救護車（不在 vehicles.vehicles）→ 在 spot 以 AMBULANCE_TYPE + AMBULANCE_COLOR adopt 一台（v.ambulance = true）+ dmg.attach + decorate(v)
//   （紅條 / 頂燈由整合層的 decorate 加上；噴漆換色重建網格後 decorate 會再被呼叫：每 AMB_CHECK_SEC 檢查 v.mesh 是否換過）
//   救護車毀損（healthOf 0）且無人駕駛、或被回收 → 玩家離 spot > AMB_RESPAWN_DIST 時補一台；ensure(true) = 開局立即生成
//   救護車完好但棄置在離 spot > AMB_HOME_DIST 處（任務結束 / 開走後下車）、無人駕駛且 !isBusy → 玩家離棄車與 spot 都 > AMB_RESPAWN_DIST 時
//   （force 不看玩家）收回（dmg.detach + vehicles.remove）並在 spot 補一台：醫院永遠有救護車
export function createAmbulanceDepot({ vehicles = null, dmg = null, spot = ambulanceSpot(), decorate = null, isBusy = () => false } = {}) {
  let car = null;
  let mesh = null;
  let t = AMB_CHECK_SEC;
  const exists = (v) => !!v && !!vehicles && vehicles.vehicles.includes(v);

  function spawn() {
    if (!vehicles || typeof vehicles.adopt !== 'function') return null;
    const v = vehicles.adopt({ type: AMBULANCE_TYPE, color: AMBULANCE_COLOR, x: spot.x, z: spot.z, yaw: spot.yaw });
    if (!v) return null;
    v.ambulance = true;
    if (dmg && typeof dmg.attach === 'function') dmg.attach(v);
    if (typeof decorate === 'function') decorate(v);
    mesh = v.mesh || null;
    car = v;
    return v;
  }

  function ensure(force = false, player = null) {
    if (exists(car)) {
      const wreck = dmg && typeof dmg.healthOf === 'function' && dmg.healthOf(car) === 0;
      if (car.mesh && car.mesh !== mesh && typeof decorate === 'function') {
        decorate(car); // 噴漆廠換色重建網格：補回紅條 / 頂燈
        mesh = car.mesh;
      }
      if (car.driven || isBusy(car)) return car;
      const away = !!car.pos && Math.hypot(car.pos.x - spot.x, car.pos.z - spot.z) > AMB_HOME_DIST;
      if (!wreck && !away) return car;
      if (wreck) {
        car.ambulance = false; // 殘骸交一般回收（main cleanupVehicles）
        car = null;
      } else {
        // 棄置在遠處：玩家看不到時收回（開局 force 直接收回）
        const unseen = !player || (Math.hypot(player.x - car.pos.x, player.z - car.pos.z) > AMB_RESPAWN_DIST && Math.hypot(player.x - spot.x, player.z - spot.z) > AMB_RESPAWN_DIST);
        if (!force && !unseen) return car;
        if (dmg && typeof dmg.detach === 'function') dmg.detach(car);
        if (typeof vehicles.remove === 'function') vehicles.remove(car);
        car = null;
      }
    }
    const far = !player || Math.hypot(player.x - spot.x, player.z - spot.z) > AMB_RESPAWN_DIST;
    if (force || far) return spawn();
    return null;
  }

  function update(dt, player) {
    t += Number.isFinite(dt) ? dt : 0;
    if (t < AMB_CHECK_SEC) return;
    t = 0;
    ensure(false, player);
  }

  const isAmbulance = (v) => !!v && !!v.ambulance;

  function dispose() {
    car = null;
    mesh = null;
  }

  return {
    update,
    ensure,
    isAmbulance,
    dispose,
    spot,
    get vehicle() {
      return exists(car) ? car : null;
    },
  };
}
