#!/usr/bin/env node
// Phase 17 隱藏包裹（src/collect/packages.js）純邏輯驗證：不 import three（圖示網格以假 THREE 驗；武器用真的 createWeapons + 替身依賴）
// 用法：node tools/test/p17-packages.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：20 個座標合法（osm-city.json + terrain.js：地圖內、不在建築體內、不在車流道路路面 / 巷道中央、不在水面、彼此 ≥ 120 m）、
//   自動收集半徑（徒步 / 車內、高差）、重複收集不計、里程碑門檻與一次性獎金不重複、安全屋補給內容每 tier 正確且已有武器只補彈、
//   存檔 serialize / restore 與舊存檔相容（save.js 清洗）、cancel、動畫只在 60 m 內更新、標記（只列已收集）、網格 1 draw call、原始碼限制
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBus } from '../../src/core/events.js';
import { createTerrain } from '../../src/terrain.js';
import { pointInPolygon, polygonBBox, closestOnPolygon, closestOnSegment } from '../../src/geom.js';
import { validateSave, defaultSave } from '../../src/save.js';
import { MARKER_COLORS } from '../../src/map/marker-colors.js';
import { WEAPONS } from '../../src/weapons/defs.js';
import { createWeapons } from '../../src/weapons/weapons.js';
import { createSafehouses } from '../../src/shops/safehouse.js';
import {
  createPackages, createPackageMesh, buildPackageGeometry, applyResupply, resupplyItems, tierFor, resupplyNotice,
  PACKAGES, PACKAGE_TOTAL, PACKAGE_RADIUS, REWARD, COMPLETE_BONUS, ANIM_RANGE, MIN_GAP, MILESTONES, AMMO_MAX, MARKER_KIND,
} from '../../src/collect/packages.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(`${ROOT}${p}`, 'utf8');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ---------- 1. 座標合法（真實地圖資料）----------
const osm = JSON.parse(read('src/data/osm-city.json'));
const T = createTerrain(osm);
{
  const B = osm.bounds;
  const blds = osm.B.map((b) => ({ p: b.p, bb: polygonBBox(b.p) }));
  const cp = {};
  const bldDist = (x, z) => {
    let m = Infinity;
    for (const b of blds) {
      if (x < b.bb.x0 - 10 || x > b.bb.x1 + 10 || z < b.bb.z0 - 10 || z > b.bb.z1 + 10) continue;
      if (pointInPolygon(x, z, b.p)) return -1;
      m = Math.min(m, Math.sqrt(closestOnPolygon(x, z, b.p, cp).d2));
    }
    return m;
  };
  const TRAFFIC = new Set(['primary', 'secondary', 'tertiary', 'trunk']);
  const segs = [];
  for (const r of osm.R) for (let i = 0; i + 3 < r.p.length; i += 2) segs.push({ r, ax: r.p[i], az: r.p[i + 1], bx: r.p[i + 2], bz: r.p[i + 3] });
  // 車流道路：整個路面（半寬 + 1 m）都不可；巷道（residential / service）：中央（半寬 − 1 m 內）不可，路緣可
  const onLane = (x, z) => {
    for (const s of segs) {
      const lim = TRAFFIC.has(s.r.t) ? s.r.w / 2 + 1 : s.r.w / 2 - 1;
      closestOnSegment(x, z, s.ax, s.az, s.bx, s.bz, cp);
      if (cp.d2 < lim * lim) return s.r;
    }
    return null;
  };
  const S = {};
  const kindAt = (x, z) => T.querySurface(x, z, Infinity, S).kind;
  const inMap = (x, z, m) => x >= B.x0 + m && x <= B.x1 - m && z >= B.z0 + m && z <= B.z1 - m;
  check(`${PACKAGE_TOTAL} 個包裹、id 不重複`, PACKAGES.length === 20 && PACKAGE_TOTAL === 20 && new Set(PACKAGES.map((p) => p.id)).size === 20);
  const bad = [];
  for (const p of PACKAGES) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) bad.push(`${p.id} 座標非數`);
    if (!inMap(p.x, p.z, 20)) bad.push(`${p.id} 地圖外`);
    const bd = bldDist(p.x, p.z);
    if (bd < 1.5) bad.push(`${p.id} 建築內 / 貼牆 ${bd.toFixed(1)}`);
    const r = onLane(p.x, p.z);
    if (r) bad.push(`${p.id} 車道 ${r.n || r.t}`);
    const k = kindAt(p.x, p.z);
    if (k === 'water' || k === 'lakebed') bad.push(`${p.id} 水面`);
    if (!Number.isFinite(T.heightAt(p.x, p.z))) bad.push(`${p.id} 高度`);
  }
  check('全部在地圖內、不在建築體內、不在車流道路 / 巷道中央、不在水面', bad.length === 0, bad.slice(0, 4).join('; '));
  let minD = Infinity;
  for (const a of PACKAGES) for (const b of PACKAGES) if (a !== b) minD = Math.min(minD, Math.hypot(a.x - b.x, a.z - b.z));
  check(`彼此 ≥ ${MIN_GAP} m`, MIN_GAP === 120 && minD >= 120, `min ${minD.toFixed(1)}`);
  const spots = new Set(PACKAGES.map((p) => p.spot));
  check('藏點分類涵蓋巷弄 / 停車角落 / 橋下 / 河岸 / 秋紅谷步道', ['巷弄', '後巷停車角落', '橋下', '河岸', '秋紅谷步道'].every((s) => spots.has(s)));
  const qhg = PACKAGES.filter((p) => p.spot.startsWith('秋紅谷'));
  check('秋紅谷點位 y 取谷底高度（< 0）', qhg.length >= 2 && qhg.every((p) => T.heightAt(p.x, p.z) < -1));
}

// ---------- 替身 ----------
function rig(opts = {}) {
  const bus = createBus();
  const ev = [];
  for (const n of ['package:collect', 'package:milestone', 'package:resupply', 'ui:sound']) bus.on(n, (e) => ev.push([n, e]));
  const money = [];
  const toasts = [];
  const sets = [];
  let commits = 0;
  const view = {
    set: (i, x, y, z, r, vis) => sets.push({ i, y, r, vis }),
    commit: () => commits++,
  };
  const pk = createPackages({
    bus,
    groundAt: (x, z) => T.heightAt(x, z),
    earn: (n, reason) => money.push([n, reason]),
    toast: (t) => toasts.push(t),
    view,
    ...opts,
  });
  return { bus, ev, money, toasts, sets, pk, view, commits: () => commits, clear: () => { ev.length = 0; money.length = 0; toasts.length = 0; sets.length = 0; } };
}
const at = (p, dx = 0, dz = 0, dy = 0) => ({ x: p.x + dx, y: p.y + dy, z: p.z + dz });
function makeWeapons() {
  return createWeapons({ bus: { emit() {} }, combat: {}, player: { actor: {} }, raycast: () => null, sweep: () => [], settings: { get: () => undefined }, isTouch: false });
}

// ---------- 2. 自動收集半徑 / 重複不計 ----------
{
  const R = rig();
  const p0 = R.pk.list[0];
  check('收集半徑常數 2.5 m、每個 NT$100', PACKAGE_RADIUS === 2.5 && REWARD === 100);
  R.pk.update(0.016, at(p0, 2.6, 0));
  check('2.6 m 外不收集', R.pk.found === 0 && R.money.length === 0);
  R.pk.update(0.016, at(p0, 1.7, 1.7)); // 2.40 m
  check('2.4 m 內自動收集（不需按鍵）', R.pk.found === 1 && R.pk.isFound(p0.id));
  check('入帳 NT$100（reason package）', R.money.length === 1 && R.money[0][0] === 100 && R.money[0][1] === 'package');
  const c = R.ev.find((e) => e[0] === 'package:collect');
  check('package:collect { id, found, total, reward }', c && c[1].id === p0.id && c[1].found === 1 && c[1].total === 20 && c[1].reward === 100);
  check('音效 ui:sound reward', R.ev.some((e) => e[0] === 'ui:sound' && e[1].kind === 'reward'));
  check('toast「隱藏包裹 1 / 20」', R.toasts.some((t) => t.includes('隱藏包裹 1 / 20')));
  R.clear();
  for (let i = 0; i < 5; i++) R.pk.update(0.016, at(p0));
  check('重複經過不重複收集 / 入帳', R.pk.found === 1 && R.money.length === 0 && !R.ev.some((e) => e[0] === 'package:collect'));
  check('collect(id) 已收集 → false', R.pk.collect(p0.id) === false && R.pk.found === 1);
  check('collect(未知 id) → false', R.pk.collect('nope') === false);
  const p1 = R.pk.list[1];
  R.pk.update(0.016, at(p1, 0, 0, 6));
  check('高差 > 4 m（例：上方陸橋）不收集', !R.pk.isFound(p1.id));
  R.pk.update(0.016, { x: p1.x + 1, z: p1.z }); // 無 y（只比水平）
  check('playerPos 無 y → 只比水平距離', R.pk.isFound(p1.id));
  const qhg = R.pk.list.find((it) => PACKAGES[it.i].spot === '秋紅谷湖岸');
  R.pk.update(0.016, at(qhg, 0.5, 0, 0.9)); // 駕駛中車身原點離地約 0.6–1 m
  check('車內（車身位置、略高於地面）也收集', R.pk.isFound(qhg.id));
}

// ---------- 3. 里程碑 / 一次性獎金 ----------
{
  check('里程碑 5 / 10 / 15 / 20', MILESTONES.map((m) => m.at).join() === '5,10,15,20' && tierFor(4) === 0 && tierFor(5) === 1 && tierFor(14) === 2 && tierFor(15) === 3 && tierFor(20) === 4);
  const R = rig();
  const tiers = [];
  for (let k = 0; k < 20; k++) {
    R.ev.length = 0;
    R.pk.update(0.016, at(R.pk.list[k]));
    for (const e of R.ev) if (e[0] === 'package:milestone') tiers.push([k + 1, e[1].tier, e[1].unlock, e[1].found]);
  }
  check('依序收集：里程碑恰在 5 / 10 / 15 / 20 各發一次', JSON.stringify(tiers) === JSON.stringify([[5, 1, 'pistol', 5], [10, 2, 'smg', 10], [15, 3, 'shotgun', 15], [20, 4, 'all', 20]]), JSON.stringify(tiers));
  const bonus = R.money.filter((m) => m[0] === COMPLETE_BONUS);
  check('20 個：NT$10000 一次性獎金（共入帳 20×100 + 10000）', COMPLETE_BONUS === 10000 && bonus.length === 1 && R.money.reduce((s, m) => s + m[0], 0) === 2000 + 10000 && R.pk.bonusPaid);
  R.clear();
  const saved = R.pk.serialize();
  R.pk.restore(saved);
  for (const it of R.pk.list) R.pk.update(0.016, at(it));
  check('讀檔後不重發里程碑 / 獎金', R.money.length === 0 && !R.ev.some((e) => e[0] === 'package:milestone') && R.pk.tier === 4);
  // 跨存檔：19 個存檔 → 讀回 → 收第 20 個 → 只發 tier 4 一次
  const R2 = rig();
  R2.pk.restore({ found: PACKAGES.slice(0, 19).map((p) => p.id), tier: 3, bonus: false });
  check('讀 19 個：tier 3、未付獎金', R2.pk.found === 19 && R2.pk.tier === 3 && !R2.pk.bonusPaid && R2.ev.length === 0);
  R2.pk.update(0.016, at(R2.pk.list[19]));
  const ms = R2.ev.filter((e) => e[0] === 'package:milestone');
  check('收第 20 個：只發 tier 4、獎金一次', ms.length === 1 && ms[0][1].tier === 4 && R2.money.filter((m) => m[0] === COMPLETE_BONUS).length === 1);
  // 存檔已付獎金 + 20 個 → 不再付
  const R3 = rig();
  R3.pk.restore({ found: PACKAGES.map((p) => p.id), tier: 4, bonus: true });
  check('讀已完成存檔：bonusPaid true、不入帳', R3.pk.bonusPaid && R3.money.length === 0);
  // 存檔 tier 被改大也不會多解鎖
  const R4 = rig();
  R4.pk.restore({ found: [PACKAGES[0].id], tier: 4, bonus: false });
  check('存檔 tier 被改大 → 依數量（1 個 = tier 0）', R4.pk.tier === 0 && R4.pk.resupply() === null);
  // 髒存檔 / 手改存檔 bonus:true 但未找齊 → bonus 旗標無效，收齊 20 個時照常發 NT$10000
  {
    const dirty = validateSave({ version: 2, packages: { found: 'oops', bonus: true } });
    const R5 = rig();
    R5.pk.restore(dirty.packages);
    check('髒存檔（found 非陣列、bonus:true）→ 還原後 0 收集、bonusPaid false', R5.pk.found === 0 && !R5.pk.bonusPaid);
    R5.pk.restore({ found: [], tier: 0, bonus: true });
    check('restore { found: [], bonus: true } → bonusPaid false', R5.pk.found === 0 && !R5.pk.bonusPaid && R5.pk.serialize() === null);
    for (const it of R5.pk.list) R5.pk.update(0.016, at(it));
    check('髒存檔 bonus:true found 空 → 收齊 20 個仍發 NT$10000（一次）', R5.pk.found === 20 && R5.pk.bonusPaid && R5.money.filter((m) => m[0] === COMPLETE_BONUS).length === 1 && R5.money.reduce((t, m) => t + m[0], 0) === 2000 + 10000);
    const R6 = rig();
    R6.pk.restore({ found: PACKAGES.slice(0, 19).map((p) => p.id), tier: 3, bonus: true });
    check('19 個 + bonus:true → bonusPaid false', R6.pk.found === 19 && !R6.pk.bonusPaid);
    R6.pk.update(0.016, at(R6.pk.list[19]));
    check('19 個 + bonus:true → 收第 20 個發獎金一次', R6.money.filter((m) => m[0] === COMPLETE_BONUS).length === 1 && R6.pk.bonusPaid);
  }
}

// ---------- 4. 安全屋補給 ----------
{
  check('AMMO_MAX 與 defs.js reserveMax 一致', ['pistol', 'smg', 'shotgun'].every((id) => AMMO_MAX[id] === WEAPONS[id].reserveMax));
  check('resupplyItems 各 tier 累計清單', resupplyItems(0).length === 0 && resupplyItems(1).map((i) => i.weapon).join() === 'pistol' && resupplyItems(2).map((i) => i.weapon).join() === 'pistol,smg' && resupplyItems(3).map((i) => i.weapon).join() === 'pistol,smg,shotgun' && resupplyItems(4).map((i) => i.weapon).join() === 'pistol,smg,shotgun');
  // 未達 5 個 → 無補給
  {
    const w = makeWeapons();
    const R = rig({ weapons: w });
    R.pk.restore({ found: PACKAGES.slice(0, 4).map((p) => p.id) });
    check('4 個：resupply → null、不發事件', R.pk.resupply() === null && !R.ev.some((e) => e[0] === 'package:resupply'));
  }
  // tier 1：手槍（初始即擁有、備彈無限）→ 只補彈（0）、不給長槍
  {
    const w = makeWeapons();
    const R = rig({ weapons: w });
    R.pk.restore({ found: PACKAGES.slice(0, 5).map((p) => p.id) });
    const r = R.pk.resupply();
    check('tier 1：手槍已有 → 只補彈（無限備彈 ammo 0）、不給衝鋒槍 / 散彈槍', r && r.tier === 1 && r.items.length === 1 && r.items[0].weapon === 'pistol' && r.items[0].given === false && !w.owns('smg') && !w.owns('shotgun'));
    const e = R.ev.find((x) => x[0] === 'package:resupply');
    check('package:resupply { tier, items }；沒給武器也沒補到彈藥 → changed false、不 toast（不蓋掉安全屋存檔提示）', e && e[1].tier === 1 && Array.isArray(e[1].items) && r.changed === false && R.toasts.length === 0);
    let calls = 0;
    const r2 = R.pk.resupply({ save: () => ++calls > 0 });
    check('沒實際補給 → 不呼叫 save()、saved null', r2.changed === false && r2.saved === null && calls === 0 && R.toasts.length === 0);
  }
  // tier 2：沒衝鋒槍 → 給；已有 → 補到上限
  {
    const w = makeWeapons();
    const R = rig({ weapons: w });
    R.pk.restore({ found: PACKAGES.slice(0, 10).map((p) => p.id) });
    const r = R.pk.resupply();
    const smg = r.items.find((i) => i.weapon === 'smg');
    check('tier 2：缺衝鋒槍 → give（附贈 startReserve，不額外補）', smg && smg.given === true && w.owns('smg') && w.ammo('smg').reserve === WEAPONS.smg.startReserve && smg.ammo === 0);
    check('tier 2：不給散彈槍', !w.owns('shotgun') && !r.items.some((i) => i.weapon === 'shotgun'));
    check('tier 2：有給武器 → changed、toast 只列實際補給（衝鋒槍新取得，不列手槍）', r.changed === true && R.toasts.length === 1 && R.toasts[0].includes('安全屋補給') && R.toasts[0].includes('衝鋒槍（新取得）') && !R.toasts[0].includes('手槍'));
    const r2 = R.pk.resupply();
    const smg2 = r2.items.find((i) => i.weapon === 'smg');
    check('tier 2 再進安全屋：已有衝鋒槍 → 只補彈到上限（不再 give）', smg2.given === false && smg2.ammo === WEAPONS.smg.reserveMax - WEAPONS.smg.startReserve && w.ammo('smg').reserve === WEAPONS.smg.reserveMax);
    const r3 = R.pk.resupply();
    check('已滿 → 補 0', r3.items.find((i) => i.weapon === 'smg').ammo === 0);
    check('已滿 → changed false、不再 toast', r3.changed === false && R.toasts.length === 2);
  }
  // resupply({ save })：有補給才再存檔，存檔結果併入同一則 toast
  {
    const w = makeWeapons();
    const R = rig({ weapons: w });
    R.pk.restore({ found: PACKAGES.slice(0, 10).map((p) => p.id) });
    const owned = [];
    const r = R.pk.resupply({ save: () => owned.push(w.owns('smg')) > 0 });
    check('有補給 → save() 在補給之後呼叫一次（存檔時已擁有衝鋒槍）', owned.length === 1 && owned[0] === true && r.saved === true);
    check('save 成功 → 同一則 toast：存檔提示 + 補給內容', R.toasts.length === 1 && R.toasts[0].startsWith('已在安全屋存檔，體力回滿。') && R.toasts[0].includes('衝鋒槍'));
    const W2 = makeWeapons();
    const R2 = rig({ weapons: W2 });
    R2.pk.restore({ found: PACKAGES.slice(0, 15).map((p) => p.id) });
    const r2 = R2.pk.resupply({ save: () => false });
    check('save 回 false → saved false、toast 含存檔失敗字樣', r2.saved === false && R2.toasts.length === 1 && R2.toasts[0].includes('存檔失敗') && R2.toasts[0].includes('散彈槍'));
    const W3 = makeWeapons();
    const R3 = rig({ weapons: W3 });
    R3.pk.restore({ found: PACKAGES.slice(0, 10).map((p) => p.id) });
    const r3 = R3.pk.resupply({ save: () => { throw new Error('quota'); } });
    check('save 丟例外 → saved false、toast 含存檔失敗', r3.saved === false && R3.toasts[0].includes('存檔失敗'));
    check('resupplyNotice：saved null → 只有補給文字', resupplyNotice(2, [{ weapon: 'smg', given: true, ammo: 0 }]) === '安全屋補給（隱藏包裹里程碑 2）：衝鋒槍（新取得）');
  }
  // 與安全屋合用（同一個 toast 槽）：save 回 false 時最後可見 toast 必含存檔失敗
  for (const [n, label] of [[5, 'tier 1 無實際補給'], [10, 'tier 2 給衝鋒槍'], [20, 'tier 4 全補']]) {
    const w = makeWeapons();
    const bus = createBus();
    const toasts = [];
    const toast = (t) => toasts.push(t);
    const pk = createPackages({ bus, weapons: w, toast });
    pk.restore({ found: PACKAGES.slice(0, n).map((p) => p.id), tier: 4, bonus: n === 20 });
    const sh = createSafehouses({ bus, save: () => false, toast });
    bus.on('safehouse:enter', () => pk.resupply({ save: () => false }));
    const res = sh.enter('safehouse-henan');
    check(`安全屋存檔失敗（${label}）→ 最後可見 toast 含「存檔失敗」`, res.ok && res.saved === false && toasts.length > 0 && toasts[toasts.length - 1].includes('存檔失敗'), toasts[toasts.length - 1]);
  }
  // tier 3：已買散彈槍 → 只補彈
  {
    const w = makeWeapons();
    w.give('shotgun');
    const R = rig({ weapons: w });
    R.pk.restore({ found: PACKAGES.slice(0, 15).map((p) => p.id) });
    const r = R.pk.resupply();
    const sg = r.items.find((i) => i.weapon === 'shotgun');
    check('tier 3：已有散彈槍 → given false、補到 60', r.tier === 3 && sg.given === false && sg.ammo === 60 - WEAPONS.shotgun.startReserve && w.ammo('shotgun').reserve === 60);
    check('tier 3：同時補給衝鋒槍（累計）', r.items.find((i) => i.weapon === 'smg').given === true && w.owns('smg'));
  }
  // tier 4：全武器補滿（新給的也補滿）
  {
    const w = makeWeapons();
    const R = rig({ weapons: w });
    R.pk.restore({ found: PACKAGES.map((p) => p.id), tier: 4, bonus: true });
    const r = R.pk.resupply();
    check('tier 4：手槍 / 衝鋒槍 / 散彈槍', r.tier === 4 && r.items.map((i) => i.weapon).join() === 'pistol,smg,shotgun');
    check('tier 4：缺的給、全部補滿', w.owns('smg') && w.owns('shotgun') && w.ammo('smg').reserve === 300 && w.ammo('shotgun').reserve === 60);
    check('tier 4 補給不再給獎金', !R.money.some((m) => m[0] === COMPLETE_BONUS));
  }
  check('applyResupply 無 weapons → given false / ammo 0', applyResupply(null, 4).every((i) => i.given === false && i.ammo === 0));
}

// ---------- 5. 存檔 ----------
{
  const R = rig();
  check('0 收集 → serialize null（存檔省略）', R.pk.serialize() === null);
  R.pk.update(0.016, at(R.pk.list[3]));
  R.pk.update(0.016, at(R.pk.list[7]));
  const s = R.pk.serialize();
  check('serialize → { found, tier, bonus }', s && s.found.join() === 'pkg-04,pkg-08' && s.tier === 0 && s.bonus === false);
  const full = { ...defaultSave(), packages: s };
  const v = validateSave(JSON.parse(JSON.stringify(full)));
  check('save.js validateSave 保留 packages', v && v.packages && v.packages.found.join() === 'pkg-04,pkg-08' && v.packages.tier === 0 && v.packages.bonus === false);
  const R2 = rig();
  R2.pk.restore(v.packages);
  check('restore 往返：同樣 2 個已收集', R2.pk.found === 2 && R2.pk.isFound('pkg-04') && R2.pk.isFound('pkg-08'));
  const old = validateSave({ version: 2, money: 500 });
  check('舊存檔（無 packages）：validateSave 省略、defaultSave 不含', old && !('packages' in old) && !('packages' in defaultSave()));
  const R3 = rig();
  R3.pk.update(0.016, at(R3.pk.list[0]));
  R3.pk.restore(old.packages);
  check('restore(undefined) → 0 收集', R3.pk.found === 0 && R3.pk.tier === 0 && !R3.pk.bonusPaid);
  const junk = validateSave({ version: 2, packages: { found: ['pkg-01', 'pkg-01', 5, 'a b', 'pkg-99'], tier: 'x', bonus: 'yes' } });
  check('save.js 清洗：去重 / 非法 id 丟棄、tier 非整數 → 0、bonus 非 true → false', junk.packages && junk.packages.found.join() === 'pkg-01,pkg-99' && junk.packages.tier === 0 && junk.packages.bonus === false);
  check('save.js：格式錯誤整欄丟棄', !('packages' in validateSave({ version: 2, packages: 'oops' })) && !('packages' in validateSave({ version: 2, packages: { found: [] } })));
  check('save.js：found 非陣列 / 空陣列 / 清洗後為空 → 整欄丟棄，不保留 bonus:true', ['oops', undefined, [], [5, 'a b']].every((found) => !('packages' in validateSave({ version: 2, packages: { found, tier: 4, bonus: true } }))));
  const R4 = rig();
  R4.pk.restore(junk.packages);
  check('restore 不認得的 id（pkg-99）不計', R4.pk.found === 1);
  R4.pk.restore([1, 2, 3]);
  check('restore 非物件 → 0 收集', R4.pk.found === 0);
}

// ---------- 6. 動畫 / 標記 / cancel ----------
{
  const R = rig();
  check('建立時寫入全部靜止姿態一次', R.sets.length === 20 && R.commits() === 1 && R.sets.every((s) => s.vis));
  R.clear();
  const c0 = R.commits();
  const far = { x: -9999, y: 0, z: -9999 };
  for (let i = 0; i < 30; i++) R.pk.update(0.016, far);
  check('60 m 外：不更新矩陣、不 commit', R.sets.length === 0 && R.commits() === c0);
  const p = R.pk.list[5];
  R.pk.update(0.016, at(p, ANIM_RANGE - 1, 0));
  check('60 m 內：只更新該包裹', R.sets.length === 1 && R.sets[0].i === 5 && R.commits() === c0 + 1);
  const r1 = R.sets[0].r;
  R.pk.update(0.5, at(p, ANIM_RANGE - 1, 0));
  check('自轉 / 浮動隨時間變化', R.sets.length === 2 && R.sets[1].r !== r1 && R.sets[1].y !== R.sets[0].y);
  R.clear();
  R.pk.update(0.016, at(p, ANIM_RANGE + 5, 0));
  check('離開範圍：回靜止姿態一次', R.sets.length === 1 && R.sets[0].i === 5);
  R.pk.update(0.016, at(p, ANIM_RANGE + 5, 0));
  check('之後不再更新', R.sets.length === 1);
  check('未收集：大地圖不標示（markers 空）', R.pk.markers().length === 0);
  R.clear();
  R.pk.update(0.016, at(p));
  check('收集 → 該包裹隱藏', R.sets.some((s) => s.i === 5 && s.vis === false));
  const mk = R.pk.markers();
  check(`已收集：kind '${MARKER_KIND}' 標記`, mk.length === 1 && mk[0].kind === 'package' && mk[0].x === p.x && mk[0].z === p.z);
  check('markers() 未變動時回同一陣列（不配置）', R.pk.markers() === mk);
  const out = [{ x: 0, z: 0 }];
  check('markers(out) 附加到 out', R.pk.markers(out) === out && out.length === 2);
  check('marker-colors：package 色碼存在、全表不重複', !!MARKER_COLORS.package && new Set(Object.values(MARKER_COLORS)).size === Object.values(MARKER_COLORS).length);
  check('progress / progressText', R.pk.progress().found === 1 && R.pk.progress().total === 20 && R.pk.progressText() === '隱藏包裹 1 / 20');
  R.clear();
  R.pk.cancel();
  check('cancel：全部回靜止姿態（已收集維持隱藏）、收集狀態不變', R.sets.length === 20 && R.sets.find((s) => s.i === 5).vis === false && R.sets.filter((s) => s.vis).length === 19 && R.pk.found === 1);
  R.clear();
  R.pk.update(0.016, at(p));
  check('cancel 後不重複收集', R.money.length === 0);
  R.pk.dispose();
  R.pk.update(0.016, at(R.pk.list[6]));
  check('dispose 後 update 無動作', R.pk.found === 1);
  const L = createPackages({});
  L.update(0.016, { x: PACKAGES[0].x, z: PACKAGES[0].z });
  check('無 bus / view / earn / weapons 也可運作（groundAt 缺 = 0）', L.found === 1 && L.list[0].y === 0 && L.resupply() === null);
}

// ---------- 7. 網格（假 THREE）----------
{
  const made = { meshes: 0, mats: [], textures: 0, lights: 0, inst: [] };
  class BoxGeometry {
    constructor(w, h, d, ws, hs, ds) {
      const ys = [];
      for (let k = 0; k <= hs; k++) ys.push(-h / 2 + (h * k) / hs);
      const pts = [];
      for (const y of ys) for (let n = 0; n < 4; n++) pts.push(y);
      for (let n = 0; n < 4; n++) pts.push(h / 2, -h / 2);
      this.attributes = { position: { count: pts.length, getY: (i) => pts[i] } };
    }
    setAttribute(k, v) { this.attributes[k] = v; }
    dispose() { this.disposed = true; }
  }
  class Matrix4 {
    constructor() { this.e = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; made.m4 = (made.m4 || 0) + 1; }
    makeRotationY(a) { const c = Math.cos(a); const s = Math.sin(a); this.e = [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; return this; }
    makeScale(x, y, z) { this.e = [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]; return this; }
    setPosition(x, y, z) { this.e[12] = x; this.e[13] = y; this.e[14] = z; return this; }
  }
  const THREE = {
    BoxGeometry,
    BufferAttribute: class { constructor(a, n) { this.array = a; this.itemSize = n; } },
    MeshBasicMaterial: class { constructor(o) { Object.assign(this, o); made.mats.push(this); } dispose() { this.disposed = true; } },
    InstancedMesh: class {
      constructor(g, m, n) { this.geometry = g; this.material = m; this.count = n; this.mats = []; this.instanceMatrix = { needsUpdate: false }; made.meshes++; made.inst.push(this); }
      setMatrixAt(i, m) { this.mats[i] = m.e.slice(); }
    },
    Matrix4,
    TextureLoader: class { constructor() { made.textures++; } },
    PointLight: class { constructor() { made.lights++; } },
  };
  const added = [];
  const scene = { add: (o) => added.push(o) };
  const view = createPackageMesh({ THREE, scene });
  check('網格：20 個 = 1 個 InstancedMesh（draw call +1 ≤ 2）', made.meshes === 1 && added.length === 1 && view.mesh.count === 20 && made.mats.length === 1);
  check('材質：MeshBasicMaterial vertexColors、無貼圖 / 光源 / 陰影', made.mats[0].vertexColors === true && !made.mats[0].map && made.textures === 0 && made.lights === 0 && view.mesh.castShadow === false && view.mesh.receiveShadow === false);
  const geo = view.mesh.geometry;
  check('幾何：頂點色 color 屬性（每頂點 3 值）', geo.attributes.color && geo.attributes.color.itemSize === 3 && geo.attributes.color.array.length === geo.attributes.position.count * 3);
  const m4Before = made.m4;
  const pk = createPackages({ view, groundAt: () => 0 });
  for (let i = 0; i < 50; i++) pk.update(0.016, { x: PACKAGES[2].x + 10, y: 0, z: PACKAGES[2].z });
  check('每幀不新建 Matrix4（set 重用同一個）', made.m4 === m4Before);
  check('靜止姿態：離地 LIFT、可見', view.mesh.mats[0][13] > 0.3 && view.mesh.mats[0][0] !== 0);
  pk.collect(PACKAGES[0].id);
  check('已收集：矩陣縮成 0、needsUpdate', view.mesh.mats[0][0] === 0 && view.mesh.mats[0][5] === 0 && view.mesh.instanceMatrix.needsUpdate === true);
  view.mesh.parent = { remove: () => (view.mesh.parent = null) };
  pk.dispose();
  check('dispose：移出場景、釋放幾何 / 材質', view.mesh.parent === null && geo.disposed && made.mats[0].disposed);
  check('buildPackageGeometry 可單獨呼叫', !!buildPackageGeometry(THREE).attributes.color);
}

// ---------- 8. 原始碼限制 ----------
{
  const src = read('src/collect/packages.js');
  check('packages.js 不 import three（純邏輯，THREE 由參數注入）', !/^import /m.test(src) && !/import\(['"]three/.test(src));
  check('packages.js 無光源 / 貼圖 / 陰影', !/Light\(|Texture|shadowMap|castShadow = true/.test(src));
  const upd = src.slice(src.indexOf('function update(dt, pos)'), src.indexOf('// 安全屋補給'));
  check('update 內不配置物件（無 new / 物件 / 陣列字面值）', upd.length > 200 && !/new |\{ *\w+:|\[\s*\]/.test(upd.replace(/\/\/[^\n]*/g, '')));
  check('檔頭列出事件 package:collect / milestone / resupply', /package:collect \{ id, found, total, reward \}/.test(src) && /package:milestone \{ tier, found, unlock \}/.test(src) && /package:resupply \{ tier, items \}/.test(src));
  const big = read('src/map/big-map.js');
  check('大地圖：圖例 package、淡化（FADED_KINDS）、小方塊圖示、圖例統計列', /package: '隱藏包裹（已收集）'/.test(big) && /FADED_KINDS\.add\('package'\)/.test(big) && /SMALL_KINDS = new Set\(\['package'\]\)/.test(big) && /getLegendStats/.test(big));
  check('暫停選單統計頁：隱藏包裹 N / total', /add\('隱藏包裹', `\$\{[^`]*\} \/ \$\{s\.hiddenPackagesTotal\}`\)/.test(read('src/ui/menu.js')));
}

console.log(failed === 0 ? `PASS ${passed}/${passed}` : `FAIL ${failed}/${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
