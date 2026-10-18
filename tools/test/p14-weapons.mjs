#!/usr/bin/env node
// Phase 14 武器驗證：衝鋒槍連發射速 / 散佈 / 彈匣 / 裝填、散彈槍彈丸數 / 錐角 / 距離衰減 / 擊倒、車輛傷害、直選與輪選、彈藥 HUD、存檔相容
// 用法：node tools/test/p14-weapons.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 純邏輯：weapons.js / aim.js / defs.js / wheel.js / save.js / combat.js（真 CombatSystem）+ 假射線場景（球體角色 / 牆 / 車），不 import three；
//   hud.js / pickups.js / models.js 依賴 three / css → 原始碼字串比對
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBus } from '../../src/core/events.js';
import { CombatSystem, KNOCKDOWN_RULES, WEAPON_CAUSE } from '../../src/combat.js';
import { createWeapons } from '../../src/weapons/weapons.js';
import { WEAPONS, SLOT_IDS, SLOT_KEYS, GUN_IDS, PURCHASABLE, isGun, pelletFalloff } from '../../src/weapons/defs.js';
import { spreadDir } from '../../src/weapons/aim.js';
import { ammoText, wheelAngles, wheelSlotFromVector, WHEEL_ANGLES, WHEEL_ANGLES_ALL } from '../../src/weapons/wheel.js';
import { validateSave, defaultSave, createSaveStore } from '../../src/save.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(`${ROOT}${p}`, 'utf8');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const DEG = Math.PI / 180;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------- 替身：角色 / 射線場景 ----------
function mkActor(id, kind, x, z, hp = 100) {
  return {
    id, kind, pos: { x, y: 0, z }, yaw: 0, hp, maxHp: hp,
    anim: { trigger: () => true, hitStop() {}, on: () => () => {} },
    body: { knockdown() {}, settleCheck: () => ({ settled: false, clearToStand: false }), standUp() {} },
  };
}
// 射線場景：spheres [{ actor?, vehicle?, x, y, z, r }]、walls [{ z }]（垂直於 +Z 的無限平面）；回傳重用物件（同 main.js）
function mkScene() {
  const spheres = [];
  const walls = [];
  const hit = { point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, actor: null, surface: 'world', vehicle: null };
  let calls = 0;
  function raycast(o, d, max, opts) {
    calls++;
    let best = Infinity;
    let bs = null;
    let bw = null;
    for (const s of spheres) {
      if (opts && s.actor && s.actor === opts.excludeActor) continue;
      const ox = o.x - s.x;
      const oy = o.y - s.y;
      const oz = o.z - s.z;
      const b = ox * d.x + oy * d.y + oz * d.z;
      const c = ox * ox + oy * oy + oz * oz - s.r * s.r;
      const disc = b * b - c;
      if (disc < 0) continue;
      const t = -b - Math.sqrt(disc);
      if (t >= 0 && t <= max && t < best) {
        best = t;
        bs = s;
        bw = null;
      }
    }
    for (const w of walls) {
      if (Math.abs(d.z) < 1e-9) continue;
      const t = (w.z - o.z) / d.z;
      if (t >= 0 && t <= max && t < best) {
        best = t;
        bw = w;
        bs = null;
      }
    }
    if (best === Infinity) return null;
    hit.point.x = o.x + d.x * best;
    hit.point.y = o.y + d.y * best;
    hit.point.z = o.z + d.z * best;
    if (bs) {
      const l = Math.hypot(hit.point.x - bs.x, hit.point.y - bs.y, hit.point.z - bs.z) || 1;
      hit.normal.x = (hit.point.x - bs.x) / l;
      hit.normal.y = (hit.point.y - bs.y) / l;
      hit.normal.z = (hit.point.z - bs.z) / l;
      hit.actor = bs.actor || null;
      hit.vehicle = bs.vehicle || null;
      hit.surface = bs.vehicle ? 'vehicle' : 'world';
    } else {
      hit.normal.x = 0;
      hit.normal.y = 0;
      hit.normal.z = -1;
      hit.actor = null;
      hit.vehicle = null;
      hit.surface = 'world';
    }
    return hit;
  }
  return { spheres, walls, raycast, get calls() { return calls; }, resetCalls() { calls = 0; } };
}
// 世界：時鐘 + bus + combat + 玩家 + weapons；aim 原點 = 槍口（散佈方向可直接由 weapon:fire dir 讀出）
function mkWorld({ rng = null } = {}) {
  let t = 0;
  const bus = createBus();
  const combat = new CombatSystem({ now: () => t, bus: null });
  const player = mkActor('player', 'player', 0, 0);
  combat.register(player);
  const scene = mkScene();
  const events = [];
  for (const n of ['weapon:fire', 'weapon:impact', 'weapon:reload', 'weapon:ammo', 'weapon:equip', 'weapon:acquire', 'weapon:dryFire']) bus.on(n, (e) => events.push({ n, e, t }));
  const weapons = createWeapons({ bus, combat, player: { actor: player }, raycast: scene.raycast, now: () => t, rng });
  const aim = { origin: { x: 0, y: 1.4, z: 0 }, dir: { x: 0, y: 0, z: 1 }, aiming: false, muzzle: { x: 0, y: 1.4, z: 0 } };
  const step = (dt) => {
    t += dt;
    weapons.update(dt, aim);
    combat.update && combat.update(dt);
  };
  const equip = (slot) => {
    weapons.select(slot);
    for (let i = 0; i < 30; i++) step(1 / 60); // 0.5 s：換裝完成
  };
  const of = (n) => events.filter((x) => x.n === n);
  return { bus, combat, player, scene, events, of, weapons, aim, step, equip, get t() { return t; }, set t(v) { t = v; } };
}
const angleTo = (dx, dy, dz, ax = 0, ay = 0, az = 1) => Math.acos(Math.min(1, (dx * ax + dy * ay + dz * az) / (Math.hypot(dx, dy, dz) * Math.hypot(ax, ay, az))));

// ======================= 定義 =======================
const P = WEAPONS.pistol;
const S = WEAPONS.smg;
const G = WEAPONS.shotgun;
check('defs：五槽 fist/bat/pistol/smg/shotgun、直選鍵 Digit1–5', SLOT_IDS.join() === 'fist,bat,pistol,smg,shotgun' && SLOT_KEYS.join() === 'Digit1,Digit2,Digit3,Digit4,Digit5' && S.slot === 3 && G.slot === 4);
check('defs：GUN_IDS / isGun / PURCHASABLE', GUN_IDS.join() === 'pistol,smg,shotgun' && isGun('smg') && isGun('shotgun') && isGun('pistol') && !isGun('bat') && !isGun('fist') && PURCHASABLE.join() === 'smg,shotgun');
check('defs：smg 全自動約 10 發 / 秒、彈匣 30、單發傷害低於手槍', S.auto === true && near(1 / S.fireInterval, 10, 0.5) && S.magSize === 30 && S.damage < P.damage && S.damage > 0);
check('defs：smg vehicleDamage 適中（每發低於手槍、每秒高於手槍）', S.vehicleDamage > 0 && S.vehicleDamage < P.vehicleDamage && S.vehicleDamage / S.fireInterval > P.vehicleDamage / P.fireInterval, `${S.vehicleDamage}/發`);
check('defs：shotgun 泵動約 1 發 / 秒、彈匣 6、8 顆彈丸、vehicleDamage 高（全中 > 手槍 3 倍）', near(G.fireInterval, 1, 0.15) && G.pump === true && G.magSize === 6 && G.pellets === 8 && G.pellets * G.vehicleDamage > 3 * P.vehicleDamage);
check('defs：價格 smg NT$2500 / shotgun NT$3500、彈藥各自價格', S.price === 2500 && G.price === 3500 && S.ammoPrice > 0 && G.ammoPrice > 0 && S.ammoPrice !== G.ammoPrice && S.ammoPack > 0 && G.ammoPack > 0);
check('defs：pelletFalloff 近距 1、遠距遞減到下限', pelletFalloff(2) === 1 && pelletFalloff(G.falloffStart) === 1 && pelletFalloff(20) < 1 && pelletFalloff(20) > pelletFalloff(28) && pelletFalloff(100) === G.falloffMin);
check('combat：KNOCKDOWN_RULES / WEAPON_CAUSE 收 smg / shotgun（cause bullet）', !!KNOCKDOWN_RULES.smg && !!KNOCKDOWN_RULES.shotgun && WEAPON_CAUSE.smg === 'bullet' && WEAPON_CAUSE.shotgun === 'bullet');

// spreadDir：偏轉角正確、phi 改變方位、單位向量
{
  const o = { x: 0, y: 0, z: 0 };
  const d = { x: 0.3, y: -0.2, z: 0.9 };
  let ok = true;
  for (const ang of [0, 0.01, 0.05, 0.1]) for (const phi of [0, 1, 2.5, 4]) {
    spreadDir(d, ang, phi, o);
    ok = ok && near(Math.hypot(o.x, o.y, o.z), 1, 1e-9) && near(angleTo(o.x, o.y, o.z, d.x, d.y, d.z), ang, 1e-6);
  }
  const a = spreadDir(d, 0.05, 0, { x: 0, y: 0, z: 0 });
  const b = spreadDir(d, 0.05, Math.PI, { x: 0, y: 0, z: 0 });
  spreadDir({ x: 0, y: 1, z: 0 }, 0.1, 0, o);
  check('aim.spreadDir：偏轉角 = angle、單位長、phi 對向相反、垂直方向不爆 NaN', ok && near(angleTo(a.x, a.y, a.z, b.x, b.y, b.z), 0.1, 1e-6) && Number.isFinite(o.x) && near(Math.hypot(o.x, o.y, o.z), 1, 1e-9));
}

// ======================= 擁有權 / 直選 / 輪選 =======================
{
  const w = mkWorld();
  check('擁有權：初始只有空手 / 球棒 / 手槍', w.weapons.owns('fist') && w.weapons.owns('bat') && w.weapons.owns('pistol') && !w.weapons.owns('smg') && !w.weapons.owns('shotgun'));
  check('直選：未購買的 smg（槽 3）select 回 false、不排隊', w.weapons.select(3) === false && w.weapons.pending === -1 && w.weapons.slot === 0);
  const seq = [];
  for (let i = 0; i < 4; i++) {
    w.weapons.cycle();
    for (let k = 0; k < 30; k++) w.step(1 / 60);
    seq.push(w.weapons.slot);
  }
  check('輪選：未購買時 Q 循環 0→1→2→0（跳過 3 / 4，同舊三槽）', seq.join() === '1,2,0,1', seq.join());
  check('give：取得 smg → true、發 weapon:acquire、彈匣滿 + 附贈備彈', w.weapons.give('smg') === true && w.of('weapon:acquire').length === 1 && w.weapons.ammo('smg').mag === S.magSize && w.weapons.ammo('smg').reserve === S.startReserve);
  check('give：重複 / 非 PURCHASABLE → false', w.weapons.give('smg') === false && w.weapons.give('pistol') === false && w.weapons.give('rifle') === false);
  w.weapons.give('shotgun');
  w.equip(0);
  const seq2 = [];
  for (let i = 0; i < 5; i++) {
    w.weapons.cycle();
    for (let k = 0; k < 30; k++) w.step(1 / 60);
    seq2.push(w.weapons.slot);
  }
  check('輪選：全擁有時循環 0→1→2→3→4→0', seq2.join() === '1,2,3,4,0', seq2.join());
  check('prevSlot：槽 0 的上一格 = 4（散彈槍）', w.weapons.prevSlot() === 4);
  w.equip(4);
  check('直選：Digit5 槽 4 → shotgun、Digit4 槽 3 → smg', w.weapons.current === 'shotgun' && (w.equip(3), w.weapons.current === 'smg'));
  const w2 = mkWorld();
  w2.weapons.give('shotgun');
  check('prevSlot：只買散彈槍、槽 0 → 4；槽 4 → 2（跳過未買的 3）', w2.weapons.prevSlot() === 4 && (w2.equip(4), w2.weapons.prevSlot() === 2));
  check('cycle(-1)：上一把（跳過未擁有）', (w2.weapons.cycle(-1), w2.weapons.pending === 2 || w2.weapons.slot === 2));
}
// 輪盤角度表
{
  const three = wheelAngles([true, true, true, false, false]);
  const all = wheelAngles([true, true, true, true, true]);
  const smgOnly = wheelAngles([true, true, true, true, false]);
  check('輪盤：未購買 = 三格表（相容）、全購買 = 五格 180/135/90/45/0、只買 smg 時槽 4 為 null', three === WHEEL_ANGLES && all.join() === WHEEL_ANGLES_ALL.join() && smgOnly[4] === null && smgOnly[3] === 45);
  check('輪盤：三格表往右滑不選（-1，同舊行為）、五格表往右 = 槽 4、右上 = 槽 3、上 = 槽 2',
    wheelSlotFromVector(80, 0) === -1 && wheelSlotFromVector(80, 0, undefined, all) === 4 && wheelSlotFromVector(60, -60, undefined, all) === 3 && wheelSlotFromVector(0, -80, undefined, all) === 2);
  check('輪盤：只買 smg 時往右滑（散彈槍格未擁有）不選', wheelSlotFromVector(80, 0, undefined, smgOnly) === -1 && wheelSlotFromVector(60, -60, undefined, smgOnly) === 3);
}

// ======================= 衝鋒槍 =======================
{
  const w = mkWorld();
  w.weapons.give('smg');
  w.equip(3);
  w.events.length = 0;
  // 按住攻擊 1 秒（60 fps，每幀 attack）
  for (let i = 0; i < 60; i++) {
    w.weapons.attack(w.aim);
    w.step(1 / 60);
  }
  const fires = w.of('weapon:fire').filter((x) => x.e.weapon === 'smg');
  check('smg 連發：按住 1 秒約 10 發（9–11）', fires.length >= 9 && fires.length <= 11, `${fires.length} 發`);
  check('smg 連發：每發 weapon:fire weapon = smg、彈匣遞減', w.weapons.ammo('smg').mag === S.magSize - fires.length);
}
{
  const w = mkWorld();
  w.weapons.give('smg');
  w.equip(3);
  w.events.length = 0;
  for (let i = 0; i < 200 && w.of('weapon:fire').length < 30; i++) {
    w.weapons.attack(w.aim);
    w.step(1 / 60);
  }
  const fires = w.of('weapon:fire');
  const dev = fires.map((x) => angleTo(x.e.dirX, x.e.dirY, x.e.dirZ) / DEG);
  const first = dev[0];
  const late = Math.max(...dev.slice(15));
  check('smg 散佈：首發 ≤ spreadBase', first <= S.spreadBase + 1e-6, `${first.toFixed(3)}°`);
  check('smg 散佈：連射後偏移擴大（第 16 發起最大偏移 > spreadBase × 2）', late > S.spreadBase * 2, `${late.toFixed(3)}°`);
  check('smg 散佈：所有偏移 ≤ spreadMax', dev.every((d) => d <= S.spreadMax + 1e-6));
  check('smg 散佈：spread() 連射後上升到 spreadMax', near(w.weapons.spread(), S.spreadMax, 0.5), `${w.weapons.spread().toFixed(2)}°`);
  for (let i = 0; i < 120; i++) w.step(1 / 60);
  check('smg 散佈：停火 2 s 收斂回 spreadBase', near(w.weapons.spread(), S.spreadBase, 1e-6));
  // 彈匣 / 裝填：打空 30 發 → 自動裝填 1.8 s → 彈匣 30、備彈 90 − 30
  check('smg 彈匣：一匣 30 發後打空（weapon:ammo smg mag 0）、第 31 發要等裝填', fires.length === 30 && w.of('weapon:ammo').some((x) => x.e.weapon === 'smg' && x.e.mag === 0 && x.e.magSize === 30));
  const rl = w.of('weapon:reload');
  check('smg 裝填：打空自動裝填（weapon:reload start/end weapon smg）', rl.some((x) => x.e.phase === 'start' && x.e.weapon === 'smg') && rl.some((x) => x.e.phase === 'end' && x.e.weapon === 'smg'));
  check('smg 裝填：完成後彈匣 30、備彈 60', w.weapons.ammo('smg').mag === 30 && w.weapons.ammo('smg').reserve === S.startReserve - 30);
  const start = rl.find((x) => x.e.phase === 'start');
  const end = rl.find((x) => x.e.phase === 'end');
  check('smg 裝填：耗時 reloadSec 1.8 s', start && end && near(end.t - start.t, S.reloadSec, 1 / 30), start && end ? `${(end.t - start.t).toFixed(3)} s` : '');
  // 手動裝填（部分彈匣）
  for (let i = 0; i < 5; i++) {
    w.weapons.attack(w.aim);
    for (let k = 0; k < 8; k++) w.step(1 / 60);
  }
  for (let k = 0; k < 30; k++) w.step(1 / 60);
  const before = w.weapons.ammo('smg').reserve;
  const ok = w.weapons.reload();
  for (let k = 0; k < 120; k++) w.step(1 / 60);
  check('smg 手動裝填：R 補滿彈匣、只扣用掉的發數', ok && w.weapons.ammo('smg').mag === 30 && w.weapons.ammo('smg').reserve === before - 5);
  // 瞄準縮小散佈：同狀態下 aiming 偏移上限較小
  const w2 = mkWorld();
  w2.weapons.give('smg');
  w2.equip(3);
  w2.aim.aiming = true;
  for (let i = 0; i < 200 && w2.of('weapon:fire').length < 25; i++) {
    w2.weapons.attack(w2.aim);
    w2.step(1 / 60);
  }
  const dev2 = w2.of('weapon:fire').map((x) => angleTo(x.e.dirX, x.e.dirY, x.e.dirZ) / DEG);
  check('smg 散佈：肩後瞄準 × aimSpreadScale（偏移 ≤ spreadMax × 0.6）', dev2.every((d) => d <= S.spreadMax * S.aimSpreadScale + 1e-6));
}
// P14 審查修正：smg 全自動射速與幀率無關（30 / 60 / 144 fps 各連射 30 發，平均射速誤差 ≤ 0.3 發 / 秒）
{
  const rates = [];
  for (const fps of [30, 60, 144]) {
    const w = mkWorld();
    w.weapons.give('smg');
    w.equip(3);
    w.events.length = 0;
    for (let i = 0; i < fps * 5 && w.of('weapon:fire').length < 30; i++) {
      w.weapons.attack(w.aim);
      w.step(1 / fps);
    }
    const f = w.of('weapon:fire');
    rates.push({ fps, rps: f.length === 30 ? 29 / (f[29].t - f[0].t) : 0 });
  }
  check('smg 射速與幀率無關：30 / 60 / 144 fps 平均射速 10 ± 0.3 發 / 秒', rates.every((r) => Math.abs(r.rps - 1 / S.fireInterval) <= 0.3), rates.map((r) => `${r.fps}fps:${r.rps.toFixed(2)}`).join(' '));
  const spread = Math.max(...rates.map((r) => r.rps)) - Math.min(...rates.map((r) => r.rps));
  check('smg 射速與幀率無關：三種幀率每秒發數差 ≤ 0.3', spread <= 0.3, spread.toFixed(3));
  // 停火後再扣：不會因結轉而縮短間隔（換槍後從扣扳機時刻起算）
  const w = mkWorld();
  w.weapons.give('smg');
  w.equip(3);
  w.weapons.attack(w.aim);
  for (let i = 0; i < 30; i++) w.step(1 / 60);
  w.events.length = 0;
  w.weapons.attack(w.aim);
  w.step(1 / 60);
  w.weapons.attack(w.aim);
  check('smg 停火 0.5 s 後再扣：立即開火、下一發仍需等滿 fireInterval', w.of('weapon:fire').length === 1);
}
// smg 命中角色 / 車輛
{
  const w = mkWorld();
  const ped = mkActor('ped1', 'pedestrian', 0, 10);
  w.combat.register(ped);
  w.scene.spheres.push({ actor: ped, x: 0, y: 1.4, z: 10, r: 1.2 });
  w.weapons.give('smg');
  w.equip(3);
  w.weapons.attack(w.aim);
  w.step(1 / 60);
  check('smg 命中行人：扣 damage 16（weapon smg）', ped.hp === 100 - S.damage && w.combat.stateOf(ped) === 'hit');
  const v = { id: 'car' };
  const w3 = mkWorld();
  w3.scene.spheres.push({ vehicle: v, x: 0, y: 1.4, z: 8, r: 1.5 });
  w3.weapons.give('smg');
  w3.equip(3);
  w3.weapons.attack(w3.aim);
  w3.step(1 / 60);
  const imp = w3.of('weapon:impact');
  check('smg 打車：weapon:impact 帶 vehicle、damage = smg.vehicleDamage', imp.length === 1 && imp[0].e.vehicle === v && imp[0].e.damage === S.vehicleDamage && imp[0].e.surface === 'vehicle');
}

// ======================= 散彈槍 =======================
{
  const w = mkWorld();
  w.scene.walls.push({ z: 10 });
  w.weapons.give('shotgun');
  w.equip(4);
  w.events.length = 0;
  w.weapons.attack(w.aim);
  w.step(1 / 60);
  const imps = w.of('weapon:impact');
  const fires = w.of('weapon:fire');
  const ang = imps.map((x) => angleTo(x.e.x - w.aim.muzzle.x, x.e.y - w.aim.muzzle.y, x.e.z - w.aim.muzzle.z) / DEG);
  check('shotgun 彈丸數：一發 8 顆（牆上 8 個落點，pellet 0–7）', imps.length === 8 && imps.map((x) => x.e.pellet).join() === '0,1,2,3,4,5,6,7');
  check('shotgun 錐角：每顆偏移 ≤ coneDeg（5°）', ang.every((a) => a <= G.coneDeg + 1e-6), ang.map((a) => a.toFixed(2)).join(','));
  check('shotgun 錐角：彈丸確實散開（最大偏移 ≥ coneDeg × 0.6、落點兩兩不同）', Math.max(...ang) >= G.coneDeg * 0.6 && new Set(imps.map((x) => `${x.e.x.toFixed(3)},${x.e.y.toFixed(3)}`)).size === 8);
  check('shotgun：weapon:fire 每扣一次只發一次（pellets 8）', fires.length === 1 && fires[0].e.weapon === 'shotgun' && fires[0].e.pellets === 8);
  check('shotgun：跳彈音效節流（第 2 顆起 quiet）', !imps[0].e.quiet && imps.slice(1).every((x) => x.e.quiet === true));
  // 泵動射速：按住 3 秒約 3 發
  const w2 = mkWorld();
  w2.weapons.give('shotgun');
  w2.equip(4);
  w2.events.length = 0;
  for (let i = 0; i < 180; i++) {
    w2.weapons.attack(w2.aim);
    w2.step(1 / 60);
  }
  const n = w2.of('weapon:fire').length;
  check('shotgun 泵動：按住 3 秒 3 發（約 1 發 / 秒）', n === 3, `${n} 發`);
  check('shotgun 彈匣：6 發、打 3 發剩 3', w2.weapons.ammo('shotgun').mag === 3 && w2.weapons.ammo('shotgun').magSize === 6);
  // 射線重用：每顆彈丸至多 2 次 raycast（鏡頭 + 槍口確認），不多配置
  const w3 = mkWorld();
  w3.weapons.give('shotgun');
  w3.equip(4);
  w3.scene.resetCalls();
  w3.weapons.attack(w3.aim);
  check('shotgun：8 顆彈丸各自射線解算（raycast 8–16 次）', w3.scene.calls >= 8 && w3.scene.calls <= 16, `${w3.scene.calls}`);
}
// 散彈：近距離高傷害可擊倒、遠距離衰減
{
  const w = mkWorld();
  const ped = mkActor('near', 'pedestrian', 0, 4);
  w.combat.register(ped);
  w.scene.spheres.push({ actor: ped, x: 0, y: 1.4, z: 4, r: 1.0 });
  w.weapons.give('shotgun');
  w.equip(4);
  const hits = [];
  w.combat.on('hit', (e) => hits.push(e));
  w.weapons.attack(w.aim);
  w.step(1 / 60);
  check('shotgun 近距（4 m）：8 顆全中合併一次受擊 = 112、weapon shotgun', hits.length === 1 && hits[0].damage === G.pellets * G.pelletDamage && hits[0].weapon === 'shotgun', hits.map((h) => h.damage).join());
  check('shotgun 近距：一槍擊倒（knockdown）', hits.length === 1 && hits[0].knockdown === true && ['knockdown', 'dead'].includes(w.combat.stateOf(ped)));

  const wf = mkWorld();
  const far = mkActor('far', 'pedestrian', 0, 25);
  wf.combat.register(far);
  wf.scene.spheres.push({ actor: far, x: 0, y: 1.4, z: 25, r: 3.0 }); // 大球：8 顆全中，只看衰減
  wf.weapons.give('shotgun');
  wf.equip(4);
  const fh = [];
  wf.combat.on('hit', (e) => fh.push(e));
  wf.weapons.attack(wf.aim);
  wf.step(1 / 60);
  const expect = Math.round(fh.length ? G.pellets * G.pelletDamage * pelletFalloff(fh[0] ? Math.hypot(0, 0, 25 - 3) : 25) : 0);
  check('shotgun 遠距（25 m）：傷害衰減（< 近距 112 的一半）', fh.length === 1 && fh[0].damage < (G.pellets * G.pelletDamage) / 2 && fh[0].damage > 0, `${fh[0] && fh[0].damage}（預期約 ${expect}）`);
  check('shotgun 遠距：不擊倒、hp 未歸零', fh.length === 1 && fh[0].knockdown === false && far.hp > 0 && wf.combat.stateOf(far) === 'hit');

  // 部分彈丸命中（小目標）→ 傷害按顆數
  const wp = mkWorld();
  const thin = mkActor('thin', 'pedestrian', 0, 6);
  wp.combat.register(thin);
  wp.scene.spheres.push({ actor: thin, x: 0, y: 1.4, z: 6, r: 0.2 });
  wp.weapons.give('shotgun');
  wp.equip(4);
  const ph = [];
  wp.combat.on('hit', (e) => ph.push(e));
  wp.weapons.attack(wp.aim);
  wp.step(1 / 60);
  const pf = wp.of('weapon:fire')[0];
  check('shotgun 部分命中：傷害 = 命中顆數 × 14（< 112）、pelletHits 對應', ph.length === 1 && pf.e.pelletHits > 0 && pf.e.pelletHits < 8 && ph[0].damage === pf.e.pelletHits * G.pelletDamage, `${pf && pf.e.pelletHits} 顆 / ${ph[0] && ph[0].damage}`);
}
// 散彈：車輛傷害
{
  const w = mkWorld();
  const v = { id: 'car' };
  w.scene.spheres.push({ vehicle: v, x: 0, y: 1.4, z: 5, r: 2.0 });
  w.weapons.give('shotgun');
  w.equip(4);
  w.weapons.attack(w.aim);
  w.step(1 / 60);
  const imp = w.of('weapon:impact').filter((x) => x.e.vehicle === v);
  const total = imp.reduce((a, x) => a + x.e.damage, 0);
  check('shotgun 打車：8 顆各帶 vehicle / damage 16，合計 128（> 手槍 34 × 3）', imp.length === 8 && imp.every((x) => x.e.damage === G.vehicleDamage) && total === 128 && total > P.vehicleDamage * 3);
  const wp = mkWorld();
  wp.scene.spheres.push({ vehicle: v, x: 0, y: 1.4, z: 5, r: 2.0 });
  wp.equip(2);
  wp.weapons.attack(wp.aim);
  wp.step(1 / 60);
  check('手槍打車：仍為 34（既有行為不變）', wp.of('weapon:impact')[0].e.damage === P.vehicleDamage);
  // P14 審查修正：散彈打車的 vehicleDamage 套與打人同一條距離衰減
  const wf = mkWorld();
  const vf = { id: 'far-car' };
  wf.scene.spheres.push({ vehicle: vf, x: 0, y: 1.4, z: 35, r: 3.0 });
  wf.weapons.give('shotgun');
  wf.equip(4);
  wf.weapons.attack(wf.aim);
  wf.step(1 / 60);
  const fimp = wf.of('weapon:impact').filter((x) => x.e.vehicle === vf);
  const mz = wf.aim.muzzle;
  const ftotal = fimp.reduce((a, x) => a + x.e.damage, 0);
  check('shotgun 遠距（32 m）打車：每顆 damage = round(16 × pelletFalloff(距離))、合計 < 手槍 34',
    fimp.length === 8 && fimp.every((x) => x.e.damage === Math.round(G.vehicleDamage * pelletFalloff(Math.hypot(x.e.x - mz.x, x.e.y - mz.y, x.e.z - mz.z), G))) && ftotal < P.vehicleDamage, `${fimp.map((x) => x.e.damage).join(',')} 合計 ${ftotal}`);
}
// P14 審查修正：散彈遠距擦傷不累積擊倒連擊（近距離有效命中才累積）
{
  const w = mkWorld();
  const ped = mkActor('graze', 'pedestrian', 0, 33);
  w.combat.register(ped);
  w.scene.spheres.push({ actor: ped, x: 0, y: 1.4, z: 33, r: 3.0 });
  w.weapons.give('shotgun');
  w.equip(4);
  const hs = [];
  w.combat.on('hit', (e) => hs.push(e));
  for (let i = 0; i < 90 && hs.length < 2; i++) {
    w.weapons.attack(w.aim);
    w.step(1 / 60);
  }
  check('shotgun 遠距（30 m）1.5 s 內連兩槍擦傷：扣血但不擊倒', hs.length === 2 && hs.every((h) => h.damage < G.comboDamage && h.knockdown === false) && ped.hp === 100 - hs[0].damage - hs[1].damage && w.combat.stateOf(ped) === 'hit', hs.map((h) => `${h.damage}/${h.knockdown}`).join(' '));
  const c = new CombatSystem({ now: () => 0, bus: null });
  const a = mkActor('a', 'player', 0, 0);
  const b = mkActor('b', 'pedestrian', 0, 3);
  const d = mkActor('d', 'pedestrian', 3, 0);
  for (const x of [a, b, d]) c.register(x);
  const r1 = [c.applyHit({ attacker: a, target: b, damage: 5, weapon: 'shotgun', combo: false }), c.applyHit({ attacker: a, target: b, damage: 5, weapon: 'shotgun', combo: false })];
  const r2 = [c.applyHit({ attacker: a, target: d, damage: 50, weapon: 'shotgun' }), c.applyHit({ attacker: a, target: d, damage: 45, weapon: 'shotgun' })];
  check('combat.applyHit combo: false 不計連擊；有效命中（預設）兩次仍擊倒', r1.every((r) => r && !r.knockdown) && !r2[0].knockdown && r2[1].knockdown);
}
// 手槍行為不變：無散佈、後座亂數序列同舊版（同一 rng 下前 5 發 recoil yaw 相同）
{
  const run = () => {
    const w = mkWorld();
    w.equip(2);
    const yaws = [];
    const dirs = [];
    for (let i = 0; i < 5; i++) {
      w.weapons.attack(w.aim);
      const k = w.weapons.recoilKick();
      yaws.push(k.yaw.toFixed(6));
      for (let s = 0; s < 20; s++) w.step(1 / 60);
    }
    for (const f of w.of('weapon:fire')) dirs.push(angleTo(f.e.dirX, f.e.dirY, f.e.dirZ));
    return { yaws, dirs, w };
  };
  const a = run();
  check('手槍：無散佈（方向 = 瞄準方向）', a.dirs.length === 5 && a.dirs.every((d) => d < 1e-9));
  check('手槍：備彈無限（ammo().reserve = Infinity）、addAmmo 回 0', a.w.weapons.ammo().reserve === Infinity && a.w.weapons.addAmmo(10) === 0);
}

// ======================= 彈藥 HUD / 拾取 =======================
{
  check('HUD ammoText：三把槍都顯示「彈匣 / 備彈」，空手 / 球棒空字串', ammoText('smg', 30, 90) === '30 / 90' && ammoText('shotgun', 6, 18) === '6 / 18' && ammoText('pistol', 12, '∞') === '12 / ∞' && ammoText('bat', 1, 2) === '' && ammoText('fist', 1, 2) === '');
  const w = mkWorld();
  w.weapons.give('smg');
  w.equip(3);
  const a = w.weapons.ammo();
  check('weapons.ammo()：手上 smg → smg 彈藥（weapon / magSize 30）；手上空手 → 手槍（相容）', a.weapon === 'smg' && a.magSize === 30 && (w.equip(0), w.weapons.ammo().weapon === 'pistol' && w.weapons.ammo().magSize === 12));
  check('addAmmo(n, smg)：加入備彈、上限 reserveMax', w.weapons.addAmmo(30, 'smg') === 30 && w.weapons.ammo('smg').reserve === 120 && w.weapons.addAmmo(9999, 'smg') === S.reserveMax - 120);
  check('addAmmo：未擁有的 shotgun → 0', w.weapons.addAmmo(6, 'shotgun') === 0);
  const hudSrc = read('src/weapons/hud.js');
  check('hud.js：槍械判定用 isGun（彈藥 / 準星 / 裝填鈕）、輪盤角度表 wheelAngles、鍵位提示 4 / 5', hudSrc.includes('const pistol = isGun(id);') && hudSrc.includes('wheelAngles(ownedFlags)') && hudSrc.includes('weaponKeyHints(true)') && hudSrc.includes('SLOT_KEYS[i]'));
  const pkSrc = read('src/weapons/pickups.js');
  check('pickups.js：點位 weapon / amount、pickup:ammo 帶 weapon、canPickup(weapon)、hideUnavailable', pkSrc.includes("bus.emit('pickup:ammo', { amount: p.amount, x: p.x, z: p.z, weapon: p.weapon })") && pkSrc.includes('canPickup(p.weapon)') && pkSrc.includes('hideUnavailable'));
  const mdSrc = read('src/weapons/models.js');
  check('models.js：smg / shotgun 載入（manifest 長槍項）+ 佔位長槍', mdSrc.includes('normalizeLongGunManifest') && mdSrc.includes("placeholderLongGun('smg')") && mdSrc.includes('return { bat: bat.model, pistol: pistol.model, smg: smg.model, shotgun: shotgun.model };'));
  const manifest = JSON.parse(read('public/models/weapons/manifest.json'));
  const ms = manifest.weapons.find((x) => x.id === 'smg');
  const mg = manifest.weapons.find((x) => x.id === 'shotgun');
  check('manifest：smg 0.454 m / shotgun 1.018 m 已含 offHandOffset（雙手扶握點）', ms && mg && near(ms.length, 0.454, 0.001) && near(mg.length, 1.018, 0.001) && Array.isArray(ms.offHandOffset) && Array.isArray(mg.offHandOffset));
  const voices = read('src/audio/voices.js');
  const audio = read('src/audio/index.js');
  check('音效：gunshot 配方依 weapon 區分 smg / shotgun（合成音）、weapon:fire 傳 weapon', voices.includes("o.weapon === 'smg'") && voices.includes("o.weapon === 'shotgun'") && audio.includes("play('gunshot', { x: e.x, z: e.z, weapon: e.weapon })"));
  const gp = read('src/gamepad.js');
  check('手把：十字鍵 ← 讀 getPrevSlot（跳過未購買）、→ = KeyQ 循環', gp.includes('opts.getPrevSlot') && gp.includes('return `Digit${prev + 1}`;') && gp.includes("if (i === PAD.RIGHT) return 'KeyQ';"));
}

// ======================= 存檔相容 =======================
{
  const d = defaultSave();
  check('存檔：defaultSave.weapons 不含新欄位（舊格式）', JSON.stringify(d.weapons) === JSON.stringify({ slot: 0, ammo: { pistol: { mag: 12, reserve: 36 } } }));
  const w = mkWorld();
  check('存檔：未買長槍時 serialize 與舊格式相同', JSON.stringify(w.weapons.serialize()) === JSON.stringify({ slot: 0, ammo: { pistol: { mag: 12, reserve: 36 } } }));
  check('存檔：舊存檔 slot 3（無 owned）→ 0', validateSave({ version: 2, weapons: { slot: 3 } }).weapons.slot === 0);
  w.weapons.give('smg');
  w.weapons.give('shotgun');
  w.equip(4);
  w.weapons.attack(w.aim);
  for (let i = 0; i < 10; i++) w.step(1 / 60);
  const ser = w.weapons.serialize();
  check('存檔：serialize 含 owned / smg / shotgun 彈藥', ser.owned.join() === 'smg,shotgun' && ser.ammo.shotgun.mag === 5 && ser.ammo.smg.mag === 30 && ser.slot === 4);
  const store = createSaveStore({ storage: (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })() });
  store.save({ ...defaultSave(), weapons: ser });
  const r = store.load();
  check('存檔：存讀往返保留 owned / slot 4 / 各槍彈藥', r.status === 'ok' && r.data.weapons.slot === 4 && r.data.weapons.owned.join() === 'smg,shotgun' && r.data.weapons.ammo.shotgun.mag === 5 && r.data.weapons.ammo.smg.reserve === S.startReserve);
  const w2 = mkWorld();
  w2.weapons.restore(r.data.weapons);
  check('存檔：restore 後擁有兩把長槍、手上散彈槍、彈藥一致', w2.weapons.owns('smg') && w2.weapons.owns('shotgun') && w2.weapons.current === 'shotgun' && w2.weapons.ammo('shotgun').mag === 5);
  const bad = validateSave({ version: 2, weapons: { slot: 4, owned: ['smg', 'rifle', 'smg'], ammo: { smg: { mag: 99, reserve: 9999 }, shotgun: { mag: 3 } } } });
  check('存檔清洗：owned 只收 smg / shotgun 去重、未擁有的槽 4 → 0、未擁有槍的彈藥丟棄、clamp 上限', bad.weapons.owned.join() === 'smg' && bad.weapons.slot === 0 && !('shotgun' in bad.weapons.ammo) && bad.weapons.ammo.smg.mag === 30 && bad.weapons.ammo.smg.reserve === 300);
  check('存檔清洗：owned 非陣列 → 省略', !('owned' in validateSave({ version: 2, weapons: { owned: 'smg' } }).weapons));
  check('存檔清洗：owned 有槍但缺彈藥 → 滿彈匣 + 附贈備彈', JSON.stringify(validateSave({ version: 2, weapons: { owned: ['shotgun'] } }).weapons.ammo.shotgun) === JSON.stringify({ mag: 6, reserve: 18 }));
  const saveSrc = read('src/save.js');
  const lim = /smg: \{ slot: (\d), mag: (\d+), reserveMax: (\d+), reserve: (\d+) \},\s*shotgun: \{ slot: (\d), mag: (\d+), reserveMax: (\d+), reserve: (\d+) \}/.exec(saveSrc);
  check('存檔上限與 defs 一致（smg / shotgun 槽位、彈匣、備彈上限、附贈備彈）', !!lim && +lim[1] === S.slot && +lim[2] === S.magSize && +lim[3] === S.reserveMax && +lim[4] === S.startReserve && +lim[5] === G.slot && +lim[6] === G.magSize && +lim[7] === G.reserveMax && +lim[8] === G.startReserve);
  const w3 = mkWorld();
  w3.weapons.restore({ slot: 2, ammo: { pistol: { mag: 4, reserve: 60 } } });
  check('存檔：舊格式 restore（無 owned）→ 長槍未擁有、手槍彈藥保留', !w3.weapons.owns('smg') && !w3.weapons.owns('shotgun') && w3.weapons.current === 'pistol' && w3.weapons.ammo('pistol').mag === 4);
}

// ======================= 效能限制（原始碼）=======================
{
  const src = read('src/weapons/weapons.js');
  const body = src.slice(src.indexOf('function attackShotgun'), src.indexOf('function attack(aim)'));
  const loop = body.slice(body.indexOf('for (let i = 0; i < D.pellets; i++) {'), body.indexOf('g.mag--;'));
  check('散彈彈丸迴圈重用射線物件（resolveShot 共用 shot / pelletDir，迴圈內除事件 payload 外無 { } / new）', loop.includes('resolveShot(raycast, a.origin, pelletDir, mz, D.range, actor, shot, rayOpts)') && !/new [A-Z]/.test(loop) && (loop.match(/\{\s*\n?\s*x: shot\.point\.x/g) || []).length === 1);
  check('散彈命中彙整預先配置（pelHits / hitArgs 在 createWeapons 建立時配置）', src.includes('for (let i = 0; i < SG.pellets; i++) pelHits.push(') && src.includes('const hitArgs = {'));
  const files = ['src/weapons/weapons.js', 'src/weapons/aim.js', 'src/weapons/defs.js', 'src/shops/gun-shop.js', 'src/shops/safehouse.js'];
  check('純邏輯檔不 import three / rapier', files.every((f) => !/^import [^\n]*(three|rapier)/m.test(read(f))));
  const added = ['src/weapons/models.js', 'src/shops/gun-shop.js', 'src/shops/safehouse.js'].map(read).join('\n');
  check('不新增 shadow map / 貼圖（castShadow / map: / Texture）', !/castShadow\s*=\s*true|shadowMap|new THREE\.\w*Texture|\bmap:\s/.test(added));
}

console.log(`${failed === 0 ? 'PASS' : 'FAIL'} ${failed === 0 ? passed : failed}/${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
