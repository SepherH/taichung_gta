#!/usr/bin/env node
// 武器無頭測試（W1）：src/weapons/**、combat.applyHit / knockdownActor、npc-ai 槍聲、pickups、HUD 純邏輯與最小 DOM
// 以假 combat actor / 假 raycast / 假 sweep 驗證：三槽狀態機、球棒命中窗與去重、手槍瞄點 / 遮擋 / 彈藥 / 裝填 / 空槍 / 後座 /
//   觸控弱吸附、擊倒門檻、側向判定、模型缺檔退回、彈藥拾取、輪盤角度 → 槽位、長按判定、存讀檔
// 用法：node tools/test/weapons.mjs [-v]（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
import { register } from 'node:module';

const HOOK = `
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function load(url, context, next) {
  if (url.endsWith('.json')) {
    return { format: 'module', shortCircuit: true, source: 'export default ' + readFileSync(fileURLToPath(url), 'utf8') + ';' };
  }
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default "";' };
  return next(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(HOOK)}`, import.meta.url);

// ---------- document 最小替身（HUD 用）----------
class FakeClassList {
  constructor(elm) {
    this.elm = elm;
    this.set = new Set();
  }
  add(...c) {
    for (const x of c) this.set.add(x);
  }
  remove(...c) {
    for (const x of c) this.set.delete(x);
  }
  toggle(c, on) {
    const v = on === undefined ? !this.set.has(c) : !!on;
    if (v) this.set.add(c);
    else this.set.delete(c);
    return v;
  }
  contains(c) {
    return this.set.has(c);
  }
}
class FakeEl {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.attrs = {};
    this.listeners = {};
    this.hidden = false;
    this.textContent = '';
    this.id = '';
    this._cls = new FakeClassList(this);
    this.ownerDocument = globalThis.document;
    this.rect = { left: 0, top: 0, width: 64, height: 64 };
  }
  get className() {
    return [...this._cls.set].join(' ');
  }
  set className(v) {
    this._cls.set = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get classList() {
    return this._cls;
  }
  get firstChild() {
    return this.children[0] || null;
  }
  appendChild(c) {
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parentNode = null;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  addEventListener(t, fn) {
    (this.listeners[t] ||= []).push(fn);
  }
  removeEventListener(t, fn) {
    const l = this.listeners[t];
    if (l) l.splice(l.indexOf(fn), 1);
  }
  dispatch(type, props = {}) {
    const e = { type, currentTarget: this, preventDefault() {}, stopPropagation() {}, pointerId: 1, clientX: 0, clientY: 0, ...props };
    for (const fn of (this.listeners[type] || []).slice()) fn(e);
  }
  setPointerCapture() {}
  getBoundingClientRect() {
    return this.rect;
  }
  find(id) {
    if (this.id === id) return this;
    for (const c of this.children) {
      const r = c.find(id);
      if (r) return r;
    }
    return null;
  }
}
globalThis.document = {
  createElement: (tag) => new FakeEl(tag),
  body: null,
};
globalThis.document.body = new FakeEl('body');

const THREE = await import('three');
const { CombatSystem, KNOCKDOWN_RULES, hitSide, pedKnockdownPayload } = await import('../../src/combat.js');
const { NpcBrain, wireCombatToBrains, GUNSHOT_RADIUS } = await import('../../src/npc-ai.js');
const { createBus } = await import('../../src/core/events.js');
const { WEAPONS, SLOT_IDS, EQUIP_SEC, SWITCH_AT, AIM_ASSIST_ANGLE, AIM_ASSIST_RANGE, DRY_FIRE_INTERVAL } = await import('../../src/weapons/defs.js');
const { pickAimAssist, resolveShot, recoilKick } = await import('../../src/weapons/aim.js');
const { createWeapons, batTiming, batArc, gunshotListeners } = await import('../../src/weapons/weapons.js');
const { loadWeaponModels, normalizeWeaponManifest, normalizeWeaponEntry, makeBatSegment, _resetWeaponModelInfo, BAT_LENGTH } = await import('../../src/weapons/models.js');
const { createAmmoPickups, DEFAULT_AMMO_POINTS, PICKUP_RADIUS } = await import('../../src/weapons/pickups.js');
const { classifyPress, isLongPress, wheelSlotFromVector, wheelCellOffset, ammoText, LONG_PRESS_MS } = await import('../../src/weapons/wheel.js');
const { createWeaponHud } = await import('../../src/weapons/hud.js');
const { onRoadSurface, buildingAt, inWater } = await import('../../src/citymodel.js');
const fs = await import('node:fs');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');

let pass = 0;
let total = 0;
const fails = [];
const VERBOSE = process.argv.includes('-v');
function ok(cond, msg) {
  total++;
  if (VERBOSE) console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (cond) pass++;
  else fails.push(msg);
}

let clock = 0;
const now = () => clock;
const FRAME = 1 / 60;

function mockActor(id, x, z, yaw = 0, { kind = 'pedestrian', y = 0 } = {}) {
  const handlers = {};
  const anim = {
    state: 'idle',
    triggers: [],
    args: [],
    trigger(name, arg) {
      this.triggers.push(name);
      this.args.push(arg);
      return true;
    },
    hitStop() {},
    on(evt, cb) {
      (handlers[evt] ||= []).push(cb);
      return () => handlers[evt].splice(handlers[evt].indexOf(cb), 1);
    },
    emit(evt, arg) {
      for (const cb of handlers[evt] || []) cb(arg);
    },
    count(name) {
      return this.triggers.filter((t) => t === name).length;
    },
  };
  const body = {
    impulses: [],
    settle: { settled: false, clearToStand: false },
    knockdown(imp) {
      this.impulses.push(imp);
    },
    settleCheck() {
      return this.settle;
    },
    standUp() {},
  };
  return { id, kind, pos: { x, y, z }, yaw, hp: 100, maxHp: 100, anim, body, faction: kind === 'player' ? 'player' : 'civilian' };
}

// 事件紀錄 bus
function recBus() {
  const bus = createBus();
  const log = [];
  for (const n of ['weapon:equip', 'weapon:swing', 'weapon:fire', 'weapon:dryFire', 'weapon:reload', 'weapon:ammo', 'weapon:impact', 'pickup:ammo']) {
    bus.on(n, (p) => log.push({ n, p }));
  }
  const of = (n) => log.filter((e) => e.n === n).map((e) => e.p);
  return { bus, log, of };
}

// 假 raycast：actor = 球（胸口 pos.y + 1.2、半徑 0.4）、牆 = 平面 { axis, v, surface }；回傳最近命中
function mockRaycast(actors, walls = []) {
  const f = (o, d, maxDist, opts = {}) => {
    f.calls++;
    let best = null;
    let bt = maxDist;
    for (const a of actors) {
      if (a === opts.excludeActor) continue;
      const cx = a.pos.x - o.x;
      const cy = a.pos.y + 1.2 - o.y;
      const cz = a.pos.z - o.z;
      const tc = cx * d.x + cy * d.y + cz * d.z;
      if (tc < 0) continue;
      const d2 = cx * cx + cy * cy + cz * cz - tc * tc;
      const r = 0.4;
      if (d2 > r * r) continue;
      const t = tc - Math.sqrt(r * r - d2);
      if (t >= 0 && t < bt) {
        bt = t;
        best = { actor: a, surface: 'actor', n: null };
      }
    }
    for (const w of walls) {
      const dv = d[w.axis];
      if (Math.abs(dv) < 1e-9) continue;
      const t = (w.v - o[w.axis]) / dv;
      if (t >= 0 && t < bt) {
        bt = t;
        const n = { x: 0, y: 0, z: 0 };
        n[w.axis] = -Math.sign(dv);
        best = { actor: null, surface: w.surface || 'world', n };
      }
    }
    if (!best) return null;
    return { point: { x: o.x + d.x * bt, y: o.y + d.y * bt, z: o.z + d.z * bt }, normal: best.n, actor: best.actor, surface: best.surface };
  };
  f.calls = 0;
  return f;
}

// 假 sweep：幾何版（線段 from–to 與目標直立膠囊（腳底 → 1.8 m、半徑 0.3）的最近距離 < radius + 0.3）
function segDist2(ax, ay, az, bx, by, bz, px, py, pz) {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const l2 = dx * dx + dy * dy + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + dx * t - px;
  const qy = ay + dy * t - py;
  const qz = az + dz * t - pz;
  return qx * qx + qy * qy + qz * qz;
}
function geoSweep(actors) {
  const f = (from, to, radius, opts = {}) => {
    f.calls.push({ t: clock, from: { ...from }, to: { ...to } });
    const out = [];
    for (const a of actors) {
      if (a === opts.excludeActor) continue;
      // 目標膠囊中軸取樣
      let min = Infinity;
      for (let h = 0.3; h <= 1.5; h += 0.3) min = Math.min(min, segDist2(from.x, from.y, from.z, to.x, to.y, to.z, a.pos.x, a.pos.y + h, a.pos.z));
      if (Math.sqrt(min) < radius + 0.3) out.push(a);
    }
    return out;
  };
  f.calls = [];
  return f;
}

function setup({ touch = false, settingsVals = {}, manifest = null, walls = [], peds = [], playAnim = null, sweepFn = null, wrapRay = null } = {}) {
  clock = 0;
  const combat = new CombatSystem({ now });
  const pa = mockActor('player', 0, 0, 0, { kind: 'player' });
  combat.register(pa);
  for (const p of peds) combat.register(p);
  const { bus, of, log } = recBus();
  const raw = mockRaycast([pa, ...peds], walls);
  const raycast = wrapRay ? wrapRay(raw) : raw;
  const sweep = sweepFn || geoSweep([pa, ...peds]);
  const settings = { get: (k) => settingsVals[k] };
  const player = { actor: pa, punch: () => combat.requestPunch(pa) };
  const w = createWeapons({ bus, combat, player, raycast, sweep, settings, now, isTouch: touch, manifest, playAnim });
  const step = (sec, aim = null, each = null) => {
    const n = Math.round(sec / FRAME);
    for (let i = 0; i < n; i++) {
      clock += FRAME;
      if (each) each(i);
      w.update(FRAME, aim);
      combat.update(FRAME);
    }
  };
  return { combat, pa, bus, of, log, raycast, sweep, settings, w, step };
}

// 玩家面向 +Z 的鏡頭瞄準：鏡頭在玩家後上方，射線朝 +Z（可指定目標點）
function aimAt(tx, ty, tz, { origin = { x: 0.45, y: 1.6, z: -1.6 }, aiming = true, candidates = null, muzzle = null } = {}) {
  const d = { x: tx - origin.x, y: ty - origin.y, z: tz - origin.z };
  const l = Math.hypot(d.x, d.y, d.z);
  return { origin, dir: { x: d.x / l, y: d.y / l, z: d.z / l }, aiming, candidates, muzzle };
}

// ---------- 0. 定義常數 ----------
{
  const B = WEAPONS.bat;
  const P = WEAPONS.pistol;
  ok(SLOT_IDS.join() === 'fist,bat,pistol', '三槽 0 空手 / 1 球棒 / 2 手槍');
  ok(B.damage === 35 && B.cooldown === 0.75 && B.hitWindow[0] === 0.3 && B.hitWindow[1] === 0.55, '球棒：傷害 35、冷卻 0.75 s、命中窗退路 [0.3, 0.55]');
  ok(P.damage === 40 && P.magSize === 12 && P.startReserve === 36 && P.reserveMax === 120 && P.fireInterval === 0.22 && P.reloadSec === 1.4 && P.range === 80,
    '手槍：傷害 40、彈匣 12、備彈 36 / 上限 120、射速 0.22 s、裝填 1.4 s、射程 80 m');
  ok(EQUIP_SEC === 0.3 && SWITCH_AT === 0.8, 'equip 0.3 s、攻擊收尾 80% 可切');
  ok(KNOCKDOWN_RULES.bat.hits === 2 && KNOCKDOWN_RULES.pistol.hits === 2 && KNOCKDOWN_RULES.pistol.window === 1.5 && KNOCKDOWN_RULES.fist.hits === 3, '擊倒門檻：棒 2 下、槍 1.5 s 內 2 發、拳 3 下');
}

// ---------- 1. 三槽狀態機 ----------
{
  const S1 = setup();
  const { w, of, step, pa } = S1;
  ok(w.current === 'fist' && w.slot === 0 && w.state === 'idle' && w.canSwitch(), '初始：空手、idle、可切');
  ok(w.select(0) === false && of('weapon:equip').length === 0, '選目前的槽 → false，不發事件');
  ok(w.select(3) === false && w.select(-1) === false && w.select(1.5) === false, '非法槽位 → false');
  ok(w.select(1) === true && w.current === 'bat' && w.state === 'equipping', 'select(1) → 球棒、equipping');
  const eq = of('weapon:equip')[0];
  ok(eq && eq.slot === 1 && eq.weapon === 'bat' && eq.prev === 'fist', `weapon:equip { slot 1, weapon bat, prev fist }`);
  ok(w.attack() === false, 'equip 期間不能攻擊');
  ok(w.select(2) === false && w.canSwitch() === false && w.current === 'bat' && w.pending === 2, 'equip 期間不能立即切，請求排隊（pending 2）');
  ok(w.select(1) === false && w.pending === -1, '再選回目前的槽 → 取消排隊');
  step(0.2);
  ok(w.state === 'equipping' && w.attack() === false, 'equip 0.2 s 仍在 equipping');
  step(0.12);
  ok(w.state === 'idle' && w.canSwitch(), 'equip 0.3 s 後 idle、可切');
  // 攻擊中 < 80% 不能切、≥ 80% 可切（球棒動作 = max(冷卻 0.75, clip 0.7) = 0.75 s）
  ok(w.attack() === true && w.state === 'attacking', '揮棒 → attacking');
  step(0.5);
  ok(!w.canSwitch() && w.select(2) === false && w.current === 'bat' && w.pending === 2, '揮擊 0.5 s（67%）不能立即切，請求排隊');
  w.select(1); // 取消排隊（排隊套用另見 tools/test/weapon-switch-hint.mjs）
  step(0.15);
  ok(w.canSwitch(), `揮擊 0.65 s（≥ 80% = ${(0.75 * SWITCH_AT).toFixed(2)} s）可切`);
  ok(w.cycle() === true && w.current === 'pistol', 'cycle：球棒 → 手槍');
  step(0.35);
  ok(w.cycle() === true && w.current === 'fist', 'cycle：手槍 → 空手（循環）');
  const evs = of('weapon:equip');
  ok(evs.length === 3 && evs[2].prev === 'pistol' && evs[2].slot === 0, '三次 equip 事件，prev 正確');
  // 受擊硬直中不能攻擊
  step(0.35);
  S1.combat.applyHit({ attacker: null, target: pa, damage: 1, weapon: 'fist', dir: { x: 0, z: 1 } });
  ok(w.attack() === false, '受擊硬直中不能攻擊');
}

// ---------- 2. 球棒：命中窗、同一揮去重、a / b 交替、擊倒門檻、倒地中不受擊 ----------
{
  const b = mockActor('b', 0, 1.0, Math.PI); // 正前方 1 m、面向玩家
  const anims = [];
  const man = {
    clips: [{ name: 'bat_swing_a', duration: 0.8 }, { name: 'bat_swing_b', duration: 0.6 }],
    events: { bat_swing_a: { hitWindow: [0.2, 0.4] } },
  };
  const S = setup({ peds: [b], manifest: man, playAnim: (n) => (anims.push(n), undefined) });
  const { w, of, step, combat, sweep } = S;
  w.select(1);
  step(0.35);
  const hits = [];
  combat.on('hit', (e) => hits.push(e));
  const kds = [];
  combat.on('knockdown', (e) => kds.push(e));
  const tSwing = clock;
  ok(w.attack() === true, '揮棒成功');
  ok(anims.includes('bat_swing_a'), '第一揮播 bat_swing_a');
  const sw = of('weapon:swing')[0];
  ok(sw && sw.weapon === 'bat' && sw.byPlayer === true && Number.isFinite(sw.x), 'weapon:swing { weapon bat, byPlayer, x,y,z }');
  // 命中窗 manifest [0.2, 0.4] s：0.2 s 前不掃掠
  step(0.15);
  ok(sweep.calls.length === 0 && b.hp === 100, '命中窗開啟前不掃掠、不計傷');
  step(0.3);
  const inWin = sweep.calls.filter((c) => c.t >= tSwing + 0.2 - 1e-9 && c.t <= tSwing + 0.4 + FRAME).length;
  ok(sweep.calls.length > 5 && inWin === sweep.calls.length, `命中窗內每幀掃掠（${sweep.calls.length} 次，全在窗內）`);
  ok(b.hp === 100 - 35 && hits.length === 1, `同一揮多幀碰到同一人只傷一次（hp=${b.hp}、hit ${hits.length}）`);
  const h = hits[0];
  ok(h.weapon === 'bat' && h.side === 'front' && h.byPlayer === true && h.knockdown === false && Number.isFinite(h.x) && Number.isFinite(h.y) && Number.isFinite(h.z) && Math.abs(h.dirZ - 1) < 1e-6,
    `combat 'hit' { weapon bat, side front, byPlayer, knockdown false, x,y,z, dir }`);
  ok(b.anim.args.at(-1) && b.anim.args.at(-1).side === 'front', "anim.trigger('hit', { side: 'front' })");
  // 冷卻 0.75 s 內不能再揮
  ok(w.attack() === false, '冷卻中不能再揮');
  step(0.35);
  // b 在硬直（0.45 s）已過；第二揮 bat_swing_b（無 events → [0.3, 0.55] × 0.6 s）
  ok(w.attack() === true && anims.filter((n) => n.startsWith('bat_swing')).join() === 'bat_swing_a,bat_swing_b', '揮擊交替 a / b');
  step(0.6);
  ok(kds.length === 1 && kds[0].cause === 'bat' && kds[0].weapon === 'bat' && combat.stateOf(b) === 'knockdown', `4 s 內第 2 下 → 擊倒 cause 'bat'（${kds.length}）`);
  const pk = pedKnockdownPayload(kds[0]);
  ok(pk && pk.cause === 'bat' && pk.weapon === 'bat' && pk.byPlayer === true, 'ped:knockdown 轉換帶 cause bat / weapon');
  const hpDown = b.hp;
  step(0.3);
  w.attack();
  step(0.8);
  ok(b.hp === hpDown && kds.length === 1, '倒地中再揮不受擊、不重複擊倒');
  const tm = batTiming(man, 'bat_swing_b');
  const tm2 = batTiming(null, 'bat_swing_a');
  ok(Math.abs(tm.open - 0.18) < 1e-9 && Math.abs(tm.close - 0.33) < 1e-9 && Math.abs(tm2.open - 0.21) < 1e-9 && Math.abs(tm2.close - 0.385) < 1e-9,
    'batTiming：缺 events → [0.3, 0.55] × clip 長度；缺 clip → 預設 0.7 s');
  const tm3 = batTiming(man, 'bat_swing_a');
  ok(tm3.open === 0.2 && tm3.close === 0.4 && tm3.duration === 0.8, 'batTiming：讀 manifest events.bat_swing_a.hitWindow');
}

// ---------- 2b. 球棒：程序揮擊弧只打前方、背後打不到；每揮對兩人各傷一次；hp 歸零擊倒 ----------
{
  const front = mockActor('f', 0.3, 0.9);
  const left = mockActor('l', -0.8, 0.5);
  const back = mockActor('bk', 0, -1.0);
  const S = setup({ peds: [front, left, back] });
  const { w, step, combat } = S;
  w.select(1);
  step(0.35);
  w.attack();
  step(0.8);
  ok(front.hp === 65 && left.hp === 65 && back.hp === 100, `程序揮擊弧：前方 / 左前各傷一次、背後不中（${front.hp}/${left.hp}/${back.hp}）`);
  const g = { x: 0, y: 0, z: 0 };
  const t = { x: 0, y: 0, z: 0 };
  batArc({ x: 0, y: 0, z: 0 }, 0, 0, false, g, t);
  const startRight = t.x < 0; // 右方 = −X（yaw 0）
  batArc({ x: 0, y: 0, z: 0 }, 0, 1, false, g, t);
  const endLeft = t.x > 0;
  ok(startRight && endLeft && Math.abs(Math.hypot(t.x - g.x, t.z - g.z) - WEAPONS.bat.length) < 1e-9, 'batArc：a 揮由右往左、棒長 0.85 m');
  // hp 歸零：一下就倒（非 recoverOnKo → dying）
  const weak = mockActor('weak', 0, 1.0);
  weak.hp = 30;
  combat.register(weak);
  const kd = [];
  combat.on('knockdown', (e) => kd.push(e));
  const r = combat.applyHit({ attacker: S.pa, target: weak, damage: 35, weapon: 'bat', dir: { x: 0, z: 1 } });
  ok(r && r.knockdown && weak.hp === 0 && kd.length === 1 && kd[0].cause === 'bat', 'hp 歸零 → 單下擊倒');
  // 揮棒者被打斷（受擊硬直）→ 這一揮取消
  const c2 = mockActor('c2', 0, 1.0);
  const S2 = setup({ peds: [c2] });
  S2.w.select(1);
  S2.step(0.35);
  S2.w.attack();
  S2.step(0.1);
  S2.combat.applyHit({ attacker: c2, target: S2.pa, damage: 5, weapon: 'fist', dir: { x: 0, z: -1 } });
  S2.step(0.6);
  ok(c2.hp === 100 && S2.pa.hp === 95, '揮擊中被打（硬直）→ 命中窗取消');
  ok(S2.w.attack() === false || S2.combat.stateOf(S2.pa) !== 'hit', '硬直中不能攻擊');
}

// ---------- 3. combat.applyHit：側向判定、去重、倒地中不受擊、knockdownActor ----------
{
  clock = 0;
  const combat = new CombatSystem({ now });
  const att = mockActor('att', 0, 0, 0, { kind: 'player' });
  const tFace = mockActor('tf', 0, 2, Math.PI); // 面向攻擊者
  const tBack = mockActor('tb', 0, 4, 0); // 背對攻擊者（面向 +Z，攻擊方向 +Z）
  for (const a of [att, tFace, tBack]) combat.register(a);
  const hits = [];
  combat.on('hit', (e) => hits.push(e));
  combat.applyHit({ attacker: att, target: tFace, damage: 10, weapon: 'bat', dir: { x: 0, z: 1 } });
  combat.applyHit({ attacker: att, target: tBack, damage: 10, weapon: 'bat', dir: { x: 0, z: 1 } });
  ok(hits[0].side === 'front' && hits[1].side === 'back', `側向：迎面 front、背後 back（${hits[0].side}/${hits[1].side}）`);
  ok(hitSide(0, 0, 1) === 'back' && hitSide(Math.PI, 0, 1) === 'front' && hitSide(Math.PI / 2, 1, 0) === 'back' && hitSide(Math.PI / 2, 0, 1) === 'front',
    'hitSide 純函式：面向 · 攻擊方向 > 0 = back（側面 90° 算 front）');
  ok(tBack.anim.args.at(-1).side === 'back', "背後受擊 anim.trigger('hit', { side: 'back' })");
  // swingId 去重（子彈：同一發只打一次）
  clock += 1;
  const sid = combat.newSwingId();
  const r1 = combat.applyHit({ attacker: att, target: tFace, damage: 40, weapon: 'pistol', dir: { x: 0, z: 1 }, swingId: sid });
  clock += 0.5;
  const r2 = combat.applyHit({ attacker: att, target: tFace, damage: 40, weapon: 'pistol', dir: { x: 0, z: 1 }, swingId: sid });
  ok(r1 && r2 === null && tFace.hp === 50, `同一 swingId 對同一人只計一次（hp=${tFace.hp}）`);
  // 手槍 1.5 s 內 2 發擊倒；間隔 > 1.5 s 不倒
  clock += 5;
  combat.update(0);
  const p1 = mockActor('p1', 0, 3);
  const p2 = mockActor('p2', 0, 3);
  p1.maxHp = p1.hp = 200;
  p2.maxHp = p2.hp = 200;
  combat.register(p1);
  combat.register(p2);
  const kds = [];
  combat.on('knockdown', (e) => kds.push(e));
  combat.applyHit({ attacker: att, target: p1, damage: 40, weapon: 'pistol', dir: { x: 0, z: 1 }, swingId: combat.newSwingId() });
  clock += 1.2;
  combat.update(0);
  combat.applyHit({ attacker: att, target: p1, damage: 40, weapon: 'pistol', dir: { x: 0, z: 1 }, swingId: combat.newSwingId() });
  ok(kds.length === 1 && kds[0].target === p1 && kds[0].cause === 'bullet', '手槍 1.2 s 內 2 發 → 擊倒 cause bullet');
  combat.applyHit({ attacker: att, target: p2, damage: 40, weapon: 'pistol', dir: { x: 0, z: 1 }, swingId: combat.newSwingId() });
  clock += 1.6;
  combat.update(0);
  const r3 = combat.applyHit({ attacker: att, target: p2, damage: 40, weapon: 'pistol', dir: { x: 0, z: 1 }, swingId: combat.newSwingId() });
  ok(kds.length === 1 && r3 && !r3.knockdown && p2.hp === 120, '手槍 2 發間隔 1.6 s → 不倒');
  // 倒地中不受擊
  ok(combat.applyHit({ attacker: att, target: p1, damage: 40, weapon: 'pistol', dir: { x: 0, z: 1 } }) === null && p1.hp === 120, '倒地中 applyHit → null、不扣血');
  // 混合武器不互相湊數：1 拳 + 1 棒 不倒（棒門檻只數棒）
  clock += 5;
  combat.update(0);
  const m = mockActor('m', 0, 3);
  combat.register(m);
  combat.applyHit({ attacker: att, target: m, damage: 1, weapon: 'fist', dir: { x: 0, z: 1 } });
  clock += 0.5;
  combat.update(0);
  const r4 = combat.applyHit({ attacker: att, target: m, damage: 1, weapon: 'bat', dir: { x: 0, z: 1 } });
  ok(r4 && !r4.knockdown, '1 拳 + 1 棒不湊成棒的 2 下');
  // 未知武器 / 未註冊 / untargetable
  ok(combat.applyHit({ attacker: att, target: m, damage: 5, weapon: 'laser' }) === null, '未知武器 → null');
  ok(combat.applyHit({ attacker: att, target: mockActor('x', 0, 0), damage: 5, weapon: 'bat' }) === null, '未註冊目標 → null');
  // 子彈打到 recoverOnKo 行人 hp 歸零 → dying（不回滿）；棒擊 → 起身回滿
  clock += 5;
  combat.update(0);
  const rk = mockActor('rk', 0, 3);
  rk.recoverOnKo = true;
  rk.hp = 30;
  const rb = mockActor('rb', 0, 3);
  rb.recoverOnKo = true;
  rb.hp = 30;
  combat.register(rk);
  combat.register(rb);
  const dead = [];
  combat.on('dead', (e) => dead.push(e.target));
  combat.applyHit({ attacker: att, target: rk, damage: 40, weapon: 'pistol', dir: { x: 0, z: 1 } });
  combat.applyHit({ attacker: att, target: rb, damage: 40, weapon: 'bat', dir: { x: 0, z: 1 } });
  rk.body.settle = rb.body.settle = { settled: true, clearToStand: true };
  for (let i = 0; i < 11 * 60; i++) {
    clock += FRAME;
    combat.update(FRAME);
  }
  ok(dead.includes(rk) && !dead.includes(rb) && rb.hp === rb.maxHp, 'recoverOnKo：棒擊歸零起身回滿；槍擊歸零 → dead');
  // knockdownActor：不發事件（預設）、可發事件、倒地中回 false
  clock += 1;
  const kdA = mockActor('kdA', 5, 5);
  combat.register(kdA);
  const n0 = kds.length;
  ok(combat.knockdownActor(kdA, { cause: 'fall' }) === true && combat.stateOf(kdA) === 'knockdown' && kds.length === n0 && kdA.body.impulses.length === 0 && kdA.anim.count('knockdown') === 1,
    'knockdownActor：進 knockdown、預設不發事件、沒給 impulse 不推剛體');
  ok(combat.knockdownActor(kdA) === false, 'knockdownActor：已倒地 → false');
  const kdB = mockActor('kdB', 5, 5);
  combat.register(kdB);
  combat.knockdownActor(kdB, { cause: 'eject', impulse: { x: 1, y: 0, z: 0 }, emit: true });
  ok(kds.length === n0 + 1 && kds.at(-1).cause === 'eject' && kdB.body.impulses.length === 1, 'knockdownActor emit: true → 發 knockdown、推剛體');
  kdB.body.settle = { settled: true, clearToStand: true };
  for (let i = 0; i < 2 * 60; i++) {
    clock += FRAME;
    combat.update(FRAME);
  }
  ok(combat.stateOf(kdB) === 'getup', 'knockdownActor 後照常 settle → getup');
}

// ---------- 4. 手槍：瞄點、遮擋、彈藥、裝填、空槍、後座 ----------
{
  const ped = mockActor('ped', 0, 10, Math.PI);
  const S = setup({ peds: [ped], settingsVals: { recoil: 0.5 } });
  const { w, of, step, combat } = S;
  w.select(2);
  step(0.35);
  const a0 = w.ammo();
  ok(a0.mag === 12 && a0.magSize === 12 && a0.reserve === Infinity, 'ammo() 12 / 12 / ∞（infiniteAmmo）');
  const hits = [];
  combat.on('hit', (e) => hits.push(e));
  const aim = aimAt(0, 1.2, 10);
  ok(w.attack(aim) === true, '開槍成功');
  const fire = of('weapon:fire')[0];
  ok(fire && fire.weapon === 'pistol' && fire.hit === true && fire.byPlayer === true && Number.isFinite(fire.dirX) && fire.dirZ > 0.9, `weapon:fire { hit true, dir ≈ +Z }`);
  ok(ped.hp === 60 && hits[0] && hits[0].weapon === 'pistol' && Math.abs(hits[0].z - (10 - 0.4)) < 0.1, `命中行人 → applyHit 40（hp=${ped.hp}）、hit 點在身體表面`);
  ok(w.ammo().mag === 11 && of('weapon:ammo').at(-1).mag === 11, 'mag 12 → 11，發 weapon:ammo');
  const k = w.recoilKick();
  ok(k.pitch < 0 && Math.abs(k.pitch - WEAPONS.pistol.recoilPitch * 0.5) < 1e-9 && Math.abs(k.yaw) <= WEAPONS.pistol.recoilYaw * 0.5 + 1e-12, `後座 pitch ${k.pitch.toFixed(4)} = −0.035 × recoil 0.5`);
  const k2 = w.recoilKick();
  ok(k2.pitch === 0 && k2.yaw === 0, 'recoilKick 讀後歸零');
  ok(w.attack(aim) === false, '射速：0.22 s 內不能再開');
  step(0.1);
  ok(w.attack(aim) === false, '0.1 s 仍不能開');
  step(0.13);
  ok(w.attack(aim) === true, '0.23 s 後可以開（半自動按住連發）');
  // 遮擋：鏡頭射線打到行人，但槍口 → 瞄點被牆擋（牆在 z = 5，只擋槍口那條：用 muzzle 從牆後）
  const S2 = setup({ peds: [mockActor('p2', 0, 10, Math.PI)], walls: [{ axis: 'x', v: 0.3, surface: 'world' }] });
  S2.w.select(2);
  S2.step(0.35);
  // 鏡頭在 x = 0.1（牆左側）直視行人；槍口在 x = 0.5（牆右側）→ 槍口到瞄點要穿過 x = 0.3 的牆
  const occAim = aimAt(0, 1.2, 10, { origin: { x: 0.1, y: 1.2, z: -2 }, muzzle: { x: 0.5, y: 1.3, z: 0.4 } });
  S2.w.attack(occAim);
  const imp = S2.of('weapon:impact')[0];
  const f2 = S2.of('weapon:fire')[0];
  ok(imp && imp.surface === 'world' && Math.abs(imp.x - 0.3) < 1e-6 && f2.hit === false && S2.combat.entries.get('p2').actor.hp === 100,
    '槍口確認遮擋：打在牆上（weapon:impact world、hit false、行人無傷）');
  ok(imp && imp.nx === 1, 'impact 法線朝槍口（槍口在牆 +X 側）');
  // 打車：surface vehicle
  const S3 = setup({ walls: [{ axis: 'z', v: 6, surface: 'vehicle' }] });
  S3.w.select(2);
  S3.step(0.35);
  S3.w.attack(aimAt(0.2, 1.3, 20));
  ok(S3.of('weapon:impact')[0] && S3.of('weapon:impact')[0].surface === 'vehicle', '打到車 → weapon:impact surface vehicle');
  // 打空（射程內無物）：無 impact、hit false
  const S4 = setup();
  S4.w.select(2);
  S4.step(0.35);
  S4.w.attack(aimAt(0, 30, 100));
  ok(S4.of('weapon:impact').length === 0 && S4.of('weapon:fire')[0].hit === false, '打空 → 無 impact、hit false');
  // 彈匣打空 → 自動裝填一次；裝填中不能射、不能切；1.4 s 後 mag 12（備彈無限）
  let shots = 0;
  for (let i = 0; i < 12; i++) {
    if (S4.w.attack(aimAt(0, 30, 100))) shots++;
    S4.step(0.25);
  }
  ok(shots === 11 && S4.w.ammo().mag === 0, `連開打空彈匣（本段 ${shots} 發 + 先前 1 發）`);
  ok(S4.w.state === 'reloading' && S4.of('weapon:reload')[0].phase === 'start', '打空 → 自動裝填（weapon:reload start）');
  ok(S4.w.attack(aimAt(0, 30, 100)) === false && S4.w.select(0) === false && !S4.w.canSwitch() && S4.w.pending === 0, '裝填中不能射、不能立即切（排隊）');
  S4.w.select(2); // 取消排隊
  const rp = S4.w.reloadProgress();
  ok(rp > 0 && rp < 1, `reloadProgress ${rp.toFixed(2)}`);
  S4.step(1.45);
  const re = S4.of('weapon:reload').at(-1);
  ok(re.phase === 'end' && re.mag === 12 && re.reserve === Infinity && S4.w.state === 'idle', `裝填完成：12 / ∞（${re.mag} / ${re.reserve}）`);
  // 手動裝填：滿彈匣 → false；開 1 發後可裝
  ok(S4.w.reload() === false, '滿彈匣不能裝填');
  S4.w.attack(aimAt(0, 30, 100));
  S4.step(0.25);
  ok(S4.w.reload() === true && S4.w.state === 'reloading', '開 1 發後 reload() 可裝');
  S4.step(1.5);
  ok(S4.w.ammo().mag === 12 && S4.w.ammo().reserve === Infinity, '手動裝填 11 → 12 / ∞');
  // 無備彈：空彈匣 → dryFire（節流）——有限備彈路徑：建立時關掉 infiniteAmmo（旗標於 createWeapons 時讀取）
  WEAPONS.pistol.infiniteAmmo = false;
  const S5 = setup();
  WEAPONS.pistol.infiniteAmmo = true;
  S5.w.select(2);
  S5.step(0.35);
  S5.w.restore({ slot: 2, ammo: { pistol: { mag: 1, reserve: 0 } } });
  S5.w.attack(aimAt(0, 30, 100));
  S5.step(0.25);
  ok(S5.w.state === 'idle' && S5.w.ammo().mag === 0, '最後一發：無備彈 → 不自動裝填');
  for (let i = 0; i < 10; i++) {
    S5.w.attack(aimAt(0, 30, 100));
    S5.step(0.05);
  }
  const dry = S5.of('weapon:dryFire');
  ok(dry.length >= 1 && dry.length <= Math.ceil(0.5 / DRY_FIRE_INTERVAL) + 1 && dry[0].weapon === 'pistol', `無備彈 → weapon:dryFire（0.5 s 內 ${dry.length} 次，節流）`);
  ok(S5.w.reload() === false, '無備彈不能裝填');
  // 撿到彈藥：空彈匣持手槍 → 自動裝填
  ok(S5.w.addAmmo(12) === 12 && S5.w.state === 'reloading', 'addAmmo(12) 空彈匣 → 自動裝填');
  S5.step(1.5);
  ok(S5.w.ammo().mag === 12 && S5.w.ammo().reserve === 0, '裝填後 12 / 0');
  ok(S5.w.addAmmo(500) === 120 && S5.w.ammo().reserve === 120 && S5.w.addAmmo(5) === 0, '備彈上限 120');
  ok(S5.w.addAmmo(-3) === 0 && S5.w.addAmmo(NaN) === 0, 'addAmmo 非正數忽略');
  // 裝填中被打倒 → 取消
  S5.w.attack(aimAt(0, 30, 100));
  S5.step(0.25);
  S5.w.reload();
  S5.combat.knockdownActor(S5.pa);
  S5.step(0.1);
  const last = S5.of('weapon:reload').at(-1);
  ok(S5.w.state === 'idle' && last.phase === 'end' && last.mag === 11, '裝填中被打倒 → 取消（彈藥不變）');
  // 無限備彈（fix1-P4）：連射超過原備彈總量（12 + 36）仍可射；彈匣打完需換彈、換彈後回滿；不會 dryFire；addAmmo 回 0
  const SInf = setup();
  SInf.w.select(2);
  SInf.step(0.35);
  let fired = 0;
  let mustReload = true;
  let refill = true;
  for (let i = 0; i < 400 && fired < 100; i++) {
    const magBefore = SInf.w.ammo().mag;
    if (SInf.w.attack(aimAt(0, 30, 100))) fired++;
    else if (magBefore === 0 && SInf.w.state !== 'reloading') mustReload = false;
    if (SInf.w.ammo().mag === 0) {
      if (SInf.w.state !== 'reloading' && SInf.w.attack(aimAt(0, 30, 100))) mustReload = false; // 空彈匣不可能直接開槍
      SInf.step(0.25);
      if (SInf.w.state !== 'reloading' || SInf.w.attack(aimAt(0, 30, 100))) mustReload = false; // 打空 → 自動裝填、裝填中不能射
      SInf.step(1.45);
      if (SInf.w.ammo().mag !== 12) refill = false;
    } else SInf.step(0.25);
  }
  const n0 = WEAPONS.pistol.magSize + WEAPONS.pistol.startReserve;
  ok(fired === 100 && fired > n0 && SInf.w.ammo().reserve === Infinity, `無限備彈：連射 ${fired} 發（> 原總量 ${n0}）仍可射、reserve ∞`);
  ok(mustReload && refill && SInf.of('weapon:reload').filter((e) => e.phase === 'end').length >= 8, '無限備彈：彈匣打完必經裝填（裝填中不能射）、換彈後彈匣回滿 12');
  ok(SInf.of('weapon:dryFire').length === 0 && SInf.w.addAmmo(12) === 0 && SInf.w.ammo().reserve === Infinity, '無限備彈：不再 dryFire、addAmmo 回 0（不跳拾取提示）');
  SInf.w.attack(aimAt(0, 30, 100));
  SInf.step(0.25);
  ok(SInf.w.reload() === true && SInf.w.state === 'reloading', '無限備彈：非空彈匣仍可按 R 換彈');
  SInf.step(1.5);
  ok(SInf.w.ammo().mag === 12 && SInf.w.reload() === false, '無限備彈：手動換彈後 12、滿彈匣不能再換');
  // 手槍 2 發 1.5 s 內擊倒行人（實際射擊流程）
  const tgt = mockActor('tgt', 0, 8, Math.PI);
  tgt.maxHp = tgt.hp = 200;
  const S6 = setup({ peds: [tgt] });
  S6.w.select(2);
  S6.step(0.35);
  const kd6 = [];
  S6.combat.on('knockdown', (e) => kd6.push(e));
  S6.w.attack(aimAt(0, 1.2, 8));
  S6.step(0.3);
  S6.w.attack(aimAt(0, 1.2, 8));
  ok(kd6.length === 1 && kd6[0].cause === 'bullet' && tgt.hp === 120, `射擊流程：0.3 s 內 2 發 → 擊倒（hp ${tgt.hp}）`);
  S6.step(0.3);
  S6.w.attack(aimAt(0, 1.2, 8));
  ok(tgt.hp === 120 && S6.of('weapon:fire').at(-1).hit === false, '倒地中再開槍不受擊（hit false）');
  // settings.recoil 缺 → 1.0
  const S7 = setup();
  S7.w.select(2);
  S7.step(0.35);
  S7.w.attack(aimAt(0, 30, 100));
  ok(Math.abs(S7.w.recoilKick().pitch - WEAPONS.pistol.recoilPitch) < 1e-9, 'settings.recoil 缺省 → 1.0');
  const ko = recoilKick(WEAPONS.pistol, 20, 1, 0.2, { pitch: 0, yaw: 0 });
  ok(Math.abs(ko.pitch - WEAPONS.pistol.recoilPitch * 1.5 * 0.2) < 1e-12 && Math.abs(ko.yaw - WEAPONS.pistol.recoilYaw * 0.2) < 1e-12, 'recoilKick 純函式：連射遞增上限 1.5 倍、× scale');
  // aim 省略：以玩家面向射擊
  const S8 = setup({ peds: [mockActor('fw', 0.2, 6, Math.PI)] });
  S8.w.select(2);
  S8.step(0.35);
  S8.w.attack();
  ok(S8.of('weapon:fire')[0] && S8.of('weapon:fire')[0].dirZ > 0.99, 'aim 省略 → 沿玩家面向射擊');
  // aiming 旗標
  S8.step(0.3, { ...aimAt(0, 1, 10), aiming: true });
  ok(S8.w.aiming === true, 'update(dt, aim.aiming) → weapons.aiming（持手槍）');
  S8.w.select(0);
  S8.step(0.1, { ...aimAt(0, 1, 10), aiming: true });
  ok(S8.w.aiming === false, '非手槍時 aiming 恆 false');
}

// ---------- 5. 觸控弱吸附 ----------
{
  const origin = { x: 0, y: 1.2, z: 0 };
  const dir = { x: 0, y: 0, z: 1 };
  const out = { x: 0, y: 0, z: 0 };
  const at = (deg, dist) => mockActor(`a${deg}-${dist}`, Math.sin((deg * Math.PI) / 180) * dist, Math.cos((deg * Math.PI) / 180) * dist);
  const a5 = at(5, 20);
  const a7 = at(7, 20);
  const far = at(1, 45);
  ok(pickAimAssist(origin, dir, [a7, a5], out) === a5 && out.x > 0.08, '夾角 5° → 吸附、方向修正');
  ok(pickAimAssist(origin, dir, [a7], out) === null && out.x === 0 && out.z === 1, '夾角 7° → 不吸附、方向不變');
  ok(pickAimAssist(origin, dir, [far], out) === null, `距離 45 m（> ${AIM_ASSIST_RANGE}）→ 不吸附`);
  ok(pickAimAssist(origin, dir, [a5], out, { isVisible: () => false }) === null, '被遮擋 → 不吸附');
  const a2 = at(2, 30);
  ok(pickAimAssist(origin, dir, [a5, a2], out) === a2, '多人取夾角最小');
  ok(Math.abs(AIM_ASSIST_ANGLE - (6 * Math.PI) / 180) < 1e-12 && AIM_ASSIST_RANGE === 40, '吸附門檻 6° / 40 m');
  // 整合：觸控 + aimAssist → 吸附命中；桌機或 aimAssist false → 打偏
  const mk = (touch, assist) => {
    const p = mockActor('tp', Math.sin((4 * Math.PI) / 180) * 15, Math.cos((4 * Math.PI) / 180) * 15, Math.PI);
    const S = setup({ touch, peds: [p], settingsVals: { aimAssist: assist } });
    S.w.select(2);
    S.step(0.35);
    S.w.attack({ origin: { x: 0, y: 1.2, z: 0 }, dir: { x: 0, y: 0, z: 1 }, aiming: true, candidates: [p], muzzle: { x: 0, y: 1.2, z: 0.3 } });
    return p.hp;
  };
  ok(mk(true, true) === 60, '觸控 + 瞄準輔助：4° 偏差仍命中');
  ok(mk(false, true) === 100, '桌機不吸附（打偏）');
  ok(mk(true, false) === 100, 'aimAssist 關 → 不吸附');
  // 被牆擋住的候選不吸附
  const hid = mockActor('hid', Math.sin((4 * Math.PI) / 180) * 15, Math.cos((4 * Math.PI) / 180) * 15, Math.PI);
  const SH = setup({ touch: true, peds: [hid], walls: [{ axis: 'z', v: 8 }] });
  SH.w.select(2);
  SH.step(0.35);
  SH.w.attack({ origin: { x: 0, y: 1.2, z: 0 }, dir: { x: 0, y: 0, z: 1 }, aiming: true, candidates: [hid], muzzle: { x: 0, y: 1.2, z: 0.3 } });
  ok(hid.hp === 100 && SH.of('weapon:impact').length === 1, '候選在牆後 → 不吸附、打在牆上');
}

// ---------- 6. resolveShot 純函式：鏡頭與角色之間的東西不算 ----------
{
  const pa = mockActor('pp', 0, 0);
  const wallBehind = { axis: 'z', v: -1 }; // 鏡頭（z = −2）與玩家（z = 0）之間的牆
  const ped = mockActor('rp', 0, 10);
  const rc = mockRaycast([pa, ped], [wallBehind]);
  const out = { hit: false, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, actor: null, surface: null, dir: { x: 0, y: 0, z: 0 }, dist: 0 };
  resolveShot(rc, { x: 0, y: 1.2, z: -2 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 1.2, z: 0.4 }, 80, pa, out);
  ok(out.actor === ped && out.hit && Math.abs(out.dist - (10 - 0.4 - 0.4)) < 1e-6, '鏡頭後方（鏡頭 → 槍口之間）的牆不擋、打到前方行人');
}

// ---------- 6b. 遠距 / 超射程（FX3）：鏡頭射線 → 瞄點 → 槍口射線兩段判定 ----------
// sharedRay：同 main.js 的 raycast，每次回傳同一個重用物件（第二次查詢會覆寫第一次的結果）
function sharedRay(inner) {
  const obj = { point: { x: 0, y: 0, z: 0 }, normal: null, actor: null, surface: 'world' };
  const nrm = { x: 0, y: 0, z: 0 };
  const f = (o, d, maxDist, opts) => {
    f.calls++;
    const h = inner(o, d, maxDist, opts);
    if (!h) return null;
    obj.point.x = h.point.x;
    obj.point.y = h.point.y;
    obj.point.z = h.point.z;
    if (h.normal) {
      nrm.x = h.normal.x;
      nrm.y = h.normal.y;
      nrm.z = h.normal.z;
      obj.normal = nrm;
    } else obj.normal = null;
    obj.actor = h.actor;
    obj.surface = h.surface;
    return obj;
  };
  f.calls = 0;
  return f;
}
{
  const P = WEAPONS.pistol;
  const pa = mockActor('pp', 0, 0);
  const cam = { x: 0.45, y: 1.6, z: -1.6 };
  const muzzle = { x: -0.2, y: 1.35, z: 0.45 }; // 同 defaultMuzzle（玩家面向 +Z）
  const newOut = () => ({ hit: false, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, actor: null, surface: null, dir: { x: 0, y: 0, z: 0 }, dist: 0 });
  const dirTo = (x, y, z) => {
    const l = Math.hypot(x - cam.x, y - cam.y, z - cam.z);
    return { x: (x - cam.x) / l, y: (y - cam.y) / l, z: (z - cam.z) / l };
  };
  // 射程內（41–79 m）瞄準行人中心：一般 / 重用物件兩種 raycast 都 100% 命中該行人
  for (const [label, wrap] of [['一般 raycast', (r) => r], ['重用物件 raycast', sharedRay]]) {
    let hits = 0;
    let n = 0;
    for (let d = 41; d <= 79; d += 2) {
      const ped = mockActor('far', 0, d);
      const out = newOut();
      resolveShot(wrap(mockRaycast([pa, ped])), cam, dirTo(0, 1.2, d), muzzle, P.range, pa, out);
      n++;
      if (out.hit && out.actor === ped && out.dist <= P.range) hits++;
    }
    ok(hits === n, `遠距 41–79 m 瞄準中心（${label}）：${hits} / ${n} 命中`);
  }
  // 超射程 111 m：hit false、actor null、落點在槍口前 80 m
  {
    const ped = mockActor('out', 0, 111);
    const out = newOut();
    resolveShot(mockRaycast([pa, ped]), cam, dirTo(0, 1.2, 111), muzzle, P.range, pa, out);
    const reach = Math.hypot(out.point.x - muzzle.x, out.point.y - muzzle.y, out.point.z - muzzle.z);
    ok(!out.hit && out.actor === null && Math.abs(reach - P.range) < 1e-6 && out.dist === P.range, `超射程 111 m → 未命中、落點 = 槍口前 ${reach.toFixed(2)} m`);
  }
  // 射程邊界：行人表面離槍口 ≈ 79.6 m 命中、≈ 81 m 不命中
  {
    const inR = mockActor('edgeIn', 0, 80.4);
    const o1 = newOut();
    resolveShot(mockRaycast([pa, inR]), cam, dirTo(0, 1.2, 80.4), muzzle, P.range, pa, o1);
    const outR = mockActor('edgeOut', 0, 82);
    const o2 = newOut();
    resolveShot(mockRaycast([pa, outR]), cam, dirTo(0, 1.2, 82), muzzle, P.range, pa, o2);
    ok(o1.actor === inR && o1.dist <= P.range + 0.25 && !o2.hit && o2.actor === null, `射程邊界：${o1.dist.toFixed(2)} m 命中、表面 81.6 m 不命中`);
  }
  // 遠距擦邊：瞄準行人邊緣（鏡頭射線打到、槍口射線因視差擦過）且背後 0.3 m 有牆 → 仍算打到行人，不打到牆
  {
    const ped = mockActor('graze', 0, 60);
    const wall = { axis: 'z', v: 60.3, surface: 'world' };
    let hits = 0;
    let n = 0;
    for (const ex of [0.3, 0.34, 0.37, -0.3, -0.34, -0.37]) {
      const out = newOut();
      resolveShot(sharedRay(mockRaycast([pa, ped], [wall])), cam, dirTo(ex, 1.2, 60), muzzle, P.range, pa, out);
      n++;
      if (out.actor === ped) hits++;
    }
    ok(hits === n, `遠距擦邊（背後有牆）：${hits} / ${n} 算打到行人`);
  }
  // 遠距遮擋：槍口與瞄點之間（離瞄點 > 0.1 m）的牆仍會擋
  {
    const ped = mockActor('occ', 0, 60);
    const out = newOut();
    resolveShot(sharedRay(mockRaycast([pa, ped], [{ axis: 'x', v: 0, surface: 'world' }])), { x: 0.45, y: 1.6, z: -1.6 }, dirTo(0.1, 1.2, 60), { x: -0.2, y: 1.35, z: 0.45 }, P.range, pa, out);
    // 鏡頭射線全程在 x > 0；槍口在 x = −0.2 → 穿過 x = 0 的牆
    ok(out.hit && out.actor === null && out.surface === 'world' && Math.abs(out.point.x) < 1e-6, '遠距：槍口 → 瞄點間的牆仍擋（打在牆上）');
  }
  // 射擊流程：55 m 行人（hp 1000）每 1.6 s 一發（避開 1.5 s 兩發擊倒）× 10 → 10 發全中、扣 400、無 impact
  {
    const tgt = mockActor('t55', 0, 55, Math.PI);
    tgt.maxHp = tgt.hp = 1000;
    const S = setup({ peds: [tgt], wrapRay: sharedRay });
    S.w.select(2);
    S.step(0.35);
    let fired = 0;
    for (let i = 0; i < 10; i++) {
      if (S.w.attack(aimAt(0, 1.2, 55))) fired++;
      S.step(i === 4 ? 1.8 : 1.6); // 第 5 發後彈匣仍有；中間多等一點無妨
    }
    const fires = S.of('weapon:fire');
    ok(fired === 10 && fires.length === 10 && fires.every((f) => f.hit === true && f.miss === false) && tgt.hp === 600 && S.of('weapon:impact').length === 0,
      `55 m × 10 發：命中 ${fires.filter((f) => f.hit).length} / ${fires.length}、hp ${tgt.hp}、impact ${S.of('weapon:impact').length}`);
  }
  // 射擊流程：111 m 行人 → hit false、miss true、不扣血、無 impact、落點 = 射程末端
  {
    const tgt = mockActor('t111', 0, 111, Math.PI);
    const S = setup({ peds: [tgt] });
    S.w.select(2);
    S.step(0.35);
    S.w.attack(aimAt(0, 1.2, 111));
    const f = S.of('weapon:fire')[0];
    const reach = f ? Math.hypot(f.ex - f.x, f.ey - f.y, f.ez - f.z) : 0;
    ok(f && f.hit === false && f.miss === true && tgt.hp === 100 && S.of('weapon:impact').length === 0 && Math.abs(reach - P.range) < 1e-6 && f.dist === P.range,
      `超射程 111 m 射擊：hit false、miss true、hp ${tgt.hp}、無 impact、落點 ${reach.toFixed(1)} m`);
  }
  // 倒地中的行人被打到：combat 不受理 → 在落點發 weapon:impact（不再「hit false 又沒 impact」）
  {
    const tgt = mockActor('kd', 0, 45, Math.PI);
    tgt.maxHp = tgt.hp = 500;
    const S = setup({ peds: [tgt] });
    S.w.select(2);
    S.step(0.35);
    S.w.attack(aimAt(0, 1.2, 45));
    S.step(0.3);
    S.w.attack(aimAt(0, 1.2, 45));
    S.step(0.3);
    const hp0 = tgt.hp;
    S.w.attack(aimAt(0, 1.2, 45));
    const f = S.of('weapon:fire').at(-1);
    const imp = S.of('weapon:impact');
    ok(S.combat.isDown(tgt) && tgt.hp === hp0 && f.hit === false && f.miss === false && imp.length === 1 && Math.abs(imp[0].z - f.ez) < 1e-9 && imp[0].surface === 'world',
      `倒地中被打到 → hit false、miss false、weapon:impact ${imp.length} 次（落點 z ${imp[0] ? imp[0].z.toFixed(2) : '無'}）`);
  }
}

// ---------- 7. NPC：槍聲逃跑、被槍擊不還手、被棒擊照一般被打 ----------
{
  clock = 0;
  const combat = new CombatSystem({ now });
  const player = mockActor('player', 0, 0, 0, { kind: 'player' });
  combat.register(player);
  const near = new NpcBrain({ actor: mockActor('n1', 10, 10) });
  const far = new NpcBrain({ actor: mockActor('n2', 25, 25) });
  const ctx = { combat };
  ok(near.hear({ type: 'gunshot', x: 0, z: 0 }) === true && far.hear({ type: 'gunshot', x: 0, z: 0 }) === false, `槍聲：${GUNSHOT_RADIUS} m 內記下、外（35 m）忽略`);
  near.update(FRAME, ctx);
  far.update(FRAME, ctx);
  ok(near.state === 'flee' && far.state === 'wander' && near.intent.run, '30 m 內逃跑、外面照常');
  const it = near.update(FRAME, ctx);
  ok(it.moveX > 0 && it.moveZ > 0, '逃離槍聲位置（往外跑）');
  // 勇敢的人（會還手）被槍擊 → 逃跑，不還手；被棒擊 → 還手
  let brave = null;
  let bravePed = null;
  for (let i = 0; i < 200 && !brave; i++) {
    const a = mockActor(`brave${i}`, 0, 1.0, Math.PI);
    const b = new NpcBrain({ actor: a });
    if (b.fights) {
      brave = b;
      bravePed = a;
    }
  }
  const brains = new Map([[bravePed.id, brave]]);
  combat.register(bravePed);
  wireCombatToBrains(combat, brains);
  combat.applyHit({ attacker: player, target: bravePed, damage: 35, weapon: 'bat', dir: { x: 0, z: 1 } });
  brave.update(FRAME, ctx);
  ok(brave.state === 'fight' && brave.target === player, '會還手的人被棒擊 → 還手（比例規則不變）');
  clock += 1;
  combat.update(0);
  combat.applyHit({ attacker: player, target: bravePed, damage: 10, weapon: 'pistol', dir: { x: 0, z: 1 }, swingId: combat.newSwingId() });
  brave.update(FRAME, ctx);
  ok(brave.state === 'flee', '同一人被槍擊 → 放棄還手、逃跑');
  // 還手中聽到槍聲 → 逃跑
  const f2 = new NpcBrain({ actor: mockActor('f2', 2, 0) });
  f2._startFight(player);
  f2.hear({ type: 'gunshot', x: 0, z: 0 });
  f2.update(FRAME, ctx);
  ok(f2.state === 'flee', '還手中聽到槍聲 → 放下逃跑');
  // 被槍擊倒 → 起身後逃跑（不還手）
  clock += 5;
  combat.update(0);
  let brave2 = null;
  for (let i = 0; i < 300 && !brave2; i++) {
    const b = new NpcBrain({ actor: mockActor(`b2-${i}`, 0, 1.5, Math.PI) });
    if (b.fights) brave2 = b;
  }
  brains.set(brave2.actor.id, brave2);
  combat.register(brave2.actor);
  brave2.actor.recoverOnKo = true;
  combat.applyHit({ attacker: player, target: brave2.actor, damage: 40, weapon: 'pistol', dir: { x: 0, z: 1 }, swingId: combat.newSwingId() });
  clock += 0.5;
  combat.applyHit({ attacker: player, target: brave2.actor, damage: 40, weapon: 'pistol', dir: { x: 0, z: 1 }, swingId: combat.newSwingId() });
  brave2.update(FRAME, ctx);
  const wasDown = brave2.state === 'down';
  brave2.actor.body.settle = { settled: true, clearToStand: true };
  for (let i = 0; i < 4 * 60; i++) {
    clock += FRAME;
    combat.update(FRAME);
    brave2.actor.anim.emit('finished', 'getup');
    brave2.update(FRAME, ctx);
  }
  ok(wasDown && brave2.state === 'flee', `被槍擊倒 → 起身後逃跑（${wasDown ? 'down' : '?'} → ${brave2.state}）`);
  // gunshotListeners：weapon:fire → 30 m 內 brain.hear
  const bus = createBus();
  const heard = [];
  const fake = (id, x, z) => ({ actor: { pos: { x, z } }, hear: (e) => heard.push([id, e.type, e.x, e.z]) });
  const list = [fake('a', 5, 5), fake('b', 40, 0)];
  const off = gunshotListeners(bus, () => list);
  bus.emit('weapon:fire', { weapon: 'pistol', x: 0, y: 1, z: 0 });
  ok(heard.length === 1 && heard[0][0] === 'a' && heard[0][1] === 'gunshot', 'gunshotListeners：weapon:fire → 30 m 內 brain.hear(gunshot)');
  off();
  bus.emit('weapon:fire', { weapon: 'pistol', x: 0, y: 1, z: 0 });
  ok(heard.length === 1, 'gunshotListeners 取消訂閱');
}

// ---------- 8. 模型：缺檔退回佔位、manifest 物件 / 陣列形式 ----------
{
  const infos = [];
  const errs = [];
  const oi = console.info;
  const oe = console.error;
  console.info = (m) => infos.push(m);
  console.error = (m) => errs.push(m);
  _resetWeaponModelInfo();
  const m1 = await loadWeaponModels('models/weapons/', { fetchJson: async () => null, loadGltf: async () => null });
  ok(m1.bat.placeholder && m1.pistol.placeholder && m1.bat.object.isObject3D && m1.pistol.object.isObject3D, 'manifest 缺 → 兩把都佔位幾何');
  ok(m1.bat.grip.length() === 0 && Math.abs(m1.bat.tip.y - BAT_LENGTH) < 1e-9 && m1.bat.length === 0.85 && m1.bat.muzzle === null, '佔位球棒：握把原點、棒頭 (0, 0.85, 0)');
  const box = new THREE.Box3().setFromObject(m1.bat.object);
  ok(Math.abs(box.max.y - box.min.y - 0.85) < 1e-6, '佔位球棒幾何長 0.85 m');
  ok(m1.pistol.muzzle && m1.pistol.muzzle.z > 0.15 && m1.pistol.object.children.length === 2, '佔位手槍：L 形兩方塊、槍口在 +Z');
  await loadWeaponModels('models/weapons/', { fetchJson: async () => null, loadGltf: async () => null });
  ok(infos.length === 1 && errs.length === 0, `缺檔只 console.info 一次、無 console.error（info ${infos.length}）`);
  // 預設 fetch：回退成 index.html（200 + HTML）→ 佔位
  _resetWeaponModelInfo();
  const of = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => '<!doctype html><html></html>' });
  const m2 = await loadWeaponModels();
  globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => '' });
  const m3 = await loadWeaponModels('models/weapons');
  globalThis.fetch = async () => {
    throw new Error('offline');
  };
  const m4 = await loadWeaponModels();
  globalThis.fetch = of;
  ok(m2.bat.placeholder && m3.pistol.placeholder && m4.bat.placeholder && errs.length === 0, 'fetch 回 index.html / 404 / 例外 → 佔位、不丟例外');
  // 有 manifest + glb
  const urls = [];
  const fakeScene = () => new THREE.Group();
  const man = { bat: { file: 'bat.glb', gripOffset: [0, 0.05, 0], tipOffset: [0, 0.9, 0], length: 0.9, type: 'melee' }, pistol: { file: 'pistol.glb', gripOffset: [0, 0, 0], muzzleOffset: [0, 0.08, 0.22] } };
  const m5 = await loadWeaponModels('models/weapons/', { fetchJson: async () => man, loadGltf: async (u) => (urls.push(u), fakeScene()) });
  ok(!m5.bat.placeholder && !m5.pistol.placeholder && m5.bat.tip.y === 0.9 && m5.bat.grip.y === 0.05 && m5.pistol.muzzle.z === 0.22 && m5.bat.length === 0.9, 'manifest 物件形式：讀 grip / tip / muzzle / length');
  ok(urls.every((u) => u.startsWith('./models/weapons/')), `glb 路徑依 base（${urls[0]}）`);
  const m6 = await loadWeaponModels('models/weapons/', { fetchJson: async () => [{ id: 'pistol', file: 'p.glb' }], loadGltf: async () => fakeScene() });
  ok(m6.bat.placeholder && !m6.pistol.placeholder && m6.pistol.muzzle.z > 0.15, '陣列形式：只有手槍 → 球棒佔位、手槍缺 muzzleOffset 用預設');
  const m7 = await loadWeaponModels('models/weapons/', { fetchJson: async () => man, loadGltf: async (u) => (u.endsWith('bat.glb') ? null : fakeScene()) });
  ok(m7.bat.placeholder && !m7.pistol.placeholder, 'glb 載入失敗 → 該把佔位');
  const nm = normalizeWeaponManifest({ weapons: [{ name: 'bat', file: 'x.glb' }] });
  ok(nm.bat && nm.bat.file === 'x.glb' && nm.pistol === null && normalizeWeaponManifest('garbage').bat === null, 'normalizeWeaponManifest：{ weapons: [...] } / 非物件');
  console.info = oi;
  console.error = oe;
}

// ---------- 8b. 美術實檔 manifest（public/models/weapons/manifest.json；glb 在 node 不解析，只驗正規化）----------
{
  const near = (a, b, eps = 1e-4) => Math.abs(a - b) < eps;
  const realPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../public/models/weapons/manifest.json');
  const real = JSON.parse(fs.readFileSync(realPath, 'utf8'));
  const nm = normalizeWeaponManifest(real);
  ok(nm.bat && nm.pistol && nm.bat.file === 'bat.glb' && nm.pistol.file === 'pistol.glb', '實檔 manifest：{ weapons: [...] } 取出 bat / pistol');
  const nb = normalizeWeaponEntry('bat', nm.bat);
  const np = normalizeWeaponEntry('pistol', nm.pistol);
  const q = np.socketQuaternion;
  ok(q && q.isQuaternion && near(q.x, 0.70711) && near(q.y, 0) && near(q.z, 0) && near(q.w, 0.70711), `手槍 socketQuaternion ≈ [0.70711, 0, 0, 0.70711]（${q && q.toArray().map((v) => v.toFixed(5)).join(', ')}）`);
  ok(nb.socketQuaternion.isQuaternion && nb.socketQuaternion.w === 1 && nb.socketQuaternion.x === 0, '球棒 socketQuaternion = 單位四元數');
  ok(nb.sweep && nb.sweep.radius === 0.04 && nb.sweep.from.z === 0.35 && nb.sweep.to.z === 0.75, `球棒 sweep 半徑 0.04、段 z 0.35→0.75（r ${nb.sweep && nb.sweep.radius}）`);
  ok(nb.tip.z === 0.75 && nb.length === 0.85 && nb.offHand && nb.offHand.z === 0.09 && nb.muzzle === null && nb.type === 'melee', '球棒 tip / length / offHand / muzzle null');
  ok(np.muzzle && np.muzzle.equals(np.tip) && np.muzzle !== np.tip && near(np.muzzle.z, 0.1455) && near(np.muzzle.y, 0.045) && np.sweep === null, '手槍無 muzzleOffset → 槍口 = tipOffset（複本）、sweep null');
  // 缺 sweep / socketRotation / 壞值 → 退回
  const fb = normalizeWeaponEntry('bat', { file: 'b.glb', gripOffset: [0, 0, 0], tipOffset: [0, 0, 1] });
  ok(near(fb.sweep.from.z, 0.4) && fb.sweep.to.z === 1 && fb.sweep.radius === 0.04 && fb.socketQuaternion.w === 1, '缺 sweep → grip→tip 40%–100% 段、半徑 0.04；缺 socketRotation → 單位');
  const bad = normalizeWeaponEntry('pistol', { file: 'p.glb', socketRotation: [0, 0, 0, 0], muzzleOffset: [0, 0.1, 0.3] });
  ok(bad.socketQuaternion.w === 1 && bad.muzzle.z === 0.3, '零四元數 → 單位；有 muzzleOffset 優先於 tipOffset');
  const q2 = normalizeWeaponEntry('pistol', { socketRotation: [0, 0, 2, 0] }).socketQuaternion;
  ok(q2.z === 1 && q2.w === 0, 'socketRotation 非單位長 → 正規化');
  const miss = normalizeWeaponEntry('bat', null);
  ok(miss.sweep.radius === 0.04 && near(miss.sweep.from.y, 0.34) && near(miss.sweep.to.y, 0.85), 'entry 缺 → 佔位球棒數值（+Y、40%–100%）');
  // loadWeaponModels 以實檔 manifest（假 glb）→ 帶出 socketQuaternion / sweep
  const infos = [];
  const oi = console.info;
  console.info = (m) => infos.push(m);
  _resetWeaponModelInfo();
  const mr = await loadWeaponModels('models/weapons/', { fetchJson: async () => JSON.parse(JSON.stringify(real)), loadGltf: async () => new THREE.Group() });
  ok(!mr.bat.placeholder && !mr.pistol.placeholder && near(mr.pistol.socketQuaternion.x, 0.70711) && mr.bat.sweep.radius === 0.04 && mr.pistol.object.name === 'weapon_pistol' && infos.length === 0, '實檔 manifest 載入：非佔位、帶 socketQuaternion / sweep、不提示缺檔');
  // 實檔 manifest 但 glb 缺 → 佔位（佔位幾何慣例 +Y，不套實檔 +Z 數值）、socketQuaternion 單位
  const mm = await loadWeaponModels('models/weapons/', { fetchJson: async () => JSON.parse(JSON.stringify(real)), loadGltf: async () => null });
  ok(mm.bat.placeholder && mm.pistol.placeholder && mm.bat.sweep.to.y === BAT_LENGTH && mm.pistol.socketQuaternion.w === 1 && mm.pistol.muzzle.z > 0.15 && infos.length === 1, 'glb 缺 → 佔位（sweep 沿 +Y、單位四元數）、info 一次');
  const mp = await loadWeaponModels('models/weapons/', { fetchJson: async () => null, loadGltf: async () => null });
  ok(mp.bat.sweep && mp.bat.sweep.radius === 0.04 && mp.pistol.sweep === null && mp.pistol.socketQuaternion.isQuaternion, 'manifest 缺 → 佔位也提供 sweep / socketQuaternion');
  console.info = oi;
  // makeBatSegment：掛到場景後以 sweep 世界座標填入；未掛 / 隱藏 → false
  const seg = makeBatSegment(mr.bat);
  const g = { x: 0, y: 0, z: 0 };
  const t = { x: 0, y: 0, z: 0 };
  ok(seg(g, t) === false, 'makeBatSegment：模型未掛到場景 → false（退回程序弧）');
  const scene = new THREE.Scene();
  const hand = new THREE.Group();
  hand.position.set(1, 1, 0);
  hand.rotation.y = Math.PI / 2; // 本地 +Z → 世界 +X
  scene.add(hand);
  hand.add(mr.bat.object);
  ok(seg(g, t) === true && near(g.x, 1.35) && near(g.y, 1) && near(g.z, 0) && near(t.x, 1.75), `makeBatSegment：世界座標（grip ${g.x.toFixed(2)}, tip ${t.x.toFixed(2)}）`);
  mr.bat.object.visible = false;
  ok(seg(g, t) === false, 'makeBatSegment：隱藏 → false');
  mr.bat.object.visible = true;
  ok(makeBatSegment(null)(g, t) === false && makeBatSegment(mr.pistol)(g, t) === false, 'makeBatSegment：null / 無 sweep → false');
  // 注入 createWeapons：命中窗內的掃掠段 = 模型 sweep 世界座標
  const calls = [];
  const w = createWeapons({
    player: { actor: mockActor('p', 0, 0, 0, { kind: 'player' }) },
    sweep: (a, b) => (calls.push([a.x, b.x]), []),
    getBatSegment: seg,
    playAnim: () => 0.7,
  });
  w.select(1);
  for (let i = 0; i < 30; i++) w.update(FRAME, null);
  w.attack(null);
  for (let i = 0; i < 40; i++) w.update(FRAME, null);
  ok(calls.length > 0 && near(calls[0][0], 1.35) && near(calls[0][1], 1.75), `createWeapons + makeBatSegment：掃掠用模型 sweep（${calls.length} 次）`);
}

// ---------- 9. 彈藥拾取 ----------
{
  const { bus, of } = recBus();
  const scene = new THREE.Scene();
  let allow = true;
  const pk = createAmmoPickups({ scene, bus, points: [{ x: 10, z: 0 }, { x: -10, z: 0 }], canPickup: () => allow, heightAt: () => 2 });
  ok(scene.children.length === 2 && pk.points[0].y === 2, '建立 2 個彈藥盒網格（heightAt 取高度）');
  pk.update(FRAME, { x: 10, y: 2, z: 2 });
  ok(of('pickup:ammo').length === 0, '2 m 外不拾取');
  const it = pk.nearest({ x: 10, z: 2 });
  ok(it && it.text === '撿彈藥' && Math.abs(it.dist - 2) < 1e-9 && it.priority === 0 && typeof it.act === 'function', 'nearest → interactable（3 m 內）');
  ok(pk.nearest({ x: 10, z: 4 }) === null, 'nearest 3 m 外 → null');
  pk.update(FRAME, { x: 10, y: 2, z: 1.4 });
  const ev = of('pickup:ammo')[0];
  ok(ev && ev.amount === 12 && ev.x === 10 && ev.z === 0, `進入 ${PICKUP_RADIUS} m 自動拾取 → pickup:ammo { amount 12, x, z }`);
  ok(!scene.children[0].visible && pk.markers().length === 1 && pk.markers()[0].kind === 'ammo', '拾取後隱藏、markers 剩 1（kind ammo）');
  pk.update(FRAME, { x: 10, y: 2, z: 0 });
  ok(of('pickup:ammo').length === 1, '重生前不會再撿');
  pk.update(89, null);
  ok(!pk.points[0].active, '89 s 還沒重生');
  pk.update(1.1, null);
  ok(pk.points[0].active && scene.children[0].visible, '90 s 後重生');
  allow = false;
  pk.update(FRAME, { x: -10, y: 2, z: 0 });
  ok(of('pickup:ammo').length === 1 && pk.points[1].active, 'canPickup false（備彈滿）→ 不拾取、盒子留著');
  ok(pk.nearest({ x: -10, z: 1 }) === null && pk.nearest({ x: 10, z: 1 }) === null, 'canPickup false（備彈滿）→ nearest 回 null、不顯示撿彈藥提示');
  ok(of('pickup:ammo').length === 1 && pk.points[1].active && scene.children[1].visible, '備彈滿時提示不出現、彈藥盒不被消耗');
  allow = true;
  ok(pk.nearest({ x: -10, z: 1 }).act() === true && of('pickup:ammo').length === 2, 'interactable.act() 也能撿');
  const mk = pk.markers();
  ok(pk.markers() === mk, 'markers 陣列重用');
  pk.dispose();
  ok(scene.children.length === 0, 'dispose 移除網格');
  // 同 main.js 接線：canPickup = 備彈 < 上限（120）；封頂時不提示、補到上限以下立即恢復
  {
    const PM = WEAPONS.pistol.reserveMax;
    let reserve = PM;
    const pk3 = createAmmoPickups({ bus, points: [{ x: 50, z: 0 }], canPickup: () => reserve < PM });
    const n0 = of('pickup:ammo').length;
    const full = pk3.nearest({ x: 50, z: 2 });
    pk3.update(FRAME, { x: 50, z: 0.5 });
    ok(PM === 120 && full === null && of('pickup:ammo').length === n0 && pk3.points[0].active, `備彈 ${PM}（上限）：不提示、走進 1.5 m 也不消耗`);
    reserve = PM - 1;
    const again = pk3.nearest({ x: 50, z: 2 });
    ok(again && again.text === '撿彈藥', '備彈低於上限 → 提示恢復');
    pk3.dispose();
  }
  // 無 scene（純邏輯）
  const pk2 = createAmmoPickups({ bus, points: [{ x: 0, z: 0 }], amount: 6, respawnSec: 5 });
  pk2.update(FRAME, { x: 0.5, z: 0.5 });
  ok(of('pickup:ammo').at(-1).amount === 6, '無 scene 也能拾取（amount 參數）');
  // 預設 7 點：人行道（不在車道、不在建築、不在水域）
  ok(DEFAULT_AMMO_POINTS.length === 7, '預設 7 個點位');
  const bad = DEFAULT_AMMO_POINTS.filter((p) => onRoadSurface(p.x, p.z, 0.5, false) || buildingAt(p.x, p.z, 1) || inWater(p.x, p.z, 1));
  ok(bad.length === 0, `預設點位都不在車道 / 建築 / 水域（違規 ${bad.length}）`);
  let minD = Infinity;
  for (let i = 0; i < 7; i++) for (let j = i + 1; j < 7; j++) minD = Math.min(minD, Math.hypot(DEFAULT_AMMO_POINTS[i].x - DEFAULT_AMMO_POINTS[j].x, DEFAULT_AMMO_POINTS[i].z - DEFAULT_AMMO_POINTS[j].z));
  ok(minD >= 150 && DEFAULT_AMMO_POINTS.every((p) => Math.hypot(p.x, p.z) < 700), `點位分散（最近兩點 ${minD.toFixed(0)} m）、在七期 700 m 內`);
}

// ---------- 10. 輪盤 / 長按純函式 ----------
{
  ok(LONG_PRESS_MS === 350 && isLongPress(350) && !isLongPress(349), '長按門檻 350 ms');
  ok(classifyPress(120, 3) === 'tap' && classifyPress(400, 0) === 'long' && classifyPress(200, 40) === 'none', 'classifyPress：短按 tap / 長按 long / 短按滑走 none');
  ok(wheelSlotFromVector(-80, 0) === 0 && wheelSlotFromVector(-60, -60) === 1 && wheelSlotFromVector(0, -80) === 2, '輪盤：左 = 空手、左上 = 球棒、上 = 手槍');
  ok(wheelSlotFromVector(5, -5) === -1 && wheelSlotFromVector(80, 40) === -1 && wheelSlotFromVector(NaN, 1) === -1, '死區內 / 右下方 / 非數值 → 不選');
  ok(wheelSlotFromVector(-80, -20) === 0 && wheelSlotFromVector(-30, -80) === 2 && wheelSlotFromVector(-80, 30) === 0, '邊界：偏左上 14° 仍空手、偏上 20° 仍手槍、左下 20° 仍空手');
  const o = wheelCellOffset(1, { x: 0, y: 0 });
  ok(o.x < 0 && o.y < 0 && wheelSlotFromVector(o.x, o.y) === 1, '格子擺放位置與判定一致');
  ok(ammoText('pistol', 12, 36) === '12 / 36' && ammoText('bat', 1, 2) === '', "ammoText：手槍 '12 / 36'");
}

// ---------- 11. HUD DOM（最小 document 替身）----------
{
  const S = setup({ touch: true });
  const root = new FakeEl('div');
  const touchRoot = new FakeEl('div');
  touchRoot.id = 'touch-ui';
  const presses = [];
  const input = { touchPress: (c, h) => presses.push(['press', c, h]), touchRelease: (c) => presses.push(['release', c]) };
  const hud = createWeaponHud({ root, touchRoot, weapons: S.w, input, isTouch: true });
  const panel = root.find('wp-hud');
  const cross = root.find('wp-crosshair');
  const bw = touchRoot.find('tb-weapon');
  const br = touchRoot.find('tb-reload');
  const ba = touchRoot.find('tb-aim');
  ok(panel && cross && bw && br && ba && touchRoot.find('wp-wheel'), 'DOM：#wp-hud、#wp-crosshair、#tb-weapon（含 #wp-wheel）、#tb-reload、#tb-aim');
  const all = [];
  const walk = (e) => {
    all.push(e);
    e.children.forEach(walk);
  };
  root.children.forEach(walk);
  touchRoot.children.forEach(walk);
  ok(all.every((e) => !e.id || e.id.startsWith('wp-') || e.id.startsWith('tb-')) && all.every((e) => [...e.classList.set].every((c) => c.startsWith('wp-') || c === 'active')), 'id / class 一律 wp- 前綴（按鈕 id 依契約 tb-）');
  hud.update(FRAME, {});
  const icon = panel.children[0];
  ok(icon.src === 'art/hud/weapon-fist.png' && panel.children[1].textContent === '空手', '圖示路徑 art/hud/weapon-<id>.png、名稱文字');
  icon.onerror();
  ok(icon.hidden && !panel.children[1].hidden, '圖示缺檔 → 顯示文字');
  ok(!cross.classList.contains('wp-show') && br.hidden && ba.hidden, '空手：無準星、裝填 / 瞄準鈕隱藏');
  // 點擊 tb-weapon = 循環
  let t = 1000;
  const perfNow = globalThis.performance.now;
  Object.defineProperty(globalThis.performance, 'now', { value: () => t, configurable: true, writable: true });
  bw.dispatch('pointerdown', { clientX: 32, clientY: 32 });
  t += 100;
  bw.dispatch('pointerup', { clientX: 33, clientY: 32 });
  ok(S.w.current === 'bat', 'tb-weapon 點擊 → cycle（空手 → 球棒）');
  S.step(0.35);
  // 長按開輪盤 → 滑到「上」（手槍）放開 = 直選
  bw.dispatch('pointerdown', { clientX: 32, clientY: 32 });
  t += 400;
  await new Promise((r) => setTimeout(r, LONG_PRESS_MS + 30));
  ok(hud.isWheelOpen() && !touchRoot.find('wp-wheel').hidden, `按住 ${LONG_PRESS_MS} ms → 輪盤打開`);
  bw.dispatch('pointermove', { clientX: 32, clientY: -50 });
  const cells = touchRoot.find('wp-wheel').children;
  ok(cells[2].classList.contains('wp-sel'), '滑到上方格 → 手槍格高亮');
  bw.dispatch('pointerup', { clientX: 32, clientY: -50 });
  ok(S.w.current === 'pistol' && !hud.isWheelOpen(), '放開 → 直選手槍、輪盤關閉');
  S.step(0.35);
  hud.update(FRAME, {});
  ok(panel.children[2].textContent === '12 / ∞' && !panel.children[2].hidden, "彈藥文字 '12 / ∞'（無限備彈）");
  ok(cross.classList.contains('wp-show') && !br.hidden && !ba.hidden, '持手槍：準星顯示、裝填 / 瞄準鈕顯示');
  hud.update(FRAME, { aimBlend: 1 });
  ok(cross.classList.contains('wp-aim'), '瞄準中準星收窄（wp-aim）');
  ba.dispatch('pointerdown', { pointerId: 7 });
  ok(presses.at(-1).join() === 'press,Mouse2,true' && hud.aimHeld, 'tb-aim 按住 → touchPress(Mouse2, hold)');
  ba.dispatch('pointerup', { pointerId: 7 });
  ok(presses.at(-1).join() === 'release,Mouse2' && !hud.aimHeld, 'tb-aim 放開 → touchRelease(Mouse2)');
  S.w.attack(aimAt(0, 30, 100));
  S.step(0.3);
  br.dispatch('pointerdown', {});
  ok(S.w.state === 'reloading', 'tb-reload → weapons.reload()');
  hud.update(FRAME, {});
  ok(!panel.children[3].hidden, '裝填中顯示進度條');
  S.step(1.5);
  hud.update(FRAME, {});
  ok(panel.children[3].hidden && panel.children[2].textContent === '12 / ∞', '裝填完成：進度條隱藏、12 / ∞');
  // 長按但放在死區 → 不選（取消）
  bw.dispatch('pointerdown', { clientX: 32, clientY: 32 });
  t += 500;
  bw.dispatch('pointerup', { clientX: 34, clientY: 30 });
  ok(S.w.current === 'pistol', '長按放在中心死區 → 取消（不切）');
  // 駕駛：準星與鈕隱藏
  hud.setDriving(true);
  hud.update(FRAME, { driving: true });
  ok(!cross.classList.contains('wp-show') && br.hidden && ba.hidden && bw.hidden, '駕駛中準星 / 武器鈕全部隱藏');
  hud.setDriving(false);
  hud.update(FRAME, {});
  // 每幀不重寫 DOM：值未變時 textContent 不重設
  let writes = 0;
  const amEl = panel.children[2];
  let txt = amEl.textContent;
  Object.defineProperty(amEl, 'textContent', { get: () => txt, set: (v) => { writes++; txt = v; }, configurable: true });
  for (let i = 0; i < 100; i++) hud.update(FRAME, {});
  ok(writes === 0, '值不變時每幀不寫 DOM');
  hud.dispose();
  ok(!root.find('wp-hud') && !touchRoot.find('tb-weapon'), 'dispose 移除 DOM');
  Object.defineProperty(globalThis.performance, 'now', { value: perfNow, configurable: true, writable: true });
  // CSS：觸控鈕 ≥ 44 px、safe-area、z-index 50–59
  const css = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/weapons/weapons.css'), 'utf8');
  const zs = [...css.matchAll(/z-index:\s*(\d+)/g)].map((m) => +m[1]);
  ok(/min-width:\s*44px/.test(css) && /min-height:\s*44px/.test(css) && /safe-area-inset/.test(css), 'CSS：按鈕 min 44 px、safe-area');
  ok(zs.length > 0 && zs.every((z) => z >= 50 && z <= 59), `CSS z-index 皆在 50–59（${zs.join(',')}）`);
  ok(!/#attribution/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'CSS 不碰 #attribution');
  const cssNc = css.replace(/\/\*[\s\S]*?\*\//g, '');
  ok(/body\.touch \.wp-hud \{[^}]*height: 28px/.test(cssNc) && /@media \(orientation: landscape\) and \(max-height: 540px\)/.test(cssNc) && /@media \(orientation: portrait\)/.test(cssNc), 'CSS：觸控面板一列（高 28）+ 矮橫向 / 直向排法（版面矩形由 attribution.mjs 驗證）');
  ok(/body\.touch-drive \.wp-hud[^{]*\{[^}]*display: none/.test(cssNc), 'CSS：觸控駕駛中面板隱藏');
}

// ---------- 12. 存讀檔 ----------
{
  const S = setup();
  S.w.select(2);
  S.step(0.35);
  S.w.attack(aimAt(0, 30, 100));
  const d = S.w.serialize();
  ok(d.slot === 2 && d.ammo.pistol.mag === 11 && d.ammo.pistol.reserve === 36, 'serialize → { slot 2, ammo.pistol { 11, 36 } }（§18）');
  const S2 = setup();
  ok(S2.w.restore(d) === true && S2.w.current === 'pistol' && S2.w.state === 'idle' && S2.w.ammo().mag === 11, 'restore：直接換到手槍（不播 equip）、彈藥還原');
  ok(S2.of('weapon:equip').at(-1).weapon === 'pistol' && S2.of('weapon:ammo').at(-1).mag === 11, 'restore 發 weapon:equip / weapon:ammo');
  S2.w.restore({ slot: 7, ammo: { pistol: { mag: 99, reserve: -1 } } });
  ok(S2.w.current === 'fist' && S2.w.ammo().mag === 12 && S2.w.ammo().reserve === Infinity && S2.w.serialize().ammo.pistol.reserve === 36, 'restore 非法值 → 預設（slot 0、12 / ∞，存檔 reserve 36）');
  // 無限備彈存檔往返：serialize → JSON → restore 後仍無限；JSON 不含 null / Infinity；舊存檔（數字備彈，含 0）讀入不壞
  const js = JSON.stringify(S.w.serialize());
  const S3 = setup();
  ok(!/null|Infinity/.test(js) && S3.w.restore(JSON.parse(js)) === true && S3.w.ammo().reserve === Infinity && S3.w.ammo().mag === 11, `存檔往返：${js} → 仍無限、mag 11`);
  for (const old of [{ slot: 2, ammo: { pistol: { mag: 0, reserve: 0 } } }, { slot: 2, ammo: { pistol: { mag: 5, reserve: 80 } } }, { slot: 2, ammo: { pistol: { mag: 3, reserve: null } } }]) {
    S3.w.restore(JSON.parse(JSON.stringify(old)));
    const okLoad = S3.w.ammo().reserve === Infinity && S3.w.reload() === true;
    S3.step(1.5);
    const back = JSON.stringify(S3.w.serialize());
    ok(okLoad && S3.w.ammo().mag === 12 && !/null|Infinity/.test(back), `舊存檔 ${JSON.stringify(old.ammo.pistol)} → 無限、可換彈回 12、再存 ${back}`);
  }
  S2.w.restore(null);
  ok(S2.w.current === 'fist', 'restore(null) 不丟例外');
  S2.w.dispose();
  ok(S2.w.attack() === false && S2.w.select(1) === false, 'dispose 後所有操作無效');
}

// ---------- 13. 空手：沿用拳擊（player.punch）、發 weapon:swing ----------
{
  const b = mockActor('fb', 0, 0.8, Math.PI);
  const S = setup({ peds: [b] });
  ok(S.w.attack() === true && S.of('weapon:swing')[0].weapon === 'fist', '空手攻擊 → player.punch() 成功、weapon:swing fist');
  S.step(0.1);
  S.pa.anim.emit('punchHitWindow', 'open');
  S.step(0.1);
  S.pa.anim.emit('punchHitWindow', 'close');
  ok(b.hp === 80, `拳擊命中走原路徑（hp=${b.hp}）`);
  ok(S.w.attack() === false, '拳擊冷卻中 attack → false');
}

// ---------- 14. 效能：每幀 update（揮棒命中窗 + 手槍）----------
{
  const peds = [];
  for (let i = 0; i < 40; i++) peds.push(mockActor(`perf${i}`, (i % 8) * 3 - 12, 3 + Math.floor(i / 8) * 3));
  const S = setup({ peds, sweepFn: () => [] });
  S.w.select(1);
  S.step(0.35);
  const N = 20000;
  const aim = aimAt(0, 1, 30);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    clock += FRAME;
    if (i % 45 === 0) S.w.attack(aim);
    S.w.update(FRAME, aim);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  ok(ms < 0.02, `weapons.update 每幀平均 ${(ms * 1000).toFixed(2)} µs（< 20 µs）`);
}

console.log(`weapons.mjs：通過 ${pass} / ${total}`);
for (const m of fails) console.log(`  ✗ ${m}`);
console.log(fails.length ? `FAIL ${fails.length}/${total}` : `PASS ${pass}/${total}`);
process.exit(fails.length ? 1 : 0);
