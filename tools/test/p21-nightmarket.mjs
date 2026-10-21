#!/usr/bin/env node
// P21 夜市攤位小遊戲（src/minigames/nightmarket.js）純邏輯驗證：不 import three（3D 外觀以假 THREE 驗；經濟 / 存檔用真的 economy.js / save.js）
// 用法：node tools/test/p21-nightmarket.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：攤位座標合法（夜市角頭地盤內、地圖內、不在建築 / 車道 / 步道 / 水面、不與既有攤位道具重疊、避開外送取餐半徑）、付費與餘額不足、
//   射氣球計分（單顆 / 一槍兩顆 / 落點之前才算 / 只算手槍）與獎金門檻（< 12 = 0、≥ 12 = 300、全破 = 800）、局中不算犯行（局外照常）、
//   彈珠台蓄力 / 彈跳 / 格子計分 / 獎金門檻（總分 ≥ 150 = 200、最高格 = 500）與整局流程、最佳成績與存檔相容（save.js 清洗、舊存檔）、
//   互斥（通緝「先甩掉警察」/ 任務中）、走遠 > 8 m 結束不退費、Esc、cancel、3D 外觀 draw call 3 與無貼圖 / 光源、原始碼限制
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBus } from '../../src/core/events.js';
import { createTerrain } from '../../src/terrain.js';
import { pointInPolygon, polygonBBox, closestOnPolygon, closestOnSegment } from '../../src/geom.js';
import { territoryAt } from '../../src/gangs.js';
import { validateSave, defaultSave } from '../../src/save.js';
import { createEconomy } from '../../src/economy.js';
import { stallRow, STALL_ROW_PITCH, runStallSpot, VALET_SITES, valetSpots } from '../../src/job-props.js';
import { NIGHT_MARKET_DELIVERY } from '../../src/missions/events.js';
import { GARBAGE_TRUCK_EVENT, DUMP_RADIUS } from '../../src/missions/garbage-truck.js';
import { GUN_SHOPS } from '../../src/shops/gun-shop.js';
import {
  createNightMarket, createNightMarketView, BOOTHS, MINIGAME_RADIUS, MINIGAME_PRIORITY, LEAVE_DIST, WANTED_TEXT, MINIGAME_KIND,
  BALLOON_PRICE, BALLOON_COUNT, BALLOON_SHOTS, BALLOON_WIN, BALLOON_REWARD, BALLOON_ALL_REWARD, BALLOON_SPACING, BALLOON_HIT_R,
  balloonCenters, rayBalloonHits, balloonReward, boothFootprint, boothColliderBoxes, beaconPoint,
  PACHINKO_PRICE, PACHINKO_BALLS, PACHINKO_WIN, PACHINKO_REWARD, PACHINKO_JACKPOT_REWARD, PACHINKO_MAX_SCORE, SLOT_SCORES, PEGS, PEG_R, BALL_R, BOARD_W,
  chargePower, launchSpeed, createBall, launchBall, pachinkoStep, simulatePachinko, slotAt, pachinkoReward, checkPlay, minigameRecord, CHARGE_RATE, LAUNCH,
  createRng, POWER_MIN, MINIGAME_OVERRIDE_PRIORITY, BALLOON_WEAPON, BALLOON_AIM_DEG, BALLOON_AIM_DIST, BALLOON_FOUL_SHOTS,
} from '../../src/minigames/nightmarket.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(`${ROOT}${p}`, 'utf8');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ---------- 1. 攤位座標合法（真實地圖資料）----------
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
  const segs = [];
  for (const r of osm.R) for (let i = 0; i + 3 < r.p.length; i += 2) segs.push({ r, foot: false, ax: r.p[i], az: r.p[i + 1], bx: r.p[i + 2], bz: r.p[i + 3] });
  for (const r of osm.F) for (let i = 0; i + 3 < r.p.length; i += 2) segs.push({ r, foot: true, ax: r.p[i], az: r.p[i + 1], bx: r.p[i + 2], bz: r.p[i + 3] });
  // 到最近路面 / 步道邊緣的距離（< 0 = 在路面上）
  const surfDist = (x, z) => {
    let m = Infinity;
    let hit = null;
    for (const s of segs) {
      closestOnSegment(x, z, s.ax, s.az, s.bx, s.bz, cp);
      const d = Math.sqrt(cp.d2) - s.r.w / 2;
      if (d < m) {
        m = d;
        hit = s;
      }
    }
    return { d: m, s: hit };
  };
  const S = {};
  const kindAt = (x, z) => T.querySurface(x, z, Infinity, S).kind;
  const inMap = (x, z, m) => x >= B.x0 + m && x <= B.x1 - m && z >= B.z0 + m && z <= B.z1 - m;

  check('2 個攤位：balloon / pachinko、id 不重複、價格 50 / 30', BOOTHS.length === 2 && BOOTHS[0].id === 'balloon' && BOOTHS[1].id === 'pachinko'
    && BOOTHS[0].price === BALLOON_PRICE && BALLOON_PRICE === 50 && BOOTHS[1].price === PACHINKO_PRICE && PACHINKO_PRICE === 30);

  // 既有夜市攤位列（main.js stallPlacement：取餐點最近車道 → 取餐點即攤車原位、正面朝道路點；job-props.js stallRow 沿路緣 ±STALL_ROW_PITCH）
  const pk = NIGHT_MARKET_DELIVERY.pickup;
  let road = null;
  {
    let best = Infinity;
    for (const s of segs) {
      if (s.foot) continue;
      closestOnSegment(pk.x, pk.z, s.ax, s.az, s.bx, s.bz, cp);
      if (cp.d2 < best) {
        best = cp.d2;
        road = { x: cp.x, z: cp.z, s };
      }
    }
  }
  const row = stallRow({ x: pk.x, z: pk.z, faceX: road.x, faceZ: road.z }, () => 0, () => true);
  const STALL_HALF = Math.hypot(1.11, 0.78); // 攤車碰撞盒外接圓半徑（prop-model PROP_COLLIDERS.night_market_stall）
  check('既有攤位列 3 格（原攤車 + oyster / tea）且相鄰 2.72 m', row.length === 3 && Math.abs(Math.hypot(row[1].pl.x - row[0].pl.x, row[1].pl.z - row[0].pl.z) - STALL_ROW_PITCH) < 1e-6);

  const bad = [];
  for (const b of BOOTHS) {
    const foot = boothFootprint(b);
    const pts = [{ x: b.x, z: b.z, tag: '站位' }, ...foot.map((p, i) => ({ ...p, tag: `角${i}` })), { ...beaconPoint(b), tag: '光柱' }];
    // 占地中心與各邊中點也驗
    for (let i = 0; i < 4; i++) pts.push({ x: (foot[i].x + foot[(i + 1) % 4].x) / 2, z: (foot[i].z + foot[(i + 1) % 4].z) / 2, tag: `邊${i}` });
    for (const p of pts) {
      if (!inMap(p.x, p.z, 20)) bad.push(`${b.id} ${p.tag} 地圖外`);
      const g = territoryAt(p.x, p.z);
      if (!g || g.id !== 'nightmarket') bad.push(`${b.id} ${p.tag} 不在夜市角頭地盤`);
      const bd = bldDist(p.x, p.z);
      if (bd < 1) bad.push(`${b.id} ${p.tag} 建築內 / 貼牆 ${bd.toFixed(1)}`);
      const sd = surfDist(p.x, p.z);
      if (sd.d < 0.5) bad.push(`${b.id} ${p.tag} 在${sd.s.foot ? '步道' : '車道'} ${sd.s.r.n || sd.s.r.t} ${sd.d.toFixed(2)}`);
      const k = kindAt(p.x, p.z);
      if (k === 'water' || k === 'lakebed') bad.push(`${b.id} ${p.tag} 水面`);
      if (!Number.isFinite(T.heightAt(p.x, p.z))) bad.push(`${b.id} ${p.tag} 高度`);
      for (const st of row) {
        const d = Math.hypot(p.x - st.pl.x, p.z - st.pl.z);
        if (d < STALL_HALF + 2) bad.push(`${b.id} ${p.tag} 與既有攤位 ${st.key} 重疊 ${d.toFixed(1)}`);
      }
    }
    const rd = surfDist(b.x, b.z);
    if (!(rd.d >= 1 && rd.d <= 4 && !rd.s.foot)) bad.push(`${b.id} 站位不在路緣外人行道（離車道 ${rd.d.toFixed(1)}）`);
    if (Math.hypot(b.x - pk.x, b.z - pk.z) < pk.radius + MINIGAME_RADIUS) bad.push(`${b.id} 進入外送取餐半徑`);
    for (const g of GUN_SHOPS) if (Math.hypot(b.x - g.x, b.z - g.z) < 25) bad.push(`${b.id} 太靠近 ${g.id}`);
  }
  check('攤位占地全部在地圖內、夜市角頭地盤內、不壓建築 / 車道 / 步道 / 水面、不與既有攤位重疊', bad.length === 0, bad.slice(0, 4).join('; '));
  const d01 = Math.hypot(BOOTHS[0].x - BOOTHS[1].x, BOOTHS[0].z - BOOTHS[1].z);
  check('兩攤互動範圍不重疊、仍在同一夜市（相距 > 2 × 半徑且 < 60 m）', d01 > MINIGAME_RADIUS * 2 + LEAVE_DIST && d01 < 60, d01.toFixed(1));
  // 驗收修正：離委託 / 打工起點 ≥ 12 m，且不落入其互動觸發圈（missions/index.js、core/landmark-points.js 依賴 css / JSON import → 讀原始碼常數）
  {
    const num = (file, re) => Number((read(file).match(re) || [])[1]);
    const START_PAD = num('src/missions/index.js', /export const START_PAD = (\d+(?:\.\d+)?);/);
    const LANDMARK_RADIUS = num('src/core/landmark-points.js', /export const LANDMARK_RADIUS = (\d+(?:\.\d+)?);/);
    const rs = runStallSpot(row);
    const valet = valetSpots(VALET_SITES, () => 0);
    // 委託目錄內建委託起點 shin_kong_mitsukoshi：地標點以 OSM「新光三越」建物輪廓重心近似（public/models/manifest.json 不在 staging）
    const skm = osm.B.find((b) => b.n === '新光三越');
    const sk = { x: 0, z: 0 };
    for (let i = 0; i < skm.p.length; i += 2) {
      sk.x += skm.p[i] / (skm.p.length / 2);
      sk.z += skm.p[i + 1] / (skm.p.length / 2);
    }
    const starts = [
      { tag: '外送取餐點', x: pk.x, z: pk.z, trig: pk.radius },
      { tag: '夜市跑單 stallBack', x: rs.stallBack.x, z: rs.stallBack.z, trig: MINIGAME_RADIUS },
      ...row.map((st) => ({ tag: `攤位列 ${st.key}`, x: st.pl.x, z: st.pl.z, trig: 0 })),
      ...valet.map((v) => ({ tag: `泊車亭 ${v.id}`, x: v.standX, z: v.standZ, trig: MINIGAME_RADIUS })),
      { tag: '委託起點 新光三越', x: sk.x, z: sk.z, trig: LANDMARK_RADIUS + START_PAD },
    ];
    const far = [];
    for (const b of BOOTHS) {
      for (const p of starts) {
        const d = Math.hypot(b.x - p.x, b.z - p.z);
        if (d < 12 || d < p.trig + MINIGAME_RADIUS) far.push(`${b.id}–${p.tag} ${d.toFixed(1)}`);
      }
    }
    check('攤位站位離委託 / 打工起點 ≥ 12 m 且在其觸發圈 + 攤位半徑之外（取餐點、stallBack、攤位列、泊車亭、新光三越委託起點）',
      starts.length >= 6 && START_PAD > 0 && LANDMARK_RADIUS > 0 && far.length === 0, far.slice(0, 4).join('; '));
    // 垃圾車沿任一車道（中心線偏 laneOffsetM）行駛，車尾投入口 DUMP_RADIUS 內可互動 → 站位離所有車道中心線 ≥ 偏移 + DUMP_RADIUS + 攤位半徑
    const need = GARBAGE_TRUCK_EVENT.laneOffsetM + DUMP_RADIUS + MINIGAME_RADIUS;
    const near = [];
    for (const b of BOOTHS) {
      let m = Infinity;
      for (const sg of segs) {
        if (sg.foot) continue;
        closestOnSegment(b.x, b.z, sg.ax, sg.az, sg.bx, sg.bz, cp);
        m = Math.min(m, Math.sqrt(cp.d2));
      }
      if (m < need) near.push(`${b.id} ${m.toFixed(2)} < ${need}`);
    }
    check('攤位互動範圍不與路過的垃圾車投入口重疊（站位離任一車道中心線 ≥ 1.8 + 5 + 2.5 m）', need === 9.3 && near.length === 0, near.join('; '));
  }
  // 攤位朝向：前方（+Z 本地）背離道路 → 子彈打向攤位內側（後牆後方不是車道）
  const balloon = BOOTHS[0];
  const wall = { x: balloon.x + Math.sin(balloon.yaw) * 4, z: balloon.z + Math.cos(balloon.yaw) * 4 };
  check('射氣球後牆比站位離車道更遠（面向攤位內側、背離道路）', surfDist(wall.x, wall.z).d > surfDist(balloon.x, balloon.z).d + 3);
  const boxes = boothColliderBoxes(BOOTHS, (x, z) => T.heightAt(x, z));
  check('碰撞盒 5 個（射氣球櫃台 / 後牆 / 兩側板 + 彈珠台機台），尺寸有限', boxes.length === 5 && boxes.every((b) => [b.x, b.y, b.z, b.yaw, b.width, b.depth, b.height].every(Number.isFinite) && b.width > 0 && b.depth > 0 && b.height > 0));
}

// ---------- 共用：建立模組與替身 ----------
function setup({ money = 1000, stars = 0, busy = null, seed = null, weapon = null } = {}) {
  const bus = createBus();
  const economy = createEconomy({ bus, initial: { ...defaultSave(), money } });
  const st = { stars, busy, toasts: [], events: [], crimes: 0, equip: 0 };
  // 整合層的 gunfire 犯行監聽（main.js 比 nightmarket 早註冊；局中豁免）
  let nm = null;
  bus.on('weapon:fire', (e) => {
    if (!e || !e.byPlayer) return;
    if (nm && nm.exemptShot(e)) return;
    st.crimes++;
  });
  for (const n of ['minigame:start', 'minigame:end']) bus.on(n, (e) => st.events.push({ n, ...e }));
  nm = createNightMarket({
    bus,
    getMoney: () => economy.money,
    spend: (n, r) => economy.spend(n, r),
    earn: (n, r) => economy.add(n, r),
    getStars: () => st.stars,
    isBusy: () => st.busy,
    equipPistol: () => { st.equip++; },
    getWeapon: weapon ? () => st.weapon : null,
    pachinkoSeed: seed,
    toast: (t) => st.toasts.push(t),
  });
  st.weapon = weapon;
  return { bus, economy, nm, st };
}
const B0 = BOOTHS[0];
const groundY = 0;
const centers = balloonCenters(B0, groundY);
const eye = { x: B0.x, y: 1.5, z: B0.z }; // 槍口（站位、1.5 m 高）
// 朝目標點開一槍（落點 = 後牆，目標後方 0.3 m）；weapon 預設 pistol
function shootAt(bus, tx, ty, tz, { weapon = 'pistol', endBefore = false } = {}) {
  const dx = tx - eye.x;
  const dy = ty - eye.y;
  const dz = tz - eye.z;
  const L = Math.hypot(dx, dy, dz);
  const k = endBefore ? (L - 1) / L : (L + 0.3) / L;
  bus.emit('weapon:fire', { weapon, x: eye.x, y: eye.y, z: eye.z, dirX: dx / L, dirY: dy / L, dirZ: dz / L, byPlayer: true, hit: false, miss: false,
    ex: eye.x + dx * k, ey: eye.y + dy * k, ez: eye.z + dz * k, dist: L * k, vehicle: null });
}
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
const ctxAt = (x, z, onFoot = true) => ({ x, z, onFoot, frozen: false });

// ---------- 2. 氣球幾何 / 射線 ----------
{
  check('氣球 5 × 3 = 15 顆、10 發、≥ 12 顆 NT$300、全破 NT$800', BALLOON_COUNT === 15 && centers.length === 15 && BALLOON_SHOTS === 10 && BALLOON_WIN === 12 && BALLOON_REWARD === 300 && BALLOON_ALL_REWARD === 800);
  const dH = Math.hypot(centers[1].x - centers[0].x, centers[1].z - centers[0].z);
  const dV = centers[5].y - centers[0].y;
  check('相鄰間距 0.45 m（水平 / 垂直），命中半徑介於半間距與對角半距之間', Math.abs(dH - BALLOON_SPACING) < 1e-9 && Math.abs(dV - BALLOON_SPACING) < 1e-9
    && BALLOON_HIT_R > BALLOON_SPACING / 2 && BALLOON_HIT_R < (BALLOON_SPACING * Math.SQRT2) / 2);
  const alive = new Array(15).fill(true);
  const hits = [];
  const c = centers[7];
  const n1 = rayBalloonHits(eye.x, eye.y, eye.z, c.x - eye.x, c.y - eye.y, c.z - eye.z, Infinity, centers, alive, hits);
  check('瞄準單顆中心 → 只破 1 顆（就是那顆）', n1 === 1 && hits[0] === 7);
  const m = mid(centers[6], centers[7]);
  const n2 = rayBalloonHits(eye.x, eye.y, eye.z, m.x - eye.x, m.y - eye.y, m.z - eye.z, Infinity, centers, alive, hits);
  check('瞄兩顆中間 → 一槍兩顆', n2 === 2 && hits.includes(6) && hits.includes(7));
  const corner = mid(mid(centers[0], centers[1]), mid(centers[5], centers[6]));
  const n4 = rayBalloonHits(eye.x, eye.y, eye.z, corner.x - eye.x, corner.y - eye.y, corner.z - eye.z, Infinity, centers, alive, hits);
  check('四顆交角 → 一槍至多兩顆（不會 4 顆）', n4 <= 2, `n=${n4}`);
  const L = Math.hypot(c.x - eye.x, c.y - eye.y, c.z - eye.z);
  check('落點在氣球之前（打到櫃台等）→ 不算', rayBalloonHits(eye.x, eye.y, eye.z, c.x - eye.x, c.y - eye.y, c.z - eye.z, L - 1, centers, alive, hits) === 0);
  check('朝後方開槍 → 不算', rayBalloonHits(eye.x, eye.y, eye.z, eye.x - c.x, 0, eye.z - c.z, Infinity, centers, alive, hits) === 0);
  alive[7] = false;
  check('已破的不再算', rayBalloonHits(eye.x, eye.y, eye.z, c.x - eye.x, c.y - eye.y, c.z - eye.z, Infinity, centers, alive, hits) === 0);
  check('balloonReward：11 → 0、12 → 300、14 → 300、15 → 800', balloonReward(11) === 0 && balloonReward(12) === 300 && balloonReward(14) === 300 && balloonReward(15) === 800 && balloonReward(-3) === 0);
}

// ---------- 3. 付費、餘額不足、射氣球整局 ----------
{
  const { bus, economy, nm, st } = setup({ money: 40 });
  check('餘額不足（NT$40 < 50）→ 不開局、不扣款、提示錢不夠', nm.start('balloon') === false && economy.money === 40 && !nm.active && st.toasts.some((t) => t.includes('錢不夠')) && st.events.length === 0);
  const inter = nm.nearest({ x: B0.x + 1, z: B0.z });
  check('站位 2.5 m 內 → interactable（priority 2、提示含價格）', inter && inter.priority === MINIGAME_PRIORITY && MINIGAME_PRIORITY === 2 && inter.text.includes('射氣球') && inter.text.includes('50') && Math.abs(inter.dist - 1) < 1e-9);
  check('站位 2.5 m 外 → null', nm.nearest({ x: B0.x + MINIGAME_RADIUS + 0.1, z: B0.z }) === null);
  check('nearest 重用同一 interactable 物件', nm.nearest({ x: B0.x, z: B0.z }) === nm.nearest({ x: B0.x + 0.5, z: B0.z }));
  check('markers：2 個 kind minigame、重用陣列', nm.markers().length === 2 && nm.markers().every((m) => m.kind === MINIGAME_KIND && MINIGAME_KIND === 'minigame') && nm.markers() === nm.markers());
  void bus;
}
function playBalloon(targets) {
  const s = setup({ money: 1000 });
  const ok = s.nm.start('balloon');
  for (const t of targets) shootAt(s.bus, t.x, t.y, t.z);
  const crimesDuring = s.st.crimes;
  s.nm.update(1 / 60, ctxAt(B0.x, B0.z));
  return { ...s, ok, crimesDuring };
}
{
  // 12 顆：2 次一槍兩顆 + 8 次單顆
  const t12 = [mid(centers[0], centers[1]), mid(centers[2], centers[3]), ...[4, 5, 6, 7, 8, 9, 10, 11].map((i) => centers[i])];
  const r = playBalloon(t12);
  const end = r.st.events.find((e) => e.n === 'minigame:end');
  check('付費 NT$50 開局：扣款、換手槍、minigame:start { id, price }', r.ok && r.st.equip === 1 && r.st.events[0].n === 'minigame:start' && r.st.events[0].id === 'balloon' && r.st.events[0].price === 50);
  check('10 發破 12 顆 → 結算 reward 300（入帳）、score 12、best 12', end && end.reason === 'done' && end.score === 12 && end.reward === 300 && r.economy.money === 1000 - 50 + 300 && r.nm.best('balloon') === 12 && !r.nm.active);
  check('局中 10 發（含最後一發、結算前）都不算犯行', r.crimesDuring === 0);
  shootAt(r.bus, 0, 0, 0);
  check('局外射擊照常算犯行', r.st.crimes === 1);
  const r2 = playBalloon([...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => centers[i])]);
  const e2 = r2.st.events.find((e) => e.n === 'minigame:end');
  check('10 發破 10 顆 → 沒得獎（reward 0，不退費）', e2 && e2.score === 10 && e2.reward === 0 && r2.economy.money === 950);
  // 全破：每排 (0,1)(2,3) 兩槍兩顆 + 第 5 顆單發 → 9 發 15 顆
  const all = [];
  for (let rr = 0; rr < 3; rr++) {
    const b = rr * 5;
    all.push(mid(centers[b], centers[b + 1]), mid(centers[b + 2], centers[b + 3]), centers[b + 4]);
  }
  const r3 = playBalloon(all);
  const e3 = r3.st.events.find((e) => e.n === 'minigame:end');
  check('9 發全破 15 顆 → 提前結算 NT$800', e3 && e3.score === 15 && e3.reward === 800 && r3.economy.money === 1000 - 50 + 800 && e3.newBest === true);
  // 只算手槍 / 落點在前不算
  const s = setup();
  s.nm.start('balloon');
  shootAt(s.bus, centers[1].x, centers[1].y, centers[1].z, { endBefore: true });
  check('落點在氣球前不破但扣 1 發（局中手槍朝氣球牆不算犯行）', s.nm.balloon.shots === 1 && s.nm.balloon.popped === 0 && s.st.crimes === 0);
  const sm = setup();
  sm.nm.start('balloon');
  shootAt(sm.bus, centers[0].x, centers[0].y, centers[0].z, { weapon: 'smg' });
  const smEnd = sm.st.events.find((e) => e.n === 'minigame:end');
  check('局中衝鋒槍射擊：不算發數也不破、照常報 gunfire、該局結束 foul（不退費）', sm.nm.balloon.shots === 0 && sm.nm.balloon.popped === 0 && sm.st.crimes === 1
    && smEnd && smEnd.reason === 'foul' && smEnd.reward === 0 && sm.economy.money === 950 && !sm.nm.active);
  shootAt(s.bus, centers[2].x, centers[2].y, centers[2].z);
  check('命中 → popped +1、剩 8 發', s.nm.balloon.popped === 1 && s.nm.balloon.left === 8);
  {
    const c = centers[7];
    const L = Math.hypot(c.x - eye.x, c.y - eye.y, c.z - eye.z);
    const dir = { x: (c.x - eye.x) / L, y: (c.y - eye.y) / L, z: (c.z - eye.z) / L };
    const ev = { weapon: 'pistol', x: eye.x, y: eye.y, z: eye.z, dirX: dir.x, dirY: dir.y, dirZ: dir.z, byPlayer: true };
    check('局中 shieldShots / exemptShot 為真（手槍朝氣球牆）', s.nm.shieldShots(eye, dir) && s.nm.exemptShot(ev));
    check('exemptShot / shieldShots 不帶射線 → 假（不再只看局中）', !s.nm.exemptShot() && !s.nm.shieldShots());
  }
  check('局中不再提供攤位 interactable（不重複開局）', s.nm.nearest({ x: B0.x, z: B0.z }) === null && s.nm.start('pachinko') === false);
}

// ---------- 4. 互斥 / 走遠 / Esc / cancel ----------
{
  const w = setup({ stars: 1 });
  check('通緝 1 星 → 不可玩、提示「先甩掉警察」、不扣款', w.nm.start('balloon') === false && w.economy.money === 1000 && w.st.toasts.some((t) => t.includes('先甩掉警察')) && WANTED_TEXT.includes('先甩掉警察'));
  const b = setup({ busy: '任務進行中，不能玩夜市小遊戲' });
  check('任務 / 副任務中（isBusy）→ 不可玩、不扣款', b.nm.start('pachinko') === false && b.economy.money === 1000 && b.st.toasts.some((t) => t.includes('任務')));
  const wb = setup({ stars: 2, busy: 'x' });
  wb.nm.start('balloon');
  check('通緝 + 任務同時 → 先提示通緝', wb.st.toasts[0] === WANTED_TEXT);
  check('checkPlay 純函式：wanted / busy / money / ok', checkPlay(B0, { stars: 1, busy: null, money: 99 }).reason === 'wanted' && checkPlay(B0, { stars: 0, busy: 'x', money: 99 }).reason === 'busy'
    && checkPlay(B0, { stars: 0, busy: null, money: 49 }).reason === 'money' && checkPlay(B0, { stars: 0, busy: null, money: 50 }).ok);

  const f = setup();
  f.nm.start('balloon');
  shootAt(f.bus, centers[0].x, centers[0].y, centers[0].z);
  f.nm.update(1 / 60, ctxAt(B0.x + LEAVE_DIST - 0.5, B0.z));
  check('離站位 7.5 m → 繼續玩', f.nm.playing === 'balloon');
  f.nm.update(1 / 60, ctxAt(B0.x + LEAVE_DIST + 0.5, B0.z));
  const fe = f.st.events.find((e) => e.n === 'minigame:end');
  check('走遠 > 8 m → 結束（reason left、reward 0、不退費、不記最佳）', fe && fe.reason === 'left' && fe.reward === 0 && f.economy.money === 950 && f.nm.best('balloon') === 0 && !f.nm.active && !f.nm.exemptShot());
  const v = setup();
  v.nm.start('balloon');
  v.nm.update(1 / 60, ctxAt(B0.x, B0.z, false));
  check('上車 / 倒地（onFoot false）→ 結束 left', v.st.events.some((e) => e.n === 'minigame:end' && e.reason === 'left'));
  const ws = setup();
  ws.nm.start('balloon');
  ws.st.stars = 1;
  ws.nm.update(1 / 60, ctxAt(B0.x, B0.z));
  check('局中被通緝 → 結束 wanted', ws.st.events.some((e) => e.n === 'minigame:end' && e.reason === 'wanted'));
  const esc = setup();
  esc.nm.start('balloon');
  esc.bus.emit('game:pause', { paused: true });
  check('射氣球局中 Esc（暫停選單 game:pause）→ 結束 esc、不退費', esc.st.events.some((e) => e.n === 'minigame:end' && e.reason === 'esc') && esc.economy.money === 950 && !esc.nm.active);
  const c = setup();
  c.nm.start('balloon');
  c.nm.cancel();
  check('cancel（回主選單）→ 無聲收場：不發 minigame:end、不退費、可再開局', !c.nm.active && !c.st.events.some((e) => e.n === 'minigame:end') && c.economy.money === 950 && c.nm.start('balloon') === true);
  const cp = setup();
  cp.nm.start('pachinko');
  cp.nm.cancel();
  check('彈珠台 cancel → 面板關閉（panelOpen false）、無事件', !cp.nm.panelOpen() && !cp.st.events.some((e) => e.n === 'minigame:end'));
}

// ---------- 5. 彈珠台：蓄力 / 彈跳 / 格子 ----------
{
  check('蓄力：按住越久越大、上限 1（0.8 / s）', chargePower(0, 0.5) === 0.4 && chargePower(0.4, 0.5) === 0.8 && chargePower(0.9, 1) === 1 && chargePower(0.3, -1) === 0.3 && CHARGE_RATE === 0.8);
  check('力道 → 初速單調遞增（60–520）', launchSpeed(0) < launchSpeed(0.5) && launchSpeed(0.5) < launchSpeed(1) && launchSpeed(1) === LAUNCH.vMax && launchSpeed(2) === LAUNCH.vMax);
  // 彈跳：珠子從某根釘子左上方落下 → 撞到後往左上反彈
  const peg = PEGS[10];
  const ball = createBall();
  ball.active = true;
  ball.x = peg.x - 3;
  ball.y = peg.y - 30;
  ball.vx = 0;
  ball.vy = 200;
  let bounced = false;
  let vxAfter = 0;
  let vyAfter = 0;
  for (let i = 0; i < 400 && !bounced; i++) {
    pachinkoStep(ball);
    if (ball.bounces > 0) {
      bounced = true;
      vxAfter = ball.vx;
      vyAfter = ball.vy;
    }
  }
  check('釘子碰撞：反彈往上（vy < 0）、往撞擊側偏（vx < 0）、推出不重疊', bounced && vyAfter < 0 && vxAfter < 0 && Math.hypot(ball.x - peg.x, ball.y - peg.y) >= PEG_R + BALL_R - 1e-6, `vx ${vxAfter.toFixed(1)} vy ${vyAfter.toFixed(1)}`);
  // 正上方落下：依列奇偶微推，不會停在釘子頂上
  const top = createBall();
  top.active = true;
  top.x = PEGS[0].x;
  top.y = PEGS[0].y - 20;
  top.vy = 100;
  for (let i = 0; i < 2000 && top.active; i++) pachinkoStep(top);
  check('正上方落下也會滑落並落格（不卡住）', !top.active && top.slot >= 0 && top.t < 10);
  const wallB = createBall();
  wallB.active = true;
  wallB.x = BOARD_W - BALL_R - 1;
  wallB.y = 60;
  wallB.vx = 300;
  pachinkoStep(wallB);
  pachinkoStep(wallB);
  check('右牆反彈：vx 變負、不出界', wallB.vx < 0 && wallB.x <= BOARD_W - BALL_R);
  check('格子：9 格、slotAt 邊界（0 → 0、300 → 8、中央 → 4）、最高格 100 在正中', SLOT_SCORES.length === 9 && slotAt(0) === 0 && slotAt(BOARD_W) === 8 && slotAt(BOARD_W / 2) === 4 && SLOT_SCORES[4] === 100 && Math.max(...SLOT_SCORES) === 100);
  const runs = [];
  for (let p = 0.05; p <= 1.0001; p += 0.05) runs.push(simulatePachinko(p));
  check('各力道都落入合法格且分數 = 該格分數、有彈跳、10 s 內落格', runs.every((r) => r.slot >= 0 && r.slot < 9 && r.score === SLOT_SCORES[r.slot] && r.time < 10) && runs.some((r) => r.bounces > 0));
  check('同力道結果固定（可重現）', simulatePachinko(0.37).slot === simulatePachinko(0.37).slot && simulatePachinko(0.37).bounces === simulatePachinko(0.37).bounces);
  check('不同力道落點分散（≥ 4 種格）', new Set(runs.map((r) => r.slot)).size >= 4);
  check('pachinkoReward：[100,50,30] → 200、[50,50,50] → 0、[100,50,20] → 0、[100,10,10] → 0、[100,100,50] → 200、[100,100,100] → 500', pachinkoReward([100, 50, 30]) === PACHINKO_REWARD && pachinkoReward([50, 50, 50]) === 0
    && pachinkoReward([100, 50, 20]) === 0 && pachinkoReward([100, 10, 10]) === 0 && pachinkoReward([100, 100, 50]) === PACHINKO_REWARD
    && pachinkoReward([100, 100, 100]) === PACHINKO_JACKPOT_REWARD && PACHINKO_WIN === 180 && PACHINKO_REWARD === 200 && PACHINKO_JACKPOT_REWARD === 500);
}
{
  // 整局：付費 → 3 顆（按住 / 放開）→ 結算（固定 seed；面板與純函式用同 seed 的亂數序列）
  const s = setup({ seed: 20261021 });
  const bal0 = s.economy.money;
  check('彈珠台付費 NT$30 開局 → panelOpen', s.nm.start('pachinko') && s.economy.money === bal0 - 30 && s.nm.panelOpen());
  check('未按住時 releaseLaunch 無效', s.nm.releaseLaunch() === false);
  const holdFrames = [30, 12, 60]; // 按住幀數（60 fps）
  const powers = [];
  for (const nf of holdFrames) {
    s.nm.pressLaunch();
    check(`蓄力中 pressLaunch 不重複（${nf} 幀）`, s.nm.pressLaunch() === false && s.nm.pachinko.charging);
    for (let i = 0; i < nf; i++) s.nm.updatePanel(1 / 60);
    const charged = s.nm.pachinko.power;
    powers.push(charged);
    s.nm.releaseLaunch();
    check(`放開發射：按住 ${nf} 幀 → 力道 ${charged.toFixed(2)}（≈ 0.8 / s）、珠子飛行中不能再蓄力`, Math.abs(charged - Math.min(1, (nf / 60) * CHARGE_RATE)) < 1e-6 && s.nm.pachinko.ball.active && s.nm.pressLaunch() === false);
    for (let i = 0; i < 60 * 15 && s.nm.pachinko.ball.active; i++) s.nm.updatePanel(1 / 60);
  }
  const p = s.nm.pachinko;
  const end = s.st.events.find((e) => e.n === 'minigame:end');
  const seqRng = createRng(p.seed);
  const expect = powers.map((pw) => simulatePachinko(pw, createBall(), seqRng).score);
  const total = expect.reduce((a, b) => a + b, 0);
  check('3 顆落格分數 = 純函式模擬結果（面板模擬與 simulatePachinko 同 seed 一致）', p.seed === 20261021 && p.scores.length === 3 && p.scores.every((v, i) => v === expect[i]), `${p.scores} vs ${expect}`);
  check('結算：score = 總分、reward = pachinkoReward、入帳、best 更新', end && end.reason === 'done' && end.score === total && end.reward === pachinkoReward(expect)
    && s.economy.money === bal0 - 30 + end.reward && s.nm.best('pachinko') === total && p.finished);
  check('結果畫面：面板仍開著；再發射無效；close → 關閉', s.nm.panelOpen() && s.nm.pressLaunch() === false && (s.nm.close(), !s.nm.panelOpen()));
  const q = setup();
  q.nm.start('pachinko');
  q.nm.pressLaunch();
  q.nm.updatePanel(0.3);
  q.nm.releaseLaunch();
  q.nm.quit('esc');
  check('彈珠台中途 Esc → 結束 esc、reward 0、不退費、面板關閉', q.st.events.some((e) => e.n === 'minigame:end' && e.reason === 'esc' && e.reward === 0) && q.economy.money === 970 && !q.nm.panelOpen());
  // 最高格保底：強制 3 顆分數含 100 → 500
  check('PACHINKO_MAX_SCORE = 3 × 100', PACHINKO_MAX_SCORE === 300 && PACHINKO_BALLS === 3);
}

// ---------- 5b. 彈珠台隨機性與期望值（P21 修正：原本決定論、蓄滿力必得 NT$200）----------
{
  const r1 = createRng(42);
  const r2 = createRng(42);
  const a = [0.37, 1, 0.6].map((pw) => simulatePachinko(pw, createBall(), r1));
  const b = [0.37, 1, 0.6].map((pw) => simulatePachinko(pw, createBall(), r2));
  check('同 seed 可重現（落格 / 彈跳次數一致）', a.every((r, i) => r.slot === b[i].slot && r.bounces === b[i].bounces));
  const slotsBySeed = new Set();
  for (let sd = 1; sd <= 40; sd++) slotsBySeed.add(simulatePachinko(0.37, createBall(), createRng(sd)).slot);
  check('同力道不同 seed 落點分散（≥ 4 種格）', slotsBySeed.size >= 4, `n=${slotsBySeed.size}`);
  // 任何固定力道都不保證得獎（含蓄滿 power = 1）：每個力道 40 個 seed 至少有一局 0 元
  const sure = [];
  let fullWins = 0;
  for (let p = POWER_MIN; p <= 1.0001; p += 0.05) {
    let zero = 0;
    for (let sd = 1; sd <= 40; sd++) {
      const rng = createRng(sd * 7919);
      const sc = [0, 1, 2].map(() => simulatePachinko(Math.min(1, p), createBall(), rng).score);
      if (pachinkoReward(sc) === 0) zero++;
      else if (p > 0.999) fullWins++;
    }
    if (zero === 0) sure.push(p.toFixed(2));
  }
  check('任何固定力道（含蓄滿 1.0）都不保證得獎', sure.length === 0 && fullWins < 40, sure.join(','));
  // 2000 局模擬：均勻隨機力道 → 期望獎金 < 票價、NT$500 機率 ≤ 2%
  const rng = createRng(20261021);
  const ball = createBall();
  const N = 2000;
  let sum = 0;
  let jack = 0;
  for (let g = 0; g < N; g++) {
    const sc = [0, 1, 2].map(() => simulatePachinko(POWER_MIN + (1 - POWER_MIN) * rng(), ball, rng).score);
    const r = pachinkoReward(sc);
    sum += r;
    if (r === PACHINKO_JACKPOT_REWARD) jack++;
  }
  check(`2000 局均勻隨機力道：期望獎金 < 票價 NT$${PACHINKO_PRICE}`, sum / N < PACHINKO_PRICE, `EV ${(sum / N).toFixed(2)}`);
  check('2000 局均勻隨機力道：最高格 NT$500 機率 ≤ 2%', jack / N <= 0.02, `${((jack / N) * 100).toFixed(2)}%`);
  // 整合：真模組 10 局蓄滿力不再穩賺（原本 money 1000 → 2700）
  const f = setup({ money: 1000 });
  for (let g = 0; g < 10; g++) {
    f.nm.start('pachinko');
    for (let k = 0; k < PACHINKO_BALLS; k++) {
      f.nm.pressLaunch();
      for (let i = 0; i < 90; i++) f.nm.updatePanel(1 / 60);
      f.nm.releaseLaunch();
      for (let i = 0; i < 60 * 15 && f.nm.pachinko.ball.active; i++) f.nm.updatePanel(1 / 60);
    }
    f.nm.close();
  }
  const ends = f.st.events.filter((e) => e.n === 'minigame:end');
  check('真模組 10 局蓄滿力：每局都有結算、不再每局得獎', ends.length === 10 && ends.some((e) => e.reward === 0) && f.economy.money < 1000 + 10 * (PACHINKO_REWARD - PACHINKO_PRICE), `money ${f.economy.money}`);
  const seeds = new Set();
  const g2 = setup();
  for (let g = 0; g < 3; g++) {
    g2.nm.start('pachinko');
    seeds.add(g2.nm.pachinko.seed);
    g2.nm.quit('esc');
  }
  check('未注入 seed：每局 seed 不同（開局時間 ⊕ 局數）', seeds.size === 3);
}

// ---------- 5c. 射氣球：最後一發與暫停同幀、切視窗自動暫停 ----------
{
  const all = [];
  for (let rr = 0; rr < 3; rr++) {
    const b = rr * 5;
    all.push(mid(centers[b], centers[b + 1]), mid(centers[b + 2], centers[b + 3]), centers[b + 4]);
  }
  const a = setup();
  a.nm.start('balloon');
  for (const t of all) shootAt(a.bus, t.x, t.y, t.z);
  a.bus.emit('game:pause', { paused: true }); // 全破那一幀、結算前按 Esc
  const ae = a.st.events.find((e) => e.n === 'minigame:end');
  check('全破後同幀 Esc（game:pause）→ 先正常結算 done、NT$800 入帳', ae && ae.reason === 'done' && ae.score === 15 && ae.reward === 800 && a.economy.money === 1000 - 50 + 800 && !a.nm.active);
  const b = setup();
  b.nm.start('balloon');
  for (let i = 0; i < 10; i++) shootAt(b.bus, centers[i].x, centers[i].y, centers[i].z);
  b.nm.setAutoPause(true);
  b.bus.emit('game:pause', { paused: true });
  b.nm.setAutoPause(false);
  const be = b.st.events.find((e) => e.n === 'minigame:end');
  check('第 10 發後同幀切視窗自動暫停 → 正常結算 done（10 顆 reward 0 但非 esc）', be && be.reason === 'done' && be.score === 10);
  const c = setup();
  c.nm.start('balloon');
  shootAt(c.bus, centers[0].x, centers[0].y, centers[0].z);
  c.nm.setAutoPause(true);
  c.bus.emit('game:pause', { paused: true });
  c.nm.setAutoPause(false);
  check('局中切視窗自動暫停（setAutoPause）→ 不視為放棄：局保留、無 minigame:end', c.nm.playing === 'balloon' && !c.st.events.some((e) => e.n === 'minigame:end'));
  c.bus.emit('game:pause', { paused: false });
  for (let i = 1; i < 10; i++) shootAt(c.bus, centers[i].x, centers[i].y, centers[i].z);
  c.nm.update(1 / 60, ctxAt(B0.x, B0.z));
  const ce = c.st.events.find((e) => e.n === 'minigame:end');
  check('自動暫停繼續後照玩、照常結算', ce && ce.reason === 'done' && ce.score === 10);
  c.nm.start('balloon');
  c.bus.emit('game:pause', { paused: true });
  check('setAutoPause(false) 之後的 Esc 暫停仍是放棄（esc）', c.st.events.filter((e) => e.n === 'minigame:end').pop().reason === 'esc');
}

// ---------- 5d. 射氣球豁免只對手槍朝氣球牆 ----------
{
  check('豁免常數：攤位武器 pistol、夾角 30°、距離 12 m、朝外連 3 發結束', BALLOON_WEAPON === 'pistol' && BALLOON_AIM_DEG === 30 && BALLOON_AIM_DIST === 12 && BALLOON_FOUL_SHOTS === 3);
  const yaw = B0.yaw;
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  const fire = (bus, o, dx, dz, weapon = 'pistol') => bus.emit('weapon:fire', { weapon, x: o.x, y: o.y, z: o.z, dirX: dx, dirY: 0, dirZ: dz, byPlayer: true, hit: false, miss: true, ex: NaN, ey: NaN, ez: NaN, dist: 0, vehicle: null });
  const rot = (deg) => {
    const a = (deg * Math.PI) / 180;
    return [fx * Math.cos(a) + fz * Math.sin(a), -fx * Math.sin(a) + fz * Math.cos(a)];
  };
  const s = setup();
  s.nm.start('balloon');
  const [ox, oz] = rot(90); // 朝攤位側面（車道 / 人行道）
  fire(s.bus, eye, ox, oz);
  check('局中手槍朝攤位外（夾角 90°）→ 照常報 gunfire、不算發數', s.st.crimes === 1 && s.nm.balloon.shots === 0 && s.nm.playing === 'balloon');
  const [bx, bz] = rot(180);
  fire(s.bus, eye, bx, bz);
  check('朝攤位後方（背對氣球牆）→ 照常報 gunfire', s.st.crimes === 2 && s.nm.balloon.outward === 2);
  shootAt(s.bus, centers[3].x, centers[3].y, centers[3].z);
  check('中間夾一發朝氣球牆 → 連射計數歸零、該發豁免', s.nm.balloon.outward === 0 && s.st.crimes === 2 && s.nm.balloon.shots === 1);
  for (let i = 0; i < 3; i++) fire(s.bus, eye, ox, oz);
  const se = s.st.events.find((e) => e.n === 'minigame:end');
  check('連續朝外 3 發 → 自動結束 foul（不退費）、3 發皆報 gunfire', se && se.reason === 'foul' && se.reward === 0 && s.st.crimes === 5 && s.economy.money === 950 && !s.nm.active);
  const t = setup();
  t.nm.start('balloon');
  const [ax, az] = rot(35);
  const ev35 = { weapon: 'pistol', x: eye.x, y: eye.y, z: eye.z, dirX: ax, dirY: 0, dirZ: az };
  const [cx, cz] = rot(10);
  const ev10 = { weapon: 'pistol', x: eye.x, y: eye.y, z: eye.z, dirX: cx, dirY: 0, dirZ: cz };
  const farO = { x: B0.x - fx * (BALLOON_AIM_DIST + 1), y: 1.5, z: B0.z - fz * (BALLOON_AIM_DIST + 1) };
  const evFar = { weapon: 'pistol', x: farO.x, y: farO.y, z: farO.z, dirX: fx, dirY: 0, dirZ: fz };
  check('夾角 10° 豁免、35° 不豁免；站位外 13 m 不豁免；非手槍不豁免', t.nm.exemptShot(ev10) && !t.nm.exemptShot(ev35) && !t.nm.exemptShot(evFar) && !t.nm.exemptShot({ ...ev10, weapon: 'smg' }));
  check('shieldShots：朝牆真、朝外 / 13 m 外假', t.nm.shieldShots(eye, { x: cx, y: 0, z: cz }) && !t.nm.shieldShots(eye, { x: ox, y: 0, z: oz }) && !t.nm.shieldShots(farO, { x: fx, y: 0, z: fz }));
  const w = setup({ weapon: 'pistol' });
  w.nm.start('balloon');
  check('getWeapon = pistol → shieldShots 朝牆為真', w.nm.shieldShots(eye, { x: cx, y: 0, z: cz }));
  w.st.weapon = 'smg';
  check('getWeapon = smg → shieldShots 為假（不遮蔽行人）', !w.nm.shieldShots(eye, { x: cx, y: 0, z: cz }));
  w.bus.emit('weapon:equip', { slot: 2, weapon: 'smg', prev: 'pistol' });
  const we = w.st.events.find((e) => e.n === 'minigame:end');
  check('局中切換非指定武器（weapon:equip smg）→ 自動結束 foul、不退費', we && we.reason === 'foul' && w.economy.money === 950 && !w.nm.active);
  const q = setup();
  q.nm.start('balloon');
  q.bus.emit('weapon:equip', { slot: 1, weapon: 'pistol', prev: 'fist' });
  check('開局換到手槍（weapon:equip pistol）不算違規', q.nm.playing === 'balloon');
  const n = q.nm;
  n.cancel();
  check('攤位 interactable 帶 override = 3（站位內壓過委託 / 外送 / 打工 / 垃圾車 priority 3）', MINIGAME_OVERRIDE_PRIORITY === 3 && n.nearest({ x: B0.x, z: B0.z }).override === MINIGAME_OVERRIDE_PRIORITY);
}

// ---------- 6. 最佳成績與存檔相容 ----------
{
  const s = setup();
  check('沒玩過 → serialize null（存檔省略）、stats 兩項 0', s.nm.serialize() === null && s.nm.stats().minigameBalloonBest === 0 && s.nm.stats().minigamePachinkoBest === 0);
  s.nm.restore({ balloon: { best: 13 }, pachinko: { best: 180 } });
  const rec = s.nm.serialize();
  check('restore / serialize 往返', rec && rec.balloon.best === 13 && rec.pachinko.best === 180 && s.nm.stats().minigameBalloonBest === 13 && s.nm.stats().minigamePachinkoBest === 180);
  s.nm.restore(undefined);
  check('restore(undefined)（舊存檔）→ 兩項 0', s.nm.best('balloon') === 0 && s.nm.best('pachinko') === 0);
  const full = { ...defaultSave(), minigames: { balloon: { best: 12 }, pachinko: { best: 210 } } };
  const v = validateSave(full);
  check('save.js 保留 minigames', v.minigames && v.minigames.balloon.best === 12 && v.minigames.pachinko.best === 210);
  check('defaultSave 不含 minigames；舊存檔（無此欄）清洗後也不含', !('minigames' in defaultSave()) && !('minigames' in validateSave({ ...defaultSave() })));
  const cases = [
    'x', 5, null, [], {}, { balloon: { best: 99 } }, { balloon: { best: -1 }, pachinko: { best: 3.5 } }, { balloon: { best: 7 }, pachinko: 'x' },
    { pachinko: { best: 999 } }, { balloon: { best: 0 }, pachinko: { best: 0 } }, { balloon: { best: 15 }, pachinko: { best: 300 }, extra: 1 },
  ];
  const same = cases.every((c) => JSON.stringify(validateSave({ ...defaultSave(), minigames: c }).minigames ?? null) === JSON.stringify(minigameRecord(c)));
  check('save.js 清洗與 minigameRecord 一致（非物件丟棄、clamp 15 / 300、非整數 → 0、皆 0 → 省略）', same);
  check('clamp：balloon 99 → 15、pachinko 999 → 300', minigameRecord({ balloon: { best: 99 } }).balloon.best === BALLOON_COUNT && minigameRecord({ pachinko: { best: 999 } }).pachinko.best === 300);
  check('其他欄位不受影響（money / story 照舊）', validateSave({ ...defaultSave(), money: 1234, minigames: 'bad' }).money === 1234);
  // 最佳成績只在完成時更新、低於紀錄不覆寫
  const r = setup();
  r.nm.restore({ balloon: { best: 14 } });
  r.nm.start('balloon');
  for (let i = 0; i < 10; i++) shootAt(r.bus, centers[i].x, centers[i].y, centers[i].z);
  r.nm.update(1 / 60, ctxAt(B0.x, B0.z));
  check('低於紀錄 → best 不變、newBest false', r.nm.best('balloon') === 14 && r.st.events.find((e) => e.n === 'minigame:end').newBest === false);
}

// ---------- 7. 3D 外觀（假 THREE）----------
{
  const made = { meshes: 0, instanced: [], textures: 0, lights: 0 };
  class Attr { constructor(a, n) { this.array = a; this.itemSize = n; this.needsUpdate = false; } }
  class Geo {
    constructor() { this.attributes = {}; this.disposed = false; }
    setAttribute(k, v) { this.attributes[k] = v; }
    translate() { return this; }
    dispose() { this.disposed = true; }
  }
  class Mat { constructor(o = {}) { Object.assign(this, o); this.disposed = false; } dispose() { this.disposed = true; } }
  class Obj { constructor() { this.parent = null; this.children = []; } add(...c) { for (const x of c) { x.parent = this; this.children.push(x); } } remove(x) { this.children = this.children.filter((y) => y !== x); x.parent = null; } }
  class Mesh extends Obj { constructor(g, m) { super(); this.geometry = g; this.material = m; made.meshes++; } }
  class M4 { constructor() { this.e = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; } makeScale(x) { this.e = [x, 0, 0, 0, 0, x, 0, 0, 0, 0, x, 0, 0, 0, 0, 1]; return this; } makeTranslation(x, y, z) { this.e = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]; return this; } }
  class Inst extends Mesh {
    constructor(g, m, n) { super(g, m); this.count = n; this.mats = new Array(n).fill(null); this.instanceMatrix = { needsUpdate: false }; this.instanceColor = null; made.instanced.push(this); }
    setMatrixAt(i, m) { this.mats[i] = m.e.slice(); }
    setColorAt() { this.instanceColor = this.instanceColor || { needsUpdate: false }; }
    computeBoundingSphere() {}
  }
  const FAKE = {
    Color: class { constructor() { this.r = 0; this.g = 0; this.b = 0; } setHex(h) { this.r = ((h >> 16) & 255) / 255; this.g = ((h >> 8) & 255) / 255; this.b = (h & 255) / 255; return this; } },
    BufferGeometry: Geo, SphereGeometry: Geo, CylinderGeometry: Geo, Float32BufferAttribute: Attr,
    MeshStandardMaterial: Mat, MeshBasicMaterial: Mat, Mesh, InstancedMesh: Inst, Matrix4: M4, AdditiveBlending: 2, DoubleSide: 2,
  };
  const scene = new Obj();
  const view = createNightMarketView({ THREE: FAKE, scene, heightAt: () => 0, beaconColor: 0x00b8d4 });
  check('外觀 draw call = 3（攤位合併網格 + 氣球 InstancedMesh + 小光柱 InstancedMesh）', view.drawCalls === 3 && scene.children.length === 3 && made.meshes === 3);
  check('氣球 InstancedMesh 15 顆、小光柱 2 根（兩攤共用一個 draw call）', made.instanced.length === 2 && made.instanced[0].count === 15 && made.instanced[1].count === 2);
  check('攤位網格頂點色、無貼圖（材質無 map）、不投影', view.boothMesh.material.vertexColors === true && !view.boothMesh.material.map && view.boothMesh.castShadow === false && view.balloons.castShadow === false);
  check('小光柱色 = 傳入的 BEACON_COLORS.minigame、加色透明不寫深度', view.beacons.material.color === 0x00b8d4 && view.beacons.material.transparent && view.beacons.material.depthWrite === false);
  const pos = view.boothMesh.geometry.attributes.position.array;
  check('攤位網格頂點數 = 方塊數 × 36、座標有限', pos.length % (36 * 3) === 0 && pos.every(Number.isFinite));
  const bal = made.instanced[0];
  const before = bal.mats[3].slice();
  view.setBalloon(3, false);
  check('破掉 → 該顆縮放 0 矩陣、needsUpdate', bal.mats[3][0] === 0 && bal.instanceMatrix.needsUpdate === true);
  view.resetBalloons();
  check('resetBalloons → 復原原位置', bal.mats[3].every((v, i) => v === before[i]) && Math.abs(before[12] - view.centers[3].x) < 1e-9);
  // 模組串接 view：開槍破氣球時同步隱藏
  const bus = createBus();
  const nm = createNightMarket({ bus, getMoney: () => 100, spend: () => true, view });
  nm.start('balloon');
  shootAt(bus, centers[0].x, centers[0].y, centers[0].z);
  check('模組命中 → view 對應氣球隱藏', bal.mats[0][0] === 0);
  nm.cancel();
  check('cancel → 氣球補滿', bal.mats[0][0] === 1);
  const op0 = view.beacons.material.opacity;
  view.update(0.5);
  check('update 只改光柱 opacity（脈動）', view.beacons.material.opacity !== op0);
  view.dispose();
  check('dispose：移出場景、釋放幾何 / 材質', scene.children.length === 0 && view.boothMesh.geometry.disposed && view.beacons.material.disposed);
}

// ---------- 8. 原始碼限制 ----------
{
  const src = read('src/minigames/nightmarket.js');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  check('不 import three / 其他模組（純邏輯，THREE 注入）', !/^\s*import\s/m.test(code));
  check('不新增光源 / 貼圖 / shadow map', !/Light\(|Texture\(|shadowMap|castShadow = true|new THREE\.(\w*)Light/.test(code));
  // 每幀路徑函式本體不配置（不 new、不建陣列 / 物件字面值）
  // 同名函式（外觀 view.update 與模組 update）全部串起來檢查
  const body = (name) => {
    const parts = [];
    for (let i = code.indexOf(`function ${name}(`); i >= 0; i = code.indexOf(`function ${name}(`, i + 1)) {
      let depth = 0;
      let j = code.indexOf('{', code.indexOf(')', i));
      const s0 = j;
      for (; j < code.length; j++) {
        if (code[j] === '{') depth++;
        else if (code[j] === '}' && --depth === 0) break;
      }
      parts.push(code.slice(s0 + 1, j));
    }
    return parts.length ? parts.join('\n') : null;
  };
  const perFrame = ['update', 'updatePanel', 'nearest', 'pachinkoStep', 'rayBalloonHits', 'refreshUi', 'drawBoard'];
  const allocs = perFrame.filter((n) => {
    const b = body(n);
    return b === null || /\bnew\s|=\s*\[|=\s*\{\s*[\w'"]+\s*:|\.map\(|\.filter\(|\.slice\(|\.reduce\(/.test(b);
  });
  check('每幀路徑（update / updatePanel / nearest / pachinkoStep / rayBalloonHits / refreshUi / drawBoard）不配置物件', allocs.length === 0, allocs.join(', '));
  check('不用 alert / confirm', !/\balert\(|\bconfirm\(/.test(code));
}

console.log(`${failed === 0 ? 'PASS' : 'FAIL'} ${failed === 0 ? passed : failed}/${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
