// 暴走任務（Phase 15，§37 Rampage，GTA 經典）：地圖 4 處紅色骷髏標記（三個幫派地盤各一 + 市區一處），步行走進標記即開始——
//   暫時發給指定武器（含彈藥），限時內擊殺指定幫派成員 / 炸毀指定數量車輛；結束（成功 / 失敗）一律收回並恢復開始前的武器狀態。
// 純邏輯模組，不 import three / rapier；DOM 只在 createRampageHud（整合層給 root）；3D 骷髏在 createSkullMarkers（THREE 由參數注入）。
//
// createRampage({ bus, weapons, gangOf, isTargetVehicle, list, config }) → { update(dt, ctx), start(id, ctx?), end(kind), cancel(), markers(out),
//   isDone(id), doneCount, allDone, serialize(), restore(rec), savedWeapons(), active, current, kills, remain, dispose(), … }
//   bus：emit rampage:start { id, name, target, gang, goal, timeSec, weapon } / rampage:kill { id, kills, goal } /
//     rampage:complete { id, reward, kills, timeSec, all, bonus } / rampage:fail { id, reason, kills }、toast（ctx.toast 省略時）；
//     訂閱 ped:dead（byPlayer 且 gangOf(ped) === 目標幫派 → 擊殺 +1）、vehicle:explode（byPlayer 且 isTargetVehicle(v) → 炸毀 +1）
//   weapons：weapons.js 實例（只用 serialize() / restore(data)）——開始時存下 serialize() 快照、restore(grantData(快照, 武器, 彈藥)) 暫發；
//     結束時 restore(快照) 恢復（原本未擁有該武器 → 仍未擁有；原本的彈匣 / 備彈 / 手持槽位原樣回來）
//   gangOf(actor) → 幫派 id | null（main：gangs.gangOf）；isTargetVehicle(v) → boolean（省略 = 全部；main：不算玩家正駕駛的車）
// 呼叫端（main.js）每幀建 ctx = { player: { x, z }, onFoot, busy, frozen, world, earn(n, reason), toast?(text, sec) }：
//   onFoot = 步行且可行動（非倒地 / KO / 送醫）；busy = 其他任務進行中（委託 / 外送 / 打工 / 警車任務 / 競速 / 副任務 / 搶劫 / 噴漆 / BUSTED・WASTED）
//   frozen = 手機 / BUSTED・WASTED / 噴漆中（計時不前進、不觸發、不補敵人）；earn(n, 'rampage') = economy.add
//   world（敵人補充介面，見 createRampageWorld；測試以替身注入）：alive(gangId, x, z, r) → 該幫存活成員數；spawn(gangId, x, z, n) → 實際補充人數；release?() → 結束時交還徵用的成員（reset 前呼叫）
// 觸發：步行（不含駕車：GTA 原作是走進骷髏；駕車經過不觸發，下車站在標記內即開始）進入未完成點的 START_RADIUS → 開始；
//   以「步行且在範圍內」的上升緣判定（結束後站在原地不會立刻重開，離開再走進來才重新挑戰）；busy → toast TOAST_BUSY 不開始
// 進行中：計時吃呼叫端 dt（clamp ≤ MAX_DT，≥ 10 fps 時與幀率無關）；每 SPAWN_SEC 秒檢查一次，玩家 ENEMY_RADIUS 內目標幫派存活成員 < MIN_ENEMIES
//   → world.spawn 補足（每次 ≤ SPAWN_BATCH，沿用 gangs 成員生成：徵用附近骨架行人換成該幫成員並挑起敵意）；通緝照常累積（不豁免犯行）
// 完成：擊殺數達標（事件當下只記 pending，下一次 update 才結算——不在武器開火的呼叫堆疊內換武器）→ 賞金 earn(reward, 'rampage')、toast、
//   標記為已完成（serialize → 存檔 rampage.done）；四處全部完成 → 額外獎勵 ALL_BONUS（直接給錢，只給一次：完成最後一處的那次）
// 失敗：timeout（時間到）/ wasted（送醫）/ busted（被捕）→ toast；cancel（回主選單 / 開新局）→ 無聲；一律恢復武器狀態、可再挑戰
// 每幀路徑不配置物件（ctx / 回傳物件 out / 標記陣列重用；HUD 字串只在擊殺數或剩餘整秒改變時重組）；事件 payload 只在事件發生時配置
import { WEAPONS, PURCHASABLE, isGun } from '../weapons/defs.js';

export const START_RADIUS = 2.5; // m，走進骷髏標記此半徑內開始
export const MAX_DT = 0.1; // s，單幀 dt 上限
export const SPAWN_SEC = 2; // s，補敵人檢查間隔
export const ENEMY_RADIUS = 60; // m，計算 / 補充敵人的範圍（以玩家為中心：骨架行人只存在於玩家附近）
export const MIN_ENEMIES = 6; // 範圍內目標幫派存活成員少於此數就補
export const SPAWN_BATCH = 4; // 每次最多補幾人
export const ALL_BONUS = 5000; // NT$，四處全部完成的額外獎勵
export const URGENT_SEC = 10; // s，剩餘時間 ≤ 此值 HUD 轉急迫樣式
export const MARKER_KIND = 'rampage'; // 小地圖骷髏圖示（hud.js SKULL_KINDS）
export const TARGETS = Object.freeze(['gang', 'vehicle']);
export const FAIL_REASONS = Object.freeze(['timeout', 'wasted', 'busted', 'cancel']);
export const TOAST_BUSY = '正在進行其他任務，不能開始暴走';
export const FAIL_TEXT = Object.freeze({ timeout: '時間到', wasted: '送醫', busted: '被捕' });
export const toastFail = (reason) => `暴走失敗：${FAIL_TEXT[reason] || reason}`;
export const toastComplete = (reward) => `暴走完成！賞金 NT$${reward}`;
export const toastAllDone = (bonus) => `全部暴走完成！額外獎勵 NT$${bonus}`;

// 暴走點：地盤點取該幫地盤多邊形內的人行道 / 步道頂點（src/data/osm-city.json F 層，離建築輪廓 ≥ 6 m）；市區點在三個地盤外
//   tools/test/p15-rampage.mjs 逐點驗證：地盤點在所屬地盤內（gangs.territoryAt）、市區點不在任何地盤、不在建築內、彼此相距 ≥ 150 m
//   ammo = 暫發備彈（彈匣另外裝滿；clamp 到該槍 reserveMax）；reward NT$1000–3000
export const RAMPAGES = Object.freeze([
  {
    id: 'rampage-nightmarket',
    name: '新光三越廣場暴走',
    x: 631.1,
    z: -95.3,
    src: 'F pedestrian（新光三越東側廣場）｜夜市角頭地盤',
    target: 'gang',
    gang: 'nightmarket',
    gangName: '夜市角頭',
    weapon: 'shotgun',
    ammo: 36,
    goal: 15,
    timeSec: 60,
    reward: 2000,
  },
  {
    id: 'rampage-qiuhonggu',
    name: '秋紅谷步道暴走',
    x: 181.1,
    z: -289.4,
    src: 'F footway（秋紅谷廣場東側）｜秋紅谷飆車族地盤',
    target: 'gang',
    gang: 'qiuhonggu',
    gangName: '秋紅谷飆車族',
    weapon: 'pistol',
    ammo: 120,
    goal: 12,
    timeSec: 60,
    reward: 1500,
  },
  {
    id: 'rampage-suits',
    name: '府會園道暴走',
    x: 926.5,
    z: 381.0,
    src: 'F pedestrian（府會園道旁，市政大樓東側）｜七期西裝幫地盤',
    target: 'gang',
    gang: 'suits',
    gangName: '七期西裝幫',
    weapon: 'smg',
    ammo: 240,
    goal: 20,
    timeSec: 90,
    reward: 3000,
  },
  {
    id: 'rampage-opera',
    name: '歌劇院炸車暴走',
    x: 152.4,
    z: 198.8,
    src: 'F footway（惠民路旁，國家歌劇院西北）｜市區（不在任何地盤）',
    target: 'vehicle',
    gang: null,
    gangName: null,
    weapon: 'shotgun',
    ammo: 60,
    goal: 6,
    timeSec: 90,
    reward: 2500,
  },
]);

export const rampageById = (id, list = RAMPAGES) => list.find((r) => r.id === id) || null;

// mm:ss（無條件進位到整秒：剩 0.4 s 仍顯示 00:01；負值 = 0）
export function formatClock(sec) {
  const s = Math.max(0, Math.ceil((Number(sec) || 0) - 1e-6));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
export const barText = (def, kills, remain) => `暴走！ ${def.target === 'vehicle' ? '炸車' : '擊殺'} ${kills}/${def.goal}｜${formatClock(remain)}`;
export const toastStart = (def) =>
  `暴走開始！${def.timeSec} 秒內${def.target === 'vehicle' ? `炸毀 ${def.goal} 台車` : `擊殺 ${def.goal} 名${def.gangName || '幫派成員'}`}（${(WEAPONS[def.weapon] && WEAPONS[def.weapon].label) || def.weapon}）`;

// 暫發武器的 restore 資料：以 weapons.serialize() 快照為底（不改動快照），擁有權加上該武器、彈匣裝滿、備彈 = min(ammo, reserveMax)、手持槽位換成該武器
export function grantData(snap, weapon, ammo) {
  const D = WEAPONS[weapon];
  const base = snap && typeof snap === 'object' ? snap : {};
  const out = { slot: D ? D.slot : 0, ammo: {} };
  if (base.ammo && typeof base.ammo === 'object') for (const k of Object.keys(base.ammo)) out.ammo[k] = { ...base.ammo[k] };
  const owned = Array.isArray(base.owned) ? base.owned.slice() : [];
  if (PURCHASABLE.includes(weapon) && !owned.includes(weapon)) owned.push(weapon);
  if (owned.length) out.owned = owned;
  if (D && isGun(weapon)) out.ammo[weapon] = { mag: D.magSize, reserve: Math.max(0, Math.min(D.reserveMax, Math.floor(ammo) || 0)) };
  return out;
}

const cloneJson = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));

export function createRampage({ bus = null, weapons = null, gangOf = null, isTargetVehicle = null, list = RAMPAGES, config = {} } = {}) {
  const C = {
    startRadius: START_RADIUS,
    maxDt: MAX_DT,
    spawnSec: SPAWN_SEC,
    enemyRadius: ENEMY_RADIUS,
    minEnemies: MIN_ENEMIES,
    spawnBatch: SPAWN_BATCH,
    allBonus: ALL_BONUS,
    urgentSec: URGENT_SEC,
    ...config,
  };
  const done = new Set();
  const inside = list.map(() => true); // 上一幀「步行且在範圍內」：初值 true = 開局 / 讀檔站在標記上不會立刻觸發
  const mk = list.map((r) => ({ x: r.x, z: r.z, kind: MARKER_KIND, id: r.id }));
  const out = { active: false, id: null, def: null, kills: 0, goal: 0, remain: 0, text: null, urgent: false };
  const st = { def: null, kills: 0, elapsed: 0, pending: false, spawnT: 0, snap: null, textKills: -1, textSec: -1, text: null, world: null };
  let lastCtx = null;
  const offs = [];

  const emit = (name, payload) => {
    if (bus && typeof bus.emit === 'function') bus.emit(name, payload);
  };
  const toast = (ctx, text, sec) => {
    if (ctx && typeof ctx.toast === 'function') ctx.toast(text, sec);
    else emit('toast', { text, seconds: sec });
  };

  function restoreWeapons() {
    if (st.snap && weapons && typeof weapons.restore === 'function') weapons.restore(st.snap);
    st.snap = null;
  }

  // 補充 / 徵用的敵人交還 gangs（所有結束路徑經 reset：完成 / 時間到 / 送醫 / 被捕 / cancel / 讀檔）
  function releaseEnemies() {
    const w = st.world;
    st.world = null;
    if (w && typeof w.release === 'function') w.release();
  }

  function reset() {
    releaseEnemies();
    st.def = null;
    st.kills = 0;
    st.elapsed = 0;
    st.pending = false;
    st.spawnT = 0;
    st.textKills = -1;
    st.textSec = -1;
    st.text = null;
    for (let i = 0; i < inside.length; i++) inside[i] = true; // 結束時站在標記上 → 離開再走進來才重開
  }

  function start(id, ctx = lastCtx) {
    const def = rampageById(id, list);
    if (!def || st.def || done.has(id)) return false;
    if (ctx && ctx.busy) {
      toast(ctx, TOAST_BUSY, 2.5);
      return false;
    }
    st.def = def;
    st.kills = 0;
    st.elapsed = 0;
    st.pending = false;
    st.spawnT = 0; // 第一次 update 就補敵人
    st.textKills = -1;
    if (weapons && typeof weapons.serialize === 'function') {
      st.snap = cloneJson(weapons.serialize());
      weapons.restore(grantData(st.snap, def.weapon, def.ammo));
    }
    toast(ctx, toastStart(def), 4);
    emit('rampage:start', { id: def.id, name: def.name, target: def.target, gang: def.gang, goal: def.goal, timeSec: def.timeSec, weapon: def.weapon });
    return true;
  }

  function complete(ctx) {
    const def = st.def;
    const kills = st.kills;
    const timeSec = st.elapsed;
    done.add(def.id);
    restoreWeapons();
    reset();
    if (ctx && typeof ctx.earn === 'function') ctx.earn(def.reward, 'rampage');
    toast(ctx, toastComplete(def.reward), 4);
    const all = list.every((r) => done.has(r.id));
    const bonus = all ? C.allBonus : 0;
    if (bonus > 0) {
      if (ctx && typeof ctx.earn === 'function') ctx.earn(bonus, 'rampage');
      toast(ctx, toastAllDone(bonus), 5);
    }
    emit('rampage:complete', { id: def.id, reward: def.reward, kills, timeSec, all, bonus });
  }

  function fail(reason, ctx) {
    const def = st.def;
    const kills = st.kills;
    restoreWeapons();
    reset();
    if (reason !== 'cancel') toast(ctx, toastFail(reason), 3);
    emit('rampage:fail', { id: def.id, reason, kills });
  }

  function addKill() {
    if (!st.def || st.pending) return;
    st.kills++;
    emit('rampage:kill', { id: st.def.id, kills: st.kills, goal: st.def.goal });
    if (st.kills >= st.def.goal) st.pending = true;
  }

  if (bus && typeof bus.on === 'function') {
    const sub = (name, fn) => {
      const off = bus.on(name, fn);
      if (typeof off === 'function') offs.push(off);
    };
    sub('ped:dead', (e) => {
      const def = st.def;
      if (!def || def.target !== 'gang' || !e || !e.byPlayer || !e.ped || typeof gangOf !== 'function') return;
      if (gangOf(e.ped) === def.gang) addKill();
    });
    sub('vehicle:explode', (e) => {
      const def = st.def;
      if (!def || def.target !== 'vehicle' || !e || !e.byPlayer) return;
      if (typeof isTargetVehicle === 'function' && !isTargetVehicle(e.vehicle)) return;
      addKill();
    });
  }

  function fillOut() {
    const def = st.def;
    out.active = !!def;
    out.id = def ? def.id : null;
    out.def = def;
    out.kills = def ? st.kills : 0;
    out.goal = def ? def.goal : 0;
    out.remain = def ? Math.max(0, def.timeSec - st.elapsed) : 0;
    out.urgent = !!def && out.remain <= C.urgentSec;
    if (def) {
      const sec = Math.ceil(out.remain - 1e-6);
      if (sec !== st.textSec || st.kills !== st.textKills) {
        st.textSec = sec;
        st.textKills = st.kills;
        st.text = barText(def, st.kills, out.remain);
      }
    }
    out.text = def ? st.text : null;
    return out;
  }

  function replenish(dt, ctx) {
    const def = st.def;
    if (def.target !== 'gang' || !ctx.world || !ctx.player) return;
    st.spawnT -= dt;
    if (st.spawnT > 0) return;
    st.spawnT = C.spawnSec;
    const px = ctx.player.x;
    const pz = ctx.player.z;
    const alive = ctx.world.alive(def.gang, px, pz, C.enemyRadius) || 0;
    const need = Math.min(C.spawnBatch, C.minEnemies - alive);
    if (need > 0) {
      st.world = ctx.world; // 結束時 release 用（徵用時的 world）
      ctx.world.spawn(def.gang, px, pz, need);
    }
  }

  function update(dt, ctx = {}) {
    lastCtx = ctx;
    if (ctx.frozen) return fillOut();
    const step = Math.min(C.maxDt, Math.max(0, Number(dt) || 0));
    if (st.def) {
      if (st.pending) complete(ctx);
      else {
        st.elapsed += step;
        if (st.elapsed >= st.def.timeSec - 1e-9) fail('timeout', ctx);
        else replenish(step, ctx);
      }
      return fillOut();
    }
    const p = ctx.player;
    if (p) {
      const r2 = C.startRadius * C.startRadius;
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        const dx = p.x - r.x;
        const dz = p.z - r.z;
        const now = !!ctx.onFoot && !done.has(r.id) && dx * dx + dz * dz <= r2;
        const rising = now && !inside[i];
        inside[i] = now;
        if (rising && start(r.id, ctx)) break;
      }
    }
    return fillOut();
  }

  // BUSTED / WASTED（main：beginRespawn → vigHooks.end(kind)）：已達標待結算 → 照算完成；否則以 kind 失敗
  function end(kind, ctx = lastCtx) {
    if (!st.def) return false;
    if (st.pending) complete(ctx);
    else fail(kind === 'busted' || kind === 'wasted' || kind === 'timeout' ? kind : 'cancel', ctx);
    return true;
  }

  // 回主選單 / 開新局 / 讀檔：無聲失敗（恢復武器、emit rampage:fail reason 'cancel'）；已達標待結算 → 同 end() 照算完成（賞金 + 完成紀錄）
  function cancel() {
    if (st.def && st.pending) complete(lastCtx);
    else if (st.def) fail('cancel', null);
    else reset();
    fillOut();
  }

  // 未完成且未進行中的點（進行中全部隱藏：避免途中誤踩另一點）
  function markers(buf = []) {
    if (st.def) return buf;
    for (let i = 0; i < list.length; i++) if (!done.has(list[i].id)) buf.push(mk[i]);
    return buf;
  }

  function serialize() {
    const ids = list.filter((r) => done.has(r.id)).map((r) => r.id);
    return ids.length ? { done: ids } : null;
  }

  // 舊存檔沒有此欄 / 格式錯誤 → 全部未完成；未知 id 略過
  function restore(rec) {
    if (st.def) cancel();
    done.clear();
    const ids = rec && Array.isArray(rec.done) ? rec.done : [];
    for (const id of ids) if (rampageById(id, list)) done.add(id);
    reset();
    fillOut();
  }

  function dispose() {
    cancel();
    for (const off of offs) off();
    offs.length = 0;
  }

  return {
    update,
    start,
    end,
    cancel,
    markers,
    serialize,
    restore,
    dispose,
    list,
    config: C,
    isDone: (id) => done.has(id),
    savedWeapons: () => (st.def ? st.snap : null), // 進行中存檔用開始前的武器狀態（暫發武器不入檔）
    get active() {
      return !!st.def;
    },
    get current() {
      return st.def;
    },
    get kills() {
      return st.kills;
    },
    get remain() {
      return st.def ? Math.max(0, st.def.timeSec - st.elapsed) : 0;
    },
    get doneCount() {
      return done.size;
    },
    get allDone() {
      return list.every((r) => done.has(r.id));
    },
  };
}

// ---------- 敵人補充（世界轉接：沿用 gangs 成員生成，不 import three） ----------
// createRampageWorld({ traffic, gangs, combat, repaint, minDist }) → { alive(gangId, x, z, r), spawn(gangId, x, z, n) → 實際人數, release() → 釋放人數, enlisted }
//   alive：gangs.members 中該幫、combat 狀態非 dead 的成員在 (x, z) 半徑 r 內的人數
//   spawn：徵用 (x, z) 半徑 ENEMY_RADIUS 內、離玩家 ≥ minDist 的漫步中骨架行人（同 street-events idle 條件），由近到遠取 n 人
//     → gangs.enlist(peds, gangId)（換成該幫成員、挑起敵意圍攻玩家）→ repaint(p)（骨架重新上色 + 掛武器，整合層提供）
//   release：本次暴走 spawn 徵用的成員 → gangs.release（收手、取消登記、citizen.gang / look 還原）→ 仍存活者 repaint(p)（回原色、卸武器）；清空紀錄（重複呼叫 = 0）
//   暫存陣列建構時配置、每次呼叫重用
export const SPAWN_MIN_DIST = 12; // m，徵用行人離玩家至少此距離（不在身邊憑空變成敵人）
export function createRampageWorld({ traffic = null, gangs = null, combat = null, repaint = null, minDist = SPAWN_MIN_DIST, radius = ENEMY_RADIUS } = {}) {
  const pool = [];
  const picked = [];
  const enlisted = []; // 本次暴走徵用的成員 actor（release 交還）
  const stateOf = (a) => (combat && typeof combat.stateOf === 'function' ? combat.stateOf(a) : 'normal');
  function idle(p) {
    if (!p || !p.alive || !p.actor || !p.brain || !p.citizen) return false;
    if (p.state !== 'walk' || p.pendingFrom || p.brain.override || p.citizen.gang || p.brain.state !== 'wander') return false;
    return stateOf(p.actor) === 'normal';
  }
  function alive(gangId, x, z, r) {
    if (!gangs || !gangs.members) return 0;
    const r2 = r * r;
    let n = 0;
    for (const m of gangs.members) {
      if (!m || !m.gang || m.gang.id !== gangId || !m.actor) continue;
      const a = m.actor;
      if ((a.pos.x - x) ** 2 + (a.pos.z - z) ** 2 > r2) continue;
      if (stateOf(a) === 'dead' || !(a.hp > 0)) continue;
      n++;
    }
    return n;
  }
  function spawn(gangId, x, z, n) {
    if (!gangs || typeof gangs.enlist !== 'function' || !traffic || !traffic.peds || !(n > 0)) return 0;
    pool.length = 0;
    const r2 = radius * radius;
    const m2 = minDist * minDist;
    for (const p of traffic.peds) {
      if (!idle(p)) continue;
      const d2 = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d2 <= r2 && d2 >= m2) pool.push(p);
    }
    if (!pool.length) return 0;
    pool.sort((p, q) => (p.x - x) ** 2 + (p.z - z) ** 2 - ((q.x - x) ** 2 + (q.z - z) ** 2));
    picked.length = 0;
    for (let i = 0; i < pool.length && picked.length < n; i++) picked.push(pool[i]);
    const actors = gangs.enlist(picked, gangId);
    for (const a of actors) enlisted.push(a);
    if (typeof repaint === 'function') for (const p of picked) if (p.citizen && p.citizen.gang) repaint(p);
    return actors.length;
  }
  function release() {
    if (!enlisted.length) return 0;
    const peds = gangs && typeof gangs.release === 'function' ? gangs.release(enlisted) : [];
    enlisted.length = 0;
    if (typeof repaint === 'function') for (const p of peds) if (p && p.alive && p.citizen && !p.citizen.gang) repaint(p);
    return peds.length;
  }
  return { alive, spawn, release, enlisted };
}

// ---------- HUD（任務條 + 畫面邊緣紅色脈動；.rampage- 前綴樣式在 src/style.css，prefers-reduced-motion 時關閉脈動） ----------
// createRampageHud({ root, doc }) → { set(out | null), el, edge, dispose() }；set 只在文字 / 狀態改變時寫 DOM
export function createRampageHud({ root = null, doc = globalThis.document } = {}) {
  if (!doc || !root) return { set() {}, el: null, edge: null, dispose() {} };
  const el = doc.createElement('div');
  el.className = 'rampage-bar';
  el.setAttribute('role', 'status');
  el.hidden = true;
  const edge = doc.createElement('div');
  edge.className = 'rampage-edge';
  edge.setAttribute('aria-hidden', 'true');
  edge.hidden = true;
  root.appendChild(edge);
  root.appendChild(el);
  let shown = null;
  let urgent = false;
  function set(o) {
    const text = o && o.active ? o.text : null;
    if (text !== shown) {
      shown = text;
      el.hidden = !text;
      edge.hidden = !text;
      if (text) el.textContent = text;
    }
    const u = !!(text && o.urgent);
    if (u !== urgent) {
      urgent = u;
      el.classList.toggle('rampage-urgent', u);
      edge.classList.toggle('rampage-urgent', u);
    }
  }
  function dispose() {
    el.remove();
    edge.remove();
  }
  return { set, el, edge, dispose };
}

// ---------- 3D 骷髏標記（程式產生的低模；THREE 由參數注入，不新增 glb / 貼圖 / 光源 / 陰影） ----------
// createSkullMarkers({ THREE, scene, heightAt, list }) → { update(dt, rampage), groups, dispose() }
//   幾何 / 材質全部共用（MeshStandardMaterial 紅色 emissive 2.0：夜間泛光門檻以上；眼窩 MeshBasicMaterial 深色），castShadow / receiveShadow 關閉
//   update：旋轉 + 上下浮動（只改既有物件的 rotation / position）；已完成或有暴走進行中的點隱藏
export const SKULL_HOVER = 1.7; // m，骷髏中心離地高度
export const SKULL_SPIN = 1.6; // rad/s
export const SKULL_BOB = 0.15; // m，浮動幅度
export function createSkullMarkers({ THREE, scene, heightAt = null, list = RAMPAGES } = {}) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xb71c1c, emissive: 0xff1a1a, emissiveIntensity: 2, roughness: 0.6, metalness: 0 });
  const dark = new THREE.MeshBasicMaterial({ color: 0x140000 });
  const geos = {
    cranium: new THREE.IcosahedronGeometry(0.6, 1),
    jaw: new THREE.BoxGeometry(0.62, 0.3, 0.5),
    eye: new THREE.IcosahedronGeometry(0.16, 0),
    nose: new THREE.ConeGeometry(0.08, 0.16, 3),
  };
  const part = (geo, m, x, y, z) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    return mesh;
  };
  const groups = list.map((r) => {
    const g = new THREE.Group();
    g.name = `rampage-skull-${r.id}`;
    g.add(part(geos.cranium, mat, 0, 0.1, 0));
    g.add(part(geos.jaw, mat, 0, -0.42, 0.12));
    g.add(part(geos.eye, dark, -0.22, 0.08, 0.5));
    g.add(part(geos.eye, dark, 0.22, 0.08, 0.5));
    const nose = part(geos.nose, dark, 0, -0.14, 0.56);
    nose.rotation.x = Math.PI;
    g.add(nose);
    const y0 = (typeof heightAt === 'function' ? heightAt(r.x, r.z) || 0 : 0) + SKULL_HOVER;
    g.position.set(r.x, y0, r.z);
    g.userData.y0 = y0;
    if (scene) scene.add(g);
    return g;
  });
  let t = 0;
  function update(dt, rampage = null) {
    t += Math.max(0, dt || 0);
    const busy = !!(rampage && rampage.active);
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const vis = !busy && !(rampage && rampage.isDone(list[i].id));
      g.visible = vis;
      if (!vis) continue;
      g.rotation.y = t * SKULL_SPIN;
      g.position.y = g.userData.y0 + Math.sin(t * 2 + i) * SKULL_BOB;
    }
  }
  function dispose() {
    for (const g of groups) if (g.parent) g.parent.remove(g);
    for (const k of Object.keys(geos)) geos[k].dispose();
    mat.dispose();
    dark.dispose();
  }
  return { update, groups, dispose };
}
