// 武器狀態機（契約 §13）：三槽（0 空手 / 1 球棒 / 2 手槍）、切換、揮棒命中窗掃掠、手槍射擊 / 彈藥 / 裝填、後座
// 純邏輯（不 import three）：所有外部依賴由 createWeapons 參數注入，node 無頭測試用假物件
//
// createWeapons({ bus, combat, player, raycast, sweep, settings, now, isTouch, manifest?, playAnim?, getBatSegment?, rng? })
//   player：{ actor（combat Actor）, punch?() → boolean, controlLocked? }；空手攻擊呼叫 player.punch()（沿用拳擊輔助瞄準 / 小衝步），
//     沒有 punch 時改呼叫 combat.requestPunch(actor)
//   raycast(origin, dir, maxDist, { excludeActor }) → { point, normal, actor|null, surface: 'world'|'vehicle' } | null
//   sweep(from, to, radius, { excludeActor }) → actor[]（膠囊掃掠碰到的角色）
//   settings：{ get(key) }，讀 recoil（0.2–1.0，缺 = 1）與 aimAssist（缺 = true）
//   now() → 秒（遊戲時鐘，建議與 CombatSystem 同一個）；省略時以 update 的 dt 累加
//   isTouch：boolean 或 () => boolean（瞄準輔助只作用於觸控）
//   manifest：角色 manifest（讀 clips[].duration 與 events.<clip>.hitWindow；可省略）
//   playAnim(name) → duration(秒) | false | undefined：動畫層（W3 createWeaponLayer.play）；省略時試 player.anim.trigger(name)（不認得的 clip 安靜略過）
//     揮棒時注入的 playAnim 明確回 false = 動畫拒絕（例如跳躍中）→ 這一揮取消、不吃冷卻
//   getBatSegment(gripOut, tipOut) → boolean：以球棒模型實際的世界座標填握把 / 棒頭（W3 掛上模型後可注入）；
//     省略或回 false 時用程序揮擊弧（面向右 75° → 左 75°，b 反向）
//   rng() → 0..1：後座左右亂數（省略 = 固定種子 LCG，可重現）
//
// 回傳：{ current, slot, state, aiming, canSwitch(), select(slot), cycle(), attack(aim), reload(), update(dt, aim),
//   ammo() → { mag, magSize, reserve }（重用同一物件）, addAmmo(n) → 實際加入數, recoilKick() → { pitch, yaw }（本幀累積、讀後歸零）,
//   reloadProgress() → 0..1 | null, serialize(), restore(data), dispose() }
//   aim = { origin:{x,y,z}, dir:{x,y,z}, aiming: boolean, muzzle?:{x,y,z}, candidates?: actor[] }（整合層每幀以鏡頭中心射線填入）
//
// 規則：
//   切換：只有 state 'idle'，或 'attacking' 且動作進行 ≥ SWITCH_AT（80%）時可切；否則忽略（不排隊）；切換後 EQUIP_SEC 內不能攻擊
//   球棒：命中窗內每幀以握把–棒頭膠囊與「上一幀棒頭 → 本幀棒頭」各掃掠一次，碰到的角色走 combat.applyHit（同一揮 swingId 去重）
//   手槍：鏡頭射線取瞄點 → 槍口確認遮擋（aim.js resolveShot）；命中角色 → combat.applyHit（weapon 'pistol'），
//     命中其他（或角色倒地中不受理）→ weapon:impact；射程（由槍口起算 80 m）內沒打到東西 → weapon:fire.miss = true（不發 impact）；
//     每發 weapon:fire（另帶 miss / ex, ey, ez 落點或射程末端 / dist，供彈道特效）；打空彈匣後自動裝填一次；彈匣空且無備彈 → weapon:dryFire（DRY_FIRE_INTERVAL 節流）
//     裝填中不能射、不能切；裝填中被打倒 → 取消（彈藥不變，發 reload end）
// 事件（bus）：weapon:equip / swing / fire / dryFire / reload / ammo / impact（payload 見契約 §10）
// 每幀路徑（update / attack）不配置新物件；事件 payload 只在事件發生時配置
import { WEAPONS, SLOT_IDS, EQUIP_SEC, SWITCH_AT, DRY_FIRE_INTERVAL, GUNSHOT_HEAR_RADIUS } from './defs.js';
import { pickAimAssist, resolveShot, recoilKick } from './aim.js';

const DEG = Math.PI / 180;
const STREAK_GAP = 0.6; // 兩發間隔小於此（秒）算連射（後座遞增）

function vec() {
  return { x: 0, y: 0, z: 0 };
}

// 固定種子 LCG（後座左右亂數用，可重現）
function lcg(seed = 12345) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// 揮棒的 clip 長度與命中窗（秒）：manifest clips[].duration / events.<clip>.hitWindow，缺則 def.clipSec 與比例
export function batTiming(manifest, clip, def = WEAPONS.bat, animDur = null) {
  let dur = Number.isFinite(animDur) && animDur > 0 ? animDur : null;
  if (dur === null && manifest && Array.isArray(manifest.clips)) {
    const c = manifest.clips.find((x) => x && x.name === clip);
    if (c && Number.isFinite(c.duration) && c.duration > 0) dur = c.duration;
  }
  if (dur === null) dur = def.clipSec;
  const w = manifest && manifest.events && manifest.events[clip] && manifest.events[clip].hitWindow;
  if (Array.isArray(w) && w.length === 2 && w.every(Number.isFinite) && w[0] >= 0 && w[1] > w[0]) {
    return { duration: dur, open: Math.min(w[0], dur), close: Math.min(w[1], dur) };
  }
  return { duration: dur, open: dur * def.hitWindow[0], close: dur * def.hitWindow[1] };
}

// 程序揮擊弧（純函式）：揮擊進度 p（0..1）時的握把 / 棒頭世界座標；reverse = b 揮（由左往右）
export function batArc(pos, yaw, p, reverse, gripOut, tipOut, def = WEAPONS.bat) {
  const from = reverse ? def.arcTo : def.arcFrom;
  const to = reverse ? def.arcFrom : def.arcTo;
  const th = (from + (to - from) * Math.min(1, Math.max(0, p))) * DEG;
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  const rx = -fz; // 右方 = (−cos yaw, sin yaw)
  const rz = fx;
  const dx = fx * Math.cos(th) + rx * Math.sin(th);
  const dz = fz * Math.cos(th) + rz * Math.sin(th);
  gripOut.x = pos.x + fx * def.gripForward;
  gripOut.y = pos.y + def.gripHeight;
  gripOut.z = pos.z + fz * def.gripForward;
  tipOut.x = gripOut.x + dx * def.length;
  tipOut.y = gripOut.y;
  tipOut.z = gripOut.z + dz * def.length;
}

// 槍聲接線：bus 的 weapon:fire → getBrains() 內每個 brain.hear({ type: 'gunshot', x, z })（npc-ai 自行判斷 30 m 內）
// getBrains() → 可迭代的 NpcBrain（例：traffic 的 brains.values()）；回傳取消訂閱函式
export function gunshotListeners(bus, getBrains, radius = GUNSHOT_HEAR_RADIUS) {
  const evt = { type: 'gunshot', x: 0, z: 0 };
  const r2 = radius * radius;
  return bus.on('weapon:fire', (e) => {
    evt.x = e.x;
    evt.z = e.z;
    const list = getBrains();
    if (!list) return;
    for (const b of list) {
      const p = b && b.actor && b.actor.pos;
      if (!p) continue;
      const dx = p.x - e.x;
      const dz = p.z - e.z;
      if (dx * dx + dz * dz <= r2) b.hear(evt);
    }
  });
}

export function createWeapons({
  bus = null,
  combat = null,
  player,
  raycast = () => null,
  sweep = () => [],
  settings = null,
  now = null,
  isTouch = false,
  manifest = null,
  playAnim = null,
  getBatSegment = null,
  rng = null,
} = {}) {
  const actor = player.actor || player;
  const P = WEAPONS.pistol;
  const B = WEAPONS.bat;
  let clock = 0;
  const time = now || (() => clock);
  const rand = rng || lcg();
  const emit = (name, payload) => {
    if (bus) bus.emit(name, payload);
  };
  const setting = (k, dflt) => {
    const v = settings && settings.get ? settings.get(k) : undefined;
    return v === undefined || v === null ? dflt : v;
  };
  const touch = () => (typeof isTouch === 'function' ? !!isTouch() : !!isTouch);

  let slot = 0;
  let state = 'idle';
  let stateAt = -Infinity;
  let actionDur = 0; // 目前攻擊動作長度（canSwitch 的 80% 以此計）
  let disposed = false;
  let aiming = false;
  // 手槍
  let mag = P.magSize;
  let reserve = P.startReserve;
  let reloadEnd = 0;
  let lastShotAt = -Infinity;
  let streak = 0;
  let lastDryAt = -Infinity;
  let autoReload = false; // 打空彈匣後，射擊動作結束自動裝填一次
  // 球棒
  let swingIdx = 0;
  let swingReverse = false;
  let swingId = 0;
  let swingActive = false;
  let winOpen = 0;
  let winClose = 0;
  let havePrev = false;
  let localSeq = 0;

  const ammoOut = { mag: 0, magSize: P.magSize, reserve: 0 };
  const kick = { pitch: 0, yaw: 0 }; // 累積中
  const kickOut = { pitch: 0, yaw: 0 };
  const kickTmp = { pitch: 0, yaw: 0 };
  const grip = vec();
  const tip = vec();
  const prevTip = vec();
  const hitDir = { x: 0, z: 0 };
  const muzzle = vec();
  const aimDir = vec();
  const shot = { hit: false, point: vec(), normal: vec(), actor: null, surface: null, dir: vec(), dist: 0 };
  const rayOpts = { excludeActor: actor };
  const sweepOpts = { excludeActor: actor };
  const visOpts = { excludeActor: actor };
  const visDir = vec();
  const defaultAim = { origin: vec(), dir: vec(), aiming: false };
  let visOrigin = null;

  const current = () => SLOT_IDS[slot];

  function newSwingId() {
    return combat && combat.newSwingId ? combat.newSwingId() : ++localSeq;
  }

  // 玩家可行動：沒被外部鎖定，combat 狀態為 normal（受擊硬直 / 倒地 / 起身中都不行）
  function canAct() {
    if (player.controlLocked) return false;
    const st = combat && combat.stateOf ? combat.stateOf(actor) : null;
    return st === null || st === 'normal';
  }

  function isDown() {
    return !!(combat && combat.isDown && combat.isDown(actor));
  }

  function play(name) {
    if (playAnim) return playAnim(name);
    if (player.anim && player.anim.trigger) player.anim.trigger(name); // 目前 animator 不認得的 clip 回 false，安靜略過
    return undefined;
  }

  function ammoPayload() {
    return { weapon: 'pistol', mag, magSize: P.magSize, reserve };
  }

  function setState(s, t, dur = 0) {
    state = s;
    stateAt = t;
    actionDur = dur;
  }

  function finishReload(cancel) {
    if (!cancel) {
      const n = Math.min(P.magSize - mag, reserve);
      mag += n;
      reserve -= n;
    }
    setState('idle', time());
    emit('weapon:reload', { weapon: 'pistol', phase: 'end', mag, reserve });
    if (!cancel) emit('weapon:ammo', ammoPayload());
  }

  // 依時間推進狀態：equip / 攻擊動作結束回 idle、裝填完成；裝填中被打倒取消
  function tick(t) {
    if (state === 'equipping' && t - stateAt >= EQUIP_SEC) setState('idle', t);
    if (state === 'attacking' && t - stateAt >= actionDur && !swingActive) {
      setState('idle', t);
      if (autoReload) {
        autoReload = false;
        startReload(t);
      }
    }
    if (state === 'reloading') {
      if (isDown()) finishReload(true);
      else if (t >= reloadEnd) finishReload(false);
    }
  }

  function canSwitch() {
    if (disposed) return false;
    tick(time());
    if (state === 'idle') return true;
    if (state === 'attacking') return actionDur <= 0 || (time() - stateAt) / actionDur >= SWITCH_AT;
    return false;
  }

  function select(s) {
    if (disposed || !Number.isInteger(s) || s < 0 || s >= SLOT_IDS.length || s === slot) return false;
    if (!canSwitch()) return false;
    const prev = current();
    const t = time();
    slot = s;
    swingActive = false;
    autoReload = false;
    setState('equipping', t, EQUIP_SEC);
    emit('weapon:equip', { slot, weapon: current(), prev });
    play('weapon_equip');
    return true;
  }

  function cycle() {
    return select((slot + 1) % SLOT_IDS.length);
  }

  function startReload(t) {
    if (current() !== 'pistol' || mag >= P.magSize || reserve <= 0 || isDown()) return false;
    setState('reloading', t, P.reloadSec);
    reloadEnd = t + P.reloadSec;
    emit('weapon:reload', { weapon: 'pistol', phase: 'start', mag, reserve });
    play('pistol_reload');
    return true;
  }

  function reload() {
    if (disposed || current() !== 'pistol') return false;
    const t = time();
    tick(t);
    if (state !== 'idle') return false;
    return startReload(t);
  }

  // ---------- 空手 ----------
  function attackFist(t) {
    const ok = player.punch ? player.punch() : combat ? combat.requestPunch(actor) : false;
    if (!ok) return false;
    setState('attacking', t, WEAPONS.fist.cooldown);
    emit('weapon:swing', { weapon: 'fist', x: actor.pos.x, y: actor.pos.y + B.gripHeight, z: actor.pos.z, byPlayer: actor.kind === 'player' });
    return true;
  }

  // ---------- 球棒 ----------
  function attackBat(t) {
    const clip = B.clips[swingIdx];
    const r = play(clip);
    if (r === false && playAnim) return false; // 動畫層拒絕：不揮、不吃冷卻
    const tm = batTiming(manifest, clip, B, typeof r === 'number' ? r : null);
    swingId = newSwingId();
    swingActive = true;
    swingReverse = swingIdx === 1;
    winOpen = t + tm.open;
    winClose = t + tm.close;
    havePrev = false;
    swingIdx ^= 1;
    setState('attacking', t, Math.max(B.cooldown, tm.duration));
    emit('weapon:swing', { weapon: 'bat', x: actor.pos.x, y: actor.pos.y + B.gripHeight, z: actor.pos.z, byPlayer: actor.kind === 'player' });
    return true;
  }

  function batSegment(p) {
    if (getBatSegment && getBatSegment(grip, tip)) return;
    batArc(actor.pos, actor.yaw, p, swingReverse, grip, tip, B);
  }

  function hitList(list) {
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const target = list[i];
      if (!target || target === actor) continue;
      hitDir.x = target.pos.x - actor.pos.x;
      hitDir.z = target.pos.z - actor.pos.z;
      if (combat) combat.applyHit({ attacker: actor, target, damage: B.damage, weapon: 'bat', dir: hitDir, swingId });
      if (!swingActive) return;
    }
  }

  // 命中窗內每幀掃掠；窗在兩幀之間關閉時以進度 1 補掃最後一次；揮擊者被打斷（受擊 / 倒地）即取消
  function updateBat(t) {
    if (!swingActive) return;
    if (!canAct()) {
      swingActive = false;
      return;
    }
    if (t < winOpen) return;
    const span = winClose - winOpen;
    const p = span > 0 ? Math.min(1, (t - winOpen) / span) : 1;
    batSegment(p);
    hitList(sweep(grip, tip, B.radius, sweepOpts));
    if (swingActive && havePrev) hitList(sweep(prevTip, tip, B.radius, sweepOpts));
    prevTip.x = tip.x;
    prevTip.y = tip.y;
    prevTip.z = tip.z;
    havePrev = true;
    if (t >= winClose) swingActive = false;
  }

  // ---------- 手槍 ----------
  function defaultMuzzle(out) {
    const fx = Math.sin(actor.yaw);
    const fz = Math.cos(actor.yaw);
    out.x = actor.pos.x + fx * P.muzzleForward - fz * P.muzzleRight;
    out.y = actor.pos.y + P.muzzleHeight;
    out.z = actor.pos.z + fz * P.muzzleForward + fx * P.muzzleRight;
    return out;
  }

  function fillDefaultAim() {
    defaultMuzzle(defaultAim.origin);
    defaultAim.dir.x = Math.sin(actor.yaw);
    defaultAim.dir.y = 0;
    defaultAim.dir.z = Math.cos(actor.yaw);
    return defaultAim;
  }

  // 吸附候選的視線檢查：鏡頭 → 行人胸口的射線第一個碰到的就是該行人（或什麼都沒碰到）
  function visible(a, pt) {
    const o = visOrigin;
    visDir.x = pt.x - o.x;
    visDir.y = pt.y - o.y;
    visDir.z = pt.z - o.z;
    const d = Math.hypot(visDir.x, visDir.y, visDir.z);
    if (d < 1e-6) return true;
    visDir.x /= d;
    visDir.y /= d;
    visDir.z /= d;
    const h = raycast(o, visDir, d + 0.5, visOpts);
    return !h || h.actor === a || Math.hypot(h.point.x - o.x, h.point.y - o.y, h.point.z - o.z) >= d - 0.3;
  }

  const assistOpts = {
    isVisible: visible,
    skip: (a) => a === actor || a.kind === 'player' || (combat && combat.isDown && combat.isDown(a)),
  };

  function attackPistol(t, aim) {
    if (mag <= 0) {
      if (reserve > 0) {
        startReload(t); // 空彈匣按攻擊 → 自動裝填（這一下不開槍）
        return false;
      }
      if (t - lastDryAt >= DRY_FIRE_INTERVAL) {
        lastDryAt = t;
        emit('weapon:dryFire', { weapon: 'pistol' });
      }
      return false;
    }
    const a = aim && aim.origin && aim.dir ? aim : fillDefaultAim();
    const mz = a.muzzle || defaultMuzzle(muzzle);
    let dir = a.dir;
    if (touch() && setting('aimAssist', true) && a.candidates && a.candidates.length) {
      visOrigin = a.origin;
      pickAimAssist(a.origin, a.dir, a.candidates, aimDir, assistOpts);
      dir = aimDir;
    }
    resolveShot(raycast, a.origin, dir, mz, P.range, actor, shot, rayOpts);
    mag--;
    streak = t - lastShotAt < STREAK_GAP ? streak + 1 : 0;
    lastShotAt = t;
    let hitActor = false;
    if (shot.actor) {
      hitDir.x = shot.dir.x;
      hitDir.z = shot.dir.z;
      const r = combat ? combat.applyHit({ attacker: actor, target: shot.actor, damage: P.damage, weapon: 'pistol', dir: hitDir, point: shot.point, swingId: newSwingId() }) : null;
      hitActor = !!r;
    }
    // 打到非角色，或打到角色但 combat 不受理（倒地 / 死亡中 / untargetable）→ 在落點發 impact，每發必有「受擊 / impact / 明確 miss」其一
    if (shot.hit && !hitActor) {
      emit('weapon:impact', {
        x: shot.point.x, y: shot.point.y, z: shot.point.z,
        nx: shot.normal.x, ny: shot.normal.y, nz: shot.normal.z,
        surface: shot.surface === 'vehicle' ? 'vehicle' : 'world',
      });
    }
    emit('weapon:fire', {
      weapon: 'pistol', x: mz.x, y: mz.y, z: mz.z,
      dirX: shot.dir.x, dirY: shot.dir.y, dirZ: shot.dir.z,
      byPlayer: actor.kind === 'player', hit: hitActor,
      miss: !shot.hit, ex: shot.point.x, ey: shot.point.y, ez: shot.point.z, dist: shot.dist,
    });
    emit('weapon:ammo', ammoPayload());
    recoilKick(P, streak, rand(), setting('recoil', 1), kickTmp);
    kick.pitch += kickTmp.pitch;
    kick.yaw += kickTmp.yaw;
    play('pistol_fire');
    setState('attacking', t, P.fireInterval);
    if (mag === 0 && reserve > 0) autoReload = true;
    return true;
  }

  function attack(aim) {
    if (disposed) return false;
    const t = time();
    tick(t);
    if (state !== 'idle' || !canAct()) return false;
    const w = current();
    if (w === 'fist') return attackFist(t);
    if (w === 'bat') return attackBat(t);
    return attackPistol(t, aim);
  }

  function update(dt, aim) {
    if (disposed) return;
    if (!now) clock += dt;
    const t = time();
    updateBat(t);
    tick(t);
    aiming = !!(aim && aim.aiming) && current() === 'pistol';
  }

  function ammo() {
    ammoOut.mag = mag;
    ammoOut.reserve = reserve;
    return ammoOut;
  }

  function addAmmo(n) {
    const k = Math.floor(n);
    if (disposed || !(k > 0)) return 0;
    const added = Math.min(P.reserveMax - reserve, k);
    if (added <= 0) return 0;
    reserve += added;
    emit('weapon:ammo', ammoPayload());
    // 彈匣已空、手上正拿著手槍待機 → 撿到彈藥順手裝填
    if (mag === 0 && current() === 'pistol') {
      const t = time();
      tick(t);
      if (state === 'idle') startReload(t);
    }
    return added;
  }

  function recoilOut() {
    kickOut.pitch = kick.pitch;
    kickOut.yaw = kick.yaw;
    kick.pitch = 0;
    kick.yaw = 0;
    return kickOut;
  }

  function reloadProgress() {
    if (state !== 'reloading') return null;
    return Math.min(1, Math.max(0, 1 - (reloadEnd - time()) / P.reloadSec));
  }

  function serialize() {
    return { slot, ammo: { pistol: { mag, reserve } } };
  }

  // 讀檔：非法欄位退回預設（slot 0、彈匣 12、備彈 36）；直接換到該槽（不播 equip），發 weapon:equip 與 weapon:ammo
  function restore(data) {
    if (disposed) return false;
    const d = data && typeof data === 'object' ? data : {};
    const s = Number.isInteger(d.slot) && d.slot >= 0 && d.slot < SLOT_IDS.length ? d.slot : 0;
    const pa = d.ammo && d.ammo.pistol;
    const okInt = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;
    mag = pa && okInt(pa.mag, P.magSize) ? pa.mag : P.magSize;
    reserve = pa && okInt(pa.reserve, P.reserveMax) ? pa.reserve : P.startReserve;
    const prev = current();
    slot = s;
    swingActive = false;
    autoReload = false;
    setState('idle', time());
    emit('weapon:equip', { slot, weapon: current(), prev });
    emit('weapon:ammo', ammoPayload());
    return !!data;
  }

  function dispose() {
    disposed = true;
    swingActive = false;
    autoReload = false;
  }

  return {
    get current() {
      return current();
    },
    get slot() {
      return slot;
    },
    get state() {
      if (!disposed) tick(time());
      return state;
    },
    get aiming() {
      return aiming;
    },
    canSwitch,
    select,
    cycle,
    attack,
    reload,
    update,
    ammo,
    addAmmo,
    recoilKick: recoilOut,
    reloadProgress,
    serialize,
    restore,
    dispose,
  };
}
