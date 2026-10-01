#!/usr/bin/env node
// p5-s0 五條小缺陷的回歸斷言（不需 node_modules：navigation.js 的 three 以 loader hook 換成空殼，只用到純邏輯部分）
// 1. 手槍射程邊界（aim.resolveShot）  2. navigator.routeLength() 回傳契約  3. 行人死亡發 ped:dead
// 4. 武器鈕連點（src/weapons/hud.js，不在本單元可改範圍：只列 INFO，不計分）  5. src/hud.js 的 setPointerCapture 一律包 try/catch
// 用法：node tools/test/s0-regressions.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

const THREE_STUB = 'export class Group {} export class Mesh {} export class MeshBasicMaterial {} export class ConeGeometry {} export class RingGeometry {} export const DoubleSide = 2;';
const HOOK = `
export async function resolve(spec, context, next) {
  if (spec === 'three') return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(THREE_STUB)}), shortCircuit: true };
  return next(spec, context);
}`;
register(`data:text/javascript,${encodeURIComponent(HOOK)}`, import.meta.url);

const { resolveShot, SHOT_RANGE_TOL } = await import('../../src/weapons/aim.js');
const { WEAPONS } = await import('../../src/weapons/defs.js');
const { buildRoadGraph, findRoute, createNavigator } = await import('../../src/navigation.js');
const { CombatSystem, DEAD_HOLD } = await import('../../src/combat.js');
const { createBus, bus: globalBus } = await import('../../src/core/events.js');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ---------- 1. 手槍射程邊界 ----------
{
  const range = WEAPONS.pistol.range;
  // 假 raycast：行人 = 半徑 0.4 的球（中心在腳底上方 1.2 m），遵守 maxDist
  const rc = (actors) => (o, d, maxDist, opts = {}) => {
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
      if (d2 > 0.16) continue;
      const t = tc - Math.sqrt(0.16 - d2);
      if (t >= 0 && t < bt) {
        bt = t;
        best = a;
      }
    }
    return best ? { point: { x: o.x + d.x * bt, y: o.y + d.y * bt, z: o.z + d.z * bt }, normal: null, actor: best, surface: 'actor' } : null;
  };
  const shoot = (cam, muzzle, dist) => {
    const ped = { id: `p${dist}`, pos: { x: muzzle.x, y: 0, z: muzzle.z + dist } };
    const tx = ped.pos.x - cam.x;
    const ty = 1.2 - cam.y;
    const tz = ped.pos.z - cam.z;
    const l = Math.hypot(tx, ty, tz);
    const out = { hit: false, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, actor: null, surface: null, dir: { x: 0, y: 0, z: 0 }, dist: 0 };
    resolveShot(rc([ped]), cam, { x: tx / l, y: ty / l, z: tz / l }, muzzle, range, null, out);
    return { out, ped };
  };
  const rigs = [
    ['肩後鏡頭', { x: 0.45, y: 1.6, z: -1.6 }, { x: -0.2, y: 1.35, z: 0.45 }],
    ['遠鏡頭（4 m）', { x: 0, y: 1.8, z: -4 }, { x: 0, y: 1.35, z: 0.45 }],
  ];
  let outHits = 0;
  let inMiss = 0;
  let maxDist = 0;
  for (const [, cam, muzzle] of rigs) {
    for (const d of [80.7, 81, 82, 82.5, 85, 100]) {
      const { out } = shoot(cam, muzzle, d);
      if (out.hit || out.actor) outHits++;
    }
    for (const d of [10, 40, 79, 80.2]) {
      const { out, ped } = shoot(cam, muzzle, d);
      if (out.actor !== ped) inMiss++;
      else maxDist = Math.max(maxDist, out.dist);
    }
  }
  check(`手槍：行人在槍口前 80.7–100 m（含 82.5 m）不命中`, outHits === 0, `命中 ${outHits} 次`);
  check(`手槍：射程內（10–80.2 m，表面 ≤ ${range} m）命中、落點距離 ≤ ${range} + ${SHOT_RANGE_TOL}`, inMiss === 0 && maxDist <= range + SHOT_RANGE_TOL, `漏 ${inMiss}、最遠 ${maxDist.toFixed(2)} m`);
}

// ---------- 2. navigator.routeLength() ----------
{
  const P = (arr) => {
    const pts = [];
    for (let i = 0; i < arr.length; i += 2) pts.push({ x: arr[i], z: arr[i + 1] });
    return { pts };
  };
  const graph = buildRoadGraph([P([0, 0, 100, 0]), P([100, 0, 100, 100]), P([0, 0, 0, 100, 100, 100])]);
  const nav = createNavigator({ graph });
  const start = { x: 0, z: 0 };
  check('routeLength：無目的地 → null', nav.routeLength() === null);
  nav.setDestination(100, 100, 'x');
  check('routeLength：已設目的地、尚未算路 → null（與 route() 一致）', nav.routeLength() === null && nav.route() === null);
  nav.update(0.016, start);
  const ref = findRoute(graph, start, { x: 100, z: 100 });
  check('routeLength：合法路線 = findRoute.lengthM（200 m）', Number.isFinite(nav.routeLength()) && Math.abs(nav.routeLength() - 200) < 1e-6 && nav.routeLength() === ref.lengthM, String(nav.routeLength()));
  nav.setDestination(100, 50, 'y', 'map', { x: 50, z: 0 });
  check('routeLength：setDestination 帶 playerPos 立即算路（100 m）', Math.abs(nav.routeLength() - 100) < 1e-6, String(nav.routeLength()));
  nav.clear();
  check('routeLength：clear 後 → null', nav.routeLength() === null && nav.route() === null);
  const empty = createNavigator({ graph: buildRoadGraph([]) });
  empty.setDestination(10, 0, 'z');
  empty.update(0.016, start);
  check('routeLength：不可達（空路網）→ null，與 route() 一致', empty.routeLength() === null && empty.route() === null);
  nav.setDestination(100, 100, 'w');
  nav.update(0.016, { x: NaN, z: 0 });
  check('routeLength：非法玩家座標 → null（不回 0 / NaN）', nav.routeLength() === null);
}

// ---------- 3. 行人死亡發 ped:dead ----------
{
  let clock = 0;
  const mkActor = (id, x, z, kind = 'pedestrian') => ({
    id,
    kind,
    pos: { x, y: 0, z },
    yaw: 0,
    hp: 100,
    maxHp: 100,
    faction: kind === 'player' ? 'player' : 'civilian',
    anim: { state: 'idle', trigger: () => true, on: () => () => {} },
    body: { knockdown() {}, settleCheck: () => ({ settled: false, clearToStand: false }), standUp() {} },
  });
  const bus = createBus();
  const dead = [];
  bus.on('ped:dead', (e) => dead.push(e));
  const combat = new CombatSystem({ now: () => clock, bus });
  const player = mkActor('player', 0, 0, 'player');
  const ped = mkActor('ped1', 0, 5);
  combat.register(player);
  combat.register(ped);
  combat.applyHit({ attacker: player, target: ped, damage: 60, weapon: 'pistol', dir: { x: 0, z: 1 } });
  check('ped:dead：未死亡不發', dead.length === 0);
  clock += 2;
  combat.applyHit({ attacker: player, target: ped, damage: 60, weapon: 'pistol', dir: { x: 0, z: 1 } });
  const e = dead[0];
  check(
    'ped:dead：槍擊致死發一次，payload 含 ped / attacker / byPlayer / cause / weapon / x / z',
    dead.length === 1 && e.ped === ped && e.attacker === player && e.byPlayer === true && e.cause === 'bullet' && e.weapon === 'pistol' && e.x === 0 && e.z === 5,
    JSON.stringify(e && { ped: e.ped && e.ped.id, attacker: e.attacker && e.attacker.id, byPlayer: e.byPlayer, cause: e.cause, weapon: e.weapon }),
  );
  for (let i = 0; i < 12; i++) {
    clock += 1;
    combat.update(1);
  }
  check(`ped:dead：DEAD_HOLD（${DEAD_HOLD} s）後轉 dead 不重複發`, dead.length === 1 && combat.stateOf(ped) === 'dead');
  // 車撞致死：擊殺來源 = 駕駛（vehicleDriver），cause 'vehicle'
  const car = { id: 'car' };
  const combat2 = new CombatSystem({ now: () => clock, bus, vehicleDriver: (v) => (v === car ? player : null) });
  const ped2 = mkActor('ped2', 3, 4);
  combat2.register(player);
  combat2.register(ped2);
  combat2.onVehicleHit({ ped: ped2, relSpeed: 20, vehicle: car, impulse: { x: 1, y: 0, z: 0 } });
  const e2 = dead[1];
  check('ped:dead：車撞致死 → cause vehicle、attacker = 駕駛', dead.length === 2 && e2.ped === ped2 && e2.cause === 'vehicle' && e2.attacker === player && e2.byPlayer === true);
  // 玩家死亡不發 ped:dead；recoverOnKo 的拳擊歸零不算死亡
  const player3 = mkActor('player3', 0, 0, 'player');
  const ko = mkActor('ko', 0, 1);
  ko.recoverOnKo = true;
  combat2.register(player3);
  combat2.register(ko);
  combat2.applyHit({ attacker: ped2, target: player3, damage: 200, weapon: 'pistol' });
  combat2.applyHit({ attacker: player3, target: ko, damage: 200, weapon: 'fist' });
  check('ped:dead：玩家死亡 / recoverOnKo 拳擊歸零不發', dead.length === 2);
  // 未注入 bus → 發到 core/events 全域單例（main.js 使用的 bus），整合層不需改動即可收到
  const got = [];
  const off = globalBus.on('ped:dead', (x) => got.push(x));
  const combat3 = new CombatSystem({ now: () => clock });
  const ped3 = mkActor('ped3', 0, 2);
  combat3.register(player);
  combat3.register(ped3);
  combat3.applyHit({ attacker: player, target: ped3, damage: 500, weapon: 'pistol' });
  off();
  check('ped:dead：預設發到全域 bus 單例', got.length === 1 && got[0].ped === ped3);
  const combat4 = new CombatSystem({ now: () => clock, bus: null });
  const ped4 = mkActor('ped4', 0, 2);
  combat4.register(player);
  combat4.register(ped4);
  let threw = false;
  try {
    combat4.applyHit({ attacker: player, target: ped4, damage: 500, weapon: 'pistol' });
  } catch {
    threw = true;
  }
  check('ped:dead：bus: null 時不發、不丟例外', !threw && ped4.hp === 0);
}

// ---------- 4. 武器鈕連點（不計分）----------
console.log('INFO  4. 武器鈕 tb-weapon 實作在 src/weapons/hud.js（本單元不可改）：重疊觸控的第二指被 if (press) return 丟棄、且未處理 lostpointercapture；斷言待該檔修正後補');

// ---------- 5. src/hud.js 的 setPointerCapture 一律包 try/catch ----------
{
  const src = readFileSync(new URL('../../src/hud.js', import.meta.url), 'utf8');
  const lines = src.split('\n');
  let total = 0;
  let unguarded = 0;
  lines.forEach((ln, i) => {
    if (!/\.(setPointerCapture|releasePointerCapture)\s*\(/.test(ln) || /^\s*\/\//.test(ln)) return;
    total++;
    // 往上找最近的 try {（同一函式內 6 行以內）
    const before = lines.slice(Math.max(0, i - 6), i).join('\n');
    if (!/try\s*\{/.test(before)) unguarded++;
  });
  check('src/hud.js：setPointerCapture / releasePointerCapture 皆在 try 內', unguarded === 0, `呼叫 ${total} 處、未包 ${unguarded} 處`);
}


// ---------- 4b / 5b. src/weapons/hud.js 觸控武器鈕（p5-s0b 追加；假 DOM，不需 three）----------
// .css import → 空模組（hud.js 引入 weapons.css）
register(
  `data:text/javascript,${encodeURIComponent(`export async function load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default "";' };
  return next(url, context);
}`)}`,
  import.meta.url,
);
{
  class FakeEl {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.style = {};
      this.hidden = false;
      this.textContent = '';
      this.listeners = new Map();
      this.captureThrows = false;
      this.captured = new Set();
      const set = (this.cls = new Set());
      this.classList = { toggle: (c, on) => (on ? set.add(c) : set.delete(c), !!on), contains: (c) => set.has(c) };
    }
    set className(v) {
      this.cls.clear();
      for (const c of String(v).split(/\s+/).filter(Boolean)) this.cls.add(c);
    }
    get className() {
      return [...this.cls].join(' ');
    }
    appendChild(c) {
      c.parentNode = this;
      this.children.push(c);
      return c;
    }
    removeChild(c) {
      this.children = this.children.filter((x) => x !== c);
      c.parentNode = null;
    }
    setAttribute() {}
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 60, height: 60 };
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    removeEventListener(type, fn) {
      const l = this.listeners.get(type);
      if (l) this.listeners.set(type, l.filter((f) => f !== fn));
    }
    setPointerCapture(id) {
      if (this.captureThrows) throw Object.assign(new Error('InvalidStateError'), { name: 'InvalidStateError' });
      this.captured.add(id);
    }
    releasePointerCapture(id) {
      if (this.captureThrows) throw Object.assign(new Error('InvalidStateError'), { name: 'InvalidStateError' });
      this.captured.delete(id);
    }
    fire(type, pointerId, x = 30, y = 30) {
      const e = { type, pointerId, clientX: x, clientY: y, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} };
      for (const fn of this.listeners.get(type) || []) fn(e);
    }
  }
  const doc = { createElement: (tag) => new FakeEl(tag) };
  const prevDoc = globalThis.document;
  globalThis.document = doc;
  const { createWeaponHud } = await import('../../src/weapons/hud.js');
  const { LONG_PRESS_MS } = await import('../../src/weapons/wheel.js');
  const mk = () => {
    const root = new FakeEl('div');
    root.ownerDocument = doc;
    const log = [];
    const weapons = { current: 'pistol', cycle: () => log.push('cycle'), select: (s) => log.push(`select${s}`), reload: () => log.push('reload'), ammo: () => ({ mag: 12, reserve: 36 }) };
    const hud = createWeaponHud({ root, touchRoot: new FakeEl('div'), weapons, isTouch: true });
    return { hud, log, btn: hud.buttons.weapon, aim: hud.buttons.aim };
  };

  // 4b-1 重疊觸控快速連點兩下：第二指的按下不被丟棄，兩次都循環
  {
    const { btn, log, hud } = mk();
    btn.fire('pointerdown', 1);
    btn.fire('pointerdown', 2);
    btn.fire('pointerup', 1);
    btn.fire('pointerup', 2);
    check('武器鈕：重疊觸控快速連點兩下 → cycle 兩次', log.filter((x) => x === 'cycle').length === 2, JSON.stringify(log));
    hud.dispose();
  }
  // 4b-2 pointercancel / lostpointercapture 後 press 不卡住，下一次點擊照常生效
  {
    const { btn, log, hud } = mk();
    btn.fire('pointerdown', 1);
    btn.fire('lostpointercapture', 1);
    btn.fire('pointerdown', 2);
    btn.fire('pointerup', 2);
    btn.fire('pointerdown', 3);
    btn.fire('pointercancel', 3);
    btn.fire('pointerdown', 4);
    btn.fire('pointerup', 4);
    check('武器鈕：lostpointercapture / pointercancel 清掉 press（不觸發 cycle），之後點擊不被吞', log.join() === 'cycle,cycle' && !btn.cls.has('active'), JSON.stringify(log));
    hud.dispose();
  }
  // 4b-3 既有行為：長按開輪盤、滑到格子放開 = 直選；放開後輪盤關閉
  {
    const realST = globalThis.setTimeout;
    const realPerf = Object.getOwnPropertyDescriptor(globalThis, 'performance');
    let t = 1000;
    let pending = null;
    globalThis.setTimeout = (fn) => ((pending = fn), 1);
    Object.defineProperty(globalThis, 'performance', { value: { now: () => t }, configurable: true, writable: true });
    try {
      const { btn, log, hud } = mk();
      btn.fire('pointerdown', 1);
      t += LONG_PRESS_MS + 10;
      if (pending) pending();
      const opened = hud.isWheelOpen();
      btn.fire('pointermove', 1, 30, -60);
      btn.fire('pointerup', 1, 30, -60); // 鈕心 (30,30) 正上方 90 px → 槽 2
      check('武器鈕：長按開輪盤、往上滑放開 = select(2)、不 cycle、輪盤關閉', opened && log.join() === 'select2' && !hud.isWheelOpen(), JSON.stringify(log));
      hud.dispose();
    } finally {
      globalThis.setTimeout = realST;
      if (realPerf) Object.defineProperty(globalThis, 'performance', realPerf);
    }
  }

  // 5b setPointerCapture 丟 InvalidStateError 時安靜降級：不丟例外、按鈕照常運作
  {
    const { btn, aim, log, hud } = mk();
    btn.captureThrows = true;
    aim.captureThrows = true;
    let threw = null;
    try {
      btn.fire('pointerdown', 7);
      btn.fire('pointerup', 7);
      aim.fire('pointerdown', 8);
      aim.fire('pointerup', 8);
    } catch (err) {
      threw = err;
    }
    check('src/weapons/hud.js：setPointerCapture 丟 InvalidStateError 不外拋、武器鈕 / 瞄準鈕照常', !threw && log.join() === 'cycle' && hud.aimHeld === false, threw ? threw.name : JSON.stringify(log));
    hud.dispose();
  }
  {
    const lines = readFileSync(new URL('../../src/weapons/hud.js', import.meta.url), 'utf8').split('\n');
    let total = 0;
    let unguarded = 0;
    lines.forEach((ln, i) => {
      if (!/\.(setPointerCapture|releasePointerCapture)\s*\(/.test(ln) || /^\s*\/\//.test(ln)) return;
      total++;
      if (!/try\s*\{/.test(lines.slice(Math.max(0, i - 6), i).join('\n'))) unguarded++;
    });
    check('src/weapons/hud.js：setPointerCapture / releasePointerCapture 皆在 try 內', total > 0 && unguarded === 0, `呼叫 ${total} 處、未包 ${unguarded} 處`);
  }
  globalThis.document = prevDoc;
}

console.log(failed ? `FAIL ${failed}/${passed + failed}` : `PASS ${passed}/${passed + failed}`);
process.exit(failed ? 1 : 0);
