#!/usr/bin/env node
// Phase 15 暴走任務（src/missions/rampage.js）純邏輯驗證：不 import three / rapier（骷髏標記以假 THREE 驗）
// 用法：node tools/test/p15-rampage.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：暴走點資料（地盤歸屬 / 市區 / 不在建築內 / 賞金範圍）、觸發條件（步行上升緣、駕車不觸發、busy、凍結、已完成）、
//   武器暫發與恢復（原本未擁有該武器 / 已擁有且彈藥數 / 手槍）、擊殺計數只算目標類型、計時與幀率無關、HUD 文字、
//   完成賞金與存檔（save.js 清洗、舊存檔相容）、全完成獎勵、失敗條件（timeout / wasted / busted）、互斥（busy / 進行中）、cancel、
//   補敵人（world 替身 + createRampageWorld + gangs.enlist / gangOf）、每幀不配置、HUD DOM、骷髏標記（無光源 / 貼圖 / 陰影）、樣式 / 標記色
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBus } from '../../src/core/events.js';
import { createWeapons } from '../../src/weapons/weapons.js';
import { WEAPONS } from '../../src/weapons/defs.js';
import { createGangs, territoryAt, GANGS } from '../../src/gangs.js';
import { pointInPolygon } from '../../src/geom.js';
import { migrate, validateSave, defaultSave } from '../../src/save.js';
import { MARKER_COLORS } from '../../src/map/marker-colors.js';
import {
  createRampage, createRampageWorld, createRampageHud, createSkullMarkers, grantData, formatClock, barText, rampageById,
  RAMPAGES, START_RADIUS, MAX_DT, SPAWN_SEC, MIN_ENEMIES, SPAWN_BATCH, ALL_BONUS, TOAST_BUSY, MARKER_KIND, toastFail, toastComplete, toastAllDone,
} from '../../src/missions/rampage.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(`${ROOT}${p}`, 'utf8');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ---------- 替身 ----------
const playerActor = { id: 'player', kind: 'player', pos: { x: 0, y: 0, z: 0 } };
const byPlayerDead = (ped) => ({ ped, byPlayer: true, attacker: playerActor, x: 0, z: 0 });
function makeRig({ gangMap = new Map(), list, config, weaponsSetup } = {}) {
  const bus = createBus();
  const weapons = createWeapons({ bus, player: { actor: playerActor } });
  if (weaponsSetup) weaponsSetup(weapons);
  const events = [];
  for (const n of ['rampage:start', 'rampage:kill', 'rampage:complete', 'rampage:fail']) bus.on(n, (e) => events.push([n, e]));
  const toasts = [];
  const earned = [];
  const world = { aliveN: 0, spawns: [], alive: (g, x, z, r) => world.aliveN, spawn: (g, x, z, n) => (world.spawns.push([g, x, z, n]), n) };
  let playerCar = null;
  const r = createRampage({ bus, weapons, gangOf: (a) => gangMap.get(a) || null, isTargetVehicle: (v) => !!v && v !== playerCar, list, config });
  const ctx = {
    player: { x: 1e4, z: 1e4 },
    onFoot: true,
    busy: false,
    frozen: false,
    world,
    earn: (n, reason) => earned.push([n, reason]),
    toast: (text, sec) => toasts.push(text),
  };
  return { bus, weapons, r, ctx, events, toasts, earned, world, setCar: (v) => (playerCar = v) };
}
const at = (ctx, def, dx = 0) => {
  ctx.player.x = def.x + dx;
  ctx.player.z = def.z;
};
// 從遠處走進 def 標記（兩幀：外 → 內）
function walkIn(rig, def) {
  at(rig.ctx, def, 50);
  rig.r.update(1 / 60, rig.ctx);
  at(rig.ctx, def);
  return rig.r.update(1 / 60, rig.ctx);
}
const NM = rampageById('rampage-nightmarket');
const QH = rampageById('rampage-qiuhonggu');
const SU = rampageById('rampage-suits');
const OP = rampageById('rampage-opera');
const gangActor = (id, gang) => ({ id, kind: 'ped', pos: { x: 0, y: 0, z: 0 }, hp: 100, gang });

// ---------- 1. 暴走點資料 ----------
{
  const osm = JSON.parse(read('src/data/osm-city.json'));
  check('4 處暴走點、id 不重複', RAMPAGES.length === 4 && new Set(RAMPAGES.map((r) => r.id)).size === 4);
  const gangPts = RAMPAGES.filter((r) => r.target === 'gang');
  check('三處幫派點各在所屬幫派地盤內（gangs.territoryAt）、三幫各一', gangPts.length === 3 && gangPts.every((r) => territoryAt(r.x, r.z) && territoryAt(r.x, r.z).id === r.gang) && new Set(gangPts.map((r) => r.gang)).size === 3 && GANGS.every((g) => gangPts.some((r) => r.gang === g.id)));
  const city = RAMPAGES.filter((r) => r.target === 'vehicle');
  check('一處市區點：不在任何地盤、目標 = 炸車', city.length === 1 && !territoryAt(city[0].x, city[0].z) && city[0].gang === null);
  const inBuilding = RAMPAGES.filter((r) => osm.B.some((b) => pointInPolygon(r.x, r.z, b.p)));
  check('暴走點都不在建築輪廓內（osm-city.json B 層）', inBuilding.length === 0, inBuilding.map((r) => r.id).join());
  let minD = Infinity;
  for (const a of RAMPAGES) for (const b of RAMPAGES) if (a !== b) minD = Math.min(minD, Math.hypot(a.x - b.x, a.z - b.z));
  check('暴走點彼此相距 ≥ 150 m', minD >= 150, `min ${minD.toFixed(1)}`);
  check('賞金 NT$1000–3000、目標 / 時限為正整數', RAMPAGES.every((r) => r.reward >= 1000 && r.reward <= 3000 && Number.isInteger(r.goal) && r.goal > 0 && r.timeSec > 0));
  check('指定武器存在、彈藥 ≤ reserveMax', RAMPAGES.every((r) => WEAPONS[r.weapon] && (!WEAPONS[r.weapon].reserveMax || r.ammo <= WEAPONS[r.weapon].reserveMax)));
  check('全完成獎勵 NT$5000', ALL_BONUS === 5000);
}

// ---------- 2. 觸發條件 ----------
{
  const rig = makeRig();
  at(rig.ctx, NM);
  rig.r.update(1 / 60, rig.ctx);
  check('開局 / 讀檔第一幀就站在標記上不觸發（需走進來）', !rig.r.active);
  const o = walkIn(rig, NM);
  check('步行走進標記 → 開始', rig.r.active && rig.r.current === NM && o.active && rig.events.some(([n, e]) => n === 'rampage:start' && e.id === NM.id && e.goal === NM.goal && e.weapon === 'shotgun'));
  check('開始 toast 說明目標', rig.toasts.some((t) => t.includes('暴走開始') && t.includes('15') && t.includes('夜市角頭')));
  rig.r.cancel();
  // 駕車經過不觸發；下車站在範圍內 → 開始
  rig.ctx.onFoot = false;
  at(rig.ctx, NM, 50);
  rig.r.update(1 / 60, rig.ctx);
  at(rig.ctx, NM);
  rig.r.update(1 / 60, rig.ctx);
  check('駕車經過標記不觸發', !rig.r.active);
  rig.ctx.onFoot = true;
  rig.r.update(1 / 60, rig.ctx);
  check('下車（步行）站在標記內 → 開始', rig.r.active);
  rig.r.cancel();
  rig.r.update(1 / 60, rig.ctx);
  check('結束後站在原地不會立刻重開', !rig.r.active);
  walkIn(rig, NM);
  check('離開再走進來 → 重新挑戰', rig.r.active);
  rig.r.cancel();
  // 半徑邊界
  at(rig.ctx, NM, 50);
  rig.r.update(1 / 60, rig.ctx);
  at(rig.ctx, NM, START_RADIUS + 0.2);
  rig.r.update(1 / 60, rig.ctx);
  check(`START_RADIUS（${START_RADIUS} m）外不觸發`, !rig.r.active);
  // busy
  const rb = makeRig();
  rb.ctx.busy = true;
  walkIn(rb, SU);
  check('其他任務進行中（busy）→ toast TOAST_BUSY、不開始', !rb.r.active && rb.toasts.includes(TOAST_BUSY));
  rb.ctx.busy = false;
  rb.r.update(1 / 60, rb.ctx);
  check('busy 解除但仍站在原地 → 不自動開始（需重新走進）', !rb.r.active);
  // frozen
  const rf = makeRig();
  at(rf.ctx, OP, 50);
  rf.r.update(1 / 60, rf.ctx);
  rf.ctx.frozen = true;
  at(rf.ctx, OP);
  rf.r.update(1 / 60, rf.ctx);
  check('凍結中（手機 / BUSTED・WASTED / 噴漆）不觸發', !rf.r.active);
  rf.ctx.frozen = false;
  rf.r.update(1 / 60, rf.ctx);
  check('解凍後在範圍內步行 → 觸發', rf.r.active);
  // 已完成的點不觸發
  const rd = makeRig();
  rd.r.restore({ done: [QH.id] });
  walkIn(rd, QH);
  check('已完成的點不再觸發', !rd.r.active);
}

// ---------- 3. 武器暫發與恢復 ----------
{
  // A：原本未擁有散彈槍，手持手槍（彈匣 5）
  const rig = makeRig({
    weaponsSetup: (w) => w.restore({ slot: 2, ammo: { pistol: { mag: 5, reserve: 36 } } }),
  });
  check('前提：未擁有散彈槍、手持手槍彈匣 5', !rig.weapons.owns('shotgun') && rig.weapons.current === 'pistol' && rig.weapons.ammo('pistol').mag === 5);
  walkIn(rig, NM);
  const a = rig.weapons.ammo('shotgun');
  check('暫發：擁有散彈槍、手持散彈槍、彈匣滿 + 備彈 36', rig.weapons.owns('shotgun') && rig.weapons.current === 'shotgun' && a.mag === WEAPONS.shotgun.magSize && a.reserve === 36);
  check('進行中 savedWeapons() = 開始前的快照（存檔不帶暫發武器）', !!rig.r.savedWeapons() && !rig.r.savedWeapons().owned && rig.r.savedWeapons().slot === 2);
  rig.r.end('wasted');
  check('結束：散彈槍收回（未擁有）、回手槍、手槍彈匣 5', !rig.weapons.owns('shotgun') && rig.weapons.current === 'pistol' && rig.weapons.ammo('pistol').mag === 5);
  check('結束後 savedWeapons() = null', rig.r.savedWeapons() === null);
  check('結束後 serialize 與開始前相同（無 owned）', JSON.stringify(rig.weapons.serialize()) === JSON.stringify({ slot: 2, ammo: { pistol: { mag: 5, reserve: 36 } } }));
  // B：原本已擁有衝鋒槍（彈匣 7 / 備彈 33）、手持球棒、也擁有散彈槍（2 / 10）
  const rb = makeRig({
    weaponsSetup: (w) => w.restore({ slot: 1, owned: ['smg', 'shotgun'], ammo: { pistol: { mag: 12, reserve: 36 }, smg: { mag: 7, reserve: 33 }, shotgun: { mag: 2, reserve: 10 } } }),
  });
  const before = JSON.stringify(rb.weapons.serialize());
  walkIn(rb, SU);
  const s = rb.weapons.ammo('smg');
  check('已擁有衝鋒槍：暫發改為彈匣 30 / 備彈 240、手持衝鋒槍', rb.weapons.current === 'smg' && s.mag === 30 && s.reserve === 240);
  rb.ctx.player.x += 30; // 離開標記
  for (let i = 0; i < 95 * 60 && rb.r.active; i++) rb.r.update(1 / 60, rb.ctx);
  check('時間到結束：衝鋒槍彈藥回到 7 / 33、散彈槍 2 / 10、手持球棒、擁有權不變', JSON.stringify(rb.weapons.serialize()) === before && rb.weapons.current === 'bat', JSON.stringify(rb.weapons.serialize()));
  // C：手槍點（手槍原本就有）：彈匣 3 → 暫發 12 → 恢復 3
  const rc = makeRig({ weaponsSetup: (w) => w.restore({ slot: 0, ammo: { pistol: { mag: 3, reserve: 50 } } }) });
  walkIn(rc, QH);
  check('手槍點：手持手槍、彈匣滿 12', rc.weapons.current === 'pistol' && rc.weapons.ammo('pistol').mag === 12);
  rc.r.cancel();
  check('cancel：回空手、手槍彈匣 3 / 備彈 50', rc.weapons.current === 'fist' && rc.weapons.ammo('pistol').mag === 3 && rc.weapons.serialize().ammo.pistol.reserve === 50);
  // grantData 純函式：不改動快照
  const snap = { slot: 0, ammo: { pistol: { mag: 1, reserve: 2 } } };
  const g = grantData(snap, 'smg', 9999);
  check('grantData：不改動快照、備彈 clamp 到 reserveMax、owned 加上武器', JSON.stringify(snap) === JSON.stringify({ slot: 0, ammo: { pistol: { mag: 1, reserve: 2 } } }) && g.ammo.smg.reserve === WEAPONS.smg.reserveMax && g.owned.includes('smg') && g.slot === WEAPONS.smg.slot);
}

// ---------- 4. 擊殺計數只算目標類型 ----------
{
  const gm = new Map();
  const nm1 = gangActor('nm1');
  const nm2 = gangActor('nm2');
  const qh1 = gangActor('qh1');
  const civ = gangActor('civ');
  gm.set(nm1, 'nightmarket');
  gm.set(nm2, 'nightmarket');
  gm.set(qh1, 'qiuhonggu');
  const rig = makeRig({ gangMap: gm });
  walkIn(rig, NM);
  rig.bus.emit('ped:dead', byPlayerDead(nm1));
  rig.bus.emit('ped:dead', byPlayerDead(qh1));
  rig.bus.emit('ped:dead', byPlayerDead(civ));
  rig.bus.emit('ped:dead', { ped: nm2, byPlayer: false, attacker: null });
  rig.bus.emit('vehicle:explode', { vehicle: {}, byPlayer: true });
  check('只算玩家擊殺的目標幫派成員（別幫 / 路人 / 非玩家 / 炸車不算）', rig.r.kills === 1, `kills ${rig.r.kills}`);
  check('rampage:kill 事件帶 kills / goal', rig.events.filter(([n]) => n === 'rampage:kill').length === 1 && rig.events.find(([n]) => n === 'rampage:kill')[1].goal === 15);
  const o = rig.r.update(1 / 60, rig.ctx);
  check('HUD 文字「暴走！ 擊殺 1/15｜01:00」', o.text === '暴走！ 擊殺 1/15｜01:00', o.text);
  rig.r.cancel();
  // 炸車點
  const rv = makeRig({ gangMap: gm });
  const myCar = { id: 'mine' };
  rv.setCar(myCar);
  walkIn(rv, OP);
  rv.bus.emit('ped:dead', byPlayerDead(nm1));
  rv.bus.emit('vehicle:explode', { vehicle: { id: 'c1' }, byPlayer: false });
  rv.bus.emit('vehicle:explode', { vehicle: myCar, byPlayer: true });
  rv.bus.emit('vehicle:explode', { vehicle: { id: 'c2' }, byPlayer: true });
  check('炸車點：只算玩家弄爆的車（擊殺 / 非玩家 / 玩家正駕駛的車不算）', rv.r.kills === 1, `kills ${rv.r.kills}`);
  const ov = rv.r.update(1 / 60, rv.ctx);
  check('炸車點 HUD 文字「暴走！ 炸車 1/6｜01:30」', ov.text === '暴走！ 炸車 1/6｜01:30', ov.text);
  // 未進行時擊殺不計
  const ri = makeRig({ gangMap: gm });
  ri.bus.emit('ped:dead', byPlayerDead(nm1));
  check('未進行暴走時擊殺不計', ri.r.kills === 0 && ri.events.length === 0);
}

// ---------- 5. 計時與幀率無關 ----------
{
  const failAt = {};
  for (const fps of [30, 60, 144]) {
    const rig = makeRig();
    walkIn(rig, NM);
    let t = 0;
    const dt = 1 / fps;
    while (rig.r.active && t < 120) {
      rig.r.update(dt, rig.ctx);
      t += dt;
    }
    failAt[fps] = t;
  }
  const spread = Math.max(...Object.values(failAt)) - Math.min(...Object.values(failAt));
  check('30 / 60 / 144 fps 時間到的模擬時刻一致（誤差 ≤ 1 幀 @30fps）且 ≈ 60 s', spread <= 1 / 30 + 1e-9 && Math.abs(failAt[60] - 60) <= 1 / 30, JSON.stringify(failAt));
  const rig = makeRig();
  walkIn(rig, NM);
  rig.r.update(1, rig.ctx); // 單幀 1 s → clamp MAX_DT
  check(`單幀 dt clamp ≤ MAX_DT（${MAX_DT} s）`, Math.abs(rig.r.remain - (60 - MAX_DT)) < 1e-9, String(rig.r.remain));
  for (let i = 0; i < 9; i++) rig.r.update(0.1, rig.ctx);
  check('剩 59 s → mm:ss「00:59」', rig.r.update(0, rig.ctx).text.endsWith('｜00:59'));
  rig.ctx.frozen = true;
  for (let i = 0; i < 600; i++) rig.r.update(0.1, rig.ctx);
  check('凍結中計時不前進', Math.abs(rig.r.remain - 59) < 1e-6);
  check('formatClock：0.4 s → 00:01、90 → 01:30、負值 → 00:00', formatClock(0.4) === '00:01' && formatClock(90) === '01:30' && formatClock(-3) === '00:00');
  check('barText 格式', barText(NM, 3, 42.2) === '暴走！ 擊殺 3/15｜00:43');
}

// ---------- 6. 完成：賞金、存檔 ----------
{
  const gm = new Map();
  const rig = makeRig({ gangMap: gm, weaponsSetup: (w) => w.restore({ slot: 2, ammo: { pistol: { mag: 4, reserve: 36 } } }) });
  walkIn(rig, NM);
  for (let i = 0; i < NM.goal + 3; i++) {
    const a = gangActor(`m${i}`);
    gm.set(a, 'nightmarket');
    rig.bus.emit('ped:dead', byPlayerDead(a));
  }
  check('達標當下不在事件堆疊內結算（仍 active、武器未換回）', rig.r.active && rig.weapons.current === 'shotgun' && rig.r.kills === NM.goal);
  rig.r.update(1 / 60, rig.ctx);
  check('下一次 update 結算完成：賞金 earn(2000, rampage)', !rig.r.active && rig.earned.length === 1 && rig.earned[0][0] === NM.reward && rig.earned[0][1] === 'rampage');
  check('完成 toast / rampage:complete（all false、bonus 0）', rig.toasts.includes(toastComplete(NM.reward)) && rig.events.some(([n, e]) => n === 'rampage:complete' && e.id === NM.id && e.all === false && e.bonus === 0 && e.kills === NM.goal));
  check('完成後武器恢復（手槍彈匣 4、未擁有散彈槍）', rig.weapons.current === 'pistol' && rig.weapons.ammo('pistol').mag === 4 && !rig.weapons.owns('shotgun'));
  check('標記為已完成：isDone / doneCount / markers 不再列出', rig.r.isDone(NM.id) && rig.r.doneCount === 1 && !rig.r.markers([]).some((m) => m.id === NM.id) && rig.r.markers([]).length === 3);
  const rec = rig.r.serialize();
  check('serialize → { done: [id] }', JSON.stringify(rec) === JSON.stringify({ done: [NM.id] }));
  const saved = validateSave(migrate({ ...defaultSave(), rampage: rec }));
  check('save.js 清洗保留 rampage.done', saved && JSON.stringify(saved.rampage) === JSON.stringify(rec));
  const r2 = makeRig();
  r2.r.restore(saved.rampage);
  check('讀檔 restore：已完成點維持完成', r2.r.isDone(NM.id) && r2.r.doneCount === 1);
  const old = validateSave(migrate({ ...defaultSave() }));
  check('舊存檔（無 rampage 欄）相容：清洗後省略、restore → 全部未完成', old && !('rampage' in old) && (r2.r.restore(old.rampage), r2.r.doneCount === 0));
  const bad = validateSave(migrate({ ...defaultSave(), rampage: { done: ['rampage-suits', 'bad id!', 7, 'rampage-suits'] } }));
  check('save.js：非法 id 個別丟棄、去重', JSON.stringify(bad.rampage) === JSON.stringify({ done: ['rampage-suits'] }));
  const bad2 = validateSave(migrate({ ...defaultSave(), rampage: 'x' }));
  check('save.js：格式錯誤整欄丟棄', bad2 && !('rampage' in bad2));
  check('defaultSave 不含 rampage', !('rampage' in defaultSave()));
  r2.r.restore({ done: ['nope', NM.id] });
  check('restore 略過未知 id', r2.r.doneCount === 1);
  check('全部未完成時 serialize → null（存檔省略）', makeRig().r.serialize() === null);
}

// ---------- 7. 全完成獎勵 ----------
{
  const gm = new Map();
  const rig = makeRig({ gangMap: gm });
  let n = 0;
  for (const def of RAMPAGES) {
    walkIn(rig, def);
    for (let i = 0; i < def.goal; i++) {
      if (def.target === 'gang') {
        const a = gangActor(`a${n++}`);
        gm.set(a, def.gang);
        rig.bus.emit('ped:dead', byPlayerDead(a));
      } else rig.bus.emit('vehicle:explode', { vehicle: { id: `v${n++}` }, byPlayer: true });
    }
    rig.r.update(1 / 60, rig.ctx);
  }
  const bonusEarn = rig.earned.filter(([v]) => v === ALL_BONUS);
  const completes = rig.events.filter(([nm]) => nm === 'rampage:complete').map(([, e]) => e);
  check('四處全部完成 → allDone', rig.r.allDone && rig.r.doneCount === 4);
  check('額外獎勵 NT$5000 只給一次（完成最後一處時）', bonusEarn.length === 1 && completes.length === 4 && completes.filter((e) => e.bonus === ALL_BONUS).length === 1 && completes[3].all === true && completes[3].bonus === ALL_BONUS);
  check('總入帳 = 四處賞金 + 5000', rig.earned.reduce((s, [v]) => s + v, 0) === RAMPAGES.reduce((s, r) => s + r.reward, 0) + ALL_BONUS);
  check('全完成 toast', rig.toasts.includes(toastAllDone(ALL_BONUS)));
  check('全完成後小地圖無暴走點', rig.r.markers([]).length === 0);
}

// ---------- 8. 失敗條件 ----------
{
  for (const kind of ['wasted', 'busted']) {
    const rig = makeRig();
    walkIn(rig, SU);
    rig.r.end(kind);
    check(`${kind}（end(kind)）→ 失敗 toast、rampage:fail reason ${kind}、可再挑戰（未標完成）`, !rig.r.active && rig.toasts.includes(toastFail(kind)) && rig.events.some(([n, e]) => n === 'rampage:fail' && e.reason === kind) && !rig.r.isDone(SU.id));
    walkIn(rig, SU);
    check(`${kind} 後離開再走進 → 可再挑戰`, rig.r.active);
  }
  const rt = makeRig();
  walkIn(rt, OP);
  for (let i = 0; i < 91 * 30 && rt.r.active; i++) rt.r.update(1 / 30, rt.ctx);
  check('時間到 → toast「暴走失敗：時間到」、reason timeout、無賞金', !rt.r.active && rt.toasts.includes(toastFail('timeout')) && rt.events.some(([n, e]) => n === 'rampage:fail' && e.reason === 'timeout') && rt.earned.length === 0);
  const rp = makeRig({ gangMap: new Map() });
  walkIn(rp, OP);
  for (let i = 0; i < OP.goal; i++) rp.bus.emit('vehicle:explode', { vehicle: { id: i }, byPlayer: true });
  rp.r.end('wasted');
  check('已達標待結算時被 WASTED → 照算完成', rp.r.isDone(OP.id) && rp.earned.length === 1);
  check('end() 在未進行時回 false', makeRig().r.end('busted') === false);
}

// ---------- 9. 互斥 ----------
{
  const rig = makeRig();
  walkIn(rig, NM);
  check('進行中 markers 不列任何點（避免途中誤踩另一點）', rig.r.markers([]).length === 0);
  check('進行中 start 另一點 → false', rig.r.start(SU.id, rig.ctx) === false && rig.r.current === NM);
  at(rig.ctx, SU, 50);
  rig.r.update(1 / 60, rig.ctx);
  at(rig.ctx, SU);
  rig.r.update(1 / 60, rig.ctx);
  check('進行中走進另一點不切換', rig.r.current === NM);
  check('busy 時 start(id, ctx) → false + toast', makeRig().r.start(SU.id, { busy: true, toast: () => {} }) === false);
  check('active getter（main.js state.rampage / vigHooks.active 用）', rig.r.active === true);
}

// ---------- 10. cancel ----------
{
  const rig = makeRig({ weaponsSetup: (w) => w.restore({ slot: 1, ammo: { pistol: { mag: 12, reserve: 36 } } }) });
  walkIn(rig, NM);
  const nToast = rig.toasts.length;
  rig.r.cancel();
  check('cancel：無聲（不 toast）、rampage:fail reason cancel、武器恢復球棒', !rig.r.active && rig.toasts.length === nToast && rig.events.some(([n, e]) => n === 'rampage:fail' && e.reason === 'cancel') && rig.weapons.current === 'bat' && !rig.weapons.owns('shotgun'));
  rig.r.cancel();
  check('未進行時 cancel 無副作用', rig.events.filter(([n]) => n === 'rampage:fail').length === 1);
  const o = rig.r.update(1 / 60, rig.ctx);
  check('cancel 後 HUD 輸出 inactive / text null', o.active === false && o.text === null);
  // 達標當幀（下一次 update 前）cancel：同 end() 照算完成，不判失敗
  const rp = makeRig();
  walkIn(rp, OP);
  for (let i = 0; i < OP.goal; i++) rp.bus.emit('vehicle:explode', { vehicle: { id: i }, byPlayer: true });
  rp.r.cancel();
  check('已達標待結算時 cancel → 照算完成（賞金、完成紀錄、rampage:complete、無 rampage:fail）',
    !rp.r.active && rp.r.isDone(OP.id) && rp.earned.length === 1 && rp.earned[0][0] === OP.reward && rp.events.some(([n]) => n === 'rampage:complete') && !rp.events.some(([n]) => n === 'rampage:fail'));
  check('已達標 cancel → serialize 寫入完成、武器恢復', JSON.stringify(rp.r.serialize()) === JSON.stringify({ done: [OP.id] }) && !rp.weapons.owns('shotgun'));
  const rs = makeRig();
  walkIn(rs, OP);
  for (let i = 0; i < OP.goal; i++) rs.bus.emit('vehicle:explode', { vehicle: { id: i }, byPlayer: true });
  rs.r.update(1 / 60, { ...rs.ctx, frozen: true }); // 手機開著：不結算
  rs.r.restore(null);
  check('已達標待結算時讀檔（restore → cancel）→ 照算完成一次（賞金已入帳、不判失敗）', !rs.r.active && rs.earned.length === 1 && !rs.events.some(([n]) => n === 'rampage:fail'));
}

// ---------- 11. 補敵人（world 替身）----------
{
  const rig = makeRig();
  walkIn(rig, SU);
  rig.world.aliveN = 1;
  rig.r.update(1 / 60, rig.ctx);
  check('開始後第一次 update 補敵人：spawn(目標幫派, 玩家位置, ≤ SPAWN_BATCH)', rig.world.spawns.length === 1 && rig.world.spawns[0][0] === 'suits' && rig.world.spawns[0][3] === Math.min(SPAWN_BATCH, MIN_ENEMIES - 1));
  for (let i = 0; i < Math.round((SPAWN_SEC - 0.1) * 60); i++) rig.r.update(1 / 60, rig.ctx);
  check(`SPAWN_SEC（${SPAWN_SEC} s）內不重複補`, rig.world.spawns.length === 1);
  for (let i = 0; i < 12; i++) rig.r.update(1 / 60, rig.ctx);
  check('間隔到 → 再補', rig.world.spawns.length === 2);
  rig.world.aliveN = MIN_ENEMIES;
  for (let i = 0; i < 3 * 60; i++) rig.r.update(1 / 60, rig.ctx);
  check(`存活 ≥ MIN_ENEMIES（${MIN_ENEMIES}）不補`, rig.world.spawns.length === 2);
  rig.r.cancel();
  const rv = makeRig();
  walkIn(rv, OP);
  for (let i = 0; i < 300; i++) rv.r.update(1 / 60, rv.ctx);
  check('炸車點不補幫派敵人', rv.world.spawns.length === 0);
}

// ---------- 12. createRampageWorld + gangs.enlist / gangOf ----------
{
  const bus = createBus();
  const gangs = createGangs({ bus, rng: () => 0.5 });
  gangs.update(0.016, { player: { x: 0, z: 0, actor: playerActor, inVehicle: false } });
  let seq = 0;
  const mkPed = (x, z, extra = {}) => {
    const actor = { id: `p${++seq}`, kind: 'ped', pos: { x, y: 0, z }, hp: 100 };
    return { x, z, alive: true, state: 'walk', actor, brain: { state: 'wander', override: null }, citizen: { look: {} }, ...extra };
  };
  const peds = [mkPed(20, 0), mkPed(15, 0), mkPed(5, 0), mkPed(80, 0), mkPed(30, 0, { state: 'flee' }), mkPed(25, 0)];
  const traffic = { peds };
  const repainted = [];
  const combat = { stateOf: () => 'normal' };
  const w = createRampageWorld({ traffic, gangs, combat, repaint: (p) => repainted.push(p) });
  const n = w.spawn('suits', 0, 0, 2);
  const enlisted = peds.filter((p) => p.citizen.gang);
  check('spawn：取半徑內、離玩家 ≥ 12 m 的漫步行人，由近到遠 n 人', n === 2 && enlisted.length === 2 && enlisted.includes(peds[1]) && enlisted.includes(peds[0]), enlisted.map((p) => p.actor.id).join());
  check('徵用者換成該幫成員、repaint 掛色', enlisted.every((p) => p.citizen.gang.id === 'suits') && repainted.length === 2);
  check('gangs.gangOf(actor) → 幫派 id；路人 → null', gangs.gangOf(peds[1].actor) === 'suits' && gangs.gangOf(peds[2].actor) === null);
  check('enlist 挑起該幫敵意（≥ hostileAt）→ 圍攻', gangs.hostility('suits') >= gangs.config.hostileAt && gangs.isHostile('suits'));
  check('alive：半徑內該幫存活成員數', w.alive('suits', 0, 0, 60) === 2 && w.alive('nightmarket', 0, 0, 60) === 0);
  peds[1].actor.hp = 0;
  check('alive：hp 歸零不算', w.alive('suits', 0, 0, 60) === 1);
  check('spawn：已是成員 / 逃跑中 / 太近 / 太遠的行人不徵用', w.spawn('suits', 0, 0, 10) === 1 && peds[5].citizen.gang && !peds[2].citizen.gang && !peds[3].citizen.gang && !peds[4].citizen.gang);
  check('spawn：無 enlist / 無行人 → 0', createRampageWorld({ traffic: { peds: [] }, gangs }).spawn('suits', 0, 0, 3) === 0 && createRampageWorld({}).spawn('suits', 0, 0, 3) === 0);
  // 真 rampage + 真 gangs：擊殺徵用的成員才算
  const wsBus = bus;
  const weapons = createWeapons({ bus: wsBus, player: { actor: playerActor } });
  const r = createRampage({ bus: wsBus, weapons, gangOf: (a) => gangs.gangOf(a) });
  r.start(SU.id, { toast: () => {} });
  wsBus.emit('ped:dead', byPlayerDead(peds[0].actor));
  wsBus.emit('ped:dead', byPlayerDead(peds[2].actor));
  check('真 gangs：擊殺徵用的西裝幫成員計入、路人不計', r.kills === 1);
  r.dispose();
  gangs.dispose();
}

// ---------- 12b. 結束後交還徵用的成員（gangs.release / rampageWorld.release）----------
{
  let seq = 0;
  const mkPed = (x, z) => {
    const actor = { id: `q${++seq}`, kind: 'ped', pos: { x, y: 0, z }, hp: 100 };
    return { x, z, alive: true, state: 'walk', actor, brain: { state: 'wander', override: null }, citizen: { look: { shirt: 'orig' } } };
  };
  const combat = { stateOf: () => 'normal' };
  const pl = { x: 0, z: 0, actor: playerActor, inVehicle: false };
  const SU3 = { ...SU, goal: 3 }; // 完成路徑：目標降到 3 人（徵用 ≤ SPAWN_BATCH 人即可達標）
  const setup = () => {
    const bus = createBus();
    const gangs = createGangs({ bus, rng: () => 0.5 });
    gangs.update(0.016, { player: pl });
    const peds = [mkPed(15, 0), mkPed(20, 0), mkPed(25, 0), mkPed(30, 0), mkPed(35, 0)];
    const repainted = [];
    const world = createRampageWorld({ traffic: { peds }, gangs, combat, repaint: (p) => repainted.push([p, p.citizen.gang ? p.citizen.gang.weapon : null]) });
    const weapons = createWeapons({ bus, player: { actor: playerActor } });
    const earned = [];
    const r = createRampage({ bus, weapons, gangOf: (a) => gangs.gangOf(a), list: [SU3], config: { allBonus: 0 } });
    const ctx = { player: { x: 0, z: 0 }, onFoot: false, busy: false, frozen: false, world, earn: (n) => earned.push(n), toast() {} };
    r.start(SU.id, ctx);
    r.update(1 / 60, ctx); // 第一次 update 補敵人
    return { bus, gangs, peds, repainted, world, r, ctx, earned };
  };
  const enlistedOf = (peds) => peds.filter((p) => p.citizen.gang);
  const engagedN = (g) => g.members.filter((m) => m.engaged).length;
  const kinds = [
    ['timeout', (t) => { for (let i = 0; i < SU.timeSec * 12 && t.r.active; i++) t.r.update(0.1, t.ctx); }],
    ['complete', (t) => {
      for (const p of enlistedOf(t.peds).slice(0, SU3.goal)) {
        p.alive = false;
        t.bus.emit('ped:dead', byPlayerDead(p.actor));
      }
      t.r.update(1 / 60, t.ctx);
    }],
    ['wasted', (t) => t.r.end('wasted')],
    ['busted', (t) => t.r.end('busted')],
    ['cancel', (t) => t.r.cancel()],
    ['restore', (t) => t.r.restore(null)],
  ];
  for (const [kind, finish] of kinds) {
    const t = setup();
    const n0 = enlistedOf(t.peds).length;
    const during = t.gangs.members.length === n0 && engagedN(t.gangs) > 0 && t.world.enlisted.length === n0;
    const alivePeds = enlistedOf(t.peds);
    finish(t);
    if (kind === 'complete') check('完成路徑：確實以完成結算', t.r.isDone(SU3.id) && t.earned.length === 1);
    const back = t.gangs.members.length === 0 && engagedN(t.gangs) === 0 && t.peds.every((p) => !p.citizen.gang && p.citizen.look.shirt === 'orig' && !p.brain.override);
    check(`結束（${kind}）後徵用成員交還：gangs.members / engaged 歸零、citizen.gang 清除、外觀還原、大腦交還`, n0 > 0 && during && !t.r.active && back,
      `n0 ${n0} members ${t.gangs.members.length} engaged ${engagedN(t.gangs)}`);
    const unarmed = t.repainted.filter(([, w]) => w === null).map(([p]) => p);
    check(`結束（${kind}）後存活者 repaint 回原色（卸武器）、enlisted 清空`, alivePeds.every((p) => !p.alive || unarmed.includes(p)) && t.world.enlisted.length === 0);
    t.r.dispose();
    t.gangs.dispose();
  }
  // 不重複釋放 / 不洩漏 / 釋放後可再徵用
  const t = setup();
  const n0 = enlistedOf(t.peds).length;
  const ped0 = enlistedOf(t.peds)[0];
  t.bus.emit('ped:dead', byPlayerDead(ped0.actor));
  ped0.alive = false;
  t.r.end('timeout');
  const rep1 = t.repainted.length;
  check('死亡的徵用者一併取消登記、不 repaint', t.gangs.members.length === 0 && !t.repainted.slice(n0).some(([p]) => p === ped0));
  check('重複 release：rampageWorld.release() = 0、gangs.release 非成員 → []、無額外 repaint', t.world.release() === 0 && t.gangs.release(t.peds.map((p) => p.actor)).length === 0 && t.gangs.release(null).length === 0 && t.repainted.length === rep1);
  t.r.cancel();
  check('未進行時 cancel / end 不呼叫 release 副作用', t.repainted.length === rep1 && t.gangs.members.length === 0);
  for (const p of t.peds) p.alive = true;
  t.ctx.player.x = SU.x;
  t.ctx.player.z = SU.z;
  t.r.start(SU.id, t.ctx);
  t.ctx.player.x = 0;
  t.ctx.player.z = 0;
  t.r.update(1 / 60, t.ctx);
  const n1 = t.gangs.members.length;
  t.r.cancel();
  check('再挑戰：重新徵用 → 結束後再次歸零（不累積）', n1 > 0 && t.gangs.members.length === 0 && t.world.enlisted.length === 0);
  // gangs.release 只交還指定 actor：原生成員（非 enlist）保留
  const bus = createBus();
  const g = createGangs({ bus, rng: () => 0.5 });
  g.update(0.016, { player: pl });
  const a = mkPed(15, 0);
  const b = mkPed(20, 0);
  g.enlist([a, b], 'suits');
  const rel = g.release([a.actor]);
  check('gangs.release(actors)：只釋放指定者、回傳骨架行人、gangOf → null、其他成員保留', rel.length === 1 && rel[0] === a && g.gangOf(a.actor) === null && g.gangOf(b.actor) === 'suits' && g.members.length === 1 && g.stats().engaged === g.members.filter((m) => m.engaged).length);
  g.dispose();
}

// ---------- 13. 每幀不配置 ----------
{
  const rig = makeRig();
  const o1 = rig.r.update(1 / 60, rig.ctx);
  walkIn(rig, NM);
  const o2 = rig.r.update(1 / 60, rig.ctx);
  const t2 = o2.text;
  const o3 = rig.r.update(1 / 60, rig.ctx);
  check('update 回傳同一個物件（重用）', o1 === o2 && o2 === o3);
  check('擊殺數 / 整秒未變時 HUD 字串不重組（同一字串）', Object.is(t2, o3.text));
  const buf = [];
  rig.r.cancel();
  const m1 = rig.r.markers(buf);
  buf.length = 0;
  const m2 = rig.r.markers(buf);
  check('markers(out) 重用呼叫端陣列與標記物件、kind = rampage', m1 === buf && m2 === buf && m2.every((m) => m.kind === MARKER_KIND) && rig.r.markers([])[0] === m2[0]);
}

// ---------- 14. HUD（假 DOM）----------
{
  const mkEl = () => {
    const cls = new Set();
    return {
      hidden: false, textContent: '', className: '', attrs: {}, writes: 0,
      setAttribute(k, v) { this.attrs[k] = v; },
      classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c) },
      remove() { this.removed = true; },
    };
  };
  const kids = [];
  const doc = { createElement: () => mkEl() };
  const root = { appendChild: (e) => kids.push(e) };
  const hud = createRampageHud({ root, doc });
  check('HUD 建立任務條 + 邊緣脈動層，初始隱藏', kids.length === 2 && hud.el.className === 'rampage-bar' && hud.edge.className === 'rampage-edge' && hud.el.hidden && hud.edge.hidden);
  hud.set({ active: true, text: '暴走！ 擊殺 0/15｜01:00', urgent: false });
  check('set：顯示文字與邊緣脈動', !hud.el.hidden && !hud.edge.hidden && hud.el.textContent === '暴走！ 擊殺 0/15｜01:00');
  hud.set({ active: true, text: '暴走！ 擊殺 0/15｜00:09', urgent: true });
  check('剩 ≤ 10 s：rampage-urgent', hud.el.classList.contains('rampage-urgent') && hud.edge.classList.contains('rampage-urgent'));
  hud.set(null);
  check('set(null)：全部隱藏、取消急迫', hud.el.hidden && hud.edge.hidden && !hud.el.classList.contains('rampage-urgent'));
  const noop = createRampageHud({});
  check('無 root：回傳 no-op（node 安全）', typeof noop.set === 'function' && (noop.set(null), true));
}

// ---------- 15. 骷髏標記（假 THREE）----------
{
  const made = { lights: 0, textures: 0, meshes: [], mats: [] };
  class Obj {
    constructor() {
      this.children = [];
      this.position = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } };
      this.rotation = { x: 0, y: 0, z: 0 };
      this.visible = true;
      this.userData = {};
      this.parent = null;
    }
    add(c) { this.children.push(c); c.parent = this; }
    remove(c) { this.children = this.children.filter((x) => x !== c); c.parent = null; }
  }
  class Geo { dispose() { this.disposed = true; } }
  class Mat { constructor(o) { Object.assign(this, o); made.mats.push(this); } dispose() { this.disposed = true; } }
  const THREE = {
    Group: class extends Obj {},
    Mesh: class extends Obj { constructor(g, m) { super(); this.geometry = g; this.material = m; made.meshes.push(this); } },
    MeshStandardMaterial: Mat,
    MeshBasicMaterial: Mat,
    IcosahedronGeometry: Geo,
    BoxGeometry: Geo,
    ConeGeometry: Geo,
    PointLight: class { constructor() { made.lights++; } },
    TextureLoader: class { constructor() { made.textures++; } },
  };
  const scene = new Obj();
  const sk = createSkullMarkers({ THREE, scene, heightAt: () => 3 });
  check('4 個骷髏群組加入場景、離地 SKULL_HOVER', sk.groups.length === 4 && scene.children.length === 4 && sk.groups.every((g) => g.position.y > 3));
  check('不新增光源 / 貼圖、mesh 不投影不受影', made.lights === 0 && made.textures === 0 && made.meshes.every((m) => m.castShadow === false && m.receiveShadow === false));
  check('材質無貼圖、主體 emissive 紅色（≥ 1.65 泛光門檻）、全部共用 2 份', made.mats.length === 2 && made.mats.every((m) => !m.map && !m.emissiveMap) && made.mats.some((m) => m.emissive === 0xff1a1a && m.emissiveIntensity >= 1.65));
  const rig = makeRig();
  rig.r.restore({ done: [NM.id] });
  sk.update(0.5, rig.r);
  check('update：旋轉；已完成的點隱藏', sk.groups[1].rotation.y > 0 && !sk.groups[0].visible && sk.groups[1].visible);
  walkIn(rig, SU);
  sk.update(0.1, rig.r);
  check('暴走進行中全部隱藏', sk.groups.every((g) => !g.visible));
  sk.dispose();
  check('dispose：移出場景、釋放幾何 / 材質', scene.children.length === 0 && made.mats.every((m) => m.disposed));
}

// ---------- 16. 原始碼 / 樣式 / 標記 ----------
{
  const src = read('src/missions/rampage.js');
  check('rampage.js 不 import three / rapier', !/from ['"](three|@dimforge)/.test(src) && !/import\(['"]three/.test(src));
  check('rampage.js 不建立光源 / 貼圖 / 陰影', !/Light\(|TextureLoader|CanvasTexture|castShadow = true|shadowMap/.test(src));
  const css = read('src/style.css');
  check('style.css：.rampage-edge 脈動動畫 + reduced motion 關閉', /\.rampage-edge \{[^}]*animation: rampage-pulse/.test(css) && /@media \(prefers-reduced-motion: reduce\) \{\s*\.rampage-edge \{[^}]*display: none/.test(css) && /@keyframes rampage-pulse/.test(css));
  check('style.css：.rampage-bar 任務條、[hidden] 隱藏', css.includes('.rampage-bar {') && /\.rampage-bar\[hidden\]/.test(css));
  const colors = Object.values(MARKER_COLORS);
  check('MARKER_COLORS.rampage 存在且全表色碼不重複', !!MARKER_COLORS.rampage && new Set(colors).size === colors.length);
  check('大地圖圖例「暴走」', /rampage: '暴走'/.test(read('src/map/big-map.js')));
  const hud = read('src/hud.js');
  check('小地圖 SKULL_KINDS 畫骷髏（不貼邊）', /const SKULL_KINDS = new Set\(\['rampage'\]\)/.test(hud) && /if \(SKULL_KINDS\.has\(m\.kind\)\)/.test(hud) && !/EDGE_KINDS = new Set\([^)]*'rampage'/.test(hud));
  const doc = read('docs/dev/interfaces.md');
  check('interfaces.md §37：介面與四個事件', /## 37\. Phase 15 暴走任務/.test(doc) && ['rampage:start', 'rampage:kill', 'rampage:complete', 'rampage:fail'].every((e) => doc.includes(e)));
}

console.log(failed ? `FAIL ${failed}/${passed + failed}` : `PASS ${passed}/${passed + failed}`);
process.exit(failed ? 1 : 0);
