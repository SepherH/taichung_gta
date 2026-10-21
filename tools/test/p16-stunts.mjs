#!/usr/bin/env node
// Phase 16 特技跳台（src/stunts.js）純邏輯驗證：不 import three / rapier（坡道網格 / 碰撞以假 THREE / 假 RAPIER 驗；跳躍以彈道替身模擬車況）
// 用法：node tools/test/p16-stunts.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 項目：坡道位置合法（osm-city.json + terrain.js：助跑 80 m 可行駛、坡道不壓車流道路、坡道 / 飛行走廊 / 落地區無建築與水面、在地圖內）、
//   起飛速度門檻、方向、落地區判定（矩形 / 圓）、翻車失敗、摔車、慢動作時長與幀率無關（上限 2.5 s / 到著地為止）、滯空與幀率無關、
//   落點 = 第一個接地幀（彈跳不覆寫）、評分計算、首次賞金與全完成獎勵、存檔相容（save.js 清洗、舊存檔）、互斥（busy 完全不觸發、
//   起飛後轉 busy = 空中被捕 / 死亡 → 立即中止不結算、星數不在介面內）、cancel / 下車中止、
//   電影鏡頭權重、標記（未完成 / 已完成淡化）、每幀不配置、HUD 面板、坡道幾何（1 draw call、頂點色、無貼圖 / 陰影）、碰撞凸包、原始碼限制
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBus } from '../../src/core/events.js';
import { createTerrain } from '../../src/terrain.js';
import { pointInPolygon, polygonBBox, closestOnPolygon, closestOnSegment } from '../../src/geom.js';
import { migrate, validateSave, defaultSave } from '../../src/save.js';
import { MARKER_COLORS } from '../../src/map/marker-colors.js';
import {
  createStunts, createRampMesh, addRampColliders, createStuntHud, buildRampGeometry, rampHull, scoreJump, inZone, stuntById, panelText,
  STUNTS, LAUNCH_SPEED, SLOWMO_SCALE, SLOWMO_MAX, REWARD, ALL_BONUS, FLIP_BONUS, PANEL_SEC, RAMP_LEN, RAMP_WIDTH, RAMP_HEIGHT, STRIPES,
  MARKER_KIND, MARKER_KIND_DONE, CAM_IN, CAM_OUT, CAM_HOLD, CAM_SIDE, toastFail, toastReward, toastAllDone,
} from '../../src/stunts.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(`${ROOT}${p}`, 'utf8');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ---------- 1. 坡道位置合法（真實地圖資料）----------
{
  const osm = JSON.parse(read('src/data/osm-city.json'));
  const T = createTerrain(osm);
  const B = osm.bounds;
  const blds = osm.B.map((b) => ({ p: b.p, bb: polygonBBox(b.p) }));
  const cp = {};
  const inBld = (x, z, pad) => blds.some((b) => x >= b.bb.x0 - pad && x <= b.bb.x1 + pad && z >= b.bb.z0 - pad && z <= b.bb.z1 + pad && (pointInPolygon(x, z, b.p) || (pad > 0 && closestOnPolygon(x, z, b.p, cp).d2 < pad * pad)));
  const segs = [];
  for (const r of osm.R) {
    if (r.u) continue;
    for (let i = 0; i + 3 < r.p.length; i += 2) segs.push({ r, ax: r.p[i], az: r.p[i + 1], bx: r.p[i + 2], bz: r.p[i + 3] });
  }
  const roadAt = (x, z, pad) => {
    for (const s of segs) {
      const lim = s.r.w / 2 + pad;
      if (x < Math.min(s.ax, s.bx) - lim || x > Math.max(s.ax, s.bx) + lim || z < Math.min(s.az, s.bz) - lim || z > Math.max(s.az, s.bz) + lim) continue;
      closestOnSegment(x, z, s.ax, s.az, s.bx, s.bz, cp);
      if (cp.d2 < lim * lim) return s.r;
    }
    return null;
  };
  const TRAFFIC = new Set(['primary', 'secondary', 'tertiary', 'trunk']);
  const S = {};
  const wet = (x, z) => {
    const k = T.querySurface(x, z, Infinity, S).kind;
    return k === 'water' || k === 'lakebed';
  };
  const inMap = (x, z, m) => x >= B.x0 + m && x <= B.x1 - m && z >= B.z0 + m && z <= B.z1 - m;
  check('5 處跳台、id 不重複', STUNTS.length === 5 && new Set(STUNTS.map((s) => s.id)).size === 5);
  let minD = Infinity;
  for (const a of STUNTS) for (const b of STUNTS) if (a !== b) minD = Math.min(minD, Math.hypot(a.x - b.x, a.z - b.z));
  check('跳台彼此相距 ≥ 120 m', minD >= 120, `min ${minD.toFixed(1)}`);
  for (const d of STUNTS) {
    const f = d.frame;
    const P = (s, l) => [d.x + f.fx * s + f.lx * l, d.z + f.fz * s + f.lz * l];
    // 助跑：坡腳前 80 m、寬 ±3 m（每 2 m 取樣）
    const bad = [];
    let onRoad = 0;
    let n = 0;
    let prevH = null;
    let maxStep = 0;
    for (let s = -80; s <= 0; s += 2) {
      for (const l of [-3, 0, 3]) {
        const [x, z] = P(s, l);
        if (!inMap(x, z, 10)) bad.push(`界外@${s}`);
        if (inBld(x, z, 1)) bad.push(`建築@${s}`);
        if (wet(x, z)) bad.push(`水@${s}`);
      }
      const [x, z] = P(s, 0);
      const h = T.heightAt(x, z);
      if (prevH !== null) maxStep = Math.max(maxStep, Math.abs(h - prevH));
      prevH = h;
      n++;
      if (roadAt(x, z, -1)) onRoad++;
    }
    check(`${d.id}：坡道前 80 m 可行駛（無建築 / 水面、在地圖內）`, bad.length === 0, bad.slice(0, 3).join());
    check(`${d.id}：助跑坡度平緩（每 2 m 高差 ≤ 0.3 m）且 ≥ 60% 在道路上`, maxStep <= 0.3 && onRoad / n >= 0.6, `step ${maxStep.toFixed(2)} road ${(onRoad / n).toFixed(2)}`);
    // 坡道本體：無建築 / 水面、不壓車流道路、在地圖內
    const rb = [];
    for (let s = 0; s <= RAMP_LEN; s += 1) for (const l of [-RAMP_WIDTH / 2, 0, RAMP_WIDTH / 2]) {
      const [x, z] = P(s, l);
      if (!inMap(x, z, 10) || inBld(x, z, 1) || wet(x, z)) rb.push(s);
      const r = roadAt(x, z, 0.5);
      if (r && TRAFFIC.has(r.t)) rb.push(`車流道路 ${r.n || r.t}`);
    }
    check(`${d.id}：坡道本體在地圖內、無建築 / 水面、不壓車流道路`, rb.length === 0, rb.slice(0, 3).join());
    // 飛行走廊（坡頂後 0–90 m、±10 m）與落地區：無建築 / 水面、在地圖內
    const fb = [];
    for (let s = RAMP_LEN; s <= RAMP_LEN + 90; s += 2) for (const l of [-10, -5, 0, 5, 10]) {
      const [x, z] = P(s, l);
      if (!inMap(x, z, 5) || inBld(x, z, 1) || wet(x, z)) fb.push(s);
    }
    check(`${d.id}：飛行走廊（坡頂後 90 m × 20 m）無建築 / 水面`, fb.length === 0, fb.slice(0, 3).join());
    const z = d.zone;
    const zb = [];
    let cells = 0;
    const R = z.shape === 'circle' ? z.r : Math.hypot(z.halfLen, z.halfWidth);
    for (let dx = -R; dx <= R; dx += 1) for (let dz = -R; dz <= R; dz += 1) {
      const x = z.x + dx;
      const zz = z.z + dz;
      if (!inZone(z, x, zz)) continue;
      cells++;
      if (!inMap(x, zz, 5) || inBld(x, zz, 0.5) || wet(x, zz)) zb.push(`${x.toFixed(0)},${zz.toFixed(0)}`);
    }
    check(`${d.id}：落地區（${z.shape}）無建築 / 水面、在地圖內`, cells > 400 && zb.length === 0, `${cells} cells ${zb.slice(0, 3).join(' ')}`);
  }
  check('落地區形狀：矩形與圓都有', STUNTS.some((s) => s.zone.shape === 'rect') && STUNTS.some((s) => s.zone.shape === 'circle'));
  check('秋紅谷邊緣 / 停車場各有一處', STUNTS.some((s) => s.name.includes('秋紅谷') && s.src.includes('秋紅谷')) && STUNTS.filter((s) => s.name.includes('停車場')).length >= 2);
}

// ---------- 彈道替身 ----------
// 車沿坡道助跑（接地）→ 坡頂起飛（離地彈道，g）→ 落地接地 → 減速停下；每幀先以 dt × timeScale 推進「世界」，再呼叫 stunts.update(dt)（同 main.js 順序）
const RIDE = 0.6; // 車身原點離地
function axisQuat(ax, ay, az, ang, out) {
  const s = Math.sin(ang / 2);
  out.x = ax * s;
  out.y = ay * s;
  out.z = az * s;
  out.w = Math.cos(ang / 2);
  return out;
}
function mulQuat(a, b, out) {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  out.x = x;
  out.y = y;
  out.z = z;
  out.w = w;
  return out;
}
function makeRig({ config, list } = {}) {
  const bus = createBus();
  const events = [];
  for (const n of ['stunt:launch', 'stunt:land', 'stunt:complete']) bus.on(n, (e) => events.push([n, e]));
  const toasts = [];
  const earned = [];
  const st = createStunts({ bus, groundAt: () => 0, config, list });
  const ctx = { busy: false, earn: (n, r) => earned.push([n, r]), toast: (t) => toasts.push(t) };
  const sample = { active: true, vehicle: { id: 'car' }, x: 0, y: RIDE, z: 0, vx: 0, vy: 0, vz: 0, qx: 0, qy: 0, qz: 0, qw: 1, grounded: true };
  return { bus, events, toasts, earned, st, ctx, sample };
}
// opts：speed、fps、g、rollRevs（空中繞前進軸翻滾圈數，落地時剛好轉完）、lateral（落點側移 m）、exitAtAir（滯空 n 秒時下車）、
//   stopAir（滯空中速度歸零且不再接地 = 摔車卡住）、after（著地後再跑幾秒實際時間）
function runJump(rig, def, opts = {}) {
  const { speed = 25, fps = 60, g = 9.81, rollRevs = 0, lateral = 0, exitAtAir = null, stopAir = false, after = 3 } = opts;
  const { st, ctx, sample } = rig;
  const f = def.frame;
  const th = Math.atan2(RAMP_HEIGHT, RAMP_LEN);
  const dt = 1 / fps;
  const vh0 = speed * Math.cos(th);
  const vy0 = speed * Math.sin(th);
  const T = (vy0 + Math.sqrt(vy0 * vy0 + 2 * g * RAMP_HEIGHT)) / g; // 解析滯空時間
  const yawQ = axisQuat(0, 1, 0, def.yawDeg * Math.PI / 180, {});
  const rq = {};
  const q = {};
  let s = -30;
  let mode = 'ground';
  let y = RIDE;
  let vy = 0;
  let vh = speed;
  let tAir = 0;
  let real = 0;
  let land = null;
  const trace = { slowReal: 0, scales: new Set(), maxCam: 0, camFullAt: null, launchReal: null, landReal: null, T, outs: [] };
  for (let i = 0; i < 20000; i++) {
    const sim = dt * st.timeScale;
    if (st.timeScale < 1) trace.slowReal += dt;
    trace.scales.add(st.timeScale);
    if (mode === 'ground') {
      s += vh * sim;
      if (s >= RAMP_LEN) {
        mode = 'air';
        y = RAMP_HEIGHT + RIDE;
        vh = vh0;
        vy = vy0;
      } else y = (s > 0 ? (RAMP_HEIGHT * s) / RAMP_LEN : 0) + RIDE;
    } else if (mode === 'air') {
      tAir += sim;
      s += vh * sim;
      y += vy * sim - 0.5 * g * sim * sim;
      vy -= g * sim;
      if (stopAir && tAir > 0.3) {
        vh = 0;
        vy = 0;
        y = 1;
      } else if (y <= RIDE) {
        y = RIDE;
        vy = 0;
        mode = 'landed';
        land = real;
      }
    } else {
      vh = Math.max(0, vh - 8 * sim);
      s += vh * sim;
    }
    const lat = mode === 'ground' ? 0 : lateral * Math.min(1, tAir / T);
    sample.x = def.x + f.fx * s + f.lx * lat;
    sample.z = def.z + f.fz * s + f.lz * lat;
    sample.y = y;
    sample.vx = f.fx * vh;
    sample.vz = f.fz * vh;
    sample.vy = mode === 'air' ? vy : mode === 'ground' && s > 0 ? vh * Math.tan(th) : 0;
    sample.grounded = mode !== 'air';
    const ang = rollRevs * 2 * Math.PI * (mode === 'ground' ? 0 : Math.min(1, tAir / T));
    mulQuat(axisQuat(f.fx, 0, f.fz, ang, rq), yawQ, q);
    sample.qx = q.x;
    sample.qy = q.y;
    sample.qz = q.z;
    sample.qw = q.w;
    if (exitAtAir !== null && mode === 'air' && tAir >= exitAtAir) sample.active = false;
    const o = st.update(dt, sample, ctx);
    real += dt;
    trace.outs.push(o);
    if (trace.launchReal === null && o.phase === 'air') trace.launchReal = real;
    trace.maxCam = Math.max(trace.maxCam, st.cam.weight);
    if (trace.camFullAt === null && st.cam.weight >= 1) trace.camFullAt = real;
    if (land !== null && real - land >= after) break;
    if (stopAir && real > 12) break;
    if (exitAtAir !== null && !sample.active && real > 6) break;
  }
  trace.landReal = land;
  sample.active = true;
  return trace;
}
// 手動腳本：衝坡起飛 → 滯空 → 第一次接地（坡頂後 firstD m，接地 touchFrames 幀 < LAND_CONFIRM）→ 彈跳離地 → 最終接地（坡頂後 finalD m）→ 結算
//   onAir(i, rig)：滯空第 i 幀呼叫（測 busy 中途轉真）；回傳每幀 out.phase 序列
function scriptJump(rig, def, { firstD = null, finalD = 40, touchFrames = 3, bounceFrames = 12, onAir = null } = {}) {
  const { st, ctx, sample: s } = rig;
  const f = def.frame;
  const dt = 1 / 60;
  const phases = [];
  const put = (sd, y, grounded) => {
    s.x = def.x + f.fx * sd;
    s.z = def.z + f.fz * sd;
    s.y = y;
    s.vx = f.fx * 25;
    s.vz = f.fz * 25;
    s.vy = 0;
    s.qx = 0;
    s.qy = 0;
    s.qz = 0;
    s.qw = 1;
    s.grounded = grounded;
    phases.push(st.update(dt, s, ctx).phase);
  };
  for (let i = 0; i < 40; i++) {
    const sd = -5 + i * 0.4;
    put(sd, RIDE + (sd >= RAMP_LEN ? RAMP_HEIGHT : 0), sd < RAMP_LEN);
  }
  const lip = RAMP_LEN;
  const airTo = (from, to, n, startI = 0) => {
    for (let i = 0; i < n; i++) {
      if (onAir) onAir(startI + i, rig);
      put(from + ((to - from) * (i + 1)) / n, RIDE + 3, false);
    }
  };
  const lastAir = lip + 6;
  if (firstD !== null) {
    airTo(lastAir, lip + firstD, 30);
    for (let i = 0; i < touchFrames; i++) put(lip + firstD, RIDE, true);
    airTo(lip + firstD, lip + finalD, bounceFrames, 30);
  } else airTo(lastAir, lip + finalD, 40);
  for (let i = 0; i < 90; i++) put(lip + finalD, RIDE, true);
  return phases;
}
const QH = stuntById('stunt-qiuhonggu');
const PK = stuntById('stunt-qhg-parking');
const lands = (rig) => rig.events.filter(([n]) => n === 'stunt:land').map(([, e]) => e);

// ---------- 2. 起飛門檻 / 方向 ----------
{
  const rig = makeRig();
  runJump(rig, QH, { speed: LAUNCH_SPEED - 2 });
  check(`速度 < ${LAUNCH_SPEED} m/s 起飛 → 不觸發（無事件、無慢動作）`, rig.events.length === 0 && rig.st.timeScale === 1);
  const r2 = makeRig();
  const t2 = runJump(r2, QH, { speed: LAUNCH_SPEED + 0.5 });
  const L2 = r2.events.find(([n]) => n === 'stunt:launch');
  check(`速度 ≥ ${LAUNCH_SPEED} m/s → stunt:launch（id / speed）`, !!L2 && L2[1].id === QH.id && L2[1].speed >= LAUNCH_SPEED && t2.scales.has(SLOWMO_SCALE));
  // 方向：從坡道側面橫越坡頂（速度與坡道方向垂直）不算
  const r3 = makeRig();
  const s = r3.sample;
  const f = QH.frame;
  for (let i = 0; i < 30; i++) {
    s.x = QH.x + f.fx * (RAMP_LEN - 0.5) + f.lx * (i * 0.5 - 4);
    s.z = QH.z + f.fz * (RAMP_LEN - 0.5) + f.lz * (i * 0.5 - 4);
    s.vx = f.lx * 30;
    s.vz = f.lz * 30;
    s.grounded = i < 10;
    r3.st.update(1 / 60, s, r3.ctx);
  }
  check('橫越坡頂（速度方向不沿坡道）→ 不觸發', r3.events.length === 0);
  // 平地高速離地（不在坡道上）
  const r4 = makeRig();
  for (let i = 0; i < 30; i++) {
    s.x = 5000 + i;
    s.z = 5000;
    s.vx = 30;
    s.vz = 0;
    s.grounded = i < 10;
    r4.st.update(1 / 60, s, r4.ctx);
  }
  check('不在坡道上離地 → 不觸發', r4.events.length === 0);
}

// ---------- 3. 成功 / 落地區 / 翻車 ----------
{
  const rig = makeRig();
  const t = runJump(rig, QH, { speed: 25 });
  const L = lands(rig);
  const c = rig.events.find(([n]) => n === 'stunt:complete');
  check('25 m/s 落在矩形落地區 → stunt:land success、stunt:complete', L.length === 1 && L[0].success === true && L[0].reason === null && !!c && c[1].id === QH.id && c[1].first === true);
  check('滯空時間 ≈ 解析值（誤差 ≤ 2 幀）', Math.abs(L[0].airTime - t.T) <= 2 / 60 + 1e-6, `${L[0].airTime.toFixed(3)} vs ${t.T.toFixed(3)}`);
  const th = Math.atan2(RAMP_HEIGHT, RAMP_LEN);
  check('飛行距離 ≈ 水平速度 × 滯空', Math.abs(L[0].distance - 25 * Math.cos(th) * t.T) < 1.5, L[0].distance.toFixed(2));
  const vy = 25 * Math.sin(th);
  const peak = RAMP_HEIGHT + (vy * vy) / (2 * 9.81);
  check('最高高度 ≈ 坡頂高 + 上拋高度', Math.abs(L[0].height - peak) < 0.2, `${L[0].height.toFixed(2)} vs ${peak.toFixed(2)}`);
  check('無旋轉 → rotation ≈ 0、flips 0', L[0].rotation < 1 && L[0].flips === 0);
  check('首次成功賞金 NT$500（reason stunt）+ toast', rig.earned.length === 1 && rig.earned[0][0] === REWARD && rig.earned[0][1] === 'stunt' && rig.toasts.includes(toastReward(REWARD)));
  check('成功 → isDone / serialize', rig.st.isDone(QH.id) && JSON.stringify(rig.st.serialize()) === JSON.stringify({ done: [QH.id] }));
  // 落地區外（太遠）→ miss
  const rm = makeRig();
  runJump(rm, QH, { speed: 41 });
  const Lm = lands(rm);
  check('41 m/s 飛過頭（落點超出矩形）→ 失敗 miss、toast、無賞金', Lm.length === 1 && Lm[0].success === false && Lm[0].reason === 'miss' && rm.toasts.includes(toastFail('miss')) && rm.earned.length === 0 && !rm.st.isDone(QH.id));
  // 圓形落地區：側移 30 m → 圈外
  const rc = makeRig();
  runJump(rc, PK, { speed: 25 });
  check('圓形落地區：正中落下 → 成功', lands(rc)[0] && lands(rc)[0].success === true);
  const rc2 = makeRig();
  runJump(rc2, PK, { speed: 25, lateral: 30 });
  check('圓形落地區：側移 30 m → miss', lands(rc2)[0] && lands(rc2)[0].reason === 'miss');
  // 翻車：落地時車頂朝下（翻半圈）→ crash
  const rf = makeRig();
  runJump(rf, QH, { speed: 25, rollRevs: 0.5 });
  const Lf = lands(rf);
  check('落地時翻覆（翻半圈、車頂朝下）→ 失敗 crash、無賞金', Lf.length === 1 && Lf[0].success === false && Lf[0].reason === 'crash' && rf.earned.length === 0 && rf.toasts.includes(toastFail('crash')));
  // 翻一整圈落地站穩 → 成功 + 翻滾加分
  const rr = makeRig();
  runJump(rr, QH, { speed: 25, rollRevs: 1 });
  const Lr = lands(rr);
  check('空中翻滾一圈後四輪落地 → 成功、flips 1、tumble ≈ 360°', Lr.length === 1 && Lr[0].success && Lr[0].flips === 1 && Math.abs(Lr[0].tumble - 360) < 10 && Lr[0].rotation > 340, `${Lr[0] && Lr[0].tumble.toFixed(1)}`);
  check('翻滾加分：同一跳分數 > 無翻滾', Lr[0].score > L[0].score + FLIP_BONUS);
  // 空中卡住（低速且不接地）→ crash
  const rs = makeRig();
  runJump(rs, QH, { speed: 25, stopAir: true });
  // 落點 = 第一個接地幀：彈跳不覆寫（QH 矩形落地區 = 坡頂後 12..80 m）
  check('QH 落地區假設：坡頂後 40 m 在區內、8 m / 84 m 在區外', inZone(QH.zone, QH.x + QH.frame.fx * (RAMP_LEN + 40), QH.z + QH.frame.fz * (RAMP_LEN + 40)) && !inZone(QH.zone, QH.x + QH.frame.fx * (RAMP_LEN + 8), QH.z + QH.frame.fz * (RAMP_LEN + 8)) && !inZone(QH.zone, QH.x + QH.frame.fx * (RAMP_LEN + 84), QH.z + QH.frame.fz * (RAMP_LEN + 84)));
  const rb1 = makeRig();
  scriptJump(rb1, QH, { firstD: 78, finalD: 84 });
  const Lb1 = lands(rb1);
  check('第一次接地在區內（坡頂後 78 m）→ 彈跳到區外（84 m）再著地 → 仍成功、賞金 NT$500、落點 = 第一次接地', Lb1.length === 1 && Lb1[0].success === true && rb1.earned.length === 1 && rb1.earned[0][0] === REWARD && Math.abs((Lb1[0].x - QH.x) * QH.frame.fx + (Lb1[0].z - QH.z) * QH.frame.fz - (RAMP_LEN + 78)) < 1e-6, Lb1[0] && `${Lb1[0].reason}`);
  const rb2 = makeRig();
  scriptJump(rb2, QH, { firstD: 8, finalD: 15 });
  const Lb2 = lands(rb2);
  check('第一次接地在區外（坡頂後 8 m）→ 彈進區內（15 m）再著地 → 失敗 miss、不發賞金、不記完成', Lb2.length === 1 && Lb2[0].success === false && Lb2[0].reason === 'miss' && rb2.earned.length === 0 && !rb2.st.isDone(QH.id) && rb2.toasts.includes(toastFail('miss')), Lb2[0] && `${Lb2[0].reason}`);
  const rb3 = makeRig();
  const pb3 = scriptJump(rb3, QH, { firstD: 30, finalD: 36 });
  check('彈跳期間仍在 air（未提早 settle）、彈跳後 timeScale 維持 1', pb3.includes('air') && rb3.st.timeScale === 1 && lands(rb3).length === 1 && lands(rb3)[0].success === true);
  check('滯空中速度歸零且不接地（側躺 / 卡住）→ crash', lands(rs).length === 1 && lands(rs)[0].reason === 'crash' && rs.st.phase === 'idle' && rs.st.timeScale === 1);
}

// ---------- 4. 慢動作：時長與幀率無關 ----------
{
  const slow = {};
  const air = {};
  for (const fps of [30, 60, 144]) {
    const rig = makeRig();
    const t = runJump(rig, QH, { speed: 25, fps });
    slow[fps] = t.slowReal;
    air[fps] = lands(rig)[0].airTime;
  }
  const spread = (o) => Math.max(...Object.values(o)) - Math.min(...Object.values(o));
  check(`長跳：慢動作到上限 ${SLOWMO_MAX} s（30 / 60 / 144 fps 一致，誤差 ≤ 1 幀 @30fps）`, Object.values(slow).every((v) => Math.abs(v - SLOWMO_MAX) <= 1 / 30 + 1e-9) && spread(slow) <= 1 / 30 + 1e-9, JSON.stringify(slow));
  check('滯空時間與幀率無關（30 / 60 / 144 fps 差 ≤ 2 幀 @30fps）', spread(air) <= 2 / 30, JSON.stringify(air));
  // 短跳（重力大）：慢動作持續到著地為止（< 上限）
  const sh = {};
  for (const fps of [30, 60, 144]) {
    const rig = makeRig();
    const t = runJump(rig, QH, { speed: 25, fps, g: 60 });
    sh[fps] = { slow: t.slowReal, land: t.landReal - t.launchReal, ok: lands(rig)[0] && lands(rig)[0].airTime > 0 };
  }
  check('短跳：慢動作持續到著地（實際時間 ≈ 起飛確認到第一個接地幀、< 上限，誤差 ≤ 2 幀 @30fps）', Object.values(sh).every((v) => v.slow < SLOWMO_MAX && Math.abs(v.slow - v.land) <= 2 / 30 + 1e-9), JSON.stringify(sh));
  check('慢動作 timeScale = 0.35', SLOWMO_SCALE === 0.35);
  const rig = makeRig();
  rig.st.update(5, rig.sample, rig.ctx);
  check('單幀 dt 過大（5 s）不會一次跑完慢動作（clamp ≤ 0.1 s）', rig.st.timeScale === 1 && rig.st.phase === 'idle');
}

// ---------- 5. 評分 ----------
{
  const s0 = scoreJump({ airTime: 2, distance: 40, height: 5, rotation: 20, tumble: 10 });
  check('scoreJump：200 + 400 + 125 + 10 + 翻滾 < 45° 不加 = 735', s0.score === 735 && s0.flips === 0 && s0.parts.tumble === 0);
  const s1 = scoreJump({ airTime: 2, distance: 40, height: 5, rotation: 380, tumble: 360 });
  check('scoreJump：翻滾 360° → tumble × 1.5 + 1 圈 × FLIP_BONUS', s1.flips === 1 && s1.parts.tumble === 540 && s1.parts.flip === FLIP_BONUS && s1.score === 200 + 400 + 125 + 190 + 540 + FLIP_BONUS);
  check('scoreJump：翻 2 圈（700°）flips 2；空值 → 0', scoreJump({ tumble: 700 }).flips === 2 && scoreJump({}).score === 0);
  const p = panelText(QH, { airTime: 1.234, distance: 38.25, height: 4.44, rotation: 12.4, tumble: 0 }, { score: 999, flips: 0 }, REWARD, 0);
  check('結算面板文字：滯空 / 距離 / 最高 / 旋轉 / 分數 / 賞金', p.title.includes(QH.name) && p.lines.join('|') === '滯空 1.23 秒|距離 38.3 m|最高 4.4 m|旋轉 12°|分數 999|首次完成賞金 NT$500');
}

// ---------- 6. 獎勵：首次、重複、全完成 ----------
{
  const rig = makeRig();
  runJump(rig, QH, { speed: 25 });
  runJump(rig, QH, { speed: 25 });
  const comps = rig.events.filter(([n]) => n === 'stunt:complete').map(([, e]) => e);
  check('同一處第二次成功：不再給賞金（first false、reward 0）', rig.earned.length === 1 && comps.length === 2 && comps[1].first === false && comps[1].reward === 0);
  for (const d of STUNTS) if (d !== QH) runJump(rig, d, { speed: d.zone.shape === 'circle' ? 25 : 27 });
  const all = rig.events.filter(([n]) => n === 'stunt:complete').map(([, e]) => e);
  check('5 處全部完成 → allDone', rig.st.allDone && rig.st.doneCount === 5, `done ${rig.st.doneCount}`);
  check(`全完成額外 NT$${ALL_BONUS} 只給一次（完成最後一處那次）`, rig.earned.filter(([n]) => n === ALL_BONUS).length === 1 && all.filter((e) => e.bonus === ALL_BONUS).length === 1 && all[all.length - 1].all === true);
  check('總入帳 = 5 × 500 + 5000', rig.earned.reduce((s, [n]) => s + n, 0) === 5 * REWARD + ALL_BONUS && rig.toasts.includes(toastAllDone(ALL_BONUS)));
  runJump(rig, QH, { speed: 25 });
  check('全完成後再跳不再給錢', rig.earned.reduce((s, [n]) => s + n, 0) === 5 * REWARD + ALL_BONUS);
}

// ---------- 7. 存檔相容 ----------
{
  const rig = makeRig();
  runJump(rig, QH, { speed: 25 });
  const rec = rig.st.serialize();
  const saved = validateSave(migrate({ ...defaultSave(), stunts: rec }));
  check('save.js 清洗保留 stunts.done', saved && JSON.stringify(saved.stunts) === JSON.stringify(rec));
  const r2 = makeRig();
  r2.st.restore(saved.stunts);
  check('讀檔 restore：已完成維持、再成功不給首次賞金', r2.st.isDone(QH.id) && (runJump(r2, QH, { speed: 25 }), r2.earned.length === 0));
  const old = validateSave(migrate({ ...defaultSave() }));
  check('舊存檔（無 stunts 欄）：清洗後省略、restore → 全部未完成', old && !('stunts' in old) && (r2.st.restore(old.stunts), r2.st.doneCount === 0));
  const v1 = validateSave({ version: 1, money: 10 });
  check('v1 存檔遷移後亦無 stunts（全部未完成）', v1 && !('stunts' in v1));
  const bad = validateSave(migrate({ ...defaultSave(), stunts: { done: [QH.id, 'bad id!', 3, QH.id] } }));
  check('非法 id 個別丟棄、去重', JSON.stringify(bad.stunts) === JSON.stringify({ done: [QH.id] }));
  const bad2 = validateSave(migrate({ ...defaultSave(), stunts: 'x' }));
  check('格式錯誤整欄丟棄、defaultSave 不含 stunts', bad2 && !('stunts' in bad2) && !('stunts' in defaultSave()));
  r2.st.restore({ done: ['nope', PK.id] });
  check('restore 略過未知 id', r2.st.doneCount === 1 && r2.st.isDone(PK.id));
  check('全部未完成 serialize → null（存檔省略）', makeRig().st.serialize() === null);
}

// ---------- 8. 互斥 ----------
{
  const rig = makeRig();
  rig.ctx.busy = true;
  const t = runJump(rig, QH, { speed: 25 });
  check('busy（任務 / 競速 / 警車任務…）起飛 → 完全不觸發（無事件、無慢動作、無鏡頭、無賞金）', rig.events.length === 0 && t.slowReal === 0 && t.maxCam === 0 && rig.earned.length === 0 && !rig.st.isDone(QH.id));
  rig.ctx.busy = false;
  runJump(rig, QH, { speed: 25 });
  check('busy 解除後同一處照常觸發', rig.st.isDone(QH.id));
  // 起飛後才轉 busy（空中被捕 / 死亡 / respawn）→ 立即中止：不結算、不給錢、timeScale 1、鏡頭立即歸還、無殘留
  for (const [label, at] of [['滯空中', 5], ['彈跳中（已第一次接地）', 32]]) {
    const rb = makeRig();
    let abortAt = null;
    const ph = scriptJump(rb, QH, {
      firstD: 30, finalD: 40,
      onAir: (i, r) => {
        if (i === at) r.ctx.busy = true;
      },
    });
    abortAt = ph.indexOf('idle', ph.indexOf('air'));
    const L = lands(rb);
    check(`${label}轉 busy（被捕 BUSTED / 死亡 WASTED）→ 立即無聲中止（land cancel、無 toast）、不發賞金、不記完成`, L.length === 1 && L[0].reason === 'cancel' && L[0].success === false && rb.earned.length === 0 && !rb.st.isDone(QH.id) && rb.toasts.length === 0 && !rb.events.some(([n]) => n === 'stunt:complete'), `${L.map((e) => e.reason)}`);
    check(`${label}轉 busy → timeScale 1、phase idle、鏡頭權重 0、無面板 / 殘留`, abortAt > 0 && rb.st.timeScale === 1 && rb.st.phase === 'idle' && rb.st.cam.weight === 0 && rb.st.active === false && rb.st.update(1 / 60, rb.sample, rb.ctx).panel === null);
  }
  {
    // 中止當幀鏡頭立即歸還（不淡出）
    const rb = makeRig();
    let w = -1;
    let ts = -1;
    scriptJump(rb, QH, {
      finalD: 40,
      onAir: (i, r) => {
        if (i === 10) r.ctx.busy = true;
        if (i === 11) {
          w = r.st.cam.weight;
          ts = r.st.timeScale;
        }
      },
    });
    check('中止當幀：cam.weight 立即 0、timeScale 立即 1', w === 0 && ts === 1, `w ${w} ts ${ts}`);
    rb.ctx.busy = false;
    runJump(rb, QH, { speed: 25 });
    check('busy 中止後解除 → 下一跳照常成功入帳', rb.st.isDone(QH.id) && rb.earned.length === 1);
  }
  const src = read('src/stunts.js');
  check('ctx 只有 busy 旗標：stunts.js 不讀通緝（wanted / stars）→ 有星數照常觸發', !/wanted|stars/.test(src.replace(/^\/\/.*$/gm, '')));
}

// ---------- 9. cancel / 下車中止 ----------
{
  const rig = makeRig();
  const t = runJump(rig, QH, { speed: 25, exitAtAir: 0.3 });
  const L = lands(rig);
  check('滯空中下車 / 車體不可用 → 無聲中止（land cancel、無 toast）、timeScale 1、鏡頭歸零', L.length === 1 && L[0].reason === 'cancel' && rig.toasts.length === 0 && rig.st.timeScale === 1 && rig.st.cam.weight === 0 && t.scales.has(SLOWMO_SCALE));
  // 換車
  const rv = makeRig();
  const s = rv.sample;
  const def = QH;
  const f = def.frame;
  for (let i = 0; i < 50; i++) {
    const sd = -5 + i * 0.4;
    s.x = def.x + f.fx * sd;
    s.z = def.z + f.fz * sd;
    s.vx = f.fx * 25;
    s.vz = f.fz * 25;
    s.grounded = sd < RAMP_LEN;
    rv.st.update(1 / 60, s, rv.ctx);
  }
  const was = rv.st.phase;
  s.vehicle = { id: 'other' };
  rv.st.update(1 / 60, s, rv.ctx);
  check('滯空中換車 → 中止', was === 'air' && rv.st.phase === 'idle' && lands(rv)[0].reason === 'cancel');
  // cancel()
  const rc = makeRig();
  rc.sample.vehicle = { id: 'car' };
  for (let i = 0; i < 50; i++) {
    const sd = -5 + i * 0.4;
    rc.sample.x = def.x + f.fx * sd;
    rc.sample.z = def.z + f.fz * sd;
    rc.sample.vx = f.fx * 25;
    rc.sample.vz = f.fz * 25;
    rc.sample.grounded = sd < RAMP_LEN;
    rc.st.update(1 / 60, rc.sample, rc.ctx);
  }
  const midAir = rc.st.phase === 'air' && rc.st.timeScale === SLOWMO_SCALE;
  rc.st.cancel();
  check('cancel()（回主選單）：timeScale 1、phase idle、鏡頭 0、面板收起、無 toast', midAir && rc.st.timeScale === 1 && rc.st.phase === 'idle' && rc.st.cam.weight === 0 && rc.toasts.length === 0 && rc.st.update(0, rc.sample, rc.ctx).panel === null);
  rc.st.cancel();
  check('未進行時 cancel 無副作用', lands(rc).length === 1);
}

// ---------- 10. 電影鏡頭 / 面板計時 ----------
{
  const rig = makeRig();
  const t = runJump(rig, QH, { speed: 25, after: 4 });
  check(`起飛後鏡頭權重 ${CAM_IN} s 內到 1`, t.camFullAt !== null && t.camFullAt - t.launchReal <= CAM_IN + 2 / 60, `${t.camFullAt && (t.camFullAt - t.launchReal).toFixed(3)}`);
  const afterLand = t.outs.length;
  check('著地 + 停留 + 淡出後權重回到 0（平滑交回跟車鏡頭）', rig.st.cam.weight === 0);
  // 淡出過程中權重單調遞減、不跳變
  const r2 = makeRig();
  const ws = [];
  const tr = runJump(r2, QH, { speed: 25, after: 0.3 });
  for (let i = 0; i < 120; i++) {
    r2.st.update(1 / 60, r2.sample, r2.ctx);
    ws.push(r2.st.cam.weight);
  }
  let mono = true;
  let maxJump = 0;
  for (let i = 1; i < ws.length; i++) {
    if (ws[i] > ws[i - 1] + 1e-9) mono = false;
    maxJump = Math.max(maxJump, ws[i - 1] - ws[i]);
  }
  check(`淡出 ${CAM_OUT} s：權重單調遞減、單幀變化 ≤ 0.05`, mono && maxJump <= 0.05 && ws[ws.length - 1] === 0 && tr.landReal !== null, `jump ${maxJump.toFixed(3)}`);
  // 鏡頭位置：離車側邊約 CAM_SIDE m、高於車
  const r3 = makeRig();
  const s = r3.sample;
  const f = QH.frame;
  for (let i = 0; i < 60; i++) {
    const sd = -5 + i * 0.4;
    s.x = QH.x + f.fx * sd;
    s.z = QH.z + f.fz * sd;
    s.y = sd > RAMP_LEN ? 4 : RIDE;
    s.vx = f.fx * 25;
    s.vz = f.fz * 25;
    s.grounded = sd < RAMP_LEN;
    r3.st.update(1 / 60, s, r3.ctx);
  }
  const c = r3.st.cam;
  const side = Math.abs((c.px - s.x) * f.lx + (c.pz - s.z) * f.lz);
  check('電影鏡頭：坡道側邊追蹤（側距 ≈ CAM_SIDE、高於車、注視車身）', r3.st.phase === 'air' && Math.abs(side - CAM_SIDE) < 0.01 && c.py > s.y && c.tx === s.x && c.tz === s.z, `side ${side.toFixed(2)}`);
  // 面板：成功後 PANEL_SEC 秒（實際時間）收起
  const r4 = makeRig();
  runJump(r4, QH, { speed: 25, after: 0.01 });
  let o = r4.st.update(0, r4.sample, r4.ctx);
  for (let i = 0; i < 300 && !o.panel; i++) o = r4.st.update(1 / 60, r4.sample, r4.ctx);
  const shown = !!o.panel && o.panel.title.includes('特技跳躍成功') && o.panelRemain > PANEL_SEC - 0.05;
  let n = 0;
  while (o.panel && n < 1000) {
    o = r4.st.update(1 / 60, r4.sample, r4.ctx);
    n++;
  }
  check(`結算面板顯示 ${PANEL_SEC} s（實際時間，誤差 ≤ 2 幀）後收起`, shown && Math.abs(n / 60 - PANEL_SEC) <= 2 / 60 + 1e-9, `${(n / 60).toFixed(2)} s`);
}

// ---------- 11. 標記 / 每幀不配置 ----------
{
  const rig = makeRig();
  const buf = [];
  const m1 = rig.st.markers(buf);
  check('markers：5 處全列、kind stunt（未完成）', m1 === buf && buf.length === 5 && buf.every((m) => m.kind === MARKER_KIND));
  runJump(rig, QH, { speed: 25 });
  buf.length = 0;
  const m2 = rig.st.markers(buf);
  check('完成後該處 kind stunt-done（淡化），其餘仍 stunt；標記物件重用', m2.filter((m) => m.kind === MARKER_KIND_DONE).length === 1 && m2.find((m) => m.id === QH.id).kind === MARKER_KIND_DONE && rig.st.markers([])[0] === m2[0]);
  const o1 = rig.st.update(1 / 60, rig.sample, rig.ctx);
  const o2 = rig.st.update(1 / 60, rig.sample, rig.ctx);
  check('update 回傳同一個物件、cam 同一個物件', o1 === o2 && o1.cam === rig.st.cam);
  const colors = Object.values(MARKER_COLORS);
  check('MARKER_COLORS：stunt / stunt-done 存在、全表色碼不重複', !!MARKER_COLORS.stunt && !!MARKER_COLORS['stunt-done'] && new Set(colors).size === colors.length);
  const big = read('src/map/big-map.js');
  check('大地圖：圖例「特技跳台」、已完成 FADED_KINDS 淡化', /stunt: '特技跳台'/.test(big) && /'stunt-done': '特技跳台（已完成）'/.test(big) && /FADED_KINDS = new Set\(\['stunt-done'\]\)/.test(big) && /ctx\.globalAlpha = FADED_KINDS\.has\(m\.kind\)/.test(big) && /ctx\.globalAlpha = 1;/.test(big));
  const hud = read('src/hud.js');
  check('小地圖：RAMP_KINDS 畫坡道圖示、不貼邊、已完成淡化', /const RAMP_KINDS = new Set\(\['stunt', 'stunt-done'\]\)/.test(hud) && /if \(RAMP_KINDS\.has\(m\.kind\)\)/.test(hud) && /if \(FADED_KINDS\.has\(m\.kind\)\) ctx\.globalAlpha = FADED_ALPHA;/.test(hud) && !/EDGE_KINDS = new Set\([^)]*'stunt/.test(hud));
}

// ---------- 12. HUD 面板（假 DOM）----------
{
  const mkEl = () => ({ hidden: false, textContent: '', className: '', attrs: {}, kids: [], setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.kids.push(c); }, remove() { this.removed = true; } });
  const kids = [];
  const doc = { createElement: () => mkEl() };
  const root = { appendChild: (e) => kids.push(e) };
  const hud = createStuntHud({ root, doc });
  check('HUD：.stunt-panel 建立、初始隱藏', kids.length === 1 && hud.el.className === 'stunt-panel' && hud.el.hidden);
  const panel = { title: '特技跳躍成功！X', lines: ['a', 'b'] };
  hud.set({ panel });
  check('set：顯示標題與多行', !hud.el.hidden && hud.el.kids[0].textContent === '特技跳躍成功！X' && hud.el.kids[1].textContent === 'a\nb');
  hud.el.kids[0].textContent = 'dirty';
  hud.set({ panel });
  check('同一 panel 物件不重寫 DOM', hud.el.kids[0].textContent === 'dirty');
  hud.set(null);
  check('set(null) 隱藏', hud.el.hidden);
  check('無 root：no-op', typeof createStuntHud({}).set === 'function');
  const css = read('src/style.css');
  check('style.css：.stunt-panel 與 [hidden]', css.includes('.stunt-panel {') && /\.stunt-panel\[hidden\]/.test(css));
}

// ---------- 13. 坡道幾何 / 網格 / 碰撞 ----------
{
  const g = buildRampGeometry(STUNTS, () => 0);
  const quads = STUNTS.length * (STRIPES + 4);
  check('幾何：每處 8 條紋 + 4 面、頂點 / 索引數正確', g.positions.length === quads * 4 * 3 && g.indices.length === quads * 6 && g.colors.length === g.positions.length);
  // 坡面法線朝上、條紋黃黑交替
  const n0y = g.normals[1];
  const c0 = [g.colors[0], g.colors[1], g.colors[2]];
  const c1 = [g.colors[12], g.colors[13], g.colors[14]];
  check('坡面法線朝上、條紋黃 / 黑交替', n0y > 0.9 && c0[0] > 0.9 && c0[1] > 0.6 && c0[2] < 0.2 && c1[0] < 0.1 && c1[1] < 0.1);
  // 側面法線朝外（左側面 · 左方向 > 0）
  const f = STUNTS[0].frame;
  const sideBase = STRIPES * 4 * 3;
  const nl = [g.normals[sideBase], g.normals[sideBase + 1], g.normals[sideBase + 2]];
  check('左側面法線朝左（外側）', nl[0] * f.lx + nl[2] * f.lz > 0.99);
  const h = rampHull(STUNTS[0], () => 0);
  check('凸包 8 點：坡頂高 RAMP_HEIGHT、底面埋地、寬 RAMP_WIDTH', h.length === 24 && Math.abs(h[6 * 3 + 1] - RAMP_HEIGHT) < 1e-6 && h[1] < 0 && Math.abs(Math.hypot(h[0] - h[3], h[2] - h[5]) - RAMP_WIDTH) < 1e-4);
  // 假 THREE
  const made = { meshes: [], mats: [], textures: 0, lights: 0 };
  class Geo { constructor() { this.attrs = {}; } setAttribute(k, v) { this.attrs[k] = v; } setIndex(i) { this.index = i; } computeBoundingSphere() {} dispose() { this.disposed = true; } }
  const THREE = {
    BufferGeometry: Geo,
    BufferAttribute: class { constructor(a, n) { this.array = a; this.itemSize = n; } },
    MeshStandardMaterial: class { constructor(o) { Object.assign(this, o); made.mats.push(this); } dispose() { this.disposed = true; } },
    Mesh: class { constructor(g2, m) { this.geometry = g2; this.material = m; made.meshes.push(this); } },
    TextureLoader: class { constructor() { made.textures++; } },
    PointLight: class { constructor() { made.lights++; } },
  };
  const added = [];
  const scene = { add: (o) => added.push(o) };
  const rm = createRampMesh({ THREE, scene, groundAt: () => 0 });
  check('網格：5 處合成 1 個 Mesh（坡道 draw call 合計 1 ≤ 2）', made.meshes.length === 1 && added.length === 1 && made.mats.length === 1);
  check('材質：vertexColors、無貼圖；不投影不受影；無光源 / 貼圖', made.mats[0].vertexColors === true && !made.mats[0].map && rm.mesh.castShadow === false && rm.mesh.receiveShadow === false && made.textures === 0 && made.lights === 0);
  check('幾何屬性：position / normal / color + index', ['position', 'normal', 'color'].every((k) => rm.mesh.geometry.attrs[k]) && !!rm.mesh.geometry.index);
  rm.mesh.parent = { remove: () => (rm.mesh.parent = null) };
  rm.dispose();
  check('dispose：釋放幾何 / 材質', rm.mesh.geometry.disposed && made.mats[0].disposed);
  // 假 RAPIER
  const hulls = [];
  const RAPIER = {
    ColliderDesc: {
      convexHull: (pts) => {
        const d = { pts, groups: null, solver: null, setCollisionGroups(gr) { this.groups = gr; return this; }, setSolverGroups(gr) { this.solver = gr; return this; } };
        hulls.push(d);
        return d;
      },
    },
  };
  const created = [];
  const world = { createCollider: (d) => (created.push(d), { handle: created.length }) };
  const cols = addRampColliders(RAPIER, world, { groundAt: () => 0, groups: 0x1234 });
  check('碰撞：每處一個靜態凸包（world.createCollider、無剛體）、groups / solver 設定', cols.length === 5 && hulls.length === 5 && hulls.every((d) => d.pts.length === 24 && d.groups === 0x1234 && d.solver === 0x1234) && created.length === 5);
  const RAPIER2 = { ColliderDesc: { convexHull: () => null } };
  check('凸包失敗（null）略過', addRampColliders(RAPIER2, world, {}).length === 0);
}

// ---------- 14. 原始碼 / 文件 ----------
{
  const src = read('src/stunts.js');
  check('stunts.js 不 import three / rapier', !/from ['"](three|@dimforge)/.test(src) && !/import\(['"]three/.test(src) && !/^import /m.test(src));
  check('stunts.js 不建立光源 / 貼圖 / 陰影', !/Light\(|TextureLoader|CanvasTexture|DataTexture|castShadow = true|shadowMap/.test(src));
  const doc = read('docs/dev/interfaces.md');
  check('interfaces.md §38：stunts.js 介面與三個事件', /## 38\. Phase 16 特技跳台/.test(doc) && ['stunt:launch', 'stunt:land', 'stunt:complete', 'createStunts', 'timeScale'].every((e) => doc.includes(e)));
  const save = read('src/save.js');
  check('save.js 檔頭註明 Phase 16 stunts', /Phase 16（§38/.test(save));
}

console.log(failed ? `FAIL ${failed}/${passed + failed}` : `PASS ${passed}/${passed + failed}`);
process.exit(failed ? 1 : 0);
