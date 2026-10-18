// 武器狀態機（契約 §13）：五槽（0 空手 / 1 球棒 / 2 手槍 / 3 衝鋒槍 / 4 散彈槍）、切換、揮棒命中窗掃掠、槍械射擊 / 彈藥 / 裝填、後座
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
// 回傳：{ current, slot, state, aiming, pending（排隊中的槽或 -1）, canSwitch(), select(slot), cycle(dir = 1), prevSlot(), attack(aim), reload(), update(dt, aim),
//   ammo(id?) → { weapon, mag, magSize, reserve }（重用同一物件；id 省略 = 手上的槍，手上不是槍時 = 手槍）,
//   addAmmo(n, id = 'pistol') → 實際加入數, owns(id), give(id) → 是否新取得, spread() → 目前散佈半角（度，衝鋒槍）,
//   recoilKick() → { pitch, yaw }（本幀累積、讀後歸零）, reloadProgress() → 0..1 | null, serialize(), restore(data), dispose() }
//   aim = { origin:{x,y,z}, dir:{x,y,z}, aiming: boolean, muzzle?:{x,y,z}, candidates?: actor[] }（整合層每幀以鏡頭中心射線填入）
//
// 規則：
//   切換：只有 state 'idle'，或 'attacking' 且動作進行 ≥ SWITCH_AT（80%）時可切；否則記下最後一次請求（pending），
//     update 時一可切就套用（後來的請求覆蓋前面的；選回目前的槽 = 取消）；切換後 EQUIP_SEC 內不能攻擊
//   球棒：命中窗內每幀以握把–棒頭膠囊與「上一幀棒頭 → 本幀棒頭」各掃掠一次，碰到的角色走 combat.applyHit（同一揮 swingId 去重）
//   手槍：鏡頭射線取瞄點 → 槍口確認遮擋（aim.js resolveShot）；命中角色 → combat.applyHit（weapon 'pistol'），
//     命中其他（或角色倒地中不受理）→ weapon:impact（V4：raycast 給了 vehicle 時 payload 帶 vehicle / damage（def.vehicleDamage）/ byPlayer，
//     整合層據此對車造成損壞，見 explosions.js damageVehicle）；射程（由槍口起算 80 m）內沒打到東西 → weapon:fire.miss = true（不發 impact）；
//     每發 weapon:fire（另帶 miss / ex, ey, ez 落點或射程末端 / dist，供彈道特效；vehicle = 打到的車（同 weapon:impact）或 null）；打空彈匣後自動裝填一次；彈匣空且無備彈 → weapon:dryFire（DRY_FIRE_INTERVAL 節流）
//     def.infiniteAmmo（createWeapons 時讀取）：備彈無限（裝填不扣備彈、不會沒子彈、addAmmo 回 0）；ammo() / 事件的 reserve 為 Infinity，serialize 仍存數字 reserve
//     裝填中不能射、不能切；裝填中被打倒 → 取消（彈藥不變，發 reload end）
//   Phase 14 擁有權：空手 / 球棒 / 手槍為初始武器；衝鋒槍 / 散彈槍（defs PURCHASABLE）由 give(id)（武器店）取得，
//     未擁有的槽 select 回 false、cycle 跳過；彈藥各槍分開（手槍備彈無限、其餘有限）
//   衝鋒槍（def.auto）：按住連發（fireInterval 0.1 s；射速與幀率無關，見 afterShot），每發方向依目前散佈半角在錐內隨機偏轉（spreadDir），
//     散佈每發 + spreadPerShot（上限 spreadMax）、停火 spreadRecoverDelay 後以 spreadRecover 度 / 秒收斂；瞄準中 × aimSpreadScale
//   散彈槍（def.pellets）：一發 8 顆彈丸，在 coneDeg 錐內以黃金角分布 + 亂數抖動；每顆各跑一次 resolveShot（重用同一 shot / 方向物件）；
//     同一目標的彈丸傷害（pelletDamage × pelletFalloff(距離)）合併成一次 combat.applyHit（weapon 'shotgun'），
//     距離 ≤ knockdownRange 且命中 ≥ knockdownPellets 顆 → forceKnockdown；合併傷害 < comboDamage（遠距擦傷）→ combo: false 不累積擊倒連擊；
//     打到非角色的每顆各發 weapon:impact（damage = vehicleDamage × pelletFalloff(距離)，每顆；
//     第 2 顆起帶 quiet: true 供音效節流）；weapon:fire 每扣一次扳機只發一次（另帶 pellets / pelletHits）
// 事件（bus）：weapon:equip / swing / fire / dryFire / reload / ammo / impact（payload 見契約 §10）/ acquire（Phase 14：{ weapon, slot }）
// 每幀路徑（update / attack）不配置新物件；事件 payload 只在事件發生時配置
import { WEAPONS, SLOT_IDS, GUN_IDS, PURCHASABLE, isGun, pelletFalloff, EQUIP_SEC, SWITCH_AT, DRY_FIRE_INTERVAL, GUNSHOT_HEAR_RADIUS } from './defs.js';
import { pickAimAssist, resolveShot, recoilKick, spreadDir } from './aim.js';

const DEG = Math.PI / 180;
const STREAK_GAP = 0.6; // 兩發間隔小於此（秒）算連射（後座遞增）
const GOLDEN = Math.PI * (3 - Math.sqrt(5)); // 黃金角（彈丸方位分布）

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
  let pending = -1; // 被狀態擋下的切換請求（最後一次），-1 = 無
  let disposed = false;
  let aiming = false;
  // 槍械：各槍彈藥（手槍備彈無限；衝鋒槍 / 散彈槍要先擁有）
  const guns = {};
  for (const id of GUN_IDS) guns[id] = { mag: WEAPONS[id].magSize, reserve: WEAPONS[id].startReserve };
  const owned = { fist: true, bat: true, pistol: true, smg: false, shotgun: false };
  let reloadGun = 'pistol'; // 裝填中的槍
  let reloadEnd = 0;
  let spreadDeg = 0; // 衝鋒槍目前散佈半角（度，停火後收斂）
  let spreadAt = -Infinity;
  let lastShotAt = -Infinity;
  let nextFireAt = -Infinity; // 槍械下一發的排程時刻（射速與幀率無關：遲到的零頭結轉到下一發）
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

  const ammoOut = { weapon: 'pistol', mag: 0, magSize: P.magSize, reserve: 0 };
  const kick = { pitch: 0, yaw: 0 }; // 累積中
  const kickOut = { pitch: 0, yaw: 0 };
  const kickTmp = { pitch: 0, yaw: 0 };
  const grip = vec();
  const tip = vec();
  const prevTip = vec();
  const hitDir = { x: 0, z: 0 };
  const muzzle = vec();
  const aimDir = vec();
  const shot = { hit: false, point: vec(), normal: vec(), actor: null, surface: null, vehicle: null, dir: vec(), dist: 0 };
  const rayOpts = { excludeActor: actor };
  const sweepOpts = { excludeActor: actor };
  const visOpts = { excludeActor: actor };
  const visDir = vec();
  const spreadOut = vec();
  // 散彈槍：彈丸方向與命中彙整（預先配置，扣扳機時不配置新物件）
  const SG = WEAPONS.shotgun;
  const pelletDir = vec();
  const firstPt = vec();
  const firstDir = vec();
  const pelHits = []; // { actor, damage, count, dist, point }
  for (let i = 0; i < SG.pellets; i++) pelHits.push({ actor: null, damage: 0, count: 0, dist: 0, point: vec() });
  const hitArgs = { attacker: actor, target: null, damage: 0, weapon: 'shotgun', dir: hitDir, point: null, swingId: 0, forceKnockdown: false, combo: true };
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

  // 無限備彈旗標於建立時讀取（之後改 defs 不影響已建立的 weapons；測試以此走有限備彈路徑）
  const INF = {};
  for (const id of GUN_IDS) INF[id] = !!WEAPONS[id].infiniteAmmo;
  const infOf = (id) => !!INF[id];
  const shownReserve = (id = 'pistol') => (infOf(id) ? Infinity : guns[id].reserve);
  const hasReserve = (id = 'pistol') => infOf(id) || guns[id].reserve > 0;

  function ammoPayload(id = 'pistol') {
    return { weapon: id, mag: guns[id].mag, magSize: WEAPONS[id].magSize, reserve: shownReserve(id) };
  }

  function setState(s, t, dur = 0) {
    state = s;
    stateAt = t;
    actionDur = dur;
  }

  function finishReload(cancel) {
    const id = reloadGun;
    const g = guns[id];
    const D = WEAPONS[id];
    if (!cancel) {
      const n = infOf(id) ? D.magSize - g.mag : Math.min(D.magSize - g.mag, g.reserve);
      g.mag += n;
      if (!infOf(id)) g.reserve -= n;
    }
    setState('idle', time());
    emit('weapon:reload', { weapon: id, phase: 'end', mag: g.mag, reserve: shownReserve(id) });
    if (!cancel) emit('weapon:ammo', ammoPayload(id));
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

  const ownsSlot = (s) => Number.isInteger(s) && s >= 0 && s < SLOT_IDS.length && !!owned[SLOT_IDS[s]];

  // 回傳 true = 立即切換；被擋下時記為 pending、回 false；未擁有的槽（未購買的衝鋒槍 / 散彈槍）回 false、不排隊
  function select(s) {
    if (disposed || !ownsSlot(s)) return false;
    if (s === slot) {
      pending = -1;
      return false;
    }
    if (!canSwitch()) {
      pending = s;
      return false;
    }
    pending = -1;
    const prev = current();
    const t = time();
    slot = s;
    swingActive = false;
    autoReload = false;
    nextFireAt = -Infinity;
    setState('equipping', t, EQUIP_SEC);
    emit('weapon:equip', { slot, weapon: current(), prev });
    play('weapon_equip');
    return true;
  }

  // 從 from 往 dir（+1 下一格 / −1 上一格）找下一個已擁有的槽（未擁有的跳過）
  function stepSlot(from, dir) {
    const n = SLOT_IDS.length;
    let s = from;
    for (let i = 0; i < n; i++) {
      s = (((s + dir) % n) + n) % n;
      if (owned[SLOT_IDS[s]]) return s;
    }
    return from;
  }

  // 排隊中再按：從排隊的槽往下一格（連按 Q 兩下 = 跳兩格）；dir = −1 往上一格（手把十字鍵 ←）
  function cycle(dir = 1) {
    return select(stepSlot(pending >= 0 ? pending : slot, dir < 0 ? -1 : 1));
  }

  // 上一個已擁有的槽（手把十字鍵 ← 換成直選鍵用；排隊中以排隊的槽為準）
  function prevSlot() {
    return stepSlot(pending >= 0 ? pending : slot, -1);
  }

  function startReload(t) {
    const id = current();
    if (!isGun(id)) return false;
    const g = guns[id];
    const D = WEAPONS[id];
    if (g.mag >= D.magSize || !hasReserve(id) || isDown()) return false;
    reloadGun = id;
    setState('reloading', t, D.reloadSec);
    reloadEnd = t + D.reloadSec;
    emit('weapon:reload', { weapon: id, phase: 'start', mag: g.mag, reserve: shownReserve(id) });
    play('pistol_reload'); // 槍械共用手槍裝填 clip（沒有長槍專用 clip）
    return true;
  }

  function reload() {
    if (disposed || !isGun(current())) return false;
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

  // ---------- 槍械 ----------
  function defaultMuzzle(out, D = P) {
    const fx = Math.sin(actor.yaw);
    const fz = Math.cos(actor.yaw);
    out.x = actor.pos.x + fx * D.muzzleForward - fz * D.muzzleRight;
    out.y = actor.pos.y + D.muzzleHeight;
    out.z = actor.pos.z + fz * D.muzzleForward + fx * D.muzzleRight;
    return out;
  }

  function fillDefaultAim(D = P) {
    defaultMuzzle(defaultAim.origin, D);
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

  // 衝鋒槍目前散佈半角（度）：最後一發 spreadRecoverDelay 秒後起以 spreadRecover 收斂回 spreadBase
  function currentSpread(t) {
    const D = WEAPONS.smg;
    const k = Math.max(0, t - spreadAt - D.spreadRecoverDelay) * D.spreadRecover;
    return Math.max(D.spreadBase, spreadDeg - k);
  }

  // 彈匣空：有備彈 → 自動裝填（這一下不開槍）；沒有 → 空槍聲（節流）；回 true = 這一下不能開槍
  function emptyMag(t, id) {
    if (guns[id].mag > 0) return false;
    if (hasReserve(id)) {
      startReload(t);
      return true;
    }
    if (t - lastDryAt >= DRY_FIRE_INTERVAL) {
      lastDryAt = t;
      emit('weapon:dryFire', { weapon: id });
    }
    return true;
  }

  // 本發瞄準方向：觸控弱吸附（只觸控、設定開啟、有候選）→ aimDir；否則 a.dir
  function shotDir(a) {
    if (touch() && setting('aimAssist', true) && a.candidates && a.candidates.length) {
      visOrigin = a.origin;
      pickAimAssist(a.origin, a.dir, a.candidates, aimDir, assistOpts);
      return aimDir;
    }
    return a.dir;
  }

  // 開火共通收尾：彈藥事件、後座、動作、打空自動裝填
  //   射擊間隔以排程時刻 nextFireAt 起算：本發比排程晚不到半個間隔（幀長造成的遲到）→ 冷卻從排程時刻算、零頭結轉，
  //   30 / 60 / 144 fps 的每秒發數一致；停火較久（或換槍 / 讀檔後）→ 從本發時刻 t 起算
  function afterShot(t, id, D) {
    const g = guns[id];
    emit('weapon:ammo', ammoPayload(id));
    recoilKick(D, streak, rand(), setting('recoil', 1), kickTmp);
    kick.pitch += kickTmp.pitch;
    kick.yaw += kickTmp.yaw;
    play('pistol_fire'); // 槍械共用手槍開槍 clip（整合層據此疊加後座）
    const base = t - nextFireAt < D.fireInterval * 0.5 ? nextFireAt : t;
    nextFireAt = base + D.fireInterval;
    setState('attacking', base, D.fireInterval);
    if (g.mag === 0 && hasReserve(id)) autoReload = true;
  }

  // 手槍 / 衝鋒槍：單一射線（衝鋒槍先依散佈偏轉方向）
  function attackGun(t, aim, id) {
    if (emptyMag(t, id)) return false;
    const D = WEAPONS[id];
    const g = guns[id];
    const a = aim && aim.origin && aim.dir ? aim : fillDefaultAim(D);
    const mz = a.muzzle || defaultMuzzle(muzzle, D);
    let dir = shotDir(a);
    if (D.spreadBase !== undefined) {
      const cur = currentSpread(t) * (a.aiming ? D.aimSpreadScale : 1);
      const ang = cur * DEG * Math.sqrt(rand());
      spreadDir(dir, ang, rand() * Math.PI * 2, spreadOut);
      dir = spreadOut;
      spreadDeg = Math.min(D.spreadMax, currentSpread(t) + D.spreadPerShot);
      spreadAt = t;
    }
    resolveShot(raycast, a.origin, dir, mz, D.range, actor, shot, rayOpts);
    g.mag--;
    streak = t - lastShotAt < STREAK_GAP ? streak + 1 : 0;
    lastShotAt = t;
    let hitActor = false;
    if (shot.actor) {
      hitDir.x = shot.dir.x;
      hitDir.z = shot.dir.z;
      const r = combat ? combat.applyHit({ attacker: actor, target: shot.actor, damage: D.damage, weapon: id, dir: hitDir, point: shot.point, swingId: newSwingId() }) : null;
      hitActor = !!r;
    }
    // 打到非角色，或打到角色但 combat 不受理（倒地 / 死亡中 / untargetable）→ 在落點發 impact，每發必有「受擊 / impact / 明確 miss」其一
    if (shot.hit && !hitActor) {
      emit('weapon:impact', {
        x: shot.point.x, y: shot.point.y, z: shot.point.z,
        nx: shot.normal.x, ny: shot.normal.y, nz: shot.normal.z,
        surface: shot.surface === 'vehicle' ? 'vehicle' : 'world',
        vehicle: shot.vehicle || null, damage: shot.vehicle ? D.vehicleDamage : 0, byPlayer: actor.kind === 'player', weapon: id,
      });
    }
    emit('weapon:fire', {
      weapon: id, x: mz.x, y: mz.y, z: mz.z,
      dirX: shot.dir.x, dirY: shot.dir.y, dirZ: shot.dir.z,
      byPlayer: actor.kind === 'player', hit: hitActor,
      miss: !shot.hit, ex: shot.point.x, ey: shot.point.y, ez: shot.point.z, dist: shot.dist,
      vehicle: shot.hit && !hitActor ? shot.vehicle || null : null, // 打到的車（同 weapon:impact；犯行豁免比對命中車用）
    });
    afterShot(t, id, D);
    return true;
  }

  // 散彈槍：8 顆彈丸各一條射線（重用 shot / pelletDir），同一目標合併傷害後一次 applyHit
  function attackShotgun(t, aim) {
    const id = 'shotgun';
    if (emptyMag(t, id)) return false;
    const D = SG;
    const g = guns[id];
    const a = aim && aim.origin && aim.dir ? aim : fillDefaultAim(D);
    const mz = a.muzzle || defaultMuzzle(muzzle, D);
    const base = shotDir(a);
    const cone = D.coneDeg * DEG;
    const spin = rand() * Math.PI * 2;
    let nHit = 0; // pelHits 已用筆數（不同目標）
    let first = -1; // 第一顆有落點（或第 0 顆）的資料供 weapon:fire 彈道
    let firstMiss = true;
    let firstDist = 0;
    let firstVehicle = null;
    let impacts = 0;
    let pelletHits = 0;
    for (let i = 0; i < D.pellets; i++) {
      // 錐內分布：半徑 ∝ √((i + 0.5) / n)（面積均勻）× 抖動、方位 = 黃金角 + 整發隨機旋轉
      const r = Math.sqrt((i + 0.5) / D.pellets) * (0.8 + 0.2 * rand());
      spreadDir(base, cone * r, spin + i * GOLDEN, pelletDir);
      resolveShot(raycast, a.origin, pelletDir, mz, D.range, actor, shot, rayOpts);
      if (first < 0 || (firstMiss && shot.hit)) {
        first = i;
        firstMiss = !shot.hit;
        firstDist = shot.dist;
        firstVehicle = shot.hit && !shot.actor ? shot.vehicle || null : null;
        firstPt.x = shot.point.x;
        firstPt.y = shot.point.y;
        firstPt.z = shot.point.z;
        firstDir.x = shot.dir.x;
        firstDir.y = shot.dir.y;
        firstDir.z = shot.dir.z;
      }
      if (shot.actor) {
        const dmg = D.pelletDamage * pelletFalloff(shot.dist, D);
        let k = 0;
        while (k < nHit && pelHits[k].actor !== shot.actor) k++;
        const h = pelHits[k];
        if (k === nHit) {
          nHit++;
          h.actor = shot.actor;
          h.damage = 0;
          h.count = 0;
          h.dist = shot.dist;
          h.point.x = shot.point.x;
          h.point.y = shot.point.y;
          h.point.z = shot.point.z;
        }
        h.damage += dmg;
        h.count++;
        if (shot.dist < h.dist) h.dist = shot.dist;
        continue;
      }
      if (!shot.hit) continue;
      emit('weapon:impact', {
        x: shot.point.x, y: shot.point.y, z: shot.point.z,
        nx: shot.normal.x, ny: shot.normal.y, nz: shot.normal.z,
        surface: shot.surface === 'vehicle' ? 'vehicle' : 'world',
        vehicle: shot.vehicle || null, damage: shot.vehicle ? Math.round(D.vehicleDamage * pelletFalloff(shot.dist, D)) : 0, byPlayer: actor.kind === 'player',
        weapon: id, pellet: i, quiet: impacts > 0,
      });
      impacts++;
    }
    g.mag--;
    streak = t - lastShotAt < STREAK_GAP ? streak + 1 : 0;
    lastShotAt = t;
    let hitActor = false;
    if (nHit) {
      const sid = newSwingId();
      for (let k = 0; k < nHit; k++) {
        const h = pelHits[k];
        hitDir.x = h.actor.pos.x - actor.pos.x;
        hitDir.z = h.actor.pos.z - actor.pos.z;
        hitArgs.target = h.actor;
        hitArgs.damage = Math.round(h.damage);
        hitArgs.point = h.point;
        hitArgs.swingId = sid;
        hitArgs.forceKnockdown = h.dist <= D.knockdownRange && h.count >= D.knockdownPellets;
        hitArgs.combo = hitArgs.damage >= D.comboDamage; // 有效命中才累積擊倒連擊（遠距擦傷不累積）
        const res = combat ? combat.applyHit(hitArgs) : null;
        if (res) {
          hitActor = true;
          pelletHits += h.count;
        } else {
          // combat 不受理（倒地 / 死亡中）：比照手槍在落點發 impact
          emit('weapon:impact', {
            x: h.point.x, y: h.point.y, z: h.point.z, nx: -hitDir.x, ny: 0, nz: -hitDir.z,
            surface: 'world', vehicle: null, damage: 0, byPlayer: actor.kind === 'player', weapon: id, quiet: impacts > 0,
          });
          impacts++;
        }
        h.actor = null;
      }
      hitArgs.target = null;
      hitArgs.point = null;
    }
    emit('weapon:fire', {
      weapon: id, x: mz.x, y: mz.y, z: mz.z,
      dirX: firstDir.x, dirY: firstDir.y, dirZ: firstDir.z,
      byPlayer: actor.kind === 'player', hit: hitActor,
      miss: firstMiss && !hitActor, ex: firstPt.x, ey: firstPt.y, ez: firstPt.z, dist: firstDist,
      vehicle: firstVehicle, pellets: D.pellets, pelletHits,
    });
    afterShot(t, id, D);
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
    if (w === 'shotgun') return attackShotgun(t, aim);
    return attackGun(t, aim, w);
  }

  function update(dt, aim) {
    if (disposed) return;
    if (!now) clock += dt;
    const t = time();
    updateBat(t);
    tick(t);
    if (pending >= 0 && canSwitch()) select(pending);
    aiming = !!(aim && aim.aiming) && isGun(current());
  }

  // id 省略：手上是槍 → 該槍；否則手槍（相容舊用法）
  function ammo(id) {
    const w = isGun(id) ? id : isGun(current()) ? current() : 'pistol';
    ammoOut.weapon = w;
    ammoOut.mag = guns[w].mag;
    ammoOut.magSize = WEAPONS[w].magSize;
    ammoOut.reserve = shownReserve(w);
    return ammoOut;
  }

  function addAmmo(n, id = 'pistol') {
    const k = Math.floor(n);
    if (disposed || !isGun(id) || !owned[id] || infOf(id) || !(k > 0)) return 0; // 無限備彈 / 未擁有：不加、回 0（整合層不跳拾取提示）
    const g = guns[id];
    const added = Math.min(WEAPONS[id].reserveMax - g.reserve, k);
    if (added <= 0) return 0;
    g.reserve += added;
    emit('weapon:ammo', ammoPayload(id));
    // 彈匣已空、手上正拿著該槍待機 → 撿到彈藥順手裝填
    if (g.mag === 0 && current() === id) {
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
    return Math.min(1, Math.max(0, 1 - (reloadEnd - time()) / WEAPONS[reloadGun].reloadSec));
  }

  const owns = (id) => !!owned[id];

  // 取得武器（武器店購買）：未擁有的 PURCHASABLE → 擁有、彈匣滿 + 附贈 startReserve 備彈，發 weapon:acquire 與 weapon:ammo；已擁有 / 非法 → false
  function give(id) {
    if (disposed || !PURCHASABLE.includes(id) || owned[id]) return false;
    owned[id] = true;
    guns[id].mag = WEAPONS[id].magSize;
    guns[id].reserve = WEAPONS[id].startReserve;
    emit('weapon:acquire', { weapon: id, slot: WEAPONS[id].slot });
    emit('weapon:ammo', ammoPayload(id));
    return true;
  }

  // 衝鋒槍目前散佈半角（度；HUD 準星 / 測試用）
  const spread = () => currentSpread(time());

  // 存檔：手槍彈藥一律存；衝鋒槍 / 散彈槍只在擁有時存彈藥與 owned 清單（未擁有 = 舊格式，與 Phase 13 以前的存檔相同）
  function serialize() {
    const out = { slot, ammo: { pistol: { mag: guns.pistol.mag, reserve: guns.pistol.reserve } } };
    const own = PURCHASABLE.filter((id) => owned[id]);
    if (own.length) {
      out.owned = own;
      for (const id of own) out.ammo[id] = { mag: guns[id].mag, reserve: guns[id].reserve };
    }
    return out;
  }

  // 讀檔：非法欄位退回預設（slot 0、彈匣 12、備彈 36）；owned 只收 PURCHASABLE；槽位必須已擁有否則 0；
  //   直接換到該槽（不播 equip），發 weapon:equip 與 weapon:ammo
  function restore(data) {
    if (disposed) return false;
    const d = data && typeof data === 'object' ? data : {};
    const own = Array.isArray(d.owned) ? d.owned : [];
    for (const id of PURCHASABLE) owned[id] = own.includes(id);
    const s = ownsSlot(d.slot) ? d.slot : 0;
    const okInt = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;
    for (const id of GUN_IDS) {
      const D = WEAPONS[id];
      const ga = d.ammo && d.ammo[id];
      const g = guns[id];
      g.mag = owned[id] && ga && okInt(ga.mag, D.magSize) ? ga.mag : D.magSize;
      g.reserve = owned[id] && ga && okInt(ga.reserve, D.reserveMax) ? ga.reserve : D.startReserve;
    }
    spreadDeg = 0;
    spreadAt = -Infinity;
    nextFireAt = -Infinity;
    const prev = current();
    slot = s;
    pending = -1;
    swingActive = false;
    autoReload = false;
    setState('idle', time());
    emit('weapon:equip', { slot, weapon: current(), prev });
    emit('weapon:ammo', ammoPayload(isGun(current()) ? current() : 'pistol'));
    return !!data;
  }

  function dispose() {
    disposed = true;
    pending = -1;
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
    get pending() {
      return pending;
    },
    canSwitch,
    select,
    cycle,
    prevSlot,
    owns,
    give,
    spread,
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
