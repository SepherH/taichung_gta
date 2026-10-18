#!/usr/bin/env node
// V2 幫派地盤無頭測試（src/gangs.js 純邏輯 + npc-ai override 掛鉤 + combat throughVehicle；不需 three / rapier）
// 用法：node tools/test/v2-gangs.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：地盤多邊形有效 / 在地圖界內 / 互不重疊 / 包含對應地標、territoryAt、成員比例與成群、敵意三條件（逗留 6 m 3 s / 瞄準 / 攻擊）與衰減、
//   圍攻分工（近戰衝上來出拳揮棒 / 持槍者保持距離射擊）、車內受擊（throughVehicle）、開車掃射觸發與冷卻、死亡被捕歸零（cancel + main.js 接線）、
//   凍結、幀率無關、每幀不配置物件（穩態無 GC）、high tier 每幀純邏輯成本 < 0.5 ms、大地圖色塊、模組不 import three
import { register } from 'node:module';

const HOOK = `
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function load(url, context, next) {
  if (url.endsWith('.json')) {
    return { format: 'module', shortCircuit: true, source: 'export default ' + readFileSync(fileURLToPath(url), 'utf8') + ';' };
  }
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
  return next(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(HOOK)}`, import.meta.url);

const fs = await import('node:fs');
const path = await import('node:path');
const { spawnSync } = await import('node:child_process');
const { fileURLToPath } = await import('node:url');
const { performance } = await import('node:perf_hooks');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const G = await import('../../src/gangs.js');
const { GANGS, GANG_ZONES, DEFAULTS, createGangs, territoryAt, polygonValid, polygonsOverlap, leaderChance, shotHitChance } = G;
const { NpcBrain, mulberry32 } = await import('../../src/npc-ai.js');
const { CombatSystem } = await import('../../src/combat.js');
const { createBus } = await import('../../src/core/events.js');
const { BOUNDS, namedBuildings, parks } = await import('../../src/citymodel.js');
const { polygonCentroid, pointInPolygon } = await import('../../src/geom.js');
const { drawBigMap } = await import('../../src/map/big-map.js');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------- 替身 ----------
function makeActor(id, x, z, kind = 'pedestrian') {
  const calls = { upper: [], trigger: [] };
  return {
    id,
    kind,
    pos: { x, y: 0, z },
    yaw: 0,
    hp: 100,
    maxHp: 100,
    calls,
    anim: {
      state: 'idle',
      trigger(n) {
        calls.trigger.push(n);
        return true;
      },
      on: () => () => {},
      playUpper(n) {
        calls.upper.push(n);
        return 0.7;
      },
    },
    body: { knockdown() {}, settleCheck: () => ({ settled: true, clearToStand: true }), standUp() {} },
  };
}
function fakeCombat() {
  const c = {
    hits: [],
    punches: [],
    down: new Set(),
    seq: 0,
    isDown: (a) => c.down.has(a),
    requestPunch(a) {
      c.punches.push(a);
      return true;
    },
    applyHit(o) {
      c.hits.push({ ...o, dir: { ...o.dir } });
      return { damage: o.damage, hp: 0, side: 'front', knockdown: false, inVehicle: !!o.throughVehicle };
    },
    newSwingId: () => ++c.seq,
  };
  return c;
}
// 成員：市民 c 套 onSpawn / onCrew 換裝 → onAttach（骨架 p，大腦 = 真的 NpcBrain）
function makeMember(gangs, def, x, z, weapon, { rival = false, crew = null } = {}) {
  const id = `m-${def.id}-${weapon}-${x}-${z}-${Math.random()}`;
  const actor = makeActor(id, x, z);
  const brain = new NpcBrain({ actor, seed: 7 });
  const c = { x, z, look: { shirt: '#fff' }, gang: { id: def.id, def, crew: crew ?? Math.floor(Math.random() * 1e6), rival, weapon } };
  const p = { citizen: c, actor, brain };
  actor.ped = p;
  gangs.pedHooks.onAttach(p);
  return { actor, brain, p, m: gangs.members.find((mm) => mm.actor === actor) };
}
function fakeCars() {
  const w = {
    spawned: [],
    despawned: [],
    drives: 0,
    brakes: 0,
    aliveFlag: true,
    nextPos: null,
    spawn(def, px, pz) {
      const car = { def, pos: w.nextPos ? { ...w.nextPos } : { x: px + 100, y: 0, z: pz } };
      w.spawned.push(car);
      return car;
    },
    alive: () => w.aliveFlag,
    drive() {
      w.drives++;
    },
    brake() {
      w.brakes++;
    },
    despawn(car, now) {
      w.despawned.push({ car, now: !!now });
    },
    update() {},
    cancel() {},
  };
  return w;
}
function capture(bus, names) {
  const ev = [];
  for (const n of names) bus.on(n, (e) => ev.push({ ...e, evt: n }));
  return ev;
}
const [NM, QH, SU] = GANGS;
const centerOf = (g) => polygonCentroid(g.territory);
function playerCtx(x, z, extra = {}) {
  const actor = makeActor('player', x, z, 'player');
  return { x, z, actor, inVehicle: false, aiming: false, aimDirX: 0, aimDirZ: 1, disabled: false, ...extra };
}
function run(gangs, ctx, sec, dt = 1 / 60, each = null) {
  const n = Math.round(sec / dt);
  for (let i = 0; i < n; i++) {
    gangs.update(dt, ctx);
    if (each) each(i * dt + dt);
  }
}

// ---------- 1. 地盤多邊形 ----------
console.log('— 地盤多邊形');
check('三個幫派、id / 名稱 / 顏色齊全', GANGS.length === 3 && GANGS.every((g) => g.id && g.name && /^#[0-9a-f]{6}$/i.test(g.color) && g.outfit && g.outfit.shirts.length));
check('名稱為規格的虛構幫派', ['夜市角頭', '秋紅谷飆車族', '七期西裝幫'].every((n) => GANGS.some((g) => g.name === n)));
check('多邊形有效（≥3 點、不自交、面積 > 0）', GANGS.every((g) => polygonValid(g.territory)));
check('多邊形全部頂點在地圖界內', GANGS.every((g) => {
  for (let i = 0; i < g.territory.length; i += 2) {
    const x = g.territory[i];
    const z = g.territory[i + 1];
    if (x < BOUNDS.minX || x > BOUNDS.maxX || z < BOUNDS.minZ || z > BOUNDS.maxZ) return false;
  }
  return true;
}));
let overlap = false;
for (let i = 0; i < GANGS.length; i++) for (let j = i + 1; j < GANGS.length; j++) if (polygonsOverlap(GANGS[i].territory, GANGS[j].territory)) overlap = true;
check('三塊地盤兩兩不重疊', !overlap);
check('polygonsOverlap 自我檢查（重疊方形 → true）', polygonsOverlap([0, 0, 10, 0, 10, 10, 0, 10], [5, 5, 15, 5, 15, 15, 5, 15]) && !polygonsOverlap([0, 0, 10, 0, 10, 10, 0, 10], [20, 0, 30, 0, 30, 10, 20, 10]));
const bld = (name) => namedBuildings.find((b) => b.name === name);
const inT = (g, pt) => !!pt && pointInPolygon(pt.x, pt.z, g.territory);
check('夜市角頭地盤含新光三越與 Top City 大遠百（夜市外送取餐點商圈）', inT(NM, polygonCentroid(bld('新光三越').poly)) && inT(NM, polygonCentroid(bld('Top City台中大遠百').poly)) && inT(NM, { x: 557.2, z: -125.1 }));
const qhg = parks.find((p) => p.name === '秋紅谷廣場');
check('秋紅谷飆車族地盤含秋紅谷廣場', !!qhg && inT(QH, polygonCentroid(qhg.poly)));
check('七期西裝幫地盤含臺灣大道市政大樓與市議會', inT(SU, polygonCentroid(bld('臺中市政府臺灣大道市政大樓').poly)) && inT(SU, polygonCentroid(bld('臺中市議會').poly)));
check('出生點老虎城（原點）不在任何地盤', territoryAt(0, 0) === null);
check('GANG_ZONES 與 GANGS 一一對應（poly / color / label）', GANG_ZONES.length === 3 && GANG_ZONES.every((z, i) => z.poly === GANGS[i].territory && z.color === GANGS[i].color && z.label.includes(GANGS[i].name)));

// ---------- 2. territoryAt ----------
console.log('— territoryAt');
check('各地盤中心點 → 該幫', GANGS.every((g) => { const c = centerOf(g); return territoryAt(c.x, c.z) === g; }));
check('地圖角落 / 界外 → null', territoryAt(BOUNDS.minX + 1, BOUNDS.minZ + 1) === null && territoryAt(5000, 5000) === null);
{
  const gangs = createGangs({});
  const c = centerOf(SU);
  check('createGangs().territoryAt 同一實作', gangs.territoryAt(c.x, c.z) === SU && gangs.territoryAt(0, 0) === null);
}

// ---------- 3. 成員比例與成群 ----------
console.log('— 成員比例');
{
  const rng = mulberry32(12345);
  const gangs = createGangs({ rng });
  let total = 0;
  let members = 0;
  let crews = 0;
  let rivals = 0;
  let badSize = 0;
  let wrongLook = 0;
  const c0 = centerOf(NM);
  for (let i = 0; i < 6000; i++) {
    const c = { x: c0.x + (rng() - 0.5) * 100, z: c0.z + (rng() - 0.5) * 100, look: { shirt: '#ffffff', pants: '#2b2f3a', skin: '#f1c9a5', height: 1.7 } };
    const extra = gangs.pedHooks.onSpawn(c);
    total += 1 + extra;
    if (!c.gang) {
      if (extra !== 0) badSize++;
      continue;
    }
    crews++;
    if (extra < 1 || extra > 3) badSize++;
    if (c.gang.rival) rivals++;
    const def = c.gang.def;
    if (!def.outfit.shirts.includes(c.look.shirt) || c.look.pants !== def.outfit.pants || c.look.skin !== '#f1c9a5') wrongLook++;
    members += 1 + extra;
    for (let k = 0; k < extra; k++) {
      const m = { x: c.x, z: c.z, look: { shirt: '#ffffff' } };
      gangs.pedHooks.onCrew(m, c);
      if (!m.gang || m.gang.crew !== c.gang.crew || m.gang.id !== c.gang.id) wrongLook++;
    }
  }
  const share = members / total;
  check(`地盤內成員比例 25–35%（${(share * 100).toFixed(1)}%）`, share >= 0.25 && share <= 0.35);
  check('一群 2–4 人（帶頭者 + 1–3 同夥）', badSize === 0 && crews > 100);
  check('成員換幫派配色（shirt / pants，膚色保留）、同夥同幫同 crew', wrongLook === 0);
  check(`入侵的敵對幫派 crew 約 10%（${((rivals / crews) * 100).toFixed(1)}%）`, rivals / crews > 0.04 && rivals / crews < 0.18);
  let outside = 0;
  for (let i = 0; i < 500; i++) {
    const c = { x: (rng() - 0.5) * 60, z: (rng() - 0.5) * 60, look: {} };
    outside += gangs.pedHooks.onSpawn(c) + (c.gang ? 1 : 0);
  }
  check('地盤外不生成成員', outside === 0);
  check('leaderChance 反推一致（30% / crew 2–4 → 0.125）', Math.abs(leaderChance(0.3, 2, 4) - 0.125) < 1e-9);
  const weapons = { pistol: 0, bat: 0, fist: 0 };
  for (let i = 0; i < 3000; i++) {
    const c = { x: c0.x, z: c0.z, look: {} };
    if (gangs.pedHooks.onSpawn(c) && c.gang) weapons[c.gang.weapon]++;
  }
  const wn = weapons.pistol + weapons.bat + weapons.fist;
  check('部分持手槍 / 球棒（各 20–45%）', weapons.pistol / wn > 0.2 && weapons.pistol / wn < 0.45 && weapons.bat / wn > 0.2 && weapons.bat / wn < 0.5 && weapons.fist > 0);
}

// ---------- 4. 敵意三條件 ----------
console.log('— 敵意觸發');
{
  // ① 逗留：地盤內 6 m 內停留 3 s
  const bus = createBus();
  const ev = capture(bus, ['gang:enter', 'gang:hostile']);
  const gangs = createGangs({ bus, rng: mulberry32(1) });
  const c = centerOf(QH);
  const mem = makeMember(gangs, QH, c.x + 4, c.z, 'fist');
  const pl = playerCtx(c.x, c.z);
  const ctx = { combat: fakeCombat(), player: pl };
  run(gangs, ctx, 2.7);
  check('進入地盤 → gang:enter（名稱）', ev.some((e) => e.evt === 'gang:enter' && e.gang === 'qiuhonggu' && e.name === '秋紅谷飆車族'));
  check('逗留未滿 3 s 不起敵意', gangs.hostility('qiuhonggu') === 0);
  run(gangs, ctx, 0.6);
  check('6 m 內停留 3 s → 敵意 ≥ hostileAt、gang:hostile', gangs.hostility('qiuhonggu') >= DEFAULTS.hostileAt && ev.some((e) => e.evt === 'gang:hostile' && e.hostile && e.cause === 'linger'));
  check('敵意後附近成員加入圍攻', mem.m.engaged && mem.m.target === pl.actor);
  check('別幫不受影響', gangs.hostility('suits') === 0 && gangs.hostility('nightmarket') === 0);

  const g2 = createGangs({ bus: createBus(), rng: mulberry32(2) });
  makeMember(g2, QH, c.x + 7, c.z, 'fist');
  run(g2, { combat: fakeCombat(), player: playerCtx(c.x, c.z) }, 10);
  check('7 m 外停留 10 s 不起敵意', g2.hostility('qiuhonggu') === 0);
  const g3 = createGangs({ bus: createBus(), rng: mulberry32(3) });
  makeMember(g3, QH, c.x + 3, c.z, 'fist');
  run(g3, { combat: fakeCombat(), player: playerCtx(c.x, c.z, { inVehicle: true }) }, 10);
  check('開車經過（車內）不算逗留', g3.hostility('qiuhonggu') === 0);
  // 成員在地盤內、玩家在地盤外（同幫成員 6 m 內）→ 不算（規格：在地盤內）
  const g4 = createGangs({ bus: createBus(), rng: mulberry32(4) });
  makeMember(g4, NM, 2, 0, 'fist');
  run(g4, { combat: fakeCombat(), player: playerCtx(0, 0) }, 10);
  check('地盤外靠近成員不算逗留', g4.hostility('nightmarket') === 0);
}
{
  // ② 掏槍瞄準
  const bus = createBus();
  const ev = capture(bus, ['gang:hostile']);
  const gangs = createGangs({ bus, rng: mulberry32(5) });
  const c = centerOf(SU);
  makeMember(gangs, SU, c.x, c.z + 15, 'pistol');
  const pl = playerCtx(c.x, c.z, { aiming: true, aimDirX: 1, aimDirZ: 0 });
  const ctx = { combat: fakeCombat(), player: pl };
  run(gangs, ctx, 1);
  check('瞄準方向偏離成員 → 不起敵意', gangs.hostility('suits') === 0);
  pl.aimDirX = 0;
  pl.aimDirZ = 1;
  run(gangs, ctx, 0.3);
  check('對成員掏槍瞄準 → 敵意 ≥ hostileAt（cause aim）', gangs.hostility('suits') >= DEFAULTS.hostileAt && ev.some((e) => e.cause === 'aim'));
  const g2 = createGangs({ bus: createBus(), rng: mulberry32(6) });
  makeMember(g2, SU, c.x, c.z + 15, 'pistol');
  run(g2, { combat: fakeCombat(), player: playerCtx(c.x, c.z, { aiming: false, aimDirX: 0, aimDirZ: 1 }) }, 1);
  check('沒按瞄準（同方向）不算', g2.hostility('suits') === 0);
}
{
  // ③ 攻擊任何成員（combat:hit / ped:knockdown / ped:dead，byPlayer）
  const bus = createBus();
  const ev = capture(bus, ['gang:hostile']);
  const gangs = createGangs({ bus, rng: mulberry32(7) });
  const pl = playerCtx(0, 0);
  const mem = makeMember(gangs, NM, 3, 0, 'bat'); // 地盤外的成員也算
  gangs.update(1 / 60, { combat: fakeCombat(), player: pl });
  bus.emit('combat:hit', { byPlayer: false, target: mem.actor, attacker: makeActor('x', 0, 0) });
  check('非玩家打成員不算', gangs.hostility('nightmarket') === 0);
  bus.emit('combat:hit', { byPlayer: true, target: mem.actor, attacker: pl.actor });
  check('玩家打成員 → 敵意滿、gang:hostile cause attack、被打者反擊', gangs.hostility('nightmarket') === DEFAULTS.maxHostility && ev.some((e) => e.cause === 'attack') && mem.m.engaged && mem.m.target === pl.actor);
  const g2 = createGangs({ bus: createBus(), rng: mulberry32(8) });
  const b2 = createBus();
  const g3 = createGangs({ bus: b2, rng: mulberry32(9) });
  const m3 = makeMember(g3, QH, 5, 5, 'fist');
  g3.update(1 / 60, { combat: fakeCombat(), player: pl });
  b2.emit('ped:knockdown', { ped: m3.actor, cause: 'vehicle', byPlayer: true });
  check('開車撞倒成員（ped:knockdown byPlayer）→ 敵意', g3.hostility('qiuhonggu') === DEFAULTS.maxHostility);
  check('dispose 後不再訂閱', (g2.dispose(), true));
}
{
  // 衰減：地盤內 decayDelay 秒後每秒 −decayIn；地盤外每秒 −decayOut；低於 calmBelow 收手
  const bus = createBus();
  const ev = capture(bus, ['gang:hostile']);
  const gangs = createGangs({ bus, rng: mulberry32(10) });
  const c = centerOf(QH);
  const mem = makeMember(gangs, QH, c.x + 30, c.z, 'fist');
  const pl = playerCtx(c.x, c.z);
  const ctx = { combat: fakeCombat(), player: pl };
  gangs.update(1 / 60, ctx);
  bus.emit('combat:hit', { byPlayer: true, target: mem.actor, attacker: pl.actor });
  run(gangs, ctx, DEFAULTS.decayDelay - 1);
  check('地盤內挑釁後 decayDelay 秒內不衰減', gangs.hostility('qiuhonggu') === 100);
  run(gangs, ctx, 6);
  const h1 = gangs.hostility('qiuhonggu');
  check(`之後以 decayIn 衰減（${h1.toFixed(2)}）`, Math.abs(h1 - (100 - DEFAULTS.decayIn * 5)) < 0.2);
  pl.x = 0;
  pl.z = 0;
  run(gangs, ctx, 5);
  const h2 = gangs.hostility('qiuhonggu');
  check(`離開地盤以 decayOut 衰減（${h2.toFixed(2)}）`, Math.abs(h2 - (h1 - DEFAULTS.decayOut * 5)) < 0.5);
  run(gangs, ctx, 20);
  check('衰減到 calmBelow 以下 → gang:hostile false、成員收手', gangs.hostility('qiuhonggu') < DEFAULTS.calmBelow && ev.some((e) => e.hostile === false) && !mem.m.engaged);
  check('收手後大腦回 wander', mem.brain.update(0.1, { combat: ctx.combat }).mode === 'wander');
}

// ---------- 5. 圍攻分工 ----------
console.log('— 圍攻分工');
{
  const bus = createBus();
  const fires = capture(bus, ['weapon:fire']);
  const gangs = createGangs({ bus, rng: mulberry32(11) });
  const combat = fakeCombat();
  const c = centerOf(NM);
  const pl = playerCtx(c.x, c.z);
  const ctx = { combat, player: pl };
  const fist = makeMember(gangs, NM, c.x + 10, c.z, 'fist');
  const bat = makeMember(gangs, NM, c.x, c.z + 1.2, 'bat');
  const gun = makeMember(gangs, NM, c.x - 20, c.z, 'pistol');
  gangs.update(1 / 60, ctx);
  bus.emit('combat:hit', { byPlayer: true, target: fist.actor, attacker: pl.actor });
  check('敵意後三人都加入圍攻', [fist, bat, gun].every((m) => m.m.engaged && m.m.target === pl.actor));
  const bctx = { combat };
  let it = fist.brain.update(0.1, bctx);
  check('近戰（10 m）衝上來：朝玩家跑、mode gang', it.mode === 'gang' && it.run && it.moveX < -0.99);
  fist.actor.pos.x = c.x + 0.8;
  let punched = false;
  for (let i = 0; i < 20; i++) {
    it = fist.brain.update(0.1, bctx);
    if (it.wantPunch) punched = true;
  }
  check('近戰貼身出拳（combat.requestPunch）', punched && combat.punches.includes(fist.actor) && it.moveX === 0 && it.moveZ === 0);
  bat.actor.yaw = Math.PI; // 面向玩家（traffic 依 faceYaw 轉身；替身不轉）
  for (let i = 0; i < 10; i++) bat.brain.update(0.1, bctx);
  const batHit = combat.hits.find((h) => h.attacker === bat.actor);
  check('球棒：揮棒動作 + 延遲後 applyHit（weapon bat）', bat.actor.calls.upper.some((n) => n.startsWith('bat_swing')) && !!batHit && batHit.weapon === 'bat' && batHit.target === pl.actor);
  it = gun.brain.update(0.1, bctx);
  check('持槍者（20 m）靠近到射程', it.run && it.moveX > 0.99);
  gun.actor.pos.x = c.x - 3;
  it = gun.brain.update(0.1, bctx);
  check('持槍者（3 m）後退拉開距離', it.moveX < -0.99 && !it.run);
  gun.actor.pos.x = c.x - 10;
  const before = combat.hits.filter((h) => h.weapon === 'pistol').length;
  let still = true;
  for (let i = 0; i < 40; i++) {
    it = gun.brain.update(0.1, bctx);
    if (it.moveX !== 0 || it.moveZ !== 0) still = false;
  }
  const shots = fires.filter((e) => e.shooter === gun.actor);
  check('持槍者（10 m）站定面向玩家射擊', still && it.faceYaw !== null && Math.abs(it.faceYaw - Math.PI / 2) < 1e-6 && shots.length >= 2);
  check('開槍：weapon:fire（byPlayer false、gang id）、命中走 combat.applyHit pistol', shots.every((e) => !e.byPlayer && e.gang === 'nightmarket' && e.weapon === 'pistol') && combat.hits.filter((h) => h.weapon === 'pistol').length >= before);
  check('射擊間隔 fireMin–fireMax（4 s 內 2–5 發）', shots.length >= 2 && shots.length <= 5);
  // 刺激被 override 吃掉：被打不逃跑
  gun.brain.onAttacked({ attacker: pl.actor, weapon: 'pistol' });
  it = gun.brain.update(0.1, bctx);
  check('圍攻中被槍擊不逃跑（刺激丟棄、維持 gang）', it.mode === 'gang' && gun.brain.state === 'gang');
  // 目標倒地：圍著看不出手
  combat.down.add(pl.actor);
  const n0 = combat.punches.length;
  for (let i = 0; i < 20; i++) fist.brain.update(0.1, bctx);
  check('玩家倒地 → 不再出拳', combat.punches.length === n0);
  combat.down.delete(pl.actor);
  // 玩家在車內：近戰追到車旁不出拳、持槍者照打（throughVehicle）
  pl.inVehicle = true;
  const n1 = combat.punches.length;
  for (let i = 0; i < 20; i++) fist.brain.update(0.1, bctx);
  const carShot = combat.hits.length;
  for (let i = 0; i < 30; i++) gun.brain.update(0.1, bctx);
  const carHits = combat.hits.slice(carShot).filter((h) => h.weapon === 'pistol');
  check('玩家在車內：近戰不出拳', combat.punches.length === n1);
  check('玩家在車內：槍手命中走 throughVehicle', carHits.length > 0 && carHits.every((h) => h.throughVehicle === true));
  pl.inVehicle = false;
}
{
  // 真 CombatSystem：throughVehicle
  const combat = new CombatSystem({ now: () => 0, bus: null });
  const p = makeActor('pl', 0, 0, 'player');
  p.untargetable = true;
  combat.register(p);
  const hitEv = [];
  combat.on('hit', (e) => hitEv.push(e));
  check('untargetable 一般 applyHit 照舊回 null', combat.applyHit({ target: p, damage: 10, weapon: 'pistol' }) === null && p.hp === 100);
  const r = combat.applyHit({ target: p, damage: 10, weapon: 'pistol', dir: { x: 1, z: 0 }, throughVehicle: true });
  check('throughVehicle：扣血、不硬直、hit 事件 inVehicle', !!r && r.inVehicle && p.hp === 90 && combat.stateOf(p) === 'normal' && hitEv.length === 1 && hitEv[0].inVehicle && hitEv[0].knockback === null && !p.calls.trigger.includes('hit'));
  p.untargetable = false;
  const r2 = combat.applyHit({ target: p, damage: 10, weapon: 'pistol', throughVehicle: true });
  check('非車內時 throughVehicle 無作用（一般受擊）', !!r2 && !r2.inVehicle && combat.stateOf(p) === 'hit');
}
{
  // 幫派互毆（低頻）
  const bus = createBus();
  const ev = capture(bus, ['gang:war']);
  const gangs = createGangs({ bus, rng: mulberry32(13), config: { warChance: 1 } });
  const c = centerOf(QH);
  const a = makeMember(gangs, NM, c.x, c.z, 'fist', { rival: true, crew: 1 });
  const b = makeMember(gangs, QH, c.x + 8, c.z, 'bat', { crew: 2 });
  const pl = playerCtx(0, 0);
  run(gangs, { combat: fakeCombat(), player: pl }, DEFAULTS.warCheck - 1);
  check('互毆檢查前不開打', !a.m.engaged);
  run(gangs, { combat: fakeCombat(), player: pl }, 1.5);
  check('入侵 crew 與在地成員互毆（gang:war、互為目標）', ev.length === 1 && a.m.target === b.actor && b.m.target === a.actor && a.m.war);
  run(gangs, { combat: fakeCombat(), player: pl }, 1);
  for (let i = 0; i < 150; i++) a.brain.update(0.1, { combat: fakeCombat() });
  check('互毆 warSec 後散去', !a.m.engaged);
  check('預設頻率低（warCheck ≥ 15 s、warChance < 0.5）', DEFAULTS.warCheck >= 15 && DEFAULTS.warChance < 0.5);
}

// ---------- 6. 開車掃射 ----------
console.log('— 開車掃射');
{
  const bus = createBus();
  const ev = capture(bus, ['gang:driveby', 'weapon:fire']);
  const gangs = createGangs({ bus, rng: mulberry32(14) });
  const combat = fakeCombat();
  const cars = fakeCars();
  const c = centerOf(SU);
  const pl = playerCtx(c.x, c.z);
  let vehDmg = 0;
  const ctx = { combat, cars, player: pl, damageVehicle: (n) => (vehDmg += n) };
  const mem = makeMember(gangs, SU, c.x + 30, c.z, 'fist');
  run(gangs, ctx, 2);
  check('敵意低不派車', cars.spawned.length === 0);
  // 瞄準只到 70：未達 drivebyAt
  pl.aiming = true;
  pl.aimDirX = 1;
  pl.aimDirZ = 0;
  run(gangs, ctx, 0.3);
  pl.aiming = false;
  run(gangs, ctx, 1);
  check('敵意 < drivebyAt（瞄準 70）不派車', gangs.hostility('suits') < DEFAULTS.drivebyAt && cars.spawned.length === 0);
  bus.emit('combat:hit', { byPlayer: true, target: mem.actor, attacker: pl.actor });
  gangs.update(1 / 60, ctx);
  check('敵意 ≥ drivebyAt → 派幫派車（gang:driveby start）', cars.spawned.length === 1 && ev.some((e) => e.evt === 'gang:driveby' && e.phase === 'start') && gangs.car('suits') === cars.spawned[0]);
  const car = cars.spawned[0];
  run(gangs, ctx, 2);
  check('遠處追玩家不開槍', cars.drives > 0 && !ev.some((e) => e.evt === 'weapon:fire' && e.shooter === null));
  car.pos.x = pl.x + 12;
  car.pos.z = pl.z;
  pl.inVehicle = true;
  const h0 = combat.hits.length;
  run(gangs, ctx, 6);
  const dShots = ev.filter((e) => e.evt === 'weapon:fire' && e.shooter === null);
  const dHits = combat.hits.slice(h0).filter((h) => h.attacker === null);
  check(`靠近 drivebyRange 內乘客開槍（6 s ${dShots.length} 發，連發 + 換輪間隔）`, dShots.length >= 8 && dShots.length <= 16);
  check('掃射命中走 combat.applyHit（玩家在車內 throughVehicle）+ 車輛扣耐久', dHits.length > 0 && dHits.every((h) => h.throughVehicle && h.weapon === 'pistol') && vehDmg === dHits.length * DEFAULTS.drivebyCarDamage);
  run(gangs, ctx, DEFAULTS.drivebyLife);
  check('存在超過 drivebyLife → 回收（gang:driveby end）', cars.despawned.length === 1 && ev.some((e) => e.evt === 'gang:driveby' && e.phase === 'end') && gangs.car('suits') === null);
  bus.emit('combat:hit', { byPlayer: true, target: mem.actor, attacker: pl.actor });
  run(gangs, ctx, DEFAULTS.drivebyCooldown - 5);
  check('冷卻中不再派車（敵意滿）', cars.spawned.length === 1);
  bus.emit('combat:hit', { byPlayer: true, target: mem.actor, attacker: pl.actor });
  run(gangs, ctx, 6);
  check('冷卻結束後再派下一台', cars.spawned.length === 2);
  cars.aliveFlag = false;
  run(gangs, ctx, 0.1);
  check('幫派車被毀 / 被搶 → 結束並進冷卻', gangs.car('suits') === null && cars.despawned.length === 2);
  cars.aliveFlag = true;
  // 凍結：車煞停、不開槍
  run(gangs, ctx, DEFAULTS.drivebyCooldown - 1);
  bus.emit('combat:hit', { byPlayer: true, target: mem.actor, attacker: pl.actor });
  run(gangs, ctx, 2);
  const car3 = gangs.car('suits');
  car3.pos.x = pl.x + 10;
  const s0 = ev.filter((e) => e.evt === 'weapon:fire').length;
  const b0 = cars.brakes;
  run(gangs, { ...ctx, frozen: true }, 5);
  check('凍結（手機 / BUSTED・WASTED）：幫派車煞停、不開槍、敵意不衰減', cars.brakes > b0 && ev.filter((e) => e.evt === 'weapon:fire').length === s0 && gangs.hostility('suits') > 90);
  // 死亡 / 被捕：cancel 歸零
  gangs.cancel();
  check('cancel（死亡 / 被捕 / 回主選單 / 新局）：敵意歸零、成員收手、幫派車立即回收', gangs.hostility() === 0 && !mem.m.engaged && gangs.car('suits') === null && cars.despawned.at(-1).now === true);
  run(gangs, ctx, 2);
  check('cancel 後冷卻重置但敵意 0 不派車', cars.spawned.length === 3);
  // 死亡 / 被捕：player:wasted / player:busted → 歸零
  for (const evt of ['player:wasted', 'player:busted']) {
    bus.emit('combat:hit', { byPlayer: true, target: mem.actor, attacker: pl.actor });
    run(gangs, ctx, 0.1);
    const had = gangs.hostility('suits') > 0 && mem.m.engaged;
    bus.emit(evt, { x: 0, z: 0 });
    check(`${evt} → 敵意歸零、成員收手`, had && gangs.hostility() === 0 && !mem.m.engaged);
  }
  // 玩家離該幫地盤外框超過 drivebyZone：敵意滿也不派車
  const fcars = fakeCars();
  const fpl = playerCtx(BOUNDS.minX + 5, BOUNDS.maxZ - 5);
  const fbus = createBus();
  const f2 = createGangs({ bus: fbus, rng: mulberry32(16) });
  const fm2 = makeMember(f2, SU, fpl.x + 2, fpl.z, 'fist');
  f2.update(1 / 60, { combat: fakeCombat(), cars: fcars, player: fpl });
  fbus.emit('combat:hit', { byPlayer: true, target: fm2.actor, attacker: fpl.actor });
  f2.update(1 / 60, { combat: fakeCombat(), cars: fcars, player: fpl });
  check('玩家離地盤 > drivebyZone：敵意滿也不派車', f2.hostility('suits') > DEFAULTS.drivebyAt && fcars.spawned.length === 0);
}

// ---------- 6b. createGangCars（車輛 / 角色替身） ----------
console.log('— 幫派車轉接');
{
  const made = [];
  const vehicles = {
    vehicles: [],
    adopt(o) {
      const kids = [];
      const v = {
        ...o,
        pos: { x: o.x, y: 0, z: o.z },
        yaw: o.yaw,
        speed: 0,
        spec: { seat: { x: 0.37, y: 0.55, z: -0.2 } },
        driven: false,
        ctl: null,
        setControls(c) {
          v.ctl = { ...c };
        },
        mesh: { kids, add: (ch) => kids.push(ch) },
      };
      vehicles.vehicles.push(v);
      made.push(v);
      return v;
    },
    remove(v) {
      const i = vehicles.vehicles.indexOf(v);
      if (i >= 0) vehicles.vehicles.splice(i, 1);
      return i >= 0;
    },
  };
  const health = new Map();
  const dmg = { attach: (v) => health.set(v, 1000), detach: (v) => health.delete(v), healthOf: (v) => (health.has(v) ? health.get(v) : null) };
  const traffic = { spawnSpots: (cx, cz, r0, r1, out) => ((out.length = 0), out.push({ x: cx + 100, z: cz, heading: 0 }), out) };
  let disposed = 0;
  const characters = {
    createCharacter: ({ colors }) => ({ colors, root: { position: { set(x, y, z) { this.x = x; this.y = y; this.z = z; } }, removeFromParent() {} } }),
    disposeCharacter: () => disposed++,
    CharacterAnimator: class {
      constructor() {
        this.trig = [];
      }
      trigger(n) {
        this.trig.push(n);
        return true;
      }
      update() {}
    },
    clips: [],
  };
  const cars = G.createGangCars({ vehicles, dmg, traffic, characters, rng: mulberry32(40) });
  const car = cars.spawn(SU, 0, 0);
  check('spawn：一般車型 + 幫派車色、dmg.attach、前座兩名幫派配色乘客', !!car && made[0].type === SU.carType && made[0].color === SU.carColor && health.has(made[0]) && car.riders.length === 2 && made[0].mesh.kids.length === 2 && car.riders.every((r) => r.ch.colors.shirt === SU.outfit.shirts[0] && r.anim.trig.includes('enter_car')));
  check('乘客坐在左右前座（x 對稱）', car.riders[0].ch.root.position.x === -car.riders[1].ch.root.position.x);
  cars.drive(car, -50, 0);
  cars.update(1 / 60, 0, 0);
  check('drive → 每幀 setControls 追向目標', !!made[0].ctl && made[0].ctl.throttle > 0);
  cars.despawn(car);
  check('despawn：玩家在 LEAVE_NEAR 外 → 立即回收（車與乘客）', vehicles.vehicles.length === 0 && disposed === 2 && cars.count() === 0);
  const car2 = cars.spawn(SU, 0, 0);
  car2.v.pos.x = 30;
  cars.update(1 / 60, 0, 0);
  cars.despawn(car2);
  cars.update(1 / 60, 0, 0);
  check('despawn：玩家 60 m 內 → 先開走（遠離玩家）', cars.count() === 1 && car2.leaving && car2.v.ctl.throttle > 0);
  car2.v.pos.x = 95;
  cars.update(1 / 60, 0, 0);
  check('開到 LEAVE_FAR 外回收', cars.count() === 0);
  const car3 = cars.spawn(SU, 0, 0);
  car3.v.driven = true;
  cars.update(1 / 60, 0, 0);
  check('玩家搶走幫派車：alive false、乘客消失、車與耐久保留給玩家', !cars.alive(car3) && cars.count() === 0 && vehicles.vehicles.includes(car3.v) && health.has(car3.v));
  car3.v.pos.x = 500; // 玩家開走（生成點才不會被判有車）
  const car4 = cars.spawn(SU, 0, 0);
  health.set(car4.v, 0);
  check('熄火 → alive false', !cars.alive(car4));
  cars.cancel();
  check('cancel 回收全部', cars.count() === 0);
}

// ---------- 6c. 審查修正回歸（var/retro/v2-findings-logic.md / v2-findings-wire.md） ----------
console.log('— 審查修正回歸');
// 車輛 / 耐久替身（setControls 記錄最後一次控制）
function regWorld(spot) {
  const vehicles = {
    vehicles: [],
    adopt(o) {
      const v = { ...o, ai: false, pos: { x: o.x, y: 0, z: o.z }, yaw: o.yaw, speed: 0, spec: {}, driven: false, ctl: null, setControls(c) { v.ctl = { ...c }; }, mesh: { add() {} } };
      vehicles.vehicles.push(v);
      return v;
    },
    remove(v) {
      const i = vehicles.vehicles.indexOf(v);
      if (i >= 0) vehicles.vehicles.splice(i, 1);
    },
  };
  const health = new Map();
  const dmg = { attach: (v) => health.set(v, 1000), detach: (v) => health.delete(v), healthOf: (v) => (health.has(v) ? health.get(v) : null) };
  const traffic = { cars: [], spawnSpots: (cx, cz, a, b, out) => ((out.length = 0), out.push(spot ? spot(cx, cz) : { x: cx + 15, z: cz, heading: 0 }), out) };
  return { vehicles, health, dmg, traffic };
}
// 真 gangs + 真 createGangCars：西裝幫地盤中心、玩家旁一名成員，打一下 → 派車（生成點離玩家 15 m）
function regDriveby(extra = {}) {
  const w = regWorld();
  const kept = [];
  const cars = G.createGangCars({ vehicles: w.vehicles, dmg: w.dmg, traffic: w.traffic, rng: () => 0, onKeep: (v) => kept.push(v), ...extra });
  const bus = createBus();
  const gangs = createGangs({ bus, rng: () => 0.99 });
  const c = centerOf(SU);
  const pl = playerCtx(c.x, c.z);
  const mem = makeMember(gangs, SU, c.x + 3, c.z, 'fist');
  const ctx = { combat: fakeCombat(), cars, player: pl };
  gangs.update(1 / 60, ctx);
  bus.emit('combat:hit', { byPlayer: true, target: mem.actor, attacker: pl.actor });
  gangs.update(1 / 60, ctx);
  const car = gangs.car('suits');
  return { w, cars, gangs, pl, ctx, car, kept };
}
{
  // 🔴 熄火殘骸不在玩家眼前消失
  const r = regDriveby();
  const v = r.car.v;
  const dist = Math.hypot(v.pos.x - r.pl.x, v.pos.z - r.pl.z);
  r.w.health.set(v, 0);
  r.gangs.update(1 / 60, r.ctx);
  check(`🔴 熄火幫派車（離玩家 ${dist.toFixed(0)} m）：殘骸留在世界、交還一般車輛（v.ai false）、耐久保留，整合層照報廢車回收`,
    dist < G.LEAVE_NEAR && r.w.vehicles.vehicles.includes(v) && v.ai === false && r.w.health.get(v) === 0 && r.gangs.car('suits') === null && r.cars.count() === 0);
  // cancel / despawn(now) 也不移除殘骸
  const r2 = regDriveby();
  const v2 = r2.car.v;
  r2.w.health.set(v2, 0);
  r2.gangs.cancel();
  check('🔴 cancel（立即回收）遇到熄火殘骸也不移除車體', r2.w.vehicles.vehicles.includes(v2) && v2.ai === false);
}
{
  // 🟡1 玩家搶走 / 正上車：v.ai false + onKeep
  const r = regDriveby();
  const v = r.car.v;
  v.driven = true;
  r.gangs.update(1 / 60, r.ctx);
  check('🟡 玩家開走幫派車：v.ai = false、onKeep(v) 交整合層回收名單、車留在世界', v.ai === false && r.kept.length === 1 && r.kept[0] === v && r.w.vehicles.vehicles.includes(v) && r.gangs.car('suits') === null);
  let keep = null;
  const r2 = regDriveby({ isKept: (vv) => vv === keep });
  const v2 = r2.car.v;
  keep = v2; // 玩家正在上車（劫車動畫中，driven 尚未 true）
  r2.gangs.update(1 / 60, r2.ctx);
  check('🟡 玩家正上車（isKept）：停止 AI 控制、v.ai = false、onKeep、不移除', v2.ai === false && r2.kept[0] === v2 && r2.w.vehicles.vehicles.includes(v2) && r2.cars.count() === 0);
}
{
  // 🟡2 frozen：含 leaving 的全部幫派車煞停，leaveT 不前進、解凍後繼續
  const r = regDriveby();
  const car = r.car;
  run(r.gangs, r.ctx, DEFAULTS.drivebyLife + 1); // timeout → 玩家 60 m 內 → leaving
  const leaving = car.leaving && r.gangs.car('suits') === null && r.cars.count() === 1;
  const lt0 = car.leaveT;
  run(r.gangs, { ...r.ctx, frozen: true }, 5);
  const ctl = car.v.ctl || {};
  check('🟡 frozen：已結束、正在開走（leaving）的幫派車也煞停（throttle 0、brake 1）', leaving && ctl.throttle === 0 && ctl.brake === 1);
  check('🟡 frozen：leaveT 不前進；解凍後照常累計', Math.abs(car.leaveT - lt0) < 1e-9 && (run(r.gangs, r.ctx, 0.5), car.leaveT > lt0 + 0.4 || car.removed));
}
{
  // 🟡3 生成點檢查：有車 / 車流車 / 玩家看得到 → 不生成
  const occupied = regWorld(() => ({ x: 100, z: 0, heading: 0 }));
  occupied.vehicles.vehicles.push({ pos: { x: 100, y: 0, z: 0 } });
  const c1 = G.createGangCars({ vehicles: occupied.vehicles, traffic: occupied.traffic, rng: () => 0 }).spawn(SU, 0, 0);
  const flow = regWorld(() => ({ x: 100, z: 0, heading: 0 }));
  flow.traffic.cars.push({ v: { pos: { x: 103, y: 0, z: 0 } } });
  const c2 = G.createGangCars({ vehicles: flow.vehicles, traffic: flow.traffic, rng: () => 0 }).spawn(SU, 0, 0);
  const seen = regWorld(() => ({ x: 100, z: 0, heading: 0 }));
  const c3 = G.createGangCars({ vehicles: seen.vehicles, traffic: seen.traffic, rng: () => 0, canSee: () => true }).spawn(SU, 0, 0);
  const ok = regWorld(() => ({ x: 100, z: 0, heading: 0 }));
  const c4 = G.createGangCars({ vehicles: ok.vehicles, traffic: ok.traffic, rng: () => 0, canSee: () => false }).spawn(SU, 0, 0);
  check('🟡 生成點已有車（VehicleManager / 車流）→ 不生成（不穿模）', c1 === null && c2 === null && occupied.vehicles.vehicles.length === 1 && flow.vehicles.vehicles.length === 0);
  check('🟡 生成點在玩家視野內（canSee）→ 不生成；空且看不到 → 生成', c3 === null && seen.vehicles.vehicles.length === 0 && !!c4);
}
{
  // 🟡4 近距離並行 / 減速，不直衝；步行 / 倒地不衝撞
  const w = regWorld((cx, cz) => ({ x: cx, z: cz + 10, heading: Math.PI }));
  const cars = G.createGangCars({ vehicles: w.vehicles, traffic: w.traffic, rng: () => 0 });
  const car = cars.spawn(SU, 0, 0);
  const res = [];
  for (const d of [3, 1]) {
    car.v.pos.z = d;
    car.v.speed = 6;
    cars.drive(car, 0, 0);
    cars.update(1 / 60, 0, 0);
    res.push({ ...car.v.ctl });
  }
  check(`🟡 車內玩家 3 m / 1 m 正前方、6 m/s 接近：煞車（${res.map((c) => c.brake.toFixed(2)).join(' / ')}）不加油`, res.every((c) => c.brake > 0.3 && c.throttle <= 0));
  car.v.pos.z = 15;
  car.v.speed = 6;
  cars.drive(car, 0, 0);
  cars.update(1 / 60, 0, 0);
  check('🟡 近距離目標改為玩家側邊點（正對玩家時也轉向，不朝玩家直衝）', Math.abs(car.v.ctl.steer) > 0.3);
  car.v.pos.z = 8;
  car.v.speed = 3;
  cars.drive(car, 0, 0, G.GANG_CAR_HOLD);
  cars.update(1 / 60, 0, 0);
  check('🟡 玩家步行：GANG_CAR_HOLD 內煞停', car.v.ctl.brake === 1 && car.v.ctl.throttle === 0);
  // updateCar：玩家倒地 → brake、不 drive；步行 → drive 帶 hold
  const bus = createBus();
  const gangs = createGangs({ bus, rng: mulberry32(21) });
  const fc = fakeCars();
  const holds = [];
  fc.drive = (cc, x, z, hold) => {
    fc.drives++;
    holds.push(hold || 0);
  };
  const c = centerOf(SU);
  const pl = playerCtx(c.x, c.z);
  const mem = makeMember(gangs, SU, c.x + 3, c.z, 'fist');
  const ctx = { combat: fakeCombat(), cars: fc, player: pl };
  gangs.update(1 / 60, ctx);
  bus.emit('combat:hit', { byPlayer: true, target: mem.actor, attacker: pl.actor });
  run(gangs, ctx, 0.5);
  const footHold = holds.length > 0 && holds.every((h) => h >= 8);
  pl.disabled = true;
  const d0 = fc.drives;
  const b0 = fc.brakes;
  run(gangs, ctx, 1);
  check('🟡 玩家步行 drive 帶 hold；倒地 / KO 時煞停不追撞', footHold && fc.drives === d0 && fc.brakes > b0);
}
{
  // 🟡5 揮棒：前搖被打倒 → 中斷，起身後重新起手；硬直中斷；面向扇形
  const batCase = (interrupt, faceAway = false) => {
    let now = 0;
    const combat = new CombatSystem({ now: () => now, bus: null });
    const c = centerOf(SU);
    const pa = makeActor('player', c.x, c.z, 'player');
    const ma = makeActor('bat1', c.x + 1.0, c.z);
    ma.yaw = faceAway ? Math.PI / 2 : -Math.PI / 2;
    combat.register(pa);
    combat.register(ma);
    const bus = createBus();
    const gangs = createGangs({ bus, rng: () => 0 });
    const brain = new NpcBrain({ actor: ma, seed: 1 });
    gangs.pedHooks.onAttach({ citizen: { gang: { id: 'suits', def: SU, crew: 1, rival: false, weapon: 'bat' } }, actor: ma, brain });
    gangs.update(1 / 60, { combat, player: playerCtx(c.x, c.z, { actor: pa }) });
    bus.emit('combat:hit', { byPlayer: true, target: ma, attacker: pa });
    const bctx = { combat };
    let n = 0;
    while (!ma.calls.upper.length && n++ < 50) {
      brain.update(0.05, bctx);
      now += 0.05;
    }
    const started = ma.calls.upper.length === 1;
    if (interrupt === 'down') combat.knockdownActor(ma, { cause: 'punch' });
    if (interrupt === 'hit') combat.applyHit({ attacker: pa, target: ma, damage: 1, weapon: 'fist', dir: { x: 1, z: 0 } });
    const hp0 = pa.hp;
    let landed = null;
    for (let i = 0; i < 140; i++) {
      now += 0.05;
      combat.update(0.05);
      brain.update(0.05, bctx);
      if (landed === null && pa.hp < hp0) landed = { swings: ma.calls.upper.length };
    }
    return { started, landed, swings: ma.calls.upper.length };
  };
  const down = batCase('down');
  check(`🟡 揮棒前搖被打倒：中斷，起身後重新起手才命中（命中時已播 ${down.landed ? down.landed.swings : 0} 次揮棒）`, down.started && !!down.landed && down.landed.swings >= 2);
  const stun = batCase('hit');
  check('🟡 揮棒前搖被打進硬直：中斷，之後重新起手才命中', stun.started && !!stun.landed && stun.landed.swings >= 2);
  const away = batCase(null, true);
  check('🟡 揮棒時目標不在面向扇形內 → 不命中', away.started && away.landed === null);
  const front = batCase(null);
  check('🟡 揮棒（面向目標、未被打斷）照常命中', front.started && !!front.landed && front.landed.swings === 1);
}
{
  // 🟡6 / 🟡7 traffic.js 同夥生成（traffic.js 需 three，以純函式 + 靜態檢查）
  const okFn = typeof G.crewSlotS === 'function' && typeof G.crewRoom === 'function';
  let slots = [];
  if (okFn) for (let k = 1; k <= 3; k++) slots.push(G.crewSlotS(240.5, -1, k, 172, 242, 1.3));
  const all = [240.5, ...slots];
  let minGap = Infinity;
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) minGap = Math.min(minGap, Math.abs(all[i] - all[j]));
  check(`🟡 路線端點附近的 3 名同夥不疊在一起（最小間距 ${Number.isFinite(minGap) ? minGap.toFixed(2) : '—'} m ≥ 0.8）`, okFn && slots.every((s) => s >= 172 && s <= 242) && minGap >= G.CREW_MIN_GAP && G.CREW_MIN_GAP >= 0.8);
  check('🟡 路線太短前後都排不下 → 不生成（NaN），不 clamp 到端點', okFn && Number.isNaN(G.crewSlotS(1, 1, 2, 0, 2, 1.3)));
  check('🟡 同夥數受總數上限與剩餘 slot 約束（cap 42、已 41 人 → 只補 1；已滿 → 0）', okFn && G.crewRoom(3, 42, 41, 10) === 1 && G.crewRoom(3, 42, 42, 10) === 0 && G.crewRoom(3, 42, 10, 2) === 2);
  const tr = fs.readFileSync(path.join(ROOT, 'src/traffic.js'), 'utf8');
  const sp = tr.slice(tr.indexOf('  _spawnPed(spot'), tr.indexOf('  _canAcquire()'));
  const ring = tr.slice(tr.indexOf('  _spawnRing('), tr.indexOf('  _trimPool()'));
  check('🟡 traffic._spawnPed：同夥用 crewSlotS、crewRoom(crowdCap)、視野外（_hidden）與間距檢查；_spawnRing 計入同夥數',
    /crewSlotS\(/.test(sp) && /crewRoom\(crew, crowdCap\(this\.plan\.target\)/.test(sp) && /!initial && !this\._hidden\(c\.x, c\.z\)/.test(sp) && /CREW_MIN_GAP/.test(sp) && !/Math\.min\(route\.s1, Math\.max\(route\.s0/.test(sp) && /this\._lastCrew/.test(ring));
}
{
  // 接線：main.js 幫派車注入 canSee / isKept / onKeep（比照逃犯車）
  const main = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  const gc = main.slice(main.indexOf('const gangCars = createGangCars('), main.indexOf('const gangPlayer'));
  check('🟡 main.js createGangCars 注入 canSee、isKept、onKeep → adopted', gc.includes('canSee:') && gc.includes('isKept: (v) => v === state.vehicle || v === cj.vehicle') && gc.includes('onKeep: (v) => adopted.add(v)'));
}

// ---------- 7. main.js 接線（靜態） ----------
console.log('— main.js 接線');
{
  const main = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  const fr = main.slice(main.indexOf('const finishRespawn'), main.indexOf('const cancelRespawn'));
  const sg = main.slice(main.indexOf('const startGame'), main.indexOf('const startGame') + 1200);
  const qm = main.slice(main.indexOf('const quitToMenu'), main.indexOf('const quitToMenu') + 800);
  check('死亡 / 被捕：finishRespawn 發 player:busted / player:wasted（gangs 訂閱歸零）', fr.includes("bus.emit('player:busted'") && fr.includes("bus.emit('player:wasted'"));
  check('開新局 / 繼續 → gangs.cancel()', sg.includes('gangs.cancel()'));
  check('回主選單 → gangs.cancel()', qm.includes('gangs.cancel()'));
  check('Traffic 建構注入 gangs.pedHooks，且 gangs 在 Traffic 之前建立', /new Traffic\([^)]*gangs: gangs\.pedHooks/.test(main) && main.indexOf('createGangs(') < main.indexOf('new Traffic('));
  const ug = main.slice(main.indexOf('const updateGame = (dt) =>'), main.indexOf('// 開始畫面 / 回到主選單'));
  check('每幀 updateGangs 在 stepWorld / updateWanted 之後、凍結條件含手機 / respawn / 噴漆', ug.indexOf('updateGangs(dt, phoneOpen);') > ug.indexOf('updateWanted(dt, phoneOpen);') && ug.indexOf('updateWanted(dt, phoneOpen);') > ug.indexOf('stepWorld(dt,') && /gangCtx\.frozen = skip \|\| !!state\.respawn \|\| !!state\.spraying/.test(main));
  check('gang:enter → HUD 提示「進入〇〇地盤」', /bus\.on\('gang:enter'[\s\S]{0,120}進入\$\{e\.name\}地盤/.test(main));
  check('小地圖 gangZones / 大地圖 zones = GANG_ZONES', main.includes('gangZones: GANG_ZONES') && main.includes('zones: GANG_ZONES'));
  const hud = fs.readFileSync(path.join(ROOT, 'src/hud.js'), 'utf8');
  check('hud.js 畫 state.gangZones', hud.includes('_drawGangZones(ctx, state.gangZones'));
  const bm = fs.readFileSync(path.join(ROOT, 'src/map/big-map.js'), 'utf8');
  check('大地圖圖例加入地盤（zones 每筆一列）', /for \(const zn of zones\) addLegend\(/.test(bm));
  const doc = fs.readFileSync(path.join(ROOT, 'docs/dev/interfaces.md'), 'utf8');
  check('interfaces.md 有 gangs.js 一節與三個事件', doc.includes('src/gangs.js') && ['gang:enter', 'gang:hostile', 'gang:driveby'].every((n) => doc.includes(n)));
}

// ---------- 8. 大地圖色塊 ----------
console.log('— 大地圖');
{
  const log = { fillStyle: [], strokeStyle: [] };
  const ctx = new Proxy({}, {
    get: (_, k) => (k === 'measureText' ? () => ({ width: 10 }) : () => {}),
    set: (_, k, v) => {
      if (k === 'fillStyle' || k === 'strokeStyle') log[k].push(v);
      return true;
    },
  });
  drawBigMap(ctx, { cx: 500, cz: 100, scale: 0.5, w: 1600, h: 1000 }, { player: null, markers: [], route: null, landmarks: [], zones: GANG_ZONES });
  check('drawBigMap 以幫派色畫地盤', GANG_ZONES.every((z) => log.fillStyle.includes(z.color) && log.strokeStyle.includes(z.color)));
}

// ---------- 9. 幀率無關 ----------
console.log('— 幀率無關');
{
  const triggerAt = (dt) => {
    const gangs = createGangs({ bus: createBus(), rng: mulberry32(20) });
    const c = centerOf(QH);
    makeMember(gangs, QH, c.x + 4, c.z, 'fist');
    const ctx = { combat: fakeCombat(), player: playerCtx(c.x, c.z) };
    let t = 0;
    while (gangs.hostility('qiuhonggu') === 0 && t < 10) {
      gangs.update(dt, ctx);
      t += dt;
    }
    return t;
  };
  const t30 = triggerAt(1 / 30);
  const t144 = triggerAt(1 / 144);
  check(`逗留觸發時間 30 / 144 Hz 一致（${t30.toFixed(3)} / ${t144.toFixed(3)} s，差 ≤ scanSec）`, Math.abs(t30 - t144) <= DEFAULTS.scanSec + 1e-6 && t30 >= 3 - 1e-6 && t30 <= 3 + DEFAULTS.scanSec + 0.04);
  const decayAfter = (dt) => {
    const bus = createBus();
    const gangs = createGangs({ bus, rng: mulberry32(21) });
    const mem = makeMember(gangs, QH, 0, 0, 'fist');
    const pl = playerCtx(0, 0);
    const ctx = { combat: fakeCombat(), player: pl };
    gangs.update(dt, ctx);
    bus.emit('combat:hit', { byPlayer: true, target: mem.actor, attacker: pl.actor });
    run(gangs, ctx, 6, dt);
    return gangs.hostility('qiuhonggu');
  };
  const d30 = decayAfter(1 / 30);
  const d144 = decayAfter(1 / 144);
  check(`敵意衰減 30 / 144 Hz 一致（${d30.toFixed(3)} / ${d144.toFixed(3)}）`, Math.abs(d30 - d144) < 0.15);
  const drivebyShots = (dt) => {
    const bus = createBus();
    let n = 0;
    bus.on('weapon:fire', (e) => {
      if (e.shooter === null) n++;
    });
    const gangs = createGangs({ bus, rng: mulberry32(22) });
    const cars = fakeCars();
    const c = centerOf(SU);
    const pl = playerCtx(c.x, c.z);
    cars.nextPos = { x: c.x + 10, y: 0, z: c.z };
    const mem = makeMember(gangs, SU, c.x + 30, c.z, 'fist');
    const ctx = { combat: fakeCombat(), cars, player: pl };
    gangs.update(dt, ctx);
    bus.emit('combat:hit', { byPlayer: true, target: mem.actor, attacker: pl.actor });
    run(gangs, ctx, 10, dt);
    return n;
  };
  const s30 = drivebyShots(1 / 30);
  const s144 = drivebyShots(1 / 144);
  check(`掃射 10 s 發數 30 / 144 Hz 一致（${s30} / ${s144}）`, s30 > 0 && Math.abs(s30 - s144) <= 1);
  const gunShots = (dt) => {
    const bus = createBus();
    let n = 0;
    bus.on('weapon:fire', () => n++);
    const gangs = createGangs({ bus, rng: mulberry32(23) });
    const c = centerOf(NM);
    const pl = playerCtx(c.x, c.z);
    const gun = makeMember(gangs, NM, c.x + 10, c.z, 'pistol');
    const ctx = { combat: fakeCombat(), player: pl };
    gangs.update(dt, ctx);
    bus.emit('combat:hit', { byPlayer: true, target: gun.actor, attacker: pl.actor });
    // 大腦以 traffic LOD 降頻呼叫（3 幀一次，累積 dt）
    let acc = 0;
    const steps = Math.round(12 / dt);
    for (let i = 0; i < steps; i++) {
      acc += dt;
      if (i % 3 === 2) {
        gun.brain.update(acc, ctx);
        acc = 0;
      }
    }
    return n;
  };
  const g30 = gunShots(1 / 30);
  const g144 = gunShots(1 / 144);
  check(`步行槍手 12 s 發數 30 / 144 Hz（降頻大腦）一致（${g30} / ${g144}）`, g30 > 0 && Math.abs(g30 - g144) <= 1);
}

// ---------- 10. 每幀不配置物件 / 效能 ----------
console.log('— 配置 / 效能');
function scene(nMembers, engagedShare = 0.3) {
  const bus = createBus();
  const gangs = createGangs({ bus, rng: mulberry32(30) });
  const combat = fakeCombat();
  const c = centerOf(NM);
  const pl = playerCtx(c.x, c.z);
  const cars = fakeCars();
  const ctx = { combat, cars, player: pl, damageVehicle: null };
  const ms = [];
  for (let i = 0; i < nMembers; i++) {
    const def = GANGS[i % 3];
    const cc = centerOf(def);
    const near = def === NM;
    const x = near ? c.x + 30 + (i % 7) * 3 : cc.x + (i % 5) * 4;
    const z = near ? c.z + Math.floor(i / 7) * 3 : cc.z;
    ms.push(makeMember(gangs, def, x, z, i % 3 === 0 ? 'fist' : i % 3 === 1 ? 'bat' : 'fist'));
  }
  gangs.update(1 / 60, ctx);
  // 部分成員圍攻（距離遠、只追擊，不出手 → 穩態無事件）
  for (let i = 0; i < ms.length * engagedShare; i++) {
    const m = ms[i].m;
    m.engaged = true;
    m.target = pl.actor;
    m.attackT = 1e9;
  }
  return { gangs, ctx, ms, pl };
}
if (process.env.V2_GANGS_ALLOC === '1') {
  const gc = globalThis.gc;
  const { gangs, ctx, ms, pl } = scene(45);
  const its = ms.map(() => ({ moveX: 0, moveZ: 0, run: false, faceYaw: null, wantPunch: false, jump: false, mode: 'wander' }));
  const bctx = { combat: ctx.combat };
  const frame = (i) => {
    pl.x += i % 2 ? 0.01 : -0.01;
    gangs.update(1 / 60, ctx);
    for (let k = 0; k < ms.length; k++) ms[k].brain.override(ms[k].brain, 1 / 60, bctx, its[k]);
  };
  for (let i = 0; i < 5000; i++) frame(i);
  const N = 20000;
  gc();
  const h0 = process.memoryUsage().heapUsed;
  for (let i = 0; i < N; i++) frame(i);
  const per = (process.memoryUsage().heapUsed - h0) / N;
  const sink = [];
  gc();
  const h2 = process.memoryUsage().heapUsed;
  for (let i = 0; i < N; i++) {
    frame(i);
    for (let k = 0; k < ms.length; k++) sink[k] = { x: i, k };
  }
  const perAlloc = (process.memoryUsage().heapUsed - h2) / N;
  console.log(JSON.stringify({ members: ms.length, per, perAlloc }));
  process.exit(0);
}
{
  // 量本單元新增的每幀路徑（gangs.update + 成員 override），不含既有大腦。子行程以大 semi-space 執行（量測期間不觸發 scavenge），
  // V8 對浮點欄位的裝箱（HeapNumber，與既有 NpcBrain 意圖同）不可避免，判準取「少於每成員每幀一個 16 B 物件」，並以「每成員每幀配置一物件」對照
  const r = spawnSync(process.execPath, ['--min-semi-space-size=128', '--max-semi-space-size=128', '--expose-gc', fileURLToPath(import.meta.url)], {
    env: { ...process.env, V2_GANGS_ALLOC: '1' },
    encoding: 'utf8',
  });
  let res = null;
  try {
    res = JSON.parse((r.stdout || '').trim().split('\n').pop());
  } catch (err) {
    res = null;
  }
  const n = res ? res.members : 45;
  check(
    res ? `穩態每幀不配置物件（${n} 成員含圍攻 / 掃描 / 衰減：${res.per.toFixed(0)} B/幀；對照每成員配置一物件 ${res.perAlloc.toFixed(0)} B/幀）` : '穩態每幀不配置物件（子行程量測失敗）',
    !!res && res.per < n * 16 && res.perAlloc - res.per >= n * 16,
    res ? '' : (r.stderr || '').slice(0, 300),
  );
}
{
  // high tier：骨架行人上限約 40–60（crowd poolMax），全為成員且 1/3 圍攻的最壞情況；量 gangs.update + 成員 override（大腦本身不算新增成本）
  const { gangs, ctx, ms, pl } = scene(60, 0.34);
  const its = ms.map(() => ({ moveX: 0, moveZ: 0, run: false, faceYaw: null, wantPunch: false, jump: false, mode: 'wander' }));
  const bctx = { combat: ctx.combat };
  const frame = (i) => {
    pl.x += i % 2 ? 0.01 : -0.01;
    gangs.update(1 / 60, ctx);
    for (let k = 0; k < ms.length; k++) if (ms[k].brain.override) ms[k].brain.override(ms[k].brain, 1 / 60, bctx, its[k]);
  };
  for (let i = 0; i < 2000; i++) frame(i);
  const N = 6000;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) frame(i);
  const per = (performance.now() - t0) / N;
  check(`high tier 每幀新增純邏輯成本 < 0.5 ms（60 成員：${(per * 1000).toFixed(1)} µs）`, per < 0.5);
}

// ---------- 11. 不 import three ----------
{
  const src = fs.readFileSync(path.join(ROOT, 'src/gangs.js'), 'utf8');
  const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
  check('gangs.js 只 import geom.js（不 import three / rapier）', imports.length === 1 && imports[0] === './geom.js');
  check('shotHitChance 近高遠低', shotHitChance(3) === DEFAULTS.hitNear && shotHitChance(100) === DEFAULTS.hitFar && shotHitChance(14) < DEFAULTS.hitNear);
}

const total = passed + failed;
console.log(failed ? `FAIL ${failed}/${total}` : `PASS ${passed}/${total}`);
process.exit(failed ? 1 : 0);
